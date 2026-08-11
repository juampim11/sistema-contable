/**
 * ADAPTADOR GALICIA — cuenta corriente en pesos, PDF.
 *
 * La especificación medida está en `docs/diseno/02-formato-galicia.md`. Este archivo la implementa y **no
 * repite los números**: cada constante dice de qué sección sale.
 *
 * ## Por qué geometría y no líneas de texto
 *
 * Dos hechos medidos sobre el archivo real, y los dos matan el enfoque por líneas:
 *
 * 1. `pdf.js` emite **un solo carácter de espacio por hueco**, sin importar que el hueco mida 5 pt o 236 pt.
 *    No existen columnas de ancho fijo en caracteres: `substring(i, j)` es inviable.
 * 2. El texto **no sale ordenado por fila visual**. El importe y el saldo —que visualmente están en la misma
 *    fila que la fecha— salen en una línea **posterior** para 262 de 326 movimientos. Un parser que asuma
 *    "una línea = un movimiento" falla en el 80 % de las filas.
 *
 * Las columnas sí existen, en **puntos PDF**, y son estables en las 24 páginas con tabla. De ahí que este
 * adaptador trabaje sobre `aFilas()`.
 *
 * ## Lo que este adaptador NO hace
 *
 * No decide si el extracto cuadra: eso lo calcula `verificarAritmetica()`, que no lo conoce. No clasifica
 * contablemente. Y no descarta una línea en silencio: lo que no entiende va a `lineasNoInterpretadas` con su
 * **forma**, nunca su texto.
 */

import { formaParaLog } from '@sistema-contable/shared/observabilidad';
import { RE_CUIT as RE_CUIT_COMPARTIDO } from '@sistema-contable/shared/seguridad';
import {
  centavosAImporte,
  importeACentavos,
  importeCanonicoACentavos,
  parsearFecha,
} from '../parseo-ar.ts';
import { hashesDeCuenta, normalizarNumeroCuenta, type ClaveCuenta } from '../hash.ts';
import { contieneIdentificador } from '../glosa.ts';
import type {
  AnexoExtracto,
  CapacidadesAdaptador,
  CuentaConMovimientos,
  LineaNoInterpretada,
  MovimientoBancarioCrudo,
  RelacionAnexo,
} from '../esquema.ts';
import {
  fragmentoEnVentanaDerecha,
  fragmentoEnX,
  textoDeFila,
  type FilaGeometrica,
} from '../texto-pdf.ts';
import type { EntradaDeAdaptador, SalidaDeAdaptador } from './registro.ts';
import {
  buscarIgnorandoAcentos,
  extraerPeriodo,
  parDeColumnas,
  valorPorEtiqueta,
  type ParDeFila,
} from './toolkit.ts';

export const BANCO_CODIGO = 'galicia';
export const VERSION = 1;

/**
 * Las capacidades declaradas. **Todas verdaderas y todas verificadas** contra el archivo real (§4, §5, §6, §10
 * de la spec): 326 filas, cadena completa sin rupturas, totales exactos, signo redundante con la columna.
 *
 * Declararlas es lo que permite que la verificación sepa qué puede exigir. Un banco que no publicara totales
 * daría `no_verificable`, que es un resultado distinto de `cuadra`.
 */
export const CAPACIDADES_GALICIA: CapacidadesAdaptador = {
  familiaLayout: 'columnas-posicionales',
  cadenaDeSaldos: 'completa',
  traeTotalesDeclarados: true,
  // El saldo inicial NO viene con etiqueta: se deriva por aritmética (§3.2). Se declara `true` porque el
  // dato está disponible y verificado por triangulación, no porque haya un rótulo.
  traeSaldoInicialDeclarado: true,
  traeSignoEnElImporte: true,
  traeSaldoPorFila: true,
  traeFechaValor: false,
  traeReferencia: true,
  traeCodigoDeConcepto: false,
  anioEnLaFecha: true,
  multiCuenta: false,
  multiMoneda: false,
  // Medido: **el período empieza antes del primer movimiento**, o sea al revés del banco que sí arrastra
  // movimientos de otro mes. Ninguna de las 326 filas cae fuera del período (spec §6).
  traeMovimientosFueraDelPeriodo: false,
  // Una sola cuenta en el archivo: no hay consolidado por moneda que publicar (spec §3).
  traeConsolidadoPorMoneda: false,
  // A2 (C4): todavía no instrumentado. Pasa a `true` cuando `leerGalicia` empiece a devolver `destinos`.
  declaraDestinos: false,
};

/**
 * Las columnas, en puntos PDF (spec §4).
 *
 * Los importes se localizan por su **borde derecho** y no por el izquierdo: el izquierdo se mueve con la
 * cantidad de dígitos, el derecho no. Es la diferencia entre un parser que sobrevive a que un importe pase de
 * seis a siete cifras y uno que no.
 */
const COLUMNAS = {
  fecha: { x: 38.4, tolerancia: 1.2 },
  descripcion: { x: 82.2, tolerancia: 1.8 },
  origen: { x: 224.4, tolerancia: 1.8 },
  credito: { desde: 340, hasta: 356 },
  debito: { desde: 458, hasta: 470 },
  saldo: { desde: 572, hasta: 584 },
} as const;

/**
 * La banda de la columna `Descripción`, en puntos PDF: desde su `x` (menos la tolerancia) **hasta la
 * columna siguiente**, que es `Origen` (spec §4). `hasta` es exclusivo, igual que en `fragmentosEnBanda`.
 *
 * No se usa para armar la glosa —eso lo sigue haciendo `glosaDe`, que no se toca— sino para **contar**
 * cuántos fragmentos hay en la columna: es la condición de confianza del corte del concepto. Ver
 * `conceptoDeLaFilaDeFecha`.
 */
const BANDA_DESCRIPCION = {
  desde: COLUMNAS.descripcion.x - COLUMNAS.descripcion.tolerancia,
  hasta: COLUMNAS.origen.x,
} as const;

/**
 * Borde derecho máximo medido de la columna `Descripción` (spec §4: `≤ 209.5`).
 *
 * Es lo que permite decidir `conceptoCompleto` **geométricamente**, que es la única forma correcta: la
 * fuente del PDF es proporcional, así que "27 caracteres" no es un corte, es una consecuencia. Depende de
 * que `Fragmento.ancho` sea fiel en este banco — y lo es, porque la propia especificación publica la
 * columna "borde derecho" de la tabla, que sale de `x + ancho`.
 */
const DESCRIPCION_BORDE_DERECHO_MAXIMO = 209.5;

/**
 * Cuánto tiene que sobrar en la columna para declarar el concepto **completo**, en puntos.
 *
 * ≈ un carácter. Un concepto que llega a menos de eso del borde puede haber sido cortado por el ancho de
 * la columna, y el esquema es explícito: *"asumirlo `true` sería afirmar algo que nadie verificó"*. Así que
 * la duda cae del lado de `false`, nunca del lado de `true`.
 */
const MARGEN_DE_TRUNCADO = 6;

const RE_FECHA_CUERPO = /^\d{2}\/\d{2}\/\d{2}$/;

/** Marcas del documento por las que se reconoce al banco (spec §9). */
const MARCAS = [/Resumen de Cuenta Corriente en Pesos/i, /^Fecha Descripci[óo]n Origen Cr[ée]dito D[ée]bito Saldo$/i];

