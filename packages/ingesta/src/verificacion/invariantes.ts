/**
 * `verificarAritmetica` — la red de seguridad del Módulo 1, y la condición de salida nº 12.
 *
 * ## Por qué esto le gana a cualquier fixture
 *
 * Un fixture afirma lo que **nosotros** creíamos que era el formato el día que lo escribimos. Un fixture
 * escrito con un malentendido lo consagra, y el test verde certifica el malentendido para siempre.
 *
 * La línea de totales y la columna de saldo afirman lo que **dice el banco**, sobre el archivo real, en
 * **todos** los archivos — incluidos los formatos que no vimos y los meses que todavía no existen. Es un
 * oráculo que viaja con el dato, no con el código.
 *
 * ## Y por qué la cadena de saldos le gana incluso a los totales
 *
 * Los totales son **una** ecuación agregada. La cadena son **N−1 ecuaciones independientes**, una por fila:
 *
 *   - **Localiza:** no dice "no cuadra", dice "se rompe entre la fila 142 y la 143, página 14".
 *   - **Es inmune a la compensación:** una fila duplicada más una perdida del mismo importe dejan el total
 *     intacto y rompen dos eslabones.
 *   - **Funciona sin línea de totales**, que es la mitad de los bancos del roster.
 *   - **Y en un banco del roster que NO publica signo, la cadena no es la red: es la FUENTE.**
 *     `importe = saldo(n) − saldo(n−1)` es la única forma de saber si fue débito o crédito.
 *
 * Medido sobre el archivo real del primer banco: **0 eslabones rotos en 325**, y las dos sumas cuadran al
 * centavo contra la línea `Total`. Las dos redes son **exactas**, no aproximadas — y eso es lo que permite
 * usarlas como gate duro y no como advertencia.
 *
 * ## Las dos reglas de construcción que lo hacen confiable
 *
 * 1. **Esta función CALCULA el veredicto.** Ningún adapter declara si cuadró. Un booleano que el productor
 *    del dato se autocertifica no es una verificación.
 * 2. **Nunca se recalcula una suma desde los datos leídos para compararla contra sí misma.** Se compara
 *    contra lo que **declara el documento**. Comparar una suma consigo misma es el chequeo que siempre pasa.
 */

import {
  centavosAImporte,
  dentroDelPeriodo,
  importeCanonicoACentavos,
  type Periodo,
} from '../parseo-ar.ts';
import type {
  CapacidadesAdaptador,
  ConsolidadoPorMoneda,
  CuentaConMovimientos,
  Diferencia,
  MovimientoBancarioCrudo,
  Verificacion,
} from '../esquema.ts';

export type ContextoVerificacion = {
  readonly capacidades: CapacidadesAdaptador;
  /** Páginas que traían encabezado de columnas y por lo tanto deberían aportar filas. */
  readonly paginasConEncabezado?: number;
  readonly paginasSinMovimientos?: number;
  /** ¿Toda línea del cuerpo quedó asignada a algo? Lo calcula el adapter; acá se reporta. */
  readonly coberturaDeLineasCompleta?: boolean;
  readonly cantidadLineasNoInterpretadas?: number;
  /**
   * Movimientos del **lote entero**, sumando todas sus cuentas. Decide el alcance de `EST_SIN_MOVIMIENTOS`.
   *
   * ## La decisión, y por qué el alcance es el archivo y no la cuenta
   *
   * "0 movimientos nunca es éxito" es una regla correcta y **aplicada por cuenta pone rojo un archivo
   * correcto**. Medido en el segundo banco del roster (`06-formato-santander.md` §11.7): su cuenta en
   * dólares viene con saldo inicial, la leyenda impresa `No tenés movimientos en dólares este período.` y
   * su saldo final — **vacía y legítima**. Rechazar el lote entero por eso descartaría los 158 movimientos
   * de la cuenta en pesos, que están perfectos.
   *
   * Con alcance de archivo la regla conserva lo que existe para atrapar —un parser que no encontró nada
   * sigue dando error, porque entonces el lote también está en cero— y deja de castigar el caso real.
   *
   * Sin este dato se mantiene el comportamiento anterior: 0 movimientos en la cuenta es error. El default
   * es el estricto **a propósito**: un llamador que se olvide de pasarlo falla del lado seguro.
   */
  readonly movimientosEnElLote?: number;
};

