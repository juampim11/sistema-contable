/**
 * ADAPTADOR SANTANDER — cuenta corriente en pesos + cuenta corriente especial en U$S, PDF.
 *
 * La especificación medida está en `docs/diseno/06-formato-santander.md`. Este archivo la implementa y
 * **no repite los números**: cada constante dice de qué sección sale.
 *
 * ## Lo que hace distinto a este banco, y por qué copiar el adaptador anterior da CERO movimientos
 *
 * **El signo del importe no está en el token.** Santander imprime `$ ##.###,##` en las dos columnas de
 * importe, siempre sin signo — **0 de 158 filas traen un `-`** (spec §0 y §4). La única señal directa del
 * signo es **en qué columna cayó el token**, o sea la posición `x`.
 *
 * El lector del primer banco del roster exige que el signo del token **coincida** con la columna. Acá nunca
 * coinciden, porque el token no tiene signo: copiado tal cual devuelve `null` en las 158 filas. Por eso el
 * par se lee con `parDeColumnas(..., { traeSignoEnElImporte: false })`, que es la otra familia de la misma
 * función y **deriva** el signo de la columna. Su verificación pasa a ser la cadena de saldos —V5,
 * `ARIT_SIGNO_INVERTIDO`—, que sigue siendo una señal independiente.
 *
 * Consecuencia de diseño: `aLineas()` acá no es una alternativa degradada, es **imposible**. Las 60 filas
 * que traen el par `(importe, saldo)` en la misma línea que la fecha son textualmente **idénticas** entre
 * débito y crédito.
 *
 * ## Las cuatro decisiones estructurales
 *
 * 1. **La región de tabla no es opcional** (spec §11.3). El `##,##%` de la columna TNA del anexo tiene
 *    borde derecho **407.0** contra 408.0 de la columna de débito: **está adentro** de su ventana. Y el
 *    CFTEA está a 1.0 pt del borde de la de crédito. Acotar el cuerpo con `regionesDeTabla` es lo que
 *    impide que un anexo entre como movimiento.
 * 2. **Dos cuentas con geometría IDÉNTICA** (spec §11.6): las dos tablas usan exactamente los mismos `x` y
 *    los mismos bordes derechos. Lo único que las separa es el título de sección y la cabecera de cuenta.
 *    Un adaptador que las mezcle **igual cierra la cadena**, porque la segunda está vacía. Por eso cada
 *    región de tabla es **una cuenta**, y su moneda sale de la cabecera (con el título como control
 *    cruzado), nunca de una coordenada.
 * 3. **`Saldo Inicial` y `Saldo total` están rotulados** (spec §2.2): no se deriva nada por aritmética.
 *    `Saldo Inicial` es una fila **con fecha y sin importe** (§11.5) — ni movimiento ni error.
 * 4. **Toda fila del documento tiene un DESTINO declarado.** `"fuera de la región de tabla"` no es un
 *    destino, es una ubicación — y mientras lo fue, los 7 renglones fiscales de los dos anexos de la p9 (§9)
 *    salían **ni en `anexos` ni en `lineasNoInterpretadas`: desaparecían sin dejar rastro**, y el adaptador
 *    parecía el mejor del roster justamente por eso (0 líneas sin interpretar). Ahora cada fila cae en uno de
 *    siete destinos —`movimiento`, `continuacion`, `saldoDeclarado`, `ruido`, `anexo`, `fueraDelCuerpo`,
 *    `residuo`— y la partición **se cuenta**: `leerSantanderConDestinos` devuelve el recuento con
 *    `sinDestino`, que tiene que dar **0**. Ver `ConteoDeDestinos`.
 *
 * ## Los anexos (§9): dos bloques, 7 renglones, y el que NO está en los movimientos
 *
 * En la p9, **después** del último `Saldo total`, hay dos bloques: `Detalle impositivo` (5 renglones) y
 * `Tasas de Acuerdos y Descubierto` (2). No son movimientos —y por eso la región de tabla los deja afuera del
 * cuerpo— pero **son datos fiscales que no se derivan de nada**: entre los 5 está el `Importe susceptible de
 * ser computado contra otros tributos`, que **no existe como movimiento**.
 *
 * Los cuatro campos que el esquema pide por renglón, y de dónde sale cada uno acá:
 *
 *  - **`relacionConMovimientos`** — el más importante: §9 mide que el `Detalle impositivo` **resume impuestos
 *    que ya están en el cuerpo** (los 21+19 `Impuesto ley 25.413` y los 8 `sircreb`) y que el `Interés
 *    cobrado` de las tasas también. Sumarlos contaría el impuesto dos veces **y el asiento cuadraría igual**.
 *    Se clasifica por literal, con `no_determinada` de default — y las tres salidas son fail-closed menos
 *    `no_esta_en_los_movimientos`, que se emite **solo** contra el literal explícito.
 *  - **`periodoDato`** — la razón por la que este bloque no se emitía. Solo 1 de los 5 renglones publica su
 *    rango; el del SIRCREB dice `… en el período de emisión`, que **no es lo mismo que `no_publicado`**: el
 *    banco declara cuál es sin imprimirlo. **Ninguno de los dos autoriza a copiar el período del extracto.**
 *  - **`atribucionCuenta`** — los dos bloques están después del `Saldo total` de las **dos** cuentas, así que
 *    con este archivo la atribución es `no_determinada`. Con un archivo de una sola cuenta pasa a
 *    `cuenta_unica_del_lote`, que es cierta por aritmética y **no** por posición.
 *  - **`ordenEnLote`** — 1-based en orden de lectura sobre el lote entero. El anexo no tiene clave natural.
 *
 * ### Un renglón no siempre entra en una fila
 *
 * El rótulo puede envolver, y entonces el renglón ocupa **dos** filas: o el importe queda abajo, o el texto
 * queda abajo. Las dos formas están contempladas en `leerAnexos`, con su apareo **en orden de lectura** —
 * aparear por cercanía cruza los importes de dos rótulos consecutivos y **el lote cuadra igual**. Ahí está
 * además la **predicción numérica falsable** de la próxima corrida contra el archivo real.
 *
 * ## Lo que este adaptador NO hace
 *
 * No decide si el extracto cuadra: eso lo calcula `verificarAritmetica()`, que no lo conoce. No clasifica
 * contablemente — y en este banco eso es una regla dura y medida: **el concepto no dice el signo y a veces
 * dice lo contrario** (§11.11: `Impuesto ley 25.413 credito 0,6%` es débito en 21 de 21). Y no descarta una
 * línea del cuerpo en silencio: lo que no entiende va a `lineasNoInterpretadas` con su **forma**, nunca su
 * texto.
 */

import { formaParaLog } from '@sistema-contable/shared/observabilidad';
import { RE_CBU as RE_CBU_COMPARTIDO, RE_CUIT as RE_CUIT_COMPARTIDO } from '@sistema-contable/shared/seguridad';
import {
  centavosAImporte,
  importeACentavos,
  importeCanonicoACentavos,
  normalizar,
  parsearFecha,
} from '../parseo-ar.ts';
import { hashesDeCuenta, normalizarNumeroCuenta, type ClaveCuenta } from '../hash.ts';
import type {
  AnexoExtracto,
  AtribucionAnexo,
  CapacidadesAdaptador,
  CuentaConMovimientos,
  LineaNoInterpretada,
  Moneda,
  MovimientoBancarioCrudo,
  PeriodoAnexo,
  RelacionAnexo,
} from '../esquema.ts';
import {
  fragmentoEnVentanaDerecha,
  fragmentoEnX,
  fragmentosEnBanda,
  textoDeFila,
  type FilaGeometrica,
  type Fragmento,
} from '../texto-pdf.ts';
import {
  dentroDeAlgunaRegion,
  parDeColumnas,
  periodoPorEtiquetas,
  regionesDeTabla,
  valorPorEtiqueta,
  type ColumnasDeImporte,
  type ParDeFila,
  type RegionDeTabla,
} from './toolkit.ts';
import { ErrorDeAdaptador } from './contrato.ts';
import type { EntradaDeAdaptador, SalidaDeAdaptador } from './registro.ts';

export const BANCO_CODIGO = 'santander';
export const VERSION = 1;

/**
 * Las capacidades declaradas. **Cada una con la sección que la mide**, porque de esto depende qué puede
 * exigir la verificación: sin la declaración, "este banco no publica X" y "el adaptador no encontró X" se
 * ven exactamente igual (contrato, regla 2).
 */
export const CAPACIDADES_SANTANDER: CapacidadesAdaptador = {
  // §3: seis columnas en puntos PDF, con los tres bordes derechos **exactos y sin dispersión**.
  familiaLayout: 'columnas-posicionales',
  // §5: semilla en el `Saldo Inicial` declarado → **0 rupturas** en las 158 transiciones.
  cadenaDeSaldos: 'completa',
  /**
   * §9: **no hay línea de totales de columna.** Santander no publica total de créditos ni de débitos; lo
   * único que publica es el saldo de cierre. Con `false`, V2 no corre — y ése era el control que en el
   * primer banco atrapaba un crédito cargado como débito por el mismo importe. Acá lo reemplaza V5, que la
   * cadena de saldos habilita.
   */
  traeTotalesDeclarados: false,
  /**
   * §2.2 y §11.5: `Saldo Inicial` es una fila **rotulada** de la tabla, con fecha, glosa y saldo. `true`
   * porque hay etiqueta, no porque se derive: acá no hay que triangular nada.
   */
  traeSaldoInicialDeclarado: true,
  /**
   * §0 y §4: **0 de 158 importes traen signo**. Es la capacidad que decide con qué familia de
   * `parDeColumnas` se lee el par, y declararla mal es un adaptador que lee cero filas.
   */
  traeSignoEnElImporte: false,
  // §3, columna 6: 160 fragmentos con borde derecho exacto en 578.0 (158 movimientos + 2 `Saldo Inicial`).
  traeSaldoPorFila: true,
  // §6: **no hay fecha valor** en este formato.
  traeFechaValor: false,
  // §3, columna 2: `Comprobante`, con valor en 94 de las 158 filas (§10).
  traeReferencia: true,
  /**
   * §14.2: el `Cod. Operativo` —29 códigos para los 29 conceptos— existe, pero **está en el `.xls`, no en
   * el PDF**. Este adaptador lee el PDF, así que no lo trae. Declararlo `true` haría que el Módulo 2
   * esperara un código que nunca va a llegar.
   */
  traeCodigoDeConcepto: false,
  // §6: `dd/mm/aa` en las 158 filas y también en la carátula. Una sola forma, con año.
  anioEnLaFecha: true,
  // §10 y §11.6: dos cuentas en el archivo, corriente en pesos y corriente especial U$S.
  multiCuenta: true,
  // §11.7 y §11.8: la segunda cuenta es en dólares, con importes escritos `U$S`.
  multiMoneda: true,
  /**
   * §6: 22 fechas distintas, del 30/05 al 30/06, y el período arranca el último día del mes anterior —que
   * es justo la fecha del `Saldo Inicial`—. Ninguna de las 158 cae fuera. Se declara `false` **con el
   * archivo de referencia**, no se relaja por las dudas: con `true`, `EST_FECHA_FUERA_DE_PERIODO` bajaría a
   * observación y se apagaría el control que detecta que se capturó una línea del bloque equivocado.
   */
  traeMovimientosFueraDelPeriodo: false,
  /**
   * §2.1, trampa 2: el "Saldo total en cuentas" de las páginas 1 y 2 **es ilegible por fila**. Sale en tres
   * fragmentos (símbolo, entero, centavos), los centavos están en otro baseline —son superíndice— y, peor,
   * **los importes de pesos y de dólares comparten los mismos dos baselines**, así que la fila reconstruida
   * mezcla las dos monedas.
   *
   * O sea que este banco **no publica un consolidado por moneda legible**, y esto es `false`. La
   * consecuencia queda escrita: INV-multicuenta no corre, y el único control que ve una mezcla de cuentas
   * acá es la separación por región más el `Saldo total` de cada una.
   */
  traeConsolidadoPorMoneda: false,
};

