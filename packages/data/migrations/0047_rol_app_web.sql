-- =============================================================================
-- 0047_rol_app_web.sql — rol de solo lectura para `apps/web` (ADR-0006 §5)
--
-- Primer paso estructural de la Tanda 4: un rol de Postgres cuyo privilegio efectivo, verificado
-- contra el catálogo real, es "la web solo puede leer lo que le corresponde" -- no disciplina de
-- código. `docs/arquitectura/ADR-0006-autenticacion.md` §5 lo diseña; esta migración corrige tres
-- puntos del fragmento SQL literal de ese §5, encontrados en la convocatoria real (`dba-data` +
-- `security-engineer` + `seguridad-datos-financieros`, en paralelo, más una corrección de alcance del
-- titular sobre el resultado):
--
-- 1. **`grant usage on schema app to app_web` faltaba.** Sin `USAGE` sobre el schema, ningún
--    `grant execute` alcanza (Postgres lo exige además del privilegio sobre la función).
-- 2. **El `SELECT` NO es "todo lo que lee `app_request` menos 4 columnas".** Es una lista angosta y
--    explícita de tablas, cada una justificada por una consulta real ya escrita -- mismo criterio que
--    el propio §7.bis del ADR ya aplica a la escritura ("cada tabla nueva es su propia enmienda").
--    Justificación tabla por tabla, trazada contra el código real (no por analogía):
--      - `tenant_node`, `membership`: resolución de cliente/rol, todo camino las necesita.
--      - `cuenta_bancaria`, `cuenta_bancaria_identificador` (sin `numero`, N2R), `lote_ingesta`,
--        `movimiento_bancario_crudo`: pasos 2-3 del wizard (subir extracto, resumen de la extracción).
--      - `reconocimiento_movimiento`: `agruparDecisionesPendientes()`
--        (`packages/ingesta/src/cierre/agrupar-decisiones-pendientes.ts:353-392`, Frente 1) la lee
--        directo para los pasos 4-5 (procesar/revisar). Sin columna de riesgo
--        (`clasificacion-campos.ts:844-847`: "ninguna columna N2-R, a propósito").
--      - `cuenta_atributo` (sin `respaldo` ni `padron_socio_id`): `leerPlanDeCuentasCompleto()`
--        (`packages/data/src/cierre/lecturas.ts:426-441`, el selector de cuenta contable real que usa
--        `confirmar-grupo.ts:199` para el paso de imputar) selecciona exactamente
--        `cuenta_id,codigo,denominacion,rol_funcional,activa,vigente_desde,vigente_hasta` -- ninguna de
--        las dos columnas de riesgo real de esa tabla (`respaldo`: mismo patrón H1 sin CHECK que
--        `regla_imputacion.respaldo`; `padron_socio_id`: N2, seudónimo de un socio). Se resuelve con el
--        MISMO mecanismo de exclusión por columna que las 4 del ADR, no con una decisión nueva de
--        aceptar H1 para toda la tabla.
--      - `asiento_propuesto`, `asiento_propuesto_renglon`, `asiento_propuesto_totales` (vista
--        `security_invoker`, `0027_cierre_mensual.sql:894`): paso 6 (generar asiento).
--    `cuenta` (identidad base del plan de cuentas) queda AFUERA a propósito: ni
--    `agruparDecisionesPendientes()` ni `leerPlanDeCuentasCompleto()` la tocan -- `codigo`/
--    `denominacion` ya viven desnormalizados en `cuenta_atributo`.
--    TODO grant de esta migración es por columna explícita, incluso en las tablas sin exclusión --
--    nunca `grant select on tabla`, mismo criterio que R41b de `grants-conjunto-cerrado.test.ts` ya
--    exige para que una columna N2R/N3 futura no se filtre en silencio por un grant de tabla completa.
-- 3. **`grant execute` en 4 funciones, no las 6 de `app_job`.** `app.current_user_id()`,
--    `app.accessible_tenant_ids()`, `app.has_role_on()`, `app.has_capacidad_en()` (RLS + la consulta de
--    conveniencia de §3 del ADR, "nunca para autorizar"). NO `verificar_coherencia_path()` ni
--    `reparentar_nodo()` -- exclusivas de `app_job`, sin consumidor de negocio en `app_web`.
--
-- Alcance de ESTA migración, explícito: SOLO §5 (lectura). §7.bis (escritura sobre
-- `confirmacion_grupo` + capacidad `imputar_grupo`) sigue bloqueado -- sus dos precondiciones no están
-- cumplidas (el guard `RE_POSIBLE_DOCUMENTO_EN_TEXTO` sigue en `apps/cli/src/confirmar-grupo.ts`, no
-- adentro de `confirmarGrupo()`, verificado contra el código real). Es tarea aparte.
--
-- `app_web` nace `nologin`, igual que `app_request` -- mismo perfil mínimo, sin `bypassrls`, sin
-- `createrole`. No se crea acá ningún rol de LOGIN que lo use (local: análogo a `app_request_dev`;
-- Supabase: alta manual en el SQL Editor, mismo método que §13 del ADR) -- el criterio de cierre
-- (verificado contra el catálogo real, no contra este `.sql`) no lo necesita: funciona sobre un rol
-- `nologin` sin que nadie se haya conectado nunca como él, mismo estado que `app_firmador` desde `0002`.
-- Queda nombrado como tarea de `devops`, antes de cablear `DATABASE_URL_APP` en Vercel.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA. NO SE APLICA A `piloto` EN ESTA
-- TAREA (piloto está 4 migraciones atrás -- 0043-0046 pendientes, verificado con `--estado`).
-- =============================================================================

