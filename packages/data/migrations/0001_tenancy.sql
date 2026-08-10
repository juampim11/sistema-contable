-- =============================================================================
-- 0001_tenancy.sql — Multi-tenancy jerárquica (estudio → cliente) + RLS
--
-- Diseño y justificación de cada decisión: docs/arquitectura/ADR-0001-tenancy.md
-- Controles de seguridad que dependen de esto: docs/arquitectura/ADR-0002-seguridad.md
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA, nunca con app_request.
--   pnpm drizzle-kit migrate     (o: psql "$DATABASE_URL" -f este_archivo)
--
-- REGLAS QUE ESTE ARCHIVO HACE CUMPLIR:
--   * Cero extensiones: gen_random_uuid() es core desde PostgreSQL 13 (apuntamos a 16).
--     Nada de pgcrypto ni ltree — una extensión es una precondición de despliegue que no todo
--     Postgres gestionado garantiza (ADR-0000 §6).
--   * Las políticas se escriben contra app.current_user_id(), NUNCA contra auth.uid():
--     el aislamiento no depende del proveedor de auth.
--   * Ninguna contraseña acá. Los roles nacen sin contraseña; cada entorno crea su usuario de
--     login y le asigna la suya fuera del repo (db:setup).
--
-- NUNCA EDITAR ESTE ARCHIVO UNA VEZ APLICADO. La corrección va en la migración siguiente.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Schema y tipos
-- -----------------------------------------------------------------------------

create schema if not exists app;

-- Profundidad variable: estudio -> [grupo] -> cliente.
-- 'grupo' queda previsto y sin uso (ADR-0001 §2.2): existe para el dueño con varias sociedades.
create type app.tipo_tenant as enum ('estudio', 'grupo', 'cliente');

-- [validar] con producto y con seguridad-datos-financieros (ADR-0001 §11).
create type app.rol_membership as enum (
  'admin_plataforma',  -- staff del SaaS
  'socio',             -- titular del estudio
  'contador',          -- registra, liquida, confirma propuestas
  'administrativo',    -- carga y clasifica; NO confirma ni presenta
  'auditor',           -- solo lectura
  'cliente_lectura'    -- el cliente del estudio mirando lo suyo (portal futuro)
);

-- -----------------------------------------------------------------------------
-- 2. El árbol de tenancy
-- -----------------------------------------------------------------------------

create table tenant_node (
  id          uuid primary key default gen_random_uuid(),
  -- Segmento del path: bigint identity, NO el uuid ni el nombre.
  -- Compacto ('1.12.15' vs tres uuid), inmutable (renombrar no toca el path) y numérico.
  nid         bigint generated always as identity unique,
  parent_id   uuid references tenant_node(id) on delete restrict,
  tipo        app.tipo_tenant not null,
  nombre      text not null,
  -- Materialized path. LO MANTIENE EL TRIGGER DE ABAJO, no la aplicación: es un invariante de
  -- integridad, y un path corrupto es una fuga de aislamiento, no un detalle cosmético.
  path        text not null,
  deleted_at  timestamptz,   -- soft-delete: nunca borrado físico de un tenant con datos
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tenant_node_raiz_chk check (
    (tipo = 'estudio' and parent_id is null) or
    (tipo <> 'estudio' and parent_id is not null)
  )
);

comment on table tenant_node is
  'Jerarquía de TENANCÍA: estudio -> [grupo] -> cliente. La RLS vive acá. No confundir con la '
  'estructura de dominio dentro de un cliente (plan de cuentas, movimientos): eso son datos con '
  'columna cliente_id. Ver ADR-0001 §2.';

comment on column tenant_node.path is
  'Materialized path con segmentos nid separados por punto. Subárbol: '
  'path = X or path like X || ''.%''. El punto es OBLIGATORIO: sin él ''1.7'' matchea ''1.70''.';

create table membership (
  id             uuid primary key default gen_random_uuid(),
  -- id que devuelve AuthProvider. SIN FK a ningún schema de auth: es lo que mantiene el esquema
  -- agnóstico de proveedor (ADR-0000 §3.2).
  user_id        uuid not null,
  tenant_node_id uuid not null references tenant_node(id) on delete cascade,
  rol            app.rol_membership not null,
  activo         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (user_id, tenant_node_id, rol)
);

