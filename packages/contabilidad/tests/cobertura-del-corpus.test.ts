/**
 * La matriz de cobertura final — banco × clase, sobre los 104 literales / ~1830 movimientos de los tres
 * bancos del piloto, contra la predicción falsable del plan §7 (`adaptive-herding-pillow.md`).
 *
 * Se deriva DIRECTAMENTE de `procedencia.porLiteral` de cada léxico — no retipea las tablas de
 * `corpus-{galicia,santander,macro}.test.ts` (esas verifican literal-por-literal; esta agrega).
 */

import { describe, expect, it } from 'vitest';
import { LEXICO_GALICIA } from '../src/lexico/galicia.ts';
import { LEXICO_SANTANDER } from '../src/lexico/santander.ts';
import { LEXICO_MACRO } from '../src/lexico/macro.ts';
import { construirIndice } from '../src/nucleo/indice.ts';
import { reconocer } from '../src/nucleo/motor.ts';
import type { Lado } from '../src/nucleo/tipos.ts';
import type { LexicoDeBanco } from '../src/nucleo/lexico.ts';

type Clase = 'propuesta' | 'decision_humana' | 'sin_reconocer';
type Fila = Record<Clase, number>;

function filaVacia(): Fila {
  return { propuesta: 0, decision_humana: 0, sin_reconocer: 0 };
}

function columnaDe(lado: Lado | 'ambos' | 'no_medido'): 'credito' | 'debito' {
  // 'ambos'/'no_medido' → el concepto es indistinto o pendienteDeLaura sin lado: cualquier columna
  // produce la misma clase, se usa 'debito' como valor arbitrario determinístico.
  if (lado === 'haber') return 'credito';
  return 'debito';
}

function distribucionDe(lexico: LexicoDeBanco): Fila {
  const indice = construirIndice(lexico);
  const fila = filaVacia();
  for (const entrada of lexico.entradas) {
    if (entrada.procedencia.fuente !== 'corpus_medido') continue;
    // 🔴 Bug encontrado por el usuario al pedir la reconciliación de §7: `procedencia.porLiteral[].literal`
    // es el texto de CITA (lo que aparece entre backticks en el documento — PROP-6 lo exige exacto, y
    // para los 5 prefijos con contraparte de Macro eso incluye el placeholder del banco, ej.
    // 'TRANSF:<token>-<n>'). El motor NUNCA ve ese texto — ve `entrada.literales` (el ancla real,
    // 'TRANSF:'). Alimentar el motor con el texto de cita en vez del ancla real hacía que esos 5
    // conceptos (102 movimientos: TRF MO CCDO 9, TRANSF: 78, CREDIN: 6, CCERR 5, TEF DATANET PR 4)
    // salieran `concepto_no_catalogado` en vez de `decision_humana` — silencioso, porque los asserts de
    // este archivo comparan sumas y umbrales, no la cifra exacta por clase.
    if (entrada.literales.length !== entrada.procedencia.porLiteral.length) {
      throw new Error(
        `${entrada.id}: literales (${entrada.literales.length}) y procedencia.porLiteral ` +
          `(${entrada.procedencia.porLiteral.length}) no corresponden 1:1 — no se puede parear ancla ↔ movimientos`,
      );
    }
    entrada.procedencia.porLiteral.forEach(({ movimientos, lado }, i) => {
      if (movimientos === 0) return;
      const ancla = entrada.literales[i]; // el texto que el motor REALMENTE ve, no el de la cita
      const r = reconocer(
        {
          bancoCodigo: lexico.banco,
          conceptoBanco: ancla,
          conceptoCompleto: true,
          conceptoBancoEstrategia: lexico.estrategiaDelAdaptador,
          conceptoCodigo: undefined,
          columnaOrigen: columnaDe(lado),
        },
        indice,
      );
      fila[r.clase] += movimientos;
    });
  }
  return fila;
}

const GALICIA = distribucionDe(LEXICO_GALICIA);
const SANTANDER = distribucionDe(LEXICO_SANTANDER);
const MACRO_SIN_HUECO = distribucionDe(LEXICO_MACRO);
/** El hueco declarado (07-formato-macro.md §12.2): 76 movimientos sin `conceptoBanco`, siempre
 * sin_evidencia_de_concepto — no está representado en ningún léxico porque no hay literal que capturar. */