/** Lo que NO es un movimiento (spec §9). Se descarta explícitamente, con su tipo. */
const RUIDO_GALICIA: readonly { readonly patron: RegExp; readonly motivo: string }[] = [
  { patron: /^P[áa]gina \d+ \/ \d+/, motivo: 'Pie con paginación; viene concatenado al título.' },
  { patron: /^\d{17}[A-Z]$/, motivo: 'Identificador de documento del pie.' },
  { patron: /^Fecha Descripci[óo]n Origen/i, motivo: 'Encabezado de tabla, repetido por página.' },
  { patron: /^Resumen de Cuenta/i, motivo: 'Título de sección.' },
  { patron: /^Total\s/, motivo: 'Línea de totales: es dato de la verificación, no un movimiento.' },
  { patron: /^Consolidado/i, motivo: 'Bloque de retención de impuestos: es un anexo.' },
  { patron: /^Movimientos$|^Saldos$|^Datos de la cuenta$|^Per[íi]odo de movimientos$/i, motivo: 'Título.' },
];

/**
 * Galicia no promete nada que el contrato compartido no tenga: alias sin campos propios.
 * Ver `registro.ts` para las tres formas posibles (uso directo, alias, intersection) y cuándo va cada una.
 */
export type SalidaGalicia = SalidaDeAdaptador;

export function reconoceGalicia(filas: readonly FilaGeometrica[]): boolean {
  const textos = filas.slice(0, 80).map(textoDeFila);
  return MARCAS.some((m) => textos.some((t) => m.test(t)));
}

/**
 * Un movimiento en construcción. Existe porque el par `(importe, saldo)` llega **después** que la fecha y la
 * glosa: el bloque se abre con la fecha y se **cierra** cuando aparece el par.
 */
type EnConstruccion = {
  fecha: string;
  lineas: string[];
  origen: string[];
  paginaPdf: number;
  /**
   * Índice de la **fila del documento** que abrió el bloque.
   *
   * Existe porque el residuo se reportaba con `filaNumero`, que es el **contador de movimientos
   * emitidos**, no una posición: las 8 líneas de carátula están antes del primer movimiento, así que las
   * ocho informaban `indice: 0`. El campo cuya razón de ser es *"dónde falló algo"* apuntaba siempre al
   * mismo lugar. Los otros dos bancos ya usan el índice de fila.
   */
  indiceFila: number;
  /** El par `(importe, saldo)`. `null` mientras no apareció: un bloque sin par es un bloque incompleto. */
  par: ParDeFila | null;
  /**
   * El concepto del banco cortado de la fila de la fecha, o `null` si en **esa** fila el corte no se pudo
   * hacer con confianza. `null` significa que el movimiento sale **sin** los tres campos de concepto — no
   * con un corte inventado. Ver `conceptoDeLaFilaDeFecha`.
   */
  concepto: ConceptoCortado | null;
};

/** El resultado del corte geométrico del concepto. `completo` es un hecho medido, no un default. */
type ConceptoCortado = { readonly valor: string; readonly completo: boolean };

/**
 * Lee el extracto.
 *
 * ## El autómata, y el diseño que hubo que corregir
 *
 * La primera versión abría el movimiento con la fecha y lo **cerraba al ver el par `(importe, saldo)`**,
 * razonando por el orden del content-stream, donde el par sale después de la glosa.
 *
 * Medido: en la vista **geométrica** el par está en la **misma fila visual que la fecha** —mismo baseline— y
 * las continuaciones de glosa están en las filas de **abajo**. Así que cerrar al ver el par cerraba el
 * movimiento antes de leer una sola continuación: salieron los 326 movimientos con la glosa **incompleta** y
 * **777 líneas** reportadas como fuera de zona.
 *
 * Los 326 estaban bien y el resultado era plausible. Es exactamente el modo de falla que el plan §6.4 llama
 * el peor: los números cuadran y el producto —la descripción— está mutilado.
 *
 * El criterio correcto en geometría: **un movimiento es la fila con fecha en la columna de fecha, más todas
 * las filas de abajo hasta la próxima fila con fecha.** El par se toma de la fila que lo trae.
 */
export function leerGalicia(filas: readonly FilaGeometrica[]): SalidaGalicia {
  const noInterpretadas: LineaNoInterpretada[] = [];
  const movimientos: MovimientoBancarioCrudo[] = [];
  const periodo = leerPeriodo(filas);

  /**
   * El anexo se resuelve **antes** del cuerpo y no dentro del autómata.
   *
   * Motivo: vive entero después de la línea `Total` (spec §10), o sea fuera de la región de tabla, y sus
   * renglones se emparejan de a dos —literal y período+importe— en filas distintas. El autómata del cuerpo
   * no tiene forma de expresar ese apareo, y meterlo ahí obligaría a un estado más para el 3 % del archivo.
   *
   * `consumidasPorElAnexo` es lo que impide el doble reporte: una fila que se volvió un anexo **no** puede
   * además figurar en `lineasNoInterpretadas`, o el mismo renglón se contaría dos veces con dos destinos.
   */
  const { anexos, consumidas: consumidasPorElAnexo } = leerAnexo(filas);

  let abierto: EnConstruccion | null = null;
  let filaNumero = 0;
  let totales: { creditos: string; debitos: string; saldoFinal: string } | null = null;

  /** Cierra el movimiento abierto. Si no tiene par, es un bloque incompleto y se reporta. */
  const cerrar = (): void => {
    if (!abierto) return;
    if (abierto.par) {
      filaNumero += 1;
      movimientos.push(armarMovimiento(abierto, abierto.par, filaNumero));
    } else {
      noInterpretadas.push({
        codigo: 'fila_sin_importe',
        forma: formaParaLog(abierto.lineas.join(' '), 60),
        paginaPdf: abierto.paginaPdf,
        indice: abierto.indiceFila,
      });
    }
    abierto = null;
  };

  for (const [indice, fila] of filas.entries()) {
    if (consumidasPorElAnexo.has(indice)) continue;

    const texto = textoDeFila(fila);
    if (texto === '') continue;

    // La línea de totales se lee ANTES de descartarla como ruido: es el dato de la verificación (spec §10).
    const t = leerTotales(texto);
    if (t) {
      cerrar();
      totales = t;
      continue;
    }

    const fechaFrag = fragmentoEnX(fila, COLUMNAS.fecha.x, COLUMNAS.fecha.tolerancia);
    const abre = fechaFrag !== undefined && RE_FECHA_CUERPO.test(fechaFrag.texto);

    if (abre && fechaFrag) {
      // Una fila con fecha cierra el movimiento anterior. Es el único criterio de cierre.
      cerrar();

      const fecha = parsearFecha(fechaFrag.texto, periodo ?? undefined);
      if (fecha === null) {
        noInterpretadas.push({
          codigo: 'fecha_ilegible',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice,
        });
        continue;
      }

      abierto = {
        fecha,
        lineas: [],
        origen: [],
        paginaPdf: fila.pagina,
        indiceFila: indice,
        par: null,
        // El concepto se corta SOLO de la fila que trae la fecha: es la única donde el banco lo empieza.
        concepto: conceptoDeLaFilaDeFecha(fila),
      };
      absorber(abierto, fila);
      continue;
    }

    // Ruido estructural: **no cierra el movimiento**. El encabezado de una página aparece en medio de un
    // bloque cuando la glosa cruza el corte de página, y cerrar ahí dejaría la continuación huérfana.
    if (RUIDO_GALICIA.some((r) => r.patron.test(texto))) continue;

    if (abierto) {
      absorber(abierto, fila);
      continue;
    }

    /**
     * Fuera de todo bloque. Acá caen la carátula y las leyendas legales, que están **antes** del primer
     * movimiento — y eso es correcto: se reportan en vez de descartarse en silencio, que es la regla del
     * contrato. El llamador decide si le importan.
     */
    noInterpretadas.push({
      codigo: 'linea_fuera_de_zona',
      forma: formaParaLog(texto, 60),
      paginaPdf: fila.pagina,
      indice,
    });
  }

  cerrar();

  const cuenta = armarCuenta(filas, movimientos, totales, periodo, anexos);
  return {
    cuentas: cuenta ? [cuenta] : [],
    lineasNoInterpretadas: noInterpretadas,
    paginasDeclaradas: leerPaginasDeclaradas(filas),
  };
}

