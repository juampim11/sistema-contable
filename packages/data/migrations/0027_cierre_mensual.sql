-- =============================================================================
-- 0027_cierre_mensual.sql — Capa D del cierre mensual: esquema, TABLAS VACÍAS
--
-- Especificado en `docs/diseno/23-arquitectura-cierre-mensual.md` (diseño de referencia) y cerrado por
-- TRES convocatorias reales: `24-convocatoria-real-cierre-mensual.md` (D-1 a D-23),
-- `25-segunda-convocatoria-cierre-mensual.md` (D-14, D-19, D-16, D-18, D-20, D-24, D-25) y
-- `26-migracion-cierre-mensual.md` (esta migración: cierre de D-25 puntual + convocatoria completa
-- de `dba-data` + `security-engineer` + `seguridad-datos-financieros` + `arquitecto-software`).
--
-- ONCE TABLAS, TODAS VACÍAS. Sin backfill (D-17: el backfill de los 3 lotes reales de `lote_ingesta`
-- espera al primer consumidor real — Commits 3/4 de liquidaciones o Capa D — no a esta migración).
-- Ninguna función `SECURITY DEFINER` nueva (condición dura de esta tarea, incidente de recursión de
-- `accessible_tenant_ids()` — `04`).
--
-- ## Tres correcciones REALES que la convocatoria de esta migración encontró sobre el diseño de `23`
--
-- 1. **`total_debe`/`total_haber` de `asiento_propuesto` NO son columnas físicas.** El diseño original
--    (`24` §3/D-18) proponía un trigger que las mantuviera y las volviera "no escribibles por
--    `app_request`" — verificado NO IMPLEMENTABLE sin `SECURITY DEFINER`: un trigger sin `DEFINER`
--    corre con los privilegios de quien dispara el DML, así que revocarle el `UPDATE` al invocador
--    también se lo revoca al trigger. Peor: aun con el grant abierto, un `UPDATE` directo sobre
--    `asiento_propuesto` (sin tocar un solo renglón) podía corromper lo que el contador ve en el paso 7
--    (revisión, ANTES de confirmar) sin que el recálculo de confirmación lo detectara a tiempo.
--    Se reemplaza por la vista `asiento_propuesto_totales` (`security_invoker = true`, PG16), calculada
--    siempre desde los renglones — no hay caché que corromper. La garantía de `debe = haber` pasa a
--    vivir en DOS puntos determinísticos de código (no en un `CHECK` de tabla): al proponer (TypeScript,
--    antes del `INSERT`) y al confirmar (recálculo dentro de `conUsuario`, D-18 sin cambios). Ninguno de
--    los dos es tarea de esta migración — son Capa D, fuera de alcance acá.
-- 2. **El gate de confirmación de D-24 no puede vivir solo en la función de aplicación que confirma.**
--    Nada en el esquema impedía que otro código (un script de soporte, un job de mantenimiento futuro)
--    hiciera `UPDATE cierre_cliente_periodo SET cierre_estado='confirmado'` sin pasar por ese control —
--    mismo patrón que ya costó R33/R13 (un control que depende de que el código lo recuerde no es un
--    control). Se mecaniza como DOS capas independientes, ninguna con `SECURITY DEFINER`: (a) RLS
--    restringe por ROL Y POR VALOR — `administrativo` no puede escribir `cierre_estado` hacia
--    `confirmado`/`anulado`, solo `socio`/`contador` pueden; (b) un trigger `BEFORE UPDATE OF
--    cierre_estado` (intra-tenant, invoker) rechaza la transición a `confirmado` si queda un
--    `pendiente_cierre` `abierto` de fuente esperada-confirmada — corre para CUALQUIER rol que llegue a
--    intentarlo, no solo para el camino "oficial".
-- 3. **`pendiente_cierre.motivo` se renombra a `motivo_codigo`.** Verificado contra
--    `packages/contabilidad/src/nucleo/tipos.ts:139-141`: el repo YA tiene la regla escrita — `motivo`
--    a secas es un nombre que el registro de clasificación (`clasificacion-campos.ts`) ya usa para
--    prosa libre N2 (`registro_auditoria.motivo`, `credencial_fiscal_rotacion.motivo`); un CÓDIGO de
--    vocabulario cerrado con ese mismo nombre heredaría esa clasificación sin merecerla. Mismo mecanismo
--    que ya forzó el renombre de `estado` a `cierre_estado`/`asiento_estado`/`pendiente_estado` (D-19).
--    `cierre_transicion.motivo` y `pendiente_dispensa.motivo` SÍ se quedan como `motivo` — ahí es prosa
--    libre genuina escrita por una persona, el caso correcto para N2.
--
-- ## Hallazgos de forma, incorporados sin discusión (mecánicos, no de criterio)
--
-- - Seis tablas necesitaban su propio `unique(cliente_id, id)` (renglón (10) de la plantilla ampliada)
--   que el boceto de `23` no tenía escrito — sin él, las FK compuestas tenant-consistentes que el mismo
--   boceto ya asumía no se pueden crear. Están todas acá.
-- - `documento_ingerido.banco_codigo` (no `banco_id uuid` como decía el boceto original): `banco.codigo`
--   es `text primary key` en `0004`, no existe `banco.id`.
-- - `UNIQUE (...) NULLS NOT DISTINCT` (PG15+, confirmado PG16 en ambos `docker-compose*.yml`) resuelve
--   el caso NULL en los índices únicos que `dba-data` había dejado sin cerrar en `24`.
-- - `cierre_cliente_periodo` NO tiene `superseded_by_id` (usa máquina de estados, D-6) — el índice único
--   de "un cierre vigente por período" usa `WHERE cierre_estado <> 'anulado'`, no la condición de `23`
--   §2.2 que asumía una columna que esa misma sección de `23` no declaraba (contradicción real,
--   encontrada por `dba-data` en `24`, cerrada acá).
-- - Ninguna de las once tablas usa `for all`: las once quedan N1/N2 sin N2-R (D-16/D-18/D-20), así que
--   el mecanismo del incidente de `movimiento_origen_crudo` no aplica por lectura restringida — pero
--   `auditor` lee las once y no escribe ninguna, y varias tienen asimetría real de autorización por
--   VALOR (`cierre_cliente_periodo`, `pendiente_cierre`, `asiento_propuesto`: `administrativo` puede
--   proponer/consolidar, nunca confirmar ni dispensar). `for all` no puede expresar esa asimetría.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `cuenta` — identidad estable del plan de cuentas (D-15)
-- -----------------------------------------------------------------------------
--
-- Deliberadamente vacía de atributos: lo que cambia (código, denominación, rol funcional) vive en
-- `cuenta_atributo`, con su propia vigencia. Esto es lo que permite que un renglón de asiento ya
-- confirmado siga citando la misma cuenta aunque Laura la renombre después (D-15).
create table cuenta (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references tenant_node(id) on delete restrict,
  creada_en   timestamptz not null default now(),

  constraint uq_cuenta_tenant unique (cliente_id, id)
);

