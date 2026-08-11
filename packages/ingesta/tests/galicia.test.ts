/**
 * ADAPTADOR GALICIA — los tests propios que le faltaban (plan de construcción, E2).
 *
 * ## Por qué este archivo existe
 *
 * Galicia es el adaptador más antiguo del repo y el que más rodaje real tiene: 326 movimientos, cadena de
 * saldos sin rupturas, totales exactos. Y hasta hoy **lo único que lo respaldaba era una corrida contra un
 * archivo que el gate no puede abrir**. Un adaptador cuya única evidencia vive en `privado/` es un
 * adaptador que nadie puede refactorizar: la primera vez que alguien toque una coordenada, el único modo de
 * saber si rompió algo es tener el PDF de un cliente a mano.
 *
 * Es también la condición que la migración de `leerPar` a `parDeColumnas` estaba esperando. Con estos tests
 * verdes, la copia local se borró.
 *
 * ## ⚠️ Ningún valor de este archivo sale del material real
 *
 * Las **coordenadas en puntos PDF sí son las medidas** —geometría del formato que imprime el banco, no un
 * dato de nadie— y están literales, tomadas de `docs/diseno/02-formato-galicia.md` §4: `38.4` para la fecha,
 * `82.2` para la descripción, `224.4` para `Origen`, y los bordes derechos `351.7–352.1` / `465.1–465.4` /
 * `578.5–578.8`. Nada de redondearlas: un fixture con `350` en vez de `351.9` valida una ventana que el
 * documento no tiene, que es exactamente el error que `fragmentosEnBanda` ya se comió una vez.
 *
 * Los importes son **escaleras y repdígitos**, las glosas están inventadas y el identificador de la
 * carátula lleva **verificador inválido**. `tools/barrido-fuga.ts` cruza este archivo contra el material
 * real y falla si algún valor coincide.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPACIDADES_GALICIA,
  leerGalicia,
  reconoceGalicia,
  type SalidaGalicia,
} from '../src/adaptadores/galicia.ts';
import { cuentaConMovimientosSchema, type CuentaConMovimientos } from '../src/esquema.ts';
import { verificarAritmetica } from '../src/verificacion/invariantes.ts';
import { depurarGlosa } from '../src/glosa.ts';
import type { FilaGeometrica } from '../src/texto-pdf.ts';
import { DESTINOS_BASE } from '../src/adaptadores/toolkit.ts';

// -----------------------------------------------------------------------------
// Las coordenadas, LITERALES de la especificación (§4)
// -----------------------------------------------------------------------------

const X_FECHA = 38.4;
const X_DESCRIPCION = 82.2;
const X_ORIGEN = 224.4;
/** Borde derecho del valor, no borde izquierdo: es cómo el banco alinea los importes. */
const BORDE_CREDITO = 351.9; // ventana medida 351.7–352.1
const BORDE_DEBITO = 465.2; // ventana medida 465.1–465.4
const BORDE_SALDO = 578.6; // ventana medida 578.5–578.8
/** §10: los 9 importes del anexo caen en la ventana de `Saldo`, con borde derecho **582.3**. */
const BORDE_SALDO_DEL_ANEXO = 582.3;
/** §4: la columna `Descripción` termina en `≤ 209.5`. Es lo que decide `conceptoCompleto`. */
const BORDE_DESCRIPCION = 209.5;
/** §9: el pie sale en `x = 35.4`, no en la columna de fecha. */
const X_PIE = 35.4;
/** §8: la línea de totales es la única otra `x` de primer fragmento del cuerpo. */
const X_TOTALES = 286.2;

// -----------------------------------------------------------------------------
// Helpers de fixture — mismo estilo que `multibanco.test.ts`
// -----------------------------------------------------------------------------

type Frag = { readonly texto: string; readonly x: number; readonly ancho?: number };

/** Arma una fila geométrica. `ancho` importa: las columnas de importe se localizan por el borde derecho. */
function fila(fragmentos: readonly Frag[], pagina = 1): FilaGeometrica {
  return {
    pagina,
    y: 0,
    fragmentos: [...fragmentos]
      .map((f) => ({ texto: f.texto, x: f.x, y: 0, ancho: f.ancho ?? f.texto.length * 5 }))
      .sort((a, b) => a.x - b.x),
  };
}

/** Un fragmento cuyo **borde derecho** cae exactamente en `derecha`. */
function enBordeDerecho(texto: string, derecha: number, ancho: number): Frag {
  return { texto, x: derecha - ancho, ancho };
}

/**
 * Le pone al documento la métrica vertical real: `aFilas()` entrega las filas ordenadas por `y`
 * **descendente** dentro de cada página, con ≈9.6 pt de interlineado (§4). El parser no mira la `y` —las
 * filas ya vienen agrupadas— pero un fixture con todas las filas en el mismo baseline describiría un
 * documento imposible.
 */
function documento(filas: readonly FilaGeometrica[]): readonly FilaGeometrica[] {
  const porPagina = new Map<number, number>();
  return filas.map((f) => {
    const n = porPagina.get(f.pagina) ?? 0;
    porPagina.set(f.pagina, n + 1);
    const y = 800 - n * 9.6;
    return { ...f, y, fragmentos: f.fragmentos.map((g) => ({ ...g, y })) };
  });
}

// -----------------------------------------------------------------------------
// El documento sintético
// -----------------------------------------------------------------------------

/**
 * El CBU del fixture. **Inventado**, y con los dos verificadores del CBU (el del 8º dígito y el del 22º)
 * dando mal: no puede ser el CBU de nadie. Es una escalera, igual que los importes.
 *
 * Se arma **por partes y no como un literal de 22 dígitos corridos** a propósito. `tools/barrido-fuga.ts`
 * corre los detectores línea por línea sobre el repo, y un literal así sería un **candidato nuevo** del
 * detector de CBU: en modo CI el barrido falla hasta que alguien cruce ese valor contra el material real y
 * su huella entre en `barrido-aceptados.json`. Partido, el valor que ve el test es el mismo y el barrido no
 * gana un candidato que nadie cruzó. (Agregar la huella a mano sería peor: afirmaría un cruce que no se hizo.)
 */
const CBU_SINTETICO = ['1234567890', '1234567890', '12'].join('');

