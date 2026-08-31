/**
 * Tipos de fila para las once tablas de Capa D del cierre mensual (`0027_cierre_mensual.sql`).
 *
 * Solo tipos — nada de lectura/escritura acá. El motor que arma asientos (Capa D en sí) es tarea
 * aparte; esta migración es exclusivamente esquema (`docs/diseno/26-migracion-cierre-mensual.md`).
 *
 * Los `as const` de acá abajo son la constante de TypeScript que `packages/data/tests/catalogo.test.ts`
 * exige para todo `CHECK` con forma de dominio cerrado (`DOMINIOS_CERRADOS`) — mismo patrón que
 * `ACCIONES`/`QUE_DECIDE`. Los tipos se DERIVAN de la constante, nunca se escriben a mano dos veces.
 */

export const TIPOS_DOCUMENTO_CIERRE = [
  'extracto',
  'fci',
  'liquidacion_tarjeta',
  'libro_iva_compras',
  'libro_iva_ventas',
] as const;
export type TipoDocumentoCierre = (typeof TIPOS_DOCUMENTO_CIERRE)[number];

export const COBERTURAS_DOCUMENTO = ['completo', 'parcial', 'corte_a_fecha'] as const;
export type CoberturaDocumento = (typeof COBERTURAS_DOCUMENTO)[number];

export const TIPOS_PERIODO = ['mensual', 'ejercicio'] as const;
export type TipoPeriodo = (typeof TIPOS_PERIODO)[number];

export const CIERRE_ESTADOS = [
  'abierto',
  'en_ingesta',
  'en_consolidacion',
  'en_revision',
  'confirmado',
  'anulado',
] as const;
export type CierreEstado = (typeof CIERRE_ESTADOS)[number];

export const HECHO_VIA = ['manual', 'automatico'] as const;
export type HechoVia = (typeof HECHO_VIA)[number];

export const PERIODICIDADES_EXPECTATIVA = ['mensual', 'anual', 'eventual'] as const;
export type PeriodicidadExpectativa = (typeof PERIODICIDADES_EXPECTATIVA)[number];

export const ORIGENES_EXPECTATIVA = [
  'declarado',
  'inferido_de_movimiento',
  'inferido_de_historico',
] as const;
export type OrigenExpectativa = (typeof ORIGENES_EXPECTATIVA)[number];

/**
 * Vocabulario cerrado de `pendiente_cierre.motivo_codigo` — distinto de `QueDecide` (Capa B/C).
 *
 * Los 5 valores de Capa D (D-28, cerrado por `contador-dominio` + `analista-funcional`, sesión
 * nocturna autónoma 2026-08-31, `docs/diseno/28-diseno-motor-clasificacion.md` §6) se agregan a los
 * 2 originales de `0027`. Distinción deliberada entre los dos primeros — remediación distinta:
 * `tipo_sin_regla_imputacion` = nadie cargó (o dejó vencer) la regla → hay que CREARLA/renovarla;
 * `cuenta_no_configurada` = la regla existe y está vigente, pero la cuenta a la que apunta no es
 * válida/vigente en el plan a esa fecha (dada de baja, reclasificada) → hay que CORREGIR la regla.
 * `resolucion_manual_obligatoria_socio` cubre el caso `N=1` que D-31 (`28`§3) veta duro de
 * auto-resolución (familia `retiro_de_socio`/`aporte_de_socio`/`cuenta_particular_socio`): no es un
 * dato faltante ni ambiguo, es un control de diseño deliberado — confundirlo con `cuenta_ambigua`
 * mentiría sobre la causa. Renombrado en `0033` (originalmente `movimiento_de_socio`, 0031): ese
 * nombre describía una CATEGORÍA de movimiento, no una CAUSA de fallo como los otros 4 — sin el
 * contexto de D-31, alguien en la cola de revisión lo leería como "falta configurar algo" e
 * intentaría arreglarlo, cuando esto nunca va a auto-resolver, por diseño (contador-dominio).
 *
 * `via_no_calificada` (`0034`) y `cuenta_bancaria_no_configurada` (`0034`) se agregaron al escribir
 * el resolver real (Ítem E, paso 1, `packages/motor-conciliacion`): de las 6 `ViaEvidencia`, solo 4
 * califican para automático (D-31 §3) — `via_no_calificada` es cuando la cuenta resuelve perfecto
 * pero la vía no alcanza, distinto de `resolucion_manual_obligatoria_socio` (ese veto es permanente,
 * este puede resolverse solo si mejora la evidencia de Capa C sobre ese movimiento).
 * `cuenta_bancaria_no_configurada` es la pata "banco" de D-29 sin mapear — motivo propio y no
 * `cuenta_no_configurada` (que es de la pata contrapartida): son dos tareas de remediación distintas.
 *
 * Bloqueado, sin resolver todavía (documentado en HANDOFF, no inventado): cómo se enrutan
 * movimientos con `reconocimiento_movimiento.clase ∈ {sin_reconocer, decision_humana}`, y la
 * prioridad de reporte si fallan las dos patas de D-29 a la vez es contrapartida-vs-banco resuelta
 * (banco primero, `contador-dominio` + JP) pero **no** codificada como un octavo motivo — el
 * `motivo_codigo` reporta la de mayor prioridad, la `evidencia` de `pendiente_cierre` consigna si la
 * otra pata también fallaba.
 */
