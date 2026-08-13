import type { PendienteDeLaura, Procedencia } from './lexico.ts';
import type { Lado, QueDecide, TipoMovimiento } from './tipos.ts';

/**
 * El catálogo canónico — capa ÚNICA, sin nombre de banco (R-I). Concepto canónico → tipo, polaridad,
 * lado esperado, y quién resuelve la cuenta.
 *
 * 🔴 Se construye INCREMENTALMENTE por banco, igual que el léxico (P4 con Galicia, se amplía en P7 con
 * Santander y en P8 con Macro) — NO de una vez con los ~40 conceptos estimados. Motivo: un concepto sin
 * evidencia real de ningún literal viola PROP-6 (procedencia verdadera) por construcción, así que no hay
 * forma honesta de poblarlo antes de escribir el léxico del banco que lo mide. Esto es una desviación
 * mecánica del plan (que preveía el catálogo completo en P4) — el archivo SÍ se vuelve a tocar en P7/P8,
 * pero solo para AGREGAR filas nuevas de conceptos con evidencia nueva, nunca para cambiar la forma o el
 * mecanismo de verificación (que es lo que "sin tocar nucleo/" protege en la letra del plan).
 *
 * Dos conceptos de bancos distintos que representan el MISMO hecho económico (ej. el impuesto Ley 25413
 * sobre débitos, medido en Galicia, Santander y Macro) comparten UN concepto canónico — el catálogo no
 * se duplica por banco, eso es justamente lo que esta capa evita (04 §1.3).
 */

export const CONCEPTOS_CANONICOS = [
  // -- impuesto_debitos_creditos ---------------------------------------------------------------------
  'impuesto_25413_sobre_debitos',
  'impuesto_25413_sobre_creditos',
  'devolucion_impuesto_25413_sobre_creditos',
  // -- comision_bancaria ------------------------------------------------------------------------------
  'comision_de_transferencia',
  'comision_de_acreditacion_de_haberes',
  'comision_de_cheque_pagado',
  'comision_de_mantenimiento_de_cuenta',
  'comision_de_extraccion',
  // -- iva_sobre_gasto_bancario -------------------------------------------------------------------------
  'iva_sobre_comision_bancaria',
  // -- percepcion_impositiva --------------------------------------------------------------------------
  'percepcion_iva',
  // -- pago_a_proveedor_transferencia -------------------------------------------------------------------
  'pago_a_proveedor_inmediato',
  'pago_con_transferencia_generico',
  'transferencia_a_terceros',
  'pago_a_proveedores_snp',
  // -- transferencia_entre_cuentas_propias ---------------------------------------------------------------
  'transferencia_cuentas_propias',
  // -- cobranza_de_cliente ----------------------------------------------------------------------------
  'acreditamiento',
  'transferencia_recibida_de_terceros',
  // -- pago_de_obligacion_fiscal ------------------------------------------------------------------------
  'pago_a_organismo_fiscal_afip',
  // -- acreditacion_tarjeta -----------------------------------------------------------------------------
  'anulacion_acreditamiento_firstdata',
  // -- extraccion_efectivo ------------------------------------------------------------------------------
  'extraccion_efectivo_autoservicio',
  // -- pago_con_cheque_propio ---------------------------------------------------------------------------
  'pago_cheque_propio',
  // -- sin tipo asignado todavía (criterio conocido, implementación fuera de esta etapa) ------------------
  'compra_con_tarjeta_debito_generica',
  'rescate_fci',
  'suscripcion_fci',
  'pago_de_servicios',
  'debito_automatico_de_servicio',
  'pago_tarjeta_corporativa_visa',
  // -- genuinamente indeterminado, sin hipótesis del léxico --------------------------------------------
  'transferencia_cash_management',

  // ══ Santander (P7) — conceptos nuevos, ninguno reemplaza a los de arriba ═════════════════════════════
  // -- acreditacion_tarjeta ----------------------------------------------------------------------------
  'acreditacion_tarjeta_first_data_visa',
  'acreditacion_tarjeta_first_data_master',
  'acreditacion_tarjeta_first_data_debito',
  'acreditacion_tarjeta_getnet',
  // -- retencion_iibb_bancaria (transiciona de sin_evidencia a habilitado) ------------------------------
  'retencion_sircreb',
  // -- cobranza_de_cliente ------------------------------------------------------------------------------
  'credito_transferencia_online_banking',
  'pago_recibido_como_proveedor',
  // -- sin tipo asignado (identidad incierta, sin hipótesis fuerte) -------------------------------------
  'echeq_recibido_debito',
  'impuesto_de_sellos',
  'debito_automatico_generico',
  // -- percepcion_impositiva ----------------------------------------------------------------------------
  'iva_21_regimen_transparencia_fiscal',
  'iva_10_5_regimen_transparencia_fiscal',
  'percepcion_iva_rg_2408',
  // -- interes_por_descubierto (transiciona de sin_evidencia a habilitado) ------------------------------
  'interes_por_descubierto_cobrado',
  // -- deposito_efectivo (transiciona de sin_evidencia a habilitado) ------------------------------------
  'deposito_de_efectivo',
  // -- pago_a_proveedor_transferencia ---------------------------------------------------------------------
  'transferencia_realizada_generica',
  'pago_de_honorarios',
  'snp_debito_directo',
  'transferencia_inmediata_generica',
  // -- comision_bancaria --------------------------------------------------------------------------------
  'comision_gestion_de_cobertura',
  'comision_de_mantenimiento_de_cuenta_dolares',

  // ══ Macro (P8) — conceptos nuevos ═════════════════════════════════════════════════════════════════
  // -- pago_a_proveedor_transferencia ---------------------------------------------------------------------
  'transferencia_macronline_debito',
  'transferencia_minorista_distinto_titular',
  // -- comision_bancaria --------------------------------------------------------------------------------
  'pago_cheque_de_camara',
  'comision_de_deposito_o_rechazo_de_cheque',
  'comision_administracion_de_valores',
  'comision_administracion_de_chequera',
  // -- percepcion_impositiva ----------------------------------------------------------------------------
  'debito_fiscal_iva_basico',
  'retencion_iva_percepcion_macro',
  // -- retencion_iibb_bancaria --------------------------------------------------------------------------
  'retencion_iibb_cordoba_renta_financiera',
  // -- pago_de_haberes (transiciona de sin_evidencia a habilitado) --------------------------------------
  'pago_de_remuneraciones',
  // -- deposito_cheques_terceros ----------------------------------------------------------------------
  'acreditacion_cheque_remesas',
  'deposito_canje_interno_fv',
  // -- cheque_rechazado (transiciona de sin_evidencia a habilitado) -------------------------------------
  'cheque_devuelto_canje_interno',
  'cheque_devuelto_remesas',
  // -- pago_con_cheque_propio ---------------------------------------------------------------------------
  'cheque_canje_interno',
  // -- extraccion_efectivo ------------------------------------------------------------------------------
  'retiro_caja_ahorro',
  'extraccion_efectivo_idcb_pyme',
  // -- prefijos con contraparte (matcheo prefijo_con_cola) ------------------------------------------------
  'transferencia_mo_ccdo_distinto_titular',
  'transferencia_con_token',
  'acreditacion_credin',
  'cheque_circuito_cerrado', // sin_tipo_asignado
  'transferencia_electronica_datanet', // indistinto
] as const;
export type ConceptoCanonico = (typeof CONCEPTOS_CANONICOS)[number];

