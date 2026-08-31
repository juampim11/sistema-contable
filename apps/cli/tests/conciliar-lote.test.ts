/**
 * Test de integración del Ítem E (Sesión 2b) contra LOCAL, con un tenant sintético — nunca el
 * piloto. Ejercita el camino completo: `reconocimiento_movimiento` + `movimiento_bancario_crudo`
 * (D-26) → resolver puro (`packages/motor-conciliacion`) → `asiento_propuesto_renglon` o
 * `pendiente_cierre`, vía `conciliarLote()`.
 *
 * El plan de cuentas del fixture es enteramente FICTICIO — códigos y denominaciones inventados para
 * este test, nunca copiados de `privado/` (memoria del proyecto: "Números reales en fixtures no
 * solo CUIT").
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { cerrarConexiones, conUsuario, type Tx } from '@sistema-contable/data';
import { conciliarLote } from '../src/conciliar-lote.ts';

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

const BANCO_CODIGO = 'banco_ficticio_e2e';

async function crearBancoSiNoExiste(): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      BANCO_CODIGO,
      'Banco Ficticio de Prueba E2E',
    ]);
  } finally {
    await duenio.end();
  }
}

/** Arma un plan de cuentas + reglas + lote + movimiento + reconocimiento mínimos, todo ficticio. */
async function armarFixtureCompleto(
  ej: Ejecutar,
  clienteId: string,
  opciones: {
    readonly tipoMovimiento: string;
    readonly concepto: string;
    readonly via: string;
    readonly lado: 'debe' | 'haber';
    readonly conRegla: boolean;
    readonly conCuentaBancoMapeada: boolean;
    /** Default junio 2026 — pasar otro período si el mismo cliente arma más de un fixture en el
     *  mismo test file (`uq_cierre_periodo_vigente` es único por cliente+período). */
    readonly periodo?: { readonly desde: string; readonly hasta: string };
  },
): Promise<{ readonly loteId: string; readonly cierreId: string; readonly cuentaBancoContableId: string; readonly cuentaGastosId: string }> {
  const periodoDesde = opciones.periodo?.desde ?? '2026-06-01';
  const periodoHasta = opciones.periodo?.hasta ?? '2026-06-30';
  const fechaMovimiento = `${periodoDesde.slice(0, 8)}15`; // día 15 del mismo mes del período

  const cuentaBanco = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [clienteId]);
  const cuentaBancoContableId = String(cuentaBanco['id']);
  await ej(
    `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
     values ($1, $2, '1.1.2.100', 'Banco Ficticio Cta Cte', 4, 'generica', '2026-01-01', 'fixture E2E')`,
    [clienteId, cuentaBancoContableId],
  );

  const cuentaGastos = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [clienteId]);
  const cuentaGastosId = String(cuentaGastos['id']);
  await ej(
    `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
     values ($1, $2, '4.2.5.200', 'Gastos y comisiones bancarias (ficticia)', 4, 'generica', '2026-01-01', 'fixture E2E')`,
    [clienteId, cuentaGastosId],
  );

  const cuentaBancaria = await una(
    ej,
    `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, $2, 'ARS') returning id::text as id`,
    [clienteId, BANCO_CODIGO],
  );
  const cuentaBancariaId = String(cuentaBancaria['id']);
  if (opciones.conCuentaBancoMapeada) {
    await ej(`update cuenta_bancaria set cuenta_id = $1 where id = $2`, [cuentaBancoContableId, cuentaBancariaId]);
  }

  if (opciones.conRegla) {
    await ej(
      `insert into regla_imputacion
         (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo, decidido_por)
       values ($1, $2, 'fija', $3, '2026-01-01', 'fixture E2E', $4)`,
      [clienteId, opciones.tipoMovimiento, cuentaGastosId, USUARIOS.socio],
    );
  }

  const lote = await una(
    ej,
    `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
     values ($1, $2, 'e2e@fixture', 'archivo', $3, 'procesado') returning id::text as id`,
    [clienteId, BANCO_CODIGO, randomUUID()],
  );
  const loteId = String(lote['id']);

  await ej(
    `insert into lote_ingesta_cuenta
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
     values ($1, $2, $3, $4::date, $5::date, 'no_verificable')`,
    [clienteId, loteId, cuentaBancariaId, periodoDesde, periodoHasta],
  );

  const movimiento = await una(
    ej,
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, concepto_banco_estrategia, contraparte_captura)
     values ($1, $2, $3, 1, $4, $5::date, 'movimiento ficticio E2E', $6, 'no_capturado', 'no_capturado')
     returning id::text as id, entrada_digest`,
    [clienteId, loteId, cuentaBancariaId, randomUUID(), fechaMovimiento, opciones.lado === 'debe' ? '-1500.00' : '1500.00'],
  );
  const movimientoId = String(movimiento['id']);
  // Generada (`0021`) — un trigger de `reconocimiento_movimiento` exige que la aplicación DECLARE
  // el mismo valor que el movimiento tiene en el instante del insert (nunca se copia sola).
  const entradaDigest = String(movimiento['entrada_digest']);

  await ej(
    `insert into reconocimiento_movimiento
       (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
        lado, via, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados, evidencia_hubo_cola)
     values ($1, $2, 'e2e00000e2e00000', $3, 'propuesta', $4, $5, 'normal', $6, $7, 'fixture.e2e', 10, false)`,
    [clienteId, movimientoId, entradaDigest, opciones.tipoMovimiento, opciones.concepto, opciones.lado, opciones.via],
  );

  const cierre = await una(
    ej,
    `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
     values ($1, 'mensual', $2::date, $3::date) returning id::text as id`,
    [clienteId, periodoDesde, periodoHasta],
  );
  const cierreId = String(cierre['id']);

  return { loteId, cierreId, cuentaBancoContableId, cuentaGastosId };
}

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
  await crearBancoSiNoExiste();
});

afterAll(async () => {
  await cerrarConexiones();
});

describe('conciliarLote — camino feliz, contra LOCAL con tenant sintético', () => {
  it('cardinalidad cerrada, regla fija, vía calificada, banco mapeado → asiento_propuesto_renglon real', async () => {
    const { loteId, cierreId, cuentaBancoContableId, cuentaGastosId } = await comoSocio((ej) =>
      armarFixtureCompleto(ej, s.clienteA, {
        tipoMovimiento: 'comision_bancaria',
        concepto: 'comision_de_mantenimiento_de_cuenta',
        via: 'texto_literal_exacto',
        lado: 'debe',
        conRegla: true,
        conCuentaBancoMapeada: true,
      }),
    );

    const reporte = await conciliarLote({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, cierreId, aplicar: true });
    expect(reporte.estado).toBe('reportado');
    if (reporte.estado !== 'reportado') return;
    expect(reporte.automaticos).toBe(1);
    expect(reporte.asientosCreados).toBe(1);
    expect(reporte.pendientesCreados).toBe(0);

    const renglones = await comoSocio((ej) =>
      ej(
        `select cuenta_id::text as cuenta_id, debe::text as debe, haber::text as haber, orden
           from asiento_propuesto_renglon r
           join asiento_propuesto a on a.cliente_id = r.cliente_id and a.id = r.asiento_id
          where a.cierre_id = $1 order by orden`,
        [cierreId],
      ),
    );
    expect(renglones).toHaveLength(2);
    const banco = renglones.find((r) => r['cuenta_id'] === cuentaBancoContableId);
    const contrapartida = renglones.find((r) => r['cuenta_id'] === cuentaGastosId);
    expect(banco, 'el renglón de banco tiene que existir con la cuenta mapeada').toBeTruthy();
    expect(contrapartida, 'el renglón de contrapartida tiene que existir con la cuenta de la regla').toBeTruthy();
    // lado='debe' es el lado de la CONTRAPARTIDA (04§2) — banco es el opuesto.
    expect(contrapartida?.['debe']).toBe('1500.00');
    expect(banco?.['haber']).toBe('1500.00');
  });

  it('dry-run (sin --aplicar): reporta pero no escribe ninguna fila', async () => {
    const { loteId, cierreId } = await comoSocio((ej) =>
      armarFixtureCompleto(ej, s.clienteA, {
        tipoMovimiento: 'deposito_efectivo',
        concepto: 'deposito_de_efectivo',
        via: 'texto_literal_exacto',
        lado: 'haber',
        conRegla: true,
        conCuentaBancoMapeada: true,
        periodo: { desde: '2026-07-01', hasta: '2026-07-31' }, // distinto del camino feliz (mismo clienteA)
      }),
    );

    const reporte = await conciliarLote({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, cierreId, aplicar: false });
    expect(reporte.estado).toBe('reportado');
    if (reporte.estado !== 'reportado') return;
    expect(reporte.aplicado).toBe(false);
    expect(reporte.automaticos).toBe(1);

    const renglones = await comoSocio((ej) =>
      ej(`select 1 from asiento_propuesto_renglon r
            join asiento_propuesto a on a.cliente_id = r.cliente_id and a.id = r.asiento_id
           where a.cierre_id = $1`, [cierreId]),
    );
    expect(renglones).toHaveLength(0);
  });
});

describe('conciliarLote — cardinalidad abierta sin regla cargada, contra LOCAL', () => {
  it('pago_a_proveedor_transferencia SIN regla configurada cae a pendiente_cierre, nunca automático', async () => {
    const { loteId, cierreId } = await comoSocio((ej) =>
      armarFixtureCompleto(ej, s.clienteB, {
        tipoMovimiento: 'pago_a_proveedor_transferencia',
        concepto: 'pago_a_proveedor_inmediato',
        via: 'texto_literal_exacto',
        lado: 'debe',
        conRegla: false, // a propósito: cardinalidad abierta, ninguna regla estática
        conCuentaBancoMapeada: true,
      }),
    );

    const reporte = await conciliarLote({ cliente: s.clienteB, usuario: USUARIOS.socio, loteId, cierreId, aplicar: true });
    expect(reporte.estado).toBe('reportado');
    if (reporte.estado !== 'reportado') return;
    expect(reporte.automaticos).toBe(0);
    expect(reporte.asientosCreados).toBe(0);
    expect(reporte.pendientesCreados).toBe(1);
    expect(reporte.pendientesPorMotivo['tipo_sin_regla_imputacion']).toBe(1);

    const pendientes = await comoSocio((ej) =>
      ej(`select motivo_codigo, evidencia from pendiente_cierre where cierre_id = $1`, [cierreId]),
    );
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]?.['motivo_codigo']).toBe('tipo_sin_regla_imputacion');
  });
});
