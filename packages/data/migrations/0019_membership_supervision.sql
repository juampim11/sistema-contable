-- =============================================================================
-- 0019 — El padrón de derechos deja de ser escribible por el sujeto del control, y deja rastro.
--
-- 🔴 CIERRA EL INCIDENTE #5.
--
-- ## El agujero
--
-- `membership` es la tabla que define quién es quién. Tenía TRES ausencias que se componen, y cerrar
-- una sola dejaba el hallazgo vivo:
--
--   (a) `membership_wr` (0001:335-339) es `for all` y gatea SÓLO POR EL NODO: ni el `using` ni el
--       `with check` mencionan `rol` ni `activo`. O sea que el predicado pregunta por el rol de QUIEN
--       ESCRIBE y nunca por el rol de LA FILA QUE SE TOCA.
--   (b) El `grant` es de TABLA ENTERA (0001:342 y 0001:349), sin recorte por columna — a diferencia de
--       `credencial_fiscal` (0002:114) y de `tenant_node` (0017 §7 / 0018).
--   (c) NO HAY RASTRO DE ESCRITURA. `acceso_auditoria` registra ACCESO, no CAMBIOS DE DERECHO, y
--       ninguna migración le engancha un trigger de auditoría a `membership`.
--
-- Medido por `tester`, actuando como `socio` del propio estudio:
--
--   update membership set activo = false where rol in ('auditor','admin_plataforma');  -- UPDATE 2
--   delete from membership where rol = 'auditor';                                      -- DELETE 1
--
-- El `auditor` pasó de árbol completo y 1 fila de auditoría a 0 y 0; el `admin_plataforma`, a 0 nodos.
-- Cero rastro. `rol` sólo permite DEGRADAR; `activo` y el `DELETE` EXPULSAN LA SUPERVISIÓN ENTERA.
--
-- 🔴 Y tiene consecuencia sobre los incidentes #1 y #2: la medición forense «cero membresías
-- inesperadas en las dos bases», que sostiene el «no hay evidencia de escalada persistente» de los
-- dos, corre sobre un estado que el sujeto auditado puede editar y borrar sin dejar fila. Las dos
-- filas quedaron ANOTADAS por eso.
--
-- ## La lección, que es distinta de la del #4
--
--   El #4: «un control de integridad que corre bajo RLS hereda la ceguera de la RLS» — lo que el
--   control PUEDE VER.
--
--   El #5: **la RLS decide QUIÉN escribe una fila, nunca QUÉ DICE la fila. Cuando la fila es la que
--   define quién es quién, esa distinción exacta es la vulnerabilidad: el sujeto de un control no
--   puede ser escritor irrestricto del registro que lo constituye.**
--
--   Corolario: **el padrón de acceso es un dato de seguridad, no un dato de dominio.**
--
-- ## 🔴 La restricción que toda remediación debe respetar
--
-- ADR-0002 INV-10 exige que revocar una membresía corte el acceso en el request siguiente, y
-- `packages/data/tests/aislamiento.test.ts` lo verifica con `update membership set activo = false`.
-- **La escritura sobre `activo` TIENE QUE SEGUIR EXISTIENDO.** El defecto no es que se escriba: es
-- sobre QUÉ FILA, con QUÉ GRANT y SIN QUÉ RASTRO. Una remediación que rompa INV-10 está mal dirigida.
--
-- ## Qué se hace, y por qué las tres patas
--
--   §1  RASTRO — `membership_historia`, append-only, escrita POR TRIGGER y no por la aplicación.
--   §2  PRIVILEGIO — grant por columna: sólo `activo` se actualiza; el `DELETE` desaparece.
--   §3  POLICY — el predicado mira el rol de LA FILA TOCADA, no sólo el del escritor.
--
-- Ninguna alcanza sola:
--   * sin (§3) el socio sigue pudiendo tocar la fila del auditor;
--   * sin (§2) puede cambiar `rol` para esquivar cualquier predicado sobre `rol`;
--   * sin (§1) todo lo anterior pasa sin dejar constancia, y el intento tampoco queda.
--
-- ## 🔴 Por qué el rastro NO va contra `acceso_auditoria`
--
-- El motivo es MECÁNICO antes que semántico, y por eso no es discutible: su trigger
-- `trg_acceso_auditoria_cliente` (0001:377-379) corre `app.exigir_nodo_cliente()`, que aborta si
-- `cliente_id` no es un nodo de tipo `cliente` activo. Una membresía de `socio`, `auditor` o
-- `admin_plataforma` cuelga típicamente del nodo ESTUDIO: **la fila no entra**. Y semánticamente
-- responden preguntas distintas — `acceso_auditoria` es «quién vio qué dato fiscal»; esto es «quién
-- puede ver, desde cuándo, y quién lo decidió».
--
-- Precedente en el repo, y es la misma forma: `credencial_fiscal` + `credencial_fiscal_rotacion`
-- (0002:62 y 0002:136). El objeto sensible y su rastro de cambio, en tabla aparte. `membership` es el
-- otro objeto de esa naturaleza y nació sin su par.
--
-- ## 🔴 Por qué el trigger es INVOKER y no `security definer`
--
-- Un `security definer` acá violaría R11 (whitelist de dos funciones) y pediría un ADR — y no hace
-- falta: el trigger escribe una fila en un nodo que el escritor YA PUEDE VER (es el mismo nodo de la
-- membresía que está tocando). Si no lo viera, el insert falla y la operación entera aborta: FALLA
-- CERRADO. Es la misma decisión que tomó 0017 al bajar el invariante a `check` + `foreign key`.
--
-- Lo que sí importa, y es la lección del #1 en una línea: **el rastro lo escribe el TRIGGER, no la
-- aplicación.** `acceso_auditoria` se escribe desde la aplicación y por eso el vector del #1 no dejó
-- nada. Un rastro que depende de que el escritor coopere no sirve contra un escritor hostil.
--
-- ## 🔴 Y por qué `hecho_por` y `ocurrido_en` NO se le otorgan a nadie
--
-- Las dos salen de un DEFAULT, y el trigger NO las nombra. Consecuencia: ni el trigger ni un `insert`
-- manual pueden falsificarlas, porque **el grant es por columna y esas dos columnas no están**.
-- Sale del hallazgo H-B de `security-engineer` sobre `acceso_auditoria.ocurrido_en`, que hoy SÍ lo
-- elige el auditado: acá esa puerta se cierra por construcción.
--
-- ## La decisión de negocio que este archivo toma, y que se puede revertir en una línea
--
-- `app.ROLES_SUPERVISORES` = `auditor` + `admin_plataforma`.
--
--   * `admin_plataforma` es ESTRUCTURAL, no opinable: `0001:36` dice que es staff de la plataforma y
--     no personal del estudio. Que el titular de un tenant pueda expulsarlo deja al operador sin
--     intervención sobre un tenant que sigue custodiando datos fiscales de TERCEROS — y esos terceros
--     no son parte de esa relación ni la pueden observar.
--   * `auditor` es LA DECISIÓN. El argumento: el auditor existe precisamente para mirar lo que el
--     socio hace, y la policy de lectura de `acceso_auditoria` (0001:385-387) ya lo reconoce al
--     restringir el rastro a `socio` Y `auditor` y a nadie más. Un control de supervisión que el
--     supervisado puede apagar sin dejar constancia no es un control degradado: profesionalmente, no
--     es un control.
--
-- Si el titular decide otra cosa, se cambia el cuerpo de `app.es_rol_supervisor()` y nada más.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. RASTRO — append-only, escrito por trigger
-- -----------------------------------------------------------------------------

