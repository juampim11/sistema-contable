/**
 * RELEVAMIENTO PARA LAURA — export auditado de CRITERIO CONTABLE, agregado sobre DOS clientes reales
 * del piloto (Bracci y ROKA). Plan aprobado por JP tras convocatoria completa (`motor-conciliacion-
 * contable`, `contador-dominio`, `qa-funcional`, `ux-designer`, `seguridad-datos-financieros`,
 * `security-engineer`) — este archivo implementa exactamente ese diseño, ya cerrado; no reabre
 * ninguna de esas decisiones.
 *
 * Objetivo: darle a Laura una primera vuelta de preguntas concretas ("¿esta contraparte es un cliente
 * o un socio?", "¿a qué cuenta va este tipo de movimiento?", "¿este asiento está bien así?") sobre
 * datos YA AGREGADOS — nunca el detalle fila por fila de cada movimiento bancario. El CLI
 * (`apps/cli/src/exportar-relevamiento-laura.ts`) arma el `.xlsx` con lo que este módulo devuelve y
 * lo escribe a disco DESPUÉS de que la transacción de lectura cierra — mismo criterio que
 * `exportar-planilla.ts` (ver su header: "primero el rastro, después el dato").
 *
 * ## INV-5 — Bracci y ROKA NUNCA en la misma consulta (condición bloqueante de
 * `seguridad-datos-financieros`)
 *
 * Dos pasadas COMPLETAMENTE separadas, cada una con su propio `clienteId` como `$1` — nunca
 * `where cliente_id = any($1::uuid[])` con los dos juntos. Cada pasada escribe SU PROPIA fila de
 * auditoría (`registrarAcceso`, `accion: 'export'`), antes de leer una sola fila con datos del
 * cliente — mismo orden que `exportar-planilla.ts`. Dos clientes, dos correlaciones.
 *
 * `recurso` en la auditoría nombra la tabla más sensible del lote (`movimiento_bancario_crudo`,
 * mismo criterio que `exportar-planilla.ts`); el resto de las tablas realmente leídas
 * (`movimiento_contraparte_identificador`, `reconocimiento_movimiento`, `pendiente_cierre`,
 * `asiento_propuesto`, `asiento_propuesto_renglon`) va en `motivo` — el campo `recurso` de
 * `acceso_auditoria` tiene un tope de 120 caracteres (`packages/data/src/db/auditoria.ts`) y la lista
 * completa no entra ahí sin recortar un nombre real de tabla, que sería peor que no nombrarla.
 *
 * ## Lo que este módulo NO hace
 *
 * No arma el `.xlsx` (eso es `apps/cli/src/exportar-relevamiento-laura.ts`, con `exceljs`). No
 * escribe nada — es de lectura pura, sobre una `tx` ya abierta por `conUsuario()`. No decide el corte
 * de la Hoja 1 en SQL — el `group by` de la consulta ya viene ordenado por `cantidad_movimientos
 * desc`, y `particionarContrapartes` (pura, sin base, testeada aparte) hace el corte en memoria.
 */

import { registrarAcceso, type Tx } from '@sistema-contable/data';
import { ROLES_QUE_EXPORTAN } from './exportar-planilla.ts';

// -----------------------------------------------------------------------------
// Vocabulario
// -----------------------------------------------------------------------------

/** Mismo motivo cerrado que `MOTIVOS_EXPORT` de `exportar-planilla.ts` — vive ahí, se reexporta acá
 *  para que el CLI de este módulo no tenga que importar el archivo del export de lotes. */
export const MOTIVO_RELEVAMIENTO_LAURA = 'relevamiento_criterio_contable' as const;

/** `DESTINATARIOS_EXPORT` ya incluye `'estudio_interno'` — este relevamiento sale SIEMPRE hacia ahí,
 *  nunca hacia `cliente_titular` ni `organismo` (afirma criterio de agrupación por contraparte y
 *  relación societaria fila por fila, mismo riesgo que el enriquecimiento de `exportar-planilla.ts`
 *  — dictamen de `seguridad-datos-financieros`, no hay decisión de producto para ampliarlo). */
