/**
 * `resolverContraparte()` — los 7 estados, sin base (código puro). Plan `adaptive-herding-pillow`,
 * P4. Cubre en particular las dos garantías centrales que la Ronda 1/2 de convocatoria exigieron:
 * el fail-closed de pepper desalineado (`seguridad-datos-financieros`) y el refinamiento de padrón
 * vacío (`motor-conciliacion-contable`).
 */

import { describe, expect, it } from 'vitest';
import {
  marcarPadronConsultado,
  resolverContraparte,
  type CandidatoDeContraparte,
  type ResolucionDeContraparte,
  type SocioDelPadron,
} from '../src/nucleo/contrapartida.ts';
import { aplicarContrapartida } from '../src/nucleo/motor.ts';
import type { Reconocimiento } from '../src/nucleo/reconocimiento.ts';

const HMAC_A = Buffer.alloc(32, 0xaa);
const HMAC_B = Buffer.alloc(32, 0xbb);
const HMAC_C = Buffer.alloc(32, 0xcc);

function candidato(overrides: Partial<CandidatoDeContraparte> = {}): CandidatoDeContraparte {
  return { clase: 'cuit', hmac: HMAC_A, pepperId: 'v1', ...overrides };
}

function socio(overrides: Partial<SocioDelPadron> = {}): SocioDelPadron {
  return {
    socioId: 'socio-1',
    documentoHmac: HMAC_A,
    pepperId: 'v1',
    vigenteDesde: '2026-01-01',
    vigenteHasta: null,
    ...overrides,
  };
}

const FECHA = '2026-06-15';

describe('resolverContraparte — sin_candidatos', () => {
  it('el movimiento no trae candidatos', () => {
    const r = resolverContraparte([], marcarPadronConsultado([socio()]), FECHA, false);
    expect(r).toEqual({ estado: 'sin_candidatos' });
  });
});

describe('resolverContraparte — es_socio', () => {
  it('un candidato matchea un socio vigente, con padrón incompleto igual — un match es evidencia real', () => {
    const r = resolverContraparte([candidato()], marcarPadronConsultado([socio()]), FECHA, false);
    expect(r).toEqual({
      estado: 'es_socio',
      socioId: 'socio-1',
      matches: [{ socioId: 'socio-1', clase: 'cuit' }],
    });
  });

  it('dos candidatos del mismo movimiento matchean al MISMO socio — sigue siendo es_socio, no multiples_socios', () => {
    const padron = marcarPadronConsultado([socio()]);
    const r = resolverContraparte(
      [candidato({ clase: 'cuit' }), candidato({ clase: 'dni', hmac: HMAC_A })],
      padron,
      FECHA,
      false,
    );
    expect(r.estado).toBe('es_socio');
  });
});

describe('resolverContraparte — es_tercero_padron_completo / sin_match_padron_incompleto', () => {
  it('ningún candidato matchea, gate activo → es tercero (12a/13a proponible)', () => {
    const r = resolverContraparte([candidato({ hmac: HMAC_B })], marcarPadronConsultado([socio()]), FECHA, true);
    expect(r).toEqual({ estado: 'es_tercero_padron_completo' });
  });

  it('ningún candidato matchea, gate INACTIVO → nunca propone, decisión humana', () => {
    const r = resolverContraparte([candidato({ hmac: HMAC_B })], marcarPadronConsultado([socio()]), FECHA, false);
    expect(r).toEqual({ estado: 'sin_match_padron_incompleto' });
  });
});

