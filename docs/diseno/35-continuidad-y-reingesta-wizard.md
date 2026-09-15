# 35 — Continuidad y re-ingesta del wizard de la demo (huecos reales, no diseño cerrado)

> **Qué es este documento.** Responde a una consulta del titular sobre el flujo de 6-7 pasos del wizard
> de la demo interactiva (`docs/diseno/34-modelo-interaccion-wizard-demo.md`), tratado explícitamente
> como **propuesta a validar, no diseño cerrado**. Convocatoria real, en paralelo, a
> `arquitecto-software`, `dba-data`, `contador-dominio` y `analista-funcional` (2026-09-14/15), cada uno
> con dictamen propio e independiente — sin narrar la voz de otro. Los cuatro convergen en las
> conclusiones de fondo, con evidencia de código/esquema real, no teoría.
>
> **Por qué existe.** Mismo motivo que el doc 34: "planes y dictámenes van al repo". Es la misma pregunta
> de fondo que `ADR-0004` (nunca escrito) — verificado antes de convocar: `ADR-0004` está documentado
> como **"una fuente vigente por cuenta-período"** (`docs/diseno/31-replanteo-hacia-producto.md:396`), no
> literalmente "doble ingesta" — el nombre casual del titular apuntaba al mismo territorio conceptual,
> pero el alcance real ya estaba decidido y diferido (B.25) antes de esta consulta.
>
> **Alcance verificado antes de escribir**: `apps/web` no existe todavía en el repo. El wizard es hoy un
> modelo de interacción (doc 34) + un boceto de Pantalla 1 (Artifact) + un backend genérico sin
> commitear. Ningún código de UI corre todavía contra Bracci/ROKA — pero el día que se conecte, va a
> escribir sobre los mismos mecanismos (`confirmarGrupo()`, `confirmarAsiento()`, `ingestar.ts`) con los
> mismos huecos que este documento encuentra hoy.

---

## 1. Estados intermedios y continuidad

**Convergencia de los cuatro dictámenes**: no hace falta ninguna tabla de "sesión de wizard" ni de
progreso/checkpoint. Cada confirmación real (`confirmarGrupo()`, `confirmarAsiento()`,
`packages/data/src/cierre/escrituras.ts:270-330,604-636`) es una escritura atómica, una fila por click,
auditada por sí sola — no depende de que se guarden N decisiones juntas al final. Si Laura sale a mitad
de revisar 40 grupos, lo que confirmó ya está persistido; lo que no, sigue exactamente igual de pendiente
— la próxima lectura de `agruparDecisionesPendientesConConfirmaciones` (`packages/ingesta/src/cierre/
agrupar-decisiones-pendientes-con-confirmaciones.ts:39-105`) **recalcula desde cero** contra datos ya
comiteados, nunca reanuda un caché.

Las tres únicas cadenas con estado real recuperable son (`dba-data`, `arquitecto-software`):
1. **Ingesta** — `lote_ingesta.estado` (`0004_ingesta.sql`).
2. **Capa C** — presencia/ausencia de fila en `reconocimiento_movimiento` (paso operativo aparte,
   `reconocer:lote --aplicar`).
3. **Confirmación de grupo** — vigencia en `confirmacion_grupo` (`0043`).

Todo lo demás (navegar la revisión, elegir cliente/cuenta) no necesita persistirse porque se recalcula
puro y determinístico cada vez.

**Hallazgo de proceso, no técnico** (`dba-data`, citando el propio doc 34 §0 como evidencia): el modelo
de interacción del wizard **ya sufrió este defecto una vez** — el listado original de los 8 pasos vivió
solo en una conversación y se perdió. Es el mismo patrón exacto que esta sección describe para los datos
de Laura.

**Clasificación: Completitud de producto — diferible sin riesgo.** Nada se corrompe ni se duplica por la
ausencia de una tabla de progreso — el riesgo solo aparecería si una futura UI decidiera cachear
decisiones sin persistir hasta un "guardar todo al final" (decisión de implementación todavía no tomada,
no un hueco de hoy).

