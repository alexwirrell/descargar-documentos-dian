// Página para elegir la carpeta de destino.
// Se abre en una ventana propia porque el selector de carpetas cierra el popup
// de la extensión y la selección se perdería.
const folderNameEl = document.getElementById('folderName');
const permEl = document.getElementById('perm');
const btnPick = document.getElementById('btnPick');
const btnAuth = document.getElementById('btnAuth');
const statusEl = document.getElementById('status');

const PERM_LABELS = { granted: 'concedido ✔', prompt: 'pendiente de autorizar', denied: 'denegado', none: '-' };

function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

async function refresh() {
  const { handle, state } = await getFolderStatus();
  folderNameEl.textContent = handle ? handle.name : '(ninguna)';
  permEl.textContent = PERM_LABELS[state] || state;
  btnAuth.hidden = !handle || state === 'granted';
}

btnPick.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'dian-facturas', mode: 'readwrite', startIn: 'downloads' });
    // El selector con mode 'readwrite' ya concede el permiso; lo confirmamos por si acaso.
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      await handle.requestPermission({ mode: 'readwrite' });
    }
    await idbSet('dirHandle', handle);
    await chrome.storage.local.set({ folderLabel: handle.name });
    setStatus(`Carpeta “${handle.name}” guardada. Ya puede iniciar las descargas desde el popup.`, 'ok');
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`No se pudo elegir la carpeta: ${err.message}`, 'err');
  }
  refresh();
});

btnAuth.addEventListener('click', async () => {
  try {
    const handle = await idbGet('dirHandle');
    if (!handle) return;
    const state = await handle.requestPermission({ mode: 'readwrite' });
    if (state === 'granted') setStatus('Acceso autorizado. Ya puede iniciar las descargas desde el popup.', 'ok');
    else setStatus('No se concedió el permiso. Elija la carpeta de nuevo.', 'err');
  } catch (err) {
    setStatus(`Error al autorizar: ${err.message}`, 'err');
  }
  refresh();
});

if (new URLSearchParams(location.search).get('reauth')) {
  setStatus('Chrome necesita que vuelva a autorizar el acceso a la carpeta antes de descargar.', 'err');
}
refresh();
