/**
 * ADAPTADOR MACRO — resumen **multi-cuenta**, PDF.
 *
 * La especificación medida está en `docs/diseno/07-formato-macro.md`. Este archivo la implementa y **no
 * repite los números**: cada constante dice de qué sección sale.
 *
 * ## Qué hace distinto a este banco, y qué decisión de diseño impone cada cosa
 *
 * | Hecho medido | Consecuencia en este archivo |
 * |---|---|
 * | **Tres cuentas en un mismo resumen**, con el encabezado repetido **47 veces** (§14.2) | la sectorización va por `seccionesPorClave` y la clave es **el número**, nunca la denominación |
 * | La cadena de saldos cierra **por cuenta**; mezcladas dan **1 ruptura sobre 1346 = 0,07 %** (§5) | cada sección arma su propia `CuentaConMovimientos`, con su saldo inicial y su saldo final |
 * | El signo **no está en el token**: 0 de 1346 (§4.1) | `parDeColumnas(..., { traeSignoEnElImporte: false })`; el signo lo dice **solo** la columna |
 * | La glosa viene en **1 a 4 fragmentos** (§7) | `fragmentosEnBanda`, nunca `fragmentoEnX`: con `fragmentoEnX` salen **1186 de 1346** descripciones truncadas |
 * | **178 importes de fuera de la tabla** caen en la ventana de `SALDO`, con el borde **idéntico** (§9) | un saldo se lee **solo** de una fila ya reconocida como movimiento, jamás barriendo la página |
 * | La carátula publica un **consolidado por moneda** (§14.4-bis) | se devuelve en `consolidadosPorMoneda`: es el único control que ve que se mezcló una cuenta |
 * | El anexo trae **6 renglones**, con dos grafías del mismo literal, uno que **cruza el corte de página** y uno **sin fecha de inicio** (§9) | `leerAnexosDelLote`, una pasada del **lote** (el ordinal es del lote), con `atribucionCuenta` y `relacionConMovimientos` declarados |
 * | La atribución del `D. 409/2018` a su cuenta **no es posicional** (0/2/1) | se emite igual, con `no_determinada`: es el renglón que **no existe como movimiento** y que antes se perdía entero |
 *
 * ## Dos cosas que este archivo aprendió corriendo contra el archivo real
 *
 * 1. 🔴 **El vocabulario tenía las etiquetas y no podía capturarlas.** El ancla les agregaba un espacio
 *    final y el banco imprime `TRANSF:<token>` **pegado**: **84 movimientos** sin concepto, con todo lo
 *    demás en verde. Ver `anclaDePrefijo`.
 * 2. 🔴 **"Fuera de la región de tabla" es una ubicación, no un destino.** El residuo tenía **141 filas**
 *    que nadie podía clasificar; medidas, eran seis bloques conocidos. Ver `reportarSiEsResiduo` y
 *    `filasExplicadasPorBloque`.
 *
 * ## Lo que este adaptador NO hace
 *
 * No decide si el extracto cuadra —eso lo calcula `verificarAritmetica()` y, para el cruce entre cuentas,
 * `verificarConsolidadoPorMoneda()`, que no lo conocen—. No clasifica contablemente. Y no descarta una línea
 * en silencio: lo que no entiende va a `lineasNoInterpretadas` con su **forma**, nunca su texto.
 */

import { formaParaLog } from '@sistema-contable/shared/observabilidad';
import { RE_CUIT as RE_CUIT_COMPARTIDO } from '@sistema-contable/shared/seguridad';
import {
  centavosAImporte,
  importeACentavos,
  importeCanonicoACentavos,
  normalizar,
  parsearFecha,
  type ImporteCanonico,
  type Periodo,
} from '../parseo-ar.ts';
import { hashesDeCuenta, normalizarNumeroCuenta, type ClaveCuenta } from '../hash.ts';
import type {
  AnexoExtracto,
  CapacidadesAdaptador,
  ConsolidadoPorMoneda,
  CuentaConMovimientos,
  CuentaDetectada,
  LineaNoInterpretada,
  Moneda,
  MovimientoBancarioCrudo,
} from '../esquema.ts';
import {
  fragmentoEnVentanaDerecha,
  fragmentoEnX,
  fragmentosEnBanda,
  textoDeFila,
  type FilaGeometrica,
} from '../texto-pdf.ts';
import {
  contarDestinos,
  dentroDeAlgunaRegion,
  extraerPeriodo,
  parDeColumnas,
  regionesDeTabla,
  seccionesPorClave,
  DESTINOS_BASE,
  type ColumnasDeImporte,
  type ConteoDeDestinos,
  type DestinoBase,
  type RegionDeTabla,
  type SeccionDetectada,
} from './toolkit.ts';
import { ErrorDeAdaptador } from './contrato.ts';
import type { EntradaDeAdaptador, SalidaDeAdaptador } from './registro.ts';

export const BANCO_CODIGO = 'macro';
export const VERSION = 1;

/**
 * Las capacidades declaradas, cada una con la sección que la respalda.
 *
 * Declararlas es lo que permite que la verificación sepa qué puede exigir: sin esto, *"el banco no publica
 * totales"* y *"el parser no encontró los totales"* se ven exactamente igual.
 */
export const CAPACIDADES_MACRO: CapacidadesAdaptador = {
  familiaLayout: 'columnas-posicionales',
  // §5: 1346 filas con saldo, 0 rupturas **por cuenta**. La cadena es completa y es la fuente del signo.
  cadenaDeSaldos: 'completa',
  // §2.2 y §9: **no hay línea `Total`**, ni por cuenta ni del archivo. Lo único declarado es el par
  // saldo inicial / saldo final. La fuerza de la verificación pasa entera a la cadena de saldos.
  traeTotalesDeclarados: false,
  // §2.2: `SALDO ULTIMO EXTRACTO AL <fecha>` — con **etiqueta real** y en la columna de saldo, uno por
  // cuenta (3). No hay que derivarlo por aritmética como en el primer banco del roster.
  traeSaldoInicialDeclarado: true,
  // §4.1: **0 de 1346** tokens traen signo. La columna es la ÚNICA evidencia, y su verificación es la
  // cadena de saldos (`signo(saldo[i] − saldo[i−1])` coincide en 1346 de 1346, y en 0 el delta es cero).
  traeSignoEnElImporte: false,
  // §3: la columna `SALDO` trae valor en las 1346 filas.
  traeSaldoPorFila: true,
  // §6: 0 filas con más de un token de fecha. No existe fecha valor en este formato.
  traeFechaValor: false,
  // §3: `REFERENCIA` con valor en 1221 de 1346 filas, en `x = 264.0` exacto.
  traeReferencia: true,
  // §12: el banco publica una glosa literal, no un código de concepto.
  traeCodigoDeConcepto: false,
  // §6: el cuerpo trae `dd/mm/aa`. El año está, no hay que resolverlo contra el período.
  anioEnLaFecha: true,
  // §14.1: tres cuentas en un mismo archivo. **El primero del roster.**
  multiCuenta: true,
  /**
   * §14.6: la estructura de moneda extranjera **existe y está impresa** (cuenta `EN DOLARES`, consolidado
   * `en DOLARES EE.UU.` separado), y tiene **cero movimientos**.
   *
   * Se declara `true` porque el archivo trae dos monedas; queda **declarado y NO ejercitado**. No se supone
   * nada sobre cotización, símbolo ni sobre en qué moneda se expresa el saldo de una cuenta USD: no hay un
   * solo movimiento en dólares del que deducirlo (§15).
   */
  multiMoneda: true,
  /**
   * §6: **4 movimientos con fecha FUERA del período declarado** (dos del 20/10 y dos del 22/10 en un
   * resumen del 01/11 al 28/11). Son movimientos legítimos que el banco arrastró.
   *
   * Con esto `EST_FECHA_FUERA_DE_PERIODO` baja a observación **para este banco**: el hecho se sigue
   * reportando y `fechasDentroDelPeriodo` sigue diciendo la verdad, pero no pone el lote en rojo.
   */
  traeMovimientosFueraDelPeriodo: true,
  // §14.4-bis: `Saldo Cuentas en PESOS` / `en DOLARES EE.UU.`, 45 apariciones cada uno. Es la entrada de
  // INV-multicuenta, la única ecuación del documento que cruza cuentas.
  traeConsolidadoPorMoneda: true,
  // A2 (C3): `leerMacro` clasifica cada fila en uno de los `DESTINOS_BASE` y devuelve el recuento.
  declaraDestinos: true,
};

/**
 * Las columnas, en puntos PDF (§3).
 *
 * 🔴 **Los bordes derechos del ENCABEZADO no sirven para inferir la ventana del valor.** Medido: `CREDITOS`
 * termina en 453.0 y sus valores en 465.6; `DEBITOS` en 369.0 y sus valores en 385.8. Un adaptador que
 * derive las ventanas de la fila de encabezado **no engancha ni un importe**. Por eso están acá, escritas
 * como el valor medido del cuerpo, y no se calculan.
 *
 * Los tres bordes derechos son un **valor único en todo el archivo**, no un rango: ±0.5 alcanza.
 */
const COLUMNAS_DE_IMPORTE: ColumnasDeImporte = {
  debito: { desde: 385.3, hasta: 386.3 },
  credito: { desde: 465.1, hasta: 466.1 },
  saldo: { desde: 553.3, hasta: 554.3 },
};

const COLUMNAS = {
  /** §3 y §7: `x = 33.0` exacto en las 1346 filas. El criterio de movimiento es `|x − 33.0| < 1`. */
  fecha: { x: 33.0, tolerancia: 0.9 },
  /**
   * §7: la glosa arranca en `x = 70.8` y viene en **1 a 4 fragmentos**; `hasta` es la coordenada de la
   * columna siguiente y **es exclusivo** (`fragmentosEnBanda` toma `[desde, hasta)`).
   *
   * El colchón de 0.5 pt hacia abajo es tolerancia de coma flotante del extractor, y es **deliberadamente
   * menor que los 1.2 pt** que separan la glosa (70.8) del bloque de carátula (72.0) — §7, trampa 7. Que la
   * banda igual llegue hasta 264.0 no reintroduce esa trampa **porque la glosa solo se lee de una fila ya
   * reconocida como movimiento**, y una fila de carátula no tiene fecha en `x = 33.0`.
   */
  glosa: { desde: 70.3, hasta: 264.0 },
  /**
   * §7: la referencia está en `x = 264.0` **exacto** (1221 valores + 47 encabezados = 1268 fragmentos).
   *
   * La tolerancia es chica a propósito: **113 glosas desbordan visualmente hacia esta columna** (hasta
   * `x = 297.6`) y **ninguna de esas 113 tiene referencia**. Una regla "referencia = cualquier fragmento a
   * la derecha de 260" captura glosa; el ancla exacta, no — porque esos fragmentos *empiezan* a la
   * izquierda de 264.0 aunque terminen a la derecha.
   */
  referencia: { x: 264.0, tolerancia: 0.5 },
} as const;

/**
 * Leyendas legales: 17 por página × 45 = 765 filas (§8). El criterio medido es **geométrico**, no textual:
 * primer fragmento en `x ∈ {20.2, 20.3}` y `y < 120` (el pie de la página).
 */
const LEYENDA_LEGAL = { x: 20.25, tolerancia: 0.35, yMaximo: 120 } as const;

/**
 * Bloque de datos del titular de la carátula: 225 filas (5 × 45), primer fragmento en `x = 72.0` (§7).
 *
 * Se descarta **por geometría** y no por su texto, que es el nombre y el domicilio del cliente: escribir ese
 * literal en una constante de este archivo lo publicaría en el repo, en los PR y en el contexto de cada
 * agente (ADR-0002, hallazgo H-A).
 */
const BLOQUE_TITULAR = { x: 72.0, tolerancia: 0.5 } as const;

/**
 * Encabezado de la **sucursal**, arriba a la derecha de cada página: **90 filas** (2 × 45).
 *
 * Medido: en todo el documento hay exactamente 90 filas cuyo primer fragmento cae en `x = 360.0`, y **las
 * 90 tienen `y > 780`** — o sea que la banda alta no descarta nada más. Es geometría, no texto: la segunda
 * línea es el domicilio de la sucursal.
 */
const ENCABEZADO_SUCURSAL = { x: 360.0, tolerancia: 0.35, yMinimo: 780 } as const;

/**
 * La columna izquierda de la carátula: **90 filas** en `x = 25.6`, 45 de ellas la etiqueta
 * `Resumen General Periodo del Extracto:` —que se lee aparte y **antes**, ver `leerPeriodoDelArchivo`— y
 * 45 una leyenda de dos fragmentos que no es ni dato ni señal.
 *
 * Va por geometría por el mismo motivo que las otras dos bandas: el criterio no depende de un literal del
 * documento. Y `x = 25.6` no roza nada: la leyenda legal del pie está en 20.2/20.3, el bloque del titular
 * en 72.0 y el cuerpo del anexo en 28.8.
 */
const BLOQUE_CARATULA_IZQ = { x: 25.6, tolerancia: 0.35 } as const;

/**
 * La regla de subrayado que cierra la tabla de cuentas de la p1: **1 fila**, un único fragmento de 125
 * guiones bajos. No lleva un solo carácter del documento, así que el patrón se puede escribir.
 */