/**
 * Suma a un movimiento abierto lo que aporta una fila: glosa, `Origen` y el par si lo trae.
 *
 * **El par se toma de la primera fila que lo tenga y no se sobreescribe.** Si una fila de continuación
 * trajera otro token con forma de importe en las columnas de importe y saldo, la ambigüedad no se resuelve
 * por preferencia: se conserva el primero, que es el de la fila de la fecha.
 */
function absorber(b: EnConstruccion, fila: FilaGeometrica): void {
  const glosa = glosaDe(fila);
  const origen = origenDe(fila);
  if (glosa !== '') b.lineas.push(glosa);
  if (origen !== '') b.origen.push(origen);
  if (b.par === null) {
    const par = parDeColumnas(fila, COLUMNAS, { traeSignoEnElImporte: true });
    if (par) b.par = par;
  }
}

// -----------------------------------------------------------------------------

function glosaDe(fila: FilaGeometrica): string {
  const f = fragmentoEnX(fila, COLUMNAS.descripcion.x, COLUMNAS.descripcion.tolerancia);
  return f?.texto.trim() ?? '';
}

function origenDe(fila: FilaGeometrica): string {
  const f = fragmentoEnX(fila, COLUMNAS.origen.x, COLUMNAS.origen.tolerancia);
  return f?.texto.trim() ?? '';
}

/**
 * Corta el **concepto del banco** de la fila que trae la fecha. `null` cuando no se puede cortar con
 * confianza — y `null` es un resultado, no una falla.
 *
 * ## Por qué el concepto se corta acá y no de la descripción ya armada
 *
 * `descripcion` es la unión de todas las líneas del bloque, y el corte que hace falta es **geométrico**: el
 * concepto es el fragmento de la columna `Descripción` de la fila de la fecha, y la contraparte vive en las
 * filas de abajo. Reconstruirlo por cantidad de caracteres sobre el texto unido es imposible: la fuente del
 * PDF es proporcional y el banco corta por ancho de columna, no por longitud (spec §8). De ahí que la
 * estrategia declarada sea `segmento_de_glosa` y no `prefijo_anclado`: no hay lista cerrada de etiquetas —
 * el vocabulario de §14 tiene **pares casi sinónimos que son el mismo concepto truncado**.
 *
 * ## Las dos condiciones de confianza, y por qué son fail-closed
 *
 * 1. **Exactamente un fragmento en la banda de la columna.** Con dos o más, dónde termina el concepto y
 *    empieza la contraparte *dentro de la misma fila* no está establecido por ninguna medición: cualquier
 *    corte sería inventado. Además es un canario — `glosaDe` toma un solo fragmento, así que una fila con
 *    dos también estaría perdiendo glosa, y el conteo `con conceptoBanco` lo hace visible.
 * 2. **Ese fragmento tiene que ser el de la columna `Descripción`** (`x ≈ 82.2`), que es el mismo que toma
 *    `glosaDe`. Si fuera otro, el concepto **no sería prefijo de `descripcion`** y rompería INV-14: el
 *    `check` `mov_crudo_concepto_prefijo_chk` y `persistirCuenta` rechazan el lote entero por eso.
 *
 * Es la decisión ya tomada del proyecto: *cuando falta el peldaño mínimo de evidencia → indeterminado, nunca
 * el peldaño siguiente en silencio*.
 *
 * ## `conceptoCompleto`
 *
 * Se decide por el **borde derecho** del fragmento contra el borde de la columna (spec §4). `ACREDITAMIENTO`
 * son 78 movimientos con 14 caracteres y no hay forma de saber si están completos mirando el texto: la
 * geometría es la única evidencia, y no se persiste. Por eso este campo existe.
 */
function conceptoDeLaFilaDeFecha(fila: FilaGeometrica): ConceptoCortado | null {
  const enLaBanda = fila.fragmentos.filter(
    (f) => f.x >= BANDA_DESCRIPCION.desde && f.x < BANDA_DESCRIPCION.hasta,
  );
  if (enLaBanda.length !== 1) return null;

  const fragmento = enLaBanda[0];
  if (!fragmento) return null;
  // Condición 2: tiene que ser el MISMO fragmento que `glosaDe` pone en `descripcionLineas[0]`.
  if (Math.abs(fragmento.x - COLUMNAS.descripcion.x) > COLUMNAS.descripcion.tolerancia) return null;

  // Se colapsan los espacios igual que en `descripcion`, o el prefijo no coincidiría carácter a carácter.
  const valor = fragmento.texto.replace(/\s+/g, ' ').trim();
  if (valor === '') return null;

  const bordeDerecho = fragmento.x + fragmento.ancho;
  return {
    valor,
    completo: bordeDerecho < DESCRIPCION_BORDE_DERECHO_MAXIMO - MARGEN_DE_TRUNCADO,
  };
}

function armarMovimiento(
  b: EnConstruccion,
  par: ParDeFila,
  filaNumero: number,
): MovimientoBancarioCrudo {
  const magnitud = par.importe.startsWith('-') ? par.importe.slice(1) : par.importe;

  /**
   * **`importeCanonicoACentavos`, no `importeACentavos`.**
   *
   * `par.saldo` ya salió de `centavosAImporte`, o sea que está en forma **canónica** (`-1234.56`, punto
   * decimal). `importeACentavos` parsea el formato **argentino** (`-1.234,56`, coma decimal) y sobre un
   * canónico devuelve `null` → con el `?? 0n` el saldo quedaba en cero y **`saldoEsAcreedor` nunca daba
   * `true`**: las 14 filas en descubierto se leían como saldo positivo.
   *
   * El mismo error estaba en `armarCuenta` y ahí producía un saldo inicial de cero, que es lo que hacía
   * fallar `ARIT_SALDO_INICIAL` y `ARIT_SALDO_FINAL`. Un solo error de función explicaba las tres fallas.
   *
   * Las dos funciones son inversas de `centavosAImporte` en dominios distintos, y confundirlas no da error
   * de tipos: las dos toman `string` y devuelven `bigint | null`.
   */
  const saldoCent = importeCanonicoACentavos(par.saldo) ?? 0n;

  return {
    tipoFila: 'movimiento',
    fecha: b.fecha,
    descripcionLineas: b.lineas,
    // El concepto del banco se trunca a 27 caracteres y **sigue en la línea siguiente** (spec §8): no sirve
    // "línea 1 = concepto, línea 2+ = contraparte". Se guardan todas las líneas y se une para la descripción.
    descripcion: b.lineas.join(' ').replace(/\s+/g, ' ').trim(),
    /**
     * Los tres campos del concepto van **juntos o ninguno**, que es lo que exigen los dos `refine` de
     * `movimientoBancarioCrudoSchema`: hay `conceptoBanco` si y solo si la estrategia declara que se
     * capturó, y `conceptoCompleto` es un hecho *sobre* el concepto, así que sin concepto no tiene sujeto.
     *
     * 🔴 **Y ninguno entra en `hashFila`.** El material del hash es `(fecha, importe, saldo, descripcion)` y
     * lo arma `hashesDeCuenta` — el concepto es **producto del parseo**, no del documento: si entrara, el
     * mismo archivo releído con otra versión del adaptador daría otro hash y el lote entero se duplicaría
     * en silencio, que es exactamente lo que el dedupe existe para impedir.
     */
    ...(b.concepto === null
      ? {}
      : {
          conceptoBanco: b.concepto.valor,
          conceptoCompleto: b.concepto.completo,
          conceptoBancoEstrategia: 'segmento_de_glosa' as const,
        }),
    ...(par.columna === 'credito' ? { credito: magnitud } : { debito: magnitud }),
    columnaOrigen: par.columna,
    importe: par.importe,
    saldo: par.saldo,
    // El saldo negativo se publica con el signo ATRÁS, y significa descubierto en la cuenta corriente.
    saldoEsAcreedor: saldoCent < 0n,
    moneda: 'ARS',
    cotizacionProvista: false,
    filaNumero,
    paginaPdf: b.paginaPdf,
    ...(b.origen.length > 0
      ? { referencias: b.origen.map((valor) => ({ tipo: 'operacion' as const, valor })) }
      : {}),
    filaHash: '',
  } as MovimientoBancarioCrudo;
}

