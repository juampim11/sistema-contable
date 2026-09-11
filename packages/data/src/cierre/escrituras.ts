/**
 * ESCRITURAS de `cuenta`/`cuenta_atributo` (`0027_cierre_mensual.sql`) — primera vez que se llenan.
 * Alta del plan de cuentas de un cliente, DOS pasadas sin orden topológico (D-15/D-25, ratificado por
 * `plan-cuentas-multicliente` en la convocatoria de este adaptador):
 *
 *   1. Un `insert` por nodo en `cuenta` (identidad estable, sin jerarquía) — arma `codigo → cuenta.id`.
 *   2. Un `insert` por nodo en `cuenta_atributo`, resolviendo `cuentaPadreId` directo de ese mapa. El
 *      marcador de raíz (`cuentaPadreCodigo === null`) se trata ANTES del lookup, nunca pasa por el
 *      mapa — es el primer hueco que encontró `plan-cuentas-multicliente` en la convocatoria.
 *
 * Exige `ContextoAuditado` (mismo patrón que `contabilidad/escrituras.ts::altaDeSocio`): el caller
 * (CLI) abre la transacción con `escribirConAuditoria`, nunca esta función.
 */

import { logger } from '@sistema-contable/shared/observabilidad';
import type {
  CasoReprocesoAsiento,
  CoberturaDocumento,
  CuentaRef,
  EvidenciaPendienteCierre,
  MotivoPendienteCierre,
  MotivoReprocesoAsiento,
  RolFuncionalCuenta,
  TipoAsientoPropuesto,
  TipoDocumentoCierre,
} from './tipos.ts';
import type { ContextoAuditado } from '../db/auditoria.ts';
import type { Tx } from '../db/conexion.ts';
import { conErroresTraducidos, ErrorDeBase } from '../db/errores-pg.ts';

export type FilaAltaPlanCuentas = {
  readonly codigo: string;
  /** Tal cual el archivo — nunca modificada (R42 de este proyecto: el código es el identificador local, la denominación es presentación). */
  readonly denominacion: string;
  readonly nivel: number;
  /** `null` = raíz. Tiene que ser el `codigo` de OTRA fila de este mismo pedido. */
  readonly cuentaPadreCodigo: string | null;
  readonly rolFuncional: RolFuncionalCuenta;
  /** Obligatorio cuando `rolFuncional` liga a un socio puntual — la migración lo exige por CHECK. */
  readonly padronSocioId: string | null;
  readonly vigenteDesde: string;
  /** Quién autorizó + referencia al archivo/mapeo — nunca genérico para las filas de socio (D-16, convocatoria de este adaptador). */
  readonly respaldo: string;
};

export type PedidoAltaPlanCuentas = {
  readonly clienteId: string;
  readonly filas: readonly FilaAltaPlanCuentas[];
};

export type ResultadoAltaPlanCuentas = {
  readonly cuentasCreadas: number;
  readonly cuentaIdPorCodigo: ReadonlyMap<string, string>;
};

export class ErrorAltaPlanCuentas extends Error {
  readonly codigo: 'padre_no_encontrado_en_el_pedido';
  readonly codigoCuenta: string;
  constructor(codigo: 'padre_no_encontrado_en_el_pedido', codigoCuenta: string) {
    super(`plan-cuentas: ${codigo} (${codigoCuenta})`);
    this.codigo = codigo;
    this.codigoCuenta = codigoCuenta;
  }
}

