/**
 * `confirmar-grupo.ts` — ÚNICO productor de `confirmacion_grupo` (0043, doc 31 Tanda 2). Cubre el
 * parseo de argumentos (incluido el guard de dato sensible en `--respaldo`), la resolución de la
 * cuenta REAL (nunca inventada), el alta feliz y su duplicado (`YA_EXISTE_CONFIRMACION_VIGENTE`), la
 * revocación feliz y sus dos abortos (`REVOCA_NO_ES_LA_VIGENTE`), y el rol insuficiente.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, corriendo contra LOCAL, con
 * `0043` aplicada.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { cerrarConexiones, conUsuario, type Tx } from '@sistema-contable/data';
import { correrConfirmarGrupo, parsearArgumentos } from '../src/confirmar-grupo.ts';

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

const BANCO_CODIGO = 'banco_confirmar_grupo';
const CODIGO_CUENTA = '1.2.1.901';
const RESPALDO = 'Confirmado por Laura, cierre de julio 2026.';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
  const duenio = await clienteDuenio();
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      BANCO_CODIGO,
      'Banco Ficticio Confirmar Grupo',
    ]);
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Cliente sintético propio por `it` — mismo patrón que `alta-regla-imputacion.test.ts`. */
async function clienteFresco(): Promise<{ clienteId: string; cuentaContableId: string }> {
  const duenio = await clienteDuenio();
  let clienteId = '';
  try {
    const f = await duenio.query<{ id: string }>(
      `insert into tenant_node (tipo, nombre, parent_id) values ('cliente', 'CLIENTE CONFIRMAR GRUPO', $1) returning id`,
      [s.estudio],
    );
    clienteId = f.rows[0]?.id ?? '';
  } finally {
    await duenio.end();
  }

  const cuentaContableId = await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [clienteId]);
    const id = String(cuenta['id']);
    await ej(
      `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
       values ($1, $2, $3, 'Proveedores varios (fixture)', 4, 'generica', '2026-01-01', 'fixture confirmar-grupo')`,
      [clienteId, id, CODIGO_CUENTA],
    );
    return id;
  });

  return { clienteId, cuentaContableId };
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
    '--banco-codigo',
    BANCO_CODIGO,
    '--concepto-banco',
    'PAGO PROVEEDOR VARIOS',
    '--cuenta-codigo',
    CODIGO_CUENTA,
    '--respaldo',
    RESPALDO,
  ];

  it('parsea una confirmación completa (sin --aplicar)', () => {
    const r = parsearArgumentos(base);
    expect(r).toEqual({
      cliente: base[1],
      usuario: base[3],
      bancoCodigo: BANCO_CODIGO,
      conceptoBanco: 'PAGO PROVEEDOR VARIOS',
      cuentaCodigo: CODIGO_CUENTA,
      respaldo: RESPALDO,
      revoca: null,
      aplicar: false,
    });
  });

  it('parsea --aplicar y --revoca', () => {
    const id = randomUUID();
    const r = parsearArgumentos([...base, '--aplicar', '--revoca', id]);
    expect(r.aplicar).toBe(true);
    expect(r.revoca).toBe(id);
  });

  it('rechaza --respaldo demasiado corto (< 15 caracteres)', () => {
    const conRespaldoCorto = [...base];
    conRespaldoCorto[11] = 'corto';
    expect(() => parsearArgumentos(conRespaldoCorto)).toThrow();
  });

  it('🔴 rechaza --respaldo con una posible cadena de documento (CUIT)', () => {
    const conCuit = [...base];
    conCuit[11] = 'Lo confirmó CUIT 20-12345678-9 por mail';
    expect(() => parsearArgumentos(conCuit)).toThrow(/posible cadena de documento/);
  });

  it('rechaza --revoca que no es un uuid', () => {
    expect(() => parsearArgumentos([...base, '--revoca', 'no-es-un-uuid'])).toThrow();
  });
});

// -----------------------------------------------------------------------------
// correrConfirmarGrupo — flujo real, base real
// -----------------------------------------------------------------------------

describe('correrConfirmarGrupo — cuenta no encontrada', () => {
  it('código inexistente en el plan del cliente aborta CUENTA_NO_ENCONTRADA, nunca inventa un id', async () => {
    const { clienteId } = await clienteFresco();
    const r = await correrConfirmarGrupo({
      cliente: clienteId,
      usuario: USUARIOS.socio,
      bancoCodigo: BANCO_CODIGO,
      conceptoBanco: 'CONCEPTO X',
      cuentaCodigo: '9.9.9.998',
      respaldo: RESPALDO,
      revoca: null,
      aplicar: false,
    });
    expect(r).toMatchObject({ estado: 'abortado', motivoCodigo: 'CUENTA_NO_ENCONTRADA' });
  });
});

