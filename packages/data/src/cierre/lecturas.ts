/**
 * LECTURAS para el servicio de I/O de `motor-conciliacion-contable` (Ítem E, paso 2). Sin
 * `ContextoAuditado` — mismo criterio que `leerReconocimientosActivos`
 * (`packages/data/src/contabilidad/lecturas.ts`): se consultan en cada pasada del motor, auditar
 * cada una sería el ruido que ADR-0002 H-8 existe para evitar.
 *
 * `data` no puede importar `contabilidad` ni `motor-conciliacion` (regla + regla espejo,
 * `packages/data/tests/reglas-de-codigo.test.ts`) — estas lecturas devuelven tipos PROPIOS,
 * `string` donde el dominio real es de otro paquete (`tipoMovimiento`/`concepto`/`clase`/`via`). El
 * servicio de I/O real (`apps/`) es quien tiene los dos paquetes a la vista y adapta.
 */

import type { Tx } from '../db/conexion.ts';
import type {
  ConfirmacionGrupo,
  CuentaRef,
  CuentaResolucion,
  ReglaImputacion,
  RolFuncionalCuenta,
  TipoAsientoPropuesto,
} from './tipos.ts';

// -----------------------------------------------------------------------------
// leerReconocimientosParaImputar — D-26 (el JOIN) + filtro de alcance de D-28 (solo `propuesta`)
// -----------------------------------------------------------------------------

export type FilaReconocimientoParaImputar = {
  readonly reconocimientoId: string;
  readonly movimientoId: string;
  readonly clase: string;
  readonly tipo: string;
  readonly concepto: string;
  readonly polaridad: string;
  readonly lado: string;
  readonly via: string;
  /** Los tres campos reales de `EvidenciaDelMatch` (`contabilidad`) — se traen para poder
   *  reconstruir un `Reconocimiento` FIEL al que persistió el motor real, nunca uno inventado. Es
   *  lo que le permite al servicio de I/O (`apps/`) estar en la allowlist de R-F: no arma una
   *  clasificación nueva, reconstruye la que YA se decidió y persistió. */
  readonly evidenciaEntradaLexicoId: string;
  readonly evidenciaCaracteresMatcheados: number;
  readonly evidenciaHuboCola: boolean;
  /** ISO `YYYY-MM-DD` — de `movimiento_bancario_crudo.fecha` (D-26, no viaja en `Reconocimiento`). */
  readonly fecha: string;
  /** Numeric-as-string, siempre no negativo (CLAUDE.md §2). */
  readonly importe: string;
  readonly cuentaBancariaId: string;
};

export type ResultadoReconocimientosParaImputar = {
  readonly filas: readonly FilaReconocimientoParaImputar[];
  /** Movimientos que YA tenían un `asiento_propuesto_renglon` o un `pendiente_cierre` terminal
   *  (`pendiente_estado <> 'abierto'`) citándolos — excluidos del `WHERE`, nunca del conteo. Sin
   *  este número, un reproceso de un lote ya conciliado antes reporta un `totalMovimientos` más
   *  chico sin que quede dicho por qué (hallazgo de la convocatoria del fix de idempotencia,
   *  2026-09-09: `seguridad-datos-financieros` + `motor-conciliacion-contable`). */
  readonly yaImputadosExcluidos: number;
};

/**
 * Lockea (`FOR UPDATE`) todas las filas de `movimiento_bancario_crudo` del lote — tiene que correr
 * ANTES de `leerReconocimientosParaImputar`, en la MISMA transacción. Sin esto, dos corridas
 * concurrentes de `conciliar:lote --aplicar` sobre el mismo lote pueden, cada una, leer "todavía sin
 * imputar" bajo READ COMMITTED (ninguna ve los INSERT no comprometidos de la otra) y duplicar el
 * asiento igual — el `NOT EXISTS` de abajo cierra el reproceso en SERIE, esto cierra el reproceso en
 * PARALELO. Hallazgo real de la convocatoria del fix de idempotencia (2026-09-09), `dba-data` +
 * `security-engineer` de forma independiente. No hace falta un índice nuevo: el lock es sobre la
 * PK/scan ya cubierto por `idx_mov_crudo_lote`.
 */
