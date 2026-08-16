# ADR-0002 — Seguridad: niveles de datos, aislamiento y reglas verificables

**Estado:** Aceptado
**Fecha:** 2026-08-09
**Depende de:** `ADR-0000-stack-infra.md` (tres credenciales, tres abstracciones) y
`ADR-0001-tenancy.md` (árbol de tenancy, RLS, `conUsuario()`).
**Contenido de dominio:** producido por la persona `seguridad-datos-financieros`
(`agents/personas/seguridad-datos-financieros.md`), convocada explícitamente para completar las cuatro
reglas de base con su criterio. Sus hallazgos adversariales están en §H, y **uno de ellos era un bug
real de la migración** (H-1), ya corregido y verificado.

> **Nota normativa, por el guardrail del agente:** este ADR **no afirma ninguna obligación legal**.
> `knowledge/` está vacío (esqueleto). Sobre secreto fiscal, protección de datos personales, plazos de
> conservación y deber de notificar incidentes: **"no tengo esa fuente cargada"** — ver §G. No se cita
> ningún número de norma porque no hay ninguna fuente cargada de la cual copiarlo.
> **Validar con profesional matriculado.**

---

## 0. Modelo de amenaza

**Qué se custodia**, por cada cliente de cada estudio: CUIT, razón social, domicilio, cuentas bancarias
y CBU, extractos completos, importes y saldos, plan de cuentas y asientos, deuda impositiva, DDJJ,
estados contables no publicados, credenciales fiscales, y —si hay sueldos— datos de empleados.

**El radio de daño es lo que define todo lo demás:** la raíz del árbol es el **estudio**. Un error de
aislamiento no filtra "un cliente a otro cliente": filtra **la cartera completa de un estudio a otro
estudio**. Quién es cliente de quién, cuánto factura, cuánto debe.

| Adversario | Por dónde entra | Qué se lleva |
|---|---|---|
| Estudio competidor | cuenta legítima en el SaaS + un bug de aislamiento | la cartera de un competidor |
| Empleado que se va | acceso legítimo amplio, sin auditoría | descarga masiva de extractos y DDJJ de toda la cartera |
| Atacante externo | credenciales de un usuario, RCE, bucket mal configurado, URL firmada filtrada | todo lo anterior + **credenciales fiscales** (permiten actuar ante el organismo en nombre del cliente) |
| Filtración pasiva | logs, mensajes de error, telemetría, dump de prod a un entorno de prueba, secreto commiteado, **dato real pegado en el contexto de un agente** | dato fiscal fuera del perímetro, sin que nadie lo note |

**Las cuatro reglas de base fijadas por el titular del producto** se toman como constraints duros:
`force row level security` en toda tabla con datos de un cliente; ningún acceso sin el filtro de tenant;
datos financieros de terceros nunca en logs y secretos nunca en el repo, con declaración explícita de
campos sensibles; aislamiento entre clientes. **Lo que este ADR agrega** es lo que hace falta para que
esas cuatro sean verificables y no se rompan solas: clasificación (§A), reglas mecánicas (§B),
invariantes con su test (§C), logging (§D), custodia de credenciales (§E), datos de prueba (§F).

---

## A. Clasificación de datos en niveles

### A.1. Los cinco niveles

| Nivel | Qué es | Datos de este dominio | Cifrado | Enmascarado | Quién lee | ¿Log? | ¿Export? | ¿Entorno de prueba? |
|---|---|---|---|---|---|---|---|---|
| **N0 — Público** | No identifica a nadie | normativa de `knowledge/`, nomenclador de jurisdicciones, catálogo de bancos, **plan de cuentas modelo del producto**, tipos de comprobante, textos de UI | — | No | Cualquiera | Sí | Sí | Sí |
| **N1 — Interno** | Metadato operativo sin dato de tercero | `tenant_node.id` (uuid), nombre del **estudio**, `lote_ingesta.id`, estado y duración de jobs, conteos, métricas, `request_id`, `user_id` (uuid) | Volumen | No | Staff del estudio + operación | Sí | Sí | Sí (sintético) |
| **N2 — Confidencial-cliente** | **Default de toda tabla de dominio** | razón social del cliente, domicilio fiscal, condición ante IVA, jurisdicciones activas, plan de cuentas **del cliente**, asientos y partidas, importes y saldos, **descripción del movimiento bancario**, deuda impositiva, papeles de trabajo, estados contables no publicados | Volumen + backups cifrados | En listados | Con membresía en **ese** nodo cliente y rol habilitado | **No** (solo el uuid) | Por rol, auditado, con motivo | **No** — solo sintético |
| **N2-R — Confidencial restringido** | Identificador directo o pieza que habilita fraude | **CUIT/CUIL**, **CBU / nro. de cuenta / alias**, **archivo de extracto crudo**, **DDJJ como archivo**, comprobantes escaneados, **legajo de empleado**, firmas escaneadas | Volumen + **campo marcado para cifrado de aplicación** | **Sí por defecto** (últimos 4 del CBU, CUIT parcial) | Rol operativo con membresía en ese cliente; nunca soporte de plataforma sin grant temporal auditado | **Nunca** | Solo export **declarado**, auditado, con motivo y destinatario | **Nunca** |
| **N3 — Secreto** | Habilita actuar en nombre del cliente | **clave fiscal**, **certificado + clave privada del webservice**, tokens del WS, **credenciales de home banking (prohibido almacenar)**, KEK/DEK, `DATABASE_URL`, credencial de storage, secreto de firma de sesión, credenciales IMAP/SMTP | **Cifrado sobre (envelope) obligatorio** | Nunca se muestra; solo huella del certificado **público** | **Ningún humano por la app.** Solo el proceso firmador | **Nunca** (ni longitud, ni prefijo) | **No existe export**: la baja es rotación | **Nunca**: los entornos no productivos usan **credenciales de homologación propias** |

### A.2. Reglas de nivel

1. **El default de una columna nueva en una tabla con `cliente_id` es N2.** No hay "sin clasificar".
2. **Un derivado hereda el nivel máximo de sus insumos.** Un CSV con CUIT + importes es N2-R.
3. **Agregar no desclasifica.** "Clientes con deuda > X" sobre un solo cliente **es** el dato del
   cliente. Solo baja de nivel un agregado sin identificadores, con k ≥ 20 registros de ≥ 5 clientes
   distintos, y con decisión registrada del titular del estudio.
4. **N3 nunca pasa por el proceso que atiende pedidos** (§E.2).
5. **Mandar cualquier cosa ≥ N2 a un servicio externo** (correo, IA, analítica, error tracking, OCR en
   la nube) **no lo decide un dev ni un agente**: es decisión registrada del titular. **Incluye pegar
   datos reales en el contexto de un agente o LLM** — este repo se trabaja con agentes, la regla aplica
   literalmente.

### A.3. El registro de clasificación es código, no prosa

La tabla de §A.1 es inútil si vive solo en un `.md`. Se materializa en **una fuente única consultable
en runtime**: `packages/shared/seguridad/clasificacion-campos.ts`, mapa
`tabla.columna → { nivel, enmascarado, cifrado, exportable }`, más, por tabla, **cuál es su columna de
tenant** (`cliente_id` | `estudio_id` | `ninguna` + justificación escrita).

- **El redactor de logs, el armador de exports y el serializador de la API derivan de ese mapa.** No hay
  listas paralelas.
- **Test bloqueante:** toda columna del esquema Drizzle tiene que existir en el registro. Columna nueva
  sin clasificar → **CI rojo**. Es lo único que impide que la clasificación quede vieja al tercer sprint.
- Los barridos de §C se **generan** a partir de ese registro: una tabla nueva queda cubierta sola.

> **✅ Implementado** en `packages/shared/src/seguridad/clasificacion-campos.ts`. Se declara con
> `as const satisfies` (no con una anotación ancha) a propósito: así los literales sobreviven y el tipo
> `ColumnaSensible` —que es el que hace que el logger **no compile** si le pasás una clave ≥ N2— se
> **deriva** del registro en vez de repetirse a mano. Los barridos de §C leen el mismo objeto.

---

## B. Reglas duras de código, verificables mecánicamente

Redactadas para que un test o `code-reviewer` las chequee sin criterio humano. Todas **bloquean merge**.

### B.0. 🔴 Ninguna regla de esta sección cuenta como control hasta que se probó rompiéndola

**Toda regla nueva o reescrita de §B se cierra por prueba de mutación, no por redacción.** En concreto:

1. Se escribe la versión **defectuosa** del código que la regla debe atrapar, y se verifica que la
   regla se ponga **roja**. Si no se pone roja, la regla no mide lo que dice.
2. 🔴 **Las mutaciones se eligen para REFUTAR, no para confirmar.** «4 mutaciones, 4 atrapadas» no dice
   nada si son las 4 que el test fue escrito para atrapar: sobre esa misma regla se corrieron 27 y
   sobrevivieron 7, todas en la familia que ningún test miraba.
3. Se agrega el **caso legítimo** —lo que la regla debe seguir permitiendo— y se verifica que alguna
   mutación se detecte **sólo** por él. Un control que sólo prohíbe pasa todos los tests negativos y
   rompe la operación real.
4. Se declara, en la columna «Estado», **cuántas mutaciones se probaron y cuántas atrapó**. Un número
   sin harness versionado se marca como **no reproducible**, y eso es información, no un detalle.
5. Se verifica que la regla **no pase por vacuidad**: toda aserción sobre un conjunto que puede estar
   vacío lleva su guarda de cardinalidad, con número.
6. **Cada ataque corre con la identidad más privilegiada que corresponda.** Un ataque probado sólo con
   el rol de la aplicación mide **privilegio**, no **invariante**, y se pone verde el día que alguien
   re-otorgue un grant de tabla entera copiando la plantilla de ADR-0001 §5.

**Y el estado es parte de la regla.** Un ⚠️ o un ❌ sin dueño y sin fecha no es una advertencia: es un
✅ con más letras. R33 estuvo ⚠️ *«existe con valores de desarrollo evidentes»* toda la vida del repo, y
esa frase era el incidente #3 escrito por adelantado.

**Marcar una regla como cerrada sin haberla mutado es exactamente el error que los incidentes #1 a #5
documentan.** Pasó: la primera marca de «cerrado» del #1 se puso con R10 escrita y sin mutar, y R10
estaba mal — por segunda vez. El porqué completo, con las cinco reglas que llegaron a estar verdes o
amarillas con su propio defecto adentro, está en `docs/diseno/09-lecciones-aprendidas.md` §11.

> ### Estado al cerrar la Fase 0 — 🔴 CONGELADA. YA NO MANDA: manda la columna «Estado» de cada regla
>
> **Foto histórica del cierre de la Fase 0 (2026-08-09), 72 tests. Se conserva para trazabilidad y
> no se actualiza.** Se escribió cuando la columna «Estado» de cada regla era una intención y no un
> hecho; hoy es al revés, y dejarla dominante **propaga datos falsos**: acá figuran ✅ **R13 y R33**,
> que sus propias filas declaran ⚠️ y ❌ *insuficiente* después de los incidentes #2, #3 y #4.
>
> 🔴 **Regla de lectura, desde 2026-08-16: la fila de cada regla es la fuente de verdad de su
> estado; esta tabla es historia.** Las reglas posteriores a la Fase 0 (R36, R37, R37 bis) no están
> acá y no van a estarlo. **Un índice que repite un estado es un índice que se desincroniza** — éste
> se desincronizó tres veces en un día. El estado de entonces, verificado con `pnpm verificar`
> (typecheck + 72 tests) y las tres pasadas SQL:
>
> | Estado | Reglas | Cómo se verifica |
> |---|---|---|
> | ✅ **Implementada y verificada** | R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, **R12**, **R13**, R15, R16, R17, R18, R19, R22, R23, R26, R27, R28, R29, R30, R32, R33, R35 | `packages/data/tests/catalogo.test.ts` (28), `aislamiento.test.ts` (19), `reglas-de-codigo.test.ts` (8), `packages/shared/tests/redactor.test.ts` (17) |
> | ⚠️ **Parcial** | R14 (el workflow de CI está escrito pero no ejecutado — ver §H.3.2), R24, R25, R31 | — |
> | ⏳ **Pendiente, con dueño** | R20, R21 (**entran con el Módulo 1**: son sobre la ingesta), R34 | — |
>
> Las reglas ✅ **no dependen de que alguien las recuerde**: una tabla nueva sin RLS forzada, una policy
> con predicado abierto, una FK de dominio sin la columna de tenant, un `console.log`, un `SET` de
> sesión o un `Pool` fuera de `packages/data/src/db/` ponen el gate en rojo.

