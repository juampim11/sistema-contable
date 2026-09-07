-- =============================================================================
-- 0040_reproceso_capa_d.sql — mecanismo de reproceso de Capa D con supersesión, Mitad 1
-- (acotada a la corrección de regla_imputacion de esta semana — 25413, impuesto a débitos y
-- créditos, 1680 asiento_propuesto completos en dos clientes reales del piloto).
--
-- Convocatoria formal completa (CLAUDE.md §3.1/§3.2): contador-dominio → arquitecto-software +
-- dba-data + security-engineer (diseño), después dba-data + security-engineer +
-- seguridad-datos-financieros (este DDL concreto), 2026-09-07.
--
-- ## El mecanismo, en dos casos (criterio de contador-dominio: el discriminador es si la
-- contadora YA REVISÓ/CONFIRMÓ el asiento, no la causa del cambio)
--
-- Caso A — asiento_estado = 'propuesto' (nadie lo confirmó todavía): reusa superseded_by_id,
-- MECANISMO YA EXISTENTE desde 0027/0028, sin cambios de esquema para esto.
-- Caso B — asiento_estado = 'confirmado' (ya entregado): NUNCA se supersede — un asiento_propuesto
-- NUEVO, tipo='ajuste_cierre' (ya está en el vocabulario cerrado desde 0027, nadie lo usó todavía),
-- con la columna nueva corrige_asiento_id. El asiento original queda 'confirmado' PARA SIEMPRE, sin
-- un solo campo tocado — los dos asientos (original + ajuste) son igualmente vigentes y visibles a
-- la vez. El ajuste se imputa al cierre_id ACTUAL/ABIERTO, nunca al confirmado que corrige (verificado
-- contra el criterio de contador-dominio: "ajuste en el período de detección, sin tocar el histórico"
-- — así el trigger de cierre-no-terminal de abajo no choca con el propio mecanismo que habilita).
--
-- ## Los dos bugs reales que la convocatoria de DDL encontró en el primer borrador — CORREGIDOS acá,
-- encontrados de forma INDEPENDIENTE por dba-data y security-engineer, misma convocatoria
--
-- (a) El mensaje de excepción del trigger nuevo interpolaba cierre_estado (N2) — EXACTAMENTE el
--     defecto que 0028 ya había encontrado y cerrado ("el mensaje NUNCA interpola valores de
--     old/new", 0028:152-159) — reintroducido acá en la primera migración siguiente. Corregido: el
--     mensaje solo nombra id/cierre_id (N1), nunca el valor del estado.
-- (b) Carrera real (TOCTOU) sin lock: el SELECT del trigger, sin `for share`, no se entera de una
--     confirmación de cierre concurrente bajo READ COMMITTED — dos transacciones pueden entrelazarse
--     y colar un asiento en un cierre que termina confirmado. Corregido con `for share` sobre la fila
--     de cierre_cliente_periodo leída (mismo remedio que 0032 ya usó para el mismo patrón de carrera).
--
-- ## Hallazgo de security-engineer, no anticipado en el diseño: policy de INSERT partida por `caso`
--
-- `administrativo` puede insertar Caso A (reemplazo_no_revisado) pero NUNCA Caso B
-- (ajuste_ya_entregado) — mismo patrón que ya rige confirmar/dispensar/transición automática en este
-- esquema: tocar lo ya confirmado/entregado es exclusivo de socio/contador.
--
-- ## Clasificación — laudo explícito del titular (2026-09-07)
--
-- La columna se llama `reproceso_motivo_codigo`, NUNCA `motivo_codigo` a secas: el registro de
-- clasificación tapa por NOMBRE DE COLUMNA GLOBALMENTE (mismo argumento que ya subió
-- `resolucion_estado` en vez de `estado` desnudo) — `lote_ingesta.motivo_codigo` es N1 y aparece en
-- decenas de `logger.*` de todo el repo; reusar el mismo literal acá en N2 tapaba esos campos con
-- `undefined` en TODO el codebase (confirmado en vivo: rompió `pnpm typecheck` en 6 archivos ajenos
-- a esta tarea, 2026-09-07, antes de este rename).
--
-- Y va N2, NO N1, pese al precedente de `pendiente_cierre.motivo_codigo` (N1): `'dato_tardio_cliente'`
-- nombra una CONDUCTA atribuible a un tercero real (el cliente del estudio), cualitativamente
-- distinto de `pendiente_cierre.motivo_codigo`, que describe estados del propio sistema sin atribuir
-- conducta a nadie. El precedente no transfiere sin más — objeción correcta de `security-engineer`,
-- laudada por el titular, no una discrepancia menor. Clasificación completa de las 10 columnas
-- nuevas + `corrige_asiento_id`: tarea aparte, misma sesión
-- (packages/shared/src/seguridad/clasificacion-campos.ts) — regla dura CLAUDE.md §2.
--
-- ## Lo que esta migración NO hace, a propósito
--
-- No conecta cierre_cliente_periodo a su ciclo de vida real (B.13, deuda declarada, independiente).
-- No generaliza a cualquier cambio de regla_imputacion (Mitad 2). No construye disparo automático
-- (cerrado en contra por los cuatro dictámenes de diseño, decisión tomada, no pendiente). No carga
-- ningún dato real — la corrida real sobre los 1680 asientos es un paso posterior, con su propia
-- autorización explícita.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. asiento_propuesto.corrige_asiento_id — el enlace del Caso B (ajuste), nunca reusa
--    superseded_by_id: esa semántica dice "esto es inválido"; un ajuste no invalida nada, los dos
--    asientos siguen siendo ciertos a la vez.
-- -----------------------------------------------------------------------------
alter table asiento_propuesto
  add column corrige_asiento_id uuid;

alter table asiento_propuesto add constraint fk_asiento_propuesto_corrige
  foreign key (cliente_id, corrige_asiento_id) references asiento_propuesto (cliente_id, id)
  on delete restrict;

alter table asiento_propuesto add constraint asiento_propuesto_corrige_no_self_chk
  check (corrige_asiento_id is null or corrige_asiento_id <> id);

comment on column asiento_propuesto.corrige_asiento_id is
  'N1 (uuid interno, no revela contenido — mismo criterio que asiento_propuesto_renglon.padron_'
  'manifestacion_id/.padron_contraparte_id). Caso B (0040): liga un asiento tipo=ajuste_cierre al '
  'asiento YA CONFIRMADO que corrige. Nunca superseded_by_id: el original sigue vigente, este solo '
  'lo complementa.';

-- -----------------------------------------------------------------------------
-- 2. Trigger — no insertar un asiento_propuesto dentro de un cierre ya terminal. Cierra el gap real
--    de fk_asiento_propuesto_cierre (0027), que nunca verificaba cierre_estado. Aplica a TODO INSERT
--    en asiento_propuesto, no solo al reproceso — corrección general, no acotada a esta tarea.
-- -----------------------------------------------------------------------------
create or replace function app.exigir_cierre_no_terminal_al_insertar_asiento() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_cierre_estado text;
begin
  -- `for share`: sin esto, un INSERT concurrente y una confirmación concurrente del mismo cierre
  -- pueden entrelazarse bajo READ COMMITTED y dejar un asiento insertado en un cierre que terminó
  -- confirmado — cada transacción vería un estado verdadero al momento de leerlo, falso al momento
  -- de commitear las dos. `for share` alcanza (no escribimos la fila): cualquier UPDATE concurrente
  -- sobre cierre_cliente_periodo toma lock exclusivo de fila, así que nos bloquea hasta que termine
  -- y volvemos a leer el valor ya confirmado (dba-data + security-engineer, convocatoria 2026-09-07,
  -- mismo remedio que 0032 ya usó para el mismo patrón de carrera).
  select cierre_estado into v_cierre_estado
    from public.cierre_cliente_periodo
   where cliente_id = new.cliente_id and id = new.cierre_id
     for share;

  if v_cierre_estado in ('confirmado', 'anulado') then
    -- El mensaje NUNCA interpola el valor de cierre_estado (N2, 0027) — mismo defecto que 0028 ya
    -- había cerrado y este borrador reintrodujo antes de esta corrección. Solo id/cierre_id (N1).
    raise exception
      'no se puede insertar un asiento_propuesto (id=%) en un cierre_cliente_periodo ya terminal (cierre_id=%)',
      new.id, new.cierre_id
      using errcode = 'P0003';
  end if;

  return new;
end;
$$;

comment on function app.exigir_cierre_no_terminal_al_insertar_asiento() is
  'Cierra el gap encontrado por security-engineer (convocatoria 2026-09-07): fk_asiento_propuesto_'
  'cierre (0027) no verificaba cierre_estado. BEFORE INSERT sobre TODO insert de asiento_propuesto, '
  'no sólo reproceso. `for share` sobre cierre_cliente_periodo cierra la carrera contra una '
  'confirmación concurrente. Invoker, sin SECURITY DEFINER (0027/R11). El mensaje nunca interpola '
  'cierre_estado (N2) — sólo id/cierre_id, mismo criterio que 0028. errcode P0003 (no P0002): 0028 ya '
  'usa P0002 para "fila inmutable post-terminal" — este es un control distinto (gate al insertar, no '
  'inmutabilidad de una fila existente) y no debe compartir SQLSTATE con ese otro.';

create trigger trg_asiento_propuesto_cierre_no_terminal
  before insert on asiento_propuesto
  for each row execute function app.exigir_cierre_no_terminal_al_insertar_asiento();

-- -----------------------------------------------------------------------------
-- 3. asiento_propuesto_reproceso — trail de NEGOCIO (distinto del trail de cumplimiento
--    acceso_auditoria/escribirConAuditoria, que el escritor de aplicación sigue usando en paralelo).
--    Mismo estilo que cierre_transicion (0027): motivo N2 prosa libre genuina, hecho_por NOT NULL,
--    SELECT abierta a todo el tenant sin gate de rol.
-- -----------------------------------------------------------------------------
create table asiento_propuesto_reproceso (
  id                            uuid primary key default gen_random_uuid(),
  cliente_id                    uuid not null references tenant_node(id) on delete restrict,
  asiento_id                    uuid not null,
  asiento_nuevo_id              uuid not null,
  caso                          text not null,
  reproceso_motivo_codigo       text not null,
  motivo                        text not null,
  regla_imputacion_id_anterior  uuid,
  regla_imputacion_id_nueva     uuid,
  hecho_por                     uuid not null,
  ocurrido_en                   timestamptz not null default now(),

  constraint asiento_propuesto_reproceso_caso_chk
    check (caso in ('reemplazo_no_revisado', 'ajuste_ya_entregado')),
  constraint asiento_propuesto_reproceso_motivo_codigo_chk
    check (reproceso_motivo_codigo in ('correccion_criterio_estudio', 'dato_tardio_cliente')),
  -- Equivalencia, no implicación (mismo patrón que cuenta_atributo_padron_socio_chk/regla_imputacion_
  -- cuenta_chk/_rol_chk): 'correccion_criterio_estudio' EXIGE las dos referencias a regla_imputacion;
  -- 'dato_tardio_cliente' (un documento tardío no reabre ninguna regla) las RECHAZA si vienen
  -- cargadas por error.
  constraint asiento_propuesto_reproceso_regla_chk
    check ( (reproceso_motivo_codigo = 'correccion_criterio_estudio')
            = (regla_imputacion_id_anterior is not null and regla_imputacion_id_nueva is not null) ),
  -- Invariante barato: un reproceso nunca liga un asiento consigo mismo.
  constraint asiento_propuesto_reproceso_distinto_chk
    check (asiento_id <> asiento_nuevo_id),
  constraint uq_asiento_propuesto_reproceso_tenant unique (cliente_id, id),

  constraint fk_asiento_propuesto_reproceso_asiento
    foreign key (cliente_id, asiento_id) references asiento_propuesto (cliente_id, id) on delete restrict,
  constraint fk_asiento_propuesto_reproceso_nuevo
    foreign key (cliente_id, asiento_nuevo_id) references asiento_propuesto (cliente_id, id) on delete restrict,
  constraint fk_asiento_propuesto_reproceso_regla_anterior
    foreign key (cliente_id, regla_imputacion_id_anterior) references regla_imputacion (cliente_id, id) on delete restrict,
  constraint fk_asiento_propuesto_reproceso_regla_nueva
    foreign key (cliente_id, regla_imputacion_id_nueva) references regla_imputacion (cliente_id, id) on delete restrict
);

create index idx_asiento_propuesto_reproceso_cliente on asiento_propuesto_reproceso(cliente_id);

-- (3) de la plantilla.
create trigger trg_asiento_propuesto_reproceso_cliente
  before insert or update of cliente_id on asiento_propuesto_reproceso
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5).
alter table asiento_propuesto_reproceso enable row level security;
alter table asiento_propuesto_reproceso force  row level security;

