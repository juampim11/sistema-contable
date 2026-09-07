/**
 * MUTACIONES de `0039_origen_evidencia_patron_contraparte.sql` — prueba por mutación del invariante
 * NUEVO de esta migración (CLAUDE.md §1.8, ADR-0002 §B.0): `contrapartida_patron_origen_coherencia_chk`,
 * la equivalencia `(patron_contraparte_estado in (match, multiples_patrones)) = (patron_contraparte_origen
 * is not null)`. Las DOS direcciones de la equivalencia, cada una con su propia mutación (relajar el
 * check, EN VIVO, confirmar que la fila indebida entra; restaurar, confirmar que se rechaza), más los
 * 4 casos legítimos (una fila por cada combinación válida de `(estado, origen)`).
 *
 *   A. estado match/multiples_patrones CON origen NULL (evidencia sin vía declarada) ... 1 mutación
 *   B. estado no_aplica/sin_match CON origen puesto (atribución sin nada que atribuir) .. 1 mutación
 *   C. legítimo: las 4 combinaciones válidas entran, cada una bajo su propia contrapartida
 *                                                                              ─────────────────────
 *                                                                              2 mutaciones, 4 legítimos
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, con `0039` APLICADA.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

type Fila = Record<string, unknown>;
type Ejecutar = (sql: string, params?: readonly unknown[]) => Promise<Fila[]>;

const desdeTx =
  (tx: Tx): Ejecutar =>
  (sql, params) =>
    tx.consultar<Fila>(sql, params);
const desdeCliente =
  (c: Client): Ejecutar =>
  async (sql, params) =>
    (await c.query<Fila>(sql, (params ?? []) as unknown[])).rows;

async function una(ej: Ejecutar, sql: string, params?: readonly unknown[]): Promise<Fila> {
  const filas = await ej(sql, params);
  const fila = filas[0];
  if (!fila) throw new Error(`La consulta no devolvió fila: ${sql.slice(0, 80)}`);
  return fila;
}

type ErrorPg = { readonly code: string; readonly constraint: string | null; readonly message: string };
const SIN_ERROR: ErrorPg = { code: '', constraint: null, message: '(no falló)' };

async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return SIN_ERROR;
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string };
    return { code: err.code ?? '', constraint: err.constraint ?? null, message: err.message ?? '' };
  }
}

function esperarRechazo(actual: ErrorPg, code: string, constraint: string, porque: string): void {
  expect({ code: actual.code, constraint: actual.constraint }, porque).toEqual({ code, constraint });
}

/** `USUARIOS.socio` tiene membresía en A — mismo criterio que `mutaciones-0038.test.ts`. */
function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

// -----------------------------------------------------------------------------
// El laboratorio de mutación de DDL — mismo mecanismo que `mutaciones-0038.test.ts`: transacción del
// dueño, SIEMPRE rollbackeada, con verificación de que el rollback restauró la definición original.
// -----------------------------------------------------------------------------
async function conDuenio<T>(fn: (ej: Ejecutar, crudo: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de mutación de DDL corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  const duenio = await clienteDuenio();
  const ej = desdeCliente(duenio);
  const crudo = (sql: string): Promise<unknown> => duenio.query(sql);
  try {
    await duenio.query('begin');
    await duenio.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);
    return await fn(ej, crudo);
  } finally {
    try {
      await duenio.query('rollback');
    } finally {
      await duenio.end();
    }
  }
}

