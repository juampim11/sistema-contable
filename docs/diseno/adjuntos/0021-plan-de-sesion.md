# Plan `0021` — el determinante de idempotencia, y capa C persistida

> `CLAUDE.md` §3.2, escrito **antes** del primer `Edit`. Disparadores (a) esquema/migración,
> (b) datos de clientes y aislamiento, (d) 3+ archivos.
> Reemplaza el plan que se aprobó en sesión y **nunca se escribió** (`HANDOFF` 54: el archivo se
> sobrescribió con el de `0015`). No se recupera — se rehace.

---

## Contexto: por qué esto, y por qué ahora

**Estado confirmado contra `HANDOFF` (68) y el árbol:** `main` en `2065c3d`; local y piloto ambos en
`0020`, mismo hash, sin drift; dueño `sistema_contable` con `rolsuper = true` en los dos entornos;
piloto con **1830 movimientos crudos y CERO reconocimientos persistidos**. `origin/main` sigue en
`a95d24f`. Local corre **PostgreSQL 16.13**.

**El problema, en una línea:** el determinante de idempotencia cubre **el código y no la entrada**, y la
entrada es mutable.

`motor_digest` es `sha256` del léxico ⊕ el catálogo alcanzable ⊕ `VERSION_DEL_MOTOR`
(`version.ts:148-172`) — **cero bytes de la fila del cliente**. Mientras tanto,
`recapturar-conceptos.ts:349-358` reescribe `concepto_banco`, `concepto_completo`,
`concepto_banco_estrategia` y `pagina_pdf`; y `backfill-contraparte.ts:303-310` reescribe
`contraparte_captura` — **y no es de una sola vez**: es el mecanismo de re-hasheo cuando rote el pepper.
La entrada real del motor son 8 campos (`lecturas.ts:266-277`) y **cuatro de las cinco columnas mutables
son entrada**. Consecuencia declarada en `escrituras.ts:298-302`: *un reproceso que cambie
`concepto_banco` sin cambiar la clase da no-op con la interpretación vieja intacta.* Fail-open y
silencioso.

**La segunda mitad no es un agregado: el DDL de `0014` la exige.** `0014:426-432` declara que
`uq_recon_determinante` es fail-closed provisorio y que la migración siguiente debe reemplazarla por una
que incluya el estado del padrón, creando `padron_manifestacion`. Esa `0015` nunca se escribió — el
número se lo comió el expediente de seguridad. Toda referencia a «0015 crea la contrapartida»
(`0014:12`, `0014:429-430`, `persistible.ts:135`, `reconocer-lote.ts:26`) es **texto obsoleto**.

**Decisión del titular:** una sola migración `0021` con las dos mitades.

**Lo que simplifica todo:** cero filas en `reconocimiento_movimiento` en los dos entornos. Sin backfill,
sin rewrite costoso, sin riesgo sobre datos existentes.

---

## 1. Qué cambia y qué no

### Cambia

| # | Qué | Dónde |
|---|---|---|
| 1 | `entrada_digest` **generada** sobre las 7 columnas de entrada | `movimiento_bancario_crudo` |
| 2 | `entrada_digest` **foto histórica** (trigger `BEFORE INSERT` + `not null`) | `reconocimiento_movimiento` |
| 3 | `padron_manifestacion_id` **FK, no un hash** | `reconocimiento_movimiento` |
| 4 | `determinante` **columna generada** sobre (1)+(2)+(3) — no escribible ni con grant | `reconocimiento_movimiento` |
| 5 | `uq_recon_determinante` reemplazada, con `nulls not distinct` | `reconocimiento_movimiento` |
| 6 | `revoke insert` de tabla + `grant insert` por columna | `reconocimiento_movimiento` |
| 7 | `padron_manifestacion` — tabla nueva, PK **uuid**, append-only | nueva |
| 8 | `reconocimiento_contrapartida` (+ satélite de matches) | nueva |
| 9 | **R40** nueva en `ADR-0002` §B, con 6 mutaciones | `ADR-0002`, `catalogo.test.ts` |
| 10 | El no-op de `escrituras.ts:303` y el `on conflict` de `:328` | `escrituras.ts` |
| 11 | Clasificación de toda columna nueva | `clasificacion-campos.ts` |
| 12 | Test de grants con cobertura **inversa de conjunto cerrado** | `catalogo.test.ts` |

### NO cambia — y qué se pierde con cada recorte