/**
 * Carátula (§3). Las etiquetas son texto impreso por el banco; los valores, inventados.
 *
 * Cuatro trampas medidas van adentro a propósito:
 *   - el período sale con las dos fechas **pegadas y en orden `[hasta, desde]`**;
 *   - la razón social viaja en la **misma fila** que la etiqueta del CUIT, delante de ella;
 *   - la condición ante IVA comparte fila con la etiqueta siguiente, que arranca en mayúscula;
 *   - la etiqueta del CBU comparte fila con otro título y su valor cae **dos filas más abajo**.
 *
 * `conEtiquetaDeCbu: false` deja el valor y saca **solo la etiqueta**: es el caso que prueba que sin ancla
 * impresa el campo queda ausente en vez de adivinado.
 *
 * `conColumnaVecina: true` agrega un CUARTO fragmento en la fila de la razón social, más a la izquierda
 * que ella — la "columna vecina alfabética" de la quinta cara del error de límites (`09` §1): sin dígitos,
 * así que las guardas de forma no la frenan. Prueba que la fusión de fragmentos se detiene en el hueco
 * geométrico y no sigue absorbiendo hacia la izquierda hasta la columna vecina.
 *
 * `conRazonSocialPartida: true` parte la razón social en DOS fragmentos CONTIGUOS (gap = 0 entre ellos) —
 * la firma geométrica de "el mismo campo cortado por el extractor", medida en Macro (`texto-pdf.ts`: un
 * campo de texto libre puede salir en 1 a 4 fragmentos por fila). Prueba que `leerTitular` los fusiona en
 * vez de quedarse solo con el último.
 */
function caratula(
  opciones: {
    readonly conEtiquetaDeCuit?: boolean;
    readonly conEtiquetaDeCbu?: boolean;
    readonly conColumnaVecina?: boolean;
    readonly conRazonSocialPartida?: boolean;
  } = {},
): FilaGeometrica[] {
  const conCuit = opciones.conEtiquetaDeCuit ?? true;
  const conCbu = opciones.conEtiquetaDeCbu ?? true;
  const conVecina = opciones.conColumnaVecina ?? false;
  const conPartida = opciones.conRazonSocialPartida ?? false;
  return [
    fila([{ texto: 'Resumen de Cuenta Corriente en Pesos', x: 200 }]),
    ...(conCuit
      ? [
          fila([
            // `ancho: 20` explícito: con el default (`texto.length*5`) su borde derecho pisaría X_FECHA y
            // borraría el hueco real que la separa de la razón social — la señal geométrica que el test de
            // "columna vecina" necesita medir.
            ...(conVecina ? [{ texto: 'OTRA COLUMNA', x: 5, ancho: 20 }] : []),
            // Un fragmento en la columna de FECHA que no es una fecha: el autómata no puede abrir acá.
            ...(conPartida
              ? [
                  /**
                   * Dos fragmentos CONTIGUOS: el borde derecho del primero (`X_FECHA + 20*5 = 138.4`) es
                   * exactamente el borde izquierdo del segundo. Gap = 0 — la firma geométrica de un campo
                   * partido por el extractor, no de una columna aparte.
                   */
                  { texto: 'RAZON SOCIAL PARTIDA', x: X_FECHA },
                  { texto: 'EN DOS FRAGMENTOS S.A.', x: X_FECHA + 100 },
                ]
              : [{ texto: 'RAZON SOCIAL SINTETICA S.R.L.', x: X_FECHA }]),
            { texto: 'CUIT del Responsable Impositivo : 30-12345678-9', x: 300 },
          ]),
        ]
      : []),
    fila([
      { texto: 'IVA: Responsable inscripto', x: X_FECHA },
      { texto: 'Cantidad de cotitulares: 2', x: 300 },
    ]),
    fila([{ texto: 'Período de movimientos', x: 300 }]),
    // §3: las dos fechas salen PEGADAS y en orden [hasta, desde].
    fila([{ texto: '30/06/202601/06/2026', x: 300 }]),
    fila([{ texto: 'Saldos', x: 450 }]),
    fila([{ texto: 'Número de cuenta', x: 100 }]),
    fila([{ texto: 'N° 1234567-8 901-2', x: 100 }]),
    /**
     * §3: el CBU va rotulado y su valor sale en una fila **posterior**, que no es necesariamente la
     * inmediata: en la vista geométrica los fragmentos de la carátula salen intercalados (§3.1.3), así que
     * la etiqueta comparte baseline con el título de al lado y entre ella y el valor cae una fila más.
     */
    ...(conCbu ? [fila([{ texto: 'CBU', x: 100 }, { texto: 'Tipo de cuenta', x: 300 }])] : []),
    fila([{ texto: 'Cuenta Corriente en Pesos', x: 300 }]),
    // El valor está SIEMPRE, con etiqueta o sin ella: es lo que hace que el caso sin etiqueta pruebe algo.
    fila([{ texto: CBU_SINTETICO, x: 100 }]),
    ...pie(1, 1),
  ];
}

/** §9: el pie **concatena la paginación con el título**, sin separador. Un patrón con `$` no engancha. */
function pie(pagina: number, numero: number): FilaGeometrica[] {
  return [
    fila([{ texto: `Página ${numero} / 2Resumen de Cuenta Corriente en Pesos`, x: X_PIE }], pagina),
    fila([{ texto: '12345678901234567A', x: X_PIE }], pagina),
  ];
}

/**
 * Los tres movimientos del cuerpo. Cada uno cubre algo distinto:
 *
 * | # | Qué demuestra |
 * |---|---|
 * | 1 | el par `(importe, saldo)` en la **misma fila visual** que la fecha, con continuación **abajo** |
 * | 2 | saldo negativo con el signo **atrás**, importe con el signo **adelante**, `Origen`, concepto truncado |
 * | 3 | **dos fragmentos de glosa**: el corte del concepto no se puede hacer y no se inventa |
 */
function cuerpo(): FilaGeometrica[] {
  return [
    fila([{ texto: 'Fecha Descripción Origen Crédito Débito Saldo', x: X_FECHA }], 2),

    fila(
      [
        { texto: '01/06/26', x: X_FECHA, ancho: 34.1 },
        // Termina en 152.2, muy lejos del borde de la columna: el concepto entró ENTERO.
        { texto: 'ACREDITAMIENTO', x: X_DESCRIPCION, ancho: 70 },
        enBordeDerecho('500,00', BORDE_CREDITO, 30),
        enBordeDerecho('700,00', BORDE_SALDO, 30),
      ],
      2,
    ),
    fila([{ texto: 'DE HABERES SINTETICO', x: X_DESCRIPCION, ancho: 100 }], 2),

    fila(
      [
        { texto: '02/06/26', x: X_FECHA, ancho: 34.1 },
        // Llega EXACTO al borde de la columna (82.2 + 127.3 = 209.5): el banco lo cortó.
        { texto: 'COM. GESTION TRANSF.FDOS', x: X_DESCRIPCION, ancho: BORDE_DESCRIPCION - X_DESCRIPCION },
        { texto: '1234', x: X_ORIGEN, ancho: 19.8 },
        enBordeDerecho('-900,00', BORDE_DEBITO, 36),
        enBordeDerecho('200,00-', BORDE_SALDO, 36),
      ],
      2,
    ),
    fila([{ texto: 'ENTRE BCOS', x: X_DESCRIPCION, ancho: 55 }], 2),

    fila(
      [
        { texto: '03/06/26', x: X_FECHA, ancho: 34.1 },
        { texto: 'TRF INMED PROVEED', x: X_DESCRIPCION, ancho: 88 },
        // Segundo fragmento DENTRO de la banda de la descripción: dónde termina el concepto no está medido.
        { texto: 'SINTETICO', x: 180.0, ancho: 40 },
        enBordeDerecho('300,00', BORDE_CREDITO, 30),
        enBordeDerecho('100,00', BORDE_SALDO, 30),
      ],
      2,
    ),
  ];
}