export async function lockearMovimientosDelLote(
  tx: Tx,
  args: { readonly clienteId: string; readonly loteIngestaId: string },
): Promise<number> {
  const filas = await tx.consultar<{ id: string }>(
    `select id::text as id
       from movimiento_bancario_crudo
      where cliente_id = $1 and lote_ingesta_id = $2
      order by fila_numero
        for update`,
    [args.clienteId, args.loteIngestaId],
  );
  return filas.length;
}

/**
 * Solo `clase = 'propuesta'` — `decision_humana`/`sin_reconocer` quedan fuera de alcance de esta
 * versión del motor (D-28, bloqueado: no está resuelto qué `motivo_codigo` les corresponde). Filtrar
 * acá, no en el resolver, evita construir un `pendiente_cierre` con un motivo inventado para una
 * clase que ningún documento cerró todavía.
 *
 * Solo reconocimientos VIGENTES (`superseded_por is null`) — mismo criterio que
 * `leerReconocimientosActivos`.
 *
 * **Excluye lo ya imputado** (fix de idempotencia, 2026-09-09 — hallazgo real: re-correr
 * `conciliar:lote --aplicar` sobre un lote ya conciliado antes reprocesaba TAMBIÉN los movimientos
 * viejos y generaba `asiento_propuesto` duplicados):
 * - `asiento_propuesto_renglon`: excluye SIN condición — es terminal, es la fila que causa la
 *   duplicación real (`escribirAsientoAutomatico` no tiene centinela ni constraint de respaldo).
 * - `pendiente_cierre`: excluye solo si `pendiente_estado <> 'abierto'` (terminal:
 *   `resuelto`/`superseded`/`dispensado`). Un pendiente `'abierto'` NO se excluye a propósito
 *   (hallazgo de `motor-conciliacion-contable`): merece volver a intentar resolverse la próxima vez
 *   que se corra `conciliar:lote` (por ejemplo, si se cargó la `regla_imputacion` que le faltaba) —
 *   `escribirPendienteDeImputacion` ya es idempotente en escritura (`uq_pendiente_cierre_natural` +
 *   centinela), así que dejarlo pasar de nuevo no duplica nada.
 *
 * **Fuera de alcance, declarado a propósito, no un agujero silencioso** (hallazgo de
 * `motor-conciliacion-contable`): la supersesión de `reconocimiento_movimiento` sobre un movimiento
 * YA imputado (bump de léxico/catálogo, `recapturar-conceptos.ts`, `backfill-contraparte.ts`) no
 * tiene, hoy, ningún camino de reproceso equivalente a `reprocesar-capa-d.ts` — un asiento así queda
 * citando la clasificación vieja. No se resuelve en este fix.
 */
/**
 * El criterio de "ya imputado" (fix de idempotencia, 2026-09-09) — extraído a una sola constante
 * para que `leerReconocimientosParaImputar` (por lote) y `contarPropuestaSinAsientoPorTipo` (por
 * tipo, para el dry-run de `alta-regla-imputacion.ts`) NUNCA puedan divergir en silencio. Asume el
 * alias `r` para `reconocimiento_movimiento` — quien la usa tiene que nombrar así su FROM.
 */
const CONDICION_SIN_ASIENTO_NI_PENDIENTE_TERMINAL = `
  not exists (
    select 1 from asiento_propuesto_renglon apr
     where apr.cliente_id = r.cliente_id and apr.referencia_origen = r.movimiento_id::text
  )
  and not exists (
    select 1 from pendiente_cierre pc
     where pc.cliente_id = r.cliente_id and pc.referencia_origen = r.movimiento_id::text
       and pc.pendiente_estado <> 'abierto'
  )
`;

