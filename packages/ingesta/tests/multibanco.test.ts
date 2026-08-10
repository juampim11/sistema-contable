/**
 * LAS PIEZAS QUE EL SEGUNDO Y EL TERCER BANCO OBLIGARON A ESCRIBIR (plan de construcción, E1).
 *
 * Cada bloque de este archivo corresponde a un modo de falla **medido** sobre un archivo real, y todos
 * comparten la misma forma: **producen un resultado plausible y equivocado**. Los números cuadran, la cadena
 * de saldos cierra, el lote dice `procesado` — y el dato está mal. Es el modo de falla que el Módulo 1 entero
 * existe para evitar, y por eso estas piezas van antes que los adaptadores que las van a usar.
 *
 * | Pieza | Sin ella | Fuente |
 * |---|---|---|
 * | `fragmentosEnBanda` | **1186 de 1346** descripciones truncadas | `07` §7 |
 * | `parDeColumnas` con el signo parametrizado | **0 movimientos** en dos bancos | `06` §0, `07` §4.1 |
 * | `regionesDeTabla` | 178 importes de anexo entran como saldos | `06` §11.3, `07` §9 |
 * | `periodoPorEtiquetas` | período `null` → sin control de fechas | `06` §11.10 |
 * | `seccionesPorClave` | 47 cuentas en vez de 3, o 1 en vez de 3 | `07` §14.2 |
 * | `hashesDeCuenta` | dos filas idénticas de cuentas distintas colapsan | `07` §10 |
 * | `U$S` en `importeACentavos` | los saldos en dólares son ilegibles | `06` §11.8 |
 *
 * ⚠️ **Ningún valor de este archivo sale de un extracto real.** Las coordenadas en puntos PDF sí son las
 * medidas —son geometría del formato que imprime el banco, no un dato de nadie— y están en los documentos
 * de especificación. Los importes, las glosas y los números de cuenta son inventados.
 */

import { describe, expect, it } from 'vitest';
import { fragmentosEnBanda, fragmentoEnX, type FilaGeometrica } from '../src/texto-pdf.ts';
import {
  dentroDeAlgunaRegion,
  parDeColumnas,
  periodoPorEtiquetas,
  regionesDeTabla,
  seccionesPorClave,
  type ColumnasDeImporte,
} from '../src/adaptadores/toolkit.ts';
import { hashesDeCuenta, type ClaveCuenta } from '../src/hash.ts';
import { importeACentavos } from '../src/parseo-ar.ts';

/** Arma una fila geométrica. `ancho` importa: las columnas de importe se localizan por el borde derecho. */
function fila(
  fragmentos: readonly { readonly texto: string; readonly x: number; readonly ancho?: number }[],
  pagina = 1,
  y = 500,
): FilaGeometrica {
  return {
    pagina,
    y,
    fragmentos: [...fragmentos]
      .map((f) => ({ texto: f.texto, x: f.x, y, ancho: f.ancho ?? f.texto.length * 5 }))
      .sort((a, b) => a.x - b.x),
  };
}

/** Un fragmento cuyo **borde derecho** cae exactamente en `derecha`. */
function enBordeDerecho(texto: string, derecha: number, ancho = 40): { texto: string; x: number; ancho: number } {
  return { texto, x: derecha - ancho, ancho };
}

