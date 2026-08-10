/**
 * Tests de `parseo-ar.ts` — fijan los cinco bugs que el tester midió sobre los archivos reales.
 *
 * Cada bloque referencia el modo de falla que cierra. Todos los valores son sintéticos.
 */

import { describe, expect, it } from 'vitest';
import {
  centavosAImporte,
  dentroDelPeriodo,
  esImporte,
  importeACentavos,
  importeCanonicoACentavos,
  normalizar,
  normalizarTokenNumerico,
  parsearFecha,
  parsearImporte,
  sumarImportes,
  tieneEncodingRoto,
} from '../src/parseo-ar.ts';

// -----------------------------------------------------------------------------
describe('la puerta que estaba abierta: dígitos pelados NO son un importe', () => {
  /**
   * Medido sobre un solo extracto real: **295 tokens** que no son importes entraban como importes
   * válidos. La causa era la rama `|\d+` del grupo entero, que hacía "importe" indistinguible de
   * "cualquier número". Cualquier adapter que localice columnas con `esImporte()` habría tomado un CUIT
   * por un importe.
   */
  it.each([
    ['código de columna de 4 dígitos', '0112'],
    ['número de tarjeta de 16', '4173090000692362'],
    ['documento de 11 dígitos', '20123456789'],
    ['CBU de 22 dígitos', '9990000090000000000001'],
    ['número de operación', '21633'],
    ['un año', '2026'],
    ['número de ley en la glosa', '25413'],
  ])('rechaza %s', (_caso, token) => {
    expect(importeACentavos(token)).toBeNull();
    expect(esImporte(token)).toBe(false);
  });

  it('acepta el importe SIN separador de miles pero CON coma decimal', () => {
    // Es la única forma en que "sin miles" es legítimo: la coma decimal es la marca de que es un importe.
    expect(importeACentavos('432,10')).toBe(43210n);
    expect(importeACentavos('0,05')).toBe(5n);
  });

  it('acepta el entero pelado SOLO si el perfil del banco lo habilita', () => {
    // El principio del piloto: lo que un banco haga distinto es un parámetro, no una relajación global.
    expect(importeACentavos('500')).toBeNull();
    expect(importeACentavos('500', { enteroPelado: true })).toBe(50000n);
  });
});

