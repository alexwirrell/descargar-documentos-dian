// Pequeño almacén clave/valor en IndexedDB.
// Se usa para guardar el FileSystemDirectoryHandle de la carpeta elegida
// (chrome.storage no puede guardar handles; IndexedDB sí).
const DIAN_IDB_NAME = 'dian-downloader';
const DIAN_IDB_STORE = 'kv';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DIAN_IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DIAN_IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DIAN_IDB_STORE, 'readonly');
    const req = tx.objectStore(DIAN_IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DIAN_IDB_STORE, 'readwrite');
    tx.objectStore(DIAN_IDB_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

// Estado del permiso de escritura sobre la carpeta guardada.
// Devuelve { handle, state } donde state es 'granted' | 'prompt' | 'denied' | 'none'.
async function getFolderStatus() {
  const handle = await idbGet('dirHandle');
  if (!handle) return { handle: null, state: 'none' };
  const state = await handle.queryPermission({ mode: 'readwrite' });
  return { handle, state };
}
