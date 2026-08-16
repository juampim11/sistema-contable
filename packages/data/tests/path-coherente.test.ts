/**
 * R36 — EL `path` DE `tenant_node` ES UNA FUNCIÓN DE `(parent_id, nid)`, NO UN DATO.
 * Migración 0017, incidentes #2 y #4.
 *
 * ## Por qué este archivo se reescribió entero
 *
 * La versión anterior probaba el ataque **sólo con `app_request`**, y con `0017` ese rol ya no tiene
 * privilegio de escritura sobre `path` ni `nid`: el ataque muere por `permission denied` antes de
 * llegar al invariante. Un test así **se pone verde el día que alguien re-otorgue
 * `grant … update on tenant_node to app_request`** copiando la plantilla de ADR-0001 §5 — que es el
 * escenario de regresión realista, mucho más que un atacante.
 *
 * Por eso cada ataque corre con **la identidad más privilegiada que corresponda**:
 *
 *   - con `app_request` se mide el **PRIVILEGIO** (que la aplicación no pueda tocar la estructura),
 *   - con `app_job` (BYPASSRLS, y con grant sobre `path`) y con el **dueño del esquema** se mide el
 *     **INVARIANTE** — que es lo que R36 realmente enuncia.
 *
 * Las dos mitades hacen falta y ninguna sustituye a la otra: sin privilegio, el dueño y los jobs
 * rompen el árbol en silencio; sin invariante, alcanza con un grant de más.
 *
 * ## Qué cambió en el mecanismo, y por qué el enunciado no lo nombra
 *
 * `0016` verificaba con un `constraint trigger` diferido que **re-leía la fila bajo RLS**, y trataba
 * «no puedo leer la fila» como violación. Medido en la ronda de cierre: eso no era lo que cerraba el
 * incidente —el ataque lo frenaba la comparación de coherencia— y dejaba tres agujeros: `nid` fuera
 * de la lista de columnas, el scan de hijos fallando ABIERTO, y operaciones legítimas abortadas.
 *
 * `0017` baja el invariante dos escalones, a `check` + `foreign key`, que Postgres **exime de la RLS
 * por diseño**. De ahí el corolario que gobierna este archivo:
 *
 * > **Un invariante verificado con la visibilidad del escritor no es un invariante.** Si el control
 * > lee con los privilegios de quien escribe, quien escribe elige lo que el control ve.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { cerrarConexiones, conJob, conUsuario } from '../src/db/conexion.ts';
import { clienteDuenio, clienteJob, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;
/** Dueño del esquema: superusuario en los entornos actuales. Mide MECANISMO puro. */
let duenio: Client;
/** `app_job`: BYPASSRLS y con grant de columna sobre `path`. Es el escritor legítimo del árbol. */
let job: Client;

/** Un `grupo` con un `cliente` adentro: el subárbol que se muda y el hijo que se puede dejar colgado. */
let grupo: string;
let clienteDelGrupo: string;

beforeAll(async () => {
  s = await sembrar();
  duenio = await clienteDuenio();

  job = await clienteJob();

  const filas = await duenio.query<{ grupo: string; cli: string }>(
    `with g as (
       insert into tenant_node (tipo, nombre, parent_id)
       values ('grupo', 'GRUPO CON HIJOS', $1) returning id
     ), c as (
       insert into tenant_node (tipo, nombre, parent_id)
       select 'cliente', 'CLIENTE DEL GRUPO SA', g.id from g returning id, parent_id
     )
     select c.parent_id::text as grupo, c.id::text as cli from c`,
    [s.estudio],
  );
  grupo = filas.rows[0]!.grupo;
  clienteDelGrupo = filas.rows[0]!.cli;
});

afterAll(async () => {
  await duenio?.end();
  await job?.end();
  await cerrarConexiones();
});

/** Lee con el DUEÑO, sin RLS: mide el estado real, no lo que el atacante ve. */
async function campo(id: string, col: 'path' | 'nid' | 'parent_path'): Promise<string> {
  const r = await duenio.query<{ v: string }>(
    `select ${col}::text as v from tenant_node where id = $1`,
    [id],
  );
  const v = r.rows[0]?.v;
  // CONTROL DE VACUIDAD: si el nodo no está, un test que compare contra '' pasaría por el motivo
  // equivocado. Mismo criterio que `pg-temp-shadowing.test.ts`.
  if (v === undefined) throw new Error(`el nodo ${id} no existe: el caso no prueba nada`);
  return v;
}

async function incoherentes(): Promise<number> {
  const r = await duenio.query<{ n: string }>(
    'select count(*)::text as n from app.verificar_coherencia_path()',
  );
  return Number(r.rows[0]?.n ?? -1);
}

