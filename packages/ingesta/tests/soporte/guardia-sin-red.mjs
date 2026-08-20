/**
 * Guardia de red para el test de `ocr.ts` que corre con la red efectivamente cortada.
 *
 * No es un mock de `tesseract.js`: es un preload de proceso (`node --import`) que reemplaza
 * `globalThis.fetch` por una función que **lanza** si alguien la invoca. `--import`/`NODE_OPTIONS`
 * llegan también a los `worker_threads.Worker` que `tesseract.js` abre en Node (verificado antes de
 * escribir este archivo: un `Worker` hijo hereda el preload del proceso), así que esto corta la red en
 * el mismo hilo donde vive el riesgo real — el worker que carga el idioma — y no solo en el hilo
 * principal, donde parchear `fetch` no demostraría nada.
 *
 * Sintético por completo: no hay ningún dato de cliente en este archivo.
 */
globalThis.fetch = async (...args) => {
  throw new Error(`RED_CORTADA_EN_TEST: intento de red hacia ${String(args[0])}`);
};