**Precondición real antes de construir "retomar"** (`dba-data`): no es una tabla de checkpoints — es
cerrar primero el hallazgo de §2 de este documento (el lote-ancla que se pierde en el camino de
excepción). Un mecanismo de "retomar" construido sobre un piso que puede desaparecer sin rastro invierte
en la capa equivocada primero.

**Historias de usuario** (`analista-funcional`):

| HU | Enunciado | AC | Clasificación |
|---|---|---|---|
| HU-1 | Como Laura, quiero que lo ya confirmado en "revisar e imputar" siga guardado si cierro el navegador a mitad de pantalla | Reabrir muestra exactamente los grupos con `requiereRevision:true` que quedaban, ni uno más ni uno menos | Riesgo de integridad — la guarda es no romper el patrón "una escritura por grupo" |
| HU-2 | Como Laura, quiero saber si una carga que se cortó quedó a medias o no pasó nada | `ingestar()` corre en una única transacción — o comitea todo o nada (`ingestar.ts:290-297`) | Completitud — ya existe, falta comunicarlo en la UI |
| HU-3 | Como Laura, quiero que un asiento ya confirmado no pueda "perderse" ni retroceder por accidente | Ya cubierto por el trigger `0028` (`P0002`, nunca silencioso), ver doc 34 §1.3 | Ya cubierto hoy |
| HU-9 | Como Laura, quiero que al reentrar al wizard vea el estado real del servidor, no un progreso que el navegador "recordaba" | Cada pantalla posterior a una escritura vuelve a pedir el estado real al entrar, nunca reanuda desde estado solo-cliente | Riesgo de integridad — sin esto, un F5 en el momento equivocado puede mostrar un paso cerrado como abierto |

---

## 2. Re-ingesta del mismo banco/cuenta/período

### 2.1. Qué previene el mecanismo real, con la distinción exacta pedida

**Duplicación física de filas** (Capa A/B, no Capa C): `uq_mov_crudo_fila unique (cliente_id,
cuenta_bancaria_id, fila_hash)` (`0004_ingesta.sql:467`), con `fila_hash` calculado por contenido
económico puro (banco, cuenta, fecha, importe, saldo, glosa normalizada, ordinal de empate —
`packages/ingesta/src/hash.ts:84-98`), **sin** `lote_ingesta_id` ni timestamp. Esto SÍ atrapa la
re-ingesta del mismo movimiento, venga del mismo archivo o de uno distinto con el mismo contenido.

**Lo que NO hace este mecanismo** (`arquitecto-software`): `entrada_digest`/`digestDeEntrada`
(`0021_determinante_de_entrada_y_capa_c.sql`) es un determinante **distinto y aguas abajo** — decide si
Capa C vuelve a evaluar un `movimiento_id` que **ya existe**, nunca si ese movimiento es en sí mismo un
duplicado. La prevención de duplicados vive enteramente en el `unique` de arriba, no en Capa C.

### 2.2. El hallazgo más concreto de todo el dictamen — `dba-data` y `analista-funcional`, de forma
independiente, con el mismo mecanismo exacto

Un archivo distinto (extracto reemitido, con al menos una fila que ya existe por `fila_hash`) no tiene
`ON CONFLICT` en su `INSERT` (`packages/ingesta/src/persistir.ts:304-339`) → choca `23505` → se traduce a
`ErrorDeBase('ING_DUPLICADO')` (`packages/data/src/db/errores-pg.ts:78,108`) → **este throw NO lo captura
el `SAVEPOINT`/`rechazar()` de `ingestar.ts`** (declarado explícito en el propio código,
`ingestar.ts:389-392`) → escapa al `catch` de `conUsuario` → **ROLLBACK de la transacción completa**,
incluido el `insert into lote_ingesta` del paso 4.

**Consecuencia medida**: Laura no obtiene ni un `lote_ingesta con_errores` que ver en pantalla, ni
`motivo_codigo`, ni fila en `acceso_auditoria` — solo `exit 2` con stderr genérico
(`ingestar.ts:829-841`). Si reintenta con el mismo archivo, choca en la misma fila, sin memoria del
intento anterior. Esto **ya estaba documentado como hueco abierto** antes de esta consulta
(`docs/diseno/10-deuda-declarada.md` §1.1, 🟠 — "el lote-ancla se pierde en todo camino de excepción"),
pero un wizard de re-ingesta activa es exactamente el camino que lo va a disparar de forma rutinaria, no
ocasional.

