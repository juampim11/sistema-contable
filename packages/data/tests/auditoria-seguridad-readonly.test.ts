/**
 * `auditoria_seguridad_readonly` — R42 (ADR-0002-seguridad.md), migraciones `0023` y `0035`.
 *
 * Motivo angosto de `MotivoJob` para correr un diagnóstico de seguridad de solo lectura, cross-tenant,
 * contra la base real (piloto), sin abrir una puerta general de acceso. `app_job` (BYPASSRLS) sigue
 * siendo la misma credencial de siempre — lo que cambia es que, con este motivo, `conJob`
 * (`packages/data/src/db/conexion.ts`) fija `set transaction read only` ANTES de correr la transacción.
 *
 * `0035` amplía el grant original de `0023` para que `detectar-lotes-desactualizados.ts` pueda agrupar
 * por lote: agrega `lote_ingesta_id` al grant sobre `movimiento_bancario_crudo` y un grant nuevo sobre
 * `lote_ingesta` (`id`, `cliente_id`, `banco_codigo`, `estado`, `created_at` — nunca
 * `archivo_clave`/`motivo_codigo`/`procesado_por`).
 *
 * Dos verificaciones:
 *   a. Que `app_job` tiene EXACTAMENTE las columnas de grant declaradas (3 tablas), cero de más — leído
 *      del catálogo real de Postgres, no inferido del código TypeScript.
 *   b. Prueba de mutación (ADR-0002 §B.0): un intento de escritura DENTRO de
 *      `conJob('auditoria_seguridad_readonly', …)` lo rechaza Postgres con `25006` (transacción de
 *      solo lectura) — el código de error IMPORTA: `42501` (permiso insuficiente) sería una causa
 *      distinta, y confundirlas significa no saber cuál de las dos está conteniendo de verdad.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { conJob } from '../src/db/conexion.ts';
import { clienteDuenio } from './ayuda.ts';

let db: Client;

beforeAll(async () => {
  db = await clienteDuenio();
});

afterAll(async () => {
  await db?.end();
});

describe('R42 — grant angosto de auditoria_seguridad_readonly (0023 + 0035)', () => {
  it('app_job tiene exactamente las columnas otorgadas, y ninguna más', async () => {
    const { rows } = await db.query<{ tabla: string; columna: string }>(
      `select table_name as tabla, column_name as columna
         from information_schema.column_privileges
        where grantee = 'app_job'
          and table_name in ('movimiento_origen_crudo', 'movimiento_bancario_crudo', 'lote_ingesta')
          and privilege_type = 'SELECT'
        order by 1, 2`,
    );
    const enBase = rows.map((f) => `${f.tabla}.${f.columna}`);
    expect(enBase, 'el grant de app_job sobre las tres tablas divergió de lo declarado en 0023/0035').toEqual([
      'lote_ingesta.banco_codigo',
      'lote_ingesta.cliente_id',
      'lote_ingesta.created_at',
      'lote_ingesta.estado',
      'lote_ingesta.id',
      'movimiento_bancario_crudo.cliente_id',
      'movimiento_bancario_crudo.descripcion',
      'movimiento_bancario_crudo.id',
      'movimiento_bancario_crudo.lote_ingesta_id',
      'movimiento_origen_crudo.cliente_id',
      'movimiento_origen_crudo.fila_origen',
      'movimiento_origen_crudo.movimiento_id',
    ]);
  });

  it('app_job no tiene ningún otro privilegio (INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER) sobre las tres tablas', async () => {
    const { rows } = await db.query<{ tabla: string; privilegio: string }>(
      `select table_name as tabla, privilege_type as privilegio
         from information_schema.column_privileges
        where grantee = 'app_job'
          and table_name in ('movimiento_origen_crudo', 'movimiento_bancario_crudo', 'lote_ingesta')
          and privilege_type <> 'SELECT'`,
    );
    expect(rows, 'app_job tiene un privilegio por columna más allá del SELECT declarado').toEqual([]);

    // DELETE/TRUNCATE/TRIGGER no son expresables por columna (misma razón que R41 en
    // grants-conjunto-cerrado.test.ts): se verifican aparte, a nivel tabla.
    for (const tabla of ['movimiento_origen_crudo', 'movimiento_bancario_crudo', 'lote_ingesta'] as const) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'] as const) {
        const { rows: r } = await db.query<{ puede: boolean }>(
          `select has_table_privilege('app_job', $1, $2) as puede`,
          [tabla, priv],
        );
        expect(r[0]?.puede, `app_job tiene ${priv} sobre ${tabla}`).toBe(false);
      }
    }
  });

  /**
   * 🔴 LA PRUEBA DE MUTACIÓN. Se elige para REFUTAR, no para confirmar (ADR-0002 §B.0): un `insert`
   * deliberadamente incompleto (le faltan columnas `not null`) igual tiene que morir por `25006` —y no
   * por `23502` (`not_null_violation`) ni por `42501` (`insufficient_privilege`, que además `app_job`
   * NO tiene sobre esta columna)— porque Postgres evalúa la transacción de solo lectura ANTES de
   * inicializar el plan de ejecución que revisaría permisos o constraints. Si esto alguna vez midiera
   * `42501`, sería la señal de que `set transaction read only` dejó de aplicarse antes del intento.
   */
  it('🔴 M: un INSERT dentro de auditoria_seguridad_readonly lo rechaza Postgres con 25006, no 42501', async () => {
    let capturado: unknown;
    try {
      await conJob('auditoria_seguridad_readonly', async (tx) => {
        await tx.consultar(
          `insert into movimiento_bancario_crudo (cliente_id, id) values (gen_random_uuid(), gen_random_uuid())`,
        );
      });
    } catch (error) {
      capturado = error;
    }
    const codigo = (capturado as { code?: unknown } | undefined)?.code;
    expect(
      codigo,
      `se esperaba el SQLSTATE 25006 (transacción de solo lectura). Recibido: ${JSON.stringify(codigo)}. ` +
        'Si es 42501, la contención real es el grant y no `set transaction read only` — hallazgo real, ' +
        'no un detalle a ajustar.',
    ).toBe('25006');
  });

  it('🔴 M: un UPDATE dentro de auditoria_seguridad_readonly lo rechaza Postgres con 25006, no 42501', async () => {
    let capturado: unknown;
    try {
      await conJob('auditoria_seguridad_readonly', async (tx) => {
        // `where false`: ni siquiera tocaría una fila si el rechazo no llegara primero. La prueba mide
        // el rechazo de la TRANSACCIÓN, no un efecto sobre datos.
        await tx.consultar(`update movimiento_origen_crudo set fila_origen = fila_origen where false`);
      });
    } catch (error) {
      capturado = error;
    }
    const codigo = (capturado as { code?: unknown } | undefined)?.code;
    expect(codigo, `se esperaba el SQLSTATE 25006. Recibido: ${JSON.stringify(codigo)}`).toBe('25006');
  });

  it('caso legítimo: un SELECT dentro de auditoria_seguridad_readonly funciona (no toda escritura implica que la lectura se rompió)', async () => {
    const filas = await conJob('auditoria_seguridad_readonly', async (tx) =>
      tx.consultar<{ n: number }>(`select count(*)::int as n from movimiento_origen_crudo`),
    );
    expect(typeof filas[0]?.n).toBe('number');
  });

  it('caso legítimo: un SELECT de las columnas EFECTIVAMENTE otorgadas no tira error de permisos (42501)', async () => {
    // El test anterior cuenta filas pero no toca ninguna columna del grant declarado en 0023 — este sí
    // selecciona exactamente `cliente_id, movimiento_id, fila_origen` de `movimiento_origen_crudo`,
    // `cliente_id, id, descripcion, lote_ingesta_id` de `movimiento_bancario_crudo`, y
    // `id, cliente_id, banco_codigo, estado, created_at` de `lote_ingesta` (0035). No hace falta que
    // la base local tenga filas: `limit 1` da 0 filas sin error, y eso ya prueba que el permiso está
    // bien otorgado.
    let errorOrigen: unknown;
    let errorBancario: unknown;
    let errorLote: unknown;
    try {
      await conJob('auditoria_seguridad_readonly', async (tx) => {
        await tx.consultar(
          `select cliente_id, movimiento_id, fila_origen from movimiento_origen_crudo limit 1`,
        );
      });
    } catch (error) {
      errorOrigen = error;
    }
    try {
      await conJob('auditoria_seguridad_readonly', async (tx) => {
        await tx.consultar(
          `select cliente_id, id, descripcion, lote_ingesta_id from movimiento_bancario_crudo limit 1`,
        );
      });
    } catch (error) {
      errorBancario = error;
    }
    try {
      await conJob('auditoria_seguridad_readonly', async (tx) => {
        await tx.consultar(`select id, cliente_id, banco_codigo, estado, created_at from lote_ingesta limit 1`);
      });
    } catch (error) {
      errorLote = error;
    }
    expect(errorOrigen, 'select de las columnas otorgadas de movimiento_origen_crudo falló').toBeUndefined();
    expect(
      errorBancario,
      'select de las columnas otorgadas de movimiento_bancario_crudo falló',
    ).toBeUndefined();
    expect(errorLote, 'select de las columnas otorgadas de lote_ingesta (0035) falló').toBeUndefined();
  });
});
