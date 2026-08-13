/**
 * ALTA (Y BAJA) DE SOCIO DEL PADRÓN — `packages/data/src/contabilidad/escrituras.ts`, migración
 * `0013_contraparte_hmac_y_padron.sql`. Plan `adaptive-herding-pillow` (Módulo 2, capa C), P3.
 *
 *     pnpm alta:socio --cliente <uuid> --usuario <uuid> --denominacion "<razón social>" \
 *       --documento-tipo cuit|cuil --vigencia-desde YYYY-MM-DD
 *       (el CUIT/CUIL se pide en un prompt oculto con doble tipeo — NUNCA por argumento)
 *
 *     pnpm alta:socio --cliente <uuid> --usuario <uuid> --baja --socio-id <uuid> \
 *       --vigencia-hasta YYYY-MM-DD
 *
 * ## Por qué el documento nunca entra por argumento — mismo riesgo que el CBU
 *
 * Un CUIT/CUIL de socio es la misma clase de dato que el CBU de `alta-cuenta.ts`: identificador N2-R
 * de un tercero. Historial de PowerShell en texto plano, línea de comandos legible por cualquier
 * proceso del mismo usuario, contexto de un agente (ADR-0002 §F.2.5) — las tres razones de
 * `alta-cuenta.ts` aplican sin cambios. Ronda 1 de convocatoria de este plan (`security-engineer` +
 * `seguridad-datos-financieros`) lo marcó como bloqueante: es la misma reincidencia que ya pasó una
 * vez con `--cbu` (HANDOFF 36), corregida acá desde el diseño.
 *
 * El documento se pide con `pedirValorConfirmado` (`./prompt-oculto.ts`, la maquinaria genérica
 * extraída de `alta-cuenta.ts` para esta reutilización), con doble tipeo — mismo criterio que el
 * CBU: dos CUIT del mismo largo producen la misma `forma()`, así que la única autoverificación
 * posible sin mostrar el valor es pedirlo dos veces.
 *
 * ## El segundo guard — `--denominacion` con forma de documento
 *
 * `padron_socio_denominacion_sin_identificador_chk` (migración 0013) impide que el documento se cuele
 * en `denominacion` **en la base** — pero actúa DESPUÉS de que el valor ya viajó por `argv`. Este
 * archivo agrega el mismo guard en la aplicación, ANTES del parseo (Ronda 1,
 * `seguridad-datos-financieros`): un `--denominacion` con forma de CUIT o DNI se rechaza igual,
 * aunque no haya venido por `--documento`.
 *
 * ## Qué imprime
 *
 * uuid, la forma del documento (`••••1234`, nunca el valor), y la denominación en texto — que no es
 * fuga en el mismo sentido: el operador la acaba de tipear él mismo, a la vista, en el mismo prompt.
 */

import { z } from 'zod';
import {
  altaDeSocio,
  bajaDeSocio,
  BajaDeSocioNoEncontradaError,
  BajaMismoDiaDeAltaError,
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  verificarCredencialDeRequest,
} from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import {
  RE_CUIT,
  RE_DNI,
  redactar,
  sinEstado,
  TIPOS_DOCUMENTO_SOCIO,
  verificadorCuitEsValido,
} from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';
import { pedirValorConfirmado, type EntradaOculta, type SalidaOculta } from './prompt-oculto.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);

type CamposAltaSocio =
  | 'cliente_id'
  | 'usuario_id'
  | 'socio_id'
  | 'documento_tipo'
  | 'pepper_id'
  | 'motivo_codigo'
  | 'causa_tipo';
// NO incluye 'documento' ni 'denominacion' — el tipo del logger no las acepta.
const log = loggerAcotado<CamposAltaSocio>();

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
const BANDERAS_PROHIBIDAS = ['documento', 'cuit', 'cuil', 'dni'] as const;
const BANDERAS = new Set(['baja']);

const esquemaAlta = z.object({
  baja: z.literal(false),
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  denominacion: z.string().min(1).max(200),
  documentoTipo: z.enum(TIPOS_DOCUMENTO_SOCIO),
  vigenciaDesde: z.string().regex(RE_FECHA),
});
const esquemaBaja = z.object({
  baja: z.literal(true),
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  socioId: z.string().regex(RE_UUID),
  vigenciaHasta: z.string().regex(RE_FECHA),
});
const esquemaArgumentos = z.discriminatedUnion('baja', [esquemaAlta, esquemaBaja]);
export type ArgumentosAltaSocio = z.infer<typeof esquemaArgumentos>;

