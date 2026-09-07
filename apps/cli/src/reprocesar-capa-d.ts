/**
 * CLI DE REPROCESO DE CAPA D — cierra la Mitad 1 del plan `abundant-twirling-naur` (migración
 * `0040`, convocatoria completa 2026-09-07). Conecta los dos escritores nuevos
 * (`reprocesarAsientoNoRevisado`/`corregirAsientoEntregado`) con el selector real: dado que se
 * corrigió una `regla_imputacion`, encuentra todos los `asiento_propuesto` vigentes que citaban la
 * cuenta VIEJA de esa regla y los reprocesa con la cuenta NUEVA — Caso A si el asiento seguía
 * `'propuesto'`, Caso B si ya estaba `'confirmado'` (después de `confirmar-asientos.ts`, Paso 2).
 *
 *     pnpm reprocesar:capa-d --cliente <uuid> --usuario <uuid> \
 *       --regla-imputacion-anterior-id <uuid> --motivo "<prosa libre>"                    (dry-run)
 *     pnpm reprocesar:capa-d --cliente <uuid> --usuario <uuid> \
 *       --regla-imputacion-anterior-id <uuid> --motivo "<prosa libre>" --aplicar
 *
 * ## Por qué el selector es SOLO `--regla-imputacion-anterior-id` (no un segundo id de "regla nueva")
 *
 * `uq_regla_imputacion_vigente` (`0030`) garantiza que hay COMO MÁXIMO una regla ABIERTA
 * (`vigente_hasta is null`) por `(cliente, tipo_movimiento, concepto)`. Dado el id de la regla vieja,
 * la "regla nueva" es la única regla abierta que comparte su `(tipo_movimiento, concepto)` — la base
 * ya lo sabe con certeza; pedirle al operador que tipee un segundo id sería una fuente de error
 * humano redundante (`leerReglaSucesoraVigente`, `packages/data`).
 *
 * ## Por qué NO hay un modo "todo lo desactualizado" del cliente
 *
 * El selector está acotado a UNA regla puntual — la que motivó esta corrida. Reprocesar más de una
 * regla a la vez es una corrida más, con su propio dry-run y su propia autorización explícita.
 *
 * ## `--motivo-codigo` fijo, no un flag
 *
 * Esta herramienta corrige una `regla_imputacion` por definición — el único `motivoCodigo` posible
 * acá es `'correccion_criterio_estudio'`. `'dato_tardio_cliente'` (el otro valor del dominio cerrado
 * de `0040`) no tiene ningún flujo hoy — Mitad 1 quedó acotada a la corrección de esta semana (plan
 * `abundant-twirling-naur`). Un flag para un valor que ningún camino de este CLI puede producir sería
 * vocabulario muerto en la superficie de argumentos.
 *
 * ## Los dos renglones de cada escritura
 *
 * Caso A (reemplazo completo, mismo hecho económico recalculado): el renglón NO corregible del
 * original se copia tal cual; el renglón corregible pasa a citar la cuenta nueva, mismo lado/importe.
 * Caso B (el efecto NETO, nunca repite el original): dos renglones NUEVOS — uno revierte la cuenta
 * vieja (mismo importe, lado OPUESTO al renglón corregible original) y otro imputa la cuenta nueva
 * (mismo importe, mismo lado que el renglón corregible original). El renglón "otro" (típicamente el
 * banco) del asiento original NUNCA se repite en el ajuste — el movimiento de caja ya quedó bien
 * registrado la primera vez; solo la clasificación estaba mal.
 *
 * ## El reporte de dry-run — el gate real antes de `--aplicar`
 *
 * Muestra, siempre, la proporción de asientos afectados sobre EL TOTAL de asientos del cliente
 * (hallazgo de la convocatoria: para uno de los dos clientes reales del piloto esto ronda el 95%).
 * `--aplicar` no tiene flag de "confirmo que vi la proporción" — el número está ahí, en el dry-run,
 * antes de que el operador decida agregar `--aplicar` a la misma línea de comando.
 */

