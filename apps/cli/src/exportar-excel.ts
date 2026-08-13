/**
 * CLI DE EXPORT — movimientos ya ingeridos a un `.xlsx`, para el primer entregable real de Laura (demo
 * del piloto). Plan `adaptive-herding-pillow` (CLAUDE.md §3.2, disparado por (b) y (d)).
 *
 *     pnpm exportar:excel --cliente <uuid> --usuario <uuid> --motivo <codigo> --destinatario <codigo> \
 *       --lote-id <uuid>
 *
 *     pnpm exportar:excel --cliente <uuid> --usuario <uuid> --motivo <codigo> --destinatario <codigo> \
 *       --listar [--banco <codigo>]
 *
 * ## Por qué `--banco` no selecciona un lote directo
 *
 * `lote_ingesta` no tiene índice por `banco_codigo` y un cliente puede tener varios lotes del mismo
 * banco (uno por mes). Adivinar cuál exportar es exactamente lo que `completar-lote.ts` ya declaró que
 * no hace ("nunca se cae a 'el más reciente'") — acá el riesgo es peor: adivinar mal exporta el mes
 * equivocado a un archivo que sale del sistema. `--banco` (opcional) solo FILTRA `--listar`; para
 * exportar hace falta el uuid exacto de `--lote-id`.
 *
 * ## El archivo es N2-R (ADR-0002 §A.2.2) — controles, en el orden en que corren
 *
 * 1. Guard R18 (`verificarCredencialDeRequest`).
 * 2. `--listar`: solo lectura, sin reservar archivo. Termina acá.
 * 3. `resolverBanco` — una `conUsuario` propia, SECUENCIAL (nunca anidada), best-effort y NUNCA
 *    decisoria: lee `lote_ingesta.banco_codigo` (N1, sin auditar) solo para que el nombre del archivo
 *    sea legible. `null` no aborta nada acá — el export sigue y aborta por su propia razón si el lote
 *    no existe.
 * 4. Reservar el destino con `wx` (nunca pisa, nunca sufija) — ANTES de abrir la transacción del export,
 *    para que una falla de disco aborte antes de auditar.
 * 5. `conUsuario` → `exportarPlanillaDeLote` (rol contra la base, auditoría ANTES de leer movimientos,
 *    arma el libro EN MEMORIA).
 * 6. Chequeo de coherencia: si el banco de la lectura previa (paso 3) no coincide con el banco real
 *    devuelto en el paso 5, aborta con `banco_incoherente` — **cero bytes escritos**. Un nombre de
 *    archivo que dice un banco distinto del contenido es peor que uno sin banco.
 * 7. Recién con la transacción ya commiteada y el banco coherente, se escribe el buffer al `fd`
 *    reservado. Nunca antes: el archivo no puede aterrizar en disco si el commit no ocurrió
 *    (`auditoria.ts`: "la auditoría se commitea antes del efecto, en su propia transacción").
 *
 * `motivo`/`destinatario` de vocabulario CERRADO — nunca texto libre del operador: `acceso_auditoria`
 * es append-only y sin remediación posible para un dato que no debía estar ahí.
 */

import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { conUsuario, verificarCredencialDeRequest, type Tx } from '@sistema-contable/data';
import {
  DESTINATARIOS_EXPORT,
  exportarPlanillaDeLote,
  listarLotesExportables,
  MOTIVOS_EXPORT,
  RE_BANCO_CODIGO,
  resolverBancoDelLote,
  type LoteExportable,
  type MotivoAbortoPlanilla,
} from '@sistema-contable/ingesta';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv, raizDelRepo } from '../../../tools/cargar-env.ts';

cargarEnv();

type CamposExport =
  | 'cliente_id'
  | 'usuario_id'
  | 'lote_id'
  | 'banco_codigo'
  | 'lotes'
  | 'filas'
  | 'cuentas'
  | 'archivo_nombre'
  | 'archivo_bytes'
  | 'correlacion'
  | 'motivo_codigo'
  | 'causa_tipo'
  | 'destruir_antes_de';
const log = loggerAcotado<CamposExport>();

/** Nunca `error.message` crudo, ni redactado: un parser/serializador puede interpolar el contenido que
 *  estaba procesando (mismo criterio que `comparar-titularidad.ts`) — este script tiene un mes entero de
 *  glosas e importes en memoria cuando `exceljs` puede tirar. Solo el nombre del constructor. */