create index idx_cuenta_cliente on cuenta(cliente_id);

create trigger trg_cuenta_cliente
  before insert or update of cliente_id on cuenta
  for each row execute function app.exigir_nodo_cliente();

alter table cuenta enable row level security;
alter table cuenta force  row level security;

create policy cuenta_sel on cuenta for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- Definir la estructura del plan de cuentas es criterio contable, no carga administrativa. Sin
-- `administrativo`: es quien "carga y clasifica", nunca quien define qué cuentas existen (`0001:39`).
create policy cuenta_ins on cuenta for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE para nadie: es la identidad estable. Lo que cambia vive en `cuenta_atributo`.

grant select, insert on cuenta to app_request;

-- -----------------------------------------------------------------------------
-- 2. `cuenta_atributo` — vigencia por cuenta (D-15, D-25)
-- -----------------------------------------------------------------------------
--
-- Segunda convocatoria real (D-25, `plan-cuentas-multicliente` + `dba-data`, cerrada en una vuelta):
-- `padron_socio_id` reemplaza la dependencia exclusiva de `denominacion` en texto libre para representar
-- "esta cuenta es de tal socio" — el check de dígitos que protege `denominacion` (abajo) bloquea
-- NÚMEROS, nunca NOMBRES, así que no duplicar el dato es la única defensa estructural real.
--
-- `rol_funcional` es un catálogo cerrado cuyo contenido completo es de `contador-dominio` (no de esta
-- migración) — la familia "ligada a un socio puntual" queda PROVISIONAL con los dos casos ya reales
-- del proyecto (`retiro_de_socio`/`aporte_de_socio`, citados en `23` §4.2 P9) más el caso genérico de
-- `25` §3. Ampliar esta lista es aditivo (`ALTER TYPE`/nuevo valor de `check`), no re-clasifica nada
-- ya escrito.
create table cuenta_atributo (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references tenant_node(id) on delete restrict,
  cuenta_id        uuid not null,
  codigo           text not null,
  -- N2: mismo nivel que `padron_socio.denominacion` — se clasifica por el peor caso, porque puede
  -- llevar el nombre de un socio. El check de dígitos no protege nombres (solo números): la defensa
  -- real es `padron_socio_id` de abajo, no este check.
  denominacion     text not null,
  nivel            integer not null,
  cuenta_padre_id  uuid,
  -- N2 (seguridad-datos-financieros, esta convocatoria): afirma un hecho real sobre la relación
  -- societaria de este cliente, no solo "en qué paso del proceso está" — mismo argumento que ya
  -- clasificó `reconocimiento_contrapartida.admite_matches` en N2 pese a ser un vocabulario cerrado.
  rol_funcional    text not null,
  -- D-25: NULL salvo que `rol_funcional` esté en la familia "ligada a un socio puntual". N2 (mismo
  -- nivel que `reconocimiento_contrapartida_match.socio_id`): seudónimo estable de una persona.
  padron_socio_id  uuid,
  activa           boolean not null default true,
  vigente_desde    date not null,
  vigente_hasta    date,
  -- Qué documento/decisión acredita el cambio — nunca una vigencia nueva sin motivo declarado.
  respaldo         text not null,
  creada_en        timestamptz not null default now(),

  constraint cuenta_atributo_rol_funcional_chk
    check (rol_funcional in ('generica', 'cuenta_particular_socio', 'aporte_de_socio',
                              'retiro_de_socio')),
  -- D-25: equivalencia, no solo implicación — un rol_funcional fuera de la familia RECHAZA
  -- padron_socio_id cargado por error, no solo tolera su ausencia (dba-data, esta convocatoria).
  constraint cuenta_atributo_padron_socio_chk
    check ( (rol_funcional in ('cuenta_particular_socio', 'aporte_de_socio', 'retiro_de_socio'))
            = (padron_socio_id is not null) ),
  constraint cuenta_atributo_vigencia_chk
    check (vigente_hasta is null or vigente_hasta > vigente_desde),
  constraint uq_cuenta_atributo_serie unique (cliente_id, cuenta_id, vigente_desde),
  constraint uq_cuenta_atributo_tenant unique (cliente_id, id),

  constraint fk_cuenta_atributo_cuenta
    foreign key (cliente_id, cuenta_id) references cuenta (cliente_id, id) on delete restrict,
  constraint fk_cuenta_atributo_padre
    foreign key (cliente_id, cuenta_padre_id) references cuenta (cliente_id, id) on delete restrict,
  -- Nota (dba-data, convocatoria de D-25): `padron_socio_id` referencia la SERIE de alta vigente al
  -- momento de la clasificación, no una identidad eterna de la persona — un socio que se va y vuelve
  -- es una fila nueva de `padron_socio` con `id` nuevo. No es un problema: `padron_socio` no admite
  -- DELETE, así que esta FK nunca queda huérfana, y una `cuenta_atributo` histórica sigue apuntando a
  -- la serie correcta de ESE período (mismo criterio que `cuenta_ref`, D-15: dato congelado).
  constraint fk_cuenta_atributo_socio
    foreign key (cliente_id, padron_socio_id) references padron_socio (cliente_id, id)
    on delete restrict
);

-- Una sola vigencia ABIERTA por cuenta (mismo mecanismo que `uq_padron_socio_vigente`, `0013`).
create unique index uq_cuenta_atributo_vigente
  on cuenta_atributo (cliente_id, cuenta_id) where vigente_hasta is null;
create index idx_cuenta_atributo_cliente on cuenta_atributo(cliente_id);
-- Sin índice sobre `padron_socio_id`: sin consulta real que lo justifique todavía (regla de
-- `dba-data`, "un índice se agrega con su consulta, medida" — volumen real de ROKA/HYJ es trivial).

create trigger trg_cuenta_atributo_cliente
  before insert or update of cliente_id on cuenta_atributo
  for each row execute function app.exigir_nodo_cliente();

alter table cuenta_atributo enable row level security;
alter table cuenta_atributo force  row level security;

create policy cuenta_atributo_sel on cuenta_atributo for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- Renombrar o reclasificar una cuenta es decisión contable — mismo criterio que `cuenta`, nunca
-- `administrativo`.
create policy cuenta_atributo_ins on cuenta_atributo for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

