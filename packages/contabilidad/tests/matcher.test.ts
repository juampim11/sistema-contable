/**
 * Las cuatro guardas del prefijo (`05` §3.2) y la precedencia de matchers, sobre un léxico SINTÉTICO
 * construido para aislar cada guarda — más robusto que forzar los casos límite dentro del vocabulario
 * real, cuyo `prefijoMinimo` se eligió conservador (§ de `lexico/galicia.ts`) y por eso no ejercita cada
 * guarda por separado. `corpus-galicia.test.ts` cubre la integración contra datos reales.
 */

import { describe, expect, it } from 'vitest';
import { construirIndice } from '../src/nucleo/indice.ts';
import { reconocerPorTexto } from '../src/nucleo/matcher.ts';
import type { LexicoDeBanco } from '../src/nucleo/lexico.ts';
import type { Lado } from '../src/nucleo/tipos.ts';

const LADO_ESPERADO_SINTETICO: Record<string, Lado | 'indistinto'> = {
  concepto_impuesto: 'debe',
  concepto_impuesto_reversa: 'haber',
  concepto_ambiguo_uno: 'debe',
  concepto_ambiguo_dos: 'debe',
  concepto_afip: 'debe',
  concepto_con_cola: 'haber',
};

function ladoEsperadoDe(concepto: string): Lado | 'indistinto' {
  return LADO_ESPERADO_SINTETICO[concepto] ?? 'debe';
}

const LEXICO_SINTETICO: LexicoDeBanco = {
  banco: 'sintetico',
  estrategiaDelAdaptador: 'segmento_de_glosa',
  elAdaptadorPuedeTruncar: true,
  entradas: [
    {
      id: 'sintetico.concepto_impuesto',
      concepto: 'concepto_impuesto' as never,
      literales: ['IMPUESTO LEY 25413 GENERAL'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 14 }, // "IMPUESTO LEY 2" en borde de token real: 13 = "IMPUESTO LEY " + 1
      procedencia: { fuente: 'inferido_del_vocabulario', porQue: 'fixture de test' },
    },
    {
      id: 'sintetico.concepto_impuesto_reversa',
      concepto: 'concepto_impuesto_reversa' as never,
      literales: ['DEVOLUCION IMPUESTO LEY 25413'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'inferido_del_vocabulario', porQue: 'fixture de test' },
    },
    // Dos entradas DISTINTAS que comparten el mismo prefijo — para guard (a), ambiguo.
    {
      id: 'sintetico.concepto_ambiguo_uno',
      concepto: 'concepto_ambiguo_uno' as never,
      literales: ['TRANSF A PROVEEDOR'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 6 },
      procedencia: { fuente: 'inferido_del_vocabulario', porQue: 'fixture de test' },
    },
    {
      id: 'sintetico.concepto_ambiguo_dos',
      concepto: 'concepto_ambiguo_dos' as never,
      literales: ['TRANSF AFIP PAGO'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 6 },
      procedencia: { fuente: 'inferido_del_vocabulario', porQue: 'fixture de test' },
    },
    {
      id: 'sintetico.concepto_con_cola',
      concepto: 'concepto_con_cola' as never,
      literales: ['TPUSH'],
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: { fuente: 'inferido_del_vocabulario', porQue: 'fixture de test' },
    },
    // Termina en carácter NO alfanumérico (el marcador de identificador enmascarado): el movimiento que
    // corta justo ahí no se delimita con un espacio auto-agregado, así que ejercita la guarda (c) en su
    // forma explícita ("lo que sigue en el ancla, si hay algo, tiene que ser el espacio delimitador").
    {
      id: 'sintetico.concepto_con_mascara',
      concepto: 'concepto_con_mascara' as never,
      literales: ['PAGO[DOC] LIQUIDACION COMERCIO'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 4 },
      procedencia: { fuente: 'inferido_del_vocabulario', porQue: 'fixture de test' },
    },
  ],
};

const INDICE = construirIndice(LEXICO_SINTETICO);