comment on table membership is
  'Una membresía en el nodo N da acceso a N y a TODO su subárbol. Los permisos son por membresía, '
  'no globales: un contador externo puede tener rol en un cliente y nada en otro.';

-- -----------------------------------------------------------------------------
-- 3. Trigger de path (mantiene el invariante del árbol)
-- -----------------------------------------------------------------------------

create or replace function app.tenant_node_set_path() returns trigger
  language plpgsql as $$
declare
  v_path_padre text;
begin
  if new.parent_id is null then
    new.path := new.nid::text;
  else
    select path into v_path_padre from tenant_node where id = new.parent_id;
    if v_path_padre is null then
      raise exception 'parent_id % inexistente', new.parent_id;
    end if;
    new.path := v_path_padre || '.' || new.nid::text;
  end if;
  return new;
end $$;

create trigger trg_tenant_node_path
  before insert on tenant_node
  for each row execute function app.tenant_node_set_path();

-- MISMA función, también en UPDATE de parent_id.
--
-- ESTO NO ESTABA EN EL DISEÑO ORIGINAL Y ES UNA FUGA DE AISLAMIENTO, no un detalle: con solo
-- BEFORE INSERT, un `update tenant_node set parent_id = ...` (consola, migración de datos, un futuro
-- "mover cliente de grupo") deja el `path` viejo. Como app.accessible_tenant_ids() resuelve el
-- subárbol POR PATH, a partir de ese momento un usuario de un estudio empieza a ver clientes de
-- otro. Silencioso: nada falla, solo aparecen filas ajenas.
-- Hallazgo del agente seguridad-datos-financieros (ADR-0002, H-1).
create trigger trg_tenant_node_path_upd
  before update of parent_id on tenant_node
  for each row execute function app.tenant_node_set_path();

-- Y el path tampoco se edita a mano: la única vía de reescritura es app.reparentar_nodo().
create or replace function app.rechazar_path_manual() returns trigger
  language plpgsql as $$
begin
  if new.path is distinct from old.path
     and coalesce(current_setting('app.reparentando', true), '') <> 'on' then
    raise exception
      'tenant_node.path no se edita a mano (% -> %): usá app.reparentar_nodo()', old.path, new.path;
  end if;
  return new;
end $$;

create trigger trg_tenant_node_path_manual
  before update of path on tenant_node
  for each row execute function app.rechazar_path_manual();

-- Chequeo de coherencia del árbol. Devuelve las filas incoherentes: si devuelve algo, el
-- aislamiento está roto. Se corre en CI y como job periódico EN PRODUCCIÓN (ADR-0002, INV-12).
create or replace function app.verificar_coherencia_path()
  returns table (id uuid, path_actual text, path_esperado text)
  language sql stable as $$
  select n.id, n.path,
         coalesce(p.path || '.', '') || n.nid::text
    from tenant_node n
    left join tenant_node p on p.id = n.parent_id
   where n.path <> coalesce(p.path || '.', '') || n.nid::text
$$;

-- Re-parentar reescribe el path del nodo y de todos sus descendientes. NO cambia el uuid, y por eso
-- la RLS de dominio (por cliente_id) sigue correcta sin tocar una sola fila de dominio.
-- Se corre con app_job, en transacción. Ver ADR-0001 §8.2.
create or replace function app.reparentar_nodo(p_nodo uuid, p_nuevo_padre uuid) returns void
  language plpgsql as $$
declare
  v_path_viejo text;
  v_path_nuevo text;
  v_path_padre text;
  v_nid        bigint;
begin
  -- Habilita la reescritura de path SOLO dentro de esta transacción (local = true).
  perform set_config('app.reparentando', 'on', true);

  select path, nid into v_path_viejo, v_nid from tenant_node where id = p_nodo;
  if v_path_viejo is null then
    raise exception 'nodo % inexistente', p_nodo;
  end if;

  select path into v_path_padre from tenant_node where id = p_nuevo_padre;
  if v_path_padre is null then
    raise exception 'nuevo padre % inexistente', p_nuevo_padre;
  end if;

  -- No se puede colgar un nodo de su propio subárbol (ciclo).
  if v_path_padre = v_path_viejo or v_path_padre like v_path_viejo || '.%' then
    raise exception 'ciclo: % está dentro del subárbol de %', p_nuevo_padre, p_nodo;
  end if;

  v_path_nuevo := v_path_padre || '.' || v_nid::text;

  update tenant_node
     set path       = v_path_nuevo || substring(path from length(v_path_viejo) + 1),
         updated_at = now()
   where path = v_path_viejo or path like v_path_viejo || '.%';

  update tenant_node set parent_id = p_nuevo_padre, updated_at = now() where id = p_nodo;

  -- Falla cerrado: si la reescritura dejó el árbol incoherente, se aborta la transacción entera.
  if exists (select 1 from app.verificar_coherencia_path()) then
    raise exception 'reparentado abortado: el árbol quedó incoherente';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Las tres funciones de RLS
