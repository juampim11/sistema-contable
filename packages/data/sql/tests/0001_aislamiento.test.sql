-- =============================================================================
-- 0001_aislamiento.test.sql — pruebas de aislamiento multi-tenant contra Postgres REAL
--
-- Verifica los invariantes de ADR-0001 / ADR-0002 que, si se rompen, son una fuga de datos entre
-- clientes de un estudio. No es un test de humo: cada bloque aborta con `raise exception` si el
-- invariante no se cumple.
--
-- SE CORRE EN TRES PASADAS, cada una con el rol que le corresponde. Esa separación ES parte de lo
-- que se prueba: si una sola credencial pudiera hacer las tres, el diseño estaría mal.
--
--   # 0. DDL de la tabla de prueba — DUEÑO DEL ESQUEMA
--   psql "$DATABASE_URL"     -v ON_ERROR_STOP=1 -v ddl=1 -f packages/data/sql/tests/0001_aislamiento.test.sql
--   # 1. Siembra de datos — app_job (BYPASSRLS)
--   psql "$DATABASE_URL_JOB" -v ON_ERROR_STOP=1 -f packages/data/sql/tests/0001_aislamiento.test.sql
--   # 2. Aserciones — rol de request (SUJETO A RLS)
--   psql "$DATABASE_URL_APP" -v ON_ERROR_STOP=1 -f packages/data/sql/tests/0001_aislamiento.test.sql
--
-- DOS COSAS QUE SALIERON DE CORRER ESTO DE VERDAD, no de suponerlas:
--
--   1. La siembra NO la puede hacer el dueño del esquema: `force row level security` le aplica las
--      políticas también a él, y no hay ninguna que permita crear un nodo raíz. Tiene que hacerla
--      app_job. En producción, además, el dueño del esquema NO debe ser superusuario: un
--      superusuario ignora RLS siempre, forzada o no.
--   2. BYPASSRLS saltea las POLÍTICAS, no otorga PRIVILEGIOS: app_job necesita GRANT explícito, y
--      los atributos de rol (LOGIN, BYPASSRLS) NO se heredan por pertenencia.
-- =============================================================================

\set ON_ERROR_STOP on

-- =============================================================================
-- PASADA 0 — DDL: tabla de dominio de prueba, construida con LOS SIETE RENGLONES
--            de la plantilla de ADR-0001 §5. Si la plantilla está mal, el test lo muestra.
-- =============================================================================

\if :{?ddl}

drop table if exists _prueba_dominio;

create table _prueba_dominio (                                                     -- (1)
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references tenant_node(id) on delete restrict,
  descripcion text not null,
  importe     numeric(18,2) not null,
  created_at  timestamptz not null default now()
);

create index idx_prueba_dominio_cliente on _prueba_dominio(cliente_id);                 -- (2)

create trigger trg_prueba_dominio_cliente                                         -- (3)
  before insert or update of cliente_id on _prueba_dominio
  for each row execute function app.exigir_nodo_cliente();

alter table _prueba_dominio enable row level security;                              -- (4)
alter table _prueba_dominio force  row level security;                             -- (5)

create policy prueba_dominio_sel on _prueba_dominio for select                          -- (6)
  using ( cliente_id in (select app.accessible_tenant_ids()) );

create policy prueba_dominio_wr on _prueba_dominio for all
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert, update, delete on _prueba_dominio to app_request;             -- (7)

-- Y a app_job, PORQUE BYPASSRLS NO OTORGA PRIVILEGIOS (solo para poder sembrar el test).
grant select, insert, update, delete on _prueba_dominio to app_job;

-- LIMPIEZA. La hace el dueño del esquema con TRUNCATE, y no la pasada 1 con `delete`.
--
-- Salió de correrlo: `app_job` no tiene ningún privilegio sobre `acceso_auditoria` (más que INSERT) ni
-- sobre las tablas de credenciales — es a propósito. Como esas tablas referencian `tenant_node` con
-- `on delete restrict`, el `delete from tenant_node` de la pasada 1 fallaba por integridad
-- referencial. Limpiar es una operación de mantenimiento del dueño, no de la aplicación; y TRUNCATE es
-- un privilegio de tabla, así que no pasa por las políticas de fila.
truncate credencial_fiscal_rotacion, credencial_fiscal, acceso_auditoria, membership, tenant_node cascade;