export async function altaPlanDeCuentas(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoAltaPlanCuentas,
): Promise<ResultadoAltaPlanCuentas> {
  // Pasada 1 — identidad estable, sin jerarquía. Un insert por nodo, en el orden que venga.
  const cuentaIdPorCodigo = new Map<string, string>();
  for (const fila of pedido.filas) {
    const insertado = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `insert into cuenta (cliente_id) values ($1) returning id::text as id`,
        [pedido.clienteId],
      ),
    );
    const id = insertado[0]?.id;
    if (!id) throw new Error(`El alta de cuenta (${fila.codigo}) no devolvió id.`); // H-14
    cuentaIdPorCodigo.set(fila.codigo, id);
  }

  // Pasada 2 — atributos + jerarquía. Ya existen TODOS los cuenta.id, sin importar el orden.
  for (const fila of pedido.filas) {
    const cuentaId = cuentaIdPorCodigo.get(fila.codigo);
    if (!cuentaId) throw new Error(`Falta cuenta.id para ${fila.codigo} — no debería pasar tras la pasada 1.`);

    let cuentaPadreId: string | null = null;
    if (fila.cuentaPadreCodigo !== null) {
      const padreId = cuentaIdPorCodigo.get(fila.cuentaPadreCodigo);
      if (!padreId) throw new ErrorAltaPlanCuentas('padre_no_encontrado_en_el_pedido', fila.codigo);
      cuentaPadreId = padreId;
    }

    await conErroresTraducidos(undefined, () =>
      tx.consultar(
        `insert into cuenta_atributo
           (cliente_id, cuenta_id, codigo, denominacion, nivel, cuenta_padre_id, rol_funcional,
            padron_socio_id, vigente_desde, respaldo)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10)`,
        [
          pedido.clienteId,
          cuentaId,
          fila.codigo,
          fila.denominacion,
          fila.nivel,
          cuentaPadreId,
          fila.rolFuncional,
          fila.padronSocioId,
          fila.vigenteDesde,
          fila.respaldo,
        ],
      ),
    );
  }

  logger.info('plan_cuentas.alta', { cliente_id: pedido.clienteId, cuentas: pedido.filas.length });

  return { cuentasCreadas: pedido.filas.length, cuentaIdPorCodigo };
}

// -----------------------------------------------------------------------------
// Alta de `regla_imputacion` (`0030`, D-29 pata "contrapartida") — `cuenta_resolucion: 'fija'`
// ÚNICAMENTE (JP, 2026-09-10): las otras 3 resoluciones ('por_socio'/'por_jurisdiccion'/
// 'por_impuesto') necesitan su propio diseño y sign-off, fuera de alcance de esta alta.
// -----------------------------------------------------------------------------

export type PedidoAltaReglaImputacion = {
  readonly clienteId: string;
  readonly tipoMovimiento: string;
  /** `null` = regla general del tipo — el único caso que usa esta tarea (contador-dominio, doc 31
   *  Dictamen 4/5 §B: "el mismo caso" es el tipo entero, no un concepto puntual). */
  readonly concepto: string | null;
  /** YA resuelto por el caller (`leerPlanDeCuentasCompleto` + código real) — esta función nunca
   *  busca ni inventa una cuenta. */
  readonly cuentaId: string;
  readonly vigenteDesde: string;
  readonly respaldo: string;
  readonly decididoPor: string;
};

export type ResultadoAltaReglaImputacion = { readonly reglaImputacionId: string };

/** Traduce `uq_regla_imputacion_vigente` (`0030`) — este CLI es solo ALTA, nunca reemplazo; cerrar
 *  una vigencia abierta es un gesto aparte, fuera de esta función. */
export class YaExisteReglaVigenteError extends Error {
  constructor(tipoMovimiento: string, concepto: string | null) {
    super(
      `Ya existe una regla_imputacion vigente para (${tipoMovimiento}, ${concepto ?? 'sin concepto'}) — ` +
        `este alta es solo para reglas NUEVAS. Para reemplazar una vigente, hay que cerrarla primero.`,
    );
    this.name = 'YaExisteReglaVigenteError';
  }
}