export async function leerReconocimientosParaImputar(
  tx: Tx,
  args: { readonly clienteId: string; readonly loteIngestaId: string },
): Promise<ResultadoReconocimientosParaImputar> {
  const filas = await tx.consultar<{
    id: string;
    movimiento_id: string;
    clase: string;
    tipo: string | null;
    concepto: string | null;
    polaridad: string | null;
    lado: string | null;
    via: string | null;
    evidencia_entrada_lexico_id: string | null;
    evidencia_caracteres_matcheados: number | null;
    evidencia_hubo_cola: boolean | null;
    fecha: string;
    importe: string;
    cuenta_bancaria_id: string;
  }>(
    `select r.id::text as id, r.movimiento_id::text as movimiento_id, r.clase, r.tipo, r.concepto,
            r.polaridad, r.lado, r.via, r.evidencia_entrada_lexico_id,
            r.evidencia_caracteres_matcheados, r.evidencia_hubo_cola,
            m.fecha::text as fecha, abs(m.importe)::text as importe,
            m.cuenta_bancaria_id::text as cuenta_bancaria_id
       from reconocimiento_movimiento r
       join movimiento_bancario_crudo m
         on m.cliente_id = r.cliente_id and m.id = r.movimiento_id
      where r.cliente_id = $1 and m.lote_ingesta_id = $2
        and r.superseded_por is null and r.clase = 'propuesta'
        and ${CONDICION_SIN_ASIENTO_NI_PENDIENTE_TERMINAL}
      order by m.fila_numero`,
    [args.clienteId, args.loteIngestaId],
  );

  const totalFilas = await tx.consultar<{ total: string }>(
    `select count(*)::text as total
       from reconocimiento_movimiento r
       join movimiento_bancario_crudo m
         on m.cliente_id = r.cliente_id and m.id = r.movimiento_id
      where r.cliente_id = $1 and m.lote_ingesta_id = $2
        and r.superseded_por is null and r.clase = 'propuesta'`,
    [args.clienteId, args.loteIngestaId],
  );
  const total = Number(totalFilas[0]?.total ?? '0');

  return {
    filas: filas.map((f) => ({
      reconocimientoId: f.id,
      movimientoId: f.movimiento_id,
      clase: f.clase,
      // `clase = 'propuesta'` en el WHERE garantiza que estos campos nunca son NULL — los propios
      // CHECK de `0014` (`reconocimiento_forma_chk`) lo exigen para esa clase.
      tipo: f.tipo as string,
      concepto: f.concepto as string,
      polaridad: f.polaridad as string,
      lado: f.lado as string,
      via: f.via as string,
      evidenciaEntradaLexicoId: f.evidencia_entrada_lexico_id as string,
      evidenciaCaracteresMatcheados: f.evidencia_caracteres_matcheados as number,
      evidenciaHuboCola: f.evidencia_hubo_cola as boolean,
      fecha: f.fecha,
      importe: f.importe,
      cuentaBancariaId: f.cuenta_bancaria_id,
    })),
    yaImputadosExcluidos: total - filas.length,
  };
}

/**
 * Cuántos movimientos `propuesta` de UN tipo, en TODO el corpus del cliente (no un lote puntual),
 * siguen sin `asiento_propuesto_renglon` ni `pendiente_cierre` terminal — el "radio del gesto" que
 * `alta-regla-imputacion.ts` muestra en su dry-run, ANTES de dar de alta la regla. Mismo criterio
 * EXACTO de exclusión que `leerReconocimientosParaImputar` (`CONDICION_SIN_ASIENTO_NI_PENDIENTE_
 * TERMINAL`, arriba) — JP, 2026-09-10: "reusá la misma consulta/criterio, no una tercera versión".
 */
export async function contarPropuestaSinAsientoPorTipo(
  tx: Tx,
  args: { readonly clienteId: string; readonly tipoMovimiento: string },
): Promise<number> {
  const filas = await tx.consultar<{ total: string }>(
    `select count(*)::text as total
       from reconocimiento_movimiento r
      where r.cliente_id = $1 and r.superseded_por is null and r.clase = 'propuesta'
        and r.tipo = $2
        and ${CONDICION_SIN_ASIENTO_NI_PENDIENTE_TERMINAL}`,
    [args.clienteId, args.tipoMovimiento],
  );
  return Number(filas[0]?.total ?? '0');
}

// -----------------------------------------------------------------------------
// leerReglasDeImputacionVigentes — D-29 pata "contrapartida"
// -----------------------------------------------------------------------------

/**
 * TODAS las reglas del cliente (sin filtrar por tipo/concepto/vigencia) — el resolver puro filtra él
 * mismo (`packages/motor-conciliacion`, "el resolver filtra, nunca confía en que el caller ya
 * pre-filtró"). Volumen esperado: bajo, una fila por `(tipo_movimiento[, concepto])` vigente más su
 * historial — sin índice adicional hasta que un cliente real lo justifique (regla de `dba-data`).
 */
