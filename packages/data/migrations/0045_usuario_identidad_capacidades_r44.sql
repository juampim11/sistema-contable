-- =============================================================================
-- 0045_usuario_identidad_capacidades_r44.sql — `usuario_identidad` + capacidades finas + R44
--
-- Síntesis de 3 dictámenes (`dba-data`, `security-engineer`, `seguridad-datos-financieros`) más
-- decisión de alcance AMPLIO del titular: extiende `app.accessible_tenant_ids()` **y**
-- `app.has_role_on()` con `usuario_identidad.activo` (no solo `has_capacidad_en()`, que el ADR
-- nombraba) — P12: "baja de una persona = un solo comando, corte completo (lectura Y escritura)".
-- Ver `docs/arquitectura/ADR-0006-autenticacion.md` §2/§3/§7/§7.bis y el plan de implementación
-- (síntesis de los 3 dictámenes, aprobado por el titular antes de esta migración).
--
-- Convocatoria PREVIA (mismo protocolo que 0037-0043): `dba-data` + `security-engineer` +
-- `seguridad-datos-financieros`, sobre el diseño; esta migración es la implementación real, revisada
-- de nuevo con ojo crítico contra el código aplicado (no copiada ciega del plan — ver correcciones
-- documentadas abajo).
--
-- ## Correcciones de `dba-data` sobre el plan aprobado (documentadas para la convocatoria posterior)
--
-- 1. 🔴 **`accessible_tenant_ids()`/`has_role_on()` ESTÁN SUPERSEDIDAS por `0015`**, no por `0001`.
--    El plan copió el `search_path = public, app, pg_temp` y las tablas SIN calificar (`membership`,
--    `tenant_node`) de la versión ORIGINAL de `0001_tenancy.sql` — exactamente la lección de
--    "migración original puede estar superada": `0015_search_path_pg_temp.sql` (R10, incidente #1) ya
--    había endurecido las DOS funciones a `search_path = pg_catalog, public, app, pg_temp` con TODA
--    tabla calificada por esquema (`public.membership`, `public.tenant_node`). Copiar el `search_path`
--    viejo habría sido una regresión real de una vulnerabilidad ya cerrada. Se preserva acá el
--    endurecimiento de `0015` íntegro, con el `join usuario_identidad` agregado.
-- 2. **Orden real distinto al presentado en el plan**: el plan mostraba la tabla `usuario_identidad`
--    con sus policies ANTES de las funciones — pero las policies de `usuario_identidad` llaman a
--    `app.has_capacidad_en()`, que a su vez hace `join usuario_identidad`. Postgres exige que toda
--    función referenciada por una policy exista al momento de `create policy`, y `has_capacidad_en()`
--    necesita la tabla ya creada. Orden real: (a) tabla SIN policies todavía, (b) las 4 funciones,
--    (c) RLS + policies + grants de la tabla, (d) R44.
-- 3. 🔴 **`with_check` de R44 va CONDICIONADO (`col is null or col = current_user_id()`), no en
--    igualdad ciega, en la mayoría de las policies** — verificado consulta por consulta cuál policy es
--    dedicada a UNA sola transición (ahí la igualdad ciega es segura, hay otra policy sin el check que
--    sirve de escape para el resto) y cuál gobierna VARIAS transiciones a la vez (o convive con una
--    hermana que hoy no restringe la columna en absoluto — ver punto 6):
--      - `asiento_propuesto_upd_confirmar` y `confirmacion_grupo_ins`: igualdad ciega, tal como
--        proponía el plan. La primera tiene a `asiento_propuesto_upd_general` (excluye
--        `asiento_estado = 'confirmado'` de su propio `with_check`) como escape para supersesión — el
--        `OR` entre policies permisivas la deja pasar igual. La segunda es INSERT puro, sin fila vieja
--        que preservar: no hay caso de "no tocar la columna".
--      - `cierre_periodo_upd_cierre` GOBIERNA DOS TRANSICIONES, no una: confirmar (→ `'confirmado'`,
--        pone `confirmado_por`/`confirmado_en`) **y anular** (→ `'anulado'`, el `CHECK` de coherencia
--        exige que NO estén los dos seteados). `cierre_periodo_upd_operativo` EXCLUYE explícitamente
--        `cierre_estado in ('confirmado','anulado')` de su propio `with_check` — o sea que anular NO
--        tiene otra policy que sirva de escape. Una igualdad ciega acá habría roto la transición de
--        ANULAR un período (`confirmado_por` se queda en `null`, `null = current_user_id()` es `null`,
--        nunca `true`) — un bug real que el "caso legítimo" de la prueba de mutación lo habría
--        encontrado recién al escribir la prueba, no antes.
--      - `pendiente_cierre_upd_general`/`_upd_dispensa`: mismo problema. `_upd_general` permite
--        cualquier destino salvo `'dispensado'` (incluye `'superseded'`, sin tocar `resuelto_por`);
--        `_upd_dispensa` no restringe destino en absoluto. Ninguna de las dos tiene una hermana que
--        sirva de escape para "superseder sin resolver" — HOY son código muerto (cero UPDATE de
--        producción sobre `pendiente_cierre`, verificado: sólo existe el `INSERT` de
--        `backfillDocumentoIngerido`), pero condicionar el check ahora, en vez de descubrir el mismo
--        bug de `cierre_periodo_upd_cierre` cuando alguien implemente el primer `UPDATE` real, es más
--        barato que dejarlo para entonces.
--    La condición NUNCA debilita R44: forjar la autoría de OTRO usuario (`resuelto_por`/
--    `confirmado_por` = un uuid ajeno, no nulo) sigue muriendo siempre — es exactamente lo que prueba
--    el eje 1 de la mutación. Lo único que la condición permite de más es dejar la columna en `null`/
--    sin tocar, que no atribuye nada a nadie.
-- 4. **Grant de `UPDATE` nuevo sobre `asiento_propuesto`**: el plan no lo mencionó, pero
--    `confirmarAsiento()` (`escrituras.ts:619-629`, ya en el repo) escribe `confirmado_por`/
--    `confirmado_en` en el mismo `UPDATE` que `asiento_estado` — sin `grant update (confirmado_por,
--    confirmado_en)`, ese `UPDATE` real habría fallado con `42501` el día que se corriera contra esta
--    migración. Agregado acá.
-- 5. **`cierre_transicion`: grant de INSERT acotado a 6 columnas, no a 8.** El plan excluía sólo
--    `hecho_por`; acá se excluyen TAMBIÉN `id` y `ocurrido_en` (mecanismo, no elegibles por quien
--    escribe) — mismo patrón exacto que `padron_manifestacion` (`0021:483-485`, excluye `id`,
--    `manifestado_por` Y `manifestado_en`). Verificado: cero INSERT de producción sobre
--    `cierre_transicion` hoy, así que no hay caller que romper al acotar.
-- 6. 🔴 **Corrección posterior de `security-engineer` + `arquitecto-software`, en paralelo: el check
--    de R44 va en las DOS policies `UPDATE` de CADA una de las tres tablas, no solo en la que gobierna
--    la transición terminal.** El punto 3 de arriba (versión original de esta migración) sólo tocaba
--    `cierre_periodo_upd_cierre` y `asiento_propuesto_upd_confirmar`. El agujero real: las policies
--    permisivas del mismo comando se combinan por `OR` en el `with_check` combinado — así que una
--    hermana que NO restrinja la columna de autoría es una ruta de bypass COMPLETA para esa columna,
--    sin que importe qué tan estricta sea la otra.
--      - `cierre_periodo_upd_operativo` (0027:357-364) NO restringe `confirmado_por` en su propio
--        `with_check` hoy — sólo excluye el destino `cierre_estado in ('confirmado','anulado')`. Y el
--        grant de `UPDATE` sobre `cierre_cliente_periodo` es de TABLA completa (0027:372, sin acotar
--        por columna) — a diferencia de `asiento_propuesto`/`pendiente_cierre`, que sí tienen grants
--        por columna. Sin el check acá, cualquier rol admitido por `_upd_operativo`
--        (`administrativo` incluido, más amplio que `_upd_cierre`) podía escribir `confirmado_por` =
--        un uuid ajeno en una fila TODAVÍA NO terminal — el trigger de `0028` no lo alcanza (sólo
--        actúa sobre filas cuyo estado VIEJO ya es terminal) y `_upd_cierre` tampoco, porque el `OR`
--        deja pasar la fila por `_upd_operativo` igual. Cerrado con el MISMO condicional que
--        `_upd_cierre` (`confirmado_por is null or confirmado_por = app.current_user_id()`): el uso
--        real nunca toca esta columna desde `_upd_operativo` (queda en `null`), así que no cambia
--        ningún caso legítimo.
--      - `asiento_propuesto_upd_general` (0027:769-776) mismo problema, mismo cierre: su `with_check`
--        sólo excluye `asiento_estado <> 'confirmado'`, sin tocar `confirmado_por`/`confirmado_en`.
--        Se agrega `(confirmado_por is null or confirmado_por = app.current_user_id())`.
--      - `pendiente_cierre_upd_general`/`_upd_dispensa` NO necesitaban corrección: el punto 3 ya las
--        condicionaba a las DOS (es el hallazgo que ya traía `security-engineer` antes de esta
--        convocatoria — ninguna de las dos es una hermana "sin check" de la otra).
--    Verificado leyendo el `with_check` real en `0027_cierre_mensual.sql:357` (`cierre_periodo_upd_
--    operativo`) y `:769` (`asiento_propuesto_upd_general`) antes de escribir el `create policy` de
--    abajo — no se asumió la forma.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- CERO conexión al piloto: diseñada y aplicada solo contra LOCAL (el piloto no tiene `membership` real
-- todavía; backfill de usuarios existentes queda pendiente de una convocatoria propia el día que sí).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `usuario_identidad` — tabla puente identidad ↔ membresía (ADR-0006 §2)
-- -----------------------------------------------------------------------------
--
-- SIN los 7 renglones de ADR-0001 §5: no lleva `cliente_id` — es transversal a tenant, mismo plano
-- que `membership`/`membership_historia` (las únicas otras dos tablas `columnaTenant: 'ninguna'` del
-- registro de clasificación). Se aísla por el join a `membership` dentro de cada policy, no por una
-- columna propia.
--
-- SIN policies todavía (van en la sección 3, después de que existan las funciones que citan): create
-- table primero dentro de la misma transacción no expone la tabla a nadie, RLS se activa antes de
-- cualquier grant.
create table usuario_identidad (
  usuario_id      uuid primary key,          -- = membership.user_id = auth.users.id de Supabase
  proveedor       text not null,
  sujeto_externo  text not null,
  activo          boolean not null default true,
  creado_en       timestamptz not null default now(),

  -- Catálogo real (verificado contra el árbitro TS ya commiteado, no contra el texto original del
  -- ADR que decía 'supabase' | 'local'): packages/auth/src/registro.ts:20, ADAPTERS_AUTH.
  constraint usuario_identidad_proveedor_chk
    check (proveedor in ('dev-identidad-fija', 'supabase')),

  constraint uq_usuario_identidad_externo unique (proveedor, sujeto_externo)
);

comment on table usuario_identidad is
  'Puente identidad <-> membresia (ADR-0006 S2). activo=false es el interruptor GLOBAL de P12: una '
  'sola fila corta lectura Y escritura (alcance amplio, S7) sobre TODOS los tenants donde la persona '
  'tuviera membership, via el join que accessible_tenant_ids()/has_role_on() agregan en esta misma '
  'migracion. No confundir con membership.activo=false, que da de baja de UN cliente puntual.';

comment on constraint usuario_identidad_proveedor_chk on usuario_identidad is
  'Catalogo cerrado, arbitro real en TypeScript: ADAPTERS_AUTH (packages/auth/src/registro.ts). El '
  'texto original del ADR decia supabase|local; se corrigio contra el codigo ya commiteado, 0045.';

comment on column usuario_identidad.sujeto_externo is
  'Email o id de proveedor de una persona de STAFF, N1 (identidad de staff, no dato de cliente/'
  'tercero) pero protegido en logs via CLAVES_SENSIBLES_EXTERNAS (mismo mecanismo que la reserva de '
  '`email`, ADR-0006 S15) porque N1 solo no alcanza para el enmascarado (COLUMNAS_SENSIBLES excluye '
  'N0/N1).';

-- -----------------------------------------------------------------------------
-- 2. Las 4 funciones — `capacidades_de`/`has_capacidad_en` nuevas, `accessible_tenant_ids`/
--    `has_role_on` reescritas con el join a `usuario_identidad` (alcance AMPLIO)
-- -----------------------------------------------------------------------------

-- Sin tabla de mapeo escribible (decisión de ADR-0006 §3, ratificada por `security-engineer`): una
-- tabla sería más flexible, pero es superficie — cualquier grant sobre ella es escalada potencial.
-- IMMUTABLE: función pura sobre el enum, sin estado externo. SIN `else`, a propósito (mismo criterio
-- que toda unión cerrada de este repo): un rol nuevo sin `case` explícito da error ruidoso en vez de
-- degradar en silencio a cero capacidades.
create or replace function app.capacidades_de(rol app.rol_membership) returns text[]
  language sql immutable
  set search_path = pg_catalog, public, app, pg_temp
as $$
  select case rol
    when 'socio'           then array['ver_cliente','revelar_dato_restringido','confirmar_asiento',
                                       'cerrar_periodo','dispensar_pendiente','alta_cuenta_bancaria',
                                       'alta_socio','alta_contraparte','manifestar_padron_completo',
                                       'exportar','administrar_membresias','leer_auditoria',
                                       'imputar_grupo']
    when 'contador'        then array['ver_cliente','revelar_dato_restringido','confirmar_asiento',
                                       'cerrar_periodo','dispensar_pendiente','alta_cuenta_bancaria',
                                       'alta_socio','alta_contraparte','manifestar_padron_completo',
                                       'imputar_grupo']
    when 'administrativo'  then array['ver_cliente','ingestar_extracto']
    when 'auditor'         then array['ver_cliente','revelar_dato_restringido','leer_auditoria']
    when 'admin_plataforma' then array[]::text[]  -- sin membresía en producción (ADR-0006 §8)
    when 'cliente_lectura'  then array[]::text[]  -- sin uso en v1 (ADR-0006 §9)
  end
$$;

comment on function app.capacidades_de(app.rol_membership) is
  'ADR-0006 S3/S7.bis. Capa ADITIVA, puramente informativa para la UI (ocultar/mostrar botones) -- '
  'NUNCA autoriza por si sola. La autorizacion real sigue siendo la policy SQL de cada tabla '
  '(has_role_on). imputar_grupo (S7.bis) agregada a socio/contador: autorar una regla de '
  'clasificacion que rige movimientos futuros es un riesgo mas parecido a regla_imputacion que a un '
  'asiento puntual, distinto de confirmar_asiento/dispensar_pendiente.';

-- SECURITY DEFINER + search_path fijo, mismo argumento exacto que accessible_tenant_ids/has_role_on
-- (0015): sin DEFINER hay recursion de policies; sin search_path fijo, DEFINER es escalada de
-- privilegios esperando un esquema plantado en el path.
create or replace function app.has_capacidad_en(nodo uuid, capacidad text) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
  select exists (
    select 1
    from public.membership m
    join public.usuario_identidad u on u.usuario_id = m.user_id and u.activo
    join public.tenant_node mn on mn.id = m.tenant_node_id
    join public.tenant_node tn on tn.id = nodo
    where m.user_id = app.current_user_id()
      and m.activo
      and capacidad = any(app.capacidades_de(m.rol))
      and (tn.path = mn.path or tn.path like mn.path || '.%')
  )
$$;

comment on function app.has_capacidad_en(uuid, text) is
  'ADR-0006 S3. Primer consumidor real: usuario_identidad_upd/_ins (administrar_membresias) -- sin '
  'el, la capa de capacidades finas nace muerta. NUNCA usada para ocultar botones de MAS peso que la '
  'policy real: mostrar de mas se rechaza con 42501/0 filas, mostrar de menos es un bug de UX.';

-- 🔴 EL VECTOR PRINCIPAL (0015). Se preserva el endurecimiento íntegro (search_path fijo con
-- pg_catalog primero y pg_temp último, toda tabla calificada por esquema) y se agrega el JOIN a
-- usuario_identidad -- ALCANCE AMPLIO (decisión del titular, P12): una identidad desactivada pierde
-- el conjunto de tenants accesibles enteros, no solo la escritura.
create or replace function app.accessible_tenant_ids() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
  select distinct d.id
  from public.membership m
  join public.usuario_identidad u on u.usuario_id = m.user_id and u.activo
  join public.tenant_node n on n.id = m.tenant_node_id
  join public.tenant_node d on d.path = n.path or d.path like n.path || '.%'
  where m.user_id = app.current_user_id()
    and m.activo
    and n.deleted_at is null
    and d.deleted_at is null
$$;

comment on function app.accessible_tenant_ids() is
  '0045 (ADR-0006 S2/S7, alcance AMPLIO -- P12): agrega join usuario_identidad u on u.usuario_id = '
  'm.user_id and u.activo sobre la version endurecida de 0015 (search_path pg_catalog,public,app,'
  'pg_temp; toda tabla calificada). usuario_identidad.activo=false vacia el conjunto entero: una '
  'identidad desactivada no ve NINGUN tenant, sin importar cuantas membership tenga.';

-- 🔴 EL SEGUNDO VECTOR, Y EL QUE MÁS DUELE (0015): `has_role_on` ES el control de N2-R. Mismo
-- endurecimiento preservado + mismo join. Con alcance amplio, una identidad desactivada pierde
-- también TODA policy de escritura gateada por rol -- que es la mayoría de las de Capa D.
create or replace function app.has_role_on(nodo_objetivo uuid, roles app.rol_membership[])
  returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
  select exists (
    select 1
    from public.membership m
    join public.usuario_identidad u on u.usuario_id = m.user_id and u.activo
    join public.tenant_node mn on mn.id = m.tenant_node_id
    join public.tenant_node tn on tn.id = nodo_objetivo
    where m.user_id = app.current_user_id()
      and m.activo
      and m.rol = any(roles)
      and (tn.path = mn.path or tn.path like mn.path || '.%')
  )
$$;

comment on function app.has_role_on(uuid, app.rol_membership[]) is
  '0045 (ADR-0006 S2/S7, alcance AMPLIO -- P12): agrega join usuario_identidad, mismo criterio que '
  'accessible_tenant_ids(). Es el hallazgo real de esta migracion: el ADR solo nombraba '
  'accessible_tenant_ids()/has_capacidad_en() para la baja de una persona -- sin extender esta '
  'funcion tambien, una baja bloqueaba lectura pero NO escritura (~109 policies de escritura '
  'gateadas por has_role_on siguen abiertas). Corte completo, no parcial.';

-- -----------------------------------------------------------------------------
-- 3. RLS + policies + grants de `usuario_identidad` — ahora que existen las funciones que citan
-- -----------------------------------------------------------------------------

alter table usuario_identidad enable row level security;
alter table usuario_identidad force  row level security;

create policy usuario_identidad_sel on usuario_identidad for select
  using ( exists (
    select 1 from membership m
     where m.user_id = usuario_identidad.usuario_id
       and m.tenant_node_id in (select app.accessible_tenant_ids())
       and app.has_capacidad_en(m.tenant_node_id, 'administrar_membresias')
  ) );

create policy usuario_identidad_ins on usuario_identidad for insert
  with check ( exists (
    select 1 from membership m
     where m.user_id = usuario_identidad.usuario_id
       and m.tenant_node_id in (select app.accessible_tenant_ids())
       and app.has_capacidad_en(m.tenant_node_id, 'administrar_membresias')
  ) );

-- `with check` repite el mismo predicado que `using` -- R4/R5 (catalogo.test.ts) exigen que TODO
-- with_check use el patrón canónico y ninguno quede abierto con `true`; "el column-grant ya alcanza"
-- no es excepción a esas dos reglas. El control real de "solo `activo` es escribible" lo sigue dando el
-- column-grant de abajo -- este predicado es la capa de aislamiento, no la de qué columna.
create policy usuario_identidad_upd on usuario_identidad for update
  using ( exists (
    select 1 from membership m
     where m.user_id = usuario_identidad.usuario_id
       and m.tenant_node_id in (select app.accessible_tenant_ids())
       and app.has_capacidad_en(m.tenant_node_id, 'administrar_membresias')
  ) )
  with check ( exists (
    select 1 from membership m
     where m.user_id = usuario_identidad.usuario_id
       and m.tenant_node_id in (select app.accessible_tenant_ids())
       and app.has_capacidad_en(m.tenant_node_id, 'administrar_membresias')
  ) );

-- Sin DELETE para nadie: una identidad no se borra, se desactiva (mismo criterio que `membership`).
grant select, insert on usuario_identidad to app_request;
grant update (activo) on usuario_identidad to app_request;

-- `app_job` (BYPASSRLS) salta las 3 policies de arriba, pero igual necesita el grant de tabla: RLS y
-- privilegios son capas separadas. Mismo caso que `alta_estudio` ya resuelve para `membership` (`conJob`,
-- 0019:136-141) -- el alta del primer usuario de un estudio no puede depender de que ya exista una
-- membresía previa con capacidad `administrar_membresias` (la policy `_ins` de arriba sí lo exige, por
-- eso el bootstrap tiene que pasar por acá, no por `app_request`).
--
-- 🔴 Corrección de `dba-data` sobre el grant intermedio: SIN `update`. `membership` es el precedente
-- real acá, y `0019:236-237` NO le da a `app_job` un `update` de tabla entera -- lo acota a
-- `update (activo)`, y ese acotamiento tiene su propio motivo escrito ahí. Para `usuario_identidad`
-- verificado (grep del repo entero): CERO callers hacen `update usuario_identidad` desde `conJob` hoy
-- -- ni la siembra sintética, ni ningún motivo de job existente. Dar `update` sin columna acotada acá
-- sería más ancho que el propio precedente que este comentario cita, y contradice el argumento de P12
-- ya escrito en el comentario de la tabla ("baja de una persona = un solo comando", vía
-- `administrar_membresias`/`app_request`, nunca un job). Si un job legítimo necesita tocar `activo`
-- el día de mañana, se agrega ahí (`grant update (activo) on usuario_identidad to app_job`), con su
-- propio motivo -- no antes.
grant select, insert on usuario_identidad to app_job;

revoke all on function app.capacidades_de(app.rol_membership) from public;
revoke all on function app.has_capacidad_en(uuid, text) from public;
grant execute on function app.capacidades_de(app.rol_membership) to app_request, app_job;
grant execute on function app.has_capacidad_en(uuid, text)       to app_request, app_job;

-- -----------------------------------------------------------------------------
-- 4. R44 — toda columna de autoría (`*_por`) atada a `app.current_user_id()` real de sesión
-- -----------------------------------------------------------------------------

-- --- 4.1 `cierre_transicion.hecho_por` — INSERT-solo, append-only, CERO callers hoy ---------------
--
-- Mismo patrón que `padron_manifestacion.manifestado_por` (0021): DEFAULT + revoke/grant de columna,
-- nunca una policy (no hace falta, sin UPDATE posible sobre esta tabla). `id`/`ocurrido_en` TAMBIÉN
-- quedan fuera del grant (mecanismo, no elegibles) -- corrección de dba-data sobre el plan, ver
-- encabezado punto 5.
alter table cierre_transicion alter column hecho_por set default app.current_user_id();

revoke insert on cierre_transicion from app_request;
grant insert (cliente_id, cierre_id, estado_desde, estado_hasta, motivo, hecho_via)
  on cierre_transicion to app_request;

comment on column cierre_transicion.hecho_por is
  'R44 (0045): NOT NULL con DEFAULT app.current_user_id(), sin grant -- no elegible por quien '
  'escribe. Mismo mecanismo que padron_manifestacion.manifestado_por (0021).';

-- --- 4.2 `cierre_cliente_periodo_upd_cierre.confirmado_por` — gobierna CONFIRMAR y ANULAR ---------
--
-- Condicionado (ver corrección 3 del encabezado): anular dejar confirmado_por/en en null, y esta
-- policy es la ÚNICA que permite ese destino (cierre_periodo_upd_operativo lo excluye explícito).
-- Igualdad ciega habría roto la transición de anular.
drop policy cierre_periodo_upd_cierre on cierre_cliente_periodo;
create policy cierre_periodo_upd_cierre on cierre_cliente_periodo for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[])
               and (confirmado_por is null or confirmado_por = app.current_user_id()) );

