/**
 * RECLASIFICACIÓN DE CONTRAPARTE — vuelve a correr `depurarGlosa()` +
 * `extraerCandidatosDeContraparte()` con el código ACTUAL sobre la glosa cruda ya persistida de un
 * lote, y corrige `contraparte_captura` + agrega los candidatos que el bug de turno no capturó.
 *
 * ## En qué se diferencia de `backfill-contraparte.ts`
 *
 * `backfill-contraparte.ts` completa el histórico PRE-`0013`: relee los `identificadores` que
 * `depurarGlosa` YA había calculado (correctamente) y nunca se habían usado. Este módulo es para el
 * caso contrario: `depurarGlosa`/`extraerCandidatosDeContraparte` (o un detector del que dependen,
 * `packages/shared/src/seguridad/detectores-forma.ts`) tenían un BUG cuando el lote se ingirió, y ya
 * se corrigió — el `identificadores` guardado en `movimiento_origen_crudo` está mal (le faltan
 * identificadores que el fix de hoy sí encuentra). Por eso este módulo relee la `glosaOriginal` en
 * claro y vuelve a correr `depurarGlosa()` desde cero, en vez de confiar en los `identificadores` ya
 * calculados.
 *
 * El caso real que lo motivó (HANDOFF 158-159, `docs/diseno/18-cuit-pegado-sin-separador.md`):
 * `RE_CUIT` tenía un bug de `\b` corregido en `cb084a0` (2026-08-23); el lote de ROKA se ingirió
 * 2026-08-12, 11 días antes, y 569 de 1346 movimientos quedaron sin ningún candidato de contraparte.
 *
 * ## Sin DELETE — invariante deliberado de `movimiento_contraparte_identificador`
 *
 * `movimiento_contraparte_identificador` es append-only por diseño (`0013_contraparte_hmac_y_padron.sql`):
 * no tiene grant ni policy de DELETE para nadie. Este módulo SOLO agrega candidatos nuevos
 * (`INSERT ... ON CONFLICT DO NOTHING`, mismo patrón que `backfillearContraparteDeLote`) y actualiza
 * `contraparte_captura`. Si el cálculo puro encontrara un candidato que "debería" perder vigencia
 * (una clase que estaba persistida y el recálculo ya no reproduce), se REPORTA como conteo
 * (`candidatosQueDeberianRemoverse`) y NUNCA se escribe — decisión del panel (`dba-data` +
 * `security-engineer` + `seguridad-datos-financieros`, 2026-09-01): reabrir ese invariante es una
 * migración nueva y una convocatoria propia, fuera de esta tarea.
 *
 * ## La transacción, en DOS partes — mismo motivo que `backfill-contraparte.ts`
 *
 * Envolver la lectura N2-R y la escritura en una sola `conUsuario` es un bug real: un `ROLLBACK`
 * borra la fila de auditoría de la lectura, pero NO saca de la memoria del proceso los
 * identificadores que ya pasaron por ahí.
 *
 *   Tx1 (`leerInsumosDeReclasificacion`, comitea y NUNCA se revierte una vez que corrió):
 *     rol → ancla del lote → `leerConAuditoria` sobre `movimiento_origen_crudo`
 *     (`leerFilasOrigenDeLote`) → `avisarSiLasLecturasSonAnomalas` → `leerDigestsDeCuentasPropias` →
 *     el estado PERSISTIDO actual (`contraparte_captura` + `leerCandidatosDeContraparte`) → COMMIT.
 *   [fuera de Tx2: `calcularReclasificacion` — puro, sin más I/O]
 *   Tx2 (`reclasificarContraparteDeLote`): `for update` sobre `lote_ingesta` → rol DE NUEVO →
 *     `pepperObjetivo` capturado una vez → (si `aplicar`) `escribirConAuditoria` → UPDATE + INSERT →
 *     COMMIT.
 *
 * ## Un lote por corrida, siempre — mismo criterio que `backfill-contraparte.ts`
 */

