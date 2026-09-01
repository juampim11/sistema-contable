/**
 * `detectarLotesDesactualizados` — solo lectura, cross-tenant, vía `conJob('auditoria_seguridad_readonly')`
 * (migración `0035`). Smoke test: un lote sin `versionExtractor` en `fila_origen` (el caso real: un
 * lote ingerido ANTES de esta tarea) aparece en el listado; uno CON la versión vigente, no.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { detectarLotesDesactualizados, VERSION_DEL_EXTRACTOR } from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../data/tests/ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('detectar_prueba', 'BANCO DETECTAR') on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

async function crearLote(clienteId: string, filaOrigen: Record<string, unknown>): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const cuenta = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, 'detectar_prueba', 'ARS')
       returning id::text as id`,
      [clienteId],
    );
    const cuentaId = cuenta[0]?.id ?? '';

    const lote = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas, filas_aceptadas)
       values ($1, 'detectar_prueba', 'prueba@1', 'archivo', $2, 'procesado', 1, 1)
       returning id::text as id`,
      [clienteId, randomUUID()],
    );
    const loteId = lote[0]?.id ?? '';

    await tx.consultar(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, '2026-08-01', '2026-08-31', 'no_verificable')`,
      [clienteId, loteId, cuentaId],
    );

    const mov = await tx.consultar<{ id: string }>(
      `insert into movimiento_bancario_crudo
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
          fecha, descripcion, importe, concepto_banco_estrategia, contraparte_captura)
       values ($1, $2, $3, 1, $4, '2026-08-15', 'X', -1.00, 'no_publicado', 'sin_identificador')
       returning id::text as id`,
      [clienteId, loteId, cuentaId, `hash_detectar_${clienteId}_${randomUUID()}`],
    );
    const movId = mov[0]?.id ?? '';

    await tx.consultar(
      `insert into movimiento_origen_crudo (cliente_id, movimiento_id, fila_origen) values ($1, $2, $3::jsonb)`,
      [clienteId, movId, JSON.stringify(filaOrigen)],
    );

    return loteId;
  });
}

describe('detectarLotesDesactualizados', () => {
  it('un lote sin versionExtractor aparece en el listado, y uno con la version vigente no', async () => {
    const loteViejo = await crearLote(s.clienteA, {
      lineas: ['X'],
      glosaOriginal: 'X',
      identificadores: { cuit: [], cbu: [], documento: [] },
      columnaOrigen: null,
      candidatosIdentificacion: [],
      referencias: [],
      // sin versionExtractor: el caso de un lote ingerido antes de esta tarea.
    });
    const loteAlDia = await crearLote(s.clienteA, {
      lineas: ['X'],
      glosaOriginal: 'X',
      identificadores: { cuit: [], cbu: [], documento: [] },
      columnaOrigen: null,
      candidatosIdentificacion: [],
      referencias: [],
      versionExtractor: VERSION_DEL_EXTRACTOR,
    });

    const lotes = await detectarLotesDesactualizados();
    const ids = lotes.map((l) => l.loteId);

    expect(ids).toContain(loteViejo);
    expect(ids).not.toContain(loteAlDia);

    const encontrado = lotes.find((l) => l.loteId === loteViejo);
    expect(encontrado?.clienteId).toBe(s.clienteA);
    expect(encontrado?.bancoCodigo).toBe('detectar_prueba');
    expect(encontrado?.movimientosDesactualizados).toBe(1);
  });
});
