// Arma el libro de Excel a partir de los registros acumulados durante la descarga.
// registro = { cufe, archivo, estado: 'OK'|'ERROR', error, header, products }
import { buildXlsx } from './xlsx-writer.mjs';

const FACTURAS_COLS = [
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

const DESCARGAS_COLS = [
  ['N.º', 'n', 'int', 6],
  ['Estado', 'estado', 'text', 15],
  ['Motivo / observaciones', 'motivo', 'text', 50],
  ['Tipo documento', 'tipo_documento', 'text', 34],
  ['Número', 'numero', 'text', 14],
  ['Fecha', 'fecha_emision', 'date', 12],
  ['Emisor NIT / doc.', 'emisor_nit', 'text', 14],
  ['Emisor', 'emisor_nombre', 'text', 30],
  ['Receptor NIT / doc.', 'receptor_nit', 'text', 14],
  ['Receptor', 'receptor_nombre', 'text', 30],
  ['Total', 'total', 'money', 15],
  ['Intentos', 'intentos', 'int', 8],
  ['Archivo PDF', 'archivo', 'text', 45],
  ['CUFE / CUDS / CUNE', 'cufe', 'text', 30]
];

const NOMINA_COLS = [
  ['Observaciones', 'observaciones', 'text', 30],
  ['Tipo documento', 'tipo_documento', 'text', 30],
  ['Número', 'numero', 'text', 10],
  ['Fecha generación', 'fecha_emision', 'date', 12],
  ['Empleador NIT', 'empleador_nit', 'text', 13],
  ['Empleador', 'empleador_razon_social', 'text', 25],
  ['Empleado tipo doc.', 'empleado_tipo_documento', 'text', 9],
  ['Empleado documento', 'empleado_documento', 'text', 14],
  ['Empleado', 'empleado_nombre', 'text', 30],
  ['Cód. trabajador', 'cod_trabajador', 'text', 10],
  ['Fecha ingreso', 'fecha_ingreso', 'date', 12],
  ['Fecha retiro', 'fecha_retiro', 'date', 12],
  ['Antigüedad', 'antiguedad', 'text', 11],
  ['Tipo contrato', 'tipo_contrato', 'text', 8],
  ['Periodo liquidación', 'periodo_liquidacion', 'text', 24],
  ['Periodo nómina', 'periodo_nomina', 'text', 8],
  ['Tiempo laborado', 'tiempo_laborado', 'text', 9],
  ['Fecha pago', 'fecha_pago', 'date', 12],
  ['Sueldo', 'sueldo', 'money', 14],
  ['Salario integral', 'salario_integral', 'text', 8],
  ['Total devengados', 'total_devengados', 'money', 15],
  ['Total deducciones', 'total_deducciones', 'money', 15],
  ['Neto pagado (comprobante total)', 'comprobante_total', 'money', 16],
  ['Forma de pago', 'forma_pago', 'text', 8],
  ['Método de pago', 'metodo_pago', 'text', 8],
  ['Banco', 'banco', 'text', 15],
  ['Tipo cuenta', 'tipo_cuenta', 'text', 10],
  ['N.º cuenta', 'numero_cuenta', 'text', 14],
  ['Moneda', 'moneda', 'text', 7],
  ['Fecha validación DIAN', 'fecha_validacion_dian', 'datetime', 19],
  ['CUNE', 'cufe', 'text', 30],
  ['Archivo PDF', 'archivo', 'text', 40]
];

const DETALLE_NOMINA_COLS = [
  ['Número', 'numero', 'text', 10],
  ['Fecha generación', 'fecha_emision', 'date', 12],
  ['Empleado documento', 'empleado_documento', 'text', 14],
  ['Empleado', 'empleado_nombre', 'text', 30],
  ['Clase', 'clase', 'text', 12],
  ['Ítem', 'nro', 'int', 6],
  ['Concepto', 'concepto', 'text', 22],
  ['Descripción', 'descripcion', 'text', 40],
  ['Tipo', 'tipo', 'text', 9],
  ['Valor', 'valor', 'money', 15],
  ['CUNE', 'cufe', 'text', 30]
];

// records: resultado por CUFE procesado; queue: lista completa de CUFEs (para marcar los pendientes)
export function buildReport(records, queue = []) {
  const byCufe = new Map();
  for (const r of records) byCufe.set(String(r.cufe || '').toLowerCase(), r); // el último intento manda

  const order = queue.length ? queue : records.map((r) => r.cufe);
  const descargas = [];
  const facturas = [];
  const detalle = [];
  const nomina = [];
  const detNomina = [];

  order.forEach((cufe, i) => {
    const rec = byCufe.get(String(cufe).toLowerCase());
    const h = (rec && rec.header) || {};
    const obs = [rec?.error, h.observaciones];
    if (rec && rec.cufe && h.cufe && rec.cufe.toLowerCase() !== h.cufe.toLowerCase()) {
      obs.push('El CUFE del PDF no coincide con el solicitado'); // control: PDF equivocado
    }
    const ok = rec && rec.estado === 'OK';
    // Emisor/receptor legales (en documento soporte emite el comprador; en nómina, el empleador)
    const ds = /soporte/i.test(h.tipo_documento || '');
    descargas.push({
      n: i + 1,
      estado: !rec ? 'Pendiente' : ok ? 'Descargado' : 'No descargado',
      motivo: obs.filter(Boolean).join('; ') || (!rec ? 'No se alcanzó a procesar' : ''),
      tipo_documento: h.tipo_documento,
      numero: h.numero,
      fecha_emision: h.fecha_emision,
      emisor_nit: ds ? h.adq_numero_documento : h.emisor_nit,
      emisor_nombre: ds ? h.adq_nombre : h.emisor_razon_social,
      receptor_nit: ds ? h.emisor_nit : h.adq_numero_documento,
      receptor_nombre: ds ? h.emisor_razon_social : h.adq_nombre,
      total: h.total_factura,
      intentos: rec?.intentos || (rec ? 1 : null),
      archivo: rec?.archivo || '',
      cufe
    });
    if (!ok) return;

    if (rec.kind === 'nomina') {
      nomina.push({ ...h, observaciones: obs.filter(Boolean).join('; '), cufe: h.cufe || cufe, archivo: rec.archivo });
      const base = { numero: h.numero, fecha_emision: h.fecha_emision, empleado_documento: h.empleado_documento, empleado_nombre: h.empleado_nombre, cufe: h.cufe || cufe };
      // Solo conceptos con valor (la representación gráfica lista todos, incluso los que van en $0)
      for (const d of rec.payroll?.devengados || []) if (d.valor) detNomina.push({ ...base, clase: 'Devengado', ...d });
      for (const d of rec.payroll?.deducciones || []) if (d.valor) detNomina.push({ ...base, clase: 'Deducción', ...d });
      return;
    }

    facturas.push({ ...h, estado: rec.estado, observaciones: obs.filter(Boolean).join('; '), cufe: h.cufe || cufe, archivo: rec.archivo || '' });
    for (const p of rec.products || []) {
      detalle.push({
        numero: h.numero, fecha_emision: h.fecha_emision, emisor_nit: h.emisor_nit,
        emisor_razon_social: h.emisor_razon_social, adq_numero_documento: h.adq_numero_documento,
        adq_nombre: h.adq_nombre, cufe: h.cufe || cufe, ...p
      });
    }
  });

  const sheets = [
    { name: 'Descargas', columns: toCols(DESCARGAS_COLS), rows: descargas },
    { name: 'Documentos', columns: toCols(FACTURAS_COLS), rows: facturas },
    { name: 'Detalle', columns: toCols(DETALLE_COLS), rows: detalle }
  ];
  if (nomina.length) {
    sheets.push({ name: 'Nómina', columns: toCols(NOMINA_COLS), rows: nomina });
    sheets.push({ name: 'Detalle nómina', columns: toCols(DETALLE_NOMINA_COLS), rows: detNomina });
  }
  return buildXlsx(sheets);
}