| Queda afuera | Qué se pierde |
|---|---|
| 🔴 **`reconocer-lote.ts:288` sigue con `padronDeclaradoCompleto: false`** | `es_tercero_padron_completo` sigue estructuralmente inalcanzable, y `reconocimiento_contrapartida` **nace con 6 de sus 7 estados sin productor**. Se pierde el beneficio funcional inmediato de la mitad B. **A cambio se gana lo único que importa acá:** el día que algo falle se sabrá si el problema es el esquema o el gate. Es disparador (c) de §3.2 por sí solo, con su propia predicción falsable — *cuántos movimientos cambian de estado con el gate prendido*, número que hoy no existe |
| **`grant select` no se recorta** | Ver §"El nudo del pepper". Se mantiene el hallazgo abierto y declarado, no cerrado |
| **`motor_digest` sigue sin ancla en la base** | Imposible por naturaleza: su referente es CÓDIGO. Queda cubierto por el trinquete de `version-del-motor.test.ts`, el check de forma y R-K. **Se escribe así en el encabezado**, no se disimula |
| **La recursión de RLS (P-1) no se toca** | Sigue siendo bloqueante de despliegue. Nada de `0021` depende de resolverla, y nada de `0021` la agrava |
| **#8 no se cierra** | No tiene arreglo dentro de la base. `0021` aplica los tres controles compensatorios que sí puede (§4) |
| **No se aplica al piloto en esta tarea** | La aplicación es autorización aparte del titular, con §1.9 corrido completo |

---

## 2. Qué se mide

| Criterio | Número |
|---|---|
| Línea de base hoy | `pnpm verificar` sobre `main`: **61 archivos, 1423 tests, 0 fallas** |
| Al cierre | Verde, con **+N tests** desglosados abajo |
| Mutaciones de R40 | **6**, elegidas para refutar, + el caso legítimo |
| Mutaciones del grant | **4** (tabla entera → rojo; `created_at` agregado → rojo; conjunto legítimo → verde; tabla inexistente → rojo por vacuidad) |
| Mutaciones del determinante | **7** ya corridas por `dba-data`, van a la suite |
| Test de grants | `toEqual` del conjunto **exacto**, nunca `not.toContain` |
| Piloto | `tenant_node`/`membership`/`movimiento_bancario_crudo`/`lote_ingesta`/`acceso_auditoria` = **4 / 1 / 1830 / 3 / 9**, antes y después. `verificar_coherencia_path()` = **0** |
| Costo del `ADD COLUMN … GENERATED` | **No medido.** Se toma en local **con el corpus cargado** antes de tocar el piloto |

---

## 3. Predicción falsable

Escrita **antes** de tocar código. El método de `09-lecciones-aprendidas.md` §5.

| Si sale… | Significa… |
|---|---|
| 🔴 **P0: cero movimientos del corpus cambian de `entrada_digest` por la recaptura ya corrida** | **La premisa de `0021` es falsa** y hay que replantear la migración entera. Es la medición que puede matar el plan antes de gastar una migración |
| P0 da > 0 | El bug de `escrituras.ts:298` tiene magnitud real y ese número **es** su magnitud |
| P1: los digests contados en la base ≠ los contados en TS | La expresión SQL y la de TypeScript divergen. Hay que saberlo en P1, no en P3 |
| La mutación 1 de R40 (único global, determinante N1) da **rojo en R40 y verde en R6** | R40 no es redundante con R6 — es la única mutación que lo prueba |
| Esa mutación diera **rojo en las dos** | R40 se implementó mirando la clasificación en vez de la forma: está mal escrita y no discrimina nada |
| La mutación 3 (tenant presente pero **no primero**) da **verde** | La implementación no es el ingenuo `cols[0] === 'cliente_id'` |
| La mutación 5 (barrido apuntado a esquema vacío) da **verde** | El barrido está roto y las otras cinco pasaron sin mirar nada — R39c |
| El caso legítimo del grant (las 15 columnas + movimiento propio) **no** commitea | El recorte rompió producción: `escrituras.ts:323-326` **nombra `id`** |
| P4: cero movimientos pasan de `decision_humana` a `propuesta` al prender el gate | Algo está mal — esa rama es inalcanzable hoy, así que el número tiene que ser > 0 |

---

## 4. Qué agentes se convocan

Convocados y **cerrados** (§3.1: la tarea de convocatoria se marca `completed` sólo tras una llamada
real a `Agent()` cuyo reporte quedó incorporado):

| Agente | Estado |
|---|---|
| `dba-data` | ✅ Todo medido contra local en transacciones revertidas |
| `arquitecto-software` | ✅ |
| `seguridad-datos-financieros` | ✅ |
| `security-engineer` | ✅ Todo medido, incluido el #7 reproducido en laboratorio |

