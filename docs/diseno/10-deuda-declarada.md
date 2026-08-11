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

## 4. Orden sugerido para retomar

1. **Antes del cuarto banco, sí o sí:** 2.4 (entradas del contrato + regla de código), 2.1 paso 1
   (vocabulario de destinos al toolkit), 2.9 (plantilla). Son las tres que evitan que el problema se
   multiplique por cinco.
2. **Cuando haya una tarea propia:** 1.1 (el lote-ancla), 2.2 (V3 tautológica en Galicia), 2.3 (el
   período faltante que descarta 326 movimientos).
3. **Cuando el volumen lo pida:** 1.2, 1.3, 1.4.
4. **Con `pnpm probar` en la mano y nunca de otra forma:** 2.5, 2.6, 2.8.
