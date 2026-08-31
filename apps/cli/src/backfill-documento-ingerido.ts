/**
 * BACKFILL DE `documento_ingerido` — 3 lotes reales YA INGERIDOS en Capa 1 (Bancor, Nación, ICBC),
 * Sesión 2a de `docs/diseno/27-roadmap-capa-d.md`. Migración `0027_cierre_mensual.sql`.
 *
 *     node apps/cli/src/backfill-documento-ingerido.ts --cliente <uuid> --usuario <uuid> --lote-id <uuid>              (dry-run)
 *     node apps/cli/src/backfill-documento-ingerido.ts --cliente <uuid> --usuario <uuid> --lote-id <uuid> --confirmar
 *
 * Sin `--confirmar`: solo reporte, no escribe nada. Con `--confirmar`: inserta si hay algo pendiente.
 *
 * ## Alcance: solo 3 lotes reales, mono-cuenta, de 3 bancos puntuales
 *
 * Galicia/Macro/Santander (multi-cuenta) quedan fuera a propósito — backfill aparte si hace falta
 * (`docs/diseno/27-roadmap-capa-d.md`, Sesión 2a). Este script ABORTA si el lote no es mono-cuenta o
 * si su banco no está en `COBERTURA_POR_BANCO` — nunca asume un valor para un caso no medido.
 *
 * ## `cobertura` — por qué está fijada a mano acá, y no leída de una consulta
 *
 * `documento_ingerido.cobertura` no tiene fuente en Capa 1: el campo `coberturaPeriodo` que el
 * contrato del extractor puede declarar (`packages/ingesta/src/esquema.ts`) nunca se persiste en
 * ninguna tabla (`persistir.ts` no lo escribe). Convocatoria real a `dba-data` (2026-08-30, backfill
 * de Sesión 2a) resolvió el valor de cada banco con evidencia distinta — ver `COBERTURA_POR_BANCO`
 * abajo, con la evidencia de cada uno en su propio comentario. Nunca se agrega un banco a ese mapa
 * sin la misma convocatoria.
 *
 * ## TOCTOU del `--cliente`
 *
 * La lectura de `lote_ingesta` filtra por `id` **y** `cliente_id` a la vez (nunca solo por `id`,
 * comparando después) — condición de `seguridad-datos-financieros`: con 3 corridas casi idénticas
 * (Bancor/Nación/ICBC), un `--cliente` trabucado en una de las tres no encuentra el lote y aborta,
 * en vez de insertar en el tenant equivocado.
 *
 * ## Qué nunca se imprime
 *
 * `objeto_almacenamiento` (N1, no exportable, `clasificacion-campos.ts`) — ni completo, ni truncado.
 * El ancla de diagnóstico es siempre `lote_id` o `documento_ingerido.id`.
 */

import { z } from 'zod';
import {
  backfillDocumentoIngerido,
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  verificarCredencialDeRequest,
  type CoberturaDocumento,
  type FilaBackfillDocumentoIngerido,
} from '@sistema-contable/data';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esquemaArgs = z.object({
  cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
  usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
  loteId: z.string().regex(RE_UUID, 'el --lote-id tiene que ser un uuid'),
  confirmar: z.boolean(),
});
export type ArgumentosBackfillDocumentoIngerido = z.infer<typeof esquemaArgs>;

export function argumentos(argv: readonly string[]): ArgumentosBackfillDocumentoIngerido {
  const mapa = new Map<string, string>();
  let confirmar = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirmar') {
      confirmar = true;
      continue;
    }
    if (a?.startsWith('--')) {
      const clave = a.slice(2);
      const valor = argv[i + 1];
      if (valor !== undefined) mapa.set(clave, valor);
      i++;
    }
  }
  const parsed = esquemaArgs.safeParse({
    cliente: mapa.get('cliente'),
    usuario: mapa.get('usuario'),
    loteId: mapa.get('lote-id'),
    confirmar,
  });
  if (!parsed.success) {
    throw new Error(
      `argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. ` +
        'Uso: --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--confirmar]',
    );
  }
  return parsed.data;
}

/**
 * Vocabulario cerrado de bancos soportados por ESTE backfill, con la evidencia de `cobertura` de
 * cada uno — confirmado por `dba-data`, convocatoria de Sesión 2a (2026-08-30). Nunca se lee de una
 * consulta: el campo no está persistido en Capa 1 (ver cabecera del archivo).
 */
