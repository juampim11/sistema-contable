/**
 * Clasificadores puros del extractor de Santander (`comoEncabezadoDeFondo`, `comoEtiquetaDeSaldo`,
 * `camposDeLinea`, `comoSaldoDeLinea`, `comoMovimientoDeLinea`, `nombreFondoExpuestoSantander`),
 * ejercitados DIRECTO con líneas de texto sintéticas (formato `pdftotext -layout`), sin pasar por
 * ningún PDF real — mismo patrón que `fci-galicia-extraer-posiciones.test.ts`.
 *
 * Todas las cifras y nombres de este archivo son SINTÉTICOS: ningún valor sale de un extracto real de
 * ningún cliente (mismo criterio que ya documenta `packages/ingesta/src/parseo-ar.ts`, hallazgo H-A).
 */

import { describe, expect, it } from 'vitest';
import {
  BuildDePdftotextIncorrectaError,
  camposDeLinea,
  comoEncabezadoDeFondo,
  comoEtiquetaDeSaldo,
  comoMovimientoDeLinea,
  comoSaldoDeLinea,
  ConsistenciaInternaPdftotextError,
  EncabezadoDeFondoNoEncontradoError,
  FechaMovimientoInvalidaError,
  nombreFondoExpuestoSantander,
  OrdenMovimientoInvalidoError,
  SaldoDesalineadoError,
  SaldoFaltanteError,
} from '../src/fci-santander/extraer-posiciones.ts';

describe('comoEncabezadoDeFondo', () => {
  it('reconoce "Fondo: <nombre>" y expone el nombre', () => {
    expect(comoEncabezadoDeFondo('Fondo: Renta Sintetica Plus')).toBe('Renta Sintetica Plus');
  });

  it('recorta "Moneda: ARS" cuando viene pegado en la misma línea', () => {
    expect(comoEncabezadoDeFondo('Fondo: Renta Sintetica Plus Moneda: ARS')).toBe('Renta Sintetica Plus');
  });

  it('una línea sin "Fondo:" devuelve null', () => {
    expect(comoEncabezadoDeFondo('Cualquier otro texto de la línea')).toBeNull();
  });

  it('una línea donde la etiqueta se repite sin nombre real después ("Fondo: Fondo:") NO abre un fondo', () => {
    expect(comoEncabezadoDeFondo('Fondo: Fondo:')).toBeNull();
  });

  it('una línea "Fondo:" sin nada después tampoco abre un fondo', () => {
    expect(comoEncabezadoDeFondo('Fondo:')).toBeNull();
    expect(comoEncabezadoDeFondo('Fondo:   ')).toBeNull();
  });

  it('reconoce el encabezado SIN el carácter ":" — hallazgo real: 2 de 3 encabezados del documento real no lo traen', () => {
    expect(comoEncabezadoDeFondo('Fondo Renta Sintetica Plus')).toBe('Renta Sintetica Plus');
  });

  it('reconoce el encabezado con un guion como separador', () => {
    expect(comoEncabezadoDeFondo('Fondo - Renta Sintetica Plus')).toBe('Renta Sintetica Plus');
  });

  it('LÍMITE CONOCIDO, documentado a propósito: una mención suelta y CORTA de "Fondo" pegada dentro de otra palabra SÍ se reconoce como encabezado — no hay anclaje de posición, solo el guard de longitud', () => {
    expect(comoEncabezadoDeFondo('cualquierSuperFondo Renta $ F.C.I. A')).toBe('Renta $ F.C.I. A');
  });

  it('SÍ reconoce un fondo cuyo propio nombre contiene "Fondo" pegado, cuando la etiqueta está al principio (caso real: "SuperFondo Renta $ F.C.I. A")', () => {
    expect(comoEncabezadoDeFondo('Fondo SuperFondo Renta $ F.C.I. A')).toBe('SuperFondo Renta $ F.C.I. A');
  });

  it('descarta una mención larga de "Fondo" dentro de una oración de texto legal/prosa — no es un encabezado', () => {
    const oracionLegal =
      'Fondo de Garantia de los Depositos establece un limite de cobertura segun la normativa vigente del Banco Central de la Republica Argentina';
    expect(comoEncabezadoDeFondo(oracionLegal)).toBeNull();
  });
});

describe('comoEtiquetaDeSaldo', () => {
  it('reconoce SALDO INICIAL', () => {
    expect(comoEtiquetaDeSaldo('SALDO INICIAL')).toBe('inicial');
  });

  it('reconoce SALDO FINAL', () => {
    expect(comoEtiquetaDeSaldo('SALDO FINAL')).toBe('final');
  });

  it('una línea que no menciona SALDO INICIAL ni SALDO FINAL devuelve null', () => {
    expect(comoEtiquetaDeSaldo('Certificado')).toBeNull();
  });
});

