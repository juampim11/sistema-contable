/**
 * LECTOR AUDITADO DE `credencial_fiscal`.
 *
 * Este archivo se declaraba en el registro de lectores desde la migración 0002 y **no existía**: el
 * registro guardaba una cadena de texto, así que el test pasaba igual. Existe ahora porque el registro
 * pasó a guardar la función.
 *
 * ## Lee metadatos, nunca el material
 *
 * `material_cifrado` está **fuera del grant de SELECT** de `app_request` (grant a nivel columna, migración
 * 0002): ni un `select *` mal armado lo alcanza — Postgres lo rechaza antes de evaluar la policy. El
 * material lo lee el proceso firmador, que no tiene ruta de entrada desde HTTP.
 *
 * Por eso este lector enumera sus columnas de forma explícita. No es estilo: un `select *` acá sería un
 * error en tiempo de ejecución en cuanto alguien le diera el grant, y la enumeración lo vuelve imposible.
 *
 * **Punto abierto declarado** (ADR-0002 §H.4): quién escribe `material_cifrado` la primera vez. Se
 * resuelve con el agente `integraciones-afip`, no acá.
 */

import type { ContextoAuditado } from './db/auditoria.ts';
import type { Tx } from './db/conexion.ts';

/**
 * El dominio cerrado de `credencial_fiscal.ambiente` (`credencial_fiscal_ambiente_chk`, migración `0002`).
 *
 * Estaba escrito como unión literal **dos veces en este mismo archivo** y en ningún lado como lista, así que
 * el test de catálogo de dominios cerrados no tenía contra qué comparar el check. Es la misma clase de
 * duplicación que `ESTADOS_LOTE` y `ORIGENES_LOTE`, y se cierra igual: una sola lista, y la base de árbitro.
 *
 * La distinción **no es cosmética**: firmar contra producción con una credencial de homologación —o al
 * revés— es un error que solo se ve cuando AFIP contesta.
 */
export const AMBIENTES_CREDENCIAL = ['homologacion', 'produccion'] as const;
export type AmbienteCredencial = (typeof AMBIENTES_CREDENCIAL)[number];

export type MetadatosCredencial = {
  readonly id: string;
  readonly servicio: string;
  readonly ambiente: AmbienteCredencial;
  readonly kekId: string;
  readonly alg: string;
  /** Huella del certificado PÚBLICO: identifica la credencial sin descifrar nada. */
  readonly fingerprintSha256: string;
  readonly venceEn: string | null;
  readonly rotadaEn: string | null;
};

export async function leerMetadatosCredencial(
  tx: Tx,
  _ctx: ContextoAuditado,
  args: { readonly clienteId: string },
): Promise<readonly MetadatosCredencial[]> {
  const filas = await tx.consultar<{
    id: string;
    servicio: string;
    ambiente: AmbienteCredencial;
    kek_id: string;
    alg: string;
    fingerprint_sha256: string;
    vence_en: string | null;
    rotada_en: string | null;
  }>(
    `select id, servicio, ambiente, kek_id, alg, fingerprint_sha256,
            vence_en::text as vence_en, rotada_en::text as rotada_en
       from credencial_fiscal
      where cliente_id = $1
      order by servicio, ambiente`,
    [args.clienteId],
  );

  return filas.map((f) => ({
    id: f.id,
    servicio: f.servicio,
    ambiente: f.ambiente,
    kekId: f.kek_id,
    alg: f.alg,
    fingerprintSha256: f.fingerprint_sha256,
    venceEn: f.vence_en,
    rotadaEn: f.rotada_en,
  }));
}
