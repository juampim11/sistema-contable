/**
 * Tanda 1 — agrupación (`docs/diseno/31-replanteo-hacia-producto.md`). `claveDeAgrupacion` pura,
 * primer commit de la tanda (sin las hojas ni `categoriaEspecial` todavía — ver los commits
 * siguientes de la misma tanda para `agruparFilas`/`armarHojaGrupos` y la colisión real).
 */

import { describe, expect, it } from 'vitest';
import { claveDeAgrupacion } from '../src/planilla/armar-libro.ts';

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
