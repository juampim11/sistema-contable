-- =============================================================================
-- 0026_catalogo_icbc.sql — da de alta a `icbc` en el catálogo, y SOLO a icbc
--
-- Sexta fila de `banco` (0011 pobló galicia/santander/macro, 0024 agregó bancor, 0025 agregó
-- nacion). Mismo patrón exacto: `on conflict (codigo) do nothing`, nunca `update`; `capacidades` es
-- resumen informativo, NO fuente de verdad (la fuente son los 15 campos de `CAPACIDADES_ICBC` en
-- `packages/ingesta/src/adaptadores/icbc.ts`).
--
-- 🔴 **Por qué recién ahora, y no en 0024/0025.** Mismo criterio ya escrito en esas dos migraciones:
-- el catálogo de bancos NUNCA lista un código sin un adapter real que lo respalde — insertar la fila
-- sin el adapter sería un dato del catálogo que el sistema no puede honrar (`resolverAdaptador` nunca
-- lo encontraría registrado). El adapter de ICBC ya está cerrado (`HANDOFF.md` (123)) — entra con SU
-- migración propia, como las dos anteriores.
--
-- 🔴 **`cadenaDeSaldos: "por_puntos_de_control"`, primera vez que el catálogo declara este valor** —
-- Galicia/Santander/Macro/Bancor/Nación son todos "completa". Es el reflejo directo de lo medido: el
-- documento real de ICBC trae saldo declarado en 5 de 9 filas de movimiento, sin patrón de intervalo
-- fijo (`docs/diseno/22-formato-icbc.md` §H3) — la verificación aritmética ya soporta este caso sin
-- cambios (`verificarAritmetica`, `packages/ingesta/src/verificacion/invariantes.ts`).
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

insert into banco (codigo, nombre, capacidades, activo)
values
  ('icbc', 'INDUSTRIAL AND COMMERCIAL BANK OF CHINA (ARGENTINA) S.A.', '{
     "familiaLayout": "columnas-posicionales",
     "cadenaDeSaldos": "por_puntos_de_control",
     "multiCuenta": false,
     "multiMoneda": false,
     "declaraDestinos": true
   }'::jsonb, true)
on conflict (codigo) do nothing;

commit;
