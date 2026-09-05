/**
 * ALTA (Y BAJA) DE `padron_contraparte` — `packages/data/src/contabilidad/escrituras.ts`, migración
 * `0037_padron_contraparte.sql`. `docs/diseno/29-padron-contraparte.md`.
 *
 *     pnpm alta:contraparte --cliente <uuid> --usuario <uuid> \
 *       --patron "<nombre, como aparece en la glosa>" --clasificacion proveedor|cliente|otro \
 *       --vigencia-desde YYYY-MM-DD
 *
 *     pnpm alta:contraparte --cliente <uuid> --usuario <uuid> \
 *       --baja --contraparte-id <uuid> --vigencia-hasta YYYY-MM-DD
 *
 * ## Por qué `--patron` SÍ va por argumento — a diferencia del documento de `alta-socio.ts`
 *
 * `patron` no es N2-R: es un nombre comercial, mismo tier que `denominacion` en `alta-socio.ts` (que
 * TAMBIÉN va por argumento, sin prompt oculto). El único dato N2-R de `alta-socio.ts` es el
 * CUIT/CUIL — `padron_contraparte` no tiene ningún campo así, por diseño (ver la convocatoria de
 * `dba-data`/`seguridad-datos-financieros` en el documento de diseño).
 *
 * ## El guard — `--patron` con forma de documento
 *
 * `padron_contraparte_patron_sin_documento_chk` (migración `0037`) impide que un documento se cuele
 * en `patron` **en la base** — pero actúa DESPUÉS de que el valor ya viajó por `argv`. Este archivo
 * agrega el mismo guard en la aplicación, ANTES del parseo (mismo criterio que Guard 2 de
 * `alta-socio.ts`), con `RE_POSIBLE_DOCUMENTO_EN_TEXTO` — el mirror en TypeScript del check SQL.
 *
 * ## Qué imprime
 *
 * uuid y el patrón en texto — no es fuga: el operador lo acaba de tipear él mismo, a la vista, en el
 * mismo argumento que le pasó al CLI.
 */

import { z } from 'zod';
import {
  altaDeContraparte,
  bajaDeContraparte,
  BajaDeContraparteNoEncontradaError,
  BajaMismoDiaDeAltaContraparteError,
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  verificarCredencialDeRequest,
} from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { RE_POSIBLE_DOCUMENTO_EN_TEXTO, redactar, sinEstado } from '@sistema-contable/shared/seguridad';
import { normalizar } from '@sistema-contable/shared/texto';
import { CLASIFICACIONES_CONTRAPARTE } from '@sistema-contable/contabilidad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);

type CamposAltaContraparte = 'cliente_id' | 'usuario_id' | 'motivo_codigo' | 'causa_tipo';
// NO incluye 'patron' ni 'clasificacion': 0037 sube las dos a N2 (mismo criterio que
// `cuenta_atributo.rol_funcional` para `clasificacion`, y que `tenant_node.nombre` para `patron`) —
// el tipo del logger las rechaza, mismo patrón que `denominacion`/`documento` en `alta-socio.ts`.
const log = loggerAcotado<CamposAltaContraparte>();

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
const BANDERAS = new Set(['baja']);

const esquemaAlta = z.object({
  baja: z.literal(false),
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  patron: z.string().min(1).max(200),
  clasificacion: z.enum(CLASIFICACIONES_CONTRAPARTE),
  vigenciaDesde: z.string().regex(RE_FECHA),
});
const esquemaBaja = z.object({
  baja: z.literal(true),
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  contraparteId: z.string().regex(RE_UUID),
  vigenciaHasta: z.string().regex(RE_FECHA),
});
const esquemaArgumentos = z.discriminatedUnion('baja', [esquemaAlta, esquemaBaja]);
export type ArgumentosAltaContraparte = z.infer<typeof esquemaArgumentos>;

const MENSAJE_USO =
  `  node apps/cli/src/alta-contraparte.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --patron "<nombre, como aparece en la glosa>" --clasificacion proveedor|cliente|otro \\${SALTO}` +
  `    --vigencia-desde YYYY-MM-DD${SALTO}${SALTO}` +
  `  node apps/cli/src/alta-contraparte.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --baja --contraparte-id <uuid> --vigencia-hasta YYYY-MM-DD`;

