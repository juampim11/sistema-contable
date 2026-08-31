/**
 * Resolver puro de Capa D — tests en memoria, sin base (mismo estilo que
 * `packages/contabilidad/tests/*.test.ts`: literales de `Reconocimiento` a mano). Primer paso
 * revertible del Ítem E (Sesión 2b) — el servicio de I/O y el tenant sintético son el paso
 * siguiente, después de que este resolver tenga tests verdes.
 *
 * Diseño validado por convocatoria real: `arquitecto-software` (límite de paquete),
 * `motor-conciliacion-contable` (firma, tensión score/D-31), `contador-dominio` (overlay de
 * especificidad, prioridad banco-primero). Ver `docs/diseno/28-diseno-motor-clasificacion.md`
 * D-26/D-29/D-31.
 */

import { describe, expect, it } from 'vitest';
import type { Reconocimiento } from '@sistema-contable/contabilidad';
import {
  resolverAsiento,
  type CuentaBancariaResuelta,
  type CuentaDelPlan,
  type EntradaResolver,
  type MovimientoParaResolver,
  type ReglaImputacion,
} from '../src/resolver.ts';

const EVIDENCIA = { entradaLexicoId: 'e1', caracteresMatcheados: 5, huboCola: false } as const;

function propuesta(
  overrides: Partial<Extract<Reconocimiento, { clase: 'propuesta' }>> = {},
): Reconocimiento {
  return {
    clase: 'propuesta',
    tipo: 'comision_bancaria',
    concepto: 'comision_de_mantenimiento_de_cuenta',
    polaridad: 'normal',
    lado: 'debe',
    via: 'texto_literal_exacto',
    evidencia: { ...EVIDENCIA, via: 'texto_literal_exacto' },
    ...overrides,
  };
}

const MOVIMIENTO: MovimientoParaResolver = {
  movimientoId: 'mov-1',
  clienteId: 'cliente-A',
  fecha: '2026-06-15',
  importe: '1500.00',
  cuentaBancariaId: 'cb-1',
};

const BANCO_OK: CuentaBancariaResuelta = { cuentaBancariaId: 'cb-1', cuentaId: 'cuenta-banco' };
const BANCO_SIN_MAPEAR: CuentaBancariaResuelta = { cuentaBancariaId: 'cb-1', cuentaId: null };

const PLAN_BASICO: readonly CuentaDelPlan[] = [
  {
    cuentaId: 'cuenta-banco',
    codigo: '1.1.2.100',
    denominacion: 'Banco Ficticio Cta Cte',
    rolFuncional: 'generica',
    activa: true,
    vigenteDesde: '2026-01-01',
    vigenteHasta: null,
  },
  {
    cuentaId: 'cuenta-gastos-bancarios',
    codigo: '4.2.5.200',
    denominacion: 'Gastos y comisiones bancarias',
    rolFuncional: 'generica',
    activa: true,
    vigenteDesde: '2026-01-01',
    vigenteHasta: null,
  },
  {
    cuentaId: 'cuenta-retiro-socio',
    codigo: '2.1.9.100',
    denominacion: 'Cuenta Particular Socio 1',
    rolFuncional: 'retiro_de_socio',
    activa: true,
    vigenteDesde: '2026-01-01',
    vigenteHasta: null,
  },
];

function reglaFija(overrides: Partial<ReglaImputacion> = {}): ReglaImputacion {
  return {
    id: 'regla-1',
    tipoMovimiento: 'comision_bancaria',
    concepto: null,
    cuentaResolucion: 'fija',
    cuentaId: 'cuenta-gastos-bancarios',
    vigenteDesde: '2026-01-01',
    vigenteHasta: null,
    ...overrides,
  };
}

function entrada(overrides: Partial<EntradaResolver> = {}): EntradaResolver {
  return {
    reconocimiento: propuesta(),
    movimiento: MOVIMIENTO,
    cuentaBancaria: BANCO_OK,
    reglasImputacion: [reglaFija()],
    planDeCuentas: PLAN_BASICO,
    ...overrides,
  };
}

