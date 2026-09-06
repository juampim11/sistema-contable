/**
 * MUTACIONES de `0038_evidencia_patron_contraparte.sql` — prueba por mutación de los invariantes
 * NUEVOS de esta migración (CLAUDE.md §1.8, ADR-0002 §B.0): código/DDL defectuoso que la pone roja,
 * su caso legítimo, conteo declarado. No repite la cobertura genérica de la plantilla de siete
 * renglones (eso ya lo mide `catalogo.test.ts`/`grants-conjunto-cerrado.test.ts`); cubre lo
 * específico de esta migración — en particular, los DOS hallazgos que la convocatoria de seguridad
 * (`dba-data` + `security-engineer` + `seguridad-datos-financieros`) marcó explícitamente para cerrar
 * con prueba de mutación:
 *
 *   A. `contrapartida_patron_estado_chk` — dominio cerrado ...................... 1 mutación, 2 legítimos
 *   B. `fk_recon_contrapartida_patron_match_padre` anclando CONTRA LAS COLUMNAS
 *      DE SOCIO en vez de las DE PATRÓN (hallazgo de `seguridad-datos-financieros`,
 *      convocatoria de 0038) ................................................... 1 mutación, 1 legítimo
 *   C. `uq_recon_contrapartida_patron_match_unico` — cardinalidad de `match` .... 1 mutación, 2 legítimos
 *   D. `fk_recon_contrapartida_patron_match_patron` — FK COMPUESTA (mismo
 *      hallazgo F1 de la convocatoria de `0037`) .............................. 1 mutación, 2 legítimos
 *   E. `patron_contraparte_estado` NOT NULL sin condición — el caso que la
 *      corrección del comentario de `reconocimiento.ts` (punto 1 de esta tarea)
 *      hace posible por primera vez: `es_socio` + `no_aplica` + CERO filas ..... 1 legítimo
 *                                                                              ─────────────────────
 *                                                                              4 mutaciones, 8 legítimos
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, con `0038` APLICADA.
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
    return { code: err.code ?? '(sin code)', constraint: err.constraint ?? null, message: err.message ?? String(e) };
  }
}

/** Aserción exacta: código SQLSTATE y nombre del constraint, los dos — nunca `rejects.toThrow()` a secas. */
function esperarRechazo(actual: ErrorPg, code: string, constraint: string, porque: string): void {
  expect({ code: actual.code, constraint: actual.constraint }, porque).toEqual({ code, constraint });
}

/** `USUARIOS.socio` tiene membresía en A y en B — mismo criterio que `mutaciones-0037.test.ts`. */
function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

// -----------------------------------------------------------------------------
// El laboratorio de mutación de DDL — mismo mecanismo que `mutaciones-0021.test.ts`/`-0037.test.ts`:
// transacción del dueño, SIEMPRE rollbackeada, con verificación de que el rollback restauró la
// definición original.
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

async function definicionDe(ej: Ejecutar, conname: string): Promise<string | undefined> {
  const filas = await ej(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [conname]);
  return filas[0] ? String(filas[0]['def']) : undefined;
}

