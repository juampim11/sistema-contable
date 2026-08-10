-- =============================================================================
-- 0009_unicidad_de_cuenta_e_indices.sql — hallazgos de la auditoría de `dba-data`
--
-- El Módulo 1 se construyó **sin el roster técnico dado de alta**. Al crearlo y auditar el
-- resultado punto por punto contra ADR-0001 §5 y ADR-0002 §H.3, el modelo salió bien parado
-- —los siete renglones están en las 10 tablas, y no hay una sola FK simple entre tablas de
-- dominio— pero aparecieron tres cosas. En este orden de importancia:
--
--   1. El invariante que impide `cuenta_ambigua` PERMANENTE. Es el único que cambia el
--      comportamiento del sistema; los otros dos son de plan de ejecución.
--   2. El índice de resolución, reordenado contra la consulta que de verdad se ejecuta.
--   3. Un índice al que le falta una columna que la consulta ordena.
--
-- ⚠️ **No se puede usar una `exclusion constraint` sobre `daterange`**: la parte de igualdad
--    (`cliente_id`) exige `btree_gist`, y ADR-0000 §6 prohíbe extensiones no-core — es lo que
--    mantiene el aislamiento portable. Los índices únicos parciales de abajo son la mejor
--    aproximación con Postgres core: cierran el caso que produce la ambigüedad **permanente**
--    (dos vigencias abiertas), no todo solapamiento posible.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. 🔴 Una sola vigencia ABIERTA por identificador y por cliente
-- -----------------------------------------------------------------------------
--
-- ## El bug, que es funcional y no de estilo
--
-- `uq_cuenta_ident_cbu_cliente (cliente_id, cbu_hmac, vigente_desde)` **no alcanza**, porque
-- `vigente_desde` sale del **período del resumen con el que se corrió el alta**
-- (`apps/cli/src/alta-cuenta.ts`). Correr el alta dos veces con resúmenes de meses distintos
-- crea dos filas perfectamente legítimas para ese `unique` — y **las dos con
-- `vigente_hasta is null`**, o sea las dos vigentes.
--
-- A partir de ahí `resolverCuentaDelExtracto` devuelve **dos candidatas** y todo extracto de
-- esa cuenta cae en `cuenta_ambigua`. **Para siempre**, porque nada lo deshace solo: es
-- exactamente el modo de falla que `0006` §3 describe con esas palabras, y que el esquema no
-- impedía.
--
-- Con este índice el segundo alta falla con `23505` (`ING_DUPLICADO`, ya traducido) en vez de
-- crear la ambigüedad, y la operación correcta pasa a ser **explícita**: cerrar la vigencia
-- anterior antes de abrir la nueva.
--
-- `pepper_id` va ADENTRO a propósito: la rotación incremental de `0006` §3 necesita poder
-- insertar la fila re-hasheada con el pepper nuevo junto a la vieja. Sin él, la rotación
-- quedaría bloqueada por este mismo constraint.
create unique index uq_cuenta_ident_cbu_vigente
  on cuenta_bancaria_identificador (cliente_id, pepper_id, cbu_hmac)
  where cbu_hmac is not null and vigente_hasta is null;

comment on index uq_cuenta_ident_cbu_vigente is
  'Una sola vigencia abierta por (cliente, pepper, CBU). Impide que un segundo alta desde el '
  'resumen de otro mes deje dos identificadores vigentes: el resolver devolveria dos '
  'candidatas y la cuenta quedaria en `cuenta_ambigua` de forma permanente. `pepper_id` va '
  'adentro para no bloquear la rotacion incremental de 0006.';

-- La MISMA garantía por número, que es **la rama que el CLI ejecuta de verdad** y que no
-- tenía ninguna unicidad.
--
-- Medido por la auditoría: `apps/cli/src/ingestar.ts` pasa `numeroDeclarado` y **nunca**
-- `cbuDeclarado`, así que la rama del CBU en el resolver está muerta en producción y la viva
-- —la del número— era la única sin proteger.
--
-- Se normaliza a dígitos porque es **como compara el resolver**: el banco escribe el número
-- con guiones o barras según el documento. `regexp_replace/4` es `IMMUTABLE` (verificado
-- contra `pg_proc` antes de aplicar), que es lo que permite usarla en un índice.
create unique index uq_cuenta_ident_numero_vigente
  on cuenta_bancaria_identificador (cliente_id, (regexp_replace(numero, '\D', '', 'g')))
  where vigente_hasta is null;

comment on index uq_cuenta_ident_numero_vigente is
  'La misma garantia que uq_cuenta_ident_cbu_vigente, por el numero normalizado a digitos: es '
  'la rama que el CLI ejecuta (nunca pasa cbuDeclarado) y era la unica sin ninguna unicidad.';

-- -----------------------------------------------------------------------------
-- 2. El índice de resolución, contra la consulta real
-- -----------------------------------------------------------------------------
--
-- `0006` lo creó como `(cliente_id, pepper_id, cbu_hmac)` con este argumento escrito: *"el
-- índice de resolución lleva la versión: una consulta que no la filtre compararía contra
-- digests de otra versión"*. **Pero el resolver no filtra por `pepper_id`** — solo lo hace el
-- alta—, así que la premisa del diseño no está implementada y la columna del medio queda sin
-- condición: `cbu_hmac` se degrada a filtro dentro del índice en vez de dar posicionamiento.
--
-- Con `(cliente_id, cbu_hmac, pepper_id)` **las dos consultas quedan servidas**: el resolver
-- posiciona por las dos primeras, y el alta —que sí filtra `pepper_id`— posiciona igual y lo
-- aplica como filtro sobre un conjunto ya de una o dos filas. Ninguna de las dos pierde.
drop index idx_cuenta_ident_resolucion;

create index idx_cuenta_ident_resolucion
  on cuenta_bancaria_identificador (cliente_id, cbu_hmac, pepper_id)
  where cbu_hmac is not null;

-- -----------------------------------------------------------------------------
-- 3. `fila_numero` en el índice del lote
-- -----------------------------------------------------------------------------
--
-- `leerFilasOrigenDeLote` ordena por `m.fila_numero` y hoy paga un sort. Es **el mismo número
-- de índices** con una columna más, y sirve además a la consulta natural *"los movimientos de
-- este lote en orden de lectura"*, que es la de revisión del lote.
--
-- Con 1346 filas el sort cuesta poco: esto se hace porque es gratis, no porque urja.
drop index idx_mov_crudo_lote;

create index idx_mov_crudo_lote
  on movimiento_bancario_crudo (cliente_id, lote_ingesta_id, fila_numero);

commit;