export const DESTINATARIO_RELEVAMIENTO_LAURA = 'estudio_interno' as const;

/** Corte de la Hoja 1: grupos con `cantidadMovimientos` por debajo de este número se agregan en el
 *  resumen del bloque en vez de listarse individualmente (ux-designer, plan aprobado). */
export const CORTE_MINIMO_CONTRAPARTE = 3;

/** Nombres REALES de las tablas leídas por una pasada completa — van en `motivo` de la auditoría
 *  (condición de `seguridad-datos-financieros`: nunca un label genérico). */
const TABLAS_LEIDAS = [
  'movimiento_bancario_crudo',
  'movimiento_contraparte_identificador',
  'reconocimiento_movimiento',
  'pendiente_cierre',
  'asiento_propuesto',
  'asiento_propuesto_renglon',
  'tenant_node',
] as const;

// -----------------------------------------------------------------------------
// Tipos de salida
// -----------------------------------------------------------------------------

export type FilaContraparteCruda = {
  readonly clienteId: string;
  readonly cantidadMovimientos: number;
  readonly algunMovimientoConMultiplesCandidatos: boolean;
  readonly ejemploDescripcion: string;
  /** `'YYYY-MM-DD'`. */
  readonly ejemploFecha: string;
  /** Canónico signado, `string` — nunca `number` (CLAUDE.md §2). */
  readonly ejemploImporte: string;
};

export type FilaContraparte = FilaContraparteCruda & {
  /** `true` solo para el bloque de `retiro_de_socio` de Bracci — el que arma el Excel usa la lista
   *  `Lista_Bracci` para esta fila igual que para las demás (Laura elige directo el nombre del socio),
   *  pero necesita distinguirla para no ofrecerle la pregunta "¿es un cliente o un socio?" sobre una
   *  fila que YA sabemos que es un retiro de socio. */
  readonly esRetiroDeSocio: boolean;
};

export type ResumenContrapartesMenores = {
  /** Cuántos grupos de contraparte quedaron con `cantidadMovimientos < CORTE_MINIMO_CONTRAPARTE`. */
  readonly grupos: number;
  /** Suma de `cantidadMovimientos` de esos grupos. */
  readonly movimientos: number;
};

export type BloqueContrapartes = {
  readonly clienteId: string;
  /** Ya particionadas: solo los grupos con `cantidadMovimientos >= CORTE_MINIMO_CONTRAPARTE`, más el
   *  bloque de `retiro_de_socio` (si corresponde) al final, marcado `esRetiroDeSocio: true`. */
  readonly filas: readonly FilaContraparte[];
  readonly resumen: ResumenContrapartesMenores;
};

export type FilaTipoSinCuenta = {
  readonly clienteId: string;
  readonly tipo: string;
  readonly cantidadMovimientos: number;
  readonly cantidadConceptosDistintos: number;
  readonly ejemploDescripcion: string;
  readonly ejemploFecha: string;
  readonly ejemploImporte: string;
};

export type RenglonAsientoEjemplo = {
  readonly orden: number;
  readonly cuentaCodigo: string | null;
  readonly cuentaDenominacion: string | null;
  readonly debe: string;
  readonly haber: string;
};

export type FilaAsientoAutomatico = {
  readonly clienteId: string;
  readonly tipo: string;
  /** Total REAL de asientos de este tipo, incluidas las reversas — nunca solo los normales. */
  readonly cantidadTotal: number;
  readonly cantidadReversas: number;
  readonly asientoIdEjemplo: string;
  readonly importeEjemplo: string;
  readonly fechaImputacion: string;
  /** Los dos renglones (debe/haber) del asiento ejemplo — SIEMPRE de polaridad `normal`: el ejemplo
   *  nunca se elige entre las reversas, aunque el total de arriba las cuente. */
  readonly renglones: readonly RenglonAsientoEjemplo[];
};