describe('camino feliz — cardinalidad cerrada, regla fija, vía calificada', () => {
  it('resuelve automático con debe/haber correctos (04§2: lado del renglón imputado = columna; banco es el opuesto)', () => {
    const resultado = resolverAsiento(entrada());
    expect(resultado.tipo).toBe('automatico');
    if (resultado.tipo !== 'automatico') return;

    const [banco, contrapartida] = resultado.renglones;
    expect(banco.cuentaId).toBe('cuenta-banco');
    expect(contrapartida.cuentaId).toBe('cuenta-gastos-bancarios');
    // reconocimiento.lado='debe' es el lado de la CONTRAPARTIDA (04§2) — banco es el opuesto.
    expect(contrapartida.lado).toBe('debe');
    expect(banco.lado).toBe('haber');
    expect(banco.importe).toBe('1500.00');
    expect(contrapartida.cuentaRef).toEqual({
      codigo: '4.2.5.200',
      denominacion: 'Gastos y comisiones bancarias',
      rolFuncional: 'generica',
    });
  });

  it('si el lado del reconocimiento es haber, banco queda en debe (inversión simétrica)', () => {
    const resultado = resolverAsiento(entrada({ reconocimiento: propuesta({ lado: 'haber' }) }));
    expect(resultado.tipo).toBe('automatico');
    if (resultado.tipo !== 'automatico') return;
    const [banco, contrapartida] = resultado.renglones;
    expect(contrapartida.lado).toBe('haber');
    expect(banco.lado).toBe('debe');
  });
});

describe('cardinalidad abierta — predicción falsable del plan: nunca se auto-resuelve', () => {
  it('pago_a_proveedor_transferencia SIN regla cargada cae a tipo_sin_regla_imputacion, nunca automático', () => {
    const resultado = resolverAsiento(
      entrada({
        reconocimiento: propuesta({ tipo: 'pago_a_proveedor_transferencia', concepto: 'pago_a_proveedor_inmediato' }),
        reglasImputacion: [], // a propósito: nadie configura una regla estática para cardinalidad abierta
      }),
    );
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('tipo_sin_regla_imputacion');
  });
});

describe('familia socio — veto duro de D-31, sin importar candidatas', () => {
  it('regla por_socio con exactamente 1 candidata igual cae a resolucion_manual_obligatoria_socio', () => {
    const resultado = resolverAsiento(
      entrada({
        reconocimiento: propuesta({ tipo: 'retiro_de_socio', concepto: 'transferencia_a_terceros' }),
        reglasImputacion: [
          reglaFija({
            id: 'regla-socio',
            tipoMovimiento: 'retiro_de_socio',
            cuentaResolucion: 'por_socio',
            cuentaId: null,
          }),
        ],
      }),
    );
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    // Predicción falsable del plan: si esto diera 'cuenta_ambigua' en vez del veto exclusivo, el
    // veto se implementó como caso de ambigüedad, no como control de diseño — sería un bug real.
    expect(resultado.motivoCodigo).toBe('resolucion_manual_obligatoria_socio');
  });

  it('defensivo: una regla FIJA que por error apunta a una cuenta ligada a un socio también vetea', () => {
    const resultado = resolverAsiento(
      entrada({
        reglasImputacion: [reglaFija({ cuentaId: 'cuenta-retiro-socio' })], // mal configurada a propósito
      }),
    );
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('resolucion_manual_obligatoria_socio');
  });

  it("'por_jurisdiccion'/'por_impuesto' NO vetean como socio — cuentan como regla no utilizable (0 candidatas)", () => {
    const resultado = resolverAsiento(
      entrada({
        reglasImputacion: [reglaFija({ cuentaResolucion: 'por_jurisdiccion', cuentaId: null })],
      }),
    );
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('tipo_sin_regla_imputacion');
  });
});

describe('vía no calificada — D-31: solo 4 de 6 vías califican para automático', () => {
  it('cuenta resuelve perfecto pero la vía no califica → via_no_calificada, no cuenta_ambigua', () => {
    const resultado = resolverAsiento(
      entrada({ reconocimiento: propuesta({ via: 'texto_prefijo_con_cola' }) }),
    );
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('via_no_calificada');
  });
});

describe('pata banco', () => {
  it('sin mapear → cuenta_bancaria_no_configurada', () => {
    const resultado = resolverAsiento(entrada({ cuentaBancaria: BANCO_SIN_MAPEAR }));
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('cuenta_bancaria_no_configurada');
  });

  it('prioridad banco-primero (contador-dominio): si fallan banco Y contrapartida, reporta banco, con nota de que la otra también fallaba', () => {
    const resultado = resolverAsiento(
      entrada({
        cuentaBancaria: BANCO_SIN_MAPEAR,
        reglasImputacion: [], // contrapartida también sin resolver
      }),
    );
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('cuenta_bancaria_no_configurada');
    expect(resultado.evidencia.contrapartidaTambienFallaba).toBe(true);
  });
});

describe('pata contrapartida — cuenta_no_configurada vs. tipo_sin_regla_imputacion (D-28, semántica disjunta)', () => {
  it('regla vigente pero apunta a una cuenta que no existe en el plan → cuenta_no_configurada (hay que CORREGIR la regla)', () => {
    const resultado = resolverAsiento(entrada({ reglasImputacion: [reglaFija({ cuentaId: 'cuenta-fantasma' })] }));
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('cuenta_no_configurada');
  });

  it('regla vencida a la fecha del movimiento → tipo_sin_regla_imputacion (hay que CREARLA/renovarla)', () => {
    const resultado = resolverAsiento(
      entrada({ reglasImputacion: [reglaFija({ vigenteHasta: '2026-03-01' })] }), // venció antes del movimiento (junio)
    );
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('tipo_sin_regla_imputacion');
  });
});

