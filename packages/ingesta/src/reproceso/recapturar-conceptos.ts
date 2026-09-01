/**
 * RECAPTURA DE CONCEPTOS — reprocesa un lote YA PERSISTIDO para backfillear `concepto_banco`,
 * `concepto_completo`, `concepto_banco_estrategia` y `pagina_pdf`, sin tocar `fecha`/`importe`/`saldo`/
 * `descripcion`/`fila_hash`. Plan `adaptive-herding-pillow`, primer consumidor real de
 * `lote_ingesta.adaptador_version` para "reproceso dirigido" (`0004_ingesta.sql`).
 *
 * Motivo original: la migración `0007_concepto_banco.sql` agregó esas columnas DESPUÉS de que algunos
 * lotes ya estuvieran persistidos — la propia `ALTER TABLE` los backfilleó con `NULL`/`'no_capturado'`.
 * Sin esto, un lote viejo se queda sin el insumo de las reglas de clasificación para siempre.
 *
 * ## Segundo motivo, sumado 2026-09-01 (hallazgo ROKA): vocabulario incompleto, no solo columna vieja
 *
 * Un lote POSTERIOR a `0007` también puede quedar con `concepto_banco` ausente: el adaptador corrió con
 * el vocabulario que tenía en ese momento, no reconoció un prefijo, y persistió la fila como
 * `concepto_banco_estrategia = 'no_publicado'` — un hecho correcto en su momento, que deja de serlo
 * cuando el vocabulario del adaptador se corrige (caso real: `macro.ts` agregó el prefijo `'ING
 * TRANSF:'`, ausente hasta entonces, y dejó 45-49% de tres lotes reales de 2026 sin concepto).
 * `mov_crudo_concepto_coherencia_chk` (`0007_concepto_banco.sql`) ya representa `'no_capturado'` y
 * `'no_publicado'` con el mismo hecho observable — `concepto_banco is null` —, así que esta herramienta
 * trata ambas estrategias como "pendiente de recálculo" por igual: el recálculo mismo decide, fila por
 * fila, si el resultado sigue siendo `no_publicado` o si el vocabulario nuevo lo reconoce. Las filas que
 * YA tienen concepto (`prefijo_anclado`/`columna_propia`/`segmento_de_glosa`) siguen fuera de alcance —
 * nunca se recalculan ni se tocan.
 *
 * ## Por qué es una herramienta aparte de `completar-lote.ts`, no una extensión
 *
 * `completar-lote.ts` exige `estado='con_errores'` (una cuenta nunca se persistió) y su operación central
 * es un INSERT. Acá el lote ya está `procesado`/`procesado_con_observaciones` (todo se persistió) y la
 * operación es un UPDATE matcheado por `fila_hash`. Los guards de entrada son mutuamente excluyentes —
 * no es un flag, son dos herramientas (`tech-lead`, convocado en el plan).
 *
 * ## Todo o nada, sin flags de waiver
 *
 * Ninguna compuerta es negociable desde un argumento de línea de comando. Si el dry-run encuentra algo
 * sucio, la corrida se reporta `'sucio'` con el detalle — nunca escribe una fila parcial, y `--aplicar`
 * se niega a correr hasta que se decida qué hacer con el hallazgo (`security-engineer`: un flag de
 * waiver reabre el "todo o nada" por la puerta de atrás).
 *
 * ## La transacción
 *
 * Esta función recibe la `Tx` YA ABIERTA (mismo patrón que `exportarPlanillaDeLote`) y el PDF YA LEÍDO Y
 * VERIFICADO por `obtenerObjetoDeCliente` (`packages/almacenamiento/src/lectura.ts`) — nunca abre su
 * propia conexión ni toca storage. El llamador (el CLI) es responsable de que esa lectura haya ocurrido
 * ANTES, en su propia transacción ya comiteada (efecto no transaccional, mismo criterio que
 * `packages/data/src/db/auditoria.ts`).
 */

import { escribirConAuditoria, type Tx } from '@sistema-contable/data';
import { logger } from '@sistema-contable/shared/observabilidad';
import { contieneIdentificador, depurarGlosa } from '../glosa.ts';
import { resolverCuentaDelExtracto } from '../resolver-cuenta.ts';
import type { SalidaDeAdaptador } from '../adaptadores/registro.ts';

