/**
 * PROP-1..13 sobre el léxico y catálogo REALES — verdes hoy con los datos de los tres bancos
 * (Galicia, Santander, Macro).
 */

import { describe, expect, it } from 'vitest';
import { CATALOGO_CANONICO, CONCEPTOS_CANONICOS, ESTADO_DE_LOS_TIPOS, type ConceptoCanonico, type FilaDelCatalogo } from '../src/nucleo/catalogo.ts';
import { LEXICO_GALICIA } from '../src/lexico/galicia.ts';
import { LEXICO_SANTANDER } from '../src/lexico/santander.ts';
import { LEXICO_MACRO } from '../src/lexico/macro.ts';
import { QUE_DECIDE } from '../src/nucleo/tipos.ts';
import { verificarPropiedades } from './propiedades.ts';

const LEXICOS_REALES = [LEXICO_GALICIA, LEXICO_SANTANDER, LEXICO_MACRO];

describe('PROP-1..13 sobre el léxico real', () => {
  it('verificarPropiedades da VERDE sobre Galicia', () => {
    const infracciones = verificarPropiedades(LEXICOS_REALES, CATALOGO_CANONICO, ESTADO_DE_LOS_TIPOS);
    expect(infracciones, JSON.stringify(infracciones, null, 2)).toEqual([]);
  });

  it('PROP-1 (anti-falso-verde): las claves de CATALOGO_CANONICO son exactamente CONCEPTOS_CANONICOS', () => {
    // 🔴 Corregido por code-reviewer (convocatoria de cierre): la versión anterior deduplicaba `claves`
    // contra sí misma (`Object.keys()` nunca trae duplicados) y nunca importaba `CONCEPTOS_CANONICOS`
    // — el assert no podía fallar pasara lo que pasara en el catálogo. Era el falso-verde que el propio
    // test decía prevenir.
    const claves = Object.keys(CATALOGO_CANONICO).sort();
    const declarados = [...CONCEPTOS_CANONICOS].sort();
    expect(claves.length).toBeGreaterThan(20);
    expect(claves).toEqual(declarados);
  });

  /**
   * PROP-9 en este paso del plan (Galicia + Santander): un valor de `QUE_DECIDE` todavía no es
   * producido, y la excepción está NOMINADA, no tolerada en silencio (mismo molde que la allowlist de
   * R32, `packages/data/tests/reglas-de-codigo.test.ts:343-403`).
   *
   * `elegir_jurisdiccion_de_la_retencion` se alcanzó en P7 con `retencion_sircreb` — sale de esta lista.
   */
  const SIN_USO_TODAVIA = [
    // NO se alcanza en esta etapa: tarjeta corporativa queda `sin_tipo_asignado` (implementación fuera
    // de alcance, ver pago_tarjeta_corporativa_visa en catalogo.ts). Se ratificó igual porque el valor
    // hace falta el día que la implementación exista — dejarlo fuera de QUE_DECIDE hoy obligaría a
    // agregarlo después, cuando ya hay código que depende de la unión cerrada.
    'completar_con_liquidacion_de_la_tarjeta',
  ] as const;

  it('PROP-9: todo valor de QUE_DECIDE es producido por una fila del catálogo, o está en la allowlist nominada', () => {
    const usados = new Set<string>();
    for (const fila of Object.values(CATALOGO_CANONICO) as FilaDelCatalogo[]) {
      if (fila.resuelve === 'decide_una_persona') usados.add(fila.queDecide);
    }
    const sinUso = QUE_DECIDE.filter((q) => !usados.has(q) && !(SIN_USO_TODAVIA as readonly string[]).includes(q));
    expect(
      sinUso,
      'un valor de QUE_DECIDE que ninguna fila produce y no está en SIN_USO_TODAVIA es una etiqueta ' +
        'que va a significar cualquier cosa el día que alguien la use — agregalo a una fila real, o a ' +
        'la allowlist con motivo, o sacalo de la unión.',
    ).toEqual([]);
  });

  it('la allowlist SIN_USO_TODAVIA no tiene entradas que ya se usan (evita que se vuelva permanente sin querer)', () => {
    const usados = new Set<string>();
    for (const fila of Object.values(CATALOGO_CANONICO) as FilaDelCatalogo[]) {
      if (fila.resuelve === 'decide_una_persona') usados.add(fila.queDecide);
    }
    const yaUsadas = SIN_USO_TODAVIA.filter((q) => usados.has(q));
    expect(yaUsadas, 'sacá de SIN_USO_TODAVIA los valores que ya se usan — la allowlist envejeció').toEqual([]);
  });

  it('todo concepto declarado en CONCEPTOS_CANONICOS es alcanzado por al menos una entrada de léxico', () => {
    const alcanzados = new Set(LEXICOS_REALES.flatMap((l) => l.entradas.map((e) => e.concepto)));
    const conceptos = Object.keys(CATALOGO_CANONICO) as ConceptoCanonico[];
    const sinAlcanzar = conceptos.filter((c) => !alcanzados.has(c));
    expect(sinAlcanzar, 'concepto declarado en el catálogo pero ningún léxico lo usa').toEqual([]);
  });

  /**
   * `categoriaDelHueco` (hallazgo de tech-lead, resuelto): anti-falso-verde de que las tres categorías
   * están realmente representadas — el compilador ya garantiza que TODA fila `sin_tipo_asignado` declare
   * una, esto verifica que no colapsaron todas a una sola por accidente.
   */
  it('las tres categoriaDelHueco están representadas por al menos una fila', () => {
    const categorias = new Set(
      (Object.values(CATALOGO_CANONICO) as FilaDelCatalogo[])
        .filter((f) => f.resuelve === 'sin_tipo_asignado')
        .map((f) => f.categoriaDelHueco),
    );
    expect([...categorias].sort()).toEqual(
      ['identidad_incierta', 'implementacion_diferida', 'sin_tipo_en_catalogo'].sort(),
    );
  });
});
