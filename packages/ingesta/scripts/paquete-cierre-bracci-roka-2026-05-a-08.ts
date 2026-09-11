/**
 * Paquete de cierre mayo-agosto 2026 para Laura — DOS archivos .xlsx separados (Bracci, ROKA),
 * nunca mezclados (INV-5, mismo criterio que `relevamiento-laura.ts`). Reusa
 * `agruparFilas`/`armarHojaGrupos`/`armarHojaEjemplosDeAsiento`/`armarHojaPlanDeCuentasOculta` de
 * `armar-libro.ts` sobre el universo MULTI-LOTE del cliente en el rango de fechas — a diferencia
 * del export mensual existente (`exportarPlanillaDeLote`), que es siempre de UN lote.
 *
 * 🔴 **Puntual de esta entrega, NO un CLI genérico** — `CLIENTES`/`DESDE`/`HASTA` están
 * hardcodeados a Bracci/ROKA/mayo-agosto 2026, a propósito: se mantiene en el repo (renombrado,
 * ya no `_tmp-`, HANDOFF 209) porque es repetible y probado contra el piloto real, pero
 * generalizarlo (flags de fecha/cliente, patrón `zod` como el resto de `apps/cli/src/`) es trabajo
 * aparte, sin dueño, si vuelve a hacer falta un paquete de este tipo para otro cliente o período.
 *
 * Corrección de fondo (JP, 2026-09-10) — 8 puntos, plan aprobado (`declarative-orbiting-bachman.md`):
 * 1. "Cuenta contable asignada"/"Contraparte identificada" en Grupos — cuenta real (Capa D, vía
 *    `asiento_propuesto_renglon`) y contraparte real (vía `reconocimiento_contrapartida` +
 *    `padron_contraparte`, 0037/0038 — NO la 0037 sola, que el propio DDL dice sin conectar).
 * 2. Leyenda de color visible en cada hoja nueva — el color solo no alcanza (JP).
 * 3. Resumen ejecutivo menciona las 3 hojas (Grupos, Ejemplos de asiento real, Acumulado).
 * 4. Salvedad de Acumulado corregida — el mapeo tipo→cuenta SÍ existe y funciona para 3 tipos; lo que
 *    falta es la regla puntual de los demás (nombrados, con su cuenta real citada cuando aplica).
 * 5. Hoja "Ejemplos de asiento real" — formato diario, 1 ejemplo por tipo homogéneo, 2 si el tipo
 *    tiene más de una cuenta real posible (con nota de la condición si es identificable).
 * 6. Bloque C del Acumulado — por cuenta contable real, con su fila "sin cuenta asignada — pendiente".
 * 7. Columnas de feedback ("Comentarios", "Si es NO: cuenta que hubieras usado") en Grupos y Ejemplos.
 * 8. Chequeo cruzado Σdebe=Σhaber de Bloque C — `throw` si no cuadra, ANTES de serializar el archivo.
 *
 * Segunda corrección de fondo (JP, 2026-09-11, cierre del "Frente 2") — convocatoria completa
 * (`contador-dominio` + `seguridad-datos-financieros` + `security-engineer` + `ux-designer`):
 * 9. Resumen ejecutivo: los DOS números (77,4%/80,2% automático sobre el total — sin cambio; 99,5%/
 *    99,5% de eso YA con cuenta real, antes 0%) explícitos y SIEMPRE separados, nunca mezclados.
 * 10. Columnas 7 de arriba reemplazadas: "¿A qué cuenta contable va?" (desplegable real del plan de
 *     cuentas del cliente, hoja oculta nueva) + "Comentario libre" — con contenido/validación SOLO en
 *     los grupos que siguen pidiendo una decisión genuina (`requiereRevision`); el resto, "— no
 *     aplica —" en gris (`ux-designer`).
 * 11. `console.error`/`console.log` con error crudo del driver o agregado de un solo cliente —
 *     corregidos (`seguridad-datos-financieros` H-1/H-2, `security-engineer` H-3/B): todo el logging
 *     pasa por `loggerAcotado`, nunca `error.message`/`error` crudo del driver de Postgres.
 *
 *     ENV_FILE=.env.piloto node packages/ingesta/scripts/paquete-cierre-bracci-roka-2026-05-a-08.ts \
 *       --usuario <uuid> --salida <carpeta-de-destino>
 */
import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {
  conUsuario,
  verificarCredencialDeRequest,
  registrarAcceso,
  leerPlanDeCuentasCompleto,
  type Tx,
} from '@sistema-contable/data';
import { textoDeTipo, TEXTO_SIN_TIPO, type TipoMovimiento } from '@sistema-contable/contabilidad';
import {
  agruparFilas,
  armarHojaGrupos,
  armarHojaEjemplosDeAsiento,
  armarHojaPlanDeCuentasOculta,
  COLUMNAS_GRUPOS_EXTENDIDO,
  serializarLibro,
  MAX_FILAS,
  FMT_MONEDA_CON_SIGNO,
  importeCanonicoANumeroExcel,
  type FilaPlanilla,
  type BloqueDeEjemplo,
  type RenglonDeEjemplo,
  type CuentaParaDesplegable,
} from '../src/planilla/armar-libro.ts';
import { ROLES_QUE_EXPORTAN } from '../src/planilla/exportar-planilla.ts';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

type CamposPaqueteFinal = 'cliente_id' | 'causa_tipo' | 'diferencia_bloque_c';
const log = loggerAcotado<CamposPaqueteFinal>();

/** Mismo patrón que `apps/cli/src/alta-regla-imputacion.ts::causaTipo` — nunca el mensaje crudo del
 *  driver (`seguridad-datos-financieros` H-1, `security-engineer` H-3: `DETAIL`/`constructor`
 *  completo de un `DatabaseError` de `pg` puede traer el valor de una fila real). */
function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

const DESDE = '2026-05-01';
const HASTA = '2026-08-31';
const MESES_INCLUIDOS = 'Mayo, junio, julio, agosto 2026';

// -----------------------------------------------------------------------------
// Mismo criterio EXACTO que `exportar-planilla.ts::categoriaEspecialDe`/`agrupableDe` (Tanda 1) —
// replicado acá porque son funciones privadas de ese módulo, no exportadas.
// -----------------------------------------------------------------------------

const QUE_DECIDE_TARJETA_PENDIENTE = new Set(['completar_con_liquidacion_del_adquirente', 'completar_con_liquidacion_de_la_tarjeta']);

function esAgrupable(clase: string, queDecide: string | null): boolean {
  return !(clase === 'decision_humana' && queDecide === 'distinguir_tercero_de_socio');
}
function categoriaEspecialDe(clase: string, queDecide: string | null): 'tarjeta_pendiente' | null {
  return clase === 'decision_humana' && queDecide !== null && QUE_DECIDE_TARJETA_PENDIENTE.has(queDecide)
    ? 'tarjeta_pendiente'
    : null;
}
function identificacionDe(clase: string, tipo: string | null): string {
  if (clase === 'sin_reconocer' || tipo === null) return TEXTO_SIN_TIPO;
  return textoDeTipo(tipo as TipoMovimiento);
}

/** Cuenta bancaria del cliente (heurística por denominación, ver HANDOFF de cierre): no hay un FK
 *  estructural de `cuenta` (contable) a `cuenta_bancaria` (extracto) — se identifica por texto porque
 *  en los datos reales de Bracci/ROKA toda cuenta bancaria real dice "banco"/"cta cte"/"cuenta
 *  especial" en su denominación. Riesgo aceptado y declarado: un plan de cuentas que nombrara una
 *  cuenta bancaria distinto rompería esta heurística en silencio — deuda para cuando haya un enlace
 *  estructural real. */
function esCuentaBancariaPorDenominacion(denominacion: string): boolean {
  return /banco|cta\.?\s*cte|cuenta\s*especial|cuenta\s*corriente/i.test(denominacion);
}