// -----------------------------------------------------------------------------
// Geometría — todo en puntos PDF (spec §3)
// -----------------------------------------------------------------------------

/**
 * Columnas alineadas a la **izquierda**, localizadas por su borde izquierdo.
 *
 * **La tolerancia de 1.2 pt es obligatoria y está medida** (§3): el bloque `Tasas de Acuerdos y
 * Descubierto` tiene su fecha en `x = 25.0`, a **2.0 pt** de la columna de fecha. Con la tolerancia por
 * defecto de `fragmentoEnX` (1.5) todavía queda afuera, pero con 2.5 sus dos filas entrarían como
 * movimientos. Se fija en 1.2 para que el margen sea explícito y no dependa de un default.
 */
const COLUMNAS = {
  fecha: { x: 23.0, tolerancia: 1.2 },
  comprobante: { x: 65.0, tolerancia: 1.2 },
} as const;

/**
 * La banda de la glosa: `[115.0, 275.0)`, `hasta` **exclusivo** (ver `fragmentosEnBanda`).
 *
 * §7 midió que **todo** el contenido de la glosa está exactamente en `x = 115.0`, sin excepción — 258
 * fragmentos = 158 glosas + 98 continuaciones + 2 etiquetas `Saldo Inicial`—, o sea que hoy hay un solo
 * fragmento por fila y `fragmentoEnX` alcanzaría. Se usa la banda igual porque el costo es cero y el modo
 * de falla que evita es el peor del módulo: en otro banco del roster la glosa sale en 1 a 4 fragmentos y
 * `fragmentoEnX` devolvió **1186 de 1346 descripciones truncadas**, con todos los importes correctos.
 *
 * El límite superior es **275.0** porque §3 mide el borde derecho de la glosa en **≤ 274.8**: un fragmento
 * que *empieza* en 275 o más ya no es glosa. Un fragmento que empieza adentro entra entero aunque se
 * derrame, que es la semántica de `fragmentosEnBanda`.
 */
const GLOSA = { desde: 115.0, hasta: 275.0 } as const;

/**
 * Las tres columnas de importe, por su **borde derecho** (§3). El izquierdo se mueve con la cantidad de
 * dígitos; el derecho no. Medido: 83 fragmentos en `r=408.0`, 75 en `492.0`, 160 en `578.0`, con importes
 * de 3 a 10 dígitos y **cero dispersión**.
 *
 * ⚠️ La ventana de débito `[404, 412]` **contiene** el `##,##%` del TNA del anexo (`r=407.0`, §11.3). Hoy no
 * explota porque `importeACentavos('57,00%')` devuelve `null` por el `%`, pero es un pelo: lo que de verdad
 * lo deja afuera es que el anexo **no está dentro de ninguna región de tabla**.
 */
const VENTANAS: ColumnasDeImporte = {
  debito: { desde: 404.0, hasta: 412.0 },
  credito: { desde: 488.0, hasta: 496.0 },
  saldo: { desde: 574.5, hasta: 582.0 },
};

/**
 * El importe de la fila `Saldo total` cae a **4 pt** de la columna de saldo del cuerpo: `r = 574.0` contra
 * `578.0` (§11.4). Una ventana `[572, 584]` engancharía los dos, así que ésta se corta **antes** de 578.
 *
 * La otra mitad de la trampa —que la etiqueta `Saldo total` está en `x ≈ 386.7`, encima del encabezado
 * `Débito` (385.6), y que un clasificador por columna la leería como un débito enorme— **no se resuelve
 * acá**: se resuelve porque la fila de cierre queda **fuera** del cuerpo de la región y nunca pasa por el
 * autómata de movimientos.
 */
const VENTANA_SALDO_TOTAL = { desde: 571.0, hasta: 576.0 } as const;

/**
 * Geometría de los dos bloques de anexo de la p9 (§9, §3, §11.3).
 *
 * ⚠️ La ventana del importe del `Detalle impositivo` es **disjunta** de las tres del cuerpo: `528.0` contra
 * `492.0` de crédito y `578.0` de saldo. Se abre ±4 pt, el mismo criterio que las del cuerpo, y no llega a
 * tocar ninguna. Que además el bloque esté fuera de toda región de tabla es la **segunda** defensa, no la
 * única: acá el anexo sí se lee, así que el aislamiento por geometría vuelve a importar.
 */
const ANEXO = {
  /** §9: 5 importes con borde derecho **528.0**. */
  importe: { desde: 524.0, hasta: 532.0 },
  /**
   * §3: la fecha del bloque de tasas está en `x = 25.0`, a **2.0 pt** de la columna de fecha del cuerpo.
   * Misma tolerancia que el cuerpo (1.2), y por eso las dos columnas siguen siendo disjuntas: 2.0 > 1.2.
   */
  fecha: { x: 25.0, tolerancia: COLUMNAS.fecha.tolerancia },
} as const;

/** Los dos títulos que abren un bloque de anexo (§8, §9). */
const RE_ANEXO_IMPOSITIVO = /^Detalle impositivo$/i;
const RE_ANEXO_TASAS = /^Tasas de Acuerdos/i;

/**
 * `##,##%` / `##,## %` — la tasa **tal como se imprime**, nunca parseada a número.
 *
 * Dos formas porque el banco la publica de dos maneras distintas: como **fragmento propio** en el bloque de
 * tasas (el TNA en `r=407.0` y el CFTEA en `487.0`, §11.3) y **adentro del rótulo** en el `Detalle
 * impositivo` (`… por creditos alicuota ##,## %`, §9). La primera se detecta por fragmento completo; la
 * segunda, buscándola dentro del literal ya armado.
 */
const RE_ALICUOTA_EN_EL_LITERAL = /\d{1,3},\d{1,2}\s*%/;
const RE_ES_ALICUOTA = /^\d{1,3},\d{1,2}\s*%$/;

/**
 * El período del renglón, leído **del propio renglón** (§9).
 *
 * Las fechas del `Detalle impositivo` van `dd-mm-aaaa` (§6), distinto del `dd/mm/aa` del cuerpo; el separador
 * se deja abierto porque `parsearFecha` acepta los dos y exigir uno sería cablear una forma no medida.
 *
 * `RE_SOLO_HASTA` se prueba **después** de `RE_COMPLETO` y nunca antes: `del X al Y` también matchea `al Y`,
 * y un rango completo degradado a `publicado_solo_hasta` perdería la fecha de inicio en silencio.
 */
