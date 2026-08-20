/**
 * Extracción de texto de un PDF — capa de I/O del Módulo 1.
 *
 * Usa **`unpdf`**, reusando la decisión de `trazabilidad-obra-gas` (ADR-0000 §7): no depende de
 * archivos de datos externos (fuentes, cmaps) que en un bundle recortado desaparecen, y es más simple
 * que `pdf-parse` + asegurarse de que esos archivos estén presentes.
 *
 * **Detección de OCR necesario, no OCR.** Si el PDF no tiene texto extraíble (viene escaneado), esta
 * capa lo **informa** y el adapter falla con un motivo claro. No se implementa el fallback OCR todavía:
 * el análisis del cliente piloto mostró que los extractos que llegan tienen texto real, y el único que
 * viene en papel **no se escanea** (`docs/analisis/00-cliente-piloto-laura.md` §3.3). El punto de
 * extensión queda marcado; construirlo antes de tener un caso real sería trabajo sin destino.
 *
 * ## Dos vistas del PDF, y por qué hacen falta las dos
 *
 * | Vista | Qué da | Cuándo sirve |
 * |---|---|---|
 * | `aLineas()` | el texto partido en líneas, en el orden del content-stream | bancos cuyo layout sobrevive al orden del stream |
 * | `aFilas()` | los fragmentos con su **coordenada `x` e `y`** | el resto — o sea, el caso normal |
 *
 * La medición sobre el primer banco real dejó claro que `aLineas()` **no alcanza**: `pdf.js` emite en
 * orden de content-stream, y en ese banco el importe y el saldo —que visualmente están en la misma fila
 * que la fecha— salen en una línea **posterior** para 262 de 326 movimientos. Un parser que asuma "una
 * línea = un movimiento" falla en el 80 % de las filas.
 *
 * Y la geometría resuelve algo más: `pdf.js` emite **un solo carácter de espacio por hueco**, sin importar
 * que el hueco mida 5 pt o 236 pt. Así que **no existen columnas de ancho fijo en caracteres** y cualquier
 * `substring(i, j)` es inviable. Las columnas sí existen, pero en puntos PDF.
 */

import zlib from 'node:zlib';
import { getDocumentProxy } from 'unpdf';

export type TextoDelPdf = {
  readonly paginas: readonly string[];
  /**
   * Páginas **sin texto**, 1-based. Es el dato que importa, no el promedio.
   *
   * La primera versión decidía `requiereOcr` con el **promedio** de caracteres por página, y eso es un
   * detector roto: un PDF con 10 páginas de texto y 40 escaneadas promedia por encima del umbral y reporta
   * `false` habiendo perdido 40 páginas. El promedio esconde exactamente el caso que hay que detectar.
   */
  readonly paginasSinTexto: readonly number[];
  /** true solo si **ninguna** página tiene texto: es un PDF imagen entero y haría falta OCR. */
  readonly requiereOcr: boolean;
};

/** Debajo de esto, una página no tiene texto de verdad. */
const CARACTERES_MINIMOS_POR_PAGINA = 40;

export async function extraerTexto(contenido: Uint8Array): Promise<TextoDelPdf> {
  const paginas = await paginasDeTexto(contenido);

  const paginasSinTexto: number[] = [];
  paginas.forEach((p, i) => {
    if (p.replace(/\s/g, '').length < CARACTERES_MINIMOS_POR_PAGINA) paginasSinTexto.push(i + 1);
  });

  return {
    paginas,
    paginasSinTexto,
    // Si alguna página trae texto, el archivo es procesable y las páginas vacías son un hallazgo
    // localizado, no un motivo de rechazo global.
    requiereOcr: paginas.length > 0 && paginasSinTexto.length === paginas.length,
  };
}

/**
 * Un fragmento de texto con su posición en la página, en puntos PDF.
 *
 * `x` crece hacia la derecha e `y` **hacia arriba** (origen abajo a la izquierda). Por eso las filas se
 * ordenan por `y` **descendente**: la primera fila de la tabla tiene el `y` más grande.
 */
