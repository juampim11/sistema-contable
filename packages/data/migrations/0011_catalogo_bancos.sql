-- =============================================================================
-- 0011_catalogo_bancos.sql — puebla `banco` con los tres códigos ya construidos
--
-- Plan vigente, ítem 6.1 (`cheerful-gathering-feather.md` §"6 · Poblar banco..."). Medido en la sesión
-- que originó el ítem: la base del piloto (`sistema_contable_piloto`) sólo tenía la fila `galicia`,
-- insertada A MANO en una sesión anterior — sin migración, sin seed, sin mecanismo reproducible. Eso
-- es lo que 0004 prometía ("la escritura es del dueño del esquema, un banco nuevo llega con su
-- adapter, no por formulario") y nunca se cumplió. Esta migración lo formaliza para los tres bancos
-- que ya tienen adapter construido y verificado contra archivo real (Galicia, Santander, Macro).
--
-- `banco` es catálogo N0 sin tenant (0004 §1): no lleva `cliente_id`, no lleva RLS, no lleva policy —
-- a propósito, con el test de catálogo que rechaza una `policy using (true)` decorativa. Por eso esta
-- migración NO trae los siete renglones de ADR-0001 §5: esos aplican a tabla de dominio con
-- `cliente_id`, y `banco` es justamente la que no tiene ninguno. La tabla, sus grants (`select` a
-- `app_request` y `app_job`) y su `check` de dominio (`codigo ~ '^[a-z0-9_]{2,32}$'`) ya existen desde
-- 0004; acá sólo se insertan filas.
--
-- `on conflict (codigo) do nothing`, NUNCA `update`: la fila `galicia` del piloto ya existe (insertada
-- a mano) y esta migración tiene que dejarla EXACTAMENTE como está, no reescribirla por detrás de una
-- migración con el dueño del esquema. Medido contra el piloto antes de escribir este archivo
-- (`select codigo, nombre, capacidades, activo from banco` → una sola fila, `codigo='galicia'`,
-- `nombre='BANCO GALICIA'`, `activo=true`) para que los valores de este insert, aunque `on conflict do
-- nothing` los descarte ahí, no inventen un nombre distinto del que ya está en uso.
--
-- ## `capacidades`: resumen informativo, NO fuente de verdad
--
-- La columna es `jsonb not null default '{}'` sin `check`: nada la obliga a coincidir con
-- `CAPACIDADES_GALICIA` / `CAPACIDADES_SANTANDER` / `CAPACIDADES_MACRO` de
-- `packages/ingesta/src/adaptadores/*.ts`, que son las 14 capacidades completas y sí gobiernan el
-- parseo. Acá entran sólo los cinco campos más legibles para quien mire la tabla sin abrir el código
-- (`familiaLayout`, `cadenaDeSaldos`, `multiCuenta`, `multiMoneda`, `declaraDestinos`) — un resumen para
-- orientarse, no un espejo. Si en algún momento hace falta decidir algo a partir de una capacidad, la
-- fuente es el adapter en TypeScript, nunca esta columna.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

insert into banco (codigo, nombre, capacidades, activo)
values
  ('galicia', 'BANCO GALICIA', '{
     "familiaLayout": "columnas-posicionales",
     "cadenaDeSaldos": "completa",
     "multiCuenta": false,
     "multiMoneda": false,
     "declaraDestinos": true
   }'::jsonb, true),
  ('santander', 'BANCO SANTANDER', '{
     "familiaLayout": "columnas-posicionales",
     "cadenaDeSaldos": "completa",
     "multiCuenta": true,
     "multiMoneda": true,
     "declaraDestinos": true
   }'::jsonb, true),
  ('macro', 'BANCO MACRO', '{
     "familiaLayout": "columnas-posicionales",
     "cadenaDeSaldos": "completa",
     "multiCuenta": true,
     "multiMoneda": true,
     "declaraDestinos": true
   }'::jsonb, true)
on conflict (codigo) do nothing;

comment on column banco.capacidades is
  'Resumen informativo (familiaLayout, cadenaDeSaldos, multiCuenta, multiMoneda, declaraDestinos). '
  'NO es fuente de verdad y no está sincronizado por ningún check: la fuente de verdad de las 14 '
  'capacidades es CAPACIDADES_<BANCO> en packages/ingesta/src/adaptadores/*.ts. Poblada por primera '
  'vez en 0011_catalogo_bancos.sql. Es catálogo N0 del PRODUCTO (qué publica el banco como formato), '
  'nunca del cliente: prohibido agregar acá un ejemplo con datos reales de un extracto (CUIT, CBU, '
  'nombre de contraparte, importe) — la clasificación N0 de esta columna asume que su contenido es '
  'exclusivamente metadata del layout, y un ejemplo real la convertiría en una fuga clasificada como '
  'pública (seguridad-datos-financieros, revisión de 0011).';

commit;
