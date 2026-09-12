/**
 * MUTACIONES de `0043_confirmacion_grupo.sql` — prueba por mutación de los invariantes NUEVOS de esta
 * migración (CLAUDE.md §1.8, ADR-0002 §B.0): código defectuoso que la pone roja, su caso legítimo,
 * conteo declarado. No repite la plantilla de siete renglones (`catalogo.test.ts`/
 * `grants-conjunto-cerrado.test.ts` la cubren genéricamente); cubre lo específico de este esquema:
 *
 *   A. `confirmacion_grupo_respaldo_chk` — piso de longitud (15) sobre `respaldo`.
 *   B. `uq_confirmacion_grupo_vigente` — a lo sumo una confirmación ABIERTA por (cliente, banco,
 *      concepto_normalizado), SECUENCIAL (mismo patrón que 0030 C).
 *   C. 🔴 LA CARRERA, EN VIVO con dos conexiones reales, sin `pg_sleep` — exactamente lo que pidió JP
 *      (2026-09-12): reproducir la carrera SIN el índice (se cuela, bug real) y CON el índice (no se
 *      cuela), igual que `mutaciones-0042.test.ts` M1/M2 para `padron_manifestacion`.
 *
 *                                                                              ─────────────────────
 *                                                                              4 mutaciones, 3 legítimos
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, con `0043` aplicada. Corre SOLO
 * contra LOCAL — la mutación de esquema (C) se niega a correr fuera de `local` (mismo guard que
 * `conIndiceMutado` de `mutaciones-0042.test.ts`).
 */

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
    return { code: err.code ?? '(sin code)', constraint: err.constraint ?? null, message: err.message ?? String(e) };
  }
}

function esperarRechazo(actual: ErrorPg, code: string, constraint: string | null, porque: string): void {
  expect({ code: actual.code, constraint: actual.constraint }, porque).toEqual({ code, constraint });
}

/** `USUARIOS.socio` tiene membresía en A y en B — mismo criterio que `mutaciones-0030-...`. */
function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

let s: Sembrado;
const BANCO = 'banco_0043';

beforeAll(async () => {
  s = await sembrar();
  // `banco` es catálogo N0 sin RLS/policy — app_request no tiene grants (0004, deliberado). Se siembra
  // con el dueño del esquema, mismo criterio que `mutaciones-0036-...test.ts`.
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ($1, 'BANCO DE PRUEBA 0043') on conflict do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

async function crearCuenta(ej: Ejecutar, clienteId: string): Promise<string> {
  const f = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [clienteId]);
  return String(f['id']);
}

async function confirmar(
  ej: Ejecutar,
  clienteId: string,
  cuentaId: string,
  concepto: string,
  respaldo = 'respaldo de prueba válido',
): Promise<Fila> {
  return una(
    ej,
    `insert into confirmacion_grupo (cliente_id, banco_codigo, concepto_banco, cuenta_id, respaldo, confirmado_por)
     values ($1, $2, $3, $4, $5, $6)
     returning id::text as id`,
    [clienteId, BANCO, concepto, cuentaId, respaldo, USUARIOS.socio],
  );
}

// =============================================================================
// A — `confirmacion_grupo_respaldo_chk` (1 mutación, 1 legítimo)
// =============================================================================
describe('0043 A — piso de longitud sobre `respaldo` (>= 15)', () => {
  it('M-A1 🔴 respaldo de 14 caracteres muere por el CHECK', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuentaId = await crearCuenta(ej, s.clienteA);
        return confirmar(ej, s.clienteA, cuentaId, 'concepto a1', '13 caracteres'.slice(0, 14));
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'confirmacion_grupo_respaldo_chk',
      'un respaldo de 14 caracteres no alcanza el piso mínimo — "ok" o "visto" no son una justificación',
    );
  });

  it('legítimo: respaldo de exactamente 15 caracteres entra', async () => {
    await comoSocio(async (ej) => {
      const cuentaId = await crearCuenta(ej, s.clienteA);
      const quince = 'x'.repeat(15);
      expect(quince.length).toBe(15);
      const fila = await confirmar(ej, s.clienteA, cuentaId, 'concepto a2 legitimo', quince);
      expect(fila['id']).toBeTruthy();
    });
  });
});

// =============================================================================
// B — `uq_confirmacion_grupo_vigente`, SECUENCIAL (1 mutación, 1 legítimo) — mismo patrón que 0030 C
// =============================================================================
describe('0043 B — a lo sumo una confirmación ABIERTA por (cliente, banco, concepto), secuencial', () => {
  it('M-B1 🔴 segunda confirmación ABIERTA para el mismo (cliente, banco, concepto) muere por unicidad', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuenta1 = await crearCuenta(ej, s.clienteB);
        const cuenta2 = await crearCuenta(ej, s.clienteB);
        await confirmar(ej, s.clienteB, cuenta1, 'CONCEPTO REPETIDO B1', 'primera confirmación');
        // Sin cerrar `vigente_hasta` de la primera: esta segunda es OTRA confirmación abierta para
        // el mismo (cliente, banco, concepto_normalizado) — el defecto que la regla evita.
        return confirmar(ej, s.clienteB, cuenta2, 'concepto repetido b1', 'segunda confirmación');
      }),
    );
    esperarRechazo(
      error,
      '23505',
      'uq_confirmacion_grupo_vigente',
      'dos confirmaciones abiertas a la vez para el mismo grupo dejan ambigua la cuenta que se exporta',
    );
  });

  it('legítimo: cerrar la primera (`vigente_hasta`) habilita la segunda', async () => {
    await comoSocio(async (ej) => {
      const cuenta1 = await crearCuenta(ej, s.clienteA);
      const cuenta2 = await crearCuenta(ej, s.clienteA);
      const primera = await confirmar(ej, s.clienteA, cuenta1, 'CONCEPTO SECUENCIAL B2', 'primera, legítima');

      // `clock_timestamp()`, NO `now()`: esta UPDATE corre en la MISMA transacción que el INSERT de
      // arriba, y `now()` devuelve el instante de INICIO de la transacción — sería IGUAL a
      // `confirmado_en`, no mayor, y chocaría con `confirmacion_grupo_vigencia_chk` (hallazgo real de
      // esta prueba, no hipotético: rompió en rojo antes de este fix).
      await ej(`update confirmacion_grupo set vigente_hasta = clock_timestamp() where id = $1`, [primera['id']]);

      const segunda = await confirmar(ej, s.clienteA, cuenta2, 'concepto secuencial b2', 'segunda, legítima');
      expect(segunda['id']).toBeTruthy();
    });
  });
});