**Pendientes, y bloquean la implementación:**

| Agente | Para qué | Bloquea |
|---|---|---|
| 🔴 `contador-dominio` + `motor-conciliacion-contable` | **La forma de `reconocimiento_contrapartida`.** Condición de `arquitecto-software`: esa tabla aparece **una sola vez en todo el repo** (`0014:12`), como nombre suelto — cero columnas previstas, cero criterio. *«Lo que objeto no es el número de archivos: es diseñar una tabla adentro de la migración que la aplica.»* También: la enumeración de tipos exclusivos de capa C para el check, y la regla de frescura de la manifestación | Abrir el `.sql` |
| `qa-automation` | El gate `COMPONENTES_DEL_DETERMINANTE`, el de `COLUMNAS_FUERA_DEL_DETERMINANTE`, y el conteo de mutaciones | P2 |
| `tester` + `code-reviewer` | Antes del Done | Cierre |
| `documentador` | `HANDOFF`, `05` §5.2 reescrita, cierre de `10-deuda-declarada` §0.0 A.1 | Cierre |

---

## 5. El paso revertible más chico

| Paso | Qué | Número que mueve |
|---|---|---|
| **P0** | `digestDeEntrada()` puro en `nucleo/`, **por exclusión**, sin DDL | Cuántos `entrada_digest` habrían cambiado por la recaptura ya corrida. **Puede falsificar el plan entero** |
| **P1** | La generada + su check en `movimiento_bancario_crudo`. Sola | Digests distintos en la base = los de P0 |
| **P2** | Trigger + `entrada_digest` + `determinante` generado + unicidad nueva + recorte del grant | Conteo de mutaciones |
| **P3** | `padron_manifestacion` + la FK + el check de nulidad pareada | Conteo de mutaciones propio |
| **P4** | `reconocimiento_contrapartida` (con su forma ya ratificada) | Promociones con evidencia completa |
| **P5** | *Fuera de `0021`.* Soltar el `false` de `reconocer-lote.ts:288` | Movimientos que cambian de estado |

⚠️ **Honestidad sobre la reversibilidad, en palabras de `arquitecto-software`:** si P1–P4 van en un
archivo, van en **una transacción**, y **la unidad revertible en el piloto es la migración, no el paso**.
Los pasos son revertibles **en local**, cada uno verificado solo contra una base descartable creada desde
template — como `dba-data` ya hizo para `0014`. Decirlo de otro modo sería vender como reversibilidad lo
que es sólo orden de trabajo.

---

## Las dos preguntas de diseño, resueltas

### Pregunta 1 — ¿columna generada, o hash en TypeScript?

> **Las dos, en capas distintas. Y la premisa de la pregunta estaba mal apoyada.**

🔴 **Corrección de premisa.** `10-deuda-declarada.md` §0.0 A.1 dice que el invariante tiene *«exactamente
la forma»* de `path = f(parent_id, nid)` y deriva de ahí «columna generada + `unique`».
**`0017_path_por_construccion.sql` no usa una columna generada**: usa columna espejo plana + `CHECK`
fila-local + FK compuesta `match full deferrable` + trigger (`0017:131, 180-182, 198-202, 213-232`). El
precedente real de generada+`unique` es `0014:184` (`es_propuesta`), con **expresión inline pura**. En
todo el repo **no hay una sola generada que invoque una función de usuario**.

🔴 **Y la restricción que decide:** `arquitecto-software` midió que la entrada del motor **sí es
fila-local** — los 7 campos salen de la misma fila de `movimiento_bancario_crudo`, y `banco_codigo` ya
está cubierto transitivamente porque `motor_digest` es **por banco**. La generada es viable en el padre.

**La FK que proponía `arquitecto-software` funciona y se descarta igual.** Medición `F4` de `dba-data`:

> Una FK afirma un hecho **PRESENTE**; el determinante registra uno **HISTÓRICO**.

Con `on update restrict`, el primer reconocimiento **congela `concepto_banco` para siempre** y
`recapturar-conceptos.ts` muere con `23503`. Con `cascade` es peor: reescribe en silencio el digest de
una interpretación ya emitida.

**Gana el trigger — y la objeción de `0014:684-688` no aplica.** Ese trigger **CUENTA** (sin filas
visibles cuenta 0, falla ABIERTO); éste **COPIA** (sin filas visibles deja `NULL`, y el `not null`
rechaza). Medido en los dos sentidos (`X1`/`X2`). **Contar y copiar fallan en direcciones opuestas.**
El `not null` es load-bearing: un `check` solo no cierra nada, porque sobre `NULL` da `UNKNOWN` (`S4`).

