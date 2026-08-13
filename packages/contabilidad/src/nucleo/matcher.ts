import { normalizarParaLexico } from './normalizacion.ts';
import type { IndiceDeLexico, EntradaConAncla } from './indice.ts';
import type { EntradaLexico } from './lexico.ts';
import type { ConceptoCanonico } from './catalogo.ts';
import type { Lado, ViaEvidencia } from './tipos.ts';

export type ResultadoDelMatcher =
  | { readonly resultado: 'encontrado'; readonly entrada: EntradaLexico; readonly via: ViaEvidencia; readonly caracteresMatcheados: number }
  | { readonly resultado: 'ambiguo'; readonly candidatos: readonly string[] }
  | { readonly resultado: 'no_encontrado' };

/**
 * `05-motor-de-reconocimiento.md` §3.2 — tres matchers, en precedencia declarada.
 *
 * 🔴 Regla dura de §3: cero regex escrita a mano sobre la glosa, cero `includes` suelto. El único
 * `startsWith` del paquete vive acá — es el choke point que R-E permite explícitamente.
 */
export function reconocerPorTexto(
  conceptoBanco: string | undefined,
  conceptoCompleto: boolean | undefined,
  lado: Lado,
  indice: IndiceDeLexico,
  ladoEsperadoDe: (concepto: ConceptoCanonico) => Lado | 'indistinto',
): ResultadoDelMatcher {
  if (conceptoBanco === undefined) return { resultado: 'no_encontrado' };

  const normalizado = normalizarParaLexico(conceptoBanco);

  // 1. `exacta` — igualdad de la cadena normalizada completa. Resuelve los sinónimos.
  const exacto = indice.porNormalizado.get(normalizado);
  if (exacto) {
    const via: ViaEvidencia = exacto.entrada.matcheo.modo === 'prefijo_con_cola' ? 'texto_prefijo_con_cola' : 'texto_literal_exacto';
    return { resultado: 'encontrado', entrada: exacto.entrada, via, caracteresMatcheados: normalizado.length };
  }

  // Un literal COMPLETO que no está en el léxico es un literal NUEVO, no el prefijo de otro — nunca cae
  // a `prefijo_unico`. Guarda mecánica, gratis, que el documento no enuncia explícitamente.
  if (conceptoCompleto === true) return { resultado: 'no_encontrado' };

  // 2. `prefijo_unico` — para el truncado que no se enumeró. Las CUATRO guardas.
  const anclaMovimiento = /[A-Z0-9]$/.test(normalizado) ? `${normalizado} ` : normalizado;
  const candidatos: EntradaConAncla[] = [];
  for (const item of indice.anclasOrdenadas) {
    if (item.entrada.matcheo.modo !== 'exacto_o_prefijo') continue;
    // (a) es prefijo de este literal
    if (!item.ancla.startsWith(anclaMovimiento)) continue;
    // (b) longitud ≥ prefijoMinimo
    if (normalizado.length < item.entrada.matcheo.prefijoMinimo) continue;
    // (c) el corte cae en borde de token. Si `anclaMovimiento` ya termina en el espacio que este mismo
    // matcher le agregó (el texto original terminaba en alfanumérico), el borde ya está garantizado por
    // construcción. Si no (el texto original terminaba en un carácter no alfanumérico, ej. `]` de un
    // marcador enmascarado), lo que sigue en el ancla real tiene que ser el fin de cadena o un espacio.
    if (!anclaMovimiento.endsWith(' ')) {
      const siguiente = item.ancla[anclaMovimiento.length];
      if (siguiente !== undefined && siguiente !== ' ') continue;
    }
    candidatos.push(item);
  }

  // Distintas ENTRADAS (no distintos literales de una misma entrada) que matchean como prefijo únicas.
  const entradasDistintas = new Map<string, EntradaConAncla>();
  for (const c of candidatos) entradasDistintas.set(c.entrada.id, c);

  if (entradasDistintas.size > 1) {
    return { resultado: 'ambiguo', candidatos: [...entradasDistintas.keys()].sort() };
  }
  if (entradasDistintas.size === 0) return { resultado: 'no_encontrado' };

  const [unica] = [...entradasDistintas.values()];
  if (!unica) return { resultado: 'no_encontrado' };

  // (d) el ladoEsperado del concepto coincide con el lado del movimiento
  const ladoEsperado = ladoEsperadoDe(unica.entrada.concepto);
  if (ladoEsperado !== 'indistinto' && ladoEsperado !== lado) {
    return { resultado: 'no_encontrado' };
  }

  return {
    resultado: 'encontrado',
    entrada: unica.entrada,
    via: 'texto_prefijo_unico',
    caracteresMatcheados: normalizado.length,
  };
}
