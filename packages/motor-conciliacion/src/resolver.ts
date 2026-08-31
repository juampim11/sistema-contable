/**
 * Resolver PURO de Capa D (`motor-conciliacion-contable`, Ítem E de Sesión 2b). Sin I/O, sin
 * conexión — recibe todo ya cargado en memoria por el servicio de I/O (que vive en `apps/`, nunca
 * en `packages/data`: ver `packages/data/tests/reglas-de-codigo.test.ts`, este paquete tiene
 * prohibido importar `data`/`ingesta`/`almacenamiento` en espejo de esa misma regla).
 *
 * Diseño cerrado por convocatoria real (`arquitecto-software` + `motor-conciliacion-contable` +
 * `contador-dominio`, sesión interactiva con JP, modo plan) sobre `docs/diseno/
 * 28-diseno-motor-clasificacion.md` (D-26, D-29, D-31). Sin score numérico: la confianza ES la vía
 * (decisión de Capa C, ratificada acá) — la evidencia de cada resultado es la vía + qué regla se
 * aplicó (y con qué especificidad) + la cardinalidad de candidatas, nunca un número inventado.
 *
 * `RolFuncionalCuenta`/`CuentaResolucion`/vocabulario de `motivoCodigo` están DUPLICADOS acá a
 * propósito, no importados del paquete de esquema (prohibido, ver arriba) — mismo patrón que
 * ya usa este repo para `TIPOS_CUENTA`/`TIPOS_CUENTA_ALTA` (`packages/data/tests/catalogo.test.ts`,
 * comentario de `DOMINIOS_CERRADOS`). PENDIENTE, no de esta tarea: un test de sincronía cuando se
 * escriba el servicio de I/O, mismo mecanismo que ya compara pares de dominios cruzando paquetes
 * desde un `.test.ts` (los tests SÍ pueden cruzar el límite que los `src/` no pueden).
 */

import type { Lado, Reconocimiento, TipoMovimiento, ViaEvidencia } from '@sistema-contable/contabilidad';
import type { ConceptoCanonico } from '@sistema-contable/contabilidad';

// -----------------------------------------------------------------------------
// Vocabulario duplicado de `packages/data/src/cierre/tipos.ts` — ver nota de cabecera.
// -----------------------------------------------------------------------------

export const ROLES_FUNCIONALES_CUENTA_MOTOR = [
  'generica',
  'cuenta_particular_socio',
  'aporte_de_socio',
  'retiro_de_socio',
] as const;
export type RolFuncionalCuentaMotor = (typeof ROLES_FUNCIONALES_CUENTA_MOTOR)[number];

/** Familia que D-31 vetea DURO de auto-resolución, sin importar cardinalidad de candidatas. */
const FAMILIA_SOCIO: readonly RolFuncionalCuentaMotor[] = [
  'cuenta_particular_socio',
  'aporte_de_socio',
  'retiro_de_socio',
];

export const CUENTA_RESOLUCIONES_MOTOR = ['fija', 'por_socio', 'por_jurisdiccion', 'por_impuesto'] as const;
export type CuentaResolucionMotor = (typeof CUENTA_RESOLUCIONES_MOTOR)[number];

/**
 * De las 6 `ViaEvidencia` de Capa C, solo estas 4 califican para automático (D-31 §3). Duplicado
 * literal — mismo argumento de sincronía que el resto del vocabulario de este archivo.
 */
const VIAS_QUE_CALIFICAN: readonly ViaEvidencia[] = [
  'codigo_y_texto_concordantes',
  'codigo_concepto',
  'texto_literal_exacto',
  'texto_prefijo_unico',
];

/**
 * Motivos de `pendiente_cierre.motivo_codigo` que este resolver puede producir. Los 5 de D-28 (con
 * el rename de D-33) + los 2 nuevos aprobados por JP (D1/D2 de la ronda de revisión), todavía SIN
 * migrar a `MOTIVOS_PENDIENTE_CIERRE` — el servicio de I/O es quien cierra esa migración antes de
 * poder persistir un `pendiente_cierre` con estos dos valores nuevos.
 */
