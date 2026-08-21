/**
 * `texto-humano.ts` — el mapeo de vocabulario cerrado a español llano para el export enriquecido.
 * Puro, sin base: ejercita directamente los tres discriminantes de `Reconocimiento`.
 */

import { describe, expect, it } from 'vitest';
import { TIPOS_MOVIMIENTO, QUE_DECIDE, MOTIVOS_SIN_RECONOCER, type TipoMovimiento } from '../src/nucleo/tipos.ts';
import {
  TEXTO_SIN_TIPO,
  textoDeMotivoSinReconocer,
  textoDeQueDecide,
  textoDeReconocimiento,
  textoDeTipo,
} from '../src/nucleo/texto-humano.ts';
import type { Reconocimiento } from '../src/nucleo/reconocimiento.ts';

const EVIDENCIA_DE_PRUEBA = { entradaLexicoId: 'e1', via: 'texto_literal_exacto', caracteresMatcheados: 5, huboCola: false } as const;

describe('textoDeTipo — cubre los 31 valores de TIPOS_MOVIMIENTO', () => {
  it('devuelve un texto no vacío para cada tipo, sin repetir "Indeterminado"', () => {
    for (const tipo of TIPOS_MOVIMIENTO) {
      const texto = textoDeTipo(tipo);
      expect(texto.length).toBeGreaterThan(0);
      // "Indeterminado" está reservado a la clase sin_reconocer (sin tipo) — el tipo `indeterminado`
      // (uno de los 31) usa otra palabra a propósito, para no confundir las dos causas distintas.
      expect(texto).not.toBe(TEXTO_SIN_TIPO);
    }
  });

  it('retiro_de_socio / aporte_de_socio llevan el calificador "(según padrón)" — contador-dominio: ' +
    'es un match algorítmico, no un hecho verificado externamente', () => {
    expect(textoDeTipo('retiro_de_socio')).toContain('(según padrón)');
    expect(textoDeTipo('aporte_de_socio')).toContain('(según padrón)');
  });
});

describe('textoDeQueDecide — cubre los 8 valores de QUE_DECIDE', () => {
  function decisionHumana(queDecide: (typeof QUE_DECIDE)[number], extra: Partial<Reconocimiento> = {}) {
    return {
      clase: 'decision_humana' as const,
      tipo: 'comision_bancaria' as TipoMovimiento,
      concepto: 'comision_de_transferencia',
      polaridad: 'normal' as const,
      lado: 'debe' as const,
      via: 'texto_literal_exacto' as const,
      evidencia: EVIDENCIA_DE_PRUEBA,
      queDecide,
      ...extra,
    } as Extract<Reconocimiento, { clase: 'decision_humana' }>;
  }

  it('cada uno de los 7 valores distintos de distinguir_tercero_de_socio da un texto propio', () => {
    for (const queDecide of QUE_DECIDE) {
      if (queDecide === 'distinguir_tercero_de_socio') continue;
      const texto = textoDeQueDecide(decisionHumana(queDecide));
      expect(texto.length).toBeGreaterThan(0);
    }
  });

  it('distinguir_tercero_de_socio: sin evidenciaContrapartida usa el texto genérico', () => {
    const texto = textoDeQueDecide(decisionHumana('distinguir_tercero_de_socio'));
    expect(texto).toContain('Depende del padrón de socios');
  });

  it.each([
    ['sin_candidatos', 'buscá el comprobante para identificar de quién es'],
    ['sin_match_padron_incompleto', 'completalo y volvé a correr'],
    ['multiples_socios', 'partí el movimiento entre varios'],
    ['socio_fuera_de_vigencia', 'ex-socio'],
    ['pepper_desalineado', 'Avisale a sistemas'],
  ] as const)('distinguir_tercero_de_socio con estado=%s da un texto específico y accionable', (estado, fragmento) => {
    const texto = textoDeQueDecide(
      decisionHumana('distinguir_tercero_de_socio', {
        evidenciaContrapartida:
          estado === 'multiples_socios' || estado === 'socio_fuera_de_vigencia'
            ? ({ estado, matches: [] } as never)
            : estado === 'pepper_desalineado'
              ? ({ estado, pepperIdsCandidatos: [], pepperIdsPadron: [] } as never)
              : ({ estado } as never),
      }),
    );
    expect(texto).toContain(fragmento);
  });

  it('🔴 mutation test real: confirmar_hipotesis_del_lexico NUNCA usa pendienteDeLaura.pregunta, ' +
    'aunque el Reconocimiento la traiga — dictamen bloqueante de seguridad-datos-financieros', () => {
    const r = decisionHumana('confirmar_hipotesis_del_lexico', {
      pendienteDeLaura: {
        pregunta: 'PREGUNTA-CANARIO-QUE-NUNCA-TIENE-QUE-APARECER-EN-EL-TEXTO',
        hipotesis: 'hipótesis interna',
        referencia: 'docs/x.md',
        desde: '2026-01-01',
      },
    });
    const texto = textoDeQueDecide(r);
    expect(texto).not.toContain('PREGUNTA-CANARIO');
    expect(texto).toContain('no hay evidencia suficiente para confirmarla');
  });
});

describe('textoDeMotivoSinReconocer — cubre los 7 valores de MOTIVOS_SIN_RECONOCER', () => {
  it('cada motivo da un texto propio, no vacío', () => {
    for (const motivo of MOTIVOS_SIN_RECONOCER) {
      expect(textoDeMotivoSinReconocer(motivo).length).toBeGreaterThan(0);
    }
  });
});

