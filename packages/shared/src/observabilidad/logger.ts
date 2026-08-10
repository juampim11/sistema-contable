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
import type { ColumnaSensible } from '../seguridad/clasificacion-campos.ts';

export const NIVELES_LOG = ['debug', 'info', 'warn', 'error'] as const;
export type NivelLog = (typeof NIVELES_LOG)[number];

/** Lo único que se puede poner como valor: nada de objetos de dominio enteros. */
export type ValorLoggeable = string | number | boolean | null | undefined | readonly string[];

/**
 * Claves prohibidas en un log. Se componen de dos fuentes, y las dos se derivan, no se repiten:
 *   - `ColumnaSensible`: toda columna ≥ N2 del registro de clasificación.
 *   - la lista literal de abajo: formas en que un dato sensible llega disfrazado desde afuera
 *     (un payload, un CSV, una respuesta de webservice) sin ser una columna nuestra.
 */
type ClaveExternaProhibida =
  | 'cuit' | 'cuil' | 'cbu' | 'alias' | 'numero_cuenta' | 'nro_cuenta'
  | 'importe' | 'monto' | 'saldo' | 'descripcion' | 'glosa' | 'concepto'
  | 'razon_social' | 'domicilio' | 'password' | 'contrasena' | 'clave'
  | 'token' | 'authorization' | 'secret' | 'private_key' | 'clave_privada'
  | 'certificado' | 'dsn' | 'database_url' | 'remuneracion' | 'sueldo'
  /**
   * ⚠️ **Las variantes camelCase, y por qué hacen falta.**
   *
   * `ClaveProhibida` es una unión de **literales exactos**, y esta lista está escrita solo en snake_case —
   * que son los nombres de las **columnas**. Pero los nombres que existen en el código TypeScript son
   * camelCase, así que `logger.info('x', { conceptoBanco: … })` **compilaba**.
   *
   * El redactor lo tapa en runtime, o sea que no había fuga. Lo que se perdía es R27: *"el logger no
   * compila si le pasás una clave ≥ N2"*. R27 es la defensa; el redactor es la red — y una red sin defensa
   * es la mitad del control.
   *
   * 🔴 **Esto es un parche, no el arreglo.** Con la misma forma **también compilan** hoy `filaOrigen`,
   * `filaHash`, `saldoFinal`, `razonSocial`, `contraparteNombre`, `numeroCuenta` y `descripcionLineas`. El
   * arreglo estructural es **derivar** la variante camelCase a nivel de tipo, para que nadie mantenga dos
   * listas — que es la lección que este repo ya aplicó tres veces con los enums del dominio contra sus
   * `check`. Queda anotado en el plan como hallazgo aparte.
   */
  | 'concepto_banco' | 'conceptoBanco'
  // El saldo consolidado por moneda (N2) y el importe del anexo. Ver la nota de
  // `CLAVES_SENSIBLES_EXTERNAS`: viajan en forma canónica, que ningún detector del redactor tapa.
  | 'consolidado' | 'consolidado_por_moneda' | 'consolidadosPorMoneda'
  | 'saldo_consolidado' | 'saldoConsolidado'
  | 'importe_declarado' | 'importeDeclarado';

export type ClaveProhibida = ColumnaSensible | ClaveExternaProhibida;

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
