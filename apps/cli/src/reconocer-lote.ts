/**
 * PERSISTIR EL RECONOCIMIENTO DE UN LOTE — migración `0014`. Plan `replicated-zooming-pine`, P1.
 *
 *     pnpm reconocer:lote --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--aplicar]
 *
 * Sin `--aplicar` es un DRY-RUN: corre el motor entero y reporta qué haría, sin escribir una fila.
 * Mismo criterio que `completar-lote.ts` y `recapturar-conceptos.ts` — el default de un comando que
 * escribe es no escribir.
 *
 * ## Qué lo separa de `resolver-contrapartida.ts`
 *
 * Aquel es y sigue siendo un dry-run puro: reporta la matriz de clases y no persiste. Este ESCRIBE.
 * Los dos corren el mismo motor; lo que cambia es que acá el resultado queda, con su `motor_digest`,
 * y una segunda corrida con el mismo digest es no-op en la BASE (`05` §5.2), no en un `if`.
 *
 * ## 🔴 Se escribe UNA vez, después de las DOS capas
 *
 * La tabla es append-oriented y capa C reescribe `clase` y `tipo`. Escribir capa B y "arreglarlo"
 * después obligaría a un UPDATE de `clase`, que flipearía la columna generada `es_propuesta` y
 * satisfaría en silencio la FK que `05` §5.1 diseñó para impedir que un pendiente tenga un asiento
 * colgado. `marcarCapaCCorrida()` lo hace visible en el tipo, no en un comentario.
 *
 * ## Lo que este comando NO hace todavía
 *
 * No persiste la EVIDENCIA de contrapartida (los 7 estados de `ResolucionDeContraparte`): esas
 * columnas las crea `0015`. El RESULTADO de capa C sí queda —está en `clase` y `tipo`— pero el POR QUÉ
 * no, así que los cinco estados que no promueven quedan indistinguibles entre sí hasta `0015`.
 * Declarado, no olvidado.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  leerEvidenciaDeMovimientos,
  leerManifestacionVigente,
  leerPadronDeContrapartes,
  leerPadronYCandidatosDeContraparte,
  leerReconocimientosActivos,
  persistirReconocimientos,
  verificarCredencialDeRequest,
  type Candidato,
  type ContraparteDelPadron,
  type EvidenciaDeMovimientoLeida,
  type PedidoDePersistirReconocimiento,
  type ManifestacionVigente,
  type SocioDelPadron as SocioDelPadronLeido,
} from '@sistema-contable/data';
import {
  aFilaPersistible,
  adjuntarEvidenciaDeContraparte,
  aplicarContrapartida,
  construirIndice,
  digestDeBanco,
  digestDeEntrada,
  idsDelLexico,
  lexicoDe,
  marcarCapaCCorrida,
  marcarPadronConsultado,
  reconocer,
  resolverContraparte,
  resolverEvidenciaDeContraparte,
  type CandidatoDeContraparte,
  type FilaDeReconocimiento,
  type IndiceDeLexico,
  type PatronDeContraparte,
  type SocioDelPadron,
} from '@sistema-contable/contabilidad';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { normalizar } from '@sistema-contable/shared/texto';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CamposReconocimiento =
  | 'cliente_id'
  | 'usuario_id'
  | 'lote_ingesta_id'
  | 'motor_digest'
  | 'total_movimientos'
  | 'aplicar'
  | 'motivo_codigo'
  | 'causa_tipo';
const log = loggerAcotado<CamposReconocimiento>();

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

function causaTipo(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'desconocido';
}

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  loteId: z.string().regex(RE_UUID),
  aplicar: z.boolean(),
});
export type ArgumentosReconocimiento = z.infer<typeof esquemaArgumentos>;

export function parsearArgumentos(argv: readonly string[]): ArgumentosReconocimiento {
  const mapa = new Map<string, string>();
  const banderas = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      if (clave === 'aplicar') {
        banderas.add(clave);
        continue;
      }
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('--')) {
        throw new Error(`El argumento --${clave} necesita un valor.`);
      }
      mapa.set(clave, valor);
      i += 1;
    }
  }

  const r = esquemaArgumentos.safeParse({
    cliente: mapa.get('cliente') ?? '',
    usuario: mapa.get('usuario') ?? '',
    loteId: mapa.get('lote-id') ?? '',
    aplicar: banderas.has('aplicar'),
  });
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).${SALTO}${SALTO}` +
        '  pnpm reconocer:lote --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--aplicar]',
    );
  }
  return r.data;
}

// -----------------------------------------------------------------------------
// Adaptadores entre los tipos de `contabilidad` y los de `data` (R-A/R-B: no se pueden importar
// entre sí — `apps/cli` es la única capa que ve los dos a la vez). Mismo rol que
// `comoSocioDelPadron` en `resolver-contrapartida.ts`.
// -----------------------------------------------------------------------------

function comoCandidatoDeContraparte(c: Candidato): CandidatoDeContraparte {
  return { clase: c.clase, hmac: c.identificadorHmac, pepperId: c.pepperId };
}

function comoPatronDeContraparte(p: ContraparteDelPadron): PatronDeContraparte {
  return { contraparteId: p.id, patron: p.patron, clasificacion: p.clasificacion as PatronDeContraparte['clasificacion'] };
}

function comoSocioDelPadron(s: SocioDelPadronLeido): SocioDelPadron {
  return {
    socioId: s.id,
    documentoHmac: s.documentoHmac,
    pepperId: s.pepperId,
    vigenteDesde: s.vigenteDesde,
    vigenteHasta: s.vigenteHasta,
  };
}

/**
 * El único lugar donde las dos listas de campos se tocan. **R-K** (`reglas-de-codigo.test.ts`) vigila
 * que no diverjan: sin esa regla, un campo agregado de un solo lado deja esta función compilando y la
 * columna nueva sin escribirse nunca.
 */
