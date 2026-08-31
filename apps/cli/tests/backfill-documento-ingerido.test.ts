/**
 * `backfill-documento-ingerido.ts` — el CLI. Parseo de args y el flujo completo (base real) sobre un
 * lote SINTÉTICO (nunca los 3 lotes reales del piloto): TOCTOU del `--cliente`, guard de mono-cuenta
 * (B.7), guard de banco soportado, dry-run y `--confirmar`. Migración `0027_cierre_mensual.sql`,
 * Sesión 2a de `docs/diseno/27-roadmap-capa-d.md`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { argumentos, backfillDocumentoIngeridoDeLote } from '../src/backfill-documento-ingerido.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
  // `ayuda.ts::sembrar()` trunca `banco` en cada corrida (tests self-contenidos, nunca dependen del
  // catálogo real de una migración) — este backfill está scopeado a códigos de banco REALES
  // ('bancor'/'nacion'/'icbc', más 'galicia' para el caso "banco no soportado"), así que hay que
  // reponerlos acá, mismo patrón que `apps/cli/tests/backfill-contraparte.test.ts`.
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values
         ('bancor', 'BANCO DE LA PROVINCIA DE CORDOBA (BANCOR)'),
         ('nacion', 'BANCO DE LA NACION ARGENTINA'),
         ('icbc', 'INDUSTRIAL AND COMMERCIAL BANK OF CHINA (ARGENTINA) S.A.'),
         ('galicia', 'BANCO GALICIA')
       on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

type OpcionesLote = {
  readonly bancoCodigo?: string;
  readonly archivoClave?: string | null;
  readonly estado?: string;
  readonly cuentas?: readonly { readonly periodoDesde: string; readonly periodoHasta: string }[];
};

async function crearLoteSintetico(clienteId: string, opciones: OpcionesLote = {}): Promise<string> {
  const bancoCodigo = opciones.bancoCodigo ?? 'bancor';
  const archivoClave = opciones.archivoClave === undefined ? `cliente/${clienteId}/extracto/${randomUUID()}.pdf` : opciones.archivoClave;
  const estado = opciones.estado ?? 'procesado';
  const cuentas = opciones.cuentas ?? [{ periodoDesde: '2026-06-01', periodoHasta: '2026-06-30' }];

  return conUsuario(USUARIOS.socio, async (tx) => {
    const lote = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_clave, archivo_hash, estado,
          filas_leidas, filas_aceptadas)
       values ($1, $2, 'prueba@1', 'archivo', $3, $4, $5, 1, 1)
       returning id::text as id`,
      [clienteId, bancoCodigo, archivoClave, randomUUID(), estado],
    );
    const loteId = lote[0]?.id ?? '';

    for (const c of cuentas) {
      const cuenta = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, $2, 'ARS')
         returning id::text as id`,
        [clienteId, bancoCodigo],
      );
      await tx.consultar(
        `insert into lote_ingesta_cuenta
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
         values ($1, $2, $3, $4, $5, 'cuadra')`,
        [clienteId, loteId, cuenta[0]?.id, c.periodoDesde, c.periodoHasta],
      );
    }
    return loteId;
  });
}

describe('argumentos', () => {
  it('parsea --cliente --usuario --lote-id sin --confirmar como dry-run', () => {
    const cliente = randomUUID();
    const usuario = randomUUID();
    const loteId = randomUUID();
    const args = argumentos(['--cliente', cliente, '--usuario', usuario, '--lote-id', loteId]);
    expect(args).toEqual({ cliente, usuario, loteId, confirmar: false });
  });

  it('reconoce --confirmar como bandera', () => {
    const cliente = randomUUID();
    const usuario = randomUUID();
    const loteId = randomUUID();
    const args = argumentos(['--cliente', cliente, '--usuario', usuario, '--lote-id', loteId, '--confirmar']);
    expect(args.confirmar).toBe(true);
  });

  it('rechaza un --cliente que no tiene forma de uuid', () => {
    expect(() => argumentos(['--cliente', 'no-es-un-uuid'])).toThrow();
  });

  it('rechaza argumentos faltantes', () => {
    expect(() => argumentos([])).toThrow();
  });
});

describe('backfillDocumentoIngeridoDeLote — flujo completo (base real)', () => {
  it('dry-run reporta "dry_run" sin objetoAlmacenamiento; --confirmar inserta; repetir da "ya_backfilleado"', async () => {
    const loteId = await crearLoteSintetico(s.clienteA);

    const dry = await backfillDocumentoIngeridoDeLote({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, confirmar: false });
    expect(dry.estado).toBe('dry_run');
    if (dry.estado === 'dry_run') {
      expect(dry.fila.bancoCodigo).toBe('bancor');
      expect(dry.fila.periodoDesde).toBe('2026-06-01');
      expect(dry.fila.periodoHasta).toBe('2026-06-30');
      expect(dry.fila.cobertura).toBe('completo');
      expect('objetoAlmacenamiento' in dry.fila).toBe(false);
    }

    const aplicado = await backfillDocumentoIngeridoDeLote({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, confirmar: true });
    expect(aplicado.estado).toBe('aplicado');

    const segunda = await backfillDocumentoIngeridoDeLote({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, confirmar: true });
    expect(segunda.estado).toBe('ya_backfilleado');
  });

  it('🔴 TOCTOU: un --cliente que no es el dueño real del lote no lo encuentra (nunca inserta en el tenant equivocado)', async () => {
    const loteId = await crearLoteSintetico(s.clienteA);
    const r = await backfillDocumentoIngeridoDeLote({ cliente: s.clienteB, usuario: USUARIOS.contadorB, loteId, confirmar: false });
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'lote_no_encontrado_o_cliente_no_coincide' });
  });

  it('🔴 lote multi-cuenta: aborta "lote_no_mono_cuenta" — nunca inventa un período promedio (B.7)', async () => {
    const loteId = await crearLoteSintetico(s.clienteA, {
      cuentas: [
        { periodoDesde: '2026-06-01', periodoHasta: '2026-06-30' },
        { periodoDesde: '2026-06-01', periodoHasta: '2026-06-15' },
      ],
    });
    const r = await backfillDocumentoIngeridoDeLote({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, confirmar: false });
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'lote_no_mono_cuenta' });
  });

  it('🔴 banco fuera de COBERTURA_POR_BANCO: aborta, nunca asume un valor de cobertura no medido', async () => {
    const loteId = await crearLoteSintetico(s.clienteA, { bancoCodigo: 'galicia' });
    const r = await backfillDocumentoIngeridoDeLote({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, confirmar: false });
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'banco_no_soportado_por_este_backfill' });
  });

  it('🔴 archivo_clave nulo: aborta antes de intentar resolver objeto_almacenamiento', async () => {
    const loteId = await crearLoteSintetico(s.clienteA, { archivoClave: null });
    const r = await backfillDocumentoIngeridoDeLote({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, confirmar: false });
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'archivo_clave_nulo' });
  });

  it('🔴 lote no backfilleable (estado con_errores): aborta', async () => {
    const loteId = await crearLoteSintetico(s.clienteA, { estado: 'con_errores' });
    const r = await backfillDocumentoIngeridoDeLote({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, confirmar: false });
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'lote_no_backfilleable' });
  });
});
