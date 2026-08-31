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
import type { CuentaResolucion, ReglaImputacion, RolFuncionalCuenta } from './tipos.ts';

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

/**
 * Solo `clase = 'propuesta'` — `decision_humana`/`sin_reconocer` quedan fuera de alcance de esta
 * versión del motor (D-28, bloqueado: no está resuelto qué `motivo_codigo` les corresponde). Filtrar
 * acá, no en el resolver, evita construir un `pendiente_cierre` con un motivo inventado para una
 * clase que ningún documento cerró todavía.
 *
 * Solo reconocimientos VIGENTES (`superseded_por is null`) — mismo criterio que
 * `leerReconocimientosActivos`.
 */
export async function leerReconocimientosParaImputar(
  tx: Tx,
  args: { readonly clienteId: string; readonly loteIngestaId: string },
): Promise<readonly FilaReconocimientoParaImputar[]> {
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
      order by m.fila_numero`,
    [args.clienteId, args.loteIngestaId],
  );

  return filas.map((f) => ({
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
  }));
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
export async function leerReglasDeImputacionVigentes(
  tx: Tx,
  args: { readonly clienteId: string },
): Promise<readonly ReglaImputacion[]> {
  const filas = await tx.consultar<{
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
  }>(
    `select id::text as id, cliente_id::text as cliente_id, tipo_movimiento, concepto,
            cuenta_resolucion, cuenta_id::text as cuenta_id,
            rol_funcional_objetivo, vigente_desde::text as vigente_desde,
            vigente_hasta::text as vigente_hasta, respaldo, decidido_por::text as decidido_por,
            creada_en::text as creada_en
       from regla_imputacion
      where cliente_id = $1
      order by tipo_movimiento, concepto nulls last, vigente_desde`,
    [args.clienteId],
  );

  return filas.map((f) => ({
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
  }));
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
