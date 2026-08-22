import { describe, expect, it } from 'vitest';
import { aPuntoFijo, formatear } from '../src/nucleo/aritmetica.ts';
import { ConsumoInvalidoError, consumirRescate } from '../src/nucleo/consumirRescate.ts';
import type { CapaFCI } from '../src/nucleo/tipos.ts';

/**
 * Fábrica de fixtures para `CapaFCI`: con `id`/`fecha` sumados a la identidad de la capa, repetir los
 * 7 campos completos en cada `it` empieza a doler (y va a doler más con Capa D). Los defaults son
 * neutros (cantidad y precio en cero, fecha fija); cada test pisa solo los campos que le importan a su
 * caso — `id` se genera solo para que cada capa del fixture tenga una identidad distinta, sin que
 * ningún test dependa de su valor concreto.
 */
let contadorIdCapa = 0;
function capa(overrides: Partial<CapaFCI> = {}): CapaFCI {
  contadorIdCapa += 1;
  return {
    id: `capa-test-${contadorIdCapa}`,
    fecha: '2026-01-01',
    cantidadOriginal: aPuntoFijo('0'),
    cantidadRemanente: aPuntoFijo('0'),
    precioUnitarioOrigen: aPuntoFijo('0'),
    origen: 'suscripcion',
    costoConocido: true,
    ...overrides,
  };
}