begin;

-- Mismo guard que `app_request`/`app_job` (0001_tenancy.sql:278-289) y `app_firmador`
-- (0002_endurecimiento.sql:46-51): permite crear el rol por adelantado en un entorno real (alta manual
-- previa por un DBA, staging clonado) sin que una re-ejecución reviente con "role already exists".
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_web') then
    create role app_web nologin;
  end if;
end $$;

grant usage on schema app to app_web;

grant execute on function app.current_user_id()                                to app_web;
grant execute on function app.accessible_tenant_ids()                          to app_web;
grant execute on function app.has_role_on(uuid, app.rol_membership[])          to app_web;
grant execute on function app.has_capacidad_en(uuid, text)                     to app_web;

-- -----------------------------------------------------------------------------
-- Pasos 1 (elegir cliente) / navegación de rol
-- -----------------------------------------------------------------------------

-- Sin `nid`, `path` ni `parent_path` (R25: bigint secuencial y sus dos espejos que lo contienen --
-- "NUNCA sale en API, URL ni export", clasificacion-campos.ts:54-74 -- enumeraría la plataforma).
-- Hallazgo real, encontrado por `path-coherente.test.ts` (R36) al correr la suite completa, no por
-- inspección: la primera versión de esta migración las incluía.
grant select (id, parent_id, tipo, nombre, deleted_at, created_at, updated_at)
  on tenant_node to app_web;

grant select (id, user_id, tenant_node_id, rol, activo, created_at)
  on membership to app_web;

-- -----------------------------------------------------------------------------
-- Pasos 2-3 (subir extracto / resumen de la extracción)
-- -----------------------------------------------------------------------------

grant select (id, cliente_id, banco_codigo, moneda, alias, abierta_desde, cerrada_en, created_at,
              cuenta_id)
  on cuenta_bancaria to app_web;

-- Sin `numero` (N2R, ADR-0006 §5): mismo mecanismo que `credencial_fiscal.material_cifrado` en 0002.
grant select (id, cliente_id, cuenta_bancaria_id, tipo_cuenta, cbu_hmac, cbu_ultimos4, vigente_desde,
              vigente_hasta, created_at, pepper_id, moneda, cuit_titular_hmac, cuit_titular_ultimos4)
  on cuenta_bancaria_identificador to app_web;

grant select (id, cliente_id, banco_codigo, adaptador_version, origen, archivo_clave, archivo_hash,
              paginas_declaradas, paginas_sin_texto, filas_leidas, filas_aceptadas, filas_rechazadas,
              estado, motivo_codigo, procesado_por, created_at, motivo_codigo_previo, es_dato_real)
  on lote_ingesta to app_web;

grant select (id, cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha,
              fecha_valor, descripcion, importe, saldo, saldo_es_acreedor, moneda, concepto_codigo,
              referencia_externa, created_at, concepto_banco, concepto_completo,
              concepto_banco_estrategia, pagina_pdf, contraparte_captura, entrada_digest)
  on movimiento_bancario_crudo to app_web;

-- -----------------------------------------------------------------------------
-- Pasos 4-5 (procesar y tipificar / revisar e imputar)
-- -----------------------------------------------------------------------------

grant select (id, cliente_id, movimiento_id, motor_digest, clase, es_propuesta, tipo, concepto,
              polaridad, lado, que_decide, motivo_codigo, via, evidencia_entrada_lexico_id,
              evidencia_caracteres_matcheados, evidencia_hubo_cola, superseded_por,
              recalculo_disponible, created_at, entrada_digest)
  on reconocimiento_movimiento to app_web;

-- Sin `respaldo` ni `padron_socio_id` (riesgo H1 / N2 pseudónimo de socio, ninguno de los dos en el
-- select real de `leerPlanDeCuentasCompleto`): mismo mecanismo de exclusión por columna que el ADR.
grant select (id, cliente_id, cuenta_id, codigo, denominacion, nivel, cuenta_padre_id, rol_funcional,
              activa, vigente_desde, vigente_hasta, creada_en)
  on cuenta_atributo to app_web;

-- -----------------------------------------------------------------------------
-- Paso 6 (generar asiento contable)
-- -----------------------------------------------------------------------------

grant select (id, cliente_id, cierre_id, tipo, fecha_imputacion, asiento_estado, superseded_by_id,
              creado_en, corrige_asiento_id, confirmado_por, confirmado_en)
  on asiento_propuesto to app_web;

grant select (id, cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion,
              fuente_cierre_id, referencia_origen, verificacion_heredada, padron_manifestacion_id,
              valuacion_ref, creado_en, padron_contraparte_id)
  on asiento_propuesto_renglon to app_web;

grant select (cliente_id, asiento_id, total_debe, total_haber)
  on asiento_propuesto_totales to app_web;

-- -----------------------------------------------------------------------------
-- Rastro -- append-only, mismo patrón que `app_request` (0001_tenancy.sql:394)
-- -----------------------------------------------------------------------------

-- Mismo listado de columnas que ya usan `app_request`/`app_job` (GRANTS_POR_COLUMNA) -- sin `id` ni
-- `ocurrido_en`, las dos con `default` propio.
grant insert (cliente_id, accion, recurso, recurso_id, motivo, correlacion, user_id)
  on acceso_auditoria to app_web;

commit;
