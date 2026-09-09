/**
 * MUTACIONES del fix de idempotencia de `leerReconocimientosParaImputar`/`conciliarLote` (Capa D,
 * CLAUDE.md §1.8) — convocatoria completa 2026-09-09 (`dba-data`, `security-engineer`,
 * `seguridad-datos-financieros`, `motor-conciliacion-contable`, `contador-dominio`). El bug real,
 * medido contra el piloto: re-correr `conciliar:lote --aplicar` sobre un lote ya conciliado antes
 * reprocesaba TAMBIÉN los movimientos viejos y generaba `asiento_propuesto` duplicados.
 *
 *   L1 legítimo, SECUENCIAL: correr `conciliarLote(--aplicar)` dos veces sobre el mismo lote — la
 *      segunda no crea nada nuevo, y lo reporta explícito (`yaImputadosExcluidos`) ... 0 mutaciones
 *   M1 🔴 mutación EN VIVO, dos conexiones reales: SIN el guard de concurrencia
 *      (`lockearMovimientosDelLote`), dos corridas simultáneas sobre el MISMO movimiento nuevo leen
 *      "todavía sin imputar" bajo READ COMMITTED (ninguna ve el INSERT no comprometido de la otra) y
 *      las dos insertan — el asiento queda duplicado ................................. 1 mutación
 *   L2 el mecanismo REAL (`lockearMovimientosDelLote` antes de leer, mismo entrelazado que M1): la
 *      segunda corrida queda BLOQUEADA hasta que la primera comitea, y al desbloquear el
 *      `NOT EXISTS` la excluye — 0 duplicados ................................. 0 mutaciones, 1 legítimo
 *                                                                              ─────────────────────
 *                                                                              1 mutación, 2 legítimos, 3 `it`
 *
 * ## Por qué M1/L2 no llaman a `conciliarLote()` directo
 *
 * `conciliarLote()` no tiene ningún hook de timing — sin él, la carrera es posible pero no
 * reproducible de forma confiable en un test (depende de timing de red entre dos conexiones reales),
 * mismo motivo que documenta `mutaciones-0041.test.ts` para su `pg_sleep` inyectado. M1/L2 llaman
 * DIRECTO a las funciones reales exportadas (`lockearMovimientosDelLote`, `leerReconocimientosParaImputar`)
 * con un `esperar()` inyectado SOLO para hacer determinística la ventana de carrera — el punto exacto
 * (después de leer, antes de escribir) es el mismo en las dos variantes, así que M1 y L2 miden
 * EXACTAMENTE la misma ventana con y sin el lock, no dos experimentos distintos.
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, corriendo contra LOCAL.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import {
  cerrarConexiones,
  conUsuario,
  leerReconocimientosParaImputar,
  lockearMovimientosDelLote,
  type Tx,
} from '@sistema-contable/data';
import { conciliarLote } from '../src/conciliar-lote.ts';
import { entornoActual } from '../../../packages/data/src/db/entorno.ts';

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

function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** true = la promesa ya resolvió/rechazó dentro de `ms`; false = sigue pendiente (bloqueada). */
async function sigueBloqueada(promesa: Promise<unknown>, ms: number): Promise<boolean> {
  const centinela = Symbol('pendiente');
  const resultado = await Promise.race([promesa.catch(() => centinela), esperar(ms).then(() => centinela)]);
  return resultado === centinela;
}

const BANCO_CODIGO = 'banco_mut_idempotencia';