const RE_REGLA_DE_SUBRAYADO = /^_{5,}$/;

/** §8: el título de la tabla de cuentas de la p1. Abre las 3 filas que **no se parsean** (trampa 17). */
const RE_TABLA_CUENTAS = /^TIPO CUENTA SUCURSAL MONEDA CUENTA CBU$/;

/** §9: la leyenda del anexo, que ocupa **dos** filas — la segunda no arranca con ningún literal propio. */
const RE_LEYENDA_ANEXO = /^ESTIMADO CLIENTE/;

/** §7: el interlineado del documento es de 12.0 pt exactos; 12.5 tolera el ruido de coma flotante. */
const INTERLINEADO_MAXIMO = 12.5;

const RE_FECHA_CUERPO = /^\d{2}\/\d{2}\/\d{2}$/;
/** §10: la referencia es siempre numérica, de 1 a 10 dígitos. **No es única y no sirve como clave.** */
const RE_REFERENCIA = /^\d{1,10}$/;

/**
 * §14.2, verificado: **47 matches, 3 números distintos.** La captura 2 —el número— es la clave de sección.
 *
 * 🔴 La denominación **nunca** es la clave: se repite entre cuentas del archivo y no distingue nada.
 */
const RE_SECCION = /^(CUENTA(?: [A-ZÁÉÍÓÚÑ.]+)+) NRO\.:\s*(\d-\d{3}-\d{10}-\d)$/;
const RE_CBU = /^Clave Bancaria Uniforme para Debito Directo:\s*(\S+)/;
/** §2.1: 47 apariciones — una por página, no una por cuenta. Abre la región de tabla. */
const RE_ENCABEZADO_TABLA = /^FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO$/;
/** §2.1: 3 apariciones, una por cuenta. Saldo inicial **rotulado**. */
const RE_SALDO_ULTIMO = /^SALDO ULTIMO EXTRACTO AL (\d{2}\/\d{2}\/\d{4})/;
/** §2.1: 3 apariciones, una por cuenta. Cierra la región de tabla y trae el saldo final declarado. */
const RE_SALDO_FINAL = /^SALDO FINAL AL DIA (\d{2}\/\d{2}\/\d{4})/;

/**
 * §2.3: el período es **del archivo** y hay que **anclarlo en la etiqueta**.
 *
 * Escanear las primeras N filas y quedarse con el primer par de fechas —como hace el adaptador del primer
 * banco— lee mal acá: la línea `TOTAL COBRADO … DEL PERIODO ##/##/#### AL ##/##/####` también trae dos
 * fechas y también matchea `extraerPeriodo`.
 */
const RE_PERIODO_ARCHIVO = /^Resumen General Periodo del Extracto:\s*(.+)$/;

/**
 * 🔴 **La etiqueta del CUIT del titular — y el renglón donde `07` §2 está MAL.**
 *
 * ## Lo que dice la spec y lo que imprime el archivo
 *
 * §2 declara `CUIT + razón social | C.U.I.T  | ###########Aaaa… **pegados** | 45`. Medido con formas sobre
 * la carátula real, la fila es:
 *
 * ```
 * p1  x=[72.0  93.0  364.4]      AAAA A{9} AAA   A.A.A.A #{11}
 * ```
 *
 * O sea: **el rótulo es el tercer fragmento** de la fila, y **después de los once dígitos no hay nada**. La
 * razón social **no viene pegada**: el CUIT está solo y al final. La trampa 16 de §11, como está escrita, no
 * existe — y este renglón es, no por casualidad, **el único de la tabla de §2 sin una regex verificada en
 * §2.1**. Ver `leerTitularDelArchivo` para de dónde sale entonces la razón social.
 *
 * ## Por qué la regex quedó como quedó
 *
 * 🔴 **Por etiqueta, jamás por patrón.** `resolver-cuenta.ts` lo escribe con la medición: buscar *"el primer
 * número de once dígitos"* encuentra el CUIT de una **contraparte** y lo toma por el del titular, *"y el
 * resultado es un extracto asignado a la cuenta equivocada, con todo cuadrando"*. Acá el riesgo no es
 * teórico: el vocabulario de este banco trae el sufijo `DOC<###########>` dentro de la glosa (§12), que es
 * el documento de un tercero, en cientos de filas del cuerpo.
 *
 * **Sin `^`**, porque el rótulo es el **tercer** fragmento: `textoDeFila` une todos los fragmentos ordenados
 * por `x`, así que la fila empieza con el de `x = 72.0`. La primera versión anclaba al inicio de la fila y
 * **no matcheó ninguna de las 45** — con el residuo en **0**, porque estas filas ya están explicadas por su
 * geometría (bloque del titular, `x = 72.0`, §7). Un hueco que ninguna métrica del lote podía mostrar.
 *
 * **`[.:\s]*` como separador**, que cubre el pegado (`C.U.I.T30…`) y la puntuación de cierre. Medido: acá
 * viene con un espacio; las otras grafías quedan cubiertas sin costo.
 *
 * **Lo que NO se aflojó:** sigue anclada en la **etiqueta impresa** —`A.A.A.A` son cuatro letras con puntos,
 * confirmado— y sin mirar un solo dígito para encontrarla. Se amplió **dónde** puede estar el rótulo; no
 * **qué** cuenta como rótulo: `CUIT` a secas se sigue rechazando.
 */
const RE_CUIT_TITULAR = /C\.U\.I\.T[.:\s]*(.*)$/;

/**
 * 🔴 **La etiqueta de la razón social — y su valor está en el RENGLÓN SIGUIENTE.**
 *
 * Medido **por fragmento** sobre la carátula real (`--caratula`, dos filas consecutivas de la p1):
 *
 * ```
 * fila 2   x= 72.0   Aa(aa):                    ← el rótulo, SOLO en su fragmento
 *          x=360.2   AAAAAAA (####) AAAAAAA     ← otra columna: NO es la razón social
 * fila 3   x= 72.0   AAAA                   ┐
 *          x= 93.0   A{9} AAA               ┘   ← la razón social, en DOS fragmentos
 *          x=364.4   A.A.A.A #{11}              ← el CUIT, en la misma fila y a la derecha
 * ```
 *
 * `Aa(aa):` es `Sr(es):`, del bloque que §7 mide en **225 filas (5 × 45)** con primer fragmento en
 * `x = 72.0` — el mismo que `BLOQUE_TITULAR` descarta por geometría. **`07` §2 no tiene este renglón**, y el
 * patrón *"etiqueta en una fila, valor en la de abajo, alineados por `x`"* es el mismo que el CBU del otro
 * banco del roster (`valorPorEtiqueta` con `maxLineasAdelante`).
 *
 * Las dos filas tienen una columna a la derecha que **no** es el nombre —el `(####)` en una, el CUIT en la
 * otra—, y por eso el valor se lee **acotado a `BANDA_DEL_TITULAR`** y jamás del texto de la fila.
 *
 * La `i` no afloja nada: las guardas de `esRazonSocialPlausible` se aplican igual, y lo peor que puede pasar
 * si el banco cambia la capitalización es que el nombre siga siendo legible en vez de desaparecer.
 */
const RE_SR_ES = /Sr\(es\)\s*:\s*(.*)$/i;

/**
 * §14.4-bis: el consolidado por moneda de la carátula.
 *
 * 🔴 **Espacios flexibles, no igualdad exacta.** El archivo imprime el mismo literal con **dos espaciados
 * distintos** (§9), así que un patrón rígido devuelve la lista vacía — y con la lista vacía el único control
 * que detecta una mezcla de cuentas se apaga solo, justo en el banco donde más falta hace.
 */
const RE_CONSOLIDADO = /^Saldo\s+Cuentas\s+en\s+(PESOS|D[OÓ]LARES\s*EE\.\s*UU\.)/i;

/**
 * §9: `TOTAL COBRADO DEL IMP…` — 3 apariciones, **una por cuenta** (§14.3).
 *
 * 🔴 **Prefijo, jamás igualdad.** Trampa 1 del §9, medida: el mismo literal sale con **dos espaciados
 * distintos en el mismo archivo** — `IMP.S/CREDS. Y DEBS. EN CTAS. BANCARIAS` (2 veces, p1) y
 * `IMP.S/CREDS.Y DEBS.EN CTAS.BANCARIAS` (1 vez, p45). Con igualdad exacta se captura 2 de 3.
 *
 * Y las dos grafías **se guardan como vienen**: son dos hechos del documento. Normalizar para comparar es
 * trabajo del léxico del Módulo 2, que es código y se puede corregir; normalizar al guardar borra el dato.
 */
const RE_ANEXO_TOTAL_COBRADO = /^TOTAL COBRADO DEL IMP/;

/** §9: `D. 409/2018 - IMPUESTO LEY 25413 COMPUTABLE …` — 3 apariciones, reparto medido **0/2/1**. */
const RE_ANEXO_D409 = /^D\. 409\/2018 - IMPUESTO LEY 25413 COMPUTABLE/;

/** §9.3: la cola del `D. 409/2018` cuando el importe viene en la fila siguiente. */
const RE_ANEXO_COLA = /^\(S\.E\.U\.O\.\)/;

/**
 * El período del anexo, **completo**. Sin `$`: la fila sigue con el importe, que es otro fragmento.
 *
 * `m.index` marca dónde arranca `DEL PERIODO`, y el literal se corta ahí: es lo que deja las dos fechas
 * **afuera** de `concepto_literal`. No es prolijidad — `anexo_literal_sin_identificador_chk` (migración
 * 0008) rechaza toda corrida de 7+ dígitos, y `ddmmaaaa` sin separadores son 8.
 */
const RE_PERIODO_ANEXO_COMPLETO = /DEL PERIODO\s+(\d{2}\/\d{2}\/\d{4})\s+AL\s+(\d{2}\/\d{2}\/\d{4})/;

/**
 * 🔴 Trampa 2 del §9: **una** de las tres líneas `D. 409/2018` viene `DEL PERIODO AL <F4>`, inline y **sin
 * fecha de inicio**. Es `publicado_solo_hasta`, y es la razón por la que `periodoDesde` dejó de ser
 * obligatorio en el esquema.
 *
 * **Nunca se rellena con el período del extracto.** Sería un hecho fiscal fabricado que cuadra.
 */
const RE_PERIODO_ANEXO_SOLO_HASTA = /DEL PERIODO\s+AL\s+(\d{2}\/\d{2}\/\d{4})/;

/**
 * La puerta de admisión del literal del anexo, **espejo exacto** de `anexo_literal_sin_identificador_chk`
 * de la migración 0008. Medido: el literal más "numérico" del documento es `409/2018 … 25413`, con corrida
 * máxima de 5 dígitos. Siete es la clase de identificador más corta de `glosa.ts`.
 */
const RE_LITERAL_CON_IDENTIFICADOR = /\d{7}/;

/** Marcas del documento por las que se reconoce al banco (§2.1). Ninguna colisiona con otro adaptador. */
const MARCAS: readonly RegExp[] = [
  /^Resumen General Periodo del Extracto:/,
  /^Saldos consolidados por moneda al /,
  RE_ENCABEZADO_TABLA,
];

/**
 * Lo que NO es un movimiento (§8, §9, §14.2). Se descarta **explícitamente y con motivo escrito**, que es
 * distinto de descartarlo en silencio: una línea que ninguna regla explica termina en
 * `lineasNoInterpretadas` con su forma.
 *
 * Varias de estas filas **no son ruido, son señal o dato** —el encabezado de cuenta, el CBU, los dos saldos
 * rotulados, el anexo— y por eso se leen **antes** en el recorrido de la sección. Están igual en esta lista
 * para que, si aparecen fuera de toda sección, no se reporten como residuo.
 */
