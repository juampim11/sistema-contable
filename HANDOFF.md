# HANDOFF — bitácora del proyecto

> Bitácora compartida entre **Claude Code** y **Codex**. Se escribe una entrada **apenas se cierra el
> DoD** de una tarea o decisión, no al final de la sesión. **Lo que no está acá o en los docs no existe
> para la otra herramienta.** Entrada más reciente arriba.

---

## 2026-08-11 (42) — Plan: `completar-lote.ts`, remediación del lote con_errores (CLAUDE.md §3.2)

**Herramienta:** Claude Code. Dispara modo plan por (a)/(b)/(c) — agrega una columna a `lote_ingesta`,
escribe datos financieros reales de un cliente, y completa un lote que ya corrió contra el piloto.
Convocatoria en dos rondas: `analista-funcional` + `contador-dominio` (criterio de aceptación, ya
aprobado por el usuario) y `dba-data` + `security-engineer` + `seguridad-datos-financieros` (diseño
técnico), las dos completas antes de este commit.

**Criterio de aceptación** (`analista-funcional` + `contador-dominio`, aprobado sin objeciones):
1. Estado final: `procesado_con_observaciones`, sin estado nuevo en el vocabulario cerrado — matemáticamente
   idéntico al caso ya medido de Macro (`estadoSegunVerificacion` es pura, no le importa el camino).
2. `filas_leidas`/`filas_aceptadas` finales = 158, **calculados** (`sum()` sobre `lote_ingesta_cuenta`),
   no hardcodeados — hoy están en 0 porque `rechazar()` nunca las tocó.
3. `filas_rechazadas` se mantiene en 0 — no se usa en ningún camino del módulo, no se inaugura acá.
4. "Lote completo" verificable: 2 filas en `lote_ingesta_cuenta` (hoy 1), `motivo_codigo IS NULL`,
   `estado='procesado_con_observaciones'`.
5. Trazabilidad en dos lugares complementarios: `acceso_auditoria` (rastro append-only) + una nota
   legible en el propio lote (para no depender de saber buscar en el rastro técnico).
6. La función relee el archivo original (mismo `archivo_hash`) para sacar el saldo declarado de la
   cuenta faltante — nunca tipeado a mano.

**Diseño técnico, con la tensión entre `dba-data` y `seguridad-datos-financieros` resuelta explícitamente:**

`seguridad-datos-financieros` confirmó que `resolverCuentaDelExtracto` es de solo lectura y que, **para
una sola cuenta faltante**, un `throw` simple alcanza — recomendó acotar el alcance de la v1 a "una
cuenta faltante por corrida" como límite de diseño declarado. `dba-data` marcó como bloqueante que, si
la función alguna vez procesa **más de una** cuenta pendiente en la misma corrida, hace falta el mismo
`SAVEPOINT` de (40)/(41) — y que, si hace falta, **no se puede reimplementar suelto en un segundo
archivo** (la lección exacta de (40): la garantía depende de un solo lugar).