async function conDdlMutado<T>(
  constraint: string | readonly string[],
  ddl: readonly string[],
  fn: (ej: Ejecutar, crudo: (sql: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const nombres = typeof constraint === 'string' ? [constraint] : constraint;
  return conDuenio(async (ej, crudo) => {
    const antes = await Promise.all(nombres.map((n) => definicionDe(ej, n)));
    for (const sentencia of ddl) await crudo(sentencia);
    try {
      return await fn(ej, crudo);
    } finally {
      await crudo('rollback');
      const despues = await Promise.all(nombres.map((n) => definicionDe(ej, n)));
      expect(despues, 'el rollback del DDL mutado NO restauró el esquema').toEqual(antes);
    }
  });
}

// -----------------------------------------------------------------------------
// Fixtures — un movimiento + un reconocimiento_movimiento por caso (1:0..1 con la contrapartida).
// -----------------------------------------------------------------------------

const BANCO = 'banco_0038';

type Cuenta = { readonly clienteId: string; readonly cuentaId: string; readonly loteId: string };

let filaSeq = 0;
async function crearMovimiento(ej: Ejecutar, cuenta: Cuenta): Promise<{ readonly id: string; readonly entradaDigest: string }> {
  filaSeq += 1;
  const f = await una(
    ej,
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, saldo, concepto_banco, concepto_completo, concepto_banco_estrategia, contraparte_captura)
     values ($1, $2, $3, $4, $5, '2026-06-15'::date, 'GLOSA 0038', -100.00, 900.00, 'CONCEPTO', true,
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

type ClaseRecon = 'propuesta' | 'decision_humana';

/**
 * Un padre `reconocimiento_movimiento` con `queDecide: 'distinguir_tercero_de_socio'` — el único
 * `queDecide` bajo el que `reconocimiento_contrapartida` cuelga. `clase` la elige el caso: `propuesta`
 * para las ramas que promueven (`es_socio`/`es_tercero_padron_completo`), `decision_humana` para el
 * resto — mismo invariante que `contrapartida_promocion_chk`.
 */
async function crearReconocimiento(ej: Ejecutar, cuenta: Cuenta, clase: ClaseRecon): Promise<{ readonly id: string }> {
  const mov = await crearMovimiento(ej, cuenta);
  const digest = motorDigestSintetico();
  // 🔴 `reconocimiento_forma_chk` (0014): `que_decide` es NOT NULL solo bajo `decision_humana`, NULL
  // bajo `propuesta` — necesario para las contrapartidas `es_socio`/`es_tercero_padron_completo`
  // (`contrapartida_promocion_chk` exige `reconocimiento_clase = 'propuesta'` ahí).
  const queDecide = clase === 'decision_humana' ? 'distinguir_tercero_de_socio' : null;
  const f = await una(
    ej,
    `insert into reconocimiento_movimiento
       (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
        lado, via, que_decide, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados,
        evidencia_hubo_cola)
     values ($1, $2, $3, $6, $4, 'pago_a_proveedor_transferencia', 'pago_con_transferencia_generico',
             'normal', 'debe', 'texto_literal_exacto', $5,
             'galicia.pago_con_transferencia_generico', 12, false)
     returning id::text as id`,
    [cuenta.clienteId, mov.id, digest, clase, queDecide, mov.entradaDigest],
  );
  return { id: String(f['id']) };
}

const INSERT_CONTRAPARTIDA = `insert into reconocimiento_contrapartida
    (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase, resuelto_a_fecha,
     patron_contraparte_estado)
  values ($1, $2, $3, $4, '2026-06-15'::date, $5)
  returning id::text as id`;

/** Padre + contrapartida en un solo paso. `resolucionEstado`/`clase` deben respetar
 *  `contrapartida_promocion_chk`; `patronContraparteEstado` es independiente (0038). */
async function crearContrapartida(
  ej: Ejecutar,
  cuenta: Cuenta,
  resolucionEstado: string,
  clase: ClaseRecon,
  patronContraparteEstado: string,
): Promise<string> {
  const padre = await crearReconocimiento(ej, cuenta, clase);
  const f = await una(ej, INSERT_CONTRAPARTIDA, [cuenta.clienteId, padre.id, resolucionEstado, clase, patronContraparteEstado]);
  const id = f['id'];
  if (!id) throw new Error('no se creó la contrapartida');
  return String(id);
}

const INSERT_PATRON_MATCH = `insert into reconocimiento_contrapartida_patron_match
    (cliente_id, contrapartida_id, regimen_matches, padron_contraparte_id)
  values ($1, $2, $3, $4)
  returning id::text as id`;

function insertarPatronMatch(
  ej: Ejecutar,
  clienteId: string,
  contrapartidaId: string,
  regimen: string,
  padronContraparteId: string,
): Promise<Fila[]> {
  return ej(INSERT_PATRON_MATCH, [clienteId, contrapartidaId, regimen, padronContraparteId]);
}

let patronSeq = 0;
async function altaPatron(ej: Ejecutar, clienteId: string): Promise<string> {
  patronSeq += 1;
  const f = await una(
    ej,
    `insert into padron_contraparte (cliente_id, patron, clasificacion, vigente_desde)
     values ($1, $2, 'proveedor', '2026-01-01'::date) returning id::text as id`,
    [clienteId, `PROVEEDOR SINTETICO 0038 ${patronSeq}`],
  );
  return String(f['id']);
}

let s: Sembrado;
let escenario: Record<'a' | 'b', Cuenta>;

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ($1, 'BANCO 0038', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }

  escenario = { a: { clienteId: '', cuentaId: '', loteId: '' }, b: { clienteId: '', cuentaId: '', loteId: '' } };
  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    for (const [clave, clienteId] of [
      ['a', s.clienteA],
      ['b', s.clienteB],
    ] as const) {
      const cuenta = await una(
        ej,
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
         values ($1, $2, 'ARS', $3) returning id::text as id`,
        [clienteId, BANCO, `0038 ${clave.toUpperCase()}`],
      );
      const lote = await una(
        ej,
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
         values ($1, $2, 'prueba-0038', 'archivo', $3, 'recibido', 0)
         returning id::text as id`,
        [clienteId, BANCO, `hash_0038_${clave}`],
      );
      await ej(
        `insert into lote_ingesta_cuenta
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
            verificacion_estado)
         values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
        [clienteId, String(lote['id']), String(cuenta['id'])],
      );
      escenario[clave] = { clienteId, cuentaId: String(cuenta['id']), loteId: String(lote['id']) };
    }
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

// =============================================================================
// A — `contrapartida_patron_estado_chk` (1 mutación, 2 legítimos)
// =============================================================================
describe('0038 A — dominio cerrado de `patron_contraparte_estado`', () => {
  it(
    'M-A1 🔴 EN VIVO: con el CHECK relajado, un quinto valor fuera del dominio ENTRA — se agrega la ' +
      'forma vulnerable, se confirma que la fila entra, se restaura la definición real al salir',
    async () => {
      const entro = await conDdlMutado(
        'contrapartida_patron_estado_chk',
        [
          'alter table reconocimiento_contrapartida drop constraint contrapartida_patron_estado_chk',
          "alter table reconocimiento_contrapartida add constraint contrapartida_patron_estado_chk check (true)",
        ],
        async (ej, crudo) => {
          await crudo(`select set_config('app.user_id', '${USUARIOS.socio}', true)`);
          const id = await crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana', 'archivado');
          return Boolean(id);
        },
      );
      expect(entro, 'el check relajado dejó pasar un quinto valor fuera de EvidenciaDeContraparte[\'estado\']').toBe(true);
    },
  );

  it('M-A1b 🔴 con el CHECK real, el mismo valor de arriba se rechaza', async () => {
    const error = await capturar(() =>
      comoSocio((ej) => crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana', 'archivado')),
    );
    esperarRechazo(
      error,
      '23514',
      'contrapartida_patron_estado_chk',
      'un quinto valor fuera de ESTADOS_EVIDENCIA_CONTRAPARTE tiene que morir por el check',
    );
  });

  it('legítimo: los 4 valores reales del dominio entran, cada uno bajo su propia contrapartida', async () => {
    await comoSocio(async (ej) => {
      for (const estado of ['no_aplica', 'sin_match', 'match', 'multiples_patrones']) {
        const id = await crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana', estado);
        expect(id).toBeTruthy();
      }
    });
  });
});

// =============================================================================
// B — `fk_recon_contrapartida_patron_match_padre` anclando CONTRA LA COLUMNA CORRECTA
// (hallazgo de `seguridad-datos-financieros`, convocatoria de 0038) — 1 mutación, 1 legítimo
// =============================================================================
describe('0038 B — la FK de mecanismo tiene que anclar contra `admite_matches_patron`, no `admite_matches` (socio)', () => {
  it(
    'M-B1 🔴 EN VIVO: con las DOS FK de mecanismo RE-ANCLADAS contra `admite_matches`/`regimen_matches` ' +
      '(evidencia de SOCIO), una fila de evidencia de PATRÓN `varios` cuelga sin problema de un padre ' +
      'cuya evidencia real de PATRÓN es `sin_match` (CERO patrones matchearon) — exactamente el vector ' +
      'que el sufijo `_patron` existe para impedir',
    async () => {
      const entro = await conDdlMutado(
        ['fk_recon_contrapartida_patron_match_padre', 'fk_recon_contrapartida_patron_match_regimen'],
        [
          'alter table reconocimiento_contrapartida_patron_match ' +
            'drop constraint fk_recon_contrapartida_patron_match_padre',
          'alter table reconocimiento_contrapartida_patron_match ' +
            'add constraint fk_recon_contrapartida_patron_match_padre ' +
            'foreign key (cliente_id, contrapartida_id, admite_matches) ' +
            'references reconocimiento_contrapartida (cliente_id, id, admite_matches) on delete restrict',
          'alter table reconocimiento_contrapartida_patron_match ' +
            'drop constraint fk_recon_contrapartida_patron_match_regimen',
          'alter table reconocimiento_contrapartida_patron_match ' +
            'add constraint fk_recon_contrapartida_patron_match_regimen ' +
            'foreign key (cliente_id, contrapartida_id, regimen_matches) ' +
            'references reconocimiento_contrapartida (cliente_id, id, regimen_matches) on delete restrict',
        ],
        async (ej, crudo) => {
          await crudo(`select set_config('app.user_id', '${USUARIOS.socio}', true)`);
          // `multiples_socios`: admite_matches (SOCIO) = true, regimen_matches (SOCIO) = 'varios'.
          // `patron_contraparte_estado: 'sin_match'`: admite_matches_patron = false, regimen_matches_patron
          // = 'sin_matches' — CERO patrones matchearon de verdad. Con las FK re-ancladas contra las
          // columnas de SOCIO, la evidencia de patrón `varios` encuentra el mismo valor del lado de
          // SOCIO y entra igual, mintiendo sobre lo que capa C encontró en `padron_contraparte`.
          const cp = await crearContrapartida(ej, escenario.a, 'multiples_socios', 'decision_humana', 'sin_match');
          const patron = await altaPatron(ej, escenario.a.clienteId);
          const fila = await insertarPatronMatch(ej, escenario.a.clienteId, cp, 'varios', patron);
          return Boolean(fila[0]?.['id']);
        },
      );
      expect(
        entro,
        'las FK mal ancladas contra las columnas de SOCIO dejaron colgar evidencia de PATRÓN de un padre sin ningún match de patrón real',
      ).toBe(true);
    },
  );

  it('legítimo: con la FK REAL, el mismo intento de arriba se rechaza', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cp = await crearContrapartida(ej, escenario.a, 'es_socio', 'propuesta', 'no_aplica');
        const patron = await altaPatron(ej, escenario.a.clienteId);
        return insertarPatronMatch(ej, escenario.a.clienteId, cp, 'patron_unico', patron);
      }),
    );
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_patron_match_padre',
      'un `es_socio` (no_aplica de patrón) no admite ninguna evidencia de patrón — el mecanismo, no un check, tiene que rechazarlo',
    );
  });
});

// =============================================================================
// C — `uq_recon_contrapartida_patron_match_unico`: cardinalidad de `match` (1 mutación, 2 legítimos)
// =============================================================================
describe('0038 C — a lo sumo UNA fila bajo `match` (regimen_matches = patron_unico)', () => {
  it(
    'M-C1 🔴 EN VIVO: sin el índice único parcial, DOS patrones distintos declarando `patron_unico` ' +
      'bajo la MISMA contrapartida entran los dos — el error sin detector aguas abajo (capa D vería ' +
      'evidencia de un solo proveedor mientras dos filas afirman serlo)',
    async () => {
      const entraronLasDos = await conDdlMutado(
        'uq_recon_contrapartida_patron_match_unico',
        ['drop index uq_recon_contrapartida_patron_match_unico'],
        async (ej, crudo) => {
          await crudo(`select set_config('app.user_id', '${USUARIOS.socio}', true)`);
          const cp = await crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana', 'match');
          const p1 = await altaPatron(ej, escenario.a.clienteId);
          const p2 = await altaPatron(ej, escenario.a.clienteId);
          const f1 = await insertarPatronMatch(ej, escenario.a.clienteId, cp, 'patron_unico', p1);
          const f2 = await insertarPatronMatch(ej, escenario.a.clienteId, cp, 'patron_unico', p2);
          return Boolean(f1[0]?.['id']) && Boolean(f2[0]?.['id']);
        },
      );
      expect(entraronLasDos, 'sin el índice parcial, dos "el único match" coexistieron bajo la misma contrapartida').toBe(true);
    },
  );

  it('legítimo: con el índice REAL, la segunda fila `patron_unico` de arriba se rechaza con `23505`', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cp = await crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana', 'match');
        const p1 = await altaPatron(ej, escenario.a.clienteId);
        const p2 = await altaPatron(ej, escenario.a.clienteId);
        await insertarPatronMatch(ej, escenario.a.clienteId, cp, 'patron_unico', p1);
        return insertarPatronMatch(ej, escenario.a.clienteId, cp, 'patron_unico', p2);
      }),
    );
    esperarRechazo(
      error,
      '23505',
      'uq_recon_contrapartida_patron_match_unico',
      'dos patrones distintos declarando ser "el único match" del mismo movimiento tienen que chocar',
    );
  });

  it('legítimo: bajo `multiples_patrones` (regimen `varios`), DOS filas entran las dos — el índice parcial no las alcanza', async () => {
    const n = await comoSocio(async (ej) => {
      const cp = await crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana', 'multiples_patrones');
      const p1 = await altaPatron(ej, escenario.a.clienteId);
      const p2 = await altaPatron(ej, escenario.a.clienteId);
      await insertarPatronMatch(ej, escenario.a.clienteId, cp, 'varios', p1);
      await insertarPatronMatch(ej, escenario.a.clienteId, cp, 'varios', p2);
      const f = await ej(
        `select count(*)::text as n from reconocimiento_contrapartida_patron_match where contrapartida_id = $1`,
        [cp],
      );
      return Number(f[0]?.['n'] ?? '-1');
    });
    // Es la mitad refutadora de M-C1/su legítimo: sin el `where regimen_matches = 'patron_unico'`
    // parcial, un índice único SIN el `where` pasaría el test de arriba y rompería `multiples_patrones`.
    expect(n, 'el índice parcial se comió `multiples_patrones`: perdió el `where regimen_matches`').toBe(2);
  });
});

// =============================================================================
// D — `fk_recon_contrapartida_patron_match_patron`: FK COMPUESTA tenant-consistente
// (mismo hallazgo F1 que ya cerró `0037`) — 1 mutación, 2 legítimos
// =============================================================================
describe('0038 D — FK compuesta de `padron_contraparte_id`', () => {
  it(
    'M-D1 🔴 EN VIVO: con la FK REDUCIDA a una sola columna (`padron_contraparte_id references ' +
      'padron_contraparte(id)`, sin `cliente_id`), una contrapartida de un cliente SÍ logra citar el ' +
      'patrón de OTRO cliente',
    async () => {
      const patronDeB = await comoSocio((ej) => altaPatron(ej, escenario.b.clienteId));
      const entroCruzado = await conDdlMutado(
        'fk_recon_contrapartida_patron_match_patron',
        [
          'alter table reconocimiento_contrapartida_patron_match ' +
            'drop constraint fk_recon_contrapartida_patron_match_patron',
          'alter table reconocimiento_contrapartida_patron_match ' +
            'add constraint fk_recon_contrapartida_patron_match_patron ' +
            'foreign key (padron_contraparte_id) references padron_contraparte (id) on delete restrict',
        ],
        async (ej, crudo) => {
          await crudo(`select set_config('app.user_id', '${USUARIOS.socio}', true)`);
          const cp = await crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana', 'match');
          const fila = await insertarPatronMatch(ej, escenario.a.clienteId, cp, 'patron_unico', patronDeB);
          return Boolean(fila[0]?.['id']);
        },
      );
      expect(
        entroCruzado,
        'con la FK simple, una contrapartida de A citando el patrón de B entró — el vector que la FK compuesta cierra',
      ).toBe(true);
    },
  );

  it('legítimo: con la FK COMPUESTA real, el mismo cruce de arriba se rechaza', async () => {
    const patronDeB = await comoSocio((ej) => altaPatron(ej, escenario.b.clienteId));
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cp = await crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana', 'match');
        return insertarPatronMatch(ej, escenario.a.clienteId, cp, 'patron_unico', patronDeB);
      }),
    );
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_patron_match_patron',
      'una contrapartida de un cliente no puede citar, como evidencia, el patrón de otro cliente',
    );
  });

  it('legítimo: citar el patrón del PROPIO cliente entra', async () => {
    await comoSocio(async (ej) => {
      const patron = await altaPatron(ej, escenario.a.clienteId);
      const cp = await crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana', 'match');
      const fila = await insertarPatronMatch(ej, escenario.a.clienteId, cp, 'patron_unico', patron);
      expect(fila[0]?.['id']).toBeTruthy();
    });
  });
});

// =============================================================================
// E — `patron_contraparte_estado` NOT NULL sin condición: el caso que la corrección
// del comentario de `reconocimiento.ts` (punto 1) hace posible por primera vez.
// =============================================================================
describe('0038 E — `es_socio` con `patron_contraparte_estado = no_aplica` y CERO filas satélite', () => {
  it('legítimo: entra sin ninguna fila en la satélite de patrón — `no_aplica` no es un caso raro, es el real para `es_socio`', async () => {
    const n = await comoSocio(async (ej) => {
      const cp = await crearContrapartida(ej, escenario.a, 'es_socio', 'propuesta', 'no_aplica');
      const f = await ej(
        `select count(*)::text as n from reconocimiento_contrapartida_patron_match where contrapartida_id = $1`,
        [cp],
      );
      return Number(f[0]?.['n'] ?? '-1');
    });
    expect(n, 'un `es_socio` no debería tener ninguna fila de evidencia de PATRÓN').toBe(0);
  });
});
