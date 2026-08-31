/**
 * MUTACIONES de `0030_regla_imputacion.sql` — prueba por mutación de los invariantes NUEVOS de esta
 * migración (CLAUDE.md §1.8): código defectuoso que la pone roja, su caso legítimo, conteo declarado.
 * No repite la cobertura genérica de la plantilla de siete renglones ni la de los dominios cerrados
 * (`tipo_movimiento`/`concepto`/`cuenta_resolucion`, cubiertos por `catalogo.test.ts`); cubre lo
 * específico de este esquema:
 *
 *   A. `regla_imputacion_cuenta_chk` — equivalencia cuenta_resolucion='fija' ⟺ cuenta_id NOT NULL.
 *      Es la encarnación directa de D-29 ("sin esto alguien hornea `SOCIO XX`", `04-imputacion-
 *      contable.md` §8 punto 3) — la mutación de referencia es debilitar la equivalencia a una
 *      implicación de un solo sentido (`cuenta_resolucion <> 'fija' or cuenta_id is not null`), que
 *      deja de rechazar que una resolución 'por_socio' traiga un `cuenta_id` cargado.
 *   B. `regla_imputacion_rol_chk` — equivalencia simétrica, cuenta_resolucion='por_socio' ⟺
 *      rol_funcional_objetivo NOT NULL.
 *   C. `uq_regla_imputacion_vigente` — una sola vigencia ABIERTA por (cliente, tipo, concepto),
 *      con `concepto IS NULL` tratado como valor (nulls not distinct) — sin esto, dos reglas con
 *      concepto NULL abiertas a la vez no chocan y el motor queda con ambigüedad permanente
 *      (security-engineer, convocatoria de esta migración).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, con `0030` aplicada.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

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

/** Mismo criterio que `mutaciones-0027.test.ts`: código + constraint, NUNCA `rejects.toThrow()` a secas. */
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

/** `USUARIOS.socio` tiene membresía en A y en B — para que la RLS no frene y solo quede el CHECK/índice. */
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

async function crearCuenta(ej: Ejecutar, clienteId: string): Promise<string> {
  const f = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [
    clienteId,
  ]);
  return String(f['id']);
}

// =============================================================================
// A — `regla_imputacion_cuenta_chk` (2 mutaciones, 1 legítimo)
// =============================================================================
describe('0030 A — equivalencia cuenta_resolucion=fija ⟺ cuenta_id NOT NULL (D-29)', () => {
  it('M-A1 🔴 `por_socio` CON `cuenta_id` cargado muere por el CHECK (el defecto que hornea SOCIO XX)', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuentaId = await crearCuenta(ej, s.clienteA);
        return una(
          ej,
          `insert into regla_imputacion
             (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, rol_funcional_objetivo,
              vigente_desde, respaldo, decidido_por)
           values ($1, 'retiro_de_socio', 'por_socio', $2, 'retiro_de_socio', '2026-01-01',
                   'test M-A1', $3)
           returning id`,
          [s.clienteA, cuentaId, USUARIOS.socio],
        );
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'regla_imputacion_cuenta_chk',
      'una regla por_socio con cuenta_id cargado horneó una cuenta fija en una resolución que debería ' +
        'resolverse dinámicamente contra el socio del movimiento',
    );
  });

  it('M-A2 🔴 `fija` SIN `cuenta_id` muere por el CHECK', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) =>
        una(
          ej,
          `insert into regla_imputacion
             (cliente_id, tipo_movimiento, cuenta_resolucion, vigente_desde, respaldo, decidido_por)
           values ($1, 'comision_bancaria', 'fija', '2026-01-01', 'test M-A2', $2)
           returning id`,
          [s.clienteA, USUARIOS.socio],
        ),
      ),
    );
    esperarRechazo(
      error,
      '23514',
      'regla_imputacion_cuenta_chk',
      'una resolución fija sin cuenta_id no tiene a qué cuenta imputar — el nombre de la resolución ' +
        'deja de significar lo que dice',
    );
  });

  it('legítimo: fija CON cuenta_id, y por_socio SIN cuenta_id, entran las dos', async () => {
    await comoSocio(async (ej) => {
      const cuentaId = await crearCuenta(ej, s.clienteA);
      const fija = await una(
        ej,
        `insert into regla_imputacion
           (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo,
            decidido_por)
         values ($1, 'comision_bancaria', 'fija', $2, '2026-01-01', 'legítimo', $3)
         returning id`,
        [s.clienteA, cuentaId, USUARIOS.socio],
      );
      expect(fija['id']).toBeTruthy();

      const porSocio = await una(
        ej,
        `insert into regla_imputacion
           (cliente_id, tipo_movimiento, cuenta_resolucion, rol_funcional_objetivo, vigente_desde,
            respaldo, decidido_por)
         values ($1, 'aporte_de_socio', 'por_socio', 'aporte_de_socio', '2026-01-01', 'legítimo', $2)
         returning id`,
        [s.clienteA, USUARIOS.socio],
      );
      expect(porSocio['id']).toBeTruthy();
    });
  });
});

