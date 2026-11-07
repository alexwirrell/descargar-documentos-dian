document.addEventListener('DOMContentLoaded', async () => {
  const nitInput = document.getElementById('nit');
  const cufesInput = document.getElementById('cufes');
  const cufeCount = document.getElementById('cufeCount');
  const folderBox = document.getElementById('folderBox');
  const btnFolder = document.getElementById('btnFolder');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const logsDiv = document.getElementById('logs');
  const msg = document.getElementById('msg');

  function renderLogs(logsList) {
    logsDiv.innerHTML = '';
    (logsList || []).forEach((text) => {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      entry.textContent = text;
      logsDiv.appendChild(entry);
    });
    logsDiv.scrollTop = logsDiv.scrollHeight;
  }

  function setProcessing(on) {
    btnStart.disabled = on;
    btnStart.textContent = on ? 'Procesando...' : 'Iniciar Descargas';
    btnStop.disabled = !on;
  }

  function parseCufes() {
    const list = cufesInput.value.split(/\r?\n/).map((c) => c.trim()).filter((c) => c.length > 0);
    return [...new Set(list)]; // sin duplicados
  }

  function updateCount() {
    const n = parseCufes().length;
    cufeCount.textContent = n ? `${n} CUFE(s) únicos` : '';
  }

  async function renderFolder() {
    try {
      const { handle, state } = await getFolderStatus();
      if (!handle) {
        folderBox.textContent = '(ninguna)';
        folderBox.className = 'folder-box warn';
      } else {
        folderBox.textContent = state === 'granted' ? `📁 ${handle.name}` : `📁 ${handle.name} (sin autorizar)`;
        folderBox.className = state === 'granted' ? 'folder-box' : 'folder-box warn';
        folderBox.title = handle.name;
      }
    } catch (e) {
      folderBox.textContent = '(error leyendo carpeta)';
    }
  }

  function openFolderWindow(reauth = false) {
    // El selector de carpetas no puede abrirse dentro del popup (Chrome lo cierra),
    // así que se abre en una ventana pequeña propia.
    chrome.windows.create({
      url: chrome.runtime.getURL(`folder.html${reauth ? '?reauth=1' : ''}`),
      type: 'popup',
      width: 460,
      height: 380
    });
  }

  // ---- Estado inicial ----
  const saved = await chrome.storage.local.get(['nit', 'logsHistory', 'isProcessing', 'cufesQueue']);
  if (saved.nit) nitInput.value = saved.nit;
  if (saved.cufesQueue && !saved.isProcessing) cufesInput.value = saved.cufesQueue.join('\n');
  renderLogs(saved.logsHistory || []);
  setProcessing(Boolean(saved.isProcessing));
  updateCount();
  renderFolder();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.logsHistory) renderLogs(changes.logsHistory.newValue);
    if (changes.isProcessing) setProcessing(Boolean(changes.isProcessing.newValue));
    if (changes.folderLabel) renderFolder();
  });

  cufesInput.addEventListener('input', updateCount);
  nitInput.addEventListener('change', () => chrome.storage.local.set({ nit: nitInput.value.trim() }));
  btnFolder.addEventListener('click', () => openFolderWindow(false));

  btnClearLogs.addEventListener('click', async () => {
    await chrome.storage.local.set({ logsHistory: [] });
    logsDiv.innerHTML = '';
  });

  btnStop.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'STOP_PROCESS' }));

  const btnReport = document.getElementById('btnReport');
  btnReport.addEventListener('click', () => {
    msg.textContent = '';
    chrome.runtime.sendMessage({ action: 'BUILD_REPORT' });
  });

  btnStart.addEventListener('click', async () => {
    msg.textContent = '';
    const nit = nitInput.value.trim();
    const cufes = parseCufes();

    if (!nit) { msg.textContent = 'Debe ingresar el NIT.'; return; }
    if (cufes.length === 0) { msg.textContent = 'Ingrese al menos un CUFE.'; return; }

    const { handle, state } = await getFolderStatus();
    if (!handle) {
      msg.textContent = 'Primero seleccione la carpeta de destino.';
      openFolderWindow(false);
      return;
    }
    if (state !== 'granted') {
      msg.textContent = 'Chrome pide volver a autorizar la carpeta. Autorícela y pulse Iniciar de nuevo.';
      openFolderWindow(true);
      return;
    }

    setProcessing(true);
    await chrome.storage.local.set({
      nit,
      cufesQueue: cufes,
      currentIndex: 0,
      isProcessing: true,
      logsHistory: [`[${new Date().toLocaleTimeString()}] Iniciando proceso para ${cufes.length} CUFE(s). Carpeta: ${handle.name}`]
    });
    chrome.runtime.sendMessage({ action: 'START_PROCESS' });
  });
});
