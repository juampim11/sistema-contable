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
  CoberturaDocumento,
  CuentaRef,
  EvidenciaPendienteCierre,
  MotivoPendienteCierre,
  RolFuncionalCuenta,
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
            referencia_origen)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::date, $9)`,
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

/**
 * Centinela de idempotencia EXPLÍCITO antes de insertar — mismo patrón que
 * `backfillDocumentoIngerido`: `uq_pendiente_cierre_natural` es la red, no el mecanismo primario.
 * Reprocesar el mismo lote dos veces con el mismo resultado no debe duplicar la cola de revisión.
 */
export async function escribirPendienteDeImputacion(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoPendienteDeImputacion,
): Promise<ResultadoPendienteDeImputacion> {
  try {
    const insertado = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `insert into pendiente_cierre (cliente_id, cierre_id, referencia_origen, motivo_codigo, evidencia)
         values ($1, $2, $3, $4, $5::jsonb)
         returning id::text as id`,
        [pedido.clienteId, pedido.cierreId, pedido.movimientoId, pedido.motivoCodigo, JSON.stringify(pedido.evidencia)],
      ),
    );
    const id = insertado[0]?.id;
    if (!id) throw new Error('El alta de pendiente_cierre no devolvió id.'); // H-14
    return { estado: 'creado', pendienteCierreId: id };
  } catch (error) {
    if (error instanceof ErrorDeBase && error.constraint === 'uq_pendiente_cierre_natural') {
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
