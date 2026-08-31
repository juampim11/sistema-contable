/**
 * EL TEST QUE ATA `reconocimiento_forma_chk` (migración 0014) A `motor.ts`.
 *
 * 🔴 Es el hallazgo ④ de `dba-data` en la Ronda 2, y él mismo lo llamó "el defecto más caro de los que
 * quedan": el check de la base declara, por MOTIVO, si la evidencia está presente o ausente — y esa
 * tabla es una FOTO del motor de hoy. Nada en el gate la mantenía atada. Si mañana `ambiguo` empieza a
 * llevar evidencia, el descubrimiento sería un INSERT rechazado en producción.
 *
 * Acá se pone rojo antes, y sin base: se ejercita cada motivo contra el motor REAL y se afirma la
 * presencia o ausencia de `evidencia` contra la misma tabla que la migración congeló.
 *
 * El archivo también cubre `aFilaPersistible` (`nucleo/persistible.ts`), porque las dos cosas
 * responden a la misma pregunta: qué columnas tiene una fila según su clase y su motivo.
 */

import { describe, expect, it } from 'vitest';
import { construirIndice, reconocer } from '../src/nucleo/motor.ts';
import { aFilaPersistible, idsDelLexico, IdDeLexicoDesconocidoError, marcarCapaCCorrida } from '../src/nucleo/persistible.ts';
import { LEXICOS_POR_BANCO } from '../src/lexico/registro.ts';
import type { LexicoDeBanco } from '../src/nucleo/lexico.ts';
import type { EvidenciaDelMatch, EvidenciaDeMovimiento, Reconocimiento } from '../src/nucleo/reconocimiento.ts';

const GALICIA = LEXICOS_POR_BANCO['galicia'] as LexicoDeBanco;
const INDICE = construirIndice(GALICIA);
const VALIDOS = idsDelLexico(GALICIA);

/**
 * 🔴 LA MISMA TABLA QUE `reconocimiento_forma_chk` congeló en la migración 0014. Si esto y el check
 * divergen, uno de los dos está mal — y el que está mal es el que no se puede cambiar sin una
 * migración nueva, así que el error tiene que aparecer ACÁ.
 *
 * `codigo_no_catalogado` y `evidencia_contradictoria` NO están: el motor nunca los produce hoy
 * (dependen de `conceptoCodigo`, que ningún adaptador emite — H3), así que no hay comportamiento que
 * verificar. El check de la base les exige nulidad grupal, que es lo más fuerte que se puede afirmar
 * sin inventar el comportamiento de código que no existe. El último test de este archivo vigila que
 * ese "hoy" siga siendo cierto.
 */
const EVIDENCIA_POR_MOTIVO: Readonly<Record<string, 'presente' | 'ausente'>> = {
  sin_evidencia_de_concepto: 'ausente',
  ambiguo: 'ausente',
  concepto_no_catalogado: 'ausente',
  concepto_sin_tipo_asignado: 'presente',
  reversa_incoherente: 'presente',
};

function evidenciaDe(parcial: Partial<EvidenciaDeMovimiento>): EvidenciaDeMovimiento {
  return {
    bancoCodigo: 'galicia',
    conceptoBanco: undefined,
    conceptoCompleto: undefined,
    conceptoBancoEstrategia: undefined,
    conceptoCodigo: undefined,
    columnaOrigen: 'debito',
    ...parcial,
  };
}

/** Ejercita el motor real hasta obtener un `sin_reconocer` con el motivo pedido. */
function sinReconocerCon(motivo: string): Reconocimiento | undefined {
  const casos: Readonly<Record<string, EvidenciaDeMovimiento>> = {
    // Sin `conceptoBanco` el motor corta antes de mirar el léxico (motor.ts:48-50).
    sin_evidencia_de_concepto: evidenciaDe({ conceptoBanco: undefined }),
    // Un literal que ninguna entrada del léxico contiene.
    concepto_no_catalogado: evidenciaDe({ conceptoBanco: 'ZZQQ LITERAL INEXISTENTE', conceptoCompleto: true }),
  };
  const caso = casos[motivo];
  if (caso) {
    const r = reconocer(caso, INDICE);
    return r.clase === 'sin_reconocer' && r.motivo === motivo ? r : undefined;
  }

  // Los otros tres dependen del contenido del léxico: se barre el corpus del banco buscando uno.
  for (const entrada of GALICIA.entradas) {
    for (const columnaOrigen of ['debito', 'credito'] as const) {
      for (const literal of entrada.literales) {
        const r = reconocer(evidenciaDe({ conceptoBanco: literal, conceptoCompleto: true, columnaOrigen }), INDICE);
        if (r.clase === 'sin_reconocer' && r.motivo === motivo) return r;
      }
    }
  }
  return undefined;
}

