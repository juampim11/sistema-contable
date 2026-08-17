/**
 * LAS CINCO PREDICCIONES FALSABLES DE P0 (plan `replicated-zooming-pine`).
 *
 * Este archivo es la razón de ser de P0. La versión anterior del plan hacía que P0 fuera agregar
 * constantes que nadie leía — cero cambio observable JUSTAMENTE porque nadie las consumía, o sea
 * trivialmente revertible e INVERIFICABLE, difiriendo el 100% del riesgo al commit siguiente
 * (hallazgo de `arquitecto-software`, Ronda 1: "no es el paso revertible más chico, es un no-op con
 * forma de paso"). Un paso que no puede ponerse rojo no verifica nada.
 *
 * Cada `it` de acá es una de las cinco predicciones escritas ANTES de tocar código, con su
 * interpretación de falla adjunta — método de `docs/diseno/09-lecciones-aprendidas.md` §5.
 */

import { describe, expect, it } from 'vitest';
import { CATALOGO_CANONICO } from '../src/nucleo/catalogo.ts';
import { LEXICOS_POR_BANCO } from '../src/lexico/registro.ts';
import { digestDeBanco, proyeccionDeBanco, VERSION_DEL_MOTOR } from '../src/nucleo/version.ts';
import type { LexicoDeBanco } from '../src/nucleo/lexico.ts';

const GALICIA = LEXICOS_POR_BANCO['galicia'] as LexicoDeBanco;
const SANTANDER = LEXICOS_POR_BANCO['santander'] as LexicoDeBanco;

/** Copia profunda que no comparte ni una referencia con el original — para mutar sin ensuciar el
 *  léxico real que usan los otros tests (`fileParallelism: false`, comparten proceso). */
function clonar(lexico: LexicoDeBanco): LexicoDeBanco {
  return structuredClone(lexico) as LexicoDeBanco;
}

describe('P0 — el digest del motor: las cinco predicciones falsables', () => {
  // ---------------------------------------------------------------------------
  it('(1) el digest de un banco es ESTABLE entre corridas y entre procesos', () => {
    const primera = digestDeBanco(GALICIA);
    const segunda = digestDeBanco(GALICIA);
    // Clon estructural: mismo contenido, CERO referencias compartidas. Si el digest dependiera de la
    // identidad de los objetos o del orden de inserción de claves en memoria, acá divergiría.
    const sobreUnClon = digestDeBanco(clonar(GALICIA));

    expect(
      segunda,
      'si esto falla, el digest no es determinístico: hay estado compartido entre llamadas',
    ).toBe(primera);
    expect(
      sobreUnClon,
      'si esto falla, la serialización depende del orden de escritura del literal y no de un orden ' +
        'canónico — el digest cambiaría al mover una línea sin cambiar nada',
    ).toBe(primera);
    expect(primera).toHaveLength(16);
  });

  // ---------------------------------------------------------------------------
  it('(2) cambiar el `tipo` de un concepto MUEVE el digest de su banco', () => {
    // No se puede mutar CATALOGO_CANONICO (es `as const`), así que se ejerce el mismo camino desde el
    // otro extremo: se cambia el CONCEPTO al que apunta una entrada, lo que cambia la fila del
    // catálogo alcanzada y por lo tanto el `tipo` que `motor.ts:62` va a leer.
    const mutado = clonar(GALICIA);
    const otra = GALICIA.entradas.find((e) => e.concepto !== GALICIA.entradas[0]?.concepto);
    expect(otra, 'el léxico de Galicia tiene un solo concepto: el test no discrimina').toBeDefined();
    (mutado.entradas[0] as { concepto: string }).concepto = otra?.concepto as string;

    expect(
      digestDeBanco(mutado),
      'si esto NO se mueve, la proyección no cubre el campo del catálogo que motor.ts lee — y un PR ' +
        'que cambie un `tipo` dejaría los reconocimientos viejos congelados, protegidos por el no-op',
    ).not.toBe(digestDeBanco(GALICIA));
  });

  // ---------------------------------------------------------------------------
  it('(3) cambiar `procedencia.porLiteral[].movimientos` NO mueve ningún digest', () => {
    const mutado = clonar(GALICIA);
    let toque = 0;
    for (const entrada of mutado.entradas) {
      const p = entrada.procedencia as { fuente: string; porLiteral?: { movimientos: number }[] };
      if (p.fuente === 'corpus_medido' && p.porLiteral) {
        for (const ev of p.porLiteral) {
          ev.movimientos += 7;
          toque += 1;
        }
      }
    }
    expect(toque, 'no se mutó ninguna frecuencia: el test no está ejerciendo nada').toBeGreaterThan(0);

    expect(
      digestDeBanco(mutado),
      'si esto SE MUEVE, la denylist está mal: re-medir el corpus invalidaría el histórico de TODOS ' +
        'los clientes y entrenaría a la contadora a aceptar recálculos sin mirar — que es la forma ' +
        'más cara de romper el 🔴 de 05 §5.2',
    ).toBe(digestDeBanco(GALICIA));
  });

  // ---------------------------------------------------------------------------
  it('(4) la proyección de un banco EXCLUYE los conceptos que ese banco no puede alcanzar', () => {
    /**
     * 🔴 Este test se reescribió tras una prueba por mutación que lo dejó en evidencia. La versión
     * original ampliaba el léxico de Santander y verificaba que el digest de Galicia no se moviera —
     * y **pasaba en verde con `conceptosAlcanzados()` mutado a devolver TODO el catálogo**, o sea con
     * el digest global, que es exactamente el defecto que la predicción (4) existe para detectar.
     *
     * Por qué no discriminaba: agregar una entrada a Santander no agrega ninguna FILA AL CATÁLOGO, y
     * el digest de Galicia depende de sus propias entradas más las filas del catálogo. El escenario
     * real —un banco nuevo que suma conceptos NUEVOS a `CATALOGO_CANONICO`— no se puede simular,
     * porque el catálogo es `as const` y no admite una clave más.
     *
     * La propiedad SÍ verificable es la que sostiene el escenario: la proyección de un banco no puede
     * contener un concepto que ese banco no alcanza. Si eso vale, sumar conceptos para otro banco es
     * estructuralmente incapaz de mover este digest.
     */
    const alcanzablesPorGalicia = new Set(GALICIA.entradas.map((e) => e.concepto));
    const ajenos = Object.keys(CATALOGO_CANONICO).filter((c) => !alcanzablesPorGalicia.has(c as never));

    expect(
      ajenos.length,
      'todos los conceptos del catálogo son alcanzables desde Galicia: el test no discrimina nada',
    ).toBeGreaterThan(0);

    const proyeccion = proyeccionDeBanco(GALICIA);
    const filtrados = ajenos.filter((c) => proyeccion.indexOf(JSON.stringify(c)) !== -1);

    expect(
      filtrados,
      'la proyección de Galicia contiene conceptos que Galicia NO puede alcanzar: el digest es GLOBAL ' +
        'y no por banco. El día que entre un banco nuevo se invalidan todos los reconocimientos de ' +
        'todos los clientes de los bancos viejos, por un cambio incapaz de alterarlos',
    ).toEqual([]);

    // Y la contracara: ampliar OTRO léxico no mueve este digest.
    const antes = digestDeBanco(GALICIA);
    const santanderAmpliado = clonar(SANTANDER);
    const plantilla = structuredClone(SANTANDER.entradas[0]);
    (plantilla as { id: string }).id = 'santander.concepto_inventado_del_test';
    (santanderAmpliado as unknown as { entradas: unknown[] }).entradas = [
      ...santanderAmpliado.entradas,
      plantilla,
    ];

    expect(
      digestDeBanco(santanderAmpliado),
      'ampliar Santander tiene que mover el digest de Santander, o el test no discrimina',
    ).not.toBe(digestDeBanco(SANTANDER));
    expect(digestDeBanco(GALICIA)).toBe(antes);
  });

  // ---------------------------------------------------------------------------
  it('(5) el digest se calcula sobre la SEMÁNTICA, no sobre el archivo', () => {
    // La proyección es texto, y no contiene ni comentarios ni prosa: si alguien hasheara el archivo,
    // un typo en un comentario movería el digest. Se verifica por la vía estructural — la proyección
    // de un clon es idéntica — más la ausencia de los campos de evidencia.
    const proyeccion = proyeccionDeBanco(GALICIA);

    expect(proyeccionDeBanco(clonar(GALICIA))).toBe(proyeccion);
    for (const clave of ['procedencia', 'motivoDelHueco', 'referencia', 'categoriaDelHueco']) {
      expect(
        proyeccion.indexOf(clave),
        `la proyección contiene "${clave}", que es evidencia y no decisión: cambiarlo invalidaría ` +
          'reconocimientos sin motivo',
      ).toBe(-1);
    }
  });
});

