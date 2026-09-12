/**
 * CLI DE CONFIRMACIÓN DE GRUPO (`0043`, doc 31 Tanda 2 — memoria de confirmaciones) — primer
 * productor de `confirmacion_grupo`. Confirma A QUÉ CUENTA CONTABLE va un grupo de movimientos, con
 * la clave EXACTA de `claveDeAgrupacion()` (`armar-libro.ts`): `(bancoCodigo, conceptoBanco
 * normalizado)`. Capa de EXPORTACIÓN pura — **nunca** escribe `reconocimiento_movimiento` ni
 * `asiento_propuesto`. D-28 (`packages/motor-conciliacion/src/resolver.ts`) sigue bloqueado —
 * decisión explícita de JP, 2026-09-12: el dropdown de la hoja "Grupos" sigue pidiendo confirmación
 * cada mes, pero llega pre-llenado con la confirmación anterior en vez de vacío.
 *
 *     pnpm confirmar:grupo --cliente <uuid> --usuario <uuid> --banco-codigo <codigo> \
 *       [--concepto-banco "<texto>"] --cuenta-codigo <codigo> --respaldo "<texto>" [--revoca <id>]
 *
 *     pnpm confirmar:grupo ... --aplicar
 *
 * ## Dry-run por defecto — SIEMPRE la misma lectura, se aplique o no
 *
 * Resuelve `--cuenta-codigo` contra el plan de cuentas REAL del cliente (mismo criterio que
 * `alta-regla-imputacion.ts`: aborta si no matchea exactamente una cuenta activa y vigente), y
 * muestra si ya existe una confirmación vigente para esa clave. Nunca escribe.
 *
 * Sin `--revoca`: si ya hay vigente, aborta (`YaExisteConfirmacionVigenteError`) — este alta es solo
 * para grupos SIN confirmación. Con `--revoca <id>`: `<id>` tiene que ser EXACTAMENTE la vigente
 * actual de la MISMA clave — si otra corrida ganó la carrera entre el cierre y el alta nueva,
 * `ConfirmacionEnCarreraError` lo traduce en vez de dejar pasar el `23505` genérico de Postgres
 * (verificado en vivo, dos conexiones reales, `mutaciones-0043-confirmacion-grupo.test.ts`).
 *
 * `--respaldo` pasa por `RE_POSIBLE_DOCUMENTO_EN_TEXTO` antes de Zod (doc 31, mismo guard pedido para
 * la hoja "Altas") — aborta si matchea un posible CUIT/documento, nunca lo persiste en silencio.
 *
 * ## Deliberadamente afuera de esta tarea
 *
 * El "radio real del gesto" (cuántos movimientos `decision_humana`/`sin_reconocer` matchean esta
 * clave HOY) — equivalente al conteo de citas de `manifestar-padron.ts` — queda sin construir: exige
 * un join contra `movimiento_bancario_crudo`/`lote_ingesta_cuenta` que esta tarea no verificó, y
 * escribirlo sin verificar sería inventar un número. Declarado como deuda, no como bug.
 */

import { z } from 'zod';
import {
  cerrarConexiones,
  confirmarGrupo,
  ConfirmacionEnCarreraError,
  conUsuario,
  escribirConAuditoria,
  leerConfirmacionGrupoVigente,
  leerPlanDeCuentasCompleto,
  RevocaDeOtraClaveConfirmacionError,
  RevocaNoEsLaVigenteConfirmacionError,
  verificarCredencialDeRequest,
  YaExisteConfirmacionVigenteError,
  type ConfirmacionGrupo,
  type FilaDelPlanDeCuentas,
} from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { RE_POSIBLE_DOCUMENTO_EN_TEXTO, redactar, sinEstado } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);

type CamposConfirmarGrupo = 'cliente_id' | 'motivo_codigo' | 'causa_tipo';
const log = loggerAcotado<CamposConfirmarGrupo>();

function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