export const MOTIVOS_PENDIENTE_CIERRE = [
  'documento_faltante',
  'cotizacion_no_disponible',
  'cliente_sin_plan_de_cuentas',
  'tipo_sin_regla_imputacion',
  'cuenta_no_configurada',
  'cuenta_ambigua',
  'resolucion_manual_obligatoria_socio',
  'via_no_calificada',
  'cuenta_bancaria_no_configurada',
] as const;
export type MotivoPendienteCierre = (typeof MOTIVOS_PENDIENTE_CIERRE)[number];

export const PENDIENTE_ESTADOS = ['abierto', 'resuelto', 'superseded', 'dispensado'] as const;
export type PendienteEstado = (typeof PENDIENTE_ESTADOS)[number];

export const TIPOS_ASIENTO_PROPUESTO = [
  'devengamiento',
  'cancelacion',
  'ajuste_cierre',
  'reimputacion',
] as const;
export type TipoAsientoPropuesto = (typeof TIPOS_ASIENTO_PROPUESTO)[number];

export const ASIENTO_ESTADOS = ['propuesto', 'confirmado', 'superseded'] as const;
export type AsientoEstado = (typeof ASIENTO_ESTADOS)[number];

/** Catálogo PROVISIONAL — `contador-dominio` cierra la lista completa antes de que Capa D la use. */
export const ROLES_FUNCIONALES_CUENTA = [
  'generica',
  'cuenta_particular_socio',
  'aporte_de_socio',
  'retiro_de_socio',
] as const;
export type RolFuncionalCuenta = (typeof ROLES_FUNCIONALES_CUENTA)[number];

/**
 * `regla_imputacion.cuenta_resolucion` (D-29, `04-imputacion-contable.md` §8 punto 3: "la cuenta no
 * siempre es una constante"). Solo `'fija'` y `'por_socio'` tienen columnas de resolución hoy
 * (`cuenta_id` / `rol_funcional_objetivo`) — `'por_jurisdiccion'`/`'por_impuesto'` quedan declaradas
 * en el dominio para no reabrir el `CHECK` cuando se diseñen, pero BLOQUEADAS sin mecanismo de
 * resolución: `04`§7 ya dice "no tengo esa fuente cargada" para jurisdicción sin publicar, y
 * `QUE_DECIDE.elegir_cuenta_de_pasivo_del_impuesto`/`elegir_jurisdiccion_de_la_retencion` confirman
 * que ambos caminos son manuales hoy. Necesitan su propia convocatoria antes de ser accionables.
 */
export const CUENTA_RESOLUCIONES = [
  'fija',
  'por_socio',
  'por_jurisdiccion',
  'por_impuesto',
] as const;
export type CuentaResolucion = (typeof CUENTA_RESOLUCIONES)[number];

export type Cuenta = {
  readonly id: string;
  readonly clienteId: string;
  readonly creadaEn: string;
};

