/**
 * MUTACIONES de `0027_cierre_mensual.sql` — prueba por mutación de los invariantes NUEVOS de esta
 * migración (CLAUDE.md §1.8): código defectuoso que la pone roja, su caso legítimo, conteo declarado.
 * No repite la cobertura genérica de la plantilla de siete renglones (eso ya lo mide
 * `packages/data/tests/catalogo.test.ts`); cubre lo específico de este esquema:
 *
 *   A. `cuenta_atributo_padron_socio_chk` — la equivalencia rol_funcional ⟺ padron_socio_id (D-25).
 *   B. `asiento_renglon_montos_chk` — un renglón nunca es debe Y haber a la vez.
 *   C. El gate de D-24, mecanizado en DOS capas: RLS (rol) + trigger (invariante, cualquier rol).
 *   D. `cierre_periodo_confirmacion_chk` — confirmado exige confirmado_en Y confirmado_por juntos.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, con `0027` APLICADA. Al momento
 * de escribir este archivo no lo está todavía (`docs/diseno/26-migracion-cierre-mensual.md`): se
 * corre recién cuando se apruebe aplicar la migración a local.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

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

/** Igual criterio que `mutaciones-0021.test.ts`: código + constraint, NUNCA `rejects.toThrow()` a secas. */
type ErrorPg = { readonly code: string; readonly constraint: string | null; readonly message: string };
const SIN_ERROR: ErrorPg = { code: '', constraint: null, message: '(no falló)' };

async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return SIN_ERROR;
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string };
    return {
      code: err.code ?? '(sin code)',
      constraint: err.constraint ?? null,
      message: err.message ?? String(e),
    };
  }
}

function esperarRechazo(actual: ErrorPg, code: string, constraint: string | null, porque: string): void {
  expect({ code: actual.code, constraint: actual.constraint }, porque).toEqual({ code, constraint });
}

/** `USUARIOS.socio` tiene membresía en A y en B — para que la RLS no frene y solo quede el CHECK/FK. */
function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

// =============================================================================
// A — `cuenta_atributo_padron_socio_chk` (2 mutaciones, 2 legítimos)
// =============================================================================
describe('0027 A — equivalencia rol_funcional ⟺ padron_socio_id (D-25)', () => {
  async function crearCuenta(ej: Ejecutar): Promise<string> {
    const f = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [
      s.clienteA,
    ]);
    return String(f['id']);
  }

  async function crearSocio(ej: Ejecutar): Promise<string> {
    const semilla = randomUUID();
    const f = await una(
      ej,
      `insert into padron_socio
         (cliente_id, denominacion, documento_tipo, documento_hmac, documento_ultimos4, pepper_id,
          vigente_desde)
       values ($1, 'SOCIO SINTÉTICO 0027', 'cuit', decode(md5($2), 'hex') || decode(md5($2), 'hex'),
               '0000', 'v1', '2026-01-01')
       returning id::text as id`,
      [s.clienteA, semilla],
    );
    return String(f['id']);
  }

  it('M-A1 🔴 `rol_funcional` GENÉRICO con `padron_socio_id` cargado muere por el CHECK', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuentaId = await crearCuenta(ej);
        const socioId = await crearSocio(ej);
        return una(
          ej,
          `insert into cuenta_atributo
             (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, padron_socio_id,
              vigente_desde, respaldo)
           values ($1, $2, '1.1.1', 'CUENTA GENERICA', 1, 'generica', $3, '2026-01-01', 'test M-A1')
           returning id`,
          [s.clienteA, cuentaId, socioId],
        );
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'cuenta_atributo_padron_socio_chk',
      'una cuenta genérica con padron_socio_id cargado entró a la base — la relación societaria se ' +
        'infiere de una columna que no debería tenerla',
    );
  });

  it('M-A2 🔴 `rol_funcional = cuenta_particular_socio` SIN `padron_socio_id` muere por el CHECK', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuentaId = await crearCuenta(ej);
        return una(
          ej,
          `insert into cuenta_atributo
             (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
           values ($1, $2, '1.1.2', 'CTA PARTICULAR SIN SOCIO', 1, 'cuenta_particular_socio',
                   '2026-01-01', 'test M-A2')
           returning id`,
          [s.clienteA, cuentaId],
        );
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'cuenta_atributo_padron_socio_chk',
      'una cuenta "particular de socio" sin socio referenciado no puede representar la relación que su ' +
        'propio rol_funcional afirma',
    );
  });

  it('legítimo: genérica sin socio, y particular de socio CON socio, entran las dos', async () => {
    await comoSocio(async (ej) => {
      const cuentaGenerica = await crearCuenta(ej);
      await una(
        ej,
        `insert into cuenta_atributo
           (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, vigente_desde, respaldo)
         values ($1, $2, '1.1.3', 'CUENTA GENERICA OK', 1, 'generica', '2026-01-01', 'legítimo')
         returning id`,
        [s.clienteA, cuentaGenerica],
      );

      const cuentaParticular = await crearCuenta(ej);
      const socioId = await crearSocio(ej);
      const fila = await una(
        ej,
        `insert into cuenta_atributo
           (cliente_id, cuenta_id, codigo, denominacion, nivel, rol_funcional, padron_socio_id,
            vigente_desde, respaldo)
         values ($1, $2, '1.1.4', 'CTA PARTICULAR OK', 1, 'cuenta_particular_socio', $3, '2026-01-01',
                 'legítimo')
         returning id`,
        [s.clienteA, cuentaParticular, socioId],
      );
      expect(fila['id']).toBeTruthy();
    });
  });
});

