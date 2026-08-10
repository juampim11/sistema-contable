/**
 * Parseo de números y fechas en formato argentino.
 *
 * Patrón reusado de `trazabilidad-obra-gas` (ADR-0000 §7): punto de miles, coma decimal, y las
 * variantes de signo que usan los bancos.
 *
 * **Nada de `parseFloat`.** Todo importe se maneja como **centavos en `bigint`** y se expone como
 * `string` decimal (ADR-0000 §2.3). Sumar unos cientos de movimientos en punto flotante ya corre el
 * último centavo.
 *
 * ⚠️ TODOS LOS EJEMPLOS DE ESTE ARCHIVO SON SINTÉTICOS. La primera versión usaba importes y una glosa
 * copiados del extracto real del cliente piloto: un importe es N2 (ADR-0002 §A.1) y un comentario viaja
 * al historial de git, a los PRs, al CI y al contexto de cada agente, donde no hay redactor que lo tape.
 * Hallazgo H-A de `seguridad-datos-financieros`.
 *
 * ---
 * ## Lo que se corrigió acá, y por qué importa
 *
 * El tester midió sobre los archivos reales y encontró cinco defectos que **fallan en verde**:
 *
 * 1. **`importeACentavos` aceptaba cualquier cadena de dígitos** (rama `|\d+` del grupo entero). Sobre un
 *    solo extracto, **295 tokens que no son importes** entraban como importes válidos: CUIT de 11
 *    dígitos, CBU de 22, códigos de columna de 4, números de tarjeta de 16. Cualquier adapter que
 *    localice columnas con `esImporte()` toma un CUIT por un importe.
 * 2. **`centavosAImporte` y `importeACentavos` no eran inversas**: el canónico usa punto decimal y el
 *    parser AR solo aceptaba coma, así que el round-trip devolvía `null` **para todo valor**. Quien
 *    sumara los importes canónicos para verificar totales obtenía Σ = 0 y **una verificación que
 *    "cuadra" contra la nada**. Se agrega `importeCanonicoACentavos`.
 * 3. **`dd/mm` y `dd-mm` devolvían `null`**: dos bancos (uno con cada forma) quedaban ilegibles a nivel
 *    fecha. La firma necesita el **período**, no el año.
 * 4. **Doble signo, un solo decimal y sin cota superior**: `-4.321,00-` pasaba como negativo, `4.321,0`
 *    se rellenaba a `4.321,00` (un token truncado se vuelve un importe **creíble y equivocado**, peor
 *    que un `null`), y 17 dígitos enteros explotaban recién en el `insert`.
 * 5. **Menos tipográfico y espacio duro** no se aceptaban, y son lo que produce un extractor de PDF.
 */

// -----------------------------------------------------------------------------
// Tipos y parámetros
// -----------------------------------------------------------------------------

/** Importe canónico: string decimal con signo y exactamente 2 decimales. Ej. `'-4321.00'`. */
export type ImporteCanonico = string;

/** Período de un extracto, en ISO. Se usa para resolver fechas sin año. */
export type Periodo = { readonly desde: string; readonly hasta: string };

/**
 * Tolerancias de parseo, **por banco**.
 *
 * Es la aplicación del principio del proyecto: lo que no se puede determinar hoy no se cablea, se
 * **parametriza**. Un banco que publique importes con un solo decimal, o enteros pelados, se resuelve
 * poniendo un flag en su perfil — no tocando esta función ni relajándola para todos.
 */
export type Tolerancias = {
  /** Aceptar un entero sin coma decimal ni separador de miles (`'500'`). Default: NO. */
  readonly enteroPelado?: boolean;
  /** Aceptar un solo decimal (`'4.321,0'`) y completarlo. Default: NO. */
  readonly unSoloDecimal?: boolean;
};

const SIN_TOLERANCIAS: Tolerancias = {};

/** `numeric(18,2)` → 16 dígitos enteros como máximo. Más que eso no entra en la base. */
const MAX_DIGITOS_ENTEROS = 16;

