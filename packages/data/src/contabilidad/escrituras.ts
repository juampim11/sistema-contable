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
import { leerManifestacionVigente, MovimientoAjenoAlClienteError } from './lecturas.ts';

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
  /**
   * 🔴 EL DIGEST DE LA ENTRADA QUE EL MOTOR EFECTIVAMENTE LEYÓ, calculado por `digestDeEntrada()`
   * sobre la MISMA evidencia que consumió `reconocer()`. No es una lectura nueva de la base: es el
   * testigo de la lectura que ya ocurrió.
   *
   * Existe porque sin él nadie podía atar las dos lecturas de `entrada_digest` que hay en una
   * corrida —la del motor, en el primer statement, y la del trigger, en el insert— y bajo READ
   * COMMITTED están separadas por el lote entero.
   */
  readonly entradaDigest: string;
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
  /**
   * 🔴 Evidencia de capa C sobre `padron_contraparte` (migración `0038`), null cuando capa C no corrió
   * (`queDecide !== 'distinguir_tercero_de_socio'`). NO es un campo de `FilaDeReconocimiento` — R-K no
   * lo espeja, porque no sale de ahí: `reconocimiento.evidenciaContraparte` queda `undefined` en la
   * rama promovida (`es_socio` → `propuesta`, ver el comentario de `reconocimiento.ts`), así que
   * `apps/cli/src/reconocer-lote.ts` arma este campo directo desde `resolucion.estado` y una llamada
   * local a `resolverEvidenciaDeContraparte`, ANTES de que `aplicarContrapartida` pueda promover nada.
   *
   * `padronManifestacionId`/`padronCompletoHasta` — ANCHO A `string | null` desde la Tanda 3
   * (`docs/diseno/31-replanteo-hacia-producto.md`, convocatoria `seguridad-datos-financieros`
   * 2026-09-08): hasta acá estaban tipados `null` a secas, a propósito, para hacer IMPOSIBLE en el
   * tipo que Mitad 1 tocara Mitad 2 por accidente. El ensanche es deliberado, no un relajamiento —
   * sin él, `reconocer-lote.ts` promovería `es_tercero_padron_completo → propuesta` correctamente
   * pero seguiría persistiendo `padron_manifestacion_id = null`, perdiendo el rastro que `0021`
   * diseñó para responder "¿qué propuestas se apoyaron en ESTA manifestación?" en O(1). El CHECK de
   * la base (`contrapartida_manifestacion_chk`, 0021) sigue siendo la autoridad: exige que los dos
   * campos sean no-nulos exactamente cuando `resolucionEstado = 'es_tercero_padron_completo'`, y
   * `fk_recon_contrapartida_alcance` exige que `padronCompletoHasta` sea el `completo_hasta` REAL de
   * la manifestación citada — quien arma este objeto nunca inventa esos dos valores, los toma de
   * `leerManifestacionVigente` (`lecturas.ts`).
   */
  readonly contrapartida: null | {
    readonly resolucionEstado: string;
    readonly resueltoAFecha: string;
    readonly padronManifestacionId: string | null;
    readonly padronCompletoHasta: string | null;
    readonly patronContraparteEstado: string;
    readonly patronContraparteIds: readonly string[];
    /**
     * 🔴 `0039`. `'concepto_banco' | 'descripcion' | null` — CUÁL de las dos glosas produjo el match,
     * cuando `patronContraparteEstado` es `'match'`/`'multiples_patrones'`; `null` en los otros dos
     * estados (`no_aplica`/`sin_match`, nada que atribuir). `contrapartida_patron_origen_coherencia_chk`
     * (0039) fuerza esa misma correspondencia en la base — un valor que no coincida con el estado
     * aborta el INSERT con `23514`, nunca se persiste incoherente.
     */
    readonly patronContraparteOrigen: string | null;
  };
};

