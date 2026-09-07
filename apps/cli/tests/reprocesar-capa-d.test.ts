/**
 * `reprocesar-capa-d.ts` — el CLI que cierra la Mitad 1 del plan `abundant-twirling-naur` (migración
 * `0040`). Base real, DOS CLI reales encadenados — `confirmar-asientos.ts` primero (deja algunos
 * asientos en `'confirmado'` y otros en `'propuesto'`), `reprocesar-capa-d.ts --aplicar` después —
 * nunca forzado por SQL directo. Verifica que cada asiento tomó el camino correcto: Caso A el que
 * seguía `'propuesto'`, Caso B el que ya estaba `'confirmado'`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, con `0040` APLICADA.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '@sistema-contable/data';
import { sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { confirmarAsientos } from '../src/confirmar-asientos.ts';
import { parsearArgumentos, reprocesarCapaD } from '../src/reprocesar-capa-d.ts';

let s: Sembrado;
let cierreAbiertoId = '';
let cuentaBancoId = '';
let cuentaViejaId = '';
let cuentaNuevaId = '';
let reglaViejaId = '';
let reglaNuevaId = '';

async function crearCuentaConAtributo(tx: Tx, codigo: string, denominacion: string): Promise<string> {
  const cuenta = await tx.consultar<{ id: string }>(`insert into cuenta (cliente_id) values ($1) returning id::text as id`, [s.clienteA]);
  const cuentaId = cuenta[0]?.id;
  if (!cuentaId) throw new Error('no se creó la cuenta sintética');
  await tx.consultar(
    `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
     values ($1, $2, $3, $4, 1, 'generica', '2026-01-01'::date, 'fixture reprocesar-capa-d.test.ts')`,
    [s.clienteA, cuentaId, codigo, denominacion],
  );
  return cuentaId;
}

async function crearAsientoOriginal(
  tx: Tx,
  cuentaCorregibleId: string,
  importe: string,
): Promise<{ readonly asientoId: string; readonly renglonBancoId: string; readonly renglonCorregibleId: string }> {
  const asiento = await tx.consultar<{ id: string }>(
    `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion, asiento_estado)
     values ($1, $2, 'devengamiento', '2026-06-15'::date, 'propuesto')
     returning id::text as id`,
    [s.clienteA, cierreAbiertoId],
  );
  const asientoId = asiento[0]?.id;
  if (!asientoId) throw new Error('no se creó el asiento sintético');

  const banco = await tx.consultar<{ id: string }>(
    `insert into asiento_propuesto_renglon (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion)
     values ($1, $2, 1, $3, $4::jsonb, 0, $5, '2026-06-15'::date) returning id::text as id`,
    [s.clienteA, asientoId, cuentaBancoId, JSON.stringify({ codigo: '1.1.1', denominacion: 'BANCO', rolFuncional: 'generica' }), importe],
  );
  const corregible = await tx.consultar<{ id: string }>(
    `insert into asiento_propuesto_renglon (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion)
     values ($1, $2, 2, $3, $4::jsonb, $5, 0, '2026-06-15'::date) returning id::text as id`,
    [s.clienteA, asientoId, cuentaCorregibleId, JSON.stringify({ codigo: '5.1.1', denominacion: 'IMPUESTO 25413 VIEJA', rolFuncional: 'generica' }), importe],
  );

  return { asientoId, renglonBancoId: banco[0]?.id ?? '', renglonCorregibleId: corregible[0]?.id ?? '' };
}

async function estadoDelAsiento(asientoId: string): Promise<{ readonly asientoEstado: string; readonly supersededById: string | null; readonly corrigeAsientoId: string | null; readonly tipo: string }> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ asiento_estado: string; superseded_by_id: string | null; corrige_asiento_id: string | null; tipo: string }>(
      `select asiento_estado, superseded_by_id::text as superseded_by_id, corrige_asiento_id::text as corrige_asiento_id, tipo
         from asiento_propuesto where id = $1`,
      [asientoId],
    );
    const fila = f[0];
    if (!fila) throw new Error(`asiento ${asientoId} no encontrado`);
    return { asientoEstado: fila.asiento_estado, supersededById: fila.superseded_by_id, corrigeAsientoId: fila.corrige_asiento_id, tipo: fila.tipo };
  });
}

async function renglonesDe(asientoId: string): Promise<readonly { readonly cuentaId: string; readonly debe: string; readonly haber: string }[]> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const filas = await tx.consultar<{ cuenta_id: string; debe: string; haber: string }>(
      `select cuenta_id::text as cuenta_id, debe, haber from asiento_propuesto_renglon where asiento_id = $1 order by orden`,
      [asientoId],
    );
    return filas.map((f) => ({ cuentaId: f.cuenta_id, debe: f.debe, haber: f.haber }));
  });
}

async function reprocesoDe(asientoId: string): Promise<readonly { readonly caso: string; readonly asientoNuevoId: string; readonly reglaAnteriorId: string | null; readonly reglaNuevaId: string | null }[]> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const filas = await tx.consultar<{ caso: string; asiento_nuevo_id: string; regla_imputacion_id_anterior: string | null; regla_imputacion_id_nueva: string | null }>(
      `select caso, asiento_nuevo_id::text as asiento_nuevo_id, regla_imputacion_id_anterior::text as regla_imputacion_id_anterior,
              regla_imputacion_id_nueva::text as regla_imputacion_id_nueva
         from asiento_propuesto_reproceso where asiento_id = $1`,
      [asientoId],
    );
    return filas.map((f) => ({ caso: f.caso, asientoNuevoId: f.asiento_nuevo_id, reglaAnteriorId: f.regla_imputacion_id_anterior, reglaNuevaId: f.regla_imputacion_id_nueva }));
  });
}

beforeAll(async () => {
  s = await sembrar();
  await conUsuario(USUARIOS.socio, async (tx) => {
    const cierre = await tx.consultar<{ id: string }>(
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta, cierre_estado)
       values ($1, 'mensual', '2026-06-01'::date, '2026-06-30'::date, 'abierto') returning id::text as id`,
      [s.clienteA],
    );
    cierreAbiertoId = cierre[0]?.id ?? '';

    cuentaBancoId = await crearCuentaConAtributo(tx, '1.1.1', 'BANCO');
    cuentaViejaId = await crearCuentaConAtributo(tx, '5.1.1', 'IMPUESTO 25413 VIEJA');
    cuentaNuevaId = await crearCuentaConAtributo(tx, '5.1.2', 'IMPUESTO 25413 NUEVA');

    const reglaVieja = await tx.consultar<{ id: string }>(
      `insert into regla_imputacion
         (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, vigente_hasta, respaldo, decidido_por)
       values ($1, 'impuesto_debitos_creditos', 'fija', $2, '2026-01-01'::date, '2026-09-01'::date, 'fixture e2e', $3)
       returning id::text as id`,
      [s.clienteA, cuentaViejaId, USUARIOS.socio],
    );
    reglaViejaId = reglaVieja[0]?.id ?? '';
    const reglaNueva = await tx.consultar<{ id: string }>(
      `insert into regla_imputacion
         (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo, decidido_por)
       values ($1, 'impuesto_debitos_creditos', 'fija', $2, '2026-09-01'::date, 'fixture e2e corregida', $3)
       returning id::text as id`,
      [s.clienteA, cuentaNuevaId, USUARIOS.socio],
    );
    reglaNuevaId = reglaNueva[0]?.id ?? '';
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

describe('parsearArgumentos', () => {
  const base = ['--cliente', randomUUID(), '--usuario', randomUUID(), '--regla-imputacion-anterior-id', randomUUID(), '--motivo', 'corrección de prueba'];

  it('dry-run por defecto (sin --aplicar)', () => {
    const r = parsearArgumentos(base);
    expect(r.aplicar).toBe(false);
  });

  it('--aplicar explícito', () => {
    const r = parsearArgumentos([...base, '--aplicar']);
    expect(r.aplicar).toBe(true);
  });

  it('rechaza sin --regla-imputacion-anterior-id', () => {
    expect(() => parsearArgumentos(['--cliente', randomUUID(), '--usuario', randomUUID(), '--motivo', 'x'])).toThrow();
  });

  it('rechaza sin --motivo', () => {
    expect(() =>
      parsearArgumentos(['--cliente', randomUUID(), '--usuario', randomUUID(), '--regla-imputacion-anterior-id', randomUUID()]),
    ).toThrow();
  });
});

describe('reprocesarCapaD — dry-run: reporta Caso A/Caso B y la proporción sobre el total, sin escribir', () => {
  it('con un asiento "propuesto" (Caso A) y ninguno "confirmado" todavía: dry-run los cuenta, no escribe nada', async () => {
    const { asientoId } = await conUsuario(USUARIOS.socio, (tx) => crearAsientoOriginal(tx, cuentaViejaId, '1000.00'));

    const r = await reprocesarCapaD({ cliente: s.clienteA, usuario: USUARIOS.socio, reglaImputacionAnteriorId: reglaViejaId, motivo: 'dry-run de prueba', aplicar: false });
    expect(r.estado).toBe('dry_run');
    if (r.estado !== 'dry_run') throw new Error('unreachable');
    expect(r.resumen.casoA).toBeGreaterThanOrEqual(1);
    expect(r.reporte.some((f) => f.asientoId === asientoId && f.clasificacion === 'caso_a' && !f.aplicado)).toBe(true);

    // Dry-run nunca escribe: el asiento sigue exactamente como estaba.
    const estado = await estadoDelAsiento(asientoId);
    expect(estado.asientoEstado).toBe('propuesto');
    const reprocesos = await reprocesoDe(asientoId);
    expect(reprocesos).toEqual([]);
  });
});

describe('E2E — los DOS CLI reales encadenados: confirmar-asientos.ts, después reprocesar-capa-d.ts --aplicar', () => {
  it('Caso A (seguía "propuesto") se reemplaza; Caso B (ya "confirmado") se ajusta sin tocar el original', async () => {
    // Dos asientos NUEVOS y propios de este caso, para no interferir con el candidato del describe
    // anterior (que ya quedó reprocesado — `leerCandidatosDeReproceso` lo excluye por tener fila en
    // `asiento_propuesto_reproceso`, así que no vuelve a aparecer, pero un asiento fresco es más claro).
    const original = await conUsuario(USUARIOS.socio, (tx) => crearAsientoOriginal(tx, cuentaViejaId, '2000.00'));
    const aConfirmar = await conUsuario(USUARIOS.socio, (tx) => crearAsientoOriginal(tx, cuentaViejaId, '500.00'));

    // 1° CLI real: confirmar-asientos.ts --aplicar, SOLO sobre `aConfirmar` — deja `original` en
    // 'propuesto' (Caso A) y `aConfirmar` en 'confirmado' (Caso B).
    const confirmacion = await confirmarAsientos({ cliente: s.clienteA, usuario: USUARIOS.socio, asientoIds: [aConfirmar.asientoId], aplicar: true });
    expect(confirmacion).toEqual({
      estado: 'aplicado',
      reporte: [{ asientoId: aConfirmar.asientoId, diagnostico: 'confirmable', aplicado: true, resultado: 'confirmado' }],
    });
    expect((await estadoDelAsiento(original.asientoId)).asientoEstado).toBe('propuesto');
    expect((await estadoDelAsiento(aConfirmar.asientoId)).asientoEstado).toBe('confirmado');

    // 2° CLI real: reprocesar-capa-d.ts --aplicar, sobre la regla vieja completa (selector = la
    // regla, no una lista de asientos — toma los dos candidatos que encuentre).
    const r = await reprocesarCapaD({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      reglaImputacionAnteriorId: reglaViejaId,
      motivo: 'corrección real e2e: impuesto 25413 mal imputado',
      aplicar: true,
    });
    expect(r.estado).toBe('aplicado');
    if (r.estado !== 'aplicado') throw new Error('unreachable');

    const filaOriginal = r.reporte.find((f) => f.asientoId === original.asientoId);
    const filaAConfirmar = r.reporte.find((f) => f.asientoId === aConfirmar.asientoId);
    expect(filaOriginal).toMatchObject({ clasificacion: 'caso_a', aplicado: true, resultado: 'reemplazado' });
    expect(filaAConfirmar).toMatchObject({ clasificacion: 'caso_b', aplicado: true, resultado: 'ajustado' });

    // --- Verificación POR CONSULTA DIRECTA — Caso A: el original quedó superseded ---
    const estadoOriginal = await estadoDelAsiento(original.asientoId);
    expect(estadoOriginal.asientoEstado).toBe('superseded');
    expect(estadoOriginal.supersededById).toBeTruthy();
    const nuevoDeA = await estadoDelAsiento(estadoOriginal.supersededById as string);
    expect(nuevoDeA.asientoEstado).toBe('propuesto');
    const renglonesNuevoA = await renglonesDe(estadoOriginal.supersededById as string);
    expect(renglonesNuevoA).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cuentaId: cuentaBancoId, haber: '2000.00' }),
        expect.objectContaining({ cuentaId: cuentaNuevaId, debe: '2000.00' }),
      ]),
    );
    // La cuenta vieja NO aparece en el asiento de reemplazo — quedó completamente reclasificado.
    expect(renglonesNuevoA.some((r2) => r2.cuentaId === cuentaViejaId)).toBe(false);
    const reprocesoA = await reprocesoDe(original.asientoId);
    expect(reprocesoA).toEqual([{ caso: 'reemplazo_no_revisado', asientoNuevoId: estadoOriginal.supersededById, reglaAnteriorId: reglaViejaId, reglaNuevaId: reglaNuevaId }]);

    // --- Verificación POR CONSULTA DIRECTA — Caso B: el original NO se tocó ---
    const estadoAConfirmar = await estadoDelAsiento(aConfirmar.asientoId);
    expect(estadoAConfirmar).toEqual({ asientoEstado: 'confirmado', supersededById: null, corrigeAsientoId: null, tipo: 'devengamiento' });
    const renglonesOriginalB = await renglonesDe(aConfirmar.asientoId);
    // Intactos: mismo banco, mismos importes que al crearlo — el ajuste NO modificó esta fila.
    expect(renglonesOriginalB).toEqual([
      { cuentaId: cuentaBancoId, debe: '0.00', haber: '500.00' },
      { cuentaId: cuentaViejaId, debe: '500.00', haber: '0.00' },
    ]);

    const reprocesoB = await reprocesoDe(aConfirmar.asientoId);
    expect(reprocesoB.length).toBe(1);
    expect(reprocesoB[0]).toMatchObject({ caso: 'ajuste_ya_entregado', reglaAnteriorId: reglaViejaId, reglaNuevaId: reglaNuevaId });
    const asientoAjusteId = reprocesoB[0]?.asientoNuevoId as string;
    const estadoAjuste = await estadoDelAsiento(asientoAjusteId);
    expect(estadoAjuste.tipo).toBe('ajuste_cierre');
    expect(estadoAjuste.corrigeAsientoId).toBe(aConfirmar.asientoId);
    const renglonesAjuste = await renglonesDe(asientoAjusteId);
    // El efecto NETO: revierte la cuenta vieja (haber, el opuesto del debe original) e imputa la
    // nueva (debe, mismo lado que el renglón corregido) — el banco NO aparece acá, no se repite.
    expect(renglonesAjuste).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cuentaId: cuentaViejaId, haber: '500.00', debe: '0.00' }),
        expect.objectContaining({ cuentaId: cuentaNuevaId, debe: '500.00', haber: '0.00' }),
      ]),
    );
    expect(renglonesAjuste.some((r2) => r2.cuentaId === cuentaBancoId)).toBe(false);

    // --- El resumen del reporte: proporción sobre el total, siempre visible antes de --aplicar ---
    expect(r.resumen.casoA).toBeGreaterThanOrEqual(1);
    expect(r.resumen.casoB).toBeGreaterThanOrEqual(1);
    expect(r.resumen.totalAsientosCliente).toBeGreaterThan(0);
    expect(r.resumen.proporcionSobreTotal).toMatch(/%$/);
  });

  it('una segunda corrida con la misma regla ya no encuentra candidatos (ya quedaron reprocesados)', async () => {
    const r = await reprocesarCapaD({ cliente: s.clienteA, usuario: USUARIOS.socio, reglaImputacionAnteriorId: reglaViejaId, motivo: 'segunda corrida', aplicar: false });
    expect(r.estado).toBe('dry_run');
    if (r.estado !== 'dry_run') throw new Error('unreachable');
    expect(r.resumen.casoA).toBe(0);
    expect(r.resumen.casoB).toBe(0);
  });
});
