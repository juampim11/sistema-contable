/**
 * ESCRITURAS AUDITADAS DEL MÓDULO 1.
 *
 * Toda escritura sobre una tabla N2-R pasa por acá, y la firma **exige** un `ContextoAuditado`: el único
 * lugar donde se fabrica uno es `escribirConAuditoria`, que ya escribió el rastro. No se puede escribir sin
 * dejar constancia porque no hay una firma que lo permita.
 *
 * ## La escritura más importante del sistema
 *
 * `cuenta_bancaria_identificador` es **la fila de la que cuelga toda la cadena de confianza de INV-6**: de
 * ella depende que un extracto se asigne al cliente correcto. Y es una escritura que hace una **persona**,
 * a propósito: si el archivo pudiera crear la cuenta, el archivo definiría la verdad y el control de
 * pertenencia se volvería tautológico — todo extracto resolvería siempre.
 *
 * ## El identificador nunca vuelve
 *
 * La función recibe el CBU en claro, calcula su HMAC y sus últimos cuatro dígitos, y **no lo devuelve ni lo
 * loguea**. El valor completo no tiene columna donde vivir: eso es la decisión de §8.7 del plan, no un
 * olvido. Lo que sale de acá son uuid y conteos.
 */

import {
  hmacDocumento,
  hmacIdentificador,
  pepperIdActual,
  ultimos4ParaGuardar,
} from '@sistema-contable/shared/seguridad';
import { logger } from '@sistema-contable/shared/observabilidad';
import type { ContextoAuditado } from '../db/auditoria.ts';
import type { Tx } from '../db/conexion.ts';
import { conErroresTraducidos } from '../db/errores-pg.ts';

/**
 * Los tipos de cuenta que acepta el alta. **Es la TERCERA copia a mano de la misma lista** —las otras dos
 * son `TIPOS_CUENTA` (`packages/ingesta/src/esquema.ts`) y el check `cuenta_ident_tipo_chk` (migración
 * `0006`)— y queda así **a propósito**. La decisión y su motivo:
 *
 * **No se puede derivar de `TIPOS_CUENTA`.** Eso obligaría a `packages/data` a importar
 * `packages/ingesta`, que es el ciclo `data → ingesta → data` **prohibido** y verificado en
 * `packages/data/tests/reglas-de-codigo.test.ts`. La alternativa —mudar `TIPOS_CUENTA` a
 * `packages/shared`— metería un vocabulario de dominio de la ingesta en el paquete base solo para
 * esquivar el ciclo, y `shared` es justamente donde nada de dominio debería estar.
 *
 * **Se cubre con el test, que da la misma garantía.** El test de catálogo de dominios cerrados compara
 * **las dos** constantes de TypeScript contra el **mismo** check de la base. Si las dos tienen que ser
 * iguales al check, son iguales entre sí: la base es el árbitro y la transitividad hace el resto. Es más
 * barato que mover un módulo, y el modo de falla que importa —que una de las tres listas se mueva sola—
 * queda cerrado igual, con el mismo mensaje de error.
 */
export const TIPOS_CUENTA_ALTA = [
  'cuenta_corriente',
  'cuenta_corriente_especial',
  'caja_ahorro',
  'cuenta_inversion',
  'tarjeta_corporativa',
  'no_determinado',
] as const;
export type TipoCuentaAlta = (typeof TIPOS_CUENTA_ALTA)[number];

export type PedidoDeAltaDeCuenta = {
  readonly clienteId: string;
  readonly bancoCodigo: string;
  readonly moneda: 'ARS' | 'USD';
  /** Etiqueta humana. **Nunca** la razón social: el redactor no puede taparla (ADR-0002 §C.0.bis). */
  readonly alias?: string | undefined;
  readonly tipoCuenta: TipoCuentaAlta;
  /**
   * Número de cuenta **entero**: hace falta así para hablar con el banco (N2-R).
   *
   * **No puede ser el CBU.** El check `cuenta_ident_numero_no_es_cbu` (migración 0006) rechaza los 22
   * dígitos exactos, porque guardar el CBU acá lo dejaría en claro y anularía la decisión de hashearlo.
   *
   * B.17 (migración 0036): opcional desde que existe la tarjeta corporativa, cuya carátula no publica
   * ni `numero` ni `cbu` en ninguna página legible — el ancla pasa a ser `cuitTitular`. El check
   * `cuenta_ident_algun_ancla_chk` sigue exigiendo que al menos UNO de los tres esté presente.
   */
  readonly numero?: string | undefined;
  /** CBU en claro. Se hashea y **no se guarda ni se devuelve**. Opcional, mismo motivo que `numero`. */
  readonly cbu?: string | undefined;
  /**
   * CUIT del titular, en claro. Se hashea con `hmacDocumento` (pepper por cliente, NUNCA
   * `hmacIdentificador`) y **no se guarda ni se devuelve** — mismo régimen que `cbu`. Solo tiene
   * sentido para `tipoCuenta === 'tarjeta_corporativa'` (`cuenta_ident_cuit_titular_solo_tarjeta_chk`,
   * migración 0036).
   */
  readonly cuitTitular?: string | undefined;
  readonly vigenteDesde: string;
};

export type ResultadoAlta = {
  readonly cuentaBancariaId: string;
  readonly identificadorId: string;
  /** Los últimos cuatro dígitos, que es lo único del CBU que queda visible. */
  readonly cbuUltimos4: string | null;
  readonly pepperId: string;
};

