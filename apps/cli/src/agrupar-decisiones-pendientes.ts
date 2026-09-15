/**
 * CLI DELGADO de `agruparDecisionesPendientes` (`@sistema-contable/ingesta`, Frente 1). Vista de
 * inspección de las decisiones pendientes de un cliente en un rango de fechas — agrupadas por banco +
 * concepto, con la cuenta contable real cuando Capa D ya la resolvió. NUNCA escribe nada: no hay flag
 * de dry-run porque no hay nada que "aplicar" — esto no es `confirmar-grupo.ts`.
 *
 *     pnpm agrupar:decisiones-pendientes --cliente <uuid> --usuario <uuid> --desde <fecha> --hasta <fecha>
 *
 * Imprime el resultado como JSON por stdout — formato simple, esto no es un entregable para Laura
 * todavía (eso sigue siendo `armar-libro.ts`/el paquete de cierre, que arma el `.xlsx`).
 */

import { z } from 'zod';
import { agruparDecisionesPendientes } from '@sistema-contable/ingesta';
import { cerrarConexiones, conUsuario, verificarCredencialDeRequest } from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

type CamposAgruparDecisionesPendientesCli = 'cliente_id' | 'motivo_codigo' | 'causa_tipo';
const log = loggerAcotado<CamposAgruparDecisionesPendientesCli>();

/** Nunca `error.message` crudo — mismo patrón que el resto de `apps/cli/src/`. */
function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

const esquemaArgumentos = z
  .object({
    cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
    usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
    desde: z.string().regex(RE_FECHA_ISO, 'el --desde tiene que ser YYYY-MM-DD'),
    hasta: z.string().regex(RE_FECHA_ISO, 'el --hasta tiene que ser YYYY-MM-DD'),
  })
  .refine((a) => a.desde <= a.hasta, { message: '--desde tiene que ser anterior o igual a --hasta' });

export type ArgumentosAgruparDecisionesPendientes = z.infer<typeof esquemaArgumentos>;

const MENSAJE_USO =
  '  node apps/cli/src/agrupar-decisiones-pendientes.ts --cliente <uuid> --usuario <uuid> \\\n' +
  '    --desde <YYYY-MM-DD> --hasta <YYYY-MM-DD>';

export function parsearArgumentos(argv: readonly string[]): ArgumentosAgruparDecisionesPendientes {
  const mapa = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('--')) {
        throw new Error(`El argumento --${clave} necesita un valor.\n\n${MENSAJE_USO}`);
      }
      mapa.set(clave, valor);
      i += 1;
    }
  }

  const crudo = {
    cliente: mapa.get('cliente') ?? '',
    usuario: mapa.get('usuario') ?? '',
    desde: mapa.get('desde') ?? '',
    hasta: mapa.get('hasta') ?? '',
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0] ?? '(rango)')}: ${i.message}`).join('; ');
    throw new Error(`Argumentos inválidos (${faltan}).\n\n${MENSAJE_USO}`);
  }
  return r.data;
}

export type ResultadoCli =
  | { readonly estado: 'credencial_invalida'; readonly motivoCodigo: 'credencial_saltea_rls' | 'contexto_no_aislado' }
  | { readonly estado: 'abortado'; readonly motivoCodigo: string }
  | {
      readonly estado: 'ok';
      readonly clienteId: string;
      readonly clienteNombre: string;
      readonly desde: string;
      readonly hasta: string;
      readonly cantidadMovimientos: number;
      readonly grupos: readonly {
        readonly clave: string;
        readonly bancoCodigo: string;
        readonly conceptoBanco: string | null;
        readonly cantidad: number;
        readonly totalDebito: string;
        readonly totalCredito: string;
        readonly fechaDesde: string;
        readonly fechaHasta: string;
        readonly tipoDeMovimiento: string;
        readonly cuentaPropuesta: { readonly codigo: string; readonly denominacion: string } | null;
        readonly requiereRevision: boolean;
      }[];
    };

/** Separado del CLI para que un test lo ejercite sin `process.exit` — mismo patrón que
 *  `correrConfirmarGrupo`/`exportarExcel`. */
export async function correrAgruparDecisionesPendientes(args: ArgumentosAgruparDecisionesPendientes): Promise<ResultadoCli> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('agrupar_decisiones_pendientes_cli.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'credencial_invalida', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'credencial_invalida', motivoCodigo: 'contexto_no_aislado' };
  }

  const resultado = await conUsuario(args.usuario, (tx) =>
    agruparDecisionesPendientes(tx, { clienteId: args.cliente, desde: args.desde, hasta: args.hasta }),
  );

  if (resultado.estado === 'abortado') {
    log.warn('agrupar_decisiones_pendientes_cli.abortado', { cliente_id: args.cliente, motivo_codigo: resultado.motivoCodigo });
    return { estado: 'abortado', motivoCodigo: resultado.motivoCodigo };
  }

  log.info('agrupar_decisiones_pendientes_cli.ok', { cliente_id: args.cliente });
  return resultado;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/agrupar-decisiones-pendientes.ts');

if (esEjecucionDirecta) {
  const salto = String.fromCharCode(10);
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await correrAgruparDecisionesPendientes(args);
    process.stdout.write(`${JSON.stringify(r, null, 2)}${salto}`);
    process.exit(r.estado === 'ok' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${salto}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