const RUIDO_MACRO: readonly { readonly patron: RegExp; readonly motivo: string }[] = [
  { patron: RE_PERIODO_ARCHIVO, motivo: 'Período del archivo; se lee aparte y una sola vez (§2.3).' },
  {
    patron: /^Saldos consolidados por moneda al /,
    motivo: 'Fecha de consolidación y `Hoja Nro.`; el pie NO declara el total de páginas (§1).',
  },
  {
    patron: /^Saldo\s+Cuentas\s+en\s/i,
    motivo: 'Consolidado por moneda; se lee aparte: es la entrada de INV-multicuenta (§14.4-bis).',
  },
  {
    patron: RE_CUIT_TITULAR,
    motivo:
      'CUIT del titular; se lee aparte y una sola vez en `leerTitularDelArchivo` (§2). Es **la misma** ' +
      'regex con la que se lee, y a propósito: con `/^C\\.U\\.I\\.T/` la fila quedaba explicada por su `x` ' +
      'aunque el lector no la enganchara, y esa asimetría dejó el hueco invisible una corrida entera.',
  },
  {
    patron: RE_SR_ES,
    motivo:
      'Razón social del titular (`Sr(es):`); se lee aparte, acotada al fragmento del rótulo. Ya la ' +
      'explicaba la geometría del bloque del titular (§7), pero la regla que la lee y la que la explica ' +
      'tienen que ser la misma: es la lección de la fila del CUIT.',
  },
  { patron: /^DETALLE DE MOVIMIENTO$/, motivo: 'Título del bloque, repetido 47 veces (§8).' },
  { patron: RE_ENCABEZADO_TABLA, motivo: 'Encabezado de columnas, repetido una vez por página (§8).' },
  { patron: RE_SECCION, motivo: 'Encabezado de cuenta: es la señal de sección, se lee aparte (§14.2).' },
  { patron: RE_CBU, motivo: 'CBU de la sección; se lee aparte (§14.2).' },
  { patron: RE_SALDO_ULTIMO, motivo: 'Saldo inicial declarado de la cuenta; es dato, se lee aparte (§2.2).' },
  { patron: RE_SALDO_FINAL, motivo: 'Saldo final declarado de la cuenta; es dato, se lee aparte (§2.2).' },
  { patron: RE_ANEXO_TOTAL_COBRADO, motivo: 'Anexo impositivo de la cuenta; se lee como anexo (§9).' },
  {
    patron: RE_ANEXO_D409,
    motivo:
      'Anexo `D. 409/2018`; se lee como anexo con `atribucionCuenta: no_determinada` (§9, trampa 15). ' +
      'Que no se sepa de qué cuenta es NO es motivo para descartarlo: es el renglón que no existe como ' +
      'movimiento.',
  },
  {
    patron: RE_ANEXO_COLA,
    motivo: 'Cola del `D. 409/2018`, que cruza el corte de página (§9, trampa 3); se consume con su etiqueta.',
  },
  { patron: RE_LEYENDA_ANEXO, motivo: 'Leyenda del anexo impositivo (§9).' },
  {
    patron: RE_REGLA_DE_SUBRAYADO,
    motivo: 'Regla de subrayado que cierra la tabla de cuentas de la p1: 1 fila, 125 guiones bajos (§8).',
  },
  {
    patron: /Tasa (?:Nom|Efec)\. Anual/,
    motivo: 'Tasas del encabezado de sección; su importe cae en la ventana de SALDO y NO es un saldo (§9).',
  },
  { patron: /^- - -/, motivo: 'Separador visual entre cuentas: 3 apariciones (§8).' },
  {
    patron: RE_TABLA_CUENTAS,
    motivo:
      'Tabla de cuentas de la p1. No se parsea: en la fila de la cuenta en dólares el banco emite MONEDA y ' +
      'CUENTA en un ÚNICO fragmento, así que leerla por `x` falla justo en la moneda extranjera ' +
      '(trampa 17). El tipo y la moneda salen del título de la sección.',
  },
];

/**
 * EL VOCABULARIO DEL BANCO — la lista **cerrada** con la que se corta `conceptoBanco` (§12).
 *
 * ## Por qué una lista cerrada y anclada, y no un heurístico
 *
 * `conceptoBancoEstrategia: 'prefijo_anclado'` significa exactamente esto: *el valor pertenece a la lista
 * cerrada de etiquetas del banco, anclada al inicio*. Las dos mitades importan:
 *
 * - 🔴 **Anclada, jamás `contains`.** Está medido (§12.1, trampa 18): `N/D DBCR 25413 S/DB TASA GRAL` es el
 *   impuesto y `N/D IDCB GRAL. EXTRAC EFVO PYME` es una **extracción de efectivo** — un `includes('IDCB')`
 *   los suma y la conciliación del anexo pasa de `true` a `false`. Y `N/D DBCR …S/DB` contra
 *   `N/C DBCR …S/CR` son **la misma raíz con los lados opuestos**, uno de ellos una reversa.
 * - 🔴 **Cerrada, sin fallback a "la glosa entera".** Es lo que sostiene INV-14 y con él la clasificación
 *   **N2** de la columna. En este archivo `TPUSH <nombre>` (569) + `TRANSF <nombre>` (409) son el **73 %**
 *   de las filas, y el vocabulario trae el sufijo `DOC<11 dígitos>`, que es el **documento de la
 *   contraparte**. Un corte "todo lo que no reconozco es concepto" se lleva el nombre y el identificador de
 *   un tercero a una columna N2 y arrastra la tabla entera al régimen de lectura auditada.
 *
 * **Cuando ninguna etiqueta matchea, no se captura concepto** — ni se inventa, ni se recorta por
 * heurística. La glosa completa vive en `descripcion`, que está clasificada justamente para eso.
 *
 * ## Cómo se compara, y por qué normalizado
 *
 * INV-14 se verifica en `persistir.ts` sobre la glosa **ya depurada**, y depurar incluye `normalizar`
 * (mayúsculas, sin acentos, espacios colapsados). Por eso el match corre sobre `normalizar(glosa)` y lo que
 * se guarda es **la etiqueta de esta lista**, no un `slice` de la glosa: así `normalizar(etiqueta)` es
 * prefijo de `normalizar(glosa)` por construcción, y las variantes de acento del propio banco
 * (`COMISIÓN`/`COMISION`) no rompen nada.
 *
 * ## Lo que queda deliberadamente afuera
 *
 * `PAGO<########>-LIQ COMER <procesadora>` (**76 movimientos**, el segundo concepto más frecuente). Los
 * ocho dígitos del medio los enmascara la depuración de INV-13 (`PAGO[DOC]-LIQ COMER …`), así que **ninguna
 * etiqueta estática puede ser prefijo de la glosa depurada** y capturarla haría rebotar el lote con
 * `concepto_banco_no_es_prefijo`. Queda como hueco declarado, no como bug silencioso.
 */
type EtiquetaDelBanco = {
  /** Lo que se guarda en `conceptoBanco`. Es prefijo de la glosa por construcción. */
  readonly etiqueta: string;
  /** Qué tiene que empezar la glosa normalizada para que la etiqueta aplique. */
  readonly ancla: string;
};

/** Etiquetas **con contraparte detrás**: el nombre del tercero va después y NO entra en el concepto. */
const PREFIJOS_CON_CONTRAPARTE: readonly string[] = [
  'TPUSH',
  'TRANSF',
  'TRANSF:',
  'CREDIN:',
  'TRF MO CCDO DIST T -',
  'CCERR',
  'TEF DATANET PR',
  '10 Sol.Resc',
  '10 Liq.Susc',
];

/**
 * 🔴 **Dónde corta el vocabulario**, que es distinto de qué literales tiene.
 *
 * A un prefijo con contraparte hay que anclarle un **separador**, si no `TPUSH` matchearía una glosa
 * hipotética `TPUSHER …` — la misma clase de error que el `contains` de la trampa 18. Pero la primera
 * versión anclaba **siempre un espacio**, y eso apagó dos etiquetas de la lista:
 *
 * > **Medido sobre el archivo real:** el banco imprime `TRANSF:<token>-<n>` y `CREDIN:<token>-<n>` **sin
 * > espacio después de los dos puntos**, así que el ancla `TRANSF: ` no matcheaba **ninguna** de las 84
 * > filas. `conceptoBanco` salía en **1186 de 1346**, y las **84** que faltaban no eran un hueco del
 * > vocabulario: eran dos etiquetas que **ya estaban en la lista** y nunca podían ganar.
 *
 * El criterio: un prefijo que **ya termina en un carácter que no es letra ni dígito** (`TRANSF:`,
 * `TRF MO CCDO DIST T -`) se delimita solo y no necesita el espacio. Uno que termina en letra o dígito
 * (`TPUSH`, `10 Sol.Resc`) sí lo necesita.
 *
 * El síntoma es el peor del módulo y por eso vale escrito: **no falla nada**. La glosa completa se guarda,
 * los importes cuadran, la cadena cierra — y 84 movimientos quedan sin concepto, o sea invisibles para el
 * motor de reconocimiento, con el lote en verde.
 */
function anclaDePrefijo(prefijo: string): string {
  const n = normalizar(prefijo);
  return /[A-Z0-9]$/.test(n) ? `${n} ` : n;
}

/**
 * Conceptos **sin contraparte**: la etiqueta es todo el concepto (§12). Puede venir seguida de los sufijos
 * estructurales del propio banco (`SUC.: ###`, `DOC<…>`, `VAR`, `CUO`), que tampoco son concepto.
 */
const CONCEPTOS_SIN_CONTRAPARTE: readonly string[] = [
  'N/D Transf. MacrOnline E-set D/T',
  'N/D Comision Trf. MacrOL E-set',
  'N/D DBCR 25413 S/DB TASA GRAL',
  'N/D DBCR 25413 S/CR TASA GRAL',
  'N/C DBCR 25413 S/CR TASA GRAL',
  'N/D FV IMPDBCR 25413 S/DB TASA GRAL',
  'N/D FV IMPDBCR 25413 S/CR TASA GRAL',
  'N/C FV IMPDBCR 25413 S/CR TASA GRAL',
  'PAGO DE CHEQUE DE CAMARA',
  'DEBITO FISCAL IVA BASICO',
  'N/D DB TRANSF MINORISTA DIST TIT',
  'N/D COMISION TRANSFERENCIAS',
  'RETENCION IIBB CORDOBA RENTA FINANC',
  'N/D DB PAGO REMUNERACIONES',
  'RETENCION IVA PERCEPCION',
  'ACREDITACION CHEQUE REMESAS',
  'N/C CR TRANSF AUT SDO MISMO TIT',
  'N/D DB TR..AUT.SDO.MISMO TIT.',
  'IMP. AFIP',
  'CHEQUE CANJE INTERNO',
  'RETIRO CAJ.AH.',
  'N/D IDCB GRAL. EXTRAC EFVO PYME',
  'N/D COM RETIRO EFECTIVO POR CAJA',
  'COMISION TRANSFERE',
  'DEPOSITO EN EFECTIVO CTA. CTE.',
  'N/C FV CR DEPOSITO CANJE INTERNO',
  'N/D FV CHEQ.DEV. DEP.CJE. INTERNO',
  'N/D FV COMISION DEPOSITO Ó RECH CHE',
  'N/D COMISION DEPOSITO O RECH CHEQ',
  'N/D COMISION ADM.VALORES AL COBRO C',
  'N/D COMISIÓN ADMINISTRACIÓN DE CHEQUERA',
  'N/D MANTENIMIENTO MENSUAL PAQUETE',
  'N/D COMISION CHQ PAG CLEARING',
  'ND CHEQUE DEVUELTO REMESAS',
];

/**
 * El vocabulario, **ordenado de etiqueta más larga a más corta**.
 *
 * El orden no es cosmético: `RETIRO CAJ.AH.` y `N/D DBCR 25413 S/DB TASA GRAL` conviven con raíces
 * compartidas, y con el orden de declaración ganaría la primera que matchea en vez de la más específica.
 * Con el orden por longitud, la etiqueta que gana es siempre la que explica **más** glosa.
 *
 * A los prefijos con contraparte se les ancla un separador: ver `anclaDePrefijo`, que es donde está el
 * criterio y la medición de las 84 filas que la primera versión perdía.
 *
 * El desempate por `ancla` cuando las longitudes son iguales no es cosmético: `TRANSF ` y `TRANSF:` miden
 * **lo mismo**, y sin un criterio explícito cuál gana depende del orden de declaración del array de arriba.
 * Que no colisionen —una glosa no puede empezar con las dos— es un hecho del formato, no una garantía del
 * código; el orden determinístico hace que el día que colisionen el resultado sea reproducible.
 */
const VOCABULARIO: readonly EtiquetaDelBanco[] = [
  ...PREFIJOS_CON_CONTRAPARTE.map((p) => ({ etiqueta: p, ancla: anclaDePrefijo(p) })),
  ...CONCEPTOS_SIN_CONTRAPARTE.map((c) => ({ etiqueta: c, ancla: normalizar(c) })),
].sort((a, b) => b.ancla.length - a.ancla.length || (a.ancla < b.ancla ? -1 : 1));

/**
 * Estrechamiento del contrato compartido, no un tipo paralelo: Macro promete más que el mínimo.
 * `consolidadosPorMoneda` y `cuentasDeclaradas` son opcionales en `SalidaDeAdaptador` porque hay bancos
 * que no los publican, pero **este** banco sí, siempre — §14.4-bis mide el consolidado por moneda de la
 * carátula, y §14.2 el literal independiente con el que se cuentan las cuentas declaradas. Ver
 * `registro.ts` para las tres formas posibles y cuándo va cada una.
 */
export type SalidaMacro = SalidaDeAdaptador & {
  readonly consolidadosPorMoneda: readonly ConsolidadoPorMoneda[];
  readonly cuentasDeclaradas: number | undefined;
  /**
   * A2 (C3, `docs/diseno/10-deuda-declarada.md` §2.1): el recuento de las siete filas posibles
   * (`DESTINOS_BASE`, `toolkit.ts`). `CAPACIDADES_MACRO.declaraDestinos: true` deja este campo
   * **requerido** acá, mismo patrón que `consolidadosPorMoneda`.
   */
  readonly destinos: ConteoDeDestinos<DestinoBase>;
};

export function reconoceMacro(filas: readonly FilaGeometrica[]): boolean {
  // 120 filas y no 80: la carátula de este banco tiene 25 renglones por página y el encabezado de tabla
  // llega recién después de ellos.
  const textos = filas.slice(0, 120).map(textoDeFila);
  return MARCAS.some((m) => textos.some((t) => m.test(t)));
}

