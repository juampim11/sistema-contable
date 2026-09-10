/**
 * Tanda 1 — agrupación (`docs/diseno/31-replanteo-hacia-producto.md`). `claveDeAgrupacion` pura
 * (commit 1) + `categoriaEspecialDe` (commit 2, motor real — sin las hojas todavía, ver el commit
 * siguiente de la misma tanda para `agruparFilas`/`armarHojaGrupos` y la colisión real).
 */

import { describe, expect, it } from 'vitest';
import { construirIndice, lexicoDe, reconocer } from '@sistema-contable/contabilidad';
import { claveDeAgrupacion } from '../src/planilla/armar-libro.ts';
import { categoriaEspecialDe } from '../src/planilla/exportar-planilla.ts';

describe('claveDeAgrupacion', () => {
  it('mismo banco + mismo texto (con espacios y mayúsculas distintas) → misma clave', () => {
    expect(claveDeAgrupacion('galicia', 'Transferencia  Recibida')).toBe(
      claveDeAgrupacion('galicia', '  transferencia recibida  '),
    );
  });

  it('mismo texto, distinto banco → clave distinta', () => {
    expect(claveDeAgrupacion('galicia', 'ACREDITAMIENTO')).not.toBe(claveDeAgrupacion('macro', 'ACREDITAMIENTO'));
  });

  it('conceptoBanco null → clave estable, distinta de cualquier texto real', () => {
    const clave = claveDeAgrupacion('galicia', null);
    expect(clave).toBe(claveDeAgrupacion('galicia', null));
    expect(clave).not.toBe(claveDeAgrupacion('galicia', '(sin concepto)'.toUpperCase()));
  });

  it('NUNCA usa la normalización del léxico (no colapsa dígitos ni tokens variables)', () => {
    // Dos referencias con solo el número de comprobante distinto tienen que quedar en grupos
    // DISTINTOS acá — la normalización que colapsaría eso es la del motor (`normalizarParaLexico`,
    // para matchear), no la de esta clave (para agrupar). Mezclarlas sería el bug del digest (187)
    // por la puerta de atrás.
    expect(claveDeAgrupacion('galicia', 'PAGO PROVEEDOR 000123')).not.toBe(
      claveDeAgrupacion('galicia', 'PAGO PROVEEDOR 000456'),
    );
  });
});

// -----------------------------------------------------------------------------
// `categoriaEspecialDe` — motor real, literales reales de `catalogo.ts` (galicia)
// -----------------------------------------------------------------------------

describe('categoriaEspecialDe', () => {
  const lexico = lexicoDe('galicia');
  if (!lexico) throw new Error('falta el léxico de galicia — no debería poder pasar');
  const indice = construirIndice(lexico);

  function reconocido(conceptoBanco: string, columnaOrigen: 'credito' | 'debito') {
    return reconocer(
      {
        bancoCodigo: 'galicia',
        conceptoBanco,
        conceptoCompleto: true,
        conceptoBancoEstrategia: undefined,
        conceptoCodigo: undefined,
        columnaOrigen,
      },
      indice,
    );
  }

  it('completar_con_liquidacion_del_adquirente (ACREDITAMIENTO, real) → tarjeta_pendiente', () => {
    const r = reconocido('ACREDITAMIENTO', 'credito');
    expect(r.clase).toBe('decision_humana');
    expect(categoriaEspecialDe(r)).toBe('tarjeta_pendiente');
  });

  it('decision_humana de OTRO que_decide (TRANSF. AFIP, real) → null, nunca tarjeta_pendiente', () => {
    const r = reconocido('TRANSF. AFIP', 'debito');
    expect(r.clase).toBe('decision_humana');
    if (r.clase === 'decision_humana') expect(r.queDecide).not.toBe('completar_con_liquidacion_del_adquirente');
    expect(categoriaEspecialDe(r)).toBeNull();
  });

  it('propuesta (EXTRACCION EN AUTOSERVICIO, real) → null', () => {
    const r = reconocido('EXTRACCION EN AUTOSERVICIO', 'debito');
    expect(r.clase).toBe('propuesta');
    expect(categoriaEspecialDe(r)).toBeNull();
  });

  it('sin_reconocer (texto inventado, no matchea ningún literal) → null', () => {
    const r = reconocido('ZZZ CONCEPTO INVENTADO PARA EL TEST ZZZ', 'credito');
    expect(r.clase).toBe('sin_reconocer');
    expect(categoriaEspecialDe(r)).toBeNull();
  });
});
