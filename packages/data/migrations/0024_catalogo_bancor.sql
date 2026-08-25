-- =============================================================================
-- 0024_catalogo_bancor.sql — da de alta a `bancor` en el catálogo, y SOLO a bancor
--
-- Cuarta fila de `banco` (0011 pobló galicia/santander/macro). Mismo patrón exacto: `on conflict
-- (codigo) do nothing`, nunca `update`; `capacidades` es resumen informativo, NO fuente de verdad (la
-- fuente son los 14 campos de `CAPACIDADES_BANCOR` en `packages/ingesta/src/adaptadores/bancor.ts`).
--
-- 🔴 **Por qué SOLO bancor, y no las cuatro filas de la ronda de bancos nuevos (BBVA/Bancor/ICBC/
-- Nación).** Criterio de esta ronda, documentado en `HANDOFF.md`: el catálogo de bancos NUNCA lista un
-- código sin un adapter real que lo respalde — insertar la fila sin el adapter sería un dato del
-- catálogo que el sistema no puede honrar (`resolverAdaptador` nunca lo encontraría registrado). BBVA
-- quedó bloqueado (PDF sin capa de texto, `docs/diseno/20-formato-bancor.md` §0); ICBC y Nación no
-- tienen adapter todavía. Cuando cada uno tenga su adapter cerrado, entra con SU migración propia — no
-- se adelanta la fila acá "para no tener que volver".
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

insert into banco (codigo, nombre, capacidades, activo)
values
  ('bancor', 'BANCO DE LA PROVINCIA DE CORDOBA (BANCOR)', '{
     "familiaLayout": "ancho-fijo",
     "cadenaDeSaldos": "completa",
     "multiCuenta": false,
     "multiMoneda": false,
     "declaraDestinos": true
   }'::jsonb, true)
on conflict (codigo) do nothing;

commit;
