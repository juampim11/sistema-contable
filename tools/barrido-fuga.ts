/**
 * BARRIDO DE FUGA SOBRE EL REPO — condición de salida nº 4.
 *
 * ## Por qué existe
 *
 * Había **importes y una glosa del extracto real de un cliente en los comentarios** de tres archivos
 * fuente. Y el punto no es el descuido: es que **ningún control existente lo detectaba**.
 *
 *   - el redactor mira **logs**,
 *   - INV-8 mira la **salida del logger**,
 *   - R33 mira **secretos** (claves privadas, `.env`),
 *   - y **nadie miraba el código fuente ni la documentación**.
 *
 * Un comentario viaja al historial de git, a los títulos de PR, a los logs de CI y al contexto de cada
 * agente que abre el repo. Ahí no hay redactor. Y por ADR-0002 §E.4.8, lo que entró al historial se
 * considera público para siempre: no hay rotación posible para un importe.
 *
 * ## Los dos modos, y por qué hacen falta los dos
 *
 * La primera versión corría los detectores sobre el repo y fallaba con **18 hallazgos, y los 18 eran
 * ejemplos sintéticos legítimos**: las cuatro notaciones de signo documentadas en `parseo-ar.ts`, los
 * importes de ejemplo de los ADR, los DSN de desarrollo del `.env.example`. **Un chequeo que grita en falso
 * 18 veces se desactiva en la segunda semana** — y entonces no protege de nada.
 *
 * El problema era la pregunta. La correcta no es *"¿hay algo con forma de importe en el repo?"* —el repo
 * documenta un formato bancario, claro que sí— sino **"¿hay algún VALOR del archivo real de un cliente en
 * el repo?"**. Es exactamente la comparación que encontró la fuga, y tiene **cero falsos positivos**.
 *
 * 1. **Estricto** (`privado/` presente, o sea la máquina de trabajo): cada candidato se **cruza contra el
 *    material real**. Si un valor del repo aparece en un archivo de un cliente → **falla**. Es el control
 *    de verdad.
 * 2. **CI** (`privado/` no existe): no hay contra qué cruzar, así que se compara contra una **allowlist de
 *    huellas** commiteada. Un candidato nuevo que no esté en la lista **falla**, y para aceptarlo hay que
 *    correr el modo estricto en la máquina que sí tiene el material. Así **CI no puede quedar verde con un
 *    valor que nadie cruzó**.
 *
 * La allowlist guarda **huellas, no valores**: un archivo de "valores aceptados" sería otra copia del dato.
 *
 *     pnpm barrido            → falla si hay fuga (estricto) o candidato sin verificar (CI)
 *     pnpm barrido --aceptar  → regenera la allowlist. Solo tiene efecto en modo estricto
 *
 * ## Su límite, declarado
 *
 * **No puede detectar una razón social ni un nombre propio**: es texto sin patrón (ADR-0002 §C.0.bis).
 * Este barrido cierra el agujero de los **identificadores y los importes**, que son los que tienen forma.
 * Para los nombres, la defensa sigue siendo la revisión y la regla de no copiar del archivo real.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { extname, join, relative, sep } from 'node:path';
import { DETECTORES, sinEstado } from '@sistema-contable/shared/seguridad';
import { formaParaLog } from '@sistema-contable/shared/observabilidad';
import { raizDelRepo } from './cargar-env.ts';

const RAIZ = raizDelRepo();
const SALTO = String.fromCharCode(10);

/** Directorios que no se barren: no son texto versionable del proyecto. */
const DIRECTORIOS_EXCLUIDOS = new Set([
  'node_modules',
  '.git',
  '.pnpm',
  'dist',
  '.next',
  'coverage',
  'privado', // ← el material real vive acá A PROPÓSITO y está gitignoreado
  '.cache-barrido', // texto ya extraído del material real; vive dentro de privado/
]);

/** Extensiones que se barren: lo que puede llegar a un commit como texto. */
const EXTENSIONES = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.sql',
  '.md',
  '.yml',
  '.yaml',
  '.json',
  '.example',
]);