type FilaReglaImputacion = {
  id: string;
  cliente_id: string;
  tipo_movimiento: string;
  concepto: string | null;
  cuenta_resolucion: string;
  cuenta_id: string | null;
  rol_funcional_objetivo: string | null;
  vigente_desde: string;
  vigente_hasta: string | null;
  respaldo: string;
  decidido_por: string;
  creada_en: string;
};

const COLUMNAS_REGLA_IMPUTACION = `id::text as id, cliente_id::text as cliente_id, tipo_movimiento, concepto,
            cuenta_resolucion, cuenta_id::text as cuenta_id,
            rol_funcional_objetivo, vigente_desde::text as vigente_desde,
            vigente_hasta::text as vigente_hasta, respaldo, decidido_por::text as decidido_por,
            creada_en::text as creada_en`;

function filaAReglaImputacion(f: FilaReglaImputacion): ReglaImputacion {
  return {
    id: f.id,
    clienteId: f.cliente_id,
    tipoMovimiento: f.tipo_movimiento,
    concepto: f.concepto,
    cuentaResolucion: f.cuenta_resolucion as CuentaResolucion,
    cuentaId: f.cuenta_id,
    rolFuncionalObjetivo: f.rol_funcional_objetivo as RolFuncionalCuenta | null,
    vigenteDesde: f.vigente_desde,
    vigenteHasta: f.vigente_hasta,
    respaldo: f.respaldo,
    decididoPor: f.decidido_por,
    creadaEn: f.creada_en,
  };
}

export async function leerReglasDeImputacionVigentes(
  tx: Tx,
  args: { readonly clienteId: string },
): Promise<readonly ReglaImputacion[]> {
  const filas = await tx.consultar<FilaReglaImputacion>(
    `select ${COLUMNAS_REGLA_IMPUTACION}
       from regla_imputacion
      where cliente_id = $1
      order by tipo_movimiento, concepto nulls last, vigente_desde`,
    [args.clienteId],
  );

  return filas.map(filaAReglaImputacion);
}

/** Una regla puntual por id — para el selector de `reprocesar-capa-d.ts` (`--regla-imputacion-anterior-id`). */
export async function leerReglaImputacionPorId(
  tx: Tx,
  args: { readonly clienteId: string; readonly reglaImputacionId: string },
): Promise<ReglaImputacion | undefined> {
  const filas = await tx.consultar<FilaReglaImputacion>(
    `select ${COLUMNAS_REGLA_IMPUTACION} from regla_imputacion where cliente_id = $1 and id = $2`,
    [args.clienteId, args.reglaImputacionId],
  );
  const f = filas[0];
  return f ? filaAReglaImputacion(f) : undefined;
}

// -----------------------------------------------------------------------------
// `confirmacion_grupo` (`0043`) — memoria de confirmaciones por grupo (doc 31, Tanda 2)
// -----------------------------------------------------------------------------

type FilaConfirmacionGrupo = {
  id: string;
  cliente_id: string;
  banco_codigo: string;
  concepto_banco: string | null;
  concepto_normalizado: string;
  cuenta_id: string;
  respaldo: string;
  confirmado_por: string;
  confirmado_en: string;
  vigente_hasta: string | null;
};

const COLUMNAS_CONFIRMACION_GRUPO = `id::text as id, cliente_id::text as cliente_id, banco_codigo,
            concepto_banco, concepto_normalizado, cuenta_id::text as cuenta_id, respaldo,
            confirmado_por::text as confirmado_por, confirmado_en::text as confirmado_en,
            vigente_hasta::text as vigente_hasta`;

function filaAConfirmacionGrupo(f: FilaConfirmacionGrupo): ConfirmacionGrupo {
  return {
    id: f.id,
    clienteId: f.cliente_id,
    bancoCodigo: f.banco_codigo,
    conceptoBanco: f.concepto_banco,
    conceptoNormalizado: f.concepto_normalizado,
    cuentaId: f.cuenta_id,
    respaldo: f.respaldo,
    confirmadoPor: f.confirmado_por,
    confirmadoEn: f.confirmado_en,
    vigenteHasta: f.vigente_hasta,
  };
}

