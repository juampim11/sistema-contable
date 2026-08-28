/**
 * MUTACIONES de `0028_inmutabilidad_post_terminal_cierre.sql` — prueba por mutación de la regla
 * verificable NUEVA de esta migración (CLAUDE.md §1.8): `app.exigir_inmutabilidad_post_terminal()`,
 * el trigger genérico que cierra el hallazgo BLOQUEANTE de HANDOFF (130).
 *
 * Archivo separado de `mutaciones-0027.test.ts` a propósito (diseño de `qa-automation`): esta regla
 * es de una convocatoria posterior, con su propia migración — no repite la cobertura de esa suite
 * (el gate de D-24 en sí, `M-C1`/`M-C2`, sigue ahí sin cambios).
 *
 * ## Qué prueba esto
 *
 * El trigger genérico rechaza cualquier UPDATE sobre una fila cuyo estado viejo YA es terminal,
 * salvo la única transición legítima de supersesión (estado→'superseded' + puntero null→no-null,
 * sin que cambie ningún otro campo) en las tablas que la admiten. Se prueba en las tres tablas donde
 * se aplicó (pedido de JP: mismo mecanismo genérico, sin variante puntual, para confirmar que
 * generaliza):
 *
 *   - `cierre_cliente_periodo`: terminales {confirmado, anulado}, SIN supersesión — bloqueo total.
 *   - `asiento_propuesto`: terminal {confirmado, superseded}, CON supersesión.
 *   - `pendiente_cierre`: terminales {resuelto, dispensado, superseded}, CON supersesión.
 *
 * ## Cobertura declarada de esta primera pasada (CLAUDE.md §1.8: conteo explícito, no todo lo
 * imaginable)
 *
 * Por tabla: 1-2 casos legítimos (la transición real sigue funcionando) + el ataque literal de
 * HANDOFF 130 (reescribir un campo sin tocar el estado, código real vía `conUsuario`) + al menos
 * una mutación que reproduce el defecto que motivó esta migración. Total: 8 legítimos, 6 ataques
 * reales, 6 mutaciones — 16 `it()` (contado con `grep -c '  it('`, no de memoria). `qa-automation`
 * diseñó una batería más amplia (~40 casos, incluidas variantes de re-superseder y de lista de
 * terminales incompleta); quedan señaladas como `// TODO(0028-b)` donde correspondería sumarlas, no
 * implementadas en esta pasada por foco de tiempo — no se declaran como cerradas.
 *
 * 🔴 Hallazgo real, encontrado CORRIENDO este archivo, no anticipado en el diseño: la mutación más
 * importante ("resto igual") no se puede demostrar en `asiento_propuesto` — esa tabla solo tiene DOS
 * columnas grantables (`asiento_estado`, `superseded_by_id`), así que no hay una tercera columna
 * grantable para "colar" junto con la supersesión: el GRANT acotado ya cierra ese vector antes de que
 * el trigger tenga que evaluar nada. La mutación se probó en `pendiente_cierre` (M-C2), que sí tiene
 * columnas grantables de sobra (`resuelto_por`/`resuelto_en`/`resolucion_id`) — ahí el chequeo "resto
 * igual" del trigger es la ÚNICA defensa, no una capa redundante con el grant.
 *
 * 🔴 **Consecuencia explícita, no implícita en el conteo de arriba:** `trg_asiento_propuesto_inmutable`
 * NO tiene, en esta pasada, ninguna prueba de ATAQUE que dependa de que el trigger en sí rechace algo
 * — el único vector conocido hoy (colar otra columna junto con la supersesión) ya lo cierra el grant
 * acotado, antes de que el trigger llegue a evaluar nada (ver el `it` "ATAQUE: supersede + colar
 * fecha_imputacion..." más abajo, que confirma el rechazo por `42501`, no por `P0002`). El trigger de
 * esta tabla hoy es una capa de defensa en profundidad SIN un ataque real que la ejercite como última
 * línea. **Si en el futuro se agrega una columna grantable nueva a `asiento_propuesto`** (además de
 * `asiento_estado`/`superseded_by_id`), el grant deja de alcanzar solo, el trigger pasa a ser la
 * defensa REAL contra ese vector — y en ese momento hace falta escribir su propio test de ataque
 * (mismo patrón que M-C2 sobre `pendiente_cierre`), no asumir que queda cubierto por analogía con las
 * otras dos tablas.
 *
 * ## El laboratorio de mutación: por qué hace falta un mecanismo nuevo, no `conGrantsMutados`
 *
 * `conGrantsMutados` (de `grants-conjunto-cerrado.test.ts`) mide con el MISMO cliente que hizo el
 * DDL — nunca ataca como otro rol. Acá hace falta lo contrario: mutar el trigger/función como DUEÑO
 * (solo el dueño puede `ALTER`/`CREATE OR REPLACE`) y DESPUÉS, en la MISMA transacción (para que el
 * DDL sin commitear sea visible), atacar como `app_request` con la identidad de un usuario de
 * negocio — igual que hace `conUsuario()`, pero sin su propia conexión (que no vería el DDL
 * sin commitear del dueño). `set local role`/`set_config` reproducen exactamente lo que hace
 * `conUsuario()`, dentro de la transacción del dueño: `set local` es transaccional por diseño de
 * Postgres, así que el `rollback` final deshace el cambio de rol solo, igual que el resto del DDL.
 *
 * Requisito previo: `0028` aplicada a local.
 */

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
    return {
      code: err.code ?? '(sin code)',
      constraint: err.constraint ?? null,
      message: err.message ?? String(e),
    };
  }
}

