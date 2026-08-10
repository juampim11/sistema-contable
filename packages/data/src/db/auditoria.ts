/**
 * CHOKE POINT DE AUDITORÍA — ADR-0002 R32 y hallazgo H-8.
 *
 * "Quién vio o cambió el dato fiscal de un cliente, y cuándo" tiene que ser una pregunta
 * contestable. Sin esto, después de un incidente todo se cierra con "no sabemos" — y el paso 4 del
 * procedimiento de secreto filtrado (§E.4) queda sin respuesta posible.
 *
 * El diseño no es "acordate de auditar": es **estructural**. Leer una tabla que tiene columnas
 * ≥ N2R exige un `ContextoAuditado`, y el único lugar donde se fabrica uno es `leerConAuditoria()`,
 * que ya escribió la fila de auditoría. No se puede leer sin dejar rastro porque no hay una firma que
 * lo permita.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@sistema-contable/shared/observabilidad';
import type { Tx } from './conexion.ts';

/**
 * El dominio cerrado de acciones auditables. **Tiene que coincidir exactamente con el check constraint
 * `acceso_auditoria_accion_chk`** (migración 0004), y hay un test de catálogo que compara las dos listas.
 *
 * La primera versión del check omitía `uso_credencial`, que esta lista sí emite: todo registro de uso de
 * una credencial fiscal habría fallado en el insert. Se descubrió al escribirlo, no en producción, porque
 * las dos listas se compararon.
 *
 * `rechazo` existe porque un lote rechazado (INV-6: el extracto declarado para el cliente A cuya cuenta
 * resuelve al B) tiene que dejar rastro, y registrarlo como `escritura` sería asentar un hecho que no
 * ocurrió en la única tabla append-only del sistema.
 */
export const ACCIONES = [
  'lectura',
  'export',
  'descarga',
  'uso_credencial',
  'escritura',
  'borrado',
  'rechazo',
] as const;
export type AccionAuditada = (typeof ACCIONES)[number];

/** Acciones donde el motivo es obligatorio: sacar el dato del sistema. */
const EXIGEN_MOTIVO: ReadonlySet<AccionAuditada> = new Set([
  'export',
  'descarga',
  'uso_credencial',
  // Un borrado es irreversible y es humano (plan §7.3: sin borrado automático). Sin motivo escrito, el
  // rastro dice que alguien borró y no dice por qué, que es justo lo que se necesita saber después.
  'borrado',
]);

export type PedidoAuditado = {
  readonly clienteId: string;
  readonly accion: AccionAuditada;
  /** Nombre de la tabla u objeto. NUNCA su contenido. */
  readonly recurso: string;
  readonly recursoId?: string;
  readonly motivo?: string;
};

// Misma razón que en conexion.ts: forma de uuid, sin exigir versión ni variante RFC.
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidFlexible = z.string().regex(RE_UUID, 'no tiene forma de uuid');

const esquemaPedido = z.object({
  clienteId: uuidFlexible,
  accion: z.enum(ACCIONES),
  recurso: z.string().min(1).max(120),
  recursoId: uuidFlexible.optional(),
  motivo: z.string().min(3).max(500).optional(),
});

/**
 * Prueba de que la fila de auditoría ya se escribió. No se puede construir desde afuera del módulo
 * (el símbolo no se exporta), así que una función que lo pida en su firma solo puede ser llamada
 * desde dentro de `leerConAuditoria`.
 */
declare const marcaAuditado: unique symbol;
export type ContextoAuditado = {
  readonly [marcaAuditado]: true;
  readonly clienteId: string;
  readonly correlacion: string;
};

/**
 * Escribe la fila de auditoría. Devuelve el **id de correlación**, que genera esta función.
 *
 * NO usa `insert ... returning`: verificado contra Postgres 16, `RETURNING` aplica también la política
 * de **SELECT** a la fila devuelta, y en una tabla append-only quien escribe el rastro normalmente no
 * puede leerlo (la policy de lectura exige socio o auditor). El `RETURNING` fallaba con "new row
 * violates row-level security policy", un mensaje que hace pensar que el problema es la escritura.
 * Ver `migrations/0003_auditoria_correlacion.sql`.
 */
