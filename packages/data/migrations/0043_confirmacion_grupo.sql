-- =============================================================================
-- 0043_confirmacion_grupo.sql — memoria de confirmaciones de Laura por grupo (Tanda 2, doc 31)
--
-- Confirma A QUÉ CUENTA CONTABLE va un grupo de movimientos — clave EXACTA de claveDeAgrupacion()
-- (`packages/ingesta/src/planilla/armar-libro.ts`): `(cliente_id, banco_codigo, concepto_banco
-- normalizado)`. Vive en la capa de EXPORTACIÓN: nunca escribe `reconocimiento_movimiento` ni
-- `asiento_propuesto`. D-28 (`packages/motor-conciliacion/src/resolver.ts`) sigue bloqueado — decisión
-- explícita de JP, 2026-09-12: no reabrir el resolver de Capa D en esta tarea. El veto de familia socio
-- (`estaVetadaPorFamiliaSocio`, D-31) queda documentado como insumo para el futuro en
-- `docs/diseno/10-deuda-declarada.md`, no aplicado acá.
--
-- Diseño: dictamen conjunto `arquitecto-software` + `dba-data` (2026-09-12) sobre la clave y el
-- contenido; patrón de vigencia final por decisión de JP — mismo mecanismo que `regla_imputacion`
-- (`0030`): `UPDATE` solo por column-grant sobre `vigente_hasta`, nunca `revoca_a`/append-only (esta
-- tabla no es citada por FK desde ninguna otra — no hereda el problema que sí resolvió `0041`/`0042`
-- para `padron_manifestacion`).
--
-- Convocatoria de seguridad PREVIA a esta migración (mismo protocolo que 0037-0042): `dba-data` +
-- `security-engineer` + `seguridad-datos-financieros`.
--
-- CERO conexión al piloto: diseñada y aplicada solo contra LOCAL.
-- =============================================================================

begin;

create table confirmacion_grupo (
  id                    uuid primary key default gen_random_uuid(),
  cliente_id            uuid not null references tenant_node(id) on delete restrict,

  banco_codigo          text not null references banco(codigo) on delete restrict,
  -- NULL = concepto vacío del banco (mismo sentinel que claveDeAgrupacion(), armar-libro.ts:221).
  concepto_banco        text,

  -- Gemela EXACTA de `normalizarParaAgrupar()` (armar-libro.ts:216-218) + el sentinel de
  -- `claveDeAgrupacion()` (armar-libro.ts:220-223) — nunca reescribir una sin la otra (barrido de
  -- sincronía en `mutaciones-0043-confirmacion-grupo.test.ts`, caso "gemela SQL↔TS").
  concepto_normalizado  text generated always as (
    case when concepto_banco is null then '(sin concepto)'
         else upper(trim(regexp_replace(concepto_banco, '\s+', ' ', 'g')))
    end
  ) stored not null,

  cuenta_id             uuid not null,

  -- Qué decisión acredita esta confirmación — mismo patrón y mismo hueco BLOQUEADO que
  -- `regla_imputacion.respaldo`/`cuenta_atributo.respaldo` (incidente #14, sin resolver, heredado a
  -- propósito: puede terminar citando un CUIT o un nombre de socio sin que la clasificación por
  -- columna lo vea). A diferencia de esos dos: NOT NULL + piso de longitud, pedido explícito de JP
  -- (2026-09-12) — un piso, no una solución.
  respaldo              text not null,
  confirmado_por        uuid not null,
  confirmado_en         timestamptz not null default now(),
  vigente_hasta         timestamptz,

  constraint confirmacion_grupo_respaldo_chk check (length(btrim(respaldo)) >= 15),
  constraint confirmacion_grupo_vigencia_chk check (vigente_hasta is null or vigente_hasta > confirmado_en),

  constraint uq_confirmacion_grupo_tenant unique (cliente_id, id),
  constraint fk_confirmacion_grupo_cuenta
    foreign key (cliente_id, cuenta_id) references cuenta (cliente_id, id) on delete restrict
);

create index idx_confirmacion_grupo_cliente on confirmacion_grupo(cliente_id);

-- Una sola confirmación ABIERTA por (cliente, banco, concepto normalizado) — mismo mecanismo que
-- `uq_regla_imputacion_vigente` (0030). `concepto_normalizado` nunca es NULL (la columna generada
-- siempre devuelve el sentinel o el texto normalizado), así que a diferencia de `regla_imputacion` NO
-- hace falta `nulls not distinct` acá.
create unique index uq_confirmacion_grupo_vigente
  on confirmacion_grupo (cliente_id, banco_codigo, concepto_normalizado)
  where vigente_hasta is null;

create trigger trg_confirmacion_grupo_cliente
  before insert or update of cliente_id on confirmacion_grupo
  for each row execute function app.exigir_nodo_cliente();

alter table confirmacion_grupo enable row level security;
alter table confirmacion_grupo force  row level security;

create policy confirmacion_grupo_sel on confirmacion_grupo for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- Confirmar a qué cuenta va un grupo es la misma clase de decisión que `regla_imputacion` (D-29 §2):
-- nunca `administrativo`.
create policy confirmacion_grupo_ins on confirmacion_grupo for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

-- UPDATE solo para CERRAR una vigencia (nunca reescribir banco/concepto/cuenta de una confirmación ya
-- escrita) — mismo patrón exacto que `regla_imputacion_upd` (0030), mecanizado por column-grant abajo.
create policy confirmacion_grupo_upd on confirmacion_grupo for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert on confirmacion_grupo to app_request;
grant update (vigente_hasta) on confirmacion_grupo to app_request;
-- Nunca a app_job: mismo argumento que regla_imputacion (0030) — ningún camino de sistema tiene motivo
-- para confirmar a mano una cuenta por Laura (CLAUDE.md §2.1).

comment on constraint confirmacion_grupo_respaldo_chk on confirmacion_grupo is
  'Piso de longitud — mismo hueco BLOQUEADO que regla_imputacion.respaldo (incidente #14): prosa libre '
  'puede terminar citando un CUIT o un nombre de socio sin que la clasificación por columna lo vea. '
  'NOT NULL + longitud mínima (15) es un piso, no una solución — decisión de JP, 2026-09-12.';
comment on table confirmacion_grupo is
  'Capa de EXPORTACIÓN pura (doc 31, Tanda 2) — nunca escribe reconocimiento_movimiento ni '
  'asiento_propuesto. D-28 sigue bloqueado: ver packages/motor-conciliacion/src/resolver.ts y '
  'docs/diseno/10-deuda-declarada.md.';

commit;
