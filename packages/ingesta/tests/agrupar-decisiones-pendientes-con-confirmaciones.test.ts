/**
 * `agruparDecisionesPendientesConConfirmaciones` — la capa que orquesta el cruce con
 * `confirmacion_grupo`, contra base real.
 *
 * Cubre: un grupo confirmado (`confirmarGrupo()`, escrito en la MISMA sesión de test) deja de
 * mostrarse como pendiente en la próxima lectura — sin correr `agruparDecisionesPendientes` puro
 * primero (que seguiría mostrándolo con `cuentaPropuesta: null`/`requiereRevision: true`); Capa D
 * nunca se pisa con una confirmación vigente; sin confirmaciones el resultado es idéntico al de la
 * función base; y un `estado: 'abortado'` de la función base se propaga tal cual, sin tocar la base
 * para nada de `confirmacion_grupo`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, corriendo contra LOCAL.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, confirmarGrupo, conUsuario, escribirConAuditoria, type Tx } from '@sistema-contable/data';
import { agruparDecisionesPendientes, agruparDecisionesPendientesConConfirmaciones } from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';

let s: Sembrado;
let filaSeq = 0;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

const BANCO_CODIGO = 'banco_agrupar_dec_confirma';
const DESDE = '2026-06-01';
const HASTA = '2026-06-30';

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

/** Un cliente sintético propio por bloque — mismo patrón que `agrupar-decisiones-pendientes.test.ts`. */
async function clienteFresco(nombre: string): Promise<{ clienteId: string; cuentaBancariaId: string }> {
  const duenio = await clienteDuenio();
  let clienteId = '';
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      BANCO_CODIGO,
      'Banco Ficticio Agrupar Decisiones Confirmaciones',
    ]);
    const f = await duenio.query<{ id: string }>(
      `insert into tenant_node (tipo, nombre, parent_id) values ('cliente', $1, $2) returning id`,
      [nombre, s.estudio],
    );
    clienteId = f.rows[0]?.id ?? '';
  } finally {
    await duenio.end();
  }

  return conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cuenta = await una(
      ej,
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, $2, 'ARS') returning id::text as id`,
      [clienteId, BANCO_CODIGO],
    );
    return { clienteId, cuentaBancariaId: String(cuenta['id']) };
  });
}

async function agregarMembresiaContador(clienteId: string, userId: string): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'contador'::app.rol_membership)`,
      [userId, clienteId],
    );
  } finally {
    await duenio.end();
  }
}

/** Un movimiento `propuesta`/`decision_humana` real, con su `reconocimiento_movimiento` — mismo
 *  fixture que `agrupar-decisiones-pendientes.test.ts` (mismo motivo de `PERMITIDOS_PROPUESTA` en
 *  R-F: construye el PEDIDO de persistencia, nunca un objeto `Reconocimiento` armado a mano). */
async function crearMovimiento(args: {
  readonly clienteId: string;
  readonly cuentaBancariaId: string;
  readonly conceptoBanco: string;
  readonly importe: string;
  readonly fecha: string;
  readonly clase: 'propuesta' | 'decision_humana';
  readonly tipo: string;
  readonly queDecide: string | null;
}): Promise<string> {
  filaSeq += 1;
  return conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const lote = await una(
      ej,
      `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
       values ($1, $2, 'agrupar-decisiones-pendientes-con-confirmaciones@fixture', 'archivo', $3, 'procesado', true) returning id::text as id`,
      [args.clienteId, BANCO_CODIGO, randomUUID()],
    );
    await ej(
      `insert into lote_ingesta_cuenta (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, $4::date, $4::date, 'no_verificable')`,
      [args.clienteId, String(lote['id']), args.cuentaBancariaId, args.fecha],
    );
    const movimiento = await una(
      ej,
      `insert into movimiento_bancario_crudo
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
          concepto_banco, concepto_banco_estrategia, concepto_completo, importe, contraparte_captura)
       values ($1, $2, $3, $4, $5, $6::date, 'movimiento fixture agrupar-decisiones-pendientes-con-confirmaciones', $7,
               'columna_propia', true, $8, 'no_capturado')
       returning id::text as id, entrada_digest`,
      [args.clienteId, String(lote['id']), args.cuentaBancariaId, filaSeq, randomUUID(), args.fecha, args.conceptoBanco, args.importe],
    );
    const movimientoId = String(movimiento['id']);
    await ej(
      `insert into reconocimiento_movimiento
         (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
          lado, que_decide, via, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados, evidencia_hubo_cola)
       values ($1, $2, 'e2e00000e2e00004', $3, $4, $5, 'transferencia_a_terceros', 'normal', 'haber', $6,
               'texto_literal_exacto', 'fixture.agrupar_decisiones_confirmaciones', 10, false)`,
      [args.clienteId, movimientoId, String(movimiento['entrada_digest']), args.clase, args.tipo, args.queDecide],
    );
    return movimientoId;
  });
}

