/**
 * Prueba de mutación puntual — `arancel`/`iva_21_sobre_arancel` en `cabal-debito.ts`, sin el filtro de
 * pipe/corchete que usa `visa-credito.ts`. CLAUDE.md §1.8: una regla nueva se cierra probando que se
 * rompe, con su caso legítimo, no solo con el caso feliz.
 *
 * Condición de `security-engineer` (dictamen previo a este commit, "verde con condiciones"): al no
 * llevar el filtro estructural, la única red contra un falso positivo es el propio vocabulario — hace
 * falta el test que la pruebe, no que la asuma.
 *
 * Dos riesgos distintos, y por eso dos casos:
 *
 * 1. **Confusión arancel↔IVA.** La etiqueta de IVA en este formato contiene la palabra completa
 *    `ARANCEL` (a diferencia de Visa, que usa la forma abreviada `ARANC`) — sin la exclusión
 *    `!t.includes('IVA')` en la condición de `arancel`, la fila de IVA matchearía PRIMERO como
 *    `arancel` (el orden de `LINEAS_DE_TOTAL`) y `iva_21_sobre_arancel` nunca se capturaría. La
 *    mutación (sacar `!t.includes('IVA')` de `cabal-debito.ts`) se aplicó a mano sobre el código en esta
 *    sesión y se confirmó que el primer test de este archivo se pone en rojo (falta el renglón de IVA);
 *    se revirtió antes de cerrar el commit, así que el código que queda en el árbol es el correcto y
 *    este test es lo que lo mantiene así.
 * 2. **Ruido con la palabra `ARANCEL` sin ser una línea de total real** (encabezado de columna de la
 *    tabla de comprobantes, medido en el documento real: contiene `VENTA`/`IVA` sin ningún importe). Sin
 *    importe, `leerLineaDeTotal` devuelve `null` y la fila cae en `renglon_sin_monto` — nunca entra a
 *    `pendientes`, nunca pisa un total real ya capturado.
 *
 * 100% SINTÉTICO — sin el documento real, mismo criterio que `liquidaciones-visa-credito-percepcion.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { leerCabalDebito } from '../src/liquidaciones/formatos/cabal-debito.ts';
import { liquidacionLeidaSchema } from '../src/liquidaciones/esquema.ts';
import type { EntradaDeLiquidacion } from '../src/liquidaciones/registro.ts';
import type { PalabraOcr, PaginaOcr } from '../src/ocr.ts';
import type { PixelesDePagina } from '../src/texto-pdf.ts';

function palabra(texto: string, x: number, y: number, confianza = 95): PalabraOcr {
  return { texto, x, y, ancho: texto.length * 8, alto: 18, confianza };
}

/** Espaciado entre filas de un mismo bloque: bien por encima de `TOLERANCIA_FILA_OCR` (20px). */
const PASO_FILA = 45;

function filaEncabezadoDeColumna(y: number): PalabraOcr[] {
  // Ruido medido en el documento real: encabezado de la tabla de comprobantes, trae VENTA y IVA como
  // etiquetas de columna, sin ningún importe.
  return [palabra('DTO', 100, y), palabra('ARANCEL', 200, y), palabra('DTO', 400, y), palabra('IVA', 500, y)];
}

function filaVentaTotal(y: number, monto: string): PalabraOcr[] {
  return [palabra('VENTA', 100, y), palabra('TOTAL', 260, y), palabra(monto, 900, y)];
}

function filaArancel(y: number, tasa: string, monto: string): PalabraOcr[] {
  return [palabra('ARANCEL', 100, y), palabra(tasa, 700, y), palabra(monto, 900, y)];
}

function filaIvaSobreArancel(y: number, tasa: string, monto: string): PalabraOcr[] {
  return [
    palabra('IVA', 100, y),
    palabra('S/ARANCEL', 260, y),
    palabra(tasa, 700, y),
    palabra(monto, 900, y),
  ];
}

function filaRetencion(y: number, tasa: string, monto: string): PalabraOcr[] {
  return [
    palabra('RETENCION', 100, y),
    palabra('INGRESOS', 260, y),
    palabra('BRUTOS', 400, y),
    palabra('SIRTAC', 520, y),
    palabra(tasa, 700, y),
    palabra(monto, 900, y),
  ];
}

function filaNeto(y: number, monto: string): PalabraOcr[] {
  return [palabra('NETO', 100, y), palabra('FINAL', 260, y), palabra('LIQUIDAR', 400, y), palabra(monto, 900, y)];
}

