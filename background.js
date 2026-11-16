// ===================== Service worker =====================
const SEARCH_URL = 'https://catalogo-vpfe.dian.gov.co/User/SearchDocument';
const FALLBACK_FOLDER = 'Facturas_DIAN'; // subcarpeta de Descargas si no se puede usar la carpeta elegida
const OFFSCREEN_URL = 'offscreen.html';
const MAX_LOGS = 1000;
const MAX_ATTEMPTS = 3;                      // intentos por CUFE ante errores transitorios
const BLOCK_WAIT_MINUTES = [2, 5, 10, 15, 30]; // espera progresiva cuando el portal bloquea
const MAX_BLOCK_WAITS = 6;                   // después de esto el proceso se pausa (se puede reanudar)
const RECORD_PREFIX = 'rec_';                // un registro por CUFE en chrome.storage (rec_00001, ...)

// ---------- Logs (en cola para que no se pisen escrituras simultáneas) ----------
let logQueue = Promise.resolve();
function appendLog(message) {
  console.log(`[BACKGROUND] ${message}`);
  logQueue = logQueue
    .then(async () => {
      const { logsHistory = [] } = await chrome.storage.local.get('logsHistory');
      logsHistory.push(`[${new Date().toLocaleTimeString()}] ${message}`);
      await chrome.storage.local.set({ logsHistory: logsHistory.slice(-MAX_LOGS) });
    })
    .catch(() => {});
  return logQueue;
}

// ---------- Documento offscreen (descifrado, lectura, escritura en carpeta) ----------
let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'Quitar la contraseña del PDF, leer su contenido y guardarlo en la carpeta elegida'
      })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 200);
}

function downloadAsync(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        reject(new Error(chrome.runtime.lastError?.message || 'descarga rechazada'));
      } else {
        resolve(id);
      }
    });
  });
}

const recKey = (index) => `${RECORD_PREFIX}${String(index).padStart(5, '0')}`;

async function savePdf({ dataUrl }) {
  const { nit, currentCufe, currentIndex = 0, renameFiles = true, attempts } =
    await chrome.storage.local.get(['nit', 'currentCufe', 'currentIndex', 'renameFiles', 'attempts']);
  const filename = `${sanitizeFilename(currentCufe || 'documento_' + Date.now())}.pdf`;

  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'PROCESS_PDF',
    dataUrl,
    nit,
    filename,
    rename: renameFiles !== false
  });

  if (!res || !res.ok) throw new Error(res?.error || 'sin respuesta del procesador de PDF');

  if (res.wasEncrypted && res.decrypted) await appendLog('Contraseña eliminada del PDF.');
  else if (res.wasEncrypted) await appendLog(`ADVERTENCIA: no se pudo quitar la contraseña (${res.warning}). Se guarda el original.`);

  await storeSaveResult(res);

  // Datos leídos del PDF → un registro por CUFE para el Excel final (escritura O(1), no reescribe todo)
  const ex = res.extracted || { header: {}, products: [] };
  const h = ex.header || {};
  await chrome.storage.local.set({
    [recKey(currentIndex)]: {
      cufe: currentCufe, archivo: res.filename, estado: 'OK', kind: ex.kind || 'factura',
      header: h, products: ex.products || [], payroll: ex.payroll || null,
      intentos: (attempts && attempts.index === currentIndex ? attempts.count : 0) + 1
    }
  });
  const total = typeof h.total_factura === 'number' ? h.total_factura.toLocaleString('es-CO', { minimumFractionDigits: 2 }) : '?';
  const lineas = ex.kind === 'nomina'
    ? `${(ex.payroll?.devengados || []).length} devengado(s) / ${(ex.payroll?.deducciones || []).length} deducción(es)`
    : `${(ex.products || []).length} línea(s)`;
  await appendLog(`Datos leídos: ${h.tipo_documento || '?'} ${h.numero || '(sin número)'} · ${h.emisor_razon_social || '?'} → ${h.adq_nombre || '?'} · ` +
    `${lineas} · total ${total}${h.observaciones ? ` · OJO: ${h.observaciones}` : ''}`);

  return { ok: true, decrypted: res.decrypted };
}

