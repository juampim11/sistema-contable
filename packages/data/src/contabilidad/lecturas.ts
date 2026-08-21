/**
 * LECTORES DEL MÓDULO 2, CAPA C (resolución de contrapartida) — migración 0013, ya aplicada al
 * piloto (ver HANDOFF). Cuatro piezas:
 *
 *   1. `leerDocumentoDeSocio` — el documento en claro de UN socio (N2-R, auditado). Histórica de
 *      esta etapa, sin cambios.
 *   2. `leerPadronDeSocios` / `leerCandidatosDeContraparte` — N2 puro, SIN `ContextoAuditado`: el
 *      motor las consulta en cada pasada (`0013:385-387`), auditar cada una sería el ruido que
 *      ADR-0002 H-8 existe para evitar. Devuelven tipos PROPIOS de este paquete — nunca los de
 *      `packages/contabilidad` (prohibición bidireccional, `reglas-de-codigo.test.ts:236-251`): la
 *      marca `PadronConsultado` ("el padrón se leyó de verdad") vive del lado de `contabilidad`
 *      (`nucleo/contrapartida.ts`, `marcarPadronConsultado`), y son las capas que importan los dos
 *      paquetes —hoy `apps/cli` y `packages/ingesta`, mismo motivo cada una: correr capa C fuera
 *      del motor puro— quienes envuelven el resultado de `leerPadronDeSocios` con ella,
 *      inmediatamente después de leer. Los adaptadores compartidos viven en
 *      `packages/ingesta/src/contraparte-adaptadores.ts`.
 *   3. `leerPadronYCandidatosDeContraparte` — orquestadora. Cierra H-6/INV-9: el `WHERE
 *      cliente_id=$1` + RLS forzada ya hacen estructuralmente imposible que las dos lecturas de
 *      arriba devuelvan una fila de otro cliente, así que el riesgo real es el LLAMADOR pasando un
 *      `movimientoId` que en realidad es de otro cliente — sin este chequeo esa fila desaparece en
 *      silencio del resultado (0 candidatos, indistinguible de un movimiento real sin evidencia).
 *      Verifica existencia contra `movimiento_bancario_crudo` con el `cliente_id` exacto, ANTES de
 *      tocar `padron_socio`/`movimiento_contraparte_identificador` — fail-closed.
 *   4. `leerEvidenciaDeMovimientos` — el lector plano que conecta `reconocer()` (capa B) con filas
 *      reales: nadie lo había escrito. `columnaOrigen` no es columna (solo vive en el JSONB N2-R de
 *      `movimiento_origen_crudo` — hallazgo de `backend-dev`), pero SÍ es derivable del signo de
 *      `importe`, que es N1/N2 plano (`0004_ingesta.sql`: "importe es SIGNADO... negativo = débito").
 *      Evita el N2-R por completo para este propósito.
 */

import { logger } from '@sistema-contable/shared/observabilidad';
import type { ClaseIdentificador, TipoDocumentoSocio } from '@sistema-contable/shared/seguridad';
import type { ContextoAuditado } from '../db/auditoria.ts';
import type { Tx } from '../db/conexion.ts';

export type DocumentoDeSocio = {
  readonly socioId: string;
  /** El documento en claro, normalizado a dígitos. Es el dato N2-R por el que existe este lector. */
  readonly documento: string;
};

/**
 * El documento en claro de UN socio. Se pide por `socioId` y no "todos los del cliente" — mismo
 * criterio que `leerFilasOrigenDeLote`: el rastro de auditoría queda con un alcance acotado y
 * verificable, y "traeme todo el padrón en claro" es exactamente la forma de un lector que
 * registra un evento que no dice nada.
 */
export async function leerDocumentoDeSocio(
  tx: Tx,
  _ctx: ContextoAuditado,
  args: { readonly clienteId: string; readonly socioId: string },
): Promise<DocumentoDeSocio | undefined> {
  const filas = await tx.consultar<{ socio_id: string; documento: string }>(
    `select socio_id, documento
       from padron_socio_documento
      where cliente_id = $1 and socio_id = $2`,
    [args.clienteId, args.socioId],
  );
  const fila = filas[0];
  if (!fila) return undefined;
  return { socioId: fila.socio_id, documento: fila.documento };
}

