/**
 * EL GATE DE `VERSION_DEL_MOTOR`.
 *
 * Corre en `pnpm test`, o sea en `pnpm verificar` **y en CI**. No va como paso de `pnpm verificar`
 * porque `.github/workflows/ci.yml` corre los pasos SUELTOS, no el script compuesto: un paso nuevo
 * ahí no correría en CI, y un gate que existe en local y no en CI es peor que no tenerlo, porque se
 * cree que está.
 *
 * Es la misma clase de regla que R-E/R-F/R-G/R-J de `packages/data/tests/reglas-de-codigo.test.ts`
 * —un barrido de texto sobre el propio repo— y vive acá solo por paquete.
 *
 * 🔴 Los tests de ROJO usan un `nucleo/` sintético en un directorio temporal. `backend-dev` declaró
 * esto como deuda ("un control que nunca se probó rojo no existe") y se cierra acá parametrizando
 * `directorio`/`ruta`/`version` en las tres funciones, en vez de dejarlo anotado.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aceptar, huellasDelMotor, leerLibro, verificar } from '../scripts/version-del-motor.ts';
import { VERSION_DEL_MOTOR } from '../src/nucleo/version.ts';

const temporales: string[] = [];

/** Un `nucleo/` sintético con 6 archivos, para poder ejercitar el rojo sin tocar el real. */
function nucleoSintetico(contenidos: Readonly<Record<string, string>>): { dir: string; libro: string } {
  const dir = mkdtempSync(join(tmpdir(), 'motor-'));
  temporales.push(dir);
  for (const [nombre, contenido] of Object.entries(contenidos)) {
    writeFileSync(join(dir, nombre), contenido, 'utf8');
  }
  return { dir, libro: join(dir, 'libro.json') };
}

const SEIS_ARCHIVOS: Readonly<Record<string, string>> = {
  'a.ts': 'export const a = 1;\n',
  'b.ts': 'export const b = 2;\n',
  'c.ts': 'export const c = 3;\n',
  'd.ts': 'export const d = 4;\n',
  'e.ts': 'export const e = 5;\n',
  'f.ts': 'export const f = 6;\n',
};

const MOTIVO = 'motivo de prueba con largo suficiente para pasar el minimo';