import { z } from 'zod';
import {
  cerrarConexiones,
  contarAsientosDelCliente,
  conUsuario,
  corregirAsientoEntregado,
  escribirConAuditoria,
  leerCandidatosDeReproceso,
  leerCierreAbiertoDelCliente,
  leerCuentaRefVigente,
  leerReglaImputacionPorId,
  leerReglaSucesoraVigente,
  reprocesarAsientoNoRevisado,
  verificarCredencialDeRequest,
  type CandidatoDeReproceso,
  type CuentaRef,
} from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
const MOTIVO_CODIGO = 'correccion_criterio_estudio' as const;

type CamposReprocesarCapaD =
  | 'cliente_id'
  | 'usuario_id'
  | 'regla_imputacion_anterior_id'
  | 'regla_imputacion_nueva_id'
  | 'asiento_id'
  | 'motivo_codigo'
  | 'causa_tipo'
  | 'total';
const log = loggerAcotado<CamposReprocesarCapaD>();

function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANDERAS = new Set(['aplicar']);

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
  usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
  reglaImputacionAnteriorId: z.string().regex(RE_UUID, 'el --regla-imputacion-anterior-id tiene que ser un uuid'),
  motivo: z.string().min(1, 'hace falta --motivo'),
  aplicar: z.boolean(),
});

export type ArgumentosReprocesarCapaD = z.infer<typeof esquemaArgumentos>;

const MENSAJE_USO =
  `  node apps/cli/src/reprocesar-capa-d.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --regla-imputacion-anterior-id <uuid> --motivo "<prosa libre>" [--aplicar]${SALTO}${SALTO}` +
  `  Sin --aplicar: dry-run, nunca escribe — muestra Caso A vs. Caso B y la proporción sobre el total` +
  `${SALTO}  de asientos del cliente. Con --aplicar: reprocesa lo que el dry-run mostró.`;

export function parsearArgumentos(argv: readonly string[]): ArgumentosReprocesarCapaD {
  const mapa = new Map<string, string>();
  const banderas = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      if (BANDERAS.has(clave)) {
        banderas.add(clave);
        continue;
      }
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('--')) {
        throw new Error(`El argumento --${clave} necesita un valor.${SALTO}${SALTO}${MENSAJE_USO}`);
      }
      mapa.set(clave, valor);
      i += 1;
    }
  }

  const crudo = {
    cliente: mapa.get('cliente') ?? '',
    usuario: mapa.get('usuario') ?? '',
    reglaImputacionAnteriorId: mapa.get('regla-imputacion-anterior-id') ?? '',
    motivo: mapa.get('motivo') ?? '',
    aplicar: banderas.has('aplicar'),
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(`Argumentos inválidos (${faltan}).${SALTO}${SALTO}${MENSAJE_USO}`);
  }
  return r.data;
}

export type MotivoAbortoReprocesarCapaD =
  | 'credencial_saltea_rls'
  | 'contexto_no_aislado'
  | 'regla_anterior_no_encontrada'
  | 'regla_anterior_no_es_fija'
  | 'regla_anterior_todavia_vigente'
  | 'sin_regla_sucesora'
  | 'regla_sucesora_no_es_fija'
  | 'cuenta_no_vigente_en_plan'
  | 'cierre_abierto_ambiguo';

export type FilaReporteReproceso = { readonly asientoId: string } & (
  | { readonly clasificacion: 'caso_a' }
  | { readonly clasificacion: 'caso_b' }
  | { readonly clasificacion: 'anomalo'; readonly motivoCodigo: string }
) &
  ({ readonly aplicado: false } | { readonly aplicado: true; readonly resultado: 'reemplazado' | 'ajustado' | 'conflicto' });

export type ResumenReproceso = {
  readonly totalAsientosCliente: number;
  readonly casoA: number;
  readonly casoB: number;
  readonly anomalos: number;
  /** `(casoA + casoB) / totalAsientosCliente`, formateado a un decimal — el número que el operador
   *  tiene que ver ANTES de poder `--aplicar` (hallazgo de la convocatoria: ronda 95% para uno de los
   *  dos clientes reales del piloto). */
  readonly proporcionSobreTotal: string;
};