// =============================================================================
// B — `asiento_renglon_montos_chk` (1 mutación, 2 legítimos)
// =============================================================================
describe('0027 B — un renglón nunca es debe Y haber a la vez', () => {
  async function crearAsiento(ej: Ejecutar): Promise<{ asientoId: string; cuentaId: string }> {
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
       values ($1, 'mensual', '2026-08-01', '2026-08-31')
       returning id::text as id`,
      [s.clienteA],
    );
    const asiento = await una(
      ej,
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', '2026-08-15')
       returning id::text as id`,
      [s.clienteA, cierre['id']],
    );
    const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [
      s.clienteA,
    ]);
    return { asientoId: String(asiento['id']), cuentaId: String(cuenta['id']) };
  }

  it('M-B1 🔴 `debe` y `haber` ambos > 0 en el mismo renglón muere por el CHECK', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const { asientoId, cuentaId } = await crearAsiento(ej);
        return una(
          ej,
          `insert into asiento_propuesto_renglon
             (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion)
           values ($1, $2, 1, $3, '{}'::jsonb, 100, 50, '2026-08-15')
           returning id`,
          [s.clienteA, asientoId, cuentaId],
        );
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'asiento_renglon_montos_chk',
      'un renglón con debe=100 y haber=50 simultáneos entró — un renglón de asiento es de un solo lado',
    );
  });

  it('legítimo: un renglón debe, otro haber, entran los dos', async () => {
    await comoSocio(async (ej) => {
      const { asientoId, cuentaId } = await crearAsiento(ej);
      const r1 = await una(
        ej,
        `insert into asiento_propuesto_renglon
           (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion)
         values ($1, $2, 1, $3, '{}'::jsonb, 100, 0, '2026-08-15') returning id`,
        [s.clienteA, asientoId, cuentaId],
      );
      const r2 = await una(
        ej,
        `insert into asiento_propuesto_renglon
           (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion)
         values ($1, $2, 2, $3, '{}'::jsonb, 0, 100, '2026-08-15') returning id`,
        [s.clienteA, asientoId, cuentaId],
      );
      expect(r1['id']).toBeTruthy();
      expect(r2['id']).toBeTruthy();
    });
  });
});

