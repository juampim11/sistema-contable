-- =============================================================================
-- 0032_documento_ingerido_lote_fk.sql — D-27: FK física `documento_ingerido → lote_ingesta`
--
-- Sesión nocturna autónoma, 2026-08-31. `docs/diseno/28-diseno-motor-clasificacion.md` §1/§6
-- describía el enganche `documento_ingerido`/`fuente_cierre` ↔ `lote_ingesta`/
-- `movimiento_bancario_crudo` como una correspondencia por RANGO
-- (`cliente_id, cuenta_bancaria_id, fecha ∈ periodo`), sin FK física ni guardia contra reingesta con
-- período solapado.
--
-- `dba-data` (convocatoria de esta sesión) encontró un dato que agrava el gap: `lote_ingesta.
-- archivo_clave` (`0004_ingesta.sql:292`) es NULLABLE y SIN `unique` — la única unicidad real de
-- `lote_ingesta` es `(cliente_id, archivo_hash)`. El enganche hoy es una comparación de STRING contra
-- una columna que la propia tabla no garantiza única: no es solo "sin FK", es un join que puede
-- matchear más de una fila sin desempate determinístico.
--
-- ## Qué se cierra acá, y qué queda aceptado como riesgo documentado (no resuelto en silencio)
--
-- (a) SE AGREGA la FK física `documento_ingerido.lote_ingesta_id → lote_ingesta`. Costo bajo (columna
--     + FK compuesta, sin backfill — mismo criterio que dejó `documento_ingerido` vacía en `0027`),
--     cierra un gap real y verificado, no una hipótesis. Nullable: solo aplica a
--     `tipo_documento = 'extracto'` hoy — `fci`/`liquidacion_tarjeta`/`libro_iva_*` no tienen tabla
--     de lote propia todavía (verificado por `dba-data` contra todas las migraciones aplicadas).
--
--     SIN el `CHECK` de equivalencia `(tipo_documento = 'extracto') = (lote_ingesta_id is not null)`:
--     no se verificó contra `packages/data/src/cierre/escrituras.ts::backfillDocumentoIngerido` que
--     TODO `extracto` real haya nacido siempre de un `lote_ingesta` — endurecerlo sin esa revisión
--     podría bloquear un camino de ingesta futuro que no pase por Módulo 1. Queda como paso 2,
--     explícito, para quien revise ese código (no bloqueado por falta de decisión de negocio — es
--     una verificación técnica pendiente).
--
-- (b) NO se agrega el guardia contra reingesta/solape de rango (`fecha ∈ periodo`). Riesgo aceptado,
--     documentado en `docs/diseno/10-deuda-declarada.md` con el motivo exacto (no en silencio):
--
--     - La vía idiomática de Postgres (`EXCLUDE USING gist` sobre `daterange`) está estructuralmente
--       bloqueada en este repo: `btree_gist` es una extensión no-core que ADR-0000 §6 prohíbe, ya
--       confirmado por `0009`/`0013` para vigencias MÁS simples (una sola fecha, no un rango cruzado
--       con `cuenta_bancaria_id`). La alternativa sin extensión es un trigger procedural con
--       `SELECT ... FOR UPDATE` para evitar carrera — pieza de concurrencia no trivial.
--     - Probabilidad real de solape, hoy, es baja y parcialmente cubierta: `uq_documento_ingerido_
--       natural` (`0027`) ya bloquea el caso más común (re-subir el mismo archivo con el mismo
--       período exacto). Lo que queda sin cubrir es un período PARCIALMENTE solapado — error humano
--       de carga administrativa, no un evento del flujo automático, y hoy CERO código de aplicación
--       ejercita este camino (Capa D de código no arrancó).
--     - Recomendación de `dba-data`: revisar quirúrgicamente cuando arranque la Sesión 2b de código
--       sobre Bracci (`27-roadmap-capa-d.md` §B.5) — si el patrón de carga real muestra reingestas
--       frecuentes, se sube de prioridad con datos, no con una hipótesis.
-- =============================================================================

begin;

alter table documento_ingerido add column lote_ingesta_id uuid;

alter table documento_ingerido add constraint fk_documento_ingerido_lote
  foreign key (cliente_id, lote_ingesta_id) references lote_ingesta (cliente_id, id)
  on delete restrict;

comment on column documento_ingerido.lote_ingesta_id is
  'D-27. Solo tipo_documento=''extracto'' lo puebla hoy — fci/liquidacion_tarjeta/libro_iva_* no '
  'tienen tabla de lote propia todavía. Sin CHECK de equivalencia: pendiente verificar '
  'backfillDocumentoIngerido antes de endurecerlo (packages/data/src/cierre/escrituras.ts).';

commit;
