/**
 * LECTURAS SOBRE EL ÁRBOL DE TENANCÍA — primera consumidora real: Pantalla 1 del wizard (PR4, "elegir
 * cliente"). No existía ninguna lectura acá todavía (`escrituras.ts` es la única hermana).
 *
 * `nombre` es N2 (`clasificacion-campos.ts`) pero no N2-R/N3 — no pasa por `leerConAuditoria` (mismo
 * criterio que ADR-0006 §5/§6 ya usa para toda la vista de solo lectura de la Tanda 4: v1 funciona
 * completa sin tocar ninguna columna N2-R). Dictamen de `seguridad-datos-financieros` (convocatoria
 * PR4, Pantalla 1): confirmado, no hace falta el choke point acá.
 *
 * 🔴 El predicado `and id in (select app.accessible_tenant_ids())` de abajo NO es redundante con la
 * RLS, aunque `Tx` no distinga en su tipo si viene de `conUsuario()` o de `conJob()` (mismo hallazgo,
 * misma convocatoria): bajo `conUsuario`/`app_web`, la policy `tenant_node_sel` ya filtra igual y este
 * predicado es un no-op. Pero `app_job` tiene `BYPASSRLS` (`0001_tenancy.sql`) y SÍ tiene `grant select`
 * sobre `tenant_node` (para `alta_estudio`/`reparentar_nodo`/`siembra_sintetica`) — si esta función
 * alguna vez se llamara bajo `conJob(...)` (nada en la firma de `Tx` lo impide hoy), sin este predicado
 * devolvería TODOS los clientes de TODOS los estudios de la base, cruzando tenants. Con el predicado,
 * `app.current_user_id()` es `null` bajo `conJob` (sin usuario seteado) y `accessible_tenant_ids()` da
 * vacío — falla cerrado en vez de exponer la base entera.
 */

import type { Tx } from '../db/conexion.ts';

export type ClienteAccesible = {
  readonly id: string;
  readonly nombre: string;
};

type FilaClienteAccesible = {
  readonly id: string;
  readonly nombre: string;
};

export async function leerClientesAccesibles(tx: Tx): Promise<readonly ClienteAccesible[]> {
  const filas = await tx.consultar<FilaClienteAccesible>(
    `select id::text as id, nombre
       from tenant_node
      where tipo = 'cliente' and deleted_at is null
        and id in (select app.accessible_tenant_ids())
      order by nombre`,
  );
  return filas.map((f) => ({ id: f.id, nombre: f.nombre }));
}