function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANDERAS = new Set(['listar']);

const esquemaArgumentos = z
  .object({
    cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
    usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
    motivo: z.enum(MOTIVOS_EXPORT),
    destinatario: z.enum(DESTINATARIOS_EXPORT),
    loteId: z.string().regex(RE_UUID, 'el --lote-id tiene que ser un uuid').optional(),
    banco: z.string().regex(RE_BANCO_CODIGO, 'el --banco tiene que tener forma de código').optional(),
    cuenta: z.string().regex(RE_UUID, 'el --cuenta tiene que ser un uuid').optional(),
    listar: z.boolean(),
  })
  .refine((a) => a.listar !== (a.loteId !== undefined), {
    message: 'elegí exactamente uno: --lote-id <uuid> para exportar, o --listar para ver cuáles hay',
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

  const crudo: Record<string, unknown> = {
    cliente: mapa.get('cliente') ?? '',
    usuario: mapa.get('usuario') ?? '',
    motivo: mapa.get('motivo') ?? '',
    destinatario: mapa.get('destinatario') ?? '',
    listar: banderas.has('listar'),
  };
  if (mapa.has('lote-id')) crudo['loteId'] = mapa.get('lote-id');
  if (mapa.has('banco')) crudo['banco'] = mapa.get('banco');
  if (mapa.has('cuenta')) crudo['cuenta'] = mapa.get('cuenta');

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).\n\n` +
        '  pnpm exportar:excel --cliente <uuid> --usuario <uuid> --motivo <codigo> ' +
        '--destinatario <codigo> --lote-id <uuid>\n' +
        '  pnpm exportar:excel --cliente <uuid> --usuario <uuid> --motivo <codigo> ' +
        '--destinatario <codigo> --listar [--banco <codigo>]\n\n' +
        `  motivo: ${MOTIVOS_EXPORT.join(' | ')}\n` +
        `  destinatario: ${DESTINATARIOS_EXPORT.join(' | ')}`,
    );
  }
  return r.data as Argumentos;
}

export const MOTIVOS_ABORTO_CLI = [
  'credencial_saltea_rls',
  'contexto_no_aislado',
  'destino_existe',
  'escritura_fallida',
  'banco_incoherente',
] as const;

/** Días hasta la destrucción recomendada del archivo (decisión del usuario, HANDOFF 2026-08-12 (46)):
 *  el borrado sigue siendo un acto humano —nunca automático, ADR-0002 §F.3.8—, esto es solo el cálculo
 *  y el recordatorio para que no dependa enteramente de que alguien lo haga a mano. */
export const TTL_DIAS_RECOMENDADO = 7;

function destruccionRecomendada(generadoEn: string): string {
  const ms = new Date(generadoEn).getTime() + TTL_DIAS_RECOMENDADO * 24 * 60 * 60 * 1000;
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10);
}

export type ResultadoExportarExcel =
  | {
      readonly estado: 'exportado';
      readonly loteId: string;
      readonly archivo: string;
      readonly bytes: number;
      readonly filas: number;
      readonly cuentas: number;
      readonly verificacion: readonly string[];
      readonly destruirAntesDe: string;
    }
  | { readonly estado: 'listado'; readonly lotes: readonly LoteExportable[] }
  | { readonly estado: 'sin_datos'; readonly loteId: string }
  | {
      readonly estado: 'abortado';
      readonly motivoCodigo: MotivoAbortoPlanilla | (typeof MOTIVOS_ABORTO_CLI)[number];
      readonly filaNumero?: number;
    };

/** Reserva y escribe el archivo. Inyectable: es lo que permite testear "la auditoría commiteó pero la
 *  escritura a disco falló" sin mockear `node:fs` entero — solo esta interfaz angosta. */
export type EscritorReservado = {
  readonly reservar: (destino: string) => number;
  readonly escribir: (fd: number, datos: Uint8Array) => void;
};

/** Exportado para que el test pueda ejercitar el camino real (`openSync`/`writeSync`/`closeSync` sobre
 *  el mismo `fd`) — no solo los dobles de prueba, que reabren por ruta. */
export const escritorReal: EscritorReservado = {
  reservar: (destino) => openSync(destino, 'wx', 0o600),
  escribir: (fd, datos) => {
    try {
      // `writeSync` puede escribir MENOS bytes de los pedidos sin lanzar (`code-reviewer`): se verifica
      // el conteo devuelto en vez de confiar en que no haya tirado. Un `.xlsx` truncado que se reporta
      // como `exportado` es peor que uno que aborta con `escritura_fallida`.
      const escritos = writeSync(fd, datos);
      if (escritos !== datos.byteLength) {
        throw new Error(`escritura incompleta: ${escritos} de ${datos.byteLength} bytes`);
      }
    } finally {
      closeSync(fd);
    }
  },
};

/** Lee el `banco_codigo` de un lote ANTES de reservar el archivo — el diferenciador nuevo (N1, seguro
 *  bajo R30) que hace el nombre legible. Inyectable: es lo que permite forzar en un test una
 *  discrepancia determinística contra la lectura REAL de `exportarPlanillaDeLote`, sin depender de
 *  timing entre dos transacciones. */
export type ResolverBanco = (
  tx: Tx,
  args: { readonly clienteId: string; readonly loteId: string },
) => Promise<string | null>;

/**
 * El nombre es una ETIQUETA, no una clave — el join real con `acceso_auditoria` es `correlacion` (ya
 * logueada en `exportar.completado`). No parsear este string en otro lado del sistema.
 *
 * `cliente8` va primero (no el banco): agrupa por tenant en cualquier listado de `salida/`, que es el
 * momento en que alguien elige qué adjuntar — el riesgo #1 de este archivo es secreto fiscal, no
 * legibilidad (`security-engineer`, plan `adaptive-herding-pillow`).
 *
 * `bancoCodigo` puede ser `null` (la lectura previa no encontró el lote) — el nombre queda sin ese
 * segmento y el export va a abortar más adelante por una razón real, si corresponde. Se revalida contra
 * `RE_BANCO_CODIGO` en el borde, aunque la base ya lo garantiza (`banco_codigo_chk`): un `path.join` no
 * hereda garantías de una constraint de otro paquete.
 */
function nombreDeArchivo(
  clienteId: string,
  bancoCodigo: string | null,
  loteId: string,
  generadoEn: string,
): string {
  const timestamp = generadoEn.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const banco = bancoCodigo !== null && RE_BANCO_CODIGO.test(bancoCodigo) ? `${bancoCodigo}_` : '';
  return `movimientos_${clienteId.slice(0, 8)}_${banco}${loteId.slice(0, 8)}_${timestamp}.xlsx`;
}

/** Corre el export. Separado del CLI para que el test lo ejercite sin `process.exit`, mismo patrón que
 *  `ingestar()`/`completarLote()`. */
export async function exportarExcel(
  args: Argumentos,
  escritor: EscritorReservado = escritorReal,
  resolverBanco: ResolverBanco = resolverBancoDelLote,
): Promise<ResultadoExportarExcel> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('exportar.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  if (args.listar) {
    return conUsuario(args.usuario, async (tx) => {
      const lotes = await listarLotesExportables(tx, {
        clienteId: args.cliente,
        ...(args.banco === undefined ? {} : { bancoCodigo: args.banco }),
      });
      log.info('exportar.listado', { cliente_id: args.cliente, lotes: lotes.length });
      return { estado: 'listado' as const, lotes };
    });
  }

  const loteId = args.loteId;
  if (loteId === undefined) {
    // El `.refine()` del esquema ya lo garantiza; esto es solo para que el tipo lo sepa acá.
    throw new Error('inalcanzable: parsearArgumentos exige --lote-id cuando no es --listar');
  }

  const generadoEn = new Date().toISOString();

  // Lectura previa, N1, best-effort — NUNCA decisoria. Su propia `conUsuario`, SECUENCIAL (nunca anidada
  // dentro de la del export real) y sin rol-check ni auditoría: solo toca `lote_ingesta.banco_codigo`,
  // que no tiene ninguna columna ≥ N2. `null` (lote inexistente/de otro cliente) → el nombre queda sin
  // ese segmento y el export aborta más adelante por su propia razón real, si corresponde.
  const bancoParaElNombre = await conUsuario(args.usuario, (tx) =>
    resolverBanco(tx, { clienteId: args.cliente, loteId }),
  );

  const nombre = nombreDeArchivo(args.cliente, bancoParaElNombre, loteId, generadoEn);
  const dirSalida = join(raizDelRepo(), 'salida');
  mkdirSync(dirSalida, { recursive: true, mode: 0o700 });
  const destino = join(dirSalida, nombre);

  let fd: number;
  try {
    fd = escritor.reservar(destino);
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
      unlinkSync(destino);
    } catch {
      /* si ya no está, no hay nada que limpiar */
    }
  };

  // `conUsuario`/`exportarPlanillaDeLote` pueden LANZAR (no solo devolver `abortado`): un error de red o
  // de base entre auditar y armar el libro. Sin este `catch`, el `fd` reservado queda huérfano en
  // `salida/` para siempre — exactamente lo que la reserva-antes-de-tx existe para evitar. `code-reviewer`
  // lo encontró: no había ningún test que lanzara desde adentro de `conUsuario`.
  let resultado;
  try {
    resultado = await conUsuario(args.usuario, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: args.cliente,
        loteId,
        ...(args.cuenta === undefined ? {} : { cuentaBancariaId: args.cuenta }),
        motivoCodigo: args.motivo,
        destinatarioCodigo: args.destinatario,
        generadoEn,
      }),
    );
  } catch (error) {
    limpiarReserva();
    throw error;
  }

  if (resultado.estado !== 'armada') {
    limpiarReserva();
    if (resultado.estado === 'sin_datos') {
      log.warn('exportar.sin_datos', { cliente_id: args.cliente, lote_id: loteId });
      return { estado: 'sin_datos', loteId: resultado.loteId };
    }
    log.warn('exportar.abortado', { cliente_id: args.cliente, lote_id: loteId, motivo_codigo: resultado.motivoCodigo });
    return resultado.filaNumero === undefined
      ? { estado: 'abortado', motivoCodigo: resultado.motivoCodigo }
      : { estado: 'abortado', motivoCodigo: resultado.motivoCodigo, filaNumero: resultado.filaNumero };
  }

  /**
   * Chequeo de coherencia — falla cerrado, ANTES de escribir un solo byte. La lectura previa es
   * best-effort y su propia `conUsuario` cerró antes de esta; la policy de `UPDATE` sobre `lote_ingesta`
   * incluye `administrativo` (que está excluido de `ROLES_QUE_EXPORTAN`), así que en teoría el
   * `banco_codigo` real puede cambiar entre las dos lecturas (`security-engineer`, plan
   * `adaptive-herding-pillow`). Un archivo cuyo NOMBRE dice un banco y cuyo CONTENIDO es de otro es un
   * riesgo de mala entrega/mal archivado sobre un N2-R — se aborta, nunca se sufija ni se "corrige".
   */
  if (bancoParaElNombre !== null && bancoParaElNombre !== resultado.bancoCodigo) {
    limpiarReserva();
    log.error('exportar.abortado', {
      cliente_id: args.cliente,
      lote_id: loteId,
      correlacion: resultado.correlacion,
      motivo_codigo: 'banco_incoherente',
    });
    return { estado: 'abortado', motivoCodigo: 'banco_incoherente' };
  }

  try {
    escritor.escribir(fd, resultado.libro);
  } catch (error) {
    limpiarReserva();
    log.error('exportar.parcial_eliminado', { correlacion: resultado.correlacion, causa_tipo: causaTipo(error) });
    return { estado: 'abortado', motivoCodigo: 'escritura_fallida' };
  }

  const destruirAntesDe = destruccionRecomendada(generadoEn);

  log.info('exportar.completado', {
    cliente_id: args.cliente,
    lote_id: loteId,
    banco_codigo: resultado.bancoCodigo,
    correlacion: resultado.correlacion,
    filas: resultado.filas,
    cuentas: resultado.cuentas,
    archivo_nombre: nombre,
    archivo_bytes: resultado.libro.byteLength,
    destruir_antes_de: destruirAntesDe,
  });

  return {
    estado: 'exportado',
    loteId,
    archivo: destino,
    bytes: resultado.libro.byteLength,
    filas: resultado.filas,
    cuentas: resultado.cuentas,
    verificacion: resultado.verificacion,
    destruirAntesDe,
  };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/exportar-excel.ts');

if (esEjecucionDirecta) {
  const salto = String.fromCharCode(10);
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await exportarExcel(args);
    process.stdout.write(`${JSON.stringify(r)}${salto}`);
    process.exit(r.estado === 'exportado' || r.estado === 'listado' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${salto}`);
    process.exit(2);
  }
}
