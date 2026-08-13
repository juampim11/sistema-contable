/**
 * MUTACIÓN DEL LÉXICO — `05-motor-de-reconocimiento.md` §8.3: cada mutación tiene que poner rojo una
 * propiedad NOMBRADA. Si alguna no la ataja nadie, es un agujero declarado, no un silencio.
 *
 * Los cuatro objetivos se eligieron para ser genuinamente ÚNICOS (sin redundancia cross-banco) — con
 * tres léxicos ya escritos, varios conceptos/tipos se alcanzan por más de un banco, y una mutación sobre
 * una entrada redundante no rompe nada (otro banco sigue cubriendo el mismo concepto/tipo). Elegir un
 * objetivo redundante habría sido el "agujero declarado" que este archivo existe para evitar.
 */

import { describe, expect, it } from 'vitest';
import { CATALOGO_CANONICO, ESTADO_DE_LOS_TIPOS, type ConceptoCanonico, type FilaDelCatalogo } from '../src/nucleo/catalogo.ts';
import { LEXICO_GALICIA } from '../src/lexico/galicia.ts';
import { LEXICO_SANTANDER } from '../src/lexico/santander.ts';
import { LEXICO_MACRO } from '../src/lexico/macro.ts';
import type { LexicoDeBanco, EntradaLexico } from '../src/nucleo/lexico.ts';
import { verificarPropiedades, type NombrePropiedad } from './propiedades.ts';

const LEXICOS_REALES = [LEXICO_GALICIA, LEXICO_SANTANDER, LEXICO_MACRO];

function clonarLexicos(): LexicoDeBanco[] {
  return structuredClone(LEXICOS_REALES) as LexicoDeBanco[];
}
function clonarCatalogo(): Record<ConceptoCanonico, FilaDelCatalogo> {
  return structuredClone(CATALOGO_CANONICO) as Record<ConceptoCanonico, FilaDelCatalogo>;
}

function reemplazarEntradaGalicia(lexicos: LexicoDeBanco[], id: string, entrada: EntradaLexico | null): void {
  const galicia = lexicos.find((l) => l.banco === 'galicia');
  if (!galicia) throw new Error('galicia no está en el clon');
  const entradas = entrada
    ? galicia.entradas.map((e) => (e.id === id ? entrada : e))
    : galicia.entradas.filter((e) => e.id !== id);
  (galicia as { entradas: readonly EntradaLexico[] }).entradas = entradas;
}

