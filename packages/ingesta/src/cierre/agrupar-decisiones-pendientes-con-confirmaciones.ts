/**
 * AGRUPAR DECISIONES PENDIENTES, CON CONFIRMACIONES — la capa que orquesta que el comentario de
 * cabecera de `agrupar-decisiones-pendientes.ts` deja explícitamente afuera de esa función: "el
 * pre-llenado de `cuentaContable` con la memoria de una confirmación anterior es una decisión de la
 * capa que orquesta... nunca de esta función". Esta es esa capa.
 *
 * Generaliza el cruce puntual de `paquete-cierre-bracci-roka-2026-05-a-08.ts` (`confirmacionesGrupoPorClave`,
 * y su consumo en `comoFilaPlanilla`: `deCapaD ?? confirmacionesGrupoPorClave.get(...)`) — mismo criterio
 * exacto, generalizado a `{clienteId, desde, hasta}`: la confirmación vigente llena el hueco SOLO
 * cuando Capa D no propuso nada; nunca lo pisa.
 *
 * Alcance angosto, a propósito:
 * - NO reimplementa la agrupación, el chequeo de rol, el tope de filas ni la auditoría de
 *   `movimiento_bancario_crudo`/`asiento_propuesto` — todo eso sigue siendo `agruparDecisionesPendientes`,
 *   llamado tal cual, dentro de la MISMA `tx`.
 * - Cruza por `claveDeAgrupacion(bancoCodigo, conceptoBanco)` — el único árbitro de "es el mismo grupo"
 *   (`armar-libro.ts`), nunca una normalización recalculada acá. Un grupo `distinguir_tercero_de_socio`
 *   (`g.clave` con sufijo `::individual:<filaNumero>`, `armar-libro.ts:916-938`) NUNCA cruza contra una
 *   confirmación — comparten glosa con otras contrapartes que Laura todavía no distinguió (code-reviewer,
 *   hallazgo real de esta revisión: ver el chequeo `g.clave !== claveBase` más abajo).
 * - El contrato de salida es el MISMO `GrupoDecisionPendiente`/`ResultadoAgruparDecisionesPendientes` —
 *   nunca expone `respaldo` (texto libre de `confirmacion_grupo`, puede citar un CUIT o un nombre de
 *   socio — incidente #14, sin resolver): solo `cuenta.codigo`/`denominacion`, el mismo shape que ya
 *   usa `cuentaPropuesta` para lo que resuelve Capa D.
 *
 * `tx: Tx` PRIMERO, siempre — mismo motivo que `agrupar-decisiones-pendientes.ts`: el caller abre la
 * transacción y decide con qué credencial correr, esta función nunca abre la suya (CLAUDE.md §2.1).
 */

import { registrarAcceso, leerConfirmacionesGrupoVigentes, leerPlanDeCuentasCompleto, type Tx } from '@sistema-contable/data';
import { claveDeAgrupacion } from '../planilla/armar-libro.ts';
import {
  agruparDecisionesPendientes,
  type GrupoDecisionPendiente,
  type PedidoAgruparDecisionesPendientes,
  type ResultadoAgruparDecisionesPendientes,
} from './agrupar-decisiones-pendientes.ts';

export async function agruparDecisionesPendientesConConfirmaciones(
  tx: Tx,
  pedido: PedidoAgruparDecisionesPendientes,
): Promise<ResultadoAgruparDecisionesPendientes> {
  const resultado = await agruparDecisionesPendientes(tx, pedido);
  if (resultado.estado !== 'ok') return resultado;

  // "Primero el rastro" — recurso APARTE del de `agruparDecisionesPendientes` (mismo principio que ya
  // aplica esa función al plan de cuentas/asientos: cada recurso tiene su propia fila de auditoría,
  // nunca implícita en la de otro), auditado ANTES de leerlo.
  await registrarAcceso(tx, {
    clienteId: resultado.clienteId,
    accion: 'export',
    recurso: 'confirmacion_grupo',
    motivo: `agrupar_decisiones_pendientes_con_confirmaciones|rango:${pedido.desde}_${pedido.hasta}|pre_llenado_cuenta_contable`,
  });
  const confirmaciones = await leerConfirmacionesGrupoVigentes(tx, { clienteId: resultado.clienteId });
  if (confirmaciones.length === 0) return resultado; // nada que cruzar — mismo resultado tal cual

  await registrarAcceso(tx, {
    clienteId: resultado.clienteId,
    accion: 'export',
    recurso: 'cuenta_atributo',
    motivo: `agrupar_decisiones_pendientes_con_confirmaciones|rango:${pedido.desde}_${pedido.hasta}|resolver_cuenta_de_confirmacion`,
  });
  const plan = await leerPlanDeCuentasCompleto(tx, { clienteId: resultado.clienteId });
  // Solo cuentas VIGENTES hoy (activa && sin vigente_hasta) — mismo filtro que el script de origen:
  // una confirmación que apunta a una cuenta ya dada de baja se DESCARTA, nunca se muestra.
  const planVigentePorId = new Map(plan.filter((c) => c.activa && c.vigenteHasta === null).map((c) => [c.cuentaId, c]));

  const cuentaPorClave = new Map<string, { readonly codigo: string; readonly denominacion: string }>(
    confirmaciones.flatMap((c) => {
      const cuenta = planVigentePorId.get(c.cuentaId);
      if (!cuenta) return [];
      return [[claveDeAgrupacion(c.bancoCodigo, c.conceptoBanco), { codigo: cuenta.codigo, denominacion: cuenta.denominacion }] as const];
    }),
  );
  if (cuentaPorClave.size === 0) return resultado;

  const grupos: readonly GrupoDecisionPendiente[] = resultado.grupos.map((g) => {
    // Capa D es la fuente de verdad más fuerte (unanimidad REAL sobre asientos ya propuestos): una
    // `cuentaPropuesta` ya resuelta nunca se pisa con una confirmación. La confirmación solo llena el
    // hueco cuando Capa D no tiene nada.
    if (g.cuentaPropuesta !== null) return g;

    const claveBase = claveDeAgrupacion(g.bancoCodigo, g.conceptoBanco);
    // `agruparFilas` (armar-libro.ts:916-938) le da a cada movimiento `distinguir_tercero_de_socio`
    // (no agrupable) una clave INDIVIDUAL, sufijada `::individual:<filaNumero>` — justo para que dos
    // movimientos que comparten el mismo texto genérico del banco, pero son contrapartes DISTINTAS,
    // nunca se traten como el mismo grupo (riesgo del incidente #14, `esAgrupable()` más abajo en
    // `agrupar-decisiones-pendientes.ts`). `g.clave` conserva ese sufijo tal cual salió de ahí — si
    // difiere de la clave base, este grupo es individual y NUNCA cruza contra una confirmación (que
    // vive indexada por `(bancoCodigo, conceptoNormalizado)`, sin noción de fila): cruzarlo igual le
    // asignaría en silencio la cuenta de "el resto de la glosa" a una contraparte que Laura todavía no
    // distinguió (code-reviewer, hallazgo real de esta revisión).
    if (g.clave !== claveBase) return g;

    const confirmada = cuentaPorClave.get(claveBase);
    if (!confirmada) return g;
    // El grupo ya tiene la decisión humana de Laura (`confirmar-grupo.ts`) — deja de "requerir
    // revisión" en esta misma lectura, no solo se le agrega la cuenta y queda pidiendo revisión de
    // nuevo.
    return { ...g, cuentaPropuesta: confirmada, requiereRevision: false };
  });

  return { ...resultado, grupos };
}