// -----------------------------------------------------------------------------
// Normalización del token
// -----------------------------------------------------------------------------

/**
 * Deja un token numérico en la forma que el parser entiende, sin cambiar su significado.
 *
 * Los extractores de PDF producen **menos tipográfico** (U+2212), **guion largo** (U+2013) y **espacio
 * duro** (U+00A0) donde el documento tenía un menos o un espacio. Normalizarlos acá evita que cada
 * adapter lo redescubra, y evita el otro extremo: que la función principal se vuelva permisiva.
 */
export function normalizarTokenNumerico(texto: string): string {
  let t = texto
    .replace(/[−–—]/g, '-')
    .replace(/[    ]/g, ' ')
    .trim();
  // Un espacio ENTRE DÍGITOS es un separador de miles (algunos extractores lo producen donde el
  // documento tenía un punto). Se saca. No abre la puerta de los dígitos pelados: la coma decimal
  // sigue siendo obligatoria. Y no toca el espacio de `-$ 55.555`, que no está entre dígitos.
  let anterior = '';
  while (anterior !== t) {
    anterior = t;
    t = t.replace(/(\d) (\d)/g, '$1$2');
  }
  return t;
}

// -----------------------------------------------------------------------------
// Importes
// -----------------------------------------------------------------------------

const RE_IMPORTE =
  /^(?<signoAdelante>-|\()?\s*(?<entero>\d{1,3}(?:\.\d{3})+|\d+)(?:,(?<decimales>\d{1,2}))?\s*(?<signoAtras>-|\))?$/;

/**
 * Símbolos de moneda que un extracto imprime **pegados al importe**, con el signo eventualmente adelante.
 *
 * **`U$S` va primero, y el orden importa:** con `\$` primero, `U$S 1.234,56` conserva la `U` y el token
 * queda ilegible. Medido en el segundo banco del roster (`06-formato-santander.md` §11.8): los saldos de
 * la cuenta en dólares volvían `null` y la cuenta entera quedaba sin verificar.
 *
 * **Solo se acepta lo observado.** `US$` —igual de común en el país— **no** aparece en ningún archivo del
 * roster y por eso no está: agregar una variante no medida es cablear un supuesto. Cuando un banco la
 * publique, se agrega acá con su archivo de referencia.
 */
const RE_SIMBOLO_MONEDA = /^(-)?\s*(?:U\$S|\$)\s*/;

/**
 * Convierte un importe argentino a centavos. `null` si el token no es un importe.
 *
 * Acepta las cuatro notaciones de negativo observadas en los formatos reales (ejemplos sintéticos):
 *   `-4.321,00`   signo adelante        (columna de importe)
 *   `765.432,10-` signo atrás           (columna de saldo — notación contable de saldo acreedor)
 *   `-$ 55.555`   signo antes del peso  (línea de totales)
 *   `(4.321,00)`  entre paréntesis      (el "Excel" de un banco que en realidad es TSV)
 *
 * Y dos símbolos de moneda: `$` y **`U$S`** (ver `RE_SIMBOLO_MONEDA`).
 *
 * **Exige coma decimal o separador de miles.** Un token de dígitos pelados NO es un importe: es la
 * regla que impide que un CUIT, un CBU o un código de columna entren como importe. Si algún banco
 * publica enteros pelados, se habilita **en su perfil** con `enteroPelado`, no acá.
 */