comment on policy cierre_periodo_upd_cierre on cierre_cliente_periodo is
  'R44 (0045): confirmado_por, cuando se escribe, tiene que ser app.current_user_id() -- nunca una '
  'identidad declarada. Condicionado (is null or = current_user_id()), no igualdad ciega: esta '
  'policy tambien gobierna ANULAR (confirmado_por se queda en null por el CHECK de coherencia) y es '
  'la unica que permite ese destino -- cierre_periodo_upd_operativo lo excluye. La inmutabilidad '
  'post-terminal sigue viviendo en trg_cierre_periodo_inmutable (0028), sin cambios acá.';

-- Corrección 6 del encabezado (security-engineer + arquitecto-software): `_upd_operativo` es la
-- hermana MÁS AMPLIA (incluye `administrativo`) y hoy no restringe `confirmado_por` en absoluto -- sin
-- este check, el `OR` entre policies permisivas la deja como ruta de bypass completa para esa columna,
-- aun con `_upd_cierre` ya condicionada arriba. Mismo condicional, mismo motivo: el uso real nunca
-- toca esta columna desde acá (queda en `null`), así que no cambia el caso legítimo operativo.
drop policy cierre_periodo_upd_operativo on cierre_cliente_periodo;
create policy cierre_periodo_upd_operativo on cierre_cliente_periodo for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[])
               and cierre_estado not in ('confirmado', 'anulado')
               and (confirmado_por is null or confirmado_por = app.current_user_id()) );

