-- =============================================================================
-- 0028_inmutabilidad_post_terminal_cierre.sql — cierra el hallazgo BLOQUEANTE de HANDOFF (130)
--
-- `0027_cierre_mensual.sql` otorgó `grant select, insert, update` A NIVEL TABLA COMPLETA sobre
-- `cierre_cliente_periodo` (línea 372) y `asiento_propuesto` (línea 784) — sin acotar columnas, a
-- diferencia de las otras 9 tablas de esa misma migración. `security-engineer` encontró que esto
-- permite a un `socio`/`contador` (el rol CORRECTO, no uno insuficiente) reescribir
-- `confirmado_por`/`confirmado_en`/`periodo_desde`/`periodo_hasta` de un cierre YA `confirmado`, o
-- `fecha_imputacion` de un asiento ya `confirmado`, sin pasar por ningún gate y sin dejar rastro en
-- `cierre_transicion` — porque la policy pensada para la transición oficial
-- (`cierre_periodo_upd_cierre`/`asiento_propuesto_upd_confirmar`) no restringe por valor, y las
-- policies permisivas del mismo comando se combinan por OR.
--
-- ## Convocatoria real: un desacuerdo técnico, resuelto por verificación empírica, no por autoridad
--
-- `arquitecto-software`, `dba-data` y `security-engineer` coincidieron en que acotar el grant por
-- columna (mismo idioma que el resto de `0027`) es necesario pero NO alcanza solo: las columnas que
-- la transición legítima necesita seguir escribiendo (`confirmado_por`/`confirmado_en`) quedan
-- igual de atacables si no hay una segunda capa.
--
-- `dba-data` propuso cerrar el resto agregando una condición de valor al `USING` de
-- `cierre_periodo_upd_cierre` (sin trigger nuevo). `arquitecto-software` objetó que eso NO funciona
-- contra este esquema: ya existe una policy `FOR SELECT` con visibilidad total del tenant
-- (`cierre_periodo_sel`), y esa policy por sí sola garantiza que la fila es "visible" para el
-- `UPDATE`, sin importar qué diga el `USING` de las policies de `UPDATE` — así que un `USING` más
-- estricto en una sola policy no cierra nada mientras cualquier OTRA policy permisiva siga sin
-- restricción.
--
-- Verificado EMPÍRICAMENTE contra Postgres real (transacciones de prueba con rollback, reproduciendo
-- la forma exacta de las policies): con el fix de `dba-data`, el ataque PASÓ. Con un trigger
-- `BEFORE UPDATE` (sin `OF <columna>`, invoker, sin `SECURITY DEFINER`) que rechaza cualquier UPDATE
-- cuando la fila vieja ya está en un estado terminal, el ataque quedó bloqueado y la transición
-- legítima siguió funcionando sin cambios. `arquitecto-software` tenía razón.
--
-- Alcance ampliado por JP durante el plan: `pendiente_cierre_upd_dispensa` tiene la misma forma de
-- bug (sin restricción de valor, deja reescribir `resuelto_por`/`resuelto_en`/`resolucion_id` de un
-- pendiente ya terminal) — mismo mecanismo, misma migración, con el pedido explícito de que el
-- trigger sea GENÉRICO y se aplique tal cual a esta tercera tabla, no una variante puntual, como
-- forma de confirmar que el diseño generaliza.
--
-- `seguridad-datos-financieros` encontró dos correcciones antes de escribir este archivo:
--   1. El trigger NUNCA interpola valores de `old`/`new` en el mensaje de excepción. `cierre_estado`
--      está clasificado N2 (`clasificacion-campos.ts`: "agregado de todo un período de un cliente,
--      revela su puntualidad contable real") — un mensaje que incluyera su valor filtraría
--      exactamente el hecho que esa clasificación protege. El mensaje solo nombra la COLUMNA (metadato
--      de esquema, vía `TG_ARGV`) y el `id` de la fila (N1) — mismo criterio que ya usa
--      `app.verificar_gate_confirmacion_cierre()` (línea 916-942 de `0027`, arma su mensaje solo con
--      `new.id` y un `count(*)`, nunca con contenido de fila).
--   2. Faltaba `'superseded'` en la lista de terminales de `asiento_propuesto`: sin eso, una fila ya
--      `superseded` puede "revivirse" a `'propuesto'` por cualquier rol, sin dejar rastro (ninguna
--      policy protege `'superseded'` como origen ni como destino). Corregido acá.
--
-- Ambigüedad resuelta por `arquitecto-software` (seguimiento puntual): la transición legítima de
-- supersesión escribe DOS columnas a la vez — la de estado (a `'superseded'`) Y el puntero
-- (`superseded_by_id`, de null a no-null) — no solo el puntero. Evidencia: `documento_ingerido` es la
-- ÚNICA tabla de `0027` que resuelve supersesión con SOLO el puntero, y lo dice explícito ("no hay un
-- 'estado' que restringir por rol acá, a diferencia de `cierre_cliente_periodo`", línea 271-273). Si
-- `asiento_estado`/`pendiente_estado` nunca fueran a valer `'superseded'` en la práctica, ese valor
-- del `CHECK` sería un vocabulario muerto sin árbitro real — y el pie de `0027` exige que cada
-- `CHECK col in (...)` tenga su árbitro en `packages/data/src/cierre/tipos.ts`.
--
-- ## Por qué NO hay trigger para `cierre_cliente_periodo` con excepción de supersesión
--
-- D-6 (`docs/diseno/23-arquitectura-cierre-mensual.md` §2.4): "Supersesión para contenido; máquina de
-- estados + historial para el cierre". La tabla de esa sección asigna EXPLÍCITAMENTE
-- `cierre_cliente_periodo` a "máquina de estados + `cierre_transicion` append-only — no se
-- supersede", a diferencia de `asiento_propuesto`/`pendiente_cierre`, que sí están en la fila
-- "Supersesión". Por eso el trigger de esta tabla no lleva columna de supersesión: una vez
-- `confirmado`/`anulado`, NINGÚN UPDATE la toca, sin excepción.
--
-- Nota aparte, declarada a propósito (no es una omisión): esa misma sección (línea 612) dice que
-- "reabrir un período confirmado" (`confirmado → en_revision`) es una capacidad PREVISTA para el
-- futuro, no implementada hoy. Este trigger la bloquea, como corresponde al estado actual del
-- proyecto — quien implemente la reapertura más adelante tiene que tocar este trigger explícitamente,
-- con su propia decisión de diseño, no encontrarlo bloqueando por sorpresa.
--
-- Ninguna función/trigger nuevo con `SECURITY DEFINER` (condición dura heredada de `0027`). Invoker
-- en los tres casos: la consulta es intra-fila (`old`/`new` de la propia fila que ya pasó RLS), sin
-- necesidad de privilegios elevados.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Grant de UPDATE acotado a columnas explícitas (mismo idioma que el resto de `0027`)
-- -----------------------------------------------------------------------------
--
-- `pendiente_cierre` no cambia acá: ya estaba acotado por columna desde `0027`
-- (`grant update (pendiente_estado, resuelto_por, resuelto_en, resolucion_id, superseded_by_id)`) —
-- su hallazgo era puramente de RLS/trigger, no de grant.

revoke update on cierre_cliente_periodo from app_request;
grant update (cierre_estado, confirmado_en, confirmado_por) on cierre_cliente_periodo to app_request;

revoke update on asiento_propuesto from app_request;
grant update (asiento_estado, superseded_by_id) on asiento_propuesto to app_request;

-- -----------------------------------------------------------------------------
-- 2. La función genérica de inmutabilidad post-terminal
-- -----------------------------------------------------------------------------
--
-- Parametrizada vía argumentos del trigger (`TG_ARGV`), para que la MISMA función sirva en las tres
-- tablas sin código bespoke (pedido explícito de JP, para confirmar que el diseño generaliza):
--   TG_ARGV[0] = nombre de la columna de estado (ej. 'cierre_estado')
--   TG_ARGV[1] = estados terminales, separados por coma (ej. 'confirmado,anulado')
--   TG_ARGV[2] = nombre de la columna de supersesión, o '' si la tabla no admite supersesión
--
-- La única transición permitida sobre una fila cuyo estado viejo YA es terminal es: el estado nuevo
-- pasa a `'superseded'` (nunca de vuelta a sí mismo: una fila `superseded` es terminal sin salida) Y
-- la columna de supersesión pasa de `null` a no-null Y ningún otro campo cambia. Cualquier otra
-- combinación se rechaza — incluida la reescritura silenciosa de una columna que sigue siendo
-- grantable por privilegio (`confirmado_por`, `confirmado_en`, etc.), que es exactamente el vector
-- que motiva esta migración.
create or replace function app.exigir_inmutabilidad_post_terminal() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_columna_estado    text    := tg_argv[0];
  v_terminales        text[]  := string_to_array(tg_argv[1], ',');
  v_columna_supersede text    := nullif(tg_argv[2], '');
  v_old               jsonb   := to_jsonb(old);
  v_new               jsonb   := to_jsonb(new);
  v_estado_viejo      text    := v_old ->> v_columna_estado;
  v_es_supersesion    boolean := false;
begin
  -- Si el estado viejo no es terminal, esta regla no aplica: el resto del esquema (RLS + el gate de
  -- D-24 para `cierre_estado`) sigue gobernando la transición como ya lo hacía.
  if v_estado_viejo is null or not (v_estado_viejo = any(v_terminales)) then
    return new;
  end if;

  -- La única excepción: fijar el puntero de supersesión Y mover el estado a 'superseded' juntos, sin
  -- que cambie ningún otro campo. Una fila YA 'superseded' no tiene excepción (v_estado_viejo <>
  -- 'superseded' lo excluye) — terminal sin salida, ni siquiera hacia sí misma.
  if v_columna_supersede is not null
     and v_estado_viejo <> 'superseded'
     and (v_new ->> v_columna_estado) = 'superseded'
     and (v_old ->> v_columna_supersede) is null
     and (v_new ->> v_columna_supersede) is not null
  then
    v_es_supersesion :=
      (v_new - v_columna_estado - v_columna_supersede) = (v_old - v_columna_estado - v_columna_supersede);
  end if;

  if v_es_supersesion then
    return new;
  end if;

  -- El mensaje NUNCA interpola valores de `old`/`new` (seguridad-datos-financieros, esta migración):
  -- solo nombra la columna (metadato de esquema) y el id de la fila (N1) — nunca el valor que esa
  -- columna tenía, que puede ser N2 (`cierre_estado`).
  raise exception
    'fila inmutable en %.% (id=%): la columna % ya está en un estado terminal — este UPDATE no es la '
    'transición legítima de supersesión (D-24/D-6, migración 0028)',
    tg_table_schema, tg_table_name, (v_old ->> 'id'), v_columna_estado
    using errcode = 'P0002';
end;
$$;

comment on function app.exigir_inmutabilidad_post_terminal() is
  'Cierra HANDOFF (130): grant de UPDATE de tabla completa + policy de confirmación sin restricción '
  'de valor permitían reescribir campos post-confirmación sin gate y sin rastro. Genérica y reusada '
  'en 3 tablas (cierre_cliente_periodo, asiento_propuesto, pendiente_cierre) via TG_ARGV — pedido '
  'explícito de JP para confirmar que el mecanismo generaliza. BEFORE UPDATE SIN "OF <columna>" a '
  'propósito: el ataque real nunca toca la columna de estado. Invoker, sin SECURITY DEFINER (0027). '
  'El mensaje de excepción nunca interpola valores de fila (solo columna + id) — cierre_estado es N2.';

-- -----------------------------------------------------------------------------
-- 3. Los tres triggers — misma función, argumentos distintos por tabla
-- -----------------------------------------------------------------------------

create trigger trg_cierre_periodo_inmutable
  before update on cierre_cliente_periodo
  for each row
  execute function app.exigir_inmutabilidad_post_terminal('cierre_estado', 'confirmado,anulado', '');

comment on trigger trg_cierre_periodo_inmutable on cierre_cliente_periodo is
  'D-6 (23-arquitectura-cierre-mensual.md §2.4): "máquina de estados + cierre_transicion append-only '
  '— no se supersede". Por eso, a diferencia de asiento_propuesto/pendiente_cierre, sin columna de '
  'supersesión: confirmado/anulado son terminales SIN excepción. Nota: `23` línea 612 declara '
  '"reabrir un período confirmado" (confirmado→en_revision) como capacidad PREVISTA para el futuro, '
  'no implementada hoy — quien la implemente tiene que tocar este trigger explícitamente, no es una '
  'omisión.';

create trigger trg_asiento_propuesto_inmutable
  before update on asiento_propuesto
  for each row
  execute function app.exigir_inmutabilidad_post_terminal(
    'asiento_estado', 'confirmado,superseded', 'superseded_by_id');

comment on trigger trg_asiento_propuesto_inmutable on asiento_propuesto is
  'D-6: "supersesión para contenido". confirmado→superseded (fijando superseded_by_id en el mismo '
  'UPDATE) es la única transición admitida sobre una fila confirmada; superseded es terminal sin '
  'salida. Cierra el hallazgo de seguridad-datos-financieros (0028): sin esto, un asiento superseded '
  'podía "revivirse" a propuesto sin rastro.';

create trigger trg_pendiente_cierre_inmutable
  before update on pendiente_cierre
  for each row
  execute function app.exigir_inmutabilidad_post_terminal(
    'pendiente_estado', 'resuelto,dispensado,superseded', 'superseded_by_id');

comment on trigger trg_pendiente_cierre_inmutable on pendiente_cierre is
  'Misma función genérica que cierre_cliente_periodo/asiento_propuesto, sin variante puntual (pedido '
  'de JP: confirma que el diseño generaliza). Cierra el hallazgo NO bloqueante de HANDOFF (130): '
  'resuelto_por/resuelto_en/resolucion_id de un pendiente ya resuelto/dispensado quedaban '
  'reescribibles porque pendiente_cierre_upd_dispensa no restringe por valor.';

-- -----------------------------------------------------------------------------
-- 4. Comentarios en las policies existentes — la inmutabilidad vive en el trigger, no en RLS
-- -----------------------------------------------------------------------------
--
-- No se modifica la lógica de ninguna policy: `dba-data` propuso agregarles una condición de valor al
-- `USING`, y se verificó que NO cierra nada (ver cabecera) porque la policy `FOR SELECT` ya da
-- visibilidad total. Dejar esto escrito para que nadie repita el intento pensando que sí funciona.

comment on policy cierre_periodo_upd_cierre on cierre_cliente_periodo is
  'Deliberadamente amplia en valor (no restringe por cierre_estado viejo): la inmutabilidad '
  'post-terminal vive en trg_cierre_periodo_inmutable, no acá. Un USING más estricto en ESTA policy '
  'no cerraría nada mientras cierre_periodo_sel siga dando visibilidad total del tenant para el '
  'UPDATE — verificado empíricamente contra Postgres real, 0028.';

comment on policy asiento_propuesto_upd_confirmar on asiento_propuesto is
  'Deliberadamente amplia en valor — mismo motivo que cierre_periodo_upd_cierre. La inmutabilidad '
  'post-terminal vive en trg_asiento_propuesto_inmutable, 0028.';

comment on policy pendiente_cierre_upd_dispensa on pendiente_cierre is
  'Deliberadamente amplia en valor — mismo motivo que cierre_periodo_upd_cierre. La inmutabilidad '
  'post-terminal vive en trg_pendiente_cierre_inmutable, 0028.';

commit;