/**
 * Gemela EXACTA de `normalizarParaAgrupar()` (`packages/ingesta/src/planilla/armar-libro.ts:216-218`)
 * — DUPLICADA a propósito, no importada: `armar-libro.ts` no expone esta función en el barrel público
 * de `@sistema-contable/ingesta` hoy (es interna al módulo de planilla), y ampliar esa superficie
 * pública es una decisión de `tech-lead`/`arquitecto-software` que esta tarea no tiene mandato para
 * tomar sola (doc 31 §1 ya dejó abierta la pregunta de si esta clave necesita unificarse con la de
 * `relevamiento-laura.ts` — tocar la superficie pública ahora se adelantaría a esa convocatoria).
 * Mismo patrón que usa `packages/motor-conciliacion` para vocabulario compartido: duplicar con
 * comentario explícito, nunca importar cruzando un límite no decidido. Si cambia la de origen sin
 * que esta se actualice, es exactamente el riesgo que doc 31 ya señaló — un test de sincronía (mismo
 * mecanismo que R-H/R-K de `reglas-de-codigo.test.ts`) es la forma correcta de cerrarlo cuando se
 * resuelva la pregunta de fondo, no agregada sola en esta tarea.
 */
function normalizarParaAgrupar(texto: string): string {
  return texto.trim().replace(/\s+/g, ' ').toUpperCase();
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANDERAS = new Set(['aplicar']);

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
  usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
  bancoCodigo: z.string().min(1, '--banco-codigo no puede estar vacío'),
  conceptoBanco: z.string().min(1).nullable(),
  cuentaCodigo: z.string().min(1, '--cuenta-codigo no puede estar vacío'),
  respaldo: z.string().min(15, '--respaldo tiene que tener al menos 15 caracteres — nunca "ok"'),
  revoca: z.string().regex(RE_UUID, 'el --revoca tiene que ser un uuid').nullable(),
  aplicar: z.boolean(),
});
export type ArgumentosConfirmarGrupo = z.infer<typeof esquemaArgumentos>;

const MENSAJE_USO =
  `  node apps/cli/src/confirmar-grupo.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --banco-codigo <codigo> [--concepto-banco "<texto>"] --cuenta-codigo <codigo> \\${SALTO}` +
  `    --respaldo "<texto>" [--revoca <id>] [--aplicar]${SALTO}${SALTO}` +
  `  Sin --aplicar: dry-run — resuelve la cuenta real y muestra si ya hay confirmación vigente.${SALTO}` +
  `  Nunca escribe. Con --aplicar: confirma el grupo (alta, o reemplazo con --revoca).`;

export function parsearArgumentos(argv: readonly string[]): ArgumentosConfirmarGrupo {
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
    bancoCodigo: mapa.get('banco-codigo') ?? '',
    conceptoBanco: mapa.get('concepto-banco') ?? null,
    cuentaCodigo: mapa.get('cuenta-codigo') ?? '',
    respaldo: mapa.get('respaldo') ?? '',
    revoca: mapa.get('revoca') ?? null,
    aplicar: banderas.has('aplicar'),
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(`Argumentos inválidos (${faltan}).${SALTO}${SALTO}${MENSAJE_USO}`);
  }

  // Dato sensible en prosa libre — ANTES de llegar a escribir, nunca en silencio (doc 31, mismo
  // guard pedido para la hoja "Altas"; mirror en TS del CHECK de longitud de la migración).
  if (sinEstado(RE_POSIBLE_DOCUMENTO_EN_TEXTO).test(r.data.respaldo)) {
    throw new Error(
      `--respaldo contiene una posible cadena de documento (CUIT/DNI/CBU) — no se acepta prosa libre ` +
        `con ese patrón.${SALTO}${SALTO}${MENSAJE_USO}`,
    );
  }

  return r.data;
}

export type MotivoAbortoConfirmarGrupo =
  | 'credencial_saltea_rls'
  | 'contexto_no_aislado'
  | 'CUENTA_NO_ENCONTRADA'
  | 'CUENTA_AMBIGUA'
  | 'YA_EXISTE_CONFIRMACION_VIGENTE'
  | 'REVOCA_NO_ES_LA_VIGENTE'
  | 'REVOCA_DE_OTRA_CLAVE'
  | 'CONFIRMACION_EN_CARRERA';

export type ReporteConfirmarGrupo = {
  readonly cuentaResuelta: FilaDelPlanDeCuentas | null;
  readonly vigenteActual: ConfirmacionGrupo | null;
};

