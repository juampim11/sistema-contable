/**
 * ESCRITURAS SOBRE EL ÁRBOL DE TENANCÍA — ADR-0001, HANDOFF 2026-08-11 (26)/(27).
 *
 * Hoy el único alta que vive acá es la de un `cliente` colgando de un `estudio` existente
 * (`apps/cli/src/alta-cliente.ts`). No hay ningún alta de `tenant_node` fuera de la siembra de tests
 * (`packages/data/tests/ayuda.ts`, que bypassa RLS a propósito con `conJob('siembra_sintetica', ...)`).
 *
 * ## Por qué esto NO usa `escribirConAuditoria`
 *
 * `escribirConAuditoria` (`../db/auditoria.ts`) exige que el `cliente_id` a auditar exista **antes** de
 * la operación: la tabla `acceso_auditoria` tiene el trigger `exigir_nodo_cliente`
 * (migración `0001_tenancy.sql`), que rechaza cualquier fila cuyo `cliente_id` no sea ya un
 * `tenant_node` activo de tipo `cliente`. Acá el sujeto de la auditoría es la fila que la propia
 * operación crea — no existe antes.
 *
 * La resolución (`arquitecto-software`, con `security-engineer`/`dba-data` de acuerdo, HANDOFF (27)
 * punto 2): el insert va primero, y la auditoría se registra **después**, en la misma transacción, con
 * `registrarAcceso` directo — el uuid recién devuelto por el `insert` ya sirve como `cliente_id` para
 * el trigger. Es la única escritura del repo donde el orden "auditoría antes que dato" se invierte, y
 * es a propósito: en cualquier otro alta (p. ej. `altaDeCuentaBancaria` en `../ingesta/escrituras.ts`)
 * el `cliente_id` YA existe, así que ahí sí corresponde auditar antes.
 *
 * Las dos operaciones (insert + `registrarAcceso`) van en la misma transacción (`tx`), así que un
 * rollback se lleva las dos: no puede quedar un `tenant_node` sin su fila de auditoría.
 */

import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/conexion.ts';
import { registrarAcceso } from '../db/auditoria.ts';
import { conErroresTraducidos } from '../db/errores-pg.ts';

/**
 * El dominio cerrado de motivos por los que puede fallar el guard de `estudioId`. **Nunca** se arma un
 * mensaje con el uuid recibido: el código alcanza para depurar (el uuid del registro ya sale del error
 * de Postgres si hiciera falta ir más profundo, nunca de un string armado a mano acá).
 */
export type CodigoErrorTenancy =
  | 'estudio_no_encontrado'
  | 'estudio_no_es_estudio'
  | 'estudio_borrado';

export class ErrorDeTenancy extends Error {
  // Declarada y asignada a mano, no como parameter property: el type-stripping de Node no las soporta
  // (mismo motivo documentado en `ErrorDeBase`/`ErrorDeAdaptador`).
  readonly codigo: CodigoErrorTenancy;

  constructor(codigo: CodigoErrorTenancy) {
    super(`Tenancy: ${codigo}`);
    this.name = 'ErrorDeTenancy';
    this.codigo = codigo;
  }
}

export type PedidoDeAltaDeCliente = {
  readonly estudioId: string;
  /** Etiqueta provisoria, NUNCA la razón social ni un CUIT (ver el guard de Zod en el CLI). */
  readonly nombre: string;
};

export type ResultadoAltaDeCliente = {
  readonly clienteId: string;
};