-- UPDATE solo para cerrar una vigencia (nunca para reescribir código/denominación de una vigencia ya
-- escrita) — mismo patrón exacto que `padron_socio` (`0013`, `grant update (denominacion,
-- vigente_hasta)`; acá es la columna de cierre de vigencia, no de contenido).
create policy cuenta_atributo_upd on cuenta_atributo for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert on cuenta_atributo to app_request;
grant update (vigente_hasta, activa) on cuenta_atributo to app_request;

-- -----------------------------------------------------------------------------
-- 3. `documento_ingerido` — registro único de "qué se subió" (D-3, D-17)
-- -----------------------------------------------------------------------------
--
-- Nace VACÍA. El backfill de los 3 lotes reales de `lote_ingesta` (Bancor/Nación/ICBC) espera al primer
-- consumidor real (D-17) — y antes de ese backfill hay que cerrar la semántica de `periodo_desde`/
-- `periodo_hasta` para documentos MULTI-CUENTA (hallazgo de `dba-data`, `10-deuda-declarada.md` §B.7):
-- un archivo puede traer N cuentas con períodos distintos, y esta columna no puede promediarlos en
-- silencio. No es un problema hoy porque la tabla no tiene una sola fila todavía.
create table documento_ingerido (
  id                    uuid primary key default gen_random_uuid(),
  cliente_id            uuid not null references tenant_node(id) on delete restrict,
  tipo_documento         text not null,
  -- Catálogo N0, no uuid: `banco.codigo` es la PK real (`0004`). Nulo para Libro IVA (sin banco).
  banco_codigo          text references banco(codigo) on delete restrict,
  periodo_desde         date not null,
  periodo_hasta         date not null,
  cobertura             text not null,
  -- N1, exportable:false — clave de storage, no contenido. Mismo criterio que `lote_ingesta.
  -- archivo_clave`: nunca lleva el hash del contenido (eso volvería al storage un oráculo de "¿tenés
  -- este archivo?").
  objeto_almacenamiento text not null,
  ingerido_en           timestamptz not null default now(),
  superseded_by_id      uuid,
  creado_en             timestamptz not null default now(),

  constraint documento_ingerido_tipo_chk
    check (tipo_documento in ('extracto', 'fci', 'liquidacion_tarjeta', 'libro_iva_compras',
                               'libro_iva_ventas')),
  constraint documento_ingerido_cobertura_chk
    check (cobertura in ('completo', 'parcial', 'corte_a_fecha')),
  constraint documento_ingerido_periodo_chk check (periodo_hasta >= periodo_desde),
  constraint uq_documento_ingerido_tenant unique (cliente_id, id),
  constraint uq_documento_ingerido_natural
    unique nulls not distinct (cliente_id, tipo_documento, banco_codigo, periodo_desde, periodo_hasta,
                                objeto_almacenamiento),

  constraint fk_documento_ingerido_superseded
    foreign key (cliente_id, superseded_by_id) references documento_ingerido (cliente_id, id)
    on delete restrict
);

create index idx_documento_ingerido_cliente on documento_ingerido(cliente_id);
create index idx_documento_ingerido_cliente_tipo on documento_ingerido(cliente_id, tipo_documento);

create trigger trg_documento_ingerido_cliente
  before insert or update of cliente_id on documento_ingerido
  for each row execute function app.exigir_nodo_cliente();

alter table documento_ingerido enable row level security;
alter table documento_ingerido force  row level security;

create policy documento_ingerido_sel on documento_ingerido for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- Ingerir es el trabajo central de `administrativo` (mismo rol que `lote_ingesta`).
create policy documento_ingerido_ins on documento_ingerido for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- Solo `superseded_by_id` es mutable (re-ingesta de un documento corregido) — column-grant, no una
-- policy de valor: no hay un "estado" que restringir por rol acá, a diferencia de `cierre_cliente_
-- periodo`.
create policy documento_ingerido_upd on documento_ingerido for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

grant select, insert on documento_ingerido to app_request;
grant update (superseded_by_id) on documento_ingerido to app_request;

-- -----------------------------------------------------------------------------
-- 4. `cierre_cliente_periodo` — la entidad central (D-1, D-2, D-6, D-19)
-- -----------------------------------------------------------------------------
--
-- SIN `superseded_by_id`: no se supersede (D-6), usa máquina de estados con historial en
-- `cierre_transicion`. El índice único de "un cierre vigente por período" usa `cierre_estado <>
-- 'anulado'`, no una columna de supersesión que esta tabla no tiene (contradicción real que `dba-data`
-- encontró entre `23` §2.2 y §2.4, cerrada acá). Sostiene reintentos arbitrarios del mismo período —
-- lo que NO sostiene por sí sola es reconstruir cuál intento reemplazó a cuál anulado; eso se lee de
-- `created_at` + `cierre_transicion`, no hace falta esquema nuevo para eso (dba-data, esta convocatoria).
create table cierre_cliente_periodo (
  id                 uuid primary key default gen_random_uuid(),
  cliente_id         uuid not null references tenant_node(id) on delete restrict,
  tipo_periodo       text not null,
  periodo_desde      date not null,
  periodo_hasta      date not null,
  -- N2 (D-19): agregado de todo un período de UN cliente, no metadato de proceso — revela puntualidad
  -- contable real, mismo tier que `periodo_desde`/`periodo_hasta`.
  cierre_estado      text not null default 'abierto',
  cierre_anterior_id uuid,
  confirmado_en      timestamptz,
  -- N1: identidad declarada ≠ autenticada (mismo patrón `manifestado_por`).
  confirmado_por     uuid,
  creado_en          timestamptz not null default now(),

  constraint cierre_periodo_tipo_chk check (tipo_periodo in ('mensual', 'ejercicio')),
  constraint cierre_periodo_estado_chk
    check (cierre_estado in ('abierto', 'en_ingesta', 'en_consolidacion', 'en_revision', 'confirmado',
                              'anulado')),
  constraint cierre_periodo_periodo_chk check (periodo_hasta >= periodo_desde),
  constraint cierre_periodo_confirmacion_chk
    check ( (cierre_estado = 'confirmado') = (confirmado_en is not null and confirmado_por is not null) ),
  constraint uq_cierre_periodo_tenant unique (cliente_id, id),

  constraint fk_cierre_periodo_anterior
    foreign key (cliente_id, cierre_anterior_id) references cierre_cliente_periodo (cliente_id, id)
    on delete restrict
);

-- Postgres no admite predicado en una `constraint unique`, así que la unicidad "un cierre vigente por
-- período" se declara como índice parcial, no como constraint de tabla.
create unique index uq_cierre_periodo_vigente
  on cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
  where cierre_estado <> 'anulado';

comment on index uq_cierre_periodo_vigente is
  'Un cierre anulado sale del predicado para siempre: un reintento del mismo período es una fila '
  'NUEVA, no un update, y puede anularse de nuevo sin límite. No reconstruye por sí solo cuál intento '
  'reemplazó a cuál anulado — eso se lee de created_at + cierre_transicion (dba-data, 0027).';

create index idx_cierre_periodo_cliente on cierre_cliente_periodo(cliente_id);
create index idx_cierre_periodo_cliente_estado on cierre_cliente_periodo(cliente_id, cierre_estado);

create trigger trg_cierre_periodo_cliente
  before insert or update of cliente_id on cierre_cliente_periodo
  for each row execute function app.exigir_nodo_cliente();

alter table cierre_cliente_periodo enable row level security;
alter table cierre_cliente_periodo force  row level security;

create policy cierre_periodo_sel on cierre_cliente_periodo for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- Apertura del período (paso 0, `23` §1.1): decisión de criterio, nunca `administrativo`.
create policy cierre_periodo_ins on cierre_cliente_periodo for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

-- DOS policies de UPDATE, permisivas (se combinan por OR): `administrativo` puede mover el cierre por
-- los estados operativos, NUNCA hacia `confirmado`/`anulado` — eso es EXCLUSIVAMENTE `socio`/
-- `contador`. Es la mitad "por permiso" del gate de D-24 (arquitecto-software, esta convocatoria); la
-- otra mitad es el trigger de abajo, que corre para CUALQUIER rol.
create policy cierre_periodo_upd_operativo on cierre_cliente_periodo for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[])
               and cierre_estado not in ('confirmado', 'anulado') );

