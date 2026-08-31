/**
 * MUTACIONES de `reconocimiento_forma_chk` (migración 0014) — los DOS huecos de cobertura que
 * `tester` encontró al verificar el fix de `via: null` hardcodeado en `aFilaPersistible`
 * (`packages/contabilidad/src/nucleo/persistible.ts`, rama `sin_reconocer`).
 *
 * `Reconocimiento['sin_reconocer']` (`packages/contabilidad/src/nucleo/reconocimiento.ts:77-82`)
 * declara `evidencia: EvidenciaDelMatch | undefined` SIN atar la presencia al `motivo` — el
 * compilador permite combinaciones que `motor.ts` hoy nunca produce mecánicamente, pero que
 * `reconocimiento_forma_chk` sí distingue por motivo (ver la tabla `EVIDENCIA_POR_MOTIVO` en
 * `packages/contabilidad/tests/forma-persistible.test.ts` y el bloque `sin_reconocer` del check en
 * esta migración). Hasta acá eso era un "debería" — este archivo lo convierte en un hecho medido:
 * se arma el `Reconocimiento` malformado A MANO (bypaseando que `motor.ts` nunca lo produce), se lo
 * pasa por `aFilaPersistible` REAL (no una reimplementación), y se hace el INSERT real de la fila
 * resultante contra Postgres.
 *
 *   Caso 1 — evidencia AUSENTE cuando el motivo la EXIGE (`concepto_sin_tipo_asignado`,
 *   `reversa_incoherente`): el check exige `num_nonnulls(via, evidencia_entrada_lexico_id,
 *   evidencia_caracteres_matcheados, evidencia_hubo_cola) = 4` para estos dos motivos.
 *
 *   Caso 2 — evidencia PRESENTE cuando el motivo la PROHÍBE (`ambiguo`, `concepto_no_catalogado`,
 *   `sin_evidencia_de_concepto`): el check exige `num_nonnulls(...) = 0` para estos tres.
 *
 * El INSERT va DIRECTO a `reconocimiento_movimiento` (no por `persistirReconocimiento`, que envuelve
 * cada consulta en `conErroresTraducidos` y traduciría el `23514` a `ErrorDeBase{codigo:'ING_CHECK'}`
 * — correcto para producción, pero acá se quiere afirmar el SQLSTATE y el nombre del constraint,
 * exactos, del mismo modo que `mutaciones-0021.test.ts`/`mutaciones-0030-*.test.ts`. El INSERT
 * necesita `entrada_digest` = el de un `movimiento_bancario_crudo` real: `trg_reconocimiento_
 * entrada_digest` (`0021`) es un `before insert` que aborta con `P0001` si no coincide, y eso
 * taparía el check que este archivo quiere medir.
 *
 * Ni un valor del material real: todo literal es sintético, mismo criterio que el resto de la
 * batería de mutaciones.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';
// Ruta relativa y no el nombre del paquete: `packages/data` NO depende de `@sistema-contable/
// contabilidad` en producción. Es el mismo camino, con el mismo motivo, que usa
// `mutaciones-0021.test.ts:105-111` para leer `digestDeEntrada`.
import {
  aFilaPersistible,
  idsDelLexico,
  marcarCapaCCorrida,
} from '../../contabilidad/src/nucleo/persistible.ts';
import { LEXICOS_POR_BANCO } from '../../contabilidad/src/lexico/registro.ts';
import type { LexicoDeBanco } from '../../contabilidad/src/nucleo/lexico.ts';
import type { EvidenciaDelMatch, Reconocimiento } from '../../contabilidad/src/nucleo/reconocimiento.ts';

const GALICIA = LEXICOS_POR_BANCO['galicia'] as LexicoDeBanco;
const VALIDOS = idsDelLexico(GALICIA);

// -----------------------------------------------------------------------------
// Andamio — mismo estilo que `mutaciones-0021.test.ts` y `mutaciones-0030-*.test.ts`.
// -----------------------------------------------------------------------------

type Fila = Record<string, unknown>;
type Ejecutar = (sql: string, params?: readonly unknown[]) => Promise<Fila[]>;

const desdeTx =
  (tx: Tx): Ejecutar =>
  (sql, params) =>
    tx.consultar<Fila>(sql, params);

async function una(ej: Ejecutar, sql: string, params?: readonly unknown[]): Promise<Fila> {
  const filas = await ej(sql, params);
  const fila = filas[0];
  if (!fila) throw new Error(`La consulta no devolvió fila: ${sql.slice(0, 80)}`);
  return fila;
}

/** Código y constraint, nunca `rejects.toThrow()` a secas — mismo criterio que el resto de la batería. */
type ErrorPg = { readonly code: string; readonly constraint: string | null; readonly message: string };
const SIN_ERROR: ErrorPg = { code: '', constraint: null, message: '(no falló)' };

