/**
 * ARITMÉTICA DE PUNTO FIJO — CLAUDE.md §2: ningún importe como `number` de JavaScript.
 *
 * `consumirRescate` necesita sumar, restar y multiplicar cantidades y precios de cuotapartes de FCI
 * sin pasar por el punto flotante de JS, donde el error de redondeo se acumula en silencio a medida
 * que se encadenan operaciones. Este módulo parte cada valor a `bigint` con una escala fija y opera
 * ahí; el punto flotante no entra en ningún paso intermedio.
 *
 * Escala de 6 decimales: alcanza con margen para cantidades de cuotapartes (2 decimales en la
 * práctica, p. ej. `12345.67`) y para precios (que suelen llevar más). Una escala variable por campo sería
 * más flexible pero es la clase de generalidad que este archivo evita hasta que un caso real la pida.
 *
 * Sin librería externa (`decimal.js` o similar): el repo hoy no tiene ningún caso medido de pérdida de
 * precisión que la justifique, y agregar una dependencia nueva no es una decisión de quien escribe
 * este archivo (le corresponde a `dba-data` + `security-engineer`, ver el plan de esta tarea). Esta
 * utilidad es deliberadamente mínima: lo que `consumirRescate` necesita y nada más.
 */

const ESCALA = 6;
const FACTOR = 10n ** BigInt(ESCALA);

/**
 * Marca de tipo nominal: un `bigint` con esta marca SIEMPRE está en la escala fija de este módulo.
 * Sin la marca, cualquier `bigint` (un id, un contador) se colaría donde se espera un importe ya
 * escalado, y una suma entre los dos daría un número sin sentido sin que TypeScript lo viera venir.
 */
const marcaPuntoFijo = Symbol('puntoFijo');
export type PuntoFijo = bigint & { readonly [marcaPuntoFijo]: true };

/** El cero de esta escala, tipado — para no repetir `0n as PuntoFijo` en cada archivo que lo necesite. */
export const CERO: PuntoFijo = 0n as PuntoFijo;

export const CODIGO_DECIMAL_INVALIDO = 'FCI_DECIMAL_INVALIDO' as const;

/**
 * 🔴 El mensaje NO lleva el texto recibido: ese texto puede venir de un archivo de un cliente (un
 * Excel, un PDF) más adelante, cuando exista el adaptador. El código alcanza para depurar — quien
 * llama ya sabe qué campo estaba parseando.
 */
export class DecimalInvalidoError extends Error {
  // Asignada a mano, no como parameter property: el type-stripping de Node no las soporta
  // (ver `packages/data/tests/reglas-de-codigo.test.ts`, "sintaxis que tsc acepta y Node no ejecuta").
  readonly codigo = CODIGO_DECIMAL_INVALIDO;

  constructor() {
    super('El texto no representa un decimal válido para la escala fija de este módulo.');
    this.name = 'DecimalInvalidoError';
  }
}

// Entero opcionalmente negativo, con una parte decimal opcional. Los dos límites (`^` y `$`) evitan
// que un texto con basura al medio o al final ("12.5x", "12.5\n0") pase como si fuera un decimal limpio.
const PATRON_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Parsea un decimal en texto (el único formato en el que este dominio recibe cantidades e importes) a la escala fija. */
export function aPuntoFijo(texto: string): PuntoFijo {
  if (!PATRON_DECIMAL.test(texto)) throw new DecimalInvalidoError();

  const negativo = texto.startsWith('-');
  const sinSigno = negativo ? texto.slice(1) : texto;
  // El patrón ya garantiza al menos un dígito antes de un punto opcional; el valor por defecto de
  // `parteEntera` es solo para satisfacer `noUncheckedIndexedAccess` — nunca se usa en los hechos.
  const [parteEntera = '0', parteDecimal = ''] = sinSigno.split('.');

  // Más decimales de los que la escala representa: truncar en silencio perdería precisión real del
  // dato de origen. Se rechaza en vez de redondear — redondear es una decisión de negocio, no de esta
  // utilidad de bajo nivel.
  if (parteDecimal.length > ESCALA) throw new DecimalInvalidoError();

  // `padEnd` sobre un ESCALA > 0 nunca devuelve '' (incluso partiendo de ''), así que no hace falta
  // un caso especial para el decimal vacío.
  const decimalRellenado = parteDecimal.padEnd(ESCALA, '0');
  const magnitud = BigInt(parteEntera) * FACTOR + BigInt(decimalRellenado);
  return (negativo ? -magnitud : magnitud) as PuntoFijo;
}

/** Formatea de vuelta a texto decimal, con exactamente `ESCALA` decimales. */
export function formatear(valor: PuntoFijo): string {
  const negativo = valor < 0n;
  const absoluto = negativo ? -valor : valor;
  const entero = absoluto / FACTOR;
  const decimal = (absoluto % FACTOR).toString().padStart(ESCALA, '0');
  const texto = `${entero}.${decimal}`;
  return negativo ? `-${texto}` : texto;
}

export function sumar(a: PuntoFijo, b: PuntoFijo): PuntoFijo {
  return (a + b) as PuntoFijo;
}

export function restar(a: PuntoFijo, b: PuntoFijo): PuntoFijo {
  return (a - b) as PuntoFijo;
}

/** -1 si `a < b`, 0 si son iguales, 1 si `a > b`. */
export function comparar(a: PuntoFijo, b: PuntoFijo): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function esCero(valor: PuntoFijo): boolean {
  return valor === 0n;
}

export function minimo(a: PuntoFijo, b: PuntoFijo): PuntoFijo {
  return comparar(a, b) <= 0 ? a : b;
}

/**
 * Multiplica dos magnitudes en esta escala (cantidad tomada de una capa × diferencia de precio, para
 * el resultado de un rescate). El producto crudo de dos `bigint` en escala 1e6 queda en escala 1e12;
 * se reescala dividiendo por `FACTOR` para volver a la escala del módulo.
 *
 * 🔴 Política de redondeo, explícita: la división entera de `bigint` en JavaScript TRUNCA HACIA CERO,
 * nunca redondea — ni siquiera en el empate exacto de la mitad del último dígito descartado. Por
 * ejemplo, `aPuntoFijo('1.000003') * aPuntoFijo('-1.5')` deja un resto exacto de `-500000n` en escala
 * 1e12 (la mitad exacta de `FACTOR`), y el resultado queda en `-1.500004` en vez de redondear a
 * `-1.500005`: el medio punto se recorta hacia cero en los dos signos, simétricamente. Igual que en
 * `aPuntoFijo`, esto no es un bug — es la decisión explícita de no redondear en una utilidad de bajo
 * nivel (redondear es una decisión de negocio, no de esta escala). Ver `tests/aritmetica.test.ts`.
 */
export function multiplicar(a: PuntoFijo, b: PuntoFijo): PuntoFijo {
  return ((a * b) / FACTOR) as PuntoFijo;
}