// -----------------------------------------------------------------------------
// leerPadronDeSocios
// -----------------------------------------------------------------------------

/** `id` (acá) vs. `socioId` (espejo en `packages/contabilidad/src/nucleo/contrapartida.ts`) es
 *  divergencia de CONVENCIÓN, no descuido — ver el docblock del otro lado. R-H bis (SocioDelPadron)
 *  en `reglas-de-codigo.test.ts` vigila los 4 campos que sí deben coincidir textualmente. */
export type SocioDelPadron = {
  readonly id: string;
  readonly documentoTipo: TipoDocumentoSocio;
  /** N2, no exportable como valor (`clasificacion-campos.ts`). Comparar con `hmacIguales`
   *  (timing-safe), nunca `===`/`Buffer.compare`. */
  readonly documentoHmac: Buffer;
  /** N2 enmascarado — seguro de mostrar/loguear. */
  readonly documentoUltimos4: string;
  readonly pepperId: string;
  readonly vigenteDesde: string;
  readonly vigenteHasta: string | null;
};

/**
 * El padrón COMPLETO de socios de un cliente — sin filtrar vigencia (la filtra el motor en
 * memoria, contra la fecha del movimiento, `0013:276-281`).
 *
 * NO trae `denominacion`: `resolverContraparte()` compara por `documentoHmac`, nunca por nombre —
 * el nombre es dato muerto para el motor, y así el reporte del CLI de dry-run (P6) estructuralmente
 * no puede imprimirlo, ni por accidente. Si en el futuro hace falta mostrarle el nombre a una
 * persona (por ejemplo, desambiguar `multiples_socios` en la cola de revisión), es una lectura
 * DISTINTA, dirigida por `socioId` puntual — no un parámetro opcional de esta.
 */
export async function leerPadronDeSocios(tx: Tx, clienteId: string): Promise<readonly SocioDelPadron[]> {
  const filas = await tx.consultar<{
    id: string;
    documento_tipo: string;
    documento_hmac: Buffer;
    documento_ultimos4: string;
    pepper_id: string;
    vigente_desde: string;
    vigente_hasta: string | null;
  }>(
    `select id, documento_tipo, documento_hmac, documento_ultimos4, pepper_id,
            vigente_desde::text as vigente_desde, vigente_hasta::text as vigente_hasta
       from padron_socio
      where cliente_id = $1
      order by vigente_desde`,
    [clienteId],
  );

  return filas.map((f) => ({
    id: f.id,
    documentoTipo: f.documento_tipo as TipoDocumentoSocio,
    documentoHmac: f.documento_hmac,
    documentoUltimos4: f.documento_ultimos4,
    pepperId: f.pepper_id,
    vigenteDesde: f.vigente_desde,
    vigenteHasta: f.vigente_hasta,
  }));
}

// -----------------------------------------------------------------------------
// leerCandidatosDeContraparte
// -----------------------------------------------------------------------------

export type Candidato = {
  readonly clase: ClaseIdentificador;
  /** N2, no exportable. HMAC con pepper DERIVADO POR CLIENTE — nunca comparar entre clientes. */
  readonly identificadorHmac: Buffer;
  readonly pepperId: string;
};

/** Cota defensiva contra un `any($2::uuid[])` armado con un array sin límite por un bug aguas
 *  arriba. El volumen real medido en el piloto es ~1830 movimientos por lote.
 *
 *  Exportada (no solo interna): un llamador que puede recibir lotes más grandes que este tope —hoy
 *  el export enriquecido de `packages/ingesta/src/planilla/exportar-planilla.ts`, cuyo propio tope
 *  de filas (`MAX_FILAS = 50_000`) es mayor que este— tiene que poder chequear ANTES de llamar y
 *  degradar con gracia, en vez de dejar que la función tire y arrastre con ella una fila de
 *  auditoría ya commiteada en la misma transacción (`security-engineer`, dictamen del plan "export
 *  enriquecido", 2026-08-21: un lote de 5.001 a 50.000 movimientos hoy es exportable sin enriquecer,
 *  y con el enriquecido sin este chequeo pasaría a lanzar dentro de la `tx` del export). */
