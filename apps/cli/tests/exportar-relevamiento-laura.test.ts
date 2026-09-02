/**
 * `exportar-relevamiento-laura.ts` — el CLI. Se prueba el parseo de args, la lectura/validación de
 * `--listas`, la reserva/escritura del destino y el mapeo a exit codes — nunca el CONTENIDO detallado
 * del `.xlsx` (eso es `packages/ingesta/tests/armar-libro-laura.test.ts`). Mismo criterio que
 * `exportar-excel.test.ts`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones } from '@sistema-contable/data';
import { sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import {
  escritorReal,
  exportarRelevamientoLaura,
  parsearArgumentos,
  type EscritorReservado,
  type LectorDeListas,
} from '../src/exportar-relevamiento-laura.ts';

let s: Sembrado;
let dirTemporal: string;

beforeAll(async () => {
  s = await sembrar();
  dirTemporal = mkdtempSync(join(tmpdir(), 'exportar-relevamiento-laura-'));
});

afterAll(async () => {
  await cerrarConexiones();
});

const LISTAS_SINTETICAS = JSON.stringify({
  bracci: ['Es un cliente', 'Socio sintético A', 'Otro (aclarar abajo)'],
  roka: ['Es un cliente', 'Socio sintético B', 'Otro (aclarar abajo)'],
  razonSocialBracci: 'CLIENTE SINTETICO BRACCI SAS',
  razonSocialRoka: 'CLIENTE SINTETICO ROKA SAS',
});

function lectorDeListasDePrueba(contenido: string): LectorDeListas {
  return () => contenido;
}

function escritorDePrueba(destinos: string[]): EscritorReservado {
  return {
    reservar: (destino) => {
      writeFileSync(destino, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      destinos.push(destino);
      return 1;
    },
    escribir: (_fd, datos) => {
      const destino = destinos.at(-1);
      if (!destino) throw new Error('no hay destino reservado');
      writeFileSync(destino, Buffer.from(datos));
    },
  };
}

function escritorQueFallaAlEscribir(): EscritorReservado {
  return {
    reservar: (destino) => {
      writeFileSync(destino, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      return 1;
    },
    escribir: () => {
      throw new Error('disco lleno (simulado)');
    },
  };
}

// -----------------------------------------------------------------------------
// parsearArgumentos
// -----------------------------------------------------------------------------

describe('parsearArgumentos', () => {
  function s0(): string {
    return '00000000-0000-0000-0000-000000000000';
  }

  it('camino válido: parsea los cinco argumentos', () => {
    const args = parsearArgumentos([
      '--bracci-id', s0(),
      '--roka-id', s0(),
      '--usuario', s0(),
      '--salida', '/tmp/salida.xlsx',
      '--listas', '/tmp/listas.json',
    ]);
    expect(args).toEqual({
      bracciId: s0(),
      rokaId: s0(),
      usuario: s0(),
      salida: '/tmp/salida.xlsx',
      listas: '/tmp/listas.json',
    });
  });

  it('falta --salida: tira', () => {
    expect(() =>
      parsearArgumentos(['--bracci-id', s0(), '--roka-id', s0(), '--usuario', s0(), '--listas', '/tmp/listas.json']),
    ).toThrow();
  });

  it('falta --listas: tira', () => {
    expect(() =>
      parsearArgumentos(['--bracci-id', s0(), '--roka-id', s0(), '--usuario', s0(), '--salida', '/tmp/salida.xlsx']),
    ).toThrow();
  });

  it('--bracci-id mal formado: tira', () => {
    expect(() =>
      parsearArgumentos([
        '--bracci-id', 'no-es-un-uuid',
        '--roka-id', s0(),
        '--usuario', s0(),
        '--salida', '/tmp/salida.xlsx',
        '--listas', '/tmp/listas.json',
      ]),
    ).toThrow();
  });
});

// -----------------------------------------------------------------------------
// exportarRelevamientoLaura
// -----------------------------------------------------------------------------

describe('exportarRelevamientoLaura', () => {
  it('listas JSON inválido (no parsea): aborta con listas_invalidas, nunca reserva archivo', async () => {
    const destino = join(dirTemporal, `${Date.now()}-json-roto.xlsx`);
    const destinos: string[] = [];
    const r = await exportarRelevamientoLaura(
      { bracciId: s.clienteA, rokaId: s.clienteB, usuario: USUARIOS.socio, salida: destino, listas: 'x' },
      escritorDePrueba(destinos),
      lectorDeListasDePrueba('{ esto no es json'),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'listas_invalidas' });
    expect(destinos).toHaveLength(0);
    expect(existsSync(destino)).toBe(false);
  });

  it('listas con un array vacío: aborta con listas_invalidas', async () => {
    const destino = join(dirTemporal, `${Date.now()}-lista-vacia.xlsx`);
    const r = await exportarRelevamientoLaura(
      { bracciId: s.clienteA, rokaId: s.clienteB, usuario: USUARIOS.socio, salida: destino, listas: 'x' },
      escritorDePrueba([]),
      lectorDeListasDePrueba(JSON.stringify({ bracci: [], roka: ['Es un cliente'] })),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'listas_invalidas' });
    expect(existsSync(destino)).toBe(false);
  });

  it('destino ya existe: aborta con destino_existe', async () => {
    const destino = join(dirTemporal, `${Date.now()}-ya-existe.xlsx`);
    writeFileSync(destino, 'contenido previo, no lo toca nadie');

    const r = await exportarRelevamientoLaura(
      { bracciId: s.clienteA, rokaId: s.clienteB, usuario: USUARIOS.socio, salida: destino, listas: 'x' },
      escritorReal,
      lectorDeListasDePrueba(LISTAS_SINTETICAS),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'destino_existe' });
    expect(readFileSync(destino, 'utf8')).toBe('contenido previo, no lo toca nadie');
  });

  it('la lectura de Bracci/ROKA se arma bien pero la escritura a disco falla: escritura_fallida, sin archivo', async () => {
    const destino = join(dirTemporal, `${Date.now()}-falla-disco.xlsx`);
    const r = await exportarRelevamientoLaura(
      { bracciId: s.clienteA, rokaId: s.clienteB, usuario: USUARIOS.socio, salida: destino, listas: 'x' },
      escritorQueFallaAlEscribir(),
      lectorDeListasDePrueba(LISTAS_SINTETICAS),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'escritura_fallida' });
    expect(existsSync(destino)).toBe(false);
  });

  it('camino feliz: arma el .xlsx, bytes > 0, dos correlaciones distintas', async () => {
    const destino = join(dirTemporal, `${Date.now()}-feliz.xlsx`);
    const r = await exportarRelevamientoLaura(
      { bracciId: s.clienteA, rokaId: s.clienteB, usuario: USUARIOS.socio, salida: destino, listas: 'x' },
      escritorReal,
      lectorDeListasDePrueba(LISTAS_SINTETICAS),
    );
    expect(r.estado).toBe('exportado');
    if (r.estado !== 'exportado') throw new Error('inalcanzable');
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.correlacionBracci).not.toBe(r.correlacionRoka);
    expect(existsSync(destino)).toBe(true);
    expect(readFileSync(destino).byteLength).toBe(r.bytes);
  });
});

describe('escritorReal', () => {
  it('reservar sobre un destino existente tira EEXIST, mismo código que valida exportarRelevamientoLaura', () => {
    const destino = join(dirTemporal, `${Date.now()}-eexist.xlsx`);
    writeFileSync(destino, 'x');
    expect(() => escritorReal.reservar(destino)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
  });
});
