/**
 * CHOKE POINT DE LECTURA — el segundo (y por ahora único otro) camino de salida de un objeto de cliente,
 * hermano de `emitirUrlDeDescarga` (`descarga.ts`). Plan `adaptive-herding-pillow`.
 *
 * `emitirUrlDeDescarga` entrega una CAPACIDAD (una URL de vida corta); esta función entrega los BYTES
 * completos a la memoria del proceso servidor — es más, no menos, así que el control no puede ser más
 * laxo. Hasta esta tarea, `storage.obtener()` no lo llamaba nadie en producción (grep del repo: el único
 * caller era un test).
 *
 * Los mismos cinco pasos de `descarga.ts`, con un orden distinto en un punto — y el motivo es real:
 *
 *   1. la clave tiene que ser del cliente que se declara;
 *   2. el ROL se verifica contra la base, con la lista de roles que decide el llamador (nunca
 *      hardcodeada acá: la corrida de `recapturar-conceptos` la restringe a `['socio']`, más estricto
 *      que `ROLES_QUE_DESCARGAN`);
 *   3. se audita con `accion:'descarga'` (la misma acción que cuenta `avisarSiElVolumenEsAnomalo` — si
 *      esto auditara `'lectura'`, el detector de H-8 quedaría ciego en este camino) y **se comitea**;
 *   4. RECIÉN AHÍ, fuera de toda transacción, `storage.obtener()` trae los bytes;
 *   5. se verifica la integridad contra el hash esperado — si no coincide, se audita un `'rechazo'` en su
 *      propia transacción y los bytes NUNCA se devuelven al llamador.
 *
 * El punto 3 pasa a estar ANTES del efecto no transaccional (el `GET` de storage), no adentro de la misma
 * transacción como hace `descarga.ts` con `urlFirmada` (ahí no hace falta: firmar una URL no es una
 * llamada de red al proveedor de storage). Acá sí: `packages/data/src/db/auditoria.ts` ya enuncia la
 * regla ("para un efecto no transaccional la auditoría se commitea antes, en su propia transacción") y
 * esta es la primera función del repo que la cumple — los dos callers reales del guardado de extractos
 * (`ingestar.ts`, `completar-lote.ts`, vía `guardarExtractoTrasResolver`) la violan, y quedó declarado
 * como deuda en su momento.
 */

import { createHash } from 'node:crypto';
import { conUsuario, registrarAcceso, type Tx } from '@sistema-contable/data';
import { logger } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { avisarSiElVolumenEsAnomalo } from './descarga.ts';
import { claveEsDelCliente } from './clave.ts';
import type { ObjectStorage } from './object-storage.ts';

/**
 * Duplicado de `hashArchivo` (`packages/ingesta/src/hash.ts:44-46`), a propósito: `packages/ingesta` YA
 * depende de `packages/almacenamiento` (usa `crearObjectStorage`), así que importar en la otra dirección
 * crearía un ciclo — el mismo que la regla de código de este repo ya prohíbe (HANDOFF 2026-08-10 (8),
 * hallazgo #6, "`data → ingesta → data`: el typecheck lo aceptaba"). Tres líneas puras, sin lógica de
 * dominio: más barato que mover la función a un tercer paquete para un solo consumidor nuevo.
 */
function hashDelContenido(contenido: Uint8Array): string {
  return createHash('sha256').update(contenido).digest('hex');
}

/** Nunca `error.message` crudo: el SDK de storage puede traer endpoint, `Key` (que incluye el
 *  `cliente_id`) y headers en el mensaje. Solo el nombre del constructor. */
function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

export type PedidoDeLectura = {
  readonly clienteId: string;
  readonly clave: string;
  /** El `archivo_hash` ya guardado en `lote_ingesta` — se verifica DESPUÉS de traer los bytes. */
  readonly hashEsperado: string;
  /** Obligatorio: sacar el objeto completo del sistema exige decir para qué (ADR-0002 R32). */
  readonly motivo: string;
  readonly recursoId?: string;
  /** Vocabulario que decide el LLAMADOR — nunca una constante de este módulo. */
  readonly rolesPermitidos: readonly string[];
};