// =============================================================================
// C — 🔴 LA CARRERA, EN VIVO con dos conexiones reales, sin pg_sleep (2 mutaciones: con/sin índice)
// =============================================================================
const INDICE_REAL = `
  drop index if exists uq_confirmacion_grupo_vigente;
  create unique index uq_confirmacion_grupo_vigente
    on confirmacion_grupo (cliente_id, banco_codigo, concepto_normalizado)
    where vigente_hasta is null;
`;
const SIN_INDICE = `drop index if exists uq_confirmacion_grupo_vigente;`;

async function conIndiceAlterado<T>(ddl: string, fn: () => Promise<T>): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de mutación de esquema corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  const duenio = await clienteDuenio();
  try {
    await duenio.query(ddl);
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

describe('0043 C — 🔴 dos conexiones reales confirmando el MISMO grupo al mismo tiempo', () => {
  it(
    'M-C1 🔴 SIN el índice (mutado: dropeado): las DOS entran — dos confirmaciones contradictorias conviven como vigentes',
    async () => {
      await conIndiceAlterado(SIN_INDICE, async () => {
        const cuenta1 = await comoSocio((ej) => crearCuenta(ej, s.clienteA));
        const cuenta2 = await comoSocio((ej) => crearCuenta(ej, s.clienteA));

        const [r1, r2] = await Promise.all([
          capturar(() => comoSocio((ej) => confirmar(ej, s.clienteA, cuenta1, 'CONCEPTO CARRERA C1', 'conexión real uno'))),
          capturar(() => comoSocio((ej) => confirmar(ej, s.clienteA, cuenta2, 'concepto carrera c1', 'conexión real dos'))),
        ]);

        expect(
          [r1.code, r2.code],
          'sin el índice, las dos conexiones entran — el bug real que 0043 existe para evitar',
        ).toEqual(['', '']);

        const abiertas = await comoSocio((ej) =>
          ej(
            `select count(*)::int as n from confirmacion_grupo
             where cliente_id = $1 and banco_codigo = $2 and concepto_normalizado = 'CONCEPTO CARRERA C1'
               and vigente_hasta is null`,
            [s.clienteA, BANCO],
          ),
        );
        expect(abiertas[0]?.['n'], 'dos filas vigentes y contradictorias para el mismo grupo').toBe(2);

        // Limpieza OBLIGATORIA antes de que `conIndiceAlterado` intente restaurar el índice único en
        // su `finally`: con las dos filas todavía "abiertas" y contradictorias, `create unique index`
        // no puede aplicarse sobre datos que ya la violan — hallazgo real de esta prueba (rompió en
        // rojo antes de este cierre). Cerrar una de las dos deja los datos consistentes con el índice
        // real que se restaura a continuación.
        await comoSocio((ej) =>
          ej(
            `update confirmacion_grupo set vigente_hasta = clock_timestamp()
             where cliente_id = $1 and banco_codigo = $2 and concepto_normalizado = 'CONCEPTO CARRERA C1'
               and vigente_hasta is null and cuenta_id = $3`,
            [s.clienteA, BANCO, cuenta2],
          ),
        );
      });
    },
    20_000,
  );

  it(
    'M-C2 🔴 CON el índice real: exactamente UNA de las dos entra, la otra muere 23505 — repetido 3 veces contra flakiness',
    async () => {
      for (let intento = 0; intento < 3; intento += 1) {
        const cuenta1 = await comoSocio((ej) => crearCuenta(ej, s.clienteB));
        const cuenta2 = await comoSocio((ej) => crearCuenta(ej, s.clienteB));
        const concepto = `CONCEPTO CARRERA C2 INTENTO ${intento}`;

        const [r1, r2] = await Promise.all([
          capturar(() => comoSocio((ej) => confirmar(ej, s.clienteB, cuenta1, concepto, 'conexión 1 real'))),
          capturar(() => comoSocio((ej) => confirmar(ej, s.clienteB, cuenta2, concepto.toLowerCase(), 'conexión 2 real'))),
        ]);

        const codigos = [r1.code, r2.code].sort();
        expect(
          codigos,
          `intento ${intento}: exactamente una de las dos tiene que entrar ('') y la otra morir '23505'`,
        ).toEqual(['', '23505']);

        const perdedora = r1.code === '' ? r2 : r1;
        expect(perdedora.constraint, `intento ${intento}: sobre el índice real de 0043`).toBe(
          'uq_confirmacion_grupo_vigente',
        );
      }
    },
    20_000,
  );
});