export type ResultadoDePersistirReconocimiento =
  | { readonly estado: 'no_op'; readonly reconocimientoId: string }
  | { readonly estado: 'creado'; readonly reconocimientoId: string }
  | { readonly estado: 'supersedido'; readonly reconocimientoId: string; readonly anteriorId: string }
  /**
   * 🔴 La entrada del movimiento CAMBIÓ entre que el motor la leyó y este momento, así que la
   * clasificación que trae el pedido es obsoleta y NO se escribe. No es un error del llamador ni de
   * los datos: es una carrera legítima contra `recapturar-conceptos.ts` o `backfill-contraparte.ts`.
   *
   * Se devuelve como ESTADO y no como excepción a propósito: el lote sigue, este movimiento se
   * cuenta, y la corrida siguiente lo reclasifica con la entrada nueva.
   */
  | { readonly estado: 'entrada_cambio_durante_la_corrida' }
  /**
   * 🔴 El determinante que se iba a escribir YA EXISTE en la cadena de este movimiento, en una fila
   * superseded. Antes esto lanzaba `ReconocimientoDigestYaEnLaCadenaError` DESPUÉS de haber aplicado
   * el `update` de supersesión, así que abortaba la transacción del lote entero — y el mensaje
   * culpaba a un cambio del léxico aunque la causa más frecuente sea otra (un padrón que se carga y
   * después se da de baja hace oscilar la `clase` con el mismo digest y la misma entrada).
   *
   * Ahora se detecta ANTES de tocar nada y se devuelve como estado: el lote sigue.
   */
  | { readonly estado: 'digest_ya_en_la_cadena'; readonly anteriorId: string };

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
  // 🔴 `0021`: la lectura arranca EN EL MOVIMIENTO y llega al reconocimiento por `left join`. Antes
  // era al revés —el movimiento entraba por un `join` interno— y eso dejaba sin comparación el caso
  // más frecuente: la PRIMERA corrida de un movimiento, donde todavía no hay reconocimiento vigente.
  //
  // Se traen DOS `entrada_digest` de la base, más el que declara el pedido:
  //   - `entrada_actual`: el que el movimiento tiene AHORA (la columna generada).
  //   - `entrada_persistida`: el que se registró cuando se emitió el reconocimiento vigente.
  //   - `pedido.entradaDigest`: el que el MOTOR LEYÓ para producir esta clasificación.
  // 🔴 DOS statements, y no un `left join` con `for update of r`: PostgreSQL **no admite FOR UPDATE
  // sobre el lado nullable de un outer join** (`0A000`). Partirlo además ordena mejor el trabajo —
  // el control de entrada corre ANTES de tomar ningún lock, así que un movimiento que se va a
  // descartar no bloquea a nadie.
  const delMovimiento = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ entrada_actual: string }>(
      `select entrada_digest as entrada_actual
         from movimiento_bancario_crudo
        where cliente_id = $1 and id = $2`,
      [pedido.clienteId, pedido.movimientoId],
    ),
  );
  const entradaActual = delMovimiento[0]?.entrada_actual;
  // H-14: la RLS sin match da 0 filas, no excepción. Un movimiento inexistente o de otro cliente
  // llega acá como AUSENCIA, y hay que nombrarlo antes de intentar escribir.
  if (entradaActual === undefined) {
    throw new MovimientoAjenoAlClienteError(pedido.clienteId, [pedido.movimientoId]);
  }

  // ---------------------------------------------------------------------------
  // 🔴 CONTROL A — lo que el motor LEYÓ contra lo que la base tiene AHORA.
  //
  // Si difieren, alguien reescribió la entrada (`recapturar-conceptos.ts`, `backfill-contraparte.ts`)
  // entre la lectura del motor y este momento, y la clasificación que traemos es OBSOLETA.
  // Persistirla dejaría una fila afirmando haberse calculado con una entrada que nunca vio — y como
  // el no-op compara `entrada_persistida` contra `entrada_actual`, esa fila daría `no_op` PARA
  // SIEMPRE con la interpretación vieja adentro. Es el bug de los 64 movimientos por otra puerta.
  //
  // ⚠️ NO SE LANZA: se devuelve un estado y el llamador sigue con el resto del lote. Lanzar acá
  // abortaría la transacción de ~1830 movimientos por uno solo. La corrida siguiente reclasifica
  // este movimiento con la entrada nueva y lo persiste normal.
  // ---------------------------------------------------------------------------
  if (pedido.entradaDigest !== entradaActual) {
    return { estado: 'entrada_cambio_durante_la_corrida' };
  }

  const activas = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string; motor_digest: string; clase: string; entrada_persistida: string }>(
      `select id::text as id, motor_digest, clase, entrada_digest as entrada_persistida
         from reconocimiento_movimiento
        where cliente_id = $1 and movimiento_id = $2 and superseded_por is null
        for update`,
      [pedido.clienteId, pedido.movimientoId],
    ),
  );
  const activa = activas[0] === undefined ? undefined : { ...activas[0], entrada_actual: entradaActual };

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

  // ---------------------------------------------------------------------------
  // 🔴 EL DETERMINANTE YA EN LA CADENA — SE DETECTA ANTES DE TOCAR NADA.
  //
  // Antes, este caso se descubría recién en el `on conflict do nothing` del INSERT, o sea DESPUÉS
  // de haber aplicado el `update` de supersesión: se lanzaba, la transacción del lote entero moría,
  // y el movimiento quedaba irreprocesable (`app_request` no tiene `update` sobre `clase` ni
  // `delete`).
  //
  // El camino que lo produce no es raro ni exótico: cargar el padrón y DESPUÉS dar de baja al socio
  // hace oscilar la clase `decision_humana → propuesta → decision_humana` con el MISMO
  // `motor_digest` y la MISMA entrada. El no-op compara `clase` (tres valores) y la unicidad usa
  // `es_propuesta` (dos), así que la tercera corrida decide superseder y choca contra la tupla de la
  // primera, que está superseded.
  //
  // Y el mensaje culpaba al léxico —que en ese camino nadie tocó— porque cuando se escribió, revertir
  // el léxico era la única forma de llegar acá. Con `entrada_digest` en el determinante hay más.
  // ---------------------------------------------------------------------------
  const enLaCadena = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `select id::text as id
         from reconocimiento_movimiento
        where cliente_id = $1 and movimiento_id = $2
          and motor_digest = $3 and entrada_digest = $4
          and es_propuesta = ($5::text = 'propuesta')
        limit 1`,
      [pedido.clienteId, pedido.movimientoId, pedido.motorDigest, pedido.entradaDigest, pedido.clase],
    ),
  );
  const yaEnLaCadena = enLaCadena[0]?.id;
  if (yaEnLaCadena !== undefined && yaEnLaCadena !== activa?.id) {
    return { estado: 'digest_ya_en_la_cadena', anteriorId: yaEnLaCadena };
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
         (cliente_id, id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto,
          polaridad, lado, via, que_decide, motivo_codigo, evidencia_entrada_lexico_id,
          evidencia_caracteres_matcheados, evidencia_hubo_cola)
       values ($1, $2, $3, $4, $16, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
        // $16 — `entrada_digest`. Va al final de la lista de parámetros y no en su posición del
        // INSERT a propósito: agregarlo en el medio habría renumerado los quince anteriores, que es
        // el cambio con más riesgo de error silencioso que se puede hacer en una query posicional.
        pedido.entradaDigest,
      ],
    ),
  );
  const id = creadas[0]?.id;
  if (!id) throw new ReconocimientoDigestYaEnLaCadenaError(pedido.clienteId, pedido.movimientoId);

  // ---------------------------------------------------------------------------
  // 🔴 `0038`: reconocimiento_contrapartida + su satélite de patrones — SOLO acá, DESPUÉS de que el
  // INSERT de arriba devolvió `id`. El gate es "¿el padre se insertó de verdad EN ESTA LLAMADA?", no
  // "¿capa C corrió?": si este código corriera antes del `if (!id) throw`, o si se moviera a una rama
  // de `no_op`/`entrada_cambio_durante_la_corrida`/`digest_ya_en_la_cadena`, `pedido.reconocimientoId`
  // NUNCA se insertó en `reconocimiento_movimiento` y `fk_recon_contrapartida_reconocimiento` abortaría
  // la transacción con `23503`. Es estructural, no una elección de estilo.
  // ---------------------------------------------------------------------------
  if (pedido.contrapartida) {
    const c = pedido.contrapartida;
    const contrapartidaFila = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `insert into reconocimiento_contrapartida
           (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase,
            padron_manifestacion_id, padron_completo_hasta, resuelto_a_fecha,
            patron_contraparte_estado, patron_contraparte_origen)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)
         returning id::text as id`,
        [
          pedido.clienteId, id, c.resolucionEstado, pedido.clase,
          c.padronManifestacionId, c.padronCompletoHasta, c.resueltoAFecha,
          c.patronContraparteEstado, c.patronContraparteOrigen,
        ],
      ),
    );
    const contrapartidaId = contrapartidaFila[0]?.id;
    if (!contrapartidaId) throw new Error('La contrapartida no devolvió id.'); // H-14

    // 🔴 NUNCA `on conflict` contra `uq_recon_contrapartida_patron_match_unico` (índice parcial): dejar
    // subir el `23505` si el productor calculó mal el régimen — ver el `comment on index` de `0038`.
    const regimen = c.patronContraparteIds.length > 1 ? 'varios' : 'patron_unico';
    for (const patronId of c.patronContraparteIds) {
      const filaPatron = await conErroresTraducidos(undefined, () =>
        tx.consultar<{ id: string }>(
          `insert into reconocimiento_contrapartida_patron_match
             (cliente_id, contrapartida_id, regimen_matches, padron_contraparte_id)
           values ($1, $2, $3, $4)
           returning id::text as id`,
          [pedido.clienteId, contrapartidaId, regimen, patronId],
        ),
      );
      if (!filaPatron[0]?.id) throw new Error('El match de patrón no devolvió id.'); // H-14
    }
  }

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

