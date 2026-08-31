-- =============================================================================
-- 0034_via_no_calificada_y_banco_no_configurado.sql — dos motivos nuevos de
-- `pendiente_cierre.motivo_codigo`, encontrados al escribir el resolver puro de
-- `motor-conciliacion-contable` (Ítem E, paso 1) y aprobados por JP en la ronda de revisión del
-- diseño (sesión interactiva, modo plan, 2026-08-31).
--
-- Ningún motivo de los 7 existentes (`0031`/`0033`) cubría estos dos estados de datos, y reusar uno
-- ya usado hubiera repetido el error de nombres que motivó el rename de D-28
-- (`movimiento_de_socio` → `resolucion_manual_obligatoria_socio`): mentir sobre la causa real.
--
-- - `via_no_calificada`: la cuenta resuelve perfecto (0 ambigüedad, 0 dato faltante), pero la vía de
--   evidencia de Capa C es una de las 2 (de 6) que D-31 no considera suficiente para automático
--   (`texto_prefijo_con_cola`, `texto_con_codigo_no_catalogado`). Distinto de
--   `resolucion_manual_obligatoria_socio`: acá el motivo puede eventualmente cambiar si mejora la
--   evidencia sobre ESE movimiento puntual; el veto de socio es permanente por diseño
--   (`contador-dominio`, ronda de revisión).
-- - `cuenta_bancaria_no_configurada`: la pata "banco" (`cuenta_bancaria.cuenta_id`, D-29) sin
--   mapear — motivo propio, no `cuenta_no_configurada` (que es de la pata contrapartida): un
--   contador viendo el código sin distinción no sabría si tiene que mapear la cuenta bancaria o
--   cargar una regla de imputación, que son dos tareas distintas (`contador-dominio`).
--
-- Sin backfill: 0 filas reales en `pendiente_cierre` con motivo de Capa D todavía (el motor real
-- recién empieza a escribir en el paso 2 de esta misma tarea).
-- =============================================================================

begin;

alter table pendiente_cierre drop constraint pendiente_cierre_motivo_chk;

alter table pendiente_cierre add constraint pendiente_cierre_motivo_chk
  check (motivo_codigo in (
    'documento_faltante', 'cotizacion_no_disponible',
    'cliente_sin_plan_de_cuentas', 'tipo_sin_regla_imputacion', 'cuenta_no_configurada',
    'cuenta_ambigua', 'resolucion_manual_obligatoria_socio',
    'via_no_calificada', 'cuenta_bancaria_no_configurada'));

comment on constraint pendiente_cierre_motivo_chk on pendiente_cierre is
  'Vocabulario cerrado, ver MOTIVOS_PENDIENTE_CIERRE (packages/data/src/cierre/tipos.ts). '
  'motivo_codigo, NO motivo a secas: ese nombre ya está clasificado N2 para prosa libre. Ampliado '
  '0031 (D-28, 5 motivos) y 0033 (rename). 0034 agrega via_no_calificada y '
  'cuenta_bancaria_no_configurada, encontrados al escribir el resolver real (Ítem E).';

commit;