export type Fragmento = {
  readonly texto: string;
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
};

export type FilaGeometrica = {
  readonly pagina: number;
  /** Baseline de la fila. */
  readonly y: number;
  /** Fragmentos ordenados por `x` ascendente: el orden visual de izquierda a derecha. */
  readonly fragmentos: readonly Fragmento[];
};

/**
 * Tolerancia vertical para agrupar fragmentos en una fila, en puntos.
 *
 * **1.5 pt no alcanza y el número no es arbitrario**: en el primer banco real, la etiqueta `Total` está en
 * `y=619` y sus tres importes en `y=620.5`. Con una tolerancia menor la fila de totales se parte en dos y
 * la etiqueta se pierde — justo la línea que la verificación necesita. Con 2.5 pt se unen, y sigue siendo
 * bastante menor que el interlineado medido dentro de un movimiento (≈9.6 pt).
 */
export const TOLERANCIA_FILA = 2.5;

/**
 * Extrae los fragmentos con su geometría y los agrupa en filas visuales.
 *
 * Es la vista que un adapter de columnas necesita: las columnas se identifican por la posición `x` (o por
 * el borde derecho, cuando el banco alinea los importes a la derecha), no por índices de carácter.
 */
export async function aFilas(contenido: Uint8Array): Promise<readonly FilaGeometrica[]> {
  const pdf = await documento(contenido);
  const salida: FilaGeometrica[] = [];

  for (let n = 1; n <= pdf.numPages; n += 1) {
    const pagina = await pdf.getPage(n);
    const contenidoTexto = await pagina.getTextContent();

    const fragmentos: Fragmento[] = [];
    for (const item of contenidoTexto.items as readonly {
      str?: string;
      transform?: readonly number[];
      width?: number;
    }[]) {
      const texto = item.str ?? '';
      if (texto.trim() === '') continue;
      fragmentos.push({
        texto,
        x: item.transform?.[4] ?? 0,
        y: item.transform?.[5] ?? 0,
        ancho: item.width ?? 0,
      });
    }

    // Agrupar por baseline. Se recorre de `y` mayor a menor, que es de arriba hacia abajo en la página.
    const porY = [...fragmentos].sort((a, b) => b.y - a.y || a.x - b.x);
    let actual: Fragmento[] = [];
    let yActual: number | null = null;

    const cerrar = (): void => {
      if (actual.length === 0 || yActual === null) return;
      salida.push({
        pagina: n,
        y: yActual,
        fragmentos: [...actual].sort((a, b) => a.x - b.x),
      });
      actual = [];
    };

    for (const f of porY) {
      if (yActual === null || Math.abs(f.y - yActual) <= TOLERANCIA_FILA) {
        yActual ??= f.y;
        actual.push(f);
      } else {
        cerrar();
        yActual = f.y;
        actual = [f];
      }
    }
    cerrar();
  }

  return salida;
}

/**
 * Texto de una fila geométrica, con los fragmentos separados por un espacio.
 *
 * Sirve para las reglas de ruido y para reportar la **forma** de una fila que no se entendió. No sirve para
 * localizar columnas: para eso está la posición.
 */