export type CuentaAtributo = {
  readonly id: string;
  readonly clienteId: string;
  readonly cuentaId: string;
  readonly codigo: string;
  readonly denominacion: string;
  readonly nivel: number;
  readonly cuentaPadreId: string | null;
  readonly rolFuncional: RolFuncionalCuenta;
  /** NOT NULL ⟺ `rolFuncional` liga a un socio puntual (D-25). */
  readonly padronSocioId: string | null;
  readonly activa: boolean;
  readonly vigenteDesde: string;
  readonly vigenteHasta: string | null;
  readonly respaldo: string;
  readonly creadaEn: string;
};

export type DocumentoIngerido = {
  readonly id: string;
  readonly clienteId: string;
  readonly tipoDocumento: TipoDocumentoCierre;
  readonly bancoCodigo: string | null;
  readonly periodoDesde: string;
  readonly periodoHasta: string;
  readonly cobertura: CoberturaDocumento;
  readonly objetoAlmacenamiento: string;
  readonly ingeridoEn: string;
  readonly supersededById: string | null;
  readonly creadoEn: string;
};

export type CierreClientePeriodo = {
  readonly id: string;
  readonly clienteId: string;
  readonly tipoPeriodo: TipoPeriodo;
  readonly periodoDesde: string;
  readonly periodoHasta: string;
  readonly cierreEstado: CierreEstado;
  readonly cierreAnteriorId: string | null;
  readonly confirmadoEn: string | null;
  /** Rastro, no compuerta — identidad declarada ≠ autenticada (D-5/D-21). */
  readonly confirmadoPor: string | null;
  readonly creadoEn: string;
};

export type CierreTransicion = {
  readonly id: string;
  readonly clienteId: string;
  readonly cierreId: string;
  readonly estadoDesde: CierreEstado;
  readonly estadoHasta: CierreEstado;
  readonly motivo: string;
  readonly hechoVia: HechoVia;
  /** NUNCA null, ni para transiciones automáticas — se atribuye a la persona cuya acción disparó la transición. */
  readonly hechoPor: string;
  readonly ocurridoEn: string;
};

export type ExpectativaFuenteCliente = {
  readonly id: string;
  readonly clienteId: string;
  readonly tipoDocumento: TipoDocumentoCierre;
  readonly bancoCodigo: string | null;
  readonly cuentaBancariaId: string | null;
  readonly periodicidad: PeriodicidadExpectativa;
  readonly origen: OrigenExpectativa;
  readonly evidencia: Readonly<Record<string, unknown>> | null;
  /** Default `true` (D-14): el silencio en las filas de confianza alta es la aprobación (D-5d). */
  readonly confirmada: boolean;
  readonly vigenciaDesde: string;
  readonly vigenciaHasta: string | null;
  readonly supersededById: string | null;
  readonly creadoEn: string;
};

export type FuenteCierre = {
  readonly id: string;
  readonly clienteId: string;
  readonly cierreId: string;
  readonly documentoIngeridoId: string;
  /** null = llegó algo que nadie esperaba — caso legítimo, no error. */
  readonly expectativaId: string | null;
  readonly cuentaBancariaId: string | null;
  readonly estadoCuadratura: Readonly<Record<string, unknown>>;
  readonly supersededById: string | null;
  readonly creadoEn: string;
};

/**
 * D-30. Por qué Capa D no pudo resolver la cuenta — códigos y referencias por id, NUNCA texto libre
 * ni un valor real del movimiento (mismo criterio de allowlist que `VerificacionHeredada`). Espeja
 * `EvidenciaResolucion` de `packages/motor-conciliacion/src/resolver.ts` — `data` no puede importar
 * ese paquete (regla espejo, `reglas-de-codigo.test.ts`), así que este tipo está DUPLICADO a
 * propósito; el servicio de I/O (`apps/`) es quien tiene ambos paquetes a la vista y mapea uno a
 * otro campo por campo al escribir la fila.
 */
export type EvidenciaPendienteCierre = Readonly<{
  via?: string;
  reglaContrapartidaAplicada?: Readonly<{ reglaId: string; especificidad: 'concepto_exacto' | 'concepto_general' }>;
  reglaContrapartidaDescartada?: Readonly<{ reglaId: string }>;
  candidatosContrapartida?: readonly Readonly<{ reglaId: string; cuentaId: string | null }>[];
  cuentaBancariaAplicada?: Readonly<{ cuentaId: string }>;
  contrapartidaTambienFallaba?: boolean;
}>;

