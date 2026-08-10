/**
 * ADAPTADOR MACRO — el banco multi-cuenta (`docs/diseno/07-formato-macro.md`).
 *
 * Cada bloque de este archivo corresponde a un modo de falla **medido** sobre el archivo real, y todos
 * comparten la misma forma: **producen un resultado plausible y equivocado**. Los importes cuadran, la
 * cadena de saldos cierra, el lote diría `procesado` — y el dato está mal.
 *
 * | Caso | Sin el criterio correcto | Fuente |
 * |---|---|---|
 * | Encabezado repetido | **47 cuentas** en vez de 3, o **1** en vez de 3 | §14.2 |
 * | Trampa de orden de la p2 | el anexo se le cuelga a la cuenta equivocada | §14.2 |
 * | Glosa en 1–4 fragmentos | **1186 de 1346** descripciones truncadas | §7 |
 * | Glosa que desborda a `REFERENCIA` | o se pierde texto, o se inventa una referencia | §7 |
 * | Importe de anexo en la ventana de `SALDO` | **178** falsos saldos, arriba de cada página | §9 |
 * | Consolidado por moneda | la mezcla de cuentas pasa con **0,07 %** de rupturas | §14.4-bis |
 * | Hash sin la cuenta | dos filas idénticas de cuentas distintas **colapsan** | §10 |
 *
 * ⚠️ **Ningún valor de este archivo sale de un extracto real.** Las coordenadas en puntos PDF sí son las
 * medidas —son geometría del formato que imprime el banco, no un dato de nadie— y están publicadas en la
 * especificación. Los importes, las glosas, los números de cuenta y los CBU son inventados.
 */

import { describe, expect, it } from 'vitest';
import type { FilaGeometrica } from '../src/texto-pdf.ts';
import {
  CAPACIDADES_MACRO,
  adaptadorMacro,
  leerMacro,
  reconoceMacro,
} from '../src/adaptadores/macro.ts';
import { ErrorDeAdaptador } from '../src/adaptadores/contrato.ts';
import { hashesDeCuenta, type ClaveCuenta } from '../src/hash.ts';
import { normalizar } from '../src/parseo-ar.ts';
import {
  anexoExtractoSchema,
  cuentaConMovimientosSchema,
  movimientoBancarioCrudoSchema,
} from '../src/esquema.ts';
import {
  verificarAritmetica,
  verificarConsolidadoPorMoneda,
  verificarConteoDeCuentas,
} from '../src/verificacion/invariantes.ts';

// -----------------------------------------------------------------------------
// Fixture: un documento con la geometría LITERAL de la especificación
// -----------------------------------------------------------------------------

type Frag = { readonly texto: string; readonly x: number; readonly ancho?: number };

/**
 * Arma una fila geométrica. El `ancho` importa: las tres columnas de importe se localizan por su **borde
 * derecho**, que es lo único que no se mueve con la cantidad de dígitos.
 */
function fila(fragmentos: readonly Frag[], pagina: number, y: number): FilaGeometrica {
  return {
    pagina,
    y,
    fragmentos: [...fragmentos]
      .map((f) => ({ texto: f.texto, x: f.x, y, ancho: f.ancho ?? f.texto.length * 3 }))
      .sort((a, b) => a.x - b.x),
  };
}

/** Un fragmento cuyo **borde derecho** cae exactamente en `derecha`. */
function enBordeDerecho(texto: string, derecha: number, ancho = 40): Frag {
  return { texto, x: derecha - ancho, ancho };
}

/** Los tres bordes derechos medidos (§3). No se redondean: son la coordenada del valor, no del rótulo. */
const BORDE = { debito: 385.8, credito: 465.6, saldo: 553.8 } as const;
/**
 * Las anclas izquierdas medidas: fecha (§3), primer fragmento de glosa (§7), referencia (§3), rótulo de
 * saldo, bloque del titular (§7), encabezado de sucursal, columna izquierda de la carátula y el cuerpo del
 * anexo. Las últimas tres salen de la medición del residuo: 90 + 45 + 6 de las 141 filas.
 */
const X = {
  fecha: 33.0,
  glosa: 70.8,
  referencia: 264.0,
  rotuloDeSaldo: 96.0,
  titular: 72.0,
  /** El segundo fragmento del nombre, en la fila de abajo del rótulo `Sr(es):` (medido). */
  nombreSegundoFragmento: 93.0,
  /**
   * La columna que **comparte baseline** con el renglón `Sr(es):` del bloque del titular, medida en
   * `x = 360.2`. No es el encabezado de sucursal (ese es el primer fragmento de su fila y vive arriba de
   * `y = 780`): es la que hace que leer el nombre "hasta el final de la fila" se lleve un `(####)` puesto.
   */
  columnaVecina: 360.2,
  /** El CUIT, en la MISMA fila que la razón social y a la derecha (medido). La otra trampa del bloque. */
  cuit: 364.4,
  sucursal: 360.0,
  caratulaIzq: 25.6,
  anexo: 28.8,
} as const;
/** Los dos renglones del encabezado de sucursal viven arriba del corte de 780 (medido: los 90). */
const Y_SUCURSAL = [804.9, 792.8] as const;

/**
 * Los dos espaciados del **mismo** literal, tal como los imprime el banco (§9, trampa 1): dos veces
 * separado y una vez pegado. **No se normalizan**: son dos hechos del documento.
 */
const TOTAL_COBRADO = {
  espaciado: 'TOTAL COBRADO DEL IMP.S/CREDS. Y DEBS. EN CTAS. BANCARIAS',
  pegado: 'TOTAL COBRADO DEL IMP.S/CREDS.Y DEBS.EN CTAS.BANCARIAS',
} as const;

const D409 = 'D. 409/2018 - IMPUESTO LEY 25413 COMPUTABLE CONTRA OTROS TRIBUTOS';

const NRO_USD = '2-000-0000000003-0';
const NRO_ESPECIAL = '1-000-0000000001-0';
const NRO_BANCARIA = '3-000-0000000002-0';

/** La glosa que aparece **idéntica** en dos cuentas distintas: es el caso del hash (§10). */
const GLOSA_REPETIDA = 'GLOSA REPETIDA SINTETICA';

/**
 * El titular de la carátula, **con las formas medidas sobre el archivo real** (§2 de la spec **está mal**
 * en este renglón, ver `RE_CUIT_TITULAR`):
 *
 * ```
 * Aa(aa): AAAAAAA (####) AAAAAAA        x=[72.0  360.2]        ← `Sr(es):` + OTRA columna
 * AAAA A{9} AAA A.A.A.A #{11}           x=[72.0  93.0  364.4]  ← el rótulo es el TERCER fragmento
 * ```
 *
 * O sea: el CUIT son **once dígitos corridos y la fila termina ahí** —la razón social **no viene pegada**—
 * y el nombre vive en el renglón `Sr(es):`, que comparte baseline con una columna que trae un `(####)`.
 *
 * ⚠️ El CUIT es **inventado y con dígito verificador inválido a propósito** (para `30000000000` el
 * verificador correcto es `7`), y la razón social también es inventada. Ningún valor de acá sale de un
 * documento real, y un número que no pasa el verificador no puede corresponder a un contribuyente.
 */
const CUIT_INVENTADO = '30000000000';
const RAZON_SOCIAL_INVENTADA = 'EMPRESA DE PRUEBA CERO SIETE SA';

/**
 * La variante que este banco **no** imprime: documento y razón social pegados en el mismo renglón. Se
 * conserva como caso porque el lector tiene que seguir cubriendo a un banco que sí los pegue — es la razón
 * por la que la guarda de la razón social no se borró, sino que pasó a ser condicional.
 */
const PEGADO_CON_RAZON_SOCIAL = `${CUIT_INVENTADO}${RAZON_SOCIAL_INVENTADA}`;

type Movimiento = {
  readonly fecha: string;
  readonly glosa: readonly Frag[];
  readonly referencia?: string;
  readonly debito?: string;
  readonly credito?: string;
  readonly saldo: string;
};

type Opciones = {
  /** Rompe INV-multicuenta sin tocar ninguna cadena de saldos: el escenario de la cuenta mezclada. */
  readonly consolidadoPesos?: string;
  /** Deja la sectorización sin su par de control: 3 secciones contra 2 `SALDO FINAL` (§14.2). */
  readonly sinSaldoFinalDeLaBancaria?: boolean;
  /**
   * El valor que sigue a la etiqueta `C.U.I.T`, **por página** (§2). `null` omite la fila entera. Permite
   * probar el archivo sin etiqueta, el valor que no arranca con once dígitos, el pegado de otro banco y el
   * archivo con dos documentos distintos entre páginas.
   */
  readonly pegadoPorPagina?: readonly (string | null)[];
  /** Ídem para el renglón `Sr(es):`, que es de donde sale la razón social. `null` omite la fila. */
  readonly razonSocialPorPagina?: readonly (string | null)[];
};

/**
 * Un resumen de dos páginas con las **tres** cuentas del formato medido: una en dólares sin movimientos
 * (§14.6), una especial en pesos y la cuenta corriente bancaria — y el encabezado de la especial repetido
 * en la p2 **antes** de que empiece la nueva, que es la trampa de orden del §14.2.
 */