/**
 * Extensiones de `privado/` que se leen como texto plano.
 *
 * **No alcanza con estas.** La primera versión leía solo estas, y al probar el control con una fuga
 * plantada resultó que **no había un solo importe con qué cruzar**: el material real de este proyecto son
 * los PDF y los Excel de los bancos, y ninguno es texto plano. El barrido daba verde porque no estaba
 * mirando nada. Por eso abajo están los tres lectores binarios.
 */
const EXTENSIONES_TEXTO = new Set(['.txt', '.csv', '.md', '.json', '.vtt', '.srt', '.tsv', '.log']);

/** Los que hay que abrir con un lector. Son los que de verdad tienen los datos del cliente. */
const EXTENSIONES_PDF = new Set(['.pdf']);
const EXTENSIONES_HOJA = new Set(['.xlsx', '.xlsm']);
/**
 * El resto se lee con extracción de cadenas imprimibles.
 *
 * Para cruzar no hace falta parsear: hace falta saber **qué valores están adentro**. Un `.xls` puede ser
 * BIFF, un TSV en Latin-1 o un HTML renombrado (las tres tecnologías aparecen en el roster de bancos), y
 * un extractor de cadenas los cubre a los tres sin tres parsers.
 */
const EXTENSIONES_BINARIAS = new Set(['.xls', '.eml', '.msg', '.doc', '.docx', '.rtf', '.ods']);

/**
 * Archivos donde un detector matchea **a propósito**, con su motivo escrito.
 *
 * Los tests de seguridad tienen que poder construir un caso sensible para probar que lo detectan: un
 * barrido que los prohíba deja al repo sin poder verificarse a sí mismo.
 *
 * **Esta lista NO exime del cruce estricto.** Vale solo en modo CI, donde lo único que se puede preguntar
 * es "¿este candidato ya lo vio alguien?". El cruce contra el material real no tiene falsos positivos, así
 * que no necesita excepciones — y eximir a un test sería dejar abierta justo la puerta que el barrido
 * cierra: nada impide pegar un valor real dentro de un archivo de test.
 */
const PERMITIDOS: readonly { readonly ruta: string; readonly motivo: string }[] = [
  {
    ruta: 'packages/shared/tests/redactor.test.ts',
    motivo: 'Construye valores sensibles SINTÉTICOS para probar que el redactor los tapa.',
  },
  {
    ruta: 'packages/shared/tests/forma.test.ts',
    motivo: 'Verifica que la forma no matchee ningún detector: necesita los casos.',
  },
  {
    ruta: 'packages/shared/src/seguridad/redactar.ts',
    motivo: 'Define los detectores; sus patrones matchean su propio texto de ejemplo.',
  },
  { ruta: 'tools/barrido-fuga.ts', motivo: 'Este archivo importa los detectores y los nombra.' },
  {
    ruta: 'packages/ingesta/tests/parseo-ar.test.ts',
    motivo:
      'Tokens SINTÉTICOS que imitan un CUIT, un CBU y un importe: son los casos que prueban el fix.',
  },
  {
    ruta: 'packages/data/src/seed/sintetico.ts',
    motivo: 'Genera identificadores con verificador INVÁLIDO; su propio test lo asegura.',
  },
  { ruta: 'packages/ingesta/src/seed/extracto-sintetico.ts', motivo: 'Ídem para extractos.' },
  {
    ruta: 'tools/barrido-fuga.test.ts',
    motivo: 'Verifica al verificador: planta fugas SINTÉTICAS y exige que el barrido las marque.',
  },
];

export type Hallazgo = {
  readonly archivo: string;
  readonly linea: number;
  readonly detector: string;
  /** La FORMA del fragmento, nunca el valor: este archivo no puede ser el que filtre el dato. */
  readonly forma: string;
  /** sha256 truncado del valor normalizado. Es lo que va a la allowlist. */
  readonly huella: string;
  /** Solo en modo estricto: si el valor aparece en un archivo real de `privado/`. */
  readonly enMaterialReal: boolean | null;
};

export type ResultadoBarrido = {
  readonly modo: 'estricto' | 'ci';
  readonly hallazgos: readonly Hallazgo[];
  /** Modo estricto: valores del material real presentes en el repo. Es LA fuga. */
  readonly fugas: readonly Hallazgo[];
  /** Modo CI: candidatos que nadie cruzó todavía. */
  readonly sinVerificar: readonly Hallazgo[];
  readonly archivosRevisados: number;
};

