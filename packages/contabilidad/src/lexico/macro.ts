import type { LexicoDeBanco } from '../nucleo/lexico.ts';

/**
 * El léxico de Macro — 35 entradas (27 sin contraparte + 8 con contraparte) / 44 literales anclados
 * (34 literales sin contraparte + 10 anclas con contraparte, `docs/diseno/07-formato-macro.md` §12 y
 * §12.3 — `'ING TRANSF:'`, sumado 2026-09-01, es la décima). El desajuste entre "35 entradas" y
 * "34+10=44 literales" es real: varias entradas fusionan más de un literal como sinónimos (ej.
 * `comision_de_transferencia`, `impuesto_25413_sobre_debitos`), así que hay menos entradas que
 * literales del lado sin contraparte.
 *
 * `elAdaptadorPuedeTruncar: false`: `macro.ts` declara `conceptoCompleto: true` SIEMPRE — el corte es
 * geométrico contra una LISTA CERRADA anclada (`prefijo_anclado`), no un límite de columna. Toda entrada
 * usa `modo: 'exacto'`, salvo los 8 entradas con contraparte (`modo: 'prefijo_con_cola'`) — para ESAS,
 * el adaptador YA cortó la cola antes de persistir `conceptoBanco` (H1 de la sesión: `macro.ts` guarda
 * la ETIQUETA de `VOCABULARIO`, no un slice de la glosa), así que la comparación efectiva sigue siendo
 * igualdad — el modo cambia la VÍA reportada y declara que existe una cola (el nombre del tercero) que
 * va a capa C, nunca a la evidencia.
 *
 * 🔴 Los 76 movimientos de `PAGO<########>-LIQ COMER <procesadora>` NO tienen entrada acá — es el hueco
 * de captura declarado en `07-formato-macro.md` §12.2 (interacción INV-13×INV-14: ninguna etiqueta
 * estática puede ser prefijo de la glosa depurada). Nunca llegan con `conceptoBanco`, así que el motor
 * los recibe como `conceptoBanco: undefined` y produce `sin_evidencia_de_concepto` sin necesitar
 * entrada — verificado en `corpus-macro.test.ts`.
 *
 * Trece conceptos son el MISMO hecho económico que ya miden Galicia/Santander (impuesto 25413,
 * transferencia entre cuentas propias, comisiones genéricas, etc.) — se reusan, no se duplican.
 */
