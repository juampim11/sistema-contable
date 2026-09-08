/**
 * CLI DE MANIFESTACIÓN DE PADRÓN COMPLETO — `packages/data/src/contabilidad/escrituras.ts`
 * (`manifestarPadron`), migraciones `0021`/`0041`/`0042`. Tanda 3 (`docs/diseno/31-replanteo-hacia-
 * producto.md`). Es el ÚNICO productor de `padron_manifestacion` — hasta este archivo, la tabla
 * existía sin nadie que la escribiera (0021: "NACE SIN PRODUCTOR").
 *
 *     pnpm manifestar:padron --cliente <uuid> --usuario <uuid> --completo-hasta YYYY-MM-DD
 *       [--revoca <manifestacion-id-anterior>]
 *
 *     pnpm manifestar:padron ... --aplicar
 *
 * ## Dry-run por defecto — SIEMPRE con el conteo de citas antes de tocar nada
 *
 * Sin `--aplicar`: lee la vigente actual (si hay), y si se pidió `--revoca`, cuenta cuántas filas de
 * `reconocimiento_contrapartida` citan HOY esa manifestación (`contarCitasDeManifestacion`) — es el
 * radio real del gesto, no una estimación. Nunca escribe.
 *
 * 🔴 **REVOCAR NO ES RETROACTIVO.** Las filas ya persistidas de `reconocimiento_contrapartida` siguen
 * citando la manifestación VIEJA para siempre (append-only, `0021`) — revocar solo impide que una fila
 * NUEVA la cite (`0041`). El conteo de citas de arriba es exactamente eso: cuántas filas van a seguir
 * apoyadas en la manifestación vieja después de este `--aplicar`, hasta que alguien vuelva a correr
 * `reconocer:lote --aplicar` sobre los lotes que las generaron (paso operativo APARTE, documentado en
 * `docs/diseno/31-replanteo-hacia-producto.md` §Tanda 3, con su propio backup y autorización — este
 * CLI nunca lo dispara solo).
 *
 * ## Por qué nunca revoca implícito
 *
 * Sin `--revoca`: si ya existe una vigente, ABORTA (`YaExisteManifestacionVigenteError`) — nunca
 * asume que la intención es reemplazarla. Con `--revoca <id>`: `<id>` tiene que ser EXACTAMENTE la
 * vigente actual en el momento del `--aplicar` (`RevocaNoEsLaVigenteError` si no) — mismo criterio que
 * `confirmar-asientos.ts`: nunca "lo que el operador creía", siempre "lo que hay ahora". Si dos
 * corridas concurrentes ganan la carrera de check-then-act de la pre-lectura, el índice único de
 * `0042` la detecta en el INSERT y este CLI la traduce (`RevocacionEnCarreraError`) en vez de dejar
 * pasar el `23505` genérico de Postgres.
 */

import { z } from 'zod';
import {
  cerrarConexiones,
  conUsuario,
  contarCitasDeManifestacion,
  escribirConAuditoria,
  leerManifestacionVigente,
  manifestarPadron,
  RevocaNoEsLaVigenteError,
  RevocacionEnCarreraError,
  verificarCredencialDeRequest,
  YaExisteManifestacionVigenteError,
  type ManifestacionVigente,
} from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);

type CamposManifestarPadron = 'cliente_id' | 'usuario_id' | 'motivo_codigo' | 'causa_tipo' | 'citas';
const log = loggerAcotado<CamposManifestarPadron>();

function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const BANDERAS = new Set(['aplicar']);

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
  usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
  completoHasta: z.string().regex(RE_FECHA, '--completo-hasta tiene que ser YYYY-MM-DD'),
  revoca: z.string().regex(RE_UUID, '--revoca tiene que ser un uuid').nullable(),
  aplicar: z.boolean(),
});
export type ArgumentosManifestarPadron = z.infer<typeof esquemaArgumentos>;

const MENSAJE_USO =
  `  node apps/cli/src/manifestar-padron.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --completo-hasta YYYY-MM-DD [--revoca <manifestacion-id-anterior>] [--aplicar]${SALTO}${SALTO}` +
  `  Sin --aplicar: dry-run — muestra la vigente actual y, si hay --revoca, cuántas filas la citan${SALTO}` +
  `  hoy. Nunca escribe. Con --aplicar: declara la manifestación (o la reemplaza, con --revoca).${SALTO}` +
  `  Revocar NO es retroactivo: las filas ya persistidas siguen citando la vieja hasta que se${SALTO}` +
  `  vuelva a correr reconocer:lote --aplicar sobre esos lotes (paso aparte, no lo hace este CLI).`;

export function parsearArgumentos(argv: readonly string[]): ArgumentosManifestarPadron {
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
    completoHasta: mapa.get('completo-hasta') ?? '',
    revoca: mapa.get('revoca') ?? null,
    aplicar: banderas.has('aplicar'),
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(`Argumentos inválidos (${faltan}).${SALTO}${SALTO}${MENSAJE_USO}`);
  }
  return r.data;
}

export type MotivoAbortoManifestarPadron =
  | 'credencial_saltea_rls'
  | 'contexto_no_aislado'
  | 'YA_EXISTE_MANIFESTACION_VIGENTE'
  | 'REVOCA_NO_ES_LA_VIGENTE'
  | 'REVOCACION_EN_CARRERA';

