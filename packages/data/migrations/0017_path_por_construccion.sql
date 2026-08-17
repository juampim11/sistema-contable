-- =============================================================================
-- 0017 — El `path` de `tenant_node` deja de ser un dato que hay que vigilar y pasa a ser una
--        CONSECUENCIA de (parent_id, nid) que la base no puede dejar de cumplir.
--
-- 🔴 CIERRA DE VERDAD EL INCIDENTE #2. La 0016 lo dejó abierto por tres lados.
--
-- ## Qué encontró la ronda de cierre sobre 0016 (los tres, reproducidos)
--
--   A. `nid` no está en la lista de columnas de NINGÚN trigger (ni 0016:148, ni 0001:115/127/143).
--      `nid` es `generated always as identity`: no admite literal, PERO SÍ `DEFAULT`. Medido, como
--      socio ordinario y con 0016 puesta:
--        * `update tenant_node set nid = default where id = <cliente propio>` COMMITEA y deja el
--          árbol incoherente. Multi-fila y `MERGE` también.
--        * `update tenant_node set nid = default, parent_id = parent_id` es PEOR: el
--          `before update of parent_id` de 0001:127 RECALCULA el path con el nid nuevo, el resultado
--          sale coherente, y el path quedó reescrito SIN `reparentar_nodo()` y SIN el GUC. La
--          afirmación de 0001:130 ("la única vía de reescritura es app.reparentar_nodo()") era falsa.
--        * `insert ... overriding system value` con `nid` explícito mina el secuencial GLOBAL y hace
--          fallar altas de OTROS estudios contra `tenant_node_nid_key`.
--
--   B. El barrido de hijos de 0016:128-138 FALLA ABIERTO: re-lee los hijos BAJO RLS y trata
--      `not found` como no-op — el mismo bug que el encabezado de 0016 documenta con todas las letras
--      para la re-lectura principal, repetido cuarenta líneas más abajo.
--
--   C. `not found` confunde tres situaciones y sólo una es un ataque: (a) el atacante se auto-ocultó
--      la fila, (b) la fila se BORRÓ en la misma transacción, (c) baja lógica. (b) no tiene nada que
--      ver con RLS —se reproduce como dueño superusuario— y ya rompió algo real: dejó ROJO
--      `packages/data/sql/tests/0001_aislamiento.test.sql`, que corre en CI.
--
-- ## 🔴 Y lo que NO cierra el incidente: la rama `not found`
--
-- MEDIDO: con `security definer` puesto y `not found` tratado como no-op, el ataque original del #2
-- SIGUE BLOQUEADO — por la comparación de coherencia, no por `not found`. El encabezado de 0016
-- atribuye el cierre a la rama equivocada.
--
-- `not found` nunca fue un control: fue una COMPENSACIÓN POR UNA CEGUERA AUTOINFLIGIDA. El trigger
-- era `invoker`, así que la RLS le tapaba justo la fila que tenía que validar.
--
-- ## El invariante, enunciado como corresponde
--
--   Para toda fila n de tenant_node, en todo estado observable:
--       n.path = coalesce(padre(n).path || '.', '') || n.nid      con n.nid INMUTABLE
--   verificado sobre el ESTADO FÍSICO de la tabla, sin excepción por rol, por GUC, por vía de
--   escritura (UPDATE / MERGE / COPY / multi-fila) ni por BYPASSRLS.
--
--   COROLARIO: un invariante verificado con la visibilidad del escritor NO es un invariante. Si el
--   control lee la tabla con los privilegios de quien escribe, quien escribe elige lo que el control
--   ve. 0016 intentó convertir esa ceguera en el control mismo.
--
-- ## Por qué CHECK + FOREIGN KEY y no un trigger (la decisión de fondo)
--
-- El invariante es REFERENCIAL: relaciona una fila con otra por una clave. Y Postgres exime a la
-- integridad referencial de la RLS POR DISEÑO — `check`, `unique` y `foreign key` se evalúan siempre,
-- sobre el estado físico, para todos los roles. Los triggers NO.
--
-- Meter un invariante referencial en un trigger es exactamente lo que obligaba a `security definer`,
-- que viola R11 y pedía un ADR. Bajado al escalón que le corresponde, el problema desaparece:
-- R11 NO SE TOCA y no hace falta ningún ADR.
--
--   (1) `parent_path` vuelve el predicado FILA-LOCAL ⇒ entra en un CHECK inmediato. Un CHECK no se
--       difiere, no lo apaga `disable trigger all`, y se aplica al dueño, al superusuario y a `COPY`.
--   (2) La FK COMPUESTA `(parent_id, parent_path) -> (id, path)` obliga a que ese espejo sea el path
--       REAL Y ACTUAL del padre. Cierra B: si un padre cambia de path, TODOS sus hijos tienen que
--       haberse actualizado en la misma transacción o el commit aborta. No puede fallar abierto
--       porque no pasa por la RLS.
--
--   `match full` y no el `match simple` por omisión: con SIMPLE, un `parent_path` nulo satisface la
--   FK "gratis" y el CHECK admitiría `path = nid` — o sea, sacar un nodo del subárbol de su propio
--   estudio poniéndole un path de raíz. Reproducido.
--
-- ## Por qué la FK va DIFERIDA y el CHECK no
--
-- `reparentar_nodo()` reescribe el path del subárbol ANTES de mover el `parent_id`: hay un estado
-- intermedio donde (parent_id, parent_path) todavía no cierra. El CHECK, en cambio, es fila-local y
-- no necesita diferirse: alcanza con escribir `path` y `parent_path` en la MISMA sentencia, que es lo
-- que hace la versión nueva de la función.
--
-- ## Por qué la FK va `no action` y NO `restrict`
--
-- `restrict` dispara de inmediato aunque la constraint esté diferida: rompería el reparentado en el
-- estado intermedio. `no action` es la única que respeta el diferimiento. La `on delete restrict` de
-- 0001 sobre `parent_id` sigue en pie e inmediata: no se pierde esa semántica.
--
-- ## MECANISMO DE BASE vs. PRIVILEGIO — y por qué hacen falta los dos
--
--   MECANISMO: sobrevive a BYPASSRLS, al dueño, a `COPY` y a un psql a las tres de la mañana.
--     tenant_node_path_chk · tenant_node_parent_path_nulo_chk · tenant_node_parent_path_fk ·
--     trg_tenant_node_nid_inmutable
--   PRIVILEGIO (§6): es AUTORIZACIÓN, y es lo ÚNICO que cierra el minado del secuencial global,
--     porque cualquier valor de `nid` es íntegramente válido — no hay constraint que lo rechace.
--
--   Ninguno alcanza solo: sólo mecanismo deja pasar `overriding system value`; sólo privilegio deja
--   al dueño y a cualquier script de mantenimiento romper el árbol en silencio.
--
-- ## 🔴 El backfill NO puede correr con `force row level security` puesto
--
-- MEDIDO con un dueño NO superusuario (lo que ADR-0002 exige en producción, y que en local no se
-- nota porque el dueño local SÍ es superusuario): el `update` del backfill afecta 0 filas EN
-- SILENCIO, y el `add constraint` recién aborta después. Por eso el backfill va dentro de una ventana
-- explícita `no force`/`force`, con su verificación ADENTRO — una verificación hecha afuera leería 0
-- filas y sería verde por vacuidad.
--
-- La ventana NO es una exposición: `alter table` toma ACCESS EXCLUSIVE y lo retiene hasta el commit
-- (medido: otra sesión no puede ni leer). Y toda la migración es UNA transacción: si algo falla,
-- revierte entera, `force` incluido.
--
-- ## Costo (MEDIDO, PG16, árbol de 6603 nodos, 3 corridas por caso)
--
--                                       sin guarda(0015)   0016        0017
--   reparentar 801 nodos — TOTAL             ~33 ms      ~630 ms     ~148 ms
--   reparentar 1 nodo hoja — total          17,4 ms      14,4 ms      6,2 ms   <- MÁS RÁPIDO
--   alta, por fila                           111 us      213 us      169 us
--   lectura (20 resoluciones de subárbol)     34 ms        34 ms       36 ms
--   tamaño con índices (5103 nodos)         1848 kB      1856 kB     2304 kB
--
--   0017 es ~5x más barato que 0016 en el reparentado, porque desaparece el scan completo del árbol.
--   Lo que 0017 paga y 0016 no: +110 us por fila en el DELETE FÍSICO (irrelevante: el diseño es
--   soft-delete, 0001:59) y +24 % de tamaño.
--
--   Y las cifras del encabezado de 0016 NO REPRODUCEN: se cronometró la LLAMADA a la función, que es
--   justo donde un trigger DIFERIDO no corre. Todo el costo aterriza en el COMMIT. Mismo patrón que
--   R10: se midió lo que era fácil de medir.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. La columna espejo, y su backfill DENTRO de la ventana sin `force`
-- -----------------------------------------------------------------------------

