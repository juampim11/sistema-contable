/**
 * R38 — EL SUJETO DE UN CONTROL NO ESCRIBE EL REGISTRO QUE LO CONSTITUYE.
 * Migración 0019, incidente #5.
 *
 * ## Qué se mide y por qué así
 *
 * `membership` es la tabla que define quién es quién. Antes de `0019`, un `socio` de su propio
 * estudio podía **desactivar y borrar la membresía del `auditor` y la del `admin_plataforma`**, sin
 * restricción de fila y **sin dejar rastro**: la policy gateaba sólo por el nodo, el grant era de
 * tabla entera, y ninguna migración enganchaba auditoría a esa tabla.
 *
 * La lección, que es distinta de la del incidente #4:
 *
 * > **La RLS decide QUIÉN escribe una fila, nunca QUÉ DICE la fila.** Cuando la fila es la que define
 * > quién es quién, esa distinción exacta es la vulnerabilidad.
 *
 * ## Las tres patas, y por qué el test las separa
 *
 * Cerrar una sola dejaba el hallazgo vivo, así que cada bloque de abajo mide una y **ninguna aserción
 * puede pasar por el motivo de otra**:
 *
 *   - **PRIVILEGIO** — el `DELETE` no existe y `rol` no se actualiza. Se mide con `app_request`.
 *   - **POLICY** — el predicado mira el rol de **la fila tocada**. Se mide con un `socio` real, con
 *     el `UPDATE` de `activo` que sí tiene permitido: si sólo midiéramos el privilegio, este bloque
 *     se pondría verde el día que alguien re-otorgue el grant de tabla entera.
 *   - **RASTRO** — lo escribe el **trigger**, no la aplicación, y `hecho_por`/`ocurrido_en` **no se
 *     pueden falsificar** porque nadie tiene grant sobre esas columnas.
 *
 * ## Y el caso legítimo es parte de la regla
 *
 * ADR-0002 **INV-10** exige que revocar una membresía corte el acceso en el request siguiente. El
 * defecto nunca fue que se escriba `activo`: fue **sobre qué fila, con qué grant y sin qué rastro**.
 * Una remediación que rompa INV-10 está mal dirigida, y el bloque LEGÍTIMO existe para detectarlo.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { cerrarConexiones, conJob, conUsuario } from '../src/db/conexion.ts';
import { clienteDuenio, clienteJob, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;
let duenio: Client;
let job: Client;

/** Un `auditor` y un `admin_plataforma` sobre el estudio: los dos supervisores que el #5 expulsaba. */
const AUDITOR = 'aaaaaaaa-0000-4000-8000-000000000019';
const ADMIN_PLATAFORMA = 'bbbbbbbb-0000-4000-8000-000000000019';
/** Un `contador`: la membresía que un socio SÍ tiene que poder administrar. */
const CONTADOR = 'cccccccc-0000-4000-8000-000000000019';

beforeAll(async () => {
  s = await sembrar();
  duenio = await clienteDuenio();
  job = await clienteJob();
});

afterAll(async () => {
  await duenio?.end();
  await job?.end();
  await cerrarConexiones();
});

beforeEach(async () => {
  // Cada caso arranca con las tres membresías puestas y el rastro limpio. Sin esto, un caso que
  // falla deja el padrón tocado y el siguiente mide otra cosa — el acoplamiento que ya se pagó en
  // `path-coherente.test.ts`.
  await duenio.query('delete from membership_historia');
  await duenio.query('delete from membership where user_id = any($1)', [
    [AUDITOR, ADMIN_PLATAFORMA, CONTADOR],
  ]);
  await duenio.query(
    `insert into membership (user_id, tenant_node_id, rol) values
       ($1, $4, 'auditor'), ($2, $4, 'admin_plataforma'), ($3, $4, 'contador')`,
    [AUDITOR, ADMIN_PLATAFORMA, CONTADOR, s.estudio],
  );
  await duenio.query('delete from membership_historia');
});