create policy cierre_periodo_upd_cierre on cierre_cliente_periodo for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert, update on cierre_cliente_periodo to app_request;

-- -----------------------------------------------------------------------------
-- 5. `cierre_transicion` — historial append-only de la máquina de estados (D-6)
-- -----------------------------------------------------------------------------
--
-- `hecho_por` NUNCA nulo — ni para transiciones automáticas: "el hecho_por nulo no es información, es
-- camuflaje" (incidente #5, ya citado en `23`/`25`). `hecho_via` distingue el origen sin recurrir a un
-- NULL ambiguo (hallazgo de `seguridad-datos-financieros`, con precedente medido en
-- `membership_historia`: "hecho_por is null no distingue origen — dueño, job, siembra o migración dan
-- el mismo nulo"). La única transición hoy prevista como automática es `abierto → en_ingesta` (D-5b,
-- al registrarse el primer `fuente_cierre`) — se atribuye a la persona cuya acción la disparó
-- (arquitecto-software, esta convocatoria).
create table cierre_transicion (
  id             uuid primary key default gen_random_uuid(),
  cliente_id     uuid not null references tenant_node(id) on delete restrict,
  cierre_id      uuid not null,
  estado_desde   text not null,
  estado_hasta   text not null,
  -- N2, prosa libre genuina (seguridad-datos-financieros ratificó: NO se renombra, a diferencia de
  -- `pendiente_cierre.motivo_codigo`).
  motivo         text not null,
  hecho_via      text not null,
  hecho_por      uuid not null,
  ocurrido_en    timestamptz not null default now(),

  constraint cierre_transicion_estado_desde_chk
    check (estado_desde in ('abierto', 'en_ingesta', 'en_consolidacion', 'en_revision', 'confirmado',
                             'anulado')),
  constraint cierre_transicion_estado_hasta_chk
    check (estado_hasta in ('abierto', 'en_ingesta', 'en_consolidacion', 'en_revision', 'confirmado',
                             'anulado')),
  constraint cierre_transicion_via_chk check (hecho_via in ('manual', 'automatico')),
  constraint uq_cierre_transicion_tenant unique (cliente_id, id),

  constraint fk_cierre_transicion_cierre
    foreign key (cliente_id, cierre_id) references cierre_cliente_periodo (cliente_id, id)
    on delete restrict
);

create index idx_cierre_transicion_cliente on cierre_transicion(cliente_id);
create index idx_cierre_transicion_cierre on cierre_transicion(cliente_id, cierre_id);

create trigger trg_cierre_transicion_cliente
  before insert or update of cliente_id on cierre_transicion
  for each row execute function app.exigir_nodo_cliente();

alter table cierre_transicion enable row level security;
alter table cierre_transicion force  row level security;

create policy cierre_transicion_sel on cierre_transicion for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- DOS policies de INSERT: `socio`/`contador` registran cualquier transición; `administrativo` SOLO
-- puede registrar la transición automática prevista (`abierto → en_ingesta`) — espejo exacto de la
-- restricción de `cierre_periodo_upd_operativo` de arriba.
create policy cierre_transicion_ins_amplio on cierre_transicion for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

create policy cierre_transicion_ins_automatico on cierre_transicion for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['administrativo']::app.rol_membership[])
               and estado_desde = 'abierto' and estado_hasta = 'en_ingesta' );

-- Sin UPDATE ni DELETE para nadie: append-only. Una transición mal registrada se corrige con una
-- transición nueva, no con un UPDATE (mismo patrón que `padron_manifestacion`).

grant select, insert on cierre_transicion to app_request;

-- -----------------------------------------------------------------------------
-- 6. `expectativa_fuente_cliente` — el "2 de 5" (D-5d, D-14)
-- -----------------------------------------------------------------------------
--
-- `confirmada` nace en `true` (D-14, segunda convocatoria): "el silencio en las filas de confianza
-- alta es la aprobación" (D-5d) — una expectativa recién inferida se comporta, a los efectos del gate
-- de D-24, exactamente igual que una explícitamente confirmada. La única forma de que NO bloquee es
-- dispensar el `pendiente_cierre` puntual (D-24) o bajar `confirmada` a `false` en general.
create table expectativa_fuente_cliente (
  id                 uuid primary key default gen_random_uuid(),
  cliente_id         uuid not null references tenant_node(id) on delete restrict,
  tipo_documento     text not null,
  banco_codigo       text references banco(codigo) on delete restrict,
  cuenta_bancaria_id uuid,
  periodicidad       text not null,
  origen             text not null,
  evidencia          jsonb,
  confirmada         boolean not null default true,
  vigencia_desde     date not null,
  vigencia_hasta     date,
  superseded_by_id   uuid,
  creado_en          timestamptz not null default now(),

  constraint expectativa_tipo_chk
    check (tipo_documento in ('extracto', 'fci', 'liquidacion_tarjeta', 'libro_iva_compras',
                               'libro_iva_ventas')),
  constraint expectativa_periodicidad_chk check (periodicidad in ('mensual', 'anual', 'eventual')),
  constraint expectativa_origen_chk
    check (origen in ('declarado', 'inferido_de_movimiento', 'inferido_de_historico')),
  constraint expectativa_vigencia_chk
    check (vigencia_hasta is null or vigencia_hasta > vigencia_desde),
  constraint uq_expectativa_tenant unique (cliente_id, id),
  constraint uq_expectativa_natural
    unique nulls not distinct (cliente_id, tipo_documento, banco_codigo, cuenta_bancaria_id,
                                vigencia_desde),

  constraint fk_expectativa_cuenta
    foreign key (cliente_id, cuenta_bancaria_id) references cuenta_bancaria (cliente_id, id)
    on delete restrict,
  constraint fk_expectativa_superseded
    foreign key (cliente_id, superseded_by_id) references expectativa_fuente_cliente (cliente_id, id)
    on delete restrict
);

