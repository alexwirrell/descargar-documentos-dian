// ===================== Content script (páginas de la DIAN) =====================
const MAX_SEARCH_ATTEMPTS = 2; // la 2.ª cubre un captcha fallido; más intentos no cambian la respuesta del portal
const POLL_MS = 300;               // revisión del captcha / contenido (antes 800 ms)
const CHALLENGE_TIMEOUT_MS = 90000; // espera máxima a que se resuelva la verificación anti-bot

function sendLog(msg) {
  console.log(`[CONTENT_SCRIPT] ${msg}`);
  return chrome.runtime.sendMessage({ type: 'LOG', message: msg }).catch(() => {});
}

// status: 'ok' | 'fail' (definitivo) | 'retry' (temporal: se reintenta el mismo CUFE)
function finishCufe(status, reason) {
  return chrome.runtime.sendMessage({ action: 'CUFE_DONE', status, reason }).catch(() => {});
}

function reportBlocked(detail) {
  return chrome.runtime.sendMessage({ action: 'BLOCKED', detail }).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------- Bloqueo / verificación anti-bot del portal ----------
const BLOCK_RE = /the request is blocked|request (was|has been) blocked|access denied|acceso denegado|too many requests|demasiadas solicitudes|error 1015|you have been blocked/i;
const CHALLENGE_RE = /just a moment|un momento|comprobando que no sea? un bot|verifying you are human|verify you are human|checking (if the site connection is secure|your browser)|attention required/i;

function blockState() {
  const title = document.title || '';
  const text = (document.body?.innerText || '').slice(0, 4000);
  if (BLOCK_RE.test(title) || BLOCK_RE.test(text)) return 'blocked';
  if (!document.querySelector('#DocumentKey') && (CHALLENGE_RE.test(title) || CHALLENGE_RE.test(text))) return 'challenge';
  return null;
}

function blockDetail() {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const ref = text.match(/\b\d{8}T\d{6}Z-[\w-]+/);
  return `${text.substring(0, 80)}${ref ? ` · ref ${ref[0]}` : ''}`;
}

// ---------- Captcha Turnstile de los formularios ----------
function getTurnstileValue() {
  for (const input of document.querySelectorAll('input[name="cf-turnstile-response"]')) {
    if (input.value) return input.value;
  }
  return '';
}

// Espera el token del captcha. Se cancela si el usuario detiene el proceso.
async function waitForCaptcha() {
  const start = Date.now();
  let reminded = false;
  for (;;) {
    const token = getTurnstileValue();
    if (token) return token;
    const { isProcessing } = await chrome.storage.local.get('isProcessing');
    if (!isProcessing) return null;
    if (!reminded && Date.now() - start > 120000) {
      reminded = true;
      await sendLog('El captcha lleva más de 2 minutos sin resolverse: revise la pestaña de la DIAN.');
    }
    await sleep(POLL_MS);
  }
}

function setInputValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function visibleErrorText() {
  // Mensajes en el formulario y también en ventanas emergentes (modal / alerta / toast) del portal
  const selectors = '.alert-danger, .alert-warning, .validation-summary-errors, .field-validation-error, .text-danger, ' +
    '.modal.show .modal-body, .modal.in .modal-body, #confirmModal-message, #alertModal .modal-body, .swal2-html-container, .toast-message, .toast-body';
  const el = [...document.querySelectorAll(selectors)].find((e) => e.offsetParent !== null && e.innerText && e.innerText.trim());
  const text = el?.innerText?.trim().replace(/\s+/g, ' ');
  return text ? text.substring(0, 200) : '';
}

// --- RUTA 1: Búsqueda ---
async function handleSearchPage(data) {
  // Si la búsqueda falla, la DIAN vuelve a mostrar esta página: contamos intentos
  // para no repetir el mismo CUFE en un bucle infinito.
  const prev = data.searchAttempts;
  const attempts = prev && prev.index === data.currentIndex ? prev.count + 1 : 1;
  await chrome.storage.local.set({ searchAttempts: { index: data.currentIndex, count: attempts } });

  const errorText = visibleErrorText();
  if (attempts > 1 && errorText) await sendLog(`La DIAN respondió: ${errorText}`);

  // Respuesta definitiva del portal (documento inexistente / no corresponde al NIT): no insistir
  if (attempts > 1 && /no (se )?(encontr|hall)|no existe|no corresponde|no es v[aá]lid|no pertenece/i.test(errorText)) {
    await finishCufe('fail', `La DIAN respondió: ${errorText}`);
    return;
  }
  if (attempts > MAX_SEARCH_ATTEMPTS) {
    const diag = describePage();
    await sendLog(`Diagnóstico: ${diag}`);
    await finishCufe('fail', errorText ? `La DIAN respondió: ${errorText}`
      : 'La consulta pública de la DIAN no devolvió ningún documento para este CUFE. Suele pasar con los ' +
        '"Application Response" (eventos como acuse de recibo o aceptación), que no tienen representación gráfica, ' +
        `o cuando el NIT no es el del emisor ni el del receptor · ${diag}`);
    return;
  }

  await sendLog(`Página de búsqueda cargada${attempts > 1 ? ` (intento ${attempts})` : ''}.`);

  const docKeyInput = document.querySelector('#DocumentKey');
  const nitInput = document.querySelector('#SearchDocumentNit');
  const searchForm = document.querySelector('#search-document-form');
  const searchBtn = document.querySelector('.search-document');

  if (!docKeyInput || !nitInput) {
    await finishCufe('retry', 'no se encontró el formulario de búsqueda');
    return;
  }

  setInputValue(docKeyInput, data.currentCufe);
  setInputValue(nitInput, data.nit);
  await sendLog('CUFE y NIT ingresados. Esperando el captcha (resuélvalo si se lo pide)...');

  const token = await waitForCaptcha();
  if (!token) return; // proceso detenido

  await sendLog('Captcha resuelto. Enviando consulta...');
  setTimeout(() => {
    if (searchBtn) searchBtn.click();
    else if (searchForm) searchForm.submit();
  }, 150);
}

// --- RUTA 2: Descarga del documento ---
// La DIAN usa varias variantes de esta página, por ejemplo:
//   - Factura: <form action="/Document/DownloadPDF"> con trackId, token, captcha
//   - Documento soporte y otros: <form action="/Document/PrintSupportDocument"> con cune, token, captcha
// Se usa el formulario del botón "Descargar PDF" (o el que apunte a una descarga/impresión)
// y se envía a su propia dirección con todos sus campos.
const DOWNLOAD_TEXT_RE = /descargar\s*(el\s*)?(pdf|documento|representaci)|imprimir|download\s*pdf/i;

function findDownloadControl() {
  return document.querySelector('a.downloadLink') ||
    [...document.querySelectorAll('a, button, input[type="submit"], input[type="button"]')]
      .find((a) => DOWNLOAD_TEXT_RE.test(a.innerText || a.value || ''));
}

function findDownloadForm() {
  const isSearch = (f) => f.querySelector('#DocumentKey') || /SearchDocument/i.test(f.getAttribute('action') || '');
  const fromControl = findDownloadControl()?.closest('form');
  if (fromControl && !isSearch(fromControl) && !/ShowDocumentToPublic/i.test(fromControl.getAttribute('action') || '')) return fromControl;
  const forms = [...document.forms].filter((f) => !isSearch(f));
  return forms.find((f) => /download|print|pdf/i.test(f.getAttribute('action') || '')) ||
    forms.find((f) => f.querySelector('input[name="token"]') && !/ShowDocumentToPublic/i.test(f.getAttribute('action') || '')) ||
    null;
}

async function handleDocumentPage() {
  await sendLog('Página del documento cargada. Obteniendo PDF...');

  const form = findDownloadForm();
  const pdfLink = document.querySelector('a[href*="DownloadPDF" i], a[href*="PrintSupport" i], a[href$=".pdf" i]')?.href;

  if (!form && !pdfLink) {
    const diag = describePage();
    await sendLog(`Diagnóstico: ${diag}`);
    await finishCufe('fail', `la página del documento no tiene formulario de descarga de PDF · ${diag}`);
    return;
  }

  try {
    let response;
    if (form) {
      const action = form.getAttribute('action') || '/Document/DownloadPDF';
      const needsCaptcha = form.querySelector('input[name="captcha"]') ||
        document.querySelector('.cf-turnstile, input[name="cf-turnstile-response"]');
      const captchaToken = needsCaptcha ? await waitForCaptcha() : '';
      if (needsCaptcha && !captchaToken) return; // proceso detenido

      const formData = new FormData(form); // incluye __RequestVerificationToken, trackId/cune, token...
      if (form.querySelector('input[name="captcha"]')) formData.set('captcha', captchaToken);
      if (!formData.get('__RequestVerificationToken')) {
        const vt = document.querySelector('input[name="__RequestVerificationToken"]')?.value;
        if (vt) formData.set('__RequestVerificationToken', vt);
      }
      await sendLog(`Solicitando PDF (${action})...`);
      response = await fetch(action, { method: (form.getAttribute('method') || 'POST').toUpperCase(), body: formData });
    } else {
      await sendLog('Descargando PDF desde el enlace de la página...');
      response = await fetch(pdfLink);
    }

    if (response.status === 403 || response.status === 429) {
      await reportBlocked(`HTTP ${response.status} al pedir el PDF`);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();
    const head = await blob.slice(0, 2048).text();
    if (!head.includes('%PDF')) {
      if (BLOCK_RE.test(head)) { await reportBlocked('el portal bloqueó la descarga del PDF'); return; }
      const ctype = response.headers.get('content-type') || '?';
      const snippet = head.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 150);
      throw new Error(`el servidor no devolvió un PDF (tipo ${ctype}): "${snippet}"`);
    }

    await sendLog(`PDF recibido (${Math.round(blob.size / 1024)} KB). Leyendo y guardando...`);
    const dataUrl = await blobToDataURL(blob);

    // Esperamos a que el PDF quede guardado antes de pasar al siguiente CUFE.
    const result = await chrome.runtime.sendMessage({ action: 'SAVE_PDF', dataUrl });
    if (!result || !result.ok) throw new Error(result?.error || 'no se pudo guardar');

    await finishCufe('ok');
  } catch (err) {
    await finishCufe('retry', err.message); // temporal: el service worker decide si reintenta
  }
}

async function init() {
  // Solo actuamos en la pestaña que abrió la extensión (evita que otras pestañas
  // de la DIAN abiertas por el usuario también rellenen formularios).
  const isWorkerTab = await chrome.runtime.sendMessage({ action: 'IS_WORKER_TAB' }).catch(() => false);
  if (!isWorkerTab) return;

  const data = await chrome.storage.local.get(['isProcessing', 'currentCufe', 'nit', 'currentIndex', 'searchAttempts']);
  if (!data.isProcessing || !data.currentCufe) return;

  // 1) ¿El portal bloqueó la solicitud o está verificando que no seamos un bot?
  let bs = blockState();
  if (bs === 'challenge') {
    await sendLog('El portal está verificando el navegador ("no sea un bot"). Esperando a que termine (resuélvalo si se lo pide)...');
    const start = Date.now();
    while (bs === 'challenge' && Date.now() - start < CHALLENGE_TIMEOUT_MS) {
      await sleep(1000);
      bs = blockState(); // si la verificación termina, la página navega y este script se vuelve a cargar
    }
    if (bs === 'challenge') bs = 'blocked';
  }
  if (bs === 'blocked') {
    await reportBlocked(blockDetail());
    return;
  }

  // 2) La búsqueda se envía por POST a /User/SearchDocument, así que la página del
  //    documento puede llegar con esa MISMA URL. Por eso se decide por el contenido.
  const kind = await detectPageKind();
  if (kind === 'document') await handleDocumentPage();
  else if (kind === 'search') await handleSearchPage(data);
  else if (blockState()) await reportBlocked(blockDetail());
  else {
    const diag = describePage();
    await sendLog(`Página no reconocida. Diagnóstico: ${diag}`);
    await finishCufe('retry', `página no reconocida · ${diag}`);
  }
}

function pageKindNow() {
  // Algunas páginas de resultado también traen el cuadro de búsqueda: si hay formulario de descarga, es el documento
  if (findDownloadForm()) return 'document';
  if (document.querySelector('#DocumentKey')) return 'search';
  if (findDownloadControl()) return 'document';
  if (document.querySelector('a[href*="DownloadPDF" i], form[action*="DownloadPDF" i]')) return 'document';
  return null;
}

// Espera hasta ~6 s por si parte del contenido se carga con JavaScript.
async function detectPageKind() {
  for (let i = 0; i < 20; i++) {
    const kind = pageKindNow();
    if (kind) return kind;
    await sleep(POLL_MS);
  }
  // Página de detalle del documento sin botón de descarga (p. ej. un tipo sin representación gráfica)
  if (/ShowDocumentToPublic/i.test(location.pathname) || /detalles? del documento/i.test(document.title)) return 'document';
  return null;
}

// Diagnóstico compacto para el log y la hoja "Descargas" del Excel
function describePage() {
  const txt = (el) => (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').substring(0, 60);
  const forms = [...document.forms].map((f) =>
    `${(f.method || 'get').toUpperCase()} ${f.getAttribute('action') || '(sin action)'} [${[...f.querySelectorAll('input[name], select[name]')].map((i) => i.name).join(',')}]`
  ).join(' | ');
  const ctrl = findDownloadControl();
  const ctrlHtml = ctrl ? ctrl.outerHTML.replace(/\s+/g, ' ').substring(0, 200) : '(ninguno)';
  const heads = [...document.querySelectorAll('h1,h2,h3,h4')].map(txt).filter(Boolean).slice(0, 4).join(' / ');
  const body = (document.querySelector('main, .container, body')?.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 160);
  return `URL=${location.pathname} | Título="${document.title}" | Encabezados=${heads || '-'} | Error="${visibleErrorText()}" | ` +
    `Formularios=${forms || '(ninguno)'} | Botón descarga=${ctrlHtml} | Texto="${body}"`;
}

init();