### B.1. Esquema y RLS

| # | Regla | Cómo se chequea | Estado |
|---|---|---|---|
| **R1** | Toda tabla con columna de tenant tiene `enable` **y** `force row level security`. | Catálogo: `pg_class.relrowsecurity and relforcerowsecurity` para toda tabla del registro → 0 excepciones. | ✅ **verificado** (T9) |
| **R2** | Toda tabla de dominio tiene su columna de tenant `not null references tenant_node(id)` **e índice** con esa columna primera. | `pg_constraint` + `pg_index`. | ✅ en la plantilla (§ADR-0001 §5); test pendiente de generalizar |
| **R3** | Toda tabla con RLS tiene policy de `select`, y la de escritura tiene `using` **y** `with check`. | Barrido de `pg_policies`. | ✅ **verificado** (T10) |
| **R4** | El predicado de tenant se escribe **exactamente** `<col_tenant> in (select app.accessible_tenant_ids())`. Rechazar `exists (select 1 from app.accessible_tenant_ids())`, `= app.accessible_tenant_ids()`, y cualquier `or … is null`. | Normalizar el texto de `pg_policies.qual`/`with_check` y matchear el patrón canónico; whitelist explícita con motivo escrito. | ⚠️ parcial: T10 detecta el predicado abierto; falta el match exacto del patrón |
| **R5** | Ninguna policy contiene `true`, `or true`, `is null` ni un `coalesce` que abra el predicado. | Regex sobre el texto de las policies. | ✅ **verificado** (T10) |
| **R6** | Unicidad **siempre scopeada al tenant**: `unique (cliente_id, …)`, `unique (estudio_id, cuit)`. **Prohibido** un único global sobre un identificador de tercero. | `pg_index` de únicos: si incluye una columna N2/N2-R y **no** la de tenant → falla. | ✅ en la plantilla; test pendiente |
| **R7** | Ninguna relación tiene como **owner** un rol con `BYPASSRLS`. | `pg_class` ⋈ `pg_roles` → 0 filas. | ⏳ pendiente |
| **R8** | Toda vista sobre tablas con RLS se crea con `security_invoker = true`. Si el Postgres objetivo no lo soporta, **prohibidas las vistas sobre dominio**. | `pg_class.reloptions`. | ⏳ pendiente |
| **R9** | **Prohibidas las vistas materializadas sobre tablas de dominio.** Una matview **no admite policies**: su contenido queda cross-tenant. Para materializar un agregado, se usa una **tabla real con columna de tenant + RLS**, refrescada por evento. | `pg_class where relkind='m'` → 0 (o whitelist N0). | ⏳ pendiente |
| **R10** | **Toda función o procedure de `app`/`public` —`security definer` Y `invoker`— declara un `search_path` donde `pg_temp` aparece una sola vez, en la última posición, y no es el único elemento.** Única exención: una función que no lea ninguna relación **ni declare ningún tipo** (hoy, solo `app.current_user_id()`), nominada en el test **por esquema, nombre y aridad** — no por nombre suelto. | `pg_proc.proconfig`: la **primera** aparición de `pg_temp` es la **última posición**, y hay al menos dos elementos. Sobre `prokind in ('f','p')`. Más `has_database_privilege(rol, db, 'TEMPORARY')` = `false` para **todo rol no superusuario** de la base (R10 bis), y `app`/`public` como los **únicos** esquemas de dominio (R10 ter). | ✅ **verificado**, reescrita **dos veces** por el incidente #1 |
| **R11** | Las únicas `security definer` permitidas son `app.accessible_tenant_ids()` y `app.has_role_on()` (leen **tenancía**, no dominio). Otra requiere ADR. | Whitelist por nombre. | ✅ cumplido hoy; test pendiente |
| **R12** | **FK compuestas tenant-consistentes**: el hijo referencia `(cliente_id, id)` del padre, con `unique (cliente_id, id)` en el padre. Es la **única** integridad de tenant que sobrevive a `BYPASSRLS` y a `COPY`. | Por cada FK entre dos tablas con tenant, la FK incluye la columna de tenant en ambos lados. | ⏳ pendiente — **entra con el Módulo 1** |
| **R13** | `tenant_node.path` coherente con `parent_id` **siempre**: trigger en `insert` **y** en `update of parent_id`; el `path` no se edita a mano. | Trigger + `app.verificar_coherencia_path()` en CI **y como job en producción**. | ⚠️ **insuficiente — reemplazada por R36** (incidente #2). Medía **presencia** del trigger y **estado actual** del árbol; ninguna de las dos cosas es una garantía de **alcanzabilidad**. Estuvo ✅ toda la vida del esquema con el agujero adentro |
| **R36** | **El `path` de `tenant_node` es una FUNCIÓN de `(parent_id, nid)`, no un dato.** Para toda fila `n`, en **todo estado observable**: `n.path = coalesce(padre(n).path ‖ '.', '') ‖ n.nid`, con **`n.nid` inmutable**. Se verifica sobre el **estado físico** de la tabla y **no admite excepción**: ni por rol, ni por GUC (`app.reparentando` incluido), ni por vía de escritura (`UPDATE`, `MERGE`, `COPY`, multi-fila), ni por `BYPASSRLS`. **Y el caso legítimo es parte del enunciado**: `reparentar_nodo()` sobre un subárbol con descendientes, el alta, y el alta seguida de borrado o de baja lógica **en la misma transacción**, tienen que seguir commiteando. | **Se ejecuta el ataque, no se inspecciona el catálogo** — y cada ataque **con la identidad más privilegiada que corresponda**: `packages/data/tests/path-coherente.test.ts`, 20 casos. `app_request` mide el **privilegio**; `app_job` (`BYPASSRLS`, con grant sobre `path`) y el **dueño del esquema** miden el **invariante**. Más un bloque de **forma** que congela lo que ningún ataque puede distinguir (`confmatchtype`, `condeferrable`, `convalidated`, las ACL de columna) y un caso que **planta una incoherencia** y exige que el detector la vea. | ⚠️ **enunciado reescrito y mecanismo aplicado (`0017` + `0018`); ✅ recién cuando la mutación cierre limpia.** La ronda de cierre de `0017` dejó **7 de 27 mutaciones vivas** y `tester` encontró dos hallazgos ALTA. Marcarla ✅ ahora repetiría el error que el propio incidente #1 documenta |
| **R14** | Toda migración que crea una tabla con tenant incluye, en la misma migración: RLS enable+force, policies, índice, FK compuesta si aplica, y entrada en el registro de clasificación. | No se lee el diff: CI **aplica todas las migraciones sobre base limpia y corre R1–R13**. | ✅ el ciclo ya corre a mano (§C.0); falta cablearlo en CI |
| **R15** | **No hay super-raíz por encima de los estudios.** Cada estudio es raíz. Una super-raíz mete a todos los estudios en un subárbol: una policy mal escrita filtra el SaaS entero. | `tenant_node where tipo='estudio' and parent_id is not null` → 0. | ✅ **verificado** (T14) |

> 🔴 **Por qué R36 se enuncia sobre el PREDICADO y nunca sobre el mecanismo (incidentes #2 y #4).**
>
> La redacción anterior nombraba tres cosas del mecanismo de `0016`: que el chequeo **se difiere al
> commit**, que **re-lee el estado final**, y que trata **«no puedo leer la fila» como violación**.
> **Las tres cambiaron con `0017`**, y la regla habría quedado describiendo una implementación que ya
> no existe. Es exactamente el error de forma de R33, que nombraba en su propio enunciado la excepción
> que resultó ser el vector.
>
> Peor: **una de las tres era falsa.** Está medido que, con `security definer` puesto y `not found`
> tratado como no-op, el ataque original **sigue bloqueado** — por la comparación de coherencia, no por
> `not found`. Esa rama nunca fue un control: fue una **compensación por una ceguera autoinfligida**,
> porque el trigger era `invoker` y la RLS le tapaba justo la fila que tenía que validar. De ahí el
> corolario que gobierna esta regla, y que vale más allá de esta tabla:
>
> > 🔴 **Un invariante verificado con la visibilidad del escritor no es un invariante. Si el control
> > lee con los privilegios de quien escribe, quien escribe elige lo que el control ve.**
>
> **La consecuencia de diseño:** el invariante es **referencial**, y Postgres exime a `check`, `unique`
> y `foreign key` de la RLS **por diseño**; los triggers no. Meterlo en un trigger es lo que obligaba a
> `security definer`, que **viola R11** y pedía un ADR. Bajado al escalón que le corresponde, **R11 no
> se toca y no hizo falta ningún ADR**. El enunciado no lo nombra igual: si mañana `path` pasa a ser una
> columna generada —medido y postergado—, la regla **no cambia una palabra**. Ésa es la prueba de que
> está escrita en el nivel correcto.
>
> **🔴 Y R36 declara su premisa, en vez de esconderla.** No todas las patas del mecanismo sobreviven lo
> mismo, y decirlo por bloque en vez de por constraint es el sobre-enunciado que ya se pagó tres veces:
>
> | Pata | Qué la apaga |
> |---|---|
> | `tenant_node_path_chk`, `..._nulo_chk` | **nada**, salvo dropearla. Aguanta `session_replication_role` y `disable trigger all` |
> | `tenant_node_parent_path_fk` | 🔴 la integridad referencial **es un trigger de sistema**: `session_replication_role=replica` y `disable trigger all` **la apagan**. Pero las dos piden **superusuario** |
> | `trg_tenant_node_nid_inmutable` | 🔴 es un trigger de **usuario**: lo apaga `disable trigger user`, **que el dueño no superusuario SÍ puede correr**. El `CHECK` queda cubriendo el invariante; lo que se pierde es la inmutabilidad de `nid` |
>
> O sea: **el invariante sobrevive al dueño; la inmutabilidad de `nid` no.** R36 depende de una premisa
> que hoy **no se cumple en ningún entorno**: que el dueño del esquema no sea superusuario. Es la deuda
> abierta del incidente #1, y mientras siga abierta esta regla se apoya en ella.
>
> **Y la identidad con la que corre cada caso es parte de la regla, no un detalle del test.** La versión
> anterior probaba el ataque **sólo con `app_request`**; con `0017` ese rol ya no tiene grant sobre
> `path` ni `nid`, así que el ataque muere por `permission denied` **antes de llegar al invariante**. Un
> test así **se pone verde el día que alguien re-otorgue `grant … update on tenant_node to app_request`**
> copiando la plantilla de ADR-0001 §5 — que es el escenario de regresión realista, mucho más que un
> atacante. **Sin privilegio, el dueño y los jobs rompen el árbol en silencio; sin invariante, alcanza
> con un grant de más. Ninguno sustituye al otro.**
>
> **Lo que R36 deliberadamente NO cubre**, y por eso no es una violación del predicado: el minado del
> secuencial **global** de `nid` vía `overriding system value`. Cualquier valor de `nid` es
> **íntegramente válido** ⇒ no hay constraint que lo pueda rechazar. Lo cierra el **privilegio**, y el
> privilegio **no le aplica al dueño**. Residuo **declarado**, y vive en el incidente #4.
>
> 🔴 **Por qué R36 se chequea ejecutando el ataque y no mirando el catálogo (incidente #2, 2026-08-15).**
>
> La tentación es escribir *"existe el trigger `trg_tenant_node_path_coherente` sobre `tenant_node`"*.
> Esa regla habría pasado **verde con tres implementaciones rotas distintas**, las tres construidas
> durante este análisis:
>
> 1. la que valida dentro del `before update of path` que ya existía — **rompe `reparentar_nodo()`**,
>    incluso para un nodo hoja, y nadie se entera hasta la primera mudanza real de un cliente;
> 2. la que valida `NEW` en vez de re-leer la fila — ídem, porque un `AFTER` diferido ve la tupla del
>    **evento**, no la final;
> 3. 🔴 la que trata `not found` como *"nada que validar"* — **deja pasar el ataque completo**, porque
>    el atacante **se auto-oculta la fila que acaba de escribir**: el `path` que planta saca la fila de
>    su propio subárbol, `accessible_tenant_ids()` deja de devolverla, y el trigger —que es `invoker`—
>    recibe `found = false`. **Medido.**
>
> Las tres tienen el trigger, con el nombre correcto, enganchado a la tabla correcta. **La regla mide
> el comportamiento o no mide nada.** Y **el caso legítimo es parte de la regla**, no un extra: un
> control que sólo prohíbe pasa todos los tests negativos y rompe la operación — de las cuatro
> mutaciones probadas, **dos se detectan únicamente por el caso positivo**.
>
> La generalización que le faltaba al corolario de R10: **una aserción sobre la presencia de un
> control, o sobre el estado actual, nunca es una aserción sobre una garantía. La garantía es sobre
> alcanzabilidad.** Eso es lo que R13 no medía, y por eso estuvo ✅ toda la vida del esquema.
>
> **Y una regla de clase que sale de acá, todavía sin adoptar como número:** un GUC puede transportar
> **identidad** —`app.user_id` no concede nada por sí mismo, todo sale de filas de `membership`, y
> ante valor ausente falla cerrado— pero **nunca autorización**. `app.reparentando` apagaba un control
> directamente, y su interruptor estaba del lado del vigilado. Barrido: en todo el repo hay
> exactamente **dos** GUC de namespace y no hay un tercero. Adoptarla como regla numerada exige antes
> decidir si el GUC se elimina o queda como ergonomía — con `0016` ya no protege nada.
>
> 🔴 **Por qué R10 está redactada así, y no como estaba (incidente #1, 2026-08-15).**
>
> La versión anterior decía *"toda función `security definer` fija `search_path`"* y el test miraba
> que `pg_proc.proconfig` tuviera una entrada. **Pasó verde con la vulnerabilidad adentro durante los
> cinco días de vida del esquema**: `accessible_tenant_ids` y `has_role_on` fijaban
> `search_path = public, app`, o sea que cumplían la letra y eran explotables igual — **`pg_temp` se
> busca PRIMERO para nombres de relación y de tipo aunque no esté listado**, así que cualquiera con
> privilegio `TEMPORARY` plantaba una `membership` falsa y anulaba la RLS de toda la instancia.
>
> Las dos cosas que la regla nueva corrige, y las dos importan:
>
> 1. **Mide la posición, no la presencia.** "Fija alguno" era la pregunta equivocada; la pregunta es
>    si el que fija **neutraliza `pg_temp`**.
> 2. **No se filtra por `prosecdef`.** Cuatro de las seis funciones vulnerables eran **`invoker`** —
>    entre ellas `app.exigir_nodo_cliente()`, que es el renglón (3) de la plantilla de ADR-0001 §5 y
>    vive en 15 tablas de dominio. Una R10 acotada a `security definer` seguiría verde con ella
>    desprotegida: la misma falla, movida un renglón.
>
> Y la exención de `current_user_id()` no es comodidad: una cláusula `SET` **inhabilita el inlining de
> funciones SQL**, y esa función se inlinea dentro de `has_role_on` y de las policies — medido, **+75 %**
> sobre el predicado de RLS de toda tabla de dominio. No la necesita porque `pg_temp` **nunca** se
> busca para nombres de función.
>
> 🔴 **Segunda reescritura, el mismo día, por la misma causa.** La primera versión de esta regla
> corregida decía *"`search_path` **terminado** en `pg_temp`"*. También estaba mal, y `qa-automation`
> lo encontró por mutación: **PostgreSQL resuelve por PRIMERA aparición** y descarta las repetidas.
> Medido con `current_schemas(true)`:
>
> ```
> search_path = pg_catalog, public, app, pg_temp  →  pg_catalog | public | app | pg_temp_N   SEGURO
> search_path = pg_temp, public, app, pg_temp     →  pg_catalog | pg_temp_N | public | app   VULNERABLE
> search_path = pg_temp                           →  pg_catalog | pg_temp_N                  VULNERABLE
> ```
>
> Los dos vulnerables **terminan** en `pg_temp` y pasaban verde, leyendo la trampa plantada igual que
> el patrón pre-`0015`. Por eso la regla dice **primera aparición = última posición, y al menos dos
> elementos**: "termina en" describe la *forma* del `search_path`; lo que hay que garantizar es su
> *efecto*. Es literalmente la misma falla que motivó la reescritura, cometida de nuevo un renglón
> más abajo — y la evidencia más fuerte que tenemos de que **el corolario de acá abajo no es un
> adorno retórico**.
>
> Corolario para quien escriba la próxima regla: **una regla verificable que mide lo que es fácil de
> medir, en vez de lo que hay que garantizar, es peor que no tenerla** — porque además da confianza.
> Y el único método que lo detecta a tiempo es la **prueba por mutación**: las dos versiones malas de
> R10 se veían perfectamente razonables leyéndolas, y las dos cayeron al primer intento de romperlas
> a propósito.

### B.2. Contexto de tenant, pooling y roles de base

| # | Regla | Cómo se chequea | Estado |
|---|---|---|---|
| **R16** | El contexto se setea **solo** con `set_config('app.user_id', $1, true)` **dentro de una transacción explícita**. Prohibido `SET`/`SET SESSION app.*` y `set_config(…, false)`. | ESLint `no-restricted-syntax` + barrido de texto sobre `**/*.ts` y `**/*.sql`; assert en runtime en el helper. | ⏳ pendiente (no hay código) |
| **R17** | **Un único punto de conexión con contexto:** `conUsuario(usuarioId, fn)` en `packages/data` (ADR-0001 §6). Ningún módulo fuera de `packages/data/src/db/` importa el pool ni llama a `drizzle()`. | `dependency-cruiser` / `no-restricted-imports` + test de conteo. | ⏳ pendiente |
| **R18** | `DATABASE_URL_JOB` (BYPASSRLS) **no se lee** desde el proceso que atiende pedidos. Y **guard de arranque**: el proceso de request consulta `select rolbypassrls, rolsuper from pg_roles where rolname = current_user` y **no arranca** si alguno es true. **Extendido al CLI y a todo proceso que toque datos de un cliente** — el CLI es el caso *más* expuesto, no una excepción: se corre a mano en una terminal donde suele estar exportado el DSN del dueño del esquema porque hace cinco minutos alguien corrió una migración, y ahí la RLS se apaga sin que nadie lo decida. El guard corre **antes de abrir el archivo**: si va a abortar, que aborte sin el extracto de un cliente en memoria. | Test de que la variable no aparece en el árbol de la app + el guard + `apps/cli/tests/ingestar.test.ts` | ✅ **implementada y verificada** |
| **R19** | `app_job` se usa **solo** para una whitelist: migraciones, alta del estudio raíz, `app.reparentar_nodo`, mantenimiento, y export de un cliente archivado. **La ingesta bancaria NO está en la lista.** Cada uso lleva comentario `-- BYPASSRLS: <motivo>` y escribe en `acceso_auditoria`. | Whitelist de rutas en el test. | ✅ **acotado en la base**: `app_job` solo tiene DML sobre `tenant_node` y `membership`; sobre dominio no tiene nada (y sobre `acceso_auditoria`, **nada** — verificado en P1-0) |
| **R20** | **La ingesta del Módulo 1 corre con `app_request`**, con un usuario de servicio con membresía en el nodo cliente del lote. El handler recibe `clienteId` obligatorio y la RLS lo re-verifica. | Test de integración: el job completo corre con el pool `app_request` → **debe pasar**. Si alguien lo hace depender de `app_job`, rompe. | ⏳ entra con el Módulo 1 |
| **R21** | **Prohibido `COPY … FROM` sobre tablas de dominio.** La carga masiva entra a **staging por lote** (con `cliente_id` y RLS) y pasa a dominio con `insert … select` como `app_request` **con contexto**, para que `with check` se evalúe fila por fila. | Barrido de texto en migraciones y código. Motivo: `COPY FROM` con el owner o con BYPASSRLS **funciona y saltea las policies** — es el atajo que va a aparecer cuando la ingesta sea lenta. | ⏳ entra con el Módulo 1 |
| **R22** | Pooler **solo en transaction mode**. Chequeo de arranque: `set_config(…,true)` sobrevive dentro de la transacción y **no** fuera. | Test de humo contra el DSN; en statement mode el proceso no arranca. | ⏳ pendiente |
| **R23** | El conjunto accesible **no se cachea en memoria de la app**: se resuelve en la base en cada transacción. | `grep` de cache/memoize + INV-10. | ✅ por diseño (la función corre en la base) |
| **R24** | La autorización **nunca** sale de datos que informa el cliente. El `cliente_id` que llega por request es un **filtro**, no una autorización. Pedir un recurso ajeno devuelve **404**, no 403 (un 403 confirma existencia). | Tipos: el service recibe una `Sesion` opaca construida server-side, nunca un `rol` de entrada. | ⏳ pendiente |
| **R25** | Prohibido exponer `tenant_node.nid` (bigint secuencial) en API, URL o export: enumera cuántos estudios/clientes tiene la plataforma. Los ids públicos son uuid. | Test de contrato sobre los esquemas Zod de respuesta. | ⏳ pendiente |

### B.3. Salida de datos: logs, errores, exports, storage

| # | Regla | Cómo se chequea | Estado |
|---|---|---|---|
| **R26** | Un solo logger, con redactor derivado del registro de §A.3. Prohibido `console.*` en `apps/**` y `packages/**`. | `eslint no-console` + test. | ⏳ pendiente |
| **R27** | El segundo parámetro del logger es un tipo cerrado que **no acepta** claves N2/N2-R/N3. Prohibido pasar una fila cruda o un objeto de dominio al logger. | Enforcement en tipos + test de que `logger.info(msg, filaMovimiento)` **no compila**. | ⏳ pendiente |
| **R28** | Prohibido propagar el error crudo del driver. **Nunca** loguear `detail`/`where` de Postgres (traen valores de fila: `Key (cbu)=(…) already exists`) ni el SQL con parámetros. | Forzar una violación de unicidad y assert de que el log no contiene el valor. | ⏳ pendiente |
| **R29** | Postgres en todos los entornos: `log_statement='none'`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`. | Chequeo de arranque contra `pg_settings`. | ⏳ pendiente |
| **R30** | Ningún dato ≥ N2 en **URL, path, query string ni nombre de archivo** (termina en access logs, historial, `Referer`, logs de CDN). La clave del objeto en storage es `cliente/<uuid>/<tipo>/<uuid>` — **nunca** CUIT, razón social ni el nombre original del archivo. | Test de contrato de rutas + barrido del módulo de storage. | ✅ decidido en ADR-0000 §3.3; test pendiente |
| **R31** | El acceso a objetos pasa por un **único emisor** de URL firmada que (a) verifica membresía, (b) escribe auditoría, (c) usa TTL en minutos. Bucket privado, sin listado. | Test de que `getSignedUrl` no se invoca fuera de ese módulo; un GET sin firma da 403 y la firma vencida deja de servir. | ⏳ pendiente |
| **R32** | Toda lectura y export de N2-R y todo uso de N3 escribe en **`acceso_auditoria`**, que es **append-only**. | `has_table_privilege('app_request','acceso_auditoria','UPDATE'/'DELETE')` = false. | ✅ **tabla creada y verificada** (T13 + P1-0: ni `app_job` puede borrarla). El cableado del choke point es pendiente |
| **R33** | Ningún secreto en el repo. Escaneo de secretos en pre-commit **y** en CI. `.env*` gitigneado salvo `.env.example`, que tiene **solo nombres**. | Secret scanning en el pipeline. | ❌ **insuficiente — reemplazada por R37** (incidente #3). La regla **nombraba la excepción que resultó ser el vector** (*"salvo `.env.example`"*), su condición (*"solo nombres"*) no se chequeaba en ningún lado, y su propio campo de estado decía «existe con valores de desarrollo evidentes» — o sea que **el defecto estuvo escrito, en esta tabla, todo el tiempo** |
| **R34** | Ningún comando destructivo o de seed corre contra un host fuera de la allowlist de entornos no productivos; ningún `DATABASE_URL` de producción en `.env` local. | El comando aborta si el host del DSN no está en la allowlist. | ⏳ pendiente |
| **R35** | Mandar algo ≥ N2 a un servicio externo requiere entrada en `docs/seguridad/registro-terceros.md` con qué se manda, con qué base y quién lo autorizó. | La lista de destinos de red permitidos es explícita; una URL externa nueva sin entrada → falla. | ✅ registro creado (vacío) |
| **R37** | **Ningún archivo TRACKEADO contiene un valor de credencial** — se llame como se llame. Tres formas: **(a)** ningún archivo con forma de entorno (`.env`, `.env.<lo que sea>`) está trackeado; **(b)** ningún archivo trackeado contiene una URL con credenciales embebidas (`<esquema>://<usuario>:<secreto>@`); **(c)** ninguna clave `UPPER_SNAKE` de nombre secreto se asigna a un literal que no sea marcador. Los permitidos de (c) llevan **motivo escrito** y no pueden apuntar a un archivo que ya no existe. 🔴 **Y ningún permitido exime de lo siguiente: un literal que coincida con un valor de un `.env*` real de la máquina es violación siempre.** | `tools/barrido-credenciales.test.ts` sobre **`git ls-files`** — lo que importa es qué está *trackeado*, que es lo único que puede viajar a un remoto. Cada forma se prueba **plantándola en un repositorio git sintético** y exigiendo que el barrido la nombre; más control de vacuidad (`> 100` archivos vistos). | ⚠️ **INSUFICIENTE — el mecanismo no llega al enunciado. Se corrige junto con `0017`.** El enunciado es correcto; la implementación tiene tres huecos medidos. **(1)** `${VAR:-default}` bajo una clave de nombre secreto es **sistemáticamente invisible**: el match captura la interpolación entera, que empieza con `$`, y `esMarcador` la descarta — o sea que la forma que el commit afirma haber cazado en `docker-compose.yml` es precisamente la que **no** caza (las encontró una persona leyendo). Prueba de control: `docker-compose.piloto.yml` conservaba un default horneado y el barrido daba **cero**. **(2)** El cruce con los `.env*` vivos —el 🔴 que *«ninguna allowlist puede eximir»*— corre **después** de `esMarcador` y solo dentro del loop del regex de asignación: una credencial viva que empiece con `ejemplo` o `changeme`, o que esté en prosa de un `.md`, en JSON o en minúscula, **nunca llega al cruce**. Medido: hay dos valores vivos en `HANDOFF.md` y el barrido reporta verde. **(3)** No corre en pre-commit ni puede estar verde en CI —sin `.env` el control de vacuidad se pone rojo—. Mutación: **23 corridas, 7 sobrevivientes** |
| **R37 bis** | **`.gitignore` no tiene ninguna negación (`!`) que vuelva a admitir un archivo de entorno.** | `negacionesDeEnv()` = `[]`, y el test comprueba que **sí** detecta una reintroducida. | ✅ **verificado** |
| **R38** | **El sujeto de un control no escribe el registro que lo constituye.** Ninguna identidad de tenant —`socio` incluido— puede **desactivar, borrar ni degradar** la membresía de un **rol supervisor** (`auditor`, `admin_plataforma`), y **toda** escritura sobre `membership` deja una fila en un rastro **append-only que escribe la base, no la aplicación**, con un autor y una marca de tiempo **que el escritor no puede elegir**. El caso legítimo es parte del enunciado: **INV-10 sigue rigiendo** — revocar la membresía de un rol no supervisor tiene que cortar el acceso en el request siguiente. | **Se ejecuta el ataque**, con el rol del atacante real (un `socio` sobre su propio estudio) y **con la escritura que sí tiene permitida**, para que el caso no pueda pasar por un `permission denied` del privilegio: `packages/data/tests/membership-supervision.test.ts`, 13 casos en cuatro bloques —**privilegio**, **policy**, **legítimo** y **rastro**— que miden las tres patas por separado. | ⚠️ **INSUFICIENTE — `0019` cierra el ataque LITERAL del #5, no la clase. Vuelve a taller.** La ronda de cierre dejó **11 de 28 mutaciones vivas** y **dos bloqueantes reproducidos**: 🔴 **(1)** `tenant_node.deleted_at` reproduce el resultado entero **sin tocar `membership` y sin una sola fila de rastro** — `accessible_tenant_ids()` exige `deleted_at is null` sobre el nodo de la membresía, así que el socio expulsa al supervisor **y le apaga la vista del rastro** en la misma sentencia (medido: el auditor pasa de ver 2 filas de rastro y 1 nodo, a **0 y 0**, con las 2 filas **intactas en disco**). El rastro tiene interruptor, y lo maneja el auditado. 🔴 **(2)** `membership_historia_ins` **no mira el rol**: el `socio`, el `administrativo`, el `cliente_lectura` y **el propio `auditor`** pueden fabricar filas **indistinguibles de las que escribe el trigger** — medido, incluida una que afirma que se borró la membresía del auditor. Y `app_job` (BYPASSRLS, con `grant update (activo)` que **no usa nadie**) expulsa a la supervisión **de todos los tenants en una sentencia**, dejando `hecho_por = null` — el mismo valor que el nulo legítimo, o sea **indistinguible de una migración**. La corrección de fondo —que el rastro lo escriba una función `security definer` en vez de depender de un grant abierto al tenant— **choca con R11 y es decisión de arquitectura**, no un parche |

> 🔴 **Por qué R37 reemplaza a R33, y por qué mide la clase y no el archivo (incidente #3, 2026-08-15).**
>
> R33 decía lo correcto —*"ningún secreto en el repo"*— y **nombraba en su propio enunciado la
> excepción que fue el vector**: *"`.env*` gitigneado **salvo `.env.example`**, que tiene solo
> nombres"*. Las dos mitades fallaron a la vez. La excepción existía porque un archivo de ejemplo es
> útil; la condición que la volvía segura —*"solo nombres"*— **no se chequeaba en ningún lado**. Y el
> campo de estado de R33 decía, textualmente, *"`.env.example` existe con valores de desarrollo
> evidentes"*: **el defecto estuvo escrito en esta misma tabla durante toda la vida del repo**, y
> nadie lo leyó como lo que era.
>
> Es la tercera vez en un día que aparece el mismo patrón —R10 dos veces, R13, ahora R33—, y con una
> vuelta de tuerca peor: acá la regla ni siquiera pasaba verde por medir mal, **pasaba amarillo
> admitiendo la falla**. Un estado ⚠️ que nadie convierte en trabajo es un ✅ con más letras.
>
> Las tres decisiones de forma de R37, y las tres salen de eso:
>
> 1. **Barre `git ls-files`, no el filesystem.** La pregunta no es *"¿qué archivos hay?"* sino *"¿qué
>    está trackeado?"* — lo único que puede viajar a un remoto. Un archivo con secretos en disco pero
>    ignorado no es el incidente; uno trackeado sí.
> 2. **No mira nombres de archivo: mira contenido.** Ignorar `.env.example` cierra **el caso**. La
>    **clase** es *"un archivo que documenta variables se fue llenando de valores"*, y eso pasa igual
>    en un `docker-compose.yml`, un workflow de CI, un `.md` del runbook o un script de despliegue.
>    Al correrla por primera vez, R37 encontró credenciales en **cuatro archivos más** — ninguno se
>    llamaba `.env`.
> 3. 🔴 **El cruce con los `.env*` vivos, que no se puede permitir por allowlist.** Ésta es la falla
>    del #3 en una línea: el valor "de ejemplo" y la credencial **viva del piloto** eran la misma
>    cadena. Un literal descartable de CI es aceptable; el mismo literal siendo además la credencial
>    de un entorno real, no — y esa distinción **ninguna lista de excepciones tiene derecho a
>    hacerla**. Es el equivalente del `revoke temporary` de `0015`: la mitad que cierra la clase
>    entera, no el caso.
>
> Corolario, para no repetirlo una quinta vez: **el campo de estado de esta tabla es parte de la
> regla, no una nota al pie.** Un ⚠️ que describe una violación concreta es un incidente que todavía
> no se abrió.


> 🔴 **Por qué R38 exige las TRES patas, y por qué ninguna sustituye a las otras (incidente #5).**
>
> La lección es **distinta** de la del #4, y por eso el incidente va en su propia fila. El #4 es sobre
> lo que un control **puede ver**: *un control de integridad que corre bajo RLS hereda la ceguera de la
> RLS*. El #5 es sobre lo que un control **tiene autoridad para decidir**:
>
> > 🔴 **La RLS decide QUIÉN escribe una fila, nunca QUÉ DICE la fila. Cuando la fila es la que define
> > quién es quién, esa distinción exacta es la vulnerabilidad.**
>
> 🔴 **Y la ronda de cierre le agregó la mitad que faltaba, que es la que `0019` no cubre:**
>
> > **La RLS también decide qué fila EXISTE para el que mira — y ese predicado lo alimenta una
> > columna que el auditado escribe.** Un rastro cuya visibilidad depende de un `boolean` del
> > auditado es un rastro con interruptor.
>
> Por eso R38 está en ⚠️ y el incidente #5 **no se cierra con `0019`**: las tres patas que la
> regla enumera son correctas y están construidas, pero **ninguna de las tres mira el camino de
> `deleted_at`**, y el rastro que la pata 1 crea es escribible por el tenant entero.
>
> Y el corolario que lo vuelve de este dominio y no de un manual: **el padrón de acceso es un dato de
> seguridad, no un dato de dominio.** En los incidentes #1 y #2 la única medición forense que dio
> positiva —la que sostiene *«no hay evidencia de escalada persistente»*— fue **«cero membresías
> inesperadas en las dos bases»**. El #5 establece que ese estado era **editable y borrable por el
> propio sujeto auditado, sin dejar fila**: degrada **retroactivamente** la fuerza de esa evidencia, y
> por eso las dos filas quedaron **anotadas**.
>
> **Las tres patas, y qué deja abierto quitar cada una** — medido por mutación, no razonado:
>
> | Si falta… | Qué queda vivo |
> |---|---|
> | la **policy** sobre el rol de la fila tocada | el socio desactiva al auditor. **4 casos en rojo** |
> | el **grant por columna** | cambia el `rol` del auditor a `contador` y esquiva cualquier predicado sobre `rol`; y **borra** la fila. **2 casos en rojo** |
> | el **rastro** | todo lo anterior pasa sin dejar constancia, y **el intento tampoco queda**. **4 casos en rojo** |
>
> **La mutación sutil, que es la que vale:** dejar el predicado **sólo en el `with check`** y no en el
> `using`. El `with check` gobierna la fila **que queda**, y como el socio **no cambia el `rol`** al
> desactivar, la fila resultante sigue siendo del auditor y el predicado la sigue aceptando. **3 casos
> en rojo.** Una regla que sólo mirara el `with check` se vería perfectamente razonable.
>
> **Por qué el rastro no puede vivir en `acceso_auditoria`, y es mecánico antes que semántico:** su
> trigger `trg_acceso_auditoria_cliente` exige un nodo de tipo `cliente` activo, y una membresía de
> `socio`, `auditor` o `admin_plataforma` cuelga del nodo **estudio** — **la fila no entra**. Y
> semánticamente responden preguntas distintas: `acceso_auditoria` es *«quién vio qué dato fiscal»*;
> esto es *«quién puede ver, desde cuándo, y quién lo decidió»*. Precedente en el repo, con la misma
> forma: `credencial_fiscal` + `credencial_fiscal_rotacion`.
>
> **Y lo escribe un TRIGGER, no la aplicación.** Es la lección del #1 en una línea: `acceso_auditoria`
> se escribe desde la aplicación, y **el vector del #1 no pasaba por la aplicación**. Un rastro que
> depende de que el escritor coopere no sirve contra un escritor hostil. Por la misma razón `hecho_por`
> y `ocurrido_en` salen de un `DEFAULT` y **nadie tiene grant sobre esas columnas** — cierra por
> construcción el defecto que `acceso_auditoria` **sí tiene hoy**, donde el auditado elige la marca de
> tiempo.
>
> **La decisión de negocio que R38 encapsula, y que se revierte en una línea:** los roles supervisores
> son `auditor` y `admin_plataforma`, en `app.es_rol_supervisor()`. `admin_plataforma` es
> **estructural** —es staff de la plataforma, no del estudio—, y que el titular de un tenant pueda
> expulsarlo deja al operador sin intervención sobre un tenant que sigue custodiando datos fiscales de
> **terceros**, que no son parte de esa relación ni la pueden observar. `auditor` es **la decisión**:
> existe para mirar lo que el socio hace, y la policy de lectura de `acceso_auditoria` ya lo reconoce
> al restringir el rastro a `socio` **y** `auditor` y a nadie más.


> 🔴 **ADVERTENCIA PROBATORIA — vigente mientras `0019` no se rediseñe (2026-08-16).**
>
> **Una fila de `membership_historia` NO es evidencia confiable por sí sola: pudo haber sido
> fabricada.** El `insert` sobre esa tabla está otorgado a `app_request` sin mirar el rol, así que
> **cualquier identidad con acceso al nodo** —`socio`, `administrativo`, `cliente_lectura` y **el
> propio `auditor`**— puede escribir filas **indistinguibles de las que escribe el trigger**:
> misma tabla, mismas columnas, y `hecho_por` puesto por el mismo `DEFAULT`. **No hay ninguna
> columna que diga «esto lo escribió la base».** Medido en la ronda de cierre de `0019`, incluida
> una fila fabricada que afirma que se borró la membresía de un auditor — una operación que `0019`
> volvió imposible.
>
> **Y la ausencia de una fila tampoco prueba nada:** `tenant_node.deleted_at` esconde el rastro de
> un nodo entero de la vista de quien supervisa, sin borrar una sola fila del disco.
>
> **Qué SÍ se puede hacer con este rastro, hoy:** reconstruir de buena fe una secuencia de cambios,
> y usarlo como **indicio** que hay que corroborar contra otra fuente. **Qué NO:** sostener una
> imputación contra una persona, ni afirmar que un cambio de derecho no ocurrió porque no figura.
>
> 🔴 **Esto NO afecta al control.** El ataque del incidente #5 —expulsar a la supervisión— queda
> bloqueado **de forma independiente**: medido en nueve escenarios, con y sin filas fabricadas, en
> transacciones separadas y en la misma, los supervisores quedan **2/2 activos** en todos. La
> policy `membership_wr` **no menciona `membership_historia`** (verificado sobre `pg_policy`): las
> filas falsas son **ruido, no privilegio**. El daño es a la **trazabilidad**, no al control.
>
> Esta advertencia se levanta cuando el rediseño cierre los dos bloqueantes, y **no antes**.

---

## C. Invariantes de aislamiento y su verificación

### C.0. Lo que ya está verificado contra Postgres real

`packages/data/sql/tests/0001_aislamiento.test.sql` — **18 aserciones, todas pasando** contra
PostgreSQL 16.13 en Docker, aplicando la migración sobre una base limpia. Se corre en **tres pasadas,
cada una con el rol que le corresponde**, y esa separación es parte de lo que se prueba:

| Aserción | Qué prueba |
|---|---|
| **P1-0** | Ni `app_job` (BYPASSRLS) puede borrar `acceso_auditoria` |
| **P1-A** | El árbol nace coherente (`path` = path del padre ‖ `nid`) |
| **P1-B** | Editar `tenant_node.path` a mano está rechazado |
| **P1-C** | Cambiar `parent_id` **recalcula** el path (el bug H-1) |
| **P1-D** | `app.reparentar_nodo` mantiene coherencia y rechaza ciclos |
| **T1** | **Sin identidad → 0 filas, 0 nodos, 0 membresías** (falla cerrado) |
| **T2 / T3** | El contador de A ve solo A; el de B solo B (los dos sentidos) |
| **T4** | El socio hereda el subárbol: ve A y B, nada del otro estudio |
| **T5** | Un estudio no ve nada del otro |
| **T6** | **`.7` no ve `.70`** (la trampa del prefijo de path) |
| **T7** | No se puede insertar en un cliente ajeno (`with check`) |
| **T8** | Una fila de dominio solo cuelga de un nodo `cliente` |
| **T9** | Toda tabla con `cliente_id` tiene RLS **habilitada y forzada** |
| **T10** | Ninguna policy con predicado abierto ni escritura sin `with_check` |
| **T11** | 🔴 **Ninguna función de `app`/`public` puede ser secuestrada por `pg_temp`** — `definer` **e** `invoker`: la **primera** aparición de `pg_temp` es la **última** posición y hay ≥2 elementos (R10), ningún rol no superusuario conserva `TEMPORARY` (R10 bis), y `app`/`public` son los únicos esquemas de dominio (R10 ter). *La redacción anterior —«toda función `security definer` fija `search_path`»— era la R10 original, que estuvo verde toda la vida del esquema con el incidente #1 adentro: las funciones vulnerables **sí** fijaban `search_path`.* |
| **T15** | El `path` es una **función** de `(parent_id, nid)`: ninguna transacción que rompa el predicado commitea, **con ninguna identidad** — incluidos `app_job` (BYPASSRLS) y el dueño del esquema (R36) |
| **T16** | Ni `app_request` ni `app_job` escriben `nid`; `app_request` tampoco `path`, `parent_path` ni **`parent_id` en un `UPDATE`** — mover un nodo es de `app.reparentar_nodo()` con `app_job` (`0017` §7, `0018`) |
| **T12** | `app_request` no saltea RLS ni es superusuario |
| **T13** | `acceso_auditoria` es append-only para el rol de request |
| **T14** | Cada estudio es raíz: no hay super-raíz de plataforma |

### C.0.bis. La suite de TypeScript — 72 tests, todos pasando

`pnpm verificar` = `pnpm typecheck` (TypeScript estricto) + `pnpm test`:

| Archivo | Qué cubre | Tests |
|---|---|---|
| `packages/data/tests/catalogo.test.ts` | R1–R15 sobre el catálogo de Postgres, después de aplicar las migraciones sobre base limpia. Incluye la **verificación del verificador**: crea a propósito una FK simple entre tablas de dominio y comprueba que el chequeo la marca. | 28 |
| `packages/data/tests/aislamiento.test.ts` | Los invariantes a través del código real (`conUsuario`/`conJob`): guard de arranque, INV-2, INV-3, INV-4, INV-10, el choke point de auditoría, el chequeo de rol en lectura y la FK compuesta. | 19 |
| `packages/data/tests/reglas-de-codigo.test.ts` | R16, R17, R26, R30 por barrido de texto sobre el repo, sin sumar un linter. | 8 |
| `packages/shared/tests/redactor.test.ts` | El registro de clasificación, el redactor, y el **barrido INV-8** sobre los tres caminos dorados con sus rutas de falla. Incluye el **límite conocido** del redactor (ver abajo). | 17 |

**Cuatro cosas que salieron de correrlo y no de suponerlo**, y que quedaron escritas donde corresponde:

- **`INSERT ... RETURNING` aplica también la política de `SELECT`.** En una tabla append-only —donde
  muchos roles escriben y pocos leen— el `returning` falla con *"new row violates row-level security
  policy"*, un mensaje que hace pensar que el problema es la escritura cuando la escritura está
  perfecta. El id de correlación pasó a generarlo la aplicación
  (`migrations/0003_auditoria_correlacion.sql`).
- **El redactor NO puede tapar una razón social.** Es texto sin patrón: ningún regex la distingue de una
  palabra cualquiera. El barrido INV-8 falló justamente ahí, con el nombre de un archivo dentro de un
  `Error`. Conclusión: **el redactor es la red, no la defensa**; la defensa es el tipo cerrado que
  rechaza la clave en compilación y la regla de no construir mensajes de error con datos del cliente.
  Queda como test explícito, para que nadie confíe en el redactor para algo que no puede hacer.
- **El tipo del logger encontró un error en la documentación de este ADR.** El ejemplo de §D usaba
  `motivo=ordenante_desconocido`, y `motivo` es una columna clasificada N2: no compila. Corregido a
  `motivo_codigo` (un código, no prosa) acá y en el código.
- **Limpiar no es una operación de la aplicación.** Ni `app_job` ni `app_request` pueden borrar el
  rastro de auditoría ni las credenciales, y como esas tablas referencian `tenant_node` con `on delete
  restrict`, la limpieza de los tests tiene que hacerla el dueño del esquema con `TRUNCATE`.

**Dos cosas más que salieron de correrlo**, ya escritas en el test SQL:

1. **El dueño del esquema no puede sembrar el nodo raíz**: `force row level security` le aplica las
   políticas también a él y no hay ninguna que permita crear un nodo sin padre. Tiene que hacerlo
   `app_job`. Corolario para producción: **el dueño del esquema no debe ser superusuario** (un
   superusuario ignora RLS siempre, forzada o no).
2. **`BYPASSRLS` saltea políticas, no otorga privilegios**, y los **atributos** de rol no se heredan por
   pertenencia (`GRANT`). Por eso `app_job` es el rol que se conecta y necesita `GRANT` explícito.

### C.1. Invariantes pendientes de test (entran con el código)

Formato: **qué no puede pasar nunca** → **así se rompe** → **test**.

**INV-5 — Un reporte agregado nunca mezcla clientes, ni por totales, ni por conteos, ni por "otros".**
*Se rompe:* una matview poblada como owner; un `group by` sin el tenant; un `count(*)` "de todos los
movimientos del período" para un porcentaje.
*Test canario:* cliente A con importes conocidos; cliente B con un movimiento **canario**
(`999999.99`, `CANARIO SRL`, CBU canario). Generar **cada** reporte y export para A como usuario de A y
verificar: los totales igualan exactamente la suma de A; el canario no aparece en ningún campo, ni en
`count`/`min`/`max`/`avg`, ni en un bucket "otros", ni en el denominador de un porcentaje; serializar el
reporte completo a texto y buscar el canario → 0 matches; y la generación **no** usó el pool de `app_job`.

**INV-6 — El job de ingesta nunca escribe en el cliente equivocado, ni con un archivo mal atribuido.**
*(Es el Módulo 1 y es el camino más riesgoso de todo el sistema.)*
*Se rompe:* el extracto se atribuye por CBU y el CBU pertenece a otro cliente; el dedupe por hash es
global; el job corre con `app_job` y la RLS no lo frena.
*Test:* lote declarado para A con archivo cuyo CBU resuelve a una cuenta de B → el lote queda
`rechazado` con motivo `cuenta_no_pertenece_al_cliente`; **0 filas nuevas** en A y en B; la **FK
compuesta** (R12) lo rechaza también bajo `app_job`; el log no contiene el CBU; el rechazo queda
auditado. Segundo caso: el mismo CBU cargado en dos clientes → **no se elige uno por probabilidad**, va
a revisión humana. Tercer caso: movimiento idéntico en A y en B → **ambos existen** (dedupe es
`unique (cliente_id, fila_hash)`, nunca global).

**INV-8 — Nada de N2/N2-R/N3 en logs, errores ni telemetría.**
*Test (el más valioso, porque compara contra los valores reales del fixture, no solo contra regex):*
fixture con un set conocido de valores sensibles; correr los tres caminos dorados (ingesta de extracto,
error de conciliación, consulta de padrón) **y sus rutas de falla**; capturar todo el output del logger,
stderr y el payload que iría al error tracking; esperar **0 ocurrencias** de cualquier valor del set y 0
matches de los detectores (CUIT, CBU de 22 dígitos, `-----BEGIN`, base64 largo) — **y sí** presencia de
`request_id`, `cliente_id`, `lote_id` y código de error, para que el test no se pase "no logueando nada".

**INV-9 — Ningún dato aprendido cruza clientes.**
*Se rompe:* el motor de conciliación guarda `alias_ordenante` o reglas aprendidas **sin** `cliente_id`
"porque el banco es el mismo". Después, en el cliente B, **sugiere** una contraparte que solo existe en
A → revela una relación comercial. Es secreto fiscal filtrado por una sugerencia de UI, sin que ninguna
fila cruce de tabla.
*Test:* conciliar en A creando un alias; como usuario de B, pedir sugerencias para un movimiento
equivalente → la de A no aparece. Más: toda tabla del motor tiene `cliente_id`, salvo whitelist N0
(entidades bancarias, tipos de comprobante).

**INV-10 — Revocar una membresía corta el acceso en el request siguiente.**
*Test:* usuario de A lee 1 fila; `update membership set activo = false`; **con el mismo token**, lee →
0 filas. Sin reinicio, sin esperar TTL.

**INV-11 — No hay soporte de plataforma con acceso permanente ni silencioso.**
*Test:* toda membresía de soporte tiene vencimiento, motivo y autorizante; expirada,
`accessible_tenant_ids()` la excluye. Y `admin_plataforma` **sale** de las policies de escritura de
dominio.

**INV-4 — El contexto de un request no sobrevive a otro en la misma conexión física.**
*Test:* pool de tamaño **1**; request 1 completa y libera; request 2 sobre la misma conexión sin setear
contexto → `current_setting('app.user_id', true)` vacío y 0 filas. Y assert en el helper: si al abrir la
transacción el setting **ya** viene con valor, **abortar** (es una fuga de sesión).

**INV-12 — Coherencia del árbol en producción, no solo en CI.**
`app.verificar_coherencia_path()` corre como **job periódico en producción** y alerta como incidente.
Complemento: un **tenant canario** en producción con una sonda que alerta si alguna vez ve un dato ajeno.
**Detección, no solo prevención.**

---

## D. Logging y observabilidad

**Permitido (N0/N1):** `request_id`, `trace_id`, `user_id`, `estudio_id`, `cliente_id`, `lote_id`,
`movimiento_id` (todos uuid), nombre de la operación, tabla afectada, **conteos**, duración, código de
error propio, estado del job, formato detectado, `sha256` truncado del archivo.

**Prohibido (≥ N2), sin excepción por nivel `debug`:** importes, saldos, CUIT/CUIL, CBU/cuenta/alias,
razón social o nombre de persona, **descripción del movimiento** (lleva el nombre de la contraparte),
nombre original del archivo, contenido o fragmento del extracto, payload del webservice, tokens, SQL con
parámetros, `detail`/`where` del error de Postgres, cualquier objeto de dominio serializado completo.

> **Regla de oro:** *el uuid del registro y el código de error alcanzan para depurar; el extracto no.*
> Si con el uuid no se puede depurar, el problema es la observabilidad del dominio, no el permiso de
> loguear.

### D.1. Tres escenarios, línea por línea

**Ingesta de un extracto bancario**

❌ inaceptable
```
INFO Procesando extracto "Metalúrgica SA - Banco X 0170-1234-5678901234 - julio.pdf"
INFO Movimiento 12/07 TRANSFERENCIA DE PROVEEDORES DEL SUR SRL CUIT 30-12345678-9 $1.482.350,00 saldo $3.207.114,55
WARN 3 sin match: [{cbu:"0170123400000012345678", importe:1482350}, ...]
```
En tres líneas: identidad del cliente, su banco y cuenta, la contraparte y su CUIT, importes y saldo. Y
va a un archivo que se rota, se indexa y se respalda **fuera del control de la RLS**.

✅ aceptable
```
INFO ingesta.iniciada  request_id=8f2a lote_id=9c31 cliente_id=7ab4 formato=pdf_banco_x hash8=1f4c9a02 bytes=284310
INFO ingesta.parseada  lote_id=9c31 movimientos=142 periodo=2026-07 duracion_ms=1830
WARN ingesta.sin_match lote_id=9c31 cantidad=3 movimiento_ids=[c1d0,44ab,7e29] motivo_codigo=ordenante_desconocido
INFO ingesta.finalizada lote_id=9c31 insertados=142 duplicados_omitidos=0 estado=ok
```

**Error de conciliación**

❌ inaceptable
```
ERROR no se pudo imputar $1.482.350,00 de PROVEEDORES DEL SUR SRL a ninguna factura de Metalúrgica SA
ERROR duplicate key value violates unique constraint "uq_mov_hash" DETAIL: Key (cliente_id, hash)=(7ab4, 9f…) already exists
ERROR   at conciliar (…) { params: ['30-12345678-9', 1482350, '0170123400000012345678'] }
```
La segunda y tercera línea son el error crudo del driver: el `DETAIL` de Postgres trae **valores de
clave** y el objeto de error trae los **parámetros ligados**. Es la fuga más frecuente y la menos
intencional.

✅ aceptable
```
ERROR conciliacion.sin_candidato cliente_id=7ab4 movimiento_id=c1d0 regla=match_cuit_ordenante candidatos=0 codigo=CONC_SIN_CANDIDATO
ERROR conciliacion.duplicado     cliente_id=7ab4 movimiento_id=c1d0 codigo=CONC_DUPLICADO constraint=uq_mov_hash
WARN  conciliacion.ambigua       cliente_id=7ab4 movimiento_id=44ab candidatos=3 codigo=CONC_AMBIGUA accion=cola_revision
```
(Coherente con `CLAUDE.md` §1.7: la ambigüedad **va a cola de revisión del contador**, no se resuelve.)

**Consulta de padrón**

❌ inaceptable
```
DEBUG GET https://…/padron/v2/persona/30123456789?token=eyJhbGciOi…
DEBUG Respuesta: {"razonSocial":"PROVEEDORES DEL SUR SRL","domicilio":"…","impuestos":[…]}
INFO  Usando certificado /secrets/estudio-perez.crt (CN=…, serial=…) para consultar 30-12345678-9
```
El CUIT en la URL termina en el access log del proxy **y del proveedor**; el token es N3; la respuesta
es dato fiscal de un tercero; la tercera línea documenta dónde vive la clave privada.

✅ aceptable
```
INFO  padron.consulta   request_id=8f2a cliente_id=7ab4 sujeto_ref=e91b origen=conciliacion cache=miss
INFO  padron.respuesta  request_id=8f2a sujeto_ref=e91b http=200 duracion_ms=412 campos=4 cache_ttl_s=86400
ERROR padron.error      request_id=8f2a sujeto_ref=e91b http=503 codigo=PADRON_NO_DISPONIBLE reintento=2/3
INFO  credencial.uso    cliente_id=7ab4 credencial_id=b2f7 servicio=padron resultado=ok   ← fila en acceso_auditoria
```
`sujeto_ref` es un id interno opaco, no el CUIT. **El CUIT viaja en el body, nunca en el path ni en el
query string** (R30).

---

## E. Secretos y credenciales fiscales

### E.1. `.env.example`: solo nombres

Ver `.env.example` en la raíz. Ninguna variable con prefijo público (`NEXT_PUBLIC_*`/`VITE_*`): lo
público se hornea en el bundle y viaja al navegador. `DATABASE_URL_JOB` y las referencias al organismo
recaudador **no existen** en el entorno del proceso web (R18). Y **nunca** un valor de ejemplo que
parezca real: un DSN de ejemplo se copia y se usa.

**Lo que nunca va, ni con valor de ejemplo:** clave privada de un certificado, credenciales fiscales de
un cliente, cualquier dato real de un cliente (CUIT, CBU, razón social).

### E.2. Custodia de los certificados del organismo recaudador

**Dónde NO van:** el repo; la imagen Docker; el `docker-compose.yml`; una variable de entorno como PEM
inline (queda en el panel del hosting, en los logs de deploy y en `ps`); la base en claro; un adjunto de
mail; la carpeta `knowledge/`.

**Dónde van:**

1. **Preferido:** almacén de secretos / KMS del proveedor, detrás de una interfaz propia (mismo criterio
   que ADR-0000 §3). La clave se genera y usa **dentro** del almacén si el proveedor lo permite; la app
   solo pide una firma.
2. **Si hay que guardarla en la base** (self-hosted sin KMS): **cifrado sobre (envelope)** — una DEK por
   cliente, cifrada con una KEK que vive afuera. La tabla guarda solo `cliente_id`, `credencial_id`,
   ciphertext, `kek_id`, `alg`, `fingerprint_sha256` **del certificado público** (identifica sin
   descifrar), `vence_en`, `rotada_en`. La columna de ciphertext se marca N3 → excluida de todo `select`
   por defecto, de todo export y de todo log.

**Quién la usa:** un **proceso firmador separado**, con su propia credencial de KMS y **sin ruta de
entrada desde HTTP**. La app pide "firmá esto para el cliente X" y recibe el resultado. Motivo concreto:
**un RCE en la web no alcanza la clave privada.** Ningún humano lee una credencial fiscal a través de la
app.

**Una credencial por `cliente_id`, con su propia DEK.** Prohibida una credencial "del estudio" que sirva
para todos: si se filtra una, se filtra la cartera.

**Delegación:** el estudio opera con autorización del cliente. Quién autorizó, cuándo, alcance y
vencimiento son **dato de primera clase**, no un supuesto. Los requisitos formales de esa delegación son
un hueco normativo (§G, G-6) — **no tengo esa fuente cargada**.

### E.3. Rotación

| Disparador | Acción |
|---|---|
| Vencimiento del certificado | Renovar antes. **El plazo de vigencia lo fija el organismo: no tengo esa fuente cargada** → se trata como **dato configurable por credencial** (`vence_en`) con alerta anticipada, **nunca** como constante en el código |
| Baja de una persona del estudio | Rotar todo secreto compartido al que tuvo acceso; desactivar usuario y membresías (INV-10) |
| Cualquier sospecha | **Rotar primero, investigar después** |
| Rotación de la KEK | Re-cifrar las DEK sin descifrar el material de negocio; la KEK anterior vive solo hasta que terminen los jobs en vuelo |
| Cambio de proveedor | Rotar todas las credenciales de infraestructura, no migrarlas |

### E.4. Si se filtra un secreto

Orden no negociable: **contener primero, entender después.**

1. **Rotar/revocar en el minuto uno.** No se investiga con el secreto vivo. Si es una credencial fiscal,
   la revocación puede requerir una acción **del cliente** ante el organismo: contactarlo es parte del
   paso 1, no del paso 6.
2. **Inventariar el alcance:** qué abría, sobre qué clientes, desde cuándo (fecha del commit, del deploy,
   del log).
3. **Invalidar sesiones y tokens** derivados.
4. **Revisar `acceso_auditoria`** y los logs del organismo/banco en la ventana de exposición: ¿se usó?
   Esto solo se puede responder si R32 está cableado — es la razón por la que la auditoría no es opcional.
5. **Registrar el incidente** en `docs/seguridad/registro-incidentes.md`.
6. **Notificar al cliente afectado y al titular del estudio** — deber profesional y contractual. **Si
   además hay un deber legal de notificación, a quién y en qué plazo: no tengo esa fuente cargada**
   (§G, G-3). No se afirma plazo ni destinatario.
7. **Post-mortem con un control que impida la repetición**, expresado como una regla de §B verificable.
   Un post-mortem que termina en "hay que tener más cuidado" no cierra el incidente.
8. **Un secreto commiteado se considera público para siempre.** Se **rota**; no se "limpia el historial y
   listo" (hay clones, forks, caches de CI, mirrors). Reescribir el historial es opcional y posterior;
   rotar es obligatorio e inmediato. **Vale igual si el repo es privado.**

---

## F. Datos de prueba

### F.1. Generación sintética (el camino normal)

- **Generador determinístico con semilla fija**: un estudio, N clientes, cuentas, plan de cuentas,
  movimientos, y los casos borde que interesan (importes iguales, transferencias entre cuentas del mismo
  cliente, descripciones ambiguas, duplicados, saldos que no cierran, encoding roto).
- **CUIT/CUIL sintéticos con dígito verificador deliberadamente INVÁLIDO.** Un CUIT "válido" generado al
  azar **pertenece a un contribuyente real**: tenerlo en el repo es una filtración con pasos extra. Si un
  test necesita uno formalmente válido, se usa un set fijo y documentado de dummies, nunca aleatorio.
- **CBU sintéticos** con entidad inexistente y verificador inválido, por el mismo motivo.
- **Nombres obviamente ficticios** (`CANARIO SRL`, `EMPRESA DE PRUEBA 07`). Prohibido "nombres realistas".
- **Los extractos de prueba se construyen desde la especificación del formato**, no desde el archivo de
  un cliente. Si hubo que mirar un archivo real para entender el formato, **ese archivo no entra al
  repo**; entra la especificación.
- **Valores canario reservados** (`999999.99`, `CANARIO SRL`, CBU canario) usados por INV-5 e INV-8, y
  para nada más.

### F.2. Prohibiciones

1. **Nunca** `pg_dump` de producción hacia testing, local, un backup personal ni un adjunto.
2. **Nunca** el `DATABASE_URL` de producción en un `.env` local. Nadie tiene la credencial de prod en su
   máquina: el acceso a prod es por un camino con auditoría.
3. **Nunca** credenciales fiscales de producción en un entorno no productivo (se usa homologación).
4. **Nunca** restaurar un backup de prod en un entorno de prueba "solo para ver".
5. **Nunca** pegar datos reales en el contexto de un agente/LLM, en un issue, un PR, una captura o un
   chat. Un ticket con una captura del extracto es una filtración.

### F.3. Reproducir un bug con un caso real

La respuesta por defecto es **no**. Solo después de agotar la reproducción sintética:

1. **Intentar sin el dato:** reporte + logs (que ya traen uuid, códigos y conteos) + caso sintético. Si no
   alcanza, **es un hallazgo de observabilidad**: anotarlo.
2. **Minimizar:** el registro que falla, no la tabla; los campos necesarios, no la fila; un movimiento, no
   el extracto.
3. **Autorización explícita** del titular del estudio **antes** de extraer nada. Un agente no la otorga
   ni la asume.
4. **Anonimizar en origen, dentro del perímetro de producción:** un script que corre del lado de prod y
   emite un fixture ya redactado (reemplazo consistente de CUIT/CBU/nombres por tokens sintéticos;
   importes escalados por un factor fijo **si el importe no es la causa**). El dato en claro **nunca sale**
   de prod: sale el fixture.
5. **Verificar el fixture antes de moverlo:** correrle los detectores de INV-8 y buscar los valores
   originales. Si algo matchea, no se mueve.
6. **Canal controlado** (repo/almacén del proyecto), nunca chat, mail ni captura.
7. **Registrar** en `docs/seguridad/registro-excepciones.md` y en `HANDOFF.md`: quién autorizó, qué se
   extrajo, para qué bug, dónde quedó, **cuándo se destruye**.
8. **TTL y destrucción con constancia.** Si quedó equivalente-a-sintético, puede quedar como caso de
   regresión; si conserva algo, **no queda**.

---

## G. Huecos normativos (pendientes — nada de esto se afirma)

`knowledge/` está en estado **esqueleto** (verificado: `sources_status: esqueleto-sin-contenido`). Para
todo lo de abajo, hoy la respuesta es **"no tengo esa fuente cargada"**. Ningún control técnico de §A–§F
depende de que estos huecos se cierren.

| # | Tema | Dónde va | Qué decisión desbloquea |
|---|---|---|---|
| **G-1** | **Secreto fiscal**: alcance, sujetos obligados, qué información cubre, excepciones | `knowledge/nacional/` | Qué puede salir del sistema y hacia quién; si un export a un tercero es siquiera admisible |
| **G-2** | **Protección de datos personales** — régimen vigente **y reformas en curso**: bases de licitud, derechos, medidas de seguridad exigidas, tratamiento por cuenta de terceros | `knowledge/nacional/` | Qué es el estudio y qué es el SaaS en la cadena de tratamiento; qué medidas son exigibles vs. elegidas |
| **G-3** | **Deber de notificar un incidente**: si existe, a quién, en qué plazo | `knowledge/nacional/` | El paso 6 de §E.4 (hoy solo deber profesional/contractual). **Ningún plazo afirmado** |
| **G-4** | **Plazos de conservación**: documentación respaldatoria, libros, comprobantes, documentación laboral | `knowledge/nacional/` | La política de retención. Hoy: **no hay borrado automático de nada**; la retención es configurable y las decisiones de borrado son humanas y registradas. Es lo técnicamente defendible sin la fuente |
| **G-5** | **Transferencia internacional / residencia de datos** | `knowledge/nacional/` | La elección de proveedor **y región** (ADR-0000 §9). Mitigación provisoria: la región es **variable de despliegue**, los datos quedan en una sola región documentada, y no se agrega ningún servicio externo por defecto |
| **G-6** | **Requisitos del organismo para delegar credenciales/certificados** a un tercero y para su custodia | `knowledge/nacional/sire/` | El modelo de autorización de §E.2 |
| **G-7** | **Secreto profesional del matriculado** y normas del Consejo Profesional | `knowledge/provincial/<jurisdicción>/` | Qué ve un `auditor` externo y un `cliente_lectura`; obligaciones al terminar la relación con un cliente |
| **G-8** | **Datos de empleados / sueldos**: régimen específico y conservación laboral | `knowledge/nacional/` | Si el legajo requiere controles más estrictos que el resto de N2-R |

Cada hueco se registra en `knowledge/_FUENTES.md` con la convención de `knowledge/README.md`. Hasta
entonces, la postura de ingeniería es **construir la capacidad configurable y auditable, no inventar el
número**.

---

## H. Veredicto adversarial del agente de seguridad

### H.0. Veredicto

**El diseño de tenancy portado es una base correcta, pero por sí solo no garantizaba el aislamiento.**
De los 15 hallazgos, **4 eran críticos**; el más grave (**H-1**) era un **bug real de la migración**, y
está corregido y verificado. Lo que sigue abierto son controles que dependen de que exista código.

Lo que está bien y no se toca: `cliente_id` uuid + igualdad indexada como predicado caliente; `path`
mantenido por trigger y no por la app; `force row level security`; `SECURITY DEFINER` con `search_path`
fijo; `set_config(…, true)` en transacción; y **fail-closed por diseño** (sin contexto → 0 filas), que es
la propiedad más valiosa del diseño. Casi todo lo de abajo apunta a que nadie la convierta en fail-open
"arreglando" un bug.

### H.1. Hallazgos

| # | Sev. | Hallazgo | Así se rompe | Estado |
|---|---|---|---|---|
| **H-1** | 🔴 | **El trigger de `path` era solo `BEFORE INSERT`.** | Un `update tenant_node set parent_id=…` deja el path viejo. Como `accessible_tenant_ids()` resuelve el subárbol **por path**, un usuario de un estudio empieza a ver clientes de otro. Silencioso: nada falla, solo aparecen filas ajenas. | ✅ **CORREGIDO Y VERIFICADO**: trigger `before update of parent_id`, trigger que rechaza editar `path` a mano, `app.verificar_coherencia_path()`, y `app.reparentar_nodo()` que aborta si deja el árbol incoherente. Tests P1-A..P1-D |
| **H-2** | 🔴 | **`app_job` (BYPASSRLS) es el camino natural del Módulo 1.** La ingesta es un job. | Un `where` mal armado, un dedupe global por hash, un reproceso "de todos los lotes" → escribe o lee filas de otro cliente. **La RLS no lo frena.** Es la falla más probable del sistema y la más difícil de detectar: el job no tiene un usuario que se queje | ✅ **acotado**: `app_job` no tiene ningún privilegio sobre dominio (verificado); R19/R20 fijan que la ingesta corre como `app_request`. ⏳ falta R12 (FK compuestas) y el test INV-6, **con el Módulo 1** |
| **H-3** | 🔴 | **Una membresía en la raíz da acceso a toda la cartera.** No hay eje de autorización *por nivel de dato*. | Se da de alta al administrativo nuevo con membresía en la raíz "para que trabaje con varios clientes" → lee extractos, DDJJ y sueldos de **todos**. No es un bug: es el comportamiento del diseño | ⏳ **abierto**: las membresías operativas se otorgan **en el nodo cliente** y la raíz se reserva a `socio`; hace falta policy con chequeo de rol también en **lectura** para N2-R/N3, y un test que falle si un rol operativo tiene membresía en un nodo `estudio` |
| **H-4** | 🔴 | **`exists()` en lugar de `in()`: fail-open de una sola letra.** | `exists (select 1 from app.accessible_tenant_ids())` se lee igual, pasa los tests de "el usuario ve sus datos", y significa **"el usuario tiene acceso a algo"**: la tabla queda abierta a cualquier usuario autenticado del SaaS. Variantes igual de letales: `or app.current_user_id() is null`, `coalesce(…, true)` | ⚠️ **parcial**: T10 rechaza `true`, `or true`, `is null` y escritura sin `with_check`. Falta el match **exacto** del patrón canónico (R4) |
| **H-5** | 🟠 | **Vistas y matviews quedan fuera de la RLS.** Una matview **no admite policies**: su contenido es una tabla cross-tenant | El dashboard es lento; alguien materializa "totales por período" siguiendo `03-reglas-desarrollo-optimizado.md` §4 ("materializar si es caro") y la crea con la conexión de job → el agregado de **todos** los clientes queda legible | ⏳ R7/R8/**R9**. **Este ADR restringe explícitamente esa recomendación de performance** para tablas de dominio |
| **H-6** | 🟠 | **El motor de conciliación filtra cross-tenant por "aprendizaje"** | `alias_ordenante` o reglas guardadas sin `cliente_id` "porque el banco es el mismo" → en el cliente B **sugiere** una contraparte que solo existe en A. Secreto fiscal filtrado por una sugerencia de UI, sin que ninguna fila cruce de tabla | ⏳ INV-9. **Entra en el Módulo 2**; ya está anotado en `agents/personas/motor-conciliacion-contable.md` |
| **H-7** | 🟠 | **El storage está completamente fuera de la RLS** | Key "parlante" (`metalurgica-sa/banco-julio.pdf`) + un bug en el emisor de URLs; URL firmada con TTL de horas que queda en un log o un mail; bucket con listado; MinIO expuesto con credenciales default | ⚠️ **parcial**: la key es `cliente/<uuid>/…` (ADR-0000 §3.3), el bucket es privado y el compose usa dos cuentas de servicio sin la de root. ⏳ falta el emisor único (R31) |
| **H-8** | 🟠 | **No había trazabilidad de acceso** | Un administrativo descarga 40 extractos de 12 clientes en su última semana y se va a la competencia: el sistema **no puede responder** quién vio qué. Y sin auditoría, el paso 4 de §E.4 es incontestable | ✅ **tabla `acceso_auditoria` creada, append-only, verificada** (T13 y P1-0: ni `app_job` puede borrarla). ⏳ falta cablear el choke point de lectura/descarga |
| **H-9** | 🟠 | **`admin_plataforma` venía en la policy de escritura**, y una super-raíz de plataforma filtraría todo el SaaS | Un usuario de soporte con membresía permanente "para poder ayudar" que queda vivo y sin auditar | ✅ **no hay super-raíz** (cada estudio es raíz, verificado en T14). ⏳ falta sacar `admin_plataforma` de las policies de escritura de dominio y modelar el grant temporal (INV-11) |
| **H-10** | 🟠 | **Unicidad global = oráculo de existencia cross-tenant** | `unique(cuit)` a nivel plataforma: al dar de alta un cliente, el error de unicidad informa que **ese CUIT ya es cliente de otro estudio**. Un competidor enumera la cartera ajena sin leer una fila | ✅ la plantilla exige `unique (cliente_id, …)` y el contrato del Módulo 1 usa `unique (cliente_id, fila_hash)`. ⏳ falta el test R6 y la regla del 404 (R24) |
| **H-11** | 🟡 | **`membership.user_id` sin FK a un usuario local** | Se borra y recrea el usuario en el proveedor de Auth, o se da de baja y su membresía queda viva: una membresía activa apuntando a alguien que ya no es esa persona. Y no hay a quién colgar la auditoría | ⏳ abierto — ya listado en ADR-0001 §11 (tabla `app_user`) |
| **H-12** | 🟡 | **El soft-delete del nodo empuja al bypass manual** | Se da de baja un cliente; sus datos quedan pero **nadie** los puede leer, ni el socio. El día que hace falta un export, alguien se conecta con `app_job` a mano: sin auditoría, sin filtro. **El control se saltea por necesidad operativa**, que es como se saltean todos | ⏳ abierto: hace falta el camino explícito "cliente archivado" (rol `socio`, policy propia, motivo obligatorio, auditoría). Es el único uso de `app_job` de la whitelist que toca dominio |
| **H-13** | 🟡 | **`nid` bigint secuencial** | Si viaja en una URL o API, enumera cuántos estudios y clientes tiene la plataforma | ⏳ R25 |
| **H-14** | 🟡 | **Fricción entre fail-closed y experiencia de desarrollo** | Una query fuera de `conUsuario()` devuelve 0 filas **sin error**. El dev no entiende y "arregla" el síntoma: fallback en la policy (→ H-4), o el pool de job (→ H-2), o desactiva RLS "para probar". **La rotura viene del arreglo, no del bug** | ⏳ `conUsuario()` debe **lanzar** con mensaje claro si no hay contexto, no devolver 0 filas en silencio (R16/R17). Documentar como el error #1 esperado |
| **H-15** | 🟡 | **Backups y dumps no tienen RLS** | Un backup contiene toda la plataforma en claro; restaurarlo "para probar" o perderlo es una filtración total | ⏳ backups cifrados con clave aparte, mismo control de acceso que prod, prohibido restaurar en no-producción (R34). **N3 siempre cifrado a nivel campo**, así el backup solo entrega ciphertext |

### H.2. Riesgo residual, declarado y aceptado

Con **todo** lo anterior implementado, sigue abierto: **la RLS no protege contra el compromiso del
proceso servidor.** Ante un RCE, el atacante tiene el pool de `app_request` y puede setear cualquier
`app.user_id` → lee cualquier cliente de cualquier estudio. Es una propiedad del modelo *pooled* (nivel 0
de ADR-0001 §7), no un defecto de la implementación.

Mitigaciones que este ADR ya toma: **N3 fuera del proceso web** (§E.2 — el peor activo no se pierde en un
RCE de la app); mínimo privilegio de la credencial de base; auditoría + detección de volumen anómalo
(H-8) para que el acceso masivo deje rastro; tenant canario con sonda (INV-12) para **detectar**. Y el
endurecimiento está previsto sin rediseño (ADR-0001 §7, niveles 1–3). **Riesgo conocido y aceptado, no
resuelto.**

### H.3. Condición de salida antes de escribir el Módulo 1 — ESTADO FINAL

| # | Punto | Estado | Dónde vive | Verificado por |
|---|---|---|---|---|
| 1 | Trigger `before update` de `path` + invariante en CI y en producción (H-1) | ✅ | `0001_tenancy.sql`: `trg_tenant_node_path_upd`, `trg_tenant_node_path_manual`, `app.verificar_coherencia_path()`, `app.reparentar_nodo()` | P1-A…P1-D (SQL) + R13 (catálogo) |
| 2 | Tests de catálogo R1–R15 sobre base limpia, **en CI** | ⚠️ **parcial** | `packages/data/tests/catalogo.test.ts` + `.github/workflows/ci.yml` | Los 28 tests corren y pasan localmente contra Postgres real; **el workflow no se ejecutó** — no puedo correr GitHub Actions desde acá. La secuencia exacta del workflow sí la corrí a mano, paso por paso |
| 3 | **FK compuestas tenant-consistentes** (R12, H-2) | ✅ | `0002_endurecimiento.sql`: `credencial_fiscal_rotacion` referencia `(cliente_id, credencial_id)` → `credencial_fiscal (cliente_id, id)` | R12 (3 tests, incluida la verificación del verificador) + el test de comportamiento que intenta el cruce |
| 4 | `conUsuario()` único punto + **guard de arranque** (R18, H-14) | ✅ | `packages/data/src/db/conexion.ts` | 4 tests de comportamiento + R16/R17 por barrido. El guard rechaza `BYPASSRLS`, superusuario y pooler fuera de transaction mode |
| 5 | Policy de rol también en **lectura** para N2-R/N3 (H-3) | ✅ | `0002_endurecimiento.sql`: `credencial_fiscal_sel` exige `socio`; **grant a nivel columna** deja `material_cifrado` fuera del alcance de `app_request` | 4 tests de catálogo + 4 de comportamiento (un `administrativo` no lee el rastro; ni el socio lee el material) |
| 6 | Choke point de `acceso_auditoria` cableado | ✅ | `packages/data/src/db/auditoria.ts`: `registrarAcceso` / `leerConAuditoria` con `ContextoAuditado` no construible desde afuera | 6 tests: escribe antes de leer, exige motivo en export/descarga, no audita sin identidad, nadie puede editar ni borrar |
| 7 | Registro de clasificación + redactor de logs derivado, con INV-8 | ✅ | `packages/shared/src/seguridad/{clasificacion-campos,redactar}.ts` + `observabilidad/logger.ts` | 17 tests, incluido el barrido INV-8 sobre los tres caminos dorados y el **límite conocido** del redactor |
| 8 | Generador sintético con CUIT/CBU de verificador inválido y valores canario | ✅ | `packages[/]data/src/seed/sintetico.ts` + `scripts/sembrar.ts` | El propio `pnpm db:seed` **aborta** si el generador produce un CUIT o un CBU con verificador válido |
| 9 | **Barrido de detectores sobre el repo**, no solo sobre los logs — ver §H.3.bis | ✅ | `tools/barrido-fuga.ts` + `.githooks/pre-commit` + paso en CI | 22 tests propios (la verificación del verificador) + prueba end-to-end: un importe real plantado en el repo **se detecta**, y al quitarlo vuelve a verde |

**Lo único que queda abierto es el punto 2, y solo en su mitad de CI.** El motivo es concreto y no es una
excusa: no puedo ejecutar GitHub Actions desde acá. El workflow está escrito y usa el **mismo**
`docker-compose` que el desarrollo local (a propósito: con un `services:` de Actions no se pueden fijar
los parámetros de log que exige R29, y el test de R29 fallaría o habría que saltearlo, o sea verificar en
CI algo distinto de lo que corre en desarrollo). La primera corrida en GitHub es la que lo cierra.

### H.3.bis. Un noveno punto que no estaba en la lista: el barrido sobre el REPO

Los ocho puntos de §H.3 se cerraron y **la fuga entró igual**. Al revisar el material real del piloto se
encontraron **cuatro importes y una glosa del extracto de un cliente escritos en los comentarios** de
`parseo-ar.ts`, `esquema.ts` y `hash.ts` — mi propio código, escrito mientras leía el archivo real.

Lo que importa no es el descuido: es que **ninguno de los ocho controles podía verlo**. El redactor mira
logs. INV-8 mira la salida del logger. R33 mira secretos. El registro de clasificación mira columnas de
base. **Nadie miraba el código fuente ni la documentación**, que es exactamente donde viaja el dato a un
lugar del que no vuelve (§E.4.8: lo commiteado se considera público para siempre, y para un importe no hay
rotación posible).

De ahí el noveno punto, `tools/barrido-fuga.ts`, con dos modos y 22 tests propios:

| | Modo estricto (máquina de trabajo) | Modo CI (runner) |
|---|---|---|
| Se activa cuando | `privado/` existe | `privado/` no existe |
| La pregunta que hace | ¿hay algún **valor del archivo real de un cliente** en el repo? | ¿hay algún candidato que **nadie cruzó todavía**? |
| Contra qué compara | los 13,5 M de caracteres extraídos de los 29 archivos reales | una **allowlist de huellas** commiteada (sha256, nunca valores) |
| Falsos positivos | cero, medidos | cero: solo grita ante un candidato nuevo |

**Cuatro correcciones salieron de probar el control en vez de darlo por bueno**, y las cuatro son la razón
por la que hoy sirve:

1. **La primera versión fallaba con 18 hallazgos, y los 18 eran ejemplos sintéticos legítimos.** La pregunta
   estaba mal: no es *"¿hay algo con forma de importe?"* —el repo documenta un formato bancario— sino *"¿hay
   algún valor del archivo real?"*. Un chequeo que grita en falso se desactiva en la segunda semana.
2. **El cruce por substring dio nueve falsos positivos.** Ninguno era un dato: estaban embebidos en ruido
   binario. Con 13,5 M de caracteres, un token de ocho dígitos aparece por azar. El cruce pasó a ser **por
   token**, que no tuvo ninguno.
3. **Normalizar quitando la coma decimal hizo colisionar el importe `1.111,11` con un número de operación
   `111111`.** La coma es lo que hace que un importe sea un importe. Se conserva.
4. **El control era ciego y daba verde.** Leía solo `.txt`, y el material real de este proyecto son PDF y
   Excel: al plantar un importe real, **no lo detectó**. Se agregaron los lectores (inflado de streams
   Flate y de entradas ZIP, extracción de cadenas en Latin-1 y UTF-16) y, sobre todo, se hizo **simétrica la
   definición**: los mismos detectores se corren de los dos lados de la comparación. Recién ahí el importe
   real plantado apareció, y desapareció al quitarlo.

El límite queda declarado: **no detecta una razón social ni un nombre propio**, que es texto sin patrón
(§C.0.bis). Cubre lo que tiene forma; para los nombres la defensa sigue siendo la revisión y la regla de no
copiar del archivo real. Y **la allowlist de exenciones no exime del cruce estricto**: eximir a un archivo
de test sería dejar abierta justo la puerta que el barrido cierra.

Corre en `pre-commit` (`.githooks/pre-commit`, se instala con `pnpm hooks:instalar`) y en CI. En pre-commit
es donde sirve: CI avisa cuando el commit ya existe.

### H.4. Punto de diseño que quedó abierto (declarado, no silenciado)

**Quién escribe `credencial_fiscal.material_cifrado`.** Las políticas exigen rol `socio` y el grant de
columna se lo da solo a `app_firmador`, que no tiene membresía en ningún nodo: hoy **nadie** puede
insertar el material por el camino normal. Es correcto que `app_request` no pueda, y es correcto que
`app_job` no tenga nada — pero falta definir cómo entra la credencial la primera vez (probablemente una
policy que reconozca al rol del firmador como rol de sistema, o un flujo en dos pasos socio→firmador).
**Se resuelve con `integraciones-afip`**, que es el agente cuyo dominio es esto; no se inventa acá. Los
tests de la FK compuesta corren con el dueño del esquema justamente para no depender de ese punto
abierto: lo que prueban es integridad referencial, que no depende de las políticas.

---

## Decisión

Se adoptan: la clasificación de §A con su registro **en código**; las reglas R1–R35 de §B como checklist
bloqueante integrada al DoD; los invariantes de §C como tests automáticos; la política de logging de §D;
la custodia y rotación de §E; los datos de prueba de §F; y el registro de huecos de §G. Los ocho puntos
de §H.3 son **condición de salida** previa al Módulo 1.

## Consecuencias

- La migración de tenancy nació **más grande** que el diseño portado: trigger de update, rechazo de
  edición de `path`, función de coherencia, `acceso_auditoria`, grants explícitos para `app_job`.
- **Se restringe una recomendación de performance:** `docs/devops/03-reglas-desarrollo-optimizado.md` §4
  sugiere materializar agregados caros; sobre tablas de dominio la **matview queda prohibida** (R9) y se
  materializa en tabla con tenant + RLS. Ese documento hay que anotarlo con la excepción.
- La ingesta del Módulo 1 **no puede tomar el atajo** de `BYPASSRLS`/`COPY`: cuesta más código (staging
  por lote) y es más lenta. Es el precio del aislamiento verificable.
- Sin `knowledge/` cargado, **no hay política de retención con plazos**: no hay borrado automático de
  nada, la retención es configurable y auditable, y las decisiones de borrado son humanas y registradas.

---

_**Validar con profesional matriculado.**_
