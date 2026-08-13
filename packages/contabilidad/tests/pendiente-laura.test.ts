/**
 * La garantía de que `pendienteDeLaura` NUNCA produce `clase: 'propuesta'` — verificada por
 * enumeración exhaustiva sobre el corpus real de los TRES bancos (no una muestra, y no solo Galicia:
 * hallazgo de `tester` en la convocatoria de cierre — la primera versión de este archivo solo
 * enumeraba `LEXICO_GALICIA`, dejando sin cobertura cartesiana los conceptos marcados de Santander y
 * Macro).
 *
 * Dos redes más la sostienen, verificadas en otro lado:
 * - El tipo: `pendienteDeLaura?: never` en la rama `resuelve:'propone'` de `ResolucionDelConcepto`
 *   (con `exactOptionalPropertyTypes`), así que una fila con hipótesis y `resuelve:'propone'` al mismo
 *   tiempo NO COMPILA — ya lo verificó `pnpm typecheck` al escribir `catalogo.ts`.
 * - El choke point R-F (`packages/data/tests/reglas-de-codigo.test.ts`): `clase: 'propuesta'` solo
 *   puede construirse en `nucleo/motor.ts`.
 */

import { describe, expect, it } from 'vitest';
import { construirIndice } from '../src/nucleo/indice.ts';
import { reconocer } from '../src/nucleo/motor.ts';
import { LEXICO_GALICIA } from '../src/lexico/galicia.ts';
import { LEXICO_SANTANDER } from '../src/lexico/santander.ts';
import { LEXICO_MACRO } from '../src/lexico/macro.ts';
import { CATALOGO_CANONICO } from '../src/nucleo/catalogo.ts';
import type { EntradaLexico, LexicoDeBanco } from '../src/nucleo/lexico.ts';
import type { FilaDelCatalogo } from '../src/nucleo/catalogo.ts';

const LEXICOS_REALES: readonly LexicoDeBanco[] = [LEXICO_GALICIA, LEXICO_SANTANDER, LEXICO_MACRO];
const INDICES = new Map(LEXICOS_REALES.map((l) => [l.banco, construirIndice(l)] as const));

/**
 * `pendienteDeLaura` puede venir del LÉXICO (incertidumbre sobre a qué concepto apunta un literal) o
 * del CATÁLOGO (incertidumbre sobre el tipo/lado de un concepto ya identificado — `LadoDelConcepto`
 * 'indistinto', o `ResolucionDelConcepto.decide_una_persona` opcional). Las dos rutas degradan igual —
 * ver `pendienteDe()` en `nucleo/motor.ts` — así que esta lista tiene que mirar las dos.
 */
function entradasMarcadas(lexico: LexicoDeBanco): readonly EntradaLexico[] {
  return lexico.entradas.filter((e) => {
    if (e.pendienteDeLaura !== undefined) return true;
    const fila: FilaDelCatalogo = CATALOGO_CANONICO[e.concepto];
    if (fila.ladoEsperado === 'indistinto') return true;
    if (fila.resuelve === 'decide_una_persona' && fila.pendienteDeLaura !== undefined) return true;
    return false;
  });
}

