/**
 * EL GATE DE `VERSION_DEL_EXTRACTOR`. Calcado de
 * `packages/contabilidad/tests/version-del-motor.test.ts` — ver ese archivo y
 * `../src/version-extraccion.ts` para el porqué completo.
 *
 * Corre en `pnpm test` y por lo tanto en CI. No va como paso de `pnpm verificar` por el mismo motivo
 * que el del motor: `.github/workflows/ci.yml` corre los pasos SUELTOS.
 *
 * 🔴 Los tests de ROJO usan un mapa nombre→ruta SINTÉTICO en un directorio temporal — nunca tocan
 * `glosa.ts`/`contraparte.ts`/`detectores-forma.ts` reales. Un control que nunca se probó rojo no
 * existe.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aceptar,
  huellasDelExtractor,
  leerLibro,
  verificar,
} from '../scripts/version-del-extractor.ts';
import { VERSION_DEL_EXTRACTOR } from '../src/version-extraccion.ts';

const temporales: string[] = [];

/** Un mapa sintético de TRES archivos, para poder ejercitar el rojo sin tocar los reales. */
function extractorSintetico(contenidos: Readonly<Record<string, string>>): {
  archivos: ReadonlyMap<string, string>;
  libro: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'extractor-'));
  temporales.push(dir);
  const archivos = new Map<string, string>();
  for (const [nombre, contenido] of Object.entries(contenidos)) {
    const ruta = join(dir, nombre);
    writeFileSync(ruta, contenido, 'utf8');
    archivos.set(nombre, ruta);
  }
  return { archivos, libro: join(dir, 'libro.json') };
}

const TRES_ARCHIVOS: Readonly<Record<string, string>> = {
  'glosa.ts': 'export const a = 1;\n',
  'contraparte.ts': 'export const b = 2;\n',
  'detectores-forma.ts': 'export const c = 3;\n',
};

const MOTIVO = 'motivo de prueba con largo suficiente para pasar el minimo';