**Clasificación: Riesgo de integridad de datos — necesita guarda mínima incluso en el camino feliz.**
Contradice CLAUDE.md §1.4 ("el uuid del registro alcanza para depurar") porque acá no se crea ni el
registro.

### 2.3. El hueco que sí es nuevo — segunda fuente con formato distinto

`arquitecto-software`: el `fila_hash` no atrapa una **segunda fuente** para el mismo cuenta-período con
formato levemente distinto (PDF vs. Excel del mismo extracto, un re-export tras un cambio de versión del
sistema del banco) — produce un hash distinto para la misma transacción real, y entra como fila nueva sin
que nada lo note. Tampoco hay guardia de **solape de rango** a nivel `lote_ingesta_cuenta`/
`documento_ingerido`. Esto es, literalmente, lo que `ADR-0004` (sin escribir) tiene que resolver — y hoy
no existe ni como capacidad declarada.

**Clasificación: Riesgo de integridad de datos**, pero — decisión ya tomada por el titular en B.25 — el
mecanismo COMPLETO de `ADR-0004` (tolerancia de redondeo, "gana el que cuadra") queda **fuera de alcance
de esta demo**. La guarda mínima no es construirlo: es bloquear toda segunda carga sobre el mismo
`(cliente_id, cuenta_bancaria_id)` con período solapado, sin excepción, mientras el mecanismo completo no
exista — sin fusión, sin comparación numérica.

**Riesgo aceptado a propósito, señalado por `code-reviewer` al cerrar la guarda mínima (2026-09-15,
`persistirCuenta`)**: el chequeo es un `select` seguido de una decisión de aplicación ("check-then-insert"),
sin `EXCLUDE USING gist`, lock advisory ni `SELECT ... FOR UPDATE` que lo haga atómico a nivel de base —
distinto de `uq_mov_crudo_fila`, que sí es un `unique` real. Bajo Postgres `READ COMMITTED` (el default,
sin isolation level explícito en ningún lado del repo), dos ingestas **concurrentes** sobre la misma
cuenta+período solapado podrían pasar el chequeo las dos antes de que cualquiera comitee. Correcto para el
camino secuencial de hoy (el CLI no corre en paralelo sobre el mismo cliente); no se cierra con un
constraint de exclusión en esta tarea porque el mecanismo completo de solape ya queda diferido a
`ADR-0004` (mismo criterio que la tolerancia de redondeo, arriba) — se documenta acá para que no se lea
después como un descuido.

### 2.4. Movimientos que desaparecen del extracto nuevo

**Técnico** (`dba-data`, `arquitecto-software`): nada compara la serie de movimientos entre lotes.
`lote_ingesta_cuenta.verificacion_estado` solo verifica la aritmética interna de un lote contra sus
propios totales — nunca cruza contra otro lote del mismo cliente/cuenta. Mismo riesgo ya aceptado en B.11
(reingesta/período solapado, D-27), sin guardia de rango solapado por bloqueo estructural de
`btree_gist` (ADR-0000 §6).

**Contable** (`contador-dominio`): esto **siempre** merece el ojo humano, nunca una decisión automática.
Una línea que desaparece puede ser una corrección legítima del banco (reemisión que saca una línea
errónea) o una carga nueva incompleta/mal tomada — el sistema no tiene evidencia para distinguir las dos
sin una referencia explícita del banco que hoy no existe. Si el movimiento ya generó un asiento
confirmado, remover su respaldo en silencio "porque no reaparece" es exactamente el tipo de pérdida
silenciosa de un hecho económico que ninguna automatización debería decidir sola.

**Clasificación: Riesgo de integridad de datos — necesita guarda mínima.** La guarda mínima NO es
resolver cuál de las dos causas es la correcta: es **alertar y no actuar solo**. Vale la nota de B.11: el
wizard de re-ingesta activa es precisamente el evento que esa entrada fijó como condición para subir la
prioridad del guard completo — el titular debe tenerlo presente al aprobar el flujo, no como bloqueante
nuevo.