/** Todas las confirmaciones VIGENTES de un cliente — para el llamador de `armar-libro.ts` (capa de
 *  exportación), que las indexa en memoria por `(bancoCodigo, conceptoNormalizado)`. Nunca filtra por
 *  banco/concepto en SQL: el llamador ya tiene `normalizarParaAgrupar()` como único árbitro de la
 *  clave (evita una segunda implementación de la normalización divergiendo de la primera). */
export async function leerConfirmacionesGrupoVigentes(
  tx: Tx,
  args: { readonly clienteId: string },
): Promise<readonly ConfirmacionGrupo[]> {
  const filas = await tx.consultar<FilaConfirmacionGrupo>(
    `select ${COLUMNAS_CONFIRMACION_GRUPO}
       from confirmacion_grupo
      where cliente_id = $1 and vigente_hasta is null
      order by banco_codigo, concepto_normalizado`,
    [args.clienteId],
  );
  return filas.map(filaAConfirmacionGrupo);
}

/** Una confirmación puntual por id — para el selector `--revoca` de `confirmar-grupo.ts`. */
export async function leerConfirmacionGrupoPorId(
  tx: Tx,
  args: { readonly clienteId: string; readonly confirmacionGrupoId: string },
): Promise<ConfirmacionGrupo | undefined> {
  const filas = await tx.consultar<FilaConfirmacionGrupo>(
    `select ${COLUMNAS_CONFIRMACION_GRUPO} from confirmacion_grupo where cliente_id = $1 and id = $2`,
    [args.clienteId, args.confirmacionGrupoId],
  );
  const f = filas[0];
  return f ? filaAConfirmacionGrupo(f) : undefined;
}

/** La vigente para UNA clave puntual — dry-run de `confirmar-grupo.ts` (antes de decidir `--aplicar`). */
export async function leerConfirmacionGrupoVigente(
  tx: Tx,
  args: { readonly clienteId: string; readonly bancoCodigo: string; readonly conceptoNormalizado: string },
): Promise<ConfirmacionGrupo | undefined> {
  const filas = await tx.consultar<FilaConfirmacionGrupo>(
    `select ${COLUMNAS_CONFIRMACION_GRUPO}
       from confirmacion_grupo
      where cliente_id = $1 and banco_codigo = $2 and concepto_normalizado = $3 and vigente_hasta is null`,
    [args.clienteId, args.bancoCodigo, args.conceptoNormalizado],
  );
  const f = filas[0];
  return f ? filaAConfirmacionGrupo(f) : undefined;
}

/**
 * La regla actualmente ABIERTA (`vigente_hasta is null`) para el mismo `(tipo_movimiento, concepto)`
 * de una regla dada — `uq_regla_imputacion_vigente` (`0030`) garantiza que hay COMO MÁXIMO una. Es el
 * "destino" que `reprocesar-capa-d.ts` infiere solo — el operador no tipea un segundo id: sería
 * redundante con lo que la propia base ya sabe, y una fuente más de error humano.
 */
export async function leerReglaSucesoraVigente(
  tx: Tx,
  args: { readonly clienteId: string; readonly tipoMovimiento: string; readonly concepto: string | null; readonly excluirReglaId: string },
): Promise<ReglaImputacion | undefined> {
  const filas = await tx.consultar<FilaReglaImputacion>(
    `select ${COLUMNAS_REGLA_IMPUTACION}
       from regla_imputacion
      where cliente_id = $1 and tipo_movimiento = $2
        and concepto is not distinct from $3
        and vigente_hasta is null
        and id <> $4`,
    [args.clienteId, args.tipoMovimiento, args.concepto, args.excluirReglaId],
  );
  const f = filas[0];
  return f ? filaAReglaImputacion(f) : undefined;
}

// -----------------------------------------------------------------------------
// leerPlanDeCuentasCompleto — para `CuentaRef` (D-15) y el veto de `rolFuncional` (D-31)
// -----------------------------------------------------------------------------

export type FilaDelPlanDeCuentas = {
  readonly cuentaId: string;
  readonly codigo: string;
  readonly denominacion: string;
  readonly rolFuncional: RolFuncionalCuenta;
  readonly activa: boolean;
  readonly vigenteDesde: string;
  readonly vigenteHasta: string | null;
};