// =============================================================================
// B — `regla_imputacion_rol_chk` (1 mutación, cubierta también por el legítimo de A)
// =============================================================================
describe('0030 B — equivalencia cuenta_resolucion=por_socio ⟺ rol_funcional_objetivo NOT NULL', () => {
  it('M-B1 🔴 `fija` CON `rol_funcional_objetivo` cargado muere por el CHECK', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuentaId = await crearCuenta(ej, s.clienteA);
        return una(
          ej,
          `insert into regla_imputacion
             (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, rol_funcional_objetivo,
              vigente_desde, respaldo, decidido_por)
           values ($1, 'comision_bancaria', 'fija', $2, 'retiro_de_socio', '2026-01-01', 'test M-B1',
                   $3)
           returning id`,
          [s.clienteA, cuentaId, USUARIOS.socio],
        );
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'regla_imputacion_rol_chk',
      'una resolución fija con rol_funcional_objetivo cargado afirma una relación societaria que esa ' +
        'resolución no usa — dato muerto que puede confundir a quien lea la regla después',
    );
  });
});

// =============================================================================
// C — `uq_regla_imputacion_vigente` (1 mutación conceptual: dos vigencias abiertas del mismo tipo)
// =============================================================================
describe('0030 C — una sola vigencia ABIERTA por (cliente, tipo, concepto), concepto NULL incluido', () => {
  it('M-C1 🔴 segunda regla ABIERTA para el mismo (cliente, tipo, concepto NULL) muere por unicidad', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuenta1 = await crearCuenta(ej, s.clienteB);
        const cuenta2 = await crearCuenta(ej, s.clienteB);
        await una(
          ej,
          `insert into regla_imputacion
             (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo,
              decidido_por)
           values ($1, 'deposito_efectivo', 'fija', $2, '2026-01-01', 'primera vigencia', $3)
           returning id`,
          [s.clienteB, cuenta1, USUARIOS.socio],
        );
        // Sin `vigente_hasta` en la primera: esta segunda inserción es OTRA vigencia abierta para el
        // mismo (cliente, tipo, concepto=NULL) — sin `nulls not distinct` en el índice, Postgres NO
        // vería colisión (NULL ≠ NULL) y esto entraría sin control (el defecto que la regla evita).
        return una(
          ej,
          `insert into regla_imputacion
             (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo,
              decidido_por)
           values ($1, 'deposito_efectivo', 'fija', $2, '2026-02-01', 'segunda vigencia', $3)
           returning id`,
          [s.clienteB, cuenta2, USUARIOS.socio],
        );
      }),
    );
    esperarRechazo(
      error,
      '23505',
      'uq_regla_imputacion_vigente',
      'dos reglas abiertas a la vez para el mismo (cliente, tipo, concepto=NULL) dejan al motor con ' +
        'ambigüedad permanente sobre cuál está vigente',
    );
  });

  it('legítimo: cerrar la primera vigencia (`vigente_hasta`) habilita la segunda', async () => {
    await comoSocio(async (ej) => {
      const cuenta1 = await crearCuenta(ej, s.clienteA);
      const cuenta2 = await crearCuenta(ej, s.clienteA);
      const primera = await una(
        ej,
        `insert into regla_imputacion
           (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo,
            decidido_por)
         values ($1, 'extraccion_efectivo', 'fija', $2, '2026-01-01', 'legítimo, primera', $3)
         returning id::text as id`,
        [s.clienteA, cuenta1, USUARIOS.socio],
      );

      await ej(`update regla_imputacion set vigente_hasta = '2026-01-31' where id = $1`, [
        primera['id'],
      ]);

      const segunda = await una(
        ej,
        `insert into regla_imputacion
           (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo,
            decidido_por)
         values ($1, 'extraccion_efectivo', 'fija', $2, '2026-02-01', 'legítimo, segunda', $3)
         returning id`,
        [s.clienteA, cuenta2, USUARIOS.socio],
      );
      expect(segunda['id']).toBeTruthy();
    });
  });
});