export const MAX_MOVIMIENTOS_POR_LECTURA = 5_000;

function validarCantidadDeMovimientos(movimientoIds: readonly string[]): void {
  if (movimientoIds.length > MAX_MOVIMIENTOS_POR_LECTURA) {
    throw new Error(
      `Se pidieron candidatos de contraparte para ${movimientoIds.length} movimientos, más de ` +
        `${MAX_MOVIMIENTOS_POR_LECTURA}. Es más que cualquier lote real medido — probablemente un ` +
        'bug del llamador armando el array, no un lote legítimo.',
    );
  }
}

/**
 * Los candidatos de contraparte de un LOTE de movimientos, agrupados por `movimientoId` — cada
 * llamada a `resolverContraparte()` recibe solo los suyos.
 *
 * `where cliente_id=$1 and movimiento_id=any($2)`: usa `uq_mov_contraparte_candidato (cliente_id,
 * movimiento_id, pepper_id, clase, identificador_hmac)` — `cliente_id` y `movimiento_id` son sus
 * dos primeras columnas, así que resuelve con un Index Scan directo. NO filtra por `pepper_id` —
 * el parámetro no existe en la firma, a propósito: durante una rotación conviven candidatos
 * `v1`/`v2` del MISMO movimiento (`0013:156-160`), y filtrar acá perdería candidatos legítimos de
 * la otra versión. La intersección de `pepper_id` contra el padrón la hace `resolverContraparte()`
 * (código puro, testeado), no esta consulta.
 */
export async function leerCandidatosDeContraparte(
  tx: Tx,
  args: { readonly clienteId: string; readonly movimientoIds: readonly string[] },
): Promise<Map<string, readonly Candidato[]>> {
  validarCantidadDeMovimientos(args.movimientoIds);
  if (args.movimientoIds.length === 0) return new Map();

  const filas = await tx.consultar<{
    movimiento_id: string;
    clase: string;
    identificador_hmac: Buffer;
    pepper_id: string;
  }>(
    `select movimiento_id, clase, identificador_hmac, pepper_id
       from movimiento_contraparte_identificador
      where cliente_id = $1
        and movimiento_id = any($2::uuid[])
      order by movimiento_id, clase, identificador_hmac`,
    [args.clienteId, args.movimientoIds],
  );

  const porMovimiento = new Map<string, Candidato[]>();
  for (const f of filas) {
    const lista = porMovimiento.get(f.movimiento_id) ?? [];
    lista.push({
      clase: f.clase as ClaseIdentificador,
      identificadorHmac: f.identificador_hmac,
      pepperId: f.pepper_id,
    });
    porMovimiento.set(f.movimiento_id, lista);
  }
  return porMovimiento;
}

// -----------------------------------------------------------------------------
// leerPadronYCandidatosDeContraparte — orquestadora, cierra H-6/INV-9
// -----------------------------------------------------------------------------

/** Código estable para que el llamador decida sin parsear un mensaje — mismo idioma que
 *  `CodigoErrorPg` de `db/errores-pg.ts`. */
export const CODIGO_MOVIMIENTO_AJENO = 'MOV_AJENO_CLIENTE' as const;

export class MovimientoAjenoAlClienteError extends Error {
  // Asignadas a mano, no como parameter properties: el type-stripping de Node no las soporta
  // (mismo motivo que `ErrorDeBase`, `db/errores-pg.ts:55-58`).
  readonly codigo = CODIGO_MOVIMIENTO_AJENO;
  readonly clienteId: string;
  readonly movimientoIdsAjenos: readonly string[];

  constructor(clienteId: string, movimientoIdsAjenos: readonly string[]) {
    super(
      `${movimientoIdsAjenos.length} movimiento(s) no pertenecen al cliente ${clienteId} (o no ` +
        `existen). H-6/INV-9: se aborta ANTES de leer padrón o candidatos — dejarlo pasar en ` +
        'silencio devolvería "sin candidatos", indistinguible de un movimiento real sin evidencia.',
    );
    this.name = 'MovimientoAjenoAlClienteError';
    this.clienteId = clienteId;
    this.movimientoIdsAjenos = movimientoIdsAjenos;
  }
}

