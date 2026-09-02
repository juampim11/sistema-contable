/**
 * CLI DE RELEVAMIENTO PARA LAURA — Excel de 3 hojas con datos AGREGADOS de Bracci y ROKA, para que la
 * contadora del estudio conteste el criterio contable de un lote de decisiones ya identificadas por el
 * motor. Plan aprobado por JP tras convocatoria completa (`motor-conciliacion-contable`,
 * `contador-dominio`, `qa-funcional`, `ux-designer`, `seguridad-datos-financieros`,
 * `security-engineer`). Mismo esqueleto que `apps/cli/src/exportar-excel.ts` — mismo guard R18, mismo
 * orden reservar-antes-de-auditar, misma escritura atómica `wx`.
 *
 *     pnpm exportar:relevamiento-laura --bracci-id <uuid> --roka-id <uuid> --usuario <uuid> \
 *       --salida <ruta-de-archivo> --listas <ruta-json>
 *
 * ## `--listas`, y por qué existe (no está en el plan original)
 *
 * El diseño da los literales concretos de las dos listas desplegables de la Hoja 1 — nombres reales de
 * socios de dos clientes reales del piloto. Hardcodearlos en ESTE archivo (git-versionado) los deja en
 * el historial para siempre, legibles por cualquier agente futuro que lo abra — con independencia de
 * que el DATO en sí esté autorizado a viajar al `.xlsx` (lo está: N2 exportable, destinatario
 * `estudio_interno`, mismo gate que ya cubre capa C en `exportar-planilla.ts`). Por eso las dos listas
 * se leen de un archivo JSON que JP aporta en el momento de la corrida real:
 *
 *     { "bracci": ["Es un cliente", "...", "Otro (aclarar abajo)"],
 *       "roka":   ["Es un cliente", "...", "Otro (aclarar abajo)"] }
 *
 * Nunca commiteado, nunca dentro de `privado/` por decisión de este CLI (la ruta la elige JP; este
 * archivo no la asume ni la fuerza) — es una desviación deliberada del literal del plan, señalada acá y
 * en el reporte de cierre de la tarea para que JP la revise.
 *
 * ## El archivo es N2 (agregado, nunca movimiento por movimiento) — controles, en el orden en que corren
 *
 * 1. Guard R18 (`verificarCredencialDeRequest`).
 * 2. Parseo y validación de `--listas` — ANTES de tocar la base: un JSON mal formado aborta barato.
 * 3. Reservar el destino con `wx` (nunca pisa, nunca sufija) — ANTES de abrir la transacción de lectura.
 * 4. `conUsuario` → `relevarParaLaura` (DOS pasadas, INV-5: Bracci y ROKA nunca en la misma consulta —
 *    ver `relevamiento-laura.ts`). Dos filas de auditoría, una por cliente, ANTES de leer sus datos.
 * 5. `armarLibroLaura` — arma las 3 hojas EN MEMORIA y corre `verificarSinIdentificadores` (INV-13,
 *    fail-closed) como último paso interno. Si lanza, este CLI nunca llega al paso 6.
 * 6. Recién con el libro armado y validado, se escribe el buffer al `fd` reservado.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { z } from 'zod';
import { conUsuario, verificarCredencialDeRequest } from '@sistema-contable/data';
import {
  armarLibroLaura,
  relevarParaLaura,
  serializarLibroLaura,
  type MotivoAbortoRelevamientoLaura as MotivoAbortoLecturaLaura,
} from '@sistema-contable/ingesta';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

type CamposRelevamiento =
  | 'cliente_bracci_id'
  | 'cliente_roka_id'
  | 'usuario_id'
  | 'correlacion_bracci'
  | 'correlacion_roka'
  | 'archivo_bytes'
  | 'motivo_codigo'
  | 'causa_tipo'
  | 'destruir_antes_de';
const log = loggerAcotado<CamposRelevamiento>();

/** Mismo criterio que `exportar-excel.ts::causaTipo` — nunca `error.message` crudo: este script tiene
 *  meses de descripciones e importes de dos clientes en memoria cuando `exceljs` puede tirar. */