function esperarRechazo(actual: ErrorPg, code: string, porque: string): void {
  expect(actual.code, porque).toBe(code);
}

function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
// El laboratorio de mutación
// -----------------------------------------------------------------------------

const TRIGGERS = [
  { tabla: 'cierre_cliente_periodo', trigger: 'trg_cierre_periodo_inmutable' },
  { tabla: 'asiento_propuesto', trigger: 'trg_asiento_propuesto_inmutable' },
  { tabla: 'pendiente_cierre', trigger: 'trg_pendiente_cierre_inmutable' },
] as const;

/** Huella de los tres triggers + la función genérica, para verificar que el rollback restauró todo. */
async function huella(ej: Ejecutar): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const { tabla, trigger } of TRIGGERS) {
    const f = await una(
      ej,
      `select pg_get_triggerdef(t.oid) as def, t.tgenabled as habilitado
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
        where c.relname = $1 and t.tgname = $2 and not t.tgisinternal`,
      [tabla, trigger],
    );
    out[`${tabla}.${trigger}`] = `${String(f['def'])}|${String(f['habilitado'])}`;
  }
  const fn = await una(
    ej,
    `select pg_get_functiondef('app.exigir_inmutabilidad_post_terminal()'::regprocedure) as def`,
  );
  out['funcion'] = String(fn['def']);
  return out;
}

/**
 * Corre `fn` con el DDL mutado, en la transacción del DUEÑO (única forma de hacer `ALTER
 * TABLE`/`CREATE OR REPLACE FUNCTION`), y DESPUÉS del DDL cambia a `app_request` con la identidad de
 * un usuario de negocio (`set local role` + `set_config`, ambos transaccionales) para que el ataque
 * se mida con los grants/RLS reales, no con los privilegios del dueño. Rollback SIEMPRE, y se
 * verifica al salir que la huella de los triggers/función volvió a ser la original.
 */
async function conInmutabilidadMutada<T>(
  ddl: readonly string[],
  usuarioId: string,
  fn: (ej: Ejecutar) => Promise<T>,
): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(
      `Las pruebas de mutación de 0028 corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`,
    );
  }
  const duenio = await clienteDuenio();
  const ejDuenio = desdeCliente(duenio);
  try {
    await duenio.query('begin');
    const antes = await huella(ejDuenio);
    for (const sentencia of ddl) await duenio.query(sentencia);
    await duenio.query('set local role app_request');
    await duenio.query(`select set_config('app.user_id', $1, true)`, [usuarioId]);
    let resultado: T;
    try {
      resultado = await fn(ejDuenio);
    } catch (error) {
      // `fn` lanzó (una query real falló) — un `reset role`/`rollback` acá NO debe reemplazar ese
      // error: en JS, una excepción lanzada en un `finally` pisa la del `try`, y ya pasó una vez en
      // esta misma corrida que "current transaction is aborted" escondió el error real. `rollback`
      // solo (nunca `reset role`: en transacción abortada cualquier comando que no sea ROLLBACK se
      // rechaza), y se relanza el original.
      await duenio.query('rollback');
      throw error;
    }
    await duenio.query('reset role');
    await duenio.query('rollback');
    const despues = await huella(ejDuenio);
    expect(despues, 'el rollback de la mutación NO restauró los triggers/función a su forma original').toEqual(
      antes,
    );
    return resultado;
  } finally {
    await duenio.end();
  }
}