/** §10: una sola línea, etiqueta `Total`, con el menos **antes del `$`** en el total de débitos. */
function lineaDeTotales(): FilaGeometrica {
  return fila(
    [
      { texto: 'Total', x: X_TOTALES, ancho: 22 },
      enBordeDerecho('$ 800,00', BORDE_CREDITO, 45),
      enBordeDerecho('-$ 900,00', BORDE_DEBITO, 50),
      enBordeDerecho('$ 100,00', BORDE_SALDO, 45),
    ],
    2,
  );
}

/**
 * Los **9 renglones** del `Consolidado de retenciones e impuestos` (§10), con **3 períodos distintos**.
 *
 * En la vista geométrica cada entrada son **dos** filas: el literal por un lado, y el período con su
 * importe compartiendo baseline por el otro. Los conceptos son los que publica el banco (§10): no son datos
 * del cliente, son las etiquetas impresas.
 */
const ENTRADAS_DEL_ANEXO: readonly {
  readonly literal: string;
  readonly desde: string;
  readonly hasta: string;
  readonly importe: string;
}[] = [
  {
    literal: 'TOTAL IMPUESTO I.V.A. SOBRE DEBITOS',
    desde: '01-06-2026',
    hasta: '30-06-2026',
    importe: '4.321,00',
  },
  {
    literal: 'TOTAL RETENCION IMPUESTO LEY 25.413 SOBRE CREDITOS',
    desde: '01-06-2026',
    hasta: '30-06-2026',
    importe: '1.234,56',
  },
  {
    literal: 'TOTAL RETENCION IMPUESTO LEY 25.413 SOBRE DEBITOS',
    desde: '01-06-2026',
    hasta: '30-06-2026',
    importe: '9.876,54',
  },
  {
    literal: 'TOTAL MENSUAL RETENCION IMPUESTO LEY 25.413 SOBRE CREDITOS',
    desde: '01-05-2026',
    hasta: '31-05-2026',
    importe: '765.432,10',
  },
  {
    literal: 'TOTAL MENSUAL RETENCION IMPUESTO LEY 25.413 SOBRE DEBITOS',
    desde: '01-05-2026',
    hasta: '31-05-2026',
    importe: '12.345,67',
  },
  {
    // 🔴 El renglón que NO existe como movimiento y no es derivable de ellos.
    literal: 'TOTAL MENSUAL RETENCION IMPUESTO LEY 25.413 CREDITO COMPUTABLE COMO PAGO A CUENTA',
    desde: '01-05-2026',
    hasta: '31-05-2026',
    importe: '111,11',
  },
  {
    // Fuera de la tabla cerrada: `no_determinada`, que es fail-closed, no un supuesto.
    literal: 'TOTAL CONCEPTO SINTETICO SIN CATALOGAR',
    desde: '01-04-2026',
    hasta: '30-04-2026',
    importe: '222,22',
  },
  {
    literal: 'TOTAL IMPUESTO I.V.A. SOBRE DEBITOS',
    desde: '01-04-2026',
    hasta: '30-04-2026',
    importe: '333,33',
  },
  {
    literal: 'TOTAL RETENCION IMPUESTO LEY 25.413 SOBRE CREDITOS',
    desde: '01-04-2026',
    hasta: '30-04-2026',
    importe: '444,44',
  },
];

/** `literalPrimero` invierte el orden de las dos filas de cada entrada: el apareo no puede depender de él. */
function bloqueDelAnexo(literalPrimero = true): FilaGeometrica[] {
  const filas: FilaGeometrica[] = [
    fila([{ texto: 'Consolidado de retención de impuestos', x: X_DESCRIPCION }], 2),
  ];
  for (const e of ENTRADAS_DEL_ANEXO) {
    const literal = fila([{ texto: e.literal, x: X_DESCRIPCION, ancho: 200 }], 2);
    const periodo = fila(
      [
        {
          texto: `PERIODO COMPRENDIDO ENTRE EL ${e.desde} Y EL ${e.hasta}`,
          x: X_DESCRIPCION,
          ancho: 250,
        },
        enBordeDerecho(e.importe, BORDE_SALDO_DEL_ANEXO, 40),
      ],
      2,
    );
    filas.push(...(literalPrimero ? [literal, periodo] : [periodo, literal]));
  }
  return filas;
}

function documentoBase(
  opciones: {
    readonly conEtiquetaDeCuit?: boolean;
    readonly conEtiquetaDeCbu?: boolean;
    readonly literalPrimero?: boolean;
  } = {},
): readonly FilaGeometrica[] {
  return documento([
    ...caratula(opciones),
    ...cuerpo(),
    lineaDeTotales(),
    ...bloqueDelAnexo(opciones.literalPrimero ?? true),
    ...pie(2, 2),
  ]);
}

function laCuenta(salida: SalidaGalicia): CuentaConMovimientos {
  const c = salida.cuentas[0];
  if (!c) throw new Error('el fixture tiene que producir exactamente una cuenta');
  return c;
}

// -----------------------------------------------------------------------------
describe('reconocimiento', () => {
  it('reconoce el documento por las marcas del banco (§9)', () => {
    expect(reconoceGalicia(documentoBase())).toBe(true);
  });

  it('no reconoce un documento vacío ni uno sin las marcas', () => {
    expect(reconoceGalicia([])).toBe(false);
    expect(reconoceGalicia(documento([fila([{ texto: 'RESUMEN DE OTRO BANCO', x: 100 }])]))).toBe(
      false,
    );
  });
});

