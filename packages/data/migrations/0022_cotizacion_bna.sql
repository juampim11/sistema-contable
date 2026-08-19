-- =============================================================================
-- 0022_cotizacion_bna.sql — caché de cotización BNA comprador/vendedor por moneda y fecha
--
-- Plan de diseño con los cuatro dictámenes que lo sostienen: `docs/diseno/12-cotizacion-bna-plan.md`.
-- Primer paso de ese plan: SOLO esquema + adapter, sin comando que escriba filas todavía (§5). La
-- lógica de valuación en el motor de contabilidad es una etapa posterior y separada, con su propia
-- convocatoria a `contador-dominio` + `motor-conciliacion-contable` (§4).
--
-- ## Por qué sin RLS, mismo patrón que `banco` (0004)
--
-- La cotización oficial del Banco Nación es idéntica para los tres clientes del piloto: no hay
-- ningún dato de nadie en esta tabla, solo el tipo de cambio publicado. `columnaTenant: 'ninguna'`
-- con motivo explícito en `packages/shared/src/seguridad/clasificacion-campos.ts`, y la excepción
-- documentada en `packages/data/tests/catalogo.test.ts` (`SIN_RLS_CON_MOTIVO`) — mismo mecanismo
-- que ya existe para `banco`, no uno nuevo. Confirmado por `seguridad-datos-financieros`.
--
-- ## Por qué los grants van acotados por columna, y no por tabla entera
--
-- `security-engineer` señaló el precedente (R19, `ADR-0002-seguridad.md` §B.2): un `grant` de tabla
-- entera es el error que ya costó incidentes con `membership`/`acceso_auditoria`. Acá:
--   - `app_job` puede `insert`/`update` el VALOR cacheado (`compra`, `venta`, `fuente`) — es quien
--     corre `conJob('cargar_cotizaciones')` — pero nunca la identidad de la fila: `moneda` y `fecha`
--     son la PK y no se reescriben una vez insertadas (un `update` de la PK sería, de hecho, otra
--     fila). `created_at` tampoco es de `app_job`: la pone el `default now()` del propio insert.
--   - `app_job` NO tiene `select`: el job escribe, no lee de vuelta. Quien consulta la cotización
--     para valuar (etapa posterior) lo hace con `app_request`, sujeto al camino normal.
--   - `app_request` solo `select`: ninguna operación de la aplicación en nombre de un cliente
--     escribe esta tabla — la cotización oficial no es algo que un cliente pueda alterar.
--
-- ## Escala numérica: MEDIDA, no estimada
--
-- `dba-data` señaló que `numeric(12,4)` era razonable pero no verificado. Se midió contra la serie
-- COMPLETA de `api.argentinadatos.com` (5707 registros, 2011-2026): máximo 2 decimales publicados en
-- todo el histórico. `numeric(12,4)` queda con margen — no es una estimación sin medir (mismo método
-- que P0 de `0021`: medir contra el dato real antes de cerrar el DDL).
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

create table cotizacion_bna (
  moneda      char(3) not null,
  fecha       date not null,
  compra      numeric(12,4) not null,
  venta       numeric(12,4) not null,
  fuente      text not null default 'argentinadatos',
  created_at  timestamptz not null default now(),

  primary key (moneda, fecha),
  constraint cotizacion_bna_montos_chk check (compra > 0 and venta > 0 and venta >= compra)
);

comment on table cotizacion_bna is
  'Caché de cotización BNA comprador/vendedor por moneda y fecha. Catálogo N0 sin tenant: la '
  'cotización oficial es idéntica para todos los clientes, sin dato de nadie. Se escribe por '
  'conJob(''cargar_cotizaciones''); el comando y el consumo del motor son pasos posteriores '
  '(docs/diseno/12-cotizacion-bna-plan.md).';

grant insert (moneda, fecha, compra, venta, fuente) on cotizacion_bna to app_job;
grant update (compra, venta, fuente) on cotizacion_bna to app_job;
grant select on cotizacion_bna to app_request;