**Forma del hash, medida:** `left(md5(…),16)`, no `sha256`. `sha256` exige `bytea`, y `text::bytea`
**reinterpreta el texto** (`'ZZ\xGG'::bytea` → `22P02` en runtime; `'\101'::bytea = 'A'` → dos textos
distintos hashean igual); `convert_to(…,'UTF8')` es lo correcto y **no es `IMMUTABLE`**; **`pgcrypto` no
está instalado** y es no-core (ADR-0000 §2). `concat()`/`concat_ws()` son `STABLE` y no entran.
`date::text` tampoco (`DateStyle`) → la fecha va como `(fecha - date '2000-01-01')::text`. Y **prefijo de
longitud por campo**, porque `md5(a || '|' || b)` con un `NULL` da `NULL` entero y `text` no admite el
byte NUL: no hay separador reservado.

🔴 **La tercera forma, que es la que de verdad transfiere la lección de `via_depth`** — de
`security-engineer`, medida (`O3`): el **`determinante` como columna generada** sobre
`(motor_digest, entrada_digest, padron_manifestacion_id)` **no se puede escribir ni con grant explícito**
(`428C9 cannot insert a non-DEFAULT value`). Es estrictamente más fuerte que cualquier recorte de ACL. Y
el estado del padrón entra como **FK, no como hash**: un hash lo elige quien escribe y la base no lo
puede verificar; una FK tenant-consistente sí, y sobrevive a `BYPASSRLS` y a `COPY`.

🔴 **Hallazgo bloqueante de forma — `nulls not distinct`.** Capa B no consulta el padrón, así que
`padron_manifestacion_id` es `NULL` en **toda** fila de capa B, y un `unique` clásico trata los `NULL`
como distintos: **dos filas idénticas entran las dos** (`N1`). *La idempotencia desaparecería justo en el
camino más transitado.* PG15+, disponible en 16.13.

**Límite declarado:** el dueño superusuario **sí** falsifica la foto histórica
(`session_replication_role='replica'` saltea el trigger, `M4`) y la generada **no** (`M5`). Es **P-1**, ya
declarada, y esto no la agrava — pero se escribe *«no falsificable por `app_request` ni `app_job`»*, no
*«no falsificable»*.

### Pregunta 2 — ¿se recorta el `grant insert`?

> **Sí — pero por dos agujeros distintos de los que la pregunta anticipaba, y la premisa era falsa.**

🔴 **La premisa es falsa, medido dos veces.** *«Bajo un grant de tabla esa columna es nombrable y el
determinante lo elegiría quien escribe»* — no:

- Si es **generada**: `cannot insert a non-DEFAULT value` (`I2`, `O3`). Rechaza el **mecanismo**, no el
  privilegio, y **ni un grant explícito alcanza**.
- Si la llena un **trigger**: la mentira **se sobrescribe en silencio** (`M1`: el insert entra y queda el
  digest verdadero). El recorte no compra integridad — compra que el intento falle **ruidoso**.

**La lección de `via_depth` no transfiere**: `via_depth` es fuerte porque su valor sale de un DEFAULT que
el atacante no puede reproducir (`pg_trigger_depth()` vale 0 fuera del trigger), no por el recorte.

🔴 **Pero el recorte va igual, por dos agujeros vivos HOY en `0014`:**

| Columna | Qué habilita hoy |
|---|---|
| **`created_at`** | Un tenant **antedata su propio reconocimiento**. H-B textual — lo mismo que `0019:88-90` y `0020` §1 cerraron para `ocurrido_en`. Nadie lo escribe |
| **`superseded_por`** | Se puede insertar una fila **NACIDA SUPERSEDED**: sale de `uq_recon_vigente`, **nunca aparece en la cola de la contadora**, y nada falla |
| `es_propuesta` | Postgres **acepta sin error** `grant insert` sobre una generada (`G1`). No hay red |
| `recalculo_disponible` | Sin productor (`0014` decisión 9) |

🔴 **`id` SE CONSERVA — copiar la forma de `0020` §1 rompe producción.** `escrituras.ts:323-326` **nombra
`id`**, porque la supersesión escribe `superseded_por = <id nuevo>` en la fila vieja **antes** del insert
(`:310-315`). Es el orden UPDATE→INSERT del punto 4 de `0014`. Y el `on conflict do nothing` lo haría
peor: `permission denied` no es un conflicto, así que el error sube crudo en el camino que corre 1830
veces. El riesgo residual es distinto del #7: `id` es `uuid default gen_random_uuid()`, no una secuencia
— para chocar hay que **adivinar 122 bits de CSPRNG de una fila que no se ve**. Riesgo aceptado y
declarado.