export type ResultadoDeCliente = {
  readonly clienteId: string;
  /** `tenant_node.nombre` — razón social, leída acá para que el CLI arme el banner de la Hoja 1 sin
   *  tener que hardcodear el nombre real de ningún cliente en código versionado (N2, `exportable:
   *  true` — `packages/shared/src/seguridad/clasificacion-campos.ts` — y este export es siempre hacia
   *  `estudio_interno`, el mismo gate que ya autoriza exposición equivalente en capa C). */
  readonly razonSocial: string;
  readonly correlacion: string;
  readonly contrapartes: BloqueContrapartes;
  readonly tiposSinCuenta: readonly FilaTipoSinCuenta[];
  readonly asientosAutomaticos: readonly FilaAsientoAutomatico[];
};

export type ResultadoRelevamiento = {
  readonly bracci: ResultadoDeCliente;
  readonly roka: ResultadoDeCliente;
};

export const MOTIVOS_ABORTO_RELEVAMIENTO_LAURA = ['rol_insuficiente'] as const;
export type MotivoAbortoRelevamientoLaura = (typeof MOTIVOS_ABORTO_RELEVAMIENTO_LAURA)[number];

export type ResultadoRelevarParaLaura =
  | ({ readonly estado: 'armado' } & ResultadoRelevamiento)
  | {
      readonly estado: 'abortado';
      readonly motivoCodigo: MotivoAbortoRelevamientoLaura;
      /** Cuál de los dos clientes no calificó — nunca ambigüo entre Bracci y ROKA. */
      readonly clienteId: string;
    };

export type PedidoRelevamientoLaura = {
  /** `[bracciId, rokaId]` — el caller resuelve los uuid reales. Nombrado por posición, no por objeto
   *  `{bracci, roka}`, para que el tipo deje explícito que las dos pasadas son simétricas en forma
   *  (misma consulta, mismo shape) y solo difieren en si corren o no el bloque de `retiro_de_socio`. */
  readonly clienteIds: readonly [string, string];
};

// -----------------------------------------------------------------------------
// Post-procesamiento en TypeScript — el corte de la Hoja 1, puro, sin base.
// -----------------------------------------------------------------------------

/**
 * Particiona las filas crudas de contraparte (YA ordenadas por `cantidadMovimientos desc` — el
 * `order by` de la consulta) en: individuales (>= `CORTE_MINIMO_CONTRAPARTE`) + resumen del resto.
 *
 * El bloque de `retiro_de_socio` (si se pasa) NUNCA entra al corte — se agrega siempre completo,
 * DESPUÉS de las filas individuales y ANTES del resumen, marcado `esRetiroDeSocio: true`. Puede venir
 * con más de un grupo (la consulta admite el caso general aunque hoy dé una sola fila) — todos entran,
 * ninguno se agrega al resumen.
 */
export function particionarContrapartes(
  clienteId: string,
  filas: readonly FilaContraparteCruda[],
  filasRetiroDeSocio: readonly FilaContraparteCruda[] = [],
): BloqueContrapartes {
  const individuales: FilaContraparte[] = [];
  let grupos = 0;
  let movimientos = 0;

  for (const f of filas) {
    if (f.cantidadMovimientos >= CORTE_MINIMO_CONTRAPARTE) {
      individuales.push({ ...f, esRetiroDeSocio: false });
    } else {
      grupos += 1;
      movimientos += f.cantidadMovimientos;
    }
  }

  const retiro: FilaContraparte[] = filasRetiroDeSocio.map((f) => ({ ...f, esRetiroDeSocio: true }));

  return {
    clienteId,
    filas: [...individuales, ...retiro],
    resumen: { grupos, movimientos },
  };
}

// -----------------------------------------------------------------------------
// Consultas — una por hoja, siempre con `$1` = el clienteId de ESA pasada. Nunca un array de clientes.
// -----------------------------------------------------------------------------

