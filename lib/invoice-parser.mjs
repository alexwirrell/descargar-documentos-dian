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
  { re: /^datos del emisor|^datos del vendedor|^datos del proveedor/, key: 'emisor' },
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

// Etiquetas que la DIAN escribe sin dos puntos (el valor va debajo)
const NO_COLON_LABELS = [/^documento validado por la dian$/];

// ¿Es una etiqueta? Devuelve { label, inline } o null
function asLabel(it, nextIt) {
  const s = it.str;
  if (NO_COLON_LABELS.some((re) => re.test(norm(s)))) return { label: s, inline: '' };
  if (nextIt && nextIt.str === ':' && /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(s) && !/\d/.test(s)) {
    return { label: s, inline: '' };
  }
  const m = s.match(/^([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ\/().º°\s-]{1,60}):\s*(.*)$/);
  if (!m) return null;
  return { label: m[1].trim(), inline: m[2].trim() };
}

function extractFields(lines) {
  // 1) Sección de cada fragmento (en orden de lectura)
  let section = 'otros';
  const all = [];
  for (const line of lines) {
    line.items.forEach((it, idx) => {
      const sec = sectionOf(it.str);
      if (sec) { section = sec; it.isHeading = true; }
      it.section = section;
      it.nextOnLine = line.items[idx + 1];
      all.push(it);
    });
  }

  // 2) Etiquetas ("Algo:"), uniendo las que vienen partidas en dos renglones
  //    (p. ej. "Responsabilidad" / "tributaria:")
  const labels = [];
  for (const it of all) {
    if (it.isHeading || it.section === 'productos') continue;
    const lab = asLabel(it, it.nextOnLine);
    if (!lab) continue;
    it.isLabel = true;
    let text = lab.label;
    let cy = it.y;
    const above = all.find((a) => a.page === it.page && a !== it && Math.abs(a.x - it.x) <= 2 &&
      a.y - it.y > 0 && a.y - it.y <= 14 && !a.isHeading && !/[\d:]/.test(a.str) && !asLabel(a, a.nextOnLine));
    if (above) {
      above.isLabelPart = true;
      text = `${above.str} ${text}`;
      cy = (above.y + it.y) / 2;
    }
    labels.push({ it, label: text, inline: lab.inline, cy, section: it.section });
  }

  const fields = {};
  const sameRow = (a, cy) => Math.abs(a.y - cy) <= 8;
  for (const L of labels) {
    const { it } = L;
    const page = it.page;
    // Límite derecho: la siguiente etiqueta (o etiqueta de totales) en la misma franja
    const stops = all.filter((o) => o.page === page && o.x > it.x + 1 && sameRow(o, L.cy) &&
      (o.isLabel || totalKey(o.str)));
    const endX = stops.length ? Math.min(...stops.map((o) => o.x)) : Infinity;

    const vals = all.filter((o) => o.page === page && o !== it && !o.isLabel && !o.isLabelPart && !o.isHeading &&
      o.x >= it.x2 - 1 && o.x < endX && o.x - it.x2 <= 160 && sameRow(o, L.cy) && !(o === it.nextOnLine && o.str === ':'))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    let value = [L.inline, ...vals.map((v) => v.str)].filter(Boolean).join(' ');

    // Valor debajo, alineado con la etiqueta (CUFE/CUDS, fechas de validación, vigencia partida)
    if (!value || /-$/.test(value)) {
      const below = all
        .filter((o) => o.page === page && Math.abs(o.x - it.x) <= 4 && it.y - o.y > 2 && it.y - o.y <= 18 &&
          !o.isLabel && !o.isLabelPart && !o.isHeading && !asLabel(o, o.nextOnLine))
        .sort((a, b) => b.y - a.y)[0];
      if (below) value = value ? `${value}${below.str}` : below.str;
    }

    value = value.trim().replace(/^'(.*)'$/, '$1');
    const key = `${L.section}|${norm(L.label)}`;
    if (!(key in fields) || (!fields[key] && value)) fields[key] = value;
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
// Etiquetas de totales (factura electrónica y documento soporte usan nombres distintos)
const TOTAL_PATTERNS = [
  ['moneda', /^moneda$/],
  ['tasa_cambio', /^tasa de cambio/],
  ['base_gravable', /^subtotal base gravable/],
  ['subtotal', /^subtotal$/],
  ['descuento_detalle', /^descuento detalle/],
  ['recargo_detalle', /^recargo detalle/],
  ['total_bruto', /^total bruto/],
  ['iva', /^(total )?iva$/],
  ['inc', /^(total )?inc$/],
  ['bolsas', /^bolsas/],
  ['otros_impuestos', /^otros impuestos/],
  ['total_impuesto', /^total impuestos?\b/],
  ['total_neto', /^total neto/],
  ['descuento_global', /^descuento global/],
  ['recargo_global', /^recargo global/],
  ['total_factura', /^total (factura|documento)\b/],
  ['anticipos', /^anticipos?/],
  ['rete_fuente', /^(rete|rte|ret\.?) ?fuente|^retencion en la fuente/],
  ['rete_iva', /^(rete|rte|ret\.?) ?iva/],
  ['rete_ica', /^(rete|rte|ret\.?) ?ica/]
];
function totalKey(str) {
  const n = norm(str);
  const hit = TOTAL_PATTERNS.find(([, re]) => re.test(n));
  return hit ? hit[0] : null;
}

function extractTotals(lines) {
  const totals = {};
  const bestX = {};
  let inTotals = false;
  for (const line of lines) {
    if (line.items.some((it) => sectionOf(it.str) === 'totales')) inTotals = true;
    if (!inTotals) continue;
    const labs = line.items.filter((it) => totalKey(it.str));
    labs.forEach((lab, k) => {
      const key = totalKey(lab.str);
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
  if (/unitario de venta|venta por item|^valor de venta|^valor total|^total$/.test(n)) return 'valor_venta';
  if (/^forma de generacion/.test(n)) return 'forma_generacion';
  if (/^fecha de compra/.test(n)) return 'fecha_compra';
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

function extractProducts(items, wordWrap = false) {
  const products = [];
  const headers = items.filter((it) => /^nro\.?$/i.test(it.str));
  for (const nroHdr of headers) {
    const page = nroHdr.page;
    const hy = nroHdr.y;
    const pageItems = items.filter((it) => it.page === page);

    // Encabezados: fragmentos cercanos a la línea del "Nro." (pueden ocupar 2-3 líneas)
    const firstRowY = Math.max(-Infinity, ...pageItems.filter((it) => it.y < hy - 2 && /^\d+$/.test(it.str) && Math.abs(it.x - nroHdr.x) < 15).map((it) => it.y));
    const HDR_CONT = /^(item|items|detalle|venta|por|compra|transmision|unitario|unitario de|de|total)$/;
    const hdrItems = pageItems.filter((it) => it.y <= hy + 24 && it.x >= nroHdr.x - 5 &&
      norm(it.str) !== 'impuestos' && !sectionOf(it.str) && it.y > firstRowY + 2 &&
      (it.y >= hy - 6 || (it.y >= hy - 20 && HDR_CONT.test(norm(it.str)))));
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
          const full = !wordWrap && prev.w >= 0.9 * (textWidthMax[key] || prev.w) && sorted.length > 1 && /[A-Za-zÁÉÍÓÚÑ0-9]$/.test(out) && /^[A-Za-zÁÉÍÓÚÑ0-9]/.test(it.str);
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
        valor_venta: parseNumber(get('valor_venta')),
        forma_generacion: get('forma_generacion'),
        fecha_compra: get('fecha_compra')
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
  const p1 = items.filter((i) => i.page === 1);
  // Título: primera línea y las siguientes en MAYÚSCULAS (p. ej. "DOCUMENTO SOPORTE EN ADQUISICIONES / EFECTUADAS A ...")
  const p1lines = lines.filter((l) => l.page === 1);
  const titleParts = [];
  for (const l of p1lines) {
    const t = l.items.map((i) => i.str).join(' ');
    if (!titleParts.length || (t === t.toUpperCase() && /[A-Z]/.test(t) && titleParts.length < 3)) titleParts.push(t);
    else break;
  }
  const title = titleParts.join(' ');
  // El documento soporte corta las descripciones entre palabras; la factura, en cualquier carácter.
  const products = extractProducts(items, /SOPORTE/i.test(title));

  const header = {
    tipo_documento: title,
    numero: pick(fields, 'doc', /^numero de /, /^numero$/, /^no\. /),
    cufe: pick(fields, null, /cufe|cude|cune|cuds|codigo unico/),
    fecha_emision: pick(fields, 'doc', 'fecha de emision', 'fecha de generacion', 'fecha de expedicion'),
    fecha_vencimiento: pick(fields, 'doc', 'fecha de vencimiento'),
    forma_pago: pick(fields, 'doc', 'forma de pago'),
    medio_pago: pick(fields, 'doc', 'medio de pago'),
    tipo_operacion: pick(fields, 'doc', 'tipo de operacion'),
    orden_pedido: pick(fields, 'doc', 'orden de pedido', 'orden de compra'),
    emisor_nit: pick(fields, 'emisor', /^nit/, 'numero de documento', 'numero documento'),
    emisor_tipo_documento: pick(fields, 'emisor', 'tipo de documento'),
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
    adq_tipo_documento: pick(fields, 'adq', 'tipo de documento') || (pick(fields, 'adq', /^nit/) ? 'NIT' : ''),
    adq_numero_documento: pick(fields, 'adq', 'numero documento', 'numero de documento', /^nit/),
    adq_tipo_contribuyente: pick(fields, 'adq', 'tipo de contribuyente'),
    adq_regimen: pick(fields, 'adq', 'regimen fiscal'),
    adq_responsabilidad: pick(fields, 'adq', 'responsabilidad tributaria'),
    adq_departamento: pick(fields, 'adq', 'departamento'),
    adq_municipio: pick(fields, 'adq', /^municipio/),
    adq_direccion: pick(fields, 'adq', 'direccion'),
    adq_telefono: pick(fields, 'adq', /^telefono/),
    adq_correo: pick(fields, 'adq', 'correo'),
    fecha_generacion: pick(fields, null, 'documento generado el'),
    fecha_validacion_dian: pick(fields, null, 'documento validado por la dian', 'dian'),
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
