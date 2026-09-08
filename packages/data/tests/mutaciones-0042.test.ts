/**
 * MUTACIONES de `0042_revocacion_padron_manifestacion_unica.sql` — prueba por mutación del
 * invariante NUEVO de esta migración (CLAUDE.md §1.8, ADR-0002 §B.0): a lo sumo una fila de
 * `padron_manifestacion` puede revocar la misma manifestación, POR CLIENTE.
 *
 *   L1 legítimo, SECUENCIAL: revocar X con Y1 (entra) → un segundo intento de revocar X con Y2
 *      muere 23505, sin necesitar concurrencia ................................ 0 mutaciones, 1 legítimo
 *   L2 legítimo, CONCURRENTE (control negativo): revocar dos manifestaciones DISTINTAS (X1, X2) al
 *      mismo tiempo — las dos entran, el índice no bloquea escrituras no conflictivas .. 1 legítimo
 *   M1 🔴 mutación EN VIVO, dos conexiones reales: las DOS intentan revocar la MISMA X al mismo
 *      tiempo — sin el índice, ambas podrían entrar (dos cadenas vivas simultáneas); con el
 *      índice real, exactamente una entra y la otra muere 23505 (repetido 3 veces) ....... 1 mutación
 *   M2 🔴 mutación de ESQUEMA (no de función): con un índice MUTADO — `unique (revoca_a)`, SIN
 *      `cliente_id` — un cliente A puede distinguir por el CÓDIGO DE ERROR (23505 vs 23503) si la
 *      manifestación de OTRO cliente B ya fue revocada, sin tener acceso a B (oráculo cross-tenant,
 *      hallazgo de `security-engineer`). Con el índice REAL (compuesto), el mismo intento SIEMPRE
 *      da 23503, nunca distingue ................................................. 1 mutación, 1 legítimo
 *                                                                              ─────────────────────
 *                                                                              3 mutaciones, 3 legítimos, 5 `it`
 *
 * ## Por qué no hace falta `pg_sleep` (a diferencia de `mutaciones-0041.test.ts`)
 *
 * `0041` probaba una carrera CHECK-THEN-ACT en PL/pgSQL (leer, dormir, decidir) — necesitaba forzar
 * el entrelazado a mano. Un índice único no tiene esa ventana: Postgres toma el "value lock" de la
 * clave AL INSERTAR, antes de decidir si hay conflicto — dos conexiones reales, sin sleep, ya
 * alcanzan para que el mecanismo se ejerza de verdad (dba-data, convocatoria 2026-09-08).
 *
 * ## Por qué M2 muta el ESQUEMA, no una función
 *
 * `0042` no tiene función/trigger que mutar (es un índice puro) — la mutación real es el DDL del
 * propio índice. Se aplica una VARIANTE del índice (mismo nombre, sin `cliente_id`) con
 * `create unique index concurrently` reemplazado por un `drop`+`create` autocommit, se corre el
 * escenario, y se restaura el índice REAL en un `finally` — mismo espíritu que
 * `conFuncionCommitteada` de `mutaciones-0040.test.ts`/`mutaciones-0041.test.ts`, aplicado a un
 * índice en vez de una función.
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, con `0042` APLICADA.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

// -----------------------------------------------------------------------------
// Andamio mínimo — mismo estilo que `mutaciones-0041.test.ts`, duplicado a propósito (conteo de
// mutaciones propio, no compartido).
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

type ErrorPg = { readonly code: string; readonly constraint: string; readonly message: string };
async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return { code: '', constraint: '', message: '(no falló)' };
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string };
    return { code: err.code ?? '', constraint: err.constraint ?? '', message: err.message ?? '' };
  }
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

async function crearManifestacion(
  ej: Ejecutar,
  clienteId: string,
  revocaA: string | null = null,
): Promise<string> {
  const f = revocaA
    ? await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta, revoca_a)
         values ($1, '2026-09-30'::date, $2) returning id::text as id`,
        [clienteId, revocaA],
      )
    : await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta)
         values ($1, '2026-06-30'::date) returning id::text as id`,
        [clienteId],
      );
  return String(f['id']);
}

// =============================================================================
// L1 — legítimo, SECUENCIAL, sin concurrencia (0 mutaciones, 1 legítimo)
// =============================================================================
describe('0042 L1 — secuencial: revocar X entra, un segundo intento de revocar X muere 23505', () => {
  it('L1 revocar X con Y1 entra; revocar X de nuevo con Y2 muere 23505 sobre uq_padron_manifestacion_revoca_a', async () => {
    const manX = await comoSocio((ej) => crearManifestacion(ej, s.clienteA));

    const y1 = await comoSocio((ej) => crearManifestacion(ej, s.clienteA, manX));
    expect(y1, 'la primera revocación de X tiene que entrar').toBeTruthy();

    const error = await capturar(() => comoSocio((ej) => crearManifestacion(ej, s.clienteA, manX)));
    expect(error.code, 'una segunda revocación de la MISMA X tiene que morir por unique_violation').toBe('23505');
    expect(error.constraint, 'sobre el índice de 0042 específicamente').toBe('uq_padron_manifestacion_revoca_a');
  });
});

// =============================================================================
// L2 — legítimo, CONCURRENTE: control negativo (1 legítimo)
// =============================================================================
describe('0042 L2 — concurrente, control negativo: revocar DOS manifestaciones distintas al mismo tiempo, las dos entran', () => {
  it('L2 dos conexiones revocando X1 y X2 (distintas) en simultáneo: ninguna bloquea a la otra', async () => {
    const x1 = await comoSocio((ej) => crearManifestacion(ej, s.clienteA));
    const x2 = await comoSocio((ej) => crearManifestacion(ej, s.clienteA));

    const [r1, r2] = await Promise.all([
      capturar(() => comoSocio((ej) => crearManifestacion(ej, s.clienteA, x1))),
      capturar(() => comoSocio((ej) => crearManifestacion(ej, s.clienteA, x2))),
    ]);

    expect(r1.code, 'revocar X1 tiene que entrar, sin relación con X2').toBe('');
    expect(r2.code, 'revocar X2 tiene que entrar, sin relación con X1').toBe('');
  });
});

// =============================================================================
// M1 — 🔴 LA CARRERA, EN VIVO con dos conexiones reales, sin pg_sleep (1 mutación)
// =============================================================================
describe('0042 M1 — 🔴 dos conexiones reales revocando la MISMA manifestación al mismo tiempo', () => {
  it(
    'M1 exactamente UNA de las dos entra; la otra muere 23505 — repetido 3 veces contra flakiness',
    async () => {
      for (let intento = 0; intento < 3; intento += 1) {
        const manX = await comoSocio((ej) => crearManifestacion(ej, s.clienteA));

        const [r1, r2] = await Promise.all([
          capturar(() => comoSocio((ej) => crearManifestacion(ej, s.clienteA, manX))),
          capturar(() => comoSocio((ej) => crearManifestacion(ej, s.clienteA, manX))),
        ]);

        const codigos = [r1.code, r2.code].sort();
        expect(
          codigos,
          `intento ${intento}: exactamente una de las dos tiene que entrar ('') y la otra morir '23505'`,
        ).toEqual(['', '23505']);

        const ganadora = r1.code === '' ? r1 : r2;
        const perdedora = r1.code === '' ? r2 : r1;
        expect(perdedora.constraint, `intento ${intento}: sobre el índice de 0042`).toBe(
          'uq_padron_manifestacion_revoca_a',
        );
        void ganadora;
      }
    },
    20_000,
  );
});

// =============================================================================
// M2 — 🔴 MUTACIÓN DE ESQUEMA: índice sin `cliente_id` reabre un oráculo cross-tenant (1 mutación,
// 1 legítimo)
// =============================================================================
const INDICE_REAL = `
  drop index if exists uq_padron_manifestacion_revoca_a;
  create unique index uq_padron_manifestacion_revoca_a
    on padron_manifestacion (cliente_id, revoca_a)
    where revoca_a is not null;
`;
const INDICE_MUTADO_SIN_CLIENTE = `
  drop index if exists uq_padron_manifestacion_revoca_a;
  create unique index uq_padron_manifestacion_revoca_a
    on padron_manifestacion (revoca_a)
    where revoca_a is not null;
`;

async function conIndiceMutado<T>(ddlMutante: string, fn: () => Promise<T>): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de mutación de esquema corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  const duenio = await clienteDuenio();
  try {
    await duenio.query(ddlMutante);
  } finally {
    await duenio.end();
  }
  try {
    return await fn();
  } finally {
    const restaurador = await clienteDuenio();
    try {
      await restaurador.query(INDICE_REAL);
    } finally {
      await restaurador.end();
    }
  }
}

describe('0042 M2 — 🔴 sin cliente_id, el índice es un oráculo cross-tenant (mutación de esquema)', () => {
  it(
    'M2 con el índice MUTADO (sin cliente_id): A distingue por el código de error si la manifestación YA REVOCADA de B está revocada',
    async () => {
      await conIndiceMutado(INDICE_MUTADO_SIN_CLIENTE, async () => {
        // B revoca su propia manifestación W (legítimo, cliente_id = B en las dos filas).
        const manW = await comoSocio((ej) => crearManifestacion(ej, s.clienteB));
        await comoSocio((ej) => crearManifestacion(ej, s.clienteB, manW));

        // A intenta "revocar" W (adivinando su id) — bajo cliente_id = A. Con el índice MUTADO
        // (global sobre `revoca_a`), la fila de B ya "gastó" el valor de W: A choca con 23505 —
        // ANTES de que la FK (que sí exige cliente_id = B) tenga oportunidad de rechazar por
        // 23503. El código de error revela que W ya está revocada, sin que A tenga acceso a B.
        const intentoA = await capturar(() => comoSocio((ej) => crearManifestacion(ej, s.clienteA, manW)));
        expect(
          intentoA.code,
          'con el índice mutado (sin cliente_id), el intento cross-tenant choca con el índice ' +
            'GLOBAL antes que con la FK — revela, por el código de error, que W ya fue revocada',
        ).toBe('23505');
      });
    },
    20_000,
  );

  it(
    'L2-mecanismo con el índice REAL (compuesto): el mismo intento SIEMPRE da 23503 — nunca revela nada',
    async () => {
      // Sin envolver en conIndiceMutado: corre contra el índice REAL, tal como quedó en 0042.
      const manW = await comoSocio((ej) => crearManifestacion(ej, s.clienteB));
      await comoSocio((ej) => crearManifestacion(ej, s.clienteB, manW));

      const intentoA = await capturar(() => comoSocio((ej) => crearManifestacion(ej, s.clienteA, manW)));
      expect(
        intentoA.code,
        'con el índice real (cliente_id, revoca_a), (cliente_id=A, revoca_a=W) nunca colisiona ' +
          '— cae siempre en la FK (23503), sin importar si W está revocada o no',
      ).toBe('23503');
      expect(intentoA.constraint, 'la FK que ya impedía citar la manifestación de OTRO cliente').toBe(
        'fk_padron_manifestacion_revoca',
      );
    },
    20_000,
  );
});