function filaCierre(y: number): PalabraOcr[] {
  return [
    palabra('PAGO', 100, y),
    palabra('FECHA', 230, y),
    palabra('LIQUIDACION', 370, y),
    palabra('19/08/2026', 500, y),
    palabra('00012345', 700, y),
    palabra('20/08/2026', 900, y),
  ];
}

function entradaDeUnaPagina(palabras: readonly PalabraOcr[]): EntradaDeLiquidacion {
  const pagina: PaginaOcr = { pagina: 1, palabras };
  const pixeles: PixelesDePagina = { data: new Uint8ClampedArray(0), width: 1000, height: 20_000, channels: 3 };
  return { paginas: [pagina], usoOcrEnPagina: [true], pixelesDePagina: [pixeles] };
}

describe('arancel / iva_21_sobre_arancel — sin filtro pipe/corchete, riesgo de confusión mutua (sintético)', () => {
  it('un bloque real produce arancel Y iva_21_sobre_arancel como renglones DISTINTOS', async () => {
    const y0 = 0;
    const palabras = [
      ...filaVentaTotal(y0, '1.000,00'),
      ...filaArancel(y0 + PASO_FILA, '1,00', '10,00'),
      ...filaIvaSobreArancel(y0 + PASO_FILA * 2, '21,00', '2,10'),
      ...filaRetencion(y0 + PASO_FILA * 3, '3,50', '35,00'),
      ...filaNeto(y0 + PASO_FILA * 4, '952,90'),
      ...filaCierre(y0 + PASO_FILA * 5),
    ];
    const entrada = entradaDeUnaPagina(palabras);

    const salida = await leerCabalDebito(entrada);

    expect(salida.liquidaciones).toHaveLength(1);
    const liquidacion = salida.liquidaciones[0];
    expect(liquidacion).toBeDefined();
    expect(liquidacionLeidaSchema.safeParse(liquidacion).success).toBe(true);
    if (!liquidacion) return;

    // La aserción que la mutación (sacar `!t.includes('IVA')` de la condición de `arancel`) pone en
    // rojo: con la mutación plantada, la fila de IVA matchea primero como `arancel` y este renglón
    // desaparece.
    const iva = liquidacion.renglones.filter((r) => r.concepto === 'iva_21_sobre_arancel');
    expect(iva).toHaveLength(1);

    const arancel = liquidacion.renglones.filter((r) => r.concepto === 'arancel');
    expect(arancel).toHaveLength(1);

    // Los dos renglones son distintos, con su propia alícuota — no el mismo total duplicado.
    expect(arancel[0]?.alicuotaPublicada).toEqual({ estado: 'publicado', valor: '1.00' });
    expect(iva[0]?.alicuotaPublicada).toEqual({ estado: 'publicado', valor: '21.00' });
  });

  it('un encabezado de columna con ARANCEL/IVA sin importe no entra a pendientes ni pisa el total real', async () => {
    const y0 = 0;
    const palabras = [
      ...filaEncabezadoDeColumna(y0), // ruido: sin importe, antes del total real
      ...filaVentaTotal(y0 + PASO_FILA, '1.000,00'),
      ...filaArancel(y0 + PASO_FILA * 2, '1,00', '10,00'),
      ...filaIvaSobreArancel(y0 + PASO_FILA * 3, '21,00', '2,10'),
      ...filaEncabezadoDeColumna(y0 + PASO_FILA * 4), // ruido: sin importe, DESPUÉS del total real
      ...filaRetencion(y0 + PASO_FILA * 5, '3,50', '35,00'),
      ...filaNeto(y0 + PASO_FILA * 6, '952,90'),
      ...filaCierre(y0 + PASO_FILA * 7),
    ];
    const entrada = entradaDeUnaPagina(palabras);

    const salida = await leerCabalDebito(entrada);

    expect(salida.liquidaciones).toHaveLength(1);
    const liquidacion = salida.liquidaciones[0];
    expect(liquidacion).toBeDefined();
    if (!liquidacion) return;

    // El total real de arancel sigue siendo el capturado — el ruido de después no lo pisó, porque sin
    // importe `leerLineaDeTotal` devuelve null y la fila nunca llega a `pendientes.set`.
    const arancel = liquidacion.renglones.filter((r) => r.concepto === 'arancel');
    expect(arancel).toHaveLength(1);
    expect(arancel[0]?.monto).toBe('10.00');

    // Las dos filas de ruido (sin importe) se reportan, nunca se descartan en silencio (contrato.ts,
    // regla 3) — van a lineasNoInterpretadas como renglon_sin_monto, no corrompen ningún total.
    const ruidoReportado = salida.lineasNoInterpretadas.filter((l) => l.codigo === 'renglon_sin_monto');
    expect(ruidoReportado.length).toBeGreaterThanOrEqual(2);
  });
});