export function comoPedidoDePersistencia(
  fila: FilaDeReconocimiento,
  ids: {
    readonly clienteId: string;
    readonly movimientoId: string;
    readonly motorDigest: string;
    /** 🔴 `digestDeEntrada()` sobre la MISMA evidencia que consumió `reconocer()`. Es el testigo de
     *  la lectura que ya ocurrió, no una lectura nueva: eso es lo que permite que el escritor
     *  compare «lo que el motor leyó» contra «lo que la base tiene ahora». */
    readonly entradaDigest: string;
  },
  /** 🔴 `0038`: NUNCA sale de `fila`/`FilaDeReconocimiento` — sale del `Map` que arma el loop de
   *  `reconocerLote`, indexado por `movimientoId`, sobre `resolucion.estado` y una llamada local a
   *  `resolverEvidenciaDeContraparte`. Ver el comentario de `PedidoDePersistirReconocimiento.contrapartida`
   *  en `escrituras.ts` para el motivo completo (el campo equivalente en `Reconocimiento` queda
   *  `undefined` en la rama promovida). */
  contrapartida: PedidoDePersistirReconocimiento['contrapartida'],
): PedidoDePersistirReconocimiento {
  return {
    clienteId: ids.clienteId,
    movimientoId: ids.movimientoId,
    entradaDigest: ids.entradaDigest,
    // 🔴 uuid del cliente, no `default gen_random_uuid()`: la supersesión escribe `superseded_por`
    // apuntando a esta fila ANTES de que exista.
    reconocimientoId: randomUUID(),
    motorDigest: ids.motorDigest,
    clase: fila.clase,
    tipo: fila.tipo,
    concepto: fila.concepto,
    polaridad: fila.polaridad,
    lado: fila.lado,
    via: fila.via,
    queDecide: fila.queDecide,
    motivoCodigo: fila.motivoCodigo,
    entradaLexicoId: fila.entradaLexicoId,
    caracteresMatcheados: fila.caracteresMatcheados,
    huboCola: fila.huboCola,
    candidatos: fila.candidatos,
    contrapartida,
  };
}

function evidenciaDeMotorDesde(ev: EvidenciaDeMovimientoLeida) {
  return {
    bancoCodigo: ev.bancoCodigo,
    conceptoBanco: ev.conceptoBanco,
    conceptoCompleto: ev.conceptoCompleto,
    conceptoBancoEstrategia: ev.conceptoBancoEstrategia,
    conceptoCodigo: ev.conceptoCodigo,
    columnaOrigen: ev.columnaOrigen,
  };
}

// -----------------------------------------------------------------------------
// Orquestación
// -----------------------------------------------------------------------------

export type MotivoAbortoReconocimiento = 'credencial_saltea_rls' | 'contexto_no_aislado';