afterEach(() => {
  for (const dir of temporales.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('el contador manual del extractor no puede fallar en silencio', () => {
  it('la huella real de glosa.ts/contraparte.ts/detectores-forma.ts coincide con el artefacto commiteado', () => {
    const r = verificar();
    expect(
      r,
      r.estado === 'rojo'
        ? `[${r.codigo}] ${r.detalle.join(', ')} — el codigo del extractor cambio sin pasar por la ` +
          'aceptacion. Si el cambio PUEDE alterar un resultado, bumpea VERSION_DEL_EXTRACTOR y corre ' +
          '`pnpm extractor:version:aceptar`. Si demostrablemente NO puede (un docblock, un rename), ' +
          'corre `pnpm extractor:version:aceptar --sin-bump --motivo "..."` — el motivo queda commiteado.'
        : '',
    ).toMatchObject({ estado: 'ok' });
  });

  // Anti-falso-verde: sin esto, un mapa roto pone el gate en verde con cero archivos.
  it('se barren los 3 archivos del pipeline y todas las huellas tienen forma', () => {
    const huellas = huellasDelExtractor();
    expect(huellas.size, 'no se estan barriendo los archivos del extractor').toBe(3);
    for (const [nombre, h] of huellas) {
      expect(h, `huella mal formada para ${nombre}`).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('los TRES archivos del pipeline entran a la huella, por su nombre exacto', () => {
    const huellas = huellasDelExtractor();
    for (const nombre of ['glosa.ts', 'contraparte.ts', 'detectores-forma.ts']) {
      expect(huellas.has(nombre), `${nombre} no entra a la huella del extractor`).toBe(true);
    }
  });

  it('el libro es monotono y su ultima entrada es la version vigente', () => {
    const libro = leerLibro();
    expect(libro, 'falta packages/ingesta/version-del-extractor.json').toBeDefined();
    const entradas = libro?.entradas ?? [];
    for (let i = 1; i < entradas.length; i += 1) {
      expect(entradas[i]?.version).toBeGreaterThanOrEqual(entradas[i - 1]?.version ?? 0);
    }
    expect(entradas.at(-1)?.version).toBe(VERSION_DEL_EXTRACTOR);
  });
});

describe('el trinquete se prueba EN ROJO, no solo en verde', () => {
  it('🔴 cambiar un archivo sin aceptar pone el gate en CODIGO_CAMBIADO_SIN_ACEPTAR', () => {
    const { archivos, libro } = extractorSintetico(TRES_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', archivos, ruta: libro, version: 1 });
    expect(verificar({ archivos, ruta: libro, version: 1 })).toMatchObject({ estado: 'ok' });

    writeFileSync(archivos.get('glosa.ts') as string, 'export const a = 999;\n', 'utf8');

    expect(verificar({ archivos, ruta: libro, version: 1 })).toEqual({
      estado: 'rojo',
      codigo: 'CODIGO_CAMBIADO_SIN_ACEPTAR',
      detalle: ['glosa.ts'],
    });
  });

  it('🔴 un archivo NUEVO sin aceptar pone el gate en rojo — el fail-open que este gate existe para cerrar', () => {
    const { archivos, libro } = extractorSintetico(TRES_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', archivos, ruta: libro, version: 1 });

    const dirDeGlosa = join(archivos.get('glosa.ts') as string, '..');
    const rutaNueva = join(dirDeGlosa, 'nuevo-archivo.ts');
    writeFileSync(rutaNueva, 'export const nuevo = 1;\n', 'utf8');
    const archivosAmpliados = new Map(archivos);
    archivosAmpliados.set('nuevo-archivo.ts', rutaNueva);

    expect(verificar({ archivos: archivosAmpliados, ruta: libro, version: 1 })).toEqual({
      estado: 'rojo',
      codigo: 'ARCHIVO_NUEVO_SIN_ACEPTAR',
      detalle: ['nuevo-archivo.ts'],
    });
  });

  /**
   * 🔴 EL TEST QUE HACE QUE EL GATE VALGA. Sin el trinquete, aceptar sería la forma corta de poner
   * el gate en verde sin bumpear — el agujero original con una ceremonia encima.
   */
  it('🔴 aceptar un cambio SIN bump y SIN --sin-bump es RECHAZADO', () => {
    const { archivos, libro } = extractorSintetico(TRES_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', archivos, ruta: libro, version: 1 });
    writeFileSync(archivos.get('glosa.ts') as string, 'export const a = 999;\n', 'utf8');

    expect(
      aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-02', archivos, ruta: libro, version: 1 }),
      'sin esto, tocar un detector y correr aceptar deja el gate verde sin bumpear',
    ).toEqual({ estado: 'rechazado', codigo: 'BUMP_FALTANTE' });

    // Y el libro NO se tocó: el rechazo es antes de escribir.
    expect(leerLibro(libro)?.entradas).toHaveLength(1);
  });

  it('con bump, el mismo cambio se acepta y apenda una entrada', () => {
    const { archivos, libro } = extractorSintetico(TRES_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', archivos, ruta: libro, version: 1 });
    writeFileSync(archivos.get('glosa.ts') as string, 'export const a = 999;\n', 'utf8');

    expect(
      aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-02', archivos, ruta: libro, version: 2 }),
    ).toMatchObject({ estado: 'aceptado', version: 2, bump: true });
    expect(leerLibro(libro)?.entradas).toHaveLength(2);
    expect(verificar({ archivos, ruta: libro, version: 2 })).toMatchObject({ estado: 'ok' });
  });

  it('--sin-bump acepta el mismo cambio, y deja el motivo commiteado para que lo lea una persona', () => {
    const { archivos, libro } = extractorSintetico(TRES_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', archivos, ruta: libro, version: 1 });
    writeFileSync(archivos.get('glosa.ts') as string, '// solo un comentario nuevo\nexport const a = 1;\n', 'utf8');

    const r = aceptar({
      sinBump: true,
      motivo: 'solo se agrego un comentario, no cambia ningun resultado del extractor',
      hoy: '2026-01-02',
      archivos,
      ruta: libro,
      version: 1,
    });
    expect(r).toMatchObject({ estado: 'aceptado', bump: false });

    const ultima = leerLibro(libro)?.entradas.at(-1);
    expect(ultima?.bump).toBe(false);
    expect(ultima?.motivo).toContain('comentario');
  });

  it('🔴 el trinquete no baja: una version menor a la ultima es RECHAZADA', () => {
    const { archivos, libro } = extractorSintetico(TRES_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', archivos, ruta: libro, version: 5 });
    writeFileSync(archivos.get('glosa.ts') as string, 'export const a = 999;\n', 'utf8');

    expect(
      aceptar({ sinBump: true, motivo: MOTIVO, hoy: '2026-01-02', archivos, ruta: libro, version: 4 }),
    ).toEqual({ estado: 'rechazado', codigo: 'VERSION_RETROCEDE' });
  });

  it('🔴 un motivo corto es rechazado sin escribir nada', () => {
    const { archivos, libro } = extractorSintetico(TRES_ARCHIVOS);
    expect(aceptar({ sinBump: true, motivo: 'typo', hoy: '2026-01-01', archivos, ruta: libro })).toEqual({
      estado: 'rechazado',
      codigo: 'MOTIVO_INSUFICIENTE',
    });
    expect(leerLibro(libro)).toBeUndefined();
  });

  it('🔴 un mapa con menos de 3 archivos NO pasa en verde — el anti-falso-verde del barrido', () => {
    const { archivos, libro } = extractorSintetico({ 'solo.ts': 'export const x = 1;\n' });
    expect(verificar({ archivos, ruta: libro, version: 1 })).toMatchObject({
      estado: 'rojo',
      codigo: 'EXTRACTOR_VACIO',
    });
  });

  it('la constante y el libro tienen que coincidir', () => {
    const { archivos, libro } = extractorSintetico(TRES_ARCHIVOS);
    aceptar({ sinBump: false, motivo: MOTIVO, hoy: '2026-01-01', archivos, ruta: libro, version: 1 });

    expect(verificar({ archivos, ruta: libro, version: 7 })).toMatchObject({
      estado: 'rojo',
      codigo: 'VERSION_NO_COINCIDE_CON_EL_LIBRO',
    });
  });
});
