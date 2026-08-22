/**
 * Extractor PRELIMINAR de posiciones de FCI desde el extracto de Galicia (layout confirmado por
 * metadatos + una corrección explícita del titular sobre la semántica de columnas — E-2,
 * `docs/seguridad/registro-excepciones.md`). NO es el adapter oficial de ingesta (sin
 * `contrato.ts`/`esquema.ts`/`persistir.ts` como Galicia/Santander/Macro): es la pieza mínima para
 * verificar el eje 1, y queda marcado como tal a propósito.
 *
 * ## Layout confirmado
 *
 * La tabla de posición ("Posición al DD/MM/YYYY") trae, por fondo, UNA sola fila con 4 fragmentos:
 * `[nombre] [tenencia en cuotas, ~2 decimales] [cotización/valor cuota, ~6 decimales] [saldo
 * valorizado en pesos = tenencia × cotización, ~2 decimales con miles]`. Solo el segundo campo
 * (tenencia) participa del eje 1 — el tercero es un importe derivado, no una cantidad (corrección
 * explícita del titular: la hipótesis inicial de este extractor comparaba una cantidad de
 * cuotapartes contra un importe en pesos).
 *
 * Debajo, bloques de movimiento con 6 fragmentos:
 * `[fecha] [SUSCRIPCIÓN|RESCATE] [cantidad, ~2 decimales] [precio, ~6 decimales, ignorado]
 * [importe $, ignorado] [fecha de liquidación]`.
 *
 * ## El invariante se verifica ENTRE documentos, no dentro de uno solo
 *
 * Cada PDF trae la tenencia declarada A ESE CORTE, no un "saldo anterior" propio. El `saldoInicial`
 * de un corte es la `tenenciaDeclarada` del MISMO fondo en el corte INMEDIATO ANTERIOR — encadenar
 * cortes consecutivos es responsabilidad de quien llama (ver el script de verificación), no de este
 * extractor.
 *
 * ## Atribución de movimientos a fondo — DESCARTADA, no resuelta, y por qué
 *
 * Se intentó reconocer una fila de encabezado de sección que delimitara el bloque de movimientos de
 * cada fondo (indicación del titular: el documento viene segmentado así). La implementación produjo
 * una REGRESIÓN real contra un caso ya validado (julio, que cerraba exacto en los 3 fondos con el
 * método de eliminación, dejó de cerrar en 2 de los 3 con la segmentación) y capturó solo 4 de ~21
 * movimientos reales en agosto — evidencia de que la indicación, sin ver el documento, no alcanzó
 * para reconstruir el patrón exacto (desalineamiento de orden entre la tabla resumen y los bloques de
 * detalle, o encabezados no reconocidos). **Descartado a pedido del titular**: no es scope creep de
 * esta tarea seguir afinándolo a ciegas — si hace falta atribución por fondo confiable para el
 * adapter oficial, es una tarea aparte que necesita revisar el documento con quien sí puede verlo.
 *
 * Este extractor, por lo tanto, NO atribuye movimientos a un fondo — devuelve, por fondo (en el orden
 * de la tabla de posición), su tenencia declarada, y aparte, TODOS los movimientos del corte sin
 * asignar. Quien llama decide cómo repartirlos (ver el script de verificación: por eliminación,
 * cuando exactamente un fondo cambió de tenencia respecto del corte anterior).
 */

import { aFilas } from '../texto-pdf.ts';
import { normalizarTokenNumerico } from '../parseo-ar.ts';

const RE_FECHA = /^\d{1,2}[/\-]\d{1,2}(?:[/\-]\d{2,4})?$/;
const RE_NUMERO_AR = /^-?\d{1,3}(?:\.\d{3})*,(\d{1,6})$/;

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

async function filasClasificadas(bytes: Uint8Array) {
  const filas = await aFilas(bytes);
  return filas.map((fila) => ({
    pagina: fila.pagina,
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

type FilaPosicion = { readonly tenenciaTexto: string };
type FilaMovimiento = { readonly tipo: 'suscripcion' | 'rescate'; readonly cantidadTexto: string };

/**
 * `[nombre] [tenencia, ~2dec] [cotización, ~6dec, ignorada] [valorizado $, ignorado]`.
 *
 * 🔴 Los rangos de `x` de abajo (370-410, 440-470, 510-535) están MEDIDOS contra los 3 PDF reales de
 * este cliente (los únicos 3 cortes que existen hoy), no son arbitrarios ni una convención publicada
 * por Galicia. Un extracto futuro con un layout distinto simplemente no matchea nada — 0 filas
 * reconocidas, en silencio, no un error — porque este extractor es preliminar (ver el comentario del
 * módulo) y no tiene todavía ningún caller que verifique ese conteo (confirmado por `code-reviewer`:
 * sin invocador en el repo aún). Quien integre este extractor a un caller real tiene que agregar esa
 * verificación ahí, no asumir que ya existe.
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
  return { tenenciaTexto: aTextoCanonico(tenencia.texto) };
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
  const [fecha1, tipo, cantidad, , , fecha2] = fragmentos;
  if (!fecha1?.esFecha || !fecha2?.esFecha) return null;
  if (!tipo?.esTipoMovimiento) return null;
  if (!cantidad || cantidad.decimales === null) return null;
  if (cantidad.x < 285 || cantidad.x > 310) return null;
  return { tipo: tipo.esTipoMovimiento, cantidadTexto: aTextoCanonico(cantidad.texto) };
}

export type ExtraccionPosicionFci = {
  /** Tenencia declarada por fondo, en orden de aparición en el documento — NUNCA el nombre real. */
  readonly tenenciasPorFondo: readonly string[];
  /** Todos los movimientos del corte, SIN atribuir a un fondo (ver comentario del módulo). */
  readonly suscripciones: readonly string[];
  readonly rescates: readonly string[];
};

export async function extraerPosicionesFci(bytes: Uint8Array): Promise<ExtraccionPosicionFci> {
  const filas = await filasClasificadas(bytes);

  const posiciones: FilaPosicion[] = [];
  const movimientos: FilaMovimiento[] = [];

  for (const fila of filas) {
    const posicion = comoFilaPosicion(fila.fragmentos);
    if (posicion) {
      posiciones.push(posicion);
      continue;
    }
    const movimiento = comoFilaMovimiento(fila.fragmentos);
    if (movimiento) movimientos.push(movimiento);
  }

  return {
    tenenciasPorFondo: posiciones.map((p) => p.tenenciaTexto),
    suscripciones: movimientos.filter((m) => m.tipo === 'suscripcion').map((m) => m.cantidadTexto),
    rescates: movimientos.filter((m) => m.tipo === 'rescate').map((m) => m.cantidadTexto),
  };
}
