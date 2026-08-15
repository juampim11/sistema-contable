/**
 * COBERTURA CONDUCTUAL DEL VECTOR `pg_temp` — migración 0015, incidente #1.
 *
 * R10 y R10 bis (`catalogo.test.ts`) son ESTÁTICOS: leen `pg_proc.proconfig` y `pg_roles`. Eso es
 * necesario y no es suficiente — la regla anterior también era estática, también estaba verde, y el
 * esquema era explotable igual. Un predicado sobre el catálogo prueba que el `search_path` está
 * escrito como queremos; **no** prueba que Postgres resuelva los nombres donde creemos.
 *
 * Este archivo prueba el COMPORTAMIENTO: planta la trampa de verdad y verifica que las funciones de
 * tenancía siguen leyendo las tablas reales. Es el test que, corrido contra el esquema del 9 al 14 de
 * agosto, se habría puesto rojo — y ninguno de los que existían lo hacía.
 *
 * ## Por qué la sesión del DUEÑO
 *
 * `pg_temp` es POR SESIÓN, y una `security definer` corre con el rol del dueño pero en la sesión de
 * QUIEN LLAMA: ve el `pg_temp` del llamador. Después de 0015 §2 (`revoke temporary … from public`)
 * ningún rol de aplicación puede plantar nada, así que la única sesión que puede montar el escenario
 * es la del dueño —que conserva `TEMPORARY` por ser dueño de la base—. Eso NO debilita la prueba: el
 * dueño es el peor caso, porque las `security definer` corren justamente con sus privilegios.
 *
 * ## El control de vacuidad no es opcional
 *
 * Un test que "no encuentra fuga" porque la trampa nunca se plantó es exactamente el bug que este
 * archivo existe para no repetir. Por eso cada caso afirma primero, con un valor exacto, que la
 * trampa quedó plantada y visible.
 *
 * Corre contra Postgres REAL:  pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { clienteDuenio } from './ayuda.ts';

/**
 * Conexión propia y exclusiva. No se reusa la de `catalogo.test.ts`: un `pg_temp` plantado sobrevive
 * a la transacción si no se lo tira, y dejaría la trampa colgada para los demás tests del archivo.
 */
let db: Client;

/** UUIDs SINTÉTICOS y evidentes. Ninguno puede coincidir con un nodo real de ninguna base. */
const NODO_FALSO = 'deadbeef-0000-4000-8000-000000000001';
const USUARIO_FALSO = 'deadbeef-0000-4000-8000-000000000002';

beforeAll(async () => {
  db = await clienteDuenio();
});

afterAll(async () => {
  await db?.end();
});