// -----------------------------------------------------------------------------

function recorrer(
  dir: string,
  aceptar: (nombre: string) => boolean,
  acumulado: string[] = [],
): string[] {
  for (const entrada of readdirSync(dir)) {
    if (DIRECTORIOS_EXCLUIDOS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    let esDir = false;
    try {
      esDir = statSync(ruta).isDirectory();
    } catch {
      continue;
    }
    if (esDir) recorrer(ruta, aceptar, acumulado);
    else if (aceptar(entrada)) acumulado.push(ruta);
  }
  return acumulado;
}

function rel(ruta: string): string {
  return relative(RAIZ, ruta).split(sep).join('/');
}

/**
 * Normaliza un valor para comparar. Se quitan los separadores de agrupamiento y **se conserva la coma
 * decimal**.
 *
 * Las dos mitades de esta decisión salieron de un error medido:
 *
 * 1. **Hay que quitar los puntos de miles y los guiones**, o el cruce da falso negativo: el mismo importe
 *    escrito `765.432,10` en un archivo y `765 432,10` en otro tiene que cruzar, y el mismo CUIT con y sin
 *    guiones también. Un chequeo que da tranquilidad falsa es peor que no tenerlo.
 * 2. **Hay que conservar la coma decimal.** Al quitarla, el importe `1.111,11` quedaba como `111111` y
 *    cruzaba contra un **número de operación** `111111` del material: mismo string, dato distinto. La coma
 *    es lo que hace que un importe sea un importe, y borrarla borra la única evidencia de que son la misma
 *    cosa.
 */
function normalizarValor(v: string): string {
  return v.replace(/[.\-\s$()]/g, '').toUpperCase();
}

export function huellaDe(valor: string): string {
  return createHash('sha256').update(normalizarValor(valor), 'utf8').digest('hex').slice(0, 32);
}

/**
 * El material real, preparado para cruzar de las dos maneras que hacen falta.
 *
 * Comparar con `material.includes(valor)` sobre el texto entero sin separadores **da falsos positivos**, y
 * el propio test del barrido lo encontró: `(1.234,56)` normaliza a `123456`, que es substring del CUIT
 * `20123456789`. Un importe de ejemplo del parser quedaba marcado como fuga.
 *
 * Y comparar **solo** por token exacto da falsos negativos, porque un extractor de PDF parte un importe en
 * dos (`765 432,10`) y entonces el token del material no es el valor del repo.
 *
 * Así que se guardan las dos vistas y se cruza contra ambas.
 */
export type MaterialReal = {
  /** Cada token del material, normalizado. El cruce exacto: preciso, sin falsos positivos. */
  readonly tokens: ReadonlySet<string>;
  /** Todo el material normalizado y pegado. El cruce por substring: atrapa el token partido. */
  readonly texto: string;
};

/**
 * ## Por qué el cruce es SOLO por token, y no por substring
 *
 * La versión con substring se probó y **dio nueve falsos positivos**. Al inspeccionar dónde aparecía cada
 * valor en el material, ninguno era un dato: estaban embebidos en ruido binario (`>=<;:##########/+*'&%#"!`
 * y `<A>#################</A>`, o sea bytes de estructura, no cifras de un extracto).
 *
 * La causa es aritmética. El material extraído mide 13 millones de caracteres, y un token de ocho dígitos
 * tiene una probabilidad nada despreciable de aparecer ahí por azar. Un chequeo con esa tasa de falsos
 * positivos se desactiva, y entonces la fuga que sí importa pasa igual.
 *
 * El cruce por **token aislado** no tuvo ni un falso positivo sobre el mismo material: ninguno de los nueve
 * candidatos aparecía como token. Un token es una unidad que el documento delimitó, no una coincidencia.
 */
const MINIMO_LARGO_TOKEN = 4;

/**
 * Las dos funciones puras del barrido, expuestas para que el test pueda **verificar al verificador** sin
 * tocar el disco ni depender de que `privado/` exista (en CI no existe).
 */
export function candidatosEnTexto(
  contenido: string,
): readonly { readonly linea: number; readonly detector: string; readonly valor: string }[] {
  const salida: { linea: number; detector: string; valor: string }[] = [];
  const lineas = contenido.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i] ?? '';
    for (const d of DETECTORES) {
      // Sin las banderas con estado (`g`/`y`): alcanza el primer match por línea y por detector para
      // localizar el archivo. Antes era `.flags.replace('g', '')` acá mismo, que tapaba `g` y dejaba
      // pasar `y` — el mismo bug que ya se había corregido en `toolkit.ts`, reintroducido por no importar
      // de ahí (paquete distinto). `sinEstado` ahora vive en `packages/shared`, importado por los dos.
      const re = sinEstado(d.patron);
      const valor = re.exec(linea)?.[0];
      if (valor) salida.push({ linea: i + 1, detector: d.nombre, valor });
    }
  }
  return salida;
}

