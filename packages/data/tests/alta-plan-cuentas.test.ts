/**
 * `cierre/escrituras.ts::altaPlanDeCuentas` — primera vez que se llenan `cuenta`/`cuenta_atributo`
 * (`0027_cierre_mensual.sql`). Fixture 100% SINTÉTICO contra `s.clienteA` (nunca el plan real de
 * Bracci ni ningún dato de cliente real) — la corrida real contra el archivo de Bracci se hizo aparte,
 * contra un tenant sintético, y quedó documentada en `HANDOFF.md` (no se commitea).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, escribirConAuditoria, type Tx } from '@sistema-contable/data';
import { ErrorDeBase } from '../src/db/errores-pg.ts';
import { altaPlanDeCuentas, ErrorAltaPlanCuentas, type FilaAltaPlanCuentas } from '../src/cierre/escrituras.ts';
import { sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Mismo criterio que `crearSocio` de `mutaciones-0027.test.ts`: socio sintético, documento sintético. */
async function crearSocioSintetico(tx: Tx, clienteId: string): Promise<string> {
  const semilla = randomUUID();
  const filas = await tx.consultar<{ id: string }>(
    `insert into padron_socio
       (cliente_id, denominacion, documento_tipo, documento_hmac, documento_ultimos4, pepper_id,
        vigente_desde)
     values ($1, 'SOCIO SINTÉTICO TEST', 'cuit', decode(md5($2), 'hex') || decode(md5($2), 'hex'),
             '0000', 'v1', '2026-01-01')
     returning id::text as id`,
    [clienteId, semilla],
  );
  const id = filas[0]?.id;
  if (!id) throw new Error('No se pudo crear el socio sintético del fixture.');
  return id;
}

describe('altaPlanDeCuentas — alta feliz, dos pasadas sin depender del orden', () => {
  it('inserta raíz + hijo + nieto ligado a socio, con cuentaPadreId resuelto para los tres', async () => {
    const socioId = await conUsuario(USUARIOS.socio, (tx) => crearSocioSintetico(tx, s.clienteA));

    // Orden A PROPÓSITO invertido (el nieto antes que el padre, el padre antes que la raíz no —
    // pero el hijo antes que el nieto sí importaría si la pasada 1 dependiera de orden topológico,
    // y no depende): prueba que la resolución de cuentaPadreId funciona sin importar el orden de filas.
    const filas: readonly FilaAltaPlanCuentas[] = [
      {
        codigo: 'T.3',
        denominacion: 'Cuenta Particular Socio de Test',
        nivel: 3,
        cuentaPadreCodigo: 'T.2',
        rolFuncional: 'cuenta_particular_socio',
        padronSocioId: socioId,
        vigenteDesde: '2026-08-27',
        respaldo: 'test: alta feliz',
      },
      {
        codigo: 'T.1',
        denominacion: 'RAIZ DE TEST',
        nivel: 1,
        cuentaPadreCodigo: null,
        rolFuncional: 'generica',
        padronSocioId: null,
        vigenteDesde: '2026-08-27',
        respaldo: 'test: alta feliz',
      },
      {
        codigo: 'T.2',
        denominacion: 'HIJO DE TEST',
        nivel: 2,
        cuentaPadreCodigo: 'T.1',
        rolFuncional: 'generica',
        padronSocioId: null,
        vigenteDesde: '2026-08-27',
        respaldo: 'test: alta feliz',
      },
    ];

    const resultado = await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'cuenta_atributo', motivo: 'test: alta feliz' },
        (ctx) => altaPlanDeCuentas(tx, ctx, { clienteId: s.clienteA, filas }),
      ),
    );

    expect(resultado.cuentasCreadas).toBe(3);
    expect(resultado.cuentaIdPorCodigo.size).toBe(3);

    const filasDb = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{
        codigo: string;
        denominacion: string;
        padre_codigo: string | null;
        rol_funcional: string;
        padron_socio_id: string | null;
      }>(
        `select ca.codigo, ca.denominacion, p.codigo as padre_codigo, ca.rol_funcional, ca.padron_socio_id::text as padron_socio_id
         from cuenta_atributo ca
         left join cuenta_atributo p on p.cuenta_id = ca.cuenta_padre_id and p.cliente_id = ca.cliente_id
         where ca.cliente_id = $1 and ca.codigo in ('T.1', 'T.2', 'T.3')
         order by ca.codigo`,
        [s.clienteA],
      ),
    );

    expect(filasDb).toEqual([
      { codigo: 'T.1', denominacion: 'RAIZ DE TEST', padre_codigo: null, rol_funcional: 'generica', padron_socio_id: null },
      { codigo: 'T.2', denominacion: 'HIJO DE TEST', padre_codigo: 'T.1', rol_funcional: 'generica', padron_socio_id: null },
      {
        codigo: 'T.3',
        denominacion: 'Cuenta Particular Socio de Test',
        padre_codigo: 'T.2',
        rol_funcional: 'cuenta_particular_socio',
        padron_socio_id: socioId,
      },
    ]);
  });

  it('la denominación queda EXACTA — mayúsculas, espacios y prefijo tal cual el pedido, nunca normalizada (R42)', async () => {
    const filas: readonly FilaAltaPlanCuentas[] = [
      {
        codigo: 'T.9',
        denominacion: '  Gastos  de   Combustible y lubricantes ',
        nivel: 1,
        cuentaPadreCodigo: null,
        rolFuncional: 'generica',
        padronSocioId: null,
        vigenteDesde: '2026-08-27',
        respaldo: 'test: denominación exacta',
      },
    ];
    await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'cuenta_atributo', motivo: 'test: denominación exacta' },
        (ctx) => altaPlanDeCuentas(tx, ctx, { clienteId: s.clienteA, filas }),
      ),
    );
    const fila = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ denominacion: string }>(
        `select denominacion from cuenta_atributo where cliente_id = $1 and codigo = 'T.9'`,
        [s.clienteA],
      ),
    );
    expect(fila[0]?.denominacion).toBe('  Gastos  de   Combustible y lubricantes ');
  });
});