type ClienteCfg = { readonly id: string; readonly nombre: string; readonly incluyeTarjeta: boolean };
const CLIENTES: readonly ClienteCfg[] = [
  { id: 'f84d9ecc-6d54-4009-8fb6-b6fa3f8d8579', nombre: 'Bracci', incluyeTarjeta: true },
  { id: '69479b8f-9b6a-4d6b-bdb2-bff817c2e750', nombre: 'ROKA', incluyeTarjeta: false },
];

// -----------------------------------------------------------------------------
// Lectura — rol, auditoría (con lotes exactos), SAVEPOINT, tope agregado, movimientos, renglones
// reales de Capa D, contraparte real, cuentas.
// -----------------------------------------------------------------------------

async function tieneRolSuficiente(tx: Tx, clienteId: string): Promise<boolean> {
  const filas = await tx.consultar<{ puede: boolean }>(
    `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
    [clienteId, ROLES_QUE_EXPORTAN],
  );
  return filas[0]?.puede === true;
}

async function lotesEnRango(tx: Tx, clienteId: string): Promise<readonly string[]> {
  const filas = await tx.consultar<{ lote_ingesta_id: string }>(
    `select distinct lote_ingesta_id::text as lote_ingesta_id
       from movimiento_bancario_crudo
      where cliente_id = $1 and fecha between $2::date and $3::date`,
    [clienteId, DESDE, HASTA],
  );
  return filas.map((f) => f.lote_ingesta_id);
}

type FilaCruda = {
  readonly movimiento_id: string;
  readonly cuenta_bancaria_id: string;
  readonly fila_numero: number;
  readonly fecha: string;
  readonly descripcion: string;
  readonly concepto_banco: string | null;
  readonly importe: string;
  readonly clase: string;
  readonly tipo: string | null;
  readonly que_decide: string | null;
};

type RenglonReal = {
  readonly movimiento_id: string;
  readonly tipo: string;
  readonly fecha: string;
  readonly descripcion: string;
  readonly codigo: string | null;
  readonly denominacion: string | null;
  readonly debe: string;
  readonly haber: string;
};

type ContraparteReal = { readonly movimiento_id: string; readonly patron: string; readonly clasificacion: string };

type CabeceraLigera = {
  readonly cuentaBancariaId: string;
  readonly bancoCodigo: string;
  readonly alias: string | null;
  readonly moneda: string;
};

type ResultadoLectura =
  | {
      readonly estado: 'ok';
      readonly crudas: readonly FilaCruda[];
      readonly renglones: readonly RenglonReal[];
      readonly contrapartes: readonly ContraparteReal[];
      readonly cabeceras: ReadonlyMap<string, CabeceraLigera>;
      readonly lotes: readonly string[];
      /** Plan de cuentas real del cliente, YA filtrado a `activa && vigenteHasta === null` (fuente del
       *  desplegable de "Grupos") — filtro mínimo confirmado por JP tras el dictamen de
       *  `contador-dominio` (2026-09-11): no distingue cuenta imputable de cuenta título/agrupación
       *  porque `cuenta_atributo` no tiene ese campo hoy (agregarlo es una migración nueva, fuera de
       *  alcance de esta tarea) — deuda declarada, no bloqueante. */
      readonly cuentasDelPlan: readonly CuentaParaDesplegable[];
      /** Movimientos de FCI (`rescate_fci`/`suscripcion_fci`) que YA se excluyeron de `crudas` — para
       *  declarar el recorte en el Resumen ejecutivo (JP, 2026-09-11: FCI está fuera de alcance de
       *  este paquete, así que el "Total de movimientos" tiene que decirlo, no dejarlo implícito). */
      readonly cantidadFciExcluida: number;
    }
  | { readonly estado: 'abortado'; readonly motivoCodigo: string };

const SAVEPOINT_LECTURA = 'sp_paquete_final_laura';

async function leerCliente(tx: Tx, clienteId: string): Promise<ResultadoLectura> {
  const lotes = await lotesEnRango(tx, clienteId);

  // "Primero el rastro" — auditoría ANTES de leer una sola fila N2, con los lotes exactos enumerados
  // (condición de `seguridad-datos-financieros`: el rango de fechas solo no alcanza).
  await registrarAcceso(tx, {
    clienteId,
    accion: 'export',
    recurso: 'movimiento_bancario_crudo',
    motivo: `paquete_cierre_4meses|dest:estudio_interno|rango:${DESDE}_${HASTA}|lotes:${lotes.join(',')}`,
  });

  await tx.consultar(`savepoint ${SAVEPOINT_LECTURA}`);
  try {
    // Tope agregado ANTES de traer una sola fila — por cliente+rango, NUNCA por lote.
    const conteo = await tx.consultar<{ n: string }>(
      `select count(*)::text as n
         from movimiento_bancario_crudo
        where cliente_id = $1 and fecha between $2::date and $3::date`,
      [clienteId, DESDE, HASTA],
    );
    const total = Number(conteo[0]?.n ?? '0');
    if (total > MAX_FILAS) {
      await tx.consultar(`rollback to savepoint ${SAVEPOINT_LECTURA}`);
      return { estado: 'abortado', motivoCodigo: 'demasiadas_filas' };
    }

    const cuentaFilas = await tx.consultar<{
      cuenta_bancaria_id: string;
      banco_codigo: string;
      alias: string | null;
      moneda: string;
    }>(
      `select distinct cb.id::text as cuenta_bancaria_id, cb.banco_codigo, cb.alias, cb.moneda
         from cuenta_bancaria cb
         join movimiento_bancario_crudo m on m.cliente_id = cb.cliente_id and m.cuenta_bancaria_id = cb.id
        where cb.cliente_id = $1 and m.fecha between $2::date and $3::date`,
      [clienteId, DESDE, HASTA],
    );
    const cabeceras = new Map(
      cuentaFilas.map((c) => [
        c.cuenta_bancaria_id,
        { cuentaBancariaId: c.cuenta_bancaria_id, bancoCodigo: c.banco_codigo, alias: c.alias, moneda: c.moneda },
      ]),
    );

    // FCI (rescate_fci/suscripcion_fci) — FUERA de alcance de este paquete (el instructivo lo dice
    // explícito). Excluidos del universo COMPLETO leído acá, no solo de "Grupos" — si quedaran en
    // los totales sin aparecer en ninguna hoja sería la misma inconsistencia ya corregida hoy en
    // (207) §6 (un número que no coincide con ninguna hoja real). Identificados por
    // `evidencia_entrada_lexico_id` (`<banco>.rescate_fci`/`<banco>.suscripcion_fci`) — estructural,
    // nunca por texto libre (`concepto_banco ilike '%FIMA%'` sería un nombre comercial de un banco
    // en particular, no el concepto real — de hecho Macro/ROKA no usa "FIMA": sus literales son "10
    // Sol.Resc"/"10 Liq.Susc", `macro.ts`; el filtro estructural los agarra igual). `tipo` es `null`
    // para estas filas a propósito (`resuelve: 'sin_tipo_asignado'` en `catalogo.ts`), así que no se
    // puede filtrar por tipo.
    //
    // 🔴 `coalesce(..., '')`, nunca comparar `evidencia_entrada_lexico_id` pelado contra `like` — la
    // columna es NULL para la mayoría de las filas (no toda fila tiene evidencia de léxico
    // persistida), y en SQL `not (NULL or NULL)` es `NULL`, no `true`: sin el `coalesce`, `where ...
    // and not (ES_FCI)` excluye también TODA fila con la columna en NULL, no solo las FCI — bug real
    // de esta misma sesión, encontrado al ver que el total de Bracci cayó 333 en vez de 79 (254 filas
    // de más, exactamente las que tienen `evidencia_entrada_lexico_id is null` en el período).
    const ES_FCI = `(coalesce(r.evidencia_entrada_lexico_id, '') like '%.rescate_fci' or coalesce(r.evidencia_entrada_lexico_id, '') like '%.suscripcion_fci')`;

    const crudas = await tx.consultar<FilaCruda>(
      `select
         m.id::text                 as movimiento_id,
         m.cuenta_bancaria_id::text as cuenta_bancaria_id,
         m.fila_numero::int         as fila_numero,
         m.fecha::text              as fecha,
         m.descripcion              as descripcion,
         m.concepto_banco           as concepto_banco,
         m.importe::text            as importe,
         r.clase                    as clase,
         r.tipo                     as tipo,
         r.que_decide               as que_decide
       from movimiento_bancario_crudo m
       join reconocimiento_movimiento r
         on r.cliente_id = m.cliente_id and r.movimiento_id = m.id and r.superseded_por is null
       where m.cliente_id = $1 and m.fecha between $2::date and $3::date and not ${ES_FCI}
       order by m.cuenta_bancaria_id, m.fecha, m.fila_numero`,
      [clienteId, DESDE, HASTA],
    );

    const excluidosPorFci = await tx.consultar<{ n: string }>(
      `select count(*)::text as n
         from movimiento_bancario_crudo m
         join reconocimiento_movimiento r
           on r.cliente_id = m.cliente_id and r.movimiento_id = m.id and r.superseded_por is null
        where m.cliente_id = $1 and m.fecha between $2::date and $3::date and ${ES_FCI}`,
      [clienteId, DESDE, HASTA],
    );
    const cantidadFciExcluida = Number(excluidosPorFci[0]?.n ?? '0');

    // Renglones REALES de Capa D (puntos 1/5/6/8) — un movimiento `propuesta` con asiento aporta 2+
    // filas acá (una por renglón). Población: `clase = 'propuesta'`, mismo filtro que `crudas`.
    const renglones = await tx.consultar<RenglonReal>(
      `select r.movimiento_id::text as movimiento_id, r.tipo, m.fecha::text as fecha, m.descripcion,
              arr.cuenta_ref->>'codigo' as codigo, arr.cuenta_ref->>'denominacion' as denominacion,
              arr.debe::text as debe, arr.haber::text as haber
       from reconocimiento_movimiento r
       join movimiento_bancario_crudo m on m.cliente_id = r.cliente_id and m.id = r.movimiento_id
       join asiento_propuesto_renglon arr
         on arr.cliente_id = r.cliente_id and arr.referencia_origen::uuid = r.movimiento_id
       where r.cliente_id = $1 and r.superseded_por is null and r.clase = 'propuesta'
         and m.fecha between $2::date and $3::date`,
      [clienteId, DESDE, HASTA],
    );

    // Contraparte real (0037/0038 — punto 1, columna 2). `string_agg` colapsa el caso `varios` a un
    // solo texto legible en vez de perder la información o elegir uno arbitrario.
    const contrapartes = await tx.consultar<ContraparteReal>(
      `select r.movimiento_id::text as movimiento_id,
              string_agg(distinct pc.patron, ' / ' order by pc.patron) as patron,
              string_agg(distinct pc.clasificacion, ' / ' order by pc.clasificacion) as clasificacion
       from reconocimiento_movimiento r
       join movimiento_bancario_crudo m on m.cliente_id = r.cliente_id and m.id = r.movimiento_id
       join reconocimiento_contrapartida rc on rc.cliente_id = r.cliente_id and rc.reconocimiento_id = r.id
       join reconocimiento_contrapartida_patron_match pm
         on pm.cliente_id = r.cliente_id and pm.contrapartida_id = rc.id
       join padron_contraparte pc on pc.cliente_id = r.cliente_id and pc.id = pm.padron_contraparte_id
       where r.cliente_id = $1 and r.superseded_por is null and rc.patron_contraparte_estado = 'match'
         and m.fecha between $2::date and $3::date
       group by r.movimiento_id`,
      [clienteId, DESDE, HASTA],
    );

    // Plan de cuentas real (fuente del desplegable de "Grupos") — rastro APARTE del de
    // `movimiento_bancario_crudo` de arriba: es un recurso distinto que también sale del sistema
    // hacia el `.xlsx` (`security-engineer`, 2026-09-11: "primero el rastro" vale para cada recurso,
    // no queda implícito en el motivo de otro). Filtro de vigencia ACÁ, nunca en `armar-libro.ts`:
    // `leerPlanDeCuentasCompleto` trae TODO el historial a propósito (sirve para otros llamadores que
    // sí lo necesitan) — este caller filtra antes de que la cuenta dada de baja llegue a la hoja
    // oculta.
    await registrarAcceso(tx, {
      clienteId,
      accion: 'export',
      recurso: 'cuenta_atributo',
      motivo: `paquete_cierre_4meses|dest:estudio_interno|desplegable_grupos`,
    });
    const planCompleto = await leerPlanDeCuentasCompleto(tx, { clienteId });
    const cuentasDelPlan: CuentaParaDesplegable[] = planCompleto
      .filter((c) => c.activa && c.vigenteHasta === null)
      .map((c) => ({ codigo: c.codigo, denominacion: c.denominacion }))
      .sort((a, b) => a.codigo.localeCompare(b.codigo));

    await tx.consultar(`release savepoint ${SAVEPOINT_LECTURA}`);
    return { estado: 'ok', crudas, renglones, contrapartes, cabeceras, lotes, cuentasDelPlan, cantidadFciExcluida };
  } catch (error) {
    // La fila de auditoría YA insertada sobrevive: se despoisona la tx y se retorna un estado
    // controlado — NUNCA relanzar acá, o `conUsuario` haría rollback de toda la transacción.
    await tx.consultar(`rollback to savepoint ${SAVEPOINT_LECTURA}`);
    log.error('paquete_final.lectura_fallo', { causa_tipo: causaTipo(error) });
    return { estado: 'abortado', motivoCodigo: 'error_de_lectura' };
  }
}