// -----------------------------------------------------------------------------

type Contexto = {
  readonly filas: readonly FilaGeometrica[];
  readonly textos: readonly string[];
  readonly regiones: readonly RegionDeTabla[];
  readonly periodoArchivo: Periodo | null;
  /** Del **archivo**: la carátula es una sola y se repite por página (§14.3). Ver `leerTitularDelArchivo`. */
  readonly titular: DatosDelTitular;
  readonly noInterpretadas: LineaNoInterpretada[];
  /**
   * Índices ya consumidos por una pasada anterior (hoy: las filas del anexo, etiqueta **y** cola).
   *
   * No alcanza con que estén en `RUIDO_MACRO`: una fila que ya produjo un `AnexoExtracto` no es ruido, y
   * si además se reportara como residuo, el mismo renglón estaría contado dos veces en dos listas que
   * después alguien suma.
   */
  readonly consumidos: ReadonlySet<number>;
  /**
   * Filas explicadas por una regla **posicional** —no por su texto ni por su `x`—: las 3 filas de datos de
   * la tabla de cuentas de la p1 y la segunda línea de la leyenda del anexo. Ver `filasExplicadasPorBloque`.
   */
  readonly explicadasPorBloque: ReadonlySet<number>;
  /**
   * A2 (C3): marca el destino de la fila `i`. **Pisa** lo que hubiera antes — es lo que usa `cerrar`-style
   * revisión cuando una fila se marcó provisoriamente y la decisión posterior la desarma.
   */
  readonly marcar: (i: number, destino: DestinoBase) => void;
  /** Como `marcar`, pero no pisa una marca ya puesta. Es el fallback genérico (ruido conocido). */
  readonly marcarSiFalta: (i: number, destino: DestinoBase) => void;
};

/**
 * Lee el extracto.
 *
 * ## El orden de las tres pasadas, y por qué es ese
 *
 * 1. **Carátula del archivo** (período, consolidado por moneda y titular). Es del archivo, no de ninguna
 *    cuenta (§14.3), y se repite en las 45 páginas: leerla adentro del bucle de secciones la leería 45 veces
 *    — y en el caso del titular, además, perdería la única verificación gratis que tiene ese dato, que es
 *    justamente que las 45 repeticiones coincidan.
 * 2. **Sectorización** con `seccionesPorClave` y acotado del cuerpo con `regionesDeTabla`. Las dos son
 *    globales y las dos existen por el mismo motivo: el encabezado se repite por página y **una repetición
 *    no abre nada nuevo**.
 * 3. **El anexo, en una pasada del LOTE y no de la cuenta.** `ordenEnLote` es 1-based en orden de lectura
 *    **del archivo entero** —es la identidad de la fila, porque el anexo no tiene clave natural— así que no
 *    se puede numerar cuenta por cuenta sin colisionar en `uq_anexo_orden`. Ver `leerAnexosDelLote`.
 * 4. **Una cuenta por sección.** Recién acá se leen movimientos y saldos, y **siempre dentro de la
 *    sección**: es lo que hace que la cadena de saldos cierre por cuenta en vez de "casi cerrar" mezclada.
 */
export function leerMacro(filas: readonly FilaGeometrica[]): SalidaMacro {
  const textos = filas.map(textoDeFila);
  const noInterpretadas: LineaNoInterpretada[] = [];

  /**
   * A2 (C3): índice de fila → destino. Se crea ACÁ, antes de las pasadas de carátula y de anexos, porque
   * esas dos ya clasifican filas (el consolidado, el titular, el anexo) antes de que exista `Contexto`.
   * Mismo patrón que `santander.ts`: `marcar` pisa, `marcarSiFalta` no.
   */
  const destinoDeFila = new Map<number, DestinoBase>();
  const marcar = (i: number, destino: DestinoBase): void => {
    destinoDeFila.set(i, destino);
  };
  const marcarSiFalta = (i: number, destino: DestinoBase): void => {
    if (!destinoDeFila.has(i)) destinoDeFila.set(i, destino);
  };

  const periodoArchivo = leerPeriodoDelArchivo(textos);
  const consolidadosPorMoneda = leerConsolidados(filas, textos, noInterpretadas, marcar);
  const titular = leerTitularDelArchivo(filas, textos, noInterpretadas, marcar);

  const { secciones, indicesSinSeccion } = seccionesPorClave(textos, claveDeSeccion);

  /**
   * El cuerpo, acotado. **No es redundante con el criterio de la fecha, es la segunda vuelta de llave**:
   * §9 mide 178 importes de fuera de la tabla cayendo en la ventana de `SALDO` con el borde derecho
   * **idéntico** (553.8) al del cuerpo, y —a diferencia del primer banco, donde el anexo estaba al final—
   * acá están **arriba de cada página** y **entre las cuentas**.
   */
  const regiones = regionesDeTabla(textos, RE_ENCABEZADO_TABLA, RE_SALDO_FINAL);

  const anexado = leerAnexosDelLote(filas, textos, secciones, noInterpretadas, marcar);

  const contexto: Contexto = {
    filas,
    textos,
    regiones,
    periodoArchivo,
    titular,
    noInterpretadas,
    consumidos: anexado.consumidos,
    explicadasPorBloque: filasExplicadasPorBloque(filas, textos),
    marcar,
    marcarSiFalta,
  };
  const cuentas = secciones.map((s) => armarCuenta(contexto, s, anexado.porSeccion.get(s.clave) ?? []));

  // Lo que está antes del primer encabezado de cuenta: carátula, leyendas y la tabla de cuentas de la p1.
  for (const i of indicesSinSeccion) reportarSiEsResiduo(contexto, i);

  return {
    cuentas,
    lineasNoInterpretadas: noInterpretadas,
    /**
     * §1: **el dato no existe.** El pie dice `Hoja Nro.: N`, sin total. Devolver acá la cantidad de páginas
     * leídas convertiría `EST_PAGINAS_DECLARADAS_NO_COINCIDEN` en una comparación de un número consigo
     * mismo — el chequeo que siempre pasa.
     */
    paginasDeclaradas: undefined,
    consolidadosPorMoneda,
    cuentasDeclaradas: cuentasDeclaradasPorElDocumento(textos),
    // A2 (C3): la partición completa, contada — no autocertificada por ninguna rama del lector.
    destinos: contarDestinos(DESTINOS_BASE, destinoDeFila, filas.length),
  };
}

/** La clave de sección es **el número**, nunca el título (§14.2). */
function claveDeSeccion(texto: string): string | null {
  return RE_SECCION.exec(texto)?.[2] ?? null;
}

/**
 * Cuántas cuentas **declara el documento**, contadas desde un literal **distinto** del que se usó para
 * sectorizar (§14.2): los pares `SALDO ULTIMO EXTRACTO AL` / `SALDO FINAL AL DIA`, 3 y 3 para 3 cuentas.
 *
 * ## Por qué no se compara acá contra las secciones leídas
 *
 * Porque eso sería **autocertificarse**, que es lo primero que el contrato del adaptador prohíbe: el mismo
 * módulo que puede haber leído mal diría que leyó bien. El cruce lo hace `verificarConteoDeCuentas` desde
 * afuera, y rechaza el lote con `cuentas_no_coinciden`.
 *
 * Y es el único control que ve **una cuenta que nunca se abrió**: si su saldo final es `0,00` —el caso real
 * de la cuenta en dólares—, perderla no mueve el consolidado por moneda ni rompe ninguna cadena de saldos.
 *
 * ## Lo único que sí se decide acá
 *
 * Si los **dos** literales del propio documento se contradicen (2 aperturas y 3 cierres), no hay un número
 * que declarar: el documento no tiene la forma que este adaptador sabe leer. Devolver el máximo o el mínimo
 * sería elegir por el operador, y elegir mal deja pasar el lote. Se falla con **código**, sin ninguna línea
 * del archivo: la cantidad de cuentas de un cliente tampoco se escribe en un mensaje de error.
 */
function cuentasDeclaradasPorElDocumento(textos: readonly string[]): number | undefined {
  const ultimos = textos.filter((t) => RE_SALDO_ULTIMO.test(t)).length;
  const finales = textos.filter((t) => RE_SALDO_FINAL.test(t)).length;

  // Ninguna de las dos etiquetas: el documento no declara nada. `undefined` es "no hay qué comparar", que
  // no es lo mismo que "coincide" — y así lo lee `verificarConteoDeCuentas`.
  if (ultimos === 0 && finales === 0) return undefined;
  if (ultimos !== finales) throw new ErrorDeAdaptador('layout_inesperado');
  return ultimos;
}

// -----------------------------------------------------------------------------
// Carátula del archivo
// -----------------------------------------------------------------------------

/** §2.3: `extraerPeriodo` sirve, pero **anclado en la etiqueta**. Ver `RE_PERIODO_ARCHIVO`. */
function leerPeriodoDelArchivo(textos: readonly string[]): Periodo | null {
  for (const texto of textos) {
    const m = RE_PERIODO_ARCHIVO.exec(texto);
    if (!m?.[1]) continue;
    const p = extraerPeriodo(m[1]);
    if (p) return p;
  }
  return null;
}

/**
 * El consolidado por moneda (§14.4-bis).
 *
 * Dos decisiones, las dos con su medición:
 *
 * 1. **El importe se lee de la ventana de `SALDO`**, no del texto de la fila. Es el mismo borde derecho
 *    (553.8) que el del cuerpo — §9 lo cuenta entre los 178 importes de fuera de tabla que caen ahí—, así
 *    que la posición es exacta y no hace falta adivinar cuál de los tokens de la línea es el número.
 * 2. **Se toma la primera aparición de cada moneda y se controlan las otras 44.** El literal sale 45 veces
 *    por moneda con el mismo valor; si una repetición trajera otro importe, eso no es un empate a resolver
 *    por preferencia: es un hallazgo, y se reporta.
 */
function leerConsolidados(
  filas: readonly FilaGeometrica[],
  textos: readonly string[],
  noInterpretadas: LineaNoInterpretada[],
  marcar: (i: number, destino: DestinoBase) => void,
): readonly ConsolidadoPorMoneda[] {
  const porMoneda = new Map<Moneda, ConsolidadoPorMoneda>();

  for (const [i, texto] of textos.entries()) {
    const m = RE_CONSOLIDADO.exec(texto);
    if (!m) continue;
    const fila = filas[i];
    if (!fila) continue;

    const moneda: Moneda = /PESOS/i.test(m[1] ?? '') ? 'ARS' : 'USD';
    const importe = importeDeLaVentanaDeSaldo(fila);
    if (importe === null) {
      noInterpretadas.push(residuo('columna_sin_ancla', fila, texto, i));
      marcar(i, 'residuo');
      continue;
    }

    const ya = porMoneda.get(moneda);
    if (ya === undefined) {
      porMoneda.set(moneda, { moneda, importe, paginaPdf: fila.pagina });
      marcar(i, 'ruido');
      continue;
    }
    if (ya.importe !== importe) {
      noInterpretadas.push(residuo('desconocido', fila, texto, i));
      marcar(i, 'residuo');
    } else {
      marcar(i, 'ruido');
    }
  }

  return [...porMoneda.values()];
}

// -----------------------------------------------------------------------------
// El titular: SIEMPRE por etiqueta, y el corte del pegado por posición
// -----------------------------------------------------------------------------

/** §2, **medido**: el CUIT del titular son **11 dígitos corridos**, sin guiones. */
const LARGO_DEL_DOCUMENTO = 11;

/**
 * La banda horizontal del bloque del titular, para leer el valor del renglón de abajo. Ver `RE_SR_ES` para
 * la medición por fragmento de las dos filas.
 *
 * `desde` es el mismo ancla que `BLOQUE_TITULAR`, que es lo que hace que la banda sea *el bloque* y no una
 * coordenada suelta. `hasta` **no es un ajuste fino**: entre el último fragmento del nombre (`x = 93.0`) y
 * la columna de la derecha (`360.2` y `364.4`) hay más de 260 pt de aire, así que 300 está lejos de los dos
 * y ningún corrimiento razonable del layout lo mueve de lugar.
 */
const BANDA_DEL_TITULAR = {
  desde: BLOQUE_TITULAR.x - BLOQUE_TITULAR.tolerancia,
  hasta: 300,
} as const;

/**
 * Lo que el archivo declara sobre su titular. `titularCondicionIva` **no está**: la carátula de este banco
 * no publica ninguna etiqueta de condición ante IVA (§2 no la lista), y no se deduce de nada. Queda
 * **ausente y declarado**, que es un dato — a diferencia de un valor plausible leído del lugar equivocado.
 */
type DatosDelTitular = {
  readonly titular?: string;
  readonly titularDocumento?: string;
};