let s: Sembrado;
let filaSeq = 0;
let base: { readonly clienteId: string; readonly cuentaBancoId: string; readonly cuentaGastosId: string; readonly cuentaBancariaId: string };

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      BANCO_CODIGO,
      'Banco Ficticio Mutación Idempotencia',
    ]);
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cuentaBanco = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [s.clienteA]);
    const cuentaBancoId = String(cuentaBanco['id']);
    await ej(
      `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
       values ($1, $2, '1.1.2.900', 'Banco Ficticio Mut Idempotencia', 4, 'generica', '2026-01-01', 'fixture mutación')`,
      [s.clienteA, cuentaBancoId],
    );

    const cuentaGastos = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [s.clienteA]);
    const cuentaGastosId = String(cuentaGastos['id']);
    await ej(
      `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
       values ($1, $2, '4.2.9.900', 'Gastos Ficticios Mut Idempotencia', 4, 'generica', '2026-01-01', 'fixture mutación')`,
      [s.clienteA, cuentaGastosId],
    );

    const cuentaBancaria = await una(
      ej,
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, cuenta_id) values ($1, $2, 'ARS', $3) returning id::text as id`,
      [s.clienteA, BANCO_CODIGO, cuentaBancoId],
    );

    // Regla fija: `comision_bancaria` -> cuenta de gastos ficticia. Sin esto, `resolverAsiento`
    // cae a `pendiente_cierre`/`tipo_sin_regla_imputacion` en vez de automático — el test de
    // idempotencia necesita el camino automático (es el que escribe `asiento_propuesto_renglon`,
    // la tabla donde vive el bug real) para tener algo que duplicar o no duplicar.
    await ej(
      `insert into regla_imputacion (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo, decidido_por)
       values ($1, 'comision_bancaria', 'fija', $2, '2026-01-01', 'fixture mutación idempotencia', $3)`,
      [s.clienteA, cuentaGastosId, USUARIOS.socio],
    );

    base = { clienteId: s.clienteA, cuentaBancoId, cuentaGastosId, cuentaBancariaId: String(cuentaBancaria['id']) };
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Un lote + un cierre nuevos, con período propio (evita chocar con `uq_cierre_periodo_vigente`
 *  entre `it`s del mismo cliente). */
async function crearLoteYCierre(
  ej: Ejecutar,
  periodo: { readonly desde: string; readonly hasta: string },
): Promise<{ readonly loteId: string; readonly cierreId: string }> {
  const lote = await una(
    ej,
    `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
     values ($1, $2, 'mut-idempotencia@fixture', 'archivo', $3, 'procesado') returning id::text as id`,
    [base.clienteId, BANCO_CODIGO, randomUUID()],
  );
  const loteId = String(lote['id']);
  await ej(
    `insert into lote_ingesta_cuenta (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
     values ($1, $2, $3, $4::date, $5::date, 'no_verificable')`,
    [base.clienteId, loteId, base.cuentaBancariaId, periodo.desde, periodo.hasta],
  );
  const cierre = await una(
    ej,
    `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
     values ($1, 'mensual', $2::date, $3::date) returning id::text as id`,
    [base.clienteId, periodo.desde, periodo.hasta],
  );
  return { loteId, cierreId: String(cierre['id']) };
}

async function crearMovimientoPropuesta(ej: Ejecutar, loteId: string, fecha: string): Promise<string> {
  filaSeq += 1;
  const movimiento = await una(
    ej,
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, concepto_banco_estrategia, contraparte_captura)
     values ($1, $2, $3, $4, $5, $6::date, 'movimiento mutación idempotencia', '-500.00', 'no_capturado', 'no_capturado')
     returning id::text as id, entrada_digest`,
    [base.clienteId, loteId, base.cuentaBancariaId, filaSeq, randomUUID(), fecha],
  );
  const movimientoId = String(movimiento['id']);
  await ej(
    `insert into reconocimiento_movimiento
       (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
        lado, via, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados, evidencia_hubo_cola)
     values ($1, $2, 'e2e00000e2e00001', $3, 'propuesta', 'comision_bancaria', 'comision_de_mantenimiento_de_cuenta',
             'normal', 'debe', 'texto_literal_exacto', 'fixture.mut', 10, false)`,
    [base.clienteId, movimientoId, String(movimiento['entrada_digest'])],
  );
  return movimientoId;
}

/** Inserta un asiento dummy (2 renglones, ambos citando `movimientoId` como `referencia_origen` —
 *  mismo criterio que `escribirAsientoAutomatico` real) directo por SQL: el test ejercita el par
 *  lock/lectura, no el resolver ni el escritor real (ya cubiertos en `conciliar-lote.test.ts`). */
async function insertarAsientoDummy(ej: Ejecutar, cierreId: string, movimientoId: string, fecha: string): Promise<void> {
  const asiento = await una(
    ej,
    `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
     values ($1, $2, 'devengamiento', $3::date) returning id::text as id`,
    [base.clienteId, cierreId, fecha],
  );
  const asientoId = String(asiento['id']);
  await ej(
    `insert into asiento_propuesto_renglon (cliente_id, asiento_id, orden, cuenta_id, debe, haber, fecha_imputacion, referencia_origen)
     values ($1, $2, 1, $3, 0, 500.00, $4::date, $5)`,
    [base.clienteId, asientoId, base.cuentaBancoId, fecha, movimientoId],
  );
  await ej(
    `insert into asiento_propuesto_renglon (cliente_id, asiento_id, orden, cuenta_id, debe, haber, fecha_imputacion, referencia_origen)
     values ($1, $2, 2, $3, 500.00, 0, $4::date, $5)`,
    [base.clienteId, asientoId, base.cuentaGastosId, fecha, movimientoId],
  );
}

async function contarRenglonesPorMovimiento(movimientoId: string): Promise<number> {
  const filas = await comoSocio((ej) => ej(`select 1 from asiento_propuesto_renglon where referencia_origen = $1`, [movimientoId]));
  return filas.length;
}

