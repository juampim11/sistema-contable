/**
 * AGRUPAR DECISIONES PENDIENTES — versión general, parametrizada por `{clienteId, desde, hasta}`, del
 * mecanismo que nació puntual en `packages/ingesta/scripts/paquete-cierre-bracci-roka-2026-05-a-08.ts`
 * (Frente 1, plan aprobado tras convocatoria real de `dba-data` + `backend-dev` +
 * `seguridad-datos-financieros` + `security-engineer` + `arquitecto-software`).
 *
 * Alcance angosto, a propósito:
 * - SOLO agrupación + datos. Nunca arma un `.xlsx` — eso sigue siendo trabajo de `armar-libro.ts` y de
 *   su llamador; esta función es un productor de datos, el Excel es un consumidor aparte.
 * - `confirmacion_grupo` NO se lee acá — el pre-llenado de `cuentaContable` con la memoria de una
 *   confirmación anterior es una decisión de la capa que orquesta (hoy el CLI, si hiciera falta),
 *   nunca de esta función: mismo motivo por el que su lectura lleva SU PROPIA auditoría, separada de
 *   la de `movimiento_bancario_crudo`/`asiento_propuesto` de acá.
 * - `padron_contraparte`/contraparte real tampoco se lee: el contrato de salida (`GrupoDecisionPendiente`)
 *   no tiene un campo para eso — no hay motivo para traer del sistema un dato N2-R que no se va a usar.
 *
 * `tx: Tx` PRIMERO, siempre — nunca `usuarioId` suelto, nunca `conUsuario`/`conJob` adentro de este
 * archivo. El caller (hoy el CLI, mañana un handler de `apps/web` con `conSesion`) abre la transacción
 * y decide con qué credencial correr; esta función nunca abre la suya (CLAUDE.md §2.1).
 */

import { z } from 'zod';
import { registrarAcceso, type Tx } from '@sistema-contable/data';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { textoDeTipo, TEXTO_SIN_TIPO, type TipoMovimiento } from '@sistema-contable/contabilidad';
import {
  agruparFilas,
  claveDeAgrupacion,
  MAX_FILAS,
  type CabeceraCuenta,
  type FilaPlanilla,
} from '../planilla/armar-libro.ts';
import { ROLES_QUE_EXPORTAN } from '../planilla/exportar-planilla.ts';
import { centavosAImporte, importeCanonicoACentavos } from '../parseo-ar.ts';

type CamposAgruparDecisionesPendientes = 'cliente_id' | 'causa_tipo';
const log = loggerAcotado<CamposAgruparDecisionesPendientes>();

/** Nunca `error.message` crudo: puede interpolar una glosa o un importe real que estaba procesando.
 *  Mismo patrón que `paquete-cierre-bracci-roka-2026-05-a-08.ts::causaTipo`. */
function causaTipo(error: unknown): string {
  if (!(error instanceof Error)) return 'desconocido';
  const reducido = redactar(error) as { nombre?: string };
  return reducido.nombre ?? 'Error';
}

// -----------------------------------------------------------------------------
// Contrato de entrada/salida
// -----------------------------------------------------------------------------

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esquemaClienteId = z.string().regex(RE_UUID);

// 🔴 AGREGADO (code-reviewer, revisión de este PR): `desde`/`hasta` solo llevaban un comentario de
// forma, sin validación en la función — el CLI de hoy (`apps/cli/src/agrupar-decisiones-pendientes.ts`)
// sí valida, pero esta función es el límite REAL (`tx: Tx` primero, sin `conUsuario`/`conJob` adentro,
// pensada para que un futuro handler de `apps/web` la llame directo) — CLAUDE.md §2 exige validación de
// límites con Zod, y "el CLI ya valida" no cubre ese futuro caller. Sin esto, una fecha mal formada
// hacía subir una excepción cruda de Postgres sin `estado: 'abortado'` controlado, y `desde > hasta`
// devolvía `{estado:'ok', grupos:[]}` en silencio (el `between` de Postgres no falla, da 0 filas).
const RE_FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const esquemaPedido = z
  .object({
    clienteId: esquemaClienteId,
    desde: z.string().regex(RE_FECHA_ISO),
    hasta: z.string().regex(RE_FECHA_ISO),
  })
  .refine((p) => p.desde <= p.hasta, { message: 'desde tiene que ser <= hasta' });