/** Cuenta filas del rastro para un sujeto. Se lee con el DUEÑO: mide el estado real. */
async function rastro(userId: string): Promise<{ n: number; ops: string }> {
  const r = await duenio.query<{ n: string; ops: string }>(
    `select count(*)::text as n, coalesce(string_agg(operacion, ',' order by ocurrido_en), '') as ops
       from membership_historia where user_id = $1`,
    [userId],
  );
  return { n: Number(r.rows[0]?.n ?? -1), ops: r.rows[0]?.ops ?? '' };
}

/**
 * Cuántas filas del rastro ve ESE usuario, con su propia identidad y bajo RLS. Es lo que distingue
 * "el mecanismo aísla" de "el dueño lo lee todo", y sin este helper los dos casos de AISLAMIENTO no
 * se podrían escribir sin repetir el `conUsuario` cinco veces.
 */
async function veElRastro(userId: string): Promise<number> {
  return conUsuario(userId, async (tx) => {
    const f = await tx.consultar<{ n: string }>(
      'select count(*)::text as n from membership_historia',
    );
    return Number(f[0]?.n ?? -1);
  });
}

async function activo(userId: string): Promise<boolean | null> {
  const r = await duenio.query<{ a: boolean }>(
    'select activo as a from membership where user_id = $1',
    [userId],
  );
  return r.rows[0]?.a ?? null;
}

