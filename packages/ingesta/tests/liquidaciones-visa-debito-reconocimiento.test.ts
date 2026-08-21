/**
 * `reconoceVisaDebito` — prueba de mutación puntual, HANDOFF 88/91/92. CLAUDE.md §1.8: una regla nueva
 * se cierra probando que se rompe, con su caso legítimo, no solo con el caso feliz.
 *
 * El bug real: `reconoceVisaDebito` usaba `MARCAS.some(...)` (OR) entre la marca genérica ("RESUMEN
 * MENSUAL DE LIQUIDACIONES A COMERCIOS", que aparece en los dos formatos) y la marca específica de
 * débito — así que la marca genérica sola alcanzaba para reconocer un documento de CRÉDITO real como
 * débito. `reconoceVisaCredito` (`visa-credito.ts`) siempre exigió AND; el fix replica ese mismo
 * patrón acá.
 *
 * **La mutación se aplicó a mano sobre `visa-debito.ts` en esta sesión** (volver a
 * `MARCAS.some((m) => m.test(texto))` con `MARCAS = [MARCA_GENERICA, MARCA_DEBITO]`) y se confirmó que
 * el primer test de este archivo se pone en rojo (`reconoceVisaDebito` da `true` sobre el texto de
 * crédito simulado, cuando debería dar `false`); se revirtió antes de cerrar el commit, así que el
 * código que queda en el árbol es el correcto y este test es lo que lo mantiene así.
 *
 * 100% SINTÉTICO — el texto de las marcas es vocabulario del FORMATO Visa (igual para todo comercio,
 * impreso por el emisor), nunca un dato de cliente. Mismo criterio que
 * `liquidaciones-visa-credito-percepcion.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { reconoceVisaDebito } from '../src/liquidaciones/formatos/visa-debito.ts';
import type { EntradaDeLiquidacion } from '../src/liquidaciones/registro.ts';
import type { PalabraOcr, PaginaOcr } from '../src/ocr.ts';
import type { PixelesDePagina } from '../src/texto-pdf.ts';

function palabra(texto: string, x: number, y: number, confianza = 95): PalabraOcr {
  return { texto, x, y, ancho: texto.length * 8, alto: 18, confianza };
}

/** La marca genérica: aparece igual en los dos formatos Visa, nunca alcanza sola. */
function palabrasMarcaGenerica(y: number, xInicial = 100): PalabraOcr[] {
  const palabras = 'RESUMEN MENSUAL DE LIQUIDACIONES A COMERCIOS'.split(' ');
  return palabras.map((p, i) => palabra(p, xInicial + i * 120, y));
}

function palabrasMarcaCredito(y: number): PalabraOcr[] {
  return ['TARJETA', 'DE', 'CREDITO', 'PESOS'].map((p, i) => palabra(p, 100 + i * 120, y));
}

function palabrasMarcaDebito(y: number): PalabraOcr[] {
  return ['TARJETA', 'DE', 'DEBITO', 'PESOS'].map((p, i) => palabra(p, 100 + i * 120, y));
}

function entradaDeUnaPagina(palabras: readonly PalabraOcr[]): EntradaDeLiquidacion {
  const pagina: PaginaOcr = { pagina: 1, palabras };
  const pixeles: PixelesDePagina = { data: new Uint8ClampedArray(0), width: 1000, height: 2000, channels: 3 };
  return { paginas: [pagina], usoOcrEnPagina: [true], pixelesDePagina: [pixeles] };
}

describe('reconoceVisaDebito — AND entre marca genérica y marca específica, no OR (sintético)', () => {
  it('un documento de CRÉDITO real (marca genérica + marca de crédito) NO se reconoce como débito', () => {
    const palabras = [...palabrasMarcaGenerica(100), ...palabrasMarcaCredito(200)];
    const entrada = entradaDeUnaPagina(palabras);

    // La aserción que la mutación (MARCAS.some(...) con la marca genérica sola) pone en rojo: con la
    // mutación plantada, esto da `true` — un documento de crédito se reconocería como débito.
    expect(reconoceVisaDebito(entrada)).toBe(false);
  });

  it('un documento de DÉBITO real (marca genérica + marca de débito) SÍ se reconoce (caso legítimo, sin regresión)', () => {
    const palabras = [...palabrasMarcaGenerica(100), ...palabrasMarcaDebito(200)];
    const entrada = entradaDeUnaPagina(palabras);

    expect(reconoceVisaDebito(entrada)).toBe(true);
  });

  it('solo la marca genérica, sin ninguna marca específica, NO se reconoce', () => {
    const entrada = entradaDeUnaPagina(palabrasMarcaGenerica(100));
    expect(reconoceVisaDebito(entrada)).toBe(false);
  });

  it('solo la marca de débito, sin la marca genérica, NO se reconoce', () => {
    const entrada = entradaDeUnaPagina(palabrasMarcaDebito(100));
    expect(reconoceVisaDebito(entrada)).toBe(false);
  });
});