/** `true` si el valor del repo aparece como token del material real. Única definición de "fuga". */
export function esFuga(valor: string, material: MaterialReal): boolean {
  const n = normalizarValor(valor);
  return n.length >= MINIMO_LARGO_TOKEN && material.tokens.has(n);
}

/**
 * Descarta las cadenas que no son texto.
 *
 * Extraer cadenas de un binario produce mucha basura de estructura, y esa basura es la que generó los
 * falsos positivos. Una línea de texto de un extracto es mayoritariamente letras, dígitos y espacios; una
 * línea de ruido es mayoritariamente puntuación y símbolos. El umbral separa las dos.
 */
function pareceTexto(linea: string): boolean {
  if (linea.length < MINIMO_LARGO_TOKEN) return false;
  let utiles = 0;
  for (const c of linea) if (/[A-Za-z0-9 ]/.test(c)) utiles += 1;
  return utiles / linea.length >= 0.7;
}

/**
 * Prepara el material real: **los mismos detectores, de los dos lados de la comparación**.
 *
 * La versión anterior tokenizaba el material por espacios, y al probarla con un importe real plantado en el
 * repo **no lo detectó**. La causa: en el texto extraído de un PDF o de un `.xls`, un importe viene pegado a
 * su vecino sin espacio (`SALDOANTERIOR765.432,10`), así que el "token" del material era otra cosa y el
 * cruce fallaba en silencio. Un falso negativo es el modo de falla peor: **cierra la pregunta**.
 *
 * La corrección es hacer simétrica la definición. Los detectores son la definición operativa de "dato
 * sensible" en este repo; si son lo que se busca en el repo, tienen que ser también lo que se extrae del
 * material. Así el conjunto contra el que se cruza no son "las palabras del archivo" sino **los valores
 * sensibles del archivo**, que es exactamente lo que se quiere comparar.
 *
 * Además se cruza una segunda pasada con los espacios entre dígitos colapsados, porque un extractor de PDF
 * parte `765.432,10` en `765` y `432,10` y ahí el detector no matchea la línea tal cual viene.
 */
export function prepararMaterial(texto: string): MaterialReal {
  const tokens = new Set<string>();

  for (const linea of texto.split(/\r?\n/)) {
    if (!pareceTexto(linea)) continue;
    // Segunda vista de la línea: sin los espacios que un extractor de PDF mete entre dígitos.
    const pegada = linea.replace(/(\d)[  ]+(?=[\d.,])/g, '$1');
    for (const vista of pegada === linea ? [linea] : [linea, pegada]) {
      for (const d of DETECTORES) {
        const re = new RegExp(d.patron.source, d.patron.flags.includes('g') ? d.patron.flags : `${d.patron.flags}g`);
        for (const m of vista.matchAll(re)) {
          const n = normalizarValor(m[0]);
          if (n.length >= MINIMO_LARGO_TOKEN) tokens.add(n);
        }
      }
    }
  }

  return { tokens, texto: normalizarValor(texto) };
}

/**
 * Extrae las cadenas imprimibles de un binario, en las dos codificaciones que importan.
 *
 * Latin-1 cubre BIFF, TSV y HTML renombrado; UTF-16LE cubre lo que produce Windows. Se corren las dos
 * porque probar solo una deja al archivo mudo, y un archivo mudo se cuenta como "limpio".
 */
