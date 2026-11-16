document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);
  const nitInput = $('nit');
  const cufesInput = $('cufes');
  const cufeCount = $('cufeCount');
  const folderBox = $('folderBox');
  const btnFolder = $('btnFolder');
  const btnStart = $('btnStart');
  const btnStop = $('btnStop');
  const btnResume = $('btnResume');
  const btnClearLogs = $('btnClearLogs');
  const btnCopyLogs = $('btnCopyLogs');
  const btnReport = $('btnReport');
  const renameFiles = $('renameFiles');
  const pauseSeconds = $('pauseSeconds');
  const progress = $('progress');
  const logsDiv = $('logs');
  const msg = $('msg');

  let currentLogs = [];

  function renderLogs(logsList) {
    currentLogs = logsList || [];
    // Rendimiento: un solo cambio en el DOM aunque haya cientos de líneas
    const frag = document.createDocumentFragment();
    currentLogs.forEach((text) => {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      entry.textContent = text;
      frag.appendChild(entry);
    });
    logsDiv.replaceChildren(frag);
    logsDiv.scrollTop = logsDiv.scrollHeight;
  }

  const STATUS_TEXT = {
    running: 'En curso',
    waiting_block: '⏳ Esperando por bloqueo del portal',
    paused: '⛔ Pausado por bloqueo del portal',
    stopped: 'Detenido',
    done: 'Completado'
  };

  async function renderState() {
    const d = await chrome.storage.local.get(['isProcessing', 'cufesQueue', 'currentIndex', 'stats', 'runStatus', 'blockedUntil']);
    const on = Boolean(d.isProcessing);
    const queue = d.cufesQueue || [];
    const idx = d.currentIndex || 0;
    const pending = queue.length > 0 && idx < queue.length;

    btnStart.disabled = on;
    btnStart.textContent = on ? 'Procesando...' : 'Iniciar Descargas';
    btnStop.disabled = !on;
    btnResume.hidden = on || !pending || d.runStatus === 'done';
    btnResume.textContent = `▶ Reanudar desde el CUFE ${idx + 1} de ${queue.length}`;

    if (!queue.length) { progress.textContent = ''; return; }
    const s = d.stats || { ok: 0, failed: 0 };
    const failed = Array.isArray(s.failed) ? s.failed.length : (s.failed || 0);
    let text = `${STATUS_TEXT[d.runStatus] || ''} · ${Math.min(idx, queue.length)}/${queue.length} procesados · ✔ ${s.ok || 0} · ✖ ${failed}`;
    if (d.runStatus === 'waiting_block' && d.blockedUntil) text += ` · reintento a las ${new Date(d.blockedUntil).toLocaleTimeString()}`;
    progress.textContent = text;
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

  // Comprueba la carpeta antes de iniciar o reanudar
  async function folderReady() {
    const { handle, state } = await getFolderStatus();
    if (!handle) {
      msg.textContent = 'Primero seleccione la carpeta de destino.';
      openFolderWindow(false);
      return null;
    }
    if (state !== 'granted') {
      msg.textContent = 'Chrome pide volver a autorizar la carpeta. Autorícela y pulse de nuevo.';
      openFolderWindow(true);
      return null;
    }
    return handle;
  }

  // ---- Estado inicial ----
  const saved = await chrome.storage.local.get(['nit', 'logsHistory', 'isProcessing', 'cufesQueue', 'renameFiles', 'pauseSeconds']);
  if (saved.nit) nitInput.value = saved.nit;
  if (saved.cufesQueue && !saved.isProcessing) cufesInput.value = saved.cufesQueue.join('\n');
  renameFiles.checked = saved.renameFiles !== false;
  pauseSeconds.value = saved.pauseSeconds || 0;
  renderLogs(saved.logsHistory || []);
  updateCount();
  renderFolder();
  renderState();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.logsHistory) renderLogs(changes.logsHistory.newValue);
    if (changes.isProcessing || changes.currentIndex || changes.stats || changes.runStatus || changes.cufesQueue) renderState();
    if (changes.folderLabel) renderFolder();
  });

  cufesInput.addEventListener('input', updateCount);
  nitInput.addEventListener('change', () => chrome.storage.local.set({ nit: nitInput.value.trim() }));
  renameFiles.addEventListener('change', () => chrome.storage.local.set({ renameFiles: renameFiles.checked }));
  pauseSeconds.addEventListener('change', () => {
    const v = Math.max(0, Math.min(600, parseInt(pauseSeconds.value, 10) || 0));
    pauseSeconds.value = v;
    chrome.storage.local.set({ pauseSeconds: v });
  });
  btnFolder.addEventListener('click', () => openFolderWindow(false));

  btnClearLogs.addEventListener('click', async () => {
    await chrome.storage.local.set({ logsHistory: [] });
    logsDiv.replaceChildren();
  });

  btnCopyLogs.addEventListener('click', async () => {
    const text = currentLogs.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Respaldo si el portapapeles moderno no está disponible
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const old = btnCopyLogs.textContent;
    btnCopyLogs.textContent = `✔ Copiado (${currentLogs.length})`;
    setTimeout(() => { btnCopyLogs.textContent = old; }, 1500);
  });

  btnStop.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'STOP_PROCESS' }));

  btnReport.addEventListener('click', () => {
    msg.textContent = '';
    chrome.runtime.sendMessage({ action: 'BUILD_REPORT' });
  });

  btnResume.addEventListener('click', async () => {
    msg.textContent = '';
    if (!(await folderReady())) return;
    chrome.runtime.sendMessage({ action: 'RESUME_PROCESS' });
  });

  btnStart.addEventListener('click', async () => {
    msg.textContent = '';
    const nit = nitInput.value.trim();
    const cufes = parseCufes();

    if (!nit) { msg.textContent = 'Debe ingresar el NIT.'; return; }
    if (cufes.length === 0) { msg.textContent = 'Ingrese al menos un CUFE.'; return; }

    const handle = await folderReady();
    if (!handle) return;

    btnStart.disabled = true;
    await chrome.storage.local.set({
      nit,
      cufesQueue: cufes,
      currentIndex: 0,
      isProcessing: true,
      renameFiles: renameFiles.checked,
      pauseSeconds: Math.max(0, parseInt(pauseSeconds.value, 10) || 0),
      logsHistory: [`[${new Date().toLocaleTimeString()}] Iniciando proceso para ${cufes.length} CUFE(s). Carpeta: ${handle.name}`]
    });
    chrome.runtime.sendMessage({ action: 'START_PROCESS' });
  });
});