function dif(
  codigo: Diferencia['codigo'],
  severidad: Diferencia['severidad'],
  extra: Omit<Diferencia, 'codigo' | 'severidad'> = {},
): Diferencia {
  return { codigo, severidad, ...extra };
}

/** Centavos de un importe canónico. `null` nunca debería pasar: el esquema ya validó la forma. */
function cent(canonico: string): bigint | null {
  return importeCanonicoACentavos(canonico);
}

// -----------------------------------------------------------------------------

export function verificarAritmetica(
  entrada: CuentaConMovimientos,
  contexto: ContextoVerificacion,
): Verificacion {
  const { cuenta, movimientos } = entrada;
  const { capacidades } = contexto;
  const diferencias: Diferencia[] = [];

  // ---------------------------------------------------------------------------
  // Sumas calculadas (en centavos, siempre)
  // ---------------------------------------------------------------------------
  let creditos = 0n;
  let debitos = 0n;

  for (const m of movimientos) {
    const v = cent(m.importe);
    if (v === null) {
      diferencias.push(dif('ARIT_IMPORTE_INCOHERENTE', 'error', { filaNumero: m.filaNumero }));
      continue;
    }
    if (v >= 0n) creditos += v;
    else debitos += -v;
  }

  // ---------------------------------------------------------------------------
  // V1 — la cadena de saldos, fila por fila. La más fuerte, porque LOCALIZA.
  // ---------------------------------------------------------------------------
  const filasConRuptura: number[] = [];
  const puedeVerificarCadena =
    capacidades.traeSaldoPorFila &&
    capacidades.cadenaDeSaldos !== 'no_disponible' &&
    movimientos.length > 1;

  if (puedeVerificarCadena) {
    for (let i = 1; i < movimientos.length; i += 1) {
      const anterior = movimientos[i - 1];
      const actual = movimientos[i];
      if (!anterior?.saldo || !actual?.saldo) {
        // Cadena por puntos de control: el banco no imprime saldo en todas las filas. No es una ruptura.
        continue;
      }
      const sAnt = cent(anterior.saldo);
      const sAct = cent(actual.saldo);
      const imp = cent(actual.importe);
      if (sAnt === null || sAct === null || imp === null) continue;

      if (sAnt + imp !== sAct) {
        filasConRuptura.push(actual.filaNumero);
        diferencias.push(
          dif('ARIT_CADENA_ROTA', 'error', {
            filaNumero: actual.filaNumero,
            paginaPdf: actual.paginaPdf,
          }),
        );
      }

      // V5 — el signo del importe tiene que ser el signo del delta del saldo.
      //
      // No es redundante con la cadena: si el adapter derivó `importe` del MISMO dato con el que armó el
      // saldo, un crédito clasificado como débito no rompe ninguna suma y pasa silencioso. Esto lo ve.
      const delta = sAct - sAnt;
      if (delta !== 0n && imp !== 0n && (delta > 0n) !== (imp > 0n)) {
        diferencias.push(
          dif('ARIT_SIGNO_INVERTIDO', 'error', {
            filaNumero: actual.filaNumero,
            paginaPdf: actual.paginaPdf,
          }),
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // V2 — las dos sumas contra los totales DECLARADOS, por separado.
  //
  // Más fuerte que V4: un crédito cargado como débito por el mismo importe deja intacta la ecuación de la
  // cuenta (los dos errores se cancelan) y rompe estas dos.
  // ---------------------------------------------------------------------------
  let verificoTotales = false;
  if (capacidades.traeTotalesDeclarados) {
    const decCred = cuenta.totalCreditosDeclarado ? cent(cuenta.totalCreditosDeclarado) : null;
    const decDeb = cuenta.totalDebitosDeclarado ? cent(cuenta.totalDebitosDeclarado) : null;

    if (decCred !== null && decDeb !== null) {
      verificoTotales = true;
      if (decCred !== creditos) diferencias.push(dif('ARIT_TOTAL_CREDITOS', 'error'));
      if (decDeb !== debitos) diferencias.push(dif('ARIT_TOTAL_DEBITOS', 'error'));
    }
    // Si el banco DICE traer totales y el parser no los encontró, no se degrada a "no aplica": el parser
    // falló, y eso es distinto de un banco que no los publica.
    else diferencias.push(dif('ARIT_TOTAL_CREDITOS', 'error', { campo: 'totales_no_encontrados' }));
  }

  // ---------------------------------------------------------------------------
  // V3/V4 — la ecuación de la cuenta: saldo inicial + créditos − débitos = saldo final.
  // Es el control que la contadora hace a mano.
  // ---------------------------------------------------------------------------
  let verificoSaldos = false;
  let saldoFinalCalculado: string | undefined;

  if (capacidades.traeSaldoInicialDeclarado && cuenta.saldoInicialDeclarado) {
    const inicial = cent(cuenta.saldoInicialDeclarado);
    if (inicial !== null) {
      const calculado = inicial + creditos - debitos;
      saldoFinalCalculado = centavosAImporte(calculado);

      if (cuenta.saldoFinalDeclarado) {
        const declarado = cent(cuenta.saldoFinalDeclarado);
        if (declarado !== null) {
          verificoSaldos = true;
          if (declarado !== calculado) diferencias.push(dif('ARIT_SALDO_FINAL', 'error'));
        }
      }

      // V3 — el saldo inicial reconstruido desde la primera fila. Resuelve además la trampa de los dos
      // saldos sin rótulo del encabezado: se decide por invariante, no por posición.
      const primera = movimientos[0];
      if (primera?.saldo) {
        const s1 = cent(primera.saldo);
        const i1 = cent(primera.importe);
        if (s1 !== null && i1 !== null && s1 - i1 !== inicial) {
          diferencias.push(dif('ARIT_SALDO_INICIAL', 'error', { filaNumero: primera.filaNumero }));
        }
      }
    }
  }

  // V5' — el último saldo contra el declarado. Redundante A PROPÓSITO: si V1 y V4 pasan y esto no, el bug
  // está en el parser de la línea de totales, no en el cuerpo.
  const ultima = movimientos.at(-1);
  if (ultima?.saldo && cuenta.saldoFinalDeclarado) {
    const u = cent(ultima.saldo);
    const d = cent(cuenta.saldoFinalDeclarado);
    if (u !== null && d !== null && u !== d) {
      diferencias.push(dif('ARIT_SALDO_FINAL', 'error', { campo: 'ultimo_saldo' }));
    }
  }

  // ---------------------------------------------------------------------------
  // V7 — fechas dentro del período y no decrecientes
  // ---------------------------------------------------------------------------
  let fechasDentroDelPeriodo = true;
  let fechasMonotonas = true;

  const periodo: Periodo | null =
    cuenta.periodoDesde && cuenta.periodoHasta
      ? { desde: cuenta.periodoDesde, hasta: cuenta.periodoHasta }
      : null;

  /**
   * La severidad de "fecha fuera del período" **la declara el banco**, no la decide esta función.
   *
   * Ver `capacidades.traeMovimientosFueraDelPeriodo`: en un banco medido la invariante es simplemente falsa
   * (4 movimientos de octubre en un resumen de noviembre) y en el resto sigue siendo un hallazgo real. Baja
   * a observación, **no desaparece**: el dato queda en `verificacion_detalle` y `fechasDentroDelPeriodo`
   * sigue reportando `false`.
   */
  const severidadFechaFuera: Diferencia['severidad'] = capacidades.traeMovimientosFueraDelPeriodo
    ? 'observacion'
    : 'error';

  let anterior: MovimientoBancarioCrudo | undefined;
  for (const m of movimientos) {
    if (periodo && !dentroDelPeriodo(m.fecha, periodo)) {
      fechasDentroDelPeriodo = false;
      diferencias.push(
        dif('EST_FECHA_FUERA_DE_PERIODO', severidadFechaFuera, {
          filaNumero: m.filaNumero,
          paginaPdf: m.paginaPdf,
        }),
      );
    }
    if (anterior && m.fecha < anterior.fecha) {
      fechasMonotonas = false;
      diferencias.push(dif('EST_FECHA_NO_MONOTONA', 'error', { filaNumero: m.filaNumero }));
    }
    anterior = m;
  }

  // ---------------------------------------------------------------------------
  // V10/V12 — hashes distintos, una sola moneda
  // ---------------------------------------------------------------------------
  const hashes = new Set<string>();
  for (const m of movimientos) {
    if (hashes.has(m.filaHash)) {
      diferencias.push(dif('EST_HASH_DUPLICADO', 'error', { filaNumero: m.filaNumero }));
    }
    hashes.add(m.filaHash);
    if (m.moneda !== cuenta.moneda) {
      diferencias.push(dif('EST_MONEDA_MEZCLADA', 'error', { filaNumero: m.filaNumero }));
    }
  }

  // ---------------------------------------------------------------------------
  // V8/V9 — páginas y cobertura de líneas
  // ---------------------------------------------------------------------------
  if (contexto.coberturaDeLineasCompleta === false) {
    diferencias.push(dif('EST_LINEA_NO_INTERPRETADA', 'error'));
  }
  if ((contexto.cantidadLineasNoInterpretadas ?? 0) > 0) {
    diferencias.push(dif('EST_LINEA_NO_INTERPRETADA', 'error'));
  }

  /**
   * "0 movimientos" NUNCA es éxito **para el archivo**. Un archivo que procesó bien y no trajo nada es un
   * archivo que no se leyó — y sin esta regla, el camino de menor resistencia de un parser roto es reportar
   * éxito.
   *
   * El alcance es el archivo y no la cuenta: ver `ContextoVerificacion.movimientosEnElLote`. Una cuenta
   * vacía dentro de un lote que sí trajo movimientos queda como **observación**, con lo cual el hecho sigue
   * escrito y el archivo correcto no se rechaza.
   */
  if (movimientos.length === 0) {
    const hayEnElLote = (contexto.movimientosEnElLote ?? 0) > 0;
    diferencias.push(dif('EST_SIN_MOVIMIENTOS', hayEnElLote ? 'observacion' : 'error'));
  }

  // ---------------------------------------------------------------------------
  // El tri-estado
  // ---------------------------------------------------------------------------
  const hayError = diferencias.some((d) => d.severidad === 'error');
  const algoSeVerifico = verificoTotales || verificoSaldos || puedeVerificarCadena;

  const estado: Verificacion['estado'] = hayError
    ? 'no_cuadra'
    : algoSeVerifico && movimientos.length > 0
      ? 'cuadra'
      : 'no_verificable';

  return {
    estado,
    cantidadMovimientos: movimientos.length,
    totalCreditosCalculado: centavosAImporte(creditos),
    totalDebitosCalculado: centavosAImporte(debitos),
    ...(saldoFinalCalculado === undefined ? {} : { saldoFinalCalculado }),
    verificoTotales,
    verificoSaldos,
    verificoCadena: puedeVerificarCadena,
    cadenaDeSaldosUsada: capacidades.cadenaDeSaldos,
    filasConRuptura,
    paginasConEncabezado: contexto.paginasConEncabezado ?? 0,
    paginasSinMovimientos: contexto.paginasSinMovimientos ?? 0,
    coberturaDeLineasCompleta: contexto.coberturaDeLineasCompleta ?? true,
    fechasDentroDelPeriodo,
    fechasMonotonas,
    diferencias,
  };
}

/**
 * ⛔ `habilitaPersistir` se **borró**, y el hueco que deja es a propósito.
 *
 * Decía `estado === 'cuadra' || (no_verificable && cantidadMovimientos > 0)`, o sea que era una **segunda
 * implementación** del criterio de `estadoSegunVerificacion` (`persistir.ts`) — cuyo propio comentario dice
 * que existe para que el criterio sea *"una sola cosa en un solo lugar"*.
 *
 * Con la cuenta vacía legítima de E1 las dos empezaron a contestar distinto: `estadoSegunVerificacion` dice
 * que se persiste con observaciones y ésta decía que no. No la llamaba nadie en producción —solo los
 * tests—, así que el día que un job la usara la cuenta vacía se habría comportado al revés según por dónde
 * se entrara.
 *
 * **El criterio vive en `estadoSegunVerificacion` y en ningún otro lado.** No se reintroduce acá una
 * versión "de solo lectura": necesita saber cuántos movimientos trajo el lote, y ese dato no es del
 * verificador.
 */

// -----------------------------------------------------------------------------
// INV-multicuenta — la única ecuación que cruza cuentas
// -----------------------------------------------------------------------------

export type ResultadoConsolidado = {
  /** `false` cuando el banco no publica consolidado: **no es "cuadra"**, es "no hay qué comparar". */
  readonly verificado: boolean;
  readonly diferencias: readonly Diferencia[];
};

/**
 * INV-multicuenta: el consolidado por moneda de la carátula contra la **suma de los saldos finales
 * declarados** de las cuentas de esa moneda.
 *
 * ## Por qué es del LOTE y no de la cuenta, y por qué no podía faltar
 *
 * `verificarAritmetica` corre **por cuenta**, y tiene que ser así: la cadena de saldos de una cuenta no
 * tiene nada que ver con la de otra. La consecuencia es que **toda** su aritmética cierra igual si el
 * adaptador se comió la separación de cuentas — no hay ninguna ecuación por cuenta que pueda detectarlo.
 *
 * Medido en el tercer banco (`07-formato-macro.md` §5 y §14.4-bis): mezclar sus tres cuentas produce **1
 * sola ruptura sobre 1346 filas = 0,07 %**, porque hay un único cambio de cuenta en orden de documento.
 * Pasa cualquier umbral de tolerancia que a alguien se le ocurra poner, el lote dice "casi cuadra", y lo
 * que queda persistido es **una cuenta que no existe con dos saldos encimados**.
 *
 * Esta es la única ecuación del documento que **no** cierra en ese escenario. Se corre **antes** de
 * persistir nada, y una diferencia acá rechaza el lote entero: la mezcla no se arregla borrando una fila.
 *
 * ## ⚠️ Lo que esta invariante NO puede ver, y hay que decirlo
 *
 * Compara **saldos finales declarados**, o sea que verifica el parseo de la carátula, no el reparto de los
 * movimientos. Tres huecos, encontrados por el panel:
 *
 * 1. **Una cuenta con saldo final `0,00` es invisible.** Mezclarla, duplicarla o perderla no mueve la suma.
 *    Una cuenta cerrada o vaciada en el período es el caso real, y el roster ya tiene una cuenta con saldo
 *    `0,00` (la de dólares del tercer banco).
 * 2. **No mira los movimientos.** Un reparto de filas equivocado entre dos cuentas cuyos encabezados se
 *    leyeron bien no lo toca. Eso lo agarra V3/V4 **por cuenta**, no esto.
 * 3. **No cuenta cuántas cuentas debía haber.** Si el adaptador nunca abre la sección de una cuenta con
 *    saldo `0,00`, la cuenta desaparece del sistema y todo cierra. La verificación que lo atraparía está
 *    medida y escrita —`07-formato-macro.md` §14.2: *"el par `SALDO ULTIMO` / `SALDO FINAL` (3 y 3) es la
 *    verificación de que el conteo de cuentas dio bien"*— y **todavía no existe en el código**. Anotada como
 *    `EST_CUENTAS_NO_COINCIDEN` en el plan.
 *
 * Sirve de red, no de garantía. Decirlo acá es lo que evita que alguien la tome por completa.
 *
 * ## Los cuatro modos de falla que reporta, y por qué ninguno se degrada a "no aplica"
 *
 * | `campo` | Qué pasó |
 * |---|---|
 * | *(vacío)* | la suma no da: se mezcló, se perdió o se duplicó una cuenta |
 * | `saldo_final_ausente` | una cuenta de esa moneda no trae saldo final → **la suma no se puede hacer**, y no saberlo es lo mismo que no verificar |
 * | `moneda_sin_cuenta` | el banco declara un consolidado de una moneda de la que no se leyó ninguna cuenta → **se perdió una cuenta entera** |
 * | `moneda_sin_consolidado` | se leyeron cuentas de una moneda que la carátula no consolida → o se inventó una cuenta, o el parser de la carátula perdió un renglón |
 *
 * Las cuatro son `error`. La tentación es marcar las tres últimas como observación —"faltan datos, no
 * necesariamente hay un problema"— y es justo al revés: el valor entero de esta invariante es detectar que
 * **falta una cuenta**, así que "falta el dato para compararla" no es una atenuante, es el síntoma.
 *
 * ## El banco DECLARA si lo publica, y esa declaración es lo que impide que el control se apague solo
 *
 * Cuando el banco **no** publica consolidado, `consolidados` viene vacío y el resultado es
 * `verificado: false` **sin diferencias**. Es la misma distinción que `no_verificable` hace con `cuadra`:
 * "no hay contra qué comparar" no es "comparé y dio bien".
 *
 * Pero cuando el banco **sí** lo publica y la lista llega vacía, eso **no** es "no aplica": es que el
 * parser de la carátula falló, y el resultado es `consolidado_no_encontrado` con severidad `error`. Sin
 * esa asimetría, el único control que ve una mezcla de cuentas se desactiva con un regex que no matchea —y
 * el tercer banco del roster imprime el mismo literal con dos espaciados distintos en el mismo archivo.
 *
 * Es el precedente ya establecido para los totales declarados, catorce líneas más arriba en este archivo.
 */
export function verificarConsolidadoPorMoneda(
  cuentas: readonly CuentaConMovimientos[],
  consolidados: readonly ConsolidadoPorMoneda[],
  opciones: {
    /** `capacidades.traeConsolidadoPorMoneda`. Sin esto no se distingue "no lo publica" de "no lo encontré". */
    readonly declaraConsolidado?: boolean;
  } = {},
): ResultadoConsolidado {
  if (consolidados.length === 0) {
    if (opciones.declaraConsolidado === true) {
      return {
        verificado: false,
        diferencias: [dif('EST_CONSOLIDADO_MONEDA', 'error', { campo: 'consolidado_no_encontrado' })],
      };
    }
    return { verificado: false, diferencias: [] };
  }

  const diferencias: Diferencia[] = [];
  const monedasDeclaradas = new Set<string>();

  for (const c of consolidados) {
    if (monedasDeclaradas.has(c.moneda)) {
      // Dos renglones para la misma moneda: el parser de la carátula tomó dos veces el mismo, o el banco
      // publica más de un consolidado y el modelo no lo contempla. En los dos casos hay que mirarlo.
      diferencias.push(
        dif('EST_CONSOLIDADO_MONEDA', 'error', { campo: 'consolidado_duplicado' }),
      );
      continue;
    }
    monedasDeclaradas.add(c.moneda);

    const deLaMoneda = cuentas.filter((x) => x.cuenta.moneda === c.moneda);
    if (deLaMoneda.length === 0) {
      diferencias.push(dif('EST_CONSOLIDADO_MONEDA', 'error', { campo: 'moneda_sin_cuenta' }));
      continue;
    }

    let suma = 0n;
    let sumable = true;
    for (const x of deLaMoneda) {
      const declarado = x.cuenta.saldoFinalDeclarado;
      const v = declarado === undefined ? null : cent(declarado);
      if (v === null) {
        sumable = false;
        break;
      }
      suma += v;
    }
    if (!sumable) {
      diferencias.push(dif('EST_CONSOLIDADO_MONEDA', 'error', { campo: 'saldo_final_ausente' }));
      continue;
    }

    const esperado = cent(c.importe);
    if (esperado === null) {
      // El consolidado se leyó pero no se pudo parsear. Distinto de "la suma no da", y el `campo` lo dice:
      // sin él, el operador busca una cuenta perdida cuando el problema está en el parser de la carátula.
      diferencias.push(dif('EST_CONSOLIDADO_MONEDA', 'error', { campo: 'consolidado_ilegible' }));
    } else if (esperado !== suma) {
      diferencias.push(dif('EST_CONSOLIDADO_MONEDA', 'error'));
    }
  }

  for (const moneda of new Set(cuentas.map((x) => x.cuenta.moneda))) {
    if (!monedasDeclaradas.has(moneda)) {
      diferencias.push(dif('EST_CONSOLIDADO_MONEDA', 'error', { campo: 'moneda_sin_consolidado' }));
    }
  }

  return { verificado: true, diferencias };
}

/**
 * El conteo de cuentas **declarado por el documento** contra el que el adaptador leyó.
 *
 * ## Es el único control que ve una cuenta que nunca se abrió
 *
 * Toda la demás verificación —incluida INV-multicuenta— parte de las cuentas que el adaptador **entregó**.
 * Ninguna puede ver una cuenta que **no está en esa lista**. El escenario, que el panel construyó y que es
 * verosímil con el material medido:
 *
 * > Un resumen con tres cuentas. Una de ellas está inactiva: cero movimientos, `SALDO ULTIMO = SALDO FINAL
 * > = 0,00`. El adaptador **nunca abre su sección** —su encabezado cayó en una página donde el regex no
 * > matcheó, y ese archivo ya tiene medido el mismo literal con dos espaciados distintos—.
 *
 * Qué pasa con cada red: la cadena de saldos cierra (las otras cuentas están intactas) · V3/V4 cierran ·
 * `EST_SIN_MOVIMIENTOS` **no dispara** porque la cuenta no existe, no está vacía · INV-multicuenta
 * **cuadra**, porque `Σ saldos finales + 0,00 = consolidado`. **Lote `procesado`, y una cuenta bancaria
 * entera del cliente desaparecida del sistema, sin pasar nunca por INV-6 y sin dejar rastro.**
 *
 * ## De dónde sale el número declarado
 *
 * **No de contar las secciones** —eso sería preguntarle al adaptador lo mismo dos veces, que es el
 * autocertificado que el contrato prohíbe—. Sale de un **literal distinto del documento**, contado aparte:
 * en el banco medido, los pares `SALDO ULTIMO EXTRACTO AL` y `SALDO FINAL AL DIA` aparecen **3 y 3 para 3
 * cuentas** (`07-formato-macro.md` §14.2, que lo nombra explícitamente como *"la verificación de que el
 * conteo de cuentas dio bien"*).
 *
 * Un banco que no publique nada equivalente devuelve `undefined` y el control no corre — y eso **se
 * declara**, no se degrada a "cuadra".
 */
export function verificarConteoDeCuentas(
  cuentasLeidas: number,
  cuentasDeclaradas: number | undefined,
): readonly Diferencia[] {
  if (cuentasDeclaradas === undefined) return [];
  if (cuentasLeidas === cuentasDeclaradas) return [];
  // Sin `campo`: el código ya lo dice todo, y los dos números **no** se publican — decir "leí 2 de 3"
  // no agrega nada que el operador no vea abriendo el archivo, y el diagnóstico no es canal de fuga.
  return [dif('EST_CUENTAS_NO_COINCIDEN', 'error')];
}
