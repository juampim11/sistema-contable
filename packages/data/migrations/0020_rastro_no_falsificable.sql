-- =============================================================================
-- 0020 — El rastro deja de ser falsificable, y se cierra la única denegación
--        CROSS-TENANT del expediente.
--
-- Cierra los hallazgos del panel que revisó `0019` (incidentes #6, #7 y #8).
-- `0019` cerró bien el ataque del #5 —la expulsión silenciosa de la supervisión,
-- medida en nueve escenarios— pero introdujo una clase de artefacto que antes no
-- existía: EVIDENCIA FALSA. Y el barrido de la clase destapó, en la tabla vieja,
-- algo peor que una fuga.
--
-- El principio que ordena las seis secciones, y que vale más allá de esta tabla:
--
--   🔴 UN RASTRO CUYA VISIBILIDAD DEPENDE DE UN ESTADO QUE EL OBSERVADO CONTROLA
--      NO ES UN RASTRO — ES UNA CORTESÍA.
--
--   Y su corolario operativo: el rastro se enuncia sobre el HECHO OBSERVADO,
--   nunca sobre el MECANISMO que lo produce, porque el mecanismo siempre tiene
--   un segundo camino. (`deleted_at` produce el resultado del #5 sin tocar
--   `membership`; mañana lo hará borrar el usuario, o mover el nodo.)
--
-- Secciones, en orden de riesgo CRECIENTE sobre el camino de escritura:
--   §1  `acceso_auditoria`: el `insert` va por columna. Cierra la denegación
--       cross-tenant (#7) y el antedatado (H-B).
--   §2  Visibilidad por MEMBRESÍA y no por accesibilidad. Cierra `deleted_at`
--       como interruptor del rastro, en las DOS tablas.
--   §3  `via_depth`: la fila escrita A MANO deja de entrar.
--   §4  El trigger se parte en dos. NO es prolijidad: es el control
--       ANTI-DILUCIÓN, y lo que impide ahogar el rastro en ruido legítimo.
--   §5  `clock_timestamp()`: dos filas de la misma transacción dejan de tener la
--       misma marca al microsegundo.
--   §6  El `comment on table` de `membership_historia` deja de mentir.
--
-- 🔴 LO QUE ESTA MIGRACIÓN **NO** HACE, dicho acá para que nadie lo suponga:
--
--   · NO vuelve confiable a `hecho_por`, y esto es lo más importante de la lista.
--     `app.current_user_id()` es `current_setting('app.user_id')` (`0001:210-213`)
--     — un GUC que **setea la propia sesión**. MEDIDO con la credencial real de
--     `app_request`: `set_config('app.user_id', <otro>, true)` a mitad de
--     transacción es LIBRE, y la fila sale firmada por el impersonado. El único
--     límite es la policy: la identidad declarada tiene que ver el nodo (declarar
--     un socio de OTRO estudio da 42501). O sea que se puede atribuir una
--     escritura a cualquiera del propio subárbol — **incluido el auditor**.
--     Ninguna sección de acá lo arregla, y NO tiene arreglo dentro de la base:
--     Postgres sólo conoce `app_request_dev`; `session_user` diría «lo escribió
--     la aplicación», nunca QUIÉN. Una firma que resista al tenedor de la
--     credencial exige que FIRME LA APLICACIÓN, y eso es arquitectura, no una
--     migración. Registrado como incidente #8.
--     ⚠️ Por eso `0019:85-90` («no se pueden falsificar») sobrestima, y §3 dice
--     «no entra», nunca «es imposible».
--
--   · NO convierte el trigger en `security definer`. `via_depth` es CONTENCIÓN,
--     no AUTENTICACIÓN — ver §3. La autenticación de verdad pide un ADR contra
--     R11 y **pierde la falla-cerrada** que `0019:74-79` eligió a conciencia.
--   · NO revoca el `insert` de tabla entera sobre `membership`: el socio sigue
--     eligiendo el `id` y el `created_at` de la membresía que crea. MEDIDO que
--     **no es el vector de la dilución** (ver §4), así que el recorte es sano.
--   · NO revoca el `delete` sobre `tenant_node` (`0017:347` revocó `insert,
--     update` y nunca el `delete`).
--   · NO agrega `motivo_job`: `hecho_por is null` sigue sin distinguir origen.
--   · NO arregla la mitad *fuga* de H-A: `acceso_auditoria.id` sigue siendo un
--     bigint monótono GLOBAL, o sea que sigue filtrando el volumen de auditoría
--     de toda la plataforma a cualquiera que lea dos filas propias. Arreglarlo
--     es cambiar el tipo de la PK de una tabla append-only: migración propia.
--
-- 🔴 PREMISA DE LA QUE DEPENDE TODO EL ESQUEMA, y que esta migración no crea ni
-- puede arreglar: el DUEÑO DEL ESQUEMA ES SUPERUSUARIO en local y en el piloto
-- (`rolsuper = t`, medido). Con un dueño NO superusuario, `app.accessible_tenant_
-- ids()` —`security definer`, dueño = dueño del esquema— lee `public.membership`,
-- que tiene `force row level security`, cuya `membership_sel` (`0001:332-333`)
-- vuelve a llamar a `app.accessible_tenant_ids()`: **recursión infinita**, medida
-- como `stack depth limit exceeded` en un simple `select count(*) from
-- membership`. No corta, porque `security definer` inhabilita el inlining y el
-- detector de recursión de RLS nunca ve el ciclo. Es un BLOQUEANTE DE DESPLIEGUE
-- registrado aparte, no un pendiente cosmético.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- §1. `acceso_auditoria` — el `insert` por columna
--
-- 🔴 EL HALLAZGO MÁS GRAVE DE ESTA TANDA, Y EL ÚNICO CROSS-TENANT DE TODO EL
-- EXPEDIENTE. No es una fuga: es una DENEGACIÓN. Un estudio apaga las lecturas
-- auditadas de OTRO.
--
-- `acceso_auditoria.id` es `bigint generated always as identity`, y el grant de
-- `0001` es de TABLA ENTERA — o sea que incluye la columna `id`. Con privilegio
-- de columna, `overriding system value` funciona, y entonces un tenant puede
-- reclamar ids que la secuencia todavía no alcanzó.
--
-- MEDIDO contra local, en una transacción revertida:
--
--   secuencia de acceso_auditoria.id -> el próximo natural sería 4957
--   socio Estudio UNO reclama ids 4957..4959:  INSERT 3
--   socio Estudio DOS, su camino normal:       23505 duplicate key value
--                                              violates "acceso_auditoria_pkey"
--
-- Y el daño NO es «no se escribe el rastro». `registrarAcceso()` corre ANTES de
-- la lectura y en la MISMA transacción (`auditoria.ts:156`, `leerConAuditoria`),
-- así que la fila que no entra se lleva puesta la operación de negocio del otro
-- estudio. Es aislamiento roto en la dimensión de DISPONIBILIDAD.
--
-- El mismo grant de tabla entera deja elegir `ocurrido_en` (hallazgo H-B, del
-- incidente #4): antedatar el propio rastro de acceso. `0019` cerró exactamente
-- esto en la tabla nueva CITANDO H-B (`0019:88-90`) y no volvió sobre la vieja.
--
-- 🔴 Y va a nivel TABLA, no `revoke insert (id)`: un `revoke` por columna sobre
-- un grant de TABLA es un NO-OP SILENCIOSO (medido en el #4, y por eso `0017:338`
-- y `0018:56` ya escribieron la forma canónica). Se revoca entero y se re-otorga
-- columna por columna.
--
-- COSTO DE PRODUCCIÓN: CERO, verificado contra el único punto de escritura que
-- existe. `auditoria.ts:127` inserta exactamente estas siete columnas y no
-- nombra `id` ni `ocurrido_en`. `app_firmador` no tiene nada sobre esta tabla.
--
-- MEDIDO con el `revoke` puesto, misma transacción:
--   insert nombrando `id`           -> 42501 permission denied   (ataque)
--   insert nombrando `ocurrido_en`  -> 42501 permission denied   (ataque)
--   insert de las siete columnas    -> OK, 1 fila               (caso legítimo)
--
-- ⚠️ CONSECUENCIA PARA EL FUTURO: con grant de tabla, toda columna nueva era
-- insertable sola —`correlacion` (`0003`) entró así—. Con grant por columna, la
-- próxima (`0001:371` ya anticipa `ip`/`user_agent`) NO es insertable y falla en
-- RUNTIME, no en la migración. Toda columna nueva de esta tabla se agrega al
-- grant en LA MISMA migración que la crea.
-- -----------------------------------------------------------------------------

revoke insert on acceso_auditoria from app_request, app_job;
grant  insert (cliente_id, user_id, accion, recurso, recurso_id, motivo, correlacion)
  on acceso_auditoria to app_request, app_job;

comment on column acceso_auditoria.id is
  'Bigint secuencial GLOBAL. NUNCA se otorga `insert` sobre esta columna: con `overriding system '
  'value` un tenant reclama ids que la secuencia no alcanzó y la PK aborta la operación auditada de '
  'OTRO tenant (incidente #7, medido). Y NUNCA sale en API, URL ni export: enumera el volumen de '
  'auditoría de toda la plataforma (R25, hallazgo H-A — abierto, pide cambio de tipo de la PK).';


-- -----------------------------------------------------------------------------
-- §2. La visibilidad del rastro se resuelve por MEMBRESÍA, no por ACCESIBILIDAD
--
-- 🔴 EL BLOQUEANTE FUNDACIONAL, y el que hace falsa la lectura ingenua del
-- incidente #5. `0019` cerró la expulsión de la supervisión por la vía de
-- `membership`… y `deleted_at` produce EL MISMO RESULTADO sin tocar `membership`.
--
-- `accessible_tenant_ids()` exige `deleted_at is null` en las DOS puntas del join
-- (`0015:194-195`). O sea que un `update tenant_node set deleted_at = now()` —una
-- escritura que el socio tiene otorgada (`0018:70`) y que no deja ninguna fila—
-- apaga el rastro para quien supervisa, SIN BORRAR UNA SOLA FILA DEL DISCO.
--
-- MEDIDO contra local, con el auditor colgando de un nodo cliente:
--
--                                    rastro   acceso   nodos
--   auditor, nodo activo                  3        6       1
--   auditor, tras `deleted_at`            0        0       0   <- apagado
--   (el dueño, en disco)                  6                    <- intactas
--   auditor, con §2 aplicado              3        6       0   <- recuperado
--
-- Y la mitad que importa igual, el ANTI-caso: el socio del OTRO estudio queda
-- IGUAL antes y después —rastro 1 -> 1, acceso 0 -> 0—, con **0 filas visibles
-- fuera de su subárbol**. El aislamiento cruzado no se mueve ni un renglón.
--
-- POR QUÉ FUNCIONA, y es la razón por la que esto es de una línea y no un
-- rediseño: `app.has_role_on()` **NO mira `deleted_at`** (`0015:203-218` — el
-- `deleted_at is null` de la línea 235 es de `exigir_nodo_cliente`, otra
-- función), y el aislamiento cruzado lo carga ÉL, por contención de `path`, no
-- `accessible_tenant_ids()`. Sacar el conjunto no afloja nada: sólo deja de
-- consultarle al auditado si el auditor puede mirar.
--
-- 🔴 `nodos` sigue en 0 después del fix, y ESTÁ BIEN. La baja lógica del nodo es
-- una operación de negocio legítima y sigue escondiendo el NODO; lo que deja de
-- esconder es el RASTRO. Son dos preguntas distintas: «¿este dato es tuyo?» la
-- puede gobernar un atributo que el tenant escribe; «¿qué se hizo con tu
-- autoridad?» no.
--
-- 🔴 ESTO ES UNA EXCEPCIÓN EXPLÍCITA A R4, y está anotada EN EL TEST
-- (`catalogo.test.ts`, `EXCEPCIONES_R4`), no sólo en el ADR — porque es en el
-- test donde se mira. Anotarla únicamente en ADR-0002 dejaba el gate rojo y la
-- excepción sin guardia: la lista es nominal y hay un caso que falla si crece o
-- si alcanza a un `with_check`.
--
-- ⚠️ ASIMETRÍA DELIBERADA: §2 saca `accessible_tenant_ids()` del `select`;
-- `membership_historia_ins` (`0019:170-171`) lo CONSERVA. Con el nodo de baja el
-- rastro se LEE pero no se ESCRIBE. No es un agujero: `membership_wr` también lo
-- conserva, así que sobre un nodo de baja el socio ya no puede tocar membresías
-- y no hay escritura que registrar. Falla cerrado, y queda escrito porque es un
-- invariante repartido entre dos policies distintas.
--
-- Va sobre las DOS tablas. `acceso_auditoria_sel` (`0001:385-387`) tiene el
-- predicado calcado, y es el rastro central de todo ADR-0002.
--
-- ⚠️ COSTO MEDIDO DE SACAR `accessible_tenant_ids()` (60.005 filas por tabla):
--
--   consulta                                        antes            después
--   count(*) membership_historia (sin where)   120.822 buf/3,7 s  300.824 buf/6,4 s
--   where tenant_node_id = … limit 50              163 buf/4,4 ms     154 buf/3,7 ms
--   count(*) acceso_auditoria (sin where)      181.044 buf/4,5 s  180.050 buf/6,2 s
--   where cliente_id = … limit 50                  162 buf/4,9 ms     153 buf/3,3 ms
--
-- El conjunto costaba 9 buffers UNA vez y quedaba como `hashed SubPlan`, y el AND
-- corta a izquierda: `has_role_on()` (~3 buffers POR FILA) sólo corría sobre las
-- 40.004 que pasaban el hash. Sin el conjunto corre sobre las 60.005. O sea que
-- el conjunto era, además de un predicado, un PRE-FILTRO BARATO. Se acepta: el
-- costo aparece SÓLO en el barrido sin `where`, que en producción no existe —
-- las dos consultas reales quedan iguales o mejor, y en `acceso_auditoria` el
-- plan pasa de Seq Scan a Index Only Scan.
--
-- ⚠️ `drop policy` + `create policy` y NO `alter policy`, a propósito: es la
-- forma unánime del repo (`0005:39`, `0019:265`; `alter policy` no aparece ni una
-- vez), el lock es el mismo (AccessExclusiveLock, medido), la ventana intermedia
-- no existe (el archivo corre en una transacción) y sería deny-all igual. Y el
-- `create` completo deja el `FOR SELECT` y el `TO` a la vista de quien lea esta
-- migración dentro de un año. 🔴 NO se generaliza a FUNCIONES: `0015:62-71`
-- prohíbe `drop`+`create` ahí porque 49 policies dependen de
-- `accessible_tenant_ids()`. De una policy no depende nada.
-- -----------------------------------------------------------------------------

drop policy membership_historia_sel on membership_historia;
create policy membership_historia_sel on membership_historia for select
  using ( app.has_role_on(tenant_node_id,
            array['admin_plataforma','socio','auditor']::app.rol_membership[]) );

drop policy acceso_auditoria_sel on acceso_auditoria;
create policy acceso_auditoria_sel on acceso_auditoria for select
  using ( app.has_role_on(cliente_id, array['socio','auditor']::app.rol_membership[]) );


-- -----------------------------------------------------------------------------
-- §3. `via_depth` — la fila escrita A MANO deja de entrar
--
-- La columna NO se le otorga a nadie. Con el grant por columna de `0019:245`
-- intacto, quien escribe a mano tiene dos caminos y los dos mueren:
--   · si la NOMBRA    -> 42501 permission denied (no tiene privilegio de columna)
--   · si NO la nombra -> corre el DEFAULT, que fuera de un trigger vale 0, y el
--                        check lo rechaza con 23514.
-- El trigger tampoco la nombra: corre el mismo DEFAULT, que adentro vale 1.
--
-- MEDIDO como socio real, contra el esquema aplicado:
--   insert nombrando via_depth        -> 42501 permission denied
--   insert nombrando hecho_por        -> 42501 permission denied
--   insert sin nombrarla              -> 23514 membership_historia_via_chk
--   insert con via_depth = 99         -> 42501 permission denied
--   select de via_depth               -> OK   (la supervisión no se estorba)
--   WITH real AS (INSERT INTO membership … RETURNING …) INSERT INTO historia …
--                                     -> 23514  <- una CTE NO hereda profundidad
--   caso legítimo (alta/baja/borrado) -> escribe, con via_depth = 1
--
-- 🔴 ES CONTENCIÓN, NO AUTENTICACIÓN, y las dos mitades del límite son reales:
--   (a) Se apoya en que hoy NINGÚN rol de aplicación puede hacer correr SQL
--       propio a profundidad de trigger >= 1: medido, ninguno tiene CREATE sobre
--       ningún esquema ni sobre la base, ni TEMPORARY (`0015` §2), y ningún
--       cuerpo de trigger arma SQL dinámico. Es un argumento por AUSENCIA DE
--       CAMINO, cierto hoy — y por eso va con su propia regla verificable, que
--       asserta esa ausencia en el gate en vez de confiar en ella.
--   (b) NO vuelve confiable a `hecho_por`. Ver el encabezado: la firma vale la
--       identidad que la SESIÓN DECLARA. §3 cierra «esta fila no la produjo
--       ninguna operación»; no cierra «esta fila la produjo otro».
--
-- 🔴 EL ORDEN DE ESTOS TRES RENGLONES NO ES ESTILO, Y NO ES EL OBVIO.
-- `pg_trigger_depth()` es STABLE (`provolatile = 's'`, medido), NO volátil. Por
-- eso `add column … default pg_trigger_depth()` toma el camino rápido de
-- `attmissingval` y evalúa el default UNA VEZ, a nivel ALTER, fuera de todo
-- trigger: MEDIDO, `atthasmissing = true`, `attmissingval = {0}`, y las filas
-- viejas quedan en 0 — o sea que el check las rechazaría a todas.
--
-- Y el backfill NO puede ir por `UPDATE`: esta tabla es append-only y no tiene
-- policy de update, así que con `force row level security` un
-- `update … set via_depth = 1` afecta **0 filas SIN ERROR** cuando el dueño no es
-- superusuario. En local no se nota porque el dueño SÍ lo es — es exactamente la
-- clase de defecto que este entorno no puede ver.
--
-- La salida es hacer el backfill POR DDL: se agrega con `default 1` (constante,
-- medido `attmissingval = {1}`, sin reescritura y sin pasar por ninguna policy) y
-- RECIÉN DESPUÉS se cambia el default al de verdad. El `not null` viene en el
-- mismo renglón. CONSECUENCIA: esta migración no necesita NINGUNA ventana de
-- `no force row level security`, sobre ninguna tabla.
--
-- 🔴 EL `not null` ES PORTANTE, NO PROLIJIDAD. Un `check` que evalúa a NULL **no
-- se viola**: la fila entra. Medido como mutación — con `drop not null` + `drop
-- default`, el ataque que no nombra la columna PASA.
-- -----------------------------------------------------------------------------

alter table membership_historia add column via_depth int not null default 1;
alter table membership_historia alter column via_depth set default pg_trigger_depth();
alter table membership_historia
  add constraint membership_historia_via_chk check (via_depth >= 1);

comment on column membership_historia.via_depth is
  'Profundidad de anidamiento de trigger con la que se escribió la fila. Sale de un DEFAULT y NUNCA '
  'se le otorga a nadie: es lo que distingue la fila que escribió `app.registrar_cambio_membership()` '
  '(vale 1) de la que alguien escribió a mano (el DEFAULT vale 0 y el check la rechaza). '
  '🔴 Sólo vale mientras el `grant insert` sea POR COLUMNA. El día que alguien re-otorgue '
  '`grant insert on membership_historia` de tabla entera copiando la plantilla de ADR-0001 §5, esta '
  'columna pasa a ser nombrable y el control desaparece SIN QUE NADA se ponga rojo. Por eso el test '
  'que la guarda mira el GRANT, no el ataque.';

comment on constraint membership_historia_via_chk on membership_historia is
  '🔴 El predicado lee la COLUMNA ALMACENADA, no llama a `pg_trigger_depth()`. No es un detalle de '
  'estilo: MEDIDO, Postgres NO rechaza una función no-immutable dentro de un `check` —se crea sin una '
  'sola advertencia— y después toda revalidación (un `VALIDATE`, un `ADD CONSTRAINT` posterior, un '
  'restore de `pg_dump`) la reevalúa FUERA del trigger, da 0, y falla con `is violated by some row` '
  'sobre filas legítimas ya escritas. La función volátil vive SÓLO en el DEFAULT. '
  'Y es `>= 1`, nunca `= 1`: la cascada `tenant_node -> membership` dispara el trigger a profundidad 2.';


-- -----------------------------------------------------------------------------
-- §4. El trigger se parte en DOS — y es el control ANTI-DILUCIÓN
--
-- 🔴 NO ES PROLIJIDAD. Sin esta sección, §3 cierra la FALSIFICACIÓN y deja
-- abierta la DENEGACIÓN DE EVIDENCIA, que es la misma familia que el #7.
--
-- El trigger de `0019` no tiene cláusula `when`, así que un `update` que no
-- cambia ningún valor escribe igual una fila de 'modificacion' vacía. Y esa fila
-- es LEGÍTIMA: nace del trigger, a profundidad 1, o sea que **pasa `via_depth`
-- sin problema**. MEDIDO como socio, con la RLS acotando sola al subárbol:
--
--   update membership set activo = activo;   (sin where)
--     -> UPDATE 4, rastro 5 -> 9  (+4)
--
-- N = membresías no supervisoras del subárbol, y **repetible sin límite**: no hay
-- unicidad ni dedup (la PK es `gen_random_uuid()`). Como la tabla es append-only
-- y ni `app_request` ni `app_job` tienen `delete`, la basura **no se saca sin una
-- migración**. El auditor no pierde la fila real: la pierde de vista.
--
-- 🔴 Y el vector NO es el `insert` de tabla entera sobre `membership` —el recorte
-- que esta migración deja afuera a propósito—: es `update (activo)`, que INV-10
-- OBLIGA a que exista. Cerrar aquel grant no habría cerrado esto.
--
-- La condición natural sería un solo trigger con
-- `when (tg_op <> 'UPDATE' or old.* is distinct from new.*)`, y NO EXISTE.
-- MEDIDO, cuatro variantes contra el esquema aplicado:
--
--   when (tg_op <> 'UPDATE' or old.* is distinct from new.*)
--      -> 42703  column "tg_op" does not exist
--   when (pg_catalog.tg_op <> 'UPDATE')
--      -> missing FROM-clause entry for table "pg_catalog"
--   after insert or update or delete … when (old.* is distinct from new.*)
--      -> INSERT trigger's WHEN condition cannot reference OLD values
--   after update … when (old.* is distinct from new.*)
--      -> CREATE TRIGGER
--
-- La cláusula `WHEN` es SQL y sólo ve OLD/NEW; `TG_OP` es una variable de
-- PL/pgSQL que existe únicamente dentro del cuerpo de la función. Y en cuanto el
-- evento incluye `insert`, referenciar OLD en el `WHEN` está PROHIBIDO. O sea que
-- partirlo en dos no es la forma prolija: **es la única que compila**.
--
-- La FUNCIÓN NO SE TOCA: los dos triggers llaman a la misma, y `tg_op` sigue
-- funcionando adentro, que es donde siempre funcionó. Los dos eventos son
-- DISJUNTOS (insert/delete vs update), así que nunca compiten y el orden
-- alfabético de disparo es irrelevante.
--
-- MEDIDO con §4 puesta: el `update` no-op pasa de +1 fila a **+0**, y el `update`
-- real sigue en +1.
--
-- ⚠️ `old.* is distinct from new.*` compara la FILA ENTERA, o sea «no cambió
-- nada», no «no cambió `activo`». Es lo correcto: `0019` §2 dejó a `app_request`
-- sólo `update (activo)`, y si mañana se le otorga otra columna, el trigger la
-- registra sola.
-- ⚠️ El nombre `trg_membership_historia` DESAPARECE. Cualquier doc o test que lo
-- nombre hay que actualizarlo.
-- ⚠️ CONSECUENCIA: `operacion = 'modificacion'` queda sin camino de producción.
-- Es un valor del dominio cerrado que, de acá en más, sólo puede producir el
-- dueño del esquema. Se conserva en el `check` a propósito: las filas históricas
-- que ya lo tienen siguen siendo válidas.
-- -----------------------------------------------------------------------------

drop trigger trg_membership_historia on membership;

create trigger trg_membership_historia_ins_del
  after insert or delete on membership
  for each row execute function app.registrar_cambio_membership();

create trigger trg_membership_historia_upd
  after update on membership
  for each row when (old.* is distinct from new.*)
  execute function app.registrar_cambio_membership();


-- -----------------------------------------------------------------------------
-- §5. `clock_timestamp()` — dos filas de la misma transacción dejan de empatar
--
-- `now()` es `transaction_timestamp()`: devuelve el MISMO valor para toda la
-- transacción. MEDIDO en la línea de base, con la fila real del trigger y una
-- forjada a mano en la misma transacción, las dos quedaron con el mismo
-- `ocurrido_en` **al microsegundo**. Y el `id` es un uuid aleatorio, así que
-- tampoco hay un secuencial que desempate: el orden de los hechos se pierde, que
-- es justo lo que un rastro tiene que conservar.
--
-- MEDIDO con `clock_timestamp()` puesta:
--   alta+baja+realta en UNA transacción      -> 3 filas, 3 marcas distintas
--   delete de 2 membresías en UNA SENTENCIA  -> 4 filas, 4 marcas distintas
--   5 rastros de acceso en UNA transacción   -> 5 marcas, span 32 ms
--   300.000 filas: now() -> 1 marca | clock_timestamp() -> 300.000
--
-- COSTO: NULO. 300.000 filas con los DOS índices `(col, ocurrido_en desc)` que ya
-- tiene la tabla, dos corridas con el orden invertido:
--   corrida 1 (now primero):    now 5641 ms  | clock 4860 ms
--   corrida 2 (clock primero):  clock 4589 ms| now   4103 ms
--   índices: 16 MB los cuatro, IDÉNTICOS.
-- El que corre segundo siempre gana: es caché, no la función. Y si algo, el
-- índice MEJORA — con `now()` una transacción larga inserta marcas viejas tarde y
-- parte páginas del medio del btree; con `clock_timestamp()` las inserciones caen
-- siempre en la página más a la derecha.
--
-- VA EN LAS DOS TABLAS. §1 acaba de sacarle a `app_request` el privilegio sobre
-- `acceso_auditoria.ocurrido_en`: la columna pasa a depender enteramente del
-- DEFAULT, así que el DEFAULT tiene que ser el bueno.
--
-- ⚠️ NADIE ASUME «una transacción, una marca» — barrido hecho. `descarga.ts:172`
-- y `:203` comparan `ocurrido_en > now() - interval '1 hour'`, y
-- `clock_timestamp()` sólo puede quedar POR DELANTE de `now()`: el predicado se
-- vuelve más inclusivo, nunca menos. La correlación se hace por `correlacion`
-- (`0003`), que existe justamente porque el timestamp no alcanzaba.
-- ⚠️ Varios `order by ocurrido_en desc limit 1` pasan de NO DETERMINÍSTICOS a
-- determinísticos. Es una mejora, pero puede cambiar el valor esperado de un test
-- que hoy pasa por casualidad.
--
-- ⚠️ ESTO NO ARREGLA EL PASADO: las filas ya escritas con `now()` quedan como
-- están, y entre dos de la misma transacción «cuál fue primero» no se contesta.
-- -----------------------------------------------------------------------------

alter table membership_historia alter column ocurrido_en set default clock_timestamp();
alter table acceso_auditoria    alter column ocurrido_en set default clock_timestamp();


-- -----------------------------------------------------------------------------
-- §6. El comentario de la tabla deja de mentir
--
-- 🔴 `0019:151-154` afirma «Lo escribe un TRIGGER, no la aplicación». Era falso
-- desde el día uno: hasta §3, cualquier identidad con acceso al nodo escribía
-- filas indistinguibles. Y el `comment on table` es la fuente que más
-- probablemente lea quien investigue —un `\d+` alcanza—, así que una afirmación
-- de más ahí vale por una prueba falsa.
-- -----------------------------------------------------------------------------

comment on table membership_historia is
  'Rastro append-only de los cambios del padrón de derechos (incidente #5). Lo escribe el trigger '
  '`app.registrar_cambio_membership()`, y desde `0020` §3 una fila escrita A MANO no entra: `via_depth` '
  'sale de un DEFAULT que fuera del trigger vale 0 y el check la rechaza. '
  '🔴 QUÉ PRUEBA UNA FILA Y QUÉ NO: prueba una AFIRMACIÓN FECHADA Y ATRIBUIDA, no un hecho. La fecha '
  'no es elegible (`ocurrido_en` sale de un DEFAULT sin grant). La AUTORÍA SÍ LO ES: `hecho_por` vale '
  '`app.current_user_id()`, que es el GUC `app.user_id` que setea la propia sesión — medido, quien '
  'tiene la credencial de `app_request` puede declararse otro del mismo subárbol, el auditor incluido '
  '(incidente #8). Ninguna fila se altera ni se borra con credenciales de aplicación. Frente al dueño '
  'del esquema no hay ninguna garantía. Alcance completo en `docs/seguridad/registro-incidentes.md`.';

commit;
