/**
 * Reintento de OCR para `neto_acreditado` — plan 16, paso 3. Sintético, sin el documento real: prueba
 * el ENGANCHE de `leerVisaDebito` (cuándo se dispara, qué pasa si el reintento tira, el tope por
 * documento), no la calidad del reconocimiento — eso ya lo cubre `liquidaciones-visa-debito.test.ts`
 * contra el documento real.
 *
 * `reconocerRecorte` se mockea acá — STUB explícito, nunca Tesseract real — porque lo que se prueba es
 * la lógica de `leerVisaDebito`/`reintentarNetoAcreditado`, no el motor de OCR. Separado del test del
 * documento real a propósito: mockear el módulo `../src/ocr.ts` acá no puede interferir con el test que
 * sí corre el pipeline completo.
 *
 * Todos los valores (importes, fechas, número de liquidación) son SINTÉTICOS — mismo criterio que
 * `parseo-ar.ts`.
 *
 * `vi.mock` se hoistea al principio del archivo (transform de Vitest), así que el orden textual con los
 * `import` de abajo no importa en tiempo de ejecución.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  leerVisaDebito,
  TOPE_REINTENTOS_NETO_POR_DOCUMENTO,
} from '../src/liquidaciones/formatos/visa-debito.ts';
import { liquidacionLeidaSchema } from '../src/liquidaciones/esquema.ts';
import type { EntradaDeLiquidacion } from '../src/liquidaciones/registro.ts';
import type { PalabraOcr, PaginaOcr } from '../src/ocr.ts';
import type { PixelesDePagina } from '../src/texto-pdf.ts';

const reconocerRecorteMock = vi.fn();
vi.mock('../src/ocr.ts', () => ({
  reconocerRecorte: (...args: unknown[]) => reconocerRecorteMock(...args),
}));

// -----------------------------------------------------------------------------
// Fixture sintético: un bloque de liquidación completo, con control fila-por-fila.
// -----------------------------------------------------------------------------

function palabra(texto: string, x: number, y: number, confianza = 95): PalabraOcr {
  return { texto, x, y, ancho: texto.length * 8, alto: 18, confianza };
}

/** Espaciado entre filas de un mismo bloque: bien por encima de `TOLERANCIA_FILA_OCR` (20px). */
const PASO_FILA = 45;
/** Espaciado entre bloques: bien por encima de la altura de un bloque, para no fusionar filas. */
const PASO_BLOQUE = 250;

function filaVentas(y: number): PalabraOcr[] {
  return [
    palabra('VENTAS', 100, y),
    palabra('C/DESCUENTO', 260, y),
    palabra('CONTADO', 430, y),
    palabra('1.000,00', 900, y),
  ];
}

function filaArancel(y: number, valido: boolean): PalabraOcr[] {
  const base = [palabra('ARANCEL', 100, y)];
  // Sin coma decimal ni separador de miles: `parsearImporte` lo rechaza (dígitos pelados) — mismo
  // patrón de falla que el documento real (HANDOFF 81).
  return valido ? [...base, palabra('50,00', 900, y)] : [...base, palabra('50000', 900, y)];
}

function filaNeto(y: number, valido: boolean): PalabraOcr[] {
  const base = [
    palabra('IMPORTE', 100, y),
    palabra('NETO', 260, y),
    palabra('DE', 380, y),
    palabra('PAGOS', 460, y),
  ];
  return valido ? [...base, palabra('950,00', 900, y)] : [...base, palabra('95000', 900, y)];
}

function filaCierre(y: number, numero: string): PalabraOcr[] {
  return [
    palabra('ACRED', 100, y),
    palabra('EN', 230, y),
    palabra('CBU', 290, y),
    palabra('PAGO', 370, y),
    palabra('19/08/2026', 500, y),
    palabra(numero, 700, y),
    palabra('20/08/2026', 900, y),
  ];
}

/**
 * Un bloque completo (ventas, arancel, neto, cierre). `netoValido`/`arancelValido` controlan si esa
 * línea trae un importe con forma válida en la primera lectura (sin reintento).
 */
function bloque(
  y0: number,
  opciones: { readonly netoValido?: boolean; readonly arancelValido?: boolean; readonly numero?: string } = {},
): PalabraOcr[] {
  return [
    ...filaVentas(y0),
    ...filaArancel(y0 + PASO_FILA, opciones.arancelValido ?? true),
    ...filaNeto(y0 + PASO_FILA * 2, opciones.netoValido ?? false),
    ...filaCierre(y0 + PASO_FILA * 3, opciones.numero ?? '00012345'),
  ];
}

function pixelesDeMuestra(height = 20_000): PixelesDePagina {
  return { data: new Uint8ClampedArray(0), width: 1000, height, channels: 3 };
}

function entradaDeUnaPagina(palabras: readonly PalabraOcr[]): EntradaDeLiquidacion {
  const pagina: PaginaOcr = { pagina: 1, palabras };
  return {
    paginas: [pagina],
    usoOcrEnPagina: [true],
    pixelesDePagina: [pixelesDeMuestra()],
  };
}

// -----------------------------------------------------------------------------