**Sintaxis, medida en ambas direcciones:** `revoke` a nivel **TABLA** + `grant` por columna. `revoke
insert (col)` sobre un grant de tabla es **no-op silencioso** (`G5`, `relacl` idéntica, sin warning);
`revoke insert` de tabla **sí** limpia los grants de columna sin residuo (`R1`).

⚠️ **Corrección a un comentario del repo:** `0018:58-59` afirma que *«`revoke update (parent_id)` sobre un
grant de columna existente no lo saca»*. **Medido, sí lo saca** (`R2`). Lo que no funciona es `revoke` por
columna sobre grant de **tabla**, que es lo que dicen correctamente `0018:60` y `0020:107`. La **acción**
de `0018` es correcta; la primera justificación está mal. `0018` está aplicada y **no se toca** — pero la
frase **no se propaga a `0021`**.

**Orden de precedencia, medido** (`0014:539-542` confirmado y ampliado):
`privilegio de columna (42501) → trigger BEFORE INSERT (P0001) → policy RLS → FK/unique`.

**El test que falta.** En todo el repo hay **un solo** test con cobertura inversa de conjunto cerrado
(`membership-supervision.test.ts:573`); los de `catalogo.test.ts:1158` y `:1194` usan `not.toContain`, así
que **una columna otorgada de más pasa verde**. Va un `toEqual` del conjunto **exacto** contra
`information_schema.column_privileges` — que sí expande un grant de tabla a una fila por columna, y por eso
discrimina el re-grant (medido: 16 filas → 20). `has_table_privilege` **no sirve**: bajo grant por columna
da `false`.

---

## 🔴 El hallazgo más pesado: R6 deja de discriminar

De `security-engineer`, medido. `catalogo.test.ts:332-335` sólo mira un índice único si **alguna de sus
columnas está clasificada N2/N2R/N3**. `motor_digest` está clasificado **N1** con buen argumento
(*«no es dato del cliente: es la identidad del artefacto de código»*). **Si el determinante nuevo se
clasifica N1 por el mismo argumento, un índice único GLOBAL sobre él pasa R6 en verde.**

Y un único global sobre el determinante es un **oráculo cross-tenant vivo**. Medido en laboratorio, con A
que **no ve** ninguna fila de B:

```
A inserta un digest que B ya tiene   ->  23505 duplicate key ... "uq_lab_global"
A inserta un digest que no existe    ->  INSERT 0 1
```

Distinguidor perfecto de existencia. Bajo RLS, Postgres **suprime el `DETAIL`** con los valores pero **no
el nombre del constraint** — la fuga es de existencia, no de valores, y alcanza porque **el valor de
sondeo lo elige el atacante**.

> *Es exactamente el caso que `CLAUDE.md` describe: un control impecable sobre el nivel de clasificación
> equivocado.*

### Regla nueva **R40**

> **Todo índice único que NO sea la clave primaria, sobre una tabla que tiene columna de tenant, incluye
> la columna de tenant.** Sin importar la clasificación de sus columnas, sin importar si es
> `create unique index` o `unique constraint`, y sin importar la **posición** de la columna de tenant.

Enunciada sobre la **propiedad**, no sobre el caso — la lección de R25, R33 y las dos primeras redacciones
de R36. **Nace verde y sin excepciones:** medido, los únicos sobre tablas con `cliente_id` que no incluyen
`cliente_id` son **16 y las 16 son la PK**; con `indisprimary = false` la línea de base es **0 filas**.

Y el argumento técnico que le corresponde a `seguridad-datos-financieros` para la clasificación: **si el
hash cubre la ENTRADA, ya no es la identidad de un artefacto de código** — es función de material N2, y
dos hashes iguales prueban dos entradas iguales. Es el criterio ya escrito para
`evidencia_entrada_lexico_id`: *se clasifica por lo que revela, no por la forma que tiene.* **R40 no
depende de esa clasificación, y ése es el punto.**

**Prueba de mutación de R40 — 6 mutaciones, elegidas para refutar**, más el caso legítimo. La nº 1
(único global con el determinante **N1**) debe dar **rojo en R40 y verde en R6**: es la única que prueba
que R40 no es redundante. La nº 3 (tenant presente pero **no primero**) debe dar **verde**: refuta el
ingenuo `cols[0] === 'cliente_id'`. La nº 5 (barrido apuntado a un esquema vacío) debe dar **rojo por
vacuidad**: la lección de R39c.

---

## Las tres tablas

### `padron_manifestacion`