-- -----------------------------------------------------------------------------

-- (1) Quién es el usuario actual.
-- Alimentada por set_config('app.user_id', $1, true) DENTRO de la transacción (ADR-0001 §6).
-- Si no está seteada: devuelve null -> el conjunto accesible es vacío -> toda consulta devuelve
-- cero filas. FALLA CERRADO, que es la única dirección aceptable.
create or replace function app.current_user_id() returns uuid
  language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- (2) Subárbol accesible del usuario actual.
-- STABLE => se evalúa una vez por query, no por fila.
-- SECURITY DEFINER + search_path FIJO: las dos mitades hacen falta. Sin DEFINER hay recursión de
-- políticas (lee tablas con RLS que a su vez llaman a esta función); sin search_path fijo, DEFINER
-- es una escalada de privilegios esperando un schema plantado en el path.
create or replace function app.accessible_tenant_ids() returns setof uuid
  language sql stable security definer set search_path = public, app as $$
  select distinct d.id
  from membership m
  join tenant_node n on n.id = m.tenant_node_id
  join tenant_node d on d.path = n.path or d.path like n.path || '.%'
  where m.user_id = app.current_user_id()
    and m.activo
    and n.deleted_at is null
    and d.deleted_at is null
$$;

-- (3) ¿El usuario actual tiene alguno de estos roles SOBRE este nodo (o sobre un ancestro)?
create or replace function app.has_role_on(nodo_objetivo uuid, roles app.rol_membership[])
  returns boolean
  language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1
    from membership m
    join tenant_node mn on mn.id = m.tenant_node_id
    join tenant_node tn on tn.id = nodo_objetivo
    where m.user_id = app.current_user_id()
      and m.activo
      and m.rol = any(roles)
      and (tn.path = mn.path or tn.path like mn.path || '.%')
  )
$$;

-- Invariante: toda fila de dominio cuelga de un nodo de tipo 'cliente' (ADR-0001 §2.2 y §4.4).
-- SIN security definer A PROPÓSITO: corre con los privilegios de quien inserta, así que si la RLS le
-- oculta el nodo, el exists da falso y el INSERT falla. Falla cerrado. Un DEFINER acá convertiría el
-- trigger en un oráculo de "¿existe el nodo X?" para tenants ajenos.
create or replace function app.exigir_nodo_cliente() returns trigger
  language plpgsql as $$
begin
  if not exists (
    select 1 from tenant_node n
     where n.id = new.cliente_id
       and n.tipo = 'cliente'
       and n.deleted_at is null
  ) then
    raise exception 'cliente_id % no es un nodo activo de tipo cliente', new.cliente_id;
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- 5. Roles de base de datos
-- -----------------------------------------------------------------------------
--
-- DETALLE DE POSTGRES QUE SE PASA POR ALTO Y ROMPE EL DISEÑO:
-- los ATRIBUTOS de rol (LOGIN, BYPASSRLS, SUPERUSER) NO se heredan por pertenencia
-- (GRANT rol TO usuario); los privilegios sí. Por eso:
--   * app_request es rol GRUPO (nologin): los usuarios de login se hacen miembros y heredan
--     privilegios, y las políticas se les aplican (no tienen BYPASSRLS).
--   * app_job es EL ROL QUE SE CONECTA (login): un usuario miembro de app_job NO heredaría
--     BYPASSRLS y las políticas se le aplicarían igual — el bypass no funcionaría.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_request') then
    create role app_request nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_job') then
    -- BYPASSRLS: saltea las políticas. SOLO server-side, solo para tomar trabajo de la cola.
    -- El trabajo real corre con conUsuario() bajo la identidad de quien lo pidió (ADR-0001 §6).
    -- Sin contraseña: la asigna cada entorno fuera del repo.
    create role app_job login bypassrls;
  end if;