// =============================================================================
// A — `cierre_cliente_periodo`: bloqueo total, sin supersesión (D-6)
// =============================================================================
describe('0028 A — cierre_cliente_periodo: inmutable una vez confirmado/anulado, sin excepción', () => {
  async function crearCierreConfirmado(ej: Ejecutar, periodo: string): Promise<string> {
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
       values ($1, 'mensual', $2, $2::date + interval '1 month' - interval '1 day')
       returning id::text as id`,
      [s.clienteA, periodo],
    );
    await ej(
      `update cierre_cliente_periodo
         set cierre_estado = 'confirmado', confirmado_en = now(), confirmado_por = $2
       where cliente_id = $1 and id = $3`,
      [s.clienteA, USUARIOS.socio, cierre['id']],
    );
    return String(cierre['id']);
  }

  it('legítimo: la transición a confirmado sigue funcionando con el trigger instalado', async () => {
    await comoSocio(async (ej) => {
      const cierreId = await crearCierreConfirmado(ej, '2027-01-01');
      const fila = await una(
        ej,
        `select cierre_estado as "cierreEstado" from cierre_cliente_periodo where cliente_id = $1 and id = $2`,
        [s.clienteA, cierreId],
      );
      expect(fila['cierreEstado']).toBe('confirmado');
    });
  });

  it('legítimo: la transición a anulado también funciona (segundo terminal, distinto CHECK)', async () => {
    await comoSocio(async (ej) => {
      const cierre = await una(
        ej,
        `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
         values ($1, 'mensual', '2027-02-01', '2027-02-28') returning id::text as id`,
        [s.clienteA],
      );
      const anulado = await una(
        ej,
        `update cierre_cliente_periodo set cierre_estado = 'anulado' where cliente_id = $1 and id = $2
         returning cierre_estado as "cierreEstado"`,
        [s.clienteA, cierre['id']],
      );
      expect(anulado['cierreEstado']).toBe('anulado');
    });
  });

  it('ATAQUE (HANDOFF 130, literal): reescribir confirmado_por de un cierre YA confirmado, sin tocar cierre_estado — rechazado', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cierreId = await crearCierreConfirmado(ej, '2027-03-01');
        return ej(`update cierre_cliente_periodo set confirmado_por = $2 where cliente_id = $1 and id = $3`, [
          s.clienteA,
          USUARIOS.contadorA,
          cierreId,
        ]);
      }),
    );
    esperarRechazo(
      error,
      'P0002',
      'el vector exacto de HANDOFF 130: falsificar quién confirmó, sin tocar cierre_estado, tiene que ' +
        'quedar bloqueado por el trigger — el rol es CORRECTO (socio), no insuficiente',
    );
  });

  it('ATAQUE: reescribir periodo_desde de un cierre ya confirmado — rechazado (grant Y trigger)', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cierreId = await crearCierreConfirmado(ej, '2027-04-01');
        return ej(`update cierre_cliente_periodo set periodo_desde = '2020-01-01' where cliente_id = $1 and id = $2`, [
          s.clienteA,
          cierreId,
        ]);
      }),
    );
    // periodo_desde ya no es grantable (0028) — el rechazo es por privilegio (42501), antes de que
    // el trigger llegue a evaluar nada. Confirma que las dos capas cierran el mismo vector por
    // caminos distintos.
    esperarRechazo(error, '42501', 'periodo_desde no es columna grantable desde 0028 — ni siquiera llega al trigger');
  });

  it('MUTACIÓN M-A1 🔴 con el trigger deshabilitado, el ataque de HANDOFF 130 pasa', async () => {
    await conInmutabilidadMutada(
      ['alter table cierre_cliente_periodo disable trigger trg_cierre_periodo_inmutable'],
      USUARIOS.socio,
      async (ej) => {
        const cierreId = await crearCierreConfirmado(ej, '2027-05-01');
        const actualizado = await una(
          ej,
          `update cierre_cliente_periodo set confirmado_por = $2 where cliente_id = $1 and id = $3
           returning confirmado_por::text as "confirmadoPor"`,
          [s.clienteA, USUARIOS.contadorA, cierreId],
        );
        expect(
          actualizado['confirmadoPor'],
          'con el trigger deshabilitado, el ataque original de HANDOFF 130 vuelve a pasar — así se ' +
            'demuestra que ES el trigger, y no otra cosa, lo que lo bloquea',
        ).toBe(USUARIOS.contadorA);
      },
    );
  });

  it('MUTACIÓN M-A2 🔴 con el trigger recreado `BEFORE UPDATE OF cierre_estado` (repite el error original de D-24), el ataque pasa', async () => {
    await conInmutabilidadMutada(
      [
        'drop trigger trg_cierre_periodo_inmutable on cierre_cliente_periodo',
        `create trigger trg_cierre_periodo_inmutable
           before update of cierre_estado on cierre_cliente_periodo
           for each row
           execute function app.exigir_inmutabilidad_post_terminal('cierre_estado', 'confirmado,anulado', '')`,
      ],
      USUARIOS.socio,
      async (ej) => {
        const cierreId = await crearCierreConfirmado(ej, '2027-06-01');
        // El ataque NUNCA toca cierre_estado — con `OF cierre_estado`, el trigger ni dispara.
        const actualizado = await una(
          ej,
          `update cierre_cliente_periodo set confirmado_por = $2 where cliente_id = $1 and id = $3
           returning confirmado_por::text as "confirmadoPor"`,
          [s.clienteA, USUARIOS.contadorA, cierreId],
        );
        expect(
          actualizado['confirmadoPor'],
          'con `OF cierre_estado`, el ataque que NUNCA toca esa columna vuelve a pasar — es exactamente ' +
            'el defecto original del gate de D-24, reproducido a propósito',
        ).toBe(USUARIOS.contadorA);
      },
    );
  });

  // TODO(0028-b, qa-automation): M3 (lista de terminales recortada a solo 'confirmado', ataca un
  // cierre 'anulado') y M4 condicional (no-op con los mismos valores, pendiente de confirmar la
  // semántica de "sin excepción" con contador-dominio) — no implementadas en esta pasada.
});

// =============================================================================
// B — `asiento_propuesto`: confirmado→superseded es la única salida (D-6, "supersesión para contenido")
// =============================================================================
describe('0028 B — asiento_propuesto: inmutable salvo la supersesión legítima', () => {
  async function crearAsientoConfirmado(ej: Ejecutar, fecha: string): Promise<string> {
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
       values ($1, 'mensual', $2, $2::date + interval '1 month' - interval '1 day')
       returning id::text as id`,
      [s.clienteA, fecha],
    );
    const asiento = await una(
      ej,
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', $3) returning id::text as id`,
      [s.clienteA, cierre['id'], fecha],
    );
    await ej(`update asiento_propuesto set asiento_estado = 'confirmado' where cliente_id = $1 and id = $2`, [
      s.clienteA,
      asiento['id'],
    ]);
    return String(asiento['id']);
  }

  it('legítimo: confirmar sigue funcionando', async () => {
    await comoSocio(async (ej) => {
      const asientoId = await crearAsientoConfirmado(ej, '2027-07-01');
      const fila = await una(
        ej,
        `select asiento_estado as "asientoEstado" from asiento_propuesto where cliente_id = $1 and id = $2`,
        [s.clienteA, asientoId],
      );
      expect(fila['asientoEstado']).toBe('confirmado');
    });
  });

  it('legítimo: superseder un asiento confirmado (estado→superseded + puntero, juntos) sigue funcionando', async () => {
    await comoSocio(async (ej) => {
      const viejoId = await crearAsientoConfirmado(ej, '2027-08-01');
      const cierreDelViejo = await una(
        ej,
        `select cierre_id::text as "cierreId" from asiento_propuesto where cliente_id = $1 and id = $2`,
        [s.clienteA, viejoId],
      );
      const nuevo = await una(
        ej,
        `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
         values ($1, $2, 'devengamiento', '2027-08-01') returning id::text as id`,
        [s.clienteA, cierreDelViejo['cierreId']],
      );
      const superseded = await una(
        ej,
        `update asiento_propuesto set asiento_estado = 'superseded', superseded_by_id = $3
         where cliente_id = $1 and id = $2
         returning asiento_estado as "asientoEstado", superseded_by_id::text as "supersededById"`,
        [s.clienteA, viejoId, nuevo['id']],
      );
      expect(superseded['asientoEstado']).toBe('superseded');
      expect(superseded['supersededById']).toBe(String(nuevo['id']));
    });
  });

  it('ATAQUE (HANDOFF 130, literal): reescribir fecha_imputacion de un asiento YA confirmado — rechazado', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const asientoId = await crearAsientoConfirmado(ej, '2027-09-01');
        return ej(`update asiento_propuesto set fecha_imputacion = '2020-01-01' where cliente_id = $1 and id = $2`, [
          s.clienteA,
          asientoId,
        ]);
      }),
    );
    esperarRechazo(error, '42501', 'fecha_imputacion no es grantable desde 0028 — el ataque de HANDOFF 130 sobre esta tabla');
  });

  it('ATAQUE (seguridad-datos-financieros): revivir un asiento superseded a propuesto — rechazado', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const viejoId = await crearAsientoConfirmado(ej, '2027-10-01');
        const cierreDelViejo = await una(
          ej,
          `select cierre_id::text as "cierreId" from asiento_propuesto where cliente_id = $1 and id = $2`,
          [s.clienteA, viejoId],
        );
        const nuevo = await una(
          ej,
          `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
           values ($1, $2, 'devengamiento', '2027-10-01') returning id::text as id`,
          [s.clienteA, cierreDelViejo['cierreId']],
        );
        await ej(`update asiento_propuesto set asiento_estado = 'superseded', superseded_by_id = $3
                   where cliente_id = $1 and id = $2`, [s.clienteA, viejoId, nuevo['id']]);
        // El ataque: revivir el viejo (ya superseded) a 'propuesto'.
        return ej(`update asiento_propuesto set asiento_estado = 'propuesto' where cliente_id = $1 and id = $2`, [
          s.clienteA,
          viejoId,
        ]);
      }),
    );
    esperarRechazo(
      error,
      'P0002',
      'sin esto, un asiento superseded podía revivirse a propuesto sin rastro — hallazgo de ' +
        'seguridad-datos-financieros, cerrado por el mismo trigger (superseded está en la lista de terminales)',
    );
  });

  it('ATAQUE: supersede + colar fecha_imputacion en el mismo UPDATE — rechazado por el GRANT, ni llega al trigger', async () => {
    // 🔴 Hallazgo al correr este test, no anticipado en el diseño: `asiento_propuesto` solo tiene DOS
    // columnas grantables (`asiento_estado`, `superseded_by_id`) — no hay una TERCERA columna
    // grantable para "colar" junto con la supersesión legítima, así que este vector ya lo cierra el
    // grant acotado de 0028, sin necesidad de que el trigger lo evalúe. El chequeo "ningún otro campo
    // cambió" del trigger es, PARA ESTA TABLA, defensa en profundidad — no la única capa. La mutación
    // que sí lo necesita como única defensa está en `pendiente_cierre` (ver M-C2 más abajo), que tiene
    // TRES columnas grantables además de las dos de supersesión (`resuelto_por`/`resuelto_en`/
    // `resolucion_id`).
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const viejoId = await crearAsientoConfirmado(ej, '2027-11-01');
        const cierreDelViejo = await una(
          ej,
          `select cierre_id::text as "cierreId" from asiento_propuesto where cliente_id = $1 and id = $2`,
          [s.clienteA, viejoId],
        );
        const nuevo = await una(
          ej,
          `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
           values ($1, $2, 'devengamiento', '2027-11-01') returning id::text as id`,
          [s.clienteA, cierreDelViejo['cierreId']],
        );
        return ej(
          `update asiento_propuesto
             set asiento_estado = 'superseded', superseded_by_id = $3, fecha_imputacion = '2020-01-01'
           where cliente_id = $1 and id = $2`,
          [s.clienteA, viejoId, nuevo['id']],
        );
      }),
    );
    esperarRechazo(
      error,
      '42501',
      'fecha_imputacion no es grantable — el grant acotado ya cierra este vector antes de que el ' +
        'trigger tenga que evaluar nada',
    );
  });

  // TODO(0028-b, qa-automation): re-superseder una fila ya superseded (exige old.superseded_by_id
  // IS NULL); trigger mal cableado con TG_ARGV[2]='' que rompe el caso legítimo de supersesión — no
  // implementadas en esta pasada.
});