// -----------------------------------------------------------------------------
// Alta y baja de `padron_contraparte` (migración 0037)
// -----------------------------------------------------------------------------

/**
 * Mirror SIMPLIFICADO de `altaDeSocio`/`bajaDeSocio`: sin HMAC, sin pepper, sin satélite N2-R —
 * `patron` es N2 simple, un nombre comercial no es un identificador que habilite fraude (ADR-0002
 * §A.1), a diferencia del documento fiscal de un socio. Una sola tabla, un solo insert.
 */
export type PedidoDeAltaDeContraparte = {
  readonly clienteId: string;
  /** YA normalizado por el llamador (CLI), con `normalizar()` — mismo contrato que `altaDeSocio`
   *  con el documento: la normalización vive una sola vez, antes de que el valor llegue acá. */
  readonly patron: string;
  /** Dominio cerrado (`padron_contraparte_clasificacion_chk`); lo arbitra la base, mismo criterio
   *  que `tipo`/`concepto` en `PedidoDePersistirReconocimiento` — este paquete no importa la unión
   *  de `packages/contabilidad`. */
  readonly clasificacion: string;
  readonly vigenteDesde: string;
};

export type ResultadoAltaDeContraparte = { readonly contraparteId: string };

/**
 * Da de alta el patrón. Igual que `altaDeSocio`, sin rama de idempotencia: el índice único parcial
 * `uq_padron_contraparte_vigente` es sobre vigencia ACTIVA, y una segunda alta con el mismo patrón
 * activo es un error real (alta duplicada a mano), no un reproceso benigno. Se deja que Postgres lo
 * rechace; `conErroresTraducidos` lo traduce sin dato del patrón en el mensaje (F2,
 * `seguridad-datos-financieros`: nunca el `DETAIL` crudo de Postgres, que expondría `patron` en claro).
 */