/** Un `asiento_propuesto_renglon` REAL (Capa D) citando el movimiento por `referencia_origen` — la
 *  fuente de `cuentaPropuesta` por unanimidad. Mismo fixture que `agrupar-decisiones-pendientes.test.ts`. */
async function marcarConCuentaReal(args: {
  readonly clienteId: string;
  readonly movimientoId: string;
  readonly fecha: string;
  readonly codigo: string;
  readonly denominacion: string;
}): Promise<void> {
  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
       values ($1, 'mensual', $2::date, $2::date) returning id::text as id`,
      [args.clienteId, args.fecha],
    );
    const asiento = await una(
      ej,
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', $3::date) returning id::text as id`,
      [args.clienteId, String(cierre['id']), args.fecha],
    );
    const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [args.clienteId]);
    const cuentaRef = JSON.stringify({ codigo: args.codigo, denominacion: args.denominacion, rolFuncional: 'generica' });
    await ej(
      `insert into asiento_propuesto_renglon
         (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion, referencia_origen)
       values ($1, $2, 1, $3, $4::jsonb, 100.00, 0, $5::date, $6)`,
      [args.clienteId, String(asiento['id']), String(cuenta['id']), cuentaRef, args.fecha, args.movimientoId],
    );
  });
}

/** Una cuenta del PLAN (`cuenta` + `cuenta_atributo` vigente) — la que va a confirmar Laura. Distinta
 *  de `marcarConCuentaReal`: esa graba solo el JSON congelado (`cuenta_ref`) de un asiento ya
 *  propuesto, esta da de alta una cuenta real y vigente del plan, que es lo que
 *  `leerPlanDeCuentasCompleto` necesita para resolver `confirmacion_grupo.cuenta_id` a
 *  `{codigo, denominacion}`. */
async function altaCuentaDelPlan(args: {
  readonly clienteId: string;
  readonly codigo: string;
  readonly denominacion: string;
}): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [args.clienteId]);
    const cuentaId = String(cuenta['id']);
    await ej(
      `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
       values ($1, $2, $3, $4, 1, 'generica', '2026-01-01', 'alta fixture agrupar-decisiones-pendientes-con-confirmaciones')`,
      [args.clienteId, cuentaId, args.codigo, args.denominacion],
    );
    return cuentaId;
  });
}

/** Confirma un grupo `(bancoCodigo, conceptoBanco)` — mismo patrón que `confirmar-grupo.ts`
 *  (`escribirConAuditoria` + `confirmarGrupo`), llamado directo en el test. */
async function confirmarGrupoDeTest(args: {
  readonly clienteId: string;
  readonly bancoCodigo: string;
  readonly conceptoBanco: string | null;
  readonly cuentaId: string;
}): Promise<void> {
  await conUsuario(USUARIOS.contadorA, (tx) =>
    escribirConAuditoria(
      tx,
      {
        clienteId: args.clienteId,
        accion: 'escritura',
        recurso: 'confirmacion_grupo',
        motivo: `test agrupar-decisiones-pendientes-con-confirmaciones: (${args.bancoCodigo}, ${args.conceptoBanco ?? 'sin concepto'})`,
      },
      (_ctx) =>
        confirmarGrupo(tx, _ctx, {
          clienteId: args.clienteId,
          bancoCodigo: args.bancoCodigo,
          conceptoBanco: args.conceptoBanco,
          cuentaId: args.cuentaId,
          respaldo: 'respaldo de prueba, confirmación de grupo por Laura (fixture de test)',
          confirmadoPor: USUARIOS.contadorA,
          revocaId: null,
        }),
    ),
  );
}

// -----------------------------------------------------------------------------
// El caso central: un grupo confirmado en la MISMA sesión deja de aparecer como pendiente
// -----------------------------------------------------------------------------

