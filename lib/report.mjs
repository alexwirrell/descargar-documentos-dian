// Arma el libro de Excel a partir de los registros acumulados durante la descarga.
// registro = { cufe, archivo, estado: 'OK'|'ERROR', error, header, products }
import { buildXlsx } from './xlsx-writer.mjs';

const FACTURAS_COLS = [
  ['Estado', 'estado', 'text', 9],
  ['Observaciones', 'observaciones', 'text', 40],
  ['Tipo documento', 'tipo_documento', 'text', 30],
  ['Número', 'numero', 'text', 14],
  ['Fecha emisión', 'fecha_emision', 'date', 13],
  ['Fecha vencimiento', 'fecha_vencimiento', 'date', 13],
  ['Forma de pago', 'forma_pago', 'text', 12],
  ['Medio de pago', 'medio_pago', 'text', 22],
  ['Tipo operación', 'tipo_operacion', 'text', 16],
  ['Orden de pedido', 'orden_pedido', 'text', 14],
  ['Vendedor tipo doc.', 'emisor_tipo_documento', 'text', 10],
  ['Vendedor NIT / doc.', 'emisor_nit', 'text', 14],
  ['Vendedor razón social', 'emisor_razon_social', 'text', 30],
  ['Vendedor nombre comercial', 'emisor_nombre_comercial', 'text', 25],
  ['Vendedor tipo contribuyente', 'emisor_tipo_contribuyente', 'text', 18],
  ['Vendedor régimen', 'emisor_regimen', 'text', 12],
  ['Vendedor responsabilidad', 'emisor_responsabilidad', 'text', 18],
  ['Vendedor actividad', 'emisor_actividad', 'text', 10],
  ['Vendedor departamento', 'emisor_departamento', 'text', 15],
  ['Vendedor municipio', 'emisor_municipio', 'text', 15],
  ['Vendedor dirección', 'emisor_direccion', 'text', 30],
  ['Vendedor teléfono', 'emisor_telefono', 'text', 13],
  ['Vendedor correo', 'emisor_correo', 'text', 28],
  ['Comprador tipo doc.', 'adq_tipo_documento', 'text', 10],
  ['Comprador número doc.', 'adq_numero_documento', 'text', 14],
  ['Comprador nombre', 'adq_nombre', 'text', 30],
  ['Comprador tipo contribuyente', 'adq_tipo_contribuyente', 'text', 18],
  ['Comprador régimen', 'adq_regimen', 'text', 12],
  ['Comprador responsabilidad', 'adq_responsabilidad', 'text', 18],
  ['Comprador departamento', 'adq_departamento', 'text', 15],
  ['Comprador municipio', 'adq_municipio', 'text', 15],
  ['Comprador dirección', 'adq_direccion', 'text', 30],
  ['Comprador teléfono', 'adq_telefono', 'text', 13],
  ['Comprador correo', 'adq_correo', 'text', 28],
  ['Moneda', 'moneda', 'text', 8],
  ['Tasa de cambio', 'tasa_cambio', 'number', 12],
  ['Subtotal', 'subtotal', 'money', 15],
  ['Base gravable', 'base_gravable', 'money', 14],
  ['Descuento detalle', 'descuento_detalle', 'money', 14],
  ['Recargo detalle', 'recargo_detalle', 'money', 14],
  ['Total bruto', 'total_bruto', 'money', 15],
  ['IVA', 'iva', 'money', 14],
  ['INC', 'inc', 'money', 12],
  ['Bolsas', 'bolsas', 'money', 10],
  ['Otros impuestos', 'otros_impuestos', 'money', 13],
  ['Total impuesto', 'total_impuesto', 'money', 14],
  ['Total neto', 'total_neto', 'money', 15],
  ['Descuento global', 'descuento_global', 'money', 14],
  ['Recargo global', 'recargo_global', 'money', 14],
  ['Total factura', 'total_factura', 'money', 15],
  ['Anticipos', 'anticipos', 'money', 12],
  ['Rete fuente', 'rete_fuente', 'money', 12],
  ['Rete IVA', 'rete_iva', 'money', 12],
  ['Rete ICA', 'rete_ica', 'money', 12],
  ['N.º líneas', 'num_lineas', 'int', 8],
  ['Notas', 'notas', 'text', 40],
  ['Fecha generación', 'fecha_generacion', 'datetime', 19],
  ['Fecha validación DIAN', 'fecha_validacion_dian', 'datetime', 19],
  ['N.º autorización', 'autorizacion', 'text', 16],
  ['Rango desde', 'rango_desde', 'text', 10],
  ['Rango hasta', 'rango_hasta', 'text', 11],
  ['Vigencia', 'vigencia', 'date', 12],
  ['CUFE', 'cufe', 'text', 30],
  ['Archivo PDF', 'archivo', 'text', 30]
];

const DETALLE_COLS = [
  ['Número', 'numero', 'text', 14],
  ['Fecha emisión', 'fecha_emision', 'date', 13],
  ['Vendedor NIT / doc.', 'emisor_nit', 'text', 14],
  ['Vendedor', 'emisor_razon_social', 'text', 28],
  ['Comprador número doc.', 'adq_numero_documento', 'text', 14],
  ['Comprador', 'adq_nombre', 'text', 28],
  ['Nro.', 'nro', 'int', 6],
  ['Código', 'codigo', 'text', 14],
  ['Descripción', 'descripcion', 'text', 40],
  ['U/M', 'um', 'text', 7],
  ['Cantidad', 'cantidad', 'number', 10],
  ['Precio unitario', 'precio_unitario', 'money', 15],
  ['Descuento', 'descuento', 'money', 12],
  ['Recargo', 'recargo', 'money', 12],
  ['IVA', 'iva', 'money', 14],
  ['% IVA', 'pct_iva', 'number', 7],
  ['INC', 'inc', 'money', 12],
  ['% INC', 'pct_inc', 'number', 7],
  ['Valor total línea', 'valor_venta', 'money', 16],
  ['Forma de generación', 'forma_generacion', 'text', 18],
  ['Fecha de compra', 'fecha_compra', 'date', 13],
  ['CUFE', 'cufe', 'text', 30]
];

const toCols = (arr) => arr.map(([header, key, type, width]) => ({ header, key, type, width }));

export function buildReport(records) {
  const facturas = [];
  const detalle = [];
  for (const rec of records) {
    const h = rec.header || {};
    const obs = [rec.error, h.observaciones];
    if (rec.cufe && h.cufe && rec.cufe.toLowerCase() !== h.cufe.toLowerCase()) {
      obs.push('El CUFE del PDF no coincide con el solicitado'); // control: PDF equivocado
    }
    facturas.push({
      ...h,
      estado: rec.estado,
      observaciones: obs.filter(Boolean).join('; '),
      cufe: h.cufe || rec.cufe,
      archivo: rec.archivo || ''
    });
    for (const p of rec.products || []) {
      detalle.push({
        numero: h.numero, fecha_emision: h.fecha_emision, emisor_nit: h.emisor_nit,
        emisor_razon_social: h.emisor_razon_social, adq_numero_documento: h.adq_numero_documento,
        adq_nombre: h.adq_nombre, cufe: h.cufe || rec.cufe, ...p
      });
    }
  }
  return buildXlsx([
    { name: 'Facturas', columns: toCols(FACTURAS_COLS), rows: facturas },
    { name: 'Detalle', columns: toCols(DETALLE_COLS), rows: detalle }
  ]);
}