export const LEXICO_MACRO: LexicoDeBanco = {
  banco: 'macro',
  estrategiaDelAdaptador: 'prefijo_anclado',
  elAdaptadorPuedeTruncar: false,
  entradas: [
    // ══ Conceptos sin contraparte (34 literales) ═══════════════════════════════════════════════════
    {
      id: 'macro.transferencia_macronline_debito',
      concepto: 'transferencia_macronline_debito',
      literales: ['N/D Transf. MacrOnline E-set D/T'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D Transf. MacrOnline E-set D/T', movimientos: 29, lado: 'debe' }] },
    },
    {
      id: 'macro.comision_de_transferencia',
      concepto: 'comision_de_transferencia',
      literales: ['N/D Comision Trf. MacrOL E-set', 'N/D COMISION TRANSFERENCIAS', 'COMISION TRANSFERE'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [
          { literal: 'N/D Comision Trf. MacrOL E-set', movimientos: 22, lado: 'debe' },
          { literal: 'N/D COMISION TRANSFERENCIAS', movimientos: 7, lado: 'debe' },
          { literal: 'COMISION TRANSFERE', movimientos: 1, lado: 'debe' },
        ] },
    },
    {
      id: 'macro.impuesto_25413_sobre_debitos',
      concepto: 'impuesto_25413_sobre_debitos',
      literales: ['N/D DBCR 25413 S/DB TASA GRAL', 'N/D FV IMPDBCR 25413 S/DB TASA GRAL'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [
          { literal: 'N/D DBCR 25413 S/DB TASA GRAL', movimientos: 17, lado: 'debe' },
          { literal: 'N/D FV IMPDBCR 25413 S/DB TASA GRAL', movimientos: 5, lado: 'debe' },
        ] },
    },
    {
      id: 'macro.impuesto_25413_sobre_creditos',
      concepto: 'impuesto_25413_sobre_creditos',
      literales: ['N/D DBCR 25413 S/CR TASA GRAL', 'N/D FV IMPDBCR 25413 S/CR TASA GRAL'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [
          { literal: 'N/D DBCR 25413 S/CR TASA GRAL', movimientos: 17, lado: 'debe' },
          { literal: 'N/D FV IMPDBCR 25413 S/CR TASA GRAL', movimientos: 1, lado: 'debe' },
        ] },
    },
    {
      id: 'macro.pago_cheque_de_camara',
      concepto: 'pago_cheque_de_camara',
      literales: ['PAGO DE CHEQUE DE CAMARA'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'PAGO DE CHEQUE DE CAMARA', movimientos: 16, lado: 'debe' }] },
    },
    {
      id: 'macro.debito_fiscal_iva_basico',
      concepto: 'debito_fiscal_iva_basico',
      literales: ['DEBITO FISCAL IVA BASICO'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'DEBITO FISCAL IVA BASICO', movimientos: 7, lado: 'debe' }] },
    },
    {
      id: 'macro.transferencia_minorista_distinto_titular',
      concepto: 'transferencia_minorista_distinto_titular',
      literales: ['N/D DB TRANSF MINORISTA DIST TIT'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D DB TRANSF MINORISTA DIST TIT', movimientos: 7, lado: 'debe' }] },
    },
    {
      id: 'macro.retencion_iibb_cordoba_renta_financiera',
      concepto: 'retencion_iibb_cordoba_renta_financiera',
      literales: ['RETENCION IIBB CORDOBA RENTA FINANC'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'RETENCION IIBB CORDOBA RENTA FINANC', movimientos: 6, lado: 'debe' }] },
    },
    {
      id: 'macro.pago_de_remuneraciones',
      concepto: 'pago_de_remuneraciones',
      literales: ['N/D DB PAGO REMUNERACIONES'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D DB PAGO REMUNERACIONES', movimientos: 6, lado: 'debe' }] },
    },
    {
      id: 'macro.retencion_iva_percepcion_macro',
      concepto: 'retencion_iva_percepcion_macro',
      literales: ['RETENCION IVA PERCEPCION'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'RETENCION IVA PERCEPCION', movimientos: 5, lado: 'debe' }] },
    },
    {
      id: 'macro.acreditacion_cheque_remesas',
      concepto: 'acreditacion_cheque_remesas',
      literales: ['ACREDITACION CHEQUE REMESAS'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'ACREDITACION CHEQUE REMESAS', movimientos: 5, lado: 'haber' }] },
    },
    {
      id: 'macro.transferencia_cuentas_propias',
      concepto: 'transferencia_cuentas_propias',
      literales: ['N/C CR TRANSF AUT SDO MISMO TIT', 'N/D DB TR..AUT.SDO.MISMO TIT.'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [
          { literal: 'N/C CR TRANSF AUT SDO MISMO TIT', movimientos: 3, lado: 'haber' },
          { literal: 'N/D DB TR..AUT.SDO.MISMO TIT.', movimientos: 3, lado: 'debe' },
        ] },
    },
    {
      id: 'macro.pago_a_organismo_fiscal_afip',
      concepto: 'pago_a_organismo_fiscal_afip',
      literales: ['IMP. AFIP'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'IMP. AFIP', movimientos: 3, lado: 'debe' }] },
    },
    {
      id: 'macro.cheque_canje_interno',
      concepto: 'cheque_canje_interno',
      literales: ['CHEQUE CANJE INTERNO'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'CHEQUE CANJE INTERNO', movimientos: 3, lado: 'debe' }] },
    },
    {
      id: 'macro.retiro_caja_ahorro',
      concepto: 'retiro_caja_ahorro',
      literales: ['RETIRO CAJ.AH.'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'RETIRO CAJ.AH.', movimientos: 2, lado: 'debe' }] },
    },
    {
      id: 'macro.extraccion_efectivo_idcb_pyme',
      concepto: 'extraccion_efectivo_idcb_pyme',
      literales: ['N/D IDCB GRAL. EXTRAC EFVO PYME'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D IDCB GRAL. EXTRAC EFVO PYME', movimientos: 2, lado: 'debe' }] },
    },
    {
      id: 'macro.devolucion_impuesto_25413_sobre_creditos',
      concepto: 'devolucion_impuesto_25413_sobre_creditos',
      literales: ['N/C DBCR 25413 S/CR TASA GRAL', 'N/C FV IMPDBCR 25413 S/CR TASA GRAL'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [
          { literal: 'N/C DBCR 25413 S/CR TASA GRAL', movimientos: 2, lado: 'haber' },
          { literal: 'N/C FV IMPDBCR 25413 S/CR TASA GRAL', movimientos: 1, lado: 'haber' },
        ] },
    },
    {
      id: 'macro.comision_de_extraccion',
      concepto: 'comision_de_extraccion',
      literales: ['N/D COM RETIRO EFECTIVO POR CAJA'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D COM RETIRO EFECTIVO POR CAJA', movimientos: 1, lado: 'debe' }] },
    },
    {
      id: 'macro.deposito_de_efectivo',
      concepto: 'deposito_de_efectivo',
      literales: ['DEPOSITO EN EFECTIVO CTA. CTE.'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'DEPOSITO EN EFECTIVO CTA. CTE.', movimientos: 1, lado: 'haber' }] },
    },
    {
      id: 'macro.deposito_canje_interno_fv',
      concepto: 'deposito_canje_interno_fv',
      literales: ['N/C FV CR DEPOSITO CANJE INTERNO'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/C FV CR DEPOSITO CANJE INTERNO', movimientos: 1, lado: 'haber' }] },
    },
    {
      id: 'macro.cheque_devuelto_canje_interno',
      concepto: 'cheque_devuelto_canje_interno',
      literales: ['N/D FV CHEQ.DEV. DEP.CJE. INTERNO'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D FV CHEQ.DEV. DEP.CJE. INTERNO', movimientos: 1, lado: 'debe' }] },
    },
    {
      id: 'macro.comision_de_deposito_o_rechazo_de_cheque',
      concepto: 'comision_de_deposito_o_rechazo_de_cheque',
      literales: ['N/D FV COMISION DEPOSITO Ó RECH CHE', 'N/D COMISION DEPOSITO O RECH CHEQ'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [
          { literal: 'N/D FV COMISION DEPOSITO Ó RECH CHE', movimientos: 1, lado: 'debe' },
          { literal: 'N/D COMISION DEPOSITO O RECH CHEQ', movimientos: 1, lado: 'debe' },
        ] },
    },
    {
      id: 'macro.comision_administracion_de_valores',
      concepto: 'comision_administracion_de_valores',
      literales: ['N/D COMISION ADM.VALORES AL COBRO C'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D COMISION ADM.VALORES AL COBRO C', movimientos: 1, lado: 'debe' }] },
    },
    {
      id: 'macro.comision_administracion_de_chequera',
      concepto: 'comision_administracion_de_chequera',
      literales: ['N/D COMISIÓN ADMINISTRACIÓN DE CHEQUERA'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D COMISIÓN ADMINISTRACIÓN DE CHEQUERA', movimientos: 1, lado: 'debe' }] },
    },
    {
      id: 'macro.comision_de_mantenimiento_de_cuenta',
      concepto: 'comision_de_mantenimiento_de_cuenta',
      literales: ['N/D MANTENIMIENTO MENSUAL PAQUETE'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D MANTENIMIENTO MENSUAL PAQUETE', movimientos: 1, lado: 'debe' }] },
    },
    {
      id: 'macro.comision_de_cheque_pagado',
      concepto: 'comision_de_cheque_pagado',
      literales: ['N/D COMISION CHQ PAG CLEARING'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'N/D COMISION CHQ PAG CLEARING', movimientos: 1, lado: 'debe' }] },
    },
    {
      id: 'macro.cheque_devuelto_remesas',
      concepto: 'cheque_devuelto_remesas',
      literales: ['ND CHEQUE DEVUELTO REMESAS'],
      matcheo: { modo: 'exacto' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'ND CHEQUE DEVUELTO REMESAS', movimientos: 1, lado: 'debe' }] },
    },

    // ══ Prefijos con contraparte (9 anclas, matcheo prefijo_con_cola) ═════════════════════════════
    {
      id: 'macro.transferencia_recibida_de_terceros',
      concepto: 'transferencia_recibida_de_terceros',
      // `'ING TRANSF:'` sumado 2026-09-01 (hallazgo ROKA-2026, §12.3 de `07-formato-macro.md`): mismo
      // hecho económico que `TPUSH`/`TRANSF` (transferencia recibida de un tercero, confirmado por
      // `contador-dominio`), etiqueta AUSENTE del corpus de noviembre 2025 que midió `TPUSH`/`TRANSF`
      // — se reusa la entrada, no se duplica (criterio del propio archivo, línea 25).
      literales: ['TPUSH', 'TRANSF', 'ING TRANSF:'],
      // 07-formato-macro.md §12.1: "TPUSH (569) + TRANSF (409) = 978 de 1346 = 73% del archivo son
      // transferencias RECIBIDAS de terceros" — el propio documento enmarca la dirección.
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [
          { literal: 'TPUSH', movimientos: 569, lado: 'haber' },
          { literal: 'TRANSF', movimientos: 409, lado: 'haber' },
          // Medido sobre ROKA-2026 (§12.3), no sobre el corpus de noviembre 2025: 2084 movimientos
          // reales (mayo 671 + junio 699 + julio 714), 100% con contraparte capturada en Módulo 1,
          // 0% match contra el padrón de socios — verificado con `resolverContraparte()`.
          { literal: 'ING TRANSF:', movimientos: 2084, lado: 'haber' },
        ] },
    },
    {
      id: 'macro.transferencia_mo_ccdo_distinto_titular',
      concepto: 'transferencia_mo_ccdo_distinto_titular',
      literales: ['TRF MO CCDO DIST T -'],
      matcheo: { modo: 'prefijo_con_cola' },
      // La procedencia cita el texto completo tal como aparece entre backticks en el documento
      // (con el placeholder `<n>`); `literales` (arriba) es el ancla real usada para matchear.
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'TRF MO CCDO DIST T - <n>', movimientos: 9, lado: 'no_medido' }] },
    },
    {
      id: 'macro.transferencia_con_token',
      concepto: 'transferencia_con_token',
      // 🔴 El banco imprime 'TRANSF:<token>' PEGADO, sin espacio (07-formato-macro.md §12: "la trampa
      // que costó 84 movimientos"). El literal se declara tal como se imprime — el ancla se construye
      // en nucleo/indice.ts respetando esto (sin agregar espacio a un carácter ya no-alfanumérico).
      literales: ['TRANSF:'],
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'TRANSF:<token>-<n>', movimientos: 78, lado: 'no_medido' }] },
    },
    {
      id: 'macro.acreditacion_credin',
      concepto: 'acreditacion_credin',
      literales: ['CREDIN:'],
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'CREDIN:<token>-<n>', movimientos: 6, lado: 'no_medido' }] },
    },
    {
      id: 'macro.cheque_circuito_cerrado',
      concepto: 'cheque_circuito_cerrado',
      literales: ['CCERR'],
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'CCERR <razón social> <n> CIRC.CERRADO', movimientos: 5, lado: 'no_medido' }] },
    },
    {
      id: 'macro.transferencia_electronica_datanet',
      concepto: 'transferencia_electronica_datanet',
      literales: ['TEF DATANET PR'],
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: 'TEF DATANET PR <razón social>', movimientos: 4, lado: 'no_medido' }] },
    },
    {
      id: 'macro.rescate_fci',
      concepto: 'rescate_fci',
      literales: ['10 Sol.Resc'],
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: '10 Sol.Resc', movimientos: 7, lado: 'no_medido' }] },
    },
    {
      id: 'macro.suscripcion_fci',
      concepto: 'suscripcion_fci',
      literales: ['10 Liq.Susc'],
      matcheo: { modo: 'prefijo_con_cola' },
      procedencia: { fuente: 'corpus_medido', documento: 'docs/diseno/07-formato-macro.md', seccion: '§12',
        porLiteral: [{ literal: '10 Liq.Susc', movimientos: 3, lado: 'no_medido' }] },
    },
  ],
};