// Escribe el resultado de saveBytes (carpeta elegida o respaldo en Descargas) y lo registra en el log
async function storeSaveResult(res) {
  if (res.savedIn === 'folder') {
    await appendLog(`Guardado en “${res.folder}/${res.filename}”.`);
    return;
  }
  await downloadAsync({
    url: res.dataUrl,
    filename: `${FALLBACK_FOLDER}/${res.filename}`,
    conflictAction: 'overwrite',
    saveAs: false
  });
  await appendLog(`ATENCIÓN: ${res.folderProblem}. Guardado en Descargas/${FALLBACK_FOLDER}/${res.filename}. ` +
    'Use “Seleccionar carpeta” en el popup para autorizarla.');
}

// ---------- Excel ----------
async function loadRecords() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(RECORD_PREFIX)).sort().map((k) => all[k]);
}

async function clearRecords() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(RECORD_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function generateReport() {
  const records = await loadRecords();
  const { cufesQueue = [] } = await chrome.storage.local.get('cufesQueue');
  if (!records.length) {
    await appendLog('No hay datos para generar el Excel.');
    return;
  }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename = `Resumen_DIAN_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.xlsx`;
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'BUILD_REPORT', records, queue: cufesQueue, filename });
    if (!res || !res.ok) throw new Error(res?.error || 'sin respuesta');
    await storeSaveResult(res);
    const ok = records.filter((r) => r.estado === 'OK').length;
    const pending = Math.max(0, cufesQueue.length - records.length);
    await appendLog(`📊 Excel generado: ${filename} — ${ok} descargado(s), ${records.length - ok} no descargado(s)` +
      `${pending ? `, ${pending} pendiente(s)` : ''}. Ver la hoja “Descargas”.`);
  } catch (err) {
    await appendLog(`Error generando el Excel: ${err.message}`);
  }
}

// Listado final en el log: CUFE completo de cada documento no descargado (fácil de copiar)
async function logSummary() {
  const records = await loadRecords();
  const failed = records.filter((r) => r.estado !== 'OK');
  const ok = records.length - failed.length;
  await appendLog(`Resumen: ${ok} descargado(s), ${failed.length} no descargado(s).`);
  for (const r of failed) await appendLog(`NO DESCARGADO: ${r.cufe} — ${r.error || 'sin detalle'}`);
}

// ---------- Flujo de la cola de CUFEs ----------
async function setStatus(status) {
  await chrome.storage.local.set({ runStatus: status });
}

async function openCurrentCufe() {
  const data = await chrome.storage.local.get(['cufesQueue', 'currentIndex', 'isProcessing', 'workTabId', 'attempts']);
  if (!data.isProcessing) return;

  const queue = data.cufesQueue || [];
  const index = data.currentIndex || 0;

  if (index >= queue.length) {
    await chrome.storage.local.set({ isProcessing: false, currentCufe: null, runStatus: 'done' });
    await appendLog('¡Proceso completado!');
    await logSummary();
    await generateReport();
    return;
  }

  const currentCufe = queue[index];
  await chrome.storage.local.set({ currentCufe, runStatus: 'running' });
  const attempt = data.attempts && data.attempts.index === index ? data.attempts.count + 1 : 1;
  await appendLog(`[${index + 1}/${queue.length}] Procesando CUFE: ${currentCufe.substring(0, 15)}...` +
    `${attempt > 1 ? ` (intento ${attempt}/${MAX_ATTEMPTS})` : ''}`);

  let tabId = data.workTabId;
  try {
    if (tabId) await chrome.tabs.update(tabId, { url: SEARCH_URL });
    else throw new Error('sin pestaña');
  } catch (e) {
    const tab = await chrome.tabs.create({ url: SEARCH_URL, active: true });
    tabId = tab.id;
    await chrome.storage.local.set({ workTabId: tabId });
  }
}

