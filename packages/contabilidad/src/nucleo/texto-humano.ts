/**
 * TEXTO HUMANO — traduce el vocabulario cerrado del motor (`TipoMovimiento`, `QueDecide`,
 * `MotivoSinReconocer`, `EstadoResolucion`) a español llano para la contadora. Ratificado por
 * `contador-dominio` (texto contable) y `ux-designer` (formato de columna) en la sesión del export
 * enriquecido, 2026-08-21 — ver `HANDOFF.md`.
 *
 * Puro (R-G/R-J: sin SQL, sin I/O, sin operaciones diferidas). El GATEO por destinatario (qué texto llega a quién)
 * NO vive acá — es responsabilidad de quien arma el export (`packages/ingesta/src/planilla/
 * exportar-planilla.ts`), porque depende de `destinatarioCodigo`, que este módulo no conoce ni debe
 * conocer.
 *
 * 🔴 `pendienteDeLaura` (la hipótesis/pregunta interna del léxico) NUNCA entra a este módulo — dictamen
 * bloqueante de `seguridad-datos-financieros`: es nota de trabajo del equipo, no explicación para quien
 * recibe el archivo. `confirmar_hipotesis_del_lexico` usa siempre el texto genérico de abajo, nunca
 * `entrada.pendienteDeLaura.pregunta`, aunque sea más preciso — la precisión pierde contra la regla.
 */

import type {
  EstadoResolucion,
  MotivoSinReconocer,
  QueDecide,
  TipoMovimiento,
} from './tipos.ts';
import type { Reconocimiento } from './reconocimiento.ts';

/** Clase `sin_reconocer`: no hay `tipo` en absoluto — el motor no pudo ni intentar clasificar. */
export const TEXTO_SIN_TIPO = 'Indeterminado';

/**
 * Tabla de 31 — una por cada valor de `TIPOS_MOVIMIENTO` (`tipos.ts:36-70`). `retiro_de_socio`/
 * `aporte_de_socio` llevan el calificador "(según padrón)" a propósito (contador-dominio): son un
 * match algorítmico contra un dato que el cliente cargó, no un hecho verificado externamente — la
 * etiqueta no puede sonar más segura de lo que la fuente sostiene.
 */
const TEXTO_DE_TIPO: Record<TipoMovimiento, string> = {
  // -- §3, catálogo principal (14 reglas) --
  impuesto_debitos_creditos: 'Impuesto a los débitos y créditos bancarios',
  comision_bancaria: 'Comisión bancaria',
  iva_sobre_gasto_bancario: 'IVA sobre gasto bancario',
  percepcion_impositiva: 'Percepción impositiva',
  interes_de_financiacion: 'Interés de financiación',
  interes_por_descubierto: 'Interés por descubierto',
  retencion_iibb_bancaria: 'Retención de IIBB (bancaria)',
  pago_de_obligacion_fiscal: 'Pago de obligación fiscal',
  pago_de_haberes: 'Pago de haberes',
  deposito_efectivo: 'Depósito en efectivo',
  extraccion_efectivo: 'Extracción de efectivo',
  transferencia_entre_cuentas_propias: 'Transferencia entre cuentas propias',
  acreditacion_tarjeta: 'Acreditación de tarjeta (cobro con tarjeta)',
  pago_a_proveedor_transferencia: 'Pago a proveedor (transferencia)',
  retiro_de_socio: 'Retiro de socio (según padrón)',
  pago_con_cheque_propio: 'Pago con cheque propio',
  cobranza_de_cliente: 'Cobranza de cliente',
  aporte_de_socio: 'Aporte de socio (según padrón)',
  deposito_cheques_terceros: 'Depósito de cheques de terceros',
  cheque_rechazado: 'Cheque rechazado',
  indeterminado: 'Sin tipo asignable',
  // -- §3.1, adicionales --
  pago_tarjeta_corporativa: 'Pago de tarjeta corporativa',
  suscripcion_fci: 'Suscripción de fondo común de inversión (FCI)',
  rescate_fci: 'Rescate de fondo común de inversión (FCI)',
  compra_con_tarjeta_debito: 'Compra con tarjeta de débito',
  debito_automatico_servicio: 'Débito automático de servicio',
  acreditacion_prestamo: 'Acreditación de préstamo',
  cuota_prestamo: 'Cuota de préstamo',
  compra_venta_de_divisas: 'Compra o venta de moneda extranjera',
  movimiento_en_cero: 'Movimiento en cero (sin efecto)',
  reverso_de_movimiento: 'Reverso sin tipo de origen',
};

export function textoDeTipo(tipo: TipoMovimiento): string {
  return TEXTO_DE_TIPO[tipo];
}

/** Los 8 valores de `QUE_DECIDE` (`tipos.ts:122-133`) que NO son `distinguir_tercero_de_socio` —
 *  ese tiene su propia tabla, por estado, más abajo. */
