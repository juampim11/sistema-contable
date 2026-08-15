-- =============================================================================
-- 0015_search_path_pg_temp.sql — cierre de la escalada de privilegios por
-- shadowing de `pg_temp` en las funciones de tenancía
--
-- 🔴 SEVERIDAD: CRÍTICA. Esta migración cierra una vulnerabilidad que permitía a
-- CUALQUIER usuario con la credencial ordinaria de la aplicación —sin ser
-- superusuario ni tener BYPASSRLS— leer y ESCRIBIR los datos de todos los demás
-- clientes y de todos los demás estudios de la instancia.
--
-- Ver la entrada dedicada de `HANDOFF.md` y el incidente #1 de
-- `docs/seguridad/registro-incidentes.md`.
--
-- ## El mecanismo
--
-- `pg_temp` se busca PRIMERO para nombres de RELACIÓN y de TIPO, aunque NO esté
-- listado en el `search_path`. Las funciones de tenancía declaraban
-- `set search_path = public, app` y leían `membership`/`tenant_node` SIN
-- calificar el esquema, así que leían lo que el atacante plantara en `pg_temp`.
-- Y las dos `security definer` corren con el dueño del esquema, que en los
-- entornos actuales es superusuario, así que adentro la RLS ni se evalúa.
--
-- Medido con la credencial `app_request` y un usuario con membresía en UN nodo:
--
--                                          baseline   con la trampa plantada
--   tenant_node                                   1  ->  5   (los dos estudios)
--   movimiento_bancario_crudo                     1  ->  2   (100 %)
--   has_role_on(<raíz del estudio ajeno>, socio)  —  ->  true
--
-- Ese `true` es lo que hace que NO sea sólo una fuga de lectura: `has_role_on`
-- es el `with check` de las policies de ESCRITURA, así que el vector habilita
-- insertarse una membresía real sobre el estudio ajeno — una escalada que
-- sobreviviría a este mismo fix. Estado verificado antes de aplicar: cero
-- incoherencias de `path` y cero membresías inesperadas en las dos bases.
--
-- ## Las tres mitades, y hacen falta las tres
--
--   (a) CALIFICAR EL ESQUEMA en los cuerpos -> cierra las 6 funciones de hoy.
--   (b) `set search_path` con `pg_temp` ÚLTIMO -> saca a `pg_temp` de la
--       posición implícita-primera, cubre la referencia que quede colgada
--       mañana, y cubre además el secuestro de NOMBRES DE TIPO.
--   (c) `revoke temporary` -> cierra la CLASE entera, incluida la función que
--       alguien escriba dentro de seis meses.
--
-- Medido: con el `search_path` nuevo y el cuerpo SIN calificar, la función ya
-- lee la tabla real (4005 filas) en vez de la trampa (777). O sea que (b) sola
-- ya corrige; (a) la acompaña porque un nombre calificado es inmune al
-- `search_path` sea cual sea, y (c) porque las dos primeras protegen a estas
-- seis y no a la séptima.
--
-- ## 🔴 `app.current_user_id()` NO SE TOCA, Y ES DELIBERADO
--
-- Una cláusula `SET` INHABILITA EL INLINING de funciones SQL. `current_user_id()`
-- hoy se inlinea dentro de `app.has_role_on()` y dentro de las policies; con
-- `SET`, `has_role_on` pasa de ~131 µs a ~230 µs por llamada (+75 % medido), y
-- esa función corre en el predicado de RLS de TODA tabla de dominio.
--
-- Y no lo necesita: `pg_temp` se busca primero para relaciones y tipos, NUNCA
-- para nombres de función u operador, así que `current_setting` es infalsificable
-- por esta vía. Si alguien "completa la tanda por simetría", degrada el sistema
-- entero a cambio de nada.
--
-- ## Por qué `create or replace` y NUNCA `drop`/`create`
--
-- No es preferencia de estilo: 49 policies dependen de `accessible_tenant_ids` y
-- 37 de `has_role_on`. Un `drop` falla por dependencia, y un `drop … cascade`
-- BORRA LAS 49 POLICIES EN SILENCIO, dejando tablas con `force row level
-- security` y sin ninguna policy. `create or replace` preserva OID, dueño y ACL
-- (verificado fila por fila), así que los `revoke`/`grant` de 0001:294-300 NO se
-- re-emiten. Los 15 triggers sobre `exigir_nodo_cliente` siguen enganchados
-- porque `pg_trigger.tgfoid` guarda el OID, que se conserva.
--
-- Lo que SÍ hay que re-declarar en cada cuerpo, porque `create or replace`
-- reemplaza la definición completa: la volatilidad (`stable`), el
-- `security definer` de las dos, y la cláusula `set search_path`.
--
-- ⚠️ NO HACE FALTA RECICLAR CONEXIONES al desplegar. Verificado con una conexión
-- viva, sin cerrarla y con la trampa todavía plantada en su `pg_temp`: la fuga se
-- cierra en la transacción siguiente, en el mismo backend.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Las seis funciones que leen una relación (o declaran un tipo)
-- -----------------------------------------------------------------------------