type FilaContraparteSql = {
  readonly cliente_id: string;
  readonly cantidad_movimientos: number;
  readonly algun_movimiento_con_multiples_candidatos: boolean;
  readonly ejemplo_descripcion: string;
  readonly ejemplo_fecha: string;
  readonly ejemplo_importe: string;
};

function comoFilaContraparte(f: FilaContraparteSql): FilaContraparteCruda {
  return {
    clienteId: f.cliente_id,
    cantidadMovimientos: f.cantidad_movimientos,
    algunMovimientoConMultiplesCandidatos: f.algun_movimiento_con_multiples_candidatos,
    ejemploDescripcion: f.ejemplo_descripcion,
    ejemploFecha: f.ejemplo_fecha,
    ejemploImporte: f.ejemplo_importe,
  };
}

/**
 * Hoja 1 — Contrapartes. Universo `distinguir_tercero_de_socio` vigente. Válida para AMBOS clientes.
 *
 * `::int` en `count(*)` — el driver ya devuelve `bigint` como string por defecto (`node-postgres`), y
 * acá es un CONTEO, no un importe: forzar `int4` deja que el driver lo entregue como `number` de JS
 * sin violar la regla de "ningún importe como number" (un conteo no es un importe). `::text` en
 * `ejemplo_fecha`/`ejemplo_importe`: son `date`/`numeric`, y sin el cast el driver los convierte
 * (`date` → `Date` con la zona horaria del host; `numeric` puede perder precisión) — ADR-0000 §2.3.
 */
async function consultarContrapartes(tx: Tx, clienteId: string): Promise<readonly FilaContraparteCruda[]> {
  const filas = await tx.consultar<FilaContraparteSql>(
    `with vigentes as (
       select r.cliente_id, r.movimiento_id
       from reconocimiento_movimiento r
       where r.cliente_id = $1
         and r.clase = 'decision_humana'
         and r.que_decide = 'distinguir_tercero_de_socio'
         and r.superseded_por is null
     ),
     movimientos as (
       select m.cliente_id, m.id as movimiento_id, m.fecha, m.importe, m.descripcion
       from movimiento_bancario_crudo m
       join vigentes v on v.cliente_id = m.cliente_id and v.movimiento_id = m.id
     ),
     candidato_elegido as (
       select distinct on (mv.cliente_id, mv.movimiento_id)
         mv.cliente_id, mv.movimiento_id, mv.fecha, mv.importe, mv.descripcion,
         ci.clase as clase_identificador, ci.identificador_hmac,
         (count(ci.identificador_hmac) over (partition by mv.cliente_id, mv.movimiento_id)) > 1
           as tiene_multiples_candidatos
       from movimientos mv
       left join movimiento_contraparte_identificador ci
         on ci.cliente_id = mv.cliente_id and ci.movimiento_id = mv.movimiento_id
       order by mv.cliente_id, mv.movimiento_id,
         case ci.clase when 'cuit' then 1 when 'cbu' then 2 when 'dni' then 3 else 4 end
     ),
     agrupado as (
       select
         cliente_id,
         coalesce(encode(identificador_hmac, 'hex'), upper(btrim(descripcion))) as clave_agrupacion,
         movimiento_id, fecha, importe, descripcion, tiene_multiples_candidatos
       from candidato_elegido
     )
     select
       cliente_id,
       count(*)::int as cantidad_movimientos,
       bool_or(tiene_multiples_candidatos) as algun_movimiento_con_multiples_candidatos,
       (array_agg(descripcion order by fecha, movimiento_id))[1] as ejemplo_descripcion,
       (array_agg(fecha order by fecha, movimiento_id))[1]::text as ejemplo_fecha,
       (array_agg(importe order by fecha, movimiento_id))[1]::text as ejemplo_importe
     from agrupado
     where cliente_id = $1
     group by cliente_id, clave_agrupacion
     order by cantidad_movimientos desc`,
    [clienteId],
  );
  return filas.map(comoFilaContraparte);
}