/**
 * TODO el historial de `cuenta_atributo` del cliente (no solo lo vigente hoy) — el resolver
 * necesita, para cada movimiento, la fila vigente a SU fecha, no a la fecha de la corrida (D-29 §2:
 * "resolviendo el rol_funcional vigente a la fecha del movimiento, no el rol actual").
 */
export async function leerPlanDeCuentasCompleto(
  tx: Tx,
  args: { readonly clienteId: string },
): Promise<readonly FilaDelPlanDeCuentas[]> {
  const filas = await tx.consultar<{
    cuenta_id: string;
    codigo: string;
    denominacion: string;
    rol_funcional: string;
    activa: boolean;
    vigente_desde: string;
    vigente_hasta: string | null;
  }>(
    `select cuenta_id::text as cuenta_id, codigo, denominacion, rol_funcional, activa,
            vigente_desde::text as vigente_desde, vigente_hasta::text as vigente_hasta
       from cuenta_atributo
      where cliente_id = $1
      order by cuenta_id, vigente_desde`,
    [args.clienteId],
  );

  return filas.map((f) => ({
    cuentaId: f.cuenta_id,
    codigo: f.codigo,
    denominacion: f.denominacion,
    rolFuncional: f.rol_funcional as RolFuncionalCuenta,
    activa: f.activa,
    vigenteDesde: f.vigente_desde,
    vigenteHasta: f.vigente_hasta,
  }));
}

// -----------------------------------------------------------------------------
// leerMapeoCuentasBancarias — D-29 pata "banco"
// -----------------------------------------------------------------------------

/** `cuenta_bancaria_id → cuenta_id | null` (mapeo fijo 1:1, sin vigencia — `0030`). */
export async function leerMapeoCuentasBancarias(
  tx: Tx,
  args: { readonly clienteId: string },
): Promise<ReadonlyMap<string, string | null>> {
  const filas = await tx.consultar<{ id: string; cuenta_id: string | null }>(
    `select id::text as id, cuenta_id::text as cuenta_id
       from cuenta_bancaria
      where cliente_id = $1`,
    [args.clienteId],
  );

  return new Map(filas.map((f) => [f.id, f.cuenta_id]));
}

// -----------------------------------------------------------------------------
// leerEstadoDeAsientos — para el dry-run de `confirmar-asientos.ts` (Mitad 1 de reproceso, `0040`)
// -----------------------------------------------------------------------------

export type EstadoDeAsiento = { readonly asientoEstado: string; readonly cierreId: string };

/**
 * Un `Map` con SOLO los `asientoId` encontrados (para ese `clienteId`, vía RLS) — el caller detecta
 * "no encontrado" por ausencia de clave, nunca por un valor inventado. Selector explícito por lista
 * de ids (nunca "todo lo pendiente" del cliente) — mismo criterio que `0040`, punto 1 del plan.
 */
export async function leerEstadoDeAsientos(
  tx: Tx,
  args: { readonly clienteId: string; readonly asientoIds: readonly string[] },
): Promise<ReadonlyMap<string, EstadoDeAsiento>> {
  if (args.asientoIds.length === 0) return new Map();
  const filas = await tx.consultar<{ id: string; asiento_estado: string; cierre_id: string }>(
    `select id::text as id, asiento_estado, cierre_id::text as cierre_id
       from asiento_propuesto
      where cliente_id = $1 and id = any($2::uuid[])`,
    [args.clienteId, args.asientoIds],
  );
  return new Map(filas.map((f) => [f.id, { asientoEstado: f.asiento_estado, cierreId: f.cierre_id }]));
}

// -----------------------------------------------------------------------------
// leerCandidatosDeReproceso — el selector real de `reprocesar-capa-d.ts` (`0040`, Mitad 1, Paso 4)
// -----------------------------------------------------------------------------

export type RenglonCandidato = {
  readonly renglonId: string;
  readonly cuentaId: string;
  readonly cuentaRef: CuentaRef;
  readonly lado: 'debe' | 'haber';
  readonly importe: string;
};