// -----------------------------------------------------------------------------
describe('fragmentosEnBanda: la glosa que viene partida en varios fragmentos', () => {
  /**
   * El caso base y el más caro. En el tercer banco la descripción sale en 1 a 4 fragmentos por fila (814
   * filas con 3), y `fragmentoEnX` —que es lo que usa el adaptador escrito -- devuelve **solo el primero**.
   * El resultado son 1186 filas con la descripción mutilada y todos los importes correctos.
   */
  it('une los cuatro fragmentos; `fragmentoEnX` devuelve solo el primero', () => {
    const f = fila([
      { texto: '01/11/25', x: 33.0 },
      { texto: 'TRANSF', x: 70.8 },
      { texto: 'RECIBIDA', x: 110.0 },
      { texto: 'DE', x: 160.0 },
      { texto: 'CUENTA PROPIA', x: 180.0 },
    ]);

    expect(fragmentoEnX(f, 70.8, 1.0)?.texto).toBe('TRANSF');
    expect(fragmentosEnBanda(f, 70.0, 263.5)).toBe('TRANSF RECIBIDA DE CUENTA PROPIA');
  });

  /**
   * Los 113 movimientos cuya glosa **desborda visualmente** hacia la columna de referencia: su borde derecho
   * llega a 297.6 y la referencia arranca en 264.0. Seleccionar por borde derecho los perdería.
   */
  it('un fragmento que se derrama a la derecha de la banda entra ENTERO', () => {
    const f = fila([
      { texto: 'GLOSA', x: 70.8, ancho: 30 },
      // Empieza adentro (240) y termina en 297.6, o sea 33.6 pt pasado el borde de la banda.
      { texto: 'QUE SE DERRAMA', x: 240.0, ancho: 57.6 },
    ]);
    expect(fragmentosEnBanda(f, 70.0, 263.5)).toBe('GLOSA QUE SE DERRAMA');
  });

  /**
   * La contracara: la banda tiene que terminar **antes** de la columna siguiente. En ese banco la referencia
   * está en `x = 264.0` exacto, y una regla "todo lo que está a la derecha de 260" se la lleva puesta.
   */
  it('NO se lleva el fragmento de la columna siguiente', () => {
    const f = fila([
      { texto: 'GLOSA', x: 70.8 },
      { texto: '9876543', x: 264.0 },
    ]);
    expect(fragmentosEnBanda(f, 70.0, 263.5)).toBe('GLOSA');
    // Y la referencia se sigue leyendo por su propia `x`, que es exacta.
    expect(fragmentoEnX(f, 264.0, 0.5)?.texto).toBe('9876543');
  });

  it('respeta el orden visual aunque los fragmentos vengan desordenados', () => {
    const f = fila([
      { texto: 'TERCERO', x: 200.0 },
      { texto: 'PRIMERO', x: 70.8 },
      { texto: 'SEGUNDO', x: 120.0 },
    ]);
    expect(fragmentosEnBanda(f, 70.0, 263.5)).toBe('PRIMERO SEGUNDO TERCERO');
  });

  it('colapsa espacios y recorta; una banda sin fragmentos es cadena vacía', () => {
    const f = fila([{ texto: '  DOS   ESPACIOS  ', x: 70.8 }]);
    expect(fragmentosEnBanda(f, 70.0, 263.5)).toBe('DOS ESPACIOS');
    expect(fragmentosEnBanda(f, 400.0, 500.0)).toBe('');
  });

  /**
   * 🔴 **Los dos bordes, con las coordenadas LITERALES de la especificación.**
   *
   * Los cinco tests de arriba usan `(70.0, 263.5)` — un colchón que eligió el autor, con el que el borde
   * nunca se toca. Los valores que publica `07-formato-macro.md` §3 son `70.8` para la glosa y `264.0` para
   * la referencia, y ésa es la llamada que va a escribir quien haga el adaptador.
   *
   * Con los dos extremos cerrados —como estaba— esa llamada natural metía **las 1221 referencias adentro de
   * la glosa**, con los 41 tests en verde. La banda es `[desde, hasta)`: `desde` inclusivo, `hasta`
   * exclusivo. Un test por extremo, y el fixture habla el idioma del documento.
   */
  it('con las coordenadas medidas (70.8, 264.0), la referencia queda AFUERA', () => {
    const f = fila([
      { texto: 'N/D COMISION', x: 70.8 },
      { texto: 'TRF MACROL', x: 140.0 },
      { texto: '9876543', x: 264.0 },
    ]);
    expect(fragmentosEnBanda(f, 70.8, 264.0)).toBe('N/D COMISION TRF MACROL');
  });

  it('`desde` es INCLUSIVO: el primer fragmento de glosa no se pierde', () => {
    const f = fila([{ texto: 'PRIMERO', x: 70.8 }]);
    expect(fragmentosEnBanda(f, 70.8, 264.0)).toBe('PRIMERO');
  });

  it('`hasta` es EXCLUSIVO: el fragmento que arranca justo en el límite no entra', () => {
    const f = fila([{ texto: 'REFERENCIA', x: 264.0 }]);
    expect(fragmentosEnBanda(f, 70.8, 264.0)).toBe('');
  });
});

