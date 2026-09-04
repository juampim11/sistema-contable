/**
 * MUTACIONES de `0036_cuenta_identificador_cuit_titular.sql` — prueba por mutación (CLAUDE.md §1.8)
 * de las reglas verificables NUEVAS: `uq_cuenta_ident_cuit_titular_vigente` (unicidad parcial por
 * `cliente_id, pepper_id, cuit_titular_hmac, moneda`, solo entre vigentes) y los dos `check` —
 * `cuenta_ident_cuit_titular_solo_tarjeta_chk` (acotado a `tarjeta_corporativa`) y
 * `cuenta_ident_algun_ancla_chk` (al menos un ancla presente).
 *
 * Cierra B.17 (`docs/diseno/10-deuda-declarada.md`) — diseño ya CERRADO por convocatoria completa de
 * `CLAUDE.md` §3.1 (`dba-data` + `security-engineer` + `seguridad-datos-financieros`). Esta migración
 * es la implementación literal de ese diseño; esta batería no rediseña nada, solo lo verifica.
 *
 * Mismo patrón que `mutaciones-0029-pendiente-cierre-reproceso.test.ts` (código SQLSTATE + nombre de
 * constraint, nunca `rejects.toThrow()` a secas) — el laboratorio de mutación DDL (`conMutada`,
 * `huella`) es la misma técnica, adaptada de índice/FK a índice/dos-checks.
 *
 * ## Cobertura declarada de esta primera pasada (CLAUDE.md §1.8: conteo explícito)
 *
 * 2 legítimos + 3 ataques contra el esquema real (uno por regla nueva, con su código SQLSTATE y su
 * nombre de constraint) + 3 mutaciones de refutación (una por regla: se dropea el constraint/índice
 * real, se confirma que el MISMO ataque que arriba fue rechazado ahora ENTRA sin error, se revierte
 * por rollback — DDL transaccional de Postgres — y se confirma el esquema de vuelta al original) + 1
 * verificación cruzada de que `cuit_titular_hmac` se calcula con `hmacDocumento` (pepper POR CLIENTE)
 * y nunca con `hmacIdentificador` (pepper global) — 9 `it()` (contado con `grep -c '  it('`, ajustando
 * el falso positivo de esta misma línea de comentario si aplica).
 *
 * Requisito previo: `0036` aplicada a local.
 */

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { hmacDocumento } from '@sistema-contable/shared/seguridad';
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

function esperarRechazo(actual: ErrorPg, code: string, constraint: string, porque: string): void {
  expect(actual.code, porque).toBe(code);
  expect(actual.constraint, porque).toBe(constraint);
}

function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('banco_0036', 'BANCO DE PRUEBA 0036')
       on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

// CUIT SINTÉTICOS, uno por caso, para que ningún test dependa de datos que dejó otro. Sin dígito
// verificador válido a propósito (mismo criterio que el generador de
// packages/data/src/seed/sintetico.ts) — esta batería opera a nivel de esquema, nunca pasa por el
// validador de dígito verificador de apps/cli/src/alta-cuenta.ts.
const CUIT_LEGITIMO_SOLO = '20099990001';
const CUIT_LEGITIMO_DOS_MONEDAS = '20099990002';
const CUIT_ATAQUE_UNICIDAD = '20099990003';
const CUIT_ATAQUE_TIPO = '20099990004';
const CUIT_MUTACION_UNICIDAD = '20099990005';
const CUIT_MUTACION_TIPO = '20099990006';

async function crearCuenta(ej: Ejecutar, clienteId: string, moneda: 'ARS' | 'USD'): Promise<string> {
  const fila = await una(
    ej,
    `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, 'banco_0036', $2)
     returning id::text as id`,
    [clienteId, moneda],
  );
  return String(fila['id']);
}

/**
 * Inserta directo contra `cuenta_bancaria_identificador`, sin pasar por `altaDeCuentaBancaria` — a
 * propósito: esta batería prueba el ESQUEMA (el índice único y los dos `check` nuevos), no la capa de
 * aplicación (esa la cubre el wiring de `packages/data/src/ingesta/escrituras.ts` y el typecheck).
 */
