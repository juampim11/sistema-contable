/**
 * OCR — el ÚNICO archivo del repo que puede importar `tesseract.js`. Plan 15, paso 1 (retomado
 * 2026-08-19). Antes de tocar este archivo, releer `docs/diseno/15-ocr-liquidaciones-plan.md` completo:
 * el porqué de cada decisión de acá está ahí, no repetido dos veces.
 *
 * ## Por qué existe como choke point y no como interfaz agnóstica
 *
 * `arquitecto-software` evaluó y descartó una interfaz tipo `AuthProvider`/`ObjectStorage`: esas existen
 * porque hay variabilidad real de proveedor con credenciales por entorno. Acá no la hay —la nube está
 * excluida por CLAUDE.md §1.4 (ver `docs/seguridad/registro-terceros.md`) y no hay una segunda
 * implementación local que justifique el costo—, así que un choke point verificable (R-P,
 * `packages/data/tests/reglas-de-codigo.test.ts`) da la misma reversibilidad sin pagar la interfaz.
 *
 * ## La condición de cierre: nunca un byte sale a un tercero, ni por accidente
 *
 * Sin `langPath`/`corePath`/`workerPath` configurados, `tesseract.js` intenta bajar de
 * `cdn.jsdelivr.net` **en silencio, sin fallar** — así es como falla-abierto por diseño la librería. Acá
 * es fail-closed: las tres rutas apuntan a los paquetes ya instalados localmente (`tesseract.js-core`,
 * `@tesseract.js-data/spa`), resueltas con `require.resolve()` contra el propio `node_modules` — nunca
 * un string armado a mano que podría desalinearse del layout real del paquete gestor. Son constantes
 * INTERNAS del módulo, nunca parámetro de ninguna función exportada: si fueran parámetro, un caller
 * futuro podría, sin quererlo, volver a apuntar al CDN por defecto.
 *
 * 🔴 **Medido contra el código real de tesseract.js v7 (no de memoria, no por analogía con v5/v6):**
 * `workerPath` SÍ existe como opción de `createWorker` en v7 (`docs/api.md` del paquete instalado:
 * *"workerPath — path for downloading worker script"*). Y en Node —a diferencia del browser— el propio
 * default de la librería (`src/worker/node/defaultOptions.js`) YA apunta a un archivo local
 * (`worker-script/node/index.js` dentro del propio paquete): `spawnWorker.js` de Node abre un
 * `worker_threads.Worker` con esa ruta, nunca una URL. Y `corePath` en Node **no se usa para nada**: el
 * `getCore` de Node (`src/worker-script/node/getCore.js`) ignora el parámetro (`async (oem, _, res) =>
 * …`) y siempre hace `require('tesseract.js-core/tesseract-core…')` — el core es local por construcción,
 * sin importar qué se configure. El único vector de red real en Node es `langPath`: sin él,
 * `worker-script/index.js` arma `https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0` y hace
 * `fetch` (`is-url` decide si `langPath` es una URL o una ruta local; una ruta local nunca dispara el
 * `fetch`). Las tres se configuran igual, explícitas: la que no hace nada hoy puede empezar a hacer algo
 * en una versión futura, y la explicitud no cuesta nada.
 *
 * ## Límites antes de `recognize()`, y por qué
 *
 * `security-engineer`: sin un límite de tamaño/dimensiones y un timeout explícito, un PDF corrupto o una
 * imagen desproporcionada cuelga el proceso indefinidamente — lo contrario de "asistido, no automático":
 * ante algo sospechoso, se rechaza con motivo, nunca se procesa a ciegas.
 *
 * ## El callback de progreso nunca sale de acá
 *
 * `createWorker` acepta un logger/callback de progreso. **Nunca se conecta a nada externo** (analítica,
 * error-tracking, ni siquiera nuestro propio `logger` con el bytes/texto adentro): queda escrito acá
 * para que nadie lo cablee después sin releer este comentario.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createWorker, type Block } from 'tesseract.js';
import { aFilas, extraerTexto, imagenDePagina, type FilaGeometrica } from './texto-pdf.ts';

const require = createRequire(import.meta.url);

/** Directorio de `tesseract.js-core`: contiene los `tesseract-core*.wasm.js` locales. Nunca el CDN. */
const CORE_PATH = dirname(require.resolve('tesseract.js-core/package.json'));

/**
 * El worker de Node de `tesseract.js`, resuelto contra el paquete instalado. Es el mismo archivo que la
 * librería usa por default en Node (nunca el bundle de browser, que si intentaría ir al CDN) — se fija
 * acá explícito para que un cambio de versión que corrija el default no nos saque de este control sin
 * que el barrido de fuga o R-P lo noten.
 */
const WORKER_PATH = require.resolve('tesseract.js/src/worker-script/node/index.js');

/**
 * El paquete de datos de idioma ya trae su propio `langPath`, calculado contra su propio `__dirname`
 * (`@tesseract.js-data/spa/index.js`). Usarlo tal cual evita construir la ruta a mano, que es
 * exactamente la clase de string armado que se desalinea con un cambio de versión del paquete.
 */