export function textoDeFila(fila: FilaGeometrica): string {
  return fila.fragmentos.map((f) => f.texto).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * El fragmento cuyo **borde izquierdo** cae en `x`, con tolerancia. Para columnas alineadas a la izquierda.
 */
export function fragmentoEnX(
  fila: FilaGeometrica,
  x: number,
  tolerancia = 1.5,
): Fragmento | undefined {
  return fila.fragmentos.find((f) => Math.abs(f.x - x) <= tolerancia);
}

/**
 * El fragmento cuyo **borde derecho** cae dentro de la ventana. Para columnas alineadas a la derecha, que
 * es cómo todo banco imprime los importes: el borde izquierdo se mueve con la cantidad de dígitos, el
 * derecho no.
 */
export function fragmentoEnVentanaDerecha(
  fila: FilaGeometrica,
  desde: number,
  hasta: number,
): Fragmento | undefined {
  return fila.fragmentos.find((f) => {
    const derecha = f.x + f.ancho;
    return derecha >= desde && derecha <= hasta;
  });
}

/**
 * Une **todos** los fragmentos cuyo borde izquierdo cae en la banda `[desde, hasta]`.
 *
 * ## Por qué existe: `fragmentoEnX` devuelve UNO y hay bancos que parten la glosa
 *
 * Medido en el tercer banco (`07-formato-macro.md` §7): la descripción viene en **1 a 4 fragmentos** por
 * fila (160 filas con 1, 340 con 2, **814 con 3**, 32 con 4). `fragmentoEnX(fila, 70.8)` devuelve solo el
 * primero, y con eso **1186 de 1346 descripciones salen truncadas**.
 *
 * Es el peor modo de falla del módulo: los importes cuadran, la cadena de saldos cierra, el lote dice
 * `procesado` — y el producto, que es la descripción, queda mutilado. Nadie lo mira otra vez.
 *
 * ## La selección es por borde IZQUIERDO, y no es un detalle
 *
 * En ese mismo banco, **113 fragmentos de glosa desbordan visualmente hacia la columna de referencia**: su
 * borde derecho llega a `x=297.6` cuando la referencia arranca en `264.0`. Seleccionar por borde derecho
 * los dejaría afuera; cortar el texto en `264.0` perdería el desborde. Con el borde izquierdo, un fragmento
 * que **empieza** dentro de la banda entra entero, aunque se derrame.
 *
 * La contracara: la banda tiene que **terminar antes** de la columna siguiente, y por eso **`hasta` es
 * EXCLUSIVO** mientras `desde` es inclusivo — la banda es `[desde, hasta)`.
 *
 * Eso no es una preferencia de estilo, es lo que hace que la firma sea usable con las coordenadas que
 * publica la especificación. La primera versión tenía los dos extremos cerrados, y con eso la llamada
 * natural —`fragmentosEnBanda(fila, 70.8, 264.0)`, que son los dos valores medidos— **metía las 1221
 * referencias adentro de la glosa**. Los tests no lo veían porque usaban `263.5`, un colchón inventado por
 * el autor: el borde nunca se ejercitaba. Lo encontró el panel, por dos vías distintas.
 *
 * Con `[desde, hasta)`, el límite de una banda es la coordenada de la columna siguiente, que es como se lee
 * el documento. Hay un test por cada extremo.
 *
 * ## Por qué se une con un espacio
 *
 * Es lo mismo que hace `textoDeFila`, y hay evidencia de que es correcto: las reglas de sección de ese
 * banco (`/^(CUENTA .+?) NRO\.:\s*…$/`) matchean **47 de 47** sobre filas de varios fragmentos armadas así.
 * O sea que este extractor parte en límites de palabra, no en medio de una. Si algún banco lo hiciera en
 * medio de una palabra, la separación correcta sería por el hueco geométrico —y ahí sí haría falta otra
 * función, porque `Fragmento.ancho` **miente** en al menos un banco del roster
 * (`06-formato-santander.md` §11.2).
 *
 * Los fragmentos de una `FilaGeometrica` ya vienen ordenados por `x` ascendente: el orden es el visual.
 */
export function fragmentosEnBanda(fila: FilaGeometrica, desde: number, hasta: number): string {
  return fila.fragmentos
    .filter((f) => f.x >= desde && f.x < hasta)
    .map((f) => f.texto)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parte cada página en líneas limpias, conservando el número de página.
 *
 * No se descarta nada acá: quién es encabezado repetido y qué es ruido lo decide **el adapter del
 * banco**, porque es distinto en cada uno. Esta capa no interpreta.
 */
export type LineaConPagina = { readonly pagina: number; readonly texto: string };

export function aLineas(texto: TextoDelPdf): LineaConPagina[] {
  const salida: LineaConPagina[] = [];
  texto.paginas.forEach((contenido, i) => {
    for (const cruda of contenido.split(/\r?\n/)) {
      const limpia = cruda.replace(/ /g, ' ').trimEnd();
      if (limpia.trim() === '') continue;
      salida.push({ pagina: i + 1, texto: limpia });
    }
  });
  return salida;
}

// -----------------------------------------------------------------------------

/**
 * Abre el PDF con una **copia** del buffer.
 *
 * `pdf.js` se apropia del `ArrayBuffer` y lo deja *detached*: una segunda llamada con la misma vista tira
 * `TypeError: Cannot perform Construct on a detached ArrayBuffer`. Y llamar dos veces es lo normal —una
 * para el texto y otra para la geometría—, así que la copia va acá y no en el llamador, donde se olvida.
 */
async function documento(contenido: Uint8Array): Promise<{
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: readonly unknown[] }>;
  }>;
}> {
  return getDocumentProxy(new Uint8Array(contenido)) as never;
}

