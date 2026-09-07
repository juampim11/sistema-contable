/**
 * MUTACIONES de `0040_reproceso_capa_d.sql` — prueba por mutación de los invariantes NUEVOS de esta
 * migración (CLAUDE.md §1.8, ADR-0002 §B.0), sobre el mecanismo de reproceso de Capa D con
 * supersesión (Mitad 1, convocatoria completa 2026-09-07).
 *
 *   A. Trigger `exigir_cierre_no_terminal_al_insertar_asiento` — el gap de fk_asiento_propuesto_cierre
 *      que security-engineer encontró: nada verificaba cierre_estado ................. 1 mutación, 2 legítimos
 *   B. `asiento_propuesto_corrige_no_self_chk` — anti-autorreferencia (Caso B) ........ 1 mutación, 1 legítimo
 *   C. `asiento_propuesto_reproceso_distinto_chk` — anti-autorreferencia (reproceso) .. 1 mutación, 1 legítimo
 *   D. `asiento_propuesto_reproceso_regla_chk` — coherencia motivo↔regla_imputacion ... 1 mutación, 2 legítimos
 *   E. 🔴 LA CARRERA TOCTOU (dba-data + security-engineer, hallazgo independiente y
 *      convergente de los dos): sin `for share`, un INSERT concurrente y una
 *      confirmación de cierre concurrente pueden entrelazarse bajo READ COMMITTED y
 *      dejar un asiento insertado en un cierre que terminó confirmado — EN VIVO, con
 *      dos conexiones reales orquestadas, no simulado .......................... 1 mutación, 1 legítimo
 *                                                                              ─────────────────────
 *                                                                              5 mutaciones, 7 legítimos
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, con `0040` APLICADA.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

type Fila = Record<string, unknown>;
type Ejecutar = (sql: string, params?: readonly unknown[]) => Promise<Fila[]>;

const desdeTx =
  (tx: Tx): Ejecutar =>
  (sql, params) =>
    tx.consultar<Fila>(sql, params);
const desdeCliente =
  (c: Client): Ejecutar =>
  async (sql, params) =>
    (await c.query<Fila>(sql, (params ?? []) as unknown[])).rows;

async function una(ej: Ejecutar, sql: string, params?: readonly unknown[]): Promise<Fila> {
  const filas = await ej(sql, params);
  const fila = filas[0];
  if (!fila) throw new Error(`La consulta no devolvió fila: ${sql.slice(0, 80)}`);
  return fila;
}

type ErrorPg = { readonly code: string; readonly constraint: string | null; readonly message: string };
const SIN_ERROR: ErrorPg = { code: '', constraint: null, message: '(no falló)' };

async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return SIN_ERROR;
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string };
    return { code: err.code ?? '', constraint: err.constraint ?? null, message: err.message ?? '' };
  }
}

function esperarRechazo(actual: ErrorPg, code: string, constraint: string, porque: string): void {
  expect({ code: actual.code, constraint: actual.constraint }, porque).toEqual({ code, constraint });
}

function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

// -----------------------------------------------------------------------------
// El laboratorio de mutación de DDL con ROLLBACK — para A-D: transacción del dueño, SIEMPRE
// rollbackeada, mismo mecanismo que mutaciones-0038/-0039.test.ts.
// -----------------------------------------------------------------------------
async function conDuenio<T>(fn: (ej: Ejecutar, crudo: (sql: string, params?: readonly unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de mutación de DDL corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  const duenio = await clienteDuenio();
  const ej = desdeCliente(duenio);
  const crudo = (sql: string, params?: readonly unknown[]): Promise<unknown> => duenio.query(sql, params as unknown[]);
  try {
    await duenio.query('begin');
    await duenio.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);
    return await fn(ej, crudo);
  } finally {
    try {
      await duenio.query('rollback');
    } finally {
      await duenio.end();
    }
  }
}

async function definicionDe(ej: Ejecutar, constraint: string): Promise<string> {
  const f = await una(ej, `select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [constraint]);
  return String(f['def']);
}

async function conDdlMutado<T>(
  constraint: string,
  ddl: readonly string[],
  fn: (ej: Ejecutar, crudo: (sql: string, params?: readonly unknown[]) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  return conDuenio(async (ej, crudo) => {
    const antes = await definicionDe(ej, constraint);
    for (const sentencia of ddl) await crudo(sentencia);
    try {
      return await fn(ej, crudo);
    } finally {
      await crudo('rollback');
      const despues = await definicionDe(ej, constraint);
      expect(despues, 'el rollback del DDL mutado NO restauró el esquema').toEqual(antes);
    }
  });
}

// -----------------------------------------------------------------------------
// Fixtures — un cliente sintético, dos cierre_cliente_periodo (uno abierto, uno confirmado), una
// cuenta y una regla_imputacion vieja/nueva.
// -----------------------------------------------------------------------------

let s: Sembrado;
let cierreAbiertoId: string;
let cierreConfirmadoId: string;
let cuentaId: string;
let reglaViejaId: string;
let reglaNuevaId: string;

let periodoSeq = 0;
async function crearCierre(ej: Ejecutar, estado: 'abierto' | 'confirmado'): Promise<string> {
  // Determinístico, nunca aleatorio: uq_cierre_periodo_vigente es (cliente_id, tipo_periodo,
  // periodo_desde, periodo_hasta) — un período random con pocos meses posibles colisiona seguro
  // entre varios `it` de la misma suite (medido: pasó en la primera corrida de este archivo).
  periodoSeq += 1;
  const mes = String(1 + (periodoSeq % 12)).padStart(2, '0');
  const anio = 2020 + Math.floor(periodoSeq / 12);
  const desde = `${anio}-${mes}-01`;
  const f =
    estado === 'abierto'
      ? await una(
          ej,
          `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta, cierre_estado)
           values ($1, 'mensual', $2::date, ($2::date + interval '1 month - 1 day')::date, 'abierto')
           returning id::text as id`,
          [s.clienteA, desde],
        )
      : await una(
          ej,
          `insert into cierre_cliente_periodo
             (cliente_id, tipo_periodo, periodo_desde, periodo_hasta, cierre_estado, confirmado_en, confirmado_por)
           values ($1, 'mensual', $2::date, ($2::date + interval '1 month - 1 day')::date, 'confirmado', now(), $3)
           returning id::text as id`,
          [s.clienteA, desde, USUARIOS.socio],
        );
  return String(f['id']);
}

async function crearAsiento(ej: Ejecutar, cierreId: string, extra: { corrigeAsientoId?: string } = {}): Promise<string> {
  const f = await una(
    ej,
    `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion, corrige_asiento_id)
     values ($1, $2, 'devengamiento', '2026-06-15'::date, $3)
     returning id::text as id`,
    [s.clienteA, cierreId, extra.corrigeAsientoId ?? null],
  );
  return String(f['id']);
}

async function crearReproceso(
  ej: Ejecutar,
  asientoId: string,
  asientoNuevoId: string,
  caso: string,
  motivoCodigo: string,
  reglas: { anterior: string | null; nueva: string | null },
): Promise<string> {
  const f = await una(
    ej,
    `insert into asiento_propuesto_reproceso
       (cliente_id, asiento_id, asiento_nuevo_id, caso, reproceso_motivo_codigo, motivo,
        regla_imputacion_id_anterior, regla_imputacion_id_nueva, hecho_por)
     values ($1, $2, $3, $4, $5, 'motivo sintético de prueba', $6, $7, $8)
     returning id::text as id`,
    [s.clienteA, asientoId, asientoNuevoId, caso, motivoCodigo, reglas.anterior, reglas.nueva, USUARIOS.socio],
  );
  return String(f['id']);
}

beforeAll(async () => {
  s = await sembrar();
  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    cierreAbiertoId = await crearCierre(ej, 'abierto');
    cierreConfirmadoId = await crearCierre(ej, 'confirmado');
    const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [s.clienteA]);
    cuentaId = String(cuenta['id']);
    const reglaVieja = await una(
      ej,
      `insert into regla_imputacion
         (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, vigente_hasta, respaldo, decidido_por)
       values ($1, 'impuesto_debitos_creditos', 'fija', $2, '2026-01-01'::date, '2026-09-01'::date, 'sintético', $3)
       returning id::text as id`,
      [s.clienteA, cuentaId, USUARIOS.socio],
    );
    reglaViejaId = String(reglaVieja['id']);
    const reglaNueva = await una(
      ej,
      `insert into regla_imputacion
         (cliente_id, tipo_movimiento, cuenta_resolucion, cuenta_id, vigente_desde, respaldo, decidido_por)
       values ($1, 'impuesto_debitos_creditos', 'fija', $2, '2026-09-01'::date, 'sintético corregido', $3)
       returning id::text as id`,
      [s.clienteA, cuentaId, USUARIOS.socio],
    );
    reglaNuevaId = String(reglaNueva['id']);
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

// =============================================================================
// A — trg_asiento_propuesto_cierre_no_terminal (1 mutación, 2 legítimos)
// =============================================================================
describe('0040 A — el trigger de cierre-no-terminal', () => {
  it(
    'M-A1 🔴 EN VIVO: con el trigger neutralizado, insertar un asiento en un cierre CONFIRMADO entra',
    async () => {
      const entro = await conDuenio(async (ej, crudo) => {
        await crudo(`
          create or replace function app.exigir_cierre_no_terminal_al_insertar_asiento() returns trigger
            language plpgsql as $$ begin return new; end; $$;
        `);
        const id = await crearAsiento(ej, cierreConfirmadoId);
        return Boolean(id);
      });
      expect(entro, 'el trigger neutralizado dejó insertar un asiento en un cierre ya confirmado').toBe(true);
    },
  );

  it('M-A1b 🔴 con el trigger real, el mismo intento se rechaza', async () => {
    const error = await capturar(() => comoSocio((ej) => crearAsiento(ej, cierreConfirmadoId)));
    expect(error.code, 'insertar en un cierre confirmado tiene que morir por el trigger (P0003)').toBe('P0003');
  });

  it('legítimo: insertar en un cierre ABIERTO funciona sin tocar el trigger', async () => {
    await comoSocio(async (ej) => {
      const id = await crearAsiento(ej, cierreAbiertoId);
      expect(id).toBeTruthy();
    });
  });
});

// =============================================================================
// B — asiento_propuesto_corrige_no_self_chk (1 mutación, 1 legítimo)
// =============================================================================
describe('0040 B — un asiento no puede corregirse a sí mismo', () => {
  it('M-B1 🔴 EN VIVO: con el CHECK relajado, corrige_asiento_id = id ENTRA', async () => {
    const entro = await conDdlMutado(
      'asiento_propuesto_corrige_no_self_chk',
      [
        'alter table asiento_propuesto drop constraint asiento_propuesto_corrige_no_self_chk',
        'alter table asiento_propuesto add constraint asiento_propuesto_corrige_no_self_chk check (true)',
      ],
      async (ej) => {
        const id = await una(
          ej,
          // corrige_asiento_id SOLO se puede fijar al INSERT (0028 acotó UPDATE a asiento_estado/
          // superseded_by_id) — el id se conoce de antemano, self-referencia directa en el INSERT.
          `insert into asiento_propuesto (id, cliente_id, cierre_id, tipo, fecha_imputacion, corrige_asiento_id)
           values ($1, $2, $3, 'ajuste_cierre', '2026-06-15'::date, $1) returning id::text as id`,
          [randomUUID(), s.clienteA, cierreAbiertoId],
        );
        return Boolean(id['id']);
      },
    );
    expect(entro, 'el check relajado dejó a un asiento corregirse a sí mismo').toBe(true);
  });

  it('M-B1b 🔴 con el CHECK real, el mismo intento se rechaza', async () => {
    const nuevoId = randomUUID();
    const error = await capturar(() =>
      comoSocio((ej) =>
        una(
          ej,
          `insert into asiento_propuesto (id, cliente_id, cierre_id, tipo, fecha_imputacion, corrige_asiento_id)
           values ($1, $2, $3, 'ajuste_cierre', '2026-06-15'::date, $1) returning id::text as id`,
          [nuevoId, s.clienteA, cierreAbiertoId],
        ),
      ),
    );
    esperarRechazo(error, '23514', 'asiento_propuesto_corrige_no_self_chk', 'corrige_asiento_id = id tiene que morir por el check');
  });
});

// =============================================================================
// C — asiento_propuesto_reproceso_distinto_chk (1 mutación, 1 legítimo)
// =============================================================================
describe('0040 C — un reproceso no puede ligar un asiento consigo mismo', () => {
  it('M-C1 🔴 EN VIVO: con el CHECK relajado, asiento_id = asiento_nuevo_id ENTRA', async () => {
    const entro = await conDdlMutado(
      'asiento_propuesto_reproceso_distinto_chk',
      [
        'alter table asiento_propuesto_reproceso drop constraint asiento_propuesto_reproceso_distinto_chk',
        'alter table asiento_propuesto_reproceso add constraint asiento_propuesto_reproceso_distinto_chk check (true)',
      ],
      async (ej) => {
        const asientoId = await crearAsiento(ej, cierreAbiertoId);
        const id = await crearReproceso(ej, asientoId, asientoId, 'reemplazo_no_revisado', 'dato_tardio_cliente', {
          anterior: null,
          nueva: null,
        });
        return Boolean(id);
      },
    );
    expect(entro, 'el check relajado dejó a un reproceso ligar un asiento consigo mismo').toBe(true);
  });

  it('M-C1b 🔴 con el CHECK real, el mismo intento se rechaza', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const asientoId = await crearAsiento(ej, cierreAbiertoId);
        await crearReproceso(ej, asientoId, asientoId, 'reemplazo_no_revisado', 'dato_tardio_cliente', {
          anterior: null,
          nueva: null,
        });
      }),
    );
    esperarRechazo(error, '23514', 'asiento_propuesto_reproceso_distinto_chk', 'asiento_id = asiento_nuevo_id tiene que morir por el check');
  });
});

// =============================================================================
// D — asiento_propuesto_reproceso_regla_chk (1 mutación, 2 legítimos)
// =============================================================================
describe('0040 D — coherencia motivo_codigo ↔ regla_imputacion', () => {
  it(
    'M-D1 🔴 EN VIVO: con el CHECK relajado, correccion_criterio_estudio SIN las dos reglas ENTRA',
    async () => {
      const entro = await conDdlMutado(
        'asiento_propuesto_reproceso_regla_chk',
        [
          'alter table asiento_propuesto_reproceso drop constraint asiento_propuesto_reproceso_regla_chk',
          'alter table asiento_propuesto_reproceso add constraint asiento_propuesto_reproceso_regla_chk check (true)',
        ],
        async (ej) => {
          const asientoViejo = await crearAsiento(ej, cierreAbiertoId);
          const asientoNuevo = await crearAsiento(ej, cierreAbiertoId);
          const id = await crearReproceso(ej, asientoViejo, asientoNuevo, 'reemplazo_no_revisado', 'correccion_criterio_estudio', {
            anterior: null,
            nueva: null,
          });
          return Boolean(id);
        },
      );
      expect(entro, 'el check relajado dejó pasar correccion_criterio_estudio sin las dos reglas referenciadas').toBe(true);
    },
  );

  it('M-D1b 🔴 con el CHECK real, el mismo intento se rechaza', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const asientoViejo = await crearAsiento(ej, cierreAbiertoId);
        const asientoNuevo = await crearAsiento(ej, cierreAbiertoId);
        await crearReproceso(ej, asientoViejo, asientoNuevo, 'reemplazo_no_revisado', 'correccion_criterio_estudio', {
          anterior: null,
          nueva: null,
        });
      }),
    );
    esperarRechazo(error, '23514', 'asiento_propuesto_reproceso_regla_chk', 'correccion_criterio_estudio sin las dos reglas tiene que morir por el check');
  });

  it('legítimo: correccion_criterio_estudio CON las dos reglas entra', async () => {
    await comoSocio(async (ej) => {
      const asientoViejo = await crearAsiento(ej, cierreAbiertoId);
      const asientoNuevo = await crearAsiento(ej, cierreAbiertoId);
      const id = await crearReproceso(ej, asientoViejo, asientoNuevo, 'reemplazo_no_revisado', 'correccion_criterio_estudio', {
        anterior: reglaViejaId,
        nueva: reglaNuevaId,
      });
      expect(id).toBeTruthy();
    });
  });

  it('legítimo: dato_tardio_cliente SIN ninguna regla entra', async () => {
    await comoSocio(async (ej) => {
      const asientoViejo = await crearAsiento(ej, cierreAbiertoId);
      const asientoNuevo = await crearAsiento(ej, cierreAbiertoId);
      const id = await crearReproceso(ej, asientoViejo, asientoNuevo, 'reemplazo_no_revisado', 'dato_tardio_cliente', {
        anterior: null,
        nueva: null,
      });
      expect(id).toBeTruthy();
    });
  });
});

// =============================================================================
// E — 🔴 LA CARRERA TOCTOU, EN VIVO con dos conexiones reales (1 mutación, 1 legítimo)
// =============================================================================
//
// Mutación COMMITTEADA de verdad (no envuelta en el rollback de conDdlMutado): una carrera entre dos
// conexiones necesita que la mutación sea VISIBLE para AMBAS — un `create or replace function` dentro
// de una transacción que después se rollbackea nunca sale de esa transacción, así que la otra
// conexión jamás la vería. Se restaura con la definición REAL al final, con su propio `try/finally`.
const FUNCION_REAL = `
create or replace function app.exigir_cierre_no_terminal_al_insertar_asiento() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_cierre_estado text;
begin
  select cierre_estado into v_cierre_estado
    from public.cierre_cliente_periodo
   where cliente_id = new.cliente_id and id = new.cierre_id
     for share;

  if v_cierre_estado in ('confirmado', 'anulado') then
    raise exception
      'no se puede insertar un asiento_propuesto (id=%) en un cierre_cliente_periodo ya terminal (cierre_id=%)',
      new.id, new.cierre_id
      using errcode = 'P0003';
  end if;

  return new;
end;
$$;
`;

const FUNCION_VULNERABLE_CON_SLEEP = `
create or replace function app.exigir_cierre_no_terminal_al_insertar_asiento() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_cierre_estado text;
begin
  -- 🔴 SIN "for share" — la mutación exacta que dba-data/security-engineer identificaron.
  select cierre_estado into v_cierre_estado
    from public.cierre_cliente_periodo
   where cliente_id = new.cliente_id and id = new.cierre_id;

  -- Sleep INYECTADO solo para este test: fuerza el entrelazado determinístico (sin esto, la carrera
  -- es posible pero no reproducible de forma confiable en un test — depende de timing de red).
  perform pg_sleep(1);

  if v_cierre_estado in ('confirmado', 'anulado') then
    raise exception 'no se puede insertar ... (cierre_id=%)', new.cierre_id using errcode = 'P0003';
  end if;

  return new;
end;
$$;
`;

const FUNCION_REAL_CON_SLEEP = `
create or replace function app.exigir_cierre_no_terminal_al_insertar_asiento() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_cierre_estado text;
begin
  -- CON "for share" — igual que la función real, pero con el MISMO sleep inyectado que la variante
  -- vulnerable, para poder comparar el mismo entrelazado bajo las dos condiciones.
  select cierre_estado into v_cierre_estado
    from public.cierre_cliente_periodo
   where cliente_id = new.cliente_id and id = new.cierre_id
     for share;

  perform pg_sleep(1);

  if v_cierre_estado in ('confirmado', 'anulado') then
    raise exception 'no se puede insertar ... (cierre_id=%)', new.cierre_id using errcode = 'P0003';
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
    await duenio.query(ddlMutante); // autocommit — sin BEGIN, cada statement se commitea solo
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

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** true = la promesa ya resolvió/rechazó dentro de `ms`; false = sigue pendiente (bloqueada). */
async function sigueBloqueada(promesa: Promise<unknown>, ms: number): Promise<boolean> {
  const centinela = Symbol('pendiente');
  const resultado = await Promise.race([promesa.catch(() => centinela), esperar(ms).then(() => centinela)]);
  return resultado === centinela ? true : false;
}