export type ResultadoReprocesarCapaD =
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoReprocesarCapaD }
  | { readonly estado: 'dry_run'; readonly resumen: ResumenReproceso; readonly reporte: readonly FilaReporteReproceso[] }
  | { readonly estado: 'aplicado'; readonly resumen: ResumenReproceso; readonly reporte: readonly FilaReporteReproceso[] };

function opuesto(lado: 'debe' | 'haber'): 'debe' | 'haber' {
  return lado === 'debe' ? 'haber' : 'debe';
}

function hoyIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type Selector =
  | { readonly ok: false; readonly motivoCodigo: MotivoAbortoReprocesarCapaD }
  | {
      readonly ok: true;
      readonly reglaAnteriorId: string;
      readonly reglaNuevaId: string;
      readonly cuentaAnteriorId: string;
      readonly cuentaNuevaId: string;
      readonly candidatos: readonly CandidatoDeReproceso[];
      readonly anomalos: readonly { readonly asientoId: string; readonly motivoCodigo: string }[];
      readonly totalAsientosCliente: number;
    };

/** Un solo `conUsuario`, todo lectura — mismo criterio que `leerReconocimientosParaImputar` y el
 *  resto de `packages/data/src/cierre/lecturas.ts`: sin `ContextoAuditado`, nada ≥ N2-R acá. */
async function resolverSelector(args: ArgumentosReprocesarCapaD): Promise<Selector> {
  return conUsuario(args.usuario, async (tx): Promise<Selector> => {
    const reglaAnterior = await leerReglaImputacionPorId(tx, { clienteId: args.cliente, reglaImputacionId: args.reglaImputacionAnteriorId });
    if (!reglaAnterior) return { ok: false, motivoCodigo: 'regla_anterior_no_encontrada' };
    if (reglaAnterior.cuentaResolucion !== 'fija' || !reglaAnterior.cuentaId) {
      return { ok: false, motivoCodigo: 'regla_anterior_no_es_fija' };
    }
    if (reglaAnterior.vigenteHasta === null) {
      return { ok: false, motivoCodigo: 'regla_anterior_todavia_vigente' };
    }

    const reglaNueva = await leerReglaSucesoraVigente(tx, {
      clienteId: args.cliente,
      tipoMovimiento: reglaAnterior.tipoMovimiento,
      concepto: reglaAnterior.concepto,
      excluirReglaId: reglaAnterior.id,
    });
    if (!reglaNueva) return { ok: false, motivoCodigo: 'sin_regla_sucesora' };
    if (reglaNueva.cuentaResolucion !== 'fija' || !reglaNueva.cuentaId) {
      return { ok: false, motivoCodigo: 'regla_sucesora_no_es_fija' };
    }

    const { candidatos, anomalos } = await leerCandidatosDeReproceso(tx, { clienteId: args.cliente, cuentaAnteriorId: reglaAnterior.cuentaId });
    const totalAsientosCliente = await contarAsientosDelCliente(tx, { clienteId: args.cliente });

    return {
      ok: true,
      reglaAnteriorId: reglaAnterior.id,
      reglaNuevaId: reglaNueva.id,
      cuentaAnteriorId: reglaAnterior.cuentaId,
      cuentaNuevaId: reglaNueva.cuentaId,
      candidatos,
      anomalos,
      totalAsientosCliente,
    };
  });
}