export const MOTIVOS_QUE_PRODUCE_EL_RESOLVER = [
  'cliente_sin_plan_de_cuentas',
  'tipo_sin_regla_imputacion',
  'cuenta_no_configurada',
  'cuenta_ambigua',
  'resolucion_manual_obligatoria_socio',
  'via_no_calificada',
  'cuenta_bancaria_no_configurada',
] as const;
export type MotivoQueProduceElResolver = (typeof MOTIVOS_QUE_PRODUCE_EL_RESOLVER)[number];

// -----------------------------------------------------------------------------
// Entrada — todo ya resuelto en memoria por el caller (D-26: el JOIN vive en el servicio de I/O).
// -----------------------------------------------------------------------------

export type MovimientoParaResolver = Readonly<{
  movimientoId: string;
  clienteId: string;
  /** ISO `YYYY-MM-DD` — gobierna qué regla/atributo de cuenta está vigente. */
  fecha: string;
  /** Numeric-as-string (CLAUDE.md §2) — nunca `number` de JS. No negativo: el signo lo da `lado`. */
  importe: string;
  cuentaBancariaId: string;
}>;

/** Pata "banco" de D-29 — mapeo fijo 1:1, sin vigencia. El caller ya hizo el `SELECT` de una fila. */
export type CuentaBancariaResuelta = Readonly<{
  cuentaBancariaId: string;
  /** `null` ⟺ `cuenta_bancaria.cuenta_id` sin configurar (D2 — `cuenta_bancaria_no_configurada`). */
  cuentaId: string | null;
}>;

/** Fila cruda de `regla_imputacion` (`0030`). El resolver filtra vigencia/overlay él mismo. */
export type ReglaImputacion = Readonly<{
  id: string;
  tipoMovimiento: TipoMovimiento;
  /** `null` = regla general para todo el `tipoMovimiento`. */
  concepto: ConceptoCanonico | null;
  cuentaResolucion: CuentaResolucionMotor;
  /** Poblado solo si `cuentaResolucion === 'fija'`. */
  cuentaId: string | null;
  vigenteDesde: string;
  vigenteHasta: string | null;
}>;

/** Snapshot histórico de `cuenta_atributo` — para `CuentaRef` y para el veto de `rolFuncional`. */
export type CuentaDelPlan = Readonly<{
  cuentaId: string;
  codigo: string;
  denominacion: string;
  rolFuncional: RolFuncionalCuentaMotor;
  activa: boolean;
  vigenteDesde: string;
  vigenteHasta: string | null;
}>;

export type EntradaResolver = Readonly<{
  reconocimiento: Reconocimiento;
  movimiento: MovimientoParaResolver;
  cuentaBancaria: CuentaBancariaResuelta;
  /** TODAS las reglas del cliente — el resolver filtra, nunca confía en un pre-filtro del caller. */
  reglasImputacion: readonly ReglaImputacion[];
  /** TODOS los atributos históricos del cliente — ídem. */
  planDeCuentas: readonly CuentaDelPlan[];
}>;

// -----------------------------------------------------------------------------
// Salida
// -----------------------------------------------------------------------------

/** Cita congelada del plan de cuentas — mismo patrón que `cuenta_ref` (D-15), nunca recalculada. */
export type CuentaRefMotor = Readonly<{
  codigo: string;
  denominacion: string;
  rolFuncional: RolFuncionalCuentaMotor;
}>;

export type RenglonPropuesto = Readonly<{
  cuentaId: string;
  cuentaRef: CuentaRefMotor;
  lado: Lado;
  importe: string;
}>;

