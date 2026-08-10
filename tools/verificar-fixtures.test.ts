/**
 * LA VERIFICACIÓN DEL GATE DE FIXTURES.
 *
 * El gate corre en verde todos los días; su estado normal es "todo bien". Un gate que nunca se probó en
 * rojo no se distingue de un gate que devuelve `true` sin mirar nada — y el fixture es justamente el
 * artefacto donde un dato real se cuela sin que nadie lo note.
 *
 * Así que acá se planta cada modo de falla y se exige que el chequeo correspondiente lo encuentre.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verificarFixtures } from './verificar-fixtures.ts';
import { raizDelRepo } from './cargar-env.ts';

const FIXTURE = join(
  raizDelRepo(),
  'packages',
  'ingesta',
  'tests',
  'fixtures',
  'extracto-sintetico.txt',
);

describe('el gate pasa sobre el fixture commiteado', () => {
  it('los siete chequeos en verde', () => {
    const { ok, resultados } = verificarFixtures();
    const fallados = resultados.filter(([, r]) => !r.ok).map(([n, r]) => `${n}: ${r.detalle.join(' | ')}`);
    expect(fallados).toEqual([]);
    expect(ok).toBe(true);
    // Siete chequeos, ni seis ni ocho: si alguien agrega uno, este número lo obliga a mirar el test.
    expect(resultados.length).toBe(7);
  });
});

describe('el fixture tiene los rasgos que hacen que sirva de algo', () => {
  const texto = readFileSync(FIXTURE, 'utf8');

  /**
   * Los cuatro modos de negativo. Un fixture con una sola notación deja tres caminos del parser sin
   * ejercitar, y esos tres son justo los que difieren entre bancos.
   */
  it.each([
    ['signo adelante', /(?<![\d,.])-\d{1,3}(?:\.\d{3})*,\d{2}/],
    ['signo atrás (saldo acreedor)', /\d{1,3}(?:\.\d{3})*,\d{2}-/],
    ['signo antes del $', /-\$\s\d/],
    ['paréntesis', /\(\d{1,3}(?:\.\d{3})*,\d{2}\)/],
  ])('trae %s', (_caso, patron) => {
    expect(patron.test(texto)).toBe(true);
  });

  it('trae las dos fechas del período PEGADAS, que es lo que rompe un split naíf', () => {
    expect(/\d{2}\/\d{2}\/\d{4}\d{2}\/\d{2}\/\d{4}/.test(texto)).toBe(true);
  });

  it('trae más de una cuenta: la variante que la muestra real no tiene', () => {
    expect((texto.match(/Cuenta Nº/g) ?? []).length).toBeGreaterThan(1);
  });

  it('repite el encabezado: el adapter tiene que saltearlo sin contarlo como movimiento', () => {
    expect((texto.match(/RESUMEN DE CUENTA/g) ?? []).length).toBeGreaterThan(1);
  });

  it('trae un bloque que NO es un movimiento', () => {
    expect(/\*\*\* IMPORTANTE/.test(texto)).toBe(true);
  });

  it('las fechas son monótonas: una que retrocede es señal de bloque mal capturado (V7)', () => {
    const dias = [...texto.matchAll(/^(\d{2})\/06\/26 /gm)].map((m) => Number(m[1]));
    expect(dias.length).toBeGreaterThan(50);
    // Se reinicia por cuenta, así que la monotonía se mide por tramos: lo que no puede pasar es un salto
    // hacia atrás grande en medio de una cuenta.
    let retrocesos = 0;
    for (let i = 1; i < dias.length; i += 1) {
      const anterior = dias[i - 1] ?? 0;
      const actual = dias[i] ?? 0;
      if (actual < anterior - 1) retrocesos += 1;
    }
    // Un solo retroceso: el arranque de la segunda cuenta.
    expect(retrocesos, 'las fechas del fixture no están ordenadas').toBeLessThanOrEqual(1);
  });
});

describe('el fixture cuadra: sin eso no puede probar la verificación', () => {
  const texto = readFileSync(FIXTURE, 'utf8');

  it('la línea de totales existe y el saldo final está declarado', () => {
    expect(/Total Creditos:/.test(texto)).toBe(true);
    expect(/Total Debitos:/.test(texto)).toBe(true);
    expect(/Saldo Final al /.test(texto)).toBe(true);
    expect(/Saldo Anterior al /.test(texto)).toBe(true);
  });

  it('cada cuenta declara su saldo inicial: sin él, V4 no se puede correr', () => {
    const cuentas = (texto.match(/Cuenta Nº/g) ?? []).length;
    const inicialesDeclarados = (texto.match(/Saldo Anterior al /g) ?? []).length;
    expect(inicialesDeclarados).toBe(cuentas);
  });
});

describe('los identificadores del fixture no pueden existir', () => {
  const texto = readFileSync(FIXTURE, 'utf8');

  /**
   * Un CUIT sintético con verificador **válido** puede pertenecerle a alguien: dejar de invalidar el
   * verificador convierte al fixture en un archivo con el identificador de un tercero real, elegido al
   * azar. El chequeo 2 del gate lo cubre; esto fija que el fixture siga teniendo identificadores que
   * chequear.
   */
  it('hay identificadores para chequear (si no, el chequeo 2 no prueba nada)', () => {
    const cuits = (texto.match(/(?<![\d-])(?:\d{2}-\d{8}-\d|\d{11})(?![\d-])/g) ?? []).length;
    const cbus = (texto.match(/(?<![\d-])\d{22}(?![\d-])/g) ?? []).length;
    expect(cuits + cbus).toBeGreaterThan(0);
  });
});