async function aplicarCasoA(
  args: ArgumentosReprocesarCapaD,
  c: CandidatoDeReproceso,
  reglaAnteriorId: string,
  reglaNuevaId: string,
  cuentaNuevaId: string,
  refNueva: CuentaRef,
): Promise<'reemplazado' | 'conflicto'> {
  const r = await conUsuario(args.usuario, (tx) =>
    escribirConAuditoria(
      tx,
      { clienteId: args.cliente, accion: 'escritura', recurso: 'asiento_propuesto', motivo: 'reprocesar-capa-d.ts: Caso A (0040, Mitad 1)' },
      (ctx) =>
        reprocesarAsientoNoRevisado(tx, ctx, {
          clienteId: args.cliente,
          cierreId: c.cierreId,
          tipo: c.tipo,
          asientoViejoId: c.asientoId,
          fechaImputacion: c.fechaImputacion,
          renglones: [
            { cuentaId: c.renglonOtro.cuentaId, cuentaRef: c.renglonOtro.cuentaRef, lado: c.renglonOtro.lado, importe: c.renglonOtro.importe },
            { cuentaId: cuentaNuevaId, cuentaRef: refNueva, lado: c.renglonCorregible.lado, importe: c.renglonCorregible.importe },
          ],
          motivoCodigo: MOTIVO_CODIGO,
          reglaImputacionIdAnterior: reglaAnteriorId,
          reglaImputacionIdNueva: reglaNuevaId,
          motivo: args.motivo,
          hechoPor: args.usuario,
        }),
    ),
  );
  if (r.estado === 'reemplazado') {
    log.info('reprocesar_capa_d.reemplazado', { cliente_id: args.cliente, asiento_id: c.asientoId });
    return 'reemplazado';
  }
  log.warn('reprocesar_capa_d.conflicto', { cliente_id: args.cliente, asiento_id: c.asientoId, motivo_codigo: r.motivoCodigo });
  return 'conflicto';
}

async function aplicarCasoB(
  args: ArgumentosReprocesarCapaD,
  c: CandidatoDeReproceso,
  reglaAnteriorId: string,
  reglaNuevaId: string,
  cuentaAnteriorId: string,
  cuentaNuevaId: string,
  refVieja: CuentaRef,
  refNueva: CuentaRef,
  cierreIdActual: string,
): Promise<'ajustado'> {
  await conUsuario(args.usuario, (tx) =>
    escribirConAuditoria(
      tx,
      { clienteId: args.cliente, accion: 'escritura', recurso: 'asiento_propuesto', motivo: 'reprocesar-capa-d.ts: Caso B (0040, Mitad 1)' },
      (ctx) =>
        corregirAsientoEntregado(tx, ctx, {
          clienteId: args.cliente,
          cierreIdActual,
          asientoOriginalId: c.asientoId,
          fechaImputacion: hoyIso(),
          renglones: [
            {
              cuentaId: cuentaAnteriorId,
              cuentaRef: refVieja,
              lado: opuesto(c.renglonCorregible.lado),
              importe: c.renglonCorregible.importe,
            },
            { cuentaId: cuentaNuevaId, cuentaRef: refNueva, lado: c.renglonCorregible.lado, importe: c.renglonCorregible.importe },
          ],
          motivoCodigo: MOTIVO_CODIGO,
          reglaImputacionIdAnterior: reglaAnteriorId,
          reglaImputacionIdNueva: reglaNuevaId,
          motivo: args.motivo,
          hechoPor: args.usuario,
        }),
    ),
  );
  log.info('reprocesar_capa_d.ajustado', { cliente_id: args.cliente, asiento_id: c.asientoId });
  return 'ajustado';
}

/** Separado del CLI para que el test lo ejercite sin `process.exit` — mismo patrón que
 *  `escribirAltaDeContraparte`/`confirmarAsientos`. */