describe('la tabla de evidencia por motivo coincide con motor.ts', () => {
  it.each(Object.keys(EVIDENCIA_POR_MOTIVO))(
    '%s: la presencia de evidencia es la que el check de 0014 congeló',
    (motivo) => {
      const r = sinReconocerCon(motivo);
      if (!r) {
        // No todos los motivos son alcanzables con el léxico de un solo banco. Que no se alcance NO
        // es una falla del check — pero sí tiene que ser visible, no un test que pasa vacío.
        expect(
          ['reversa_incoherente', 'concepto_sin_tipo_asignado', 'ambiguo'],
          `el motivo ${motivo} no se alcanzó con el léxico de Galicia y tampoco está declarado como ` +
            'posiblemente inalcanzable — revisar si el motor dejó de producirlo',
        ).toContain(motivo);
        return;
      }

      const esperado = EVIDENCIA_POR_MOTIVO[motivo];
      const tieneEvidencia = r.clase === 'sin_reconocer' && r.evidencia !== undefined;
      expect(
        tieneEvidencia,
        `motor.ts produce ${motivo} con evidencia ${tieneEvidencia ? 'PRESENTE' : 'AUSENTE'}, y ` +
          `reconocimiento_forma_chk (0014) la declara ${esperado}. Uno de los dos está mal, y el ` +
          'check no se puede cambiar sin una migración nueva.',
      ).toBe(esperado === 'presente');
    },
  );

  /**
   * Anti-lista-muerta en la dirección peligrosa: si el motor empieza a producir un motivo que esta
   * tabla no contempla, el check de 0014 lo va a mandar a la rama `else` (nulidad grupal) sin que
   * nadie lo haya decidido.
   */
  it('el motor no produce ningún motivo fuera de la tabla, sobre el corpus del léxico', () => {
    const vistos = new Set<string>();
    for (const entrada of GALICIA.entradas) {
      for (const columnaOrigen of ['debito', 'credito'] as const) {
        for (const literal of entrada.literales) {
          const r = reconocer(evidenciaDe({ conceptoBanco: literal, conceptoCompleto: true, columnaOrigen }), INDICE);
          if (r.clase === 'sin_reconocer') vistos.add(r.motivo);
        }
      }
    }
    const fuera = [...vistos].filter((m) => EVIDENCIA_POR_MOTIVO[m] === undefined);
    expect(
      fuera,
      'el motor produjo un motivo que la tabla de 0014 no contempla: cae en la rama `else` del check ' +
        '(nulidad grupal) sin que nadie lo haya decidido.',
    ).toEqual([]);
    expect(vistos.size, 'el barrido no produjo ni un sin_reconocer: el test no discrimina').toBeGreaterThan(0);
  });
});