create table membership_historia (
  id             uuid primary key default gen_random_uuid(),
  -- Del PLANO DE TENANCÍA, no del de cliente: una membresía de socio/auditor cuelga del ESTUDIO, y
  -- por eso esta tabla NO lleva `cliente_id` ni los siete renglones de ADR-0001 §5, igual que
  -- `tenant_node` y `membership`.
  tenant_node_id uuid not null references tenant_node(id),
  -- SIN FK: la membresía puede haberse borrado, y el sentido de esta tabla es que quede el rastro.
  membership_id  uuid not null,
  user_id        uuid not null,
  rol            app.rol_membership not null,
  -- Dominio cerrado NOMBRADO: el gate exige que todo `check` con esta forma tenga su constante de
  -- TypeScript espejada y su fila en `DOMINIOS_CERRADOS`. Sin nombre no se puede parear.
  operacion      text not null
    constraint membership_historia_operacion_chk
    check (operacion in ('alta', 'modificacion', 'baja', 'borrado')),
  activo_antes   boolean,
  activo_despues boolean,
  -- 🔴 Las dos salen de un DEFAULT y NADIE tiene grant sobre ellas. Ni el trigger las nombra.
  -- Es lo que impide que el auditado elija quién figura y cuándo — el defecto que `acceso_auditoria`
  -- sí tiene hoy sobre `ocurrido_en`.
  --
  -- `hecho_por` es NULLABLE a propósito, y el nulo ES INFORMACIÓN: significa que la escritura no vino
  -- de una sesión con contexto de usuario, o sea el **dueño del esquema o un job** — una migración,
  -- un script de mantenimiento, la siembra sintética. Distinguir «lo hizo una persona a través de la
  -- aplicación» de «lo hizo el mantenimiento» es exactamente lo que hay que poder contestar después,
  -- y forzar un valor de relleno lo borraría. Lo que NO puede pasar es que alguien lo elija: por eso
  -- no hay grant sobre la columna.
  hecho_por      uuid default app.current_user_id(),
  ocurrido_en    timestamptz not null default now()
);