end $$;

grant usage on schema app to app_request, app_job;

-- Las funciones SECURITY DEFINER no se dejan ejecutables por public: se concede explícitamente.
revoke all on function app.accessible_tenant_ids() from public;
revoke all on function app.has_role_on(uuid, app.rol_membership[]) from public;
grant execute on function app.current_user_id()      to app_request, app_job;
grant execute on function app.accessible_tenant_ids() to app_request, app_job;
grant execute on function app.has_role_on(uuid, app.rol_membership[]) to app_request, app_job;
grant execute on function app.verificar_coherencia_path() to app_job;   -- control periódico
grant execute on function app.reparentar_nodo(uuid, uuid) to app_job;   -- solo el camino autorizado

-- -----------------------------------------------------------------------------
-- 6. RLS sobre las tablas de tenancy
-- -----------------------------------------------------------------------------
--
-- force row level security: sin esto, EL DUEÑO DE LA TABLA IGNORA LAS POLÍTICAS. Como las tablas las
-- posee el dueño del esquema (que corre migraciones y scripts), `enable` solo no alcanza.

alter table tenant_node enable row level security;
alter table tenant_node force  row level security;
alter table membership  enable row level security;
alter table membership  force  row level security;

create policy tenant_node_sel on tenant_node for select
  using ( id in (select app.accessible_tenant_ids()) );

-- Altas y bajas de nodos: solo socio o staff, y sobre el subárbol propio.
-- El nodo RAÍZ (el estudio) no lo puede crear nadie por esta vía: no tiene ancestro sobre el que
-- tener rol. Se crea con el dueño del esquema o app_job, en un script de alta explícito y auditado
-- (ADR-0001 §8.8). Es a propósito: un endpoint que puede crear estudios es un endpoint que puede
-- fabricarse acceso.
create policy tenant_node_wr on tenant_node for all
  using      ( id in (select app.accessible_tenant_ids())
               and app.has_role_on(id, array['admin_plataforma','socio']::app.rol_membership[]) )
  with check ( parent_id is not null
               and parent_id in (select app.accessible_tenant_ids())
               and app.has_role_on(parent_id, array['admin_plataforma','socio']::app.rol_membership[]) );

-- [validar] (ADR-0001 §11): esto permite que cualquiera con acceso a un nodo vea QUIÉNES tienen
-- membresía en su subárbol. Para socio/contador es lo esperado; para cliente_lectura probablemente no.
-- Cuando se defina, se acota con una política adicional por rol.
create policy membership_sel on membership for select
  using ( tenant_node_id in (select app.accessible_tenant_ids()) );

create policy membership_wr on membership for all
  using      ( tenant_node_id in (select app.accessible_tenant_ids())
               and app.has_role_on(tenant_node_id, array['admin_plataforma','socio']::app.rol_membership[]) )
  with check ( tenant_node_id in (select app.accessible_tenant_ids())
               and app.has_role_on(tenant_node_id, array['admin_plataforma','socio']::app.rol_membership[]) );

grant select, insert, update, delete on tenant_node to app_request;
grant select, insert, update, delete on membership  to app_request;

-- app_job NECESITA privilegios explícitos: BYPASSRLS saltea las POLÍTICAS, no otorga PRIVILEGIOS.
-- Sin este grant, el alta del estudio raíz y el re-parentado fallan por permisos (no por RLS).
-- Se limita a las tablas de TENANCÍA: el dominio lo escribe app_request bajo conUsuario(), incluida
-- la ingesta del Módulo 1 (ADR-0002 R19/R20 — la ingesta NO está en la whitelist de app_job).
grant select, insert, update, delete on tenant_node to app_job;
grant select, insert, update, delete on membership  to app_job;

-- -----------------------------------------------------------------------------
-- 6.1. Auditoría de acceso (append-only)
-- -----------------------------------------------------------------------------
--
-- Requisito duro de la persona seguridad-datos-financieros: "quién vio o cambió el dato fiscal de un
-- cliente, y cuándo" tiene que ser una pregunta contestable. Sin esto, después de un incidente todo
-- se cierra con "no sabemos" (ADR-0002, H-8).
--
-- APPEND-ONLY: a app_request se le concede INSERT y SELECT, NUNCA update ni delete. Un rastro de
-- auditoría que el mismo proceso auditado puede editar no es un rastro de auditoría.