export function argumentos(argv: readonly string[]): ArgumentosAltaContraparte {
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

  // Guard, PRE-parseo de Zod: --patron con forma de documento (7+ dígitos con separador opcional) se
  // rechaza — mismo criterio que Guard 2 de alta-socio.ts, con el heurístico más amplio que
  // corresponde acá (ver el comentario de RE_POSIBLE_DOCUMENTO_EN_TEXTO).
  const patron = mapa.get('patron');
  if (patron !== undefined && sinEstado(RE_POSIBLE_DOCUMENTO_EN_TEXTO).test(patron)) {
    throw new Error(
      `--patron tiene forma de documento (7+ dígitos, con o sin separadores) — no se acepta. Si el ` +
        `nombre real del proveedor/cliente contiene una cadena larga de dígitos (código postal, ` +
        `número de sucursal), este guard la va a rechazar como falso positivo: es el trade-off ` +
        `aceptado (mismo criterio que padron_socio). No hay forma de cargarlo por este camino; avisá ` +
        `a quien mantiene el CLI si el caso es real.${SALTO}${SALTO}${MENSAJE_USO}`,
    );
  }

  // Guard, PRE-parseo: --baja mezclado con campos de alta se rechaza explícito — mismo criterio que
  // Guard 3 de alta-socio.ts (Ronda 3, tester: sin esto Zod los descarta en silencio).
  if (banderas.has('baja')) {
    const camposDeAltaSueltos = ['patron', 'clasificacion', 'vigencia-desde'].filter((c) => mapa.has(c));
    if (camposDeAltaSueltos.length > 0) {
      throw new Error(
        `--baja no se combina con ${camposDeAltaSueltos.map((c) => `--${c}`).join(', ')} — son campos ` +
          `de alta. Una baja usa --contraparte-id y --vigencia-hasta, nada más.${SALTO}${SALTO}${MENSAJE_USO}`,
      );
    }
  }

  const crudo = banderas.has('baja')
    ? {
        baja: true,
        cliente: mapa.get('cliente') ?? '',
        usuario: mapa.get('usuario') ?? '',
        contraparteId: mapa.get('contraparte-id') ?? '',
        vigenciaHasta: mapa.get('vigencia-hasta') ?? '',
      }
    : {
        baja: false,
        cliente: mapa.get('cliente') ?? '',
        usuario: mapa.get('usuario') ?? '',
        patron: patron ?? '',
        clasificacion: mapa.get('clasificacion') ?? '',
        vigenciaDesde: mapa.get('vigencia-desde') ?? '',
      };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(`Argumentos inválidos (${faltan}).${SALTO}${SALTO}${MENSAJE_USO}`);
  }
  return r.data;
}

export type MotivoAbortoAltaContraparte = 'credencial_saltea_rls' | 'contexto_no_aislado';
export type ResultadoAltaContraparte =
  | { readonly estado: 'alta'; readonly contraparteId: string }
  | { readonly estado: 'baja'; readonly contraparteId: string }
  | {
      readonly estado: 'abortado';
      readonly motivoCodigo:
        | MotivoAbortoAltaContraparte
        | 'BAJA_CONTRAPARTE_NO_ENCONTRADA'
        | 'BAJA_MISMO_DIA_DE_ALTA';
    };

export async function escribirAltaDeContraparte(args: {
  readonly cliente: string;
  readonly usuario: string;
  readonly patron: string;
  readonly clasificacion: string;
  readonly vigenciaDesde: string;
}): Promise<ResultadoAltaContraparte> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('alta_contraparte.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const resultado = await conUsuario(args.usuario, (tx) =>
    escribirConAuditoria(
      tx,
      {
        clienteId: args.cliente,
        accion: 'escritura',
        recurso: 'padron_contraparte',
        motivo: 'alta de contraparte del padron, migracion 0037',
      },
      (ctx) =>
        altaDeContraparte(tx, ctx, {
          clienteId: args.cliente,
          patron: normalizar(args.patron),
          clasificacion: args.clasificacion,
          vigenteDesde: args.vigenciaDesde,
        }),
    ),
  );

  log.info('alta_contraparte.creado', { cliente_id: args.cliente });

  return { estado: 'alta', contraparteId: resultado.contraparteId };
}

export async function escribirBajaDeContraparte(args: {
  readonly cliente: string;
  readonly usuario: string;
  readonly contraparteId: string;
  readonly vigenciaHasta: string;
}): Promise<ResultadoAltaContraparte> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('alta_contraparte.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  try {
    const resultado = await conUsuario(args.usuario, (tx) =>
      escribirConAuditoria(
        tx,
        {
          clienteId: args.cliente,
          accion: 'escritura',
          recurso: 'padron_contraparte',
          motivo: 'baja de contraparte del padron, migracion 0037',
        },
        (ctx) =>
          bajaDeContraparte(tx, ctx, {
            clienteId: args.cliente,
            contraparteId: args.contraparteId,
            vigenteHasta: args.vigenciaHasta,
          }),
      ),
    );
    log.info('alta_contraparte.baja', { cliente_id: args.cliente });
    return { estado: 'baja', contraparteId: resultado.contraparteId };
  } catch (error) {
    if (error instanceof BajaDeContraparteNoEncontradaError) {
      return { estado: 'abortado', motivoCodigo: 'BAJA_CONTRAPARTE_NO_ENCONTRADA' };
    }
    if (error instanceof BajaMismoDiaDeAltaContraparteError) {
      log.error('alta_contraparte.abortado', { motivo_codigo: 'BAJA_MISMO_DIA_DE_ALTA' });
      return { estado: 'abortado', motivoCodigo: 'BAJA_MISMO_DIA_DE_ALTA' };
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/alta-contraparte.ts');

if (esEjecucionDirecta) {
  try {
    const args = argumentos(process.argv.slice(2));

    if (args.baja) {
      const r = await escribirBajaDeContraparte(args);
      imprimir(JSON.stringify(r));
      process.exit(r.estado === 'abortado' ? 1 : 0);
    }

    imprimir('');
    imprimir(`  Cliente          ${args.cliente}`);
    imprimir(`  Patrón           ${args.patron}`);
    imprimir(`  Clasificación    ${args.clasificacion}`);
    imprimir(`  Vigente desde    ${args.vigenciaDesde}`);

    const r = await escribirAltaDeContraparte(args);

    imprimir('');
    if (r.estado === 'alta') {
      imprimir('  Alta OK.');
      imprimir(`    contraparte_id   ${r.contraparteId}`);
    } else {
      imprimir(`  ABORTA: ${JSON.stringify(r)}`);
    }
    imprimir('');
    process.exit(r.estado === 'abortado' ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