// -----------------------------------------------------------------------------
describe('cuerpo: el par (importe, saldo) y las continuaciones', () => {
  const cuenta = laCuenta(leerGalicia(documentoBase()));

  /**
   * §1: el par está en la **misma fila visual** que la fecha —mismo baseline— aunque el content-stream lo
   * emita después. Es la razón por la que el adaptador trabaja sobre `aFilas()` y no sobre líneas.
   */
  it('toma el par de la fila que trae la fecha', () => {
    expect(cuenta.movimientos.map((m) => [m.fecha, m.importe, m.saldo])).toEqual([
      ['2026-06-01', '500.00', '700.00'],
      ['2026-06-02', '-900.00', '-200.00'],
      ['2026-06-03', '300.00', '100.00'],
    ]);
  });

  /**
   * §8: las continuaciones están **abajo**, y cerrar el movimiento al ver el par las dejaba afuera. Esa fue
   * la falla que produjo 326 movimientos con la glosa mutilada y 777 líneas fuera de zona.
   */
  it('absorbe las continuaciones de glosa que están debajo', () => {
    const primero = cuenta.movimientos[0];
    expect(primero?.descripcionLineas).toEqual(['ACREDITAMIENTO', 'DE HABERES SINTETICO']);
    expect(primero?.descripcion).toBe('ACREDITAMIENTO DE HABERES SINTETICO');
    expect(cuenta.movimientos[1]?.descripcion).toBe('COM. GESTION TRANSF.FDOS ENTRE BCOS');
  });

  it('lee la columna Origen aparte de la glosa: fusionarlas destruye el identificador', () => {
    expect(cuenta.movimientos[1]?.referencias).toEqual([{ tipo: 'operacion', valor: '1234' }]);
    expect(cuenta.movimientos[0]?.referencias ?? []).toEqual([]);
  });

  it('reparte crédito y débito por columna, no por signo derivado', () => {
    expect(cuenta.movimientos.map((m) => m.columnaOrigen)).toEqual([
      'credito',
      'debito',
      'credito',
    ]);
    expect(cuenta.movimientos[1]?.debito).toBe('900.00');
    expect(cuenta.movimientos[1]?.credito).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
describe('las tres notaciones de signo del mismo documento (§5)', () => {
  const cuenta = laCuenta(leerGalicia(documentoBase()));

  it('importe con el menos ADELANTE y saldo con el menos ATRÁS', () => {
    const segundo = cuenta.movimientos[1];
    // `-900,00` en la columna de débito y `200,00-` en la de saldo, en la misma fila.
    expect(segundo?.importe).toBe('-900.00');
    expect(segundo?.saldo).toBe('-200.00');
    // La cuenta corriente quedó en descubierto: es lo que las 14 filas negativas del archivo real dicen.
    expect(segundo?.saldoEsAcreedor).toBe(true);
  });

  it('los saldos positivos no se marcan como acreedores', () => {
    expect(cuenta.movimientos.map((m) => m.saldoEsAcreedor)).toEqual([false, true, false]);
  });

  it('la línea Total pone el menos ANTES del `$`, y el débito se publica como magnitud', () => {
    expect(cuenta.cuenta.totalCreditosDeclarado).toBe('800.00');
    // El documento lo imprime `-$ 900,00`; el esquema exige la magnitud.
    expect(cuenta.cuenta.totalDebitosDeclarado).toBe('900.00');
    expect(cuenta.cuenta.saldoFinalDeclarado).toBe('100.00');
  });

  /**
   * La regresión que costó 14 filas: un parser único para las tres notaciones las descartaba en silencio y
   * el análisis contaba 312 en vez de 326. Acá el conteo es chico pero la propiedad es la misma.
   */
  it('ninguna fila se pierde por el signo', () => {
    expect(cuenta.movimientos).toHaveLength(3);
  });
});

// -----------------------------------------------------------------------------
describe('carátula: lo que no tiene etiqueta se deriva, y lo que la tiene se lee por ella', () => {
  const salida = leerGalicia(documentoBase());
  const cuenta = laCuenta(salida);

  /**
   * §3.1: **no existe ninguna etiqueta `Saldo Anterior`**, y los dos importes de la carátula salen sin
   * rótulo y en orden invertido. El saldo inicial se deriva: `saldo(fila 1) − importe(fila 1)`.
   */
  it('deriva el saldo inicial por aritmética, porque no hay etiqueta', () => {
    expect(cuenta.cuenta.saldoInicialDeclarado).toBe('200.00');
  });

  it('toma el período con las dos fechas pegadas y en orden invertido (§3)', () => {
    expect(cuenta.cuenta.periodoDesde).toBe('2026-06-01');
    expect(cuenta.cuenta.periodoHasta).toBe('2026-06-30');
  });

  it('lee el número de cuenta por su etiqueta, en la línea siguiente', () => {
    expect(cuenta.cuenta.numero).toBe('1234567-8 901-2');
  });

  it('lee titular, documento y condición ante IVA por etiqueta', () => {
    expect(cuenta.cuenta.titularDocumento).toBe('30-12345678-9');
    expect(cuenta.cuenta.titular).toBe('RAZON SOCIAL SINTETICA S.R.L.');
    // La etiqueta siguiente comparte fila y arranca en mayúscula: no se la lleva puesta.
    expect(cuenta.cuenta.titularCondicionIva).toBe('Responsable inscripto');
  });

  /**
   * 🔴 La quinta cara del error de límites (`09` §1): una columna vecina alfabética, más a la izquierda
   * que la razón social, en la MISMA fila geométrica. Sin dígitos, así que las guardas de forma no la
   * frenan por sí solas — el límite tiene que venir de la geometría, no del contenido.
   *
   * Prueba por mutación: con `fila.fragmentos.slice(0, indiceEtiqueta).join(' ')` (la versión que junta
   * TODO lo anterior a la etiqueta) esto daría `'OTRA COLUMNA RAZON SOCIAL SINTETICA S.R.L.'`. Con el
   * fragmento inmediatamente anterior, sólo la razón social.
   */
  it('una columna vecina alfabética a la izquierda de la razón social NO se cuela', () => {
    const conVecina = documento([
      ...caratula({ conColumnaVecina: true }),
      ...cuerpo(),
      lineaDeTotales(),
      ...pie(2, 2),
    ]);
    const c = laCuenta(leerGalicia(conVecina));
    expect(c.cuenta.titular).toBe('RAZON SOCIAL SINTETICA S.R.L.');
    expect(c.cuenta.titular).not.toContain('OTRA COLUMNA');
  });

  /**
   * 🔴 Razón social partida en fragmentos geométricos, delante de la etiqueta del CUIT — un campo de texto
   * libre en esa columna puede salir partido en 1 a 4 fragmentos por fila (medido en Macro: 814 de 1346
   * filas en 3 fragmentos; `texto-pdf.ts`). La versión anterior de `leerTitular` tomaba SOLO
   * `fragmentos[indiceEtiqueta - 1]` — el ÚLTIMO fragmento antes de la etiqueta — así que con la razón
   * social partida en dos, el primer pedazo se perdía SIN error y sin campo ausente: un titular incompleto
   * quedaba persistido en silencio.
   *
   * Prueba por mutación: con la implementación anterior esto da `titular === 'EN DOS FRAGMENTOS S.A.'` —
   * `'RAZON SOCIAL PARTIDA'` desaparece sin dejar rastro.
   */
  it('une los fragmentos de la razón social cuando viene partida delante de la etiqueta', () => {
    const partida = documento([
      ...caratula({ conRazonSocialPartida: true }),
      ...cuerpo(),
      lineaDeTotales(),
      ...pie(2, 2),
    ]);
    const c = laCuenta(leerGalicia(partida));
    expect(c.cuenta.titular).toBe('RAZON SOCIAL PARTIDA EN DOS FRAGMENTOS S.A.');
  });

  /**
   * 🔴 El control cruzado que evita que el fix se pase de largo: razón social partida en dos fragmentos Y
   * una columna vecina real, en la MISMA fila. La fusión tiene que juntar los dos fragmentos CONTIGUOS de
   * la razón social (gap = 0) y PARAR ahí — no seguir absorbiendo hacia la izquierda hasta la columna
   * vecina, separada por un hueco real (13.4pt en el fixture, contra 0pt entre los fragmentos de la razón
   * social). Si el fix se implementara como "todo lo que precede a la etiqueta sin dígitos" —el bug
   * original que motivó la quinta cara— este test lo atrapa: daría
   * `'OTRA COLUMNA RAZON SOCIAL PARTIDA EN DOS FRAGMENTOS S.A.'`.
   */
  it('funde la razón social partida sin absorber una columna vecina real en la misma fila', () => {
    const partidaConVecina = documento([
      ...caratula({ conRazonSocialPartida: true, conColumnaVecina: true }),
      ...cuerpo(),
      lineaDeTotales(),
      ...pie(2, 2),
    ]);
    const c = laCuenta(leerGalicia(partidaConVecina));
    expect(c.cuenta.titular).toBe('RAZON SOCIAL PARTIDA EN DOS FRAGMENTOS S.A.');
    expect(c.cuenta.titular).not.toContain('OTRA COLUMNA');
  });

  /**
   * 🔴 **El control que importa: por etiqueta, NUNCA por patrón.**
   *
   * El cuerpo del extracto real tiene 113 corridas de once dígitos que son CUIT de contrapartes. Un lector
   * que busque "el primer CUIT del documento" toma el de un tercero por el del titular, y a partir de ahí
   * el extracto de **otro** cliente valida como propio. Sin la etiqueta, el campo queda **ausente**.
   */
  it('un CUIT en el cuerpo NO se lee como el del titular', () => {
    const conCuitEnLaGlosa = documento([
      ...caratula({ conEtiquetaDeCuit: false }),
      ...cuerpo(),
      fila([{ texto: 'TRANSF DE 30-12345678-9', x: X_DESCRIPCION, ancho: 120 }], 2),
      lineaDeTotales(),
      ...pie(2, 2),
    ]);
    const c = laCuenta(leerGalicia(conCuitEnLaGlosa));

    expect(c.cuenta.titularDocumento).toBeUndefined();
    expect(c.cuenta.titular).toBeUndefined();
    // Y el identificador sigue en la glosa del movimiento, que es de donde `depurarGlosa` lo va a sacar.
    expect(c.movimientos.at(-1)?.descripcion).toContain('30-12345678-9');
  });

  it('el pie concatenado al título no impide leer las páginas declaradas (§9)', () => {
    expect(salida.paginasDeclaradas).toBe(2);
  });
});

// -----------------------------------------------------------------------------
describe('CBU: el identificador primario de INV-6, por etiqueta y en otra fila', () => {
  /**
   * §3: el CBU sale con etiqueta y el valor en una fila posterior. Es el identificador primario de
   * `resolverCuentaDelExtracto` —`cbuDeclarado ?? numeroDeclarado`— así que leerlo es lo que completa el
   * control cruzado con el número de cuenta, no un dato de adorno.
   */
  it('lo lee por su etiqueta aunque el valor esté dos filas más abajo', () => {
    expect(laCuenta(leerGalicia(documentoBase())).cuenta.cbu).toBe(CBU_SINTETICO);
  });

  /**
   * 🔴 **El control que importa, otra vez: por etiqueta, NUNCA por patrón.**
   *
   * Acá el valor está en el documento, con su forma exacta de 22 dígitos, y **la etiqueta no**. Un lector
   * que buscara "la corrida de 22 dígitos del documento" lo encontraría igual — y el día que ese número
   * largo sea de otra cosa, el extracto resuelve contra la cuenta equivocada con todo cuadrando. Sin
   * etiqueta, el campo queda **ausente**: ausente es un dato, un valor plausible del lugar equivocado no.
   */
  it('sin la etiqueta el campo queda AUSENTE, aunque los 22 dígitos estén en el documento', () => {
    const c = laCuenta(leerGalicia(documentoBase({ conEtiquetaDeCbu: false })));

    expect(c.cuenta.cbu).toBeUndefined();
    // Y lo que sí tiene etiqueta se sigue leyendo: la ausencia es del CBU, no del parseo.
    expect(c.cuenta.numero).toBe('1234567-8 901-2');
  });

  /**
   * La etiqueta del CBU está **dentro** de la ventana de `leerNumeroDeCuenta` (3 filas después de
   * `Número de cuenta`), y una fila de 22 dígitos pelados también matchea la forma del número de cuenta.
   * Que cada uno se quede con lo suyo es la propiedad que hace que tener los dos sirva de control cruzado:
   * si colapsaran, habría un solo identificador escrito dos veces.
   */
  it('el número de cuenta y el CBU no se pisan', () => {
    const cuenta = laCuenta(leerGalicia(documentoBase())).cuenta;

    expect(cuenta.numero).toBe('1234567-8 901-2');
    expect(cuenta.cbu).toBe(CBU_SINTETICO);
    expect(cuenta.cbu).not.toBe(cuenta.numero);
  });

  /**
   * Una corrida **más larga** que la publicada no es un CBU con basura al final: es otro número. El patrón
   * lleva `\b` de los dos lados justamente para que no matchee sus primeros 22 dígitos, que sería un CBU
   * plausible e inexistente.
   */
  it('una corrida de 23 dígitos no se recorta a 22', () => {
    const conCorridaLarga = documento([
      fila([{ texto: 'Resumen de Cuenta Corriente en Pesos', x: 200 }]),
      fila([{ texto: '30/06/202601/06/2026', x: 300 }]),
      fila([{ texto: 'CBU', x: 100 }]),
      fila([{ texto: `${CBU_SINTETICO}7`, x: 100 }]),
      ...cuerpo(),
      lineaDeTotales(),
      ...pie(2, 2),
    ]);

    expect(laCuenta(leerGalicia(conCorridaLarga)).cuenta.cbu).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
describe('conceptoBanco: el corte geométrico, y cuándo NO se hace', () => {
  const cuenta = laCuenta(leerGalicia(documentoBase()));

  it('corta el concepto de la fila de la fecha y declara la estrategia', () => {
    expect(cuenta.movimientos[0]?.conceptoBanco).toBe('ACREDITAMIENTO');
    expect(cuenta.movimientos[0]?.conceptoBancoEstrategia).toBe('segmento_de_glosa');
    expect(cuenta.movimientos[1]?.conceptoBanco).toBe('COM. GESTION TRANSF.FDOS');
  });

  /**
   * §8: el concepto se trunca por **ancho de columna** y sigue abajo. `ACREDITAMIENTO` son 78 movimientos
   * de 14 caracteres en el archivo real y no hay forma de saber si están completos mirando el texto: la
   * evidencia es geométrica y no se persiste. Por eso el campo existe.
   */
  it('conceptoCompleto sale del borde derecho contra el borde de la columna (§4)', () => {
    expect(cuenta.movimientos[0]?.conceptoCompleto).toBe(true);
    // Llega exacto a 209.5: el banco lo cortó, y afirmar `true` sería afirmar algo que nadie verificó.
    expect(cuenta.movimientos[1]?.conceptoCompleto).toBe(false);
  });

  /**
   * 🔴 La decisión ya tomada del proyecto: *cuando falta el peldaño mínimo de evidencia → indeterminado,
   * nunca el peldaño siguiente en silencio*. Con dos fragmentos en la columna, dónde termina el concepto y
   * empieza la contraparte no está medido, así que **los tres campos se omiten**.
   */
  it('con dos fragmentos de glosa en la fila no inventa el corte: omite los TRES campos', () => {
    const tercero = cuenta.movimientos[2];
    expect(tercero?.conceptoBanco).toBeUndefined();
    expect(tercero?.conceptoCompleto).toBeUndefined();
    expect(tercero?.conceptoBancoEstrategia).toBeUndefined();
  });

  /**
   * INV-14, la cláusula que `persistirCuenta` verifica y el `check` `mov_crudo_concepto_prefijo_chk`
   * respalda: el concepto tiene que ser prefijo de la descripción **ya depurada**. Se comprueba con la
   * misma función que corre al persistir, no con una aproximación.
   */
  it('INV-14: el concepto es prefijo de la descripción depurada', () => {
    for (const m of cuenta.movimientos) {
      if (m.conceptoBanco === undefined) continue;
      const glosa = depurarGlosa(m.descripcion).descripcion;
      const concepto = depurarGlosa(m.conceptoBanco).descripcion;
      expect(glosa.startsWith(concepto)).toBe(true);
    }
  });

  /**
   * 🔴 `conceptoBanco` **no entra en el material de `hashFila`**. Es producto del parseo: si entrara, el
   * mismo archivo releído con otra versión del adaptador daría otro hash y el lote entero se duplicaría en
   * silencio. Acá se mueve la geometría —lo que cambia `conceptoCompleto`— y los hashes tienen que quedar
   * idénticos.
   */
  it('mover el concepto no mueve el hash', () => {
    const conOtroAncho = documento(
      documentoBase().map((f) => ({
        ...f,
        fragmentos: f.fragmentos.map((g) =>
          g.texto === 'ACREDITAMIENTO' ? { ...g, ancho: BORDE_DESCRIPCION - X_DESCRIPCION } : g,
        ),
      })),
    );
    const otra = laCuenta(leerGalicia(conOtroAncho));

    expect(otra.movimientos[0]?.conceptoCompleto).toBe(false);
    expect(otra.movimientos.map((m) => m.filaHash)).toEqual(
      cuenta.movimientos.map((m) => m.filaHash),
    );
  });

  it('los hashes de la cuenta son únicos y completos', () => {
    const hashes = cuenta.movimientos.map((m) => m.filaHash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const h of hashes) expect(h).toHaveLength(64);
  });
});

// -----------------------------------------------------------------------------
describe('el anexo: los 9 renglones que se estaban perdiendo enteros', () => {
  const cuenta = laCuenta(leerGalicia(documentoBase()));

  it('captura las 9 entradas de §10', () => {
    expect(cuenta.anexos).toHaveLength(9);
    expect(cuenta.anexos.map((a) => a.ordenEnLote)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  /**
   * §10: el bloque cubre **tres períodos distintos** del extracto. Es la razón por la que el sistema NUNCA
   * rellena el período del anexo con el del resumen: sería un hecho fiscal fabricado que además cuadra.
   */
  it('conserva los tres períodos distintos, todos publicados completos', () => {
    const periodos = new Set(cuenta.anexos.map((a) => `${a.periodoDesde ?? ''}..${a.periodoHasta ?? ''}`));
    expect(periodos).toEqual(
      new Set(['2026-06-01..2026-06-30', '2026-05-01..2026-05-31', '2026-04-01..2026-04-30']),
    );
    for (const a of cuenta.anexos) {
      expect(a.periodoDato).toBe('publicado_completo');
      // Y ninguno cayó al período del extracto, que es 01/06–30/06.
      expect(a.periodoDesde).toBeDefined();
    }
    expect(cuenta.anexos.some((a) => a.periodoDesde === '2026-04-01')).toBe(true);
  });

  /**
   * 🔴 `cuenta_unica_del_lote`, y **no** `publicada_por_cuenta`. El banco no dice de qué cuenta es el
   * bloque: lo sabemos porque el archivo tiene una sola. La evidencia es aritmética del lote, y el día que
   * llegue un archivo de dos cuentas la deducción deja de valer.
   */
  it('declara la atribución por la que el bloque es de esta cuenta', () => {
    for (const a of cuenta.anexos) expect(a.atribucionCuenta).toBe('cuenta_unica_del_lote');
  });

  /**
   * 🔴 El renglón del **importe computable como pago a cuenta** es el que no existe como movimiento y no es
   * derivable de ellos: es el único candidato a registración de todo el bloque. Los demás resumen impuestos
   * que ya están en el cuerpo, y lo que no está en la tabla cerrada es `no_determinada` (fail-closed).
   */
  it('clasifica la relación con los movimientos, con el computable aparte', () => {
    const porRelacion = new Map<string, number>();
    for (const a of cuenta.anexos) {
      porRelacion.set(a.relacionConMovimientos, (porRelacion.get(a.relacionConMovimientos) ?? 0) + 1);
    }
    expect(porRelacion.get('resume_movimientos_del_cuerpo')).toBe(7);
    expect(porRelacion.get('no_esta_en_los_movimientos')).toBe(1);
    expect(porRelacion.get('no_determinada')).toBe(1);

    const computable = cuenta.anexos.find(
      (a) => a.relacionConMovimientos === 'no_esta_en_los_movimientos',
    );
    expect(computable?.conceptoLiteral).toContain('CREDITO COMPUTABLE COMO PAGO A CUENTA');
    expect(computable?.importeDeclarado).toBe('111.11');
  });

  it('el literal va tal como lo escribe el banco, sin normalizar, y con su moneda', () => {
    expect(cuenta.anexos[0]?.conceptoLiteral).toBe('TOTAL IMPUESTO I.V.A. SOBRE DEBITOS');
    expect(cuenta.anexos[0]?.importeDeclarado).toBe('4321.00');
    expect(cuenta.anexos[0]?.moneda).toBe('ARS');
    // El bloque publica período, concepto e importe: ninguna tasa. Inventar una sería normativa fabricada.
    expect(cuenta.anexos[0]?.alicuotaPublicada).toBeUndefined();
  });

  /**
   * `pdf.js` emite en orden de content-stream, así que **cuál de las dos filas de la entrada va arriba no
   * es una propiedad del documento**. El apareo tiene que dar lo mismo en las dos orientaciones; cablear
   * una produciría un corrimiento de a uno —cada importe con el rótulo del renglón vecino— que cuadra igual.
   */
  it('aparea igual con el literal arriba que con el literal abajo', () => {
    const invertido = laCuenta(leerGalicia(documentoBase({ literalPrimero: false })));
    expect(invertido.anexos.map((a) => [a.conceptoLiteral, a.importeDeclarado])).toEqual(
      cuenta.anexos.map((a) => [a.conceptoLiteral, a.importeDeclarado]),
    );
  });

  /**
   * 🔴 **PROHIBIDO que el anexo entre en la suma de movimientos.** Si entra, el impuesto queda contado dos
   * veces **y el asiento cuadra igual**, que es la peor clase de error de este dominio. Los 9 importes del
   * anexo caen en la ventana `x` de la columna `Saldo` (§10), así que la tentación es real.
   */
  it('ningún importe del anexo entra en los movimientos ni en sus totales', () => {
    expect(cuenta.movimientos).toHaveLength(3);

    const delAnexo = new Set(cuenta.anexos.map((a) => a.importeDeclarado));
    for (const m of cuenta.movimientos) {
      expect(delAnexo.has(m.importe.replace('-', ''))).toBe(false);
      expect(delAnexo.has(m.saldo?.replace('-', '') ?? '')).toBe(false);
    }

    const v = verificarAritmetica(cuenta, {
      capacidades: CAPACIDADES_GALICIA,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    expect(v.estado).toBe('cuadra');
    expect(v.filasConRuptura).toEqual([]);
    expect(v.totalCreditosCalculado).toBe('800.00');
    expect(v.totalDebitosCalculado).toBe('900.00');
  });

  /**
   * El anexo no puede contarse dos veces: una fila que se volvió un renglón de anexo **no** puede además
   * aparecer en `lineasNoInterpretadas`.
   *
   * 🔴 **Reescrito para A2 (C4).** Antes de instrumentar destinos, las 8 filas de carátula (CBU y número
   * de cuenta incluidos, aunque las dos ya estén leídas por etiqueta) caían en `lineasNoInterpretadas`
   * con el código genérico `linea_fuera_de_zona`, indistinguibles de un renglón que de verdad no se
   * entendió. Con la partición por destino, esa misma rama del autómata (`!abierto`: antes del primer
   * movimiento o después de `Total`) se cuenta en `destinos.fueraDelCuerpo` — el residuo baja de 8 a 0
   * contra este fixture, que es la primicia que A2 busca, no una regresión (predicción del plan, ya
   * confirmada contra el archivo real por auditar).
   */
  it('las filas de carátula quedan en fueraDelCuerpo, no en el residuo', () => {
    const salida = leerGalicia(documentoBase());
    expect(salida.lineasNoInterpretadas).toEqual([]);
    expect(salida.destinos.fueraDelCuerpo).toBe(8);
  });

  /**
   * 🔴 `indice` tiene que ser la posición de la fila **en el documento**, no el contador de movimientos.
   *
   * Este test existe por un bug encontrado en la pasada de coherencia entre los tres bancos: los `push` al
   * residuo escribían `indice: filaNumero`, que es el contador de **movimientos emitidos**. Con la
   * carátula reclasificada a `fueraDelCuerpo` (arriba), ya no produce residuo con el que ejercitar esto —
   * así que el fixture pasa a un residuo **genuino** dentro del cuerpo: una fecha ilegible y un bloque que
   * nunca completa su par, ninguno de los dos precedido por un movimiento que cierre con éxito. Si el bug
   * volviera —cualquiera de los dos `push` usando `filaNumero` en vez de la posición real— `filaNumero`
   * queda en `0` los dos casos (nunca se emite un movimiento en este documento) y las dos aserciones caen:
   * ni distintos ni crecientes.
   */
  it('el índice del residuo es la posición de la fila, no el contador de movimientos', () => {
    const conResiduoGenuino = documento([
      fila([{ texto: 'Resumen de Cuenta Corriente en Pesos', x: 200 }]),
      fila([{ texto: 'Fecha Descripción Origen Crédito Débito Saldo', x: X_FECHA }], 2),
      // Fecha con la FORMA del cuerpo pero inválida como fecha: `parsearFecha` la rechaza.
      fila(
        [
          { texto: '99/99/99', x: X_FECHA, ancho: 34.1 },
          { texto: 'FECHA INVALIDA', x: X_DESCRIPCION, ancho: 60 },
        ],
        2,
      ),
      // Abre un bloque válido que nunca trae su par: cierra como `fila_sin_importe` al llegar `Total`.
      fila(
        [
          { texto: '01/06/26', x: X_FECHA, ancho: 34.1 },
          { texto: 'SIN IMPORTE', x: X_DESCRIPCION, ancho: 60 },
        ],
        2,
      ),
      lineaDeTotales(),
      ...pie(2, 2),
    ]);

    const salida = leerGalicia(conResiduoGenuino);
    expect(salida.lineasNoInterpretadas.map((l) => l.codigo)).toEqual([
      'fecha_ilegible',
      'fila_sin_importe',
    ]);
    const indices = salida.lineasNoInterpretadas.map((l) => l.indice);

    // Distintos: dos filas distintas del documento no pueden compartir posición.
    expect(new Set(indices).size).toBe(indices.length);
    // Y crecientes, porque se recorren en orden de lectura.
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    // Cero movimientos emitidos: si cualquiera de los dos `push` usara `filaNumero`, los dos darían `0`.
    expect(salida.destinos.movimiento).toBe(0);
  });

  it('sin línea de totales no hay anexo: no se sale a buscarlo por el documento entero', () => {
    const sinTotales = documento([
      ...caratula(),
      ...cuerpo(),
      ...bloqueDelAnexo(),
      ...pie(2, 2),
    ]);
    expect(laCuenta(leerGalicia(sinTotales)).anexos).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('parDeColumnas: la migración que estos tests estaban habilitando', () => {
  /**
   * La única diferencia de comportamiento entre la copia local y la función del toolkit: un token en **las
   * dos** columnas devolvía el crédito y ahora devuelve `null`. Sobre el archivo real da idéntico —las 326
   * filas tienen exactamente una columna—, así que la diferencia hay que provocarla.
   *
   * Preferir una de las dos produciría una fila **plausible con la mitad del dato inventado**; sin par, el
   * bloque queda incompleto y se reporta con su código.
   */
  it('un importe en crédito Y en débito deja la fila sin par, no elige una', () => {
    const ambiguo = documento([
      ...caratula(),
      fila([{ texto: 'Fecha Descripción Origen Crédito Débito Saldo', x: X_FECHA }], 2),
      fila(
        [
          { texto: '01/06/26', x: X_FECHA, ancho: 34.1 },
          { texto: 'ACREDITAMIENTO', x: X_DESCRIPCION, ancho: 70 },
          enBordeDerecho('500,00', BORDE_CREDITO, 30),
          enBordeDerecho('500,00', BORDE_DEBITO, 30),
          enBordeDerecho('700,00', BORDE_SALDO, 30),
        ],
        2,
      ),
      ...pie(2, 2),
    ]);

    const salida = leerGalicia(ambiguo);
    expect(salida.cuentas).toEqual([]);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'fila_sin_importe')).toBe(true);
  });

  /**
   * §5.1: el signo del token y la columna son **dos evidencias independientes**. Que coincidan es un
   * control cruzado gratis; que no coincidan es un hallazgo, no algo a resolver por preferencia.
   */
  it('un importe positivo en la columna de débito es un hallazgo, no un débito', () => {
    const signoIncoherente = documento([
      ...caratula(),
      fila([{ texto: 'Fecha Descripción Origen Crédito Débito Saldo', x: X_FECHA }], 2),
      fila(
        [
          { texto: '01/06/26', x: X_FECHA, ancho: 34.1 },
          { texto: 'ACREDITAMIENTO', x: X_DESCRIPCION, ancho: 70 },
          // Sin el menos adelante, en la columna de débito.
          enBordeDerecho('900,00', BORDE_DEBITO, 36),
          enBordeDerecho('200,00-', BORDE_SALDO, 36),
        ],
        2,
      ),
      ...pie(2, 2),
    ]);

    expect(leerGalicia(signoIncoherente).cuentas).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('la salida entera valida contra el esquema', () => {
  /**
   * El guard final: los dos `refine` de `movimientoBancarioCrudoSchema` que atan los tres campos del
   * concepto, y los del anexo que atan las fechas a `periodoDato`. Si el adaptador emitiera `conceptoBanco`
   * sin estrategia, o un `publicado_completo` sin fechas, esto es lo que lo ve.
   */
  it('cuentaConMovimientosSchema acepta la cuenta con sus 9 anexos', () => {
    const r = cuentaConMovimientosSchema.safeParse(laCuenta(leerGalicia(documentoBase())));
    expect(r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual(
      [],
    );
  });
});

// -----------------------------------------------------------------------------
describe('toda fila tiene un DESTINO declarado, y la partición se cuenta (A2, C4)', () => {
  const salida = leerGalicia(documentoBase());
  const { destinos } = salida;

  /**
   * 🔴 `"fuera de la región de tabla"` no es un destino, es una ubicación — y mientras Galicia no lo
   * distinguía, la carátula entera se iba a `lineasNoInterpretadas` sin diferenciar "es carátula" de "es
   * un renglón que no se entendió". `sinDestino` en 0 es lo que convierte *"toda fila está explicada"* en
   * un hecho medido, igual que en `santander.ts`.
   */
  it('la partición cierra: ninguna fila queda sin destino', () => {
    expect(destinos.total).toBe(documentoBase().length);
    expect(destinos.sinDestino).toBe(0);
    // La suma se calcula con `DESTINOS_BASE.reduce`, no a mano: así un octavo destino futuro no rompe
    // silenciosamente este test en un archivo y no en otro (lección de la quinta cara).
    const suma = DESTINOS_BASE.reduce((acc, d) => acc + destinos[d], 0);
    expect(suma).toBe(documentoBase().length);
  });

  it('cada recuento coincide con lo que el lector devolvió: no es una declaración aparte', () => {
    const cuenta = laCuenta(salida);
    expect(destinos.movimiento).toBe(cuenta.movimientos.length);
    expect(destinos.anexo).toBe(cuenta.anexos.length);
    expect(destinos.residuo).toBe(salida.lineasNoInterpretadas.length);
    // La línea `Total`: el único renglón rotulado de la verificación en este banco (§10).
    expect(destinos.saldoDeclarado).toBe(1);
  });

  /**
   * `fueraDelCuerpo` es la carátula: las 8 filas que antes de A2 caían en `lineasNoInterpretadas` con
   * código `linea_fuera_de_zona` (ver el test de arriba, ahora reescrito) — el hallazgo que el plan
   * predecía: **residuo baja de 8 a 0 contra este fixture**, y las 8 quedan contadas, no perdidas ni
   * confundidas con un renglón que no se entendió.
   */
  it('la carátula queda contada, no desaparecida ni confundida con residuo', () => {
    // El recuento entero, exacto. Cualquier fila que cambie de destino se ve acá y no en un promedio.
    expect(destinos).toEqual({
      movimiento: 3,
      continuacion: 11,
      saldoDeclarado: 1,
      ruido: 9,
      anexo: 9,
      fueraDelCuerpo: 8,
      residuo: 0,
      sinDestino: 0,
      total: documentoBase().length,
    });
  });
});
