/**
 * R36 — EL `path` DE `tenant_node` NO SE PUEDE DEJAR INCOHERENTE. Migración 0016, incidente #2.
 *
 * ## Por qué este test EJECUTA EL ATAQUE en vez de mirar el catálogo
 *
 * La tentación es afirmar *"existe el trigger `trg_tenant_node_path_coherente` sobre
 * `tenant_node`"*. Esa regla habría pasado **verde con tres implementaciones rotas distintas**,
 * todas construidas durante el análisis de este incidente:
 *
 *   1. la que valida dentro del `before update of path` (rompe `reparentar_nodo()`, y nadie se
 *      entera hasta la primera mudanza real de un cliente entre estudios),
 *   2. la que valida `NEW` en vez de re-leer la fila (ídem), y
 *   3. 🔴 **la que trata `not found` como "nada que validar"** — que deja pasar el ataque
 *      COMPLETO, porque el atacante **se auto-oculta la fila que acaba de escribir**.
 *
 * Las tres tienen el trigger, con el nombre correcto, enganchado a la tabla correcta.
 * **La regla mide el comportamiento o no mide nada.**
 *
 * Es la lección de R10 en el incidente #1, aplicada antes de cometer el error en vez de después:
 * *una regla verificable que mide lo que es fácil de medir, en vez de lo que hay que garantizar,
 * es peor que no tenerla — porque además da confianza* (ADR-0002 §B.1).
 *
 * ## Y el caso legítimo es parte de la regla, no un extra
 *
 * Un control que sólo prohíbe pasa todos los tests negativos y rompe la operación. El caso 4 es el
 * que mata `not deferrable` y el que mata validar con `NEW` — las dos formas "obvias" del fix.
 *
 * Corre con la MISMA credencial que usa la aplicación (`app_request`, sujeta a RLS), que es lo
 * único que reproduce el escenario: el atacante es un socio, no el dueño del esquema.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { cerrarConexiones, conJob, conUsuario } from '../src/db/conexion.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;
let db: Client;

/** Un `grupo` con un `cliente` adentro, colgando del estudio: el subárbol que se va a mudar. */
let grupo: string;
let clienteDelGrupo: string;

beforeAll(async () => {
  s = await sembrar();
  db = await clienteDuenio();
  const filas = await db.query<{ grupo: string; cli: string }>(
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
  await db?.end();
  await cerrarConexiones();
});

/** Lee con el DUEÑO, sin pasar por RLS: mide el estado real, no lo que el atacante ve. */
async function pathDe(id: string): Promise<string> {
  const r = await db.query<{ path: string }>('select path from tenant_node where id = $1', [id]);
  return r.rows[0]?.path ?? '';
}

async function nidDe(id: string): Promise<string> {
  const r = await db.query<{ nid: string }>('select nid::text as nid from tenant_node where id = $1', [id]);
  return r.rows[0]?.nid ?? '';
}

async function incoherentes(): Promise<number> {
  const r = await db.query<{ n: string }>('select count(*)::text as n from app.verificar_coherencia_path()');
  return Number(r.rows[0]?.n ?? -1);
}

/** Cuántos nodos ve el socio del estudio AJENO. Es la consecuencia, no el mecanismo. */
async function nodosQueVeElAjeno(): Promise<number> {
  return conUsuario(USUARIOS.socioOtroEstudio, async (tx) => {
    const filas = await tx.consultar<{ n: string }>('select count(*)::text as n from tenant_node');
    return Number(filas[0]?.n ?? -1);
  });
}

describe('R36 — el path no se puede dejar incoherente (incidente #2)', () => {
  it('caso 1: el socio NO puede empujar su cliente al subárbol ajeno, ni con app.reparentando prendido', async () => {
    const pathAjeno = await pathDe(s.estudio2);
    const nid = await nidDe(s.clienteA);

    // 🔴 LA mutación que un test de presencia no captura: al escribir este path, la fila sale del
    // subárbol del atacante y `accessible_tenant_ids()` deja de devolverla — el trigger, que es
    // INVOKER, recibe `not found`. Si eso se tratara como no-op, el ataque pasaría igual.
    await expect(
      conUsuario(USUARIOS.socio, async (tx) => {
        await tx.consultar(`select set_config('app.reparentando','on',true)`);
        await tx.consultar('update tenant_node set path = $1 where id = $2', [
          `${pathAjeno}.${nid}`,
          s.clienteA,
        ]);
      }),
    ).rejects.toThrow(/coherencia del path|path incoherente/i);
  });

  it('caso 2: tampoco un path incoherente que le sigue siendo VISIBLE', async () => {
    // Acá la fila no se auto-oculta: sigue colgando del estudio propio. Mata la implementación
    // que confunde "no la veo" con "está bien" — o sea, la simétrica del caso 1.
    const pathPropio = await pathDe(s.estudio);
    await expect(
      conUsuario(USUARIOS.socio, async (tx) => {
        await tx.consultar(`select set_config('app.reparentando','on',true)`);
        await tx.consultar('update tenant_node set path = $1 where id = $2', [
          `${pathPropio}.999999`,
          s.clienteA,
        ]);
      }),
    ).rejects.toThrow(/path incoherente/i);
  });

  it('caso 3: el ataque no dejó rastro — se mide el ESTADO, no la excepción', async () => {
    // El criterio del incidente #1: ahí la verificación forense fue lo que dijo si hubo escalada
    // persistente. Una excepción que se lanza y un estado que igual quedó escrito no son lo mismo.
    expect(await incoherentes()).toBe(0);
    expect(await pathDe(s.clienteA)).toBe(`${await pathDe(s.estudio)}.${await nidDe(s.clienteA)}`);
  });

  it('caso 4: reparentar_nodo() sigue moviendo un subárbol CON descendientes', async () => {
    // EL POSITIVO, y no es decorativo: mata `not deferrable` y mata validar con `NEW`. Las dos
    // formas obvias del fix cierran el agujero rompiendo la mudanza de un cliente entre estudios.
    await conJob('reparentar_nodo', (tx) =>
      tx.consultar('select app.reparentar_nodo($1, $2)', [grupo, s.estudio2]),
    );

    expect(await incoherentes()).toBe(0);
    expect(await pathDe(grupo)).toBe(`${await pathDe(s.estudio2)}.${await nidDe(grupo)}`);
    // Y el descendiente se movió con él: es lo que el chequeo inmediato no podía ver.
    expect(await pathDe(clienteDelGrupo)).toBe(
      `${await pathDe(grupo)}.${await nidDe(clienteDelGrupo)}`,
    );
  });

  it('caso 5: el socio del estudio ajeno no ganó visibilidad por el ataque', async () => {
    // La consecuencia que le importa al negocio, no el mecanismo. Después del caso 4 el ajeno ve
    // MAS nodos, pero porque un job legítimo le mudó un subárbol — nunca por el ataque.
    const ve = await nodosQueVeElAjeno();
    const suSubarbol = await db.query<{ n: string }>(
      `select count(*)::text as n from tenant_node t, tenant_node r
        where r.id = $1 and (t.path = r.path or t.path like r.path || '.%')`,
      [s.estudio2],
    );
    expect(ve).toBe(Number(suSubarbol.rows[0]!.n));
    // Y clienteA, el objetivo del ataque, NO está entre lo que ve.
    expect(await pathDe(s.clienteA)).not.toContain(await pathDe(s.estudio2));
  });
});
