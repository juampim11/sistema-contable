/**
 * CLI DE REMEDIACIÓN — completa un lote `con_errores` al que le faltó UNA cuenta, sin rehacer lo que ya
 * era correcto.
 *
 *     pnpm completar-lote --cliente <uuid> --archivo <ruta> --banco <codigo> --usuario <uuid>
 *
 * ## El bug que esto remedia, y por qué no alcanza con volver a correr `pnpm ingesta`
 *
 * Antes del `SAVEPOINT` de HANDOFF 2026-08-11 (40)/(41), un archivo multi-cuenta donde una cuenta se
 * persistía con éxito y una posterior fallaba (`cuenta_no_registrada`, típicamente) dejaba el lote
 * entero `con_errores`, **con la primera cuenta ya comiteada de verdad**. El fix de (40) corrige la
 * causa raíz hacia adelante — el próximo archivo que entre revierte todo si algo falla —, pero no toca
 * los lotes que **ya** quedaron en ese estado. Y `pnpm ingesta` no sirve para completarlos: el
 * `archivo_hash` ya existe, así que devuelve `ya_procesado` sobre el `loteId` de siempre sin escribir
 * nada (ver HANDOFF (42), la pregunta que motivó este script).
 *
 * ## El límite de diseño, declarado a propósito (HANDOFF 2026-08-11 (42))
 *
 * Esta función completa **una cuenta por corrida**. Resuelve TODAS las cuentas del documento —lectura
 * pura, sin riesgo— y cuenta cuántas todavía no tienen fila en `lote_ingesta_cuenta` para este lote:
 *
 *   - **0 pendientes:** no-op limpio, `ya_completado`.
 *   - **exactamente 1:** se verifica y persiste esa sola cuenta. Sin `SAVEPOINT`: hasta ese punto la
 *     transacción es puramente de lectura (`resolverCuentaDelExtracto` no escribe), así que un fallo acá
 *     no tiene nada que revertir — `persistirCuenta` no inserta una sola fila si su propia verificación
 *     dice que no persiste.
 *   - **2 o más:** aborta explícito, nunca intenta una segunda cuenta en la misma corrida.
 *
 * Con este límite, el escenario que le preocupaba a `dba-data` en la convocatoria —dos cuentas en la
 * misma corrida, la primera persiste, la segunda falla— no puede ocurrir por construcción, y no hace
 * falta reimplementar el `SAVEPOINT` de `ingestar.ts` en un segundo archivo (la lección de (40): la
 * garantía depende de un solo lugar).
 *
 * 🟡 **No cubre lotes rechazados en la etapa de LOTE** (`consolidado_no_cuadra`, `cuentas_no_coinciden`,
 * `destinos_no_cuadran`, `banco_ambiguo`, `banco_declarado_no_coincide`, `adapter_no_disponible`): esos
 * fallan antes de que exista una sola fila en `lote_ingesta_cuenta`, así que **todas** las cuentas del
 * archivo aparecen como "pendientes" acá, y con dos o más cuentas el aborto de arriba los deja intactos
 * — correcto, porque esta función no sabe reparar ese tipo de problema. Con un archivo de una sola
 * cuenta que fallara por esa vía, en cambio, se vería como "1 pendiente" y esta función lo intentaría
 * completar igual: caso no medido, no cubierto por el criterio de aceptación de HANDOFF (42). Declarado
 * acá, no resuelto.
 *
 * NUNCA se corre a mano el usuario final sin que este script termine: es la contadora la que decide
 * cuándo, mismo criterio de "asistido, no automático" de CLAUDE.md §1.7.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import {
  conUsuario,
  registrarAcceso,
  verificarCredencialDeRequest,
} from '@sistema-contable/data';
import {
  configDelEntorno,
  crearObjectStorage,
  guardarExtractoTrasResolver,
  type ObjectStorage,
} from '@sistema-contable/almacenamiento';
import {
  adaptadorGalicia,
  adaptadorMacro,
  adaptadorSantander,
  aFilas,
  extraerTexto,
  type CuentaConMovimientos,
  persistirCuenta,
  registrarAdaptador,
  resolverAdaptador,
  resolverCuentaDelExtracto,
  verificarAritmetica,
  type EstadoLotePersistido,
} from '@sistema-contable/ingesta';

import { forma, logger } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

// Mismo criterio que `ingestar.ts`: el registro es del borde de la aplicación, no un side-effect de
// import de `packages/ingesta`. Se repite acá — importar `ingestar.ts` por sus side-effects sería
// exactamente el acoplamiento que ese comentario, en ese archivo, existe para evitar.
registrarAdaptador(adaptadorGalicia);
registrarAdaptador(adaptadorMacro);
registrarAdaptador(adaptadorSantander);

cargarEnv();

/**
 * `RE_UUID`, `esquemaArgumentos` y `EXTENSIONES_ACEPTADAS` repiten literalmente los de `ingestar.ts`
 * (`code-reviewer` lo señaló al revisar este archivo). A diferencia del registro de adaptadores —que el
 * comentario de más arriba justifica no compartir por sus side-effects de import— esto es puro y sin
 * efecto de borde, así que extraerlo sería seguro. No se hace en esta tarea: HANDOFF 2026-08-11 (42)
 * declaró explícitamente "no cambia: ingestar.ts", y cualquier edición a ese archivo —aunque sea mover
 * una constante— dispara de nuevo CLAUDE.md §3.2(c) (modifica un adaptador/motor que ya corre contra
 * datos de clientes reales). Diez líneas duplicadas y puras es más barato que reabrir esa puerta para
 * este cambio puntual.
 */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
  archivo: z.string().min(1),
  banco: z.string().regex(/^[a-z0-9_]{2,32}$/),
  usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
});