// -----------------------------------------------------------------------------
// Renglones reales agrupados por movimiento — insumo de `cuentaContable` (FilaPlanilla), Bloque C, y
// los ejemplos de asiento.
// -----------------------------------------------------------------------------

type RenglonesPorMovimiento = ReadonlyMap<string, readonly RenglonReal[]>;

function agruparRenglonesPorMovimiento(renglones: readonly RenglonReal[]): RenglonesPorMovimiento {
  const mapa = new Map<string, RenglonReal[]>();
  for (const r of renglones) {
    const arr = mapa.get(r.movimiento_id) ?? [];
    arr.push(r);
    mapa.set(r.movimiento_id, arr);
  }
  return mapa;
}

/** La pata "real" (no bancaria) del asiento de un movimiento — la que se muestra en "Cuenta contable
 *  asignada" (la pata bancaria ya se ve en "Cuenta (del ejemplo)"). `null` si el asiento fuera 100%
 *  de cuentas bancarias (no debería pasar en el corpus real) o si el movimiento no tiene asiento. */
function cuentaContableDelMovimiento(renglonesDelMov: readonly RenglonReal[] | undefined): { codigo: string; denominacion: string } | null {
  if (!renglonesDelMov) return null;
  const noBancaria = renglonesDelMov.find((r) => r.codigo !== null && r.denominacion !== null && !esCuentaBancariaPorDenominacion(r.denominacion));
  if (!noBancaria || noBancaria.codigo === null || noBancaria.denominacion === null) return null;
  return { codigo: noBancaria.codigo, denominacion: noBancaria.denominacion };
}

// -----------------------------------------------------------------------------
// FilaCruda → FilaPlanilla, para `agruparFilas`/`armarHojaGrupos` (Tanda 1 + corrección de fondo).
// -----------------------------------------------------------------------------