**PK `uuid`, nunca `bigint identity`** — `security-engineer` **reprodujo el incidente #7** en laboratorio:
con `identity` + grant de tabla, A inserta `OVERRIDING SYSTEM VALUE` con id 2 y 3, y **el camino normal de
B muere con `23505`**. Denegación cross-tenant en una tabla que todavía no existe. El uuid la cierra de
raíz y evita además la mitad *fuga* de H-A.

| | |
|---|---|
| RLS | `enable` **y** `force`; predicado exacto; **no** entra en `EXCEPCIONES_R4` |
| `insert` | 🔴 **`socio`, `contador` — sin `administrativo`** |
| `update` / `delete` | **ninguna policy, ningún grant.** Una manifestación errónea **se supersede con una fila nueva** (`revoca_a uuid` + FK de dos columnas), jamás un `UPDATE`: una columna `revocada_en` actualizable no lleva autor, y el rastro diría que quien manifestó fue quien revocó |
| Sin grant | `id`, `manifestado_por`, `manifestado_en` |
| `manifestado_por` | `uuid not null default app.current_user_id()`. El `not null` es **portante**: fuera de un contexto de request la función devuelve `NULL` y el insert se rechaza con `23502` |
| `app_job` | **nada**, ni policy ni grant |
| Texto libre | **No va.** Es donde termina el nombre de un socio. Si hace falta, `motivo_codigo` cerrado |

**Por qué sin `administrativo` — los dos agentes convergieron por caminos distintos:**

- *Dominio* (`seguridad-datos-financieros`): el precedente ya está fijado en la tabla hermana,
  `0013:390-392` — *«decidir quién es socio de un cliente es criterio del contador»*. Manifestar es la
  misma decisión un nivel más arriba: no dice *«esta persona es socia»*, dice **«no hay ninguna otra que
  lo sea»**. Si no puede agregar un socio, no puede declarar cerrada la lista. Y el argumento de
  `0014:518-524` no transfiere: la manifestación no es una propuesta, es **la premisa que cambia el
  resultado del motor** — el administrativo estaría fabricando la premisa que convierte su propio trabajo
  en propuesta lista. **R38 en forma general.**
- *Técnico* (`security-engineer`), medido: mientras #8 esté abierto, **la lista de roles de la policy de
  INSERT *es* el conjunto de identidades forjables en `manifestado_por`**. Sacar `administrativo` reduce
  en uno, por nodo, el conjunto de firmas forjables. **Es el único control sobre #8 que una migración
  puede aplicar.**

**La consecuencia medida del error:** socio no cargado → su retiro cae en `es_tercero_padron_completo` →
promoción a `pago_a_proveedor_transferencia` en vez de `retiro_de_socio` → imputa a **Proveedores** lo que
es **Cuenta Particular**. 🔴 **Y el asiento cuadra igual**: el balance cierra, el IVA no cambia, y la
diferencia aparece —si aparece— en el cierre del ejercicio.

**Enunciado probatorio, en el `comment on column`** (no en un doc aparte: quien lee la columna es quien
necesita el límite). Vale: que alguien con credencial de `app_request` y membresía habilitada sobre este
cliente ejecutó esto en ese instante; la **fecha no es elegible** (DEFAULT sin grant), el **cliente
tampoco** (`0020` lo midió: otro estudio da `42501`). **No vale:** identificar a la persona —
`app.current_user_id()` es un GUC que setea la propia sesión, y medido con la credencial real,
`set_config('app.user_id', <otro>, true)` sale **genuina y mal atribuida**. 🔴 *Identidad declarada no es
identidad autenticada.*

🔴 **Condición para `ux-designer`/`frontend-dev`, no para la migración:** ninguna pantalla ni export puede
presentar `manifestado_por` como prueba de autoría. Si la cola dijera *«padrón declarado completo por
Laura»*, la pantalla afirma más de lo que el mecanismo sostiene — que es exactamente lo que `0019:85-90`
hizo y `0020` tuvo que desmentir.

### `reconocimiento_contrapartida` (+ satélite de matches)

🔴 **Su forma NO se diseña acá.** Condición de `arquitecto-software`, aceptada: la ratifican
`contador-dominio` y `motor-conciliacion-contable` **antes de abrir el `.sql`**. Lo que ya está fijado:

