/**
 * `comoFilaPosicion` — reconocimiento de la fila de posición de un fondo (tenencia, cotización,
 * valorizado), ejercitado DIRECTO con fragmentos sintéticos, sin pasar por ningún PDF. `nombreFondoExpuesto`
 * — la transformación de `nombreInterno` al `fondo` real que ahora expone `FondoExtraido` (ronda 2 del
 * export FCI).
 *
 * Todas las cifras y nombres de este archivo son SINTÉTICOS (mismo criterio que ya documenta
 * `packages/ingesta/src/parseo-ar.ts`, hallazgo H-A): ningún valor sale de un extracto real de
 * ningún cliente.
 */

import { describe, expect, it } from 'vitest';
import {
  comoFilaPosicion,
  nombreFondoExpuesto,
  type FragmentoClasificado,
} from '../src/fci-galicia/extraer-posiciones.ts';

function fragmento(parciales: Partial<FragmentoClasificado>): FragmentoClasificado {
  return {
    x: 0,
    decimales: null,
    esFecha: false,
    esTipoMovimiento: null,
    texto: '',
    ...parciales,
  };
}

/** Los 4 fragmentos de una fila de posición válida, todos dentro de los rangos de `x` que el código
 *  ya valida — cada test parte de acá y pisa solo lo que necesita. */
function fragmentosDeFilaValida(overrides: Partial<Record<'nombre' | 'tenencia' | 'cotizacion' | 'valorizado', Partial<FragmentoClasificado>>> = {}): FragmentoClasificado[] {
  return [
    fragmento({ x: 10, texto: 'Fondo Sintetico Renta A', ...overrides.nombre }),
    fragmento({ x: 390, decimales: 2, texto: '1.234,56', ...overrides.tenencia }),
    fragmento({ x: 455, decimales: 6, texto: '123,456789', ...overrides.cotizacion }),
    fragmento({ x: 520, decimales: 2, texto: '152.345,67', ...overrides.valorizado }),
  ];
}

describe('comoFilaPosicion', () => {
  it('reconoce los 4 campos de una fila de posición válida, con valor canónico (punto decimal, sin miles)', () => {
    const resultado = comoFilaPosicion(fragmentosDeFilaValida());

    expect(resultado).toEqual({
      nombreInterno: 'Fondo Sintetico Renta A',
      tenenciaTexto: '1234.56',
      cotizacionTexto: '123.456789',
      valorizadoTexto: '152345.67',
    });
  });

  it('un fragmento de tenencia fuera de la ventana de x sigue devolviendo null (comportamiento ya existente)', () => {
    const resultado = comoFilaPosicion(
      fragmentosDeFilaValida({ tenencia: { x: 300 } }), // fuera de [370, 410]
    );

    expect(resultado).toBeNull();
  });

  it('un fragmento de cotización fuera de la ventana de x devuelve null', () => {
    const resultado = comoFilaPosicion(
      fragmentosDeFilaValida({ cotizacion: { x: 500 } }), // fuera de [440, 470]
    );

    expect(resultado).toBeNull();
  });

  it('un fragmento de valorizado fuera de la ventana de x devuelve null', () => {
    const resultado = comoFilaPosicion(
      fragmentosDeFilaValida({ valorizado: { x: 600 } }), // fuera de [510, 535]
    );

    expect(resultado).toBeNull();
  });

  it('el fragmento de nombre fuera de su ventana (x >= 50) devuelve null', () => {
    const resultado = comoFilaPosicion(fragmentosDeFilaValida({ nombre: { x: 60 } }));

    expect(resultado).toBeNull();
  });

  it('cualquier campo numérico sin decimales reconocidos (decimales: null) devuelve null', () => {
    const resultado = comoFilaPosicion(fragmentosDeFilaValida({ tenencia: { decimales: null } }));

    expect(resultado).toBeNull();
  });

  it('una cantidad de fragmentos distinta de 4 devuelve null', () => {
    const [nombre, tenencia, cotizacion] = fragmentosDeFilaValida();
    expect(comoFilaPosicion([nombre!, tenencia!, cotizacion!])).toBeNull();
  });
});

/**
 * `nombreFondoExpuesto` — la transformación de `nombreInterno` (tabla de posición) al `fondo` que
 * ahora sale en `FondoExtraido` y como nombre de hoja del `.xlsx` (ronda 2 del export). Nombres
 * inventados por este test, ninguno real.
 */
describe('nombreFondoExpuesto', () => {
  it('deja intacto un nombre ya bien formado', () => {
    expect(nombreFondoExpuesto('Fima Ahorro Pesos')).toBe('Fima Ahorro Pesos');
  });

  it('recorta espacios de punta', () => {
    expect(nombreFondoExpuesto('  Fima Premium Renta Fija  ')).toBe('Fima Premium Renta Fija');
  });

  it('colapsa espacios internos repetidos (común en texto extraído de PDF)', () => {
    expect(nombreFondoExpuesto('Fima  Ahorro   Pesos')).toBe('Fima Ahorro Pesos');
  });

  it('preserva mayúsculas y minúsculas tal como vienen — no es la clave de unión normalizada', () => {
    expect(nombreFondoExpuesto('fima Renta mixta')).toBe('fima Renta mixta');
  });
});