/** Roles habilitados para correr esta herramienta. Más estricto que `ROLES_QUE_DESCARGAN`
 *  (`['socio','contador']`) — decisión explícita del usuario para esta primera corrida, sobre el banco
 *  del 90% de la cartera. Ampliarlo después es un cambio de una línea, sin migración. */
export const ROLES_QUE_RECAPTURAN = ['socio'] as const;

export const MOTIVOS_ABORTO_RECAPTURA = [
  'lote_no_encontrado',
  'lote_no_recapturable',
  'rol_insuficiente',
  'integridad_cambio_entre_lecturas',
  'adapter_no_disponible',
  'banco_ambiguo',
  'banco_declarado_no_coincide',
  'sin_movimientos',
  'cuenta_no_resuelta',
] as const;
export type MotivoAbortoRecaptura = (typeof MOTIVOS_ABORTO_RECAPTURA)[number];

export type ConteoCompuertas = {
  readonly totalPersistido: number;
  readonly totalReleido: number;
  /** A — biyección por fila_hash, por cuenta. Nunca waivable. */
  readonly hashNoReproduce: number;
  /** B — prefijo INV-14 contra la descripción YA ALMACENADA. Nunca waivable. */
  readonly prefijoInv14Falla: number;
  /** C — ¿depurarGlosa cambió para este archivo? Informativo, nunca bloquea por sí solo. */
  readonly depuracionDivergente: number;
  /** D — cruce de fila_numero entre releído y persistido. Nunca waivable. */
  readonly filaNumeroDiverge: number;
  /** +1 — el concepto a escribir, o la descripción ya almacenada, contienen un identificador.
   *  SIEMPRE bloqueante — no es una decisión operativa, es un hallazgo de seguridad. */
  readonly identificadorEncontrado: number;
};

function compuertasLimpias(c: ConteoCompuertas): boolean {
  return (
    c.hashNoReproduce === 0 &&
    c.prefijoInv14Falla === 0 &&
    c.filaNumeroDiverge === 0 &&
    c.identificadorEncontrado === 0 &&
    c.totalReleido === c.totalPersistido
  );
}

export type PedidoRecaptura = {
  readonly clienteId: string;
  readonly loteId: string;
  /** El `archivo_hash` que ya validó `obtenerObjetoDeCliente` — se re-verifica acá (TOCTOU) contra lo que
   *  diga la base DENTRO de esta transacción. */
  readonly archivoHashEsperado: string;
  readonly bancoCodigo: string;
  readonly adaptadorVersion: number;
  /** `false` = dry-run: corre las compuertas, nunca escribe. `true` = si las compuertas dan limpias,
   *  escribe. */
  readonly aplicar: boolean;
};

export type ResultadoRecaptura =
  | { readonly estado: 'ya_backfilleado'; readonly loteId: string }
  | { readonly estado: 'listo'; readonly compuertas: ConteoCompuertas }
  | { readonly estado: 'sucio'; readonly compuertas: ConteoCompuertas }
  | {
      readonly estado: 'aplicado';
      readonly compuertas: ConteoCompuertas;
      readonly filasActualizadas: number;
      readonly adaptadorVersion: string;
    }
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoRecaptura };

/** `conceptoBancoEstrategia` es lo que decide, en el loop de abajo, si una fila ya capturada
 *  (`prefijo_anclado`/`columna_propia`/`segmento_de_glosa`) queda fuera de alcance de esta recaptura. */
type FilaPersistida = {
  readonly id: string;
  readonly cuentaBancariaId: string;
  readonly filaNumero: number;
  readonly filaHash: string;
  readonly descripcion: string;
  readonly conceptoBancoEstrategia: string;
};

/** Estrategias "pendiente de recálculo" — EXACTAMENTE el lado `null` de
 *  `mov_crudo_concepto_coherencia_chk` (`0007_concepto_banco.sql`: `(concepto_banco is null) =
 *  (concepto_banco_estrategia in ('no_capturado','no_publicado'))`). Cualquier otra estrategia de
 *  `ESTRATEGIAS_CONCEPTO` (`../esquema.ts`) significa "ya capturado" y queda fuera de alcance. */