function cadenasDeBinario(buffer: Buffer): string {
  const partes: string[] = [];
  for (const codificacion of ['latin1', 'utf16le'] as const) {
    const texto = buffer.toString(codificacion);
    // Corridas de 4+ caracteres imprimibles: por debajo de eso es ruido de estructura.
    for (const m of texto.matchAll(/[\x20-\x7eÀ-ÿ]{4,}/g)) partes.push(m[0]);
  }
  return partes.join(SALTO);
}

/**
 * Caché del texto extraído, **dentro de `privado/`** porque es material real: no puede vivir en ningún
 * lugar versionable. Sin caché el barrido paga la extracción de todos los PDF en cada corrida, y un
 * chequeo lento se saltea.
 */
const DIR_CACHE = join(RAIZ, 'privado', '.cache-barrido');

function textoDeArchivo(ruta: string): string {
  const ext = extname(ruta).toLowerCase();
  if (EXTENSIONES_TEXTO.has(ext)) return readFileSync(ruta, 'utf8');
  if (EXTENSIONES_BINARIAS.has(ext) || EXTENSIONES_HOJA.has(ext) || EXTENSIONES_PDF.has(ext)) {
    // Se cachea por mtime: si el archivo cambió, se vuelve a extraer.
    const clave = createHash('sha256').update(ruta).digest('hex').slice(0, 24);
    const marca = String(statSync(ruta).mtimeMs);
    const cache = join(DIR_CACHE, `${clave}.txt`);
    if (existsSync(cache)) {
      const guardado = readFileSync(cache, 'utf8');
      const corte = guardado.indexOf(SALTO);
      if (corte > 0 && guardado.slice(0, corte) === marca) return guardado.slice(corte + 1);
    }
    const texto = extraerTextoDe(ruta, ext);
    mkdirSync(DIR_CACHE, { recursive: true });
    writeFileSync(cache, marca + SALTO + texto, 'utf8');
    return texto;
  }
  return '';
}

/**
 * PDF y XLSX no son texto, pero **para cruzar no hace falta parsearlos**: hace falta saber qué valores
 * están adentro. Un PDF con texto embebido guarda sus cadenas en streams comprimidos con Flate, así que se
 * descomprimen y se extraen las cadenas; un XLSX es un ZIP de XML, mismo tratamiento. Los dos casos son
 * "inflar y sacar cadenas", y eso evita meter una dependencia de parseo en una herramienta de seguridad.
 *
 * Si un PDF es puro escaneo (uno del roster lo es), no hay texto que extraer y **eso queda declarado**: el
 * barrido no puede cruzar contra una imagen, y decirlo es mejor que dar verde en silencio.
 */
function extraerTextoDe(ruta: string, ext: string): string {
  const buffer = readFileSync(ruta);
  const partes: string[] = [cadenasDeBinario(buffer)];

  // Inflar todo lo que parezca un stream Flate. Cubre PDF (streams) y XLSX/ODS (entradas ZIP deflate).
  for (let i = 0; i < buffer.length - 2; i += 1) {
    // Cabecera zlib: 0x78 seguido de 0x01/0x9c/0xda/0x5e son las combinaciones habituales.
    if (buffer[i] !== 0x78) continue;
    const segundo = buffer[i + 1];
    if (segundo !== 0x01 && segundo !== 0x9c && segundo !== 0xda && segundo !== 0x5e) continue;
    try {
      partes.push(cadenasDeBinario(inflateSync(buffer.subarray(i), { finishFlush: 2 })));
    } catch {
      /* no era un stream: seguir */
    }
  }
  // `raw deflate` sin cabecera zlib, que es como el ZIP de un XLSX guarda sus entradas.
  if (EXTENSIONES_HOJA.has(ext)) {
    for (let i = 0; i < buffer.length - 30; i += 1) {
      if (buffer.readUInt32LE(i) !== 0x04034b50) continue; // firma de entrada local ZIP
      const nombreLargo = buffer.readUInt16LE(i + 26);
      const extraLargo = buffer.readUInt16LE(i + 28);
      const inicio = i + 30 + nombreLargo + extraLargo;
      try {
        partes.push(cadenasDeBinario(inflateRawSync(buffer.subarray(inicio), { finishFlush: 2 })));
      } catch {
        /* entrada almacenada sin comprimir o corrupta: ya la cubrió `cadenasDeBinario` */
      }
    }
  }
  return partes.join(SALTO);
}

