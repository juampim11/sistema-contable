-- =============================================================================
-- 0037_padron_contraparte.sql — catálogo de proveedores/clientes conocidos por NOMBRE, para que
-- Capa C identifique la contraparte específica de un pago/cobranza cuando el léxico genérico solo
-- sabe decir "es un pago a ALGÚN proveedor".
--
-- Diseño CERRADO por dos convocatorias completas (`arquitecto-software` + `contador-dominio` +
-- `dba-data`, después `dba-data` + `plan-cuentas-multicliente` sobre el enlace con `cuenta_id`),
-- documentado en `docs/diseno/29-padron-contraparte.md`. Antes de escribir este DDL se convocó además
-- `security-engineer` + `seguridad-datos-financieros` sobre el DDL concreto (exigido por
-- `CLAUDE.md` §3.1 para toda migración/RLS) — encontraron UN hallazgo bloqueante, corregido en (c)
-- abajo. Esta migración es la implementación literal de ese diseño — no se rediseña nada acá.
--
-- ## Qué se agrega
--
-- (a) `padron_contraparte` — tabla nueva, N2 simple. A diferencia de `padron_socio` (0013), NO lleva
--     HMAC/pepper/satélite N2-R: un nombre comercial no es un identificador que habilite fraude
--     (ADR-0002 §A.1), a diferencia del documento fiscal de un socio. Mismos tres precedentes de N2
--     en este repo para un nombre real: `tenant_node.nombre`, `padron_socio.denominacion`,
--     `cuenta_atributo.denominacion`.
-- (b) `clasificacion` — dominio cerrado `('proveedor', 'cliente', 'otro')`, mismo criterio que subió
--     `cuenta_atributo.rol_funcional` a N2 (0027): afirma un hecho real de la relación comercial de
--     ESE cliente, no vocabulario de proceso.
-- (c) `padron_contraparte_patron_sin_documento_chk` — CORREGIDO en la convocatoria de seguridad
--     previa a esta migración. La forma original (`patron !~ '[0-9]{7}'`, mismo regex que
--     `padron_socio_denominacion_sin_identificador_chk` de 0013) solo bloquea una corrida de 7+
--     dígitos CONSECUTIVOS — un CUIT con separadores de miles ("30.712.345.678") no tiene ninguna
--     corrida de 7 seguidos y lo evade por completo. El regex de acá exige 7+ dígitos con un
--     separador OPCIONAL (espacio/punto/guión) entre cada uno, así que una cadena de dígitos
--     partida por puntos o espacios sigue contando como una sola corrida. Puerta de admisión
--     CONSERVADORA, no de confianza — ver el `comment on constraint` de abajo para el trade-off
--     aceptado.
-- (d) `asiento_propuesto_renglon.padron_contraparte_id` — columna nueva, FK COMPUESTA
--     tenant-consistente. Es evidencia trazable ("este renglón matcheó contra este patrón"), NUNCA
--     resuelve `cuenta_id` — la cuenta destino sigue siendo la genérica que ya resuelve
--     `regla_imputacion` (`cuenta_resolucion` NO se toca, sigue en sus 4 valores: decisión cerrada en
--     la ronda de `plan-cuentas-multicliente`, verificación empírica contra el piloto real sin
--     ningún caso de sub-cuenta por proveedor). La FK tiene que ser COMPUESTA y no simple: sin
--     `(cliente_id, padron_contraparte_id) references padron_contraparte(cliente_id, id)`, un INSERT
--     con `cliente_id` de un cliente y `padron_contraparte_id` apuntando a una fila de OTRO cliente
--     pasaría igual — Postgres solo valida existencia, RLS no protege el INSERT del hijo contra ese
--     vector (hallazgo F1 de `seguridad-datos-financieros`, confirmado por `security-engineer`
--     contra el DDL real de `asiento_propuesto_renglon`: mismo patrón exacto que
--     `fk_asiento_renglon_manifestacion`, 0027).
--
-- ## Lo que esta migración NO hace, a propósito
--
-- No conecta nada al pipeline real (`motor.ts`, lectura del padrón, persistencia de
-- `padron_contraparte_id` al escribir un renglón) — eso es una integración posterior, con su propia
-- convocatoria si hace falta (`docs/diseno/29-padron-contraparte.md` §4). No carga ningún proveedor
-- real — eso es un paso posterior separado, con confirmación de la contadora nombre por nombre.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `padron_contraparte` (N2) — el catálogo
-- -----------------------------------------------------------------------------
create table padron_contraparte (
  -- (1) de la plantilla de ADR-0001 §5.
  id             uuid primary key default gen_random_uuid(),
  cliente_id     uuid not null references tenant_node(id) on delete restrict,

  -- N2. Ya normalizado por la aplicación (normalizar(), packages/shared/src/texto/normalizar.ts)
  -- antes de escribir — los cinco checks de forma de abajo verifican la POSCONDICIÓN de esa
  -- normalización, nunca la recalculan (el algoritmo vive una sola vez, en TypeScript).
  patron         text not null,

  -- N2. Mismo argumento que subió cuenta_atributo.rol_funcional a N2: afirma un hecho real de la
  -- relación comercial de ESTE cliente con un tercero puntual, no vocabulario de proceso.
  clasificacion  text not null,

  -- N2. Vigencia SEMIABIERTA [vigente_desde, vigente_hasta) — mismo patrón que padron_socio.
  vigente_desde  date not null,
  vigente_hasta  date,

  created_at     timestamptz not null default now(),

  constraint padron_contraparte_patron_no_vacio_chk
    check (btrim(patron) <> ''),
  constraint padron_contraparte_patron_mayuscula_chk
    check (patron = upper(patron)),
  constraint padron_contraparte_patron_recortado_chk
    check (patron = btrim(patron)),
  constraint padron_contraparte_patron_sin_espacios_dobles_chk
    check (patron !~ '  '),
  constraint padron_contraparte_patron_sin_marcas_chk
    check (patron !~ '[̀-ͯ]'),

  -- Puerta de admisión contra un documento tipeado por error en `patron` — ver (c) en la cabecera.
  constraint padron_contraparte_patron_sin_documento_chk
    check (patron !~ '[0-9]([[:space:].-]?[0-9]){6,}'),

  constraint padron_contraparte_clasificacion_chk
    check (clasificacion in ('proveedor', 'cliente', 'otro')),

  constraint padron_contraparte_vigencia_chk
    check (vigente_hasta is null or vigente_hasta > vigente_desde),

  -- Unicidades, SIEMPRE por cliente (R6), con cliente_id PRIMERO en cada una (R40: todo índice único
  -- no-PK sobre tabla con columna de tenant incluye esa columna adelante).
  constraint uq_padron_contraparte_serie
    unique (cliente_id, patron, vigente_desde),
  constraint uq_padron_contraparte_tenant
    unique (cliente_id, id)
);

