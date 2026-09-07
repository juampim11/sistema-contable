/**
 * `reprocesarAsientoNoRevisado` / `corregirAsientoEntregado` — los dos escritores reales del
 * reproceso de Capa D con supersesión (migración `0040`, Mitad 1, Paso 3).
 *
 * No repite la cobertura de mecanismo de DDL (eso ya lo cierra `mutaciones-0040.test.ts` con prueba de
 * mutación en vivo, incluida la carrera TOCTOU del trigger); esto verifica el WIRING del escritor de
 * TypeScript, contra los escenarios 1, 2 y 4 de la tabla de predicción falsable del plan aprobado:
 *
 *   1. Asiento 'propuesto' reprocesado (Caso A) → original 'superseded', nuevo 'propuesto' con
 *      superseded_by_id, 1 fila en asiento_propuesto_reproceso (caso='reemplazo_no_revisado').
 *   2. Asiento 'confirmado' corregido (Caso B) → original SIGUE 'confirmado' intacto, nuevo
 *      tipo='ajuste_cierre' con corrige_asiento_id, 1 fila (caso='ajuste_ya_entregado').
 *   4. Reprocesar dos veces el mismo asiento 'propuesto' (carrera) → segunda corrida da 0 filas
 *      afectadas, {estado:'conflicto', motivoCodigo:'asiento_ya_no_estaba_propuesto'}, sin throw.
 *
 * El escenario 3 (trigger de cierre no-terminal) ya está cubierto por `mutaciones-0040.test.ts` A.
 * El escenario 5 (CLI, dry-run vs. --aplicar) es Paso 4, fuera de este archivo.
 *
 * Requisito previo: `0040` APLICADA.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { escribirConAuditoria } from '../src/db/auditoria.ts';
import {
  corregirAsientoEntregado,
  reprocesarAsientoNoRevisado,
  type PedidoCorregirAsientoEntregado,
  type PedidoReprocesarAsientoNoRevisado,
  type RenglonParaEscribir,
} from '../src/cierre/escrituras.ts';
import { sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;
let cierreAbiertoId = '';
let cuentaBancoId = '';
let cuentaContrapartidaId = '';
let reglaViejaId = '';
let reglaNuevaId = '';

let periodoSeq = 0;
async function crearCierre(tx: Tx, estado: 'abierto' | 'confirmado'): Promise<string> {
  periodoSeq += 1;
  const mes = String(1 + (periodoSeq % 12)).padStart(2, '0');
  const anio = 2021 + Math.floor(periodoSeq / 12);
  const desde = `${anio}-${mes}-01`;
  const filas =
    estado === 'abierto'
      ? await tx.consultar<{ id: string }>(
          `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta, cierre_estado)
           values ($1, 'mensual', $2::date, ($2::date + interval '1 month - 1 day')::date, 'abierto')
           returning id::text as id`,
          [s.clienteA, desde],
        )
      : await tx.consultar<{ id: string }>(
          `insert into cierre_cliente_periodo
             (cliente_id, tipo_periodo, periodo_desde, periodo_hasta, cierre_estado, confirmado_en, confirmado_por)
           values ($1, 'mensual', $2::date, ($2::date + interval '1 month - 1 day')::date, 'confirmado', now(), $3)
           returning id::text as id`,
          [s.clienteA, desde, USUARIOS.socio],
        );
  const id = filas[0]?.id;
  if (!id) throw new Error('no se creó el cierre sintético');
  return id;
}

async function crearAsiento(
  tx: Tx,
  cierreId: string,
  estado: 'propuesto' | 'confirmado',
  renglones: readonly [RenglonParaEscribir, RenglonParaEscribir],
): Promise<string> {
  const filas = await tx.consultar<{ id: string }>(
    `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion, asiento_estado)
     values ($1, $2, 'devengamiento', '2026-06-15'::date, $3)
     returning id::text as id`,
    [s.clienteA, cierreId, estado],
  );
  const id = filas[0]?.id;
  if (!id) throw new Error('no se creó el asiento sintético');
  for (const [orden, renglon] of renglones.entries()) {
    await tx.consultar(
      `insert into asiento_propuesto_renglon
         (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, '2026-06-15'::date)`,
      [
        s.clienteA,
        id,
        orden + 1,
        renglon.cuentaId,
        JSON.stringify(renglon.cuentaRef),
        renglon.lado === 'debe' ? renglon.importe : '0',
        renglon.lado === 'haber' ? renglon.importe : '0',
      ],
    );
  }
  return id;
}

function renglonesSinteticos(): readonly [RenglonParaEscribir, RenglonParaEscribir] {
  return [
    {
      cuentaId: cuentaBancoId,
      cuentaRef: { codigo: '1.1.1', denominacion: 'BANCO SINTÉTICO', rolFuncional: 'generica' },
      lado: 'haber',
      importe: '1000.00',
    },
    {
      cuentaId: cuentaContrapartidaId,
      cuentaRef: { codigo: '5.1.1', denominacion: 'GASTO SINTÉTICO', rolFuncional: 'generica' },
      lado: 'debe',
      importe: '1000.00',
    },
  ];
}

async function estadoDe(id: string): Promise<{ readonly asientoEstado: string; readonly supersededById: string | null }> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ asiento_estado: string; superseded_by_id: string | null }>(
      `select asiento_estado, superseded_by_id::text as superseded_by_id from asiento_propuesto where id = $1`,
      [id],
    );
    const fila = f[0];
    if (!fila) throw new Error(`asiento ${id} no encontrado`);
    return { asientoEstado: fila.asiento_estado, supersededById: fila.superseded_by_id };
  });
}

async function reprocesoDe(asientoId: string): Promise<readonly { readonly caso: string; readonly asientoNuevoId: string }[]> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const filas = await tx.consultar<{ caso: string; asiento_nuevo_id: string }>(
      `select caso, asiento_nuevo_id::text as asiento_nuevo_id from asiento_propuesto_reproceso where asiento_id = $1`,
      [asientoId],
    );
    return filas.map((f) => ({ caso: f.caso, asientoNuevoId: f.asiento_nuevo_id }));
  });
}

beforeAll(async () => {
  s = await sembrar();
  await conUsuario(USUARIOS.socio, async (tx) => {
    cierreAbiertoId = await crearCierre(tx, 'abierto');
    const banco = await tx.consultar<{ id: string }>(`insert into cuenta (cliente_id) values ($1) returning id::text as id`, [s.clienteA]);
    cuentaBancoId = banco[0]?.id ?? '';
    const contrapartida = await tx.consultar<{ id: string }>(`insert into cuenta (cliente_id) values ($1) returning id::text as id`, [s.clienteA]);
    cuentaContrapartidaId = contrapartida[0]?.id ?? '';
    const reglaVieja = await tx.consultar<{ id: string }>(
      `insert into regla_imputacion
         (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, vigente_hasta, respaldo, decidido_por)
       values ($1, 'impuesto_debitos_creditos', 'fija', $2, '2026-01-01'::date, '2026-09-01'::date, 'sintético 0040 wiring', $3)
       returning id::text as id`,
      [s.clienteA, cuentaBancoId, USUARIOS.socio],
    );
    reglaViejaId = reglaVieja[0]?.id ?? '';
    const reglaNueva = await tx.consultar<{ id: string }>(
      `insert into regla_imputacion
         (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo, decidido_por)
       values ($1, 'impuesto_debitos_creditos', 'fija', $2, '2026-09-01'::date, 'sintético 0040 wiring corregido', $3)
       returning id::text as id`,
      [s.clienteA, cuentaBancoId, USUARIOS.socio],
    );
    reglaNuevaId = reglaNueva[0]?.id ?? '';
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

function pedidoBaseCorreccion(): {
  readonly motivoCodigo: 'correccion_criterio_estudio';
  readonly reglaImputacionIdAnterior: string;
  readonly reglaImputacionIdNueva: string;
  readonly motivo: string;
  readonly hechoPor: string;
} {
  return {
    motivoCodigo: 'correccion_criterio_estudio',
    reglaImputacionIdAnterior: reglaViejaId,
    reglaImputacionIdNueva: reglaNuevaId,
    motivo: 'corrección sintética de wiring (0040)',
    hechoPor: USUARIOS.socio,
  };
}

function reprocesarNoRevisado(pedido: PedidoReprocesarAsientoNoRevisado) {
  return conUsuario(USUARIOS.socio, (tx) =>
    escribirConAuditoria(
      tx,
      { clienteId: pedido.clienteId, accion: 'escritura', recurso: 'asiento_propuesto', motivo: 'prueba de wiring del reproceso (0040)' },
      (ctx) => reprocesarAsientoNoRevisado(tx, ctx, pedido),
    ),
  );
}

function corregirEntregado(pedido: PedidoCorregirAsientoEntregado) {
  return conUsuario(USUARIOS.socio, (tx) =>
    escribirConAuditoria(
      tx,
      { clienteId: pedido.clienteId, accion: 'escritura', recurso: 'asiento_propuesto', motivo: 'prueba de wiring del reproceso (0040)' },
      (ctx) => corregirAsientoEntregado(tx, ctx, pedido),
    ),
  );
}

describe('0040 — reprocesarAsientoNoRevisado (Caso A, escenario 1 de la predicción falsable)', () => {
  it('asiento "propuesto" reprocesado: original → superseded, nuevo → propuesto con superseded_by_id, 1 fila de reproceso', async () => {
    const asientoViejoId = await conUsuario(USUARIOS.socio, (tx) => crearAsiento(tx, cierreAbiertoId, 'propuesto', renglonesSinteticos()));

    const r = await reprocesarNoRevisado({
      clienteId: s.clienteA,
      cierreId: cierreAbiertoId,
      tipo: 'devengamiento',
      asientoViejoId,
      fechaImputacion: '2026-06-15',
      renglones: renglonesSinteticos(),
      ...pedidoBaseCorreccion(),
    });
    expect(r.estado).toBe('reemplazado');
    if (r.estado !== 'reemplazado') throw new Error('unreachable');

    const viejo = await estadoDe(asientoViejoId);
    expect(viejo).toEqual({ asientoEstado: 'superseded', supersededById: r.asientoNuevoId });

    const nuevo = await estadoDe(r.asientoNuevoId);
    expect(nuevo.asientoEstado).toBe('propuesto');

    const reprocesos = await reprocesoDe(asientoViejoId);
    expect(reprocesos).toEqual([{ caso: 'reemplazo_no_revisado', asientoNuevoId: r.asientoNuevoId }]);
  });
});

describe('0040 — corregirAsientoEntregado (Caso B, escenario 2 de la predicción falsable)', () => {
  it('asiento "confirmado" corregido: original SIGUE confirmado intacto, nuevo ajuste_cierre con corrige_asiento_id, 1 fila de reproceso', async () => {
    const asientoOriginalId = await conUsuario(USUARIOS.socio, (tx) => crearAsiento(tx, cierreAbiertoId, 'confirmado', renglonesSinteticos()));

    const r = await corregirEntregado({
      clienteId: s.clienteA,
      cierreIdActual: cierreAbiertoId,
      asientoOriginalId,
      fechaImputacion: '2026-06-20',
      renglones: renglonesSinteticos(),
      ...pedidoBaseCorreccion(),
    });

    const original = await estadoDe(asientoOriginalId);
    expect(original).toEqual({ asientoEstado: 'confirmado', supersededById: null });

    const ajuste = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ tipo: string; corrige_asiento_id: string | null; asiento_estado: string }>(
        `select tipo, corrige_asiento_id::text as corrige_asiento_id, asiento_estado from asiento_propuesto where id = $1`,
        [r.asientoAjusteId],
      );
      return f[0];
    });
    expect(ajuste).toEqual({ tipo: 'ajuste_cierre', corrige_asiento_id: asientoOriginalId, asiento_estado: 'propuesto' });

    const reprocesos = await reprocesoDe(asientoOriginalId);
    expect(reprocesos).toEqual([{ caso: 'ajuste_ya_entregado', asientoNuevoId: r.asientoAjusteId }]);
  });
});

describe('0040 — la carrera: reprocesar dos veces el mismo asiento "propuesto" (escenario 4)', () => {
  it('la segunda corrida da 0 filas afectadas → {estado:"conflicto", motivoCodigo:"asiento_ya_no_estaba_propuesto"}, sin throw', async () => {
    const asientoViejoId = await conUsuario(USUARIOS.socio, (tx) => crearAsiento(tx, cierreAbiertoId, 'propuesto', renglonesSinteticos()));

    const pedido: PedidoReprocesarAsientoNoRevisado = {
      clienteId: s.clienteA,
      cierreId: cierreAbiertoId,
      tipo: 'devengamiento',
      asientoViejoId,
      fechaImputacion: '2026-06-15',
      renglones: renglonesSinteticos(),
      ...pedidoBaseCorreccion(),
    };

    const primera = await reprocesarNoRevisado(pedido);
    expect(primera.estado).toBe('reemplazado');

    // 🔴 Mismo asientoViejoId: ya está 'superseded' — simula la carrera (dos corridas del CLI sobre
    // el mismo lote, o una confirmación concurrente entre el listado y la aplicación).
    const segunda = await reprocesarNoRevisado(pedido);
    expect(segunda).toEqual({ estado: 'conflicto', motivoCodigo: 'asiento_ya_no_estaba_propuesto' });

    // El conflicto no debe haber dejado un segundo superseded_by_id ni una segunda fila de reproceso.
    const viejo = await estadoDe(asientoViejoId);
    expect(viejo.asientoEstado).toBe('superseded');
    const reprocesos = await reprocesoDe(asientoViejoId);
    expect(reprocesos.length, 'el intento en conflicto no debe agregar una segunda fila de reproceso').toBe(1);
  });
});