export type CandidatoDeReproceso = {
  readonly asientoId: string;
  readonly asientoEstado: 'propuesto' | 'confirmado';
  readonly cierreId: string;
  readonly tipo: TipoAsientoPropuesto;
  readonly fechaImputacion: string;
  /** El renglón que citaba la cuenta de la regla ANTERIOR — el que hay que corregir. */
  readonly renglonCorregible: RenglonCandidato;
  /** El otro renglón del asiento (típicamente el del banco) — nunca se toca en ninguno de los 2 casos. */
  readonly renglonOtro: RenglonCandidato;
};

/** `asientoId` que matchearon la cuenta de la regla anterior pero NO calificaron como candidato
 *  limpio — el reporte de dry-run los tiene que mostrar, nunca descartarlos en silencio. */
export type AsientoAnomaloDeReproceso = {
  readonly asientoId: string;
  readonly motivoCodigo: 'no_tiene_exactamente_dos_renglones' | 'los_dos_renglones_citan_la_cuenta_anterior';
};

/**
 * Selector = "asientos vigentes (`'propuesto'`/`'confirmado'`, sin superseder) de este cliente con
 * exactamente un renglón que cita `cuentaAnteriorId`" — nunca "todo lo desactualizado" del cliente:
 * está acotado a la cuenta de UNA regla puntual, la que el operador nombró por `--regla-imputacion-
 * anterior-id`. Excluye asientos que sean ellos mismos un ajuste (`corrige_asiento_id is not null`) y
 * los que ya tienen una fila en `asiento_propuesto_reproceso` (ya reprocesados) — nunca reprocesa dos
 * veces el mismo hecho económico por la misma corrida ni por una corrida repetida.
 */
export async function leerCandidatosDeReproceso(
  tx: Tx,
  args: { readonly clienteId: string; readonly cuentaAnteriorId: string },
): Promise<{ readonly candidatos: readonly CandidatoDeReproceso[]; readonly anomalos: readonly AsientoAnomaloDeReproceso[] }> {
  const filas = await tx.consultar<{
    asiento_id: string;
    asiento_estado: string;
    cierre_id: string;
    tipo: string;
    fecha_imputacion: string;
    renglon_id: string;
    cuenta_id: string;
    cuenta_ref: CuentaRef;
    debe: string;
    haber: string;
  }>(
    `select a.id as asiento_id, a.asiento_estado, a.cierre_id::text as cierre_id, a.tipo,
            a.fecha_imputacion::text as fecha_imputacion,
            r.id as renglon_id, r.cuenta_id::text as cuenta_id, r.cuenta_ref, r.debe, r.haber
       from asiento_propuesto a
       join asiento_propuesto_renglon r on r.cliente_id = a.cliente_id and r.asiento_id = a.id
      where a.cliente_id = $1
        and a.asiento_estado in ('propuesto', 'confirmado')
        and a.corrige_asiento_id is null
        and not exists (
          select 1 from asiento_propuesto_reproceso rp
           where rp.cliente_id = a.cliente_id and rp.asiento_id = a.id
        )
        and exists (
          select 1 from asiento_propuesto_renglon r2
           where r2.cliente_id = a.cliente_id and r2.asiento_id = a.id and r2.cuenta_id = $2
        )
      order by a.id, r.orden`,
    [args.clienteId, args.cuentaAnteriorId],
  );

  const porAsiento = new Map<string, typeof filas>();
  for (const f of filas) {
    const lista = porAsiento.get(f.asiento_id) ?? [];
    lista.push(f);
    porAsiento.set(f.asiento_id, lista);
  }

  const candidatos: CandidatoDeReproceso[] = [];
  const anomalos: AsientoAnomaloDeReproceso[] = [];

  for (const [asientoId, renglones] of porAsiento) {
    if (renglones.length !== 2) {
      anomalos.push({ asientoId, motivoCodigo: 'no_tiene_exactamente_dos_renglones' });
      continue;
    }
    const [r1, r2] = renglones as [(typeof renglones)[number], (typeof renglones)[number]];
    const r1Corregible = r1.cuenta_id === args.cuentaAnteriorId;
    const r2Corregible = r2.cuenta_id === args.cuentaAnteriorId;
    if (r1Corregible === r2Corregible) {
      // Los dos citan la cuenta anterior (o, imposible dado el `exists` de arriba, ninguno) — un
      // asiento donde las dos patas caen en la misma cuenta no es el caso que este selector resuelve.
      anomalos.push({ asientoId, motivoCodigo: 'los_dos_renglones_citan_la_cuenta_anterior' });
      continue;
    }
    const corregible = r1Corregible ? r1 : r2;
    const otro = r1Corregible ? r2 : r1;
    const aRenglon = (f: (typeof renglones)[number]): RenglonCandidato => ({
      renglonId: f.renglon_id,
      cuentaId: f.cuenta_id,
      cuentaRef: f.cuenta_ref,
      lado: Number(f.debe) > 0 ? 'debe' : 'haber',
      importe: Number(f.debe) > 0 ? f.debe : f.haber,
    });
    candidatos.push({
      asientoId,
      asientoEstado: renglones[0]?.asiento_estado as 'propuesto' | 'confirmado',
      cierreId: renglones[0]?.cierre_id as string,
      tipo: renglones[0]?.tipo as TipoAsientoPropuesto,
      fechaImputacion: renglones[0]?.fecha_imputacion as string,
      renglonCorregible: aRenglon(corregible),
      renglonOtro: aRenglon(otro),
    });
  }

  return { candidatos, anomalos };
}