// -----------------------------------------------------------------------------
describe('round-trip: el camino corto a una verificación que cuadra contra la nada', () => {
  /**
   * `centavosAImporte` produce punto decimal; `importeACentavos` esperaba coma. Resultado: el round-trip
   * daba `null` **para todo valor**, así que sumar 326 importes canónicos con el parser AR daba Σ = 0 y
   * una verificación "exitosa" sobre nada.
   */
  it.each([0n, 1n, -1n, 5n, 100n, -100n, -99n, 4321_00n, -83_246_944_51n])(
    'ida y vuelta de %s centavos',
    (centavos) => {
      const canonico = centavosAImporte(centavos);
      expect(importeCanonicoACentavos(canonico)).toBe(centavos);
    },
  );

  it('`sumarImportes` suma canónicos sin pasar por el parser AR', () => {
    expect(sumarImportes(['100.00', '-40.50', '0.50'])).toBe('60.00');
    // Y falla explícitamente si algo no es canónico, en vez de devolver un total silenciosamente corto.
    expect(sumarImportes(['100.00', '1.234,56'])).toBeNull();
  });

  it('rechaza un canónico que no cabe en numeric(18,2)', () => {
    expect(importeCanonicoACentavos('12345678901234567.00')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe('las cuatro notaciones de signo, y las que son dato roto', () => {
  it('acepta las cuatro formas de negativo observadas', () => {
    expect(importeACentavos('-4.321,00')).toBe(-432100n);
    expect(importeACentavos('765.432,10-')).toBe(-76543210n);
    expect(importeACentavos('-$ 55.555')).toBe(-5555500n);
    expect(importeACentavos('(4.321,00)')).toBe(-432100n);
  });

  it('rechaza DOBLE signo: importe y saldo son tokens vecinos y el `-` migra entre ellos', () => {
    expect(importeACentavos('-4.321,00-')).toBeNull();
    expect(importeACentavos('-(4.321,00)')).toBeNull();
  });

  it('rechaza un paréntesis suelto', () => {
    expect(importeACentavos('(4.321,00')).toBeNull();
    expect(importeACentavos('4.321,00)')).toBeNull();
  });

  it('rechaza UN SOLO decimal: rellenarlo convierte un token truncado en un importe creíble', () => {
    expect(importeACentavos('4.321,0')).toBeNull();
    // Y si algún banco los publica así, se habilita en SU perfil.
    expect(importeACentavos('4.321,0', { unSoloDecimal: true })).toBe(432100n);
  });

  it('rechaza lo que no cabe en numeric(18,2), en vez de explotar en el insert', () => {
    expect(importeACentavos('12.345.678.901.234.567,00')).toBeNull();
  });

  it('normaliza el menos tipográfico y el espacio duro que produce un extractor de PDF', () => {
    expect(normalizarTokenNumerico('−4.321,00')).toBe('-4.321,00');
    expect(importeACentavos('−4.321,00')).toBe(-432100n);
    expect(importeACentavos('4 321,00')).toBe(432100n);
  });

  it('cero: se parsea, y la decisión de crédito/débito es del adapter', () => {
    expect(importeACentavos('0,00')).toBe(0n);
    expect(parsearImporte('0,00')).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------
describe('fechas sin año: dos bancos del roster quedaban ilegibles', () => {
  const junio = { desde: '2026-06-01', hasta: '2026-06-30' };

  it('resuelve `dd/mm` y `dd-mm` contra el período', () => {
    expect(parsearFecha('30/06', junio)).toBe('2026-06-30');
    expect(parsearFecha('01-06', junio)).toBe('2026-06-01');
  });

  it('un período que cruza el fin de año resuelve cada fecha a su año', () => {
    const cruce = { desde: '2025-12-15', hasta: '2026-01-15' };
    expect(parsearFecha('31/12', cruce)).toBe('2025-12-31');
    expect(parsearFecha('02/01', cruce)).toBe('2026-01-02');
  });

  it('una fecha fuera del período devuelve null: NO adivina el año', () => {
    // Devolver una fecha plausible esconde que la línea es de otro bloque mal capturado.
    expect(parsearFecha('15/03', junio)).toBeNull();
  });

  it('sin período, `dd/mm` no se resuelve', () => {
    expect(parsearFecha('30/06')).toBeNull();
  });

  it('con año explícito sigue funcionando, y valida el calendario', () => {
    expect(parsearFecha('30/06/2026')).toBe('2026-06-30');
    expect(parsearFecha('30/06/26', junio)).toBe('2026-06-30');
    expect(parsearFecha('31/02/2026')).toBeNull();
    expect(parsearFecha('32/01/2026')).toBeNull();
  });

  it('dentroDelPeriodo es la invariante V7, expuesta para no reimplementarla', () => {
    expect(dentroDelPeriodo('2026-06-15', junio)).toBe(true);
    expect(dentroDelPeriodo('2026-07-01', junio)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
describe('normalización de texto', () => {
  it('quita acentos, colapsa espacios y pasa a mayúsculas', () => {
    expect(normalizar('  Comisión   de   Servicio ')).toBe('COMISION DE SERVICIO');
  });

  it('CONSERVA el marcador de encoding roto en vez de borrarlo', () => {
    // El "Excel" de un banco del roster es un TSV en Latin-1: confundir un carácter roto con una letra
    // hace que dos filas distintas parezcan la misma en el cruce PDF↔Excel.
    const roto = 'COMISI�N';
    expect(normalizar(roto)).toContain('�');
    expect(tieneEncodingRoto(roto)).toBe(true);
    expect(tieneEncodingRoto('COMISION')).toBe(false);
  });
});