afterEach(() => {
  for (const dir of temporales.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('el contador manual del motor no puede fallar en silencio', () => {
  it('la huella real de nucleo/ coincide con el artefacto commiteado', () => {
    const r = verificar();
    expect(
      r,
      r.estado === 'rojo'
        ? `[${r.codigo}] ${r.detalle.join(', ')} — el codigo del motor cambio sin pasar por la ` +
          'aceptacion. Si el cambio PUEDE alterar un resultado, bumpea VERSION_DEL_MOTOR y corre ' +
          '`pnpm motor:version:aceptar`. Si demostrablemente NO puede (un docblock, un rename), ' +
          'corre `pnpm motor:version:aceptar --sin-bump --motivo "..."` — el motivo queda commiteado.'
        : '',
    ).toMatchObject({ estado: 'ok' });
  });

  // Anti-falso-verde: sin esto, un barrido roto pone el gate en verde escaneando cero archivos.
  it('se barren al menos 5 archivos de nucleo/ y todas las huellas tienen forma', () => {
    const huellas = huellasDelMotor();
    expect(huellas.size, 'no se esta barriendo packages/contabilidad/src/nucleo').toBeGreaterThan(4);
    for (const [nombre, h] of huellas) {
      expect(h, `huella mal formada para ${nombre}`).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  /**
   * 🔴 Las dos exclusiones son PROMESAS, no comodidad. Si mañana `catalogo.ts` entrara a la huella,
   * apendar un renglón de Santander obligaría a un bump global que invalida el histórico de Galicia
   * — la invalidación cruzada que el digest por banco existe para evitar.
   */
  it('catalogo.ts y version.ts NO entran a la huella, y el resto de nucleo/ SI', () => {
    const huellas = huellasDelMotor();
    expect(huellas.has('catalogo.ts'), 'catalogo.ts son DATOS: ya entra a digestDeBanco por banco').toBe(false);
    expect(huellas.has('version.ts'), 'version.ts es el que mide').toBe(false);
    for (const nombre of ['matcher.ts', 'normalizacion.ts', 'indice.ts', 'motor.ts', 'contrapartida.ts']) {
      expect(huellas.has(nombre), `${nombre} no entra a la huella del motor`).toBe(true);
    }
  });

  it('el libro es monotono y su ultima entrada es la version vigente', () => {
    const libro = leerLibro();
    expect(libro, 'falta packages/contabilidad/version-del-motor.json').toBeDefined();
    const entradas = libro?.entradas ?? [];
    for (let i = 1; i < entradas.length; i += 1) {
      expect(entradas[i]?.version).toBeGreaterThanOrEqual(entradas[i - 1]?.version ?? 0);
    }
    expect(entradas.at(-1)?.version).toBe(VERSION_DEL_MOTOR);
  });
});

describe('el trinquete se prueba EN ROJO, no solo en verde', () => {
  it('🔴 cambiar un archivo sin aceptar pone el gate en CODIGO_CAMBIADO_SIN_ACEPTAR', () => {
    const { dir, libro } = nucleoSintetico(SEIS_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', directorio: dir, ruta: libro, version: 1 });
    expect(verificar({ directorio: dir, ruta: libro, version: 1 })).toMatchObject({ estado: 'ok' });

    writeFileSync(join(dir, 'a.ts'), 'export const a = 999;\n', 'utf8');

    expect(verificar({ directorio: dir, ruta: libro, version: 1 })).toEqual({
      estado: 'rojo',
      codigo: 'CODIGO_CAMBIADO_SIN_ACEPTAR',
      detalle: ['a.ts'],
    });
  });

  it('🔴 un archivo NUEVO sin aceptar pone el gate en rojo — el fail-open que la exclusión evita', () => {
    const { dir, libro } = nucleoSintetico(SEIS_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', directorio: dir, ruta: libro, version: 1 });

    writeFileSync(join(dir, 'persistible.ts'), 'export const nuevo = 1;\n', 'utf8');

    expect(verificar({ directorio: dir, ruta: libro, version: 1 })).toEqual({
      estado: 'rojo',
      codigo: 'ARCHIVO_NUEVO_SIN_ACEPTAR',
      detalle: ['persistible.ts'],
    });
  });

  /**
   * 🔴 EL TEST QUE HACE QUE EL GATE VALGA. Sin el trinquete, aceptar sería la forma corta de poner
   * el gate en verde sin bumpear — el agujero original con una ceremonia encima.
   */
  it('🔴 aceptar un cambio SIN bump y SIN --sin-bump es RECHAZADO', () => {
    const { dir, libro } = nucleoSintetico(SEIS_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', directorio: dir, ruta: libro, version: 1 });
    writeFileSync(join(dir, 'a.ts'), 'export const a = 999;\n', 'utf8');

    expect(
      aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-02', directorio: dir, ruta: libro, version: 1 }),
      'sin esto, tocar el matcher y correr aceptar deja el gate verde sin bumpear',
    ).toEqual({ estado: 'rechazado', codigo: 'BUMP_FALTANTE' });

    // Y el libro NO se tocó: el rechazo es antes de escribir.
    expect(leerLibro(libro)?.entradas).toHaveLength(1);
  });

  it('con bump, el mismo cambio se acepta y apenda una entrada', () => {
    const { dir, libro } = nucleoSintetico(SEIS_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', directorio: dir, ruta: libro, version: 1 });
    writeFileSync(join(dir, 'a.ts'), 'export const a = 999;\n', 'utf8');

    expect(
      aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-02', directorio: dir, ruta: libro, version: 2 }),
    ).toMatchObject({ estado: 'aceptado', version: 2, bump: true });
    expect(leerLibro(libro)?.entradas).toHaveLength(2);
    expect(verificar({ directorio: dir, ruta: libro, version: 2 })).toMatchObject({ estado: 'ok' });
  });

  it('--sin-bump acepta el mismo cambio, y deja el motivo commiteado para que lo lea una persona', () => {
    const { dir, libro } = nucleoSintetico(SEIS_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', directorio: dir, ruta: libro, version: 1 });
    writeFileSync(join(dir, 'a.ts'), '// solo un comentario nuevo\nexport const a = 1;\n', 'utf8');

    const r = aceptar({
      sinBump: true,
      motivo: 'solo se agrego un comentario, no cambia ningun resultado del motor',
      hoy: '2026-01-02',
      directorio: dir,
      ruta: libro,
      version: 1,
    });
    expect(r).toMatchObject({ estado: 'aceptado', bump: false });

    const ultima = leerLibro(libro)?.entradas.at(-1);
    expect(ultima?.bump).toBe(false);
    expect(ultima?.motivo).toContain('comentario');
  });

  it('🔴 el trinquete no baja: una version menor a la ultima es RECHAZADA', () => {
    const { dir, libro } = nucleoSintetico(SEIS_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', directorio: dir, ruta: libro, version: 5 });
    writeFileSync(join(dir, 'a.ts'), 'export const a = 999;\n', 'utf8');

    expect(
      aceptar({ sinBump: true, motivo: MOTIVO, hoy: '2026-01-02', directorio: dir, ruta: libro, version: 4 }),
    ).toEqual({ estado: 'rechazado', codigo: 'VERSION_RETROCEDE' });
  });

  it('🔴 un motivo corto es rechazado sin escribir nada', () => {
    const { dir, libro } = nucleoSintetico(SEIS_ARCHIVOS);
    expect(aceptar({ sinBump: true, motivo: 'typo', hoy: '2026-01-01', directorio: dir, ruta: libro })).toEqual({
      estado: 'rechazado',
      codigo: 'MOTIVO_INSUFICIENTE',
    });
    expect(leerLibro(libro)).toBeUndefined();
  });

  it('🔴 un nucleo/ vacio NO pasa en verde — el anti-falso-verde del barrido', () => {
    const { dir, libro } = nucleoSintetico({ 'solo.ts': 'export const x = 1;\n' });
    expect(verificar({ directorio: dir, ruta: libro, version: 1 })).toMatchObject({
      estado: 'rojo',
      codigo: 'NUCLEO_VACIO',
    });
  });

  it('la constante y el libro tienen que coincidir', () => {
    const { dir, libro } = nucleoSintetico(SEIS_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', directorio: dir, ruta: libro, version: 1 });

    expect(verificar({ directorio: dir, ruta: libro, version: 7 })).toMatchObject({
      estado: 'rojo',
      codigo: 'VERSION_NO_COINCIDE_CON_EL_LIBRO',
    });
  });
});
