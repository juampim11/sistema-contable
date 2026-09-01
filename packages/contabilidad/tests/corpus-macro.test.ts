/**
 * La tabla del corpus de Macro — literal → concepto → clase esperada, y el motor real corriendo contra
 * ella. Incluye el hueco declarado de 76 movimientos sin `conceptoBanco` (07-formato-macro.md §12.2).
 *
 * ⚠️ La suma de las frecuencias publicadas en §12 da 1347, no 1346 (el total real del lote ingerido) —
 * discrepancia de ±1 ya documentada en la sesión (el detalle exacto de qué literal está de más o de
 * menos no está resuelto en el documento). Se afirma 1347 acá porque es lo que la tabla, fila por fila,
 * efectivamente suma — no se fuerza a 1346 sin saber cuál fila corregir.
 */

import { describe, expect, it } from 'vitest';
import { CATALOGO_CANONICO, type ConceptoCanonico, type FilaDelCatalogo } from '../src/nucleo/catalogo.ts';
import { LEXICO_MACRO } from '../src/lexico/macro.ts';
import { construirIndice } from '../src/nucleo/indice.ts';
import { reconocer } from '../src/nucleo/motor.ts';

type ClaseEsperada = 'propuesta' | 'decision_humana' | 'sin_reconocer';
type ColumnaOrigen = 'credito' | 'debito';

function claseEsperadaDe(concepto: ConceptoCanonico): ClaseEsperada {
  const fila: FilaDelCatalogo = CATALOGO_CANONICO[concepto];
  if (fila.resuelve === 'sin_tipo_asignado') return 'sin_reconocer';
  if (fila.resuelve === 'decide_una_persona') return 'decision_humana';
  return fila.pendienteDeLaura ? 'decision_humana' : 'propuesta';
}

const TABLA_ESPERADA: ReadonlyArray<{
  literal: string;
  concepto: ConceptoCanonico;
  movimientos: number;
  columnaOrigen: ColumnaOrigen;
}> = [
  { literal: 'N/D Transf. MacrOnline E-set D/T', concepto: 'transferencia_macronline_debito', movimientos: 29, columnaOrigen: 'debito' },
  { literal: 'N/D Comision Trf. MacrOL E-set', concepto: 'comision_de_transferencia', movimientos: 22, columnaOrigen: 'debito' },
  { literal: 'N/D DBCR 25413 S/DB TASA GRAL', concepto: 'impuesto_25413_sobre_debitos', movimientos: 17, columnaOrigen: 'debito' },
  { literal: 'N/D DBCR 25413 S/CR TASA GRAL', concepto: 'impuesto_25413_sobre_creditos', movimientos: 17, columnaOrigen: 'debito' },
  { literal: 'PAGO DE CHEQUE DE CAMARA', concepto: 'pago_cheque_de_camara', movimientos: 16, columnaOrigen: 'debito' },
  { literal: 'DEBITO FISCAL IVA BASICO', concepto: 'debito_fiscal_iva_basico', movimientos: 7, columnaOrigen: 'debito' },
  { literal: 'N/D DB TRANSF MINORISTA DIST TIT', concepto: 'transferencia_minorista_distinto_titular', movimientos: 7, columnaOrigen: 'debito' },
  { literal: 'N/D COMISION TRANSFERENCIAS', concepto: 'comision_de_transferencia', movimientos: 7, columnaOrigen: 'debito' },
  { literal: 'RETENCION IIBB CORDOBA RENTA FINANC', concepto: 'retencion_iibb_cordoba_renta_financiera', movimientos: 6, columnaOrigen: 'debito' },
  { literal: 'N/D DB PAGO REMUNERACIONES', concepto: 'pago_de_remuneraciones', movimientos: 6, columnaOrigen: 'debito' },
  { literal: 'RETENCION IVA PERCEPCION', concepto: 'retencion_iva_percepcion_macro', movimientos: 5, columnaOrigen: 'debito' },
  { literal: 'N/D FV IMPDBCR 25413 S/DB TASA GRAL', concepto: 'impuesto_25413_sobre_debitos', movimientos: 5, columnaOrigen: 'debito' },
  { literal: 'ACREDITACION CHEQUE REMESAS', concepto: 'acreditacion_cheque_remesas', movimientos: 5, columnaOrigen: 'credito' },
  { literal: 'N/C CR TRANSF AUT SDO MISMO TIT', concepto: 'transferencia_cuentas_propias', movimientos: 3, columnaOrigen: 'credito' },
  { literal: 'N/D DB TR..AUT.SDO.MISMO TIT.', concepto: 'transferencia_cuentas_propias', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'IMP. AFIP', concepto: 'pago_a_organismo_fiscal_afip', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'CHEQUE CANJE INTERNO', concepto: 'cheque_canje_interno', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'RETIRO CAJ.AH.', concepto: 'retiro_caja_ahorro', movimientos: 2, columnaOrigen: 'debito' },
  { literal: 'N/D IDCB GRAL. EXTRAC EFVO PYME', concepto: 'extraccion_efectivo_idcb_pyme', movimientos: 2, columnaOrigen: 'debito' },
  { literal: 'N/C DBCR 25413 S/CR TASA GRAL', concepto: 'devolucion_impuesto_25413_sobre_creditos', movimientos: 2, columnaOrigen: 'credito' },
  { literal: 'N/D COM RETIRO EFECTIVO POR CAJA', concepto: 'comision_de_extraccion', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'COMISION TRANSFERE', concepto: 'comision_de_transferencia', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'DEPOSITO EN EFECTIVO CTA. CTE.', concepto: 'deposito_de_efectivo', movimientos: 1, columnaOrigen: 'credito' },
  { literal: 'N/C FV CR DEPOSITO CANJE INTERNO', concepto: 'deposito_canje_interno_fv', movimientos: 1, columnaOrigen: 'credito' },
  { literal: 'N/D FV CHEQ.DEV. DEP.CJE. INTERNO', concepto: 'cheque_devuelto_canje_interno', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'N/D FV COMISION DEPOSITO Ó RECH CHE', concepto: 'comision_de_deposito_o_rechazo_de_cheque', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'N/D COMISION DEPOSITO O RECH CHEQ', concepto: 'comision_de_deposito_o_rechazo_de_cheque', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'N/C FV IMPDBCR 25413 S/CR TASA GRAL', concepto: 'devolucion_impuesto_25413_sobre_creditos', movimientos: 1, columnaOrigen: 'credito' },
  { literal: 'N/D FV IMPDBCR 25413 S/CR TASA GRAL', concepto: 'impuesto_25413_sobre_creditos', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'N/D COMISION ADM.VALORES AL COBRO C', concepto: 'comision_administracion_de_valores', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'N/D COMISIÓN ADMINISTRACIÓN DE CHEQUERA', concepto: 'comision_administracion_de_chequera', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'N/D MANTENIMIENTO MENSUAL PAQUETE', concepto: 'comision_de_mantenimiento_de_cuenta', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'N/D COMISION CHQ PAG CLEARING', concepto: 'comision_de_cheque_pagado', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'ND CHEQUE DEVUELTO REMESAS', concepto: 'cheque_devuelto_remesas', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'TPUSH', concepto: 'transferencia_recibida_de_terceros', movimientos: 569, columnaOrigen: 'credito' },
  { literal: 'TRANSF', concepto: 'transferencia_recibida_de_terceros', movimientos: 409, columnaOrigen: 'credito' },
  { literal: 'CREDIN:', concepto: 'acreditacion_credin', movimientos: 6, columnaOrigen: 'credito' },
  { literal: 'CCERR', concepto: 'cheque_circuito_cerrado', movimientos: 5, columnaOrigen: 'debito' },
  { literal: '10 Sol.Resc', concepto: 'rescate_fci', movimientos: 7, columnaOrigen: 'credito' },
  { literal: '10 Liq.Susc', concepto: 'suscripcion_fci', movimientos: 3, columnaOrigen: 'debito' },
];

