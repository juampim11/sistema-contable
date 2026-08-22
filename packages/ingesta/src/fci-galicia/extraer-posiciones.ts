/**
 * Extractor PRELIMINAR de posiciones de FCI desde el extracto de Galicia (layout confirmado por
 * metadatos + precisiones explícitas del titular: la semántica de columnas de la tabla de posición,
 * y el patrón literal del encabezado de sección — E-2, `docs/seguridad/registro-excepciones.md`).
 * NO es el adapter oficial de ingesta (sin `contrato.ts`/`esquema.ts`/`persistir.ts` como
 * Galicia/Santander/Macro): es la pieza mínima para verificar el eje 1, y queda marcado como tal a
 * propósito.
 *
 * **Atribución por fondo: CONFIRMADA.** Julio y agosto (los dos cortes con corte previo en el lote)
 * cierran EXACTO en los 3 fondos con esta segmentación — ver `docs/diseno/17-fci-peps-plan.md` §6.
 *
 * ## Layout confirmado
 *
 * La tabla de posición ("Posición al DD/MM/YYYY") trae, por fondo, UNA sola fila con 4 fragmentos:
 * `[nombre] [tenencia en cuotas, ~2 decimales] [cotización/valor cuota, ~6 decimales] [saldo
 * valorizado en pesos = tenencia × cotización, ~2 decimales con miles]`. Solo el segundo campo
 * (tenencia) participa del eje 1 — el tercero es un importe derivado, no una cantidad.
 *
 * Debajo, el documento trae un bloque de movimientos **por fondo**, delimitado por una línea con el
 * patrón LITERAL `FONDO - <nombre> CLASE <letra>` — texto de plantilla del banco, igual en cualquier
 * extracto de este tipo, confirmado por el titular como NO siendo dato de cliente. Debajo de esa
 * línea viene la cabecera de columnas repetida (Fecha de concertación / Descripción / Cantidad de
 * Cuotas / Valor / Monto Neto de la Operación / Fecha de Liquidación), y recién ahí las filas de
 * movimiento de ESE fondo, hasta la siguiente línea `FONDO - ... CLASE ...` o el fin del documento.
 * Cada movimiento trae 6 fragmentos: `[fecha] [SUSCRIPCIÓN|RESCATE] [cantidad, ~2 decimales]
 * [precio, ~6 decimales, ignorado — no participa del eje 1] [importe $, ignorado] [fecha de
 * liquidación]`.
 *
 * 🔴 **El orden de los bloques NO alcanza para unirlos con la tabla de posición**: un fondo sin
 * ningún movimiento en el corte simplemente NO imprime su bloque (confirmado contra los 3 PDF reales
 * por conteo de coincidencias del patrón — julio tiene solo 1 encabezado, junio y agosto tienen 3),
 * así que "el N-ésimo bloque es del N-ésimo fondo" se rompe apenas un fondo queda inactivo.
 *
 * 🔴 **La unión es por NOMBRE, y NO por igualdad exacta.** El nombre capturado en el encabezado de
 * bloque (`FONDO - <nombre> CLASE <letra>`) es una versión ABREVIADA del nombre de la tabla de
 * posición — confirmado por metadatos: en los 3 PDF reales, el nombre del encabezado mide ~12
 * caracteres contra ~20-25 del nombre de la tabla. Se unen por "uno contiene al otro" (en cualquier
 * dirección) sobre las claves normalizadas — nunca por igualdad estricta, que falla siempre. El
 * nombre se usa SOLO como clave interna de unión, nunca se expone fuera de este módulo.
 *
 * ## El invariante se verifica ENTRE documentos, no dentro de uno solo
 *
 * Cada PDF trae la tenencia declarada A ESE CORTE, no un "saldo anterior" propio. El `saldoInicial`
 * de un corte es la `tenenciaDeclarada` del MISMO fondo en el corte INMEDIATO ANTERIOR — encadenar
 * cortes consecutivos es responsabilidad de quien llama (ver el script de verificación), no de este
 * extractor.
 *
 * ## Historial: dos intentos previos de segmentación, descartados antes de llegar a este
 *
 * 1. Reconocer el encabezado por forma genérica (fragmentos sin fecha/número/palabra clave) —
 *    produjo una regresión real (julio dejó de cerrar) y se descartó.
 * 2. El patrón literal `FONDO - ... CLASE ...`, pero unido por IGUALDAD EXACTA de nombre — 0
 *    movimientos atribuidos en los 3 cortes, porque el nombre del encabezado es abreviado.
 *
 * El fix (unión por "contiene", ver arriba) es el que cierra julio y agosto exacto en los 3 fondos.
 */