/**
 * Los datos del titular de la carátula, leídos **una vez para todo el archivo** (§14.3).
 *
 * ## 🔴 Dos renglones distintos, no uno — y `07` §2 dice lo contrario
 *
 * §2 declara el CUIT y la razón social **pegados en un mismo token**. Medido con formas, es **falso**: son
 * dos filas del bloque del titular, y la del CUIT **termina en los once dígitos**.
 *
 * Medido **por fragmento**, son dos filas consecutivas y tres columnas:
 *
 * | Fila | Fragmentos | Qué es |
 * |---|---|---|
 * | 2 | `x=72.0` → `Sr(es):` · `x=360.2` → `AAAAAAA (####) AAAAAAA` | la **etiqueta sola**, y otra columna |
 * | 3 | `x=72.0` + `x=93.0` → la razón social · `x=364.4` → `C.U.I.T #{11}` | el **valor** de la etiqueta de arriba, y el CUIT |
 *
 * O sea: **la etiqueta `Sr(es):` no lleva su valor al lado sino en el renglón siguiente**, alineado por `x`
 * —el mismo patrón que el CBU del otro banco del roster— y en esa misma fila, a la derecha, está el CUIT.
 *
 * La versión anterior leía el documento del renglón correcto y **lo tiraba**, porque exigía una razón social
 * pegada detrás que no existe: saltaba la guarda de *"la razón social no puede quedar vacía"* y los dos
 * campos volvían ausentes. **La guarda estaba bien; la premisa era falsa.** Por eso la guarda no se borró:
 * se convirtió en *"si hay texto después de los 11 dígitos, tiene que ser una razón social válida"*, que
 * sigue cubriendo a un banco que sí los pegue.
 *
 * ## Para qué existe este dato, y qué se sacrifica primero
 *
 * `titularDocumento` es un **control cruzado de INV-6**: valida que el archivo sea del cliente declarado. No
 * resuelve la cuenta —eso lo hacen el número y el CBU— así que no bloquea nada si falta. Justamente por eso
 * **vale menos que cero si sale mal**: un control que da verdadero cuando debería dar falso es peor que no
 * tenerlo. `titular` es informativo, así que ante la duda se sacrifica ese primero.
 *
 * ## Las guardas, y qué pasa si alguna no da
 *
 * | Guarda | Si no da |
 * |---|---|
 * | La etiqueta aparece | el campo queda **ausente**. No se inventa nada |
 * | Los 11 primeros caracteres son dígitos | `titularDocumento` ausente — no se corta a ciegas |
 * | Si hay texto detrás de los 11, es una razón social plausible | `titularDocumento` ausente: el corte cayó mal |
 * | El valor de `Sr(es):` está en la fila de abajo, misma página, a un interlineado | `titular` ausente: no se barre el bloque buscando un nombre |
 * | Solo los fragmentos de `BANDA_DEL_TITULAR` entran en el nombre | el CUIT (`x = 364.4`) y el `(####)` (`x = 360.2`) quedan afuera **por geometría** |
 * | La razón social no tiene dígitos y empieza con letra | `titular` ausente — la segunda línea de defensa de las dos anteriores |
 *
 * ## La repetición en las 45 páginas es una verificación, no una molestia
 *
 * 🔴 De cada renglón se toma el **primero** y se controla que las otras 44 digan lo mismo. Un valor
 * contradicho **se reporta y queda ausente**: elegir uno dejaría el control cruzado de INV-6 validando
 * contra uno de los dos titulares del archivo, que es el falso verdadero que este dato existe para evitar.
 * Los dos renglones se verifican **por separado** y caen por separado — un `C.U.I.T` contradicho no borra un
 * `Sr(es):` que sí coincide. Lo que no puede pasar es que un valor contradicho se elija por preferencia.
 *
 * ⚠️ Nada de esto se imprime: los valores van a `CuentaDetectada` y lo único que llega al residuo es la
 * **forma** de la fila.
 */
function leerTitularDelArchivo(
  filas: readonly FilaGeometrica[],
  textos: readonly string[],
  noInterpretadas: LineaNoInterpretada[],
  marcar: (i: number, destino: DestinoBase) => void,
): DatosDelTitular {
  const acordado = <T,>(
    leer: (fila: FilaGeometrica, i: number) => T | null,
    iguales: (a: T, b: T) => boolean,
  ): T | null => valorAcordadoEnElArchivo(filas, textos, noInterpretadas, leer, iguales, marcar);

  const delCuit = acordado(
    (fila) => {
      const valor = valorDeLaEtiqueta(fila, RE_CUIT_TITULAR);
      return valor === null ? null : cortarElPegado(valor);
    },
    (a, b) => a.documento === b.documento && a.titular === b.titular,
  );

  const razonSocial = acordado((_fila, i) => razonSocialDelBloque(filas, i), (a, b) => a === b);

  /**
   * Si el documento vino con la razón social pegada —otro banco, u otro período de este— gana esa, porque
   * es la que el documento imprime **en el mismo renglón** que el número. Acá siempre es `null` y el nombre
   * sale de `Sr(es):`.
   */
  const titular = delCuit?.titular ?? razonSocial;

  return {
    ...(titular === null || titular === undefined ? {} : { titular }),
    ...(delCuit === null ? {} : { titularDocumento: delCuit.documento }),
  };
}

/**
 * La razón social del titular: **etiqueta en un renglón, valor en el de abajo**, alineados por `x`.
 *
 * ## Las cuatro condiciones, y qué mide cada una
 *
 * | Condición | Por qué |
 * |---|---|
 * | La fila `i` trae la etiqueta `Sr(es):` **sola en su fragmento** | es la forma medida; si el rótulo trae algo pegado, ese algo es el valor y se usa **ese** (cubre a un banco que lo imprima inline) |
 * | La fila `i + 1`, **misma página**, a **un** interlineado | ventana de **una** fila y explícita: es la que está medida. Un barrido "buscá el nombre más abajo" agarraría el domicilio, y prefiero `titular` ausente |
 * | Solo los fragmentos de `BANDA_DEL_TITULAR` | 🔴 en esa fila el CUIT está a la derecha (`x = 364.4`): un corte por *texto de la fila* se lo lleva puesto y guarda el documento del cliente adentro del campo del nombre |
 * | `esRazonSocialPlausible` sobre el resultado | la segunda línea de defensa: si la banda igual dejara pasar un `(####)` o el CUIT, el nombre queda **ausente** en vez de sucio |
 *
 * Los **dos** fragmentos del nombre (`x = 72.0` y `93.0`) se unen con un espacio: cortar por fragmento acá
 * devolvería la primera palabra sola.
 */
function razonSocialDelBloque(filas: readonly FilaGeometrica[], i: number): string | null {
  const fila = filas[i];
  if (fila === undefined) return null;

  const pegadoAlRotulo = fila.fragmentos
    .map((f) => RE_SR_ES.exec(f.texto)?.[1]?.trim())
    .find((v) => v !== undefined);
  if (pegadoAlRotulo === undefined) return null;

  // Un banco que imprima el nombre en el mismo fragmento que el rótulo: se usa ese y no se mira abajo.
  if (pegadoAlRotulo !== '') return esRazonSocialPlausible(pegadoAlRotulo) ? pegadoAlRotulo : null;

  const siguiente = filas[i + 1];
  if (siguiente === undefined || siguiente.pagina !== fila.pagina) return null;
  const salto = fila.y - siguiente.y;
  if (salto <= 0 || salto > INTERLINEADO_MAXIMO) return null;

  const valor = siguiente.fragmentos
    .filter((f) => f.x >= BANDA_DEL_TITULAR.desde && f.x < BANDA_DEL_TITULAR.hasta)
    .map((f) => f.texto)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return esRazonSocialPlausible(valor) ? valor : null;
}

/**
 * El valor que sigue a una etiqueta, **acotado al fragmento donde está el rótulo**.
 *
 * 🔴 **Acotado al fragmento, y no "todo lo que sigue en la fila".** Medido: las dos filas del bloque del
 * titular tienen una columna a la derecha que no es su valor —el `(####)` en una, el CUIT en la otra—.
 * Leyendo el texto de la fila entera, esa columna se pega al final del valor. El corte por fragmento la deja
 * afuera **por construcción**, sin depender de reconocer su contenido.
 *
 * El único caso que el corte por fragmento perdería —rótulo y valor en fragmentos **distintos**— se cubre
 * mirando el fragmento siguiente cuando el del rótulo no trae nada más. Y si ese siguiente resulta ser la
 * columna vecina, lo frenan las guardas del que llama: acá no hay ninguna decisión que dependa de adivinar.
 */
function valorDeLaEtiqueta(fila: FilaGeometrica, etiqueta: RegExp): string | null {
  for (const [j, fragmento] of fila.fragmentos.entries()) {
    const m = etiqueta.exec(fragmento.texto);
    if (!m) continue;
    const resto = (m[1] ?? '').trim();
    if (resto !== '') return resto;
    // El rótulo ocupa el fragmento entero: el valor, si está, es el fragmento siguiente de la misma fila.
    const siguiente = fila.fragmentos[j + 1]?.texto.trim() ?? '';
    return siguiente === '' ? null : siguiente;
  }
  return null;
}

/**
 * Toma el valor de un renglón que el documento **repite en las 45 páginas** y devuelve el acordado, o `null`
 * si dos páginas se contradicen — reportando la discrepancia como hallazgo.
 *
 * Es el mismo criterio que `leerConsolidados` aplica al consolidado por moneda, con una diferencia: allá el
 * primero se conserva porque es un importe que igual se verifica contra la suma de las cuentas; acá **no hay
 * contra qué verificarlo**, así que un valor contradicho no se elige, se pierde.
 */
function valorAcordadoEnElArchivo<T>(
  filas: readonly FilaGeometrica[],
  textos: readonly string[],
  noInterpretadas: LineaNoInterpretada[],
  leer: (fila: FilaGeometrica, i: number) => T | null,
  iguales: (a: T, b: T) => boolean,
  marcar: (i: number, destino: DestinoBase) => void,
): T | null {
  let primero: T | null = null;
  let contradicho = false;

  for (const [i, fila] of filas.entries()) {
    const leido = leer(fila, i);
    if (leido === null) continue;
    if (primero === null) {
      primero = leido;
      continue;
    }
    if (iguales(primero, leido)) continue;

    contradicho = true;
    noInterpretadas.push(residuo('desconocido', fila, textos[i] ?? '', i));
    marcar(i, 'residuo');
  }

  return contradicho ? null : primero;
}

/**
 * Corta el valor del renglón del CUIT en documento y —**si el banco la pega**— razón social.
 *
 * Medido en este archivo: **no la pega**, el renglón termina en los once dígitos y `titular` sale `null`,
 * que es un resultado **válido** y no un fallo. La rama del pegado se conserva porque la guarda que la
 * cubre es la misma que detecta un corte mal puesto: un resto que no parece una razón social significa que
 * los primeros 11 caracteres tampoco eran el documento, y entonces **se descarta todo el renglón**.
 */
function cortarElPegado(
  valor: string,
): { readonly documento: string; readonly titular: string | null } | null {
  const documento = valor.slice(0, LARGO_DEL_DOCUMENTO);
  if (!/^\d{11}$/.test(documento)) return null;

  const resto = valor.slice(LARGO_DEL_DOCUMENTO).trim();
  if (resto === '') return { documento, titular: null };
  return esRazonSocialPlausible(resto) ? { documento, titular: resto } : null;
}

/**
 * Si un texto puede ser la razón social del titular.
 *
 * Las dos guardas son las de `galicia.ts`, por el mismo motivo y con una medición propia: **la forma medida
 * es alfabética**, y lo que puede colarse acá es el `(####)` de la columna que comparte baseline con el
 * bloque del titular. Un nombre con dígitos se rechaza — y rechazar significa `titular` **ausente**, que es
 * el resultado seguro para un campo informativo.
 */
function esRazonSocialPlausible(texto: string): boolean {
  return texto !== '' && /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(texto) && !/\d/.test(texto);
}

// -----------------------------------------------------------------------------
// Una cuenta por sección
// -----------------------------------------------------------------------------

/**
 * Arma la cuenta de una sección: sus movimientos y sus dos saldos rotulados.
 *
 * Los anexos llegan **ya leídos y ya numerados** desde la pasada del lote: su ordinal es del lote entero
 * (`uq_anexo_orden`) y su atribución la decide `leerAnexosDelLote`, no la posición en este bucle.
 *
 * ## Una sección con CERO movimientos igual emite su cuenta
 *
 * Es el caso de la cuenta en dólares (§14.6), y es **legítimo**: tiene saldo inicial y final impresos, los
 * dos en `0,00`. Devolver `null` la borraría del lote, y con ella se iría la única cuenta de esa moneda —
 * dejando `Saldo Cuentas en DOLARES EE.UU.` sin nada contra qué compararse. `verificarAritmetica` ya sabe
 * degradar `EST_SIN_MOVIMIENTOS` a observación cuando el **lote** sí trajo movimientos.
 */