### 2.5. Sobre líneas repetidas que generan un asiento nuevo — matiz de `contador-dominio`

El caso de "la misma línea generando dos asientos" (dos reconocimientos de una línea idéntica) **no
tiene correlato real en la práctica de un estudio** — es preocupación técnica sin equivalente contable,
siempre que la deduplicación compare identidad completa del movimiento (fecha+importe+signo+número de
operación), no solo texto. Lo que sí existe en la práctica es una **reversión bancaria posterior** (línea
distinta, con su propio importe/fecha/número), que no debe confundirse con "la misma línea repetida" — si
el mecanismo de deduplicación comparara solo texto/descripción, podría absorber una reversión legítima
como "ya vista" y perderla. No verificado hoy cuál criterio usa el matching real — pregunta abierta para
quien mantenga `agrupar-decisiones-pendientes-con-confirmaciones.ts`.

### 2.6. HU-4 — evidencia (re-ingesta del MISMO archivo, ya cubierta hoy)

Distinta del resto de §2: acá no hay hueco. Se documenta con el mismo nivel de cita que el resto del
dictamen porque §5(b) la usa como punto de partida del camino feliz y necesita su propia evidencia, no
solo la mención de pasada.

**El mecanismo, verificado hoy contra el código real** (no contra la versión que describía el plan
original): `uq_lote_ingesta_archivo unique (cliente_id, archivo_hash)` (`0004_ingesta.sql:317`) hace que
un mismo archivo (mismo `archivo_hash`, calculado sobre los bytes crudos) para el mismo cliente solo
pueda tener **una** fila en `lote_ingesta`. `apps/cli/src/ingestar.ts:307-320` la consulta al arrancar
PASO 3 y decide en función del `estado` de esa fila, no de su sola existencia:

- Si el lote existente está en `ESTADOS_LOTE_PERSISTIDO` (`procesado`, `procesado_con_observaciones` —
  el archivo ya se procesó de verdad), devuelve `{ estado: 'ya_procesado', loteId }` sin volver a
  parsear ni a insertar nada (`ingestar.ts:314-320`).
- Si el lote existente quedó `con_errores` (el archivo **no** llegó a procesarse), el mismo bloque lo deja
  pasar para reintentar — comentario propio del código (`ingestar.ts:288-297`) documenta el bug que esto
  corrige: la versión anterior devolvía `ya_procesado` ante cualquier fila con el mismo hash, sin mirar
  `estado`, y un archivo rechazado por una causa ya corregida (ejemplo real medido: vigencia de cuenta,
  cliente Bracci) quedaba imposible de reintentar.

**Consecuencia para Laura**: subir el mismo PDF/Excel dos veces seguidas (doble click, red que se corta y
reintenta) nunca duplica un lote ni corre el parseo de nuevo si ya tuvo éxito — responde limpio y rápido.
Distinto del hueco de §2.2 (archivo **distinto** con contenido que se solapa), que sí necesita guarda
nueva.

**Clasificación: Ya cubierto hoy — sin trabajo nuevo.**

### 2.7. Historias de usuario de re-ingesta (`analista-funcional`)

| HU | Enunciado | AC | Clasificación |
|---|---|---|---|
| HU-4 | Como Laura, quiero que subir el mismo archivo dos veces no duplique nada ni tenga que esperar de nuevo el parseo | `uq_lote_ingesta_archivo` + `ingestar.ts:307-320` devuelven `ya_procesado` limpio ante el mismo archivo cuando el intento previo persistió; un intento previo `con_errores` se reintenta en vez de bloquearse (ver §2.6) | Ya cubierto hoy |
| HU-5 | Como Laura, quiero que re-subir un extracto con filas que ya existen (mismo movimiento, archivo distinto) me diga qué pasó, en vez de perder la carga sin rastro | Un `23505` de `uq_mov_crudo_fila` termina en `lote_ingesta con_errores` + `motivo_codigo` + 1 fila en `acceso_auditoria` con `accion:'rechazo'` — nunca en `exit 2` sin traza (ver §2.2) | Riesgo de integridad — necesita guarda mínima |
| HU-6 | Como Laura, quiero que el sistema no me deje cargar dos veces el mismo período de la misma cuenta con archivos de formato distinto, sin que nadie lo note | Un segundo `lote_ingesta_cuenta` para el mismo `(cliente_id, cuenta_bancaria_id)` con `periodo_desde`/`periodo_hasta` solapado contra uno ya persistido se rechaza explícito, antes de insertar ninguna fila (ver §2.3) | Riesgo de integridad — necesita guarda mínima |

