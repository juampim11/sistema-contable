/**
 * LA CLAVE DEL OBJETO — la decisión más chica de este paquete y la que más cuesta revertir.
 *
 * Una clave mal elegida no se arregla con un deploy: hay que mover objetos. Y dos de las tres decisiones
 * de acá son de seguridad, no de organización.
 */

import { z } from 'zod';

/** Misma razón que en `conexion.ts`: forma de uuid, sin exigir versión ni variante RFC. */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(RE_UUID, 'no tiene forma de uuid');

export const PREFIJO_CLIENTE = 'cliente';

/** Lo que el módulo sabe guardar. Unión cerrada: una categoría nueva se agrega acá, no en el llamador. */
export const CATEGORIAS = ['extracto'] as const;
export type Categoria = (typeof CATEGORIAS)[number];

const esquemaClave = z.object({
  clienteId: uuid,
  categoria: z.enum(CATEGORIAS),
  /** El id del RECURSO (el lote), nunca el hash del contenido. Ver abajo. */
  recursoId: uuid,
  extension: z.enum(['pdf', 'xlsx', 'xls', 'csv']),
});

export type PedidoDeClave = z.infer<typeof esquemaClave>;

/**
 * Construye la clave. Es la **única** forma de armar una: no hay concatenación de strings en el resto del
 * paquete, así que las tres reglas de abajo no dependen de que alguien las recuerde.
 *
 * ## 1. El `cliente_id` va primero (ADR-0000 §3.3)
 *
 * `cliente/<uuid>/extracto/<...>` hace que el aislamiento sea **visible en el storage**, y habilita una
 * política de bucket por prefijo más adelante sin migrar un solo objeto. Con el cliente en el medio o al
 * final, esa política no se puede escribir.
 *
 * ## 2. El nombre es el id del LOTE, nunca el hash del contenido
 *
 * Una clave derivada del contenido convierte al storage en un **oráculo**: cualquiera con acceso de
 * lectura al bucket puede preguntar "¿tenés este archivo exacto?" calculando el hash de un archivo que ya
 * tiene, y la respuesta confirma que ese extracto pasó por el sistema — sin leer nada.
 *
 * ## 3. El nombre original del archivo NO entra
 *
 * Suele traer la razón social y el período (`Extracto_ACME_SRL_junio.pdf`). Una clave lo expone en los
 * logs de acceso del proveedor, en las URL firmadas y en cualquier listado. El nombre original tampoco se
 * guarda en `lote_ingesta`, que es N1 estricto por la misma razón.
 */
export function construirClave(pedido: PedidoDeClave): string {
  const p = esquemaClave.parse(pedido);
  return `${PREFIJO_CLIENTE}/${p.clienteId}/${p.categoria}/${p.recursoId}.${p.extension}`;
}

/**
 * Verifica que una clave pertenezca a un cliente. Es el chequeo que hace el emisor de URL firmada antes
 * de firmar: sin él, un `clienteId` correcto en la auditoría y una clave de otro cliente en la firma
 * producen un rastro que dice lo contrario de lo que pasó.
 */
export function claveEsDelCliente(clave: string, clienteId: string): boolean {
  const c = uuid.safeParse(clienteId);
  if (!c.success) return false;
  return clave.startsWith(`${PREFIJO_CLIENTE}/${c.data}/`);
}

/** El `cliente_id` que la clave declara, o `null` si la clave no tiene la forma canónica. */
export function clienteDeClave(clave: string): string | null {
  const partes = clave.split('/');
  if (partes.length < 4 || partes[0] !== PREFIJO_CLIENTE) return null;
  const posible = uuid.safeParse(partes[1]);
  return posible.success ? posible.data : null;
}