export type ReporteManifestarPadron = {
  readonly vigenteActual: ManifestacionVigente | null;
  /** `null` cuando no se pidió `--revoca` (no hay nada que contar); número cuando sí. */
  readonly citasDeLoQueSeVaARevocar: number | null;
};

export type ResultadoManifestarPadron =
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoManifestarPadron; readonly detalle?: string }
  | { readonly estado: 'dry_run'; readonly reporte: ReporteManifestarPadron }
  | { readonly estado: 'aplicado'; readonly reporte: ReporteManifestarPadron; readonly manifestacionId: string };

/** Separado del CLI para que el test lo ejercite sin `process.exit` — mismo patrón que
 *  `escribirAltaDeContraparte`/`confirmarAsientos`. */
export async function correrManifestarPadron(args: ArgumentosManifestarPadron): Promise<ResultadoManifestarPadron> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('manifestar_padron.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  // La lectura del reporte (vigente + conteo de citas) es SIEMPRE la misma, se aplique o no: el
  // dry-run y el --aplicar tienen que mostrar el mismo radio del gesto antes de decidir.
  const reporte = await conUsuario(args.usuario, async (tx): Promise<ReporteManifestarPadron> => {
    const vigenteActual = await leerManifestacionVigente(tx, { clienteId: args.cliente });
    const citasDeLoQueSeVaARevocar =
      args.revoca === null ? null : await contarCitasDeManifestacion(tx, { clienteId: args.cliente, manifestacionId: args.revoca });
    return { vigenteActual, citasDeLoQueSeVaARevocar };
  });

  if (!args.aplicar) {
    log.info('manifestar_padron.dry_run', {
      cliente_id: args.cliente,
      citas: reporte.citasDeLoQueSeVaARevocar ?? undefined,
    });
    return { estado: 'dry_run', reporte };
  }

  try {
    const r = await conUsuario(args.usuario, (tx) =>
      escribirConAuditoria(
        tx,
        {
          clienteId: args.cliente,
          accion: 'escritura',
          recurso: 'padron_manifestacion',
          motivo: 'manifestar-padron.ts: declaración/reemplazo de padrón completo (0021/0041/0042, Tanda 3)',
        },
        (ctx) =>
          manifestarPadron(tx, ctx, {
            clienteId: args.cliente,
            completoHasta: args.completoHasta,
            revocaId: args.revoca,
          }),
      ),
    );
    log.info('manifestar_padron.aplicado', { cliente_id: args.cliente });
    return { estado: 'aplicado', reporte, manifestacionId: r.manifestacionId };
  } catch (error) {
    if (error instanceof YaExisteManifestacionVigenteError) {
      log.error('manifestar_padron.abortado', { motivo_codigo: 'YA_EXISTE_MANIFESTACION_VIGENTE' });
      return { estado: 'abortado', motivoCodigo: 'YA_EXISTE_MANIFESTACION_VIGENTE', detalle: error.message };
    }
    if (error instanceof RevocaNoEsLaVigenteError) {
      log.error('manifestar_padron.abortado', { motivo_codigo: 'REVOCA_NO_ES_LA_VIGENTE' });
      return { estado: 'abortado', motivoCodigo: 'REVOCA_NO_ES_LA_VIGENTE', detalle: error.message };
    }
    if (error instanceof RevocacionEnCarreraError) {
      log.error('manifestar_padron.abortado', { motivo_codigo: 'REVOCACION_EN_CARRERA' });
      return { estado: 'abortado', motivoCodigo: 'REVOCACION_EN_CARRERA', detalle: error.message };
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/manifestar-padron.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));

    imprimir('');
    imprimir(`  Cliente          ${args.cliente}`);
    imprimir(`  Completo hasta   ${args.completoHasta}`);
    imprimir(`  Revoca           ${args.revoca ?? '(ninguna — primera manifestación)'}`);
    imprimir(`  Modo             ${args.aplicar ? 'APLICAR' : 'dry-run'}`);
    imprimir('');

    const r = await correrManifestarPadron(args);

    if (r.estado === 'abortado') {
      imprimir(`  ABORTA: ${r.motivoCodigo}`);
      if (r.detalle) imprimir(`    ${r.detalle}`);
      process.exit(1);
    }

    const { vigenteActual, citasDeLoQueSeVaARevocar } = r.reporte;
    imprimir(`  Vigente actual   ${vigenteActual ? `${vigenteActual.id} (completo_hasta ${vigenteActual.completoHasta})` : '(ninguna)'}`);
    if (citasDeLoQueSeVaARevocar !== null) {
      imprimir(`  Citas de la que se va a revocar   ${citasDeLoQueSeVaARevocar}`);
      imprimir('');
      imprimir('  🔴 REVOCAR NO ES RETROACTIVO: esas filas siguen citando la manifestación VIEJA hasta');
      imprimir('     que se vuelva a correr reconocer:lote --aplicar sobre los lotes que las generaron');
      imprimir('     — paso APARTE, con su propio backup y autorización, esto no lo dispara.');
    }
    imprimir('');

    if (r.estado === 'dry_run') {
      imprimir('  DRY-RUN: no se escribió nada. Volvé a correr con --aplicar.');
      imprimir('');
      process.exit(0);
    }

    imprimir('  Aplicado OK.');
    imprimir(`    manifestacion_id   ${r.manifestacionId}`);
    imprimir('');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