const { langPath: LANG_PATH } = require('@tesseract.js-data/spa') as { readonly langPath: string };

/** Confirmado por JP: solo español. No se agrega `eng` sin que alguien lo pida con un caso real. */
const IDIOMA_DEFAULT = 'spa';

/** `numeric`/bytes razonables para una página de liquidación escaneada. Más que esto es sospechoso. */
const MAX_BYTES_IMAGEN = 25 * 1024 * 1024;

/** Una página A4 a 300dpi ronda 2480×3508 px. El doble de eso ya es una imagen fuera de lo esperado. */
const MAX_DIMENSION_PX = 6000;

/** Tope de tiempo para UNA página. Un PDF corrupto o una imagen degenerada no cuelga el proceso. */
const TIMEOUT_RECONOCIMIENTO_MS = 90_000;

export type CodigoErrorOcr =
  | 'imagen_demasiado_grande'
  | 'dimensiones_excesivas'
  | 'formato_de_imagen_no_reconocido'
  | 'timeout_de_reconocimiento'
  | 'motor_ocr_fallo';

/** Error con código, nunca con mensaje armado: acá el "dato" sería el contenido de la imagen. */
export class ErrorDeOcr extends Error {
  readonly codigo: CodigoErrorOcr;

  constructor(codigo: CodigoErrorOcr) {
    super(`Ocr: ${codigo}`);
    this.name = 'ErrorDeOcr';
    this.codigo = codigo;
  }
}

/** Una palabra reconocida. Píxeles de la IMAGEN (no puntos PDF), `y` hacia ABAJO. */
export type PalabraOcr = {
  readonly texto: string;
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
  readonly alto: number;
  /** Tal como lo publica tesseract (0–100 típicamente, puede traer decimales). */
  readonly confianza: number;
};

export type PaginaOcr = {
  readonly pagina: number;
  readonly palabras: readonly PalabraOcr[];
};

/**
 * Dimensiones de una imagen PNG, BMP o JPEG, sin decodificarla. `null` si el formato no se reconoce: eso
 * es un resultado, no una falla — el llamador decide qué código de error corresponde.
 *
 * PNG (el formato real que produce `imagenDePagina`, `texto-pdf.ts`): firma de 8 bytes, seguida del
 * chunk `IHDR` con ancho/alto en `uint32` **big-endian** en los offsets 16/20 — `IHDR` es siempre el
 * primer chunk (lo exige la especificación), así que el offset es fijo.
 *
 * BMP: cabecera `BITMAPFILEHEADER`+`BITMAPINFOHEADER`, ancho/alto en `int32` LE en los offsets 18/22
 * (el alto puede venir negativo para bitmaps top-down: la magnitud es lo que importa acá). Se sigue
 * reconociendo por si algún caller (o un test) pasa un BMP directo — `imagenDePagina` ya no produce
 * BMP, ver su comentario, porque `tesseract.js` v7 rompe con BMP grandes.
 *
 * JPEG: se recorren los marcadores (`0xFF` seguido de un byte que no sea `0x00`/`0xFF` de relleno) hasta
 * un marcador SOF (Start Of Frame, familia `0xC0`–`0xCF` salvo `0xC4`/`0xC8`/`0xCC`, que no son SOF), que
 * trae alto y ancho en los 4 bytes que siguen al byte de precisión.
 */
export function dimensionesImagen(bytes: Uint8Array): { readonly ancho: number; readonly alto: number } | null {
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ancho = vista.getUint32(16, false);
    const alto = vista.getUint32(20, false);
    return { ancho, alto };
  }

  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ancho = vista.getInt32(18, true);
    const alto = vista.getInt32(22, true);
    return { ancho: Math.abs(ancho), alto: Math.abs(alto) };
  }

  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marcador = bytes[i + 1];
      if (marcador === undefined || marcador === 0x00 || marcador === 0xff) {
        i += 1;
        continue;
      }
      const esSof =
        marcador >= 0xc0 &&
        marcador <= 0xcf &&
        marcador !== 0xc4 &&
        marcador !== 0xc8 &&
        marcador !== 0xcc;
      if (esSof) {
        const alto = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
        const ancho = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
        return { ancho, alto };
      }
      // Marcadores sin payload (RST0-7, SOI, EOI) no traen longitud: avanzar de a un byte.
      if (marcador >= 0xd0 && marcador <= 0xd9) {
        i += 2;
        continue;
      }
      const largoSegmento = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
      if (largoSegmento < 2) return null;
      i += 2 + largoSegmento;
    }
    return null;
  }

  return null;
}

