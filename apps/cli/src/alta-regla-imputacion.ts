/**
 * CLI DE ALTA DE `regla_imputacion` (`0030`, D-29 pata "contrapartida") — ÚNICO productor hoy: la
 * tabla tenía lectores (`leerReglasDeImputacionVigentes`, etc.) desde que se creó, pero ningún
 * camino de escritura (verificado antes de escribir esto). Corrección de fondo del paquete final,
 * JP 2026-09-10 (HANDOFF 203/204) — `contador-dominio` ya dictaminó las 3 cuentas candidatas
 * (`docs/diseno/31-replanteo-hacia-producto.md`, Dictamen 4/5 §B/C).
 *
 *     pnpm alta:regla-imputacion --cliente <uuid> --usuario <uuid> --tipo <tipo_movimiento> \
 *       --cuenta-codigo <codigo> --vigente-desde YYYY-MM-DD --respaldo "<texto>"
 *
 *     pnpm alta:regla-imputacion ... --aplicar
 *
 * ## Alcance deliberadamente angosto
 *
 * SOLO `cuenta_resolucion: 'fija'` — hardcodeado en el INSERT (`altaReglaImputacion`), nunca un
 * parámetro. Las otras 3 resoluciones ('por_socio'/'por_jurisdiccion'/'por_impuesto') necesitan su
 * propio diseño; este CLI no las sirve.
 *
 * SOLO regla general del tipo — no hay `--concepto`: `contador-dominio` (doc 31 §B) dictaminó que
 * "el mismo caso" acá es el tipo entero, no un override puntual. Si algún día hace falta un
 * override, se agrega la bandera ahí, no se asume ahora.
 *
 * SOLO alta — nunca reemplazo. Si ya existe una regla vigente para el mismo tipo,
 * `YaExisteReglaVigenteError` aborta siempre (dry-run y `--aplicar` por igual). Cerrar una vigencia
 * es un gesto aparte, con su propia autorización — este CLI no lo hace.
 *
 * ## Dry-run por defecto — SIEMPRE con el radio real antes de tocar nada
 *
 * Sin `--aplicar`: resuelve `--cuenta-codigo` contra el plan de cuentas REAL del cliente
 * (`leerPlanDeCuentasCompleto` — nunca un id inventado, aborta si no matchea exactamente una cuenta
 * activa y vigente), muestra si ya existe una regla vigente para el tipo, y cuenta cuántos
 * movimientos `propuesta` de ese tipo, en TODO el corpus del cliente, siguen sin asiento
 * (`contarPropuestaSinAsientoPorTipo` — MISMO criterio de exclusión que
 * `leerReconocimientosParaImputar`, nunca una tercera versión del cálculo: JP, 2026-09-10). Nunca
 * escribe.
 */

import { z } from 'zod';
import {
  altaReglaImputacion,
  cerrarConexiones,
  conUsuario,
  contarPropuestaSinAsientoPorTipo,
  escribirConAuditoria,
  leerPlanDeCuentasCompleto,
  leerReglasDeImputacionVigentes,
  verificarCredencialDeRequest,
  YaExisteReglaVigenteError,
  type FilaDelPlanDeCuentas,
} from '@sistema-contable/data';
import { TIPOS_MOVIMIENTO } from '@sistema-contable/contabilidad';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);

type CamposAltaReglaImputacion = 'cliente_id' | 'motivo_codigo' | 'causa_tipo';
const log = loggerAcotado<CamposAltaReglaImputacion>();

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
  tipo: z.enum(TIPOS_MOVIMIENTO),
  cuentaCodigo: z.string().min(1, '--cuenta-codigo no puede estar vacío'),
  vigenteDesde: z.string().regex(RE_FECHA, '--vigente-desde tiene que ser YYYY-MM-DD'),
  respaldo: z.string().min(20, '--respaldo tiene que tener al menos 20 caracteres — nunca "ok"'),
  aplicar: z.boolean(),
});
export type ArgumentosAltaReglaImputacion = z.infer<typeof esquemaArgumentos>;

const MENSAJE_USO =
  `  node apps/cli/src/alta-regla-imputacion.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --tipo <tipo_movimiento> --cuenta-codigo <codigo> --vigente-desde YYYY-MM-DD \\${SALTO}` +
  `    --respaldo "<texto>" [--aplicar]${SALTO}${SALTO}` +
  `  Sin --aplicar: dry-run — resuelve la cuenta real, muestra si ya hay regla vigente, y cuenta${SALTO}` +
  `  cuántos movimientos de ese tipo siguen sin asiento. Nunca escribe. Con --aplicar: da de alta${SALTO}` +
  `  la regla ('fija', regla general del tipo — sin --concepto, no lo acepta este CLI).`;