const MENSAJE_USO =
  `  node apps/cli/src/alta-socio.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --denominacion "<razón social>" --documento-tipo cuit|cuil --vigencia-desde YYYY-MM-DD${SALTO}${SALTO}` +
  `  node apps/cli/src/alta-socio.ts --cliente <uuid> --usuario <uuid> \\${SALTO}` +
  `    --baja --socio-id <uuid> --vigencia-hasta YYYY-MM-DD${SALTO}${SALTO}` +
  `  El documento (CUIT/CUIL) NUNCA se pasa por argumento: se pide en un prompt oculto, con doble tipeo.`;

export function argumentos(argv: readonly string[]): ArgumentosAltaSocio {
  // Guard 1, PRE-parseo: --documento/--cuit/--cuil/--dni no son argumentos válidos, con o sin `=`
  // (idéntico al chequeo de --cbu en alta-cuenta.ts, por cada nombre prohibido).
  for (const prohibida of BANDERAS_PROHIBIDAS) {
    if (argv.some((a) => a === `--${prohibida}` || a.startsWith(`--${prohibida}=`))) {
      throw new Error(
        `--${prohibida} ya no es un argumento válido: quedaría en texto plano en el historial de ` +
          `PowerShell (mismo riesgo que --cbu en alta-cuenta.ts). El documento se pide en un prompt ` +
          `oculto, nunca por argumento.${SALTO}${SALTO}${MENSAJE_USO}`,
      );
    }
  }

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

  // Guard 2, PRE-parseo de Zod: --denominacion con forma de documento se rechaza, aunque no haya
  // venido por --documento (Ronda 1, seguridad-datos-financieros).
  const denominacion = mapa.get('denominacion');
  if (denominacion !== undefined) {
    if (sinEstado(RE_CUIT).test(denominacion) || sinEstado(RE_DNI).test(denominacion)) {
      throw new Error(
        `--denominacion tiene forma de documento (CUIT/CUIL o DNI) — no se acepta. El documento se ` +
          `pide aparte, en un prompt oculto.${SALTO}${SALTO}${MENSAJE_USO}`,
      );
    }
  }

  // Guard 3, PRE-parseo: --baja mezclado con campos de alta (--denominacion/--documento-tipo/
  // --vigencia-desde) se rechaza explícito — sin esto, Zod los descarta en silencio al armar el
  // objeto de la rama `baja` y el operador nunca sabe que los tipeó en vano (Ronda 3, `tester`).
  if (banderas.has('baja')) {
    const camposDeAltaSueltos = ['denominacion', 'documento-tipo', 'vigencia-desde'].filter((c) => mapa.has(c));
    if (camposDeAltaSueltos.length > 0) {
      throw new Error(
        `--baja no se combina con ${camposDeAltaSueltos.map((c) => `--${c}`).join(', ')} — son campos ` +
          `de alta. Una baja usa --socio-id y --vigencia-hasta, nada más.${SALTO}${SALTO}${MENSAJE_USO}`,
      );
    }
  }

  const crudo = banderas.has('baja')
    ? {
        baja: true,
        cliente: mapa.get('cliente') ?? '',
        usuario: mapa.get('usuario') ?? '',
        socioId: mapa.get('socio-id') ?? '',
        vigenciaHasta: mapa.get('vigencia-hasta') ?? '',
      }
    : {
        baja: false,
        cliente: mapa.get('cliente') ?? '',
        usuario: mapa.get('usuario') ?? '',
        denominacion: denominacion ?? '',
        documentoTipo: mapa.get('documento-tipo') ?? '',
        vigenciaDesde: mapa.get('vigencia-desde') ?? '',
      };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(`Argumentos inválidos (${faltan}).${SALTO}${SALTO}${MENSAJE_USO}`);
  }
  return r.data;
}

export type MotivoAbortoAltaSocio = 'credencial_saltea_rls' | 'contexto_no_aislado';
export type ResultadoAltaSocio =
  | { readonly estado: 'alta'; readonly socioId: string; readonly documentoUltimos4: string; readonly pepperId: string }
  | { readonly estado: 'baja'; readonly socioId: string }
  | {
      readonly estado: 'abortado';
      readonly motivoCodigo: MotivoAbortoAltaSocio | 'BAJA_SOCIO_NO_ENCONTRADO' | 'BAJA_MISMO_DIA_DE_ALTA';
    };

/**
 * Escribe el alta. El documento YA viene resuelto (test o prompt) — nunca se prompea acá adentro,
 * mismo criterio de separación que `backfillContraparte()`, un escalón más estricto: acá ni siquiera
 * el I/O interactivo entra a la función que el test ejercita.
 */