-- Reinicio de la secuencia de nid, para que el test sea REPETIBLE.
-- `nid` es una identity global: en la segunda corrida los nid ya no arrancan en 1, y la trampa del
-- path (necesita que coexistan un nid 7 y un nid 70) no se puede construir. Lo hace la pasada 0
-- porque requiere ser dueño de la tabla — app_job tiene BYPASSRLS, no ownership.
alter table tenant_node alter column nid restart with 1;

\echo 'PASADA 0 OK: _prueba_dominio creada, tablas limpias y secuencia de nid reiniciada.'

\endif

-- =============================================================================
-- PASADA 1 — SIEMBRA (solo si el rol actual saltea RLS)
-- =============================================================================

do $$
declare
  v_estudio   uuid;
  v_cliente_a uuid;
  v_cliente_b uuid;
  v_estudio_2 uuid;
  v_cliente_c uuid;
  v_nodo_7    uuid;
  v_nodo_70   uuid;
  v_path_7    text;
  v_path_70   text;
  v_grupo     uuid;
  v_mudado    uuid;
  v_fallo     boolean;
begin
  -- La siembra es para app_job: saltea RLS pero NO es superusuario. Se excluye al superusuario a
  -- propósito, porque un superusuario puede más que app_job (p. ej. borrar la auditoría) y haría
  -- pasar por buenas aserciones que con el rol real fallan.
  if not coalesce((select rolbypassrls from pg_roles where rolname = current_user), false)
     or coalesce((select rolsuper from pg_roles where rolname = current_user), false) then
    raise notice 'PASADA 1 salteada: % no es el rol de jobs (bypassrls y no superusuario)', current_user;
    return;
  end if;

  -- ---- P1-0: NI SIQUIERA app_job puede borrar el rastro de auditoría ---------
  -- BYPASSRLS saltea políticas, no otorga privilegios: a app_job no se le concedió nada sobre
  -- acceso_auditoria. Un rastro que el rol más poderoso de la app puede borrar no es un rastro.
  v_fallo := false;
  begin
    delete from acceso_auditoria;
    v_fallo := true;
  exception when insufficient_privilege then
    null;   -- es el resultado esperado
  end;
  if v_fallo then
    raise exception 'P1-0 FALLA: app_job pudo borrar acceso_auditoria';
  end if;
  raise notice 'P1-0 OK  ni app_job (BYPASSRLS) puede borrar acceso_auditoria';

  -- La limpieza la hizo la pasada 0 (dueño del esquema, con TRUNCATE). Acá solo se siembra: app_job no
  -- tiene privilegios para borrar el rastro de auditoría ni las credenciales, y está bien que no los
  -- tenga. Ver el comentario de la pasada 0.
  delete from _prueba_dominio;

  -- Estudio 1 con dos clientes
  insert into tenant_node (tipo, nombre) values ('estudio', 'Estudio Uno')
    returning id into v_estudio;
  insert into tenant_node (tipo, nombre, parent_id) values ('cliente', 'Cliente A', v_estudio)
    returning id into v_cliente_a;
  insert into tenant_node (tipo, nombre, parent_id) values ('cliente', 'Cliente B', v_estudio)
    returning id into v_cliente_b;

  -- Estudio 2, totalmente ajeno
  insert into tenant_node (tipo, nombre) values ('estudio', 'Estudio Dos')
    returning id into v_estudio_2;
  insert into tenant_node (tipo, nombre, parent_id) values ('cliente', 'Cliente C', v_estudio_2)
    returning id into v_cliente_c;

  insert into membership (user_id, tenant_node_id, rol) values
    ('11111111-1111-1111-1111-111111111111', v_estudio,   'socio'),
    ('22222222-2222-2222-2222-222222222222', v_cliente_a, 'contador'),
    ('33333333-3333-3333-3333-333333333333', v_cliente_b, 'contador'),
    ('44444444-4444-4444-4444-444444444444', v_estudio_2, 'socio');

  -- ---------------------------------------------------------------------------
  -- La trampa del materialized path: hay que forzar que coexistan un path que termine en '.7' y
  -- otro en '.70'. Si el LIKE de subárbol se escribiera `path like X || '%'` (sin el punto), el
  -- dueño de '.7' vería las filas de '.70'. Creamos los nodos para poder probarlo de verdad.
  -- ---------------------------------------------------------------------------
  insert into tenant_node (tipo, nombre, parent_id)
  select 'cliente', 'relleno ' || g, v_estudio_2 from generate_series(1, 90) g;

  -- Se busca el par de forma GENÉRICA: dos nodos donde el path de uno es prefijo del otro SIN que
  -- el corte caiga en un punto. Es la condición exacta de la trampa, sin depender de que los nid
  -- sean justo 7 y 70.
  select a.id, a.path, b.id, b.path
    into v_nodo_7, v_path_7, v_nodo_70, v_path_70
    from tenant_node a
    join tenant_node b
      on b.path <> a.path
     and b.path like a.path || '%'
     and substring(b.path from length(a.path) + 1 for 1) <> '.'
     -- Solo entre nodos de relleno: si el par cayera sobre Cliente A/B/C, esos nodos YA tienen filas
     -- en _prueba_dominio y el conteo de T6 mezclaría dos cosas distintas. (Pasó al correrlo.)
   where a.nombre like 'relleno %' and b.nombre like 'relleno %'
   limit 1;

  if v_nodo_7 is null or v_nodo_70 is null then
    raise exception 'el test no pudo construir el par de prefijo (¿se reinició la secuencia de nid '
                    'en la pasada 0?). Sin este par, T6 no prueba nada.';
  end if;

  insert into membership (user_id, tenant_node_id, rol)
    values ('55555555-5555-5555-5555-555555555555', v_nodo_7, 'contador');

  insert into _prueba_dominio (cliente_id, descripcion, importe) values
    (v_cliente_a, 'A-1',       100.00),
    (v_cliente_a, 'A-2',       -50.00),
    (v_cliente_b, 'B-1',       200.00),
    (v_cliente_c, 'C-1',       300.00),
    (v_nodo_7,    'siete-1',    10.00),
    (v_nodo_70,   'setenta-1',  20.00);

  raise notice 'PASADA 1: sembrado con % (bypassrls). Par de trampa: % vs %',
               current_user, v_path_7, v_path_70;

  -- ---- P1-A: el árbol nace coherente -----------------------------------------
  if exists (select 1 from app.verificar_coherencia_path()) then
    raise exception 'P1-A FALLA: el árbol quedó incoherente al sembrarlo';
  end if;
  raise notice 'P1-A OK  el árbol es coherente (path = path del padre || nid)';

  -- ---- P1-B: el path NO se edita a mano (H-1) --------------------------------
  v_fallo := false;
  begin
    update tenant_node set path = '999' where id = v_cliente_a;
    v_fallo := true;
  exception when others then
    null;  -- rechazado por trg_tenant_node_path_manual: es lo esperado
  end;
  if v_fallo then
    raise exception 'P1-B FALLA: se pudo editar tenant_node.path a mano';
  end if;
  raise notice 'P1-B OK  editar tenant_node.path a mano está rechazado';

  -- ---- P1-C: cambiar parent_id RECALCULA el path (el bug que tenía el diseño) -
  -- Sin trigger BEFORE UPDATE, acá el path quedaba viejo y el subárbol accesible se corrompía:
  -- un usuario del estudio 1 empezaba a ver clientes del estudio 2, en silencio.
  insert into tenant_node (tipo, nombre, parent_id) values ('grupo', 'Grupo X', v_estudio)
    returning id into v_grupo;
  insert into tenant_node (tipo, nombre, parent_id) values ('cliente', 'Mudado', v_estudio)
    returning id into v_mudado;

  update tenant_node set parent_id = v_grupo where id = v_mudado;

  if (select path from tenant_node where id = v_mudado)
     <> (select path from tenant_node where id = v_grupo) || '.' ||
        (select nid::text from tenant_node where id = v_mudado) then
    raise exception 'P1-C FALLA: cambiar parent_id no recalculó el path';
  end if;
  if exists (select 1 from app.verificar_coherencia_path()) then
    raise exception 'P1-C FALLA: el árbol quedó incoherente tras cambiar parent_id';
  end if;
  raise notice 'P1-C OK  cambiar parent_id recalcula el path y el árbol sigue coherente';

  -- ---- P1-D: reparentar un subárbol entero mantiene la coherencia ------------
  perform app.reparentar_nodo(v_mudado, v_estudio);
  if exists (select 1 from app.verificar_coherencia_path()) then
    raise exception 'P1-D FALLA: app.reparentar_nodo dejó el árbol incoherente';
  end if;
  -- y no se puede colgar un nodo de su propio subárbol
  v_fallo := false;
  begin
    perform app.reparentar_nodo(v_estudio, v_cliente_a);
    v_fallo := true;
  exception when others then
    null;
  end;
  if v_fallo then raise exception 'P1-D FALLA: se permitió crear un ciclo en el árbol'; end if;
  raise notice 'P1-D OK  reparentar mantiene coherencia y rechaza ciclos';

  -- Limpieza de los nodos auxiliares del test de reparentado
  delete from tenant_node where id in (v_mudado, v_grupo);

  raise notice '=== PASADA 1 COMPLETA (P1-A..P1-D) ===';