// -----------------------------------------------------------------------------------------------------
// Tipos del catálogo — espejo de la sección 2 del plan (adaptive-herding-pillow.md)
// -----------------------------------------------------------------------------------------------------

export type LadoDelConcepto =
  | { readonly polaridad: 'normal'; readonly ladoEsperado: Lado }
  | { readonly polaridad: 'reversa'; readonly ladoEsperado: Lado; readonly reversaDe: ConceptoCanonico }
  | {
      readonly polaridad: 'normal';
      readonly ladoEsperado: 'indistinto';
      readonly pendienteDeLaura: PendienteDeLaura;
    };

/**
 * Por qué un concepto queda `sin_tipo_asignado` — discriminante ESTRUCTURAL, no texto libre.
 *
 * 🔴 Resuelve el hallazgo de `tech-lead` (convocatoria de coherencia, HANDOFF 50): "sin tipo asignado"
 * mezclaba TRES motivos bajo un solo string libre (`motivoDelHueco`), sin campo que los separara — el
 * texto individual de cada fila SÍ distinguía cuál aplicaba, pero nada lo garantizaba estructuralmente
 * (nada impedía, por ejemplo, agregar un concepto de "identidad incierta" con el texto de "implementación
 * diferida" por error de copy-paste). Ahora cada fila declara su categoría, y el compilador exige que
 * las tres sigan siendo distinguibles.
 */
export type CategoriaDelHueco =
  /** El criterio contable YA está resuelto (con Laura o por el catálogo de 04 §3.1); falta programar la
   * imputación — típicamente porque el dato vive en un documento separado del extracto bancario (FCI,
   * tarjeta corporativa) y necesita una decisión de ingesta de Módulo 1 primero. */
  | 'implementacion_diferida'
  /** No hay una hipótesis única razonable sobre QUÉ es el movimiento — la evidencia disponible (lado
   * medido, semántica del literal) no alcanza para decidir entre 2+ lecturas plausibles. */
  | 'identidad_incierta'
  /** Se sabe exactamente qué es el movimiento, pero el catálogo de tipos (31, `04-imputacion-contable.md`
   * §3/§3.1) no tiene ningún tipo que lo represente — puede necesitar un tipo nuevo. */
  | 'sin_tipo_en_catalogo';

export type ResolucionDelConcepto =
  | { readonly resuelve: 'propone'; readonly tipo: TipoMovimiento; readonly pendienteDeLaura?: never }
  | {
      readonly resuelve: 'decide_una_persona';
      readonly tipo: TipoMovimiento;
      readonly queDecide: QueDecide;
      readonly pendienteDeLaura?: PendienteDeLaura;
    }
  | {
      readonly resuelve: 'sin_tipo_asignado';
      readonly categoriaDelHueco: CategoriaDelHueco;
      readonly motivoDelHueco: string;
      readonly referencia: string;
    };

export type FilaDelCatalogo = LadoDelConcepto &
  ResolucionDelConcepto & { readonly procedencia: Procedencia };

/**
 * `Record<ConceptoCanonico, FilaDelCatalogo>` y NO un array: PROP-1 ("cada concepto mapea a exactamente
 * un (tipo, polaridad, ladoEsperado)") queda garantizada por el COMPILADOR — no se puede repetir una
 * clave ni omitir un concepto declarado en `CONCEPTOS_CANONICOS`. `as const satisfies` para que los
 * literales sobrevivan (mismo idiom que `clasificacion-campos.ts:39-40`).
 */
