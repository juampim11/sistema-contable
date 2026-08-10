/**
 * INV-6 — RESOLVER A QUÉ CUENTA PERTENECE EL EXTRACTO.
 *
 * Es el control más importante del módulo, y el que más fácil se implementa mal de una forma que *parece*
 * funcionar.
 *
 * ## El control que NO valida nada
 *
 * El primer impulso es preguntar *"¿aparece el CUIT del cliente en este archivo?"*. Medido sobre el
 * extracto real del piloto: el archivo tiene **113 corridas de once dígitos** (los CUIT de las
 * contrapartes) y dos CUIT con guiones, uno en la carátula y otro en el cuerpo.
 *
 * O sea que ese chequeo da **verdadero para el extracto de otro cliente** en el que el nuestro figura como
 * contraparte — que es el caso más común, no un borde. Un control que da verdadero cuando debería dar
 * falso, y que además transmite la sensación de haber validado algo, es peor que no tener control.
 *
 * ## Cómo se resuelve de verdad
 *
 * Por **etiqueta, no por patrón**: se lee el identificador de la carátula del documento (donde el banco
 * declara la cuenta) y se busca **entre las cuentas registradas del cliente declarado**, acotado a la
 * fecha del período.
 *
 * ## La consulta NUNCA pregunta "¿de quién es este CBU?"
 *
 * Preguntarlo requeriría saltear la RLS, y eso construye un **oráculo cross-tenant**: con un CBU
 * cualquiera se averigua si su dueño es cliente de otro estudio. La consulta lleva siempre
 * `cliente_id = <el declarado>`, así que la RLS la vuelve a filtrar y el peor caso es "no encontré nada".
 *
 * Por eso la salida `cuenta_no_pertenece_al_cliente` **no dice de quién es**: el radio de daño es
 * estudio→estudio, decirlo filtra la cartera de un competidor, y el operador no lo necesita — tiene el
 * archivo y sabe quién se lo mandó.
 *
 * ## Y no da de alta la cuenta sola
 *
 * `cuenta_no_registrada` exige alta explícita por una persona. Si el archivo pudiera crear la cuenta, el
 * archivo definiría la verdad y el control se volvería **tautológico**: todo extracto resolvería siempre.
 */

import type { Tx } from '@sistema-contable/data';
import { hmacIdentificador } from '@sistema-contable/shared/seguridad';
import { logger } from '@sistema-contable/shared/observabilidad';

export type PedidoDeResolucion = {
  /** El cliente que declaró el comando. La consulta se acota SIEMPRE a este valor. */
  readonly clienteId: string;
  /** Identificador leído de la carátula del documento por etiqueta. */
  readonly cbuDeclarado?: string | undefined;
  readonly numeroDeclarado?: string | undefined;
  /** Fecha del período, para resolver contra el identificador vigente ENTONCES. */
  readonly alFecha: string;
};

export type ResolucionDeCuenta =
  | {
      readonly estado: 'resuelta';
      readonly clienteId: string;
      readonly cuentaBancariaId: string;
    }
  | {
      readonly estado:
        | 'cuenta_no_pertenece_al_cliente'
        | 'cuenta_no_registrada'
        | 'cuenta_ambigua'
        | 'sin_identificador_en_caratula';
    };

/**
 * Resuelve la cuenta. Las cinco salidas son las del plan §7.2.8 y **ninguna de las cuatro de fracaso
 * permite continuar**.
 *
 * La distinción entre `cuenta_no_pertenece_al_cliente` y `cuenta_no_registrada` es la que le dice al
 * operador qué hacer: la primera significa "este archivo no es de este cliente, revisá qué cargaste"; la
 * segunda, "la cuenta es nueva, hay que darla de alta". Colapsarlas en un solo error obliga a adivinar.
 */
