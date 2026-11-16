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

// Acepta formato colombiano ("1.234.567,89", "13,00") y estadounidense ("$1,697,250", "19.00").
export function parseNumber(s) {
  if (s === null || s === undefined) return null;
  let t = String(s).replace(/[$\s]|COP/gi, '');
  if (!t || !/\d/.test(t) || /[^\d.,()-]/.test(t)) return null;
  const neg = /^-|^\(.*\)$/.test(t);
  t = t.replace(/[()-]/g, '');
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // El último separador es el decimal
    t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Solo comas: varias, o una seguida de exactamente 3 dígitos → miles; si no, decimal
    t = (t.split(',').length > 2 || /^\d{1,3},\d{3}$/.test(t)) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (lastDot >= 0) {
    if (t.split('.').length > 2 || /^\d{1,3}\.\d{3}$/.test(t)) t = t.replace(/\./g, '');
  }
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const isNumeric = (s) => /^-?\(?[\d.,]+\)?$/.test(String(s).trim()) && /\d/.test(s);

// ---------------------------------------------------------------------
// 1) Extracción de fragmentos con pdf.js
// ---------------------------------------------------------------------
export async function extractItems(pdfjsLib, bytes, password, worker) {
  const doc = await pdfjsLib.getDocument({
    data: bytes,
    password: password || undefined,
    isEvalSupported: false,
    useSystemFonts: false,
    ...(worker ? { worker } : {})
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
  { re: /^datos totales/, key: 'totales' },
  { re: /^referencias$/, key: 'referencias' },
  // Nómina electrónica
  { re: /^datos del empleador/, key: 'empleador' },
  { re: /^datos del empleado/, key: 'empleado' },
  { re: /^detalle del documento individual/, key: 'nomina_detalle' },
  { re: /^deducciones$/, key: 'deducciones' },
  { re: /^totales$/, key: 'totales_nomina' }
];

function sectionOf(str) {
  const n = norm(str);
  const h = SECTION_HEADINGS.find((s) => s.re.test(n));
  return h ? h.key : null;
}

// Etiquetas que la DIAN escribe sin dos puntos (el valor va debajo)
const NO_COLON_LABELS = [/^documento validado por la dian$/, /^documento generado$/];

// ¿Es una etiqueta? Devuelve { label, inline } o null
function asLabel(it, nextIt) {
  const s = it.str;
  if (NO_COLON_LABELS.some((re) => re.test(norm(s)))) return { label: s, inline: '' };
  if (nextIt && nextIt.str === ':' && /^\p{L}/u.test(s) && !/\d/.test(s)) {
    return { label: s, inline: '' };
  }
  const m = s.match(/^(\p{L}[\p{L}\/().º°\s\-–—]{1,70}):\s*(.*)$/u);
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
    if (it.isHeading || ['productos', 'referencias', 'nomina_detalle', 'deducciones'].includes(it.section)) continue;
    const lab = asLabel(it, it.nextOnLine);
    if (!lab) continue;
    it.isLabel = true;
    let text = lab.label;
    let cy = it.y;
    const above = all.find((a) => a.page === it.page && a !== it && Math.abs(a.x - it.x) <= 2 &&
      a.y - it.y > 0 && a.y - it.y <= 14 && !a.isHeading && !/[\d:]/.test(a.str) && !asLabel(a, a.nextOnLine) &&
      (/^\p{Ll}/u.test(it.str) || /(\s(y|o|de|del|y\/o)|\/)$/i.test(a.str)));
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
      (o.isLabel || (o.section === 'totales' && totalKey(o.str))));
    const endX = stops.length ? Math.min(...stops.map((o) => o.x)) : Infinity;

    const vals = all.filter((o) => o.page === page && o !== it && !o.isLabel && !o.isLabelPart && !o.isHeading &&
      o.x >= it.x2 - 1 && o.x < endX && o.x - it.x2 <= 160 && sameRow(o, L.cy) && !(o === it.nextOnLine && o.str === ':'))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    let value = [L.inline, ...vals.map((v) => v.str)].filter(Boolean).join(' ');

    // Valor debajo, alineado con la etiqueta (CUFE/CUDS, fechas de validación, vigencia partida)
    if (!value || /-$/.test(value)) {
      const below = all
        .filter((o) => o.page === page && Math.abs(o.x - it.x) <= 4 && it.y - o.y > 2 && it.y - o.y <= 18 &&
          !o.isLabel && !o.isLabelPart && !o.isHeading && !asLabel(o, o.nextOnLine) &&
          !labels.some((L2) => L2.it !== it && L2.it.page === page && L2.it.x < o.x && o.x - L2.it.x2 <= 160 && sameRow(o, L2.cy)))
        .sort((a, b) => b.y - a.y)[0];
      if (below) value = value ? `${value}${below.str}` : below.str;
    }

    // Valor que continúa debajo, alineado con la etiqueta ("20 - Nota Crédito que referencia una" / "factura electrónica")
    else if (value && vals.length) {
      const cont = all
        .filter((o) => o.page === page && Math.abs(o.x - it.x) <= 4 && it.y - o.y > 6 && it.y - o.y <= 13 &&
          !o.isLabel && !o.isLabelPart && !o.isHeading && !asLabel(o, o.nextOnLine) && !/^\d/.test(o.str))
        .sort((a, b) => b.y - a.y)[0];
      if (cont) value = `${value} ${cont.str}`;
    }

    value = value.trim().replace(/^'(.*)'$/, '$1').replace(/^[\/|]\s*/, '');
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
  if (/^cantidad|^consumo facturado/.test(n)) return 'cantidad';
  if (/^precio de consumo/.test(n)) return 'precio_unitario';
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

// Lee una tabla anclada en una columna numérica (Nro. / Items).
//   headerRe: texto del encabezado ancla; keyFn: nombre de columna → clave.
// Devuelve [{ nro, get(clave) }] con el texto de cada celda (une renglones partidos).
function extractTable(items, { headerRe, keyFn, wordWrap = false, labelsStop = false, pickHeader = () => true }) {
  const out = [];
  const headers = items.filter((it) => headerRe.test(it.str) && pickHeader(it));
  for (const nroHdr of headers) {
    const page = nroHdr.page;
    const hy = nroHdr.y;
    const pageItems = items.filter((it) => it.page === page);

    // Encabezados: fragmentos cercanos a la línea del ancla (pueden ocupar 2-3 líneas)
    const firstRowY = Math.max(-Infinity, ...pageItems.filter((it) => it.y < hy - 2 && it.y > hy - 40 && /^\d+$/.test(it.str) && Math.abs(it.x - nroHdr.x) < 15).map((it) => it.y));
    const HDR_CONT = /^(item|items|detalle|venta|por|compra|transmision|unitario|unitario de|de|total)$/;
    const hdrItems = pageItems.filter((it) => it.y <= hy + 24 && it.x >= nroHdr.x - 5 &&
      !/^(impuestos|devengados)$/.test(norm(it.str)) && !sectionOf(it.str) && it.y > firstRowY + 2 &&
      (it.y >= hy - 6 || (it.y >= hy - 20 && HDR_CONT.test(norm(it.str)))) &&
      !(it.y > hy + 4 && /^\d/.test(it.str)));
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
      c.name = c.parts.sort((a, b) => b.y - a.y).map((q) => q.str).join(' ');
      c.key = keyFn(c.name, keys);
      c.cx = (c.x + c.x2) / 2;
      keys.push(c.key);
    });
    const hdrBottom = Math.min(...hdrItems.map((h) => h.y));

    // Límite inferior: siguiente título, pie de página o (en nómina) la siguiente etiqueta
    const stopper = pageItems
      .filter((it) => it.y < hdrBottom && (sectionOf(it.str) || /^hoja \d+ de \d+$/i.test(it.str) ||
        /^representacion grafica$/.test(norm(it.str)) || (labelsStop && asLabel(it, null))))
      .sort((a, b) => b.y - a.y)[0];
    const bottom = stopper ? stopper.y + 4 : -Infinity;
    const region = pageItems.filter((it) => it.y < hdrBottom - 1 && it.y > bottom && it.str !== '$');

    const colOf = (it) => cols.reduce((best, c) => (Math.abs(c.cx - it.cx) < Math.abs(best.cx - it.cx) ? c : best), cols[0]);
    const nroCol = cols.find((c) => c.key === 'nro');
    const anchors = region.filter((it) => colOf(it) === nroCol && /^\d+$/.test(it.str)).sort((a, b) => b.y - a.y);
    if (!anchors.length) continue;

    // ¿El texto de cada fila está centrado verticalmente respecto al número (facturas, documento soporte)
    // o empieza en el renglón del número y sigue hacia abajo (documentos equivalentes: POS, SPD)?
    const textCol = cols.find((c) => c.key === 'descripcion') || cols.find((c) => c.key === 'concepto');
    let topAligned = false;
    if (textCol) {
      const inText = (it) => colOf(it) === textCol && !anchors.includes(it);
      const aboveFirst = region.some((it) => inText(it) && it.y > anchors[0].y + 2);
      const evenCentered = anchors.some((a) => !region.some((it) => inText(it) && Math.abs(it.y - a.y) <= 2) &&
        region.some((it) => inText(it) && Math.abs(it.y - a.y) <= 12));
      topAligned = !aboveFirst && !evenCentered;
    }

    const rows = anchors.map((a) => ({ anchor: a, cells: {} }));
    for (const it of region) {
      if (anchors.includes(it)) continue;
      const row = topAligned
        // fila cuyo número está en el mismo renglón o es el más cercano por encima
        ? rows.filter((r) => r.anchor.y >= it.y - 2).reduce((best, r) => (!best || r.anchor.y < best.anchor.y ? r : best), null) || rows[0]
        : rows.reduce((best, r) => (Math.abs(r.anchor.y - it.y) < Math.abs(best.anchor.y - it.y) ? r : best), rows[0]);
      const col = colOf(it);
      (row.cells[col.key] = row.cells[col.key] || []).push(it);
    }

    const textWidthMax = {};
    rows.forEach((r) => Object.entries(r.cells).forEach(([k, arr]) => arr.forEach((it) => {
      textWidthMax[k] = Math.max(textWidthMax[k] || 0, it.w);
    })));

    const joinCell = (key, arr) => {
      if (!arr || !arr.length) return '';
      const sorted = [...arr].sort((a, b) => b.y - a.y || a.x - b.x);
      let txt = '';
      let prev = null;
      for (const it of sorted) {
        if (!prev) txt = it.str;
        else if (Math.abs(prev.y - it.y) <= Y_TOL) txt += ' ' + it.str;
        else {
          // Salto de línea: si la línea anterior llenaba la columna, la palabra se partió → sin espacio
          const full = !wordWrap && prev.w >= 0.9 * (textWidthMax[key] || prev.w) && sorted.length > 1 &&
            /[A-Za-zÁÉÍÓÚÑ0-9]$/.test(txt) && /^[A-Za-zÁÉÍÓÚÑ0-9]/.test(it.str);
          txt += (full ? '' : ' ') + it.str;
        }
        prev = it;
      }
      return txt.trim();
    };

    for (const r of rows) out.push({ nro: Number(r.anchor.str), page, header: nroHdr, get: (k) => joinCell(k, r.cells[k]) });
  }
  return out;
}

function extractProducts(items, wordWrap = false) {
  const rows = extractTable(items, { headerRe: /^nro\.?$/i, keyFn: columnKey, wordWrap });
  const products = rows.map(({ nro, get }) => ({
    nro,
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
  }));
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
  return out.join(' ').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------
// API principal
// ---------------------------------------------------------------------
// Título: renglones superiores de la página 1 hasta el primer título de sección o etiqueta,
// sin "Representación Gráfica" ni "Pag:1".
function extractTitle(lines) {
  const parts = [];
  for (const l of lines.filter((x) => x.page === 1)) {
    const t = l.items.map((i) => i.str).join(' ').trim();
    const n = norm(t);
    if (/^representacion grafica$|^pag:?\s*\d+$/.test(n)) continue;
    if (l.items.some((i) => sectionOf(i.str) || asLabel(i, null)) || parts.length >= 5) break;
    parts.push(t);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function parseInvoiceItems(items) {
  const lines = buildLines(items);
  const fields = extractFields(lines);
  const totals = extractTotals(lines);
  const title = extractTitle(lines);
  // El documento soporte corta las descripciones entre palabras; la factura, en cualquier carácter.
  const charBreak = /factura electr[oó]nica de venta|nota (cr[eé]dito|d[eé]bito) de la factura|talonario/i.test(title) && !/soporte|equivalente/i.test(title);
  const products = extractProducts(items, !charBreak);

  const header = {
    tipo_documento: title,
    numero: pick(fields, 'doc', /^numero del? /, /^numero$/, /^no\. /),
    cufe: pick(fields, null, /cufe|cude|cune|cuds|codigo unico/),
    fecha_emision: pick(fields, 'doc', 'fecha de emision', 'fecha de generacion', 'fecha de expedicion', /^fecha y hora de (expedicion|emision|generacion)/),
    fecha_vencimiento: pick(fields, 'doc', 'fecha de vencimiento'),
    forma_pago: pick(fields, 'doc', 'forma de pago'),
    medio_pago: pick(fields, 'doc', 'medio de pago'),
    tipo_operacion: pick(fields, 'doc', 'tipo de operacion'),
    orden_pedido: pick(fields, 'doc', 'orden de pedido', 'orden de compra'),
    emisor_nit: pick(fields, 'emisor', /^nit/, /^numero (de |del )?documento/),
    emisor_tipo_documento: pick(fields, 'emisor', 'tipo de documento'),
    emisor_razon_social: pick(fields, 'emisor', /^razon social/, /^nombre o razon social/, /^nombre( y apellidos?)?$/),
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
    adq_nombre: pick(fields, 'adq', /^nombre o razon social/, /^razon social/, /^nombre( y apellidos?)?$/),
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

// ---------------------------------------------------------------------
// Nómina electrónica (documento individual y nota de ajuste)
// ---------------------------------------------------------------------
function payrollKey(name, prevKeys) {
  const n = norm(name);
  if (/^items?$/.test(n)) return 'nro';
  if (/^concepto/.test(n)) return 'concepto';
  if (/^descripcion/.test(n)) return 'descripcion';
  if (/^tipo/.test(n)) return 'tipo';
  if (/^valor/.test(n)) return 'valor';
  return 'col_' + prevKeys.length;
}

function parsePayrollItems(items, lines, fields, title) {
  const rows = extractTable(items, { headerRe: /^items$/i, keyFn: payrollKey, wordWrap: true, labelsStop: true });
  const devengados = [];
  const deducciones = [];
  for (const r of rows) {
    // ¿La tabla está bajo el título "Deducciones"?
    const isDed = items.some((it) => it.page === r.page && sectionOf(it.str) === 'deducciones' &&
      it.y > r.header.y && it.y - r.header.y < 30);
    const line = { nro: r.nro, concepto: r.get('concepto'), descripcion: r.get('descripcion'), tipo: r.get('tipo'), valor: parseNumber(r.get('valor')) };
    (isDed ? deducciones : devengados).push(line);
  }

  const n = (v) => parseNumber(v);
  const header = {
    tipo_documento: title,
    numero: pick(fields, 'doc', 'numero de nomina', /^numero/),
    cufe: pick(fields, null, /cune|cufe|codigo unico/),
    fecha_emision: pick(fields, 'doc', 'fecha de generacion', 'fecha de emision'),
    empleador_razon_social: pick(fields, 'empleador', 'razon social', 'nombre completo'),
    empleador_nit: pick(fields, 'empleador', /^nit/),
    empleador_direccion: pick(fields, 'empleador', 'direccion'),
    empleador_municipio: pick(fields, 'empleador', /^municipio|^ciudad/),
    empleado_tipo_documento: pick(fields, 'empleado', 'tipo de documento'),
    empleado_documento: pick(fields, 'empleado', 'no de documento', /^numero de documento/, /^no\.? documento/),
    empleado_nombre: pick(fields, 'empleado', 'nombre', 'nombre completo'),
    cod_trabajador: pick(fields, 'empleado', 'cod trabajador'),
    fecha_ingreso: pick(fields, 'empleado', 'fecha de ingreso'),
    fecha_retiro: pick(fields, 'empleado', 'fecha de retiro'),
    antiguedad: pick(fields, 'empleado', 'antiguedad'),
    tipo_contrato: pick(fields, 'empleado', 'tipo de contrato'),
    periodo_liquidacion: pick(fields, 'empleado', 'periodo de liquidacion'),
    periodo_nomina: pick(fields, null, 'periodo de nomina'),
    tiempo_laborado: pick(fields, 'empleado', 'tiempo laborado'),
    fecha_pago: pick(fields, null, 'fecha de pago'),
    sueldo: n(pick(fields, 'empleado', 'sueldo')),
    salario_integral: pick(fields, 'empleado', 'salario integral'),
    total_devengados: n(pick(fields, null, 'total devengados')),
    total_deducciones: n(pick(fields, null, 'total deducciones')),
    comprobante_total: n(pick(fields, null, 'comprobante total')),
    forma_pago: pick(fields, null, 'forma de pago'),
    metodo_pago: pick(fields, null, 'metodo de pago'),
    banco: pick(fields, null, 'banco'),
    tipo_cuenta: pick(fields, null, 'tipo de cta'),
    numero_cuenta: pick(fields, null, 'no de cta'),
    moneda: pick(fields, null, 'tipo moneda', 'moneda'),
    fecha_validacion_dian: pick(fields, null, 'documento validado por la dian'),
    fecha_generacion: pick(fields, null, 'documento generado', 'documento generado el')
  };
  // Campos comunes (listado de descargas y nombre del archivo): emisor = empleador, receptor = empleado
  header.emisor_nit = header.empleador_nit;
  header.emisor_razon_social = header.empleador_razon_social;
  header.adq_numero_documento = header.empleado_documento;
  header.adq_nombre = header.empleado_nombre;
  header.total_factura = header.comprobante_total;

  const obs = [];
  if (!header.cufe) obs.push('No se encontró el CUNE en el PDF');
  if (!header.numero) obs.push('No se encontró el número de nómina');
  const sum = (arr) => arr.reduce((t, x) => t + (x.valor || 0), 0);
  if (header.total_devengados !== null && devengados.length && Math.abs(sum(devengados) - header.total_devengados) > 1) {
    obs.push(`Suma de devengados (${sum(devengados)}) ≠ total devengados (${header.total_devengados})`);
  }
  if (header.total_deducciones !== null && deducciones.length && Math.abs(sum(deducciones) - header.total_deducciones) > 1) {
    obs.push(`Suma de deducciones (${sum(deducciones)}) ≠ total deducciones (${header.total_deducciones})`);
  }
  header.observaciones = obs.join('; ');
  return { kind: 'nomina', header, products: [], payroll: { devengados, deducciones }, fields };
}

// Elige el lector según el tipo de documento
export function parseDocumentItems(items) {
  const lines = buildLines(items);
  const title = extractTitle(lines);
  if (/n[oó]mina/i.test(title)) {
    const fields = extractFields(lines);
    return parsePayrollItems(items, lines, fields, title);
  }
  const r = parseInvoiceItems(items);
  return { kind: 'factura', ...r };
}

// ---------------------------------------------------------------------
// Nombre de archivo: TIPO_AAAAMMDD_NUMERO_RCPTR_NIT_NOMBRE_EMSR_NIT_NOMBRE.pdf
// ---------------------------------------------------------------------
export function docTypeCode(title) {
  const t = norm(title);
  if (/nomina/.test(t)) return /ajuste/.test(t) ? 'NANE' : 'NIE';
  if (/nota de ajuste/.test(t) && /soporte/.test(t)) return 'NADS';
  if (/nota de ajuste/.test(t) && /equivalente/.test(t)) return 'NADE';
  if (/documento soporte/.test(t)) return 'DS';
  if (/nota credito/.test(t)) return 'NC';
  if (/nota debito/.test(t)) return 'ND';
  if (/talonario|papel/.test(t)) return 'FTP';
  if (/exportacion/.test(t)) return 'FEXP';
  if (/contingencia/.test(t)) return 'FCON';
  if (/documento equivalente|pos\b/.test(t)) return 'DE';
  if (/factura/.test(t)) return 'FEV';
  return 'DOC';
}

function toYmd(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

function cleanPart(v, max = 40) {
  return norm(v).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/, '');
}

// Emisor y receptor legales: en el documento soporte (y su nota de ajuste) emite el adquiriente.
export function buildDocFileName(result) {
  const h = (result && result.header) || {};
  const code = docTypeCode(h.tipo_documento || '');
  const date = toYmd(h.fecha_emision || h.fecha_generacion);
  const num = cleanPart(h.numero, 30);
  if (!date || !num || code === 'DOC') return null;
  const vendedor = { nit: h.emisor_nit, name: h.emisor_razon_social };
  const comprador = { nit: h.adq_numero_documento, name: h.adq_nombre };
  const [emsr, rcptr] = (code === 'DS' || code === 'NADS') ? [comprador, vendedor] : [vendedor, comprador];
  const nit = (x) => cleanPart(String(x.nit || '').replace(/[^0-9A-Za-z]/g, ''), 20) || 'SIN_DATO';
  const name = (x) => cleanPart(x.name) || 'SIN_NOMBRE';
  return `${code}_${date}_${num}_RCPTR_${nit(rcptr)}_${name(rcptr)}_EMSR_${nit(emsr)}_${name(emsr)}.pdf`;
}

export async function parseInvoicePdf(pdfjsLib, bytes, password, worker) {
  const items = await extractItems(pdfjsLib, bytes, password, worker);
  if (!items.length) {
    return { kind: 'factura', header: { observaciones: 'El PDF no contiene texto extraíble (¿imagen escaneada?)' }, products: [], fields: {} };
  }
  return parseDocumentItems(items);
}
