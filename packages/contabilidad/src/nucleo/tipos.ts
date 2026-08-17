/**
 * Los dominios cerrados del núcleo — Módulo 2, capa B (reconocimiento).
 *
 * Todos tienen su `check` en la base desde la migración `0014_reconocimiento_persistido.sql`, y el
 * árbitro es el test de catálogo (`DOMINIOS_CERRADOS` en `packages/data/tests/catalogo.test.ts`), que
 * los compara como CONJUNTO contra `pg_constraint`. Hasta 0014 el árbitro era
 * `packages/contabilidad/tests/dominios-pendientes.test.ts`, que ya no los nomina.
 */

/**
 * Las tres clases de `Reconocimiento` (`05-motor-de-reconocimiento.md` §5). Tres, y no dos más un
 * booleano, porque son **tres trabajos distintos** para la persona: en `decision_humana` el motor ya
 * sabe qué es y ella elige una cuenta; en `sin_reconocer` tiene que decir qué es. Un solo estado
 * "pendiente" mezcla los dos y la cola se vuelve inutilizable.
 *
 * 🔴 El discriminante de `Reconocimiento` (`reconocimiento.ts`) se DERIVA de acá — no se repite la
 * lista. Repetirla reintroduce exactamente la divergencia que el test de catálogo existe para cerrar.
 *
 * Idéntica a `reconocimiento_clase_chk`; hay test de catálogo.
 */
export const CLASES_RECONOCIMIENTO = ['propuesta', 'decision_humana', 'sin_reconocer'] as const;
export type ClaseDeReconocimiento = (typeof CLASES_RECONOCIMIENTO)[number];

/**
 * Los tipos de movimiento — `04-imputacion-contable.md` §3 (21 filas) + §3.1 (10 tipos adicionales que
 * las 14 reglas no cubren pero tienen que existir igual, o caen en silencio en una regla equivocada).
 *
 * 🔴 El check de la base lleva LOS 31, no los "habilitados" de `ESTADO_DE_LOS_TIPOS` (`catalogo.ts`):
 * `retiro_de_socio` y `aporte_de_socio` están marcados `sin_evidencia_en_el_roster` —no se alcanzan
 * por literal— y sin embargo `motor.ts:147` los produce por capa C. Un check derivado de los
 * habilitados rechazaría TODA la capa C. El estado de un tipo es una afirmación sobre la evidencia del
 * corpus, no sobre el dominio.
 *
 * Idéntica a `reconocimiento_tipo_chk`; hay test de catálogo.
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
 * Idéntica a `reconocimiento_polaridad_chk`; hay test de catálogo.
 */
export const POLARIDADES = ['normal', 'reversa'] as const;
export type Polaridad = (typeof POLARIDADES)[number];

/** `04-imputacion-contable.md` §2: `lado = columnaOrigen === 'credito' ? 'haber' : 'debe'`. A
 *  diferencia de la polaridad, es un HECHO del documento, no una interpretación.
 *
 *  Idéntica a `reconocimiento_lado_chk`; hay test de catálogo. */
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
 * Idéntica a `reconocimiento_via_chk`; hay test de catálogo.
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
 * Idéntica a `reconocimiento_decide_chk`; hay test de catálogo.
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
 * 🔴 La columna de la base se llama `motivo_codigo`, NO `motivo`: es un CÓDIGO de dominio cerrado, no
 * prosa, y `motivo` a secas es un nombre que el repo ya clasificó N2 (ADR-0002 §C.0.bis, donde este
 * error ya se pagó una vez).
 *
 * `codigo_no_catalogado` y `evidencia_contradictoria` NUNCA se producen hoy: dependen de
 * `conceptoCodigo`, que ningún adaptador del roster emite (H3). El check de 0014 les exige nulidad
 * GRUPAL de la evidencia, que es lo más fuerte que se puede afirmar sin inventar el comportamiento de
 * código que no existe.
 *
 * Idéntica a `reconocimiento_motivo_chk`; hay test de catálogo.
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