end $$;

-- =============================================================================
-- PASADA 2 — ASERCIONES (solo si el rol actual está SUJETO a RLS y no es superusuario)
-- =============================================================================

do $$
declare
  v_n     integer;
  v_est   uuid;
  v_fallo boolean;
begin
  if coalesce((select rolbypassrls from pg_roles where rolname = current_user), false)
     or coalesce((select rolsuper from pg_roles where rolname = current_user), false) then
    raise notice 'PASADA 2 salteada: % saltea RLS o es superusuario', current_user;
    return;
  end if;

  -- ---- T1: sin identidad seteada, no se ve NADA (falla cerrado) --------------
  perform set_config('app.user_id', '', true);
  select count(*) into v_n from _prueba_dominio;
  if v_n <> 0 then raise exception 'T1 FALLA: sin app.user_id se ven % filas de dominio', v_n; end if;
  select count(*) into v_n from tenant_node;
  if v_n <> 0 then raise exception 'T1 FALLA: sin app.user_id se ven % nodos', v_n; end if;
  select count(*) into v_n from membership;
  if v_n <> 0 then raise exception 'T1 FALLA: sin app.user_id se ven % membresías', v_n; end if;
  raise notice 'T1  OK  sin identidad -> 0 filas, 0 nodos, 0 membresías (falla cerrado)';

  -- ---- T2: el contador de A ve SOLO A ---------------------------------------
  perform set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true);
  select count(*) into v_n from _prueba_dominio;
  if v_n <> 2 then raise exception 'T2 FALLA: contador de A ve % filas (deberían ser 2)', v_n; end if;
  if exists (select 1 from _prueba_dominio where descripcion not like 'A-%') then
    raise exception 'T2 FALLA: el contador de A ve filas de otro cliente';
  end if;
  raise notice 'T2  OK  contador de Cliente A ve solo las 2 filas de A';

  -- ---- T3: el simétrico: el contador de B ve SOLO B -------------------------
  perform set_config('app.user_id', '33333333-3333-3333-3333-333333333333', true);
  select count(*) into v_n from _prueba_dominio;
  if v_n <> 1 then raise exception 'T3 FALLA: contador de B ve % filas (debería ser 1)', v_n; end if;
  if exists (select 1 from _prueba_dominio where descripcion not like 'B-%') then
    raise exception 'T3 FALLA: el contador de B ve filas de otro cliente';
  end if;
  raise notice 'T3  OK  contador de Cliente B ve solo la fila de B';

  -- ---- T4: el socio hereda el subárbol: ve A y B, nada del otro estudio -----
  perform set_config('app.user_id', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into v_n from _prueba_dominio;
  if v_n <> 3 then raise exception 'T4 FALLA: el socio ve % filas (deberían ser 3)', v_n; end if;
  if exists (select 1 from _prueba_dominio where descripcion like 'C-%'
                                         or descripcion like 'siete%'
                                         or descripcion like 'setenta%') then
    raise exception 'T4 FALLA: el socio del estudio 1 ve datos del estudio 2';
  end if;
  raise notice 'T4  OK  el socio ve A y B por herencia de subárbol, y nada del otro estudio';

  -- ---- T5: un estudio no ve NADA del otro ----------------------------------
  perform set_config('app.user_id', '44444444-4444-4444-4444-444444444444', true);
  if exists (select 1 from _prueba_dominio where descripcion like 'A-%' or descripcion like 'B-%') then
    raise exception 'T5 FALLA: el estudio 2 ve datos del estudio 1';
  end if;
  raise notice 'T5  OK  el estudio 2 no ve nada del estudio 1';

  -- ---- T6: LA TRAMPA DEL PATH: '.7' no debe ver '.70' ----------------------
  perform set_config('app.user_id', '55555555-5555-5555-5555-555555555555', true);
  select count(*) into v_n from _prueba_dominio;
  if v_n <> 1 then
    raise exception 'T6 FALLA: el nodo .7 ve % filas (debería ver 1). '
                    'Síntoma clásico del LIKE de subárbol sin el punto', v_n;
  end if;
  if exists (select 1 from _prueba_dominio where descripcion = 'setenta-1') then
    raise exception 'T6 FALLA: el nodo .7 ve la fila del nodo .70 — FUGA POR PREFIJO DE PATH';
  end if;
  raise notice 'T6  OK  .7 no ve .70 (el punto del LIKE de subárbol está bien puesto)';

  -- ---- T7: no se puede ESCRIBIR en otro cliente (with check) ---------------
  perform set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true);
  begin
    insert into _prueba_dominio (cliente_id, descripcion, importe)
    select id, 'inyectada', 1.00 from tenant_node where nombre = 'Cliente B';
  exception when others then
    null;   -- rechazado: también es resultado válido
  end;
  perform set_config('app.user_id', '11111111-1111-1111-1111-111111111111', true);  -- socio, ve todo
  select count(*) into v_n from _prueba_dominio where descripcion = 'inyectada';
  if v_n <> 0 then raise exception 'T7 FALLA: el contador de A escribió una fila en el cliente B'; end if;
  raise notice 'T7  OK  no se puede insertar en un cliente ajeno';

  -- ---- T8: el dominio no puede colgar de un nodo que no sea cliente --------
  select id into v_est from tenant_node where nombre = 'Estudio Uno';
  v_fallo := false;
  begin
    insert into _prueba_dominio (cliente_id, descripcion, importe) values (v_est, 'al-estudio', 1.00);
    v_fallo := true;
  exception when others then
    null;   -- rechazado por app.exigir_nodo_cliente
  end;
  if v_fallo then raise exception 'T8 FALLA: se insertó una fila de dominio colgada del estudio'; end if;
  raise notice 'T8  OK  una fila de dominio solo puede colgar de un nodo cliente';

  -- ---- T9: catálogo: ninguna tabla con cliente_id sin RLS habilitada Y forzada
  select count(*) into v_n
  from pg_class c
  join pg_namespace ns on ns.oid = c.relnamespace
  where c.relkind = 'r' and ns.nspname = 'public'
    and exists (select 1 from pg_attribute a
                 where a.attrelid = c.oid and a.attname = 'cliente_id'
                   and a.attnum > 0 and not a.attisdropped)
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_n <> 0 then
    raise exception 'T9 FALLA: % tabla(s) con cliente_id sin enable+force row level security', v_n;
  end if;
  raise notice 'T9  OK  toda tabla con cliente_id tiene RLS habilitada Y forzada';

  -- ---- T10: no hay política abierta (el fail-open de una sola letra, H-4) ---
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and ( coalesce(qual, '') ~* '^\s*true\s*$'
       or coalesce(qual, '') ~* '(or\s+true|is\s+null)'
       or coalesce(with_check, '') ~* '^\s*true\s*$'
       or (cmd in ('INSERT','UPDATE','ALL') and with_check is null) );
  if v_n <> 0 then
    raise exception 'T10 FALLA: % política(s) con predicado abierto (true / or true / is null / sin with_check)', v_n;
  end if;
  raise notice 'T10 OK  ninguna política con predicado abierto ni escritura sin with_check';

  -- ---- T11: toda función SECURITY DEFINER fija search_path -----------------
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef
    and n.nspname in ('app','public')
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  if v_n <> 0 then
    raise exception 'T11 FALLA: % función(es) SECURITY DEFINER sin search_path fijado', v_n;
  end if;
  raise notice 'T11 OK  toda función SECURITY DEFINER tiene search_path fijado';

  -- ---- T12: el rol de request no saltea RLS ni es superusuario --------------
  if (select rolbypassrls from pg_roles where rolname = 'app_request') then
    raise exception 'T12 FALLA: app_request tiene BYPASSRLS';
  end if;
  raise notice 'T12 OK  app_request no saltea RLS; el rol actual (%) tampoco es superusuario', current_user;

  -- ---- T13: la auditoría es append-only ------------------------------------
  if has_table_privilege('app_request', 'acceso_auditoria', 'UPDATE')
     or has_table_privilege('app_request', 'acceso_auditoria', 'DELETE') then
    raise exception 'T13 FALLA: app_request puede editar o borrar acceso_auditoria (no es append-only)';
  end if;
  raise notice 'T13 OK  acceso_auditoria es append-only para el rol de request';

  -- ---- T14: no hay super-raíz por encima de los estudios (H-9) --------------
  perform set_config('app.user_id', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into v_n from tenant_node where tipo = 'estudio' and parent_id is not null;
  if v_n <> 0 then
    raise exception 'T14 FALLA: hay % estudio(s) con padre — existe una super-raíz', v_n;
  end if;
  raise notice 'T14 OK  cada estudio es una raíz: no hay super-raíz de plataforma';

  raise notice '=== PASADA 2 COMPLETA: T1..T14 PASARON ===';
end $$;
