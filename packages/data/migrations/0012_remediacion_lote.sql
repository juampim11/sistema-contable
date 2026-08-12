-- =============================================================================
-- 0012_remediacion_lote.sql — `lote_ingesta.motivo_codigo_previo`, para la remediación
-- de un lote atrapado por el bug de atomicidad de HANDOFF 2026-08-11 (40)/(41)
--
-- El bug (ya corregido en apps/cli/src/ingestar.ts, sin migración): antes del SAVEPOINT de (40), un
-- archivo multi-cuenta donde una cuenta se persistía con éxito y otra fallaba después dejaba el lote
-- entero `estado='con_errores'`, con la primera cuenta comiteada de todas formas. `completar-lote.ts`
-- (HANDOFF (42)) remedia esos lotes ya existentes agregando la cuenta que faltaba, sin tocar ni
-- rehacer lo que ya era correcto.
--
-- `motivo_codigo_previo` es la traza legible de esa remediación, en el propio lote: NULL si el lote
-- nunca se remedió; si no es NULL, es el `motivo_codigo` que el lote tenía ANTES de completarse.
--
-- ## Por qué acá y no en `lote_ingesta_cuenta.verificacion_detalle` (que ya existe)
--
-- `verificacion_detalle` es POR CUENTA — documenta el resultado de la verificación aritmética de esa
-- cuenta puntual. Una nota sobre "este LOTE se remedió" ahí mezclaría dos conceptos de alcance
-- distinto: cualquier lectura futura de `verificacion_detalle` esperando solo diferencias de esa
-- cuenta se encontraría con metadata de otra cosa (`dba-data`, convocatoria de HANDOFF (42)).
--
-- ## Por qué `text` sin `check`, igual que `motivo_codigo`
--
-- El dominio de valores que puede pasar por acá es grande y evolutivo: `MOTIVOS_TECNICOS`
-- (`apps/cli/src/ingestar.ts`), los cuatro estados de fracaso de `ResolucionDeCuenta`
-- (`packages/ingesta/src/resolver-cuenta.ts`), y los códigos de `CODIGOS_DIFERENCIA` que puede
-- devolver `estadoSegunVerificacion`. `motivo_codigo` (0004) ya tomó esta misma decisión por el mismo
-- motivo — un `check` acá y no ahí sería inconsistente, y mantenerlo sincronizado con tres archivos TS
-- distintos es la clase de segunda-lista-que-diverge que este proyecto evita a propósito.
--
-- ## Por qué NO es N2, y por qué no hace falta una columna de correlación
--
-- Solo puede contener CÓDIGOS del vocabulario cerrado — nunca texto libre del operador, nunca un dato
-- leído del PDF (`completar-lote.ts` no expone ningún camino para eso). Sigue siendo N1, mismo nivel
-- que `motivo_codigo` (`seguridad-datos-financieros`, condición explícita de su revisión).
--
-- El puente hacia el registro completo de auditoría (quién completó el lote, cuándo, con qué
-- credencial) NO necesita una columna nueva: `registrarAcceso(tx, {recurso:'lote_ingesta', recursoId:
-- lote_ingesta.id, ...})` ya ata cada fila de `acceso_auditoria` al lote por `recurso_id` — una clave
-- exacta, no una búsqueda por rango de fecha. Para pivotear desde acá: `select * from acceso_auditoria
-- where recurso = 'lote_ingesta' and recurso_id = <lote_ingesta.id> order by ocurrido_en`.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

alter table lote_ingesta
  add column motivo_codigo_previo text;

comment on column lote_ingesta.motivo_codigo_previo is
  'NULL si el lote nunca se remedió. Si no es NULL, es el motivo_codigo que tenía este lote ANTES de '
  'completarse por apps/cli/src/completar-lote.ts (HANDOFF 2026-08-11 (42)) — CÓDIGO del vocabulario '
  'cerrado, nunca un mensaje, mismo criterio que motivo_codigo. Para el registro completo de quién '
  'completó el lote y cuándo: select * from acceso_auditoria where recurso = ''lote_ingesta'' and '
  'recurso_id = lote_ingesta.id order by ocurrido_en.';

commit;