describe('P0 — propiedades de la proyección que sostienen las cinco de arriba', () => {
  it('`pendienteDeLaura` entra por PRESENCIA, no por contenido', () => {
    const conPendiente = clonar(GALICIA);
    const entrada = conPendiente.entradas.find((e) => e.pendienteDeLaura !== undefined);

    if (!entrada) {
      // Ningún léxico del roster tiene una hipótesis abierta hoy (verificado en HANDOFF 51). Se planta
      // una para que el test discrimine igual, en vez de pasar vacío.
      (conPendiente.entradas[0] as { pendienteDeLaura: unknown }).pendienteDeLaura = {
        pregunta: 'x',
        hipotesis: 'y',
        referencia: 'z',
        desde: '2026-01-01',
      };
      expect(
        digestDeBanco(conPendiente),
        'agregar una hipótesis abierta TIENE que mover el digest: degrada la clase a decision_humana',
      ).not.toBe(digestDeBanco(GALICIA));
      return;
    }

    const soloTextoCambiado = clonar(conPendiente);
    const objetivo = soloTextoCambiado.entradas.find((e) => e.pendienteDeLaura !== undefined);
    (objetivo?.pendienteDeLaura as { pregunta: string }).pregunta = 'redacción completamente distinta';

    expect(
      digestDeBanco(soloTextoCambiado),
      'reformular la pregunta de una hipótesis no cambia lo que reconocer() devuelve — solo lo que se ' +
        'le muestra a la persona. Si mueve el digest, invalida reconocimientos por un cambio de prosa',
    ).toBe(digestDeBanco(conPendiente));
  });

  it('los tres bancos del roster tienen digests DISTINTOS entre sí', () => {
    const digests = Object.values(LEXICOS_POR_BANCO).map(digestDeBanco);
    expect(
      new Set(digests).size,
      'dos bancos con el mismo digest significa que la proyección no incluye la identidad del banco',
    ).toBe(digests.length);
  });

  it('`VERSION_DEL_MOTOR` participa del digest', () => {
    // No se puede reasignar la constante, así que se verifica que esté EN la proyección: es lo que
    // hace que un cambio en matcher/normalizacion/indice/motor pueda invalidar sin tocar datos.
    expect(
      proyeccionDeBanco(GALICIA).indexOf(`"versionDelMotor":${VERSION_DEL_MOTOR}`),
      'VERSION_DEL_MOTOR no está en la proyección: un cambio del CÓDIGO del motor no invalidaría nada',
    ).toBeGreaterThan(-1);
  });
});
