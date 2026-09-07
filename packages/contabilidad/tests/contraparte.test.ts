/**
 * `resolverEvidenciaDeContraparte()` — los 4 estados, sin base (código puro). Migración `0037`,
 * `docs/diseno/29-padron-contraparte.md`.
 *
 * Prueba de mutación (CLAUDE.md §1.8, ADR-0002 §B.0): el caso `no_aplica` (F5,
 * `seguridad-datos-financieros`) se cierra mutando el CÓDIGO REAL —se comenta el corte temprano de
 * `es_socio` en `contraparte.ts`, se corre esta suite y se confirma ROJO, se revierte y se confirma
 * VERDE— corrida en vivo durante la implementación, no solo descripta acá. El resto de los casos
 * (sin_match / match / multiples_patrones / fallback a `descripcion`) llevan su mutante señalado en
 * el comentario del `it`.
 *
 * `glosas()` (helper de este archivo) arma las dos glosas candidatas; por default las dos valen lo
 * mismo, así que la mayoría de los casos heredados de antes del fallback (0037) siguen probando
 * exactamente lo mismo que antes, con `origen: 'concepto_banco'` agregado a la aserción (el primer
 * intento siempre gana si matchea).
 */

import { describe, expect, it } from 'vitest';
import {
  resolverEvidenciaDeContraparte,
  type GlosasCandidatas,
  type PatronDeContraparte,
} from '../src/nucleo/contraparte.ts';

function patron(overrides: Partial<PatronDeContraparte> = {}): PatronDeContraparte {
  return { contraparteId: 'contraparte-1', patron: 'FORCOR', clasificacion: 'proveedor', ...overrides };
}

/** Por default, `conceptoBanco` y `descripcion` valen lo mismo — mismo comportamiento que antes del
 *  fallback (0039) para los casos que no lo ejercitan a propósito. */
function glosas(overrides: Partial<GlosasCandidatas> = {}): GlosasCandidatas {
  const base = overrides.conceptoBanco ?? overrides.descripcion ?? '';
  return { conceptoBanco: base, descripcion: base, ...overrides };
}

describe('resolverEvidenciaDeContraparte — no_aplica (F5, regla dura no negociable)', () => {
  it('la resolución de socio ya cerró el caso (es_socio) — ni se consulta el padrón, aunque matchearía', () => {
    // Mutante ejercitado en vivo, fuera de este archivo: comentar el `if (resolucionSocio ===
    // 'es_socio') return { estado: 'no_aplica' }` de contraparte.ts hace que ESTE `it` se ponga rojo
    // (el resultado pasa a ser `match`, mezclando la evidencia de HMAC con la de texto) — es
    // exactamente el escenario que la regla dura de docs/diseno/29-padron-contraparte.md §1.2 prohíbe.
    const r = resolverEvidenciaDeContraparte('es_socio', glosas({ conceptoBanco: 'TRF INMED PROVEED FORCOR SA' }), [
      patron(),
    ]);
    expect(r).toEqual({ estado: 'no_aplica' });
  });

  it('mismo corte para cualquier otro patrón, aunque la glosa sea un match perfecto', () => {
    const r = resolverEvidenciaDeContraparte('es_socio', glosas({ conceptoBanco: 'RODAMET' }), [
      patron({ patron: 'RODAMET' }),
    ]);
    expect(r).toEqual({ estado: 'no_aplica' });
  });

  it('el corte de es_socio gana incluso cuando descripcion (no solo conceptoBanco) matchearía', () => {
    const r = resolverEvidenciaDeContraparte(
      'es_socio',
      { conceptoBanco: '', descripcion: 'TRF INMED PROVEED FORCOR SA' },
      [patron()],
    );
    expect(r).toEqual({ estado: 'no_aplica' });
  });
});

describe('resolverEvidenciaDeContraparte — sin_match', () => {
  it('se consultó, ningún patrón matchea en ninguna de las dos glosas', () => {
    const r = resolverEvidenciaDeContraparte(
      'es_tercero_padron_completo',
      glosas({ conceptoBanco: 'TRANSFERENCIA DE TERCEROS' }),
      [patron({ patron: 'FORCOR' })],
    );
    expect(r).toEqual({ estado: 'sin_match' });
  });
});

describe('resolverEvidenciaDeContraparte — match (vía concepto_banco, primer intento)', () => {
  it('un solo patrón matchea la glosa (substring, post-normalización) — origen concepto_banco', () => {
    const r = resolverEvidenciaDeContraparte('sin_candidatos', glosas({ conceptoBanco: 'TRF INMED PROVEED FORCOR SA' }), [
      patron(),
    ]);
    expect(r).toEqual({ estado: 'match', contraparteId: 'contraparte-1', clasificacion: 'proveedor', origen: 'concepto_banco' });
  });

  it('el patrón aparece como substring en medio de texto libre — mutante: si el filtro comparara ' +
    'con === en vez de includes(), este caso (el real: nombre + CUIT en la misma glosa) daría ' +
    'sin_match en vez de match', () => {
    const glosaConTextoAlrededor = 'TRF INMED PROVEED FORCOR SA CUIT 30712345678';
    const r = resolverEvidenciaDeContraparte('sin_candidatos', glosas({ conceptoBanco: glosaConTextoAlrededor }), [
      patron({ patron: 'FORCOR' }),
    ]);
    expect(r).toEqual({ estado: 'match', contraparteId: 'contraparte-1', clasificacion: 'proveedor', origen: 'concepto_banco' });
  });

  it('la clasificación devuelta es la del patrón que matcheó, no un default fijo', () => {
    const r = resolverEvidenciaDeContraparte('sin_candidatos', glosas({ conceptoBanco: 'TRANSFERENCIA DE TERCEROS RODAMET' }), [
      patron({ contraparteId: 'contraparte-2', patron: 'RODAMET', clasificacion: 'cliente' }),
    ]);
    expect(r).toEqual({ estado: 'match', contraparteId: 'contraparte-2', clasificacion: 'cliente', origen: 'concepto_banco' });
  });
});

