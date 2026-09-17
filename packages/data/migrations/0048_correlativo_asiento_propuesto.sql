-- =============================================================================
-- 0048_correlativo_asiento_propuesto.sql — implementación de ADR-0007: número correlativo del
-- Libro Diario por cliente + FK de trazabilidad movimiento_bancario↔renglón, reemplazando
-- `referencia_origen` (texto libre, sin integridad referencial).
--
-- Convocatoria formal de IMPLEMENTACIÓN (CLAUDE.md §3.1/§3.2), separada de la convocatoria de
-- DISEÑO que ya cerró `docs/arquitectura/ADR-0007-modelo-datos-asiento-contable.md` con 5 agentes
-- (contador-dominio, arquitecto-software, dba-data, security-engineer, seguridad-datos-financieros).
-- Esta migración es la "Forma de la migración propuesta" de ese ADR, verificada en vivo contra
-- Postgres local antes de darse por cerrada — no una transcripción ciega del diseño.
--
-- ## 🔴 El punto crítico del ADR, MEDIDO en vivo, con un resultado DISTINTO al esperado
--
-- El ADR (§3, `security-engineer`) predijo: "No hace falta SECURITY DEFINER nuevo... grant directo
-- select, update (siguiente_numero) a app_request, invoker, dentro de RLS normal" — a diferencia de
-- `0041_manifestacion_vigente_al_citar.sql`, donde `app_request` no tenía NINGÚN privilegio de
-- UPDATE sobre `padron_manifestacion` y el `SELECT ... FOR UPDATE` moría con `42501` antes de tocar
-- una sola policy.
--
-- Reproducido en vivo (`set role app_request` + `set_config('app.user_id', ...)`, tabla de prueba
-- con la MISMA forma: RLS forzada, policy de SELECT sola, `grant select, update (siguiente_numero)`):
-- el `42501` de ACL **no ocurre** — el grant de columna alcanza para la verificación de privilegio
-- que Postgres exige antes de tomar el lock de `FOR UPDATE`. Hasta acá, el ADR acertó.
--
-- Pero apareció un obstáculo DISTINTO, no anticipado por ningún agente de la convocatoria de diseño:
-- con SOLO la policy de SELECT, `SELECT ... FOR UPDATE` devuelve **0 filas, sin ningún error** —
-- no un `42501`, un resultado vacío indistinguible de "no existe esa fila". Motivo (verificado
-- consultando el comportamiento real, no de memoria): Postgres exige que la fila pase, ADEMÁS de las
-- policies de `SELECT` aplicables, las policies de **UPDATE** (o `ALL`) aplicables para ese rol —
-- aunque la sentencia sea un `SELECT` puro, el marcador de fila (`FOR UPDATE`/`FOR SHARE`) activa esa
-- segunda evaluación. Sin ninguna policy de UPDATE, el conjunto de policies de UPDATE aplicables es
-- vacío, y row security con conjunto vacío de policies para un comando es DENY, no un no-op —
-- exactamente el mismo "RLS-vacío-es-deny" que ya rige INSERT/UPDATE en el resto del esquema, pero
-- que ningún agente de la convocatoria de diseño había extendido a este caso concreto de
-- `SELECT...FOR UPDATE` sin policy de UPDATE.
--
-- Verificado el remedio, en la misma sesión: agregando una policy `FOR UPDATE` (aun con `using
-- (true)` en la prueba mínima), la fila aparece bajo `FOR UPDATE` sin tocar el grant. Con eso,
-- **NO hace falta `SECURITY DEFINER`** — el ADR tenía razón en la conclusión, pero por un motivo
-- adicional al que anticipó: hace falta el grant de columna (ACL) **Y** una policy de UPDATE (RLS),
-- las dos cosas, ninguna alcanza sola. Esta migración agrega la policy de UPDATE que el punto 1 del
-- ADR no incluía (solo mencionaba "policy de select estándar").
--
-- ## Diseño final de `asiento_correlativo_cliente`, con el hallazgo incorporado
--
-- Los siete renglones de ADR-0001 §5, con el desvío puntual YA documentado por el ADR: `cliente_id
-- uuid primary key` en vez de `id uuid` + `unique(cliente_id, id)` — una fila por cliente, nada más
-- la referencia por FK (mismo criterio que `0027` usa para sus propios desvíos puntuales). El renglón
-- (2) de la plantilla ("índice por cliente_id") ya lo da la PK misma: no hace falta un índice aparte.
-- Renglón (6): policy de SELECT estándar. Renglón (6-bis, el hallazgo de arriba): policy de UPDATE,
-- restringida a `socio`/`contador` — el único camino real que toca esta tabla es el trigger de abajo,
-- disparado exclusivamente por `confirmarAsiento()` (`escrituras.ts:619-629`), que ya exige
-- `socio`/`contador` vía `asiento_propuesto_upd_confirmar` (`0027`) para llegar a esa transición.
-- Renglón (7): `grant select`, `insert (cliente_id)` (columna acotada, no tabla completa — ver
-- corrección de `security-engineer` más abajo), `update (siguiente_numero)`.
--
-- 🔴 CORRECCIÓN AL DISEÑO DEL ADR, MEDIDA EN VIVO, no una preferencia de estilo: el ADR (§3) preveía
-- SOLO `select, update (siguiente_numero)` — la fila nacería del backfill (abajo, para los clientes
-- YA existentes) o de un `conJob('alta_estudio', …)` FUTURO, sin `insert` para `app_request`. Corrida
-- la suite completa de `packages/data` con la migración aplicada tal cual el ADR la describía, DOS
-- tests reales de `mutaciones-0045-usuario-identidad-r44.test.ts` (que crean su propio cliente
-- efímero, sin pasar por ningún alta "oficial") rompieron: uno con el `P0006` de "alta de cliente
-- incompleta" que la primera versión de esta función lanzaba, y el otro — más serio — con el CÓDIGO DE
-- ERROR CAMBIADO: un test que verifica que confirmar con una identidad ajena muere por RLS (`42501`)
-- recibió en cambio `P0006`, porque el trigger de la sección 3 corre ANTES de que Postgres evalúe el
-- `WITH CHECK` de la policy de confirmación (los triggers `BEFORE ROW` se ejecutan antes de que el
-- executor valide la fila propuesta contra RLS) — mi trigger fallaba primero, por un motivo que no
-- tenía nada que ver con la intención real del test.
--
-- La corrección no es cosmética: dado que la ÚNICA función que escribe en esta tabla ya replica el
-- predicado de tenant/rol exacto de esta policy de INSERT (ver la sección 3, `asignar_numero_
-- correlativo_asiento()`), agregar `insert` con la misma policy tenant+rol convierte al trigger en
-- AUTOPROVISOR: `INSERT (cliente_id) ... ON CONFLICT (cliente_id) DO NOTHING` antes del `SELECT ...
-- FOR UPDATE` garantiza que la fila exista SIEMPRE que la transición sea legítima, sin depender de que
-- exista previamente ni de una tarea de aplicación futura. Dos primeras-confirmaciones concurrentes del
-- mismo cliente recién creado se serializan igual: la segunda `INSERT ... ON CONFLICT DO NOTHING` no
-- hace nada (la primera ya insertó), y el `SELECT ... FOR UPDATE` inmediatamente después sigue siendo
-- el punto real de serialización (ver sección 3). Consecuencia positiva, no solo una corrección: el
-- `conJob('alta_estudio', …)` que el ADR §3 preveía como paso OBLIGATORIO pasa a ser un pre-warm
-- OPCIONAL — el mecanismo ya no depende de él para funcionar correctamente.
--
-- 🔴 SEGUNDA CORRECCIÓN, de `security-engineer`, sobre la primera versión de esta autoprovisión: el
-- `insert` de arriba se otorgó primero A NIVEL DE TABLA COMPLETA (`grant select, insert on ...`) —
-- eso le daba a `app_request` privilegio de INSERT sobre TODAS las columnas, incluida
-- `siguiente_numero`, y nada en el esquema le impedía a un `INSERT` de aplicación (fuera de esta
-- función, un bug o un camino no anticipado) escribir `siguiente_numero` con cualquier valor —
-- rompiendo la garantía "arranca en 1" sin pasar por ningún mecanismo de la base. Corregido a `grant
-- insert (cliente_id)`: la única forma de que `siguiente_numero` tome un valor al insertar es su
-- `default 1` — ningún camino de escritura de `app_request` puede pisarlo con un literal.
--
-- ## Por qué `FOR UPDATE` (no `FOR SHARE`) y por qué el trigger dispara solo en la transición real
--
-- Misma lógica que `0041`: dos confirmaciones concurrentes del mismo cliente (asientos DISTINTOS)
-- tienen que serializarse en la fila del contador — `FOR UPDATE` es el lock exclusivo que lo fuerza;
-- `FOR SHARE` dejaría que las dos lean el mismo `siguiente_numero` antes de que cualquiera lo
-- incremente. Verificado en vivo con dos conexiones reales (sección de evidencia al final del
-- archivo, dejada como comentario porque el test de mutación completo lo arma `qa-automation`
-- después, CLAUDE.md §1.8 — acá se deja la reproducción, no el test formal).
--
-- El trigger es `BEFORE UPDATE OF asiento_estado ... WHEN (new.asiento_estado = 'confirmado' and
-- old.asiento_estado is distinct from 'confirmado')`: dispara únicamente cuando la sentencia toca la
-- columna de estado (`confirmarAsiento()` siempre la incluye en el `SET`, verificado contra
-- `escrituras.ts:621-625`) y el valor nuevo es `'confirmado'` viniendo de cualquier otro valor. Como
-- `0028` (`trg_asiento_propuesto_inmutable`) ya bloquea CUALQUIER `UPDATE` cuyo `old.asiento_estado`
-- sea terminal (`confirmado`/`superseded`) salvo la excepción de supersesión, la única forma real de
-- que `old.asiento_estado` sea distinto de `'confirmado'` en este punto es que sea `'propuesto'`
-- (el único no-terminal del dominio) — coincide exactamente con la transición que
-- `confirmarAsiento()` hace (`WHERE ... AND asiento_estado = 'propuesto'`).
--
-- ## Orden de disparo contra los triggers ya existentes de `asiento_propuesto` — confirmado, no supuesto
--
-- Para la sentencia real que confirma un asiento (`UPDATE ... SET asiento_estado='confirmado',
-- confirmado_por=$3, confirmado_en=now() WHERE ... AND asiento_estado='propuesto'`), los triggers
-- `BEFORE ROW` que Postgres evalúa son (alfabético por nombre, verificado: Postgres NO reordena por
-- fecha de creación):
--   1. `trg_asiento_propuesto_cierre_no_terminal` (`0040`) — es `BEFORE INSERT`, no dispara en UPDATE.
--   2. `trg_asiento_propuesto_cliente` (`0027`) — es `BEFORE ... OF cliente_id`; esta sentencia no
--      toca `cliente_id`, no dispara.
--   3. `trg_asiento_propuesto_correlativo` (ESTA migración) — dispara, asigna `numero_correlativo`.
--   4. `trg_asiento_propuesto_inmutable` (`0028`) — dispara (sin `OF`, cualquier UPDATE), pero
--      `old.asiento_estado = 'propuesto'` NO es terminal, así que retorna `new` de inmediato sin
--      mirar `numero_correlativo` ni ninguna otra columna. El orden entre (3) y (4) es, por eso,
--      IRRELEVANTE para esta transición puntual — se deja documentado para que quien audite después
--      no tenga que volver a derivarlo.
--
-- ## `movimiento_bancario_id` — FK compuesta tenant-safe, reemplaza `referencia_origen`
--
-- `(cliente_id, movimiento_bancario_id) references movimiento_bancario_crudo (cliente_id, id)`,
-- NULLABLE (no todo asiento nace de un movimiento — `ajuste_cierre`/`reimputacion` no
-- necesariamente). La FK es construible sin migración previa: `movimiento_bancario_crudo` ya tiene
-- `unique (cliente_id, id)` (`uq_mov_crudo_tenant`, `0004_ingesta.sql:468`).
-- `referencia_origen` NO se dropea acá (dos pasos, ADR-0007 §2/"Forma de la migración propuesta"):
-- queda deprecada, preservada, para poder verificar el backfill antes de eliminarla en una migración
-- posterior. Ningún ajuste de código de aplicación (`escrituras.ts`/`lecturas.ts`) en esta migración
-- — está fuera del alcance pedido para esta tarea (ADR-0007, "Forma de la migración propuesta" punto
-- 5, tarea separada).
--
-- Índice `idx_asiento_renglon_movimiento (cliente_id, movimiento_bancario_id)` — SÍ se agrega, y con
-- su motivo medido (no por hábito de "toda FK compuesta lleva índice": las otras dos FK compuestas de
-- esta misma tabla, `fk_asiento_renglon_fuente` y `fk_asiento_renglon_manifestacion` (`0027`), NO
-- tienen índice dedicado, y `fk_asiento_renglon_cuenta` tampoco — las tres apuntan a tablas
-- (`cuenta`, `fuente_cierre`, `padron_manifestacion`) que NO otorgan `DELETE` a `app_request`,
-- así que el `ON DELETE RESTRICT` de esas FK nunca dispara un chequeo real contra esta tabla).
-- `movimiento_bancario_crudo`, en cambio, SÍ otorga `delete` a `app_request`
-- (`0004_ingesta.sql:502`) — borrar un movimiento bancario crudo obliga a Postgres a verificar que
-- ninguna fila de `asiento_propuesto_renglon` lo referencie antes de permitir el `DELETE`
-- (`ON DELETE RESTRICT`), y sin índice sobre `(cliente_id, movimiento_bancario_id)` esa verificación
-- es un `seq scan` completo de la tabla por cada intento de borrado. Es, además, exactamente la
-- consulta que reemplaza a `CONDICION_SIN_ASIENTO_NI_PENDIENTE_TERMINAL`
-- (`packages/data/src/cierre/lecturas.ts:118-127`, hoy filtrando por `cliente_id, referencia_origen`
-- sin índice dedicado tampoco) el día que ese código migre a la columna nueva — tarea de aplicación
-- separada, no de esta migración.
--
-- ## Backfill de `movimiento_bancario_id` — medido, ninguna fila descartada en silencio
--
-- El `UPDATE` va con una CTE que filtra por forma de UUID ANTES de castear (evita que Postgres
-- intente `::uuid` sobre un valor no-UUID durante la evaluación de un JOIN, donde el orden de
-- evaluación de predicados no está garantizado) y hace JOIN real contra `movimiento_bancario_crudo`
-- (mismo `cliente_id`) para no violar la FK con una referencia rota. Local (verificado antes de
-- escribir este archivo): 2 renglones totales, 0 con `referencia_origen` no nulo — el backfill no
-- tiene nada que hacer hoy en este entorno, y el `RAISE NOTICE` de abajo lo deja loggeado igual, para
-- que en un entorno con datos reales (piloto) el operador vea los tres conteos (total, sin forma de
-- UUID, con forma de UUID pero sin movimiento real) y no asuma "0 backfilleadas" = "nada que
-- revisar" sin mirar el resto de la fila del reporte.
--
-- ## Qué NO hace esta migración, a propósito (ADR-0007, "Qué NO va en esta migración")
--
-- Ninguna tabla puente de consolidación N:1. Ningún cambio a `pendiente_cierre.referencia_origen`
-- (mismo patrón sin FK, declarado pendiente aparte). Ningún `DROP` de `referencia_origen`. Ningún
-- ajuste de `escrituras.ts`/`lecturas.ts` (tarea de aplicación separada). Ningún grant nuevo a
-- `app_web` sobre `numero_correlativo` ni `movimiento_bancario_id` — `0047_rol_app_web.sql` ya
-- documenta el criterio ("grants nuevos necesitan su propia justificación contra una consulta REAL de
-- apps/web") y hoy no existe esa consulta; se agrega cuando la haya, tarea aparte.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `asiento_correlativo_cliente` — el contador por cliente (ADR-0007 §3)
-- -----------------------------------------------------------------------------
create table asiento_correlativo_cliente (
  cliente_id       uuid primary key references tenant_node(id) on delete restrict,   -- (1)(2), ver cabecera
  siguiente_numero integer not null default 1,
  creado_en        timestamptz not null default now(),

  constraint asiento_correlativo_cliente_numero_chk check (siguiente_numero > 0)
);

-- (3)
create trigger trg_asiento_correlativo_cliente_cliente
  before insert or update of cliente_id on asiento_correlativo_cliente
  for each row execute function app.exigir_nodo_cliente();

-- (4)(5)
alter table asiento_correlativo_cliente enable row level security;
alter table asiento_correlativo_cliente force  row level security;

-- (6)
create policy asiento_correlativo_cliente_sel on asiento_correlativo_cliente for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (6-bis) — HALLAZGO de esta migración (ver cabecera): sin esta policy, `SELECT ... FOR UPDATE`
-- devuelve 0 filas para `app_request` EN SILENCIO (no un 42501): Postgres exige policies de UPDATE
-- aplicables, además de las de SELECT, para el lock de fila — conjunto vacío de policies de UPDATE es
-- DENY. Restringida a `socio`/`contador`: el único llamador real (`confirmarAsiento()`) ya exige ese
-- mismo rol para llegar a la transición que dispara el trigger de la sección 3.
create policy asiento_correlativo_cliente_upd on asiento_correlativo_cliente for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

-- INSERT — corrección al diseño del ADR, ver cabecera de la sección: habilita el autoprovisionamiento
-- de la fila la primera vez que un cliente confirma un asiento, sin depender de una tarea de alta
-- futura. Mismo predicado tenant+rol que la policy de UPDATE.
create policy asiento_correlativo_cliente_ins on asiento_correlativo_cliente for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

-- (7) — SIN delete: una vez que un cliente tiene su fila, nunca se borra (append-in-place, solo
-- UPDATE incrementa el contador). INSERT por COLUMNA, solo `cliente_id` — hallazgo de
-- `security-engineer` sobre la primera versión de esta migración: un `grant insert` de tabla completa
-- le habría dado a `app_request` la capacidad de insertar `siguiente_numero` con CUALQUIER valor (por
-- ejemplo un `INSERT` directo desde la aplicación con `siguiente_numero = 999999`, sin pasar por el
-- trigger), lo que rompería la garantía "arranca en 1" sin que ningún mecanismo de la base lo impida.
-- Con `insert (cliente_id)` nada más, `siguiente_numero` SOLO puede tomar su `default 1` — la única
-- forma de hacer que valga otra cosa es el `UPDATE` posterior, que sí está acotado (incrementa desde el
-- valor lockeado, nunca lo pisa con un literal arbitrario).
grant select on asiento_correlativo_cliente to app_request;
grant insert (cliente_id) on asiento_correlativo_cliente to app_request;
grant update (siguiente_numero) on asiento_correlativo_cliente to app_request;

comment on table asiento_correlativo_cliente is
  'ADR-0007 §3: contador de folio del Libro Diario, UNO por cliente (cliente_id es la PK — desvío '
  'puntual documentado del boilerplate id+unique(cliente_id,id), mismo criterio que 0027). Solo lo '
  'toca app.asignar_numero_correlativo_asiento() (trigger de asiento_propuesto), vía INSERT (cliente_id) '
  '...ON CONFLICT DO NOTHING (autoprovisión con siguiente_numero tomando su default 1 — nunca un valor '
  'explícito, grant de columna acotado a propósito, hallazgo de security-engineer) + SELECT...FOR '
  'UPDATE + UPDATE (siguiente_numero), todo bajo policy de socio/contador. Sin delete para app_request.';

comment on column asiento_correlativo_cliente.siguiente_numero is
  'N1, no exportable: mismo tier que numero_correlativo (no revela contenido económico), pero sin '
  'motivo de exportarlo — es un valor interno de mecanismo, nunca "el folio de un asiento real" (eso '
  'es asiento_propuesto.numero_correlativo).';

-- Backfill: una fila por cada cliente YA EXISTENTE, arrancando en 1. Pre-warm, no un requisito duro:
-- el trigger de la sección 3 autoprovisiona la fila igual la primera vez que haga falta (corrección
-- medida al ADR, ver cabecera) — este backfill solo evita esa primera escritura extra para los
-- clientes que ya existen hoy.
insert into asiento_correlativo_cliente (cliente_id, siguiente_numero)
select id, 1
  from tenant_node
 where tipo = 'cliente' and deleted_at is null
on conflict (cliente_id) do nothing;

-- -----------------------------------------------------------------------------
-- 2. `asiento_propuesto.numero_correlativo` — la columna que el trigger de la sección 3 asigna
-- -----------------------------------------------------------------------------
alter table asiento_propuesto add column numero_correlativo integer;

alter table asiento_propuesto add constraint uq_asiento_propuesto_numero
  unique (cliente_id, numero_correlativo);

comment on column asiento_propuesto.numero_correlativo is
  'ADR-0007 §3/§4: folio del Libro Diario, asignado por trg_asiento_propuesto_correlativo SOLO en la '
  'transición propuesto→confirmado. NULL mientras el asiento está propuesto — Postgres excluye NULLs '
  'de un unique normal, así que múltiples propuestas sin confirmar no compiten entre sí. Un asiento '
  'superseded NO libera su número (0028 lo protege como cualquier otra columna post-terminal). N1: no '
  'revela contenido económico por sí solo, mismo tier que corrige_asiento_id (0040). R25 '
  '(ADR-0002-seguridad.md): es POR CLIENTE, nunca global — un secuencial global sería el tercer '
  'miembro de la clase prohibida (tenant_node.nid, acceso_auditoria.id) y, además, nunca podría '
  'mostrarse al contador.';

-- -----------------------------------------------------------------------------
-- 3. El trigger de asignación — dispara SOLO en la transición propuesto→confirmado
-- -----------------------------------------------------------------------------
--
-- Invoker, SIN `security definer`: el hallazgo de esta migración (ver cabecera) es que el grant de
-- columna + la policy de UPDATE de la sección 1 alcanzan para `SELECT...FOR UPDATE` bajo invoker —
-- a diferencia de `0041`, donde `app_request` no tenía NINGÚN privilegio de UPDATE (ni de tabla ni de
-- columna) sobre `padron_manifestacion` y el `42501` ocurría en la capa de ACL, antes de que RLS
-- entrara en juego. R11 (catalogo.test.ts) NO se amplía en esta migración.
create or replace function app.asignar_numero_correlativo_asiento() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_numero integer;
begin
  -- AUTOPROVISIÓN — corrección medida al diseño del ADR, ver cabecera del archivo (sección 1, renglón
  -- 7): garantiza que la fila del contador exista para CUALQUIER cliente que llegue hasta acá, sin
  -- depender de un alta previa. `ON CONFLICT DO NOTHING` hace que sea un no-op si la fila ya existe
  -- (el caso normal: backfill de esta migración, o una confirmación anterior de este mismo cliente).
  -- Sujeta a la policy de INSERT (tenant + socio/contador) — mismo predicado que el resto. SOLO
  -- `cliente_id` en la lista de columnas: el grant de `app_request` es `insert (cliente_id)`, columna
  -- acotada (hallazgo de security-engineer) — `siguiente_numero` NUNCA se escribe con un literal acá,
  -- toma su `default 1` de la definición de la tabla. Escribirlo explícito (aunque fuera con el mismo
  -- valor `1`) exigiría `insert (cliente_id, siguiente_numero)` y el grant no lo permite.
  insert into public.asiento_correlativo_cliente (cliente_id)
  values (new.cliente_id)
  on conflict (cliente_id) do nothing;

  -- LOCK: mismo motivo que 0041 — leer y lockear en el orden inverso reabre la ventana entre dos
  -- confirmaciones concurrentes del mismo cliente (asientos DISTINTOS, o incluso la primera
  -- confirmación de un cliente recién autoprovisionado arriba) que este lock existe para cerrar. FOR
  -- UPDATE, no FOR SHARE: hace falta el lock EXCLUSIVO para que la segunda transacción espere hasta
  -- que la primera incremente y libere, no solo hasta que la primera termine de leer.
  select siguiente_numero into v_numero
    from public.asiento_correlativo_cliente
   where cliente_id = new.cliente_id
     for update;

  if not found then
    -- Guardia defensiva, no un camino esperado: con el INSERT de arriba, esta fila SIEMPRE existe en
    -- este punto (backfilleada, autoprovisionada recién, o de una confirmación anterior). Si algún
    -- día deja de ser así (p. ej. alguien le agrega DELETE a app_request sobre esta tabla, lo que
    -- ADR-0007 nunca contempla), esto falla cerrado con un mensaje explícito en vez de asignar un
    -- folio ambiguo. Interpola cliente_id (N1, uuid interno) — mismo criterio que app.exigir_nodo_
    -- cliente (0001_tenancy.sql). Nunca interpola numero_correlativo ni ninguna columna N2.
    raise exception
      'cliente_id % no tiene fila en asiento_correlativo_cliente después de intentar autoprovisionarla '
      '— esto no debería pasar nunca; revisar si algo le otorgó DELETE a app_request sobre esa tabla',
      new.cliente_id
      using errcode = 'P0006';
  end if;

  update public.asiento_correlativo_cliente
     set siguiente_numero = v_numero + 1
   where cliente_id = new.cliente_id;

  new.numero_correlativo := v_numero;
  return new;
end;
$$;

comment on function app.asignar_numero_correlativo_asiento() is
  'ADR-0007 §3. BEFORE UPDATE OF asiento_estado sobre asiento_propuesto, WHEN propuesto→confirmado. '
  'Invoker (ver cabecera: grant de columna + policies de INSERT/UPDATE de asiento_correlativo_cliente '
  'alcanzan, medido en vivo — a diferencia de 0041, sin SECURITY DEFINER). Autoprovisiona la fila del '
  'contador con INSERT...ON CONFLICT DO NOTHING (corrección medida al ADR, ver cabecera del archivo) '
  'antes del SELECT...FOR UPDATE, que lockea la fila ANTES de leer siguiente_numero (mismo orden que '
  '0041, mismo motivo: cerrar la ventana de carrera entre confirmaciones concurrentes del mismo '
  'cliente). El P0006 queda como guardia defensiva, no como camino esperado.';

create trigger trg_asiento_propuesto_correlativo
  before update of asiento_estado on asiento_propuesto
  for each row
  when (new.asiento_estado = 'confirmado' and old.asiento_estado is distinct from 'confirmado')
  execute function app.asignar_numero_correlativo_asiento();

comment on trigger trg_asiento_propuesto_correlativo on asiento_propuesto is
  'Orden de disparo confirmado contra trg_asiento_propuesto_inmutable (0028) para la transición '
  'propuesto→confirmado: da igual el orden alfabético entre los dos porque 0028 no hace nada cuando '
  'old.asiento_estado no es terminal (ver cabecera de 0048 para el detalle completo). No dispara en '
  'INSERT (trg_asiento_propuesto_cierre_no_terminal, 0040, es la única BEFORE INSERT) ni cuando la '
  'sentencia no toca asiento_estado (OF asiento_estado).';

-- -----------------------------------------------------------------------------
-- 4. `asiento_propuesto_renglon.movimiento_bancario_id` — FK compuesta tenant-safe (ADR-0007 §2)
-- -----------------------------------------------------------------------------
alter table asiento_propuesto_renglon add column movimiento_bancario_id uuid;

alter table asiento_propuesto_renglon add constraint fk_asiento_renglon_movimiento
  foreign key (cliente_id, movimiento_bancario_id)
  references movimiento_bancario_crudo (cliente_id, id)
  on delete restrict;

-- Índice con su motivo medido, ver cabecera: es la única de las cuatro FK de esta tabla cuyo padre
-- otorga `delete` a `app_request` (movimiento_bancario_crudo, 0004:502), así que es la única cuyo
-- `ON DELETE RESTRICT` dispara un chequeo real que un índice acelera.
create index idx_asiento_renglon_movimiento
  on asiento_propuesto_renglon(cliente_id, movimiento_bancario_id);

comment on column asiento_propuesto_renglon.movimiento_bancario_id is
  'ADR-0007 §2/§4/§5: reemplaza referencia_origen (text libre, sin FK) como puntero al movimiento '
  'bancario de origen. Nullable: solo el tipo devengamiento nace siempre de un movimiento; '
  'ajuste_cierre/reimputacion no necesariamente. N1, mismo tier que movimiento_bancario_crudo.id — no '
  'revela contenido. referencia_origen queda deprecada, preservada, NO se dropea en esta migración '
  '(dos pasos: verificar el backfill primero).';

comment on constraint fk_asiento_renglon_movimiento on asiento_propuesto_renglon is
  'FK compuesta tenant-safe: (cliente_id, movimiento_bancario_id) — una FK simple contra solo '
  '.id no respeta RLS de movimiento_bancario_crudo (el chequeo de FK de Postgres corre con el '
  'privilegio del dueño de la tabla, no con RLS). Mismo idioma que fk_asiento_renglon_cuenta/'
  '_fuente/_manifestacion (0027) y 20+ instancias más del esquema desde 0002.';

comment on index idx_asiento_renglon_movimiento is
  'ADR-0007 §5 (dba-data, esta migración): a diferencia de fk_asiento_renglon_cuenta/_fuente/'
  '_manifestacion (0027, sin índice dedicado), movimiento_bancario_crudo SÍ otorga delete a '
  'app_request (0004:502) — sin este índice, el chequeo de ON DELETE RESTRICT al borrar un movimiento '
  'es un seq scan completo de esta tabla. También es la forma que toma la consulta de '
  'CONDICION_SIN_ASIENTO_NI_PENDIENTE_TERMINAL (lecturas.ts:118-127) el día que ese código migre de '
  'referencia_origen a esta columna (tarea de aplicación separada).';

-- Backfill de movimiento_bancario_id desde referencia_origen — medido, nada se descarta en silencio.
-- La CTE filtra por forma de UUID ANTES de castear (Postgres no garantiza el orden de evaluación de
-- predicados dentro de un JOIN, así que castear directo en el WHERE de un UPDATE...FROM podría
-- intentar `::uuid` sobre un valor sin forma de UUID) y el JOIN contra movimiento_bancario_crudo
-- evita violar la FK con una referencia rota: solo se backfillean filas cuyo movimiento REAL existe
-- para ese cliente.
do $$
declare
  v_total           integer;
  v_con_referencia  integer;
  v_sin_forma_uuid  integer;
  v_forma_uuid      integer;
  v_actualizadas    integer;
  v_sin_movimiento  integer;
begin
  select count(*) into v_total from asiento_propuesto_renglon;

  select count(*) into v_con_referencia
    from asiento_propuesto_renglon
   where referencia_origen is not null;

  select count(*) into v_sin_forma_uuid
    from asiento_propuesto_renglon
   where referencia_origen is not null
     and referencia_origen !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  v_forma_uuid := v_con_referencia - v_sin_forma_uuid;

  with candidatas as (
    select id, cliente_id, referencia_origen::uuid as movimiento_id
      from asiento_propuesto_renglon
     where referencia_origen is not null
       and referencia_origen ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  )
  update asiento_propuesto_renglon apr
     set movimiento_bancario_id = c.movimiento_id
    from candidatas c
    join movimiento_bancario_crudo mbc
      on mbc.cliente_id = c.cliente_id and mbc.id = c.movimiento_id
   where apr.id = c.id;
  get diagnostics v_actualizadas = row_count;

  v_sin_movimiento := v_forma_uuid - v_actualizadas;

  raise notice
    '0048 backfill movimiento_bancario_id: % renglones totales, % con referencia_origen no nulo, '
    '% sin forma de UUID (referencia_origen se preserva, sin backfillear), '
    '% con forma de UUID pero sin movimiento_bancario_crudo real para ese cliente (huérfanas, '
    'referencia_origen se preserva, no se pierde nada), % backfilleadas con éxito.',
    v_total, v_con_referencia, v_sin_forma_uuid, v_sin_movimiento, v_actualizadas;
end $$;

commit;

-- =============================================================================
-- Evidencia de verificación en vivo, dejada acá (no un test de mutación formal — CLAUDE.md §1.8 lo
-- deja para qa-automation en una tarea aparte, mismo criterio que 0041 declara para su propia
-- reproducción):
--
-- 1. `SELECT ... FOR UPDATE` bajo `app_request` con el grant de columna + policy de UPDATE de la
--    sección 1: SIN error, fila visible — confirmado con una tabla de prueba de la misma forma antes
--    de escribir este archivo, y de nuevo contra `asiento_correlativo_cliente` real después de
--    aplicar esta migración (ver HANDOFF/reporte de esta tarea).
-- 2. Confirmar un asiento real (`3a44c25f-3618-4638-b8ab-9313292149bd`, cliente
--    `565e413b-4924-4f30-9de6-38c4148186f3`, usuario `22222222-2222-2222-2222-222222222222`, rol
--    `contador`) vía `conUsuario` asigna `numero_correlativo = 1` y deja `siguiente_numero = 2` en
--    `asiento_correlativo_cliente` — verificado con la migración ya aplicada, antes de cerrar la
--    tarea.
-- 3. Dos confirmaciones concurrentes del MISMO cliente (dos asientos_propuesto distintos), con
--    `pg_sleep` inyectado entre el `SELECT ... FOR UPDATE` y el `UPDATE` de incremento (mismo método
--    que 0041), NO reciben el mismo número: la segunda transacción queda bloqueada en el `FOR UPDATE`
--    hasta que la primera libera el lock, y lee el valor YA incrementado.
-- =============================================================================