describe('textoDeReconocimiento — las tres columnas, por clase', () => {
  it('propuesta: identificación con el tipo, "confianza" Alta, "pendiente" siempre null', () => {
    const r: Reconocimiento = {
      clase: 'propuesta',
      tipo: 'comision_bancaria',
      concepto: 'comision_de_transferencia',
      polaridad: 'normal',
      lado: 'debe',
      via: 'texto_literal_exacto',
      evidencia: EVIDENCIA_DE_PRUEBA,
    };
    expect(textoDeReconocimiento(r)).toEqual({ identificacion: 'Comisión bancaria', confianza: 'Alta', pendiente: null });
  });

  it('decision_humana: identificación con el tipo, "pendiente" con el texto de queDecide', () => {
    const r: Reconocimiento = {
      clase: 'decision_humana',
      tipo: 'acreditacion_tarjeta',
      concepto: 'acreditamiento',
      polaridad: 'normal',
      lado: 'haber',
      via: 'texto_literal_exacto',
      evidencia: EVIDENCIA_DE_PRUEBA,
      queDecide: 'completar_con_liquidacion_del_adquirente',
    };
    const texto = textoDeReconocimiento(r);
    expect(texto.identificacion).toBe('Acreditación de tarjeta (cobro con tarjeta)');
    expect(texto.pendiente).not.toBeNull();
  });

  it('sin_reconocer: identificación "Indeterminado", "confianza" null, "pendiente" con el motivo', () => {
    const r: Reconocimiento = { clase: 'sin_reconocer', motivo: 'ambiguo', candidatos: ['a', 'b'], evidencia: undefined };
    expect(textoDeReconocimiento(r)).toEqual({
      identificacion: TEXTO_SIN_TIPO,
      confianza: null,
      pendiente: textoDeMotivoSinReconocer('ambiguo'),
    });
  });

  // Ajuste 7 (JP + ux-designer + contador-dominio, HANDOFF 95): "confianza" reemplaza al calificador
  // "(sin confirmar)" del ajuste 6 — el sufijo rompía el filtro de Excel por "Tipo de movimiento"
  // ("Cobranza de cliente" vs. "Cobranza de cliente (sin confirmar)" eran dos valores DISTINTOS).
  // "identificacion" nunca lleva el calificador ahora, sin importar queDecide.
  it.each(['confirmar_hipotesis_del_lexico', 'distinguir_tercero_de_socio'] as const)(
    'decision_humana con queDecide=%s: "confianza" es "A confirmar" — el tipo es un default, no un hecho — e "identificacion" NUNCA lleva sufijo',
    (queDecide) => {
      const r: Reconocimiento = {
        clase: 'decision_humana',
        tipo: 'pago_a_proveedor_transferencia',
        concepto: 'comision_de_transferencia',
        polaridad: 'normal',
        lado: 'debe',
        via: 'texto_literal_exacto',
        evidencia: EVIDENCIA_DE_PRUEBA,
        queDecide,
      };
      const texto = textoDeReconocimiento(r);
      expect(texto.identificacion).toBe('Pago a proveedor (transferencia)');
      expect(texto.confianza).toBe('A confirmar');
    },
  );

  it('decision_humana con los otros 6 valores de QueDecide: "confianza" es "Alta" — el tipo ya es firme', () => {
    const otros = [
      'elegir_cuenta_de_pasivo_del_impuesto',
      'confirmar_cuenta_propia_destino',
      'completar_con_liquidacion_del_adquirente',
      'confirmar_computo_de_credito_fiscal',
      'elegir_jurisdiccion_de_la_retencion',
      'completar_con_liquidacion_de_la_tarjeta',
    ] as const;
    for (const queDecide of otros) {
      const r: Reconocimiento = {
        clase: 'decision_humana',
        tipo: 'pago_de_obligacion_fiscal',
        concepto: 'comision_de_transferencia',
        polaridad: 'normal',
        lado: 'debe',
        via: 'texto_literal_exacto',
        evidencia: EVIDENCIA_DE_PRUEBA,
        queDecide,
      };
      const texto = textoDeReconocimiento(r);
      expect(texto.confianza).toBe('Alta');
      expect(texto.identificacion).toBe('Pago de obligación fiscal');
    }
  });

  it('🔴 caso real que reportó JP: el filtro de Excel por "Tipo de movimiento" agrupa todo bajo el ' +
    'mismo valor, sin importar la confianza — "identificacion" es idéntica con y sin queDecide de ' +
    'identidad no confirmada, para el mismo tipo', () => {
    const base = {
      clase: 'decision_humana' as const,
      tipo: 'cobranza_de_cliente' as const,
      concepto: 'comision_de_transferencia' as const,
      polaridad: 'normal' as const,
      lado: 'haber' as const,
      via: 'texto_literal_exacto' as const,
      evidencia: EVIDENCIA_DE_PRUEBA,
    };
    const altaConfianza = textoDeReconocimiento({ ...base, queDecide: 'confirmar_computo_de_credito_fiscal' });
    const aConfirmar = textoDeReconocimiento({ ...base, queDecide: 'distinguir_tercero_de_socio' });
    expect(altaConfianza.identificacion).toBe(aConfirmar.identificacion);
    expect(altaConfianza.confianza).not.toBe(aConfirmar.confianza);
  });
});