async function insertarIdentificador(
  ej: Ejecutar,
  args: {
    readonly clienteId: string;
    readonly cuentaBancariaId: string;
    readonly tipoCuenta: string;
    readonly moneda: 'ARS' | 'USD';
    readonly numero?: string | null;
    readonly cbuHmac?: Buffer | null;
    readonly cuitTitularHmac?: Buffer | null;
    readonly vigenteDesde: string;
  },
): Promise<string> {
  const fila = await una(
    ej,
    `insert into cuenta_bancaria_identificador
       (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, moneda, cuit_titular_hmac,
        vigente_desde)
     values ($1, $2, $3, $4, $5, $6, $7, $8::date)
     returning id::text as id`,
    [
      args.clienteId,
      args.cuentaBancariaId,
      args.tipoCuenta,
      args.numero ?? null,
      args.cbuHmac ?? null,
      args.moneda,
      args.cuitTitularHmac ?? null,
      args.vigenteDesde,
    ],
  );
  return String(fila['id']);
}

// -----------------------------------------------------------------------------
// El laboratorio de mutación DDL — mismo patrón que `mutaciones-0029-...test.ts`
// (`conUniqueMutada`/`huella`), adaptado a un índice + dos checks en vez de un índice + una FK.
// -----------------------------------------------------------------------------

async function huella(ej: Ejecutar): Promise<Record<string, string>> {
  const idx = await una(
    ej,
    `select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'cuenta_bancaria_identificador'
        and indexname = 'uq_cuenta_ident_cuit_titular_vigente'`,
  );
  const chkTarjeta = await una(
    ej,
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'cuenta_ident_cuit_titular_solo_tarjeta_chk'
        and conrelid = 'cuenta_bancaria_identificador'::regclass`,
  );
  const chkAncla = await una(
    ej,
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'cuenta_ident_algun_ancla_chk'
        and conrelid = 'cuenta_bancaria_identificador'::regclass`,
  );
  return {
    indice: String(idx['indexdef']),
    chkTarjeta: String(chkTarjeta['def']),
    chkAncla: String(chkAncla['def']),
  };
}

async function conMutada<T>(
  ddl: readonly string[],
  usuarioId: string,
  fn: (ej: Ejecutar) => Promise<T>,
): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(
      `Las pruebas de mutación de 0036 corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`,
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
      // Cualquier falla acá (el DDL mismo, el cambio de rol, o el intento) deja la transacción del
      // dueño posiblemente abortada — `rollback` es el único comando válido en ese estado, nunca
      // `reset role`. Se relanza el error original, no uno nuevo del `rollback`.
      await duenio.query('rollback');
      throw error;
    }
    await duenio.query('reset role');
    await duenio.query('rollback');
    const despues = await huella(ejDuenio);
    expect(despues, 'el rollback de la mutación NO restauró el esquema original').toEqual(antes);
    return resultado;
  } finally {
    await duenio.end();
  }
}

describe('0036 — legítimos: el CUIT del titular como ancla', () => {
  it('legítimo: alta solo con cuit_titular_hmac (sin numero ni cbu) inserta', async () => {
    await comoSocio(async (ej) => {
      const cuentaId = await crearCuenta(ej, s.clienteA, 'ARS');
      const digest = hmacDocumento('cuit', CUIT_LEGITIMO_SOLO, s.clienteA);
      const identId = await insertarIdentificador(ej, {
        clienteId: s.clienteA,
        cuentaBancariaId: cuentaId,
        tipoCuenta: 'tarjeta_corporativa',
        moneda: 'ARS',
        cuitTitularHmac: digest,
        vigenteDesde: '2026-02-01',
      });
      expect(identId).toBeTruthy();
    });
  });

  it('legítimo: el mismo titular en dos monedas (ARS y USD) coexiste sin colisión', async () => {
    await comoSocio(async (ej) => {
      const cuentaArs = await crearCuenta(ej, s.clienteA, 'ARS');
      const cuentaUsd = await crearCuenta(ej, s.clienteA, 'USD');
      const digest = hmacDocumento('cuit', CUIT_LEGITIMO_DOS_MONEDAS, s.clienteA);
      const idArs = await insertarIdentificador(ej, {
        clienteId: s.clienteA,
        cuentaBancariaId: cuentaArs,
        tipoCuenta: 'tarjeta_corporativa',
        moneda: 'ARS',
        cuitTitularHmac: digest,
        vigenteDesde: '2026-03-01',
      });
      const idUsd = await insertarIdentificador(ej, {
        clienteId: s.clienteA,
        cuentaBancariaId: cuentaUsd,
        tipoCuenta: 'tarjeta_corporativa',
        moneda: 'USD',
        cuitTitularHmac: digest,
        vigenteDesde: '2026-03-01',
      });
      expect(idArs).not.toBe(idUsd);
    });
  });
});