describe('resolverContraparte — pepper_desalineado (Ronda 1, seguridad-datos-financieros)', () => {
  it('candidato y padrón en versiones de pepper distintas → desalineado, NUNCA es_tercero', () => {
    const candidatoV2 = candidato({ pepperId: 'v2' });
    const padronV1 = marcarPadronConsultado([socio({ pepperId: 'v1' })]);
    const r = resolverContraparte([candidatoV2], padronV1, FECHA, true); // gate activo a propósito
    expect(r.estado).toBe('pepper_desalineado');
    if (r.estado === 'pepper_desalineado') {
      expect(r.pepperIdsCandidatos).toEqual(['v2']);
      expect(r.pepperIdsPadron).toEqual(['v1']);
    }
  });

  it('un candidato huérfano (su pepper no existe en el padrón) desalinea aunque otro candidato SÍ tenga intersección', () => {
    const padron = marcarPadronConsultado([socio({ pepperId: 'v1' })]);
    const r = resolverContraparte(
      [candidato({ pepperId: 'v1', hmac: HMAC_B }), candidato({ pepperId: 'v2', hmac: HMAC_C })],
      padron,
      FECHA,
      true,
    );
    expect(r.estado).toBe('pepper_desalineado');
  });

  it('🔴 hallazgo de tester (Ronda 3): padrón MIXTO (un socio viejo en v1, uno nuevo en v2) — el candidato del socio VIEJO capturado post-rotación NUNCA da es_tercero', () => {
    // Reproduce el bug real: Socio A nunca se re-hasheó (sigue en v1); Socio B es un alta nueva, ya
    // en v2. Un movimiento real de Socio A capturado DESPUÉS de la rotación tiene su candidato en v2
    // (pepperIdActual() ya daba v2 al momento de la captura) — ese candidato v2 nunca puede matchear
    // la fila de Socio A (que sigue en v1). La regla de intersección original daba "alineado" porque
    // Socio B "cubría" el v2 del candidato, y el movimiento de Socio A resolvía es_tercero_padron_
    // completo en silencio — exactamente la conversión de socio en proveedor que el fail-closed existe
    // para impedir.
    const socioAViejo = socio({ socioId: 'socio-A', documentoHmac: HMAC_A, pepperId: 'v1' });
    const socioBNuevo = socio({ socioId: 'socio-B', documentoHmac: HMAC_B, pepperId: 'v2' });
    const padronMixto = marcarPadronConsultado([socioAViejo, socioBNuevo]);

    // Candidato del movimiento real de Socio A, pero hasheado con el pepper ACTUAL (v2) porque se
    // capturó después de la rotación — su HMAC representa el documento de A, no coincide con nada
    // (la fila de A quedó en v1, nunca re-hasheada).
    const candidatoDeSocioAPostRotacion = candidato({ pepperId: 'v2', hmac: HMAC_A });

    const r = resolverContraparte([candidatoDeSocioAPostRotacion], padronMixto, FECHA, true); // gate activo a propósito
    expect(r.estado).toBe('pepper_desalineado');
    expect(r.estado).not.toBe('es_tercero_padron_completo');
    expect(r.estado).not.toBe('es_socio');
  });

  it('🔴 refinamiento (motor-conciliacion-contable): padrón VACÍO no es "desalineado" — es "no hay padrón cargado"', () => {
    // Estado real medido hoy contra el piloto: padron_socio tiene 0 filas. Sin el refinamiento, esto
    // daría SIEMPRE pepper_desalineado (interseccionVacia por construcción), un diagnóstico falso de
    // "rotación de pepper" cuando el problema real es que nadie cargó el padrón todavía.
    const padronVacio = marcarPadronConsultado([]);
    const r = resolverContraparte([candidato()], padronVacio, FECHA, false);
    expect(r.estado).toBe('sin_match_padron_incompleto');
    expect(r.estado).not.toBe('pepper_desalineado');
  });

  it('padrón vacío + gate activo → es_tercero_padron_completo, no pepper_desalineado', () => {
    const padronVacio = marcarPadronConsultado([]);
    const r = resolverContraparte([candidato()], padronVacio, FECHA, true);
    expect(r).toEqual({ estado: 'es_tercero_padron_completo' });
  });
});

