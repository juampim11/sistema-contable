/**
 * LECTORES AUDITADOS DEL MÓDULO 2 — hoy, solo `padron_socio_documento` (migración 0013).
 *
 * Vive en `packages/data/src/contabilidad/` y no en `packages/data/src/ingesta/` porque es la
 * ubicación que el plan del Módulo 2 ya fijó (`packages/data/src/contabilidad/{lecturas,escrituras}.ts`),
 * anticipando el paquete `packages/contabilidad` que todavía no existe — capa C (resolución de
 * contrapartida) va a leer `padron_socio` (sin auditoría, N2 puro) a través de otra función; esta es
 * exclusivamente para el documento en claro (N2-R), que el motor NUNCA consulta.
 */

import type { ContextoAuditado } from '../db/auditoria.ts';
import type { Tx } from '../db/conexion.ts';

export type DocumentoDeSocio = {
  readonly socioId: string;
  /** El documento en claro, normalizado a dígitos. Es el dato N2-R por el que existe este lector. */
  readonly documento: string;
};

/**
 * El documento en claro de UN socio. Se pide por `socioId` y no "todos los del cliente" — mismo
 * criterio que `leerFilasOrigenDeLote`: el rastro de auditoría queda con un alcance acotado y
 * verificable, y "traeme todo el padrón en claro" es exactamente la forma de un lector que
 * registra un evento que no dice nada.
 */
export async function leerDocumentoDeSocio(
  tx: Tx,
  _ctx: ContextoAuditado,
  args: { readonly clienteId: string; readonly socioId: string },
): Promise<DocumentoDeSocio | undefined> {
  const filas = await tx.consultar<{ socio_id: string; documento: string }>(
    `select socio_id, documento
       from padron_socio_documento
      where cliente_id = $1 and socio_id = $2`,
    [args.clienteId, args.socioId],
  );
  const fila = filas[0];
  if (!fila) return undefined;
  return { socioId: fila.socio_id, documento: fila.documento };
}
