# 10 — Deuda declarada: lo que las auditorías encontraron y NO se corrigió todavía

> **Qué es este documento.** El registro de lo que tres agentes encontraron al auditar el Módulo 1 y que
> **se decidió no tocar en la misma tanda**, con el motivo de cada postergación y qué haría falta para
> cerrarlo.
>
> **Por qué existe.** Una auditoría cuyo resultado se aplica a medias y no se anota es peor que no
> haberla hecho: el próximo que mire el código va a asumir que lo que está es lo que se decidió. Acá
> queda escrito qué se sabe que está mal, para que nadie lo redescubra desde cero — y para que ninguna
> de estas líneas sea una sorpresa cuando alguien la pise.
>
> **Cómo se lee la severidad.** 🔴 cambia un comportamiento del sistema; 🟠 rompe una garantía declarada;
> 🟡 es costo o fragilidad sin falla actual.

---

## 0.0. 🧭 ROADMAP — qué falta, al 2026-08-16

> **Actualizado al cierre del expediente de seguridad** (`0015` a `0020`, incidentes #1 a #8),
> mergeado a `main` en `cd9fe95`. Esta sección es **el índice de lo que falta**; el detalle de cada
> línea vive en el documento que se cita.
>
> 🔴 **Cómo leer el orden:** lo de arriba **bloquea** a lo de abajo. La deuda de seguridad no es una
> lista paralela al producto: la recursión de RLS es una precondición de despliegue, y el determinante
> de idempotencia es una precondición del reproceso.

### A. Lo próximo, ya decidido

| | Qué | Estado |
|---|---|---|
| **A.1** | 🔴 **`0021` — rediseño del determinante de idempotencia.** El determinante persistido (`motor_digest`) cubre **el CÓDIGO, no la ENTRADA**, y la entrada es **mutable**: `recapturar-conceptos.ts` y `backfill-contraparte.ts` hacen `UPDATE` sobre `movimiento_bancario_crudo`. Un reproceso que cambie `concepto_banco` sin cambiar la clase **da no-op con la interpretación vieja intacta** — está declarado en `escrituras.ts:296-300` | ⚠️ **PLAN ESCRITO Y PREMISA MEDIDA (2026-08-17).** Expediente completo: **`11-migracion-0021-determinante-y-capa-c.md`**. Panel de 6 convocado; **P0 y P1 cerrados sin una línea de DDL**. 🔴 **La magnitud del bug, medida sobre el corpus real: 64 movimientos** (de 1830, 1754 cambian de digest y 64 conservan la clase). Faltan P2–P4 |
| **A.2** | 🔴 **La condición dura del dueño del esquema** — ver §6 de `08-plan-de-construccion.md`. **Antes de reconfigurar el dueño como NO superusuario en NINGÚN entorno**, hay que resolver la recursión infinita de RLS | Tarea propia con `security-engineer` + `arquitecto-software` + `dba-data` |

✅ **Las dos preguntas de diseño ya fueron al panel y están DICTAMINADAS** (2026-08-17). El detalle, con
la evidencia ejecutada, está en `11-migracion-0021-determinante-y-capa-c.md` §3 y §4. Resumen:

1. **¿Columna generada + `unique`, o hash calculado en TypeScript?** → **Generada en
   `movimiento_bancario_crudo`** (donde la entrada es fila-local) **+ foto histórica por trigger
   `BEFORE INSERT` + `not null`** en `reconocimiento_movimiento`.
   🔴 **Y la premisa de esta pregunta, tal como estaba escrita acá, era FALSA:**
   `0017_path_por_construccion.sql` **NO usa una columna generada** — usa columna espejo plana + `CHECK`
   fila-local + FK compuesta `match full deferrable` + trigger (`0017:131, 180-182, 198-202, 213-232`).
   El precedente real de generada+`unique` es `0014:184` (`es_propuesta`), con expresión **inline pura**;
   en todo el repo no hay una generada que invoque una función de usuario.
   🔴 **Y la FK que ese patrón sugería quedó descartada por medición:** *una FK afirma un hecho
   PRESENTE; el determinante registra uno HISTÓRICO* — con `on update restrict` el primer reconocimiento
   **congela `concepto_banco` para siempre** y `recapturar-conceptos.ts` muere con `23503`.
2. **¿Se recorta el `grant insert`?** → **Sí, pero la premisa también era falsa.** Una generada **no es
   falsificable ni bajo grant de tabla** (`cannot insert a non-DEFAULT value`: rechaza el mecanismo, no
   el privilegio), y una columna llenada por trigger **se sobrescribe en silencio**. El recorte no compra
   integridad: compra que el intento falle **ruidoso**.
   🔴 **El recorte va igual, por dos agujeros vivos HOY en `0014`**: `created_at` insertable (un tenant
   **antedata** su propio reconocimiento) y `superseded_por` insertable (una fila **nacida superseded**
   sale del índice parcial, **nunca llega a la cola de la contadora**, y nada falla).

**Dato que simplifica A.1:** el piloto tiene **1830 movimientos y CERO reconocimientos persistidos**.
No hay backfill, no hay filas que migrar, no hay riesgo sobre datos existentes. La migración es de
esquema puro.

### B. El producto, donde estaba

| | Qué | Bloqueado por |
|---|---|---|
| **B.1** | **Capa D — imputación** (qué cuenta se debita y cuál se acredita) | El **plan de cuentas del cliente**, que no existe todavía |
| **B.2** | **Capa E — composición del asiento** | Ídem B.1 |
| **B.3** | **La cola de revisión del contador** (`apps/web`) — el sistema es **asistido**: el motor propone y la contadora decide. Hoy no hay dónde decidir | Convoca `ux-designer` + `frontend-dev` + `seguridad-datos-financieros` |
| **B.4** | **Login / `AuthProvider`** — hoy la identidad entra por un GUC que setea la sesión (**incidente #8**). No hay autenticación de personas en ningún lado | Es la otra mitad del #8: sin aplicación que firme, `hecho_por` no vale como atribución |
| **B.5** | **FCI y tarjetas** — suscripción y rescate de FCI con **inventario PEPS**, pago de tarjeta corporativa, y la **liquidación del adquirente**. `01-modulo-1-ingesta-bancaria.md` marca el inventario PEPS de apertura como *«lo único que no se puede reconstruir después»* y la liquidación del adquirente como *«sin ella la regla 11 queda mal para siempre»* | Material del estudio + `contador-dominio`. **Alta prioridad de captura, aunque el cálculo venga después** |
| **B.6** | **`knowledge/` sigue vacío** — siete huecos normativos. Los cuatro que el Módulo 2 consume directo: crédito fiscal, percepciones, régimen de recaudación bancaria provincial, y porción computable del impuesto a los débitos y créditos | Es la razón por la que los agentes fiscales contestan *«no tengo esa fuente cargada»*. **Eso es el guardrail funcionando, no una falla a compensar** — pero tiene costo operativo real desde el incidente #3 |

### C. Deuda técnica que no bloquea, pero se cobra sola

- **La deuda de seguridad abierta**: `08-plan-de-construccion.md` §6.0 — nueve líneas, de bloqueante de
  despliegue a higiene.
- **El lote-ancla se pierde en todo camino de excepción** (§1.1 de este documento).
- **`pnpm db:seed` roto contra una base desde cero**: faltan `movimiento_contraparte_identificador` y
  `membership_historia` en la lista de `truncate` de `sembrar.ts`. La suite corre porque
  `tests/ayuda.ts` sí las tiene — **el runbook no**.
- **`0016_path_coherente.sql` quedó en el historial de migraciones** aunque `0017` la reemplazó por
  completo. No se toca (una migración aplicada no se edita), pero quien lea el directorio va a
  encontrar dos migraciones del mismo invariante.
- 🟡 **Validación legal de Poppler (`pdftotext`) como subproceso externo, pendiente — sin dueño.**
  `packages/ingesta/src/fci-santander/extraer-posiciones.ts` invoca `pdftotext` (Poppler, licencia GPL)
  como binario de sistema vía `node:child_process`, nunca importado/linkeado — ADR-0000 §2.4 documenta
  el criterio ("GPL solo como proceso externo separado"). Ese criterio es la práctica de la industria,
  **no fue revisado por un abogado**. Cierre: antes de vender este producto a un **segundo estudio o
  cliente externo al piloto**, confirmar con asesoría legal que el patrón sostiene la distribución
  comercial tal como está planteada — y, si no, decidir reemplazo de binario o cambio de modelo de
  distribución. Detalle completo: `docs/arquitectura/ADR-0000-stack-infra.md` §2.4.
- 🟡 **Promoción de "reconcile-or-refuse" a regla formal (candidata R43) en `ADR-0002-seguridad.md`
  §B — pendiente, sin dueño.** Principio ya aplicado en código (`SaldoDesalineadoError`,
  `EncabezadoDeFondoNoEncontradoError`, `ConsistenciaInternaPdftotextError`,
  `FuentesDesincronizadasError` — `fci-santander/extraer-posiciones.ts`): ningún extractor que compare
  dos fuentes para el mismo dato numérico/estructural puede reconciliar una discrepancia en silencio,
  siempre abortar con el detalle exacto. Documentado como principio en
  `docs/diseno/19-fci-santander-extractor-hibrido.md`, **no promovido formalmente todavía**: la
  promoción a regla de `ADR-0002` §B exige la **prueba de mutación de §B.0** (código defectuoso que la
  ponga roja, caso legítimo, conteo de mutaciones declarado) — esa prueba es parte de la tarea de
  cierre, no un paso posterior opcional.
- 🟡 **Ninguna herramienta de la sesión de trabajo fuerza `formaParaLog` sobre un comando de shell
  suelto contra un documento real — pendiente, sin dueño.** `registro-incidentes.md` fila **12**
  (2026-08-25): un agente corrió `pdftotext -layout ... \| sed 's/[0-9]/9/g'` directo por Bash para medir
  la estructura de un PDF real, redactando solo dígitos — dos cadenas de letras (razón social, nombre de
  titular) quedaron en texto plano en la salida. El código de producción está bien (`formaParaLog` cubre
  letras y dígitos, y es lo que usan `probar-adaptador.ts` y los scripts de medición del propio módulo);
  el hueco es que **nada impide que un agente use el binario de sistema directo en vez del script del
  proyecto**. No hay lint ni test que pueda cubrir esto — es un hábito de trabajo, no una regla
  verificable de ADR-0002 §B. Cierre, si alguna vez se decide cerrar: un wrapper de repo para lecturas
  ad hoc de un documento real (`pnpm medir <archivo>` con salida ya pasada por `formaParaLog`), para que
  la vía rápida sea también la segura — hoy la vía rápida (`pdftotext` a mano) es la insegura.
- 🟡 **Bloque de totales/comisiones de Bancor (página final del extracto), literal no confirmado —
  pendiente, sin dueño.** `docs/diseno/20-formato-bancor.md` §6: 9 líneas con patrón `etiqueta: $importe`
  detectadas por estructura, pero sin el texto exacto de la etiqueta confirmado contra el documento real
  (el clasificador de permisos bloqueó una lectura cruda adicional, correctamente — ver incidente #12 de
  `registro-incidentes.md`). Hoy van a `lineasNoInterpretadas` (`linea_fuera_de_zona`), no a `anexos[]`:
  `anexoExtractoSchema` exige el literal real, no una forma. Cierre: confirmar las 9 etiquetas contra el
  PDF real (o uno nuevo del mismo banco) y promoverlas a `anexos[]` con su `relacionConMovimientos`.
- 🟡 **`--banco <código no catalogado>` pierde el lote-ancla, sin rastro en `acceso_auditoria` —
  preexistente, no específico de Bancor.** Hallazgo de `security-engineer` al revisar
  `0024_catalogo_bancor.sql`: en `apps/cli/src/ingestar.ts`, el PASO 4 inserta en `lote_ingesta` con
  `banco_codigo` referenciando `banco(codigo)` (FK). Si el operador declara un código que no está en el
  catálogo (hoy: `bbva`, `icbc`, `nacion`), el `insert` viola la FK **antes** de que exista el lote-ancla
  — la transacción revierte sin dejar fila de auditoría, al revés de lo que el propio comentario del
  archivo promete ("el lote se crea antes de todo... para que el rechazo tenga dónde asentarse"). No es
  una fuga (sale por `redactar()`, código de salida distinto de cero), pero es peor observabilidad que el
  camino de un banco catalogado sin adapter (que sí falla con rastro, vía `sin_adaptador` en el PASO 6).
  Cierre: validar `--banco` contra el catálogo ANTES del PASO 4, con su propio motivo de rechazo
  auditado, en vez de dejar que la FK sea el único guardia.
- El resto de las secciones de este documento.

---

## 0. El contexto que explica casi todo lo de abajo

**El Módulo 1 se construyó sin el roster técnico dado de alta.** No existían `security-engineer`,
`dba-data`, `tech-lead`, `qa-automation` ni los otros ocho: se dieron de alta **después**, y su primera
tarea fue auditar lo ya construido.

El resultado es el argumento de por qué el roster se convoca **antes** (regla que quedó en `CLAUDE.md`
§3.1). Encontraron, entre otras cosas:

- Un **bug funcional** que ningún test veía: dos identificadores vigentes para la misma cuenta dejaban
  todo extracto de esa cuenta en `cuenta_ambigua` **de forma permanente**. Corregido en la migración
  `0009`.
- Un **tipo del logger que había divergido de su propia fuente**: ~32 claves que el redactor tapa en
  runtime nunca estuvieron en el tipo, y **toda columna multi-palabra compilaba en camelCase** — la
  grafía real del código. Corregido derivando el tipo del registro de clasificación.
- **Tres comentarios del repo que afirmaban que existía un test que no existía.**
- Un **falso positivo del guardián de migraciones** que impedía arrancar en una máquina nueva.

Nada de eso lo detectó el gate, que estuvo verde todo el tiempo. Es la tercera vez que este repo
confirma lo mismo: **el gate verde no es evidencia de nada por sí solo.**

---

## 1. Modelo de datos (auditoría de `dba-data`)

### 1.1 🟠 El lote-ancla se pierde en todo camino de excepción

`ingestar.ts` declara: *"el lote se crea antes de todo lo demás, incluso si el archivo se va a
rechazar: es el ancla a la que se cuelgan el rechazo y su motivo"*. **Eso vale solo en los caminos que
hacen `return`.** En todo camino que lanza, el `catch` de `conUsuario` hace `ROLLBACK` y se lleva el
lote, su `motivo_codigo` **y** la fila de `acceso_auditoria`. Queda un exit code y cero rastro en la
base.

Y el disparador probable en producción no es exótico: **un extracto reemitido o con período solapado**
viola `uq_mov_crudo_fila` → `23505` → `ING_DUPLICADO` → rollback total. Lo mismo con
`uq_anexo_sin_doble_lectura`, que es una **heurística de detección implementada como unique index**: un
falso positivo aborta un lote de 1346 filas sin dejar constancia de por qué.

**Por qué no se corrigió:** es un cambio de estructura de la aplicación (dos transacciones, o un
`SAVEPOINT` alrededor de la persistencia con el rechazo asentado después), no una migración. Merece su
propia tarea con su propio test.

**Converge con** el hallazgo de `security-engineer` sobre `persistirAnexos`, que lanza en vez de
devolver un `motivoCodigo` — el mismo agujero por otra puerta.

### 1.2 🟡 Once índices redundantes — **requiere enmendar ADR-0001 §5 antes de tocar nada**

Once índices de una sola columna `(cliente_id)` son **prefijo estricto** de un `unique (cliente_id, …)`
de la misma tabla. Se pagan 7 entradas de índice por fila en `movimiento_bancario_crudo` × 1346 filas
por lote.

Está verificado que dropearlos **no rompe** el test R2 del catálogo: pide *algún* índice con la columna
de tenant primera, y el `unique (cliente_id, id)` del renglón (10) lo satisface en las once.

🔴 **Pero no se dropean sin enmendar el ADR.** ADR-0001 §5 renglón (2) dice literalmente
`create index idx_<tabla>_cliente on <tabla>(cliente_id); -- SIEMPRE`. Si se borran sin cambiar esa
línea, el próximo módulo los vuelve a crear y esto se discute de nuevo.

**Enmienda propuesta al renglón (2):** *"un índice con la columna de tenant como **primera** columna —
puede ser el `unique (cliente_id, id)` del renglón (10)"*.

`idx_acceso_auditoria_cliente` queda afuera: es `(cliente_id, ocurrido_en desc)` y es el único de esa
tabla.

### 1.3 🟡 `returning id` fila por fila

`persistir.ts` usa `returning id::text` ×1346. Dos costos: **`INSERT … RETURNING` aplica también la
policy de `SELECT`** (1346 evaluaciones de más, hecho ya documentado en `0003`), y obliga a 2692
round-trips.

**El precedente del arreglo ya está en el repo:** `registrarAcceso` genera el uuid en la aplicación por
exactamente el mismo motivo. Generando el `id` con `randomUUID()` se elimina el `returning` y se
habilita un `INSERT … VALUES (…),(…)` multi-fila. **No viola R21**: R21 prohíbe `COPY … FROM`, y un
`INSERT` multi-fila **sí evalúa `with check` fila por fila**.

**Por qué no se corrigió:** es una optimización, no una falla. Entra cuando el volumen lo pida.

**Addendum (6.2, 2026-08-11) — el mismo `RETURNING` puede además RECHAZAR, no solo costar de más, y esto
sí es una falla, no una optimización pendiente.** Verificado en Postgres real (`security-engineer`, no
solo por lectura de la documentación de Postgres): si una tabla con `FORCE ROW LEVEL SECURITY` tiene una
policy de `SELECT` que resuelve consultando **esa misma tabla** (patrón self-referencial — hoy, en este
repo, solo `tenant_node` vía `accessible_tenant_ids()`), un `insert ... returning` sobre esa tabla
rechaza con *"new row violates row-level security policy"* **incluso para un usuario con acceso legítimo
confirmado un instante después** en la misma transacción. Confirmado que no depende de correlación de la
subconsulta, del origen del `id`, ni del contenido de la policy — se reprodujo con el chequeo más trivial
posible (`exists(select 1 from t where id = p_id)`). **No es el mismo mecanismo que el de
`registrarAcceso`/`acceso_auditoria`** (ahí el escritor genuinamente no tiene rol de lectura, es un
rechazo legítimo); acá el rechazo es puramente del timing de la re-evaluación dentro del mismo statement.
**Mitigación, la misma que ya prescribe este párrafo para el caso de performance:** no usar `RETURNING`
en el `insert`; generar el `id` en la aplicación con `randomUUID()` e insertarlo explícito (aplicado en
`altaDeClienteEnEstudio`, `packages/data/src/tenancy/escrituras.ts`), o hacer un `select` en un statement
separado dentro de la misma transacción. Aplica a cualquier tabla futura con el mismo patrón
self-referencial de policy — las tablas de dominio estándar (con `cliente_id` preexistente al insert) no
lo pisan, por eso `persistir.ts` nunca lo vio como rechazo, solo como costo.

### 1.4 🟡 Sin timeouts, y el `PUT` al storage corre dentro de la transacción

No hay `statement_timeout` ni `idle_in_transaction_session_timeout` en ningún lado (verificado en todo
el repo, incluido `docker-compose.yml`). Y el `PUT` al object storage ocurre **dentro** de la
transacción: un timeout de S3/MinIO mantiene abierta una transacción con 2700 filas escritas,
reteniendo el `xmin` y bloqueando el vacuum. Es la parte del pipeline cuya latencia no controla nadie
del proyecto.

⚠️ **Ojo con el arreglo obvio:** `ALTER ROLE app_request SET statement_timeout` **no funciona**.
`app_request` es rol grupo `nologin` y los *settings* de rol, igual que los atributos, **no se heredan
por pertenencia** — es el mismo detalle que ADR-0001 §4.3 ya documenta para `BYPASSRLS`. Va en el rol de
login de cada entorno, en `ALTER DATABASE`, o —lo mejor, porque es transaccional y ya es el patrón del
proyecto— con un `set_config(…, true)` más dentro de `conUsuario()`.

### 1.5 🟠 Durante una rotación de pepper, TODA cuenta resuelve `cuenta_ambigua`

Consecuencia destapada al corregir la ambigüedad permanente en la `0009`, y **medida con un test**
(`inv6-resolucion.test.ts`, *"cuenta_ambigua sigue vivo por la vía de la rotación de pepper"*).

`uq_cuenta_ident_cbu_vigente` lleva `pepper_id` adentro **a propósito**: sin él, la rotación incremental
de la `0006` quedaría bloqueada por el propio constraint. O sea que durante una rotación **sí** conviven
dos filas vigentes con el mismo CBU. Y el resolver **no filtra por `pepper_id`** — es la premisa que la
`0006` dejó escrita (*"el índice de resolución lleva la versión: una consulta que no la filtre compararía
contra digests de otra versión"*) y que nunca se implementó.

Resultado: mientras dure la rotación, toda cuenta con las dos filas devuelve `cuenta_ambigua`. **Es un
frenazo, no una fuga** — el sistema no imputa nada al azar — pero es un frenazo total, y hoy está medido
en vez de esperando a producción.

**Las dos salidas, y por qué no elegí:**
- Que el resolver filtre por el pepper vigente. Cierra el caso, **pero** una fila todavía no re-hasheada
  pasa de `cuenta_ambigua` a `cuenta_no_encontrada`, que es peor: el operador deja de ver que hay algo.
- Que la rotación sea atómica por cuenta (cerrar la vigencia vieja en la misma transacción que abre la
  nueva). Cierra el caso sin tocar el resolver, pero cambia el procedimiento de rotación.

Es una decisión de `arquitecto-software` + `seguridad-datos-financieros`, no del que aplica el índice.

### 1.6 🟡 `moneda` admite más en la base que en el código

La base admite `~'^[A-Z]{3}$'` en 4 tablas; el código admite `['ARS','USD']`. El dominio de la base es
**más ancho** y eso no está declarado como deliberado. Decidir: o se estrecha el `check`, o se escribe
por qué queda ancho.

### 1.7 🟠 Nada en el esquema impide que un `tenant_node` `cliente` cuelgue de otro `cliente`

`tenant_node_raiz_chk` (migración `0001`) solo exige `(tipo='estudio' ⇒ parent_id is null)` y
`(tipo≠'estudio' ⇒ parent_id is not null)` — **no valida el `tipo` del padre**. Un `cliente` podría
colgar de otro `cliente` (o de sí mismo transitivamente) por un simple error de operador pasando el uuid
equivocado, y ni el `check`, ni la FK, ni la policy `tenant_node_wr` lo detectan: `has_role_on` resuelve
por prefijo de `path`, así que un socio con rol sobre el `cliente` padre-por-error tendría rol también
sobre el hijo. No es fuga entre estudios (RLS sigue protegiendo eso), pero rompe silenciosamente el
supuesto "los clientes son hojas" y, si algún día se habilita un rol de lectura acotado a un cliente
puntual (`cliente_lectura`, ya nombrado en el roster de personas), ese rol vería también los datos del
cliente anidado por error.

**Hallazgo de `seguridad-datos-financieros`** (6.2, 2026-08-11), confirmado por `security-engineer` y
`dba-data`. **Mitigado hoy solo a nivel de aplicación**: `altaDeClienteEnEstudio`
(`packages/data/src/tenancy/escrituras.ts`) valida `tipo='estudio'` antes de insertar, para el único
camino de alta que existe. **No cierra la vía de raíz**: cualquier otro insert futuro sobre `tenant_node`
(un job, una consola, un segundo script) podría seguir sin ese guard. **Cierre correcto, pendiente**: un
trigger en la migración de tenancy que valide el `tipo` del padre para cualquier vía de inserción, no
solo la de aplicación — fuera del alcance de 6.2 porque tocar `0001_tenancy.sql` es una decisión de
mayor radio que un guard de aplicación en una función nueva.

### 1.8 🟡 El `PUT` al storage no participa de la transacción: un fallo POSTERIOR deja el objeto huérfano, confirmado contra el piloto

Manifestación concreta de lo que §1.4 ya señalaba en abstracto ("el `PUT` corre dentro de la
transacción [de Postgres, pero el storage no participa de esa transacción]"), confirmada por primera vez
contra un dato real: HANDOFF 2026-08-11 (44), `completar-lote.ts` corrió contra el piloto con la
migración `0012` sin aplicar ahí. `guardarExtractoTrasResolver` hizo el `PUT` con éxito (log
`extracto.guardado`), y el `update` de `lote_ingesta` que sigue **después** falló por la columna
inexistente. `conUsuario` revirtió Postgres entero, pero el objeto en S3/MinIO **no tiene reversa**: quedó
en el bucket real, sin ningún `archivo_clave` que lo señale.

**No es una fuga** (nada lista por prefijo, nada lo sirve sin `archivo_clave`) y **es autocurativo en
este caso puntual**: la clave es determinística (`cliente_id` + `lote_id`, `clave.ts`), así que la
próxima corrida exitosa vuelve a hacer `PUT` sobre la misma clave (sobreescribe con contenido idéntico,
sin duplicar nada) y esta vez si el `update` tiene éxito, `archivo_clave` sí lo termina señalando. **Pero
el mecanismo general sigue sin reversa**: si el fallo posterior no fuera transitorio/reintentable (por
ejemplo, un error real de negocio que aborta la corrida para siempre en vez de una migración pendiente),
el objeto quedaría huérfano permanentemente, sin que nada en el sistema lo detecte. **Cierre correcto,
pendiente**: mover el `PUT` fuera de la transacción por completo (guardar primero bajo una clave
provisoria/con TTL, confirmar después) o un job de barrido que compare objetos existentes contra
`lote_ingesta.archivo_clave` — ninguna de las dos se intentó acá, alcance de una tarea aparte.

---

## 2. Coherencia entre adaptadores (pasada de `tech-lead`)

> Diagnóstico en una línea: **los tres adaptadores no divergen en el criterio, divergen en la edad.**
> Galicia es el primero y no recibió ninguna de las tres lecciones que el segundo y el tercero pagaron.
>
> 🔴 **Lo peligroso para los cinco bancos que faltan no es la divergencia de estilo: es que hoy no hay
> un archivo del que copiar.** Quien escriba el cuarto va a copiar uno de los tres y va a heredar
> exactamente lo que a ése le falta.

### 2.1 🔴 La unificación del residuo — **la más importante de esta lista**

| | Mecanismo | Qué significa `residuo` ahí |
|---|---|---|
| Santander | `DESTINOS_SANTANDER` (7 destinos) + conteo con `sinDestino = 0` | *"esto no lo entendí"* |
| Macro | la disciplina está (`reportarSiEsResiduo`), **el conteo no** | *"esto no lo entendí"* |
| Galicia | ninguno | *"lo que el autómata del cuerpo no consumió"* — incluye el CBU y el número de cuenta, **cuyo dato sí se lee** |

**No es menor** porque ponerle destinos a Galicia **reclasifica sus 47 líneas medidas** y baja el conteo
del residuo, que es un número congelado en `09 §3` y afirmado en su test.

**Y hay un hallazgo que cambia la prioridad:** el CLI **nunca pasa** `cantidadLineasNoInterpretadas` ni
`coberturaDeLineasCompleta` a `verificarAritmetica`. O sea que **`EST_LINEA_NO_INTERPRETADA` no se
dispara nunca en producción**: el residuo se loguea y no puertea nada. Los tests de Santander sí lo
pasan, y por eso ahí *parece* un gate.

**Plan propuesto, en tres pasos y antes del cuarto banco:**
1. Subir el **vocabulario** al toolkit (`Destino`, `ConteoDeDestinos`, `contarDestinos`) — un tipo y una
   función pura sobre un `Map`, sin un solo `if` por banco. El marcado se queda en cada adaptador.
2. Migrar Galicia y Macro **midiendo con `pnpm probar` antes y después**, y escribiendo la predicción
   falsable (el método de `09 §5`): *"Galicia pasa de residuo 47 a residuo N y `fueraDelCuerpo` 47−N; si
   N ≠ 0, esas N líneas son un hallazgo real"*.
3. Recién ahí decidir si el CLI alimenta el conteo y el residuo pasa a ser gate.

**Avance (A2, 2026-08-11):** pasos 1 y 2 cerrados — `DESTINOS_BASE`/`ConteoDeDestinos<D>`/`contarDestinos<D>`
en `toolkit.ts`; Santander migrado, Macro instrumentado (residuo se mantuvo en 0 contra el fixture,
`fueraDelCuerpo=0` como predecía la tabla), Galicia instrumentado (residuo bajó de 8 a 0 contra el
fixture sintético, con las 8 filas de carátula pasando a `fueraDelCuerpo` — confirmado, no forzado).
**Paso 3 (el gate) sigue pendiente: C5.** La verificación contra archivo real (`pnpm probar`, 3
sittings) queda como checkpoint del usuario, no se corrió en esta tanda.

🔴 **Caso borde encontrado y documentado, no resuelto (`code-reviewer`, revisión de C4):** en
`leerAnexo` (`galicia.ts`), un candidato de renglón de anexo (literal o período/importe) que **no
llega a aparearse** cae clasificado como `fueraDelCuerpo` en vez de `residuo` — porque distinguirlo
exigiría que `leerAnexo` devuelva un tercer conjunto de índices al bucle principal, infraestructura que
A2/C4 no pedía construir. No está ejercitado por ningún fixture ni por el archivo real medido hasta
ahora (los 9 renglones aparean completos en los dos). Revisar antes de implementar `verificarDestinos`
(C5) si esto necesita resolverse, porque ahí sí habría un gate consumiendo el número.

🔴 **C5 confirmado contra archivo real, con un hallazgo pendiente de investigar (Santander,
2026-08-11).** `pnpm probar` contra los tres archivos reales: Macro y Galicia coinciden exacto con la
predicción del punto anterior (`fueraDelCuerpo`/`residuo` como se esperaba, `INV-destinos:
diferencias=0` en los dos). **Santander mide `residuo=5`** — la primera vez que se mide contra archivo
real (antes solo contra el fixture sintético); no había una predicción numérica escrita para
compararlo, a diferencia de Macro/Galicia.

Formas de las 5 líneas (`a`=minúscula, `A`=inicial mayúscula, `#`=dígito — nunca el texto real, mismo
criterio del propio `pnpm probar`; guardadas en `HANDOFF.md` 2026-08-11 (31) para que sobrevivan un
resumen de contexto):

```
×1  Aaaaaaa aa a{9} a{8} aaa ##### aaa ##-##-#### aa ##-##-####
×1  Aaaaaaa a{11} aa aaa a{9} aaaaaa aaaaa a{8} aaa ##-##-#### …
×1  Aa{8} Aa{8}
×1  Aaaaa Aaaa Aaaaaa Aaaaaa Aa{10} AAA AAA AAAAA Aaaaaaa aaaaa…
×1  aaaaa aaaaa
```

**Hipótesis descartada, con la traza completa que la refuta:** el primer intento sospechó de
`RE_ANEXO_RESUMEN`/`RE_ANEXO_COMPUTABLE` (`santander.ts`) por case-sensitivity, contra las palabras
"Sircreb"/"Importe susceptible..." que las formas 1 y 2 parecían sugerir por longitud de palabra. **Es
incorrecto**: los dos regex se llaman una sola vez cada uno, siempre contra `normalizar(literal)`
(`parseo-ar.ts:312`, que ya hace `.toUpperCase()`) — agregarles la flag `i` no cambia nada, porque el
texto ya llega en mayúsculas. Además, `relacionDelRenglon` (donde viven esos regex) no decide si una
fila cae en residuo: solo clasifica una fila que **ya se emitió** como anexo. La lección para la
próxima vez: coincidencia de longitud de palabra en una `forma()` no es una traza de código — hay que
seguir la cadena de llamadas hasta el punto real donde se decide el destino.

**Los tres candidatos reales**, siguiendo la cadena completa del bucle de armado
(`santander.ts`, función que arma `anexos` a partir de `clasificarBloque`, ~línea 1150-1190), en el
orden en que se evalúan:

1. `RE_CORRIDA_DE_IDENTIFICADOR.test(conceptoLiteral)` (línea ~1162) — una corrida de 7+ dígitos
   seguidos → residuo `desconocido`. Las formas no muestran ninguna corrida de 7+ (el `#####` de la
   forma 1 son 5), así que es el candidato menos probable, pero no descartado sin ver el literal
   completo (podría haber más dígitos fuera de la ventana capturada por `formaParaLog`, que trunca a
   120 caracteres).
2. `periodoDelRenglon(conceptoLiteral)` devuelve `null` (línea ~1166-1170) — rango de fechas invertido
   (`hasta < desde`) o no parseable → residuo `fecha_ilegible`. Las formas 1 y 2 tienen las dos un
   `del ##-##-#### al ##-##-####`: **es el candidato más plausible** para esas dos, pero hay que
   confirmar si las fechas parsean y en qué orden vienen.
3. Sin importe emparejado (línea ~1188-1191) → residuo `fila_sin_importe`. Aplica a cualquiera de las
   5, en particular a las formas 3 y 5 (más cortas, sin patrón de fecha visible) — un rótulo cuyo
   importe suelto esperado no aparece donde el apareo lo busca.

**Qué hace falta para cerrar esto — le toca al usuario, no a un agente** (dato real, `--caratula` lee
la carátula/cuerpo fragmento por fragmento con su `x`, sigue sin imprimir un valor pero hay que
correrlo contra el archivo real): `pnpm probar --banco santander --archivo <ruta> --caratula <n>` con
`n` lo bastante grande para cubrir los índices de las 5 líneas de residuo (que el mismo `pnpm probar`
imprime en `no interpretadas=`), comparar la forma completa (sin el truncado a 120) contra los tres
candidatos de arriba, y decidir código por código cuál aplica.

**Contingencia aplicada mientras tanto** (`verificarDestinos`, `packages/ingesta/src/verificacion/
invariantes.ts`): `residuo > 0` bajó de severidad `error` a `observación` — **el residuo se sigue
viendo en el log, pero no rechaza el lote**. `sinDestino > 0` y `destinos===undefined &&
declaraDestinos` NO están cubiertos por esta contingencia, siguen en `error` (son violaciones más
estructurales, no el mismo tipo de hallazgo). Restaurar a `error` es cambiar una línea
(`severidadResiduo`, comentario 🔴 en el propio código) cuando el residuo de Santander se explique o
baje a 0.

### 2.2 🔴 `traeSaldoInicialDeclarado` significa dos cosas, y en Galicia vuelve V3 una tautología

- Santander y Macro: `true` porque **hay etiqueta impresa**.
- Galicia: `true` porque el dato *"está disponible"* — pero se **deriva**:
  `saldoInicial = saldo(fila 1) − importe(fila 1)`.

El verificador hace `if (s1 - i1 !== inicial) → ARIT_SALDO_INICIAL`, e `inicial` **es literalmente
`s1 - i1` calculado por el adaptador**. 🔴 **V3 no puede fallar nunca en Galicia.** Es el autocertificado
que el contrato prohíbe, entrando por la puerta de la capacidad. (V4 sobrevive: compara contra la línea
`Total`, que sí es un dato del documento.)

**Decisión pendiente:** o `traeSaldoInicialDeclarado` pasa a tri-estado
(`declarado | derivado | ausente`) y V3 corre solo con `declarado`, o se agrega una capacidad hermana.
Las dos cambian el esquema de capacidades y lo que corre el verificador.

### 2.3 🔴 Tres conductas distintas cuando falta el período, y una pierde el extracto entero

| | Sin período | Consecuencia |
|---|---|---|
| Santander | `throw ErrorDeAdaptador('periodo_no_reconocido')` | rechazo con código ✅ |
| Macro | devuelve `null`, emite las cuentas sin período | el CLI lo frena en `cuenta_sin_periodo` ✅ |
| Galicia | `armarCuenta` devuelve `null` → `cuentas: []` | 🔴 **los 326 movimientos leídos se descartan en silencio** |

En Galicia el CLI termina en `sin_movimientos`, que es el mensaje **equivocado** para el hecho real — y
el operador que lee *"sin movimientos"* en un extracto de 326 filas no tiene por dónde empezar. Es el
mismo patrón que el caso `cuenta_no_pertenece_al_cliente` ya documentado.

La conducta de Santander tiene la razón escrita (*"un adaptador que siguiera adelante apagaría V7 en
silencio"*) y debería ser la única. Cambiarla implica que Galicia empiece a lanzar.

### 2.4 ✅ RESUELTO (A1, 2026-08-11) — La forma del contrato: cuatro tipos propios donde debería haber uno

`SalidaGalicia`, `SalidaMacro`, `EntradaGalicia`, `EntradaMacro` contra `SalidaDeAdaptador` /
`EntradaDeAdaptador`. Medido:

- Las dos **entradas** cuestan **cero**: son idénticas carácter a carácter al tipo del contrato.
- `SalidaGalicia` es barato: es un subconjunto.
- `SalidaMacro` **no es gratis**: declara `consolidadosPorMoneda` y `cuentasDeclaradas` como
  **requeridos** y el contrato los tiene opcionales; devolver el tipo del contrato rompe el typecheck
  estricto en dos tests. La salida correcta es declararlo como **estrechamiento**:
  `type SalidaMacro = SalidaDeAdaptador & { readonly consolidadosPorMoneda: readonly ConsolidadoPorMoneda[] }`.

**Y la regla que lo sostiene**, en `packages/data/tests/reglas-de-codigo.test.ts` (donde ya viven las dos
de aislamiento entre bancos): *ningún archivo de `adaptadores/` declara un tipo `Salida*` o `Entrada*`
propio; el contrato es `registro.ts`.* **Sin esa regla, el cuarto banco declara los suyos y volvemos a
tres.**

**Resuelto tal como estaba diseñado acá**, con dos ajustes que aparecieron al implementar (ver
`HANDOFF.md` 2026-08-11, entradas del cierre de A1): `packages/ingesta/src/index.ts` re-exportaba los
dos tipos `Entrada*` por nombre explícito y había que ajustarlo (si no, no compila), y la regla de
código quedó redactada contra el **lado derecho** de la declaración (`XxxDeAdaptador` o una
intersection de eso), no contra el nombre — porque `SalidaGalicia`/`SalidaMacro` siguen existiendo a
propósito, como fachada del contrato, no como tipos paralelos.

### 2.5 🔴 La lectura de carátula: hay un patrón que debería ser el único, y migrarlo mueve el hash

Galicia y Santander leen por **línea** (`textoDeFila`, que une todos los fragmentos con un espacio).
Macro lee por **fragmento**, acotado a una banda.

**El patrón correcto es el de Macro**, y las dos lecciones de `09` lo dicen: *el rótulo puede no abrir
la fila* y *la columna vecina comparte baseline*. **`valorPorEtiqueta` trabaja sobre `textoDeFila`: por
construcción no puede distinguir "el valor de la etiqueta" de "la columna de al lado".** Y Galicia hace
exactamente lo que Macro aprendió que es peligroso — toma el texto de la fila **antes** del rótulo como
razón social. Funciona porque está medido, y está a una versión del resumen de dejar de funcionar en
silencio.

**Hallazgo concreto de reimplementación:** `valorPorEtiqueta` devuelve `m[0]`. Galicia y Macro
necesitaban **grupo de captura** (`m[1]`), y por eso **los dos escribieron su propio lector**. Ésa es la
respuesta a *"¿alguien reimplementó algo que ya existe?"*: sí, dos veces, por una limitación de la firma.

🔴 **Por qué no se toca:** `leerNumeroDeCuenta` produce `numero` → `ClaveCuenta.numeroNormalizado` →
**material de `hashesDeCuenta`**. Tocar ese lector **mueve los 326 `fila_hash` de un lote ya
persistido**. Cualquier cambio acá va con `pnpm probar` en la mano y comparando el `numero` carácter a
carácter antes de tocar nada.

### 2.6 🟠 `absorber` devuelve `void` en Galicia y `boolean` en Santander

Santander tiene el criterio escrito: *"una fila del cuerpo que no aporta nada no es una continuación: es
algo que no se entendió, y absorberla en silencio es cómo una glosa termina con el encabezado de la
página adentro"*. En Galicia, toda fila dentro de un bloque abierto que no matchee el ruido se absorbe;
si no aporta glosa ni origen ni par, **la fila desaparece sin dejar rastro**. Corregirlo **sube el
residuo de Galicia** sobre el archivo real → va junto con 2.1.

### 2.7 🟡 Dos nombres y dos convenios para el lector de movimiento

Galicia y Santander devuelven el movimiento y el residuo lo empuja el llamador; Macro devuelve una
**unión etiquetada** `{ movimiento } | { codigo }`. El de Macro es el correcto —hace **imposible**
olvidarse de reportar— pero unificarlo obliga a reescribir el autómata de cierre de los otros dos.

### 2.8 🟠 A Galicia le falta el bloque "el fixture es el documento medido"

`09 §2` es explícito: *"un fixture escrito desde la especificación no la verifica: la consagra"*.

| | Bloque que fija la geometría antes de mirar el resultado | Tests por mutación |
|---|---|---|
| Santander | ✅ 2 tests | ✅ 3 |
| Macro | ✅ (con la historia de las **tres** veces que el fixture mintió) | ✅ 4 |
| **Galicia** | ❌ **ninguno** | 🟡 2 |

Galicia es el que **más** lo necesita: su fixture se escribió último y contra una spec que ya se
corrigió **cuatro veces**. **No se copia el de Santander**: hay que escribirlo mirando
`02-formato-galicia.md` §4 renglón por renglón y marcando cuáles tienen conteo verificado. Es trabajo de
spec, no de refactor.

### 2.9 🟡 Escribir el esqueleto canónico como plantilla

Los tres comparten esqueleto y difieren solo en el orden de las secciones. **No se reordenan archivos
que funcionan** — la coherencia es un medio, no un fin. Lo que sí conviene antes del cuarto banco es
escribir el esqueleto como plantilla (`09 §7` o un `adaptadores/PLANTILLA.md`), para que el cuarto banco
**nazca** alineado. Es más barato que alinear ocho después.

### 2.10 🟡 `unpdf` tira `Warning: TypeError: Math.sumPrecise is not a function` — benigno, confirmado

**Verificado contra archivo real** (A2, confirmación con el usuario, 2026-08-11): al correr `pnpm probar`
contra los PDF reales de Galicia (4 veces) y Santander (8 veces) aparece este warning al arrancar la
lectura. **No aparece con Macro.**

**De dónde sale, rastreado hasta el código fuente.** No es de este repo: `grep -r "sumPrecise"
packages/` da cero resultados, y `creditos`/`debitos` en `verificacion/invariantes.ts` son `BigInt`
acumulados a mano (`0n`), sin ningún `Math.sumPrecise` en el camino. Sale de la copia minificada de
`pdf.js` que empaqueta `unpdf` (`packages/ingesta/src/texto-pdf.ts`, `node_modules/.pnpm/unpdf@1.8.0/
.../dist/pdfjs.mjs`) — **17 usos, los 17 en código de escritura/subseteo de fuentes, formularios XFA
y guardado de PDF** (`GlyfTable.getSize()`, `Glyph.getSize()`, apariencias de campos de formulario,
MD5 para guardar). Ninguno está en el camino de decodificación de texto que `aFilas`/`extraerTexto`
consumen.

**Por qué falla.** `Math.sumPrecise` es una API de V8 muy nueva (propuesta TC39 en etapa 3). No existe
como global ni en Node v24.14.0 (confirmado) — la versión de `pdf.js` que trae `unpdf@1.8.0` la llama
sin comprobar si existe. Es un bug de esa dependencia, no de este repo.

**Por qué no rompe nada.** `pdf.js` tiene su propio `warn()` (`console.warn('Warning: '+e)`, confirmado
leyendo el bundle) — el error se atrapa y se loguea, no se propaga: si fuera una excepción sin atrapar,
el script se habría caído antes de imprimir el LOTE, y en cambio corrió completo hasta el veredicto.
Verificado además de forma empírica, no solo por lectura de código: en la corrida real de Galicia,
`verificoTotales=true` sin `ARIT_TOTAL_CREDITOS`/`ARIT_TOTAL_DEBITOS` — la suma de créditos/débitos
calculada por este repo (ajena por completo a `Math.sumPrecise`) coincidió exacta con el total que
declara la carátula del banco, más `hashes únicos = total` y cadena de saldos sin rupturas. Si el texto
extraído hubiera salido corrompido, ese cruce habría fallado con error, no en silencio.

**Por qué en Galicia/Santander y no en Macro.** Se investigó una hipótesis (¿correlaciona con
`traeTotalesDeclarados`/el camino V2 de verificación de totales?) y **se descartó con datos reales**:
Santander tiene `traeTotalesDeclarados: false` (no publica totales, usa V5) y el warning apareció igual,
8 veces. Los 17 usos están en fuentes/formularios del PDF, así que la correlación real es con la
estructura interna de cada archivo (fuentes embebidas, campos de formulario), no con qué verificación
corre de este lado.

**Qué hacer:** actualizar `unpdf` cuando exista una versión que no dependa de `Math.sumPrecise` sin
guardia, o reportarlo upstream. No bloqueante — no toca el veredicto de ningún lote.

---

### 2.11 🟡 `alta-cuenta.ts` duplica 3 regex de `santander.ts`; el guardrail cruzado solo cubre 1 de las 3

**Contexto:** el fix de `leerCaratula` multi-cuenta (HANDOFF 2026-08-11 (34) y su enmienda) duplicó a
propósito `RE_CABECERA_CUENTA`, `RE_NUMERO_CUENTA_EN_CABECERA` y `RE_ES_DOLARES` de
`packages/ingesta/src/adaptadores/santander.ts` en `apps/cli/src/alta-cuenta.ts` — no se importan
porque `packages/ingesta/src/index.ts` prohíbe exponer el vocabulario interno de un adaptador (§2.4).

**El hallazgo (`code-reviewer`, en la revisión de ese mismo fix):** el test guardrail
(`apps/cli/tests/alta-cuenta.test.ts`, describe `guardrail cruzado con santander.ts`) corre la misma
cadena literal contra `leerCaratula` y contra `reconoceSantander`, la única función pública que ejercita
`RE_CABECERA_CUENTA`. Pero `reconoceSantander` **no** evalúa `RE_NUMERO_CUENTA_EN_CABECERA` ni
`RE_ES_DOLARES` — esas dos regex duplicadas no tienen ningún cross-check automatizado. Hoy están
verificadas carácter por carácter contra el original (confirmado con `JSON.stringify`/`codePointAt`
sobre las dos copias, mismo `º` = U+00BA en las dos), pero una divergencia futura en `santander.ts:388`
o `:391` que no se replique acá pasaría el gate en verde.

**Por qué no se cerró en el mismo commit:** cerrarlo de verdad pide invocar `leerSantander` (que sí usa
las tres regex) con un `FilaGeometrica[]` completo — encabezado de columnas, región de tabla, cierre
con "Saldo total" — del mismo tamaño que las fixtures de `santander.test.ts` (~300 líneas). Es
desproporcionado para un fix puntual de `leerCaratula`, que ni siquiera arma `FilaGeometrica`.

**Qué hacer:** si se toca `alta-cuenta.ts` o `santander.ts` de nuevo, extender el guardrail para
ejercitar `leerSantander` con una fixture mínima (cabecera + "No tenés movimientos en ... este
período", sin movimientos reales) y comparar `cuentas[].numero`/`.moneda` contra lo que devuelve
`leerCaratula` para el mismo texto. No bloqueante — las tres copias están verificadas manualmente hoy.

---

### 2.12 🟡 Mismo hueco que §2.11, ahora para las dos regex de Macro (`RE_SECCION_MACRO`/`RE_CBU_MACRO`)

**Contexto:** el fix de `leerCaratula` para Macro (HANDOFF 2026-08-11 (38)) duplicó
`RE_SECCION_MACRO`/`RE_CBU_MACRO` de `packages/ingesta/src/adaptadores/macro.ts` en
`apps/cli/src/alta-cuenta.ts`, mismo motivo que §2.11 (`index.ts` prohíbe exponer vocabulario interno
de un adaptador). A diferencia de Santander, el *particionado* en secciones (`seccionesPorClave`) SÍ se
reusa importada — es infraestructura compartida de `toolkit.ts`, no vocabulario privado (`tech-lead`,
HANDOFF (38)) — así que la superficie duplicada acá es más chica: solo las dos regex y dos funciones
puramente derivadas (`tipoDeCuentaDelTituloMacro`/`monedaDelTituloMacro`).

**El hallazgo (`tech-lead`, en el diseño del mismo fix):** `reconoceMacro` (la función pública que el
adaptador real usa para reconocer el formato) no ejercita ni `RE_SECCION_MACRO` ni `RE_CBU_MACRO` — su
`MARCAS` usa `RE_ENCABEZADO_TABLA` y dos etiquetas de carátula distintas. No hay hoy ninguna función
pública de `macro.ts` que sirva de guardrail cruzado automatizado para estas dos regex, a diferencia de
`RE_CABECERA_CUENTA` de Santander (que sí tiene `reconoceSantander` como guardrail).

**Verificación hecha en su lugar:** corrida empírica de solo-conteo contra el archivo real del piloto
(nunca contenido, solo conteos y categorías) confirmando que las dos regex matchean sobre `aLineas()`
tal como se esperaba: 47 matches de `RE_SECCION_MACRO` (3 números de cuenta distintos, tipos
`corriente`/`especial`, monedas `ARS`/`USD`), 47 matches de `RE_CBU_MACRO`, con **las 47 dando
exactamente 22 dígitos** después de limpiar guiones. Confirma el diseño contra el archivo real, pero no
es un guardrail automatizado que el gate vuelva a correr — es una medición puntual de esta sesión.

**Qué hacer:** mismo camino que §2.11 — si se agrega superficie pública angosta a `macro.ts` (por
ejemplo, exportar `claveDeSeccion` como `claveDeSeccionMacro`, que ya es exactamente la función que
`seccionesPorClave` recibe en producción), un test podría correr la misma cadena literal contra las dos
copias. Decisión de superficie pública del paquete, no de este fix puntual. No bloqueante.

---

## 3. Lo que se corrigió en esta tanda (para que no se busque acá)

| Hallazgo | Dónde quedó |
|---|---|
| Ambigüedad permanente de cuenta (dos vigencias abiertas) | migración `0009` |
| Índice de resolución con el orden equivocado | migración `0009` |
| `fila_numero` faltante en el índice del lote | migración `0009` |
| El tipo del logger divergido de su fuente, y en camelCase | `clasificacion-campos.ts` + `logger.ts` |
| Seis claves sensibles en ninguna de las dos listas | `clasificacion-campos.ts` |
| Falso positivo del guardián de migraciones por CRLF | `.gitattributes` + `migrar.ts` |
| Un test que **consagraba** la ambigüedad permanente como estado esperado | `inv6-resolucion.test.ts`, reescrito en los dos sentidos |
| El encabezado del toolkit afirmando un hecho falso | `toolkit.ts` |
| El índice del residuo de Galicia (siempre `0`) | `galicia.ts` + test por mutación |
| La puerta del literal de anexo que no era espejo del `check` | `galicia.ts` |

---

## 5. Export a Excel para Laura (`pnpm exportar:excel`) — deuda declarada en el propio diseño

> A diferencia de las secciones 1 y 2 (auditoría retrospectiva del Módulo 1 ya construido), esto es
> deuda que la propia tarea declaró **al diseñarse**, no algo que un agente auditor encontró después:
> plan `adaptive-herding-pillow`, cerrado en `HANDOFF.md` 2026-08-12 (46). Va acá porque el criterio es
> el mismo — que nadie la redescubra desde cero.

### 5.1 🟡 `acceso_auditoria` no tiene columna `destinatario`

ADR-0002 §A.1 exige que todo export N2-R quede auditado "con motivo **y** destinatario" — dos datos, no
uno. La tabla `acceso_auditoria` solo tiene `motivo` (`text`, N2, append-only). `exportar-planilla.ts`
codifica los dos adentro de esa única columna: `"<motivo_codigo>|dest:<destinatario_codigo>"`, los dos
de vocabulario cerrado (`z.enum` en el CLI, nunca texto libre del operador).

**Por qué no se corrigió acá:** agregar la columna es una migración, y esta tarea no tocaba el esquema
de auditoría (CLAUDE.md §3.2(a) la dispararía de nuevo si se sumara sin plan propio). Además
`acceso_auditoria` ya tiene filas históricas con `accion='export'` (`descarga.ts`) sin este campo: una
migración real tiene que decidir si retrocompleta esas filas o las deja `NULL`.

**Qué hace falta para cerrarlo:** migración + `dba-data` + `seguridad-datos-financieros` (toca el modelo
de auditoría, dispara la matriz de §3.1) para decidir si la columna nueva reemplaza el parseo compuesto
de `motivo` en **todos** los lugares que ya lo generan, no solo en el export nuevo.

### 5.2 ✅ CERRADO (2026-08-12, misma sesión) — el TTL de 7 días ahora se calcula y se loguea

`apps/cli/src/exportar-excel.ts` agrega `TTL_DIAS_RECOMENDADO = 7` y `destruccionRecomendada(generadoEn)`
(`new Date(generadoEn)` con argumento, nunca `new Date()` a secas). El resultado `'exportado'` lleva
`destruirAntesDe` y el evento `exportar.completado` loguea `destruir_antes_de`. Test agregado al camino
feliz de `apps/cli/tests/exportar-excel.test.ts`. **No se tocó la leyenda "Procedencia" del workbook**
(queda con `cliente`/`lote`/`correlacion`/`motivo`/`destinatario`, sin la fecha de destrucción) — eso
sigue pendiente si se quiere que el recordatorio viaje con el archivo y no solo con el log; alcance menor,
declarado, no bloqueante. **El borrado del archivo sigue siendo un acto humano** (ADR-0002 §F.3.8) — lo
único que se automatizó es el cálculo y el recordatorio, nunca la destrucción en sí.

<details>
<summary>Diagnóstico original (antes del cierre), para trazabilidad</summary>

El diseño aprobado por el usuario ("adelante con el export, con controles completos, MÁS TTL y borrado
explícitos declarados") preveía que `pnpm exportar:excel` imprimiera/logueara una fecha de destrucción
recomendada (`generado_en + 7 días`) en el evento `exportar.completado`, como recordatorio automático —
así quedó descrito en el plan y en el pedido de cierre de esta misma tarea.

**Verificado contra el código el 2026-08-12 (cierre de la tarea, documentador): no está implementado.**
Ni `apps/cli/src/exportar-excel.ts` (el evento `exportar.completado` solo loguea `cliente_id`,
`lote_id`, `banco_codigo`, `correlacion`, `filas`, `cuentas`, `archivo_nombre`, `archivo_bytes` —
buscado en el archivo, no hay campo de fecha derivada), ni
`packages/ingesta/src/planilla/exportar-planilla.ts`, ni `armar-libro.ts` (que sí escribe `generado_en`
en la celda `A1` y en la leyenda "Procedencia" de `Control de saldos`, pero nunca una fecha calculada a
partir de él) tienen ningún cálculo de TTL. Búsqueda de `ttl`/`destruc`/`7 d[ií]as` en los tres archivos
y sus tests: cero resultados salvo el comentario que **menciona** que el export "no tiene TTL" como
contraste con una descarga.

**Consecuencia práctica:** el control sigue vigente como decisión (es un acto humano registrado, tal
como decidió el titular — ver el procedimiento nuevo en `docs/seguridad/registro-excepciones.md`), pero
hoy depende **enteramente** de que quien corre el export calcule `generado_en + 7 días` a mano y lo
registre — nada en el sistema se lo recuerda ni lo verifica, y el propio archivo `.xlsx` tampoco lleva
la fecha de destrucción en su leyenda (solo `cliente`/`lote`/`correlacion`/`motivo`/`destinatario`).

**Por qué no se corrigió acá:** el documentador no escribe código de producción
(`agents/personas/documentador.md`, "Qué NO hace"). Cerrarlo es código real (un campo derivado en el
`logger.info` y en la leyenda del workbook) más su test.

**Qué hace falta para cerrarlo:** sumar al evento `exportar.completado` un campo
`destruye_recomendado_en` (ISO), calculado como `generadoEn + 7 días`, y agregarlo a la leyenda
"Procedencia" de `armar-libro.ts` (para que el recordatorio viaje con el archivo, no solo con el log).
Cambio chico, sin tocar esquema ni RLS — candidato a que lo tome `backend-dev` sin plan de §3.2 propio,
salvo que se decida sumarlo junto con 5.1.

</details>

---

## 6. Orden sugerido para retomar

1. **Antes del cuarto banco, sí o sí:** 2.4 (entradas del contrato + regla de código), 2.1 paso 1
   (vocabulario de destinos al toolkit), 2.9 (plantilla). Son las tres que evitan que el problema se
   multiplique por cinco.
2. **Cuando haya una tarea propia:** 1.1 (el lote-ancla), 2.2 (V3 tautológica en Galicia), 2.3 (el
   período faltante que descarta 326 movimientos).
3. **Cuando el volumen lo pida:** 1.2, 1.3, 1.4.
4. **Con `pnpm probar` en la mano y nunca de otra forma:** 2.5, 2.6, 2.8.
5. **5.2 (TTL calculado y logueado) ya está cerrado** (2026-08-12, misma sesión que lo abrió). Queda 5.1
   (columna `destinatario`), que espera a una migración propia del modelo de auditoría — no bloqueante
   para la próxima corrida real de `exportar:excel`.