---

## 3. "Borrar la carga completa" — evaluado, no dado por bueno

### 3.1. Veredicto contable (`contador-dominio`)

**Refuta la idea como mecanismo general, la valida solo en una ventana acotada**: un borrado real es
aceptable **únicamente** mientras la carga no generó ninguna propuesta de asiento — estado puramente
técnico, previo a cualquier clasificación. En cuanto el motor produjo aunque sea una propuesta pendiente
de revisión, un borrado sin rastro deja al sistema en un estado que un contador no puede auditar después
con confianza. Desde que existe un asiento **confirmado**, borrar la carga que lo originó nunca es
aceptable, bajo ningún punto — es lo mismo que borrar el comprobante de respaldo de un asiento ya
registrado. El mecanismo correcto, en los tres casos donde ya hay algo que proteger, no es `DELETE`: es
**supersesión de lote** (marcar la carga vieja como reemplazada, con quién y cuándo, en la traza) — mismo
estándar que el proyecto ya se autoimpuso para `pendiente_cierre`/`cierre_transicion` (autoría
obligatoria, sin bypass de rol, migraciones `0045`/`0046`).

### 3.2. Verificación técnica del punto de no retorno (`arquitecto-software`, `dba-data`)

**Grants de DELETE hoy, tabla por tabla** (verificado, no supuesto):
- `movimiento_bancario_crudo`, `lote_ingesta_cuenta`: **sí** tienen `for all` (incluye DELETE) para
  `socio/contador/administrativo` (`0004_ingesta.sql:336,418,494`).
- `lote_ingesta` (la fila ancla): **no** tiene `delete` en su grant — solo `select, insert, update`
  (`0004_ingesta.sql:344`).
- `documento_ingerido`, `pendiente_cierre`, `asiento_propuesto`, `confirmacion_grupo`: **ninguna** tiene
  `delete` (`0027:282-283,668-670,784`, `0043:97-98`).

**El límite estructural real, verificable por FK, no por convención**: **todas** las FK del esquema son
`on delete restrict` — verificado sin una sola excepción en 39 ocurrencias por `grep`. Desde que Capa C
escribe la primera fila de `reconocimiento_movimiento` para un movimiento, un `DELETE` real sobre
`movimiento_bancario_crudo` falla en la base (`23503`), sin depender de que la aplicación lo recuerde.

**Precedente de costo real** (`dba-data`, el borrado ya ejecutado del lote de prueba `ae762fda`, HANDOFF
199): se planificaron 8 tablas y aparecieron 3 más recién al ejecutar (descubiertas por choque de
`23503` en dos intentos fallidos) — se necesitó backup con checksum previo, verificación recursiva contra
el catálogo de TODAS las FK, y una transacción con conteo esperado por tabla + `COMMIT` condicional. Y
ese fue el caso **más simple posible** (0 filas en `asiento_propuesto`). El caso "borrar para repetir una
prueba de la demo" es estructuralmente más caro si la demo avanzó hasta ahí — que es justamente el
objetivo del wizard.

**Precisión adicional** (`analista-funcional`, HU-7): el vocabulario cerrado de `acceso_auditoria.accion`
**ya incluye `'borrado'`** (`0004_ingesta.sql:67`) — el dominio anticipó la necesidad de auditar un
borrado, pero **cero código emite ese valor hoy** (grep sin resultados). El hueco no es de esquema: es
que la función que lo usaría nunca se escribió.

### 3.3. Síntesis y recomendación de límite (no de implementación)