describe('mutación del léxico — cada una pone rojo una propiedad NOMBRADA', () => {
  it('el verificador da VERDE sobre el léxico real (anti-falso-verde: sin esto, las 4 pasarían sin verificar nada)', () => {
    expect(verificarPropiedades(LEXICOS_REALES, CATALOGO_CANONICO, ESTADO_DE_LOS_TIPOS)).toEqual([]);
  });

  it('1. borrar una entrada (galicia.anulacion_acreditamiento_firstdata, único en todo el corpus, ' +
    'sin reuso cross-banco) → PROP-5 (concepto sin ninguna entrada que lo alcance)', () => {
    const lexicos = clonarLexicos();
    reemplazarEntradaGalicia(lexicos, 'galicia.anulacion_acreditamiento_firstdata', null);
    const infracciones = verificarPropiedades(lexicos, CATALOGO_CANONICO, ESTADO_DE_LOS_TIPOS);
    const propiedades = new Set<NombrePropiedad>(infracciones.map((i) => i.propiedad));
    expect(propiedades.has('PROP-5'), JSON.stringify(infracciones, null, 2)).toBe(true);
  });

  it('2. fusionar dos entradas (impuesto_25413_sobre_creditos + su reversa devolucion_...) bajo UN ' +
    'concepto con lados medidos opuestos → PROP-12 (coherencia de lado contra el corpus medido)', () => {
    const lexicos = clonarLexicos();
    const fusionada: EntradaLexico = {
      id: 'galicia.impuesto_25413_sobre_creditos',
      concepto: 'impuesto_25413_sobre_creditos',
      literales: ['IMP. CRE. LEY 25413', 'DEV.IMP.CRED.LEY 25413'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 8 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/05-motor-de-reconocimiento.md',
        seccion: '§0.A',
        porLiteral: [
          { literal: 'IMP. CRE. LEY 25413', movimientos: 21, lado: 'debe' },
          // La reversa mide 'haber' — el concepto único de la fusión declara ladoEsperado 'debe'.
          { literal: 'DEV.IMP.CRED.LEY 25413', movimientos: 3, lado: 'haber' },
        ],
      },
    };
    const galicia = lexicos.find((l) => l.banco === 'galicia');
    if (!galicia) throw new Error('galicia no está en el clon');
    (galicia as { entradas: readonly EntradaLexico[] }).entradas = galicia.entradas
      .filter((e) => e.id !== 'galicia.devolucion_impuesto_25413_sobre_creditos')
      .map((e) => (e.id === 'galicia.impuesto_25413_sobre_creditos' ? fusionada : e));

    const infracciones = verificarPropiedades(lexicos, CATALOGO_CANONICO, ESTADO_DE_LOS_TIPOS);
    const propiedades = new Set<NombrePropiedad>(infracciones.map((i) => i.propiedad));
    expect(propiedades.has('PROP-12'), JSON.stringify(infracciones, null, 2)).toBe(true);
  });

  it('3. invertir un ladoEsperado (impuesto_25413_sobre_creditos: debe → haber) → PROP-12 (el corpus ' +
    'medido mide débito en los 21 movimientos) Y PROP-4 (su reversa deja de tener el lado opuesto)', () => {
    const catalogo = clonarCatalogo();
    const fila = catalogo.impuesto_25413_sobre_creditos;
    if (fila.ladoEsperado === 'indistinto') throw new Error('fixture inválido');
    (catalogo as Record<string, FilaDelCatalogo>).impuesto_25413_sobre_creditos = { ...fila, ladoEsperado: 'haber' };

    const infracciones = verificarPropiedades(LEXICOS_REALES, catalogo, ESTADO_DE_LOS_TIPOS);
    const propiedades = new Set<NombrePropiedad>(infracciones.map((i) => i.propiedad));
    expect(propiedades.has('PROP-12'), JSON.stringify(infracciones, null, 2)).toBe(true);
    expect(propiedades.has('PROP-4'), JSON.stringify(infracciones, null, 2)).toBe(true);
  });

  it('4. acortar un literal (COMISION EXTRACCION EN → COMISION EXTRACCION, se pierde la palabra final) ' +
    '→ PROP-6 (el literal acortado ya no aparece entre backticks en el documento fuente)', () => {
    const lexicos = clonarLexicos();
    const galicia = lexicos.find((l) => l.banco === 'galicia');
    if (!galicia) throw new Error('galicia no está en el clon');
    const original = galicia.entradas.find((e) => e.id === 'galicia.comision_de_extraccion');
    if (!original) throw new Error('fixture inválido');
    if (original.procedencia.fuente !== 'corpus_medido') throw new Error('fixture inválido: fuente inesperada');
    const acortada: EntradaLexico = {
      ...original,
      literales: ['COMISION EXTRACCION'],
      procedencia: {
        ...original.procedencia,
        porLiteral: [{ literal: 'COMISION EXTRACCION', movimientos: 1, lado: 'debe' }],
      },
    };
    (galicia as { entradas: readonly EntradaLexico[] }).entradas = galicia.entradas.map((e) =>
      e.id === 'galicia.comision_de_extraccion' ? acortada : e,
    );

    const infracciones = verificarPropiedades(lexicos, CATALOGO_CANONICO, ESTADO_DE_LOS_TIPOS);
    const propiedades = new Set<NombrePropiedad>(infracciones.map((i) => i.propiedad));
    expect(propiedades.has('PROP-6'), JSON.stringify(infracciones, null, 2)).toBe(true);
  });
});