describe('R38 / PRIVILEGIO — una membresía no se borra, y el rol no se edita', () => {
  it('app_request no puede BORRAR una membresía, ni la de un contador', async () => {
    // Mismo criterio que 0005 con `credencial_fiscal`: «una credencial no se borra, se rota».
    // Una membresía no se borra, se desactiva — y desactivarla ya está previsto por INV-10.
    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        tx.consultar('delete from membership where user_id = $1', [CONTADOR]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('app_request no puede cambiar el ROL de una membresía', async () => {
    // Sin esto, el predicado de la policy sobre `rol` sería esquivable: bastaría con degradar al
    // auditor a `contador` y después tocarlo.
    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        tx.consultar(`update membership set rol = 'contador' where user_id = $1`, [AUDITOR]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('R38 / POLICY — el predicado mira el rol de LA FILA TOCADA', () => {
  it('un socio NO puede desactivar al auditor de su propio estudio', async () => {
    // 🔴 EL ataque del incidente #5. Antes de 0019 esto era `UPDATE 2` y cero rastro.
    // Se mide con el `update` de `activo`, que el socio SÍ tiene permitido: así el caso no puede
    // pasar por el motivo equivocado (un `permission denied` del privilegio).
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [AUDITOR]),
    );
    expect(await activo(AUDITOR), 'el auditor quedó desactivado: la policy no filtró la fila').toBe(
      true,
    );
  });

  it('tampoco al admin_plataforma, que es staff de la plataforma y no del estudio', async () => {
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [ADMIN_PLATAFORMA]),
    );
    expect(await activo(ADMIN_PLATAFORMA)).toBe(true);
  });

  it('ni de un saque: un update masivo no alcanza a los supervisores', async () => {
    // La forma exacta que midió `tester`: `where rol in ('auditor','admin_plataforma')`.
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar(
        `update membership set activo = false where rol in ('auditor','admin_plataforma')`,
      ),
    );
    expect(await activo(AUDITOR)).toBe(true);
    expect(await activo(ADMIN_PLATAFORMA)).toBe(true);
  });

  it('y no puede CREAR una membresía de supervisor para sí mismo', async () => {
    // La mitad aditiva: si pudiera nombrarse auditor, el predicado del resto se vuelve irrelevante.
    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        tx.consultar(
          `insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'auditor')`,
          [USUARIOS.socio, s.estudio],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('R38 / LEGÍTIMO — INV-10 sigue en pie', () => {
  it('un socio SÍ puede desactivar a un contador, y el acceso se corta', async () => {
    // Es el caso positivo, y no es decorativo: una remediación que rompa esto está mal dirigida.
    // ADR-0002 INV-10 exige que revocar una membresía corte el acceso en el request siguiente.
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [CONTADOR]),
    );
    expect(await activo(CONTADOR)).toBe(false);

    const ve = await conUsuario(CONTADOR, async (tx) => {
      const f = await tx.consultar<{ n: string }>('select count(*)::text as n from tenant_node');
      return Number(f[0]?.n ?? -1);
    });
    expect(ve, 'la membresía revocada no cortó el acceso: INV-10 roto').toBe(0);
  });

  it('y volver a activarlo también', async () => {
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [CONTADOR]),
    );
    // 🔴 ESTA ASERCIÓN INTERMEDIA NO ES DECORATIVA. Sin ella el caso pasa POR VACUIDAD: el estado
    // final que afirma (`activo = true`) es el MISMO con el que arranca el `beforeEach`, así que si
    // los dos updates no hacen nada el caso igual sale verde. MEDIDO: con
    // `app.es_rol_supervisor()` devolviendo siempre `true` —o sea, con el socio incapaz de tocar
    // ninguna membresía— este caso era el único del bloque LEGÍTIMO que seguía en verde.
    expect(await activo(CONTADOR), 'la baja no ocurrió: el caso estaba pasando por vacuidad').toBe(
      false,
    );

    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = true where user_id = $1', [CONTADOR]),
    );
    expect(await activo(CONTADOR)).toBe(true);
  });

  it('🔴 el admin_plataforma SÍ puede desactivar al auditor: la cláusula de escape existe', async () => {
    // El positivo que cierra la MITAD DE ARRIBA del predicado. `not es_rol_supervisor(rol) or
    // has_role_on(..., admin_plataforma)` tiene dos mitades y sólo la primera estaba medida:
    // MEDIDO — borrando la cláusula del `admin_plataforma` de las dos ramas de la policy, los 13
    // casos originales seguían en verde. Sin este caso, el día que alguien "simplifique" el
    // predicado nadie se entera de que la baja de un auditor que se fue del estudio dejó de tener
    // camino, y la única salida pasa a ser el dueño del esquema.
    await conUsuario(ADMIN_PLATAFORMA, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [AUDITOR]),
    );
    expect(await activo(AUDITOR), 'ni el admin_plataforma puede administrar a un supervisor').toBe(
      false,
    );
  });
});

describe('R38 / RASTRO — lo escribe el trigger, y no se puede falsificar', () => {
  it('desactivar y reactivar a un contador deja las dos operaciones registradas', async () => {
    expect((await rastro(CONTADOR)).n, 'el rastro no arrancó limpio').toBe(0);

    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [CONTADOR]),
    );
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = true where user_id = $1', [CONTADOR]),
    );

    const r = await rastro(CONTADOR);
    expect(r.n, 'el trigger no registró las escrituras').toBe(2);
    expect(r.ops).toBe('baja,alta');
  });

  it('el alta de una membresía también queda registrada', async () => {
    const nuevo = 'dddddddd-0000-4000-8000-000000000019';
    await duenio.query('delete from membership where user_id = $1', [nuevo]);
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar(
        `insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'contador')`,
        [nuevo, s.estudio],
      ),
    );
    expect((await rastro(nuevo)).ops).toBe('alta');
    await duenio.query('delete from membership where user_id = $1', [nuevo]);
  });

  it('🔴 hecho_por y ocurrido_en NO se pueden falsificar: nadie tiene grant sobre esas columnas', async () => {
    // Es el hallazgo H-B sobre `acceso_auditoria.ocurrido_en`, cerrado por construcción: las dos
    // salen de un DEFAULT y el trigger ni las nombra.
    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        tx.consultar(
          `insert into membership_historia
             (tenant_node_id, membership_id, user_id, rol, operacion, hecho_por, ocurrido_en)
           values ($1, gen_random_uuid(), $2, 'contador', 'alta', $2, '2018-01-01')`,
          [s.estudio, CONTADOR],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('🔴 el rastro es APPEND-ONLY: ni el socio puede borrarlo ni editarlo', async () => {
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [CONTADOR]),
    );
    expect((await rastro(CONTADOR)).n).toBe(1);

    for (const sql of [
      'delete from membership_historia',
      `update membership_historia set operacion = 'alta'`,
    ]) {
      await expect(
        conUsuario(USUARIOS.socio, (tx) => tx.consultar(sql)),
      ).rejects.toThrow(/permission denied/i);
    }
    expect((await rastro(CONTADOR)).n, 'el rastro se pudo borrar').toBe(1);
  });

  it('el auditor puede LEER el rastro de su propio estudio', async () => {
    // Si el supervisor no lo puede leer, el rastro no cumple su función.
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [CONTADOR]),
    );
    // EXACTO y no `toBeGreaterThan(0)`: el rastro arranca limpio en cada caso, hubo UNA escritura, y
    // "alguna fila" no distingue "ve lo suyo" de "ve de más" — que es justo el otro caso de abajo.
    expect(await veElRastro(AUDITOR)).toBe(1);
  });

  it('🔴 hecho_por es el uuid del ESCRITOR, no "alguien"', async () => {
    // MEDIDO: sacándole el `default app.current_user_id()` a la columna —o sea, dejando el rastro
    // anónimo— los 13 casos originales seguían en verde. El rastro registraba «alguien» y ninguna
    // aserción miraba la columna. Un rastro que no dice quién no contesta la pregunta que R38 hace.
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [CONTADOR]),
    );
    const r = await duenio.query<{ hecho_por: string | null }>(
      'select hecho_por::text as hecho_por from membership_historia where user_id = $1',
      [CONTADOR],
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.hecho_por).toBe(USUARIOS.socio);
  });

  it('y el nulo ES información: una escritura de mantenimiento no inventa un autor', async () => {
    // La contracara del caso anterior, y es parte del enunciado de 0019: `hecho_por` es nullable a
    // propósito y el nulo significa "no vino de una sesión con contexto de usuario". Sin este caso,
    // la remediación obvia al caso de arriba —poner la columna `not null` con un relleno— pasaría.
    await conJob('mantenimiento', (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [CONTADOR]),
    );
    const r = await duenio.query<{ hecho_por: string | null }>(
      'select hecho_por::text as hecho_por from membership_historia where user_id = $1',
      [CONTADOR],
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.hecho_por).toBe(null);
  });

  it('🔴 el BORRADO de una membresía queda registrado', async () => {
    // MEDIDO: sacándole el `or delete` al trigger, los 13 casos originales seguían en verde — porque
    // ninguno borraba una membresía. Y no podían: 0019 le sacó el DELETE a app_request Y a app_job,
    // así que el único camino que queda es el DUEÑO DEL ESQUEMA — una migración, un script de
    // mantenimiento. Es justo el escritor contra el que un rastro tiene que seguir funcionando.
    await duenio.query('delete from membership where user_id = $1', [CONTADOR]);
    const r = await rastro(CONTADOR);
    expect(r.n, 'el borrado no dejó rastro').toBe(1);
    expect(r.ops).toBe('borrado');
  });
});

