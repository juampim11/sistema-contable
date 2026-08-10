-- =============================================================================
-- 0002_endurecimiento.sql — cierre de los puntos de ADR-0002 §H.3 que viven en la base
--
-- Cubre:
--   * Punto 2 — FK COMPUESTAS TENANT-CONSISTENTES: la primera relación padre-hijo del esquema las
--     usa, y el test de catálogo las exige de ahí en adelante.
--   * Punto 4 — POLICY DE ROL EN LECTURA para N2R/N3: hasta ahora las policies chequeaban rol solo
--     en escritura. Un dato restringido exige rol también para LEERLO.
--   * Punto 5 — el rastro de auditoría tiene que poder escribirse desde un job (R19), sin que un job
--     pueda leerlo ni borrarlo.
--
-- Las dos tablas nuevas (`credencial_fiscal`, `credencial_fiscal_rotacion`) están especificadas en
-- ADR-0002 §E.2 y §E.3. NO son del Módulo 1: son la custodia de credenciales fiscales, y existen acá
-- porque son la única forma de que los puntos 2 y 4 queden implementados y verificados en vez de
-- quedar como una regla sin sujeto.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Auditoría escribible desde un job (R19), pero nunca legible ni borrable por él
-- -----------------------------------------------------------------------------
--
-- ADR-0002 R19 exige que CADA uso de la credencial que saltea RLS deje rastro. Con los grants de la
-- 0001, `app_job` no podía escribir en acceso_auditoria y la regla era incumplible.
--
-- Se le da INSERT y nada más: puede dejar rastro, no puede leer el de otros ni borrar el propio.
grant insert on acceso_auditoria to app_job;

comment on table acceso_auditoria is
  'Append-only. app_request: INSERT + SELECT (acotado por policy a socio/auditor). app_job: INSERT y '
  'nada más. Nadie tiene UPDATE ni DELETE: un rastro que el auditado puede editar no es un rastro.';

-- -----------------------------------------------------------------------------
-- 2. Rol del proceso firmador
-- -----------------------------------------------------------------------------
--
-- El material criptográfico de una credencial fiscal NO lo lee el proceso que atiende pedidos: lo lee
-- un proceso firmador separado, sin ruta de entrada desde HTTP (ADR-0002 §E.2). Motivo concreto: un
-- RCE en la app no alcanza la clave privada.
--
-- Se crea el rol ahora aunque el proceso no exista todavía: es lo que permite expresar el privilegio
-- a nivel de COLUMNA, y que el test verifique que app_request no puede ni seleccionarla.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_firmador') then
    create role app_firmador nologin;
  end if;
end $$;

grant usage on schema app to app_firmador;
grant execute on function app.current_user_id()       to app_firmador;
grant execute on function app.accessible_tenant_ids() to app_firmador;
grant execute on function app.has_role_on(uuid, app.rol_membership[]) to app_firmador;

-- -----------------------------------------------------------------------------
-- 3. credencial_fiscal — la única tabla N3 (ADR-0002 §E.2)
-- -----------------------------------------------------------------------------

create table credencial_fiscal (
  id                 uuid primary key default gen_random_uuid(),
  cliente_id         uuid not null references tenant_node(id) on delete restrict,
  servicio           text not null,                    -- N1: qué webservice
  ambiente           text not null,                    -- N1: homologacion | produccion
  -- N3. Cifrado con envelope: una DEK por cliente, la KEK vive en el almacén de secretos externo.
  -- app_request NO tiene privilegio de SELECT sobre esta columna (ver grants de abajo).
  material_cifrado   bytea not null,
  kek_id             text not null,                    -- identificador de la clave maestra, no la clave
  alg                text not null,
  -- Huella del certificado PÚBLICO: identifica la credencial sin descifrar nada.
  fingerprint_sha256 text not null,
  -- Dato CONFIGURABLE por credencial, no una constante: el plazo lo fija el organismo y esa fuente no
  -- está cargada (ADR-0002 §G, G-6). Una constante en el código sería inventar la norma.
  vence_en           date,
  rotada_en          timestamptz,
  created_at         timestamptz not null default now(),

  constraint credencial_fiscal_ambiente_chk check (ambiente in ('homologacion', 'produccion')),
  -- Una credencial por cliente + servicio + ambiente. UNICIDAD POR CLIENTE, nunca global (R6).
  constraint uq_credencial_fiscal_natural unique (cliente_id, servicio, ambiente),
  -- Habilita que un hijo la referencie de forma TENANT-CONSISTENTE (punto 2, ver §4).
  constraint uq_credencial_fiscal_tenant unique (cliente_id, id)
);

create index idx_credencial_fiscal_cliente on credencial_fiscal(cliente_id);
create index idx_credencial_fiscal_vence   on credencial_fiscal(vence_en) where vence_en is not null;

create trigger trg_credencial_fiscal_cliente
  before insert or update of cliente_id on credencial_fiscal
  for each row execute function app.exigir_nodo_cliente();

alter table credencial_fiscal enable row level security;
alter table credencial_fiscal force  row level security;