Los cuatro dictámenes convergen: **no otorgar ningún grant de `DELETE` nuevo sobre `lote_ingesta`,
`asiento_propuesto`, `cierre_cliente_periodo` ni tablas equivalentes sin pasar por el mismo panel que
cerró `0028`** (`dba-data` + `security-engineer` + `seguridad-datos-financieros`, matriz CLAUDE.md
§3.1) — hacerlo "solo para destrabar la demo" reabriría exactamente el vector que esa migración cerró
(grant de tabla completa sin restricción de valor). El mecanismo consistente con el resto del sistema es
un estado nuevo tipo `anulado` en `lote_ingesta` (análogo a `cierre_cliente_periodo`), no un `DELETE`.

**Clasificación: Riesgo de integridad de datos — necesita guarda mínima incluso en el camino feliz**, no
porque el mecanismo actual sea débil (el FK `restrict` es sólido), sino porque la idea del titular, si se
implementa apurada para destrabar una demo, tiene un camino obvio hacia el error real.

**Historias de usuario** (`analista-funcional`):

| HU | Enunciado | AC | Clasificación |
|---|---|---|---|
| HU-7 | Como Laura, quiero poder deshacer una carga hecha por error antes de haber tipificado nada | Hoy NO existe ninguna opción construida (ni DELETE seguro encapsulado, ni supersesión) — el hueco es de función, no de esquema | Riesgo de integridad — necesita guarda mínima |
| HU-8 | Como Laura, quiero que "borrar" deje de estar disponible en cuanto empecé a tipificar/confirmar algo sobre esa carga | Un intento de borrado sobre un lote con ≥1 fila en `reconocimiento_movimiento`/`asiento_propuesto` falla explícito (mismo patrón `conflicto/motivoCodigo` que ya usa `confirmarAsiento`), nunca con un `23503` crudo mostrado tal cual | Riesgo de integridad — necesita guarda mínima |

---

## 4. Viabilidad del modelo de wizard lineal

**Convergencia unánime de los cuatro**: el wizard de 6-7 pasos **sigue siendo válido como metáfora de
interacción** — la secuencia de pantallas que Laura recorre para una cuenta de un cliente. **No es
viable como modelo de implementación subyacente**, y no hace falta que lo sea: la máquina de estados real
ya existe, repartida en las tablas de dominio (`cierre_cliente_periodo`, `pendiente_cierre`,
`asiento_propuesto`, `confirmacion_grupo`, cada una con su propio ciclo de vida verificado). Lo que falta
no es infraestructura nueva — es una función de lectura/proyección que, en cada carga de pantalla, infiera
"en qué paso está Laura" a partir de ese estado ya persistido (¿hay `cierre_cliente_periodo` abierto para
esta cuenta-período? ¿cuántos `pendiente_cierre` siguen `abierto`? ¿cuántos `asiento_propuesto` siguen
`propuesto`?), nunca al revés.

**Corolario de límite** (`arquitecto-software`): el stepper nunca puede permitir un "atrás" que dispare un
intento real de reversión de un paso ya confirmado — eso ya está bloqueado por `0028` a nivel de base,
verificable, así que cualquier implementación que respete ese límite no puede corromper el sistema aunque
el front tenga un bug: el peor caso es un error visible, no una corrupción silenciosa.

---

## 5. Entregable final

### (a) Historias de usuario — ver tablas de §1, §2.7 y §3.3 arriba (9 HU numeradas, cada una con su
clasificación).

### (b) Camino feliz acotado para la demo, con guardas mínimas separadas de lo diferible

**Estrictamente necesario** (si falta, la demo puede dañar datos reales de Bracci/ROKA):

1. **HU-4** (§2.6) — ya cubierto hoy, sin trabajo nuevo (`uq_lote_ingesta_archivo` +
   `ingestar.ts:307-320` devuelven `ya_procesado` limpio ante el mismo archivo).
2. **HU-5 mínima** (§2.2) — capturar `ING_DUPLICADO` explícito en el loop de inserción y enrutarlo por
   `rechazar()`, igual que los demás ~8 rechazos ya existentes. Es un `catch` de aplicación, no una
   migración.