// -----------------------------------------------------------------------------
describe('R38 / AISLAMIENTO — el rastro de derechos no cruza el tenant ni baja de supervisor', () => {
  it('🔴 un socio de OTRO estudio no ve ni una fila del rastro ajeno', async () => {
    // MEDIDO: con `alter table membership_historia disable row level security` los 13 casos
    // originales seguían en verde. El rastro de derechos de todos los estudios quedaba legible por
    // cualquiera con el grant de `select` — y el grant lo tiene app_request entero.
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = false where user_id = $1', [CONTADOR]),
    );
    expect(await veElRastro(USUARIOS.socioOtroEstudio)).toBe(0);
  });

  it('🔴 un contador del MISMO estudio tampoco: leer el rastro es de supervisor', async () => {
    // MEDIDO: sacándole el `has_role_on(...)` a `membership_historia_sel` y dejando sólo el
    // predicado de nodo, los 13 casos originales seguían en verde. Mismo criterio que
    // `acceso_auditoria_sel` (0001:385): el rastro es más restringido que el dato.
    //
    // 🔴 EL ESCENARIO IMPORTA, y esta primera versión del caso lo tuvo mal: el lector no supervisor
    // tiene que tener una membresía ACTIVA y SOBRE EL MISMO NODO en el que cayó la fila del rastro.
    // Midiendo con la membresía que el propio caso acababa de desactivar, el `0` salía por
    // `accessible_tenant_ids()` vacío —o sea, por el aislamiento y no por el rol— y la mutación
    // sobrevivía igual. Por eso acá el rastro lo genera el ALTA de un tercero y el contador queda
    // intacto.
    const nuevo = randomUUID();
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar(
        `insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'contador')`,
        [nuevo, s.estudio],
      ),
    );

    expect(await veElRastro(AUDITOR), 'el supervisor sí lo ve').toBe(1);
    expect(await veElRastro(CONTADOR), 'un contador no es supervisor').toBe(0);

    await duenio.query('delete from membership where user_id = $1', [nuevo]);
  });
});

