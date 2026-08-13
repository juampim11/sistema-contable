/**
 * RECAPTURA DE CONCEPTOS — reprocesa un lote YA PERSISTIDO para backfillear `concepto_banco`,
 * `concepto_completo`, `concepto_banco_estrategia` y `pagina_pdf`, sin tocar `fecha`/`importe`/`saldo`/
 * `descripcion`/`fila_hash`. Plan `adaptive-herding-pillow`, primer consumidor real de
 * `lote_ingesta.adaptador_version` para "reproceso dirigido" (`0004_ingesta.sql`).
 *
 * Motivo: la migración `0007_concepto_banco.sql` agregó esas columnas DESPUÉS de que algunos lotes ya
 * estuvieran persistidos — la propia `ALTER TABLE` los backfilleó con `NULL`/`'no_capturado'`. Sin esto,
 * un lote viejo se queda sin el insumo de las reglas de clasificación para siempre.
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

type FilaPersistida = {
  readonly id: string;
  readonly cuentaBancariaId: string;
  readonly filaNumero: number;
  readonly filaHash: string;
  readonly descripcion: string;
};

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

  // Idempotencia: si NINGUNA fila está en 'no_capturado', ya se backfilleó — no-op limpio.
  const centinela = await tx.consultar<{ pendientes: number; total: number }>(
    `select count(*) filter (where concepto_banco_estrategia = 'no_capturado')::int as pendientes,
            count(*)::int as total
       from movimiento_bancario_crudo
      where cliente_id = $1 and lote_ingesta_id = $2`,
    [pedido.clienteId, pedido.loteId],
  );
  const { pendientes, total: totalPersistidoLote } = centinela[0] ?? { pendientes: 0, total: 0 };
  if (pendientes === 0) {
    return { estado: 'ya_backfilleado', loteId: pedido.loteId };
  }
  // `0 < pendientes < total` es estructuralmente imposible bajo todo-o-nada — si aparece, alguien
  // escribió por otra puerta. Las compuertas NO lo detectan (matchean por fila_hash, no por estrategia
  // persistida), así que el dry-run puede reportar 'listo' igual: el hallazgo recién sale a la luz en
  // `--aplicar`, cuando la fila ya capturada no matchea el WHERE del UPDATE y dispara B1 (throw, nunca
  // escritura parcial — seguro, pero no es el mismo 'sucio' prolijo de las demás compuertas).

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
  }>(
    `select id::text as id, cuenta_bancaria_id::text as cuenta_bancaria_id,
            fila_numero::int as fila_numero, fila_hash, descripcion
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

      // D — cross-check de orden/conteo de lectura.
      if (persistida.filaNumero !== m.filaNumero) {
        conteo.filaNumeroDiverge += 1;
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
            and m.concepto_banco_estrategia = 'no_capturado'
            and m.pagina_pdf is null
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