create index idx_expectativa_cliente on expectativa_fuente_cliente(cliente_id);

create trigger trg_expectativa_cliente
  before insert or update of cliente_id on expectativa_fuente_cliente
  for each row execute function app.exigir_nodo_cliente();

alter table expectativa_fuente_cliente enable row level security;
alter table expectativa_fuente_cliente force  row level security;

create policy expectativa_sel on expectativa_fuente_cliente for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- El motor puede proponer una expectativa inferida (origen inferido_de_*) — `administrativo` incluido,
-- es lectura de señales, no juicio.
create policy expectativa_ins on expectativa_fuente_cliente for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- Ratificar o descartar (`confirmada`) es el juicio del contador (D-5d: "el contador la ratifica o la
-- descarta") — no `administrativo`.
create policy expectativa_upd on expectativa_fuente_cliente for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert on expectativa_fuente_cliente to app_request;
grant update (confirmada, vigencia_hasta, superseded_by_id) on expectativa_fuente_cliente to app_request;

-- -----------------------------------------------------------------------------
-- 7. `fuente_cierre` — el enganche uniforme documento↔cierre
-- -----------------------------------------------------------------------------
create table fuente_cierre (
  id                    uuid primary key default gen_random_uuid(),
  cliente_id            uuid not null references tenant_node(id) on delete restrict,
  cierre_id             uuid not null,
  documento_ingerido_id uuid not null,
  expectativa_id        uuid,
  cuenta_bancaria_id    uuid,
  estado_cuadratura     jsonb not null default '{}'::jsonb,
  superseded_by_id      uuid,
  creado_en             timestamptz not null default now(),

  constraint uq_fuente_cierre_tenant unique (cliente_id, id),
  constraint uq_fuente_cierre_natural
    unique nulls not distinct (cliente_id, cierre_id, documento_ingerido_id, cuenta_bancaria_id),

  constraint fk_fuente_cierre_cierre
    foreign key (cliente_id, cierre_id) references cierre_cliente_periodo (cliente_id, id)
    on delete restrict,
  constraint fk_fuente_cierre_documento
    foreign key (cliente_id, documento_ingerido_id) references documento_ingerido (cliente_id, id)
    on delete restrict,
  constraint fk_fuente_cierre_expectativa
    foreign key (cliente_id, expectativa_id) references expectativa_fuente_cliente (cliente_id, id)
    on delete restrict,
  constraint fk_fuente_cierre_cuenta
    foreign key (cliente_id, cuenta_bancaria_id) references cuenta_bancaria (cliente_id, id)
    on delete restrict,
  constraint fk_fuente_cierre_superseded
    foreign key (cliente_id, superseded_by_id) references fuente_cierre (cliente_id, id)
    on delete restrict
);

create index idx_fuente_cierre_cliente on fuente_cierre(cliente_id);
create index idx_fuente_cierre_cierre on fuente_cierre(cliente_id, cierre_id);

create trigger trg_fuente_cierre_cliente
  before insert or update of cliente_id on fuente_cierre
  for each row execute function app.exigir_nodo_cliente();

alter table fuente_cierre enable row level security;
alter table fuente_cierre force  row level security;

create policy fuente_cierre_sel on fuente_cierre for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

create policy fuente_cierre_ins on fuente_cierre for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

create policy fuente_cierre_upd on fuente_cierre for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

grant select, insert on fuente_cierre to app_request;
grant update (estado_cuadratura, superseded_by_id) on fuente_cierre to app_request;

-- -----------------------------------------------------------------------------
-- 8. `pendiente_cierre` — la cola del paso 6 (D-4, D-5b, D-24)
-- -----------------------------------------------------------------------------
--
-- `motivo_codigo`, NO `motivo` — ver nota de cabecera. `expectativa_id` es columna NUEVA respecto del
-- boceto de `23`/`24`: necesaria para que el gate de D-24 pueda unir un pendiente de "documento
-- faltante" contra la expectativa que sigue confirmada — un documento que NUNCA llegó no tiene
-- `fuente_cierre` (esa tabla solo existe para lo que SÍ se ingirió), así que `fuente_cierre_id` no
-- alcanza para ese caso. Es un hallazgo de esta migración, no de una convocatoria previa — documentado
-- explícito para que no se lea como un agregado silencioso.
create table pendiente_cierre (
  id                 uuid primary key default gen_random_uuid(),
  cliente_id         uuid not null references tenant_node(id) on delete restrict,
  cierre_id          uuid not null,
  fuente_cierre_id   uuid,
  expectativa_id     uuid,
  referencia_origen  text,
  motivo_codigo      text not null,
  pendiente_estado   text not null default 'abierto',
  resuelto_por       uuid,
  resuelto_en        timestamptz,
  resolucion_id      uuid,
  superseded_by_id   uuid,
  creado_en          timestamptz not null default now(),

  constraint pendiente_cierre_motivo_chk
    check (motivo_codigo in ('documento_faltante', 'cotizacion_no_disponible')),
  constraint pendiente_cierre_estado_chk
    check (pendiente_estado in ('abierto', 'resuelto', 'superseded', 'dispensado')),
  constraint uq_pendiente_cierre_tenant unique (cliente_id, id),
  constraint uq_pendiente_cierre_natural
    unique nulls not distinct (cliente_id, cierre_id, fuente_cierre_id, referencia_origen,
                                motivo_codigo),

  constraint fk_pendiente_cierre_cierre
    foreign key (cliente_id, cierre_id) references cierre_cliente_periodo (cliente_id, id)
    on delete restrict,
  constraint fk_pendiente_cierre_fuente
    foreign key (cliente_id, fuente_cierre_id) references fuente_cierre (cliente_id, id)
    on delete restrict,
  constraint fk_pendiente_cierre_expectativa
    foreign key (cliente_id, expectativa_id) references expectativa_fuente_cliente (cliente_id, id)
    on delete restrict,
  constraint fk_pendiente_cierre_superseded
    foreign key (cliente_id, superseded_by_id) references pendiente_cierre (cliente_id, id)
    on delete restrict
);

create index idx_pendiente_cierre_cliente on pendiente_cierre(cliente_id);
create index idx_pendiente_cierre_cierre on pendiente_cierre(cliente_id, cierre_id);
-- El gate de confirmación (más abajo) filtra exactamente por esta combinación.
create index idx_pendiente_cierre_gate
  on pendiente_cierre(cliente_id, cierre_id, pendiente_estado, motivo_codigo)
  where pendiente_estado = 'abierto';

create trigger trg_pendiente_cierre_cliente
  before insert or update of cliente_id on pendiente_cierre
  for each row execute function app.exigir_nodo_cliente();

alter table pendiente_cierre enable row level security;
alter table pendiente_cierre force  row level security;

create policy pendiente_cierre_sel on pendiente_cierre for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

create policy pendiente_cierre_ins on pendiente_cierre for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- DOS policies de UPDATE: resolver/superseder es del ancho de siempre; DISPENSAR es del mismo peso
-- que confirmar (hallazgo de `arquitecto-software`, esta convocatoria: D-24 nunca fijó quién puede
-- dispensar) — nunca `administrativo`, que "NO confirma ni presenta" por definición de su rol.
create policy pendiente_cierre_upd_general on pendiente_cierre for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[])
               and pendiente_estado <> 'dispensado' );