**Resolución: se adopta la restricción de `seguridad-datos-financieros` de forma literal, no como
atajo.** `completar-lote.ts` resuelve TODAS las cuentas del documento (lectura pura, sin riesgo) y
cuenta cuántas todavía no tienen fila en `lote_ingesta_cuenta` para este lote. Si son 0: no-op limpio
(`ya_completado`). Si es exactamente 1: se verifica y persiste esa sola cuenta — sin `SAVEPOINT`, porque
nada se escribió antes en esta transacción y un `throw` simple alcanza (mismo argumento de
`seguridad-datos-financieros`). **Si son ≥2: aborta explícito** ("esta función completa una cuenta por
corrida, hay N pendientes — corré esto N veces"), nunca intenta una segunda en la misma invocación. Con
este límite, el escenario que preocupa a `dba-data` (dos cuentas en la misma corrida, la primera
persiste, la segunda falla) **no puede ocurrir** — no hace falta el mecanismo compartido que hubiera
sido bloqueante replicar. Los dos quedan satisfechos: la simplicidad que pedía
`seguridad-datos-financieros`, y la garantía de "nunca una segunda cuenta comiteada bajo una corrida que
no completó" que pedía `dba-data`, por construcción en vez de por vigilancia.

**Migración nueva, confirmada necesaria por `dba-data`** (no hay ninguna columna existente que sirva):
`lote_ingesta` es **N1 estricto a propósito** (comentario de la migración 0004: "ni una sola columna ≥
N2"), y `lote_ingesta_cuenta.verificacion_detalle` es por CUENTA, no por lote — meter ahí una nota sobre
el lote entero mezclaría dos conceptos de alcance distinto. `0012_remediacion_lote.sql`:
`alter table lote_ingesta add column motivo_codigo_previo text` (nullable, sin `check` — mismo criterio
que `motivo_codigo`, que tampoco lo tiene porque su dominio es grande y evolutivo, no un enum chico).
`NULL` es el flag "nunca se remedió". Entrada nueva en `clasificacion-campos.ts`, mismo nivel que
`motivo_codigo` (N1, exportable, nota explicando que es un código cerrado).

**El puente que pidió `seguridad-datos-financieros`** (la nota tiene que poder pivotear al registro
completo de `acceso_auditoria`, "no solo qué pasó, también quién") **no necesita una columna nueva**:
`registrarAcceso(tx, {recurso:'lote_ingesta', recursoId: loteId, ...})` ya ata cada fila de
`acceso_auditoria` al lote por `recurso_id = lote_ingesta.id` — es una clave exacta, no "adivinar por
rango de fecha". El comentario de la columna nueva deja escrito el camino de consulta
(`acceso_auditoria where recurso='lote_ingesta' and recurso_id = <id>`) para que nadie tenga que
redescubrirlo.

**Hallazgo nuevo de `dba-data`, no estaba en el criterio original:** `rechazar()` solo toca
`estado`/`motivo_codigo` — el lote rechazado también quedó con `adaptador_version='santander@pendiente'`
(el placeholder que arma el paso 4 antes de leer el archivo), `archivo_clave`/`paginas_declaradas`/
`paginas_sin_texto` en `NULL`. La función de remediación tiene que completar TODO eso, no solo estado y
contadores — si no, el lote queda `procesado_con_observaciones` con una versión de adaptador que dice
`@pendiente`, inconsistente para cualquier reinterpretación futura (el comentario de la migración dice
que la versión existe justamente para eso).

**Guardrails de `security-engineer`, incorporados:**
- Guard R18 al principio, mismo orden que `ingestar.ts` (antes de abrir el archivo).
- "No encontré el lote por `(cliente_id, archivo_hash)`" es un aborto explícito, **nunca** un fallback
  (ni crear un lote nuevo, ni "el más reciente en `con_errores`" de ese cliente).
- Validar que el `--banco` releído coincide con el `banco_codigo` ya persistido en el lote, y que el
  lote esté **exactamente** `con_errores` antes de tocar nada.
- El motivo de auditoría se arma solo con códigos cerrados + uuids — nunca texto libre del operador ni
  dato leído del PDF.

**Guardrails de `seguridad-datos-financieros`, incorporados:**
- Fallo de verificación (`no_cuadra`) después de una resolución exitosa se trata IGUAL que fallo de
  resolución: aborto limpio, sin distinguir escritura parcial.
- Cualquier impresión del saldo releído pasa por `forma()`; nunca por el `logger` (ni siquiera con
  `forma()` — R26/R27 de ADR-0002 prohíben cualquier valor N2/N2-R en el logger, sea cual sea su forma).
- Segunda corrida sobre una cuenta ya completada: `select` explícito antes de intentar el `insert`,
  resultado `ya_completado` con código cerrado — nunca dejar salir un `23505` crudo (fuga potencial de
  fragmento de fila vía el mensaje de Postgres, no solo mala UX).

**Auditoría — confirmado por `dba-data`:** `escribirConAuditoria` no aplica (es el gate de N2-R; estas
tablas no lo son — `persistirCuenta` ya las escribe hoy sin ese envoltorio). `registrarAcceso` directo,
`accion='escritura'`, motivo con el patrón de sufijos ya usado en `alta-cuenta.ts`.

1. **Qué cambia y qué no.** Cambia: migración nueva (una columna N1), `clasificacion-campos.ts`, un
   script nuevo `apps/cli/src/completar-lote.ts`. **No cambia:** `ingestar.ts` (no hace falta tocarlo,
   ni extraer nada compartido, dado que no hace falta `SAVEPOINT`); ninguna fila ya persistida de ARS;
   el vocabulario cerrado de `estado`/`accion`.
2. **Qué se mide.** Tests con fixtures sintéticos (nunca contra el piloto real — lo corre el usuario):
   0 cuentas faltantes → `ya_completado`; 1 faltante que resuelve → estado/contadores/`adaptador_version`
   correctos, auditoría escrita; 1 faltante que NO resuelve → aborta sin tocar nada; ≥2 faltantes →
   aborta explícito sin intentar ninguna; segunda corrida sobre un lote ya completado → `ya_completado`,
   sin `23505` crudo. `pnpm verificar` en verde.
3. **Predicción falsable.** El usuario corre `completar-lote.ts` contra el lote real de Santander (con
   la cuenta USD ya registrada) y tiene que ver: `estado='procesado_con_observaciones'`, 2 filas en
   `lote_ingesta_cuenta`, `filas_leidas=filas_aceptadas=158`, `motivo_codigo IS NULL`,
   `motivo_codigo_previo='cuenta_no_pertenece_al_cliente'`, `adaptador_version` correcta (no
   `@pendiente`), y una fila nueva en `acceso_auditoria` con `accion='escritura'` y `recurso_id` igual al
   lote. Si algo de esto no coincide, es un hallazgo — no se reintenta sin confirmarlo conmigo primero.
4. **Agentes.** Ya convocados en dos rondas: `analista-funcional`, `contador-dominio` (criterio,
   aprobado), `dba-data`, `security-engineer`, `seguridad-datos-financieros` (diseño técnico) — los
   cinco con hallazgos incorporados arriba. `code-reviewer` sobre el diff final antes de cerrar.
5. **Paso revertible más chico.** Un commit único: la migración y el script resuelven el mismo problema
   y separarlos dejaría la migración sin nada que la use. Revertible con `git revert` de la migración +
   el script juntos (la columna nueva es nullable, sin dato existente que dependa de ella).

---

---

## 2026-08-11 (41) — Cierre: atomicidad real de `ingestar.ts`, causa raíz corregida

**Herramienta:** Claude Code. Cierra la tarea planificada en (40).

**Qué se hizo, sobre el diseño final incorporando los cuatro hallazgos de la convocatoria:**
- `apps/cli/src/ingestar.ts`: `SAVEPOINT despues_del_lote` justo después de crear `loteId`. `rechazar()`
  gana `ROLLBACK TO SAVEPOINT despues_del_lote` como primera línea (antes del `update`/
  `registrarAcceso` del propio rechazo — el orden es crítico, invertirlo se lleva puesto el rastro del
  rechazo también). Los ~8 sitios que llaman a `rechazar(tx, ...)` no cambiaron una sola línea propia:
  la garantía vive en un solo lugar. Los `throw` técnicos (errores de Postgres traducidos, el de
  `persistirAnexos`, el del storage) quedan intactos — siguen revirtiendo toda la transacción.
- `packages/ingesta/src/persistir.ts`: docstring de `persistirCuenta` corregido — la garantía de "un
  fallo revierte todo el lote" es del **llamador** (vía `rechazar()`), no de esta función por sí sola.
- Cinco comentarios de `ingestar.ts` corregidos para reflejar el mecanismo real, no solo la intención.
- `apps/cli/tests/ingestar.test.ts`: un test nuevo con una `cuenta_bancaria` real registrada (necesaria
  para que la primera cuenta resuelva y persista de verdad, la precondición del bug) — confirma que una
  cuenta exitosa NO sobrevive cuando una cuenta posterior del mismo archivo falla: cero filas en
  `movimiento_bancario_crudo`, el lote en `con_errores` con su motivo, y el rechazo auditado.

**Verificación por mutación, dos veces independientes:** quien conduce comentó el `ROLLBACK TO
SAVEPOINT` y confirmó que el test detecta 4 filas huérfanas (en vez de 0) — reproduce el bug real a
escala. `code-reviewer`, además, invirtió el orden dentro de `rechazar()` (escritura antes que rollback)
y confirmó que produce exactamente el escenario "peor que el bug original" que predijo
`security-engineer`: el lote vuelve a `recibido` sin `motivo_codigo` ni rastro. Los dos restauraron el
archivo después; sin residuo.

**Convocatoria (`tech-lead`, `dba-data`, `security-engineer`, `seguridad-datos-financieros`, HANDOFF
(40)) y `code-reviewer` sobre el diff final: sin bloqueantes.**

**Confirmado por lectura de código, sin tocar datos: Macro tiene el mismo bug** (`leerMacro` arma un
elemento de `cuentas` por cada sección, el loop de `ingestar.ts` es agnóstico del banco). El fix, al
vivir enteramente en `ingestar.ts`, corrige la exposición de Macro también — no hizo falta ni se tocó
`macro.ts`.

**No cierra `docs/diseno/10-deuda-declarada.md` §1.1** (el problema inverso: un `throw` real pierde el
lote-ancla). Queda declarado, no resuelto — una posible segunda tarea simétrica, a decidir después.

**Remediación de las 158 filas ya comiteadas (del intento real de Santander): recomendación
documentada en (40), NO implementada.** Borrar está estructuralmente bloqueado (sin grant de `delete` en
`movimiento_origen_crudo`, y `force row level security` sin policy de `delete` — deniega incluso al
dueño del esquema). La recomendación es "completar" el lote existente con una función nueva (fuera de
este fix, necesita su propio plan y criterio de aceptación de `analista-funcional`/`contador-dominio`
antes de escribirse, por la ausencia de máquina de estados que señaló `dba-data`).

**Medido:** `pnpm typecheck` limpio, `pnpm test` 794/794 (27 archivos), `pnpm barrido` limpio.

**Predicción falsable, para cuando el usuario reintente:** al reintentar la ingesta de Santander (con
la cuenta USD todavía sin registrar, a propósito), el lote debe rechazarse con el mismo `motivo_codigo`
de siempre, pero esta vez con **CERO filas nuevas** en `movimiento_bancario_crudo` para ese lote. Las
158 filas del intento anterior siguen ahí — no las toca este fix, es la remediación pendiente descripta
arriba.

**Rama:** `fix/ingestar-atomicidad-savepoint`, un commit único (más este de cierre), lista para
mergear a `main` con `--no-ff`.

---

---

## 2026-08-11 (40) — Plan: atomicidad real de `ingestar.ts` (CLAUDE.md §3.2)

**Herramienta:** Claude Code. Dispara modo plan por (a)/(c) — toca la transacción que escribe datos
financieros reales de un cliente y modifica un script que ya corre contra el piloto. Convocatoria
completa (`tech-lead`, `dba-data`, `security-engineer`, `seguridad-datos-financieros`) ya corrida en
paralelo, cada uno verificando el diagnóstico contra el código real, no solo mi resumen.

**El bug, confirmado contra la base real del piloto (no hipotético).** `ingestar()`
(`apps/cli/src/ingestar.ts:210-590`) procesa todas las cuentas de un archivo en un loop, dentro de UNA
transacción (`conUsuario`, que comitea en cualquier `return` normal del callback y solo revierte si
lanza — `packages/data/src/db/conexion.ts:246-255`). Los ~8 caminos de rechazo (`archivo_ilegible`,
`requiere_ocr`, los tres motivos de banco, `sin_movimientos`, `consolidado_no_cuadra`/similares, y
dentro del loop: `cuenta_sin_periodo`, resolución fallida, persistencia fallida) llaman a `rechazar(tx,
...)` y hacen `return` — nunca `throw`. Si una cuenta anterior en el loop ya se persistió con éxito
cuando una posterior falla, todo se comitea junto: la cuenta buena queda con sus filas reales, colgada
de un lote marcado `con_errores`. Confirmado con una consulta de solo-conteo contra el piloto: **158
filas reales en `movimiento_bancario_crudo`**, `verificacion=cuadra`, con su `lote_ingesta` en
`estado=con_errores`, `motivo_codigo=cuenta_no_pertenece_al_cliente` — el archivo real de Santander
tiene 2 cuentas (ARS ya dada de alta, USD deliberadamente sin registrar todavía), y el loop persistió
ARS antes de fallar en USD.

**Por qué `cuenta_no_pertenece_al_cliente` y no un bug de lógica separada** (se descartó la hipótesis
del usuario con evidencia): `resolverCuentaDelExtracto` (`packages/ingesta/src/resolver-cuenta.ts`) es
la única función de resolución, sin duplicación. Distingue sus dos motivos de fracaso preguntando
"¿este cliente tiene ALGUNA cuenta registrada?" (no "¿tiene ESTA?") — como la ARS ya está de alta, la
falta de la USD se reporta como "no pertenece", no como "no registrada". Correcto según el diseño de la
función, engañoso en este escenario específico (1 de 2 cuentas reales registrada, no un archivo ajeno).
Queda declarado como hallazgo, no se toca en este fix — el usuario priorizó la causa raíz.

**Diseño final, incorporando los cuatro hallazgos de la convocatoria:**
1. `SAVEPOINT despues_del_lote` justo después de crear `loteId` (después del `set_config` de tenant
   que hace `conUsuario` antes de invocar el callback — confirmado por `security-engineer`, `dba-data` y
   `tech-lead` de forma independiente que un `ROLLBACK TO SAVEPOINT` posterior no puede tocar ese
   contexto).
2. 🔴 **`ROLLBACK TO SAVEPOINT despues_del_lote` va DENTRO de `rechazar()`, como primera línea — no
   repetido en los 8 call sites** (`dba-data`: "la garantía depende de un solo lugar, no de que nueve
   personas se acuerden de hacer las dos cosas en el orden correcto"). Los 8 sitios existentes no
   cambian una sola línea de su propia lógica.
3. Los caminos que **lanzan** (un `23505` traducido, el `throw` explícito de `persistirAnexos` por un
   literal con identificador) quedan intactos — siguen revirtiendo TODA la transacción, incluido el
   lote. Es correcto para un error técnico inesperado y está fuera del alcance de este fix.
4. Corrige, de yapa, un segundo caso no pedido explícitamente: persistencia PARCIAL de la cuenta
   ACTUAL (`persistir.ts:276`, `concepto_banco_no_es_prefijo`, un `return false` después de haber
   insertado ya algunas filas de esa misma cuenta) — mismo mecanismo, mismo `ROLLBACK TO SAVEPOINT` lo
   cubre (`tech-lead`).

**SAVEPOINT en vez de partir en 2-3 transacciones separadas** (`dba-data` + `tech-lead`, coincidieron
de forma independiente): la alternativa abre una ventana de crash entre transacciones donde el lote
queda `estado=recibido`, durable, sin nadie que lo vaya a rechazar nunca — un lote fantasma que
necesitaría un job de limpieza nuevo que hoy no existe. Con SAVEPOINT, si el proceso muere en cualquier
punto, la transacción completa nunca se comitea: no hay estado intermedio observable.

**No cierra `docs/diseno/10-deuda-declarada.md` §1.1** (`tech-lead`, hallazgo que cambia el marco de la
tarea): esa entrada describe el problema **inverso** — un `throw` real (no un `return`) hace perder
hasta el propio lote-ancla, sin `motivo_codigo` ni rastro de auditoría, peor en otro sentido que el bug
de acá. §1.1 ya proponía SAVEPOINT como remedio, para el caso contrario. Queda **declarado, no
cerrado** — probablemente una segunda tarea simétrica (envolver también el `catch` de errores técnicos
con `ROLLBACK TO SAVEPOINT` + `rechazar` en vez de perder todo), a decidir después.

**Comentarios a corregir** (`ingestar.ts:435`, `:448`, `:509-510`; `persistir.ts:154`) — confirmado por
`tech-lead`: tres de ellos vuelven a ser ciertos solos en cuanto el fix esté (no hace falta reescribirlos
con una idea distinta); el de `persistir.ts:154` necesita una frase aclarando que la garantía es del
**llamador** (vía el nuevo `rechazar()`), no de `persistirCuenta` en sí misma. `ingestar.ts:561` (el
`throw` del storage) queda igual — ya es correcto hoy.

**Macro tiene el mismo bug, confirmado por lectura de código** (`tech-lead`, sin tocar `macro.ts` ni
datos reales de Macro): `CAPACIDADES_MACRO.multiCuenta: true`, `leerMacro` arma un elemento de `cuentas`
por cada sección detectada, y el loop de `ingestar.ts` es agnóstico del banco. El fix, al vivir
enteramente en `ingestar.ts`, corrige la exposición de Macro **sin tocar `macro.ts`** — no hace falta
una tarea separada para Macro.

**Remediación de las 158 filas — recomendación documentada, NO implementada en este fix** (el usuario
lo pidió explícitamente separado de la causa raíz):
- Confirmado en dos capas independientes por `seguridad-datos-financieros` y `dba-data`: borrar está
  estructuralmente bloqueado. `movimiento_origen_crudo` no tiene grant de `delete` para nadie, y aunque
  lo tuviera, tiene `force row level security` sin ninguna policy de `delete` — deniega por defecto
  incluso al dueño del esquema, salvo `BYPASSRLS` real (lo que el usuario pidió explícitamente no
  proponer).
- Recomendación: **"completar" el lote existente**, nunca borrar y rehacer — de hecho "rehacer" ni
  siquiera tiene sentido acá: USD nunca se persistió (falló en resolución, antes de `persistirCuenta`),
  así que lo único que hay en la base son las 158 filas de ARS, que son las **correctas**. Una función
  nueva (fuera de este fix) que: inserte `lote_ingesta_cuenta` + movimientos de USD contra el MISMO
  `loteId` (el `unique(cliente_id, lote_ingesta_id, cuenta_bancaria_id)` ya protege contra duplicar
  ARS por error), recalcule y escriba los contadores agregados del lote completo (`filas_leidas`,
  `filas_aceptadas`, `filas_rechazadas`, `estado`) — **hallazgo adicional**: hoy `lote_ingesta.filas_
  aceptadas=0` pese a las 158 filas reales, porque `rechazar()` nunca los toca — y deje rastro en
  `acceso_auditoria` (`accion='escritura'`, `motivo` encadenando el `motivo_codigo` del rechazo
  original, mismo patrón que ya usa `alta-cuenta.ts` para sus sufijos). Runner: **`conUsuario`, nunca
  `conJob`** — es una corrección financiera con intención humana, y `'ingesta_bancaria'` está
  deliberadamente fuera de los motivos de `conJob`.
- No hace falta ningún cambio de esquema para esto (`dba-data`: el `unique` ya protege, no hay máquina
  de estados que lo bloquee — aunque esa AUSENCIA de máquina de estados es en sí un hueco a tener en
  cuenta cuando se escriba esa función). No hace falta un valor nuevo de `acceso_auditoria.accion`
  (`'escritura'` alcanza).
- Los datos de las 158 filas **no están expuestos de forma incorrecta hoy**: la policy de lectura de
  `movimiento_bancario_crudo` no depende del `estado` del lote — es un problema de completitud de
  cualquier vista que filtre por `estado='procesado'`, no de aislamiento ni de secreto fiscal
  (`seguridad-datos-financieros`, severidad baja-media, correctamente detrás de la causa raíz).

1. **Qué cambia y qué no.** Cambia: `rechazar()` gana el `ROLLBACK TO SAVEPOINT` como primera línea;
   `ingestar()` agrega el `SAVEPOINT` después de crear el lote; los 5 comentarios de atomicidad. **No
   cambia:** ningún camino que hoy lanza (queda para §1.1, declarado); `macro.ts` (el fix lo cubre sin
   tocarlo); las 158 filas ya comiteadas (remediación es una tarea futura separada, con su propio plan
   — necesita criterio de aceptación de `analista-funcional`/`contador-dominio` antes de escribirse,
   por la ausencia de máquina de estados que señaló `dba-data`).
2. **Qué se mide.** Test nuevo en `apps/cli/tests/ingestar.test.ts`: dos cuentas falsas, la primera
   resuelve/verifica/persiste con éxito, la segunda falla resolución — afirma (a) CERO filas en
   `movimiento_bancario_crudo` para ese lote (no solo para la cuenta 2, que nunca se persistió — para
   TODO el lote, incluida la 1), (b) `lote_ingesta.estado='con_errores'` con el `motivo_codigo`
   correcto, y (c) el `rechazo` queda auditado (`security-engineer`: verificar por evidencia, no solo
   que el gate esté verde — es el mismo test que exige que el rechazo sobreviva al rollback parcial).
   Un segundo test para el caso de `tech-lead` (persistencia parcial de la cuenta actual). `pnpm
   verificar` en verde.
3. **Predicción falsable.** El usuario reintenta la ingesta de Santander (con la cuenta USD **todavía
   sin registrar**, a propósito, para probar el camino de rechazo limpio) y tiene que ver: el lote
   rechazado con el mismo `motivo_codigo` de siempre, pero esta vez **CERO filas nuevas** en
   `movimiento_bancario_crudo` para ese lote — nunca más una cuenta buena comiteada bajo un rechazo. Si
   aparece cualquier fila nueva en un lote rechazado, es un hallazgo — no se reintenta sin confirmarlo
   conmigo primero. (Las 158 filas viejas del intento anterior siguen ahí — esa es la remediación
   pendiente, no algo que este fix toque.)
4. **Agentes.** Ya convocados en paralelo: `tech-lead`, `dba-data`, `security-engineer`,
   `seguridad-datos-financieros` — los cuatro con hallazgos incorporados arriba.
5. **Paso revertible más chico.** Un commit único: el `SAVEPOINT` y el `ROLLBACK TO SAVEPOINT` dentro
   de `rechazar()` son la misma pieza, no tiene sentido separarlos. Revertible con `git revert`, sin
   efecto en las 158 filas ya existentes (no las toca).

---

---

## 2026-08-11 (39) — Cierre: `leerCaratula` para Macro, implementado, verificado, en verde

**Herramienta:** Claude Code. Cierra la tarea planificada en (38).

**Qué se hizo, sobre el diseño final incorporando los cinco hallazgos de la convocatoria:**
- `apps/cli/src/alta-cuenta.ts`: tercera rama en `leerCaratula`, detectada por `seccionesPorClave`
  (importada de `@sistema-contable/ingesta`, no duplicada — infraestructura compartida de
  `toolkit.ts`). Duplica solo `RE_SECCION_MACRO`/`RE_CBU_MACRO`/`tipoDeCuentaDelTituloMacro`/
  `monedaDelTituloMacro` (vocabulario privado de `macro.ts`, verificado carácter por carácter contra
  el original). Filtra por `(moneda, tipo)`: `--tipo` nuevo, opcional, enum cerrado de 3 valores
  (`cuenta_corriente`/`cuenta_corriente_especial`/`caja_ahorro`, derivado de `TipoCuentaAlta` con
  `as const satisfies`), aplicado **siempre** que esté presente — nunca ignorado en silencio aunque
  `--moneda` sola ya alcanzara. 0/`>1` candidatas por `(moneda, tipo)` → error explícito con tipo +
  cantidad de movimientos (aproximada, solo de consola) de cada candidata — nunca número ni CBU, y
  nunca solo el tipo (sería un eco circular). El CBU real de Macro trae guiones — se limpia
  (`.replace(/\D/g, '')`) y se valida `/^\d{22}$/` antes de aceptarlo. Motivo de auditoría con un
  segundo sufijo (independiente del de CBU manual de (36)) cuando `--tipo` participó de la elección.
- `apps/cli/tests/alta-cuenta.test.ts`: 10 tests nuevos (45 en total), con los mismos valores
  sintéticos que ya usa `macro.test.ts` (`NRO_USD`/`NRO_ESPECIAL`/`NRO_BANCARIA`, mismos CBU con
  guión) — no se inventa un formato nuevo.
- `docs/diseno/10-deuda-declarada.md` §2.12 (nuevo): mismo criterio que §2.11 — el guardrail cruzado
  automatizado no tiene equivalente para `RE_SECCION_MACRO`/`RE_CBU_MACRO` (`reconoceMacro` no las
  ejercita). No bloqueante, documentado.

**Verificación empírica pedida por `tech-lead` (HANDOFF (38), punto 4), hecha antes de cerrar:** script
descartable de solo-conteo (nunca contenido) contra el PDF real del piloto, confirmando que
`RE_SECCION_MACRO`/`RE_CBU_MACRO` matchean sobre `aLineas()` tal como predecía el diseño: **47** matches
de cabecera (3 números de cuenta distintos, tipos `corriente`/`especial`, monedas `ARS`/`USD`), **47**
matches de CBU, con las 47 dando **exactamente 22 dígitos** después de limpiar guiones. Script borrado
después de correrlo, no queda en el repo.

**Convocatoria (`tech-lead`, `dba-data`, `security-engineer`, `seguridad-datos-financieros`, todos en
HANDOFF (38)) y `code-reviewer` sobre el diff final:** sin bloqueantes. `code-reviewer` verificó con una
prueba de mutación real que el test `'--tipo se aplica SIEMPRE...'` discrimina de verdad — reintrodujo
el bug exacto que `security-engineer` había pedido prevenir (ignorar `--tipo` cuando moneda sola ya
alcanzaba) y el test lo detectó de inmediato; restauró el archivo después, sin diff residual confirmado.

**Medido:** `pnpm typecheck` limpio, `pnpm test` 793/793 (27 archivos), `pnpm barrido` limpio.

**Predicción falsable:** el usuario corre `pnpm alta:cuenta --banco macro --moneda ARS --tipo
cuenta_corriente --archivo <el PDF real> --cliente <uuid> --usuario <uuid>` (con
`ENV_FILE=.env.piloto`) y tiene que imprimir la forma del número/CBU de la cuenta de 1335 movimientos,
sin error. Sin `--tipo` (documento con las dos ARS), tiene que fallar explícito listando los dos tipos
candidatos con su conteo de movimientos — `cuenta_corriente_especial` con un conteo chico,
`cuenta_corriente` con uno mucho más grande. Si imprime la cuenta equivocada o vuelve a fallar de otra
forma, es un hallazgo — no se reintenta sin confirmarlo conmigo primero.

**Rama:** `feat/alta-cuenta-macro-multicuenta`, un commit único (más este de cierre), lista para
mergear a `main` con `--no-ff`.

---

---

## 2026-08-11 (38) — Plan: `leerCaratula` para Macro, tres cuentas y dos ejes (CLAUDE.md §3.2)

**Herramienta:** Claude Code. Dispara modo plan por (a)/(c) — atribución de identificador real de cuenta
(número/CBU, N2-R) y modifica el mismo script que ya corre contra datos reales. Convocatoria completa
(`tech-lead`, `dba-data`, `security-engineer`, `seguridad-datos-financieros`) ya corrida en paralelo,
cada uno leyendo `macro.ts` de forma independiente, no solo mi resumen.

**El caso.** Macro tiene 3 cuentas en un mismo PDF: 1 USD (0 movimientos, se deja para después) y 2 en
ARS de tipo distinto (`cuenta_corriente_especial`, 11 movimientos; `cuenta_corriente`, 1335
movimientos). El fix de Santander asumía que `--moneda` alcanza porque ahí hay a lo sumo una cuenta por
moneda; acá no alcanza — hacen falta dos ejes.

**Investigación previa (confirmada de forma independiente por los 4 agentes, no solo por mí):**
- El formato de Macro es **estructuralmente distinto** al de Santander, no una variante. Cada cuenta
  abre con `CUENTA <TIPO...> NRO.: <número>` (`RE_SECCION`, `macro.ts:238`), que se repite una vez por
  página (47 veces para 3 cuentas reales) — el número (grupo 2) es la clave, el título (grupo 1) nunca.
- A diferencia de Santander, **el CBU sí es atribuible por cuenta**: cada sección tiene su propia línea
  `Clave Bancaria Uniforme para Debito Directo: <CBU>` (`RE_CBU`, `macro.ts:239`), leída **dentro** del
  rango de índices de esa sección (`macro.ts:1127-1153`, `cbu ??= cbuLeido` adentro del loop `for (const
  i of seccion.indices)`). No hace falta ningún prompt manual para este caso.
- Ya existe infraestructura **compartida y exportada** para partir el documento en secciones con
  reapertura por clave: `seccionesPorClave(textos, claveDeEncabezado)` (`toolkit.ts:816`, re-exportada
  desde `@sistema-contable/ingesta` vía `export *` — no es vocabulario privado de un adaptador, a
  diferencia de las regex de Santander). `leerCaratula` la importa directo, no la duplica.
- `--tipo` como argumento CLI nuevo es seguro (a diferencia de `--cbu`): ya se imprime hoy en claro
  (`alta-cuenta.ts`, forma de salida), no es un identificador, no resuelve nada en
  `resolverCuentaDelExtracto` (confirmado por `dba-data`), y es clasificación N1 (confirmado contra
  `clasificacion-campos.ts`).

**Hallazgo crítico de la convocatoria — cambia el diseño original:** con `--tipo` mal elegido por el
operador, a diferencia de Santander, **no hay ninguna señal de error**. Las dos cuentas ARS tienen CBU
reales y distintos, así que el alta con `--tipo` equivocado da éxito limpio sobre la cuenta incorrecta
— sin excepción, sin choque de idempotencia (`seguridad-datos-financieros`, severidad crítica). Mitigación
exigida: el error de ambigüedad tiene que mostrar, de las secciones candidatas, tipo **y cantidad de
movimientos** — no solo el tipo (que es un eco circular: confirma lo que el operador ya tipeó, no una
evidencia independiente). `security-engineer` había marcado el conteo de movimientos como dato a evitar
en un mensaje de error (dato operacional derivado de actividad real); dado que la clasificación de qué
dato es sensible en este negocio es la autoridad de `seguridad-datos-financieros` por diseño del propio
roster (`agents/README.md`: security-engineer audita el control, seguridad-datos-financieros decide qué
proteger), se sigue su recomendación — documentado acá para que quede la tensión, no escondida.

**Hallazgos técnicos de `tech-lead`, incorporados al diseño:**
- El guardrail cruzado automatizado de Santander (contra `reconoceSantander`) **no transfiere igual**:
  `reconoceMacro` no ejercita `RE_SECCION`/`RE_CBU`. Se acepta como deuda declarada (mismo criterio que
  ya usa `10-deuda-declarada.md` §2.11 para las otras dos regex de Santander), no bloqueante.
- El branch de Macro **no necesita** el cross-check manual de números distintos que sí necesita
  Santander: `seccionesPorClave` ya agrupa por clave en un `Map` — dos secciones con el mismo número son,
  por construcción, la misma sección reabierta, nunca dos secciones distintas coincidiendo.
- 🔴 **El CBU real de Macro trae guiones** (`#######-#-#############-#`, confirmado contra
  `packages/ingesta/tests/macro.test.ts:364` — mismos valores sintéticos que ya usa esa suite,
  `'2850000-1-0000000000003-1'`), a diferencia de Galicia/Santander que siempre entregan 22 dígitos
  limpios. El branch de Macro tiene que limpiar (`.replace(/\D/g, '')`) y validar `/^\d{22}$/` antes de
  aceptarlo, con el mismo error explícito que ya usa el resto del archivo — el HMAC saldría bien igual
  (`normalizarIdentificador` ya limpia antes de hashear) pero aceptar una forma sin validar rompe el
  patrón que el archivo ya sigue en cada otro punto.
- **Verificación empírica pendiente, no bloqueante para escribir el código pero sí para darlo por
  cerrado**: `macro.ts` usa `aFilas()` en producción, no `aLineas()` — pero por una razón ajena a las
  cabeceras de sección (el signo de los movimientos, que `leerCaratula` nunca lee). El propio documento
  de diseño (`07-formato-macro.md` §1) mide que las líneas de este archivo específico sobreviven
  `aLineas()` intactas, a diferencia de Galicia — pero esa medición es sobre movimientos, no
  específicamente sobre la línea de cabecera de sección ni la de CBU. Antes de dar el fix por cerrado
  hace falta una corrida real (o un diagnóstico de solo-conteo, nunca contenido) contra el PDF de
  `privado/` que confirme que `RE_SECCION`/`RE_CBU` matchean sobre `aLineas()` tal como se espera.
- Menor, documentado en el código: `monedaDelTitulo` (duplicada) cae a `ARS` por default cuando el
  título no nombra la moneda — es el caso real de "CUENTA CORRIENTE BANCARIA" (sin "PESOS" ni
  "DOLARES"). El adaptador real lo sostiene con una invariante de todo el documento que `leerCaratula`
  no reconstruye (solo lee carátula). Riesgo aceptado, mismo perfil que el resto de la función.

1. **Qué cambia y qué no.** `leerCaratula` gana una tercera rama (formato Macro: detectada por
   `seccionesPorClave` encontrando ≥1 sección), con su propio filtro de dos ejes (`moneda` + `--tipo`
   nuevo, opcional, solo obligatorio cuando `moneda` sola no alcanza). **No cambia:** el branch de
   Santander ni el de Galicia, `macro.ts` (el adaptador real, sin tocar), ni el prompt oculto de CBU de
   (36) — Macro no lo necesita.
2. **Qué se mide.** Tests nuevos con los valores sintéticos YA usados en `macro.test.ts` (mismos
   `NRO_USD`/`NRO_ESPECIAL`/`NRO_BANCARIA`, mismos CBU con guión): 0/1/`>2` secciones por moneda+tipo,
   limpieza de CBU con guiones, mensaje de ambigüedad con tipo+conteo de movimientos (nunca número ni
   CBU), motivo de auditoría con sufijo cuando hubo selección entre variantes. `pnpm verificar` en verde.
   Antes de cerrar: corrida real (o diagnóstico de solo-conteo) contra el PDF de `privado/` confirmando
   que las cabeceras de sección sobreviven `aLineas()`.
3. **Predicción falsable.** El usuario corre `pnpm alta:cuenta --banco macro --moneda ARS --tipo
   cuenta_corriente --archivo <el PDF real> --cliente <uuid> --usuario <uuid>` (con
   `ENV_FILE=.env.piloto`) y tiene que imprimir la forma del número/CBU de la cuenta de 1335 movimientos,
   sin error. Sin `--tipo` (con las dos ARS presentes), tiene que fallar explícito listando los dos tipos
   candidatos con su conteo de movimientos. Si imprime la cuenta equivocada o vuelve a fallar, es un
   hallazgo — no se reintenta sin confirmarlo conmigo primero.
4. **Agentes.** Ya convocados en paralelo: `tech-lead`, `dba-data`, `security-engineer`,
   `seguridad-datos-financieros` — los cuatro con hallazgos incorporados arriba.
5. **Paso revertible más chico.** Un commit único: la rama de Macro, la limpieza de CBU, y `--tipo` son
   el mismo problema (desambiguar tres cuentas de un documento) y separarlos dejaría el fix a medias.
   Revertible con `git revert`, sin efecto en filas ya persistidas.

---

## 2026-08-11 (37) — Investigación: "el prompt de CBU no acepta nada" — no era un bug

**Herramienta:** Claude Code. El usuario reportó, antes de correr nada más, que el prompt oculto de (36)
no aceptaba tipeo ni pegado, en PowerShell (dentro y fuera de VS Code). Pidió investigar la causa antes
de reintentar cualquier cosa, y explícitamente que no se sugiriera `--cbu` como workaround.

**Descartado por descarte sucesivo, con el usuario corriendo cada prueba:**
1. pnpm envolviendo `stdin` — descartado: falló igual con `node apps/cli/src/alta-cuenta.ts` directo.
2. VS Code/ConPTY — descartado: falló igual en una ventana de PowerShell común, fuera del editor.
3. El mecanismo de `stdin` en modo raw en la máquina del usuario — **descartado con evidencia
   concluyente**, dos diagnósticos corridos por el usuario:
   - En la corrida real, `Ctrl+C` sobre el prompt colgado produjo exactamente
     `ABORTA: Cancelado por el operador (Ctrl+C).` — ese mensaje **solo puede salir si el modo raw
     estaba activo** y `onData` interceptó el byte ``. Si el modo raw no hubiera estado
     funcionando, Windows/Node habrían matado el proceso con el SIGINT default, sin ese mensaje.
   - Un test aislado (`node -e "process.stdin.setRawMode(true); ..."`, sin este repo de por medio)
     mostró cada tecla tipeada llegando una por una (`GOT:"s"`, `GOT:"f"`, etc.).

**Conclusión: nunca hubo un bug funcional.** El mismo `onData` que procesó el Ctrl+C correctamente
procesa cada dígito exactamente igual — no hay ninguna rama que trate un carácter de control distinto
de un dígito en cuanto a si SE RECIBE. Lo que pasaba es que el diseño (deliberado, de la convocatoria
de (36): "ni un asterisco") no da **ninguna** señal de que el prompt está vivo mientras se tipea, y con
dos prompts seguidos (CBU y confirmación) es fácil no notar la transición al segundo. Desde la
perspectiva del usuario, "funciona en silencio" y "está colgado" son indistinguibles — el mismo costo
que ya había anticipado `seguridad-datos-financieros` en (36) al elegir cero eco, pero sin haber previsto
que también generaría esta duda.

**Fix aplicado — cosmético, cero cambio de superficie de seguridad:** una línea de texto antes del
primer prompt, aclarando explícitamente que no va a aparecer nada en pantalla, que es a propósito, y
que después del primero va a aparecer un segundo pedido. No cambia el modelo de eco (sigue sin haber
ni un asterisco).

**Decisión sobre agregar feedback por tecla (asteriscos):** se le preguntó al usuario si quería
reabrir la decisión de (36) y agregar un asterisco por tecla (confirmaría "está vivo" sin revelar el
valor, solo la cantidad tipeada — que de todas formas ya se sabe que son 22). El usuario respondió que
la aclaración de texto ya alcanza ("Solucionado") — **se mantiene cero eco, sin asteriscos**, sin
reconvocar a `security-engineer`/`seguridad-datos-financieros` porque no hubo cambio de diseño que
revisar.

**Medido:** `pnpm typecheck` limpio, `pnpm test` en verde (783 tests, sin cambios de comportamiento en
ninguno), `pnpm barrido` limpio.

**Para quien retome:** si un futuro operador reporta el mismo síntoma, el primer paso NO es asumir un
bug de `stdin` — es confirmar con las mismas dos pruebas de acá (Ctrl+C sobre el prompt colgado, y el
`node -e` aislado) antes de tocar código. Si las dos dan la misma señal que acá, es la misma causa:
falta de familiaridad con el diseño de cero eco, no un defecto.

---

---

## 2026-08-11 (36) — `--cbu` sacado del CLI: prompt oculto de doble tipeo, en su lugar

**Herramienta:** Claude Code. Cierra un gap de seguridad que el propio usuario detectó en el cierre (35),
antes de correr el comando que esa entrada dejaba pendiente — no se le dio ningún comando con `--cbu`.

**El problema.** El fix de (34)/(35) agregó `--cbu <22 dígitos>` como argumento CLI para el caso
multi-cuenta. Eso reintroduce el riesgo 1 que la propia cabecera de `alta-cuenta.ts` (líneas 7-22) ya
documentaba desde antes: un valor pasado por argumento queda permanente en
`PSReadLine\ConsoleHost_history.txt`. Ni la convocatoria de (34)/(35) (`dba-data`, `tech-lead`,
`security-engineer`, `seguridad-datos-financieros`) lo cruzó contra el propio header del archivo que
motivaba la regla.

**Qué se hizo, convocando de nuevo a `security-engineer` y `seguridad-datos-financieros` sobre el
diseño antes de escribirlo, y a `code-reviewer` sobre el diff final:**
- `--cbu` sale del esquema de argumentos. `argumentos()` ahora rechaza explícito cualquier `--cbu` o
  `--cbu=valor` en `argv` (el chequeo por `=` lo agregó `code-reviewer`: el primero solo cubría
  `--cbu <valor>` con espacio, y `--cbu=valor` pasaba en **silencio total** — ni error ni el
  recordatorio de limpiar el historial). El mensaje le dice al operador que, si lo tipeó, esa línea
  YA quedó grabada, y da el comando de PowerShell para revisar el historial.
- `pedirValorOculto()` (nueva, exportada para test): lee de `stdin` en modo raw, sin ecoar un solo
  carácter (ni asteriscos — dos CBU de igual longitud se ven idénticos bajo cualquier máscara por
  posición), con soporte de backspace, Ctrl+C (rechaza con `PedidoDeCbuCancelado`, nunca con el buffer
  parcial) y escaneo del chunk completo (no solo el último carácter, por si un paste trae el Enter
  pegado). Nunca pasa por `argv` ni por una variable de entorno.
- `pedirCbuConfirmado()` (nueva, exportada): pide el CBU **dos veces** y exige que coincidan byte a
  byte antes de aceptarlo — no una confirmación con `forma()`, que no sirve acá (todo CBU de 22 dígitos
  produce la misma forma, no hay manera de que el operador confirme a ojo que tipeó el correcto).
  Imprime una advertencia de no copiar/pegar el valor en ningún chat, ticket, captura ni asistente de
  IA (ADR-0002 §F.2). Ninguno de sus tres `throw` interpola el valor tipeado.
- El bloque CLI real intenta `leerCaratula` sin CBU manual primero; solo si tira el error puntual de
  "no se puede atribuir a una sola moneda" invoca el prompt. El motivo de auditoría de
  `escribirConAuditoria` gana un sufijo fijo (`— CBU ingresado manualmente por el operador, no leido del
  documento`) cuando el CBU vino del prompt, agregado por la CLI, nunca por el operador — para que
  "¿esto se leyó o lo tipeó alguien?" sea contestable desde `acceso_auditoria`.

**Hallazgos de la convocatoria, todos cerrados en el mismo commit:**
- `security-engineer` confirmó la premisa central (stdin de un proceso hijo no lo registra `PSReadLine`,
  a diferencia de lo que se somete al propio prompt de PowerShell) y encontró el gap de `--cbu=valor`
  antes que `code-reviewer` lo confirmara ejecutando código real contra un `--cbu` sin `=`; pidió manejo
  explícito de Ctrl+C y escaneo de chunk completo — los dos ya estaban en el diseño y quedaron
  implementados tal cual.
- `seguridad-datos-financieros` calificó de **crítico** el riesgo de que un operador tipee de memoria el
  CBU de otra cuenta real del mismo cliente (mismo mecanismo de idempotencia silenciosa que ya describió
  en (34)) y pidió doble tipeo en vez de una confirmación con eco parcial — implementado.
- `code-reviewer`, sobre el diff final, encontró el bug de `--cbu=valor` (bloqueante, corregido) y un
  leak de `process.on('exit', ...)` en `pedirCbuConfirmado` sin `removeListener` simétrico (corregido
  con `try/finally`). Sugirió además un valor de prueba menos repetitivo para el test de no-interpolación
  — no aplicado, cosmético.

**Medido:** `pnpm typecheck` limpio, `pnpm test` 783/783 (35 tests nuevos en `alta-cuenta.test.ts`,
incluidos los dos casos que atraparon los bugs de `code-reviewer`), `pnpm barrido` limpio.

**Predicción falsable (retoma la de (35)):** el usuario corre `pnpm alta:cuenta --banco santander
--moneda ARS --archivo <el PDF real> --cliente <uuid> --usuario <uuid>` con `ENV_FILE=.env.piloto` —
**sin `--cbu`, nunca**. Al detectar que el documento tiene más de una cuenta, el script va a pedir el
CBU con un prompt oculto (dos veces, sin eco). Si el script pide `--cbu` como argumento, o si algo se ve
en pantalla mientras se tipea, es un hallazgo — no seguir, avisar antes de reintentar.

**Rama:** commit directo sobre la rama de (35) ya mergeada, listo para su propia rama +
`merge --no-ff`.

---

---

## 2026-08-11 (35) — Cierre: `leerCaratula` multi-cuenta implementado, revisado y en verde

**Herramienta:** Claude Code. Cierra la tarea planificada en (34) y su enmienda.

**Qué se hizo, sobre el alcance final de la enmienda (no el original):**
- `apps/cli/src/alta-cuenta.ts`: `leerCaratula(texto, moneda, cbuManual)` ahora detecta el formato
  Santander (cabeceras `Cuenta Corriente...Nº`, regex duplicadas de `santander.ts` con el mismo escape
  `º`), filtra el número de cuenta por moneda con dedupe por valor distinto, cruza contra la otra
  moneda para detectar un filtro que no discrimine, deriva `tipoCuenta` de la cabecera matcheada, y trata
  el CBU como no atribuible cuando el documento tiene más de una cuenta (mismo criterio que
  `santander.ts:817-832`) — exige `--cbu <22 dígitos>` explícito en ese caso, nuevo argumento opcional.
  El camino Galicia (una sola cuenta, sin esas cabeceras) queda sin cambios de comportamiento.
  `leerCaratula`/`argumentos`/`clasificarTipo` pasan a `export function` con guard `esEjecucionDirecta`
  (mismo patrón que `ingestar.ts`), y la salida imprime qué sección se usó (texto de código, nunca la
  línea real del documento).
- `apps/cli/tests/alta-cuenta.test.ts` (nuevo, 19 tests): Galicia sin cambios, Santander una-cuenta,
  multi-cuenta con y sin `--cbu`, 0/`&gt;1` números distintos, cross-check de colisión, cabecera repetida
  por página (no es error), idempotencia cruzada (el guard corta antes de tocar la base), y un guardrail
  que corre la misma cadena literal contra `leerCaratula` y contra `reconoceSantander` (exportado de
  `santander.ts`) para detectar divergencia futura entre las dos copias de regex.
- `docs/diseno/10-deuda-declarada.md` §2.11 (nuevo): declara que el guardrail cruzado solo cubre
  `RE_CABECERA_CUENTA` vía `reconoceSantander` — `RE_NUMERO_CUENTA_EN_CABECERA` y `RE_ES_DOLARES` quedan
  sin cross-check automatizado (verificadas a mano, carácter por carácter, hoy). No bloqueante.

**Convocatoria (§3.1, tareas #25-28) y `code-reviewer` (diff completo):** los cuatro agentes de la
enmienda están documentados en (34). `code-reviewer`, sobre el diff final, no encontró bugs de
correctitud activos — confirmó dedupe, cross-check, guard de CBU y camino Galicia correctos — y señaló
el hallazgo que quedó como §2.11 más un `º` sin escapar (corregido antes de este commit).

**Medido:** `pnpm typecheck` limpio, `pnpm test` 767/767 (27 archivos, 0 fallos — incluida
`verificar-fixtures.test.ts`, que había dado timeout una vez por contención de recursos mientras corrían
los cuatro agentes en paralelo, y corrió limpio en 24.7 s en la corrida en serie), `pnpm barrido` limpio.

**Predicción falsable (punto 3 del plan), NO verificada todavía:** falta que el usuario corra
`pnpm alta:cuenta --banco santander --moneda ARS --cbu &lt;el CBU real de la cuenta en pesos&gt; --archivo
&lt;el PDF&gt; --cliente &lt;uuid&gt; --usuario &lt;uuid&gt;` con `ENV_FILE=.env.piloto`. Nota importante para esa
corrida: como el documento es multi-cuenta (trae también la sección USD), **hace falta `--cbu` explícito**
— sin él, el script va a fallar con el mensaje "no se puede atribuir a una sola moneda", que es el
comportamiento correcto y esperado, no un bug nuevo.

**Rama:** `fix/alta-cuenta-caratula-multicuenta`, un commit único (más este de cierre), lista para
mergear a `main` con `--no-ff`.

---

## 2026-08-11 (34) — Plan: `leerCaratula` multi-cuenta (CLAUDE.md §3.2)

**Herramienta:** Claude Code. Dispara modo plan por (b) y (c) — atribución de identificadores reales
de cuenta (CBU/número, N2-R), y modifica un script que ya corre contra datos reales. El usuario pidió
explícitamente modo plan para esto, aunque no estuviera 100% seguro del gatillo exacto — correcto:
sí dispara, por las dos razones de arriba.

**Contexto medido, en esta misma sesión, antes de escribir el plan:**
- `leerCaratula` (`apps/cli/src/alta-cuenta.ts:99-171`) busca el número de cuenta con 4 etiquetas
  documentadas como propias de Galicia (`docs/diseno/02-formato-galicia.md` §3) — ninguna matchea el
  rótulo real de Santander (`"Cuenta Corriente en Pesos Nº ..."` / `"...especial U$S Nº ..."`, per
  `RE_CABECERA_CUENTA` de `santander.ts`). `valorPorEtiqueta` (`toolkit.ts:104`) busca por substring
  (`indexOf`), así que ninguna etiqueta corta matchea un rótulo con palabras en el medio.
- `--moneda` existe en el esquema de `alta-cuenta.ts` (`z.enum(['ARS','USD']).default('ARS')`) pero
  **no filtra la búsqueda**: con dos cuentas en el mismo archivo (el caso real de Santander: pesos +
  USD), toma la primera que aparece en el documento, sin garantía de que sea la correcta.
- El usuario está dando de alta la cuenta en **pesos** (158 movimientos reales; la de USD dio
  `EST_SIN_MOVIMIENTOS`/`no_verificable` en A2, se deja para después).

1. **Qué cambia y qué no.** `leerCaratula` gana reconocimiento del rótulo real de Santander (`Cuenta
   Corriente en Pesos Nº` / `Cuenta Corriente especial U$S Nº`), y `--moneda` pasa a filtrar: con
   múltiples secciones "Cuenta Corriente...Nº" en el documento, se usa la que coincide con la moneda
   pedida (`ARS`→"en Pesos", `USD`→"especial U$S"/"U$S"), no la primera que aparece. **No cambia:**
   `santander.ts` ni ningún adaptador (su propia detección ya es correcta, por geometría); el
   comportamiento para Galicia (una sola cuenta por archivo, sin ambigüedad) no debería moverse.
2. **Qué se mide.** Test nuevo (o existente, si hay alguno para `leerCaratula`) que confirme: con un
   texto sintético de dos "Cuenta Corriente" (pesos y USD), `--moneda ARS` encuentra el número de la
   sección de pesos y `--moneda USD` el de la de USD — nunca cruzados. `pnpm verificar` en verde.
3. **Predicción falsable.** El usuario corre `pnpm alta:cuenta --banco santander --moneda ARS
   --archivo <el mismo PDF real> --cliente <uuid> --usuario <uuid>` (con `ENV_FILE=.env.piloto`) y
   tiene que imprimir la forma del número de cuenta de la sección "en Pesos", sin error. Si imprime la
   forma de la cuenta USD, o vuelve a fallar, es un hallazgo — no se reintenta sin confirmarlo primero
   conmigo.
4. **Agentes.** `dba-data` (escribe `cuenta_bancaria_identificador` con el hash) + `tech-lead`
   (coherencia entre la detección de `santander.ts` y la de `leerCaratula` — mismo patrón de la quinta
   cara) + `security-engineer` + `seguridad-datos-financieros` — los dos últimos obligatorios por el
   riesgo que el propio archivo ya declara: un identificador mal atribuido "nunca va a resolver" y
   queda así de forma permanente.
5. **Paso revertible más chico.** Un commit único: los dos cambios (etiqueta + filtro por moneda)
   resuelven el mismo problema y no tiene sentido separarlos — un commit a medias (solo la etiqueta,
   sin el filtro) dejaría la ambigüedad multi-cuenta intacta, que es justo lo que el usuario pidió
   cerrar de una. Revertible con `git revert`, sin efecto en filas ya persistidas (es un fix de lectura,
   no toca datos existentes).

### Enmienda tras la convocatoria (los cuatro agentes ya corrieron) — el alcance del punto 1 creció

Los cuatro agentes de la matriz de arriba corrieron de verdad (`Agent()`, no narrado) y devolvieron
hallazgos que **cambian el alcance** del punto 1, no solo lo confirman. Se documentan acá, antes de
escribir el diff, siguiendo el mismo estándar que ya se aplicó toda la sesión (HANDOFF (17)/(18)): un
plan que no se actualiza con lo que dice la convocatoria es la misma falla de nuevo.

- **`tech-lead`** confirmó el diseño exacto: reusar `RE_CABECERA_CUENTA`/`RE_NUMERO_CUENTA`/
  `RE_ES_DOLARES` de `santander.ts` (líneas 377/388/391), **duplicados** en `alta-cuenta.ts` (no
  importados — `packages/ingesta/src/index.ts` prohíbe exponer vocabulario interno de un adaptador), con
  un test-guardrail que corre el mismo string sintético contra las dos copias para que una divergencia
  futura tire el gate rojo. El patrón de valor actual (`^...$`, anclado en los dos extremos) NO sirve
  para Santander: ahí el número va incrustado en la misma línea que la cabecera, no en la línea
  siguiente — hace falta `RE_NUMERO_CUENTA` con `.exec()` directo, sin pasar por `valorPorEtiqueta`.
  Selección: juntar TODAS las cabeceras que matchean `RE_CABECERA_CUENTA`, filtrar por
  `RE_ES_DOLARES(l) === (moneda==='USD')`, extraer número de cada una y **deduplicar por valor
  distinto** (no por cantidad de cabeceras — la cabecera puede repetirse una vez por página). 0 números
  distintos o >1 número distinto para la moneda pedida ⇒ error explícito, nunca adivinar. Confirmó
  también que Galicia no colisiona (su etiqueta nunca aparece como substring del rótulo de Santander) y
  que **hace falta exportar `leerCaratula`/`argumentos`/`clasificarTipo`** con el mismo patrón de guard
  que ya usa `ingestar.ts` (`esEjecucionDirecta`) — hoy es imposible testear la función sin correr el
  script completo, y sin eso el punto 2 de este plan no es escribible.
- **`security-engineer`** encontró el hallazgo que más cambia el alcance: **el plan original no tocaba
  el CBU**, solo el número de cuenta. Pero el CBU es el campo obligatorio del que depende toda
  resolución futura de extractos, y `santander.ts` (líneas 817-832) ya decidió, con dos cuentas en el
  documento, que el CBU queda **no determinado** — nunca atribuido a una sola moneda, porque no hay
  ninguna señal en el archivo que lo ate a una de las dos. Peor: como `altaDeCuentaBancaria` es
  idempotente por `(cliente_id, pepper_id, cbu_hmac, vigente_desde)`, si las dos altas (ARS y luego USD,
  que es justo el plan del usuario: "la de USD la dejamos para después") comparten el mismo CBU leído
  con el mismo `vigenteDesde`, la segunda alta **no crea nada** — devuelve en silencio los ids de la
  cuenta ya cargada, y el CLI imprime "Alta OK" como si hubiera dado de alta la cuenta en dólares.
  También señaló que `tipoCuenta` no estaba cubierto por el filtro propuesto (mismo riesgo de cruce que
  el número) y que la etiqueta/sección matcheada tiene que imprimirse (texto de código, no dato del
  cliente) porque `forma()` sola no distingue dos números de igual longitud de secciones distintas.
- **`seguridad-datos-financieros`** midió la consecuencia concreta si el filtro matcheara la sección
  equivocada sin fallar: la cuenta real en pesos queda huérfana con un diagnóstico **engañoso**
  (`cuenta_no_pertenece_al_cliente`, no `cuenta_no_registrada` — le dice al operador "este archivo no es
  de este cliente" cuando sí lo es), y la cuenta real en dólares resuelve **silenciosamente** contra la
  fila mal rotulada, mezclando movimientos de las dos monedas bajo una sola cuenta. Severidad: crítica.
  Recomendó, además del error explícito, un cross-check en la misma corrida (comparar el número hallado
  para la moneda pedida contra el de la otra moneda; si coinciden, el filtro no discriminó y hay que
  abortar) como defensa adicional contra un ancla débil.
- **`dba-data`** confirmó que no hace falta migración y que la única red de la base
  (`uq_cuenta_ident_numero_vigente`/`uq_cuenta_ident_cbu_vigente`, `0009`) **no cubre** este escenario
  porque protege contra reuso de un identificador ya existente, no contra un primer alta mal atribuido
  contra un identificador que todavía no está en la base (la cuenta USD real). También confirmó que no
  existe ningún camino para dar de baja un identificador mal cargado — se documenta como hueco en
  `docs/diseno/10-deuda-declarada.md` si hace falta después, no se resuelve acá.

**Alcance final del punto 1, reemplaza al original:**
1. `leerCaratula` detecta el formato Santander (≥1 cabecera `RE_CABECERA_CUENTA`) vs. Galicia (0
   cabeceras, camino actual sin cambios).
2. Con formato Santander: número de cuenta filtrado por moneda con dedupe por valor distinto + error
   explícito si 0 o >1; cross-check contra la otra moneda (mismo número en las dos ⇒ abortar);
   `tipoCuenta` derivado de qué cabecera matcheó (`especial U$S`→`cuenta_corriente_especial`,
   si no→`cuenta_corriente`), no de la etiqueta `'Tipo de cuenta'` que Santander no imprime.
3. CBU: si el documento tiene más de una cabecera de cuenta (multi-cuenta), **no se atribuye** — se
   agrega `--cbu <22 dígitos>` como argumento opcional nuevo, exigido solo en este caso, con el mismo
   error explícito que ya usa el resto del archivo si falta. Documento de una sola cuenta: sin cambios
   (se sigue leyendo por etiqueta).
4. La salida imprime, además de las formas ya existentes, qué sección/etiqueta se usó (texto de código
   fijo, nunca la línea real del documento) para que el operador confirme a ojo.
5. `leerCaratula`/`argumentos`/`clasificarTipo` pasan a `export function`, con guard
   `esEjecucionDirecta` igual a `ingestar.ts`, para que sean testeables.

El punto 2 (qué se mide) se amplía: además del caso ya descripto, un test de idempotencia cruzada (dos
altas con `vigenteDesde` igual y CBU compartido tienen que fallar por el punto 3 de arriba ANTES de
llegar a `altaDeCuentaBancaria` — nunca devolver silenciosamente los ids de la otra cuenta) y el
guardrail cruzado de regex contra `santander.ts` que pidió `tech-lead`. El punto 3 (predicción
falsable) no cambia. El punto 5 (paso revertible) tampoco: sigue siendo un commit único — separar el
CBU del número dejaría exactamente el mismo riesgo crítico que describió `seguridad-datos-financieros`
sin cerrar.

---

## 2026-08-11 (33) — 🔴 CIERRE DE SESIÓN. Punto de entrada si retomás sin este chat.

**Herramienta:** Claude Code, sesión larga y autónoma (el usuario se ausentó después de dar la
confirmación inicial; volvió para correr los tres `pnpm probar` reales y para las decisiones de
6.3). Todo lo de abajo está mergeado a `main`, sin ramas pendientes.

### Qué se cerró, de punta a punta

| Parte | Estado | Commit de merge |
|---|---|---|
| Registro de los 23 sub-agentes | ✅ resuelto (bug de YAML sin comillar, no un bug de Claude Code) | `b228f10` |
| D — modo plan obligatorio | ✅ `CLAUDE.md` §3.2, `AGENTS.md` §6 | `72294c0` |
| A1 — contrato unificado de adaptadores | ✅ | `71df9f2` |
| A2 — destinos (C1-C5) | ✅ en código | `67a3adc` |
| 6.1 — catálogo de bancos | ✅ (migración `0011`, aplicada a dev) | `00cfda0` |
| 6.2 — `pnpm alta:cliente` | ✅ | `e2bbabe` |
| **A2 confirmado contra archivo real** | ✅ Macro y Galicia exactos; Santander con residuo=5 sin explicar, contingencia aplicada | commit `9cee789` |

Cada parte tuvo su convocatoria real (`TaskCreate`/`addBlockedBy`, nunca solo declarada) y su
`code-reviewer` sobre el diff final antes de mergear. `pnpm verificar`: **747 tests + 7 todo** (era
680 al arrancar D). Tres hallazgos de seguridad reales aparecieron y se corrigieron en el camino (ver
`docs/diseno/10-deuda-declarada.md` §1.7 y §2.1) — ninguno se sabía de antemano, los encontró la
convocatoria.

### A2 contra los tres archivos reales — el resultado que importa

- **Macro**: exacto contra la predicción (HANDOFF 22). `sinDestino=0`, `residuo=0`,
  `fueraDelCuerpo=0`, 1346/6/3. `INV-destinos: diferencias=0`. **Dos observaciones en la corrida,
  las dos verificadas contra el código y NO son hallazgos** (re-preguntadas por el usuario después
  de que la primera respuesta se perdiera en un resumen de contexto — esta vez con cita exacta):
  1. `VEREDICTO DEL LOTE: no_verificable` — viene de la cuenta 1 (USD, 0 movimientos).
     `verificarAritmetica` (`invariantes.ts:307-309`) empuja `EST_SIN_MOVIMIENTOS` en severidad
     `observación` (no `error`) porque el lote entero tiene movimientos (1346); con eso el tri-estado
     de esa cuenta da `no_verificable`, nunca `no_cuadra`. `persistir.ts:86-125` tiene el bloque
     específico para esto —con su propia advertencia 🔴 de un bug real que un panel de tres agentes
     encontró ahí en una versión anterior, ya corregido (exige `saldoInicialDeclarado ===
     saldoFinalDeclarado`, si no coincide rechaza igual)— y persiste la cuenta vacía como
     `procesado_con_observaciones`. Mismo patrón ya medido para la cuenta USD vacía de Santander.
     **Diseño confirmado funcionando, no deuda.**
  2. Cuenta 3, 4 filas `EST_FECHA_FUERA_DE_PERIODO` — coincide EXACTO con lo ya declarado en
     `CAPACIDADES_MACRO` (`macro.ts:124-131`, "4 movimientos... dos del 20/10 y dos del 22/10 en un
     resumen del 01/11 al 28/11"): el archivo real corrido es ese mismo resumen. Severidad
     `observación` a propósito (`traeMovimientosFueraDelPeriodo: true`), por eso la cuenta igual dio
     `cuadra`. **Es la misma medición ya declarada antes de esta sesión, reproducida — no un
     hallazgo nuevo.**
- **Galicia**: exacto contra la predicción. `sinDestino=0`, `fueraDelCuerpo=29`, `residuo=0`, 326/9.
  `INV-destinos: diferencias=0`.
- **Santander**: `residuo=5` — primera vez que se mide contra archivo real, sin predicción numérica
  previa. Las 5 formas están guardadas en HANDOFF (31). Se investigaron dos regex
  (`RE_ANEXO_RESUMEN`/`RE_ANEXO_COMPUTABLE`) como causa — **descartado**, siguiendo la cadena de
  llamadas completa hasta el final (ya reciben texto normalizado a mayúsculas). Quedan **tres
  candidatos reales sin confirmar**, documentados en `docs/diseno/10-deuda-declarada.md` §2.1 con la
  línea exacta de código de cada uno. **Falta correr `pnpm probar --banco santander --archivo <ruta>
  --caratula <n>`** contra los índices de esas 5 líneas — es el próximo paso, y es del usuario, no de
  un agente (dato real).

### La contingencia aplicada, y el bug que casi la vuelve inútil

`verificarDestinos` (`invariantes.ts`) baja `residuo>0` de `error` a `observación` — el residuo de
Santander no bloquea 6.3 mientras se investiga. `sinDestino>0` y `destinos_no_declarados` siguen en
`error`, sin tocar. **`code-reviewer` encontró que esto no tenía efecto real**: `ingestar.ts`
rechazaba por *presencia* de diferencias (`.length > 0`), no por severidad — el mismo patrón que
`persistir.ts` ya usaba (`primeraDiferencia`, filtra por `error`) nunca se replicó en el gate de
lote. **Corregido en el mismo commit** (`9cee789`), con test nuevo que agarra específicamente esa
clase de regresión. Restaurar `residuo` a `error` cuando se confirme la causa: una línea
(`severidadResiduo` en `invariantes.ts`, comentario 🔴 en el propio código).

### `Math.sumPrecise` — explicado y documentado, no bloqueante

Warning benigno de `unpdf` (copia de `pdf.js` que usa una API de V8 muy nueva sin comprobar si
existe, en código de escritura de fuentes/formularios — nunca en el camino de lectura de texto que
este repo usa). Confirmado con datos reales que no correlaciona con `traeTotalesDeclarados` (Santander
lo tiene en `false` y el warning apareció igual). Documentado en `docs/diseno/10-deuda-declarada.md`
§2.10. Candidato a cerrar actualizando `unpdf`, sin urgencia.

### 6.3 — dónde quedó, específicamente

**Script descartable de titularidad: construido y con smoke test, sin correr contra archivos
reales.** `packages/ingesta/scripts/comparar-titularidad.ts` — **sin commitear a propósito** (así lo
pidió el plan; la traza es esta bitácora, no el árbol de git). Diseño revisado por
`seguridad-datos-financieros` antes de escribirse: el CUIT nunca sale de una única función
(`compararTitulares`), normaliza antes de comparar, `undefined` en cualquiera de los dos →
`no_publicado` (nunca un falso "distintos" silencioso), un solo `try/catch` que nunca imprime
`error.message`. Comando:

```bash
node packages/ingesta/scripts/comparar-titularidad.ts \
  --archivo1 <ruta al PDF real de Santander> --banco1 santander \
  --archivo2 <ruta al PDF real de Macro> --banco2 macro
```

Imprime únicamente `mismo_titular: true|false` (más un par de líneas de diagnóstico sin datos). **Si
la sesión se reinicia, este es el primer comando a correr para 6.3** — nada de lo que sigue puede
arrancar sin su resultado.

**Nada más de 6.3 arrancó.** `pnpm alta:cliente`, `alta-cuenta.ts`, `ingestar.ts` real contra el
piloto: **todavía no se tocó nada**, esperando el booleano de titularidad y, antes que eso, la
confirmación de Santander contra archivo real (o la decisión de proceder igual con el residuo como
deuda conocida — ya es una opción viable, la contingencia está aplicada y funcionando).

**Bancor sigue en pausa total, sin tocar, como en toda la sesión.**

### Para retomar sin este chat, en orden

1. Si todavía no se corrió: `pnpm probar --banco santander --archivo <ruta> --caratula <n>` contra
   los índices de las 5 líneas de residuo (HANDOFF 31) — decide entre los 3 candidatos de
   `10-deuda-declarada.md` §2.1, o confirma que hace falta seguir investigando.
2. Correr `comparar-titularidad.ts` (comando arriba) — el usuario, en su terminal, nunca en el
   contexto de un agente.
3. Con el booleano: decidir 1 o 2 llamadas a `pnpm alta:cliente` (`--estudio`, `--nombre`, `--usuario`
   — los tres obligatorios, ver HANDOFF 26/27).
4. `alta-cuenta.ts` para cada cuenta, con el extracto **más viejo** de cada una (no el que ya se usó
   para probar A2).
5. `ingestar.ts` real contra el piloto, para los dos bancos.
6. Comparar los conteos reales contra los medidos por `pnpm probar` — tienen que coincidir exacto.

---

## 2026-08-11 (32) — Plan: fix de los 2 regex + contingencia de C5 (CLAUDE.md §3.2)

**Herramienta:** Claude Code. Dispara modo plan por (c) — modifica `santander.ts`, adaptador que ya
corre contra datos reales. Decisión ya tomada por el usuario (HANDOFF 31, este mensaje) — el plan
documenta la ejecución, no abre la decisión.

1. **Qué cambia y qué no.** `RE_ANEXO_RESUMEN` y `RE_ANEXO_COMPUTABLE` (`santander.ts`) ganan la flag
   `i`: son case-sensitive contra un literal en mayúsculas que el documento real no imprime así (formas
   1 y 2 del residuo=5 medido, HANDOFF 31). `verificarDestinos` (`invariantes.ts`): el caso `residuo>0`
   pasa a severidad `observación` en vez de `error` — contingencia ya prevista en el diseño de C5
   (HANDOFF 22 punto 5), aislada para poder revertirse en una línea. **No cambia:** `sinDestino>0` ni
   `destinos===undefined && declaraDestinos` — esos dos siguen en `error`, no están cubiertos por esta
   contingencia (son violaciones más estructurales: partición que no cierra, o promesa incumplida).
2. **Qué se mide.** `pnpm verificar` en verde. El usuario corre `pnpm probar --banco santander` contra
   el mismo archivo real después del fix de regex — eso, no un test, es lo que confirma si el residuo
   bajó.
3. **Predicción falsable.** Si las formas 1 y 2 eran de verdad `RE_ANEXO_RESUMEN`/`RE_ANEXO_COMPUTABLE`
   sin matchear por case, el residuo baja de 5 a **exactamente 3** (las formas 3, 4 y 5 sin explicar).
   Si baja a otro número, la hipótesis estaba incompleta — hay que revisar cuál regex explica qué.
4. **Agentes.** `code-reviewer` sobre el diff antes de cerrar — cambio chico pero toca un adaptador con
   datos reales y el gate de producción.
5. **Paso revertible más chico.** Los dos regex, un commit. La contingencia de severidad, otro commit
   separado — son independientes y cada uno se puede revertir solo.

---

## 2026-08-11 (31) — A2 contra archivo real: Galicia confirmado, Santander con residuo=5 a clasificar

**Corrido por el usuario**, dato real, solo las formas (sin dígitos/texto real) llegan a este contexto.

### Galicia — confirmado exacto contra la predicción (HANDOFF 22)

`sinDestino=0`, `fueraDelCuerpo=29`, `residuo=0`, 326 movimientos, 9 anexos, `INV-destinos:
diferencias=0`, `VEREDICTO DEL LOTE: cuadra`, hashes únicos 326/326. Sin hallazgos de A2 — instrumentación
de Galicia (C4) confirmada contra archivo real.

### Santander — corrida, con `residuo=5` (`EST_LINEA_NO_INTERPRETADA`), pendiente de clasificar

Las **formas** de las 5 líneas sin interpretar (`a`=minúscula, `A`=inicial mayúscula de palabra,
`#`=dígito — nunca el texto ni los dígitos reales, mismo criterio que imprime `pnpm probar`):

```
×1  Aaaaaaa aa a{9} a{8} aaa ##### aaa ##-##-#### aa ##-##-####
×1  Aaaaaaa a{11} aa aaa a{9} aaaaaa aaaaa a{8} aaa ##-##-#### …
×1  Aa{8} Aa{8}
×1  Aaaaa Aaaa Aaaaaa Aaaaaa Aa{10} AAA AAA AAAAA Aaaaaaa aaaaa…
×1  aaaaa aaaaa
```

**Pendiente de responder:** ¿se pueden clasificar en el vocabulario de `DESTINOS_BASE`, o hace falta el
camino de contingencia (`observación` + seguimiento, ya previsto en el plan A2 — HANDOFF 22, punto 5)?
¿Esto bloquea 6.3 (ingesta real de Santander), o el residuo puede quedar declarado como deuda conocida
mientras se procede?

### Math.sumPrecise — confirmado benigno, con el dato de Santander

El warning apareció también en Santander (8 veces) pese a `traeTotalesDeclarados: false` — descarta la
hipótesis de que correlacionaba con el camino V2 de verificación de totales. Documentado completo en
`docs/diseno/10-deuda-declarada.md` §2.10.

---

## 2026-08-11 (30) — A2 confirmado contra archivo real: Macro (1 de 3)

**Corrido por el usuario** (`pnpm probar --banco macro --archivo <ruta real, 11-2025 cta cte
especial.pdf>`), no por un agente — dato real, no pasa por este contexto más que como conteos.

**Coincide exacto con la fila "Esperado" de la predicción de Macro (HANDOFF 22):** `sinDestino=0`,
`residuo=0` (no interpretadas=0), `fueraDelCuerpo=0`, 1346 movimientos, 6 anexos (1+3+2 por cuenta), 3
cuentas. `INV-destinos: diferencias=0` — el gate de C5 no rechaza nada. **La instrumentación de Macro
(C3) queda confirmada contra archivo real**, no solo contra el fixture sintético.

Dos observaciones en la corrida, ninguna es hallazgo — ya estaban documentadas en `CAPACIDADES_MACRO`
antes de esta sesión: `VEREDICTO DEL LOTE: no_verificable` viene de la cuenta USD con `EST_SIN_MOVIMIENTOS`
(0 movimientos en dólares, ya sabido); los 4 `EST_FECHA_FUERA_DE_PERIODO` en la cuenta 3 son los mismos 4
movimientos de octubre en el resumen de noviembre ya medidos (`traeMovimientosFueraDelPeriodo: true`).

**Falta Galicia y Santander** (el usuario los está corriendo) antes de dar A2 por confirmado del todo.

---

## 2026-08-11 (29) — Plan 6.3, primer paso (CLAUDE.md §3.2, escrito antes del primer `Edit`)

**Herramienta:** Claude Code, sesión autónoma, con confirmación explícita del usuario para este paso
puntual (no para el resto de 6.3). Dispara modo plan por (b) — maneja CUIT real, aunque sea solo en
memoria y nunca lo emita.

1. **Qué cambia y qué no.** Un script **descartable, sin commit de código** (el plan lo marca así
   explícitamente): lee los dos PDF reales (Santander y Macro) con `resolverAdaptador`/`leer()` — el
   mismo camino que `probar-adaptador.ts` — y compara `cuenta.titularDocumento` (el CUIT que cada
   adaptador ya extrae de la carátula, campo `CuentaDetectada.titularDocumento`) de las dos cuentas.
   Devuelve por stdout **únicamente** `mismo_titular: true` o `mismo_titular: false`. El CUIT completo
   nunca se imprime, nunca se loguea, nunca queda en una variable que sobreviva a la función que lo lee.
   **No toca la base ni el storage** (mismo criterio que `probar-adaptador.ts`). **No cambia:** ningún
   adaptador, ningún archivo del pipeline de ingesta real.
2. **Qué se mide.** El script corre limpio contra los dos PDF y termina con exactamente una línea de
   salida útil (el booleano) más las líneas de diagnóstico sin datos (cuántas páginas, si cada adaptador
   pudo leer el documento) — mismo estilo que `probar-adaptador.ts`.
3. **Predicción falsable.** No aplica en el sentido numérico de A2 — es un booleano, no un conteo. La
   predicción es de *comportamiento*: si alguno de los dos extractos no publica `titularDocumento`
   (`undefined`), el script tiene que fallar con código explícito (`documento_no_publicado` o similar),
   nunca asumir `mismo_titular: false` por comparar `undefined !== undefined` en falso silencioso.
4. **Agentes.** `seguridad-datos-financieros` — obligatorio por CLAUDE.md §3.1 (dato de cliente).
5. **Paso revertible más chico.** El script entero, al no comitearse, no deja rastro en el árbol de
   `main` — es la unidad más chica posible: se corre, se lee el resultado, se borra.

---

## 2026-08-11 (28) — 6.2 cerrado. Sesión autónoma en pausa: lo que sigue necesita al usuario

**Herramienta:** Claude Code. Mergeado a `main` (`feat/alta-cliente-cli`, `--no-ff`). `pnpm alta:cliente`
existe y está probado con RLS real (8 tests, incluida la prueba por mutación del guard de tipo y el test
que fija el comportamiento del `RETURNING`).

**Estado del plan D → A1 → A2 → 6, de punta a punta, todo mergeado a `main` salvo lo marcado abajo:**

| Parte | Estado |
|---|---|
| D — modo plan obligatorio | ✅ cerrado (CLAUDE.md §3.2, AGENTS.md §6) |
| A1 — contrato unificado | ✅ cerrado |
| A2 — destinos (C1-C5) | ✅ cerrado **en código**. 🔴 **sin confirmar contra archivo real** (ver HANDOFF 23) |
| 6.1 — catálogo de bancos | ✅ cerrado |
| 6.2 — `alta:cliente` | ✅ cerrado (esta entrada) |
| 6.3 — ingesta real | ⏸️ **no arrancada** — depende de A2 confirmado y necesita al usuario |

### Por qué la sesión autónoma se detiene acá, y no sigue con 6.3

El propio plan (`cheerful-gathering-feather.md` §6.3) reserva explícitamente la verificación contra
archivo real como checkpoint del usuario ("avisame cuándo necesités que corra `pnpm probar`"), y 6.3
además:
1. **Depende de que A2 esté confirmado contra Santander y Macro reales** — hoy solo está confirmado
   contra fixtures sintéticos (HANDOFF 23).
2. Necesita el **CUIT de los extractos reales** para determinar si Santander y Macro comparten titular
   — con la regla dura de que ese dato nunca puede pasar por el contexto de un agente ni quedar en un
   log (ADR-0002 §F.2.5, ya citada en el plan). Es exactamente la clase de operación que corresponde
   correr con el usuario presente, no en una sesión desatendida.
3. Es ingesta **real** contra la base del piloto — no un fixture, no un `pnpm test`.

**Nada de esto es una decisión que se pueda posponer con una convocatoria de agentes**: son archivos que
no están en el repo y una operación con datos reales de terceros. Se frena acá, con todo lo anterior
verificado, mergeado y documentado.

### Qué hace falta para retomar

1. **Confirmar A2 contra archivo real**: `pnpm probar --banco macro --archivo <ruta>` y
   `--banco galicia --archivo <ruta>` (las predicciones falsables completas están en HANDOFF 22), y la
   primera medición de `sinDestino` de Santander contra archivo real (nunca antes se corrió).
2. **6.1 real**: la migración `0011` corrió contra desarrollo, no contra el piloto — falta aplicarla ahí
   antes de 6.3.
3. **6.3**, los tres pasos del plan (`cheerful-gathering-feather.md` §6.3): determinar titularidad
   compartida (script descartable, solo booleano) → `alta-cuenta.ts` con el extracto más viejo de cada
   cuenta → `ingestar.ts` real contra el piloto → comparar conteos reales contra los medidos.

**Bancor sigue en pausa total, sin tocar.**

---

## 2026-08-11 (27) — 6.2, diseño ajustado tras la convocatoria (antes de implementar)

Los cuatro agentes convocados (HANDOFF 26) convergieron, independientemente, en que el plan original de
3 argumentos (`--estudio`, `--nombre`) **no alcanza contra el esquema real**. Ajustes al diseño, todos
con más de una fuente coincidiendo:

1. **Falta `--usuario <uuid>`** (arquitecto-software + security-engineer + dba-data, los tres). La
   policy `tenant_node_wr` exige `has_role_on(parent_id, [socio, admin_plataforma])` evaluado contra
   `app.current_user_id()` — sin un socio actuante bajo `conUsuario`, el insert no tiene cómo pasar RLS,
   y la salida fácil (`conJob`) saltearía el único control de autorización que existe para esta
   operación. Mismo patrón que `alta-cuenta.ts`.
2. **`escribirConAuditoria` no se puede usar tal cual**: el `cliente_id` a auditar no existe antes del
   insert que lo crea, y el trigger `exigir_nodo_cliente` lo exige preexistente. Resolución (propuesta
   por `arquitecto-software`, mismo criterio en `security-engineer`/`dba-data`): función nueva en
   `packages/data/src/tenancy/escrituras.ts` que hace el insert y **después**, misma transacción, llama
   `registrarAcceso` directo (no `escribirConAuditoria`) con el uuid recién creado — excepción
   documentada al orden "auditoría antes que escritura", con el motivo escrito en el código: acá el
   sujeto de auditoría no existe antes de la operación que lo crea.
3. **🔴 Hallazgo de `seguridad-datos-financieros`: nada en el esquema impide que un `cliente` cuelgue de
   otro `cliente`** (el `check` de `tenant_node` solo exige que el padre no sea null, no que sea
   `tipo='estudio'`). Confirmado por `security-engineer` y `dba-data` independientemente. **Alcance de
   esta tarea:** guard de aplicación (`select tipo, deleted_at from tenant_node where id=$estudio`,
   rechazar si no es `'estudio'` o está borrado) — no se toca la migración `0001` de tenancy, que está
   fuera del alcance declarado del plan (punto 1: "no cambia el modelo de tenancy en sí"). El trigger de
   esquema que lo cerraría de raíz (para cualquier vía de inserción futura, no solo este script) queda
   como deuda declarada — ver `docs/diseno/10-deuda-declarada.md` §1.7.
4. **`--nombre`**: Zod rechaza si matchea `RE_CUIT` (detector ya existente y auditado), largo máximo 60
   (mismo criterio que `alias` de `alta-cuenta.ts`). No cierra el vector del todo (nadie puede impedir
   que el operador tipee un nombre real igual) pero cubre el error más probable sin costo.
5. **Sin `unique(parent_id, nombre)`**: `nombre` no es clave de dominio (es la etiqueta provisoria que
   HANDOFF 11 ya dijo que se renombra sin tocar la fila). Un test confirma, en cambio, que dos altas con
   el mismo nombre producen dos uuid distintos — a propósito, no un bug.
6. Falta el servicio de escritura en `packages/data/src` (no existe ningún alta de `tenant_node` fuera
   de la siembra de tests, que bypassa RLS a propósito). Se crea `packages/data/src/tenancy/escrituras.ts`.

**Implementa `backend-dev`, con este diseño ya cerrado — no rediseña.**

---

## 2026-08-11 (26) — Plan 6.2 (CLAUDE.md §3.2, escrito antes del primer `Edit`)

**Herramienta:** Claude Code, sesión autónoma. Dispara modo plan por (a)/(b) — toca el modelo de
tenancy y aislamiento entre clientes.

1. **Qué cambia y qué no.** `apps/cli/src/alta-cliente.ts` (mismo directorio que `alta-cuenta.ts`, no
   `packages/data/scripts/` como dice el comentario desactualizado de ese archivo — se corrige de
   paso). Inserta un `tenant_node` con `tipo='cliente'` colgando del `estudio` existente. Recibe
   `--estudio <uuid>` y `--nombre "<etiqueta>"` — **nunca** un CUIT, nunca lo imprime. Imprime **solo**
   el uuid nuevo. **No cambia:** el modelo de tenancy en sí (ya está diseñado, HANDOFF entrada 11); no
   se toca `alta-cuenta.ts` salvo lectura de referencia de estilo.
2. **Qué se mide.** Test de integración: creación exitosa, unicidad razonable (no dos clientes
   idénticos por accidente, sin inventar una restricción que el modelo no pida), y que el uuid nuevo
   quede resoluble por `conUsuario` del socio del estudio (aislamiento correcto desde el primer
   momento).
3. **Predicción falsable.** Antes: el piloto tiene 1 cliente (`CLIENTE PILOTO 01`). Después de correr
   `pnpm alta:cliente` dos veces (Santander, Macro): 3 clientes, cada uno resoluble por `conUsuario`
   del socio del estudio, ninguno con CUIT en ninguna columna ni en la salida de stdout.
4. **Agentes.** `dba-data` + `arquitecto-software` (modelo de tenancy) + `security-engineer` +
   `seguridad-datos-financieros` — los cuatro, porque toca aislamiento entre clientes.
5. **Paso revertible más chico.** El script entero ya es la unidad atómica razonable: es un alta, no
   una migración de esquema — revertible borrando la fila (o, en el piloto, simplemente no
   usándola) sin tocar ninguna otra.

---

## 2026-08-11 (25) — 6.1 cerrado: catálogo de bancos poblado

**Herramienta:** Claude Code, sesión autónoma. Mergeado a `main` (`feat/catalogo-bancos`, `--no-ff`).

Migración `0011_catalogo_bancos.sql`, aplicada contra la base de desarrollo (no contra el piloto — eso
es 6.3). `dba-data` la escribió y verificó (`banco_r28` del fixture de tests intacto); `security-engineer`
y `seguridad-datos-financieros` revisaron en paralelo sin bloqueantes. Se incorporó una mejora
preventiva: advertencia explícita en el `comment on column banco.capacidades` contra meter ahí un dato
de ejemplo real (heredaría la clasificación N0 de la columna). `pnpm verificar`: 739+7, sin cambios.

**Sigue 6.2** (`pnpm alta:cliente`), con su propia convocatoria (`dba-data` + `arquitecto-software` +
`security-engineer` + `seguridad-datos-financieros` — toca el modelo de tenancy).

---

## 2026-08-11 (24) — Plan 6.1 (CLAUDE.md §3.2, escrito antes del primer `Edit`)

**Herramienta:** Claude Code, sesión autónoma. Dispara modo plan por (a) migración — obligatorio,
sin importar tamaño.

1. **Qué cambia y qué no.** `packages/data/migrations/00NN_catalogo_bancos.sql`: `insert ... on
   conflict (codigo) do nothing` para los tres códigos ya construidos (`galicia`, `santander`,
   `macro`) en la tabla `banco`. `galicia` hoy está insertada a mano en el piloto sin mecanismo
   reproducible — la migración la formaliza sin duplicarla. `capacidades` es `jsonb not null default
   '{}'` sin `check`, así que no hace falta mantenerla sincronizada con `CAPACIDADES_GALICIA/_MACRO/
   _SANTANDER`; entra un resumen informativo con un comentario explícito de que no es fuente de
   verdad. **No cambia:** ningún dato existente (es `on conflict do nothing`, no `update`). **No
   entra:** Bancor (pausa total) ni ningún banco de los cinco pendientes.
2. **Qué se mide.** La migración corre limpia contra una base nueva y contra el piloto (que ya tiene
   `galicia`) sin duplicar filas ni tocar la existente. `pnpm verificar` sigue verde.
3. **Predicción falsable.** Antes: piloto con 1 fila en `banco` (`galicia`). Después de correr la
   migración contra el piloto: 3 filas (`galicia` sin cambios, `santander` y `macro` nuevas). Si
   `galicia` cambia de fila (distinto uuid o algún campo) es un hallazgo — `on conflict do nothing`
   tiene que dejarla exactamente como está.
4. **Agentes.** `dba-data` + `security-engineer` + `seguridad-datos-financieros` — los tres,
   obligatorio por ser migración (CLAUDE.md §3.1).
5. **Paso revertible más chico.** La migración entera ya es la unidad atómica: un archivo SQL nuevo,
   revertible con una migración de baja (`delete where codigo in (...)`) si hiciera falta, sin tocar
   ninguna fila que no haya insertado ella misma.

---

## 2026-08-11 (23) — A2 cerrado en código: los cinco commits (C1-C5), mergeado a `main`

**Herramienta:** Claude Code. **Estado:** mergeado (`feat/destinos-alcance-completo`, `--no-ff`).
Sesión autónoma, sin intervención del usuario desde que arrancó D.

**Los cinco commits, cada uno verificado en verde antes del siguiente:**
- **C1+C2** — vocabulario (`DESTINOS_BASE`/`ConteoDeDestinos<D>`/`contarDestinos<D>` en `toolkit.ts`),
  contrato (`destinos?` en `SalidaDeAdaptador`, `declaraDestinos` en `CapacidadesAdaptador`, los
  **cuatro** sitios — el cuarto, `extracto-sintetico.ts`, no estaba en el plan original y lo encontró
  `backend-dev`). Santander migrado a lo genérico. 725+7 (refactor puro, 0 movido).
- **C3** — Macro instrumentado. `fueraDelCuerpo=0` como predecía el plan. 728+7 (+3).
- **C4** — Galicia instrumentado. Acá SÍ se movió un número a propósito: residuo bajó de 8 a 0 contra
  el fixture (carátula reclasificada a `fueraDelCuerpo`), auditado fila por fila antes de escribirlo.
  731+7 (+3). Code-reviewer recomendó `SalidaGalicia` como intersection (no alias) para no simular en
  runtime una garantía que TS da gratis — aplicado.
- **C5** — el gate (`verificarDestinos`, enganchado en `ingestar.ts`). Único commit que cambia
  veredictos de producción; convocatoria más estricta, 7 casos de qa-automation cada uno con mutante
  confirmado en vivo. Code-reviewer encontró que la genericidad `<D extends string>` escondía un cast
  inseguro — simplificado a tipado directo contra `DestinoBase`. 739+7 (+8).

**Convocatoria completa antes de tocar código**: `tech-lead` (conduce, definió el orden exacto de
commits) + `backend-dev` + `qa-automation` + `qa-funcional`, en paralelo, con reportes cruzados y
convergentes. `backend-dev` implementó C3/C4/C5 en tres convocatorias separadas (no todo junto), cada
una con `code-reviewer` sobre el diff antes de commitear — mismo patrón que A1.

### 🔴 Dos cosas pendientes, explícitas, NO resueltas en esta entrada

1. **La verificación contra archivo real (`pnpm probar`, 3 sittings, 6 comandos) es un checkpoint
   reservado para el usuario** — el plan lo marca así explícitamente ("avisame cuándo necesités que
   corra") y no se ejecutó en esta sesión. Las predicciones falsables completas (Macro, Galicia, y la
   primera medición de `sinDestino` de Santander contra archivo real) están en HANDOFF (22). **A2 no
   está confirmado contra datos reales todavía — solo contra fixtures sintéticos.**
2. **Caso borde en `galicia.ts` sin resolver**: un candidato de renglón de anexo sin aparear cae en
   `fueraDelCuerpo` en vez de `residuo` (ver `docs/diseno/10-deuda-declarada.md` §2.1). No ejercitado
   por ningún fixture ni por el archivo real medido hasta ahora. `code-reviewer` lo marcó como una
   decisión pendiente, no un bloqueante de C5. Queda para que el usuario decida si se resuelve antes de
   confiar en `fueraDelCuerpo` con datos reales o se acepta como hueco conocido.

**Sigue ítem 6** (catálogo `banco` + `alta:cliente` + ingesta real) — 6.1 y 6.2 no dependen de la
verificación real de A2 y se pueden avanzar en código; **6.3 sí depende** (ingesta real necesita saber
si A2 está confirmado contra los archivos reales de Santander/Macro antes de correr).

---

## 2026-08-11 (22) — Plan A2 (CLAUDE.md §3.2, escrito antes del primer `Edit`)

**Herramienta:** Claude Code, sesión autónoma. Dispara modo plan por (c) y (d). Diseño **ya integrado**
en el plan externo `cheerful-gathering-feather.md` §A2 — no se rediseña, se ejecuta.

1. **Qué cambia y qué no.** `ConteoDeDestinos<D>` genérico (tupla `as const`) en `toolkit.ts`, con
   `DESTINOS_BASE` (unión común de 7, la de Santander). Campo opcional `destinos` en
   `SalidaDeAdaptador` + `declaraDestinos: boolean` en `CapacidadesAdaptador`. `leerSantanderConDestinos`
   se borra: `leerSantander` devuelve el conteo en la salida. Migra **Macro primero** (instrumentación
   pura, residuo ya en 0, sin decisiones nuevas), **Galicia después** (mueve números, con el criterio
   posicional del plan). Gate de residuo como función nueva de lote. **No cambia:** el criterio de
   `absorber` en Galicia (§2.6, movería el mismo número y volvería la predicción no falsable — queda
   fuera de esta tanda). **No se persiste** el conteo esta tanda: llega al gate y al log, sin migración.
2. **Qué se mide.** `pnpm verificar` en verde con el conteo de tests que corresponda a cada commit.
   Contra archivo real: los conteos de línea de base ya escritos abajo, número por número — el criterio
   es la lista de conteos, no `VEREDICTO: cuadra`.
3. **Predicción falsable — ya escrita en el plan, se transcribe:**
   - **Macro** (`pnpm probar --banco macro`): esperado `sinDestino=0`, `residuo=0`,
     Σdestinos=filas.length, 1346/6/3 sin cambios. `sinDestino>0` = hallazgo real. `fueraDelCuerpo>0` =
     mapeo mal hecho (en Macro toda la carátula tiene regla escrita). `residuo>0` o los conteos de
     mov/anexos se mueven = la instrumentación cambió comportamiento, revertir.
   - **Galicia** (`pnpm probar --banco galicia`): esperado `residuo=0`, `fueraDelCuerpo=29`,
     `sinDestino=0`, 326/9 sin cambios (las 29 eran carátula y legales). `residuo=N>0` con
     `fueraDelCuerpo=29−N` = hallazgo real, N filas sin explicar. `residuo+fueraDelCuerpo≠29` = el total
     se movió, la diferencia es el hallazgo.
   - Línea de base completa (no se puede mover sin explicación): Galicia 326 mov / 9-9 anexos / residuo
     29 (hoy, antes de instrumentar). Santander 158 / 7-7 / residuo 5 — primera vez que se mide
     `sinDestino` de Santander contra archivo real. Macro 1346 / 6-6 / residuo 0. INV-13=0, INV-14=0,
     hashes únicos = total, en los tres.
4. **Agentes.** `tech-lead` (conduce) + `backend-dev` + `qa-automation` + `qa-funcional`.
5. **Paso revertible más chico.** C1+C2 (vocabulario + contrato + borrar `leerSantanderConDestinos`)
   es el commit más chico que ya vale la pena: deja todo listo sin mover un número, 100% revertible.
   C3 (Macro) y C4 (Galicia) son aditivos y mutuamente independientes (el campo es opcional) — cada uno
   su propio commit dentro de la misma rama. C5 (gate) es el único que cambia veredictos de producción;
   revertirlo vuelve exactamente al estado de hoy.

**Checkpoint que necesita al usuario, no una convocatoria de agente:** C3 y C4 se verifican contra
archivo real con `pnpm probar` — 3 sittings, 6 comandos (el plan lo marca explícitamente: *"avisame
cuándo necesités que corra `pnpm probar`"*). Se implementa y se verifica con `pnpm test`/`pnpm verificar`
(fixtures sintéticos) hasta ese punto; la corrida contra el archivo real queda señalada para el usuario,
no se ejecuta sola.

---

## 2026-08-11 (21) — A1 cerrado: contrato unificado de adaptadores

**Herramienta:** Claude Code. **Estado:** mergeado a `main` (`fix/contrato-unificado-adaptadores`,
`--no-ff`). Sesión autónoma, sigue sin intervención del usuario.

**Plan escrito en HANDOFF (20) antes del primer `Edit`**, tal como exige la Parte D recién cerrada.
Convocados `arquitecto-software` + `tech-lead` (diseño, antes de tocar código) y `code-reviewer`
(diff final, antes de mergear) — los tres con `TaskCreate`/`addBlockedBy` bloqueando la
implementación.

**Dos hallazgos de los agentes que cambiaron la implementación respecto del plan original:**
1. `arquitecto-software`: `packages/ingesta/src/index.ts` re-exporta los adaptadores **por nombre
   explícito** (no `export *`, por la colisión de `BANCO_CODIGO`/`VERSION` entre bancos ya
   documentada ahí) y nombraba literalmente `EntradaGalicia`/`EntradaMacro` — sin ajustarlo, el build
   no compila al borrar esos tipos.
2. Los dos agentes de diseño, independientemente: la regla de código tal como estaba redactada en el
   plan ("ningún archivo declara `Salida*`/`Entrada*` propio") se **auto-rompe** contra el propio
   diseño de A1, porque `SalidaGalicia`/`SalidaMacro` siguen existiendo a propósito como fachada del
   contrato. Se redactó contra el **lado derecho** de la declaración en vez del nombre.

**Implementado:** `EntradaGalicia`/`EntradaMacro` borrados; `SalidaGalicia` → alias de
`SalidaDeAdaptador`; `SalidaMacro` → intersection type; comentario nuevo en `registro.ts` con las
tres formas posibles de relacionarse con el contrato; `index.ts` ajustado; regla nueva en
`reglas-de-codigo.test.ts` **probada por mutación a mano** (reintroduje un tipo paralelo en
`galicia.ts`, confirmé que el test cae con el mensaje esperado, revertí); de paso, `code-reviewer`
encontró y `String.raw` corrigió un regex sin escapar en la regla de aislamiento entre bancos ya
existente (bug real, confirmado con Node, sin impacto práctico medido hasta ahora).

**Verificado contra la predicción falsable del plan:** `pnpm verificar` → **725 tests + 7 todo**
(era 724+7, **+1 exacto** por la regla nueva, 0 tests rotos) — la predicción del punto 3 del plan se
cumplió tal cual. Barrido estricto: 0 fugas. `docs/diseno/10-deuda-declarada.md` §2.4 marcado
resuelto.

**Sigue A2** (destinos, los tres pasos — diseño ya integrado en el plan externo
`cheerful-gathering-feather.md`), con su propia convocatoria (`tech-lead` conduce + `backend-dev` +
`qa-automation` + `qa-funcional`) antes de tocar `toolkit.ts`/`macro.ts`/`galicia.ts`.

---

## 2026-08-11 (20) — Plan A1 (CLAUDE.md §3.2, escrito antes del primer `Edit`)

**Herramienta:** Claude Code, sesión autónoma. Dispara modo plan por (c) y (d): modifica adaptadores
que ya corren contra datos reales, y toca 4+ archivos.

1. **Qué cambia y qué no.** `EntradaGalicia`/`EntradaMacro` se borran (idénticas carácter a carácter
   al contrato). `SalidaGalicia` pasa a `export type SalidaGalicia = SalidaDeAdaptador`.
   `SalidaMacro` pasa a intersection type (`SalidaDeAdaptador & { consolidadosPorMoneda, cuentasDeclaradas
   requeridos }`), no tipo paralelo. Regla nueva en `reglas-de-codigo.test.ts`: ningún archivo de
   `adaptadores/` declara `Salida*`/`Entrada*` propio. **No cambia:** `santander.ts` (ya usa el
   contrato), ni el comportamiento de lectura de ningún banco — es un cambio de tipos, no de runtime.
   **No entra A2** (destinos) en esta parte — depende de que la regla de código de A1 exista primero.
2. **Qué se mide.** `pnpm verificar` en verde, con el mismo conteo de tests **+1** (la regla nueva) y
   0 tests rotos. Barrido de fuga en modo estricto: 0 fugas (no cambia dato sensible).
3. **Predicción falsable.** Si `SalidaMacro` como intersection sigue exigiendo
   `consolidadosPorMoneda`/`cuentasDeclaradas` no-opcionales, los tests existentes de `macro.test.ts`
   no deberían cambiar de resultado — 0 tests de Macro rotos. Si alguno se rompe, el estrechamiento no
   es fiel al comportamiento real del adaptador y hay que revisar el diseño, no forzar el tipo.
4. **Agentes.** `arquitecto-software` + `tech-lead` (diseño, antes de tocar código — límite entre
   módulos y ≥2 implementaciones del mismo patrón) + `code-reviewer` (sobre el diff final, antes de
   mergear).
5. **Paso revertible más chico.** El commit único (borra Entradas + reemplaza Salidas + agrega la
   regla) ya es la unidad atómica razonable: separar "borrar Entradas" de "reemplazar Salidas" dejaría
   un estado intermedio con imports rotos, sin beneficio. Es revertible con `git revert` sin efecto en
   runtime — los tipos no existen en tiempo de ejecución.

---

## 2026-08-11 (19) — Parte D cerrada: modo plan obligatorio en CLAUDE.md §3.2 + AGENTS.md §6

**Herramienta:** Claude Code. **Estado:** mergeado a `main` (`feat/modo-plan-obligatorio`, `--no-ff`),
sesión autónoma (usuario ausente, instrucción explícita de avanzar D → A1 → A2 → 6 sin pedir más
confirmación salvo bloqueante real).

**Registro de sub-agentes, resuelto de verdad esta vez.** HANDOFF (18) §0 dejó abierta la hipótesis de
que el harness cachea `.claude/agents/` al arrancar el proceso. Encontrada la causa real: 12 de los 23
wrappers tenían `": "` sin comillar dentro de `description:` del frontmatter — YAML plano no lo admite
sin romper el parseo. Comillado en los 12 (`.claude/agents/` y `agents/wrappers-claude/`), confirmado
en una sesión nueva: **los 23 registran**. Detalle completo en `agents/README.md` §"Registro runtime
vs. disco". Commit `fix/registro-subagentes-yaml`, mergeado antes de esta parte.

**Convocados de verdad, con `TaskCreate`/`addBlockedBy` bloqueando la implementación:** `product-owner`
y `documentador`, en paralelo, antes de escribir una línea de la regla.

- `product-owner` **ajustó el umbral de tres disparadores a cuatro**: agregó "(c) modifica un
  adaptador/motor/consulta que ya corre contra datos de un cliente o en producción, sin importar
  cantidad de archivos" — con el caso real y medido de `galicia.ts` (HANDOFF 17§4/18§3, truncado
  silencioso de razón social, 814/1346 filas) como evidencia de que el umbral de 3+ archivos solo
  dejaba pasar exactamente ese tipo de cambio. También agregó una válvula de escape para el disparador
  de "3+ archivos" (cambios puramente mecánicos no lo disparan) y marcó qué campos del plan son
  no-negociables (1, 2 y 4) y cuáles se pueden resolver en una línea (3 y 5, con "no hay baseline, se
  mide en el paso 1" como respuesta válida al campo 3).
- `documentador` fijó la ubicación (`CLAUDE.md §3.2`, entre §3.1 y §4; `AGENTS.md §6`, después de §5) y
  el mecanismo de trazabilidad para Codex: el plan tiene que existir **escrito en `HANDOFF.md` antes**
  del primer `apply_patch`/`Edit`, mismo criterio inspeccionable que el banner `=== [Persona] ===` de
  `AGENTS.md` §5.

**Verificación:** `pnpm verificar` no se re-corrió en esta parte (cambio de solo documentación, sin
código); el barrido de fuga en modo estricto corrió como parte del pre-commit hook de los dos commits
(YAML + Parte D) y dio `0 fugas` las dos veces.

**Sigue A1** (contrato unificado), con su propia convocatoria (`arquitecto-software` + `tech-lead` +
`code-reviewer`) antes de tocar `galicia.ts`/`macro.ts`.

---

## 2026-08-10 (18) — CI arreglado, módulo de detectores centralizado, `galicia.ts` sin truncado, Parte B cerrada

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **724 tests + 7 todo**, 25 archivos.
Barrido en modo estricto: **0 fugas**. Barrido en modo CI (`BARRIDO_FORZAR_CI=1`): **exit 0**. **Sin
commits ni push** (no se pidió). Todo en el working tree, rama `fix/quinta-cara-limites-hermanos`.

### 0. El reinicio de sesión no resolvió el registro de sub-agentes

Seguían **11 de 23** registrados (los mismos 11 de antes del roster técnico) — la hipótesis con más
evidencia es que el harness cachea el índice de `.claude/agents/` al arrancar el **proceso**, no al abrir
una conversación nueva, y hace falta un reinicio real del proceso o `/agents` para forzar el rescan.
Verificado: los 23 archivos tienen frontmatter válido, no hay `.claude/settings.json` con un límite. Se
trabajó igual con el fallback de persona adoptada (`agents/README.md`, `CLAUDE.md` §3.1 punto 6) para los
12 faltantes, con convocatoria real por `TaskCreate`/`TaskUpdate` bloqueando cada implementación — 7
agentes convocados en paralelo antes de tocar código (devops, seguridad-datos-financieros ×2 rondas,
security-engineer, tech-lead, backend-dev, qa-funcional, qa-automation), más `code-reviewer` sobre el diff
final.

### 1. CI de `main`, arreglado — causa raíz confirmada, no allowlist a ciegas

Era lo de HANDOFF (17) §3: el detector `corrida_larga` (commit `f2d4464`) generó 20 candidatos que
`tools/barrido-aceptados.json` nunca cruzó. `devops` confirmó que los 20 son sintéticos y que el camino
correcto es regenerar la allowlist (hay precedente idéntico, commit `2552644`) y no ampliar `PERMITIDOS`
(reservado a meta-tests del redactor, no a fixtures generales). `pnpm barrido --aceptar` corrido en esta
máquina; diff puramente aditivo (12 huellas nuevas, ninguna removida).

### 2. Módulo centralizado de detectores — `packages/shared/src/seguridad/detectores-forma.ts`

CBU, CUIT, documento (DNI) y corrida-larga, importados por `redactar.ts` **y** `packages/ingesta/src/glosa.ts`
(antes cada uno tenía su copia, ya divergentes). Tres hallazgos que cambiaron el diseño respecto del plan
inicial:

1. 🔴 **`seguridad-datos-financieros` probó en vivo que el estilo lookaround de `glosa.ts`
   (`(?<![\d-])...(?![\d-])`) es el que tiene el agujero, no el `\b` de `redactar.ts`**: un CBU pegado a un
   guión (`REF-999...`) no matcheaba NINGUNO de los 4 patrones de `glosa.ts`. Se unificó hacia `\b` para
   los detectores de longitud fija (CBU/CUIT/documento), y el lookaround-que-excluye-separadores quedó solo
   para el catch-all de longitud variable. Esto **corrigió** la recomendación inicial de `tech-lead` (que
   sugería el camino contrario).
2. **DNI (7-8 dígitos) se agregó al redactor** — antes `redactarTexto('DNI 1234567...')` no tapaba nada,
   el mismo hueco que motivó Parte 0. `backend-dev` había recomendado NO agregarlo (rompía un test viejo
   cuya premisa —"el piso es 9, igual que en glosa.ts"— ya era falsa). Se tomó la decisión de cerrarlo de
   todos modos, por el pedido explícito del usuario y por ser exactamente el hallazgo de HANDOFF (17) §5; el
   test viejo se corrigió, no se preservó.
3. 🔴 **Separadores en el DNI rompieron algo real, medido en vivo, no en teoría**: la primera versión le
   agregaba separadores comunes al DNI igual que al CBU, y `tools/barrido-fuga.ts` en modo estricto encontró
   **34 falsos positivos** — el importe canónico (`10000.00`: 5 dígitos + punto + 2 decimales) matchea el
   mismo patrón que un DNI de 7 con un punto adentro. Se corrigió: **separadores solo en CBU**, el DNI queda
   sin ellos (residuo declarado, con test que lo deja medido en
   `packages/ingesta/tests/detectores-compartidos.test.ts`). Ningún agente de la convocatoria detectó esto
   de antemano — apareció al correr el barrido después de aplicar el cambio, y es la prueba de que
   `pnpm verificar` + `barrido` en modo estricto son el control real, no la revisión de diseño.

Test nuevo `detectores-compartidos.test.ts` (38 casos): paridad estructural (mismo `.source`/`.flags` +
lista pineada de nombres de detectores en los dos archivos — agregar un detector nuevo en uno solo rompe
el test) + barrido de comportamiento por longitud de dígitos (1 a 25) comparando `contieneDatoSensible`
contra `contieneIdentificador`. Diseño de `qa-automation`.

### 3. `galicia.ts` — truncado silencioso de la razón social, corregido

`leerTitular` tomaba un solo fragmento (`fragmentos[indiceEtiqueta - 1]`) como razón social; si viniera
partida en 2+ fragmentos (medido en Macro: 814/1346 filas en 3 fragmentos), se perdía todo menos el
último, sin error. Ahora `razonSocialAntesDe` fusiona fragmentos contiguos caminando hacia la izquierda,
cortando en el primer hueco geométrico grande (`HUECO_MAXIMO_ENTRE_FRAGMENTOS_DE_RAZON_SOCIAL = 8`, 🔴 sin
medir contra un archivo real) o el primer fragmento con dígitos — nunca por banda de `x` (esa vía ya
rompió este mismo campo una vez, documentado en `09-lecciones-aprendidas.md` §1). Dos tests nuevos en
`galicia.test.ts`: razón social partida sola, y partida + columna vecina real en la misma fila (control
cruzado de que la fusión no se pasa de largo). `leerTitular` también dejó de reimplementar la ubicación de
la etiqueta y pasó a reusar `buscarIgnorandoAcentos` (ahora exportada de `toolkit.ts`).

### 4. Resto de Parte B, los 5 pares — cerrados

- **`santander.ts`**: `RE_CBU`/`RE_CUIT` locales sin `\b` → reemplazados por los del módulo compartido
  (mismo bug que ya se había corregido en `alta-cuenta.ts` y `galicia.ts`, sin propagar).
- **Ventana de búsqueda de CBU/CUIT en Santander**: antes sobre el documento entero, ahora acotada a
  `FILAS_DE_CARATULA = 200` (mismo valor que ya usa `reconoceSantander`) — mismo riesgo que Galicia ya
  documentaba para el mismo dato (la glosa de una transferencia puede traer `CBU` seguido del CBU de la
  contraparte).
- **`alta-cuenta.ts`**: el patrón del número de cuenta ahora ancla `^...$`, igual que
  `leerNumeroDeCuenta` de Galicia (mismo formato de archivo).
- **`barrido-fuga.ts`**: `.flags.replace('g', '')` (tapaba `g`, dejaba pasar `y`) reemplazado por
  `sinEstado` importado de `packages/shared` — la misma función que ya vivía en `toolkit.ts`, ahora en un
  solo lugar para los dos.
- **Cola de anexo (Macro vs. Santander)**: `tech-lead` confirmó que es **justificado dejarlas separadas**
  (mecánicas de apareo genuinamente distintas) — se documentó la decisión en la tabla de veredictos de
  `toolkit.ts` en vez de forzar una abstracción con dos casos que ya divergen.

### 5. Verificado, no solo ejecutado

`pnpm verificar` completo en verde dos veces (antes y después de la corrección del punto 2.3). Barrido
estricto: 0 fugas. Barrido CI: exit 0, allowlist regenerada dos veces (task 1, y de nuevo después de
agregar el módulo — 79 huellas en total, todas aditivas).

`code-reviewer` convocado sobre el diff final completo (14 archivos, +551/−54) antes de dar esto por
cerrado. Encontró **dos hallazgos reales, los dos corregidos antes de cerrar**:

1. **`galicia.ts` seguía con `RE_CUIT_DEL_TITULAR` local, sin `\b` ni prefijo validado** — exactamente lo
   que `tech-lead` había recomendado migrar al módulo compartido (igual que `santander.ts`), y que quedó
   afuera del diff por un olvido al aplicar los cambios de Parte B. Corregido: ahora importa `RE_CUIT` de
   `detectores-forma.ts`, igual que el resto.
2. **`indiceEtiqueta` en `leerTitular` busca la etiqueta dentro de un ÚNICO fragmento**, mientras que
   `documento` (vía `valorPorEtiqueta`) la busca sobre la línea ya unida — así que si la etiqueta viniera
   partida en 2+ fragmentos, `razonSocial` quedaría `null` en vez de leerse. No hay caso real medido que lo
   ejercite hoy (`pnpm probar --caratula` mide un solo fragmento), así que no se forzó un fix especulativo:
   queda declarado con un comentario 🔴 medido, mismo estilo que el resto de los residuos de esta rama.

Gate completo re-corrido después de las dos correcciones: sigue verde (724 + 7 todo, 0 fugas, CI exit 0).

### 6. Qué falta para retomar: D, A1, A2, ítem 6

El plan vigente (`cheerful-gathering-feather.md`, fuera del repo) sigue en el mismo punto que dejó
HANDOFF (17) §1: con Parte 0 y Parte B cerradas, sigue **D** (modo plan obligatorio) → **A1** (contrato
unificado) → **A2** (destinos, 3 pasos) → **6** (catálogo `banco` + `alta:cliente` + ingesta real). Cada
una necesita su convocatoria propia (`TaskCreate` con la tarea de convocar bloqueando la de implementar,
mismo mecanismo que esta entrada). Bancor (Parte C) sigue en pausa total.

---

## 2026-08-10 (17) — 🔴 **PUNTO DE ENTRADA SI RETOMÁS SIN EL CHAT.** Corrección de proceso a mitad de
ejecución del plan, con dos hallazgos reales sin corregir todavía. **Se viene un reinicio de sesión.**

**Herramienta:** Claude Code. **Estado:** trabajo **detenido a propósito** antes de tocar D/A1/A2/ítem 6.
Rama activa `fix/quinta-cara-limites-hermanos`, con cambios sin commitear. `main` tiene una regresión de
CI **sin corregir** (ver §3). **Sin push.**

### 0. Qué es esto y por qué existe

El usuario detectó que ejecuté Parte 0 (fuga del redactor) y arranqué Parte B (barrido de límites) **sin
convocar al panel** que `CLAUDE.md` §3.1 exige como regla dura — la misma falla del Módulo 1, repetida en
la sesión que escribió `10-deuda-declarada.md` sobre esa falla. Se paró todo, se hizo una revisión
retroactiva con `code-reviewer` + `seguridad-datos-financieros`, y **los dos encontraron problemas
reales** en el trabajo hecho sin panel. Antes de reiniciar la sesión (para intentar que el harness
registre los 23 sub-agentes en vez de 11), el usuario pidió dejar todo escrito acá. Es lo que sigue.

### 1. El plan vigente

`C:\Users\Juan Pàblo Marchini\.claude-personal\plans\cheerful-gathering-feather.md` (fuera del repo, en
el directorio de planes del usuario). Aprobado completo, 6 partes: **0** (fuga redactor) → **B** (barrido
quinta cara) → **D** (modo plan obligatorio) → **A1** (contrato unificado) → **A2** (destinos, 3 pasos) →
**6** (catálogo `banco` + `alta:cliente` + ingesta real de Santander/Macro al piloto, con **6.1/6.2/6.3**).
Bancor (Parte C) queda **en pausa total, sin excepción**, hasta confirmación aparte del usuario.

### 2. El mecanismo de convocatoria mecánica — YA ESCRITO en `CLAUDE.md` §3.1 punto 6 y `AGENTS.md` §5

Redacción **aprobada como definitiva** por el usuario. Resumen: toda tarea de la matriz de convocatoria
se crea **junto con** una tarea `convocar <agente> para <tarea>` por cada agente de la fila, con
`addBlockedBy` sobre la tarea de implementación. La de implementación no arranca (no `Edit`/`Write`)
mientras la de convocatoria siga `pending`. Se marca `completed` sólo tras una llamada real a `Agent()`.

🔴 **Pregunta que el usuario hizo y que quedó resuelta, ya incorporada al texto de CLAUDE.md**: el
fallback de la regla 4 (persona adoptada cuando el sub-agente no está registrado) **sí** satisface el
gate, porque sigue siendo un `Agent()` separado (`subagent_type: general-purpose` con el prompt de
adopción) — probado dos veces en esta corrección, las dos con hallazgos independientes reales. Lo que
**NO** satisface el gate es narrar `=== [Persona] ===` dentro de la propia respuesta sin invocar `Agent()`
— eso es el protocolo de Codex (una sola herramienta), no el de Claude Code. Está escrito así,
explícitamente, en `CLAUDE.md` §3.1 punto 6.

⚠️ **`CLAUDE.md` y `AGENTS.md` tienen este texto en el WORKING TREE, sin commitear**, sobre la rama
`fix/quinta-cara-limites-hermanos` (junto con los cambios de `galicia.ts`, ver §4). No se perdió nada:
`git status` lo confirma. Falta commitearlo — puede ir en el mismo commit que cierre el resto de Parte B,
o en uno propio si se prefiere separarlo.

### 3. 🔴 Hallazgo BLOQUEANTE, verificado, SIN CORREGIR: `main` tiene el gate de CI roto ahora mismo

El commit `f2d4464` (ya mergeado a `main` vía `f2d8cf6`, Parte 0) agregó el detector `corrida_larga` a
`DETECTORES` en `packages/shared/src/seguridad/redactar.ts`. Ese mismo array lo reusa
`tools/barrido-fuga.ts` para barrer **todo el repo**, no sólo logs. En modo estricto (con `privado/`
presente, como en esta máquina) el barrido cruza contra el material real y da verde. **En modo CI (sin
`privado/`) compara contra `tools/barrido-aceptados.json`, que nunca se regeneró con el detector nuevo.**

Verificado en vivo:
```
BARRIDO_FORZAR_CI=1 node tools/barrido-fuga.ts
  → 20 candidato(s) SIN VERIFICAR, exit code 1
```
Los 20 son literales de fixtures sintéticos (`galicia.test.ts`, `macro.test.ts`, `multibanco.test.ts`,
`aislamiento-modulo-1.test.ts`, `seed/texto-extracto-sintetico.ts`, `forma.ts`, `hmac-identificador.ts`) —
no hay dato real entre ellos, es puramente que la allowlist quedó vieja. `git log -- tools/barrido-aceptados.json`
confirma: el último commit que la tocó es `2552644`, **anterior** a `f2d4464`.

**Sin corregir todavía.** Dos caminos, a decidir cuando se retome (recomendación de `code-reviewer`):
regenerar con `pnpm barrido --aceptar` en esta máquina (tiene `privado/`) y commitear la allowlist nueva,
**o** acotar el detector para que no dispare sobre literales de test/seed que el barrido ya sabe que son
inocuos (ver `motivoPermitido()` / `PERMITIDOS` en `tools/barrido-fuga.ts:530` — existe un mecanismo de
exención por ruta, no evaluado todavía si aplica acá).

### 4. Hallazgo IMPORTANTE, verificado, SIN CORREGIR: `galicia.ts` puede truncar la razón social en silencio

Cambio sin commitear en `packages/ingesta/src/adaptadores/galicia.ts` (+32/−4) y su test (+34) en la rama
`fix/quinta-cara-limites-hermanos`. `leerTitular()` ahora toma **un solo fragmento**
(`fragmentos[indiceEtiqueta - 1]`) como razón social, en vez de todo el prefijo de texto de la fila (que
sí tenía el bug real: se colaba una columna vecina). Pero `code-reviewer` midió que el propio toolkit del
proyecto (`texto-pdf.ts:201-202`) documenta que un campo de texto libre en la misma columna puede venir
**partido en 1 a 4 fragmentos por fila** (medido en Macro: 814 de 1346 filas con 3 fragmentos). Si la
razón social de un cliente futuro viene partida en 2+ fragmentos, `fragmentos[indiceEtiqueta - 1]` toma
sólo el último pedazo — sin error, sin campo ausente, un titular incompleto persistido en silencio.

Segundo hallazgo, MENOR, del mismo diff: `leerTitular()` reimplementa la ubicación de la etiqueta
(`f.texto.toUpperCase().includes(...)`) en vez de reusar la posición que `valorPorEtiqueta` ya resolvió
(con normalización de acentos). Dos caminos que pueden divergir si la etiqueta alguna vez viene partida.

**Sin corregir todavía.** Falta: decidir si se extiende a fusionar fragmentos contiguos (como
`fragmentosEnBanda` ya hace para la descripción de Macro) o se acepta el riesgo con un test que lo deje
medido; y agregar el caso de test de razón social en 2 fragmentos, que hoy no existe (sólo está el de
columna vecina).

### 5. Hallazgo ALTA, verificado, SIN CORREGIR: el redactor sigue sin detector de DNI (7-8 dígitos)

De `seguridad-datos-financieros` (persona adoptada), verificado por mí con node antes de reportarlo:
```
redactarTexto('Key (titular_documento)=(12345678) already exists.') → detectores: []
redactarTexto('DNI 1234567 no encontrado')                          → detectores: []
```
Es la MISMA clase de fuga que motivó Parte 0 (dato N2R de un tercero pasa entero a los logs), y lo más
grave: `packages/shared/src/seguridad/clasificacion-campos.ts:660-663` **ya documentaba este hueco
exacto** desde una sesión anterior — *"el detector de CUIT exige prefijo... y no hay ningún detector de
DNI"*— pero sólo se cerró por CLAVE (agregando `titular_documento`/`dni` a la lista de claves
prohibidas), nunca por FORMA en `redactarTexto`. `glosa.ts:80` sí tiene el detector de 7-8 dígitos
(`documento`) desde antes; nunca se propagó al redactor compartido.

Segundo hallazgo, MEDIO/MENOR, confirmado por **los dos agentes independientemente**: el catch-all de
9+ dígitos está **copiado literal** en `redactar.ts:121` y `glosa.ts:92`, sin constante compartida ni
test que impida que diverjan — la misma clase de duplicación que causó la fuga que Parte 0 cerró.

Hallazgo BAJA/informativo, explícitamente no urgente: DNI o CBU con separadores (`"12.345.678"`,
`"0070 0123 40 0000 1234567 8"`) tampoco se detectan hoy — ni antes ni después de este fix. La
recomendación del agente es una **decisión explícita** (documentar el residuo o abrirlo como ítem
propio), no dejarlo implícito. No requiere solución ya.

**Sin corregir todavía.** El fix pendiente: (a) extraer el patrón de 9+ y agregar uno de 7-8 a un módulo
compartido de `packages/shared/src/seguridad/` importado desde `glosa.ts` **y** `redactar.ts` — cierra a
la vez el hueco de DNI y la duplicación; (b) test nuevo en `redactor.test.ts` con el patrón de
`inv13-glosa.test.ts` (app y redactor rechazan el MISMO conjunto) pero sobre texto **crudo**, no
depurado; (c) documentar el residuo de formatos con separador como decisión escrita, no como olvido.

### 6. `TaskList` — snapshot exacto al momento de escribir esto (por si no sobrevive al reinicio)

```
#1  [completed]   Parte 0 — fuga del redactor
#2  [in_progress] Parte B — barrido de la quinta cara            [blocked by #9, #10, #11]
#3  [pending]     Parte D — modo plan obligatorio                [blocked by #12]
#4  [pending]     A1 — contrato unificado                        [blocked by #13]
#5  [pending]     A2 — destinos, los tres pasos                  [blocked by #14]
#6  [pending]     Ítem 6.1 — migración catálogo banco             [blocked by #15]
#7  [pending]     Ítem 6.2 — script alta:cliente                  [blocked by #16]
#8  [pending]     Ítem 6.3 — ingesta real Santander/Macro         [blocked by #17]
#9  [completed]   Revisión retroactiva: code-reviewer (Parte 0 + galicia.ts)
#10 [completed]   Revisión retroactiva: seguridad-datos-financieros (Parte 0 + galicia.ts)
#11 [pending]     Convocar: resto de Parte B (security-engineer + seguridad-datos-financieros +
                  qa-automation + tech-lead)
#12 [pending]     Convocar: Parte D (product-owner + documentador)
#13 [pending]     Convocar: A1 (arquitecto-software + tech-lead + code-reviewer)
#14 [pending]     Convocar: A2 (tech-lead + backend-dev + qa-automation + qa-funcional)
#15 [pending]     Convocar: Ítem 6.1 (dba-data + security-engineer + seguridad-datos-financieros)
#16 [pending]     Convocar: Ítem 6.2 (dba-data + arquitecto-software + security-engineer +
                  seguridad-datos-financieros)
#17 [pending]     Convocar: Ítem 6.3 (seguridad-datos-financieros)
```

**#9 y #10 quedan `completed` pero sus hallazgos NO están corregidos** — ver §3, §4, §5. Antes de marcar
Parte B (#2) como para retomar, hay que decidir: ¿los hallazgos de #9/#10 son parte de "cerrar Parte 0
correctamente" (un fix nuevo, en su propia rama, sobre `main`) o se atienden como parte de #11 (que ya
convoca a `seguridad-datos-financieros` de nuevo para el resto de Parte B)? Mi lectura: son parte de
cerrar Parte 0 primero, porque `main` está roto para CI ahora mismo — no deberían esperar al resto de
Parte B.

### 7. Estado exacto de git

- `main`: `f2d8cf6` (merge de Parte 0) es el HEAD. **CI roto** (ver §3). Nada de Parte B llegó a `main`.
- Rama activa: `fix/quinta-cara-limites-hermanos`, creada después del merge de Parte 0.
- Sin commitear en esa rama: `CLAUDE.md`, `AGENTS.md` (mecanismo de convocatoria, §2 de esta entrada),
  `packages/ingesta/src/adaptadores/galicia.ts` y `packages/ingesta/tests/galicia.test.ts` (fix de razón
  social con el hallazgo de §4 sin resolver todavía).
- De los 6 pares de Parte B, sólo el de la razón social (galicia↔macro) tiene un intento escrito. Los
  otros 5 (CBU santander, CUIT lookarounds, número de cuenta `alta-cuenta.ts`, flags `barrido-fuga.ts`, y
  los dos de alcance CBU/CUIT-ventana-completa y cola-de-anexo-macro) **no se tocaron**.

### 8. Qué falta para retomar, en orden

1. **Si esto se lee después de un reinicio de sesión**: verificar cuántos de los 23 sub-agentes están
   registrados ahora (antes eran 11 de 23 — ver `agents/README.md` y probar con el Agent tool). Si siguen
   sin estar todos, el fallback de persona adoptada sigue siendo válido (§2 de esta entrada).
2. Cerrar el hallazgo del §3 (allowlist / CI roto en `main`) — es lo más urgente, `main` está roto.
3. Cerrar los hallazgos del §4 y §5 (galicia.ts + redactor), en la misma rama `fix/quinta-cara-limites-hermanos`
   o en una nueva — a decidir.
4. Recién ahí, retomar el resto de Parte B (tarea #2, bloqueada por #11 — que sigue pendiente de
   convocar).
5. `pnpm verificar` tiene que volver a dar verde (línea de base: **687** tests + 7 todo, después de
   Parte 0) y `BARRIDO_FORZAR_CI=1 node tools/barrido-fuga.ts` tiene que dar exit 0 antes de dar por
   cerrado nada de esto.

---

## 2026-08-10 (16) — 🔴 Roster técnico completo, y la auditoría que encontró lo que el gate verde no veía

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **673 tests + 7 todo = 680** (venía de
638). **Sin commits ni push** (pedido explícito). Todo queda en el working tree.

> **Lo que hay que leer antes de retomar:** `docs/diseno/10-deuda-declarada.md` (nuevo) — lo que las tres
> auditorías encontraron y **no** se corrigió, con el motivo de cada postergación. Tiene tres ítems que
> hay que cerrar **antes de escribir el cuarto banco**.

### 1. El roster pasó de 11 a 23 personas

Se dieron de alta las **12 técnicas** que faltaban: `product-owner`, `analista-funcional`,
`arquitecto-software`, `tech-lead`, `ux-designer`, `backend-dev`, `frontend-dev`, `dba-data`, `devops`,
`qa-funcional`, `qa-automation`, `security-engineer`. Cada una con su persona, su wrapper y su copia en
`.claude/agents/`. Las 11 anteriores conservan su contenido intacto: **solo se reescribió el campo
`description`** para que sirva de regla de ruteo.

🔴 **`security-engineer` y `seguridad-datos-financieros` NO se solapan y ante datos de clientes se
convocan LOS DOS.** El primero pregunta *"¿por dónde se entra y por dónde sale?"*; el segundo, *"¿qué
dato es sensible en ESTE negocio?"*. Un control impecable sobre el nivel de clasificación equivocado no
sirve, y una clasificación correcta sin control tampoco.

**La delegación quedó escrita como regla, no como sugerencia:** `CLAUDE.md` §3.1 tiene la matriz
`tipo de tarea → agentes que se convocan SIEMPRE`, más las cinco reglas de cómo se convoca (incluida:
🔴 **`privado/` está prohibido para todo agente**). `agents/README.md` y `AGENTS.md` sincronizados.

### 2. Por qué la regla está escrita así: la auditoría del Módulo 1

El Módulo 1 se construyó **sin este roster**. Al darlo de alta y auditar lo ya hecho —punto por punto
contra ADR-0001 §5 y ADR-0002— con el gate en verde, apareció esto:

| Hallazgo | Severidad | Dónde quedó |
|---|---|---|
| **Ambigüedad PERMANENTE de cuenta**: nada impedía dos identificadores vigentes, y a partir de ahí todo extracto caía en `cuenta_ambigua` sin nada que lo deshiciera | 🔴 bug funcional | migración **`0009`** |
| **Un test que CONSAGRABA ese bug** como estado esperado | 🔴 | `inv6-resolucion.test.ts`, reescrito en los dos sentidos |
| El tipo del logger **había divergido de su fuente**: ~32 claves que el redactor tapa nunca estuvieron en el tipo, y **toda columna multi-palabra compilaba en camelCase** — la grafía real del código | 🔴 R27 no valía | `ClaveProhibida = ClaveSensible`, derivado del registro |
| Seis claves sensibles en **ninguna** de las dos listas | 🔴 | `clasificacion-campos.ts` |
| **`pnpm db:migrate` no arrancaba en máquina nueva**: `core.autocrlf` reescribe los `.sql` y el guardián de hash lo lee como "migración editada" | 🔴 falso positivo | `.gitattributes` + hash normalizado en `migrar.ts` |
| La puerta del literal de anexo **no era espejo** del `check`: **4 de 7 casos medidos divergían**, y cada uno voltea el lote entero | 🔴 | `persistir.ts` + `galicia.ts` + test |
| Índice de resolución con el orden equivocado contra la consulta real | 🔴 | `0009` |
| **Tres comentarios del repo afirmaban que existía un test que no existía** | 🟠 | test parametrizado de **10 pares** + `0010` |
| El encabezado del toolkit afirmaba *"Santander los ejercita"* de cuatro funciones que **ningún adaptador importa** | 🟠 | `toolkit.ts` |
| El índice del residuo de Galicia era el contador de movimientos: las 8 líneas informaban `indice: 0` | 🟠 | `galicia.ts` + test por mutación |

**Nada de esto lo detectó el gate.** Es la tercera vez que este repo confirma lo mismo.

### 3. Test de aislamiento del Módulo 1 — **verde, y demostrado que discrimina**

`packages/ingesta/tests/aislamiento-modulo-1.test.ts`, **16 tests**. Clientes A y B cargados **por el
pipeline real** (`persistirCuenta` / `persistirAnexos`, incluidos anexos), barrido de **las 10 tablas con
`cliente_id`** derivado del catálogo, en **las dos direcciones**, más escritura cruzada y lectura por uuid
ajeno.

🔴 **La verificación del verificador está hecha por mutación, no por argumento:** abriendo la policy
(`using (true)`) el contador de A pasó a ver **exactamente 7** movimientos de B. O sea que el 0 significa
RLS, y no "no cargamos nada".

**Y destapó un hecho contraintuitivo que hay que saber:** en el camino de escritura cruzada **no actúa la
`with check` de la policy, sino el trigger** `app.exigir_nodo_cliente()` — los `BEFORE ROW` corren antes
de que Postgres evalúe la `with check`. Los dos fallan cerrado y son equivalentes, pero un test que
afirmara *"lo frena la policy"* estaría afirmando algo falso y seguiría verde el día que alguien saque el
trigger.

### 4. Consistencia entre los tres adaptadores

Diagnóstico de `tech-lead`: **no divergen en el criterio, divergen en la edad.** Galicia es el primero y
no recibió ninguna de las tres lecciones que los otros dos pagaron.

🔴 **Lo peligroso para los cinco bancos que faltan no es la divergencia de estilo: es que hoy no hay un
archivo del que copiar.** Quien escriba el cuarto va a heredar lo que a ése le falte.

Los **menores de riesgo nulo** se aplicaron (residuo, espejo del check, encabezado falso). Los **nueve
mayores** están en `10-deuda-declarada.md` §2 con su medición, porque cada uno mueve un número medido o
cambia un contrato. Tres se cierran **antes del cuarto banco**: el contrato de entrada/salida con su regla
de código, el vocabulario de destinos en el toolkit, y la plantilla del esqueleto.

### 5. Pendiente para quien retome

- ✅ **`pnpm probar --banco galicia` corrido contra el archivo real: `VEREDICTO: cuadra`.** Todo lo
  congelado se mantiene (326 · 116/210 · 14 negativos · 21 referencias · **9 anexos** · conceptoBanco 326 ·
  32 conceptos · 0 rupturas · carátula completa · INV-13 y INV-14 en 0 · 326/326 hashes únicos). El espejo
  del `check` era el cambio con riesgo real —es más estricto que la puerta anterior— y **no rechazó ninguno
  de los 9 literales**. Residuo **29**, que es 47 − 18 (los 9 anexos × 2 filas): la resta cierra sin una
  sola línea sin explicar.
- 🔴 **Nada está commiteado.** Por el punto 3 del encargo original corresponde rama + merge `--no-ff`, sin
  reescribir historia ya mergeada.
- `packages/data/tests/ayuda.ts` omite `anexo_extracto` de su `truncate` explícito. Funciona por `cascade`,
  pero ese archivo nombra las tablas una por una **precisamente** para que una tabla nueva olvidada se note.
- Las decisiones de `10-deuda-declarada.md` §1.5 (rotación de pepper → `cuenta_ambigua`) y §1.2 (enmienda
  a ADR-0001 §5 antes de dropear los 11 índices redundantes).

---

## 2026-08-10 (15) — 🔴 **`09-lecciones-aprendidas.md`**: el procedimiento para los cinco bancos que faltan

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **638 tests + 7 todo**. **Sin commits.**

> **Antes de escribir el adaptador del cuarto banco, leé `docs/diseno/09-lecciones-aprendidas.md`.** No es una
> bitácora: es el **procedimiento** (§7, doce pasos), las trampas medidas, y los **tres niveles de prueba**
> que hasta hoy no estaban escritos en ningún lado (§8).

### Por qué existe

Los tres primeros bancos costaron caro en errores que **se repitieron con caras distintas**, y ninguno se
manifestó como una excepción o un test rojo: **todos produjeron un resultado que cuadraba igual**. Con cinco
bancos por delante, escribirlos una vez sale más barato que volver a pagarlos.

Lo que el documento fija, en una línea cada uno:

1. **El error de los cuatro rostros: el límite que no se puso.** `includes` sin ancla · `TRANSF: ` con espacio
   final (84 movimientos) · `\d{22}` sin `\b` · banda de `x` sin corte derecho. **Todo patrón que localiza un
   dato necesita sus DOS límites.** Y los cuatro campos afectados **no se imprimen nunca**, así que un valor
   sucio ahí es invisible para siempre.
2. **Un fixture escrito desde la especificación no la verifica: la consagra.** Con la cadena completa —spec
   mal → adaptador → fixture → 64 tests verdes— y la contramedida: **probar por mutación**, revirtiendo cada
   premisa y contando los tests que caen. *Si una mutación no rompe nada, ese test no prueba lo que dice.*
3. **El destino de una línea es QUÉ ES, no DÓNDE ESTÁ**, con la tabla de los tres bancos que muestra que **el
   que mejor puntuaba era el que más perdía**.
4. **Los controles que solo existen si alguien los escribe**, y el patrón común: se comparan contra algo que
   **el documento declara** y que el adaptador **no produjo**.
5. **Predicciones falsables en vez de conjeturas** — con los dos casos de esta etapa, incluida **una
   hipótesis mía que se falsificó midiéndola** (los 160 conceptos: el cruce dio 0 de 160).
6. **Las herramientas y qué contesta cada una**: `pnpm probar`, `--caratula <n>` fragmento por fragmento, y
   las formas del residuo agrupadas.

### La pregunta del titular, contestada con evidencia

*"¿Cada desarrollo tiene su US en backlog y su plan de testing?"* — **verificado sobre el repo: no.**

| | Estado |
|---|---|
| Backlog de US | ❌ **No existe.** Cero artefactos en `docs/` |
| Criterios de aceptación | ✅ Existen y son **mejores que una US típica**: el "Done" por banco de `08` §3 son conteos exactos. Pero están por **etapa de ingeniería**, no por unidad de trabajo |
| Plan de testing | ❌ No existía. **Lo escribe `09` §8** |
| DoD | 🟡 Parcial (`docs/devops/03` §2), y **le falta el nivel funcional** |

**Los tres niveles que de hecho existen**, medidos: **14 archivos puros** (unitario) · **9 contra Postgres
real** con RLS y las tres credenciales (integración) · **`pnpm probar` contra el archivo real**
(funcional/aceptación).

🔴 **El tercero no está automatizado y no puede estarlo**: el gate no tiene acceso a `privado/`. Eso lo vuelve
un **paso manual obligatorio del DoD de cada banco** — y es literalmente el nivel que encontró el anexo
perdido, el error de la spec, los 84 conceptos y el CBU sin leer.

**Recomendación escrita en `09` §9:** para cinco bancos no hace falta un backlog formal. Hace falta que **§7
sea el DoD de cada uno**, con el paso 12 —correr contra el archivo real y comparar **cada** número—
**bloqueante**. Es el 90 % del valor de una US con el 10 % de la ceremonia.

---

## 2026-08-10 (14) — Los seis pendientes, cerrados. Y **un error en la especificación**, no en el código.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **638 tests + 7 todo**, 23 archivos.
Verificado contra los tres archivos reales. **Sin commits.**

### Los seis

| # | Qué | Resultado |
|---|---|---|
| 1 | CBU de Galicia | ✅ `cbu=si`. Por etiqueta, **solo en la carátula**, y con `\b` de los dos lados |
| 2 | Las 2 filas con fechas del residuo de Santander | ✅ **No llevan importe en ningún lado**: se corrige la spec, no el código |
| 3 | Titular de Macro | ✅ `titular=si documento=si`. `condicionIva=no`, **declarado**: ese banco no publica la etiqueta |
| 4 | `alicuotaPublicada` con dos tasas | ✅ **No se parte.** Hoy nadie calcula con ese valor y el consumidor futuro va a decir cuál importa |
| 5 | Sincronizar las specs con lo medido | ✅ Las cuatro (`02`, `06`, `07`, `08`) |
| 6 | Canario de INV-15 | ✅ **Declarado** con sus tres aserciones en `it.todo`: su sujeto es el Módulo 2 |

**Carátula completa en los tres bancos**, que era el arranque de la pregunta: *"si no se leen los encabezados,
ahí hay información del cliente… ¿se desecha?"*. Se desechaba. Ya no.

### 🔴 El hallazgo de fondo: la spec estaba mal, y ninguna capa podía verlo

`07` §2 declaraba que el CUIT venía con la razón social **pegada**. Es falso, y costó **dos intentos de
adaptador** antes de medirlo. La forma real, por fragmento:

```
  fila 2   x= 72.0  Aa(aa):                    ← el rótulo, SOLO
           x=360.2  AAAAAAA (####) AAAAAAA     ← otra columna
  fila 3   x= 72.0  AAAA
           x= 93.0  A{9} AAA                   ← la razón social, en DOS fragmentos
           x=364.4  A.A.A.A #{11}              ← el CUIT, otra columna. La fila TERMINA ahí
```

**Por qué sobrevivió:** era **el único renglón de la tabla de §2 sin una regex verificada en §2.1**. Todos
los demás tienen su patrón contado contra el archivo; ése se describió a ojo. Y de ahí sale una cadena que
ninguna capa rompe sola:

> la spec lo dice mal → el adaptador se escribe contra la spec → **el fixture del test también** → 64 tests
> verdes confirmando el mismo supuesto falso.

**Regla que queda:** *un renglón de especificación sin conteo verificado es un renglón no medido. Y un
fixture escrito desde la especificación no la verifica: la consagra.*

Correcciones aplicadas a `07`: **§2.0-bis** con la medición; **trampa 16 eliminada** (no existe); **trampas
21 y 22 nuevas** — el rótulo no abre la fila, y `Sr(es):` tiene su valor en el **renglón siguiente**
compartiendo baseline con el CUIT.

**La 22 es la peligrosa**, y tiene la firma del peor modo de falla del proyecto: un lector que corte *"todo
lo que sigue a la etiqueta en la fila"* **guarda el documento del titular adentro del campo del nombre** — y
es invisible, porque ese campo no se imprime nunca. Hoy no pasa porque el corte es **por banda de `x` con
límite derecho**, y hay **4 tests que caen** si alguien saca ese límite.

Es el mismo error con cuatro caras: el `contains` de `IDCB`, el ancla con espacio de `TRANSF:`, el `\b` que
faltaba en el CBU, y esta banda sin corte.

### Dos cosas de método que funcionaron

1. **Las predicciones falsables como instrumento.** Santander no adivinó si sus dos filas eran anexo perdido:
   escribió una **tabla donde tres mecanismos mueven los números distinto**. Salió `anexos=7, residuo=5`, que
   era una fila exacta de esa tabla, y se confirmó viendo **qué forma desapareció** del residuo. Una
   ambigüedad de documentación resuelta por medición, sin abrir el archivo.
2. **`--caratula <n>` imprime la carátula fragmento por fragmento**, con la `x` de cada uno. Es lo que
   distingue *"el rótulo trae el valor"* de *"el rótulo está solo y al lado hay otra columna"* — invisible en
   la forma de la fila entera, y es exactamente lo que decide si un lector se lleva puesta la columna vecina.

### Backlog nuevo, todo anotado en `08`

1. 🔴 **E1.1 está en 5 de 14, no cerrado.** Escribí "cerrado, los 14 puntos" y era falso; lo detectó
   `documentador` verificando contra el código. Corregido en `08` §3.
2. **`fragmentoEnVentanaDerecha` devuelve el primero de la ventana, parsee o no.** Era riesgo teórico del
   panel; ahora tiene síntoma medido: un rótulo largo **tapa** al importe que viene atrás.
3. **El residuo no significa lo mismo en los tres adaptadores.** Galicia mete ahí filas que **sí se leyeron**
   (número de cuenta, CBU): el residuo es *"lo que el autómata del cuerpo no consumió"*, no *"lo que nadie
   leyó"*. Santander ya lo resolvió con su unión cerrada de destinos y `sinDestino = 0`.
4. **El gate de verificadores no mira los archivos de test.** Medido: **61 identificadores, 0 con verificador
   válido** — pero eso es mérito de quien los escribió, no del control. Un CUIT sintético con verificador
   válido **puede pertenecerle a un contribuyente real**.
5. **`alta-cuenta.ts` sigue sin tests**, y es el que fija contra qué resuelven todos los extractos futuros de
   una cuenta. Se le corrigió hoy un `\b` que faltaba: sin él, una corrida de 23 dígitos se recortaba a 22 y
   el alta guardaba un **CBU plausible e inexistente**.
6. **Macro §8 no cierra consigo mismo**: el título dice 1460 filas de ruido y su tabla suma 1428, y ninguno
   incluye las 141 del residuo. Nunca se cerró contra `filas geométricas = 2865`.

---

## 2026-08-10 (13) — **22 renglones fiscales rescatados.** Anexos, E2 completa, y el residuo con destino declarado.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **606 tests + 4 todo**, 23 archivos (venía
de 517). Verificado contra los tres archivos reales. **Sin commits.**

### El hallazgo que originó todo

Al agregarle al script de verificación las **formas del residuo** —el texto con los dígitos a `9` y las
letras a `A`/`a`, que muestra la estructura sin un solo dato— apareció esto en Galicia:

```
×9  AAAAAAA A{11} AAAAA AA ##-##-#### A AA ##-##-#### ###.###,##
```

Nueve renglones con dos fechas y un importe. `02` §10 mide que su anexo tiene **exactamente 9 entradas**.
**Era el bloque impositivo entero, en el residuo, con `anexos=0`.**

Y al mirar los tres juntos salió la inversión que importa:

| Banco | `lineasNoInterpretadas` | `anexos` | Qué pasaba |
|---|---|---|---|
| Galicia | 47 | 0 | los 9 renglones **en el residuo**: se veían |
| Macro | 141 | 3 de 6 | los `D. 409/2018` estaban en `RUIDO_MACRO`: **descartados sin rastro** |
| **Santander** | **0** | **0** | **7 renglones en ningún lado** |

> 🔴 **El que mejor puntuaba en "líneas no interpretadas" era el que más perdía.** Su adaptador no reportaba
> lo que caía fuera de la región de tabla, y por eso sacaba 0.

**La regla que sale de esto: el destino de una línea es QUÉ ES, no DÓNDE ESTÁ.** "Fuera de la región de
tabla" es una ubicación, no un destino. Toda línea necesita uno declarado —movimiento, ruido con su regla,
anexo o residuo— y la ecuación tiene que cerrar. Es lo que `particionar` + `residuoDeParticion` del toolkit
ya proponían con **cero usuarios**, y cuyo comentario describía el caso con seis meses de anticipación.

### El resultado, contra los archivos reales

| | Galicia | Santander | Macro |
|---|---|---|---|
| **Anexos** | **0 → 9** | **0 → 7** | **3 → 6** |
| **`conceptoBanco`** | **0 → 326** | 158 | **1186 → 1270** |
| Residuo | 47 → **29** | 0 → **6** | 141 → **0** |
| Carátula | `titular`+`documento`+`condicionIva` ✅ | `documento` ✅ | **`cbu`** ✅ |
| Movimientos · rupturas · INV-13/14 | 326 · 0 · 0/0 | 158 · 0 · 0/0 | 1346 · 0 · 0/0 |

**22 renglones fiscales rescatados**, incluidos los tres del *importe computable como pago a cuenta*, que
**no existe como movimiento y no es derivable de ellos**. Y **ningún número financiero se movió**.

### Los tres hallazgos de los agentes

1. 🔴 **Macro: 84 movimientos sin concepto por un espacio.** Yo había conjeturado que los 160 faltantes eran
   las 160 filas de un solo fragmento de glosa; el agente **cruzó los conjuntos y dio 0 de 160**. La causa
   real: `TRANSF:` y `CREDIN:` **estaban** en el vocabulario, pero el ancla les agregaba un **espacio final**
   y el banco los imprime pegados (`TRANSF:ABC…`). El ancla no matcheaba nunca. Arreglo: un prefijo que
   termina en carácter no alfanumérico se delimita solo; uno que termina en letra sigue exigiendo el espacio,
   **con contraprueba de `TPUSHERIA`** para que la trampa del `contains` no vuelva por la ventana.
   `conceptoBanco` **1186 → 1270**, y los 76 restantes son exactamente el hueco declarado de
   `PAGO<n>-LIQ COMER`.
2. **Galicia: el canario dio limpio.** `glosaDe` usa `fragmentoEnX`, que devuelve **un solo fragmento**: si
   alguna fila tuviera dos, la glosa se estaría truncando en silencio —el mismo modo de falla que en Macro
   mutiló 1186 descripciones—. El agente **no lo arregló** porque `descripcion` entra en `hashFila` y
   cambiarlo movería los 326 hashes, y dejó la predicción falsable: `con conceptoBanco < 326` significa
   exactamente eso. **Salió 326/326: no hay truncado, y los hashes no se tocan.** De yapa,
   `conceptos distintos = 32`, que es **el vocabulario medido en `02` §14 al literal**.
3. **El índice de doble lectura funciona.** Mi propio test puso dos anexos que diferían solo en
   `atribucionCuenta` y `uq_anexo_sin_doble_lectura` los rechazó — idénticos en literal, período e importe
   **son el mismo renglón leído dos veces**. Quedó como test propio.

### Lo que se escribió

- **`anexoExtractoSchema` rediseñado**: `periodoDato` (4 situaciones medidas, incluida `periodo_de_emision`
  —el banco **declara** el período sin imprimirlo—), `atribucionCuenta`, `relacionConMovimientos`,
  `ordenEnLote`, e `importe` → **`importeDeclarado`** (un `sum(importe)` copiado del query de movimientos
  **no compila**). Era lo que bloqueaba a Santander, cuyo agente se había negado —con razón— a emitir anexos
  con el período del extracto.
- **`persistirAnexos`** con el ordinal **del lote** (por cuenta colisionaría en `uq_anexo_orden`) y
  `no_determinada ⇒ cuenta en NULL`, más INV-14 como puerta de admisión.
- **`packages/ingesta/tests/anexos.test.ts`**, 12 tests contra la base real.
- **E2 completa**: Galicia tiene sus **primeros 34 tests propios** y `leerPar` migrado a `parDeColumnas`.
- Santander: **`leerSantanderConDestinos()`** — 7 destinos en unión cerrada, `sinDestino` tiene que dar 0, y
  `leerSantander` delega para que no haya dos clasificaciones que puedan divergir.

### Lo que queda

1. **Galicia: el CBU está en el residuo** (`×1 #{22}`) y sale `cbu=no`. INV-6 resuelve por número, así que no
   bloquea — pero el CBU es el identificador primario del resolver. **Por etiqueta, nunca por patrón**: el
   cuerpo tiene 113 corridas de once dígitos que son CUIT de contrapartes.
2. **Santander: dos de sus 6 filas de residuo llevan fechas** (`… ##-##-#### aa ##-##-####`), que es la
   estructura de un rótulo de anexo. Salieron 7 anexos y §9 dice 5+2, así que probablemente sean rótulos ya
   capturados — pero su propio agente avisó que **§9 lista seis rótulos para "5 importes"** y que cuál no
   lleva importe no se sabe sin el archivo. Dos minutos de mirada.
3. **Macro: `titular` y `documento` en `no`.** Su carátula los trae **pegados** (`C.U.I.T <11 dígitos><razón
   social>`, `07` §2), o sea que hay que partirlos.
4. **`alicuotaPublicada` es un campo y Santander publica dos tasas** (TNA y CFTEA). Hoy van juntas para no
   perder ninguna; separarlas pide una columna y una migración.
5. **`07` §12 quedó corto, medido**: `PAGO<n>-LIQ COMER` tiene **dos** largos (8 dígitos ×70 y **11 ×6**), y
   `TRANSF:`/`CREDIN:` suman **84**, no "~90". Y §8 no inventariaba las 141 filas del residuo.
6. Sigue pendiente el **test canario de INV-15** end-to-end, que necesita el Módulo 2 para tener sujeto.

---

## 2026-08-10 (12) — **Los tres bancos leídos y verificados contra los archivos reales.** E1.1, E4 y la 0008.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **517 tests + 4 todo**, 21 archivos.
Migraciones **0007 y 0008 aplicadas** contra Postgres 16. **Sin commits.**

### El resultado que importa

`pnpm probar --banco <codigo> --archivo <pdf>` corrido contra los tres archivos reales. **No toca la base
ni el almacenamiento**: lee, parsea, verifica e imprime conteos sin un solo valor.

| | Galicia | Santander | Macro |
|---|---|---|---|
| Páginas / filas geométricas | 26 / 1204 | 11 / 414 | 45 / 2865 |
| Cuentas | 1 | **2** | **3 (0/11/1335)** |
| Movimientos | **326** | **158** | **1346** |
| Créditos / débitos | 116 / 210 | **75 / 83** | 1165 / 181 |
| Saldo negativo | 14 | 158 | 283 |
| Con referencia | 21 | 94 | 1221 |
| **Rupturas de cadena** | **0** | **0** | **0 en las tres cuentas** |
| Fechas distintas | 21 | 22 | 19 y 3 |
| INV-13 / INV-14 | 0 / 0 | 0 / 0 | 0 / 0 |
| Hashes únicos | 326/326 | 158/158 | **1346/1346** |
| Esquema Zod | valida | valida | valida |

**Todos los números coinciden con los medidos** en `02` §2.2, `06` §10 y `07` §10. Y dos de los tres
adaptadores los escribieron agentes que **nunca abrieron `privado/`**: trabajaron solo contra las
especificaciones.

**Los tres controles que solo se ven en un archivo real:**

1. **`INV-multicuenta` en Macro: `verificado=true, diferencias=0`.** Es el único control que detecta la
   mezcla de cuentas — con las tres encimadas habría dado **1 ruptura sobre 1346 (0,07 %)** y todo lo demás
   igual. Separó bien.
2. **El reparto 83/75 de Santander.** Era el criterio que la cadena de saldos **no** atrapa: un parser que
   ponga los 158 en una columna da 0 rupturas si además invierte el saldo.
3. **Las 4 fechas de octubre de Macro salieron como `observacion`** con el lote en `cuadra` — la capacidad
   `traeMovimientosFueraDelPeriodo` haciendo exactamente lo suyo.

### Cinco hallazgos de la corrida, ninguno de parseo

1. 🔴 **El CLI nunca cablea `lineasNoInterpretadas` a la verificación.** Lo loguea y no se lo pasa a
   `verificarAritmetica`, así que **`EST_LINEA_NO_INTERPRETADA` jamás dispara en producción** — el código
   existe, tiene test, y sostiene la regla *"un adaptador nunca descarta una línea en silencio"*.
2. 🔴 **Y antes de cablearlo hay que unificar el criterio, porque hoy la métrica NO es comparable:**
   Santander **0**, Galicia **47**, Macro **141** — y los tres leyeron bien. Santander no reporta lo que cae
   fuera de la región de tabla; Macro sí. Cablearlo tal cual **rechazaría Galicia y Macro y dejaría pasar
   Santander**, por una diferencia de convención y no de calidad.
   **Propuesta:** solo cuenta lo que cae **dentro** de la región de tabla —donde una línea perdida es un
   movimiento perdido—; lo de afuera va a un contador informativo aparte. Con ese criterio los tres deberían
   dar 0 y ahí sí se puede exigir.
3. **Galicia no captura `conceptoBanco`** (`con conceptoBanco=0`): el adaptador nunca se actualizó a E4 — se
   les avisó a los dos agentes que escribían adaptadores nuevos y no a él. **Y sus 326 filas ya están en la
   base del piloto con `concepto_banco = null`**, o sea que es reproceso, que es justo lo que E4 existía para
   evitar.
4. **A Macro le faltan 160 conceptos**, no 76 como se había previsto (`1186 de 1346`). Pista, no conclusión:
   `07` §7 midió **exactamente 160 filas con un solo fragmento de glosa**. Si son las mismas, el problema es
   dónde corta y no qué literales faltan. **No es un defecto: es la medida del hueco de vocabulario**, que es
   el insumo de la planilla para la contadora.
5. **Macro emite 3 de 6 anexos**: los tres `TOTAL COBRADO` (uno por cuenta) sí, los tres `D. 409/2018` no —
   su atribución es 0/2/1 y con el modelo viejo habría tenido que inventar la cuenta. **Con la `0008`
   colgando del lote ya se pueden capturar** con `atribucion_cuenta = no_determinada`.

**Un número para mirar, de baja prioridad:** la distribución de líneas de glosa de Galicia da
`1→64 2→28 3→115 4→9 5→109 7→1` (suma 326) y la medición inicial de `01` §2.2 decía
`{1:64, 3:27, 4:114, 5:9, 6:111, 8:1}` (también 326). Corridas por uno y con dos movimientos de diferencia
en tres baldes. Puede ser que las dos mediciones cuenten cosas distintas —líneas de texto vs. fragmentos de
glosa— pero es **el único número que no coincide exacto**, y es sobre la glosa, que es el producto.

### Lo demás que se hizo en esta entrada

- **E1.1, PARCIAL**: `EST_CUENTAS_NO_COINCIDEN` (con el test que muestra que el consolidado **cuadra igual**
  cuando se pierde una cuenta en `0,00`), `CAMPOS_DIFERENCIA` como enum cerrado, la guarda importe≠saldo de
  `parDeColumnas`, el contrato de `seccionesPorClave`, y la flag `y` que se escapaba de `.replace('g','')`.
  🔴 **En la entrada anterior escribí "E1.1 cerrado, los 14 puntos del panel" y era falso: eran cinco.** Lo
  detectó `documentador` verificando contra el código en vez de contra el documento. Corregido en `08` §3 con
  la lista de lo hecho y lo pendiente. Una tabla mal marcada es peor que una tabla larga: a lo que dice
  "cerrado" nadie vuelve.
- **E4 (`0007`)**: `concepto_banco` (N2), `concepto_completo` (N1), `concepto_banco_estrategia` (N1) y
  **`pagina_pdf`** —que estaba en el esquema y no se persistía—, con **INV-14 como `check` en la base**:
  `concepto_banco` tiene que ser **prefijo de `descripcion`**, así hereda la garantía de INV-13 por
  construcción y la tabla no pasa al régimen de lectura auditada.
- **`0008_anexos.sql`**: cuelga del **lote** con `cuenta_bancaria_id` nullable y `atribucion_cuenta`, porque
  la atribución del anexo a su cuenta **no es posicional en ninguno de los tres bancos**. Con
  `relacion_con_movimientos`, *"prohibido que entre en la suma"* deja de ser una prohibición no verificable y
  pasa a ser una condición sobre una columna (**INV-15**).
- **Colisión de exports encontrada por el adaptador de Macro:** dos `export *` de adaptadores chocan en
  `BANCO_CODIGO`/`VERSION` y **ESM omite el símbolo en silencio**. El índice pasó a exports por nombre.
- **E-1 ampliada y confirmada** por el titular el 2026-08-10: la excepción cubre a **todos los titulares** del
  material. Con sus tres controles nuevos y la condición de cierre (demo → prod arranca de cero).

### Lo que sigue

Los tres adaptadores leen bien. Lo pendiente es de **integración**, no de parseo: unificar y cablear
`lineasNoInterpretadas`, poner E4 en Galicia (y reprocesar sus 326), capturar los `D. 409/2018` con la tabla
nueva, escribir `persistirAnexos` + el test canario de INV-15, y medir los 160 conceptos de Macro para la
planilla de vocabulario de la contadora.

---

## 2026-08-10 (11) — El panel revisó E1 y encontró **seis bloqueantes**. Corregidos. Y se corrigió el alcance de E-1.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **412 tests + 4 todo**, y ahora `apps/`
**sí se typechequea**. **Sin commits.**

### Lo primero, porque es de proceso

**E1 se había hecho sin convocar a nadie.** La matriz de `agents/README.md` dice `seguridad-datos-financieros`
**obligatorio** ante datos de clientes o aislamiento, y `code-reviewer` antes de mergear, `tester` antes del
"Done". No se convocó a ninguno. Se convocaron después, sobre lo ya escrito, y **encontraron seis bloqueantes
con el gate en verde**.

⚠️ **Los wrappers de `.claude/agents/` NO están registrados como sub-agentes en la sesión.** El harness solo
expone los built-in (`Agent type 'code-reviewer' not found`). Se resolvió con el mecanismo portable que el
propio proyecto diseñó: **adopción de persona** (`agents/README.md`, el protocolo de Codex) — un agente
genérico que lee `agents/personas/<x>.md` completo y actúa con ese rol. Funciona igual. **Para que los
wrappers se registren hace falta reiniciar Claude Code** (o revisar `/agents`).

### Los seis bloqueantes, todos corregidos

| # | Qué | Cómo se veía | Fix |
|---|---|---|---|
| 1 | 🔴 **`estadoSegunVerificacion` persistía una cuenta con la verificación en `no_cuadra`** | El bloque de la cuenta vacía **retornaba antes del `switch`**. Una cuenta vacía con saldo inicial ≠ saldo final —el síntoma de que el parser perdió sus movimientos— se persistía con el lote en verde. Y `EST_SIN_MOVIMIENTOS` se había bajado a observación en el mismo cambio: **las dos redes se retiraron juntas** | Se exige `estado !== 'no_cuadra'`; si no, rechazo con el código de la diferencia |
| 2 | 🔴 **`apps/` estaba fuera del `include` de `tsconfig.json`** | Todo el cableado del CLI —el pipeline de once pasos, INV-6, INV-multicuenta— **nunca pasó por `tsc`**. Vitest corre `apps/*/tests` pero no typechequea: el gate verde no significaba lo que parecía. Al agregarlo aparecieron **dos errores reales** | `apps/` y `tools/` agregados |
| 3 | 🔴 **`alFecha: string \| undefined`** en la llamada a INV-6 | `periodoHasta` es opcional y **puede faltar de verdad**. El `undefined` llegaba a la consulta → cero candidatas → el operador recibía **`cuenta_no_pertenece_al_cliente`**, el mensaje más grave del módulo, por un problema de parseo de carátula | Guard previo con motivo propio `cuenta_sin_periodo` |
| 4 | 🔴 **INV-multicuenta se apagaba en silencio** si el adaptador devolvía la lista vacía | "El banco no lo publica" y "el parser de carátula falló" se veían **igual**. En el banco donde más falta hace, el literal viene con **dos espaciados distintos en el mismo archivo**: un regex que falle desactiva el único control que ve una mezcla, y el lote pasa con 1 ruptura sobre 1346 | Capacidad `traeConsolidadoPorMoneda` + `consolidado_no_encontrado` como **error**. Mismo precedente que `traeTotalesDeclarados` |
| 5 | 🔴 **`fragmentosEnBanda` tenía los dos extremos cerrados** | Con las coordenadas **que publica la especificación** (`70.8`, `264.0`) metía **las 1221 referencias adentro de la glosa**. Los tests no lo veían porque usaban `263.5`, un colchón inventado por mí: el borde nunca se ejercitaba | La banda es `[desde, hasta)`. Un test por extremo, con las coordenadas literales del documento |
| 6 | 🟠 **`habilitaPersistir` vs `estadoSegunVerificacion`**: dos criterios, contestando distinto | Para la cuenta vacía una decía `true` y la otra `false`. `habilitaPersistir` no la usaba nadie en producción, solo los tests | **Borrada.** El criterio vive en un solo lugar, que es lo que su propio comentario dice |

**Tres agentes convergieron independientemente en el nº 1.** Se reprodujo antes de aceptarlo:
`estado verificacion: no_cuadra` → `estadoSegunVerificacion: {"persistir":true}`.

### Lo que el panel confirmó que está bien

`hashesDeCuenta`, `U$S` (incluida la decisión de **no** agregar `US$` sin medirlo), `periodoPorEtiquetas`, la
semántica de bordes de `regionesDeTabla`, y —de `seguridad-datos-financieros`— que **E1 no rompe el
aislamiento entre clientes ni filtra un valor a un log hoy**. Los fixtures de `multibanco.test.ts` no traen
valores del material real (revisión independiente, además del barrido).

### Lo que queda abierto: **`08` §3, sección E1.1**

14 hallazgos priorizados. Los tres que más pesan:

1. **`EST_CUENTAS_NO_COINCIDEN`** — es el único agujero de mezcla que INV-multicuenta **no puede** ver: una
   cuenta con saldo final `0,00` cuya sección nunca se abre **desaparece del sistema y todo cierra**. La
   verificación está medida y escrita en `07` §14.2 y no existe en el código.
2. **`Diferencia.campo` es `z.string()` abierto** y sale a tres canales, uno de ellos una columna clasificada
   **N1** cuya nota dice *"ninguna diferencia lleva un valor"*. Hoy eso es cierto **por convención, no por el
   tipo**.
3. **El CLI usa el `logger` genérico** teniendo `loggerAcotado` escrito, y `consolidado`/`saldo_consolidado`
   no están en ninguna lista del redactor — y el importe canónico (`-98765.43`) **no lo tapa ningún detector**.

### El alcance de E-1, corregido

`docs/seguridad/registro-excepciones.md` decía *"un cliente del estudio, 8 bancos, período 06/2026"*. **Las
tres partes estaban mal**: son **varios clientes distintos** (por el CUIT de cada carátula), **cuántos no se
sabe**, y los períodos son **heterogéneos** (Macro es 11-2025). Se corrigió la fila, se agregó la sección de
corrección, y **tres controles nuevos** (6, 7 y 8): un tenant por titular sin excepción, identificador
provisorio opaco, e INV-6 probado con el cruce real.

🔴 **Decisión pendiente del titular, y es previa a cualquier ingesta de un segundo titular:** la autorización
registrada se dio sobre *"el cliente piloto"*. Esto son varios titulares que no son ese cliente. **No es
reversible**: `on delete restrict` + `acceso_auditoria` append-only sin `grant delete` significan que "después
lo borramos" no está disponible. Mientras tanto el material **se lee para medir formato** —que es lo que se
viene haciendo— pero **no se ingesta un segundo titular a la base del piloto**.

### El modelo del cliente provisorio (diseñado, no aplicado)

`plan-cuentas-multicliente` entregó el diseño. Lo esencial, en tres puntos:

- **El tenant no es la identidad: es el `uuid`.** `fila_hash`, `archivo_hash`, las FK compuestas, el prefijo
  `cliente/<uuid>/` en storage y `acceso_auditoria` cuelgan del uuid y **ninguno contiene la identidad del
  titular**. O sea que **no falta un dato para crear el tenant**: falta la *etiqueta*. El uuid que se asigna
  hoy es el definitivo.
- **De provisorio a real se RENOMBRA**, y es la única de las tres opciones con costo cero: `cliente_id` no
  cambia, así que no se toca ni una fila de dominio. Migrar exige `BYPASSRLS` sobre FK no deferrables, deja el
  objeto en el prefijo viejo (un `UPDATE` no mueve un `PUT`) y **parte el rastro append-only en dos
  titulares**; re-ingestar duplica el PDF y deja residuo imborrable. ADR-0001 §3 ya lo había previsto: el
  segmento del path es `nid`, no el nombre.
- **Un tenant por titular** (agrupados por HMAC del CUIT de carátula, con pepper, sin escribir el CUIT en
  ningún lado), todos colgando del mismo estudio. **Ante la duda: sobre-partir, nunca unir.**

**Falta una pieza que no existe:** hoy **no hay forma soportada de crear un nodo `cliente`** en la base del
piloto — los dos `insert into tenant_node` del repo están en `sembrar.ts` (que arranca con `truncate` de once
tablas) y en `tests/ayuda.ts`. Hace falta `pnpm alta:cliente`, con la forma de `alta-cuenta.ts`.

**Y una trampa de orden, medida:** `alta-cuenta.ts` pone `vigente_desde = periodo.desde` **del PDF que se le
pasa**. Con períodos heterogéneos, dar de alta con el de 06/2026 y después ingestar el de 11-2025 devuelve
`cuenta_no_registrada` **con la cuenta ya cargada**. La regla: **el alta de cada cuenta se hace con el
extracto más viejo de esa cuenta.**

### Lo que sigue

**E1.1** (`08` §3), empezando por `EST_CUENTAS_NO_COINCIDEN` y el cierre de `Diferencia.campo`. Después E2.

---

## 2026-08-10 (10) — **E1 cerrado**: las 10 piezas que Macro y Santander expusieron, con 57 tests nuevos

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **403 tests + 4 todo**, 19 archivos (antes
346). **Sin commits.**

> El punto de entrada sin contexto sigue siendo **`docs/diseno/08-plan-de-construccion.md`**, ya actualizado:
> E1 figura cerrado con dónde quedó cada pieza, y **E2 (tests del adaptador de Galicia) es lo que sigue**.

### Qué se hizo

Las **10 piezas de E1**, ninguna postergada. Todas nacieron del mismo modo de falla medido: **producen un
resultado plausible y equivocado** — los importes cuadran, la cadena de saldos cierra, el lote dice
`procesado`, y el dato está mal.

| # | Pieza | Archivo |
|---|---|---|
| 1 | `fragmentosEnBanda` | `packages/ingesta/src/texto-pdf.ts` |
| 2 | `verificarConsolidadoPorMoneda` (INV-multicuenta) + `EST_CONSOLIDADO_MONEDA` + `consolidadosPorMoneda` | `verificacion/invariantes.ts`, `esquema.ts`, `adaptadores/registro.ts`, `apps/cli/src/ingestar.ts` |
| 3 | `seccionesPorClave` | `adaptadores/toolkit.ts` |
| 4 | `regionesDeTabla` + `dentroDeAlgunaRegion` | `adaptadores/toolkit.ts` |
| 5 | `parDeColumnas` con `traeSignoEnElImporte` | `adaptadores/toolkit.ts` |
| 6 | `periodoPorEtiquetas` | `adaptadores/toolkit.ts` |
| 7 | `U$S` en `importeACentavos` (`RE_SIMBOLO_MONEDA`) | `parseo-ar.ts` |
| 8 | `EST_SIN_MOVIMIENTOS` **por archivo** | `invariantes.ts` + `persistir.ts` + CLI |
| 9 | Capacidad `traeMovimientosFueraDelPeriodo` | `esquema.ts` + `invariantes.ts` |
| 10 | `hashesDeCuenta` | `hash.ts` (y `galicia.ts` lo usa) |

Tests: **`packages/ingesta/tests/multibanco.test.ts`** (41, nuevo) y **`verificacion.test.ts`** (+16).

### Las cuatro decisiones que quedan escritas, no re-discutibles

1. **`EST_SIN_MOVIMIENTOS` es POR ARCHIVO** (la recomendación abierta en `06` §11.7, ahora decidida). Una
   cuenta vacía dentro de un lote que sí trajo movimientos es **observación**, y **se persiste** con cero
   movimientos. Guardarla no es completitud: **su saldo final declarado es lo que INV-multicuenta necesita**
   para que la suma por moneda cierre. Sin el dato del lote se conserva la regla estricta — el default falla
   del lado seguro.
2. **Las invariantes que un banco falsifica se DECLARAN, no se relajan.** "Toda fecha cae dentro del período"
   es falsa en Macro (4 movimientos de octubre en un resumen de noviembre) y verdadera en el resto. Se agregó
   la capacidad `traeMovimientosFueraDelPeriodo`, que baja la diferencia a **observación** sin hacerla
   desaparecer: sigue en `verificacion_detalle` con su número de fila y `fechasDentroDelPeriodo` sigue en
   `false`. Relajarla para todos habría apagado el control donde sí sirve.
3. **INV-multicuenta rechaza el LOTE, y corre antes de persistir una sola fila.** Una mezcla de cuentas no se
   arregla descartando una fila: si el reparto está mal, **todas** las filas están atribuidas a la cuenta
   equivocada. Motivo nuevo: `consolidado_no_cuadra`.
4. **Los tres modos de "no puedo compararlo" de INV-multicuenta son `error`, no observación**
   (`saldo_final_ausente`, `moneda_sin_cuenta`, `moneda_sin_consolidado`). La tentación es marcarlos como
   atenuante y es al revés: el valor entero de la invariante es detectar que **falta una cuenta**, así que
   "falta el dato para compararla" es el síntoma, no la excusa.

### Dos cosas que salieron de escribirlo

- **`ParDeFila` estaba declarado dos veces** (galicia y toolkit) y `index.ts` re-exporta los dos módulos con
  `export *`. Galicia ahora **importa el tipo** del toolkit; su `leerPar` no se tocó.
- **El primer test de la cuenta vacía falló, y tenía razón.** `{...BASE, movimientos: []}` conserva los
  totales declarados de las 40 filas del fixture, así que daba `no_cuadra` por `ARIT_TOTAL_CREDITOS` — un
  rojo que no tenía nada que ver con lo que el test probaba. Se escribió a mano una cuenta vacía **con la
  forma real** (saldo inicial = saldo final, sin totales declarados). Queda anotado en el propio test: un
  fixture incoherente empuja a relajar el verificador.

### Lo que NO se tocó, a propósito

- **`galicia.ts` no migró a `parDeColumnas`.** La lógica es la misma salvo un detalle (token en las dos
  columnas: allá gana el crédito, acá es `null`) y sobre el archivo real da idéntico. Pero **lo único que
  respalda hoy a ese adaptador es una corrida contra un archivo que el gate no puede abrir**. La migración es
  condición de salida de **E2**, con los tests puestos. Está anotado en el docblock de `leerPar`.
- **`inferirCortes` / `cortarEnColumnas` siguen ahí**, con cero usuarios en los tres bancos. Se borran con el
  **cuarto**: borrar sobre tres es una conclusión, borrar sobre uno era una corazonada.
- **El camino `consolidado_no_cuadra` del CLI no tiene test de integración**: hoy ningún adaptador emite
  consolidados (Galicia no los publica), así que el camino está inerte. La lógica sí está cubierta con 9
  tests unitarios. Se cierra en **E3**, con el adaptador de Macro.

### Lo que sigue, en una línea

**E2**: los tests del adaptador de Galicia, que hoy funciona sin uno solo propio, más las cuatro mutaciones de
texto que están en `it.todo`. **Después** E3, los adaptadores de Santander y Macro, que son los que van a
ejercitar de verdad las diez piezas de E1.

---

## 2026-08-10 (9) — **PUNTO DE ENTRADA PARA RETOMAR SIN CONTEXTO.** Tres bancos medidos, arquitectura decidida.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **346 tests + 4 todo**. Los 326 movimientos
de Galicia persistidos en la base del piloto. **Sin commits.**

> **Si retomás sin el contexto de la conversación, leé `docs/diseno/08-plan-de-construccion.md`.** Es el punto
> de entrada: dice qué está hecho, qué está decidido, qué está abierto y en qué orden construir. Esta entrada
> es el resumen; ese documento es el mapa.

### Los documentos, y qué contiene cada uno

| Documento | Qué es |
|---|---|
| **`08-plan-de-construccion.md`** | 🔴 **Empezar acá.** Arquitectura decidida, estado del código, orden de construcción E1–E6, decisiones tomadas, preguntas para la contadora, deuda de seguridad, limpieza |
| `01-modulo-1-ingesta-bancaria.md` | El plan del Módulo 1 y sus 12 condiciones de salida (cerradas) |
| `02-formato-galicia.md` | Spec de Galicia — 326 movimientos, 17 trampas |
| `03-hallazgos-del-panel.md` | Los 4 informes del primer panel: seguridad, verificación, Módulo 2. Y §3.4.bis con la corrección del supuesto del código de concepto |
| `04-imputacion-contable.md` | El modelo de imputación desde las 14 reglas reales de la contadora |
| `05-motor-de-reconocimiento.md` | El motor de reconocimiento de tipo, con el léxico por banco |
| **`06-formato-santander.md`** | Spec de Santander — 158 movimientos, 2 cuentas |
| **`07-formato-macro.md`** | Spec de Macro — 1346 movimientos, **3 cuentas con transferencias entre ellas** |

### La arquitectura, en cuatro líneas

```
POR BANCO  1. Extracción y parseo del PDF        adaptadores/<banco>.ts
           ───────────── se persiste el extracto ─────────────
POR BANCO  2. Léxico: TEXTO del banco → concepto canónico     lexico/<banco>.ts  (DATOS)
ÚNICO      3. Catálogo: concepto → tipo de movimiento
ÚNICO      4. Imputación: (tipo, columnaOrigen) → cuenta del plan del cliente
```

**Duplicar lo que depende del banco es sano —aísla fallas—; duplicar lo que depende del criterio de la
contadora es peligroso —multiplica los lugares donde su decisión queda desactualizada.**

Evidencia medida de por qué la capa 2 es por banco: el impuesto a los débitos y créditos aparece como
`IMP. DEB. LEY 25413 GRAL.` **y** `IMPUESTO DEB.LEY 25413` (Galicia), `Impuesto ley 25.413 debito 0,6%`
(Santander), `N/D DBCR 25413 S/DB TASA GRAL` (Macro). **Tres bancos, cuatro grafías, un solo hecho.**

### La arquitectura por banco, validada con tres bancos

- Los **tres** necesitan la vista **geométrica**, por razones distintas: orden del content-stream (Galicia),
  y **el signo solo está en la columna** (Santander y Macro).
- `texto-pdf.ts`, `parseo-ar.ts`, `verificarAritmetica` y el pipeline de controles: **los tres sin modificar**.
- **`inferirCortes` sigue en CERO usuarios en los tres.** Ninguno tiene columnas de ancho fijo en caracteres:
  `pdf.js` emite un espacio por hueco. Borrar al confirmar con el cuarto banco.
- De las 5 piezas que le faltaron a Santander, **4 son genéricas**. Ese reparto es lo que valida la apuesta.

### Los tres hallazgos que cambian decisiones

1. 🔴 **Mezclar las cuentas de Macro da 1 ruptura sobre 1346 = 0,07 %.** Pasa cualquier umbral, "casi cuadra",
   y produce una cuenta inexistente con dos saldos encimados. **El único control que lo detecta** es el
   consolidado por moneda de la carátula contra la suma de los saldos finales — no tiene equivalente en Galicia
   y hay que agregarlo como invariante.
2. 🔴 **La regla 10 (transferencias entre cuentas propias) se reconoce por el PAR DE CONCEPTOS, no por
   importe+fecha+signo.** Ese criterio devuelve 5 pares en Macro y **2 son falsos positivos**: dos importes
   redondos que coinciden el mismo día. Con el criterio al revés se imputan como movimientos con terceros dos
   operaciones legítimas, **y el asiento cuadra igual**.
3. 🔴 **En Santander y Macro el importe NO lleva signo.** Copiar `leerPar()` de Galicia —que exige que el signo
   del token coincida con la columna— da **0 movimientos**.

### Corrección a un dato que quedó mal antes

Dije que solo Galicia tenía código de concepto. **Santander también**: su `.xls` es un **TSV en Latin-1
renombrado** con una columna `Cod. Operativo`, **29 códigos para 29 conceptos**. No se detectó antes porque
`exceljs` no lee ese formato. Son **2 de 5**, no 1 de 5 — y para Credicoop y Macro sigue sin medirse (sus `.xls`
son BIFF y no hay lector).

### Lo que se hizo en esta entrada

- **Se persistieron las especificaciones de Santander y Macro** (`06`, `07`), que solo existían en el contexto
  de la conversación. Cuestan ~20 min de medición cada una.
- **Se escribió `08-plan-de-construccion.md`** como punto de entrada sin contexto.
- **Multi-cuenta cableado en el CLI**: los pasos 8–10 corren **por cuenta** (INV-6 por cuenta, verificación por
  cuenta, y el veredicto del lote es el peor de sus cuentas). Antes hacía `cuentas[0]` y con Macro habría
  persistido la primera y descartado las otras dos **en silencio**.
- **Dos reglas de código nuevas**: ningún adaptador importa a otro, y ninguno importa `data` ni
  `almacenamiento`.
- **Advertencia medida en el toolkit**: un solo banco escrito, importa una función, seis exportaciones en cero.
  Con la regla: **el segundo y el tercer banco deciden qué sobrevive**.
- Se borraron los 15 scripts de análisis descartables (su contenido está en `02`, `06` y `07`). Se conservó
  `probar-galicia.ts`, que es la corrida de verificación con salida sin valores.

### Lo que sigue, en una línea

**E1 de `08` §3**: las 10 piezas que Macro y Santander expusieron, empezando por `fragmentosEnBanda` (sin ella
1186 de 1346 descripciones de Macro salen truncadas) y el `INV-multicuenta`. **Después** los tests del adaptador
de Galicia, que hoy funciona sin un solo test propio. **Recién después** los dos adaptadores nuevos.

**El motor de reconocimiento no arranca sin las 7 respuestas de `08` §5**, empezando por qué es
`ACREDITAMIENTO` — 78 movimientos, el concepto más frecuente del extracto de Galicia.

**Ojo con la base:** el piloto es `sistema_contable_piloto` (`ENV_FILE=.env.piloto`). `pnpm test` corre contra
la local de siempre y **aborta** si detecta lotes cargados.

---

## 2026-08-10 (8) — Galicia end-to-end: **326 movimientos persistidos**. Y un supuesto falsificado que rehizo el diseño del Módulo 2.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **344 tests + 4 todo**. Los 326 movimientos
del extracto real en la base del piloto, verificación `cuadra`. **Sin commits.**

### 1. Lo que corrió de punta a punta

```
ingesta.parseada      filas_leidas=326  paginas=26  lineas_no_interpretadas=47
ingesta.verificada    verificacion_estado=cuadra   filas_con_ruptura=0
ingesta.persistida    filas_insertadas=326  estado=procesado
```

En la base: 326 movimientos, 326 filas crudas en la satélite, 326 hashes distintos, 14 en descubierto,
verificación `cuadra`, idempotencia confirmada (segunda corrida → `ya_procesado`). El objeto se escribió
**último**, después de que las filas entraron.

Todos los números coinciden con la especificación medida: 326 filas, 116 créditos, 210 débitos, 14 saldos
negativos, 21 con referencia, 0 rupturas, 25 páginas declaradas.

**Infraestructura del piloto:** base separada `sistema_contable_piloto` con `APP_ENTORNO=piloto` y
`.env.piloto` (gitignoreado). **Los tests truncan `tenant_node`**, así que compartir base habría borrado el
material real y su rastro de auditoría — hay guard en los dos lados. Excepción **E-1** registrada en
`docs/seguridad/registro-excepciones.md` con la autorización del titular y de la contadora. Pepper propio
generado (el de `.env.example` es público y no protege nada; hay guard que aborta).

### 2. Bugs corregidos en esta tanda

| # | Bug | Cómo se encontró |
|---|---|---|
| 1 | **El autómata del adaptador cerraba el movimiento antes de leer la glosa.** En la vista geométrica el par `(importe, saldo)` está en la **misma fila que la fecha**, no después: cerrar al verlo descartaba las continuaciones. **777 líneas perdidas con los 326 movimientos correctos** — §6.4 literal | corriendo contra el archivo real |
| 2 | **`importeACentavos` usado sobre valores ya canónicos.** Las dos funciones son inversas de `centavosAImporte` en dominios distintos y confundirlas **no da error de tipos**. Explicaba las tres fallas restantes: los 14 saldos en descubierto leídos como positivos, `ARIT_SALDO_INICIAL` y `ARIT_SALDO_FINAL` | ídem |
| 3 | **`extraerPeriodo` rechazaba el caso real.** Yo había puesto un control de "período invertido = parseo mal hecho" y el banco emite las fechas en orden `[hasta, desde]`: el control rechazaba lo normal y la vigencia caía a un fallback inventado. Ahora min/max, y **el fallback no existe** | el alta imprimió `2000-01-01` |
| 4 | **El CLI nunca cargaba el `.env`.** Funcionaba **solo en tests**, donde vitest lo carga. La peor forma de estar roto: quien lo corre a mano concluye que el problema es su máquina | corriendo el CLI |
| 5 | **Un archivo que no es un PDF lanzaba** en vez de rechazar con código: el lote quedaba en `recibido` **sin motivo**, o sea sin nadie mirándolo | los tests del CLI |
| 6 | **Ciclo de paquetes** `data → ingesta → data`: el typecheck lo aceptaba. El script de alta se movió a `apps/cli` y hay **regla de código** que lo prohíbe | typecheck |
| 7 | El logger tipado **rechazó mi propia línea de log** con `cbu_ultimos4`: es N2 y no va a un log ni en su forma parcial | typecheck |

### 3. 🔴 El supuesto que se cayó, y por qué importa

Se afirmó —yo— que **"el código de concepto está en el Excel"** y se estuvo a punto de diseñar la imputación
contable sobre eso. **Se midió y es falso.** De los cinco bancos que entregan planilla, **solo Galicia trae
código**; tres de los ocho no entregan planilla; y hay **cuatro tecnologías** distintas detrás de la palabra
"Excel" (`.xlsx` ZIP, `.xls` BIFF, texto renombrado, HTML renombrado).

Corregido en `03-hallazgos-del-panel.md` §3.4.bis y en el plan §3.3.

**El rediseño está en dos documentos nuevos**, con el equipo convocado sobre las **14 reglas reales** de la
contadora (`privado/…/leer bancos.txt`) en vez del código de concepto:

- **`docs/diseno/04-imputacion-contable.md`** — el modelo de imputación
- **`docs/diseno/05-motor-de-reconocimiento.md`** — el motor de reconocimiento de tipo

### 4. Los cinco hallazgos del rediseño que cambian decisiones

1. **La separación son cinco capas, no dos.** La que faltaba: **resolución de contrapartida** (padrones). Tres
   de las 14 reglas —las de mayor volumen— no fallan por reconocimiento sino porque **falta un padrón**. Y la
   prueba: **Galicia trae código de concepto y esas reglas siguen indecidibles con él.**
2. **`lado = columnaOrigen === 'credito' ? 'haber' : 'debe'`** para todo renglón con una sola contrapartida.
   **La tabla de imputación guarda CUENTAS, nunca lados.** Se recorrieron las 14 reglas y no hay una sola
   excepción: las reglas 8 y 9 son la prueba —misma cuenta, los dos lados, y el lado sale de la columna. Con eso
   **la inversión de signo deja de ser posible por construcción**.
3. **Los 14 tipos NO cubren el material del piloto.** Medido en la base: **14 movimientos de FCI**, **6 de
   percepción de IVA** y **11 de compra con débito** no entran en ninguna de las 14 reglas. El motor tiene que
   poder decir *"reconozco el concepto y no tengo tipo para él"* — que es distinto de *"no reconozco el
   concepto"*. El primero es un **hueco de producto**; el segundo, un literal nuevo.
4. **Cuatro de los 14 tipos tienen CERO evidencia** en el vocabulario medido (intereses de financiación,
   SIRCREB, depósitos en efectivo, cheque rechazado). **No se pueden escribir hoy** sin inventar vocabulario.
5. **El anexo del banco es un set etiquetado POR EL BANCO** para dos tipos: la suma de lo reconocido como
   impuesto ley 25.413 sobre débitos tiene que igualar el total que el banco publica en el anexo. **Es la
   verificación más fuerte disponible y no necesita ni una etiqueta humana.** Exige la tabla de anexos, que hoy
   no existe.

### 5. 🔴 Tres cosas que hay que preguntarle a la contadora antes de escribir el motor

1. **¿Qué es `ACREDITAMIENTO`?** **78 movimientos, todos crédito** — el concepto más frecuente del extracto
   (medido en la base). Si es acreditación de adquirente —y en el mismo vocabulario está
   `ANULAC. ACRED. FIRSTDATA.`— entonces **78 movimientos van a decisión humana** por falta de la liquidación
   del adquirente, y eso cambia todo el volumen del piloto.
2. **Tarjetas: ¿"Deudores por ventas" o "Tarjeta de crédito a cobrar"?** Dijo las dos cosas en documentos
   distintos y el diseño difiere: con cuenta separada el residuo del neteo queda **aislado y reconciliable**;
   dentro de Deudores se disuelve entre las cobranzas y **no se detecta nunca**.
3. **¿Sus clientes llevan circuito de valores** (cheques a pagar / en cartera)? De eso depende que las reglas
   12c, 13c y 14 estén bien o **dupliquen la cancelación**.

Más: **etiquetar el corpus de vocabulario** (32 literales de Galicia + los de Santander, `literal → tipo`). Es
el único insumo humano que el motor necesita para ser verificable, **y no son datos de sus clientes**: son las
etiquetas que imprime el banco.

Y una decisión que le corresponde al titular: **la regla 11 hay que advertirla aunque ella no lo pidió**. Su
simplificación es sobre **la cuenta** (legítima, se respeta); el problema es el **importe**: el neto omite el
arancel, su IVA y las retenciones. Son plata, y el asiento cuadra igual.

### 6. Lo que sigue, en orden

1. **Tests del adaptador contra el fixture sintético.** Hoy el adaptador funciona contra el archivo real y
   **no tiene un solo test propio** — al revés de como debería ser. Con las cuatro mutaciones de texto, que
   ahora sí tienen sujeto.
2. **Los campos que son reproceso si se agregan después** (`04` §9 y `05` §9). Los dos más urgentes:
   **`conceptoBanco` no se persiste** (el esquema Zod lo tiene, la migración `0004` no) y
   **`conceptoCompleto`** — `ACREDITAMIENTO` tiene 14 caracteres y **no se puede saber si está truncado**; el
   ancho de la columna es un hecho del parseo y **no es reconstruible después**. Más la tabla de **anexos**.
3. **El lector de Excel y el cruce PDF↔Excel.** La clave **no puede ser `(fecha, importe)`** (7 grupos con 19
   filas repetidas): tiene que ser `(fecha, importe, saldo)`, único 326/326.
4. **El segundo banco (Santander).** Es la prueba real de si el toolkit sirve: si sale en un archivo chico, la
   apuesta era correcta; si hay que reescribir el pipeline, está mal factorizado — y es mejor saberlo con dos
   bancos que con ocho.
5. Recién después, el motor de reconocimiento — **con las respuestas de §5 en mano.**

**Ojo:** la base del piloto es `sistema_contable_piloto` (`ENV_FILE=.env.piloto`). `pnpm test` corre contra la
base local de siempre y **aborta** si detecta lotes cargados.

---

## 2026-08-10 (7) — Panel de 4 agentes + toolkit del adaptador. **9 bugs propios corregidos.**

**Herramienta:** Claude Code, sesión autónoma. **Estado:** `pnpm verificar` verde — **340 tests + 4 todo**
(18 archivos), los 18 invariantes SQL con las tres credenciales, gate de fixtures 7/7, barrido verde en los
dos modos. **Sin commits.**

**El adaptador de Galicia NO está escrito, y es a propósito.** El panel encontró que faltan piezas que van
antes. Están abajo, y el orden está en `docs/diseno/03-hallazgos-del-panel.md` §4.

### Lo nuevo que hay para leer

| Documento | Qué tiene |
|---|---|
| **`docs/diseno/02-formato-galicia.md`** | La especificación del formato, medida sobre el archivo real y **sin un solo valor del cliente**. 326 filas, 0 rupturas de cadena, totales exactos. 17 trampas, con cuáles ya están resueltas |
| **`docs/diseno/03-hallazgos-del-panel.md`** | Los tres informes consolidados: seguridad de la primera corrida real, estrategia de verificación del adaptador, y qué capturar para el Módulo 2 |

### El hallazgo que cambia el diseño del adaptador

**El layout de Galicia NO es de ancho fijo en caracteres.** `pdf.js` emite **un espacio por hueco**, sin
importar que mida 5 pt o 236 pt. Así que `substring(i, j)` es inviable y `inferirCortes()` no sirve para ese
banco. Y el importe y el saldo **salen en una línea posterior a la fecha** en 262 de 326 filas: un parser que
asuma "una línea = un movimiento" falla en el 80 % de las filas.

De ahí **`aFilas()`** en `texto-pdf.ts`: agrupa fragmentos por coordenada `y` y expone la `x` de cada uno.
Verificado contra el PDF real: **326 filas con fecha en la columna de fecha**, que es el número esperado.

### Los 9 bugs propios, todos confirmados con una medición antes de tocar nada

| # | Bug | Dónde |
|---|---|---|
| 1 | **La glosa se comía el encabezado de la página siguiente, los totales y la carátula** — 9 de 80 filas, con el test verde porque solo contaba filas | `toolkit.ts`: `particionar()` + ruido transparente vs. de corte |
| 2 | **El generador producía un fixture incoherente** (importe positivo en la columna de débito) y la verificación decía `no_cuadra` con razón — pero por culpa del generador | `extracto-sintetico.ts`, y ahora **valida su propia salida** |
| 3 | **`glosa.ts` tomaba un importe por documento**: `1234567,89` quedaba como `[DOC],89` | `glosa.ts` |
| 4 | **`pnpm db:seed` borraba el rastro de auditoría append-only** y las 7 tablas del Módulo 1, por un `cascade` | `sembrar.ts`: enumerado, sin `cascade`, aborta fuera de `local` o con lotes cargados |
| 5 | **`extraerTexto` dejaba el buffer detachado**: la segunda llamada tiraba `TypeError` | `texto-pdf.ts` |
| 6 | **`requiereOcr` por promedio**: 10 páginas con texto y 40 escaneadas promedian por encima del umbral | `paginasSinTexto` por página |
| 7 | **Mes hardcodeado** en el generador y **página 4 declarada dos veces** | mes derivado del período; secuencia 1..8 |
| 8 | **`.env` fuera del barrido** (`extname('.env')` devuelve vacío) | `barrido-fuga.ts` |
| 9 | **Parameter properties**: `tsc` compila y Node explota al importar | 2 clases + **regla de código** que lo prohíbe |

Y **el check `tipo_cuenta` de `0004` admitía 4 valores contra los 6 del dominio**, aplastando la
`cuenta_corriente_especial` que el piloto tiene. Corregido en `0006`.

### Un hallazgo mejor de lo esperado

Al escribir el test de R28 se descubrió que **la RLS forzada suprime el `DETAIL: Failing row contains` de
Postgres**. En `banco` (sin RLS) la fila sale completa; en una tabla de dominio, no. Los siete renglones de
ADR-0001 §5 dan una defensa que nadie diseñó, y está escrito como test con la evidencia de los dos lados
(`packages/data/tests/errores-pg.test.ts`) para que nadie concluya que la RLS es opcional en una tabla
"auxiliar".

**No reemplaza al traductor de errores** (`errores-pg.ts`, nuevo): eso cubre las tablas sin RLS, el `where`, y
el hecho de que re-lanzar el error del driver arrastra `stack` y `parameters`.

### Lo nuevo en código

- **`packages/ingesta/src/adaptadores/`** — `contrato.ts` (un adaptador **no se autocertifica**, declara sus
  capacidades y nunca descarta una línea en silencio), `registro.ts` (detecta el banco por **contenido** y lo
  compara contra lo declarado; el estado `ambiguo` existe porque hay dos PDF byte-idénticos en el roster) y
  `toolkit.ts` (carátula por etiqueta, cortes inferidos, partición contada, período con fechas pegadas).
- **`packages/ingesta/src/persistir.ts`** — "todo o nada". `no_cuadra` deja cero filas. `no_verificable` da
  `procesado_con_observaciones`, que **no es** `procesado`.
- **`packages/data/src/db/errores-pg.ts`** — traductor de errores de Postgres (R28).
- **`texto-pdf.ts`** — `aFilas()`, `fragmentoEnVentanaDerecha()`, `paginasSinTexto`.
- **`0006_ajustes_cuenta.sql`** — el check de `tipo_cuenta`, el check que impide guardar el CBU en `numero`
  (22 dígitos exactos = CBU), y **`pepper_id`** para poder rotar el pepper sin volver a pedir los CBU.
- **Guard del pepper**: aborta si es el valor de `.env.example` y el entorno no es `local`.

### Lo que hay que resolver ANTES de la primera corrida real (dos son tuyas)

1. **Generar un pepper propio** y ponerlo en `.env`. Va primero: recalcular `cbu_hmac` después exige el CBU en
   claro, que el sistema **no guarda**. El guard ya está, pero solo aborta fuera de `local`.
2. **Decidir el encuadre de la corrida** (hallazgos §1.1): ADR-0002 §A.1 dice que datos N2/N2-R **nunca** van a
   un entorno de prueba. Cargar el CBU real y correr el PDF contra la base local lo contradice. Hace falta
   declarar el entorno y una entrada en `docs/seguridad/registro-excepciones.md` con **quién autorizó** — eso
   es tuyo, no mío.
3. **`escribirConAuditoria`**: hoy `escritura` está en `ACCIONES` y **no se emite en ningún lugar del repo**. El
   alta de la cuenta es la fila de la que cuelga INV-6 y quedaría sin rastro.
4. **El objeto se guarda dentro de la transacción**: un fallo posterior deja el PDF huérfano en un lugar del que
   el sistema no sabe, sin listado y sin inventario. Va último, con compensación.
5. **`fila_origen` es `jsonb not null` sin forma declarada** — hace falta `filaOrigenSchema` con `.strict()`.
6. **El identificador no puede entrar por argumento del CLI**: queda en el historial de PowerShell, que está
   fuera del repo, del barrido y del `.gitignore`. Va por stdin sin eco.
7. **Ningún agente abre `privado/extractos/`.** Hay que escribirlo en `CLAUDE.md` y `AGENTS.md`: hoy la regla
   vive en el ADR, y el ADR no es lo que se lee antes de abrir un archivo.

### Y antes del adaptador

- **Los 4 detectores que las mutaciones de texto tienen que poner rojos: existen cero.** Y uno de los `it.todo`
  está **mal planteado** — dice `no_verificable` y lo correcto es `no_cuadra`.
- **Cinco agujeros donde ningún invariante ataja**: borrar una continuación de glosa, convertir una continuación
  en movimiento, correr una columna dos caracteres, borrar el encabezado de una página, duplicar la carátula.
- **Ocho rasgos que le faltan al fixture** para poder desarrollar sin mirar el archivo real, que es justo lo que
  el gate existe para evitar. Sobre todo: pares `(fecha, importe)` repetidos (7 grupos en el real, **0** en el
  fixture) y un **segundo fixture** para poder probar `reconoce()` en negativo.

### Para el Módulo 2, decidido ahora porque después es reproceso

- **La depuración de la glosa rompe 6 de las 14 reglas de la contadora** — todas las que tienen por clave un
  número. Solución sin sacrificar el aislamiento: `contraparte_documento_tipo`, `contraparte_documento_hmac`
  (mismo pepper) y `referencias[]` extraídas **antes** de depurar.
- **La regla de tarjetas queda mal igual con el código de concepto**: el importe llega **neto** y los
  componentes no están en el extracto. El plan se contradice consigo mismo; §11 es la versión correcta.
- **`saldo_es_acreedor` tiene la ambigüedad horneada en el nombre**: significa cosas opuestas según el libro, y
  mapear la palabra del banco derecho al booleano **invierte todos los saldos**. Se deriva de la cadena.
- **`knowledge/` está vacío.** Cuatro respuestas quedan en "no tengo esa fuente cargada": cómputo del crédito
  fiscal, régimen de recaudación bancaria provincial, criterio de las RT sobre imputación temporal, y no
  compensación de saldos.

**Ojo con la base local:** se aplicó `0006`.

---

## 2026-08-10 (6) — **Las 12 condiciones de salida del Módulo 1, CERRADAS**

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **277 tests + 4 todo**, 15 archivos de
test; los 18 invariantes SQL con las tres credenciales; el gate de fixtures con sus 7 chequeos.
**Sin commits.**

### Lo que se cerró en esta entrada (9, 6, 8, 10, 11)

| # | Qué | Dónde |
|---|---|---|
| 9 | `packages/almacenamiento`: `ObjectStorage` con **dos credenciales** (lectura/escritura), clave canónica, **emisor único de URL firmada** y el orden **resolver→guardar** | `src/{clave,object-storage,extracto,descarga}.ts` + 26 tests |
| 6 | **INV-6 completo**: resolvedor de cuenta por HMAC con pepper, acotado siempre al cliente declarado | `packages/ingesta/src/resolver-cuenta.ts` + 11 tests |
| 8 | **INV-13**: la glosa se depura antes de ser `descripcion` | `packages/ingesta/src/glosa.ts` + 17 tests |
| 10 | **Fixture sintético + gate de 7 chequeos**, reproducible byte a byte | `tools/{generar,verificar}-fixtures.ts` + 13 tests |
| 11 | **CLI con el guard de R18**, `--cliente` obligatorio, rechazo con `accion='rechazo'` | `apps/cli/src/ingestar.ts` + 10 tests |

### Las decisiones que hay que conocer antes de seguir

1. **El orden resolver→guardar es control de flujo, no disciplina.** No existe una función `guardar` para
   extractos: la única forma es `guardarExtractoTrasResolver(storage, pedido, resolver)`, que **recibe el
   resolvedor y lo ejecuta ella misma**. Guardar primero "para no perder el archivo" escribe el PDF de un
   cliente bajo el prefijo de otro, y a partir de ahí el socio del cliente equivocado se lo baja
   **legítimamente**, con auditoría normal y sin que nada falle.
2. **La clave del objeto lleva el id del LOTE, nunca el hash del contenido.** Una clave derivada del
   contenido vuelve al storage un oráculo de "¿tenés este archivo exacto?".
3. **`administrativo` puede ingestar y NO puede descargar.** Es H-8 literal. Y el `auditor` tampoco:
   verifica que el proceso ocurrió sin necesitar el documento.
4. **La resolución NUNCA pregunta "¿de quién es este CBU?"** — requeriría saltear la RLS y sería un oráculo
   cross-tenant. Va siempre acotada al cliente declarado, y por eso el rechazo **no puede decir** de quién
   es la cuenta (hay un test que verifica que el uuid del otro cliente no aparezca en el resultado).
5. **`cuenta_no_registrada` exige alta por una persona.** Si el archivo pudiera crear la cuenta, el archivo
   definiría la verdad y el control sería tautológico: todo extracto resolvería siempre.
6. **INV-13 es lo que SOSTIENE que `descripcion` sea N2.** Si la glosa conserva el CUIT de una contraparte,
   el dato es de un tercero que nunca consintió nada —o sea N2R— y leer movimientos tendría que pasar por el
   lector auditado. Los identificadores se extraen a la satélite; el **nombre propio se conserva a
   propósito**, porque es lo que el contador necesita para clasificar.
7. **El TTL de la URL firmada tiene tope DURO de 300 s**: se recorta, no se confía en el llamador.

### Los seis hallazgos, ninguno encontrado por una revisión

Están en el plan §10.1 con detalle. El más grave: **la trampa de `for all`** — las policies permisivas de
Postgres se combinan con `OR` y `for all` incluye `SELECT`, así que la policy de escritura de
`movimiento_origen_crudo` (que admite al administrativo porque ingestar es su trabajo) **anulaba** la de
lectura restringida. El control se veía correcto en la migración y no existía en la base. Los otros cinco:
el barrido ciego que daba verde, `LECTORES_AUDITADOS` con strings a un archivo inexistente, `ACCIONES` vs.
el check constraint divergiendo, el CBU truncado por el ancho de columna que ningún patrón reconocía, y el
fixture con fechas desordenadas que habría hecho fallar V7 por culpa del fixture.

### Lo que NO está, dicho explícitamente

- **Ningún adapter de banco.** El CLI rechaza con `adapter_no_disponible` **y lo dice**. Guardar el archivo
  y dejar el lote en `procesado` con cero movimientos sería el peor modo de falla: un lote que nadie
  vuelve a mirar.
- Las **4 mutaciones de texto** siguen `it.todo`: necesitan un adapter para tener sujeto.
- El **pepper** (`IDENTIFICADOR_PEPPER`) es de desarrollo. En producción viene del almacén de secretos.

### Lo que sigue

**E1 del plan §9**: el primer adapter (Galicia), sobre el fixture sintético — nunca sobre el PDF real. El
gate de fixtures existe justamente para que el parser no se calibre contra el archivo del cliente.

**Comandos nuevos:** `pnpm fixtures:generar`, `pnpm fixtures:verificar`, `pnpm barrido:aceptar`,
`pnpm hooks:instalar`, `pnpm ingesta --cliente <uuid> --archivo <ruta> --banco <cod> --usuario <uuid>`.
`pnpm verificar` ahora corre typecheck + barrido + gate de fixtures + tests.

**Ojo con la base local:** se aplicaron `0004` y `0005` sobre base recreada. Si ya tenías la base migrada,
recreala: `drop database` + `pnpm db:migrate && pnpm db:setup`. Y `pnpm install` (hay tres paquetes nuevos:
`almacenamiento`, `apps/cli`, y el SDK de S3).

---

## 2026-08-10 (5) — Condiciones de salida del Módulo 1: nº 4 y nº 5 cerradas (E0 completa)

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **200 tests + 4 todo**, y los 18
invariantes SQL con las tres credenciales sobre base recreada desde cero. **Sin commits.**

### Condición nº 4 — barrido de detectores sobre el REPO (`tools/barrido-fuga.ts`)

Es el control que faltaba: el redactor mira logs, INV-8 mira el logger, R33 mira secretos, y **nadie
miraba el código fuente ni la documentación**, que es donde había entrado la fuga.

**Cuatro correcciones salieron de probar el control en vez de darlo por bueno.** Están documentadas en
ADR-0002 §H.3.bis, y cada una invalidaba la versión anterior:

1. La primera versión fallaba con **18 hallazgos y los 18 eran ejemplos sintéticos legítimos**. La
   pregunta estaba mal: no es "¿hay algo con forma de importe?" sino "¿hay algún **valor del archivo real**
   en el repo?".
2. El cruce por substring dio **9 falsos positivos**, todos embebidos en ruido binario: con 13,5 M de
   caracteres, un token de ocho dígitos aparece por azar. Se pasó a cruce **por token**.
3. Normalizar quitando la coma decimal hacía colisionar el importe `1.111,11` con un **número de operación**
   `111111`. La coma se conserva.
4. **El control era ciego y daba verde.** Leía solo `.txt`, y el material real son PDF y Excel: al plantar
   un importe real **no lo detectó**. Se agregaron los lectores (inflado de streams Flate y entradas ZIP,
   cadenas en Latin-1 y UTF-16) y se hizo **simétrica la definición** — los mismos detectores de los dos
   lados. Recién ahí el importe real plantado apareció, y desapareció al quitarlo.

Dos modos: **estricto** (con `privado/`, cruza contra el material real) y **CI** (allowlist de **huellas**,
nunca valores, en `tools/barrido-aceptados.json`). Corre en `.githooks/pre-commit` —se instala con
`pnpm hooks:instalar`— y como paso de CI. La allowlist **no exime del cruce estricto**: eximir a un test
sería dejar abierta la puerta que el barrido cierra.

### Condición nº 5 — `0004_ingesta.sql` + registro de clasificación + catálogo verde

**Siete tablas**: `banco` (N0 sin tenant) más `cuenta_bancaria`, `cuenta_bancaria_identificador` (N2R),
`lote_ingesta` (N1 estricto), `lote_ingesta_cuenta`, `movimiento_bancario_crudo`,
`movimiento_origen_crudo` (N2R). Las seis enmiendas al contrato de ADR-0001 §5.1 están escritas con su
motivo en la cabecera de la migración. Clasificación completa en `clasificacion-campos.ts`.

### Cuatro problemas encontrados por los tests, no por la revisión

1. **Bug de seguridad real: la trampa de `for all`.** Las policies permisivas de Postgres se combinan con
   **OR**, y `for all` incluye SELECT. La policy de escritura de `movimiento_origen_crudo` admitía al
   `administrativo` (ingestar es su trabajo) y eso **anulaba** la policy de lectura restringida: el
   administrativo leía las filas crudas con los CUIT de las contrapartes — escenario H-8 sin descargar
   nada. La policy de lectura estaba bien escrita; el control se veía correcto en la migración y no existía
   en la base. Corregido declarando la escritura por operación. **`0005_policies_sin_for_all.sql`** aplica
   lo mismo a `credencial_fiscal`, donde el bug hoy NO se manifiesta pero el patrón es una bomba con
   fusible. Hay un test de catálogo que prohíbe el patrón, no la instancia.
2. **`LECTORES_AUDITADOS` era decorativo.** Guardaba **strings**, y `credencial_fiscal` apuntaba a
   `packages/data/src/credenciales.ts`, **que no existía**. El test pasaba porque verificaba que hubiera
   entrada, no que el lector existiera. Ahora el registro guarda la **referencia a la función** (vive en
   `db/lectores-auditados.ts` para no crear un ciclo), y hubo que escribir los tres lectores de verdad.
3. **`ACCIONES` (TS) y el check constraint (SQL) divergían**: el check omitía `uso_credencial`, que el
   código sí emite. Todo registro de uso de una credencial fiscal habría fallado el día que se integrara
   AFIP. Hay un test que compara las dos listas.
4. **`numero` fuera del grant de `app_request`** lo volvía ilegible para TODOS los roles. N2R no significa
   "sin grant": significa rol en lectura **más** auditoría. Sin grant es el control de N3.

### Estado de las 12 condiciones de salida (plan §10)

| # | Condición | Estado |
|---|---|---|
| 1 | Datos reales fuera de los comentarios de `packages/ingesta/src/*` | ✅ verificado, 0 ocurrencias |
| 2 | `.gitignore` anclado, sin negaciones de fixtures | ✅ |
| 3 | Commitear el `.gitignore` antes de `packages/` | ⏳ **tarea del usuario** (no hago commits) |
| 4 | Barrido de detectores sobre el repo, en pre-commit y CI | ✅ 22 tests propios + prueba end-to-end |
| 5 | `0004_ingesta.sql` + clasificación + catálogo verde | ✅ 31 catálogo + 16 aislamiento de ingesta |
| 6 | Test completo de INV-6 (4 casos × 3 aserciones) | ⏳ necesita el resolvedor de cuenta |
| 7 | Logger con allowlist + detector `importe_ar` + `forma()` | ✅ |
| 8 | INV-13: ninguna `descripcion` matchea los detectores | ⏳ necesita el adapter |
| 9 | `packages/almacenamiento` con emisor único de URL firmada | ⏳ |
| 10 | Fixture sintético + `pnpm fixtures:verificar` (7 chequeos) | ⚠️ generador hecho; falta el gate |
| 11 | `accion='rechazo'` + check constraint + guard desde el CLI | ⚠️ base hecha (0004); falta el CLI |
| 12 | `verificarAritmetica` pura + mutaciones | ✅ 11 mutaciones en rojo por su detector |

### Lo que sigue

Condición 9 (`packages/almacenamiento`), después 6 y 8 —que necesitan el resolvedor de cuenta y el
adapter—, y 10 y 11. Recién con las 12 arranca E1.

**Ojo con la base local:** `0004` y `0005` se aplicaron sobre una base **recreada desde cero** (se
corrigieron dos veces antes de que viajaran a un commit). Si otra herramienta ya tenía la base migrada,
tiene que recrearla: `drop database` + `pnpm db:migrate && pnpm db:setup`.

---

## 2026-08-09 (4) — Análisis del cliente piloto + plan del Módulo 1 (panel de 6 agentes)

**Herramienta:** Claude Code. **Estado:** plan cerrado, **construcción del adapter NO iniciada** por
decisión del panel. **Sin commits.**

### Qué se hizo

1. **Transcript de la entrevista** (~68 min) guardado en `privado/laura-transcript.txt`, **fuera del
   repo**. De los cinco formatos se eligió el **VTT** (el único con diarización) y se convirtió a 255
   turnos de conversación. `privado/` agregado al `.gitignore`.
2. **`docs/analisis/00-cliente-piloto-laura.md`** — análisis redactado de la entrevista.
3. **Llegaron los archivos reales**: 8 bancos con PDF, varios con Excel, más FCI (3) y tarjetas (2), y
   **tres documentos de criterio escritos por la contadora** (14 reglas de clasificación bancaria, FCI con
   PEPS, y el circuito de reimputación de tarjetas). El conector de Drive por MCP apunta a la cuenta de
   trabajo y no alcanza la carpeta personal: los archivos se copiaron a `privado/extractos/`.
4. **Panel de 6 agentes**, cada uno adoptando su persona, todos sobre el material real.
5. **`docs/diseno/01-modulo-1-ingesta-bancaria.md`** — el plan completo, escrito para los **8 bancos**.

### El hallazgo que hubo que arreglar antes que nada

`seguridad-datos-financieros` encontró **importes y una glosa del extracto REAL en los comentarios** de
`packages/ingesta/src/{parseo-ar,esquema,hash}.ts`. Verificado contra el archivo: los cinco tokens
presentes. Un comentario viaja al historial de git, a los PRs, al CI y al contexto de cada agente — donde
no hay redactor que lo tape. **Corregido y verificado: 0 ocurrencias.** Y el mecanismo importa más que el
síntoma: **ningún control existente lo detectaba** (el redactor mira logs, INV-8 mira el logger, nadie
mira los comentarios). Falta un barrido de detectores sobre el repo en pre-commit y en CI.

También se corrigió el `.gitignore`: `/privado/` **anclado** (sin anclar hacía desaparecer fixtures
legítimos en silencio) y **eliminadas las negaciones `!**/fixtures/**/*.pdf|xlsx`**, que eran el único
camino por el que un extracto real podía entrar con un `git add -A`.

### Hechos medidos que reemplazan supuestos

- **7 PDFs, no 8**: el de Credicoop es byte-idéntico al de ICBC. **BBVA es imagen pura** (0 caracteres).
- **Galicia reconstruido entero**: 326 movimientos, **cadena de saldos sin una sola ruptura en 325**,
  sumas exactas contra la línea `Total`. La verificación es exacta, no aproximada.
- **Leer por líneas sirve para 3 de 8 bancos.** **Bancor no publica signo**: el débito/crédito sale de la
  cadena de saldos, o sea que la aritmética es **la fuente**, no la red.
- **Detrás de "Excel" hay tres tecnologías**; el `.xls` de Santander es un TSV en Latin-1.
- **`(fecha, importe)` no es clave** (19 colisiones); `(fecha, importe, saldo)` sí (326/326).
- **La ruta y el nombre del archivo no acreditan nada** — hay tres casos de archivo mal ubicado en el
  material de origen. INV-6 no es hipótesis.

### Correcciones a documentos y código propios

Seis refutaciones al análisis (el número de referencia **no** es clave; la premisa del OCR era falsa; nueve
bancos y no cinco; el ancla de cuenta es el número; el padrón es N2R con `estudio_id` y no N0/N1;
PDF/Excel se complementan al revés de lo escrito), **más un cuasi-identificador**: el documento redactaba
bien campo por campo y el **conjunto** identificaba por cruce a una empresa. Regla que deja: **hay que
redactar el conjunto, no solo cada campo.**

Y **once bugs medidos** en el código del Módulo 1, listados en el plan §3.2. Los tres peores fallan en
verde: `importeACentavos` acepta cualquier cadena de dígitos (295 tokens por extracto); `centavosAImporte`
y `importeACentavos` **no son inversas** (Σ = 0 y una verificación que cuadra contra la nada); y
`verificacionSchema` permite `hayTotales: false` con `cuadra: true` — **el verde por vacío está horneado en
el contrato**.

### Tres reglas de la contadora producen un asiento incorrecto

Auditadas contra el extracto real: la 3 (una percepción de IVA mandada a crédito fiscal), la 7 (la comisión
del banco por el servicio de haberes mandada a Sueldos a pagar) y la 11 (la acreditación de tarjeta neta
imputada al bruto). **Los tres desaparecen matcheando código de concepto en vez de texto libre.** Hay que
confirmarlas con ella: son de su criterio, no nuestro.

### Por qué NO se construyó el adapter

El panel lo bloqueó, y coincido: **12 condiciones de salida** en el plan §10. Las dos que lo resumen:
`verificarAritmetica` como función pura con sus cinco ecuaciones, y `mutaciones.test.ts` con sus diez
mutaciones. Sin esas dos, **los 8 bancos son ocho apuestas**.

### Lo próximo

1. Aprobar el plan (o corregirlo).
2. Las 12 condiciones de salida de §10 — dos ya están hechas.
3. Pedirle a Laura las 10 cosas de §11. Las tres urgentes: **padrón de CUIT de socios**, **inventario PEPS
   de apertura** y **liquidación del adquirente de tarjetas** (esta última no está en ningún módulo del
   diseño y sin ella la regla 11 queda mal para siempre).

---

## 2026-08-09 (3) — Cierre de Fase 0: los 7 puntos de ADR-0002 §H.3 que necesitaban código

**Herramienta:** Claude Code. **Estado:** cerrado, con **1 punto parcial declarado**. **Sin commits.**

### Qué se hizo

Scaffolding del monorepo (`pnpm` workspaces, TypeScript estricto, Node 24 con type-stripping nativo
verificado) y los siete puntos:

| # | Punto | Estado |
|---|---|---|
| 1 | `conUsuario()` único punto + guard de arranque | ✅ `packages/data/src/db/conexion.ts` |
| 2 | FK compuestas tenant-consistentes | ✅ `0002_endurecimiento.sql` |
| 3 | Registro de clasificación + redactor de logs | ✅ `packages/shared/src/seguridad/` + `observabilidad/logger.ts` |
| 4 | Policy de rol en lectura para N2-R/N3 | ✅ `0002` + grant a nivel **columna** |
| 5 | Choke point de auditoría | ✅ `packages/data/src/db/auditoria.ts` |
| 6 | Tests de catálogo en CI | ⚠️ tests ✅ y pasando; **el workflow no se ejecutó** (no puedo correr GitHub Actions) |
| 7 | Generador de datos sintéticos | ✅ `packages/data/src/seed/sintetico.ts` + `pnpm db:seed` |

**Gate:** `pnpm verificar` = typecheck estricto + **72 tests, todos pasando**. Más las **3 pasadas SQL**
(18 aserciones) con las tres credenciales distintas. Migraciones `0001`, `0002` y `0003` aplicadas.

### Cuatro hallazgos que salieron de correrlo (no de suponerlo)

1. **`INSERT ... RETURNING` aplica también la política de `SELECT`.** En una tabla append-only —muchos
   escriben, pocos leen— el `returning` falla con *"new row violates row-level security policy"*, que
   hace pensar que el problema es la escritura cuando la escritura está bien. → El id de correlación lo
   genera la aplicación (`0003_auditoria_correlacion.sql`).
2. **El redactor no puede tapar una razón social.** Es texto sin patrón. El barrido INV-8 lo encontró con
   el nombre de un archivo dentro de un `Error`. → **El redactor es la red, no la defensa**: la defensa
   es el tipo cerrado del logger y la regla de no armar mensajes de error con datos del cliente. Quedó
   como test explícito del límite.
3. **El tipo del logger encontró un error en el propio ADR-0002 §D**: el ejemplo usaba `motivo=`, y
   `motivo` es una columna N2. Corregido a `motivo_codigo` en el ADR y en el código.
4. **Limpiar no es una operación de la aplicación.** Ni `app_job` ni `app_request` pueden borrar el rastro
   de auditoría ni las credenciales, y las FK `on delete restrict` bloquean el borrado del árbol: la
   limpieza de tests y de seed la hace el dueño del esquema con `TRUNCATE`.

Dos correcciones de infraestructura, también de correrlo: el detector de cuentas con separadores
matcheaba **UUIDs** (arreglado con lookarounds), y `z.uuid()` de Zod 4 valida versión/variante RFC y
rechaza uuids que Postgres acepta → se valida la **forma**, no el linaje RFC.

### Un punto de diseño abierto, declarado

**Quién escribe `credencial_fiscal.material_cifrado`**: hoy nadie puede por el camino normal (la policy
exige `socio`, el grant de columna es solo de `app_firmador`, y el firmador no tiene membresía). Es
correcto que `app_request` y `app_job` no puedan; falta definir cómo entra la credencial la primera vez.
**Se resuelve con `integraciones-afip`**, que es su dominio. Ver ADR-0002 §H.4.

### Lo próximo

1. **Analizar el transcript de la conversación con Laura** (pedido del usuario) — pendiente de recibirlo.
2. Recién después: **Módulo 1** (extracción de extractos PDF), con `0004_ingesta.sql` según el contrato de
   ADR-0001 §5.1. Falta definir el **banco piloto** y de dónde sale el PDF real (que **no** puede entrar
   al repo: ADR-0002 §F.2).

---

## 2026-08-09 (2) — Base de arquitectura: stack, tenancy y seguridad (3 ADRs + migración verificada)

**Herramienta:** Claude Code. **Estado:** cerrado. **Sin commits** (pedido explícito del usuario).

### Qué se hizo

1. **`docs/arquitectura/ADR-0000-stack-infra.md`** — TypeScript estricto + Zod; monorepo pnpm desde el
   primer commit; **el Módulo 1 arranca sin app web** (`apps/cli` + `packages/ingesta`, decisión
   fundamentada en §2.2); las tres abstracciones (Drizzle/Postgres, `AuthProvider`, `ObjectStorage`
   S3-compatible); migraciones `drizzle-kit` en SQL plano; Docker local; y la tabla de portabilidad para
   **Google Cloud / AWS / Vercel+Supabase / self-hosted**.
2. **`ADR-0001-tenancy.md`** — tenancy jerárquica portada de `admin-barrios`: **estudio = raíz, cliente =
   hijo**, `tenant_node` con materialized path, `membership`, las tres funciones (`app.current_user_id`,
   `app.accessible_tenant_ids`, `app.has_role_on`), roles `app_request` / `app_job`, la **plantilla de
   siete renglones** obligatoria para toda tabla de dominio, y el contrato del Módulo 1.
3. **`ADR-0002-seguridad.md`** — cinco niveles de datos (N0/N1/N2/N2-R/N3) con control por nivel; **35
   reglas verificables** (R1–R35) con su estado; 18 invariantes de aislamiento; política de logging con
   ejemplos aceptable/inaceptable; custodia y rotación de credenciales fiscales; datos de prueba;
   huecos normativos G-1..G-8. Contenido producido por el agente **`seguridad-datos-financieros`**,
   convocado explícitamente.
4. **`packages/data/migrations/0001_tenancy.sql`** — escrita **y aplicada contra PostgreSQL 16 real**.
5. **`packages/data/sql/tests/0001_aislamiento.test.sql`** — **18 aserciones, todas pasando** (tres
   pasadas, una por rol). Ver §C.0 del ADR-0002 para la lista.
6. **`docker-compose.yml` + `.env.example` + `.gitignore` + `packages/data/sql/db-setup.sql`** —
   infraestructura local levantada y verificada de punta a punta (runbook en ADR-0000 §4.1).
7. **`docs/seguridad/`** — `registro-terceros.md`, `registro-incidentes.md`, `registro-excepciones.md`
   (vacíos, con su procedimiento).
8. **Sync**: `CLAUDE.md` §1 (cuatro reglas duras reales, ya sin placeholders) y §2 (convenciones del
   stack); `AGENTS.md` §0 (ADRs como lectura obligatoria) y §2 (las tres reglas de esquema).

### Un bug real encontrado y corregido

El agente `seguridad-datos-financieros` encontró que el diseño portado tenía el trigger de `path` **solo
en `BEFORE INSERT`** (hallazgo H-1, crítico). Consecuencia: un `update tenant_node set parent_id = …`
dejaba el `path` viejo, y como `accessible_tenant_ids()` resuelve el subárbol **por path**, un usuario de
un estudio empezaba a ver clientes de otro — en silencio. **Corregido**: trigger en `update of
parent_id`, trigger que rechaza editar `path` a mano, `app.verificar_coherencia_path()` (para CI y para
un job en producción) y `app.reparentar_nodo()` que aborta si deja el árbol incoherente. Verificado con
las aserciones P1-A..P1-D.

### Dos cosas que salieron de correrlo, no de suponerlo

- **El dueño del esquema NO puede sembrar el nodo raíz:** `force row level security` le aplica las
  políticas también a él. La siembra la hace `app_job`. Corolario: **en producción el dueño del esquema
  no debe ser superusuario** (un superusuario ignora RLS siempre).
- **`BYPASSRLS` saltea políticas, no otorga privilegios**, y los **atributos** de rol no se heredan por
  `GRANT`. Por eso `app_job` es el rol que se conecta y necesita grants explícitos — y por eso **ni él
  puede borrar `acceso_auditoria`** (verificado en P1-0).

### Estado verificado (respuesta a las tres preguntas del usuario)

| Pregunta | Respuesta |
|---|---|
| ¿Soporta multi-tenant? | **Sí, y está probado** contra Postgres real: 18 aserciones, incluidas las dos direcciones del aislamiento, la herencia de subárbol, el fallo cerrado sin identidad y la trampa del prefijo de path. |
| ¿Tiene niveles de seguridad definidos? | **Sí, definidos** (5 niveles + 35 reglas + 18 invariantes). **Parcialmente implementados**: lo que vive en la base está hecho y verificado; lo que necesita código está listado como condición de salida en ADR-0002 §H.3. |
| ¿Es agnóstico de despliegue? | **Sí, por diseño**, con 3 puntos a confirmar contra el proveedor elegido (roles con `BYPASSRLS`, pooling en transaction mode, URL firmadas en Cloud Storage). ADR-0000 §6 y §9. |

### Lo próximo, en orden

1. **Scaffolding del monorepo** (`package.json`, `pnpm-workspace.yaml`, `tsconfig`), porque siete de los
   ocho puntos de ADR-0002 §H.3 necesitan que exista código.
2. **`conUsuario()` en `packages/data`** con el guard de arranque que rechaza `BYPASSRLS`/superusuario en
   el proceso de request, y el registro de clasificación de campos.
3. **Módulo 1 (ingesta)** con `0002_ingesta.sql` según el contrato de ADR-0001 §5.1 — `cliente_id` desde
   la primera fila, unicidad `(cliente_id, fila_hash)`, FK compuestas tenant-consistentes.

---

## 2026-08-09 — Alta de los agentes de dominio + esqueleto de `knowledge/`

**Herramienta:** Claude Code. **Estado:** cerrado. **Sin commits** (pedido explícito del usuario).

### Qué se hizo

1. **8 agentes de dominio** dados de alta con la estructura portable de 3 archivos
   (`agents/personas/<n>.md` + `agents/wrappers-claude/<n>.md` + `.claude/agents/<n>.md`):
   `contador-dominio`, `fiscal-nacional-iva-ganancias`,
   `fiscal-ingresos-brutos-convenio-multilateral`, `integraciones-afip`,
   `motor-conciliacion-contable`, `plan-cuentas-multicliente`, `balances-normas-tecnicas`,
   `seguridad-datos-financieros`.
2. **`.claude/agents/` creado y activado** con los 11 wrappers (8 nuevos + los 3 genéricos del template,
   que no estaban activados).
3. **Esqueleto de `knowledge/`** (carpetas + un README por carpeta, **sin contenido normativo**):
   `nacional/{iva,ganancias,sire}`, `interjurisdiccional/convenio-multilateral/{regimen-general,
   regimenes-especiales,sifere}`, `provincial/` (con `_PLANTILLA-provincia.md`, **sin ninguna provincia
   creada**), `clientes/` (con `_PLANTILLA-jurisdicciones-activas.md`), más `README.md`,
   `JURISDICCIONES-ACTIVAS.md` y `_FUENTES.md`.
4. **`docs/agents/guia-carga-conocimiento.md`**: qué cargar primero, en qué orden y de qué fuente
   oficial. Mínimo viable = IVA + Ganancias nacional, y el IIBB de la primera provincia real.
5. **Sync de tablas** en `agents/README.md` (roster completo + guardrails + matriz de convocatoria +
   checklist de sincronía), `CLAUDE.md` (§1.6 y §1.7 nuevas reglas duras; §3 tabla de sub-agentes) y
   `AGENTS.md` (§1 las dos reglas que Codex tiene que tener presentes; §3 roster y puntero a `knowledge/`).

### Decisiones que quedan escritas

- **Dos agentes fiscales, no uno.** El reparto interjurisdiccional (coeficientes, atribución de ingresos
  y gastos, regímenes especiales, SIFERE) tiene complejidad propia y no se resuelve con criterios
  nacionales. Están separados a propósito y se derivan trabajo entre sí.
- **No hay "jurisdicción activa" única.** A diferencia de `admin-barrios`, acá un cliente puede tener
  **varias jurisdicciones simultáneas** por Convenio Multilateral. Modelado como **colección con
  vigencia** por cliente (`knowledge/JURISDICCIONES-ACTIVAS.md` +
  `agents/personas/plan-cuentas-multicliente.md`).
- **Asistido, no automático** (regla dura `CLAUDE.md` §1.7): el motor de conciliación **propone** con
  evidencia y deja en cola de revisión del contador; nunca registra solo, ni con score máximo.
- **Ninguna provincia creada en `knowledge/provincial/`**, a propósito: la ley impositiva es anual y un
  relevamiento "por las dudas" envejece antes de usarse. Se crea la primera cuando se sepa la del
  cliente piloto.
- **El motor de conciliación del gas está disponible y verificado en disco**
  (`C:\Proyectos_Desa\trazabilidad-obra-gas\src\services\conciliacion\{matcher,reglas,reversas,
  imputacion-service}.ts`, `src/domain/cuit.ts`, `src/lib/normalizar-texto.ts`). El análisis de reuso ya
  escrito para el otro producto (`admin-barrios\docs\diseno\02-reuso-conciliacion.md`) sirve de base;
  **no** se copió código todavía.

### Supuestos marcados

- **Nombre del proyecto = `sistema-contable`** (el del repo). Se usó en los wrappers. Los placeholders
  `<NOMBRE_PROYECTO>`, `<REGLA_DURA_1..4>` y los de `docs/devops/*` **siguen sin completar**: no eran
  parte del pedido.
- **`AFIP` → `ARCA`**: el cambio de denominación del organismo está anotado como `[A VERIFICAR]`.
  Denominación exacta, URLs y nombres de servicio se verifican contra fuente oficial antes de escribirlos
  en un doc o en código.
- **Números de norma y de RT**: el único que aparece afirmado en todo lo escrito es **RT 41** (variante
  para entes pequeños/medianos), porque lo indicó el usuario al definir el alcance del agente — y aun así
  queda sujeto a verificación contra FACPCE al cargarlo. Ningún otro número de norma se escribió.

### Qué NO se tocó (a pedido)

**Ingesta bancaria** y **tenancy**: etapa siguiente. Las personas de `motor-conciliacion-contable` y
`plan-cuentas-multicliente` delimitan explícitamente qué **no** deciden todavía sobre esos dos temas.

### Lo próximo, en orden

1. **Cargar `knowledge/nacional/iva/` y `knowledge/nacional/ganancias/`** — es lo único que desbloquea a
   `fiscal-nacional-iva-ganancias` para toda la cartera. Hoy `knowledge/` está vacío y **todos** los
   agentes fiscales responden "no tengo esa fuente cargada".
2. **Definir la provincia del cliente piloto** y si es unilateral o de Convenio → crear
   `knowledge/provincial/<provincia>/iibb/` desde la plantilla; si es de Convenio, cargar además
   `interjurisdiccional/convenio-multilateral/`.
3. Recién después: ingesta bancaria y tenancy.