// -----------------------------------------------------------------------------
describe('R38 / LA CUARTA VÍA — borrar el nodo no es una puerta de atrás a la membresía', () => {
  it('🔴 un socio no puede destruir la membresía de un auditor borrando el tenant_node', async () => {
    // `membership.tenant_node_id` es `on delete cascade`: antes de 0019, borrar un nodo se llevaba
    // sus membresías EN SILENCIO, y `tenant_node_wr` le da el DELETE al socio sobre su subárbol.
    // MEDIDO sin el trigger: `delete from tenant_node` como socio => PERMITIDO, membresía del
    // auditor en 0, rastro vacío. Hoy queda cerrado porque el trigger intenta escribir el rastro
    // contra un nodo que ya no existe (FK) y que ya no ve (policy de insert) — o sea que LA FK Y LA
    // POLICY SON PARTE DEL CONTROL, no plomería. MEDIDO que lo son: soltando las dos, los 13 casos
    // originales seguían en verde y el socio volvía a poder destruir la membresía del auditor.
    // Sin `returning`, y con el uuid puesto desde acá: `accessible_tenant_ids()` es STABLE y todavía
    // no ve el nodo recién insertado en la misma sentencia (está medido en `tenancy-escrituras`).
    const nodo = randomUUID();
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar(
        `insert into tenant_node (id, tipo, nombre, parent_id)
         values ($1, 'cliente', 'CLIENTE SONDA 0019', $2)`,
        [nodo, s.estudio],
      ),
    );
    const VICTIMA = 'ffffffff-0000-4000-8000-000000000019';
    await duenio.query('delete from membership where user_id = $1', [VICTIMA]);
    await duenio.query(
      `insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'auditor')`,
      [VICTIMA, nodo],
    );

    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        tx.consultar('delete from tenant_node where id = $1', [nodo]),
      ),
    ).rejects.toThrow();

    const q = await duenio.query<{ n: string }>(
      'select count(*)::text as n from membership where user_id = $1',
      [VICTIMA],
    );
    expect(
      Number(q.rows[0]?.n ?? -1),
      'la membresía del auditor se destruyó por el cascade del nodo',
    ).toBe(1);

    // La limpieza tiene que borrar PRIMERO el rastro, y eso no es plomería del test: es la
    // consecuencia operativa de 0019 que conviene dejar escrita — mientras exista una fila de
    // `membership_historia` apuntándole, un `tenant_node` NO SE PUEDE BORRAR NI CON EL DUEÑO. El
    // camino de baja de un nodo es el soft-delete (`deleted_at`), y el borrado físico dejó de
    // existir para cualquier nodo que haya tenido alguna vez una membresía.
    await duenio.query('delete from membership where user_id = $1', [VICTIMA]);
    await duenio.query('delete from membership_historia where tenant_node_id = $1', [nodo]);
    await duenio.query('delete from tenant_node where id = $1', [nodo]);
  });
});

