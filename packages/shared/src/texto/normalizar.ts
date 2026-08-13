/**
 * Normaliza texto para comparar: sin acentos, sin espacios repetidos, mayúsculas.
 *
 * Se usa para el `fila_hash` y para el cruce PDF↔Excel. **Conserva el marcador de reemplazo de
 * encoding (`�`)** en vez de borrarlo: el "Excel" de un banco es un TSV en Latin-1 y confundir un
 * carácter roto con una letra hace que dos filas distintas parezcan la misma.
 *
 * Movida byte por byte desde `packages/ingesta/src/parseo-ar.ts` (que la re-exporta) porque
 * `packages/contabilidad` la necesita como base de su propia normalización de léxico y no puede
 * depender de `ingesta` — mismo motivo, ya escrito, por el que `CLASES_IDENTIFICADOR_CONTRAPARTE`
 * vive en `hmac-identificador.ts`. Alimenta `fila_hash` (identidad de fila): cualquier cambio de
 * comportamiento acá reprocesaría lo ya ingestado como filas nuevas.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}