alter table tenant_node add column parent_path text;

comment on column tenant_node.parent_path is
  'Espejo del `path` del padre. NO es dato: es lo que vuelve FILA-LOCAL —y por lo tanto verificable '
  'con un CHECK inmediato, inmune a la RLS— el invariante path = padre.path || ''.'' || nid. Su '
  'veracidad la sostiene la FK compuesta tenant_node_parent_path_fk. N1, no exportable (contiene '
  'nid, R25). Nullable a propósito: las raíces no tienen padre, y esa nulidad la gobierna '
  'tenant_node_parent_path_nulo_chk.';

-- Ver el encabezado: con `force row level security` este update afecta 0 filas EN SILENCIO cuando el
-- dueño no es superusuario. La ventana está protegida por el ACCESS EXCLUSIVE del propio ALTER.
alter table tenant_node no force row level security;

update tenant_node c
   set parent_path = p.path
  from tenant_node p
 where p.id = c.parent_id;

-- La verificación va ADENTRO de la ventana: afuera leería 0 filas y sería verde por vacuidad.
do $$
declare v_n bigint;
begin
  select count(*) into v_n from tenant_node
   where (parent_id is null) <> (parent_path is null);
  if v_n <> 0 then
    raise exception '0017: backfill incompleto en % fila(s) (parent_id y parent_path discrepan en nulidad)', v_n;
  end if;

  select count(*) into v_n
    from tenant_node c join tenant_node p on p.id = c.parent_id
   where c.parent_path is distinct from p.path;
  if v_n <> 0 then
    raise exception '0017: backfill inconsistente en % fila(s)', v_n;
  end if;

  select count(*) into v_n from app.verificar_coherencia_path();
  if v_n <> 0 then
    raise exception
      '0017 ABORTADA: el árbol YA está incoherente en % fila(s). Reparar ANTES de aplicar esta '
      'migración: es estado del incidente #2, no un problema de la migración.', v_n;
  end if;
