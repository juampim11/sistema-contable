/**
 * INV-13 — condición de salida nº 8.
 *
 * > **Ninguna `descripcion` producida matchea los detectores de CUIT, CBU o documento.**
 *
 * No es una regla de limpieza: es lo que **sostiene la clasificación N2** de la columna. Si la descripción
 * conserva el CUIT de una contraparte, el dato es de un tercero que no es cliente del estudio y que nunca
 * consintió nada — o sea N2R — y entonces leer movimientos tendría que pasar por el lector auditado. Con
 * 326 filas por pantalla, eso llena la auditoría de ruido y la vuelve inútil para detectar el acceso masivo
 * real (H-8).
 *
 * Todas las glosas de este archivo son **sintéticas**, con verificador de CUIT y de CBU inválido.
 */

import { describe, expect, it } from 'vitest';
import { contieneDatoSensible } from '@sistema-contable/shared/seguridad';
import { contieneIdentificador, depurarGlosa, MARCADOR } from '../src/glosa.ts';
import { extractoSintetico } from '../src/seed/extracto-sintetico.ts';

/**
 * Glosas con la **forma** de las que publica un banco: concepto, nombre de contraparte e identificadores
 * pegados en el texto libre. Los valores son sintéticos.
 */
const GLOSAS = [
  'TRANSFERENCIA RECIBIDA DE EMPRESA DE PRUEBA 07 SRL CUIT 20-12345678-9',
  'PAGO A PROVEEDOR 20123456789 FACTURA A 0001-00000123',
  'TRANSF CBU 9990000090000000000001 A EMPRESA DE PRUEBA 08 SA',
  'DEBITO AUTOMATICO SERVICIOS DNI 12345678',
  'CREDITO POR VENTAS 9990000090000000000002 LIQUIDACION',
  'RETENCION IIBB CUIT 27-98765432-1 JURISDICCION 901',
  'COMISION MANTENIMIENTO DE CUENTA',
];

describe('INV-13: ningún identificador con forma sobrevive en la descripción', () => {
  it.each(GLOSAS)('depura: %s', (glosa) => {
    const r = depurarGlosa(glosa);
    expect(contieneIdentificador(r.descripcion), `sobrevivió un identificador: ${r.descripcion}`).toBe(
      false,
    );
  });

  it('y tampoco matchea los detectores del redactor de logs', () => {
    // Los detectores son la definición operativa de "dato sensible" en el repo. Que la descripción no
    // matchee ninguno es lo que permite listarla sin que el logger la tape entera.
    for (const glosa of GLOSAS) {
      const { descripcion } = depurarGlosa(glosa);
      expect(contieneDatoSensible(descripcion), `matcheó un detector: ${descripcion}`).toBe(false);
    }
  });
});

describe('lo que se saca no se pierde: va a la fila cruda N2R', () => {
  /**
   * Descartar los identificadores en vez de guardarlos sería peor que dejarlos: el CUIT de la contraparte
   * es el dato con el que el Módulo 2 va a matchear el tercero. Se mueve de lugar, no se destruye.
   */
  it('el CUIT extraído está disponible, entero, para la satélite', () => {
    const r = depurarGlosa('TRANSFERENCIA DE EMPRESA DE PRUEBA 07 SRL CUIT 20-12345678-9');
    expect(r.identificadores.cuit).toEqual(['20-12345678-9']);
    expect(r.descripcion).toContain(MARCADOR.cuit);
  });

  it('el CBU también', () => {
    const r = depurarGlosa('TRANSF CBU 9990000090000000000001 A TERCERO');
    expect(r.identificadores.cbu).toEqual(['9990000090000000000001']);
  });

  it('varios identificadores en la misma glosa se extraen todos', () => {
    const r = depurarGlosa('PAGO 20123456789 Y 27987654321 EN UNA LINEA');
    expect(r.identificadores.cuit.length).toBe(2);
    expect(contieneIdentificador(r.descripcion)).toBe(false);
  });
});