import { aFilas, textoDeFila } from '../texto-pdf.ts';
import { normalizarTokenNumerico, parsearFecha, type Periodo } from '../parseo-ar.ts';

const RE_FECHA = /^\d{1,2}[/\-]\d{1,2}(?:[/\-]\d{2,4})?$/;
const RE_NUMERO_AR = /^-?\d{1,3}(?:\.\d{3})*,(\d{1,6})$/;

/**
 * Texto de plantilla del banco (confirmado por el titular: NO es dato de cliente, es igual en
 * cualquier extracto de este tipo) que delimita el bloque de movimientos de un fondo. El grupo 1
 * captura el nombre TAL COMO aparece en la tabla de posición — se usa solo como clave interna de
 * unión (ver `extraerPosicionesFci`), nunca se expone.
 */
const RE_ENCABEZADO_FONDO = /FONDO\s*-\s*(.+?)\s*CLASE\s+[A-Z]/i;

function sinPrefijoDeMoneda(texto: string): string {
  return texto.replace(/^-?\s*(?:U\$S|\$)\s*/, (coincidencia) =>
    coincidencia.startsWith('-') ? '-' : '',
  );
}

/**
 * 🔴 `normalizarTokenNumerico` (`parseo-ar.ts`) ANTES de clasificar o convertir — hallazgo de
 * `code-reviewer`: los extractores de PDF (el mismo `unpdf`/`pdf.js` que usa este archivo, vía
 * `texto-pdf.ts`) producen menos tipográfico (`−`, U+2212), guion largo y espacio duro donde el
 * documento tenía un `-` ASCII o un separador de miles — sin normalizar, esas variantes no matchean
 * `RE_NUMERO_AR`/`RE_FECHA` y la fila se descarta en silencio, el mismo modo de falla que
 * `parseo-ar.ts` ya documenta y que los adapters bancarios oficiales evitan por este mismo paso.
 */
function decimalesDe(texto: string): number | null {
  const m = RE_NUMERO_AR.exec(sinPrefijoDeMoneda(normalizarTokenNumerico(texto)));
  return m?.[1] ? m[1].length : null;
}

/** AR (`"1.234,56"`, con o sin prefijo de moneda) a decimal canónico (`"1234.56"`). Nunca trunca. */
function aTextoCanonico(texto: string): string {
  const sinMoneda = sinPrefijoDeMoneda(normalizarTokenNumerico(texto));
  return sinMoneda.replace(/\./g, '').replace(',', '.');
}

type FragmentoClasificado = {
  readonly x: number;
  readonly decimales: number | null;
  readonly esFecha: boolean;
  readonly esTipoMovimiento: 'suscripcion' | 'rescate' | null;
  readonly texto: string;
};

type FilaClasificada = {
  readonly pagina: number;
  readonly fragmentos: readonly FragmentoClasificado[];
  /** Texto de la fila completa, unido — SOLO para testear `RE_ENCABEZADO_FONDO` (plantilla del
   *  banco, no dato de cliente); nunca se expone fuera de este módulo. */
  readonly textoDeLaFila: string;
};

async function filasClasificadas(bytes: Uint8Array): Promise<FilaClasificada[]> {
  const filas = await aFilas(bytes);
  return filas.map((fila) => ({
    pagina: fila.pagina,
    textoDeLaFila: textoDeFila(fila),
    fragmentos: fila.fragmentos.map(
      (f): FragmentoClasificado => ({
        x: f.x,
        decimales: decimalesDe(f.texto),
        esFecha: RE_FECHA.test(normalizarTokenNumerico(f.texto)),
        esTipoMovimiento: /SUSCRIP/i.test(f.texto)
          ? 'suscripcion'
          : /RESCATE/i.test(f.texto)
            ? 'rescate'
            : null,
        texto: f.texto,
      }),
    ),
  }));
}

/** `nombreInterno`: SOLO para unir con el bloque de movimientos (por "contiene", no igualdad) — nunca sale. */
type FilaPosicion = { readonly nombreInterno: string; readonly tenenciaTexto: string };
type FilaMovimiento = {
  readonly tipo: 'suscripcion' | 'rescate';
  readonly cantidadTexto: string;
  /** Cotización de la cuotaparte en esa operación — necesaria para armar capas de costo PEPS. */
  readonly precioTexto: string;
  /** Fecha de concertación, tal como viene en el documento (dd/mm u dd/mm/aaaa) — sin resolver a
   *  ISO todavía: eso necesita el período del corte, que esta fila no conoce por sí sola. */
  readonly fechaCrudaTexto: string;
};