// -----------------------------------------------------------------------------
describe('parDeColumnas: dos familias de banco, no dos ramas de un if', () => {
  /** Las tres ventanas del tercer banco, en puntos PDF (`07` §3). Bordes derechos, no izquierdos. */
  const COLUMNAS_SIN_SIGNO: ColumnasDeImporte = {
    debito: { desde: 385.3, hasta: 386.3 },
    credito: { desde: 465.1, hasta: 466.1 },
    saldo: { desde: 553.3, hasta: 554.3 },
  };

  const filaDeMovimiento = (
    columna: 'credito' | 'debito',
    importe: string,
    saldo: string,
  ): FilaGeometrica =>
    fila([
      { texto: '01/11/25', x: 33.0 },
      { texto: 'GLOSA SINTETICA', x: 70.8 },
      enBordeDerecho(importe, columna === 'debito' ? 385.8 : 465.6),
      enBordeDerecho(saldo, 553.8),
    ]);

  /**
   * **La trampa de portar código, y es la que hay que ver primero.**
   *
   * El lector del primer banco exige que el signo del token coincida con la columna. En estos dos bancos el
   * token **nunca** trae signo: 0 de 158 y 0 de 1346. Copiado tal cual devuelve `null` en todas las filas, o
   * sea **un adaptador que lee cero movimientos** — y el síntoma no dice por qué.
   */
  it('el criterio del banco con signo redundante da CERO pares en un banco sin signo', () => {
    const f = filaDeMovimiento('debito', '4.321,00', '-98.765,43');
    expect(parDeColumnas(f, COLUMNAS_SIN_SIGNO, { traeSignoEnElImporte: true })).toBeNull();
    expect(parDeColumnas(f, COLUMNAS_SIN_SIGNO, { traeSignoEnElImporte: false })).not.toBeNull();
  });

  it('sin signo en el token, el DÉBITO sale negativo: lo dice la columna', () => {
    const r = parDeColumnas(filaDeMovimiento('debito', '4.321,00', '-98.765,43'), COLUMNAS_SIN_SIGNO, {
      traeSignoEnElImporte: false,
    });
    expect(r).toEqual({ importe: '-4321.00', saldo: '-98765.43', columna: 'debito' });
  });

  it('sin signo en el token, el CRÉDITO sale positivo', () => {
    const r = parDeColumnas(filaDeMovimiento('credito', '4.321,00', '98.765,43'), COLUMNAS_SIN_SIGNO, {
      traeSignoEnElImporte: false,
    });
    expect(r).toEqual({ importe: '4321.00', saldo: '98765.43', columna: 'credito' });
  });

  /**
   * Si el banco declara que no publica signo y aparece uno, **no es un negativo**: es un token mal separado
   * o una fila que no es un movimiento. Aceptarlo produciría un débito de signo invertido que la cadena de
   * saldos detectaría recién en la fila siguiente, y como `ARIT_CADENA_ROTA`, no como lo que es.
   */
  it('un token FIRMADO en un banco que no publica signo es un hallazgo, no un negativo', () => {
    const r = parDeColumnas(filaDeMovimiento('debito', '-4.321,00', '-98.765,43'), COLUMNAS_SIN_SIGNO, {
      traeSignoEnElImporte: false,
    });
    expect(r).toBeNull();
  });

  describe('con el signo redundante, la coincidencia se CRUZA', () => {
    /** Ventanas del primer banco (`02` §4): el débito va a la derecha del crédito, al revés del tercero. */
    const COLUMNAS_CON_SIGNO: ColumnasDeImporte = {
      credito: { desde: 340, hasta: 356 },
      debito: { desde: 458, hasta: 470 },
      saldo: { desde: 572, hasta: 584 },
    };

    it('el signo del token coincide con la columna: par válido', () => {
      const f = fila([
        enBordeDerecho('-4.321,00', 465),
        enBordeDerecho('98.765,43-', 578),
      ]);
      expect(parDeColumnas(f, COLUMNAS_CON_SIGNO, { traeSignoEnElImporte: true })).toEqual({
        importe: '-4321.00',
        saldo: '-98765.43',
        columna: 'debito',
      });
    });

    it('el signo NO coincide con la columna: es un hallazgo, no se elige uno', () => {
      // Token positivo en la columna de débito. Derivar el signo de la columna taparía la contradicción.
      const f = fila([enBordeDerecho('4.321,00', 465), enBordeDerecho('98.765,43', 578)]);
      expect(parDeColumnas(f, COLUMNAS_CON_SIGNO, { traeSignoEnElImporte: true })).toBeNull();
    });

    it('el importe en CERO no contradice a ninguna columna', () => {
      const f = fila([enBordeDerecho('0,00', 465), enBordeDerecho('98.765,43', 578)]);
      expect(parDeColumnas(f, COLUMNAS_CON_SIGNO, { traeSignoEnElImporte: true })?.columna).toBe('debito');
    });
  });

  it('un importe en las DOS columnas es null, no "gana el crédito"', () => {
    const f = fila([
      enBordeDerecho('1.111,00', 385.8),
      enBordeDerecho('2.222,00', 465.6),
      enBordeDerecho('98.765,43', 553.8),
    ]);
    expect(parDeColumnas(f, COLUMNAS_SIN_SIGNO, { traeSignoEnElImporte: false })).toBeNull();
  });

  it('sin saldo no hay par: la cadena de saldos es la verificación del signo', () => {
    const f = fila([enBordeDerecho('4.321,00', 385.8)]);
    expect(parDeColumnas(f, COLUMNAS_SIN_SIGNO, { traeSignoEnElImporte: false })).toBeNull();
  });

  /**
   * Ventanas solapadas: el **mismo** fragmento entra como importe y como saldo. Sin la guarda sale un par
   * plausible con la mitad inventada —importe = saldo— y la cadena de saldos da un delta igual al saldo,
   * así que nada lo contradice. En un banco del roster el `Saldo total` cae a **4 pt** de la columna de
   * saldo: el solapamiento no es hipotético.
   */
  it('el mismo fragmento no puede ser el importe Y el saldo', () => {
    const f = fila([enBordeDerecho('4.321,00', 465.6)]);
    const solapadas: ColumnasDeImporte = {
      debito: { desde: 385.3, hasta: 386.3 },
      credito: { desde: 465.1, hasta: 466.1 },
      saldo: { desde: 465.1, hasta: 466.1 }, // ← la misma ventana que crédito
    };
    expect(parDeColumnas(f, solapadas, { traeSignoEnElImporte: false })).toBeNull();
  });

  it('sin importe en ninguna columna tampoco hay par (es la fila de saldo inicial)', () => {
    const f = fila([{ texto: 'Saldo Inicial', x: 115.0 }, enBordeDerecho('98.765,43', 553.8)]);
    expect(parDeColumnas(f, COLUMNAS_SIN_SIGNO, { traeSignoEnElImporte: false })).toBeNull();
  });

  /** El tercer banco pone el menos **adelante** en el saldo; el primero **atrás**. Los dos se leen. */
  it('lee el saldo negativo con el menos adelante y con el menos atrás', () => {
    const adelante = parDeColumnas(filaDeMovimiento('credito', '1,00', '-98.765,43'), COLUMNAS_SIN_SIGNO, {
      traeSignoEnElImporte: false,
    });
    const atras = parDeColumnas(filaDeMovimiento('credito', '1,00', '98.765,43-'), COLUMNAS_SIN_SIGNO, {
      traeSignoEnElImporte: false,
    });
    expect(adelante?.saldo).toBe('-98765.43');
    expect(atras?.saldo).toBe('-98765.43');
  });
});