export async function altaDeContraparte(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoDeAltaDeContraparte,
): Promise<ResultadoAltaDeContraparte> {
  const fila = await conErroresTraducidos(undefined, () =>
    tx.consultar<{ id: string }>(
      `insert into padron_contraparte (cliente_id, patron, clasificacion, vigente_desde)
       values ($1, $2, $3, $4::date)
       returning id::text as id`,
      [pedido.clienteId, pedido.patron, pedido.clasificacion, pedido.vigenteDesde],
    ),
  );
  const contraparteId = fila[0]?.id;
  if (!contraparteId) throw new Error('El alta de contraparte no devolvió id.'); // H-14

  // Sin `clasificacion`: 0037 la sube a N2 (mismo criterio que `cuenta_atributo.rol_funcional`) — el
  // tipo del logger la rechaza (mismo patrón que `denominacion`/`documento` en `altaDeSocio`).
  logger.info('alta_contraparte.creado', { cliente_id: pedido.clienteId });

  return { contraparteId };
}

export type PedidoDeBajaDeContraparte = {
  readonly clienteId: string;
  readonly contraparteId: string;
  readonly vigenteHasta: string;
};

export type MotivoBajaDeContraparte = 'BAJA_CONTRAPARTE_NO_ENCONTRADA';

export class BajaDeContraparteNoEncontradaError extends Error {
  readonly codigo: MotivoBajaDeContraparte = 'BAJA_CONTRAPARTE_NO_ENCONTRADA';
  readonly clienteId: string;
  readonly contraparteId: string;

