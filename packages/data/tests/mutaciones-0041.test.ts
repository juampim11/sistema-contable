/**
 * MUTACIONES de `0041_manifestacion_vigente_al_citar.sql` — prueba por mutación del invariante
 * NUEVO de esta migración (CLAUDE.md §1.8, ADR-0002 §B.0): una `reconocimiento_contrapartida` no
 * puede citar una `padron_manifestacion` ya revocada como si estuviera vigente.
 *
 *   L1 legítimo, SECUENCIAL: cita X vigente (entra) → revoca X con Y (entra) → un tercer insert
 *      citando X muere P0004 ................................................ 0 mutaciones, 1 legítimo
 *   M1 🔴 mutación EN VIVO, dos conexiones reales: la función SIN NINGÚN LOCK (mismo `pg_sleep`
 *      inyectado que L2) dice "no revocada" con la foto vieja y la carrera se cuela ... 1 mutación
 *   M2 🔴 mutación EN VIVO, dos conexiones reales: la función con `FOR SHARE` en vez de
 *      `FOR UPDATE` (mismo `pg_sleep`) — la carrera se cuela IGUAL, porque `FOR SHARE` no
 *      conflictúa con el `FOR KEY SHARE` que toma la FK del lado que revoca ............ 1 mutación
 *   L2 el mecanismo REAL de `0041` (`FOR UPDATE`, mismo `pg_sleep` en el mismo punto que M1/M2):
 *      la carrera NO se cuela ................................................. 0 mutaciones, 1 legítimo
 *                                                                              ─────────────────────
 *                                                                              2 mutaciones, 2 legítimos, 4 `it`
 *
 * ## Por qué L1 corre contra el archivo de la migración TAL CUAL quedó aplicado
 *
 * L1 y L2 corren contra `app.exigir_manifestacion_vigente()` como quedó en
 * `0041_manifestacion_vigente_al_citar.sql` — nunca contra un borrador aparte. M1 y M2 aplican
 * (autocommit, sin `BEGIN`) una VARIANTE MUTADA de esa misma función SOLO por la duración de su
 * `it`, y la restauran a la definición REAL en un `finally` — exactamente el patrón de
 * `FUNCION_VULNERABLE_CON_SLEEP` / `FUNCION_REAL` de `mutaciones-0040.test.ts` bloque E, con el
 * mismo motivo: una carrera entre dos conexiones necesita que la mutación sea VISIBLE para AMBAS,
 * y un `create or replace function` dentro de una transacción que después se rollbackea nunca
 * sale de esa transacción.
 *
 * ## Por qué el `pg_sleep` va en el mismo punto en las tres variantes (M1, M2, L2)
 *
 * Sin él, la carrera es posible pero no reproducible de forma confiable en un test — depende del
 * timing de red entre dos conexiones reales. El punto elegido —después de leer `v_revocada`, antes
 * de decidir— es el mismo que usa `mutaciones-0040.test.ts` bloque E, y es el que hace que la
 * comparación entre M1/M2 y L2 mida EXACTAMENTE la misma ventana bajo tres locks distintos (ninguno,
 * `FOR SHARE`, `FOR UPDATE`) — no tres experimentos distintos con tres ventanas distintas.
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, con `0041` APLICADA.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

// -----------------------------------------------------------------------------
// Andamio mínimo — mismo estilo que `caracterizacion-manifestacion-revocada-citable.test.ts`,
// duplicado a propósito (ese archivo no exporta sus helpers, y éste existe para no compartir
// conteo de mutaciones con ningún otro).
// -----------------------------------------------------------------------------

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

type ErrorPg = { readonly code: string; readonly message: string };
async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return { code: '', message: '(no falló)' };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? '', message: err.message ?? '' };
  }
}

function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** true = la promesa ya resolvió/rechazó dentro de `ms`; false = sigue pendiente (bloqueada). */
async function sigueBloqueada(promesa: Promise<unknown>, ms: number): Promise<boolean> {
  const centinela = Symbol('pendiente');
  const resultado = await Promise.race([promesa.catch(() => centinela), esperar(ms).then(() => centinela)]);
  return resultado === centinela;
}

