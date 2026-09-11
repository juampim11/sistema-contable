/**
 * ACTUALIZA el alias (etiqueta humana) de una cuenta bancaria YA dada de alta — nunca crea una cuenta
 * ni toca su identificador (`numero`/`cbu`). Corrección de fondo del paquete final para Laura, JP
 * 2026-09-11 (HANDOFF 206): las cuentas de Bracci y ROKA mostraban "(sin alias)" o un alias residual
 * de una carga anterior sin criterio (ver HANDOFF (97)) en vez del nombre real del banco.
 *
 *     node apps/cli/src/actualizar-alias-cuenta.ts --cliente <uuid> --usuario <uuid> \
 *       --moneda ARS|USD --tipo <tipo_cuenta> --alias "Cuenta Corriente en Pesos" [--aplicar]
 *
 * ## Por qué se resuelve la cuenta por (moneda, tipo) y no por `--cuenta <uuid>`
 *
 * Un uuid pegado a mano es exactamente el modo de falla que este proyecto evita en cada alta real: no
 * hay manera de que el operador confirme a ojo que el uuid corresponde a la cuenta correcta. `moneda` +
 * `tipo_cuenta` (del identificador VIGENTE, `vigente_hasta is null`) son datos que el operador sí puede
 * verificar contra el extracto real que tiene delante — mismo criterio de "listar, nunca adivinar" que
 * `alta-cuenta.ts`. Si la combinación no resuelve a exactamente una cuenta, aborta y lista las
 * candidatas (nunca elige la más cercana).
 *
 * ## Dry-run por defecto
 *
 * Sin `--aplicar`: resuelve la cuenta real, muestra alias actual → alias nuevo, banco, cantidad de
 * movimientos ya ingeridos (para que el operador la reconozca). Nunca escribe. Con `--aplicar`: UPDATE
 * auditado, solo la columna `alias` — ninguna otra columna de `cuenta_bancaria` cambia.
 */

import { z } from 'zod';
import {
  actualizarAliasDeCuentaBancaria,
  cerrarConexiones,
  conUsuario,
  CuentaBancariaNoEncontradaError,
  escribirConAuditoria,
  verificarCredencialDeRequest,
} from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);

type CamposActualizarAlias = 'cliente_id' | 'motivo_codigo' | 'causa_tipo';
const log = loggerAcotado<CamposActualizarAlias>();

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
  moneda: z.enum(['ARS', 'USD']),
  tipo: z.string().min(1, '--tipo no puede estar vacío'),
  alias: z.string().min(1).max(60, '--alias tiene que tener 60 caracteres o menos (mismo tope que el alta)'),
  aplicar: z.boolean(),
});
export type ArgumentosActualizarAlias = z.infer<typeof esquemaArgumentos>;

const MENSAJE_USO =
  `  node apps/cli/src/actualizar-alias-cuenta.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --moneda ARS|USD --tipo <tipo_cuenta> --alias "texto" [--aplicar]${SALTO}${SALTO}` +
  `  Sin --aplicar: dry-run — resuelve la cuenta real por (moneda, tipo) y muestra alias actual →${SALTO}` +
  `  nuevo. Nunca escribe. Con --aplicar: UPDATE auditado, solo la columna alias.`;

export function parsearArgumentos(argv: readonly string[]): ArgumentosActualizarAlias {
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
    moneda: mapa.get('moneda') ?? '',
    tipo: mapa.get('tipo') ?? '',
    alias: mapa.get('alias') ?? '',
    aplicar: banderas.has('aplicar'),
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(`Argumentos inválidos (${faltan}).${SALTO}${SALTO}${MENSAJE_USO}`);
  }
  return r.data;
}

type CandidataCuenta = {
  readonly cuentaBancariaId: string;
  readonly bancoCodigo: string;
  readonly aliasActual: string | null;
  readonly cbuUltimos4: string | null;
  readonly cantidadMovimientos: number;
};

export type MotivoAbortoActualizarAlias =
  | 'credencial_saltea_rls'
  | 'contexto_no_aislado'
  | 'CUENTA_NO_ENCONTRADA'
  | 'CUENTA_AMBIGUA';

export type ReporteActualizarAlias = { readonly candidata: CandidataCuenta | null };

export type ResultadoActualizarAliasCli =
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoActualizarAlias; readonly detalle?: string; readonly reporte?: ReporteActualizarAlias }
  | { readonly estado: 'dry_run'; readonly reporte: ReporteActualizarAlias }
  | { readonly estado: 'aplicado'; readonly reporte: ReporteActualizarAlias; readonly aliasAnterior: string | null };

/** Separado del CLI para que el test lo ejercite sin `process.exit` — mismo patrón que
 *  `correrAltaReglaImputacion`. */