export type PedidoAgruparDecisionesPendientes = {
  readonly clienteId: string;
  readonly desde: string; // 'YYYY-MM-DD'
  readonly hasta: string; // 'YYYY-MM-DD'
};

export type GrupoDecisionPendiente = {
  readonly clave: string;
  readonly bancoCodigo: string;
  readonly conceptoBanco: string | null;
  readonly cantidad: number;
  readonly totalDebito: string; // canónico, numeric-as-string — nunca number (CLAUDE.md §2)
  readonly totalCredito: string;
  readonly fechaDesde: string;
  readonly fechaHasta: string;
  readonly tipoDeMovimiento: string;
  readonly cuentaPropuesta: { readonly codigo: string; readonly denominacion: string } | null;
  readonly requiereRevision: boolean;
};

export type ResultadoAgruparDecisionesPendientes =
  | {
      readonly estado: 'ok';
      readonly clienteId: string;
      /** Resuelto SIEMPRE desde la base (`tenant_node.nombre`), nunca de un parámetro de texto libre —
       *  un typo en el uuid no puede producir una salida etiquetada con el nombre de otro cliente. */
      readonly clienteNombre: string;
      readonly desde: string;
      readonly hasta: string;
      readonly grupos: readonly GrupoDecisionPendiente[];
      readonly cantidadMovimientos: number;
    }
  | {
      readonly estado: 'abortado';
      readonly motivoCodigo:
        | 'rol_insuficiente'
        | 'demasiadas_filas'
        | 'cliente_id_invalido'
        /** `desde`/`hasta` sin forma YYYY-MM-DD, o `desde > hasta`. Agregado en la revisión de código
         *  de este PR — ver la nota junto a `esquemaPedido` más arriba. */
        | 'rango_invalido'
        /** Agregado sobre el contrato original: una falla de lectura DESPUÉS de que la auditoría de
         *  `movimiento_bancario_crudo` ya se insertó no puede relanzar (`conUsuario` haría rollback de
         *  TODA la transacción, incluida esa fila) — se despoisona con `rollback to savepoint` y se
         *  devuelve un estado controlado, mismo mecanismo que `leerCliente` en el script de origen. */
        | 'error_de_lectura';
    };

// -----------------------------------------------------------------------------
// Lectura cruda
// -----------------------------------------------------------------------------

type FilaCruda = {
  readonly movimiento_id: string;
  readonly cuenta_bancaria_id: string;
  readonly fila_numero: number;
  readonly fecha: string;
  readonly concepto_banco: string | null;
  readonly importe: string;
  readonly clase: string;
  readonly tipo: string | null;
  readonly que_decide: string | null;
};

type RenglonReal = {
  readonly movimiento_id: string;
  readonly codigo: string | null;
  readonly denominacion: string | null;
};

type CabeceraLigera = { readonly bancoCodigo: string; readonly moneda: string };

const SAVEPOINT_LECTURA = 'sp_agrupar_decisiones_pendientes';

