/**
 * ESCRITURAS DEL MÓDULO 2, CAPA C — alta y baja de socio del padrón (migración 0013).
 *
 * Una sola transacción entre `padron_socio` y `padron_socio_documento`: el invariante entre las dos
 * NO tiene constraint de base (mismo patrón que el invariante `contraparte_captura` ⟺
 * `movimiento_contraparte_identificador`, `0013:130-138`) — solo la transacción de
 * `escribirConAuditoria` lo garantiza, con rollback conjunto ante cualquier fallo.
 *
 * El documento en claro nunca vuelve ni se loguea: solo `documentoUltimos4`. Igual que
 * `altaDeCuentaBancaria` con el CBU (`ingesta/escrituras.ts`).
 */

import { hmacDocumento, pepperIdActual } from '@sistema-contable/shared/seguridad';
import type { TipoDocumentoSocio } from '@sistema-contable/shared/seguridad';
import { logger } from '@sistema-contable/shared/observabilidad';
import type { ContextoAuditado } from '../db/auditoria.ts';
import type { Tx } from '../db/conexion.ts';
import { conErroresTraducidos, ErrorDeBase } from '../db/errores-pg.ts';

export type PedidoDeAltaDeSocio = {
  readonly clienteId: string;
  readonly denominacion: string;
  readonly documentoTipo: TipoDocumentoSocio;
  /** En claro, YA validado (forma + dígito verificador) por el llamador. Se hashea y se guarda
   *  además normalizado a dígitos en `padron_socio_documento`; nunca vuelve. */
  readonly documento: string;
  readonly vigenteDesde: string;
};

export type ResultadoAltaDeSocio = {
  readonly socioId: string;
  readonly documentoUltimos4: string;
  readonly pepperId: string;
};

/**
 * Da de alta el socio y su documento. Exige `ContextoAuditado`.
 *
 * A DIFERENCIA de `altaDeCuentaBancaria`, NO hay rama de idempotencia "ya existe, se devuelve el
 * existente": el índice único parcial `uq_padron_socio_vigente` es sobre vigencia ACTIVA, y una
 * segunda alta con el mismo documento activo es un error real (alta duplicada a mano), no un
 * reproceso benigno de un archivo — el modo de falla que ese índice existe para atajar. Se deja que
 * Postgres lo rechace; `conErroresTraducidos` lo traduce a `ErrorDeBase{codigo:'ING_DUPLICADO'}`,
 * sin dato del socio en el mensaje.
 */
export async function altaDeSocio(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoDeAltaDeSocio,
): Promise<ResultadoAltaDeSocio> {
  const digest = hmacDocumento(pedido.documentoTipo, pedido.documento, pedido.clienteId);
  const normalizado = pedido.documento.replace(/\D/g, '');
  const ultimos4 = normalizado.slice(-4);
  const pepperId = pepperIdActual();

  const socio = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into padron_socio
         (cliente_id, denominacion, documento_tipo, documento_hmac, documento_ultimos4, pepper_id, vigente_desde)
       values ($1, $2, $3, $4, $5, $6, $7::date)
       returning id::text as id`,
      [pedido.clienteId, pedido.denominacion, pedido.documentoTipo, digest, ultimos4, pepperId, pedido.vigenteDesde],
    ),
  );
  const socioId = socio[0]?.id;
  if (!socioId) throw new Error('El alta de socio no devolvió id.'); // H-14: RLS sin match da 0 filas, no excepción

  const documentoFila = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into padron_socio_documento (cliente_id, socio_id, documento)
       values ($1, $2, $3)
       returning id::text as id`,
      [pedido.clienteId, socioId, normalizado],
    ),
  );
  if (!documentoFila[0]?.id) throw new Error('El alta del documento de socio no devolvió id.'); // H-14

  logger.info('alta_socio.creado', {
    cliente_id: pedido.clienteId,
    socio_id: socioId,
    documento_tipo: pedido.documentoTipo,
    pepper_id: pepperId,
  });

  return { socioId, documentoUltimos4: ultimos4, pepperId };
}

export type PedidoDeBajaDeSocio = {
  readonly clienteId: string;
  readonly socioId: string;
  readonly vigenteHasta: string;
};

export type MotivoBajaDeSocio = 'BAJA_SOCIO_NO_ENCONTRADO';

export class BajaDeSocioNoEncontradaError extends Error {
  readonly codigo: MotivoBajaDeSocio = 'BAJA_SOCIO_NO_ENCONTRADO';
  readonly clienteId: string;
  readonly socioId: string;

  constructor(clienteId: string, socioId: string) {
    super(`No hay un socio con vigencia abierta para dar de baja (cliente ${clienteId}, socio ${socioId}).`);
    this.name = 'BajaDeSocioNoEncontradaError';
    this.clienteId = clienteId;
    this.socioId = socioId;
  }
}

/**
 * `padron_socio_vigencia_chk` (migración 0013) exige `vigente_hasta > vigente_desde` ESTRICTO — una
 * baja con la misma fecha que el alta (el caso real más común: un error de tipeo notado el mismo día)
 * la rechaza. Sin este catch, ese rechazo llegaba como `ErrorDeBase{codigo:'ING_CHECK'}` genérico, sin
 * decirle al contador qué hacer (Ronda 3, `qa-funcional`: "el flujo documentado no funciona para el
 * error más común").
 */
export class BajaMismoDiaDeAltaError extends Error {
  readonly codigo = 'BAJA_MISMO_DIA_DE_ALTA' as const;

  constructor() {
    super(
      'No se puede cerrar la vigencia con la misma fecha (o una anterior) a la del alta — ' +
        'padron_socio exige vigente_hasta > vigente_desde. Si el error se detectó el mismo día de la ' +
        'carga, dar la baja con la fecha de MAÑANA (el socio no llegó a estar vigente ningún día real, ' +
        'y ningún movimiento de hoy debería resolver contra él si se corre resolver:contrapartida después).',
    );
    this.name = 'BajaMismoDiaDeAltaError';
  }
}

/**
 * Cierra la vigencia. Único UPDATE que el grant por columna permite (`0013:417`) — no se puede
 * corregir `documentoHmac`/`documentoTipo`/`vigenteDesde` de un alta con error: un error de carga
 * se corrige dando de baja la fila y dando de alta una nueva (ratificado por
 * `plan-cuentas-multicliente`, Ronda 1 del plan — corregir el documento desincronizaría la satélite
 * `padron_socio_documento` en silencio).
 */
export async function bajaDeSocio(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoDeBajaDeSocio,
): Promise<{ readonly socioId: string }> {
  let filas: readonly { readonly id: string }[];
  try {
    filas = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `update padron_socio set vigente_hasta = $3::date
          where cliente_id = $1 and id = $2 and vigente_hasta is null
          returning id::text as id`,
        [pedido.clienteId, pedido.socioId, pedido.vigenteHasta],
      ),
    );
  } catch (error) {
    if (error instanceof ErrorDeBase && error.constraint === 'padron_socio_vigencia_chk') {
      throw new BajaMismoDiaDeAltaError();
    }
    throw error;
  }
  const id = filas[0]?.id;
  if (!id) throw new BajaDeSocioNoEncontradaError(pedido.clienteId, pedido.socioId);

  logger.info('alta_socio.baja', { cliente_id: pedido.clienteId, socio_id: id });
  return { socioId: id };
}