create policy pendiente_cierre_upd_dispensa on pendiente_cierre for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert on pendiente_cierre to app_request;
grant update (pendiente_estado, resuelto_por, resuelto_en, resolucion_id, superseded_by_id)
  on pendiente_cierre to app_request;

-- -----------------------------------------------------------------------------
-- 9. `pendiente_dispensa` — la excepción de D-24, append-only
-- -----------------------------------------------------------------------------
create table pendiente_dispensa (
  id                  uuid primary key default gen_random_uuid(),
  cliente_id          uuid not null references tenant_node(id) on delete restrict,
  pendiente_cierre_id uuid not null,
  -- N2, prosa libre genuina — igual que `cierre_transicion.motivo`.
  motivo              text not null,
  dispensado_por      uuid not null,
  dispensado_en       timestamptz not null default now(),

  constraint uq_pendiente_dispensa_tenant unique (cliente_id, id),

  constraint fk_pendiente_dispensa_pendiente
    foreign key (cliente_id, pendiente_cierre_id) references pendiente_cierre (cliente_id, id)
    on delete restrict
);

create index idx_pendiente_dispensa_cliente on pendiente_dispensa(cliente_id);
create index idx_pendiente_dispensa_pendiente
  on pendiente_dispensa(cliente_id, pendiente_cierre_id);

create trigger trg_pendiente_dispensa_cliente
  before insert or update of cliente_id on pendiente_dispensa
  for each row execute function app.exigir_nodo_cliente();

alter table pendiente_dispensa enable row level security;
alter table pendiente_dispensa force  row level security;

create policy pendiente_dispensa_sel on pendiente_dispensa for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- Nunca `administrativo` — mismo criterio que `pendiente_cierre_upd_dispensa`. Quien inserta acá, en
-- la misma transacción, es quien puso `pendiente_cierre.pendiente_estado = 'dispensado'`.
create policy pendiente_dispensa_ins on pendiente_dispensa for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE para nadie: append-only, mismo patrón que `padron_manifestacion`.

grant select, insert on pendiente_dispensa to app_request;

-- -----------------------------------------------------------------------------
-- 10. `asiento_propuesto` — el paso 7 (D-7, D-18)
-- -----------------------------------------------------------------------------
--
-- SIN `total_debe`/`total_haber` como columnas físicas — ver nota de cabecera, punto 1. Se exponen
-- como vista calculada siempre desde los renglones (`asiento_propuesto_totales`, más abajo, después de
-- `asiento_propuesto_renglon`).
create table asiento_propuesto (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references tenant_node(id) on delete restrict,
  cierre_id        uuid not null,
  tipo             text not null,
  fecha_imputacion date not null,
  -- N1 (D-19): marcador de workflow sobre un asiento puntual, no un hecho agregado del cliente —
  -- mismo tier que `reconocimiento_movimiento.clase`/`.es_propuesta`.
  asiento_estado   text not null default 'propuesto',
  superseded_by_id uuid,
  creado_en        timestamptz not null default now(),

  constraint asiento_propuesto_tipo_chk
    check (tipo in ('devengamiento', 'cancelacion', 'ajuste_cierre', 'reimputacion')),
  constraint asiento_propuesto_estado_chk
    check (asiento_estado in ('propuesto', 'confirmado', 'superseded')),
  constraint uq_asiento_propuesto_tenant unique (cliente_id, id),

  constraint fk_asiento_propuesto_cierre
    foreign key (cliente_id, cierre_id) references cierre_cliente_periodo (cliente_id, id)
    on delete restrict,
  constraint fk_asiento_propuesto_superseded
    foreign key (cliente_id, superseded_by_id) references asiento_propuesto (cliente_id, id)
    on delete restrict
);

create index idx_asiento_propuesto_cliente on asiento_propuesto(cliente_id);
create index idx_asiento_propuesto_cierre on asiento_propuesto(cliente_id, cierre_id);

create trigger trg_asiento_propuesto_cliente
  before insert or update of cliente_id on asiento_propuesto
  for each row execute function app.exigir_nodo_cliente();

alter table asiento_propuesto enable row level security;
alter table asiento_propuesto force  row level security;

create policy asiento_propuesto_sel on asiento_propuesto for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

create policy asiento_propuesto_ins on asiento_propuesto for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- DOS policies de UPDATE: superseder (reproceso) es del ancho de siempre; confirmar es EXCLUSIVAMENTE
-- `socio`/`contador` — "el sistema propone, el contador aprueba" (CLAUDE.md §1.7), ahora enforced por
-- permiso.
create policy asiento_propuesto_upd_general on asiento_propuesto for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[])
               and asiento_estado <> 'confirmado' );

create policy asiento_propuesto_upd_confirmar on asiento_propuesto for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert, update on asiento_propuesto to app_request;