export async function reprocesarCapaD(args: ArgumentosReprocesarCapaD): Promise<ResultadoReprocesarCapaD> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('reprocesar_capa_d.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const sel = await resolverSelector(args);
  if (!sel.ok) {
    log.error('reprocesar_capa_d.abortado', { motivo_codigo: sel.motivoCodigo });
    return { estado: 'abortado', motivoCodigo: sel.motivoCodigo };
  }

  const clasificados: FilaReporteReproceso[] = [
    ...sel.candidatos.map(
      (c): FilaReporteReproceso => ({
        asientoId: c.asientoId,
        clasificacion: c.asientoEstado === 'propuesto' ? 'caso_a' : 'caso_b',
        aplicado: false,
      }),
    ),
    ...sel.anomalos.map(
      (a): FilaReporteReproceso => ({ asientoId: a.asientoId, clasificacion: 'anomalo', motivoCodigo: a.motivoCodigo, aplicado: false }),
    ),
  ];

  const casoA = sel.candidatos.filter((c) => c.asientoEstado === 'propuesto').length;
  const casoB = sel.candidatos.filter((c) => c.asientoEstado === 'confirmado').length;
  const proporcion =
    sel.totalAsientosCliente > 0 ? (((casoA + casoB) / sel.totalAsientosCliente) * 100).toFixed(1) + '%' : 'n/d (cliente sin asientos)';
  const resumen: ResumenReproceso = { totalAsientosCliente: sel.totalAsientosCliente, casoA, casoB, anomalos: sel.anomalos.length, proporcionSobreTotal: proporcion };

  log.info('reprocesar_capa_d.dry_run', {
    cliente_id: args.cliente,
    regla_imputacion_anterior_id: sel.reglaAnteriorId,
    regla_imputacion_nueva_id: sel.reglaNuevaId,
    total: sel.totalAsientosCliente,
  });

  if (!args.aplicar || sel.candidatos.length === 0) {
    return { estado: args.aplicar ? 'aplicado' : 'dry_run', resumen, reporte: clasificados };
  }

  const refs = await conUsuario(args.usuario, (tx) =>
    leerCuentaRefVigente(tx, { clienteId: args.cliente, cuentaIds: [sel.cuentaAnteriorId, sel.cuentaNuevaId] }),
  );
  const refVieja = refs.get(sel.cuentaAnteriorId);
  const refNueva = refs.get(sel.cuentaNuevaId);
  if (!refVieja || !refNueva) {
    return { estado: 'abortado', motivoCodigo: 'cuenta_no_vigente_en_plan' };
  }

  let cierreIdActual: string | null = null;
  if (casoB > 0) {
    const cierresAbiertos = await conUsuario(args.usuario, (tx) => leerCierreAbiertoDelCliente(tx, { clienteId: args.cliente }));
    if (cierresAbiertos.length !== 1) {
      return { estado: 'abortado', motivoCodigo: 'cierre_abierto_ambiguo' };
    }
    cierreIdActual = cierresAbiertos[0] as string;
  }

  const reporteAplicado: FilaReporteReproceso[] = [];
  for (const c of sel.candidatos) {
    if (c.asientoEstado === 'propuesto') {
      const resultado = await aplicarCasoA(args, c, sel.reglaAnteriorId, sel.reglaNuevaId, sel.cuentaNuevaId, refNueva);
      reporteAplicado.push({ asientoId: c.asientoId, clasificacion: 'caso_a', aplicado: true, resultado });
    } else {
      const resultado = await aplicarCasoB(
        args,
        c,
        sel.reglaAnteriorId,
        sel.reglaNuevaId,
        sel.cuentaAnteriorId,
        sel.cuentaNuevaId,
        refVieja,
        refNueva,
        cierreIdActual as string,
      );
      reporteAplicado.push({ asientoId: c.asientoId, clasificacion: 'caso_b', aplicado: true, resultado });
    }
  }
  for (const a of sel.anomalos) {
    reporteAplicado.push({ asientoId: a.asientoId, clasificacion: 'anomalo', motivoCodigo: a.motivoCodigo, aplicado: false });
  }

  return { estado: 'aplicado', resumen, reporte: reporteAplicado };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/reprocesar-capa-d.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));

    imprimir('');
    imprimir(`  Cliente                        ${args.cliente}`);
    imprimir(`  Regla de imputación anterior   ${args.reglaImputacionAnteriorId}`);
    imprimir(`  Modo                           ${args.aplicar ? 'APLICAR' : 'dry-run'}`);
    imprimir('');

    const r = await reprocesarCapaD(args);

    if (r.estado === 'abortado') {
      imprimir(`  ABORTA: ${JSON.stringify(r)}`);
      process.exit(1);
    }

    for (const fila of r.reporte) {
      imprimir(`  ${fila.asientoId}  ${JSON.stringify(fila)}`);
    }
    imprimir('');
    imprimir(`  total_asientos_cliente=${r.resumen.totalAsientosCliente}`);
    imprimir(`  caso_a=${r.resumen.casoA}  caso_b=${r.resumen.casoB}  anomalos=${r.resumen.anomalos}`);
    imprimir(`  proporcion_afectada_sobre_total=${r.resumen.proporcionSobreTotal}`);
    imprimir('');

    process.exit(0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