comment on policy cierre_periodo_upd_operativo on cierre_cliente_periodo is
  'R44 (0045), corrección posterior de security-engineer + arquitecto-software: esta policy es la '
  'hermana MÁS AMPLIA de cierre_periodo_upd_cierre (incluye administrativo) y su with_check original '
  '(0027) no restringía confirmado_por -- sin este check era una ruta de bypass completa sobre filas '
  'NO terminales, vía el OR entre policies permisivas. Condicionado igual que _upd_cierre: el uso '
  'real nunca toca esta columna desde acá.';

-- --- 4.3 `pendiente_cierre.resuelto_por` — DOS policies, ambas condicionadas ------------------------
--
-- Mismo condicionamiento que 4.2 y por el mismo motivo estructural: ninguna de las dos tiene una
-- hermana sin el check que sirva de escape para "superseder sin resolver". Hoy CERO UPDATE de
-- producción sobre esta tabla (verificado); se cierra el vector antes de que el primer caller real lo
-- ejercite, no después.
drop policy pendiente_cierre_upd_general on pendiente_cierre;
create policy pendiente_cierre_upd_general on pendiente_cierre for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[])
               and pendiente_estado <> 'dispensado'
               and (resuelto_por is null or resuelto_por = app.current_user_id()) );

drop policy pendiente_cierre_upd_dispensa on pendiente_cierre;
create policy pendiente_cierre_upd_dispensa on pendiente_cierre for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[])
               and (resuelto_por is null or resuelto_por = app.current_user_id()) );

