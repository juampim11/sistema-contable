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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
      // El NOMBRE del constraint, no «check constraint» a secas: con la alternativa laxa, el caso
      // pasaba igual cuando el que saltaba era OTRO check. Ver el comentario de `abortaCon`.
      /tenant_node_path_chk/,
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
      /tenant_node_parent_path_fk/,
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

  it('un nodo CON padre no puede darse un path de RAÍZ vaciando su espejo', async () => {
    // 🔴 Éste es EL ataque que `tenant_node_parent_path_nulo_chk` y `match full` existen para frenar:
    // sacar un nodo del subárbol de su propio estudio poniéndole un path sin prefijo. Y hay que
    // escribir path Y parent_path JUNTOS, porque son las dos mitades de la mentira.
    //
    // La versión anterior de este caso escribía sólo `parent_path = null`, y entonces el que saltaba
    // era `tenant_node_path_chk` — no el nulo_chk. MEDIDO en la ronda de mutación: con
    // `tenant_node_parent_path_nulo_chk` DROPEADO los 14 casos quedaban verdes, y con la FK bajada a
    // `match simple` también. Los dos cerrojos de la nulidad parcial no los probaba nada.
    const nid = await campo(s.clienteA, 'nid');
    await abortaCon(
      duenio,
      [
        `select set_config('app.reparentando','on',true)`,
        `update tenant_node set path = '${nid}', parent_path = null where id = '${s.clienteA}'`,
      ],
      /tenant_node_parent_path_nulo_chk/,
    );
  });
});