| | |
|---|---|
| `insert` | `socio`, `contador`, `administrativo` — **acá sí entra**: es salida del motor, mismo criterio que `reconocimiento_candidato` (`0014:746-749`) |
| `update`/`delete` | ninguna. Un resultado mal calculado no se edita: se supersede el reconocimiento entero |
| Nombres | 🔴 **`resolucion_estado` y `match_clase`, nunca `estado` ni `clase`** — el registro clasifica **por nombre de columna globalmente**, y una columna `clase` en N2 haría que el redactor tape **todo** campo llamado `clase` de todo log, incluido el `reconocimiento_movimiento.clase` que es N1 a propósito y es lo que muestra la cola |
| **No van** | `vigenteDesde`/`vigenteHasta` (duplican un hecho **mutable** —`0013:417` da `grant update (vigente_hasta)`— y con ellas adentro `select resolucion_estado, socio_id, vigente_hasta` devuelve **la fecha de salida de cada ex-socio** desde la tabla que se lista entera todos los meses); `pepperIds*` (estado de la **plataforma**, no del cliente: durante una rotación la tabla se llenaría de miles de filas sin un solo hecho del cliente) |
| `socio_id` | **N2**, ratificando el antecedente de `HANDOFF:1913-1914` que nunca se aplicó porque era para la `0015` que no se escribió. Rompe `escrituras.ts:78-83` y `:161`, que van en la misma tarea |
| Satélite de matches | 0..N, mismo idiom que `reconocimiento_candidato`: un array no admite FK, ni unicidad por elemento, ni check por elemento |
| `padron_manifestacion_id` | 🔴 `not null` **sólo en las ramas que dependen del gate** (`resolucion_estado in ('es_tercero_padron_completo','sin_match_padron_incompleto')`); en las otras cinco la resolución **no consultó el gate** y la columna no debe mentir que sí. Misma forma condicional que `reconocimiento_forma_chk` — una nulidad grupal daría verde a una fila que exhibe una premisa que no usó |

**Régimen de auditoría: las tres tablas quedan fuera, y es mecánico.** Con cero columnas N2-R/N3,
`tablasQueExigenRolEnLectura()` las excluye por derivación. Si una sola terminara en N2-R, la tabla entra
sola en `tablasSinLectorAuditado()` y **el gate se pone rojo**. El control ya está construido; `0021` no
lo rompe. 🔴 **Restricción dura que se sigue de ahí:** si el estado del padrón se calculara sobre
`padron_socio_documento.documento` (**N2-R**), `reconocimiento_movimiento` entera cae al régimen auditado
y **la cola de revisión se vuelve inusable**. Por eso el padrón entra como **FK a la manifestación**, no
como digest del documento. (`arquitecto-software` y `seguridad-datos-financieros` llegaron a esto por
caminos distintos.)

🔴 **Riesgo a vigilar — `siembra_sintetica`.** Es el único motivo de `conJob` que escribe dominio. Hoy
`sintetico.ts` no menciona `reconocimiento`. **Dictamen: no se siembran estas tablas**; si hacen falta
datos de desarrollo, se siembran bajo `conUsuario`. Es el punto (7) de R38: *un privilegio sin camino de
producción nombrado no es una excepción documentada, es superficie.*

---

## El nudo del pepper — resuelto a la baja, y por qué

`seguridad-datos-financieros` exigió que `entrada_digest` se calcule con **pepper derivado por cliente**:
sin él, la misma glosa da el mismo digest en dos clientes del mismo estudio, y un `contador` con membresía
en ambos correlaciona con un join sin leer un solo CUIT. **Una columna generada no puede acceder a un
secreto de entorno**, así que el pepper y la generada son incompatibles.

🔴 **Verificado por quien conduce (§3.1 regla 5), y baja la severidad:** el ataque exige acceso RLS a los
**dos** tenants — y `concepto_banco` está clasificado **N2, no N2-R**
(`clasificacion-campos.ts:415-426`), o sea que **se lee directo bajo `conUsuario`, sin lectura auditada**
(`lecturas.ts:288-329` es un `select` plano). *Quien puede correlacionar por el digest ya puede
correlacionar por la glosa misma, y con mejor resolución.* **El digest no agrega ninguna capacidad.**

Y el hallazgo, tal como está enunciado, **ya es cierto hoy de `fila_hash`** — N2, comparable, sin pepper,
`exportable: false` — que este plan no creó.

**Decisión: generada sin pepper**, clasificada **N2 / `exportable: false`** citando el precedente de
`fila_hash`. A cambio se conserva lo que el pepper habría costado: la no-falsificabilidad por
`app_request`/`app_job` y el cierre del modo de falla de concurrencia que `arquitecto-software` midió
—recaptura y persistencia simultáneas, **las dos commitean**—, que *ningún test de aplicación atrapa y
ninguna revisión de código ve*.