-- -----------------------------------------------------------------------------
-- 11. `asiento_propuesto_renglon` — cada línea del asiento (D-7, D-15, D-16, D-18, D-20)
-- -----------------------------------------------------------------------------
--
-- Roles SIMÉTRICOS (D-18, ratificado por `seguridad-datos-financieros`): sin columna N2-R (`cuenta_id`
-- es FK a la identidad estable, nunca el documento en claro; `padron_manifestacion_id` es FK a la
-- premisa, no al padrón — mismo argumento que ya mantiene a `reconocimiento_contrapartida` fuera de
-- `tablasQueExigenRolEnLectura()`). Write-once: corregir un renglón es superseder el `asiento_
-- propuesto` entero (D-6), nunca un UPDATE.
create table asiento_propuesto_renglon (
  id                      uuid primary key default gen_random_uuid(),
  cliente_id              uuid not null references tenant_node(id) on delete restrict,
  asiento_id              uuid not null,
  orden                   integer not null,
  cuenta_id               uuid not null,
  -- N2: cita congelada {codigo, denominacion, rol_funcional} vigente a fecha_imputacion, capturada al
  -- confirmar (D-15). El asiento CITA el plan de cuentas, no lo recalcula.
  cuenta_ref              jsonb not null default '{}'::jsonb,
  debe                    numeric(18,2) not null default 0,
  haber                   numeric(18,2) not null default 0,
  fecha_imputacion        date not null,
  fuente_cierre_id        uuid,
  referencia_origen       text,
  -- N2 por defecto (D-20): allowlist de claves + vocabulario cerrado por valor, para que nunca pueda
  -- colar un valor crudo de OCR (`ConfianzaDeCampo.valorLeido`) — mismo criterio que `lote_ingesta_
  -- cuenta.verificacion_detalle` ("ninguna diferencia lleva un valor"). El `motivo` interno de este
  -- jsonb queda sin cerrar por CHECK (sería sobre-especificar); lo cierra Zod en el límite de escritura
  -- (D-20, capa de aplicación), no esta migración.
  verificacion_heredada   jsonb not null default '{}'::jsonb,
  padron_manifestacion_id uuid,
  -- N2: plata del propio cliente (cotización usada o capas de FCI consumidas). El asiento CITA, no
  -- recalcula (D-7).
  valuacion_ref           jsonb,
  creado_en               timestamptz not null default now(),

  constraint asiento_renglon_montos_chk check (debe >= 0 and haber >= 0 and (debe = 0 or haber = 0)),
  constraint asiento_renglon_verificacion_chk
    check ( (verificacion_heredada
              - array['estado','referencia_documento_id','referencia_linea','motivo','aproximada',
                       'fecha_referencia']::text[]) = '{}'::jsonb
            and (verificacion_heredada->>'estado' is null
                 or verificacion_heredada->>'estado' in ('exacta','aproximada','no_verificable')) ),
  constraint uq_asiento_renglon_tenant unique (cliente_id, id),
  constraint uq_asiento_renglon_orden unique (cliente_id, asiento_id, orden),

  constraint fk_asiento_renglon_asiento
    foreign key (cliente_id, asiento_id) references asiento_propuesto (cliente_id, id)
    on delete restrict,
  constraint fk_asiento_renglon_cuenta
    foreign key (cliente_id, cuenta_id) references cuenta (cliente_id, id) on delete restrict,
  constraint fk_asiento_renglon_fuente
    foreign key (cliente_id, fuente_cierre_id) references fuente_cierre (cliente_id, id)
    on delete restrict,
  constraint fk_asiento_renglon_manifestacion
    foreign key (cliente_id, padron_manifestacion_id) references padron_manifestacion (cliente_id, id)
    on delete restrict
);

create index idx_asiento_renglon_cliente on asiento_propuesto_renglon(cliente_id);
create index idx_asiento_renglon_asiento on asiento_propuesto_renglon(cliente_id, asiento_id);

create trigger trg_asiento_renglon_cliente
  before insert or update of cliente_id on asiento_propuesto_renglon
  for each row execute function app.exigir_nodo_cliente();

alter table asiento_propuesto_renglon enable row level security;
alter table asiento_propuesto_renglon force  row level security;

-- SELECT abierta a todo el tenant (sin chequeo de rol) — `auditor` lee, y D-18 exige que quien
-- inserta vea el 100% de lo que su propio trigger/consulta necesita agregar.
create policy asiento_renglon_sel on asiento_propuesto_renglon for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

create policy asiento_renglon_ins on asiento_propuesto_renglon for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE para nadie: write-once. Guardrail explícito para quien toque este esquema
-- después (mismo estilo que `0021` sobre `reconocimiento_contrapartida`): esta tabla NO tiene columnas
-- N2-R a propósito. Si algún día se necesita guardar acá un documento en claro de un tercero (no una
-- referencia), la tabla entra en `tablasQueExigenRolEnLectura()` y hay que RE-SIMETRIZAR los roles de
-- INSERT contra los nuevos de SELECT — no agregar la columna sin volver a esta decisión.

grant select, insert on asiento_propuesto_renglon to app_request;

comment on table asiento_propuesto_renglon is
  'Roles de lectura/escritura SIMÉTRICOS por diseño (D-18) — sin columnas N2-R a propósito. Si se '
  'agrega una columna que guarde un documento en claro de un tercero (no una FK/referencia), esta '
  'tabla pasa a tablasQueExigenRolEnLectura() y los roles de INSERT tienen que re-simetrizarse contra '
  'los nuevos de SELECT restringido — no es un ajuste automático.';

-- -----------------------------------------------------------------------------
-- 12. `asiento_propuesto_totales` — vista, reemplaza las columnas físicas de `asiento_propuesto`
-- -----------------------------------------------------------------------------
--
-- `security_invoker = true` (PG16): SIN esto, la vista corre con los privilegios del DUEÑO DEL ESQUEMA
-- (superusuario en este entorno, `23` §2.2) y bypassea RLS para cualquiera que la consulte — el mismo
-- tipo de agujero que ya obligó a declarar explícito que el dueño del esquema es superusuario. Nunca
-- se cachea: siempre se calcula desde los renglones vigentes, así que no hay valor que un `UPDATE`
-- directo pueda corromper (arquitecto-software, esta convocatoria — resuelve de raíz el problema del
-- trigger que no podía funcionar sin `SECURITY DEFINER`).
--
-- La garantía de `debe = haber` deja de ser un `CHECK` de tabla y pasa a vivir en DOS puntos de código
-- determinístico, fuera de esta migración (Capa D): al proponer (TypeScript, antes del INSERT de los
-- renglones) y al confirmar (recálculo dentro de `conUsuario`, D-18). Sin esto, un asiento con renglones
-- que no cuadran puede EXISTIR como fila `propuesto` — es correcto que exista así: el paso 7 (revisión
-- humana) es precisamente donde el contador lo detecta antes de confirmar.
create view asiento_propuesto_totales
  with (security_invoker = true) as
  select
    r.cliente_id,
    r.asiento_id,
    coalesce(sum(r.debe), 0)::numeric(18,2) as total_debe,
    coalesce(sum(r.haber), 0)::numeric(18,2) as total_haber
  from asiento_propuesto_renglon r
  group by r.cliente_id, r.asiento_id;

