/**
 * `resolverEvidenciaDeContraparte()` — los 4 estados, sin base (código puro). Migración `0037`,
 * `docs/diseno/29-padron-contraparte.md`.
 *
 * Prueba de mutación (CLAUDE.md §1.8, ADR-0002 §B.0): el caso `no_aplica` (F5,
 * `seguridad-datos-financieros`) se cierra mutando el CÓDIGO REAL —se comenta el corte temprano de
 * `es_socio` en `contraparte.ts`, se corre esta suite y se confirma ROJO, se revierte y se confirma
 * VERDE— corrida en vivo durante la implementación, no solo descripta acá. El resto de los casos
 * (sin_match / match / multiples_patrones) llevan su mutante señalado en el comentario del `it`.
 */

import { describe, expect, it } from 'vitest';
import { resolverEvidenciaDeContraparte, type PatronDeContraparte } from '../src/nucleo/contraparte.ts';

function patron(overrides: Partial<PatronDeContraparte> = {}): PatronDeContraparte {
  return { contraparteId: 'contraparte-1', patron: 'FORCOR', clasificacion: 'proveedor', ...overrides };
}

describe('resolverEvidenciaDeContraparte — no_aplica (F5, regla dura no negociable)', () => {
  it('la resolución de socio ya cerró el caso (es_socio) — ni se consulta el padrón, aunque matchearía', () => {
    // Mutante ejercitado en vivo, fuera de este archivo: comentar el `if (resolucionSocio ===
    // 'es_socio') return { estado: 'no_aplica' }` de contraparte.ts hace que ESTE `it` se ponga rojo
    // (el resultado pasa a ser `match`, mezclando la evidencia de HMAC con la de texto) — es
    // exactamente el escenario que la regla dura de docs/diseno/29-padron-contraparte.md §1.2 prohíbe.
    const r = resolverEvidenciaDeContraparte('es_socio', 'TRF INMED PROVEED FORCOR SA', [patron()]);
    expect(r).toEqual({ estado: 'no_aplica' });
  });

  it('mismo corte para cualquier otro patrón, aunque la glosa sea un match perfecto', () => {
    const r = resolverEvidenciaDeContraparte('es_socio', 'RODAMET', [patron({ patron: 'RODAMET' })]);
    expect(r).toEqual({ estado: 'no_aplica' });
  });
});

describe('resolverEvidenciaDeContraparte — sin_match', () => {
  it('se consultó, ningún patrón matchea', () => {
    const r = resolverEvidenciaDeContraparte('es_tercero_padron_completo', 'TRANSFERENCIA DE TERCEROS', [
      patron({ patron: 'FORCOR' }),
    ]);
    expect(r).toEqual({ estado: 'sin_match' });
  });
});

describe('resolverEvidenciaDeContraparte — match', () => {
  it('un solo patrón matchea la glosa (substring, post-normalización)', () => {
    const r = resolverEvidenciaDeContraparte('sin_candidatos', 'TRF INMED PROVEED FORCOR SA', [patron()]);
    expect(r).toEqual({ estado: 'match', contraparteId: 'contraparte-1', clasificacion: 'proveedor' });
  });

  it('el patrón aparece como substring en medio de texto libre — mutante: si el filtro comparara ' +
    'con === en vez de includes(), este caso (el real: nombre + CUIT en la misma glosa) daría ' +
    'sin_match en vez de match', () => {
    const glosaConTextoAlrededor = 'TRF INMED PROVEED FORCOR SA CUIT 30712345678';
    const r = resolverEvidenciaDeContraparte('sin_candidatos', glosaConTextoAlrededor, [patron({ patron: 'FORCOR' })]);
    expect(r).toEqual({ estado: 'match', contraparteId: 'contraparte-1', clasificacion: 'proveedor' });
  });

  it('la clasificación devuelta es la del patrón que matcheó, no un default fijo', () => {
    const r = resolverEvidenciaDeContraparte('sin_candidatos', 'TRANSFERENCIA DE TERCEROS RODAMET', [
      patron({ contraparteId: 'contraparte-2', patron: 'RODAMET', clasificacion: 'cliente' }),
    ]);
    expect(r).toEqual({ estado: 'match', contraparteId: 'contraparte-2', clasificacion: 'cliente' });
  });
});

describe('resolverEvidenciaDeContraparte — multiples_patrones', () => {
  it('dos patrones matchean la misma glosa — fail-closed, nunca elige el más específico', () => {
    const r = resolverEvidenciaDeContraparte('sin_candidatos', 'TRF INMED PROVEED FORCOR SA', [
      patron({ contraparteId: 'contraparte-1', patron: 'FORCOR' }),
      patron({ contraparteId: 'contraparte-3', patron: 'FORCOR SA' }),
    ]);
    expect(r).toEqual({ estado: 'multiples_patrones', contraparteIds: ['contraparte-1', 'contraparte-3'] });
  });

  it('mutante: si se devolviera solo el primer match en vez de listar todos, este caso perdería el ' +
    'segundo id sin que el estado deje de decir multiples_patrones', () => {
    const r = resolverEvidenciaDeContraparte('sin_candidatos', 'TRF INMED PROVEED FORCOR SA', [
      patron({ contraparteId: 'contraparte-1', patron: 'FORCOR' }),
      patron({ contraparteId: 'contraparte-3', patron: 'FORCOR SA' }),
    ]);
    expect(r.estado === 'multiples_patrones' && r.contraparteIds).toEqual(['contraparte-1', 'contraparte-3']);
  });
});