describe('resolverEvidenciaDeContraparte — multiples_patrones (vía concepto_banco, primer intento)', () => {
  it('dos patrones matchean la misma glosa — fail-closed, nunca elige el más específico', () => {
    const r = resolverEvidenciaDeContraparte('sin_candidatos', glosas({ conceptoBanco: 'TRF INMED PROVEED FORCOR SA' }), [
      patron({ contraparteId: 'contraparte-1', patron: 'FORCOR' }),
      patron({ contraparteId: 'contraparte-3', patron: 'FORCOR SA' }),
    ]);
    expect(r).toEqual({ estado: 'multiples_patrones', contraparteIds: ['contraparte-1', 'contraparte-3'], origen: 'concepto_banco' });
  });

  it('mutante: si se devolviera solo el primer match en vez de listar todos, este caso perdería el ' +
    'segundo id sin que el estado deje de decir multiples_patrones', () => {
    const r = resolverEvidenciaDeContraparte('sin_candidatos', glosas({ conceptoBanco: 'TRF INMED PROVEED FORCOR SA' }), [
      patron({ contraparteId: 'contraparte-1', patron: 'FORCOR' }),
      patron({ contraparteId: 'contraparte-3', patron: 'FORCOR SA' }),
    ]);
    expect(r.estado === 'multiples_patrones' && r.contraparteIds).toEqual(['contraparte-1', 'contraparte-3']);
  });
});

describe('resolverEvidenciaDeContraparte — fallback a descripcion (0039, convocatoria 2026-09-06)', () => {
  it('concepto_banco sin_match (segmento corto tipo Galicia), descripcion matchea — origen descripcion', () => {
    // Reproduce EXACTO el patrón medido contra el corpus real de Bracci: concepto_banco es un
    // segmento geométrico que nunca llega al nombre; el nombre solo vive en la glosa completa.
    const r = resolverEvidenciaDeContraparte(
      'sin_candidatos',
      { conceptoBanco: 'TRF INMED PROVEED', descripcion: 'TRF INMED PROVEED FORCOR SA VARIOS BANCO' },
      [patron()],
    );
    expect(r).toEqual({ estado: 'match', contraparteId: 'contraparte-1', clasificacion: 'proveedor', origen: 'descripcion' });
  });

  it('mutante — NUNCA MERGE: un patrón presente solo en descripcion, con concepto_banco ya matcheando ' +
    'otro patrón distinto, no debe aparecer en el resultado (el segundo intento reemplaza, no se suma)', () => {
    const r = resolverEvidenciaDeContraparte(
      'sin_candidatos',
      { conceptoBanco: 'TRF INMED PROVEED RODAMET', descripcion: 'TRF INMED PROVEED RODAMET SA FORCOR REF' },
      [
        patron({ contraparteId: 'contraparte-rodamet', patron: 'RODAMET', clasificacion: 'proveedor' }),
        patron({ contraparteId: 'contraparte-forcor', patron: 'FORCOR', clasificacion: 'proveedor' }),
      ],
    );
    // concepto_banco ya da match (RODAMET) — descripcion (que también tendría FORCOR) NUNCA se
    // consulta. Si se mergearan las dos pasadas, este caso daría multiples_patrones con los dos ids.
    expect(r).toEqual({
      estado: 'match',
      contraparteId: 'contraparte-rodamet',
      clasificacion: 'proveedor',
      origen: 'concepto_banco',
    });
  });

  it('concepto_banco vacío (tipo Bancor/ICBC/Nación, nunca se captura) — cae directo al fallback', () => {
    const r = resolverEvidenciaDeContraparte(
      'sin_candidatos',
      { conceptoBanco: '', descripcion: 'PAGO A RODAMET SACI' },
      [patron({ patron: 'RODAMET', clasificacion: 'proveedor' })],
    );
    expect(r).toEqual({ estado: 'match', contraparteId: 'contraparte-1', clasificacion: 'proveedor', origen: 'descripcion' });
  });

  it('multiples_patrones también puede venir del fallback, con origen descripcion', () => {
    const r = resolverEvidenciaDeContraparte(
      'sin_candidatos',
      { conceptoBanco: 'TRF INMED PROVEED', descripcion: 'TRF INMED PROVEED FORCOR SA' },
      [
        patron({ contraparteId: 'contraparte-1', patron: 'FORCOR' }),
        patron({ contraparteId: 'contraparte-3', patron: 'FORCOR SA' }),
      ],
    );
    expect(r).toEqual({
      estado: 'multiples_patrones',
      contraparteIds: ['contraparte-1', 'contraparte-3'],
      origen: 'descripcion',
    });
  });

  it('ninguna de las dos glosas matchea — sin_match, sin origen', () => {
    const r = resolverEvidenciaDeContraparte(
      'sin_candidatos',
      { conceptoBanco: 'TRF INMED PROVEED', descripcion: 'TRF INMED PROVEED XYZ SA VARIOS BANCO' },
      [patron({ patron: 'FORCOR' })],
    );
    expect(r).toEqual({ estado: 'sin_match' });
  });
});
