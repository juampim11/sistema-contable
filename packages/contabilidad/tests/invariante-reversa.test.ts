/**
 * INV-M2-1 — coherencia de reversa (`05-motor-de-reconocimiento.md` §4). Con `polaridad:'normal'`,
 * `lado === ladoEsperado`. Con `'reversa'`, `lado === opuesto(ladoEsperado)`. Si no se cumple, NUNCA hay
 * propuesta: `sin_reconocer`, motivo `reversa_incoherente` — el error de mapeo se detecta por
 * aritmética de lados, sin que nadie etiquete nada.
 */

import { describe, expect, it } from 'vitest';
import { construirIndice } from '../src/nucleo/indice.ts';
import { reconocer } from '../src/nucleo/motor.ts';
import { LEXICO_GALICIA } from '../src/lexico/galicia.ts';

const INDICE_GALICIA = construirIndice(LEXICO_GALICIA);

function reconocerLiteral(literal: string, columnaOrigen: 'credito' | 'debito') {
  return reconocer(
    {
      bancoCodigo: 'galicia',
      conceptoBanco: literal,
      conceptoCompleto: true,
      conceptoBancoEstrategia: 'segmento_de_glosa',
      conceptoCodigo: undefined,
      columnaOrigen,
    },
    INDICE_GALICIA,
  );
}

describe('INV-M2-1 — coherencia de reversa', () => {
  it('el impuesto normal, en el lado esperado (débito), reconoce', () => {
    const r = reconocerLiteral('IMP. CRE. LEY 25413', 'debito');
    expect(r.clase).not.toBe('sin_reconocer');
  });

  it('🔴 el caso que ataja el par trampa: el mismo literal del impuesto en el lado OPUESTO (crédito) ' +
    'NUNCA propone — cae en sin_reconocer/reversa_incoherente, sin que nadie haya etiquetado nada', () => {
    const r = reconocerLiteral('IMP. CRE. LEY 25413', 'credito');
    expect(r).toEqual(
      expect.objectContaining({ clase: 'sin_reconocer', motivo: 'reversa_incoherente' }),
    );
  });

  it('la reversa, en su lado esperado (crédito), reconoce', () => {
    const r = reconocerLiteral('DEV.IMP.CRED.LEY 25413', 'credito');
    expect(r.clase).not.toBe('sin_reconocer');
  });

  it('la reversa en el lado equivocado (débito) — mismo invariante, dirección opuesta', () => {
    const r = reconocerLiteral('DEV.IMP.CRED.LEY 25413', 'debito');
    expect(r).toEqual(
      expect.objectContaining({ clase: 'sin_reconocer', motivo: 'reversa_incoherente' }),
    );
  });

  it("ladoEsperado:'indistinto' es vacuamente coherente en cualquier lado (transferencia entre cuentas propias)", () => {
    const debito = reconocerLiteral('TRANSF. CTAS PROPIAS', 'debito');
    const credito = reconocerLiteral('TRANSF. CTAS PROPIAS', 'credito');
    expect(debito.clase).not.toBe('sin_reconocer');
    expect(credito.clase).not.toBe('sin_reconocer');
  });
});