function armarCuenta(
  ctx: Contexto,
  seccion: SeccionDetectada,
  anexos: readonly AnexoExtracto[],
): CuentaConMovimientos {
  /**
   * El título se lee del encabezado que **abrió** la sección, y no del último visto.
   *
   * Es lo que hace inofensiva la trampa de orden de la p2 (§14.2): ahí el encabezado de la cuenta anterior
   * se repite **antes** de que empiece la nueva, para colgarle la cola de su anexo. Con la reapertura por
   * número esas filas vuelven solas a su sección, y tomando el título de la apertura no hay ninguna fila que
   * pueda renombrar una cuenta a mitad de camino.
   */
  const titulo = tituloDeLaSeccion(ctx.textos, seccion);
  const moneda = monedaDelTitulo(titulo);
  const movimientos: MovimientoBancarioCrudo[] = [];

  let cbu: string | null = null;
  let saldoInicial: ImporteCanonico | null = null;
  let saldoFinal: ImporteCanonico | null = null;
  let fechaSaldoFinal: string | null = null;
  let filaNumero = 0;

  for (const i of seccion.indices) {
    const fila = ctx.filas[i];
    const texto = ctx.textos[i];
    if (fila === undefined || texto === undefined || texto === '') continue;

    // Ya lo leyó la pasada de anexos del lote: ni movimiento, ni saldo, ni residuo.
    if (ctx.consumidos.has(i)) continue;

    // --- Señal y dato de la sección: se leen ANTES de cualquier regla de ruido ---

    /**
     * A2 (C3): `RE_SECCION` y `RE_CBU` se consumen con `continue` ANTES de llegar a `esRuidoConocido` /
     * `reportarSiEsResiduo` — igual que ya están en `RUIDO_MACRO` para cuando aparecen FUERA de una
     * sección (`indicesSinSeccion`), pero acá adentro nunca pasan por esa función. Sin la marca explícita
     * quedan `sinDestino`.
     */
    if (RE_SECCION.test(texto)) {
      ctx.marcar(i, 'ruido');
      continue;
    }

    const cbuLeido = RE_CBU.exec(texto)?.[1];
    if (cbuLeido !== undefined) {
      cbu ??= cbuLeido;
      ctx.marcar(i, 'ruido');
      continue;
    }

    if (RE_SALDO_ULTIMO.test(texto)) {
      const importe = importeDeLaVentanaDeSaldo(fila);
      if (importe === null) {
        ctx.noInterpretadas.push(residuo('fila_sin_importe', fila, texto, i));
        ctx.marcar(i, 'residuo');
      } else {
        saldoInicial ??= importe;
        ctx.marcar(i, 'saldoDeclarado');
      }
      continue;
    }

    const finalM = RE_SALDO_FINAL.exec(texto);
    if (finalM) {
      const importe = importeDeLaVentanaDeSaldo(fila);
      if (importe === null) {
        ctx.noInterpretadas.push(residuo('fila_sin_importe', fila, texto, i));
        ctx.marcar(i, 'residuo');
      } else {
        saldoFinal ??= importe;
        ctx.marcar(i, 'saldoDeclarado');
      }
      fechaSaldoFinal ??= parsearFecha(finalM[1] ?? '');
      continue;
    }

    // --- El cuerpo ---

    /**
     * 🔴 **El criterio que hace que los 178 importes de fuera de la tabla no entren como saldos** (§9).
     *
     * Una fila es un movimiento si tiene una fecha `dd/mm/aa` en `x = 33.0` **y** cae dentro de una región
     * de tabla. Recién entonces se le lee el saldo. Barriendo la página por la ventana del borde derecho se
     * capturarían las 44 filas de `Tasa Efec. Anual`, los 90 `Saldo Cuentas en …` y los 6 saldos rotulados
     * —todos con el mismo borde 553.8— como si fueran saldos del cuerpo.
     */
    const fechaFrag = fragmentoEnX(fila, COLUMNAS.fecha.x, COLUMNAS.fecha.tolerancia);
    const esMovimiento =
      fechaFrag !== undefined &&
      RE_FECHA_CUERPO.test(fechaFrag.texto) &&
      dentroDeAlgunaRegion(ctx.regiones, i);

    if (esMovimiento && fechaFrag) {
      const leido = leerMovimiento(fila, fechaFrag.texto, ctx.periodoArchivo, filaNumero + 1, moneda);
      if ('codigo' in leido) {
        ctx.noInterpretadas.push(residuo(leido.codigo, fila, texto, i));
        ctx.marcar(i, 'residuo');
        continue;
      }
      filaNumero += 1;
      movimientos.push(leido.movimiento);
      ctx.marcar(i, 'movimiento');
      continue;
    }

    reportarSiEsResiduo(ctx, i);
  }

  return {
    cuenta: armarCuentaDetectada({
      titulo,
      numero: seccion.clave,
      cbu,
      moneda,
      saldoInicial,
      saldoFinal,
      fechaSaldoFinal,
      periodoArchivo: ctx.periodoArchivo,
      titular: ctx.titular,
    }),
    /**
     * 🔴 **Los hashes se asignan por cuenta, con la cuenta adentro de la clave** (§10).
     *
     * El archivo trae **7 grupos de filas duplicadas, 19 filas**, repartidas entre las cuentas. Sin el
     * número de cuenta en el material, dos movimientos idénticos de cuentas distintas **colapsan al mismo
     * hash**: uno se pierde contra `unique (cliente_id, cuenta_bancaria_id, fila_hash)` o —peor— queda
     * atribuido a la cuenta equivocada. Y el ordinal de empate se cuenta **dentro** de esta cuenta.
     */
    movimientos: conHashes(movimientos, {
      bancoCodigo: BANCO_CODIGO,
      numeroNormalizado: normalizarNumeroCuenta(seccion.clave),
      moneda,
    }),
    anexos: [...anexos],
  };
}

function conHashes(
  movimientos: readonly MovimientoBancarioCrudo[],
  clave: ClaveCuenta,
): MovimientoBancarioCrudo[] {
  const hashes = hashesDeCuenta(
    clave,
    movimientos.map((m) => ({
      fecha: m.fecha,
      importe: m.importe,
      saldo: m.saldo ?? null,
      descripcion: m.descripcion,
    })),
  );
  return movimientos.map((m, i) => ({ ...m, filaHash: hashes[i] ?? '' }));
}

/**
 * La cuenta detectada.
 *
 * ## Qué es del archivo y qué de la sección (§14.3)
 *
 * - **`periodoHasta` sale de la sección**: `SALDO FINAL AL DIA <fecha>` es literalmente el último día del
 *   período de **esa** cuenta. Que en el archivo medido las tres coincidan con el período del archivo es un
 *   hecho, no una garantía: las etiquetas son por cuenta y podrían diferir.
 * - **`periodoDesde` sale del archivo.** La etiqueta de la sección —`SALDO ULTIMO EXTRACTO AL`— **no es el
 *   inicio del período**: mide `31/10/2025` contra un período que arranca el `01/11/2025`, o sea que es la
 *   fecha del saldo del extracto **anterior**. Usarla como inicio correría el borde un día y ensuciaría
 *   `EST_FECHA_FUERA_DE_PERIODO` sin que nadie lo note. Cómo se obtiene el inicio del período **por
 *   cuenta** cuando difiera del archivo (un alta a mitad de mes) queda **no determinado**: no hay un caso
 *   medido del que deducirlo.
 */
function armarCuentaDetectada(d: {
  readonly titulo: string;
  readonly numero: string;
  readonly cbu: string | null;
  readonly moneda: Moneda;
  readonly saldoInicial: ImporteCanonico | null;
  readonly saldoFinal: ImporteCanonico | null;
  readonly fechaSaldoFinal: string | null;
  readonly periodoArchivo: Periodo | null;
  readonly titular: DatosDelTitular;
}): CuentaDetectada {
  const hasta = d.fechaSaldoFinal ?? d.periodoArchivo?.hasta;
  const desde = d.periodoArchivo?.desde;

  return {
    denominacion: d.titulo,
    tipoCuenta: tipoDeCuentaDelTitulo(d.titulo),
    numero: d.numero,
    ...(d.cbu === null ? {} : { cbu: d.cbu }),
    /**
     * Del **archivo**, no de la sección: la carátula es una sola (§14.3). Las tres cuentas comparten
     * titular porque el documento tiene un solo bloque `C.U.I.T `, repetido por página.
     *
     * `titularCondicionIva` queda **ausente**: §2 no lista ninguna etiqueta de condición ante IVA en este
     * banco. Ver `leerTitularDelArchivo`.
     */
    ...d.titular,
    moneda: d.moneda,
    ...(desde === undefined ? {} : { periodoDesde: desde }),
    ...(hasta === undefined ? {} : { periodoHasta: hasta }),
    ...(d.saldoInicial === null ? {} : { saldoInicialDeclarado: d.saldoInicial }),
    ...(d.saldoFinal === null ? {} : { saldoFinalDeclarado: d.saldoFinal }),
    // §2.2 y §9: no hay línea `Total`. `totalCreditosDeclarado` y `totalDebitosDeclarado` quedan **ausentes**
    // a propósito, coherentes con `traeTotalesDeclarados: false`.
  };
}

/**
 * §14.6: el tipo y la moneda salen del **título de la sección**, nunca de la tabla `TIPO CUENTA SUCURSAL…`
 * de la p1: ahí la fila de la cuenta en dólares emite `MONEDA` y `CUENTA` en un **único fragmento** y
 * parsearla por `x` falla justo en la moneda extranjera (trampa 17).
 *
 * El default es `ARS` porque el título de la tercera cuenta —`CUENTA CORRIENTE BANCARIA`— **no nombra la
 * moneda** (§14.1) y es en pesos. El default no es gratis y por eso no queda solo: una moneda mal asignada
 * rompe INV-multicuenta por `moneda_sin_consolidado` o por la suma, que es exactamente para lo que ese
 * control existe.
 */
function monedaDelTitulo(titulo: string): Moneda {
  return /D[OÓ]LAR/i.test(titulo) ? 'USD' : 'ARS';
}

/** El orden importa: `ESPECIAL` antes que `CORRIENTE`, porque el título trae las dos palabras. */
function tipoDeCuentaDelTitulo(titulo: string): CuentaDetectada['tipoCuenta'] {
  if (/ESPECIAL/i.test(titulo)) return 'cuenta_corriente_especial';
  if (/CORRIENTE/i.test(titulo)) return 'cuenta_corriente';
  if (/AHORRO/i.test(titulo)) return 'caja_ahorro';
  // §15: si aparece una caja de ahorro con otro rótulo, esto no la inventa: la declara no determinada.
  return 'no_determinado';
}

// -----------------------------------------------------------------------------
// El movimiento
// -----------------------------------------------------------------------------

type MovimientoLeido =
  | { readonly movimiento: MovimientoBancarioCrudo }
  | { readonly codigo: LineaNoInterpretada['codigo'] };