export type ReporteDeReconocimiento = {
  readonly estado: 'reportado';
  readonly aplicado: boolean;
  readonly porClase: Record<string, number>;
  /** 🔴 El reparto, que el agregado por clase esconde. `qa-funcional` (Ronda 3): "los tres números
   *  son idénticos si la cola son 1481 preguntas distintas o si son cuatro preguntas repetidas".
   *  Y `tech-lead` lo necesita para decidir si el delta contra la proyección del corpus es el signo
   *  de `importe` (`reversa_incoherente`) o el truncado de Galicia (`ambiguo`/`concepto_no_catalogado`). */
  readonly porQueDecide: Record<string, number>;
  readonly porMotivo: Record<string, number>;
  /** Cruce con el centinela de captura de contraparte: cuántos de los `distinguir_tercero_de_socio`
   *  NO tienen ningún candidato, o sea el PISO IRREDUCIBLE de la cola que ningún padrón baja. */
  readonly contrapartidaSinCandidato: number;
  readonly digestsPorBanco: Record<string, string>;
  /** Movimientos de un banco sin léxico registrado: se saltan, pero CONTADOS — sin esto el total no
   *  reflejaría el tamaño real del lote sin que el operador se entere. */
  readonly sinLexico: number;
  readonly yaVigentesConEsteDigest: number;
  readonly creados: number;
  readonly supersedidos: number;
  readonly noOp: number;
  /** 🔴 Carreras DETECTADAS, no errores: la entrada del movimiento cambió mientras corría el lote y
   *  su clasificación quedó obsoleta, así que no se escribió. La corrida siguiente los reconoce con
   *  la entrada nueva. Antes de `0021` esto se persistía mal y en silencio. */
  readonly entradaCambio: number;
  /** Determinantes que ya figuraban en la cadena. Antes abortaban el lote entero. */
  readonly digestYaEnLaCadena: number;
  /** 🔴 Tanda 3 (0041/0042): carreras DETECTADAS contra `manifestar-padron.ts --revoca` corriendo en
   *  paralelo — el pedido citaba una manifestación que otra transacción revocó mientras corría este
   *  lote (`P0004`). Como `entradaCambio`/`digestYaEnLaCadena`, un valor > 0 no es un error: la
   *  corrida siguiente reclasifica esos movimientos con el estado de manifestación vigente actual. */
  readonly manifestacionRevocadaDuranteLaCorrida: number;
};