const BANCO = 'banco_mut_0041';

let s: Sembrado;
let filaSeq = 0;
let cuenta = { clienteId: '', cuentaId: '', loteId: '' };

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ($1, 'BANCO MUT 0041', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const c = await una(
      ej,
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
       values ($1, $2, 'ARS', 'MUT 0041') returning id::text as id`,
      [s.clienteA, BANCO],
    );
    const lote = await una(
      ej,
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
       values ($1, $2, 'prueba-mut-0041', 'archivo', $3, 'recibido', 0)
       returning id::text as id`,
      [s.clienteA, BANCO, `hash_mut_0041_${randomUUID()}`],
    );
    await ej(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
          verificacion_estado)
       values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
      [s.clienteA, String(lote['id']), String(c['id'])],
    );
    cuenta = { clienteId: s.clienteA, cuentaId: String(c['id']), loteId: String(lote['id']) };
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Padre mínimo válido: movimiento + reconocimiento clase `propuesta` — la única clase que admite
 *  `es_tercero_padron_completo` vía `contrapartida_promocion_chk` (0021 §4). */
async function crearPadrePropuesta(ej: Ejecutar): Promise<{ readonly reconocimientoId: string }> {
  filaSeq += 1;
  const mov = await una(
    ej,
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, saldo, concepto_banco, concepto_completo, concepto_banco_estrategia, concepto_codigo,
        contraparte_captura)
     values ($1, $2, $3, $4, $5, '2026-06-15'::date, 'GLOSA MUT 0041', '-100.00'::numeric, 900.00,
             'CONCEPTO', true, 'columna_propia', null, 'capturado')
     returning id::text as id, entrada_digest`,
    [cuenta.clienteId, cuenta.loteId, cuenta.cuentaId, filaSeq, randomUUID()],
  );

  const recon = await una(
    ej,
    `insert into reconocimiento_movimiento
       (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
        lado, via, que_decide, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados,
        evidencia_hubo_cola)
     values ($1, $2, $3, $4, 'propuesta', 'comision_bancaria', 'comision_de_transferencia', 'normal',
             'debe', 'texto_literal_exacto', null, 'galicia.comision_de_transferencia', 12, false)
     returning id::text as id`,
    [cuenta.clienteId, String(mov['id']), filaSeq.toString(16).padStart(16, '0'), String(mov['entrada_digest'])],
  );
  return { reconocimientoId: String(recon['id']) };
}

async function crearManifestacion(ej: Ejecutar, revocaA: string | null = null): Promise<string> {
  const f = revocaA
    ? await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta, revoca_a)
         values ($1, '2026-09-30'::date, $2) returning id::text as id`,
        [cuenta.clienteId, revocaA],
      )
    : await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta)
         values ($1, '2026-06-30'::date) returning id::text as id`,
        [cuenta.clienteId],
      );
  return String(f['id']);
}

/** Cita `manifestacionId` desde una `reconocimiento_contrapartida` nueva (padre nuevo cada vez:
 *  `uq_recon_contrapartida_reconocimiento` es 1:0..1 y no admite dos citas del mismo padre). */
async function citarManifestacion(ej: Ejecutar, manifestacionId: string): Promise<string> {
  const padre = await crearPadrePropuesta(ej);
  const f = await una(
    ej,
    `insert into reconocimiento_contrapartida
       (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase,
        padron_manifestacion_id, padron_completo_hasta, resuelto_a_fecha, patron_contraparte_estado)
     values ($1, $2, 'es_tercero_padron_completo', 'propuesta', $3, '2026-06-30'::date,
             '2026-06-15'::date, 'no_aplica')
     returning id::text as id`,
    [cuenta.clienteId, padre.reconocimientoId, manifestacionId],
  );
  return String(f['id']);
}

// =============================================================================
// L1 — legítimo, SECUENCIAL, contra la migración TAL CUAL quedó aplicada (0 mutaciones, 1 legítimo)
// =============================================================================
describe('0041 L1 — secuencial: citar vigente entra, revocar entra, citar la ya-revocada muere P0004', () => {
  it('L1 cita X vigente (entra) → revoca X con Y (entra) → un tercer insert citando X muere P0004', async () => {
    const manX = await comoSocio((ej) => crearManifestacion(ej));

    // Cita 1: X está vigente todavía — tiene que entrar.
    const cita1 = await comoSocio((ej) => citarManifestacion(ej, manX));
    expect(cita1, 'citar una manifestación VIGENTE tiene que entrar').toBeTruthy();

    // Revoca X con una manifestación nueva Y — tiene que entrar (padron_manifestacion no cambia
    // de invariante acá, sigue append-only y sin UPDATE/DELETE).
    const manY = await comoSocio((ej) => crearManifestacion(ej, manX));
    expect(manY, 'revocar X (insertar Y con revoca_a = X) tiene que entrar').toBeTruthy();

    // Un TERCER insert, con un padre nuevo, cita a X otra vez — X ya está revocada por Y.
    const error = await capturar(() => comoSocio((ej) => citarManifestacion(ej, manX)));
    expect(error.code, 'citar X después de que Y la revocó tiene que morir por P0004').toBe('P0004');
  });
});

// =============================================================================
// M1/M2/L2 — LA CARRERA, EN VIVO con dos conexiones reales (2 mutaciones, 1 legítimo)
// =============================================================================
//
// Transacción A: cita `X` (INSERT en reconocimiento_contrapartida, dispara el trigger).
// Transacción B: revoca `X` (INSERT en padron_manifestacion con revoca_a = X) MIENTRAS A duerme.
//
// Las tres variantes de la función comparten la MISMA estructura y el MISMO punto de `pg_sleep` —
// sólo cambia el lock que toma el `perform` inicial. La real (con `for update`, sin sleep) es la
// que quedó en el archivo de la migración; estas tres son variantes CON SLEEP inyectado sólo para
// hacer determinística la ventana de carrera en el test — mismo patrón que
// `mutaciones-0040.test.ts` bloque E (`FUNCION_VULNERABLE_CON_SLEEP` / `FUNCION_REAL_CON_SLEEP`).
const GUARD = `
  if new.padron_manifestacion_id is null then
    return new;
  end if;

  if not (
    new.cliente_id in (select app.accessible_tenant_ids())
    and app.has_role_on(new.cliente_id, array['socio','contador','administrativo']::app.rol_membership[])
  ) then
    return new;
  end if;
