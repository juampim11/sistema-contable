/**
 * ADAPTADOR SANTANDER — el "Done" de `docs/diseno/06-formato-santander.md` §10, y las trampas de §11.
 *
 * ## Dos reglas de construcción de este archivo
 *
 * 1. 🔴 **Ningún importe, glosa, identificador ni número de cuenta sale del material real.** Los conceptos
 *    son inventados (`Concepto sintetico NN`), los importes se **calculan** con una escalera aritmética, y
 *    el CUIT y el CBU son los sintéticos que ya usa el repo: entidad `999` inexistente y verificador
 *    inválido. Lo único que se copia de la especificación es la **geometría** —posiciones en puntos PDF—,
 *    que es una propiedad del formato que imprime el banco y no un dato de nadie.
 *
 * 2. 🔴 **Las coordenadas son las LITERALES de la spec**: `23.0 / 65.0 / 115.0` a la izquierda y los bordes
 *    derechos `408.0 / 492.0 / 578.0`, más `574.0` del `Saldo total`, `407.0` del TNA, `487.0` del CFTEA y
 *    `536.9` del pie. Nada de valores redondeados "con colchón": el precedente está en
 *    `multibanco.test.ts`, donde un fixture con `263.5` en vez de `264.0` dejó pasar un defecto que metía
 *    1221 referencias adentro de la glosa con 41 tests en verde. **El borde tiene que ejercitarse.**
 *
 * ## Y una tercera, propia de este banco
 *
 * `estado === 'cuadra'` **no alcanza** (§10). Un parser que se coma la distinción de columna y ponga los
 * 158 movimientos en una sola produce **0 rupturas** si además invierte el saldo. Por eso los tests exigen
 * el **reparto 83 débitos / 75 créditos**, no solo la cadena.
 */

import { describe, expect, it } from 'vitest';
import {
  adaptadorSantander,
  CAPACIDADES_SANTANDER,
  leerSantander,
  leerSantanderConDestinos,
  reconoceSantander,
} from '../src/adaptadores/santander.ts';
import {
  dentroDeAlgunaRegion,
  regionesDeTabla,
  RUIDO_COMUN,
} from '../src/adaptadores/toolkit.ts';
import { ErrorDeAdaptador } from '../src/adaptadores/contrato.ts';
import {
  fragmentoEnVentanaDerecha,
  textoDeFila,
  type FilaGeometrica,
} from '../src/texto-pdf.ts';
import { verificarAritmetica } from '../src/verificacion/invariantes.ts';
import { importeCanonicoACentavos } from '../src/parseo-ar.ts';
import {
  anexoExtractoSchema,
  movimientoBancarioCrudoSchema,
  type AnexoExtracto,
} from '../src/esquema.ts';
import { depurarGlosa } from '../src/glosa.ts';

// -----------------------------------------------------------------------------
// Geometría literal de la especificación (§3, §8, §11)
// -----------------------------------------------------------------------------

/** Bordes IZQUIERDOS de las columnas alineadas a la izquierda (§3). */
const X = {
  fecha: 23.0,
  comprobante: 65.0,
  glosa: 115.0,
  /** Etiqueta `Saldo total`, encima del encabezado `Débito` (385.6) — §11.4. */
  etiquetaSaldoTotal: 386.7,
  /** El pie `N - M` (§8). */
  pie: 536.9,
  /** La fecha del anexo de tasas, a **2.0 pt** de la columna de fecha (§3). */
  fechaDelAnexo: 25.0,
} as const;

/** Bordes DERECHOS, exactos y sin dispersión (§3, §9, §11.3, §11.4). */
const R = {
  debito: 408.0,
  credito: 492.0,
  saldo: 578.0,
  /** El `Saldo total`, a 4 pt de la columna de saldo del cuerpo (§11.4). */
  saldoTotal: 574.0,
  /** El TNA del anexo: **adentro** de la ventana de débito `[404, 412]` (§11.3). */
  tna: 407.0,
  /** El CFTEA: a 1.0 pt del borde de la ventana de crédito (§11.3). */
  cftea: 487.0,
  /** Los importes del `Detalle impositivo` (§9). */
  anexoImpositivo: 528.0,
  /**
   * El `Interés cobrado` del bloque de tasas. §9 **nombra la columna** —dice que su importe ya está en el
   * cuerpo— pero **no publica su `x`**: lo único medido de ese bloque son el TNA (407.0), el CFTEA (487.0) y
   * la fecha (25.0). Así que acá se reusa el único borde de anexo que la spec sí mide, y **el adaptador no
   * depende de ese valor**: en el bloque de tasas el importe se toma por "el fragmento más a la derecha que
   * parsea como importe", no por posición. Hay un test que lo corre con otra `x` para probarlo.
   */
  anexoTasas: 528.0,
  /** El encabezado `Débito`, alineado a la derecha de su columna. */
  encabezadoDebito: 408.0,
  encabezadoCredito: 492.0,
  encabezadoSaldo: 578.0,
  /** El importe de `Acuerdo:` en la cabecera de cuenta: 423.5 en p2, 374.6 en p3–p9 (§2.1). */
  acuerdoPagina2: 423.5,
  acuerdoRestoDePaginas: 374.6,
} as const;

/**
 * §11.2: la fecha sale con **ancho ≈ 0** cuando se repite (130 de 158 filas) y con 35.5 cuando cambia.
 * El texto está completo en las 158; lo que está en cero es el avance. Con `x = 23.0`, el borde derecho da
 * **23.4** y **58.5**, que son los dos valores medidos.
 */
const ANCHO_FECHA = { repetida: 0.4, visible: 35.5 } as const;

const ENCABEZADO_LITERAL = 'Fecha Comprobante Movimiento Débito Crédito Saldo en cuenta';

/** Identificadores sintéticos ya usados por el repo: entidad inexistente y verificador inválido. */
const CUIT_SINTETICO = '20-12345678-9';
const CBU_SINTETICO = '9990000090000000000001';
const CUENTA_PESOS = '123-456789/0';
const CUENTA_DOLARES = '987-654321/0';

// -----------------------------------------------------------------------------
// Helpers de fixture
// -----------------------------------------------------------------------------

type FragmentoDePrueba = { readonly texto: string; readonly x: number; readonly ancho?: number };

function filaGeometrica(
  fragmentos: readonly FragmentoDePrueba[],
  pagina: number,
  y: number,
): FilaGeometrica {
  return {
    pagina,
    y,
    fragmentos: [...fragmentos]
      .map((f) => ({ texto: f.texto, x: f.x, y, ancho: f.ancho ?? f.texto.length * 5 }))
      .sort((a, b) => a.x - b.x),
  };
}

/** Un fragmento cuyo **borde derecho** cae exactamente en `derecha`. Así imprime todo importe. */
function enBordeDerecho(texto: string, derecha: number, ancho = 40): FragmentoDePrueba {
  return { texto, x: derecha - ancho, ancho };
}

/** Acumulador de filas con página y baseline, para que el fixture se lea como el documento. */
function hoja(): {
  readonly filas: FilaGeometrica[];
  pagina(n: number): void;
  agregar(fragmentos: readonly FragmentoDePrueba[]): void;
} {
  const filas: FilaGeometrica[] = [];
  let paginaActual = 1;
  let y = 800;
  return {
    filas,
    pagina(n: number): void {
      paginaActual = n;
      y = 800;
    },
    agregar(fragmentos: readonly FragmentoDePrueba[]): void {
      filas.push(filaGeometrica(fragmentos, paginaActual, y));
      // Interlineado entre movimientos: ≥ 18.6 pt medido (§3). Muy por encima de TOLERANCIA_FILA = 2.5.
      y -= 19;
    },
  };
}

// -----------------------------------------------------------------------------
// Importes: se CALCULAN, nunca se copian
// -----------------------------------------------------------------------------