describe('cliente sin plan de cuentas — evaluado ANTES que cualquier regla (analista-funcional, prioridad de evaluación)', () => {
  it('CTA=∅ → cliente_sin_plan_de_cuentas, nunca tipo_sin_regla_imputacion aunque también sea 0 candidatas', () => {
    const resultado = resolverAsiento(entrada({ planDeCuentas: [] }));
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('cliente_sin_plan_de_cuentas');
  });
});

describe('overlay de especificidad — concepto exacto gana sobre general (contador-dominio)', () => {
  const reglaGeneral = reglaFija({ id: 'regla-general', concepto: null, cuentaId: 'cuenta-gastos-bancarios' });
  const reglaEspecifica = reglaFija({
    id: 'regla-especifica',
    concepto: 'comision_de_mantenimiento_de_cuenta',
    cuentaId: 'cuenta-banco', // distinta a propósito, para poder distinguir cuál ganó
  });

  it('con las dos vigentes a la vez, gana la de concepto exacto, y la evidencia cita la descartada', () => {
    const resultado = resolverAsiento(
      entrada({
        reconocimiento: propuesta({ concepto: 'comision_de_mantenimiento_de_cuenta' }),
        reglasImputacion: [reglaGeneral, reglaEspecifica],
      }),
    );
    expect(resultado.tipo).toBe('automatico');
    if (resultado.tipo !== 'automatico') return;
    expect(resultado.evidencia.reglaContrapartidaAplicada).toEqual({
      reglaId: 'regla-especifica',
      especificidad: 'concepto_exacto',
    });
    expect(resultado.evidencia.reglaContrapartidaDescartada).toEqual({ reglaId: 'regla-general' });
  });

  it('sin la específica, usa la general', () => {
    const resultado = resolverAsiento(
      entrada({
        reconocimiento: propuesta({ concepto: 'comision_de_mantenimiento_de_cuenta' }),
        reglasImputacion: [reglaGeneral],
      }),
    );
    expect(resultado.tipo).toBe('automatico');
    if (resultado.tipo !== 'automatico') return;
    expect(resultado.evidencia.reglaContrapartidaAplicada?.especificidad).toBe('concepto_general');
  });
});

describe('cuenta_ambigua — defensivo, dos reglas de la misma especificidad a la vez (no debería pasar con la unicidad real de la base, pero el resolver no confía en eso)', () => {
  it('dos reglas concepto-general vigentes al mismo tiempo para el mismo tipo → cuenta_ambigua', () => {
    const resultado = resolverAsiento(
      entrada({
        reglasImputacion: [
          reglaFija({ id: 'regla-x', concepto: null, cuentaId: 'cuenta-banco' }),
          reglaFija({ id: 'regla-y', concepto: null, cuentaId: 'cuenta-gastos-bancarios' }),
        ],
      }),
    );
    expect(resultado.tipo).toBe('pendiente');
    if (resultado.tipo !== 'pendiente') return;
    expect(resultado.motivoCodigo).toBe('cuenta_ambigua');
    expect(resultado.evidencia.candidatosContrapartida).toHaveLength(2);
  });
});

describe('clase distinta de propuesta — fuera de alcance de esta versión (D-28, bloqueado)', () => {
  it('decision_humana nunca produce efecto automático', () => {
    const reconocimientoDecisionHumana: Reconocimiento = {
      clase: 'decision_humana',
      tipo: 'pago_a_proveedor_transferencia',
      concepto: 'pago_a_proveedor_inmediato',
      polaridad: 'normal',
      lado: 'debe',
      via: 'texto_literal_exacto',
      evidencia: { ...EVIDENCIA, via: 'texto_literal_exacto' },
      queDecide: 'distinguir_tercero_de_socio',
    };
    const resultado = resolverAsiento(entrada({ reconocimiento: reconocimientoDecisionHumana }));
    expect(resultado.tipo).toBe('pendiente');
  });

  it('sin_reconocer nunca produce efecto automático', () => {
    const reconocimientoSinReconocer: Reconocimiento = {
      clase: 'sin_reconocer',
      motivo: 'concepto_no_catalogado',
      candidatos: [],
      evidencia: undefined,
    };
    const resultado = resolverAsiento(entrada({ reconocimiento: reconocimientoSinReconocer }));
    expect(resultado.tipo).toBe('pendiente');
  });
});