`;

const FUNCION_REAL = `
create or replace function app.exigir_manifestacion_vigente() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_revocada boolean;
begin
  ${GUARD}
  perform 1
    from public.padron_manifestacion
   where cliente_id = new.cliente_id
     and id = new.padron_manifestacion_id
     for update;

  select exists (
    select 1 from public.padron_manifestacion
     where cliente_id = new.cliente_id
       and revoca_a = new.padron_manifestacion_id
  ) into v_revocada;

  if v_revocada then
    raise exception
      'padron_manifestacion_id % ya fue revocada: no se puede citar como vigente',
      new.padron_manifestacion_id
      using errcode = 'P0004';
  end if;

  return new;
end;
$$;
`;

/** M1: SIN NINGÚN LOCK — la mutación exacta que dba-data identificó en el diseño original. */
const FUNCION_SIN_LOCK_CON_SLEEP = `
create or replace function app.exigir_manifestacion_vigente() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_revocada boolean;
begin
  ${GUARD}
  -- 🔴 SIN "for update" NI NINGÚN OTRO LOCK. Lee, y decide después de dormir sobre esa lectura.
  select exists (
    select 1 from public.padron_manifestacion
     where cliente_id = new.cliente_id
       and revoca_a = new.padron_manifestacion_id
  ) into v_revocada;

  -- Sleep INYECTADO sólo para este test: fuerza el entrelazado determinístico (sin esto, la
  -- carrera es posible pero no reproducible de forma confiable — depende de timing de red).
  perform pg_sleep(1);

  if v_revocada then
    raise exception 'padron_manifestacion_id % ya fue revocada: no se puede citar como vigente',
      new.padron_manifestacion_id using errcode = 'P0004';
  end if;

  return new;
