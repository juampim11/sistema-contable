/**
 * CLI DE RECLASIFICACIÓN DE CONTRAPARTE — vuelve a correr `depurarGlosa()` +
 * `extraerCandidatosDeContraparte()` con el código ACTUAL sobre la glosa cruda de un lote ya
 * persistido, para lotes ingeridos con una versión anterior del pipeline de extracción
 * (`VERSION_DEL_EXTRACTOR`, `packages/ingesta/src/version-extraccion.ts`).
 *
 *     pnpm reclasificar:contraparte --cliente <uuid> --usuario <uuid> --lote-id <uuid>              (dry-run)
 *     pnpm reclasificar:contraparte --cliente <uuid> --usuario <uuid> --lote-id <uuid> --aplicar
 *
 * ## En qué se diferencia de `backfill:contraparte`
 *
 * `backfill:contraparte` completa el histórico PRE-`0013`, releyendo `identificadores` ya
 * calculados correctamente. Este comando es para el caso contrario: el CÁLCULO de esos
 * `identificadores` tenía un bug cuando el lote se ingirió (caso real: `RE_CUIT` con el bug de `\b`,
 * corregido en `cb084a0`) y hace falta volver a correr `depurarGlosa()` desde la glosa cruda.
 *
 * ## Sin DELETE
 *
 * Solo agrega candidatos nuevos y corrige `contraparte_captura`. Nunca borra un candidato ya
 * persistido — ver `packages/ingesta/src/reproceso/reclasificar-contraparte.ts` para el porqué
 * (invariante append-only de `movimiento_contraparte_identificador`, `0013`).
 *
 * ## Orden, en el orden en que corre
 *
 * 1. Guard R18.
 * 2. `leerInsumosDeReclasificacion` (Tx1, comitea): rol → ancla del lote → `leerConAuditoria` sobre
 *    la satélite N2R → `avisarSiLasLecturasSonAnomalas` → digests de cuentas propias → estado
 *    persistido actual.
 * 3. `reclasificarContraparteDeLote` (Tx2): TOCTOU + rol otra vez + `calcularReclasificacion` (puro)
 *    + (si `--aplicar`) el UPDATE + los INSERT de candidatos nuevos.
 *
 * **Un lote por corrida, siempre.** Sin `--forzar`, sin flag de waiver.
 */

import { z } from 'zod';
import { conUsuario, verificarCredencialDeRequest } from '@sistema-contable/data';
import {
  leerInsumosDeReclasificacion,
  reclasificarContraparteDeLote,
  type MotivoAbortoReclasificacion,
  type ResultadoReclasificacion,
} from '@sistema-contable/ingesta';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

type CamposReclasificacion =
  | 'cliente_id'
  | 'usuario_id'
  | 'lote_id'
  | 'total_filas'
  | 'leidas_de_n2r'
  | 'sin_cambio'
  | 'candidatos_que_deberian_removerse'
  | 'descartados_por_forma'
  | 'filas_actualizadas'
  | 'motivo_codigo'
  | 'causa_tipo';
const log = loggerAcotado<CamposReclasificacion>();

/** Nunca `error.message` crudo: este script tiene identificadores de terceros en memoria mientras
 *  corre. Solo el nombre del constructor (mismo patrón que `backfill-contraparte.ts`). */
function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANDERAS = new Set(['aplicar']);

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
  usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
  loteId: z.string().regex(RE_UUID, 'el --lote-id tiene que ser un uuid'),
  aplicar: z.boolean(),
});

export type Argumentos = z.infer<typeof esquemaArgumentos>;

export function parsearArgumentos(argv: readonly string[]): Argumentos {
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
        throw new Error(`El argumento --${clave} necesita un valor.`);
      }
      mapa.set(clave, valor);
      i += 1;
    }
  }

  const crudo = {
    cliente: mapa.get('cliente') ?? '',
    usuario: mapa.get('usuario') ?? '',
    loteId: mapa.get('lote-id') ?? '',
    aplicar: banderas.has('aplicar'),
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).\n\n` +
        '  pnpm reclasificar:contraparte --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--aplicar]\n\n' +
        '  Sin --aplicar: dry-run, nunca escribe. Con --aplicar: escribe si hay algo pendiente.\n' +
        '  Un lote por corrida, siempre — sin flag de waiver.',
    );
  }
  return r.data;
}

export const MOTIVOS_ABORTO_CLI = ['credencial_saltea_rls', 'contexto_no_aislado'] as const;

export type ResultadoReclasificarContraparte =
  | ResultadoReclasificacion
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoReclasificacion | (typeof MOTIVOS_ABORTO_CLI)[number] };

/** Corre la reclasificación. Separado del CLI para que el test lo ejercite sin `process.exit`,
 *  mismo patrón que `backfillContraparte()`. */
export async function reclasificarContraparte(args: Argumentos): Promise<ResultadoReclasificarContraparte> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('reclasificar_contraparte.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const insumos = await leerInsumosDeReclasificacion(args.usuario, { clienteId: args.cliente, loteId: args.loteId });
  if (!insumos.ok) {
    log.warn('reclasificar_contraparte.abortado', {
      cliente_id: args.cliente,
      lote_id: args.loteId,
      motivo_codigo: insumos.motivoCodigo,
    });
    return { estado: 'abortado', motivoCodigo: insumos.motivoCodigo };
  }

  const resultado = await conUsuario(args.usuario, (tx) =>
    reclasificarContraparteDeLote(
      tx,
      { clienteId: args.cliente, loteId: args.loteId, aplicar: args.aplicar },
      insumos.insumos,
    ),
  );

  if (resultado.estado === 'aplicado') {
    log.info('reclasificar_contraparte.aplicado', {
      cliente_id: args.cliente,
      lote_id: args.loteId,
      filas_actualizadas: resultado.filasActualizadas,
    });
  } else if (resultado.estado === 'listo') {
    log.info('reclasificar_contraparte.reporte', {
      cliente_id: args.cliente,
      lote_id: args.loteId,
      total_filas: resultado.reporte.totalFilas,
      leidas_de_n2r: resultado.reporte.leidasDeN2R,
      sin_cambio: resultado.reporte.sinCambio,
      candidatos_que_deberian_removerse: resultado.reporte.candidatosQueDeberianRemoverse,
      descartados_por_forma: resultado.reporte.descartadosPorForma,
    });
  }

  return resultado;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/reclasificar-contraparte.ts');

if (esEjecucionDirecta) {
  const salto = String.fromCharCode(10);
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await reclasificarContraparte(args);
    process.stdout.write(`${JSON.stringify(r, null, 2)}${salto}`);
    if (r.estado === 'listo' && !args.aplicar) {
      process.stdout.write(`${salto}  DRY-RUN: no se escribió ninguna fila. Volvé a correr con --aplicar.${salto}`);
    }
    process.exit(r.estado === 'aplicado' || r.estado === 'listo' || r.estado === 'ya_reclasificado' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${salto}`);
    process.exit(2);
  }
}