const RE_PERIODO_COMPLETO = /\bdel\s+(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\s+al\s+(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i;
const RE_PERIODO_SOLO_HASTA = /\bal\s+(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i;
/**
 * 🔴 El caso que `periodo_de_emision` existe para nombrar: `Total Retención Régimen de Recaudación SIRCREB
 * **en el período de emisión**` (§9). El banco **declara** cuál es el período sin imprimir las fechas. No es
 * `no_publicado` —ahí el banco no dice nada— y **ninguno de los dos autoriza a copiar el período del
 * extracto**: la resolución la hace el Módulo 2 explícitamente, nunca un default de acá.
 */
const RE_PERIODO_DE_EMISION = /EN EL PERIODO DE EMISION/;

/**
 * 🔴 **La misma cláusula, pero SOLA en una fila: es la cola de un rótulo que envolvió.**
 *
 * Regla explícita —no una banda geométrica ampliada— y **derivada de una que ya estaba escrita**: es
 * `RE_PERIODO_DE_EMISION` anclada a los dos extremos. Una fila cuyo literal es **exactamente** la cláusula no
 * es un renglón (no declara ningún impuesto) ni es ruido (declara un hecho fiscal): es la **segunda línea**
 * del rótulo de arriba, exactamente como la continuación de una glosa en el cuerpo (§7).
 *
 * Por qué importa y no es cosmético: si la cláusula queda en su propia fila, el rótulo de arriba se lee
 * **sin** ella y `periodoDelRenglon` lo resuelve como `no_publicado` — o sea, *"el banco no dijo nada"*
 * cuando el banco **sí dijo** cuál es el período. Es la única de las cuatro salidas de `PeriodoAnexo` que se
 * pierde en silencio y con todo cuadrando.
 *
 * Se pega **solo** al rótulo inmediatamente anterior del mismo bloque y de la misma página, y **una sola
 * vez**. Si no hay tal rótulo, la fila vuelve al residuo con el mismo código que hoy (`fila_sin_importe`):
 * una cláusula suelta sin dueño es un hallazgo, no un dato que se cuelga del renglón más cercano.
 */
const RE_COLA_PERIODO_DE_EMISION = /^EN EL PERIODO DE EMISION$/;

/**
 * El único renglón que se emite como `no_esta_en_los_movimientos`, y por eso el patrón es **el literal**.
 *
 * §9 y el esquema: es el importe computable como pago a cuenta, **no existe como movimiento y no es derivable
 * de ellos**. Es también el único candidato a registración de todo el bloque, así que un falso positivo acá
 * es un asiento de más — al revés que las otras dos salidas, que son fail-closed.
 */
const RE_ANEXO_COMPUTABLE = /IMPORTE SUSCEPTIBLE DE SER COMPUTADO/;

/**
 * Los renglones que **resumen** lo que ya está en el cuerpo (§9): el impuesto al cheque (21+19 movimientos) y
 * el SIRCREB (8). `25\.?413` porque el cuerpo lo escribe `25.413` y el anexo `25413`.
 */
const RE_ANEXO_RESUMEN = /(IMPUESTO\s+LEY\s+25\.?413|SIRCREB)/;

/**
 * 🔴 Puerta de admisión del literal del anexo: **ninguna corrida de 7 o más dígitos**.
 *
 * Es el mismo predicado que el `check` `anexo_literal_sin_identificador_chk` de la migración `0008`. Se
 * verifica **acá** porque un literal que lo viole no puede emitirse: la base lo rechazaría y el lote entero se
 * caería por una constraint traducida en vez de por un renglón reportado.
 *
 * Medido: los literales de este banco llegan a 5 dígitos seguidos (`25413`), las fechas van con separadores
 * (`dd-mm-aaaa` → 4) y las alícuotas con coma. No debería dispararse nunca — y si se dispara, el renglón va a
 * `lineasNoInterpretadas` con su forma, que es exactamente lo que hay que ver para arreglarlo.
 */
const RE_CORRIDA_DE_IDENTIFICADOR = /\d{7}/;

/**
 * El pie de página, anclado por `x` (§8).
 *
 * **Dos trampas en una.** Primera: el pie es `N - M`, **no** `Página N / M`, así que la regla `pie` de
 * `RUIDO_COMUN` no matchea nada acá. Segunda: `/^\d+ - \d+$/` suelto es peligrosamente genérico —cualquier
 * fila con dos números y un guion lo cumple—, así que la regla vive en el adaptador y **exige la posición**.
 * El `y ≈ 21.3` medido no se usa: depende del alto de página y no aporta nada sobre la `x`.
 */
const PIE = { x: 536.9, tolerancia: 2.0 } as const;
const RE_PIE = /^\d{1,3} - (\d{1,3})$/;

// -----------------------------------------------------------------------------
// Vocabulario impreso por el banco (spec §2, §8)
// -----------------------------------------------------------------------------

/**
 * `Nº` es **U+00BA** (indicador ordinal masculino), no U+00B0 (grado). Verificado por codepoint (§2.1).
 * Un regex escrito con `°` no engancha **nunca**, y el síntoma es una cuenta sin número, no un error.
 * Va con el **escape unicode** y no con el carácter literal justamente por eso: los dos se ven casi iguales
 * en un editor, y así el patrón no depende de que nadie los confunda ni de con qué codificación se guardó
 * este archivo.
 */
const RE_CABECERA_CUENTA = /^Cuenta Corriente.*N\u00BA/;

/**
 * El número de cuenta, con su forma medida `###-######/#` (§2).
 *
 * Es **más estricto a propósito** que `RE_CABECERA_CUENTA`, y la asimetría es deliberada: la regla de ruido
 * tiene que seguir reconociendo la cabecera aunque el banco cambie el formato del número (si no, las
 * cabeceras que caen dentro de la tabla se van a `lineasNoInterpretadas` y el lote se va a `no_cuadra` —§8
 * midió 8 filas sin interpretar: 7 cabeceras y 1 nota al pie—), mientras que el dato tiene que fallar y
 * dejar la cuenta **sin número** —que se detecta al resolver— antes que capturar otra cosa.
 */
const RE_NUMERO_CUENTA = /N\u00BA\s*(\d{3}-\d{6}\/\d)/;

/** La variante de la cuenta en moneda extranjera. Es lo que distingue las dos cuentas (§11.6). */
const RE_ES_DOLARES = /especial\s+U\$S/i;

/** Encabezado de la tabla, literal (§3). Abre la región y se repite una vez por página (9 veces, §8). */
const RE_ENCABEZADO = /^Fecha Comprobante Movimiento D[ée]bito Cr[ée]dito Saldo en cuenta$/;

/**
 * La fila de cierre de cada cuenta (§9): `Saldo total`, una vez por cuenta.
 *
 * El lookahead **no es decorativo**: la carátula de las páginas 1 y 2 imprime `Saldo total en cuentas`
 * (§2.1, trampa 2), que es un renglón ilegible por fila y de otra cosa. Sin el lookahead, ese renglón
 * cerraría la región de la primera cuenta en la página 2 y el cuerpo quedaría partido.
 */
const RE_CIERRE = /^Saldo total(?!\s+en\s+cuentas)/;

/** Título de sección. Es el control cruzado de la moneda de cada región (§11.6). */
const RE_TITULO_SECCION = /^Movimientos en (?:pesos|d[óo]lares)$/i;
const RE_TITULO_DOLARES = /^Movimientos en d[óo]lares$/i;

/** La etiqueta de la fila de saldo inicial, en la columna de glosa (§11.5). */
const RE_SALDO_INICIAL = /^Saldo Inicial$/i;

/** `dd/mm/aa`, una sola forma en las 158 filas y en la carátula (§6). */
const RE_FECHA_CUERPO = /^\d{2}\/\d{2}\/\d{2}$/;

/**
 * El período sale de **dos etiquetas en filas geométricas distintas**, a 14 pt una de otra (§11.10).
 * `extraerPeriodo` exige las dos fechas en la misma cadena y devuelve `null` acá; por eso
 * `periodoPorEtiquetas`.
 */
const RE_DESDE = /^Desde:\s*(\d{2}\/\d{2}\/\d{2})$/;
const RE_HASTA = /^Hasta:\s*(\d{2}\/\d{2}\/\d{2})$/;

/**
 * CUIT y CBU del titular, por etiqueta (§2). Nunca por patrón: la glosa trae identificadores de terceros.
 *
 * 🔴 **Antes eran patrones locales sin `\b` en ningún lado** (`/\d{2}-\d{8}-\d/`, `/\d{22}/`): una corrida
 * más larga que la publicada matcheaba igual sus primeros dígitos y el archivo quedaba leído con un
 * identificador plausible pero equivocado — exactamente el bug que `alta-cuenta.ts` y `galicia.ts` ya
 * habían cerrado para el mismo dato, sin propagarlo acá. Ahora importan del catálogo centralizado
 * (`packages/shared/src/seguridad/detectores-forma.ts`), que ancla con `\b` a los dos lados.
 */
const RE_CUIT = RE_CUIT_COMPARTIDO;
const RE_CBU = RE_CBU_COMPARTIDO;

/**
 * Cuántas filas del principio son carátula, para acotar dónde se buscan las etiquetas `CBU:`/`CUIT:`.
 *
 * 🔴 Antes se buscaban sobre `textos.map(textoDeFila)` **del documento entero**, sin ventana. Galicia ya
 * documentaba el riesgo para el mismo dato: la glosa de una transferencia puede traer la palabra `CBU`
 * seguida del CBU **de la contraparte**, y sin ventana ese renglón se leería como el identificador del
 * titular. Acá las etiquetas son igual de cortas (`CBU:`, `CUIT:`), así que el mismo riesgo aplica.
 *
 * Mismo valor que ya usa `reconoceSantander` (200 filas, cubre la carátula entera y el primer encabezado
 * con margen, sobre las 414 del archivo medido en §1) — no es una ventana nueva, es la misma ya medida.
 */
const FILAS_DE_CARATULA = 200;

/**
 * Lo que dentro de la tabla **no** es un movimiento (§8). Se descarta explícitamente, con su motivo.
 *
 * Las 8 cabeceras de cuenta caen **DENTRO** de la región de tabla: sin su regla propia se van a
 * `lineasNoInterpretadas` y el estado se va a `no_cuadra` por `EST_LINEA_NO_INTERPRETADA`. Medido: 8 filas
 * sin interpretar (7 cabeceras + 1 nota al pie) si falta esta lista.
 */
const RUIDO_SANTANDER: readonly { readonly patron: RegExp; readonly motivo: string }[] = [
  { patron: RE_ENCABEZADO, motivo: 'Encabezado de columnas: se repite una vez por página (§8).' },
  { patron: RE_CABECERA_CUENTA, motivo: 'Cabecera de cuenta: cae dentro de la región de tabla (§8).' },
  { patron: RE_TITULO_SECCION, motivo: 'Título de sección de moneda (§8).' },
  {
    patron: RE_ANEXO_IMPOSITIVO,
    motivo: 'Título del anexo impositivo: ABRE el bloque, no es un renglón del bloque (§9).',
  },
  { patron: /^Tipo de impuesto\b/i, motivo: 'Encabezado de columnas del anexo impositivo (§9).' },
  {
    patron: RE_ANEXO_TASAS,
    motivo: 'Título del anexo de tasas: ABRE el bloque, no es un renglón del bloque (§9).',
  },
  {
    patron: /^No ten[eé]s movimientos en .*este per[íi]odo\.?$/i,
    motivo: 'Leyenda de cuenta sin movimientos: es legítima, no un fallo de lectura (§11.7).',
  },
  { patron: /^\* Salvo error u omisi[óo]n/i, motivo: 'Nota al pie legal (§8).' },
  {
    patron: /^Saldo total en cuentas/i,
    motivo: 'Renglón de la carátula, ilegible por fila y con las dos monedas mezcladas (§2.1).',
  },
];

// -----------------------------------------------------------------------------

export function reconoceSantander(filas: readonly FilaGeometrica[]): boolean {
  // La tabla arranca en la página 2, así que mirar solo la carátula no alcanza. 200 filas cubren la
  // carátula entera y el primer encabezado con margen, sobre las 414 del archivo medido (§1).
  const textos = filas.slice(0, 200).map(textoDeFila);
  if (textos.some((t) => RE_ENCABEZADO.test(t))) return true;
  // Sin el encabezado, hacen falta las dos marcas: `Movimientos en pesos` solo es poco distintivo, y una
  // detección de más deja el archivo en `ambiguo`, que es un rechazo.
  return (
    textos.some((t) => RE_TITULO_SECCION.test(t)) && textos.some((t) => RE_CABECERA_CUENTA.test(t))
  );
}

/**
 * Un movimiento en construcción.
 *
 * El bloque se abre con la fila que trae fecha en la columna de fecha y se cierra con la **próxima** fila
 * con fecha (o con el fin de la región), absorbiendo mientras tanto las filas de abajo. §7 midió que la
 * glosa tiene **como máximo 2 líneas** —60 movimientos de una, 98 con una continuación— y **0 movimientos
 * partidos entre páginas**, pero el autómata no cablea ese máximo: si un período trajera una continuación
 * más, entra sola.
 */
type BloqueAbierto = {
  readonly fecha: string;
  readonly lineas: string[];
  comprobante: string | null;
  readonly paginaPdf: number;
  readonly indiceFila: number;
  par: ParDeFila | null;
};

/** Lo que se sabe de una región de tabla antes de recorrer su cuerpo. Una región = una cuenta (§11.6). */
type MetadatoDeCuenta = {
  readonly moneda: Moneda;
  readonly numero: string | null;
  readonly denominacion: string;
  readonly saldoFinalDeclarado: string | null;
};

/**
 * Los siete destinos posibles de una fila del documento. **Unión cerrada y exhaustiva.**
 *
 * Existe porque `"cae fuera de la región de tabla"` no es un destino: es una ubicación, y mientras se usó
 * como si fuera un destino los 7 renglones fiscales de los dos anexos (§9) desaparecían sin dejar rastro.
 *
 * - `movimiento` — la fila que abre un movimiento emitido.
 * - `continuacion` — una fila que aportó glosa, comprobante o par a un movimiento abierto (§7), o texto a un
 *   rótulo de anexo que envolvió (`RE_COLA_PERIODO_DE_EMISION`). En los dos casos la fila **no tiene registro
 *   propio**: su contenido está adentro del registro de otra fila. Igual que en el cuerpo, la marca no se
 *   revisa si ese registro después falla — la que se revisa a `residuo` es la fila que lo abrió.
 * - `saldoDeclarado` — `Saldo Inicial` (§11.5) y `Saldo total` (§9): **datos de la verificación**, no ruido.
 * - `ruido` — una regla de `RUIDO_SANTANDER`, el pie anclado (§8) o la fila vacía. Siempre **con su regla**.
 * - `anexo` — un renglón emitido de alguno de los dos bloques de la p9 (§9).
 * - `fueraDelCuerpo` — fuera de toda región **y** de todo bloque de anexo, y ninguna regla la explica: la
 *   carátula y las leyendas legales de p1/p10/p11, 129 de las 414 filas del archivo medido (§1). Es el
 *   residuo de la partición *de afuera del cuerpo*: se **cuenta** y no pone el lote en rojo, al revés de
 *   `residuo`.
 * - `residuo` — va a `lineasNoInterpretadas`, con su **forma**. Empuja el lote a `no_cuadra`.
 */
export const DESTINOS_SANTANDER = [
  'movimiento',
  'continuacion',
  'saldoDeclarado',
  'ruido',
  'anexo',
  'fueraDelCuerpo',
  'residuo',
] as const;
export type DestinoSantander = (typeof DESTINOS_SANTANDER)[number];

export type ConteoDeDestinos = Readonly<Record<DestinoSantander, number>> & {
  /**
   * Filas que **ninguna** rama del lector marcó. Tiene que dar **0**: es el control de la partición, y es lo
   * que hace que "toda fila tiene un destino declarado" sea un hecho medido y no una afirmación del autor.
   * Mismo razonamiento que `residuoDeParticion` en el toolkit.
   */
  readonly sinDestino: number;
  readonly total: number;
};

/**
 * El lector, con el recuento de la partición al lado.
 *
 * `SalidaDeAdaptador` es el contrato **compartido** de los tres bancos y no se toca por uno; el recuento sale
 * por acá, que es una función propia de este adaptador. `leerSantander` delega en ésta y tira el recuento, así
 * que **hay una sola pasada y no hay dos clasificaciones que puedan divergir** — que es exactamente el defecto
 * que un segundo recorrido "de auditoría" habría introducido.
 */
export function leerSantander(filas: readonly FilaGeometrica[]): SalidaDeAdaptador {
  return leerSantanderConDestinos(filas).salida;
}

export function leerSantanderConDestinos(filas: readonly FilaGeometrica[]): {
  readonly salida: SalidaDeAdaptador;
  readonly destinos: ConteoDeDestinos;
} {
  const textos = filas.map(textoDeFila);
  const noInterpretadas: LineaNoInterpretada[] = [];

  /** Índice de fila → destino. Se pisa cuando una decisión posterior lo revisa (ver `cerrar`). */
  const destinoDeFila = new Map<number, DestinoSantander>();
  const marcar = (i: number, destino: DestinoSantander): void => {
    destinoDeFila.set(i, destino);
  };
  const marcarSiFalta = (i: number, destino: DestinoSantander): void => {
    if (!destinoDeFila.has(i)) destinoDeFila.set(i, destino);
  };

  const periodo = periodoPorEtiquetas(textos, RE_DESDE, RE_HASTA);
  if (periodo === null) {
    /**
     * Sin período no hay `EST_FECHA_FUERA_DE_PERIODO`, ni `periodo_desde`/`hasta` en el lote. Se falla con
     * código en vez de emitir cuentas sin período: las dos etiquetas están medidas en la carátula (§2), y
     * que no aparezcan significa que el layout cambió, no que este archivo no tenga período. Un adaptador
     * que siguiera adelante apagaría V7 **en silencio**, que es exactamente lo que el módulo evita.
     */
    throw new ErrorDeAdaptador('periodo_no_reconocido');
  }

  const regiones = regionesDeTabla(textos, RE_ENCABEZADO, RE_CIERRE);
  if (regiones.length === 0) throw new ErrorDeAdaptador('layout_inesperado');

  /**
   * Las dos filas que delimitan cada región quedan **fuera** del cuerpo y por eso el recorrido no las mira.
   * Se marcan acá para que no caigan en `fueraDelCuerpo`: el encabezado es ruido y el `Saldo total` es un
   * **dato de la verificación** (§8: *"no son ruido: son datos"*), no una fila que sobró.
   */
  for (const region of regiones) {
    marcar(region.indiceEncabezado, 'ruido');
    if (region.indiceCierre !== null) marcar(region.indiceCierre, 'saldoDeclarado');
  }

  const metadatos = regiones.map((region, k) =>
    metadatoDeRegion(filas, textos, regiones, k, region, noInterpretadas, marcar),
  );

  /**
   * Índice de fila → índice de región. `dentroDeAlgunaRegion` contesta *si* una fila es cuerpo; esto
   * contesta **de qué cuenta**, que es la pregunta que el resto de la aritmética no puede responder sola:
   * toda ecuación por cuenta cierra igual si el adaptador mezcló dos cuentas.
   */
  const regionDeFila = new Map<number, number>();
  regiones.forEach((r, k) => {
    const hasta = r.indiceCierre ?? filas.length;
    for (let i = r.indiceEncabezado + 1; i < hasta; i += 1) regionDeFila.set(i, k);
  });

  /**
   * Los anexos, **antes** del recorrido del cuerpo, porque su lectura decide el destino de filas que el
   * recorrido va a ver como "fuera de región" y necesita saber si ya están explicadas.
   *
   * `atribucionCuenta` sale de acá y no de la posición del bloque: los dos bloques están después del
   * `Saldo total` de las **dos** cuentas (§9), así que no hay ninguna evidencia posicional de a cuál
   * pertenecen. Con una sola cuenta en el lote la atribución es cierta **por aritmética** —y va separada
   * justamente para que el día que este banco mande un archivo de dos cuentas la deducción deje de valer.
   */
  const atribucionCuenta: AtribucionAnexo =
    regiones.length === 1 ? 'cuenta_unica_del_lote' : 'no_determinada';
  const anexos = leerAnexos(filas, textos, regiones, atribucionCuenta, noInterpretadas, marcar);

  const acumuladores = regiones.map(() => ({
    movimientos: [] as MovimientoBancarioCrudo[],
    saldoInicialDeclarado: null as string | null,
  }));

  let abierto: BloqueAbierto | null = null;
  let regionActual = -1;

  /** Cierra el bloque abierto. Un bloque sin par `(importe, saldo)` es incompleto y se reporta. */
  const cerrar = (): void => {
    const bloque = abierto;
    abierto = null;
    if (!bloque) return;

    const acumulador = acumuladores[regionActual];
    const meta = metadatos[regionActual];
    if (!acumulador || !meta) return;

    if (!bloque.par) {
      // La fila se había marcado `movimiento` al abrirse; el bloque no se pudo completar, así que su destino
      // se **revisa**. Es el único lugar donde una marca se pisa, y es por eso que existe `marcar`.
      marcar(bloque.indiceFila, 'residuo');
      noInterpretadas.push({
        codigo: 'fila_sin_importe',
        forma: formaParaLog(bloque.lineas.join(' '), 60),
        paginaPdf: bloque.paginaPdf,
        indice: bloque.indiceFila,
      });
      return;
    }
    if (bloque.lineas.length === 0) {
      /**
       * Fecha e importe sin **nada** en la columna de glosa. §7 midió que las 158 filas traen su glosa en
       * `x = 115.0` sin excepción, así que esto es una anomalía de layout — y emitirlo produciría un
       * movimiento con `descripcion` vacía, que el esquema rechaza. Se reporta con la forma de la fecha,
       * que no lleva ningún valor.
       */
      marcar(bloque.indiceFila, 'residuo');
      noInterpretadas.push({
        codigo: 'desconocido',
        forma: formaParaLog(bloque.fecha, 60),
        paginaPdf: bloque.paginaPdf,
        indice: bloque.indiceFila,
      });
      return;
    }
    acumulador.movimientos.push(
      armarMovimiento(bloque, bloque.par, acumulador.movimientos.length + 1, meta.moneda),
    );
  };

  for (const [i, fila] of filas.entries()) {
    const texto = textos[i] ?? '';

    /**
     * Fuera de toda región no hay **cuerpo** que interpretar, pero sí hay destino: o la fila ya la reclamó un
     * bloque de anexo (§9), o una regla de ruido la explica, o es carátula/leyenda legal —129 de las 414
     * filas del archivo medido (§1)—. Lo que **no** puede pasar es que se vaya sin quedar contada: así se
     * perdían los 7 renglones fiscales.
     */
    if (!dentroDeAlgunaRegion(regiones, i)) {
      cerrar();
      marcarSiFalta(i, esRuido(fila, texto) ? 'ruido' : 'fueraDelCuerpo');
      continue;
    }
    const k = regionDeFila.get(i);
    if (k === undefined) {
      // Defensivo: `dentroDeAlgunaRegion` y `regionDeFila` cubren el mismo conjunto por construcción.
      cerrar();
      marcarSiFalta(i, 'fueraDelCuerpo');
      continue;
    }
    // Cambio de cuenta: el bloque abierto pertenece a la anterior y se cierra ANTES de mover el puntero.
    if (k !== regionActual) {
      cerrar();
      regionActual = k;
    }

    if (texto === '') {
      marcar(i, 'ruido');
      continue;
    }

    if (esPieDePagina(fila, texto)) {
      marcar(i, 'ruido');
      continue;
    }
    /**
     * El ruido estructural **no cierra el bloque**. El encabezado y la cabecera de la página siguiente
     * aparecen en medio de un movimiento cuando su glosa cruza el corte de hoja, y cerrar ahí dejaría la
     * continuación huérfana. En este archivo no pasa —0 movimientos partidos entre páginas (§7)— pero el
     * criterio correcto no depende de eso.
     */
    if (RUIDO_SANTANDER.some((r) => r.patron.test(texto))) {
      marcar(i, 'ruido');
      continue;
    }

    const fechaFrag = fragmentoEnX(fila, COLUMNAS.fecha.x, COLUMNAS.fecha.tolerancia);
    const abre = fechaFrag !== undefined && RE_FECHA_CUERPO.test(fechaFrag.texto);

    if (abre && fechaFrag) {
      // Una fila con fecha cierra el movimiento anterior. Es el único criterio de cierre del cuerpo.
      cerrar();

      const glosa = fragmentosEnBanda(fila, GLOSA.desde, GLOSA.hasta);

      /**
       * `Saldo Inicial`: fecha + glosa rotulada + saldo y **ningún** fragmento en las columnas de importe
       * (§11.5). Un autómata que exija el par la reporta como `fila_sin_importe`; uno que la acepte inventa
       * un movimiento de importe cero. No es ninguna de las dos: es el saldo inicial declarado.
       */
      if (RE_SALDO_INICIAL.test(glosa)) {
        const saldo = leerSaldoInicial(fila);
        const acumulador = acumuladores[regionActual];
        if (saldo === null || !acumulador || acumulador.saldoInicialDeclarado !== null) {
          // O la fila tiene la etiqueta y no la forma, o hay dos saldos iniciales en la misma cuenta. En
          // los dos casos es un hallazgo, no un dato: se reporta y no se pisa lo ya leído.
          marcar(i, 'residuo');
          noInterpretadas.push({
            codigo: 'desconocido',
            forma: formaParaLog(texto, 60),
            paginaPdf: fila.pagina,
            indice: i,
          });
        } else {
          marcar(i, 'saldoDeclarado');
          acumulador.saldoInicialDeclarado = saldo;
        }
        continue;
      }

      const fecha = parsearFecha(fechaFrag.texto, periodo);
      if (fecha === null) {
        marcar(i, 'residuo');
        noInterpretadas.push({
          codigo: 'fecha_ilegible',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice: i,
        });
        continue;
      }

      // Provisional: si el bloque no llega a completar su par, `cerrar` la revisa a `residuo`.
      marcar(i, 'movimiento');
      abierto = {
        fecha,
        lineas: [],
        comprobante: null,
        paginaPdf: fila.pagina,
        indiceFila: i,
        par: null,
      };
      absorber(abierto, fila);
      continue;
    }

    if (abierto) {
      // Una fila del cuerpo que no aporta **nada** no es una continuación: es algo que no se entendió, y
      // absorberla en silencio es cómo una glosa termina con el encabezado de la página adentro.
      if (absorber(abierto, fila)) {
        marcar(i, 'continuacion');
      } else {
        marcar(i, 'residuo');
        noInterpretadas.push({
          codigo: 'desconocido',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice: i,
        });
      }
      continue;
    }

    marcar(i, 'residuo');
    noInterpretadas.push({
      codigo: 'linea_fuera_de_zona',
      forma: formaParaLog(texto, 60),
      paginaPdf: fila.pagina,
      indice: i,
    });
  }

  cerrar();

  /**
   * En orden de documento. El recorrido del cuerpo y la pasada de anexos escriben en la misma lista desde dos
   * momentos distintos, y un residuo del anexo apareciendo antes que uno de la p3 haría ilegible el reporte.
   * El orden es el del documento porque es el único con el que un humano puede ir a mirar la hoja.
   */
  noInterpretadas.sort((a, b) => a.indice - b.indice);

  /**
   * El CBU se lee de la carátula por etiqueta (§2) y **solo se asigna cuando el archivo trae una sola
   * cuenta**.
   *
   * Con dos cuentas hay una sola etiqueta `CBU:` medida y nada la ata a una de las dos. Y el CBU es la
   * clave con la que `resolverCuentaDelExtracto` decide a qué cuenta bancaria van los movimientos: pegarle
   * el CBU de la cuenta en pesos a la cuenta en dólares haría que las dos resolvieran a la misma, con todo
   * cuadrando. **A qué cuenta pertenece el CBU de la carátula queda no determinado** (§15) y por eso no se
   * publica; el número de cuenta, que sí sale de la cabecera de cada región, alcanza para resolver.
   *
   * 🔴 La búsqueda se acota a `FILAS_DE_CARATULA`, no al documento entero: ver el comentario de esa
   * constante.
   */
  const textosCaratula = textos.slice(0, FILAS_DE_CARATULA);
  const cbu =
    regiones.length === 1 ? (valorPorEtiqueta(textosCaratula, ['CBU:'], RE_CBU)?.valor ?? null) : null;
  const cuitTitular = valorPorEtiqueta(textosCaratula, ['CUIT:'], RE_CUIT)?.valor ?? null;

  /**
   * **Los anexos cuelgan de la PRIMERA cuenta, y eso no es una atribución.**
   *
   * `anexos` vive adentro de `CuentaConMovimientos`, así que hay que elegir un contenedor sí o sí; quien dice
   * de qué cuenta es el renglón es `atribucionCuenta`, y con `no_determinada` `persistirCuenta` graba
   * `cuenta_bancaria_id` en **null** (hay un `check` de coherencia en la base que lo exige). Van todos a la
   * primera y **a ninguna otra**: repetirlos por cuenta los duplicaría y reventaría `uq_anexo_orden`, que es
   * `(cliente_id, lote_ingesta_id, orden_en_lote)`.
   */
  const cuentas = regiones.map((_, k) =>
    armarCuenta(
      metadatos[k],
      acumuladores[k],
      periodo,
      cbu,
      cuitTitular,
      k === 0 ? anexos : [],
    ),
  );

  return {
    salida: {
      cuentas: cuentas.filter((c): c is CuentaConMovimientos => c !== null),
      lineasNoInterpretadas: noInterpretadas,
      paginasDeclaradas: leerPaginasDeclaradas(filas),
      // `traeConsolidadoPorMoneda: false`: el renglón existe y es ilegible por fila (§2.1). Se omite el
      // campo, y la ausencia se lee como "no hay qué comparar", nunca como "cuadra".
    },
    destinos: contarDestinos(destinoDeFila, filas.length),
  };
}

/** El recuento por destino, más las dos cifras de control. Ver `ConteoDeDestinos`. */
function contarDestinos(
  destinoDeFila: ReadonlyMap<number, DestinoSantander>,
  total: number,
): ConteoDeDestinos {
  const conteo: Record<DestinoSantander, number> = {
    movimiento: 0,
    continuacion: 0,
    saldoDeclarado: 0,
    ruido: 0,
    anexo: 0,
    fueraDelCuerpo: 0,
    residuo: 0,
  };
  for (const destino of destinoDeFila.values()) conteo[destino] += 1;
  return { ...conteo, sinDestino: total - destinoDeFila.size, total };
}

/** Las dos clases de fila que una regla escrita explica: el pie anclado (§8) y `RUIDO_SANTANDER`. */
function esRuido(fila: FilaGeometrica, texto: string): boolean {
  if (texto === '') return true;
  if (esPieDePagina(fila, texto)) return true;
  return RUIDO_SANTANDER.some((r) => r.patron.test(texto));
}

// -----------------------------------------------------------------------------
// Anexos (spec §9) — los dos bloques de la p9, después del último `Saldo total`
// -----------------------------------------------------------------------------

/** Las dos clases de bloque. Cambian **de dónde sale el importe** y la relación con el cuerpo. */
type ClaseDeAnexo = 'impositivo' | 'tasas';

type BloqueDeAnexo = {
  readonly clase: ClaseDeAnexo;
  /** Primer índice del cuerpo del bloque: el título queda **afuera** (es ruido, igual que un encabezado). */
  readonly desde: number;
  /** Exclusivo. */
  readonly hasta: number;
};

/**
 * Dónde empieza y dónde termina cada bloque de anexo.
 *
 * ## Las tres decisiones del autómata, y qué modo de falla cierra cada una
 *
 * 1. **Un título dentro de una región de tabla NO abre un bloque.** El cuerpo manda: si un movimiento tuviera
 *    la glosa `Detalle impositivo`, abrir un anexo ahí partiría la tabla y se llevaría puestos los
 *    movimientos que siguen.
 * 2. **El bloque termina al cambiar de página.** Los dos están en la p9 (§9), y sin este corte el segundo
 *    —que es el último del documento— se comería las **dos páginas de leyendas legales** (p10 y p11) y las
 *    reportaría como renglones ilegibles. El costo está declarado: si un período partiera un bloque entre
 *    hojas, la cola quedaría en `fueraDelCuerpo` — contada, pero sin leer. §15 ya declara no determinado el
 *    comportamiento del bloque entre períodos.
 * 3. **El bloque termina al entrar en una región de tabla**, por si un archivo trajera una cuenta más después
 *    de los anexos.
 */
function bloquesDeAnexo(
  filas: readonly FilaGeometrica[],
  textos: readonly string[],
  regiones: readonly RegionDeTabla[],
): readonly BloqueDeAnexo[] {
  const bloques: BloqueDeAnexo[] = [];
  let abierto: { clase: ClaseDeAnexo; desde: number; pagina: number } | null = null;

  const cerrar = (hasta: number): void => {
    if (abierto && hasta > abierto.desde) {
      bloques.push({ clase: abierto.clase, desde: abierto.desde, hasta });
    }
    abierto = null;
  };

  for (const [i, fila] of filas.entries()) {
    const texto = textos[i] ?? '';
    const enTabla = dentroDeAlgunaRegion(regiones, i);

    const clase: ClaseDeAnexo | null = enTabla
      ? null
      : RE_ANEXO_IMPOSITIVO.test(texto)
        ? 'impositivo'
        : RE_ANEXO_TASAS.test(texto)
          ? 'tasas'
          : null;

    if (clase !== null) {
      cerrar(i);
      abierto = { clase, desde: i + 1, pagina: fila.pagina };
      continue;
    }
    if (abierto && (enTabla || fila.pagina !== abierto.pagina)) cerrar(i);
  }
  cerrar(filas.length);

  return bloques;
}

/** El importe de un renglón: los centavos ya validados y el token, que es de donde sale la moneda (§11.8). */
type ImporteDeAnexo = { readonly centavos: bigint; readonly texto: string };

/**
 * Lo que se puede leer de una fila **sola**, sin mirar a las de al lado.
 *
 * 🔴 `importe: null` **no es un error**: es una fila que no trae importe, y el importe puede estar más abajo
 * (ver `leerAnexos`). Quién decide si eso es un renglón partido o un residuo es el lector del bloque, que sí
 * ve a las vecinas. Ésta es la razón por la que la lectura se partió en dos: antes "no encontré el importe en
 * esta fila" y "este renglón no tiene importe" eran **la misma** respuesta, y con eso el rótulo que envuelve
 * no se podía distinguir del renglón que de verdad no publica importe.
 */
type PiezasDeRenglon = {
  readonly conceptoLiteral: string;
  readonly alicuotaPublicada: string | undefined;
  readonly importe: ImporteDeAnexo | null;
};

type LecturaDePiezas =
  | { readonly ok: true; readonly piezas: PiezasDeRenglon }
  | { readonly ok: false; readonly codigo: LineaNoInterpretada['codigo'] };

/**
 * Cómo se leyó una fila del bloque **antes** de mirar a sus vecinas. Unión cerrada: toda fila del bloque cae
 * en una de las cinco, que es la misma disciplina de `DestinoSantander` un nivel más abajo.
 *
 * - `ruido` — una regla escrita la explica (`RUIDO_SANTANDER` o el pie).
 * - `residuo` — no se entendió, con el código con el que se reporta.
 * - `rotulo` — trae literal. **Con o sin importe propio**: el sin importe es el candidato a aparearse.
 * - `importeSuelto` — trae importe y **nada más**. Es el otro lado del apareo.
 * - `colaDePeriodo` — `RE_COLA_PERIODO_DE_EMISION`: texto que pertenece al rótulo de arriba.
 */
type FilaDeAnexo =
  | { readonly tipo: 'ruido'; readonly indice: number }
  | {
      readonly tipo: 'residuo';
      readonly indice: number;
      readonly fila: FilaGeometrica;
      readonly codigo: LineaNoInterpretada['codigo'];
    }
  | {
      readonly tipo: 'rotulo';
      readonly indice: number;
      readonly fila: FilaGeometrica;
      readonly clase: ClaseDeAnexo;
      readonly piezas: PiezasDeRenglon;
    }
  | {
      readonly tipo: 'importeSuelto';
      readonly indice: number;
      readonly fila: FilaGeometrica;
      readonly importe: ImporteDeAnexo;
    }
  | {
      readonly tipo: 'colaDePeriodo';
      readonly indice: number;
      readonly fila: FilaGeometrica;
      readonly literal: string;
    };

/**
 * Lee los dos bloques y devuelve sus renglones, en orden de documento.
 *
 * 🔴 **Un renglón que no se pudo interpretar va a `lineasNoInterpretadas` con su forma.** Es la mitad del
 * arreglo: capturar 5 de 7 y tirar 2 en silencio deja el mismo agujero que tirar los 7, solo que más chico.
 * Lo único que se descarta sin reportar es lo que una **regla escrita** explica —el encabezado
 * `Tipo de impuesto | Importe` y el pie de la hoja—, y ésas ya están en `RUIDO_SANTANDER`.
 *
 * ## El renglón que NO entra en una fila, y por qué el lector mira el bloque y no la fila
 *
 * Un rótulo largo puede no entrar al lado de su importe. Está **medido en el tercer banco del roster**
 * (`07-formato-macro.md` §9, trampa 3): la etiqueta en una fila y su importe en la fila `(S.E.U.O.) <IMP>` de
 * más abajo, una de ellas cruzando el corte de página. Acá se contemplan las **dos** formas de envolver, que
 * dejan residuos distintos y se arreglan distinto:
 *
 * | Forma | Qué se ve | Cómo se resuelve |
 * |---|---|---|
 * | El **importe** queda en la fila de abajo | el rótulo sin importe **y** una fila con importe y sin texto | apareo `rotulo` ↔ `importeSuelto` |
 * | El **texto** queda en la fila de abajo | el rótulo con su importe **y** una fila de texto suelto | `colaDePeriodo` (`RE_COLA_PERIODO_DE_EMISION`) |
 *
 * ### El apareo es EN ORDEN DE LECTURA, no por cercanía
 *
 * Los `importeSuelto` se consumen con un cursor que **solo avanza**, y cada rótulo toma el primero **posterior
 * a él** que quede sin consumir. Aparear por cercanía es la trampa: con dos rótulos que envuelven seguidos, el
 * segundo rótulo se queda con el importe del primero, el primero con el del segundo — y **el lote cuadra
 * igual**, porque los dos importes se emitieron y ningún control los cruza contra su rótulo. Es la misma
 * clase de error que un crédito cargado como débito por el mismo importe.
 *
 * ### Un rótulo sin importe NO se emite en cero
 *
 * Si no queda ningún `importeSuelto` posterior, el rótulo vuelve al residuo con su **forma** y el mismo código
 * de siempre (`fila_sin_importe`). Un anexo con `importeDeclarado` en cero sería un hecho fiscal inventado que
 * además pasa el esquema.
 *
 * ### El conteo, que es lo que hace verificable todo lo anterior
 *
 * Cada mecanismo mueve las dos cifras de una manera distinta, y por eso la próxima corrida contra el archivo
 * real **distingue cuál se disparó** en vez de dar un número que confirma cualquier hipótesis:
 *
 * | Mecanismo | `anexos` | residuo | Otra señal |
 * |---|---|---|---|
 * | Apareo `rotulo` ↔ `importeSuelto` | **+1** por par | **−2** por par | el `importeSuelto` deja de reportarse con `desconocido` |
 * | El importe estaba en la fila y lo tapaba otro fragmento (`importeDelDetalleImpositivo`) | **+1** por fila | **−1** por fila | ningún residuo con `desconocido` desaparece |
 * | Cola `en el período de emisión` | **0** | **−1** | un renglón pasa de `no_publicado` a `periodo_de_emision` |
 *
 * ## 🔴 LA PREDICCIÓN, escrita antes de correrla y falsable
 *
 * Estado medido del archivo real **antes** de este cambio: `anexos = 7` y **6** líneas en el residuo, las
 * **seis** con código `fila_sin_importe`. Dos de esas seis tienen forma de rótulo (rótulo largo + un número de
 * 5 dígitos + dos fechas `dd-mm-aaaa`), que es la forma del `Totales de retencion impuesto ley 25413 del … al
 * …` que §9 transcribe.
 *
 * **Si esas dos filas son rótulos de anexo, la próxima corrida da `anexos = 9` y residuo = 4.** Si no lo son,
 * las dos cifras **no se mueven** — y entonces el que necesita una línea es §9 de la spec, no este archivo.
 *
 * Y hay una consecuencia más fina, que es la que dice **por cuál de los dos mecanismos** pasó, porque los seis
 * códigos medidos ya restringen el resultado: **ningún residuo trae hoy el código `desconocido`**, y una fila
 * con importe y sin texto se reporta exactamente con ése. O sea que en este archivo **no hay ningún
 * `importeSuelto`**, y el apareo —el mecanismo que este cambio agrega— **no puede dispararse acá**. Entonces:
 *
 * - `anexos = 9` / residuo = 4 ⟹ el importe **estaba en la fila del rótulo** y lo tapaba un fragmento que no
 *   parsea: fue `importeDelDetalleImpositivo`, no el apareo. La hipótesis del rótulo se confirma y la del
 *   "importe en una fila posterior" queda **descartada para este archivo**.
 * - `anexos = 7` / residuo = 6 o 5 ⟹ esas dos filas no llevan importe en ninguna parte visible, y ahí sí hay
 *   que volver a §9. (5 y no 6 si además se disparó la cola: ver la fila `en el período de emisión` de la
 *   tabla de arriba, que baja el residuo sin tocar `anexos`.)
 * - Cualquier otra combinación ⟹ el bloque tiene una forma que ninguna de las tres reglas describe, y eso se
 *   mira antes de tocar nada más.
 *
 * El apareo se implementa igual, aunque este archivo no lo ejercite: está medido en otro banco del roster, y
 * la alternativa —descubrirlo el día que Santander cambie el ancho de una columna— es descubrirlo por un
 * renglón fiscal perdido en silencio.
 */
function leerAnexos(
  filas: readonly FilaGeometrica[],
  textos: readonly string[],
  regiones: readonly RegionDeTabla[],
  atribucionCuenta: AtribucionAnexo,
  noInterpretadas: LineaNoInterpretada[],
  marcar: (i: number, destino: DestinoSantander) => void,
): readonly AnexoExtracto[] {
  const anexos: AnexoExtracto[] = [];

  const alResiduo = (
    indice: number,
    fila: FilaGeometrica,
    codigo: LineaNoInterpretada['codigo'],
  ): void => {
    marcar(indice, 'residuo');
    noInterpretadas.push({
      codigo,
      forma: formaParaLog(textos[indice] ?? '', 60),
      paginaPdf: fila.pagina,
      indice,
    });
  };

  for (const bloque of bloquesDeAnexo(filas, textos, regiones)) {
    const clasificadas = clasificarBloque(filas, textos, bloque);

    /**
     * Las colas, **antes** del apareo: el literal del rótulo tiene que estar completo para que
     * `periodoDelRenglon` vea la cláusula, y una cola no cambia de dueño según de dónde salga el importe.
     */
    const colaDelRotulo = new Map<number, string>();
    let anterior: FilaDeAnexo | undefined;
    for (const c of clasificadas) {
      if (c.tipo === 'ruido') continue;
      if (c.tipo === 'colaDePeriodo') {
        if (
          anterior !== undefined &&
          anterior.tipo === 'rotulo' &&
          anterior.fila.pagina === c.fila.pagina &&
          !colaDelRotulo.has(anterior.indice)
        ) {
          colaDelRotulo.set(anterior.indice, c.literal);
          marcar(c.indice, 'continuacion');
        } else {
          // Sin rótulo inmediatamente arriba no hay a quién pegarla. Mismo código que hoy: la fila tiene
          // texto y no tiene importe.
          alResiduo(c.indice, c.fila, 'fila_sin_importe');
        }
      }
      anterior = c;
    }

    /**
     * El apareo. `proximoSuelto` **solo avanza**: los importes sueltos se consumen en orden de lectura y una
     * sola vez, y los que quedan antes del rótulo que los busca se saltean para siempre (un importe que
     * aparece **arriba** del rótulo no es su continuación). Ver la nota de arriba sobre la cercanía.
     */
    const sueltos = clasificadas.filter(
      (c): c is Extract<FilaDeAnexo, { tipo: 'importeSuelto' }> => c.tipo === 'importeSuelto',
    );
    const consumidos = new Set<number>();
    let proximoSuelto = 0;

    for (const c of clasificadas) {
      if (c.tipo === 'ruido') {
        marcar(c.indice, 'ruido');
        continue;
      }
      if (c.tipo === 'residuo') {
        alResiduo(c.indice, c.fila, c.codigo);
        continue;
      }
      // `colaDePeriodo` e `importeSuelto` ya se resolvieron o se resuelven después de este lazo.
      if (c.tipo !== 'rotulo') continue;

      const cola = colaDelRotulo.get(c.indice);
      const conceptoLiteral =
        cola === undefined
          ? c.piezas.conceptoLiteral
          : `${c.piezas.conceptoLiteral} ${cola}`.replace(/\s+/g, ' ').trim();

      /**
       * Las dos puertas se pasan **antes** de tomar un importe suelto: un rótulo que no va a emitirse no
       * puede consumir el importe del rótulo que viene abajo. Si lo consumiera, un renglón mal formado se
       * llevaría puesto al siguiente y el segundo error se leería como "faltó un importe".
       */
      if (RE_CORRIDA_DE_IDENTIFICADOR.test(conceptoLiteral)) {
        alResiduo(c.indice, c.fila, 'desconocido');
        continue;
      }
      const periodo = periodoDelRenglon(conceptoLiteral);
      if (periodo === null) {
        alResiduo(c.indice, c.fila, 'fecha_ilegible');
        continue;
      }

      let importe = c.piezas.importe;
      if (importe === null) {
        while (
          proximoSuelto < sueltos.length &&
          (sueltos[proximoSuelto]?.indice ?? Number.POSITIVE_INFINITY) <= c.indice
        ) {
          proximoSuelto += 1;
        }
        const suelto = sueltos[proximoSuelto];
        if (suelto !== undefined) {
          importe = suelto.importe;
          consumidos.add(suelto.indice);
          proximoSuelto += 1;
        }
      }
      // 🔴 Sin importe no se emite: ni en cero, ni con el de otro renglón. Al residuo con su forma.
      if (importe === null) {
        alResiduo(c.indice, c.fila, 'fila_sin_importe');
        continue;
      }

      marcar(c.indice, 'anexo');
      anexos.push(
        armarAnexo({
          clase: c.clase,
          conceptoLiteral,
          periodo,
          importe,
          alicuotaPublicada: c.piezas.alicuotaPublicada,
          /**
           * `ordenEnLote` es **1-based sobre el lote entero** y se asigna en orden de lectura del **rótulo**
           * —no del importe—, que es la fila que identifica al renglón. El anexo no tiene clave natural y
           * `uq_anexo_orden` la exige única por lote.
           */
          ordenEnLote: anexos.length + 1,
          atribucionCuenta,
          // Como en el tercer banco: la página donde arranca la ETIQUETA, no donde cayó el importe.
          paginaPdf: c.fila.pagina,
        }),
      );
    }

    for (const s of sueltos) {
      // Un importe suelto consumido no tiene registro propio: su dato está adentro del renglón del rótulo.
      // Uno que nadie reclamó es una fila con importe y sin rótulo, que es un hallazgo y se reporta.
      if (consumidos.has(s.indice)) marcar(s.indice, 'anexo');
      else alResiduo(s.indice, s.fila, 'desconocido');
    }
  }

  return anexos;
}

/** Clasifica las filas de un bloque mirando **cada una sola**. Ver `FilaDeAnexo`. */
function clasificarBloque(
  filas: readonly FilaGeometrica[],
  textos: readonly string[],
  bloque: BloqueDeAnexo,
): readonly FilaDeAnexo[] {
  const salida: FilaDeAnexo[] = [];

  for (let indice = bloque.desde; indice < bloque.hasta; indice += 1) {
    const fila = filas[indice];
    const texto = textos[indice] ?? '';
    if (!fila) continue;

    // El encabezado de columnas del bloque y el pie de la hoja: ruido **con su regla**, no renglones.
    if (esRuido(fila, texto)) {
      salida.push({ tipo: 'ruido', indice });
      continue;
    }

    const lectura = piezasDelRenglon(fila, bloque.clase);
    if (!lectura.ok) {
      salida.push({ tipo: 'residuo', indice, fila, codigo: lectura.codigo });
      continue;
    }
    const { conceptoLiteral, importe } = lectura.piezas;

    if (conceptoLiteral === '') {
      salida.push(
        importe === null
          ? // Ni texto ni importe: no hay nada que emitir y tampoco una regla que lo explique.
            { tipo: 'residuo', indice, fila, codigo: 'desconocido' }
          : { tipo: 'importeSuelto', indice, fila, importe },
      );
      continue;
    }

    // La cláusula sola, sin importe. Con importe sería un renglón completo y se lee como tal.
    if (importe === null && RE_COLA_PERIODO_DE_EMISION.test(normalizar(conceptoLiteral))) {
      salida.push({ tipo: 'colaDePeriodo', indice, fila, literal: conceptoLiteral });
      continue;
    }

    salida.push({ tipo: 'rotulo', indice, fila, clase: bloque.clase, piezas: lectura.piezas });
  }

  return salida;
}

/**
 * Las piezas de **una** fila del bloque: literal, alícuota e importe (que puede faltar).
 *
 * El renglón se descompone por geometría en cuatro partes y **lo que sobra es el rótulo**, en vez de cortar el
 * rótulo por una `x` fija: en el bloque de tasas el importe no tiene posición medida (§9 lo nombra
 * `Interés cobrado` y §11.3 solo mide el TNA y el CFTEA), así que una banda de literal cableada dejaría
 * afuera cualquier fragmento que el banco corra. Con "todo lo que no se consumió", ningún fragmento
 * publicado se pierde: o es dato de un campo, o está en el literal.
 */
function piezasDelRenglon(fila: FilaGeometrica, clase: ClaseDeAnexo): LecturaDePiezas {
  const consumidos = new Set<Fragmento>();

  /**
   * 1. La fecha del bloque de tasas (§3, `x = 25.0`).
   *
   * **No se usa como período del renglón**, y es deliberado: es la fecha de vigencia de la tasa, no el rango
   * que cubre el importe. Publicarla como `publicado_solo_hasta` sería afirmar un hecho fiscal que el banco
   * no declaró — la misma clase de invento que copiarle el período del extracto.
   */
  const fechaFrag = clase === 'tasas' ? fragmentoEnX(fila, ANEXO.fecha.x, ANEXO.fecha.tolerancia) : undefined;
  if (fechaFrag && RE_FECHA_CUERPO.test(fechaFrag.texto.trim())) consumidos.add(fechaFrag);

  // 2. Las alícuotas que vienen en fragmento propio: el TNA (`r=407.0`) y el CFTEA (`487.0`) de §11.3.
  const alicuotas = fila.fragmentos.filter((f) => RE_ES_ALICUOTA.test(f.texto.trim()));
  for (const f of alicuotas) consumidos.add(f);

  /**
   * 3. El importe, que puede **no estar** — y eso no es un error acá. Ver `PiezasDeRenglon`.
   *
   * - `impositivo`: **por posición**, borde derecho `528.0` (§9). Es un dato medido y se exige.
   * - `tasas`: §9 nombra el `Interés cobrado` pero **no publica su `x`**, así que se toma el fragmento más a
   *   la derecha que parsee como importe y no sea una alícuota. Un `##,##%` no puede colarse:
   *   `importeACentavos` devuelve `null` por el `%` — y además ya está consumido.
   */
  const importeFrag =
    clase === 'impositivo'
      ? importeDelDetalleImpositivo(fila)
      : [...fila.fragmentos]
          .reverse()
          .find((f) => !consumidos.has(f) && importeACentavos(f.texto) !== null);

  let importe: ImporteDeAnexo | null = null;
  if (importeFrag) {
    const centavos = importeACentavos(importeFrag.texto);
    // Defensivo: los dos caminos de arriba ya exigen que parsee. Si no parsea, la fila no trae importe.
    if (centavos !== null) {
      // `importeDeclarado` es **no signado**, contra el importe signado del movimiento: un anexo es una
      // magnitud cobrada. Un token negativo acá no se convierte a magnitud: es un hallazgo y se reporta.
      if (centavos < 0n) return { ok: false, codigo: 'desconocido' };
      consumidos.add(importeFrag);
      importe = { centavos, texto: importeFrag.texto };
    }
  }

  // 4. Lo que sobra es el rótulo, **tal como lo escribe el banco**. No se normaliza: dos grafías del mismo
  // literal son dos hechos del documento, y normalizar es trabajo del léxico del Módulo 2.
  const conceptoLiteral = fila.fragmentos
    .filter((f) => !consumidos.has(f))
    .map((f) => f.texto)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  /**
   * La alícuota, **literal y nunca parseada a número**: una tasa en float es el mismo error que un importe en
   * float. Cuando el banco publica dos en la misma fila (TNA y CFTEA, §11.3) van **las dos**, en orden de
   * lectura: el campo es uno solo y quedarse con una perdería un dato publicado, que es justo lo que este
   * trabajo vino a arreglar. Distinguirlas necesitaría una columna más en el esquema compartido.
   */
  const alicuotaPublicada =
    alicuotas.length > 0
      ? alicuotas.map((f) => f.texto.trim()).join(' ')
      : (RE_ALICUOTA_EN_EL_LITERAL.exec(conceptoLiteral)?.[0] ?? undefined);

  return { ok: true, piezas: { conceptoLiteral, alicuotaPublicada, importe } };
}

/**
 * El importe del `Detalle impositivo`: el fragmento de la ventana `[524, 532]` **que parsea como importe**.
 *
 * 🔴 No es `fragmentoEnVentanaDerecha` y la diferencia no es cosmética: esa función devuelve **el primero**
 * cuyo borde derecho cae en la ventana, parsee o no. Un rótulo largo cuyo borde derecho aterrice adentro de
 * los 8 pt de la ventana **tapa** al importe que viene atrás, y la fila entera se reporta como
 * `fila_sin_importe` — que es exactamente la forma de residuo que hoy tienen las dos filas con pinta de
 * rótulo del archivo real. Filtrar por "parsea como importe" no puede capturar de más: la ventana es
 * **disjunta** de las tres columnas del cuerpo (§9 vs §3), y un rótulo no parsea como importe.
 *
 * Es estrictamente más ancho que lo anterior: cuando hay un solo fragmento en la ventana, las dos funciones
 * devuelven lo mismo.
 */
function importeDelDetalleImpositivo(fila: FilaGeometrica): Fragmento | undefined {
  return fila.fragmentos.find((f) => {
    const derecha = f.x + f.ancho;
    if (derecha < ANEXO.importe.desde || derecha > ANEXO.importe.hasta) return false;
    return importeACentavos(f.texto) !== null;
  });
}

/** Arma el renglón con los cinco campos que el esquema pide y **ninguno rellenado por default**. */
function armarAnexo(args: {
  readonly clase: ClaseDeAnexo;
  readonly conceptoLiteral: string;
  readonly periodo: PeriodoDelRenglon;
  readonly importe: ImporteDeAnexo;
  readonly alicuotaPublicada: string | undefined;
  readonly ordenEnLote: number;
  readonly atribucionCuenta: AtribucionAnexo;
  readonly paginaPdf: number;
}): AnexoExtracto {
  const { periodo, importe } = args;
  return {
    tipoFila: 'anexo',
    conceptoLiteral: args.conceptoLiteral,
    ordenEnLote: args.ordenEnLote,
    atribucionCuenta: args.atribucionCuenta,
    ...(periodo.desde === undefined ? {} : { periodoDesde: periodo.desde }),
    ...(periodo.hasta === undefined ? {} : { periodoHasta: periodo.hasta }),
    periodoDato: periodo.dato,
    importeDeclarado: centavosAImporte(importe.centavos),
    // La moneda sale del **símbolo que el banco imprime** pegado al importe (`$` / `U$S`, §11.8), no de en
    // qué cuenta cayó el bloque: la atribución a una cuenta es justamente lo que acá no está determinado.
    moneda: /U\$S/i.test(importe.texto) ? 'USD' : 'ARS',
    ...(args.alicuotaPublicada === undefined ? {} : { alicuotaPublicada: args.alicuotaPublicada }),
    relacionConMovimientos: relacionDelRenglon(args.clase, args.conceptoLiteral),
    paginaPdf: args.paginaPdf,
  };
}

/**
 * Qué publica el banco sobre el período de **este** renglón (§9).
 *
 * 🔴 **Nunca el período del extracto.** Sería un hecho fiscal fabricado que cuadra — la misma clase de error
 * que una cotización completada con la de hoy. Devuelve `null` cuando el renglón **declara** un rango y las
 * fechas no se pudieron leer: eso es un hallazgo, y degradarlo a `no_publicado` lo escondería.
 */
type PeriodoDelRenglon = {
  readonly dato: PeriodoAnexo;
  readonly desde?: string;
  readonly hasta?: string;
};

function periodoDelRenglon(literal: string): PeriodoDelRenglon | null {
  const completo = RE_PERIODO_COMPLETO.exec(literal);
  if (completo) {
    const desde = parsearFecha(completo[1] ?? '');
    const hasta = parsearFecha(completo[2] ?? '');
    // Un rango invertido no se da vuelta: el esquema y el `check` de la base lo rechazan, y "arreglarlo" acá
    // escondería que se leyó una fecha de otra parte de la fila.
    if (desde === null || hasta === null || hasta < desde) return null;
    return { dato: 'publicado_completo', desde, hasta };
  }

  const soloHasta = RE_PERIODO_SOLO_HASTA.exec(literal);
  if (soloHasta) {
    const hasta = parsearFecha(soloHasta[1] ?? '');
    if (hasta === null) return null;
    return { dato: 'publicado_solo_hasta', hasta };
  }

  // El SIRCREB: el banco DECLARA cuál es el período sin imprimirlo. Ver `RE_PERIODO_DE_EMISION`.
  if (RE_PERIODO_DE_EMISION.test(normalizar(literal))) return { dato: 'periodo_de_emision' };

  return { dato: 'no_publicado' };
}

/**
 * ¿El importe de este renglón **ya está** en los movimientos del cuerpo? (§9)
 *
 * Es lo que convierte *"prohibido que entre en la suma"* —una prohibición que nadie puede chequear— en una
 * condición sobre una columna. Dos de las tres salidas son fail-closed (`resume_…` y `no_determinada` se
 * tratan igual: no registrar de más); la tercera, `no_esta_en_los_movimientos`, es la única que habilita una
 * registración y por eso se emite **solo** contra su literal explícito.
 *
 * El bloque de tasas va entero a `resume_movimientos_del_cuerpo` **por §9**, no por su rótulo: lo que ese
 * bloque publica es el `Interés cobrado`, y el cuerpo trae sus movimientos de `Cobro de interes por
 * descubierto`. Es además el lado seguro: si un período agregara otra columna a ese bloque, el error sería
 * "no se registró algo que había que registrar", no "se registró dos veces".
 */
function relacionDelRenglon(clase: ClaseDeAnexo, literal: string): RelacionAnexo {
  if (clase === 'tasas') return 'resume_movimientos_del_cuerpo';

  const normalizado = normalizar(literal);
  // El orden importa: el literal del computable puede nombrar el mismo impuesto que los que sí lo resumen.
  if (RE_ANEXO_COMPUTABLE.test(normalizado)) return 'no_esta_en_los_movimientos';
  if (RE_ANEXO_RESUMEN.test(normalizado)) return 'resume_movimientos_del_cuerpo';
  return 'no_determinada';
}

// -----------------------------------------------------------------------------
// Piezas del cuerpo
// -----------------------------------------------------------------------------

/**
 * Suma a un movimiento abierto lo que aporta una fila. Devuelve si aportó algo.
 *
 * **El par se toma de la primera fila que lo trae y no se sobreescribe**, igual que el comprobante: si una
 * continuación trajera otro token con forma de importe, la ambigüedad no se resuelve por preferencia.
 */
function absorber(b: BloqueAbierto, fila: FilaGeometrica): boolean {
  let aporto = false;

  const glosa = fragmentosEnBanda(fila, GLOSA.desde, GLOSA.hasta);
  if (glosa !== '') {
    b.lineas.push(glosa);
    aporto = true;
  }

  if (b.comprobante === null) {
    const frag = fragmentoEnX(fila, COLUMNAS.comprobante.x, COLUMNAS.comprobante.tolerancia);
    const valor = frag?.texto.trim() ?? '';
    if (valor !== '') {
      b.comprobante = valor;
      aporto = true;
    }
  }

  if (b.par === null) {
    /**
     * **`traeSignoEnElImporte: false`.** El token nunca trae signo (§0), así que el signo se **deriva** de
     * la columna y un token firmado no es un negativo: es un token mal separado o una fila que no es un
     * movimiento, y la función devuelve `null`.
     */
    const par = parDeColumnas(fila, VENTANAS, { traeSignoEnElImporte: false });
    if (par) {
      b.par = par;
      aporto = true;
    }
  }

  return aporto;
}

function armarMovimiento(
  b: BloqueAbierto,
  par: ParDeFila,
  filaNumero: number,
  moneda: Moneda,
): MovimientoBancarioCrudo {
  const magnitud = par.importe.startsWith('-') ? par.importe.slice(1) : par.importe;

  /**
   * `importeCanonicoACentavos`, **no** `importeACentavos`: `par.saldo` ya salió de `centavosAImporte`, o
   * sea que está en forma canónica (punto decimal). El parser argentino sobre un canónico devuelve `null`,
   * y con un `?? 0n` el saldo quedaría en cero y `saldoEsAcreedor` nunca daría `true` — o sea que **las 158
   * filas en descubierto se leerían como saldo positivo** (§5). Las dos funciones toman `string` y
   * devuelven `bigint | null`: confundirlas no da error de tipos.
   */
  const saldoCent = importeCanonicoACentavos(par.saldo) ?? 0n;

  /**
   * §7: la semántica de las dos líneas es **estable** —línea 1 es el concepto del banco, línea 2 la
   * contraparte o la referencia— y el concepto **no se trunca** a ancho fijo. Eso habilita publicar
   * `conceptoBanco` aparte, que es sobre lo que van a matchear las reglas del Módulo 2, y es lo que el
   * primer banco del roster **no** permitía (allá el concepto sigue en la línea siguiente).
   *
   * **INV-14: es la primera línea del MISMO texto con el que se arma `descripcion`.** No una segunda
   * reconstrucción, no un recorte por cantidad de caracteres: `descripcion` es el `join` de `lineas` y
   * `conceptoBanco` es `lineas[0]`, así que el prefijo se cumple por construcción y no por disciplina.
   * `persistirCuenta` lo vuelve a verificar sobre la glosa **depurada** y rechaza el lote con
   * `concepto_banco_no_es_prefijo` si no da.
   *
   * Se guarda con la grafía que imprime el banco (sentence case, §12) y **sin normalizar**: el mismo
   * catálogo sale en Title Case en el `.xls`, y quien compare las dos fuentes tiene que poder elegir la
   * normalización. La comparación de INV-14 no se ve afectada porque el prefijo se chequea con las dos
   * puntas pasadas por la misma `depurarGlosa`.
   */
  const conceptoBanco = b.lineas[0] ?? '';

  return {
    tipoFila: 'movimiento',
    fecha: b.fecha,
    descripcionLineas: b.lineas,
    // La concatenación de las dos líneas. La depuración de identificadores NO se hace acá: la hace
    // `persistirCuenta` con `depurarGlosa` antes de escribir, y este campo es la glosa de origen.
    descripcion: b.lineas.join(' ').replace(/\s+/g, ' ').trim(),
    /**
     * Los tres campos del concepto viajan **juntos o no viajan**: el esquema tiene dos `refine` que atan
     * `conceptoBanco` con su estrategia y con `conceptoCompleto`, precisamente para que "el banco no lo
     * publica" no se pueda confundir con "el adaptador no lo miró".
     *
     * - `segmento_de_glosa`: el corte es **geométrico**, la línea 1 de la glosa. No es `columna_propia`
     *   —eso es el `Cod. Operativo` del `.xls` (§14.2), que este adaptador no lee— ni `prefijo_anclado`:
     *   no hay lista cerrada de etiquetas contra la que anclar.
     * - `conceptoCompleto: true` porque **está medido** (§7): el concepto no se trunca a ancho fijo —máx.
     *   41 caracteres contra una columna que llega a 274.8 pt— y toda la glosa sale en `x = 115.0`. No se
     *   deriva del `ancho` del fragmento a propósito: en este banco la métrica de fuente es lo menos
     *   confiable del archivo (§11.2 y §11.12), así que apoyar el dato ahí sería peor que declararlo.
     *   (Que una de las 29 etiquetas del catálogo del banco *parezca* cortada —§12— es otra pregunta: ésa
     *   es la etiqueta que el banco imprime, no un corte de columna.)
     */
    ...(conceptoBanco === ''
      ? {}
      : {
          conceptoBanco,
          conceptoCompleto: true,
          conceptoBancoEstrategia: 'segmento_de_glosa' as const,
        }),
    ...(par.columna === 'credito' ? { credito: magnitud } : { debito: magnitud }),
    columnaOrigen: par.columna,
    importe: par.importe,
    saldo: par.saldo,
    // §5: las 158 filas tienen saldo negativo (descubierto todo el período), y en cuenta corriente eso
    // significa saldo acreedor. La notación del saldo POSITIVO en pesos queda no determinada (§15).
    saldoEsAcreedor: saldoCent < 0n,
    moneda,
    cotizacionProvista: false,
    filaNumero,
    paginaPdf: b.paginaPdf,
    /**
     * El `Comprobante` es la referencia de mayor jerarquía que publica este banco: columna propia, 2 a 8
     * dígitos, presente en 94 de 158 (§10, §15). Sale de **su columna**, nunca de un patrón sobre la glosa
     * —que es cómo un número de terminal termina siendo un comprobante—.
     */
    ...(b.comprobante === null
      ? {}
      : {
          referenciaExterna: b.comprobante,
          referencias: [{ tipo: 'operacion' as const, valor: b.comprobante }],
        }),
    filaHash: '',
  } as MovimientoBancarioCrudo;
}

/**
 * La fila `Saldo Inicial` (§11.5): saldo en su columna y **ningún** fragmento en las de importe.
 *
 * La ausencia de importe se exige, no se asume: una fila con etiqueta `Saldo Inicial` y un importe en una
 * columna no es un saldo inicial, es otra cosa, y aceptarla metería un saldo inventado en la semilla de la
 * cadena — que es el dato del que dependen V3, V4 y V5.
 */
function leerSaldoInicial(fila: FilaGeometrica): string | null {
  if (fragmentoEnVentanaDerecha(fila, VENTANAS.debito.desde, VENTANAS.debito.hasta)) return null;
  if (fragmentoEnVentanaDerecha(fila, VENTANAS.credito.desde, VENTANAS.credito.hasta)) return null;

  const saldo = fragmentoEnVentanaDerecha(fila, VENTANAS.saldo.desde, VENTANAS.saldo.hasta);
  if (!saldo) return null;
  const centavos = importeACentavos(saldo.texto);
  return centavos === null ? null : centavosAImporte(centavos);
}

/** La fila `Saldo total` (§9): un único importe, con su propio borde derecho (§11.4). */
function leerSaldoTotal(fila: FilaGeometrica): string | null {
  const frag = fragmentoEnVentanaDerecha(
    fila,
    VENTANA_SALDO_TOTAL.desde,
    VENTANA_SALDO_TOTAL.hasta,
  );
  if (!frag) return null;
  const centavos = importeACentavos(frag.texto);
  return centavos === null ? null : centavosAImporte(centavos);
}

/** El pie `N - M` (§8): el patrón **más** la posición. El patrón solo es demasiado genérico. */
function esPieDePagina(fila: FilaGeometrica, texto: string): boolean {
  return RE_PIE.test(texto) && fragmentoEnX(fila, PIE.x, PIE.tolerancia) !== undefined;
}

/** El `M` del pie: lo que el documento declara tener. Contado ≠ declarado significa que faltan hojas. */
function leerPaginasDeclaradas(filas: readonly FilaGeometrica[]): number | undefined {
  for (const fila of filas) {
    const texto = textoDeFila(fila);
    if (!esPieDePagina(fila, texto)) continue;
    const m = RE_PIE.exec(texto);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// Cuentas: una región = una cuenta (spec §11.6)
// -----------------------------------------------------------------------------

/**
 * Qué cuenta es cada región.
 *
 * Las dos tablas tienen **la misma geometría**, así que la identidad sale del texto y de dos señales
 * independientes:
 *
 *   - la **cabecera de cuenta** (`Cuenta Corriente Nº` / `Cuenta Corriente especial U$S Nº`), que además
 *     trae el número — el único identificador con el que se puede resolver la cuenta;
 *   - el **título de sección** (`Movimientos en pesos` / `en dólares`), que está justo antes del
 *     encabezado de columnas.
 *
 * Si las dos aparecen y **se contradicen**, no se elige una en silencio: se reporta. Y si la región no
 * tiene cabecera propia —medido: hay 8 cabeceras para 8 páginas de tabla y **2** cuentas, así que la
 * segunda sección puede no tener la suya—, se busca en todo el documento la cabecera de la **misma
 * variante**, que es la que la carátula imprime. Nunca "la otra cabecera que haya": eso le pegaría el
 * número de la cuenta en pesos a la cuenta en dólares.
 */
function metadatoDeRegion(
  filas: readonly FilaGeometrica[],
  textos: readonly string[],
  regiones: readonly RegionDeTabla[],
  k: number,
  region: RegionDeTabla,
  noInterpretadas: LineaNoInterpretada[],
  marcar: (i: number, destino: DestinoSantander) => void,
): MetadatoDeCuenta {
  const hasta = region.indiceCierre ?? textos.length;

  let cabecera: string | null = null;
  for (let i = region.indiceEncabezado + 1; i < hasta; i += 1) {
    const t = textos[i] ?? '';
    if (RE_CABECERA_CUENTA.test(t)) {
      cabecera = t;
      break;
    }
  }

  // El título de sección más cercano por arriba, sin cruzar el cierre de la región anterior.
  const anterior = regiones[k - 1];
  const piso = anterior ? (anterior.indiceCierre ?? -1) + 1 : 0;
  let titulo: string | null = null;
  for (let i = region.indiceEncabezado - 1; i >= piso; i -= 1) {
    const t = textos[i] ?? '';
    if (RE_TITULO_SECCION.test(t)) {
      titulo = t;
      break;
    }
  }

  const dolaresPorCabecera = cabecera === null ? null : RE_ES_DOLARES.test(cabecera);
  const dolaresPorTitulo = titulo === null ? null : RE_TITULO_DOLARES.test(titulo);

  if (
    dolaresPorCabecera !== null &&
    dolaresPorTitulo !== null &&
    dolaresPorCabecera !== dolaresPorTitulo
  ) {
    // Las dos señales de moneda se contradicen. Gana la cabecera —es la que trae el número, o sea la
    // identidad— y la contradicción se reporta para que el lote no pase en verde con las cuentas cruzadas.
    // El destino de la fila de encabezado pasa de `ruido` a `residuo`: se reportó, así que se cuenta.
    marcar(region.indiceEncabezado, 'residuo');
    noInterpretadas.push({
      codigo: 'desconocido',
      forma: formaParaLog(cabecera ?? '', 60),
      paginaPdf: filas[region.indiceEncabezado]?.pagina ?? 1,
      indice: region.indiceEncabezado,
    });
  }

  const esDolares = dolaresPorCabecera ?? dolaresPorTitulo ?? false;

  // Sin cabecera propia: la de la misma variante en cualquier parte del documento (típicamente la
  // carátula). Se filtra por variante para no atribuirle a una cuenta el número de la otra.
  const cabeceraUsada =
    cabecera ?? textos.find((t) => RE_CABECERA_CUENTA.test(t) && RE_ES_DOLARES.test(t) === esDolares) ?? null;

  const numero = cabeceraUsada === null ? null : (RE_NUMERO_CUENTA.exec(cabeceraUsada)?.[1] ?? null);

  /**
   * La denominación es lo que el banco escribe antes del `Nº`. Nunca es identificador (puede repetirse
   * entre cuentas), y por eso no entra en el hash: para eso está el número.
   */
  const denominacion =
    cabeceraUsada === null
      ? esDolares
        ? 'Cuenta Corriente especial U$S'
        : 'Cuenta Corriente'
      : (cabeceraUsada.split(/\s*N\u00BA/)[0] ?? '').trim();

  const filaCierre = region.indiceCierre === null ? undefined : filas[region.indiceCierre];

  return {
    moneda: esDolares ? 'USD' : 'ARS',
    numero,
    denominacion: denominacion === '' ? 'Cuenta Corriente' : denominacion,
    saldoFinalDeclarado: filaCierre ? leerSaldoTotal(filaCierre) : null,
  };
}

/**
 * Arma la cuenta con sus movimientos.
 *
 * **Una cuenta con cero movimientos se emite igual.** La cuenta en dólares del archivo medido trae su
 * `Saldo Inicial`, la leyenda impresa `No tenés movimientos en dólares este período.` y su `Saldo total`,
 * con cero filas: está **vacía y es legítima** (§11.7). Descartarla escondería una cuenta del cliente, y el
 * alcance de `EST_SIN_MOVIMIENTOS` ya está resuelto del otro lado —es del lote, no de la cuenta— por
 * `ContextoVerificacion.movimientosEnElLote`.
 */
function armarCuenta(
  meta: MetadatoDeCuenta | undefined,
  acumulador:
    | {
        readonly movimientos: readonly MovimientoBancarioCrudo[];
        readonly saldoInicialDeclarado: string | null;
      }
    | undefined,
  periodo: { readonly desde: string; readonly hasta: string },
  cbu: string | null,
  cuitTitular: string | null,
  anexos: readonly AnexoExtracto[],
): CuentaConMovimientos | null {
  if (!meta || !acumulador) return null;

  /**
   * Los hashes se asignan al final y **por cuenta**: el ordinal de empate se cuenta dentro de esta cuenta,
   * no sobre el archivo. `hashesDeCuenta` ata las dos cosas para que un adaptador multi-cuenta no pueda
   * contar el ordinal sobre el archivo entero ni olvidarse la cuenta dentro del material del hash.
   */
  const clave: ClaveCuenta = {
    bancoCodigo: BANCO_CODIGO,
    numeroNormalizado: normalizarNumeroCuenta(meta.numero ?? 'sin_numero'),
    moneda: meta.moneda,
  };
  const hashes = hashesDeCuenta(
    clave,
    acumulador.movimientos.map((m) => ({
      fecha: m.fecha,
      importe: m.importe,
      saldo: m.saldo ?? null,
      descripcion: m.descripcion,
    })),
  );

  return {
    cuenta: {
      denominacion: meta.denominacion,
      // §2: la variante `especial U$S` es un tipo de cuenta distinto, no la misma cuenta en otra moneda.
      tipoCuenta: meta.moneda === 'USD' ? 'cuenta_corriente_especial' : 'cuenta_corriente',
      ...(meta.numero === null ? {} : { numero: meta.numero }),
      ...(cbu === null ? {} : { cbu }),
      moneda: meta.moneda,
      periodoDesde: periodo.desde,
      periodoHasta: periodo.hasta,
      ...(acumulador.saldoInicialDeclarado === null
        ? {}
        : { saldoInicialDeclarado: acumulador.saldoInicialDeclarado }),
      ...(meta.saldoFinalDeclarado === null
        ? {}
        : { saldoFinalDeclarado: meta.saldoFinalDeclarado }),
      // §9: este banco NO publica totales de columna. Los campos quedan ausentes y la capacidad lo declara.
      ...(cuitTitular === null ? {} : { titularDocumento: cuitTitular }),
    },
    movimientos: acumulador.movimientos.map((m, i) => ({ ...m, filaHash: hashes[i] ?? '' })),
    /**
     * Los 7 renglones de los dos bloques de la p9 (§9), **con su período declarado en `periodoDato` y no
     * copiado del extracto**. Que estén acá adentro no dice de qué cuenta son: eso lo dice
     * `atribucionCuenta`, y por eso llegan ya leídos en vez de leerse por cuenta.
     *
     * ⚠️ **Ninguno entra en la suma de movimientos**, y no es una promesa: es lo que dice cada renglón en
     * `relacionConMovimientos` y lo que el campo se llame `importeDeclarado` y no `importe`.
     */
    anexos: [...anexos],
  };
}

// -----------------------------------------------------------------------------
// El adaptador, con la forma del contrato
// -----------------------------------------------------------------------------

export const adaptadorSantander = {
  bancoCodigo: BANCO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_SANTANDER,
  reconoce: (e: EntradaDeAdaptador): boolean => reconoceSantander(e.filas),
  leer: (e: EntradaDeAdaptador): SalidaDeAdaptador => leerSantander(e.filas),
} as const;
