import type { LexicoDeBanco } from '../nucleo/lexico.ts';

/**
 * El léxico de Santander — 27 entradas / 29 literales (`docs/diseno/06-formato-santander.md` §12).
 *
 * `elAdaptadorPuedeTruncar: false`: `santander.ts` declara `conceptoCompleto: true` SIEMPRE (medido —
 * máx. 41 caracteres contra una columna de 274.8 pt). Toda entrada usa `modo: 'exacto'` — PROP-10 lo
 * exige. "Sentence case" vs. "Title Case" del `.xls` (H2) no necesita enumerarse: `normalizar()` hace
 * `toUpperCase()` y las colapsa antes de comparar.
 *
 * Seis conceptos son el MISMO hecho económico que ya mide Galicia (el impuesto Ley 25413, la
 * transferencia entre cuentas propias, etc.) — se reusa el concepto, no se duplica (04 §1.3).
 */
export const LEXICO_SANTANDER: LexicoDeBanco = {
  banco: 'santander',
  estrategiaDelAdaptador: 'segmento_de_glosa',
  elAdaptadorPuedeTruncar: false,
  entradas: [
    {
      id: 'santander.acreditacion_tarjeta_first_data_visa',
      concepto: 'acreditacion_tarjeta_first_data_visa',
      literales: ['Pago comercios first data visa nro.liq.'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Pago comercios first data visa nro.liq.', movimientos: 29, lado: 'haber' }],
      },
    },
    {
      id: 'santander.impuesto_25413_sobre_creditos',
      concepto: 'impuesto_25413_sobre_creditos', // MISMO hecho económico que mide Galicia
      literales: ['Impuesto ley 25.413 credito 0,6%'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Impuesto ley 25.413 credito 0,6%', movimientos: 21, lado: 'debe' }],
      },
    },
    {
      id: 'santander.impuesto_25413_sobre_debitos',
      concepto: 'impuesto_25413_sobre_debitos', // MISMO hecho económico que mide Galicia
      literales: ['Impuesto ley 25.413 debito 0,6%'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Impuesto ley 25.413 debito 0,6%', movimientos: 19, lado: 'debe' }],
      },
    },
    {
      id: 'santander.acreditacion_tarjeta_first_data_master',
      concepto: 'acreditacion_tarjeta_first_data_master',
      literales: ['Pago comercios first data master nro.liq.'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Pago comercios first data master nro.liq.', movimientos: 17, lado: 'ambos' }],
      },
    },
    {
      id: 'santander.acreditacion_tarjeta_first_data_debito',
      concepto: 'acreditacion_tarjeta_first_data_debito',
      literales: ['Pago comercios first data m. deb nro.liq.'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Pago comercios first data m. deb nro.liq.', movimientos: 10, lado: 'haber' }],
      },
    },
    {
      id: 'santander.transferencia_recibida_de_terceros',
      concepto: 'transferencia_recibida_de_terceros', // MISMO hecho económico que mide Galicia
      literales: ['Transferencia recibida'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Transferencia recibida', movimientos: 10, lado: 'haber' }],
      },
    },
    {
      id: 'santander.retencion_sircreb',
      concepto: 'retencion_sircreb',
      literales: ['Regimen de recaudacion sircreb y'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Regimen de recaudacion sircreb y', movimientos: 8, lado: 'debe' }],
      },
    },
    {
      id: 'santander.transferencia_cuentas_propias',
      concepto: 'transferencia_cuentas_propias', // MISMO hecho económico que mide Galicia
      literales: ['Transf recibida cvu mismo titular'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Transf recibida cvu mismo titular', movimientos: 8, lado: 'haber' }],
      },
    },
    {
      id: 'santander.credito_transferencia_online_banking',
      concepto: 'credito_transferencia_online_banking',
      literales: ['Credito transf online banking emp'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Credito transf online banking emp', movimientos: 3, lado: 'haber' }],
      },
    },
    {
      id: 'santander.echeq_recibido_debito',
      concepto: 'echeq_recibido_debito',
      literales: ['Echeq canje interno recibido 24hs', 'Echeq clearing recibido 48hs'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [
          { literal: 'Echeq canje interno recibido 24hs', movimientos: 3, lado: 'debe' },
          { literal: 'Echeq clearing recibido 48hs', movimientos: 3, lado: 'debe' },
        ],
      },
    },
    {
      id: 'santander.iva_21_regimen_transparencia_fiscal',
      concepto: 'iva_21_regimen_transparencia_fiscal',
      literales: ['Iva 21% reg de transfisc ley27743'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Iva 21% reg de transfisc ley27743', movimientos: 3, lado: 'debe' }],
      },
    },
    {
      id: 'santander.interes_por_descubierto_cobrado',
      concepto: 'interes_por_descubierto_cobrado',
      literales: ['Cobro de interes por descubierto'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Cobro de interes por descubierto', movimientos: 2, lado: 'debe' }],
      },
    },
    {
      id: 'santander.iva_10_5_regimen_transparencia_fiscal',
      concepto: 'iva_10_5_regimen_transparencia_fiscal',
      literales: ['Iva 10,5% reg trans fisc ley 27743'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Iva 10,5% reg trans fisc ley 27743', movimientos: 2, lado: 'debe' }],
      },
    },
    {
      id: 'santander.percepcion_iva_rg_2408',
      concepto: 'percepcion_iva_rg_2408',
      literales: ['Iva percep rg 2408 alic reducida', 'Iva percepcion rg 2408'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [
          { literal: 'Iva percep rg 2408 alic reducida', movimientos: 2, lado: 'debe' },
          { literal: 'Iva percepcion rg 2408', movimientos: 2, lado: 'debe' },
        ],
      },
    },
    {
      id: 'santander.impuesto_de_sellos',
      concepto: 'impuesto_de_sellos',
      literales: ['Impuesto de sellos'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Impuesto de sellos', movimientos: 2, lado: 'debe' }],
      },
    },
    {
      id: 'santander.deposito_de_efectivo',
      concepto: 'deposito_de_efectivo',
      literales: ['Deposito de efectivo'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Deposito de efectivo', movimientos: 2, lado: 'haber' }],
      },
    },
    {
      id: 'santander.pago_recibido_como_proveedor',
      concepto: 'pago_recibido_como_proveedor',
      literales: ['Pago a proveedores recibido'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Pago a proveedores recibido', movimientos: 2, lado: 'haber' }],
      },
    },
    {
      id: 'santander.debito_automatico_generico',
      concepto: 'debito_automatico_generico',
      literales: ['Debito automatico'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Debito automatico', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'santander.transferencia_realizada_generica',
      concepto: 'transferencia_realizada_generica',
      literales: ['Transferencia realizada'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Transferencia realizada', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'santander.comision_gestion_de_cobertura',
      concepto: 'comision_gestion_de_cobertura',
      literales: ['Comision gestion de cobertura'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Comision gestion de cobertura', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'santander.pago_de_servicios',
      concepto: 'pago_de_servicios', // MISMO literal y concepto que mide Galicia
      literales: ['Pago de servicios'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Pago de servicios', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'santander.pago_de_honorarios',
      concepto: 'pago_de_honorarios',
      literales: ['Pago de honorarios'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Pago de honorarios', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'santander.snp_debito_directo',
      concepto: 'snp_debito_directo',
      literales: ['Snp debito directo'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Snp debito directo', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'santander.acreditacion_tarjeta_getnet',
      concepto: 'acreditacion_tarjeta_getnet',
      literales: ['Pago comercios getnet nro.liq.'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Pago comercios getnet nro.liq.', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'santander.comision_de_mantenimiento_de_cuenta',
      concepto: 'comision_de_mantenimiento_de_cuenta', // MISMO hecho económico que mide Galicia
      literales: ['Comision por servicio de cuenta'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Comision por servicio de cuenta', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'santander.comision_de_mantenimiento_de_cuenta_dolares',
      concepto: 'comision_de_mantenimiento_de_cuenta_dolares',
      literales: ['Comision servicio cuenta dolares'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Comision servicio cuenta dolares', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'santander.transferencia_inmediata_generica',
      concepto: 'transferencia_inmediata_generica',
      literales: ['Transferencia inmediata'],
      matcheo: { modo: 'exacto' },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/06-formato-santander.md',
        seccion: '§12',
        porLiteral: [{ literal: 'Transferencia inmediata', movimientos: 1, lado: 'debe' }],
      },
    },
  ],
};