describe('correrConfirmarGrupo — flujo feliz, duplicado y revocación', () => {
  it('primera confirmación entra; una segunda sin --revoca aborta YA_EXISTE_CONFIRMACION_VIGENTE', async () => {
    const { clienteId } = await clienteFresco();

    const primera = await correrConfirmarGrupo({
      cliente: clienteId,
      usuario: USUARIOS.socio,
      bancoCodigo: BANCO_CODIGO,
      conceptoBanco: 'PAGO PROVEEDOR VARIOS',
      cuentaCodigo: CODIGO_CUENTA,
      respaldo: RESPALDO,
      revoca: null,
      aplicar: true,
    });
    expect(primera.estado).toBe('aplicado');
    const confirmacionId = primera.estado === 'aplicado' ? primera.confirmacionGrupoId : '';
    expect(confirmacionId).toMatch(/^[0-9a-f-]{36}$/);

    // Verificado por consulta directa — nunca solo confiar en el reporte del CLI.
    const filaReal = await comoSocio((ej) =>
      ej(
        `select banco_codigo, concepto_normalizado, cuenta_id::text as cuenta_id, respaldo, confirmado_por::text as confirmado_por, vigente_hasta
           from confirmacion_grupo where cliente_id = $1 and id = $2`,
        [clienteId, confirmacionId],
      ),
    );
    expect(filaReal[0]).toMatchObject({
      banco_codigo: BANCO_CODIGO,
      concepto_normalizado: 'PAGO PROVEEDOR VARIOS',
      confirmado_por: USUARIOS.socio,
      vigente_hasta: null,
    });

    // Segunda, misma clave (normalización distinta: minúsculas + doble espacio) SIN --revoca.
    const segunda = await correrConfirmarGrupo({
      cliente: clienteId,
      usuario: USUARIOS.socio,
      bancoCodigo: BANCO_CODIGO,
      conceptoBanco: 'pago  proveedor varios',
      cuentaCodigo: CODIGO_CUENTA,
      respaldo: 'Segundo intento — tiene que abortar antes de escribir.',
      revoca: null,
      aplicar: true,
    });
    expect(segunda).toMatchObject({ estado: 'abortado', motivoCodigo: 'YA_EXISTE_CONFIRMACION_VIGENTE' });

    // Confirmado que la segunda NO escribió una fila nueva.
    const cantidad = await comoSocio((ej) =>
      ej(`select 1 from confirmacion_grupo where cliente_id = $1 and banco_codigo = $2`, [clienteId, BANCO_CODIGO]),
    );
    expect(cantidad).toHaveLength(1);

    // Revocar con un id que NO es el vigente — aborta sin tocar nada.
    const revocaEquivocada = await correrConfirmarGrupo({
      cliente: clienteId,
      usuario: USUARIOS.socio,
      bancoCodigo: BANCO_CODIGO,
      conceptoBanco: 'PAGO PROVEEDOR VARIOS',
      cuentaCodigo: CODIGO_CUENTA,
      respaldo: 'Revocación con id equivocado — tiene que abortar.',
      revoca: randomUUID(),
      aplicar: true,
    });
    expect(revocaEquivocada).toMatchObject({ estado: 'abortado', motivoCodigo: 'REVOCA_NO_ES_LA_VIGENTE' });

    // Revocar con el id REAL — entra, y la vieja queda cerrada.
    const tercera = await correrConfirmarGrupo({
      cliente: clienteId,
      usuario: USUARIOS.socio,
      bancoCodigo: BANCO_CODIGO,
      conceptoBanco: 'PAGO PROVEEDOR VARIOS',
      cuentaCodigo: CODIGO_CUENTA,
      respaldo: 'Corrección: era otra cuenta — Laura se equivocó la primera vez.',
      revoca: confirmacionId,
      aplicar: true,
    });
    expect(tercera.estado).toBe('aplicado');

    const vigentes = await comoSocio((ej) =>
      ej(
        `select id::text as id from confirmacion_grupo
           where cliente_id = $1 and banco_codigo = $2 and vigente_hasta is null`,
        [clienteId, BANCO_CODIGO],
      ),
    );
    expect(vigentes).toHaveLength(1);
    expect(vigentes[0]?.['id']).not.toBe(confirmacionId);
  });
});

describe('correrConfirmarGrupo — rol insuficiente', () => {
  it('🔴 administrativo no puede confirmar (policy confirmacion_grupo_ins exige socio|contador)', async () => {
    const codigoPropio = '9.9.902.001';
    await conUsuario(USUARIOS.socio, async (tx) => {
      const ej = desdeTx(tx);
      const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [s.clienteA]);
      await ej(
        `insert into cuenta_atributo (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
         values ($1, $2, $3, 'Cuenta fixture rol insuficiente', 4, 'generica', '2026-01-01', 'fixture confirmar-grupo')`,
        [s.clienteA, String(cuenta['id']), codigoPropio],
      );
    });

    await expect(
      correrConfirmarGrupo({
        cliente: s.clienteA,
        usuario: USUARIOS.administrativoA,
        bancoCodigo: BANCO_CODIGO,
        conceptoBanco: 'CONCEPTO ROL INSUFICIENTE',
        cuentaCodigo: codigoPropio,
        respaldo: RESPALDO,
        revoca: null,
        aplicar: true,
      }),
    ).rejects.toThrow();
  });
});
