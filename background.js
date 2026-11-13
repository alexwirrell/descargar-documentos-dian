// ===================== Service worker =====================
const SEARCH_URL = 'https://catalogo-vpfe.dian.gov.co/User/SearchDocument';
const FALLBACK_FOLDER = 'Facturas_DIAN'; // subcarpeta de Descargas si no se puede usar la carpeta elegida
const OFFSCREEN_URL = 'offscreen.html';
const MAX_LOGS = 500;

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

// ---------- Documento offscreen (descifrado + escritura en carpeta) ----------
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
        justification: 'Quitar la contraseña del PDF y guardarlo en la carpeta elegida'
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

async function savePdf({ dataUrl }) {
  const { nit, currentCufe } = await chrome.storage.local.get(['nit', 'currentCufe']);
  const filename = `${sanitizeFilename(currentCufe || 'factura_' + Date.now())}.pdf`;

  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'PROCESS_PDF',
    dataUrl,
    nit,
    filename
  });

  if (!res || !res.ok) throw new Error(res?.error || 'sin respuesta del procesador de PDF');

  if (res.decrypted && res.wasEncrypted) await appendLog('Contraseña eliminada del PDF.');
  else if (res.decrypted) await appendLog('El PDF no tenía contraseña.');
  else await appendLog(`ADVERTENCIA: no se pudo quitar la contraseña (${res.warning}). Se guarda el original como ${res.filename}`);

  await storeSaveResult(res);

  // Datos leídos del PDF → se acumulan para el Excel final
  const ex = res.extracted || { header: {}, products: [] };
  const h = ex.header || {};
  await addRecord({ cufe: currentCufe, archivo: res.filename, estado: 'OK', header: h, products: ex.products || [] });
  const total = typeof h.total_factura === 'number' ? h.total_factura.toLocaleString('es-CO', { minimumFractionDigits: 2 }) : '?';
  await appendLog(`Datos leídos: ${h.numero || '(sin número)'} · ${h.emisor_razon_social || '?'} → ${h.adq_nombre || '?'} · ` +
    `${(ex.products || []).length} línea(s) · total ${total}${h.observaciones ? ` · OJO: ${h.observaciones}` : ''}`);

  return { ok: true, decrypted: res.decrypted };
}

// Escribe el resultado de saveBytes (carpeta elegida o respaldo en Descargas) y lo registra en el log
async function storeSaveResult(res) {
  if (res.savedIn === 'folder') {
    await appendLog(`Guardado en “${res.folder}/${res.filename}”.`);
    return;
  }
  // Respaldo con chrome.downloads (solo puede guardar dentro de Descargas).
  await downloadAsync({
    url: res.dataUrl,
    filename: `${FALLBACK_FOLDER}/${res.filename}`,
    conflictAction: 'overwrite',
    saveAs: false
  });
  await appendLog(`ATENCIÓN: ${res.folderProblem}. Guardado en Descargas/${FALLBACK_FOLDER}/${res.filename}. ` +
    'Use “Seleccionar carpeta” en el popup para autorizarla.');
}

// ---------- Registros para el Excel ----------
let recordsQueue = Promise.resolve();
function addRecord(record) {
  recordsQueue = recordsQueue
    .then(async () => {
      const { reportRecords = [] } = await chrome.storage.local.get('reportRecords');
      reportRecords.push(record);
      await chrome.storage.local.set({ reportRecords });
    })
    .catch(() => {});
  return recordsQueue;
}

async function generateReport() {
  await recordsQueue;
  const { reportRecords = [] } = await chrome.storage.local.get('reportRecords');
  if (!reportRecords.length) {
    await appendLog('No hay datos para generar el Excel.');
    return;
  }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename = `Resumen_DIAN_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.xlsx`;
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'BUILD_REPORT', records: reportRecords, filename });
    if (!res || !res.ok) throw new Error(res?.error || 'sin respuesta');
    await storeSaveResult(res);
    const ok = reportRecords.filter((r) => r.estado === 'OK').length;
    await appendLog(`📊 Excel generado: ${filename} (${ok} documento(s) leído(s), ${reportRecords.length - ok} con error).`);
  } catch (err) {
    await appendLog(`Error generando el Excel: ${err.message}`);
  }
}

// ---------- Flujo de la cola de CUFEs ----------
async function openCurrentCufe() {
  const data = await chrome.storage.local.get(['cufesQueue', 'currentIndex', 'isProcessing', 'workTabId', 'stats']);
  if (!data.isProcessing) return;

  const queue = data.cufesQueue || [];
  const index = data.currentIndex || 0;

  if (index >= queue.length) {
    const stats = data.stats || { ok: 0, failed: [] };
    await appendLog(`¡Proceso completado! ${stats.ok} guardado(s), ${stats.failed.length} con error.`);
    if (stats.failed.length) {
      await appendLog(`CUFEs con error: ${stats.failed.map((c) => c.substring(0, 15) + '…').join(', ')}`);
    }
    await chrome.storage.local.set({ isProcessing: false, currentCufe: null });
    await generateReport();
    return;
  }

  const currentCufe = queue[index];
  await chrome.storage.local.set({ currentCufe });
  await appendLog(`[${index + 1}/${queue.length}] Procesando CUFE: ${currentCufe.substring(0, 15)}...`);

  let tabId = data.workTabId;
  try {
    if (tabId) await chrome.tabs.update(tabId, { url: SEARCH_URL, active: true });
    else throw new Error('sin pestaña');
  } catch (e) {
    const tab = await chrome.tabs.create({ url: SEARCH_URL, active: true });
    tabId = tab.id;
    await chrome.storage.local.set({ workTabId: tabId });
  }
}

async function finishCufe({ status, reason }) {
  const data = await chrome.storage.local.get(['currentIndex', 'currentCufe', 'stats', 'isProcessing']);
  if (!data.isProcessing) return;
  const stats = data.stats || { ok: 0, failed: [] };
  if (status === 'ok') {
    stats.ok += 1;
  } else {
    stats.failed.push(data.currentCufe);
    await addRecord({ cufe: data.currentCufe, estado: 'ERROR', error: reason || 'desconocido', header: {}, products: [] });
    await appendLog(`ERROR con este CUFE: ${reason || 'desconocido'}. Se continúa con el siguiente.`);
  }
  await chrome.storage.local.set({ currentIndex: (data.currentIndex || 0) + 1, stats, searchAttempts: null });
  await openCurrentCufe();
}

async function startProcess() {
  // Una pestaña nueva y dedicada: el content script solo actúa en ella.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  await chrome.storage.local.set({ workTabId: tab.id, stats: { ok: 0, failed: [] }, searchAttempts: null, reportRecords: [] });
  await openCurrentCufe();
}

async function stopProcess() {
  const { isProcessing } = await chrome.storage.local.get('isProcessing');
  await chrome.storage.local.set({ isProcessing: false });
  await appendLog('Proceso detenido por el usuario.');
  if (isProcessing) await generateReport(); // Excel parcial con lo procesado hasta ahora
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { workTabId, isProcessing } = await chrome.storage.local.get(['workTabId', 'isProcessing']);
  if (tabId === workTabId) {
    await chrome.storage.local.set({ workTabId: null });
    if (isProcessing) {
      await chrome.storage.local.set({ isProcessing: false });
      await appendLog('Se cerró la pestaña de trabajo. Proceso detenido.');
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
      chrome.storage.local.get(['workTabId', 'isProcessing']).then((d) => {
        sendResponse(Boolean(d.isProcessing && sender.tab && sender.tab.id === d.workTabId));
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

    case 'START_PROCESS':
      startProcess();
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
