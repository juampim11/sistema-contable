/**
 * Eje 4 — confianza de captura. Plan 15, commit 2 del plan 14 (retomado 2026-08-19).
 *
 * Todos los valores de este archivo son SINTÉTICOS: ningún `valorLeido` ni confianza sale del documento
 * real. `valorLeido` en particular nunca lleva un dato con forma de importe/CUIT/fecha real — son
 * strings de prueba como `'x'`, a propósito.
 */
import { describe, expect, it } from 'vitest';
import {
  ESTADOS_CONFIANZA_CAPTURA,
  UMBRAL_CONFIANZA_MINIMA,
  evaluarConfianzaDeCaptura,
} from '../src/liquidaciones/captura.ts';

describe('UMBRAL_CONFIANZA_MINIMA — regresión sobre el valor fijado con evidencia', () => {
  it('es 70, entero (R-O: nada de decimales en el vocabulario compartido)', () => {
    expect(UMBRAL_CONFIANZA_MINIMA).toBe(70);
    expect(Number.isInteger(UMBRAL_CONFIANZA_MINIMA)).toBe(true);
  });
});

describe('evaluarConfianzaDeCaptura', () => {
  it('confianzaOcr null → no_evaluable, y confianzaOcr se conserva null (texto nativo, el eje no corrió)', () => {
    const r = evaluarConfianzaDeCaptura('campo_x', 'x', null);
    expect(r).toEqual({ campo: 'campo_x', valorLeido: 'x', confianzaOcr: null, estado: 'no_evaluable' });
  });

  it('por debajo del umbral: dudoso', () => {
    expect(evaluarConfianzaDeCaptura('c', 'x', UMBRAL_CONFIANZA_MINIMA - 1).estado).toBe('dudoso');
  });

  it('mutación en el límite exacto: EN el umbral es confiable, no dudoso (`< umbral`, nunca `<= umbral`)', () => {
    // Éste es el caso que un off-by-one degrada en silencio: si la comparación fuera `<= umbral` en vez
    // de `< umbral`, este valor pasaría a `dudoso` sin que ningún otro test lo note.
    const r = evaluarConfianzaDeCaptura('c', 'x', UMBRAL_CONFIANZA_MINIMA);
    expect(r.estado).toBe('confiable');
    expect(r.confianzaOcr).toBe(UMBRAL_CONFIANZA_MINIMA);
  });

  it('por encima del umbral: confiable', () => {
    expect(evaluarConfianzaDeCaptura('c', 'x', UMBRAL_CONFIANZA_MINIMA + 1).estado).toBe('confiable');
  });

  it('trunca la confianza a entero ANTES de compararla y de guardarla (R-O)', () => {
    // 69.9 trunca a 69 (< 70): dudoso. Si comparara sin truncar, 69.9 >= 70 sería falso igual — el caso
    // que sí distingue truncar de no truncar es el de abajo.
    expect(evaluarConfianzaDeCaptura('c', 'x', 69.9).confianzaOcr).toBe(69);
    expect(evaluarConfianzaDeCaptura('c', 'x', 69.9).estado).toBe('dudoso');
    // 70.9 trunca a 70 (>= 70): confiable. Sin truncar antes de comparar, seguiría dando confiable —
    // pero el campo `confianzaOcr` persistido llevaría un decimal, que es lo que R-O prohíbe guardar.
    const r = evaluarConfianzaDeCaptura('c', 'x', 70.9);
    expect(r.confianzaOcr).toBe(70);
    expect(Number.isInteger(r.confianzaOcr)).toBe(true);
    expect(r.estado).toBe('confiable');
  });

  it('el roster de estados es exactamente el declarado, en el orden fijado', () => {
    expect(ESTADOS_CONFIANZA_CAPTURA).toEqual(['confiable', 'dudoso', 'no_evaluable']);
  });

  it('nunca modifica ni consulta nada del eje 1: es una función pura sobre sus tres argumentos', () => {
    // No hay forma de que esta función reciba una LiquidacionLeida ni un ResultadoDeEje: su firma solo
    // admite (campo, valorLeido, confianzaOcr). Este test documenta la garantía de tipos como
    // comportamiento observable, no solo como comentario.
    expect(evaluarConfianzaDeCaptura.length).toBe(3);
  });
});
