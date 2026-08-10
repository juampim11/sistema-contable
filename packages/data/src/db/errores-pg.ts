/**
 * TRADUCTOR DE ERRORES DE POSTGRES — R28.
 *
 * ## El agujero, concreto
 *
 * Cuando se viola un `check` o un `not null`, Postgres agrega al error:
 *
 *     DETAIL: Failing row contains (7ab4…, 2026-06-15, TRANSFERENCIA A <razón social>, -4321.00, …)
 *
 * **La fila entera.** En `movimiento_bancario_crudo` eso es la fecha, la glosa con el nombre de la
 * contraparte, el importe y el saldo: N2 completo. Y los disparadores son mundanos, no exóticos — una
 * moneda que el adaptador no normalizó, un `fila_numero` en cero, un `numeric(18,2)` desbordado porque el
 * parser pegó dos columnas.
 *
 * El escenario de daño es el más probable de todos: la primera corrida contra un PDF real falla en la fila
 * 143, el error sube sin capturar, y alguien —razonablemente, para pedir ayuda— pega el stderr en un issue
 * o en un chat. Ahí viajó la fila de un extracto real.
 *
 * ## Por qué no alcanza con el redactor
 *
 * Dos razones. La primera: el redactor **no puede tapar una razón social**, que es texto sin patrón
 * (ADR-0002 §C.0.bis). La segunda es más fina: la forma canónica de un `numeric` de Postgres es
 * `1482350.00` —punto decimal, sin separador de miles— y el detector `importe_ar` busca el formato
 * **local** (`1.482.350,00`). Un importe que sale por el camino del driver **pasa el redactor limpio**.
 *
 * El redactor es la red, no la defensa. La defensa es no dejar salir el `detail`.
 *
 * ## Qué hace este módulo
 *
 * Construye un `Error` **nuevo** con solo `{ codigo, constraint, tabla, filaNumero }`, y **descarta**
 * `detail`, `where`, `hint`, `schema`, `column`, `table` y `parameters`. Nunca re-lanza el error del
 * driver: re-lanzarlo es exactamente el bug.
 */

/** Códigos de error propios, estables, para que el llamador decida sin parsear un mensaje. */
export const CODIGOS_ERROR_PG = [
  'ING_DUPLICADO',
  'ING_CHECK',
  'ING_NOT_NULL',
  'ING_FK',
  'ING_RLS',
  'ING_DESBORDE_NUMERICO',
  'ING_OTRO',
] as const;
export type CodigoErrorPg = (typeof CODIGOS_ERROR_PG)[number];

/**
 * Error de base **sin datos**. Lo único que sale es el código, el nombre de la constraint y —si el
 * llamador lo sabe— el número de fila.
 *
 * El nombre de la constraint es seguro y es lo más útil que hay: `mov_crudo_moneda_chk` dice exactamente
 * qué se violó, sin decir con qué valor.
 */
export class ErrorDeBase extends Error {
  // Campos declarados y asignados a mano, NO como parameter properties del constructor: el
  // type-stripping de Node (que es cómo corre este repo, sin paso de build) no las soporta y falla con
  // `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. El typecheck de `tsc` las acepta, así que el error solo aparece
  // al ejecutar — y aparece en el primer script que importe este módulo.
  readonly codigo: CodigoErrorPg;
  readonly constraint: string | undefined;
  readonly filaNumero: number | undefined;

  constructor(codigo: CodigoErrorPg, constraint?: string, filaNumero?: number) {
    super(
      `${codigo}${constraint === undefined ? '' : ` (${constraint})`}` +
        `${filaNumero === undefined ? '' : ` en la fila ${filaNumero}`}`,
    );
    this.name = 'ErrorDeBase';
    this.codigo = codigo;
    this.constraint = constraint;
    this.filaNumero = filaNumero;
  }
}

/** Los `SQLSTATE` que importan. El resto cae en `ING_OTRO`, que también es seguro. */
const POR_SQLSTATE: Readonly<Record<string, CodigoErrorPg>> = {
  '23505': 'ING_DUPLICADO', // unique_violation
  '23514': 'ING_CHECK', // check_violation
  '23502': 'ING_NOT_NULL', // not_null_violation
  '23503': 'ING_FK', // foreign_key_violation
  '42501': 'ING_RLS', // insufficient_privilege
  '22003': 'ING_DESBORDE_NUMERICO', // numeric_value_out_of_range
};

/**
 * Traduce cualquier error a uno sin datos.
 *
 * Un error que **no** es de Postgres se traduce igual: si es un `Error` nuestro con código, se conserva;
 * si es cualquier otra cosa, se reduce a `ING_OTRO`. La regla es que de esta función **nunca** sale un
 * mensaje que el llamador no armó.
 */
export function traducirErrorDeBase(error: unknown, filaNumero?: number): ErrorDeBase {
  // Un `ErrorDeBase` ya está traducido: se devuelve tal cual para no perder el número de fila original.
  if (error instanceof ErrorDeBase) return error;

  const e = error as { code?: unknown; constraint?: unknown } | null;
  const sqlstate = typeof e?.code === 'string' ? e.code : '';
  const constraint = typeof e?.constraint === 'string' ? e.constraint : undefined;

  return new ErrorDeBase(POR_SQLSTATE[sqlstate] ?? 'ING_OTRO', constraint, filaNumero);
}

/**
 * Envuelve una operación de base y traduce lo que lance.
 *
 * Se usa alrededor de **cada** insert de la ingesta, con su número de fila: sin él, un `insert` de 326
 * filas que falla no dice cuál, y la única salida es volver al archivo — que es justo lo que no se quiere
 * hacer con el extracto de un cliente.
 */
export async function conErroresTraducidos<T>(
  filaNumero: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw traducirErrorDeBase(error, filaNumero);
  }
}