describe('reintento de neto_acreditado — enganche en leerVisaDebito (sintético, sin documento real)', () => {
  it('el reintento SOLO se dispara para neto_acreditado: un arancel sin monto no llama a reconocerRecorte', async () => {
    reconocerRecorteMock.mockReset();
    // arancel falla (sin forma de importe), neto y el resto del bloque son válidos: no debería haber
    // ningún reintento en todo el documento.
    const entrada = entradaDeUnaPagina(bloque(0, { arancelValido: false, netoValido: true }));

    const salida = await leerVisaDebito(entrada);

    expect(reconocerRecorteMock).not.toHaveBeenCalled();
    expect(salida.liquidaciones).toHaveLength(1);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'renglon_sin_monto')).toBe(true);
    expect(salida.topeDeReintentosAlcanzado).toBeUndefined();
  });

  it('neto_acreditado sin monto SÍ dispara el reintento, y un recorte válido recupera la liquidación', async () => {
    reconocerRecorteMock.mockReset();
    reconocerRecorteMock.mockResolvedValueOnce({
      pagina: 1,
      palabras: [palabra('950,00', 900, 90, 91)],
    } satisfies PaginaOcr);
    const entrada = entradaDeUnaPagina(bloque(0, { netoValido: false }));

    const salida = await leerVisaDebito(entrada);

    expect(reconocerRecorteMock).toHaveBeenCalledTimes(1);
    // La banda pedida está anclada en `fila.y` del renglón de neto, dentro de `[0, altura de página]`.
    const [pixelesArg, y0Arg, y1Arg] = reconocerRecorteMock.mock.calls[0] as [PixelesDePagina, number, number];
    expect(pixelesArg).toBeDefined();
    expect(y0Arg).toBeGreaterThanOrEqual(0);
    expect(y1Arg).toBeGreaterThan(y0Arg);

    expect(salida.liquidaciones).toHaveLength(1);
    expect(salida.lineasNoInterpretadas).toHaveLength(0);
    expect(liquidacionLeidaSchema.safeParse(salida.liquidaciones[0]).success).toBe(true);
  });

  it('una excepción del reintento no aborta el documento: las demás liquidaciones se siguen devolviendo', async () => {
    reconocerRecorteMock.mockReset();
    // Primer bloque: el reintento tira (cualquier excepción, incluido un `ErrorDeOcr` real, se trata
    // igual). Segundo bloque: el reintento recupera un importe válido.
    reconocerRecorteMock.mockRejectedValueOnce(new Error('falla simulada de tesseract'));
    reconocerRecorteMock.mockResolvedValueOnce({
      pagina: 1,
      palabras: [palabra('950,00', 900, 90, 91)],
    } satisfies PaginaOcr);

    const entrada = entradaDeUnaPagina([
      ...bloque(0, { netoValido: false, numero: '00011111' }),
      ...bloque(PASO_BLOQUE, { netoValido: false, numero: '00022222' }),
    ]);

    const salida = await leerVisaDebito(entrada);

    // No debe lanzar: si `reintentarNetoAcreditado` propagara, `await leerVisaDebito` habría rechazado
    // antes de esta línea.
    expect(reconocerRecorteMock).toHaveBeenCalledTimes(2);
    expect(salida.liquidaciones).toHaveLength(1); // solo el segundo bloque se recuperó
    expect(
      salida.lineasNoInterpretadas.filter((l) => l.codigo === 'bloque_de_totales_no_interpretado'),
    ).toHaveLength(1); // el primero queda incompleto, reportado, nunca descartado en silencio
    expect(salida.topeDeReintentosAlcanzado).toBeUndefined();
  });

  it('al alcanzar el tope de reintentos por documento, deja de intentar reintentos nuevos', async () => {
    reconocerRecorteMock.mockReset();
    // Stub liviano: siempre "no encontró nada" — ningún Tesseract real, corre rápido incluso con
    // varias decenas de bloques.
    reconocerRecorteMock.mockResolvedValue({ pagina: 1, palabras: [] } satisfies PaginaOcr);

    const cantidadDeBloques = TOPE_REINTENTOS_NETO_POR_DOCUMENTO + 5;
    const palabras = Array.from({ length: cantidadDeBloques }, (_, i) =>
      bloque(i * PASO_BLOQUE, { netoValido: false, numero: String(100000 + i) }),
    ).flat();
    const entrada = entradaDeUnaPagina(palabras);

    const salida = await leerVisaDebito(entrada);

    // El contador cuenta INTENTOS (cada llamada, éxito o fracaso) — se corta en el tope, no antes ni
    // después, aunque el documento tenga más bloques que dispararían un reintento.
    expect(reconocerRecorteMock).toHaveBeenCalledTimes(TOPE_REINTENTOS_NETO_POR_DOCUMENTO);
    expect(salida.topeDeReintentosAlcanzado).toBe(true);
    // Ninguna liquidación se recuperó (el stub nunca devuelve un importe): todas quedan reportadas,
    // ninguna se descarta en silencio.
    expect(salida.liquidaciones).toHaveLength(0);
    expect(
      salida.lineasNoInterpretadas.filter((l) => l.codigo === 'bloque_de_totales_no_interpretado'),
    ).toHaveLength(cantidadDeBloques);
  });
});