export async function reconocerLote(
  args: ArgumentosReconocimiento,
): Promise<{ readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoReconocimiento } | ReporteDeReconocimiento> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('reconocer_lote.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  return conUsuario(args.usuario, async (tx) => {
    const evidencias = await leerEvidenciaDeMovimientos(tx, {
      clienteId: args.cliente,
      loteIngestaId: args.loteId,
    });

    const { padron, candidatosPorMovimiento } = await leerPadronYCandidatosDeContraparte(tx, {
      clienteId: args.cliente,
      movimientoIds: evidencias.map((e) => e.movimientoId),
    });
    const padronConsultado = marcarPadronConsultado(padron.map(comoSocioDelPadron));

    // padron_contraparte (0037) — leído una vez por lote, mismo criterio que el padrón de socios.
    const patronesDeContraparte = (await leerPadronDeContrapartes(tx, args.cliente)).map(comoPatronDeContraparte);

    // padron_manifestacion (0021/0041, Tanda 3) — leída UNA VEZ por lote, mismo criterio que el
    // padrón de contrapartes. `null` = nadie manifestó todavía para este cliente: el gate se evalúa
    // `false` para cada movimiento, mismo comportamiento conservador que regía antes de esta tarea.
    const manifestacion = await leerManifestacionVigente(tx, { clienteId: args.cliente });

    const activos = await leerReconocimientosActivos(tx, {
      clienteId: args.cliente,
      loteIngestaId: args.loteId,
    });
    const digestVigentePorMovimiento = new Map(activos.map((a) => [a.movimientoId, a.motorDigest]));

    const indices = new Map<string, IndiceDeLexico>();
    const validosPorBanco = new Map<string, ReadonlySet<string>>();
    const digestsPorBanco: Record<string, string> = {};

    const pedidos: PedidoDePersistirReconocimiento[] = [];
    const porClase: Record<string, number> = { propuesta: 0, decision_humana: 0, sin_reconocer: 0 };
    const porQueDecide: Record<string, number> = {};
    const porMotivo: Record<string, number> = {};
    let contrapartidaSinCandidato = 0;
    let sinLexico = 0;
    let yaVigentesConEsteDigest = 0;

    for (const ev of evidencias) {
      const lexico = lexicoDe(ev.bancoCodigo);
      if (!lexico) {
        sinLexico += 1;
        continue;
      }
      if (!indices.has(ev.bancoCodigo)) {
        indices.set(ev.bancoCodigo, construirIndice(lexico));
        validosPorBanco.set(ev.bancoCodigo, idsDelLexico(lexico));
        digestsPorBanco[ev.bancoCodigo] = digestDeBanco(lexico);
      }
      const digest = digestsPorBanco[ev.bancoCodigo] as string;

      // 🔴 Las dos capas ANTES de escribir, siempre. `marcarCapaCCorrida` lo vuelve estructural.
      const capaB = reconocer(evidenciaDeMotorDesde(ev), indices.get(ev.bancoCodigo) as IndiceDeLexico);
      let final = capaB;
      let contrapartida: PedidoDePersistirReconocimiento['contrapartida'] = null;
      if (capaB.clase === 'decision_humana' && capaB.queDecide === 'distinguir_tercero_de_socio') {
        const candidatos = (candidatosPorMovimiento.get(ev.movimientoId) ?? []).map(comoCandidatoDeContraparte);
        // Tanda 3 (docs/diseno/31-replanteo-hacia-producto.md) — el gate real, por fin. `ev.fecha`
        // como corte contra `manifestacion.completoHasta`, INCLUSIVE (`<=`, nunca `<`): no es una
        // elección de este archivo, es lo que ya exige `contrapartida_frescura_chk` (0021:
        // `padron_completo_hasta >= resuelto_a_fecha`) sobre la fila que se va a insertar — se usa
        // `ev.fecha` como `resueltoAFecha` más abajo y se deja que el CHECK de la base sea la
        // autoridad final del corte, nunca una segunda fuente de verdad reimplementada acá
        // (`contador-dominio`, convocatoria 2026-09-08). Si `manifestacion` es `null` (nadie
        // manifestó todavía, o el `--completo-hasta` no cubre `ev.fecha`), el gate da `false` — mismo
        // comportamiento conservador que regía antes de esta tarea.
        const padronCompleto = manifestacion !== null && ev.fecha <= manifestacion.completoHasta;
        const resolucion = resolverContraparte(candidatos, padronConsultado, ev.fecha, padronCompleto);
        // 🔴 `0039`: las DOS glosas candidatas, normalizadas acá — nunca en `contraparte.ts` (esa
        // función no normaliza nada). `conceptoBanco` se prueba primero; `descripcion` es el
        // fallback cuando el segmento de Capa B no llega al nombre (convocatoria 2026-09-06, corpus
        // real de Bracci: Galicia/Santander cortan antes del nombre, Bancor/ICBC/Nación ni capturan
        // `concepto_banco`).
        const glosas = { conceptoBanco: normalizar(ev.conceptoBanco ?? ''), descripcion: normalizar(ev.descripcion) };
        // 🔴 `0038`: se calcula ACÁ, sobre `resolucion.estado` directo — ANTES de que
        // `aplicarContrapartida` pueda promover `final` a `'propuesta'` — porque
        // `reconocimiento.evidenciaContraparte` queda `undefined` en esa rama (ver el comentario de
        // `reconocimiento.ts`). Es la MISMA llamada que hace `adjuntarEvidenciaDeContraparte` puertas
        // adentro; se duplica a propósito para no depender del campo que puede quedar sin llenar.
        const evidenciaContraparte = resolverEvidenciaDeContraparte(resolucion.estado, glosas, patronesDeContraparte);
        final = aplicarContrapartida(capaB, resolucion);
        final = adjuntarEvidenciaDeContraparte(final, resolucion.estado, glosas, patronesDeContraparte);
        // 🔴 Los dos campos son `null` salvo en la rama `es_tercero_padron_completo` — y en esa
        // rama, `manifestacion` NUNCA puede ser `null` (`padronCompleto` solo pudo dar `true` si
        // `manifestacion !== null`, arriba). `contrapartida_manifestacion_chk` (0021) exige
        // exactamente esta correspondencia; `fk_recon_contrapartida_alcance` exige que
        // `padronCompletoHasta` sea el `completo_hasta` REAL de la fila citada — nunca un valor
        // inventado ni recalculado, siempre el que devolvió `leerManifestacionVigente`.
        const citaManifestacion = resolucion.estado === 'es_tercero_padron_completo';
        contrapartida = {
          resolucionEstado: resolucion.estado,
          resueltoAFecha: ev.fecha,
          padronManifestacionId: citaManifestacion ? (manifestacion as ManifestacionVigente).id : null,
          padronCompletoHasta: citaManifestacion ? (manifestacion as ManifestacionVigente).completoHasta : null,
          patronContraparteEstado: evidenciaContraparte.estado,
          patronContraparteIds:
            evidenciaContraparte.estado === 'match' ? [evidenciaContraparte.contraparteId]
            : evidenciaContraparte.estado === 'multiples_patrones' ? evidenciaContraparte.contraparteIds
            : [],
          // 🔴 `0039`: origen SOLO en match/multiples_patrones — coincide con
          // contrapartida_patron_origen_coherencia_chk, que rechaza cualquier otra combinación.
          patronContraparteOrigen:
            evidenciaContraparte.estado === 'match' || evidenciaContraparte.estado === 'multiples_patrones'
              ? evidenciaContraparte.origen
              : null,
        };
      }

      porClase[final.clase] = (porClase[final.clase] ?? 0) + 1;
      if (final.clase === 'decision_humana') {
        porQueDecide[final.queDecide] = (porQueDecide[final.queDecide] ?? 0) + 1;
        if (final.queDecide === 'distinguir_tercero_de_socio' && ev.contraparteCaptura !== 'capturado') {
          contrapartidaSinCandidato += 1;
        }
      }
      if (final.clase === 'sin_reconocer') {
        porMotivo[final.motivo] = (porMotivo[final.motivo] ?? 0) + 1;
      }

      if (digestVigentePorMovimiento.get(ev.movimientoId) === digest) {
        yaVigentesConEsteDigest += 1;
      }

      const fila = aFilaPersistible(
        marcarCapaCCorrida(final),
        validosPorBanco.get(ev.bancoCodigo) as ReadonlySet<string>,
      );
      pedidos.push(comoPedidoDePersistencia(fila, {
        clienteId: args.cliente,
        movimientoId: ev.movimientoId,
        motorDigest: digest,
        // 🔴 Se calcula acá, en la MISMA iteración que llamó a `reconocer()`, sobre la MISMA fila
        // que se leyó. NO se relee la base: si se releyera, volvería exactamente el problema que
        // esto cierra. Y va sobre `ev` entera y no sobre `evidenciaDeMotorDesde(ev)` —que proyecta
        // sólo los seis campos de capa B— porque el principio es que el digest cubre TODO lo que el
        // motor puede leer, y lo que el motor puede leer ES `EvidenciaDeMovimientoLeida`.
        entradaDigest: digestDeEntrada(ev),
      }, contrapartida));
    }

    const base = {
      estado: 'reportado' as const,
      porClase,
      porQueDecide,
      porMotivo,
      contrapartidaSinCandidato,
      digestsPorBanco,
      sinLexico,
      yaVigentesConEsteDigest,
    };

    if (!args.aplicar) {
      log.info('reconocer_lote.dry_run', {
        cliente_id: args.cliente,
        lote_ingesta_id: args.loteId,
        total_movimientos: pedidos.length,
        aplicar: false,
      });
      return {
        ...base,
        aplicado: false,
        creados: 0,
        supersedidos: 0,
        noOp: 0,
        entradaCambio: 0,
        digestYaEnLaCadena: 0,
        manifestacionRevocadaDuranteLaCorrida: 0,
      };
    }

    // Un solo evento de auditoría por LOTE, no por movimiento: `recursoId` es el lote. Auditar cada
    // fila sería el ruido que ADR-0002 H-8 existe para evitar.
    const resumen = await escribirConAuditoria(
      tx,
      {
        clienteId: args.cliente,
        accion: 'escritura',
        recurso: 'reconocimiento_movimiento',
        recursoId: args.loteId,
        motivo: 'persistencia del reconocimiento del motor (Modulo 2, migracion 0014)',
      },
      (ctx) =>
        persistirReconocimientos(
          tx,
          ctx,
          {
            clienteId: args.cliente,
            loteIngestaId: args.loteId,
            motorDigest: Object.values(digestsPorBanco).join(','),
          },
          pedidos,
        ),
    );

    return {
      ...base,
      aplicado: true,
      creados: resumen.creados,
      supersedidos: resumen.supersedidos,
      noOp: resumen.noOp,
      entradaCambio: resumen.entradaCambio,
      digestYaEnLaCadena: resumen.digestYaEnLaCadena,
      manifestacionRevocadaDuranteLaCorrida: resumen.manifestacionRevocadaDuranteLaCorrida,
    };
  });
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/reconocer-lote.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await reconocerLote(args);
    imprimir(JSON.stringify(r, null, 2));
    if (r.estado === 'reportado' && !r.aplicado) {
      imprimir('');
      imprimir('  DRY-RUN: no se escribió ninguna fila. Volvé a correr con --aplicar.');
    }
    process.exit(r.estado === 'abortado' ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