/** `worker.recognize()` con un tope de tiempo. Si vence, se termina el worker y se lanza el código. */
async function conTimeout<T>(promesa: Promise<T>, worker: { terminate(): Promise<unknown> }): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, reject) => {
    temporizador = setTimeout(() => {
      void worker.terminate();
      reject(new ErrorDeOcr('timeout_de_reconocimiento'));
    }, TIMEOUT_RECONOCIMIENTO_MS);
  });
  try {
    return await Promise.race([promesa, limite]);
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Aplana `blocks → paragraphs → lines → words` (la forma nativa de tesseract.js) a una lista chata de
 * `PalabraOcr`: acá no hace falta la jerarquía, el próximo eje (`captura.ts`) trabaja por campo, no por
 * bloque de layout. `null` (documento sin nada reconocido) da lista vacía, nunca un error.
 */
function aplanarPalabras(blocks: readonly Block[] | null): PalabraOcr[] {
  const palabras: PalabraOcr[] = [];
  for (const bloque of blocks ?? []) {
    for (const parrafo of bloque.paragraphs) {
      for (const linea of parrafo.lines) {
        for (const palabra of linea.words) {
          palabras.push({
            texto: palabra.text,
            x: palabra.bbox.x0,
            y: palabra.bbox.y0,
            ancho: palabra.bbox.x1 - palabra.bbox.x0,
            alto: palabra.bbox.y1 - palabra.bbox.y0,
            confianza: palabra.confidence,
          });
        }
      }
    }
  }
  return palabras;
}

/**
 * Reconoce una imagen (PNG, BMP o JPEG, en bytes) y devuelve sus palabras con geometría y confianza.
 *
 * Crea y termina un worker por llamada: es el diseño más simple y seguro para el volumen real (un
 * cliente, pocas liquidaciones por mes, unas pocas páginas cada una) — reusar un worker entre páginas es
 * una optimización sin caso que la pida todavía.
 */
export async function reconocerImagen(
  bytes: Uint8Array,
  idioma: string = IDIOMA_DEFAULT,
): Promise<PaginaOcr> {
  if (bytes.length === 0 || bytes.length > MAX_BYTES_IMAGEN) {
    throw new ErrorDeOcr('imagen_demasiado_grande');
  }

  const dimensiones = dimensionesImagen(bytes);
  if (dimensiones === null) {
    throw new ErrorDeOcr('formato_de_imagen_no_reconocido');
  }
  if (dimensiones.ancho > MAX_DIMENSION_PX || dimensiones.alto > MAX_DIMENSION_PX) {
    throw new ErrorDeOcr('dimensiones_excesivas');
  }

  const worker = await createWorker(idioma, undefined, {
    langPath: LANG_PATH,
    corePath: CORE_PATH,
    workerPath: WORKER_PATH,
    cacheMethod: 'none',
    // Nunca se conecta a nada externo. Ver el comentario de cabecera. No cablear un logger acá.
    logger: () => {},
  });

  try {
    // `blocks` viene deshabilitado por default desde v6 (menos output = menos runtime): sin pedirlo acá,
    // `data.blocks` es `null` y no hay geometría por palabra que capturar.
    const { data } = await conTimeout(
      worker.recognize(Buffer.from(bytes), {}, { blocks: true }),
      worker,
    );
    const palabras = aplanarPalabras(data.blocks);
    return { pagina: 1, palabras };
  } catch (e) {
    if (e instanceof ErrorDeOcr) throw e;
    throw new ErrorDeOcr('motor_ocr_fallo');
  } finally {
    await worker.terminate();
  }
}

/**
 * Extrae el texto del PDF, y para las páginas SIN texto nativo (`requiereOcr`/`paginasSinTexto` de
 * `texto-pdf.ts`), pide su imagen embebida (`imagenDePagina`) y corre OCR. Así los siete adapters
 * bancarios y `texto-pdf.ts` en sí nunca cargan `tesseract.js`: solo el adapter de liquidaciones que de
 * verdad recibe documentos escaneados importa esta función.
 *
 * `usoOcrEnPagina[i]` dice, por página (0-based, igual que `paginas`), si esa entrada vino de OCR o de
 * la geometría nativa del PDF — es el dato que la cola de revisión necesita para no mostrar un valor de
 * OCR como si fuera texto nativo (dictamen `contador-dominio`, plan 15).
 */
export async function extraerConOcrSiHaceFalta(
  contenido: Uint8Array,
): Promise<{
  readonly paginas: readonly (readonly FilaGeometrica[] | PaginaOcr)[];
  readonly usoOcrEnPagina: readonly boolean[];
}> {
  const texto = await extraerTexto(contenido);
  const sinTexto = new Set(texto.paginasSinTexto);
  const filas = await aFilas(contenido);

  const paginas: (readonly FilaGeometrica[] | PaginaOcr)[] = [];
  const usoOcrEnPagina: boolean[] = [];

  for (let pagina = 1; pagina <= texto.paginas.length; pagina += 1) {
    if (!sinTexto.has(pagina)) {
      paginas.push(filas.filter((f) => f.pagina === pagina));
      usoOcrEnPagina.push(false);
      continue;
    }

    const imagen = await imagenDePagina(contenido, pagina);
    if (imagen === null) throw new ErrorDeOcr('formato_de_imagen_no_reconocido');
    const reconocida = await reconocerImagen(imagen);
    paginas.push({ ...reconocida, pagina });
    usoOcrEnPagina.push(true);
  }

  return { paginas, usoOcrEnPagina };
}
