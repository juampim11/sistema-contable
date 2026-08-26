-- =============================================================================
-- 0025_catalogo_nacion.sql — da de alta a `nacion` en el catálogo, y SOLO a nacion
--
-- Quinta fila de `banco` (0011 pobló galicia/santander/macro, 0024 agregó bancor). Mismo patrón
-- exacto: `on conflict (codigo) do nothing`, nunca `update`; `capacidades` es resumen informativo, NO
-- fuente de verdad (la fuente son los 15 campos de `CAPACIDADES_NACION` en
-- `packages/ingesta/src/adaptadores/nacion.ts`).
--
-- 🔴 **Por qué SOLO nacion, y no también ICBC.** Mismo criterio ya escrito en `0024`: el catálogo de
-- bancos NUNCA lista un código sin un adapter real que lo respalde — insertar la fila sin el adapter
-- sería un dato del catálogo que el sistema no puede honrar (`resolverAdaptador` nunca lo encontraría
-- registrado). El adapter de Nación ya está cerrado (`HANDOFF.md` (121)); ICBC todavía no tiene el
-- suyo. Cuando lo tenga, entra con SU migración propia.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

insert into banco (codigo, nombre, capacidades, activo)
values
  ('nacion', 'BANCO DE LA NACION ARGENTINA', '{
     "familiaLayout": "columnas-posicionales",
     "cadenaDeSaldos": "completa",
     "multiCuenta": false,
     "multiMoneda": false,
     "declaraDestinos": true
   }'::jsonb, true)
on conflict (codigo) do nothing;

commit;
