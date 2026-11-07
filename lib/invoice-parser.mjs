// =====================================================================
// Lector de la representación gráfica DIAN ("Solución Gratuita DIAN").
//
// Estrategia: pdf.js entrega cada fragmento de texto con su posición (x, y).
// Con eso se reconstruyen líneas y se leen:
//   - campos "Etiqueta: valor" por sección (documento, emisor, adquiriente)
//   - totales (columna derecha = moneda local COP)
//   - tabla "Detalles de Productos" por columnas (según encabezados) y filas
//     (ancladas en la columna "Nro.").
// No depende de coordenadas fijas, así que tolera nombres/direcciones largas.
// =====================================================================

const Y_TOL = 2.5; // tolerancia vertical para considerar dos fragmentos en la misma línea

export function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// "123.500,00" -> 123500 ; "19.00" -> 19 ; "13,00" -> 13
export function parseNumber(s) {
  if (s === null || s === undefined) return null;
  let t = String(s).replace(/[$\s]|COP/gi, '');
  if (!t || !/\d/.test(t)) return null;
  const neg = /^-|^\(.*\)$/.test(t);
  t = t.replace(/[()-]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const isNumeric = (s) => /^-?\(?[\d.,]+\)?$/.test(String(s).trim()) && /\d/.test(s);

// ---------------------------------------------------------------------
// 1) Extracción de fragmentos con pdf.js
// ---------------------------------------------------------------------
export async function extractItems(pdfjsLib, bytes, password) {
  const doc = await pdfjsLib.getDocument({
    data: bytes,
    password: password || undefined,
    isEvalSupported: false,
    useSystemFonts: false
  }).promise;
  const items = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        const str = (it.str || '').replace(/\s+/g, ' ').trim();
        if (!str) continue;
        const x = it.transform[4];
        const y = it.transform[5];
        items.push({ page: p, x, y, w: it.width, x2: x + it.width, cx: x + it.width / 2, str });
      }
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return items;
}

// Ordena en orden de lectura y agrupa por líneas
function buildLines(items) {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.page === it.page && Math.abs(last.y - it.y) <= Y_TOL) last.items.push(it);
    else lines.push({ page: it.page, y: it.y, items: [it] });
  }
  lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));
  return lines;
}

// ---------------------------------------------------------------------
// 2) Campos "Etiqueta: valor"
// ---------------------------------------------------------------------
const SECTION_HEADINGS = [
  { re: /^datos del documento/, key: 'doc' },
  { re: /^datos del emisor/, key: 'emisor' },
  { re: /^datos del adquiriente|^datos del adquirente|^datos del comprador/, key: 'adq' },
  { re: /^detalles? de productos/, key: 'productos' },
  { re: /^notas finales/, key: 'notas' },
  { re: /^datos totales/, key: 'totales' }
];

function sectionOf(str) {
  const n = norm(str);
  const h = SECTION_HEADINGS.find((s) => s.re.test(n));
  return h ? h.key : null;
}

// ¿Es una etiqueta? Devuelve { label, inline } o null
function asLabel(it, nextIt) {
  const s = it.str;
  if (nextIt && nextIt.str === ':' && /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(s) && !/\d/.test(s)) {
    return { label: s, inline: '' };
  }
  const m = s.match(/^([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ\/().º°\s-]{1,60}):\s*(.*)$/);
  if (!m) return null;
  return { label: m[1].trim(), inline: m[2].trim() };
}