⚠️ **Queda declarado, no cerrado:** el día que exista un rol que vea la cola de revisión **sin** ver los
movimientos crudos, la premisa de esta decisión se cae y hay que revisitarla. Va a
`10-deuda-declarada.md`, no a un comentario.

---

## Los dos gates nuevos que hoy no existen

Sin ellos el diseño es **peor** que la alternativa (`arquitecto-software`):

1. 🔴 **El DDL es por INCLUSIÓN y `version.ts` se construyó por EXCLUSIÓN a propósito.** Una columna nueva
   en `movimiento_bancario_crudo` que el motor empiece a leer **nace fuera del digest, en silencio** — el
   mismo fail-open que `version.ts` existe para cerrar, reintroducido del otro lado del límite. Cierre: un
   test que lea `pg_attribute` y exija que toda columna esté **o** dentro de la expresión de la generada,
   **o** en una lista `COLUMNAS_FUERA_DEL_DETERMINANTE` **con su motivo escrito**. Es el mecanismo de
   `catalogo.test.ts:102-124`, que ya corre. **Con ese test, el DDL es por inclusión y el sistema por
   exclusión.**
2. **`COMPONENTES_DEL_DETERMINANTE` en TS ↔ `conkey` de `uq_recon_determinante`.** Verificado: hoy
   **ningún test ata un `unique` a una constante de TS** (`DOMINIOS_CERRADOS` sólo matchea
   `col = ANY (ARRAY[…])`). Sin esto, la quinta fuente de variación se absorbe del lado del código sin
   migración. **Y ya hay cuarta y quinta**, descubiertas sólo por enumerar: los **candidatos de
   contraparte** (mutables, en otra tabla — ninguna generada los alcanza) y el **`pepper_id` de la
   corrida**.

---

## Dos hallazgos fuera de alcance, que se arreglan en la misma tarea

🔴 **H-1 — `loggerAcotado` no verifica su allowlist contra el registro.** `logger.ts:150-170` tipa los
campos como `Partial<Record<Clave, ValorLoggeable>>` y hace `as CamposLoggeables`: **`Clave` no se
intersecta con `ClaveProhibida` en ningún lado.** Con `socio_id` en N2 deja de ser hipotético —
`alta-socio.ts:65-75` ya declara `'socio_id'` y lo emite en `:253` y `:294`: siguen compilando, y el
redactor los degrada a `[REDACTADO]`, perdiendo el único asidero para depurar un alta **sin que nada
avise**.

🔴 **H-2 — `resolver-contrapartida.ts:309` publica `sociosInvolucrados` a stdout sin redactor.**
`process.stdout.write` lo esquiva por completo. **El día que `socio_id` sea N2 —o sea, con `0021`— esa
línea publica una lista N2 en stdout**, y `pnpm resolver:contrapartida > salida.json` deja en disco, sin
clasificar y sin rastro, la lista de socios de un cliente. Arreglo recomendado: dejar sólo el **conteo**.

---

## Defectos preexistentes reportados, que NO se arreglan acá

- **R11 se verifica por `proname` suelto** (`catalogo.test.ts:535-543`), sin esquema ni aridad: una
  sobrecarga o una homónima en el otro esquema pasa verde.
- **R7 ya es vacua bajo P-1** — 116 relaciones con owner `sistema_contable`, que tiene `bypassrls` por ser
  superusuario. El test sólo falla si el owner es `app_job`. **No marcar R7 ✅ por esto.**
- `0018:58-59` (ver arriba).

---

## Verificación de extremo a extremo

```bash
pnpm db:up && pnpm db:migrate && pnpm db:setup   # local, contra base descartable primero
pnpm db:seed                                     # sintético, nunca real
pnpm verificar                                   # typecheck + barrido + fixtures + suite
```

Más, específicamente:
1. **P0 sin DDL**, midiendo sobre el corpus local — es lo que puede falsificar el plan.
2. Cada paso verificado solo contra **base descartable creada desde template y borrada al terminar**, como
   `dba-data` hizo para `0014`.
3. Las **17 mutaciones** (6 de R40 + 4 del grant + 7 del determinante) en la suite, con su caso legítimo.
4. El costo del `ADD COLUMN … GENERATED` medido **en local con el corpus cargado**.
5. 🔴 **El piloto no se toca en esta tarea.** Su aplicación es autorización aparte del titular, con
   `CLAUDE.md` §1.9 corrido completo: `ENV_FILE=.env.piloto pnpm db:migrate --estado` → listar → confirmar
   que coincide **exacto** → frenar si aparece una de más. **Nunca `pnpm db:migrate` pelado.**
