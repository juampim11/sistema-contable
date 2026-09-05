/**
 * MUTACIONES de `0037_padron_contraparte.sql` — prueba por mutación de los invariantes NUEVOS de
 * esta migración (CLAUDE.md §1.8, ADR-0002 §B.0): código/DDL defectuoso que la pone roja, su caso
 * legítimo, conteo declarado. No repite la cobertura genérica de la plantilla de siete renglones
 * (eso ya lo mide `catalogo.test.ts`/`grants-conjunto-cerrado.test.ts`); cubre lo específico de esta
 * tabla:
 *
 *   A. `padron_contraparte_clasificacion_chk` — dominio cerrado ................ 1 mutación, 1 legítimo
 *   B. `padron_contraparte_vigencia_chk` — semiabierta estricta ................ 1 mutación, 1 legítimo
 *   C. `padron_contraparte_patron_sin_documento_chk` — el hallazgo de           1 mutación de DDL
 *      `security-engineer`: LIVE, con el regex vulnerable original             (vulnerable→rechaza
 *      restaurado y comparado, más el rechazo real y el legítimo                el corregido), 2 legítimos
 *   D. Poscondición de normalización (mayúscula/recortado/espacios/vacío) ...... 4 mutaciones
 *   E. R6/R40 — mismo patrón en dos clientes distintos no colisiona ........... 1 legítimo
 *   F. `uq_padron_contraparte_vigente` — una sola vigencia abierta por patrón .. 1 mutación, 1 legítimo
 *   G. `fk_asiento_renglon_contraparte` — FK COMPUESTA (hallazgo F1 de          1 mutación de DDL
 *      `seguridad-datos-financieros`/`security-engineer`): sin ella, un        (FK simple deja
 *      renglón de un cliente podría citar el patrón de OTRO                    pasar cross-tenant), 1 legítimo
 *                                                                               ─────────────────────
 *                                                                               9 mutaciones, 8 legítimos
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, con `0037` APLICADA.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
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
    return { code: err.code ?? '(sin code)', constraint: err.constraint ?? null, message: err.message ?? String(e) };
  }
}

/** Aserción exacta: código SQLSTATE y nombre del constraint, los dos — nunca `rejects.toThrow()` a secas. */
function esperarRechazo(actual: ErrorPg, code: string, constraint: string, porque: string): void {
  expect({ code: actual.code, constraint: actual.constraint }, porque).toEqual({ code, constraint });
}

/** `USUARIOS.socio` tiene membresía en A y en B — mismo criterio que `mutaciones-0027.test.ts`. */
function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

