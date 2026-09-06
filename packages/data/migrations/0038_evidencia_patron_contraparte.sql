-- =============================================================================
-- 0038_evidencia_patron_contraparte.sql — Mitad 1: persiste en reconocimiento_contrapartida (0021)
-- también la evidencia de padron_contraparte (0037), que hoy sólo vive en memoria durante
-- reconocer-lote.ts/exportar-planilla.ts y se descarta al terminar la corrida.
--
-- Convocatoria formal (CLAUDE.md §3.1): dba-data + security-engineer + seguridad-datos-financieros,
-- sobre este DDL concreto. Sin bloqueantes de mecanismo (RLS/FKs/índice parcial fiel al precedente de
-- 0021). Cambios respecto del primer borrador, todos incorporados abajo:
--   (a) padron_contraparte_id en la satélite nueva va N2 (dba-data + seguridad-datos-financieros,
--       veredictos independientes) — mismo tier que reconocimiento_contrapartida_match.socio_id, NO el
--       de asiento_propuesto_renglon.padron_contraparte_id (N1, 0037 — rol distinto: ese cita evidencia
--       sobre un asiento YA generado, ésta ES la cola de revisión activa). Deuda separada, sin dueño,
--       registrada en docs/diseno/10-deuda-declarada.md: la clasificación N1 de 0037 se apoyó en una
--       analogía floja con padron_manifestacion_id, no se toca en esta migración.
--   (b) patron_contraparte_estado NOT NULL sin condición, verificado EN VIVO (select count(*),
--       2026-09-06): reconocimiento_contrapartida tiene 0 filas en local y en piloto — el NOT NULL sin
--       default no rompe nada hoy. resolverEvidenciaDeContraparte() es TOTAL sobre las 7 ramas de
--       resolucion_estado, así que el valor siempre es computable.
--   (c) 🔴 Hallazgo de secuenciación (dba-data, bloqueante de PROCESO): esta migración y el código del
--       escritor (packages/data/src/contabilidad/escrituras.ts, apps/cli/src/reconocer-lote.ts) tienen
--       que desplegarse en el MISMO release — aplicada sola, rompe el próximo INSERT de capa C.
--   (d) Las dos FK de 3 columnas de la satélite nueva anclan contra admite_matches_patron/
--       regimen_matches_patron del padre, NUNCA contra los homónimos de socio que conviven en la MISMA
--       fila — hallazgo explícito de seguridad-datos-financieros, cubierto por prueba de mutación.
--   (e) El check de promoción (contrapartida_promocion_chk) NO se replica para patron_contraparte_estado
--       — a propósito: un match de nombre nunca promueve decision_humana → propuesta por sí solo
--       (contraparte.ts). Confirmado por seguridad-datos-financieros.
--
-- Fuera de esta migración, a propósito: padron_manifestacion_id/padron_completo_hasta no se tocan
-- (Mitad 2, aparte); no se carga ningún proveedor real; no se toca 0037 ni ninguna migración aplicada.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- A. `reconocimiento_contrapartida` — evidencia del padrón de contrapartes por NOMBRE
-- -----------------------------------------------------------------------------

alter table reconocimiento_contrapartida
  add column patron_contraparte_estado text not null,
  add column admite_matches_patron boolean generated always as
    (patron_contraparte_estado in ('match', 'multiples_patrones')) stored not null,
  add column regimen_matches_patron text generated always as (
    case patron_contraparte_estado
      when 'match'              then 'patron_unico'
      when 'multiples_patrones' then 'varios'
      else                           'sin_matches'
    end) stored not null;

alter table reconocimiento_contrapartida add constraint contrapartida_patron_estado_chk
  check (patron_contraparte_estado in ('no_aplica', 'sin_match', 'match', 'multiples_patrones'));

alter table reconocimiento_contrapartida
  add constraint uq_recon_contrapartida_admite_patron  unique (cliente_id, id, admite_matches_patron),
  add constraint uq_recon_contrapartida_regimen_patron unique (cliente_id, id, regimen_matches_patron);

grant insert (patron_contraparte_estado) on reconocimiento_contrapartida to app_request;

comment on column reconocimiento_contrapartida.patron_contraparte_estado is
  'N2. Uno de los 4 estados de EvidenciaDeContraparte (packages/contabilidad/src/nucleo/contraparte.ts), '
  'espejo hermano de resolucion_estado pero sobre el padrón de contrapartes por NOMBRE (0037), no por '
  'HMAC de documento. NOT NULL sin condición: resolverEvidenciaDeContraparte() es TOTAL sobre las 7 '
  'ramas de resolucion_estado (incluida es_socio, donde da no_aplica) y esta fila se escribe siempre '
  'que capa C corrió — el valor siempre es computable. Verificado en vivo (2026-09-06): 0 filas en '
  'local y piloto al momento de escribir esta migración, por eso el NOT NULL sin default no rompe '
  'nada; re-verificar el conteo si pasa tiempo antes de aplicar.';

