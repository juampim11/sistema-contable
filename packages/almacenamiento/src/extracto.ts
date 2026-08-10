/**
 * GUARDAR EL EXTRACTO — y el orden que no se puede invertir.
 *
 * ## El bug que este archivo hace imposible
 *
 * La secuencia natural al escribir el pipeline es: *"primero guardo el archivo para no perderlo, después
 * resuelvo a qué cuenta pertenece"*. Suena prudente y es la falla más grave del módulo.
 *
 * Si el archivo se guarda antes de resolver, la clave se arma con el `clienteId` **declarado en el
 * comando**. Cuando la resolución después dice que la cuenta es de otro cliente, el PDF ya está escrito
 * bajo el prefijo `cliente/<el-declarado>/…`. A partir de ahí el socio del cliente equivocado se lo baja
 * **legítimamente**: tiene membresía, la clave está en su prefijo, la URL firmada se emite sin objeción y
 * la auditoría registra un acceso perfectamente normal. Nada falla. Simplemente el extracto de un cliente
 * quedó en la carpeta de otro, y el radio de daño es estudio→estudio.
 *
 * ## Por qué no basta con "acordarse del orden"
 *
 * Un comentario que diga "resolvé antes de guardar" se cumple hasta el primer refactor apurado. Así que
 * acá **no hay una función `guardar` para extractos**: la única forma de guardar es
 * `guardarExtractoTrasResolver`, que recibe la función resolvedora y **la ejecuta ella misma**. El orden
 * deja de ser disciplina del llamador y pasa a ser control de flujo de este archivo.
 *
 * Y hay un test que verifica el orden de las llamadas y que con una resolución fallida `guardar()` **no se
 * invoca nunca**.
 */

import { logger } from '@sistema-contable/shared/observabilidad';
import { construirClave, type Categoria } from './clave.ts';
import type { ObjectStorage } from './object-storage.ts';

/**
 * El resultado de resolver a qué cuenta pertenece el archivo.
 *
 * Los cuatro estados de no-resolución son los del plan §7.2.8 y **ninguno de ellos permite guardar**.
 * `cuenta_no_registrada` en particular exige alta explícita por un humano: si el archivo pudiera crear la
 * cuenta, el archivo definiría la verdad y el control sería tautológico.
 */
export type ResolucionCuenta =
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
        | 'requiere_ocr';
    };

export type PedidoDeGuardado = {
  readonly clienteId: string;
  readonly loteId: string;
  readonly categoria: Categoria;
  readonly extension: 'pdf' | 'xlsx' | 'xls' | 'csv';
  readonly contentType: string;
  readonly contenido: Buffer;
};

export type ResultadoGuardado =
  | { readonly guardado: true; readonly clave: string; readonly resolucion: ResolucionCuenta }
  | { readonly guardado: false; readonly motivoCodigo: string; readonly resolucion: ResolucionCuenta };

/**
 * Resuelve **y después** guarda. No hay otro camino para escribir un extracto.
 *
 * El `resolver` se recibe como función y se ejecuta acá: es lo que vuelve el orden inviolable. Si devuelve
 * cualquier estado distinto de `resuelta`, el objeto **no se escribe** y se devuelve el código para que el
 * llamador lo asiente en el lote y en el rastro.
 */
export async function guardarExtractoTrasResolver(
  storage: ObjectStorage,
  pedido: PedidoDeGuardado,
  resolver: () => Promise<ResolucionCuenta>,
): Promise<ResultadoGuardado> {
  const resolucion = await resolver();

  if (resolucion.estado !== 'resuelta') {
    // Cero filas, cero objeto. El lote queda como ancla del rechazo, con su código.
    logger.warn('extracto.no_guardado', {
      lote_id: pedido.loteId,
      cliente_id: pedido.clienteId,
      motivo_codigo: resolucion.estado,
    });
    return { guardado: false, motivoCodigo: resolucion.estado, resolucion };
  }

  /**
   * INV-6, el chequeo que hace que el orden sirva de algo.
   *
   * Resolver primero y después armar la clave con el cliente **declarado** tendría el mismo efecto que
   * guardar antes de resolver. La clave se arma con el cliente que la **resolución** devolvió, y si no
   * coincide con el declarado se rechaza.
   *
   * El error NO dice de quién es la cuenta: decirlo filtra la cartera de un competidor y confirma la
   * existencia de un cliente sobre el que no hay membresía (mismo razonamiento del 404 vs. 403). Y el
   * operador no lo necesita: tiene el archivo y sabe quién se lo mandó.
   */
  if (resolucion.clienteId !== pedido.clienteId) {
    logger.warn('extracto.cliente_no_coincide', {
      lote_id: pedido.loteId,
      cliente_id: pedido.clienteId,
      motivo_codigo: 'cuenta_no_pertenece_al_cliente',
    });
    return {
      guardado: false,
      motivoCodigo: 'cuenta_no_pertenece_al_cliente',
      resolucion: { estado: 'cuenta_no_pertenece_al_cliente' },
    };
  }

  const clave = construirClave({
    clienteId: resolucion.clienteId,
    categoria: pedido.categoria,
    recursoId: pedido.loteId,
    extension: pedido.extension,
  });

  await storage.guardar(clave, pedido.contenido, pedido.contentType);

  logger.info('extracto.guardado', {
    lote_id: pedido.loteId,
    cliente_id: pedido.clienteId,
    cuenta_bancaria_id: resolucion.cuentaBancariaId,
  });

  return { guardado: true, clave, resolucion };
}