describe('0040 E — 🔴 la carrera TOCTOU, en vivo con dos conexiones reales', () => {
  it(
    'M-E1 🔴 EN VIVO, SIN for share: un INSERT y una confirmación concurrentes se entrelazan — el ' +
      'asiento queda insertado en un cierre que YA es confirmado',
    async () => {
      await conFuncionCommitteada(FUNCION_VULNERABLE_CON_SLEEP, async () => {
        const cierreId = await comoSocio((ej) => crearCierre(ej, 'abierto'));

        const clienteA = await clienteDuenio();
        const clienteB = await clienteDuenio();
        try {
          await clienteA.query('begin');
          await clienteA.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);

          const asientoId = randomUUID();
          // No se espera todavía: dispara el INSERT, que entra al trigger, lee 'abierto', y se
          // duerme 1s ANTES de decidir — el resto de este bloque corre MIENTRAS ClientA duerme.
          const insertA = clienteA.query(
            `insert into asiento_propuesto (id, cliente_id, cierre_id, tipo, fecha_imputacion)
             values ($1, $2, $3, 'devengamiento', '2026-06-15'::date)`,
            [asientoId, s.clienteA, cierreId],
          );

          await esperar(300); // deja que ClientA entre al pg_sleep (lea 'abierto' antes de confirmar)

          await clienteB.query('begin');
          await clienteB.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);
          // Sin "for share" del lado de ClientA, esto NO bloquea — completa de inmediato.
          await clienteB.query(
            `update cierre_cliente_periodo set cierre_estado = 'confirmado', confirmado_en = now(), confirmado_por = $1
             where id = $2`,
            [USUARIOS.socio, cierreId],
          );
          await clienteB.query('commit');

          // ClientA despierta, ya decidió con el valor viejo ('abierto') — inserta igual.
          await insertA;
          await clienteA.query('commit');

          const verificacion = await comoSocio((ej) =>
            una(ej, `select cierre_estado from cierre_cliente_periodo where id = $1`, [cierreId]),
          );
          expect(verificacion['cierre_estado'], 'la carrera dejó el cierre confirmado').toBe('confirmado');

          const filaAsiento = await comoSocio((ej) =>
            ej(`select id from asiento_propuesto where id = $1`, [asientoId]),
          );
          expect(
            filaAsiento.length,
            'LA CARRERA SE COLÓ: el asiento quedó insertado en un cierre que ya es confirmado',
          ).toBe(1);
        } finally {
          await clienteA.end();
          await clienteB.end();
        }
      });
    },
    10_000,
  );

  it(
    'M-E1b 🔴 CON for share: el MISMO entrelazado — ClientB queda BLOQUEADO hasta que ClientA ' +
      'termina, y el resultado final es consistente (nunca la corrupción de M-E1)',
    async () => {
      await conFuncionCommitteada(FUNCION_REAL_CON_SLEEP, async () => {
        const cierreId = await comoSocio((ej) => crearCierre(ej, 'abierto'));

        const clienteA = await clienteDuenio();
        const clienteB = await clienteDuenio();
        try {
          await clienteA.query('begin');
          await clienteA.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);

          const asientoId = randomUUID();
          const insertA = clienteA.query(
            `insert into asiento_propuesto (id, cliente_id, cierre_id, tipo, fecha_imputacion)
             values ($1, $2, $3, 'devengamiento', '2026-06-15'::date)`,
            [asientoId, s.clienteA, cierreId],
          );

          // "for share" toma el lock ANTES del sleep (es la primera línea de la función) — para
          // cuando llegamos acá, ClientA ya tiene la fila de cierre_cliente_periodo bloqueada.
          await esperar(300);

          await clienteB.query('begin');
          await clienteB.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);
          const updateB = clienteB.query(
            `update cierre_cliente_periodo set cierre_estado = 'confirmado', confirmado_en = now(), confirmado_por = $1
             where id = $2`,
            [USUARIOS.socio, cierreId],
          );

          const bloqueada = await sigueBloqueada(updateB, 500);
          expect(bloqueada, 'sin el lock de "for share", ClientB no debería haber quedado bloqueado — la mutación no aplicó').toBe(true);

          // Libera el lock — recién ahí ClientB puede completar.
          await insertA;
          await clienteA.query('commit');

          await updateB;
          await clienteB.query('commit');

          const verificacion = await comoSocio((ej) =>
            una(ej, `select cierre_estado from cierre_cliente_periodo where id = $1`, [cierreId]),
          );
          expect(verificacion['cierre_estado']).toBe('confirmado');

          const filaAsiento = await comoSocio((ej) => ej(`select id from asiento_propuesto where id = $1`, [asientoId]));
          expect(
            filaAsiento.length,
            'el asiento se insertó ANTES de que el cierre se confirmara (orden serializado, no corrupto)',
          ).toBe(1);
        } finally {
          await clienteA.end();
          await clienteB.end();
        }
      });
    },
    10_000,
  );
});
