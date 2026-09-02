/**
 * Prueba de mutación puntual — `percepcion_iva_rg2408` con dos tasas en el mismo bloque, commit 2b del
 * plan 14 (visa-credito.ts). CLAUDE.md §1.8: una regla nueva se cierra probando que se rompe, con su
 * caso legítimo, no solo con el caso feliz.
 *
 * El riesgo real, señalado por `seguridad-datos-financieros` en la revisión de este plan: escribir
 * `pendientes.set(concepto, [total])` en vez de acumular
 * (`pendientes.set(concepto, [...(pendientes.get(concepto) ?? []), total])`) pisaría en silencio la
 * primera tasa de percepción con la segunda — `renglones` tendría UN solo renglón de
 * `percepcion_iva_rg2408` en vez de dos, sin ningún error visible.
 *
 * Este archivo prueba el caso legítimo (dos tasas → dos renglones, en orden) contra el código real de
 * `acumularPendiente`. La mutación en sí —volver a `.set(concepto, [total])` sin spread— se aplicó a
 * mano sobre `visa-credito.ts` en esta sesión y se confirmó que este mismo test se pone en rojo (un
 * solo renglón en vez de dos); se revirtió antes de cerrar el commit, así que el código que queda en
 * el árbol es el correcto y este test es lo que lo mantiene así.
 *
 * 100% SINTÉTICO — sin el documento real, mismo criterio que `liquidaciones-visa-debito-reintento.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { leerVisaCredito } from '../src/liquidaciones/formatos/visa-credito.ts';
import { liquidacionLeidaSchema } from '../src/liquidaciones/esquema.ts';
import type { EntradaDeLiquidacion } from '../src/liquidaciones/registro.ts';
import type { PalabraOcr, PaginaOcr } from '../src/ocr.ts';
import type { PixelesDePagina } from '../src/texto-pdf.ts';

function palabra(texto: string, x: number, y: number, confianza = 95): PalabraOcr {
  return { texto, x, y, ancho: texto.length * 8, alto: 18, confianza };
}

/** Espaciado entre filas de un mismo bloque: bien por encima de `TOLERANCIA_FILA_OCR` (20px). */
const PASO_FILA = 45;

function filaVentaContado(y: number): PalabraOcr[] {
  return [palabra('VENTA', 100, y), palabra('CONTADO', 260, y), palabra('1.847,90', 900, y)];
}

function filaVentaCuota(y: number): PalabraOcr[] {
  return [palabra('VENTA', 100, y), palabra('A', 220, y), palabra('CUOTAS', 280, y), palabra('500,00', 900, y)];
}

/** Dos tasas de percepción IVA, cada una en su propia fila — es el caso medido del documento real. */
function filaPercepcionTasaUno(y: number): PalabraOcr[] {
  return [
    palabra('PERCEPCION', 100, y),
    palabra('IVA', 320, y),
    palabra('RG', 400, y),
    palabra('2408', 460, y),
    palabra('1,50', 700, y),
    palabra('22,50', 900, y),
  ];
}

function filaPercepcionTasaDos(y: number): PalabraOcr[] {
  return [
    palabra('PERCEPCION', 100, y),
    palabra('IVA', 320, y),
    palabra('RG', 400, y),
    palabra('2408', 460, y),
    palabra('3,00', 700, y),
    palabra('45,00', 900, y),
  ];
}

function filaNeto(y: number): PalabraOcr[] {
  return [
    palabra('IMPORTE', 100, y),
    palabra('NETO', 260, y),
    palabra('DE', 380, y),
    palabra('PAGOS', 460, y),
    palabra('1.400,00', 900, y),
  ];
}

function filaCierre(y: number): PalabraOcr[] {
  return [
    palabra('ACRED', 100, y),
    palabra('EN', 230, y),
    palabra('CBU', 290, y),
    palabra('PAGO', 370, y),
    palabra('19/08/2026', 500, y),
    palabra('00012345', 700, y),
    palabra('20/08/2026', 900, y),
  ];
}

function bloqueConDosPercepciones(y0: number): PalabraOcr[] {
  return [
    ...filaVentaContado(y0),
    ...filaVentaCuota(y0 + PASO_FILA),
    ...filaPercepcionTasaUno(y0 + PASO_FILA * 2),
    ...filaPercepcionTasaDos(y0 + PASO_FILA * 3),
    ...filaNeto(y0 + PASO_FILA * 4),
    ...filaCierre(y0 + PASO_FILA * 5),
  ];
}

function entradaDeUnaPagina(palabras: readonly PalabraOcr[]): EntradaDeLiquidacion {
  const pagina: PaginaOcr = { pagina: 1, palabras };
  const pixeles: PixelesDePagina = { data: new Uint8ClampedArray(0), width: 1000, height: 20_000, channels: 3 };
  return { paginas: [pagina], usoOcrEnPagina: [true], pixelesDePagina: [pixeles] };
}

describe('percepción IVA con dos tasas — acumulación sin pisar (sintético, sin documento real)', () => {
  it('un bloque con dos líneas de percepción produce DOS renglones, en el orden en que se leyeron', async () => {
    const entrada = entradaDeUnaPagina(bloqueConDosPercepciones(0));

    const salida = await leerVisaCredito(entrada);

    expect(salida.liquidaciones).toHaveLength(1);
    const liquidacion = salida.liquidaciones[0];
    expect(liquidacion).toBeDefined();
    expect(liquidacionLeidaSchema.safeParse(liquidacion).success).toBe(true);
    if (!liquidacion) return;

    const percepciones = liquidacion.renglones.filter((r) => r.concepto === 'percepcion_iva_rg2408');
    // La aserción que la mutación (`.set(concepto, [total])` sin spread) pone en rojo: con la mutación
    // plantada, esto da 1 (la segunda tasa pisa a la primera), no 2.
    expect(percepciones).toHaveLength(2);

    // Orden preservado: la primera tasa leída es la primera del arreglo, nunca reordenada por valor.
    expect(percepciones[0]?.alicuotaPublicada).toEqual({ estado: 'publicado', valor: '1.50' });
    expect(percepciones[1]?.alicuotaPublicada).toEqual({ estado: 'publicado', valor: '3.00' });
  });

  it('un bloque con una sola línea de percepción produce UN renglón (caso legítimo, sin dos tasas)', async () => {
    const y0 = 0;
    const palabras = [
      ...filaVentaContado(y0),
      ...filaPercepcionTasaUno(y0 + PASO_FILA),
      ...filaNeto(y0 + PASO_FILA * 2),
      ...filaCierre(y0 + PASO_FILA * 3),
    ];
    const entrada = entradaDeUnaPagina(palabras);

    const salida = await leerVisaCredito(entrada);

    expect(salida.liquidaciones).toHaveLength(1);
    const percepciones = salida.liquidaciones[0]?.renglones.filter(
      (r) => r.concepto === 'percepcion_iva_rg2408',
    );
    expect(percepciones).toHaveLength(1);
  });
});