/**
 * Hoja 1, bloque especial `retiro_de_socio` de Bracci — SOLO se llama para ese clienteId. Universo
 * `pendiente_cierre.motivo_codigo = 'tipo_sin_regla_imputacion'` + `reconocimiento_movimiento.tipo =
 * 'retiro_de_socio'`. Generalizado a agrupar por `clave_agrupacion` (mismo criterio que la consulta de
 * arriba) aunque hoy el resultado real del piloto sea un solo grupo de 14 movimientos.
 */
async function consultarRetiroDeSocio(tx: Tx, clienteId: string): Promise<readonly FilaContraparteCruda[]> {
  const filas = await tx.consultar<FilaContraparteSql>(
    `with pendientes as (
       select pc.cliente_id, pc.referencia_origen::uuid as movimiento_id
       from pendiente_cierre pc
       where pc.cliente_id = $1
         and pc.motivo_codigo = 'tipo_sin_regla_imputacion'
         and pc.pendiente_estado = 'abierto'
         and pc.superseded_by_id is null
     ),
     con_tipo as (
       select p.cliente_id, p.movimiento_id
       from pendientes p
       join reconocimiento_movimiento r
         on r.cliente_id = p.cliente_id and r.movimiento_id = p.movimiento_id
        and r.superseded_por is null and r.clase = 'propuesta'
       where r.tipo = 'retiro_de_socio'
     ),
     con_datos as (
       select ct.cliente_id, ct.movimiento_id, m.fecha, m.importe, m.descripcion
       from con_tipo ct
       join movimiento_bancario_crudo m on m.cliente_id = ct.cliente_id and m.id = ct.movimiento_id
     ),
     candidato as (
       select distinct on (cd.cliente_id, cd.movimiento_id)
         cd.cliente_id, cd.movimiento_id, cd.fecha, cd.importe, cd.descripcion,
         ci.identificador_hmac,
         (count(ci.identificador_hmac) over (partition by cd.cliente_id, cd.movimiento_id)) > 1
           as multiples
       from con_datos cd
       left join movimiento_contraparte_identificador ci
         on ci.cliente_id = cd.cliente_id and ci.movimiento_id = cd.movimiento_id
       order by cd.cliente_id, cd.movimiento_id,
         case ci.clase when 'cuit' then 1 when 'cbu' then 2 when 'dni' then 3 else 4 end
     ),
     agrupado as (
       select
         cliente_id,
         coalesce(encode(identificador_hmac, 'hex'), upper(btrim(descripcion))) as clave_agrupacion,
         movimiento_id, fecha, importe, descripcion, multiples
       from candidato
     )
     select
       cliente_id,
       count(*)::int as cantidad_movimientos,
       bool_or(multiples) as algun_movimiento_con_multiples_candidatos,
       (array_agg(descripcion order by fecha, movimiento_id))[1] as ejemplo_descripcion,
       (array_agg(fecha order by fecha, movimiento_id))[1]::text as ejemplo_fecha,
       (array_agg(importe order by fecha, movimiento_id))[1]::text as ejemplo_importe
     from agrupado
     where cliente_id = $1
     group by cliente_id, clave_agrupacion
     order by cantidad_movimientos desc`,
    [clienteId],
  );
  return filas.map(comoFilaContraparte);
}

type FilaTipoSinCuentaSql = {
  readonly cliente_id: string;
  readonly tipo: string;
  readonly cantidad_movimientos: number;
  readonly cantidad_conceptos_distintos: number;
  readonly ejemplo_descripcion: string;
  readonly ejemplo_fecha: string;
  readonly ejemplo_importe: string;
};

/** Hoja 2 — Tipos sin cuenta. Válida para AMBOS clientes; `retiro_de_socio` queda EXCLUIDO a propósito
 *  (`r.tipo <> 'retiro_de_socio'`) porque ya se muestra en la Hoja 1 con su propia pregunta. Puede dar
 *  0 filas para un cliente (Bracci, hoy) — no es un error, es lo que hay. */