// =============================================================================
// C — el gate de D-24, en sus dos capas (RLS + trigger)
// =============================================================================
describe('0027 C — gate de confirmación (D-24)', () => {
  /** Cierre + expectativa CONFIRMADA + pendiente ABIERTO de `documento_faltante` contra esa expectativa. */
  async function armarEscenarioBloqueado(ej: Ejecutar): Promise<{ cierreId: string; pendienteId: string }> {
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta, cierre_estado)
       values ($1, 'mensual', '2026-09-01', '2026-09-30', 'en_revision')
       returning id::text as id`,
      [s.clienteA],
    );
    const expectativa = await una(
      ej,
      `insert into expectativa_fuente_cliente
         (cliente_id, tipo_documento, periodicidad, origen, confirmada, vigencia_desde)
       values ($1, 'extracto', 'mensual', 'declarado', true, '2026-01-01')
       returning id::text as id`,
      [s.clienteA],
    );
    const pendiente = await una(
      ej,
      `insert into pendiente_cierre
         (cliente_id, cierre_id, expectativa_id, motivo_codigo, pendiente_estado)
       values ($1, $2, $3, 'documento_faltante', 'abierto')
       returning id::text as id`,
      [s.clienteA, cierre['id'], expectativa['id']],
    );
    return { cierreId: String(cierre['id']), pendienteId: String(pendiente['id']) };
  }

  it('M-C1 🔴 confirmar con el pendiente ABIERTO muere por el trigger del gate (P0001)', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const { cierreId } = await armarEscenarioBloqueado(ej);
        return ej(
          `update cierre_cliente_periodo
             set cierre_estado = 'confirmado', confirmado_en = now(), confirmado_por = $3
           where cliente_id = $1 and id = $2`,
          [s.clienteA, cierreId, USUARIOS.socio],
        );
      }),
    );
    esperarRechazo(
      error,
      'P0001',
      null,
      'D-24: un pendiente abierto de fuente esperada-confirmada tiene que bloquear la confirmación, ' +
        'para CUALQUIER rol que la intente — no solo por convención de la app',
    );
  });

  it('legítimo: dispensar el pendiente desbloquea la confirmación', async () => {
    await comoSocio(async (ej) => {
      const { cierreId, pendienteId } = await armarEscenarioBloqueado(ej);

      await ej(
        `insert into pendiente_dispensa (cliente_id, pendiente_cierre_id, motivo, dispensado_por)
         values ($1, $2, 'test: dispensado para M-C legítimo', $3)`,
        [s.clienteA, pendienteId, USUARIOS.socio],
      );
      await ej(`update pendiente_cierre set pendiente_estado = 'dispensado' where cliente_id = $1 and id = $2`, [
        s.clienteA,
        pendienteId,
      ]);

      const confirmado = await una(
        ej,
        `update cierre_cliente_periodo
           set cierre_estado = 'confirmado', confirmado_en = now(), confirmado_por = $3
         where cliente_id = $1 and id = $2 returning cierre_estado as "cierreEstado"`,
        [s.clienteA, cierreId, USUARIOS.socio],
      );
      expect(confirmado['cierreEstado']).toBe('confirmado');
    });
  });

  it('M-C2 🔴 `administrativo` no puede escribir `cierre_estado = confirmado` — RLS lo rechaza (42501)', async () => {
    const duenio = await clienteDuenio();
    let cierreId = '';
    try {
      const f = await duenio.query<{ id: string }>(
        `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta, cierre_estado)
         values ($1, 'mensual', '2026-10-01', '2026-10-31', 'en_revision')
         returning id::text as id`,
        [s.clienteA],
      );
      cierreId = f.rows[0]?.id as string;
    } finally {
      await duenio.end();
    }

    const error = await capturar(() =>
      conUsuario(USUARIOS.administrativoA, (tx) =>
        tx.consultar(
          `update cierre_cliente_periodo
             set cierre_estado = 'confirmado', confirmado_en = now(), confirmado_por = $2
           where cliente_id = $1 and id = $3`,
          [s.clienteA, USUARIOS.administrativoA, cierreId],
        ),
      ),
    );
    expect(error.code, 'administrativo tiene que fallar por RLS al intentar confirmar').toBe('42501');
  });
});

// =============================================================================
// D — `cierre_periodo_confirmacion_chk` (1 mutación, 1 legítimo)
// =============================================================================
describe('0027 D — `confirmado` exige `confirmado_en` Y `confirmado_por` juntos', () => {
  it('M-D1 🔴 `cierre_estado=confirmado` sin `confirmado_por` muere por el CHECK', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cierre = await una(
          ej,
          `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
           values ($1, 'mensual', '2026-11-01', '2026-11-30') returning id::text as id`,
          [s.clienteA],
        );
        return ej(
          `update cierre_cliente_periodo set cierre_estado = 'confirmado', confirmado_en = now()
           where cliente_id = $1 and id = $2`,
          [s.clienteA, cierre['id']],
        );
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'cierre_periodo_confirmacion_chk',
      'un cierre confirmado sin confirmado_por no tiene quién lo confirmó — el mismo patrón que ya ' +
        'costó el incidente de hecho_por/confirmado_por nulo como camuflaje',
    );
  });

  it('legítimo: confirmado con los dos campos entra', async () => {
    await comoSocio(async (ej) => {
      const cierre = await una(
        ej,
        `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
         values ($1, 'mensual', '2026-12-01', '2026-12-31') returning id::text as id`,
        [s.clienteA],
      );
      const actualizado = await una(
        ej,
        `update cierre_cliente_periodo
           set cierre_estado = 'confirmado', confirmado_en = now(), confirmado_por = $2
         where cliente_id = $1 and id = $3 returning cierre_estado as "cierreEstado"`,
        [s.clienteA, USUARIOS.socio, cierre['id']],
      );
      expect(actualizado['cierreEstado']).toBe('confirmado');
    });
  });
});