function conSeparadorDeMiles(entero: string): string {
  return entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Centavos → la notación del banco. §4: el importe va **sin signo** (`$ #.###,##`) y el saldo lleva el
 * menos **antes del `$`** (`-$ #.###.###,##`). Los dos son la 3ª notación de `parseo-ar.ts`.
 */
function importeDelBanco(centavos: bigint, simbolo: '$' | 'U$S'): string {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  const entero = conSeparadorDeMiles((abs / 100n).toString());
  const decimales = (abs % 100n).toString().padStart(2, '0');
  return `${negativo ? '-' : ''}${simbolo} ${entero},${decimales}`;
}

// -----------------------------------------------------------------------------
// El documento sintético: 2 cuentas, 158 movimientos, 8 páginas de tabla (§10)
// -----------------------------------------------------------------------------

const CANTIDAD = 158;
const DEBITOS_ESPERADOS = 83;
const CREDITOS_ESPERADOS = 75;
const CON_COMPROBANTE = 94;
const CON_CONTINUACION = 98;
const DE_UNA_LINEA = 60;
const CONCEPTOS_DISTINTOS = 29;
const FECHAS_DISTINTAS = 22;
const PAGINAS_TOTALES = 11;

/**
 * Permutación de `0..157`. `multiplicador` tiene que ser coprimo con 158 = 2·79, y así cada corte
 * `permutacion(i) < n` selecciona **exactamente** `n` movimientos, repartidos y no en bloque.
 */
function permutacion(i: number, multiplicador: number): number {
  return (i * multiplicador) % CANTIDAD;
}

const esDebito = (i: number): boolean => permutacion(i, 83) < DEBITOS_ESPERADOS;
const traeComprobante = (i: number): boolean => permutacion(i, 61) < CON_COMPROBANTE;
const traeContinuacion = (i: number): boolean => permutacion(i, 45) < CON_CONTINUACION;

/** 22 fechas distintas y **no decrecientes** (§6): el 30/05 y después 01/06 a 21/06. */
function fechaDe(i: number): string {
  const indice = Math.floor((i * FECHAS_DISTINTAS) / CANTIDAD);
  return indice === 0 ? '30/05/26' : `${String(indice).padStart(2, '0')}/06/26`;
}

/** 29 conceptos, en sentence case como los imprime el banco (§12). Inventados. */
function conceptoDe(i: number): string {
  return `Concepto sintetico ${String((i % CONCEPTOS_DISTINTOS) + 1).padStart(2, '0')}`;
}

/**
 * La segunda línea: contraparte o referencia (§7). Uno de los conceptos lleva un **importe embebido en la
 * glosa** (§11.9): son importes de un tercero dentro de una descripción, y lo que los mantiene fuera de las
 * columnas es la geometría, no un filtro de texto.
 */
function continuacionDe(i: number): string {
  return i % CONCEPTOS_DISTINTOS === 28
    ? 'Base de calculo 12,34% sobre $ 987,65'
    : `Contraparte sintetica ${(i % 17) + 1}`;
}

function comprobanteDe(i: number): string {
  return String(100_000 + i);
}

// -----------------------------------------------------------------------------
// Los dos bloques de anexo de la p9 (§9)
// -----------------------------------------------------------------------------

/**
 * Los rótulos del `Detalle impositivo`.
 *
 * **Son literales que imprime el banco**, igual que `ENCABEZADO_LITERAL`: están en §9 y no son un dato de
 * nadie. Lo que sí es inventado es todo lo que llevan adentro — las fechas del período (2026), la alícuota y
 * los importes—, que es lo que la regla 1 de este archivo protege.
 *
 * ⚠️ §9 mide **5 importes** y lista **seis** rótulos: cuál de los seis no lleva importe queda sin determinar
 * sin volver al archivo. El fixture usa cinco, que es la cifra medida, y **el lector no depende de la
 * cantidad**: recorre el bloque entero y reporta lo que no entiende.
 *
 * Los cinco cubren los cuatro `periodoDato` que importan acá y las tres relaciones con el cuerpo.
 */
const RENGLONES_IMPOSITIVOS = [
  // El ÚNICO que publica su rango (§9). `dd-mm-aaaa`, que es la forma del anexo y no la del cuerpo (§6).
  'Totales de retencion impuesto ley 25413 del 01-06-2026 al 30-06-2026',
  'Total retencion impuesto ley 25413 por debitos',
  // 🔴 El que NO existe como movimiento: el único candidato a registración del bloque.
  'Importe susceptible de ser computado contra otros tributos',
  // La alícuota va adentro del rótulo, no en fragmento propio. El valor es inventado.
  'Por retencion impuesto ley 25413 por creditos alicuota 33,00 %',
  // 🔴 `en el período de emisión`: el banco DECLARA el período sin imprimirlo. No es `no_publicado`.
  'Total Retención Régimen de Recaudación SIRCREB en el período de emisión',
] as const;

/**
 * Los dos renglones de `Tasas de Acuerdos y Descubierto`.
 *
 * El rótulo es sintético: §9 cuenta las dos filas y §3/§11.3 miden la fecha y las dos tasas, pero **no** hay
 * medición del texto ni de su `x`. Se pone en la columna de glosa, que es la posición plausible, y el lector
 * tampoco depende de eso: el rótulo es *lo que sobra* después de sacar fecha, tasas e importe.
 */
const RENGLONES_DE_TASAS = ['Renglon de tasas sintetico uno', 'Renglon de tasas sintetico dos'] as const;

const ANEXOS_ESPERADOS = RENGLONES_IMPOSITIVOS.length + RENGLONES_DE_TASAS.length;

/** Escalera aritmética: ningún importe se parece a otro y ninguno sale de ningún archivo. */
function magnitudDe(i: number): bigint {
  return BigInt(i + 1) * 13_711n + 4_321n;
}

/** §5: las 158 filas están en descubierto. Con esta semilla ningún saldo llega a cruzar el cero. */
const SALDO_INICIAL_PESOS = -200_000_000n;
const SALDO_INICIAL_DOLARES = 12_345n;

function paginaDe(i: number): number {
  return 2 + Math.min(7, Math.floor(i / 20));
}

/** La cadena de saldos completa, calculada una sola vez: es el oráculo del fixture. */
const SALDOS: readonly bigint[] = (() => {
  const salida: bigint[] = [];
  let saldo = SALDO_INICIAL_PESOS;
  for (let i = 0; i < CANTIDAD; i += 1) {
    saldo += esDebito(i) ? -magnitudDe(i) : magnitudDe(i);
    salida.push(saldo);
  }
  return salida;
})();

const SALDO_FINAL_PESOS = SALDOS[CANTIDAD - 1] ?? 0n;

function encabezadoDeTabla(): readonly FragmentoDePrueba[] {
  return [
    { texto: 'Fecha', x: X.fecha },
    { texto: 'Comprobante', x: X.comprobante },
    { texto: 'Movimiento', x: X.glosa },
    // Los tres títulos de columna van alineados a la derecha de su columna, como los importes.
    enBordeDerecho('Débito', R.encabezadoDebito, 22.4),
    enBordeDerecho('Crédito', R.encabezadoCredito, 24.6),
    enBordeDerecho('Saldo en cuenta', R.encabezadoSaldo, 60.0),
  ];
}

function cabeceraDeCuenta(pagina: number, dolares = false): readonly FragmentoDePrueba[] {
  return [
    {
      texto: `Cuenta Corriente${dolares ? ' especial U$S' : ''} Nº ${dolares ? CUENTA_DOLARES : CUENTA_PESOS}`,
      x: X.fecha,
    },
    // §2.1, trampa 3: el importe de `Acuerdo:` se corre de 423.5 a 374.6 según la variante de fuente. Esa
    // línea se parsea por etiqueta sobre el texto, nunca por `x` — y acá se incluye para que el fixture
    // tenga el mismo importe migratorio que el archivo real.
    enBordeDerecho(
      `Acuerdo: ${importeDelBanco(100_000_000n, '$')}`,
      pagina === 2 ? R.acuerdoPagina2 : R.acuerdoRestoDePaginas,
      120,
    ),
    { texto: 'Vencimiento: 30/06/26', x: 440.0 },
  ];
}

function filaDeMovimiento(i: number, fechaVisible: boolean): readonly FragmentoDePrueba[] {
  const magnitud = magnitudDe(i);
  const saldo = SALDOS[i] ?? 0n;
  return [
    {
      texto: fechaDe(i),
      x: X.fecha,
      ancho: fechaVisible ? ANCHO_FECHA.visible : ANCHO_FECHA.repetida,
    },
    ...(traeComprobante(i) ? [{ texto: comprobanteDe(i), x: X.comprobante }] : []),
    { texto: conceptoDe(i), x: X.glosa },
    // 🔴 El importe va SIN SIGNO en las dos columnas (§0, §4). La columna es la única señal.
    enBordeDerecho(importeDelBanco(magnitud, '$'), esDebito(i) ? R.debito : R.credito),
    enBordeDerecho(importeDelBanco(saldo, '$'), R.saldo, 60),
  ];
}

/**
 * El documento completo. Devuelve las filas geométricas en el orden en que las emitiría `aFilas()`.
 */
function documentoSantander(
  opciones: {
    /** §8: la cuenta en dólares puede no tener cabecera propia (hay 8 para 8 páginas y 2 cuentas). */
    readonly cabeceraDolaresEnLaSeccion?: boolean;
    /** Ver `R.anexoTasas`: §9 nombra el `Interés cobrado` y no publica su `x`. */
    readonly bordeDelInteresCobrado?: number;
  } = {},
): readonly FilaGeometrica[] {
  const h = hoja();

  // --- Página 1: carátula. Todo rotulado (§2). ---
  h.pagina(1);
  h.agregar([{ texto: 'Resumen de cuenta', x: X.fecha }]);
  h.agregar([{ texto: `CUIT: ${CUIT_SINTETICO}`, x: X.fecha }]);
  h.agregar([{ texto: `Cuenta Corriente Nº ${CUENTA_PESOS}`, x: X.fecha }]);
  // La cabecera de la cuenta en dólares vive en la carátula: es de donde sale su número cuando su sección
  // no trae cabecera propia.
  if (opciones.cabeceraDolaresEnLaSeccion !== true) {
    h.agregar([{ texto: `Cuenta Corriente especial U$S Nº ${CUENTA_DOLARES}`, x: X.fecha }]);
  }
  h.agregar([{ texto: `CBU: ${CBU_SINTETICO}`, x: X.fecha }]);
  // §11.10: `Desde:` y `Hasta:` en filas geométricas DISTINTAS.
  h.agregar([{ texto: 'Desde: 30/05/26', x: X.fecha }]);
  h.agregar([{ texto: 'Hasta: 30/06/26', x: X.fecha }]);
  /**
   * §2.1, trampa 2: el "Saldo total en cuentas" sale en tres fragmentos, los centavos en otro baseline, y
   * pesos y dólares comparten los dos baselines. La fila reconstruida mezcla las dos monedas — por eso este
   * banco no publica un consolidado legible y `traeConsolidadoPorMoneda` es `false`.
   */
  h.agregar([
    { texto: 'Saldo total en cuentas', x: X.fecha },
    { texto: '$', x: 300.0 },
    { texto: '1.111', x: 320.0 },
    { texto: '11', x: 360.0 },
  ]);
  h.agregar([{ texto: 'Movimientos en pesos', x: X.fecha }]);
  h.agregar([{ texto: `1 - ${PAGINAS_TOTALES}`, x: X.pie }]);

  // --- Páginas 2 a 9: la tabla de la cuenta en pesos. ---
  let fechaAnterior = '';
  let paginaAnterior = -1;

  for (let pagina = 2; pagina <= 9; pagina += 1) {
    h.pagina(pagina);
    // §8: las 8 cabeceras de cuenta caen DENTRO de la región de tabla.
    h.agregar(cabeceraDeCuenta(pagina));
    h.agregar(encabezadoDeTabla());

    if (pagina === 2) {
      // §11.5: fecha + glosa rotulada + saldo, y NINGÚN fragmento en las columnas de importe.
      h.agregar([
        { texto: '30/05/26', x: X.fecha, ancho: ANCHO_FECHA.visible },
        { texto: 'Saldo Inicial', x: X.glosa },
        enBordeDerecho(importeDelBanco(SALDO_INICIAL_PESOS, '$'), R.saldo, 60),
      ]);
    }

    for (let i = 0; i < CANTIDAD; i += 1) {
      if (paginaDe(i) !== pagina) continue;
      // §11.2: la fecha es visible ⟺ cambia la fecha o cambia la página.
      const visible = fechaDe(i) !== fechaAnterior || pagina !== paginaAnterior;
      h.agregar(filaDeMovimiento(i, visible));
      fechaAnterior = fechaDe(i);
      paginaAnterior = pagina;

      if (traeContinuacion(i)) {
        // §7: la continuación es una fila con un ÚNICO fragmento en x = 115.0.
        h.agregar([{ texto: continuacionDe(i), x: X.glosa }]);
      }
    }

    // §8: una de las dos notas al pie cae adentro de la tabla. Sin su regla, va a `lineasNoInterpretadas`.
    if (pagina === 5) {
      h.agregar([{ texto: '* Salvo error u omisión', x: X.fecha }]);
    }

    if (pagina === 9) {
      // §9: `Saldo total`, una vez por cuenta. Etiqueta en 386.7, importe en r = 574.0.
      h.agregar([
        { texto: 'Saldo total', x: X.etiquetaSaldoTotal },
        enBordeDerecho(importeDelBanco(SALDO_FINAL_PESOS, '$'), R.saldoTotal, 60),
      ]);

      // --- La segunda cuenta, en la misma página y con la MISMA geometría (§11.6). ---
      h.agregar([{ texto: 'Movimientos en dólares', x: X.fecha }]);
      if (opciones.cabeceraDolaresEnLaSeccion === true) {
        h.agregar(cabeceraDeCuenta(pagina, true));
      }
      h.agregar(encabezadoDeTabla());
      h.agregar([
        { texto: '30/05/26', x: X.fecha, ancho: ANCHO_FECHA.visible },
        { texto: 'Saldo Inicial', x: X.glosa },
        // §11.8: `U$S` no es `$`.
        enBordeDerecho(importeDelBanco(SALDO_INICIAL_DOLARES, 'U$S'), R.saldo, 60),
      ]);
      // §11.7: la cuenta está vacía y es LEGÍTIMA.
      h.agregar([{ texto: 'No tenés movimientos en dólares este período.', x: X.glosa }]);
      h.agregar([
        { texto: 'Saldo total', x: X.etiquetaSaldoTotal },
        enBordeDerecho(importeDelBanco(SALDO_INICIAL_DOLARES, 'U$S'), R.saldoTotal, 60),
      ]);

      // --- Los dos anexos, DESPUÉS del último `Saldo total` de las DOS cuentas (§9). ---
      h.agregar([{ texto: 'Detalle impositivo', x: X.fecha }]);
      h.agregar([
        { texto: 'Tipo de impuesto', x: X.fecha },
        enBordeDerecho('Importe', R.anexoImpositivo, 30),
      ]);
      RENGLONES_IMPOSITIVOS.forEach((rotulo, n) => {
        h.agregar([
          { texto: rotulo, x: X.fecha },
          enBordeDerecho(importeDelBanco(BigInt(n + 1) * 7_777n, '$'), R.anexoImpositivo),
        ]);
      });
      h.agregar([{ texto: 'Tasas de Acuerdos y Descubierto', x: X.fecha }]);
      RENGLONES_DE_TASAS.forEach((rotulo, k) => {
        const n = k + 1;
        h.agregar([
          // §3: la fecha del anexo está a 2.0 pt de la columna de fecha. Con tolerancia 2.5 entraría.
          { texto: '30/06/26', x: X.fechaDelAnexo, ancho: ANCHO_FECHA.visible },
          { texto: rotulo, x: X.glosa },
          // §11.3: el TNA cae DENTRO de la ventana de débito y el CFTEA a 1 pt de la de crédito.
          enBordeDerecho(`5${n},00%`, R.tna, 30),
          enBordeDerecho(`7${n},00%`, R.cftea, 30),
          // §9: el `Interés cobrado`, que ya está en el cuerpo. Ver la nota de `R.anexoTasas`.
          enBordeDerecho(
            importeDelBanco(BigInt(n) * 31_337n, '$'),
            opciones.bordeDelInteresCobrado ?? R.anexoTasas,
          ),
        ]);
      });
    }

    h.agregar([{ texto: `${pagina} - ${PAGINAS_TOTALES}`, x: X.pie }]);
  }

  // --- Páginas 10 y 11: legales. ---
  for (let pagina = 10; pagina <= PAGINAS_TOTALES; pagina += 1) {
    h.pagina(pagina);
    h.agregar([{ texto: 'Leyenda legal sintetica sin ningun dato', x: X.fecha }]);
    h.agregar([{ texto: `${pagina} - ${PAGINAS_TOTALES}`, x: X.pie }]);
  }

  return h.filas;
}

/**
 * Documento mínimo para los casos de borde: carátula con las dos etiquetas de período, una región de tabla
 * con el cuerpo que se le pase, y su `Saldo total`.
 */
function documentoMinimo(
  cuerpo: readonly (readonly FragmentoDePrueba[])[],
  opciones: {
    readonly conHasta?: boolean;
    readonly saldoTotal?: bigint;
    /** Renglones del `Detalle impositivo`, **después** del `Saldo total` como en el archivo (§9). */
    readonly anexo?: readonly (readonly FragmentoDePrueba[])[];
  } = {},
): readonly FilaGeometrica[] {
  const h = hoja();
  h.agregar([{ texto: `CUIT: ${CUIT_SINTETICO}`, x: X.fecha }]);
  h.agregar([{ texto: 'Desde: 30/05/26', x: X.fecha }]);
  if (opciones.conHasta !== false) h.agregar([{ texto: 'Hasta: 30/06/26', x: X.fecha }]);
  h.agregar([{ texto: 'Movimientos en pesos', x: X.fecha }]);
  h.pagina(2);
  h.agregar(cabeceraDeCuenta(2));
  h.agregar(encabezadoDeTabla());
  for (const fila of cuerpo) h.agregar(fila);
  h.agregar([
    { texto: 'Saldo total', x: X.etiquetaSaldoTotal },
    enBordeDerecho(importeDelBanco(opciones.saldoTotal ?? -1n, '$'), R.saldoTotal, 60),
  ]);
  if (opciones.anexo) {
    h.agregar([{ texto: 'Detalle impositivo', x: X.fecha }]);
    h.agregar([
      { texto: 'Tipo de impuesto', x: X.fecha },
      enBordeDerecho('Importe', R.anexoImpositivo, 30),
    ]);
    for (const fila of opciones.anexo) h.agregar(fila);
  }
  h.agregar([{ texto: `2 - ${PAGINAS_TOTALES}`, x: X.pie }]);
  return h.filas;
}

/** Un documento de **una** cuenta, sin movimientos, con los renglones de anexo que se le pasen. */
function documentoConAnexo(
  renglones: readonly (readonly FragmentoDePrueba[])[],
): readonly FilaGeometrica[] {
  return documentoMinimo([], { anexo: renglones });
}

// -----------------------------------------------------------------------------
// El fixture, leído una sola vez
// -----------------------------------------------------------------------------

const DOCUMENTO = documentoSantander();
const LEIDO = leerSantander(DOCUMENTO);
const CUENTA_ARS = LEIDO.cuentas[0];
const CUENTA_USD = LEIDO.cuentas[1];

// -----------------------------------------------------------------------------
describe('el fixture es el documento medido, no una simplificación', () => {
  it('reproduce las coordenadas literales de la spec, incluidos los bordes', () => {
    const textos = DOCUMENTO.map(textoDeFila);
    expect(textos).toContain(ENCABEZADO_LITERAL);
    // Los tres bordes derechos del cuerpo, tal como los mide §3.
    const unMovimiento = DOCUMENTO.find((f) => textoDeFila(f).startsWith('30/05/26 Concepto'));
    expect(unMovimiento).toBeDefined();
    if (unMovimiento) {
      const debito = fragmentoEnVentanaDerecha(unMovimiento, 404.0, 412.0);
      const saldo = fragmentoEnVentanaDerecha(unMovimiento, 574.5, 582.0);
      expect(debito ?? saldo).toBeDefined();
      expect(saldo).toBeDefined();
    }
  });

  it('ninguna glosa del fixture trae signo en el importe: 0 de 158 (§0)', () => {
    let conSigno = 0;
    for (const fila of DOCUMENTO) {
      for (const f of fila.fragmentos) {
        const derecha = f.x + f.ancho;
        const enColumnaDeImporte =
          (derecha >= 404 && derecha <= 412) || (derecha >= 488 && derecha <= 496);
        if (enColumnaDeImporte && f.texto.startsWith('-')) conSigno += 1;
      }
    }
    expect(conSigno, 'el fixture no reproduce el hallazgo que cambia el diseño').toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('reconocimiento', () => {
  it('reconoce el documento por el encabezado literal, que está en la página 2', () => {
    expect(reconoceSantander(DOCUMENTO)).toBe(true);
  });

  it('no reconoce un documento que no trae ninguna de sus marcas', () => {
    const otro = [
      filaGeometrica([{ texto: 'Resumen de Cuenta Corriente en Pesos', x: 38.4 }], 1, 800),
      filaGeometrica([{ texto: 'Fecha Descripción Origen Crédito Débito Saldo', x: 38.4 }], 1, 780),
    ];
    expect(reconoceSantander(otro)).toBe(false);
  });

  it('el adaptador expone el contrato con su código y su versión', () => {
    expect(adaptadorSantander.bancoCodigo).toBe('santander');
    expect(adaptadorSantander.version).toBe(1);
    expect(adaptadorSantander.reconoce({ filas: DOCUMENTO })).toBe(true);
    expect(adaptadorSantander.leer({ filas: DOCUMENTO }).cuentas).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
describe('capacidades declaradas: cada una es la entrada del verificador', () => {
  it('las declara TODAS, con los valores que mide la spec', () => {
    expect(CAPACIDADES_SANTANDER).toEqual({
      familiaLayout: 'columnas-posicionales',
      cadenaDeSaldos: 'completa',
      // §9: no hay línea de totales de columna → V2 no es verificable en este banco.
      traeTotalesDeclarados: false,
      // §2.2 y §11.5: `Saldo Inicial` viene ROTULADO, no derivado.
      traeSaldoInicialDeclarado: true,
      // §0 y §4: 0 de 158 importes traen signo.
      traeSignoEnElImporte: false,
      traeSaldoPorFila: true,
      traeFechaValor: false,
      traeReferencia: true,
      // §14.2: el `Cod. Operativo` existe en el `.xls`, no en el PDF.
      traeCodigoDeConcepto: false,
      anioEnLaFecha: true,
      multiCuenta: true,
      multiMoneda: true,
      traeMovimientosFueraDelPeriodo: false,
      // §2.1: el consolidado de la carátula es ilegible por fila y mezcla las dos monedas.
      traeConsolidadoPorMoneda: false,
    });
  });
});

// -----------------------------------------------------------------------------
describe('el "Done" de §10, entero', () => {
  it('dos cuentas', () => {
    expect(LEIDO.cuentas).toHaveLength(2);
    expect(CUENTA_ARS?.cuenta.moneda).toBe('ARS');
    expect(CUENTA_USD?.cuenta.moneda).toBe('USD');
  });

  it('158 movimientos en pesos y 0 en dólares', () => {
    expect(CUENTA_ARS?.movimientos).toHaveLength(CANTIDAD);
    expect(CUENTA_USD?.movimientos).toHaveLength(0);
  });

  /**
   * 🔴 **El criterio propio de este banco.** `estado === 'cuadra'` no alcanza: un parser que ponga los 158
   * en una sola columna produce 0 rupturas si además invierte el saldo. El reparto se exige aparte.
   */
  it('reparto 83 débitos / 75 créditos', () => {
    const debitos = CUENTA_ARS?.movimientos.filter((m) => m.columnaOrigen === 'debito') ?? [];
    const creditos = CUENTA_ARS?.movimientos.filter((m) => m.columnaOrigen === 'credito') ?? [];
    expect(debitos).toHaveLength(DEBITOS_ESPERADOS);
    expect(creditos).toHaveLength(CREDITOS_ESPERADOS);

    // Y el signo derivado de la columna, en las 158: crédito positivo, débito negativo.
    for (const m of debitos) expect(m.importe.startsWith('-'), m.filaHash).toBe(true);
    for (const m of creditos) expect(m.importe.startsWith('-'), m.filaHash).toBe(false);
    // La columna del banco y el derivado no pueden divergir (`refine` del esquema, replicado acá).
    for (const m of debitos) expect(m.debito).toBeDefined();
    for (const m of creditos) expect(m.credito).toBeDefined();
  });

  it('158 con saldo negativo', () => {
    const acreedores = CUENTA_ARS?.movimientos.filter((m) => m.saldoEsAcreedor === true) ?? [];
    expect(acreedores).toHaveLength(CANTIDAD);
  });

  it('94 con valor en Comprobante', () => {
    const conComprobante =
      CUENTA_ARS?.movimientos.filter((m) => m.referenciaExterna !== undefined) ?? [];
    expect(conComprobante).toHaveLength(CON_COMPROBANTE);
    // Y sale de SU columna (x = 65.0), no de un patrón sobre la glosa: los 94 valores son los que el
    // fixture imprimió en esa columna, y ninguno de los 64 restantes se inventó.
    const esperados = new Set(
      Array.from({ length: CANTIDAD }, (_, i) => i)
        .filter(traeComprobante)
        .map(comprobanteDe),
    );
    for (const m of conComprobante) {
      expect(esperados.has(m.referenciaExterna ?? '')).toBe(true);
      expect(m.referencias?.[0]).toEqual({ tipo: 'operacion', valor: m.referenciaExterna });
    }
  });

  it('60 de una sola línea y 98 con continuación', () => {
    const movimientos = CUENTA_ARS?.movimientos ?? [];
    expect(movimientos.filter((m) => m.descripcionLineas.length === 1)).toHaveLength(DE_UNA_LINEA);
    expect(movimientos.filter((m) => m.descripcionLineas.length === 2)).toHaveLength(
      CON_CONTINUACION,
    );
    // §7: máximo 2, nunca 3.
    expect(movimientos.every((m) => m.descripcionLineas.length <= 2)).toBe(true);
  });

  it('29 conceptos distintos, y el concepto sale de la línea 1 (§7)', () => {
    const conceptos = new Set((CUENTA_ARS?.movimientos ?? []).map((m) => m.conceptoBanco));
    expect(conceptos.size).toBe(CONCEPTOS_DISTINTOS);
    // La descripción es la concatenación; el concepto, solo la primera línea.
    const conDos = CUENTA_ARS?.movimientos.find((m) => m.descripcionLineas.length === 2);
    expect(conDos?.conceptoBanco).toBe(conDos?.descripcionLineas[0]);
    expect(conDos?.descripcion).toBe(conDos?.descripcionLineas.join(' '));
  });

  /**
   * Los tres campos del concepto viajan juntos, y el esquema tiene dos `refine` que lo atan: un
   * `conceptoBanco` sin estrategia declarada hace indistinguible "el banco no lo publica" de "el adaptador
   * no lo miró". Acá se valida **cada uno de los 158 movimientos contra el esquema Zod entero**, que es lo
   * que prueba que los cuatro `refine` (crédito XOR débito, columna coherente, importe derivado, concepto)
   * se cumplen fila por fila y no solo en el caso que uno mira.
   */
  it('los 158 movimientos validan contra `movimientoBancarioCrudoSchema`', () => {
    for (const m of CUENTA_ARS?.movimientos ?? []) {
      const r = movimientoBancarioCrudoSchema.safeParse(m);
      expect(r.success, JSON.stringify(r.error?.issues ?? [])).toBe(true);
    }
  });

  it('el concepto declara su estrategia y que entró completo', () => {
    for (const m of CUENTA_ARS?.movimientos ?? []) {
      // §7: el corte es geométrico —la línea 1 de la glosa—, no una columna propia ni una lista cerrada.
      expect(m.conceptoBancoEstrategia).toBe('segmento_de_glosa');
      // §7: el concepto no se trunca a ancho fijo (máx. 41 caracteres en una columna de 160 pt).
      expect(m.conceptoCompleto).toBe(true);
    }
  });

  /**
   * 🔴 **INV-14**: `conceptoBanco` tiene que ser prefijo de la `descripcion` **depurada**. Se verifica con
   * las dos puntas pasadas por la misma `depurarGlosa`, que es exactamente lo que hace `persistirCuenta`
   * antes de escribir —y lo que rechaza el lote con `concepto_banco_no_es_prefijo` si no da—.
   */
  it('INV-14: el concepto es prefijo de la descripción depurada, en las 158', () => {
    for (const m of CUENTA_ARS?.movimientos ?? []) {
      const concepto = depurarGlosa(m.conceptoBanco ?? '').descripcion;
      const descripcion = depurarGlosa(m.descripcion).descripcion;
      expect(descripcion.startsWith(concepto), `${concepto} ⊄ ${descripcion}`).toBe(true);
    }
  });

  it('cada movimiento sabe de qué página salió', () => {
    for (const m of CUENTA_ARS?.movimientos ?? []) {
      expect(m.paginaPdf).toBeGreaterThanOrEqual(2);
      expect(m.paginaPdf).toBeLessThanOrEqual(9);
    }
    // Las 8 páginas con tabla aportan movimientos (§1): ninguna quedó sin leer.
    expect(new Set((CUENTA_ARS?.movimientos ?? []).map((m) => m.paginaPdf)).size).toBe(8);
  });

  it('22 fechas distintas, no decrecientes', () => {
    const fechas = (CUENTA_ARS?.movimientos ?? []).map((m) => m.fecha);
    expect(new Set(fechas).size).toBe(FECHAS_DISTINTAS);
    for (let i = 1; i < fechas.length; i += 1) {
      expect((fechas[i] ?? '') >= (fechas[i - 1] ?? '')).toBe(true);
    }
  });

  it('0 líneas no interpretadas', () => {
    expect(LEIDO.lineasNoInterpretadas).toEqual([]);
  });

  it('11 páginas declaradas por el pie', () => {
    expect(LEIDO.paginasDeclaradas).toBe(PAGINAS_TOTALES);
  });

  it('0 rupturas de cadena, y el estado de la cuenta en pesos es `cuadra`', () => {
    expect(CUENTA_ARS).toBeDefined();
    if (!CUENTA_ARS) return;
    const v = verificarAritmetica(CUENTA_ARS, {
      capacidades: CAPACIDADES_SANTANDER,
      cantidadLineasNoInterpretadas: LEIDO.lineasNoInterpretadas.length,
      movimientosEnElLote: CANTIDAD,
    });
    expect(v.filasConRuptura).toEqual([]);
    expect(v.diferencias).toEqual([]);
    expect(v.estado).toBe('cuadra');
    // §9: V2 no corre porque el banco no publica totales, y eso queda DECLARADO, no escondido.
    expect(v.verificoTotales).toBe(false);
    expect(v.verificoSaldos).toBe(true);
    expect(v.verificoCadena).toBe(true);
  });

  it('no hay duplicados: las 158 filas tienen hash distinto', () => {
    const hashes = new Set((CUENTA_ARS?.movimientos ?? []).map((m) => m.filaHash));
    expect(hashes.size).toBe(CANTIDAD);
  });
});

// -----------------------------------------------------------------------------
describe('§11.6 — dos cuentas con geometría IDÉNTICA', () => {
  /**
   * Lo único que separa las dos tablas es el título de sección y la cabecera de cuenta. Un adaptador que
   * las mezcle **igual cierra la cadena**, porque la segunda está vacía: por eso la separación se prueba
   * por número de cuenta, no por que la aritmética dé bien.
   */
  it('cada cuenta tiene SU número, y no el de la otra', () => {
    expect(CUENTA_ARS?.cuenta.numero).toBe(CUENTA_PESOS);
    expect(CUENTA_USD?.cuenta.numero).toBe(CUENTA_DOLARES);
    expect(CUENTA_ARS?.cuenta.numero).not.toBe(CUENTA_USD?.cuenta.numero);
  });

  it('la cuenta en dólares es `cuenta_corriente_especial`, no la misma cuenta en otra moneda', () => {
    expect(CUENTA_ARS?.cuenta.tipoCuenta).toBe('cuenta_corriente');
    expect(CUENTA_USD?.cuenta.tipoCuenta).toBe('cuenta_corriente_especial');
    expect(CUENTA_USD?.cuenta.denominacion).toContain('especial');
  });

  it('ningún movimiento de la cuenta en pesos quedó en la de dólares', () => {
    expect((CUENTA_ARS?.movimientos ?? []).every((m) => m.moneda === 'ARS')).toBe(true);
    expect(CUENTA_USD?.movimientos ?? []).toHaveLength(0);
  });

  it('funciona igual si la sección en dólares SÍ trae su cabecera adentro', () => {
    const leido = leerSantander(documentoSantander({ cabeceraDolaresEnLaSeccion: true }));
    expect(leido.cuentas).toHaveLength(2);
    expect(leido.cuentas[1]?.cuenta.numero).toBe(CUENTA_DOLARES);
    expect(leido.cuentas[1]?.cuenta.moneda).toBe('USD');
    expect(leido.lineasNoInterpretadas).toEqual([]);
  });

  /**
   * El CBU de la carátula **no se le pega a ninguna de las dos cuentas**: hay una sola etiqueta `CBU:` y
   * nada la ata a una de las dos. Y el CBU es la clave con la que se resuelve a qué cuenta bancaria van los
   * movimientos: asignarlo a las dos las haría resolver a la misma, con todo cuadrando.
   */
  it('con dos cuentas, el CBU de la carátula NO se asigna: queda no determinado', () => {
    expect(CUENTA_ARS?.cuenta.cbu).toBeUndefined();
    expect(CUENTA_USD?.cuenta.cbu).toBeUndefined();
  });

  it('con una sola cuenta, el CBU sí se asigna', () => {
    const doc = documentoMinimo(
      [
        [
          { texto: '01/06/26', x: X.fecha, ancho: ANCHO_FECHA.visible },
          { texto: 'Concepto sintetico 01', x: X.glosa },
          enBordeDerecho('$ 4.321,00', R.debito),
          enBordeDerecho('-$ 9.876,54', R.saldo, 60),
        ],
      ],
      { saldoTotal: -987_654n },
    );
    const conCbu = [
      filaGeometrica([{ texto: `CBU: ${CBU_SINTETICO}`, x: X.fecha }], 1, 900),
      ...doc,
    ];
    const leido = leerSantander(conCbu);
    expect(leido.cuentas).toHaveLength(1);
    expect(leido.cuentas[0]?.cuenta.cbu).toBe(CBU_SINTETICO);
  });

  it('el CUIT del titular se lee por etiqueta, nunca por patrón', () => {
    expect(CUENTA_ARS?.cuenta.titularDocumento).toBe(CUIT_SINTETICO);
  });
});

// -----------------------------------------------------------------------------
describe('§11.7 — la cuenta en dólares está vacía y es LEGÍTIMA', () => {
  it('se emite igual, con su saldo inicial y su saldo final leídos como `U$S`', () => {
    expect(CUENTA_USD?.cuenta.saldoInicialDeclarado).toBe('123.45');
    expect(CUENTA_USD?.cuenta.saldoFinalDeclarado).toBe('123.45');
  });

  /**
   * `EST_SIN_MOVIMIENTOS` es un error **por archivo**, no por cuenta: con `movimientosEnElLote` en 158, la
   * cuenta vacía queda como observación y el archivo correcto no se rechaza. Sin ese dato, el default es el
   * estricto y el lote entero se caería por una cuenta que el banco imprimió vacía a propósito.
   */
  it('sin movimientos en el lote sería un error; con 158 en el lote es una observación', () => {
    expect(CUENTA_USD).toBeDefined();
    if (!CUENTA_USD) return;

    const conLote = verificarAritmetica(CUENTA_USD, {
      capacidades: CAPACIDADES_SANTANDER,
      movimientosEnElLote: CANTIDAD,
    });
    expect(conLote.diferencias).toEqual([{ codigo: 'EST_SIN_MOVIMIENTOS', severidad: 'observacion' }]);
    expect(conLote.estado).toBe('no_verificable');

    const sinLote = verificarAritmetica(CUENTA_USD, { capacidades: CAPACIDADES_SANTANDER });
    expect(sinLote.diferencias[0]?.severidad).toBe('error');
  });
});

// -----------------------------------------------------------------------------
describe('§11.5 — `Saldo Inicial` es una fila con fecha y SIN importe', () => {
  it('no genera un movimiento y sí el saldo inicial declarado', () => {
    expect(CUENTA_ARS?.cuenta.saldoInicialDeclarado).toBe('-2000000.00');
    // Ninguno de los 158 movimientos tiene la etiqueta como concepto.
    expect(
      (CUENTA_ARS?.movimientos ?? []).some((m) => /Saldo Inicial/i.test(m.descripcion)),
    ).toBe(false);
  });

  it('la cadena arranca en el saldo inicial declarado: saldo(1) − importe(1) = semilla', () => {
    const primera = CUENTA_ARS?.movimientos[0];
    expect(primera).toBeDefined();
    if (!primera) return;
    const s = importeCanonicoACentavos(primera.saldo ?? '') ?? 0n;
    const i = importeCanonicoACentavos(primera.importe) ?? 0n;
    expect(s - i).toBe(SALDO_INICIAL_PESOS);
  });

  /**
   * Con la etiqueta pero **con** un importe en una columna, ya no es un saldo inicial. No se acepta —eso
   * metería un saldo inventado en la semilla de la cadena— y tampoco se inventa un movimiento: se reporta.
   */
  it('una fila `Saldo Inicial` CON importe se reporta, no se toma como semilla ni como movimiento', () => {
    const doc = documentoMinimo([
      [
        { texto: '30/05/26', x: X.fecha, ancho: ANCHO_FECHA.visible },
        { texto: 'Saldo Inicial', x: X.glosa },
        enBordeDerecho('$ 1.234,56', R.debito),
        enBordeDerecho('-$ 9.876,54', R.saldo, 60),
      ],
    ]);
    const leido = leerSantander(doc);
    expect(leido.cuentas[0]?.movimientos).toHaveLength(0);
    expect(leido.cuentas[0]?.cuenta.saldoInicialDeclarado).toBeUndefined();
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['desconocido']);
    // La forma, nunca el texto: ni el importe ni la fecha del original sobreviven.
    expect(leido.lineasNoInterpretadas[0]?.forma).not.toContain('1.234,56');
    expect(leido.lineasNoInterpretadas[0]?.forma).not.toContain('30/05/26');
    expect(leido.lineasNoInterpretadas[0]?.forma).toContain('##/##/##');
  });
});

// -----------------------------------------------------------------------------
describe('§11.3 — el anexo cae en las ventanas del cuerpo, y la región es lo que lo salva', () => {
  const regiones = regionesDeTabla(DOCUMENTO.map(textoDeFila), /^Fecha Comprobante Movimiento D[ée]bito Cr[ée]dito Saldo en cuenta$/, /^Saldo total(?!\s+en\s+cuentas)/);

  it('la trampa es real: el TNA del anexo entra en la ventana de débito `[404, 412]`', () => {
    const filaTna = DOCUMENTO.find((f) => textoDeFila(f).includes('51,00%'));
    expect(filaTna).toBeDefined();
    if (!filaTna) return;
    // Es el hecho medido: sin acotar la región, este `%` está adentro de la columna de débito.
    expect(fragmentoEnVentanaDerecha(filaTna, 404.0, 412.0)?.texto).toBe('51,00%');
  });

  it('...y esa fila está FUERA de toda región de tabla', () => {
    const indiceTna = DOCUMENTO.findIndex((f) => textoDeFila(f).includes('51,00%'));
    expect(indiceTna).toBeGreaterThan(0);
    expect(dentroDeAlgunaRegion(regiones, indiceTna)).toBe(false);
  });

  it('el anexo impositivo tampoco entra: ningún movimiento salió de esos renglones', () => {
    expect(
      (CUENTA_ARS?.movimientos ?? []).some((m) => /Renglon impositivo/i.test(m.descripcion)),
    ).toBe(false);
    // Y la cantidad sigue siendo exactamente 158: ni uno de más.
    expect(CUENTA_ARS?.movimientos).toHaveLength(CANTIDAD);
  });

  it('hay exactamente dos regiones —una por cuenta— con el encabezado repetido por página', () => {
    expect(regiones).toHaveLength(2);
    // 8 páginas de tabla para la cuenta en pesos: el encabezado repetido NO abre una región nueva.
    expect(regiones[0]?.repeticionesDeEncabezado).toBe(8);
    expect(regiones[1]?.repeticionesDeEncabezado).toBe(1);
  });

  /**
   * §8: las cabeceras de cuenta caen **DENTRO** de la región de tabla, y sin su regla propia se van a
   * `lineasNoInterpretadas` y el estado se va a `no_cuadra` por `EST_LINEA_NO_INTERPRETADA`.
   *
   * El número medido es **8 filas sin interpretar = 7 cabeceras + 1 nota al pie**, y el fixture lo
   * reproduce exacto: la cabecera de la página 2 está **antes** del primer encabezado de columnas, o sea
   * que abre la sección pero queda fuera del cuerpo; las de las páginas 3 a 9 —siete— caen adentro.
   */
  it('siete cabeceras y una nota al pie caen dentro de la región, y no ensucian nada', () => {
    const adentroDeLaRegion = (predicado: (t: string) => boolean): number[] =>
      DOCUMENTO.map((f, i) => ({ i, t: textoDeFila(f) }))
        .filter((x) => predicado(x.t) && dentroDeAlgunaRegion(regiones, x.i))
        .map((x) => x.i);

    expect(adentroDeLaRegion((t) => /^Cuenta Corriente.*Nº/.test(t))).toHaveLength(7);
    expect(adentroDeLaRegion((t) => /^\* Salvo error u omisión/.test(t))).toHaveLength(1);
    // Con las reglas de §8 puestas, las ocho se explican y no queda residuo.
    expect(LEIDO.lineasNoInterpretadas).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('§11.4 — `Saldo total` cae a 4 pt de la columna de saldo', () => {
  it('su importe queda FUERA de la ventana de saldo del cuerpo', () => {
    const filaTotal = DOCUMENTO.find((f) => textoDeFila(f).startsWith('Saldo total -$'));
    expect(filaTotal).toBeDefined();
    if (!filaTotal) return;
    // r = 574.0 contra la ventana [574.5, 582] del cuerpo: disjuntas por medio punto.
    expect(fragmentoEnVentanaDerecha(filaTotal, 574.5, 582.0)).toBeUndefined();
    expect(fragmentoEnVentanaDerecha(filaTotal, 571.0, 576.0)).toBeDefined();
  });

  it('se lee como saldo final declarado y coincide con el último saldo del cuerpo', () => {
    const ultimo = CUENTA_ARS?.movimientos.at(-1);
    expect(CUENTA_ARS?.cuenta.saldoFinalDeclarado).toBe(ultimo?.saldo);
  });

  /**
   * La otra mitad de la trampa: la etiqueta está en `x ≈ 386.7`, encima del encabezado `Débito` (385.6). Un
   * clasificador por columna la leería como un débito enorme. Lo que lo impide no es una ventana: es que la
   * fila de cierre queda **fuera** del cuerpo de la región.
   */
  it('la etiqueta no produce ningún movimiento con la glosa `Saldo total`', () => {
    expect((CUENTA_ARS?.movimientos ?? []).some((m) => /Saldo total/i.test(m.descripcion))).toBe(
      false,
    );
  });
});

// -----------------------------------------------------------------------------
describe('§8 — el pie es `N - M`, no `Página N / M`', () => {
  it('la regla genérica de `RUIDO_COMUN` no matchea el pie de este banco', () => {
    const reglaPie = RUIDO_COMUN.find((r) => r.tipo === 'pie');
    expect(reglaPie).toBeDefined();
    expect(reglaPie?.patron.test('7 - 11')).toBe(false);
  });

  it('anclado por `x`: el pie se descarta y publica el total de páginas', () => {
    expect(LEIDO.paginasDeclaradas).toBe(PAGINAS_TOTALES);
    expect(LEIDO.lineasNoInterpretadas).toEqual([]);
  });

  /**
   * `/^\d+ - \d+$/` suelto es peligrosamente genérico. Una fila con esa forma **en otra posición** no es un
   * pie: se reporta en vez de descartarse, que es la regla del contrato.
   */
  it('la misma forma en otra `x` NO es un pie: se reporta', () => {
    const doc = documentoMinimo([[{ texto: '7 - 11', x: X.glosa }]]);
    const leido = leerSantander(doc);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['linea_fuera_de_zona']);
  });
});

// -----------------------------------------------------------------------------
describe('§11.10 — el período está en dos filas distintas', () => {
  it('se lee de las dos etiquetas y queda en las dos cuentas', () => {
    expect(CUENTA_ARS?.cuenta.periodoDesde).toBe('2026-05-30');
    expect(CUENTA_ARS?.cuenta.periodoHasta).toBe('2026-06-30');
    expect(CUENTA_USD?.cuenta.periodoDesde).toBe('2026-05-30');
  });

  it('las 158 fechas caen dentro del período', () => {
    for (const m of CUENTA_ARS?.movimientos ?? []) {
      expect(m.fecha >= '2026-05-30' && m.fecha <= '2026-06-30').toBe(true);
    }
  });

  /**
   * Sin período no hay control de fechas. Se falla con **código**, no se emiten cuentas sin período: seguir
   * adelante apagaría V7 en silencio, que es el modo de falla que el módulo entero existe para evitar.
   */
  it('si falta una de las dos etiquetas, falla con código y sin texto del archivo', () => {
    const doc = documentoMinimo([], { conHasta: false });
    expect(() => leerSantander(doc)).toThrow(ErrorDeAdaptador);
    try {
      leerSantander(doc);
    } catch (error) {
      expect(error).toBeInstanceOf(ErrorDeAdaptador);
      if (error instanceof ErrorDeAdaptador) expect(error.codigo).toBe('periodo_no_reconocido');
    }
  });
});

// -----------------------------------------------------------------------------
describe('§11.2 — la fecha repetida sale con ancho ≈ 0', () => {
  it('el borde derecho de la columna de fecha vale 23.4 o 58.5: `Fragmento.ancho` miente', () => {
    const repetida = DOCUMENTO.find((f) =>
      f.fragmentos.some((g) => g.x === X.fecha && g.ancho === ANCHO_FECHA.repetida),
    );
    const visible = DOCUMENTO.find((f) =>
      f.fragmentos.some((g) => g.x === X.fecha && g.ancho === ANCHO_FECHA.visible),
    );
    expect(repetida).toBeDefined();
    expect(visible).toBeDefined();
    if (!repetida || !visible) return;

    const bordeRepetida = X.fecha + ANCHO_FECHA.repetida;
    const bordeVisible = X.fecha + ANCHO_FECHA.visible;
    expect(bordeRepetida).toBeCloseTo(23.4, 5);
    expect(bordeVisible).toBeCloseTo(58.5, 5);

    // Una ventana derecha que sirviera para una NO sirve para la otra: por eso la fecha se lee por su
    // borde izquierdo con `fragmentoEnX`, y no con `fragmentoEnVentanaDerecha`.
    expect(fragmentoEnVentanaDerecha(repetida, 57.0, 60.0)).toBeUndefined();
  });

  it('las 158 fechas se leen igual: el adaptador no arrastra la del movimiento anterior', () => {
    // Si se arrastrara, la cantidad de fechas distintas cambiaría y la monotonía taparía el fallo.
    expect(new Set((CUENTA_ARS?.movimientos ?? []).map((m) => m.fecha)).size).toBe(
      FECHAS_DISTINTAS,
    );
    expect((CUENTA_ARS?.movimientos ?? []).every((m) => m.fecha !== '')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
describe('§3 — la tolerancia de 1.2 pt en la columna de fecha', () => {
  /**
   * Medido: el bloque `Tasas de Acuerdos y Descubierto` tiene su fecha en `x = 25.0`, a 2.0 pt de la
   * columna. Con tolerancia 2.5 sus dos filas entran como movimientos. Acá la fila se pone **adentro** de
   * la región para probar la tolerancia sola, sin la protección de la región.
   */
  it('una fecha a 2.0 pt de la columna NO abre un movimiento', () => {
    const doc = documentoMinimo([
      [
        { texto: '30/06/26', x: X.fechaDelAnexo, ancho: ANCHO_FECHA.visible },
        enBordeDerecho('51,00%', R.tna, 30),
        enBordeDerecho('71,00%', R.cftea, 30),
      ],
    ]);
    const leido = leerSantander(doc);
    expect(leido.cuentas[0]?.movimientos).toHaveLength(0);
    // Y no se descarta en silencio: se reporta con su forma.
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['linea_fuera_de_zona']);
  });
});

// -----------------------------------------------------------------------------
describe('§11.11 — el concepto no dice el signo, y a veces dice lo contrario', () => {
  /**
   * Medido en el archivo real: un mismo concepto aparece con **6 débitos y 11 créditos**, con el mismo
   * número de comprobante. Cualquier mapeo por palabra clave se equivoca en al menos 27 de 158 filas.
   */
  it('el mismo concepto y el mismo comprobante, en las dos columnas, dan signos opuestos', () => {
    // Los tres importes se CALCULAN y la cadena cierra: el débito baja el saldo y el crédito lo devuelve.
    const magnitud = 123_456n;
    const saldoUno = -76_543_210n;
    const doc = documentoMinimo([
      [
        { texto: '01/06/26', x: X.fecha, ancho: ANCHO_FECHA.visible },
        { texto: '100001', x: X.comprobante },
        { texto: 'Concepto sintetico credito', x: X.glosa },
        enBordeDerecho(importeDelBanco(magnitud, '$'), R.debito),
        enBordeDerecho(importeDelBanco(saldoUno, '$'), R.saldo, 60),
      ],
      [
        { texto: '02/06/26', x: X.fecha, ancho: ANCHO_FECHA.visible },
        { texto: '100001', x: X.comprobante },
        { texto: 'Concepto sintetico credito', x: X.glosa },
        enBordeDerecho(importeDelBanco(magnitud, '$'), R.credito),
        enBordeDerecho(importeDelBanco(saldoUno + magnitud, '$'), R.saldo, 60),
      ],
    ]);
    const movimientos = leerSantander(doc).cuentas[0]?.movimientos ?? [];
    expect(movimientos).toHaveLength(2);
    expect(movimientos[0]?.columnaOrigen).toBe('debito');
    expect(movimientos[0]?.importe).toBe('-1234.56');
    expect(movimientos[1]?.columnaOrigen).toBe('credito');
    expect(movimientos[1]?.importe).toBe('1234.56');
    // El concepto es el mismo en los dos: la palabra "credito" no decidió nada.
    expect(movimientos[0]?.conceptoBanco).toBe(movimientos[1]?.conceptoBanco);
  });

  /**
   * La trampa de portar el lector del primer banco: con `traeSignoEnElImporte: true` el signo del token
   * tiene que coincidir con la columna, y acá el token **nunca** trae signo → 0 movimientos.
   */
  it('un token FIRMADO en la columna de importe no se acepta como negativo', () => {
    const doc = documentoMinimo([
      [
        { texto: '01/06/26', x: X.fecha, ancho: ANCHO_FECHA.visible },
        { texto: 'Concepto sintetico 01', x: X.glosa },
        enBordeDerecho('-$ 1.234,56', R.debito),
        enBordeDerecho('-$ 765.432,10', R.saldo, 60),
      ],
    ]);
    const leido = leerSantander(doc);
    expect(leido.cuentas[0]?.movimientos).toHaveLength(0);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['fila_sin_importe']);
  });
});

// -----------------------------------------------------------------------------
describe('§11.9 — la glosa con un importe embebido', () => {
  it('el importe de la glosa no entra en ninguna columna: la geometría lo mantiene afuera', () => {
    const conBase = (CUENTA_ARS?.movimientos ?? []).filter((m) =>
      m.descripcion.includes('Base de calculo'),
    );
    expect(conBase.length).toBeGreaterThan(0);
    for (const m of conBase) {
      // El importe del movimiento es el de su columna, no el de la glosa.
      expect(m.descripcion).toContain('987,65');
      expect(m.importe).not.toContain('987.65');
    }
  });
});

// -----------------------------------------------------------------------------
describe('el contrato: nada se descarta en silencio y nada del archivo llega a un mensaje', () => {
  it('toda línea no interpretada lleva FORMA, nunca texto', () => {
    const doc = documentoMinimo([[{ texto: 'Linea sintetica 12345 que nadie explica', x: 300.0 }]]);
    const leido = leerSantander(doc);
    expect(leido.lineasNoInterpretadas).toHaveLength(1);
    const l = leido.lineasNoInterpretadas[0];
    // Los dígitos salen enmascarados con `#` y ningún token del original sobrevive. (Lo que sí aparece es
    // `a{9}`, el colapso de corridas largas que hace `formaParaLog`: es un conteo, no un valor.)
    expect(l?.forma).toContain('#####');
    expect(l?.forma).not.toContain('12345');
    expect(l?.forma).not.toContain('sintetica');
    expect(l?.paginaPdf).toBe(2);
  });

  it('sin encabezado de tabla no se inventa una región: falla con código', () => {
    const h = hoja();
    h.agregar([{ texto: `CUIT: ${CUIT_SINTETICO}`, x: X.fecha }]);
    h.agregar([{ texto: 'Desde: 30/05/26', x: X.fecha }]);
    h.agregar([{ texto: 'Hasta: 30/06/26', x: X.fecha }]);
    try {
      leerSantander(h.filas);
      expect.unreachable('tendría que haber fallado');
    } catch (error) {
      expect(error).toBeInstanceOf(ErrorDeAdaptador);
      if (error instanceof ErrorDeAdaptador) expect(error.codigo).toBe('layout_inesperado');
    }
  });

  it('no publica consolidado por moneda: la ausencia no es "cuadra"', () => {
    expect(LEIDO.consolidadosPorMoneda).toBeUndefined();
    expect(CAPACIDADES_SANTANDER.traeConsolidadoPorMoneda).toBe(false);
  });

});

// -----------------------------------------------------------------------------
// §9 — los dos bloques de anexo: 7 renglones que antes desaparecían
// -----------------------------------------------------------------------------

/** Todos los anexos del lote. Cuelgan de la primera cuenta; **de qué cuenta son lo dice la atribución.** */
const ANEXOS = CUENTA_ARS?.anexos ?? [];
const anexoPorLiteral = (aguja: string): AnexoExtracto | undefined =>
  ANEXOS.find((a) => a.conceptoLiteral.includes(aguja));

describe('§9 — los 7 renglones de los dos bloques', () => {
  /**
   * 🔴 **El hallazgo que motivó todo esto.** Este adaptador sacaba `anexos = 0` **y**
   * `lineasNoInterpretadas = 0`: los 7 renglones fiscales de la p9 no estaban en ninguna de las dos listas,
   * o sea que desaparecían sin dejar rastro — y eso lo hacía parecer el mejor del roster cuando era el que
   * más perdía. Comparado: otro banco tenía sus 9 renglones **en el residuo** (se veían) y otro capturaba 3
   * de 6. Este test es el que impide volver a ese estado.
   */
  it('captura los 5 del `Detalle impositivo` y los 2 de `Tasas`, y ninguno queda en el residuo', () => {
    expect(ANEXOS).toHaveLength(ANEXOS_ESPERADOS);
    expect(LEIDO.lineasNoInterpretadas).toEqual([]);
    // Y no se duplican colgándolos de las dos cuentas: eso reventaría `uq_anexo_orden`.
    expect(CUENTA_USD?.anexos).toEqual([]);
  });

  it('los 7 validan contra `anexoExtractoSchema`, con sus dos `refine` de coherencia', () => {
    for (const a of ANEXOS) {
      const r = anexoExtractoSchema.safeParse(a);
      expect(r.success, JSON.stringify(r.error?.issues ?? [])).toBe(true);
    }
  });

  it('`ordenEnLote` es 1-based, consecutivo y en orden de lectura: es la identidad de la fila', () => {
    expect(ANEXOS.map((a) => a.ordenEnLote)).toEqual(
      Array.from({ length: ANEXOS_ESPERADOS }, (_, i) => i + 1),
    );
    // El bloque impositivo va primero en el documento, así que se lleva los primeros ordinales.
    expect(ANEXOS.slice(0, RENGLONES_IMPOSITIVOS.length).map((a) => a.conceptoLiteral)).toEqual([
      ...RENGLONES_IMPOSITIVOS,
    ]);
  });

  it('todos salen de la p9 y con la moneda del símbolo que imprime el banco', () => {
    for (const a of ANEXOS) {
      expect(a.paginaPdf).toBe(9);
      expect(a.moneda).toBe('ARS');
      expect(a.tipoFila).toBe('anexo');
    }
  });
});

// -----------------------------------------------------------------------------
describe('§9 — `periodoDato`: cuatro situaciones, y NINGUNA se rellena con el período del extracto', () => {
  /**
   * 🔴 El invariante del esquema, verificado sobre el resultado: el extracto va del `2026-05-30` al
   * `2026-06-30`, y **ningún** renglón que no publique su rango lo hereda. Un anexo con el período del
   * extracto es un hecho fiscal fabricado que cuadra.
   */
  it('ningún renglón hereda el período del extracto', () => {
    for (const a of ANEXOS) {
      if (a.periodoDato === 'publicado_completo') continue;
      expect(a.periodoDesde).toBeUndefined();
    }
    expect(CUENTA_ARS?.cuenta.periodoDesde).toBe('2026-05-30');
    expect(ANEXOS.filter((a) => a.periodoDesde === '2026-05-30')).toHaveLength(0);
  });

  it('el único que publica su rango sale `publicado_completo`, con `dd-mm-aaaa` parseado a ISO', () => {
    const a = anexoPorLiteral('Totales de retencion');
    expect(a?.periodoDato).toBe('publicado_completo');
    expect(a?.periodoDesde).toBe('2026-06-01');
    expect(a?.periodoHasta).toBe('2026-06-30');
  });

  /**
   * 🔴 `periodo_de_emision` **no es `no_publicado`**: acá el banco declara cuál es el período —`… en el
   * período de emisión`— sin imprimir las fechas, y la resolución la hace el Módulo 2 explícitamente. Si esto
   * cayera en `no_publicado`, el dato de que el banco lo dijo se perdería para siempre.
   */
  it('el SIRCREB sale `periodo_de_emision`, sin fechas y sin confundirse con `no_publicado`', () => {
    const a = anexoPorLiteral('SIRCREB');
    expect(a?.periodoDato).toBe('periodo_de_emision');
    expect(a?.periodoDesde).toBeUndefined();
    expect(a?.periodoHasta).toBeUndefined();
  });

  it('los que no dicen nada salen `no_publicado`, que es otra cosa', () => {
    expect(anexoPorLiteral('por debitos')?.periodoDato).toBe('no_publicado');
    expect(anexoPorLiteral('Importe susceptible')?.periodoDato).toBe('no_publicado');
    // Y los dos renglones de tasas: su fecha es la vigencia de la tasa, NO el período del importe.
    for (const rotulo of RENGLONES_DE_TASAS) {
      expect(anexoPorLiteral(rotulo)?.periodoDato).toBe('no_publicado');
      expect(anexoPorLiteral(rotulo)?.periodoHasta).toBeUndefined();
    }
  });

  /** La variante `DEL PERIODO AL <fecha>` de otro banco del roster: acá se prueba la rama, no el archivo. */
  it('un rango sin inicio sale `publicado_solo_hasta`, no `publicado_completo` a medias', () => {
    const leido = leerSantander(
      documentoConAnexo([
        [
          { texto: 'Renglon sintetico del periodo al 30-06-2026', x: X.fecha },
          enBordeDerecho('$ 1.111,11', R.anexoImpositivo),
        ],
      ]),
    );
    const a = leido.cuentas[0]?.anexos[0];
    expect(a?.periodoDato).toBe('publicado_solo_hasta');
    expect(a?.periodoDesde).toBeUndefined();
    expect(a?.periodoHasta).toBe('2026-06-30');
  });

  /**
   * Un renglón que **declara** un rango y cuyas fechas no se pueden leer es un hallazgo, no un
   * `no_publicado`: degradarlo escondería que el bloque cambió de forma. Va al residuo con su forma.
   */
  it('un rango declarado con fechas ilegibles va al residuo, no se degrada a `no_publicado`', () => {
    const leido = leerSantander(
      documentoConAnexo([
        [
          { texto: 'Renglon sintetico del 99-99-2026 al 98-98-2026', x: X.fecha },
          enBordeDerecho('$ 1.111,11', R.anexoImpositivo),
        ],
      ]),
    );
    expect(leido.cuentas[0]?.anexos).toEqual([]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['fecha_ilegible']);
    expect(leido.lineasNoInterpretadas[0]?.forma).not.toContain('2026');
  });
});

// -----------------------------------------------------------------------------
describe('§9 — `relacionConMovimientos`: el campo que impide contar el impuesto dos veces', () => {
  /**
   * 🔴 §9: el `Detalle impositivo` **resume impuestos que YA están como movimientos** (los 21+19 del impuesto
   * al cheque y los 8 del SIRCREB). Sumarlos contaría el impuesto dos veces **y el asiento cuadraría igual**,
   * que es la peor clase de error de este dominio.
   */
  it('los que resumen el cuerpo van a `resume_movimientos_del_cuerpo`', () => {
    expect(anexoPorLiteral('Totales de retencion')?.relacionConMovimientos).toBe(
      'resume_movimientos_del_cuerpo',
    );
    expect(anexoPorLiteral('por debitos')?.relacionConMovimientos).toBe(
      'resume_movimientos_del_cuerpo',
    );
    expect(anexoPorLiteral('SIRCREB')?.relacionConMovimientos).toBe('resume_movimientos_del_cuerpo');
    // §9: el `Interés cobrado` del bloque de tasas también está en el cuerpo.
    for (const rotulo of RENGLONES_DE_TASAS) {
      expect(anexoPorLiteral(rotulo)?.relacionConMovimientos).toBe('resume_movimientos_del_cuerpo');
    }
  });

  /**
   * 🔴 El renglón que **no existe como movimiento y no es derivable de ellos**: es el único candidato a
   * registración de todo el bloque, y era el que se perdía sin dejar rastro. Es también la única salida que
   * NO es fail-closed, por eso se emite solo contra su literal explícito.
   */
  it('el importe computable va a `no_esta_en_los_movimientos`, y es el único', () => {
    expect(anexoPorLiteral('Importe susceptible')?.relacionConMovimientos).toBe(
      'no_esta_en_los_movimientos',
    );
    expect(ANEXOS.filter((a) => a.relacionConMovimientos === 'no_esta_en_los_movimientos')).toHaveLength(1);
  });

  /** Fail-closed: un rótulo que el adaptador no reconoce **no** se declara registrable. */
  it('un rótulo desconocido cae en `no_determinada`, nunca en `no_esta_en_los_movimientos`', () => {
    const leido = leerSantander(
      documentoConAnexo([
        [
          { texto: 'Rotulo sintetico que nadie mapeo', x: X.fecha },
          enBordeDerecho('$ 2.222,22', R.anexoImpositivo),
        ],
      ]),
    );
    expect(leido.cuentas[0]?.anexos[0]?.relacionConMovimientos).toBe('no_determinada');
  });

  /**
   * 🔴 **INV-15, sobre el resultado y no sobre la intención.** Ninguno de los 7 importes del anexo aparece en
   * la suma de los 158 movimientos. Se verifica contra la suma que calcula el verificador —no contra una
   * lista escrita a mano— porque la prohibición *"no lo sumes"* es lo que nadie puede chequear.
   */
  it('los importes del anexo NO entran en la suma de movimientos', () => {
    expect(CUENTA_ARS).toBeDefined();
    if (!CUENTA_ARS) return;

    const v = verificarAritmetica(CUENTA_ARS, {
      capacidades: CAPACIDADES_SANTANDER,
      cantidadLineasNoInterpretadas: LEIDO.lineasNoInterpretadas.length,
      movimientosEnElLote: CANTIDAD,
    });
    // La cadena sigue cerrando con los anexos adentro del objeto: no tocaron ninguna suma.
    expect(v.estado).toBe('cuadra');
    expect(v.cantidadMovimientos).toBe(CANTIDAD);

    // Y ningún importe del anexo es el importe de ningún movimiento del fixture: los dos conjuntos de
    // magnitudes son disjuntos por construcción (7.777·n y 31.337·n contra 13.711·(i+1)+4.321).
    const magnitudesDeMovimientos = new Set(
      (CUENTA_ARS.movimientos ?? []).map((m) => m.importe.replace('-', '')),
    );
    for (const a of ANEXOS) {
      expect(magnitudesDeMovimientos.has(a.importeDeclarado), a.importeDeclarado).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
describe('§9 — `atribucionCuenta`: no se inventa de qué cuenta es', () => {
  /**
   * Los dos bloques están **después** del `Saldo total` de las dos cuentas, así que no hay evidencia
   * posicional de a cuál pertenecen. Que el objeto cuelgue de la primera cuenta es transporte:
   * `persistirCuenta` graba `cuenta_bancaria_id` en null cuando la atribución es `no_determinada`.
   */
  it('con dos cuentas, los 7 salen `no_determinada`', () => {
    for (const a of ANEXOS) expect(a.atribucionCuenta).toBe('no_determinada');
  });

  /**
   * Con una sola cuenta la atribución es cierta **por aritmética**, y va en un valor distinto a propósito: el
   * día que este banco mande un archivo de dos cuentas, la deducción deja de valer — y con un solo valor ese
   * cambio sería invisible.
   */
  it('con una sola cuenta pasa a `cuenta_unica_del_lote`, que es otra evidencia', () => {
    const leido = leerSantander(
      documentoConAnexo([
        [
          { texto: 'Renglon sintetico sin periodo', x: X.fecha },
          enBordeDerecho('$ 3.333,33', R.anexoImpositivo),
        ],
      ]),
    );
    expect(leido.cuentas).toHaveLength(1);
    expect(leido.cuentas[0]?.anexos[0]?.atribucionCuenta).toBe('cuenta_unica_del_lote');
  });
});

// -----------------------------------------------------------------------------
describe('§9 — la alícuota es un LITERAL, nunca un número', () => {
  it('la del `Detalle impositivo` sale del rótulo, con su coma y su `%`', () => {
    const a = anexoPorLiteral('alicuota');
    expect(a?.alicuotaPublicada).toBe('33,00 %');
    // Y el rótulo la conserva: es lo que el banco imprime, no se le saca nada.
    expect(a?.conceptoLiteral).toContain('alicuota 33,00 %');
  });

  /**
   * §11.3: el bloque de tasas publica **dos** —el TNA (`r=407.0`) y el CFTEA (`487.0`)—. El esquema tiene un
   * solo campo, así que van las dos en orden de lectura: quedarse con una perdería un dato publicado, que es
   * exactamente lo que este trabajo vino a arreglar. Distinguirlas necesitaría una columna más.
   */
  it('el bloque de tasas publica dos y no se pierde ninguna', () => {
    expect(anexoPorLiteral(RENGLONES_DE_TASAS[0])?.alicuotaPublicada).toBe('51,00% 71,00%');
    expect(anexoPorLiteral(RENGLONES_DE_TASAS[1])?.alicuotaPublicada).toBe('52,00% 72,00%');
  });

  it('los renglones sin alícuota no la traen: no se inventa un `0,00%`', () => {
    expect(anexoPorLiteral('SIRCREB')?.alicuotaPublicada).toBeUndefined();
    expect(anexoPorLiteral('Importe susceptible')?.alicuotaPublicada).toBeUndefined();
  });

  /** El `##,##%` del TNA cae **dentro** de la ventana de débito (§11.3) y aun así no es un importe. */
  it('una alícuota nunca se toma por el importe del renglón', () => {
    for (const a of ANEXOS) {
      expect(a.importeDeclarado).not.toContain('%');
      expect(a.importeDeclarado).toMatch(/^\d+\.\d{2}$/);
    }
  });
});

// -----------------------------------------------------------------------------
describe('§9 — los renglones del anexo dejan de ser invisibles', () => {
  /**
   * 🔴 El criterio nuevo, y la mitad del arreglo: capturar 5 de 7 y tirar 2 en silencio deja el mismo agujero
   * que tirar los 7, solo que más chico. Un renglón sin importe legible **se reporta con su forma**.
   */
  it('un renglón del bloque sin importe va a `lineasNoInterpretadas`, con su forma', () => {
    const leido = leerSantander(
      documentoConAnexo([[{ texto: 'Renglon sintetico sin ningun importe', x: X.fecha }]]),
    );
    expect(leido.cuentas[0]?.anexos).toEqual([]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['fila_sin_importe']);
    const l = leido.lineasNoInterpretadas[0];
    expect(l?.paginaPdf).toBe(2);
    // La forma, nunca el texto.
    expect(l?.forma).not.toContain('Renglon');
    expect(l?.forma).toContain('A');
  });

  /**
   * 🔴 La puerta de admisión de `anexo_literal_sin_identificador_chk` (migración 0008): **ninguna corrida de
   * 7+ dígitos** entra al literal. Se verifica acá y no en la base para que el operador reciba un renglón
   * reportado y no una violación de constraint que se lleva puesto el lote entero.
   */
  it('un literal con una corrida de 7 dígitos no se emite: se reporta', () => {
    const leido = leerSantander(
      documentoConAnexo([
        [
          // Una fecha `ddmmaaaa` pegada sin separadores es el caso realista de 8 dígitos seguidos.
          { texto: 'Renglon sintetico 01062026 sin separadores', x: X.fecha },
          enBordeDerecho('$ 4.444,44', R.anexoImpositivo),
        ],
      ]),
    );
    expect(leido.cuentas[0]?.anexos).toEqual([]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['desconocido']);
  });

  /** Y los literales que este banco sí imprime pasan: la corrida más larga es de 5 (`25413`). */
  it('los 7 literales medidos pasan la puerta de admisión', () => {
    for (const a of ANEXOS) expect(a.conceptoLiteral).not.toMatch(/\d{7}/);
  });

  /** Un importe negativo en el anexo no se convierte a magnitud: `importeDeclarado` es no signado. */
  it('un importe negativo se reporta en vez de emitirse como magnitud', () => {
    const leido = leerSantander(
      documentoConAnexo([
        [
          { texto: 'Renglon sintetico con importe negativo', x: X.fecha },
          enBordeDerecho('-$ 5.555,55', R.anexoImpositivo),
        ],
      ]),
    );
    expect(leido.cuentas[0]?.anexos).toEqual([]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['desconocido']);
  });

  /**
   * El bloque de tasas lee su importe **por parseo, no por posición**: §9 nombra el `Interés cobrado` pero no
   * publica su `x`. Este test lo corre con otra coordenada para que el fixture no cablee un supuesto.
   */
  it('el importe del bloque de tasas no depende de una `x` que la spec no mide', () => {
    const conOtraX = documentoSantander({ bordeDelInteresCobrado: 500.0 });
    const anexos = leerSantander(conOtraX).cuentas[0]?.anexos ?? [];
    expect(anexos).toHaveLength(ANEXOS_ESPERADOS);
    expect(leerSantander(conOtraX).lineasNoInterpretadas).toEqual([]);
  });

  /** El bloque termina al cambiar de página: si no, se comería las dos hojas de leyendas legales. */
  it('el bloque no se come las páginas de legales que vienen después', () => {
    expect(ANEXOS.every((a) => a.paginaPdf === 9)).toBe(true);
    expect(LEIDO.lineasNoInterpretadas).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('toda fila tiene un DESTINO declarado, y la partición se cuenta', () => {
  const { destinos } = leerSantanderConDestinos(DOCUMENTO);

  /**
   * 🔴 `"fuera de la región de tabla"` no es un destino, es una ubicación — y mientras se usó como destino,
   * los 7 renglones del anexo se iban por ahí. `sinDestino` en 0 es lo que convierte *"toda fila está
   * explicada"* en un hecho medido, igual que `residuoDeParticion` en el toolkit.
   */
  it('la partición cierra: ninguna fila queda sin destino', () => {
    expect(destinos.total).toBe(DOCUMENTO.length);
    expect(destinos.sinDestino).toBe(0);
    const suma =
      destinos.movimiento +
      destinos.continuacion +
      destinos.saldoDeclarado +
      destinos.ruido +
      destinos.anexo +
      destinos.fueraDelCuerpo +
      destinos.residuo;
    expect(suma).toBe(DOCUMENTO.length);
  });

  it('cada recuento coincide con lo que el lector devolvió: no es una declaración aparte', () => {
    expect(destinos.movimiento).toBe(CANTIDAD);
    expect(destinos.continuacion).toBe(CON_CONTINUACION);
    expect(destinos.anexo).toBe(ANEXOS_ESPERADOS);
    expect(destinos.residuo).toBe(LEIDO.lineasNoInterpretadas.length);
    // 2 `Saldo Inicial` + 2 `Saldo total`, uno de cada por cuenta (§8: son datos, no ruido).
    expect(destinos.saldoDeclarado).toBe(4);
  });

  /**
   * `fueraDelCuerpo` es la carátula y las leyendas legales (§1: 129 de 414 en el archivo medido). Se **cuenta**
   * y no pone el lote en rojo, al revés de `residuo` — pero deja de ser invisible, que era el punto.
   */
  it('la carátula y los legales quedan contados, no desaparecidos', () => {
    // El recuento entero, exacto. Cualquier fila que cambie de destino se ve acá y no en un promedio.
    expect(destinos).toEqual({
      movimiento: CANTIDAD,
      continuacion: CON_CONTINUACION,
      saldoDeclarado: 4,
      ruido: 38,
      anexo: ANEXOS_ESPERADOS,
      /**
       * 5 de la carátula (`Resumen`, `CUIT:`, `CBU:`, `Desde:`, `Hasta:`) + 2 leyendas legales de p10/p11.
       * Las dos cabeceras de cuenta, el consolidado ilegible, el título de sección y los pies **no** están
       * acá: cada uno tiene su regla y cuenta como `ruido`.
       */
      fueraDelCuerpo: 7,
      residuo: 0,
      sinDestino: 0,
      total: DOCUMENTO.length,
    });
  });
});

// -----------------------------------------------------------------------------
// §9 — el renglón que NO entra en una fila
// -----------------------------------------------------------------------------

/**
 * Las dos formas de envolver un renglón de anexo, y por qué están acá.
 *
 * El caso está **medido en el tercer banco del roster** (`07-formato-macro.md` §9, trampa 3): la etiqueta en
 * una fila y su importe en la de abajo. En Santander **no está medido**: lo que hay es el residuo del archivo
 * real, con dos filas con forma de rótulo y código `fila_sin_importe`. Estos tests no afirman que el archivo
 * tenga el caso — ejercitan el **mecanismo**, que es lo que hace que la próxima corrida distinga entre las
 * dos hipótesis en vez de confirmar cualquiera. La predicción numérica está escrita en `leerAnexos`.
 *
 * 🔴 Todo lo de acá es **inventado**: rótulos sintéticos e importes de una escalera propia.
 */

/** Una fila del bloque cuyo ÚNICO contenido es el importe, en el borde derecho medido de §9. */
const filaDeImporteSuelto = (texto: string): readonly FragmentoDePrueba[] => [
  enBordeDerecho(texto, R.anexoImpositivo),
];

/** Un rótulo sin importe propio: solo texto, como los renglones del `Detalle impositivo`. */
const filaDeRotulo = (texto: string): readonly FragmentoDePrueba[] => [{ texto, x: X.fecha }];

describe('§9 — un rótulo cuyo importe está en una fila posterior', () => {
  it('el rótulo y el importe de abajo se aparean en UN renglón, y no queda residuo', () => {
    const { salida, destinos } = leerSantanderConDestinos(
      documentoConAnexo([
        filaDeRotulo('Renglon sintetico con el importe abajo'),
        filaDeImporteSuelto('$ 1.111,11'),
      ]),
    );
    const anexos = salida.cuentas[0]?.anexos ?? [];
    expect(anexos).toHaveLength(1);
    expect(anexos[0]?.conceptoLiteral).toBe('Renglon sintetico con el importe abajo');
    expect(anexos[0]?.importeDeclarado).toBe('1111.11');
    // La página es la de la ETIQUETA, no la de donde cayó el importe.
    expect(anexos[0]?.paginaPdf).toBe(2);
    expect(salida.lineasNoInterpretadas).toEqual([]);
    /**
     * El conteo, que es lo que hace verificable el apareo: las **dos** filas quedan con destino `anexo` —una
     * emite y la otra aporta su importe— y las dos salen del residuo. O sea `anexos + 1` y residuo `− 2`,
     * que es distinto del `+1 / −1` del importe tapado. Ver la tabla de `leerAnexos`.
     */
    expect(destinos.anexo).toBe(2);
    expect(destinos.residuo).toBe(0);
  });

  /**
   * 🔴 El modo de falla que hace falta escribir como test porque **el lote cuadra igual**: los dos importes
   * se emiten, ningún control los cruza contra su rótulo, y el único síntoma es un impuesto atribuido al
   * concepto equivocado. Aparear por cercanía da vuelta este par.
   */
  it('el apareo es en orden de lectura: dos rótulos consecutivos NO se cruzan los importes', () => {
    const leido = leerSantander(
      documentoConAnexo([
        filaDeRotulo('Renglon sintetico primero'),
        filaDeRotulo('Renglon sintetico segundo'),
        filaDeImporteSuelto('$ 1.111,11'),
        filaDeImporteSuelto('$ 2.222,22'),
      ]),
    );
    const anexos = leido.cuentas[0]?.anexos ?? [];
    expect(anexos.map((a) => [a.conceptoLiteral, a.importeDeclarado, a.ordenEnLote])).toEqual([
      ['Renglon sintetico primero', '1111.11', 1],
      ['Renglon sintetico segundo', '2222.22', 2],
    ]);
    expect(leido.lineasNoInterpretadas).toEqual([]);
  });

  it('un rótulo que se queda sin importe vuelve al residuo con su forma: nunca un anexo en cero', () => {
    const leido = leerSantander(
      documentoConAnexo([
        filaDeRotulo('Renglon sintetico con importe'),
        filaDeImporteSuelto('$ 3.333,33'),
        filaDeRotulo('Renglon sintetico que se queda sin nada'),
      ]),
    );
    const anexos = leido.cuentas[0]?.anexos ?? [];
    expect(anexos.map((a) => a.importeDeclarado)).toEqual(['3333.33']);
    // Ni un `importeDeclarado` en cero, ni el importe del renglón de arriba repetido.
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['fila_sin_importe']);
    const l = leido.lineasNoInterpretadas[0];
    expect(l?.forma).not.toContain('Renglon');
    expect(l?.forma).toContain('A');
  });

  it('un importe que aparece ARRIBA del rótulo no es su continuación: los dos se reportan', () => {
    const leido = leerSantander(
      documentoConAnexo([
        filaDeImporteSuelto('$ 4.444,44'),
        filaDeRotulo('Renglon sintetico con el importe arriba'),
      ]),
    );
    expect(leido.cuentas[0]?.anexos).toEqual([]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual([
      'desconocido',
      'fila_sin_importe',
    ]);
  });

  it('un importe que nadie reclamó se reporta: es una fila con importe y sin rótulo', () => {
    const leido = leerSantander(documentoConAnexo([filaDeImporteSuelto('$ 5.555,55')]));
    expect(leido.cuentas[0]?.anexos).toEqual([]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['desconocido']);
  });

  /**
   * Un rótulo que no va a emitirse **no puede consumir** el importe del que viene abajo: si lo hiciera, un
   * renglón mal formado se llevaría puesto al siguiente y el segundo error se leería como "faltó un importe".
   */
  it('un rótulo que no pasa la puerta de admisión NO consume el importe del que viene abajo', () => {
    const leido = leerSantander(
      documentoConAnexo([
        filaDeRotulo('Renglon sintetico 01062026 sin separadores'),
        filaDeRotulo('Renglon sintetico valido'),
        filaDeImporteSuelto('$ 6.666,66'),
      ]),
    );
    expect(leido.cuentas[0]?.anexos.map((a) => [a.conceptoLiteral, a.importeDeclarado])).toEqual([
      ['Renglon sintetico valido', '6666.66'],
    ]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['desconocido']);
  });

  /**
   * El apareo **no cruza el corte de página**, y es una consecuencia declarada de `bloquesDeAnexo`: el bloque
   * termina al cambiar de hoja para no comerse las dos páginas de legales. En el tercer banco el caso medido
   * justamente cruza; acá el costo queda escrito y verificado — la cola queda **contada** y sin leer, nunca
   * apareada con el rótulo equivocado.
   */
  it('el apareo no cruza el corte de página: el bloque termina ahí', () => {
    const h = hoja();
    h.agregar([{ texto: `CUIT: ${CUIT_SINTETICO}`, x: X.fecha }]);
    h.agregar([{ texto: 'Desde: 30/05/26', x: X.fecha }]);
    h.agregar([{ texto: 'Hasta: 30/06/26', x: X.fecha }]);
    h.pagina(2);
    h.agregar(cabeceraDeCuenta(2));
    h.agregar(encabezadoDeTabla());
    h.agregar([
      { texto: 'Saldo total', x: X.etiquetaSaldoTotal },
      enBordeDerecho(importeDelBanco(-1n, '$'), R.saldoTotal, 60),
    ]);
    h.agregar([{ texto: 'Detalle impositivo', x: X.fecha }]);
    h.agregar(filaDeRotulo('Renglon sintetico partido entre hojas'));
    h.pagina(3);
    h.agregar(filaDeImporteSuelto('$ 7.777,77'));

    const leido = leerSantander(h.filas);
    expect(leido.cuentas[0]?.anexos).toEqual([]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['fila_sin_importe']);
  });
});

// -----------------------------------------------------------------------------
describe('§9 — la otra forma de envolver: la cláusula del período en su propia fila', () => {
  const SIRCREB = 'Total retencion regimen de recaudacion SIRCREB';

  /**
   * 🔴 El defecto que la regla arregla, escrito primero: sin la cláusula, el rótulo sale `no_publicado` —o
   * sea *"el banco no dijo nada"*— cuando el banco **sí dijo** cuál es el período. Es la única de las cuatro
   * salidas de `periodoDato` que se pierde en silencio y con todo cuadrando.
   */
  it('sin la cláusula, el mismo rótulo sale `no_publicado`', () => {
    const leido = leerSantander(
      documentoConAnexo([
        [{ texto: SIRCREB, x: X.fecha }, enBordeDerecho('$ 8.888,88', R.anexoImpositivo)],
      ]),
    );
    expect(leido.cuentas[0]?.anexos[0]?.periodoDato).toBe('no_publicado');
  });

  it('la cláusula sola se pega al rótulo de arriba y el renglón sale `periodo_de_emision`', () => {
    const { salida, destinos } = leerSantanderConDestinos(
      documentoConAnexo([
        [{ texto: SIRCREB, x: X.fecha }, enBordeDerecho('$ 8.888,88', R.anexoImpositivo)],
        filaDeRotulo('en el período de emisión'),
      ]),
    );
    const anexos = salida.cuentas[0]?.anexos ?? [];
    expect(anexos).toHaveLength(1);
    expect(anexos[0]?.periodoDato).toBe('periodo_de_emision');
    expect(anexos[0]?.periodoDesde).toBeUndefined();
    expect(anexos[0]?.periodoHasta).toBeUndefined();
    expect(anexos[0]?.conceptoLiteral).toBe(`${SIRCREB} en el período de emisión`);
    expect(salida.lineasNoInterpretadas).toEqual([]);
    /**
     * Este mecanismo baja el residuo **sin** mover `anexos`: la cola no tiene registro propio, es
     * `continuacion` igual que la segunda línea de una glosa (§7). Es la tercera fila de la tabla de
     * `leerAnexos`, y la que hace que residuo `5` y residuo `4` signifiquen cosas distintas.
     */
    expect(destinos.anexo).toBe(1);
    expect(destinos.continuacion).toBe(1);
    expect(destinos.residuo).toBe(0);
  });

  it('una cláusula sin rótulo arriba no se cuelga del renglón más cercano: va al residuo', () => {
    const leido = leerSantander(documentoConAnexo([filaDeRotulo('en el período de emisión')]));
    expect(leido.cuentas[0]?.anexos).toEqual([]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['fila_sin_importe']);
  });
});

// -----------------------------------------------------------------------------
describe('§9 — el importe tapado por otro fragmento de la MISMA fila', () => {
  /**
   * 🔴 `fragmentoEnVentanaDerecha` devuelve **el primero** cuyo borde derecho cae en la ventana, parsee o no.
   * Un rótulo largo que termina adentro de los 8 pt de `[524, 532]` tapa al importe que viene atrás, y la
   * fila entera se reporta `fila_sin_importe` **con todo el resto del lote cuadrando** — que es exactamente
   * la forma de residuo que hoy tienen las dos filas con pinta de rótulo del archivo real.
   */
  it('el importe se busca por lo que PARSEA, no por ser el primero de la ventana', () => {
    const rotuloQueTapa = 'Renglon sintetico largo que termina en la ventana del importe';
    const { salida, destinos } = leerSantanderConDestinos(
      documentoConAnexo([
        [
          // Borde derecho 530.0: adentro de `[524, 532]`, y antes del importe por su `x`.
          enBordeDerecho(rotuloQueTapa, 530.0, 200),
          enBordeDerecho('$ 9.999,99', R.anexoImpositivo),
        ],
      ]),
    );
    const anexos = salida.cuentas[0]?.anexos ?? [];
    expect(anexos).toHaveLength(1);
    expect(anexos[0]?.conceptoLiteral).toBe(rotuloQueTapa);
    expect(anexos[0]?.importeDeclarado).toBe('9999.99');
    expect(salida.lineasNoInterpretadas).toEqual([]);
    /**
     * Una sola fila: este mecanismo sube `anexos` en 1 y baja el residuo en 1, **sin** ningún importe suelto
     * de por medio. Es lo que separa esta hipótesis del apareo (+1 / −2) en la próxima corrida.
     */
    expect(destinos.anexo).toBe(1);
    expect(destinos.residuo).toBe(0);
  });

  /** La ventana sigue cerrada: un fragmento que no parsea no pasa a ser importe por estar solo. */
  it('un fragmento que no parsea no se convierte en el importe del renglón', () => {
    const leido = leerSantander(
      documentoConAnexo([
        [enBordeDerecho('Renglon sintetico sin importe legible', R.anexoImpositivo, 200)],
      ]),
    );
    expect(leido.cuentas[0]?.anexos).toEqual([]);
    expect(leido.lineasNoInterpretadas.map((l) => l.codigo)).toEqual(['fila_sin_importe']);
  });
});