export function importeACentavos(texto: string, tolerancias: Tolerancias = SIN_TOLERANCIAS): bigint | null {
  const limpio = normalizarTokenNumerico(texto).replace(/\s+/g, ' ');
  if (!limpio) return null;

  // `-$ 1.234,56`: el signo puede venir antes del símbolo de moneda.
  const sinMoneda = limpio.replace(RE_SIMBOLO_MONEDA, (_m, signo: string | undefined) =>
    signo ? '-' : '',
  );

  const m = RE_IMPORTE.exec(sinMoneda);
  if (!m?.groups) return null;

  const { signoAdelante, entero, decimales, signoAtras } = m.groups as Record<
    string,
    string | undefined
  >;
  if (entero === undefined) return null;

  // (1) Doble signo = dato roto, no un negativo. Pasa cuando la separación de columnas migra el `-`
  //     del importe al saldo o al revés: importe y saldo son tokens vecinos.
  const tieneSignoAdelante = signoAdelante === '-';
  const tieneSignoAtras = signoAtras === '-';
  if (tieneSignoAdelante && tieneSignoAtras) return null;

  // (2) Los paréntesis van de a pares. Uno solo es un dato partido.
  const abre = signoAdelante === '(';
  const cierra = signoAtras === ')';
  if (abre !== cierra) return null;
  if (abre && (tieneSignoAdelante || tieneSignoAtras)) return null;

  const tieneSeparadorMiles = entero.includes('.');
  const tieneDecimales = decimales !== undefined;

  // (3) LA REGLA QUE CIERRA LA PUERTA: sin coma decimal y sin separador de miles, no es un importe.
  if (!tieneDecimales && !tieneSeparadorMiles && !tolerancias.enteroPelado) return null;

  // (4) Un solo decimal es un token truncado. Rellenarlo produce un importe creíble y equivocado.
  if (tieneDecimales && decimales.length === 1 && !tolerancias.unSoloDecimal) return null;

  const enteroLimpio = entero.replace(/\./g, '');

  // (5) Cota superior: `numeric(18,2)`. Fallar acá y no en el `insert` al final de un job de 45 páginas.
  if (enteroLimpio.replace(/^0+/, '').length > MAX_DIGITOS_ENTEROS) return null;

  const centavos = BigInt(enteroLimpio) * 100n + BigInt((decimales ?? '').padEnd(2, '0'));
  const negativo = tieneSignoAdelante || tieneSignoAtras || abre;
  return negativo ? -centavos : centavos;
}

/**
 * ¿Este token es un importe argentino bien formado?
 *
 * ⚠️ **NO SIRVE PARA CLASIFICAR NI PARA LOCALIZAR COLUMNAS.** Responde "tiene forma de importe", no
 * "es el importe de esta fila". La celda se asigna **por posición** (columna anclada en el encabezado,
 * u offset de carácter en la familia de ancho fijo) y esta función valida el contenido **después**.
 * Usarla al revés es cómo un código de columna o un número de tarjeta termina siendo un importe.
 */
export function esImporte(texto: string, tolerancias: Tolerancias = SIN_TOLERANCIAS): boolean {
  return importeACentavos(texto, tolerancias) !== null;
}