/** La línea de totales (spec §10). Notación propia: `$` con espacio y el menos antes del `$`. */
function leerTotales(
  texto: string,
): { readonly creditos: string; readonly debitos: string; readonly saldoFinal: string } | null {
  const m =
    /^Total\s+\$\s*([\d.]+,\d{2})\s+-\$\s*([\d.]+,\d{2})\s+(-?)\$\s*([\d.]+,\d{2})(-?)$/.exec(texto);
  if (!m) return null;

  const cred = importeACentavos(m[1] ?? '');
  const deb = importeACentavos(m[2] ?? '');
  const saldo = importeACentavos(`${m[3] ?? ''}${m[4] ?? ''}${m[5] ?? ''}`);
  if (cred === null || deb === null || saldo === null) return null;

  return {
    creditos: centavosAImporte(cred),
    // El total de débitos se publica negativo; el esquema lo exige **no negativo** (es una magnitud).
    debitos: centavosAImporte(deb < 0n ? -deb : deb),
    saldoFinal: centavosAImporte(saldo),
  };
}

function leerPeriodo(filas: readonly FilaGeometrica[]): { desde: string; hasta: string } | null {
  for (const fila of filas.slice(0, 60)) {
    const p = extraerPeriodo(textoDeFila(fila));
    if (p) return p;
  }
  return null;
}

