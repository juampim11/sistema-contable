import type { LexicoDeBanco } from '../nucleo/lexico.ts';

/**
 * El léxico de Galicia — 28 entradas / 32 literales (`docs/diseno/02-formato-galicia.md` §14).
 *
 * `elAdaptadorPuedeTruncar: true` porque `galicia.ts` corta el concepto GEOMÉTRICAMENTE contra el borde
 * derecho de la columna (`conceptoBancoEstrategia: 'segmento_de_glosa'`) — un literal largo puede llegar
 * truncado. Por eso casi todas las entradas usan `exacto_o_prefijo`.
 *
 * `prefijoMinimo` conservador por defecto: la LONGITUD COMPLETA del literal normalizado más corto de la
 * entrada — cero riesgo de matchear un truncado ambiguo. Tres entradas (los dos lados del impuesto
 * 25413 y su devolución) usan un valor más ajustado, ya verificado a mano contra el resto del
 * vocabulario y revisado por `contador-dominio` (convocatoria bloqueante). `PROP-13` (P9) recalcula
 * estos valores desde los datos — hasta entonces, "conservador" nunca es incorrecto, solo subóptimo.
 */
export const LEXICO_GALICIA: LexicoDeBanco = {
  banco: 'galicia',
  estrategiaDelAdaptador: 'segmento_de_glosa',
  elAdaptadorPuedeTruncar: true,
  entradas: [
    {
      id: 'galicia.acreditamiento',
      concepto: 'acreditamiento',
      literales: ['ACREDITAMIENTO'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 14 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'ACREDITAMIENTO', movimientos: 78, lado: 'haber' }],
      },
    },
    {
      id: 'galicia.pago_a_proveedor_inmediato',
      concepto: 'pago_a_proveedor_inmediato',
      literales: ['TRF INMED PROVEED'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 18 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'TRF INMED PROVEED', movimientos: 70, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.impuesto_25413_sobre_creditos',
      concepto: 'impuesto_25413_sobre_creditos',
      literales: ['IMP. CRE. LEY 25413'],
      // 'IMP CRE LEY' (11) diverge de 'IMP DEB LEY...' en el 4º token, en borde de token.
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 11 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/05-motor-de-reconocimiento.md',
        seccion: '§0.A',
        porLiteral: [{ literal: 'IMP. CRE. LEY 25413', movimientos: 21, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.impuesto_25413_sobre_debitos',
      concepto: 'impuesto_25413_sobre_debitos',
      literales: ['IMP. DEB. LEY 25413 GRAL.', 'IMPUESTO DEB.LEY 25413'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 11 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [
          { literal: 'IMP. DEB. LEY 25413 GRAL.', movimientos: 19, lado: 'debe' },
          { literal: 'IMPUESTO DEB.LEY 25413', movimientos: 4, lado: 'debe' },
        ],
      },
    },
    {
      id: 'galicia.iva_sobre_comision_bancaria',
      concepto: 'iva_sobre_comision_bancaria',
      literales: ['IVA'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 3 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'IVA', movimientos: 17, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.comision_de_transferencia',
      concepto: 'comision_de_transferencia',
      literales: ['COM. GESTION TRANSF.FDOS'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 24 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'COM. GESTION TRANSF.FDOS', movimientos: 12, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.compra_con_tarjeta_debito_generica',
      concepto: 'compra_con_tarjeta_debito_generica',
      literales: ['COMPRA DEBITO'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 13 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'COMPRA DEBITO', movimientos: 11, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.transferencia_cuentas_propias',
      concepto: 'transferencia_cuentas_propias',
      literales: ['TRANSF. CTAS PROPIAS'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 20 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'TRANSF. CTAS PROPIAS', movimientos: 11, lado: 'ambos' }],
      },
    },
    {
      id: 'galicia.rescate_fci',
      concepto: 'rescate_fci',
      literales: ['RESCATE FIMA'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 12 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'RESCATE FIMA', movimientos: 10, lado: 'haber' }],
      },
    },
    {
      id: 'galicia.transferencia_cash_management',
      concepto: 'transferencia_cash_management',
      literales: ['TRANSFERENCIAS CASH'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 19 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'TRANSFERENCIAS CASH', movimientos: 8, lado: 'ambos' }],
      },
    },
    {
      id: 'galicia.pago_con_transferencia_generico',
      concepto: 'pago_con_transferencia_generico',
      literales: ['PAGO CON TRANSFERENCIA'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 22 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'PAGO CON TRANSFERENCIA', movimientos: 7, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.transferencia_a_terceros',
      concepto: 'transferencia_a_terceros',
      literales: ['TRANSF. A TERCEROS', 'TRANSFERENCIA A TERCEROS'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 17 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [
          { literal: 'TRANSF. A TERCEROS', movimientos: 5, lado: 'debe' },
          { literal: 'TRANSFERENCIA A TERCEROS', movimientos: 4, lado: 'debe' },
        ],
      },
    },
    {
      id: 'galicia.percepcion_iva',
      concepto: 'percepcion_iva',
      literales: ['PERCEP. IVA', 'PERCEPCION RG 5617/24'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 10 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [
          { literal: 'PERCEP. IVA', movimientos: 5, lado: 'debe' },
          { literal: 'PERCEPCION RG 5617/24', movimientos: 1, lado: 'debe' },
        ],
      },
    },
    {
      id: 'galicia.pago_de_servicios',
      concepto: 'pago_de_servicios',
      literales: ['PAGO DE SERVICIOS'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 17 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'PAGO DE SERVICIOS', movimientos: 5, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.comision_de_acreditacion_de_haberes',
      concepto: 'comision_de_acreditacion_de_haberes',
      literales: ['SERVICIO ACREDITAMIENTO DE'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 26 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'SERVICIO ACREDITAMIENTO DE', movimientos: 4, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.pago_a_proveedores_snp',
      concepto: 'pago_a_proveedores_snp',
      literales: ['SNP PAGO A PROVEEDORES', 'SERVICIO PAGO A PROVEEDORES'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 22 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [
          { literal: 'SNP PAGO A PROVEEDORES', movimientos: 4, lado: 'debe' },
          { literal: 'SERVICIO PAGO A PROVEEDORES', movimientos: 1, lado: 'debe' },
        ],
      },
    },
    {
      id: 'galicia.pago_a_organismo_fiscal_afip',
      concepto: 'pago_a_organismo_fiscal_afip',
      literales: ['TRANSF. AFIP'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 11 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'TRANSF. AFIP', movimientos: 4, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.suscripcion_fci',
      concepto: 'suscripcion_fci',
      literales: ['SUSCRIPCION FIMA'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 16 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'SUSCRIPCION FIMA', movimientos: 4, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.anulacion_acreditamiento_firstdata',
      concepto: 'anulacion_acreditamiento_firstdata',
      literales: ['ANULAC. ACRED. FIRSTDATA.'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 22 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'ANULAC. ACRED. FIRSTDATA.', movimientos: 3, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.devolucion_impuesto_25413_sobre_creditos',
      concepto: 'devolucion_impuesto_25413_sobre_creditos',
      literales: ['DEV.IMP.CRED.LEY 25413'],
      // 'DEV IMP ' (8) — borde de token, ningún otro literal de Galicia empieza con 'DEV'. Es el caso
      // que demuestra por qué el prefijo va anclado al inicio (05 §0.A: contains('IMP') se come la
      // devolución bajo el impuesto normal).
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 8 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/05-motor-de-reconocimiento.md',
        seccion: '§0.A',
        porLiteral: [{ literal: 'DEV.IMP.CRED.LEY 25413', movimientos: 3, lado: 'haber' }],
      },
    },
    {
      id: 'galicia.debito_automatico_de_servicio',
      concepto: 'debito_automatico_de_servicio',
      literales: ['DEB. AUTOM. DE SERV.'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 17 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'DEB. AUTOM. DE SERV.', movimientos: 3, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.pago_cheque_propio',
      concepto: 'pago_cheque_propio',
      literales: ['CHEQUE PAGADOR NRO.'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 18 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'CHEQUE PAGADOR NRO.', movimientos: 3, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.comision_de_cheque_pagado',
      concepto: 'comision_de_cheque_pagado',
      literales: ['COMISION CHEQUE PAGADO POR'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 26 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'COMISION CHEQUE PAGADO POR', movimientos: 3, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.pago_tarjeta_corporativa_visa',
      concepto: 'pago_tarjeta_corporativa_visa',
      literales: ['PAGO VISA EMPRESA'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 17 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'PAGO VISA EMPRESA', movimientos: 2, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.comision_de_mantenimiento_de_cuenta',
      concepto: 'comision_de_mantenimiento_de_cuenta',
      literales: ['COMISION SERVICIO DE CUENTA'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 27 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'COMISION SERVICIO DE CUENTA', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.extraccion_efectivo_autoservicio',
      concepto: 'extraccion_efectivo_autoservicio',
      literales: ['EXTRACCION EN AUTOSERVICIO'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 26 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'EXTRACCION EN AUTOSERVICIO', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.comision_de_extraccion',
      concepto: 'comision_de_extraccion',
      literales: ['COMISION EXTRACCION EN'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 22 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'COMISION EXTRACCION EN', movimientos: 1, lado: 'debe' }],
      },
    },
    {
      id: 'galicia.transferencia_recibida_de_terceros',
      concepto: 'transferencia_recibida_de_terceros',
      literales: ['TRANSFERENCIA DE TERCEROS'],
      matcheo: { modo: 'exacto_o_prefijo', prefijoMinimo: 25 },
      procedencia: {
        fuente: 'corpus_medido',
        documento: 'docs/diseno/02-formato-galicia.md',
        seccion: '§14',
        porLiteral: [{ literal: 'TRANSFERENCIA DE TERCEROS', movimientos: 1, lado: 'haber' }],
      },
    },
  ],
};