-- Una sola vigencia ABIERTA por (cliente, patrón) — mismo mecanismo que uq_padron_socio_vigente
-- (0013): sin esto, dos altas del mismo patrón con fecha de inicio distinta dejarían dos filas
-- vigentes y el motor nunca podría resolver ese patrón sin ambigüedad.
create unique index uq_padron_contraparte_vigente
  on padron_contraparte (cliente_id, patron)
  where vigente_hasta is null;

-- (2) de la plantilla, y la consulta real: el motor trae el padrón COMPLETO de un cliente y compara
-- en memoria (son unidades de filas por cliente, no miles) — mismo patrón que padron_socio. Sin
-- índice de patrón/LIKE: la ambigüedad entre patrones la resuelve el motor, no la base.
create index idx_padron_contraparte_cliente on padron_contraparte(cliente_id);

-- (3) el patrón cuelga de un nodo `cliente`, nunca de un `estudio`.
create trigger trg_padron_contraparte_cliente
  before insert or update of cliente_id on padron_contraparte
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5). El (5) le aplica las políticas también al dueño del esquema.
alter table padron_contraparte enable row level security;
alter table padron_contraparte force  row level security;

-- (6) lectura sin chequeo de rol: no hay ninguna columna N2-R, y el motor la consulta en cada
-- pasada — mismo criterio que padron_socio_sel.
create policy padron_contraparte_sel on padron_contraparte for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) escritura por operación, nunca `for all`. SIN `administrativo`: decidir que un tercero es
-- proveedor/cliente cambia la imputación de TODOS sus movimientos, pasados y futuros, sin que nada
-- falle — mismo argumento exacto que excluye a `administrativo` de padron_socio_ins/upd.
create policy padron_contraparte_ins on padron_contraparte for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador']::app.rol_membership[]) );

create policy padron_contraparte_upd on padron_contraparte for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador']::app.rol_membership[]) );