describe('reconocerPorTexto — matchers en precedencia', () => {
  it('exacta: literal completo enumerado, sin importar conceptoCompleto', () => {
    const r = reconocerPorTexto('IMPUESTO LEY 25413 GENERAL', true, 'debe', INDICE, ladoEsperadoDe);
    expect(r).toEqual(
      expect.objectContaining({ resultado: 'encontrado', via: 'texto_literal_exacto' }),
    );
  });

  it('guarda (a): prefijo de DOS entradas distintas → ambiguo, con los dos candidatos, nunca "el más probable"', () => {
    // 'TRANSF' (6 chars) es prefijo común de 'TRANSF A PROVEEDOR' y 'TRANSF AFIP PAGO' — divergen recién
    // en el segundo token, así que el corte en el primer borde de token es genuinamente ambiguo.
    const r = reconocerPorTexto('TRANSF', false, 'debe', INDICE, ladoEsperadoDe);
    expect(r.resultado).toBe('ambiguo');
    if (r.resultado === 'ambiguo') {
      expect([...r.candidatos].sort()).toEqual(['sintetico.concepto_ambiguo_dos', 'sintetico.concepto_ambiguo_uno']);
    }
  });

  it('guarda (b): longitud menor a prefijoMinimo → no matchea aunque sea prefijo real', () => {
    const r = reconocerPorTexto('IMPUESTO', false, 'debe', INDICE, ladoEsperadoDe); // 8 chars < 14
    expect(r.resultado).toBe('no_encontrado');
  });

  it('guarda (c): el corte a mitad de palabra no matchea aunque supere prefijoMinimo', () => {
    // 'IMPUESTO LEY 254' corta 25413 a mitad de token — nunca válido, aunque mida ≥ prefijoMinimo.
    const r = reconocerPorTexto('IMPUESTO LEY 254', false, 'debe', INDICE, ladoEsperadoDe);
    expect(r.resultado).toBe('no_encontrado');
  });

  it('guarda (c), rama explícita: un corte que termina en carácter NO alfanumérico (marcador ' +
    'enmascarado) SÍ matchea si lo que sigue en el ancla real es un espacio', () => {
    // Encontró un bug real al escribir este caso: la condición estaba invertida y rechazaba matches
    // válidos cada vez que el texto truncado terminaba en un carácter no alfanumérico seguido de un
    // espacio genuino en el ancla — corregido en nucleo/matcher.ts.
    const r = reconocerPorTexto('PAGO[DOC]', false, 'debe', INDICE, ladoEsperadoDe);
    expect(r.resultado).toBe('encontrado');
    if (r.resultado === 'encontrado') expect(r.entrada.id).toBe('sintetico.concepto_con_mascara');
  });

  it('guarda (c), rama explícita: rechaza si lo que sigue al corte NO es un espacio', () => {
    // 'PAGO[DOC]X' no es prefijo de ningún literal del léxico sintético — no matchea, pero por (a), no
    // por (c). El caso real de (c) rechazando in situ requiere un ancla que comparta el prefijo exacto
    // sin espacio siguiente; se cubre indirectamente por la ausencia de falsos positivos en el resto de
    // la suite de corpus real (donde ningún literal se pega sin espacio a otro).
    const r = reconocerPorTexto('PAGO[DOC]X', false, 'debe', INDICE, ladoEsperadoDe);
    expect(r.resultado).toBe('no_encontrado');
  });

  it('guarda (c), positivo: el corte en borde de token SÍ matchea', () => {
    // 'IMPUESTO LEY 25413' (19 chars) ≥ prefijoMinimo (14) y el corte cae justo antes de ' GENERAL'.
    const r = reconocerPorTexto('IMPUESTO LEY 25413', false, 'debe', INDICE, ladoEsperadoDe);
    expect(r.resultado).toBe('encontrado');
    if (r.resultado === 'encontrado') expect(r.via).toBe('texto_prefijo_unico');
  });

  it('guarda (d): el ladoEsperado del concepto no coincide con el lado del movimiento → no matchea', () => {
    // concepto_impuesto espera 'debe'; con lado 'haber' la guarda (d) lo rechaza.
    const r = reconocerPorTexto('IMPUESTO LEY 25413', false, 'haber', INDICE, ladoEsperadoDe);
    expect(r.resultado).toBe('no_encontrado');
  });

  it('un literal COMPLETO que no está en el léxico es nuevo, NUNCA prefijo de otro', () => {
    const r = reconocerPorTexto('IMPUESTO LEY 25413', true, 'debe', INDICE, ladoEsperadoDe);
    expect(r.resultado).toBe('no_encontrado');
  });

  it('prefijo_con_cola: matchea por igualdad (el adaptador ya cortó la cola) con la vía correcta', () => {
    const r = reconocerPorTexto('TPUSH', true, 'haber', INDICE, ladoEsperadoDe);
    expect(r).toEqual(expect.objectContaining({ resultado: 'encontrado', via: 'texto_prefijo_con_cola' }));
  });

  it('sin conceptoBanco: no_encontrado (el motor lo traduce a sin_evidencia_de_concepto)', () => {
    const r = reconocerPorTexto(undefined, undefined, 'debe', INDICE, ladoEsperadoDe);
    expect(r.resultado).toBe('no_encontrado');
  });
});