comment on policy pendiente_cierre_upd_general on pendiente_cierre is
  'R44 (0045): resuelto_por, cuando se escribe, tiene que ser app.current_user_id(). Condicionado '
  '(is null or = current_user_id()): esta policy tambien permite superseder (destino <> dispensado) '
  'sin tocar resuelto_por, y no tiene otra policy hermana que sirva de escape para ese caso -- mismo '
  'motivo estructural que cierre_periodo_upd_cierre arriba. La inmutabilidad post-terminal sigue '
  'viviendo en trg_pendiente_cierre_inmutable (0028), sin cambios acá.';

comment on policy pendiente_cierre_upd_dispensa on pendiente_cierre is
  'R44 (0045): mismo motivo y mismo condicionamiento que pendiente_cierre_upd_general -- esta policy '
  'no restringe destino en absoluto, así que también necesita el escape para "superseder sin '
  'resolver". La inmutabilidad post-terminal sigue viviendo en trg_pendiente_cierre_inmutable (0028).';

-- --- 4.4 `confirmacion_grupo_ins.confirmado_por` — INSERT puro, igualdad ciega ---------------------
--
-- Sin fila vieja que preservar (es un INSERT): no hay caso de "no tocar la columna", así que la
-- igualdad ciega del plan original es correcta tal cual. Caller real ya pasa el mismo valor que
-- current_user_id() de la sesión (confirmar-grupo.ts:253,269 -- verificado, no se rompe).
drop policy confirmacion_grupo_ins on confirmacion_grupo;
create policy confirmacion_grupo_ins on confirmacion_grupo for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[])
               and confirmado_por = app.current_user_id() );

