/**
 * Los dominios cerrados del núcleo — Módulo 2, capa B (reconocimiento).
 *
 * ⏳ NINGUNA de estas constantes TIENE CHECK EN LA BASE todavía: no existe la migración `0014`. Cuando
 * exista y cree `reconocimiento_tipo_chk`/`reconocimiento_via_chk`/`reconocimiento_decide_chk`/
 * `reconocimiento_motivo_chk`, agregar la fila correspondiente en `DOMINIOS_CERRADOS`
 * (`packages/data/tests/catalogo.test.ts`) y reemplazar esta nota por la fórmula del repo ("Idéntica a
 * `x_chk`; hay test de catálogo"). Mientras tanto el árbitro es
 * `packages/contabilidad/tests/dominios-pendientes.test.ts`.
 */

/**
 * Los tipos de movimiento — `04-imputacion-contable.md` §3 (21 filas) + §3.1 (10 tipos adicionales que
 * las 14 reglas no cubren pero tienen que existir igual, o caen en silencio en una regla equivocada).
 *
 * ⏳ TODAVÍA NO TIENE CHECK EN LA BASE.
 */
export const TIPOS_MOVIMIENTO = [
  // §3 — catálogo principal (14 reglas de la contadora)
  'impuesto_debitos_creditos',
  'comision_bancaria',
  'iva_sobre_gasto_bancario',
  'percepcion_impositiva',
  'interes_de_financiacion',
  'interes_por_descubierto',
  'retencion_iibb_bancaria',
  'pago_de_obligacion_fiscal',
  'pago_de_haberes',
  'deposito_efectivo',
  'extraccion_efectivo',
  'transferencia_entre_cuentas_propias',
  'acreditacion_tarjeta',
  'pago_a_proveedor_transferencia',
  'retiro_de_socio',
  'pago_con_cheque_propio',
  'cobranza_de_cliente',
  'aporte_de_socio',
  'deposito_cheques_terceros',
  'cheque_rechazado',
  'indeterminado',
  // §3.1 — no cubiertos por las 14 reglas, declarados para no caer en silencio en una regla equivocada
  'pago_tarjeta_corporativa',
  'suscripcion_fci',
  'rescate_fci',
  'compra_con_tarjeta_debito',
  'debito_automatico_servicio',
  'acreditacion_prestamo',
  'cuota_prestamo',
  'compra_venta_de_divisas',
  'movimiento_en_cero',
  'reverso_de_movimiento',
] as const;
export type TipoMovimiento = (typeof TIPOS_MOVIMIENTO)[number];

/**
 * `05-motor-de-reconocimiento.md` §4: la polaridad es una INTERPRETACIÓN (no un hecho del documento
 * como el lado). Una reversa es el mismo tipo que su base, con el lado invertido — nunca un tipo aparte.
 *
 * ⏳ TODAVÍA NO TIENE CHECK EN LA BASE.
 */
export const POLARIDADES = ['normal', 'reversa'] as const;
export type Polaridad = (typeof POLARIDADES)[number];

/** `04-imputacion-contable.md` §2: `lado = columnaOrigen === 'credito' ? 'haber' : 'debe'`. */
export const LADOS = ['debe', 'haber'] as const;
export type Lado = (typeof LADOS)[number];

export function opuesto(lado: Lado): Lado {
  return lado === 'debe' ? 'haber' : 'debe';
}

/**
 * `05-motor-de-reconocimiento.md` §2.1 — la confianza ES la vía, sin score inventado. Unión cerrada y
 * ordenada por precedencia (el código gana sobre el texto).
 *
 * H3 (verificado): ningún adaptador del roster emite `conceptoCodigo` hoy. Las tres vías basadas en
 * código (`codigo_y_texto_concordantes`, `codigo_concepto`, `texto_con_codigo_no_catalogado`) quedan
 * declaradas pero inalcanzables en esta etapa — ver R-... en `reglas-de-codigo.test.ts` y PROP-9.
 *
 * ⏳ TODAVÍA NO TIENE CHECK EN LA BASE.
 */
export const VIAS_EVIDENCIA = [
  'codigo_y_texto_concordantes',
  'codigo_concepto',
  'texto_literal_exacto',
  'texto_prefijo_unico',
  'texto_prefijo_con_cola',
  'texto_con_codigo_no_catalogado',
] as const;
export type ViaEvidencia = (typeof VIAS_EVIDENCIA)[number];

/**
 * Qué decisión concreta le queda a la persona cuando el motor YA SABE el tipo pero no puede elegir la
 * cuenta (clase `decision_humana`, `05-motor-de-reconocimiento.md` §5). 8 valores, no 5: los 3 nuevos
 * surgieron del corpus real medido y fueron ratificados por `contador-dominio` (convocatoria bloqueante,
 * ver el plan §9) — cada uno protege una cuenta o una decisión distinta, ninguno se fusiona con los
 * 5 originales de las 14 reglas.
 *
 * ⏳ TODAVÍA NO TIENE CHECK EN LA BASE.
 */
export const QUE_DECIDE = [
  // Los 5 originales, derivados de las 14 reglas de la contadora (05 §5)
  'elegir_cuenta_de_pasivo_del_impuesto', // regla 6 — tipo 6, pago_de_obligacion_fiscal
  'confirmar_cuenta_propia_destino', // regla 10 — tipo 10, transferencia_entre_cuentas_propias
  'distinguir_tercero_de_socio', // reglas 12/13 — necesita el padrón de socios (capa C)
  'completar_con_liquidacion_del_adquirente', // regla 11 — tipo 11, acreditacion_tarjeta (cobro)
  'confirmar_computo_de_credito_fiscal', // regla 3 — tipo 3, iva_sobre_gasto_bancario
  // Los 3 nuevos, del corpus real (ver plan §2, ratificados por contador-dominio)
  'elegir_jurisdiccion_de_la_retencion', // SIRCREB/IIBB sin jurisdicción publicada — tipo 5, activo
  'completar_con_liquidacion_de_la_tarjeta', // tarjeta corporativa (pago) — tipo pago_tarjeta_corporativa
  'confirmar_hipotesis_del_lexico', // destino de las entradas marcadas pendienteDeLaura
] as const;
export type QueDecide = (typeof QUE_DECIDE)[number];

/**
 * `05-motor-de-reconocimiento.md` §5 — por qué un movimiento cae en `clase: 'sin_reconocer'`.
 *
 * ⏳ TODAVÍA NO TIENE CHECK EN LA BASE.
 */
export const MOTIVOS_SIN_RECONOCER = [
  'concepto_no_catalogado',
  'concepto_sin_tipo_asignado',
  'codigo_no_catalogado',
  'evidencia_contradictoria',
  'ambiguo',
  'reversa_incoherente',
  'sin_evidencia_de_concepto',
] as const;
export type MotivoSinReconocer = (typeof MOTIVOS_SIN_RECONOCER)[number];