comment on constraint membership_historia_operacion_chk on membership_historia is
  'Cierra el dominio de `operacion`. Se compara contra la constante `OPERACIONES_MEMBRESIA` de '
  '`packages/data/src/db/auditoria.ts`, y el gate exige que las dos listas coincidan: si divergen, '
  'la de la base es la única real y el código escribe a ciegas.';

comment on table membership_historia is
  'Rastro append-only de los cambios del padrón de derechos (incidente #5). Lo escribe un TRIGGER, '
  'no la aplicación: un rastro que depende de que el escritor coopere no sirve contra un escritor '
  'hostil, que es la lección del incidente #1. Misma forma que credencial_fiscal_rotacion.';

create index idx_membership_historia_nodo on membership_historia (tenant_node_id, ocurrido_en desc);
create index idx_membership_historia_user on membership_historia (user_id, ocurrido_en desc);

alter table membership_historia enable row level security;
alter table membership_historia force row level security;

-- Lo lee quien puede supervisar: socio, auditor y admin_plataforma sobre el nodo. Mismo criterio que
-- `acceso_auditoria_sel` (0001:385-387).
create policy membership_historia_sel on membership_historia for select
  using ( tenant_node_id in (select app.accessible_tenant_ids())
          and app.has_role_on(tenant_node_id,
                array['admin_plataforma','socio','auditor']::app.rol_membership[]) );

-- El insert lo hace el trigger, con la identidad del escritor: alcanza con que vea el nodo.
create policy membership_historia_ins on membership_historia for insert
  with check ( tenant_node_id in (select app.accessible_tenant_ids()) );

-- 🔴 SIN policy de UPDATE ni de DELETE, a propósito: append-only. Mismo criterio que
-- `acceso_auditoria` (0001) y que el DELETE de `credencial_fiscal` (0005:36-38).

