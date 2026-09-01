/**
 * DETECCIÓN DE LOTES DESACTUALIZADOS — SOLO LECTURA, CROSS-TENANT.
 *
 * Encuentra, sin investigación manual por cliente, qué lotes de ingesta tienen movimientos cuya
 * `fila_origen.versionExtractor` (`packages/ingesta/src/persistir.ts`) quedó atrás de
 * `VERSION_DEL_EXTRACTOR` — o no existe, porque el lote se ingirió ANTES de que ese campo existiera.
 * Es el mismo caso real que motivó todo este mecanismo (HANDOFF 158-159): `RE_CUIT` tenía el bug de
 * `\b` corregido en `cb084a0`, y sin este script encontrar qué otros lotes del piloto se ingirieron
 * antes del fix hubiera sido, de nuevo, revisar cliente por cliente a mano.
 *
 * ## `conJob('auditoria_seguridad_readonly')` — mismo motivo angosto que `0023`
 *
 * Cross-tenant y de solo lectura: ningún motivo de `conUsuario()` puede cruzar clientes, y ningún
 * otro motivo de `MotivoJob` tiene grant sobre estas columnas. El grant de la migración `0035`
 * amplía el de `0023` (`movimiento_origen_crudo.fila_origen`, `movimiento_bancario_crudo.cliente_id`)
 * con lo que hacía falta para agrupar por lote: `movimiento_bancario_crudo.lote_ingesta_id` y
 * `lote_ingesta(id, cliente_id, banco_codigo, estado, created_at)`. `set transaction read only`
 * (que `conJob` fija ANTES de correr `fn` para este motivo) rechaza cualquier DML con `25006` —
 * este módulo nunca intenta escribir.
 *
 * ## Qué proyecta, y qué NUNCA proyecta
 *
 * Solo `clienteId`/`loteId`/`bancoCodigo`/`estado`/el conteo de movimientos desactualizados. NUNCA
 * `fila_origen` completo, nunca `select *`, nunca la glosa ni un identificador — el diagnóstico
 * necesita saber QUÉ lotes reclasificar, no leer el contenido de ninguno.
 */

import { conJob, registrarUsoSoloLectura } from '@sistema-contable/data';
import { VERSION_DEL_EXTRACTOR } from '../version-extraccion.ts';

export type LoteDesactualizado = {
  readonly clienteId: string;
  readonly loteId: string;
  readonly bancoCodigo: string;
  readonly estado: string;
  readonly createdAt: string;
  readonly movimientosDesactualizados: number;
};

/**
 * `(fila_origen->>'versionExtractor') is null` cubre los dos casos de "desactualizado": el lote
 * nunca tuvo el campo (ingerido antes de esta tarea) o lo tiene con una versión anterior a la
 * vigente. `->>'clave'` sobre una columna JSON YA otorgada por columna no exige un grant aparte —
 * mismo criterio que el comentario de `0023` sobre `fila_origen`.
 */
export async function detectarLotesDesactualizados(): Promise<readonly LoteDesactualizado[]> {
  const filas = await conJob('auditoria_seguridad_readonly', async (tx) =>
    tx.consultar<{
      cliente_id: string;
      lote_id: string;
      banco_codigo: string;
      estado: string;
      created_at: string;
      movimientos_desactualizados: string;
    }>(
      `select o.cliente_id::text as cliente_id,
              m.lote_ingesta_id::text as lote_id,
              l.banco_codigo,
              l.estado,
              l.created_at::text as created_at,
              count(*)::text as movimientos_desactualizados
         from movimiento_origen_crudo o
         join movimiento_bancario_crudo m
           on m.cliente_id = o.cliente_id and m.id = o.movimiento_id
         join lote_ingesta l
           on l.cliente_id = m.cliente_id and l.id = m.lote_ingesta_id
        where (o.fila_origen ->> 'versionExtractor') is null
           or (o.fila_origen ->> 'versionExtractor')::int < $1
        group by o.cliente_id, m.lote_ingesta_id, l.banco_codigo, l.estado, l.created_at
        order by l.created_at`,
      [VERSION_DEL_EXTRACTOR],
    ),
  );

  const resultado: readonly LoteDesactualizado[] = filas.map((f) => ({
    clienteId: f.cliente_id,
    loteId: f.lote_id,
    bancoCodigo: f.banco_codigo,
    estado: f.estado,
    createdAt: f.created_at,
    movimientosDesactualizados: Number(f.movimientos_desactualizados),
  }));

  registrarUsoSoloLectura({
    motivoJob: 'auditoria_seguridad_readonly',
    clienteIds: [...new Set(resultado.map((r) => r.clienteId))],
    filasLeidas: resultado.reduce((acc, r) => acc + r.movimientosDesactualizados, 0),
    detalle: `detectar_lotes_desact:v${VERSION_DEL_EXTRACTOR}`,
  });

  return resultado;
}