async function definicionDe(ej: Ejecutar, constraint: string): Promise<string> {
  const f = await una(
    ej,
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`,
    [constraint],
  );
  return String(f['def']);
}

async function conDdlMutado<T>(
  constraint: string,
  ddl: readonly string[],
  fn: (ej: Ejecutar, crudo: (sql: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  return conDuenio(async (ej, crudo) => {
    const antes = await definicionDe(ej, constraint);
    for (const sentencia of ddl) await crudo(sentencia);
    try {
      return await fn(ej, crudo);
    } finally {
      await crudo('rollback');
      const despues = await definicionDe(ej, constraint);
      expect(despues, 'el rollback del DDL mutado NO restauró el esquema').toEqual(antes);
    }
  });
}

// -----------------------------------------------------------------------------
// Fixtures — mismo idiom que `mutaciones-0038.test.ts`: un movimiento + un reconocimiento_movimiento
// por caso, con `patron_contraparte_origen` sumado al INSERT.
// -----------------------------------------------------------------------------

const BANCO = 'banco_0039';

type Cuenta = { readonly clienteId: string; readonly cuentaId: string; readonly loteId: string };

let filaSeq = 0;
async function crearMovimiento(ej: Ejecutar, cuenta: Cuenta): Promise<{ readonly id: string; readonly entradaDigest: string }> {
  filaSeq += 1;
  const f = await una(
    ej,
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, saldo, concepto_banco, concepto_completo, concepto_banco_estrategia, contraparte_captura)
     values ($1, $2, $3, $4, $5, '2026-06-15'::date, 'GLOSA 0039', -100.00, 900.00, 'CONCEPTO', true,
             'columna_propia', 'capturado')
     returning id::text as id, entrada_digest`,
    [cuenta.clienteId, cuenta.loteId, cuenta.cuentaId, filaSeq, randomUUID()],
  );
  return { id: String(f['id']), entradaDigest: String(f['entrada_digest']) };
}

let digestSeq = 0;
function motorDigestSintetico(): string {
  digestSeq += 1;
  return digestSeq.toString(16).padStart(16, '0');
}

async function crearReconocimiento(ej: Ejecutar, cuenta: Cuenta): Promise<{ readonly id: string }> {
  const mov = await crearMovimiento(ej, cuenta);
  const digest = motorDigestSintetico();
  const f = await una(
    ej,
    `insert into reconocimiento_movimiento
       (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
        lado, via, que_decide, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados,
        evidencia_hubo_cola)
     values ($1, $2, $3, $4, 'decision_humana', 'pago_a_proveedor_transferencia',
             'pago_con_transferencia_generico', 'normal', 'debe', 'texto_literal_exacto',
             'distinguir_tercero_de_socio', 'galicia.pago_con_transferencia_generico', 12, false)
     returning id::text as id`,
    [cuenta.clienteId, mov.id, digest, mov.entradaDigest],
  );
  return { id: String(f['id']) };
}

const INSERT_CONTRAPARTIDA_CON_ORIGEN = `insert into reconocimiento_contrapartida
    (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase, resuelto_a_fecha,
     patron_contraparte_estado, patron_contraparte_origen)
  values ($1, $2, $3, 'decision_humana', '2026-06-15'::date, $4, $5)
  returning id::text as id`;

async function crearContrapartida(
  ej: Ejecutar,
  cuenta: Cuenta,
  patronContraparteEstado: string,
  patronContraparteOrigen: string | null,
): Promise<string> {
  const padre = await crearReconocimiento(ej, cuenta);
  const f = await una(ej, INSERT_CONTRAPARTIDA_CON_ORIGEN, [
    cuenta.clienteId,
    padre.id,
    'sin_candidatos',
    patronContraparteEstado,
    patronContraparteOrigen,
  ]);
  const id = f['id'];
  if (!id) throw new Error('no se creó la contrapartida');
  return String(id);
}

// -----------------------------------------------------------------------------
// Setup — un cliente sintético, una cuenta, un lote.
// -----------------------------------------------------------------------------

let s: Sembrado;
let cuenta: Cuenta;

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ($1, 'BANCO 0039', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const c = await una(
      ej,
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
       values ($1, $2, 'ARS', '0039 A') returning id::text as id`,
      [s.clienteA, BANCO],
    );
    const lote = await una(
      ej,
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
       values ($1, $2, 'prueba-0039', 'archivo', 'hash_0039', 'recibido', 0)
       returning id::text as id`,
      [s.clienteA, BANCO],
    );
    await ej(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
          verificacion_estado)
       values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
      [s.clienteA, String(lote['id']), String(c['id'])],
    );
    cuenta = { clienteId: s.clienteA, cuentaId: String(c['id']), loteId: String(lote['id']) };
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