function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esquemaArgumentos = z.object({
  bracciId: z.string().regex(RE_UUID, 'el --bracci-id tiene que ser un uuid'),
  rokaId: z.string().regex(RE_UUID, 'el --roka-id tiene que ser un uuid'),
  usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
  salida: z.string().min(1, 'el --salida tiene que ser una ruta de archivo'),
  listas: z.string().min(1, 'el --listas tiene que ser una ruta a un JSON'),
});

export type Argumentos = z.infer<typeof esquemaArgumentos>;

export function parsearArgumentos(argv: readonly string[]): Argumentos {
  const mapa = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('--')) {
        throw new Error(`El argumento --${clave} necesita un valor.`);
      }
      mapa.set(clave, valor);
      i += 1;
    }
  }

  const crudo: Record<string, unknown> = {
    bracciId: mapa.get('bracci-id') ?? '',
    rokaId: mapa.get('roka-id') ?? '',
    usuario: mapa.get('usuario') ?? '',
    salida: mapa.get('salida') ?? '',
    listas: mapa.get('listas') ?? '',
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).\n\n` +
        '  pnpm exportar:relevamiento-laura --bracci-id <uuid> --roka-id <uuid> --usuario <uuid> ' +
        '--salida <ruta-de-archivo> --listas <ruta-json>',
    );
  }
  return r.data;
}

const esquemaListas = z.object({
  // Mínimo 2: una respuesta real + "Otro (aclarar abajo)" o equivalente — una lista de un solo
  // ítem pasaría todos los controles y produciría un desplegable sin alternativa real.
  bracci: z.array(z.string().min(1)).min(2, 'la lista de Bracci necesita al menos 2 opciones'),
  roka: z.array(z.string().min(1)).min(2, 'la lista de ROKA necesita al menos 2 opciones'),
});

export type MotivoAbortoCliRelevamientoLaura =
  | 'credencial_saltea_rls'
  | 'contexto_no_aislado'
  | 'listas_invalidas'
  | 'destino_existe'
  | 'escritura_fallida';

export type ResultadoExportarRelevamientoLaura =
  | {
      readonly estado: 'exportado';
      readonly archivo: string;
      readonly bytes: number;
      readonly correlacionBracci: string;
      readonly correlacionRoka: string;
      readonly destruirAntesDe: string;
    }
  | {
      readonly estado: 'abortado';
      readonly motivoCodigo: MotivoAbortoCliRelevamientoLaura | MotivoAbortoLecturaLaura;
    };

/** Días hasta la destrucción recomendada — mismo criterio y mismo valor que `exportar-excel.ts`
 *  (`TTL_DIAS_RECOMENDADO`, HANDOFF 2026-08-12 (46)): el borrado sigue siendo un acto humano, esto es
 *  solo el cálculo y el recordatorio. */
export const TTL_DIAS_RECOMENDADO = 7;

function destruccionRecomendada(generadoEn: string): string {
  const ms = new Date(generadoEn).getTime() + TTL_DIAS_RECOMENDADO * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Reserva y escribe el archivo. Inyectable, mismo motivo que `exportar-excel.ts::EscritorReservado`:
 *  permite testear "el libro se armó pero la escritura a disco falló" sin mockear `node:fs` entero. */
export type EscritorReservado = {
  readonly reservar: (destino: string) => number;
  readonly escribir: (fd: number, datos: Uint8Array) => void;
};

export const escritorReal: EscritorReservado = {
  reservar: (destino) => openSync(destino, 'wx', 0o600),
  escribir: (fd, datos) => {
    try {
      const escritos = writeSync(fd, datos);
      if (escritos !== datos.byteLength) {
        throw new Error(`escritura incompleta: ${escritos} de ${datos.byteLength} bytes`);
      }
    } finally {
      closeSync(fd);
    }
  },
};

/** Inyectable por el mismo motivo que `escritor`: el test necesita poder simular un JSON de listas sin
 *  depender de un archivo real en disco. */
export type LectorDeListas = (ruta: string) => string;
export const lectorDeListasReal: LectorDeListas = (ruta) => readFileSync(ruta, 'utf8');

export async function exportarRelevamientoLaura(
  args: Argumentos,
  escritor: EscritorReservado = escritorReal,
  lectorDeListas: LectorDeListas = lectorDeListasReal,
): Promise<ResultadoExportarRelevamientoLaura> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('relevamiento_laura.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  // Listas de contraparte — ANTES de reservar el archivo o tocar la base: un JSON mal formado aborta
  // barato, sin dejar un `fd` reservado huérfano ni una fila de auditoría de un intento que no iba a
  // poder terminar.
  let listas: z.infer<typeof esquemaListas>;
  try {
    const crudo: unknown = JSON.parse(lectorDeListas(args.listas));
    const r = esquemaListas.safeParse(crudo);
    if (!r.success) {
      log.warn('relevamiento_laura.abortado', { motivo_codigo: 'listas_invalidas' });
      return { estado: 'abortado', motivoCodigo: 'listas_invalidas' };
    }
    listas = r.data;
  } catch (error) {
    log.warn('relevamiento_laura.abortado', { motivo_codigo: 'listas_invalidas', causa_tipo: causaTipo(error) });
    return { estado: 'abortado', motivoCodigo: 'listas_invalidas' };
  }

  let fd: number;
  try {
    fd = escritor.reservar(args.salida);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { estado: 'abortado', motivoCodigo: 'destino_existe' };
    }
    throw error;
  }

  const limpiarReserva = (): void => {
    try {
      closeSync(fd);
    } catch {
      /* ya puede estar cerrado */
    }
    try {
      unlinkSync(args.salida);
    } catch {
      /* si ya no está, no hay nada que limpiar */
    }
  };

  const generadoEn = new Date().toISOString();

  // `conUsuario`/`relevarParaLaura` pueden LANZAR (error de red o de base entre auditar y leer) —
  // mismo `catch` que `exportar-excel.ts`: sin él, el `fd` reservado queda huérfano para siempre.
  let resultado;
  try {
    resultado = await conUsuario(args.usuario, (tx) =>
      relevarParaLaura(tx, { clienteIds: [args.bracciId, args.rokaId] }),
    );
  } catch (error) {
    limpiarReserva();
    throw error;
  }

  if (resultado.estado === 'abortado') {
    limpiarReserva();
    log.warn('relevamiento_laura.abortado', { motivo_codigo: resultado.motivoCodigo });
    return { estado: 'abortado', motivoCodigo: resultado.motivoCodigo };
  }

  // Arma el libro EN MEMORIA. `armarLibroLaura` corre `verificarSinIdentificadores` (INV-13) como
  // último paso interno y LANZA si matchea — acá abajo eso se traduce a `escritura_fallida` y la
  // reserva se limpia, nunca queda un `.xlsx` a medio escribir ni un `fd` huérfano.
  let libro;
  let buffer: Uint8Array;
  try {
    libro = await armarLibroLaura(resultado, {
      generadoEn,
      listaBracci: listas.bracci,
      listaRoka: listas.roka,
    });
    buffer = await serializarLibroLaura(libro);
  } catch (error) {
    limpiarReserva();
    log.error('relevamiento_laura.armado_fallido', { causa_tipo: causaTipo(error) });
    return { estado: 'abortado', motivoCodigo: 'escritura_fallida' };
  }

  try {
    escritor.escribir(fd, buffer);
  } catch (error) {
    limpiarReserva();
    log.error('relevamiento_laura.parcial_eliminado', { causa_tipo: causaTipo(error) });
    return { estado: 'abortado', motivoCodigo: 'escritura_fallida' };
  }

  const destruirAntesDe = destruccionRecomendada(generadoEn);

  log.info('relevamiento_laura.completado', {
    cliente_bracci_id: args.bracciId,
    cliente_roka_id: args.rokaId,
    correlacion_bracci: resultado.bracci.correlacion,
    correlacion_roka: resultado.roka.correlacion,
    archivo_bytes: buffer.byteLength,
    destruir_antes_de: destruirAntesDe,
  });

  return {
    estado: 'exportado',
    archivo: args.salida,
    bytes: buffer.byteLength,
    correlacionBracci: resultado.bracci.correlacion,
    correlacionRoka: resultado.roka.correlacion,
    destruirAntesDe,
  };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]
  ?.replace(/\\/g, '/')
  .endsWith('apps/cli/src/exportar-relevamiento-laura.ts');

if (esEjecucionDirecta) {
  const salto = String.fromCharCode(10);
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await exportarRelevamientoLaura(args);
    process.stdout.write(`${JSON.stringify(r)}${salto}`);
    process.exit(r.estado === 'exportado' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${salto}`);
    process.exit(2);
  }
}