/** Corre sentencias en una transacción que SIEMPRE revierte, y exige que aborte con `patron`. */
async function abortaCon(c: Client, sentencias: readonly string[], patron: RegExp): Promise<void> {
  let mensaje = '';
  try {
    await c.query('begin');
    for (const sql of sentencias) await c.query(sql);
    await c.query('commit');
  } catch (e) {
    mensaje = String((e as Error).message).split('\n')[0] ?? '';
  } finally {
    try {
      await c.query('rollback');
    } catch {
      /* la transacción ya estaba abortada */
    }
  }
  expect(mensaje, 'la transacción COMMITEÓ: el invariante no se está aplicando').not.toBe('');
  expect(mensaje).toMatch(patron);
}

/** Corre sentencias legítimas y exige que NO aborten. Revierte igual, para no dejar estado. */
async function pasa(c: Client, sentencias: readonly string[]): Promise<void> {
  let mensaje = '';
  try {
    await c.query('begin');
    for (const sql of sentencias) await c.query(sql);
    await c.query('rollback');
  } catch (e) {
    mensaje = String((e as Error).message).split('\n')[0] ?? '';
    try {
      await c.query('rollback');
    } catch {
      /* nada */
    }
  }
  expect(mensaje, 'una operación legítima abortó').toBe('');
}