function leerMovimiento(
  fila: FilaGeometrica,
  tokenFecha: string,
  periodo: Periodo | null,
  filaNumero: number,
  moneda: Moneda,
): MovimientoLeido {
  /**
   * El período se pasa **solo para resolver el siglo** de `dd/mm/aa`. **No acota**: 4 movimientos caen
   * fuera del período declarado (§6) y son legítimos. `parsearFecha` filtra por período únicamente cuando
   * la fecha viene sin año, que no es el caso de este banco.
   */
  const fecha = parsearFecha(tokenFecha, periodo ?? undefined);
  if (fecha === null) return { codigo: 'fecha_ilegible' };

  /**
   * §4.1: **el signo NO está en el token, 0 de 1346.** Con `traeSignoEnElImporte: true` —el criterio del
   * primer banco del roster— esta llamada devuelve `null` en **todas** las filas y el adaptador lee cero
   * movimientos, sin que el síntoma diga por qué.
   */
  const par = parDeColumnas(fila, COLUMNAS_DE_IMPORTE, { traeSignoEnElImporte: false });
  if (par === null) return { codigo: 'fila_sin_importe' };

  /**
   * §7: la glosa viene en **1 a 4 fragmentos** (160 filas con 1, 340 con 2, 814 con 3, 32 con 4).
   * `fragmentoEnX` devuelve **uno** y dejaría **1186 de 1346** descripciones truncadas — con todos los
   * importes correctos y la cadena de saldos cerrando, que es el peor modo de falla del módulo.
   *
   * Y **no se trunca a ancho fijo**: acá la glosa mide entre 9 y 54 caracteres y el banco no la corta.
   */
  const glosa = fragmentosEnBanda(fila, COLUMNAS.glosa.desde, COLUMNAS.glosa.hasta);
  if (glosa === '') return { codigo: 'columna_sin_ancla' };

  const refFrag = fragmentoEnX(fila, COLUMNAS.referencia.x, COLUMNAS.referencia.tolerancia);
  const refTexto = refFrag?.texto.trim() ?? '';
  const referencia = RE_REFERENCIA.test(refTexto) ? refTexto : null;

  /**
   * ~38% medido (511/1331): el banco imprime el CUIT de la contraparte en la columna `REFERENCIA` en vez
   * de en la glosa. `RE_REFERENCIA` (1 a 10 dígitos) lo rechaza por tener 11 y `referencia` queda `null`
   * — pero seguía **descartándose entero**, sin llegar ni a `descripcion` ni a `referencias`.
   *
   * El destino es la glosa, no `referencias`: `referencias` es para el número de operación del banco, no
   * para un documento de identidad, y `depurarGlosa` (`glosa.ts`, downstream en `persistir.ts`) ya extrae
   * CUIT de `descripcion` por forma y lo enruta a `identificadores.cuit` — el mismo camino que hoy resuelve
   * el 62% de los casos donde el CUIT viene naturalmente en el texto. Agregarlo acá reusa ese mecanismo sin
   * tocarlo.
   *
   * `new RegExp(...)` porque `RE_CUIT_COMPARTIDO` trae flag `/g` y es *stateful* entre llamadas (mismo
   * patrón que `glosa.ts`): usar `.test()` directo sobre el regex importado devolvería `false` en llamadas
   * alternadas.
   */
  const refEsCuit =
    referencia === null && new RegExp(RE_CUIT_COMPARTIDO.source, RE_CUIT_COMPARTIDO.flags).test(refTexto);

  /**
   * 🔴 **No agregar lo que ya está.** Dos formas distintas del mismo hecho —la duplicación real del
   * banco (el CUIT viene en la glosa Y en `REFERENCIA`) y el solape geométrico de 0.5 pt entre
   * `COLUMNAS.glosa.hasta` y `COLUMNAS.referencia.tolerancia` (un fragmento en `x≈263.7-264.0` puede
   * caer tanto en `fragmentosEnBanda` como en `fragmentoEnX`)— hacen que `refTexto` ya sea substring de
   * `glosa` antes de concatenar nada.
   *
   * Concatenar sin este chequeo deja `"...20111111112 20111111112"`: dos CUIT de 11 dígitos con un
   * único separador en el medio son, por forma, un CBU de 22 dígitos. `depurarGlosa` (`glosa.ts`)
   * evalúa `RE_CBU` antes que `RE_CUIT` en `PATRONES`, así que reclasifica la línea entera como CBU y
   * el CUIT real desaparece (`identificadores.cuit: []`), persistiendo un CBU que no existe.
   *
   * La contención por substring cubre los dos casos sin tocar las ventanas de columna, que es
   * territorio de mayor riesgo para el 62% que ya funciona sin pasar por acá.
   */
  const refYaEstaEnGlosa = refTexto !== '' && glosa.includes(refTexto);
  const glosaConReferencia = refEsCuit && !refYaEstaEnGlosa ? `${glosa} ${refTexto}` : glosa;

  const magnitud = par.importe.startsWith('-') ? par.importe.slice(1) : par.importe;
  // Canónico: `par.saldo` salió de `centavosAImporte`. `importeACentavos` —que parsea el formato
  // argentino— devolvería `null` acá y el saldo quedaría en cero, con lo que `saldoEsAcreedor` nunca daría
  // `true` y las 283 filas en descubierto se leerían como saldo positivo.
  const saldoCent = importeCanonicoACentavos(par.saldo) ?? 0n;

  /**
   * El concepto se declara **con su procedencia**, y se omite entero cuando no se capturó.
   *
   * `conceptoCompleto` es `true` siempre que hay concepto, y es un hecho medido, no un optimismo: §7 mide
   * que la glosa de este banco **no se trunca a ancho fijo** (9 a 54 caracteres), al revés del primer banco
   * del roster, que cortaba a 27/20. O sea que la etiqueta que se reconoció entró entera.
   */
  const conceptoBanco = conceptoDeLaGlosa(glosa);
  const concepto =
    conceptoBanco === null
      ? {}
      : {
          conceptoBanco,
          conceptoCompleto: true,
          conceptoBancoEstrategia: 'prefijo_anclado' as const,
        };

  const movimiento = {
    tipoFila: 'movimiento',
    fecha,
    // §7: **cero líneas de continuación**, verificado por tres vías. Un movimiento es exactamente una fila.
    descripcionLineas: [glosaConReferencia],
    descripcion: glosaConReferencia,
    ...concepto,
    ...(par.columna === 'credito' ? { credito: magnitud } : { debito: magnitud }),
    columnaOrigen: par.columna,
    importe: par.importe,
    saldo: par.saldo,
    // §4: el saldo lleva el menos **ADELANTE** —al revés del primer banco del roster— y significa
    // descubierto en la cuenta corriente. 283 filas.
    saldoEsAcreedor: saldoCent < 0n,
    moneda,
    // §14.6: el extracto no publica cotización, y con cero movimientos en dólares no se deduce ninguna.
    cotizacionProvista: false,
    candidatosIdentificacion: [],
    ...(referencia === null
      ? { referencias: [] }
      : {
          referencias: [{ tipo: 'operacion' as const, valor: referencia }],
          referenciaExterna: referencia,
        }),
    filaNumero,
    paginaPdf: fila.pagina,
    filaHash: '',
  } as MovimientoBancarioCrudo;

  return { movimiento };
}

/**
 * El concepto del banco, o `null` si la glosa no empieza con ninguna etiqueta del vocabulario.
 *
 * Ver `VOCABULARIO`: lista cerrada, anclada al inicio, **sin fallback a la glosa entera**.
 */