end;
$$;
`;

/** M2: `FOR SHARE` en vez de `FOR UPDATE` — SÍ toma un lock, pero el equivocado: `FOR SHARE` no
 *  conflictúa con el `FOR KEY SHARE` que toma automáticamente la FK del lado que revoca. */
const FUNCION_FOR_SHARE_CON_SLEEP = `
create or replace function app.exigir_manifestacion_vigente() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_revocada boolean;
begin
  ${GUARD}
  -- 🔴 "for share" en vez de "for update" — la mutación específica que M2 existe para refutar.
  perform 1
    from public.padron_manifestacion
   where cliente_id = new.cliente_id
     and id = new.padron_manifestacion_id
     for share;

  select exists (
    select 1 from public.padron_manifestacion
     where cliente_id = new.cliente_id
       and revoca_a = new.padron_manifestacion_id
  ) into v_revocada;

  perform pg_sleep(1);

  if v_revocada then
    raise exception 'padron_manifestacion_id % ya fue revocada: no se puede citar como vigente',
      new.padron_manifestacion_id using errcode = 'P0004';
  end if;

  return new;
end;
$$;
`;

/** L2: el mecanismo REAL (`for update`), con el MISMO `pg_sleep` en el MISMO punto relativo que
 *  M1/M2 — para que la comparación sea "mismo experimento, distinto lock", no tres experimentos
 *  distintos. */
const FUNCION_REAL_CON_SLEEP = `
create or replace function app.exigir_manifestacion_vigente() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_revocada boolean;
begin
  ${GUARD}
  perform 1
    from public.padron_manifestacion
   where cliente_id = new.cliente_id
     and id = new.padron_manifestacion_id
     for update;

  select exists (
    select 1 from public.padron_manifestacion
     where cliente_id = new.cliente_id
       and revoca_a = new.padron_manifestacion_id
  ) into v_revocada;

  perform pg_sleep(1);

  if v_revocada then
    raise exception 'padron_manifestacion_id % ya fue revocada: no se puede citar como vigente',
      new.padron_manifestacion_id using errcode = 'P0004';
  end if;

  return new;