/**
 * `[nombre] [tenencia, ~2dec] [cotización, ~6dec, ignorada] [valorizado $, ignorado]`.
 *
 * 🔴 Los rangos de `x` de abajo (370-410, 440-470, 510-535) están MEDIDOS contra los 3 PDF reales de
 * este cliente (los únicos 3 cortes que existen hoy), no son arbitrarios ni una convención publicada
 * por Galicia. Un extracto futuro con un layout distinto simplemente no matchea nada — 0 filas
 * reconocidas, en silencio, no un error — porque este extractor es preliminar (ver el comentario del
 * módulo) y no tiene todavía ningún caller que verifique ese conteo. Quien integre este extractor a
 * un caller real tiene que agregar esa verificación ahí, no asumir que ya existe.
 */
function comoFilaPosicion(fragmentos: readonly FragmentoClasificado[]): FilaPosicion | null {
  if (fragmentos.length !== 4) return null;
  const [nombre, tenencia, cotizacion, valorizado] = fragmentos;
  if (!nombre || !tenencia || !cotizacion || !valorizado) return null;
  if (tenencia.decimales === null || cotizacion.decimales === null || valorizado.decimales === null) {
    return null;
  }
  if (nombre.x >= 50) return null;
  if (tenencia.x < 370 || tenencia.x > 410) return null;
  if (cotizacion.x < 440 || cotizacion.x > 470) return null;
  if (valorizado.x < 510 || valorizado.x > 535) return null;
  return { nombreInterno: nombre.texto, tenenciaTexto: aTextoCanonico(tenencia.texto) };
}

/**
 * 🔴 El signo de `cantidadTexto` NO se controla acá — depende de `aritmetica-posicion.ts`
 * (`aCantidadEscalada`, en el módulo que consume este resultado) para rechazar un valor negativo con
 * `CantidadPosicionInvalidaError`. Es una dependencia implícita entre los dos módulos, a propósito
 * (hallazgo de `code-reviewer`): este extractor no sabe si un signo negativo acá es un error de
 * extracción o un caso de negocio real, y prefiere fallar alto (una excepción, no un dato corrupto)
 * en el módulo que sí conoce la regla de dominio ("las cantidades de FCI nunca son negativas").
 */
function comoFilaMovimiento(fragmentos: readonly FragmentoClasificado[]): FilaMovimiento | null {
  if (fragmentos.length !== 6) return null;
  const [fecha1, tipo, cantidad, precio, , fecha2] = fragmentos;
  if (!fecha1?.esFecha || !fecha2?.esFecha) return null;
  if (!tipo?.esTipoMovimiento) return null;
  if (!cantidad || cantidad.decimales === null) return null;
  if (cantidad.x < 285 || cantidad.x > 310) return null;
  // 🔴 Rango de `x` para el precio (hallazgo de `code-reviewer`: faltaba, a diferencia de `cantidad`)
  // — medido igual que el resto: ~375 en los 3 PDF reales.
  if (!precio || precio.decimales === null) return null;
  if (precio.x < 365 || precio.x > 390) return null;
  return {
    tipo: tipo.esTipoMovimiento,
    cantidadTexto: aTextoCanonico(cantidad.texto),
    precioTexto: aTextoCanonico(precio.texto),
    fechaCrudaTexto: fecha1.texto,
  };
}

/** Un movimiento ya resuelto: cantidad y precio canónicos, fecha en ISO, EN ORDEN de documento. */
export type MovimientoFci = {
  readonly tipo: 'suscripcion' | 'rescate';
  readonly cantidad: string;
  readonly precio: string;
  readonly fecha: string;
};

