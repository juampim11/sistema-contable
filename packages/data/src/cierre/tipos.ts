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

/** Vocabulario cerrado de `pendiente_cierre.motivo_codigo` — distinto de `QueDecide` (Capa B/C). */
export const MOTIVOS_PENDIENTE_CIERRE = ['documento_faltante', 'cotizacion_no_disponible'] as const;
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