comment on column reconocimiento_contrapartida.admite_matches_patron is
  'Generada STORED, ancla de mecanismo para reconocimiento_contrapartida_patron_match — mismo idiom '
  'que admite_matches, PERO PARA EL PADRÓN DE NOMBRES: sufijo _patron a propósito, para no confundirla '
  'con la columna homónima de socio que convive en la MISMA fila y significa otra cosa.';

comment on column reconocimiento_contrapartida.regimen_matches_patron is
  'Generada STORED, hermana de regimen_matches pero para el padrón de nombres. Mismo criterio de '
  'sufijo explícito que admite_matches_patron.';

comment on constraint contrapartida_patron_estado_chk on reconocimiento_contrapartida is
  'Dominio cerrado. Lista IDÉNTICA a ESTADOS_EVIDENCIA_CONTRAPARTE '
  '(packages/contabilidad/src/nucleo/contraparte.ts), derivada de EvidenciaDeContraparte[''estado'']. '
  'A diferencia de resolucion_estado, NINGÚN valor está bloqueado por código: '
  'resolverEvidenciaDeContraparte es total y las 4 ramas son alcanzables desde el primer lote real.';

comment on constraint uq_recon_contrapartida_admite_patron on reconocimiento_contrapartida is
  'Destino del lado referenciado de fk_recon_contrapartida_patron_match_padre. NO confundir con '
  'uq_recon_contrapartida_admite (mismo padre, ancla la evidencia de SOCIO): dos anclas independientes '
  'conviven en la misma fila desde 0038, cada una para su propia satélite.';

comment on constraint uq_recon_contrapartida_regimen_patron on reconocimiento_contrapartida is
  'Destino del lado referenciado de fk_recon_contrapartida_patron_match_regimen. Mismo criterio que '
  'uq_recon_contrapartida_admite_patron: ancla independiente de la de socio.';

-- -----------------------------------------------------------------------------
-- B. `reconocimiento_contrapartida_patron_match` (N2, satélite 0..N) — a qué patrones matcheó
-- -----------------------------------------------------------------------------
-- Mirror de reconocimiento_contrapartida_match (0021), simplificado: sin match_clase — acá no hay
-- "vía" de identificador, resolverEvidenciaDeContraparte() matchea por una sola forma (substring exacto
-- contra la glosa normalizada, contraparte.ts) — y padron_contraparte_id en vez de socio_id.
create table reconocimiento_contrapartida_patron_match (
  id                     uuid primary key default gen_random_uuid(),
  cliente_id             uuid not null references tenant_node(id) on delete restrict,

  contrapartida_id       uuid not null,

  -- N2. Constante. No se puede escribir ni con el valor correcto. Mitad hija de la FK que vuelve
  -- IMPOSIBLE un match colgado de un padre que no admite matches de patrón.
  admite_matches         boolean generated always as (true) stored not null,

  -- N2. Escribible, pero no falsificable: la FK sólo encuentra padre si el valor coincide con el del
  -- padre, y el check mata 'sin_matches'.
  regimen_matches        text not null,

  -- N2 (convocatoria de 0038, dba-data + seguridad-datos-financieros, caminos independientes, mismo
  -- veredicto): mismo tier que reconocimiento_contrapartida_match.socio_id, NO el de
  -- asiento_propuesto_renglon.padron_contraparte_id (N1, 0037) — ese cita evidencia sobre un asiento
  -- YA generado; ésta ES la cola de revisión activa mostrando cuál matcheó. El riesgo es la
  -- correlación entre filas por un mismo uuid recurrente (perfil comercial del tercero con este
  -- cliente), no el contenido del uuid. Nunca el texto del patrón: la evidencia en pantalla es el
  -- uuid, igual que socio_id en la satélite hermana.
  padron_contraparte_id  uuid not null,

  created_at             timestamptz not null default now(),

  -- Dominio cerrado, subconjunto: los regímenes que ADMITEN matches. Lista IDÉNTICA a
  -- REGIMENES_CON_MATCHES_PATRON (packages/contabilidad/src/nucleo/contraparte.ts).
  constraint contrapartida_patron_match_regimen_chk
    check (regimen_matches in ('patron_unico', 'varios')),

  -- El mismo patrón dos veces en la misma contrapartida no es un dato: bug del productor. A diferencia
  -- de la satélite hermana, sin match_clase en la clave: no hay dos formas legítimas de matchear el
  -- mismo patrón dos veces.
  constraint uq_recon_contrapartida_patron_match
    unique (cliente_id, contrapartida_id, padron_contraparte_id),

  constraint uq_recon_contrapartida_patron_match_tenant unique (cliente_id, id),

  -- (11) FK COMPUESTA de TRES columnas: mismo cliente Y un padre que ADMITE matches de patrón.
  -- 🔴 Ancla contra admite_matches_patron del PADRE — NUNCA contra admite_matches (homónimo de socio,
  -- misma fila). Un error de copiar por nombre en vez de por significado ataría esta evidencia al
  -- estado de SOCIO, en silencio, sin fallar compilación ni tipo (hallazgo de
  -- seguridad-datos-financieros, convocatoria de 0038 — cubierto por prueba de mutación explícita).
  constraint fk_recon_contrapartida_patron_match_padre
    foreign key (cliente_id, contrapartida_id, admite_matches)
    references reconocimiento_contrapartida (cliente_id, id, admite_matches_patron)
    on delete restrict,

  -- (11) otra vez, por VALOR, contra regimen_matches_patron del padre — mismo cuidado que arriba.
  constraint fk_recon_contrapartida_patron_match_regimen
    foreign key (cliente_id, contrapartida_id, regimen_matches)
    references reconocimiento_contrapartida (cliente_id, id, regimen_matches_patron)
    on delete restrict,

  -- (11) FK COMPUESTA tenant-consistente — mismo hallazgo F1 de la convocatoria de 0037: sin las DOS
  -- columnas, un INSERT con cliente_id propio y padron_contraparte_id de OTRO cliente pasaría igual
  -- (Postgres solo valida existencia, RLS no protege el INSERT del hijo).
  constraint fk_recon_contrapartida_patron_match_patron
    foreign key (cliente_id, padron_contraparte_id)
    references padron_contraparte (cliente_id, id)
    on delete restrict
);