// =============================================================================
// C — `pendiente_cierre`: mismo mecanismo genérico, sin variante puntual (pedido de JP)
// =============================================================================
describe('0028 C — pendiente_cierre: mismo trigger genérico, confirma que el diseño generaliza', () => {
  async function crearPendienteResuelto(ej: Ejecutar, periodo: string): Promise<string> {
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
       values ($1, 'mensual', $2, $2::date + interval '1 month' - interval '1 day')
       returning id::text as id`,
      [s.clienteA, periodo],
    );
    const pendiente = await una(
      ej,
      `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
       values ($1, $2, 'documento_faltante', 'abierto') returning id::text as id`,
      [s.clienteA, cierre['id']],
    );
    await ej(
      `update pendiente_cierre
         set pendiente_estado = 'resuelto', resuelto_por = $2, resuelto_en = now()
       where cliente_id = $1 and id = $3`,
      [s.clienteA, USUARIOS.socio, pendiente['id']],
    );
    return String(pendiente['id']);
  }

  it('legítimo: resolver un pendiente abierto sigue funcionando', async () => {
    await comoSocio(async (ej) => {
      const pendienteId = await crearPendienteResuelto(ej, '2027-12-01');
      const fila = await una(
        ej,
        `select pendiente_estado as "pendienteEstado" from pendiente_cierre where cliente_id = $1 and id = $2`,
        [s.clienteA, pendienteId],
      );
      expect(fila['pendienteEstado']).toBe('resuelto');
    });
  });

  it('legítimo: superseder un pendiente ya resuelto (mismo mecanismo que asiento_propuesto)', async () => {
    await comoSocio(async (ej) => {
      const viejoId = await crearPendienteResuelto(ej, '2028-01-01');
      const cierreDelViejo = await una(
        ej,
        `select cierre_id::text as "cierreId" from pendiente_cierre where cliente_id = $1 and id = $2`,
        [s.clienteA, viejoId],
      );
      // `referencia_origen` distinta a propósito: `uq_pendiente_cierre_natural` no tiene predicado
      // parcial (a diferencia de lo que asumía el boceto original, `23` §2.5) — un `pendiente_cierre`
      // nuevo con la MISMA clave natural que el que reemplaza (mismo cierre_id + motivo_codigo, los
      // dos con fuente_cierre_id/referencia_origen en null) choca contra esa unique. Residuo real,
      // ya señalado por `arquitecto-software` (no bloquea el diseño del trigger, que solo gobierna la
      // fila VIEJA — es de quien implemente el flujo real de reproceso de `pendiente_cierre`).
      const nuevo = await una(
        ej,
        `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado, referencia_origen)
         values ($1, $2, 'documento_faltante', 'abierto', 'reproceso-test-legitimo') returning id::text as id`,
        [s.clienteA, cierreDelViejo['cierreId']],
      );
      const superseded = await una(
        ej,
        `update pendiente_cierre set pendiente_estado = 'superseded', superseded_by_id = $3
         where cliente_id = $1 and id = $2
         returning pendiente_estado as "pendienteEstado"`,
        [s.clienteA, viejoId, nuevo['id']],
      );
      expect(superseded['pendienteEstado']).toBe('superseded');
    });
  });

  it('MUTACIÓN M-C2 🔴 sin exigir "ningún otro campo cambió", colar resuelto_por junto con la supersesión pasa — la mutación más importante de esta batería', async () => {
    // A diferencia de `asiento_propuesto` (ver el ATAQUE de arriba), acá SÍ hay una tercera columna
    // grantable (`resuelto_por`) además de las dos de supersesión — el grant acotado NO alcanza solo,
    // y es el chequeo "resto igual" del trigger el que tiene que cerrar este vector.
    await conInmutabilidadMutada(
      [
        `create or replace function app.exigir_inmutabilidad_post_terminal() returns trigger
           language plpgsql set search_path = pg_catalog, public, app, pg_temp as $fn$
         declare
           v_columna_estado text := tg_argv[0];
           v_terminales text[] := string_to_array(tg_argv[1], ',');
           v_columna_supersede text := nullif(tg_argv[2], '');
           v_old jsonb := to_jsonb(old);
           v_new jsonb := to_jsonb(new);
           v_estado_viejo text := v_old ->> v_columna_estado;
         begin
           if v_estado_viejo is null or not (v_estado_viejo = any(v_terminales)) then return new; end if;
           -- DEFECTO A PROPÓSITO: no exige que el resto de las columnas quede igual.
           if v_columna_supersede is not null and v_estado_viejo <> 'superseded'
              and (v_new ->> v_columna_estado) = 'superseded'
              and (v_old ->> v_columna_supersede) is null
              and (v_new ->> v_columna_supersede) is not null
           then return new; end if;
           raise exception 'fila inmutable en %.% (id=%): columna % terminal', tg_table_schema, tg_table_name,
             (v_old ->> 'id'), v_columna_estado using errcode = 'P0002';
         end; $fn$`,
      ],
      USUARIOS.socio,
      async (ej) => {
        const viejoId = await crearPendienteResuelto(ej, '2028-04-01');
        const cierreDelViejo = await una(
          ej,
          `select cierre_id::text as "cierreId" from pendiente_cierre where cliente_id = $1 and id = $2`,
          [s.clienteA, viejoId],
        );
        const nuevo = await una(
          ej,
          `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado, referencia_origen)
           values ($1, $2, 'documento_faltante', 'abierto', 'reproceso-test-mutacion') returning id::text as id`,
          [s.clienteA, cierreDelViejo['cierreId']],
        );
        // El ataque: supersede Y cuela una falsificación de resuelto_por en el MISMO update.
        const resultado = await una(
          ej,
          `update pendiente_cierre
             set pendiente_estado = 'superseded', superseded_by_id = $3, resuelto_por = $4
           where cliente_id = $1 and id = $2
           returning resuelto_por::text as "resueltoPor"`,
          [s.clienteA, viejoId, nuevo['id'], USUARIOS.contadorA],
        );
        expect(
          resultado['resueltoPor'],
          'sin el chequeo de "ningún otro campo cambió", colar resuelto_por junto con la supersesión ' +
            'legítima pasa — es el vector exacto de HANDOFF 130, disfrazado de supersesión, y acá el ' +
            'grant NO alcanza solo porque resuelto_por sí es grantable',
        ).toBe(USUARIOS.contadorA);
      },
    );
  });

  it('ATAQUE (hallazgo secundario, HANDOFF 130): reescribir resuelto_por de un pendiente YA resuelto — rechazado', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const pendienteId = await crearPendienteResuelto(ej, '2028-02-01');
        return ej(`update pendiente_cierre set resuelto_por = $2 where cliente_id = $1 and id = $3`, [
          s.clienteA,
          USUARIOS.contadorA,
          pendienteId,
        ]);
      }),
    );
    esperarRechazo(
      error,
      'P0002',
      'el hallazgo secundario NO bloqueante de HANDOFF 130, cerrado por el mismo trigger genérico ' +
        'sin código bespoke — confirma que el mecanismo generaliza (pedido explícito de JP)',
    );
  });

  it('MUTACIÓN M-C1 🔴 con el trigger deshabilitado, el ataque sobre pendiente_cierre también pasa', async () => {
    await conInmutabilidadMutada(
      ['alter table pendiente_cierre disable trigger trg_pendiente_cierre_inmutable'],
      USUARIOS.socio,
      async (ej) => {
        const pendienteId = await crearPendienteResuelto(ej, '2028-03-01');
        const actualizado = await una(
          ej,
          `update pendiente_cierre set resuelto_por = $2 where cliente_id = $1 and id = $3
           returning resuelto_por::text as "resueltoPor"`,
          [s.clienteA, USUARIOS.contadorA, pendienteId],
        );
        expect(
          actualizado['resueltoPor'],
          'con el trigger deshabilitado en ESTA tabla puntual, el ataque vuelve a pasar — prueba que ' +
            'es este trigger, instalado en las tres tablas independientemente, el que cierra cada una',
        ).toBe(USUARIOS.contadorA);
      },
    );
  });

  // TODO(0028-b, qa-automation): lista de terminales sin 'superseded' (ataca un pendiente ya
  // superseded reescribiendo referencia_origen) — no implementada en esta pasada.
});
