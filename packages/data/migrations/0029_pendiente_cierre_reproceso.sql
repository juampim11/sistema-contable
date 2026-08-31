-- =============================================================================
-- 0029_pendiente_cierre_reproceso.sql — cierra B.8 (docs/diseno/10-deuda-declarada.md), acotada a
-- `pendiente_cierre` por decisión explícita de JP (2026-08-30)
--
-- `pendiente_cierre.uq_pendiente_cierre_natural` (`0027_cierre_mensual.sql:610-612`) es
-- `unique nulls not distinct (cliente_id, cierre_id, fuente_cierre_id, referencia_origen,
-- motivo_codigo)` SIN predicado parcial — a diferencia de lo que ya pedía el diseño de referencia
-- (`23-arquitectura-cierre-mensual.md` §2.2: "parcializados por vigencia donde hay supersesión") y del
-- precedente ya aplicado en la MISMA migración (`uq_cierre_periodo_vigente`, `0027:324-328`, índice
-- parcial) y en `0014` (`uq_recon_vigente`). Consecuencia real: la fila NUEVA que reemplaza a un
-- `pendiente_cierre` superseded no puede compartir la misma clave natural que la fila vieja — choca
-- contra la `unique`. Confirmado en la práctica al escribir
-- `mutaciones-0028-inmutabilidad-post-terminal.test.ts` (el test legítimo de supersesión solo pasaba
-- dándole a la fila nueva un `referencia_origen` distinto — workaround del test, no del esquema).
--
-- ## Convocatoria real: `dba-data` + `arquitecto-software`, en paralelo, sin disenso en la solución
--
-- El predicado parcial SOLO no alcanza. El trigger de `0028`
-- (`app.exigir_inmutabilidad_post_terminal`, aplicado acá vía `trg_pendiente_cierre_inmutable`) exige
-- que la ÚNICA transición sobre una fila terminal sea un `UPDATE` que fije `superseded_by_id` al `id`
-- de la fila nueva Y mueva el estado a `'superseded'`, sin que cambie nada más. Si la fila nueva se
-- inserta DESPUÉS de ese `UPDATE` (para poder referenciar su `id`), el `INSERT` cae bajo el mismo
-- predicado `WHERE superseded_by_id IS NULL` que la fila vieja tenía hasta un instante antes —el orden
-- correcto es UPDATE-de-la-vieja-primero, INSERT-de-la-nueva-después—, pero eso exige que el `UPDATE`
-- apunte a un `id` que todavía no existe como fila, lo que viola `fk_pendiente_cierre_superseded` con
-- chequeo inmediato. Por eso el fix son DOS cambios de DDL, no uno: el índice parcial, MÁS la FK de
-- supersesión pasada a `DEFERRABLE INITIALLY DEFERRED` (chequeo pospuesto al `commit`, no al final del
-- `UPDATE`). Ninguna FK apunta a la clave natural (todas usan el surrogate tenant-scoped
-- `(cliente_id, id)`), así que el cambio es seguro desde ese ángulo; `idx_pendiente_cierre_gate` es
-- ortogonal (filtra por `pendiente_estado`, no por esta unique) y no requiere ajuste. El trigger de
-- `0028` tampoco se toca: gobierna exclusivamente la fila VIEJA, ortogonal a este hallazgo (confirmado
-- por ambos agentes, no solo asumido).
--
-- ## Contrato para quien escriba el flujo real de reproceso (Capa D, todavía sin implementar)
--
-- El `id` de la fila nueva lo tiene que generar la APLICACIÓN de forma explícita (nunca el default
-- `gen_random_uuid()` de la columna), para poder pasarlo en el `UPDATE` de la fila vieja antes de que
-- la fila nueva exista. Orden obligatorio dentro de la misma transacción: (1) `UPDATE` de la fila
-- vieja fijando `pendiente_estado = 'superseded'` y `superseded_by_id = <id generado>`; (2) `INSERT`
-- de la fila nueva con ese mismo `id` explícito. Concurrencia: el `UPDATE` del paso 1 debe llevar
-- `and superseded_by_id is null` en el `WHERE` y tratar "0 filas afectadas" como conflicto explícito
-- (mismo patrón que `packages/data/src/contabilidad/escrituras.ts:435-443` para
-- `reconocimiento_movimiento`), nunca como éxito silencioso.
--
-- ## Alcance, deliberadamente acotado (decisión de JP, no de los agentes convocados)
--
-- El mismo patrón (`unique nulls not distinct` sin predicado parcial, en una tabla con
-- `superseded_by_id`) se repite, SIN SÍNTOMA MEDIDO todavía, en `documento_ingerido`
-- (`uq_documento_ingerido_natural`, `0027:243-245`) y, de forma parcial, en `expectativa_fuente_cliente`
-- (`uq_expectativa_natural`, `0027:474-476`) y `fuente_cierre` (`uq_fuente_cierre_natural`,
-- `0027:531-532`). `arquitecto-software` recomendó corregir las cuatro tablas acá, por coherencia de
-- esquema; JP decidió acotar esta migración a `pendiente_cierre` (lo único con síntoma real medido hoy)
-- y declarar las otras tres como hallazgo **B.9** en `10-deuda-declarada.md`, sin dueño, para una
-- convocatoria futura con evidencia real — "medir antes de tocar algo por parecido de forma", mismo
-- criterio ya aplicado con los adaptadores Macro/Bancor.
--
-- Ninguna función/trigger nuevo, ningún `SECURITY DEFINER` (condición dura heredada de `0027`/`0028`).
-- Ninguna columna nueva — sin entrada nueva en `clasificacion-campos.ts`.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

alter table pendiente_cierre drop constraint uq_pendiente_cierre_natural;

-- Índice parcial, no constraint de tabla (Postgres no admite predicado en una `unique` de tabla, ya
-- documentado en `0027:324-325`) — mismo idiom que `uq_cierre_periodo_vigente` (`0027`) y
-- `uq_recon_vigente` (`0014`).
create unique index uq_pendiente_cierre_natural
  on pendiente_cierre (cliente_id, cierre_id, fuente_cierre_id, referencia_origen, motivo_codigo)
  nulls not distinct
  where superseded_by_id is null;

alter table pendiente_cierre drop constraint fk_pendiente_cierre_superseded;
alter table pendiente_cierre add constraint fk_pendiente_cierre_superseded
  foreign key (cliente_id, superseded_by_id) references pendiente_cierre (cliente_id, id)
  on delete restrict
  deferrable initially deferred;

commit;