// -----------------------------------------------------------------------------
// El laboratorio de mutación de DDL — mismo mecanismo que `mutaciones-0021.test.ts`: transacción del
// dueño, SIEMPRE rollbackeada, con verificación de que el rollback restauró la definición original.
// -----------------------------------------------------------------------------
async function conDuenio<T>(fn: (ej: Ejecutar, crudo: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de mutación de DDL corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  const duenio = await clienteDuenio();
  const ej = desdeCliente(duenio);
  const crudo = (sql: string): Promise<unknown> => duenio.query(sql);
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

async function definicionDe(ej: Ejecutar, conname: string): Promise<string | undefined> {
  const filas = await ej(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [conname]);
  return filas[0] ? String(filas[0]['def']) : undefined;
}

async function conDdlMutado<T>(
  constraint: string,
  ddl: readonly string[],
  fn: (ej: Ejecutar, crudo: (sql: string) => Promise<unknown>) => Promise<T>,
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

let s: Sembrado;
let seq = 0;
/** Un patrón sintético único por test, para no chocar con `uq_padron_contraparte_vigente` entre casos. */
function patronSintetico(): string {
  seq += 1;
  return `PROVEEDOR SINTETICO ${seq}`;
}

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

async function altaContraparte(
  ej: Ejecutar,
  clienteId: string,
  cambios: Partial<{ patron: string; clasificacion: string; vigenteDesde: string; vigenteHasta: string | null }> = {},
): Promise<Fila> {
  const c = {
    patron: patronSintetico(),
    clasificacion: 'proveedor',
    vigenteDesde: '2026-01-01',
    vigenteHasta: null as string | null,
    ...cambios,
  };
  return una(
    ej,
    `insert into padron_contraparte (cliente_id, patron, clasificacion, vigente_desde, vigente_hasta)
     values ($1, $2, $3, $4::date, $5::date)
     returning id::text as id`,
    [clienteId, c.patron, c.clasificacion, c.vigenteDesde, c.vigenteHasta],
  );
}

// =============================================================================
// A — `padron_contraparte_clasificacion_chk` (1 mutación, 1 legítimo)
// =============================================================================
describe('0037 A — dominio cerrado de `clasificacion`', () => {
  it('M-A1 🔴 un valor fuera de proveedor|cliente|otro muere por el CHECK', async () => {
    const error = await capturar(() => comoSocio((ej) => altaContraparte(ej, s.clienteA, { clasificacion: 'socio' })));
    esperarRechazo(error, '23514', 'padron_contraparte_clasificacion_chk', 'clasificacion="socio" no es un valor del dominio cerrado');
  });

  it('legítimo: los tres valores del dominio entran', async () => {
    await comoSocio(async (ej) => {
      for (const clasificacion of ['proveedor', 'cliente', 'otro']) {
        const f = await altaContraparte(ej, s.clienteA, { clasificacion });
        expect(f['id']).toBeTruthy();
      }
    });
  });
});

// =============================================================================
// B — `padron_contraparte_vigencia_chk` (1 mutación, 1 legítimo)
// =============================================================================
describe('0037 B — vigencia semiabierta estricta', () => {
  it('M-B1 🔴 vigente_hasta = vigente_desde (mismo día) muere por el CHECK', async () => {
    const error = await capturar(() =>
      comoSocio((ej) => altaContraparte(ej, s.clienteA, { vigenteDesde: '2026-03-01', vigenteHasta: '2026-03-01' })),
    );
    esperarRechazo(error, '23514', 'padron_contraparte_vigencia_chk', '[d,d) es un intervalo que ninguna fecha satisface');
  });

  it('legítimo: vigente_hasta > vigente_desde entra', async () => {
    await comoSocio(async (ej) => {
      const f = await altaContraparte(ej, s.clienteA, { vigenteDesde: '2026-03-01', vigenteHasta: '2026-03-02' });
      expect(f['id']).toBeTruthy();
    });
  });
});

// =============================================================================
// C — `padron_contraparte_patron_sin_documento_chk` — el hallazgo de `security-engineer`
// =============================================================================
describe('0037 C — guardia anti-documento en `patron` (corregido por security-engineer)', () => {
  const CUIT_CON_SEPARADORES_DE_MILES = 'PROVEEDOR 30.712.345.678 SA'; // sintético: NO es un CUIT real
  const REGEX_VULNERABLE_ORIGINAL = "patron !~ '[0-9]{7}'"; // la forma que padron_socio ya usa hoy

  it(
    'M-C1 🔴 EN VIVO: con el regex ORIGINAL (solo dígitos consecutivos), un CUIT partido en bloques ' +
      'de miles EVADE el guardia — se agrega la versión vulnerable, se confirma que la fila ENTRA, se ' +
      'restaura la definición real al salir',
    async () => {
      const entro = await conDdlMutado(
        'padron_contraparte_patron_sin_documento_chk',
        [
          'alter table padron_contraparte drop constraint padron_contraparte_patron_sin_documento_chk',
          `alter table padron_contraparte add constraint padron_contraparte_patron_sin_documento_chk check (${REGEX_VULNERABLE_ORIGINAL})`,
        ],
        async (ej) => {
          const f = await altaContraparte(ej, s.clienteA, { patron: CUIT_CON_SEPARADORES_DE_MILES });
          return Boolean(f['id']);
        },
      );
      expect(entro, 'el regex vulnerable dejó pasar un documento con separadores de miles — la evasión es real').toBe(
        true,
      );
    },
  );

  it('M-C1b 🔴 con el guardia REAL (corregido), el mismo valor de arriba se rechaza', async () => {
    const error = await capturar(() => comoSocio((ej) => altaContraparte(ej, s.clienteA, { patron: CUIT_CON_SEPARADORES_DE_MILES })));
    esperarRechazo(
      error,
      '23514',
      'padron_contraparte_patron_sin_documento_chk',
      'el regex corregido tiene que atrapar 7+ dígitos con separador opcional, no solo corridas consecutivas',
    );
  });

  it('legítimo: un nombre real sin corrida de 7+ dígitos entra', async () => {
    await comoSocio(async (ej) => {
      const f = await altaContraparte(ej, s.clienteA, { patron: 'DISTRIBUIDORA SINTETICA SA' });
      expect(f['id']).toBeTruthy();
    });
  });

  it('legítimo: un nombre con pocos dígitos sueltos (no 7 seguidos) entra', async () => {
    await comoSocio(async (ej) => {
      const f = await altaContraparte(ej, s.clienteA, { patron: 'SUCURSAL 42 SA' });
      expect(f['id']).toBeTruthy();
    });
  });
});

// =============================================================================
// D — poscondición de normalización (4 mutaciones)
// =============================================================================
describe('0037 D — `patron` tiene que llegar ya normalizado', () => {
  it('M-D1 🔴 minúsculas mueren por `padron_contraparte_patron_mayuscula_chk`', async () => {
    const error = await capturar(() => comoSocio((ej) => altaContraparte(ej, s.clienteA, { patron: 'forcor sa' })));
    esperarRechazo(error, '23514', 'padron_contraparte_patron_mayuscula_chk', 'un patrón en minúsculas no es la poscondición de normalizar()');
  });

  it('M-D2 🔴 espacio inicial muere por `padron_contraparte_patron_recortado_chk`', async () => {
    const error = await capturar(() => comoSocio((ej) => altaContraparte(ej, s.clienteA, { patron: ' FORCOR SA' })));
    esperarRechazo(error, '23514', 'padron_contraparte_patron_recortado_chk', 'un patrón sin recortar no es la poscondición de normalizar()');
  });

  it('M-D3 🔴 espacio doble muere por `padron_contraparte_patron_sin_espacios_dobles_chk`', async () => {
    const error = await capturar(() => comoSocio((ej) => altaContraparte(ej, s.clienteA, { patron: 'FORCOR  SA' })));
    esperarRechazo(error, '23514', 'padron_contraparte_patron_sin_espacios_dobles_chk', 'espacios repetidos no son la poscondición de normalizar()');
  });

  it('M-D4 🔴 cadena vacía (post-recorte) muere por `padron_contraparte_patron_no_vacio_chk`', async () => {
    const error = await capturar(() => comoSocio((ej) => altaContraparte(ej, s.clienteA, { patron: '   ' })));
    esperarRechazo(error, '23514', 'padron_contraparte_patron_no_vacio_chk', 'un patrón en blanco no identifica a nadie');
  });
});

// =============================================================================
// E — R6/R40: unicidad SIEMPRE por cliente, nunca global
// =============================================================================
describe('0037 E — aislamiento: el mismo patrón en dos clientes distintos no colisiona', () => {
  it('legítimo: "FORCOR SA" en clienteA y en clienteB, sin choque', async () => {
    await comoSocio(async (ej) => {
      const fA = await altaContraparte(ej, s.clienteA, { patron: 'MISMO NOMBRE ENTRE CLIENTES SA' });
      const fB = await altaContraparte(ej, s.clienteB, { patron: 'MISMO NOMBRE ENTRE CLIENTES SA' });
      expect(fA['id']).toBeTruthy();
      expect(fB['id']).toBeTruthy();
      expect(fA['id']).not.toEqual(fB['id']);
    });
  });
});

// =============================================================================
// F — `uq_padron_contraparte_vigente`: una sola vigencia ABIERTA por (cliente, patrón)
// =============================================================================
describe('0037 F — una sola vigencia abierta por patrón', () => {
  it('M-F1 🔴 dos altas del mismo patrón, las dos con vigencia abierta, la segunda choca', async () => {
    const patron = 'RODAMET SINTETICO SA';
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        await altaContraparte(ej, s.clienteA, { patron, vigenteDesde: '2026-01-01' });
        await altaContraparte(ej, s.clienteA, { patron, vigenteDesde: '2026-02-01' });
      }),
    );
    esperarRechazo(error, '23505', 'uq_padron_contraparte_vigente', 'dos vigencias abiertas del mismo patrón dejarían el motor sin poder resolverlo nunca más');
  });

  it('legítimo: cerrar la primera vigencia y dar de alta la nueva funciona', async () => {
    const patron = 'RODAMET SINTETICO SA 2';
    await comoSocio(async (ej) => {
      const primera = await altaContraparte(ej, s.clienteA, { patron, vigenteDesde: '2026-01-01' });
      await una(
        ej,
        `update padron_contraparte set vigente_hasta = '2026-02-01' where cliente_id = $1 and id = $2 returning id`,
        [s.clienteA, primera['id']],
      );
      const segunda = await altaContraparte(ej, s.clienteA, { patron, vigenteDesde: '2026-02-01' });
      expect(segunda['id']).toBeTruthy();
    });
  });
});