function extractFields(lines) {
  const fields = {}; // clave "seccion|etiqueta normalizada" -> valor
  let section = 'otros';

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // ¿la línea es un título de sección?
    for (const it of line.items) {
      const sec = sectionOf(it.str);
      if (sec) section = sec;
    }
    if (section === 'productos') continue;

    // localizar etiquetas de la línea
    const labels = [];
    line.items.forEach((it, idx) => {
      const lab = asLabel(it, line.items[idx + 1]);
      if (lab) labels.push({ idx, it, ...lab });
    });

    labels.forEach((lab, k) => {
      const nextLab = labels[k + 1];
      const endX = nextLab ? nextLab.it.x - 1 : Infinity;
      let value = lab.inline;
      let prevEnd = lab.it.x2;
      for (let j = lab.idx + 1; j < line.items.length; j++) {
        const it = line.items[j];
        if (it.x >= endX) break;
        if (it.x - prevEnd > 30) break; // salto grande = otra columna/bloque
        prevEnd = it.x2;
        if (it.str === ':' && j === lab.idx + 1) continue;
        value = value ? `${value} ${it.str}` : it.str;
      }
      // Valor debajo, alineado con la etiqueta (p. ej. CUFE, autorización, fechas)
      if (!value || /-$/.test(value)) {
        for (let b = li + 1; b < lines.length && b <= li + 3; b++) {
          const below = lines[b];
          if (below.page !== line.page || line.y - below.y > 14) break;
          const cand = below.items.find((c, ci) => Math.abs(c.x - lab.it.x) <= 4 && !asLabel(c, below.items[ci + 1]) && !sectionOf(c.str));
          if (cand) { value = value ? `${value}${cand.str}` : cand.str; break; }
        }
      }
      const key = `${section}|${norm(lab.label)}`;
      if (!(key in fields) || (!fields[key] && value)) fields[key] = value.trim();
    });
  }
  return fields;
}

function pick(fields, section, ...aliases) {
  for (const a of aliases) {
    const re = a instanceof RegExp ? a : null;
    for (const [k, v] of Object.entries(fields)) {
      const [sec, lab] = k.split('|');
      if (section && sec !== section) continue;
      if (re ? re.test(lab) : lab === norm(a)) {
        if (v) return v;
      }
    }
  }
  return '';
}

// ---------------------------------------------------------------------
// 3) Totales (columna derecha = moneda local)
// ---------------------------------------------------------------------
const TOTAL_LABELS = {
  moneda: 'moneda',
  tasa_cambio: 'tasa de cambio',
  subtotal: 'subtotal',
  descuento_detalle: 'descuento detalle',
  recargo_detalle: 'recargo detalle',
  total_bruto: 'total bruto factura',
  iva: 'iva',
  inc: 'inc',
  bolsas: 'bolsas',
  otros_impuestos: 'otros impuestos',
  total_impuesto: 'total impuesto (=)',
  total_neto: 'total neto factura (=)',
  descuento_global: 'descuento global (-)',
  recargo_global: 'recargo global (+)',
  total_factura: 'total factura (=)',
  anticipos: 'anticipos',
  rete_fuente: 'rete fuente',
  rete_iva: 'rete iva',
  rete_ica: 'rete ica'
};
const TOTAL_BY_LABEL = Object.fromEntries(Object.entries(TOTAL_LABELS).map(([k, v]) => [v, k]));

function extractTotals(lines) {
  const totals = {};
  const bestX = {};
  let inTotals = false;
  for (const line of lines) {
    if (line.items.some((it) => sectionOf(it.str) === 'totales')) inTotals = true;
    if (!inTotals) continue;
    const labs = line.items.filter((it) => TOTAL_BY_LABEL[norm(it.str)]);
    labs.forEach((lab, k) => {
      const key = TOTAL_BY_LABEL[norm(lab.str)];
      const endX = labs[k + 1] ? labs[k + 1].x : Infinity;
      const vals = line.items.filter((it) => it.x > lab.x2 && it.x < endX && it.str !== '$');
      let value;
      if (key === 'moneda') {
        value = vals.map((v) => v.str).find((s) => /^[A-Z]{3}$/.test(s)) || '';
      } else {
        const num = [...vals].reverse().find((v) => isNumeric(v.str));
        value = num ? parseNumber(num.str) : null;
      }
      // Hay dos bloques (moneda extranjera / moneda local): se prefiere el de más a la derecha con valor.
      const hasValue = value !== null && value !== '';
      if (hasValue && (bestX[key] === undefined || lab.x > bestX[key])) {
        totals[key] = value;
        bestX[key] = lab.x;
      } else if (!(key in totals)) {
        totals[key] = key === 'moneda' ? '' : null;
      }
    });
  }
  return totals;
}