end $$;

alter table tenant_node force row level security;

-- -----------------------------------------------------------------------------
-- 2. El invariante FILA-LOCAL: dos CHECK inmediatos
-- -----------------------------------------------------------------------------

alter table tenant_node
  add constraint tenant_node_path_chk
  check (path = coalesce(parent_path || '.', '') || nid::text);

alter table tenant_node
  add constraint tenant_node_parent_path_nulo_chk
  check ((parent_id is null) = (parent_path is null));

-- -----------------------------------------------------------------------------
-- 3. El invariante REFERENCIAL: la FK compuesta, diferida
-- -----------------------------------------------------------------------------
--
-- El unique (id, path) es el requisito de Postgres para referenciar ese par. No agrega unicidad nueva
-- ni ningún oráculo: `id` ya es PK y `path` ya era único global desde 0001 (uq_tenant_node_path).

alter table tenant_node
  add constraint uq_tenant_node_id_path unique (id, path);

alter table tenant_node
  add constraint tenant_node_parent_path_fk
  foreign key (parent_id, parent_path) references tenant_node (id, path)
  match full
  deferrable initially deferred;

-- La comprobación del lado referenciante busca por (parent_id, parent_path). `idx_tenant_node_parent`
-- cubre sólo la primera columna; con este índice el chequeo del commit queda en index-only scan.
create index idx_tenant_node_parent_path on tenant_node (parent_id, parent_path);