export async function resolverCuentaDelExtracto(
  tx: Tx,
  pedido: PedidoDeResolucion,
): Promise<ResolucionDeCuenta> {
  const identificador = pedido.cbuDeclarado ?? pedido.numeroDeclarado;
  if (!identificador || identificador.replace(/\D/g, '').length === 0) {
    // Sin identificador en la carátula no hay nada contra qué resolver. Adivinar por "la única cuenta que
    // tiene el cliente" sería el mismo error que dar de alta sola: el archivo definiría la verdad.
    logger.warn('resolucion.sin_identificador', {
      cliente_id: pedido.clienteId,
      motivo_codigo: 'sin_identificador_en_caratula',
    });
    return { estado: 'sin_identificador_en_caratula' };
  }

  const usaCbu = pedido.cbuDeclarado !== undefined && pedido.cbuDeclarado.replace(/\D/g, '') !== '';
  const digest = hmacIdentificador(identificador);

  /**
   * La consulta. Dos cosas que no son negociables:
   *
   *   - `cliente_id = $1` **siempre**, así la RLS la vuelve a filtrar y no hay oráculo posible;
   *   - el rango de vigencia, para que un extracto de hace ocho meses resuelva con el identificador
   *     vigente entonces y no con el actual. Sin eso, un cambio de CBU hace que los extractos viejos
   *     matcheen con un número que en su momento no existía — un match incorrecto que además parece bien.
   */
  const candidatas = usaCbu
    ? await tx.consultar<{ cuenta_bancaria_id: string }>(
        `select distinct cuenta_bancaria_id::text as cuenta_bancaria_id
           from cuenta_bancaria_identificador
          where cliente_id = $1
            and cbu_hmac = $2
            and vigente_desde <= $3::date
            and (vigente_hasta is null or vigente_hasta >= $3::date)`,
        [pedido.clienteId, digest, pedido.alFecha],
      )
    : await tx.consultar<{ cuenta_bancaria_id: string }>(
        // Por número: se compara normalizado a dígitos en los dos lados, porque el banco lo escribe con
        // guiones o con barras según el documento y la carga a mano casi nunca coincide carácter a carácter.
        `select distinct cuenta_bancaria_id::text as cuenta_bancaria_id
           from cuenta_bancaria_identificador
          where cliente_id = $1
            and regexp_replace(numero, '\\D', '', 'g') = $2
            and vigente_desde <= $3::date
            and (vigente_hasta is null or vigente_hasta >= $3::date)`,
        [pedido.clienteId, identificador.replace(/\D/g, ''), pedido.alFecha],
      );

  if (candidatas.length === 1) {
    const cuentaBancariaId = candidatas[0]?.cuenta_bancaria_id;
    if (cuentaBancariaId) {
      return { estado: 'resuelta', clienteId: pedido.clienteId, cuentaBancariaId };
    }
  }

  if (candidatas.length > 1) {
    // Dos cuentas del mismo cliente con el mismo identificador vigente a la vez es un problema de datos,
    // no del archivo. Lo resuelve una persona: elegir automáticamente "la primera" asigna movimientos a
    // una cuenta al azar y el error aparece en el balance, meses después.
    logger.warn('resolucion.ambigua', {
      cliente_id: pedido.clienteId,
      candidatas: candidatas.length,
      motivo_codigo: 'cuenta_ambigua',
    });
    return { estado: 'cuenta_ambigua' };
  }

  /**
   * Cero candidatas. Ahora hay que distinguir los dos casos, y **sin preguntar de quién es la cuenta**.
   *
   * La distinción se hace con una pregunta que solo mira al cliente declarado: *¿este cliente tiene alguna
   * cuenta registrada?* Si tiene, el archivo probablemente es de otro cliente. Si no tiene ninguna, es un
   * alta pendiente. En los dos casos la información sale del propio cliente, nunca de otro.
   */
  const propias = await tx.consultar<{ n: string }>(
    `select count(*)::text as n from cuenta_bancaria_identificador where cliente_id = $1`,
    [pedido.clienteId],
  );
  const tieneCuentas = Number(propias[0]?.n ?? '0') > 0;

  const estado = tieneCuentas ? 'cuenta_no_pertenece_al_cliente' : 'cuenta_no_registrada';
  logger.warn('resolucion.fallida', {
    cliente_id: pedido.clienteId,
    motivo_codigo: estado,
  });
  return { estado };
}