function conceptoDeLaGlosa(glosa: string): string | null {
  const normalizada = normalizar(glosa);
  for (const { etiqueta, ancla } of VOCABULARIO) {
    if (normalizada.startsWith(ancla)) return etiqueta;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Anexo impositivo
// -----------------------------------------------------------------------------

/**
 * Los seis renglones de anexo del archivo, leídos en **una sola pasada del lote**.
 *
 * ## Por qué del lote y no de la cuenta
 *
 * `ordenEnLote` es 1-based en orden de lectura **del archivo entero**, y es la identidad de la fila: el
 * anexo **no tiene clave natural** —`(literal, período)` colisiona entre las tres cuentas, y normalizar el
 * literal para deduplicar borra la grafía impresa, que es dato medido—. Numerarlo cuenta por cuenta
 * reventaría `uq_anexo_orden (cliente_id, lote_ingesta_id, orden_en_lote)` en el segundo insert.
 *
 * ## Los dos renglones, y por qué el segundo es el que importa
 *
 * | Renglón | Atribución | Relación con los movimientos | Por qué |
 * |---|---|---|---|
 * | `TOTAL COBRADO DEL IMP.S/CREDS. Y DEBS.` (3) | `publicada_por_cuenta` | `resume_movimientos_del_cuerpo` | El banco lo imprime **dentro** de la sección; §5 mide que coincide con `Σ(débito − crédito)` de los movimientos cuya glosa contiene `25413`, o sea que su importe **ya está** en el cuerpo |
 * | `D. 409/2018 … COMPUTABLE CONTRA OTROS TRIBUTOS` (3) | `no_determinada` | `no_esta_en_los_movimientos` | §9 trampa 4: 3 líneas para 3 cuentas con reparto **0/2/1** — la atribución **no es posicional**. Y es el renglón que **no existe como movimiento y no es derivable de ellos**: el importe computable como pago a cuenta |
 *
 * 🔴 **El `D. 409/2018` se emite aunque no se sepa de qué cuenta es.** La versión anterior de este archivo
 * lo descartaba por eso mismo, y era el error: *"no sé de qué cuenta es"* no es motivo para perder el
 * único renglón del documento que **no se puede reconstruir desde los movimientos**. La tabla del lote
 * (migración 0008) resuelve el problema en el lugar correcto — `cuenta_bancaria_id` nullable, con
 * `atribucion_cuenta` diciendo por qué — en vez de obligar al adaptador a elegir una cuenta.
 *
 * ## Las tres trampas del §9, y dónde se resuelve cada una
 *
 * 1. **Dos variantes de espaciado del mismo literal** (2 + 1). Reconocimiento por **prefijo**, y el literal
 *    se guarda **sin normalizar**: `RE_ANEXO_TOTAL_COBRADO`.
 * 2. **Una variante `DEL PERIODO AL <F4>`, inline y sin fecha de inicio** → `publicado_solo_hasta`.
 *    `RE_PERIODO_ANEXO_SOLO_HASTA`, probado **después** del completo.
 * 3. 🔴 **Un `D. 409/2018` cruza el corte de página**: la etiqueta en la p1 y su `(S.E.U.O.) <IMP>` en la
 *    p2 **después del encabezado de cuenta repetido**. Es el único elemento del documento que se parte. Su
 *    importe se busca en la **siguiente fila `(S.E.U.O.)` sin consumir**, que puede estar en otra página, y
 *    `paginaPdf` es la de la **etiqueta**. Ver `importeDelAnexo`.
 */
type AnexosDelLote = {
  /** Por clave de sección (= número de cuenta). Una sección sin anexos no aparece. */
  readonly porSeccion: ReadonlyMap<string, readonly AnexoExtracto[]>;
  /** Índices ya explicados: las etiquetas y las colas `(S.E.U.O.)` que se consumieron. */
  readonly consumidos: ReadonlySet<number>;
};

function leerAnexosDelLote(
  filas: readonly FilaGeometrica[],
  textos: readonly string[],
  secciones: readonly SeccionDetectada[],
  noInterpretadas: LineaNoInterpretada[],
  marcar: (i: number, destino: DestinoBase) => void,
): AnexosDelLote {
  /** De qué sección es cada fila. Es dónde el banco lo **imprime**, que no es lo mismo que de qué cuenta es. */
  const seccionDeIndice = new Map<number, SeccionDetectada>();
  for (const s of secciones) for (const i of s.indices) seccionDeIndice.set(i, s);

  const porSeccion = new Map<string, AnexoExtracto[]>();
  const consumidos = new Set<number>();
  /** Índices de las colas `(S.E.U.O.)`, en orden. Se consumen de a una, en orden de lectura. */
  const colas = textos.flatMap((t, i) => (RE_ANEXO_COLA.test(t) ? [i] : []));
  let proximaCola = 0;

  let ordenEnLote = 0;

  for (const [i, texto] of textos.entries()) {
    const esTotalCobrado = RE_ANEXO_TOTAL_COBRADO.test(texto);
    const esD409 = RE_ANEXO_D409.test(texto);
    if (!esTotalCobrado && !esD409) continue;

    const fila = filas[i];
    const seccion = seccionDeIndice.get(i);
    /**
     * Sin sección no hay dónde colgarlo: `CuentaConMovimientos.anexos` es el único transporte que tiene
     * este adaptador. No se inventa una cuenta —el reparto medido dice justamente que la atribución no es
     * posicional— así que se reporta como residuo y queda visible. Medido: **no pasa** en el archivo real,
     * los 6 renglones caen dentro de una sección.
     */
    if (fila === undefined || seccion === undefined) {
      if (fila !== undefined) {
        noInterpretadas.push(residuo('linea_fuera_de_zona', fila, texto, i));
        marcar(i, 'residuo');
      }
      continue;
    }

    const periodo = periodoDelAnexo(texto);
    if (periodo === null) {
      noInterpretadas.push(residuo('desconocido', fila, texto, i));
      marcar(i, 'residuo');
      continue;
    }

    const importe = importeDelAnexo(filas, fila, colas, proximaCola);
    if (importe === null) {
      noInterpretadas.push(residuo('fila_sin_importe', fila, texto, i));
      marcar(i, 'residuo');
      continue;
    }

    /**
     * El literal se corta **antes** de `DEL PERIODO`, así que las fechas quedan afuera. Es lo que hace que
     * `TOTAL COBRADO … DEL PERIODO <F4> AL <F4>` no lleve una corrida de 8 dígitos si algún día el banco
     * imprime `ddmmaaaa` sin barras — el `check` de la base rechaza el lote entero, y acá se ve el renglón.
     */
    const conceptoLiteral = texto.slice(0, periodo.indiceDeCorte).replace(/\s+/g, ' ').trim();
    if (conceptoLiteral === '' || RE_LITERAL_CON_IDENTIFICADOR.test(conceptoLiteral)) {
      noInterpretadas.push(residuo('desconocido', fila, texto, i));
      marcar(i, 'residuo');
      continue;
    }

    ordenEnLote += 1;
    // A2 (C3): la cola —cuando la hubo— aportó el importe a ESTE renglón; no tiene registro propio.
    if (importe.indiceDeLaCola !== null) {
      consumidos.add(importe.indiceDeLaCola);
      marcar(importe.indiceDeLaCola, 'continuacion');
    }
    consumidos.add(i);
    marcar(i, 'anexo');
    proximaCola = importe.proximaCola;

    const lista = porSeccion.get(seccion.clave) ?? [];
    lista.push({
      tipoFila: 'anexo',
      conceptoLiteral,
      ordenEnLote,
      /**
       * `TOTAL COBRADO` lo imprime el banco **dentro** de la sección; el `D. 409/2018` está impreso ahí
       * también, y eso **no alcanza**: §9 mide el reparto 0/2/1 sobre 3 cuentas. La diferencia entre las
       * dos filas es la evidencia, no la posición — y es exactamente lo que declara esta columna.
       */
      atribucionCuenta: esD409 ? 'no_determinada' : 'publicada_por_cuenta',
      ...periodo.campos,
      importeDeclarado: importe.importe,
      /**
       * La moneda de la **sección en la que el banco lo imprime**, que es la misma columna en la que
       * alinea los saldos de esa cuenta. No se fuerza a `ARS`: el archivo trae una cuenta en dólares con
       * su propio `TOTAL COBRADO`, y suponerle pesos sería inventar una conversión (§14.6).
       */
      moneda: monedaDelTitulo(tituloDeLaSeccion(textos, seccion)),
      /**
       * 🔴 **El campo que convierte la prohibición en una condición sobre una columna** (INV-15).
       *
       * `TOTAL COBRADO` **resume** movimientos que ya están en el cuerpo: §5 lo mide contra
       * `Σ(débito − crédito)` de los movimientos cuya glosa contiene `25413`, y da `true` en las dos
       * cuentas con movimientos. Sumarlo cuenta el impuesto **dos veces** y el asiento cuadra igual.
       *
       * El `D. 409/2018` es el otro caso: **no existe como movimiento**. Es lo único candidato a
       * registración de todo el bloque, y hoy se perdía entero.
       */
      relacionConMovimientos: esD409 ? 'no_esta_en_los_movimientos' : 'resume_movimientos_del_cuerpo',
      // §9 trampa 3: la página donde arranca la ETIQUETA, no donde cae el importe.
      paginaPdf: fila.pagina,
    });
    porSeccion.set(seccion.clave, lista);
  }

  return { porSeccion, consumidos };
}

/** El título impreso de la sección, del encabezado que la **abrió** (nunca del último visto). */
function tituloDeLaSeccion(textos: readonly string[], seccion: SeccionDetectada): string {
  return RE_SECCION.exec(textos[seccion.indiceApertura] ?? '')?.[1] ?? 'CUENTA';
}

type PeriodoDelAnexo = {
  /** Dónde arranca `DEL PERIODO`: el literal se corta ahí. */
  readonly indiceDeCorte: number;
  readonly campos:
    | { readonly periodoDato: 'publicado_completo'; readonly periodoDesde: string; readonly periodoHasta: string }
    | { readonly periodoDato: 'publicado_solo_hasta'; readonly periodoHasta: string };
};

/**
 * Qué publica el banco sobre el período de **este** renglón. Dos de las cuatro situaciones del esquema
 * están medidas en este archivo; las otras dos (`periodo_de_emision` y `no_publicado`) son de otro banco y
 * **no se producen acá**: emitirlas sin caso medido sería declarar un hecho que el documento no dice.
 *
 * 🔴 **Si no se reconoce ninguna de las dos, el renglón NO se emite con el período del extracto.** El
 * esquema lo permitiría (`no_publicado` no lleva fechas), pero un anexo cuyo período no se entendió es un
 * renglón mal leído, no un renglón sin período: va al residuo, que es donde se ve.
 */
function periodoDelAnexo(texto: string): PeriodoDelAnexo | null {
  const completo = RE_PERIODO_ANEXO_COMPLETO.exec(texto);
  if (completo && completo.index > 0) {
    const desde = parsearFecha(completo[1] ?? '');
    const hasta = parsearFecha(completo[2] ?? '');
    if (desde !== null && hasta !== null && hasta >= desde) {
      return {
        indiceDeCorte: completo.index,
        campos: { periodoDato: 'publicado_completo', periodoDesde: desde, periodoHasta: hasta },
      };
    }
    return null;
  }

  const soloHasta = RE_PERIODO_ANEXO_SOLO_HASTA.exec(texto);
  if (soloHasta && soloHasta.index > 0) {
    const hasta = parsearFecha(soloHasta[1] ?? '');
    if (hasta !== null) {
      return {
        indiceDeCorte: soloHasta.index,
        // 🔴 `periodoDesde` queda **ausente**, no relleno. Ver `RE_PERIODO_ANEXO_SOLO_HASTA`.
        campos: { periodoDato: 'publicado_solo_hasta', periodoHasta: hasta },
      };
    }
  }
  return null;
}

type ImporteDelAnexo = {
  readonly importe: ImporteCanonico;
  /** La cola que se consumió, o `null` si el importe venía inline. */
  readonly indiceDeLaCola: number | null;
  readonly proximaCola: number;
};

/**
 * El importe del renglón, que puede estar en **su propia fila o en la siguiente `(S.E.U.O.)`**.
 *
 * §9 trampa 3: de los tres `D. 409/2018`, uno viene inline (`… (S.E.U.O.) <IMP>`, p45) y dos traen el
 * importe en una fila `(S.E.U.O.) <IMP>` posterior — y **uno de esos dos cruza el corte de página**: su
 * etiqueta está en la p1 y su cola en la p2, **después del encabezado de cuenta repetido**. Por eso la cola
 * se busca en el documento entero y no dentro de la página ni dentro de la sección.
 *
 * Las colas se consumen **en orden y una sola vez**: en la p2 hay dos, y la primera —que aparece *antes*
 * de la etiqueta de la p2— es la del renglón de la p1. Emparejarlas por cercanía las cruzaría.
 *
 * El importe se lee de la ventana de `SALDO` (borde derecho 553.8), que es donde el banco alinea los tres
 * importes del anexo. Y se exige **no negativo**: es una magnitud cobrada, no un movimiento con signo.
 */
function importeDelAnexo(
  filas: readonly FilaGeometrica[],
  fila: FilaGeometrica,
  colas: readonly number[],
  proximaCola: number,
): ImporteDelAnexo | null {
  const inline = importeDeLaVentanaDeSaldo(fila);
  if (inline !== null) {
    return inline.startsWith('-') ? null : { importe: inline, indiceDeLaCola: null, proximaCola };
  }

  const indice = colas[proximaCola];
  if (indice === undefined) return null;
  const filaDeLaCola = filas[indice];
  if (filaDeLaCola === undefined) return null;

  const importe = importeDeLaVentanaDeSaldo(filaDeLaCola);
  if (importe === null || importe.startsWith('-')) return null;
  return { importe, indiceDeLaCola: indice, proximaCola: proximaCola + 1 };
}

/**
 * Las filas que no se explican por su texto ni por su `x`, sino por **dónde están respecto de otra fila**.
 *
 * Son el resto del residuo medido, y las dos son bloques de continuación:
 *
 * | Filas | Qué | Regla |
 * |---|---|---|
 * | **3** | Los datos de la tabla `TIPO CUENTA SUCURSAL MONEDA CUENTA CBU` de la p1 | Entre el título y la regla de subrayado que la cierra |
 * | **2** | La segunda línea de la leyenda `ESTIMADO CLIENTE …` del anexo | La fila siguiente, misma página, a un interlineado |
 *
 * 🔴 **La tabla de cuentas no se parsea, y eso es una decisión** (trampa 17): en la fila de la cuenta en
 * dólares el banco emite `MONEDA` y `CUENTA` en un **único fragmento**, así que leerla por `x` falla justo
 * en la moneda extranjera. El tipo y la moneda salen del título de la sección. Pero *no parsearla* no es
 * *no explicarla*: sus 3 filas tienen destino declarado, no quedan en el residuo como "algo que no entendí".
 */
function filasExplicadasPorBloque(
  filas: readonly FilaGeometrica[],
  textos: readonly string[],
): ReadonlySet<number> {
  const explicadas = new Set<number>();

  for (const [i, texto] of textos.entries()) {
    if (RE_TABLA_CUENTAS.test(texto)) {
      // Desde el título hasta la regla de subrayado que cierra la tabla, sin salir de la página.
      const pagina = filas[i]?.pagina;
      for (let j = i + 1; j < textos.length; j += 1) {
        if (filas[j]?.pagina !== pagina) break;
        const t = textos[j] ?? '';
        if (RE_REGLA_DE_SUBRAYADO.test(t)) break;
        // Una sección abierta cierra la tabla: si falta la regla, no se traga el resto del documento.
        if (RE_SECCION.test(t)) break;
        explicadas.add(j);
      }
      continue;
    }

    if (RE_LEYENDA_ANEXO.test(texto)) {
      const actual = filas[i];
      const siguiente = filas[i + 1];
      if (
        actual !== undefined &&
        siguiente !== undefined &&
        siguiente.pagina === actual.pagina &&
        actual.y - siguiente.y <= INTERLINEADO_MAXIMO
      ) {
        explicadas.add(i + 1);
      }
    }
  }

  return explicadas;
}

// -----------------------------------------------------------------------------
// Ruido y residuo
// -----------------------------------------------------------------------------

function importeDeLaVentanaDeSaldo(fila: FilaGeometrica): ImporteCanonico | null {
  const f = fragmentoEnVentanaDerecha(
    fila,
    COLUMNAS_DE_IMPORTE.saldo.desde,
    COLUMNAS_DE_IMPORTE.saldo.hasta,
  );
  if (!f) return null;
  const centavos = importeACentavos(f.texto);
  return centavos === null ? null : centavosAImporte(centavos);
}

function esLeyendaLegal(fila: FilaGeometrica): boolean {
  const primero = fila.fragmentos[0];
  return (
    primero !== undefined &&
    Math.abs(primero.x - LEYENDA_LEGAL.x) <= LEYENDA_LEGAL.tolerancia &&
    fila.y < LEYENDA_LEGAL.yMaximo
  );
}

function esBloqueDelTitular(fila: FilaGeometrica): boolean {
  const primero = fila.fragmentos[0];
  return primero !== undefined && Math.abs(primero.x - BLOQUE_TITULAR.x) <= BLOQUE_TITULAR.tolerancia;
}

/** 90 filas (2 × 45): el encabezado de la sucursal, arriba a la derecha. Ver `ENCABEZADO_SUCURSAL`. */
function esEncabezadoDeSucursal(fila: FilaGeometrica): boolean {
  const primero = fila.fragmentos[0];
  return (
    primero !== undefined &&
    Math.abs(primero.x - ENCABEZADO_SUCURSAL.x) <= ENCABEZADO_SUCURSAL.tolerancia &&
    fila.y > ENCABEZADO_SUCURSAL.yMinimo
  );
}

/** 90 filas: la columna izquierda de la carátula. Ver `BLOQUE_CARATULA_IZQ`. */
function esBloqueDeCaratulaIzq(fila: FilaGeometrica): boolean {
  const primero = fila.fragmentos[0];
  return (
    primero !== undefined && Math.abs(primero.x - BLOQUE_CARATULA_IZQ.x) <= BLOQUE_CARATULA_IZQ.tolerancia
  );
}

function esRuidoConocido(fila: FilaGeometrica, texto: string): boolean {
  if (
    esLeyendaLegal(fila) ||
    esBloqueDelTitular(fila) ||
    esEncabezadoDeSucursal(fila) ||
    esBloqueDeCaratulaIzq(fila)
  ) {
    return true;
  }
  return RUIDO_MACRO.some((r) => r.patron.test(texto));
}

/**
 * Reporta la fila `i` **solo si ninguna regla la explica**.
 *
 * ## El criterio, después de medirlo contra el archivo real
 *
 * Es la tercera regla del contrato: un adaptador nunca descarta una línea en silencio. Pero *"fuera de la
 * región de tabla"* es una **ubicación, no un destino**, y con ese criterio el residuo de este banco tenía
 * **141 filas** que nadie podía clasificar sin volver al PDF. Medidas, eran seis bloques conocidos:
 * el encabezado de sucursal (90), la columna izquierda de la carátula (45), la tabla de cuentas de la p1
 * (3 + su regla de subrayado) y la segunda línea de la leyenda del anexo (2).
 *
 * **Toda línea del documento tiene ahora un destino declarado**: movimiento, ruido con su regla escrita,
 * anexo, o residuo. Residuo pasó a significar *"esto no lo entendí"* y no *"esto no me tocaba"* — que es
 * lo que lo vuelve una métrica accionable en vez de un número grande al que uno se acostumbra.
 *
 * Lo que va al reporte es la **forma** —dígitos a `#`, mayúsculas a `A`— y nunca el texto: una línea de
 * este documento contiene el nombre y el documento de una contraparte, y un log se rota, se indexa y se
 * respalda fuera del alcance de la RLS.
 */
function reportarSiEsResiduo(ctx: Contexto, i: number): void {
  const fila = ctx.filas[i];
  const texto = ctx.textos[i];
  if (fila === undefined || texto === undefined || texto === '') return;
  // Ya lo marcó la pasada de anexos del lote (etiqueta o cola): no se revisa acá.
  if (ctx.consumidos.has(i)) return;
  /**
   * A2 (C3): `marcarSiFalta`, no `marcar` — una fila puede llegar ya marcada `residuo` desde una pasada
   * anterior (`leerConsolidados`, `valorAcordadoEnElArchivo`) cuyo texto IGUAL matchea una regla de
   * `RUIDO_MACRO`. La marca de la pasada anterior es la que corresponde: no se pisa.
   */
  if (ctx.explicadasPorBloque.has(i)) {
    ctx.marcarSiFalta(i, 'ruido');
    return;
  }
  if (esRuidoConocido(fila, texto)) {
    ctx.marcarSiFalta(i, 'ruido');
    return;
  }
  ctx.noInterpretadas.push(residuo('linea_fuera_de_zona', fila, texto, i));
  ctx.marcar(i, 'residuo');
}

function residuo(
  codigo: LineaNoInterpretada['codigo'],
  fila: FilaGeometrica,
  texto: string,
  indice: number,
): LineaNoInterpretada {
  return { codigo, forma: formaParaLog(texto, 60), paginaPdf: fila.pagina, indice };
}

// -----------------------------------------------------------------------------
// El adaptador, con la forma del contrato
// -----------------------------------------------------------------------------

export const adaptadorMacro = {
  bancoCodigo: BANCO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_MACRO,
  reconoce: (e: EntradaDeAdaptador): boolean => reconoceMacro(e.filas),
  leer: (e: EntradaDeAdaptador): SalidaMacro => leerMacro(e.filas),
} as const;