  constructor(clienteId: string, contraparteId: string) {
    super(
      `No hay una contraparte con vigencia abierta para dar de baja (cliente ${clienteId}, ` +
        `contraparte ${contraparteId}).`,
    );
    this.name = 'BajaDeContraparteNoEncontradaError';
    this.clienteId = clienteId;
    this.contraparteId = contraparteId;
  }
}

/** Mismo motivo exacto que `BajaMismoDiaDeAltaError`: `padron_contraparte_vigencia_chk` exige
 *  `vigente_hasta > vigente_desde` ESTRICTO. */
export class BajaMismoDiaDeAltaContraparteError extends Error {
  readonly codigo = 'BAJA_MISMO_DIA_DE_ALTA' as const;

  constructor() {
    super(
      'No se puede cerrar la vigencia con la misma fecha (o una anterior) a la del alta — ' +
        'padron_contraparte exige vigente_hasta > vigente_desde. Si el error se detectó el mismo ' +
        'día de la carga, dar la baja con la fecha de MAÑANA.',
    );
    this.name = 'BajaMismoDiaDeAltaContraparteError';
  }
}

/**
 * Cierra la vigencia. Único UPDATE que el grant por columna permite. Un patrón mal cargado NO se
 * corrige con un UPDATE de `patron`/`clasificacion` (no hay grant): acá `patron` ES la clave
 * funcional de matching, así que un error de carga se corrige dando de baja la fila y dando de alta
 * una nueva con el valor correcto — más estricto que `padron_socio` (que sí permite corregir
 * `denominacion` por ser una etiqueta cosmética, no la clave de match).
 */
export async function bajaDeContraparte(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoDeBajaDeContraparte,
): Promise<{ readonly contraparteId: string }> {
  let filas: readonly { readonly id: string }[];
  try {
    filas = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `update padron_contraparte set vigente_hasta = $3::date
          where cliente_id = $1 and id = $2 and vigente_hasta is null
          returning id::text as id`,
        [pedido.clienteId, pedido.contraparteId, pedido.vigenteHasta],
      ),
    );
  } catch (error) {
    if (error instanceof ErrorDeBase && error.constraint === 'padron_contraparte_vigencia_chk') {
      throw new BajaMismoDiaDeAltaContraparteError();
    }
    throw error;
  }
  const id = filas[0]?.id;
  if (!id) throw new BajaDeContraparteNoEncontradaError(pedido.clienteId, pedido.contraparteId);

  logger.info('alta_contraparte.baja', { cliente_id: pedido.clienteId });
  return { contraparteId: id };
}

// -----------------------------------------------------------------------------
// Manifestación de padrón completo (migración 0021, gap cerrado por 0041/0042 — Tanda 3)
// -----------------------------------------------------------------------------

export type PedidoDeManifestarPadron = {
  readonly clienteId: string;
  readonly completoHasta: string;
  /** `null` = primera manifestación del cliente. Con valor: tiene que ser EXACTAMENTE la vigente
   *  actual — nunca "la que el operador cree que es", siempre la que la base tiene en ese instante. */
  readonly revocaId: string | null;
};

