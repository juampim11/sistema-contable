/**
 * EMISOR ÚNICO DE URL FIRMADA — condición de salida nº 9 del Módulo 1.
 *
 * Una URL firmada es una **capacidad transferible**: quien la tiene lee el objeto sin autenticarse, sin
 * pasar por la RLS y sin dejar rastro en la base. Toda la protección del sistema —policies, roles,
 * choke point de auditoría— queda del otro lado del link.
 *
 * Por eso la firma tiene un solo punto de emisión, y ese punto hace cinco cosas **en este orden**:
 *
 *   1. verifica que la clave pertenezca al cliente que se declara;
 *   2. verifica el **rol** del usuario sobre ese cliente;
 *   3. escribe la auditoría —con motivo obligatorio— **antes de firmar**;
 *   4. mira el **volumen** reciente del usuario y avisa si es anómalo;
 *   5. recién entonces firma, con un TTL acotado por un tope duro.
 *
 * El paso 3 antes del 5 es deliberado: si la firma falla, queda registrado el intento, que es
 * información. Al revés, una firma emitida y una auditoría que falló dejan una capacidad viva sin rastro.
 */

import { leerConAuditoria, type Tx } from '@sistema-contable/data';
import { logger } from '@sistema-contable/shared/observabilidad';
import { claveEsDelCliente } from './clave.ts';
import type { ObjectStorage } from './object-storage.ts';

/**
 * Tope duro del TTL.
 *
 * Cinco minutos alcanzan para que un navegador siga el link. Cualquier valor mayor es una capacidad que
 * sobrevive al pegado en un chat, a la copia en un ticket y al historial del navegador de una máquina
 * compartida. El tope es **duro** —se recorta, no se confía en el llamador— porque el número lo pone quien
 * escribe la feature y el riesgo lo corre el estudio.
 */
export const TTL_MAXIMO_SEGUNDOS = 300;

/**
 * Roles que pueden descargar el archivo original.
 *
 * **`administrativo` NO está, y es el punto entero.** El administrativo puede *ingestar* —es su trabajo— y
 * no puede bajarse los archivos: el escenario H-8 de ADR-0002 es literalmente el administrativo
 * descargando cuarenta extractos en su última semana. `auditor` tampoco: puede verificar que el proceso
 * ocurrió sin necesidad del documento.
 */
export const ROLES_QUE_DESCARGAN = ['socio', 'contador'] as const;

/**
 * Umbral de volumen por usuario y por hora.
 *
 * No bloquea: **avisa**. Un bloqueo con un número inventado rompe el trabajo legítimo del día de cierre, y
 * el número correcto no lo tengo (no hay fuente cargada sobre el ritmo real de un estudio). Lo que sí es
 * seguro es que sin ninguna señal de volumen, H-8 queda registrado en la auditoría y **nadie lo mira** —
 * que es el modo en que estos casos se descubren seis meses después.
 *
 * Es un parámetro, no una constante de negocio: con el dato de uso real se ajusta acá.
 */
export const UMBRAL_DESCARGAS_POR_HORA = 20;

/**
 * Umbral de LECTURAS por usuario y por hora (`accion:'lectura'` — hoy, solo el backfill de
 * contraparte de la migración 0013, `apps/cli/src/backfill-contraparte.ts`).
 *
 * Deliberadamente MENOR que `UMBRAL_DESCARGAS_POR_HORA` y con su propio contador, no el mismo: una
 * "descarga" es un PDF entero que sale del sistema hacia un humano; una "lectura" de este tipo es
 * una consulta a la satélite N2R de movimientos, acotada a un lote, y hoy el único caller legítimo
 * la llama a lo sumo unas pocas veces en toda su vida (un lote por corrida, corrida a mano). Sumarla
 * al mismo contador que las descargas produciría una alerta que menciona "25 descargas" cuando en
 * realidad hubo 3 descargas y 22 lecturas — el mensaje que nadie mira es el eslabón que se rompe.
 */
export const UMBRAL_LECTURAS_POR_HORA = 5;

export type PedidoDeDescarga = {
  readonly clienteId: string;
  readonly clave: string;
  /** Obligatorio: sacar un dato del sistema exige decir para qué (ADR-0002 R32). */
  readonly motivo: string;
  readonly recursoId?: string;
  readonly ttlSegundos?: number;
};

export type ResultadoDescarga =
  | { readonly emitida: true; readonly url: string; readonly expiraEnSegundos: number }
  | { readonly emitida: false; readonly motivoCodigo: MotivoRechazoDescarga };

export type MotivoRechazoDescarga =
  | 'clave_de_otro_cliente'
  | 'rol_insuficiente'
  | 'motivo_faltante';

/**
 * Emite la URL. Es la única función del repo que llama a `storage.urlFirmada` para un archivo de cliente.
 *
 * Recibe la `Tx` de `conUsuario()`: sin identidad no hay rol que verificar ni auditoría que escribir, y la
 * firma no se emite.
 */
