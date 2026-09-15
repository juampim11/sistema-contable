/**
 * `usuario_identidad.activo` — el corte real, no solo el grant.
 *
 * ## Por qué este archivo existe aparte de `mutaciones-0045-usuario-identidad-r44.test.ts`
 *
 * Esa batería prueba R44 (autoría atada a la sesión). Esta prueba una cosa distinta y anterior en la
 * cadena: `0045` extiende `app.accessible_tenant_ids()` y `app.has_role_on()` con
 * `join usuario_identidad u on u.usuario_id = m.user_id and u.activo` — el comentario de la propia
 * migración lo dice explícito: *"usuario_identidad.activo=false vacía el conjunto entero: una
 * identidad desactivada no ve NINGÚN tenant, sin importar cuántas membership tenga"*.
 *
 * Verificado por grep de todo el repo, antes de escribir esto: **nada** ejercitaba ese mecanismo en
 * vivo. `grants-conjunto-cerrado.test.ts` prueba que el GRANT de `UPDATE (activo)` existe para
 * `app_request` — no que apagar la columna corte algo. Una regla que solo se probó por su grant, nunca
 * por su efecto, no cuenta como control (CLAUDE.md §1.8).
 *
 * ## Las tres aserciones, sobre el MISMO usuario, en la MISMA sesión de prueba
 *
 * 1. `accessible_tenant_ids()` pasa de ver el cliente de prueba a devolver CERO filas.
 * 2. `has_role_on()` pasa de `true` a `false` para el mismo nodo/rol que antes autorizaba.
 * 3. Una escritura real que antes funcionaba (`insert` en `confirmacion_grupo`, la misma tabla que ya
 *    usa la batería de R44 para su eje D) falla por RLS después de apagar `activo` — no por otro motivo.
 *
 * UUID fijo, dedicado, que NINGÚN otro archivo de test toca (verificado por grep): evita que apagar
 * `activo` para este usuario afecte a otra suite que corra en paralelo sobre el mismo proceso de vitest.
 *
 * Requisito previo: `0045` aplicada a local.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { clienteDuenio, sembrar, type Sembrado } from './ayuda.ts';

type Fila = Record<string, unknown>;
type Ejecutar = (sql: string, params?: readonly unknown[]) => Promise<Fila[]>;

const desdeTx =
  (tx: Tx): Ejecutar =>
  (sql, params) =>
    tx.consultar<Fila>(sql, params);

function comoUsuario<T>(usuarioId: string, fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(usuarioId, (tx) => fn(desdeTx(tx)));
}

async function una(ej: Ejecutar, sql: string, params?: readonly unknown[]): Promise<Fila> {
  const filas = await ej(sql, params);
  const fila = filas[0];
  if (!fila) throw new Error(`La consulta no devolvió fila: ${sql.slice(0, 80)}`);
  return fila;
}

type ErrorPg = { readonly code: string; readonly message: string };
const SIN_ERROR: ErrorPg = { code: '', message: '(no falló)' };

async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return SIN_ERROR;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? '(sin code)', message: err.message ?? String(e) };
  }
}

/**
 * Rechazo esperado por `app.exigir_nodo_cliente()` (`0001_tenancy.sql:252-263`), no por la policy de
 * `confirmacion_grupo_ins` directamente. Medido en vivo, no asumido: con `activo=false`, el `insert`
 * en `confirmacion_grupo` muere ACÁ primero, con `P0001`, no con `42501`.
 *
 * Por qué es correcto y no un problema del test: ese trigger es deliberadamente SIN `security
 * definer` (comentario propio de la migración: "si la RLS le oculta el nodo, el exists da falso y el
 * INSERT falla. Falla cerrado."). Corre `BEFORE INSERT`, con los privilegios del USUARIO que inserta
 * -- así que hereda exactamente la misma vista de `tenant_node` filtrada por
 * `accessible_tenant_ids()` que ya midieron las dos aserciones de arriba. Con `activo=false` esa vista
 * está vacía, el `exists` da falso, y el trigger dispara antes de que la policy de
 * `confirmacion_grupo_ins` llegue siquiera a evaluarse. Es el MISMO corte de acceso que las otras dos
 * aserciones, por una puerta distinta y anterior -- no una tercera cosa sin relación.
 */