comment on policy confirmacion_grupo_ins on confirmacion_grupo is
  'R44 (0045): confirmado_por = app.current_user_id(), igualdad ciega -- INSERT puro, sin fila vieja '
  'que preservar. Precondición bloqueante de ADR-0006 S7.bis antes de otorgarle a app_web el grant '
  'sobre esta tabla: sin este check, un request de browser podría atribuir la confirmación a otra '
  'persona.';

-- --- 4.5 `asiento_propuesto.confirmado_por`/`.confirmado_en` — columnas NUEVAS ---------------------
--
-- `confirmarAsiento()` (escrituras.ts:604-629, ya en el repo) solo cambiaba asiento_estado; ahora deja
-- constancia de quién y cuándo. Verificado antes de aplicar: 0 filas 'confirmado' en local (sin
-- backfill que decidir). Nullable + CHECK de coherencia, mismo patrón que
-- cierre_periodo_confirmacion_chk (0027).
alter table asiento_propuesto
  add column confirmado_por uuid,
  add column confirmado_en  timestamptz;

-- 🔴 Corrección encontrada CORRIENDO la batería de mutación de 0028 (no en el papel): el plan original
-- proponía la MISMA forma bicondicional que `cierre_periodo_confirmacion_chk` (0027) --
-- `(asiento_estado = 'confirmado') = (confirmado_por is not null and ...)`. Eso rompe la transición
-- LEGÍTIMA "superseder un asiento ya confirmado" (D-6, probada en `mutaciones-0028-...test.ts`): al
-- pasar a `asiento_estado = 'superseded'` sin borrar `confirmado_por`/`confirmado_en` (quedan como
-- rastro histórico de quién lo había confirmado antes de la supersesión), el lado izquierdo se vuelve
-- `false` y el derecho sigue `true` -- `23514` en vez de dejar pasar la supersesión. A diferencia de
-- `cierre_cliente_periodo` (solo dos terminales, `confirmado`/`anulado`, SIN supersesión posible),
-- `asiento_propuesto` sí supersede un `confirmado`, así que el invariante real es una IMPLICACIÓN en
-- una sola dirección ("todo asiento confirmado tiene autor"), no una equivalencia: nunca exige que
-- `confirmado_por` vuelva a `null` cuando el estado deja de ser `confirmado`.
alter table asiento_propuesto add constraint asiento_propuesto_confirmacion_chk
  check ( asiento_estado <> 'confirmado' or (confirmado_por is not null and confirmado_en is not null) );