const TEXTO_DE_QUE_DECIDE: Record<Exclude<QueDecide, 'distinguir_tercero_de_socio'>, string> = {
  elegir_cuenta_de_pasivo_del_impuesto:
    'Es un pago a un organismo, pero el movimiento no dice qué obligación cancela. Indicá qué ' +
    'impuesto o cargo es para poder elegir la cuenta de pasivo.',
  confirmar_cuenta_propia_destino:
    'Es una transferencia entre cuentas del mismo cliente, pero no está confirmado a cuál de sus ' +
    'cuentas fue. Confirmá el destino.',
  completar_con_liquidacion_del_adquirente:
    'Es una acreditación de tarjeta. Se contabilizó por el importe que informa el banco, sin poder ' +
    'separar arancel, IVA ni retenciones — falta la liquidación de la tarjeta/adquirente, que hoy el ' +
    'sistema no procesa. Buscala aparte para completar el asiento.',
  confirmar_computo_de_credito_fiscal:
    'Es IVA de un gasto bancario. El concepto está identificado, pero no está evaluado si ' +
    'corresponde computarlo como crédito fiscal — confirmalo vos o con el área impositiva.',
  elegir_jurisdiccion_de_la_retencion:
    'Es una retención de Ingresos Brutos, pero el banco no informa la jurisdicción. Elegila para ' +
    'poder asignar la cuenta — una cuenta que mezcla jurisdicciones no sirve para la declaración de ' +
    'IIBB.',
  completar_con_liquidacion_de_la_tarjeta:
    'Es un pago de tarjeta corporativa. Falta la liquidación de la tarjeta (detalle de consumos) ' +
    'para completar el asiento — hoy el sistema no la procesa. Buscala aparte.',
  confirmar_hipotesis_del_lexico:
    'El sistema tiene una hipótesis sobre qué es este movimiento, pero no hay evidencia suficiente ' +
    'para confirmarla sin arriesgarse a un error. Revisá el detalle y confirmá qué es.',
};

/** `distinguir_tercero_de_socio`, por `EstadoResolucion` — solo los 5 que en la práctica quedan en
 *  `decision_humana` (`es_socio`/`es_tercero_padron_completo` promueven a `propuesta`,
 *  `motor.ts:143-166`, y nunca llegan acá). Ratificado por `contador-dominio` contra
 *  `docs/diseno/11-migracion-0021-determinante-y-capa-c.md:488-494`. */
const TEXTO_DE_ESTADO_CONTRAPARTE: Partial<Record<EstadoResolucion, string>> = {
  sin_candidatos:
    'No hay ningún socio del padrón que coincida con esta contraparte — buscá el comprobante para ' +
    'identificar de quién es. No es un problema del padrón.',
  sin_match_padron_incompleto:
    'El padrón de socios de este cliente no tiene cargado el CUIT/CBU de esta contraparte — ' +
    'completalo y volvé a correr.',
  multiples_socios:
    'Esta contraparte coincide con más de un socio — elegí cuál es, o si corresponde, partí el ' +
    'movimiento entre varios.',
  socio_fuera_de_vigencia:
    'Coincide con un socio, pero fuera del período en que figura vigente — confirmá si la fecha del ' +
    'padrón está mal o si es un movimiento con un ex-socio.',
  pepper_desalineado:
    'No requiere nada contable de tu parte — es un problema técnico interno. Avisale a sistemas, no ' +
    'lo resuelvas vos.',
};

const TEXTO_DISTINGUIR_TERCERO_DE_SOCIO_GENERICO =
  'Es un pago o cobro a una persona o empresa — no está confirmado si es un socio o un tercero. ' +
  'Depende del padrón de socios del cliente; revisalo vos.';

/** Los 7 valores de `MOTIVOS_SIN_RECONOCER` (`tipos.ts:150-158`). */
const TEXTO_DE_MOTIVO_SIN_RECONOCER: Record<MotivoSinReconocer, string> = {
  concepto_no_catalogado:
    'El sistema no reconoce este texto — es un concepto nuevo, no está en el vocabulario cargado. ' +
    'Decinos qué es.',
  concepto_sin_tipo_asignado:
    'El sistema reconoce qué es este movimiento, pero todavía no tiene dónde imputarlo — depende de ' +
    'un documento que no viene en el extracto bancario (por ejemplo, el Libro IVA Compras, o el ' +
    'detalle de un fondo). Mientras tanto, decidí vos la cuenta.',
  ambiguo:
    'El texto coincide con más de un concepto posible y el sistema no elige para no arriesgarse a un ' +
    'error. Decinos cuál de las opciones es.',
  reversa_incoherente:
    'El sistema reconoce el concepto, pero el lado (débito/crédito) no es el esperado para este tipo ' +
    '— puede ser un caso distinto o un error de captura. Revisalo vos.',
  sin_evidencia_de_concepto:
    'El extracto no trae el concepto de este movimiento (el banco no lo publicó, o llegó en papel) — ' +
    'no hay con qué reconocerlo automáticamente. Decinos qué es.',
  codigo_no_catalogado:
    'El banco envió un código de concepto que el sistema no tiene catalogado. Decinos qué es.',
  evidencia_contradictoria:
    'El código y el texto del movimiento sugieren cosas distintas — el sistema no elige entre los ' +
    'dos para no arriesgarse a un error. Revisalo vos.',
};