/** Centavos → string decimal canónico con 2 decimales y signo. */
export function centavosAImporte(centavos: bigint): ImporteCanonico {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  return `${negativo ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/**
 * Canónico → centavos. **La inversa exacta de `centavosAImporte`.**
 *
 * Existe porque no existía, y su ausencia era una trampa: el canónico usa **punto** decimal y
 * `importeACentavos` espera **coma**, así que quien intentara sumar importes canónicos con el parser AR
 * obtenía `null` en todos y una Σ de 0 — con una verificación que "cuadra" contra la nada.
 */
export function importeCanonicoACentavos(canonico: ImporteCanonico): bigint | null {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(canonico.trim());
  if (!m) return null;
  const [, signo, entero, decimales] = m;
  if (entero === undefined || decimales === undefined) return null;
  if (entero.replace(/^0+/, '').length > MAX_DIGITOS_ENTEROS) return null;
  const centavos = BigInt(entero) * 100n + BigInt(decimales);
  return signo === '-' ? -centavos : centavos;
}

export function parsearImporte(
  texto: string,
  tolerancias: Tolerancias = SIN_TOLERANCIAS,
): ImporteCanonico | null {
  const c = importeACentavos(texto, tolerancias);
  return c === null ? null : centavosAImporte(c);
}

/** Suma en centavos. Se expone para que nadie sume canónicos con aritmética de strings ni de floats. */
export function sumarImportes(canonicos: readonly ImporteCanonico[]): ImporteCanonico | null {
  let total = 0n;
  for (const c of canonicos) {
    const v = importeCanonicoACentavos(c);
    if (v === null) return null;
    total += v;
  }
  return centavosAImporte(total);
}

// -----------------------------------------------------------------------------
// Fechas
// -----------------------------------------------------------------------------

const RE_FECHA = /^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2}|\d{4}))?$/;

function esFechaValida(anio: number, mes: number, dia: number): boolean {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return false;
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  return f.getUTCFullYear() === anio && f.getUTCMonth() === mes - 1 && f.getUTCDate() === dia;
}

function aIso(anio: number, mes: number, dia: number): string {
  return `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * Fecha argentina a ISO (`aaaa-mm-dd`). `null` si no es una fecha válida.
 *
 * Acepta `dd/mm/aaaa`, `dd/mm/aa`, y **`dd/mm` o `dd-mm` sin año** — que es como las publican dos de los
 * bancos del roster. Sin año, el año **se resuelve contra el período del extracto**, nunca se adivina:
 *
 *   - Si la fecha cae dentro del período con el año del `desde`, ése es el año.
 *   - Si no, se prueba con el año del `hasta` (el caso del período que cruza el fin de año).
 *   - Si no cae en ninguno, devuelve `null`. **No adivina**: una fecha que no pertenece al período es
 *     una línea de otro bloque mal capturada, y devolver una fecha plausible la esconde.
 */
export function parsearFecha(texto: string, periodo?: Periodo): string | null {
  const m = RE_FECHA.exec(normalizarTokenNumerico(texto));
  if (!m) return null;

  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const anioCrudo = m[3];

  // --- Con año explícito ---
  if (anioCrudo !== undefined) {
    let anio = Number(anioCrudo);
    if (anioCrudo.length === 2) {
      // Siglo por cercanía al período; sin período, 20xx (correcto para todo extracto que este
      // sistema va a ver, y el supuesto queda explícito en vez de escondido).
      const referencia = periodo ? Number(periodo.hasta.slice(0, 4)) : 2000 + anio;
      const siglo = Math.floor(referencia / 100) * 100;
      anio = siglo + anio;
      if (anio - referencia > 50) anio -= 100;
      if (referencia - anio > 50) anio += 100;
    }
    return esFechaValida(anio, mes, dia) ? aIso(anio, mes, dia) : null;
  }

  // --- Sin año: se resuelve contra el período ---
  if (!periodo) return null;

  const anioDesde = Number(periodo.desde.slice(0, 4));
  const anioHasta = Number(periodo.hasta.slice(0, 4));

  for (const anio of anioDesde === anioHasta ? [anioDesde] : [anioDesde, anioHasta]) {
    if (!esFechaValida(anio, mes, dia)) continue;
    const iso = aIso(anio, mes, dia);
    if (iso >= periodo.desde && iso <= periodo.hasta) return iso;
  }
  return null;
}

/** ¿Esta fecha ISO cae dentro del período? Invariante V7, expuesta para que no se reimplemente. */
export function dentroDelPeriodo(fechaIso: string, periodo: Periodo): boolean {
  return fechaIso >= periodo.desde && fechaIso <= periodo.hasta;
}

// -----------------------------------------------------------------------------
// Texto
// -----------------------------------------------------------------------------

/**
 * Normaliza texto para comparar: sin acentos, sin espacios repetidos, mayúsculas.
 *
 * Se usa para el `fila_hash` y para el cruce PDF↔Excel. **Conserva el marcador de reemplazo de
 * encoding (`�`)** en vez de borrarlo: el "Excel" de un banco es un TSV en Latin-1 y confundir un
 * carácter roto con una letra hace que dos filas distintas parezcan la misma.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** ¿El texto trae marcadores de reemplazo de encoding? Señal de que se leyó con la codificación errónea. */
export function tieneEncodingRoto(texto: string): boolean {
  return texto.includes('�');
}