-- Sin DELETE para nadie: un patrón mal cargado se CIERRA (vigente_hasta), nunca se borra — mismo
-- motivo que padron_socio (un extracto viejo tiene que seguir resolviendo con el padrón de entonces).
grant select, insert on padron_contraparte to app_request;

-- Update SOLO de vigente_hasta. A diferencia de padron_socio.denominacion (etiqueta cosmética que sí
-- se puede corregir), acá `patron` ES la clave funcional de matching: un typo no es cosmético.
-- Corregirlo es cerrar la serie (vigente_hasta) y dar de alta la nueva con el valor corregido.
grant update (vigente_hasta) on padron_contraparte to app_request;

-- app_job no recibe nada: el alta corre como app_request, bajo conUsuario.

comment on table padron_contraparte is
  'Catálogo por cliente de proveedores/clientes conocidos por NOMBRE (texto libre matcheado contra '
  'la glosa bancaria), para que Capa C identifique la contraparte específica cuando el léxico '
  'genérico solo sabe decir "es un pago a ALGÚN proveedor". N2 simple, sin HMAC/pepper/satélite '
  'N2-R a diferencia de padron_socio: un nombre comercial no es un identificador que habilite '
  'fraude. Se enlaza al asiento como EVIDENCIA (asiento_propuesto_renglon.padron_contraparte_id), '
  'nunca resuelve cuenta_id — ver docs/diseno/29-padron-contraparte.md.';

comment on constraint padron_contraparte_clasificacion_chk on padron_contraparte is
  'Dominio cerrado. Lista IDÉNTICA a CLASIFICACIONES_CONTRAPARTE '
  '(packages/contabilidad/src/nucleo/contraparte.ts). Comparada como conjunto contra pg_constraint '
  'por el test de catálogo de dominios cerrados.';

comment on constraint padron_contraparte_patron_sin_documento_chk on padron_contraparte is
  'Puerta de admisión (no confianza), mismo mecanismo que '
  'padron_socio_denominacion_sin_identificador_chk (0013), corregido contra el vector de evasión '
  'por separadores de miles que ese regex original dejaba pasar (ver security-engineer, '
  'convocatoria previa a esta migración): exige 7+ dígitos con separador OPCIONAL '
  '(espacio/punto/guión) entre cada uno, no solo corridas consecutivas. Puerta de admisión '
  'CONSERVADORA — un nombre de proveedor real con una cadena larga de dígitos (código postal, '
  'número de sucursal) puede rechazarse como falso positivo; es el trade-off aceptado, mismo '
  'criterio que padron_socio. Si ocurre, el CLI debe indicarlo con claridad en el mensaje de '
  'error, no fallar en silencio.';

comment on column padron_contraparte.patron is
  'N2. Nombre comercial de un proveedor/cliente, ya normalizado (normalizar()) por la aplicación '
  'antes de escribir. Mismo tier que tenant_node.nombre/padron_socio.denominacion.';

comment on column padron_contraparte.clasificacion is
  'N2. proveedor|cliente|otro — familia de cuenta a la que pertenece la relación con este tercero. '
  '"otro" también sirve para ANULAR el default de un patrón de glosa cuando el tercero es conocido '
  'por otra vía (ej. un empleado) — ver docs/diseno/29-padron-contraparte.md §1.3.';

-- -----------------------------------------------------------------------------
-- 2. `asiento_propuesto_renglon.padron_contraparte_id` — enlace de EVIDENCIA (D-7/D-15/D-18/D-20,
--    mismo trato que padron_manifestacion_id)
-- -----------------------------------------------------------------------------
alter table asiento_propuesto_renglon add column padron_contraparte_id uuid;

-- FK COMPUESTA tenant-consistente — ver (d) en la cabecera para el motivo exacto.
alter table asiento_propuesto_renglon add constraint fk_asiento_renglon_contraparte
  foreign key (cliente_id, padron_contraparte_id) references padron_contraparte (cliente_id, id)
  on delete restrict;

comment on column asiento_propuesto_renglon.padron_contraparte_id is
  'FK de EVIDENCIA (uuid, no contenido) a padron_contraparte — mismo trato que '
  'padron_manifestacion_id: el asiento CITA qué patrón matcheó, nunca resuelve cuenta_id a partir '
  'de esto. NULL cuando no hubo match o no se consultó. No activa tablasQueExigenRolEnLectura(): '
  'una referencia no es el documento en claro de un tercero (guardrail explícito de 0027 sobre '
  'esta misma tabla).';

commit;
