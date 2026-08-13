/**
 * `backfill-contraparte.ts` — el CLI. Parseo de args y el flujo completo (base real): lectura
 * auditada de la satélite N2R, cálculo de candidatos, dry-run y `--aplicar`. Migración 0013.
 *
 * La mecánica de compuertas/idempotencia ya está cubierta en
 * `packages/ingesta/tests/reproceso/backfill-contraparte.test.ts`; acá se prueba el cableado del
 * CLI (parseo, `verificarCredencialDeRequest`, mapeo a resultado) — mismo criterio que
 * `recapturar-conceptos.test.ts`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { backfillContraparte, parsearArgumentos } from '../src/backfill-contraparte.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('backfill_cli', 'BANCO BACKFILL CLI') on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

async function crearLotePre0013ConUnIdentificador(clienteId: string): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const cuenta = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, 'backfill_cli', 'ARS')
       returning id::text as id`,
      [clienteId],
    );
    const cuentaId = cuenta[0]?.id ?? '';
    const lote = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas, filas_aceptadas)
       values ($1, 'backfill_cli', 'prueba@1', 'archivo', $2, 'procesado', 1, 1)
       returning id::text as id`,
      [clienteId, randomUUID()],
    );
    const loteId = lote[0]?.id ?? '';
    await tx.consultar(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
      [clienteId, loteId, cuentaId],
    );
    const mov = await tx.consultar<{ id: string }>(
      `insert into movimiento_bancario_crudo
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
          fecha, descripcion, importe, concepto_banco_estrategia, contraparte_captura)
       values ($1, $2, $3, 1, $4, '2026-06-15', 'CONCEPTO CLI', -50.00, 'no_publicado', 'no_capturado')
       returning id::text as id`,
      [clienteId, loteId, cuentaId, `hash_cli_${clienteId}`],
    );
    await tx.consultar(
      `insert into movimiento_origen_crudo (cliente_id, movimiento_id, fila_origen) values ($1, $2, $3::jsonb)`,
      [
        clienteId,
        mov[0]?.id,
        JSON.stringify({
          lineas: ['CONCEPTO CLI'],
          glosaOriginal: 'CONCEPTO CLI',
          identificadores: { cuit: ['30-71234567-8'], cbu: [], documento: [] },
          columnaOrigen: null,
          candidatosIdentificacion: [],
          referencias: [],
        }),
      ],
    );
    return loteId;
  });
}

describe('parsearArgumentos', () => {
  it('parsea --cliente --usuario --lote-id sin --aplicar como dry-run', () => {
    const cliente = randomUUID();
    const usuario = randomUUID();
    const loteId = randomUUID();
    const args = parsearArgumentos(['--cliente', cliente, '--usuario', usuario, '--lote-id', loteId]);
    expect(args).toEqual({ cliente, usuario, loteId, aplicar: false });
  });

  it('reconoce --aplicar como bandera, sin consumir un valor', () => {
    const cliente = randomUUID();
    const usuario = randomUUID();
    const loteId = randomUUID();
    const args = parsearArgumentos([
      '--cliente', cliente, '--usuario', usuario, '--lote-id', loteId, '--aplicar',
    ]);
    expect(args.aplicar).toBe(true);
  });

  it('rechaza un --cliente que no tiene forma de uuid', () => {
    expect(() => parsearArgumentos(['--cliente', 'no-es-un-uuid'])).toThrow();
  });

  it('rechaza argumentos faltantes', () => {
    expect(() => parsearArgumentos([])).toThrow();
  });
});

describe('backfillContraparte — flujo completo (base real)', () => {
  it('dry-run reporta "listo"; --aplicar backfillea', async () => {
    const loteId = await crearLotePre0013ConUnIdentificador(s.clienteA);

    const dry = await backfillContraparte({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, aplicar: false });
    expect(dry.estado).toBe('listo');
    if (dry.estado === 'listo') {
      expect(dry.conteo.filasDelLote).toBe(1);
      expect(dry.conteo.candidatosTotales).toBe(1);
    }

    const aplicado = await backfillContraparte({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, aplicar: true });
    expect(aplicado.estado).toBe('aplicado');
    if (aplicado.estado === 'aplicado') {
      expect(aplicado.filasActualizadas).toBe(1);
    }

    const segunda = await backfillContraparte({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, aplicar: true });
    expect(segunda.estado).toBe('ya_backfilleado');
  });

  it('rol insuficiente: el contador no puede correr el backfill', async () => {
    const loteId = await crearLotePre0013ConUnIdentificador(s.clienteA);
    const r = await backfillContraparte({ cliente: s.clienteA, usuario: USUARIOS.contadorA, loteId, aplicar: false });
    expect(r.estado).toBe('abortado');
    if (r.estado === 'abortado') expect(r.motivoCodigo).toBe('rol_insuficiente');
  });
});