export async function escribirAltaDeSocio(args: {
  readonly cliente: string;
  readonly usuario: string;
  readonly denominacion: string;
  readonly documentoTipo: 'cuit' | 'cuil';
  readonly documento: string;
  readonly vigenciaDesde: string;
}): Promise<ResultadoAltaSocio> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('alta_socio.abortado', { motivo_codigo: 'credencial_saltea_rls' });
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
        recurso: 'padron_socio',
        motivo: 'alta de socio del padron, Modulo 2 capa C',
      },
      (ctx) =>
        altaDeSocio(tx, ctx, {
          clienteId: args.cliente,
          denominacion: args.denominacion,
          documentoTipo: args.documentoTipo,
          documento: args.documento,
          vigenteDesde: args.vigenciaDesde,
        }),
    ),
  );

  log.info('alta_socio.creado', {
    cliente_id: args.cliente,
    socio_id: resultado.socioId,
    documento_tipo: args.documentoTipo,
    pepper_id: resultado.pepperId,
  });

  return {
    estado: 'alta',
    socioId: resultado.socioId,
    documentoUltimos4: resultado.documentoUltimos4,
    pepperId: resultado.pepperId,
  };
}

export async function escribirBajaDeSocio(args: {
  readonly cliente: string;
  readonly usuario: string;
  readonly socioId: string;
  readonly vigenciaHasta: string;
}): Promise<ResultadoAltaSocio> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('alta_socio.abortado', { motivo_codigo: 'credencial_saltea_rls' });
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
          recurso: 'padron_socio',
          motivo: 'baja de socio del padron, Modulo 2 capa C',
        },
        (ctx) => bajaDeSocio(tx, ctx, { clienteId: args.cliente, socioId: args.socioId, vigenteHasta: args.vigenciaHasta }),
      ),
    );
    log.info('alta_socio.baja', { cliente_id: args.cliente, socio_id: resultado.socioId });
    return { estado: 'baja', socioId: resultado.socioId };
  } catch (error) {
    if (error instanceof BajaDeSocioNoEncontradaError) {
      return { estado: 'abortado', motivoCodigo: 'BAJA_SOCIO_NO_ENCONTRADO' };
    }
    if (error instanceof BajaMismoDiaDeAltaError) {
      log.error('alta_socio.abortado', { motivo_codigo: 'BAJA_MISMO_DIA_DE_ALTA' });
      return { estado: 'abortado', motivoCodigo: 'BAJA_MISMO_DIA_DE_ALTA' };
    }
    throw error;
  }
}

/** El prompt del documento — solo se usa en el bloque de ejecución directa, nunca en las funciones de
 *  arriba. Valida forma (11 dígitos) y dígito verificador antes de aceptar el valor. */
export async function pedirDocumentoConfirmado(
  entrada: EntradaOculta = process.stdin,
  salida: SalidaOculta = process.stdout,
): Promise<string> {
  const valor = await pedirValorConfirmado(
    {
      primero: '  CUIT/CUIL (11 dígitos): ',
      segundo: '  Repetí el CUIT/CUIL para confirmar: ',
      aviso: [
        'Se pide acá, tecleado, para que nunca quede en el historial de la terminal.',
        'No lo copies ni lo pegues de ningún chat, ticket, captura ni asistente de IA — tipealo directo.',
        'No vas a ver NADA en pantalla mientras tipeás — ni un asterisco, a propósito. Escribí los 11 ' +
          'dígitos igual y apretá Enter; después va a aparecer un segundo pedido para confirmarlo.',
      ],
    },
    entrada,
    salida,
  );
  const normalizado = valor.replace(/\D/g, '');
  if (!/^\d{11}$/.test(normalizado)) {
    throw new Error('El valor no tiene forma de CUIT/CUIL (11 dígitos).');
  }
  if (!verificadorCuitEsValido(normalizado)) {
    throw new Error('El dígito verificador no es válido.');
  }
  return normalizado;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/alta-socio.ts');

if (esEjecucionDirecta) {
  try {
    const args = argumentos(process.argv.slice(2));

    if (args.baja) {
      const r = await escribirBajaDeSocio(args);
      imprimir(JSON.stringify(r));
      process.exit(r.estado === 'abortado' ? 1 : 0);
    }

    // Confirmación NO secreta (denominación, tipo, vigencia) — mitiga error de tipeo sin ocultar nada
    // que el operador ya vio en su propia pantalla al tipearlo.
    imprimir('');
    imprimir(`  Cliente          ${args.cliente}`);
    imprimir(`  Denominación     ${args.denominacion}`);
    imprimir(`  Tipo documento   ${args.documentoTipo}`);
    imprimir(`  Vigente desde    ${args.vigenciaDesde}`);

    const documento = await pedirDocumentoConfirmado();
    const r = await escribirAltaDeSocio({ ...args, documento });

    imprimir('');
    if (r.estado === 'alta') {
      imprimir('  Alta OK.');
      imprimir(`    socio_id     ${r.socioId}`);
      imprimir(`    documento    ••••${r.documentoUltimos4}`);
      imprimir(`    pepper_id    ${r.pepperId}`);
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
