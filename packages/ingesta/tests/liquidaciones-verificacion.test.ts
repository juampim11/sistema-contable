/**
 * `verificarAritmeticaPorLiquidacion` y `verificarChecksumDelEmisorMinimo` — commit 2 del plan 14.
 *
 * Todos los importes de este archivo son SINTÉTICOS (hallazgo H-A, ya documentado en `parseo-ar.ts`):
 * ningún valor sale de una liquidación real. La forma de los renglones sigue el patrón que ya fija
 * `liquidaciones-registro.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  verificarAritmeticaPorLiquidacion,
  verificarChecksumDelEmisorMinimo,
  verificarEjeChecksumDelEmisor,
  sumaDeNetosAcreditados,
} from '../src/liquidaciones/verificacion.ts';
import type {
  CapacidadesDeFormato,
  LiquidacionLeida,
  RenglonDeLiquidacion,
} from '../src/liquidaciones/esquema.ts';

function capacidades(parciales: Partial<CapacidadesDeFormato>): CapacidadesDeFormato {
  return {
    traeTotalDelEmisor: true,
    publicaBaseYAlicuotaPorRenglon: false,
    traePercepcionIva: false,
    ...parciales,
  };
}

function renglon(parciales: Partial<RenglonDeLiquidacion>): RenglonDeLiquidacion {
  return {
    concepto: 'arancel',
    subtipoVenta: 'no_discriminado',
    base: { estado: 'no_publicado' },
    alicuotaPublicada: { estado: 'no_publicado' },
    monto: '0.00',
    jurisdiccion: { estado: 'no_publicado' },
    ...parciales,
  };
}

function liquidacion(parciales: Partial<LiquidacionLeida>): LiquidacionLeida {
  return {
    numeroDeLiquidacion: { estado: 'no_publicado' },
    fechaPresentacion: '2026-08-01',
    fechaDePago: { estado: 'no_publicado' },
    moneda: 'ARS',
    ventasBrutas: '1000.00',
    netoAcreditado: '1000.00',
    renglones: [],
    caveatDeComputoFiscal: false,
    ...parciales,
  };
}

describe('verificarAritmeticaPorLiquidacion', () => {
  it('cuadra: ventas menos los renglones que restan da exactamente el neto', () => {
    const l = liquidacion({
      ventasBrutas: '1000.00',
      netoAcreditado: '980.00',
      renglones: [
        renglon({ concepto: 'arancel', monto: '10.00' }),
        renglon({ concepto: 'iva_21_sobre_arancel', monto: '10.00' }),
      ],
    });
    const r = verificarAritmeticaPorLiquidacion(l);
    expect(r).toEqual({ eje: 'aritmetica_por_liquidacion', estado: 'cuadra' });
  });

  it('no_cuadra: la suma de renglones no reproduce el neto declarado', () => {
    const l = liquidacion({
      ventasBrutas: '1000.00',
      netoAcreditado: '900.00', // debería dar 980.00 con estos renglones
      renglones: [renglon({ concepto: 'arancel', monto: '20.00' })],
    });
    const r = verificarAritmeticaPorLiquidacion(l);
    expect(r).toEqual({ eje: 'aritmetica_por_liquidacion', estado: 'no_cuadra' });
  });

  it('sin renglones, ventas debe ser igual al neto para cuadrar', () => {
    const l = liquidacion({ ventasBrutas: '500.00', netoAcreditado: '500.00', renglones: [] });
    expect(verificarAritmeticaPorLiquidacion(l).estado).toBe('cuadra');
  });

  it('un renglón con efecto no_determinado y monto != 0: no_verificable con su motivo', () => {
    const l = liquidacion({
      ventasBrutas: '1000.00',
      netoAcreditado: '950.00',
      renglones: [
        renglon({ concepto: 'arancel', monto: '10.00' }),
        // percepcion_iva_rg2408 tiene efectoSobreElNeto: 'no_determinado' en el catálogo.
        renglon({ concepto: 'percepcion_iva_rg2408', monto: '5.00' }),
      ],
    });
    const r = verificarAritmeticaPorLiquidacion(l);
    expect(r).toEqual({
      eje: 'aritmetica_por_liquidacion',
      estado: 'no_verificable',
      motivo: 'concepto_con_efecto_no_determinado',
    });
  });

  it('un renglón no_determinado en CERO no dispara no_verificable: sigue cuadrando si el resto cierra', () => {
    const l = liquidacion({
      ventasBrutas: '1000.00',
      netoAcreditado: '990.00',
      renglones: [
        renglon({ concepto: 'arancel', monto: '10.00' }),
        renglon({ concepto: 'percepcion_iva_rg2408', monto: '0.00' }),
      ],
    });
    expect(verificarAritmeticaPorLiquidacion(l).estado).toBe('cuadra');
  });
});

describe('verificarChecksumDelEmisorMinimo — implementación PARCIAL (ver comentario en verificacion.ts)', () => {
  it('cuadra: la suma de los netos acreditados coincide con el total declarado', () => {
    const liquidaciones = [
      liquidacion({ netoAcreditado: '100.00' }),
      liquidacion({ netoAcreditado: '250.50' }),
      liquidacion({ netoAcreditado: '49.50' }),
    ];
    const r = verificarChecksumDelEmisorMinimo(liquidaciones, '400.00');
    expect(r).toEqual({ eje: 'checksum_del_emisor', estado: 'cuadra' });
  });

  it('no_cuadra: la suma no coincide con el total declarado', () => {
    const liquidaciones = [
      liquidacion({ netoAcreditado: '100.00' }),
      liquidacion({ netoAcreditado: '250.50' }),
    ];
    const r = verificarChecksumDelEmisorMinimo(liquidaciones, '999.99');
    expect(r).toEqual({ eje: 'checksum_del_emisor', estado: 'no_cuadra' });
  });

  it('lista vacía de liquidaciones nunca cuadra contra un total declarado no nulo', () => {
    const r = verificarChecksumDelEmisorMinimo([], '1.00');
    expect(r.estado).toBe('no_cuadra');
  });
});

describe('verificarEjeChecksumDelEmisor — decide el motivo por capacidad del formato, no del lote', () => {
  it('traeTotalDelEmisor: false → siempre no_verificable/emisor_no_publica_total, sin importar el lote', () => {
    const liquidaciones = [liquidacion({ netoAcreditado: '100.00' })];
    // Si llegara a delegar en verificarChecksumDelEmisorMinimo por error, esto daría 'cuadra' —
    // por eso el total declarado coincide exacto con la suma: el test detecta el bug si se cuela.
    const r = verificarEjeChecksumDelEmisor(capacidades({ traeTotalDelEmisor: false }), liquidaciones, '100.00');
    expect(r).toEqual({ eje: 'checksum_del_emisor', estado: 'no_verificable', motivo: 'emisor_no_publica_total' });
  });

  it('traeTotalDelEmisor: false → mismo resultado con lista vacía y total arbitrario', () => {
    const r = verificarEjeChecksumDelEmisor(capacidades({ traeTotalDelEmisor: false }), [], '0.00');
    expect(r).toEqual({ eje: 'checksum_del_emisor', estado: 'no_verificable', motivo: 'emisor_no_publica_total' });
  });

  it('traeTotalDelEmisor: true → delega en verificarChecksumDelEmisorMinimo, caso cuadra', () => {
    const liquidaciones = [
      liquidacion({ netoAcreditado: '100.00' }),
      liquidacion({ netoAcreditado: '250.50' }),
    ];
    const r = verificarEjeChecksumDelEmisor(capacidades({ traeTotalDelEmisor: true }), liquidaciones, '350.50');
    expect(r).toEqual(verificarChecksumDelEmisorMinimo(liquidaciones, '350.50'));
    expect(r).toEqual({ eje: 'checksum_del_emisor', estado: 'cuadra' });
  });

  it('traeTotalDelEmisor: true → delega en verificarChecksumDelEmisorMinimo, caso no_cuadra', () => {
    const liquidaciones = [liquidacion({ netoAcreditado: '100.00' })];
    const r = verificarEjeChecksumDelEmisor(capacidades({ traeTotalDelEmisor: true }), liquidaciones, '999.99');
    expect(r).toEqual(verificarChecksumDelEmisorMinimo(liquidaciones, '999.99'));
    expect(r).toEqual({ eje: 'checksum_del_emisor', estado: 'no_cuadra' });
  });
});

describe('sumaDeNetosAcreditados', () => {
  it('suma en centavos, nunca en punto flotante', () => {
    const liquidaciones = [
      liquidacion({ netoAcreditado: '0.10' }),
      liquidacion({ netoAcreditado: '0.20' }),
    ];
    // 0.1 + 0.2 en floats de JS da 0.30000000000000004. Acá tiene que dar exacto.
    expect(sumaDeNetosAcreditados(liquidaciones)).toBe('0.30');
  });

  it('lista vacía suma cero', () => {
    expect(sumaDeNetosAcreditados([])).toBe('0.00');
  });
});
