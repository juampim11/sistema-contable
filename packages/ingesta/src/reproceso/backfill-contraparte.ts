/**
 * BACKFILL DE CONTRAPARTE — completa `movimiento_contraparte_identificador` y
 * `movimiento_bancario_crudo.contraparte_captura` sobre los lotes YA INGERIDOS antes de la
 * migración `0013_contraparte_hmac_y_padron.sql`. Plan `adaptive-herding-pillow` (Módulo 2,
 * primera etapa).
 *
 * Para lotes NUEVOS el candidato ya se calcula en el momento de ingerir
 * (`packages/ingesta/src/persistir.ts`, vía `extraerCandidatosDeContraparte`) — exposición cero,
 * nunca relee N2-R. Esta herramienta es EXCLUSIVAMENTE para el histórico.
 *
 * ## No es un mecanismo de una sola vez
 *
 * A diferencia de `cuenta_bancaria_identificador.cbu_hmac` (cuya rotación es perezosa porque el
 * valor en claro NO vive en el sistema — el próximo extracto lo trae de nuevo), acá el valor en
 * claro SÍ vive para siempre en `movimiento_origen_crudo`, y ningún extracto futuro re-toca una
 * fila vieja. Esta herramienta ES el mecanismo de re-hasheo cuando el pepper GLOBAL rote — por eso
 * la idempotencia está atada a "¿ya tiene captura?" (el centinela `contraparte_captura`), no a un
 * flag de una sola corrida.
 *
 * ## La transacción, en DOS partes
 *
 * Envolver la lectura N2-R y la escritura en una sola `conUsuario` es un bug real: un `ROLLBACK`
 * borra la fila de auditoría de la lectura, pero NO saca de la memoria del proceso los
 * identificadores que ya pasaron por ahí (`seguridad-datos-financieros`, ronda de revisión de esta
 * migración). Mismo patrón que `packages/almacenamiento/src/lectura.ts` ya resuelve para el PDF de
 * `recapturar-conceptos`:
 *
 *   Tx1 (`leerInsumosDeBackfill`, comitea y NUNCA se revierte una vez que corrió):
 *     rol → ancla del lote → `leerConAuditoria` sobre `movimiento_origen_crudo`
 *     (`leerFilasOrigenDeLote`) → `avisarSiLasLecturasSonAnomalas` → COMMIT.
 *   [fuera de transacción: `extraerCandidatosDeContraparte` por movimiento — puro, sin más I/O]
 *   Tx2 (`backfillearContraparteDeLote`): `for update` sobre `lote_ingesta` → rol DE NUEVO →
 *     centinela de idempotencia → `escribirConAuditoria` → UPDATE + INSERT → COMMIT.
 *
 * ## Un lote por corrida, siempre
 *
 * Nunca `--todos-los-lotes`, nunca un rango: es lo que hace que `recurso_id = loteId` DETERMINE el
 * alcance leído, sin depender de que el operador lo haya declarado bien.
 */

import {
  conUsuario,
  escribirConAuditoria,
  leerConAuditoria,
  leerDigestsDeCuentasPropias,
  leerFilasOrigenDeLote,
  type FilaOrigen,
  type Tx,
} from '@sistema-contable/data';
import { avisarSiLasLecturasSonAnomalas } from '@sistema-contable/almacenamiento';
import { logger } from '@sistema-contable/shared/observabilidad';
import { pepperIdActual } from '@sistema-contable/shared/seguridad';
import { extraerCandidatosDeContraparte } from '../contraparte.ts';

/** Más estricto que `ROLES_QUE_DESCARGAN` (`['socio','contador']`) — decisión explícita para esta
 *  primera corrida sobre datos reales. Ampliarlo después es un cambio de una línea, sin migración. */
export const ROLES_QUE_BACKFILLEAN = ['socio'] as const;

export const MOTIVOS_ABORTO_BACKFILL = [
  'lote_no_encontrado',
  'lote_no_backfilleable',
  'rol_insuficiente',
] as const;
export type MotivoAbortoBackfill = (typeof MOTIVOS_ABORTO_BACKFILL)[number];

