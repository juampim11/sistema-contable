/**
 * `alta-regla-imputacion.ts` — ÚNICO productor de `regla_imputacion` (0030, verificado antes de
 * escribir este CLI: no existía ninguno). Cubre el parseo de argumentos, la resolución de la cuenta
 * REAL (nunca inventada), el conteo del dry-run reusando el MISMO criterio de exclusión que
 * `leerReconocimientosParaImputar` (JP, 2026-09-10 — no una tercera versión del cálculo), el alta
 * real y su duplicado (`YA_EXISTE_REGLA_VIGENTE`), y el rol insuficiente.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, corriendo contra LOCAL.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { cerrarConexiones, conUsuario, type Tx } from '@sistema-contable/data';
import { correrAltaReglaImputacion, parsearArgumentos } from '../src/alta-regla-imputacion.ts';

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

const BANCO_CODIGO = 'banco_alta_regla_imputacion';
const CODIGO_CUENTA = '1.2.1.900';

let s: Sembrado;
let filaSeq = 0;

beforeAll(async () => {
  s = await sembrar();
  const duenio = await clienteDuenio();
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      BANCO_CODIGO,
      'Banco Ficticio Alta Regla Imputacion',
    ]);
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Cliente sintético propio por `it` — mismo patrón que `manifestar-padron.test.ts`, así cada test
 *  parte de "sin regla vigente todavía", sin estado compartido entre `it`s. */
async function clienteFresco(): Promise<{ clienteId: string; cuentaBancariaId: string; cuentaContableId: string }> {
  const duenio = await clienteDuenio();
  let clienteId = '';
  try {
    const f = await duenio.query<{ id: string }>(
      `insert into tenant_node (tipo, nombre, parent_id) values ('cliente', 'CLIENTE ALTA REGLA IMPUTACION', $1) returning id`,
      [s.estudio],
    );
    clienteId = f.rows[0]?.id ?? '';
  } finally {
    await duenio.end();
  }

  return conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [clienteId]);
    const cuentaContableId = String(cuenta['id']);
    await ej(
      `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
       values ($1, $2, $3, 'Deudores por Ventas (fixture)', 4, 'generica', '2026-01-01', 'fixture alta-regla-imputacion')`,
      [clienteId, cuentaContableId, CODIGO_CUENTA],
    );
    const cuentaBancaria = await una(
      ej,
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, $2, 'ARS') returning id::text as id`,
      [clienteId, BANCO_CODIGO],
    );
    return { clienteId, cuentaBancariaId: String(cuentaBancaria['id']), cuentaContableId };
  });
}

/** Un movimiento `propuesta` real del tipo pedido, SIN asiento — lo que el dry-run tiene que contar. */
async function crearMovimientoPropuestaSinAsiento(
  cuentaBancariaId: string,
  clienteId: string,
  tipo: string,
  concepto: string,
  fecha: string,
): Promise<string> {
  filaSeq += 1;
  return conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const lote = await una(
      ej,
      `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
       values ($1, $2, 'alta-regla-imputacion@fixture', 'archivo', $3, 'procesado') returning id::text as id`,
      [clienteId, BANCO_CODIGO, randomUUID()],
    );
    await ej(
      `insert into lote_ingesta_cuenta (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, $4::date, $4::date, 'no_verificable')`,
      [clienteId, String(lote['id']), cuentaBancariaId, fecha],
    );
    const movimiento = await una(
      ej,
      `insert into movimiento_bancario_crudo
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
          importe, concepto_banco_estrategia, contraparte_captura)
       values ($1, $2, $3, $4, $5, $6::date, 'movimiento fixture alta-regla-imputacion', '-500.00', 'no_capturado', 'no_capturado')
       returning id::text as id, entrada_digest`,
      [clienteId, String(lote['id']), cuentaBancariaId, filaSeq, randomUUID(), fecha],
    );
    const movimientoId = String(movimiento['id']);
    await ej(
      `insert into reconocimiento_movimiento
         (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
          lado, via, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados, evidencia_hubo_cola)
       values ($1, $2, 'e2e00000e2e00002', $3, 'propuesta', $4, $5, 'normal', 'haber', 'texto_literal_exacto',
               'fixture.alta_regla', 10, false)`,
      [clienteId, movimientoId, String(movimiento['entrada_digest']), tipo, concepto],
    );
    return movimientoId;
  });
}

/** Marca un movimiento como YA IMPUTADO (asiento_propuesto_renglon citándolo) — para probar que el
 *  conteo del dry-run lo EXCLUYE, mismo criterio que `leerReconocimientosParaImputar`. */
async function marcarComoYaImputado(clienteId: string, cuentaContableId: string, movimientoId: string, fecha: string): Promise<void> {
  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
       values ($1, 'mensual', $2::date, $2::date) returning id::text as id`,
      [clienteId, fecha],
    );
    const asiento = await una(
      ej,
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', $3::date) returning id::text as id`,
      [clienteId, String(cierre['id']), fecha],
    );
    await ej(
      `insert into asiento_propuesto_renglon (cliente_id, asiento_id, orden, cuenta_id, debe, haber, fecha_imputacion, referencia_origen)
       values ($1, $2, 1, $3, 0, 500.00, $4::date, $5)`,
      [clienteId, String(asiento['id']), cuentaContableId, fecha, movimientoId],
    );
  });
}

