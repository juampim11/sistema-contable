/**
 * `alta-socio.ts` — el CLI de alta/baja de socio del padrón (migración 0013, capa C). Base real.
 * Plan `adaptive-herding-pillow`, P3.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones } from '@sistema-contable/data';
import { sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { argumentos, escribirAltaDeSocio, escribirBajaDeSocio } from '../src/alta-socio.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

// `escribirAltaDeSocio`/`altaDeSocio` NO validan dígito verificador — el documento "YA viene
// resuelto" (validado por `pedirDocumentoConfirmado`, capa del prompt, nunca en la escritura).
// Alcanza con forma de 11 dígitos para estos tests; no hace falta un DV real.
let contadorDocumento = 0;
function documentoDistinto(): string {
  contadorDocumento += 1;
  return `20${String(contadorDocumento).padStart(8, '0')}${contadorDocumento % 10}`;
}
const CUIT_VALIDO = documentoDistinto();

describe('argumentos — parseo y guards de aplicación', () => {
  const base = ['--cliente', randomUUID(), '--usuario', randomUUID()];

  it('parsea un alta completa', () => {
    const r = argumentos([
      ...base,
      '--denominacion',
      'SOCIO DE PRUEBA SRL',
      '--documento-tipo',
      'cuit',
      '--vigencia-desde',
      '2026-01-01',
    ]);
    expect(r).toEqual({
      baja: false,
      cliente: base[1],
      usuario: base[3],
      denominacion: 'SOCIO DE PRUEBA SRL',
      documentoTipo: 'cuit',
      vigenciaDesde: '2026-01-01',
    });
  });

  it('parsea una baja', () => {
    const socioId = randomUUID();
    const r = argumentos([...base, '--baja', '--socio-id', socioId, '--vigencia-hasta', '2026-06-01']);
    expect(r).toEqual({ baja: true, cliente: base[1], usuario: base[3], socioId, vigenciaHasta: '2026-06-01' });
  });

  it.each(['--documento', '--cuit', '--cuil', '--dni'])(
    '🔴 rechaza %s como argumento, ANTES de tocar la base (mismo riesgo que --cbu en alta-cuenta.ts)',
    (flag) => {
      expect(() => argumentos([...base, flag, CUIT_VALIDO])).toThrow(/ya no es un argumento válido/);
    },
  );

  it('🔴 rechaza --denominacion con forma de CUIT/CUIL, aunque no venga por --documento', () => {
    expect(() =>
      argumentos([...base, '--denominacion', '30-71234567-8', '--documento-tipo', 'cuit', '--vigencia-desde', '2026-01-01']),
    ).toThrow(/forma de documento/);
  });

  it('🔴 rechaza --denominacion con forma de DNI', () => {
    expect(() =>
      argumentos([...base, '--denominacion', '12345678', '--documento-tipo', 'cuit', '--vigencia-desde', '2026-01-01']),
    ).toThrow(/forma de documento/);
  });

  it('rechaza argumentos faltantes', () => {
    expect(() => argumentos(base)).toThrow();
  });

  it('🔴 rechaza --baja combinado con --denominacion, en vez de ignorar el campo en silencio', () => {
    const socioId = randomUUID();
    expect(() =>
      argumentos([
        ...base, '--baja', '--socio-id', socioId, '--vigencia-hasta', '2026-06-01',
        '--denominacion', 'ESTO NO DEBERÍA IMPORTAR SRL',
      ]),
    ).toThrow(/no se combina/);
  });
});

describe('escribirAltaDeSocio / escribirBajaDeSocio — flujo completo (base real)', () => {
  it('alta feliz: devuelve socioId y solo los últimos 4 dígitos del documento', async () => {
    const documento = documentoDistinto();
    const r = await escribirAltaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      denominacion: 'SOCIO ALTA FELIZ SRL',
      documentoTipo: 'cuit',
      documento,
      vigenciaDesde: '2026-01-01',
    });
    expect(r.estado).toBe('alta');
    if (r.estado === 'alta') {
      expect(r.socioId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.documentoUltimos4).toBe(documento.slice(-4));
      expect(r.pepperId).toMatch(/^v\d+$/);
    }
  });

  it('🔴 rechaza un alta duplicada del mismo documento activo — sin rama de idempotencia silenciosa', async () => {
    const documento = documentoDistinto();
    const pedido = {
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      denominacion: 'SOCIO DUPLICADO SRL',
      documentoTipo: 'cuit' as const,
      documento,
      vigenciaDesde: '2026-01-01',
    };
    const primera = await escribirAltaDeSocio(pedido);
    expect(primera.estado).toBe('alta');

    // Misma denominación distinta a propósito: si hubiera una rama de idempotencia por accidente,
    // este segundo alta con datos distintos NO debería "fusionarse" con el primero — tiene que
    // rechazar, punto, por el índice único de vigencia activa.
    await expect(escribirAltaDeSocio({ ...pedido, denominacion: 'OTRO NOMBRE SRL' })).rejects.toThrow();
  });

  it('baja cierra la vigencia; una segunda baja sobre el mismo socio no encuentra fila activa', async () => {
    const documento = documentoDistinto();
    const alta = await escribirAltaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      denominacion: 'SOCIO PARA BAJA SRL',
      documentoTipo: 'cuit',
      documento,
      vigenciaDesde: '2026-01-01',
    });
    expect(alta.estado).toBe('alta');
    const socioId = alta.estado === 'alta' ? alta.socioId : '';

    const baja = await escribirBajaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      socioId,
      vigenciaHasta: '2026-06-01',
    });
    expect(baja).toEqual({ estado: 'baja', socioId });

    const segundaBaja = await escribirBajaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      socioId,
      vigenciaHasta: '2026-07-01',
    });
    expect(segundaBaja).toEqual({ estado: 'abortado', motivoCodigo: 'BAJA_SOCIO_NO_ENCONTRADO' });
  });

  it('🔴 baja el MISMO día del alta (el error más común, detectado al toque) da un motivo explícito, no ING_CHECK genérico', async () => {
    const documento = documentoDistinto();
    const alta = await escribirAltaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      denominacion: 'SOCIO ERROR MISMO DIA SRL',
      documentoTipo: 'cuit',
      documento,
      vigenciaDesde: '2026-06-15',
    });
    expect(alta.estado).toBe('alta');
    const socioId = alta.estado === 'alta' ? alta.socioId : '';

    // padron_socio_vigencia_chk exige vigente_hasta > vigente_desde ESTRICTO — cerrar con la misma
    // fecha del alta viola el check. Tiene que dar un motivo específico, no un error genérico.
    const bajaMismoDia = await escribirBajaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      socioId,
      vigenciaHasta: '2026-06-15',
    });
    expect(bajaMismoDia).toEqual({ estado: 'abortado', motivoCodigo: 'BAJA_MISMO_DIA_DE_ALTA' });

    // Con la fecha de mañana sí funciona — es el workaround que el mensaje de error recomienda.
    const bajaManana = await escribirBajaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      socioId,
      vigenciaHasta: '2026-06-16',
    });
    expect(bajaManana).toEqual({ estado: 'baja', socioId });
  });

  it('🔴 rol insuficiente: administrativo no puede dar de alta un socio (policy exige socio|contador)', async () => {
    const documento = documentoDistinto();
    await expect(
      escribirAltaDeSocio({
        cliente: s.clienteA,
        usuario: USUARIOS.administrativoA,
        denominacion: 'SOCIO ROL INSUFICIENTE SRL',
        documentoTipo: 'cuit',
        documento,
        vigenciaDesde: '2026-01-01',
      }),
    ).rejects.toThrow();
  });

  it('aislamiento cross-cliente: un socio dado de alta en clienteA no es visible por un usuario sin membership ahí', async () => {
    const documento = documentoDistinto();
    const alta = await escribirAltaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      denominacion: 'SOCIO AISLAMIENTO SRL',
      documentoTipo: 'cuit',
      documento,
      vigenciaDesde: '2026-01-01',
    });
    expect(alta.estado).toBe('alta');

    // socioOtroEstudio no tiene membership en clienteA — una baja contra ese cliente, con esa
    // identidad, tiene que fallar por RLS (0 filas visibles), nunca "encontrar" el socio de otro.
    const socioId = alta.estado === 'alta' ? alta.socioId : '';
    const intento = await escribirBajaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socioOtroEstudio,
      socioId,
      vigenciaHasta: '2026-06-01',
    }).catch((e: unknown) => e);
    // O bien tira (RLS/rol) o devuelve BAJA_SOCIO_NO_ENCONTRADO (0 filas visibles) — nunca la baja real.
    if (intento && typeof intento === 'object' && 'estado' in intento) {
      expect((intento as { estado: string }).estado).toBe('abortado');
    } else {
      expect(intento).toBeInstanceOf(Error);
    }
  });
});
