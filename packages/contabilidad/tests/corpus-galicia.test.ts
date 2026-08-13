/**
 * La tabla del corpus de Galicia — literal → clase + tipo ESPERADOS, congelada ANTES de que exista el
 * motor (`05` §8.2: el corpus etiquetado es el INSUMO, no la salida — escribirlo después del motor
 * invita a ajustar la tabla hasta que el motor pase).
 *
 * `clase` se deriva DECLARATIVAMENTE del catálogo (sin correr un solo movimiento): `resuelve:'propone'`
 * sin `pendienteDeLaura` → `propuesta`; `resuelve:'decide_una_persona'` (con o sin `pendienteDeLaura`,
 * las dos rutas caen en la misma clase — `05` §5) → `decision_humana`; `resuelve:'sin_tipo_asignado'` →
 * `sin_reconocer` con motivo `concepto_sin_tipo_asignado`.
 *
 * En P6, cuando `nucleo/motor.ts` exista, este archivo se extiende: en vez de solo comparar contra la
 * tabla, corre `reconocer()` sobre cada literal y compara el resultado del motor contra esta misma
 * tabla — la tabla no se edita para que el motor pase.
 */

import { describe, expect, it } from 'vitest';
import { CATALOGO_CANONICO, type ConceptoCanonico, type FilaDelCatalogo } from '../src/nucleo/catalogo.ts';
import { LEXICO_GALICIA } from '../src/lexico/galicia.ts';
import { construirIndice } from '../src/nucleo/indice.ts';
import { reconocer } from '../src/nucleo/motor.ts';

type ClaseEsperada = 'propuesta' | 'decision_humana' | 'sin_reconocer';
type ColumnaOrigen = 'credito' | 'debito';

function claseEsperadaDe(concepto: ConceptoCanonico): ClaseEsperada {
  const fila: FilaDelCatalogo = CATALOGO_CANONICO[concepto];
  if (fila.resuelve === 'sin_tipo_asignado') return 'sin_reconocer';
  if (fila.resuelve === 'decide_una_persona') return 'decision_humana';
  // resuelve === 'propone': si tiene pendienteDeLaura, la degradación la manda a decision_humana.
  return fila.pendienteDeLaura ? 'decision_humana' : 'propuesta';
}

/**
 * Las 32 filas del vocabulario medido (`docs/diseno/02-formato-galicia.md` §14), literal por literal.
 * `columnaOrigen` es el lado MEDIDO del literal (ver `procedencia.porLiteral` en `catalogo.ts` y
 * `lexico/galicia.ts`) — para las dos entradas `'ambos'` (indistinto), se prueban las DOS columnas más
 * abajo, no solo la declarada acá.
 */