-- -----------------------------------------------------------------------------
-- 4. El trigger de alta también llena `parent_path`
-- -----------------------------------------------------------------------------
-- R10 (incidente #1): `pg_catalog` primero, `pg_temp` último, todo calificado por esquema.

create or replace function app.tenant_node_set_path() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_path_padre text;
begin
  if new.parent_id is null then
    new.parent_path := null;
    new.path        := new.nid::text;
  else
    select path into v_path_padre from public.tenant_node where id = new.parent_id;
    if v_path_padre is null then
      raise exception 'parent_id % inexistente', new.parent_id;
    end if;
    new.parent_path := v_path_padre;
    new.path        := v_path_padre || '.' || new.nid::text;
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- 5. `nid` es INMUTABLE
-- -----------------------------------------------------------------------------
-- Va como MECANISMO además de como privilegio, porque el grant por columna no le aplica al dueño.
--
-- La lista `of nid` acá SÍ es exacta y no es la clase de whitelist que causó A: `before update of
-- nid` dispara exactamente cuando `nid` aparece en el SET, que es la única forma en que un identity
-- puede cambiar (`set nid = default`). MEDIDO: sin la lista, el trigger corre en TODO update y cuesta
-- ~+14 us por fila sobre updates que no tienen nada que ver con el nid.

create or replace function app.rechazar_nid_manual() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if new.nid is distinct from old.nid then
    raise exception 'tenant_node.nid es inmutable (% -> %)', old.nid, new.nid
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_tenant_node_nid_inmutable on tenant_node;
create trigger trg_tenant_node_nid_inmutable
  before update of nid on tenant_node
  for each row execute function app.rechazar_nid_manual();

-- El constraint trigger de 0016 queda subsumido por §2 y §3, y se lleva sus tres agujeros. El `drop
-- function` es seguro y NO contradice el criterio de 0015 (que prohibía dropear funciones con 49
-- policies colgando): esta función sólo tenía ese trigger, y ninguna policy la referencia.
drop trigger  if exists trg_tenant_node_path_coherente on tenant_node;
drop function if exists app.exigir_path_coherente();

-- -----------------------------------------------------------------------------
-- 6. Reparentado: path y parent_path en la MISMA sentencia
-- -----------------------------------------------------------------------------
-- El CHECK no es diferible, así que no puede haber una sentencia intermedia con el path nuevo y el
-- parent_path viejo. La FK sí es diferible, y es la que tolera que `parent_id` se mueva un renglón
-- más abajo.
--
-- Se saca el `verificar_coherencia_path()` del final: era un scan COMPLETO del árbol por reparentado
-- y ahora es redundante — la base ya no puede aceptar un árbol incoherente, así que si el rewrite
-- quedara mal, el COMMIT aborta solo. MEDIDO: reparentar un nodo hoja pasa de 17,4 ms a 6,2 ms.
-- La función SIGUE EXISTIENDO (INV-12): cambia de rol, de "el control" a "el detector de que alguien
-- desarmó el control".

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
  -- Sigue haciendo falta: `app.rechazar_path_manual()` rechaza toda escritura de `path` sin este GUC.
  -- Ya no es una excepción a la INTEGRIDAD —eso lo cierran §2 y §3— sino, como debió ser siempre, una
  -- excepción a la PROHIBICIÓN.
  perform set_config('app.reparentando', 'on', true);

  select path, nid into v_path_viejo, v_nid from public.tenant_node where id = p_nodo;
  if v_path_viejo is null then
    raise exception 'nodo % inexistente', p_nodo;
  end if;

  select path into v_path_padre from public.tenant_node where id = p_nuevo_padre;
  if v_path_padre is null then
    raise exception 'nuevo padre % inexistente', p_nuevo_padre;
  end if;

  if v_path_padre = v_path_viejo or v_path_padre like v_path_viejo || '.%' then
    raise exception 'ciclo: % está dentro del subárbol de %', p_nuevo_padre, p_nodo;
  end if;

  v_path_nuevo := v_path_padre || '.' || v_nid::text;

  update public.tenant_node
     set path        = v_path_nuevo || substring(path from length(v_path_viejo) + 1),
         parent_path = case
                         when id = p_nodo then v_path_padre
                         else v_path_nuevo || substring(parent_path from length(v_path_viejo) + 1)
                       end,
         updated_at  = now()
   where path = v_path_viejo or path like v_path_viejo || '.%';

  update public.tenant_node
     set parent_id = p_nuevo_padre, updated_at = now()
   where id = p_nodo;
end $$;

-- -----------------------------------------------------------------------------
-- 7. PRIVILEGIO: la aplicación no escribe la estructura del árbol
-- -----------------------------------------------------------------------------
--
-- La regla, dicha de una forma que se pueda recordar y verificar:
--   `app_request` y `app_job` escriben TODO menos las tres columnas que SON el árbol: `nid`, `path`
--   y `parent_path`. Única excepción: `app_job` sobre `path`/`parent_path`, porque
--   `app.reparentar_nodo()` corre con su identidad (no es `security definer`).
--   `nid` no lo escribe NADIE: ni la aplicación, ni los jobs.
--
-- Esto es lo único que cierra el minado del secuencial global vía `overriding system value`:
-- cualquier valor de `nid` es ÍNTEGRAMENTE válido, así que no hay constraint que lo pueda rechazar.
--
-- 🔴 OJO al aplicar algo parecido en otra tabla: `revoke update (col)` sobre un grant de TABLA es un
-- NO-OP SILENCIOSO (medido: la ACL queda idéntica, sin error). Hay que revocar a nivel tabla y
-- re-otorgar columna por columna, que es lo que se hace acá.
--
-- MEDIDO: el alta normal sigue funcionando. `escrituras.ts:120` inserta (id, tipo, nombre,
-- parent_id) y `sembrar.ts:133` inserta (tipo, nombre, parent_id); `path` y `parent_path` los pone el
-- BEFORE trigger, y una columna que asigna un trigger NO requiere privilegio de columna.

revoke all            on tenant_node from public;
revoke insert, update on tenant_node from app_request, app_job;

grant insert (id, parent_id, tipo, nombre, deleted_at, created_at, updated_at)
  on tenant_node to app_request, app_job;

grant update (parent_id, tipo, nombre, deleted_at, updated_at)
  on tenant_node to app_request, app_job;

-- Sólo para `app.reparentar_nodo()`, que corre como app_job.
grant update (path, parent_path) on tenant_node to app_job;

-- `select` y `delete` quedan como los dejó 0001: no tienen granularidad de columna que sirva acá.

commit;