async function consultarTiposSinCuenta(tx: Tx, clienteId: string): Promise<readonly FilaTipoSinCuenta[]> {
  const filas = await tx.consultar<FilaTipoSinCuentaSql>(
    `with pendientes as (
       select pc.cliente_id, pc.id as pendiente_cierre_id, pc.referencia_origen::uuid as movimiento_id
       from pendiente_cierre pc
       where pc.cliente_id = $1
         and pc.motivo_codigo = 'tipo_sin_regla_imputacion'
         and pc.pendiente_estado = 'abierto'
         and pc.superseded_by_id is null
     ),
     con_tipo as (
       select p.cliente_id, p.movimiento_id, r.tipo, r.concepto, m.fecha, m.importe, m.descripcion
       from pendientes p
       join movimiento_bancario_crudo m on m.cliente_id = p.cliente_id and m.id = p.movimiento_id
       join reconocimiento_movimiento r
         on r.cliente_id = p.cliente_id and r.movimiento_id = p.movimiento_id
        and r.superseded_por is null and r.clase = 'propuesta'
       where r.tipo <> 'retiro_de_socio'
     )
     select
       cliente_id, tipo,
       count(*)::int as cantidad_movimientos,
       count(distinct concepto)::int as cantidad_conceptos_distintos,
       (array_agg(descripcion order by fecha))[1] as ejemplo_descripcion,
       (array_agg(fecha order by fecha))[1]::text as ejemplo_fecha,
       (array_agg(importe order by fecha))[1]::text as ejemplo_importe
     from con_tipo
     where cliente_id = $1
     group by cliente_id, tipo
     order by cantidad_movimientos desc`,
    [clienteId],
  );
  return filas.map((f) => ({
    clienteId: f.cliente_id,
    tipo: f.tipo,
    cantidadMovimientos: f.cantidad_movimientos,
    cantidadConceptosDistintos: f.cantidad_conceptos_distintos,
    ejemploDescripcion: f.ejemplo_descripcion,
    ejemploFecha: f.ejemplo_fecha,
    ejemploImporte: f.ejemplo_importe,
  }));
}

type FilaAsientoSql = {
  readonly cliente_id: string;
  readonly tipo: string;
  readonly cantidad_total: number;
  readonly cantidad_reversas: number;
  readonly asiento_id_ejemplo: string;
  readonly importe_ejemplo: string;
  readonly fecha_imputacion: string;
  readonly renglon_orden: number;
  readonly cuenta_codigo: string | null;
  readonly cuenta_denominacion: string | null;
  readonly debe: string;
  readonly haber: string;
};

/**
 * Hoja 3 — Asientos automáticos. Válida para AMBOS clientes. Devuelve DOS filas por cada
 * `(cliente, tipo)` — un renglón debe, un renglón haber del mismo `asiento_id_ejemplo` — que
 * `agruparAsientosAutomaticos` combina en una `FilaAsientoAutomatico` con `renglones: [debe, haber]`.
 */
