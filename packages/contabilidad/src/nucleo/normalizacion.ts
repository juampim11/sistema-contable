import { normalizar } from '@sistema-contable/shared/texto';

/**
 * La normalización del LÉXICO (`05-motor-de-reconocimiento.md` §3.1). Es una capa ENCIMA de
 * `normalizar()`, y es una función DISTINTA a propósito: `normalizar()` alimenta `fila_hash`, que es la
 * IDENTIDAD de una fila ingerida, y agregarle un paso reescribiría el hash de todo lo ya ingestado.
 *
 * 🔴 Esta función NUNCA se usa para hashear filas — solo para comparar literales de léxico entre sí.
 *
 * Los cuatro pasos de `05` §3.1, en orden:
 * 0. `normalizar()`: NFD, sin diacríticos, espacios colapsados, MAYÚSCULAS.
 * 1. Puntuación de abreviatura (`.`, `-`, `/`) → espacio, y re-colapso. Es lo único que une
 *    `IMP. DEB. LEY 25413 GRAL.` con `IMPUESTO DEB.LEY 25413`.
 * 2. Los DÍGITOS SE CONSERVAN: `25413` es lo que distingue el impuesto de cualquier otra cosa.
 * 3. Sin stemming, sin stopwords, sin distancia de edición — un error de clasificación no puede
 *    convertirse en un misterio. Dos literales del banco que son el mismo concepto se ENUMERAN los
 *    dos (`EntradaLexico.literales`), nunca se infieren por similitud.
 * 4. Los marcadores `[CUIT]`/`[CBU]`/`[DOC]` SOBREVIVEN (los corchetes no están en la clase del paso 1)
 *    pero están PROHIBIDOS como evidencia — lo hace cumplir PROP-7, no una convención en prosa.
 *
 * 🔴 Los `:` NO están en la lista del paso 1, a propósito: si entraran, `TRANSF:` (Macro, 78 mov.) y
 * `TRANSF ` (409 mov.) colapsarían a la misma cadena y el ancla auto-delimitante de Macro se
 * destruiría (`macro.ts:506-529`).
 */
export function normalizarParaLexico(texto: string): string {
  return normalizar(texto)
    .replace(/[.\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
