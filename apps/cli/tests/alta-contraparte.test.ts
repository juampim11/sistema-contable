/**
 * `alta-contraparte.ts` — el CLI de alta/baja de `padron_contraparte` (migración 0037, capa C).
 * Base real. Mismo alcance que `alta-socio.test.ts`, adaptado a las diferencias de diseño ya
 * cerradas: `--patron` va por argumento normal (no es N2-R, sin prompt oculto), y el guard es contra
 * forma de documento en TEXTO LIBRE (`RE_POSIBLE_DOCUMENTO_EN_TEXTO`), no contra CUIT/DNI bien
 * formados.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, con `0037` APLICADA.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones } from '@sistema-contable/data';
import { sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { argumentos, escribirAltaDeContraparte, escribirBajaDeContraparte } from '../src/alta-contraparte.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

let seq = 0;
/** Un patrón sintético distinto por caso, para no chocar con `uq_padron_contraparte_vigente`. */
function patronDistinto(): string {
  seq += 1;
  return `CONTRAPARTE DE PRUEBA ${seq}`;
}

describe('argumentos — parseo y guards de aplicación', () => {
  const base = ['--cliente', randomUUID(), '--usuario', randomUUID()];

  it('parsea un alta completa', () => {
    const r = argumentos([
      ...base,
      '--patron',
      'PROVEEDOR DE PRUEBA SA',
      '--clasificacion',
      'proveedor',
      '--vigencia-desde',
      '2026-01-01',
    ]);
    expect(r).toEqual({
      baja: false,
      cliente: base[1],
      usuario: base[3],
      patron: 'PROVEEDOR DE PRUEBA SA',
      clasificacion: 'proveedor',
      vigenciaDesde: '2026-01-01',
    });
  });

  it('parsea una baja', () => {
    const contraparteId = randomUUID();
    const r = argumentos([...base, '--baja', '--contraparte-id', contraparteId, '--vigencia-hasta', '2026-06-01']);
    expect(r).toEqual({ baja: true, cliente: base[1], usuario: base[3], contraparteId, vigenciaHasta: '2026-06-01' });
  });

  it('rechaza clasificación fuera del dominio cerrado', () => {
    expect(() =>
      argumentos([...base, '--patron', 'X SA', '--clasificacion', 'socio', '--vigencia-desde', '2026-01-01']),
    ).toThrow();
  });

  it('🔴 rechaza --patron con forma de documento (CUIT con guiones, estilo AFIP)', () => {
    expect(() =>
      argumentos([...base, '--patron', '30-71234567-8', '--clasificacion', 'proveedor', '--vigencia-desde', '2026-01-01']),
    ).toThrow(/forma de documento/);
  });

  it('🔴 rechaza --patron con forma de documento partido por separadores de miles (el vector que evadía el regex original)', () => {
    expect(() =>
      argumentos([
        ...base, '--patron', 'PROVEEDOR 30.712.345.678 SA', '--clasificacion', 'proveedor', '--vigencia-desde', '2026-01-01',
      ]),
    ).toThrow(/forma de documento/);
  });

  it('acepta --patron con pocos dígitos sueltos (no 7 seguidos, ni con separador)', () => {
    const r = argumentos([...base, '--patron', 'SUCURSAL 42 SA', '--clasificacion', 'proveedor', '--vigencia-desde', '2026-01-01']);
    expect(r).toMatchObject({ patron: 'SUCURSAL 42 SA' });
  });

  it('rechaza argumentos faltantes', () => {
    expect(() => argumentos(base)).toThrow();
  });

  it('🔴 rechaza --baja combinado con --patron, en vez de ignorar el campo en silencio', () => {
    const contraparteId = randomUUID();
    expect(() =>
      argumentos([
        ...base, '--baja', '--contraparte-id', contraparteId, '--vigencia-hasta', '2026-06-01',
        '--patron', 'ESTO NO DEBERÍA IMPORTAR SA',
      ]),
    ).toThrow(/no se combina/);
  });
});

