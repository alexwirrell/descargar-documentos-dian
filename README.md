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
- **Facturas electrónicas y documentos soporte:** reconoce la representación gráfica de la **factura electrónica de venta** y la del **documento soporte en adquisiciones efectuadas a no obligados a facturar** (CUDS).
- **Resumen en Excel** con dos hojas:
  - **Facturas:** una fila por CUFE/CUDS con estado, tipo de documento, número, fechas, forma y medio de pago, datos completos del **vendedor** y del **comprador**, subtotal, base gravable, descuentos, IVA, INC, total, retenciones, fecha de validación DIAN, autorización y numeración.
  - **Detalle:** una fila por producto o servicio con código, descripción, unidad, cantidad, precio unitario, descuento, IVA, INC, valor total de la línea y, en documentos soporte, forma de generación y fecha de compra.
  - Se usan los términos *vendedor* y *comprador* porque sirven para ambos documentos: en la factura el vendedor es quien la emite; en el documento soporte la emite el comprador.
- **Controles de calidad:** la columna *Observaciones* avisa si la suma de las líneas no coincide con el subtotal, si el CUFE del PDF no corresponde al solicitado, o si falta información.
- **Robusta ante errores:** reintenta búsquedas fallidas (máximo 3 veces), continúa con el siguiente CUFE si uno falla, y registra todo en una consola de logs dentro del popup.
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
5. Pulse **Iniciar Descargas**. Se abre una pestaña de la DIAN donde la extensión trabaja; resuelva el captcha si se lo pide.
6. Al terminar, encontrará en la carpeta elegida:
   - `<CUFE>.pdf` por cada documento, sin contraseña.
   - `Resumen_DIAN_AAAA-MM-DD_HHMMSS.xlsx` con los datos de todos los documentos.

Otros controles:

- **Detener:** interrumpe el proceso y genera el Excel con lo procesado hasta ese momento.
- **Generar Excel de la última descarga:** vuelve a crear el Excel de la última corrida.
- **Limpiar:** borra la consola de logs.

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
   - **Página del documento:** solicita el PDF a `/Document/DownloadPDF` y lo envía al service worker.
4. El service worker pasa el PDF al **documento offscreen**, que lo descifra, lo lee y lo guarda. Cuando recibe la confirmación, continúa con el siguiente CUFE.

### Lectura de los PDF

La DIAN genera las representaciones gráficas con una plantilla estándar (“Solución Gratuita DIAN”) cuyo texto es extraíble, sin necesidad de OCR. El lector (`lib/invoice-parser.mjs`) usa pdf.js para obtener cada fragmento de texto con su posición (x, y) y luego:

- Lee los pares **“Etiqueta: valor”** por sección (Datos del documento, Emisor/Vendedor, Adquiriente). Busca el valor en una franja alrededor de la etiqueta, por lo que admite etiquetas y valores partidos en varios renglones. Usa las etiquetas y no coordenadas fijas, así que tolera nombres y direcciones de cualquier longitud.
- Reconoce los nombres de los totales en ambas plantillas (p. ej. *Total factura* / *Total documento*, *Rete fuente* / *Rte fuente*) y los toma de la columna de moneda local (COP).
- Reconstruye la **tabla de productos**: las columnas salen de los encabezados y las filas se anclan en la columna *Nro.*. Une las descripciones que ocupan varios renglones.
- Convierte los números en formato colombiano (`1.234.567,89`) a valores numéricos. En el Excel, fechas y montos quedan como fechas y números reales.

## Limitaciones conocidas

- **Captcha:** si Cloudflare pide interacción, hay que resolverlo manualmente en la pestaña de trabajo.
- **Descripciones largas (facturas):** en la factura, la DIAN corta las descripciones carácter por carácter. Cuando una línea llena todo el ancho de la columna no se puede saber si el corte coincidió con un espacio; se asume que no (lo más frecuente), por lo que en casos aislados dos palabras pueden quedar unidas.
- **Otros formatos:** el lector está pensado para las representaciones gráficas estándar de la DIAN (factura electrónica y documento soporte). PDF con plantillas propias de un proveedor tecnológico pueden quedar con campos vacíos, y en ese caso la columna *Observaciones* lo señala.
- **Permiso de carpeta:** Chrome puede pedir reautorizar la carpeta tras reiniciar el navegador, salvo que se haya elegido “Permitir en cada visita”.
- Si la DIAN cambia la estructura de su portal, puede ser necesario actualizar los selectores de `content.js`.

## Permisos que solicita

| Permiso | Para qué se usa |
|---|---|
| `storage`, `unlimitedStorage` | Guardar la cola de CUFEs, los logs y los datos para el Excel en el propio navegador |
| `tabs` | Abrir y controlar la pestaña de trabajo en el portal de la DIAN |
| `downloads` | Guardado de respaldo en *Descargas* si no hay permiso sobre la carpeta elegida |
| `offscreen` | Documento oculto que descifra los PDF, los lee y escribe los archivos |
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