function esperarRechazoPorNodoInvisible(actual: ErrorPg, porque: string): void {
  expect(actual.code, porque).toBe('P0001');
  expect(
    actual.message,
    `${porque} — y el mensaje tiene que ser el de exigir_nodo_cliente(): "${actual.message}"`,
  ).toMatch(/no es un nodo activo de tipo cliente/);
}

let s: Sembrado;
const BANCO = 'banco_0045_activo';
/** UUID fijo y dedicado a este archivo — verificado por grep que ningún otro test lo usa. */
const USUARIO_TOGGLE = 'dddddddd-0000-4000-8000-000000000045';
/**
 * Dos cuentas, creadas con el dueño del esquema (bypassea RLS) ANTES de tocar `activo` -- para que la
 * escritura que cada `it()` mide sea EXCLUSIVAMENTE el `insert` en `confirmacion_grupo`, nunca el
 * `insert` de la cuenta que lo referencia. Si `crearCuenta()` corriera como `USUARIO_TOGGLE` dentro de
 * cada test, con `activo=false` no se podría distinguir "murió el insert de cuenta" de "murió el
 * insert de confirmacion_grupo" -- las dos fallarían igual por RLS, pero solo la segunda es lo que
 * este archivo dice medir.
 */
let cuentaBaseId: string;
let cuentaAtaqueId: string;