// -----------------------------------------------------------------------------
// leerCuentaRefVigente — la cita del plan de cuentas VIGENTE HOY, para las cuentas que
// `reprocesar-capa-d.ts` introduce en un renglón nuevo (la cuenta nueva de la regla, y — en Caso B —
// la cuenta vieja que hay que revertir). Corrida manual disparada HOY (D-15: el asiento cita el plan
// vigente a su propia fecha; acá esa fecha es la del reproceso, no la del hecho económico original).
// -----------------------------------------------------------------------------

export async function leerCuentaRefVigente(
  tx: Tx,
  args: { readonly clienteId: string; readonly cuentaIds: readonly string[] },
): Promise<ReadonlyMap<string, CuentaRef>> {
  if (args.cuentaIds.length === 0) return new Map();
  const filas = await tx.consultar<{ cuenta_id: string; codigo: string; denominacion: string; rol_funcional: string }>(
    `select cuenta_id::text as cuenta_id, codigo, denominacion, rol_funcional
       from cuenta_atributo
      where cliente_id = $1 and cuenta_id = any($2::uuid[]) and vigente_hasta is null`,
    [args.clienteId, args.cuentaIds],
  );
  return new Map(
    filas.map((f) => [
      f.cuenta_id,
      { codigo: f.codigo, denominacion: f.denominacion, rolFuncional: f.rol_funcional as RolFuncionalCuenta },
    ]),
  );
}

// -----------------------------------------------------------------------------
// leerCierreAbiertoDelCliente — el destino de Caso B (el `cierreIdActual` que `corregirAsientoEntregado`
// exige) — nunca inferido, siempre UNA fila `cierre_estado = 'abierto'` o el CLI aborta explícito.
// -----------------------------------------------------------------------------

export async function leerCierreAbiertoDelCliente(tx: Tx, args: { readonly clienteId: string }): Promise<readonly string[]> {
  const filas = await tx.consultar<{ id: string }>(
    `select id::text as id from cierre_cliente_periodo where cliente_id = $1 and cierre_estado = 'abierto'`,
    [args.clienteId],
  );
  return filas.map((f) => f.id);
}

// -----------------------------------------------------------------------------
// contarAsientosDelCliente — el denominador del reporte de `reprocesar-capa-d.ts`: la proporción
// afectada sobre EL TOTAL de asientos del cliente (el hallazgo de la convocatoria: para uno de los
// dos clientes reales, esto ronda el 95% de todo lo que Capa D le generó — el operador tiene que
// verlo ANTES de poder `--aplicar`, nunca enterarse después).
// -----------------------------------------------------------------------------

export async function contarAsientosDelCliente(tx: Tx, args: { readonly clienteId: string }): Promise<number> {
  const filas = await tx.consultar<{ n: string }>(`select count(*)::text as n from asiento_propuesto where cliente_id = $1`, [args.clienteId]);
  return Number(filas[0]?.n ?? '0');
}