function comoFilaPlanilla(
  f: FilaCruda,
  renglonesPorMovimiento: RenglonesPorMovimiento,
  contrapartesPorMovimiento: ReadonlyMap<string, ContraparteReal>,
): FilaPlanilla {
  const contraparte = contrapartesPorMovimiento.get(f.movimiento_id);
  return {
    filaNumero: f.fila_numero,
    cuentaBancariaId: f.cuenta_bancaria_id,
    fecha: f.fecha,
    fechaValor: null,
    descripcion: f.descripcion,
    conceptoBanco: f.concepto_banco,
    conceptoCodigo: null,
    conceptoCompleto: null,
    conceptoBancoEstrategia: null,
    importe: f.importe,
    saldo: null,
    saldoEsAcreedor: null,
    moneda: 'ARS',
    referenciaExterna: null,
    paginaPdf: null,
    identificacion: identificacionDe(f.clase, f.tipo),
    confianza: null,
    pendiente: null,
    contraparteConocida: null,
    categoriaEspecial: categoriaEspecialDe(f.clase, f.que_decide),
    cuentaContable: cuentaContableDelMovimiento(renglonesPorMovimiento.get(f.movimiento_id)),
    contraparte: contraparte ? { patron: contraparte.patron, clasificacion: contraparte.clasificacion } : null,
    requiereDecisionHumana: f.clase !== 'propuesta',
    agrupable: esAgrupable(f.clase, f.que_decide),
  };
}

// -----------------------------------------------------------------------------
// Hoja "Resumen ejecutivo" — solo agregados, ya verificados contra la base antes de esta corrida.
// Punto 3: menciona explícito las 3 hojas y qué encontrar en cada una.
// -----------------------------------------------------------------------------

function armarHojaResumen(
  libro: ExcelJS.Workbook,
  cliente: ClienteCfg,
  crudas: readonly FilaCruda[],
  renglones: readonly RenglonReal[],
  cantidadGruposDecidir: number,
  cantidadGruposTarjeta: number,
  cantidadFciExcluida: number,
): void {
  const hoja = libro.addWorksheet('Resumen ejecutivo');
  const total = crudas.length;
  const propuesta = crudas.filter((f) => f.clase === 'propuesta').length;
  const tarjeta = crudas.filter((f) => categoriaEspecialDe(f.clase, f.que_decide) === 'tarjeta_pendiente').length;
  const decidir = total - propuesta - tarjeta;
  const pct = (n: number, sobre: number): string => (sobre > 0 ? `${((n / sobre) * 100).toFixed(1)}%` : '0.0%');

  // Dos medidas DISTINTAS, siempre separadas en el texto (JP + convocatoria, 2026-09-11 — nunca una
  // cifra sola que las mezcle): (1) qué fracción del total el sistema identifica solo, sin cambios
  // desde antes de las 4 reglas de HANDOFF 204 (Capa D no toca esta clasificación); (2) de eso ya
  // identificado, cuánto tiene además la cuenta contable real puesta (antes de esas 4 reglas: 0%).
  const movimientosConAsientoReal = new Set(renglones.map((r) => r.movimiento_id));
  const propuestaConCuenta = crudas.filter((f) => f.clase === 'propuesta' && movimientosConAsientoReal.has(f.movimiento_id)).length;

  const lineas = [
    `${cliente.nombre} — ${MESES_INCLUIDOS}`,
    '',
    `Total de movimientos bancarios: ${total}` +
      (cantidadFciExcluida > 0
        ? ` (no incluye ${cantidadFciExcluida} movimientos de Fondos Comunes de Inversión — FCI queda fuera de alcance de este envío, ver instructivo).`
        : '.'),
    `Identificados automáticamente (clase 'propuesta'): ${propuesta} de ${total} (${pct(propuesta, total)}) del total de movimientos.`,
    `De esos ${propuesta}, ${propuestaConCuenta} (${pct(propuestaConCuenta, propuesta)}) ya tienen la cuenta contable real asignada (antes de esta corrección: 0%). Son dos medidas distintas — la primera es qué fracción del total el sistema identifica solo; la segunda es, de eso ya identificado, cuánto tiene además la cuenta puesta. Detalle en "Acumulado".`,
    `Piden una decisión tuya: ${decidir} (${pct(decidir, total)}) — agrupados en ${cantidadGruposDecidir} decisiones, ver hoja "Grupos"`,
    ...(cliente.incluyeTarjeta
      ? [`Cobros con tarjeta identificados aparte: ${tarjeta} (${pct(tarjeta, total)}) — ${cantidadGruposTarjeta} grupos, ver hoja "Tarjeta pendiente"`]
      : []),
    '',
    'Qué encontrás en cada hoja:',
    '— "Grupos": todos los movimientos agrupados por banco + concepto — una decisión tuya cubre todo el grupo. Incluye la cuenta contable real cuando ya está asignada; en los grupos ya resueltos solos, las columnas de tu decisión aparecen en gris con "— no aplica —".',
    '— "Ejemplos de asiento real": el asiento real, formato libro diario, para cada tipo de movimiento que el sistema ya arma solo — para que veas el criterio, no para que lo apruebes.',
    '— "Acumulado (no es balance)": totales del período, en tres bloques — por cuenta bancaria, por tipo de movimiento, y por cuenta contable real (Capa D).',
    '',
    'Este archivo es de ida: lo que completes en "Grupos" (cuenta elegida, comentario) NO se carga ' +
      'solo al sistema — el sistema nunca vuelve a leer este archivo automáticamente. Avisanos y lo ' +
      'cargamos nosotros con tu respuesta.',
  ];
  lineas.forEach((linea, i) => {
    const celda = hoja.getCell(i + 1, 1);
    celda.value = linea;
    if (i === 0) celda.font = { bold: true, size: 13 };
    hoja.mergeCells(i + 1, 1, i + 1, 6);
    hoja.getRow(i + 1).alignment = { wrapText: true };
  });
  hoja.getColumn(1).width = 90;
}

// -----------------------------------------------------------------------------
// Hoja "Acumulado bancario (no es balance)" — TRES bloques (punto 6), nunca fusionados
// (contador-dominio). Salvedad corregida (punto 4).
// -----------------------------------------------------------------------------

type Totales = { cantidad: number; debito: number; credito: number };
function vacios(): Totales {
  return { cantidad: 0, debito: 0, credito: 0 };
}
function sumar(t: Totales, importeCanonico: string): void {
  const n = importeCanonicoANumeroExcel(importeCanonico) ?? 0;
  t.cantidad += 1;
  if (n < 0) t.debito += -n;
  else t.credito += n;
}

const CLASES = ['propuesta', 'decision_humana', 'sin_reconocer'] as const;
const ETIQUETA_CLASE: Record<(typeof CLASES)[number], string> = {
  propuesta: 'Propuesta',
  decision_humana: 'Decisión humana',
  sin_reconocer: 'Sin reconocer',
};

const ARGB_ALERTA = 'FFF4CCCC';
// Mismos ARGB que la leyenda de color (`escribirLeyendaColor` en armar-libro.ts) — antes esta hoja
// pintaba TODOS los encabezados de un gris (`FF808080`) que ni siquiera coincidía con el de la
// leyenda, y sin distinguir origen real (JP, corrección de fondo 2026-09-10, punto 2).
const ARGB_EXTRACTO = 'FFE7E6E6';
const ARGB_SISTEMA = 'FF5B9BD5';
const BORDE: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
};
const FMT_CANTIDAD = '#,##0';

function encabezado(hoja: ExcelJS.Worksheet, filaIdx: number, textos: readonly string[], origenes: readonly string[]): void {
  textos.forEach((h, i) => {
    const celda = hoja.getCell(filaIdx, i + 1);
    celda.value = h;
    celda.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: origenes[i] ?? ARGB_SISTEMA } };
    celda.border = BORDE;
    celda.alignment = { vertical: 'middle', wrapText: true };
  });
}