beforeAll(async () => {
  if (entornoActual() !== 'local') {
    throw new Error(`Esta prueba corre SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  s = await sembrar();
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ($1, 'BANCO DE PRUEBA 0045 ACTIVO') on conflict do nothing`,
      [BANCO],
    );
    // Membresía real de `socio` sobre el cliente de prueba -- mismo rol que ya usa el eje D
    // (`confirmacion_grupo_ins`) de la batería de R44, para que la escritura de la aserción 3 sea
    // idéntica a un caso ya cerrado y no una construcción ad-hoc.
    await duenio.query(
      `insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'socio'::app.rol_membership)
       on conflict do nothing`,
      [USUARIO_TOGGLE, s.clienteA],
    );
    // Arranca ACTIVO: la aserción de la línea de base (todavía ve/puede escribir) necesita esto antes
    // de apagarlo.
    await duenio.query(
      `insert into usuario_identidad (usuario_id, proveedor, sujeto_externo, activo)
       values ($1::uuid, 'dev-identidad-fija', $2, true)
       on conflict (proveedor, sujeto_externo) do update set activo = true`,
      [USUARIO_TOGGLE, USUARIO_TOGGLE],
    );

    const cBase = await duenio.query<{ id: string }>(
      `insert into cuenta (cliente_id) values ($1) returning id::text as id`,
      [s.clienteA],
    );
    cuentaBaseId = String(cBase.rows[0]?.id);
    const cAtaque = await duenio.query<{ id: string }>(
      `insert into cuenta (cliente_id) values ($1) returning id::text as id`,
      [s.clienteA],
    );
    cuentaAtaqueId = String(cAtaque.rows[0]?.id);
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

async function ponerActivo(valor: boolean): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(`update usuario_identidad set activo = $2 where usuario_id = $1`, [
      USUARIO_TOGGLE,
      valor,
    ]);
  } finally {
    await duenio.end();
  }
}

/**
 * PREDICCIÓN FALSABLE, antes de correr:
 *
 *   1. Con `activo=true`: `accessible_tenant_ids()` incluye `s.clienteA`, `has_role_on(s.clienteA,
 *      ['socio'])` da `true`, y un `insert` real en `confirmacion_grupo` funciona.
 *   2. Con `activo=false` (MISMO usuario, MISMA membresía, sin tocar nada más): `accessible_tenant_ids()`
 *      da CERO filas, `has_role_on()` da `false`, y el MISMO `insert` que antes funcionaba muere --
 *      nunca por falta de membresía (que sigue intacta) ni por falta de grant (ya demostrado presente
 *      en el paso 1). Medido en vivo, no asumido: el rechazo real es `P0001` de
 *      `app.exigir_nodo_cliente()` (`cliente_id` deja de ser visible antes de llegar a evaluar la
 *      policy de `confirmacion_grupo_ins`), no `42501` de esa policy directamente -- ver el comentario
 *      de `esperarRechazoPorNodoInvisible()`. Mismo corte de fondo, puerta distinta.
 *   3. Si el paso 2 siguiera viendo el tenant o pudiendo escribir, el `join ... and u.activo` de `0045`
 *      no está cortando nada -- el hallazgo sería real, no un detalle de test.
 */
describe('0045 — usuario_identidad.activo corta accessible_tenant_ids/has_role_on/escritura real', () => {
  it('activo=true: ve el tenant, tiene el rol, y puede escribir', async () => {
    await ponerActivo(true);

    const tenants = await comoUsuario(USUARIO_TOGGLE, (ej) =>
      ej('select id::text as id from app.accessible_tenant_ids() as id'),
    );
    expect(
      tenants.map((f) => f['id']),
      'con activo=true, accessible_tenant_ids() tiene que incluir el cliente de prueba',
    ).toContain(s.clienteA);

    const rol = await comoUsuario(USUARIO_TOGGLE, (ej) =>
      una(ej, `select app.has_role_on($1, array['socio']::app.rol_membership[]) as "tieneRol"`, [s.clienteA]),
    );
    expect(rol['tieneRol'], 'con activo=true, has_role_on() tiene que dar true').toBe(true);

    const escritura = await capturar(() =>
      comoUsuario(USUARIO_TOGGLE, (ej) =>
        ej(
          `insert into confirmacion_grupo (cliente_id, banco_codigo, concepto_banco, cuenta_id, respaldo, confirmado_por)
           values ($1, $2, 'concepto activo-toggle base', $3, 'respaldo de prueba valido', $4)`,
          [s.clienteA, BANCO, cuentaBaseId, USUARIO_TOGGLE],
        ),
      ),
    );
    expect(escritura, 'con activo=true, el insert real tiene que funcionar sin error').toEqual(SIN_ERROR);
  });

  it('activo=false: el MISMO usuario, la MISMA membresía, deja de ver el tenant, pierde el rol, y la escritura muere (nodo invisible, misma raíz)', async () => {
    await ponerActivo(false);

    const tenants = await comoUsuario(USUARIO_TOGGLE, (ej) =>
      ej('select id::text as id from app.accessible_tenant_ids() as id'),
    );
    expect(
      tenants,
      'con activo=false, accessible_tenant_ids() tiene que devolver CERO filas -- la membership sigue activa, la identidad no',
    ).toHaveLength(0);

    const rol = await comoUsuario(USUARIO_TOGGLE, (ej) =>
      una(ej, `select app.has_role_on($1, array['socio']::app.rol_membership[]) as "tieneRol"`, [s.clienteA]),
    );
    expect(rol['tieneRol'], 'con activo=false, has_role_on() tiene que dar false').toBe(false);

    const error = await capturar(() =>
      comoUsuario(USUARIO_TOGGLE, (ej) =>
        ej(
          `insert into confirmacion_grupo (cliente_id, banco_codigo, concepto_banco, cuenta_id, respaldo, confirmado_por)
           values ($1, $2, 'concepto activo-toggle ataque', $3, 'respaldo de prueba valido', $4)`,
          [s.clienteA, BANCO, cuentaAtaqueId, USUARIO_TOGGLE],
        ),
      ),
    );
    esperarRechazoPorNodoInvisible(
      error,
      'con activo=false el insert que antes funcionaba tiene que morir -- misma membresía, mismo ' +
        'grant, la única diferencia es la identidad desactivada',
    );
  });
});
