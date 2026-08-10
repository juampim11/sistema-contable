/**
 * LOS LECTORES AUDITADOS DEL MÓDULO 1.
 *
 * Las dos tablas N2R de `0004_ingesta.sql` —`cuenta_bancaria_identificador` y
 * `movimiento_origen_crudo`— solo se leen por acá. No es una convención: la firma **exige** un
 * `ContextoAuditado`, que no se puede construir desde afuera de `auditoria.ts` (lleva un símbolo no
 * exportado). El único modo de obtener uno es haber pasado por `leerConAuditoria`, que escribe el rastro
 * **antes** de la lectura.
 *
 * ## Por qué estas dos tablas y no las otras
 *
 * `movimiento_bancario_crudo` es donde trabaja el contador y se lee sin auditar por fila: auditar 326
 * filas por pantalla no es un control, es el ruido que **destruye** la capacidad de detectar el acceso
 * masivo real (ADR-0002 H-8). El dato que obligaría a auditar —la fila cruda con los CUIT de las
 * contrapartes— vive en la satélite, y esa sí pasa por acá.
 */

import type { ContextoAuditado } from '../db/auditoria.ts';
import type { Tx } from '../db/conexion.ts';

export type IdentificadorDeCuenta = {
  readonly id: string;
  readonly cuentaBancariaId: string;
  readonly tipoCuenta: string;
  /** El número completo. Es el dato N2R por el que existe este lector. */
  readonly numero: string;
  readonly cbuUltimos4: string | null;
  readonly vigenteDesde: string;
  readonly vigenteHasta: string | null;
};

/**
 * Identificadores de una cuenta **vigentes a una fecha**.
 *
 * La fecha no es un adorno: un extracto de hace ocho meses tiene que resolver con el identificador
 * vigente **entonces**, no con el actual. Un CBU y un número de cuenta cambian, y leer el vigente hoy
 * para interpretar un documento viejo produce un match incorrecto que además parece correcto.
 */
export async function leerIdentificadoresDeCuenta(
  tx: Tx,
  _ctx: ContextoAuditado,
  args: { readonly clienteId: string; readonly cuentaBancariaId: string; readonly alFecha: string },
): Promise<readonly IdentificadorDeCuenta[]> {
  const filas = await tx.consultar<{
    id: string;
    cuenta_bancaria_id: string;
    tipo_cuenta: string;
    numero: string;
    cbu_ultimos4: string | null;
    vigente_desde: string;
    vigente_hasta: string | null;
  }>(
    `select id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_ultimos4,
            vigente_desde::text as vigente_desde, vigente_hasta::text as vigente_hasta
       from cuenta_bancaria_identificador
      where cliente_id = $1
        and cuenta_bancaria_id = $2
        and vigente_desde <= $3::date
        and (vigente_hasta is null or vigente_hasta >= $3::date)
      order by vigente_desde desc`,
    [args.clienteId, args.cuentaBancariaId, args.alFecha],
  );

  return filas.map((f) => ({
    id: f.id,
    cuentaBancariaId: f.cuenta_bancaria_id,
    tipoCuenta: f.tipo_cuenta,
    numero: f.numero,
    cbuUltimos4: f.cbu_ultimos4,
    vigenteDesde: f.vigente_desde,
    vigenteHasta: f.vigente_hasta,
  }));
}

export type FilaOrigen = {
  readonly movimientoId: string;
  readonly filaOrigen: unknown;
};

/**
 * Filas crudas de un lote, tal como vinieron del archivo.
 *
 * Se pide **por lote** y no "todas las del cliente" a propósito: el rastro de auditoría queda con un
 * alcance acotado y verificable. Un lector que acepte "traeme todo" registra un evento que no dice nada.
 */
export async function leerFilasOrigenDeLote(
  tx: Tx,
  _ctx: ContextoAuditado,
  args: { readonly clienteId: string; readonly loteIngestaId: string },
): Promise<readonly FilaOrigen[]> {
  const filas = await tx.consultar<{ movimiento_id: string; fila_origen: unknown }>(
    `select o.movimiento_id, o.fila_origen
       from movimiento_origen_crudo o
       join movimiento_bancario_crudo m
         on m.cliente_id = o.cliente_id and m.id = o.movimiento_id
      where o.cliente_id = $1 and m.lote_ingesta_id = $2
      order by m.fila_numero`,
    [args.clienteId, args.loteIngestaId],
  );

  return filas.map((f) => ({ movimientoId: f.movimiento_id, filaOrigen: f.fila_origen }));
}
