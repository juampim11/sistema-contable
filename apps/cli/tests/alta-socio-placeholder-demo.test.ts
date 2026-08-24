/**
 * `alta-socio-placeholder-demo.ts` — placeholder de demo para El Prat (Módulo 2, capa C). Base real.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones } from '@sistema-contable/data';
import { verificadorCuitEsValido } from '@sistema-contable/shared/seguridad';
import { sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import {
  argumentos,
  CLIENTE_EL_PRAT,
  DOCUMENTO_PLACEHOLDER,
  escribirAltaDePlaceholder,
} from '../src/alta-socio-placeholder-demo.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

describe('DOCUMENTO_PLACEHOLDER — el guard que lo hace inconfundible con un dato real', () => {
  it('🔴 el dígito verificador NUNCA puede ser válido — mismo guard que packages/data/scripts/sembrar.ts', () => {
    // Si esto alguna vez da `true` (por un typo futuro al editar la constante), el placeholder dejaría
    // de ser "inconfundible con un CUIT real" y este test tiene que fallar ruidoso, no en silencio.
    expect(verificadorCuitEsValido(DOCUMENTO_PLACEHOLDER)).toBe(false);
  });

  it('tiene forma válida de CUIT (11 dígitos, prefijo AFIP real) — pasa el constraint de forma de la base', () => {
    expect(DOCUMENTO_PLACEHOLDER).toMatch(/^(20|23|24|25|26|27|30|33|34)[0-9]{9}$/);
  });

  it('no reusa el cuerpo del CUIT CANARIO de packages/data/src/seed/sintetico.ts (reservado para INV-5/INV-8)', () => {
    expect(DOCUMENTO_PLACEHOLDER).not.toContain('99999999');
  });
});

describe('argumentos — parseo y guards', () => {
  it('parsea usuario + vigencia-desde', () => {
    const usuario = randomUUID();
    const r = argumentos(['--usuario', usuario, '--vigencia-desde', '2025-10-20']);
    expect(r).toEqual({ usuario, vigenciaDesde: '2025-10-20' });
  });

  it('🔴 rechaza --cliente — el único cliente válido está hardcodeado, no es un argumento', () => {
    expect(() =>
      argumentos(['--cliente', randomUUID(), '--usuario', randomUUID(), '--vigencia-desde', '2025-10-20']),
    ).toThrow(/no es un argumento de este script/);
  });

  it.each(['--documento', '--cuit', '--cuil', '--dni'])(
    '🔴 rechaza %s como argumento, ANTES de tocar la base',
    (flag) => {
      expect(() =>
        argumentos(['--usuario', randomUUID(), '--vigencia-desde', '2025-10-20', flag, DOCUMENTO_PLACEHOLDER]),
      ).toThrow(/ya no es un argumento válido/);
    },
  );

  it('rechaza un uuid de usuario inválido', () => {
    expect(() => argumentos(['--usuario', 'no-es-un-uuid', '--vigencia-desde', '2025-10-20'])).toThrow();
  });

  it('rechaza una fecha con forma inválida', () => {
    expect(() => argumentos(['--usuario', randomUUID(), '--vigencia-desde', '20-10-2025'])).toThrow();
  });
});

describe('escribirAltaDePlaceholder — el bypass es ESTRECHO, no un "saltar checksum" genérico', () => {
  it('🔴 rechaza cualquier valor que no sea EXACTAMENTE DOCUMENTO_PLACEHOLDER, aunque tenga forma válida', async () => {
    // Forma válida de CUIT, verificador también inválido (mismo patrón que el placeholder) — pero NO
    // es el valor exacto documentado. Si esto alguna vez pasara, el script dejaría de ser "el único
    // valor que puede insertar es el que está en el registro" y volvería a ser un bypass genérico.
    await expect(
      escribirAltaDePlaceholder({
        clienteId: s.clienteA,
        usuario: USUARIOS.socio,
        vigenciaDesde: '2025-10-20',
        documento: '20999999996',
      }),
    ).rejects.toThrow(/solo acepta el valor placeholder documentado/);
  });

  it('alta feliz con el valor exacto: devuelve socioId y solo los últimos 4 dígitos', async () => {
    const r = await escribirAltaDePlaceholder({
      clienteId: s.clienteA,
      usuario: USUARIOS.socio,
      vigenciaDesde: '2025-10-20',
      documento: DOCUMENTO_PLACEHOLDER,
    });
    expect(r.estado).toBe('alta');
    if (r.estado === 'alta') {
      expect(r.socioId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.documentoUltimos4).toBe(DOCUMENTO_PLACEHOLDER.slice(-4));
      expect(r.pepperId).toMatch(/^v\d+$/);
    }
  });

  it('una segunda alta con el mismo placeholder, en el mismo tenant y vigencia activa, rechaza (índice único de vigencia)', async () => {
    // Documenta la consecuencia que seguridad-datos-financieros pidió dejar escrita: reusar el mismo
    // placeholder dos veces en un cliente, con la primera fila todavía vigente, es un error de
    // unicidad esperado — fail-closed, no un bug. Se prueba contra clienteB para no interferir con el
    // resto de los tests de este archivo que usan clienteA.
    const primera = await escribirAltaDePlaceholder({
      clienteId: s.clienteB,
      usuario: USUARIOS.contadorB,
      vigenciaDesde: '2025-10-20',
      documento: DOCUMENTO_PLACEHOLDER,
    });
    expect(primera.estado).toBe('alta');

    await expect(
      escribirAltaDePlaceholder({
        clienteId: s.clienteB,
        usuario: USUARIOS.contadorB,
        vigenciaDesde: '2025-10-20',
        documento: DOCUMENTO_PLACEHOLDER,
      }),
    ).rejects.toThrow();
  });
});

describe('CLIENTE_EL_PRAT', () => {
  it('es el uuid del tenant real de El Prat en el piloto, no un valor de test', () => {
    expect(CLIENTE_EL_PRAT).toBe('80741296-8cbf-4a4f-bcf1-8e8cb1c57584');
  });
});