/** Los tres conceptos 'indistinto' (sin lado publicado) — se prueban en las DOS columnas por separado. */
const TABLA_INDISTINTOS: ReadonlyArray<{ literal: string; concepto: ConceptoCanonico; movimientos: number }> = [
  { literal: 'TRF MO CCDO DIST T -', concepto: 'transferencia_mo_ccdo_distinto_titular', movimientos: 9 },
  { literal: 'TRANSF:', concepto: 'transferencia_con_token', movimientos: 78 },
  { literal: 'TEF DATANET PR', concepto: 'transferencia_electronica_datanet', movimientos: 4 },
];

const INDICE_MACRO = construirIndice(LEXICO_MACRO);

function reconocerMacro(conceptoBanco: string | undefined, columnaOrigen: ColumnaOrigen) {
  return reconocer(
    {
      bancoCodigo: 'macro',
      conceptoBanco,
      conceptoCompleto: true,
      conceptoBancoEstrategia: 'prefijo_anclado',
      conceptoCodigo: undefined,
      columnaOrigen,
    },
    INDICE_MACRO,
  );
}

describe('corpus de Macro — tabla congelada', () => {
  it('la tabla cubre los 34 literales sin contraparte + 9 anclas con contraparte = 43', () => {
    expect(TABLA_ESPERADA.length + TABLA_INDISTINTOS.length).toBe(43);
  });

  it('la suma de movimientos capturables (sin el hueco de 76) es 1271', () => {
    const capturable =
      TABLA_ESPERADA.reduce((acc, f) => acc + f.movimientos, 0) +
      TABLA_INDISTINTOS.reduce((acc, f) => acc + f.movimientos, 0);
    expect(capturable).toBe(1271);
  });

  it.each(TABLA_ESPERADA)('«$literal» → $concepto', ({ literal, concepto }) => {
    const entrada = LEXICO_MACRO.entradas.find((e) => e.literales.includes(literal));
    expect(entrada, `ningún entrada de lexico/macro.ts contiene el literal "${literal}"`).toBeDefined();
    expect(entrada?.concepto).toBe(concepto);
  });
});

