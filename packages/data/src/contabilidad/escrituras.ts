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

  // 🔴 SIN `socio_id`: `0021` lo subió a N2 (seudónimo estable de una persona humana, opaco pero
  // ENLAZABLE — agregado por líneas de log da el perfil de un socio real desde un almacén que no
  // tiene RLS ni frontera de tenant). El typecheck lo rechaza, y esa es la falla buena: ruidosa y
  // en la misma tarea. Lo que queda alcanza para depurar un alta —el cliente, el tipo de documento
  // y la versión de pepper— sin nombrar a la persona.
  logger.info('alta_socio.creado', {
    cliente_id: pedido.clienteId,
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

  // Sin `socio_id` por lo mismo que en el alta (N2 desde `0021`). La baja se depura por cliente y
  // por el momento del evento; el uuid del socio no agrega nada que valga publicar.
  logger.info('alta_socio.baja', { cliente_id: pedido.clienteId });
  return { socioId: id };
}


// -----------------------------------------------------------------------------
// Reconocimiento del motor (migración 0014) — append-oriented, con supersesión
// -----------------------------------------------------------------------------

/**
 * Espejo PLANO de `FilaDeReconocimiento` (`packages/contabilidad/src/nucleo/persistible.ts`). NO se
 * importa: R-A lo prohíbe con un barrido de TEXTO, así que `import type` tampoco sirve.
 *
 * Eso no reabre la discusión de la Ronda 1: el mapeo del TIPO SUMA vive del otro lado y lo arbitra el
 * compilador (`switch` exhaustivo con `never`). Lo que queda acá es la lista de parámetros del SQL,
 * exactamente como `PedidoDeAltaDeSocio`. El adaptador entre los dos vive en `apps/cli` —la única capa
 * que importa los dos paquetes, mismo precedente que `comoSocioDelPadron`— y **R-K**
 * (`packages/data/tests/reglas-de-codigo.test.ts`) vigila que las dos listas de nombres no diverjan:
 * sin esa regla, un campo agregado de un solo lado deja al adaptador compilando y a la columna sin
 * escribirse nunca.
 *
 * Los dominios van como `string`: este paquete no puede importar las uniones, y el árbitro pasa a ser
 * la base — es el traspaso que `nucleo/tipos.ts` anticipa ("hasta 0014 el árbitro era el test de
 * dominios pendientes"). Los ocho `check` de 0014 más `DOMINIOS_CERRADOS` reatan las uniones de
 * TypeScript a las columnas.
 */
export type PedidoDePersistirReconocimiento = {
  readonly clienteId: string;
  readonly movimientoId: string;
  /**
   * 🔴 uuid generado EN EL CLIENTE (`randomUUID()`), nunca `default gen_random_uuid()`. El plan de
   * transacción lo exige: la supersesión escribe `superseded_por = <este uuid>` ANTES de que la fila
   * exista, y para eso hay que conocerlo de antemano.
   */
  readonly reconocimientoId: string;
  readonly motorDigest: string;
  readonly clase: string;
  readonly tipo: string | null;
  readonly concepto: string | null;
  readonly polaridad: string | null;
  readonly lado: string | null;
  readonly via: string | null;
  readonly queDecide: string | null;
  readonly motivoCodigo: string | null;
  readonly entradaLexicoId: string | null;
  readonly caracteresMatcheados: number | null;
  readonly huboCola: boolean | null;
  readonly candidatos: readonly string[];
};

export type ResultadoDePersistirReconocimiento =
  | { readonly estado: 'no_op'; readonly reconocimientoId: string }
  | { readonly estado: 'creado'; readonly reconocimientoId: string }
  | { readonly estado: 'supersedido'; readonly reconocimientoId: string; readonly anteriorId: string };

export const CODIGO_DIGEST_YA_EN_LA_CADENA = 'RECON_DIGEST_YA_SUPERSEDIDO' as const;

/**
 * 🔴 Cuando el digest nuevo coincide con una fila YA SUPERSEDIDA del mismo movimiento. Pasa de verdad:
 * se revierte un cambio del léxico y el digest vuelve a un valor histórico. Las tres salidas posibles
 * son malas, y por eso el motor NO elige — se detiene con un código:
 *
 *   - no-op → deja ACTIVO el reconocimiento equivocado, que es lo contrario de lo que se pidió
 *   - insertar igual → viola `uq_recon_determinante`
 *   - "des-supersedir" el viejo → muta la cadena append-oriented y rompe su linealidad
 *
 * Es la misma forma de "la ausencia se representa, no se rellena" que gobierna todo este módulo: hay
 * una decisión que el motor no puede tomar, y la representa en vez de adivinarla.
 */
export class ReconocimientoDigestYaEnLaCadenaError extends Error {
  // Asignadas a mano, no como parameter properties (type-stripping de Node).
  readonly codigo = CODIGO_DIGEST_YA_EN_LA_CADENA;
  readonly clienteId: string;
  readonly movimientoId: string;

  constructor(clienteId: string, movimientoId: string) {
    super(
      'El digest del motor ya figura en la cadena de reconocimientos de este movimiento, en una fila ' +
        'superseded. Volver a un digest histórico (por ejemplo revirtiendo un cambio del léxico) es ' +
        'una decisión humana, no un reproceso. ' +
        `cliente ${clienteId}, movimiento ${movimientoId}.`,
    );
    this.name = 'ReconocimientoDigestYaEnLaCadenaError';
    this.clienteId = clienteId;
    this.movimientoId = movimientoId;
  }
}

/**
 * Persiste UN reconocimiento. Se escribe UNA sola vez, DESPUÉS de las dos capas (B y C): la tabla es
 * append-oriented y capa C reescribe `clase` y `tipo` — un cambio de `clase` flipearía la columna
 * generada `es_propuesta` y satisfaría en silencio la FK de tres columnas que `05` §5.1 diseñó para
 * impedirlo. Del lado del motor eso lo hace estructural `ReconocimientoFinal`.
 *
 * 🔴 El orden de las cuatro consultas NO es intercambiable:
 *
 *   1. lock de la fila ACTIVA (`for update`) — serializa dos reprocesos concurrentes del mismo
 *      movimiento. Sin él, los dos leen "no hay activa" y los dos insertan.
 *   2. no-op: mismo digest ⇒ cero filas escritas (`05` §5.2). Va ANTES del paso 3 a propósito: si se
 *      dejara al `on conflict do nothing` del insert, el paso 3 ya habría dejado la FK diferida
 *      apuntando a una fila que nunca va a existir, y la transacción entera abortaría en el `commit`
 *      con un error de FK — correcto pero ilegible.
 *   3. supersesión ANTES del insert: al revés, las dos filas quedarían activas a la vez y el índice
 *      único parcial `where superseded_por is null` dispara en el acto (un índice no es diferible).
 *      Acá la FK apunta a una fila inexistente: por eso `fk_recon_superseded` es DEFERRABLE.
 *   4. insert. El `on conflict do nothing` es la guarda de carrera; si dispara, el digest ya está en
 *      la cadena y se corta con código.
 */
export async function persistirReconocimiento(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoDePersistirReconocimiento,
): Promise<ResultadoDePersistirReconocimiento> {
  // 🔴 `0021`: se traen DOS `entrada_digest` distintos y esa es la mitad del arreglo.
  //   - `entrada_persistida`: el que tenía el movimiento CUANDO se emitió el reconocimiento vigente
  //     (la foto histórica que copió el trigger).
  //   - `entrada_actual`: el que tiene el movimiento HOY (columna generada, se recalcula sola en
  //     cada UPDATE de la entrada).
  // Comparar los dos es lo que detecta un reproceso que cambió la entrada sin cambiar la clase.
  // Sale de la BASE y no de un cálculo en TypeScript a propósito: la columna generada es la fuente,
  // y así el no-op no puede divergir de la unicidad que lo respalda.
  const activas = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string; motor_digest: string; clase: string; entrada_persistida: string; entrada_actual: string }>(
      `select r.id::text as id, r.motor_digest, r.clase,
              r.entrada_digest as entrada_persistida,
              m.entrada_digest as entrada_actual
         from reconocimiento_movimiento r
         join movimiento_bancario_crudo m
           on m.cliente_id = r.cliente_id and m.id = r.movimiento_id
        where r.cliente_id = $1 and r.movimiento_id = $2 and r.superseded_por is null
        for update of r`,
      [pedido.clienteId, pedido.movimientoId],
    ),
  );
  const activa = activas[0];

  // 🔴 EL NO-OP COMPARA DIGEST **Y CLASE**, no solo el digest. Hallazgo independiente de
  // `qa-funcional` y `code-reviewer` (Ronda 3): capa C corre con el MISMO léxico y por lo tanto el
  // mismo digest que capa B, así que comparar solo el digest hacía que la PROMOCIÓN de capa C
  // —`decision_humana` → `propuesta` tras cargar el padrón— devolviera `no_op` y no se escribiera
  // NUNCA. El reporte imprimía `noOp: N, creados: 0` y parecía que había salido bien: fail-open y
  // silencioso, el mismo modo de falla que `version.ts` describe para un contador manual.
  //
  // La base ya estaba bien: `uq_recon_determinante` lleva `es_propuesta` como cuarta columna
  // justamente para admitir esa fila. Era el corto-circuito de acá el que la anulaba antes del
  // INSERT. Con `clase` en la comparación, la promoción entra por el camino UPDATE→INSERT y el
  // caso que el DDL declara fail-closed (mismo digest, misma clase, padrón distinto) sigue siendo
  // ruidoso.
  //
  // 🔴 `0021` CIERRA EL AGUJERO QUE ESTE COMENTARIO DECLARABA ABIERTO. Decía: «el determinante
  // cubre el CÓDIGO, no la ENTRADA, y la entrada es MUTABLE — `recapturar-conceptos.ts` y
  // `backfill-contraparte.ts` hacen UPDATE sobre `movimiento_bancario_crudo`; un reproceso que
  // cambie `concepto_banco` sin cambiar la clase sigue dando no-op con la interpretación vieja
  // intacta». Eso se MIDIÓ antes de escribir el DDL: **64 movimientos del corpus real** de 1830
  // cambiaban de entrada conservando la clase, o sea que quedaban con la interpretación vieja y un
  // `no_op` silencioso.
  //
  // La tercera condición es la que los rescata: si la entrada de HOY no es la que se usó para
  // emitir el reconocimiento vigente, NO es un no-op aunque el código y la clase coincidan — hay
  // que reconocer de nuevo y superseder. El caso `entrada_persistida === entrada_actual` es el
  // no-op verdadero, y sigue siendo el camino normal de un reproceso que no cambió nada.
  if (
    activa &&
    activa.motor_digest === pedido.motorDigest &&
    activa.clase === pedido.clase &&
    activa.entrada_persistida === activa.entrada_actual
  ) {
    return { estado: 'no_op', reconocimientoId: activa.id };
  }

  if (activa) {
    const cerradas = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `update reconocimiento_movimiento
            set superseded_por = $3
          where cliente_id = $1 and id = $2 and superseded_por is null
          returning id::text as id`,
        [pedido.clienteId, activa.id, pedido.reconocimientoId],
      ),
    );
    // H-14: RLS sin match da 0 filas, no excepción.
    if (!cerradas[0]?.id) throw new Error('La supersesión no devolvió id.');
  }

  const creadas = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into reconocimiento_movimiento
         (cliente_id, id, movimiento_id, motor_digest, clase, tipo, concepto, polaridad, lado, via,
          que_decide, motivo_codigo, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados,
          evidencia_hubo_cola)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       -- 0021: la tupla del ON CONFLICT es uq_recon_determinante, que ahora lleva entrada_digest.
       -- Nombrarla acá NO la inserta (la llena el trigger que copia la foto historica): en un ON
       -- CONFLICT se nombran las columnas del INDICE, no valores. Si esta lista deja de coincidir
       -- EXACTO con la unicidad, Postgres responde 42P10 y todo insert muere -- ruidoso, y es la
       -- razon por la que este renglon cambia si o si junto con el determinante.
       on conflict (cliente_id, movimiento_id, motor_digest, entrada_digest, es_propuesta) do nothing
       returning id::text as id`,
      [
        pedido.clienteId,
        pedido.reconocimientoId,
        pedido.movimientoId,
        pedido.motorDigest,
        pedido.clase,
        pedido.tipo,
        pedido.concepto,
        pedido.polaridad,
        pedido.lado,
        pedido.via,
        pedido.queDecide,
        pedido.motivoCodigo,
        pedido.entradaLexicoId,
        pedido.caracteresMatcheados,
        pedido.huboCola,
      ],
    ),
  );
  const id = creadas[0]?.id;
  if (!id) throw new ReconocimientoDigestYaEnLaCadenaError(pedido.clienteId, pedido.movimientoId);

  for (const entradaLexicoId of pedido.candidatos) {
    const fila = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `insert into reconocimiento_candidato (cliente_id, reconocimiento_id, entrada_lexico_id)
         values ($1, $2, $3)
         returning id::text as id`,
        [pedido.clienteId, id, entradaLexicoId],
      ),
    );
    if (!fila[0]?.id) throw new Error('El candidato del reconocimiento no devolvió id.'); // H-14
  }

  return activa
    ? { estado: 'supersedido', reconocimientoId: id, anteriorId: activa.id }
    : { estado: 'creado', reconocimientoId: id };
}

export type ResumenDePersistencia = {
  readonly creados: number;
  readonly supersedidos: number;
  readonly noOp: number;
};

/**
 * El lote entero en UNA transacción, y UNA línea de log al final.
 *
 * 🔴 Deliberadamente NO hay `logger.info` por movimiento: un lote son miles de filas y ese log es
 * exactamente el ruido que ADR-0002 H-8 existe para evitar — un rastro donde todo es interesante no
 * deja ver nada. Mismo criterio que `leerPadronDeSocios`, que no se audita fila por fila. La línea
 * final lleva conteos y el digest (identidad de CÓDIGO, N1); nunca `tipo` ni `concepto`, que son la
 * interpretación del movimiento de un cliente y están clasificados N2.
 */
export async function persistirReconocimientos(
  tx: Tx,
  ctx: ContextoAuditado,
  args: { readonly clienteId: string; readonly loteIngestaId: string; readonly motorDigest: string },
  pedidos: readonly PedidoDePersistirReconocimiento[],
): Promise<ResumenDePersistencia> {
  let creados = 0;
  let supersedidos = 0;
  let noOp = 0;

  for (const pedido of pedidos) {
    const r = await persistirReconocimiento(tx, ctx, pedido);
    if (r.estado === 'creado') creados += 1;
    else if (r.estado === 'supersedido') supersedidos += 1;
    else noOp += 1;
  }

  logger.info('reconocimiento.persistido', {
    cliente_id: args.clienteId,
    lote_ingesta_id: args.loteIngestaId,
    motor_digest: args.motorDigest,
    creados,
    supersedidos,
    no_op: noOp,
  });

  return { creados, supersedidos, noOp };
}
