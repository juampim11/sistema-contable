-- =============================================================================
-- 0031_capa_d_vocabulario_motivo.sql — D-28 (vocabulario de `pendiente_cierre.motivo_codigo` para
-- Capa D) + D-30 (columna `evidencia` para lo que Capa D no pudo resolver)
--
-- Sesión nocturna autónoma, 2026-08-31. Convocatoria en paralelo (sin verse entre sí, conciliado
-- acá por quien conduce) de `contador-dominio` (criterio contable) y `analista-funcional`
-- (verificabilidad) sobre `docs/diseno/28-diseno-motor-clasificacion.md` §3/§6 (D-28, D-31).
--
-- ## Los 5 motivos nuevos, y por qué no son 4
--
-- Los 4 candidatos originales de la convocatoria de diseño (`cuenta_no_configurada`,
-- `cuenta_ambigua`, `tipo_sin_regla_imputacion`, `cliente_sin_plan_de_cuentas`) tenían una ambigüedad
-- real que `analista-funcional` encontró de forma independiente (sin ver la respuesta de
-- `contador-dominio`, que llegó a la misma conclusión por otro camino): `cuenta_no_configurada` y
-- `tipo_sin_regla_imputacion` podían dispararse por el MISMO estado de datos. `contador-dominio`
-- las redefine con semántica disjunta y remediación distinta:
--
-- - `tipo_sin_regla_imputacion`: nadie cargó la regla, o la única que existe está vencida/todavía no
--   vigente a la fecha del movimiento → hay que CREARLA o renovarla.
-- - `cuenta_no_configurada`: la regla existe y está vigente, pero la cuenta a la que apunta no es
--   válida/vigente en el plan a esa fecha (dada de baja, reclasificada) → hay que CORREGIR la regla.
--
-- `cliente_sin_plan_de_cuentas` es lógicamente un subconjunto de "0 candidatas" (sin `cuenta`, no hay
-- ninguna regla que pueda resolver) — la prioridad de evaluación (`analista-funcional`, ambigüedad C)
-- es: si el cliente no tiene NINGUNA fila en `cuenta`/`cuenta_atributo`, se reporta
-- `cliente_sin_plan_de_cuentas` ANTES de evaluar la tabla de reglas; si tiene plan, recién ahí se
-- evalúa `N` (candidatas resueltas). Esta prioridad es la que hace reproducible el resultado que
-- `28`§5 ya predijo para H y J (100% a `pendiente_cierre` con este motivo, no con el genérico).
--
-- `movimiento_de_socio` (quinto motivo, no estaba en la lista original) cubre el caso `N=1` que D-31
-- (`28`§3) veta duro de auto-resolución para la familia `retiro_de_socio`/`aporte_de_socio`/
-- `cuenta_particular_socio` — `contador-dominio` y `analista-funcional` lo encontraron por separado
-- (ambigüedad/gap "B"), sin coordinarse. NO es un dato faltante (hay exactamente 1 candidata
-- correcta) ni una ambigüedad (no hay más de una) — es un control de diseño deliberado. Reusar
-- `cuenta_ambigua` o `cuenta_no_configurada` para este caso le mentiría al revisor sobre la causa.
--
-- ## BLOQUEADO, sin resolver esta noche — documentado en HANDOFF, no inventado
--
-- - Motivo propio para la pata "banco" (`cuenta_bancaria.cuenta_id`, D-29) sin mapear —
--   `analista-funcional` propuso `cuenta_bancaria_no_configurada` pero lo marcó bloqueado: es
--   decisión de cuántos motivos vale la pena mantener, no de esquema.
-- - Cómo se enrutan movimientos con `reconocimiento_movimiento.clase ∈ {sin_reconocer,
--   decision_humana}` — ¿llegan siquiera a `pendiente_cierre`? No está especificado en ningún
--   documento (`analista-funcional`).
-- - Prioridad de reporte si fallan las dos patas de D-29 a la vez (banco Y contrapartida).
-- - `cuenta_ambigua` sigue mezclando dos causas raíz con remediación opuesta ("normal" para tipos de
--   cardinalidad abierta vs. "bug de datos" por reglas solapadas por error) — no se abre un sexto
--   motivo para esto por decisión de `contador-dominio`/`analista-funcional` de no inflar el
--   catálogo; la columna `evidencia` de abajo es lo que tiene que distinguirlas cuando el motor
--   exista, no un `motivo_codigo` nuevo.
--
-- Vocabulario completo: `packages/data/src/cierre/tipos.ts`, `MOTIVOS_PENDIENTE_CIERRE`.
-- =============================================================================

begin;

alter table pendiente_cierre drop constraint pendiente_cierre_motivo_chk;

alter table pendiente_cierre add constraint pendiente_cierre_motivo_chk
  check (motivo_codigo in (
    'documento_faltante', 'cotizacion_no_disponible',
    'cliente_sin_plan_de_cuentas', 'tipo_sin_regla_imputacion', 'cuenta_no_configurada',
    'cuenta_ambigua', 'movimiento_de_socio'));

comment on constraint pendiente_cierre_motivo_chk on pendiente_cierre is
  'Vocabulario cerrado, ver MOTIVOS_PENDIENTE_CIERRE (packages/data/src/cierre/tipos.ts). '
  'motivo_codigo, NO motivo a secas: ese nombre ya está clasificado N2 para prosa libre. Ampliado '
  '0031 (D-28) con los 5 motivos de Capa D, sobre los 2 originales de 0027.';

-- D-30: lo que Capa D no pudo resolver, para que la cola de revisión tenga contexto además del
-- `motivo_codigo` — mismo patrón de allowlist que ya usa `verificacion_heredada`
-- (`reconocimiento_movimiento`, 0014), nunca prosa libre ni un valor real del movimiento (el código,
-- no el dato, es lo que va acá). Nullable: los 2 motivos originales de 0027 no la necesitan.
alter table pendiente_cierre add column evidencia jsonb;

comment on column pendiente_cierre.evidencia is
  'Por qué Capa D no pudo resolver la cuenta — códigos y referencias por id (p. ej. qué regla de '
  'regla_imputacion se evaluó, cuántas candidatas resultaron), NUNCA texto libre ni un valor real '
  'del movimiento. Distingue, para cuenta_ambigua, "cardinalidad abierta por diseño" de "reglas '
  'solapadas por error de carga" — bloqueado documentar el esquema exacto del jsonb hasta que exista '
  'el motor real que lo escriba (Sesión 2b de código).';

commit;