// =============================================================================
// G — `fk_asiento_renglon_contraparte`: FK COMPUESTA tenant-consistente (hallazgo F1)
// =============================================================================
describe('0037 G — FK compuesta de `asiento_propuesto_renglon.padron_contraparte_id`', () => {
  let mesSeq = 0;
  /** Un período mensual DISTINTO por llamada — `uq_cierre_periodo_vigente` es por (cliente, período). */
  async function crearAsiento(ej: Ejecutar, clienteId: string): Promise<{ asientoId: string; cuentaId: string }> {
    mesSeq += 1;
    const mes = String(mesSeq).padStart(2, '0');
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
       values ($1, 'mensual', $2::date, ($2::date + interval '1 month - 1 day')::date) returning id::text as id`,
      [clienteId, `2027-${mes}-01`],
    );
    const asiento = await una(
      ej,
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', $3::date) returning id::text as id`,
      [clienteId, cierre['id'], `2027-${mes}-15`],
    );
    const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [clienteId]);
    return { asientoId: String(asiento['id']), cuentaId: String(cuenta['id']) };
  }

  async function crearRenglon(
    ej: Ejecutar,
    clienteId: string,
    asientoId: string,
    cuentaId: string,
    padronContraparteId: string | null,
  ): Promise<Fila[]> {
    return ej(
      `insert into asiento_propuesto_renglon
         (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion, padron_contraparte_id)
       values ($1, $2, 1, $3, '{}'::jsonb, 100, 0, '2026-08-15', $4)
       returning id::text as id`,
      [clienteId, asientoId, cuentaId, padronContraparteId],
    );
  }

  it(
    'M-G1 🔴 EN VIVO: con la FK REDUCIDA a una sola columna (`padron_contraparte_id references ' +
      'padron_contraparte(id)`, sin `cliente_id`), un renglón de un cliente SÍ logra citar el patrón ' +
      'de OTRO cliente — la prueba de que la FK tiene que ser COMPUESTA y no simple',
    async () => {
      const contraparteDeB = await comoSocio((ej) => altaContraparte(ej, s.clienteB));
      const entroCruzado = await conDdlMutado(
        'fk_asiento_renglon_contraparte',
        [
          'alter table asiento_propuesto_renglon drop constraint fk_asiento_renglon_contraparte',
          'alter table asiento_propuesto_renglon add constraint fk_asiento_renglon_contraparte ' +
            'foreign key (padron_contraparte_id) references padron_contraparte (id) on delete restrict',
        ],
        async (ej) => {
          const { asientoId, cuentaId } = await crearAsiento(ej, s.clienteA);
          const fila = await crearRenglon(ej, s.clienteA, asientoId, cuentaId, String(contraparteDeB['id']));
          return Boolean(fila[0]?.['id']);
        },
      );
      expect(
        entroCruzado,
        'con la FK simple, un renglón de A citando el patrón de B entró — exactamente el vector que la FK compuesta cierra',
      ).toBe(true);
    },
  );

  it('M-G1b 🔴 con la FK COMPUESTA real, el mismo cruce de arriba se rechaza', async () => {
    const contraparteDeB = await comoSocio((ej) => altaContraparte(ej, s.clienteB));
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const { asientoId, cuentaId } = await crearAsiento(ej, s.clienteA);
        return crearRenglon(ej, s.clienteA, asientoId, cuentaId, String(contraparteDeB['id']));
      }),
    );
    esperarRechazo(
      error,
      '23503',
      'fk_asiento_renglon_contraparte',
      'un renglón de cliente A no puede citar, como evidencia, el patrón de otro cliente',
    );
  });

  it('legítimo: un renglón citando el patrón de SU PROPIO cliente entra', async () => {
    await comoSocio(async (ej) => {
      const contraparte = await altaContraparte(ej, s.clienteA);
      const { asientoId, cuentaId } = await crearAsiento(ej, s.clienteA);
      const fila = await crearRenglon(ej, s.clienteA, asientoId, cuentaId, String(contraparte['id']));
      expect(fila[0]?.['id']).toBeTruthy();
    });
  });

  it('legítimo: `padron_contraparte_id` NULL (sin match/no consultado) entra igual', async () => {
    await comoSocio(async (ej) => {
      const { asientoId, cuentaId } = await crearAsiento(ej, s.clienteA);
      const fila = await crearRenglon(ej, s.clienteA, asientoId, cuentaId, null);
      expect(fila[0]?.['id']).toBeTruthy();
    });
  });
});