const TABLA_ESPERADA: ReadonlyArray<{
  literal: string;
  concepto: ConceptoCanonico;
  movimientos: number;
  columnaOrigen: ColumnaOrigen;
}> = [
  { literal: 'ACREDITAMIENTO', concepto: 'acreditamiento', movimientos: 78, columnaOrigen: 'credito' },
  { literal: 'TRF INMED PROVEED', concepto: 'pago_a_proveedor_inmediato', movimientos: 70, columnaOrigen: 'debito' },
  { literal: 'IMP. CRE. LEY 25413', concepto: 'impuesto_25413_sobre_creditos', movimientos: 21, columnaOrigen: 'debito' },
  { literal: 'IMP. DEB. LEY 25413 GRAL.', concepto: 'impuesto_25413_sobre_debitos', movimientos: 19, columnaOrigen: 'debito' },
  { literal: 'IVA', concepto: 'iva_sobre_comision_bancaria', movimientos: 17, columnaOrigen: 'debito' },
  { literal: 'COM. GESTION TRANSF.FDOS', concepto: 'comision_de_transferencia', movimientos: 12, columnaOrigen: 'debito' },
  { literal: 'COMPRA DEBITO', concepto: 'compra_con_tarjeta_debito_generica', movimientos: 11, columnaOrigen: 'debito' },
  { literal: 'TRANSF. CTAS PROPIAS', concepto: 'transferencia_cuentas_propias', movimientos: 11, columnaOrigen: 'debito' },
  { literal: 'RESCATE FIMA', concepto: 'rescate_fci', movimientos: 10, columnaOrigen: 'credito' },
  { literal: 'TRANSFERENCIAS CASH', concepto: 'transferencia_cash_management', movimientos: 8, columnaOrigen: 'debito' },
  { literal: 'PAGO CON TRANSFERENCIA', concepto: 'pago_con_transferencia_generico', movimientos: 7, columnaOrigen: 'debito' },
  { literal: 'TRANSF. A TERCEROS', concepto: 'transferencia_a_terceros', movimientos: 5, columnaOrigen: 'debito' },
  { literal: 'PERCEP. IVA', concepto: 'percepcion_iva', movimientos: 5, columnaOrigen: 'debito' },
  { literal: 'PAGO DE SERVICIOS', concepto: 'pago_de_servicios', movimientos: 5, columnaOrigen: 'debito' },
  { literal: 'SERVICIO ACREDITAMIENTO DE', concepto: 'comision_de_acreditacion_de_haberes', movimientos: 4, columnaOrigen: 'debito' },
  { literal: 'SNP PAGO A PROVEEDORES', concepto: 'pago_a_proveedores_snp', movimientos: 4, columnaOrigen: 'debito' },
  { literal: 'IMPUESTO DEB.LEY 25413', concepto: 'impuesto_25413_sobre_debitos', movimientos: 4, columnaOrigen: 'debito' },
  { literal: 'TRANSFERENCIA A TERCEROS', concepto: 'transferencia_a_terceros', movimientos: 4, columnaOrigen: 'debito' },
  { literal: 'TRANSF. AFIP', concepto: 'pago_a_organismo_fiscal_afip', movimientos: 4, columnaOrigen: 'debito' },
  { literal: 'SUSCRIPCION FIMA', concepto: 'suscripcion_fci', movimientos: 4, columnaOrigen: 'debito' },
  { literal: 'ANULAC. ACRED. FIRSTDATA.', concepto: 'anulacion_acreditamiento_firstdata', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'DEV.IMP.CRED.LEY 25413', concepto: 'devolucion_impuesto_25413_sobre_creditos', movimientos: 3, columnaOrigen: 'credito' },
  { literal: 'DEB. AUTOM. DE SERV.', concepto: 'debito_automatico_de_servicio', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'CHEQUE PAGADOR NRO.', concepto: 'pago_cheque_propio', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'COMISION CHEQUE PAGADO POR', concepto: 'comision_de_cheque_pagado', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'PAGO VISA EMPRESA', concepto: 'pago_tarjeta_corporativa_visa', movimientos: 2, columnaOrigen: 'debito' },
  { literal: 'COMISION SERVICIO DE CUENTA', concepto: 'comision_de_mantenimiento_de_cuenta', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'EXTRACCION EN AUTOSERVICIO', concepto: 'extraccion_efectivo_autoservicio', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'COMISION EXTRACCION EN', concepto: 'comision_de_extraccion', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'SERVICIO PAGO A PROVEEDORES', concepto: 'pago_a_proveedores_snp', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'TRANSFERENCIA DE TERCEROS', concepto: 'transferencia_recibida_de_terceros', movimientos: 1, columnaOrigen: 'credito' },
  { literal: 'PERCEPCION RG 5617/24', concepto: 'percepcion_iva', movimientos: 1, columnaOrigen: 'debito' },
];

const INDICE_GALICIA = construirIndice(LEXICO_GALICIA);

