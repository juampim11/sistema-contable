/**
 * MUTACIÓN DEL LÉXICO — `05-motor-de-reconocimiento.md` §8.3: cada mutación tiene que poner rojo una
 * propiedad NOMBRADA. Si alguna no la ataja nadie, es un agujero declarado, no un silencio.
 *
 * Los seis objetivos se eligieron para ser genuinamente ÚNICOS (sin redundancia cross-banco) — con
 * tres léxicos ya escritos, varios conceptos/tipos se alcanzan por más de un banco, y una mutación sobre
 * una entrada redundante no rompe nada (otro banco sigue cubriendo el mismo concepto/tipo). Elegir un
 * objetivo redundante habría sido el "agujero declarado" que este archivo existe para evitar.
 *
 * Los objetivos 5 y 6 (PROP-3, PROP-2) se agregaron al promover `texto_prefijo_con_cola` a vía
 * calificada de D-31 (HANDOFF correspondiente) — condición del dictamen combinado
 * `motor-conciliacion-contable` + `contador-dominio`: la garantía de "0 ambigüedad" tiene que estar
 * en CI, no solo medida una vez sobre el corpus de ROKA. Usan vocabulario REAL de `macro.ts` (no
 * sintético genérico) para que la mutación sea creíble como error real de un futuro alta de literal.
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

function reemplazarEntradaDeBanco(lexicos: LexicoDeBanco[], banco: string, id: string, entrada: EntradaLexico | null): void {
  const lex = lexicos.find((l) => l.banco === banco);
  if (!lex) throw new Error(`${banco} no está en el clon`);
  const entradas = entrada
    ? lex.entradas.map((e) => (e.id === id ? entrada : e))
    : lex.entradas.filter((e) => e.id !== id);
  (lex as { entradas: readonly EntradaLexico[] }).entradas = entradas;
}

function agregarEntradaDeBanco(lexicos: LexicoDeBanco[], banco: string, entrada: EntradaLexico): void {
  const lex = lexicos.find((l) => l.banco === banco);
  if (!lex) throw new Error(`${banco} no está en el clon`);
  (lex as { entradas: readonly EntradaLexico[] }).entradas = [...lex.entradas, entrada];
}

describe('mutación del léxico — cada una pone rojo una propiedad NOMBRADA', () => {
  it('el verificador da VERDE sobre el léxico real (anti-falso-verde: sin esto, las 4 pasarían sin verificar nada)', () => {
    expect(verificarPropiedades(LEXICOS_REALES, CATALOGO_CANONICO, ESTADO_DE_LOS_TIPOS)).toEqual([]);
  });

  it('1. borrar una entrada (galicia.anulacion_acreditamiento_firstdata, único en todo el corpus, ' +
    'sin reuso cross-banco) → PROP-5 (concepto sin ninguna entrada que lo alcance)', () => {
    const lexicos = clonarLexicos();
    reemplazarEntradaDeBanco(lexicos, 'galicia', 'galicia.anulacion_acreditamiento_firstdata', null);
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

  it('5. agregar una entrada de Macro cuyo ancla colisiona como PREFIJO real del ancla de ' +
    '`macro.transferencia_recibida_de_terceros` (literal "TRANSF", 409 mov.) → PROP-3. Prueba que la ' +
    'protección de anclaje no depende de que hoy no exista un literal así en el vocabulario — un alta ' +
    'futura de un literal "TRANSF ..." tiene que romper la propiedad, no colar silenciosamente', () => {
    const lexicos = clonarLexicos();
    const mutante: EntradaLexico = {
      id: 'macro.mutante_prop3_prefijo_transf',
      concepto: 'transferencia_recibida_de_terceros',
      literales: ['TRANSF A CCDO'],
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: {
        fuente: 'inferido_del_vocabulario',
        porQue: 'Entrada sintética de mutación (Objetivo 5) — nunca existió en el corpus real, se ' +
          'agrega solo para probar que PROP-3 detecta la colisión de ancla contra "TRANSF".',
      },
    };
    agregarEntradaDeBanco(lexicos, 'macro', mutante);

    const infracciones = verificarPropiedades(lexicos, CATALOGO_CANONICO, ESTADO_DE_LOS_TIPOS);
    const propiedades = new Set<NombrePropiedad>(infracciones.map((i) => i.propiedad));
    expect(propiedades.has('PROP-3'), JSON.stringify(infracciones, null, 2)).toBe(true);
    // Control: NINGUNA otra propiedad se dispara por este mutante puntual (fuente no-corpus_medido
    // esquiva PROP-6/PROP-12 a propósito, para que la predicción sea "solo PROP-3").
    expect([...propiedades], JSON.stringify(infracciones, null, 2)).toEqual(['PROP-3']);
  });

  it('6. agregar una entrada de Macro cuyo literal duplica EXACTO "TRANSF:" (el literal real de ' +
    '`macro.transferencia_con_token`, 78 mov.) bajo otro concepto → PROP-2 (colisión literal exacta ' +
    'entre dos entradas del mismo banco)', () => {
    const lexicos = clonarLexicos();
    const mutante: EntradaLexico = {
      id: 'macro.mutante_prop2_duplica_transf_dos_puntos',
      concepto: 'transferencia_recibida_de_terceros',
      literales: ['TRANSF:'],
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: {
        fuente: 'inferido_del_vocabulario',
        porQue: 'Entrada sintética de mutación (Objetivo 6) — duplica a propósito el literal real de ' +
          'macro.transferencia_con_token para probar que PROP-2 detecta la colisión exacta.',
      },
    };
    agregarEntradaDeBanco(lexicos, 'macro', mutante);

    const infracciones = verificarPropiedades(lexicos, CATALOGO_CANONICO, ESTADO_DE_LOS_TIPOS);
    const propiedades = new Set<NombrePropiedad>(infracciones.map((i) => i.propiedad));
    expect(propiedades.has('PROP-2'), JSON.stringify(infracciones, null, 2)).toBe(true);
    expect([...propiedades], JSON.stringify(infracciones, null, 2)).toEqual(['PROP-2']);
  });
});