async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return SIN_ERROR;
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string };
    return {
      code: err.code ?? '(sin code)',
      constraint: err.constraint ?? null,
      message: err.message ?? String(e),
    };
  }
}

function esperarRechazo(actual: ErrorPg, code: string, constraint: string, porque: string): void {
  expect({ code: actual.code, constraint: actual.constraint }, porque).toEqual({ code, constraint });
}

function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

// -----------------------------------------------------------------------------
// Escenario: un banco, una cuenta, un lote — lo mínimo para poder crear un movimiento.
// -----------------------------------------------------------------------------

const BANCO = 'banco_0014_forma_chk';

let s: Sembrado;
let cuentaBancariaId: string;
let loteIngestaId: string;

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ($1, 'BANCO 0014 FORMA CHK', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cuenta = await una(
      ej,
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
       values ($1, $2, 'ARS', '0014 forma chk') returning id::text as id`,
      [s.clienteA, BANCO],
    );
    cuentaBancariaId = String(cuenta['id']);

    const lote = await una(
      ej,
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
       values ($1, $2, 'prueba-0014-forma-chk', 'archivo', $3, 'recibido', 0)
       returning id::text as id`,
      [s.clienteA, BANCO, `hash_0014_forma_chk`],
    );
    loteIngestaId = String(lote['id']);

    await ej(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
          verificacion_estado)
       values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
      [s.clienteA, loteIngestaId, cuentaBancariaId],
    );
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

/** `fila_numero` monotónico de proceso: dos movimientos de este archivo nunca chocan entre sí. */
let filaSeq = 0;

