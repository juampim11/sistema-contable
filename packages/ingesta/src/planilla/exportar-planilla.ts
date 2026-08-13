/**
 * EXPORT A EXCEL — nivel de negocio. Recibe un `Tx` ya abierto por `conUsuario()`: no abre conexión, no
 * escribe a disco. El CLI (`apps/cli/src/exportar-excel.ts`) es el único que hace las dos cosas, y las
 * hace DESPUÉS de que esta función retorna — plan `adaptive-herding-pillow`, "Controles de seguridad".
 *
 * Orden interno, y es load-bearing (mismo criterio que `leerConAuditoria`/`descarga.ts`): el lote se
 * ubica primero (tabla `lote_ingesta`, sin una sola columna ≥ N2 — ver su clasificación), el ROL se
 * verifica contra la base, y **recién ahí** se escribe la auditoría — ANTES de leer una sola fila con
 * datos N2 (`lote_ingesta_cuenta`, `movimiento_bancario_crudo`). "Primero el rastro, después el dato."
 *
 * ⚠️ Ojo con el alcance real de esa garantía (`code-reviewer` lo señaló): la auditoría y las lecturas de
 * cabecera/movimientos corren en la MISMA `tx` de `conUsuario`. Si la consulta de cabecera o de
 * movimientos falla DESPUÉS de auditar, `conUsuario` hace `rollback` de la transacción entera —**se
 * pierde también la fila de auditoría recién insertada**, no queda un rastro del intento. La garantía
 * "primero el rastro" es real y verificada por test para el camino que sí importa acá: si el COMMIT ya
 * ocurrió (la función retornó `armada`) y la escritura del `.xlsx` a disco falla después —un efecto NO
 * transaccional, fuera de esta `tx`—, ahí sí el rastro sobrevive (`apps/cli/tests/exportar-excel.test.ts`,
 * "la auditoría ya commiteó pero la escritura a disco falla"). Un savepoint propio para blindar también el
 * caso intra-transacción queda fuera de alcance de esta tarea.
 */

import { registrarAcceso, type Tx } from '@sistema-contable/data';
import { ROLES_QUE_DESCARGAN } from '@sistema-contable/almacenamiento';
import {
  armarLibro,
  serializarLibro,
  MAX_FILAS,
  MOTIVOS_LIBRO,
  type CabeceraCuenta,
  type FilaPlanilla,
} from './armar-libro.ts';

export const MOTIVOS_EXPORT = [
  'demo_contadora',
  'revision_mensual',
  'pedido_del_cliente',
  'soporte_incidente',
] as const;
export type MotivoExport = (typeof MOTIVOS_EXPORT)[number];

/**
 * `acceso_auditoria` no tiene columna `destinatario` (ADR-0002 §A.1 la exige para N2-R; agregarla es una
 * migración, fuera de alcance de esta tarea — deuda declarada). Se codifica dentro de `motivo`, los dos
 * de vocabulario cerrado: nunca texto libre en una columna N2 append-only sin remediación posible.
 */
export const DESTINATARIOS_EXPORT = ['estudio_interno', 'cliente_titular', 'organismo'] as const;
export type DestinatarioExport = (typeof DESTINATARIOS_EXPORT)[number];

/** Roles que pueden exportar. Reusa el gate de `descarga.ts`, no una lista propia — un export es
 *  estrictamente más dato que una descarga (consultable/ordenable/agregable, sin TTL), así que nunca
 *  puede ser más laxo. `administrativo`/`auditor` quedan afuera (H-8, ADR-0002). */
export const ROLES_QUE_EXPORTAN = ROLES_QUE_DESCARGAN;

const ESTADOS_LOTE_EXPORTABLE = new Set(['procesado', 'procesado_con_observaciones']);

export const MOTIVOS_ABORTO_PLANILLA = [
  'rol_insuficiente',
  'lote_no_encontrado',
  'lote_no_exportable',
  'sin_cabecera',
  ...MOTIVOS_LIBRO,
] as const;
export type MotivoAbortoPlanilla = (typeof MOTIVOS_ABORTO_PLANILLA)[number];

