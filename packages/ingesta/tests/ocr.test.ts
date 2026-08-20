/**
 * `ocr.ts` — plan 15, paso 1 (retomado 2026-08-19).
 *
 * Todas las imágenes de este archivo son SINTÉTICAS (mismo criterio anti-fuga que el resto del
 * paquete): un rectángulo de un solo color, cabeceras armadas a mano. Nunca un byte de un documento
 * real.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dimensionesImagen, reconocerImagen, reconocerRecorte, ErrorDeOcr } from '../src/ocr.ts';
import type { PixelesDePagina } from '../src/texto-pdf.ts';

// -----------------------------------------------------------------------------
// `dimensionesImagen` — sin decodificar, solo cabecera.
// -----------------------------------------------------------------------------

describe('dimensionesImagen', () => {
  function bmp(ancho: number, alto: number): Uint8Array {
    const buffer = new Uint8Array(54);
    const vista = new DataView(buffer.buffer);
    buffer[0] = 0x42;
    buffer[1] = 0x4d;
    vista.setInt32(18, ancho, true);
    vista.setInt32(22, alto, true);
    return buffer;
  }

  it('lee ancho y alto de un BMP', () => {
    expect(dimensionesImagen(bmp(120, 80))).toEqual({ ancho: 120, alto: 80 });
  });

  it('un BMP top-down (alto negativo) devuelve la magnitud', () => {
    expect(dimensionesImagen(bmp(120, -80))).toEqual({ ancho: 120, alto: 80 });
  });

  it('lee ancho y alto de un JPEG (marcador SOF0)', () => {
    // SOI(FFD8) + APP0 mínimo (FFE0, largo 16) + SOF0(FFC0): largo=17, precisión=8, alto=00F0(240), ancho=0140(320).
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xf0, 0x01, 0x40, 0x03,
      0xff, 0xd9,
    ]);
    expect(dimensionesImagen(jpeg)).toEqual({ ancho: 320, alto: 240 });
  });

  it('un formato irreconocible da null, no un valor inventado', () => {
    expect(dimensionesImagen(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Límites ANTES de `recognize()`: se rechaza con código, nunca se procesa a ciegas.
// -----------------------------------------------------------------------------

describe('reconocerImagen — guardas de tamaño y dimensión', () => {
  it('rechaza una imagen vacía con `imagen_demasiado_grande`', async () => {
    await expect(reconocerImagen(new Uint8Array(0))).rejects.toMatchObject({
      codigo: 'imagen_demasiado_grande',
    });
  });

  it('rechaza un formato irreconocible con `formato_de_imagen_no_reconocido`', async () => {
    await expect(reconocerImagen(new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({
      codigo: 'formato_de_imagen_no_reconocido',
    });
  });

  it('rechaza dimensiones excesivas con `dimensiones_excesivas`, sin llegar a crear un worker', async () => {
    const buffer = new Uint8Array(54);
    const vista = new DataView(buffer.buffer);
    buffer[0] = 0x42;
    buffer[1] = 0x4d;
    vista.setInt32(18, 20000, true); // > MAX_DIMENSION_PX
    vista.setInt32(22, 20000, true);
    await expect(reconocerImagen(buffer)).rejects.toMatchObject({ codigo: 'dimensiones_excesivas' });
  });

  it('el error es un `ErrorDeOcr` con código, nunca un mensaje armado con el contenido', async () => {
    try {
      await reconocerImagen(new Uint8Array(0));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ErrorDeOcr);
      expect((e as ErrorDeOcr).codigo).toBe('imagen_demasiado_grande');
    }
  });
});

// -----------------------------------------------------------------------------
// `reconocerRecorte` — plan 16, paso 2. Rectángulo sintético de un solo color, nunca un documento real.
// -----------------------------------------------------------------------------

/** Un rectángulo gris parejo, 1 canal — mismo criterio anti-fuga que el resto del archivo. */
function pixelesSinteticos(width: number, height: number): PixelesDePagina {
  const data = new Uint8ClampedArray(width * height);
  data.fill(128);
  return { data, width, height, channels: 1 };
}

describe('reconocerRecorte', () => {
  it('recorta la banda [y0, y1) y termina en un reconocimiento real (caso feliz)', async () => {
    const pixeles = pixelesSinteticos(40, 80);
    const resultado = await reconocerRecorte(pixeles, 10, 50);
    expect(resultado.pagina).toBe(1);
    // Un rectángulo liso no tiene por qué reconocer palabras: lo que importa es que COMPLETÓ.
    expect(resultado.palabras).toEqual([]);
  }, 120_000);

  it.each([
    ['y0 negativo', -1, 10],
    ['y0 >= y1', 10, 5],
    ['y0 === y1 (banda vacía)', 10, 10],
    ['y1 fuera de rango (> height)', 0, 200],
    ['y0 no entero', 1.5, 10],
  ] as const)('rechaza la región inválida (%s) con region_de_recorte_invalida', async (_caso, y0, y1) => {
    const pixeles = pixelesSinteticos(40, 80);
    await expect(reconocerRecorte(pixeles, y0, y1)).rejects.toMatchObject({
      codigo: 'region_de_recorte_invalida',
    });
  });
});

// -----------------------------------------------------------------------------
// La condición de cierre de CLAUDE.md §1.4: reconocimiento REAL, con la red REALMENTE cortada.
// -----------------------------------------------------------------------------

/**
 * No alcanza con verificar que `langPath`/`corePath`/`workerPath` apuntan a rutas locales — eso prueba
 * la configuración, no el comportamiento. Este test corre `reconocerImagen()` de verdad, en un proceso
 * hijo cuyo `globalThis.fetch` fue reemplazado por una función que **lanza** (`guardia-sin-red.mjs`,
 * instalada vía `NODE_OPTIONS=--import=…`, que sí llega a los `worker_threads.Worker` que abre
 * `tesseract.js` en Node — verificado antes de escribir este archivo, ver el comentario del guard).
 *
 * La lógica que hace que esto sea una prueba real y no vacía: si `ocr.ts` estuviera mal configurado
 * —un typo en `langPath`, una versión de `tesseract.js` que dejara de respetar la opción— e intentara
 * bajar el idioma del CDN, la guardia lanzaría y el proceso hijo reportaría `ok: false`. Que reporte
 * `ok: true` es evidencia de que el reconocimiento se completó sin que ninguna de las tres rutas locales
 * fallara a la red.
 */
describe('ocr.ts nunca toca la red (CLAUDE.md §1.4)', () => {
  it('reconoce una imagen real con la red cortada, usando solo los paquetes locales', () => {
    const rutaScript = fileURLToPath(new URL('./soporte/reconocer-aislado.ts', import.meta.url));
    const rutaGuardia = fileURLToPath(new URL('./soporte/guardia-sin-red.mjs', import.meta.url));

    const salida = execFileSync(process.execPath, [rutaScript], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(rutaGuardia).href}`,
      },
      encoding: 'utf8',
      timeout: 120_000,
    });

    const resultado = JSON.parse(salida.trim()) as
      | { readonly ok: true; readonly pagina: number; readonly palabras: number }
      | { readonly ok: false; readonly mensaje: string };

    expect(resultado.ok, JSON.stringify(resultado)).toBe(true);
    if (resultado.ok) {
      expect(resultado.pagina).toBe(1);
      // Una imagen en blanco no tiene por qué reconocer palabras: lo que importa es que COMPLETÓ.
      expect(resultado.palabras).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);
});
