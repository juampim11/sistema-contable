/**
 * CLI DE RECAPTURA — backfillea `concepto_banco`/`concepto_completo`/`concepto_banco_estrategia`/
 * `pagina_pdf` sobre un lote YA PERSISTIDO, releyendo el PDF original desde storage. Plan
 * `adaptive-herding-pillow` (CLAUDE.md §3.2, disparado por (b) y (c): datos de un cliente real, y es el
 * primer lector de bytes de storage en producción del repo).
 *
 *     pnpm recapturar:conceptos --cliente <uuid> --usuario <uuid> --lote-id <uuid>              (dry-run)
 *     pnpm recapturar:conceptos --cliente <uuid> --usuario <uuid> --lote-id <uuid> --aplicar
 *
 * ## Por qué es una herramienta aparte de `completar-lote.ts`
 *
 * `completar-lote.ts` exige `estado='con_errores'` y su operación central es un INSERT (una cuenta que
 * nunca se persistió). Acá el lote ya está `procesado`/`procesado_con_observaciones` y la operación es
 * un UPDATE matcheado por `fila_hash` sobre filas que ya existen. Los guards de estado son mutuamente
 * excluyentes — no es un flag, son dos herramientas (`tech-lead`, convocado en el plan).
 *
 * ## Orden, en el orden en que corre
 *
 * 1. Guard R18.
 * 2. Lectura N1 de `lote_ingesta` (banco, `archivo_clave`, `archivo_hash`, estado) — sin auditar, sin
 *    rol: la tabla no tiene ninguna columna ≥ N2.
 * 3. `obtenerObjetoDeCliente` (`packages/almacenamiento/src/lectura.ts`): rol contra la base
 *    (`ROLES_QUE_RECAPTURAN = ['socio']`), auditoría `accion:'descarga'` **comiteada antes** del `GET` a
 *    storage, verificación de integridad contra `archivo_hash`.
 * 4. Releer el PDF con el adaptador actual (mismo camino que `completar-lote.ts`).
 * 5. `recapturarConceptosDeLote`: TOCTOU + rol otra vez + las compuertas + (si `--aplicar` y las
 *    compuertas dan limpias) el `UPDATE`.
 *
 * **Sin `--forzar`, sin flag de waiver.** Si el dry-run encuentra algo sucio, se reporta y `--aplicar`
 * se niega — no hay corrida parcial automática.
 */

import { z } from 'zod';
import { conUsuario, verificarCredencialDeRequest } from '@sistema-contable/data';
import {
  configDelEntorno,
  crearObjectStorage,
  obtenerObjetoDeCliente,
  type ObjectStorage,
} from '@sistema-contable/almacenamiento';
import {
  adaptadorGalicia,
  adaptadorMacro,
  adaptadorSantander,
  aFilas,
  extraerTexto,
  recapturarConceptosDeLote,
  registrarAdaptador,
  resolverAdaptador,
  ROLES_QUE_RECAPTURAN,
  type MotivoAbortoRecaptura,
  type ResultadoRecaptura,
} from '@sistema-contable/ingesta';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

// Mismo criterio que `completar-lote.ts`/`ingestar.ts`: registro duplicado a propósito, en el borde de
// la aplicación — importar `ingestar.ts` por sus side-effects sería el acoplamiento que ese comentario
// existe para evitar.
registrarAdaptador(adaptadorGalicia);
registrarAdaptador(adaptadorMacro);
registrarAdaptador(adaptadorSantander);

cargarEnv();

type CamposRecaptura =
  | 'cliente_id'
  | 'usuario_id'
  | 'lote_id'
  | 'banco_codigo'
  | 'total_persistido'
  | 'total_releido'
  | 'hash_no_reproduce'
  | 'prefijo_inv14_falla'
  | 'depuracion_divergente'
  | 'fila_numero_diverge'
  | 'identificador_encontrado'
  | 'filas_actualizadas'
  | 'adaptador_version'
  | 'motivo_codigo'
  | 'causa_tipo';
const log = loggerAcotado<CamposRecaptura>();

/** Nunca `error.message` crudo: un parser de PDF o el SDK de storage pueden interpolar contenido que
 *  estaban procesando — este script tiene el PDF entero y sus glosas en memoria. Solo el nombre del
 *  constructor (mismo patrón que `exportar-excel.ts`/`comparar-titularidad.ts`). */