export const COBERTURA_POR_BANCO: Readonly<Record<string, { readonly cobertura: CoberturaDocumento; readonly evidencia: string }>> = {
  // ICBC y Nación: el adaptador declara `coberturaPeriodo: 'completo'` en su propio código de
  // extracción (`packages/ingesta/src/adaptadores/icbc.ts:530`,
  // `packages/ingesta/src/adaptadores/nacion.ts:545`) — nunca se persistió en Capa 1, pero está
  // declarado en la fuente. Corroborado contra el piloto: `lote_ingesta_cuenta.verificacion_estado
  // = 'cuadra'` medido para el lote real de cada uno.
  icbc: { cobertura: 'completo', evidencia: 'declarado_en_adaptador (icbc.ts:530), corroborado por verificacion_estado=cuadra' },
  nacion: { cobertura: 'completo', evidencia: 'declarado_en_adaptador (nacion.ts:545), corroborado por verificacion_estado=cuadra' },
  // Bancor: el adaptador NUNCA declara `coberturaPeriodo` — no hay fuente de código, a diferencia de
  // ICBC/Nación. Fijado a mano, MEDIDO y NO DECLARADO: el período real leído de
  // `lote_ingesta_cuenta` para el lote de Contenedores Paoluc S.A.S. es un mes calendario exacto
  // (2026-06-01 a 2026-06-30, sin recorte) y `verificacion_estado = 'cuadra'` — la cadena de saldos
  // cierra (saldo_inicial_declarado + movimientos = saldo_final_declarado, ambos publicados por el
  // banco). Es la misma observación que ya deja escrita `packages/ingesta/src/esquema.ts` sobre los
  // bancos medidos antes de Nación, pero verificada acá con el dato real de ESTE lote — no asumida
  // por parecido. Si algún día aparece un lote de Bancor que NO sea un mes calendario completo o que
  // no cuadre, este valor fijo deja de ser válido para ese lote — no se reusa sin remedir.
  bancor: { cobertura: 'completo', evidencia: 'medido_no_declarado: mes calendario exacto + verificacion_estado=cuadra, lote real 2026-06' },
};

export const MOTIVOS_ABORTO_CLI = [
  'credencial_saltea_rls',
  'contexto_no_aislado',
  'lote_no_encontrado_o_cliente_no_coincide',
  'lote_no_backfilleable',
  'archivo_clave_nulo',
  'lote_no_mono_cuenta',
  'banco_no_soportado_por_este_backfill',
] as const;
export type MotivoAbortoCli = (typeof MOTIVOS_ABORTO_CLI)[number];

export type ResultadoCli =
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoCli }
  | { readonly estado: 'dry_run'; readonly fila: Omit<FilaBackfillDocumentoIngerido, 'objetoAlmacenamiento'>; readonly loteId: string }
  | { readonly estado: 'ya_backfilleado'; readonly documentoIngeridoId: string; readonly loteId: string }
  | { readonly estado: 'aplicado'; readonly documentoIngeridoId: string; readonly loteId: string };

function esEstadoBackfilleable(estado: string): boolean {
  return estado === 'procesado' || estado === 'procesado_con_observaciones';
}

