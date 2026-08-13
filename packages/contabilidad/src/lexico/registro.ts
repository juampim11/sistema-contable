import type { LexicoDeBanco } from '../nucleo/lexico.ts';
import { LEXICO_GALICIA } from './galicia.ts';
import { LEXICO_SANTANDER } from './santander.ts';
import { LEXICO_MACRO } from './macro.ts';

/**
 * El único archivo que importa los tres léxicos — mismo patrón que
 * `packages/ingesta/src/adaptadores/registro.ts`: el registro conoce a todos los bancos, ningún léxico
 * conoce a otro (R-C).
 *
 * `bancoCodigo` se consume acá y en ningún otro lado de `nucleo/` — es la frontera exacta que hace
 * verificable "el motor nunca ve el banco" (05 §1.2, corregido a "bancoCodigo se consume una vez, en el
 * lookup del léxico").
 */
export const LEXICOS_POR_BANCO: Readonly<Record<string, LexicoDeBanco>> = {
  galicia: LEXICO_GALICIA,
  santander: LEXICO_SANTANDER,
  macro: LEXICO_MACRO,
};

export function lexicoDe(bancoCodigo: string): LexicoDeBanco | undefined {
  return LEXICOS_POR_BANCO[bancoCodigo];
}