export type ResumenMaterial = {
  readonly archivos: number;
  /** Archivos de los que no se pudo extraer nada: el barrido está CIEGO ante ellos y hay que decirlo. */
  readonly mudos: readonly string[];
  readonly caracteres: number;
};

let resumenUltimoMaterial: ResumenMaterial = { archivos: 0, mudos: [], caracteres: 0 };

/**
 * Todo el material de `privado/`, preparado para cruzar. `null` si la carpeta no existe (modo CI).
 *
 * **Exportada a propósito**: el gate de fixtures (`tools/verificar-fixtures.ts`) tiene que cruzar contra
 * exactamente el mismo material. Su primera versión lo leía por su cuenta y cruzaba contra una fracción,
 * así que dos controles que decían "cruzado contra el material real" miraban cosas distintas — la clase de
 * divergencia que ya apareció dos veces en este trabajo.
 */
export function materialReal(): MaterialReal | null {
  const dir = join(RAIZ, 'privado');
  if (!existsSync(dir)) return null;

  const lector = (n: string): boolean => {
    const e = extname(n).toLowerCase();
    return (
      EXTENSIONES_TEXTO.has(e) ||
      EXTENSIONES_PDF.has(e) ||
      EXTENSIONES_HOJA.has(e) ||
      EXTENSIONES_BINARIAS.has(e)
    );
  };

  const partes: string[] = [];
  const mudos: string[] = [];
  const archivos = recorrer(dir, lector);
  for (const a of archivos) {
    let texto = '';
    try {
      texto = textoDeArchivo(a);
    } catch {
      /* ilegible: cuenta como mudo, no como limpio */
    }
    if (texto.trim().length === 0) mudos.push(rel(a));
    else partes.push(texto);
  }

  const unido = partes.join(SALTO);
  resumenUltimoMaterial = { archivos: archivos.length, mudos, caracteres: unido.length };
  return prepararMaterial(unido);
}

export function resumenMaterial(): ResumenMaterial {
  return resumenUltimoMaterial;
}

const RUTA_ALLOWLIST = join(RAIZ, 'tools', 'barrido-aceptados.json');

function leerAllowlist(): Set<string> {
  if (!existsSync(RUTA_ALLOWLIST)) return new Set();
  const j = JSON.parse(readFileSync(RUTA_ALLOWLIST, 'utf8')) as { huellas?: string[] };
  return new Set(j.huellas ?? []);
}

// -----------------------------------------------------------------------------

export function barrer(): ResultadoBarrido {
  const permitidos = new Set(PERMITIDOS.map((p) => p.ruta));
  /**
   * `.env` y `.env.*` se barren explícitamente.
   *
   * `extname('.env')` devuelve `''`, así que el filtro por extensión **no los alcanzaba**: eran el único
   * lugar del árbol de trabajo donde un CBU real podía quedar escrito sin que ningún control lo viera — y
   * es exactamente el archivo donde uno lo pondría "un rato mientras pruebo". Están gitignoreados, así que
   * no se commitean, pero son los que se copian entre máquinas y se pegan en un ticket.
   */
  const archivos = recorrer(
    RAIZ,
    (n) => EXTENSIONES.has(extname(n)) || n === '.env.example' || n === '.env' || n.startsWith('.env.'),
  );
  // `BARRIDO_FORZAR_CI=1` simula la máquina de CI para poder verificar ESE camino desde acá. Solo puede
  // forzar hacia el modo más ciego: no hay manera de fingir tener material real que no está.
  const real = process.env['BARRIDO_FORZAR_CI'] === '1' ? null : materialReal();
  const modo: 'estricto' | 'ci' = real === null ? 'ci' : 'estricto';
  const allowlist = leerAllowlist();
  const hallazgos: Hallazgo[] = [];

  for (const ruta of archivos) {
    const r = rel(ruta);
    // La exención vale solo para el modo CI: el cruce estricto no exime a nadie, ni a los tests.
    if (modo === 'ci' && permitidos.has(r)) continue;
    if (r === 'tools/barrido-aceptados.json') continue; // huellas, no valores

    for (const c of candidatosEnTexto(readFileSync(ruta, 'utf8'))) {
      hallazgos.push({
        archivo: r,
        linea: c.linea,
        detector: c.detector,
        forma: formaParaLog(c.valor, 40),
        huella: huellaDe(c.valor),
        enMaterialReal: real === null ? null : esFuga(c.valor, real),
      });
    }
  }

  return {
    modo,
    hallazgos,
    fugas: modo === 'estricto' ? hallazgos.filter((h) => h.enMaterialReal === true) : [],
    sinVerificar: modo === 'ci' ? hallazgos.filter((h) => !allowlist.has(h.huella)) : [],
    archivosRevisados: archivos.length,
  };
}