/**
 * Da de alta un `tenant_node` de tipo `cliente`, colgado de un `estudio` existente.
 *
 * ## El guard de `estudioId`, y por qué es de aplicación y no de esquema
 *
 * Nada en el `check` de `tenant_node` (migración `0001`) impide que un `cliente` cuelgue de otro
 * `cliente`: el `check` solo exige que el padre no sea null cuando `tipo <> 'estudio'`. Hallazgo de
 * `seguridad-datos-financieros`, confirmado por `security-engineer` y `dba-data` (HANDOFF (27) punto
 * 3). Cerrarlo de raíz en el esquema (un trigger que valide el tipo del padre para cualquier vía de
 * inserción futura, no solo esta función) queda como deuda declarada
 * (`docs/diseno/10-deuda-declarada.md` §1.7) — fuera del alcance de esta tarea. Acá se cierra el único
 * camino de alta que existe hoy: se verifica ANTES del insert, para no crear el nodo si el guard falla.
 *
 * La consulta del guard corre bajo RLS (la misma `tx` que el resto): si quien invoca no tiene acceso al
 * `estudioId`, la política de `select` ya se lo oculta y el guard ve "no encontrado" — indistinguible,
 * a propósito, de que el uuid no exista. Ninguno de los dos casos revela si el nodo existe para un
 * tenant ajeno.
 *
 * `nombre` NO es clave de dominio (HANDOFF entrada 11: es la etiqueta provisoria que se renombra sin
 * tocar la fila) — no lleva unicidad. Dos altas con el mismo nombre producen dos `cliente` distintos, a
 * propósito.
 */
export async function altaDeClienteEnEstudio(
  tx: Tx,
  pedido: PedidoDeAltaDeCliente,
): Promise<ResultadoAltaDeCliente> {
  const padres = await tx.consultar<{ tipo: string; deleted_at: string | null }>(
    `select tipo, deleted_at from tenant_node where id = $1`,
    [pedido.estudioId],
  );
  const padre = padres[0];
  if (!padre) throw new ErrorDeTenancy('estudio_no_encontrado');
  if (padre.tipo !== 'estudio') throw new ErrorDeTenancy('estudio_no_es_estudio');
  if (padre.deleted_at !== null) throw new ErrorDeTenancy('estudio_borrado');

  /**
   * 🔴 SIN `returning`, a propósito — y no por el mismo motivo que `registrarAcceso`.
   *
   * Medido en vivo (no en teoría): `insert ... returning id::text as id` sobre `tenant_node`, con el
   * socio dueño del `estudio` padre (que SÍ tiene `select` sobre el nodo nuevo, verificado aparte con
   * una consulta posterior en la misma transacción), **rechaza con "new row violates row-level
   * security policy"**. Sin `returning`, el mismo insert entra sin problema, y una `select` posterior
   * ve la fila sin inconveniente — es la re-evaluación de la policy de SELECT contra la fila recién
   * insertada, **dentro del mismo statement**, la que falla, no el acceso en sí. Misma familia de
   * bug que ya está documentada en `registrarAcceso` (`../db/auditoria.ts`) para `acceso_auditoria`,
   * aunque ahí el motivo es otro (el escritor no tiene SELECT sobre esa tabla); acá el escritor sí
   * tiene SELECT y falla igual, así que el mecanismo es más general de lo que ese comentario cubre.
   *
   * La salida es la misma que ya eligió esta base de código para el caso hermano: generar el uuid del
   * lado de la aplicación, insertarlo explícito, y no depender de `returning` para conocerlo. Causa raíz
   * confirmada en Postgres real (no solo por lectura de la documentación) y documentada como deuda de
   * fondo, no solo parche puntual: `docs/diseno/10-deuda-declarada.md` §1.3, addendum del 2026-08-11.
   */
  const clienteId = randomUUID();
  await conErroresTraducidos(undefined, () =>
    tx.consultar(
      `insert into tenant_node (id, tipo, nombre, parent_id)
       values ($1, 'cliente', $2, $3)`,
      [clienteId, pedido.nombre, pedido.estudioId],
    ),
  );

  // Auditoría DESPUÉS del insert, a propósito: ver el comentario de cabecera de este archivo. El
  // `cliente_id` que se audita es el que la línea de arriba acaba de crear.
  await registrarAcceso(tx, {
    clienteId,
    accion: 'escritura',
    recurso: 'tenant_node',
    recursoId: clienteId,
    motivo: 'alta_cliente',
  });

  return { clienteId };
}