export type ResultadoDeManifestarPadron = { readonly manifestacionId: string };

/** Se pidió declarar SIN `--revoca` pero ya hay una vigente — nunca se revoca implícito. */
export class YaExisteManifestacionVigenteError extends Error {
  readonly codigo = 'YA_EXISTE_MANIFESTACION_VIGENTE' as const;
  readonly vigenteId: string;

  constructor(vigenteId: string) {
    super(
      `Ya existe una manifestación vigente (${vigenteId}) para este cliente. Si la intención es ` +
        `reemplazarla, volvé a correr con --revoca ${vigenteId}. Nunca se revoca implícito.`,
    );
    this.name = 'YaExisteManifestacionVigenteError';
    this.vigenteId = vigenteId;
  }
}

/**
 * `--revoca <id>` no coincide con la vigente actual — o porque nunca hubo vigente, o porque cambió
 * mientras el operador decidía (alguien más ya manifestó o revocó). Mismo criterio que
 * `confirmar-asientos.ts`: nunca "lo que el operador creía", siempre "lo que hay ahora".
 */
export class RevocaNoEsLaVigenteError extends Error {
  readonly codigo = 'REVOCA_NO_ES_LA_VIGENTE' as const;
  readonly revocaId: string;
  readonly vigenteActualId: string | null;

  constructor(revocaId: string, vigenteActualId: string | null) {
    super(
      vigenteActualId === null
        ? `Se pidió --revoca ${revocaId} pero no hay ninguna manifestación vigente para este cliente ` +
            `(alguien ya la revocó, o nunca existió). Volvé a correr sin --revoca para declarar la primera.`
        : `Se pidió --revoca ${revocaId} pero la vigente ACTUAL es ${vigenteActualId} — alguien la ` +
            `cambió mientras decidías. Volvé a correr con --revoca ${vigenteActualId}, o sin --revoca ` +
            `para ver el estado actual antes de decidir de nuevo.`,
    );
    this.name = 'RevocaNoEsLaVigenteError';
    this.revocaId = revocaId;
    this.vigenteActualId = vigenteActualId;
  }
}

/**
 * La pre-lectura de abajo vio "X es la vigente", pero OTRA corrida de `manifestar-padron.ts --revoca
 * X` ganó la carrera y comiteó primero — `uq_padron_manifestacion_revoca_a` (0042) es el backstop que
 * lo detecta (la pre-lectura es check-then-act, sin lock; el índice único es lo que de verdad cierra
 * la carrera). Nunca "reintentar solo": el operador tiene que VER el estado nuevo antes de decidir.
 */
export class RevocacionEnCarreraError extends Error {
  readonly codigo = 'REVOCACION_EN_CARRERA' as const;
  readonly revocaId: string;

  constructor(revocaId: string) {
    super(
      `Otra corrida revocó ${revocaId} justo antes que esta (carrera detectada por ` +
        `uq_padron_manifestacion_revoca_a, 0042). Volvé a correr manifestar-padron.ts sin --revoca ` +
        `para ver el estado actual y decidir de nuevo.`,
    );
    this.name = 'RevocacionEnCarreraError';
    this.revocaId = revocaId;
  }
}

/**
 * Declara (o reemplaza) la manifestación de padrón completo de un cliente. Grant por columna desde
 * `0021`: solo `cliente_id, completo_hasta, revoca_a` son elegibles — `manifestado_por`/`manifestado_en`
 * los pone la base (`app.current_user_id()`/`now()`), nunca el escritor (0021: "identidad declarada
 * no es identidad autenticada").
 *
 * La pre-lectura (`leerManifestacionVigente`) es SOLO para el mensaje de error accionable — es
 * check-then-act, con su propia carrera posible (dos corridas concurrentes, cada una viendo "X es la
 * vigente"). El control real es `uq_padron_manifestacion_revoca_a` (0042): si la pre-lectura no
 * alcanzó a detectar la carrera, el índice la detecta en el INSERT y este escritor la traduce a
 * `RevocacionEnCarreraError` en vez de dejar pasar el `23505` genérico.
 */
