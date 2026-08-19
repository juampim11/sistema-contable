/**
 * Punto de entrada del subárbol de liquidaciones: `@sistema-contable/ingesta/liquidaciones`.
 *
 * 🔴 **Sub-entrypoint propio y NO `export *` desde el índice raíz del paquete**, a propósito.
 *
 * El índice raíz ya documenta el modo de falla: dos `export *` que exportan el mismo nombre **no fallan**
 * en ESM, **omiten el símbolo ambiguo en silencio**, sin un solo error de tipos. Y la superposición acá
 * sería real y grande —`ESTADOS_VERIFICACION`, `limpiarRegistro`, `capacidadesAdaptadorSchema`,
 * `lineaNoInterpretadaSchema` y una docena más—: el vocabulario de liquidaciones es estructuralmente
 * paralelo al de extractos, que es exactamente la condición que produce el choque.
 *
 * Un sub-entrypoint lo hace imposible por construcción, es el mismo mecanismo que ya usa
 * `@sistema-contable/shared` (`/observabilidad`, `/seguridad`, `/texto`), y de yapa deja el aislamiento
 * de R-M visible en el path de cada import.
 */
export * from './contrato.ts';
export * from './esquema.ts';
export * from './registro.ts';