export type EvidenciaResolucion = Readonly<{
  via: ViaEvidencia;
  reglaContrapartidaAplicada?: Readonly<{ reglaId: string; especificidad: 'concepto_exacto' | 'concepto_general' }>;
  /** La regla general que el overlay tapó, cuando existían las dos a la vez — auditoría del overlay. */
  reglaContrapartidaDescartada?: Readonly<{ reglaId: string }>;
  /** Solo poblado en el caso defensivo de ambigüedad real (>1 candidata en la misma especificidad). */
  candidatosContrapartida?: readonly Readonly<{ reglaId: string; cuentaId: string | null }>[];
  cuentaBancariaAplicada?: Readonly<{ cuentaId: string }>;
  /** Cuando falló la pata banco Y la contrapartida también fallaba — para que el contador vea el
   *  cuadro completo en una sola pasada, aunque el `motivoCodigo` reporte solo la de mayor prioridad
   *  (banco primero, decisión de `contador-dominio`: precondición estructural + mayor radio de
   *  impacto que una regla de imputación puntual). */
  contrapartidaTambienFallaba?: boolean;
}>;

export type ResultadoResolver =
  | Readonly<{
      tipo: 'automatico';
      renglones: readonly [RenglonPropuesto, RenglonPropuesto];
      evidencia: EvidenciaResolucion;
    }>
  | Readonly<{
      tipo: 'pendiente';
      motivoCodigo: MotivoQueProduceElResolver;
      evidencia: EvidenciaResolucion;
    }>;

// -----------------------------------------------------------------------------
// Resolución de la pata "contrapartida" — overlay de especificidad (contador-dominio: concepto
// exacto gana sobre concepto general, ejes ortogonales a la vigencia).
// -----------------------------------------------------------------------------

type ReglaGanadora =
  | Readonly<{ estado: 'ninguna' }>
  | Readonly<{ estado: 'ambigua'; candidatos: readonly ReglaImputacion[] }>
  | Readonly<{ estado: 'ganadora'; regla: ReglaImputacion; especificidad: 'concepto_exacto' | 'concepto_general'; descartada: ReglaImputacion | null }>;

function vigenteA(regla: Pick<ReglaImputacion, 'vigenteDesde' | 'vigenteHasta'>, fecha: string): boolean {
  return regla.vigenteDesde <= fecha && (regla.vigenteHasta === null || regla.vigenteHasta > fecha);
}

function reglaGanadora(
  reglas: readonly ReglaImputacion[],
  tipoMovimiento: TipoMovimiento,
  concepto: ConceptoCanonico,
  fecha: string,
): ReglaGanadora {
  const vigentes = reglas.filter((r) => r.tipoMovimiento === tipoMovimiento && vigenteA(r, fecha));

  const especificas = vigentes.filter((r) => r.concepto === concepto);
  if (especificas.length > 1) return { estado: 'ambigua', candidatos: especificas };
  if (especificas.length === 1) {
    const generales = vigentes.filter((r) => r.concepto === null);
    return {
      estado: 'ganadora',
      regla: especificas[0] as ReglaImputacion,
      especificidad: 'concepto_exacto',
      descartada: generales[0] ?? null,
    };
  }

  const generales = vigentes.filter((r) => r.concepto === null);
  if (generales.length > 1) return { estado: 'ambigua', candidatos: generales };
  if (generales.length === 1) {
    return { estado: 'ganadora', regla: generales[0] as ReglaImputacion, especificidad: 'concepto_general', descartada: null };
  }

  return { estado: 'ninguna' };
}

function cuentaVigente(plan: readonly CuentaDelPlan[], cuentaId: string, fecha: string): CuentaDelPlan | null {
  return plan.find((c) => c.cuentaId === cuentaId && c.activa && vigenteA(c, fecha)) ?? null;
}

function aCuentaRef(c: CuentaDelPlan): CuentaRefMotor {
  return { codigo: c.codigo, denominacion: c.denominacion, rolFuncional: c.rolFuncional };
}

