/**
 * CLI DE RECONCILIACIÓN — marca `asiento_propuesto.asiento_estado = 'confirmado'` sobre lo que JP
 * confirma que YA se entregó a la contadora. Reusa la transición `asiento_propuesto_upd_confirmar`
 * (`0027`) y el trigger de inmutabilidad post-terminal (`0028`) — no agrega ningún mecanismo nuevo de
 * base. Plan `abundant-twirling-naur` (Mitad 1 del reproceso de Capa D, Paso 2).
 *
 *     pnpm confirmar:asientos --cliente <uuid> --usuario <uuid> --asiento-id <uuid> [--asiento-id <uuid> ...]
 *     pnpm confirmar:asientos --cliente <uuid> --usuario <uuid> --asiento-id <uuid> ... --aplicar
 *
 * ## Por qué es la precondición del reproceso (Caso B)
 *
 * `asiento_estado` nunca sale de `'propuesto'` en producción hoy — nadie invoca esta transición
 * (hallazgo que reencuadró la convocatoria de `0040`: 1893/1893 asientos del piloto). Sin este CLI,
 * ningún asiento real puede clasificarse como Caso B (`corregirAsientoEntregado`) — el 100% del
 * piloto cae en Caso A hasta que JP reconcilie a mano lo que ya entregó.
 *
 * ## Selector — SIEMPRE una lista explícita, nunca "todo lo pendiente"
 *
 * `--asiento-id` es repetible (una vez por asiento). No existe un modo "todo el cliente" ni "todo lo
 * propuesto" — mismo criterio que `alta-contraparte.ts`/`recapturar-conceptos.ts`: la autorización es
 * por unidad, nunca por lote implícito (CLAUDE.md §1.9, generalizado más allá de migraciones).
 *
 * ## Dry-run por defecto
 *
 * Sin `--aplicar`: solo lee `asiento_estado` actual de cada id y reporta si es confirmable
 * (`'propuesto'`), ya terminal (`'confirmado'`/`'superseded'`), o no encontrado — nunca escribe. Con
 * `--aplicar`: confirma cada asiento que dio `'propuesto'` en la MISMA corrida (no reusa la lectura
 * del dry-run si se corrió aparte — cada `--aplicar` relee y confirma en su propia transacción por
 * id, así que una carrera entre el dry-run y el `--aplicar` la detecta el propio escritor, nunca
 * queda un `0 filas` silencioso).
 */

import { z } from 'zod';
import { cerrarConexiones, confirmarAsiento, conUsuario, escribirConAuditoria, leerEstadoDeAsientos, verificarCredencialDeRequest } from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);

type CamposConfirmarAsientos = 'cliente_id' | 'usuario_id' | 'asiento_id' | 'motivo_codigo' | 'causa_tipo' | 'total';
const log = loggerAcotado<CamposConfirmarAsientos>();

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
  asientoIds: z.array(z.string().regex(RE_UUID, 'cada --asiento-id tiene que ser un uuid')).min(1, 'hace falta al menos un --asiento-id'),
  aplicar: z.boolean(),
});

export type ArgumentosConfirmarAsientos = z.infer<typeof esquemaArgumentos>;

const MENSAJE_USO =
  `  node apps/cli/src/confirmar-asientos.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --asiento-id <uuid> [--asiento-id <uuid> ...] [--aplicar]${SALTO}${SALTO}` +
  `  Sin --aplicar: dry-run, nunca escribe. Con --aplicar: confirma cada asiento que esté 'propuesto'` +
  `${SALTO}  al momento de aplicar (relee, no reusa el dry-run) — nunca "todo lo pendiente" del cliente.`;

export function parsearArgumentos(argv: readonly string[]): ArgumentosConfirmarAsientos {
  const mapa = new Map<string, string>();
  const banderas = new Set<string>();
  const asientoIds: string[] = [];
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
      if (clave === 'asiento-id') {
        asientoIds.push(valor);
      } else {
        mapa.set(clave, valor);
      }
      i += 1;
    }
  }

  const crudo = {
    cliente: mapa.get('cliente') ?? '',
    usuario: mapa.get('usuario') ?? '',
    asientoIds,
    aplicar: banderas.has('aplicar'),
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(`Argumentos inválidos (${faltan}).${SALTO}${SALTO}${MENSAJE_USO}`);
  }
  return r.data;
}

export type MotivoAbortoConfirmarAsientos = 'credencial_saltea_rls' | 'contexto_no_aislado';