export type ResultadoConfirmarGrupo =
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoConfirmarGrupo; readonly detalle?: string; readonly reporte?: ReporteConfirmarGrupo }
  | { readonly estado: 'dry_run'; readonly reporte: ReporteConfirmarGrupo }
  | { readonly estado: 'aplicado'; readonly reporte: ReporteConfirmarGrupo; readonly confirmacionGrupoId: string };

/** Separado del CLI para que el test lo ejercite sin `process.exit` — mismo patrón que
 *  `correrAltaReglaImputacion`/`correrManifestarPadron`. */
export async function correrConfirmarGrupo(args: ArgumentosConfirmarGrupo): Promise<ResultadoConfirmarGrupo> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('confirmar_grupo.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const conceptoNormalizado = args.conceptoBanco === null ? '(sin concepto)' : normalizarParaAgrupar(args.conceptoBanco);

  // SIEMPRE la misma lectura, se aplique o no — mismo criterio que `alta-regla-imputacion.ts`.
  const previo = await conUsuario(args.usuario, async (tx) => {
    const plan = await leerPlanDeCuentasCompleto(tx, { clienteId: args.cliente });
    const candidatas = plan.filter((c) => c.codigo === args.cuentaCodigo && c.activa && c.vigenteHasta === null);
    const vigenteActual = await leerConfirmacionGrupoVigente(tx, {
      clienteId: args.cliente,
      bancoCodigo: args.bancoCodigo,
      conceptoNormalizado,
    });
    return { candidatas, vigenteActual: vigenteActual ?? null };
  });

  if (previo.candidatas.length === 0) {
    log.error('confirmar_grupo.abortado', { motivo_codigo: 'CUENTA_NO_ENCONTRADA' });
    return {
      estado: 'abortado',
      motivoCodigo: 'CUENTA_NO_ENCONTRADA',
      detalle: `Ninguna cuenta activa y vigente con código "${args.cuentaCodigo}" en el plan de este cliente.`,
    };
  }
  if (previo.candidatas.length > 1) {
    log.error('confirmar_grupo.abortado', { motivo_codigo: 'CUENTA_AMBIGUA' });
    return {
      estado: 'abortado',
      motivoCodigo: 'CUENTA_AMBIGUA',
      detalle: `${previo.candidatas.length} cuentas activas y vigentes comparten el código "${args.cuentaCodigo}".`,
    };
  }
  const cuentaResuelta = previo.candidatas[0] as FilaDelPlanDeCuentas;
  const reporte: ReporteConfirmarGrupo = { cuentaResuelta, vigenteActual: previo.vigenteActual };

  // Sin --revoca: solo alta, nunca reemplazo — mismo criterio que `alta-regla-imputacion.ts` (aborta
  // en dry-run y en --aplicar por igual, para que el dry-run no prometa lo que --aplicar va a rechazar).
  if (args.revoca === null && previo.vigenteActual !== null) {
    log.error('confirmar_grupo.abortado', { motivo_codigo: 'YA_EXISTE_CONFIRMACION_VIGENTE' });
    return { estado: 'abortado', motivoCodigo: 'YA_EXISTE_CONFIRMACION_VIGENTE', reporte };
  }
  // Con --revoca: tiene que apuntar EXACTAMENTE a la vigente actual de esta clave — mismo criterio de
  // pre-lectura que `manifestar-padron.ts` (el chequeo real y final es el escritor, esto solo evita
  // un viaje redondo con un id que ya se sabe equivocado).
  if (args.revoca !== null && previo.vigenteActual?.id !== args.revoca) {
    log.error('confirmar_grupo.abortado', { motivo_codigo: 'REVOCA_NO_ES_LA_VIGENTE' });
    return {
      estado: 'abortado',
      motivoCodigo: 'REVOCA_NO_ES_LA_VIGENTE',
      detalle: `--revoca ${args.revoca} no es la confirmación vigente de esta clave ahora.`,
      reporte,
    };
  }

  if (!args.aplicar) {
    log.info('confirmar_grupo.dry_run', { cliente_id: args.cliente });
    return { estado: 'dry_run', reporte };
  }

  try {
    const r = await conUsuario(args.usuario, (tx) =>
      escribirConAuditoria(
        tx,
        {
          clienteId: args.cliente,
          accion: 'escritura',
          recurso: 'confirmacion_grupo',
          motivo: `confirmar-grupo.ts: grupo (${args.bancoCodigo}, ${args.conceptoBanco ?? 'sin concepto'}) → ${cuentaResuelta.codigo} (doc 31 Tanda 2)`,
        },
        (_ctx) =>
          confirmarGrupo(tx, _ctx, {
            clienteId: args.cliente,
            bancoCodigo: args.bancoCodigo,
            conceptoBanco: args.conceptoBanco,
            cuentaId: cuentaResuelta.cuentaId,
            respaldo: args.respaldo,
            confirmadoPor: args.usuario,
            revocaId: args.revoca,
          }),
      ),
    );
    log.info('confirmar_grupo.aplicado', { cliente_id: args.cliente });
    return { estado: 'aplicado', reporte, confirmacionGrupoId: r.confirmacionGrupoId };
  } catch (error) {
    if (error instanceof YaExisteConfirmacionVigenteError) {
      log.error('confirmar_grupo.abortado', { motivo_codigo: 'YA_EXISTE_CONFIRMACION_VIGENTE' });
      return { estado: 'abortado', motivoCodigo: 'YA_EXISTE_CONFIRMACION_VIGENTE', detalle: error.message, reporte };
    }
    if (error instanceof RevocaNoEsLaVigenteConfirmacionError) {
      log.error('confirmar_grupo.abortado', { motivo_codigo: 'REVOCA_NO_ES_LA_VIGENTE' });
      return { estado: 'abortado', motivoCodigo: 'REVOCA_NO_ES_LA_VIGENTE', detalle: error.message, reporte };
    }
    if (error instanceof RevocaDeOtraClaveConfirmacionError) {
      log.error('confirmar_grupo.abortado', { motivo_codigo: 'REVOCA_DE_OTRA_CLAVE' });
      return { estado: 'abortado', motivoCodigo: 'REVOCA_DE_OTRA_CLAVE', detalle: error.message, reporte };
    }
    if (error instanceof ConfirmacionEnCarreraError) {
      log.error('confirmar_grupo.abortado', { motivo_codigo: 'CONFIRMACION_EN_CARRERA' });
      return { estado: 'abortado', motivoCodigo: 'CONFIRMACION_EN_CARRERA', detalle: error.message, reporte };
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/confirmar-grupo.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));

    imprimir('');
    imprimir(`  Cliente          ${args.cliente}`);
    imprimir(`  Banco            ${args.bancoCodigo}`);
    imprimir(`  Concepto         ${args.conceptoBanco ?? '(sin concepto)'}`);
    imprimir(`  Cuenta (código)  ${args.cuentaCodigo}`);
    imprimir(`  Revoca           ${args.revoca ?? '(alta nueva)'}`);
    imprimir(`  Modo             ${args.aplicar ? 'APLICAR' : 'dry-run'}`);
    imprimir('');

    const r = await correrConfirmarGrupo(args);

    if (r.estado === 'abortado') {
      imprimir(`  ABORTA: ${r.motivoCodigo}`);
      if (r.detalle) imprimir(`    ${r.detalle}`);
      if (r.reporte) {
        imprimir(`  Cuenta resuelta      ${r.reporte.cuentaResuelta ? `${r.reporte.cuentaResuelta.codigo} · ${r.reporte.cuentaResuelta.denominacion}` : '(no resuelta)'}`);
        imprimir(`  Vigente actual       ${r.reporte.vigenteActual ? r.reporte.vigenteActual.id : '(ninguna)'}`);
      }
      process.exit(1);
    }

    const { cuentaResuelta, vigenteActual } = r.reporte;
    imprimir(`  Cuenta resuelta      ${cuentaResuelta ? `${cuentaResuelta.codigo} · ${cuentaResuelta.denominacion} (${cuentaResuelta.cuentaId})` : '(no resuelta)'}`);
    imprimir(`  Vigente actual       ${vigenteActual ? vigenteActual.id : '(ninguna)'}`);
    imprimir('');

    if (r.estado === 'dry_run') {
      imprimir('  DRY-RUN: no se escribió nada. Volvé a correr con --aplicar.');
      imprimir('');
      process.exit(0);
    }

    imprimir('  Aplicado OK.');
    imprimir(`    confirmacion_grupo_id   ${r.confirmacionGrupoId}`);
    imprimir('');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