export function textoDeMotivoSinReconocer(motivo: MotivoSinReconocer): string {
  return TEXTO_DE_MOTIVO_SIN_RECONOCER[motivo];
}

/** `r.clase` tiene que ser `'decision_humana'` — el llamador ya lo sabe por el discriminante. */
export function textoDeQueDecide(
  r: Extract<Reconocimiento, { readonly clase: 'decision_humana' }>,
): string {
  if (r.queDecide !== 'distinguir_tercero_de_socio') {
    return TEXTO_DE_QUE_DECIDE[r.queDecide];
  }
  const estado = r.evidenciaContrapartida?.estado;
  if (estado === undefined) return TEXTO_DISTINGUIR_TERCERO_DE_SOCIO_GENERICO;
  return TEXTO_DE_ESTADO_CONTRAPARTE[estado] ?? TEXTO_DISTINGUIR_TERCERO_DE_SOCIO_GENERICO;
}

/**
 * Los dos `QueDecide` donde `tipo` es un default provisorio, no un hecho confirmado — `contador-
 * dominio` (ajuste 6, HANDOFF 94): `distinguir_tercero_de_socio` NO es "ya sé qué es, falta un dato" —
 * `aplicarContrapartida()` (`motor.ts:134-166`) reescribe `tipo` de `pago_a_proveedor_transferencia`/
 * `cobranza_de_cliente` a `retiro_de_socio`/`aporte_de_socio` cuando se resuelve, y esas son cuentas de
 * naturaleza distinta (pasivo/activo comercial vs. patrimonio neto) — el mismo problema que
 * `confirmar_hipotesis_del_lexico`, no un dato puntual sobre un tipo ya firme. Los otros 6 valores de
 * `QueDecide` fijan `tipo` por regla del catálogo y ningún código lo reescribe después.
 */
const QUE_DECIDE_SIN_IDENTIDAD_CONFIRMADA: ReadonlySet<QueDecide> = new Set([
  'confirmar_hipotesis_del_lexico',
  'distinguir_tercero_de_socio',
]);

/**
 * Las tres columnas del export, ya resueltas — `identificacion` nunca es `null` (un hueco ahí sería
 * indistinguible de un bug, ux-designer); `pendiente` es `null` solo para `propuesta` (ya identificado,
 * nada que decidir salvo tipear la cuenta, deferido a Capa D — ruido repetirlo acá, ux-designer);
 * `confianza` es `null` solo para `sin_reconocer` ("Indeterminado" ya es una respuesta válida en sí
 * misma, no una variante de confianza de otro tipo — `contador-dominio`, ajuste 7).
 *
 * `confianza` reemplaza al calificador `"(sin confirmar)"` que `identificacion` llevaba antes (ajuste
 * 6) — JP encontró que el sufijo rompía el filtro de Excel por "Tipo de movimiento": "Cobranza de
 * cliente" y "Cobranza de cliente (sin confirmar)" quedaban como dos valores de texto DISTINTOS, así
 * que el tip de la leyenda ("filtrá por Tipo de movimiento y asignales la cuenta en bloque") dejaba de
 * cumplirse. Separar confianza de contenido en dos ejes (dos columnas) en vez de fusionarlos en un
 * string es el mismo principio que ya fijó `docs/diseno/15-ocr-liquidaciones-plan.md` (eje 4, líneas
 * ~136-142: "el estado de verificación aritmética no reemplaza esa señal — son cosas distintas") para
 * el OCR de liquidaciones — nunca un solo estado mezclando dos preguntas distintas. (JP citó "09" al
 * pedir este ajuste; el texto real vive en 15 — corregido acá, no se reescribe 09.)
 */
export type TextoDeReconocimiento = {
  readonly identificacion: string;
  readonly confianza: string | null;
  readonly pendiente: string | null;
};

export function textoDeReconocimiento(r: Reconocimiento): TextoDeReconocimiento {
  switch (r.clase) {
    case 'propuesta':
      return { identificacion: textoDeTipo(r.tipo), confianza: 'Alta', pendiente: null };
    case 'decision_humana': {
      const confianza = QUE_DECIDE_SIN_IDENTIDAD_CONFIRMADA.has(r.queDecide) ? 'A confirmar' : 'Alta';
      return { identificacion: textoDeTipo(r.tipo), confianza, pendiente: textoDeQueDecide(r) };
    }
    case 'sin_reconocer':
      return { identificacion: TEXTO_SIN_TIPO, confianza: null, pendiente: textoDeMotivoSinReconocer(r.motivo) };
  }
}