describe('resolverContraparte — socio_fuera_de_vigencia', () => {
  it('el candidato matchea el documento, pero la fecha del movimiento es ANTERIOR a vigente_desde', () => {
    const s = socio({ vigenteDesde: '2026-07-01', vigenteHasta: null });
    const r = resolverContraparte([candidato()], marcarPadronConsultado([s]), '2026-06-15', true);
    expect(r.estado).toBe('socio_fuera_de_vigencia');
    if (r.estado === 'socio_fuera_de_vigencia') {
      expect(r.matches).toEqual([
        { socioId: 'socio-1', clase: 'cuit', vigenteDesde: '2026-07-01', vigenteHasta: null },
      ]);
    }
  });

  it('la fecha del movimiento es POSTERIOR o igual a vigente_hasta (semiabierto: [desde, hasta))', () => {
    const s = socio({ vigenteDesde: '2026-01-01', vigenteHasta: '2026-06-01' });
    const r = resolverContraparte([candidato()], marcarPadronConsultado([s]), '2026-06-01', true);
    expect(r.estado).toBe('socio_fuera_de_vigencia');
  });

  it('nunca se reinterpreta como es_tercero_padron_completo aunque el gate esté activo', () => {
    const s = socio({ vigenteDesde: '2027-01-01', vigenteHasta: null });
    const r = resolverContraparte([candidato()], marcarPadronConsultado([s]), FECHA, true);
    expect(r.estado).not.toBe('es_tercero_padron_completo');
  });
});

describe('resolverContraparte — multiples_socios', () => {
  it('dos candidatos matchean, cada uno, a un socio VIGENTE distinto — nunca elige, lista todos', () => {
    const socioUno = socio({ socioId: 'socio-1', documentoHmac: HMAC_A });
    const socioDos = socio({ socioId: 'socio-2', documentoHmac: HMAC_B });
    const r = resolverContraparte(
      [candidato({ clase: 'cuit', hmac: HMAC_A }), candidato({ clase: 'dni', hmac: HMAC_B })],
      marcarPadronConsultado([socioUno, socioDos]),
      FECHA,
      true,
    );
    expect(r.estado).toBe('multiples_socios');
    if (r.estado === 'multiples_socios') {
      expect(r.matches).toHaveLength(2);
      expect(new Set(r.matches.map((m) => m.socioId))).toEqual(new Set(['socio-1', 'socio-2']));
    }
  });

  it('socio_fuera_de_vigencia y multiples_socios NUNCA coexisten: si uno de los dos matches está fuera de vigencia, cuenta solo el vigente', () => {
    const socioVigente = socio({ socioId: 'socio-1', documentoHmac: HMAC_A });
    const socioNoVigente = socio({ socioId: 'socio-2', documentoHmac: HMAC_B, vigenteDesde: '2027-01-01' });
    const r = resolverContraparte(
      [candidato({ clase: 'cuit', hmac: HMAC_A }), candidato({ clase: 'dni', hmac: HMAC_B })],
      marcarPadronConsultado([socioVigente, socioNoVigente]),
      FECHA,
      true,
    );
    // Un solo match vigente (socio-1): es_socio, no multiples_socios ni socio_fuera_de_vigencia.
    expect(r.estado).toBe('es_socio');
  });
});

describe('resolverContraparte — comparación por HMAC, nunca por clase suelta', () => {
  it('un candidato dni/cbu no puede matchear un socio (dominio de hash distinto) — el mismo HMAC no aparece por construcción, pero el test documenta la propiedad', () => {
    // padron_socio solo admite documento_tipo cuit/cuil (dominio 'cuit_cuil'); un candidato dni/cbu
    // real nunca comparte HMAC con una fila del padrón. Acá se fuerza el HMAC igual a propósito para
    // confirmar que resolverContraparte no filtra por 'clase' — compara solo por HMAC+pepper, y de
    // hecho matchea (la garantía real vive en hmacDocumento(), no en esta función).
    const s = socio({ documentoHmac: HMAC_A });
    const r = resolverContraparte([candidato({ clase: 'dni', hmac: HMAC_A })], marcarPadronConsultado([s]), FECHA, true);
    expect(r.estado).toBe('es_socio');
  });
});

// -----------------------------------------------------------------------------
// aplicarContrapartida — la promoción a `clase: 'propuesta'` (motor.ts, R-F)
// -----------------------------------------------------------------------------