export async function correrActualizarAlias(args: ArgumentosActualizarAlias): Promise<ResultadoActualizarAliasCli> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('actualizar_alias_cuenta.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  // Resolución por (moneda, tipo del identificador VIGENTE) — nunca por uuid pegado a mano. N2/N1, no
  // N2R (`numero` no se lee acá): no hace falta `leerConAuditoria`, mismo criterio que
  // `clasificacion-campos.ts` ya aplica a estas columnas.
  const candidatas = await conUsuario(args.usuario, (tx) =>
    tx.consultar<{
      cuenta_bancaria_id: string;
      banco_codigo: string;
      alias: string | null;
      cbu_ultimos4: string | null;
      cantidad_movimientos: string;
    }>(
      `select cb.id::text as cuenta_bancaria_id, cb.banco_codigo, cb.alias, ci.cbu_ultimos4,
              (select count(*)::text from movimiento_bancario_crudo m
                where m.cliente_id = cb.cliente_id and m.cuenta_bancaria_id = cb.id) as cantidad_movimientos
         from cuenta_bancaria cb
         join cuenta_bancaria_identificador ci
           on ci.cliente_id = cb.cliente_id and ci.cuenta_bancaria_id = cb.id and ci.vigente_hasta is null
        where cb.cliente_id = $1 and cb.moneda = $2 and ci.tipo_cuenta = $3`,
      [args.cliente, args.moneda, args.tipo],
    ),
  );

  if (candidatas.length === 0) {
    log.error('actualizar_alias_cuenta.abortado', { motivo_codigo: 'CUENTA_NO_ENCONTRADA' });
    return {
      estado: 'abortado',
      motivoCodigo: 'CUENTA_NO_ENCONTRADA',
      detalle: `Ninguna cuenta con identificador vigente en moneda=${args.moneda} tipo=${args.tipo} para este cliente.`,
    };
  }
  if (candidatas.length > 1) {
    log.error('actualizar_alias_cuenta.abortado', { motivo_codigo: 'CUENTA_AMBIGUA' });
    return {
      estado: 'abortado',
      motivoCodigo: 'CUENTA_AMBIGUA',
      detalle: `${candidatas.length} cuentas comparten moneda=${args.moneda} tipo=${args.tipo} — dato inesperado, revisar antes de continuar.`,
    };
  }
  const c = candidatas[0] as (typeof candidatas)[number];
  const candidata: CandidataCuenta = {
    cuentaBancariaId: c.cuenta_bancaria_id,
    bancoCodigo: c.banco_codigo,
    aliasActual: c.alias,
    cbuUltimos4: c.cbu_ultimos4,
    cantidadMovimientos: Number(c.cantidad_movimientos),
  };
  const reporte: ReporteActualizarAlias = { candidata };

  if (!args.aplicar) {
    log.info('actualizar_alias_cuenta.dry_run', { cliente_id: args.cliente });
    return { estado: 'dry_run', reporte };
  }

  try {
    const r = await conUsuario(args.usuario, (tx) =>
      escribirConAuditoria(
        tx,
        {
          clienteId: args.cliente,
          accion: 'escritura',
          recurso: 'cuenta_bancaria',
          recursoId: candidata.cuentaBancariaId,
          motivo: `actualizar-alias-cuenta.ts: alias → "${args.alias}" (HANDOFF 206, corrección de fondo del paquete final)`,
        },
        (_ctx) =>
          actualizarAliasDeCuentaBancaria(tx, _ctx, {
            clienteId: args.cliente,
            cuentaBancariaId: candidata.cuentaBancariaId,
            aliasNuevo: args.alias,
          }),
      ),
    );
    log.info('actualizar_alias_cuenta.aplicado', { cliente_id: args.cliente });
    return { estado: 'aplicado', reporte, aliasAnterior: r.aliasAnterior };
  } catch (error) {
    if (error instanceof CuentaBancariaNoEncontradaError) {
      log.error('actualizar_alias_cuenta.abortado', { motivo_codigo: 'CUENTA_NO_ENCONTRADA' });
      return { estado: 'abortado', motivoCodigo: 'CUENTA_NO_ENCONTRADA', detalle: error.message, reporte };
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/actualizar-alias-cuenta.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));

    imprimir('');
    imprimir(`  Cliente          ${args.cliente}`);
    imprimir(`  Moneda           ${args.moneda}`);
    imprimir(`  Tipo de cuenta   ${args.tipo}`);
    imprimir(`  Alias nuevo      ${args.alias}`);
    imprimir(`  Modo             ${args.aplicar ? 'APLICAR' : 'dry-run'}`);
    imprimir('');

    const r = await correrActualizarAlias(args);

    if (r.estado === 'abortado') {
      imprimir(`  ABORTA: ${r.motivoCodigo}`);
      if (r.detalle) imprimir(`    ${r.detalle}`);
      process.exit(1);
    }

    const cand = r.reporte.candidata as CandidataCuenta;
    imprimir(`  Cuenta resuelta          ${cand.bancoCodigo} · terminada en ${cand.cbuUltimos4 ?? '(n/a)'} (${cand.cuentaBancariaId})`);
    imprimir(`  Movimientos ya ingeridos ${cand.cantidadMovimientos}`);
    imprimir(`  Alias actual             ${cand.aliasActual ?? '(sin alias)'}`);
    imprimir(`  Alias nuevo              ${args.alias}`);
    imprimir('');

    if (r.estado === 'dry_run') {
      imprimir('  DRY-RUN: no se escribió nada. Volvé a correr con --aplicar.');
      imprimir('');
      process.exit(0);
    }

    imprimir('  Aplicado OK.');
    imprimir('');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