export type MotivoRechazoLectura =
  | 'clave_de_otro_cliente'
  | 'motivo_faltante'
  | 'rol_insuficiente'
  | 'objeto_no_encontrado'
  | 'integridad_no_coincide';

export type ResultadoLectura =
  | { readonly obtenido: true; readonly contenido: Buffer }
  | { readonly obtenido: false; readonly motivoCodigo: MotivoRechazoLectura };

export async function obtenerObjetoDeCliente(
  usuarioId: string,
  storage: ObjectStorage,
  pedido: PedidoDeLectura,
): Promise<ResultadoLectura> {
  // 1. La clave tiene que ser del cliente que se declara — mismo argumento que `descarga.ts:86-97`: sin
  // esto, un `clienteId` correcto en la auditoría y una clave de otro cliente en la lectura producen un
  // rastro que dice lo contrario de lo que pasó.
  if (!claveEsDelCliente(pedido.clave, pedido.clienteId)) {
    logger.warn('lectura.rechazada', { cliente_id: pedido.clienteId, motivo_codigo: 'clave_de_otro_cliente' });
    return { obtenido: false, motivoCodigo: 'clave_de_otro_cliente' };
  }
  if (!pedido.motivo || pedido.motivo.trim().length < 3) {
    return { obtenido: false, motivoCodigo: 'motivo_faltante' };
  }

  // 2 y 3: rol contra la base, auditoría, y COMMIT — todo en Tx0, antes de tocar storage.
  const tx0 = await conUsuario(usuarioId, async (tx: Tx) => {
    const filas = await tx.consultar<{ puede: boolean }>(
      `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
      [pedido.clienteId, pedido.rolesPermitidos],
    );
    if (filas[0]?.puede !== true) {
      logger.warn('lectura.rechazada', { cliente_id: pedido.clienteId, motivo_codigo: 'rol_insuficiente' });
      return { ok: false as const, motivoCodigo: 'rol_insuficiente' as const };
    }

    await registrarAcceso(tx, {
      clienteId: pedido.clienteId,
      accion: 'descarga',
      recurso: 'extracto',
      ...(pedido.recursoId === undefined ? {} : { recursoId: pedido.recursoId }),
      motivo: pedido.motivo,
    });
    // Después de auditar: el contador tiene que incluir esta lectura (mismo criterio que `descarga.ts`).
    await avisarSiElVolumenEsAnomalo(tx, pedido.clienteId);

    return { ok: true as const };
  });

  if (!tx0.ok) {
    return { obtenido: false, motivoCodigo: tx0.motivoCodigo };
  }

  // 4. Fuera de toda transacción: el GET de red al proveedor de storage.
  let contenido: Buffer;
  try {
    contenido = await storage.obtener(pedido.clave);
  } catch (error) {
    logger.error('lectura.objeto_no_encontrado', { cliente_id: pedido.clienteId, causa_tipo: causaTipo(error) });
    return { obtenido: false, motivoCodigo: 'objeto_no_encontrado' };
  }

  // 5. Integridad. Nunca se loguean los hashes (son comparables — el mismo argumento que hace a
  // `fila_hash` un oráculo): si alguien tiene el extracto, puede recomputar el hash y confirmar que pasó
  // por el sistema. El rechazo se audita en su PROPIA transacción — la principal ya comiteó en Tx0.
  if (hashDelContenido(contenido) !== pedido.hashEsperado) {
    await conUsuario(usuarioId, (tx) =>
      registrarAcceso(tx, {
        clienteId: pedido.clienteId,
        accion: 'rechazo',
        recurso: 'extracto',
        ...(pedido.recursoId === undefined ? {} : { recursoId: pedido.recursoId }),
        motivo: 'integridad_no_coincide',
      }),
    );
    logger.error('lectura.integridad_no_coincide', { cliente_id: pedido.clienteId });
    return { obtenido: false, motivoCodigo: 'integridad_no_coincide' };
  }

  return { obtenido: true, contenido };
}