export async function registrarAcceso(tx: Tx, pedido: PedidoAuditado): Promise<string> {
  const p = esquemaPedido.parse(pedido);

  if (EXIGEN_MOTIVO.has(p.accion) && !p.motivo) {
    throw new Error(
      `La acción "${p.accion}" saca el dato del sistema y exige un motivo escrito (ADR-0002 R32).`,
    );
  }
  if (!tx.usuarioId) {
    throw new Error(
      'registrarAcceso() necesita una transacción con identidad (conUsuario). Un acceso sin ' +
        'usuario identificable no se puede auditar. Ver ADR-0002 R32.',
    );
  }

  const correlacion = randomUUID();

  await tx.consultar(
    `insert into acceso_auditoria
       (cliente_id, user_id, accion, recurso, recurso_id, motivo, correlacion)
     values ($1, app.current_user_id(), $2, $3, $4, $5, $6)`,
    [p.clienteId, p.accion, p.recurso, p.recursoId ?? null, p.motivo ?? null, correlacion],
  );

  logger.info('auditoria.registrada', {
    correlacion,
    cliente_id: p.clienteId,
    accion: p.accion,
    recurso: p.recurso,
    recurso_id: p.recursoId,
  });

  return correlacion;
}

/**
 * El choke point. Escribe la auditoría **antes** de ejecutar la lectura, y le pasa a `fn` el
 * `ContextoAuditado` que las lecturas de datos restringidos exigen.
 *
 * El orden importa: primero el rastro, después el dato. Si la lectura falla, queda registrado el
 * intento — que es información, no ruido.
 */
export async function leerConAuditoria<T>(
  tx: Tx,
  pedido: PedidoAuditado,
  fn: (ctx: ContextoAuditado) => Promise<T>,
): Promise<T> {
  const correlacion = await registrarAcceso(tx, pedido);
  const ctx = {
    clienteId: pedido.clienteId,
    correlacion,
  } as unknown as ContextoAuditado;
  return fn(ctx);
}

/**
 * ESCRIBIR CON AUDITORÍA — la simétrica de `leerConAuditoria`, y hacía falta.
 *
 * ## El agujero que cierra
 *
 * El control de **lectura** de datos restringidos es estructural: leer una tabla N2-R exige un
 * `ContextoAuditado`, y el único lugar donde se fabrica uno es `leerConAuditoria`. **No compila** sin haber
 * dejado rastro.
 *
 * Para **escritura** no había nada equivalente. `'escritura'` estaba en `ACCIONES` y en el check constraint,
 * y **no se emitía en ningún lugar del repo**: "el alta queda auditada" dependía de que quien escribiera el
 * script se acordara — precisamente el modo de falla que §C.0.bis declara inaceptable (*"el diseño no es
 * 'acordate de auditar': es estructural"*).
 *
 * Y la escritura que más lo necesita es la primera: el alta de `cuenta_bancaria_identificador` es **la fila
 * de la que cuelga toda la cadena de confianza de INV-6**. De ella depende que un extracto se asigne al
 * cliente correcto.
 *
 * ## Por qué el rastro se escribe ANTES, igual que en la lectura
 *
 * Si la escritura falla, queda registrado el intento — que es información. Al revés, una escritura hecha y
 * una auditoría que falló dejan un cambio sin rastro, que es el estado que este módulo entero existe para
 * que no pase.
 *
 * Las dos van en la **misma transacción**, así que un rollback se lleva las dos: no hay rastro de algo que
 * no ocurrió. (Para un efecto **no transaccional** —escribir un objeto al storage, emitir una URL firmada—
 * la regla es la opuesta: la auditoría se commitea **antes** del efecto, en su propia transacción.)
 */
export async function escribirConAuditoria<T>(
  tx: Tx,
  pedido: PedidoAuditado,
  fn: (ctx: ContextoAuditado) => Promise<T>,
): Promise<T> {
  if (pedido.accion !== 'escritura' && pedido.accion !== 'borrado') {
    throw new Error(
      `escribirConAuditoria espera accion 'escritura' o 'borrado', recibió '${pedido.accion}'. ` +
        'Una lectura va por leerConAuditoria: si las dos aceptaran cualquier acción, el rastro dejaría de ' +
        'distinguir quién miró de quién cambió.',
    );
  }

  const correlacion = await registrarAcceso(tx, pedido);
  const ctx = { clienteId: pedido.clienteId, correlacion } as unknown as ContextoAuditado;
  return fn(ctx);
}

// El registro vive en `lectores-auditados.ts` y guarda la REFERENCIA a la función, no su nombre en un
// string. El motivo: la versión que vivía acá declaraba `credencial_fiscal:
// 'leerMetadatosCredencial (packages/data/src/credenciales.ts)'` y **ese archivo no existía**. El test
// pasaba igual, porque verificaba que la tabla tuviera entrada, no que el lector existiera.
//
// Está en otro archivo porque el registro tiene que importar los lectores, y los lectores importan
// `ContextoAuditado` de acá: juntos serían un ciclo.
