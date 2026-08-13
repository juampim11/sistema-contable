/**
 * CLI DE BACKFILL DE CONTRAPARTE — completa `movimiento_contraparte_identificador` y
 * `movimiento_bancario_crudo.contraparte_captura` sobre un lote YA PERSISTIDO, leyendo los
 * identificadores que la satélite N2R de movimientos ya tiene guardados. Migración
 * `0013_contraparte_hmac_y_padron.sql`. Plan `adaptive-herding-pillow` (Módulo 2, primera etapa).
 *
 *     pnpm backfill:contraparte --cliente <uuid> --usuario <uuid> --lote-id <uuid>              (dry-run)
 *     pnpm backfill:contraparte --cliente <uuid> --usuario <uuid> --lote-id <uuid> --aplicar
 *
 * ## Por qué NO relee el PDF (a diferencia de `recapturar-conceptos.ts`)
 *
 * El identificador de la contraparte ya está persistido, en claro, en la satélite N2R desde que
 * el lote se ingirió — `depurarGlosa` siempre lo extrajo, aunque hasta esta migración nada lo
 * usara. No hace falta volver a storage ni al adaptador: alcanza con su lector auditado.
 *
 * ## Orden, en el orden en que corre
 *
 * 1. Guard R18.
 * 2. `leerInsumosDeBackfill` (Tx1, comitea): rol → ancla del lote → `leerConAuditoria` sobre la
 *    satélite N2R → `avisarSiLasLecturasSonAnomalas` → los digests de cuentas propias.
 * 3. `backfillearContraparteDeLote` (Tx2): TOCTOU + rol otra vez + centinela de idempotencia +
 *    (si `--aplicar`) el UPDATE + los INSERT de candidatos.
 *
 * **Un lote por corrida, siempre.** Sin `--forzar`, sin flag de waiver.
 */

import { z } from 'zod';
import { conUsuario, verificarCredencialDeRequest } from '@sistema-contable/data';
import {
  backfillearContraparteDeLote,
  leerInsumosDeBackfill,
  type MotivoAbortoBackfill,
  type ResultadoBackfill,
} from '@sistema-contable/ingesta';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

type CamposBackfill =
  | 'cliente_id'
  | 'usuario_id'
  | 'lote_id'
  | 'filas_del_lote'
  | 'leidas_de_n2r'
  | 'candidatos_totales'
  | 'sin_identificador'
  | 'capturado_cuenta_propia'
  | 'descartados_por_forma'
  | 'filas_actualizadas'
  | 'motivo_codigo'
  | 'causa_tipo';
const log = loggerAcotado<CamposBackfill>();

/** Nunca `error.message` crudo: este script tiene identificadores de terceros en memoria mientras
 *  corre. Solo el nombre del constructor (mismo patrón que `recapturar-conceptos.ts`). */
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
        '  pnpm backfill:contraparte --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--aplicar]\n\n' +
        '  Sin --aplicar: dry-run, nunca escribe. Con --aplicar: escribe si hay algo pendiente.\n' +
        '  Un lote por corrida, siempre — sin flag de waiver.',
    );
  }
  return r.data;
}

export const MOTIVOS_ABORTO_CLI = ['credencial_saltea_rls', 'contexto_no_aislado'] as const;

export type ResultadoBackfillContraparte =
  | ResultadoBackfill
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoBackfill | (typeof MOTIVOS_ABORTO_CLI)[number] };

/** Corre el backfill. Separado del CLI para que el test lo ejercite sin `process.exit`, mismo
 *  patrón que `recapturarConceptos()`. */
export async function backfillContraparte(args: Argumentos): Promise<ResultadoBackfillContraparte> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('backfill_contraparte.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const insumos = await leerInsumosDeBackfill(args.usuario, { clienteId: args.cliente, loteId: args.loteId });
  if (!insumos.ok) {
    log.warn('backfill_contraparte.abortado', {
      cliente_id: args.cliente,
      lote_id: args.loteId,
      motivo_codigo: insumos.motivoCodigo,
    });
    return { estado: 'abortado', motivoCodigo: insumos.motivoCodigo };
  }

  const resultado = await conUsuario(args.usuario, (tx) =>
    backfillearContraparteDeLote(
      tx,
      { clienteId: args.cliente, loteId: args.loteId, aplicar: args.aplicar },
      insumos.insumos,
    ),
  );

  if (resultado.estado === 'aplicado') {
    log.info('backfill_contraparte.aplicado', {
      cliente_id: args.cliente,
      lote_id: args.loteId,
      filas_actualizadas: resultado.filasActualizadas,
      candidatos_totales: resultado.conteo.candidatosTotales,
    });
  } else if (resultado.estado === 'listo') {
    log.info('backfill_contraparte.conteo', {
      cliente_id: args.cliente,
      lote_id: args.loteId,
      filas_del_lote: resultado.conteo.filasDelLote,
      leidas_de_n2r: resultado.conteo.leidasDeN2R,
      candidatos_totales: resultado.conteo.candidatosTotales,
      sin_identificador: resultado.conteo.sinIdentificador,
      capturado_cuenta_propia: resultado.conteo.capturadoCuentaPropia,
      descartados_por_forma: resultado.conteo.descartadosPorForma,
    });
  }

  return resultado;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/backfill-contraparte.ts');

if (esEjecucionDirecta) {
  const salto = String.fromCharCode(10);
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await backfillContraparte(args);
    process.stdout.write(`${JSON.stringify(r)}${salto}`);
    process.exit(r.estado === 'aplicado' || r.estado === 'listo' || r.estado === 'ya_backfilleado' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${salto}`);
    process.exit(2);
  }
}
