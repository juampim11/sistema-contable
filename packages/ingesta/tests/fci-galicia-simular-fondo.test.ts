/**
 * `simularFondo` — encadena `consumirRescate` (PEPS) a través de varios cortes para un mismo fondo.
 *
 * Todas las cifras de este archivo son SINTÉTICAS (mismo criterio que ya documenta
 * `packages/ingesta/src/parseo-ar.ts`, hallazgo H-A): ningún valor sale de un extracto real de ningún
 * cliente.
 */

import { formatear } from '@sistema-contable/fci';
import { describe, expect, it } from 'vitest';
import type { MovimientoFci } from '../src/fci-galicia/extraer-posiciones.ts';
import { simularFondo, type CorteDeFondo } from '../src/fci-galicia/simular-fondo.ts';

function movimiento(parciales: Partial<MovimientoFci> & Pick<MovimientoFci, 'tipo'>): MovimientoFci {
  return { cantidad: '0', precio: '0', fecha: '2025-01-01', ...parciales };
}

describe('simularFondo', () => {
  it('serie vacía: no hay nada para simular', () => {
    expect(simularFondo([])).toEqual({ consumos: [], snapshots: [] });
  });

  it('apertura + una suscripción + un rescate que cubre justo con la capa de apertura', () => {
    // apertura = tenenciaDeclarada − Σsuscripciones + Σrescates = 1300 − 500 + 200 = 1000
    const corte: CorteDeFondo = {
      corte: '2025-01-31',
      periodoDesde: '2025-01-01',
      tenenciaDeclarada: '1300.00',
      movimientos: [
        movimiento({ tipo: 'suscripcion', cantidad: '500.00', precio: '10.00', fecha: '2025-01-05' }),
        movimiento({ tipo: 'rescate', cantidad: '200.00', precio: '12.00', fecha: '2025-01-10' }),
      ],
    };

    const simulacion = simularFondo([corte]);

    expect(simulacion.consumos).toHaveLength(1);
    const [consumo] = simulacion.consumos;
    expect(consumo?.corte).toBe('2025-01-31');
    expect(formatear(consumo!.resultado.cantidadSinCubrir)).toBe('0.000000');
    expect(consumo!.resultado.items).toHaveLength(1);
    expect(consumo!.resultado.items[0]?.capa.id).toBe('apertura');
    expect(formatear(consumo!.resultado.items[0]!.cantidadConsumida)).toBe('200.000000');

    expect(simulacion.snapshots).toHaveLength(1);
    const [snapshot] = simulacion.snapshots;
    expect(snapshot?.capasAbiertas).toHaveLength(2);
    const apertura = snapshot!.capasAbiertas.find((c) => c.id === 'apertura');
    const suscripcion = snapshot!.capasAbiertas.find((c) => c.id !== 'apertura');
    // 1000 de apertura − 200 consumidos por el rescate = 800.
    expect(formatear(apertura!.cantidadRemanente)).toBe('800.000000');
    // La suscripción de 500 no fue tocada por el rescate (se cubrió entero con la apertura).
    expect(formatear(suscripcion!.cantidadRemanente)).toBe('500.000000');
  });

  it('un rescate partido entre 2 capas, encadenado a través de 2 cortes', () => {
    // Corte 1: apertura = 150 (tenencia final) − 100 (suscripción) + 0 (sin rescate) = 50.
    const corte1: CorteDeFondo = {
      corte: '2025-01-31',
      periodoDesde: '2025-01-01',
      tenenciaDeclarada: '150.00',
      movimientos: [
        movimiento({ tipo: 'suscripcion', cantidad: '100.00', precio: '50.00', fecha: '2025-01-15' }),
      ],
    };
    // Corte 2: un rescate de 120 sobre un stock total de 150 (50 de apertura + 100 de la suscripción)
    // — no alcanza con una sola capa, se parte entre las dos.
    const corte2: CorteDeFondo = {
      corte: '2025-02-28',
      periodoDesde: '2025-02-01',
      tenenciaDeclarada: '30.00',
      movimientos: [
        movimiento({ tipo: 'rescate', cantidad: '120.00', precio: '60.00', fecha: '2025-02-10' }),
      ],
    };

    const simulacion = simularFondo([corte1, corte2]);

    expect(simulacion.consumos).toHaveLength(1);
    const [consumo] = simulacion.consumos;
    expect(consumo?.corte).toBe('2025-02-28');
    expect(consumo!.resultado.items).toHaveLength(2);
    expect(consumo!.resultado.items[0]?.capa.id).toBe('apertura');
    expect(formatear(consumo!.resultado.items[0]!.cantidadConsumida)).toBe('50.000000');
    expect(consumo!.resultado.items[1]?.capa.id).toBe('susc_1');
    expect(formatear(consumo!.resultado.items[1]!.cantidadConsumida)).toBe('70.000000');
    expect(formatear(consumo!.resultado.cantidadSinCubrir)).toBe('0.000000');
  });

  it('el snapshot del segundo corte refleja el consumo acumulado de ambos cortes, no solo del último', () => {
    // apertura = 70 (tenencia final del corte 1) − 0 + 30 (rescate del corte 1) = 100.
    const corte1: CorteDeFondo = {
      corte: '2025-03-31',
      periodoDesde: '2025-03-01',
      tenenciaDeclarada: '70.00',
      movimientos: [
        movimiento({ tipo: 'rescate', cantidad: '30.00', precio: '5.00', fecha: '2025-03-05' }),
      ],
    };
    const corte2: CorteDeFondo = {
      corte: '2025-04-30',
      periodoDesde: '2025-04-01',
      tenenciaDeclarada: '50.00',
      movimientos: [
        movimiento({ tipo: 'rescate', cantidad: '20.00', precio: '6.00', fecha: '2025-04-05' }),
      ],
    };

    const simulacion = simularFondo([corte1, corte2]);

    expect(simulacion.snapshots).toHaveLength(2);
    // Después del corte 1: 100 − 30 = 70.
    expect(formatear(simulacion.snapshots[0]!.capasAbiertas[0]!.cantidadRemanente)).toBe('70.000000');
    // Después del corte 2: 70 − 20 = 50 (acumulado de LOS DOS rescates, no solo el de 20 del corte 2).
    expect(formatear(simulacion.snapshots[1]!.capasAbiertas[0]!.cantidadRemanente)).toBe('50.000000');
  });
});
