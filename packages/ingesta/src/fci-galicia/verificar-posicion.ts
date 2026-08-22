/**
 * Verificación del eje 1 (invariante de cantidades) de una posición de FCI, por fondo.
 *
 * Mismo principio que `verificarAritmetica` (`packages/ingesta/src/verificacion/invariantes.ts`):
 * esta función CALCULA el veredicto comparando contra lo que **declara el documento**
 * (`tenenciaFinalDeclarada`), nunca contra sí misma. `saldoInicialDeclarado`, `suscripciones` y
 * `rescates` ya vienen extraídos — este archivo no toca ningún PDF.
 *
 * 🔴 Regla dura de seguridad de datos, no de diseño (`docs/seguridad/registro-excepciones.md`, E-2):
 * el resultado NUNCA lleva el delta exacto, ni el valor calculado, ni la tenencia declarada — el
 * sistema procesa cantidades reales de un cliente fuera del piloto, sin tenant, bajo un método
 * reforzado que exige reportar solo un booleano y, si no cierra, una categoría acotada del delta.
 */

import {
  aCantidadEscalada,
  diferenciaAbsoluta,
  FACTOR_CANTIDAD_POSICION,
  sumarCantidades,
} from './aritmetica-posicion.ts';

export type PosicionFondo = {
  readonly fondo: string;
  /**
   * Fecha ISO del corte del extracto (`2025-06-30`, `2025-07-31`, `2025-08-29`, etc.). E-2 exige
   * reportar `cierra` **por fondo Y corte** (`docs/seguridad/registro-excepciones.md`) — un mismo
   * fondo se verifica una vez por cada corte, y sin este campo dos resultados del mismo fondo en
   * cortes distintos no se podrían distinguir al agregarlos (hallazgo de `seguridad-datos-financieros`
   * sobre la primera versión de este tipo).
   */
  readonly corte: string;
  /** Cantidad de cuotapartes, string decimal SIN SIGNO, hasta 6 decimales. */
  readonly saldoInicialDeclarado: string;
  readonly suscripciones: readonly string[];
  readonly rescates: readonly string[];
  readonly tenenciaFinalDeclarada: string;
};

export type CategoriaDelta = '<0.01' | '0.01-1' | '>1';

export type ResultadoVerificacionPosicion = {
  readonly fondo: string;
  readonly corte: string;
  readonly cierra: boolean;
  /** Presente SOLO si `cierra === false`. Nunca el delta exacto. */
  readonly categoriaDelta?: CategoriaDelta;
};

const UMBRAL_0_01 = FACTOR_CANTIDAD_POSICION / 100n;
const UMBRAL_1 = FACTOR_CANTIDAD_POSICION;

function categorizar(deltaAbsoluto: bigint): CategoriaDelta {
  if (deltaAbsoluto < UMBRAL_0_01) return '<0.01';
  if (deltaAbsoluto <= UMBRAL_1) return '0.01-1';
  return '>1';
}

/**
 * `saldoInicial + Σsuscripciones − Σrescates` contra `tenenciaFinalDeclarada`, tolerancia CERO
 * (comparación exacta de enteros escalados, nunca aproximada).
 */
export function verificarPosicionFondo(posicion: PosicionFondo): ResultadoVerificacionPosicion {
  const inicial = aCantidadEscalada(posicion.saldoInicialDeclarado);
  const suscripto = sumarCantidades(posicion.suscripciones);
  const rescatado = sumarCantidades(posicion.rescates);
  const declarada = aCantidadEscalada(posicion.tenenciaFinalDeclarada);

  const calculado = inicial + suscripto - rescatado;

  if (calculado === declarada) {
    return { fondo: posicion.fondo, corte: posicion.corte, cierra: true };
  }

  return {
    fondo: posicion.fondo,
    corte: posicion.corte,
    cierra: false,
    categoriaDelta: categorizar(diferenciaAbsoluta(calculado, declarada)),
  };
}