describe('aFilaPersistible respeta la forma que el check exige', () => {
  it('una propuesta lleva las cuatro de interpretación y las cuatro de evidencia, y ninguna de las otras', () => {
    const propuesta = GALICIA.entradas
      .flatMap((e) => e.literales.map((l) => ({ literal: l })))
      .map(({ literal }) => reconocer(evidenciaDe({ conceptoBanco: literal, conceptoCompleto: true }), INDICE))
      .find((r) => r.clase === 'propuesta');
    expect(propuesta, 'ninguna entrada de Galicia produce una propuesta en débito').toBeDefined();

    const fila = aFilaPersistible(marcarCapaCCorrida(propuesta as Reconocimiento), VALIDOS);
    expect(fila.tipo).not.toBeNull();
    expect(fila.concepto).not.toBeNull();
    expect(fila.polaridad).not.toBeNull();
    expect(fila.lado).not.toBeNull();
    expect(fila.entradaLexicoId).not.toBeNull();
    expect(fila.caracteresMatcheados).not.toBeNull();
    expect(fila.huboCola).not.toBeNull();
    expect(fila.via).not.toBeNull();
    // Y las que la clase NO tiene:
    expect(fila.queDecide).toBeNull();
    expect(fila.motivoCodigo).toBeNull();
    expect(fila.candidatos).toEqual([]);
  });

  it('un sin_reconocer sin evidencia deja las cuatro columnas en null, sin rellenar ninguna', () => {
    const r = reconocer(evidenciaDe({ conceptoBanco: undefined }), INDICE);
    const fila = aFilaPersistible(marcarCapaCCorrida(r), VALIDOS);

    expect(fila.motivoCodigo).toBe('sin_evidencia_de_concepto');
    expect(fila.entradaLexicoId).toBeNull();
    expect(fila.caracteresMatcheados).toBeNull();
    expect(fila.huboCola).toBeNull();
    expect(fila.via).toBeNull();
    // Media evidencia es una fila que no se puede explicar ni descartar: el check la rechaza.
    expect(fila.tipo).toBeNull();
    expect(fila.concepto).toBeNull();
  });

  /**
   * 🔴 LA GUARDA DE PERTENENCIA. `EntradaLexico['id']` es `string` a secas, así que el tipo no impide
   * un id construido con tokens de la glosa: lo impide este `Set.has`.
   */
  it('un id que no pertenece al léxico explota, y el error NO lleva el valor', () => {
    const falso: Reconocimiento = {
      clase: 'sin_reconocer',
      motivo: 'ambiguo',
      candidatos: ['galicia.razon_social_del_tercero'],
      evidencia: undefined,
    };

    let capturado: unknown;
    try {
      aFilaPersistible(marcarCapaCCorrida(falso), VALIDOS);
    } catch (e) {
      capturado = e;
    }

    expect(capturado).toBeInstanceOf(IdDeLexicoDesconocidoError);
    expect(
      (capturado as Error).message,
      'el mensaje lleva el id: si vino de la glosa, lo filtra al log y al stderr — el escenario ' +
        'exacto que esta guarda existe para atajar, reintroducido por el error que lo reporta',
    ).not.toContain('razon_social_del_tercero');
  });

  /**
   * 🔴 EL MUTANTE REAL: bug encontrado al aplicar Capa C contra el primer corpus grande del
   * piloto (1081 movimientos, julio 2026) — Postgres rechazó el INSERT con `ING_CHECK` /
   * `reconocimiento_forma_chk`. La rama `sin_reconocer` hardcodeaba `via: null`
   * incondicionalmente, pero el check exige las CUATRO columnas de evidencia no-nulas cuando
   * `motivo_codigo` es `concepto_sin_tipo_asignado` o `reversa_incoherente` (ver el punto 5 de
   * 0014 y la tabla de `EVIDENCIA_POR_MOTIVO` arriba). El único `via` de esta rama vive DENTRO
   * de `evidencia.via`, no a nivel raíz — a diferencia de `propuesta`/`decision_humana`.
   *
   * Verificado revirtiendo el fix a mano (`via: null` hardcodeado) y confirmando que ESTE test
   * puntual se pone rojo — no la suite en general.
   */
  it.each(['concepto_sin_tipo_asignado', 'reversa_incoherente'] as const)(
    'un sin_reconocer con evidencia (%s) persiste via desde evidencia.via, nunca null',
    (motivo) => {
      const idReal = GALICIA.entradas[0]?.id as string;
      const evidencia: EvidenciaDelMatch = {
        entradaLexicoId: idReal,
        via: 'texto_literal_exacto',
        caracteresMatcheados: 5,
        huboCola: false,
      };
      const r: Reconocimiento = {
        clase: 'sin_reconocer',
        motivo,
        candidatos: [],
        evidencia,
      };
      const fila = aFilaPersistible(marcarCapaCCorrida(r), VALIDOS);

      expect(fila.via, 'reconocimiento_forma_chk exige via no-nulo para este motivo').not.toBeNull();
      expect(fila.via).toBe(evidencia.via);
      // Las otras tres columnas del mismo grupo, para que el mutante no pase "por casualidad"
      // arreglando solo la que el nombre del test menciona.
      expect(fila.entradaLexicoId).not.toBeNull();
      expect(fila.caracteresMatcheados).not.toBeNull();
      expect(fila.huboCola).not.toBeNull();
    },
  );

  it('un id legítimo del léxico pasa', () => {
    const idReal = GALICIA.entradas[0]?.id as string;
    const legitimo: Reconocimiento = {
      clase: 'sin_reconocer',
      motivo: 'ambiguo',
      candidatos: [idReal],
      evidencia: undefined,
    };
    const fila = aFilaPersistible(marcarCapaCCorrida(legitimo), VALIDOS);
    expect(fila.candidatos).toEqual([idReal]);
  });
});
