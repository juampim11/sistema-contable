/**
 * MUTACIONES de `0029_pendiente_cierre_reproceso.sql` — prueba por mutación de la regla verificable
 * NUEVA de esta migración (CLAUDE.md §1.8): `uq_pendiente_cierre_natural` pasa a índice parcial
 * (`WHERE superseded_by_id IS NULL`) + `fk_pendiente_cierre_superseded` pasa a `DEFERRABLE INITIALLY
 * DEFERRED`. Cierra B.8 (`docs/diseno/10-deuda-declarada.md`), acotado a `pendiente_cierre` por
 * decisión explícita de JP (2026-08-30) — `documento_ingerido`/`expectativa_fuente_cliente`/
 * `fuente_cierre` quedan declaradas aparte como B.9, sin tocar.
 *
 * Archivo separado de `mutaciones-0028-inmutabilidad-post-terminal.test.ts` a propósito: prueba una
 * regla DISTINTA (unicidad de clave natural bajo supersesión, no inmutabilidad post-terminal), con su
 * propia migración. Ese archivo sí se editó (el test legítimo de supersesión de `pendiente_cierre`
 * dejó de necesitar el workaround de `referencia_origen` distinto) para probar el caso real ahora que
 * `0029` lo permite — no se duplica acá esa edición, este archivo agrega su propia batería.
 *
 * ## Qué prueba esto
 *
 * El fix tiene DOS componentes, y la batería prueba que hacen falta los DOS (`dba-data`, convocatoria
 * de B.8): el índice parcial solo no alcanza si el `id` de la fila nueva no existe todavía cuando el
 * `UPDATE` de la vieja la referencia — hace falta la FK diferida.
 *
 * ## Cobertura declarada de esta primera pasada (CLAUDE.md §1.8: conteo explícito)
 *
 * 3 legítimos (incluido el caso cross-tenant) + 1 ataque real (duplicado activo) + 2 mutaciones de
 * refutación (una por componente del fix) — 6 `it()` (contado con `grep -c '  it('`, ajustando el
 * falso positivo de esta misma línea de comentario si aplica).
 *
 * 🔴 **Mutación deliberadamente NO incluida, con su motivo**: "el índice sin `cliente_id` permite
 * colisión cross-tenant" no es construible como caso que discrimine en ESTE esquema — `cierre_id` es
 * `not null` y está atado a un único `cliente_id` por la FK compuesta `fk_pendiente_cierre_cierre`
 * (`cliente_id, cierre_id` → `cierre_cliente_periodo(cliente_id, id)`), así que dos clientes nunca
 * pueden compartir el mismo `cierre_id` — `cierre_id` ya garantiza la partición por tenant
 * independientemente de si `cliente_id` está en el índice. Quitar `cliente_id` del índice no cambiaría
 * ningún resultado observable, así que un test que lo mutara no se pondría rojo con el defecto
 * presente — no sería una mutación que discrimina (ADR-0002 §B.0: elegidas para refutar, no para
 * simular refutación). `cliente_id` se mantiene en el índice por la regla dura de `CLAUDE.md` §1.2
 * ("unicidades siempre por cliente, nunca globales"), no porque haga falta acá para cerrar un vector de
 * ataque real.
 *
 * Requisito previo: `0029` aplicada a local.
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
// El laboratorio de mutación — mismo patrón que `mutaciones-0028-...test.ts`
// (`conInmutabilidadMutada`), adaptado a índice/FK en vez de trigger/función.
// -----------------------------------------------------------------------------

async function huella(ej: Ejecutar): Promise<Record<string, string>> {
  const idx = await una(
    ej,
    `select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'pendiente_cierre'
        and indexname = 'uq_pendiente_cierre_natural'`,
  );
  const fk = await una(
    ej,
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'fk_pendiente_cierre_superseded' and conrelid = 'pendiente_cierre'::regclass`,
  );
  return { indice: String(idx['indexdef']), fk: String(fk['def']) };
}

async function conUniqueMutada<T>(
  ddl: readonly string[],
  usuarioId: string,
  fn: (ej: Ejecutar) => Promise<T>,
): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(
      `Las pruebas de mutación de 0029 corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`,
    );
  }
  const duenio = await clienteDuenio();
  const ejDuenio = desdeCliente(duenio);
  try {
    await duenio.query('begin');
    const antes = await huella(ejDuenio);
    let resultado: T;
    try {
      for (const sentencia of ddl) await duenio.query(sentencia);
      await duenio.query('set local role app_request');
      await duenio.query(`select set_config('app.user_id', $1, true)`, [usuarioId]);
      resultado = await fn(ejDuenio);
    } catch (error) {
      // Cualquier falla acá (el DDL mismo, el cambio de rol, o el ataque) deja la transacción del
      // dueño posiblemente abortada — `rollback` es el único comando válido en ese estado, nunca
      // `reset role`. Se relanza el error original, no uno nuevo del `rollback`.
      await duenio.query('rollback');
      throw error;
    }
    await duenio.query('reset role');
    await duenio.query('rollback');
    const despues = await huella(ejDuenio);
    expect(despues, 'el rollback de la mutación NO restauró el índice/FK a su forma original').toEqual(antes);
    return resultado;
  } finally {
    await duenio.end();
  }
}

async function crearCierre(ej: Ejecutar, clienteId: string, periodo: string): Promise<string> {
  const cierre = await una(
    ej,
    `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
     values ($1, 'mensual', $2, $2::date + interval '1 month' - interval '1 day')
     returning id::text as id`,
    [clienteId, periodo],
  );
  return String(cierre['id']);
}

async function crearPendienteTerminal(ej: Ejecutar, clienteId: string, cierreId: string): Promise<string> {
  const pendiente = await una(
    ej,
    `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
     values ($1, $2, 'documento_faltante', 'abierto') returning id::text as id`,
    [clienteId, cierreId],
  );
  await ej(
    `update pendiente_cierre set pendiente_estado = 'resuelto', resuelto_por = $2, resuelto_en = now()
     where cliente_id = $1 and id = $3`,
    [clienteId, USUARIOS.socio, pendiente['id']],
  );
  return String(pendiente['id']);
}

/** El flujo real de reproceso: UPDATE-vieja-primero (id generado por la app), INSERT-nueva-después. */
async function reprocesar(
  ej: Ejecutar,
  clienteId: string,
  viejoId: string,
  cierreId: string,
  referenciaOrigen: string | null,
): Promise<{ nuevoId: string }> {
  const nuevoId = randomUUID();
  await una(
    ej,
    `update pendiente_cierre set pendiente_estado = 'superseded', superseded_by_id = $3
     where cliente_id = $1 and id = $2 and superseded_by_id is null
     returning pendiente_estado as "pendienteEstado"`,
    [clienteId, viejoId, nuevoId],
  );
  await una(
    ej,
    `insert into pendiente_cierre (id, cliente_id, cierre_id, motivo_codigo, pendiente_estado, referencia_origen)
     values ($1, $2, $3, 'documento_faltante', 'abierto', $4) returning id::text as id`,
    [nuevoId, clienteId, cierreId, referenciaOrigen],
  );
  return { nuevoId };
}