create or replace function app.tenant_node_set_path() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_path_padre text;
begin
  if new.parent_id is null then
    new.path := new.nid::text;
  else
    select path into v_path_padre from public.tenant_node where id = new.parent_id;
    if v_path_padre is null then
      raise exception 'parent_id % inexistente', new.parent_id;
    end if;
    new.path := v_path_padre || '.' || new.nid::text;
  end if;
  return new;
end $$;

-- 🔴 ENTRA EN LA TANDA AUNQUE NO LEA NINGUNA RELACIÓN. Declara una variable
-- `text`, y `pg_temp` se busca primero también para NOMBRES DE TIPO: un
-- `create temp table text (a int, b int)` crea el tipo compuesto `pg_temp.text` y
-- secuestra la declaración (demostrado: "malformed record literal"). Por eso
-- `pg_catalog` va explícito y PRIMERO, no por prolijidad.
create or replace function app.rechazar_path_manual() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if new.path is distinct from old.path
     and coalesce(current_setting('app.reparentando', true), '') <> 'on' then
    raise exception
      'tenant_node.path no se edita a mano (% -> %): usá app.reparentar_nodo()', old.path, new.path;
  end if;
  return new;
end $$;

create or replace function app.verificar_coherencia_path()
  returns table (id uuid, path_actual text, path_esperado text)
  language sql stable
  set search_path = pg_catalog, public, app, pg_temp
as $$
  select n.id, n.path,
         coalesce(p.path || '.', '') || n.nid::text
    from public.tenant_node n
    left join public.tenant_node p on p.id = n.parent_id
   where n.path <> coalesce(p.path || '.', '') || n.nid::text
$$;

create or replace function app.reparentar_nodo(p_nodo uuid, p_nuevo_padre uuid) returns void
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_path_viejo text;
  v_path_nuevo text;
  v_path_padre text;
  v_nid        bigint;
begin
  -- Habilita la reescritura de path SOLO dentro de esta transacción (local = true).
  perform set_config('app.reparentando', 'on', true);

  select path, nid into v_path_viejo, v_nid from public.tenant_node where id = p_nodo;
  if v_path_viejo is null then
    raise exception 'nodo % inexistente', p_nodo;
  end if;

  select path into v_path_padre from public.tenant_node where id = p_nuevo_padre;
  if v_path_padre is null then
    raise exception 'nuevo padre % inexistente', p_nuevo_padre;
  end if;

  -- No se puede colgar un nodo de su propio subárbol (ciclo).
  if v_path_padre = v_path_viejo or v_path_padre like v_path_viejo || '.%' then
    raise exception 'ciclo: % está dentro del subárbol de %', p_nuevo_padre, p_nodo;
  end if;

  v_path_nuevo := v_path_padre || '.' || v_nid::text;

  update public.tenant_node
     set path       = v_path_nuevo || substring(path from length(v_path_viejo) + 1),
         updated_at = now()
   where path = v_path_viejo or path like v_path_viejo || '.%';

  update public.tenant_node set parent_id = p_nuevo_padre, updated_at = now() where id = p_nodo;

  -- Falla cerrado: si la reescritura dejó el árbol incoherente, se aborta la transacción entera.
  if exists (select 1 from app.verificar_coherencia_path()) then
    raise exception 'reparentado abortado: el árbol quedó incoherente';
  end if;
end $$;

-- 🔴 EL VECTOR PRINCIPAL. `security definer` y `stable` se RE-DECLARAN: sin
-- `stable` volvería a `volatile` y se evaluaría por fila en vez de una vez por
-- consulta, sobre el predicado de RLS de todas las tablas.
create or replace function app.accessible_tenant_ids() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
  select distinct d.id
  from public.membership m
  join public.tenant_node n on n.id = m.tenant_node_id
  join public.tenant_node d on d.path = n.path or d.path like n.path || '.%'
  where m.user_id = app.current_user_id()
    and m.activo
    and n.deleted_at is null
    and d.deleted_at is null