export type PedidoExportPlanilla = {
  readonly clienteId: string;
  readonly loteId: string;
  /** Filtro opcional: si se omite, se exportan TODAS las cuentas del lote (una hoja por cada una). */
  readonly cuentaBancariaId?: string;
  readonly motivoCodigo: MotivoExport;
  readonly destinatarioCodigo: DestinatarioExport;
  /** ISO instant. Lo inyecta el caller — este módulo nunca llama `new Date()` sin argumento. */
  readonly generadoEn: string;
};

export type ResultadoExportPlanilla =
  | {
      readonly estado: 'armada';
      readonly loteId: string;
      readonly bancoCodigo: string;
      readonly libro: Uint8Array;
      readonly filas: number;
      readonly cuentas: number;
      readonly verificacion: readonly string[];
      readonly periodoDesde: string;
      readonly periodoHasta: string;
      readonly correlacion: string;
    }
  | { readonly estado: 'sin_datos'; readonly loteId: string; readonly correlacion: string }
  | {
      readonly estado: 'abortado';
      readonly motivoCodigo: MotivoAbortoPlanilla;
      readonly filaNumero?: number;
    };

export async function exportarPlanillaDeLote(
  tx: Tx,
  pedido: PedidoExportPlanilla,
): Promise<ResultadoExportPlanilla> {
  // 1. Rol contra la BASE (misma función que usan las policies, no un objeto de sesión).
  const rolFilas = await tx.consultar<{ puede: boolean }>(
    `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
    [pedido.clienteId, ROLES_QUE_EXPORTAN],
  );
  if (rolFilas[0]?.puede !== true) {
    return { estado: 'abortado', motivoCodigo: 'rol_insuficiente' };
  }

  // 2. Ubicar el lote — `cliente_id` explícito en el WHERE, aunque se vaya por PK (`--lote-id`): la RLS
  // es el mecanismo, no la única verificación (mismo criterio que `descarga.ts`). `lote_ingesta` no lleva
  // ninguna columna ≥ N2, así que esta lectura es segura ANTES de auditar.
  const loteFilas = await tx.consultar<{ id: string; banco_codigo: string; estado: string }>(
    `select id::text as id, banco_codigo, estado
       from lote_ingesta
      where id = $1 and cliente_id = $2`,
    [pedido.loteId, pedido.clienteId],
  );
  const lote = loteFilas[0];
  // Mismo código si no existe o si es de otro cliente: nunca distinguir, para no convertir el CLI en
  // oráculo de enumeración de lotes ajenos.
  if (!lote) {
    return { estado: 'abortado', motivoCodigo: 'lote_no_encontrado' };
  }
  if (!ESTADOS_LOTE_EXPORTABLE.has(lote.estado)) {
    return { estado: 'abortado', motivoCodigo: 'lote_no_exportable' };
  }

  // 3. Auditoría, PRIMERO — antes de leer una sola fila con datos N2. Si algo falla después, el rastro
  // del intento ya quedó.
  const correlacion = await registrarAcceso(tx, {
    clienteId: pedido.clienteId,
    accion: 'export',
    recurso: 'movimiento_bancario_crudo',
    recursoId: pedido.loteId,
    motivo: `${pedido.motivoCodigo}|dest:${pedido.destinatarioCodigo}`,
  });

  // 4. Cabecera(s) — N2. Con `cuenta_bancaria_id` explícito en el WHERE cuando se pasó el filtro.
  const cabeceraFilas = await tx.consultar<{
    cuenta_bancaria_id: string;
    banco_codigo: string;
    cuenta_alias: string | null;
    moneda: string;
    periodo_desde: string;
    periodo_hasta: string;
    saldo_inicial_declarado: string | null;
    saldo_final_declarado: string | null;
    total_creditos_declarado: string | null;
    total_debitos_declarado: string | null;
    saldo_final_calculado: string | null;
    total_creditos_calculado: string | null;
    total_debitos_calculado: string | null;
    filas_leidas: number;
    filas_aceptadas: number;
    verificacion_estado: string;
  }>(
    `select lic.cuenta_bancaria_id::text        as cuenta_bancaria_id,
            cb.banco_codigo                     as banco_codigo,
            cb.alias                            as cuenta_alias,
            lic.moneda                          as moneda,
            lic.periodo_desde::text             as periodo_desde,
            lic.periodo_hasta::text             as periodo_hasta,
            lic.saldo_inicial_declarado::text   as saldo_inicial_declarado,
            lic.saldo_final_declarado::text     as saldo_final_declarado,
            lic.total_creditos_declarado::text  as total_creditos_declarado,
            lic.total_debitos_declarado::text   as total_debitos_declarado,
            lic.saldo_final_calculado::text     as saldo_final_calculado,
            lic.total_creditos_calculado::text  as total_creditos_calculado,
            lic.total_debitos_calculado::text   as total_debitos_calculado,
            lic.filas_leidas::int               as filas_leidas,
            lic.filas_aceptadas::int            as filas_aceptadas,
            lic.verificacion_estado             as verificacion_estado
       from lote_ingesta_cuenta lic
       join cuenta_bancaria cb on cb.cliente_id = lic.cliente_id and cb.id = lic.cuenta_bancaria_id
      where lic.cliente_id = $1
        and lic.lote_ingesta_id = $2
        and ($3::uuid is null or lic.cuenta_bancaria_id = $3::uuid)
      order by cb.banco_codigo, lic.moneda, lic.cuenta_bancaria_id`,
    [pedido.clienteId, pedido.loteId, pedido.cuentaBancariaId ?? null],
  );
  if (cabeceraFilas.length === 0) {
    return { estado: 'abortado', motivoCodigo: 'sin_cabecera' };
  }

  const cabeceras: readonly CabeceraCuenta[] = cabeceraFilas.map((f) => ({
    cuentaBancariaId: f.cuenta_bancaria_id,
    bancoCodigo: f.banco_codigo,
    cuentaAlias: f.cuenta_alias,
    moneda: f.moneda,
    periodoDesde: f.periodo_desde,
    periodoHasta: f.periodo_hasta,
    saldoInicialDeclarado: f.saldo_inicial_declarado,
    saldoFinalDeclarado: f.saldo_final_declarado,
    totalCreditosDeclarado: f.total_creditos_declarado,
    totalDebitosDeclarado: f.total_debitos_declarado,
    saldoFinalCalculado: f.saldo_final_calculado,
    totalCreditosCalculado: f.total_creditos_calculado,
    totalDebitosCalculado: f.total_debitos_calculado,
    filasLeidas: f.filas_leidas,
    filasAceptadas: f.filas_aceptadas,
    verificacionEstado: f.verificacion_estado,
  }));

  // 5. Tope de filas — se cuenta ANTES de traer los datos, para no cargar en memoria lo que se va a
  // rechazar igual.
  const conteoFilas = await tx.consultar<{ n: string }>(
    `select count(*)::text as n
       from movimiento_bancario_crudo
      where cliente_id = $1 and lote_ingesta_id = $2 and ($3::uuid is null or cuenta_bancaria_id = $3::uuid)`,
    [pedido.clienteId, pedido.loteId, pedido.cuentaBancariaId ?? null],
  );
  const totalMovimientos = Number(conteoFilas[0]?.n ?? '0');
  if (totalMovimientos === 0) {
    return { estado: 'sin_datos', loteId: pedido.loteId, correlacion };
  }
  if (totalMovimientos > MAX_FILAS) {
    return { estado: 'abortado', motivoCodigo: 'demasiadas_filas' };
  }

  // 6. Movimientos — N2. `::text` en `date`: sin el cast el driver devuelve un `Date` y la zona horaria
  // del host corre el día (mismo criterio que `lecturas.ts`).
  const movFilas = await tx.consultar<{
    fila_numero: number;
    cuenta_bancaria_id: string;
    fecha: string;
    fecha_valor: string | null;
    descripcion: string;
    concepto_banco: string | null;
    concepto_codigo: string | null;
    concepto_completo: boolean | null;
    concepto_banco_estrategia: string | null;
    importe: string;
    saldo: string | null;
    saldo_es_acreedor: boolean | null;
    moneda: string;
    referencia_externa: string | null;
    pagina_pdf: number | null;
  }>(
    `select m.fila_numero::int         as fila_numero,
            m.cuenta_bancaria_id::text as cuenta_bancaria_id,
            m.fecha::text              as fecha,
            m.fecha_valor::text        as fecha_valor,
            m.descripcion              as descripcion,
            m.concepto_banco           as concepto_banco,
            m.concepto_codigo          as concepto_codigo,
            m.concepto_completo        as concepto_completo,
            m.concepto_banco_estrategia as concepto_banco_estrategia,
            m.importe::text            as importe,
            m.saldo::text              as saldo,
            m.saldo_es_acreedor        as saldo_es_acreedor,
            m.moneda                   as moneda,
            m.referencia_externa       as referencia_externa,
            m.pagina_pdf::int          as pagina_pdf
       from movimiento_bancario_crudo m
      where m.cliente_id = $1
        and m.lote_ingesta_id = $2
        and ($3::uuid is null or m.cuenta_bancaria_id = $3::uuid)
      order by m.cuenta_bancaria_id, m.fila_numero`,
    [pedido.clienteId, pedido.loteId, pedido.cuentaBancariaId ?? null],
  );

  const filas: readonly FilaPlanilla[] = movFilas.map((f) => ({
    filaNumero: f.fila_numero,
    cuentaBancariaId: f.cuenta_bancaria_id,
    fecha: f.fecha,
    fechaValor: f.fecha_valor,
    descripcion: f.descripcion,
    conceptoBanco: f.concepto_banco,
    conceptoCodigo: f.concepto_codigo,
    conceptoCompleto: f.concepto_completo,
    conceptoBancoEstrategia: f.concepto_banco_estrategia,
    importe: f.importe,
    saldo: f.saldo,
    saldoEsAcreedor: f.saldo_es_acreedor,
    moneda: f.moneda,
    referenciaExterna: f.referencia_externa,
    paginaPdf: f.pagina_pdf,
  }));

  const resultadoLibro = armarLibro({
    clienteId: pedido.clienteId,
    loteId: pedido.loteId,
    bancoCodigo: lote.banco_codigo,
    loteEstado: lote.estado,
    adaptadorVersion: '',
    generadoEn: pedido.generadoEn,
    correlacion,
    motivoCodigo: pedido.motivoCodigo,
    destinatarioCodigo: pedido.destinatarioCodigo,
    cabeceras,
    filas,
  });
  if (resultadoLibro.estado === 'abortado') {
    return resultadoLibro.filaNumero === undefined
      ? { estado: 'abortado', motivoCodigo: resultadoLibro.motivoCodigo }
      : { estado: 'abortado', motivoCodigo: resultadoLibro.motivoCodigo, filaNumero: resultadoLibro.filaNumero };
  }

  const libro = await serializarLibro(resultadoLibro.libro);

  const periodos = cabeceras.map((c) => ({ desde: c.periodoDesde, hasta: c.periodoHasta }));
  const periodoDesde = periodos.reduce((min, p) => (p.desde < min ? p.desde : min), periodos[0]?.desde ?? '');
  const periodoHasta = periodos.reduce((max, p) => (p.hasta > max ? p.hasta : max), periodos[0]?.hasta ?? '');

  return {
    estado: 'armada',
    loteId: pedido.loteId,
    bancoCodigo: lote.banco_codigo,
    libro,
    filas: resultadoLibro.filas,
    cuentas: cabeceras.length,
    verificacion: cabeceras.map((c) => c.verificacionEstado),
    periodoDesde,
    periodoHasta,
    correlacion,
  };
}

export type LoteExportable = {
  readonly loteId: string;
  readonly bancoCodigo: string;
  readonly estado: string;
  readonly cuentas: number;
  readonly filasAceptadas: number;
  readonly periodoDesde: string | null;
  readonly periodoHasta: string | null;
};

/** Modo listado: qué lotes hay para exportar. Códigos y conteos, ni un solo importe. */
export async function listarLotesExportables(
  tx: Tx,
  pedido: { readonly clienteId: string; readonly bancoCodigo?: string; readonly limite?: number },
): Promise<readonly LoteExportable[]> {
  const filas = await tx.consultar<{
    lote_id: string;
    banco_codigo: string;
    estado: string;
    cuentas: number;
    filas_aceptadas: number;
    periodo_desde: string | null;
    periodo_hasta: string | null;
  }>(
    `select li.id::text                     as lote_id,
            li.banco_codigo                 as banco_codigo,
            li.estado                       as estado,
            count(lic.id)::int              as cuentas,
            coalesce(sum(lic.filas_aceptadas), 0)::int as filas_aceptadas,
            min(lic.periodo_desde)::text    as periodo_desde,
            max(lic.periodo_hasta)::text    as periodo_hasta
       from lote_ingesta li
       left join lote_ingesta_cuenta lic
              on lic.cliente_id = li.cliente_id and lic.lote_ingesta_id = li.id
      where li.cliente_id = $1
        and ($2::text is null or li.banco_codigo = $2::text)
        and li.estado in ('procesado', 'procesado_con_observaciones')
      group by li.id, li.banco_codigo, li.estado
      order by max(lic.periodo_hasta) desc nulls last, li.id
      limit $3::int`,
    [pedido.clienteId, pedido.bancoCodigo ?? null, pedido.limite ?? 50],
  );

  return filas.map((f) => ({
    loteId: f.lote_id,
    bancoCodigo: f.banco_codigo,
    estado: f.estado,
    cuentas: f.cuentas,
    filasAceptadas: f.filas_aceptadas,
    periodoDesde: f.periodo_desde,
    periodoHasta: f.periodo_hasta,
  }));
}

/** Misma forma que exige `banco_codigo_chk` en la base — se reusa acá y en `--banco` del CLI, en vez de
 *  tener el regex escrito dos veces. */
export const RE_BANCO_CODIGO = /^[a-z0-9_]{2,32}$/;

/**
 * Resuelve el `banco_codigo` de un lote, ANTES de auditar o de tocar N2. Lectura N1 pura de
 * `lote_ingesta` (sin una sola columna ≥ N2, a propósito — ver el header de este módulo), así que no
 * exige rol-check ni auditoría.
 *
 * 🔴 Best-effort, NUNCA decisorio: existe solo para que el CLI pueda componer un nombre de archivo
 * legible ANTES de reservarlo. `null` si no hay fila (lote inexistente, o de otro cliente — RLS +
 * `cliente_id` explícito, mismo criterio que el resto de este archivo). La única autoridad real sobre
 * "¿existe este lote y puedo exportarlo?" sigue siendo `exportarPlanillaDeLote` — el llamador tiene que
 * comparar el resultado de acá contra `resultado.bancoCodigo` antes de escribir nada a disco (plan
 * `adaptive-herding-pillow`, chequeo de coherencia `banco_incoherente`).
 */
export async function resolverBancoDelLote(
  tx: Tx,
  args: { readonly clienteId: string; readonly loteId: string },
): Promise<string | null> {
  const filas = await tx.consultar<{ banco_codigo: string }>(
    `select banco_codigo from lote_ingesta where id = $1 and cliente_id = $2`,
    [args.loteId, args.clienteId],
  );
  return filas[0]?.banco_codigo ?? null;
}
