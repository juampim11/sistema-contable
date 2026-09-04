-- =============================================================================
-- 0036_cuenta_identificador_cuit_titular.sql — B.17: tercer camino de resolución de cuenta,
-- por CUIT del titular, para la tarjeta corporativa que no publica `numero` ni `cbu`
--
-- `docs/diseno/10-deuda-declarada.md` §B.17. `INV-6` (`packages/ingesta/src/resolver-cuenta.ts`)
-- rechaza el lote de tarjeta corporativa de Bracci porque el documento no publica `numero` ni `cbu`
-- en ninguna página legible, en los 3 meses reales medidos. Diseño CERRADO por convocatoria completa
-- de `CLAUDE.md` §3.1 (`dba-data` + `security-engineer` + `seguridad-datos-financieros`, dos rondas:
-- 2026-09-02 sobre el DDL original, 2026-09-03 sobre las dos correcciones cruzadas de abajo). Esta
-- migración es la implementación literal de ese diseño ya cerrado — no se rediseña nada acá.
--
-- ## Qué se agrega
--
-- (a) `moneda`: `cuenta_bancaria_identificador` no tenía columna propia (vivía solo en
--     `cuenta_bancaria`/`lote_ingesta_cuenta`). Hace falta ACÁ, duplicada del padre, porque el índice
--     único de (c) vive a este nivel y un titular con tarjeta en dos monedas (ARS y USD, cada una su
--     propia fila de `cuenta_bancaria` — mismo patrón de partir el documento por moneda que ya usa
--     Macro) tiene que poder tener un `cuit_titular_hmac` igual en las dos sin chocar.
-- (b) `cuit_titular_hmac` / `cuit_titular_ultimos4`: el ancla nueva. **`cuit_titular_hmac` se calcula
--     con `hmacDocumento('cuit', valor, clienteId)` — pepper DERIVADO POR CLIENTE, NUNCA
--     `hmacIdentificador()` (pepper global, el mismo régimen que `cbu_hmac`).** Es la corrección
--     central de la segunda ronda de convocatoria, y los tres agentes llegaron al mismo hallazgo por
--     separado: un CBU identifica una cuenta puntual, compartirlo entre dos clientes del estudio es
--     anómalo; un CUIT identifica una PERSONA, que puede legítimamente ser titular en más de un
--     cliente del mismo estudio (un socio o apoderado con tarjeta corporativa en dos empresas
--     distintas). Con pepper global, el mismo CUIT produciría el mismo digest en los dos clientes —
--     la correlación cruzada exacta que `hmacDocumento()` (HKDF por cliente) existe para impedir,
--     documentada en `packages/shared/src/seguridad/hmac-identificador.ts:152-156` y ya usada por
--     `identificador_hmac`/`documento_hmac` (migración `0013`).
-- (c) `numero` pasa a NULLABLE: hoy `NOT NULL`, bloquea el alta de la tarjeta corporativa aunque se
--     resuelva INV-6 con el CUIT del titular. `cuenta_ident_numero_no_es_cbu` (migración `0006`,
--     `check (length(regexp_replace(numero, '\D', '', 'g')) <> 22)`) no se toca: Postgres evalúa un
--     `CHECK` como satisfecho cuando el operando es `NULL` (no es `FALSE`), así que sigue vigente
--     sobre cualquier `numero` no nulo sin necesidad de tocarlo.
-- (d) `cuenta_ident_algun_ancla_chk`: al menos un ancla (`numero`, `cbu_hmac` o `cuit_titular_hmac`)
--     tiene que estar presente — relajar `numero` a nullable sin este check dejaría una fila sin
--     ningún dato contra el que `resolverCuentaDelExtracto` pueda matchear jamás.
-- (e) `cuenta_ident_cuit_titular_solo_tarjeta_chk`: `cuit_titular_hmac` solo tiene sentido para
--     `tipo_cuenta = 'tarjeta_corporativa'` — una cuenta corriente o caja de ahorro se identifica por
--     `numero`/`cbu`, nunca por el CUIT de su titular.
-- (f) `uq_cuenta_ident_cuit_titular_vigente`: unicidad parcial (solo vigentes, `vigente_hasta is
--     null`) por `(cliente_id, pepper_id, cuit_titular_hmac, moneda)` — con `moneda`, no sin ella.
--     **Esta es la segunda corrección cruzada**, de `arquitecto-software` sobre el dictamen original
--     de `dba-data` (que proponía el índice SIN `moneda`): un titular con tarjeta en dos monedas
--     colisionaría consigo mismo sin la columna extra. Con la evidencia de hoy (Bracci: una sola
--     tarjeta corporativa, confirmada contra el corpus completo de los 3 meses reales, sin colisión)
--     el caso de "dos tarjetas distintas con el mismo titular" queda declarado como límite conocido y
--     no resuelto — mismo criterio de "no inventar la regla sin caso real" que ya usa
--     `docs/diseno/10-deuda-declarada.md` en otros puntos. El propio índice único lo protege: si
--     aparece, el ALTA de la segunda tarjeta revienta explícito (`23505`), nunca mezcla en silencio
--     movimientos de dos tarjetas distintas en una sola cuenta.
--
-- ## Verificado por `dba-data`, sentencia por sentencia (segunda ronda de convocatoria)
--
-- Es aditivo puro más una relajación de `NOT NULL`: ningún `check` nuevo puede evaluar `FALSE` sobre
-- una fila existente (`numero` era `NOT NULL` en el 100% de las filas hasta este mismo `ALTER`; las
-- tres columnas nuevas nacen `NULL`/con default en todas). Riesgo de aplicación: bajo.
--
-- ## Qué NO se agrega acá, y por qué (riesgo aceptado, no en silencio)
--
-- El caso "dos tarjetas corporativas distintas con el mismo titular" (dos `cuenta_bancaria_id`
-- legítimamente distintos que compartirían `cuit_titular_hmac` + `moneda`) no tiene regla propia: no
-- hay evidencia de que ocurra hoy, y el índice único de (f) ya lo convierte en un `23505` explícito
-- en vez de en una mezcla silenciosa si alguna vez aparece — que es la garantía mínima que este
-- proyecto exige (CLAUDE.md §1.8), no la respuesta final a ese caso.
--
-- Mismo criterio, mismo nivel de esquema: `altaDeCuentaBancaria` (`packages/data/src/ingesta/
-- escrituras.ts`) no verifica idempotencia si el pedido trae SOLO `numero` (sin `cbu` ni
-- `cuitTitular`) — hoy ningún caller real produce ese caso (el camino de carátula siempre trae
-- `cbu`, el camino de tarjeta siempre trae `cuitTitular`), pero el código no lo impide. Sin caso
-- real que lo ejercite, no se resuelve acá; se declara para que no quede escondido.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