describe('altaPlanDeCuentas — 🔴 cuentaPadreCodigo que no está en el propio pedido', () => {
  it('lanza ErrorAltaPlanCuentas("padre_no_encontrado_en_el_pedido") ANTES de dejar filas a medio insertar sin padre resoluble', async () => {
    const filas: readonly FilaAltaPlanCuentas[] = [
      {
        codigo: 'T.HUERFANO',
        denominacion: 'CUENTA CON PADRE INEXISTENTE',
        nivel: 2,
        cuentaPadreCodigo: 'T.NO_EXISTE_EN_ESTE_PEDIDO',
        rolFuncional: 'generica',
        padronSocioId: null,
        vigenteDesde: '2026-08-27',
        respaldo: 'test: padre no encontrado',
      },
    ];
    const error = await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'cuenta_atributo', motivo: 'test: padre no encontrado' },
        (ctx) => altaPlanDeCuentas(tx, ctx, { clienteId: s.clienteA, filas }),
      ),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorAltaPlanCuentas);
    expect((error as ErrorAltaPlanCuentas).codigo).toBe('padre_no_encontrado_en_el_pedido');
    expect((error as ErrorAltaPlanCuentas).codigoCuenta).toBe('T.HUERFANO');
  });
});

describe('altaPlanDeCuentas — 🔴 CHECK de la migración 0027 sigue vigente para esta vía de alta', () => {
  it('rol_funcional=cuenta_particular_socio sin padronSocioId muere por cuenta_atributo_padron_socio_chk, no entra silenciado', async () => {
    const filas: readonly FilaAltaPlanCuentas[] = [
      {
        codigo: 'T.SIN_SOCIO',
        denominacion: 'Cuenta Particular Sin Socio',
        nivel: 1,
        cuentaPadreCodigo: null,
        rolFuncional: 'cuenta_particular_socio',
        padronSocioId: null,
        vigenteDesde: '2026-08-27',
        respaldo: 'test: CHECK vigente',
      },
    ];
    const error = await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'cuenta_atributo', motivo: 'test: CHECK vigente' },
        (ctx) => altaPlanDeCuentas(tx, ctx, { clienteId: s.clienteA, filas }),
      ),
    ).catch((e: unknown) => e);

    // `escrituras.ts` envuelve cada insert con `conErroresTraducidos` (R28) — lo que sale NUNCA es el
    // error crudo del driver, es `ErrorDeBase` con código propio + constraint, sin datos de la fila.
    expect(error).toBeInstanceOf(ErrorDeBase);
    expect((error as ErrorDeBase).codigo).toBe('ING_CHECK');
    expect((error as ErrorDeBase).constraint).toBe('cuenta_atributo_padron_socio_chk');
  });
});

describe('altaPlanDeCuentas — aislamiento cross-cliente', () => {
  it('las cuentas insertadas para clienteA no son visibles para un usuario sin membership ahí', async () => {
    const filas: readonly FilaAltaPlanCuentas[] = [
      {
        codigo: 'T.AISLAMIENTO',
        denominacion: 'CUENTA DE AISLAMIENTO',
        nivel: 1,
        cuentaPadreCodigo: null,
        rolFuncional: 'generica',
        padronSocioId: null,
        vigenteDesde: '2026-08-27',
        respaldo: 'test: aislamiento',
      },
    ];
    await conUsuario(USUARIOS.socio, (tx) =>
      escribirConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'escritura', recurso: 'cuenta_atributo', motivo: 'test: aislamiento' },
        (ctx) => altaPlanDeCuentas(tx, ctx, { clienteId: s.clienteA, filas }),
      ),
    );

    const visibleParaAjeno = await conUsuario(USUARIOS.socioOtroEstudio, (tx) =>
      tx.consultar(`select 1 from cuenta_atributo where cliente_id = $1 and codigo = 'T.AISLAMIENTO'`, [
        s.clienteA,
      ]),
    );
    expect(visibleParaAjeno).toEqual([]);
  });
});