create table acceso_auditoria (
  id           bigint generated always as identity primary key,
  cliente_id   uuid not null references tenant_node(id) on delete restrict,
  user_id      uuid not null,             -- quién (app.current_user_id())
  accion       text not null,             -- 'lectura' | 'export' | 'descarga' | 'uso_credencial' | ...
  recurso      text not null,             -- tabla u objeto afectado (nombre, NO contenido)
  recurso_id   uuid,                      -- id del registro (uuid, nunca un valor sensible)
  motivo       text,                      -- obligatorio para export/descarga (lo exige la app)
  ocurrido_en  timestamptz not null default now()
  -- [validar] con producto: si hace falta ip/user-agent, va acá — y NUNCA un dato de nivel N2+
);

create index idx_acceso_auditoria_cliente on acceso_auditoria(cliente_id, ocurrido_en desc);
create index idx_acceso_auditoria_user    on acceso_auditoria(user_id, ocurrido_en desc);

create trigger trg_acceso_auditoria_cliente
  before insert or update of cliente_id on acceso_auditoria
  for each row execute function app.exigir_nodo_cliente();

alter table acceso_auditoria enable row level security;
alter table acceso_auditoria force  row level security;

-- Leer el rastro es más restringido que leer el dato: solo socio y auditor.
create policy acceso_auditoria_sel on acceso_auditoria for select
  using ( cliente_id in (select app.accessible_tenant_ids())
          and app.has_role_on(cliente_id, array['socio','auditor']::app.rol_membership[]) );

-- Cualquiera que tenga acceso al cliente puede DEJAR rastro (y debe).
create policy acceso_auditoria_ins on acceso_auditoria for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and user_id = app.current_user_id() );

grant select, insert on acceso_auditoria to app_request;   -- SIN update, SIN delete: append-only

-- -----------------------------------------------------------------------------
-- 7. Índices
-- -----------------------------------------------------------------------------

create unique index uq_tenant_node_path on tenant_node(path);

-- text_pattern_ops: necesario para que LIKE 'prefijo%' use índice cuando la collation NO es 'C'
-- — el caso de Cloud SQL, RDS y Supabase. Sin esto, cada resolución de subárbol es un scan.
create index idx_tenant_node_path_prefix on tenant_node(path text_pattern_ops);
create index idx_tenant_node_parent      on tenant_node(parent_id);
create index idx_tenant_node_tipo        on tenant_node(tipo) where deleted_at is null;

create index idx_membership_user_activo  on membership(user_id) where activo;
create index idx_membership_node         on membership(tenant_node_id);

commit;

-- =============================================================================
-- PLANTILLA PARA TODA TABLA DE DOMINIO FUTURA (ADR-0001 §5)
--
-- Los siete renglones son OBLIGATORIOS. Faltar el índice es un problema de performance; faltar
-- enable/force/policy es una FUGA DE DATOS ENTRE CLIENTES. Se verifica con un test que recorre el
-- catálogo de Postgres (ADR-0002 §C).
--
--   create table <tabla> (
--     id         uuid primary key default gen_random_uuid(),
--     cliente_id uuid not null references tenant_node(id) on delete restrict,   -- (1)
--     ...
--     created_at timestamptz not null default now()
--   );
--
--   create index idx_<tabla>_cliente on <tabla>(cliente_id);                     -- (2)
--
--   create trigger trg_<tabla>_cliente                                           -- (3)
--     before insert or update of cliente_id on <tabla>
--     for each row execute function app.exigir_nodo_cliente();
--
--   alter table <tabla> enable row level security;                               -- (4)
--   alter table <tabla> force  row level security;                               -- (5)
--
--   create policy <tabla>_sel on <tabla> for select                              -- (6)
--     using ( cliente_id in (select app.accessible_tenant_ids()) );
--
--   create policy <tabla>_wr on <tabla> for all
--     using      ( cliente_id in (select app.accessible_tenant_ids())
--                  and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
--     with check ( cliente_id in (select app.accessible_tenant_ids())
--                  and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );
--
--   grant select, insert, update, delete on <tabla> to app_request;              -- (7)
--
-- Y las unicidades SIEMPRE por cliente: unique (cliente_id, <clave natural>), nunca global.
-- =============================================================================