const ESTRATEGIAS_PENDIENTES = new Set<string>(['no_capturado', 'no_publicado']);

export async function recapturarConceptosDeLote(
  tx: Tx,
  pedido: PedidoRecaptura,
  leido: SalidaDeAdaptador,
): Promise<ResultadoRecaptura> {
  // TOCTOU + serialización de dos corridas del operador: el ancla se bloquea acá.
  const anclaFilas = await tx.consultar<{ id: string; estado: string; archivo_hash: string }>(
    `select id::text as id, estado, archivo_hash
       from lote_ingesta
      where id = $1 and cliente_id = $2
      for update`,
    [pedido.loteId, pedido.clienteId],
  );
  const ancla = anclaFilas[0];
  if (!ancla) {
    return { estado: 'abortado', motivoCodigo: 'lote_no_encontrado' };
  }
  if (ancla.archivo_hash !== pedido.archivoHashEsperado) {
    return { estado: 'abortado', motivoCodigo: 'integridad_cambio_entre_lecturas' };
  }
  if (ancla.estado !== 'procesado' && ancla.estado !== 'procesado_con_observaciones') {
    return { estado: 'abortado', motivoCodigo: 'lote_no_recapturable' };
  }

  // Rol, DE NUEVO — la ventana entre la Tx de `obtenerObjetoDeCliente` y esta puede haber cambiado la
  // membership, y `mov_crudo_wr` por sí sola admite también `administrativo`.
  const rolFilas = await tx.consultar<{ puede: boolean }>(
    `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
    [pedido.clienteId, ROLES_QUE_RECAPTURAN],
  );
  if (rolFilas[0]?.puede !== true) {
    return { estado: 'abortado', motivoCodigo: 'rol_insuficiente' };
  }

  if (leido.cuentas.length === 0) {
    return { estado: 'abortado', motivoCodigo: 'sin_movimientos' };
  }

  // Idempotencia (paso 1, barato): si NINGUNA fila tiene `concepto_banco` NULL, no hay nada pendiente de
  // recálculo. `concepto_banco is null` es la MISMA condición que sostiene
  // `mov_crudo_concepto_coherencia_chk` (`0007_concepto_banco.sql`) — cubre `'no_capturado'` y
  // `'no_publicado'` sin enumerar la unión a mano, y sigue siendo correcta si el catálogo de estrategias
  // crece.
  const centinela = await tx.consultar<{ pendientes: number; total: number }>(
    `select count(*) filter (where concepto_banco is null)::int as pendientes,
            count(*)::int as total
       from movimiento_bancario_crudo
      where cliente_id = $1 and lote_ingesta_id = $2`,
    [pedido.clienteId, pedido.loteId],
  );
  const { pendientes, total: totalPersistidoLote } = centinela[0] ?? { pendientes: 0, total: 0 };
  if (pendientes === 0) {
    return { estado: 'ya_backfilleado', loteId: pedido.loteId };
  }
  // `0 < pendientes < total` YA NO es un caso imposible — es el caso NORMAL de un lote real: un banco
  // publica concepto en algunas filas y no en otras, así que "pendiente" (`no_capturado`/`no_publicado`)
  // y "ya capturado" (`prefijo_anclado`/`columna_propia`/`segmento_de_glosa`) conviven en el mismo lote
  // por diseño. Lo que sostiene que esto sea seguro es el guard "ya capturada, fuera de alcance" más
  // abajo: una fila ya capturada nunca llega a `aEscribir`, así que el `WHERE` del UPDATE final (que
  // sigue exigiendo `concepto_banco is null`) nunca la ve — sin ese guard, sí terminaría en `aEscribir`
  // y el UPDATE la dejaría afuera, disparando el `throw` de "todo o nada" con un lote real y mixto.

  // Resolver cada cuenta del documento y traer sus filas persistidas.
  const porCuentaReleida = new Map<string, SalidaDeAdaptador['cuentas'][number]>();
  for (const cuenta of leido.cuentas) {
    const periodoHasta = cuenta.cuenta.periodoHasta;
    if (periodoHasta === undefined) {
      return { estado: 'abortado', motivoCodigo: 'cuenta_no_resuelta' };
    }
    const resolucion = await resolverCuentaDelExtracto(tx, {
      clienteId: pedido.clienteId,
      numeroDeclarado: cuenta.cuenta.numero,
      alFecha: periodoHasta,
    });
    if (resolucion.estado !== 'resuelta') {
      return { estado: 'abortado', motivoCodigo: 'cuenta_no_resuelta' };
    }
    porCuentaReleida.set(resolucion.cuentaBancariaId, cuenta);
  }

  const persistidas = await tx.consultar<{
    id: string;
    cuenta_bancaria_id: string;
    fila_numero: number;
    fila_hash: string;
    descripcion: string;
    concepto_banco_estrategia: string;
  }>(
    `select id::text as id, cuenta_bancaria_id::text as cuenta_bancaria_id,
            fila_numero::int as fila_numero, fila_hash, descripcion, concepto_banco_estrategia
       from movimiento_bancario_crudo
      where cliente_id = $1 and lote_ingesta_id = $2
      order by cuenta_bancaria_id, fila_numero`,
    [pedido.clienteId, pedido.loteId],
  );

  const conteo: {
    hashNoReproduce: number;
    prefijoInv14Falla: number;
    depuracionDivergente: number;
    filaNumeroDiverge: number;
    identificadorEncontrado: number;
  } = {
    hashNoReproduce: 0,
    prefijoInv14Falla: 0,
    depuracionDivergente: 0,
    filaNumeroDiverge: 0,
    identificadorEncontrado: 0,
  };

  type PorEscribir = {
    readonly id: string;
    readonly conceptoBanco: string | null;
    readonly conceptoCompleto: boolean | null;
    readonly conceptoBancoEstrategia: string;
    readonly paginaPdf: number | null;
  };
  const aEscribir: PorEscribir[] = [];

  // Agrupar persistidas por cuenta, y dentro de cada cuenta indexar por fila_hash — el match es POR
  // CUENTA: `uq_mov_crudo_fila` es (cliente_id, cuenta_bancaria_id, fila_hash), así que el mismo hash
  // puede repetirse legítimamente en dos cuentas distintas del mismo documento.
  const persistidasPorCuenta = new Map<string, FilaPersistida[]>();
  for (const p of persistidas) {
    const arr = persistidasPorCuenta.get(p.cuenta_bancaria_id) ?? [];
    arr.push({
      id: p.id,
      cuentaBancariaId: p.cuenta_bancaria_id,
      filaNumero: p.fila_numero,
      filaHash: p.fila_hash,
      descripcion: p.descripcion,
      conceptoBancoEstrategia: p.concepto_banco_estrategia,
    });
    persistidasPorCuenta.set(p.cuenta_bancaria_id, arr);
  }

  let totalReleido = 0;
  for (const [cuentaBancariaId, cuentaReleida] of porCuentaReleida) {
    const persistidasDeLaCuenta = persistidasPorCuenta.get(cuentaBancariaId) ?? [];
    const porHash = new Map(persistidasDeLaCuenta.map((f) => [f.filaHash, f]));
    const matcheadas = new Set<string>();

    for (const m of cuentaReleida.movimientos) {
      totalReleido += 1;
      const persistida = porHash.get(m.filaHash);
      if (!persistida) {
        conteo.hashNoReproduce += 1;
        continue;
      }
      matcheadas.add(persistida.id);

      // D — cross-check de orden/conteo de lectura. Corre para TODA fila matcheada, capturada o no: es
      // la biyección del documento entero, no algo específico de recapturar concepto — degradarla para
      // las filas ya capturadas dejaría de proteger contra un documento reordenado o mal leído.
      if (persistida.filaNumero !== m.filaNumero) {
        conteo.filaNumeroDiverge += 1;
      }

      // Fuera de alcance: esta fila YA tiene concepto capturado (`prefijo_anclado`/`columna_propia`/
      // `segmento_de_glosa` — cualquier estrategia fuera de `ESTRATEGIAS_PENDIENTES`). El cross-check de
      // arriba (hash + fila_numero) ya corrió; lo único que se salta acá es recalcular/reescribir un
      // concepto que nadie pidió tocar. Sin este guard, esta fila terminaría en `aEscribir` y el UPDATE
      // final (que sigue exigiendo `concepto_banco is null`) no podría escribirla — el `throw` de "todo
      // o nada" con un lote real y mixto (el caso normal bajo el alcance ampliado), no de laboratorio.
      // Tiene que ir DESPUÉS de `matcheadas.add` (si no, la compuerta de biyección de abajo cuenta esta
      // fila como no-matcheada) y ANTES de recalcular nada (INV-14/identificador no tienen sujeto acá).
      if (!ESTRATEGIAS_PENDIENTES.has(persistida.conceptoBancoEstrategia)) {
        continue;
      }

      // C — informativo: ¿la depuración de la glosa cruda cambió para este archivo?
      const descripcionRedepurada = depurarGlosa(m.descripcion).descripcion;
      if (descripcionRedepurada !== persistida.descripcion) {
        conteo.depuracionDivergente += 1;
      }

      // El concepto a escribir, derivado de la glosa cruda releída — INV-14 se valida contra la
      // descripción YA ALMACENADA, nunca contra la recalculada.
      const conceptoBanco = m.conceptoBanco === undefined ? null : depurarGlosa(m.conceptoBanco).descripcion;

      if (conceptoBanco !== null) {
        if (contieneIdentificador(conceptoBanco)) {
          conteo.identificadorEncontrado += 1;
          continue;
        }
        if (
          m.conceptoBancoEstrategia !== 'columna_propia' &&
          !persistida.descripcion.startsWith(conceptoBanco)
        ) {
          conteo.prefijoInv14Falla += 1;
          continue;
        }
      }
      // La descripción YA ALMACENADA también puede llevar un identificador que la depuración de su
      // época no tapó — hallazgo de `seguridad-datos-financieros`: el check de la base no cubre esto
      // porque compara contra ese mismo valor viejo.
      if (contieneIdentificador(persistida.descripcion)) {
        conteo.identificadorEncontrado += 1;
        continue;
      }

      // Cuándo escribir, ahora que `no_capturado` Y `no_publicado` comparten este loop:
      // - `no_capturado` es TRANSITORIO — "ningún adaptador lo emite" (0007) — y tiene que reemplazarse
      //   SIEMPRE por un valor terminal, aunque el recálculo siga sin encontrar concepto (relabel a
      //   `no_publicado`, que sí es definitivo). Sin esto, una fila legacy sin concepto real quedaría
      //   mal etiquetada para siempre — la misma ambigüedad que 0007 agregó esta columna para eliminar.
      // - `no_publicado` YA ES terminal: si el recálculo confirma que sigue sin concepto, escribir el
      //   mismo valor no cambia nada, y el centinela (`concepto_banco is null`) la seguiría contando como
      //   pendiente en cada corrida futura, para siempre. Se escribe solo si el recálculo encontró algo.
      const eraTransitoria = persistida.conceptoBancoEstrategia === 'no_capturado';
      const encontroConceptoNuevo = conceptoBanco !== null;
      if (!eraTransitoria && !encontroConceptoNuevo) {
        continue;
      }

      aEscribir.push({
        id: persistida.id,
        conceptoBanco,
        conceptoCompleto: conceptoBanco === null ? null : (m.conceptoCompleto ?? null),
        conceptoBancoEstrategia: conceptoBanco === null ? 'no_publicado' : (m.conceptoBancoEstrategia ?? 'no_publicado'),
        paginaPdf: m.paginaPdf ?? null,
      });
    }

    // Toda fila persistida de esta cuenta tiene que haber matcheado alguna releída.
    conteo.hashNoReproduce += persistidasDeLaCuenta.filter((f) => !matcheadas.has(f.id)).length;
  }

  const compuertas: ConteoCompuertas = {
    totalPersistido: totalPersistidoLote,
    totalReleido,
    ...conteo,
  };

  if (!compuertasLimpias(compuertas)) {
    logger.warn('recapturar_conceptos.sucio', {
      cliente_id: pedido.clienteId,
      lote_id: pedido.loteId,
      hash_no_reproduce: compuertas.hashNoReproduce,
      prefijo_inv14_falla: compuertas.prefijoInv14Falla,
      fila_numero_diverge: compuertas.filaNumeroDiverge,
      identificador_encontrado: compuertas.identificadorEncontrado,
    });
    return { estado: 'sucio', compuertas };
  }

  // Idempotencia (paso 2, exacto): compuertas limpias, pero ninguna fila pendiente cambió — el caso
  // esperado de un lote `no_publicado` que sigue sin concepto tras el recálculo. Sin esto, el centinela
  // barato de arriba (`concepto_banco is null`) seguiría viendo `pendientes > 0` en la próxima corrida
  // para siempre, y cada `--aplicar` reescribiría los mismos valores sin converger nunca. Simétrico en
  // dry-run: si nada cambiaría, decirlo es más honesto que `'listo'`.
  if (aEscribir.length === 0) {
    return { estado: 'ya_backfilleado', loteId: pedido.loteId };
  }

  if (!pedido.aplicar) {
    return { estado: 'listo', compuertas };
  }

  const adaptadorVersion = `${pedido.bancoCodigo}@${pedido.adaptadorVersion}`;

  return escribirConAuditoria(
    tx,
    {
      clienteId: pedido.clienteId,
      accion: 'escritura',
      recurso: 'lote_ingesta',
      recursoId: pedido.loteId,
      motivo: `recapturar_conceptos:${adaptadorVersion}`,
    },
    async () => {
      const ids = aEscribir.map((f) => f.id);
      const conceptos = aEscribir.map((f) => f.conceptoBanco);
      const completos = aEscribir.map((f) => f.conceptoCompleto);
      const estrategias = aEscribir.map((f) => f.conceptoBancoEstrategia);
      const paginas = aEscribir.map((f) => f.paginaPdf);

      // `concepto_banco is null` por sí solo ya implica `concepto_banco_estrategia in ('no_capturado',
      // 'no_publicado')` — es literalmente lo que dice `mov_crudo_concepto_coherencia_chk`
      // (`0007_concepto_banco.sql`) — así que no hace falta repetir la unión acá. `pagina_pdf is null`
      // SE SACÓ a propósito: una fila `no_publicado` real (post-0007, el adaptador corrió y sí conoce la
      // página aunque no haya encontrado concepto) ya tiene `pagina_pdf` poblado desde la ingesta
      // original — exigir NULL acá excluiría justo las filas que este cambio existe para alcanzar. El
      // guard "ya capturada, fuera de alcance" de más arriba ya garantiza que `aEscribir` solo trae
      // filas con `concepto_banco` persistido NULL; `concepto_banco is null` acá es defensa en
      // profundidad (protege contra un TOCTOU dentro de esta misma transacción), no el único filtro.
      const actualizadas = await tx.consultar<{ id: string }>(
        `update movimiento_bancario_crudo m
            set concepto_banco = v.concepto_banco,
                concepto_completo = v.concepto_completo,
                concepto_banco_estrategia = v.concepto_banco_estrategia,
                pagina_pdf = v.pagina_pdf
           from unnest($1::uuid[], $2::text[], $3::boolean[], $4::text[], $5::int[])
                as v(id, concepto_banco, concepto_completo, concepto_banco_estrategia, pagina_pdf)
          where m.id = v.id
            and m.cliente_id = $6
            and m.lote_ingesta_id = $7
            and m.concepto_banco is null
          returning m.id::text as id`,
        [ids, conceptos, completos, estrategias, paginas, pedido.clienteId, pedido.loteId],
      );

      // Nunca `return` acá si esto no cierra: `conUsuario` comitea en cualquier return normal, y un
      // UPDATE ya emitido quedaría parcialmente escrito. `throw` fuerza el rollback de TODO.
      if (actualizadas.length !== aEscribir.length) {
        throw new Error(
          `recapturar_conceptos: el UPDATE afectó ${actualizadas.length} de ${aEscribir.length} filas esperadas.`,
        );
      }

      await tx.consultar(
        `update lote_ingesta set adaptador_version = $1 where id = $2 and cliente_id = $3`,
        [adaptadorVersion, pedido.loteId, pedido.clienteId],
      );

      logger.info('recapturar_conceptos.aplicado', {
        cliente_id: pedido.clienteId,
        lote_id: pedido.loteId,
        filas: actualizadas.length,
        adaptador_version: adaptadorVersion,
      });

      return {
        estado: 'aplicado' as const,
        compuertas,
        filasActualizadas: actualizadas.length,
        adaptadorVersion,
      };
    },
  );
}