-- (6) SELECT sin chequeo de rol — mismo criterio que cierre_transicion: es el trail de negocio que
-- la contadora tiene que poder ver sin fricción de rol adicional.
create policy asiento_propuesto_reproceso_sel on asiento_propuesto_reproceso for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) DOS policies de INSERT, partidas por VALOR de `caso` (hallazgo de security-engineer, 2026-09-07):
-- tocar un asiento YA CONFIRMADO/entregado (ajuste_ya_entregado) es exclusivo de socio/contador —
-- mismo patrón que ya rige confirmar/dispensar/transición automática en este esquema.
-- `administrativo` puede proponer un reemplazo de algo no revisado, nunca corregir algo ya entregado.
create policy asiento_propuesto_reproceso_ins_general on asiento_propuesto_reproceso for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[])
               and caso = 'reemplazo_no_revisado' );

create policy asiento_propuesto_reproceso_ins_ajuste on asiento_propuesto_reproceso for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[])
               and caso = 'ajuste_ya_entregado' );

-- Sin UPDATE ni DELETE para nadie: append-only, mismo patrón que cierre_transicion/pendiente_dispensa.

grant select, insert on asiento_propuesto_reproceso to app_request;

comment on table asiento_propuesto_reproceso is
  'Trail de NEGOCIO del reproceso de Capa D (0040) — por qué se reemplazó/ajustó cada asiento, con '
  'qué regla vieja y nueva, quién y cuándo. Distinto del trail de cumplimiento (acceso_auditoria vía '
  'escribirConAuditoria, que el escritor de aplicación usa en paralelo, restringido a socio/auditor). '
  'Append-only: sin UPDATE ni DELETE otorgado a nadie.';

comment on constraint asiento_propuesto_reproceso_caso_chk on asiento_propuesto_reproceso is
  'Dominio cerrado. Lista IDÉNTICA a CASOS_REPROCESO_ASIENTO (packages/data/src/cierre/tipos.ts).';

comment on constraint asiento_propuesto_reproceso_motivo_codigo_chk on asiento_propuesto_reproceso is
  'Dominio cerrado. Lista IDÉNTICA a MOTIVOS_REPROCESO_ASIENTO (packages/data/src/cierre/tipos.ts). '
  'N2 (no N1, laudo del titular 2026-09-07): dato_tardio_cliente nombra una conducta atribuible a un '
  'tercero real, a diferencia de pendiente_cierre.motivo_codigo (estados del propio sistema).';

commit;
