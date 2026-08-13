/**
 * La tabla del corpus de Santander — literal → concepto → clase esperada, y el motor real corriendo
 * contra ella. Mismo criterio que `corpus-galicia.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { CATALOGO_CANONICO, type ConceptoCanonico, type FilaDelCatalogo } from '../src/nucleo/catalogo.ts';
import { LEXICO_SANTANDER } from '../src/lexico/santander.ts';
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

/** Las 29 filas del vocabulario medido (`docs/diseno/06-formato-santander.md` §12). */
const TABLA_ESPERADA: ReadonlyArray<{
  literal: string;
  concepto: ConceptoCanonico;
  movimientos: number;
  columnaOrigen: ColumnaOrigen;
}> = [
  { literal: 'Pago comercios first data visa nro.liq.', concepto: 'acreditacion_tarjeta_first_data_visa', movimientos: 29, columnaOrigen: 'credito' },
  { literal: 'Impuesto ley 25.413 credito 0,6%', concepto: 'impuesto_25413_sobre_creditos', movimientos: 21, columnaOrigen: 'debito' },
  { literal: 'Impuesto ley 25.413 debito 0,6%', concepto: 'impuesto_25413_sobre_debitos', movimientos: 19, columnaOrigen: 'debito' },
  { literal: 'Pago comercios first data master nro.liq.', concepto: 'acreditacion_tarjeta_first_data_master', movimientos: 17, columnaOrigen: 'credito' },
  { literal: 'Pago comercios first data m. deb nro.liq.', concepto: 'acreditacion_tarjeta_first_data_debito', movimientos: 10, columnaOrigen: 'credito' },
  { literal: 'Transferencia recibida', concepto: 'transferencia_recibida_de_terceros', movimientos: 10, columnaOrigen: 'credito' },
  { literal: 'Regimen de recaudacion sircreb y', concepto: 'retencion_sircreb', movimientos: 8, columnaOrigen: 'debito' },
  { literal: 'Transf recibida cvu mismo titular', concepto: 'transferencia_cuentas_propias', movimientos: 8, columnaOrigen: 'credito' },
  { literal: 'Credito transf online banking emp', concepto: 'credito_transferencia_online_banking', movimientos: 3, columnaOrigen: 'credito' },
  { literal: 'Echeq canje interno recibido 24hs', concepto: 'echeq_recibido_debito', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'Echeq clearing recibido 48hs', concepto: 'echeq_recibido_debito', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'Iva 21% reg de transfisc ley27743', concepto: 'iva_21_regimen_transparencia_fiscal', movimientos: 3, columnaOrigen: 'debito' },
  { literal: 'Cobro de interes por descubierto', concepto: 'interes_por_descubierto_cobrado', movimientos: 2, columnaOrigen: 'debito' },
  { literal: 'Iva 10,5% reg trans fisc ley 27743', concepto: 'iva_10_5_regimen_transparencia_fiscal', movimientos: 2, columnaOrigen: 'debito' },
  { literal: 'Iva percep rg 2408 alic reducida', concepto: 'percepcion_iva_rg_2408', movimientos: 2, columnaOrigen: 'debito' },
  { literal: 'Impuesto de sellos', concepto: 'impuesto_de_sellos', movimientos: 2, columnaOrigen: 'debito' },
  { literal: 'Deposito de efectivo', concepto: 'deposito_de_efectivo', movimientos: 2, columnaOrigen: 'credito' },
  { literal: 'Pago a proveedores recibido', concepto: 'pago_recibido_como_proveedor', movimientos: 2, columnaOrigen: 'credito' },
  { literal: 'Iva percepcion rg 2408', concepto: 'percepcion_iva_rg_2408', movimientos: 2, columnaOrigen: 'debito' },
  { literal: 'Debito automatico', concepto: 'debito_automatico_generico', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'Transferencia realizada', concepto: 'transferencia_realizada_generica', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'Comision gestion de cobertura', concepto: 'comision_gestion_de_cobertura', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'Pago de servicios', concepto: 'pago_de_servicios', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'Pago de honorarios', concepto: 'pago_de_honorarios', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'Snp debito directo', concepto: 'snp_debito_directo', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'Pago comercios getnet nro.liq.', concepto: 'acreditacion_tarjeta_getnet', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'Comision por servicio de cuenta', concepto: 'comision_de_mantenimiento_de_cuenta', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'Comision servicio cuenta dolares', concepto: 'comision_de_mantenimiento_de_cuenta_dolares', movimientos: 1, columnaOrigen: 'debito' },
  { literal: 'Transferencia inmediata', concepto: 'transferencia_inmediata_generica', movimientos: 1, columnaOrigen: 'debito' },
];