$$;

-- 🔴 EL SEGUNDO VECTOR, Y EL QUE MÁS DUELE: `has_role_on` ES el control de N2-R
-- (0002 §H.3 punto 4). Comprometida, las cuatro tablas restringidas se leían
-- igual que cualquier otra — el CUIT en claro de los socios, el número de cuenta
-- entero, y la fila cruda del extracto con los CUIT de TERCEROS que nunca fueron
-- clientes de nadie.
create or replace function app.has_role_on(nodo_objetivo uuid, roles app.rol_membership[])
  returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
  select exists (
    select 1
    from public.membership m
    join public.tenant_node mn on mn.id = m.tenant_node_id
    join public.tenant_node tn on tn.id = nodo_objetivo
    where m.user_id = app.current_user_id()
      and m.activo
      and m.rol = any(roles)
      and (tn.path = mn.path or tn.path like mn.path || '.%')
  )
$$;

-- Renglón (3) de la plantilla de ADR-0001 §5: está en 15 tablas de dominio.
-- SIN `security definer`, igual que en 0001 — el falla-cerrado depende de eso.
--
-- ⚠️ El comentario de 0001:249-251 decía que "falla cerrado" porque la RLS de
-- `tenant_node` filtraría la fila. Con la trampa plantada eso era FALSO por dos
-- motivos a la vez: leía otra tabla, Y una tabla temporal no lleva policies.
create or replace function app.exigir_nodo_cliente() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if not exists (
    select 1 from public.tenant_node n
     where n.id = new.cliente_id
       and n.tipo = 'cliente'
       and n.deleted_at is null
  ) then
    raise exception 'cliente_id % no es un nodo activo de tipo cliente', new.cliente_id;
  end if;
  return new;
end $$;

-- `app.current_user_id()` NO se toca. Ver el encabezado.

-- -----------------------------------------------------------------------------
-- 2. El control que cierra la CLASE, no el caso
-- -----------------------------------------------------------------------------
--
-- Sin privilegio `TEMPORARY` no se puede crear el objeto que shadowea, y eso vale
-- para toda función presente y futura. `PUBLIC` lo conserva por default en
-- PostgreSQL y este esquema nunca lo revocó.
--
-- Va por SQL dinámico porque `revoke … on database` acepta SOLO un identificador
-- literal: ni `current_database()` ni un parámetro. Así la migración es la misma
-- en local, CI, piloto y producción. Es transaccional e idempotente.
--
-- NO toca CONNECT: el `datacl` queda `{=c/dueño, dueño=CTc/dueño}`. Verificado
-- que no rompe nada: el runner de migraciones corre como dueño (que conserva el
-- privilegio por serlo), `pg_dump -F c` no crea objetos temporales, el pooling no
-- los usa, las tablas de los tests son PERMANENTES, y el barrido del repo no
-- encontró un solo `create temp`.
do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
end $$;

-- -----------------------------------------------------------------------------
-- 3. Deuda de 0001 que vive en el mismo renglón
-- -----------------------------------------------------------------------------
--
-- 0001:294-295 revocó el `execute` de PUBLIC SOLO de las dos `security definer`.
-- Las otras dos quedaron con el default de PUBLIC, así que hasta esta migración
-- `app_request` PODÍA INVOCAR `app.reparentar_nodo()` — la función que reescribe
-- los `path` sobre los que `accessible_tenant_ids()` resuelve el subárbol, o sea
-- el vector H-1 de ADR-0002 directamente invocable desde la credencial de la app.
--
-- Verificado que revocarlo no rompe la suite: `reparentar_nodo` sólo se invoca en
-- la PASADA 1 de `0001_aislamiento.test.sql`, guardada por `rolbypassrls and not
-- rolsuper` (= `app_job`), y `verificar_coherencia_path` desde `catalogo.test.ts`
-- con `clienteDuenio()`.
revoke all on function app.reparentar_nodo(uuid, uuid) from public;
revoke all on function app.verificar_coherencia_path() from public;
grant execute on function app.reparentar_nodo(uuid, uuid) to app_job;
grant execute on function app.verificar_coherencia_path() to app_job;

commit;