describe('0036 — ataques contra el esquema real, cada uno rechazado por su regla', () => {
  it('ATAQUE: segundo alta del mismo titular + misma moneda, vigente — rechazado (uq_cuenta_ident_cuit_titular_vigente)', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuenta1 = await crearCuenta(ej, s.clienteA, 'ARS');
        const cuenta2 = await crearCuenta(ej, s.clienteA, 'ARS');
        const digest = hmacDocumento('cuit', CUIT_ATAQUE_UNICIDAD, s.clienteA);
        await insertarIdentificador(ej, {
          clienteId: s.clienteA,
          cuentaBancariaId: cuenta1,
          tipoCuenta: 'tarjeta_corporativa',
          moneda: 'ARS',
          cuitTitularHmac: digest,
          vigenteDesde: '2026-04-01',
        });
        // Segunda tarjeta, mismo cliente/CUIT/moneda, también vigente (vigente_hasta null en las
        // dos) — tiene que chocar: el índice parcial no abre la puerta a dos anclas vigentes del
        // mismo titular en la misma moneda.
        return insertarIdentificador(ej, {
          clienteId: s.clienteA,
          cuentaBancariaId: cuenta2,
          tipoCuenta: 'tarjeta_corporativa',
          moneda: 'ARS',
          cuitTitularHmac: digest,
          vigenteDesde: '2026-04-15',
        });
      }),
    );
    esperarRechazo(
      error,
      '23505',
      'uq_cuenta_ident_cuit_titular_vigente',
      'dos identificadores vigentes del mismo titular en la misma moneda tienen que seguir rechazados',
    );
  });

  it('ATAQUE: cuit_titular_hmac en un tipo_cuenta distinto de tarjeta_corporativa — rechazado (cuenta_ident_cuit_titular_solo_tarjeta_chk)', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuenta = await crearCuenta(ej, s.clienteA, 'ARS');
        const digest = hmacDocumento('cuit', CUIT_ATAQUE_TIPO, s.clienteA);
        return insertarIdentificador(ej, {
          clienteId: s.clienteA,
          cuentaBancariaId: cuenta,
          tipoCuenta: 'caja_ahorro',
          moneda: 'ARS',
          cuitTitularHmac: digest,
          vigenteDesde: '2026-04-01',
        });
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'cuenta_ident_cuit_titular_solo_tarjeta_chk',
      'el CUIT del titular solo tiene sentido en tarjeta_corporativa — una caja de ahorro se identifica '
        + 'por numero/cbu',
    );
  });

  it('ATAQUE: numero, cbu_hmac y cuit_titular_hmac los tres NULL — rechazado (cuenta_ident_algun_ancla_chk)', async () => {
    const error = await capturar(() =>
      comoSocio(async (ej) => {
        const cuenta = await crearCuenta(ej, s.clienteA, 'ARS');
        return insertarIdentificador(ej, {
          clienteId: s.clienteA,
          cuentaBancariaId: cuenta,
          tipoCuenta: 'cuenta_corriente',
          moneda: 'ARS',
          vigenteDesde: '2026-04-01',
        });
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'cuenta_ident_algun_ancla_chk',
      'una fila sin numero, sin cbu_hmac y sin cuit_titular_hmac no tiene nada contra qué resolver jamás',
    );
  });
});