-- 🔴 LA CARDINALIDAD DE `match`, EN LA BASE. Índice único PARCIAL, mismo idiom que
-- uq_recon_contrapartida_match_socio_unico (0021).
create unique index uq_recon_contrapartida_patron_match_unico
  on reconocimiento_contrapartida_patron_match (cliente_id, contrapartida_id)
  where regimen_matches = 'patron_unico';

comment on index uq_recon_contrapartida_patron_match_unico is
  'GARANTIZA, junto con fk_recon_contrapartida_patron_match_regimen: bajo match (regimen_matches = '
  'patron_unico) hay A LO SUMO UNA fila. 🔴 EL INSERT DE ESTA TABLA TIENE QUE DEJAR SUBIR EL 23505, '
  'NUNCA envolverlo en ON CONFLICT (ninguna de las dos formas, con o sin WHERE) — mismo vector exacto '
  'documentado en uq_recon_contrapartida_match_socio_unico (0021): al ser parcial, un ON CONFLICT con '
  'el WHERE que matchea el predicado SÍ compila y traga en silencio una colisión que debería abortar '
  'el lote (hallazgo de security-engineer, convocatoria de 0038).';

-- (2) de la plantilla.
create index idx_reconocimiento_contrapartida_patron_match_cliente
  on reconocimiento_contrapartida_patron_match(cliente_id);

-- (3)
create trigger trg_reconocimiento_contrapartida_patron_match_cliente
  before insert or update of cliente_id on reconocimiento_contrapartida_patron_match
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5).
alter table reconocimiento_contrapartida_patron_match enable row level security;
alter table reconocimiento_contrapartida_patron_match force  row level security;

-- (6) lectura sin chequeo de rol: cero columnas N2-R/N3, mismo criterio que la satélite hermana —
-- esto es salida del motor, la cola de revisión la lee entera todos los meses.
create policy reconocimiento_contrapartida_patron_match_sel
  on reconocimiento_contrapartida_patron_match for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) POR OPERACIÓN, nunca `for all`. `administrativo` entra: esto es SALIDA DEL MOTOR, mismo criterio
-- que reconocimiento_contrapartida_match_ins.
create policy reconocimiento_contrapartida_patron_match_ins
  on reconocimiento_contrapartida_patron_match for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE para nadie: un cálculo mal hecho se corrige re-emitiendo el reconocimiento
-- (supersesión), nunca editando la evidencia vieja. `app_job` no recibe nada.
grant select on reconocimiento_contrapartida_patron_match to app_request;
grant insert (cliente_id, contrapartida_id, regimen_matches, padron_contraparte_id)
  on reconocimiento_contrapartida_patron_match to app_request;

comment on constraint contrapartida_patron_match_regimen_chk on reconocimiento_contrapartida_patron_match is
  'Dominio cerrado, subconjunto. Lista IDÉNTICA a REGIMENES_CON_MATCHES_PATRON '
  '(packages/contabilidad/src/nucleo/contraparte.ts) — NO es la misma constante que '
  'REGIMENES_CON_MATCHES de la satélite hermana (''socio_unico'' vs ''patron_unico'').';

comment on table reconocimiento_contrapartida_patron_match is
  'Satélite 0..N de reconocimiento_contrapartida (migración 0038): los patrones de padron_contraparte '
  '(0037) contra los que matcheó la glosa bancaria normalizada. Mirror de '
  'reconocimiento_contrapartida_match (evidencia de SOCIO), sin match_clase: acá no hay "vía" de '
  'identificador, una sola forma de matchear (substring exacto, resolverEvidenciaDeContraparte en '
  'contraparte.ts). Sin UPDATE ni DELETE para nadie: un cálculo mal hecho se corrige re-emitiendo el '
  'reconocimiento (supersesión), nunca editando evidencia vieja.';

commit;
