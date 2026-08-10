/**
 * El contrato de `forma()` — condición de salida nº 7.
 *
 * `forma()` existe para poder loguear una línea que el adapter no entendió **sin loguear la línea**. Su
 * valor entero depende de una sola propiedad, y es la que este archivo verifica:
 *
 * > **`forma()` de cualquier texto no matchea ningún detector de `redactar.ts`.**
 *
 * Los detectores son la definición operativa de "dato sensible" en este repo. No matchear ninguno es la
 * prueba de que no quedó nada — y es lo que permite loguearla sin pensarlo dos veces.
 */

import { describe, expect, it } from 'vitest';
import { esForma, forma, formaParaLog } from '../src/observabilidad/forma.ts';
import { contieneDatoSensible, DETECTORES, redactarTexto } from '../src/seguridad/redactar.ts';

/**
 * Textos con la FORMA de lo que aparece en un extracto. Los valores son sintéticos e inválidos a
 * propósito (verificador de CUIT y CBU inválido, entidad inexistente).
 */
const CON_DATO = [
  '01/06/26 CONCEPTO DE PRUEBA UNO 0112 -4.321,00 765.432,10',
  'EMPRESA DE PRUEBA 07 SRL',
  '20123456789',
  '9990000090000000000001',
  'CUIT 20-12345678-9 pago de servicios',
  'postgres://usuario:secreto123@base.interna:5432/contable',
  'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.zzzzzzzzzzz',
  '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
  'Resumen 0170-1234-5678901234 junio',
  'Key (cliente_id, cbu)=(7ab4, 9990000090000000000001) already exists',
];

describe('forma(): no conserva ningún carácter de dato', () => {
  it.each(CON_DATO)('la forma no contiene ni un dígito ni una letra del original: %s', (texto) => {
    // Primero: el texto original SÍ es sensible (si no, el caso no prueba nada).
    // Se exceptúan los que son solo nombres propios: el redactor no los puede reconocer y es un límite
    // conocido — justamente por eso existe `forma()`.
    const esNombreSuelto = texto === 'EMPRESA DE PRUEBA 07 SRL';
    if (!esNombreSuelto) {
      expect(contieneDatoSensible(texto), 'el caso no prueba nada si el original no es sensible').toBe(
        true,
      );
    }

    const f = forma(texto);
    // La propiedad que garantiza que no filtra un valor: cero dígitos, y solo A/a como letras.
    expect(/[0-9]/.test(f), `la forma conservó un dígito: ${f}`).toBe(false);
    expect(esForma(f), `la forma conservó una letra del original: ${f}`).toBe(true);
    // Y ningún valor del original sobrevive.
    for (const token of texto.split(/[\s,()=]+/).filter((t) => t.length >= 4)) {
      expect(f.includes(token), `sobrevivió el token de ${token.length} caracteres`).toBe(false);
    }
  });
});

describe('formaParaLog(): lo que REALMENTE va a un log no matchea ningún detector', () => {
  it.each(CON_DATO)('no matchea nada: %s', (texto) => {
    const f = formaParaLog(texto);
    expect(contieneDatoSensible(f), `matcheó un detector: ${f}`).toBe(false);
    expect(redactarTexto(f).detectores).toEqual([]);
  });

  it('ningún detector matchea, uno por uno', () => {
    for (const texto of CON_DATO) {
      const f = formaParaLog(texto);
      for (const d of DETECTORES) {
        const re = new RegExp(d.patron.source, d.patron.flags);
        expect(re.test(f), `el detector "${d.nombre}" matcheó: ${f}`).toBe(false);
      }
    }
  });
});

describe('forma() conserva lo que sirve para depurar', () => {
  it('conserva longitud, posición, separadores y signo', () => {
    expect(forma('01/06/26 ABC def 0112 -4.321,00')).toBe('##/##/## AAA aaa #### -#.###,##');
  });

  it('es idempotente', () => {
    const f = forma('01/06/26 CONCEPTO 4.321,00');
    expect(forma(f)).toBe(f);
  });

  it('no cambia la cantidad de caracteres', () => {
    for (const texto of CON_DATO) expect(forma(texto).length).toBe(texto.length);
  });

  it('deja ver la estructura de columnas de ancho fijo', () => {
    const f = forma('01/06   CONCEPTO      1.234,56   9.876,54');
    expect(f).toContain('   ');
    expect(f).toBe('##/##   AAAAAAAA      #.###,##   #.###,##');
  });
});

describe('formaParaLog acota lo que va a una línea de log', () => {
  it('colapsa las corridas largas', () => {
    expect(formaParaLog('AAAAAAAAAAAAAAAAAAAA')).toBe('A{20}');
  });

  it('trunca lo patológico', () => {
    const largo = formaParaLog('x'.repeat(500), 40);
    expect(largo.length).toBeLessThanOrEqual(40);
  });

  it('una corrida de 200 letras se colapsa y no llega al detector de base64', () => {
    expect(formaParaLog('X'.repeat(200))).toBe('A{200}');
    expect(contieneDatoSensible(formaParaLog('X'.repeat(200)))).toBe(false);
  });
});