describe('consumirRescate', () => {
  it('rescate partido entre dos capas: consume toda la más vieja y el resto de la siguiente', () => {
    // Patrón confirmado contra un caso real (un rescate de cuotapartes que no alcanza a cubrirse con
    // una sola capa reparte el remanente en la capa siguiente) — pero las CIFRAS de acá son sintéticas
    // a propósito: los números reales del cliente no viven en el repo (barrido de fuga, ADR-0002 §F.2).
    const capaVieja = capa({
      fecha: '2026-01-10',
      cantidadOriginal: aPuntoFijo('6000.00'),
      cantidadRemanente: aPuntoFijo('4321.55'),
      precioUnitarioOrigen: aPuntoFijo('118.30'),
      origen: 'apertura',
    });
    const capaSiguiente = capa({
      fecha: '2026-02-15',
      cantidadOriginal: aPuntoFijo('25000.00'),
      cantidadRemanente: aPuntoFijo('20000.00'),
      precioUnitarioOrigen: aPuntoFijo('142.10'),
      origen: 'suscripcion',
    });
    const precioRescate = aPuntoFijo('150.00');

    const resultado = consumirRescate([capaVieja, capaSiguiente], aPuntoFijo('12345.67'), precioRescate);

    expect(resultado.items).toHaveLength(2);

    expect(resultado.items[0]?.capa).toBe(capaVieja);
    expect(formatear(resultado.items[0]!.cantidadConsumida)).toBe('4321.550000');
    expect(resultado.items[0]?.costoEstimado).toBe(false);

    expect(resultado.items[1]?.capa).toBe(capaSiguiente);
    expect(formatear(resultado.items[1]!.cantidadConsumida)).toBe('8024.120000');
    expect(resultado.items[1]?.costoEstimado).toBe(false);

    // Resultado individual de cada ítem: (precioRescate - precioUnitarioOrigen) * cantidadConsumida.
    // (150.00 - 118.30) * 4321.55 = 31.70 * 4321.55 = 136993.135
    expect(formatear(resultado.items[0]!.resultado)).toBe('136993.135000');
    // (150.00 - 142.10) * 8024.12 = 7.90 * 8024.12 = 63390.548
    expect(formatear(resultado.items[1]!.resultado)).toBe('63390.548000');

    expect(formatear(resultado.cantidadCubierta)).toBe('12345.670000');
    expect(formatear(resultado.cantidadSinCubrir)).toBe('0.000000');
    expect(resultado.parcialmenteEstimado).toBe(false);
  });

  it('una sola capa alcanza para cubrir todo el rescate', () => {
    const capaUnica = capa({
      cantidadOriginal: aPuntoFijo('1000.00'),
      cantidadRemanente: aPuntoFijo('1000.00'),
      precioUnitarioOrigen: aPuntoFijo('100.00'),
    });

    const resultado = consumirRescate([capaUnica], aPuntoFijo('250.00'), aPuntoFijo('110.00'));

    expect(resultado.items).toHaveLength(1);
    expect(formatear(resultado.items[0]!.cantidadConsumida)).toBe('250.000000');
    // (110 - 100) * 250 = 2500
    expect(formatear(resultado.items[0]!.resultado)).toBe('2500.000000');
    expect(formatear(resultado.cantidadSinCubrir)).toBe('0.000000');
    expect(resultado.parcialmenteEstimado).toBe(false);
  });

  it('rescate exacto al remanente de una capa: no toca la capa siguiente', () => {
    const capaA = capa({
      fecha: '2026-01-01',
      cantidadOriginal: aPuntoFijo('500.00'),
      cantidadRemanente: aPuntoFijo('500.00'),
      precioUnitarioOrigen: aPuntoFijo('50.00'),
      origen: 'apertura',
    });
    const capaB = capa({
      fecha: '2026-02-01',
      cantidadOriginal: aPuntoFijo('300.00'),
      cantidadRemanente: aPuntoFijo('300.00'),
      precioUnitarioOrigen: aPuntoFijo('60.00'),
    });

    const resultado = consumirRescate([capaA, capaB], aPuntoFijo('500.00'), aPuntoFijo('55.00'));

    expect(resultado.items).toHaveLength(1);
    expect(resultado.items[0]?.capa).toBe(capaA);
    expect(formatear(resultado.cantidadSinCubrir)).toBe('0.000000');
  });

  it('el rescate excede el stock total: no inventa una capa ni completa con precio 0, y expone lo que faltó', () => {
    const capaUnica = capa({
      cantidadOriginal: aPuntoFijo('100.00'),
      cantidadRemanente: aPuntoFijo('100.00'),
      precioUnitarioOrigen: aPuntoFijo('80.00'),
    });

    const resultado = consumirRescate([capaUnica], aPuntoFijo('150.00'), aPuntoFijo('90.00'));

    expect(resultado.items).toHaveLength(1);
    expect(formatear(resultado.items[0]!.cantidadConsumida)).toBe('100.000000');
    expect(formatear(resultado.cantidadCubierta)).toBe('100.000000');
    // Los 50 que faltaron quedan explícitos, nunca como una tercera capa inventada.
    expect(formatear(resultado.cantidadSinCubrir)).toBe('50.000000');
  });

  it('una capa con costoConocido:false marca su ítem como estimado, y eso vuelve el resultado global parcialmenteEstimado', () => {
    const capaConocida = capa({
      fecha: '2026-01-01',
      cantidadOriginal: aPuntoFijo('200.00'),
      cantidadRemanente: aPuntoFijo('200.00'),
      precioUnitarioOrigen: aPuntoFijo('40.00'),
    });
    const capaAperturaSinPrecioReal = capa({
      fecha: '2026-02-01',
      cantidadOriginal: aPuntoFijo('300.00'),
      cantidadRemanente: aPuntoFijo('300.00'),
      // El precio no es real (cliente que entró a mitad de ejercicio); igual se necesita un valor para
      // poder operar — `costoConocido: false` es la marca de que ESTE número es una estimación, nunca
      // se "arregla" con un promedio ni con el precio de cierre.
      precioUnitarioOrigen: aPuntoFijo('45.00'),
      origen: 'apertura',
      costoConocido: false,
    });

    const resultado = consumirRescate(
      [capaConocida, capaAperturaSinPrecioReal],
      aPuntoFijo('350.00'),
      aPuntoFijo('50.00'),
    );

    expect(resultado.items).toHaveLength(2);
    expect(resultado.items[0]?.costoEstimado).toBe(false);
    expect(resultado.items[1]?.costoEstimado).toBe(true);
    expect(resultado.parcialmenteEstimado).toBe(true);
  });

  it('una capa ya agotada (remanente cero) no genera ítem', () => {
    const capaAgotada = capa({
      fecha: '2026-01-01',
      cantidadOriginal: aPuntoFijo('100.00'),
      cantidadRemanente: aPuntoFijo('0'),
      precioUnitarioOrigen: aPuntoFijo('10.00'),
    });
    const capaConStock = capa({
      fecha: '2026-02-01',
      cantidadOriginal: aPuntoFijo('100.00'),
      cantidadRemanente: aPuntoFijo('100.00'),
      precioUnitarioOrigen: aPuntoFijo('20.00'),
    });

    const resultado = consumirRescate([capaAgotada, capaConStock], aPuntoFijo('40.00'), aPuntoFijo('25.00'));

    expect(resultado.items).toHaveLength(1);
    expect(resultado.items[0]?.capa).toBe(capaConStock);
  });

  it('un rescate a pérdida (precio de rescate menor al de origen) da un resultado negativo', () => {
    const capaUnica = capa({
      cantidadRemanente: aPuntoFijo('1000.00'),
      precioUnitarioOrigen: aPuntoFijo('200.00'),
    });

    const resultado = consumirRescate([capaUnica], aPuntoFijo('400.00'), aPuntoFijo('180.00'));

    expect(resultado.items).toHaveLength(1);
    expect(formatear(resultado.items[0]!.cantidadConsumida)).toBe('400.000000');
    // (180.00 - 200.00) * 400.00 = -20.00 * 400.00 = -8000.00
    expect(formatear(resultado.items[0]!.resultado)).toBe('-8000.000000');
    expect(formatear(resultado.cantidadCubierta)).toBe('400.000000');
    expect(formatear(resultado.cantidadSinCubrir)).toBe('0.000000');
    expect(resultado.parcialmenteEstimado).toBe(false);
  });

  describe('validación de entradas — rechaza en vez de producir basura silenciosa', () => {
    it('capas fuera de orden PEPS (no decreciente por fecha) tiran ConsumoInvalidoError', () => {
      const capaNueva = capa({ fecha: '2026-02-01', cantidadRemanente: aPuntoFijo('100.00') });
      const capaVieja = capa({ fecha: '2026-01-01', cantidadRemanente: aPuntoFijo('100.00') });

      // Invertidas a propósito: la más nueva primero.
      expect(() => consumirRescate([capaNueva, capaVieja], aPuntoFijo('10.00'), aPuntoFijo('1.00'))).toThrow(
        ConsumoInvalidoError,
      );
    });

    it('cantidadARescatar negativa tira ConsumoInvalidoError', () => {
      const capaUnica = capa({ cantidadRemanente: aPuntoFijo('100.00') });

      expect(() => consumirRescate([capaUnica], aPuntoFijo('-10.00'), aPuntoFijo('1.00'))).toThrow(
        ConsumoInvalidoError,
      );
    });

    it('precioRescate negativo tira ConsumoInvalidoError', () => {
      const capaUnica = capa({ cantidadRemanente: aPuntoFijo('100.00') });

      expect(() => consumirRescate([capaUnica], aPuntoFijo('10.00'), aPuntoFijo('-1.00'))).toThrow(
        ConsumoInvalidoError,
      );
    });

    it('una capa con cantidadRemanente negativa tira ConsumoInvalidoError', () => {
      const capaInvalida = capa({ cantidadRemanente: aPuntoFijo('-5.00') });

      expect(() => consumirRescate([capaInvalida], aPuntoFijo('10.00'), aPuntoFijo('1.00'))).toThrow(
        ConsumoInvalidoError,
      );
    });

    it('una capa con cantidadOriginal negativa tira ConsumoInvalidoError', () => {
      const capaInvalida = capa({ cantidadOriginal: aPuntoFijo('-5.00'), cantidadRemanente: aPuntoFijo('5.00') });

      expect(() => consumirRescate([capaInvalida], aPuntoFijo('10.00'), aPuntoFijo('1.00'))).toThrow(
        ConsumoInvalidoError,
      );
    });

    it('una capa con precioUnitarioOrigen negativo tira ConsumoInvalidoError', () => {
      const capaInvalida = capa({
        cantidadRemanente: aPuntoFijo('5.00'),
        precioUnitarioOrigen: aPuntoFijo('-1.00'),
      });

      expect(() => consumirRescate([capaInvalida], aPuntoFijo('10.00'), aPuntoFijo('1.00'))).toThrow(
        ConsumoInvalidoError,
      );
    });
  });
});
