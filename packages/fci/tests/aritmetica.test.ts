import { describe, expect, it } from 'vitest';
import {
  aPuntoFijo,
  comparar,
  DecimalInvalidoError,
  esCero,
  formatear,
  minimo,
  multiplicar,
  restar,
  sumar,
} from '../src/nucleo/aritmetica.ts';

describe('aritmetica', () => {
  describe('multiplicar — trunca hacia cero, incluida la mitad exacta', () => {
    it('empate exacto en signo positivo: recorta el medio punto hacia abajo', () => {
      // 1.000003 * 1.5 = 1.5000045 → resto exacto de medio dígito en la escala interna (1e12).
      // Redondeando se esperaría 1.500005; truncando hacia cero da 1.500004.
      const resultado = multiplicar(aPuntoFijo('1.000003'), aPuntoFijo('1.5'));
      expect(formatear(resultado)).toBe('1.500004');
    });

    it('empate exacto en signo negativo: recorta el medio punto hacia arriba (hacia cero)', () => {
      // Mismo empate que el caso anterior, con el signo invertido: -1.5000045. Redondeando "lejos de
      // cero" se esperaría -1.500005; truncando hacia cero da -1.500004, simétrico al caso positivo.
      const resultado = multiplicar(aPuntoFijo('1.000003'), aPuntoFijo('-1.5'));
      expect(formatear(resultado)).toBe('-1.500004');
    });

    it('caso sin empate: el resultado exacto no depende de ninguna política de redondeo', () => {
      const resultado = multiplicar(aPuntoFijo('2.5'), aPuntoFijo('4'));
      expect(formatear(resultado)).toBe('10.000000');
    });
  });

  describe('sumar / restar', () => {
    it('suma dos magnitudes positivas', () => {
      expect(formatear(sumar(aPuntoFijo('10.50'), aPuntoFijo('5.25')))).toBe('15.750000');
    });

    it('resta da negativo cuando el sustraendo es mayor', () => {
      expect(formatear(restar(aPuntoFijo('5.00'), aPuntoFijo('8.00')))).toBe('-3.000000');
    });

    it('resta con cero no altera el valor', () => {
      expect(formatear(restar(aPuntoFijo('7.123456'), aPuntoFijo('0')))).toBe('7.123456');
    });
  });

  describe('comparar', () => {
    it('-1 cuando el primero es menor', () => {
      expect(comparar(aPuntoFijo('1.00'), aPuntoFijo('2.00'))).toBe(-1);
    });

    it('1 cuando el primero es mayor', () => {
      expect(comparar(aPuntoFijo('2.00'), aPuntoFijo('1.00'))).toBe(1);
    });

    it('0 cuando son iguales', () => {
      expect(comparar(aPuntoFijo('3.14'), aPuntoFijo('3.14'))).toBe(0);
    });

    it('compara correctamente con negativos', () => {
      expect(comparar(aPuntoFijo('-5.00'), aPuntoFijo('-1.00'))).toBe(-1);
    });
  });

  describe('esCero', () => {
    it('true para el cero exacto', () => {
      expect(esCero(aPuntoFijo('0'))).toBe(true);
    });

    it('true para "0.000000" con ceros explícitos', () => {
      expect(esCero(aPuntoFijo('0.000000'))).toBe(true);
    });

    it('false para cualquier valor no nulo, incluido uno negativo', () => {
      expect(esCero(aPuntoFijo('-0.000001'))).toBe(false);
    });
  });

  describe('minimo', () => {
    it('devuelve el menor de dos positivos', () => {
      expect(formatear(minimo(aPuntoFijo('3.00'), aPuntoFijo('7.00')))).toBe('3.000000');
    });

    it('devuelve el negativo cuando se compara contra un positivo', () => {
      expect(formatear(minimo(aPuntoFijo('-1.00'), aPuntoFijo('1.00')))).toBe('-1.000000');
    });

    it('con dos iguales devuelve ese valor', () => {
      expect(formatear(minimo(aPuntoFijo('4.50'), aPuntoFijo('4.50')))).toBe('4.500000');
    });
  });

  describe('formatear', () => {
    it('siempre deja exactamente 6 decimales', () => {
      expect(formatear(aPuntoFijo('42'))).toBe('42.000000');
    });

    it('conserva el signo negativo', () => {
      expect(formatear(aPuntoFijo('-0.5'))).toBe('-0.500000');
    });
  });

  describe('aPuntoFijo — rechaza en vez de rellenar', () => {
    it('tira DecimalInvalidoError con texto que no es un decimal', () => {
      expect(() => aPuntoFijo('12.5x')).toThrow(DecimalInvalidoError);
    });

    it('tira DecimalInvalidoError con más decimales que la escala', () => {
      expect(() => aPuntoFijo('1.1234567')).toThrow(DecimalInvalidoError);
    });

    it('el error lleva código, nunca el texto recibido en el mensaje', () => {
      expect.assertions(3);
      try {
        aPuntoFijo('no-es-un-numero');
      } catch (error) {
        expect(error).toBeInstanceOf(DecimalInvalidoError);
        expect((error as DecimalInvalidoError).codigo).toBe('FCI_DECIMAL_INVALIDO');
        expect((error as DecimalInvalidoError).message).not.toContain('no-es-un-numero');
      }
    });
  });
});