function formatearMoneda(n: number): string {
  return `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Bloque C candidato: por cuenta contable real, YA SIN el bucket "sin cuenta asignada" — ese pasa a
 *  ser un callout destacado antes de la tabla (punto 4), no una fila más entre las demás. */
type FilaBloqueC = { readonly etiqueta: string; readonly cantidad: number; readonly debe: number; readonly haber: number };
type PendienteBloqueC = { readonly cantidad: number; readonly totalPropuesta: number; readonly debito: number; readonly credito: number };

function calcularBloqueC(
  renglones: readonly RenglonReal[],
  crudas: readonly FilaCruda[],
): { filas: readonly FilaBloqueC[]; sumaDebe: number; sumaHaber: number; pendiente: PendienteBloqueC } {
  const porCuenta = new Map<string, { denominacion: string; cantidad: number; debe: number; haber: number }>();
  for (const r of renglones) {
    if (r.codigo === null || r.denominacion === null) continue;
    const entry = porCuenta.get(r.codigo) ?? { denominacion: r.denominacion, cantidad: 0, debe: 0, haber: 0 };
    entry.cantidad += 1;
    entry.debe += Number(r.debe);
    entry.haber += Number(r.haber);
    porCuenta.set(r.codigo, entry);
  }
  const filas: FilaBloqueC[] = [...porCuenta.entries()]
    .sort((a, b) => b[1].cantidad - a[1].cantidad)
    .map(([codigo, e]) => ({ etiqueta: `${codigo} · ${e.denominacion}`, cantidad: e.cantidad, debe: e.debe, haber: e.haber }));

  // Mismo denominador EXACTO que `textoMapeoTipoACuenta` (movimientos clase='propuesta' del
  // período) — el % de este callout es el complemento exacto del ya explicado ahí, nunca un cuarto
  // cálculo independiente.
  const totalPropuesta = crudas.filter((f) => f.clase === 'propuesta').length;
  const movimientosConAsiento = new Set(renglones.map((r) => r.movimiento_id));
  const sinCuenta = crudas.filter((f) => f.clase === 'propuesta' && !movimientosConAsiento.has(f.movimiento_id));
  let debitoSinCuenta = 0;
  let creditoSinCuenta = 0;
  for (const f of sinCuenta) {
    const n = importeCanonicoANumeroExcel(f.importe) ?? 0;
    if (n < 0) debitoSinCuenta += -n;
    else creditoSinCuenta += n;
  }

  const sumaDebe = filas.reduce((acc, f) => acc + f.debe, 0);
  const sumaHaber = filas.reduce((acc, f) => acc + f.haber, 0);
  return {
    filas,
    sumaDebe,
    sumaHaber,
    pendiente: { cantidad: sinCuenta.length, totalPropuesta, debito: debitoSinCuenta, credito: creditoSinCuenta },
  };
}

/** Texto de tipos con/sin cuenta real, para la salvedad corregida (punto 4) — nunca hardcodeado: se
 *  arma a partir de los mismos datos que ya se midieron. */
function textoMapeoTipoACuenta(crudas: readonly FilaCruda[], renglones: readonly RenglonReal[]): string {
  const propuesta = crudas.filter((f) => f.clase === 'propuesta');
  const conAsiento = new Set(renglones.map((r) => r.movimiento_id));
  const tiposConCuenta = new Map<string, number>();
  const tiposSinCuenta = new Map<string, number>();
  for (const f of propuesta) {
    const tipo = f.tipo ?? '(sin tipo)';
    const destino = conAsiento.has(f.movimiento_id) ? tiposConCuenta : tiposSinCuenta;
    destino.set(tipo, (destino.get(tipo) ?? 0) + 1);
  }
  const listar = (m: Map<string, number>): string =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tipo, n]) => `${identificacionDe('propuesta', tipo)} (${n})`)
      .join(', ');
  const total = propuesta.length;
  const totalCon = [...tiposConCuenta.values()].reduce((a, b) => a + b, 0);
  const pct = total > 0 ? ((totalCon / total) * 100).toFixed(1) : '0.0';
  return (
    `El sistema SÍ tiene un mapeo real de tipo de movimiento a cuenta contable y lo aplica ` +
    `automáticamente: ${totalCon} de ${total} (${pct}%) ya tienen cuenta asignada — ` +
    `${listar(tiposConCuenta)}. Ese ${pct}% es sobre el total de movimientos clasificados ` +
    `automáticamente (clase "propuesta") del período, NO sobre el total de movimientos del cliente ` +
    `(ver "Resumen ejecutivo" para ese otro número). Lo que todavía falta es la regla puntual para el ` +
    `resto: ${listar(tiposSinCuenta)} — esos movimientos siguen pendientes de asignación de cuenta ` +
    `(columna "Sin cuenta asignada — pendiente", nunca una cuenta inventada) hasta que se cargue esa regla.`
  );
}

function armarHojaAcumulado(
  libro: ExcelJS.Workbook,
  crudas: readonly FilaCruda[],
  renglones: readonly RenglonReal[],
  cabeceras: ReadonlyMap<string, CabeceraLigera>,
): { sumaDebe: number; sumaHaber: number } {
  // "Acumulado bancario (no es balance)" mide 34 caracteres — Excel corta a 31 y lo trunca en
  // silencio (encontrado corriendo el script real, no en el diseño). Nombre corto, mismo mensaje.
  const hoja = libro.addWorksheet('Acumulado (no es balance)');

  const salvedad = [
    '⚠️ Esto NO es un estado contable ni un cierre de ejercicio — es un acumulado de movimientos bancarios.',
    '',
    `— Cubre exclusivamente los movimientos que pasaron por las cuentas bancarias del cliente entre el ${DESDE} y el ${HASTA} (${MESES_INCLUIDOS}). No incluye ningún asiento que no se origine en un movimiento bancario: ajustes de cierre, devengamientos, previsiones, amortizaciones, diferencias de cambio no bancarias, ni ajuste por inflación cuando corresponda — ninguno de estos está contemplado acá.`,
    '— El Bloque A ("por cuenta bancaria") es la cuenta bancaria real (banco, alias, moneda): es información de caja/bancos. El Bloque B ("por tipo de movimiento") es la clasificación operativa que hace el sistema a partir del texto o código que publica el banco — todavía no es la cuenta contable.',
    textoMapeoTipoACuenta(crudas, renglones),
    '— El Bloque C es el único de los tres en cuenta contable REAL (código y denominación del plan de cuentas), tomado de los asientos que Capa D ya generó — incluye, sin ocultarla, la fila de lo que todavía no tiene cuenta asignada.',
    '— Los importes no netean IVA ni ningún otro impuesto que pueda estar incluido en el movimiento bancario.',
    '— Cada cifra de los Bloques A y B corresponde a movimientos con distinto grado de certeza (columna "Clase"): "propuesta" (identificado por el sistema), "decisión humana" (requirió y tuvo intervención de la contadora) y "sin reconocer" (todavía sin clasificar). Se muestran siempre desagregadas — un total que las mezclara sería engañoso.',
    '— Este acumulado no reemplaza el Estado de Situación Patrimonial ni el Estado de Resultados del ente, y no está preparado según ninguna Resolución Técnica de exposición.',
  ];
  hoja.getColumn(1).width = 40;
  for (let i = 2; i <= 9; i += 1) hoja.getColumn(i).width = 20;
  const ANCHO_MERGE_APROX_CHARS = 180;

  salvedad.forEach((linea, i) => {
    const celda = hoja.getCell(i + 1, 1);
    celda.value = linea;
    // Negrita solo la primera línea (el título de alerta) — antes también la última, que era el
    // descargo "Validar con profesional matriculado" (sacado, JP 2026-09-11: redundante y fuera de
    // lugar dirigido a la propia contadora matriculada). La última línea real hoy ("Este acumulado
    // no reemplaza...") no tiene ese mismo peso, no le corresponde negrita.
    if (i === 0) celda.font = { bold: true };
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB_ALERTA } };
    celda.alignment = { wrapText: true, vertical: 'middle' };
    hoja.mergeCells(i + 1, 1, i + 1, 9);
    const lineasEnvueltas = Math.max(1, Math.ceil(linea.length / ANCHO_MERGE_APROX_CHARS));
    hoja.getRow(i + 1).height = linea.length === 0 ? 10 : lineasEnvueltas * 18 + 6;
  });

  let fila = salvedad.length + 3;
  // Leyenda de color (punto 2) — antes del primer bloque, para toda la hoja.
  const swatch = (col: number, argb: string, texto: string): void => {
    hoja.getCell(fila, col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    hoja.getCell(fila, col).border = BORDE;
    hoja.getCell(fila, col + 1).value = texto;
    hoja.getCell(fila, col + 1).font = { italic: true, size: 9 };
  };
  swatch(1, 'FFE7E6E6', 'Dato del extracto bancario');
  swatch(4, 'FF5B9BD5', 'Calculado por el sistema');
  fila += 2;

  // Bloque A — por cuenta bancaria real.
  hoja.getCell(fila, 1).value = 'Bloque A — Acumulado por cuenta bancaria';
  hoja.getRow(fila).font = { bold: true };
  fila += 1;

  const porCuenta = new Map<string, Record<(typeof CLASES)[number], Totales>>();
  for (const f of crudas) {
    const entry = porCuenta.get(f.cuenta_bancaria_id) ?? { propuesta: vacios(), decision_humana: vacios(), sin_reconocer: vacios() };
    const clase = (CLASES as readonly string[]).includes(f.clase) ? (f.clase as (typeof CLASES)[number]) : 'sin_reconocer';
    sumar(entry[clase], f.importe);
    porCuenta.set(f.cuenta_bancaria_id, entry);
  }
  // "Cuenta bancaria (extracto)", no "Cuenta" a secas — para que no se confunda con "Cuenta contable
  // asignada" de la hoja Grupos (JP, punto 1): es la cuenta REAL del extracto, agrupa por banco, no
  // es ni pretende ser una cuenta contable (una misma cuenta bancaria mezcla todo tipo de movimiento).
  const encabezadosA = ['Cuenta bancaria (extracto)', ...CLASES.flatMap((c) => [`${ETIQUETA_CLASE[c]} — cant.`, `${ETIQUETA_CLASE[c]} — débito`, `${ETIQUETA_CLASE[c]} — crédito`])];
  // La cuenta es dato del extracto; las 9 columnas de cantidad/débito/crédito por clase son
  // AGREGADOS calculados por el sistema, aunque deriven en última instancia del importe del extracto.
  encabezado(hoja, fila, encabezadosA, [ARGB_EXTRACTO, ...Array(9).fill(ARGB_SISTEMA)]);
  fila += 1;
  const filaComienzoDatosA = fila;
  let indiceFila = 0;
  for (const [cuentaId, porClase] of porCuenta) {
    const cab = cabeceras.get(cuentaId);
    const etiqueta = cab ? `${cab.bancoCodigo} · ${cab.alias ?? '(sin alias)'} · ${cab.moneda}` : '(cuenta desconocida)';
    const valores: ExcelJS.CellValue[] = [etiqueta, ...CLASES.flatMap((c) => [porClase[c].cantidad, porClase[c].debito, porClase[c].credito])];
    valores.forEach((v, i) => {
      const celda = hoja.getCell(fila, i + 1);
      celda.value = v;
      celda.border = BORDE;
      if (i > 0 && (i - 1) % 3 !== 0) celda.numFmt = FMT_MONEDA_CON_SIGNO;
      else if (i > 0) celda.numFmt = FMT_CANTIDAD;
      if (indiceFila % 2 === 1) celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } };
    });
    fila += 1;
    indiceFila += 1;
  }
  const filaFinDatosA = fila - 1;
  fila += 1;

  // Bloque B — por tipo de movimiento (proxy, nunca fusionado con el Bloque A ni el C).
  hoja.getCell(fila, 1).value = 'Bloque B — Acumulado por tipo de movimiento (clasificación del sistema, no es cuenta contable)';
  hoja.getRow(fila).font = { bold: true };
  fila += 1;
  const encabezadosB = ['Tipo de movimiento', 'Cantidad', 'Total débito', 'Total crédito', 'Cuenta(s) bancaria(s)', 'Clase predominante'];
  // "Cuenta(s) bancaria(s)" es dato real del extracto (qué cuenta tocó); el resto — INCLUIDA "Clase
  // predominante", mal coloreada como extracto hasta esta corrección (JP, punto 2) — es calculado.
  encabezado(hoja, fila, encabezadosB, [ARGB_SISTEMA, ARGB_SISTEMA, ARGB_SISTEMA, ARGB_SISTEMA, ARGB_EXTRACTO, ARGB_SISTEMA]);
  fila += 1;

  type EntradaTipo = { totales: Totales; cuentas: Set<string>; clases: Map<string, number> };
  const porTipo = new Map<string, EntradaTipo>();
  for (const f of crudas) {
    const clave = identificacionDe(f.clase, f.tipo);
    const entry = porTipo.get(clave) ?? { totales: vacios(), cuentas: new Set<string>(), clases: new Map<string, number>() };
    sumar(entry.totales, f.importe);
    entry.cuentas.add(f.cuenta_bancaria_id);
    entry.clases.set(f.clase, (entry.clases.get(f.clase) ?? 0) + 1);
    porTipo.set(clave, entry);
  }
  const filasTipo = [...porTipo.entries()].sort((a, b) => b[1].totales.cantidad - a[1].totales.cantidad);
  indiceFila = 0;
  for (const [tipoTexto, entry] of filasTipo) {
    const clasePredominante = [...entry.clases.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const etiquetasCuenta = [...entry.cuentas].map((id) => {
      const cab = cabeceras.get(id);
      return cab ? `${cab.bancoCodigo} · ${cab.alias ?? '(sin alias)'}` : id;
    });
    const cuentaTexto = etiquetasCuenta.length > 1 ? 'Varias' : (etiquetasCuenta[0] ?? '');
    const valores: ExcelJS.CellValue[] = [
      tipoTexto,
      entry.totales.cantidad,
      entry.totales.debito,
      entry.totales.credito,
      cuentaTexto,
      clasePredominante in ETIQUETA_CLASE ? ETIQUETA_CLASE[clasePredominante as (typeof CLASES)[number]] : clasePredominante,
    ];
    const formatos: (string | undefined)[] = [undefined, FMT_CANTIDAD, FMT_MONEDA_CON_SIGNO, FMT_MONEDA_CON_SIGNO, undefined, undefined];
    valores.forEach((v, i) => {
      const celda = hoja.getCell(fila, i + 1);
      celda.value = v;
      celda.border = BORDE;
      if (formatos[i]) celda.numFmt = formatos[i]!;
      if (indiceFila % 2 === 1) celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } };
    });
    fila += 1;
    indiceFila += 1;
  }
  fila += 1;

  // Bloque C — por cuenta contable REAL (punto 6).
  hoja.getCell(fila, 1).value = 'Bloque C — Acumulado por cuenta contable real (Capa D)';
  hoja.getRow(fila).font = { bold: true };
  fila += 1;

  const { filas: filasC, sumaDebe, sumaHaber, pendiente } = calcularBloqueC(renglones, crudas);

  // Callout destacado ANTES de la tabla (punto 4) — el bucket "sin cuenta asignada" ya NO es una fila
  // más entre las demás: mismo denominador exacto que la salvedad (`textoMapeoTipoACuenta`), % nunca
  // recalculado con otro criterio.
  const pctPendiente = pendiente.totalPropuesta > 0 ? ((pendiente.cantidad / pendiente.totalPropuesta) * 100).toFixed(1) : '0.0';
  const celdaCallout = hoja.getCell(fila, 1);
  celdaCallout.value =
    `⚠️ ${pendiente.cantidad} de ${pendiente.totalPropuesta} movimientos automáticos (${pctPendiente}%) todavía no tiene cuenta asignada — ` +
    `${formatearMoneda(pendiente.debito)} débito / ${formatearMoneda(pendiente.credito)} crédito (importe del extracto, no debe/haber contable). ` +
    `Detalle por tipo en la salvedad de este bloque, más arriba.`;
  celdaCallout.font = { bold: true };
  celdaCallout.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB_ALERTA } };
  celdaCallout.alignment = { wrapText: true };
  hoja.mergeCells(fila, 1, fila, 4);
  hoja.getRow(fila).height = 32;
  fila += 2;

  // Banner visible ANTES de la tabla (punto 3) — la nota al pie que ya existía quedaba después de la
  // tabla, insuficiente (JP: "más visible, antes de la tabla, no solo después").
  const celdaBanner = hoja.getCell(fila, 1);
  celdaBanner.value =
    'Este bloque cuenta RENGLONES de asiento, no movimientos — un mismo movimiento aparece en 2 ' +
    'cuentas distintas (debe y haber), por eso los totales no coinciden con el Bloque B.';
  celdaBanner.font = { italic: true, bold: true };
  hoja.mergeCells(fila, 1, fila, 4);
  fila += 1;

  const encabezadosC = ['Cuenta contable', 'Cantidad de renglones', 'Total débito', 'Total crédito'];
  encabezado(hoja, fila, encabezadosC, Array(4).fill(ARGB_SISTEMA));
  fila += 1;
  indiceFila = 0;
  for (const f of filasC) {
    const valores: ExcelJS.CellValue[] = [f.etiqueta, f.cantidad, f.debe, f.haber];
    valores.forEach((v, i) => {
      const celda = hoja.getCell(fila, i + 1);
      celda.value = v;
      celda.border = BORDE;
      if (i === 1) celda.numFmt = FMT_CANTIDAD;
      if (i >= 2) celda.numFmt = FMT_MONEDA_CON_SIGNO;
      if (indiceFila % 2 === 1) celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } };
    });
    fila += 1;
    indiceFila += 1;
  }
  hoja.getCell(fila, 1).value = 'Cantidad de renglones ≠ cantidad de movimientos: una misma cuenta puede recibir débito y crédito en movimientos distintos.';
  hoja.getCell(fila, 1).font = { italic: true, size: 9 };
  hoja.mergeCells(fila, 1, fila, 4);

  hoja.getColumn(10).width = 20;
  hoja.autoFilter = { from: { row: filaComienzoDatosA - 1, column: 1 }, to: { row: filaFinDatosA, column: encabezadosA.length } };

  return { sumaDebe, sumaHaber };
}

// -----------------------------------------------------------------------------
// "Ejemplos de asiento real" (punto 5) — homogeneidad por tipo, normalizando la pata bancaria (JP,
// ajuste 2026-09-10): la variación de CUÁL cuenta bancaria del cliente originó el movimiento no es
// una variante de tratamiento, es trivial y esperable. Solo se muestran 2 ejemplos cuando la pata NO
// bancaria realmente cambia.
// -----------------------------------------------------------------------------

function armarBloquesDeEjemplo(renglones: readonly RenglonReal[], porMovimiento: RenglonesPorMovimiento): readonly BloqueDeEjemplo[] {
  // 1) Agrupar movimientos por tipo, y dentro de cada tipo por la firma de su(s) pata(s) NO bancaria(s).
  type Movimiento = { readonly movimiento_id: string; readonly fecha: string; readonly descripcion: string; readonly cuentaBancariaCodigo: string | null };
  const porTipo = new Map<string, Map<string, Movimiento[]>>();
  const yaVisto = new Set<string>();
  for (const r of renglones) {
    if (yaVisto.has(r.movimiento_id)) continue;
    yaVisto.add(r.movimiento_id);
    const todos = porMovimiento.get(r.movimiento_id) ?? [];
    const noBancarias = todos.filter((x) => x.codigo !== null && x.denominacion !== null && !esCuentaBancariaPorDenominacion(x.denominacion));
    const bancaria = todos.find((x) => x.codigo !== null && x.denominacion !== null && esCuentaBancariaPorDenominacion(x.denominacion));
    const firma = noBancarias.length > 0 ? [...new Set(noBancarias.map((x) => x.codigo))].sort().join('+') : 'sin_pata_no_bancaria';
    const porFirma = porTipo.get(r.tipo) ?? new Map<string, Movimiento[]>();
    const lista = porFirma.get(firma) ?? [];
    lista.push({ movimiento_id: r.movimiento_id, fecha: r.fecha, descripcion: r.descripcion, cuentaBancariaCodigo: bancaria?.codigo ?? null });
    porFirma.set(firma, lista);
    porTipo.set(r.tipo, porFirma);
  }

  const bloques: BloqueDeEjemplo[] = [];
  for (const [tipo, porFirma] of porTipo) {
    const firmas = [...porFirma.entries()].sort((a, b) => b[1].length - a[1].length);
    const homogeneo = firmas.length === 1;
    for (const [, movimientos] of firmas) {
      // Ejemplo real de esta variante: el más reciente (determinístico).
      const [ejemplo] = [...movimientos].sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
      if (!ejemplo) continue;
      const renglonesDelEjemplo = porMovimiento.get(ejemplo.movimiento_id) ?? [];
      const renglonesOrdenados: RenglonDeEjemplo[] = renglonesDelEjemplo
        .filter((r) => r.codigo !== null && r.denominacion !== null)
        .map((r) => ({ cuentaCodigo: r.codigo!, cuentaDenominacion: r.denominacion!, debe: Number(r.debe), haber: Number(r.haber) }));

      let notaVariante: string | null = null;
      if (!homogeneo) {
        // ¿Correlaciona con el banco de origen?
        const bancosDeLaFirma = new Set(movimientos.map((m) => m.cuentaBancariaCodigo));
        const bancosDeOtrasFirmas = new Set(
          firmas.filter(([f]) => f !== [...porFirma.entries()].find(([, v]) => v === movimientos)?.[0]).flatMap(([, ms]) => ms.map((m) => m.cuentaBancariaCodigo)),
        );
        const soloEnEstaFirma = [...bancosDeLaFirma].every((b) => !bancosDeOtrasFirmas.has(b));
        notaVariante = soloEnEstaFirma
          ? 'según el banco de origen del movimiento'
          : 'este tipo tiene más de una cuenta posible según el caso';
      }

      bloques.push({
        tipoTexto: identificacionDe('propuesta', tipo),
        cantidadEnVariante: movimientos.length,
        fecha: ejemplo.fecha,
        descripcionBanco: ejemplo.descripcion,
        renglones: renglonesOrdenados,
        notaVariante,
      });
    }
  }
  // Orden: por tipo (cantidad total desc), variantes del mismo tipo juntas.
  const totalPorTipo = new Map<string, number>();
  for (const b of bloques) totalPorTipo.set(b.tipoTexto, (totalPorTipo.get(b.tipoTexto) ?? 0) + b.cantidadEnVariante);
  return bloques.sort((a, b) => {
    const dt = (totalPorTipo.get(b.tipoTexto) ?? 0) - (totalPorTipo.get(a.tipoTexto) ?? 0);
    return dt !== 0 ? dt : b.cantidadEnVariante - a.cantidadEnVariante;
  });
}

// -----------------------------------------------------------------------------
// Armado del libro completo por cliente.
// -----------------------------------------------------------------------------

async function armarLibroCliente(cliente: ClienteCfg, resultado: Extract<ResultadoLectura, { estado: 'ok' }>): Promise<Uint8Array> {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'sistema-contable';
  libro.lastModifiedBy = 'sistema-contable';
  libro.created = new Date();

  const cabecerasPorCuenta = new Map(
    [...resultado.cabeceras.entries()].map(([id, c]) => [id, { cuentaBancariaId: id, bancoCodigo: c.bancoCodigo, cuentaAlias: c.alias, moneda: c.moneda, tipoCuenta: null, cbuUltimos4: null, periodoDesde: DESDE, periodoHasta: HASTA, saldoInicialDeclarado: null, saldoFinalDeclarado: null, totalCreditosDeclarado: null, totalDebitosDeclarado: null, saldoFinalCalculado: null, totalCreditosCalculado: null, totalDebitosCalculado: null, filasLeidas: 0, filasAceptadas: 0, verificacionEstado: 'no_verificable' }] as const),
  );

  const renglonesPorMovimiento = agruparRenglonesPorMovimiento(resultado.renglones);
  const contrapartesPorMovimiento = new Map(resultado.contrapartes.map((c) => [c.movimiento_id, c] as const));
  const filasPlanilla = resultado.crudas.map((f) => comoFilaPlanilla(f, renglonesPorMovimiento, contrapartesPorMovimiento));
  const grupos = agruparFilas(filasPlanilla, cabecerasPorCuenta);
  const gruposTarjeta = grupos.filter((g) => g.categoriaEspecial === 'tarjeta_pendiente');
  const gruposNormales = grupos.filter((g) => g.categoriaEspecial !== 'tarjeta_pendiente');

  // Cantidad de grupos que ALGO piden a Laura — mismo cálculo EXACTO que arma la hoja "Grupos"
  // (`g.requiereRevision`), nunca un tercer conteo independiente. La primera versión de este número
  // agrupaba por (banco, concepto) a mano, sin pasar por `agruparFilas` — y eso SUBCONTABA: un
  // movimiento `distinguir_tercero_de_socio` nunca se agrupa con otro (`agrupable: false`, ver la
  // nota de `FilaPlanilla`), así que cada uno es su PROPIA fila en "Grupos" — la cuenta manual los
  // excluía por completo. Hallazgo real, corrida contra el piloto (2026-09-11): ROKA mostraba "15
  // decisiones" en el Resumen mientras la hoja "Grupos" tenía 25 filas pidiendo revisión — 10
  // movimientos singulares de este tipo, sin contar. Bracci no lo mostró (0 singulares en el
  // período), por eso el bug pasó una corrida entera sin notarse.
  const cantidadGruposDecidir = gruposNormales.filter((g) => g.requiereRevision).length;

  armarHojaResumen(libro, cliente, resultado.crudas, resultado.renglones, cantidadGruposDecidir, gruposTarjeta.length, resultado.cantidadFciExcluida);
  if (gruposNormales.length > 0) {
    // Hoja oculta del plan de cuentas real — SIEMPRE se arma (aunque venga vacía: el desplegable
    // queda sin opciones, nunca un archivo corrupto por un nombre definido con rango inválido — ver
    // `armarHojaPlanDeCuentasOculta`). Nombre único por cliente: los dos archivos son siempre
    // separados (INV-5), pero el nombre definido vive a nivel de LIBRO — mismo criterio defensivo
    // aunque hoy nunca compartan `Workbook`.
    const nombreDefinidoPlanDeCuentas = armarHojaPlanDeCuentasOculta(
      libro,
      'Plan de cuentas (no editar)',
      `PlanDeCuentas_${cliente.nombre}`,
      resultado.cuentasDelPlan,
    );
    armarHojaGrupos(
      libro,
      'Grupos',
      `Grupos por banco + concepto · ${cliente.nombre} · ${MESES_INCLUIDOS}. Los grupos en gris en ` +
        '"¿A qué cuenta contable va?"/"Comentario libre" ya los resolvió el sistema solo — no ' +
        'necesitan tu revisión. Los que están en blanco con desplegable son los que sí te pido que ' +
        'mires.',
      gruposNormales,
      undefined,
      COLUMNAS_GRUPOS_EXTENDIDO,
      nombreDefinidoPlanDeCuentas,
    );
  }
  const bloquesDeEjemplo = armarBloquesDeEjemplo(resultado.renglones, renglonesPorMovimiento);
  if (bloquesDeEjemplo.length > 0) {
    armarHojaEjemplosDeAsiento(libro, `Ejemplos de asiento real · ${cliente.nombre} · ${MESES_INCLUIDOS}`, bloquesDeEjemplo);
  }
  if (cliente.incluyeTarjeta && gruposTarjeta.length > 0) {
    armarHojaGrupos(
      libro,
      'Tarjeta pendiente',
      'Cobros con tarjeta de crédito (Visa/Mastercard, vía Prisma/First Data) — el ajuste de comisión/IVA/retenciones se resuelve con tu Libro IVA Compras, no con una liquidación bancaria. No hace falta que revises estos grupos todavía.',
      gruposTarjeta,
      'FFCFC1E8',
    );
  }
  const { sumaDebe, sumaHaber } = armarHojaAcumulado(libro, resultado.crudas, resultado.renglones, resultado.cabeceras);

  // Punto 8 — chequeo cruzado mecanizado: Σdebe = Σhaber del Bloque C. Cada asiento balancea por
  // construcción (Capa D); si la suma agregada no cierra, algo se rompió entre la lectura y acá —
  // nunca se serializa un archivo con una cuenta que no cuadra.
  //
  // Nunca los totales (Σdebe/Σhaber) a consola — son un agregado de UN SOLO cliente, no cumplen el
  // umbral de agregación segura de ADR-0002 §A.2.3 (k≥20, ≥5 clientes). Solo la diferencia, que en el
  // caso sano es 0 (`seguridad-datos-financieros` H-2, `security-engineer` Hallazgo B).
  const diferencia = Math.round((sumaDebe - sumaHaber) * 100) / 100;
  log.info('paquete_final.bloque_c_verificado', { cliente_id: cliente.id, diferencia_bloque_c: diferencia });
  if (diferencia !== 0) {
    throw new Error(`${cliente.nombre}: Bloque C no cuadra (diferencia ${diferencia.toFixed(2)}) — ver logs.`);
  }

  return serializarLibro(libro);
}

// -----------------------------------------------------------------------------
// Reserva atómica de archivo — dos `wx`, aislados por cliente.
// -----------------------------------------------------------------------------

type EscritorReservado = { readonly fd: number; readonly destino: string };

function reservar(destino: string): EscritorReservado {
  return { fd: openSync(destino, 'wx', 0o600), destino };
}
function limpiar(r: EscritorReservado): void {
  try {
    closeSync(r.fd);
  } catch {
    /* ya puede estar cerrado */
  }
  try {
    unlinkSync(r.destino);
  } catch {
    /* si ya no está, no hay nada que limpiar */
  }
}
function escribirArchivo(r: EscritorReservado, datos: Uint8Array): void {
  try {
    const n = writeSync(r.fd, datos);
    if (n !== datos.byteLength) throw new Error(`escritura incompleta: ${n} de ${datos.byteLength} bytes`);
  } finally {
    closeSync(r.fd);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const usuarioId = argv[argv.indexOf('--usuario') + 1];
  const carpetaSalida = argv[argv.indexOf('--salida') + 1];
  if (!usuarioId || !carpetaSalida) throw new Error('Uso: --usuario <uuid> --salida <carpeta>');

  await verificarCredencialDeRequest();

  const reservas = new Map<string, EscritorReservado>();
  try {
    for (const c of CLIENTES) {
      const destino = join(carpetaSalida, `paquete-final-${c.nombre.toLowerCase()}-2026-05-a-08.xlsx`);
      reservas.set(c.nombre, reservar(destino));
    }
  } catch (error) {
    for (const r of reservas.values()) limpiar(r);
    throw error;
  }

  for (const cliente of CLIENTES) {
    const reserva = reservas.get(cliente.nombre)!;
    try {
      const puede = await conUsuario(usuarioId, (tx) => tieneRolSuficiente(tx, cliente.id));
      if (!puede) {
        log.error('paquete_final.rol_insuficiente', { cliente_id: cliente.id });
        limpiar(reserva);
        continue;
      }

      const resultado = await conUsuario(usuarioId, (tx) => leerCliente(tx, cliente.id));
      if (resultado.estado === 'abortado') {
        log.error('paquete_final.abortado', { cliente_id: cliente.id });
        limpiar(reserva);
        continue;
      }

      // Nunca las cantidades crudas (movimientos/renglones/contrapartes/lotes) a consola — mismo
      // motivo que la diferencia del Bloque C: agregado de UN SOLO cliente
      // (`seguridad-datos-financieros` H-2, `security-engineer` Hallazgo B). El destino sí se
      // imprime: es una ruta local que eligió el propio operador, no un dato del cliente.
      const buffer = await armarLibroCliente(cliente, resultado);
      escribirArchivo(reserva, buffer);
      log.info('paquete_final.ok', { cliente_id: cliente.id });
      process.stdout.write(`${cliente.nombre}: OK — ${reserva.destino}\n`);
    } catch (error) {
      limpiar(reserva);
      throw error;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error('paquete_final.error_fatal', { causa_tipo: causaTipo(error) });
    process.exit(1);
  });