// ---------------------------------------------------------------------
// 4) Tabla de productos
// ---------------------------------------------------------------------
function columnKey(name, prevKeys) {
  const n = norm(name);
  if (/^nro\.?$|^no\.?$|^item$/.test(n)) return 'nro';
  if (/^codigo/.test(n)) return 'codigo';
  if (/^descripcion/.test(n)) return 'descripcion';
  if (/^u\/m|^unidad/.test(n)) return 'um';
  if (/^cantidad/.test(n)) return 'cantidad';
  if (/unitario de venta|^valor total|^total$/.test(n)) return 'valor_venta';
  if (/^precio unitario$|^valor unitario/.test(n)) return 'precio_unitario';
  if (/^descuento/.test(n)) return 'descuento';
  if (/^recargo/.test(n)) return 'recargo';
  if (/^iva$/.test(n)) return 'iva';
  if (/^inc$/.test(n)) return 'inc';
  if (n === '%') {
    const last = prevKeys[prevKeys.length - 1];
    if (last === 'iva') return 'pct_iva';
    if (last === 'inc') return 'pct_inc';
    return 'pct_' + prevKeys.length;
  }
  return 'col_' + n.replace(/[^a-z0-9]+/g, '_');
}

function extractProducts(items) {
  const products = [];
  const headers = items.filter((it) => /^nro\.?$/i.test(it.str));
  for (const nroHdr of headers) {
    const page = nroHdr.page;
    const hy = nroHdr.y;
    const pageItems = items.filter((it) => it.page === page);

    // Encabezados: fragmentos cercanos a la línea del "Nro." (pueden ocupar 2-3 líneas)
    const hdrItems = pageItems.filter((it) => it.y <= hy + 18 && it.y >= hy - 6 && it.x >= nroHdr.x - 5 && norm(it.str) !== 'impuestos');
    // Agrupar en columnas por solapamiento horizontal
    const cols = [];
    for (const it of [...hdrItems].sort((a, b) => a.x - b.x)) {
      const c = cols.find((col) => it.x < col.x2 - 1 && it.x2 > col.x + 1);
      if (c) {
        c.parts.push(it);
        c.x = Math.min(c.x, it.x);
        c.x2 = Math.max(c.x2, it.x2);
      } else cols.push({ x: it.x, x2: it.x2, parts: [it] });
    }
    cols.sort((a, b) => a.x - b.x);
    const keys = [];
    cols.forEach((c) => {
      c.name = c.parts.sort((a, b) => b.y - a.y).map((p) => p.str).join(' ');
      c.key = columnKey(c.name, keys);
      c.cx = (c.x + c.x2) / 2;
      keys.push(c.key);
    });
    const hdrBottom = Math.min(...hdrItems.map((h) => h.y));

    // Límite inferior: siguiente título/pie de página
    const stopper = pageItems
      .filter((it) => it.y < hdrBottom && (sectionOf(it.str) || /^hoja \d+ de \d+$/i.test(it.str)))
      .sort((a, b) => b.y - a.y)[0];
    const bottom = stopper ? stopper.y + 4 : -Infinity;
    const region = pageItems.filter((it) => it.y < hdrBottom - 1 && it.y > bottom && it.str !== '$');

    const colOf = (it) => cols.reduce((best, c) => (Math.abs(c.cx - it.cx) < Math.abs(best.cx - it.cx) ? c : best), cols[0]);
    const nroCol = cols.find((c) => c.key === 'nro');
    const anchors = region.filter((it) => colOf(it) === nroCol && /^\d+$/.test(it.str)).sort((a, b) => b.y - a.y);
    if (!anchors.length) continue;

    const rows = anchors.map((a) => ({ anchor: a, cells: {} }));
    for (const it of region) {
      if (anchors.includes(it)) continue;
      const row = rows.reduce((best, r) => (Math.abs(r.anchor.y - it.y) < Math.abs(best.anchor.y - it.y) ? r : best), rows[0]);
      const col = colOf(it);
      (row.cells[col.key] = row.cells[col.key] || []).push(it);
    }

    // Ancho máximo de fragmentos de texto (para saber si una palabra se cortó al final de la línea)
    const textWidthMax = {};
    rows.forEach((r) => Object.entries(r.cells).forEach(([k, arr]) => arr.forEach((it) => {
      textWidthMax[k] = Math.max(textWidthMax[k] || 0, it.w);
    })));

    const joinCell = (key, arr) => {
      if (!arr || !arr.length) return '';
      const sorted = [...arr].sort((a, b) => b.y - a.y || a.x - b.x);
      let out = '';
      let prev = null;
      for (const it of sorted) {
        if (!prev) out = it.str;
        else if (Math.abs(prev.y - it.y) <= Y_TOL) out += ' ' + it.str;
        else {
          // Salto de línea: si la línea anterior llenaba la columna, la palabra se partió → sin espacio
          const full = prev.w >= 0.9 * (textWidthMax[key] || prev.w) && sorted.length > 1 && /[A-Za-zÁÉÍÓÚÑ0-9]$/.test(out) && /^[A-Za-zÁÉÍÓÚÑ0-9]/.test(it.str);
          out += (full ? '' : ' ') + it.str;
        }
        prev = it;
      }
      return out.trim();
    };

    for (const r of rows) {
      const get = (k) => joinCell(k, r.cells[k]);
      products.push({
        nro: Number(r.anchor.str),
        codigo: get('codigo'),
        descripcion: get('descripcion'),
        um: get('um'),
        cantidad: parseNumber(get('cantidad')),
        precio_unitario: parseNumber(get('precio_unitario')),
        descuento: parseNumber(get('descuento')),
        recargo: parseNumber(get('recargo')),
        iva: parseNumber(get('iva')),
        pct_iva: parseNumber(get('pct_iva')),
        inc: parseNumber(get('inc')),
        pct_inc: parseNumber(get('pct_inc')),
        valor_venta: parseNumber(get('valor_venta'))
      });
    }
  }
  // Evitar duplicados si el encabezado se repite en otra página
  const seen = new Set();
  return products.filter((p) => {
    const k = `${p.nro}|${p.codigo}|${p.valor_venta}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------
// 5) Notas finales
// ---------------------------------------------------------------------
function extractNotes(lines) {
  const out = [];
  let on = false;
  for (const line of lines) {
    for (const it of line.items) {
      const sec = sectionOf(it.str);
      if (sec) { on = sec === 'notas'; continue; }
      if (/^hoja \d+ de \d+$/i.test(it.str)) { on = false; continue; }
      if (on) out.push(it.str);
    }
  }
  return out.join(' ').trim();
}

// ---------------------------------------------------------------------
// API principal
// ---------------------------------------------------------------------
export function parseInvoiceItems(items) {
  const lines = buildLines(items);
  const fields = extractFields(lines);
  const totals = extractTotals(lines);
  const products = extractProducts(items);
  const p1 = items.filter((i) => i.page === 1);
  const title = p1.length ? p1.reduce((a, b) => (b.y > a.y ? b : a)).str : '';

  const header = {
    tipo_documento: title,
    numero: pick(fields, 'doc', /^numero de /, /^numero$/, /^no\. /),
    cufe: pick(fields, 'doc', /cufe|cude|codigo unico/),
    fecha_emision: pick(fields, 'doc', 'fecha de emision'),
    fecha_vencimiento: pick(fields, 'doc', 'fecha de vencimiento'),
    forma_pago: pick(fields, 'doc', 'forma de pago'),
    medio_pago: pick(fields, 'doc', 'medio de pago'),
    tipo_operacion: pick(fields, 'doc', 'tipo de operacion'),
    orden_pedido: pick(fields, 'doc', 'orden de pedido'),
    emisor_nit: pick(fields, 'emisor', /^nit/),
    emisor_razon_social: pick(fields, 'emisor', 'razon social', 'nombre o razon social'),
    emisor_nombre_comercial: pick(fields, 'emisor', 'nombre comercial'),
    emisor_tipo_contribuyente: pick(fields, 'emisor', 'tipo de contribuyente'),
    emisor_regimen: pick(fields, 'emisor', 'regimen fiscal'),
    emisor_responsabilidad: pick(fields, 'emisor', 'responsabilidad tributaria'),
    emisor_actividad: pick(fields, 'emisor', /^actividad economica/),
    emisor_departamento: pick(fields, 'emisor', 'departamento'),
    emisor_municipio: pick(fields, 'emisor', /^municipio/),
    emisor_direccion: pick(fields, 'emisor', 'direccion'),
    emisor_telefono: pick(fields, 'emisor', /^telefono/),
    emisor_correo: pick(fields, 'emisor', 'correo'),
    adq_nombre: pick(fields, 'adq', 'nombre o razon social', 'razon social'),
    adq_tipo_documento: pick(fields, 'adq', 'tipo de documento'),
    adq_numero_documento: pick(fields, 'adq', 'numero documento', 'numero de documento'),
    adq_tipo_contribuyente: pick(fields, 'adq', 'tipo de contribuyente'),
    adq_regimen: pick(fields, 'adq', 'regimen fiscal'),
    adq_responsabilidad: pick(fields, 'adq', 'responsabilidad tributaria'),
    adq_departamento: pick(fields, 'adq', 'departamento'),
    adq_municipio: pick(fields, 'adq', /^municipio/),
    adq_direccion: pick(fields, 'adq', 'direccion'),
    adq_telefono: pick(fields, 'adq', /^telefono/),
    adq_correo: pick(fields, 'adq', 'correo'),
    fecha_generacion: pick(fields, null, 'documento generado el'),
    fecha_validacion_dian: pick(fields, null, 'dian'),
    autorizacion: pick(fields, null, 'numero de autorizacion'),
    rango_desde: pick(fields, null, 'rango desde'),
    rango_hasta: pick(fields, null, 'rango hasta'),
    vigencia: pick(fields, null, 'vigencia'),
    notas: extractNotes(lines),
    ...totals
  };

  // Validaciones básicas
  const obs = [];
  if (!header.cufe) obs.push('No se encontró el CUFE en el PDF');
  if (!header.numero) obs.push('No se encontró el número del documento');
  if (header.total_factura === null || header.total_factura === undefined) obs.push('No se encontró el total');
  if (!products.length) obs.push('No se encontraron líneas de producto');
  const sumLines = products.reduce((s, p) => s + (p.valor_venta || 0), 0);
  if (products.length && header.subtotal !== null && header.subtotal !== undefined && Math.abs(sumLines - header.subtotal) > 1) {
    obs.push(`Suma de líneas (${sumLines.toFixed(2)}) ≠ subtotal (${header.subtotal})`);
  }
  header.num_lineas = products.length;
  header.observaciones = obs.join('; ');

  return { header, products, fields };
}

export async function parseInvoicePdf(pdfjsLib, bytes, password) {
  const items = await extractItems(pdfjsLib, bytes, password);
  if (!items.length) {
    return { header: { observaciones: 'El PDF no contiene texto extraíble (¿imagen escaneada?)' }, products: [], fields: {} };
  }
  return parseInvoiceItems(items);
}