describe('pg_temp shadowing — cobertura conductual de 0015', () => {
  /**
   * `app.exigir_nodo_cliente()` es el renglón (3) de la plantilla de ADR-0001 §5 y está en **15
   * tablas de dominio**. Es INVOKER, así que la R10 vieja —filtrada por `prosecdef`— no la miraba.
   *
   * El escenario usa una tabla propia con el mismo trigger en vez de una tabla de dominio: así la
   * prueba mide el trigger y no las columnas de la tabla del mes que viene. Todo va dentro de una
   * transacción que se revierte, incluida la temporal.
   */
  it('exigir_nodo_cliente rechaza un cliente_id que SOLO existe en pg_temp.tenant_node', async () => {
    await db.query('begin');
    try {
      await db.query('create table public._qa_pg_temp (cliente_id uuid not null)');
      await db.query(
        `create trigger _qa_exigir before insert on public._qa_pg_temp
           for each row execute function app.exigir_nodo_cliente()`,
      );

      // La trampa: mismas columnas que lee el cuerpo del trigger.
      await db.query(
        `create temp table tenant_node (
           id uuid, tipo text, deleted_at timestamptz, path text, parent_id uuid, nid bigint)`,
      );
      await db.query(
        `insert into pg_temp.tenant_node (id, tipo, deleted_at, path, nid)
         values ($1, 'cliente', null, '1', 1)`,
        [NODO_FALSO],
      );

      // CONTROL DE VACUIDAD: la trampa está plantada y es visible desde esta sesión.
      const { rows: control } = await db.query<{ n: string }>(
        'select count(*)::text as n from pg_temp.tenant_node',
      );
      expect(control[0]?.n, 'la trampa no se plantó: el caso no prueba nada').toBe('1');

      // Y el nodo NO existe en la tabla real.
      const { rows: real } = await db.query<{ n: string }>(
        'select count(*)::text as n from public.tenant_node where id = $1',
        [NODO_FALSO],
      );
      expect(real[0]?.n, 'el uuid sintético no puede existir en la tabla real').toBe('0');

      // El insert TIENE que ser rechazado por el trigger, con el mensaje exacto de 0015.
      await expect(
        db.query('insert into public._qa_pg_temp (cliente_id) values ($1)', [NODO_FALSO]),
      ).rejects.toThrow(`cliente_id ${NODO_FALSO} no es un nodo activo de tipo cliente`);
    } finally {
      await db.query('rollback');
    }
  });

  /**
   * `app.accessible_tenant_ids()` es el predicado de RLS de TODA tabla de dominio, y
   * `app.has_role_on()` es el `with check` de las policies de escritura y el control de N2-R. Con la
   * trampa plantada, el vector medido en 0015 daba `tenant_node: 1 -> 5` y `has_role_on(...) = true`.
   */
  it('accessible_tenant_ids y has_role_on ignoran una pg_temp.membership plantada', async () => {
    await db.query('begin');
    try {
      await db.query(
        'create temp table membership (user_id uuid, tenant_node_id uuid, rol text, activo boolean)',
      );
      await db.query(
        `create temp table tenant_node (
           id uuid, parent_id uuid, path text, nid bigint, deleted_at timestamptz, tipo text)`,
      );
      await db.query(`insert into pg_temp.tenant_node values ($1, null, '1', 1, null, 'estudio')`, [
        NODO_FALSO,
      ]);
      await db.query(`insert into pg_temp.membership values ($1, $2, 'socio', true)`, [
        USUARIO_FALSO,
        NODO_FALSO,
      ]);

      // CONTROL DE VACUIDAD, exacto: una fila en cada trampa.
      const { rows: control } = await db.query<{ m: string; t: string }>(
        `select (select count(*) from pg_temp.membership)::text as m,
                (select count(*) from pg_temp.tenant_node)::text as t`,
      );
      expect([control[0]?.m, control[0]?.t], 'las trampas no se plantaron').toEqual(['1', '1']);

      // La sesión se declara ese usuario. Si las funciones leyeran la trampa, tendría un estudio.
      await db.query(`select set_config('app.user_id', $1, true)`, [USUARIO_FALSO]);

      const { rows: accesibles } = await db.query<{ n: string }>(
        'select count(*)::text as n from app.accessible_tenant_ids()',
      );
      expect(
        accesibles[0]?.n,
        'accessible_tenant_ids leyó pg_temp.membership: el predicado de RLS de todas las tablas de ' +
          'dominio quedó bajo control de quien plante la temporal. Ver 0015 y el incidente #1.',
      ).toBe('0');

      const { rows: rol } = await db.query<{ puede: boolean }>(
        `select app.has_role_on($1::uuid, array['socio']::app.rol_membership[]) as puede`,
        [NODO_FALSO],
      );
      expect(
        rol[0]?.puede,
        'has_role_on leyó pg_temp: es el `with check` de las policies de escritura, así que esto ' +
          'no es una fuga de lectura sino una escalada — habilita insertarse una membresía real.',
      ).toBe(false);
    } finally {
      await db.query('rollback');
    }
  });

  /**
   * `app.verificar_coherencia_path()` es el falla-cerrado de `app.reparentar_nodo()`: si lee una
   * trampa vacía, un reparentado que rompió el árbol se da por bueno.
   */
  it('verificar_coherencia_path ignora una pg_temp.tenant_node incoherente', async () => {
    await db.query('begin');
    try {
      await db.query(
        `create temp table tenant_node (
           id uuid, parent_id uuid, path text, nid bigint, deleted_at timestamptz, tipo text)`,
      );
      // Una fila deliberadamente incoherente: path '99' con nid 1. Si la función la leyera, la
      // reportaría; leyendo la tabla real no reporta nada.
      await db.query(`insert into pg_temp.tenant_node values ($1, null, '99', 1, null, 'estudio')`, [
        NODO_FALSO,
      ]);

      const { rows: control } = await db.query<{ n: string }>(
        'select count(*)::text as n from pg_temp.tenant_node',
      );
      expect(control[0]?.n, 'la trampa no se plantó: el caso no prueba nada').toBe('1');

      const { rows } = await db.query<{ id: string }>(
        'select id::text as id from app.verificar_coherencia_path()',
      );
      expect(
        rows.map((f) => f.id),
        'verificar_coherencia_path leyó pg_temp.tenant_node: el falla-cerrado de reparentar_nodo ' +
          'quedó bajo control de quien plante la temporal.',
      ).toEqual([]);
    } finally {
      await db.query('rollback');
    }
  });

  /**
   * La mitad (b) de 0015 — `pg_temp` ÚLTIMO en el `search_path`— existe para cubrir la referencia sin
   * calificar que quede colgada mañana. Este caso la mide DIRECTO, con una función escrita acá que
   * NO califica el esquema: la única defensa que la separa de la trampa es el `search_path`.
   *
   * 🔴 Es el caso que R10 daba VERDE cuando el `search_path` era `pg_temp, public, app, pg_temp`
   * (pg_temp repetido) o `pg_temp` a secas: Postgres resuelve por PRIMERA aparición, así que el
   * predicado "termina en pg_temp" no alcanza. Acá se mide el efecto, no la forma.
   */
  it('con el search_path de 0015, un cuerpo SIN calificar sigue leyendo la tabla real', async () => {
    await db.query('begin');
    try {
      await db.query(
        `create function pg_temp._qa_sin_calificar() returns bigint
           language sql stable
           set search_path = pg_catalog, public, app, pg_temp
         as $$ select count(*) from tenant_node $$`,
      );
      await db.query(
        `create temp table tenant_node (
           id uuid, parent_id uuid, path text, nid bigint, deleted_at timestamptz, tipo text)`,
      );
      await db.query(`insert into pg_temp.tenant_node values ($1, null, '1', 1, null, 'estudio')`, [
        NODO_FALSO,
      ]);

      const { rows } = await db.query<{ trampa: string; leido: string; real: string }>(
        `select (select count(*) from pg_temp.tenant_node)::text as trampa,
                pg_temp._qa_sin_calificar()::text                as leido,
                (select count(*) from public.tenant_node)::text   as real`,
      );
      // CONTROL DE VACUIDAD: la trampa existe y tiene EXACTAMENTE una fila…
      expect(rows[0]?.trampa, 'la trampa no se plantó: el caso no prueba nada').toBe('1');
      // …y la función leyó la tabla real, no la trampa. Comparación EXACTA contra el conteo real.
      expect(
        rows[0]?.leido,
        'un cuerpo sin calificar leyó pg_temp: la mitad (b) de 0015 no está sosteniendo nada. ' +
          'Revisá que el search_path tenga pg_temp ÚLTIMO y UNA SOLA VEZ.',
      ).toBe(rows[0]?.real);
    } finally {
      await db.query('rollback');
    }
  });
});
