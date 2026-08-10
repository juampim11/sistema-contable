/**
 * EL CONTRATO DE UN ADAPTADOR DE BANCO.
 *
 * Un adaptador es lo **único** específico de cada banco. Todo lo demás —parseo de importes, hash de fila,
 * verificación aritmética, resolución de cuenta, persistencia— es genérico y ya está escrito. Ocho bancos
 * van a ser ocho adaptadores chicos, no ocho pipelines.
 *
 * ## Las tres reglas del contrato, y por qué cada una
 *
 * ### 1. Un adaptador NO se autocertifica
 *
 * Devuelve lo que leyó y **nada más**. No decide si el extracto "cuadra": eso lo calcula
 * `verificarAritmetica()`, que es una función pura que no conoce al adaptador. Un adaptador que se
 * verificara a sí mismo estaría afirmando que leyó bien con la misma lógica con la que leyó — y un error de
 * lectura se vería como un extracto correcto.
 *
 * ### 2. Un adaptador DECLARA sus capacidades
 *
 * `CapacidadesAdaptador` dice qué publica el banco: si trae saldo por fila, si trae totales, si trae el
 * signo. Sin esa declaración, **"el banco no publica el signo" y "el adaptador está roto" son
 * indistinguibles** — y el segundo se esconde detrás del primero para siempre. Con la declaración, la
 * verificación sabe qué chequeos puede correr y cuáles tiene que reportar como `no_verificable`, que es un
 * resultado distinto de `cuadra`.
 *
 * ### 3. Un adaptador nunca descarta una línea en silencio
 *
 * Toda línea que no interpretó va a `lineasNoInterpretadas`, con su **forma** (`formaParaLog`) y **nunca su
 * texto**. Es la diferencia entre "leí 324 de 326 filas y te digo cuáles dos no entendí" y "leí 324 filas",
 * que es el peor modo de falla del módulo: un número plausible que nadie vuelve a mirar.
 *
 * ## Lo que un adaptador NO hace
 *
 * No clasifica contablemente, no adivina la cuenta contable, no netea, no agrupa y no propone asientos. Eso
 * es el Módulo 2, y hacerlo acá mezclaría "lo que dice el documento" con "lo que interpretamos", que es
 * justo la distinción que permite reprocesar un lote cuando se descubre que una regla estaba mal.
 */

/**
 * ## Nota sobre el tipo `Adaptador`
 *
 * La primera versión de este archivo declaraba `Adaptador`, `EntradaAdaptador` y `SalidaAdaptador` con el
 * texto y las líneas del PDF como entrada. El primer banco real lo refutó: la vista que hace falta es la
 * **geométrica** (ver `galicia.ts`), y mantener dos declaraciones del mismo tipo —una teórica y una real—
 * es cómo se termina con dos contratos que divergen.
 *
 * Así que **el tipo vive en `registro.ts`**, que es donde se usa, y este archivo conserva lo que no cambió:
 * las tres reglas de arriba y el error con código.
 */

/**
 * Error del adaptador con **código**, no con mensaje libre.
 *
 * Un mensaje armado con el contenido del archivo —"no pude parsear la línea `TRANSFERENCIA A JUAN PEREZ
 * 20-12345678-9`"— filtra el dato al log, al stderr y al historial de la terminal. El código alcanza para
 * saber qué pasó, y la forma de la línea para saber dónde.
 */
export type CodigoErrorAdaptador =
  | 'sin_texto'
  | 'caratula_no_reconocida'
  | 'sin_movimientos'
  | 'layout_inesperado'
  | 'periodo_no_reconocido';

export class ErrorDeAdaptador extends Error {
  // Declaradas y asignadas a mano, no como parameter properties: el type-stripping de Node no las
  // soporta y este repo corre sin paso de build. `tsc` las acepta, así que el error solo aparece al
  // ejecutar.
  readonly codigo: CodigoErrorAdaptador;
  /** Forma de la línea que falló, si aplica. NUNCA su texto. */
  readonly formaDeLaLinea: string | undefined;

  constructor(codigo: CodigoErrorAdaptador, formaDeLaLinea?: string) {
    super(`Adaptador: ${codigo}${formaDeLaLinea === undefined ? '' : ` (forma=${formaDeLaLinea})`}`);
    this.name = 'ErrorDeAdaptador';
    this.codigo = codigo;
    this.formaDeLaLinea = formaDeLaLinea;
  }
}