export type PendienteCierre = {
  readonly id: string;
  readonly clienteId: string;
  readonly cierreId: string;
  readonly fuenteCierreId: string | null;
  /** Requerido cuando `motivoCodigo === 'documento_faltante'` — es lo que el gate de D-24 evalúa. */
  readonly expectativaId: string | null;
  readonly referenciaOrigen: string | null;
  readonly motivoCodigo: MotivoPendienteCierre;
  readonly pendienteEstado: PendienteEstado;
  readonly resueltoPor: string | null;
  readonly resueltoEn: string | null;
  readonly resolucionId: string | null;
  readonly supersededById: string | null;
  /** D-30 (`0031`), nullable: los 2 motivos originales de `0027` no la necesitan. */
  readonly evidencia: EvidenciaPendienteCierre | null;
  readonly creadoEn: string;
};

export type PendienteDispensa = {
  readonly id: string;
  readonly clienteId: string;
  readonly pendienteCierreId: string;
  readonly motivo: string;
  readonly dispensadoPor: string;
  readonly dispensadoEn: string;
};

export type AsientoPropuesto = {
  readonly id: string;
  readonly clienteId: string;
  readonly cierreId: string;
  readonly tipo: TipoAsientoPropuesto;
  readonly fechaImputacion: string;
  readonly asientoEstado: AsientoEstado;
  readonly supersededById: string | null;
  readonly creadoEn: string;
};

/** Fila de la vista `asiento_propuesto_totales` — nunca una tabla física (ver comentario de la migración). */
export type AsientoPropuestoTotales = {
  readonly clienteId: string;
  readonly asientoId: string;
  readonly totalDebe: string;
  readonly totalHaber: string;
};

export type EstadoVerificacionHeredada = 'exacta' | 'aproximada' | 'no_verificable';

/** Allowlist de claves exigida por el CHECK de la migración — Zod debe espejarla en el límite de escritura (D-20). */
export type VerificacionHeredada = Readonly<{
  estado?: EstadoVerificacionHeredada;
  referenciaDocumentoId?: string;
  referenciaLinea?: number;
  motivo?: string;
  aproximada?: boolean;
  fechaReferencia?: string;
}>;

export type CuentaRef = Readonly<{
  codigo: string;
  denominacion: string;
  rolFuncional: RolFuncionalCuenta;
}>;

export type AsientoPropuestoRenglon = {
  readonly id: string;
  readonly clienteId: string;
  readonly asientoId: string;
  readonly orden: number;
  readonly cuentaId: string;
  /** Cita congelada del plan de cuentas vigente a `fechaImputacion` — el asiento cita, no recalcula (D-15). */
  readonly cuentaRef: CuentaRef;
  readonly debe: string;
  readonly haber: string;
  readonly fechaImputacion: string;
  readonly fuenteCierreId: string | null;
  readonly referenciaOrigen: string | null;
  readonly verificacionHeredada: VerificacionHeredada;
  readonly padronManifestacionId: string | null;
  readonly valuacionRef: Readonly<Record<string, unknown>> | null;
  readonly creadoEn: string;
};

/**
 * Fila de `regla_imputacion` (`0030`, D-29 pata "contrapartida"). `tipoMovimiento`/`concepto` van
 * como `string`, no como `TipoMovimiento`/`ConceptoCanonico` de `contabilidad` — `data` tiene
 * prohibido importar ese paquete (regla espejo de `reglas-de-codigo.test.ts`); el `CHECK` de la base
 * es la validación real de esos dos dominios, no este tipo. Quien necesite el tipo estrecho
 * (`packages/motor-conciliacion`) lo tipa contra su propia copia, en el servicio de I/O de `apps/`.
 */
export type ReglaImputacion = Readonly<{
  id: string;
  clienteId: string;
  tipoMovimiento: string;
  concepto: string | null;
  cuentaResolucion: CuentaResolucion;
  cuentaId: string | null;
  rolFuncionalObjetivo: RolFuncionalCuenta | null;
  vigenteDesde: string;
  vigenteHasta: string | null;
  respaldo: string;
  decididoPor: string;
  creadaEn: string;
}>;