/** `Página N / M`: el M es lo que el documento declara tener (spec §2). */
function leerPaginasDeclaradas(filas: readonly FilaGeometrica[]): number | undefined {
  for (const fila of filas) {
    // Sin ancla `^`: el pie viene **concatenado al título** de la sección y en la vista geométrica el
    // fragmento de la paginación es el último de la fila. Un patrón anclado no engancha nunca (spec §9).
    const m = /P[áa]gina\s*\d+\s*\/\s*(\d+)/.exec(textoDeFila(fila));
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}

/**
 * Arma la cuenta con sus totales.
 *
 * **El saldo inicial se DERIVA**: `saldo(fila 1) − importe(fila 1)`. No hay etiqueta de "Saldo Anterior" en
 * este banco (spec §3.1), y los dos importes de la carátula salen sin rótulo y en orden invertido. Derivarlo
 * por aritmética es más robusto que leer una etiqueta que no existe, y queda verificado por triangulación
 * contra el otro importe de la carátula.
 */
function armarCuenta(
  filas: readonly FilaGeometrica[],
  movimientos: readonly MovimientoBancarioCrudo[],
  totales: { readonly creditos: string; readonly debitos: string; readonly saldoFinal: string } | null,
  periodo: { readonly desde: string; readonly hasta: string } | null,
  anexos: readonly AnexoExtracto[],
): CuentaConMovimientos | null {
  if (movimientos.length === 0 || !periodo) return null;

  const primera = movimientos[0];
  if (!primera) return null;
  // Canónicos los dos: vienen de `centavosAImporte`. Ver la nota de `armarMovimiento`.
  const saldoPrimera = importeCanonicoACentavos(primera.saldo ?? '') ?? 0n;
  const importePrimera = importeCanonicoACentavos(primera.importe) ?? 0n;
  const saldoInicial = centavosAImporte(saldoPrimera - importePrimera);

  const numero = leerNumeroDeCuenta(filas);
  const cbu = leerCbu(filas);
  const titular = leerTitular(filas);

  /**
   * Los hashes se asignan al final y **por cuenta**: el ordinal de empate depende de cuántas filas
   * idénticas hay dentro de **esta** cuenta, no en el archivo. `hashesDeCuenta` ata las dos cosas —la clave
   * y el ordinal— para que un adaptador multi-cuenta no pueda contar el ordinal sobre el archivo entero.
   *
   * 🔴 **La clave sigue siendo el `numero`, y no el CBU recién leído.** Es tentador —el CBU es el
   * identificador primario de INV-6— y sería un cambio de hash de las 326 filas: el mismo archivo releído
   * daría otra clave, el dedupe no reconocería nada y el lote entero entraría duplicado en silencio. El CBU
   * es para **resolver** contra qué cuenta registrada va el extracto (`resolverCuentaDelExtracto`); la
   * identidad de la fila es otra cosa.
   */
  const clave: ClaveCuenta = {
    bancoCodigo: BANCO_CODIGO,
    numeroNormalizado: normalizarNumeroCuenta(numero ?? 'sin_numero'),
    moneda: 'ARS',
  };
  const hashes = hashesDeCuenta(
    clave,
    movimientos.map((m) => ({
      fecha: m.fecha,
      importe: m.importe,
      saldo: m.saldo ?? null,
      descripcion: m.descripcion,
    })),
  );

  const conHash = movimientos.map((m, i) => ({ ...m, filaHash: hashes[i] ?? '' }));

  return {
    cuenta: {
      denominacion: 'CUENTA CORRIENTE EN PESOS',
      tipoCuenta: 'cuenta_corriente',
      ...(numero === null ? {} : { numero }),
      ...(cbu === null ? {} : { cbu }),
      moneda: 'ARS',
      periodoDesde: periodo.desde,
      periodoHasta: periodo.hasta,
      saldoInicialDeclarado: saldoInicial,
      ...(totales
        ? {
            saldoFinalDeclarado: totales.saldoFinal,
            totalCreditosDeclarado: totales.creditos,
            totalDebitosDeclarado: totales.debitos,
          }
        : {}),
      ...titular,
    },
    movimientos: conHash,
    anexos: [...anexos],
  };
}

/** El número de cuenta, por etiqueta (spec §3). Nunca por patrón: hay 113 identificadores en el cuerpo. */
function leerNumeroDeCuenta(filas: readonly FilaGeometrica[]): string | null {
  const textos = filas.slice(0, 60).map(textoDeFila);
  for (const [i, t] of textos.entries()) {
    if (!/^N[úu]mero de cuenta$/i.test(t)) continue;
    for (let k = 1; k <= 3 && i + k < textos.length; k += 1) {
      const m = /^N?°?\s*([\d\-/ ]{6,})$/.exec(textos[i + k] ?? '');
      if (m?.[1]) return m[1].trim();
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Carátula (titular y CBU): SIEMPRE por etiqueta, nunca por patrón
// -----------------------------------------------------------------------------

/** Cuántas filas del principio son carátula. El mismo horizonte que usa `leerNumeroDeCuenta`. */
const FILAS_DE_CARATULA = 60;

/**
 * Las variantes con las que el banco rotula el CBU en la carátula (spec §3: etiqueta `CBU`, valor en la
 * **línea siguiente**). Se aceptan dos grafías porque es lo único que cambia entre versiones de un resumen.
 */
const ETIQUETAS_CBU = ['CBU', 'C.B.U.'] as const;

/**
 * La forma publicada del CBU (spec §3): **22 dígitos corridos**, sin separadores.
 *
 * Los `\b` de los dos lados no son decoración: hacen que una corrida de **23** dígitos **no** matchee en
 * absoluto en vez de matchear sus primeros 22. Un identificador más largo del que el banco publica no es un
 * CBU con basura al final: es otro número, y recortarlo produciría un CBU plausible e inexistente.
 *
 * 🔴 **No se valida el dígito verificador, y es a propósito.** El adaptador reporta lo que el banco
 * imprimió; quien decide si ese identificador corresponde a una cuenta registrada es
 * `resolverCuentaDelExtracto`, contra la base y acotado al cliente declarado. Recalcular el verificador acá
 * agregaría una forma nueva de perder el dato —un error en nuestra implementación del módulo 10 descarta un
 * CBU real y el extracto cae a `sin_identificador_en_caratula`— sin agregar ninguna certeza que el resolver
 * no dé mejor.
 */
const RE_CBU = /\b\d{22}\b/;

/**
 * Cuántas filas después de la etiqueta se acepta el valor.
 *
 * La spec mide *"línea siguiente"*, pero eso se midió sobre la **vía de líneas** (orden del content-stream)
 * y este adaptador trabaja sobre la **vía geométrica**, donde los fragmentos de la carátula salen
 * intercalados (§3.1.3): la etiqueta comparte baseline con otra cosa y el valor puede quedar una o dos filas
 * más abajo. De ahí una ventana chica pero mayor que uno.
 *
 * **Chica a propósito.** La ventana es lo único que separa "el valor que sigue a esta etiqueta" de "algún
 * número largo de más adelante". Ampliarla hasta que "aparezca" un CBU es exactamente el patrón suelto que
 * `resolver-cuenta.ts` prohíbe, con un rótulo encima para disimular.
 */
const CBU_MAX_FILAS_ADELANTE = 4;

/**
 * Lee el CBU de la carátula. `null` —el campo **ausente**— cuando la etiqueta no está.
 *
 * ## Por qué no se busca "la corrida de 22 dígitos del documento"
 *
 * Es la misma regla que el titular y el número de cuenta, y por el mismo motivo medido: el cuerpo tiene
 * **113 corridas de once dígitos** que son CUIT de contrapartes (`resolver-cuenta.ts`). Veintidós dígitos es
 * menos ambiguo que once, y aun así la regla no se relaja: el día que el banco imprima otro número largo —un
 * identificador de operación, un número de acuerdo— un patrón sin etiqueta lo levanta y el CBU del titular
 * pasa a ser el de otro. Y el resultado de eso no es un error visible: es **un extracto asignado a la cuenta
 * equivocada, con todo cuadrando**.
 *
 * ## Y por qué solo la carátula
 *
 * La glosa de una transferencia puede traer la palabra `CBU` seguida del CBU **de la contraparte**. Buscar
 * la etiqueta en el documento entero convertiría ese renglón en el identificador del titular, que es la
 * misma falla por la otra puerta. El CBU es un dato de la carátula; fuera de ella no se busca.
 *
 * ## Ausente es un resultado
 *
 * Sin etiqueta, el campo no se emite. Hoy eso no bloquea nada —INV-6 resuelve igual por `numero`, que sí
 * tiene etiqueta— y tener los dos es el control cruzado completo. Inventar el valor con un patrón sería
 * cambiar "no lo tengo" por "lo tengo mal", que es estrictamente peor.
 *
 * 🔴 El valor devuelto **no se loguea nunca**, ni entero ni en forma: es N2-R (`redactar.ts` lo tapa en los
 * logs justamente por esto). Va al campo `cbu` de `CuentaDetectada` y a ningún otro lado.
 */
function leerCbu(filas: readonly FilaGeometrica[]): string | null {
  const textos = filas.slice(0, FILAS_DE_CARATULA).map(textoDeFila);
  const hallado = valorPorEtiqueta(textos, ETIQUETAS_CBU, RE_CBU, CBU_MAX_FILAS_ADELANTE);
  return hallado?.valor ?? null;
}

/** La etiqueta que imprime el banco antes del CUIT del titular (spec §3). */
const ETIQUETA_CUIT_TITULAR = 'CUIT del Responsable Impositivo';

/**
 * La forma publicada del CUIT en la carátula: `##-########-#` (spec §3). Con guiones, siempre.
 *
 * 🔴 Antes era un patrón local sin `\b` ni validación de prefijo — el mismo hueco que el CBU vecino
 * (`RE_CBU`, arriba) ya había cerrado con `\b`, sin propagarlo al patrón hermano de CUIT (hallazgo de
 * `tech-lead` en la revisión de Parte B). Ahora importa del catálogo centralizado
 * (`packages/shared/src/seguridad/detectores-forma.ts`), igual que `santander.ts`.
 */
const RE_CUIT_DEL_TITULAR = RE_CUIT_COMPARTIDO;

/**
 * `IVA: <condición>` (spec §3), con la forma medida `Aaaaaaaaaaa aaaaaaaaa`: la primera palabra en
 * capital y las siguientes en minúscula.
 *
 * **El corte por minúsculas no es cosmético: es el delimitador.** En la misma fila geométrica viene la
 * etiqueta siguiente (`Cantidad de cotitulares:`), que arranca en mayúscula — un patrón "letras y espacios"
 * se la llevaría puesta y la condición ante IVA saldría con media etiqueta ajena pegada.
 */
const RE_CONDICION_IVA = /\bIVA\s*:\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)*)/;

/**
 * Cuánto puede separar a dos fragmentos de la carátula, en puntos PDF, para que sigan siendo la MISMA
 * razón social partida por el extractor — y no una columna distinta que comparte fila.
 *
 * 🔴 **Sin medir contra un archivo real con la razón social partida.** Es una hipótesis, no un dato
 * (`docs/diseno/09-lecciones-aprendidas.md` §2: "un renglón sin conteo verificado es un renglón NO
 * MEDIDO"). El valor de partida es conservador a propósito: bastante menor que el hueco más angosto
 * medido entre columnas del cuerpo (`Fecha`→`Descripción`, 43.8 pt: `COLUMNAS.descripcion.x -
 * COLUMNAS.fecha.x`) y bastante mayor que el ancho de un espacio simple. Antes de confiar en esto para un
 * caso real, correr `pnpm probar --caratula` contra el archivo que motivó el cambio y ajustar al hueco
 * medido.
 */
const HUECO_MAXIMO_ENTRE_FRAGMENTOS_DE_RAZON_SOCIAL = 8;

/**
 * Fusiona, caminando hacia la izquierda desde `indiceEtiqueta`, los fragmentos que son la MISMA razón
 * social partida — nunca una columna vecina.
 *
 * ## Por qué esto no es `fragmentosEnBanda`
 *
 * Esa función (`texto-pdf.ts`) fusiona por BANDA de `x`, y una banda de `x` ya rompió este mismo campo una
 * vez: sin corte derecho, el documento del titular terminaba guardado adentro del campo del nombre
 * (`docs/diseno/09-lecciones-aprendidas.md` §1, fila "Banda del titular"). No es casualidad: a diferencia
 * del cuerpo, la carátula no tiene columnas con `x` publicada ni estable — sus fragmentos "salen
 * intercalados" (ver el comentario de `leerCbu`, spec §3.1.3) — así que no hay ningún `[desde, hasta)` que
 * la especificación respalde para "todo lo que precede a la etiqueta".
 *
 * En vez de eso, se camina fragmento por fragmento desde `indiceEtiqueta - 1` hacia la izquierda. Cada uno
 * entra solo si cumple las DOS condiciones:
 *
 *   1. no tiene dígitos (la guarda que ya existía: descarta un CUIT o un `(####)` vecino);
 *   2. el hueco entre su borde derecho y el borde izquierdo del fragmento ya aceptado a su derecha es
 *      chico — la firma geométrica de "es la misma frase partida", no "es otra columna que comparte
 *      baseline".
 *
 * El primer fragmento que no cumple alguna de las dos corta la fusión ahí mismo: lo que quede más a la
 * izquierda no entra, aunque tampoco tenga dígitos. Con el fixture de la "quinta cara" (una columna vecina
 * alfabética separada por un hueco real), el hueco da muy por fuera de la tolerancia y sigue quedando
 * afuera — ahora por geometría, no solo por tomar un único fragmento.
 *
 * Medido contra el archivo real (`pnpm probar --caratula`): hoy la fila trae exactamente un fragmento
 * antes de la etiqueta, así que para ese archivo el resultado no cambia — la fusión entra en juego recién
 * cuando hay más de uno.
 */
function razonSocialAntesDe(fila: FilaGeometrica, indiceEtiqueta: number): string | null {
  const partes: string[] = [];
  let bordeIzquierdoAceptado: number | null = null;

  for (let i = indiceEtiqueta - 1; i >= 0; i -= 1) {
    const candidato = fila.fragmentos[i];
    if (!candidato) break;

    const texto = candidato.texto.trim();
    if (texto.length === 0 || /\d/.test(texto)) break;

    if (bordeIzquierdoAceptado !== null) {
      const hueco = bordeIzquierdoAceptado - (candidato.x + candidato.ancho);
      if (Math.abs(hueco) > HUECO_MAXIMO_ENTRE_FRAGMENTOS_DE_RAZON_SOCIAL) break;
    }

    partes.unshift(texto);
    bordeIzquierdoAceptado = candidato.x;
  }

  const unido = partes.join(' ').trim();
  return unido.length >= 2 ? unido : null;
}

/**
 * Lee los datos del titular de la carátula.
 *
 * ## Por etiqueta, y por qué acá no hay atajo
 *
 * El cuerpo del extracto tiene **113 corridas de once dígitos** que son CUIT de contrapartes (§14 de la
 * spec, y la nota de `resolver-cuenta.ts`). Buscar "el primer CUIT del documento" encuentra el de un
 * tercero y lo guarda como titular — y a partir de ahí la validación "este archivo es del cliente" da
 * verdadero para el extracto de **otro** cliente en el que el nuestro figura como contraparte. Un control
 * que da verdadero cuando debería dar falso es peor que no tenerlo.
 *
 * ## El titular NO tiene etiqueta propia, y por eso se ancla a la del CUIT
 *
 * En la carátula, la razón social sale en la **misma fila geométrica** que la etiqueta del CUIT, delante de
 * ella. Así que se lee como el texto que **precede a la etiqueta**, que sigue siendo un ancla impresa por el
 * banco y no un patrón sobre el documento entero. Dos guardas: tiene que haber texto antes, y ese texto **no
 * puede tener dígitos** — la forma medida es toda alfabética, y un prefijo con dígitos significa que la fila
 * no es la que se cree.
 *
 * Lo que no aparece con etiqueta confiable se devuelve **ausente**. Ausente es un dato; un valor plausible
 * leído del lugar equivocado, no.
 */
function leerTitular(filas: readonly FilaGeometrica[]): {
  readonly titular?: string;
  readonly titularDocumento?: string;
  readonly titularCondicionIva?: string;
} {
  const textos = filas.slice(0, FILAS_DE_CARATULA).map(textoDeFila);

  const documento = valorPorEtiqueta(textos, [ETIQUETA_CUIT_TITULAR], RE_CUIT_DEL_TITULAR);

  /**
   * La razón social se arma fusionando los fragmentos contiguos que preceden a la etiqueta del CUIT —
   * `razonSocialAntesDe`, más arriba — en vez de tomar un único fragmento fijo.
   *
   * 🔴 **Truncado silencioso, corregido.** La versión anterior tomaba SOLO `fragmentos[indiceEtiqueta -
   * 1]`: si la razón social real viniera partida en 2+ fragmentos geométricos (medido en Macro:
   * `texto-pdf.ts` documenta 1 a 4 fragmentos por fila para un campo de texto libre en la misma columna),
   * se perdía todo menos el último pedazo, sin error y sin campo ausente — el peor modo de falla del
   * módulo (`docs/diseno/09-lecciones-aprendidas.md`).
   *
   * La ubicación de la etiqueta ahora reusa `buscarIgnorandoAcentos` (`toolkit.ts`), la misma que ya usa
   * `valorPorEtiqueta`, en vez de reimplementar la búsqueda con `.includes()` sin normalizar acentos.
   *
   * 🔴 **Residuo declarado, medido y no cubierto por test (hallazgo de `code-reviewer`).** `documento` se
   * ubica sobre el texto de la fila YA UNIDO (`textoDeFila`, vía `valorPorEtiqueta`) — robusto a que la
   * etiqueta venga partida en varios fragmentos. `indiceEtiqueta`, en cambio, busca la etiqueta COMPLETA
   * dentro de un ÚNICO fragmento (`f.texto`): si `ETIQUETA_CUIT_TITULAR` viniera partida en 2+ fragmentos
   * geométricos —el mismo fenómeno que ya se corrigió para la razón social, arriba— `indiceEtiqueta` daría
   * `-1` y `razonSocial` quedaría `null`. No es un truncado (el campo se declara ausente, no un valor
   * parcial), pero sí una pérdida de un dato que hoy se lee bien. Medido contra el archivo real
   * (`pnpm probar --caratula`): la etiqueta sale en un solo fragmento, así que no ocurre hoy. Sin caso real
   * que lo ejercite, no se fuerza un fix especulativo — queda declarado acá para que la próxima medición
   * decida si hace falta.
   */
  let razonSocial: string | null = null;
  if (documento) {
    const fila = filas[documento.linea];
    const indiceEtiqueta = fila?.fragmentos.findIndex(
      (f) => buscarIgnorandoAcentos(f.texto, ETIQUETA_CUIT_TITULAR) !== -1,
    );
    if (fila && indiceEtiqueta !== undefined && indiceEtiqueta > 0) {
      razonSocial = razonSocialAntesDe(fila, indiceEtiqueta);
    }
  }

  let condicionIva: string | null = null;
  for (const t of textos) {
    const m = RE_CONDICION_IVA.exec(t);
    if (m?.[1]) {
      condicionIva = m[1].trim();
      break;
    }
  }

  return {
    ...(razonSocial === null ? {} : { titular: razonSocial }),
    ...(documento === null ? {} : { titularDocumento: documento.valor }),
    ...(condicionIva === null ? {} : { titularCondicionIva: condicionIva }),
  };
}

// -----------------------------------------------------------------------------
// El anexo: `Consolidado de retenciones e impuestos`
// -----------------------------------------------------------------------------

/**
 * El renglón de período del anexo (spec §7 y §10): las fechas de este bloque vienen con **guiones** y con
 * año de cuatro dígitos, al revés que el cuerpo (`dd/mm/aa`).
 *
 * En la vista geométrica este renglón trae, además de las dos fechas, **el importe** —comparten baseline—,
 * así que es el ancla del bloque: es el único inequívoco.
 */
const RE_PERIODO_DEL_ANEXO =
  /^PERIODO\s+COMPRENDIDO\s+ENTRE\s+EL\s+(\d{2}-\d{2}-\d{4})\s+Y\s+EL\s+(\d{2}-\d{2}-\d{4})\b/i;

/**
 * De qué renglones del anexo se sabe si su importe **ya está** en los movimientos del cuerpo.
 *
 * Es lo que convierte la prohibición *"que el anexo no entre en la suma"* —que nadie puede chequear— en una
 * condición sobre una columna. Y por eso la tabla es **cerrada y anclada**, nunca un `includes`: los pares
 * casi sinónimos del vocabulario de §14 (`IMP. DEB. LEY 25413 GRAL.` / `IMPUESTO DEB.LEY 25413`) muestran
 * que en este banco el mismo concepto aparece con dos grafías, y un `contains` mezcla lados opuestos.
 *
 * ⚠️ **El orden importa.** El renglón computable como pago a cuenta empieza igual que los mensuales
 * (`TOTAL MENSUAL RETENCION IMPUESTO LEY 25.413 …`) y termina distinto: si el patrón general corriera
 * primero, el único renglón que **no está en los movimientos** quedaría marcado como si estuviera, y el
 * pago a cuenta —que no es derivable de ningún movimiento— se perdería para siempre.
 *
 * Lo que no matchea es `no_determinada`, que el esquema trata como `resume_…`: **fail-closed, no registrar
 * de más**.
 */
/**
 * 🔴 **Espejo exacto de `anexo_literal_sin_identificador_chk`** (migración 0008): el `check` de la base
 * rechaza toda corrida de 7 o más dígitos en `concepto_literal`. Se verifica **acá** para que un renglón
 * sospechoso quede en el residuo en vez de reventar la transacción del lote entero — 1346 movimientos
 * perdidos por un anexo.
 *
 * **No alcanza con `contieneIdentificador`, y la diferencia no es teórica:** sus patrones llevan
 * lookarounds que excluyen `[\d\-.,]`, así que `1234567,89` pasa ese filtro y la base lo rechaza igual.
 * El `check` es `[0-9]{7}` a secas, sin lookarounds: el espejo tiene que ser el mismo regex. Los otros
 * dos bancos del roster ya lo escriben así.
 *
 * Se conservan los dos controles: `contieneIdentificador` es más estricto en otras direcciones (un CUIT
 * con guiones), y fail-closed es la dirección correcta para esto.
 */
const RE_LITERAL_CON_IDENTIFICADOR = /\d{7}/;

const RELACION_POR_LITERAL: readonly {
  readonly patron: RegExp;
  readonly relacion: RelacionAnexo;
}[] = [
  {
    patron: /CREDITO\s+COMPUTABLE\s+COMO\s+PAGO\s+A\s+CUENTA$/,
    relacion: 'no_esta_en_los_movimientos',
  },
  {
    patron: /^TOTAL\s+IMPUESTO\s+I\.V\.A\.\s+SOBRE\s+DEBITOS$/,
    relacion: 'resume_movimientos_del_cuerpo',
  },
  {
    patron: /^TOTAL\s+(?:MENSUAL\s+)?RETENCION\s+IMPUESTO\s+LEY\s+25\.413\s+SOBRE\s+(?:CREDITOS|DEBITOS)$/,
    relacion: 'resume_movimientos_del_cuerpo',
  },
];

function relacionDelLiteral(literal: string): RelacionAnexo {
  for (const r of RELACION_POR_LITERAL) if (r.patron.test(literal)) return r.relacion;
  return 'no_determinada';
}

/** Un renglón del bloque, ya clasificado. El bloque son pares: un literal y un período con su importe. */
type RenglonDeAnexo =
  | {
      readonly clase: 'periodo';
      readonly indice: number;
      readonly pagina: number;
      readonly desde: string;
      readonly hasta: string;
      readonly importe: string;
    }
  | { readonly clase: 'literal'; readonly indice: number; readonly pagina: number; readonly texto: string };

/**
 * Lee el `Consolidado de retenciones e impuestos` — las **9 entradas con 3 períodos distintos** de §10.
 *
 * ## Por qué esto no se puede descartar, aunque parezca ruido
 *
 * Adentro está el renglón del **importe computable como pago a cuenta**, que **no existe como movimiento y
 * no es derivable de ellos**. Descartar el bloque lo pierde sin dejar rastro, y hasta hoy este adaptador lo
 * descartaba: sus 9 renglones aparecían en el residuo y nadie los leía.
 *
 * ## El bloque en la vista geométrica: dos filas por entrada, no tres
 *
 * En la vista de líneas la entrada son tres (`PERIODO …` / concepto / importe); en la geométrica el importe
 * comparte baseline con el período, así que son **dos filas**: el literal por un lado y el período con su
 * importe por el otro. Cuál de las dos va arriba **no es una propiedad del documento** —`pdf.js` emite en
 * orden de content-stream— así que el apareo no se cablea a una orientación: cada período toma el literal
 * **inmediatamente anterior** si está libre, y si no, el **inmediatamente posterior**. Las dos
 * orientaciones salen bien y ninguna se supone.
 *
 * ## Los tres límites, todos fail-closed
 *
 * 1. **El bloque empieza después de la línea `Total`** (§10: "todo lo posterior a `Total`"). Sin línea de
 *    totales no hay anexo: no se sale a buscarlo por el documento entero, donde las ventanas de importe de
 *    la tabla capturan cosas que no son de la tabla.
 * 2. **Todo en la página del primer renglón de período.** La página siguiente es texto legal (§2), y una
 *    leyenda no puede volverse el literal de un renglón impositivo.
 * 3. **Un período sin literal libre no se emite.** `conceptoLiteral` no tiene default posible —el rótulo es
 *    del banco— y fabricar uno sería inventar el hecho. La fila queda en `lineasNoInterpretadas` con su
 *    forma, que es donde se ve que faltó algo.
 */
function leerAnexo(filas: readonly FilaGeometrica[]): {
  readonly anexos: readonly AnexoExtracto[];
  readonly consumidas: ReadonlySet<number>;
} {
  const vacio = { anexos: [] as readonly AnexoExtracto[], consumidas: new Set<number>() };

  const indiceTotales = filas.findIndex((f) => leerTotales(textoDeFila(f)) !== null);
  if (indiceTotales === -1) return vacio;

  const candidatos: RenglonDeAnexo[] = [];
  for (let i = indiceTotales + 1; i < filas.length; i += 1) {
    const fila = filas[i];
    if (!fila) continue;
    const texto = textoDeFila(fila);

    const periodo = renglonDePeriodo(fila, texto);
    if (periodo) {
      candidatos.push({ clase: 'periodo', indice: i, pagina: fila.pagina, ...periodo });
      continue;
    }
    if (esLiteralDeAnexo(fila, texto)) {
      candidatos.push({ clase: 'literal', indice: i, pagina: fila.pagina, texto });
    }
  }

  // Límite 2: el bloque es el de la página del primer renglón de período.
  const paginaDelBloque = candidatos.find((c) => c.clase === 'periodo')?.pagina;
  if (paginaDelBloque === undefined) return vacio;
  const renglones = candidatos.filter((c) => c.pagina === paginaDelBloque);

  const anexos: AnexoExtracto[] = [];
  const consumidas = new Set<number>();
  const literalesUsados = new Set<number>();

  for (const [i, r] of renglones.entries()) {
    if (r.clase !== 'periodo') continue;

    const anterior = renglones[i - 1];
    const posterior = renglones[i + 1];
    const elegido =
      anterior?.clase === 'literal' && !literalesUsados.has(i - 1)
        ? { pos: i - 1, renglon: anterior }
        : posterior?.clase === 'literal' && !literalesUsados.has(i + 1)
          ? { pos: i + 1, renglon: posterior }
          : null;
    // Límite 3: sin literal no se emite. Los dos renglones quedan visibles en el residuo.
    if (elegido === null) continue;

    literalesUsados.add(elegido.pos);
    consumidas.add(r.indice);
    consumidas.add(elegido.renglon.indice);

    anexos.push({
      tipoFila: 'anexo',
      conceptoLiteral: elegido.renglon.texto,
      // La identidad de la fila: el anexo no tiene clave natural. Galicia trae una sola cuenta, así que el
      // orden dentro del lote y el orden de lectura son el mismo.
      ordenEnLote: anexos.length + 1,
      /**
       * 🔴 `cuenta_unica_del_lote`, **no** `publicada_por_cuenta`. El banco no dice de qué cuenta es este
       * bloque; lo sabemos porque el archivo tiene **una sola** (spec §3, `multiCuenta: false`). La
       * evidencia es aritmética del lote, no una afirmación del documento — y el día que Galicia mande un
       * archivo de dos cuentas la deducción deja de valer. Con un solo valor eso sería invisible.
       */
      atribucionCuenta: 'cuenta_unica_del_lote',
      periodoDesde: r.desde,
      periodoHasta: r.hasta,
      /**
       * Las dos fechas vienen **impresas** en el renglón, así que el período está publicado completo.
       *
       * 🔴 Y por eso nunca hace falta el otro camino: **el período del extracto no se copia acá**. §10 mide
       * que el bloque cubre **tres períodos distintos** del extracto; rellenar con el del resumen daría un
       * hecho fiscal fabricado que además cuadra.
       */
      periodoDato: 'publicado_completo',
      importeDeclarado: r.importe,
      moneda: 'ARS',
      // `alicuotaPublicada` va ausente: este bloque publica período, concepto e importe, y ninguna tasa
      // (§10). Un campo vacío es el dato correcto; inventar una alícuota sería normativa fabricada.
      relacionConMovimientos: relacionDelLiteral(elegido.renglon.texto),
      paginaPdf: r.pagina,
    });
  }

  return { anexos, consumidas };
}

/** El renglón `PERIODO COMPRENDIDO ENTRE EL … Y EL …` con su importe, o `null` si no es ése. */
function renglonDePeriodo(
  fila: FilaGeometrica,
  texto: string,
): { readonly desde: string; readonly hasta: string; readonly importe: string } | null {
  const m = RE_PERIODO_DEL_ANEXO.exec(texto);
  if (!m) return null;

  const desde = parsearFecha(m[1] ?? '');
  const hasta = parsearFecha(m[2] ?? '');
  // El esquema exige que el período no termine antes de empezar. Un par invertido es un renglón mal leído.
  if (desde === null || hasta === null || hasta < desde) return null;

  /**
   * El importe se localiza por la **ventana de la columna `Saldo`**: §10 mide que los 9 importes del anexo
   * caen ahí (borde derecho 582.3). No se busca "el último token con forma de importe" — eso es
   * clasificar por contenido, que es justo lo que produce que un código o un identificador entre como
   * importe (`parseo-ar.ts`, nota de `esImporte`).
   */
  const fragmento = fragmentoEnVentanaDerecha(fila, COLUMNAS.saldo.desde, COLUMNAS.saldo.hasta);
  if (!fragmento) return null;

  const centavos = importeACentavos(fragmento.texto);
  // `importeDeclarado` es una magnitud no negativa. Un negativo acá no se convierte en positivo —eso
  // fabricaría el signo—: el renglón queda sin emitir y visible en el residuo.
  if (centavos === null || centavos < 0n) return null;

  return { desde, hasta, importe: centavosAImporte(centavos) };
}

/**
 * ¿Esta fila es el **literal** de un renglón del anexo?
 *
 * Las condiciones son de admisión, no de reconocimiento: cada una descarta algo que si entrara produciría un
 * renglón impositivo con el rótulo equivocado.
 *
 * - **Sin minúsculas.** Los conceptos del bloque son mayúsculas (§10); las leyendas legales son prosa. Es lo
 *   que impide que un párrafo legal se vuelva el rótulo de una retención.
 * - **Sin importe en la ventana de saldo.** Un renglón con importe es un renglón de período, no un rótulo.
 * - **Sin identificador.** Es la misma puerta de admisión que `persistirAnexos` pone antes del `insert` y
 *   que el `check` `anexo_literal_sin_identificador_chk` (migración 0008) exige: ninguna corrida de 7+
 *   dígitos. Se aplica **acá** para que el renglón sospechoso quede en el residuo en vez de reventar la
 *   transacción del lote entero.
 */
function esLiteralDeAnexo(fila: FilaGeometrica, texto: string): boolean {
  if (texto.length < 5 || texto.length > 160) return false;
  if (!/^[A-ZÁÉÍÓÚÑ]/.test(texto)) return false;
  if (/[a-záéíóúñ]/.test(texto)) return false;
  if (RE_PERIODO_DEL_ANEXO.test(texto)) return false;
  if (RUIDO_GALICIA.some((r) => r.patron.test(texto))) return false;
  if (fragmentoEnVentanaDerecha(fila, COLUMNAS.saldo.desde, COLUMNAS.saldo.hasta)) return false;
  if (RE_LITERAL_CON_IDENTIFICADOR.test(texto)) return false;
  if (contieneIdentificador(texto)) return false;
  return true;
}

// -----------------------------------------------------------------------------
// El adaptador, con la forma del contrato
// -----------------------------------------------------------------------------

export const adaptadorGalicia = {
  bancoCodigo: BANCO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_GALICIA,
  reconoce: (e: EntradaDeAdaptador): boolean => reconoceGalicia(e.filas),
  leer: (e: EntradaDeAdaptador): SalidaGalicia => leerGalicia(e.filas),
} as const;
