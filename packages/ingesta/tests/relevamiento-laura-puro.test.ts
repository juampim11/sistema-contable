/**
 * `particionarContrapartes`/`agruparAsientosAutomaticos` — puras, sin base. Datos SINTÉTICOS, ninguno
 * calcado de Bracci o ROKA (ni nombre de contraparte ni cifra real).
 */

import { describe, expect, it } from 'vitest';
import {
  agruparAsientosAutomaticos,
  CORTE_MINIMO_CONTRAPARTE,
  particionarContrapartes,
  type FilaContraparteCruda,
} from '@sistema-contable/ingesta';

function filaCruda(overrides: Partial<FilaContraparteCruda>): FilaContraparteCruda {
  return {
    clienteId: 'cliente-de-prueba',
    cantidadMovimientos: 1,
    algunMovimientoConMultiplesCandidatos: false,
    ejemploDescripcion: 'CONCEPTO SINTETICO DE PRUEBA',
    ejemploFecha: '2026-01-15',
    ejemploImporte: '-1000.00',
    ...overrides,
  };
}

describe('particionarContrapartes', () => {
  it('CORTE_MINIMO_CONTRAPARTE es 3 (el corte que documenta el plan)', () => {
    expect(CORTE_MINIMO_CONTRAPARTE).toBe(3);
  });

  it('un grupo con cantidad >= 3 va individual; uno con < 3 va al resumen', () => {
    const filas = [
      filaCruda({ cantidadMovimientos: 5 }),
      filaCruda({ cantidadMovimientos: 3 }), // exactamente el corte: individual
      filaCruda({ cantidadMovimientos: 2 }),
      filaCruda({ cantidadMovimientos: 1 }),
    ];

    const bloque = particionarContrapartes('cliente-de-prueba', filas);

    expect(bloque.filas).toHaveLength(2);
    expect(bloque.filas.map((f) => f.cantidadMovimientos)).toEqual([5, 3]);
    expect(bloque.filas.every((f) => f.esRetiroDeSocio === false)).toBe(true);
    expect(bloque.resumen).toEqual({ grupos: 2, movimientos: 3 }); // 2+1
  });

  it('sin filas ni retiro_de_socio, el bloque queda vacío sin romperse', () => {
    const bloque = particionarContrapartes('cliente-de-prueba', []);
    expect(bloque.filas).toHaveLength(0);
    expect(bloque.resumen).toEqual({ grupos: 0, movimientos: 0 });
  });

  it('el bloque de retiro_de_socio se agrega SIEMPRE completo, sin pasar por el corte, ' +
    'después de las individuales y marcado esRetiroDeSocio', () => {
    const filas = [filaCruda({ cantidadMovimientos: 5 }), filaCruda({ cantidadMovimientos: 1 })];
    const retiro = [filaCruda({ cantidadMovimientos: 1, ejemploDescripcion: 'RETIRO SINTETICO' })];

    const bloque = particionarContrapartes('cliente-de-prueba', filas, retiro);

    expect(bloque.filas).toHaveLength(2); // la individual (5) + el retiro (1, pese a ser < 3)
    expect(bloque.filas[0]?.esRetiroDeSocio).toBe(false);
    expect(bloque.filas[1]?.esRetiroDeSocio).toBe(true);
    expect(bloque.filas[1]?.cantidadMovimientos).toBe(1);
    // El grupo B (1, sin ser retiro) SÍ fue al resumen — el retiro no lo contamina.
    expect(bloque.resumen).toEqual({ grupos: 1, movimientos: 1 });
  });

  it('admite más de un grupo de retiro_de_socio (caso general) — todos entran, ninguno al resumen', () => {
    const retiro = [
      filaCruda({ cantidadMovimientos: 1, ejemploDescripcion: 'RETIRO A' }),
      filaCruda({ cantidadMovimientos: 1, ejemploDescripcion: 'RETIRO B' }),
    ];
    const bloque = particionarContrapartes('cliente-de-prueba', [], retiro);
    expect(bloque.filas).toHaveLength(2);
    expect(bloque.filas.every((f) => f.esRetiroDeSocio)).toBe(true);
    expect(bloque.resumen).toEqual({ grupos: 0, movimientos: 0 });
  });
});

describe('agruparAsientosAutomaticos', () => {
  function filaSql(overrides: Record<string, unknown> = {}): Parameters<typeof agruparAsientosAutomaticos>[0][number] {
    return {
      cliente_id: 'cliente-de-prueba',
      tipo: 'comision_bancaria',
      cantidad_total: 2,
      cantidad_reversas: 1,
      asiento_id_ejemplo: 'asiento-1',
      importe_ejemplo: '500.00',
      fecha_imputacion: '2026-01-15',
      renglon_orden: 1,
      cuenta_codigo: '1.1.01',
      cuenta_denominacion: 'Banco cuenta corriente',
      debe: '500.00',
      haber: '0.00',
      ...overrides,
    };
  }

  it('combina las dos filas planas (un renglón por lado) del mismo (cliente, tipo) en una sola fila', () => {
    const filas = [
      filaSql({ renglon_orden: 1, debe: '500.00', haber: '0.00' }),
      filaSql({ renglon_orden: 2, debe: '0.00', haber: '500.00', cuenta_codigo: '5.1.01', cuenta_denominacion: 'Gastos bancarios' }),
    ];

    const agrupado = agruparAsientosAutomaticos(filas);

    expect(agrupado).toHaveLength(1);
    const fila = agrupado[0];
    expect(fila?.tipo).toBe('comision_bancaria');
    // El total real (incluida la reversa) se preserva tal cual vino de la consulta — no se recalcula.
    expect(fila?.cantidadTotal).toBe(2);
    expect(fila?.cantidadReversas).toBe(1);
    expect(fila?.renglones).toHaveLength(2);
    expect(fila?.renglones.map((r) => r.orden)).toEqual([1, 2]);
  });

  it('separa (cliente, tipo) distintos en filas distintas', () => {
    const filas = [
      filaSql({ tipo: 'comision_bancaria', renglon_orden: 1 }),
      filaSql({ tipo: 'comision_bancaria', renglon_orden: 2 }),
      filaSql({ tipo: 'pago_de_haberes', asiento_id_ejemplo: 'asiento-2', renglon_orden: 1 }),
      filaSql({ tipo: 'pago_de_haberes', asiento_id_ejemplo: 'asiento-2', renglon_orden: 2 }),
    ];
    const agrupado = agruparAsientosAutomaticos(filas);
    expect(agrupado.map((f) => f.tipo).sort()).toEqual(['comision_bancaria', 'pago_de_haberes']);
  });

  it('sin filas, devuelve un arreglo vacío sin romperse', () => {
    expect(agruparAsientosAutomaticos([])).toEqual([]);
  });
});