describe('camposDeLinea', () => {
  it('parte por 2 o más espacios consecutivos, nunca por un espacio simple', () => {
    expect(camposDeLinea('SALDO INICIAL  12.345,67')).toEqual(['SALDO INICIAL', '12.345,67']);
  });

  it('recorta espacios de punta de cada campo', () => {
    expect(camposDeLinea('  A   B  ')).toEqual(['A', 'B']);
  });

  it('una línea sin separadores de 2+ espacios da un solo campo', () => {
    expect(camposDeLinea('Fondo: Renta Sintetica')).toEqual(['Fondo: Renta Sintetica']);
  });

  it('una línea vacía da un array vacío', () => {
    expect(camposDeLinea('')).toEqual([]);
  });
});

describe('comoSaldoDeLinea', () => {
  it('reconoce SALDO INICIAL con su importe (único campo con 2 decimales)', () => {
    const resultado = comoSaldoDeLinea('SALDO INICIAL  12.345,67');
    expect(resultado).toEqual({ tipo: 'inicial', importe: '12345.67' });
  });

  it('reconoce SALDO FINAL', () => {
    const resultado = comoSaldoDeLinea('SALDO FINAL  9.876,54');
    expect(resultado).toEqual({ tipo: 'final', importe: '9876.54' });
  });

  it('despega el prefijo de moneda ($) antes de convertir a decimal canónico', () => {
    expect(comoSaldoDeLinea('SALDO INICIAL  $ 1.000,00')).toEqual({ tipo: 'inicial', importe: '1000.00' });
  });

  it('una línea SALDO sin ningún campo de 2 decimales devuelve null (no se inventa el importe)', () => {
    expect(comoSaldoDeLinea('SALDO INICIAL')).toBeNull();
  });

  it('una línea SALDO con MÁS de un campo de 2 decimales devuelve null (ambiguo, no se adivina cuál)', () => {
    expect(comoSaldoDeLinea('SALDO INICIAL  12.345,67  99,00')).toBeNull();
  });

  it('una línea que no es de saldo devuelve null', () => {
    expect(comoSaldoDeLinea('Certificado  1.234,00')).toBeNull();
  });
});

describe('comoMovimientoDeLinea', () => {
  // Orden real medido contra el documento: Fecha, Concepto, Certificado, Cantidad(4dec), Valor(6dec),
  // Importe(2dec) — el orden físico de columnas no importa acá, se identifica por decimales.
  const lineaDeRescate = '01/06/2026  RESCATE  1234567  100,0000  1.500,000000  150.000,00';

  it('reconoce una línea de rescate completa: cantidad(4dec)/valor(6dec)/importe(2dec) por FORMA, no por posición', () => {
    const resultado = comoMovimientoDeLinea(lineaDeRescate);
    expect(resultado).toEqual({
      tipo: 'rescate',
      cantidad: '100.0000',
      precio: '1500.000000',
      importe: '150000.00',
      certificado: '1234567',
      fechaCruda: '01/06/2026',
    });
  });

  it('reconoce suscripción por la palabra SUSCRIP en la línea', () => {
    const linea = '15/06/2026  SUSCRIPCION  7654321  53,0000  1.600,000000  84.800,00';
    expect(comoMovimientoDeLinea(linea)?.tipo).toBe('suscripcion');
  });

  it('el orden físico de los campos no importa — reconoce igual si Certificado viene DESPUÉS de Importe', () => {
    const linea = '20/06/2026  RESCATE  10,0000  1.550,000000  15.500,00  1111111';
    const resultado = comoMovimientoDeLinea(linea);
    expect(resultado).toEqual({
      tipo: 'rescate',
      cantidad: '10.0000',
      precio: '1550.000000',
      importe: '15500.00',
      certificado: '1111111',
      fechaCruda: '20/06/2026',
    });
  });

  it('sin fecha al principio de la línea, devuelve null', () => {
    expect(comoMovimientoDeLinea('RESCATE  1234567  100,0000  1.500,000000  150.000,00')).toBeNull();
  });

  it('sin la palabra suscripción ni rescate, devuelve null', () => {
    expect(comoMovimientoDeLinea('01/06/2026  1234567  100,0000  1.500,000000  150.000,00')).toBeNull();
  });

  it('sin certificado (ningún campo de 7 dígitos), el campo queda vacío pero el resto se reconoce igual', () => {
    const linea = '01/06/2026  RESCATE  100,0000  1.500,000000  150.000,00';
    const resultado = comoMovimientoDeLinea(linea);
    expect(resultado?.certificado).toBe('');
    expect(resultado?.cantidad).toBe('100.0000');
  });

  it('falta Cantidad (4 decimales) — devuelve null, nunca se fuerza con lo que falte', () => {
    const linea = '01/06/2026  RESCATE  1234567  1.500,000000  150.000,00';
    expect(comoMovimientoDeLinea(linea)).toBeNull();
  });

  it('una línea de leyenda/rótulo que menciona "rescate" en prosa, sin fecha, no cuenta como movimiento', () => {
    expect(comoMovimientoDeLinea('Consulte las condiciones de rescate')).toBeNull();
  });

  it('reconoce varias líneas de rescate reales por separado, cada una con su propio certificado', () => {
    const lineas = [
      '05/06/2026  RESCATE  1111111  10,0000  1.550,000000  15.500,00',
      '12/06/2026  RESCATE  2222222  10,0000  1.560,000000  15.600,00',
      '20/06/2026  RESCATE  3333333  10,0000  1.570,000000  15.700,00',
      '27/06/2026  RESCATE  4444444  10,0000  1.580,000000  15.800,00',
    ];
    const resultados = lineas.map(comoMovimientoDeLinea);
    expect(resultados.every((r) => r !== null)).toBe(true);
    expect(resultados.filter((r) => r?.tipo === 'rescate')).toHaveLength(4);
    expect(new Set(resultados.map((r) => r?.certificado))).toEqual(new Set(['1111111', '2222222', '3333333', '4444444']));
  });
});