/** Un movimiento real, para tener un `entrada_digest` con el que `trg_reconocimiento_entrada_digest` no aborte. */
async function crearMovimiento(ej: Ejecutar): Promise<{ readonly id: string; readonly entradaDigest: string }> {
  filaSeq += 1;
  const f = await una(
    ej,
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, saldo, concepto_banco, concepto_completo, concepto_banco_estrategia, concepto_codigo,
        contraparte_captura)
     values ($1, $2, $3, $4, $5, '2026-06-15'::date, 'GLOSA', -100.00::numeric, 900.00, 'CONCEPTO',
             true, 'columna_propia', null, 'capturado')
     returning id::text as id, entrada_digest`,
    [s.clienteA, loteIngestaId, cuentaBancariaId, filaSeq, randomUUID()],
  );
  return { id: String(f['id']), entradaDigest: String(f['entrada_digest']) };
}

let digestSeq = 0;
/** 16 hex, la forma que exige `reconocimiento_digest_chk`. Sintético y monotónico. */
function motorDigestSintetico(): string {
  digestSeq += 1;
  return digestSeq.toString(16).padStart(16, '0');
}

/** El INSERT real contra `reconocimiento_movimiento`, con la fila que produjo `aFilaPersistible`. */
async function insertarFila(
  ej: Ejecutar,
  mov: { readonly id: string; readonly entradaDigest: string },
  fila: ReturnType<typeof aFilaPersistible>,
): Promise<Fila[]> {
  return ej(
    `insert into reconocimiento_movimiento
       (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
        lado, via, que_decide, motivo_codigo, evidencia_entrada_lexico_id,
        evidencia_caracteres_matcheados, evidencia_hubo_cola)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning id::text as id`,
    [
      s.clienteA,
      mov.id,
      motorDigestSintetico(),
      mov.entradaDigest,
      fila.clase,
      fila.tipo,
      fila.concepto,
      fila.polaridad,
      fila.lado,
      fila.via,
      fila.queDecide,
      fila.motivoCodigo,
      fila.entradaLexicoId,
      fila.caracteresMatcheados,
      fila.huboCola,
    ],
  );
}

// =============================================================================
// Caso 1 — evidencia AUSENTE cuando el motivo la EXIGE
// =============================================================================
describe('reconocimiento_forma_chk rechaza sin_reconocer sin evidencia cuando el motivo la exige', () => {
  it.each(['concepto_sin_tipo_asignado', 'reversa_incoherente'] as const)(
    'M-1 🔴 %s con evidencia AUSENTE: aFilaPersistible produce 0 de 4, el check exige 4 — INSERT rechazado',
    async (motivo) => {
      // El tipo lo permite (`evidencia?: EvidenciaDelMatch`) aunque `motor.ts` siempre traiga
      // evidencia para estos dos motivos (`motor.ts:75` y `:90`) — este `Reconocimiento` no puede
      // salir del motor real, se arma a mano para ejercitar el hueco del tipo.
      const r: Reconocimiento = {
        clase: 'sin_reconocer',
        motivo,
        candidatos: [],
        evidencia: undefined,
      };
      const fila = aFilaPersistible(marcarCapaCCorrida(r), VALIDOS);
      // La fila que produce aFilaPersistible: las cuatro de evidencia en null. Es exactamente lo
      // que el check de 0014 rechaza para este motivo.
      expect(fila.via).toBeNull();
      expect(fila.entradaLexicoId).toBeNull();
      expect(fila.caracteresMatcheados).toBeNull();
      expect(fila.huboCola).toBeNull();

      const error = await capturar(() =>
        comoSocio(async (ej) => {
          const mov = await crearMovimiento(ej);
          return insertarFila(ej, mov, fila);
        }),
      );
      esperarRechazo(
        error,
        '23514',
        'reconocimiento_forma_chk',
        `motivo ${motivo} exige evidencia (num_nonnulls = 4) y la fila la trajo en 0 de 4 — si esto ` +
          'entrara, la cola de revisión mostraría un sin_reconocer con ese motivo y sin ninguna prueba ' +
          'de por qué',
      );
    },
  );
});

// =============================================================================
// Caso 2 — evidencia PRESENTE cuando el motivo la PROHÍBE
// =============================================================================
describe('reconocimiento_forma_chk rechaza sin_reconocer con evidencia cuando el motivo la prohíbe', () => {
  it.each(['ambiguo', 'concepto_no_catalogado', 'sin_evidencia_de_concepto'] as const)(
    'M-2 🔴 %s con evidencia PRESENTE: aFilaPersistible produce 4 de 4, el check exige 0 — INSERT rechazado',
    async (motivo) => {
      const idReal = GALICIA.entradas[0]?.id as string;
      const evidencia: EvidenciaDelMatch = {
        entradaLexicoId: idReal,
        via: 'texto_literal_exacto',
        caracteresMatcheados: 5,
        huboCola: false,
      };
      // El tipo lo permite aunque `motor.ts` nunca traiga evidencia para estos tres motivos
      // (`motor.ts:55`, `:58`, `:49`) — el fix actual de `aFilaPersistible` es agnóstico al motivo:
      // si `r.evidencia` es truthy escribe las cuatro columnas, sin mirar cuál es el motivo.
      const r: Reconocimiento = {
        clase: 'sin_reconocer',
        motivo,
        candidatos: [],
        evidencia,
      };
      const fila = aFilaPersistible(marcarCapaCCorrida(r), VALIDOS);
      expect(fila.via).not.toBeNull();
      expect(fila.entradaLexicoId).not.toBeNull();
      expect(fila.caracteresMatcheados).not.toBeNull();
      expect(fila.huboCola).not.toBeNull();

      const error = await capturar(() =>
        comoSocio(async (ej) => {
          const mov = await crearMovimiento(ej);
          return insertarFila(ej, mov, fila);
        }),
      );
      esperarRechazo(
        error,
        '23514',
        'reconocimiento_forma_chk',
        `motivo ${motivo} prohíbe evidencia (num_nonnulls = 0) y la fila la trajo completa — si esto ` +
          'entrara, la cola de revisión mostraría una prueba de match que el motor nunca produjo para ' +
          'este motivo',
      );
    },
  );
});
