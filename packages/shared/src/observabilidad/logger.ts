/**
 * LOGGER ÚNICO — ADR-0002 §D y reglas R26/R27/R28.
 *
 * Tres capas de defensa, en orden de cuándo actúan:
 *
 *   1. **Compilación (R27):** el tipo `CamposLoggeables` RECHAZA las claves de nivel ≥ N2, derivadas
 *      del registro de clasificación. `logger.info('x', { material_cifrado: v })` no compila.
 *   2. **Runtime:** todo lo que se emite pasa por el redactor, que tapa lo que llegó por texto libre
 *      (el `detail` del driver de Postgres, un mensaje de error con un CBU adentro).
 *   3. **Test (INV-8):** se corren los caminos reales y se verifica que ningún valor del fixture
 *      sensible aparezca en la salida — y que sí aparezcan `request_id`, `cliente_id` y el código de
 *      error, para que el test no se pase "no logueando nada".
 *
 * `console.*` está prohibido en el resto del repo (R26): este archivo es el único que lo usa.
 */

import { redactar } from '../seguridad/redactar.ts';
import type { ClaveSensible } from '../seguridad/clasificacion-campos.ts';

export const NIVELES_LOG = ['debug', 'info', 'warn', 'error'] as const;
export type NivelLog = (typeof NIVELES_LOG)[number];

/** Lo único que se puede poner como valor: nada de objetos de dominio enteros. */
export type ValorLoggeable = string | number | boolean | null | undefined | readonly string[];

/**
 * Claves prohibidas en un log. **Una sola fuente, derivada — nunca una lista escrita acá.**
 *
 * `ClaveSensible` sale de `clasificacion-campos.ts` y cubre las cuatro combinaciones: toda columna
 * >= N2 del registro y toda clave externa, **cada una en snake_case y en camelCase**.
 *
 * ## Por qué se borró la lista que vivía en este archivo
 *
 * Era una unión escrita a mano que **ya había divergido de su propia fuente**: ~32 claves que el
 * redactor tapa en runtime nunca estuvieron en el tipo, ni siquiera en snake_case — `credito`,
 * `debito`, `saldo_final`, `titular`, `cotizacion`, `dni`, `contraparte_nombre` y otras. Y encima
 * **toda columna multi-palabra compilaba en camelCase**, que es la grafía de los nombres reales del
 * código: `saldoFinalDeclarado`, `filaOrigen`, `cbuUltimos4`.
 *
 * El redactor las tapaba en runtime, o sea que no hubo fuga. Lo que no valía era **R27** —*"el logger
 * no compila si le pasás una clave >= N2"*—, que es la **defensa**; el redactor es la **red**.
 *
 * Lo encontró la auditoría de `security-engineer` sobre el Módulo 1. Derivar en vez de mantener dos
 * listas es la lección que este repo ya aplicó tres veces con los enums del dominio contra sus `check`.
 */
export type ClaveProhibida = ClaveSensible;

/**
 * El truco del `never`: cualquier clave prohibida solo admite el tipo `never`, así que pasarla con un
 * valor real es un error de compilación. Las demás claves aceptan un `ValorLoggeable`.
 *
 * Nótese que un objeto de dominio completo tampoco entra: `ValorLoggeable` no incluye objetos.
 */
export type CamposLoggeables = {
  readonly [K in ClaveProhibida]?: never;
} & {
  readonly [clave: string]: ValorLoggeable | undefined;
};

export type Emisor = (linea: string) => void;

let emisor: Emisor = (linea) => {
  // El único console.* del repo (R26).
  // eslint-disable-next-line no-console
  console.log(linea);
};

/** Para los tests (INV-8): capturar la salida sin escribir a stdout. */
export function configurarEmisor(nuevo: Emisor): Emisor {
  const anterior = emisor;
  emisor = nuevo;
  return anterior;
}

function nivelMinimo(): NivelLog {
  const v = process.env['LOG_LEVEL'];
  return (NIVELES_LOG as readonly string[]).includes(v ?? '') ? (v as NivelLog) : 'info';
}

