/**
 * `cierre/escrituras.ts::backfillDocumentoIngerido` — backfill de `documento_ingerido`
 * (`0027_cierre_mensual.sql`), Sesión 2a de `docs/diseno/27-roadmap-capa-d.md`. Fixture 100%
 * SINTÉTICO contra `s.clienteA` (nunca los 3 lotes reales del piloto, que se backfillean aparte con
 * `apps/cli/src/backfill-documento-ingerido.ts`, no commiteado).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, escribirConAuditoria } from '@sistema-contable/data';
import { ErrorDeBase } from '../src/db/errores-pg.ts';
import { backfillDocumentoIngerido, type FilaBackfillDocumentoIngerido } from '../src/cierre/escrituras.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
  // `sembrar()` trunca `banco` en cada corrida — repone el código real que usa el fixture de este
  // archivo, mismo patrón que `apps/cli/tests/backfill-documento-ingerido.test.ts`.
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('bancor', 'BANCO DE LA PROVINCIA DE CORDOBA (BANCOR)')
       on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

function filaSintetica(clienteId: string, parcial?: Partial<FilaBackfillDocumentoIngerido>): FilaBackfillDocumentoIngerido {
  return {
    clienteId,
    tipoDocumento: 'extracto',
    bancoCodigo: 'bancor',
    periodoDesde: '2026-06-01',
    periodoHasta: '2026-06-30',
    cobertura: 'completo',
    objetoAlmacenamiento: `cliente/${clienteId}/extracto/${randomUUID()}.pdf`,
    ingeridoEn: '2026-06-30T12:00:00.000Z',
    ...parcial,
  };
}

describe('backfillDocumentoIngerido — alta feliz', () => {
  it('inserta la fila y devuelve estado "aplicado" con el id nuevo', async () => {
    const fila = filaSintetica(s.clienteA);

    const resultado = await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'documento_ingerido', motivo: 'test: alta feliz' },
        (ctx) => backfillDocumentoIngerido(tx, ctx, fila),
      ),
    );

    expect(resultado.estado).toBe('aplicado');

    const filaDb = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ banco_codigo: string; periodo_desde: string; periodo_hasta: string; cobertura: string; ingerido_en: string }>(
        `select banco_codigo, periodo_desde::text as periodo_desde, periodo_hasta::text as periodo_hasta,
                cobertura, ingerido_en::text as ingerido_en
           from documento_ingerido where id = $1`,
        [resultado.estado === 'aplicado' ? resultado.documentoIngeridoId : ''],
      ),
    );
    expect(filaDb[0]?.banco_codigo).toBe('bancor');
    expect(filaDb[0]?.periodo_desde).toBe('2026-06-01');
    expect(filaDb[0]?.periodo_hasta).toBe('2026-06-30');
    expect(filaDb[0]?.cobertura).toBe('completo');
  });
});

describe('backfillDocumentoIngerido — idempotencia', () => {
  it('una segunda corrida con los mismos valores devuelve "ya_backfilleado", sin duplicar', async () => {
    const fila = filaSintetica(s.clienteA);

    const primera = await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'documento_ingerido', motivo: 'test: idempotencia 1' },
        (ctx) => backfillDocumentoIngerido(tx, ctx, fila),
      ),
    );
    expect(primera.estado).toBe('aplicado');

    const segunda = await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'documento_ingerido', motivo: 'test: idempotencia 2' },
        (ctx) => backfillDocumentoIngerido(tx, ctx, fila),
      ),
    );
    expect(segunda).toEqual({ estado: 'ya_backfilleado', documentoIngeridoId: (primera as { documentoIngeridoId: string }).documentoIngeridoId });

    const conteo = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ n: number }>(
        `select count(*)::int as n from documento_ingerido
          where cliente_id = $1 and banco_codigo = 'bancor' and objeto_almacenamiento = $2`,
        [s.clienteA, fila.objetoAlmacenamiento],
      ),
    );
    expect(conteo[0]?.n).toBe(1);
  });
});

describe('backfillDocumentoIngerido — 🔴 aislamiento cross-cliente', () => {
  it('la fila insertada para clienteA no es visible para un usuario sin membership ahí', async () => {
    const fila = filaSintetica(s.clienteA);

    await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'documento_ingerido', motivo: 'test: aislamiento' },
        (ctx) => backfillDocumentoIngerido(tx, ctx, fila),
      ),
    );

    const visibleParaAjeno = await conUsuario(USUARIOS.socioOtroEstudio, (tx) =>
      tx.consultar(`select 1 from documento_ingerido where cliente_id = $1 and objeto_almacenamiento = $2`, [
        s.clienteA,
        fila.objetoAlmacenamiento,
      ]),
    );
    expect(visibleParaAjeno).toEqual([]);
  });
});

describe('backfillDocumentoIngerido — 🔴 CHECK de la migración 0027 sigue vigente para esta vía', () => {
  it('cobertura fuera del dominio cerrado muere por documento_ingerido_cobertura_chk, sin datos en el error (R28)', async () => {
    const fila = filaSintetica(s.clienteA, {
      // Cast deliberado: fuerza un valor fuera del dominio TS para ejercitar el CHECK de la base,
      // no el tipo de TS (mismo criterio que el test equivalente de `altaPlanDeCuentas`).
      cobertura: 'no_existe' as FilaBackfillDocumentoIngerido['cobertura'],
    });

    const error = await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'documento_ingerido', motivo: 'test: CHECK vigente' },
        (ctx) => backfillDocumentoIngerido(tx, ctx, fila),
      ),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorDeBase);
    expect((error as ErrorDeBase).codigo).toBe('ING_CHECK');
    expect((error as ErrorDeBase).constraint).toBe('documento_ingerido_cobertura_chk');
  });
});