describe('agruparDecisionesPendientesConConfirmaciones — un grupo recién confirmado deja de requerir revisión', () => {
  it('sin confirmar: cuentaPropuesta null y requiereRevision true; confirmado DESPUÉS: cuentaPropuesta con la cuenta confirmada y requiereRevision false, en la misma sesión', async () => {
    const { clienteId, cuentaBancariaId } = await clienteFresco('CLIENTE CONFIRMACION LLENA HUECO');
    await agregarMembresiaContador(clienteId, USUARIOS.contadorA);

    // Grupo sin ningún asiento real (Capa D no propuso nada) — cuentaPropuesta queda null en la
    // función base.
    await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'PAGO SERVICIO LUZ',
      importe: '-75.00',
      fecha: '2026-06-05',
      clase: 'decision_humana',
      tipo: 'indeterminado',
      queDecide: 'confirmar_cuenta_propia_destino',
    });

    const antesDeConfirmar = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientesConConfirmaciones(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    if (antesDeConfirmar.estado !== 'ok') throw new Error(`se esperaba 'ok': ${antesDeConfirmar.motivoCodigo}`);
    expect(antesDeConfirmar.grupos).toHaveLength(1);
    expect(antesDeConfirmar.grupos[0]?.cuentaPropuesta).toBeNull();
    expect(antesDeConfirmar.grupos[0]?.requiereRevision).toBe(true);

    const cuentaId = await altaCuentaDelPlan({ clienteId, codigo: '5.2.3', denominacion: 'Servicios' });
    await confirmarGrupoDeTest({ clienteId, bancoCodigo: BANCO_CODIGO, conceptoBanco: 'PAGO SERVICIO LUZ', cuentaId });

    // La función BASE, llamada de nuevo, no cambia — nunca lee `confirmacion_grupo` (contrato
    // congelado de `agrupar-decisiones-pendientes.ts`).
    const baseDespues = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientes(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    if (baseDespues.estado !== 'ok') throw new Error(`se esperaba 'ok': ${baseDespues.motivoCodigo}`);
    expect(baseDespues.grupos[0]?.cuentaPropuesta).toBeNull();
    expect(baseDespues.grupos[0]?.requiereRevision).toBe(true);

    // La función COMBINADA, en la MISMA sesión, ya no muestra el grupo como pendiente.
    const despuesDeConfirmar = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientesConConfirmaciones(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    if (despuesDeConfirmar.estado !== 'ok') throw new Error(`se esperaba 'ok': ${despuesDeConfirmar.motivoCodigo}`);
    expect(despuesDeConfirmar.grupos).toHaveLength(1);
    expect(despuesDeConfirmar.grupos[0]?.cuentaPropuesta).toEqual({ codigo: '5.2.3', denominacion: 'Servicios' });
    expect(despuesDeConfirmar.grupos[0]?.requiereRevision).toBe(false);
    // El resto del grupo no cambia por el cruce — mismos totales que la función base.
    expect(despuesDeConfirmar.grupos[0]?.totalDebito).toBe(baseDespues.grupos[0]?.totalDebito);
    expect(despuesDeConfirmar.grupos[0]?.cantidad).toBe(baseDespues.grupos[0]?.cantidad);
  });

  it('Capa D con unanimidad real NUNCA se pisa con una confirmación vigente, aunque apunte a otra cuenta', async () => {
    const { clienteId, cuentaBancariaId } = await clienteFresco('CLIENTE CAPA D NO SE PISA');
    await agregarMembresiaContador(clienteId, USUARIOS.contadorA);

    const mov = await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'TRANSFERENCIA PROVEEDOR CAPA D',
      importe: '-40.00',
      fecha: '2026-06-05',
      clase: 'propuesta',
      tipo: 'cobranza_de_cliente',
      queDecide: null,
    });
    await marcarConCuentaReal({ clienteId, movimientoId: mov, fecha: '2026-06-05', codigo: '5.1.1', denominacion: 'Proveedores (Capa D)' });

    // Confirmación vigente para la MISMA clave, apuntando a OTRA cuenta — si esto pisara Capa D, el
    // test de abajo fallaría.
    const cuentaId = await altaCuentaDelPlan({ clienteId, codigo: '9.9.9', denominacion: 'Cuenta que NUNCA debería aparecer' });
    await confirmarGrupoDeTest({ clienteId, bancoCodigo: BANCO_CODIGO, conceptoBanco: 'TRANSFERENCIA PROVEEDOR CAPA D', cuentaId });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientesConConfirmaciones(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    if (r.estado !== 'ok') throw new Error(`se esperaba 'ok': ${r.motivoCodigo}`);
    expect(r.grupos).toHaveLength(1);
    expect(r.grupos[0]?.cuentaPropuesta).toEqual({ codigo: '5.1.1', denominacion: 'Proveedores (Capa D)' });
    expect(r.grupos[0]?.requiereRevision).toBe(false);
  });

  // 🔴 AGREGADO (code-reviewer, revisión de este PR): un grupo `distinguir_tercero_de_socio` recibe de
  // `agruparFilas` una clave INDIVIDUAL sufijada `::individual:<filaNumero>` (`armar-libro.ts:916-938`)
  // — justo para que dos movimientos que comparten el mismo texto genérico del banco, pero son
  // contrapartes DISTINTAS, nunca se traten como el mismo grupo (incidente #14). Antes de este test, la
  // función combinada recomputaba `claveDeAgrupacion(bancoCodigo, conceptoBanco)` ignorando ese sufijo:
  // una confirmación vigente para `(bancoCodigo, conceptoBanco)` se colaba en TODO movimiento individual
  // que compartiera esa glosa, asignándole en silencio la cuenta de "el resto del concepto" a una
  // contraparte que Laura todavía no distinguió — ~77% de `decision_humana` en los clientes reales del
  // piloto es justamente `distinguir_tercero_de_socio`. Sin este test, ese camino nunca se ejercitaba.
  it('un grupo distinguir_tercero_de_socio (clave individual) NUNCA cruza con una confirmación, aunque comparta banco/concepto con un grupo agrupable que sí confirmado', async () => {
    const { clienteId, cuentaBancariaId } = await clienteFresco('CLIENTE INDIVIDUAL NUNCA CRUZA');
    await agregarMembresiaContador(clienteId, USUARIOS.contadorA);

    // Mismo (bancoCodigo, conceptoBanco) para los dos — si el cruce ignorara `g.clave`, los dos
    // terminarían con la misma cuenta confirmada.
    await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'ING TRANSF: JUAN PEREZ',
      importe: '300.00',
      fecha: '2026-06-05',
      clase: 'decision_humana',
      tipo: 'indeterminado',
      queDecide: 'confirmar_cuenta_propia_destino', // agrupable: clave "normal", SÍ puede cruzar
    });
    await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'ING TRANSF: JUAN PEREZ', // MISMO concepto, a propósito
      importe: '400.00',
      fecha: '2026-06-06',
      clase: 'decision_humana',
      tipo: 'indeterminado',
      queDecide: 'distinguir_tercero_de_socio', // el ÚNICO valor que hace clave individual
    });

    const cuentaId = await altaCuentaDelPlan({ clienteId, codigo: '4.4.4', denominacion: 'Cuenta confirmada del grupo normal' });
    await confirmarGrupoDeTest({ clienteId, bancoCodigo: BANCO_CODIGO, conceptoBanco: 'ING TRANSF: JUAN PEREZ', cuentaId });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientesConConfirmaciones(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    if (r.estado !== 'ok') throw new Error(`se esperaba 'ok': ${r.motivoCodigo}`);
    expect(r.grupos).toHaveLength(2);

    const grupoNormal = r.grupos.find((g) => g.clave === `${BANCO_CODIGO}::ING TRANSF: JUAN PEREZ`);
    expect(grupoNormal).toBeDefined();
    expect(grupoNormal?.cuentaPropuesta).toEqual({ codigo: '4.4.4', denominacion: 'Cuenta confirmada del grupo normal' });
    expect(grupoNormal?.requiereRevision).toBe(false);

    const grupoIndividual = r.grupos.find((g) => g.clave !== `${BANCO_CODIGO}::ING TRANSF: JUAN PEREZ`);
    expect(grupoIndividual).toBeDefined();
    expect(grupoIndividual?.clave).toContain('::individual:');
    // El grupo individual NUNCA cruza — sigue sin cuenta y pidiendo revisión, aunque comparta
    // banco/concepto con el grupo que sí tiene confirmación vigente.
    expect(grupoIndividual?.cuentaPropuesta).toBeNull();
    expect(grupoIndividual?.requiereRevision).toBe(true);
  });

  it('sin ninguna confirmación vigente para el cliente, el resultado es idéntico al de la función base', async () => {
    const { clienteId, cuentaBancariaId } = await clienteFresco('CLIENTE SIN CONFIRMACIONES');
    await agregarMembresiaContador(clienteId, USUARIOS.contadorA);

    await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'CONCEPTO SIN CONFIRMAR',
      importe: '10.00',
      fecha: '2026-06-05',
      clase: 'decision_humana',
      tipo: 'indeterminado',
      queDecide: 'confirmar_cuenta_propia_destino',
    });

    const base = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientes(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    const combinado = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientesConConfirmaciones(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    expect(combinado).toEqual(base);
  });

  it('un clienteId inválido se propaga tal cual (abortado), sin tocar `confirmacion_grupo`', async () => {
    await conUsuario(USUARIOS.socio, async (tx) => {
      const r = await agruparDecisionesPendientesConConfirmaciones(tx, { clienteId: 'no-es-un-uuid', desde: DESDE, hasta: HASTA });
      expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'cliente_id_invalido' });
    });
  });
});