export const CATALOGO_CANONICO = {
  // === impuesto_debitos_creditos =====================================================================
  impuesto_25413_sobre_debitos: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'impuesto_debitos_creditos',
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
  impuesto_25413_sobre_creditos: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'impuesto_debitos_creditos',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/05-motor-de-reconocimiento.md',
      seccion: '§0.A',
      porLiteral: [{ literal: 'IMP. CRE. LEY 25413', movimientos: 21, lado: 'debe' }],
    },
  },
  devolucion_impuesto_25413_sobre_creditos: {
    // 🔴 Corregido por contador-dominio (convocatoria bloqueante): reversa de impuesto_25413_sobre_CREDITOS
    // (no de sobre_debitos) — el par trampa exacto de 05 §0.A. "El crédito por anulación va al HABER de
    // la MISMA cuenta" (04 §3 fila 1) — mismo tipo que su base.
    polaridad: 'reversa',
    ladoEsperado: 'haber',
    reversaDe: 'impuesto_25413_sobre_creditos',
    resuelve: 'propone',
    tipo: 'impuesto_debitos_creditos',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/05-motor-de-reconocimiento.md',
      seccion: '§0.A',
      porLiteral: [{ literal: 'DEV.IMP.CRED.LEY 25413', movimientos: 3, lado: 'haber' }],
    },
  },

  // === comision_bancaria ==============================================================================
  comision_de_transferencia: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'COM. GESTION TRANSF.FDOS', movimientos: 12, lado: 'debe' }],
    },
  },
  comision_de_acreditacion_de_haberes: {
    // Corregido por analista-funcional: 'SERVICIO ACREDITAMIENTO DE' es el truncado de 'SERVICIO
    // ACREDITAMIENTO DE HABERES' (comisión del servicio de acreditación de sueldos), NO evidencia de
    // adquirente de tarjetas — 04 §3, nota del tipo 2.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    // La procedencia cita 02-formato-galicia.md (donde el literal truncado a 27 caracteres está
    // medido con su frecuencia real) — 04-imputacion-contable.md §3 explica el POR QUÉ de la
    // corrección (no es evidencia de adquirente), pero no es donde el literal en sí está citado.
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'SERVICIO ACREDITAMIENTO DE', movimientos: 4, lado: 'debe' }],
    },
  },
  comision_de_cheque_pagado: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'COMISION CHEQUE PAGADO POR', movimientos: 3, lado: 'debe' }],
    },
  },
  comision_de_mantenimiento_de_cuenta: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'COMISION SERVICIO DE CUENTA', movimientos: 1, lado: 'debe' }],
    },
  },
  comision_de_extraccion: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'COMISION EXTRACCION EN', movimientos: 1, lado: 'debe' }],
    },
  },

  // === iva_sobre_gasto_bancario ========================================================================
  iva_sobre_comision_bancaria: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'iva_sobre_gasto_bancario',
    queDecide: 'confirmar_computo_de_credito_fiscal',
    // 04 §3 fila 3, régimen F: "el tipo se reconoce bien. Que sea COMPUTABLE depende de condición IVA,
    // afectación, prorrateo y requisitos: no tengo esa fuente cargada". El motor no cablea "IVA → crédito".
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'IVA', movimientos: 17, lado: 'debe' }],
    },
  },

  // === percepcion_impositiva ===========================================================================
  percepcion_iva: {
    // Corregido por analista-funcional: 04 §3 YA resolvió esto como tipo 3b, régimen F — no es
    // pendiente_confirmacion_laura (05 §0.C quedó desactualizado por 04, que es posterior).
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'percepcion_impositiva',
    queDecide: 'confirmar_computo_de_credito_fiscal',
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

  // === pago_a_proveedor_transferencia ===================================================================
  pago_a_proveedor_inmediato: {
    // No fusionado con pago_con_transferencia_generico (mismo tipo, más abajo) pese a ser
    // económicamente similares: literales distintos ("inmediata" vs "con transferencia" genérico)
    // sin evidencia de que sean el MISMO circuito bancario — mismo criterio conservador que evitó
    // fusionar conceptos sin confirmación en otros puntos del catálogo (PROP-2 exige un hecho, no una
    // suposición de equivalencia).
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'TRF INMED PROVEED', movimientos: 70, lado: 'debe' }],
    },
  },
  pago_con_transferencia_generico: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'PAGO CON TRANSFERENCIA', movimientos: 7, lado: 'debe' }],
    },
  },
  transferencia_a_terceros: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
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
  pago_a_proveedores_snp: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
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

  // === transferencia_entre_cuentas_propias ==============================================================
  transferencia_cuentas_propias: {
    // Concepto compartido por los tres bancos — reusarlo en vez de duplicarlo (04 §1.3) hizo que la
    // evidencia de Macro respondiera, para SÍ MISMO, la pregunta que Galicia deja abierta: Macro
    // publica DOS literales distintos, uno por dirección (`N/C CR TRANSF...` haber, `N/D DB TR..AUT...`
    // debe); Santander publica uno solo, siempre crédito (dirección fija, sin ambigüedad); Galicia
    // publica uno solo sin distinguir dirección — es la ÚNICA de las tres fuentes con la pregunta
    // realmente abierta. `ladoEsperado: 'indistinto'` sigue siendo correcto para el concepto compartido
    // (la evidencia agregada de las tres fuentes SÍ mide ambos lados), y sigue habiendo una pregunta real
    // pendiente — pero acotada a Galicia, no al concepto en general.
    polaridad: 'normal',
    ladoEsperado: 'indistinto',
    pendienteDeLaura: {
      pregunta:
        '¿TRANSF. CTAS PROPIAS de Galicia (11 mov.) usa el mismo literal para las dos patas de una ' +
        'transferencia entre cuentas propias, o el extracto real permite distinguir cuál sale y cuál ' +
        'entra? (Macro SÍ distingue por literal; Santander publica una sola dirección; Galicia es la ' +
        'única fuente sin evidencia de distinción.)',
      hipotesis: 'Mismo literal para ambas direcciones en Galicia — no hay evidencia de un literal ' +
        'separado por dirección en su vocabulario medido, a diferencia de Macro.',
      referencia: 'docs/diseno/02-formato-galicia.md §14',
      desde: '2026-08-13',
    },
    resuelve: 'decide_una_persona',
    tipo: 'transferencia_entre_cuentas_propias',
    queDecide: 'confirmar_cuenta_propia_destino',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'TRANSF. CTAS PROPIAS', movimientos: 11, lado: 'ambos' }],
    },
  },

  // === cobranza_de_cliente =============================================================================
  acreditamiento: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'decide_una_persona',
    tipo: 'cobranza_de_cliente',
    queDecide: 'confirmar_hipotesis_del_lexico',
    pendienteDeLaura: {
      pregunta:
        '¿ACREDITAMIENTO (78 mov., el concepto más frecuente) es acreditación de un adquirente de ' +
        'tarjetas, o transferencia/cobranza recibida genérica? Si es adquirente, va a decisión humana ' +
        'por falta de la liquidación; si es genérico, es candidato natural a 13a cobranza_de_cliente.',
      // Corregido por analista-funcional: la hipótesis original citaba 'SERVICIO ACREDITAMIENTO DE'
      // como evidencia de tarjetas — ERROR, es la comisión de acreditación de sueldos (ver el concepto
      // comision_de_acreditacion_de_haberes arriba). Evidencia real de la hipótesis "adquirente" queda
      // limitada a ANULAC. ACRED. FIRSTDATA. (3 de 78 mov., 4%) — débil.
      hipotesis:
        'Débil: solo ANULAC. ACRED. FIRSTDATA. (3 de 78 mov., 4%) sugiere adquirente de tarjetas — y ' +
        'que la anulación SÍ nombre FIRSTDATA mientras ACREDITAMIENTO a secas nunca lo nombra abre una ' +
        'lectura alternativa igual de plausible: cajón genérico de créditos recibidos (13a, resuelve ' +
        'por padrón, sin necesitar esta hipótesis). Se usa 13a como default hasta que Laura confirme, ' +
        'porque no asume la lectura más restrictiva sin evidencia fuerte.',
      referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
      desde: '2026-08-12',
    },
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'ACREDITAMIENTO', movimientos: 78, lado: 'haber' }],
    },
  },
  transferencia_recibida_de_terceros: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'decide_una_persona',
    tipo: 'cobranza_de_cliente',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'TRANSFERENCIA DE TERCEROS', movimientos: 1, lado: 'haber' }],
    },
  },

  // === pago_de_obligacion_fiscal ========================================================================
  pago_a_organismo_fiscal_afip: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_de_obligacion_fiscal',
    queDecide: 'elegir_cuenta_de_pasivo_del_impuesto', // regla 6, manual explícito — sin pregunta abierta
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'TRANSF. AFIP', movimientos: 4, lado: 'debe' }],
    },
  },

  // === acreditacion_tarjeta =============================================================================
  anulacion_acreditamiento_firstdata: {
    // No se modela como `reversaDe: 'acreditamiento'`: el concepto base ('acreditamiento') tiene su
    // propio tipo sin confirmar (pendienteDeLaura), y forzar una relación de reversa formal presumiría
    // un vínculo que todavía no está verificado. Se deja como concepto propio, con la misma pregunta
    // abierta — más honesto que una relación de reversa sin evidencia sólida.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'acreditacion_tarjeta',
    queDecide: 'completar_con_liquidacion_del_adquirente',
    pendienteDeLaura: {
      pregunta: 'Ver la pregunta de ACREDITAMIENTO — esta es su probable anulación (FIRSTDATA es un ' +
        'procesador de tarjetas real), pero la identidad del concepto base todavía no está confirmada.',
      hipotesis: 'Reversa económica de ACREDITAMIENTO cuando ese concepto resulte ser adquirente de ' +
        'tarjetas — mismo motivo que la pregunta de acreditamiento.',
      referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
      desde: '2026-08-12',
    },
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'ANULAC. ACRED. FIRSTDATA.', movimientos: 3, lado: 'debe' }],
    },
  },

  // === extraccion_efectivo ==============================================================================
  extraccion_efectivo_autoservicio: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'extraccion_efectivo',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'EXTRACCION EN AUTOSERVICIO', movimientos: 1, lado: 'debe' }],
    },
  },

  // === pago_con_cheque_propio ===========================================================================
  pago_cheque_propio: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_con_cheque_propio',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'CHEQUE PAGADOR NRO.', movimientos: 3, lado: 'debe' }],
    },
  },

  // === sin tipo asignado — los tres motivos que mezclaba esta categoría (hallazgo de tech-lead,
  // convocatoria de coherencia) ahora están discriminados estructuralmente por `categoriaDelHueco`
  // (`ResolucionDelConcepto`, arriba), no solo por el texto libre de `motivoDelHueco`. Las 4 de acá son
  // 'implementacion_diferida': el criterio contable ya está resuelto (con Laura o por 04 §3.1), falta
  // programar la imputación (el dato vive en un documento separado del extracto — FCI, tarjeta
  // corporativa — y necesita una decisión de ingesta de Módulo 1 primero).
  compra_con_tarjeta_debito_generica: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'implementacion_diferida',
    motivoDelHueco:
      'El tipo compra_con_tarjeta_debito existe en 04 §3.1 ("tiene que existir igual") pero su cuenta ' +
      'destino no está ratificada — no se asigna hasta que ESTADO_DE_LOS_TIPOS lo marque habilitado.',
    referencia: 'docs/diseno/04-imputacion-contable.md §3.1',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'COMPRA DEBITO', movimientos: 11, lado: 'debe' }],
    },
  },
  rescate_fci: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'implementacion_diferida',
    motivoDelHueco:
      'Criterio contable conocido (asiento simple + reimputación PEPS, resuelto por Laura en esta ' +
      'sesión), pero la implementación (capa D/E, el dato de cuotapartes vive en un documento separado ' +
      'del extracto bancario) queda fuera de esta etapa — decisión de ingesta de Módulo 1 pendiente.',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'RESCATE FIMA', movimientos: 10, lado: 'haber' }],
    },
  },
  suscripcion_fci: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'implementacion_diferida',
    motivoDelHueco: 'Mismo motivo que rescate_fci.',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'SUSCRIPCION FIMA', movimientos: 4, lado: 'debe' }],
    },
  },
  pago_de_servicios: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'identidad_incierta',
    motivoDelHueco:
      'Podría ser debito_automatico_servicio (tipo 12, pendiente_de_ratificacion — 05 §10 pregunta ' +
      '"¿tipo 12 o gasto propio?") o un pago genérico distinto — sin hipótesis única razonable para ' +
      'asignar tipo sin la respuesta de Laura.',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'PAGO DE SERVICIOS', movimientos: 5, lado: 'debe' }],
    },
  },
  debito_automatico_de_servicio: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'identidad_incierta',
    motivoDelHueco: 'Mismo motivo que pago_de_servicios — es el otro literal candidato a la misma pregunta.',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'DEB. AUTOM. DE SERV.', movimientos: 3, lado: 'debe' }],
    },
  },
  pago_tarjeta_corporativa_visa: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'implementacion_diferida',
    motivoDelHueco:
      'Criterio contable conocido (mapeo verificado a 5 cuentas: Proveedores, Importaciones, Impuestos ' +
      'y tasas, Gastos y comisiones, Cargas financieras, contra Tarjeta corporativa a pagar), pero la ' +
      'implementación queda fuera de esta etapa — decisión de ingesta de Módulo 1 pendiente (resumen de ' +
      'tarjeta es documento separado del extracto).',
    referencia: 'docs/diseno/04-imputacion-contable.md §3.1',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'PAGO VISA EMPRESA', movimientos: 2, lado: 'debe' }],
    },
  },

  // === genuinamente indeterminado, sin hipótesis fuerte del léxico ========================================
  transferencia_cash_management: {
    polaridad: 'normal',
    ladoEsperado: 'indistinto',
    pendienteDeLaura: {
      pregunta:
        '¿TRANSFERENCIAS CASH (8 mov., canal Cash Management) son siempre pagos a proveedores, o el ' +
        'canal se usa también para cobranzas? El literal no distingue dirección.',
      hipotesis:
        'Pago a proveedor por defecto (misma forma económica que TRF INMED PROVEED), pero sin evidencia ' +
        'de dirección en el vocabulario medido — podría ser también cobranza.',
      referencia: 'docs/diseno/02-formato-galicia.md §14',
      desde: '2026-08-13',
    },
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'confirmar_hipotesis_del_lexico',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/02-formato-galicia.md',
      seccion: '§14',
      porLiteral: [{ literal: 'TRANSFERENCIAS CASH', movimientos: 8, lado: 'ambos' }],
    },
  },

  // ══ Santander (P7) ═══════════════════════════════════════════════════════════════════════════════

  // === acreditacion_tarjeta ============================================================================
  acreditacion_tarjeta_first_data_visa: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'decide_una_persona',
    tipo: 'acreditacion_tarjeta',
    queDecide: 'completar_con_liquidacion_del_adquirente',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Pago comercios first data visa nro.liq.', movimientos: 29, lado: 'haber' }],
    },
  },
  acreditacion_tarjeta_first_data_master: {
    // 17 mov., 6 débito + 11 crédito bajo el MISMO literal — el caso real que motivó ladoEsperado
    // 'indistinto' (ratificado por contador-dominio). Los 6 débitos podrían ser contracargos.
    polaridad: 'normal',
    ladoEsperado: 'indistinto',
    pendienteDeLaura: {
      pregunta:
        '¿Pago comercios first data master nro.liq. (17 mov., 6 débito + 11 crédito con el MISMO ' +
        'literal) son contracargos los 6 débitos, o el circuito de Mastercard liquida distinto del de ' +
        'Visa? Con un lado fijo, los 6 débitos saldrían "reversa_incoherente" — un motivo falso que ' +
        'esconde la pregunta real.',
      hipotesis:
        'Contracargos (chargebacks) del adquirente — es la lectura más común para un débito dentro de ' +
        'un flujo que por diseño es de cobro (crédito). Sin evidencia adicional para confirmarlo.',
      referencia: 'docs/diseno/06-formato-santander.md §12',
      desde: '2026-08-13',
    },
    resuelve: 'decide_una_persona',
    tipo: 'acreditacion_tarjeta',
    queDecide: 'completar_con_liquidacion_del_adquirente',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Pago comercios first data master nro.liq.', movimientos: 17, lado: 'ambos' }],
    },
  },
  acreditacion_tarjeta_first_data_debito: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'decide_una_persona',
    tipo: 'acreditacion_tarjeta',
    queDecide: 'completar_con_liquidacion_del_adquirente',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Pago comercios first data m. deb nro.liq.', movimientos: 10, lado: 'haber' }],
    },
  },
  acreditacion_tarjeta_getnet: {
    // 1 solo movimiento, DÉBITO — el resto de la familia "Pago comercios..." es crédito. Se declara el
    // lado tal como se midió (no 'indistinto': acá no hay ambigüedad DENTRO del literal, la anomalía es
    // comparativa contra sus hermanos) y se pregunta en vez de asumir un contracargo sin evidencia.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'acreditacion_tarjeta',
    queDecide: 'confirmar_hipotesis_del_lexico',
    pendienteDeLaura: {
      pregunta:
        '¿Pago comercios getnet nro.liq. (1 mov., DÉBITO) es un contracargo puntual, o Getnet liquida ' +
        'con polaridad distinta de First Data (Visa/Master/m.deb, todos crédito)?',
      hipotesis: 'Contracargo puntual — el volumen (1 movimiento) no alcanza para inferir un patrón ' +
        'estructural distinto por procesadora.',
      referencia: 'docs/diseno/06-formato-santander.md §12',
      desde: '2026-08-13',
    },
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Pago comercios getnet nro.liq.', movimientos: 1, lado: 'debe' }],
    },
  },

  // === retencion_iibb_bancaria (transiciona a habilitado con esta fila) ================================
  retencion_sircreb: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'retencion_iibb_bancaria',
    queDecide: 'elegir_jurisdiccion_de_la_retencion',
    // 04 §3 fila 5: el tipo es D, la cuenta exige `jurisdiccion` — el literal no la publica.
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Regimen de recaudacion sircreb y', movimientos: 8, lado: 'debe' }],
    },
  },

  // === cobranza_de_cliente ==============================================================================
  credito_transferencia_online_banking: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'decide_una_persona',
    tipo: 'cobranza_de_cliente',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Credito transf online banking emp', movimientos: 3, lado: 'haber' }],
    },
  },
  pago_recibido_como_proveedor: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'decide_una_persona',
    tipo: 'cobranza_de_cliente',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Pago a proveedores recibido', movimientos: 2, lado: 'haber' }],
    },
  },

  // === sin tipo asignado — discriminado por `categoriaDelHueco` (ver la nota completa en la sección de
  // Galicia): echeq_recibido_debito y debito_automatico_generico son 'identidad_incierta';
  // impuesto_de_sellos (más abajo) es 'sin_tipo_en_catalogo'.
  echeq_recibido_debito: {
    // 🔴 Hallazgo de analista-funcional: los DOS literales de Echeq miden DÉBITO pese a decir
    // "recibido" — contradice la lectura obvia (13c depósito de cheques de terceros, régimen haber
    // fijo). Sin hipótesis razonable — se deja sin tipo, en vez de forzar 13c contra la evidencia medida.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'identidad_incierta',
    motivoDelHueco:
      '"Echeq...recibido" mide DÉBITO en los dos literales (canje interno 24hs y clearing 48hs), lo que ' +
      'contradice la lectura obvia de depósito de cheques de terceros (13c, régimen haber fijo). Podría ' +
      'ser el banco recibiendo el echeq para canje (no el cliente cobrándolo), una comisión asociada, o ' +
      'un movimiento de otra naturaleza — sin evidencia suficiente para una hipótesis única razonable.',
    referencia: 'docs/diseno/06-formato-santander.md §12',
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
  impuesto_de_sellos: {
    // Hallazgo de analista-funcional: identidad no verificada contra los 31 tipos del catálogo — no hay
    // un tipo dedicado a sellado bancario en 04 §3/§3.1.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'sin_tipo_en_catalogo',
    motivoDelHueco:
      'El catálogo de 31 tipos no tiene ninguno para el impuesto de sellos bancario — no es ' +
      'pago_de_obligacion_fiscal (6, que es un PAGO al organismo, no una retención bancaria) ni ' +
      'ningún otro tipo fiscal del catálogo. Puede necesitar un tipo propio.',
    referencia: 'docs/diseno/06-formato-santander.md §12',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Impuesto de sellos', movimientos: 2, lado: 'debe' }],
    },
  },
  debito_automatico_generico: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'identidad_incierta',
    motivoDelHueco: 'Mismo motivo que debito_automatico_de_servicio de Galicia — 05 §10 pregunta ' +
      '"¿tipo 12 o gasto propio?", sin resolver.',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Debito automatico', movimientos: 1, lado: 'debe' }],
    },
  },

  // === percepcion_impositiva ============================================================================
  iva_21_regimen_transparencia_fiscal: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'percepcion_impositiva',
    queDecide: 'confirmar_computo_de_credito_fiscal',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Iva 21% reg de transfisc ley27743', movimientos: 3, lado: 'debe' }],
    },
  },
  iva_10_5_regimen_transparencia_fiscal: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'percepcion_impositiva',
    queDecide: 'confirmar_computo_de_credito_fiscal',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Iva 10,5% reg trans fisc ley 27743', movimientos: 2, lado: 'debe' }],
    },
  },
  percepcion_iva_rg_2408: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'percepcion_impositiva',
    queDecide: 'confirmar_computo_de_credito_fiscal',
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

  // === interes_por_descubierto (transiciona a habilitado con esta fila) ================================
  interes_por_descubierto_cobrado: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'interes_por_descubierto',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Cobro de interes por descubierto', movimientos: 2, lado: 'debe' }],
    },
  },

  // === deposito_efectivo (transiciona a habilitado con esta fila) ======================================
  deposito_de_efectivo: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'propone',
    tipo: 'deposito_efectivo',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Deposito de efectivo', movimientos: 2, lado: 'haber' }],
    },
  },

  // === pago_a_proveedor_transferencia ===================================================================
  // Los cuatro conceptos de Santander de acá abajo (transferencia_realizada_generica, pago_de_honorarios,
  // snp_debito_directo, transferencia_inmediata_generica) comparten tipo y régimen, y podrían leerse
  // como el mismo hecho — se mantienen separados por el mismo criterio conservador que
  // pago_a_proveedor_inmediato (arriba): literales distintos sin evidencia de que sean el mismo
  // circuito, y fusionar sin confirmación sería asumir una equivalencia que PROP-2 no puede verificar.
  transferencia_realizada_generica: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Transferencia realizada', movimientos: 1, lado: 'debe' }],
    },
  },
  pago_de_honorarios: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Pago de honorarios', movimientos: 1, lado: 'debe' }],
    },
  },
  snp_debito_directo: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Snp debito directo', movimientos: 1, lado: 'debe' }],
    },
  },
  transferencia_inmediata_generica: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Transferencia inmediata', movimientos: 1, lado: 'debe' }],
    },
  },

  // === comision_bancaria ================================================================================
  comision_gestion_de_cobertura: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Comision gestion de cobertura', movimientos: 1, lado: 'debe' }],
    },
  },
  comision_de_mantenimiento_de_cuenta_dolares: {
    // El gasto de la cuenta en USD se cobra en la cuenta en PESOS — doc: "un motor que agrupe por
    // moneda desde el concepto se equivoca". El concepto es correcto igual: es una comisión, la
    // resolución de EN QUÉ CUENTA imputarla es de capa D (imputación), fuera de esta etapa.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/06-formato-santander.md',
      seccion: '§12',
      porLiteral: [{ literal: 'Comision servicio cuenta dolares', movimientos: 1, lado: 'debe' }],
    },
  },

  // ══ Macro (P8) ═══════════════════════════════════════════════════════════════════════════════════

  // === pago_a_proveedor_transferencia ===================================================================
  transferencia_macronline_debito: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'N/D Transf. MacrOnline E-set D/T', movimientos: 29, lado: 'debe' }],
    },
  },
  transferencia_minorista_distinto_titular: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'N/D DB TRANSF MINORISTA DIST TIT', movimientos: 7, lado: 'debe' }],
    },
  },

  // === pago_con_cheque_propio ===========================================================================
  pago_cheque_de_camara: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_con_cheque_propio',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'PAGO DE CHEQUE DE CAMARA', movimientos: 16, lado: 'debe' }],
    },
  },

  // === comision_bancaria ================================================================================
  comision_de_deposito_o_rechazo_de_cheque: {
    // contador-dominio (convocatoria bloqueante): el nombre bundlea comisión de depósito rutinaria y
    // comisión por rechazo — sin evidencia de que sean dos literales distintos en el corpus medido
    // (ambos literales son variantes de escritura del mismo patrón, no dos hechos), se mantiene UN
    // concepto. Revisar si aparece evidencia real que los separe.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [
        { literal: 'N/D FV COMISION DEPOSITO Ó RECH CHE', movimientos: 1, lado: 'debe' },
        { literal: 'N/D COMISION DEPOSITO O RECH CHEQ', movimientos: 1, lado: 'debe' },
      ],
    },
  },
  comision_administracion_de_valores: {
    // contador-dominio: la justificación de agrupar comisiones bajo un tipo es trazabilidad de
    // evidencia por sub-tipo (04 §4), no "puede ir a otra cuenta" — si un cliente necesita distinguir
    // gastos de custodia de gastos bancarios de rutina, hace falta un TIPO propio (decisión de
    // plan-cuentas-multicliente, no tomada acá). Queda bajo comision_bancaria hasta esa decisión.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'N/D COMISION ADM.VALORES AL COBRO C', movimientos: 1, lado: 'debe' }],
    },
  },
  comision_administracion_de_chequera: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'comision_bancaria',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'N/D COMISIÓN ADMINISTRACIÓN DE CHEQUERA', movimientos: 1, lado: 'debe' }],
    },
  },

  // === percepcion_impositiva ============================================================================
  debito_fiscal_iva_basico: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'percepcion_impositiva',
    queDecide: 'confirmar_computo_de_credito_fiscal',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'DEBITO FISCAL IVA BASICO', movimientos: 7, lado: 'debe' }],
    },
  },
  retencion_iva_percepcion_macro: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'percepcion_impositiva',
    queDecide: 'confirmar_computo_de_credito_fiscal',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'RETENCION IVA PERCEPCION', movimientos: 5, lado: 'debe' }],
    },
  },

  // === retencion_iibb_bancaria ===========================================================================
  retencion_iibb_cordoba_renta_financiera: {
    // 🔴 NO es SIRCREB (07 §12.1) — jurisdicción publicada (Córdoba), a diferencia de la de Santander.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'retencion_iibb_bancaria',
    queDecide: 'elegir_jurisdiccion_de_la_retencion',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'RETENCION IIBB CORDOBA RENTA FINANC', movimientos: 6, lado: 'debe' }],
    },
  },

  // === pago_de_haberes (transiciona a habilitado con esta fila) ========================================
  pago_de_remuneraciones: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'pago_de_haberes',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'N/D DB PAGO REMUNERACIONES', movimientos: 6, lado: 'debe' }],
    },
  },

  // === deposito_cheques_terceros =========================================================================
  acreditacion_cheque_remesas: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'decide_una_persona',
    tipo: 'deposito_cheques_terceros',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'ACREDITACION CHEQUE REMESAS', movimientos: 5, lado: 'haber' }],
    },
  },
  deposito_canje_interno_fv: {
    polaridad: 'normal',
    ladoEsperado: 'haber',
    resuelve: 'decide_una_persona',
    tipo: 'deposito_cheques_terceros',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'N/C FV CR DEPOSITO CANJE INTERNO', movimientos: 1, lado: 'haber' }],
    },
  },

  // === cheque_rechazado (transiciona a habilitado con esta fila) =======================================
  cheque_devuelto_canje_interno: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'cheque_rechazado',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'N/D FV CHEQ.DEV. DEP.CJE. INTERNO', movimientos: 1, lado: 'debe' }],
    },
  },
  cheque_devuelto_remesas: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'cheque_rechazado',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'ND CHEQUE DEVUELTO REMESAS', movimientos: 1, lado: 'debe' }],
    },
  },

  // === pago_con_cheque_propio ============================================================================
  cheque_canje_interno: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'decide_una_persona',
    tipo: 'pago_con_cheque_propio',
    queDecide: 'distinguir_tercero_de_socio',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'CHEQUE CANJE INTERNO', movimientos: 3, lado: 'debe' }],
    },
  },

  // === extraccion_efectivo ==============================================================================
  retiro_caja_ahorro: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'extraccion_efectivo',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'RETIRO CAJ.AH.', movimientos: 2, lado: 'debe' }],
    },
  },
  extraccion_efectivo_idcb_pyme: {
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'propone',
    tipo: 'extraccion_efectivo',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'N/D IDCB GRAL. EXTRAC EFVO PYME', movimientos: 2, lado: 'debe' }],
    },
  },

  // === prefijos con contraparte (matcheo prefijo_con_cola) ===============================================
  transferencia_mo_ccdo_distinto_titular: {
    // Sin lado publicado por el banco para este prefijo específico — a diferencia de TPUSH/TRANSF, el
    // documento no lo enmarca explícitamente como "recibida". Se pregunta en vez de asumir dirección.
    polaridad: 'normal',
    ladoEsperado: 'indistinto',
    pendienteDeLaura: {
      pregunta: '¿TRF MO CCDO DIST T - <n> (9 mov.) es una transferencia enviada o recibida? El ' +
        'vocabulario medido no publica el lado para este prefijo específico.',
      hipotesis: 'Sin hipótesis fuerte — a diferencia de TPUSH/TRANSF (que 07-formato-macro.md §12.1 ' +
        'enmarca explícitamente como "recibidas"), este prefijo no tiene esa misma evidencia textual.',
      referencia: 'docs/diseno/07-formato-macro.md §12',
      desde: '2026-08-13',
    },
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'confirmar_hipotesis_del_lexico',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'TRF MO CCDO DIST T - <n>', movimientos: 9, lado: 'no_medido' }],
    },
  },
  transferencia_con_token: {
    polaridad: 'normal',
    ladoEsperado: 'indistinto',
    pendienteDeLaura: {
      pregunta: '¿TRANSF:<token>-<n> (78 mov., el ancla que costó 84 movimientos por el espacio mal ' +
        'puesto) es transferencia enviada o recibida? Y separado: ¿es el mismo producto que CREDIN: o ' +
        'uno distinto?',
      hipotesis: 'Sin hipótesis fuerte sobre dirección — el prefijo "TRANSF:" con dos puntos podría ser ' +
        'un canal técnico distinto de "TRANSF " (espacio), no necesariamente la misma semántica.',
      referencia: 'docs/diseno/07-formato-macro.md §12',
      desde: '2026-08-13',
    },
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'confirmar_hipotesis_del_lexico',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'TRANSF:<token>-<n>', movimientos: 78, lado: 'no_medido' }],
    },
  },
  acreditacion_credin: {
    // 🔴 Corregido por tech-lead (convocatoria de coherencia): esta entrada tenía la misma evidencia
    // no_medido que sus 4 hermanas (transferencia_mo_ccdo_distinto_titular, transferencia_con_token,
    // cheque_circuito_cerrado, transferencia_electronica_datanet) pero un ladoEsperado FIJO basado en
    // que 'CRED' sugiere crédito — asumiendo la lectura más restrictiva sin evidencia del corpus, el
    // modo de falla exacto que el diseño existe para impedir (plan §1: "no asume sin evidencia fuerte").
    // Mismo tratamiento que sus hermanas: indistinto + pendienteDeLaura.
    polaridad: 'normal',
    ladoEsperado: 'indistinto',
    pendienteDeLaura: {
      pregunta: '¿CREDIN:<token>-<n> (6 mov.) es transferencia enviada o recibida? "CRED" en el prefijo ' +
        'sugiere crédito, pero el vocabulario medido no publica el lado — no se asume sin confirmar.',
      hipotesis: 'Con más base que transferencia_con_token (el prefijo "CRED" apunta a crédito), pero ' +
        'sigue siendo una lectura del nombre, no una medición — no alcanza para fijar el lado.',
      referencia: 'docs/diseno/07-formato-macro.md §12',
      desde: '2026-08-13',
    },
    resuelve: 'decide_una_persona',
    tipo: 'cobranza_de_cliente',
    queDecide: 'confirmar_hipotesis_del_lexico',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'CREDIN:<token>-<n>', movimientos: 6, lado: 'no_medido' }],
    },
  },
  cheque_circuito_cerrado: {
    // contador-dominio: no hay tipo que encaje — no es 12c/13c (eso es un tercero), el circuito cerrado
    // es un acuerdo con el banco. No hay hipótesis razonable.
    polaridad: 'normal',
    ladoEsperado: 'debe',
    resuelve: 'sin_tipo_asignado',
    categoriaDelHueco: 'sin_tipo_en_catalogo',
    motivoDelHueco:
      'El catálogo de 31 tipos no tiene ninguno para el cheque de pago diferido en circuito cerrado — ' +
      'no es pago_con_cheque_propio (12c) ni deposito_cheques_terceros (13c): el circuito cerrado es un ' +
      'acuerdo con el banco, no una operación con un tercero identificable.',
    referencia: 'docs/diseno/07-formato-macro.md §12.1',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'CCERR <razón social> <n> CIRC.CERRADO', movimientos: 5, lado: 'no_medido' }],
    },
  },
  transferencia_electronica_datanet: {
    polaridad: 'normal',
    ladoEsperado: 'indistinto',
    pendienteDeLaura: {
      pregunta: '¿TEF DATANET PR <razón social> (4 mov.) es transferencia enviada o recibida?',
      hipotesis: 'Sin hipótesis fuerte — mismo motivo que transferencia_mo_ccdo_distinto_titular.',
      referencia: 'docs/diseno/07-formato-macro.md §12',
      desde: '2026-08-13',
    },
    resuelve: 'decide_una_persona',
    tipo: 'pago_a_proveedor_transferencia',
    queDecide: 'confirmar_hipotesis_del_lexico',
    procedencia: {
      fuente: 'corpus_medido',
      documento: 'docs/diseno/07-formato-macro.md',
      seccion: '§12',
      porLiteral: [{ literal: 'TEF DATANET PR <razón social>', movimientos: 4, lado: 'no_medido' }],
    },
  },
} as const satisfies Record<ConceptoCanonico, FilaDelCatalogo>;