// Espera N segundos antes de seguir. Para esperas largas usa chrome.alarms
// (el service worker puede dormirse y perder un setTimeout).
async function waitThen(seconds, alarmName) {
  if (seconds <= 0) return openCurrentCufe();
  if (seconds < 30) {
    setTimeout(() => openCurrentCufe(), seconds * 1000);
    return;
  }
  await chrome.alarms.create(alarmName, { delayInMinutes: seconds / 60 });
}

async function finishCufe({ status, reason }) {
  const data = await chrome.storage.local.get(['currentIndex', 'currentCufe', 'stats', 'isProcessing', 'attempts', 'pauseSeconds']);
  if (!data.isProcessing) return;
  const index = data.currentIndex || 0;
  const stats = data.stats || { ok: 0, failed: 0 };
  const prevCount = data.attempts && data.attempts.index === index ? data.attempts.count : 0;
  const count = prevCount + 1;

  if (status === 'retry' && count < MAX_ATTEMPTS) {
    await chrome.storage.local.set({ attempts: { index, count } });
    await appendLog(`Fallo temporal: ${reason || 'desconocido'}. Se reintenta este CUFE en 5 s.`);
    return waitThen(5, 'retry-cufe');
  }

  if (status === 'ok') {
    stats.ok += 1;
    await chrome.storage.local.set({ blockWaits: 0 });
  } else {
    stats.failed += 1;
    await chrome.storage.local.set({
      [recKey(index)]: { cufe: data.currentCufe, estado: 'ERROR', error: reason || 'desconocido', header: {}, products: [], intentos: count }
    });
    await appendLog(`ERROR con este CUFE: ${reason || 'desconocido'}. Se continúa con el siguiente.`);
  }
  await chrome.storage.local.set({ currentIndex: index + 1, stats, searchAttempts: null, attempts: null });

  const pause = Math.max(0, Number(data.pauseSeconds) || 0);
  if (pause > 0) await appendLog(`Pausa de ${pause} s antes del siguiente documento...`);
  return waitThen(pause, 'next-cufe');
}

// El portal mostró una verificación anti-bot que no se resolvió o bloqueó la solicitud.
// No se intenta esquivar: se espera (cada vez más) y se reintenta el MISMO CUFE.
async function handleBlocked({ detail }) {
  const data = await chrome.storage.local.get(['isProcessing', 'runStatus', 'blockWaits', 'workTabId']);
  if (!data.isProcessing || data.runStatus === 'waiting_block') return;
  const waits = (data.blockWaits || 0) + 1;

  // Dejar de cargar el portal mientras se espera
  if (data.workTabId) chrome.tabs.update(data.workTabId, { url: 'about:blank' }).catch(() => {});

  if (waits > MAX_BLOCK_WAITS) {
    await chrome.storage.local.set({ isProcessing: false, runStatus: 'paused', blockWaits: 0 });
    await appendLog(`⛔ El portal de la DIAN sigue bloqueando las consultas (${detail}). Proceso PAUSADO. ` +
      'Pulse “Reanudar” más tarde: continuará desde este mismo CUFE.');
    await generateReport();
    return;
  }

  const minutes = BLOCK_WAIT_MINUTES[Math.min(waits - 1, BLOCK_WAIT_MINUTES.length - 1)];
  const at = new Date(Date.now() + minutes * 60000).toLocaleTimeString();
  await chrome.storage.local.set({ runStatus: 'waiting_block', blockWaits: waits, blockedUntil: Date.now() + minutes * 60000 });
  await appendLog(`⚠️ El portal de la DIAN bloqueó la consulta (${detail}). Esperando ${minutes} min ` +
    `(hasta las ${at}) para reintentar el mismo CUFE. No cierre el navegador.`);
  await chrome.alarms.create('retry-block', { delayInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const { isProcessing } = await chrome.storage.local.get('isProcessing');
  if (!isProcessing) return;
  if (alarm.name === 'retry-block') await appendLog('Reintentando después de la espera por bloqueo...');
  await setStatus('running');
  await openCurrentCufe();
});

async function startProcess() {
  await chrome.alarms.clearAll();
  await clearRecords();
  // Una pestaña nueva y dedicada: el content script solo actúa en ella.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  await chrome.storage.local.set({
    workTabId: tab.id, stats: { ok: 0, failed: 0 }, searchAttempts: null, attempts: null,
    blockWaits: 0, runStatus: 'running'
  });
  await openCurrentCufe();
}