const ORDEN: Record<NivelLog, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function formatearValor(valor: unknown): string {
  const redactado = redactar(valor);
  if (typeof redactado === 'string') {
    return /[\s"=]/.test(redactado) ? JSON.stringify(redactado) : redactado;
  }
  if (Array.isArray(redactado)) return `[${redactado.join(',')}]`;
  return JSON.stringify(redactado);
}

function emitir(nivel: NivelLog, evento: string, campos: CamposLoggeables = {}): void {
  if (ORDEN[nivel] < ORDEN[nivelMinimo()]) return;

  const partes: string[] = [nivel.toUpperCase(), evento];
  for (const [clave, valor] of Object.entries(campos)) {
    if (valor === undefined) continue;
    partes.push(`${clave}=${formatearValor(valor)}`);
  }
  emisor(partes.join(' '));
}

/**
 * El nombre del evento es un identificador con punto (`ingesta.finalizada`), no una frase: una frase
 * invita a meterle el dato adentro ("no se pudo imputar tanto a tal proveedor").
 */
export const logger = {
  debug: (evento: string, campos?: CamposLoggeables) => emitir('debug', evento, campos),
  info: (evento: string, campos?: CamposLoggeables) => emitir('info', evento, campos),
  warn: (evento: string, campos?: CamposLoggeables) => emitir('warn', evento, campos),
  /**
   * Un error se loguea por su CÓDIGO, no por su excepción. Si hay que pasar el error, se pasa por
   * `causa` y el redactor lo reduce a nombre + mensaje redactado (sin stack, sin `detail` del driver).
   */
  error: (evento: string, campos?: CamposLoggeables & { readonly codigo?: string }, causa?: unknown) => {
    if (causa === undefined) {
      emitir('error', evento, campos);
      return;
    }
    const reducido = redactar(causa) as { nombre?: string; mensaje?: string };
    emitir('error', evento, {
      ...campos,
      causa_tipo: reducido.nombre ?? typeof causa,
      causa_mensaje: reducido.mensaje ?? '[SIN_MENSAJE]',
    });
  },
} as const;

/**
 * LOGGER ACOTADO — allowlist cerrada, verificada en compilación.
 *
 * ## Por qué existe, además del blocklist
 *
 * `CamposLoggeables` es un **blocklist**: prohíbe las claves que conocemos. Y un blocklist de nombres
 * **pierde siempre contra el próximo campo**: `saldo` estaba prohibido y `saldoFinal` no; `importe`
 * estaba y `credito`/`debito` no. El agujero no fue un descuido puntual, es la forma del mecanismo.
 *
 * Un logger acotado invierte la lógica: se declara la **unión cerrada de campos permitidos** para una
 * familia de eventos, y **cualquier otra clave no compila**. Un campo nuevo no entra por olvido: entra
 * cuando alguien lo agrega al tipo, que es el momento en que se piensa su nivel.
 *
 * ```ts
 * type CamposIngesta = 'request_id' | 'lote_id' | 'cliente_id' | 'pagina' | 'movimientos' | 'codigo';
 * const log = loggerAcotado<CamposIngesta>();
 * log.info('ingesta.parseada', { lote_id: '9c31', movimientos: 326 });   // ✅
 * log.info('ingesta.parseada', { saldoFinal: '…' });                     // ❌ no compila
 * ```
 *
 * Es lo que convierte las líneas de ejemplo de ADR-0002 §D en un **contrato** en vez de una sugerencia.
 */
export function loggerAcotado<Clave extends string>(): {
  debug(evento: string, campos?: Readonly<Partial<Record<Clave, ValorLoggeable>>>): void;
  info(evento: string, campos?: Readonly<Partial<Record<Clave, ValorLoggeable>>>): void;
  warn(evento: string, campos?: Readonly<Partial<Record<Clave, ValorLoggeable>>>): void;
  error(
    evento: string,
    campos?: Readonly<Partial<Record<Clave, ValorLoggeable>>>,
    causa?: unknown,
  ): void;
} {
  type Campos = Readonly<Partial<Record<Clave, ValorLoggeable>>>;
  // El cast es local y está acotado: `Campos` es un subconjunto de lo loggeable por construcción
  // (sus valores son `ValorLoggeable`), y las claves prohibidas quedan fuera de `Clave` en cada uso.
  const abrir = (c?: Campos): CamposLoggeables => (c ?? {}) as CamposLoggeables;
  return {
    debug: (evento, campos) => emitir('debug', evento, abrir(campos)),
    info: (evento, campos) => emitir('info', evento, abrir(campos)),
    warn: (evento, campos) => emitir('warn', evento, abrir(campos)),
    error: (evento, campos, causa) => logger.error(evento, abrir(campos), causa),
  };
}