describe('R36 / PRIVILEGIO — la aplicación no escribe la estructura del árbol', () => {
  it('app_request no puede empujar su cliente al subárbol ajeno, ni con app.reparentando prendido', async () => {
    const pathAjeno = await campo(s.estudio2, 'path');
    const nid = await campo(s.clienteA, 'nid');

    await expect(
      conUsuario(USUARIOS.socio, async (tx) => {
        await tx.consultar(`select set_config('app.reparentando','on',true)`);
        await tx.consultar('update tenant_node set path = $1 where id = $2', [
          `${pathAjeno}.${nid}`,
          s.clienteA,
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('app_request tampoco puede tocar nid — ni suelto ni junto a parent_id', async () => {
    // El segundo es el que importaba: con `parent_id = parent_id` el trigger de 0001 RECOMPUTA el
    // path desde el nid nuevo, así que el resultado salía coherente y 0016 lo bendecía.
    for (const sql of [
      'update tenant_node set nid = default where id = $1',
      'update tenant_node set nid = default, parent_id = parent_id where id = $1',
    ]) {
      await expect(
        conUsuario(USUARIOS.socio, (tx) => tx.consultar(sql, [s.clienteA])),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('ni app_request ni app_job pueden fijar nid en un insert (minado del secuencial global)', async () => {
    // `overriding system value` es el escape que la norma le da a quien tiene privilegio sobre la
    // columna. No hay constraint que lo pueda rechazar —todo nid es íntegramente válido—, así que
    // esto es privilegio y sólo privilegio.
    const sql =
      `insert into tenant_node (nid, tipo, nombre, parent_id) overriding system value ` +
      `values (999777, 'cliente', 'MINA SA', '${s.estudio}')`;
    await abortaCon(job, [sql], /permission denied/i);
    await expect(conUsuario(USUARIOS.socio, (tx) => tx.consultar(sql))).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('R36 / INVARIANTE — se cumple aunque el escritor sea app_job o el dueño', () => {
  it('app_job no puede escribir un path incoherente, ni con el GUC prendido', async () => {
    // app_job SÍ tiene grant sobre `path` (lo necesita `reparentar_nodo()`) y saltea RLS. Acá no lo
    // frena ningún privilegio: lo frena el CHECK, que es fila-local e inmune a la RLS.
    const pathAjeno = await campo(s.estudio2, 'path');
    const nid = await campo(s.clienteA, 'nid');
    await abortaCon(
      job,
      [
        `select set_config('app.reparentando','on',true)`,
        `update tenant_node set path = '${pathAjeno}.${nid}' where id = '${s.clienteA}'`,
      ],
      /tenant_node_path_chk|check constraint/i,
    );
  });

  it('app_job tampoco mintiendo path Y parent_path a la vez: ahí lo ataja la FK', async () => {
    const pathAjeno = await campo(s.estudio2, 'path');
    const nid = await campo(s.clienteA, 'nid');
    await abortaCon(
      job,
      [
        `select set_config('app.reparentando','on',true)`,
        `update tenant_node set path = '${pathAjeno}.${nid}', parent_path = '${pathAjeno}' ` +
          `where id = '${s.clienteA}'`,
      ],
      /foreign key|parent_path_fk/i,
    );
  });

  it('el DUEÑO del esquema tampoco puede cambiar nid — es mecanismo, no privilegio', async () => {
    // El grant por columna no le aplica al dueño. Por eso la inmutabilidad de `nid` va TAMBIÉN como
    // trigger: si sólo fuera privilegio, cualquier script de mantenimiento rompería el árbol.
    await abortaCon(
      duenio,
      [`update tenant_node set nid = default where id = '${s.clienteA}'`],
      /inmutable/i,
    );
  });

  it('parent_path nulo con parent_id no nulo queda prohibido (match full + check)', async () => {
    // Sin esto, un `parent_path` nulo satisfaría la FK "gratis" y el check admitiría `path = nid`:
    // o sea, sacar un nodo del subárbol de su propio estudio poniéndole un path de raíz.
    await abortaCon(
      duenio,
      [
        `select set_config('app.reparentando','on',true)`,
        `update tenant_node set parent_path = null where id = '${s.clienteA}'`,
      ],
      /nulo_chk|check constraint/i,
    );
  });
});

describe('R36 / HIJOS — mover un padre no puede dejar descendientes colgados', () => {
  it('mudar un padre a un path coherente CONSIGO MISMO, dejando al hijo atrás, aborta por FK', async () => {
    // El padre queda coherente, así que el CHECK fila-local lo acepta. Lo que queda mal es el HIJO,
    // cuyo `parent_path` ya no existe. Es exactamente lo que 0016 no veía.
    const pathAjeno = await campo(s.estudio2, 'path');
    const nidGrupo = await campo(grupo, 'nid');
    await abortaCon(
      duenio,
      [
        `select set_config('app.reparentando','on',true)`,
        `update tenant_node set path = '${pathAjeno}.${nidGrupo}', parent_path = '${pathAjeno}', ` +
          `parent_id = '${s.estudio2}' where id = '${grupo}'`,
      ],
      /foreign key|parent_path_fk/i,
    );
  });

  it('y tampoco escondiendo al hijo con deleted_at primero', async () => {
    // 🔴 ESTE es el agujero B: `0016` re-leía los hijos BAJO RLS, así que ocultar al hijo lo hacía
    // desaparecer del control y la mudanza COMMITEABA. La integridad referencial no pasa por la RLS,
    // así que el truco dejó de funcionar.
    const pathAjeno = await campo(s.estudio2, 'path');
    const nidGrupo = await campo(grupo, 'nid');
    await abortaCon(
      duenio,
      [
        `update tenant_node set deleted_at = now() where id = '${clienteDelGrupo}'`,
        `select set_config('app.reparentando','on',true)`,
        `update tenant_node set path = '${pathAjeno}.${nidGrupo}', parent_path = '${pathAjeno}', ` +
          `parent_id = '${s.estudio2}' where id = '${grupo}'`,
      ],
      /foreign key|parent_path_fk/i,
    );
  });
});

describe('R36 / LO LEGÍTIMO — es parte de la regla, no un extra', () => {
  // Un control que sólo prohíbe pasa todos los tests negativos y rompe la operación real. De las
  // cuatro mutaciones que se probaron sobre 0016, DOS se detectaban únicamente por el caso positivo.

  it('el alta de un cliente sigue funcionando', async () => {
    await pasa(duenio, [
      `insert into tenant_node (tipo, nombre, parent_id) values ('cliente','SONDA ALTA SA','${s.estudio}')`,
    ]);
  });

  it('alta y borrado en la MISMA transacción — el falso positivo (b) de 0016', async () => {
    // `0016` abortaba acá: el chequeo diferido llegaba al commit y la fila ya no existía, y trataba
    // «no puedo leerla» como violación. Rompió `0001_aislamiento.test.sql`, que corre en CI.
    await pasa(duenio, [
      `insert into tenant_node (tipo, nombre, parent_id) values ('cliente','SONDA EFIMERA SA','${s.estudio}')`,
      `delete from tenant_node where nombre = 'SONDA EFIMERA SA'`,
    ]);
  });

  it('alta y baja lógica en la MISMA transacción — el falso positivo (c)', async () => {
    await pasa(duenio, [
      `insert into tenant_node (tipo, nombre, parent_id) values ('cliente','SONDA BAJA SA','${s.estudio}')`,
      `update tenant_node set deleted_at = now() where nombre = 'SONDA BAJA SA'`,
    ]);
  });

  it('reparentar_nodo() sigue moviendo un subárbol CON descendientes', async () => {
    await conJob('reparentar_nodo', (tx) =>
      tx.consultar('select app.reparentar_nodo($1, $2)', [grupo, s.estudio2]),
    );

    expect(await incoherentes()).toBe(0);
    expect(await campo(grupo, 'path')).toBe(
      `${await campo(s.estudio2, 'path')}.${await campo(grupo, 'nid')}`,
    );
    // Y el descendiente se movió con él, con su espejo al día.
    expect(await campo(clienteDelGrupo, 'path')).toBe(
      `${await campo(grupo, 'path')}.${await campo(clienteDelGrupo, 'nid')}`,
    );
    expect(await campo(clienteDelGrupo, 'parent_path')).toBe(await campo(grupo, 'path'));
  });
});

describe('R36 / ESTADO — se mide el árbol, no la excepción', () => {
  it('después de todos los ataques, el árbol sigue coherente y clienteA no se movió', async () => {
    // El criterio del incidente #1: una excepción que se lanza y un estado que igual quedó escrito
    // no son lo mismo. Acá se mide lo segundo.
    expect(await incoherentes()).toBe(0);
    expect(await campo(s.clienteA, 'path')).toBe(
      `${await campo(s.estudio, 'path')}.${await campo(s.clienteA, 'nid')}`,
    );
    expect(await campo(s.clienteA, 'path')).not.toContain(await campo(s.estudio2, 'path'));
  });
});