function documento(opciones: Opciones = {}): readonly FilaGeometrica[] {
  const filas: FilaGeometrica[] = [];
  let pagina = 1;
  let y = 760;

  const linea = (fragmentos: readonly Frag[]): void => {
    filas.push(fila(fragmentos, pagina, y));
    y -= 12;
  };
  const texto = (t: string, x = 20.2): void => linea([{ texto: t, x }]);

  const movimiento = (m: Movimiento): void => {
    const importe =
      m.debito === undefined
        ? enBordeDerecho(m.credito ?? '', BORDE.credito)
        : enBordeDerecho(m.debito, BORDE.debito);
    linea([
      { texto: m.fecha, x: X.fecha },
      ...m.glosa,
      ...(m.referencia === undefined ? [] : [{ texto: m.referencia, x: X.referencia }]),
      importe,
      enBordeDerecho(m.saldo, BORDE.saldo),
    ]);
  };

  /** La carátula, que en este banco se repite en **las 45 páginas** y es del archivo, no de una cuenta. */
  const caratula = (hoja: number, espaciadoRaro: boolean): void => {
    // Leyenda legal: se reconoce por geometría (x ≈ 20.25, y < 120), no por su texto (§8).
    filas.push(fila([{ texto: 'LEYENDA LEGAL SINTETICA DEL PIE', x: 20.3 }], pagina, 100));
    /**
     * El encabezado de la **sucursal**, arriba a la derecha: 2 filas por página, 90 en el archivo real, y
     * las 90 con `y > 780`. Es la mitad del residuo que antes nadie podía clasificar.
     */
    for (const [n, yFijo] of Y_SUCURSAL.entries()) {
      filas.push(fila([{ texto: `ENCABEZADO SINTETICO DE SUCURSAL ${n}`, x: X.sucursal }], pagina, yFijo));
    }
    /** La leyenda de la columna izquierda de la carátula: 45 filas en `x = 25.6`, dos fragmentos. */
    linea([
      { texto: 'Leyenda sintetica', x: X.caratulaIzq },
      { texto: 'de la caratula', x: 90.0 },
    ]);
    texto('Resumen General Periodo del Extracto: 01/11/2025 al 28/11/2025');
    texto(`Saldos consolidados por moneda al 28/11/2025 Hoja Nro.: ${hoja}`);
    linea([
      { texto: 'Saldo Cuentas en PESOS', x: 20.2 },
      enBordeDerecho(opciones.consolidadoPesos ?? '3.000,00', BORDE.saldo),
    ]);
    // 🔴 El mismo literal con **dos espaciados distintos en el mismo archivo** (§9): en una página sale
    // entero y en otra partido, con lo que `textoDeFila` deja un espacio de más adentro de `EE.UU.`.
    linea(
      espaciadoRaro
        ? [
            { texto: 'Saldo Cuentas en DOLARES EE.', x: 20.2 },
            { texto: 'UU.', x: 120.0 },
            enBordeDerecho('0,00', BORDE.saldo),
          ]
        : [
            { texto: 'Saldo Cuentas en DOLARES EE.UU.', x: 20.2 },
            enBordeDerecho('0,00', BORDE.saldo),
          ],
    );
    /**
     * 🔴 **El bloque del titular, con la geometría medida POR FRAGMENTO** — y ya van tres veces que este
     * fixture miente sobre estas dos filas. Vale escrito, porque cada mentira costó una corrida:
     *
     * 1. `texto('C.U.I.T <pegado>')`: un fragmento, rótulo al principio. Un lector anclado con `^` pasaba en
     *    verde y contra el archivo real no enganchaba **ninguna** de las 45.
     * 2. Rótulo corrido, pero **con la razón social pegada detrás** —lo que dice §2 y el documento no hace—:
     *    el documento se leía bien y la guarda de "razón social no vacía" lo tiraba.
     * 3. `Sr(es): <nombre>` en el mismo fragmento: el nombre **no** está al lado de su etiqueta.
     *
     * La forma medida son **dos filas consecutivas y tres columnas**:
     *
     * ```
     * x= 72.0  Sr(es):                     x=360.2  <otra columna, con (####)>
     * x= 72.0  <nombre>  x=93.0 <resto>    x=364.4  C.U.I.T <11 dígitos>
     * ```
     *
     * El rótulo va **solo** en su fragmento y su valor está **abajo**, partido en dos y alineado por `x`. La
     * fila de abajo es además la del CUIT, que es la trampa que este layout invita a comerse.
     */
    const razonSocial =
      opciones.razonSocialPorPagina === undefined
        ? RAZON_SOCIAL_INVENTADA
        : (opciones.razonSocialPorPagina[hoja - 1] ?? null);
    const pegado =
      opciones.pegadoPorPagina === undefined
        ? CUIT_INVENTADO
        : (opciones.pegadoPorPagina[hoja - 1] ?? null);

    if (razonSocial !== null) {
      linea([
        // El rótulo, SOLO en su fragmento — y otra columna en el mismo baseline, con su `(####)`.
        { texto: 'Sr(es):', x: X.titular },
        { texto: 'SUCURSAL SINTETICA (0000) LOCALIDAD', x: X.columnaVecina },
      ]);
    }
    if (razonSocial !== null || pegado !== null) {
      /** El nombre, en **dos** fragmentos: cortar por fragmento devolvería la primera palabra sola. */
      const [primera = '', ...resto] = (razonSocial ?? '').split(' ');
      linea([
        ...(razonSocial === null
          ? []
          : [
              { texto: primera, x: X.titular },
              { texto: resto.join(' '), x: X.nombreSegundoFragmento },
            ]),
        /**
         * En la p2 el valor va **pegado al rótulo, sin espacio**: las dos grafías del separador conviven,
         * con el mismo documento en las dos, como el banco ya hace con `Saldo Cuentas en DOLARES EE.UU.`.
         */
        ...(pegado === null
          ? []
          : [{ texto: hoja === 1 ? `C.U.I.T ${pegado}` : `C.U.I.T${pegado}`, x: X.cuit }]),
      ]);
    }
    texto('DOMICILIO SINTETICO 1234 - LOCALIDAD DE PRUEBA', X.titular);
  };

  /** Los cuatro renglones que abren (o **reabren**) una sección de cuenta (§14.2). */
  const encabezadoDeCuenta = (titulo: string, numero: string, cbu: string): void => {
    texto(`${titulo} NRO.: ${numero}`);
    texto(`Clave Bancaria Uniforme para Debito Directo: ${cbu}`);
    texto('DETALLE DE MOVIMIENTO');
    texto('FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO');
  };

  const saldoUltimo = (importe: string): void =>
    linea([
      { texto: 'SALDO ULTIMO EXTRACTO AL 31/10/2025', x: X.rotuloDeSaldo },
      enBordeDerecho(importe, BORDE.saldo),
    ]);

  const saldoFinal = (importe: string): void =>
    linea([
      { texto: 'SALDO FINAL AL DIA 28/11/2025', x: X.rotuloDeSaldo },
      enBordeDerecho(importe, BORDE.saldo),
    ]);

  /**
   * `TOTAL COBRADO …` — el renglón que **resume movimientos del cuerpo** (§5): coincide con
   * `Σ(débito − crédito)` de los movimientos cuya glosa contiene `25413`. Su importe viene **inline**, en
   * la ventana de `SALDO`.
   */
  const anexo = (literal: string, importe: string): void =>
    linea([
      { texto: `${literal} DEL PERIODO 01/11/2025 AL 28/11/2025`, x: X.anexo },
      enBordeDerecho(importe, BORDE.saldo),
    ]);

  /** `D. 409/2018 …` con las dos fechas y **sin importe**: su `(S.E.U.O.) <IMP>` llega después. */
  const d409ConCola = (): void => texto(`${D409} DEL PERIODO 01/11/2025 AL 28/11/2025`, X.anexo);

  /** La cola. En el archivo real una de ellas cae en la página siguiente, tras el encabezado repetido. */
  const cola = (importe: string): void =>
    linea([{ texto: '(S.E.U.O.)', x: X.anexo }, enBordeDerecho(importe, BORDE.saldo)]);

  /**
   * 🔴 La variante **inline y SIN fecha de inicio** (§9, trampa 2): `DEL PERIODO AL <F4>`. Es el único
   * caso medido de `publicado_solo_hasta`, y la razón por la que `periodoDesde` dejó de ser obligatorio.
   */
  const d409SoloHasta = (importe: string): void =>
    linea([
      { texto: `${D409} DEL PERIODO AL 28/11/2025 (S.E.U.O.)`, x: X.anexo },
      enBordeDerecho(importe, BORDE.saldo),
    ]);

  /** La leyenda del anexo, que ocupa **dos** filas: la segunda no tiene literal propio (§9). */
  const leyendaDelAnexo = (): void => {
    texto('ESTIMADO CLIENTE, TENGA EN CUENTA QUE UD. PUDIERA ESTAR ALCANZADO', X.anexo);
    texto('SEGUNDA LINEA SINTETICA DE LA MISMA LEYENDA', X.anexo);
  };

  // ---------------------------------------------------------------- página 1
  caratula(1, true);
  /**
   * La tabla de cuentas de la p1 (§8): título, **tres** filas de datos y la regla de subrayado que la
   * cierra. No se parsea —trampa 17: en la fila de la cuenta en dólares el banco emite `MONEDA` y `CUENTA`
   * en un único fragmento— pero **sí se explica**: sus filas tienen destino declarado y no van al residuo.
   */
  texto('TIPO CUENTA SUCURSAL MONEDA CUENTA CBU');
  texto('CTA CTE ESP 001 DOLARES 2-000-0000000003-0 2850000-1-0000000000003-1', X.anexo);
  texto('CTA CTE ESP 001 PESOS 1-000-0000000001-0 2850000-1-0000000000001-1', X.anexo);
  texto('CTA CTE 001 PESOS 3-000-0000000002-0 2850000-1-0000000000002-1', X.anexo);
  texto('_'.repeat(125), X.anexo);

  // La única fila del fixture que NINGUNA regla explica. Es lo que mantiene viva la tercera regla del
  // contrato: si el residuo fuera siempre cero, el test no probaría que se reporta, probaría que no pasa.
  texto('FILA SINTETICA QUE NINGUNA REGLA EXPLICA', 150.0);

  encabezadoDeCuenta('CUENTA CORRIENTE ESPECIAL EN DOLARES', NRO_USD, '2850000-1-0000000000003-1');
  saldoUltimo('0,00');
  saldoFinal('0,00');
  // El `TOTAL COBRADO` de la cuenta en dólares: el banco lo imprime en su sección, en la misma columna
  // en la que alinea sus saldos. Su moneda es la de la sección, no `ARS` por defecto (§14.6).
  anexo(TOTAL_COBRADO.espaciado, '5,00');
  texto('- - - - - - - - - - - -');

  encabezadoDeCuenta('CUENTA CORRIENTE ESPECIAL EN PESOS', NRO_ESPECIAL, '2850000-1-0000000000001-1');
  saldoUltimo('1.000,00');
  movimiento({
    fecha: '03/11/25',
    glosa: [{ texto: GLOSA_REPETIDA, x: X.glosa }],
    referencia: '0',
    credito: '500,00',
    saldo: '1.500,00',
  });
  saldoFinal('1.500,00');
  anexo(TOTAL_COBRADO.espaciado, '12,00');
  // 🔴 El `D. 409/2018` que **cruza el corte de página**: la etiqueta acá, su `(S.E.U.O.) <IMP>` en la p2
  // y **después** del encabezado de cuenta repetido. Es el único elemento del documento que se parte.
  d409ConCola();

  // ---------------------------------------------------------------- página 2
  pagina = 2;
  y = 760;
  caratula(2, false);

  // 🔴 LA TRAMPA DE ORDEN (§14.2): primero se **repite** el encabezado de la cuenta que venía, para
  // colgarle la cola de su anexo, y **después** empieza la nueva.
  encabezadoDeCuenta('CUENTA CORRIENTE ESPECIAL EN PESOS', NRO_ESPECIAL, '2850000-1-0000000000001-1');
  cola('3,00'); // ← la cola del `D. 409/2018` de la p1, no de nada de esta página.
  // El segundo `D. 409/2018`, con su cola en la MISMA página: es el orden real de la p2 del archivo.
  d409ConCola();
  cola('9,00');
  leyendaDelAnexo();
  texto('- - - - - - - - - - - -');

  encabezadoDeCuenta('CUENTA CORRIENTE BANCARIA', NRO_BANCARIA, '2850000-1-0000000000002-1');
  // 44 filas del archivo real: el segundo importe cae **exactamente** en el borde de `SALDO` (§9).
  linea([
    { texto: 'Tasa Nom. Anual: 1,00 Tasa Efec. Anual:', x: 20.2 },
    enBordeDerecho('2,00', BORDE.saldo),
  ]);
  saldoUltimo('9.000,00');

  // Fuera del período declarado (§6) y con la glosa en **cuatro** fragmentos (§7).
  movimiento({
    fecha: '20/10/25',
    glosa: [
      { texto: 'CUATRO', x: X.glosa },
      { texto: 'FRAGMENTOS DE', x: 110.0 },
      { texto: 'GLOSA', x: 160.0 },
      { texto: 'SINTETICA', x: 210.0 },
    ],
    referencia: '9876543',
    debito: '500,00',
    saldo: '8.500,00',
  });
  // Glosa que **desborda** hacia `REFERENCIA` (borde derecho 297.6) y, como las 113 medidas, sin referencia.
  movimiento({
    fecha: '03/11/25',
    glosa: [
      { texto: 'GLOSA QUE', x: X.glosa },
      { texto: 'DESBORDA A LA REFERENCIA', x: 240.0, ancho: 57.6 },
    ],
    debito: '9.000,00',
    saldo: '-500,00',
  });
  movimiento({
    fecha: '03/11/25',
    glosa: [{ texto: 'TPUSH NOMBRE SINTETICO DE UN TERCERO', x: X.glosa }],
    referencia: '12',
    credito: '1.500,00',
    saldo: '1.000,00',
  });
  // 🔴 Idéntico al único movimiento de la cuenta especial: misma fecha, mismo importe, **mismo saldo** y
  // misma glosa. Es el par que colapsa si la cuenta no entra en el material del hash (§10).
  movimiento({
    fecha: '03/11/25',
    glosa: [{ texto: GLOSA_REPETIDA, x: X.glosa }],
    referencia: '0',
    credito: '500,00',
    saldo: '1.500,00',
  });
  /**
   * 🔴 **Las dos etiquetas que el vocabulario tenía y no podía capturar.** El banco imprime
   * `CREDIN:<token>-<n>` y `TRANSF:<token>-<n>` **sin espacio después de los dos puntos**, y el ancla les
   * agregaba uno: en el archivo real eso dejó **84 movimientos sin concepto**, con todo lo demás en verde.
   */
  movimiento({
    fecha: '03/11/25',
    glosa: [{ texto: 'CREDIN:TOKENSINTETICO-34', x: X.glosa }],
    credito: '100,00',
    saldo: '1.600,00',
  });
  movimiento({
    fecha: '03/11/25',
    glosa: [{ texto: 'TRANSF:OTROTOKEN-12', x: X.glosa }],
    debito: '100,00',
    saldo: '1.500,00',
  });
  if (opciones.sinSaldoFinalDeLaBancaria !== true) saldoFinal('1.500,00');
  // 🔴 La SEGUNDA grafía del mismo literal (§9, trampa 1): con igualdad exacta se capturan 2 de 3.
  anexo(TOTAL_COBRADO.pegado, '34,00');
  // Y el tercero: inline, con `DEL PERIODO AL <F4>` y **sin fecha de inicio**.
  d409SoloHasta('7,00');
  leyendaDelAnexo();

  return filas;
}