async function resumeProcess() {
  const data = await chrome.storage.local.get(['cufesQueue', 'currentIndex', 'workTabId']);
  const queue = data.cufesQueue || [];
  if (!queue.length || (data.currentIndex || 0) >= queue.length) {
    await appendLog('No hay CUFEs pendientes para reanudar.');
    return;
  }
  await chrome.alarms.clearAll();
  await chrome.storage.local.set({ isProcessing: true, runStatus: 'running', blockWaits: 0, searchAttempts: null });
  await appendLog(`Reanudando desde el CUFE ${(data.currentIndex || 0) + 1} de ${queue.length}...`);
  let tabOk = false;
  if (data.workTabId) tabOk = await chrome.tabs.get(data.workTabId).then(() => true, () => false);
  if (!tabOk) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    await chrome.storage.local.set({ workTabId: tab.id });
  }
  await openCurrentCufe();
}

async function stopProcess() {
  const { isProcessing } = await chrome.storage.local.get('isProcessing');
  await chrome.alarms.clearAll();
  await chrome.storage.local.set({ isProcessing: false, runStatus: 'stopped' });
  await appendLog('Proceso detenido por el usuario. Puede continuar luego con “Reanudar”.');
  if (isProcessing) {
    await logSummary();
    await generateReport(); // Excel parcial con lo procesado hasta ahora
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { workTabId, isProcessing } = await chrome.storage.local.get(['workTabId', 'isProcessing']);
  if (tabId === workTabId) {
    await chrome.storage.local.set({ workTabId: null });
    if (isProcessing) {
      await chrome.alarms.clearAll();
      await chrome.storage.local.set({ isProcessing: false, runStatus: 'stopped' });
      await appendLog('Se cerró la pestaña de trabajo. Proceso detenido (puede “Reanudar”).');
      await generateReport();
    }
  }
});

// ---------- Mensajes ----------
// Importante: el listener NO es async. Devuelve true cuando va a responder más tarde.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target === 'offscreen') return false; // mensajes para el documento offscreen

  if (request.type === 'LOG') {
    appendLog(request.message);
    return false;
  }

  switch (request.action) {
    case 'IS_WORKER_TAB':
      chrome.storage.local.get(['workTabId', 'isProcessing', 'runStatus']).then((d) => {
        sendResponse(Boolean(d.isProcessing && d.runStatus === 'running' && sender.tab && sender.tab.id === d.workTabId));
      });
      return true;

    case 'SAVE_PDF':
      savePdf(request).then(sendResponse, async (err) => {
        await appendLog(`Error guardando el PDF: ${err.message}`);
        sendResponse({ ok: false, error: err.message });
      });
      return true;

    case 'CUFE_DONE':
      finishCufe(request);
      return false;

    case 'BLOCKED':
      handleBlocked(request);
      return false;

    case 'START_PROCESS':
      startProcess();
      return false;

    case 'RESUME_PROCESS':
      resumeProcess();
      return false;

    case 'STOP_PROCESS':
      stopProcess();
      return false;

    case 'BUILD_REPORT': // botón "Generar Excel" del popup (vuelve a generar con la última corrida)
      generateReport();
      return false;
  }
  return false;
});