// -----------------------------------------------------------------------------
// parsearArgumentos
// -----------------------------------------------------------------------------

describe('parsearArgumentos', () => {
  const base = [
    '--cliente',
    randomUUID(),
    '--usuario',
    randomUUID(),
    '--tipo',
    'cobranza_de_cliente',
    '--cuenta-codigo',
    '1.2.1.100',
    '--vigente-desde',
    '2026-05-01',
    '--respaldo',
    'Dictamen contador-dominio, doc 31, HANDOFF 203/204.',
  ];

  it('parsea un alta completa (sin --aplicar)', () => {
    const r = parsearArgumentos(base);
    expect(r).toEqual({
      cliente: base[1],
      usuario: base[3],
      tipo: 'cobranza_de_cliente',
      cuentaCodigo: '1.2.1.100',
      vigenteDesde: '2026-05-01',
      respaldo: 'Dictamen contador-dominio, doc 31, HANDOFF 203/204.',
      aplicar: false,
    });
  });

  it('parsea --aplicar', () => {
    const r = parsearArgumentos([...base, '--aplicar']);
    expect(r.aplicar).toBe(true);
  });

  it('rechaza un --tipo fuera del vocabulario cerrado', () => {
    const conTipoInvalido = [...base];
    conTipoInvalido[5] = 'tipo_inventado';
    expect(() => parsearArgumentos(conTipoInvalido)).toThrow();
  });

  it('rechaza --respaldo demasiado corto ("ok")', () => {
    const conRespaldoCorto = [...base];
    conRespaldoCorto[11] = 'ok';
    expect(() => parsearArgumentos(conRespaldoCorto)).toThrow();
  });

  it('rechaza --vigente-desde con formato inválido', () => {
    const conFechaInvalida = [...base];
    conFechaInvalida[9] = '01/05/2026';
    expect(() => parsearArgumentos(conFechaInvalida)).toThrow();
  });
});

// -----------------------------------------------------------------------------
// correrAltaReglaImputacion — flujo real, base real
// -----------------------------------------------------------------------------

describe('correrAltaReglaImputacion — cuenta no encontrada', () => {
  it('código inexistente en el plan del cliente aborta CUENTA_NO_ENCONTRADA, nunca inventa un id', async () => {
    const { clienteId } = await clienteFresco();
    const r = await correrAltaReglaImputacion({
      cliente: clienteId,
      usuario: USUARIOS.socio,
      tipo: 'cobranza_de_cliente',
      cuentaCodigo: '9.9.9.999',
      vigenteDesde: '2026-05-01',
      respaldo: 'Dictamen contador-dominio, doc 31, HANDOFF 203/204.',
      aplicar: false,
    });
    expect(r).toMatchObject({ estado: 'abortado', motivoCodigo: 'CUENTA_NO_ENCONTRADA' });
  });
});

describe('correrAltaReglaImputacion — dry-run: cuenta resuelta + conteo reusando el criterio real', () => {
  it('resuelve la cuenta real y cuenta EXACTO los movimientos sin asiento — excluye el que ya tiene uno', async () => {
    const { clienteId, cuentaBancariaId, cuentaContableId } = await clienteFresco();

    const sinAsiento1 = await crearMovimientoPropuestaSinAsiento(cuentaBancariaId, clienteId, 'cobranza_de_cliente', 'acreditamiento', '2026-05-10');
    const sinAsiento2 = await crearMovimientoPropuestaSinAsiento(cuentaBancariaId, clienteId, 'cobranza_de_cliente', 'acreditamiento', '2026-05-11');
    const yaImputado = await crearMovimientoPropuestaSinAsiento(cuentaBancariaId, clienteId, 'cobranza_de_cliente', 'acreditamiento', '2026-05-12');
    await marcarComoYaImputado(clienteId, cuentaContableId, yaImputado, '2026-05-12');
    // Ruido: mismo cliente, tipo DISTINTO — no tiene que contar.
    await crearMovimientoPropuestaSinAsiento(cuentaBancariaId, clienteId, 'extraccion_efectivo', 'extraccion_efectivo_autoservicio', '2026-05-13');

    const r = await correrAltaReglaImputacion({
      cliente: clienteId,
      usuario: USUARIOS.socio,
      tipo: 'cobranza_de_cliente',
      cuentaCodigo: CODIGO_CUENTA,
      vigenteDesde: '2026-05-01',
      respaldo: 'Dictamen contador-dominio, doc 31, HANDOFF 203/204.',
      aplicar: false,
    });

    expect(r.estado).toBe('dry_run');
    if (r.estado !== 'dry_run') return;
    expect(r.reporte.cuentaResuelta?.codigo).toBe(CODIGO_CUENTA);
    expect(r.reporte.yaHayReglaVigente).toBe(false);
    // EXACTO 2 — sinAsiento1 y sinAsiento2, nunca 3 (excluye el ya imputado) ni más (excluye el otro tipo).
    expect(r.reporte.movimientosSinAsiento).toBe(2);
    void sinAsiento1;
    void sinAsiento2;
  });
});