async function paginasDeTexto(contenido: Uint8Array): Promise<readonly string[]> {
  const { extractText } = await import('unpdf');
  const pdf = await documento(contenido);
  const { text } = await extractText(pdf as never, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((p) => p ?? '');
}

// -----------------------------------------------------------------------------
// Imagen embebida de una página — plan 15, para el OCR de liquidaciones escaneadas.
// -----------------------------------------------------------------------------

/**
 * La imagen embebida de una página, si tiene una, codificada como **PNG**. `null` si la página no trae
 * ninguna imagen extraíble.
 *
 * ## Lo que se midió antes de escribir esto (plan 15 §2, predicción falsable)
 *
 * `unpdf` expone `extractImages()`, que usa el decodificador de imagen **propio de `pdf.js`** (el mismo
 * motor que ya trae `getDocumentProxy`) para devolver los **píxeles ya decodificados** de cada
 * `paintImageXObject` de la página — nunca hace falta rasterizar la página entera con un canvas.
 * `@napi-rs/canvas` es un *peer dependency opcional* de `unpdf`, usado solo por `renderPageAsImage()`
 * (que sí dibuja la página completa); `extractImages()` no lo toca, y no está instalado en este repo.
 * O sea: la predicción "el `/Image` es extraíble sin rasterizar" se confirma, pero con una salvedad —
 * lo que se obtiene no son los bytes JPEG crudos del stream `/DCTDecode`, sino los píxeles YA
 * decodificados (`Uint8ClampedArray` + ancho + alto + canales). Evita la dependencia nueva igual, así
 * que el resultado práctico es el mismo: nada de `node-canvas`/`@napi-rs/canvas`.
 *
 * ## Por qué PNG y no BMP (🔴 corregido contra el documento real, no una elección de estilo)
 *
 * La primera versión reempaquetaba como BMP —trivial de escribir a mano, y Leptonica lo soporta nativo.
 * **Rompió contra el documento real.** El cuerpo de cada página mide 2110×3033 px × 3 canales ≈ 19,2
 * millones de bytes, y `tesseract.js` normaliza **todo** BMP con `bmp-js` (`worker-script/utils/setImage.js`:
 * *"Leptonica supports some but not all bmp files"*) haciendo `Buffer.from(Array.from({ ...image, length:
 * Object.keys(image).length }))` — ese `{ ...image }` convierte cada byte del array en una propiedad
 * enumerable propia, y V8 tira `RangeError: Too many properties to enumerate` bastante antes de los 19,2
 * millones. Es un límite real de `tesseract.js` v7 para BMP grandes, no una hipótesis: se midió corriendo
 * el pipeline completo contra la página 1 del documento real.
 *
 * PNG evita ese camino entero: `setImage.js` solo pasa por `bmp-js` cuando los dos primeros bytes son
 * `BM`; cualquier otro formato reconocido por Leptonica (PNG incluido) va directo a
 * `TessModule.FS.writeFile('/input', image)`, sin la conversión que rompe. Y no hace falta una
 * dependencia nueva para comprimir: `node:zlib` (built-in) alcanza para el `IDAT` — la única pieza no
 * trivial de un PNG mínimo, sin filtros por fila (tipo 0, "None") y con CRC32 tabulado a mano (ver
 * `crc32Png`, más abajo).
 *
 * ## La imagen de MAYOR ÁREA, nunca "la primera"
 *
 * 🔴 Medido contra el archivo real, y corrigiendo un supuesto equivocado de la primera versión: cada
 * página del documento real trae **dos** imágenes (`extractImages` devuelve un arreglo de 2), no una —
 * un encabezado/logo chico (1297×137 px, ~178 mil px) y el cuerpo escaneado de la página completa
 * (2110×3033 px, ~6,4 millones de px). Tomar "la primera" del arreglo (el orden de aparición en la
 * lista de operadores de dibujo, que no tiene por qué coincidir con el orden visual) le daba el
 * encabezado al OCR y nunca el cuerpo — silencioso: no fallaba, devolvía 3 palabras por página en vez de
 * un error. Es exactamente el modo de falla que este proyecto ya conoce: un resultado plausible con el
 * dato equivocado adentro. La imagen de mayor `ancho × alto` es la heurística correcta mientras el
 * documento real siga trayendo un logo chico y un cuerpo grande — si algún formato futuro trajera dos
 * imágenes de tamaño comparable, esta función seguiría eligiendo una sola y ese caso queda sin cubrir,
 * no inventado.
 */

/**
 * Los píxeles crudos de la imagen de mayor área embebida en una página, tal cual los devuelve
 * `unpdf.extractImages` (ya decodificados, sin codificar a ningún formato de archivo). `null` si la
 * página no trae ninguna imagen extraíble.
 *
 * Separado de `imagenDePagina` (plan 16, paso 1) para que un llamador que necesite los píxeles antes de
 * decidir CÓMO codificarlos —el reintento sobre un recorte, plan 16 paso 3— no tenga que decodificar un
 * PNG que esta misma función acaba de producir. La elección "mayor área, nunca la primera" es la misma
 * de siempre: ver el comentario de `imagenDePagina`, no se repite acá.
 */
export type PixelesDePagina = {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 3 | 4;
};

export async function pixelesDePagina(
  contenido: Uint8Array,
  pagina: number,
): Promise<PixelesDePagina | null> {
  const { extractImages } = await import('unpdf');
  // Copia del buffer: mismo motivo que `documento()` — `pdf.js` deja el `ArrayBuffer` original detached.
  const imagenes = await extractImages(new Uint8Array(contenido), pagina);
  const mayor = imagenes.reduce<(typeof imagenes)[number] | null>((mayor, actual) => {
    const area = actual.width * actual.height;
    const areaMayor = mayor ? mayor.width * mayor.height : -1;
    return area > areaMayor ? actual : mayor;
  }, null);
  if (!mayor) return null;
  return { data: mayor.data, width: mayor.width, height: mayor.height, channels: mayor.channels };
}

/** Envoltorio delgado sobre `pixelesDePagina`: mismos píxeles, codificados a PNG. */
export async function imagenDePagina(contenido: Uint8Array, pagina: number): Promise<Uint8Array | null> {
  const pixeles = await pixelesDePagina(contenido, pagina);
  if (!pixeles) return null;
  return codificarPng(pixeles.data, pixeles.width, pixeles.height, pixeles.channels);
}

const FIRMA_PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Tabla de CRC32 (IEEE 802.3), precomputada una vez. Es el checksum que exige cada chunk PNG. */
const TABLA_CRC32 = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

function crc32Png(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (TABLA_CRC32[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Un chunk PNG: longitud del payload (4, BE) + tipo (4 ASCII) + payload + CRC32 de (tipo+payload). */
function chunkPng(tipo: string, payload: Uint8Array): Uint8Array {
  const salida = new Uint8Array(12 + payload.length);
  const vista = new DataView(salida.buffer);
  vista.setUint32(0, payload.length, false);
  for (let i = 0; i < 4; i += 1) salida[4 + i] = tipo.charCodeAt(i);
  salida.set(payload, 8);
  const paraCrc = salida.subarray(4, 8 + payload.length);
  vista.setUint32(8 + payload.length, crc32Png(paraCrc), false);
  return salida;
}

/**
 * Empaqueta píxeles crudos (1, 3 o 4 canales) como un PNG truecolor de 8 bits sin filtros de fila.
 *
 * Cada scanline lleva el byte de filtro `0` (`None`, sin predicción) antepuesto — es lo único que exige
 * el formato antes de comprimir; no hace falta ninguno de los otros cuatro filtros para que el archivo
 * sea válido, solo para que comprima mejor, y acá el tamaño del archivo no es la prioridad. La
 * compresión la hace `zlib.deflateSync` (built-in de Node, no una dependencia nueva).
 *
 * Exportada (plan 16, paso 2) para que `ocr.ts` la reuse tal cual al codificar un RECORTE vertical de
 * `pixelesDePagina()` en `reconocerRecorte`. Nunca una segunda implementación: el precedente es el bug
 * de BMP de acá arriba, que costó reproducir el pipeline completo contra el documento real para
 * encontrarlo — dos caminos que "deberían" producir el mismo PNG y no lo hacen es exactamente esa
 * clase de bug.
 */
export function codificarPng(
  pixeles: Uint8ClampedArray,
  ancho: number,
  alto: number,
  canales: 1 | 3 | 4,
): Uint8Array {
  const leerPixel = (indice: number): { r: number; g: number; b: number } => {
    const base = indice * canales;
    if (canales === 1) {
      const g = pixeles[base] ?? 0;
      return { r: g, g, b: g };
    }
    return { r: pixeles[base] ?? 0, g: pixeles[base + 1] ?? 0, b: pixeles[base + 2] ?? 0 };
  };

  const anchoFila = 1 + ancho * 3; // byte de filtro + RGB por píxel
  const crudo = new Uint8Array(anchoFila * alto);
  for (let y = 0; y < alto; y += 1) {
    const inicioFila = y * anchoFila;
    crudo[inicioFila] = 0; // filtro None
    for (let x = 0; x < ancho; x += 1) {
      const { r, g, b } = leerPixel(y * ancho + x);
      const destino = inicioFila + 1 + x * 3;
      crudo[destino] = r;
      crudo[destino + 1] = g;
      crudo[destino + 2] = b;
    }
  }

  const ihdr = new Uint8Array(13);
  const vistaIhdr = new DataView(ihdr.buffer);
  vistaIhdr.setUint32(0, ancho, false);
  vistaIhdr.setUint32(4, alto, false);
  ihdr[8] = 8; // profundidad de bit
  ihdr[9] = 2; // tipo de color: truecolor RGB
  ihdr[10] = 0; // compresión: deflate (el único valor válido en PNG)
  ihdr[11] = 0; // filtro: adaptativo por fila (el byte por scanline decide; acá siempre 0)
  ihdr[12] = 0; // sin interlace

  const idat = new Uint8Array(zlib.deflateSync(crudo));

  const partes = [
    FIRMA_PNG,
    chunkPng('IHDR', ihdr),
    chunkPng('IDAT', idat),
    chunkPng('IEND', new Uint8Array(0)),
  ];
  const total = partes.reduce((n, p) => n + p.length, 0);
  const salida = new Uint8Array(total);
  let offset = 0;
  for (const parte of partes) {
    salida.set(parte, offset);
    offset += parte.length;
  }
  return salida;
}