export type FondoExtraido = {
  /** Rótulo opaco, `fondo_N` en el orden de la tabla de posición — nunca el nombre real. */
  readonly fondo: string;
  readonly tenenciaDeclarada: string;
  /**
   * En ORDEN de documento, validado monótono no decreciente por `fecha` (ver `movimientosConfiables`
   * si no lo es). Necesario para armar capas de costo PEPS
   * (`packages/fci/src/nucleo/consumirRescate.ts`), que a su vez EXIGE ese orden y rechaza si no lo
   * está — un orden equivocado acá produciría un costo PEPS invertido en silencio antes de llegar
   * siquiera a ese guard, porque este campo alimenta la simulación completa, no una sola llamada.
   */
  readonly movimientos: readonly MovimientoFci[];
  /**
   * 🔴 `false` si alguna fecha de este fondo no se pudo resolver contra el `periodo`, o si el orden
   * resultante no es monótono — en cualquiera de los dos casos, `movimientos` queda VACÍO (nunca un
   * orden parcial o dudoso) y esta bandera es la única señal de que pasó. Aislado por fondo a
   * propósito (hallazgo de `code-reviewer`): un problema de fecha en UN fondo no debe tumbar el
   * cálculo de `suscripciones`/`rescates` — el eje 1 — de los otros fondos, ni el propio, que no
   * depende de fecha en absoluto.
   */
  readonly movimientosConfiables: boolean;
  /** Agregados de cantidad — para el eje 1 (`verificar-posicion.ts`). Se calculan DIRECTO de las
   *  filas crudas, nunca a través de `movimientos`: no dependen de que la fecha resuelva bien. */
  readonly suscripciones: readonly string[];
  readonly rescates: readonly string[];
};

/** El orden de `movimientos`, resuelto por fecha, no resultó monótono no decreciente — nunca se
 *  reordena en silencio (eso sería inventar una secuencia); se descarta el campo entero para ese
 *  fondo y se marca `movimientosConfiables: false`. */
export class OrdenMovimientoInvalidoError extends Error {
  constructor() {
    super('El orden de los movimientos, resuelto por fecha, no es monótono no decreciente.');
    this.name = 'OrdenMovimientoInvalidoError';
  }
}

export type ExtraccionPosicionFci = {
  readonly fondos: readonly FondoExtraido[];
};

/**
 * Más de un bloque de movimientos matcheó el nombre de un mismo fondo de la tabla de posición (dos
 * fondos con un prefijo de familia de producto en común, por ejemplo). Nunca se resuelve quedándose
 * con el primero en silencio — mismo criterio que el resto de este extractor.
 */
export class AtribucionFondoAmbiguaError extends Error {
  constructor() {
    super('Más de un bloque de movimientos matchea el nombre de un fondo — atribución ambigua.');
    this.name = 'AtribucionFondoAmbiguaError';
  }
}

/**
 * La fecha de un movimiento no se pudo resolver contra el `periodo` del corte — nunca se adivina
 * (mismo criterio que `parsearFecha` en `parseo-ar.ts`: una fecha fuera de período es una fila mal
 * capturada, no algo para forzar).
 */
export class FechaMovimientoInvalidaError extends Error {
  constructor() {
    super('La fecha de un movimiento no se pudo resolver contra el período del corte.');
    this.name = 'FechaMovimientoInvalidaError';
  }
}