// =============================================================================
// L1 — legítimo, SECUENCIAL, contra `conciliarLote()` REAL (0 mutaciones, 1 legítimo)
// =============================================================================
describe('idempotencia L1 — secuencial: re-correr conciliar:lote --aplicar NO duplica', () => {
  it('primera corrida crea el asiento; la segunda no crea nada y lo reporta explícito', async () => {
    const { loteId, cierreId } = await comoSocio((ej) => crearLoteYCierre(ej, { desde: '2026-06-01', hasta: '2026-06-30' }));
    await comoSocio((ej) => crearMovimientoPropuesta(ej, loteId, '2026-06-15'));

    const primera = await conciliarLote({ cliente: base.clienteId, usuario: USUARIOS.socio, loteId, cierreId, aplicar: true });
    expect(primera.estado).toBe('reportado');
    if (primera.estado !== 'reportado') return;
    expect(primera.asientosCreados).toBe(1);
    expect(primera.yaImputadosExcluidos).toBe(0);

    const segunda = await conciliarLote({ cliente: base.clienteId, usuario: USUARIOS.socio, loteId, cierreId, aplicar: true });
    expect(segunda.estado).toBe('reportado');
    if (segunda.estado !== 'reportado') return;
    expect(segunda.totalMovimientos, 'el movimiento ya imputado no tiene que volver a entrar al resolver').toBe(0);
    expect(segunda.asientosCreados, 'la segunda corrida NO tiene que crear un segundo asiento').toBe(0);
    expect(segunda.yaImputadosExcluidos, 'tiene que quedar contado explícito, no solo ausente').toBe(1);

    const renglones = await comoSocio((ej) =>
      ej(
        `select 1 from asiento_propuesto_renglon r
           join asiento_propuesto a on a.cliente_id = r.cliente_id and a.id = r.asiento_id
          where a.cierre_id = $1`,
        [cierreId],
      ),
    );
    expect(renglones, 'exactamente 2 renglones (1 asiento) en la base, nunca 4').toHaveLength(2);
  });
});

// =============================================================================
// M1/L2 — LA CARRERA, EN VIVO con dos conexiones reales (1 mutación, 1 legítimo)
// =============================================================================
describe('idempotencia M1/L2 — 🔴 la carrera de dos corridas concurrentes, en vivo con dos conexiones reales', () => {
  it(
    'M1 🔴 EN VIVO, SIN el guard de concurrencia: dos corridas simultáneas del mismo movimiento nuevo ' +
      'leen "sin imputar" las dos, y las dos insertan — el asiento queda duplicado',
    async () => {
      if (entornoActual() !== 'local') throw new Error(`Las pruebas de carrera corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);

      const { loteId, cierreId } = await comoSocio((ej) => crearLoteYCierre(ej, { desde: '2026-07-01', hasta: '2026-07-31' }));
      const movimientoId = await comoSocio((ej) => crearMovimientoPropuesta(ej, loteId, '2026-07-15'));

      async function corridaSinLock(): Promise<void> {
        await conUsuario(USUARIOS.socio, async (tx) => {
          const ej = desdeTx(tx);
          // 🔴 A propósito: NO llama a `lockearMovimientosDelLote` antes de leer.
          const { filas } = await leerReconocimientosParaImputar(tx, { clienteId: base.clienteId, loteIngestaId: loteId });
          expect(filas, 'sin lock, las dos corridas tienen que ver el movimiento como "todavía sin imputar"').toHaveLength(1);
          await esperar(300); // fuerza el entrelazado determinístico — mismo motivo que mutaciones-0041
          await insertarAsientoDummy(ej, cierreId, movimientoId, '2026-07-15');
        });
      }

      await Promise.all([corridaSinLock(), esperar(100).then(corridaSinLock)]);

      const n = await contarRenglonesPorMovimiento(movimientoId);
      expect(n, 'LA CARRERA SE COLÓ: sin el lock, las dos corridas insertaron — 4 renglones (2 asientos) para el mismo movimiento').toBe(4);
    },
    10_000,
  );

  it(
    'L2 el mecanismo REAL (lockearMovimientosDelLote antes de leer), mismo entrelazado que M1: ' +
      'la segunda corrida queda BLOQUEADA hasta que la primera comitea, y no duplica',
    async () => {
      if (entornoActual() !== 'local') throw new Error(`Las pruebas de carrera corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);

      const { loteId, cierreId } = await comoSocio((ej) => crearLoteYCierre(ej, { desde: '2026-08-01', hasta: '2026-08-31' }));
      const movimientoId = await comoSocio((ej) => crearMovimientoPropuesta(ej, loteId, '2026-08-15'));

      async function corridaConLock(): Promise<void> {
        await conUsuario(USUARIOS.socio, async (tx) => {
          const ej = desdeTx(tx);
          await lockearMovimientosDelLote(tx, { clienteId: base.clienteId, loteIngestaId: loteId });
          const { filas } = await leerReconocimientosParaImputar(tx, { clienteId: base.clienteId, loteIngestaId: loteId });
          await esperar(300); // mismo punto/duración que M1 — comparación justa
          if (filas.length === 0) return; // la corrida que quedó bloqueada ve el ya-imputado y no hace nada
          await insertarAsientoDummy(ej, cierreId, movimientoId, '2026-08-15');
        });
      }

      const promesaA = corridaConLock();
      await esperar(100);
      const promesaB = corridaConLock();

      const bloqueadaB = await sigueBloqueada(promesaB, 500);
      expect(bloqueadaB, 'FOR UPDATE tiene que bloquear a la segunda corrida hasta que la primera comitea').toBe(true);

      await Promise.all([promesaA, promesaB]);

      const n = await contarRenglonesPorMovimiento(movimientoId);
      expect(n, 'con el lock, un solo asiento (2 renglones) — nunca 4').toBe(2);
    },
    10_000,
  );
});