/**
 * Da de alta la cuenta y su identificador vigente. **Exige `ContextoAuditado`**: la única forma de llamarla
 * es desde dentro de `escribirConAuditoria`.
 *
 * Idempotente por `(cliente_id, cbu_hmac, vigente_desde)`: correrla dos veces con el mismo CBU y la misma
 * fecha de vigencia no crea una segunda fila. Importa porque el modo de falla contrario —dos identificadores
 * vigentes para la misma cuenta— pone al resolver en `cuenta_ambigua` **para siempre**.
 */
export async function altaDeCuentaBancaria(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoDeAltaDeCuenta,
): Promise<ResultadoAlta> {
  // B.17 (0036): el CBU pasó a opcional — solo se hashea si el pedido lo trae. Idem el CUIT del
  // titular, con `hmacDocumento` (pepper POR CLIENTE) y NUNCA `hmacIdentificador` (pepper global):
  // un CUIT identifica una persona, que puede legítimamente ser titular en más de un cliente del
  // mismo estudio, y el pepper global crearía la correlación cruzada entre clientes que
  // `hmacDocumento` existe para impedir (ver `resolver-cuenta.ts::resolverPorCuitTitular`).
  const digest = pedido.cbu !== undefined ? hmacIdentificador(pedido.cbu) : null;
  const ultimos4 = pedido.cbu !== undefined ? ultimos4ParaGuardar(pedido.cbu) : null;
  const digestCuitTitular =
    pedido.cuitTitular !== undefined ? hmacDocumento('cuit', pedido.cuitTitular, pedido.clienteId) : null;
  const cuitTitularUltimos4 =
    pedido.cuitTitular !== undefined ? ultimos4ParaGuardar(pedido.cuitTitular) : null;
  const pepperId = pepperIdActual();

  // Si el identificador ya está cargado para este cliente, se devuelve el existente. Dos ramas: por
  // CBU (comportamiento de siempre) o, cuando no hay CBU, por CUIT del titular + moneda (0036) — las
  // dos son la MISMA garantía de idempotencia, solo cambia el ancla disponible.
  const yaEsta =
    digest !== null
      ? await tx.consultar<{ id: string; cuenta_bancaria_id: string }>(
          `select id::text as id, cuenta_bancaria_id::text as cuenta_bancaria_id
             from cuenta_bancaria_identificador
            where cliente_id = $1 and pepper_id = $2 and cbu_hmac = $3 and vigente_desde = $4::date`,
          [pedido.clienteId, pepperId, digest, pedido.vigenteDesde],
        )
      : digestCuitTitular !== null
        ? await tx.consultar<{ id: string; cuenta_bancaria_id: string }>(
            `select id::text as id, cuenta_bancaria_id::text as cuenta_bancaria_id
               from cuenta_bancaria_identificador
              where cliente_id = $1 and pepper_id = $2 and cuit_titular_hmac = $3 and moneda = $4
                and vigente_desde = $5::date`,
            [pedido.clienteId, pepperId, digestCuitTitular, pedido.moneda, pedido.vigenteDesde],
          )
        : [];
  const existente = yaEsta[0];
  if (existente) {
    logger.info('alta_cuenta.ya_existia', {
      cliente_id: pedido.clienteId,
      cuenta_bancaria_id: existente.cuenta_bancaria_id,
    });
    return {
      cuentaBancariaId: existente.cuenta_bancaria_id,
      identificadorId: existente.id,
      cbuUltimos4: ultimos4,
      pepperId,
    };
  }

  const cuenta = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
       values ($1, $2, $3, $4) returning id::text as id`,
      [pedido.clienteId, pedido.bancoCodigo, pedido.moneda, pedido.alias ?? null],
    ),
  );
  const cuentaBancariaId = cuenta[0]?.id;
  if (!cuentaBancariaId) throw new Error('El alta de cuenta no devolvió id.');

  // El insert de `cuenta_bancaria_identificador` — YA envuelto en `conErroresTraducidos` — se
  // EXTIENDE con las tres columnas de 0036, nunca un segundo camino de escritura separado: perdería
  // la traducción de errores que este `insert` ya tiene.
  const identificador = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria_identificador
         (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4,
          pepper_id, vigente_desde, moneda, cuit_titular_hmac, cuit_titular_ultimos4)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11)
       returning id::text as id`,
      [
        pedido.clienteId,
        cuentaBancariaId,
        pedido.tipoCuenta,
        pedido.numero ?? null,
        digest,
        ultimos4,
        pepperId,
        pedido.vigenteDesde,
        pedido.moneda,
        digestCuitTitular,
        cuitTitularUltimos4,
      ],
    ),
  );
  const identificadorId = identificador[0]?.id;
  if (!identificadorId) throw new Error('El alta de identificador no devolvió id.');

  /**
   * Salen uuid, el tipo de cuenta y la versión del pepper. Nada más.
   *
   * La primera versión de esta línea incluía `cbu_ultimos4`, y **el tipo del logger la rechazó**: esa columna
   * está clasificada N2 con enmascarado, así que no va a un log ni en su forma parcial. Es el control
   * funcionando en el momento correcto — en tiempo de compilación, no después de mirar un log de producción.
   *
   * Los últimos cuatro dígitos sirven para **mostrarle la cuenta a una persona en una pantalla**, que es
   * distinto de dejarlos escritos en un archivo que se rota, se envía y se indexa.
   */
  logger.info('alta_cuenta.creada', {
    cliente_id: pedido.clienteId,
    cuenta_bancaria_id: cuentaBancariaId,
    banco_codigo: pedido.bancoCodigo,
    tipo_cuenta: pedido.tipoCuenta,
    pepper_id: pepperId,
  });

  return { cuentaBancariaId, identificadorId, cbuUltimos4: ultimos4, pepperId };
}