export async function manifestarPadron(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoDeManifestarPadron,
): Promise<ResultadoDeManifestarPadron> {
  const vigente = await leerManifestacionVigente(tx, { clienteId: pedido.clienteId });

  if (pedido.revocaId === null) {
    if (vigente !== null) throw new YaExisteManifestacionVigenteError(vigente.id);
  } else if (vigente === null || vigente.id !== pedido.revocaId) {
    throw new RevocaNoEsLaVigenteError(pedido.revocaId, vigente?.id ?? null);
  }

  let filas: readonly { readonly id: string }[];
  try {
    filas = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `insert into padron_manifestacion (cliente_id, completo_hasta, revoca_a)
         values ($1, $2::date, $3)
         returning id::text as id`,
        [pedido.clienteId, pedido.completoHasta, pedido.revocaId],
      ),
    );
  } catch (error) {
    if (error instanceof ErrorDeBase && error.constraint === 'uq_padron_manifestacion_revoca_a') {
      // Solo puede dispararse con `revoca_a is not null` (0042: `where revoca_a is not null`) — si
      // este catch corre, `pedido.revocaId` no puede ser `null`.
      throw new RevocacionEnCarreraError(pedido.revocaId as string);
    }
    throw error;
  }
  const id = filas[0]?.id;
  if (!id) throw new Error('La manifestación no devolvió id.'); // H-14

  logger.info('padron_manifestacion.manifestado', {
    cliente_id: pedido.clienteId,
    revoca: pedido.revocaId !== null,
  });

  return { manifestacionId: id };
}