export async function backfillDocumentoIngeridoDeLote(args: ArgumentosBackfillDocumentoIngerido): Promise<ResultadoCli> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  return conUsuario(args.usuario, async (tx) => {
    // TOCTOU: `id` y `cliente_id` en la MISMA condición — un --cliente que no corresponde a este
    // lote no encuentra fila, nunca "encuentra y compara después".
    const anclaFilas = await tx.consultar<{
      banco_codigo: string;
      archivo_clave: string | null;
      ingerido_en: string;
      estado: string;
    }>(
      `select banco_codigo, archivo_clave, created_at::text as ingerido_en, estado
         from lote_ingesta
        where id = $1 and cliente_id = $2`,
      [args.loteId, args.cliente],
    );
    const ancla = anclaFilas[0];
    if (!ancla) {
      return { estado: 'abortado', motivoCodigo: 'lote_no_encontrado_o_cliente_no_coincide' };
    }
    if (!esEstadoBackfilleable(ancla.estado)) {
      return { estado: 'abortado', motivoCodigo: 'lote_no_backfilleable' };
    }
    if (!ancla.archivo_clave) {
      return { estado: 'abortado', motivoCodigo: 'archivo_clave_nulo' };
    }

    const cuentasFilas = await tx.consultar<{ periodo_desde: string; periodo_hasta: string }>(
      `select periodo_desde::text as periodo_desde, periodo_hasta::text as periodo_hasta
         from lote_ingesta_cuenta
        where lote_ingesta_id = $1 and cliente_id = $2`,
      [args.loteId, args.cliente],
    );
    if (cuentasFilas.length !== 1) {
      // B.7 (`docs/diseno/10-deuda-declarada.md`): el período se declara POR CUENTA. Este script
      // solo sabe resolver el caso mono-cuenta (1 fila = "por archivo" y "por cuenta" coinciden);
      // un lote multi-cuenta queda fuera de alcance a propósito, no se le inventa un promedio.
      return { estado: 'abortado', motivoCodigo: 'lote_no_mono_cuenta' };
    }
    const cuenta = cuentasFilas[0];
    if (!cuenta) {
      return { estado: 'abortado', motivoCodigo: 'lote_no_mono_cuenta' };
    }

    const coberturaResuelta = COBERTURA_POR_BANCO[ancla.banco_codigo];
    if (!coberturaResuelta) {
      return { estado: 'abortado', motivoCodigo: 'banco_no_soportado_por_este_backfill' };
    }

    const fila: FilaBackfillDocumentoIngerido = {
      clienteId: args.cliente,
      tipoDocumento: 'extracto',
      bancoCodigo: ancla.banco_codigo,
      periodoDesde: cuenta.periodo_desde,
      periodoHasta: cuenta.periodo_hasta,
      cobertura: coberturaResuelta.cobertura,
      objetoAlmacenamiento: ancla.archivo_clave,
      ingeridoEn: ancla.ingerido_en,
    };

    if (!args.confirmar) {
      const { objetoAlmacenamiento: _nuncaImpreso, ...filaSinClaveDeStorage } = fila;
      return { estado: 'dry_run', fila: filaSinClaveDeStorage, loteId: args.loteId };
    }

    const resultado = await escribirConAuditoria(
      tx,
      {
        clienteId: args.cliente,
        accion: 'escritura',
        recurso: 'documento_ingerido',
        motivo: `backfill de documento_ingerido — lote real de Capa 1, lote_id=${args.loteId}, banco=${ancla.banco_codigo} (Sesión 2a)`,
      },
      (ctx) => backfillDocumentoIngerido(tx, ctx, fila),
    );

    return { ...resultado, loteId: args.loteId };
  });
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/backfill-documento-ingerido.ts');

if (esEjecucionDirecta) {
  const args = argumentos(process.argv.slice(2));
  const r = await backfillDocumentoIngeridoDeLote(args);

  imprimir('');
  imprimir(`  lote_id: ${r.estado === 'abortado' ? args.loteId : r.loteId}`);

  if (r.estado === 'abortado') {
    imprimir(`  ABORTADO: ${r.motivoCodigo}`);
    await cerrarConexiones();
    process.exit(1);
  }
  if (r.estado === 'dry_run') {
    imprimir('  DRY-RUN (sin --confirmar): no se escribió nada. Fila a insertar:');
    imprimir(`    tipo_documento:   ${r.fila.tipoDocumento}`);
    imprimir(`    banco_codigo:     ${r.fila.bancoCodigo}`);
    imprimir(`    periodo_desde:    ${r.fila.periodoDesde}`);
    imprimir(`    periodo_hasta:    ${r.fila.periodoHasta}`);
    imprimir(`    cobertura:        ${r.fila.cobertura}`);
    imprimir(`    ingerido_en:      ${r.fila.ingeridoEn}`);
    imprimir('    objeto_almacenamiento: (no impreso — N1 no exportable, clave de storage)');
    await cerrarConexiones();
    process.exit(0);
  }
  if (r.estado === 'ya_backfilleado') {
    imprimir(`  YA_BACKFILLEADO — documento_ingerido.id = ${r.documentoIngeridoId} (sin cambios).`);
    await cerrarConexiones();
    process.exit(0);
  }
  imprimir(`  OK — documento_ingerido.id = ${r.documentoIngeridoId} insertado.`);
  await cerrarConexiones();
}