function decisionHumanaDistinguirSocio(lado: 'debe' | 'haber'): Reconocimiento {
  return {
    clase: 'decision_humana',
    tipo: 'pago_a_proveedor_transferencia',
    concepto: 'transferencia_a_terceros',
    polaridad: 'normal',
    lado,
    via: 'texto_literal_exacto',
    evidencia: { entradaLexicoId: 'galicia.transferencia', via: 'texto_literal_exacto', caracteresMatcheados: 10, huboCola: false },
    queDecide: 'distinguir_tercero_de_socio',
  };
}

describe('aplicarContrapartida', () => {
  it('reconocimientos que NO son decision_humana/distinguir_tercero_de_socio pasan sin cambios', () => {
    const propuesta: Reconocimiento = {
      clase: 'propuesta',
      tipo: 'comision_bancaria',
      concepto: 'comision_de_transferencia',
      polaridad: 'normal',
      lado: 'debe',
      via: 'texto_literal_exacto',
      evidencia: { entradaLexicoId: 'x', via: 'texto_literal_exacto', caracteresMatcheados: 5, huboCola: false },
    };
    const resolucion: ResolucionDeContraparte = { estado: 'es_socio', socioId: 'socio-1', matches: [] };
    expect(aplicarContrapartida(propuesta, resolucion)).toBe(propuesta);
  });

  it('es_socio + lado debe → promueve a propuesta, tipo retiro_de_socio (12b)', () => {
    const r = aplicarContrapartida(decisionHumanaDistinguirSocio('debe'), {
      estado: 'es_socio',
      socioId: 'socio-1',
      matches: [{ socioId: 'socio-1', clase: 'cuit' }],
    });
    expect(r.clase).toBe('propuesta');
    if (r.clase === 'propuesta') {
      expect(r.tipo).toBe('retiro_de_socio');
      expect(r.evidenciaContrapartida?.estado).toBe('es_socio');
    }
  });

  it('es_socio + lado haber → promueve a propuesta, tipo aporte_de_socio (13b)', () => {
    const r = aplicarContrapartida(decisionHumanaDistinguirSocio('haber'), {
      estado: 'es_socio',
      socioId: 'socio-1',
      matches: [],
    });
    expect(r.clase).toBe('propuesta');
    if (r.clase === 'propuesta') expect(r.tipo).toBe('aporte_de_socio');
  });

  it('es_tercero_padron_completo + lado debe → pago_a_proveedor_transferencia (12a)', () => {
    const r = aplicarContrapartida(decisionHumanaDistinguirSocio('debe'), { estado: 'es_tercero_padron_completo' });
    expect(r.clase).toBe('propuesta');
    if (r.clase === 'propuesta') expect(r.tipo).toBe('pago_a_proveedor_transferencia');
  });

  it('es_tercero_padron_completo + lado haber → cobranza_de_cliente (13a)', () => {
    const r = aplicarContrapartida(decisionHumanaDistinguirSocio('haber'), { estado: 'es_tercero_padron_completo' });
    expect(r.clase).toBe('propuesta');
    if (r.clase === 'propuesta') expect(r.tipo).toBe('cobranza_de_cliente');
  });

  const NO_PROMUEVEN: readonly ResolucionDeContraparte[] = [
    { estado: 'sin_match_padron_incompleto' },
    { estado: 'sin_candidatos' },
    { estado: 'pepper_desalineado', pepperIdsCandidatos: ['v2'], pepperIdsPadron: ['v1'] },
    { estado: 'multiples_socios', matches: [] },
    { estado: 'socio_fuera_de_vigencia', matches: [] },
  ];

  it.each(NO_PROMUEVEN)('$estado nunca promueve — se queda en decision_humana con la evidencia adjunta', (resolucion) => {
    const r = aplicarContrapartida(decisionHumanaDistinguirSocio('debe'), resolucion);
    expect(r.clase).toBe('decision_humana');
    if (r.clase === 'decision_humana') expect(r.evidenciaContrapartida).toEqual(resolucion);
  });
});