alter table cuenta_bancaria_identificador
  add column moneda char(3) not null default 'ARS';

alter table cuenta_bancaria_identificador
  add constraint cuenta_ident_moneda_chk check (moneda ~ '^[A-Z]{3}$');

comment on column cuenta_bancaria_identificador.moneda is
  'B.17. Duplicada del padre (cuenta_bancaria.moneda) a propósito: la unicidad parcial por CUIT del '
  'titular (uq_cuenta_ident_cuit_titular_vigente) vive a este nivel, y un titular con tarjeta en dos '
  'monedas (dos filas de cuenta_bancaria, mismo patrón que Macro) no tiene que colisionar consigo mismo.';

alter table cuenta_bancaria_identificador
  add column cuit_titular_hmac bytea;

alter table cuenta_bancaria_identificador
  add column cuit_titular_ultimos4 char(4);

alter table cuenta_bancaria_identificador
  add constraint cuenta_ident_cuit_titular_ultimos4_chk
    check (cuit_titular_ultimos4 is null or cuit_titular_ultimos4 ~ '^[0-9]{4}$');

comment on column cuenta_bancaria_identificador.cuit_titular_hmac is
  'B.17. Tercer camino de resolución de INV-6 (tarjeta corporativa sin numero/cbu en la carátula). '
  'hmacDocumento(''cuit'', valor, clienteId) — pepper DERIVADO POR CLIENTE, NUNCA hmacIdentificador() '
  '(pepper global, el régimen de cbu_hmac): un CUIT identifica una PERSONA, que puede legítimamente '
  'ser titular en más de un cliente del mismo estudio, y el pepper global crearía una correlación '
  'cruzada entre clientes que hmacDocumento() existe para impedir (hmac-identificador.ts:152-156).';

alter table cuenta_bancaria_identificador
  alter column numero drop not null;

alter table cuenta_bancaria_identificador
  add constraint cuenta_ident_algun_ancla_chk
    check (numero is not null or cbu_hmac is not null or cuit_titular_hmac is not null);

alter table cuenta_bancaria_identificador
  add constraint cuenta_ident_cuit_titular_solo_tarjeta_chk
    check (cuit_titular_hmac is null or tipo_cuenta = 'tarjeta_corporativa');

-- Unicidad POR CLIENTE (nunca global — CLAUDE.md §1.2) y SOLO ENTRE VIGENTES: un titular puede tener
-- una serie histórica de identificadores no vigentes sin que eso cuente como colisión.
create unique index uq_cuenta_ident_cuit_titular_vigente
  on cuenta_bancaria_identificador (cliente_id, pepper_id, cuit_titular_hmac, moneda)
  where cuit_titular_hmac is not null and vigente_hasta is null;

commit;