export function motivoPermitido(ruta: string): string | undefined {
  return PERMITIDOS.find((p) => p.ruta === ruta)?.motivo;
}

export function escribirAllowlist(hallazgos: readonly Hallazgo[]): number {
  // Solo las huellas de los archivos que CI va a revisar: las de los exentos nunca se le van a preguntar.
  const huellas = [
    ...new Set(
      hallazgos.filter((h) => motivoPermitido(h.archivo) === undefined).map((h) => h.huella),
    ),
  ].sort();
  const contenido = {
    _comentario:
      'Huellas (sha256 truncado) de los candidatos ACEPTADOS, cruzados contra el material real en modo ' +
      'estricto. NO contiene valores: un archivo de valores aceptados seria otra copia del dato. Se ' +
      'regenera con `pnpm barrido --aceptar` en una maquina con privado/ presente.',
    generado_en_modo: 'estricto',
    huellas,
  };
  writeFileSync(RUTA_ALLOWLIST, JSON.stringify(contenido, null, 2) + SALTO, 'utf8');
  return huellas.length;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function imprimir(texto: string): void {
  process.stdout.write(texto + SALTO);
}

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('tools/barrido-fuga.ts');

if (esEjecucionDirecta) {
  const r = barrer();
  imprimir('');
  imprimir(
    `  barrido de fuga [modo ${r.modo}]: ${r.archivosRevisados} archivos, ${r.hallazgos.length} candidato(s)`,
  );

  if (r.modo === 'estricto') {
    const m = resumenMaterial();
    imprimir(
      `  material real: ${m.archivos} archivo(s), ${m.caracteres.toLocaleString('es-AR')} caracteres extraidos`,
    );
    // Un archivo del que no se extrajo nada NO es un archivo limpio: es un archivo que no se miro.
    if (m.mudos.length > 0) {
      imprimir(`  CIEGO ante ${m.mudos.length} archivo(s) sin texto extraible (escaneos, formatos opacos):`);
      for (const x of m.mudos) imprimir(`    - ${x}`);
    }
    if (r.fugas.length === 0) {
      imprimir('  OK: ningun valor del material real de privado/ aparece en el repo.');
      if (process.argv.includes('--aceptar')) {
        imprimir(`  allowlist actualizada: ${escribirAllowlist(r.hallazgos)} huella(s).`);
      }
      imprimir('');
      process.exit(0);
    }
    imprimir('');
    imprimir(`  FUGA: ${r.fugas.length} valor(es) del material real presentes en el repo`);
    imprimir('');
    for (const h of r.fugas) {
      imprimir(`    ${h.archivo}:${h.linea}  [${h.detector}]  forma=${h.forma}`);
    }
    imprimir('');
    imprimir('  Un dato de un cliente en el codigo o en la documentacion viaja al historial de git y al');
    imprimir('  contexto de cada agente, donde no hay redactor. Reemplazalo por un valor SINTETICO.');
    imprimir('');
    process.exit(1);
  }

  if (r.sinVerificar.length === 0) {
    imprimir('  OK: todos los candidatos estan en la allowlist verificada.');
    imprimir('');
    process.exit(0);
  }
  imprimir('');
  imprimir(`  ${r.sinVerificar.length} candidato(s) SIN VERIFICAR (no estan en la allowlist)`);
  imprimir('');
  for (const h of r.sinVerificar) {
    imprimir(`    ${h.archivo}:${h.linea}  [${h.detector}]  forma=${h.forma}`);
  }
  imprimir('');
  imprimir('  CI no puede cruzarlos contra el material real porque privado/ no existe aca.');
  imprimir('  Corre `pnpm barrido --aceptar` en la maquina que tiene privado/ y commitea la allowlist.');
  imprimir('');
  process.exit(1);
}