const MACRO: Fila = { ...MACRO_SIN_HUECO, sin_reconocer: MACRO_SIN_HUECO.sin_reconocer + 76 };

function suma(...filas: Fila[]): Fila {
  return filas.reduce(
    (acc, f) => ({
      propuesta: acc.propuesta + f.propuesta,
      decision_humana: acc.decision_humana + f.decision_humana,
      sin_reconocer: acc.sin_reconocer + f.sin_reconocer,
    }),
    filaVacia(),
  );
}

const TOTAL = suma(GALICIA, SANTANDER, MACRO);

describe('matriz de cobertura del corpus — banco × clase', () => {
  it('Galicia: 326 movimientos, ninguno se pierde', () => {
    expect(GALICIA.propuesta + GALICIA.decision_humana + GALICIA.sin_reconocer).toBe(326);
  });

  it('Santander: 158 movimientos, ninguno se pierde', () => {
    expect(SANTANDER.propuesta + SANTANDER.decision_humana + SANTANDER.sin_reconocer).toBe(158);
  });

  it('Macro: 1347 movimientos (incluido el hueco de 76), ninguno se pierde', () => {
    expect(MACRO.propuesta + MACRO.decision_humana + MACRO.sin_reconocer).toBe(1347);
  });

  it('el total combinado no pierde movimientos: 326 + 158 + 1347 = 1831', () => {
    // El plan §7 predijo sobre 1830 (326+158+1346) — la discrepancia de +1 es la misma ±1 de
    // documentación de Macro ya señalada en corpus-macro.test.ts, no un movimiento perdido por el motor.
    expect(TOTAL.propuesta + TOTAL.decision_humana + TOTAL.sin_reconocer).toBe(1831);
  });

  it('reporta la matriz completa (informativo — no es un assert, es la evidencia para el HANDOFF)', () => {
    const matriz = { GALICIA, SANTANDER, MACRO, TOTAL };
    // eslint-disable-next-line no-console -- test informativo, no hay logger de aplicación acá
    expect(matriz, JSON.stringify(matriz, null, 2)).toBeDefined();
  });

  it('🔴 propuesta no se disparó muy por encima de lo predicho — el desvío peligroso es ' +
    'proponer donde debería preguntar (una propuesta de más CUADRA IGUAL)', () => {
    // 🔴 Corregido por code-reviewer (convocatoria de cierre): el assert anterior comparaba
    // TOTAL.propuesta contra sí mismo más el resto ("0 < decision_humana + sin_reconocer"), cierto casi
    // siempre por construcción — pasaba igual con 1500 propuestas de 1831. Exactamente el "anti-falso-
    // verde que nunca puede fallar" que este archivo existe para prevenir.
    //
    // Predicción del plan §7 sobre el corpus completo: ~221 propuestas (12,1%). Medido hoy: 209 (11,4%).
    // El techo (300) da ~40% de margen sobre lo medido — atrapa un desvío de orden de magnitud (el
    // motor proponiendo donde debería preguntar) sin ser tan ajustado que un ajuste legítimo de una
    // fila del catálogo lo rompa por casualidad. El techo real es una decisión de producto, no un
    // número mágico — este valor es el piso de seguridad hasta que se decida uno.
    expect(TOTAL.propuesta).toBeLessThan(300);
    expect(TOTAL.propuesta).toBeGreaterThan(0);
  });

  it('decision_humana sigue siendo la clase dominante — capa C (contrapartida), no el léxico, ' +
    'es lo que desbloquea el producto', () => {
    expect(TOTAL.decision_humana).toBeGreaterThan(TOTAL.propuesta);
    expect(TOTAL.decision_humana).toBeGreaterThan(TOTAL.sin_reconocer);
  });

  it('sin_reconocer en Macro incluye AL MENOS los 76 del hueco declarado (nunca menos)', () => {
    expect(MACRO.sin_reconocer).toBeGreaterThanOrEqual(76);
  });
});
