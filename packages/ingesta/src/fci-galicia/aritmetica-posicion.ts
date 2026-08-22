/**
 * Aritmética de punto fijo mínima para el verificador de posición de FCI.
 *
 * Cantidades de cuotapartes con hasta 6 decimales — confirmado contra el histograma real de los 3
 * extractos de Galicia (descubrimiento de formato de esta misma tarea, script efímero fuera del
 * repo): los números en formato AR del documento traen 2 o 6 decimales, nunca otra cosa. Nada de
 * `number` de JS para estas cantidades (CLAUDE.md §2): se opera en `bigint` con escala fija.
 *
 * Separada de `packages/fci/src/nucleo/aritmetica.ts` a propósito — pero NO por R-B (`code-reviewer`
 * corrigió la primera versión de este comentario: R-B, tal como está escrita en
 * `packages/data/tests/reglas-de-codigo.test.ts`, solo prohíbe que `packages/fci` importe
 * `data`/`ingesta`/`almacenamiento`; no prohíbe que `ingesta` importa un primitivo puro de `fci` en la
 * dirección contraria). La razón real es independencia del oráculo: este verificador y el núcleo de
 * costeo PEPS no deberían compartir la misma implementación de aritmética, para que un bug en esa
 * implementación no quede invisible en los dos lados a la vez. Y separada de `parseo-ar.ts`: esa
 * utilidad está fijada en 2 decimales para importes en pesos y la usan los adaptadores bancarios
 * reales — no se le cambia la escala para este caso puntual.
 */

const ESCALA = 6;
const FACTOR = 10n ** BigInt(ESCALA);

/**
 * Entero con hasta `ESCALA` decimales — nunca más (no hay redondeo acá) y **nunca con signo**.
 *
 * 🔴 Sin `-?` a propósito (hallazgo de `code-reviewer`, `tester` y `qa-automation` sobre la primera
 * versión, los tres de forma independiente): una cantidad de cuotapartes de FCI —saldo, suscripción,
 * rescate o tenencia— nunca es negativa en este dominio. Aceptar el signo dejaba pasar un rescate
 * cargado con el signo invertido (un error de extracción típico de PDF) como si SUMARA en vez de
 * restar, y el invariante "cerraba" sobre un documento que en los hechos no cierra — exactamente lo
 * que este verificador existe para detectar. El signo de una operación (sumar o restar) ya lo decide
 * la fórmula en `verificar-posicion.ts`, nunca el texto de origen.
 */
const PATRON_CANTIDAD = /^\d+(\.\d{1,6})?$/;

export const CODIGO_CANTIDAD_POSICION_INVALIDA = 'FCI_POSICION_CANTIDAD_INVALIDA' as const;

/**
 * 🔴 El mensaje no lleva el texto recibido: mismo criterio que `DecimalInvalidoError` de
 * `packages/fci/src/nucleo/aritmetica.ts` — ese texto puede venir de un documento de un cliente.
 */
export class CantidadPosicionInvalidaError extends Error {
  readonly codigo = CODIGO_CANTIDAD_POSICION_INVALIDA;

  constructor() {
    super('El texto no representa una cantidad de posición válida (sin signo, hasta 6 decimales).');
    this.name = 'CantidadPosicionInvalidaError';
  }
}

/** Parsea una cantidad decimal sin signo (hasta 6 decimales) a la escala fija interna. */
export function aCantidadEscalada(texto: string): bigint {
  if (!PATRON_CANTIDAD.test(texto)) throw new CantidadPosicionInvalidaError();

  const [parteEntera = '0', parteDecimal = ''] = texto.split('.');
  const decimalRellenado = parteDecimal.padEnd(ESCALA, '0');
  return BigInt(parteEntera) * FACTOR + BigInt(decimalRellenado);
}

/** Suma una lista de cantidades (p. ej. todas las suscripciones o todos los rescates de un fondo). */
export function sumarCantidades(textos: readonly string[]): bigint {
  return textos.reduce((acumulado, texto) => acumulado + aCantidadEscalada(texto), 0n);
}

/** Valor absoluto de `a − b`, en la escala interna. */
export function diferenciaAbsoluta(a: bigint, b: bigint): bigint {
  const diferencia = a - b;
  return diferencia < 0n ? -diferencia : diferencia;
}

/** Cuántos decimales usa la escala interna — para que quien categorice un delta no repita el `6`. */
export const ESCALA_CANTIDAD_POSICION = ESCALA;
export const FACTOR_CANTIDAD_POSICION = FACTOR;