export type ResumenDePersistencia = {
  readonly creados: number;
  readonly supersedidos: number;
  readonly noOp: number;
  /**
   * 🔴 Movimientos cuya ENTRADA cambió mientras corría el lote, así que su clasificación quedó
   * obsoleta y NO se escribió. **Un valor > 0 no es un error: es una carrera detectada.** Significa
   * que alguien corrió `recapturar-conceptos` o `backfill-contraparte` en paralelo, y que esos
   * movimientos hay que volver a reconocerlos — la corrida siguiente lo hace sola.
   *
   * Existe porque el modo de falla que reemplaza era SILENCIOSO: antes se persistía la
   * clasificación vieja con la entrada nueva estampada encima, y el movimiento quedaba dando
   * `no_op` para siempre.
   */
  readonly entradaCambio: number;
  /**
   * Movimientos cuyo determinante ya figuraba en la cadena, en una fila superseded. Antes esto
   * abortaba la transacción del lote entero; ahora se cuenta y el lote sigue.
   */
  readonly digestYaEnLaCadena: number;
  /**
   * 🔴 Tanda 3 (0041/0042). El pedido citaba una `padron_manifestacion_id` que OTRA transacción
   * revocó entre que este lote la leyó (`leerManifestacionVigente`, una vez al principio) y el
   * momento de este INSERT — `app.exigir_manifestacion_vigente()` lo rechazó con `P0004`
   * (`ErrorDeBase.codigo === 'ING_MANIFESTACION_REVOCADA'`). Mismo espíritu que
   * `entradaCambio`/`digestYaEnLaCadena`: **un valor > 0 no es un error, es una carrera legítima
   * detectada** — la corrida siguiente, con la manifestación vigente actual, reclasifica este
   * movimiento sin el gate de padrón completo (o con el de la manifestación nueva, si ya hay una).
   *
   * Requiere el SAVEPOINT por pedido de acá abajo: sin él, el `P0004` de UN movimiento dejaría la
   * transacción entera abortada y el resto del lote (potencialmente miles de filas) sin persistir.
   */
  readonly manifestacionRevocadaDuranteLaCorrida: number;
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
/**
 * 🔴 Nombre FIJO, nunca interpolado con un id de pedido — un `SAVEPOINT` no admite parámetros
 * ligados y este nombre nunca lleva un valor del pedido adentro (evitar por diseño la clase de
 * bug de inyección que interpolar un identificador de usuario en SQL abriría).
 *
 * Es seguro reusar el mismo nombre en cada vuelta del loop: `RELEASE SAVEPOINT` (camino feliz) y
 * `ROLLBACK TO SAVEPOINT` + `RELEASE SAVEPOINT` (camino de carrera) sacan el savepoint de la pila
 * antes de la siguiente vuelta, así que no se acumulan savepoints anidados a lo largo de un lote de
 * miles de filas.
 */
const SAVEPOINT_PERSISTIR_RECONOCIMIENTO = 'sp_persistir_reconocimiento';

export async function persistirReconocimientos(
  tx: Tx,
  ctx: ContextoAuditado,
  args: { readonly clienteId: string; readonly loteIngestaId: string; readonly motorDigest: string },
  pedidos: readonly PedidoDePersistirReconocimiento[],
): Promise<ResumenDePersistencia> {
  let creados = 0;
  let supersedidos = 0;
  let noOp = 0;
  let entradaCambio = 0;
  let digestYaEnLaCadena = 0;
  let manifestacionRevocadaDuranteLaCorrida = 0;

  for (const pedido of pedidos) {
    // 🔴 Tanda 3: SAVEPOINT por pedido. Sin esto, un `P0004` de `app.exigir_manifestacion_vigente()`
    // (0041) —el pedido citaba una manifestación que OTRA transacción revocó mientras corría este
    // lote— dejaría TODA la transacción del lote en estado abortado (comportamiento estándar de
    // Postgres: un error dentro de una transacción invalida todo lo que sigue hasta el próximo
    // ROLLBACK), perdiendo el trabajo de los demás pedidos ya procesados. Con el savepoint, solo se
    // deshace ESTE pedido y el lote sigue con el siguiente.
    await tx.consultar(`savepoint ${SAVEPOINT_PERSISTIR_RECONOCIMIENTO}`);
    try {
      const r = await persistirReconocimiento(tx, ctx, pedido);
      await tx.consultar(`release savepoint ${SAVEPOINT_PERSISTIR_RECONOCIMIENTO}`);
      if (r.estado === 'creado') creados += 1;
      else if (r.estado === 'supersedido') supersedidos += 1;
      else if (r.estado === 'entrada_cambio_durante_la_corrida') entradaCambio += 1;
      else if (r.estado === 'digest_ya_en_la_cadena') digestYaEnLaCadena += 1;
      else noOp += 1;
    } catch (error) {
      // Filtro ESTRICTO por código, no por instancia de Error ni por mensaje: solo `P0004`
      // (`ING_MANIFESTACION_REVOCADA`, ver `errores-pg.ts`) es una carrera legítima ya conocida.
      // Cualquier otro error —incluido uno sin traducir, como los `throw new Error(...)` de H-14
      // adentro de `persistirReconocimiento`— es fail-closed: se relanza y aborta el lote entero.
      // Elegir el código equivocado acá (por ejemplo, atrapar `ErrorDeBase` en general) taparía
      // bugs reales del resto del lote detrás de un contador que parece "todo controlado".
      if (error instanceof ErrorDeBase && error.codigo === 'ING_MANIFESTACION_REVOCADA') {
        await tx.consultar(`rollback to savepoint ${SAVEPOINT_PERSISTIR_RECONOCIMIENTO}`);
        await tx.consultar(`release savepoint ${SAVEPOINT_PERSISTIR_RECONOCIMIENTO}`);
        manifestacionRevocadaDuranteLaCorrida += 1;
        continue;
      }
      throw error;
    }
  }

  logger.info('reconocimiento.persistido', {
    cliente_id: args.clienteId,
    lote_ingesta_id: args.loteIngestaId,
    motor_digest: args.motorDigest,
    creados,
    supersedidos,
    no_op: noOp,
    entrada_cambio: entradaCambio,
    digest_ya_en_la_cadena: digestYaEnLaCadena,
    manifestacion_revocada_durante_la_corrida: manifestacionRevocadaDuranteLaCorrida,
  });

  return {
    creados,
    supersedidos,
    noOp,
    entradaCambio,
    digestYaEnLaCadena,
    manifestacionRevocadaDuranteLaCorrida,
  };
}
