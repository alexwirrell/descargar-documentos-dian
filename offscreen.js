// Documento offscreen: aquí se quita la contraseña del PDF (qpdf compilado a WebAssembly)
// y se escribe el archivo en la carpeta elegida (File System Access API).
// Se hace en un documento y no en el service worker porque estas APIs funcionan
// de forma fiable solo en contextos de ventana.

// Este archivo se carga como módulo ES (ver offscreen.html).
import * as pdfjsLib from './lib/pdfjs/pdf.min.mjs';
import { parseInvoicePdf } from './lib/invoice-parser.mjs';
import { buildReport } from './lib/report.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/pdf.worker.min.mjs');

let qpdfPromise = null;

function getQpdf() {
  if (!qpdfPromise) {
    qpdfPromise = (async () => {
      const resp = await fetch(chrome.runtime.getURL('lib/qpdf.wasm'));
      const wasmBinary = await resp.arrayBuffer();
      // `Module` es la fábrica global que define lib/qpdf.js
      return Module({ wasmBinary, print: () => {}, printErr: () => {} });
    })().catch((err) => {
      qpdfPromise = null;
      throw err;
    });
  }
  return qpdfPromise;
}

function passwordCandidates(nit) {
  const raw = String(nit || '').trim();
  const beforeDash = raw.split('-')[0].trim();
  const digits = raw.replace(/\D/g, '');
  // El último intento con contraseña vacía cubre PDFs que solo tienen contraseña de propietario.
  return [...new Set([raw, beforeDash, digits].filter(Boolean)), ''];
}

function looksEncrypted(bytes) {
  // Heurística: buscar "/Encrypt" en los últimos 64 KB (trailer / diccionario de cifrado)
  const tail = bytes.subarray(Math.max(0, bytes.length - 65536));
  return new TextDecoder('latin1').decode(tail).includes('/Encrypt');
}

async function removePassword(bytes, nit) {
  const qpdf = await getQpdf();
  const IN = '/in.pdf';
  const OUT = '/out.pdf';
  try {
    qpdf.FS.writeFile(IN, bytes);
    for (const pw of passwordCandidates(nit)) {
      let rc;
      try {
        rc = qpdf.callMain([`--password=${pw}`, '--decrypt', IN, OUT]);
      } catch (e) {
        rc = 2;
      }
      // qpdf: 0 = ok, 3 = ok con advertencias, 2 = error (p. ej. contraseña inválida)
      if (rc === 0 || rc === 3) {
        const out = qpdf.FS.readFile(OUT);
        return { ok: true, bytes: new Uint8Array(out) };
      }
    }
    return { ok: false, error: 'Ninguna contraseña funcionó (se probó el NIT ingresado).' };
  } finally {
    try { qpdf.FS.unlink(IN); } catch (e) {}
    try { qpdf.FS.unlink(OUT); } catch (e) {}
  }
}

function bytesToDataUrl(bytes, mime = 'application/pdf') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

async function writeToFolder(handle, filename, bytes) {
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function processPdf({ dataUrl, nit, filename }) {
  const original = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  const header = new TextDecoder('latin1').decode(original.subarray(0, 1024));
  if (!header.includes('%PDF')) {
    return { ok: false, error: 'El archivo recibido no es un PDF.' };
  }

  const wasEncrypted = looksEncrypted(original);
  let finalBytes = original;
  let finalName = filename;
  let decrypted = false;
  let warning = null;

  try {
    const result = await removePassword(original, nit);
    if (result.ok) {
      finalBytes = result.bytes;
      decrypted = true;
    } else {
      warning = result.error;
    }
  } catch (err) {
    warning = `Error al quitar la contraseña: ${err.message}`;
  }

  if (!decrypted && wasEncrypted) {
    // Se guarda el original pero marcado, para que no pase desapercibido.
    finalName = filename.replace(/\.pdf$/i, '') + '_PROTEGIDO.pdf';
  }

  // Leer el contenido del PDF (copia: pdf.js transfiere el buffer al worker y lo deja vacío)
  let extracted = null;
  try {
    extracted = await parseInvoicePdf(pdfjsLib, finalBytes.slice(), decrypted ? undefined : String(nit || '').trim());
    delete extracted.fields;
  } catch (err) {
    extracted = { header: { observaciones: `No se pudo leer el contenido del PDF: ${err.message}` }, products: [] };
  }

  const saved = await saveBytes(finalName, finalBytes, 'application/pdf');
  return { ok: true, wasEncrypted, decrypted, warning, filename: finalName, extracted, ...saved };
}

// Guarda en la carpeta elegida; si no se puede, devuelve un dataUrl para que el
// service worker lo guarde con chrome.downloads (carpeta Descargas).
async function saveBytes(name, bytes, mime) {
  let folderProblem;
  try {
    const { handle, state } = await getFolderStatus();
    if (handle && state === 'granted') {
      await writeToFolder(handle, name, bytes);
      return { savedIn: 'folder', folder: handle.name };
    }
    folderProblem = handle ? 'sin permiso de escritura sobre la carpeta' : 'no hay carpeta seleccionada';
  } catch (err) {
    folderProblem = `no se pudo escribir en la carpeta (${err.message})`;
  }
  return { savedIn: 'fallback', folderProblem, dataUrl: await bytesToDataUrl(bytes, mime) };
}

async function buildAndSaveReport({ records, filename }) {
  const bytes = buildReport(records || []);
  const saved = await saveBytes(filename, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return { ok: true, filename, ...saved };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  const handlers = { PROCESS_PDF: processPdf, BUILD_REPORT: buildAndSaveReport };
  const handler = handlers[msg.action];
  if (!handler) return false;
  handler(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true; // respuesta asíncrona
});