const leido = leerMacro(documento());
const [ctaUsd, ctaEspecial, ctaBancaria] = leido.cuentas;

// -----------------------------------------------------------------------------
describe('capacidades: cada una con la sección que la respalda', () => {
  it('declara lo que el banco publica y lo que NO', () => {
    expect(CAPACIDADES_MACRO).toMatchObject({
      // §2.2 y §9: no hay línea `Total`, ni por cuenta ni del archivo.
      traeTotalesDeclarados: false,
      // §2.2: `SALDO ULTIMO EXTRACTO AL`, con etiqueta real y no derivado por aritmética.
      traeSaldoInicialDeclarado: true,
      // §4.1: 0 de 1346 tokens con signo. La columna es la única evidencia.
      traeSignoEnElImporte: false,
      // §14.1: tres cuentas en un archivo — el primero del roster.
      multiCuenta: true,
      // §14.6: declarado y NO ejercitado; la cuenta en dólares tiene cero movimientos.
      multiMoneda: true,
      // §6: 4 movimientos de octubre en un resumen de noviembre. La invariante universal es FALSA acá.
      traeMovimientosFueraDelPeriodo: true,
      // §14.4-bis: la entrada del único control que ve una mezcla de cuentas.
      traeConsolidadoPorMoneda: true,
      cadenaDeSaldos: 'completa',
    });
  });

  it('reconoce el documento por la carátula, y no reconoce cualquier PDF', () => {
    expect(reconoceMacro(documento())).toBe(true);
    expect(reconoceMacro([fila([{ texto: 'OTRO BANCO', x: 20.2 }], 1, 700)])).toBe(false);
    expect(adaptadorMacro.bancoCodigo).toBe('macro');
  });

  it('§1: no declara páginas — el pie dice `Hoja Nro.` SIN total', () => {
    // Devolver acá la cantidad de páginas leídas volvería `EST_PAGINAS_DECLARADAS_NO_COINCIDEN` una
    // comparación de un número consigo mismo.
    expect(leido.paginasDeclaradas).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
describe('§14.2 — la sectorización: el encabezado repetido NO crea una cuenta nueva', () => {
  it('cuatro encabezados de cuenta dan TRES cuentas', () => {
    const encabezados = documento().filter((f) =>
      f.fragmentos.some((g) => / NRO\.: \d-\d{3}-\d{10}-\d$/.test(g.texto)),
    );
    // El fixture repite el de la cuenta especial, igual que el archivo real repite los suyos 47 veces.
    expect(encabezados).toHaveLength(4);
    expect(leido.cuentas).toHaveLength(3);
    expect(leido.cuentas.map((c) => c.cuenta.numero)).toEqual([
      NRO_USD,
      NRO_ESPECIAL,
      NRO_BANCARIA,
    ]);
  });

  /**
   * La clave es **el número**, nunca la denominación: en el archivo real la denominación se repite entre
   * cuentas y no distingue nada. Acá las dos cuentas especiales comparten las tres primeras palabras.
   */
  it('el tipo y la moneda salen del TÍTULO de la sección, no de la tabla de cuentas de la p1', () => {
    expect(ctaUsd?.cuenta.moneda).toBe('USD');
    expect(ctaUsd?.cuenta.tipoCuenta).toBe('cuenta_corriente_especial');
    expect(ctaEspecial?.cuenta.moneda).toBe('ARS');
    expect(ctaEspecial?.cuenta.tipoCuenta).toBe('cuenta_corriente_especial');
    // §14.1: el título de la tercera cuenta NO nombra la moneda y la cuenta es en pesos.
    expect(ctaBancaria?.cuenta.denominacion).toBe('CUENTA CORRIENTE BANCARIA');
    expect(ctaBancaria?.cuenta.moneda).toBe('ARS');
    expect(ctaBancaria?.cuenta.tipoCuenta).toBe('cuenta_corriente');
  });

  /**
   * 🔴 **La trampa de orden de la p2.** Primero se repite el encabezado de la cuenta que venía —para
   * colgarle la cola de su anexo, que cruza el corte de página— y recién después empieza la nueva. Un
   * autómata que cierre la sección al ver cualquier encabezado le atribuye esas filas a la cuenta
   * equivocada.
   */
  it('la cola del anexo de la p2 no se le cuelga a la cuenta nueva ni le corre los saldos', () => {
    expect(ctaEspecial?.cuenta.saldoInicialDeclarado).toBe('1000.00');
    expect(ctaEspecial?.cuenta.saldoFinalDeclarado).toBe('1500.00');
    // Y la cuenta que empieza DESPUÉS arranca con su propio saldo, no con el `3,00` de la cola del anexo.
    expect(ctaBancaria?.cuenta.saldoInicialDeclarado).toBe('9000.00');
    expect(ctaBancaria?.cuenta.saldoFinalDeclarado).toBe('1500.00');
  });

  /**
   * §14.2: **el par `SALDO ULTIMO` / `SALDO FINAL` es la verificación de que el conteo de cuentas dio
   * bien** — y se cuenta desde un literal **distinto** del que sectorizó, si no es preguntarle al
   * adaptador lo mismo dos veces. El cruce lo hace el pipeline, no el adaptador.
   */
  it('declara cuántas cuentas trae el documento, contadas desde OTRO literal', () => {
    expect(leido.cuentasDeclaradas).toBe(3);
    expect(verificarConteoDeCuentas(leido.cuentas.length, leido.cuentasDeclaradas)).toEqual([]);
  });

  /**
   * El control que ve una cuenta que **nunca se abrió**: si su saldo final es `0,00` —el caso real de la
   * cuenta en dólares— perderla no mueve el consolidado ni rompe ninguna cadena.
   */
  it('si se perdiera una cuenta, el cruce contra lo declarado la delata', () => {
    expect(verificarConteoDeCuentas(2, leido.cuentasDeclaradas)).toContainEqual(
      expect.objectContaining({ codigo: 'EST_CUENTAS_NO_COINCIDEN', severidad: 'error' }),
    );
  });

  it('si los dos literales del documento se contradicen, falla con código y sin línea', () => {
    expect(() => leerMacro(documento({ sinSaldoFinalDeLaBancaria: true }))).toThrow(ErrorDeAdaptador);
    try {
      leerMacro(documento({ sinSaldoFinalDeLaBancaria: true }));
      expect.unreachable('tenía que fallar');
    } catch (e) {
      expect((e as ErrorDeAdaptador).codigo).toBe('layout_inesperado');
      // El error no lleva ni una línea del documento: solo el código.
      expect((e as ErrorDeAdaptador).formaDeLaLinea).toBeUndefined();
    }
  });

  it('un documento sin encabezados de cuenta no inventa ninguna, ni declara un conteo', () => {
    const r = leerMacro([fila([{ texto: 'CUALQUIER COSA', x: 20.2 }], 1, 700)]);
    expect(r.cuentas).toEqual([]);
    // `undefined` es "no hay qué comparar", que no es lo mismo que "coincide".
    expect(r.cuentasDeclaradas).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
describe('§14.6 — la cuenta en dólares tiene CERO movimientos y es legítima', () => {
  it('se emite igual, con sus dos saldos en cero', () => {
    // Borrarla se llevaría puesta la única cuenta de su moneda, y con ella el consolidado en dólares
    // se quedaría sin nada contra qué compararse.
    expect(ctaUsd?.movimientos).toHaveLength(0);
    expect(ctaUsd?.cuenta.saldoInicialDeclarado).toBe('0.00');
    expect(ctaUsd?.cuenta.saldoFinalDeclarado).toBe('0.00');
  });

  it('no se supone nada sobre cotización', () => {
    expect(leido.cuentas.every((c) => c.movimientos.every((m) => m.cotizacionProvista === false))).toBe(
      true,
    );
  });
});

// -----------------------------------------------------------------------------
describe('§7 — la glosa: 1 a 4 fragmentos, sin truncar, sin comerse la referencia', () => {
  const b1 = () => ctaBancaria?.movimientos[0];
  const b2 = () => ctaBancaria?.movimientos[1];

  /**
   * El caso más caro del formato: `fragmentoEnX` devuelve **uno solo** y dejaría 1186 de 1346
   * descripciones mutiladas, con todos los importes correctos. Nadie las vuelve a mirar.
   */
  it('une los CUATRO fragmentos de la glosa', () => {
    expect(b1()?.descripcion).toBe('CUATRO FRAGMENTOS DE GLOSA SINTETICA');
    expect(b1()?.descripcionLineas).toEqual(['CUATRO FRAGMENTOS DE GLOSA SINTETICA']);
  });

  /**
   * Los 113 movimientos cuya glosa **invade visualmente** `REFERENCIA` (hasta `x = 297.6`). De esos 113,
   * **cero** tienen referencia: el banco solo deja desbordar cuando la celda está vacía.
   */
  it('la glosa que desborda a REFERENCIA entra ENTERA y no inventa una referencia', () => {
    expect(b2()?.descripcion).toBe('GLOSA QUE DESBORDA A LA REFERENCIA');
    expect(b2()?.referencias).toEqual([]);
    expect(b2()?.referenciaExterna).toBeUndefined();
  });

  it('la referencia se lee de `x = 264.0` exacto y se publica como referencia de operación', () => {
    expect(b1()?.referencias).toEqual([{ tipo: 'operacion', valor: '9876543' }]);
    expect(b1()?.referenciaExterna).toBe('9876543');
  });

  /** §7: no hay continuaciones. Un movimiento es exactamente una fila. */
  it('no arma continuaciones: una fila, una descripción', () => {
    expect(
      leido.cuentas.every((c) => c.movimientos.every((m) => m.descripcionLineas.length === 1)),
    ).toBe(true);
  });

});

// -----------------------------------------------------------------------------
describe('§12 e INV-14 — el concepto sale de una lista CERRADA y anclada', () => {
  /**
   * 🔴 Es lo que sostiene que `conceptoBanco` sea **N2 y no N2-R**. En este archivo `TPUSH <nombre>` y
   * `TRANSF <nombre>` son el 73 % de las filas: un corte "lo que no reconozco es concepto" se lleva el
   * nombre —y el `DOC<11 dígitos>` del vocabulario— a una columna que después se lee sin auditar.
   */
  it('captura el prefijo del vocabulario, NUNCA el nombre que viene detrás', () => {
    const conTpush = ctaBancaria?.movimientos[2];
    expect(conTpush?.descripcion).toBe('TPUSH NOMBRE SINTETICO DE UN TERCERO');
    expect(conTpush?.conceptoBanco).toBe('TPUSH');
    expect(conTpush?.conceptoBancoEstrategia).toBe('prefijo_anclado');
    // §7: la glosa de este banco NO se trunca a ancho fijo, así que la etiqueta entró entera.
    expect(conTpush?.conceptoCompleto).toBe(true);
  });

  /** Sin fallback: una glosa fuera del vocabulario medido **no** produce concepto. */
  it('una glosa que no está en el vocabulario no captura concepto, y omite los tres campos', () => {
    const sinConcepto = ctaBancaria?.movimientos[0];
    expect(sinConcepto?.descripcion).toBe('CUATRO FRAGMENTOS DE GLOSA SINTETICA');
    expect(sinConcepto?.conceptoBanco).toBeUndefined();
    expect(sinConcepto?.conceptoCompleto).toBeUndefined();
    expect(sinConcepto?.conceptoBancoEstrategia).toBeUndefined();
  });

  /** INV-14: `conceptoBanco` tiene que ser **prefijo de `descripcion`**; hay un `check` en la base. */
  it('todo concepto capturado es prefijo de su descripción, normalizado', () => {
    for (const m of leido.cuentas.flatMap((c) => c.movimientos)) {
      if (m.conceptoBanco === undefined) continue;
      expect(normalizar(m.descripcion).startsWith(normalizar(m.conceptoBanco))).toBe(true);
    }
  });

  /**
   * La sanción del esquema, corrida sobre **todo** lo que produce el adaptador: los `refine` de
   * `conceptoBanco`/`conceptoCompleto`/`conceptoBancoEstrategia` y el de `importe` contra su columna.
   */
  it('cada movimiento producido valida contra el esquema Zod', () => {
    for (const m of leido.cuentas.flatMap((c) => c.movimientos)) {
      expect(() => movimientoBancarioCrudoSchema.parse(m)).not.toThrow();
    }
    for (const cuenta of leido.cuentas) {
      expect(() => cuentaConMovimientosSchema.parse(cuenta)).not.toThrow();
    }
  });

  it('cada movimiento lleva su página, que ahora se persiste', () => {
    expect(ctaEspecial?.movimientos[0]?.paginaPdf).toBe(1);
    expect(ctaBancaria?.movimientos.map((m) => m.paginaPdf)).toEqual([2, 2, 2, 2, 2, 2]);
  });

  /**
   * 🔴 **Dónde corta el vocabulario, que es distinto de qué literales tiene.**
   *
   * `TRANSF:` y `CREDIN:` **estaban en la lista** y no capturaban nada: el ancla les agregaba un espacio
   * final y el banco imprime `TRANSF:<token>-<n>` **pegado**. Medido sobre el archivo real: **84
   * movimientos** sin concepto, con la glosa completa, los importes correctos, la cadena cerrando y el
   * lote en verde. Es el modo de falla que ninguna aritmética detecta.
   */
  it('las etiquetas que terminan en un separador NO exigen un espacio detrás', () => {
    const credin = ctaBancaria?.movimientos[4];
    expect(credin?.descripcion).toBe('CREDIN:TOKENSINTETICO-34');
    expect(credin?.conceptoBanco).toBe('CREDIN:');

    const transf = ctaBancaria?.movimientos[5];
    expect(transf?.descripcion).toBe('TRANSF:OTROTOKEN-12');
    expect(transf?.conceptoBanco).toBe('TRANSF:');
  });

  /**
   * Y la contraprueba de que aflojar el ancla no aflojó el `contains`: `TPUSH` **sigue** exigiendo el
   * espacio, porque termina en letra. Sin eso, la trampa 18 vuelve por la ventana.
   */
  it('las etiquetas que terminan en letra SIGUEN exigiendo el espacio', () => {
    const pegada = leerMacro([
      ...documento(),
      fila(
        [
          { texto: '03/11/25', x: X.fecha },
          { texto: 'TPUSHERIA SINTETICA', x: X.glosa },
          enBordeDerecho('1,00', BORDE.credito),
          enBordeDerecho('1,00', BORDE.saldo),
        ],
        2,
        50,
      ),
    ]);
    const glosas = pegada.cuentas.flatMap((c) => c.movimientos);
    const sospechosa = glosas.find((m) => m.descripcion === 'TPUSHERIA SINTETICA');
    // Puede no entrar como movimiento (está fuera de la región de tabla); lo que NO puede es entrar
    // como movimiento CON concepto `TPUSH`.
    expect(sospechosa?.conceptoBanco).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
describe('§4 y §9 — el signo lo dice la columna, y el saldo solo se lee de un movimiento', () => {
  it('el débito sale negativo y el crédito positivo, sin signo en el token', () => {
    const b1 = ctaBancaria?.movimientos[0];
    expect(b1).toMatchObject({ columnaOrigen: 'debito', debito: '500.00', importe: '-500.00' });
    expect(b1?.credito).toBeUndefined();

    const b3 = ctaBancaria?.movimientos[2];
    expect(b3).toMatchObject({ columnaOrigen: 'credito', credito: '1500.00', importe: '1500.00' });
  });

  /** §4: el menos va **ADELANTE** en el saldo — al revés del primer banco del roster. */
  it('lee el saldo negativo con el menos adelante y lo marca acreedor', () => {
    expect(ctaBancaria?.movimientos[1]).toMatchObject({ saldo: '-500.00', saldoEsAcreedor: true });
    expect(ctaBancaria?.movimientos[0]?.saldoEsAcreedor).toBe(false);
  });

  /**
   * 🔴 **El caso de los 178 importes de fuera de la tabla** (§9): `Tasa Efec. Anual`, `Saldo Cuentas en …`,
   * `(S.E.U.O.)` y los saldos rotulados caen todos en la ventana de `SALDO`, con el borde derecho
   * **idéntico** (553.8) al del cuerpo. El criterio que funciona: un saldo se lee **solo** de una fila que
   * ya se reconoció como movimiento.
   */
  it('ningún importe de fuera de la tabla entra como movimiento ni como saldo', () => {
    const movimientos = leido.cuentas.flatMap((c) => c.movimientos);
    expect(movimientos).toHaveLength(7);
    // `(S.E.U.O.) 3,00`, `Tasa Efec. Anual 2,00`, el consolidado `3.000,00` y el anexo `12,00`/`34,00`.
    const saldos = movimientos.map((m) => m.saldo);
    for (const intruso of ['3.00', '2.00', '3000.00', '12.00', '34.00']) {
      expect(saldos).not.toContain(intruso);
    }
  });

  it('la cadena de saldos de cada cuenta cierra: 0 rupturas POR CUENTA', () => {
    for (const cuenta of leido.cuentas) {
      const v = verificarAritmetica(cuenta, {
        capacidades: CAPACIDADES_MACRO,
        movimientosEnElLote: 7,
      });
      expect(v.filasConRuptura, `cuenta ${cuenta.cuenta.numero ?? ''}`).toEqual([]);
      expect(v.diferencias.filter((d) => d.severidad === 'error')).toEqual([]);
    }
  });

  /**
   * §6: la validación "toda fecha cae dentro del período" es **falsa en este banco**. El hecho se reporta
   * igual —`fechasDentroDelPeriodo` sigue diciendo la verdad— pero como observación, no como error.
   */
  it('los movimientos con fecha fuera del período se reportan como OBSERVACIÓN, no como error', () => {
    const cuenta = ctaBancaria;
    if (!cuenta) throw new Error('el fixture no armó la cuenta corriente bancaria');
    const v = verificarAritmetica(cuenta, {
      capacidades: CAPACIDADES_MACRO,
      movimientosEnElLote: 7,
    });
    expect(cuenta.movimientos[0]?.fecha).toBe('2025-10-20');
    expect(v.fechasDentroDelPeriodo).toBe(false);
    expect(v.diferencias).toContainEqual(
      expect.objectContaining({ codigo: 'EST_FECHA_FUERA_DE_PERIODO', severidad: 'observacion' }),
    );
    expect(v.estado).toBe('cuadra');
  });
});

// -----------------------------------------------------------------------------
describe('§14.3 — qué es del archivo y qué de la cuenta', () => {
  it('el período es del archivo y el cierre de cada cuenta sale de su `SALDO FINAL AL DIA`', () => {
    for (const cuenta of leido.cuentas) {
      expect(cuenta.cuenta.periodoDesde).toBe('2025-11-01');
      expect(cuenta.cuenta.periodoHasta).toBe('2025-11-28');
    }
  });

  /**
   * §2.3: `extraerPeriodo` sirve **anclado en la etiqueta**. La línea `TOTAL COBRADO … DEL PERIODO … AL …`
   * del anexo también trae dos fechas y también matchea: escanear las primeras filas y quedarse con el
   * primer par leería el período del anexo.
   */
  it('el período no se confunde con el par de fechas del anexo', () => {
    const soloAnexo = documento().filter(
      (f) => !f.fragmentos.some((g) => g.texto.startsWith('Resumen General Periodo')),
    );
    // Sin la etiqueta no hay período: prefiere no tenerlo antes que tomar el del anexo.
    for (const cuenta of leerMacro(soloAnexo).cuentas) {
      expect(cuenta.cuenta.periodoDesde).toBeUndefined();
    }
  });

  it('no publica totales de débitos ni de créditos, coherente con la capacidad declarada', () => {
    for (const cuenta of leido.cuentas) {
      expect(cuenta.cuenta.totalCreditosDeclarado).toBeUndefined();
      expect(cuenta.cuenta.totalDebitosDeclarado).toBeUndefined();
    }
  });

});

// -----------------------------------------------------------------------------
const todosLosAnexos = () => leido.cuentas.flatMap((c) => c.anexos);
const anexoPorOrden = (n: number) => todosLosAnexos().find((a) => a.ordenEnLote === n);

describe('§9 — el anexo: los SEIS renglones, y qué declara cada uno', () => {
  /**
   * 🔴 **El renglón que antes se perdía.** La versión anterior de este adaptador emitía los 3
   * `TOTAL COBRADO` y **descartaba los 3 `D. 409/2018`** porque su atribución no es posicional (reparto
   * medido 0/2/1). Con la tabla colgando del **lote** —`cuenta_bancaria_id` nullable y `atribucion_cuenta`
   * diciendo por qué— *"no sé de qué cuenta es"* dejó de ser motivo para tirar el único renglón que **no
   * existe como movimiento y no es derivable de ellos**.
   */
  it('emite los 6: 3 `TOTAL COBRADO` y 3 `D. 409/2018`', () => {
    const anexos = todosLosAnexos();
    expect(anexos).toHaveLength(6);
    expect(anexos.filter((a) => a.conceptoLiteral.startsWith('TOTAL COBRADO'))).toHaveLength(3);
    expect(anexos.filter((a) => a.conceptoLiteral.startsWith('D. 409/2018'))).toHaveLength(3);
  });

  /**
   * `ordenEnLote` es la **identidad** de la fila: el anexo no tiene clave natural —`(literal, período)`
   * colisiona entre las tres cuentas— y `uq_anexo_orden` es `(cliente, lote, orden)`. Numerarlo por cuenta
   * colisionaría en el segundo insert de la transacción.
   */
  it('el ordinal es del LOTE y en orden de lectura: 1..6 sin repetir', () => {
    const ordenes = todosLosAnexos()
      .map((a) => a.ordenEnLote)
      .sort((a, b) => a - b);
    expect(ordenes).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /**
   * §9, trampa 1: **dos variantes de espaciado del mismo literal** en el mismo archivo. Con igualdad
   * exacta se capturan 2 de 3. Y las dos grafías se guardan **tal como las imprime el banco**: normalizar
   * al guardar borra un hecho del documento; normalizar para comparar es trabajo del léxico del Módulo 2.
   */
  it('captura las DOS grafías del mismo literal, y no las normaliza', () => {
    const literales = todosLosAnexos()
      .filter((a) => a.conceptoLiteral.startsWith('TOTAL COBRADO'))
      .map((a) => a.conceptoLiteral);
    expect(literales.filter((l) => l === TOTAL_COBRADO.espaciado)).toHaveLength(2);
    expect(literales.filter((l) => l === TOTAL_COBRADO.pegado)).toHaveLength(1);
  });

  /**
   * §5: el `TOTAL COBRADO` coincide con `Σ(débito − crédito)` de los movimientos cuya glosa contiene
   * `25413`, o sea que **resume movimientos que ya están en el cuerpo**. El `D. 409/2018` no.
   */
  it('declara la relación con los movimientos, que es lo que hace verificable INV-15', () => {
    for (const a of todosLosAnexos()) {
      expect(a.relacionConMovimientos).toBe(
        a.conceptoLiteral.startsWith('TOTAL COBRADO')
          ? 'resume_movimientos_del_cuerpo'
          : 'no_esta_en_los_movimientos',
      );
    }
  });

  /**
   * §9, trampa 4: hay 3 líneas `D. 409/2018` para 3 cuentas y el reparto en orden de documento es
   * **0/2/1**. Estar impreso adentro de una sección **no** es evidencia de a qué cuenta pertenece.
   */
  it('el `TOTAL COBRADO` se atribuye por cuenta y el `D. 409/2018` NO', () => {
    for (const a of todosLosAnexos()) {
      expect(a.atribucionCuenta).toBe(
        a.conceptoLiteral.startsWith('TOTAL COBRADO') ? 'publicada_por_cuenta' : 'no_determinada',
      );
    }
  });

  it('el `TOTAL COBRADO` de la cuenta en dólares lleva SU moneda, no `ARS` por defecto', () => {
    expect(ctaUsd?.anexos).toHaveLength(1);
    expect(ctaUsd?.anexos[0]).toMatchObject({ moneda: 'USD', importeDeclarado: '5.00' });
    expect(ctaEspecial?.anexos.every((a) => a.moneda === 'ARS')).toBe(true);
  });

  /**
   * §9, trampa 2: la variante inline `DEL PERIODO AL <F4>`, **sin fecha de inicio**. Es el único caso
   * medido de `publicado_solo_hasta` y la razón por la que las dos fechas dejaron de ser obligatorias.
   *
   * 🔴 Lo que el esquema protege es que `periodoDesde` quede **ausente** y no relleno con el del extracto:
   * el extracto arranca el `01/11/2025` y escribirlo acá sería un hecho fiscal fabricado que cuadra.
   */
  it('la variante sin fecha de inicio se declara `publicado_solo_hasta`, y NO se rellena', () => {
    const soloHasta = todosLosAnexos().filter((a) => a.periodoDato === 'publicado_solo_hasta');
    expect(soloHasta).toHaveLength(1);
    expect(soloHasta[0]).toMatchObject({ periodoHasta: '2025-11-28', importeDeclarado: '7.00' });
    expect(soloHasta[0]?.periodoDesde).toBeUndefined();
    // Y el resto sí trae las dos, porque el banco las imprime.
    for (const a of todosLosAnexos()) {
      if (a.periodoDato !== 'publicado_completo') continue;
      expect(a.periodoDesde).toBe('2025-11-01');
      expect(a.periodoHasta).toBe('2025-11-28');
    }
  });

  /**
   * 🔴 §9, trampa 3: **el único elemento del documento que se parte entre páginas.** La etiqueta está en
   * la p1 y su `(S.E.U.O.) <IMP>` en la p2, **después del encabezado de cuenta repetido** — que es la
   * misma trampa de orden del §14.2, vista desde el anexo.
   *
   * `paginaPdf` es la de la **etiqueta**, no la del importe: es donde arranca el renglón.
   */
  it('el `D. 409/2018` que cruza el corte de página se arma completo, con la página de su etiqueta', () => {
    const cruzado = anexoPorOrden(3);
    expect(cruzado).toMatchObject({
      paginaPdf: 1,
      importeDeclarado: '3.00',
      periodoDato: 'publicado_completo',
      atribucionCuenta: 'no_determinada',
    });
    // Y el de la p2, cuya cola está en su misma página, toma la OTRA cola: no se cruzan.
    expect(anexoPorOrden(4)).toMatchObject({ paginaPdf: 2, importeDeclarado: '9.00' });
  });

  /**
   * `anexo_literal_sin_identificador_chk` (migración 0008): ninguna corrida de 7+ dígitos. El literal se
   * corta **antes** de `DEL PERIODO`, así que las fechas quedan afuera — si se guardaran como `ddmmaaaa`
   * sin separadores serían 8 dígitos seguidos y el `check` rechazaría el lote entero.
   */
  it('ningún literal lleva las fechas ni una corrida de 7 dígitos', () => {
    for (const a of todosLosAnexos()) {
      expect(a.conceptoLiteral).not.toMatch(/\d{7}/);
      expect(a.conceptoLiteral).not.toMatch(/DEL PERIODO/);
      expect(a.conceptoLiteral.trim()).toBe(a.conceptoLiteral);
    }
  });

  /**
   * 🔴 **EL CANARIO DEL DOBLE CONTEO.** Es lo que sostiene de verdad la prohibición: ninguna barrera de
   * Postgres impide un `union all` entre las dos tablas.
   *
   * Si un importe de anexo entrara en la suma de movimientos, el impuesto quedaría contado **dos veces** y
   * el asiento **cuadraría igual** — la peor clase de error de este dominio. Los seis importes del anexo
   * (`5,00`, `12,00`, `34,00`, `3,00`, `9,00`, `7,00`) caen todos en la ventana de `SALDO`, con el borde
   * derecho **idéntico** (553.8) al del cuerpo.
   */
  it('ningún importe de anexo entra en la suma de movimientos ni como saldo de una fila', () => {
    const movimientos = leido.cuentas.flatMap((c) => c.movimientos);
    const deAnexo = new Set(todosLosAnexos().map((a) => a.importeDeclarado));
    expect(deAnexo).toEqual(new Set(['5.00', '12.00', '34.00', '3.00', '9.00', '7.00']));

    for (const m of movimientos) {
      expect(deAnexo.has(m.saldo ?? '')).toBe(false);
      expect(deAnexo.has(m.importe.replace('-', ''))).toBe(false);
    }

    // Y la verificación por cuenta —que es la que produce los totales— no ve ni uno de esos importes.
    for (const cuenta of leido.cuentas) {
      const v = verificarAritmetica(cuenta, {
        capacidades: CAPACIDADES_MACRO,
        movimientosEnElLote: 7,
      });
      expect(deAnexo.has(v.totalCreditosCalculado)).toBe(false);
      expect(deAnexo.has(v.totalDebitosCalculado)).toBe(false);
      // La cuenta en dólares no tiene movimientos y sale `no_verificable`; lo que ninguna puede es
      // **no cuadrar**, que es lo que pasaría si un importe de anexo entrara en la ecuación.
      expect(v.estado).not.toBe('no_cuadra');
    }
  });

  /**
   * `alicuotaPublicada` es **N2** contra la intuición —las tasas que publica un banco en su anexo no son
   * alícuotas legales, son el precio que le cobra a ese cliente— y este banco no la publica en ninguno de
   * los seis renglones. Ausente, no `'0'`.
   */
  it('no publica alícuota en ningún renglón: no se inventa una', () => {
    for (const a of todosLosAnexos()) expect(a.alicuotaPublicada).toBeUndefined();
  });

  it('cada anexo producido valida contra el esquema Zod', () => {
    for (const a of todosLosAnexos()) expect(() => anexoExtractoSchema.parse(a)).not.toThrow();
    for (const cuenta of leido.cuentas) {
      expect(() => cuentaConMovimientosSchema.parse(cuenta)).not.toThrow();
    }
  });
});

// -----------------------------------------------------------------------------
describe('§14.4-bis — el consolidado por moneda: el único control que ve una mezcla', () => {
  it('lee las dos monedas, y el literal con el espaciado partido también', () => {
    expect(leido.consolidadosPorMoneda).toEqual([
      { moneda: 'ARS', importe: '3000.00', paginaPdf: 1 },
      { moneda: 'USD', importe: '0.00', paginaPdf: 1 },
    ]);
  });

  it('cuadra contra la suma de los saldos finales de cada moneda', () => {
    const r = verificarConsolidadoPorMoneda(leido.cuentas, leido.consolidadosPorMoneda, {
      declaraConsolidado: CAPACIDADES_MACRO.traeConsolidadoPorMoneda,
    });
    expect(r.verificado).toBe(true);
    expect(r.diferencias).toEqual([]);
  });

  /**
   * 🔴 **El escenario que ninguna otra ecuación del documento detecta.** Toda la aritmética por cuenta
   * cierra igual si la sectorización se hizo mal; ésta no. Acá se simula moviendo el consolidado, que es
   * equivalente a haber perdido, duplicado o mezclado una cuenta.
   */
  it('un consolidado que NO cuadra rechaza el lote', () => {
    const otro = leerMacro(documento({ consolidadoPesos: '9.999,00' }));
    const r = verificarConsolidadoPorMoneda(otro.cuentas, otro.consolidadosPorMoneda, {
      declaraConsolidado: CAPACIDADES_MACRO.traeConsolidadoPorMoneda,
    });
    // Las cuentas y las cadenas son idénticas a las del caso que cuadra: por cuenta, todo cierra.
    for (const cuenta of otro.cuentas) {
      expect(
        verificarAritmetica(cuenta, { capacidades: CAPACIDADES_MACRO, movimientosEnElLote: 7 })
          .filasConRuptura,
      ).toEqual([]);
    }
    expect(r.diferencias).toContainEqual(
      expect.objectContaining({ codigo: 'EST_CONSOLIDADO_MONEDA' }),
    );
  });
});

// -----------------------------------------------------------------------------
describe('§10 — el hash lleva la cuenta adentro', () => {
  const enEspecial = () => ctaEspecial?.movimientos[0];
  const enBancaria = () => ctaBancaria?.movimientos[3];

  it('el fixture ejercita el caso: las dos filas son idénticas en todo lo que entra al hash', () => {
    // Sin esta aserción el test de abajo podría pasar por casualidad, comparando filas distintas.
    expect(enEspecial()?.fecha).toBe(enBancaria()?.fecha);
    expect(enEspecial()?.importe).toBe(enBancaria()?.importe);
    expect(enEspecial()?.saldo).toBe(enBancaria()?.saldo);
    expect(enEspecial()?.descripcion).toBe(GLOSA_REPETIDA);
    expect(enBancaria()?.descripcion).toBe(GLOSA_REPETIDA);
  });

  it('dos movimientos idénticos en cuentas distintas NO colapsan', () => {
    expect(enEspecial()?.filaHash).not.toBe(enBancaria()?.filaHash);
    expect(enEspecial()?.filaHash).toHaveLength(64);
  });

  /**
   * Y la contraprueba: con la **misma** clave de cuenta, esas dos filas sí colapsan. Es lo que demuestra
   * que lo que las separa es el número de cuenta y no otra diferencia del fixture.
   */
  it('con la misma clave de cuenta, colapsarían', () => {
    const clave: ClaveCuenta = {
      bancoCodigo: 'macro',
      numeroNormalizado: '1000000000010',
      moneda: 'ARS',
    };
    const material = {
      fecha: '2025-11-03',
      importe: '500.00',
      saldo: '1500.00',
      descripcion: GLOSA_REPETIDA,
    };
    const [a] = hashesDeCuenta(clave, [material]);
    const [b] = hashesDeCuenta(clave, [material]);
    expect(a).toBe(b);
  });

  it('todos los hashes del lote son distintos', () => {
    const hashes = leido.cuentas.flatMap((c) => c.movimientos.map((m) => m.filaHash));
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

// -----------------------------------------------------------------------------
/**
 * §2 — **el titular, medido con formas y no leído de la spec.**
 *
 * `titularDocumento` no resuelve la cuenta (para eso están el número y el CBU, y con ellos INV-6 ya cierra):
 * es un **control cruzado** que valida que el archivo sea del cliente declarado. Justamente por eso vale
 * menos que cero si sale mal — un control que da verdadero cuando debería dar falso es peor que no tenerlo.
 * `titular` es informativo, así que ante la duda es el primero que se sacrifica.
 *
 * | Caso | Sin el criterio correcto |
 * |---|---|
 * | Once dígitos en el cuerpo (`DOC<###########>`, §12) | el CUIT de un **tercero** guardado como titular |
 * | El rótulo es el **tercer** fragmento de su fila | con `^` no matchea **ninguna** de las 45 |
 * | El renglón **termina** en los once dígitos | exigir razón social pegada tira el documento que ya se leyó |
 * | `Sr(es):` comparte baseline con una columna con `(####)` | el nombre se guarda con la columna vecina pegada |
 * | Dos documentos entre páginas | se elige uno, y el control cruzado valida contra la mitad del archivo |
 */
describe('§2 — titular y documento de la carátula', () => {
  const filasCon = (literal: string, filas: readonly FilaGeometrica[]): readonly FilaGeometrica[] =>
    filas.filter((f) => f.fragmentos.some((g) => g.texto.includes(literal)));

  /**
   * 🔴 **El bloque que fija la geometría ANTES de mirar el resultado — y van dos veces que hace falta.**
   *
   * Primero el fixture emitía la fila del CUIT con **un solo fragmento** y el rótulo al principio: un lector
   * anclado con `^` pasaba en verde y contra el archivo real no enganchaba ninguna de las 45. Después la
   * emitía con la **razón social pegada** detrás del CUIT, que es lo que dice §2 y el documento **no hace**:
   * el documento se leía bien y la guarda de la razón social lo tiraba.
   *
   * Un fixture que no reproduce la geometría medida no prueba nada sobre este documento. Estas asserts son
   * las que hacen que la próxima simplificación se caiga acá y no en la corrida contra el archivo real.
   */
  it('reproduce la geometría MEDIDA de las dos filas de la carátula', () => {
    const filas = documento();

    // Fila del rótulo: la etiqueta SOLA en su fragmento, y otra columna en el mismo baseline con su `(####)`.
    const delRotulo = filasCon('Sr(es):', filas);
    expect(delRotulo).toHaveLength(2);
    for (const f of delRotulo) {
      expect(f.fragmentos).toHaveLength(2);
      expect(f.fragmentos[0]?.texto).toBe('Sr(es):');
      expect(f.fragmentos[0]?.x).toBe(X.titular);
      expect(f.fragmentos[1]?.x).toBe(X.columnaVecina);
      expect(f.fragmentos[1]?.texto).toMatch(/\(\d{4}\)/);
    }

    // Fila de abajo: el nombre en DOS fragmentos de la banda, y el CUIT a la derecha en la MISMA fila.
    const delCuit = filasCon('C.U.I.T', filas);
    expect(delCuit).toHaveLength(2);
    for (const [n, f] of delCuit.entries()) {
      expect(f.fragmentos).toHaveLength(3);
      expect(f.fragmentos.map((g) => g.x)).toEqual([X.titular, X.nombreSegundoFragmento, X.cuit]);
      // El rótulo del CUIT es el TERCER fragmento: la fila no empieza con la etiqueta.
      expect(f.fragmentos[2]?.texto).toMatch(/^C\.U\.I\.T/);
      expect(f.fragmentos.map((g) => g.texto).join(' ')).not.toMatch(/^C\.U\.I\.T/);
      // Y la fila TERMINA en los once dígitos: no hay razón social pegada detrás.
      expect(f.fragmentos[2]?.texto).toMatch(/\d{11}$/);
      // Está justo debajo del rótulo, misma página y a un interlineado.
      const rotulo = delRotulo[n];
      expect(f.pagina).toBe(rotulo?.pagina);
      expect((rotulo?.y ?? 0) - f.y).toBe(12);
    }
    // Las dos grafías del separador conviven en el mismo archivo: con espacio y pegada al rótulo.
    const rotulos = delCuit.map((f) => f.fragmentos[2]?.texto ?? '');
    expect(rotulos.filter((t) => t.startsWith('C.U.I.T '))).toHaveLength(1);
    expect(rotulos.filter((t) => /^C\.U\.I\.T\d/.test(t))).toHaveLength(1);
  });

  it('el documento sale del renglón `C.U.I.T` y el nombre del renglón `Sr(es):`', () => {
    for (const c of leido.cuentas) {
      expect(c.cuenta.titularDocumento).toBe(CUIT_INVENTADO);
      expect(c.cuenta.titular).toBe(RAZON_SOCIAL_INVENTADA);
    }
  });

  /**
   * 🔴 **El error que este layout invita a cometer.** La razón social y el CUIT están en la **misma fila**,
   * y el CUIT a la derecha (`x = 364.4`). Un lector que tome "el texto de la fila de abajo" guarda el
   * documento del cliente **adentro del campo del nombre** — y nadie lo nota nunca, porque el campo no se
   * imprime. La banda `[72.0, 300)` lo deja afuera por geometría, y las guardas son la segunda vuelta.
   */
  it('el fragmento del CUIT NO entra en la razón social', () => {
    for (const c of leido.cuentas) {
      expect(c.cuenta.titular).toBe(RAZON_SOCIAL_INVENTADA);
      expect(c.cuenta.titular).not.toMatch(/C\.U\.I\.T/);
      expect(c.cuenta.titular).not.toMatch(/\d/);
      expect(c.cuenta.titular).not.toContain(CUIT_INVENTADO);
    }
  });

  /**
   * Y la otra columna, la del renglón del rótulo: `Sr(es):` comparte baseline con `… (####) …` en
   * `x = 360.2`. Ni el `(####)` ni el nombre de esa columna pueden aparecer en el campo.
   */
  it('el nombre no se lleva puesta la columna que comparte baseline con el rótulo', () => {
    for (const c of leido.cuentas) {
      expect(c.cuenta.titular).not.toMatch(/\(/);
      expect(c.cuenta.titular).not.toMatch(/SUCURSAL/);
    }
  });

  /**
   * La ventana es de **una** fila y explícita. Si el nombre estuviera más abajo —o si entre el rótulo y el
   * nombre se colara otra cosa— el campo queda **ausente**: prefiero eso a un barrido que agarre el
   * domicilio, que es el renglón siguiente del mismo bloque.
   */
  it('si el valor no está en la fila inmediata de abajo, el nombre queda ausente', () => {
    const filas = documento();
    const rotulos = filas.flatMap((f, n) => (f.fragmentos.some((g) => g.texto === 'Sr(es):') ? [n] : []));
    // Las dos páginas, si no la otra tapa el agujero — el modo de falla de siempre.
    expect(rotulos).toHaveLength(2);
    // Se corre el renglón del nombre un interlineado más abajo: la ventana ya no lo alcanza.
    const corridos = new Set(rotulos.map((n) => n + 1));
    const conHueco = filas.map((f, n) => (corridos.has(n) ? { ...f, y: f.y - 12 } : f));
    for (const c of leerMacro(conHueco).cuentas) {
      expect(c.cuenta.titular).toBeUndefined();
      // Y el documento no se toca: son dos lecturas independientes.
      expect(c.cuenta.titularDocumento).toBe(CUIT_INVENTADO);
    }
  });

  /**
   * Cada grafía del separador, **sola**: si las dos están y una falla, la otra tapa el agujero — que es
   * justo el modo de falla que dejó pasar la primera versión.
   */
  it('lee el valor tanto separado por espacio como pegado al rótulo', () => {
    for (const soloEnLaPagina of [[CUIT_INVENTADO, null], [null, CUIT_INVENTADO]] as const) {
      const filas = documento({ pegadoPorPagina: soloEnLaPagina });
      expect(filasCon('C.U.I.T', filas)).toHaveLength(1);
      for (const c of leerMacro(filas).cuentas) expect(c.cuenta.titularDocumento).toBe(CUIT_INVENTADO);
    }
  });

  /**
   * 🔴 **El renglón termina en los once dígitos, y eso es un resultado válido.** La versión anterior exigía
   * razón social pegada —lo que dice §2— y por esa guarda tiraba un documento que ya había leído bien.
   */
  it('el documento se lee aunque NO haya razón social pegada detrás', () => {
    const filas = documento({ razonSocialPorPagina: [null, null] });
    for (const c of leerMacro(filas).cuentas) {
      expect(c.cuenta.titularDocumento).toBe(CUIT_INVENTADO);
      // Sin el renglón `Sr(es):` no hay de dónde sacar el nombre: ausente, no inventado.
      expect(c.cuenta.titular).toBeUndefined();
    }
  });

  /**
   * Y la contraparte: la guarda **no se borró**, se volvió condicional. Un banco que sí pegue la razón
   * social al documento sigue cubierto, y los dos campos salen del mismo renglón.
   */
  it('si el banco SÍ pega la razón social al documento, se leen los dos del mismo renglón', () => {
    const filas = documento({
      pegadoPorPagina: [PEGADO_CON_RAZON_SOCIAL, PEGADO_CON_RAZON_SOCIAL],
      // Sin el renglón `Sr(es):`, para que el nombre solo pueda venir del pegado.
      razonSocialPorPagina: [null, null],
    });
    for (const c of leerMacro(filas).cuentas) {
      expect(c.cuenta.titularDocumento).toBe(CUIT_INVENTADO);
      expect(c.cuenta.titular).toBe(RAZON_SOCIAL_INVENTADA);
    }
  });

  /**
   * La carátula es **del archivo** (§14.3): un solo bloque, repetido en las 45 páginas. Las tres cuentas
   * comparten titular, y eso no es una copia perezosa: es lo que el documento dice.
   */
  it('el titular es del ARCHIVO, no de la sección: las tres cuentas traen el mismo', () => {
    const titulares = new Set(leido.cuentas.map((c) => `${c.cuenta.titular}|${c.cuenta.titularDocumento}`));
    expect(titulares.size).toBe(1);
    expect(leido.cuentas).toHaveLength(3);
  });

  /**
   * §2 **no lista** ninguna etiqueta de condición ante IVA en este banco. Ausente es la respuesta correcta,
   * no un hueco: el otro banco del roster sí la publica (`IVA: <condición>`) y por eso el campo existe.
   */
  it('la condición ante IVA queda AUSENTE: la carátula de este banco no la publica', () => {
    for (const c of leido.cuentas) expect(c.cuenta.titularCondicionIva).toBeUndefined();
  });

  /**
   * 🔴 **Por etiqueta, nunca por patrón** (`resolver-cuenta.ts`): "el primer número de once dígitos"
   * encuentra el CUIT de una contraparte y lo toma por el del titular, y el extracto termina asignado a la
   * cuenta equivocada con todo cuadrando. En este banco el cuerpo trae el sufijo `DOC<###########>` en la
   * glosa (§12), que son documentos de terceros.
   */
  it('sin la etiqueta, el documento queda ausente — aunque el cuerpo traiga once dígitos', () => {
    const conDocDeUnTercero = [
      ...documento({ pegadoPorPagina: [null, null] }),
      fila([{ texto: `TPUSH NOMBRE SINTETICO DOC${CUIT_INVENTADO}`, x: X.glosa }], 2, 60),
    ];
    for (const c of leerMacro(conDocDeUnTercero).cuentas) {
      expect(c.cuenta.titularDocumento).toBeUndefined();
      expect(c.cuenta.titularCondicionIva).toBeUndefined();
      // El renglón `Sr(es):` sigue estando y sigue siendo válido: son dos renglones independientes.
      expect(c.cuenta.titular).toBe(RAZON_SOCIAL_INVENTADA);
    }
  });

  /**
   * El corte es **posicional**, así que hay que verificar que los 11 primeros sean dígitos **antes** de
   * cortar. Acá el valor trae 10: un `slice` a ciegas guardaría `3000000000E` como documento y
   * `MPRESA DE PRUEBA…` como razón social. Los dos plausibles, los dos falsos, y sin nada que los delate.
   */
  it('si los 11 primeros NO son dígitos, no se corta: el documento queda ausente', () => {
    const malFormado = `3000000000${RAZON_SOCIAL_INVENTADA}`;
    const leidoMal = leerMacro(documento({ pegadoPorPagina: [malFormado, malFormado] }));
    for (const c of leidoMal.cuentas) expect(c.cuenta.titularDocumento).toBeUndefined();
  });

  /**
   * Y la guarda del resto: si detrás de los once dígitos hay algo que **no** parece una razón social, el
   * corte cayó mal y **se descarta el renglón entero** — no se guarda el documento "por las dudas".
   */
  it('si detrás de los 11 dígitos hay algo que no es una razón social, se descarta el renglón', () => {
    const conCola = `${CUIT_INVENTADO}-0000-9999`;
    const leidoRaro = leerMacro(documento({ pegadoPorPagina: [conCola, conCola] }));
    for (const c of leidoRaro.cuentas) expect(c.cuenta.titularDocumento).toBeUndefined();
  });

  /**
   * 🔴 **Dos documentos distintos en un mismo archivo es un HALLAZGO**, no un empate a resolver por
   * preferencia. Se reporta y el campo queda **ausente**: quedarse con el de la primera página dejaría el
   * control cruzado de INV-6 validando contra uno de los dos titulares del archivo.
   */
  it('dos documentos distintos entre páginas: se reporta y NO se elige uno', () => {
    // Otro CUIT inventado, también con verificador inválido.
    const leidoDoble = leerMacro(documento({ pegadoPorPagina: [CUIT_INVENTADO, '30000000001'] }));

    for (const c of leidoDoble.cuentas) expect(c.cuenta.titularDocumento).toBeUndefined();

    const hallazgos = leidoDoble.lineasNoInterpretadas.filter((l) => l.codigo === 'desconocido');
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]?.paginaPdf).toBe(2);
    // Y se reporta la **forma**, nunca el nombre ni el número. Los `{n}` son del formateador de corridas,
    // no del documento: se sacan antes de mirar si quedó algún dígito.
    const forma = hallazgos[0]?.forma ?? '';
    expect(forma.replace(/\{\d+\}/g, '')).not.toMatch(/[0-9]/);
    expect(forma.replace(/[Aa{}\d]/g, '')).not.toMatch(/[b-zB-Z]/);
  });

  /** Los dos renglones se verifican por separado y **caen por separado**. */
  it('dos razones sociales distintas entre páginas: cae el nombre, no el documento', () => {
    const leidoDoble = leerMacro(
      documento({ razonSocialPorPagina: [RAZON_SOCIAL_INVENTADA, 'OTRA EMPRESA DE PRUEBA SA'] }),
    );
    for (const c of leidoDoble.cuentas) {
      expect(c.cuenta.titular).toBeUndefined();
      // El `C.U.I.T` coincide en las dos páginas, así que sobrevive: son renglones independientes.
      expect(c.cuenta.titularDocumento).toBe(CUIT_INVENTADO);
    }
    expect(leidoDoble.lineasNoInterpretadas.filter((l) => l.codigo === 'desconocido')).toHaveLength(1);
  });

  /** El caso en verde no reporta nada: las 45 repeticiones coincidiendo es lo normal, no un hallazgo. */
  it('las repeticiones que coinciden no producen ningún hallazgo', () => {
    expect(leido.lineasNoInterpretadas.filter((l) => l.codigo === 'desconocido')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('el contrato: nada se descarta en silencio, y nada del documento se escribe', () => {
  /**
   * 🔴 **El criterio cambió, y por eso este bloque también.**
   *
   * *"Fuera de la región de tabla"* es una **ubicación, no un destino**. Con ese criterio el residuo del
   * archivo real tenía **141 filas** que nadie podía clasificar sin volver al PDF, y —peor— el adaptador
   * que mejor puntuaba en `lineasNoInterpretadas` era el que más renglones de anexo perdía en silencio.
   *
   * Ahora **toda línea tiene un destino declarado**: movimiento, ruido con su regla, anexo, o residuo. Y
   * residuo significa *"esto no lo entendí"*, que es una métrica accionable.
   */
  it('la única fila que ninguna regla explica se reporta, y con su forma', () => {
    expect(leido.lineasNoInterpretadas).toHaveLength(1);
    const [residuo] = leido.lineasNoInterpretadas;
    expect(residuo?.codigo).toBe('linea_fuera_de_zona');
    expect(residuo?.paginaPdf).toBe(1);
  });

  it('la forma no conserva ni un dígito ni una letra del documento', () => {
    for (const l of leido.lineasNoInterpretadas) {
      // Se le sacan los `{n}` de la notación de corrida, que son del formateador y no del documento.
      expect(l.forma.replace(/\{\d+\}/g, '')).not.toMatch(/[0-9]/);
      expect(l.forma.replace(/[Aa{}\d]/g, '')).not.toMatch(/[b-zB-Z]/);
    }
  });

  it('la carátula, las leyendas legales y el bloque del titular no se reportan como residuo', () => {
    // Se reconocen por geometría (x ≈ 20.25 con y < 120, y x = 72.0), no por su texto: escribir esos
    // literales en el adaptador publicaría el nombre y el domicilio del cliente en el repo.
    const formas = leido.lineasNoInterpretadas.map((l) => l.forma).join(' ');
    expect(formas).not.toMatch(/\{3[0-9]\}/);
    expect(leido.lineasNoInterpretadas).toHaveLength(1);
  });

  /**
   * Los seis bloques que componían las **141** filas del residuo medido, cada uno con su regla:
   *
   * | Filas | Qué | Regla |
   * |---|---|---|
   * | 90 | Encabezado de sucursal (2 × 45) | `x ≈ 360.0` con `y > 780` |
   * | 45 | Leyenda de la columna izquierda de la carátula | `x ≈ 25.6` |
   * | 3 | Datos de la tabla de cuentas de la p1 | entre el título y la regla de subrayado |
   * | 1 | La regla de subrayado que la cierra | `/^_{5,}$/` |
   * | 2 | Segunda línea de la leyenda `ESTIMADO CLIENTE` | fila siguiente, misma página, un interlineado |
   */
  it('los seis bloques del residuo medido quedan explicados, no reportados', () => {
    const reportados = new Set(leido.lineasNoInterpretadas.map((l) => l.indice));
    const filas = documento();

    const enX = (x: number, predicado: (f: FilaGeometrica) => boolean = () => true): number[] =>
      filas.flatMap((f, i) =>
        Math.abs((f.fragmentos[0]?.x ?? -999) - x) < 0.35 && predicado(f) ? [i] : [],
      );

    const sucursal = enX(X.sucursal, (f) => f.y > 780);
    const caratulaIzq = enX(X.caratulaIzq);
    // El fixture tiene 2 páginas: 2 filas de sucursal y 1 de carátula izquierda por página.
    expect(sucursal).toHaveLength(4);
    expect(caratulaIzq).toHaveLength(2);

    const subrayado = filas.flatMap((f, i) => (/^_{5,}$/.test(f.fragmentos[0]?.texto ?? '') ? [i] : []));
    expect(subrayado).toHaveLength(1);
    // Las 3 filas de datos de la tabla están entre su título y la regla de subrayado.
    const tabla = [subrayado[0]! - 3, subrayado[0]! - 2, subrayado[0]! - 1];

    for (const i of [...sucursal, ...caratulaIzq, ...subrayado, ...tabla]) {
      expect(reportados.has(i), `la fila ${i} no debería estar en el residuo`).toBe(false);
    }
  });

  /**
   * Y el bloque que sí es del anexo: las filas de la etiqueta y de la cola `(S.E.U.O.)` **producen un
   * `AnexoExtracto`**, así que no pueden estar además en el residuo. El mismo renglón contado en dos
   * listas es la clase de error que hace que dos métricas del mismo lote no sumen.
   */
  it('ninguna fila de anexo aparece a la vez como anexo y como residuo', () => {
    const filas = documento();
    const textos = filas.map((f) => f.fragmentos.map((g) => g.texto).join(' '));
    const deAnexo = textos.flatMap((t, i) =>
      /^(TOTAL COBRADO DEL IMP|D\. 409\/2018|\(S\.E\.U\.O\.\))/.test(t) ? [i] : [],
    );
    // 3 `TOTAL COBRADO` + 3 `D. 409/2018` + 2 colas.
    expect(deAnexo).toHaveLength(8);
    const reportados = new Set(leido.lineasNoInterpretadas.map((l) => l.indice));
    for (const i of deAnexo) expect(reportados.has(i)).toBe(false);
  });
});