-- PUNTO 4 — CHEQUEO DE ROL EN **LECTURA**, no solo en escritura.
-- La policy de la 0001 para dominio chequeaba rol solo en el `for all`; para una tabla con columnas
-- N2R/N3 eso alcanza para escribir pero deja la lectura abierta a cualquier rol con acceso al
-- cliente (incluido `administrativo`). Acá el `select` exige rol explícito.
create policy credencial_fiscal_sel on credencial_fiscal for select
  using ( cliente_id in (select app.accessible_tenant_ids())
          and app.has_role_on(cliente_id, array['socio']::app.rol_membership[]) );

create policy credencial_fiscal_wr on credencial_fiscal for all
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio']::app.rol_membership[]) );

-- GRANT A NIVEL DE COLUMNA: app_request ve los METADATOS, nunca el material.
-- Es un control más fuerte que una policy: aunque un bug de la app arme un `select *`, Postgres lo
-- rechaza. `material_cifrado` queda deliberadamente afuera de esta lista.
grant select (id, cliente_id, servicio, ambiente, kek_id, alg, fingerprint_sha256, vence_en,
              rotada_en, created_at)
  on credencial_fiscal to app_request;

-- El firmador es el único que toca el material.
grant select, insert, update on credencial_fiscal to app_firmador;

-- app_job NO recibe ningún privilegio sobre esta tabla: un job no tiene nada que hacer con una
-- credencial fiscal, y su BYPASSRLS haría inútil la policy de arriba.

-- -----------------------------------------------------------------------------
-- 4. credencial_fiscal_rotacion — la primera FK COMPUESTA TENANT-CONSISTENTE (punto 2)
-- -----------------------------------------------------------------------------
--
-- POR QUÉ COMPUESTA. Una FK simple (`credencial_id references credencial_fiscal(id)`) garantiza que
-- la credencial exista, pero NO que pertenezca al mismo cliente que la fila hija. Con RLS activa el
-- ataque no pasa (la policy filtra), pero:
--   * `app_job` saltea la policy;
--   * un `COPY` o un `insert` hecho por el dueño del esquema también;
--   * y un bug de la app puede pasar un `credencial_id` de otro cliente.
-- La FK compuesta lo hace IMPOSIBLE a nivel de integridad referencial, que es la única defensa de
-- tenant que sobrevive a los tres casos (ADR-0002 R12 / H-2).
create table credencial_fiscal_rotacion (
  id                   uuid primary key default gen_random_uuid(),
  cliente_id           uuid not null references tenant_node(id) on delete restrict,
  credencial_id        uuid not null,
  motivo               text not null,
  fingerprint_anterior text,
  rotada_por           uuid not null,
  ocurrido_en          timestamptz not null default now(),

  -- La FK lleva la columna de tenant en AMBOS lados. Esto es el punto 2.
  constraint fk_rotacion_credencial
    foreign key (cliente_id, credencial_id)
    references credencial_fiscal (cliente_id, id)
    on delete restrict
);

create index idx_credencial_rotacion_cliente on credencial_fiscal_rotacion(cliente_id);
create index idx_credencial_rotacion_cred    on credencial_fiscal_rotacion(cliente_id, credencial_id);

create trigger trg_credencial_rotacion_cliente
  before insert or update of cliente_id on credencial_fiscal_rotacion
  for each row execute function app.exigir_nodo_cliente();

alter table credencial_fiscal_rotacion enable row level security;
alter table credencial_fiscal_rotacion force  row level security;

-- El historial de rotaciones no es secreto (no contiene material), pero sí es N2: lo leen socio y
-- auditor. El auditor entra acá y NO en credencial_fiscal: puede verificar que se rotó sin poder
-- pedir la credencial.
create policy credencial_rotacion_sel on credencial_fiscal_rotacion for select
  using ( cliente_id in (select app.accessible_tenant_ids())
          and app.has_role_on(cliente_id, array['socio','auditor']::app.rol_membership[]) );

create policy credencial_rotacion_ins on credencial_fiscal_rotacion for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio']::app.rol_membership[]) );

-- Append-only, igual que la auditoría: una rotación no se edita ni se borra.
grant select, insert on credencial_fiscal_rotacion to app_request;
grant select, insert on credencial_fiscal_rotacion to app_firmador;

commit;

-- =============================================================================
-- PLANTILLA ACTUALIZADA (reemplaza a la de 0001 para tablas con datos restringidos)
--
-- Para una tabla de dominio con columnas N2R o N3, a los siete renglones de ADR-0001 §5 se le suman:
--
--   (8)  policy de SELECT con chequeo de rol:
--        using ( cliente_id in (select app.accessible_tenant_ids())
--                and app.has_role_on(cliente_id, array['socio',...]::app.rol_membership[]) )
--
--   (9)  grant de SELECT **por columna**, dejando afuera lo N3:
--        grant select (col_a, col_b, ...) on <tabla> to app_request;
--
--   (10) unique (cliente_id, id), para que un hijo pueda referenciarla de forma tenant-consistente.
--
--   (11) toda FK hacia otra tabla con tenant es COMPUESTA:
--        foreign key (cliente_id, <padre>_id) references <padre> (cliente_id, id)
--
-- Los cuatro los exige `packages/data/tests/catalogo.test.ts`. Una tabla nueva que los omita no
-- necesita que alguien lo note en la revisión: el test se pone rojo.
-- =============================================================================
