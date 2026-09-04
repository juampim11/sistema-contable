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
import { hmacDocumento, hmacIdentificador } from '@sistema-contable/shared/seguridad';
import { logger } from '@sistema-contable/shared/observabilidad';

export type PedidoDeResolucion = {
  /** El cliente que declaró el comando. La consulta se acota SIEMPRE a este valor. */
  readonly clienteId: string;
  /** Identificador leído de la carátula del documento por etiqueta. */
  readonly cbuDeclarado?: string | undefined;
  readonly numeroDeclarado?: string | undefined;
  /**
   * B.17 — tercer camino, solo cuando la carátula no publica `numero` ni `cbu` (tarjeta corporativa):
   * el CUIT del titular, también leído de la carátula por etiqueta, nunca por patrón libre. Se
   * intenta ANTES de devolver `sin_identificador_en_caratula`, nunca en lugar de las dos anclas
   * anteriores.
   */
  readonly cuitTitularDeclarado?: string | undefined;
  /**
   * La moneda del documento (`CuentaDetectada.moneda`, ya obligatoria en el esquema del adapter).
   * La tercera rama la necesita para no colisionar cuando el mismo titular tiene tarjeta en dos
   * monedas (`uq_cuenta_ident_cuit_titular_vigente`, migración 0036) — las otras dos ramas no la usan
   * porque `numero`/`cbu` ya son anclas suficientes por sí solas.
   */
  readonly moneda: 'ARS' | 'USD';
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
 * Cero candidatas: distingue `cuenta_no_pertenece_al_cliente` de `cuenta_no_registrada` **sin
 * preguntar de quién es la cuenta** — la pregunta solo mira al cliente declarado (¿tiene alguna
 * cuenta registrada?), nunca a otro. Compartida por las tres ramas de resolución.
 */
async function estadoSinCandidatas(
  tx: Tx,
  clienteId: string,
): Promise<'cuenta_no_pertenece_al_cliente' | 'cuenta_no_registrada'> {
  const propias = await tx.consultar<{ n: string }>(
    `select count(*)::text as n from cuenta_bancaria_identificador where cliente_id = $1`,
    [clienteId],
  );
  const tieneCuentas = Number(propias[0]?.n ?? '0') > 0;
  return tieneCuentas ? 'cuenta_no_pertenece_al_cliente' : 'cuenta_no_registrada';
}

/**
 * Tercer camino de INV-6 (B.17): resuelve por el CUIT del titular declarado en la carátula, para el
 * caso de tarjeta corporativa que no publica `numero` ni `cbu` en ninguna página legible.
 *
 * **`hmacDocumento`, nunca `hmacIdentificador`.** Un CUIT identifica una PERSONA, que puede
 * legítimamente ser titular en más de un cliente del mismo estudio (un socio o apoderado con tarjeta
 * corporativa en dos empresas distintas) — con el pepper global de `hmacIdentificador()` el mismo
 * CUIT produciría el mismo digest en los dos clientes, la correlación cruzada exacta que
 * `hmacDocumento()` (pepper derivado por cliente) existe para impedir.
 */
async function resolverPorCuitTitular(
  tx: Tx,
  pedido: PedidoDeResolucion,
  cuitTitular: string,
): Promise<ResolucionDeCuenta> {
  const digestCuitTitular = hmacDocumento('cuit', cuitTitular, pedido.clienteId);

  // Mismos dos invariantes que la consulta por CBU/número: `cliente_id = $1` siempre (nunca hay
  // oráculo cross-tenant posible) y el rango de vigencia acotado a la fecha del período. `moneda`
  // se suma acá porque el mismo titular puede tener tarjeta en dos monedas (0036).
  const candidatas = await tx.consultar<{ cuenta_bancaria_id: string }>(
    `select distinct cuenta_bancaria_id::text as cuenta_bancaria_id
       from cuenta_bancaria_identificador
      where cliente_id = $1
        and cuit_titular_hmac = $2
        and moneda = $3
        and vigente_desde <= $4::date
        and (vigente_hasta is null or vigente_hasta >= $4::date)`,
    [pedido.clienteId, digestCuitTitular, pedido.moneda, pedido.alFecha],
  );

  if (candidatas.length === 1) {
    const cuentaBancariaId = candidatas[0]?.cuenta_bancaria_id;
    if (cuentaBancariaId) {
      return { estado: 'resuelta', clienteId: pedido.clienteId, cuentaBancariaId };
    }
  }

  if (candidatas.length > 1) {
    logger.warn('resolucion.ambigua', {
      cliente_id: pedido.clienteId,
      candidatas: candidatas.length,
      motivo_codigo: 'cuenta_ambigua',
    });
    return { estado: 'cuenta_ambigua' };
  }

  const estado = await estadoSinCandidatas(tx, pedido.clienteId);
  logger.warn('resolucion.fallida', {
    cliente_id: pedido.clienteId,
    motivo_codigo: estado,
  });
  return { estado };
}

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
    // Sin numero/cbu, B.17 da una tercera oportunidad ANTES de rendirse: el CUIT del titular, cuando
    // la carátula lo declara (tarjeta corporativa). Nunca al revés — numeroDeclarado/cbuDeclarado
    // siguen siendo las anclas primarias.
    const cuitTitular = pedido.cuitTitularDeclarado;
    if (cuitTitular && cuitTitular.replace(/\D/g, '').length > 0) {
      return resolverPorCuitTitular(tx, pedido, cuitTitular);
    }

    // Sin ningún identificador en la carátula no hay nada contra qué resolver. Adivinar por "la única
    // cuenta que tiene el cliente" sería el mismo error que dar de alta sola: el archivo definiría la
    // verdad.
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

  // Cero candidatas. Distinguir los dos casos, y **sin preguntar de quién es la cuenta** — ver
  // `estadoSinCandidatas` arriba.
  const estado = await estadoSinCandidatas(tx, pedido.clienteId);
  logger.warn('resolucion.fallida', {
    cliente_id: pedido.clienteId,
    motivo_codigo: estado,
  });
  return { estado };
}
