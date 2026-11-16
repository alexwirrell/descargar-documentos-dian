# Descargar documentos DIAN

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Descargar%20documentos%20DIAN-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/descargar-documentos-dian/iokiadeklaegllnamjcloddejbjhffjm?hl=es)

Extensión para Google Chrome (Manifest V3), [disponible en Chrome Web Store](https://chromewebstore.google.com/detail/descargar-documentos-dian/iokiadeklaegllnamjcloddejbjhffjm?hl=es), que automatiza la consulta y descarga masiva de facturas electrónicas desde el portal público de la DIAN ([catalogo-vpfe.dian.gov.co](https://catalogo-vpfe.dian.gov.co/User/SearchDocument)) a partir de una lista de CUFEs.

Por cada documento, la extensión:

1. Busca el CUFE con el NIT del emisor o receptor.
2. Descarga la representación gráfica en PDF.
3. **Quita la contraseña** del PDF (la DIAN lo entrega protegido con el NIT).
4. Lo guarda en la **carpeta que usted elija**, con el CUFE como nombre de archivo.
5. **Lee el contenido del PDF** y, al terminar, genera un **Excel (.xlsx)** con los datos de todos los documentos.

Todo el procesamiento ocurre localmente en su navegador. Ver [Política de Privacidad](PRIVACY_POLICY.md).

---

## Características

- **Descarga masiva:** pegue cientos de CUFEs (uno por línea) y la extensión los procesa en orden. Los duplicados se eliminan automáticamente.
- **Carpeta de destino a elección:** se elige con el selector de carpetas del sistema (File System Access API), no solo dentro de *Descargas*.
- **PDF sin contraseña:** se descifran con [qpdf](https://github.com/qpdf/qpdf) compilado a WebAssembly, usando el NIT ingresado. Si el NIT se escribe con dígito de verificación (`900123456-7`), también se prueba sin él.
- **Varios tipos de documento:** reconoce las representaciones gráficas de:
  - Factura electrónica de venta (`FEV`)
  - Factura de venta de talonario o de papel (`FTP`)
  - Nota crédito (`NC`) y nota débito (`ND`)
  - Documento soporte en adquisiciones a no obligados a facturar (`DS`) y su nota de ajuste (`NADS`)
  - Nómina individual electrónica (`NIE`) y su nota de ajuste (`NANE`)
  - Documentos equivalentes electrónicos (`DE`): POS, servicios públicos (SPD), peajes, tiquete de transporte, entre otros, y su nota de ajuste (`NADE`)
- **PDF renombrados:** con la opción activa, cada PDF se guarda como
  `TIPO_AAAAMMDD_NÚMERO_RCPTR_NIT_NOMBRE_EMSR_NIT_NOMBRE.pdf`, por ejemplo
  `FEV_20251125_FE_14262_RCPTR_901183139_SANIMAX_DE_COLOMBIA_S_A_S_EMSR_900665391_BIO_CICLO_S_A_S.pdf`.
  Se usan el emisor y el receptor legales: en el documento soporte emite el comprador y en la nómina, el empleador. Si no se pudo leer el PDF, se usa el CUFE como nombre.
- **Resumen en Excel** con estas hojas:
  - **Descargas:** listado de **todos** los CUFEs de la lista con su estado (*Descargado*, *No descargado* o *Pendiente*), el motivo cuando falló, el tipo, número, fecha, emisor, receptor, total, intentos y nombre del archivo.
  - **Documentos:** una fila por factura, nota o documento soporte con fechas, forma y medio de pago, datos completos del **vendedor** y del **comprador**, subtotal, base gravable, descuentos, IVA, INC, total, retenciones, fecha de validación DIAN, autorización y numeración.
  - **Detalle:** una fila por producto o servicio con código, descripción, unidad, cantidad, precio unitario, descuento, IVA, INC, valor total de la línea y, en documentos soporte, forma de generación y fecha de compra.
  - **Nómina** y **Detalle nómina** (solo si hay nóminas): empleador, empleado, periodo, sueldo, total devengados, deducciones y neto pagado, más cada devengado y deducción con valor.
- **Controles de calidad:** la columna *Observaciones* avisa si la suma de las líneas no coincide con el subtotal (o, en la nómina, con el total devengado o deducido), si el CUFE del PDF no corresponde al solicitado, o si falta información.
- **Bloqueos del portal:** si el portal de la DIAN responde *“The request is blocked”*, *“Too many requests”* o una verificación anti-bot que no se resuelve, la extensión **no lo evade**. Se detiene, espera cada vez más (2, 5, 10, 15 y 30 minutos) y reintenta el **mismo** CUFE, así que ese documento no se pierde. Si el bloqueo persiste, el proceso queda en pausa y se puede **reanudar** después.
- **Reintentos:** los errores temporales (respuesta que no es PDF, error del servidor) se reintentan hasta 3 veces antes de marcar el CUFE como no descargado.
- **Reanudar:** si el proceso se detiene (por usted, por un bloqueo o porque se cerró la pestaña), el botón **Reanudar** continúa desde el CUFE pendiente sin perder lo ya descargado.
- **Pausa entre documentos** opcional, para consultar el portal con calma en listas largas.
- **Captcha:** la extensión espera a que el captcha de Cloudflare Turnstile se resuelva (automáticamente o por usted) antes de enviar cada consulta. No lo evade.

## Instalación

### Desde Chrome Web Store (recomendado)

1. Abra la página de la extensión en [Chrome Web Store](https://chromewebstore.google.com/detail/descargar-documentos-dian/iokiadeklaegllnamjcloddejbjhffjm?hl=es).
2. Pulse **Agregar a Chrome** y confirme con **Agregar extensión**.
3. Ancle la extensión en la barra de herramientas (icono de rompecabezas → chincheta) para tenerla a mano.

Instalada así, Chrome la actualiza automáticamente cuando se publica una nueva versión. También funciona en Microsoft Edge y Brave, que permiten instalar extensiones de Chrome Web Store.

### Desde el código fuente (modo desarrollador)

Para probar cambios o usar la versión más reciente del repositorio antes de que se publique en la tienda:

1. Descargue o clone este repositorio:
   ```bash
   git clone https://github.com/alexwirrell/descargar-documentos-dian.git
   ```
   O use **Code → Download ZIP** en [github.com/alexwirrell/descargar-documentos-dian](https://github.com/alexwirrell/descargar-documentos-dian) y descomprímalo.
2. Abra `chrome://extensions` en Chrome (o Edge / Brave).
3. Active el **Modo de desarrollador** (esquina superior derecha).
4. Pulse **Cargar descomprimida** y seleccione la carpeta del proyecto.
5. Ancle la extensión en la barra de herramientas para tenerla a mano.

Requiere Chrome 116 o superior.

## Uso

1. Abra el popup de la extensión.
2. Escriba el **NIT** del emisor o receptor (sin puntos ni comas). Este NIT es también la contraseña de los PDF.
3. Pulse **Seleccionar carpeta**: se abre una ventana pequeña donde elige la carpeta de destino.
   - Si Chrome ofrece **“Permitir en cada visita”**, elíjala para no tener que autorizar la carpeta cada vez que abra el navegador.
4. Pegue la lista de **CUFEs**, uno por línea.
5. Opcional: deje marcada **Renombrar PDF con los datos del documento** y, para listas largas, indique una **Pausa** en segundos entre documentos.
6. Pulse **Iniciar Descargas**. Se abre una pestaña de la DIAN donde la extensión trabaja; resuelva el captcha si se lo pide.
7. Al terminar, encontrará en la carpeta elegida:
   - Un PDF por documento, sin contraseña y con nombre descriptivo (o con el CUFE como nombre si desactivó la opción).
   - `Resumen_DIAN_AAAA-MM-DD_HHMMSS.xlsx` con el listado de descargas y los datos de todos los documentos.

   El log termina con un resumen y una línea `NO DESCARGADO: <CUFE> — <motivo>` por cada documento que no se pudo descargar.

Otros controles:

- **Detener:** interrumpe el proceso y genera el Excel con lo procesado hasta ese momento.
- **Reanudar:** continúa desde el CUFE donde quedó el proceso.
- **Generar Excel de la última descarga:** vuelve a crear el Excel de la última corrida.
- **Copiar:** copia todo el log al portapapeles (útil para reportar un problema).
- **Limpiar:** borra la consola de logs.

Debajo de los botones se ve el progreso: documentos procesados, descargados y con error, y la hora del próximo reintento si el portal bloqueó la consulta.

Si se pierde el permiso sobre la carpeta durante el proceso, los archivos no se pierden: se guardan en `Descargas/Facturas_DIAN/` y el log lo indica.

## Estructura del proyecto

```
├── manifest.json          Configuración de la extensión (MV3)
├── background.js          Service worker: cola de CUFEs, navegación, logs, guardado y reporte
├── content.js             Se ejecuta en el portal DIAN: llena el formulario, espera el captcha y descarga el PDF
├── popup.html / popup.js  Interfaz principal
├── folder.html / folder.js  Ventana para elegir y autorizar la carpeta de destino
├── offscreen.html / offscreen.js  Documento oculto: descifra el PDF, lee su contenido y escribe los archivos
├── icons/                 Iconos de la extensión (16 y 48 px)
└── lib/
    ├── idb.js             Guarda el acceso a la carpeta en IndexedDB
    ├── qpdf.js, qpdf.wasm qpdf compilado a WebAssembly (descifrado de PDF)
    ├── pdfjs/             pdf.js de Mozilla (extracción de texto)
    ├── invoice-parser.mjs Lector de la representación gráfica DIAN
    ├── report.mjs         Columnas y hojas del Excel
    └── xlsx-writer.mjs    Generador de .xlsx sin dependencias
```

## Cómo funciona

### Flujo de descarga

1. `popup.js` guarda el NIT y la cola de CUFEs en `chrome.storage.local` y avisa al service worker.
2. `background.js` abre una pestaña dedicada en la página de búsqueda de la DIAN. El content script solo actúa en esa pestaña.
3. `content.js` reconoce cada página por su **contenido** (no por la URL, porque la búsqueda se envía por POST a la misma dirección):
   - **Página de búsqueda:** llena CUFE y NIT, espera el token del captcha y envía la consulta.
   - **Página del documento:** toma el formulario del botón *Descargar PDF* (según el tipo de documento va a `/Document/DownloadPDF`, `/Document/PrintSupportDocument`, etc.), lo envía con sus campos y el token del captcha, y pasa el PDF al service worker.
   - **Bloqueo o verificación anti-bot:** avisa al service worker, que espera y reintenta el mismo CUFE.
4. El service worker pasa el PDF al **documento offscreen**, que lo descifra (solo si está cifrado), lo lee, le pone nombre y lo guarda. Cuando recibe la confirmación, continúa con el siguiente CUFE.

### Lectura de los PDF

La DIAN genera las representaciones gráficas con una plantilla estándar (“Solución Gratuita DIAN”) cuyo texto es extraíble, sin necesidad de OCR. El lector (`lib/invoice-parser.mjs`) usa pdf.js para obtener cada fragmento de texto con su posición (x, y) y luego:

- Lee los pares **“Etiqueta: valor”** por sección (Datos del documento, Emisor/Vendedor, Adquiriente). Busca el valor en una franja alrededor de la etiqueta, por lo que admite etiquetas y valores partidos en varios renglones. Usa las etiquetas y no coordenadas fijas, así que tolera nombres y direcciones de cualquier longitud.
- Reconoce los nombres de los totales en ambas plantillas (p. ej. *Total factura* / *Total documento*, *Rete fuente* / *Rte fuente*) y los toma de la columna de moneda local (COP).
- Reconstruye las **tablas** (productos de facturas y notas; devengados y deducciones de la nómina): las columnas salen de los encabezados y las filas se anclan en la columna *Nro.* o *Items*. Une los textos que ocupan varios renglones y no mezcla la tabla de *Referencias*.
- Convierte los números en formato colombiano (`1.234.567,89`) y estadounidense (`$1,697,250`, usado en la nómina) a valores numéricos. En el Excel, fechas y montos quedan como fechas y números reales.

## Limitaciones conocidas

- **Captcha:** si Cloudflare pide interacción, hay que resolverlo manualmente en la pestaña de trabajo.
- **Eventos (Application Response):** los acuses de recibo, aceptaciones y demás eventos sobre una factura no tienen representación gráfica y la consulta pública de la DIAN no los muestra. Aparecen como *No descargado* en la hoja *Descargas* con ese motivo.
- **Descripciones largas (facturas):** en la factura, la DIAN corta las descripciones carácter por carácter. Cuando una línea llena todo el ancho de la columna no se puede saber si el corte coincidió con un espacio; se asume que no (lo más frecuente), por lo que en casos aislados dos palabras pueden quedar unidas.
- **Otros formatos:** el lector está pensado para las representaciones gráficas estándar de la DIAN (ver la lista de tipos arriba). PDF con plantillas propias de un proveedor tecnológico pueden quedar con campos vacíos, y en ese caso la columna *Observaciones* lo señala.
- **Permiso de carpeta:** Chrome puede pedir reautorizar la carpeta tras reiniciar el navegador, salvo que se haya elegido “Permitir en cada visita”.
- Si la DIAN cambia la estructura de su portal, puede ser necesario actualizar los selectores de `content.js`.

## Permisos que solicita

| Permiso | Para qué se usa |
|---|---|
| `storage`, `unlimitedStorage` | Guardar la cola de CUFEs, los logs y los datos para el Excel en el propio navegador |
| `tabs` | Abrir y controlar la pestaña de trabajo en el portal de la DIAN |
| `downloads` | Guardado de respaldo en *Descargas* si no hay permiso sobre la carpeta elegida |
| `offscreen` | Documento oculto que descifra los PDF, los lee y escribe los archivos |
| `alarms` | Esperar varios minutos antes de reintentar cuando el portal bloquea, y las pausas largas entre documentos |
| `https://catalogo-vpfe.dian.gov.co/*` | Único sitio en el que actúa la extensión |

La política de seguridad incluye `wasm-unsafe-eval`, necesario para ejecutar qpdf en WebAssembly. No se carga código remoto.

## Privacidad

La extensión no envía datos a ningún servidor distinto del portal oficial de la DIAN. Ver [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## Componentes de terceros

| Componente | Uso | Licencia |
|---|---|---|
| [qpdf](https://github.com/qpdf/qpdf) (vía [qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm)) | Quitar la contraseña de los PDF | Apache 2.0 (`lib/QPDF_LICENSE.txt`) |
| [pdf.js](https://github.com/mozilla/pdf.js) 4.10 | Extracción de texto de los PDF | Apache 2.0 (`lib/pdfjs/LICENSE`) |

## Aviso

Este proyecto no está afiliado, respaldado ni patrocinado por la DIAN (Dirección de Impuestos y Aduanas Nacionales de Colombia). Úselo de acuerdo con los términos de uso del portal y solo para consultar documentos que tenga derecho a ver.
