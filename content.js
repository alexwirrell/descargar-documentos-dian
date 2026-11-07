// ===================== Content script (páginas de la DIAN) =====================
const MAX_SEARCH_ATTEMPTS = 3;

function sendLog(msg) {
  console.log(`[CONTENT_SCRIPT] ${msg}`);
  return chrome.runtime.sendMessage({ type: 'LOG', message: msg }).catch(() => {});
}

function finishCufe(status, reason) {
  return chrome.runtime.sendMessage({ action: 'CUFE_DONE', status, reason }).catch(() => {});
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getTurnstileValue() {
  for (const input of document.querySelectorAll('input[name="cf-turnstile-response"]')) {
    if (input.value) return input.value;
  }
  return '';
}

// Espera a que el captcha Turnstile tenga token. Se cancela si el usuario detiene el proceso.
function waitForCaptcha() {
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      const token = getTurnstileValue();
      if (token) {
        clearInterval(timer);
        resolve(token);
        return;
      }
      const { isProcessing } = await chrome.storage.local.get('isProcessing');
      if (!isProcessing) {
        clearInterval(timer);
        resolve(null);
      }
    }, 800);
  });
}

function setInputValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function visibleErrorText() {
  const el = document.querySelector('.alert-danger, .validation-summary-errors, .field-validation-error, .text-danger');
  const text = el?.innerText?.trim();
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

  if (attempts > MAX_SEARCH_ATTEMPTS) {
    await finishCufe('fail', errorText || `documento no encontrado tras ${MAX_SEARCH_ATTEMPTS} intentos`);
    return;
  }

  await sendLog(`Página de búsqueda cargada${attempts > 1 ? ` (intento ${attempts})` : ''}.`);

  const docKeyInput = document.querySelector('#DocumentKey');
  const nitInput = document.querySelector('#SearchDocumentNit');
  const searchForm = document.querySelector('#search-document-form');
  const searchBtn = document.querySelector('.search-document');

  if (!docKeyInput || !nitInput) {
    await finishCufe('fail', 'no se encontró el formulario de búsqueda');
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
  }, 500);
}

// --- RUTA 2: Descarga del documento ---
async function handleDocumentPage(data) {
  await sendLog('Página del documento cargada. Obteniendo PDF...');

  const trackId = document.querySelector('input[name="trackId"]')?.value;
  const token = document.querySelector('input[name="token"]')?.value;
  const verificationToken = document.querySelector('input[name="__RequestVerificationToken"]')?.value;

  const pdfLink = document.querySelector('a[href*="DownloadPDF" i]')?.href;

  if (!(trackId && token) && !pdfLink) {
    await sendLog(`Diagnóstico: ${describePage()}`);
    await finishCufe('fail', 'no se encontraron los identificadores del documento en la página');
    return;
  }

  try {
    let response;
    if (trackId && token) {
      const hasCaptcha = document.querySelector('.cf-turnstile, input[name="cf-turnstile-response"]');
      const captchaToken = hasCaptcha ? await waitForCaptcha() : '';
      if (hasCaptcha && !captchaToken) return; // proceso detenido
      await sendLog('Solicitando PDF...');

      const formData = new FormData();
      formData.append('__RequestVerificationToken', verificationToken || '');
      formData.append('trackId', trackId);
      formData.append('token', token);
      formData.append('captcha', captchaToken || '');
      response = await fetch('/Document/DownloadPDF', { method: 'POST', body: formData });
    } else {
      await sendLog('Descargando PDF desde el enlace de la página...');
      response = await fetch(pdfLink);
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();
    const head = await blob.slice(0, 1024).text();
    if (!head.includes('%PDF')) {
      throw new Error('el servidor no devolvió un PDF (posible captcha vencido o sesión expirada)');
    }

    await sendLog(`PDF recibido (${Math.round(blob.size / 1024)} KB). Quitando contraseña y guardando...`);
    const dataUrl = await blobToDataURL(blob);

    // Esperamos a que el PDF quede guardado antes de pasar al siguiente CUFE.
    const result = await chrome.runtime.sendMessage({ action: 'SAVE_PDF', dataUrl });
    if (!result || !result.ok) throw new Error(result?.error || 'no se pudo guardar');

    await finishCufe('ok');
  } catch (err) {
    await finishCufe('fail', err.message);
  }
}

async function init() {
  // Solo actuamos en la pestaña que abrió la extensión (evita que otras pestañas
  // de la DIAN abiertas por el usuario también rellenen formularios).
  const isWorkerTab = await chrome.runtime.sendMessage({ action: 'IS_WORKER_TAB' }).catch(() => false);
  if (!isWorkerTab) return;

  const data = await chrome.storage.local.get(['isProcessing', 'currentCufe', 'nit', 'currentIndex', 'searchAttempts']);
  if (!data.isProcessing || !data.currentCufe) return;

  // La búsqueda se envía por POST a /User/SearchDocument, así que la página del
  // documento puede llegar con esa MISMA URL. Por eso se decide por el contenido.
  const kind = await detectPageKind();
  if (kind === 'document') await handleDocumentPage(data);
  else if (kind === 'search') await handleSearchPage(data);
  else {
    await sendLog(`Página no reconocida. Diagnóstico: ${describePage()}`);
    await finishCufe('fail', 'la DIAN devolvió una página no reconocida (ver diagnóstico arriba)');
  }
}

function pageKindNow() {
  if (document.querySelector('input[name="trackId"]') && document.querySelector('input[name="token"]')) return 'document';
  if (document.querySelector('a[href*="DownloadPDF" i], form[action*="DownloadPDF" i]')) return 'document';
  if (document.querySelector('#DocumentKey')) return 'search';
  return null;
}

// Espera hasta 10 s por si parte del contenido se carga con JavaScript.
async function detectPageKind() {
  for (let i = 0; i < 20; i++) {
    const kind = pageKindNow();
    if (kind) return kind;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function describePage() {
  const txt = (el) => (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').substring(0, 60);
  const forms = [...document.forms].map((f) => `${f.method}:${f.getAttribute('action')}`).join(' | ');
  const inputs = [...document.querySelectorAll('input[name]')].map((i) => i.name).join(',');
  const links = [...document.querySelectorAll('a, button')]
    .filter((a) => /pdf|descarg|download/i.test(txt(a) + (a.getAttribute('href') || '')))
    .map((a) => `"${txt(a)}"→${a.getAttribute('href') || a.getAttribute('onclick') || ''}`)
    .join(' | ');
  const heads = [...document.querySelectorAll('h1,h2,h3')].map(txt).filter(Boolean).slice(0, 4).join(' / ');
  return `URL=${location.pathname} | Título="${document.title}" | Encabezados=${heads} | Error="${visibleErrorText()}" | ` +
    `Forms=${forms} | Inputs=${inputs} | Enlaces PDF=${links || '(ninguno)'}`;
}

init();