export function parsearArgumentos(argv: readonly string[]): ArgumentosAltaReglaImputacion {
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
    tipo: mapa.get('tipo') ?? '',
    cuentaCodigo: mapa.get('cuenta-codigo') ?? '',
    vigenteDesde: mapa.get('vigente-desde') ?? '',
    respaldo: mapa.get('respaldo') ?? '',
    aplicar: banderas.has('aplicar'),
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(`Argumentos inválidos (${faltan}).${SALTO}${SALTO}${MENSAJE_USO}`);
  }
  return r.data;
}

export type MotivoAbortoAltaReglaImputacion =
  | 'credencial_saltea_rls'
  | 'contexto_no_aislado'
  | 'CUENTA_NO_ENCONTRADA'
  | 'CUENTA_AMBIGUA'
  | 'YA_EXISTE_REGLA_VIGENTE';

export type ReporteAltaReglaImputacion = {
  readonly cuentaResuelta: FilaDelPlanDeCuentas | null;
  readonly yaHayReglaVigente: boolean;
  readonly movimientosSinAsiento: number;
};

export type ResultadoAltaReglaImputacion =
  | {
      readonly estado: 'abortado';
      readonly motivoCodigo: MotivoAbortoAltaReglaImputacion;
      readonly detalle?: string;
      /** Solo poblado cuando el aborto ocurre DESPUÉS de armar el reporte (`YA_EXISTE_REGLA_VIGENTE`
       *  del chequeo previo) — `CUENTA_NO_ENCONTRADA`/`CUENTA_AMBIGUA` abortan antes de tener uno. */
      readonly reporte?: ReporteAltaReglaImputacion;
    }
  | { readonly estado: 'dry_run'; readonly reporte: ReporteAltaReglaImputacion }
  | { readonly estado: 'aplicado'; readonly reporte: ReporteAltaReglaImputacion; readonly reglaImputacionId: string };

/** Separado del CLI para que el test lo ejercite sin `process.exit` — mismo patrón que
 *  `correrManifestarPadron`. */
