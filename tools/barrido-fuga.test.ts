/**
 * LA VERIFICACIÓN DEL VERIFICADOR — condición de salida nº 4.
 *
 * El barrido es un control de seguridad, y un control de seguridad que nunca se probó rojo **no existe**:
 * un `barrer()` que devolviera siempre `fugas: []` pasaría desapercibido para siempre, porque su estado
 * normal es justamente "no encontré nada".
 *
 * Así que este archivo **planta una fuga** —un valor que está en el material— y exige que la detecte. Y
 * planta también el caso simétrico —un valor sintético que NO está en el material— y exige que no la
 * marque, porque el falso positivo es el modo de falla que ya mató a la primera versión del barrido: 18
 * hallazgos legítimos, y un chequeo que grita en falso se desactiva en la segunda semana.
 *
 * Todos los valores de este archivo son **sintéticos**. No hay ninguno de ningún cliente: el material
 * "real" que se usa acá se construye en el propio test.
 */

import { describe, expect, it } from 'vitest';
import { candidatosEnTexto, esFuga, huellaDe, prepararMaterial } from './barrido-fuga.ts';

/**
 * Simula un archivo de `privado/`: el texto extraído de un extracto. Valores sintéticos, con verificador
 * de CUIT y de CBU inválido a propósito (misma regla que el generador sintético de `packages/data`).
 */
const MATERIAL_SIMULADO = prepararMaterial(
  [
    'BANCO DE PRUEBA - RESUMEN DE CUENTA',
    'CUIT 20-12345678-9   CBU 9990000090000000000001',
    '01/06/26  CONCEPTO DE PRUEBA UNO      -4.321,00     765.432,10',
    '02/06/26  CONCEPTO DE PRUEBA DOS       1.111,11     766.543,21',
  ].join(String.fromCharCode(10)),
);

describe('el barrido detecta la fuga que motivó su existencia', () => {
  /**
   * Es el caso exacto de la fuga que se encontró: un importe del extracto copiado a un comentario del
   * código fuente. Ningún otro control lo veía — el redactor mira logs, no comentarios.
   */
  it.each([
    ['un importe copiado del extracto a un comentario', '// ejemplo: el saldo daba 765.432,10'],
    ['el CUIT del titular en un comentario', '/** el titular es CUIT 20-12345678-9 */'],
    ['un CBU en una constante', "const cuenta = '9990000090000000000001';"],
    ['un importe negativo con el signo adelante', 'expect(saldo).toBe(-4.321,00);'],
  ])('detecta %s', (_caso, lineaPlantada) => {
    const candidatos = candidatosEnTexto(lineaPlantada);
    expect(candidatos.length, 'ningún detector matcheó la línea plantada').toBeGreaterThan(0);
    expect(
      candidatos.some((c) => esFuga(c.valor, MATERIAL_SIMULADO)),
      'el valor está en el material y el barrido no lo marcó',
    ).toBe(true);
  });
});

describe('el barrido NO grita en falso: es lo que lo hace usable', () => {
  /**
   * Todos estos tienen **forma** de dato sensible y ninguno **es** un dato del material. La primera
   * versión del barrido fallaba con los 18 casos de esta clase, y por eso no servía.
   */
  it.each([
    ['una notación de signo documentada en el parser', "importeACentavos('(1.234,56)')"],
    ['un importe de ejemplo de un ADR', 'el movimiento entra como `-9.876,54`'],
    ['un DSN de desarrollo', 'postgres://app:app@localhost:5432/contable'],
    ['otro CBU sintético distinto', "const otra = '9990000090000000000002';"],
  ])('no marca %s', (_caso, linea) => {
    for (const c of candidatosEnTexto(linea)) {
      expect(esFuga(c.valor, MATERIAL_SIMULADO), `falso positivo en ${c.detector}`).toBe(false);
    }
  });

  it('el piso de longitud evita que un token corto matchee por azar', () => {
    // `0112` es un código de columna: aparece en cualquier texto largo. Cruzarlo sería ruido puro.
    expect(esFuga('0112', MATERIAL_SIMULADO)).toBe(false);
  });
});

describe('la normalización es la que evita el FALSO NEGATIVO', () => {
  /**
   * Pasó de verdad en la pasada manual: buscar el importe con sus puntos de miles contra un texto que los
   * escribía distinto devolvió "no está" cuando sí estaba. **El chequeo que da tranquilidad falsa es peor
   * que no tener chequeo**, porque cierra la pregunta.
   */
  it.each([
    ['con puntos de miles', '765.432,10'],
    ['con espacio duro del extractor de PDF', '765 432,10'],
    ['con guiones como el CUIT', '20-12345678-9'],
    ['sin guiones', '20123456789'],
    ['con el signo adelante', '-765.432,10'],
    ['con el signo atrás, que es como un banco marca el saldo acreedor', '765.432,10-'],
    ['entre paréntesis', '(765.432,10)'],
  ])('%s cruza contra el mismo material', (_caso, valor) => {
    expect(esFuga(valor, MATERIAL_SIMULADO)).toBe(true);
  });

  /**
   * El otro lado del trade-off, y es deliberado.
   *
   * Quitar la coma decimal hacía que el importe `1.111,11` quedara como `111111` y cruzara contra un
   * **número de operación** `111111` del material: mismo string, dato distinto. La coma es lo que hace que
   * un importe sea un importe. El precio de conservarla es que un importe escrito **sin** su coma decimal
   * no cruza — y se paga con gusto, porque en este dominio un importe siempre lleva centavos.
   */
  it('un importe y un identificador con los mismos dígitos NO son el mismo dato', () => {
    const conNumeroDeOperacion = prepararMaterial('OPERACION 111111 CONFIRMADA');
    expect(esFuga('1.111,11', conNumeroDeOperacion), 'falso positivo: importe vs identificador').toBe(
      false,
    );
  });

  /**
   * El alcance del barrido es **exactamente** el de los detectores, a los dos lados.
   *
   * Un número de operación de seis dígitos pelados no matchea ningún detector: no es un CUIT (once), ni un
   * CBU (veintidós), ni un importe (no tiene coma decimal). Así que ni se extrae del material ni se busca en
   * el repo. Es coherente, y es el límite declarado — el barrido cubre lo que tiene forma, y para lo que no
   * la tiene la defensa sigue siendo la revisión.
   */
  it('lo que ningún detector reconoce queda fuera del barrido, a los dos lados', () => {
    const material = prepararMaterial('OPERACION 111111 CONFIRMADA');
    expect(esFuga('111111', material)).toBe(false);
    // Y un CUIT del mismo material sí entra, porque sí tiene forma.
    expect(esFuga('20123456789', prepararMaterial('TITULAR CUIT 20-12345678-9'))).toBe(true);
  });

  it('el precio declarado: un importe sin su coma decimal no cruza', () => {
    expect(esFuga('76543210', MATERIAL_SIMULADO)).toBe(false);
  });
});

describe('la allowlist guarda huellas, no valores', () => {
  it('la huella no permite reconstruir el valor ni lo contiene', () => {
    const valor = '765.432,10';
    const h = huellaDe(valor);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain('765');
    expect(h).not.toContain('43210');
  });

  it('dos escrituras del mismo valor dan la misma huella (si no, la allowlist no sirve)', () => {
    expect(huellaDe('765.432,10')).toBe(huellaDe('765 432,10'));
    expect(huellaDe('20-12345678-9')).toBe(huellaDe('20123456789'));
  });

  it('valores distintos dan huellas distintas', () => {
    expect(huellaDe('765.432,10')).not.toBe(huellaDe('765.432,11'));
  });
});