export async function emitirUrlDeDescarga(
  tx: Tx,
  storage: ObjectStorage,
  pedido: PedidoDeDescarga,
): Promise<ResultadoDescarga> {
  // 1. La clave tiene que ser del cliente que se declara.
  //
  // Sin esto, un `clienteId` correcto en la auditoría y una clave de otro cliente en la firma producen un
  // rastro que dice lo contrario de lo que pasó: el peor resultado posible, porque la investigación
  // posterior arranca con una pista falsa.
  if (!claveEsDelCliente(pedido.clave, pedido.clienteId)) {
    logger.warn('descarga.rechazada', {
      cliente_id: pedido.clienteId,
      motivo_codigo: 'clave_de_otro_cliente',
    });
    return { emitida: false, motivoCodigo: 'clave_de_otro_cliente' };
  }

  if (!pedido.motivo || pedido.motivo.trim().length < 3) {
    return { emitida: false, motivoCodigo: 'motivo_faltante' };
  }

  // 2. Rol sobre ESE cliente. Se pregunta a la base, no a un objeto de sesión: el rol vive en
  // `membership` y `app.has_role_on` es la misma función que usan las policies. Dos fuentes de verdad
  // para "qué rol tiene esta persona" divergen, y la que gana es la de la base.
  const filas = await tx.consultar<{ puede: boolean }>(
    `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
    [pedido.clienteId, ROLES_QUE_DESCARGAN],
  );
  if (filas[0]?.puede !== true) {
    logger.warn('descarga.rechazada', {
      cliente_id: pedido.clienteId,
      motivo_codigo: 'rol_insuficiente',
    });
    return { emitida: false, motivoCodigo: 'rol_insuficiente' };
  }

  const ttl = Math.min(Math.max(1, pedido.ttlSegundos ?? TTL_MAXIMO_SEGUNDOS), TTL_MAXIMO_SEGUNDOS);

  // 3, 4 y 5: auditoría → volumen → firma. El choke point escribe el rastro antes de entregar el ctx.
  return leerConAuditoria(
    tx,
    {
      clienteId: pedido.clienteId,
      accion: 'descarga',
      recurso: 'extracto',
      ...(pedido.recursoId === undefined ? {} : { recursoId: pedido.recursoId }),
      motivo: pedido.motivo,
    },
    async () => {
      await avisarSiElVolumenEsAnomalo(tx, pedido.clienteId);
      const url = await storage.urlFirmada(pedido.clave, ttl);
      return { emitida: true as const, url, expiraEnSegundos: ttl };
    },
  );
}

/**
 * Cuenta las descargas del usuario actual en la última hora y emite un `warn` si pasa el umbral.
 *
 * Se cuenta desde `acceso_auditoria`, que es la misma tabla donde se acaba de escribir el evento: el
 * contador incluye esta descarga, así que el umbral se compara contra el total real y no contra el
 * anterior.
 *
 * No lanza ni bloquea. Un fallo en la señal de volumen **no puede** impedir una descarga legítima, así que
 * el error se traga con su código y se sigue: perder el aviso es malo, romper el trabajo del día de cierre
 * por un problema de observabilidad es peor.
 *
 * **Exportada** (plan `adaptive-herding-pillow`): `packages/almacenamiento/src/lectura.ts` es un segundo
 * camino de salida de un objeto de storage, y sin esta llamada la señal de H-8 quedaría muerta ahí — el
 * umbral solo saltaría cuando alguien pidiera una URL firmada por el camino de siempre.
 */
export async function avisarSiElVolumenEsAnomalo(tx: Tx, clienteId: string): Promise<void> {
  try {
    const filas = await tx.consultar<{ n: string }>(
      `select count(*)::text as n from acceso_auditoria
        where user_id = app.current_user_id()
          and accion = 'descarga'
          and ocurrido_en > now() - interval '1 hour'`,
    );
    const n = Number(filas[0]?.n ?? '0');
    if (n > UMBRAL_DESCARGAS_POR_HORA) {
      // El aviso lleva CONTEOS y ningún dato: es lo que hace que se pueda mandar a un canal de alertas.
      logger.warn('descarga.volumen_anomalo', {
        cliente_id: clienteId,
        descargas_ultima_hora: n,
        umbral: UMBRAL_DESCARGAS_POR_HORA,
      });
    }
  } catch {
    logger.warn('descarga.volumen_no_evaluado', { cliente_id: clienteId });
  }
}

/**
 * La misma señal que `avisarSiElVolumenEsAnomalo`, pero para `accion:'lectura'` — contador y
 * evento propios, nunca el mismo contador que las descargas (ver `UMBRAL_LECTURAS_POR_HORA`).
 *
 * Primer emisor real: el backfill de contraparte (migración 0013), que lee la satélite N2R de
 * movimientos por lote vía `leerConAuditoria`. Antes de esta función, ningún camino de
 * `accion:'lectura'` del repo tenía ninguna señal de volumen — quedaba en la auditoría, que
 * contesta la pregunta DESPUÉS del hecho, no MIENTRAS pasa.
 */
export async function avisarSiLasLecturasSonAnomalas(tx: Tx, clienteId: string): Promise<void> {
  try {
    const filas = await tx.consultar<{ n: string }>(
      `select count(*)::text as n from acceso_auditoria
        where user_id = app.current_user_id()
          and accion = 'lectura'
          and ocurrido_en > now() - interval '1 hour'`,
    );
    const n = Number(filas[0]?.n ?? '0');
    if (n > UMBRAL_LECTURAS_POR_HORA) {
      logger.warn('lectura.volumen_anomalo', {
        cliente_id: clienteId,
        lecturas_ultima_hora: n,
        umbral: UMBRAL_LECTURAS_POR_HORA,
      });
    }
  } catch {
    logger.warn('lectura.volumen_no_evaluado', { cliente_id: clienteId });
  }
}
