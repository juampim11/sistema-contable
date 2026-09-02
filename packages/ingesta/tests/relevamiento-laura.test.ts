/**
 * RELEVAMIENTO PARA LAURA — contra Postgres LOCAL, con datos SINTÉTICOS (nunca `.env.piloto`, nunca un
 * uuid ni un nombre reales de Bracci o ROKA). `clienteA` de `sembrar()` hace el papel de "el primer
 * cliente de la tupla" (el que SÍ corre el bloque de `retiro_de_socio`); `clienteB` hace el papel del
 * segundo (el que NO). Cubre, contra la base real:
 *
 *   - El corte de la Hoja 1: un grupo con `cantidadMovimientos >= 3` va individual, uno con < 3 va al
 *     resumen (`grupos`/`movimientos` agregados).
 *   - `retiro_de_socio` NUNCA aparece en `tiposSinCuenta` (Hoja 2), aunque el cliente SÍ tenga un
 *     pendiente de ese tipo — la Hoja 1 lo muestra aparte, siempre completo, sin pasar por el corte.
 *   - `pago_de_haberes` aparece en `tiposSinCuenta` con su cantidad y su conteo de conceptos distintos.
 *   - La Hoja 3 reporta el total REAL (incluidas reversas) pero el ejemplo elegido es siempre de
 *     polaridad `normal`.
 *
 * `particionarContrapartes`/`agruparAsientosAutomaticos` (puras) se prueban aparte, sin base, en
 * `relevamiento-laura-puro.test.ts`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  altaPlanDeCuentas,
  cerrarConexiones,
  conUsuario,
  escribirAsientoAutomatico,
  escribirConAuditoria,
  escribirPendienteDeImputacion,
  persistirReconocimiento,
  type ContextoAuditado,
  type Tx,
} from '@sistema-contable/data';
import {
  CAPACIDADES_SINTETICAS,
  extractoSintetico,
  persistirCuenta,
  relevarParaLaura,
  verificarAritmetica,
  type CuentaConMovimientos,
  type EstadoLotePersistido,
} from '@sistema-contable/ingesta';
import { hmacDocumento, pepperIdActual } from '@sistema-contable/shared/seguridad';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
// Fixture — mismo patrón que `exportar-planilla-enriquecido.test.ts`: banco/cuenta/lote sintéticos,
// reconocimiento/pendiente/asiento vía las funciones REALES de escritura (nunca un INSERT a mano que
// tenga que reinventar el determinante de entrada — `entrada_digest` lo verifica un trigger).
// -----------------------------------------------------------------------------

const BANCO_CODIGO = 'sintetico';

async function registrarBanco(): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      BANCO_CODIGO,
      'BANCO SINTETICO',
    ]);
  } finally {
    await duenio.end();
  }
}

async function registrarCuentaBancaria(clienteId: string): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const c = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias) values ($1, $2, 'ARS', 'Cuenta de prueba')
       returning id::text as id`,
      [clienteId, BANCO_CODIGO],
    );
    const id = c[0]?.id;
    if (!id) throw new Error('no se creó la cuenta de prueba');
    return id;
  });
}

async function crearLotePersistido(clienteId: string, cuentaBancariaId: string, cuenta: CuentaConMovimientos): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const creado = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, procesado_por)
       values ($1, $2, $3, 'archivo', $4, 'recibido', app.current_user_id())
       returning id::text as id`,
      [clienteId, BANCO_CODIGO, `${BANCO_CODIGO}@1`, randomUUID()],
    );
    const loteId = creado[0]?.id;
    if (!loteId) throw new Error('no se creó el lote de prueba');

    const movimientosEnElLote = cuenta.movimientos.length;
    const verificacion = verificarAritmetica(cuenta, {
      capacidades: CAPACIDADES_SINTETICAS as never,
      movimientosEnElLote,
    });
    const persistido = await persistirCuenta(tx, {
      clienteId,
      loteId,
      cuentaBancariaId,
      cuenta,
      verificacion,
      movimientosEnElLote,
    });
    if (!persistido.persistido) {
      throw new Error(`fixture inválido: la cuenta debía persistir y no lo hizo (${persistido.motivoCodigo})`);
    }
    const estado: EstadoLotePersistido = persistido.estado;
    await tx.consultar(`update lote_ingesta set estado = $2, filas_leidas = $3, filas_aceptadas = $3 where id = $1`, [
      loteId,
      estado,
      movimientosEnElLote,
    ]);
    return loteId;
  });
}

async function idsDeMovimientos(clienteId: string, loteId: string): Promise<readonly string[]> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const filas = await tx.consultar<{ id: string }>(
      `select id::text as id from movimiento_bancario_crudo
        where cliente_id = $1 and lote_ingesta_id = $2
        order by fila_numero`,
      [clienteId, loteId],
    );
    return filas.map((f) => f.id);
  });
}

async function agregarIdentificador(clienteId: string, movimientoId: string, cuitSintetico: string): Promise<void> {
  const hmac = hmacDocumento('cuit', cuitSintetico, clienteId);
  await conUsuario(USUARIOS.socio, (tx) =>
    tx.consultar(
      `insert into movimiento_contraparte_identificador (cliente_id, movimiento_id, clase, identificador_hmac, pepper_id)
       values ($1, $2, 'cuit', $3, $4)`,
      [clienteId, movimientoId, hmac, pepperIdActual()],
    ),
  );
}

/** Digest de motor de forma válida (16 hex) — no importa que no salga de una corrida real del motor,
 *  este archivo solo prueba las consultas de agregación, no capa B/C. Nunca una corrida ascendente
 *  (`0123456789...`): el barrido de fuga la marcó como posible coincidencia con material real. */