/**
 * Arma los dos insumos de `resolverContraparte()` para un lote, con el guardrail de H-6/INV-9. El
 * `WHERE cliente_id=$1` + RLS forzada YA garantizan que las dos lecturas de arriba nunca devuelven
 * una fila de otro cliente — repetirlo acá sería tautológico. El riesgo real es el LLAMADOR pasando
 * un `movimientoId` de otro cliente (typo, lote mal armado): sin este chequeo, esa fila desaparece
 * en silencio. Por eso se verifica EXISTENCIA explícita contra `movimiento_bancario_crudo` con el
 * `cliente_id` exacto, ANTES de tocar `padron_socio`/`movimiento_contraparte_identificador`.
 */
export async function leerPadronYCandidatosDeContraparte(
  tx: Tx,
  args: { readonly clienteId: string; readonly movimientoIds: readonly string[] },
): Promise<{
  readonly padron: readonly SocioDelPadron[];
  readonly candidatosPorMovimiento: Map<string, readonly Candidato[]>;
}> {
  const idsUnicos = [...new Set(args.movimientoIds)];
  validarCantidadDeMovimientos(idsUnicos);

  if (idsUnicos.length > 0) {
    const filas = await tx.consultar<{ id: string }>(
      `select id from movimiento_bancario_crudo where cliente_id = $1 and id = any($2::uuid[])`,
      [args.clienteId, idsUnicos],
    );
    const existentes = new Set(filas.map((f) => f.id));
    const ajenos = idsUnicos.filter((id) => !existentes.has(id));
    if (ajenos.length > 0) {
      logger.warn('contraparte.movimiento_ajeno', {
        cliente_id: args.clienteId,
        cantidad: ajenos.length,
        codigo: CODIGO_MOVIMIENTO_AJENO,
      });
      throw new MovimientoAjenoAlClienteError(args.clienteId, ajenos);
    }
  }

  const padron = await leerPadronDeSocios(tx, args.clienteId);
  const candidatosPorMovimiento = await leerCandidatosDeContraparte(tx, {
    clienteId: args.clienteId,
    movimientoIds: idsUnicos,
  });
  return { padron, candidatosPorMovimiento };
}

// -----------------------------------------------------------------------------
// leerEvidenciaDeMovimientos — conecta reconocer() (capa B) con filas reales del lote
// -----------------------------------------------------------------------------

export type EvidenciaDeMovimientoLeida = {
  readonly movimientoId: string;
  readonly bancoCodigo: string;
  readonly conceptoBanco: string | undefined;
  readonly conceptoCompleto: boolean | undefined;
  readonly conceptoBancoEstrategia: 'segmento_de_glosa' | 'prefijo_anclado' | 'columna_propia' | undefined;
  readonly conceptoCodigo: string | undefined;
  readonly columnaOrigen: 'credito' | 'debito';
  /** ISO `YYYY-MM-DD` — la fecha que `resolverContraparte()` usa para filtrar vigencia del padrón. */
  readonly fecha: string;
  readonly contraparteCaptura: 'no_capturado' | 'sin_identificador' | 'capturado' | 'capturado_cuenta_propia';
};

/**
 * Lectura N1/N2 plana (sin `ContextoAuditado`, sin rol) de un lote completo, con el `bancoCodigo`
 * resuelto desde `lote_ingesta` (join). `columnaOrigen` se DERIVA del signo de `importe`
 * (`0004_ingesta.sql`: "importe es SIGNADO... negativo = débito") — no hace falta leer el N2-R de
 * `movimiento_origen_crudo` para esto, a diferencia de lo que el hallazgo original de `backend-dev`
 * suponía. Único caso ambiguo: `importe = 0` (tipo `movimiento_en_cero`) no distingue de qué
 * columna vino — se resuelve arbitrariamente a `'credito'`, sin impacto real (un movimiento en cero
 * no tiene contrapartida patrimonial que capa C tenga que resolver).
 */