// =============================================================================
// A — estado match/multiples_patrones CON origen NULL (1 mutación)
// =============================================================================
describe('0039 A — origen NULL bajo un estado que exige atribución', () => {
  it(
    'M-A1 🔴 EN VIVO: con el check de coherencia relajado, `match` + `origen NULL` ENTRA — se agrega ' +
      'la forma vulnerable, se confirma que la fila entra, se restaura la definición real al salir',
    async () => {
      const entro = await conDdlMutado(
        'contrapartida_patron_origen_coherencia_chk',
        [
          'alter table reconocimiento_contrapartida drop constraint contrapartida_patron_origen_coherencia_chk',
          'alter table reconocimiento_contrapartida add constraint contrapartida_patron_origen_coherencia_chk check (true)',
        ],
        async (ej) => {
          await ej(`select set_config('app.user_id', '${USUARIOS.socio}', true)`);
          const id = await crearContrapartida(ej, cuenta, 'match', null);
          return Boolean(id);
        },
      );
      expect(entro, 'el check relajado dejó pasar match con origen NULL — evidencia sin vía declarada').toBe(true);
    },
  );

  it('M-A1b 🔴 con el CHECK real, el mismo intento de arriba se rechaza', async () => {
    const error = await capturar(() => comoSocio((ej) => crearContrapartida(ej, cuenta, 'match', null)));
    esperarRechazo(
      error,
      '23514',
      'contrapartida_patron_origen_coherencia_chk',
      'match con origen NULL tiene que morir por el check de coherencia',
    );
  });
});

// =============================================================================
// B — estado no_aplica/sin_match CON origen puesto (1 mutación)
// =============================================================================
describe('0039 B — origen puesto bajo un estado que no tiene nada que atribuir', () => {
  it(
    'M-B1 🔴 EN VIVO: con el check de coherencia relajado, `sin_match` + `origen` puesto ENTRA',
    async () => {
      const entro = await conDdlMutado(
        'contrapartida_patron_origen_coherencia_chk',
        [
          'alter table reconocimiento_contrapartida drop constraint contrapartida_patron_origen_coherencia_chk',
          'alter table reconocimiento_contrapartida add constraint contrapartida_patron_origen_coherencia_chk check (true)',
        ],
        async (ej) => {
          await ej(`select set_config('app.user_id', '${USUARIOS.socio}', true)`);
          const id = await crearContrapartida(ej, cuenta, 'sin_match', 'concepto_banco');
          return Boolean(id);
        },
      );
      expect(entro, 'el check relajado dejó pasar sin_match con origen puesto — atribución sin nada que atribuir').toBe(true);
    },
  );

  it('M-B1b 🔴 con el CHECK real, el mismo intento de arriba se rechaza', async () => {
    const error = await capturar(() =>
      comoSocio((ej) => crearContrapartida(ej, cuenta, 'sin_match', 'concepto_banco')),
    );
    esperarRechazo(
      error,
      '23514',
      'contrapartida_patron_origen_coherencia_chk',
      'sin_match con origen puesto tiene que morir por el check de coherencia',
    );
  });
});

// =============================================================================
// C — legítimo: las 4 combinaciones válidas
// =============================================================================
describe('0039 C — legítimo: las 4 combinaciones válidas entran', () => {
  it('no_aplica + origen NULL', async () => {
    await comoSocio(async (ej) => {
      const id = await crearContrapartida(ej, cuenta, 'no_aplica', null);
      expect(id).toBeTruthy();
    });
  });

  it('sin_match + origen NULL', async () => {
    await comoSocio(async (ej) => {
      const id = await crearContrapartida(ej, cuenta, 'sin_match', null);
      expect(id).toBeTruthy();
    });
  });

  it('match + origen concepto_banco', async () => {
    await comoSocio(async (ej) => {
      const id = await crearContrapartida(ej, cuenta, 'match', 'concepto_banco');
      expect(id).toBeTruthy();
    });
  });

  it('multiples_patrones + origen descripcion', async () => {
    await comoSocio(async (ej) => {
      const id = await crearContrapartida(ej, cuenta, 'multiples_patrones', 'descripcion');
      expect(id).toBeTruthy();
    });
  });
});