const MOTOR_DIGEST_DE_PRUEBA = 'a1c3f5b7d9e02468';

async function escribirReconocimiento(
  tx: Tx,
  ctx: ContextoAuditado,
  args: {
    readonly clienteId: string;
    readonly movimientoId: string;
    readonly clase: 'decision_humana' | 'propuesta';
    readonly tipo: string;
    readonly concepto: string;
    readonly polaridad: 'normal' | 'reversa';
    readonly lado: 'debe' | 'haber';
    readonly queDecide?: string;
  },
): Promise<void> {
  const filas = await tx.consultar<{ entrada_digest: string }>(
    `select entrada_digest from movimiento_bancario_crudo where cliente_id = $1 and id = $2`,
    [args.clienteId, args.movimientoId],
  );
  const entradaDigest = filas[0]?.entrada_digest;
  if (!entradaDigest) throw new Error('fixture inválido: el movimiento no tiene entrada_digest');

  const r = await persistirReconocimiento(tx, ctx, {
    clienteId: args.clienteId,
    movimientoId: args.movimientoId,
    reconocimientoId: randomUUID(),
    motorDigest: MOTOR_DIGEST_DE_PRUEBA,
    entradaDigest,
    clase: args.clase,
    tipo: args.tipo,
    concepto: args.concepto,
    polaridad: args.polaridad,
    lado: args.lado,
    via: 'texto_literal_exacto',
    queDecide: args.queDecide ?? null,
    motivoCodigo: null,
    entradaLexicoId: 'sintetico.concepto_test',
    caracteresMatcheados: 5,
    huboCola: false,
    candidatos: [],
  });
  if (r.estado !== 'creado') {
    throw new Error(`fixture inválido: persistirReconocimiento devolvió "${r.estado}" en vez de "creado"`);
  }
}

async function escribirPendiente(tx: Tx, ctx: ContextoAuditado, clienteId: string, cierreId: string, movimientoId: string): Promise<void> {
  const r = await escribirPendienteDeImputacion(tx, ctx, {
    clienteId,
    cierreId,
    movimientoId,
    motivoCodigo: 'tipo_sin_regla_imputacion',
    evidencia: {},
  });
  if (r.estado !== 'creado') {
    throw new Error(`fixture inválido: escribirPendienteDeImputacion devolvió "${r.estado}" en vez de "creado"`);
  }
}

async function crearCierre(tx: Tx, clienteId: string): Promise<string> {
  const filas = await tx.consultar<{ id: string }>(
    `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
     values ($1, 'mensual', '2026-01-01', '2026-01-31')
     returning id::text as id`,
    [clienteId],
  );
  const id = filas[0]?.id;
  if (!id) throw new Error('fixture inválido: no se creó cierre_cliente_periodo');
  return id;
}

