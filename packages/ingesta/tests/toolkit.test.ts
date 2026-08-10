/**
 * EL TOOLKIT DE LAYOUT, contra el fixture sintético.
 *
 * Todo lo que se verifica acá es lo que los ocho adaptadores van a compartir. Si el toolkit está bien, un
 * banco nuevo es un archivo chico; si está mal, cada adaptador reimplementa el error a su manera.
 *
 * **Ningún test de este archivo toca `privado/`.** El fixture sintético existe justamente para esto.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agruparEnFilas,
  clasificarRuido,
  cortarEnColumnas,
  extraerPeriodo,
  inferirCortes,
  particionar,
  residuoDeParticion,
  RUIDO_COMUN,
  valorPorEtiqueta,
} from '../src/adaptadores/toolkit.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'extracto-sintetico.txt');
const LINEAS = readFileSync(FIXTURE, 'utf8').split(/\r?\n/);

const ES_MOVIMIENTO = (t: string): boolean => /^\d{2}\/\d{2}\/\d{2}\s/.test(t);

// -----------------------------------------------------------------------------
describe('carátula: se lee POR ETIQUETA, no por patrón', () => {
  /**
   * Buscar "el primer número de 22 dígitos" en vez de la etiqueta `CBU:` encuentra el identificador de una
   * contraparte del cuerpo y lo toma por el del titular. El extracto termina asignado a la cuenta
   * equivocada, con todo cuadrando. La etiqueta la imprime el banco y es la única ancla confiable.
   */
  it('encuentra el CBU por su etiqueta', () => {
    const r = valorPorEtiqueta(LINEAS, ['CBU:'], /\d{22}/);
    expect(r).not.toBeNull();
    expect(r?.valor).toMatch(/^\d{22}$/);
  });

  it('encuentra el número de cuenta por su etiqueta', () => {
    const r = valorPorEtiqueta(LINEAS, ['Cuenta Nº', 'Cuenta N°', 'Nro. de Cuenta'], /[\d\-/]{6,}/);
    expect(r?.valor).toBeDefined();
  });

  it('tolera la variante de la etiqueta: los bancos cambian `Nº` por `N°` entre versiones', () => {
    const lineas = ['Cuenta N° 0112-100000/0    CBU: 9990000090000000000001'];
    const r = valorPorEtiqueta(lineas, ['Cuenta Nº', 'Cuenta N°'], /[\d\-/]{6,}/);
    expect(r?.valor).toBe('0112-100000/0');
  });

  it('ignora acentos y mayúsculas al buscar la etiqueta', () => {
    const lineas = ['PERIODO: 01/06/2026 al 30/06/2026'];
    expect(valorPorEtiqueta(lineas, ['Período:'], /\d{2}\/\d{2}\/\d{4}/)?.valor).toBe('01/06/2026');
  });

  it('NO devuelve un valor que está ANTES de la etiqueta', () => {
    // Si buscara en toda la línea, tomaría el 22-dígitos de la izquierda, que es de otra cosa.
    const lineas = ['9999999999999999999999 no es el cbu    CBU: 1234567890123456789012'];
    expect(valorPorEtiqueta(lineas, ['CBU:'], /\d{22}/)?.valor).toBe('1234567890123456789012');
  });

  it('devuelve null si la etiqueta no está, en vez de adivinar', () => {
    expect(valorPorEtiqueta(LINEAS, ['ETIQUETA QUE NO EXISTE'], /\d+/)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe('columnas: los cortes se infieren, no se hardcodean', () => {
  const movimientos = LINEAS.filter(ES_MOVIMIENTO);

  it('el fixture tiene exactamente los movimientos que declara su especificación', () => {
    // Igualdad exacta, no `toBeGreaterThan(50)`: con un umbral, un adaptador que devuelve una sola fila
    // pasa el test. Es el anti-patrón que hace que una suite verde no signifique nada.
    expect(movimientos.length).toBe(80);
  });

  it('encuentra los tres canales entre columnas', () => {
    // Fecha | concepto | importe | saldo → exactamente tres canales. El número exacto es el que detecta
    // que el layout cambió; un `>= 3` acepta cualquier cosa por encima.
    expect(inferirCortes(movimientos).length).toBe(3);
  });

  it('cortar por los cortes inferidos deja la fecha sola en la primera columna', () => {
    const cortes = inferirCortes(movimientos);
    for (const linea of movimientos.slice(0, 20)) {
      const columnas = cortarEnColumnas(linea, cortes);
      expect(columnas[0], `la primera columna no es la fecha: ${columnas[0]}`).toMatch(
        /^\d{2}\/\d{2}\/\d{2}$/,
      );
    }
  });

  it('la última columna es el saldo, y tiene forma de importe en todas las filas', () => {
    const cortes = inferirCortes(movimientos);
    for (const linea of movimientos) {
      const columnas = cortarEnColumnas(linea, cortes);
      const ultima = columnas.at(-1) ?? '';
      expect(ultima, `la última columna no es un importe: "${ultima}"`).toMatch(
        /^-?\(?\$?\s?\d{1,3}(?:\.\d{3})*,\d{2}\)?-?$/,
      );
    }
  });

  /**
   * El corte va al MEDIO del canal a propósito: así un dígito que se corre un carácter —cosa que pasa
   * cuando el importe crece de seis a siete cifras— sigue cayendo en su columna. Cortar en el borde deja el
   * layout al filo de romperse por un espacio.
   */
  it('un valor que se corre un carácter sigue cayendo en su columna', () => {
    const base = ['01/06/26  CONCEPTO      1.234,56    9.876,54'];
    const corrido = ['01/06/26  CONCEPTO     12.345,67    9.876,54'];
    const cortes = inferirCortes([...base, ...corrido]);
    for (const linea of [...base, ...corrido]) {
      const columnas = cortarEnColumnas(linea, cortes);
      expect(columnas[0]).toBe('01/06/26');
      expect(columnas.at(-1)).toBe('9.876,54');
    }
  });

  it('sin filas no inventa cortes', () => {
    expect(inferirCortes([])).toEqual([]);
  });

  it('un solo espacio NO es un canal: aparece dentro de una glosa', () => {
    const cortes = inferirCortes(['01/06/26 UN CONCEPTO CON ESPACIOS  1.234,56'], 2);
    // Los canales de dos o más espacios: el que separa el concepto del importe.
    expect(cortes.length).toBe(1);
  });
});

// -----------------------------------------------------------------------------
describe('agrupar: la glosa que sigue en la línea de abajo', () => {
  const conPagina = LINEAS.map((texto) => ({ texto, pagina: 1 }));

  /**
   * Los dos errores opuestos, y los dos producen un resultado plausible:
   *   - tomar la continuación por un movimiento **inventa una fila** (sin importe, o con basura);
   *   - ignorarla **pierde la referencia**, que es el dato con el que el Módulo 2 matchea el tercero.
   */
  it('la continuación queda pegada a su movimiento, no como fila propia', () => {
    const filas = agruparEnFilas(conPagina, ES_MOVIMIENTO);
    const movimientosEnElTexto = LINEAS.filter(ES_MOVIMIENTO).length;
    expect(filas.length, 'inventó o perdió filas').toBe(movimientosEnElTexto);
  });

  it('alguna fila tiene continuaciones (si no, el test no prueba nada)', () => {
    const filas = agruparEnFilas(conPagina, ES_MOVIMIENTO);
    const conContinuacion = filas.filter((f) => f.continuaciones.length > 0);
    expect(conContinuacion.length, 'el fixture no tiene glosas multi-línea').toBeGreaterThan(0);
  });

  it('las continuaciones conservan su orden', () => {
    const filas = agruparEnFilas(
      [
        { texto: '01/06/26  MOVIMIENTO  1.234,56  9.876,54', pagina: 1 },
        { texto: '    PRIMERA CONTINUACION', pagina: 1 },
        { texto: '    SEGUNDA CONTINUACION', pagina: 1 },
      ],
      ES_MOVIMIENTO,
    );
    expect(filas.length).toBe(1);
    expect(filas[0]?.continuaciones).toEqual(['    PRIMERA CONTINUACION', '    SEGUNDA CONTINUACION']);
  });

  it('una continuación ANTES del primer movimiento no crea una fila fantasma', () => {
    // Es carátula o encabezado, no una continuación. Crear una fila acá desplazaría todo el conteo.
    const filas = agruparEnFilas(
      [
        { texto: 'Titular: EMPRESA DE PRUEBA', pagina: 1 },
        { texto: '01/06/26  MOVIMIENTO  1.234,56  9.876,54', pagina: 1 },
      ],
      ES_MOVIMIENTO,
    );
    expect(filas.length).toBe(1);
    expect(filas[0]?.continuaciones).toEqual([]);
  });

  it('cada fila sabe en qué línea y en qué página está: sirve para reportar dónde falló', () => {
    const filas = agruparEnFilas(conPagina, ES_MOVIMIENTO);
    for (const f of filas) {
      expect(f.indice).toBeGreaterThanOrEqual(0);
      expect(LINEAS[f.indice]).toBe(f.principal);
    }
  });
});

// -----------------------------------------------------------------------------
describe('LA GLOSA NO PUEDE LLEVAR RUIDO — el peor modo de falla del módulo', () => {
  /**
   * ## Qué se descubrió midiendo, y por qué este es el test más importante del archivo
   *
   * La primera versión de `agruparEnFilas` trataba **toda** línea que no empezaba con fecha como
   * continuación del movimiento anterior. Medido sobre este mismo fixture: **9 de las 80 filas** se
   * llevaban adentro de la glosa el **encabezado de la página siguiente**, la **línea de totales**, el
   * **saldo final** y la **carátula de la segunda cuenta**.
   *
   * Y el test pasaba, porque su única aserción era `filas.length === 80`. O sea: la glosa corrida —el peor
   * modo de falla del módulo, §6.4— ocurriendo en el caso base, con un test verde encima.
   *
   * El conteo de filas **no puede** detectarlo: la cantidad de movimientos es correcta. Lo único que lo
   * detecta es mirar el contenido de las glosas.
   */
  const REGLAS = [
    ...RUIDO_COMUN,
    { tipo: 'totales' as const, patron: /^Total\s/i, motivo: 'Línea de totales.' },
    {
      tipo: 'caratula' as const,
      patron: /^(?:Cuenta|Titular|Saldo (?:Anterior|Final))/i,
      motivo: 'Carátula de la cuenta.',
    },
    {
      tipo: 'encabezado' as const,
      patron: /^BANCO SINTETICO|^Periodo:/i,
      motivo: 'Encabezado del banco, repetido por página.',
    },
    {
      tipo: 'leyenda_legal' as const,
      patron: /^\s*\*\*\*|^\s{4}Ante cualquier/i,
      motivo: 'Leyenda legal.',
    },
  ];

  /** Una continuación de este banco: indentada y sin fecha al inicio. */
  const ES_CONTINUACION = (t: string): boolean => /^\s{2,}\S/.test(t) && !ES_MOVIMIENTO(t.trimStart());

  const conPagina = LINEAS.map((texto) => ({ texto, pagina: 1 }));

  it('ninguna continuación es una línea de ruido', () => {
    const p = particionar(conPagina, ES_MOVIMIENTO, REGLAS, ES_CONTINUACION);

    const conRuido = p.filas
      .filter((f) => f.continuaciones.some((c) => clasificarRuido(c, REGLAS) !== null))
      .map((f) => ({ fila: f.indice, glosa: f.continuaciones }));

    expect(conRuido, 'la glosa se comió encabezados, totales o carátula').toEqual([]);
  });

  it('`agruparEnFilas` con el criterio de ruido tampoco lo absorbe', () => {
    // La versión sin el tercer parámetro metía 9 de 80. Con él, cero.
    const filas = agruparEnFilas(conPagina, ES_MOVIMIENTO, (t) => clasificarRuido(t, REGLAS) !== null);
    const conRuido = filas.filter((f) =>
      f.continuaciones.some((c) => clasificarRuido(c, REGLAS) !== null),
    );
    expect(conRuido.length).toBe(0);
    expect(filas.length).toBe(80);
  });

  it('sin el criterio de ruido, el bug REAPARECE (la verificación del verificador)', () => {
    /**
     * Si esto diera cero, el test de arriba no estaría probando nada: el criterio de ruido no haría falta.
     *
     * Acá el umbral **sí** es la aserción correcta, al contrario que en el resto del archivo: la cantidad
     * exacta depende de cuántos cortes de página tenga el fixture, que es un parámetro de su
     * especificación. Lo que se verifica es que **el caso exista**, no cuántas veces.
     */
    const filas = agruparEnFilas(conPagina, ES_MOVIMIENTO);
    const conRuido = filas.filter((f) =>
      f.continuaciones.some((c) => clasificarRuido(c, REGLAS) !== null),
    );
    expect(conRuido.length, 'el fixture ya no tiene el caso: el test dejó de proteger algo').toBeGreaterThan(
      0,
    );
  });

  /**
   * ## La partición se CUENTA, no se declara
   *
   * `verificarAritmetica` recibe `coberturaDeLineasCompleta` por su contexto, o sea que hoy la **declara el
   * adaptador**. Eso es el mismo autocertificado que el contrato prohíbe para los totales: un adaptador que
   * se comió el encabezado reporta cobertura completa, con razón desde su punto de vista y falso desde el
   * del documento.
   *
   * La ecuación de abajo la puede verificar un tercero sin preguntarle nada al adaptador.
   */
  it('la ecuación de partición cierra: ninguna línea se pierde en silencio', () => {
    const p = particionar(conPagina, ES_MOVIMIENTO, REGLAS, ES_CONTINUACION);
    expect(residuoDeParticion(p)).toBe(0);
  });

  it('y ninguna línea queda sin explicación', () => {
    const p = particionar(conPagina, ES_MOVIMIENTO, REGLAS, ES_CONTINUACION);
    const sinExplicar = p.noInterpretadas.map((i) => LINEAS[i]);
    expect(sinExplicar, 'líneas que ninguna regla explicó').toEqual([]);
  });

  it('el recuento por tipo dice QUÉ se descartó, no solo cuánto', () => {
    const p = particionar(conPagina, ES_MOVIMIENTO, REGLAS, ES_CONTINUACION);
    // Los cuatro tipos que este fixture tiene de verdad. Si alguno cae a cero, el fixture perdió un rasgo.
    expect(p.ruido.encabezado).toBeGreaterThan(0);
    expect(p.ruido.separador).toBeGreaterThan(0);
    expect(p.ruido.totales).toBeGreaterThan(0);
    expect(p.ruido.caratula).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
describe('ruido: se descarta, pero nunca en silencio', () => {
  it('reconoce el separador de guiones', () => {
    expect(clasificarRuido('------------------------------', RUIDO_COMUN)?.tipo).toBe('separador');
  });

  it('reconoce la fila de títulos de columna', () => {
    expect(clasificarRuido('Fecha     Concepto     Importe', RUIDO_COMUN)?.tipo).toBe('encabezado');
  });

  it('reconoce la línea vacía sin necesidad de una regla', () => {
    expect(clasificarRuido('   ', RUIDO_COMUN)?.tipo).toBe('vacia');
  });

  it('NO clasifica un movimiento como ruido', () => {
    expect(clasificarRuido('01/06/26  CONCEPTO  1.234,56  9.876,54', RUIDO_COMUN)).toBeNull();
  });

  /**
   * `totales` y `caratula` son ruido para el cuerpo y **datos** para la verificación. Por eso la función
   * devuelve el tipo y no un booleano: un `esRuido(): boolean` obligaría a buscar los totales una segunda
   * vez, y esa segunda búsqueda es donde se pierde la línea de un banco que la escribe distinto.
   */
  it('el tipo distingue lo que es ruido para el cuerpo de lo que es dato para la verificación', () => {
    const reglas = [
      ...RUIDO_COMUN,
      {
        tipo: 'totales' as const,
        patron: /^Total\s+(?:Creditos|Debitos)/i,
        motivo: 'Línea de totales: no es un movimiento, pero es el dato de la verificación.',
      },
    ];
    const r = clasificarRuido('Total Creditos:        68.911,57', reglas);
    expect(r?.tipo).toBe('totales');
    // Y la regla trae escrito su motivo, para que se pueda discutir.
    expect(r?.motivo).toContain('verificación');
  });

  it('cada línea del fixture es movimiento, continuación o ruido clasificado: ninguna queda huérfana', () => {
    const reglas = [
      ...RUIDO_COMUN,
      { tipo: 'totales' as const, patron: /^Total\s/i, motivo: 'Totales.' },
      { tipo: 'caratula' as const, patron: /^(?:Cuenta|Titular|Saldo (?:Anterior|Final))/i, motivo: 'Carátula.' },
      { tipo: 'encabezado' as const, patron: /^BANCO SINTETICO|^Periodo:/i, motivo: 'Encabezado.' },
      { tipo: 'leyenda_legal' as const, patron: /^\s*\*\*\*|^\s{4}Ante cualquier/i, motivo: 'Leyenda.' },
    ];

    const huerfanas = LINEAS.filter(
      (l) => !ES_MOVIMIENTO(l) && !/^\s{4}[A-Z]/.test(l) && clasificarRuido(l, reglas) === null,
    );
    // Una línea huérfana es una línea que el adaptador descartaría sin saber por qué. Es exactamente lo que
    // `lineasNoInterpretadas` tiene que reportar.
    expect(huerfanas, `líneas sin clasificar: ${JSON.stringify(huerfanas.slice(0, 3))}`).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('período: las dos fechas pueden venir PEGADAS', () => {
  /** Está en el material real y rompe cualquier `split`: parece una sola fecha larga. */
  it('lee las dos fechas sin separador', () => {
    expect(extraerPeriodo('Periodo: 01/06/202630/06/2026   Pagina 1')).toEqual({
      desde: '2026-06-01',
      hasta: '2026-06-30',
    });
  });

  it.each([
    ['con "al"', 'Periodo: 01/06/2026 al 30/06/2026'],
    ['con guion', 'Periodo: 01/06/2026 - 30/06/2026'],
    ['con "hasta"', 'Desde 01/06/2026 hasta 30/06/2026'],
    ['con año de dos dígitos', 'Periodo: 01/06/26 al 30/06/26'],
    ['con guiones como separador de fecha', 'Periodo: 01-06-2026 al 30-06-2026'],
  ])('también %s', (_caso, texto) => {
    expect(extraerPeriodo(texto)).toEqual({ desde: '2026-06-01', hasta: '2026-06-30' });
  });

  it('lo lee del fixture', () => {
    const linea = LINEAS.find((l) => l.startsWith('Periodo:')) ?? '';
    expect(extraerPeriodo(linea)).toEqual({ desde: '2026-06-01', hasta: '2026-06-30' });
  });

  /**
   * **Decisión revisada por el material real.**
   *
   * La primera versión rechazaba el período invertido, razonando que era un parseo mal hecho. El archivo del
   * banco piloto lo refutó: `pdf.js` emite en orden de content-stream y ese banco emite las dos fechas
   * **`[hasta, desde]`**. El control rechazaba el caso normal, y el período caía a un fallback en silencio.
   *
   * Cuál fecha es el inicio del período no depende del orden de emisión: es la menor.
   */
  it('el orden de emisión no importa: se toma min y max', () => {
    const alDerecho = extraerPeriodo('Periodo: 01/06/2026 al 30/06/2026');
    const alReves = extraerPeriodo('Periodo: 30/06/202601/06/2026');
    expect(alDerecho).toEqual({ desde: '2026-06-01', hasta: '2026-06-30' });
    expect(alReves, 'el orden invertido es el caso REAL de un banco del roster').toEqual(alDerecho);
  });

  it('las dos fechas iguales sí se rechazan: se leyó la misma celda dos veces', () => {
    expect(extraerPeriodo('Periodo: 01/06/2026 al 01/06/2026')).toBeNull();
  });

  it('devuelve null si no hay dos fechas, en vez de inventar la segunda', () => {
    expect(extraerPeriodo('Periodo: 01/06/2026')).toBeNull();
    expect(extraerPeriodo('sin fechas')).toBeNull();
  });
});