comment on constraint asiento_propuesto_confirmacion_chk on asiento_propuesto is
  'R44 (0045): IMPLICACIÓN de una sola dirección (asiento_estado=confirmado -> autor no nulo), NO la '
  'equivalencia bicondicional de cierre_periodo_confirmacion_chk (0027) -- esa forma rompía superseder '
  'un asiento ya confirmado (confirmado_por/confirmado_en quedan como rastro histórico, no se limpian '
  'al pasar a superseded). Corrección encontrada corriendo mutaciones-0028-...test.ts, no en el papel. '
  'Verificado antes de aplicar: cero filas confirmado sin autor en local -- sin backfill que decidir '
  'acá. Un cliente con historial real (piloto) necesita su propia decisión de backfill antes de '
  'aplicar esta migración ahí.';

-- Grant nuevo -- el plan no lo mencionó, pero confirmarAsiento() ya escribe estas dos columnas en el
-- mismo UPDATE que asiento_estado (escrituras.ts:619-629): sin esto, ese UPDATE real falla con 42501.
grant update (confirmado_por, confirmado_en) on asiento_propuesto to app_request;

-- Igualdad ciega (a diferencia de 4.2/4.3): asiento_propuesto_upd_general excluye explícitamente
-- asiento_estado = 'confirmado' de su propio with_check, así que supersesión (destino 'superseded')
-- pasa por esa policy sin necesitar ésta -- el OR entre policies permisivas la deja igual. No hay
-- caso real donde esta policy sea el único camino para un destino que no sea confirmar.
drop policy asiento_propuesto_upd_confirmar on asiento_propuesto;
create policy asiento_propuesto_upd_confirmar on asiento_propuesto for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[])
               and confirmado_por = app.current_user_id() );