describe('correrAltaReglaImputacion — flujo feliz y duplicado', () => {
  it('primera alta entra; una segunda para el mismo tipo aborta YA_EXISTE_REGLA_VIGENTE', async () => {
    const { clienteId } = await clienteFresco();

    const primera = await correrAltaReglaImputacion({
      cliente: clienteId,
      usuario: USUARIOS.socio,
      tipo: 'cobranza_de_cliente',
      cuentaCodigo: CODIGO_CUENTA,
      vigenteDesde: '2026-05-01',
      respaldo: 'Dictamen contador-dominio, doc 31, HANDOFF 203/204.',
      aplicar: true,
    });
    expect(primera.estado).toBe('aplicado');
    const reglaId = primera.estado === 'aplicado' ? primera.reglaImputacionId : '';
    expect(reglaId).toMatch(/^[0-9a-f-]{36}$/);

    // Verificado por consulta directa — nunca solo confiar en el reporte del CLI.
    const filaReal = await comoSocio((ej) =>
      ej(
        `select tipo_movimiento, concepto, cuenta_resolucion, cuenta_id::text as cuenta_id, respaldo, decidido_por::text as decidido_por
           from regla_imputacion where cliente_id = $1 and id = $2`,
        [clienteId, reglaId],
      ),
    );
    expect(filaReal[0]).toMatchObject({
      tipo_movimiento: 'cobranza_de_cliente',
      concepto: null,
      cuenta_resolucion: 'fija',
      decidido_por: USUARIOS.socio,
    });

    const segunda = await correrAltaReglaImputacion({
      cliente: clienteId,
      usuario: USUARIOS.socio,
      tipo: 'cobranza_de_cliente',
      cuentaCodigo: CODIGO_CUENTA,
      vigenteDesde: '2026-06-01',
      respaldo: 'Segundo intento — tiene que abortar antes de escribir.',
      aplicar: true,
    });
    expect(segunda).toMatchObject({ estado: 'abortado', motivoCodigo: 'YA_EXISTE_REGLA_VIGENTE' });

    // Confirmado que la segunda NO escribió una fila nueva.
    const cantidad = await comoSocio((ej) =>
      ej(`select 1 from regla_imputacion where cliente_id = $1 and tipo_movimiento = 'cobranza_de_cliente'`, [clienteId]),
    );
    expect(cantidad).toHaveLength(1);
  });
});

describe('correrAltaReglaImputacion — rol insuficiente', () => {
  it('🔴 administrativo no puede dar de alta (policy regla_imputacion_ins exige socio|contador)', async () => {
    // `administrativoA` (ayuda.ts) tiene membership real SOLO en `s.clienteA` (no en `s.estudio`) —
    // un `clienteFresco()` nuevo, sibling de `clienteA`, le sería invisible por RLS (0 filas, no un
    // error), y el test terminaría probando "sin acceso al tenant" en vez de "rol insuficiente". Por
    // eso este test usa `s.clienteA` con un código de cuenta propio, para no chocar con otras filas
    // de `cuenta_atributo` que otros archivos de test puedan haber sembrado ahí.
    const codigoPropio = `9.9.${(filaSeq += 1)}.001`;
    await conUsuario(USUARIOS.socio, async (tx) => {
      const ej = desdeTx(tx);
      const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [s.clienteA]);
      await ej(
        `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
         values ($1, $2, $3, 'Cuenta fixture rol insuficiente', 4, 'generica', '2026-01-01', 'fixture alta-regla-imputacion')`,
        [s.clienteA, String(cuenta['id']), codigoPropio],
      );
    });

    await expect(
      correrAltaReglaImputacion({
        cliente: s.clienteA,
        usuario: USUARIOS.administrativoA,
        tipo: 'cobranza_de_cliente',
        cuentaCodigo: codigoPropio,
        vigenteDesde: '2026-05-01',
        respaldo: 'Dictamen contador-dominio, doc 31, HANDOFF 203/204.',
        aplicar: true,
      }),
    ).rejects.toThrow();
  });
});
