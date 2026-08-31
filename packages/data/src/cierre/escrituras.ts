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
import type { CoberturaDocumento, RolFuncionalCuenta, TipoDocumentoCierre } from './tipos.ts';
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