describe('pendienteDeLaura nunca produce clase:"propuesta" — los tres bancos', () => {
  it('anti-falso-verde: hay al menos una entrada marcada en CADA banco', () => {
    // Si algún banco diera 0, el resto de los tests de ese banco pasarían sin verificar nada.
    for (const lexico of LEXICOS_REALES) {
      expect(entradasMarcadas(lexico).length, `${lexico.banco}: cero entradas marcadas`).toBeGreaterThan(0);
    }
  });

  it.each(LEXICOS_REALES.map((l) => l.banco))(
    '%s: ninguna entrada marcada produce jamás una propuesta (producto cartesiano completo)',
    (banco) => {
      const lexico = LEXICOS_REALES.find((l) => l.banco === banco);
      const indice = INDICES.get(banco);
      if (!lexico || !indice) throw new Error(`banco desconocido: ${banco}`);
      const marcadas = entradasMarcadas(lexico);
      const propuestas: string[] = [];

      for (const entrada of marcadas) {
        for (const literal of entrada.literales) {
          for (const columnaOrigen of ['credito', 'debito'] as const) {
            for (const conceptoCompleto of [true, false]) {
              const r = reconocer(
                {
                  bancoCodigo: lexico.banco,
                  conceptoBanco: literal,
                  conceptoCompleto,
                  conceptoBancoEstrategia: lexico.estrategiaDelAdaptador,
                  conceptoCodigo: undefined,
                  columnaOrigen,
                },
                indice,
              );
              if (r.clase === 'propuesta') {
                propuestas.push(`${entrada.id} / "${literal}" / ${columnaOrigen} / completo=${conceptoCompleto}`);
              }
            }
          }
        }
      }

      expect(
        propuestas,
        'una entrada con hipótesis abierta produjo una propuesta — el motor firmó por la contadora una ' +
          'decisión que ella no tomó. Revisá la degradación en nucleo/motor.ts (función pendienteDe): ' +
          'tiene que ganarle a resuelve:"propone", no al revés.',
      ).toEqual([]);
    },
  );

  it.each(LEXICOS_REALES.map((l) => l.banco))(
    '%s: la degradación conserva el concepto: no lo reemplaza por sin_reconocer',
    (banco) => {
      const lexico = LEXICOS_REALES.find((l) => l.banco === banco);
      const indice = INDICES.get(banco);
      if (!lexico || !indice) throw new Error(`banco desconocido: ${banco}`);
      // decision_humana es "el motor YA SABE qué es, la persona elige la cuenta" (05 §5). Confundirlo
      // con sin_reconocer mezclaría los dos trabajos y haría la cola inutilizable.
      for (const entrada of entradasMarcadas(lexico)) {
        const [primerLiteral] = entrada.literales;
        const r = reconocer(
          {
            bancoCodigo: lexico.banco,
            conceptoBanco: primerLiteral,
            conceptoCompleto: true,
            conceptoBancoEstrategia: lexico.estrategiaDelAdaptador,
            conceptoCodigo: undefined,
            columnaOrigen: 'debito',
          },
          indice,
        );
        // No afirmamos la clase exacta acá (INV-M2-1 puede rechazar el lado 'debito' específico para
        // algunos conceptos) — solo que si el motor SÍ reconoció el literal, nunca lo mandó a
        // sin_reconocer por el solo hecho de tener pendienteDeLaura.
        if (r.clase === 'sin_reconocer') {
          expect(
            r.motivo,
            `${entrada.id}: sin_reconocer inesperado con motivo distinto de reversa_incoherente`,
          ).toBe('reversa_incoherente');
        }
      }
    },
  );
});

describe('pendienteDeLaura a nivel de LÉXICO (EntradaLexico.pendienteDeLaura)', () => {
  /**
   * Hallazgo de `tester` (convocatoria de cierre): ningún literal real de los tres bancos usa el canal
   * de `EntradaLexico.pendienteDeLaura` (todas las hipótesis abiertas del corpus real llegan por el
   * catálogo — `ladoEsperado:'indistinto'` o `decide_una_persona.pendienteDeLaura`). El código que
   * atiende ese canal (`motor.ts`, `pendienteDe()`, primera rama: `if (entradaPendiente) return
   * entradaPendiente;`) es correcto por inspección, pero sin este test es una rama sin ningún caso que
   * la ejercite — si alguien la rompe, nada lo nota.
   */
  it('una entrada de léxico con pendienteDeLaura propio degrada aunque su concepto resuelva "propone" sin marca', () => {
    const base = LEXICO_GALICIA.entradas.find((e) => e.id === 'galicia.extraccion_efectivo_autoservicio');
    if (!base) throw new Error('fixture inválido: falta galicia.extraccion_efectivo_autoservicio');
    const filaBase = CATALOGO_CANONICO[base.concepto];
    // Confirma la premisa del caso: el CATÁLOGO no marca este concepto — la única hipótesis abierta acá
    // la pone el LÉXICO, para aislar el canal que el resto de la suite nunca ejercita.
    expect(filaBase.resuelve).toBe('propone');
    expect('pendienteDeLaura' in filaBase).toBe(false);

    const entradaSintetica: EntradaLexico = {
      ...base,
      id: 'galicia.__sintetico_pendiente_de_lexico__',
      pendienteDeLaura: {
        pregunta: '¿Este literal sintético es genuinamente extraccion_efectivo_autoservicio?',
        hipotesis: 'Fixture de test — ejercita el canal EntradaLexico.pendienteDeLaura, que ningún ' +
          'literal real de los tres bancos usa hoy.',
        referencia: 'packages/contabilidad/tests/pendiente-laura.test.ts',
        desde: '2026-08-13',
      },
    };
    const indiceSintetico = construirIndice({
      ...LEXICO_GALICIA,
      entradas: [...LEXICO_GALICIA.entradas.filter((e) => e.id !== base.id), entradaSintetica],
    });

    const r = reconocer(
      {
        bancoCodigo: 'galicia',
        conceptoBanco: base.literales[0],
        conceptoCompleto: true,
        conceptoBancoEstrategia: LEXICO_GALICIA.estrategiaDelAdaptador,
        conceptoCodigo: undefined,
        columnaOrigen: 'debito',
      },
      indiceSintetico,
    );

    expect(r.clase, JSON.stringify(r)).toBe('decision_humana');
    if (r.clase === 'decision_humana') {
      expect(r.queDecide).toBe('confirmar_hipotesis_del_lexico');
      expect(r.pendienteDeLaura?.referencia).toBe('packages/contabilidad/tests/pendiente-laura.test.ts');
    }
  });
});