grant select on asiento_propuesto_totales to app_request;

-- -----------------------------------------------------------------------------
-- 13. El gate de confirmación de D-24 — mecanizado, no solo acordado
-- -----------------------------------------------------------------------------
--
-- Segunda capa del gate (la primera es RLS: `cierre_periodo_upd_cierre` ya restringe QUIÉN puede
-- escribir `cierre_estado = 'confirmado'`). Esta capa corre para CUALQUIER rol que llegue a intentarlo
-- — no depende de que el código de aplicación recuerde llamar a la función correcta (hallazgo de
-- `security-engineer`, esta convocatoria: "un control que depende de que el código lo llame no es un
-- control", mismo patrón que ya costó R33/R13). Invoker, sin `SECURITY DEFINER`: la consulta es
-- intra-tenant, mismo `cliente_id` que la fila que ya se tiene permiso de escribir.
create or replace function app.verificar_gate_confirmacion_cierre() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_pendientes integer;
begin
  select count(*) into v_pendientes
    from public.pendiente_cierre p
    join public.expectativa_fuente_cliente e
      on e.cliente_id = p.cliente_id and e.id = p.expectativa_id
   where p.cliente_id = new.cliente_id
     and p.cierre_id = new.id
     and p.pendiente_estado = 'abierto'
     and p.motivo_codigo = 'documento_faltante'
     and e.confirmada = true;

  if v_pendientes > 0 then
    raise exception
      'No se puede confirmar el cierre %: hay % pendiente(s) de fuente esperada-confirmada, sin '
      'resolver ni dispensar (D-24).', new.id, v_pendientes
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function app.verificar_gate_confirmacion_cierre() is
  'D-24 mecanizado: rechaza cierre_estado→confirmado si queda un pendiente_cierre abierto de fuente '
  'esperada-confirmada. Corre para CUALQUIER rol que llegue a intentar la transición, no solo por el '
  'camino "oficial" de la función de aplicación que confirma (security-engineer, 0027). Invoker, '
  'intra-tenant: sin SECURITY DEFINER.';

create trigger trg_cierre_periodo_gate_confirmacion
  before update of cierre_estado on cierre_cliente_periodo
  for each row
  when (new.cierre_estado = 'confirmado' and old.cierre_estado is distinct from 'confirmado')
  execute function app.verificar_gate_confirmacion_cierre();

-- -----------------------------------------------------------------------------
-- 14. Comentarios de los quince dominios cerrados — exigidos por
--     `packages/data/tests/catalogo.test.ts` ("los dominios cerrados no pueden divergir entre el
--     código y la base"): cada CHECK con forma `col in (...)` necesita nombrar acá la constante
--     TypeScript que lo espeja, o el barrido de esa suite lo marca "sin árbitro" (mismo mecanismo
--     que ya usan `0004`/`0014`/`0019` para `ACCIONES`/`QUE_DECIDE`/`OPERACIONES_MEMBRESIA`).
--     Las constantes viven en `packages/data/src/cierre/tipos.ts`.
-- -----------------------------------------------------------------------------

comment on constraint documento_ingerido_tipo_chk on documento_ingerido is
  'Vocabulario cerrado, ver TIPOS_DOCUMENTO_CIERRE (packages/data/src/cierre/tipos.ts).';
comment on constraint documento_ingerido_cobertura_chk on documento_ingerido is
  'Vocabulario cerrado, ver COBERTURAS_DOCUMENTO (packages/data/src/cierre/tipos.ts).';
comment on constraint cierre_periodo_tipo_chk on cierre_cliente_periodo is
  'Vocabulario cerrado, ver TIPOS_PERIODO (packages/data/src/cierre/tipos.ts).';
comment on constraint cierre_periodo_estado_chk on cierre_cliente_periodo is
  'Vocabulario cerrado, ver CIERRE_ESTADOS (packages/data/src/cierre/tipos.ts). D-19: renombrada de '
  '`estado` a `cierre_estado` — el registro de clasificación clasifica por nombre GLOBALMENTE.';
comment on constraint cierre_transicion_estado_desde_chk on cierre_transicion is
  'Vocabulario cerrado, ver CIERRE_ESTADOS (packages/data/src/cierre/tipos.ts) — mismo vocabulario que cierre_cliente_periodo.cierre_estado.';
comment on constraint cierre_transicion_estado_hasta_chk on cierre_transicion is
  'Vocabulario cerrado, ver CIERRE_ESTADOS (packages/data/src/cierre/tipos.ts).';
comment on constraint cierre_transicion_via_chk on cierre_transicion is
  'Vocabulario cerrado, ver HECHO_VIA (packages/data/src/cierre/tipos.ts). hecho_por nunca nulo, ni '
  'para automatico — "el nulo no es información, es camuflaje" (incidente #5).';
comment on constraint expectativa_tipo_chk on expectativa_fuente_cliente is
  'Vocabulario cerrado, ver TIPOS_DOCUMENTO_CIERRE (packages/data/src/cierre/tipos.ts).';
comment on constraint expectativa_periodicidad_chk on expectativa_fuente_cliente is
  'Vocabulario cerrado, ver PERIODICIDADES_EXPECTATIVA (packages/data/src/cierre/tipos.ts).';
comment on constraint expectativa_origen_chk on expectativa_fuente_cliente is
  'Vocabulario cerrado, ver ORIGENES_EXPECTATIVA (packages/data/src/cierre/tipos.ts).';
comment on constraint pendiente_cierre_motivo_chk on pendiente_cierre is
  'Vocabulario cerrado, ver MOTIVOS_PENDIENTE_CIERRE (packages/data/src/cierre/tipos.ts). '
  'motivo_codigo, NO motivo a secas: ese nombre ya está clasificado N2 para prosa libre.';
comment on constraint pendiente_cierre_estado_chk on pendiente_cierre is
  'Vocabulario cerrado, ver PENDIENTE_ESTADOS (packages/data/src/cierre/tipos.ts). `dispensado` es D-24.';
comment on constraint asiento_propuesto_tipo_chk on asiento_propuesto is
  'Vocabulario cerrado, ver TIPOS_ASIENTO_PROPUESTO (packages/data/src/cierre/tipos.ts).';
comment on constraint asiento_propuesto_estado_chk on asiento_propuesto is
  'Vocabulario cerrado, ver ASIENTO_ESTADOS (packages/data/src/cierre/tipos.ts).';
comment on constraint cuenta_atributo_rol_funcional_chk on cuenta_atributo is
  'Vocabulario cerrado, ver ROLES_FUNCIONALES_CUENTA (packages/data/src/cierre/tipos.ts). '
  'PROVISIONAL — contador-dominio cierra la lista completa antes de que Capa D la use.';

commit;