describe('R36 / HIJOS — mover un padre no puede dejar descendientes colgados', () => {
  // 🔴 Padre e hijo PROPIOS de cada caso, no los globales `grupo`/`clienteDelGrupo`.
  //
  // Estos dos ataques mudan un padre de `s.estudio` a `s.estudio2`. Si el padre YA estuviera bajo
  // `estudio2`, el update sería un no-op que COMMITEA y `abortaCon` daría rojo con el mensaje
  // exactamente equivocado: «la transacción COMMITEÓ: el invariante no se está aplicando». MEDIDO con
  // `--sequence.shuffle.tests --sequence.seed=42`: con el orden barajado, el caso positivo de
  // `reparentar_nodo()` corría primero, movía `grupo`, y estos dos casos caían por eso. La dependencia
  // de orden existía, no estaba declarada, y el síntoma acusaba al invariante en vez de al test.
  let padre: string;
  let hijo: string;

  beforeEach(async () => {
    const r = await duenio.query<{ padre: string; hijo: string }>(
      `with p as (
         insert into tenant_node (tipo, nombre, parent_id) values ('grupo','SONDA HIJOS',$1)
         returning id
       ), h as (
         insert into tenant_node (tipo, nombre, parent_id)
         select 'cliente','SONDA HIJOS HIJO SA', p.id from p returning id, parent_id
       )
       select h.parent_id::text as padre, h.id::text as hijo from h`,
      [s.estudio],
    );
    padre = r.rows[0]!.padre;
    hijo = r.rows[0]!.hijo;
    // El ataque sólo significa algo si el padre arranca colgando del estudio PROPIO.
    expect(await campo(padre, 'parent_path')).toBe(await campo(s.estudio, 'path'));
  });

  it('mudar un padre a un path coherente CONSIGO MISMO, dejando al hijo atrás, aborta por FK', async () => {
    // El padre queda coherente, así que el CHECK fila-local lo acepta. Lo que queda mal es el HIJO,
    // cuyo `parent_path` ya no existe. Es exactamente lo que 0016 no veía.
    const pathAjeno = await campo(s.estudio2, 'path');
    const nidPadre = await campo(padre, 'nid');
    await abortaCon(
      duenio,
      [
        `select set_config('app.reparentando','on',true)`,
        `update tenant_node set path = '${pathAjeno}.${nidPadre}', parent_path = '${pathAjeno}', ` +
          `parent_id = '${s.estudio2}' where id = '${padre}'`,
      ],
      /tenant_node_parent_path_fk/,
    );
  });

  it('y tampoco escondiendo al hijo con deleted_at primero', async () => {
    // 🔴 ESTE es el agujero B: `0016` re-leía los hijos BAJO RLS, así que ocultar al hijo lo hacía
    // desaparecer del control y la mudanza COMMITEABA. La integridad referencial no pasa por la RLS,
    // así que el truco dejó de funcionar.
    const pathAjeno = await campo(s.estudio2, 'path');
    const nidPadre = await campo(padre, 'nid');
    await abortaCon(
      duenio,
      [
        `update tenant_node set deleted_at = now() where id = '${hijo}'`,
        `select set_config('app.reparentando','on',true)`,
        `update tenant_node set path = '${pathAjeno}.${nidPadre}', parent_path = '${pathAjeno}', ` +
          `parent_id = '${s.estudio2}' where id = '${padre}'`,
      ],
      /tenant_node_parent_path_fk/,
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

describe('R36 / FORMA — lo que ningún ataque puede distinguir', () => {
  // Acá SÍ se mira el catálogo, y no contradice a ADR-0002 §B.1: lo que el ADR prohíbe es que R36 se
  // verifique SÓLO inspeccionando el catálogo (eso es lo que dejó a R13 verde con el agujero adentro).
  // Los ataques de arriba miden ALCANZABILIDAD; este bloque congela los atributos declarativos que
  // NINGÚN ataque puede distinguir porque no cambian el resultado de ninguna operación probable.
  //
  // MEDIDO por mutación, todas VERDES sin este bloque: `match full` -> `match simple`; el CHECK y la
  // FK re-creados `not valid`; `idx_tenant_node_parent_path` dropeado.

  it('la FK es la que 0017 declara: match full, deferrable, deferred, no action, validada', async () => {
    const r = await duenio.query<{
      matchtype: string; deferrable: boolean; deferred: boolean;
      validated: boolean; upd: string; del: string;
    }>(
      `select confmatchtype as matchtype, condeferrable as deferrable, condeferred as deferred,
              convalidated as validated, confupdtype as upd, confdeltype as del
         from pg_constraint where conname = 'tenant_node_parent_path_fk'
          and conrelid = 'tenant_node'::regclass`,
    );
    // `f` = MATCH FULL. Con `s` (simple) un parent_path nulo satisface la FK gratis.
    expect(r.rows[0]).toEqual({
      matchtype: 'f', deferrable: true, deferred: true, validated: true, upd: 'a', del: 'a',
    });
  });

  it('los dos CHECK son inmediatos y están validados', async () => {
    const r = await duenio.query<{ conname: string; deferrable: boolean; validated: boolean }>(
      `select conname, condeferrable as deferrable, convalidated as validated
         from pg_constraint
        where conrelid = 'tenant_node'::regclass
          and conname in ('tenant_node_path_chk','tenant_node_parent_path_nulo_chk')
        order by conname`,
    );
    expect(r.rows).toEqual([
      { conname: 'tenant_node_parent_path_nulo_chk', deferrable: false, validated: true },
      { conname: 'tenant_node_path_chk', deferrable: false, validated: true },
    ]);
  });

  it('están el unique que la FK necesita y el índice que cubre la comprobación', async () => {
    const r = await duenio.query<{ n: string }>(
      `select string_agg(indexname, ',' order by indexname) as n from pg_indexes
        where tablename = 'tenant_node'
          and indexname in ('uq_tenant_node_id_path','idx_tenant_node_parent_path')`,
    );
    expect(r.rows[0]?.n).toBe('idx_tenant_node_parent_path,uq_tenant_node_id_path');
  });

  it('nid no lo escribe NADIE, y path/parent_path sólo app_job', async () => {
    const r = await duenio.query<{ col: string; acl: string }>(
      `select attname as col, coalesce(attacl::text, '(sin acl)') as acl
         from pg_attribute where attrelid = 'tenant_node'::regclass
          and attname in ('nid','path','parent_path') order by attname`,
    );
    const acl = Object.fromEntries(r.rows.map((x) => [x.col, x.acl]));
    // `nid` sin ACL de columna = nadie puede escribirla: es lo ÚNICO que cierra el minado del
    // secuencial global, porque cualquier valor de nid es íntegramente válido.
    expect(acl['nid']).toBe('(sin acl)');
    expect(acl['path']).toBe('{app_job=w/sistema_contable}');
    expect(acl['parent_path']).toBe('{app_job=w/sistema_contable}');
  });

  it('ni app_request ni app_job tienen insert/update A NIVEL TABLA', async () => {
    // El escenario de regresión realista: alguien copia la plantilla de ADR-0001 §5 y re-otorga el
    // grant de tabla. `revoke update (col)` sobre un grant de tabla es un NO-OP SILENCIOSO.
    const r = await duenio.query<{ rol: string; tiene: boolean }>(
      `select rol, has_table_privilege(rol, 'tenant_node', 'insert')
              or has_table_privilege(rol, 'tenant_node', 'update') as tiene
         from unnest(array['app_request','app_job']) as rol order by rol`,
    );
    expect(r.rows).toEqual([
      { rol: 'app_job', tiene: false },
      { rol: 'app_request', tiene: false },
    ]);
  });
});

describe('R36 / EL DETECTOR — verificar_coherencia_path() tiene que ver algo', () => {
  it('cuenta EXACTAMENTE la fila que se rompió a propósito, y cero después de repararla', async () => {
    // 🔴 CONTROL DE VACUIDAD DEL CONTROL. `expect(await incoherentes()).toBe(0)` aparece tres veces
    // en este archivo y pasa igual con el detector CIEGO: MEDIDO, reemplazando el cuerpo de la
    // función por `select … where false`, los 14 casos quedaban verdes. Un cero sólo significa algo
    // si el mismo detector sabe devolver uno.
    //
    // Para plantar la incoherencia hay que apagar la FK, y lo único que la apaga es
    // `session_replication_role = replica` — que requiere SUPERUSUARIO. Ver el bloque de arriba: eso
    // NO es una vía de ataque en producción (ADR-0002 exige que el dueño no sea superusuario), es la
    // única forma de fabricar el estado que el detector tiene que detectar.
    expect(await incoherentes()).toBe(0);

    // Padre e hijo PROPIOS de este caso. No se reusan `grupo`/`clienteDelGrupo`: para cuando este
    // bloque corre, el caso positivo ya los movió, el update de abajo sería un no-op y el caso
    // pasaría midiendo cero contra cero. (Pasó al escribirlo: lo delató este mismo `toBe(1)`.)
    const nuevos = await duenio.query<{ padre: string; hijo: string }>(
      `with p as (
         insert into tenant_node (tipo, nombre, parent_id) values ('grupo','SONDA DETECTOR',$1)
         returning id
       ), h as (
         insert into tenant_node (tipo, nombre, parent_id)
         select 'cliente','SONDA DETECTOR HIJO SA', p.id from p returning id, parent_id
       )
       select h.parent_id::text as padre, h.id::text as hijo from h`,
      [s.estudio],
    );
    const padre = nuevos.rows[0]!.padre;
    const hijo = nuevos.rows[0]!.hijo;

    try {
      await duenio.query('begin');
      await duenio.query('set local session_replication_role = replica');
      const r0 = await duenio.query(
        `update tenant_node set path = $1, parent_path = $2, parent_id = $3 where id = $4`,
        [
          `${await campo(s.estudio2, 'path')}.${await campo(padre, 'nid')}`,
          await campo(s.estudio2, 'path'),
          s.estudio2,
          padre,
        ],
      );
      expect(r0.rowCount, 'no se rompió ninguna fila: el caso no probaría nada').toBe(1);
      await duenio.query('commit');
      // El hijo quedó apuntando a un parent_path que ya no existe: UNA fila incoherente, ni más ni menos.
      expect(await incoherentes()).toBe(1);
      const r = await duenio.query<{ id: string }>(
        'select id::text as id from app.verificar_coherencia_path()',
      );
      expect(r.rows[0]?.id).toBe(hijo);
    } finally {
      await duenio.query('rollback').catch(() => undefined);
      await duenio
        .query(`delete from tenant_node where nombre like 'SONDA DETECTOR%'`)
        .catch(() => undefined);
    }
    expect(await incoherentes()).toBe(0);
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