comment on policy asiento_propuesto_upd_confirmar on asiento_propuesto is
  'R44 (0045): confirmado_por = app.current_user_id(), igualdad ciega -- asiento_propuesto_upd_general '
  'excluye asiento_estado=''confirmado'' de su propio with_check, así que supersesión pasa por esa '
  'policy (OR entre permisivas) sin depender de ésta. La inmutabilidad post-terminal sigue viviendo '
  'en trg_asiento_propuesto_inmutable (0028), sin cambios acá.';

-- Corrección 6 del encabezado (security-engineer + arquitecto-software): mismo agujero que
-- cierre_periodo_upd_operativo -- _upd_general es la hermana MÁS AMPLIA (incluye administrativo) y su
-- with_check original (0027) sólo excluía asiento_estado='confirmado', sin tocar confirmado_por.
-- Condicionado (no igualdad ciega): supersesión pasa por acá dejando la columna en null, uso legítimo
-- intacto.
drop policy asiento_propuesto_upd_general on asiento_propuesto;
create policy asiento_propuesto_upd_general on asiento_propuesto for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[])
               and asiento_estado <> 'confirmado'
               and (confirmado_por is null or confirmado_por = app.current_user_id()) );

comment on policy asiento_propuesto_upd_general on asiento_propuesto is
  'R44 (0045), corrección posterior de security-engineer + arquitecto-software: hermana MÁS AMPLIA de '
  'asiento_propuesto_upd_confirmar (incluye administrativo), su with_check original (0027) no '
  'restringía confirmado_por -- sin este check era ruta de bypass completa sobre filas NO '
  'confirmadas, vía el OR entre policies permisivas. Condicionado igual que _upd_confirmar en su '
  'intención (nunca deja pasar un autor ajeno), pero permite null/self porque este camino no confirma.';

commit;