3. **HU-6 mínima** (§2.3) — bloqueo simple: una sola carga por `(cliente_id, cuenta_bancaria_id)` con
   período no solapado, sin fusión ni comparación numérica. Es exactamente "impedir la re-carga sin
   intervención manual" que pidió el titular al plantear la pregunta.
4. **Si el botón "borrar" entra al alcance de la demo**: HU-7 + HU-8 completas (verificación de cero
   referencias en tablas de Capa C/D + auditoría real con `accion='borrado'`, que el esquema ya prevé
   pero nadie construyó). **Si no da el tiempo, la alternativa más barata es no exponer el botón** y
   dejar solo la corrección por supersesión (`revocaId`) que ya existe y ya está probada.
5. **HU-9** (§1) — reconciliar contra el servidor en cada entrada de pantalla; barato, usa lecturas que
   ya existen, ninguna tabla nueva.

**Diferido a propósito, sin riesgo de dañar datos reales:**
- Copy exacto de cada mensaje de rechazo (UX, no integridad).
- `ADR-0004` completo (tolerancia de redondeo, "gana el que cuadra") — ya diferido por decisión previa
  del titular en B.25; esta consulta no lo reabre.
- El botón "borrar la carga completa", si no se llega a construir con sus dos guardas (HU-7/HU-8).
- Nombres/orden final de los pasos 2-8 del wizard (pendiente de que el titular reconstruya el listado
  original, doc 34 §0) — bloquea el boceto visual, no la integridad de datos.
- Comparación numérica entre fuentes / detección de "movimiento desaparecido" completa (§2.4) — la
  guarda mínima (alertar y no actuar solo) alcanza para la demo; el mecanismo fino queda para cuando
  aparezca un segundo caso real, mismo criterio que B.11/B.25 ya fijaron.

### (c) Construcción mínima (no el diseño completo del producto)

1. `catch` explícito de `ING_DUPLICADO` en `persistir.ts`/`ingestar.ts`, enrutado a `rechazar()` con un
   `motivoCodigo` propio (ej. `fila_ya_existe_en_otro_lote`).
2. Chequeo de solape de rango ANTES de insertar: una consulta contra `lote_ingesta_cuenta` comparando
   `periodo_desde`/`periodo_hasta` — no una migración, evita el `EXCLUDE USING gist` bloqueado por
   ADR-0000 §6.
3. Si "borrar" entra al alcance: función que (i) verifique cero filas en `reconocimiento_movimiento`/
   `asiento_propuesto`/`movimiento_origen_crudo` para el lote, (ii) borre en el orden de FK correcto
   (documentado y probado una sola vez, no a pulmón cada vez), (iii) pase por `escribirConAuditoria` con
   `accion='borrado'`.
4. Regla de implementación para la futura UI, sin tabla nueva: cada pantalla posterior a una escritura
   hace su propio fetch de estado real al entrar.
5. Fixture sintético que mida HU-5 (1 fila duplicada + N nuevas) contra el comportamiento de HOY, antes
   de tocar código — la línea de base que exige CLAUDE.md §3.2 punto 2, antes de cualquier
   implementación futura de este documento.

---

## 6. Lo que este documento NO decide

- El mecanismo exacto de "retomar" (qué consulta arma el estado del wizard) — pregunta abierta para
  `analista-funcional`/`backend-dev` cuando se implemente, no una decisión de este dictamen.
- Si el botón "borrar" entra o no al alcance de la demo — decisión del titular, con el costo real ya
  medido arriba (§3.2, precedente `ae762fda`) para que la decisión sea informada.
- El criterio exacto de matching para deduplicar líneas repetidas (§2.5) — pregunta abierta para quien
  mantenga el motor de agrupación.
- Los nombres/orden finales de los pasos 2-8 del wizard — sigue pendiente de doc 34 §0.

## Convocatoria

`arquitecto-software`, `dba-data`, `contador-dominio`, `analista-funcional` — reales, en paralelo,
2026-09-14/15. Ninguno implementó código; este documento es análisis y dictamen, tal como se pidió.