async function crearCuentaDePlan(tx: Tx, ctx: ContextoAuditado, clienteId: string, codigo: string, denominacion: string): Promise<string> {
  const r = await altaPlanDeCuentas(tx, ctx, {
    clienteId,
    filas: [
      {
        codigo,
        denominacion,
        nivel: 1,
        cuentaPadreCodigo: null,
        rolFuncional: 'generica',
        padronSocioId: null,
        vigenteDesde: '2026-01-01',
        respaldo: 'fixture de prueba',
      },
    ],
  });
  const id = r.cuentaIdPorCodigo.get(codigo);
  if (!id) throw new Error(`fixture inválido: no se creó la cuenta ${codigo}`);
  return id;
}

function cuentaSintetica(semilla: number, cantidad: number): CuentaConMovimientos {
  return extractoSintetico({
    semilla,
    cantidadMovimientos: cantidad,
    saldoInicialCentavos: 1_000_000_00n,
    periodoDesde: '2026-01-01',
    periodoHasta: '2026-01-31',
  });
}

// -----------------------------------------------------------------------------
// Escenario "cliente 1 de la tupla" (con bloque de retiro_de_socio) — 9 movimientos usados.
// -----------------------------------------------------------------------------

type EscenarioCliente1 = {
  readonly clienteId: string;
  readonly loteId: string;
};

async function armarCliente1(clienteId: string): Promise<EscenarioCliente1> {
  const cuentaBancariaId = await registrarCuentaBancaria(clienteId);
  const cuenta = cuentaSintetica(101, 9);
  const loteId = await crearLotePersistido(clienteId, cuentaBancariaId, cuenta);
  const ids = await idsDeMovimientos(clienteId, loteId);
  if (ids.length < 9) throw new Error('fixture inválido: no se generaron los 9 movimientos esperados');

  await conUsuario(USUARIOS.socio, async (tx) =>
    escribirConAuditoria(tx, { clienteId, accion: 'escritura', recurso: 'fixture_relevamiento_laura', motivo: 'fixture de prueba' }, async (ctx) => {
      // Grupo A — 4 movimientos, misma contraparte: entra individual (>= 3).
      for (const id of ids.slice(0, 4)) {
        await agregarIdentificador(clienteId, id, '20111111111');
        await escribirReconocimiento(tx, ctx, {
          clienteId,
          movimientoId: id,
          clase: 'decision_humana',
          tipo: 'pago_a_proveedor_transferencia',
          concepto: 'pago_a_proveedor_inmediato',
          polaridad: 'normal',
          lado: 'debe',
          queDecide: 'distinguir_tercero_de_socio',
        });
      }

      // Grupo B — 1 movimiento, otra contraparte: va al resumen (< 3).
      const idGrupoB = ids[4];
      if (!idGrupoB) throw new Error('fixture inválido: falta ids[4]');
      await agregarIdentificador(clienteId, idGrupoB, '20222222222');
      await escribirReconocimiento(tx, ctx, {
        clienteId,
        movimientoId: idGrupoB,
        clase: 'decision_humana',
        tipo: 'pago_a_proveedor_transferencia',
        concepto: 'pago_a_proveedor_inmediato',
        polaridad: 'normal',
        lado: 'debe',
        queDecide: 'distinguir_tercero_de_socio',
      });

      // Bloque retiro_de_socio — 2 movimientos, misma contraparte: SIEMPRE completo, nunca al resumen,
      // y nunca en tiposSinCuenta.
      const cierreId = await crearCierre(tx, clienteId);
      const idsRetiro = ids.slice(5, 7);
      for (const id of idsRetiro) {
        await agregarIdentificador(clienteId, id, '20333333333');
        await escribirReconocimiento(tx, ctx, {
          clienteId,
          movimientoId: id,
          clase: 'propuesta',
          tipo: 'retiro_de_socio',
          concepto: 'pago_a_proveedor_inmediato',
          polaridad: 'normal',
          lado: 'debe',
        });
        await escribirPendiente(tx, ctx, clienteId, cierreId, id);
      }

      // Asientos automáticos — un tipo con un asiento normal y uno reversa: el total tiene que
      // reportar los DOS, y el ejemplo elegido tiene que ser SIEMPRE el normal.
      const cuentaBancoId = await crearCuentaDePlan(tx, ctx, clienteId, '1.1.01', 'Banco cuenta corriente');
      const cuentaGastoId = await crearCuentaDePlan(tx, ctx, clienteId, '5.1.01', 'Gastos bancarios');
      const idNormal = ids[7];
      const idReversa = ids[8];
      if (!idNormal || !idReversa) throw new Error('fixture inválido: faltan ids[7]/ids[8]');

      await escribirReconocimiento(tx, ctx, {
        clienteId,
        movimientoId: idNormal,
        clase: 'propuesta',
        tipo: 'comision_bancaria',
        concepto: 'comision_de_mantenimiento_de_cuenta',
        polaridad: 'normal',
        lado: 'debe',
      });
      await escribirAsientoAutomatico(tx, ctx, {
        clienteId,
        cierreId,
        fechaImputacion: '2026-01-15',
        movimientoId: idNormal,
        renglones: [
          { cuentaId: cuentaBancoId, cuentaRef: { codigo: '1.1.01', denominacion: 'Banco cuenta corriente', rolFuncional: 'generica' }, lado: 'haber', importe: '500.00' },
          { cuentaId: cuentaGastoId, cuentaRef: { codigo: '5.1.01', denominacion: 'Gastos bancarios', rolFuncional: 'generica' }, lado: 'debe', importe: '500.00' },
        ],
      });

      await escribirReconocimiento(tx, ctx, {
        clienteId,
        movimientoId: idReversa,
        clase: 'propuesta',
        tipo: 'comision_bancaria',
        concepto: 'comision_de_mantenimiento_de_cuenta',
        polaridad: 'reversa',
        lado: 'haber',
      });
      await escribirAsientoAutomatico(tx, ctx, {
        clienteId,
        cierreId,
        fechaImputacion: '2026-01-16',
        movimientoId: idReversa,
        renglones: [
          { cuentaId: cuentaBancoId, cuentaRef: { codigo: '1.1.01', denominacion: 'Banco cuenta corriente', rolFuncional: 'generica' }, lado: 'debe', importe: '500.00' },
          { cuentaId: cuentaGastoId, cuentaRef: { codigo: '5.1.01', denominacion: 'Gastos bancarios', rolFuncional: 'generica' }, lado: 'haber', importe: '500.00' },
        ],
      });
    }),
  );

  return { clienteId, loteId };
}

