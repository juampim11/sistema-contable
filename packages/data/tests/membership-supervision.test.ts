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
import type { Client } from 'pg';
import { cerrarConexiones, conUsuario } from '../src/db/conexion.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;
let duenio: Client;

/** Un `auditor` y un `admin_plataforma` sobre el estudio: los dos supervisores que el #5 expulsaba. */
const AUDITOR = 'aaaaaaaa-0000-4000-8000-000000000019';
const ADMIN_PLATAFORMA = 'bbbbbbbb-0000-4000-8000-000000000019';
/** Un `contador`: la membresía que un socio SÍ tiene que poder administrar. */
const CONTADOR = 'cccccccc-0000-4000-8000-000000000019';

beforeAll(async () => {
  s = await sembrar();
  duenio = await clienteDuenio();
});

afterAll(async () => {
  await duenio?.end();
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
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar('update membership set activo = true where user_id = $1', [CONTADOR]),
    );
    expect(await activo(CONTADOR)).toBe(true);
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
    const n = await conUsuario(AUDITOR, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from membership_historia',
      );
      return Number(f[0]?.n ?? -1);
    });
    expect(n).toBeGreaterThan(0);
  });
});