const INDICE_SANTANDER = construirIndice(LEXICO_SANTANDER);

describe('corpus de Santander — tabla congelada', () => {
  it('la tabla cubre los 29 literales medidos en 06-formato-santander.md §12', () => {
    expect(TABLA_ESPERADA.length).toBe(29);
  });

  it('la suma de movimientos de la tabla es 158 (el lote real ingerido del piloto)', () => {
    expect(TABLA_ESPERADA.reduce((acc, f) => acc + f.movimientos, 0)).toBe(158);
  });

  it.each(TABLA_ESPERADA)('«$literal» → $concepto', ({ literal, concepto }) => {
    const entrada = LEXICO_SANTANDER.entradas.find((e) => e.literales.includes(literal));
    expect(entrada, `ningún entrada de lexico/santander.ts contiene el literal "${literal}"`).toBeDefined();
    expect(entrada?.concepto).toBe(concepto);
  });
});

describe('corpus de Santander — EL MOTOR', () => {
  it.each(TABLA_ESPERADA)('«$literal» ($columnaOrigen) → el motor devuelve la clase esperada de $concepto', ({
    literal,
    concepto,
    columnaOrigen,
  }) => {
    const r = reconocer(
      {
        bancoCodigo: 'santander',
        conceptoBanco: literal,
        conceptoCompleto: true,
        conceptoBancoEstrategia: 'segmento_de_glosa',
        conceptoCodigo: undefined,
        columnaOrigen,
      },
      INDICE_SANTANDER,
    );
    expect(r.clase, `literal "${literal}": el motor devolvió ${JSON.stringify(r)}`).toBe(claseEsperadaDe(concepto));
    if (r.clase !== 'sin_reconocer') expect(r.concepto).toBe(concepto);
  });

  it("acreditacion_tarjeta_first_data_master (17 mov., indistinto): las DOS columnas reconocen, ninguna cae en reversa_incoherente", () => {
    for (const columnaOrigen of ['debito', 'credito'] as const) {
      const r = reconocer(
        {
          bancoCodigo: 'santander',
          conceptoBanco: 'Pago comercios first data master nro.liq.',
          conceptoCompleto: true,
          conceptoBancoEstrategia: 'segmento_de_glosa',
          conceptoCodigo: undefined,
          columnaOrigen,
        },
        INDICE_SANTANDER,
      );
      expect(r.clase).not.toBe('sin_reconocer');
    }
  });

  it('la distribución de clases que el motor REALMENTE devuelve suma 158', () => {
    const porClase: Record<ClaseEsperada, number> = { propuesta: 0, decision_humana: 0, sin_reconocer: 0 };
    for (const { literal, movimientos, columnaOrigen } of TABLA_ESPERADA) {
      const r = reconocer(
        {
          bancoCodigo: 'santander',
          conceptoBanco: literal,
          conceptoCompleto: true,
          conceptoBancoEstrategia: 'segmento_de_glosa',
          conceptoCodigo: undefined,
          columnaOrigen,
        },
        INDICE_SANTANDER,
      );
      porClase[r.clase] += movimientos;
    }
    expect(porClase.propuesta + porClase.decision_humana + porClase.sin_reconocer).toBe(158);
  });
});