import {
  conUsuario,
  escribirConAuditoria,
  leerCandidatosDeContraparte,
  leerConAuditoria,
  leerDigestsDeCuentasPropias,
  leerFilasOrigenDeLote,
  type FilaOrigen,
  type Tx,
} from '@sistema-contable/data';
import { avisarSiLasLecturasSonAnomalas } from '@sistema-contable/almacenamiento';
import { logger } from '@sistema-contable/shared/observabilidad';
import { pepperIdActual, type ClaseIdentificador } from '@sistema-contable/shared/seguridad';
import { extraerCandidatosDeContraparte, type CandidatoContraparte } from '../contraparte.ts';
import { depurarGlosa } from '../glosa.ts';
import { VERSION_DEL_EXTRACTOR } from '../version-extraccion.ts';

/** Más angosto que `ROLES_QUE_DESCARGAN` — constante PROPIA, no se reusa
 *  `ROLES_QUE_BACKFILLEAN` de `backfill-contraparte.ts`: son dos mecanismos distintos, aunque hoy
 *  tengan el mismo valor. Ampliarlo después es un cambio de una línea, sin migración. */
export const ROLES_QUE_RECLASIFICAN = ['socio'] as const;

export const MOTIVOS_ABORTO_RECLASIFICACION = [
  'lote_no_encontrado',
  'lote_no_reclasificable',
  'rol_insuficiente',
] as const;
export type MotivoAbortoReclasificacion = (typeof MOTIVOS_ABORTO_RECLASIFICACION)[number];

/** Mismos dos estados que `backfill-contraparte.ts`: un lote solo se reclasifica si ya se persistió
 *  algo (`con_errores` no dejó ninguna fila, `recibido` es un estado transitorio que no debería
 *  poder llegar acá). */
function esEstadoReclasificable(estado: string): boolean {
  return estado === 'procesado' || estado === 'procesado_con_observaciones';
}

// -----------------------------------------------------------------------------
// Tx1 — lectura auditada + estado persistido
// -----------------------------------------------------------------------------

/** Los cuatro valores del dominio de `movimiento_bancario_crudo.contraparte_captura`. */
export type CapturaDeContraparte = 'no_capturado' | 'sin_identificador' | 'capturado' | 'capturado_cuenta_propia';

export type InsumosDeReclasificacion = {
  readonly filasOrigen: readonly FilaOrigen[];
  readonly digestsPropios: readonly Buffer[];
  readonly capturaPersistidaPorMovimiento: ReadonlyMap<string, CapturaDeContraparte>;
  readonly clasesPersistidasPorMovimiento: ReadonlyMap<string, ReadonlySet<ClaseIdentificador>>;
};

export type ResultadoLecturaInsumosReclasificacion =
  | { readonly ok: true; readonly insumos: InsumosDeReclasificacion }
  | { readonly ok: false; readonly motivoCodigo: MotivoAbortoReclasificacion };

/**
 * Tx1 — lee los insumos N2-R del lote MÁS el estado persistido actual. Comitea antes de devolver:
 * si el llamador aborta después, el rastro de esta lectura queda igual.
 */