function estaVetadaPorFamiliaSocio(c: CuentaDelPlan): boolean {
  return FAMILIA_SOCIO.includes(c.rolFuncional);
}

// -----------------------------------------------------------------------------
// Resolver principal
// -----------------------------------------------------------------------------

export function resolverAsiento(entrada: EntradaResolver): ResultadoResolver {
  const { reconocimiento, movimiento, cuentaBancaria, reglasImputacion, planDeCuentas } = entrada;

  // Fuera de alcance de esta versión (D-28, bloqueado): `decision_humana`/`sin_reconocer` nunca
  // producen efecto acá — caen a `pendiente` trivialmente por la primera cláusula de D-31, con el
  // motivo genérico más cercano hasta que la próxima convocatoria cierre el vocabulario exacto.
  if (reconocimiento.clase !== 'propuesta') {
    return {
      tipo: 'pendiente',
      motivoCodigo: 'tipo_sin_regla_imputacion',
      evidencia: { via: reconocimiento.evidencia?.via ?? 'texto_prefijo_con_cola' },
    };
  }

  if (planDeCuentas.length === 0) {
    return { tipo: 'pendiente', motivoCodigo: 'cliente_sin_plan_de_cuentas', evidencia: { via: reconocimiento.via } };
  }

  // ---- Pata "contrapartida" primero (para saber si TAMBIÉN falla, aunque el reporte final
  // priorice banco — contador-dominio, ronda de revisión). ----
  const ganadora = reglaGanadora(reglasImputacion, reconocimiento.tipo, reconocimiento.concepto, movimiento.fecha);

  let contrapartidaResuelta:
    | Readonly<{ cuenta: CuentaDelPlan; evidenciaParcial: EvidenciaResolucion }>
    | null = null;
  let motivoSiContrapartidaFalla: MotivoQueProduceElResolver | null = null;
  let evidenciaContrapartidaFallo: EvidenciaResolucion = { via: reconocimiento.via };

  if (ganadora.estado === 'ambigua') {
    motivoSiContrapartidaFalla = 'cuenta_ambigua';
    evidenciaContrapartidaFallo = {
      via: reconocimiento.via,
      candidatosContrapartida: ganadora.candidatos.map((r) => ({ reglaId: r.id, cuentaId: r.cuentaId })),
    };
  } else if (ganadora.estado === 'ninguna') {
    motivoSiContrapartidaFalla = 'tipo_sin_regla_imputacion';
  } else {
    const regla = ganadora.regla;
    const evidenciaRegla: EvidenciaResolucion = {
      via: reconocimiento.via,
      reglaContrapartidaAplicada: { reglaId: regla.id, especificidad: ganadora.especificidad },
      ...(ganadora.descartada ? { reglaContrapartidaDescartada: { reglaId: ganadora.descartada.id } } : {}),
    };

    if (regla.cuentaResolucion === 'por_socio') {
      // D-31 vetea DURO esta familia, sin importar candidatas — no se calcula socioId ni se
      // cuentan candidatos, consecuencia lógica ya validada (D3 de la ronda de revisión).
      return { tipo: 'pendiente', motivoCodigo: 'resolucion_manual_obligatoria_socio', evidencia: evidenciaRegla };
    }

    if (regla.cuentaResolucion === 'por_jurisdiccion' || regla.cuentaResolucion === 'por_impuesto') {
      // Sin mecanismo de resolución (D-29, bloqueado) — cuenta como "regla no utilizable", NO como
      // candidata resuelta (motor-conciliacion-contable, ronda de revisión).
      motivoSiContrapartidaFalla = 'tipo_sin_regla_imputacion';
    } else {
      // 'fija'
      const cuenta = regla.cuentaId ? cuentaVigente(planDeCuentas, regla.cuentaId, movimiento.fecha) : null;
      if (!cuenta) {
        motivoSiContrapartidaFalla = 'cuenta_no_configurada';
        evidenciaContrapartidaFallo = evidenciaRegla;
      } else if (estaVetadaPorFamiliaSocio(cuenta)) {
        // Defensivo: una regla 'fija' no debería apuntar nunca a una cuenta ligada a un socio, pero
        // si pasara (error de carga), el veto de D-31 igual aplica — evaluado antes que la vía.
        return { tipo: 'pendiente', motivoCodigo: 'resolucion_manual_obligatoria_socio', evidencia: evidenciaRegla };
      } else {
        contrapartidaResuelta = { cuenta, evidenciaParcial: evidenciaRegla };
      }
    }
  }

  // ---- Pata "banco" ----
  const bancoResuelto = cuentaBancaria.cuentaId ? cuentaVigente(planDeCuentas, cuentaBancaria.cuentaId, movimiento.fecha) : null;

  // ---- Prioridad de reporte: banco primero si fallan las dos (contador-dominio, ronda de revisión) ----
  if (!bancoResuelto) {
    const contrapartidaTambienFallaba = contrapartidaResuelta === null;
    return {
      tipo: 'pendiente',
      motivoCodigo: 'cuenta_bancaria_no_configurada',
      evidencia: {
        via: reconocimiento.via,
        ...(contrapartidaTambienFallaba ? { contrapartidaTambienFallaba: true } : {}),
      },
    };
  }

  if (!contrapartidaResuelta) {
    return {
      tipo: 'pendiente',
      motivoCodigo: motivoSiContrapartidaFalla ?? 'tipo_sin_regla_imputacion',
      evidencia: evidenciaContrapartidaFallo,
    };
  }

  // ---- Veto de familia socio sobre la cuenta de banco (defensivo, evaluado antes que la vía —
  // motor-conciliacion-contable, ronda de revisión: si el veto aplica, la vía es irrelevante). ----
  if (estaVetadaPorFamiliaSocio(bancoResuelto)) {
    return {
      tipo: 'pendiente',
      motivoCodigo: 'resolucion_manual_obligatoria_socio',
      evidencia: contrapartidaResuelta.evidenciaParcial,
    };
  }

  // ---- Calificación de vía (D-31) ----
  if (!VIAS_QUE_CALIFICAN.includes(reconocimiento.via)) {
    return { tipo: 'pendiente', motivoCodigo: 'via_no_calificada', evidencia: contrapartidaResuelta.evidenciaParcial };
  }

  // ---- Automático ----
  // `reconocimiento.lado` es el lado del RENGLÓN IMPUTADO (la contrapartida) — `04-imputacion-
  // contable.md` §2: "lado = columnaOrigen === 'credito' ? 'haber' : 'debe' para todo renglón
  // IMPUTADO" (ejemplo regla 8: columna crédito, Caja —la contrapartida, que disminuye— va al
  // haber; Banco —que aumenta— va al debe, el lado OPUESTO). Banco nunca es la contrapartida
  // imputada: su lado sale de invertir el de la contrapartida, nunca al revés.
  const ladoContrapartida = reconocimiento.lado;
  const ladoBanco: Lado = ladoContrapartida === 'debe' ? 'haber' : 'debe';

  return {
    tipo: 'automatico',
    renglones: [
      { cuentaId: bancoResuelto.cuentaId, cuentaRef: aCuentaRef(bancoResuelto), lado: ladoBanco, importe: movimiento.importe },
      {
        cuentaId: contrapartidaResuelta.cuenta.cuentaId,
        cuentaRef: aCuentaRef(contrapartidaResuelta.cuenta),
        lado: ladoContrapartida,
        importe: movimiento.importe,
      },
    ],
    evidencia: {
      ...contrapartidaResuelta.evidenciaParcial,
      cuentaBancariaAplicada: { cuentaId: bancoResuelto.cuentaId },
    },
  };
}