describe('0029 — pendiente_cierre: reproceso con la misma clave natural que la fila superseded', () => {
  it('legítimo: reproceso con clave natural idéntica (referencia_origen null en ambas)', async () => {
    await comoSocio(async (ej) => {
      const cierreId = await crearCierre(ej, s.clienteA, '2029-01-01');
      const viejoId = await crearPendienteTerminal(ej, s.clienteA, cierreId);
      const { nuevoId } = await reprocesar(ej, s.clienteA, viejoId, cierreId, null);
      const fila = await una(
        ej,
        `select pendiente_estado as "pendienteEstado" from pendiente_cierre where cliente_id = $1 and id = $2`,
        [s.clienteA, nuevoId],
      );
      expect(fila['pendienteEstado']).toBe('abierto');
    });
  });

  it('legítimo: regresión — reproceso con referencia_origen distinta sigue funcionando', async () => {
    await comoSocio(async (ej) => {
      const cierreId = await crearCierre(ej, s.clienteA, '2029-02-01');
      const viejoId = await crearPendienteTerminal(ej, s.clienteA, cierreId);
      const { nuevoId } = await reprocesar(ej, s.clienteA, viejoId, cierreId, 'reproceso-distinto');
      const fila = await una(
        ej,
        `select referencia_origen as "referenciaOrigen" from pendiente_cierre where cliente_id = $1 and id = $2`,
        [s.clienteA, nuevoId],
      );
      expect(fila['referenciaOrigen']).toBe('reproceso-distinto');
    });
  });

  it('legítimo: dos clientes distintos con la misma forma de clave natural coexisten sin choque', async () => {
    await comoSocio(async (ej) => {
      const cierreA = await crearCierre(ej, s.clienteA, '2029-03-01');
      const cierreB = await crearCierre(ej, s.clienteB, '2029-03-01');
      const pendienteA = await una(
        ej,
        `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
         values ($1, $2, 'documento_faltante', 'abierto') returning id::text as id`,
        [s.clienteA, cierreA],
      );
      const pendienteB = await una(
        ej,
        `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
         values ($1, $2, 'documento_faltante', 'abierto') returning id::text as id`,
        [s.clienteB, cierreB],
      );
      expect(pendienteA['id']).not.toBe(pendienteB['id']);
    });
  });

  it('ATAQUE: duplicado activo — dos filas SIN relación de supersesión y la misma clave natural — rechazado', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cierreId = await crearCierre(ej, s.clienteA, '2029-04-01');
        await ej(
          `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
           values ($1, $2, 'documento_faltante', 'abierto')`,
          [s.clienteA, cierreId],
        );
        // Segunda fila, misma clave natural completa, sin superseder la primera — tiene que seguir
        // chocando: el índice parcial no abre la puerta a duplicados activos genuinos.
        return ej(
          `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
           values ($1, $2, 'documento_faltante', 'abierto')`,
          [s.clienteA, cierreId],
        );
      }),
    );
    esperarRechazo(error, '23505', 'un segundo pendiente ACTIVO con la misma clave natural tiene que seguir rechazado');
  });

  it('MUTACIÓN 🔴 índice sin predicado parcial (estado real de B.8 antes de 0029): reconstruirlo ya falla contra datos reales', async () => {
    // El error no aparece recién en el INSERT de un caso nuevo: para este punto del archivo ya hay,
    // commiteada, una fila superseded y su reemplazo con la MISMA clave natural (el caso legítimo de
    // más arriba) — reconstruir el índice SIN predicado parcial choca contra esos datos reales de
    // inmediato, antes de que este test inserte una sola fila propia. Evidencia más directa todavía
    // del síntoma real de B.8 que un INSERT aislado.
    const error = await capturar(() =>
      conUniqueMutada(
        [
          'drop index uq_pendiente_cierre_natural',
          `create unique index uq_pendiente_cierre_natural
             on pendiente_cierre (cliente_id, cierre_id, fuente_cierre_id, referencia_origen, motivo_codigo)
             nulls not distinct`,
        ],
        USUARIOS.socio,
        async (ej) => {
          const cierreId = await crearCierre(ej, s.clienteA, '2029-05-01');
          const viejoId = await crearPendienteTerminal(ej, s.clienteA, cierreId);
          await reprocesar(ej, s.clienteA, viejoId, cierreId, null);
        },
      ),
    );
    esperarRechazo(
      error,
      '23505',
      'sin el predicado parcial, cualquier par superseded+reemplazo con la misma clave natural (los ' +
        'hay commiteados en este archivo desde el caso legítimo) hace fallar la reconstrucción del ' +
        'índice mismo — reproduce el síntoma real de B.8',
    );
  });

  it('MUTACIÓN 🔴 FK sin deferrable: el UPDATE de la fila vieja falla, no llega a intentar el INSERT', async () => {
    const error = await capturar(() =>
      conUniqueMutada(
        [
          'alter table pendiente_cierre drop constraint fk_pendiente_cierre_superseded',
          `alter table pendiente_cierre add constraint fk_pendiente_cierre_superseded
             foreign key (cliente_id, superseded_by_id) references pendiente_cierre (cliente_id, id)
             on delete restrict`,
        ],
        USUARIOS.socio,
        async (ej) => {
          const cierreId = await crearCierre(ej, s.clienteA, '2029-06-01');
          const viejoId = await crearPendienteTerminal(ej, s.clienteA, cierreId);
          await reprocesar(ej, s.clienteA, viejoId, cierreId, null);
        },
      ),
    );
    esperarRechazo(
      error,
      '23503',
      'sin DEFERRABLE, el UPDATE que fija superseded_by_id a un id que todavía no es una fila viola ' +
        'la FK de inmediato — confirma que el segundo componente del fix no es cosmético',
    );
  });
});