describe('el orden de los patrones: de más largo a más corto', () => {
  /**
   * Un CBU tiene 22 dígitos y **contiene** corridas de 11 y de 8. Si el CUIT se buscara primero, se comería
   * los primeros once dígitos del CBU y dejaría los otros once sueltos en la descripción — o sea, INV-13
   * fallaría por un detalle de orden.
   */
  it('un CBU se reconoce como CBU, no como dos pedazos', () => {
    const r = depurarGlosa('TRANSF 9990000090000000000001 FIN');
    expect(r.identificadores.cbu).toEqual(['9990000090000000000001']);
    expect(r.identificadores.cuit).toEqual([]);
    expect(r.descripcion).toBe(`TRANSF ${MARCADOR.cbu} FIN`);
    expect(contieneIdentificador(r.descripcion)).toBe(false);
  });
});

describe('lo que INV-13 NO promete, declarado', () => {
  /**
   * El nombre propio y la razón social **no se sacan**, y no es una limitación a lamentar: el nombre de la
   * contraparte es justo lo que el contador necesita para clasificar el movimiento. Por eso `descripcion`
   * es N2 y no N1 — no es un dato inocuo, es un dato que el contador tiene derecho a ver sin ceremonia.
   */
  it('la razón social sobrevive, a propósito', () => {
    const r = depurarGlosa('TRANSFERENCIA DE EMPRESA DE PRUEBA 07 SRL CUIT 20-12345678-9');
    expect(r.descripcion).toContain('EMPRESA DE PRUEBA 07 SRL');
  });

  it('el concepto también: es lo que se clasifica', () => {
    expect(depurarGlosa('COMISION MANTENIMIENTO DE CUENTA').descripcion).toBe(
      'COMISION MANTENIMIENTO DE CUENTA',
    );
  });
});

describe('la verificación del verificador', () => {
  it('`contieneIdentificador` da TRUE sobre una glosa sin depurar', () => {
    // Si diera false para todo, INV-13 pasaría siempre y no verificaría nada.
    const conIdentificadores = GLOSAS.filter((g) => contieneIdentificador(g));
    expect(conIdentificadores.length, 'el verificador no detecta nada: INV-13 es vacío').toBe(
      GLOSAS.length - 1, // la última no tiene ninguno
    );
  });

  it('usa los MISMOS patrones que la depuración', () => {
    // Dos listas de patrones divergen. Esto fija que agregar una clase nueva la haga conocer a los dos
    // lados: si `depurarGlosa` enmascara algo que `contieneIdentificador` no busca, este test no lo ve —
    // pero si busca algo que la depuración no enmascara, INV-13 se pone rojo enseguida.
    for (const glosa of GLOSAS) {
      expect(contieneIdentificador(depurarGlosa(glosa).descripcion)).toBe(false);
    }
  });
});

describe('sobre el extracto sintético completo, fila por fila', () => {
  it('ninguna descripción del fixture lleva un identificador', () => {
    const extracto = extractoSintetico({
      semilla: 7,
      cantidadMovimientos: 60,
      saldoInicialCentavos: 1_000_000n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
    });
    let revisadas = 0;

    for (const mov of extracto.movimientos) {
      // Se depura la glosa **con un identificador inyectado**: el generador actual produce conceptos
      // limpios, así que sin la inyección el test pasaría sin ejercitar nada. Lo que se verifica es que la
      // depuración funcione sobre las glosas que el fixture produce, no que el fixture ya venga limpio.
      const conIdentificador = `${mov.descripcion} CUIT 20-12345678-9 CBU 9990000090000000000001`;
      expect(contieneIdentificador(conIdentificador), 'el caso no prueba nada').toBe(true);

      const { descripcion } = depurarGlosa(conIdentificador);
      expect(contieneIdentificador(descripcion), `fila con identificador: ${descripcion}`).toBe(false);
      revisadas += 1;
    }

    // Sin esta aserción, un generador que devolviera cero movimientos haría pasar el test sin revisar
    // nada — el mismo modo de falla que "0 movimientos NUNCA es éxito" en la verificación aritmética.
    expect(revisadas, 'no se revisó ninguna fila').toBeGreaterThan(50);
  });
});
