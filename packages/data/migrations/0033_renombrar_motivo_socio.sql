-- =============================================================================
-- 0033_renombrar_motivo_socio.sql — renombra `movimiento_de_socio` a
-- `resolucion_manual_obligatoria_socio` en el vocabulario de `pendiente_cierre.motivo_codigo`.
--
-- Decisión de `contador-dominio`, a pedido de JP: el nombre original describía una CATEGORÍA de
-- movimiento, no una CAUSA de fallo como los otros 4 motivos de Capa D
-- (`cliente_sin_plan_de_cuentas`, `tipo_sin_regla_imputacion`, `cuenta_no_configurada`,
-- `cuenta_ambigua`). Sin el contexto de D-31, alguien en la cola de revisión leería
-- `movimiento_de_socio` como "falta configurar algo" e intentaría arreglarlo — cuando en realidad
-- es un control de diseño deliberado (D-31, `28-diseno-motor-clasificacion.md` §3: la familia
-- `retiro_de_socio`/`aporte_de_socio`/`cuenta_particular_socio` nunca auto-resuelve, aunque haya
-- exactamente 1 candidata perfecta). El nombre nuevo lo dice sin ambigüedad.
--
-- Migración puntual de renombre: el motor que produce este motivo todavía no existe (0 filas reales
-- en LOCAL con `motivo_codigo = 'movimiento_de_socio'`), así que no hay backfill de datos que hacer.
-- Mismo constraint (`pendiente_cierre_motivo_chk`). Verificado por `dba-data` que ningún índice,
-- vista o función del esquema cita el valor literal (`idx_pendiente_cierre_gate` cita la columna
-- `motivo_codigo`, no el valor) — el único lugar a tocar en SQL es este `CHECK` y su `COMMENT`.
-- Vocabulario espejado en `packages/data/src/cierre/tipos.ts` (`MOTIVOS_PENDIENTE_CIERRE`) en la
-- misma tarea.
-- =============================================================================

begin;

alter table pendiente_cierre drop constraint pendiente_cierre_motivo_chk;

alter table pendiente_cierre add constraint pendiente_cierre_motivo_chk
  check (motivo_codigo in (
    'documento_faltante', 'cotizacion_no_disponible',
    'cliente_sin_plan_de_cuentas', 'tipo_sin_regla_imputacion', 'cuenta_no_configurada',
    'cuenta_ambigua', 'resolucion_manual_obligatoria_socio'));

comment on constraint pendiente_cierre_motivo_chk on pendiente_cierre is
  'Vocabulario cerrado, ver MOTIVOS_PENDIENTE_CIERRE (packages/data/src/cierre/tipos.ts). '
  'motivo_codigo, NO motivo a secas: ese nombre ya está clasificado N2 para prosa libre. Ampliado '
  '0031 (D-28) con los 5 motivos de Capa D, sobre los 2 originales de 0027. 0033 renombra '
  '''movimiento_de_socio'' a ''resolucion_manual_obligatoria_socio'' (contador-dominio): es un '
  'control de diseño deliberado, no un dato faltante.';

commit;