export async function leerEvidenciaDeMovimientos(
  tx: Tx,
  args: { readonly clienteId: string; readonly loteIngestaId: string },
): Promise<readonly EvidenciaDeMovimientoLeida[]> {
  const filas = await tx.consultar<{
    id: string;
    banco_codigo: string;
    concepto_banco: string | null;
    concepto_completo: boolean | null;
    concepto_banco_estrategia: string;
    concepto_codigo: string | null;
    importe: string;
    fecha: string;
    contraparte_captura: string;
  }>(
    `select m.id, li.banco_codigo, m.concepto_banco, m.concepto_completo, m.concepto_banco_estrategia,
            m.concepto_codigo, m.importe::text as importe, m.fecha::text as fecha, m.contraparte_captura
       from movimiento_bancario_crudo m
       join lote_ingesta li on li.cliente_id = m.cliente_id and li.id = m.lote_ingesta_id
      where m.cliente_id = $1 and m.lote_ingesta_id = $2
      order by m.fila_numero`,
    [args.clienteId, args.loteIngestaId],
  );

  return filas.map((f) => {
    const estrategiaCruda = f.concepto_banco_estrategia;
    const sinEstrategia = estrategiaCruda === 'no_capturado' || estrategiaCruda === 'no_publicado';
    return {
      movimientoId: f.id,
      bancoCodigo: f.banco_codigo,
      conceptoBanco: f.concepto_banco ?? undefined,
      conceptoCompleto: f.concepto_completo ?? undefined,
      conceptoBancoEstrategia: sinEstrategia
        ? undefined
        : (estrategiaCruda as EvidenciaDeMovimientoLeida['conceptoBancoEstrategia']),
      conceptoCodigo: f.concepto_codigo ?? undefined,
      columnaOrigen: Number(f.importe) < 0 ? 'debito' : 'credito',
      fecha: f.fecha,
      contraparteCaptura: f.contraparte_captura as EvidenciaDeMovimientoLeida['contraparteCaptura'],
    };
  });
}


// -----------------------------------------------------------------------------
// leerReconocimientosActivos (migración 0014)
// -----------------------------------------------------------------------------

export type ReconocimientoActivo = {
  readonly reconocimientoId: string;
  readonly movimientoId: string;
  readonly motorDigest: string;
  readonly clase: string;
};

/**
 * Los reconocimientos VIGENTES de un lote (`superseded_por is null`) — lo que le dice al llamador,
 * antes de procesar, cuántos movimientos ya están al día con el digest actual.
 *
 * Sin `ContextoAuditado`, mismo criterio que `leerPadronDeSocios`: se consulta en cada pasada del
 * motor, y auditar cada una sería el ruido de ADR-0002 H-8.
 *
 * NO devuelve `tipo` ni `concepto` — que están clasificados N2. El reproceso solo necesita saber QUÉ
 * digest tiene cada movimiento; traer la interpretación entera sería un lector con más alcance del que
 * su propósito justifica, y el alcance de más es lo que después alguien reusa para un listado. Para
 * pintar la cola de revisión va una lectura distinta, con su propia justificación.
 *
 * Usa `uq_recon_vigente`, el índice único PARCIAL de 0014: `(cliente_id, movimiento_id)
 * where superseded_por is null` sirve este predicado sin un índice extra.
 *
 * 🔴 `where cliente_id = $1` explícito ADEMÁS de la RLS forzada — cinturón y tiradores, igual que el
 * resto de este archivo.
 */
export async function leerReconocimientosActivos(
  tx: Tx,
  args: { readonly clienteId: string; readonly loteIngestaId: string },
): Promise<readonly ReconocimientoActivo[]> {
  const filas = await tx.consultar<{
    id: string;
    movimiento_id: string;
    motor_digest: string;
    clase: string;
  }>(
    `select r.id::text as id, r.movimiento_id::text as movimiento_id, r.motor_digest, r.clase
       from reconocimiento_movimiento r
       join movimiento_bancario_crudo m
         on m.cliente_id = r.cliente_id and m.id = r.movimiento_id
      where r.cliente_id = $1 and m.lote_ingesta_id = $2 and r.superseded_por is null
      order by r.movimiento_id`,
    [args.clienteId, args.loteIngestaId],
  );

  return filas.map((f) => ({
    reconocimientoId: f.id,
    movimientoId: f.movimiento_id,
    motorDigest: f.motor_digest,
    clase: f.clase,
  }));
}