export type Argumentos = z.infer<typeof esquemaArgumentos>;

const EXTENSIONES_ACEPTADAS = new Set(['.pdf', '.xlsx', '.xls', '.csv']);

/**
 * Vocabulario cerrado de los abortos propios de este script. Los que empiezan igual que los de
 * `ingestar.ts` (`archivo_ilegible`, `requiere_ocr`, ...) son el mismo código para el mismo hecho: releer
 * el archivo puede fallar de las mismas formas que leerlo la primera vez.
 */
export const MOTIVOS_ABORTO = [
  'credencial_saltea_rls',
  'contexto_no_aislado',
  'extension_no_soportada',
  'lote_no_encontrado',
  'lote_no_remediable',
  'banco_no_coincide',
  'archivo_ilegible',
  'requiere_ocr',
  'adapter_no_disponible',
  'banco_ambiguo',
  'banco_declarado_no_coincide',
  'sin_movimientos',
  'multiples_cuentas_pendientes',
] as const;

export type ResultadoCompletarLote =
  | {
      readonly estado: 'completado';
      readonly loteId: string;
      readonly estadoLote: EstadoLotePersistido;
      readonly filas: number;
    }
  | { readonly estado: 'ya_completado'; readonly loteId: string }
  | { readonly estado: 'rechazado'; readonly loteId: string; readonly motivoCodigo: string }
  | { readonly estado: 'abortado'; readonly motivoCodigo: string; readonly pendientes?: number };

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

  const crudo = {
    cliente: mapa.get('cliente') ?? '',
    archivo: mapa.get('archivo') ?? '',
    banco: mapa.get('banco') ?? '',
    usuario: mapa.get('usuario') ?? '',
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).\n\n` +
        '  pnpm completar-lote --cliente <uuid> --archivo <ruta> --banco <codigo> --usuario <uuid>\n\n' +
        'El archivo tiene que ser EXACTAMENTE el mismo que se usó en la ingesta original: la búsqueda del\n' +
        'lote es por (cliente, hash del archivo). Un archivo distinto —aunque sea del mismo banco y\n' +
        'cliente— no encuentra el lote y aborta con lote_no_encontrado.',
    );
  }
  return r.data;
}

function contentTypeDe(extension: string): string {
  switch (extension) {
    case '.pdf':
      return 'application/pdf';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls':
      return 'application/vnd.ms-excel';
    default:
      return 'text/csv';
  }
}

type Pendiente =
  | { readonly cuentaLeida: CuentaConMovimientos; readonly resuelta: true; readonly cuentaBancariaId: string }
  | { readonly cuentaLeida: CuentaConMovimientos; readonly resuelta: false; readonly motivoCodigo: string };

/**
 * Corre la remediación. Separado del CLI para que el test lo ejercite sin `process.exit`, mismo patrón
 * que `ingestar()`.
 */
export async function completarLote(
  args: Argumentos,
  storage: ObjectStorage,
): Promise<ResultadoCompletarLote> {
  // PASO 1 — el mismo guard R18 que `ingestar.ts`, antes de abrir el archivo.
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    logger.error('completar_lote.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const extension = extname(args.archivo).toLowerCase();
  if (!EXTENSIONES_ACEPTADAS.has(extension)) {
    return { estado: 'abortado', motivoCodigo: 'extension_no_soportada' };
  }

  const contenido = readFileSync(args.archivo);
  const archivoHash = createHash('sha256').update(contenido).digest('hex');

  logger.info('completar_lote.iniciado', {
    cliente_id: args.cliente,
    banco_codigo: args.banco,
    archivo_bytes: contenido.byteLength,
  });

  return conUsuario(args.usuario, async (tx) => {
    // El lote tiene que EXISTIR ya. Nunca se crea uno nuevo ni se cae a "el más reciente con_errores de
    // este cliente" — sería adivinar cuál lote completar (`security-engineer`, HANDOFF (42)).
    const filaLote = await tx.consultar<{
      id: string;
      estado: string;
      motivo_codigo: string | null;
      banco_codigo: string;
      archivo_clave: string | null;
    }>(
      `select id::text as id, estado, motivo_codigo, banco_codigo, archivo_clave
         from lote_ingesta
        where cliente_id = $1 and archivo_hash = $2`,
      [args.cliente, archivoHash],
    );
    const loteActual = filaLote[0];
    if (!loteActual) {
      logger.warn('completar_lote.abortado', { motivo_codigo: 'lote_no_encontrado' });
      return { estado: 'abortado' as const, motivoCodigo: 'lote_no_encontrado' };
    }
    const loteId = loteActual.id;

    if (loteActual.estado === 'procesado' || loteActual.estado === 'procesado_con_observaciones') {
      logger.info('completar_lote.ya_completado', { cliente_id: args.cliente, lote_id: loteId });
      return { estado: 'ya_completado' as const, loteId };
    }
    if (loteActual.estado !== 'con_errores') {
      logger.warn('completar_lote.abortado', { lote_id: loteId, motivo_codigo: 'lote_no_remediable' });
      return { estado: 'abortado' as const, motivoCodigo: 'lote_no_remediable' };
    }

    if (loteActual.banco_codigo !== args.banco) {
      logger.warn('completar_lote.abortado', { lote_id: loteId, motivo_codigo: 'banco_no_coincide' });
      return { estado: 'abortado' as const, motivoCodigo: 'banco_no_coincide' };
    }

    let texto;
    let filas;
    try {
      texto = await extraerTexto(contenido);
      filas = await aFilas(contenido);
    } catch {
      return { estado: 'abortado' as const, motivoCodigo: 'archivo_ilegible' };
    }
    if (texto.requiereOcr) {
      return { estado: 'abortado' as const, motivoCodigo: 'requiere_ocr' };
    }

    const cual = resolverAdaptador({ filas }, args.banco);
    if (cual.estado !== 'encontrado') {
      const motivo =
        cual.estado === 'sin_adaptador'
          ? 'adapter_no_disponible'
          : cual.estado === 'ambiguo'
            ? 'banco_ambiguo'
            : 'banco_declarado_no_coincide';
      return { estado: 'abortado' as const, motivoCodigo: motivo };
    }

    const leido = cual.adaptador.leer({ filas });
    if (leido.cuentas.length === 0) {
      return { estado: 'abortado' as const, motivoCodigo: 'sin_movimientos' };
    }

    const movimientosEnElLote = leido.cuentas.reduce((n, c) => n + c.movimientos.length, 0);

    // Qué cuentas del documento ya tienen su fila en `lote_ingesta_cuenta` para ESTE lote.
    const existentes = await tx.consultar<{ cuenta_bancaria_id: string }>(
      `select cuenta_bancaria_id::text as cuenta_bancaria_id
         from lote_ingesta_cuenta
        where lote_ingesta_id = $1 and cliente_id = $2`,
      [loteId, args.cliente],
    );
    const yaPersistidas = new Set(existentes.map((r) => r.cuenta_bancaria_id));

    /**
     * Atajo, encontrado por `code-reviewer`: si ya hay tantas filas en `lote_ingesta_cuenta` como cuentas
     * trae el documento, no puede faltar ninguna — por `uq_lote_cuenta_natural` (migración 0004) cada
     * fila es una cuenta distinta, así que el conteo alcanza para saber que está completo. Sin este
     * atajo, una cuenta YA persistida que dejara de re-resolver hoy (su `cuenta_bancaria_identificador`
     * cambió de vigencia después de la ingesta original, por ejemplo) se contaría como "pendiente" igual
     * que una genuinamente faltante — nunca corrompe nada (no hay `insert` posible sobre una cuenta que
     * ya está), pero podía devolver `rechazado`/`multiples_cuentas_pendientes` sobre un lote que en
     * realidad ya estaba completo.
     */
    if (existentes.length >= leido.cuentas.length) {
      logger.info('completar_lote.ya_completado', { cliente_id: args.cliente, lote_id: loteId });
      return { estado: 'ya_completado' as const, loteId };
    }

    const pendientes: Pendiente[] = [];
    for (const cuentaLeida of leido.cuentas) {
      const { periodoDesde, periodoHasta } = cuentaLeida.cuenta;
      if (periodoDesde === undefined || periodoHasta === undefined) {
        pendientes.push({ cuentaLeida, resuelta: false, motivoCodigo: 'cuenta_sin_periodo' });
        continue;
      }
      const resolucion = await resolverCuentaDelExtracto(tx, {
        clienteId: args.cliente,
        numeroDeclarado: cuentaLeida.cuenta.numero,
        alFecha: periodoHasta,
      });
      if (resolucion.estado !== 'resuelta') {
        pendientes.push({ cuentaLeida, resuelta: false, motivoCodigo: resolucion.estado });
        continue;
      }
      if (!yaPersistidas.has(resolucion.cuentaBancariaId)) {
        pendientes.push({ cuentaLeida, resuelta: true, cuentaBancariaId: resolucion.cuentaBancariaId });
      }
    }

    if (pendientes.length === 0) {
      logger.info('completar_lote.ya_completado', { cliente_id: args.cliente, lote_id: loteId });
      return { estado: 'ya_completado' as const, loteId };
    }
    if (pendientes.length >= 2) {
      logger.warn('completar_lote.abortado', {
        lote_id: loteId,
        motivo_codigo: 'multiples_cuentas_pendientes',
        pendientes: pendientes.length,
      });
      return {
        estado: 'abortado' as const,
        motivoCodigo: 'multiples_cuentas_pendientes',
        pendientes: pendientes.length,
      };
    }

    const unica = pendientes[0];
    if (!unica) throw new Error('pendientes.length === 1 pero el elemento no está: inalcanzable.');

    if (!unica.resuelta) {
      logger.warn('completar_lote.rechazado', { lote_id: loteId, motivo_codigo: unica.motivoCodigo });
      return { estado: 'rechazado' as const, loteId, motivoCodigo: unica.motivoCodigo };
    }

    const verificacion = verificarAritmetica(unica.cuentaLeida, {
      capacidades: cual.adaptador.capacidades as never,
      movimientosEnElLote,
    });

    /**
     * Fallo de verificación después de una resolución exitosa se trata IGUAL que fallo de resolución:
     * aborto limpio (`seguridad-datos-financieros`, HANDOFF (42)). No hay nada que revertir — hasta acá
     * la transacción solo leyó, y si `persistirCuenta` decide no persistir, no inserta una sola fila.
     */
    const persistido = await persistirCuenta(tx, {
      clienteId: args.cliente,
      loteId,
      cuentaBancariaId: unica.cuentaBancariaId,
      cuenta: unica.cuentaLeida,
      verificacion,
      movimientosEnElLote,
    });
    if (!persistido.persistido) {
      return { estado: 'rechazado' as const, loteId, motivoCodigo: persistido.motivoCodigo };
    }

    // La cuenta entró. Recalcular los contadores del LOTE sobre lo que hay en la base, nunca acumulando
    // a mano — es lo que el criterio de aceptación pide explícitamente (HANDOFF (42), punto 2).
    const filasPorCuenta = await tx.consultar<{ verificacion_estado: string; filas_aceptadas: number }>(
      `select verificacion_estado, filas_aceptadas::int as filas_aceptadas
         from lote_ingesta_cuenta
        where lote_ingesta_id = $1 and cliente_id = $2`,
      [loteId, args.cliente],
    );
    const filasAceptadas = filasPorCuenta.reduce((n, f) => n + f.filas_aceptadas, 0);
    const estadoFinal: EstadoLotePersistido = filasPorCuenta.some((f) => f.verificacion_estado !== 'cuadra')
      ? 'procesado_con_observaciones'
      : 'procesado';

    /**
     * El objeto nunca se guardó: la ingesta original rechazó ANTES del paso 11 de `ingestar.ts` (el
     * guardado es lo último que hace, y acá nunca se llegó). `archivo_clave` queda NULL en todo lote
     * `con_errores` originado en la etapa de cuenta — se completa acá, con el mismo orden inviolable
     * (resolver antes de guardar) que documenta `extracto.ts`.
     */
    let archivoClave = loteActual.archivo_clave;
    let paginasDeclaradas: number | null = null;
    let paginasSinTexto: number | null = null;
    if (archivoClave === null) {
      const resultadoGuardado = await guardarExtractoTrasResolver(
        storage,
        {
          clienteId: args.cliente,
          loteId,
          categoria: 'extracto',
          extension: extension.slice(1) as 'pdf' | 'xlsx' | 'xls' | 'csv',
          contentType: contentTypeDe(extension),
          contenido,
        },
        async () => ({
          estado: 'resuelta' as const,
          clienteId: args.cliente,
          cuentaBancariaId: loteId,
        }),
      );
      if (!resultadoGuardado.guardado) {
        throw new Error(`No se pudo guardar el objeto del lote: ${resultadoGuardado.motivoCodigo}`);
      }
      archivoClave = resultadoGuardado.clave;
      paginasDeclaradas = leido.paginasDeclaradas ?? null;
      paginasSinTexto = texto.paginasSinTexto.length;
    }

    const motivoCodigoPrevio = loteActual.motivo_codigo;
    const adaptadorVersion = `${cual.adaptador.bancoCodigo}@${cual.adaptador.version}`;

    await tx.consultar(
      `update lote_ingesta
          set estado = $2, motivo_codigo = null, motivo_codigo_previo = $3,
              filas_leidas = $4, filas_aceptadas = $4, adaptador_version = $5,
              archivo_clave = coalesce($6, archivo_clave),
              paginas_declaradas = coalesce($7, paginas_declaradas),
              paginas_sin_texto = coalesce($8, paginas_sin_texto)
        where id = $1 and cliente_id = $9`,
      [
        loteId,
        estadoFinal,
        motivoCodigoPrevio,
        filasAceptadas,
        adaptadorVersion,
        archivoClave,
        paginasDeclaradas,
        paginasSinTexto,
        args.cliente,
      ],
    );

    // El rastro completo (quién, cuándo, con qué credencial) queda en `acceso_auditoria`, atado al lote
    // por `recurso_id` — el puente que pidió `seguridad-datos-financieros`, sin columna nueva para eso.
    await registrarAcceso(tx, {
      clienteId: args.cliente,
      accion: 'escritura',
      recurso: 'lote_ingesta',
      recursoId: loteId,
      // Solo códigos cerrados + el propio motivo previo (también un código cerrado): nunca texto libre
      // del operador ni un dato leído del archivo.
      motivo: `completar_lote:${motivoCodigoPrevio ?? 'desconocido'}`,
    });

    logger.info('completar_lote.completado', {
      cliente_id: args.cliente,
      lote_id: loteId,
      estado: estadoFinal,
      filas: filasAceptadas,
      motivo_codigo_previo: motivoCodigoPrevio,
    });

    // El saldo releído se muestra en su FORMA, nunca por el logger aunque fuera enmascarado (R26/R27 de
    // ADR-0002 no hacen excepción por enmascarado): es la única confirmación visual de que la cuenta que
    // se completó es la que corresponde, sin publicar el valor.
    const saldoFinal = unica.cuentaLeida.cuenta.saldoFinalDeclarado;
    process.stdout.write(
      `Cuenta completada (forma, no valor) — saldo final declarado: ${saldoFinal === undefined ? '(no publicado)' : forma(saldoFinal)}${String.fromCharCode(10)}`,
    );

    return { estado: 'completado' as const, loteId, estadoLote: estadoFinal, filas: filasAceptadas };
  });
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]
  ?.replace(/\\/g, '/')
  .endsWith('apps/cli/src/completar-lote.ts');

if (esEjecucionDirecta) {
  const salto = String.fromCharCode(10);
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await completarLote(args, crearObjectStorage(configDelEntorno()));

    process.stdout.write(`${JSON.stringify(r)}${salto}`);
    process.exit(r.estado === 'completado' || r.estado === 'ya_completado' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(redactar(error))}${salto}`);
    process.exit(2);
  }
}