describe('0036 — mutaciones de refutación: sin la regla, el mismo ataque de arriba entra', () => {
  it('MUTACIÓN 🔴 sin uq_cuenta_ident_cuit_titular_vigente: el segundo alta que antes chocaba ahora entra', async () => {
    await conMutada(['drop index uq_cuenta_ident_cuit_titular_vigente'], USUARIOS.socio, async (ej) => {
      const cuenta1 = await crearCuenta(ej, s.clienteA, 'ARS');
      const cuenta2 = await crearCuenta(ej, s.clienteA, 'ARS');
      const digest = hmacDocumento('cuit', CUIT_MUTACION_UNICIDAD, s.clienteA);
      const id1 = await insertarIdentificador(ej, {
        clienteId: s.clienteA,
        cuentaBancariaId: cuenta1,
        tipoCuenta: 'tarjeta_corporativa',
        moneda: 'ARS',
        cuitTitularHmac: digest,
        vigenteDesde: '2026-05-01',
      });
      // Sin el índice, la MISMA combinación (cliente/CUIT/moneda, las dos vigentes) que el ataque de
      // arriba probó que revienta con `23505` ahora entra sin error — es la evidencia directa de que
      // el índice, y no otra cosa, es lo que sostenía ese rechazo.
      const id2 = await insertarIdentificador(ej, {
        clienteId: s.clienteA,
        cuentaBancariaId: cuenta2,
        tipoCuenta: 'tarjeta_corporativa',
        moneda: 'ARS',
        cuitTitularHmac: digest,
        vigenteDesde: '2026-05-15',
      });
      expect(id1).not.toBe(id2);
    });
  });

  it('MUTACIÓN 🔴 sin cuenta_ident_cuit_titular_solo_tarjeta_chk: cuit_titular_hmac en caja_ahorro ahora entra', async () => {
    await conMutada(
      ['alter table cuenta_bancaria_identificador drop constraint cuenta_ident_cuit_titular_solo_tarjeta_chk'],
      USUARIOS.socio,
      async (ej) => {
        const cuenta = await crearCuenta(ej, s.clienteA, 'ARS');
        const digest = hmacDocumento('cuit', CUIT_MUTACION_TIPO, s.clienteA);
        const id = await insertarIdentificador(ej, {
          clienteId: s.clienteA,
          cuentaBancariaId: cuenta,
          tipoCuenta: 'caja_ahorro',
          moneda: 'ARS',
          cuitTitularHmac: digest,
          vigenteDesde: '2026-05-01',
        });
        expect(id).toBeTruthy();
      },
    );
  });

  it('MUTACIÓN 🔴 sin cuenta_ident_algun_ancla_chk: una fila sin ningún ancla ahora entra', async () => {
    await conMutada(
      ['alter table cuenta_bancaria_identificador drop constraint cuenta_ident_algun_ancla_chk'],
      USUARIOS.socio,
      async (ej) => {
        const cuenta = await crearCuenta(ej, s.clienteA, 'ARS');
        const id = await insertarIdentificador(ej, {
          clienteId: s.clienteA,
          cuentaBancariaId: cuenta,
          tipoCuenta: 'cuenta_corriente',
          moneda: 'ARS',
          vigenteDesde: '2026-05-01',
        });
        expect(id).toBeTruthy();
      },
    );
  });
});

describe('0036 — el pepper es POR CLIENTE, nunca global (hallazgo central de la convocatoria)', () => {
  it('el MISMO CUIT ficticio de titular, en dos clientes SINTÉTICOS distintos, produce cuit_titular_hmac DISTINTOS', () => {
    // Si esto diera el mismo hash para los dos clientes, sería el bug exacto que esta convocatoria
    // existió para evitar: un socio con membership en los dos clientes podría, sin ver un CUIT en
    // claro, notar que comparten un titular — la correlación cruzada entre clientes que
    // `hmacDocumento()` (pepper derivado por cliente, vía HKDF) existe para impedir. Nunca se llama acá
    // `hmacIdentificador()` (pepper global): esa es exactamente la función prohibida para este campo.
    const mismoCuit = '20099990009';
    const digestClienteA = hmacDocumento('cuit', mismoCuit, s.clienteA);
    const digestClienteB = hmacDocumento('cuit', mismoCuit, s.clienteB);
    expect(digestClienteA.equals(digestClienteB)).toBe(false);
  });
});