// -----------------------------------------------------------------------------
describe('R38 / MECANISMO — lo que el catálogo tiene que decir, lo diga quien lo diga', () => {
  it('🔴 el trigger es AFTER, por fila, y cubre insert, update Y delete', async () => {
    // Un test de comportamiento no distingue AFTER de BEFORE acá (la transacción revierte igual las
    // dos), así que el invariante se mide donde SÍ es observable: el catálogo. Y de paso cierra las
    // tres mutaciones de cobertura del trigger sin depender de que exista un caso por operación.
    // tgtype = ROW(1) | INSERT(4) | DELETE(8) | UPDATE(16) = 29; el bit BEFORE(2) tiene que estar
    // apagado.
    const r = await duenio.query<{ tgname: string; tgtype: number }>(
      `select tgname, tgtype::int as tgtype from pg_trigger
        where tgrelid = 'membership'::regclass and not tgisinternal`,
    );
    expect(r.rows.map((f) => f.tgname)).toEqual(['trg_membership_historia']);
    expect(r.rows[0]?.tgtype, 'AFTER + FOR EACH ROW + insert/update/delete').toBe(29);
  });

  it('🔴 la FK del rastro a tenant_node existe y NO cascadea', async () => {
    // Es la mitad del control que la CUARTA VÍA no alcanza a medir por comportamiento: contra el
    // socio alcanza la policy de insert del rastro, pero contra el DUEÑO —una migración, un script
    // de mantenimiento— lo único que frena el borrado físico del nodo es esta FK. MEDIDO: soltando
    // la FK, el dueño vuelve a poder borrar un nodo con membresías y los 22 casos siguen en verde.
    // Y si alguien la "arregla" a `on delete cascade`, el rastro del borrado se borraría con el
    // nodo, que es exactamente lo contrario de append-only.
    const r = await duenio.query<{ confdeltype: string }>(
      `select confdeltype from pg_constraint
        where conrelid = 'membership_historia'::regclass and contype = 'f'
          and confrelid = 'tenant_node'::regclass`,
    );
    expect(r.rows.length, 'el rastro perdió la FK a tenant_node').toBe(1);
    expect(r.rows[0]?.confdeltype, "'a' = no action; ni cascade ni set null").toBe('a');
  });

  it('🔴 sobre membership, app_request y app_job actualizan SOLO `activo` y ninguno borra', async () => {
    // MEDIDO: re-otorgándole `update, delete on membership` a app_job —que además tiene BYPASSRLS,
    // o sea que la policy de §3 no le aplica— los 13 casos originales seguían en verde. El recorte
    // por columna del §2 sólo estaba medido del lado de app_request.
    const upd = await duenio.query<{ grantee: string; column_name: string }>(
      `select grantee, column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'membership'
          and privilege_type = 'UPDATE' and grantee in ('app_request','app_job')
        order by grantee, column_name`,
    );
    expect(upd.rows).toEqual([
      { grantee: 'app_job', column_name: 'activo' },
      { grantee: 'app_request', column_name: 'activo' },
    ]);

    const del = await duenio.query<{ grantee: string }>(
      `select grantee from information_schema.table_privileges
        where table_schema = 'public' and table_name = 'membership'
          and privilege_type = 'DELETE' and grantee in ('app_request','app_job')`,
    );
    expect(del.rows, 'una membresía no se borra, se desactiva').toEqual([]);
  });
});