/** Normaliza una clave interna de unión (espacios, mayúsculas) — nunca se expone el resultado. */
function normalizarClave(texto: string): string {
  return texto.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * `periodo`: rango del corte (p. ej. `{ desde: '2025-07-01', hasta: '2025-07-31' }`), para resolver
 * la fecha cruda de cada movimiento (que puede venir sin año) a ISO — mismo mecanismo que
 * `parsearFecha` de `parseo-ar.ts` ya usan los adapters bancarios oficiales.
 */
export async function extraerPosicionesFci(
  bytes: Uint8Array,
  periodo: Periodo,
): Promise<ExtraccionPosicionFci> {
  const filas = await filasClasificadas(bytes);

  const posiciones: FilaPosicion[] = [];
  // Un grupo por CLAVE distinta de bloque `FONDO - ... CLASE ...` encontrada. Un fondo sin ningún
  // movimiento en el corte no imprime bloque — por eso se une por NOMBRE, no por orden (ver
  // comentario del módulo). La clave nunca se expone fuera de este módulo.
  //
  // 🔴 Se FUSIONA por clave EXACTA (hallazgo de `code-reviewer`): si el mismo bloque se repite por un
  // salto de página interno del documento (mismo fondo, cabecera reimpresa), un `push` incondicional
  // crearía un segundo grupo y los movimientos de la continuación quedarían huérfanos — nunca
  // recuperables desde `movimientosDe`, que busca un solo grupo por fondo.
  const grupos: { clave: string; movimientos: FilaMovimiento[] }[] = [];
  let claveActual: string | null = null;

  for (const fila of filas) {
    const posicion = comoFilaPosicion(fila.fragmentos);
    if (posicion) {
      posiciones.push(posicion);
      continue;
    }

    const encabezado = RE_ENCABEZADO_FONDO.exec(fila.textoDeLaFila);
    if (encabezado?.[1]) {
      claveActual = normalizarClave(encabezado[1]);
      if (!grupos.some((g) => g.clave === claveActual)) grupos.push({ clave: claveActual, movimientos: [] });
      continue;
    }

    const movimiento = comoFilaMovimiento(fila.fragmentos);
    if (movimiento && claveActual !== null) {
      // Se busca por CLAVE (no por posición en el array) para que, tras la fusión de arriba, un
      // bloque continuado (mismo fondo, cabecera reimpresa) siga acumulando en el mismo grupo que
      // su primera aparición, no en uno creado al final.
      grupos.find((g) => g.clave === claveActual)?.movimientos.push(movimiento);
    }
  }

  /**
   * 🔴 El nombre del encabezado de bloque es una versión ABREVIADA del nombre de la tabla de
   * posición (confirmado por metadatos: longitudes de 12 caracteres contra 20-25 en los 3 PDF
   * reales) — no coinciden por igualdad exacta. Se unen por "uno contiene al otro", en cualquier
   * dirección, sobre las claves normalizadas (nunca expuestas).
   *
   * 🔴 Ambigüedad: si MÁS DE UN grupo matchea (hallazgo de `code-reviewer` — dos fondos con un
   * prefijo de familia de producto en común podrían coincidir), esta función RECHAZA en vez de
   * quedarse con el primero en silencio — mismo criterio que ya aplica el resto del extractor
   * ("fallar alto, nunca un dato corrupto").
   */
  function movimientosDe(nombreDePosicion: string): FilaMovimiento[] {
    const clavePosicion = normalizarClave(nombreDePosicion);
    const candidatos = grupos.filter(
      (g) => clavePosicion.includes(g.clave) || g.clave.includes(clavePosicion),
    );
    if (candidatos.length > 1) {
      throw new AtribucionFondoAmbiguaError();
    }
    return candidatos[0]?.movimientos ?? [];
  }

  const fondos: FondoExtraido[] = posiciones.map((posicion, indice) => {
    const crudos = movimientosDe(posicion.nombreInterno);

    // Agregados de cantidad — el eje 1 — directo de las filas crudas, SIN pasar por la resolución
    // de fecha: un problema de fecha en este fondo (o en otro) nunca debe tumbar este cálculo, que
    // ya está confirmado exacto contra los 3 PDF reales (docs/diseno/17-fci-peps-plan.md §6).
    const suscripciones = crudos.filter((m) => m.tipo === 'suscripcion').map((m) => m.cantidadTexto);
    const rescates = crudos.filter((m) => m.tipo === 'rescate').map((m) => m.cantidadTexto);

    // `movimientos` (para la simulación PEPS) SÍ depende de la fecha, y se aísla por fondo: si la
    // resolución falla o el orden resultante no es monótono, este fondo queda con `movimientos: []`
    // y `movimientosConfiables: false` — nunca un orden parcial o dudoso, y nunca afecta a los otros
    // fondos ni a los agregados de este mismo fondo (ver arriba).
    let movimientos: MovimientoFci[] = [];
    let movimientosConfiables = true;
    try {
      movimientos = crudos.map((m) => {
        const fecha = parsearFecha(m.fechaCrudaTexto, periodo);
        if (fecha === null) throw new FechaMovimientoInvalidaError();
        return { tipo: m.tipo, cantidad: m.cantidadTexto, precio: m.precioTexto, fecha };
      });
      for (let i = 1; i < movimientos.length; i += 1) {
        if (movimientos[i]!.fecha < movimientos[i - 1]!.fecha) throw new OrdenMovimientoInvalidoError();
      }
    } catch (error) {
      if (!(error instanceof FechaMovimientoInvalidaError) && !(error instanceof OrdenMovimientoInvalidoError)) {
        throw error;
      }
      movimientos = [];
      movimientosConfiables = false;
    }

    return {
      fondo: `fondo_${indice + 1}`,
      tenenciaDeclarada: posicion.tenenciaTexto,
      movimientos,
      movimientosConfiables,
      suscripciones,
      rescates,
    };
  });

  return { fondos };
}
