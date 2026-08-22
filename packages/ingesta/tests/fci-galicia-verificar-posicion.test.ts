/**
 * `verificarPosicionFondo` — eje 1 (invariante de cantidades) de una posición de FCI.
 *
 * Todas las cantidades de este archivo son SINTÉTICAS (mismo criterio que ya documenta
 * `packages/ingesta/src/parseo-ar.ts`, hallazgo H-A): ningún valor sale de un extracto real.
 */

import { describe, expect, it } from 'vitest';
import { CantidadPosicionInvalidaError } from '../src/fci-galicia/aritmetica-posicion.ts';
import type {
  CategoriaDelta,
  PosicionFondo,
  ResultadoVerificacionPosicion,
} from '../src/fci-galicia/verificar-posicion.ts';
import { verificarPosicionFondo } from '../src/fci-galicia/verificar-posicion.ts';

function posicion(parciales: Partial<PosicionFondo>): PosicionFondo {
  return {
    fondo: 'fondo-sintetico',
    corte: '2026-01-31',
    saldoInicialDeclarado: '0',
    suscripciones: [],
    rescates: [],
    tenenciaFinalDeclarada: '0',
    ...parciales,
  };
}

/** Blinda "nunca exponer el delta" con el objeto COMPLETO, no una lista parcial de claves. */
function esperarNoCierra(
  resultado: ResultadoVerificacionPosicion,
  categoriaDelta: CategoriaDelta,
): void {
  expect(resultado).toEqual({
    fondo: resultado.fondo,
    corte: resultado.corte,
    cierra: false,
    categoriaDelta,
  });
}

describe('verificarPosicionFondo', () => {
  it('cierra exacto: inicial + suscripciones - rescates = tenencia declarada', () => {
    const resultado = verificarPosicionFondo(
      posicion({
        saldoInicialDeclarado: '100.000000',
        suscripciones: ['50.500000'],
        rescates: ['20.250000'],
        tenenciaFinalDeclarada: '130.250000',
      }),
    );

    expect(resultado).toEqual({ fondo: 'fondo-sintetico', corte: '2026-01-31', cierra: true });
  });

  it('no cierra, delta chico (<0.01): categoriaDelta, nunca el delta ni el calculado', () => {
    const resultado = verificarPosicionFondo(
      posicion({
        saldoInicialDeclarado: '100.000000',
        suscripciones: ['50.500000'],
        rescates: ['20.250000'],
        tenenciaFinalDeclarada: '130.250005', // 0.000005 de diferencia contra lo calculado
      }),
    );

    esperarNoCierra(resultado, '<0.01');
  });

  it('no cierra, delta grande (>1)', () => {
    const resultado = verificarPosicionFondo(
      posicion({
        saldoInicialDeclarado: '100.000000',
        suscripciones: ['50.500000'],
        rescates: ['20.250000'],
        tenenciaFinalDeclarada: '135.250000', // 5.000000 de diferencia contra lo calculado
      }),
    );

    esperarNoCierra(resultado, '>1');
  });

  it('fondo sin movimientos: saldo inicial igual a la tenencia final cierra', () => {
    const resultado = verificarPosicionFondo(
      posicion({
        saldoInicialDeclarado: '42.123456',
        tenenciaFinalDeclarada: '42.123456',
      }),
    );

    expect(resultado).toEqual({ fondo: 'fondo-sintetico', corte: '2026-01-31', cierra: true });
  });

  it('borde inferior de categoría: delta exactamente 0.01 cae en 0.01-1, no en <0.01', () => {
    const resultado = verificarPosicionFondo(
      posicion({
        saldoInicialDeclarado: '100.000000',
        tenenciaFinalDeclarada: '100.010000',
      }),
    );

    esperarNoCierra(resultado, '0.01-1');
  });

  it('borde superior de categoría: delta exactamente 1 cae en 0.01-1, no en >1', () => {
    const resultado = verificarPosicionFondo(
      posicion({
        saldoInicialDeclarado: '100.000000',
        tenenciaFinalDeclarada: '101.000000',
      }),
    );

    esperarNoCierra(resultado, '0.01-1');
  });

  it('varias suscripciones y rescates se suman antes de comparar', () => {
    const resultado = verificarPosicionFondo(
      posicion({
        saldoInicialDeclarado: '1000.000000',
        suscripciones: ['10.000000', '20.000000', '5.500000'],
        rescates: ['3.000000', '2.500000'],
        tenenciaFinalDeclarada: '1030.000000', // 1000 + 35.5 - 5.5
      }),
    );

    expect(resultado).toEqual({ fondo: 'fondo-sintetico', corte: '2026-01-31', cierra: true });
  });

  describe('rechaza cantidades con signo — un rescate/suscripción negativo enmascararía un error de extracción', () => {
    it('un rescate negativo tira CantidadPosicionInvalidaError, no "cierra" con el signo invertido', () => {
      // Sin el guard: 100 - (-10) = 110, y el invariante "cerraría" sobre un documento que en los
      // hechos tiene un rescate mal extraído (signo de más en vez de un movimiento real).
      expect(() =>
        verificarPosicionFondo(
          posicion({
            saldoInicialDeclarado: '100.000000',
            rescates: ['-10.000000'],
            tenenciaFinalDeclarada: '110.000000',
          }),
        ),
      ).toThrow(CantidadPosicionInvalidaError);
    });

    it('una suscripción negativa tira CantidadPosicionInvalidaError', () => {
      expect(() =>
        verificarPosicionFondo(posicion({ suscripciones: ['-5.000000'] })),
      ).toThrow(CantidadPosicionInvalidaError);
    });

    it('saldoInicialDeclarado o tenenciaFinalDeclarada negativos tiran CantidadPosicionInvalidaError', () => {
      expect(() =>
        verificarPosicionFondo(posicion({ saldoInicialDeclarado: '-1.000000' })),
      ).toThrow(CantidadPosicionInvalidaError);
      expect(() =>
        verificarPosicionFondo(posicion({ tenenciaFinalDeclarada: '-1.000000' })),
      ).toThrow(CantidadPosicionInvalidaError);
    });
  });

  describe('propaga el error de parseo a través de la función completa', () => {
    it('un string no parseable en la lista de suscripciones tira, sin llegar a calcular nada', () => {
      expect(() =>
        verificarPosicionFondo(
          posicion({ suscripciones: ['50.500000', 'no-es-un-numero'] }),
        ),
      ).toThrow(CantidadPosicionInvalidaError);
    });

    it('formato con coma decimal (no soportado, este dominio usa punto) tira', () => {
      expect(() => verificarPosicionFondo(posicion({ rescates: ['20,25'] }))).toThrow(
        CantidadPosicionInvalidaError,
      );
    });

    it('más de 6 decimales tira — se rechaza, nunca se trunca en silencio', () => {
      expect(() =>
        verificarPosicionFondo(posicion({ saldoInicialDeclarado: '12.1234567' })),
      ).toThrow(CantidadPosicionInvalidaError);
    });
  });
});