// -----------------------------------------------------------------------------
// Escenario "cliente 2 de la tupla" (sin bloque de retiro_de_socio) — pago_de_haberes en Hoja 2.
// -----------------------------------------------------------------------------

async function armarCliente2(clienteId: string): Promise<void> {
  const cuentaBancariaId = await registrarCuentaBancaria(clienteId);
  const cuenta = cuentaSintetica(202, 2);
  const loteId = await crearLotePersistido(clienteId, cuentaBancariaId, cuenta);
  const ids = await idsDeMovimientos(clienteId, loteId);
  if (ids.length < 2) throw new Error('fixture inválido: no se generaron los 2 movimientos esperados');

  await conUsuario(USUARIOS.socio, async (tx) =>
    escribirConAuditoria(tx, { clienteId, accion: 'escritura', recurso: 'fixture_relevamiento_laura', motivo: 'fixture de prueba' }, async (ctx) => {
      const cierreId = await crearCierre(tx, clienteId);
      const conceptos = ['pago_de_remuneraciones', 'pago_de_honorarios'];
      for (const [indice, id] of ids.entries()) {
        const concepto = conceptos[indice];
        if (!concepto) continue;
        await escribirReconocimiento(tx, ctx, {
          clienteId,
          movimientoId: id,
          clase: 'propuesta',
          tipo: 'pago_de_haberes',
          concepto,
          polaridad: 'normal',
          lado: 'debe',
        });
        await escribirPendiente(tx, ctx, clienteId, cierreId, id);
      }
    }),
  );
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('relevarParaLaura — contra Postgres local', () => {
  it('arma las 3 hojas de los dos clientes, con el corte de la Hoja 1, retiro_de_socio aparte, ' +
    'pago_de_haberes en Hoja 2, y la Hoja 3 con reversa contada pero ejemplo normal', async () => {
    await registrarBanco();
    await armarCliente1(s.clienteA);
    await armarCliente2(s.clienteB);

    const crudo = await conUsuario(USUARIOS.socio, (tx) =>
      relevarParaLaura(tx, { clienteIds: [s.clienteA, s.clienteB] }),
    );
    expect(crudo.estado).toBe('armado');
    if (crudo.estado !== 'armado') throw new Error('inalcanzable: el rol de socio siempre debería calificar');
    const resultado = crudo;

    // ---- Hoja 1: corte >= 3 vs resumen, retiro_de_socio siempre completo -------------------------
    const filasContrapartes = resultado.bracci.contrapartes.filas;
    expect(filasContrapartes).toHaveLength(2); // grupo A (4, individual) + retiro_de_socio (2)

    const grupoA = filasContrapartes.find((f) => !f.esRetiroDeSocio);
    expect(grupoA?.cantidadMovimientos).toBe(4);
    expect(grupoA?.esRetiroDeSocio).toBe(false);

    const filaRetiro = filasContrapartes.find((f) => f.esRetiroDeSocio);
    expect(filaRetiro).toBeDefined();
    expect(filaRetiro?.cantidadMovimientos).toBe(2);

    // El grupo B (1 movimiento, < 3) fue al resumen, no a `filas`.
    expect(resultado.bracci.contrapartes.resumen).toEqual({ grupos: 1, movimientos: 1 });

    // El segundo cliente de la tupla no corrió el bloque de retiro_de_socio y no tiene contrapartes
    // de `distinguir_tercero_de_socio` en este fixture.
    expect(resultado.roka.contrapartes.filas).toHaveLength(0);
    expect(resultado.roka.contrapartes.filas.some((f) => f.esRetiroDeSocio)).toBe(false);

    // ---- Hoja 2: retiro_de_socio NUNCA acá, aunque el cliente 1 sí tenga ese pendiente ------------
    expect(resultado.bracci.tiposSinCuenta).toHaveLength(0);
    expect(resultado.bracci.tiposSinCuenta.some((f) => f.tipo === 'retiro_de_socio')).toBe(false);

    // pago_de_haberes, con su cantidad y su conteo de conceptos distintos.
    expect(resultado.roka.tiposSinCuenta).toHaveLength(1);
    const filaHaberes = resultado.roka.tiposSinCuenta[0];
    expect(filaHaberes?.tipo).toBe('pago_de_haberes');
    expect(filaHaberes?.cantidadMovimientos).toBe(2);
    expect(filaHaberes?.cantidadConceptosDistintos).toBe(2);

    // ---- Hoja 3: total incluye la reversa, pero el ejemplo elegido es siempre normal --------------
    expect(resultado.bracci.asientosAutomaticos).toHaveLength(1);
    const filaAsiento = resultado.bracci.asientosAutomaticos[0];
    expect(filaAsiento?.tipo).toBe('comision_bancaria');
    expect(filaAsiento?.cantidadTotal).toBe(2);
    expect(filaAsiento?.cantidadReversas).toBe(1);
    expect(filaAsiento?.renglones).toHaveLength(2);
    // Los dos renglones del ejemplo tienen que sumar el mismo importe en debe y en haber (500.00 cada
    // uno) — es el asiento NORMAL, nunca el reversa (que llevaría los lados invertidos).
    const debeTotal = filaAsiento?.renglones.reduce((acc, r) => acc + Number(r.debe), 0) ?? 0;
    const haberTotal = filaAsiento?.renglones.reduce((acc, r) => acc + Number(r.haber), 0) ?? 0;
    expect(debeTotal).toBeCloseTo(500);
    expect(haberTotal).toBeCloseTo(500);

    // ---- Auditoría: dos correlaciones distintas, una por cliente (INV-5) --------------------------
    expect(resultado.bracci.correlacion).not.toBe(resultado.roka.correlacion);
  }, 30_000);

  it('rol insuficiente (administrativo, fuera de ROLES_QUE_EXPORTAN): aborta antes de auditar o leer', async () => {
    const r = await conUsuario(USUARIOS.administrativoA, (tx) =>
      relevarParaLaura(tx, { clienteIds: [s.clienteA, s.clienteB] }),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente', clienteId: s.clienteA });
  });
});