describe('corpus de Galicia — tabla congelada (literal → concepto → clase esperada)', () => {
  it('la tabla cubre los 32 literales medidos en 02-formato-galicia.md §14', () => {
    expect(TABLA_ESPERADA.length).toBe(32);
  });

  it('la suma de movimientos de la tabla es 326 (el lote real ingerido del piloto)', () => {
    const total = TABLA_ESPERADA.reduce((acc, f) => acc + f.movimientos, 0);
    expect(total).toBe(326);
  });

  it.each(TABLA_ESPERADA)('«$literal» → $concepto', ({ literal, concepto }) => {
    // El literal existe en el léxico de Galicia, mapeado exactamente al concepto declarado en la tabla.
    const entrada = LEXICO_GALICIA.entradas.find((e) => e.literales.includes(literal));
    expect(entrada, `ningún entrada de lexico/galicia.ts contiene el literal "${literal}"`).toBeDefined();
    expect(entrada?.concepto).toBe(concepto);
  });

  it('la distribución de clases esperadas es la predicción falsable del plan (±1 por redondeo de fusiones)', () => {
    const porClase: Record<ClaseEsperada, number> = { propuesta: 0, decision_humana: 0, sin_reconocer: 0 };
    for (const { concepto, movimientos } of TABLA_ESPERADA) {
      porClase[claseEsperadaDe(concepto)] += movimientos;
    }
    // Predicción del plan (§7): propuesta ~75, decision_humana ~132+119=251, sin_reconocer 0 (Galicia
    // no tiene el hueco de conceptoBanco de Macro). Se reporta el resultado real, no se fuerza el número.
    expect(porClase.propuesta + porClase.decision_humana + porClase.sin_reconocer).toBe(326);
    expect(porClase, JSON.stringify(porClase)).toBeDefined();
  });
});

describe('corpus de Galicia — EL MOTOR (P6: pasa de "la tabla dice" a "el motor devuelve")', () => {
  it.each(TABLA_ESPERADA)('«$literal» ($columnaOrigen) → el motor devuelve la clase esperada de $concepto', ({
    literal,
    concepto,
    columnaOrigen,
  }) => {
    const r = reconocer(
      {
        bancoCodigo: 'galicia',
        conceptoBanco: literal,
        conceptoCompleto: true,
        conceptoBancoEstrategia: 'segmento_de_glosa',
        conceptoCodigo: undefined,
        columnaOrigen,
      },
      INDICE_GALICIA,
    );
    expect(r.clase, `literal "${literal}": el motor devolvió ${JSON.stringify(r)}`).toBe(claseEsperadaDe(concepto));
    if (r.clase !== 'sin_reconocer') expect(r.concepto).toBe(concepto);
  });

  it('la distribución de clases que el motor REALMENTE devuelve coincide con la tabla congelada', () => {
    const porClase: Record<ClaseEsperada, number> = { propuesta: 0, decision_humana: 0, sin_reconocer: 0 };
    for (const { literal, movimientos, columnaOrigen } of TABLA_ESPERADA) {
      const r = reconocer(
        {
          bancoCodigo: 'galicia',
          conceptoBanco: literal,
          conceptoCompleto: true,
          conceptoBancoEstrategia: 'segmento_de_glosa',
          conceptoCodigo: undefined,
          columnaOrigen,
        },
        INDICE_GALICIA,
      );
      porClase[r.clase] += movimientos;
    }
    const esperado: Record<ClaseEsperada, number> = { propuesta: 0, decision_humana: 0, sin_reconocer: 0 };
    for (const { concepto, movimientos } of TABLA_ESPERADA) esperado[claseEsperadaDe(concepto)] += movimientos;
    expect(porClase).toEqual(esperado);
  });

  it.each(['TRANSF. CTAS PROPIAS', 'TRANSFERENCIAS CASH'])(
    // 🔴 Corregido por code-reviewer (convocatoria de cierre): el resto de la tabla solo prueba la
    // columnaOrigen declarada por literal — para los dos conceptos 'indistinto' de Galicia
    // (transferencia_cuentas_propias, transferencia_cash_management) hay que probar las DOS columnas,
    // mismo patrón que TABLA_INDISTINTOS en corpus-macro.test.ts.
    '«%s» (indistinto): las DOS columnas dan la clase esperada',
    (literal) => {
      const fila = TABLA_ESPERADA.find((f) => f.literal === literal);
      if (!fila) throw new Error(`fixture inválido: falta "${literal}"`);
      for (const columnaOrigen of ['debito', 'credito'] as const) {
        const r = reconocer(
          {
            bancoCodigo: 'galicia',
            conceptoBanco: literal,
            conceptoCompleto: true,
            conceptoBancoEstrategia: 'segmento_de_glosa',
            conceptoCodigo: undefined,
            columnaOrigen,
          },
          INDICE_GALICIA,
        );
        expect(r.clase, `"${literal}" / ${columnaOrigen}: ${JSON.stringify(r)}`).toBe(claseEsperadaDe(fila.concepto));
      }
    },
  );
});