// -----------------------------------------------------------------------------
describe('regionesDeTabla: acotar el cuerpo, porque el anexo cae en las mismas ventanas', () => {
  const ENCABEZADO = /^FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO$/;
  const CIERRE = /^SALDO FINAL AL DIA /;

  it('el encabezado repetido por página NO abre una región nueva', () => {
    const textos = [
      'Carátula',
      'FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO',
      'mov 1',
      'FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO', // página 2
      'mov 2',
      'FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO', // página 3
      'mov 3',
      'SALDO FINAL AL DIA 28/11/2025',
      'Tasa Efec. Anual: 1,00',
    ];
    const r = regionesDeTabla(textos, ENCABEZADO, CIERRE);

    expect(r).toHaveLength(1);
    expect(r[0]?.repeticionesDeEncabezado).toBe(3);
    expect(r[0]?.indiceEncabezado).toBe(1);
    expect(r[0]?.indiceCierre).toBe(7);
  });

  it('deja AFUERA el encabezado, el cierre y todo lo que viene después', () => {
    const textos = [
      'Saldo Cuentas en PESOS 1,00', // 0 — importe fuera de tabla, cae en la ventana de saldo
      'FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO', // 1
      'mov', // 2
      'SALDO FINAL AL DIA 28/11/2025', // 3
      'Tasa Efec. Anual: 1,00', // 4 — el otro importe fuera de tabla
    ];
    const r = regionesDeTabla(textos, ENCABEZADO, CIERRE);

    expect(dentroDeAlgunaRegion(r, 0)).toBe(false);
    expect(dentroDeAlgunaRegion(r, 1)).toBe(false); // el encabezado no es cuerpo
    expect(dentroDeAlgunaRegion(r, 2)).toBe(true);
    expect(dentroDeAlgunaRegion(r, 3)).toBe(false); // el cierre es dato de verificación
    expect(dentroDeAlgunaRegion(r, 4)).toBe(false);
  });

  it('dos cuentas en un archivo dan dos regiones', () => {
    const textos = [
      'FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO',
      'mov de la primera',
      'SALDO FINAL AL DIA 28/11/2025',
      'FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO',
      'mov de la segunda',
      'SALDO FINAL AL DIA 28/11/2025',
    ];
    expect(regionesDeTabla(textos, ENCABEZADO, CIERRE)).toHaveLength(2);
  });

  it('un cierre sin región abierta no cierra nada', () => {
    const textos = ['SALDO FINAL AL DIA 28/11/2025', 'FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO', 'mov'];
    const r = regionesDeTabla(textos, ENCABEZADO, CIERRE);
    expect(r).toHaveLength(1);
    expect(r[0]?.indiceEncabezado).toBe(1);
  });

  it('sin línea de cierre, la región llega hasta el final del documento', () => {
    const textos = ['FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO', 'mov 1', 'mov 2'];
    const r = regionesDeTabla(textos, ENCABEZADO, CIERRE);
    expect(r[0]?.indiceCierre).toBeNull();
    expect(dentroDeAlgunaRegion(r, 2)).toBe(true);
  });

  it('sin encabezado no hay ninguna región: no se asume que todo el archivo es tabla', () => {
    expect(regionesDeTabla(['a', 'b'], ENCABEZADO, CIERRE)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
describe('periodoPorEtiquetas: las dos fechas en filas distintas', () => {
  const DESDE = /^Desde:\s*(\d{2}\/\d{2}\/\d{2})$/;
  const HASTA = /^Hasta:\s*(\d{2}\/\d{2}\/\d{2})$/;

  it('lee el período aunque las etiquetas estén a 14 pt una de otra', () => {
    const textos = ['CUIT: 30-00000000-0', 'Desde: 30/05/26', 'Hasta: 30/06/26'];
    expect(periodoPorEtiquetas(textos, DESDE, HASTA)).toEqual({
      desde: '2026-05-30',
      hasta: '2026-06-30',
    });
  });

  /**
   * Acá el rótulo dice cuál es cuál, así que un par invertido **no se da vuelta**: significa que se leyó
   * mal, y ordenarlo escondería el error. Es la diferencia con `extraerPeriodo`, donde las dos fechas salen
   * del mismo texto y el orden lo decide el extractor.
   */
  it('un período invertido es null: no se ordena por las dudas', () => {
    const textos = ['Desde: 30/06/26', 'Hasta: 30/05/26'];
    expect(periodoPorEtiquetas(textos, DESDE, HASTA)).toBeNull();
  });

  it('un período de un solo día es válido (las etiquetas son dos, no la misma celda leída dos veces)', () => {
    const textos = ['Desde: 30/06/26', 'Hasta: 30/06/26'];
    expect(periodoPorEtiquetas(textos, DESDE, HASTA)).toEqual({
      desde: '2026-06-30',
      hasta: '2026-06-30',
    });
  });

  it('falta una de las dos etiquetas: null, nunca la mitad del período', () => {
    expect(periodoPorEtiquetas(['Desde: 30/05/26'], DESDE, HASTA)).toBeNull();
  });

  it('una fecha imposible no se acepta como período', () => {
    expect(periodoPorEtiquetas(['Desde: 31/02/26', 'Hasta: 30/06/26'], DESDE, HASTA)).toBeNull();
  });

  it('una regex con flag `g` no saltea apariciones (lastIndex no se arrastra)', () => {
    const textos = ['ruido', 'Desde: 30/05/26', 'Hasta: 30/06/26'];
    const conGlobal = /^Desde:\s*(\d{2}\/\d{2}\/\d{2})$/g;
    expect(periodoPorEtiquetas(textos, conGlobal, HASTA)?.desde).toBe('2026-05-30');
  });
});

// -----------------------------------------------------------------------------
describe('seccionesPorClave: 47 encabezados, 3 cuentas', () => {
  const RE_CUENTA = /^(CUENTA(?: [A-ZÁÉÍÓÚÑ.]+)+) NRO\.:\s*(\d-\d{3}-\d{10}-\d)$/;
  const claveDeEncabezado = (t: string): string | null => RE_CUENTA.exec(t)?.[2] ?? null;

  const CTA_A = 'CUENTA CORRIENTE ESPECIAL EN PESOS NRO.: 1-000-0000000001-0';
  const CTA_B = 'CUENTA CORRIENTE BANCARIA NRO.: 3-000-0000000002-0';

  /**
   * El error que esta función existe para impedir: sin la deduplicación por número, un resumen de 45 páginas
   * emite **47 cuentas para 3**, y `uq_lote_cuenta_natural` revienta — o, si el número se normaliza distinto,
   * **no revienta** y quedan 47 filas de cuenta con la cadena de saldos partida en 45 pedazos.
   */
  it('el encabezado repetido reabre la sección, no crea una cuenta nueva', () => {
    const textos = [CTA_A, 'mov 1', CTA_A, 'mov 2', CTA_A, 'mov 3'];
    const { secciones } = seccionesPorClave(textos, claveDeEncabezado);

    expect(secciones).toHaveLength(1);
    expect(secciones[0]?.repeticionesDeEncabezado).toBe(3);
    expect(secciones[0]?.indices).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('dos números distintos son dos secciones, en orden de aparición', () => {
    const { secciones } = seccionesPorClave([CTA_A, 'm1', CTA_B, 'm2'], claveDeEncabezado);
    expect(secciones.map((s) => s.clave)).toEqual([
      '1-000-0000000001-0',
      '3-000-0000000002-0',
    ]);
  });

  /**
   * **La trampa de orden de la página 2**, medida: primero se repite el encabezado de la cuenta que venía
   * —para colgarle la cola de su anexo, que cruza el corte de página— y **después** empieza la nueva. Un
   * autómata que cierre la sección al ver cualquier encabezado le atribuye el anexo a la cuenta equivocada.
   */
  it('la cola del anexo de la cuenta anterior vuelve a SU sección, no a la nueva', () => {
    const textos = [
      CTA_A, // 0  página 1
      'mov de A', // 1
      CTA_A, // 2  página 2: se repite A para colgarle el anexo
      '(S.E.U.O.) 1,00', // 3  ← la cola del anexo de A
      CTA_B, // 4  y recién ahora empieza B
      'mov de B', // 5
    ];
    const { secciones } = seccionesPorClave(textos, claveDeEncabezado);

    expect(secciones).toHaveLength(2);
    expect(secciones[0]?.indices).toContain(3);
    expect(secciones[1]?.indices).not.toContain(3);
  });

  it('lo que está antes del primer encabezado no pertenece a ninguna cuenta', () => {
    const { secciones, indicesSinSeccion } = seccionesPorClave(
      ['Carátula del archivo', 'Leyenda legal', CTA_A, 'mov'],
      claveDeEncabezado,
    );
    expect(indicesSinSeccion).toEqual([0, 1]);
    expect(secciones[0]?.indices).toEqual([2, 3]);
  });

  it('un documento sin encabezados de cuenta no inventa una sección', () => {
    const { secciones, indicesSinSeccion } = seccionesPorClave(['a', 'b'], claveDeEncabezado);
    expect(secciones).toHaveLength(0);
    expect(indicesSinSeccion).toEqual([0, 1]);
  });

  /**
   * Secciones **intercaladas**. En el archivo medido las cuentas son contiguas, así que este caso está
   * declarado *no determinado* en `07` §15. La reapertura por clave lo soporta y esto lo deja probado: si
   * algún período trae las cuentas alternadas, el adaptador no se rompe en silencio.
   */
  it('soporta cuentas intercaladas, que están declaradas como no determinadas', () => {
    const { secciones } = seccionesPorClave(
      [CTA_A, 'm1', CTA_B, 'm2', CTA_A, 'm3'],
      claveDeEncabezado,
    );
    expect(secciones).toHaveLength(2);
    expect(secciones[0]?.indices).toEqual([0, 1, 4, 5]);
  });
});

// -----------------------------------------------------------------------------
describe('hashesDeCuenta: la clave es de la cuenta, y el ordinal se cuenta adentro', () => {
  const claveDe = (numero: string): ClaveCuenta => ({
    bancoCodigo: 'banco_de_prueba',
    numeroNormalizado: numero,
    moneda: 'ARS',
  });

  const FILA = {
    fecha: '2026-11-03',
    importe: '-4321.00',
    saldo: '-98765.43',
    descripcion: 'GLOSA SINTETICA',
  };

  /**
   * El archivo medido trae **7 grupos de filas duplicadas** repartidas en tres cuentas. Sin la cuenta adentro
   * del material del hash, dos movimientos idénticos de cuentas distintas colapsan al mismo valor: uno de los
   * dos se pierde contra el `unique`, o peor, queda atribuido a la cuenta equivocada.
   */
  it('dos filas idénticas en cuentas distintas NO colapsan', () => {
    const [a] = hashesDeCuenta(claveDe('0000000001'), [FILA]);
    const [b] = hashesDeCuenta(claveDe('0000000002'), [FILA]);
    expect(a).not.toBe(b);
  });

  it('la misma fila en la misma cuenta da el mismo hash: el reproceso es idempotente', () => {
    const [a] = hashesDeCuenta(claveDe('0000000001'), [FILA]);
    const [b] = hashesDeCuenta(claveDe('0000000001'), [FILA]);
    expect(a).toBe(b);
  });

  it('el empate genuino se distingue por el ordinal, y los dos hashes son distintos', () => {
    const h = hashesDeCuenta(claveDe('0000000001'), [FILA, FILA, FILA]);
    expect(new Set(h).size).toBe(3);
  });

  /**
   * El ordinal es **un contador de ocurrencia dentro del grupo de filas idénticas**, no la posición
   * absoluta. Por eso insertar una fila arriba no mueve el hash de las de abajo — que es lo que evita que un
   * extracto reemitido duplique todo lo que está debajo del movimiento agregado.
   */
  it('insertar una fila distinta arriba no mueve el hash de ninguna otra', () => {
    const otra = { ...FILA, importe: '-1111.00' };
    const sinLaNueva = hashesDeCuenta(claveDe('0000000001'), [FILA, otra]);
    const conLaNueva = hashesDeCuenta(claveDe('0000000001'), [
      { ...FILA, importe: '-2222.00' },
      FILA,
      otra,
    ]);
    expect(conLaNueva.slice(1)).toEqual(sinLaNueva);
  });
});

// -----------------------------------------------------------------------------
describe('U$S: el símbolo de moneda que dejaba ilegible la cuenta en dólares', () => {
  it('lee el importe en dólares, con y sin signo', () => {
    expect(importeACentavos('U$S 1.234,56')).toBe(123_456n);
    expect(importeACentavos('-U$S 1.234,56')).toBe(-123_456n);
    expect(importeACentavos('U$S1.234,56')).toBe(123_456n);
  });

  it('el peso sigue funcionando igual', () => {
    expect(importeACentavos('$ 1.234,56')).toBe(123_456n);
    expect(importeACentavos('-$ 1.234,56')).toBe(-123_456n);
  });

  /** El símbolo no relaja la regla que impide que un identificador entre como importe. */
  it('no abre la puerta a los dígitos pelados', () => {
    expect(importeACentavos('U$S 20123456789')).toBeNull();
  });
});