export async function correrAltaReglaImputacion(args: ArgumentosAltaReglaImputacion): Promise<ResultadoAltaReglaImputacion> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('alta_regla_imputacion.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  // Resolución de la cuenta REAL + estado actual — SIEMPRE la misma lectura, se aplique o no (mismo
  // criterio que `manifestar-padron.ts`: dry-run y --aplicar muestran el mismo radio del gesto).
  const previo = await conUsuario(args.usuario, async (tx) => {
    const plan = await leerPlanDeCuentasCompleto(tx, { clienteId: args.cliente });
    const candidatas = plan.filter((c) => c.codigo === args.cuentaCodigo && c.activa && c.vigenteHasta === null);
    const reglas = await leerReglasDeImputacionVigentes(tx, { clienteId: args.cliente });
    const yaHayReglaVigente = reglas.some((r) => r.tipoMovimiento === args.tipo && r.concepto === null);
    const movimientosSinAsiento = await contarPropuestaSinAsientoPorTipo(tx, {
      clienteId: args.cliente,
      tipoMovimiento: args.tipo,
    });
    return { candidatas, yaHayReglaVigente, movimientosSinAsiento };
  });

  if (previo.candidatas.length === 0) {
    log.error('alta_regla_imputacion.abortado', { motivo_codigo: 'CUENTA_NO_ENCONTRADA' });
    return {
      estado: 'abortado',
      motivoCodigo: 'CUENTA_NO_ENCONTRADA',
      detalle: `Ninguna cuenta activa y vigente con código "${args.cuentaCodigo}" en el plan de este cliente.`,
    };
  }
  if (previo.candidatas.length > 1) {
    log.error('alta_regla_imputacion.abortado', { motivo_codigo: 'CUENTA_AMBIGUA' });
    return {
      estado: 'abortado',
      motivoCodigo: 'CUENTA_AMBIGUA',
      detalle: `${previo.candidatas.length} cuentas activas y vigentes comparten el código "${args.cuentaCodigo}" — dato inesperado, revisar el plan de cuentas antes de continuar.`,
    };
  }
  const cuentaResuelta = previo.candidatas[0] as FilaDelPlanDeCuentas;

  const reporte: ReporteAltaReglaImputacion = {
    cuentaResuelta,
    yaHayReglaVigente: previo.yaHayReglaVigente,
    movimientosSinAsiento: previo.movimientosSinAsiento,
  };

  // Solo ALTA, nunca reemplazo — aborta siempre que ya exista, sea dry-run o --aplicar (mismo
  // criterio en los dos caminos, para que el dry-run no prometa un alta que --aplicar va a rechazar).
  if (previo.yaHayReglaVigente) {
    log.error('alta_regla_imputacion.abortado', { motivo_codigo: 'YA_EXISTE_REGLA_VIGENTE' });
    return { estado: 'abortado', motivoCodigo: 'YA_EXISTE_REGLA_VIGENTE', reporte };
  }

  if (!args.aplicar) {
    log.info('alta_regla_imputacion.dry_run', { cliente_id: args.cliente });
    return { estado: 'dry_run', reporte };
  }

  try {
    const r = await conUsuario(args.usuario, (tx) =>
      escribirConAuditoria(
        tx,
        {
          clienteId: args.cliente,
          accion: 'escritura',
          recurso: 'regla_imputacion',
          motivo: `alta-regla-imputacion.ts: regla fija ${args.tipo} → ${cuentaResuelta.codigo} (HANDOFF 203/204, doc 31 Dictamen 4/5 §B/C)`,
        },
        (_ctx) =>
          altaReglaImputacion(tx, _ctx, {
            clienteId: args.cliente,
            tipoMovimiento: args.tipo,
            concepto: null,
            cuentaId: cuentaResuelta.cuentaId,
            vigenteDesde: args.vigenteDesde,
            respaldo: args.respaldo,
            decididoPor: args.usuario,
          }),
      ),
    );
    log.info('alta_regla_imputacion.aplicado', { cliente_id: args.cliente });
    return { estado: 'aplicado', reporte, reglaImputacionId: r.reglaImputacionId };
  } catch (error) {
    if (error instanceof YaExisteReglaVigenteError) {
      log.error('alta_regla_imputacion.abortado', { motivo_codigo: 'YA_EXISTE_REGLA_VIGENTE' });
      return { estado: 'abortado', motivoCodigo: 'YA_EXISTE_REGLA_VIGENTE', detalle: error.message };
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/alta-regla-imputacion.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));

    imprimir('');
    imprimir(`  Cliente          ${args.cliente}`);
    imprimir(`  Tipo             ${args.tipo}`);
    imprimir(`  Cuenta (código)  ${args.cuentaCodigo}`);
    imprimir(`  Vigente desde    ${args.vigenteDesde}`);
    imprimir(`  Modo             ${args.aplicar ? 'APLICAR' : 'dry-run'}`);
    imprimir('');

    const r = await correrAltaReglaImputacion(args);

    if (r.estado === 'abortado') {
      imprimir(`  ABORTA: ${r.motivoCodigo}`);
      if (r.detalle) imprimir(`    ${r.detalle}`);
      if (r.reporte) {
        imprimir(`  Cuenta resuelta          ${r.reporte.cuentaResuelta ? `${r.reporte.cuentaResuelta.codigo} · ${r.reporte.cuentaResuelta.denominacion}` : '(no resuelta)'}`);
        imprimir(`  Movimientos sin asiento  ${r.reporte.movimientosSinAsiento}`);
      }
      process.exit(1);
    }

    const { cuentaResuelta, movimientosSinAsiento } = r.reporte;
    imprimir(`  Cuenta resuelta          ${cuentaResuelta ? `${cuentaResuelta.codigo} · ${cuentaResuelta.denominacion} (${cuentaResuelta.cuentaId})` : '(no resuelta)'}`);
    imprimir(`  Ya hay regla vigente     ${r.reporte.yaHayReglaVigente ? 'SÍ (no debería llegar acá)' : 'no'}`);
    imprimir(`  Movimientos sin asiento  ${movimientosSinAsiento} (radio real de este alta)`);
    imprimir('');

    if (r.estado === 'dry_run') {
      imprimir('  DRY-RUN: no se escribió nada. Volvé a correr con --aplicar.');
      imprimir('');
      process.exit(0);
    }

    imprimir('  Aplicado OK.');
    imprimir(`    regla_imputacion_id   ${r.reglaImputacionId}`);
    imprimir('');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