// -----------------------------------------------------------------------------------------------------

export type EstadoDeTipo =
  | { readonly estado: 'habilitado' }
  | { readonly estado: 'sin_evidencia_en_el_roster'; readonly motivo: string; readonly referencia: string }
  | { readonly estado: 'pendiente_de_ratificacion'; readonly motivo: string; readonly referencia: string };

/**
 * PROP-5: todo tipo tiene ≥1 entrada, O una declaración explícita de por qué no.
 *
 * 🔴 Se construye incrementalmente, igual que `CATALOGO_CANONICO` — refleja el estado real de ESTE
 * paso del plan (P4/P5, solo Galicia). Algunos tipos marcados `sin_evidencia_en_el_roster` acá SÍ
 * tienen evidencia en Santander/Macro (ya verificada en la exploración de esta sesión) — el motivo lo
 * dice explícitamente para que no se lea como "ningún banco lo publica", y se corrige a `habilitado`
 * en P7/P8 cuando ese léxico exista de verdad.
 */
export const ESTADO_DE_LOS_TIPOS = {
  impuesto_debitos_creditos: { estado: 'habilitado' },
  comision_bancaria: { estado: 'habilitado' },
  iva_sobre_gasto_bancario: { estado: 'habilitado' },
  percepcion_impositiva: { estado: 'habilitado' },
  pago_a_proveedor_transferencia: { estado: 'habilitado' },
  transferencia_entre_cuentas_propias: { estado: 'habilitado' },
  cobranza_de_cliente: { estado: 'habilitado' },
  pago_de_obligacion_fiscal: { estado: 'habilitado' },
  acreditacion_tarjeta: { estado: 'habilitado' },
  extraccion_efectivo: { estado: 'habilitado' },
  pago_con_cheque_propio: { estado: 'habilitado' },

  compra_con_tarjeta_debito: {
    estado: 'pendiente_de_ratificacion',
    motivo: 'Identidad de literal clara (COMPRA DEBITO, Galicia), cuenta destino sin criterio ratificado.',
    referencia: 'docs/diseno/04-imputacion-contable.md §3.1',
  },
  rescate_fci: {
    estado: 'pendiente_de_ratificacion',
    motivo: 'Criterio conocido, implementación diferida (dato de cuotapartes en documento separado).',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
  },
  suscripcion_fci: {
    estado: 'pendiente_de_ratificacion',
    motivo: 'Mismo motivo que rescate_fci.',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
  },
  debito_automatico_servicio: {
    estado: 'pendiente_de_ratificacion',
    motivo: '05 §10 pregunta abierta: "¿tipo 12 o gasto propio?" — criterio no resuelto.',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §10',
  },
  pago_tarjeta_corporativa: {
    estado: 'pendiente_de_ratificacion',
    motivo: 'Mapeo a 5 cuentas verificado, implementación fuera de esta etapa (decisión de Módulo 1).',
    referencia: 'docs/diseno/04-imputacion-contable.md §3.1',
  },

  retencion_iibb_bancaria: { estado: 'habilitado' }, // P7: retencion_sircreb (Santander, 8 mov.)
  deposito_efectivo: { estado: 'habilitado' }, // P7: deposito_de_efectivo (Santander, 2 mov.); Macro también lo mide (P8)
  cheque_rechazado: { estado: 'habilitado' }, // P8: cheque_devuelto_canje_interno + cheque_devuelto_remesas (Macro)
  interes_por_descubierto: { estado: 'habilitado' }, // P7: interes_por_descubierto_cobrado (Santander, 2 mov.)
  interes_de_financiacion: {
    estado: 'sin_evidencia_en_el_roster',
    motivo: 'Cero evidencia en los 32+29+43 literales medidos de los tres bancos del piloto.',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §0.B',
  },
  pago_de_haberes: { estado: 'habilitado' }, // P8: pago_de_remuneraciones (Macro, "N/D DB PAGO REMUNERACIONES")
  retiro_de_socio: {
    estado: 'sin_evidencia_en_el_roster',
    motivo:
      'No se alcanza por literal: es el resultado de resolver distinguir_tercero_de_socio contra el ' +
      'padrón (capa C, fuera de esta etapa) — ningún concepto del léxico apunta acá directamente.',
    referencia: 'docs/diseno/04-imputacion-contable.md §1 (capa C)',
  },
  aporte_de_socio: {
    estado: 'sin_evidencia_en_el_roster',
    motivo: 'Mismo motivo que retiro_de_socio.',
    referencia: 'docs/diseno/04-imputacion-contable.md §1 (capa C)',
  },
  // P8: acreditacion_cheque_remesas + deposito_canje_interno_fv (Macro). El atributo por cliente
  // usa_circuito_de_valores (04 §4) sigue sin resolver — decide la IMPUTACIÓN (capa D, fuera de esta
  // etapa), no si el tipo tiene evidencia de reconocimiento.
  deposito_cheques_terceros: { estado: 'habilitado' },
  indeterminado: {
    estado: 'sin_evidencia_en_el_roster',
    motivo: 'No es un tipo que un concepto declare — es el resultado, no una entrada del léxico.',
    referencia: 'docs/diseno/04-imputacion-contable.md §3',
  },
  acreditacion_prestamo: {
    estado: 'sin_evidencia_en_el_roster',
    motivo: 'Cero evidencia en los tres bancos del piloto.',
    referencia: 'docs/diseno/04-imputacion-contable.md §3.1',
  },
  cuota_prestamo: {
    estado: 'sin_evidencia_en_el_roster',
    motivo: 'Cero evidencia — y aunque apareciera, desdobla en capital+interés+IVA, ninguno en el extracto.',
    referencia: 'docs/diseno/04-imputacion-contable.md §3.1',
  },
  compra_venta_de_divisas: {
    estado: 'sin_evidencia_en_el_roster',
    motivo: 'Cero evidencia en los tres bancos del piloto.',
    referencia: 'docs/diseno/04-imputacion-contable.md §3.1',
  },
  movimiento_en_cero: {
    estado: 'sin_evidencia_en_el_roster',
    motivo: 'Se detecta por importe = 0, no por literal — ningún concepto del léxico apunta acá.',
    referencia: 'docs/diseno/04-imputacion-contable.md §3.1',
  },
  reverso_de_movimiento: {
    estado: 'sin_evidencia_en_el_roster',
    motivo:
      'Las reversas medidas hasta ahora modelan como polaridad:"reversa" DENTRO del tipo de su base ' +
      '(ej. devolucion_impuesto_25413_sobre_creditos sigue siendo tipo impuesto_debitos_creditos), no ' +
      'como este tipo genérico — que queda para reversas sin tipo base propio, sin evidencia todavía.',
    referencia: 'docs/diseno/05-motor-de-reconocimiento.md §4',
  },
} as const satisfies Record<TipoMovimiento, EstadoDeTipo>;