async function tieneRolSuficiente(tx: Tx, clienteId: string): Promise<boolean> {
  const filas = await tx.consultar<{ puede: boolean }>(
    `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
    [clienteId, ROLES_QUE_EXPORTAN],
  );
  return filas[0]?.puede === true;
}

/** Cuenta bancaria del cliente (heurística por denominación) — DUPLICADA a propósito de
 *  `paquete-cierre-bracci-roka-2026-05-a-08.ts::esCuentaBancariaPorDenominacion`, mismo riesgo
 *  aceptado y declarado ahí: no hay un FK estructural de `cuenta` (contable) a `cuenta_bancaria`
 *  (extracto), así que un plan de cuentas que nombrara una cuenta bancaria distinto rompería esto en
 *  silencio. Deuda para cuando haya un enlace estructural real, no de esta tarea. */
function esCuentaBancariaPorDenominacion(denominacion: string): boolean {
  return /banco|cta\.?\s*cte|cuenta\s*especial|cuenta\s*corriente/i.test(denominacion);
}

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

/** La pata "real" (no bancaria) del asiento de un movimiento — DUPLICADA de
 *  `paquete-cierre-bracci-roka-2026-05-a-08.ts::cuentaContableDelMovimiento`, mismo criterio exacto.
 *  `null` si el movimiento no tiene asiento real todavía, o si por algún motivo el asiento fuera 100%
 *  de cuentas bancarias (no debería pasar en el corpus real). */
function cuentaContableDelMovimiento(
  renglonesDelMov: readonly RenglonReal[] | undefined,
): { codigo: string; denominacion: string } | null {
  if (!renglonesDelMov) return null;
  const noBancaria = renglonesDelMov.find(
    (r) => r.codigo !== null && r.denominacion !== null && !esCuentaBancariaPorDenominacion(r.denominacion),
  );
  if (!noBancaria || noBancaria.codigo === null || noBancaria.denominacion === null) return null;
  return { codigo: noBancaria.codigo, denominacion: noBancaria.denominacion };
}

/** Mismo criterio EXACTO que `exportar-planilla.ts::agrupableDe`/`identificacionDe` (vía la copia
 *  puntual del script de origen) — `false` SOLO para `distinguir_tercero_de_socio`: esa fila nunca se
 *  agrupa con otra aunque comparta `(bancoCodigo, conceptoBanco)`, porque dos contrapartes distintas
 *  pueden compartir el mismo texto genérico del banco (`seguridad-datos-financieros`, Tanda 1). */
function esAgrupable(clase: string, queDecide: string | null): boolean {
  return !(clase === 'decision_humana' && queDecide === 'distinguir_tercero_de_socio');
}

function identificacionDe(clase: string, tipo: string | null): string {
  if (clase === 'sin_reconocer' || tipo === null) return TEXTO_SIN_TIPO;
  return textoDeTipo(tipo as TipoMovimiento);
}

function comoFilaPlanilla(
  f: FilaCruda,
  renglonesPorMovimiento: RenglonesPorMovimiento,
  cabeceras: ReadonlyMap<string, CabeceraLigera>,
): FilaPlanilla {
  return {
    filaNumero: f.fila_numero,
    cuentaBancariaId: f.cuenta_bancaria_id,
    fecha: f.fecha,
    fechaValor: null,
    // Sin `descripcion` real — nunca se selecciona de la base acá: `agruparFilas`/`claveDeAgrupacion`
    // no la usan (verificado contra `armar-libro.ts`), y esta función no arma ningún ejemplo de fila
    // que la necesite. Un campo de menos que traer del sistema es una superficie de menos.
    descripcion: '',
    conceptoBanco: f.concepto_banco,
    conceptoCodigo: null,
    conceptoCompleto: null,
    conceptoBancoEstrategia: null,
    importe: f.importe,
    saldo: null,
    saldoEsAcreedor: null,
    moneda: cabeceras.get(f.cuenta_bancaria_id)?.moneda ?? 'ARS',
    referenciaExterna: null,
    paginaPdf: null,
    identificacion: identificacionDe(f.clase, f.tipo),
    confianza: null,
    pendiente: null,
    contraparteConocida: null,
    categoriaEspecial: null,
    cuentaContable: cuentaContableDelMovimiento(renglonesPorMovimiento.get(f.movimiento_id)),
    contraparte: null,
    requiereDecisionHumana: f.clase !== 'propuesta',
    agrupable: esAgrupable(f.clase, f.que_decide),
  };
}

// -----------------------------------------------------------------------------
// Agregados por grupo — nunca a través de `GrupoDeMovimientos.totalDebito/totalCredito` (son `number`,
// pensados para una celda de Excel — CLAUDE.md §2 los prohíbe como contrato de dominio). Se recalculan
// acá con aritmética de centavos (bigint), y se leen `clave`/`bancoCodigo`/`conceptoBanco`/`cantidad`/
// `tipoDeMovimiento`/`requiereRevision` de `agruparFilas` tal cual — esos campos SÍ son seguros.
// -----------------------------------------------------------------------------

/** Misma clave EFECTIVA que usa `agruparFilas` internamente (`armar-libro.ts`): por
 *  `claveDeAgrupacion(bancoCodigo, conceptoBanco)`, salvo que la fila no sea `agrupable` — ahí es su
 *  propia clave individual, sufijada por `filaNumero`. DUPLICADA a propósito (esa parte de
 *  `agruparFilas` no está expuesta por separado): es la única forma de acumular EN PARALELO, por la
 *  MISMA clave que el agrupador pure ya calculó, sin tocar `armar-libro.ts`. */
function claveEfectiva(fila: FilaPlanilla, bancoCodigo: string): string {
  const base = claveDeAgrupacion(bancoCodigo, fila.conceptoBanco);
  return fila.agrupable ? base : `${base}::individual:${fila.filaNumero}`;
}

type Acumulado = {
  debito: bigint;
  credito: bigint;
  fechaMin: string;
  fechaMax: string;
  /** código → denominación, de cada cuenta real distinta vista en el grupo. */
  cuentas: Map<string, string>;
  huboSinCuenta: boolean;
};

function acumularPorClave(
  filas: readonly FilaPlanilla[],
  bancoCodigoPorCuenta: ReadonlyMap<string, string>,
): ReadonlyMap<string, Acumulado> {
  const mapa = new Map<string, Acumulado>();
  for (const fila of filas) {
    const bancoCodigo = bancoCodigoPorCuenta.get(fila.cuentaBancariaId) ?? '(banco desconocido)';
    const clave = claveEfectiva(fila, bancoCodigo);
    const acc = mapa.get(clave) ?? {
      debito: 0n,
      credito: 0n,
      fechaMin: fila.fecha,
      fechaMax: fila.fecha,
      cuentas: new Map<string, string>(),
      huboSinCuenta: false,
    };
    const centavos = importeCanonicoACentavos(fila.importe) ?? 0n;
    if (centavos < 0n) acc.debito += -centavos;
    else acc.credito += centavos;
    if (fila.fecha < acc.fechaMin) acc.fechaMin = fila.fecha;
    if (fila.fecha > acc.fechaMax) acc.fechaMax = fila.fecha;
    if (fila.cuentaContable === null) acc.huboSinCuenta = true;
    else acc.cuentas.set(fila.cuentaContable.codigo, fila.cuentaContable.denominacion);
    mapa.set(clave, acc);
  }
  return mapa;
}

/** `null` salvo que TODOS los miembros del grupo compartan la MISMA cuenta real y ninguno esté sin
 *  cuenta — unanimidad, nunca mayoría (mismo criterio que `cuentaAsignadaDelGrupo` de
 *  `armar-libro.ts`). La ausencia se representa con `null`, nunca con una cuenta "probable". */
function cuentaPropuestaDe(acc: Acumulado): { readonly codigo: string; readonly denominacion: string } | null {
  if (acc.huboSinCuenta || acc.cuentas.size !== 1) return null;
  const [entrada] = acc.cuentas.entries();
  if (!entrada) return null;
  const [codigo, denominacion] = entrada;
  return { codigo, denominacion };
}

// -----------------------------------------------------------------------------
// Fase de lectura — la única protegida por SAVEPOINT (el resto, aguas abajo, es cómputo puro sobre
// lo ya leído o una consulta N1 sin riesgo de fila a medio leer).
// -----------------------------------------------------------------------------

type LecturaCruda = {
  readonly crudas: readonly FilaCruda[];
  readonly renglones: readonly RenglonReal[];
  readonly cabeceras: ReadonlyMap<string, CabeceraLigera>;
  readonly bancoCodigoPorCuenta: ReadonlyMap<string, string>;
};

type ResultadoLectura =
  | { readonly estado: 'ok' } & LecturaCruda
  | { readonly estado: 'demasiadas_filas' }
  | { readonly estado: 'error_de_lectura' };

async function leerCrudasYRenglones(
  tx: Tx,
  clienteId: string,
  pedido: PedidoAgruparDecisionesPendientes,
): Promise<ResultadoLectura> {
  await tx.consultar(`savepoint ${SAVEPOINT_LECTURA}`);
  try {
    // Tope agregado ANTES de traer una sola fila — por cliente+rango, nunca por lote.
    const conteo = await tx.consultar<{ n: string }>(
      `select count(*)::text as n
         from movimiento_bancario_crudo
        where cliente_id = $1 and fecha between $2::date and $3::date`,
      [clienteId, pedido.desde, pedido.hasta],
    );
    const total = Number(conteo[0]?.n ?? '0');
    if (total > MAX_FILAS) {
      await tx.consultar(`rollback to savepoint ${SAVEPOINT_LECTURA}`);
      return { estado: 'demasiadas_filas' };
    }

    const cuentaFilas = await tx.consultar<{ cuenta_bancaria_id: string; banco_codigo: string; moneda: string }>(
      `select distinct cb.id::text as cuenta_bancaria_id, cb.banco_codigo, cb.moneda
         from cuenta_bancaria cb
         join movimiento_bancario_crudo m on m.cliente_id = cb.cliente_id and m.cuenta_bancaria_id = cb.id
        where cb.cliente_id = $1 and m.fecha between $2::date and $3::date`,
      [clienteId, pedido.desde, pedido.hasta],
    );
    const cabeceras = new Map<string, CabeceraLigera>(
      cuentaFilas.map((c) => [c.cuenta_bancaria_id, { bancoCodigo: c.banco_codigo, moneda: c.moneda }]),
    );
    const bancoCodigoPorCuenta = new Map<string, string>(cuentaFilas.map((c) => [c.cuenta_bancaria_id, c.banco_codigo]));

    const crudas = await tx.consultar<FilaCruda>(
      `select
         m.id::text                 as movimiento_id,
         m.cuenta_bancaria_id::text as cuenta_bancaria_id,
         m.fila_numero::int         as fila_numero,
         m.fecha::text              as fecha,
         m.concepto_banco           as concepto_banco,
         m.importe::text            as importe,
         r.clase                    as clase,
         r.tipo                     as tipo,
         r.que_decide               as que_decide
       from movimiento_bancario_crudo m
       join reconocimiento_movimiento r
         on r.cliente_id = m.cliente_id and r.movimiento_id = m.id and r.superseded_por is null
       where m.cliente_id = $1 and m.fecha between $2::date and $3::date
       order by m.cuenta_bancaria_id, m.fecha, m.fila_numero`,
      [clienteId, pedido.desde, pedido.hasta],
    );

    // Recurso APARTE de `movimiento_bancario_crudo` — Capa D (`asiento_propuesto_renglon`) es un dato
    // distinto (cuenta contable real y montos ya imputados), su propia auditoría, no implícita en la
    // de arriba ("primero el rastro... vale para cada recurso", mismo principio que ya aplica este
    // mecanismo al plan de cuentas en el script de origen).
    await registrarAcceso(tx, {
      clienteId,
      accion: 'export',
      recurso: 'asiento_propuesto',
      motivo: `agrupar_decisiones_pendientes|rango:${pedido.desde}_${pedido.hasta}|cuenta_real_de_capa_d`,
    });
    const renglones = await tx.consultar<RenglonReal>(
      `select r.movimiento_id::text as movimiento_id,
              arr.cuenta_ref->>'codigo' as codigo, arr.cuenta_ref->>'denominacion' as denominacion
       from reconocimiento_movimiento r
       join movimiento_bancario_crudo m on m.cliente_id = r.cliente_id and m.id = r.movimiento_id
       join asiento_propuesto_renglon arr
         on arr.cliente_id = r.cliente_id and arr.referencia_origen::uuid = r.movimiento_id
       where r.cliente_id = $1 and r.superseded_por is null and r.clase = 'propuesta'
         and m.fecha between $2::date and $3::date`,
      [clienteId, pedido.desde, pedido.hasta],
    );

    await tx.consultar(`release savepoint ${SAVEPOINT_LECTURA}`);
    return { estado: 'ok', crudas, renglones, cabeceras, bancoCodigoPorCuenta };
  } catch (error) {
    // La fila de auditoría de `movimiento_bancario_crudo` YA insertada (antes del savepoint) sobrevive:
    // se despoisona la tx y se retorna un estado controlado — nunca relanzar acá, o el `conUsuario`/
    // `conJob` del caller haría rollback de toda la transacción, incluida esa fila. Mismo mecanismo que
    // `leerCliente` en `paquete-cierre-bracci-roka-2026-05-a-08.ts`.
    await tx.consultar(`rollback to savepoint ${SAVEPOINT_LECTURA}`);
    log.error('agrupar_decisiones_pendientes.lectura_fallo', { cliente_id: clienteId, causa_tipo: causaTipo(error) });
    return { estado: 'error_de_lectura' };
  }
}

// -----------------------------------------------------------------------------
// Función central
// -----------------------------------------------------------------------------

export async function agruparDecisionesPendientes(
  tx: Tx,
  pedido: PedidoAgruparDecisionesPendientes,
): Promise<ResultadoAgruparDecisionesPendientes> {
  const clienteIdParseado = esquemaClienteId.safeParse(pedido.clienteId);
  if (!clienteIdParseado.success) {
    return { estado: 'abortado', motivoCodigo: 'cliente_id_invalido' };
  }
  const clienteId = clienteIdParseado.data;

  // Forma de `desde`/`hasta` + orden, ANTES de tocar la base — ver la nota junto a `esquemaPedido`.
  if (!esquemaPedido.safeParse(pedido).success) {
    return { estado: 'abortado', motivoCodigo: 'rango_invalido' };
  }

  // Rol ANTES de cualquier select de dominio — verificable: es la PRIMERA consulta que corre esta
  // función, sin excepción. RLS de SELECT solo exige membresía, no capacidad de exportar; este chequeo
  // es la única razón por la que un `administrativo` (rol fuera de `ROLES_QUE_EXPORTAN`) no puede pedir
  // esto. Corre también bajo `conJob` (que saltea RLS): `has_role_on` depende de
  // `app.current_user_id()`, que ahí no resuelve a ningún socio/contador real, así que `puede` da
  // `false` igual — el chequeo explícito sostiene la garantía aunque RLS esté fuera de escena.
  const puede = await tieneRolSuficiente(tx, clienteId);
  if (!puede) {
    return { estado: 'abortado', motivoCodigo: 'rol_insuficiente' };
  }

  // "Primero el rastro" — auditoría ANTES de leer una sola fila N2, sin excepción. `accion: 'export'`
  // — mismo comportamiento que el script puntual, ratificado por escrito (ADR-0006 §6.bis, riesgo H-1:
  // esta lectura alimenta un archivo que sale del sistema, no una pantalla permanente con sesión — el
  // motivo queda obligatorio por eso).
  //
  // 🔴 CORREGIDO (code-reviewer, revisión de este PR): la versión anterior enumeraba los `lotes:`
  // exactos en el motivo, para lo cual consultaba `lotesEnRango()` — un `select` real contra
  // `movimiento_bancario_crudo` — ANTES de este `registrarAcceso`. Eso violaba "primero el rastro" de
  // forma literal: para cuando se auditaba, ya se había leído esa tabla. El script puntual del que se
  // generalizó esto (`paquete-cierre-bracci-roka-2026-05-a-08.ts:218-227`) tiene el MISMO defecto —
  // heredado sin querer al reusar el patrón, no corregido ahí (deuda declarada, fuera de alcance de
  // esta tarea; ver HANDOFF). Acá se cierra: el motivo queda con el rango de fechas (suficiente
  // identificación del alcance, ADR-0006 §9: "una fila de acceso_auditoria por request... nunca una
  // fila por renglón" — no exige enumerar cada lote), y NINGÚN `select` corre antes de esta línea.
  await registrarAcceso(tx, {
    clienteId,
    accion: 'export',
    recurso: 'movimiento_bancario_crudo',
    motivo: `agrupar_decisiones_pendientes|rango:${pedido.desde}_${pedido.hasta}`,
  });

  const lectura = await leerCrudasYRenglones(tx, clienteId, pedido);
  if (lectura.estado === 'demasiadas_filas') {
    return { estado: 'abortado', motivoCodigo: 'demasiadas_filas' };
  }
  if (lectura.estado === 'error_de_lectura') {
    return { estado: 'abortado', motivoCodigo: 'error_de_lectura' };
  }
  const { crudas, renglones, cabeceras, bancoCodigoPorCuenta } = lectura;

  // De acá en más: el SAVEPOINT ya se liberó (lectura completa y consistente) — nada de lo que sigue
  // necesita `rollback to savepoint` ni conversión a un estado controlado. Es cómputo puro sobre lo ya
  // leído, más una consulta N1 sin riesgo (`tenant_node.nombre`). Un error acá es genuinamente
  // inesperado y tiene que subir y revertir toda la transacción, no degradarse en silencio.
  const renglonesPorMovimiento = agruparRenglonesPorMovimiento(renglones);
  const filasPlanilla = crudas.map((f) => comoFilaPlanilla(f, renglonesPorMovimiento, cabeceras));

  // Mapa mínimo para `agruparFilas` — solo `bancoCodigo` importa a esa función (verificado contra
  // `armar-libro.ts::construirGrupo`); el resto de `CabeceraCuenta` es superficie de Excel que esta
  // función nunca arma. Mismo truco que `armarLibroCliente` en el script de origen.
  const cabecerasParaAgrupar = new Map<string, CabeceraCuenta>(
    [...cabeceras.entries()].map(([id, c]) => [
      id,
      {
        cuentaBancariaId: id,
        bancoCodigo: c.bancoCodigo,
        cuentaAlias: null,
        tipoCuenta: null,
        cbuUltimos4: null,
        moneda: c.moneda,
        periodoDesde: pedido.desde,
        periodoHasta: pedido.hasta,
        saldoInicialDeclarado: null,
        saldoFinalDeclarado: null,
        totalCreditosDeclarado: null,
        totalDebitosDeclarado: null,
        saldoFinalCalculado: null,
        totalCreditosCalculado: null,
        totalDebitosCalculado: null,
        filasLeidas: 0,
        filasAceptadas: 0,
        verificacionEstado: 'no_verificable',
      },
    ]),
  );

  const gruposBase = agruparFilas(filasPlanilla, cabecerasParaAgrupar);
  const acumulados = acumularPorClave(filasPlanilla, bancoCodigoPorCuenta);

  const grupos: GrupoDecisionPendiente[] = gruposBase.map((g) => {
    const acc = acumulados.get(g.clave);
    if (!acc) {
      // Invariante roto: `claveEfectiva` tiene que producir EXACTAMENTE las mismas claves que
      // `agruparFilas` calcula internamente. Un `throw` acá es preferible a un total en cero
      // silencioso.
      throw new Error('agruparDecisionesPendientes: clave de agruparFilas sin acumulado — claveEfectiva desincronizada');
    }
    return {
      clave: g.clave,
      bancoCodigo: g.bancoCodigo,
      conceptoBanco: g.conceptoBanco,
      cantidad: g.cantidad,
      totalDebito: centavosAImporte(acc.debito),
      totalCredito: centavosAImporte(acc.credito),
      fechaDesde: acc.fechaMin,
      fechaHasta: acc.fechaMax,
      tipoDeMovimiento: g.tipoDeMovimiento,
      cuentaPropuesta: cuentaPropuestaDe(acc),
      requiereRevision: g.requiereRevision,
    };
  });

  // Nombre del cliente resuelto SIEMPRE desde la base — nunca de un parámetro de texto libre.
  const clienteFilas = await tx.consultar<{ nombre: string }>(
    `select nombre from tenant_node where id = $1 and tipo = 'cliente' and deleted_at is null`,
    [clienteId],
  );
  const clienteNombre = clienteFilas[0]?.nombre;
  if (clienteNombre === undefined) {
    // El rol dio permiso (hay membresía activa sobre este nodo) pero `tenant_node` no lo resuelve
    // como cliente activo — inconsistencia real entre `membership`/`has_role_on` y `tenant_node`,
    // nunca un caso de dominio esperado. Sube y revierte (persona `backend-dev`: "un error
    // inesperado sube y revierte"), no se degrada a un estado 'abortado' silencioso — y acá SÍ
    // propaga de verdad: este `throw` ya no está dentro de ningún `try/catch` que lo convierta.
    throw new Error('agruparDecisionesPendientes: rol suficiente pero tenant_node no resolvió un cliente activo');
  }

  return {
    estado: 'ok',
    clienteId,
    clienteNombre,
    desde: pedido.desde,
    hasta: pedido.hasta,
    grupos,
    cantidadMovimientos: crudas.length,
  };
}