function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANDERAS = new Set(['aplicar']);

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
  usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
  loteId: z.string().regex(RE_UUID, 'el --lote-id tiene que ser un uuid'),
  aplicar: z.boolean(),
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

  const crudo = {
    cliente: mapa.get('cliente') ?? '',
    usuario: mapa.get('usuario') ?? '',
    loteId: mapa.get('lote-id') ?? '',
    aplicar: banderas.has('aplicar'),
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).\n\n` +
        '  pnpm recapturar:conceptos --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--aplicar]\n\n' +
        '  Sin --aplicar: dry-run, nunca escribe. Con --aplicar: escribe SOLO si las compuertas dan\n' +
        '  limpias — si el dry-run encontró algo sucio, --aplicar se niega igual (sin flag de waiver).',
    );
  }
  return r.data;
}

export const MOTIVOS_ABORTO_CLI = [
  'credencial_saltea_rls',
  'contexto_no_aislado',
  'archivo_no_almacenado',
  'clave_de_otro_cliente',
  'motivo_faltante',
  'rol_insuficiente',
  'objeto_no_encontrado',
  'integridad_no_coincide',
  'requiere_ocr',
  'archivo_ilegible',
  'adapter_no_disponible',
  'banco_ambiguo',
  'banco_declarado_no_coincide',
] as const;

export type ResultadoRecapturarConceptos =
  | ResultadoRecaptura
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoRecaptura | (typeof MOTIVOS_ABORTO_CLI)[number] };

/** Motivo de vocabulario cerrado que exige el choke point de lectura — no texto libre del operador. */
const MOTIVO_DESCARGA = 'recapturar_conceptos: lectura previa al backfill de concepto_banco/pagina_pdf';

/** Corre la recaptura. Separado del CLI para que el test lo ejercite sin `process.exit`, mismo patrón
 *  que `ingestar()`/`completarLote()`/`exportarExcel()`. `storage` es inyectable — mismo patrón que
 *  `completarLote(args, storage)` — para que el test pueda correr sin MinIO real si hace falta. */
export async function recapturarConceptos(
  args: Argumentos,
  storage: ObjectStorage,
): Promise<ResultadoRecapturarConceptos> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('recapturar_conceptos.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  // Lectura N1 pura: `lote_ingesta` no tiene ninguna columna ≥ N2, así que esto es seguro sin auditar
  // (mismo criterio que `exportar-planilla.ts`).
  const ancla = await conUsuario(args.usuario, async (tx) => {
    const filas = await tx.consultar<{
      banco_codigo: string;
      archivo_clave: string | null;
      archivo_hash: string;
      estado: string;
    }>(
      `select banco_codigo, archivo_clave, archivo_hash, estado
         from lote_ingesta where id = $1 and cliente_id = $2`,
      [args.loteId, args.cliente],
    );
    return filas[0];
  });

  if (!ancla) {
    return { estado: 'abortado', motivoCodigo: 'lote_no_encontrado' };
  }
  if (ancla.estado !== 'procesado' && ancla.estado !== 'procesado_con_observaciones') {
    return { estado: 'abortado', motivoCodigo: 'lote_no_recapturable' };
  }
  if (ancla.archivo_clave === null) {
    return { estado: 'abortado', motivoCodigo: 'archivo_no_almacenado' };
  }

  const lectura = await obtenerObjetoDeCliente(args.usuario, storage, {
    clienteId: args.cliente,
    clave: ancla.archivo_clave,
    hashEsperado: ancla.archivo_hash,
    motivo: MOTIVO_DESCARGA,
    recursoId: args.loteId,
    rolesPermitidos: ROLES_QUE_RECAPTURAN,
  });
  if (!lectura.obtenido) {
    log.warn('recapturar_conceptos.abortado', { cliente_id: args.cliente, lote_id: args.loteId, motivo_codigo: lectura.motivoCodigo });
    return { estado: 'abortado', motivoCodigo: lectura.motivoCodigo };
  }

  let leido;
  try {
    const texto = await extraerTexto(lectura.contenido);
    if (texto.requiereOcr) {
      return { estado: 'abortado', motivoCodigo: 'requiere_ocr' };
    }
    const filas = await aFilas(lectura.contenido);
    const cual = resolverAdaptador({ filas }, ancla.banco_codigo);
    if (cual.estado !== 'encontrado') {
      const motivo =
        cual.estado === 'sin_adaptador'
          ? ('adapter_no_disponible' as const)
          : cual.estado === 'ambiguo'
            ? ('banco_ambiguo' as const)
            : ('banco_declarado_no_coincide' as const);
      return { estado: 'abortado', motivoCodigo: motivo };
    }
    leido = { salida: cual.adaptador.leer({ filas }), version: cual.adaptador.version };
  } catch (error) {
    log.error('recapturar_conceptos.abortado', { cliente_id: args.cliente, lote_id: args.loteId, causa_tipo: causaTipo(error) });
    return { estado: 'abortado', motivoCodigo: 'archivo_ilegible' };
  }

  const resultado = await conUsuario(args.usuario, (tx) =>
    recapturarConceptosDeLote(
      tx,
      {
        clienteId: args.cliente,
        loteId: args.loteId,
        archivoHashEsperado: ancla.archivo_hash,
        bancoCodigo: ancla.banco_codigo,
        adaptadorVersion: leido.version,
        aplicar: args.aplicar,
      },
      leido.salida,
    ),
  );

  if (resultado.estado === 'aplicado') {
    log.info('recapturar_conceptos.aplicado', {
      cliente_id: args.cliente,
      lote_id: args.loteId,
      banco_codigo: ancla.banco_codigo,
      filas_actualizadas: resultado.filasActualizadas,
      adaptador_version: resultado.adaptadorVersion,
    });
  } else if (resultado.estado === 'listo' || resultado.estado === 'sucio') {
    log.info('recapturar_conceptos.compuertas', {
      cliente_id: args.cliente,
      lote_id: args.loteId,
      total_persistido: resultado.compuertas.totalPersistido,
      total_releido: resultado.compuertas.totalReleido,
      hash_no_reproduce: resultado.compuertas.hashNoReproduce,
      prefijo_inv14_falla: resultado.compuertas.prefijoInv14Falla,
      depuracion_divergente: resultado.compuertas.depuracionDivergente,
      fila_numero_diverge: resultado.compuertas.filaNumeroDiverge,
      identificador_encontrado: resultado.compuertas.identificadorEncontrado,
    });
  }

  return resultado;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/recapturar-conceptos.ts');

if (esEjecucionDirecta) {
  const salto = String.fromCharCode(10);
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await recapturarConceptos(args, crearObjectStorage(configDelEntorno()));
    process.stdout.write(`${JSON.stringify(r)}${salto}`);
    process.exit(r.estado === 'aplicado' || r.estado === 'listo' || r.estado === 'ya_backfilleado' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${salto}`);
    process.exit(2);
  }
}