describe('escribirAltaDeContraparte / escribirBajaDeContraparte — flujo completo (base real)', () => {
  it('alta feliz: devuelve contraparteId', async () => {
    const r = await escribirAltaDeContraparte({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      patron: patronDistinto(),
      clasificacion: 'proveedor',
      vigenciaDesde: '2026-01-01',
    });
    expect(r.estado).toBe('alta');
    if (r.estado === 'alta') {
      expect(r.contraparteId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('🔴 rechaza una alta duplicada del mismo patrón activo — sin rama de idempotencia silenciosa', async () => {
    const patron = patronDistinto();
    const pedido = {
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      patron,
      clasificacion: 'proveedor',
      vigenciaDesde: '2026-01-01',
    };
    const primera = await escribirAltaDeContraparte(pedido);
    expect(primera.estado).toBe('alta');

    // Misma clasificación distinta a propósito: si hubiera una rama de idempotencia por accidente,
    // este segundo alta no debería "fusionarse" con el primero — tiene que rechazar, punto, por el
    // índice único de vigencia activa.
    await expect(escribirAltaDeContraparte({ ...pedido, clasificacion: 'cliente' })).rejects.toThrow();
  });

  it('baja cierra la vigencia; una segunda baja sobre la misma contraparte no encuentra fila activa', async () => {
    const alta = await escribirAltaDeContraparte({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      patron: patronDistinto(),
      clasificacion: 'proveedor',
      vigenciaDesde: '2026-01-01',
    });
    expect(alta.estado).toBe('alta');
    const contraparteId = alta.estado === 'alta' ? alta.contraparteId : '';

    const baja = await escribirBajaDeContraparte({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      contraparteId,
      vigenciaHasta: '2026-06-01',
    });
    expect(baja).toEqual({ estado: 'baja', contraparteId });

    const segundaBaja = await escribirBajaDeContraparte({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      contraparteId,
      vigenciaHasta: '2026-07-01',
    });
    expect(segundaBaja).toEqual({ estado: 'abortado', motivoCodigo: 'BAJA_CONTRAPARTE_NO_ENCONTRADA' });
  });

  it('🔴 baja el MISMO día del alta (el error más común, detectado al toque) da un motivo explícito, no ING_CHECK genérico', async () => {
    const alta = await escribirAltaDeContraparte({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      patron: patronDistinto(),
      clasificacion: 'proveedor',
      vigenciaDesde: '2026-06-15',
    });
    expect(alta.estado).toBe('alta');
    const contraparteId = alta.estado === 'alta' ? alta.contraparteId : '';

    // padron_contraparte_vigencia_chk exige vigente_hasta > vigente_desde ESTRICTO — cerrar con la
    // misma fecha del alta viola el check. Tiene que dar un motivo específico, no un error genérico.
    const bajaMismoDia = await escribirBajaDeContraparte({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      contraparteId,
      vigenciaHasta: '2026-06-15',
    });
    expect(bajaMismoDia).toEqual({ estado: 'abortado', motivoCodigo: 'BAJA_MISMO_DIA_DE_ALTA' });

    // Con la fecha de mañana sí funciona — es el workaround que el mensaje de error recomienda.
    const bajaManana = await escribirBajaDeContraparte({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      contraparteId,
      vigenciaHasta: '2026-06-16',
    });
    expect(bajaManana).toEqual({ estado: 'baja', contraparteId });
  });

  it('🔴 rol insuficiente: administrativo no puede dar de alta una contraparte (policy exige socio|contador)', async () => {
    await expect(
      escribirAltaDeContraparte({
        cliente: s.clienteA,
        usuario: USUARIOS.administrativoA,
        patron: patronDistinto(),
        clasificacion: 'proveedor',
        vigenciaDesde: '2026-01-01',
      }),
    ).rejects.toThrow();
  });

  it('aislamiento cross-cliente: una contraparte dada de alta en clienteA no es visible por un usuario sin membership ahí', async () => {
    const alta = await escribirAltaDeContraparte({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      patron: patronDistinto(),
      clasificacion: 'proveedor',
      vigenciaDesde: '2026-01-01',
    });
    expect(alta.estado).toBe('alta');

    // socioOtroEstudio no tiene membership en clienteA — una baja contra ese cliente, con esa
    // identidad, tiene que fallar por RLS (0 filas visibles), nunca "encontrar" la contraparte real.
    const contraparteId = alta.estado === 'alta' ? alta.contraparteId : '';
    const intento = await escribirBajaDeContraparte({
      cliente: s.clienteA,
      usuario: USUARIOS.socioOtroEstudio,
      contraparteId,
      vigenciaHasta: '2026-06-01',
    }).catch((e: unknown) => e);
    // O bien tira (RLS/rol) o devuelve BAJA_CONTRAPARTE_NO_ENCONTRADA (0 filas visibles) — nunca la
    // baja real.
    if (intento && typeof intento === 'object' && 'estado' in intento) {
      expect((intento as { estado: string }).estado).toBe('abortado');
    } else {
      expect(intento).toBeInstanceOf(Error);
    }
  });
});