export type ConteoBackfill = {
  readonly filasDelLote: number;
  readonly leidasDeN2R: number;
  readonly candidatosTotales: number;
  readonly sinIdentificador: number;
  readonly capturadoCuentaPropia: number;
  readonly descartadosPorForma: number;
};

export type InsumosBackfill = {
  readonly filasOrigen: readonly FilaOrigen[];
  readonly digestsPropios: readonly Buffer[];
};

export type ResultadoLecturaInsumos =
  | { readonly ok: true; readonly insumos: InsumosBackfill }
  | { readonly ok: false; readonly motivoCodigo: MotivoAbortoBackfill };

function esEstadoBackfilleable(estado: string): boolean {
  return estado === 'procesado' || estado === 'procesado_con_observaciones';
}

/**
 * Tx1 — lee los insumos N2-R del lote. Comitea antes de devolver: si el llamador aborta después
 * (Ctrl-C, una compuerta que falla en Tx2), el rastro de esta lectura queda igual — la lectura
 * ocurrió, y el rollback de otra transacción no la deshace de la memoria del proceso.
 */
export async function leerInsumosDeBackfill(
  usuarioId: string,
  pedido: { readonly clienteId: string; readonly loteId: string },
): Promise<ResultadoLecturaInsumos> {
  return conUsuario(usuarioId, async (tx: Tx) => {
    const anclaFilas = await tx.consultar<{ estado: string }>(
      `select estado from lote_ingesta where id = $1 and cliente_id = $2`,
      [pedido.loteId, pedido.clienteId],
    );
    const ancla = anclaFilas[0];
    if (!ancla) {
      return { ok: false as const, motivoCodigo: 'lote_no_encontrado' as const };
    }
    if (!esEstadoBackfilleable(ancla.estado)) {
      return { ok: false as const, motivoCodigo: 'lote_no_backfilleable' as const };
    }

    const rolFilas = await tx.consultar<{ puede: boolean }>(
      `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
      [pedido.clienteId, ROLES_QUE_BACKFILLEAN],
    );
    if (rolFilas[0]?.puede !== true) {
      return { ok: false as const, motivoCodigo: 'rol_insuficiente' as const };
    }

    const filasOrigen = await leerConAuditoria(
      tx,
      {
        clienteId: pedido.clienteId,
        accion: 'lectura',
        recurso: 'movimiento_origen_crudo',
        recursoId: pedido.loteId,
        motivo: `backfill_contraparte:${pepperIdActual()}`,
      },
      (ctx) => leerFilasOrigenDeLote(tx, ctx, { clienteId: pedido.clienteId, loteIngestaId: pedido.loteId }),
    );
    // Después de auditar: el contador tiene que incluir esta lectura.
    await avisarSiLasLecturasSonAnomalas(tx, pedido.clienteId);

    const digestsPropios = await leerDigestsDeCuentasPropias(tx, pedido.clienteId);

    return { ok: true as const, insumos: { filasOrigen, digestsPropios } };
  });
}

type IdentificadoresAlmacenados = {
  readonly cuit: readonly string[];
  readonly cbu: readonly string[];
  readonly documento: readonly string[];
};

/** `fila_origen` es `unknown` en el tipo del lector — es jsonb sin esquema en la base. Se lee con
 *  un guard mínimo, nunca con un cast ciego: un `fila_origen` con otra forma produce cero
 *  candidatos, nunca una excepción a mitad del lote. */
function identificadoresDe(filaOrigen: unknown): IdentificadoresAlmacenados {
  const obj = filaOrigen as { identificadores?: Partial<IdentificadoresAlmacenados> } | null | undefined;
  return {
    cuit: obj?.identificadores?.cuit ?? [],
    cbu: obj?.identificadores?.cbu ?? [],
    documento: obj?.identificadores?.documento ?? [],
  };
}

export type PedidoBackfill = {
  readonly clienteId: string;
  readonly loteId: string;
  /** `false` = dry-run: calcula y cuenta, nunca escribe. `true` = escribe si hay algo pendiente. */
  readonly aplicar: boolean;
};

export type ResultadoBackfill =
  | { readonly estado: 'ya_backfilleado'; readonly loteId: string }
  | { readonly estado: 'listo'; readonly conteo: ConteoBackfill }
  | { readonly estado: 'aplicado'; readonly conteo: ConteoBackfill; readonly filasActualizadas: number }
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoBackfill };

/**
 * Tx2 — recibe los insumos YA LEÍDOS y auditados por `leerInsumosDeBackfill`. Nunca abre su propia
 * lectura de N2-R.
 */
export async function backfillearContraparteDeLote(
  tx: Tx,
  pedido: PedidoBackfill,
  insumos: InsumosBackfill,
): Promise<ResultadoBackfill> {
  // TOCTOU + serialización de dos corridas del operador: el ancla se bloquea acá.
  const anclaFilas = await tx.consultar<{ estado: string }>(
    `select estado from lote_ingesta where id = $1 and cliente_id = $2 for update`,
    [pedido.loteId, pedido.clienteId],
  );
  const ancla = anclaFilas[0];
  if (!ancla) {
    return { estado: 'abortado', motivoCodigo: 'lote_no_encontrado' };
  }
  if (!esEstadoBackfilleable(ancla.estado)) {
    return { estado: 'abortado', motivoCodigo: 'lote_no_backfilleable' };
  }

  // Rol, DE NUEVO — la ventana entre Tx1 y Tx2 puede haber cambiado la membership, y `mov_crudo_wr`
  // por sí sola admite también `administrativo`.
  const rolFilas = await tx.consultar<{ puede: boolean }>(
    `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
    [pedido.clienteId, ROLES_QUE_BACKFILLEAN],
  );
  if (rolFilas[0]?.puede !== true) {
    return { estado: 'abortado', motivoCodigo: 'rol_insuficiente' };
  }

  /**
   * Idempotencia CONSCIENTE DEL PEPPER — no solo "¿ya tiene captura?".
   *
   * Un movimiento está pendiente si nunca se procesó (`'no_capturado'`), o si se procesó con
   * candidatos pero el pepper OBJETIVO (el actual del entorno, `pepperIdActual()`) no tiene fila
   * entre esos candidatos — el caso de una rotación. `'sin_identificador'` y
   * `'capturado_cuenta_propia'` NUNCA vuelven a quedar pendientes: ninguna de las dos clasificaciones
   * depende del pepper derivado (la primera no tenía nada que hashear; la segunda se decide en
   * espacio GLOBAL — `hmacIdentificador` contra `cuenta_bancaria_identificador.cbu_hmac` — ajeno a
   * la derivación por cliente). Sin esta distinción, la herramienta no podría servir de mecanismo de
   * re-hasheo tras una rotación, contra lo que afirma la cabecera de este archivo.
   */
  const pepperObjetivo = pepperIdActual();
  const pendientesFilas = await tx.consultar<{ id: string }>(
    `select m.id::text as id
       from movimiento_bancario_crudo m
      where m.cliente_id = $1 and m.lote_ingesta_id = $2
        and (m.contraparte_captura = 'no_capturado'
             or (m.contraparte_captura = 'capturado'
                 and not exists (
                   select 1 from movimiento_contraparte_identificador c
                    where c.cliente_id = m.cliente_id and c.movimiento_id = m.id
                      and c.pepper_id = $3
                 )))`,
    [pedido.clienteId, pedido.loteId, pepperObjetivo],
  );
  const idsPendientes = new Set(pendientesFilas.map((f) => f.id));

  const totalFilas = await tx.consultar<{ n: number }>(
    `select count(*)::int as n from movimiento_bancario_crudo where cliente_id = $1 and lote_ingesta_id = $2`,
    [pedido.clienteId, pedido.loteId],
  );
  const total = totalFilas[0]?.n ?? 0;

  if (idsPendientes.size === 0) {
    return { estado: 'ya_backfilleado', loteId: pedido.loteId };
  }

  const conteo = {
    candidatosTotales: 0,
    sinIdentificador: 0,
    capturadoCuentaPropia: 0,
    descartadosPorForma: 0,
  };

  type PorEscribir = {
    readonly movimientoId: string;
    readonly captura: 'sin_identificador' | 'capturado' | 'capturado_cuenta_propia';
    readonly candidatos: readonly { readonly clase: string; readonly hmac: Buffer; readonly pepperId: string }[];
  };
  const aEscribir: PorEscribir[] = [];

  // Solo se recalculan los movimientos PENDIENTES — el resto del lote ya está resuelto para este
  // pepper y no hace falta tocarlo, ni de nuevo ni distinto.
  for (const fila of insumos.filasOrigen.filter((f) => idsPendientes.has(f.movimientoId))) {
    const identificadores = identificadoresDe(fila.filaOrigen);
    const extraccion = extraerCandidatosDeContraparte(identificadores, pedido.clienteId, insumos.digestsPropios);

    conteo.candidatosTotales += extraccion.candidatos.length;
    conteo.descartadosPorForma += extraccion.descartadosPorForma;
    if (extraccion.captura === 'sin_identificador') conteo.sinIdentificador += 1;
    if (extraccion.captura === 'capturado_cuenta_propia') conteo.capturadoCuentaPropia += 1;

    aEscribir.push({
      movimientoId: fila.movimientoId,
      captura: extraccion.captura,
      candidatos: extraccion.candidatos,
    });
  }

  const conteoCompleto: ConteoBackfill = {
    filasDelLote: total,
    leidasDeN2R: insumos.filasOrigen.length,
    ...conteo,
  };

  if (!pedido.aplicar) {
    return { estado: 'listo', conteo: conteoCompleto };
  }

  return escribirConAuditoria(
    tx,
    {
      clienteId: pedido.clienteId,
      accion: 'escritura',
      recurso: 'movimiento_bancario_crudo',
      recursoId: pedido.loteId,
      motivo: `backfill_contraparte:${pepperObjetivo}`,
    },
    async () => {
      const ids = aEscribir.map((f) => f.movimientoId);
      const capturas = aEscribir.map((f) => f.captura);

      // Bulk, atómico, acotado por `lote_ingesta_id` (sin él, un movimiento de OTRO lote con el
      // mismo id no podría colarse — pero el guard igual está, mismo criterio que
      // `recapturar-conceptos.ts`). El `WHERE` acota por el conjunto de ids YA CALCULADO como
      // pendiente arriba (`idsPendientes`), no por `contraparte_captura = 'no_capturado'` a secas:
      // en una rotación, un movimiento puede llegar acá con `contraparte_captura` ya en `'capturado'`
      // — sigue siendo el valor correcto, y el UPDATE lo re-escribe con el mismo resultado (recalculado
      // en limpio, así que también corrige si el padrón de cuentas propias cambió desde la corrida
      // anterior).
      const actualizadas = await tx.consultar<{ id: string }>(
        `update movimiento_bancario_crudo m
            set contraparte_captura = v.captura
           from unnest($1::uuid[], $2::text[]) as v(id, captura)
          where m.id = v.id
            and m.cliente_id = $3
            and m.lote_ingesta_id = $4
            and m.id = any($5::uuid[])
          returning m.id::text as id`,
        [ids, capturas, pedido.clienteId, pedido.loteId, [...idsPendientes]],
      );

      // Nunca `return` acá si esto no cierra: `conUsuario` comitea en cualquier return normal, y un
      // UPDATE ya emitido quedaría parcialmente escrito. `throw` fuerza el rollback de TODO.
      if (actualizadas.length !== aEscribir.length) {
        throw new Error(
          `backfill_contraparte: el UPDATE afectó ${actualizadas.length} de ${aEscribir.length} filas esperadas.`,
        );
      }

      let candidatosInsertados = 0;
      for (const f of aEscribir) {
        for (const candidato of f.candidatos) {
          await tx.consultar(
            `insert into movimiento_contraparte_identificador
               (cliente_id, movimiento_id, clase, identificador_hmac, pepper_id)
             values ($1, $2, $3, $4, $5)
             on conflict on constraint uq_mov_contraparte_candidato do nothing`,
            [pedido.clienteId, f.movimientoId, candidato.clase, candidato.hmac, candidato.pepperId],
          );
          candidatosInsertados += 1;
        }
      }

      logger.info('backfill_contraparte.aplicado', {
        cliente_id: pedido.clienteId,
        lote_id: pedido.loteId,
        filas: actualizadas.length,
        candidatos: candidatosInsertados,
      });

      return {
        estado: 'aplicado' as const,
        conteo: conteoCompleto,
        filasActualizadas: actualizadas.length,
      };
    },
  );
}