create or replace function app.registrar_cambio_membership() returns trigger
  language plpgsql
  -- R10 (incidente #1): `pg_temp` último, esquema calificado en todo el cuerpo.
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_op text;
begin
  if tg_op = 'INSERT' then
    v_op := 'alta';
  elsif tg_op = 'DELETE' then
    v_op := 'borrado';
  elsif old.activo is distinct from new.activo then
    v_op := case when new.activo then 'alta' else 'baja' end;
  else
    v_op := 'modificacion';
  end if;

  -- NO se nombran `hecho_por` ni `ocurrido_en`: van por DEFAULT y nadie tiene grant sobre ellas.
  if tg_op = 'DELETE' then
    insert into public.membership_historia
      (tenant_node_id, membership_id, user_id, rol, operacion, activo_antes, activo_despues)
    values (old.tenant_node_id, old.id, old.user_id, old.rol, v_op, old.activo, null);
    return old;
  end if;

  insert into public.membership_historia
    (tenant_node_id, membership_id, user_id, rol, operacion, activo_antes, activo_despues)
  values (new.tenant_node_id, new.id, new.user_id, new.rol, v_op,
          case when tg_op = 'UPDATE' then old.activo else null end, new.activo);
  return new;
end $$;

-- AFTER: si la escritura no llegó a ocurrir, no hay nada que registrar. Y `for each row` porque el
-- rastro es por membresía, no por sentencia.
create trigger trg_membership_historia
  after insert or update or delete on membership
  for each row execute function app.registrar_cambio_membership();

-- -----------------------------------------------------------------------------
-- 2. PRIVILEGIO — sólo `activo` se actualiza, y el DELETE desaparece
-- -----------------------------------------------------------------------------
--
-- 🔴 `revoke update (col)` sobre un grant de TABLA es un no-op silencioso (medido en el #4): hay que
-- revocar a nivel tabla y re-otorgar columna por columna. Es lo que se hace acá.
--
-- Cambiar el `rol` de una membresía deja de ser un `update`: es baja + alta, y las dos quedan
-- registradas. Es el mismo criterio con que 0005:36-38 le sacó el DELETE a `credencial_fiscal`
-- («una credencial fiscal no se borra, se rota»): **una membresía no se borra, se desactiva** — y
-- desactivarla ya está previsto por INV-10.
--
-- MEDIDO antes de aplicarlo: CERO `insert`/`update`/`delete` sobre `membership` en código de
-- producción TypeScript. Los únicos están en el seed sintético y en helpers de test; el CLI de alta y
-- baja de socio opera sobre `padron_socio`, que es otra tabla.

revoke update, delete on membership from app_request;
grant  update (activo) on membership to app_request;

-- `app_job` conserva lo suyo: la siembra sintética crea membresías con `conJob`. Pero tampoco
-- necesita borrar ni cambiar roles.
revoke update, delete on membership from app_job;
grant  update (activo) on membership to app_job;

-- 🔴 El `insert` va POR COLUMNA, y `hecho_por`/`ocurrido_en` NO están en la lista. Con un grant de
-- tabla entera, cualquiera podría escribir una fila de rastro eligiendo quién figura y cuándo — que
-- es el defecto que `acceso_auditoria.ocurrido_en` sí tiene hoy (hallazgo H-B). Lo detectó el propio
-- test de esta migración: con `grant insert on membership_historia` a secas, el caso «no se pueden
-- falsificar» pasaba en verde por el motivo equivocado.
grant select on membership_historia to app_request, app_job;
grant insert (tenant_node_id, membership_id, user_id, rol, operacion, activo_antes, activo_despues)
  on membership_historia to app_request, app_job;

-- -----------------------------------------------------------------------------
-- 3. POLICY — el predicado mira el rol de LA FILA TOCADA
-- -----------------------------------------------------------------------------

create or replace function app.es_rol_supervisor(p_rol app.rol_membership) returns boolean
  language sql immutable
  set search_path = pg_catalog, public, app, pg_temp
as $$
  select p_rol in ('auditor', 'admin_plataforma')
$$;

comment on function app.es_rol_supervisor is
  'Roles cuya membresía NO puede tocar un socio del propio tenant (incidente #5). '
  '`admin_plataforma` es estructural: es staff de la plataforma, no del estudio (0001:36). '
  '`auditor` es la decisión de negocio: existe para mirar lo que el socio hace. '
  'Si el titular decide otra cosa, se cambia el cuerpo de esta función y nada más.';

drop policy membership_wr on membership;

-- La `using` gobierna la fila QUE YA ESTÁ (update/delete); la `with check`, la que QUEDA.
-- Las dos necesitan el predicado: sin el `using`, el socio podría tocar la fila del auditor
-- mientras el resultado siga siendo válido.
create policy membership_wr on membership for all
  using      ( tenant_node_id in (select app.accessible_tenant_ids())
               and app.has_role_on(tenant_node_id, array['admin_plataforma','socio']::app.rol_membership[])
               and ( not app.es_rol_supervisor(rol)
                     or app.has_role_on(tenant_node_id, array['admin_plataforma']::app.rol_membership[]) ) )
  with check ( tenant_node_id in (select app.accessible_tenant_ids())
               and app.has_role_on(tenant_node_id, array['admin_plataforma','socio']::app.rol_membership[])
               and ( not app.es_rol_supervisor(rol)
                     or app.has_role_on(tenant_node_id, array['admin_plataforma']::app.rol_membership[]) ) );

commit;