export async function leerInsumosDeReclasificacion(
  usuarioId: string,
  pedido: { readonly clienteId: string; readonly loteId: string },
): Promise<ResultadoLecturaInsumosReclasificacion> {
  return conUsuario(usuarioId, async (tx: Tx) => {
    const anclaFilas = await tx.consultar<{ estado: string }>(
      `select estado from lote_ingesta where id = $1 and cliente_id = $2`,
      [pedido.loteId, pedido.clienteId],
    );
    const ancla = anclaFilas[0];
    if (!ancla) return { ok: false as const, motivoCodigo: 'lote_no_encontrado' as const };
    if (!esEstadoReclasificable(ancla.estado)) {
      return { ok: false as const, motivoCodigo: 'lote_no_reclasificable' as const };
    }

    const rolFilas = await tx.consultar<{ puede: boolean }>(
      `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
      [pedido.clienteId, ROLES_QUE_RECLASIFICAN],
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
        motivo: `reclasificar_contraparte:v${VERSION_DEL_EXTRACTOR}`,
      },
      (ctx) => leerFilasOrigenDeLote(tx, ctx, { clienteId: pedido.clienteId, loteIngestaId: pedido.loteId }),
    );
    // Después de auditar: el contador tiene que incluir esta lectura.
    await avisarSiLasLecturasSonAnomalas(tx, pedido.clienteId);

    const digestsPropios = await leerDigestsDeCuentasPropias(tx, pedido.clienteId);

    // El estado PERSISTIDO actual — plano, N1/N2, mismo régimen que `leerEvidenciaDeMovimientos`:
    // no exige `ContextoAuditado`.
    const capturasFilas = await tx.consultar<{ id: string; contraparte_captura: string }>(
      `select id::text as id, contraparte_captura from movimiento_bancario_crudo
        where cliente_id = $1 and lote_ingesta_id = $2`,
      [pedido.clienteId, pedido.loteId],
    );
    const capturaPersistidaPorMovimiento = new Map<string, CapturaDeContraparte>(
      capturasFilas.map((f) => [f.id, f.contraparte_captura as CapturaDeContraparte]),
    );

    const movimientoIds = filasOrigen.map((f) => f.movimientoId);
    const candidatosPorMovimiento = await leerCandidatosDeContraparte(tx, {
      clienteId: pedido.clienteId,
      movimientoIds,
    });
    const clasesPersistidasPorMovimiento = new Map<string, ReadonlySet<ClaseIdentificador>>();
    for (const [movId, candidatos] of candidatosPorMovimiento) {
      clasesPersistidasPorMovimiento.set(movId, new Set(candidatos.map((c) => c.clase)));
    }

    return {
      ok: true as const,
      insumos: { filasOrigen, digestsPropios, capturaPersistidaPorMovimiento, clasesPersistidasPorMovimiento },
    };
  });
}

// -----------------------------------------------------------------------------
// Cálculo puro — fuera de transacción, sin más I/O
// -----------------------------------------------------------------------------

/** `fila_origen` es `unknown` — jsonb sin esquema en la base. Guard mínimo, nunca un cast ciego:
 *  una fila con otra forma se salta (contada aparte), nunca revienta el lote entero. */
function glosaOriginalDe(filaOrigen: unknown): string | undefined {
  const obj = filaOrigen as { glosaOriginal?: unknown } | null | undefined;
  return typeof obj?.glosaOriginal === 'string' ? obj.glosaOriginal : undefined;
}

export type ReporteDeReclasificacion = {
  readonly totalFilas: number;
  readonly leidasDeN2R: number;
  /** `fila_origen` sin `glosaOriginal` en forma de texto — no se puede recalcular, se salta. */
  readonly filasSinGlosaOriginal: number;
  /** `"<capturaPersistida>->|<capturaNueva>"`, p. ej. `"sin_identificador->capturado"`. */
  readonly porTransicionDeCaptura: Record<string, number>;
  readonly sinCambio: number;
  /** Pares (movimiento, clase) NUEVOS respecto de lo persistido — nunca cuenta HMAC ni glosa. */
  readonly candidatosNuevosPorClase: Record<string, number>;
  /**
   * Pares (movimiento, clase) que el cálculo puro YA NO reproduce pero siguen persistidos. Fuera de
   * alcance (sin DELETE, ver cabecera del archivo): se reporta, nunca se escribe.
   */
  readonly candidatosQueDeberianRemoverse: number;
  readonly descartadosPorForma: number;
};

type CambioDeReclasificacion = {
  readonly movimientoId: string;
  readonly capturaNueva: CapturaDeContraparte;
  readonly candidatos: readonly CandidatoContraparte[];
};

export type DiffDeReclasificacion = {
  readonly reporte: ReporteDeReclasificacion;
  /** Solo las filas con cambio real — lo que Tx2 tiene que escribir si `aplicar`. */
  readonly aEscribir: readonly CambioDeReclasificacion[];
};

/**
 * El cálculo puro: por cada fila, vuelve a correr `depurarGlosa()` + `extraerCandidatosDeContraparte()`
 * con el código ACTUAL sobre `glosaOriginal`, y compara contra lo persistido. Sin base, sin storage —
 * testeable sin Postgres.
 */
export function calcularReclasificacion(
  clienteId: string,
  insumos: InsumosDeReclasificacion,
): DiffDeReclasificacion {
  const porTransicionDeCaptura: Record<string, number> = {};
  const candidatosNuevosPorClase: Record<string, number> = {};
  let filasSinGlosaOriginal = 0;
  let sinCambio = 0;
  let candidatosQueDeberianRemoverse = 0;
  let descartadosPorForma = 0;
  const aEscribir: CambioDeReclasificacion[] = [];

  for (const fila of insumos.filasOrigen) {
    const glosaOriginal = glosaOriginalDe(fila.filaOrigen);
    if (glosaOriginal === undefined) {
      filasSinGlosaOriginal += 1;
      continue;
    }

    const glosa = depurarGlosa(glosaOriginal);
    const extraccion = extraerCandidatosDeContraparte(glosa.identificadores, clienteId, insumos.digestsPropios);
    descartadosPorForma += extraccion.descartadosPorForma;

    const capturaPersistida = insumos.capturaPersistidaPorMovimiento.get(fila.movimientoId) ?? 'no_capturado';
    const clasesPersistidas = insumos.clasesPersistidasPorMovimiento.get(fila.movimientoId) ?? new Set();
    const clasesNuevas = new Set(extraccion.candidatos.map((c) => c.clase));

    const clasesAAgregar = [...clasesNuevas].filter((c) => !clasesPersistidas.has(c));
    const clasesQueDeberianRemoverse = [...clasesPersistidas].filter((c) => !clasesNuevas.has(c));
    candidatosQueDeberianRemoverse += clasesQueDeberianRemoverse.length;

    const transicion = `${capturaPersistida}->${extraccion.captura}`;
    porTransicionDeCaptura[transicion] = (porTransicionDeCaptura[transicion] ?? 0) + 1;

    const cambioDeCaptura = capturaPersistida !== extraccion.captura;
    const hayClaseNueva = clasesAAgregar.length > 0;

    if (!cambioDeCaptura && !hayClaseNueva) {
      sinCambio += 1;
      continue;
    }

    for (const clase of clasesAAgregar) {
      candidatosNuevosPorClase[clase] = (candidatosNuevosPorClase[clase] ?? 0) + 1;
    }

    // Se escriben TODOS los candidatos recalculados de la fila, no solo los de clase nueva: el
    // `ON CONFLICT DO NOTHING` de Tx2 absorbe los que ya existían (mismo hmac, mismo pepper) — mismo
    // criterio que `backfillearContraparteDeLote`. Filtrar acá arriesgaría perder un candidato
    // genuinamente nuevo de una clase que ya tenía OTRO identificador persistido.
    aEscribir.push({
      movimientoId: fila.movimientoId,
      capturaNueva: extraccion.captura,
      candidatos: extraccion.candidatos,
    });
  }

  const reporte: ReporteDeReclasificacion = {
    totalFilas: insumos.capturaPersistidaPorMovimiento.size,
    leidasDeN2R: insumos.filasOrigen.length,
    filasSinGlosaOriginal,
    porTransicionDeCaptura,
    sinCambio,
    candidatosNuevosPorClase,
    candidatosQueDeberianRemoverse,
    descartadosPorForma,
  };

  return { reporte, aEscribir };
}

// -----------------------------------------------------------------------------
// Tx2 — lock + escritura auditada
// -----------------------------------------------------------------------------

export type PedidoReclasificacion = {
  readonly clienteId: string;
  readonly loteId: string;
  /** `false` = dry-run: calcula y reporta, nunca escribe. `true` = escribe si hay algo pendiente. */
  readonly aplicar: boolean;
};

export type ResultadoReclasificacion =
  | { readonly estado: 'ya_reclasificado'; readonly loteId: string }
  | { readonly estado: 'listo'; readonly reporte: ReporteDeReclasificacion }
  | { readonly estado: 'aplicado'; readonly reporte: ReporteDeReclasificacion; readonly filasActualizadas: number }
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoReclasificacion };

/**
 * Tx2 — recibe los insumos YA LEÍDOS y auditados por `leerInsumosDeReclasificacion`. Nunca abre su
 * propia lectura de N2-R.
 */
export async function reclasificarContraparteDeLote(
  tx: Tx,
  pedido: PedidoReclasificacion,
  insumos: InsumosDeReclasificacion,
): Promise<ResultadoReclasificacion> {
  // TOCTOU + serialización de dos corridas del operador: el ancla se bloquea acá.
  const anclaFilas = await tx.consultar<{ estado: string }>(
    `select estado from lote_ingesta where id = $1 and cliente_id = $2 for update`,
    [pedido.loteId, pedido.clienteId],
  );
  const ancla = anclaFilas[0];
  if (!ancla) return { estado: 'abortado', motivoCodigo: 'lote_no_encontrado' };
  if (!esEstadoReclasificable(ancla.estado)) {
    return { estado: 'abortado', motivoCodigo: 'lote_no_reclasificable' };
  }

  // Rol, DE NUEVO — la ventana entre Tx1 y Tx2 puede haber cambiado la membership.
  const rolFilas = await tx.consultar<{ puede: boolean }>(
    `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
    [pedido.clienteId, ROLES_QUE_RECLASIFICAN],
  );
  if (rolFilas[0]?.puede !== true) return { estado: 'abortado', motivoCodigo: 'rol_insuficiente' };

  // Capturado UNA vez al tope de Tx2: los candidatos ya traen su propio `pepperId` (calculado en
  // `calcularReclasificacion`, fuera de tx), y este valor viaja en el motivo de auditoría para que
  // el rastro diga con qué pepper se escribió, mismo criterio que `backfillearContraparteDeLote`.
  const pepperObjetivo = pepperIdActual();

  const { reporte, aEscribir } = calcularReclasificacion(pedido.clienteId, insumos);

  if (aEscribir.length === 0) {
    return { estado: 'ya_reclasificado', loteId: pedido.loteId };
  }

  if (!pedido.aplicar) {
    return { estado: 'listo', reporte };
  }

  return escribirConAuditoria(
    tx,
    {
      clienteId: pedido.clienteId,
      accion: 'escritura',
      recurso: 'movimiento_bancario_crudo',
      recursoId: pedido.loteId,
      motivo: `reclasificar_contraparte:v${VERSION_DEL_EXTRACTOR}:pepper-${pepperObjetivo}`,
    },
    async () => {
      const ids = aEscribir.map((f) => f.movimientoId);
      const capturas = aEscribir.map((f) => f.capturaNueva);

      const actualizadas = await tx.consultar<{ id: string }>(
        `update movimiento_bancario_crudo m
            set contraparte_captura = v.captura
           from unnest($1::uuid[], $2::text[]) as v(id, captura)
          where m.id = v.id
            and m.cliente_id = $3
            and m.lote_ingesta_id = $4
          returning m.id::text as id`,
        [ids, capturas, pedido.clienteId, pedido.loteId],
      );

      // Nunca `return` acá si esto no cierra: `conUsuario` comitea en cualquier return normal, y un
      // UPDATE ya emitido quedaría parcialmente escrito. `throw` fuerza el rollback de TODO.
      if (actualizadas.length !== aEscribir.length) {
        throw new Error(
          `reclasificar_contraparte: el UPDATE afectó ${actualizadas.length} de ${aEscribir.length} filas esperadas.`,
        );
      }

      // Sin DELETE — solo INSERT ... ON CONFLICT DO NOTHING. La tabla es append-only por diseño
      // (`0013_contraparte_hmac_y_padron.sql`); un candidato que "sobra" respecto del cálculo
      // actual queda reportado en `candidatosQueDeberianRemoverse`, nunca se borra acá.
      let candidatosInsertados = 0;
      for (const f of aEscribir) {
        for (const candidato of f.candidatos) {
          const insertado = await tx.consultar(
            `insert into movimiento_contraparte_identificador
               (cliente_id, movimiento_id, clase, identificador_hmac, pepper_id)
             values ($1, $2, $3, $4, $5)
             on conflict on constraint uq_mov_contraparte_candidato do nothing
             returning 1`,
            [pedido.clienteId, f.movimientoId, candidato.clase, candidato.hmac, candidato.pepperId],
          );
          candidatosInsertados += insertado.length;
        }
      }

      logger.info('reclasificar_contraparte.aplicado', {
        cliente_id: pedido.clienteId,
        lote_id: pedido.loteId,
        filas: actualizadas.length,
        candidatos: candidatosInsertados,
      });

      return { estado: 'aplicado' as const, reporte, filasActualizadas: actualizadas.length };
    },
  );
}
