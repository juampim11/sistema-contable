import { normalizarParaLexico } from './normalizacion.ts';
import type { EntradaLexico, LexicoDeBanco } from './lexico.ts';

/** El ancla de un literal: forma normalizada, delimitada. Mismo criterio que `macro.ts:anclaDePrefijo`
 * — un literal que ya termina en carácter no alfanumérico se delimita solo. */
export function anclaDe(literal: string): string {
  const n = normalizarParaLexico(literal);
  return /[A-Z0-9]$/.test(n) ? `${n} ` : n;
}

export type EntradaConAncla = {
  readonly entrada: EntradaLexico;
  readonly literal: string;
  readonly normalizado: string;
  readonly ancla: string;
};

export type IndiceDeLexico = {
  readonly lexico: LexicoDeBanco;
  /** Igualdad exacta: normalizado completo → entrada+literal. */
  readonly porNormalizado: ReadonlyMap<string, EntradaConAncla>;
  /** Para prefijo: TODAS las anclas, ordenadas de más larga a más corta (la que explica más glosa gana
   * primero). Desempate por orden lexicográfico del ancla, para que una colisión sea reproducible. */
  readonly anclasOrdenadas: readonly EntradaConAncla[];
};

export function construirIndice(lexico: LexicoDeBanco): IndiceDeLexico {
  const porNormalizado = new Map<string, EntradaConAncla>();
  const anclas: EntradaConAncla[] = [];

  for (const entrada of lexico.entradas) {
    for (const literal of entrada.literales) {
      const normalizado = normalizarParaLexico(literal);
      const item: EntradaConAncla = { entrada, literal, normalizado, ancla: anclaDe(literal) };
      porNormalizado.set(normalizado, item);
      anclas.push(item);
    }
  }

  anclas.sort((a, b) => b.ancla.length - a.ancla.length || (a.ancla < b.ancla ? -1 : 1));

  return { lexico, porNormalizado, anclasOrdenadas: anclas };
}