describe('Errores — identifican el punto exacto, nunca contenido ni un mensaje genérico', () => {
  it('SaldoFaltanteError identifica fondo e inicial/final por índice, sin nombre de fondo', () => {
    const error = new SaldoFaltanteError(2, 'final');
    expect(error.message).toContain('#2');
    expect(error.message).toContain('FINAL');
    expect(error.indiceDeFondo).toBe(2);
    expect(error.cual).toBe('final');
  });

  it('EncabezadoDeFondoNoEncontradoError identifica el número de bloque', () => {
    const error = new EncabezadoDeFondoNoEncontradoError(2);
    expect(error.message).toContain('#2');
    expect(error.numeroDeBloqueDeDatos).toBe(2);
  });

  it('ConsistenciaInternaPdftotextError reporta los dos conteos', () => {
    const error = new ConsistenciaInternaPdftotextError(4, 3);
    expect(error.message).toContain('4');
    expect(error.message).toContain('3');
    expect(error.conteoFondos).toBe(4);
    expect(error.conteoBloques).toBe(3);
  });

  it('SaldoDesalineadoError identifica el bloque y el motivo exacto', () => {
    const error = new SaldoDesalineadoError(2, 'inicial_duplicado_sin_final_previo');
    expect(error.message).toContain('Bloque #2');
    expect(error.message).toContain('inicial_duplicado_sin_final_previo');
    expect(error.numeroDeBloque).toBe(2);
    expect(error.motivo).toBe('inicial_duplicado_sin_final_previo');
  });

  it('BuildDePdftotextIncorrectaError menciona Poppler, para que quede claro qué build hace falta', () => {
    expect(new BuildDePdftotextIncorrectaError().message).toContain('Poppler');
  });

  it('OrdenMovimientoInvalidoError y FechaMovimientoInvalidaError tienen mensaje propio, sin dato', () => {
    expect(new OrdenMovimientoInvalidoError().name).toBe('OrdenMovimientoInvalidoError');
    expect(new FechaMovimientoInvalidaError().name).toBe('FechaMovimientoInvalidaError');
  });
});

describe('nombreFondoExpuestoSantander', () => {
  it('deja intacto un nombre ya bien formado', () => {
    expect(nombreFondoExpuestoSantander('Renta Sintetica Plus')).toBe('Renta Sintetica Plus');
  });

  it('recorta "Moneda: ARS" si viene arrastrado', () => {
    expect(nombreFondoExpuestoSantander('Renta Sintetica Plus Moneda: ARS')).toBe('Renta Sintetica Plus');
  });

  it('colapsa espacios internos repetidos', () => {
    expect(nombreFondoExpuestoSantander('Renta   Sintetica  Plus')).toBe('Renta Sintetica Plus');
  });

  it('recorta espacios de punta', () => {
    expect(nombreFondoExpuestoSantander('  Renta Sintetica Plus  ')).toBe('Renta Sintetica Plus');
  });
});