async function consultarAsientosAutomaticos(tx: Tx, clienteId: string): Promise<readonly FilaAsientoAutomatico[]> {
  const filas = await tx.consultar<FilaAsientoSql>(
    `with renglones as (
       select ar.cliente_id, ar.id as asiento_id, ar.fecha_imputacion,
              arr.referencia_origen::uuid as movimiento_id, arr.orden, arr.cuenta_ref, arr.debe, arr.haber
       from asiento_propuesto ar
       join asiento_propuesto_renglon arr on arr.cliente_id = ar.cliente_id and arr.asiento_id = ar.id
       where ar.cliente_id = $1
     ),
     totales_por_asiento as (
       select cliente_id, asiento_id, movimiento_id, sum(debe) as importe_asiento
       from renglones group by cliente_id, asiento_id, movimiento_id
     ),
     asientos_con_tipo as (
       select t.cliente_id, t.asiento_id, t.movimiento_id, t.importe_asiento, rm.tipo, rm.polaridad
       from totales_por_asiento t
       join movimiento_bancario_crudo m on m.cliente_id = t.cliente_id and m.id = t.movimiento_id
       join reconocimiento_movimiento rm
         on rm.cliente_id = t.cliente_id and rm.movimiento_id = m.id
        and rm.superseded_por is null and rm.clase = 'propuesta'
     ),
     conteo_total as (
       select cliente_id, tipo, count(*)::int as cantidad_total,
              count(*) filter (where polaridad <> 'normal')::int as cantidad_reversas
       from asientos_con_tipo
       group by cliente_id, tipo
     ),
     solo_normales as (
       select * from asientos_con_tipo where polaridad = 'normal'
     ),
     mediana as (
       select cliente_id, tipo, percentile_cont(0.5) within group (order by importe_asiento) as importe_mediano
       from solo_normales group by cliente_id, tipo
     ),
     ranked as (
       select a.cliente_id, a.tipo, a.asiento_id, a.importe_asiento,
              row_number() over (
                partition by a.cliente_id, a.tipo
                order by abs(a.importe_asiento - md.importe_mediano), a.asiento_id
              ) as orden
       from solo_normales a
       join mediana md using (cliente_id, tipo)
     )
     select
       ct.cliente_id, ct.tipo, ct.cantidad_total, ct.cantidad_reversas,
       ranked.asiento_id::text as asiento_id_ejemplo, ranked.importe_asiento::text as importe_ejemplo,
       ap.fecha_imputacion::text as fecha_imputacion, arr.orden as renglon_orden,
       arr.cuenta_ref->>'codigo' as cuenta_codigo, arr.cuenta_ref->>'denominacion' as cuenta_denominacion,
       arr.debe::text as debe, arr.haber::text as haber
     from conteo_total ct
     join ranked on ranked.cliente_id = ct.cliente_id and ranked.tipo = ct.tipo and ranked.orden = 1
     join asiento_propuesto ap on ap.cliente_id = ranked.cliente_id and ap.id = ranked.asiento_id
     join asiento_propuesto_renglon arr on arr.cliente_id = ranked.cliente_id and arr.asiento_id = ranked.asiento_id
     where ct.cliente_id = $1
     order by ct.cliente_id, ct.tipo, arr.orden`,
    [clienteId],
  );
  return agruparAsientosAutomaticos(filas);
}

/** Combina las filas planas (una por renglón) en una fila por `(cliente, tipo)`, pura y testeable sin
 *  base. Exportada para el test de "el total incluye reversas pero el ejemplo es siempre normal". */
export function agruparAsientosAutomaticos(filas: readonly FilaAsientoSql[]): readonly FilaAsientoAutomatico[] {
  const porTipo = new Map<string, FilaAsientoAutomatico & { renglones: RenglonAsientoEjemplo[] }>();
  for (const f of filas) {
    const clave = `${f.cliente_id} ${f.tipo}`;
    let acumulado = porTipo.get(clave);
    if (!acumulado) {
      acumulado = {
        clienteId: f.cliente_id,
        tipo: f.tipo,
        cantidadTotal: f.cantidad_total,
        cantidadReversas: f.cantidad_reversas,
        asientoIdEjemplo: f.asiento_id_ejemplo,
        importeEjemplo: f.importe_ejemplo,
        fechaImputacion: f.fecha_imputacion,
        renglones: [],
      };
      porTipo.set(clave, acumulado);
    }
    acumulado.renglones.push({
      orden: f.renglon_orden,
      cuentaCodigo: f.cuenta_codigo,
      cuentaDenominacion: f.cuenta_denominacion,
      debe: f.debe,
      haber: f.haber,
    });
  }
  return [...porTipo.values()];
}

// -----------------------------------------------------------------------------
// Punto de entrada
// -----------------------------------------------------------------------------