end;
$$;
`;

async function conFuncionCommitteada<T>(ddlMutante: string, fn: () => Promise<T>): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de carrera corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  const duenio = await clienteDuenio();
  try {
    await duenio.query(ddlMutante); // autocommit — sin BEGIN, el CREATE OR REPLACE se commitea solo
  } finally {
    await duenio.end();
  }
  try {
    return await fn();
  } finally {
    const restaurador = await clienteDuenio();
    try {
      await restaurador.query(FUNCION_REAL);
    } finally {
      await restaurador.end();
    }
  }
}

/**
 * Corre el entrelazado A-cita/B-revoca con la función (ya instalada, con sleep) que corresponda, y
 * devuelve si la contrapartida de A quedó insertada Y si B logró revocar.
 */
async function correrCarrera(): Promise<{ readonly citoA: boolean; readonly revocoB: boolean; readonly bloqueadaB: boolean }> {
  const manX = await comoSocio((ej) => crearManifestacion(ej));
  const padre = await comoSocio((ej) => crearPadrePropuesta(ej));

  const clienteA = await clienteDuenio();
  const clienteB = await clienteDuenio();
  try {
    await clienteA.query('begin');
    await clienteA.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);

    // Dispara el INSERT de A: entra al trigger, toma (o no) el lock, lee v_revocada, y se duerme 1s
    // ANTES de decidir. No se espera todavía — el resto de este bloque corre MIENTRAS A duerme.
    const insertA = clienteA.query(
      `insert into reconocimiento_contrapartida
         (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase,
          padron_manifestacion_id, padron_completo_hasta, resuelto_a_fecha, patron_contraparte_estado)
       values ($1, $2, 'es_tercero_padron_completo', 'propuesta', $3, '2026-06-30'::date,
               '2026-06-15'::date, 'no_aplica')`,
      [cuenta.clienteId, padre.reconocimientoId, manX],
    );

    await esperar(300); // deja que A entre al pg_sleep (ya leyó v_revocada antes de dormir)

    await clienteB.query('begin');
    await clienteB.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);
    const revocarB = clienteB.query(
      `insert into padron_manifestacion (cliente_id, completo_hasta, revoca_a)
       values ($1, '2026-09-30'::date, $2)`,
      [cuenta.clienteId, manX],
    );

    const bloqueadaB = await sigueBloqueada(revocarB, 500);

    if (bloqueadaB) {
      // B está esperando el lock de A — dejar que A termine primero.
      await insertA;
      await clienteA.query('commit');
      await revocarB;
      await clienteB.query('commit');
    } else {
      // B ya commiteó (o está a punto de) sin haber esperado nada — cerrar los dos en el mismo
      // orden en que terminaron.
      await revocarB;
      await clienteB.query('commit');
      const citoA = await capturar(() => insertA.then(() => clienteA.query('commit')));
      if (citoA.code) {
        return { citoA: false, revocoB: true, bloqueadaB };
      }
    }

    return { citoA: true, revocoB: true, bloqueadaB };
  } finally {
    await clienteA.end().catch(() => {});
    await clienteB.end().catch(() => {});
  }
}

describe('0041 M1/M2/L2 — 🔴 la carrera TOCTOU, en vivo con dos conexiones reales', () => {
  it(
    'M1 🔴 EN VIVO, SIN NINGÚN LOCK: A lee "no revocada", duerme, B revoca y commitea DURANTE el ' +
      'sleep de A, y A cita a X igual — la carrera se cuela',
    async () => {
      const resultado = await conFuncionCommitteada(FUNCION_SIN_LOCK_CON_SLEEP, correrCarrera);
      expect(resultado.bloqueadaB, 'sin ningún lock, B no debería haber quedado bloqueado un solo instante').toBe(false);
      expect(
        resultado.citoA && resultado.revocoB,
        'LA CARRERA SE COLÓ: A citó a X como vigente Y B logró revocar X — sin lock, las dos cosas pasan',
      ).toBe(true);
    },
    10_000,
  );

  it(
    'M2 🔴 EN VIVO, FOR SHARE en vez de FOR UPDATE: el lock existe pero es el equivocado — no ' +
      'conflictúa con el FOR KEY SHARE de la FK que revoca, y la carrera se cuela IGUAL que sin lock',
    async () => {
      const resultado = await conFuncionCommitteada(FUNCION_FOR_SHARE_CON_SLEEP, correrCarrera);
      expect(
        resultado.bloqueadaB,
        'FOR SHARE no debería bloquear al INSERT que revoca (FOR KEY SHARE no conflictúa con FOR SHARE)',
      ).toBe(false);
      expect(
        resultado.citoA && resultado.revocoB,
        'LA CARRERA SE COLÓ incluso CON FOR SHARE: hace falta específicamente FOR UPDATE, no "algún lock"',
      ).toBe(true);
    },
    10_000,
  );

  it(
    'L2 el mecanismo REAL (FOR UPDATE), mismo pg_sleep en el mismo punto: B queda BLOQUEADO hasta ' +
      'que A termina, y el resultado final es consistente — la carrera NO se cuela',
    async () => {
      const resultado = await conFuncionCommitteada(FUNCION_REAL_CON_SLEEP, correrCarrera);
      expect(
        resultado.bloqueadaB,
        'FOR UPDATE tiene que bloquear al INSERT que revoca (conflictúa con su FOR KEY SHARE implícito)',
      ).toBe(true);
      // Con FOR UPDATE, B queda bloqueado hasta que A termina: A cita a X (todavía vigente en ese
      // instante) y commitea: LUEGO B revoca. Cronología consistente — nunca la corrupción de M1/M2.
      expect(resultado.citoA, 'A tiene que poder citar a X: en el momento en que decidió, X seguía vigente').toBe(true);
      expect(resultado.revocoB, 'B tiene que poder revocar X DESPUÉS de que A liberó el lock').toBe(true);
    },
    10_000,
  );
});