export async function altaReglaImputacion(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoAltaReglaImputacion,
): Promise<ResultadoAltaReglaImputacion> {
  try {
    const insertado = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `insert into regla_imputacion
           (cliente_id, tipo_movimiento, concepto, cuenta_resolucion, cuenta_id, vigente_desde,
            respaldo, decidido_por)
         values ($1, $2, $3, 'fija', $4, $5::date, $6, $7)
         returning id::text as id`,
        [
          pedido.clienteId,
          pedido.tipoMovimiento,
          pedido.concepto,
          pedido.cuentaId,
          pedido.vigenteDesde,
          pedido.respaldo,
          pedido.decididoPor,
        ],
      ),
    );
    const id = insertado[0]?.id;
    if (!id) throw new Error('El alta de regla_imputacion no devolvió id.'); // H-14
    // `tipo_movimiento` es N2+ en el registro de clasificación (revela patrón de actividad del
    // cliente) — no viaja al log, mismo criterio que el resto del repo (R27).
    logger.info('regla_imputacion.alta', { cliente_id: pedido.clienteId });
    return { reglaImputacionId: id };
  } catch (error) {
    if (error instanceof ErrorDeBase && error.constraint === 'uq_regla_imputacion_vigente') {
      throw new YaExisteReglaVigenteError(pedido.tipoMovimiento, pedido.concepto);
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Backfill de `documento_ingerido` — 3 lotes reales de Capa 1 (Sesión 2a, `27-roadmap-capa-d.md`)
// -----------------------------------------------------------------------------

/**
 * Un lote YA INGERIDO y verificado (`lote_ingesta`/`lote_ingesta_cuenta`, `0004_ingesta.sql`),
 * resuelto por el CLI llamador — esta función no lee esas tablas, solo escribe. Mismo criterio que
 * `altaPlanDeCuentas`: recibe valores ya resueltos, no reabre la fuente.
 */
export type FilaBackfillDocumentoIngerido = {
  readonly clienteId: string;
  readonly tipoDocumento: TipoDocumentoCierre;
  readonly bancoCodigo: string;
  readonly periodoDesde: string;
  readonly periodoHasta: string;
  readonly cobertura: CoberturaDocumento;
  /** Clave de storage tal cual `lote_ingesta.archivo_clave` — nunca recalculada (condición de
   *  `security-engineer`, convocatoria de este backfill: si dos corridas la recomponen distinto, la
   *  unicidad natural deja de detectar el duplicado). */
  readonly objetoAlmacenamiento: string;
  /** Histórico (`lote_ingesta.created_at`), NUNCA `now()` — condición de `dba-data` y
   *  `seguridad-datos-financieros`: `now()` falsearía cuándo llegó el extracto real. */
  readonly ingeridoEn: string;
};

export type ResultadoBackfillDocumentoIngerido =
  | { readonly estado: 'ya_backfilleado'; readonly documentoIngeridoId: string }
  | { readonly estado: 'aplicado'; readonly documentoIngeridoId: string };

/**
 * Centinela de idempotencia EXPLÍCITO antes de insertar (condición de `security-engineer`): la
 * unicidad natural (`uq_documento_ingerido_natural`) es la red, no el mecanismo primario. Si de
 * todos modos choca (carrera entre dos corridas), se traduce a `'ya_backfilleado'` en vez de dejar
 * subir el `ErrorDeBase` — nunca `ON CONFLICT DO NOTHING`, que ocultaría el duplicado sin que el
 * llamador se entere de cuál de las dos rutas pasó.
 */
export async function backfillDocumentoIngerido(
  tx: Tx,
  _ctx: ContextoAuditado,
  fila: FilaBackfillDocumentoIngerido,
): Promise<ResultadoBackfillDocumentoIngerido> {
  const existente = await tx.consultar<{ id: string }>(
    `select id::text as id
       from documento_ingerido
      where cliente_id = $1 and tipo_documento = $2 and banco_codigo = $3
        and periodo_desde = $4::date and periodo_hasta = $5::date and objeto_almacenamiento = $6`,
    [fila.clienteId, fila.tipoDocumento, fila.bancoCodigo, fila.periodoDesde, fila.periodoHasta, fila.objetoAlmacenamiento],
  );
  const idExistente = existente[0]?.id;
  if (idExistente) {
    return { estado: 'ya_backfilleado', documentoIngeridoId: idExistente };
  }

  try {
    const insertado = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `insert into documento_ingerido
           (cliente_id, tipo_documento, banco_codigo, periodo_desde, periodo_hasta, cobertura,
            objeto_almacenamiento, ingerido_en)
         values ($1, $2, $3, $4::date, $5::date, $6, $7, $8::timestamptz)
         returning id::text as id`,
        [
          fila.clienteId,
          fila.tipoDocumento,
          fila.bancoCodigo,
          fila.periodoDesde,
          fila.periodoHasta,
          fila.cobertura,
          fila.objetoAlmacenamiento,
          fila.ingeridoEn,
        ],
      ),
    );
    const id = insertado[0]?.id;
    if (!id) throw new Error('El backfill de documento_ingerido no devolvió id.'); // H-14

    logger.info('documento_ingerido.backfill_aplicado', {
      cliente_id: fila.clienteId,
      tipo_documento: fila.tipoDocumento,
      banco_codigo: fila.bancoCodigo,
    });

    return { estado: 'aplicado', documentoIngeridoId: id };
  } catch (error) {
    if (error instanceof ErrorDeBase && error.constraint === 'uq_documento_ingerido_natural') {
      const carrera = await tx.consultar<{ id: string }>(
        `select id::text as id
           from documento_ingerido
          where cliente_id = $1 and tipo_documento = $2 and banco_codigo = $3
            and periodo_desde = $4::date and periodo_hasta = $5::date and objeto_almacenamiento = $6`,
        [fila.clienteId, fila.tipoDocumento, fila.bancoCodigo, fila.periodoDesde, fila.periodoHasta, fila.objetoAlmacenamiento],
      );
      const id = carrera[0]?.id;
      if (id) return { estado: 'ya_backfilleado', documentoIngeridoId: id };
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Escrituras del resolver de Capa D (`motor-conciliacion-contable`, Ítem E, paso 2)
// -----------------------------------------------------------------------------
//
// Reciben valores YA RESUELTOS por el servicio de I/O de `apps/` (que sí ve los paquetes de Capa
// B/C y de Capa D a la vez) — nunca un `Reconocimiento` ni un tipo de esos otros paquetes.
// `cierreId` se recibe como dato: NO existe hoy
// ningún código de producción que cree/encuentre un `cierre_cliente_periodo` (B.13,
// `docs/diseno/10-deuda-declarada.md`) — decisión explícita de JP de dejarlo fuera de esta tarea.

export type RenglonParaEscribir = {
  readonly cuentaId: string;
  readonly cuentaRef: CuentaRef;
  readonly lado: 'debe' | 'haber';
  readonly importe: string;
  /** Cita congelada, claves snake_case IDÉNTICAS a `asiento_renglon_verificacion_chk` (`0027`) — el
   *  servicio de I/O la copia tal cual del resolver de Capa D, sin remapear nada. `undefined`/
   *  ausente ⟹ se persiste `{}` (default de la columna) — mismo comportamiento de siempre para lo
   *  que no la usa. */
  readonly verificacionHeredada?: Readonly<{ estado: 'aproximada'; motivo: string }>;
};

export type PedidoAsientoAutomatico = {
  readonly clienteId: string;
  readonly cierreId: string;
  readonly fechaImputacion: string;
  /** Para trazabilidad — no es una FK, va en `referencia_origen` (mismo patrón que `pendiente_cierre`). */
  readonly movimientoId: string;
  /** [banco, contrapartida] — mismo orden que devuelve `resolverAsiento()`. */
  readonly renglones: readonly [RenglonParaEscribir, RenglonParaEscribir];
};

export type ResultadoAsientoAutomatico = { readonly asientoId: string };

/**
 * `tipo: 'devengamiento'` — es el reconocimiento inicial de un hecho económico a partir de un
 * movimiento bancario real, no una cancelación de algo ya devengado, ni un ajuste de cierre, ni una
 * reimputación de FCI (los otros 3 valores de `TIPOS_ASIENTO_PROPUESTO`).
 */
export async function escribirAsientoAutomatico(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoAsientoAutomatico,
): Promise<ResultadoAsientoAutomatico> {
  const asiento = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', $3::date)
       returning id::text as id`,
      [pedido.clienteId, pedido.cierreId, pedido.fechaImputacion],
    ),
  );
  const asientoId = asiento[0]?.id;
  if (!asientoId) throw new Error('El alta de asiento_propuesto no devolvió id.'); // H-14

  for (const [orden, renglon] of pedido.renglones.entries()) {
    await conErroresTraducidos(undefined, () =>
      tx.consultar(
        `insert into asiento_propuesto_renglon
           (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion,
            referencia_origen, verificacion_heredada)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::date, $9, $10::jsonb)`,
        [
          pedido.clienteId,
          asientoId,
          orden + 1,
          renglon.cuentaId,
          JSON.stringify(renglon.cuentaRef),
          renglon.lado === 'debe' ? renglon.importe : '0',
          renglon.lado === 'haber' ? renglon.importe : '0',
          pedido.fechaImputacion,
          pedido.movimientoId,
          JSON.stringify(renglon.verificacionHeredada ?? {}),
        ],
      ),
    );
  }

  logger.info('motor_conciliacion.asiento_automatico', {
    cliente_id: pedido.clienteId,
    cierre_id: pedido.cierreId,
    asiento_id: asientoId,
  });

  return { asientoId };
}

export type PedidoPendienteDeImputacion = {
  readonly clienteId: string;
  readonly cierreId: string;
  readonly movimientoId: string;
  readonly motivoCodigo: MotivoPendienteCierre;
  readonly evidencia: EvidenciaPendienteCierre;
};

export type ResultadoPendienteDeImputacion =
  | { readonly estado: 'ya_pendiente'; readonly pendienteCierreId: string }
  | { readonly estado: 'creado'; readonly pendienteCierreId: string };

const SAVEPOINT_PENDIENTE_DE_IMPUTACION = 'sp_pendiente_de_imputacion';

/**
 * Centinela de idempotencia EXPLÍCITO antes de insertar — mismo patrón que
 * `backfillDocumentoIngerido`: `uq_pendiente_cierre_natural` es la red, no el mecanismo primario.
 * Reprocesar el mismo lote dos veces con el mismo resultado no debe duplicar la cola de revisión.
 *
 * 🔴 **`SAVEPOINT` por llamada (fix de idempotencia de Capa D, 2026-09-09) — mismo idiom que
 * `persistirReconocimientos`/`SAVEPOINT_PERSISTIR_RECONOCIMIENTO`.** Sin esto, la "red" de arriba
 * nunca funcionó de verdad: un error de Postgres deja TODA la transacción abortada hasta el próximo
 * `ROLLBACK` — el `SELECT` de "carrera" del catch, que necesita seguir leyendo DESPUÉS del `INSERT`
 * fallido, moría con `25P02` antes de poder devolver `'ya_pendiente'`. Bug real, encontrado
 * corriendo el fix de idempotencia de Capa D contra el piloto real (LOCAL, con un solo movimiento
 * por test, nunca lo ejercitó — hacía falta un lote real con un `pendiente_cierre` `'abierto'`
 * preexistente). Es seguro reusar el mismo nombre en cada llamada: se libera (camino feliz) o se
 * hace `ROLLBACK TO` + se libera (camino de carrera) antes de retornar, así que no se acumulan
 * savepoints anidados a lo largo de un lote.
 */
export async function escribirPendienteDeImputacion(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoPendienteDeImputacion,
): Promise<ResultadoPendienteDeImputacion> {
  await tx.consultar(`savepoint ${SAVEPOINT_PENDIENTE_DE_IMPUTACION}`);
  try {
    const insertado = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `insert into pendiente_cierre (cliente_id, cierre_id, referencia_origen, motivo_codigo, evidencia)
         values ($1, $2, $3, $4, $5::jsonb)
         returning id::text as id`,
        [pedido.clienteId, pedido.cierreId, pedido.movimientoId, pedido.motivoCodigo, JSON.stringify(pedido.evidencia)],
      ),
    );
    await tx.consultar(`release savepoint ${SAVEPOINT_PENDIENTE_DE_IMPUTACION}`);
    const id = insertado[0]?.id;
    if (!id) throw new Error('El alta de pendiente_cierre no devolvió id.'); // H-14
    return { estado: 'creado', pendienteCierreId: id };
  } catch (error) {
    if (error instanceof ErrorDeBase && error.constraint === 'uq_pendiente_cierre_natural') {
      await tx.consultar(`rollback to savepoint ${SAVEPOINT_PENDIENTE_DE_IMPUTACION}`);
      await tx.consultar(`release savepoint ${SAVEPOINT_PENDIENTE_DE_IMPUTACION}`);
      const carrera = await tx.consultar<{ id: string }>(
        `select id::text as id
           from pendiente_cierre
          where cliente_id = $1 and cierre_id = $2 and fuente_cierre_id is null
            and referencia_origen = $3 and motivo_codigo = $4`,
        [pedido.clienteId, pedido.cierreId, pedido.movimientoId, pedido.motivoCodigo],
      );
      const id = carrera[0]?.id;
      if (id) return { estado: 'ya_pendiente', pendienteCierreId: id };
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Reconciliación manual — `confirmarAsiento` (`0040`, Mitad 1, Paso 2). Reusa la transición
// `asiento_propuesto_upd_confirmar` (`0027`) y el trigger de inmutabilidad post-terminal (`0028`):
// esta función no agrega NINGÚN mecanismo nuevo de base, solo el UPDATE que nadie invocaba todavía
// (el hallazgo que reencuadró toda la convocatoria: 1893/1893 asientos del piloto seguían
// `'propuesto'`). Es la precondición del reproceso Caso B — sin esto, ningún asiento llega nunca a
// `'confirmado'`.
// -----------------------------------------------------------------------------

export type PedidoConfirmarAsiento = {
  readonly clienteId: string;
  readonly asientoId: string;
};

export type ResultadoConfirmarAsiento =
  | { readonly estado: 'confirmado' }
  /**
   * 🔴 0 filas afectadas — el asiento no estaba `'propuesto'` (ya `'confirmado'`, ya `'superseded'`,
   * o el id no existe para este cliente). Mismo criterio que `reprocesarAsientoNoRevisado`: el
   * conflicto sube explícito, nunca `ON CONFLICT`. El trigger de `0028` refuerza esto mismo un nivel
   * más abajo — reconfirmar un asiento ya `'confirmado'` muere con `P0002`, nunca en silencio.
   */
  | { readonly estado: 'conflicto'; readonly motivoCodigo: 'asiento_no_estaba_propuesto' };

export async function confirmarAsiento(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoConfirmarAsiento,
): Promise<ResultadoConfirmarAsiento> {
  const confirmado = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `update asiento_propuesto
          set asiento_estado = 'confirmado'
        where cliente_id = $1 and id = $2 and asiento_estado = 'propuesto'
        returning id::text as id`,
      [pedido.clienteId, pedido.asientoId],
    ),
  );
  if (!confirmado[0]?.id) {
    return { estado: 'conflicto', motivoCodigo: 'asiento_no_estaba_propuesto' };
  }

  logger.info('reproceso_capa_d.confirmado', { cliente_id: pedido.clienteId, asiento_id: pedido.asientoId });

  return { estado: 'confirmado' };
}

// -----------------------------------------------------------------------------
// Reproceso de Capa D con supersesión (`0040`, Mitad 1) — dos escritores, uno por caso.
// `contador-dominio`: el discriminador es si la contadora YA REVISÓ/CONFIRMÓ el asiento
// (`asiento_estado`), no la causa del cambio. Ninguno de los dos toca el mecanismo de idempotencia
// de Capa B/C (`entrada_digest`) — son escrituras de aplicación explícitas, disparadas a mano por un
// operador vía CLI, nunca automáticas (CLAUDE.md §1.7, cerrado en contra por la convocatoria).
// -----------------------------------------------------------------------------

export type PedidoDeReprocesoAsiento = {
  readonly clienteId: string;
  readonly fechaImputacion: string;
  readonly renglones: readonly [RenglonParaEscribir, RenglonParaEscribir];
  readonly motivoCodigo: MotivoReprocesoAsiento;
  /**
   * Exigidas cuando `motivoCodigo === 'correccion_criterio_estudio'`; `null` las dos cuando es
   * `'dato_tardio_cliente'` (un documento tardío no reabre ninguna regla) — el CHECK de coherencia
   * de `0040` (`asiento_propuesto_reproceso_regla_chk`) lo fuerza también en la base; este tipo lo
   * deja como responsabilidad del caller, no lo valida acá (el 23514 de la base es la red final).
   */
  readonly reglaImputacionIdAnterior: string | null;
  readonly reglaImputacionIdNueva: string | null;
  /** N2 — prosa libre genuina (mismo tier que `cierre_transicion.motivo`). Ver el hallazgo H1
   *  (convocatoria `0030`, sin cerrar): puede terminar citando un CUIT o un nombre de tercero — la
   *  advertencia al operador antes de guardar es responsabilidad del CLI, no de este escritor. */
  readonly motivo: string;
  readonly hechoPor: string;
};

/**
 * Caso A — el asiento viejo sigue `asiento_estado = 'propuesto'` (nadie lo confirmó todavía).
 * Reusa `superseded_by_id`: el asiento nuevo va al MISMO `cierre_id` que el viejo (es la misma
 * propuesta, recalculada) — a diferencia de Caso B, acá no hay período distinto que imputar.
 */
export type PedidoReprocesarAsientoNoRevisado = PedidoDeReprocesoAsiento & {
  readonly asientoViejoId: string;
  readonly cierreId: string;
  readonly tipo: TipoAsientoPropuesto;
};

export type ResultadoReprocesarAsientoNoRevisado =
  | { readonly estado: 'reemplazado'; readonly asientoNuevoId: string; readonly reprocesoId: string }
  /**
   * 🔴 0 filas afectadas en el `UPDATE` de supersesión — el asiento viejo YA NO estaba `'propuesto'`
   * cuando se intentó reemplazarlo (alguien lo confirmó, o ya se reprocesó, entre que se listó y se
   * aplicó). Nunca se envuelve en un `ON CONFLICT`: el conflicto sube como estado explícito, mismo
   * criterio que `0029`/`0038` — un `0 filas` silencioso es exactamente el modo de falla que la
   * ceremonia "listar, confirmar, frenar" de `CLAUDE.md` §1.9 existe para evitar.
   */
  | { readonly estado: 'conflicto'; readonly motivoCodigo: 'asiento_ya_no_estaba_propuesto' };

const CASO_REEMPLAZO: CasoReprocesoAsiento = 'reemplazo_no_revisado';

export async function reprocesarAsientoNoRevisado(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoReprocesarAsientoNoRevisado,
): Promise<ResultadoReprocesarAsientoNoRevisado> {
  const nuevo = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, $3, $4::date)
       returning id::text as id`,
      [pedido.clienteId, pedido.cierreId, pedido.tipo, pedido.fechaImputacion],
    ),
  );
  const asientoNuevoId = nuevo[0]?.id;
  if (!asientoNuevoId) throw new Error('El alta del asiento de reemplazo no devolvió id.'); // H-14

  for (const [orden, renglon] of pedido.renglones.entries()) {
    await conErroresTraducidos(undefined, () =>
      tx.consultar(
        `insert into asiento_propuesto_renglon
           (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::date)`,
        [
          pedido.clienteId,
          asientoNuevoId,
          orden + 1,
          renglon.cuentaId,
          JSON.stringify(renglon.cuentaRef),
          renglon.lado === 'debe' ? renglon.importe : '0',
          renglon.lado === 'haber' ? renglon.importe : '0',
          pedido.fechaImputacion,
        ],
      ),
    );
  }

  // 🔴 `AND asiento_estado = 'propuesto'` — la red contra la carrera: si el asiento viejo ya no está
  // `propuesto` (alguien lo confirmó, o ya se superseó, entre el listado y esta corrida), 0 filas.
  const superseded = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `update asiento_propuesto
          set asiento_estado = 'superseded', superseded_by_id = $1
        where cliente_id = $2 and id = $3 and asiento_estado = 'propuesto'
        returning id::text as id`,
      [asientoNuevoId, pedido.clienteId, pedido.asientoViejoId],
    ),
  );
  if (!superseded[0]?.id) {
    return { estado: 'conflicto', motivoCodigo: 'asiento_ya_no_estaba_propuesto' };
  }

  const reproceso = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into asiento_propuesto_reproceso
         (cliente_id, asiento_id, asiento_nuevo_id, caso, reproceso_motivo_codigo, motivo,
          regla_imputacion_id_anterior, regla_imputacion_id_nueva, hecho_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id::text as id`,
      [
        pedido.clienteId,
        pedido.asientoViejoId,
        asientoNuevoId,
        CASO_REEMPLAZO,
        pedido.motivoCodigo,
        pedido.motivo,
        pedido.reglaImputacionIdAnterior,
        pedido.reglaImputacionIdNueva,
        pedido.hechoPor,
      ],
    ),
  );
  const reprocesoId = reproceso[0]?.id;
  if (!reprocesoId) throw new Error('El alta de asiento_propuesto_reproceso no devolvió id.'); // H-14

  logger.info('reproceso_capa_d.reemplazado', {
    cliente_id: pedido.clienteId,
    asiento_id: pedido.asientoViejoId,
    asiento_nuevo_id: asientoNuevoId,
  });

  return { estado: 'reemplazado', asientoNuevoId, reprocesoId };
}

/**
 * Caso B — el asiento original ya está `asiento_estado = 'confirmado'` (ya entregado). NUNCA se
 * toca: el ajuste es un `asiento_propuesto` nuevo, `tipo = 'ajuste_cierre'`, con `corrige_asiento_id`
 * apuntando al original. Va al `cierreIdActual` (el período ABIERTO en curso) — nunca al `cierre_id`
 * del original (ya terminal): es lo que hace que el trigger `exigir_cierre_no_terminal_al_
 * insertar_asiento` (`0040`) no choque con este mecanismo, ver el DDL.
 */
export type PedidoCorregirAsientoEntregado = PedidoDeReprocesoAsiento & {
  readonly asientoOriginalId: string;
  readonly cierreIdActual: string;
};

export type ResultadoCorregirAsientoEntregado = {
  readonly asientoAjusteId: string;
  readonly reprocesoId: string;
};

const CASO_AJUSTE: CasoReprocesoAsiento = 'ajuste_ya_entregado';

export async function corregirAsientoEntregado(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoCorregirAsientoEntregado,
): Promise<ResultadoCorregirAsientoEntregado> {
  const ajuste = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion, corrige_asiento_id)
       values ($1, $2, 'ajuste_cierre', $3::date, $4)
       returning id::text as id`,
      [pedido.clienteId, pedido.cierreIdActual, pedido.fechaImputacion, pedido.asientoOriginalId],
    ),
  );
  const asientoAjusteId = ajuste[0]?.id;
  if (!asientoAjusteId) throw new Error('El alta del asiento de ajuste no devolvió id.'); // H-14

  for (const [orden, renglon] of pedido.renglones.entries()) {
    await conErroresTraducidos(undefined, () =>
      tx.consultar(
        `insert into asiento_propuesto_renglon
           (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::date)`,
        [
          pedido.clienteId,
          asientoAjusteId,
          orden + 1,
          renglon.cuentaId,
          JSON.stringify(renglon.cuentaRef),
          renglon.lado === 'debe' ? renglon.importe : '0',
          renglon.lado === 'haber' ? renglon.importe : '0',
          pedido.fechaImputacion,
        ],
      ),
    );
  }

  // Sin gate de "0 filas": a diferencia de Caso A, el original NUNCA se toca — no hay carrera que
  // detectar acá (nada compite por escribir la MISMA fila).
  const reproceso = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into asiento_propuesto_reproceso
         (cliente_id, asiento_id, asiento_nuevo_id, caso, reproceso_motivo_codigo, motivo,
          regla_imputacion_id_anterior, regla_imputacion_id_nueva, hecho_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id::text as id`,
      [
        pedido.clienteId,
        pedido.asientoOriginalId,
        asientoAjusteId,
        CASO_AJUSTE,
        pedido.motivoCodigo,
        pedido.motivo,
        pedido.reglaImputacionIdAnterior,
        pedido.reglaImputacionIdNueva,
        pedido.hechoPor,
      ],
    ),
  );
  const reprocesoId = reproceso[0]?.id;
  if (!reprocesoId) throw new Error('El alta de asiento_propuesto_reproceso no devolvió id.'); // H-14

  logger.info('reproceso_capa_d.ajustado', {
    cliente_id: pedido.clienteId,
    asiento_id: pedido.asientoOriginalId,
    asiento_nuevo_id: asientoAjusteId,
  });

  return { asientoAjusteId, reprocesoId };
}