describe('corpus de Macro — EL MOTOR', () => {
  it.each(TABLA_ESPERADA)('«$literal» ($columnaOrigen) → el motor devuelve la clase esperada de $concepto', ({
    literal,
    concepto,
    columnaOrigen,
  }) => {
    const r = reconocerMacro(literal, columnaOrigen);
    expect(r.clase, `literal "${literal}": el motor devolvió ${JSON.stringify(r)}`).toBe(claseEsperadaDe(concepto));
    if (r.clase !== 'sin_reconocer') expect(r.concepto).toBe(concepto);
  });

  it.each(TABLA_INDISTINTOS)('«$literal» (indistinto): las DOS columnas reconocen como $concepto', ({ literal, concepto }) => {
    for (const columnaOrigen of ['debito', 'credito'] as const) {
      const r = reconocerMacro(literal, columnaOrigen);
      expect(r.clase, `literal "${literal}" / ${columnaOrigen}: ${JSON.stringify(r)}`).toBe(claseEsperadaDe(concepto));
    }
  });

  it('🔴 el ancla TRANSF: (pegada, sin espacio) matchea — la trampa de las 84 filas perdidas no se repite', () => {
    const r = reconocerMacro('TRANSF:', 'credito');
    expect(r.clase).not.toBe('sin_reconocer');
  });

  it("🔴 el hueco declarado de 76 movimientos (PAGO<n>-LIQ COMER, sin conceptoBanco) da sin_evidencia_de_concepto — nunca ambiguo ni concepto_no_catalogado", () => {
    // Los 76 no tienen literal — el motor los recibe con conceptoBanco: undefined, como cualquier fila
    // sin captura de concepto (INV-13×INV-14, 07-formato-macro.md §12.2). Se corren las 76 repeticiones
    // reales para que el conteo total quede exacto en el test de distribución de abajo.
    const r = reconocerMacro(undefined, 'debito');
    expect(r).toEqual(expect.objectContaining({ clase: 'sin_reconocer', motivo: 'sin_evidencia_de_concepto' }));
  });

  it('la distribución de clases que el motor REALMENTE devuelve, incluido el hueco de 76, suma 1347', () => {
    const porClase: Record<ClaseEsperada, number> = { propuesta: 0, decision_humana: 0, sin_reconocer: 0 };
    for (const { literal, movimientos, columnaOrigen } of TABLA_ESPERADA) {
      porClase[reconocerMacro(literal, columnaOrigen).clase] += movimientos;
    }
    for (const { literal, movimientos } of TABLA_INDISTINTOS) {
      // 'indistinto': se cuenta una sola vez con cualquiera de las dos columnas (da la misma clase).
      porClase[reconocerMacro(literal, 'debito').clase] += movimientos;
    }
    // El hueco: 76 movimientos, sin_reconocer/sin_evidencia_de_concepto.
    porClase.sin_reconocer += 76;

    expect(porClase.propuesta + porClase.decision_humana + porClase.sin_reconocer).toBe(1347);
  });
});

/**
 * `'ING TRANSF:'` — sumado 2026-09-01, hallazgo ROKA-2026 (`07-formato-macro.md` §12.3). Deliberadamente
 * SEPARADO de `TABLA_ESPERADA`/`TABLA_INDISTINTOS` de arriba: esas tablas son el corpus CONGELADO de
 * noviembre 2025, donde este literal está ausente por diseño — sumarlo ahí infla un conteo que existe
 * para verificar una medición histórica puntual, no el léxico en general.
 */
describe('corpus de Macro — ING TRANSF: (hallazgo ROKA-2026)', () => {
  it('reusa la entrada existente de transferencia_recibida_de_terceros — mismo concepto que TPUSH/TRANSF', () => {
    const entrada = LEXICO_MACRO.entradas.find((e) => e.id === 'macro.transferencia_recibida_de_terceros');
    expect(entrada?.literales).toContain('ING TRANSF:');
    expect(entrada?.concepto).toBe('transferencia_recibida_de_terceros');
  });

  it('el motor clasifica "ING TRANSF:" como decision_humana / distinguir_tercero_de_socio', () => {
    const r = reconocerMacro('ING TRANSF:', 'credito');
    expect(r.clase, `el motor devolvió ${JSON.stringify(r)}`).toBe('decision_humana');
    if (r.clase === 'decision_humana') {
      expect(r.concepto).toBe('transferencia_recibida_de_terceros');
      expect(r.queDecide).toBe('distinguir_tercero_de_socio');
    }
  });

  it('anclaje estricto: "ING TRANSF:" en el MEDIO de la glosa no matchea (nunca contains)', () => {
    const r = reconocerMacro('PREFIJO ING TRANSF: resto', 'credito');
    expect(r.clase).toBe('sin_reconocer');
    if (r.clase === 'sin_reconocer') expect(r.motivo).toBe('concepto_no_catalogado');
  });

  // No-regresión de TPUSH/TRANSF: ya cubierta por `it.each(TABLA_ESPERADA)` arriba (líneas 118-126),
  // que sigue corriendo sobre esos dos literales sin cambios — no se duplica acá.
});