async function relevarUnCliente(tx: Tx, clienteId: string, incluirRetiroDeSocio: boolean): Promise<ResultadoDeCliente> {
  // Auditoría PRIMERO, antes de leer una sola fila de este cliente — mismo orden que
  // `exportar-planilla.ts` ("primero el rastro, después el dato"). Una fila de auditoría POR CLIENTE
  // (INV-5): esta función nunca se llama con los dos clientes juntos.
  const correlacion = await registrarAcceso(tx, {
    clienteId,
    accion: 'export',
    recurso: 'movimiento_bancario_crudo',
    motivo:
      `${MOTIVO_RELEVAMIENTO_LAURA}|dest:${DESTINATARIO_RELEVAMIENTO_LAURA}` +
      `|tablas:${TABLAS_LEIDAS.join(',')}`,
  });

  const razonSocial = await consultarRazonSocial(tx, clienteId);
  const contrapartesCrudas = await consultarContrapartes(tx, clienteId);
  const retiroDeSocio = incluirRetiroDeSocio ? await consultarRetiroDeSocio(tx, clienteId) : [];
  const contrapartes = particionarContrapartes(clienteId, contrapartesCrudas, retiroDeSocio);

  const tiposSinCuenta = await consultarTiposSinCuenta(tx, clienteId);
  const asientosAutomaticos = await consultarAsientosAutomaticos(tx, clienteId);

  return { clienteId, razonSocial, correlacion, contrapartes, tiposSinCuenta, asientosAutomaticos };
}

/** `tenant_node.nombre` del cliente — mismo criterio que `resolverBancoDelLote` en
 *  `exportar-planilla.ts`: una lectura chica, sin datos ≥ N2R, que no necesita su propio rol-check
 *  porque ya corrió el de la auditoría del paso anterior. Si el id no resuelve (no debería pasar: es
 *  el mismo clienteId con el que ya se auditó y se van a leer movimientos), cae al propio uuid en vez
 *  de inventar un nombre — nunca bloquea el resto del relevamiento por esto. */
async function consultarRazonSocial(tx: Tx, clienteId: string): Promise<string> {
  const filas = await tx.consultar<{ nombre: string }>(`select nombre from tenant_node where id = $1`, [clienteId]);
  return filas[0]?.nombre ?? clienteId;
}

/** Mismo gate que `exportarPlanillaDeLote` (`ROLES_QUE_EXPORTAN`, reusado — "un export es
 *  estrictamente más dato que una descarga, nunca puede ser más laxo"). `has_role_on` es la MISMA
 *  función que usan las policies — no una copia con su propia lógica. */
async function tieneRolSuficiente(tx: Tx, clienteId: string): Promise<boolean> {
  const filas = await tx.consultar<{ puede: boolean }>(
    `select app.has_role_on($1::uuid, $2::app.rol_membership[]) as puede`,
    [clienteId, ROLES_QUE_EXPORTAN],
  );
  return filas[0]?.puede === true;
}

/**
 * Arma los datos de las 3 hojas del relevamiento, en DOS pasadas separadas (INV-5). `args.clienteIds`
 * es `[bracciId, rokaId]` — el bloque de `retiro_de_socio` de la Hoja 1 solo corre para el primero.
 *
 * El rol se verifica para LOS DOS clientes ANTES de auditar o leer una sola fila de cualquiera de los
 * dos — mismo orden que `exportarPlanillaDeLote` ("rol, después rastro, después dato"), y cada
 * chequeo con su propio `clienteId` como `$1` (INV-5 aplica también acá).
 */
export async function relevarParaLaura(tx: Tx, args: PedidoRelevamientoLaura): Promise<ResultadoRelevarParaLaura> {
  const [bracciId, rokaId] = args.clienteIds;

  if (!(await tieneRolSuficiente(tx, bracciId))) {
    return { estado: 'abortado', motivoCodigo: 'rol_insuficiente', clienteId: bracciId };
  }
  if (!(await tieneRolSuficiente(tx, rokaId))) {
    return { estado: 'abortado', motivoCodigo: 'rol_insuficiente', clienteId: rokaId };
  }

  const bracci = await relevarUnCliente(tx, bracciId, true);
  const roka = await relevarUnCliente(tx, rokaId, false);
  return { estado: 'armado', bracci, roka };
}