export type FilaReporteConfirmarAsiento = {
  readonly asientoId: string;
} & (
  | { readonly diagnostico: 'confirmable' }
  | { readonly diagnostico: 'ya_terminal'; readonly asientoEstado: string }
  | { readonly diagnostico: 'no_encontrado' }
) &
  (
    | { readonly aplicado: false }
    | { readonly aplicado: true; readonly resultado: 'confirmado' | 'conflicto' }
  );

export type ResultadoConfirmarAsientos =
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoConfirmarAsientos }
  | { readonly estado: 'dry_run'; readonly reporte: readonly FilaReporteConfirmarAsiento[] }
  | { readonly estado: 'aplicado'; readonly reporte: readonly FilaReporteConfirmarAsiento[] };

/** Separado del CLI para que el test lo ejercite sin `process.exit` — mismo patrón que
 *  `escribirAltaDeContraparte`/`recapturarConceptos`. */
export async function confirmarAsientos(args: ArgumentosConfirmarAsientos): Promise<ResultadoConfirmarAsientos> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('confirmar_asientos.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const estados = await conUsuario(args.usuario, (tx) =>
    leerEstadoDeAsientos(tx, { clienteId: args.cliente, asientoIds: args.asientoIds }),
  );

  const diagnosticos: readonly {
    readonly asientoId: string;
    readonly diagnostico: FilaReporteConfirmarAsiento['diagnostico'];
    readonly asientoEstado?: string;
  }[] = args.asientoIds.map((asientoId) => {
    const fila = estados.get(asientoId);
    if (!fila) return { asientoId, diagnostico: 'no_encontrado' as const };
    if (fila.asientoEstado !== 'propuesto') return { asientoId, diagnostico: 'ya_terminal' as const, asientoEstado: fila.asientoEstado };
    return { asientoId, diagnostico: 'confirmable' as const };
  });

  if (!args.aplicar) {
    log.info('confirmar_asientos.dry_run', { cliente_id: args.cliente, total: diagnosticos.length });
    return {
      estado: 'dry_run',
      reporte: diagnosticos.map((d) => ({ ...d, aplicado: false }) as FilaReporteConfirmarAsiento),
    };
  }

  const reporte: FilaReporteConfirmarAsiento[] = [];
  for (const d of diagnosticos) {
    if (d.diagnostico !== 'confirmable') {
      reporte.push({ ...d, aplicado: false } as FilaReporteConfirmarAsiento);
      continue;
    }
    const r = await conUsuario(args.usuario, (tx) =>
      escribirConAuditoria(
        tx,
        {
          clienteId: args.cliente,
          accion: 'escritura',
          recurso: 'asiento_propuesto',
          motivo: 'confirmar-asientos.ts: reconciliación manual de asientos ya entregados (0040, Mitad 1)',
        },
        (ctx) => confirmarAsiento(tx, ctx, { clienteId: args.cliente, asientoId: d.asientoId }),
      ),
    );
    if (r.estado === 'confirmado') {
      log.info('confirmar_asientos.confirmado', { cliente_id: args.cliente, asiento_id: d.asientoId });
    } else {
      log.warn('confirmar_asientos.conflicto', { cliente_id: args.cliente, asiento_id: d.asientoId, motivo_codigo: r.motivoCodigo });
    }
    reporte.push({ ...d, aplicado: true, resultado: r.estado } as FilaReporteConfirmarAsiento);
  }

  return { estado: 'aplicado', reporte };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/confirmar-asientos.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));

    imprimir('');
    imprimir(`  Cliente        ${args.cliente}`);
    imprimir(`  Asientos       ${args.asientoIds.length}`);
    imprimir(`  Modo           ${args.aplicar ? 'APLICAR' : 'dry-run'}`);
    imprimir('');

    const r = await confirmarAsientos(args);

    if (r.estado === 'abortado') {
      imprimir(`  ABORTA: ${JSON.stringify(r)}`);
      process.exit(1);
    }

    for (const fila of r.reporte) {
      imprimir(`  ${fila.asientoId}  ${JSON.stringify(fila)}`);
    }
    imprimir('');
    const confirmables = r.reporte.filter((f) => f.diagnostico === 'confirmable').length;
    const yaTerminales = r.reporte.filter((f) => f.diagnostico === 'ya_terminal').length;
    const noEncontrados = r.reporte.filter((f) => f.diagnostico === 'no_encontrado').length;
    imprimir(`  confirmables=${confirmables}  ya_terminales=${yaTerminales}  no_encontrados=${noEncontrados}`);
    imprimir('');

    process.exit(0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
