# 34 — Modelo de interacción del wizard de la demo interactiva

> **Qué es este documento.** Cierra 3 preguntas sobre el modelo de interacción del wizard de 8 pasos de
> la demo interactiva (Frente 2), que quedaron abiertas después de que se cerraran las 8 preguntas de
> diseño originales y se publicara el boceto de Pantalla 1 ("Elegir cliente"). Convocatoria real a
> `ux-designer` + `analista-funcional`, en paralelo, cada uno con dictamen propio (2026-09-14). Las dos
> personas convergen en las 3 respuestas; `analista-funcional` las verificó contra código real y datos
> medidos, no contra intuición de diseño.
>
> **Por qué existe.** Las dos personas convocadas lo pidieron explícito: "planes y dictámenes van al
> repo" — si esto queda solo en el chat, no existe para la próxima sesión ni para Codex, y las pantallas
> que faltan bocetar (5 de la numeración final de 6, más la de cierre del bucle — ver §0) se construirían
> sobre una base que nadie puede volver a consultar.

---

## 0. Numeración final — 6 pasos, fijada por el titular (2026-09-15)

El listado original de 8 pasos nunca se recuperó (registro de la búsqueda, sin resultado, más abajo). El
titular resolvió el punto de forma directa, sin esperar a reconstruir la lista perdida: la numeración
final del wizard es de **6 pasos**, no 8 — incorpora la fusión de §1.2 y colapsa además otras posiciones
que el listado original tenía por separado.

| # | Paso | Estado |
|---|---|---|
| 1 | Elegir cliente | Ya bocetado y aprobado (Artifact publicado) |
| 2 | Subir extracto bancario | Bocetado 2026-09-16, dentro del marco de doc 36 (header global + sidebar + panel) — [Artifact](https://claude.ai/artifact/9aPArKYhBdMjX9zj6WLh6F). Pendiente de aprobación del titular |
| 3 | Resumen de la extracción | Pendiente de boceto |
| 4 | Procesar y tipificar | Pendiente de boceto |
| 5 | Revisar e imputar (fusión de "revisar tipificaciones" + "imputación a cuentas contables", ver §1.2) | Pendiente de boceto |
| 6 | Generar asiento contable | Pendiente de boceto |

**Pantalla de cierre del bucle — fuera de la numeración principal** (resolución completa en §1.1): no es
"un paso 7", es una transición de estado entre sesiones del wizard. Sus dos acciones van al mismo nivel
visual, sin ninguna marcada como default:

- "Elegir otra cuenta del mismo cliente" → vuelve al paso 2 con `clienteId` ya fijado.
- "Elegir otro cliente" → vuelve al paso 1, estado del wizard completamente limpio.

**Registro de la búsqueda que no encontró el listado original** (para que quien retome esto no la
repita): al escribir la primera versión de este documento se buscó, sin éxito, el listado original de
los 8 pasos (nombres, orden, contenido de cada uno) en todo `docs/` y en `HANDOFF.md` — no existe en
ningún archivo. Tampoco está en el `.dc.html` publicado de Pantalla 1: los pasos 2 a 8 del stepper solo
tienen el número, sin etiqueta (`<div class="etiqueta">&nbsp;</div>` × 7, verificado por
`analista-funcional` línea por línea contra el Artifact real). El listado original vivió solo en una
conversación anterior y no se persistió a ningún lado. La tabla de arriba **reemplaza** ese listado
perdido — no lo reconstruye.

---

## 1. Los tres hallazgos originales, con su resolución

### 1.1. El bucle del último paso — es un bucle real, no un final

**Hallazgo** (`ux-designer` + `analista-funcional`, convergentes): la contadora no procesa un cliente por
sesión — procesa cuentas bancarias en volumen, a través de varios clientes. Un wizard que termina en un
punto muerto después de cada cuenta obliga a re-entrar manualmente cada vez, fricción que no existe en
el papel de hoy de Laura (pasa de una hoja del Excel a la siguiente sin "cerrarlo"). El paso final,
además, no es un paso más: dispara `confirmarGrupo()`/`confirmarAsiento()` sobre filas que
`app.exigir_inmutabilidad_post_terminal()` (`0028_inmutabilidad_post_terminal_cierre.sql`) vuelve
inmutables — es un punto de no retorno real.

**Dato medido, no supuesto** (`analista-funcional`, contra la maqueta real de Pantalla 1): de los 6
clientes de ejemplo del boceto, **4 de 6 (67%) tienen más de una cuenta bancaria** (3, 1, 2, 4, 2, 1
cuentas respectivamente). El caso de "otra cuenta del mismo cliente" no es un caso raro.

**Resolución (titular, 2026-09-14, punto 1 de la consulta)**: Laura no tiene un patrón fijo de trabajo —
salta entre clientes y bancos sin encadenar necesariamente las cuentas de un mismo cliente. Por eso la
pantalla de cierre del bucle muestra las dos acciones **al mismo nivel visual, sin ninguna marcada como
default ni más prominente que la otra**:

- "Elegir otra cuenta de \<mismo cliente\>" → salta directo al paso de selección de cuenta con
  `clienteId` ya fijado.
- "Volver a Elegir cliente" → paso 1 literal, estado del wizard completamente limpio.

**Esta pantalla de cierre vive FUERA de la numeración principal 1-6** (ver §0) — no es "un paso 7", es
una transición de estado entre sesiones del wizard. El stepper de 6 círculos representa los pasos de esta
cuenta, no "6 de infinitas".

**Criterios de aceptación** (`analista-funcional`):

| AC | Cómo se comprueba |
|---|---|
| Ningún avance automático sin clic tras completar el último paso | El estado del wizard no cambia hasta un evento de click explícito |
| Las dos acciones se muestran con el mismo peso visual (mismo tamaño, mismo tono, sin badge de "recomendado") | Revisión del boceto: ningún botón con estilo primario/secundario diferenciado entre las dos |
| "Otra cuenta del mismo cliente" preserva `clienteId` sin re-elegirlo | Test: 0 clics para volver a ver el mismo cliente seleccionado en el paso siguiente |
| "Elegir otro cliente" limpia TODO el estado del wizard | Test: snapshot del estado tras esa acción === snapshot de entrada fresca |

---

### 1.2. Revisar e imputar — una sola vista, no dos pantallas

**Hallazgo, con evidencia de código, no solo de estilo** (`analista-funcional`):

1. El dominio ya modela esto como una sola cosa: `GrupoDecisionPendiente`
   (`packages/ingesta/src/cierre/agrupar-decisiones-pendientes.ts:77-88`) trae `cuentaPropuesta` y
   `requiereRevision` en el **mismo objeto** — no hay dos colecciones separadas de "grupos para revisar"
   y "grupos para imputar".
2. El artefacto real que Laura usa hoy ya es una sola vista: la hoja "Grupos" del Excel
   (`apps/cli/src/confirmar-grupo.ts:9-11`, decisión de JP del 2026-09-12) — un dropdown por grupo,
   pre-llenado con la confirmación del mes anterior, que ella corrige o acepta en el mismo gesto. No hay
   un paso previo de "solo mirar".
3. Volumen real medido (`docs/diseno/31-replanteo-hacia-producto.md:66-68`, Bracci julio 2026): 1081
   movimientos → 518 propuestos automáticamente + 563 para decidir — órdenes de magnitud comparables,
   ninguna categoría domina lo suficiente como para justificar dos flujos separados.
4. `ADR-0006` §16 (decisión del titular, 2026-09-14) ya resolvió el mismo tipo de distinción
   ("propuesta" vs. "decisión humana") a favor de un estado visual distinto dentro de la misma tabla, no
   de una pantalla aparte — para PR4 (de solo lectura), pero mismo criterio aplicable acá.

Regla dura de `ux-designer`, citada como respaldo adicional: *"Reduce la decisión, no la información.
Frente a una propuesta de asiento la pregunta tiene que ser binaria, y estar al lado de lo que la
justifica."* Separar "ver evidencia" de "decidir" en dos pantallas rompe esto — obliga a sostener en la
cabeza la evidencia de la pantalla anterior mientras se decide en la siguiente.

**Resolución (titular, 2026-09-14, punto 2 de la consulta)**: confirmado contra el mensaje original de
JP, verificado línea por línea — "revisar tipificaciones" e "imputación a cuentas contables" eran dos
viñetas separadas en el conteo original de 8 pasos. **Se fusionan en un solo paso/vista**: cada grupo
trae su evidencia y su acción de confirmar en el mismo bloque visual, con estado distinguido (propuesta
del motor / memoria de confirmación previa / sin regla). Esta fusión es el paso 5 de la numeración final
de 6 pasos que el titular fijó el 2026-09-15 (ver §0) — "Revisar e imputar".

**Criterios de aceptación** (`analista-funcional`):

| AC | Cómo se comprueba |
|---|---|
| Una sola vista consume `GrupoDecisionPendiente[]` completo, sin split en dos endpoints/pantallas | 1 solo fetch, 1 sola pantalla numerada del wizard para esto |
| Estado visual distingue ≥3 casos: propuesta sin revisión pendiente, requiere revisión, sin regla (`cuentaPropuesta===null`) | Contra Bracci julio: los 3 baldes existen con conteo > 0 cada uno |
| Confirmar una fila no exige haber "revisado" en un paso anterior separado | Ningún gate de UI bloquea el click de confirmar detrás de una pantalla de solo lectura previa |

---

### 1.3. El stepper no debe prometer un rollback que el sistema no tiene

**Hallazgo, hecho de código, no zona gris** (`analista-funcional`): `confirmarAsiento()`
(`packages/data/src/cierre/escrituras.ts:604-632`) hace `UPDATE ... where asiento_estado = 'propuesto'`
— si 0 filas afectadas, devuelve `{estado:'conflicto', motivoCodigo:'asiento_no_estaba_propuesto'}`,
nunca permite volver de `'confirmado'` a `'propuesto'` por ese camino. El trigger
`app.exigir_inmutabilidad_post_terminal()` (`0028`) lo refuerza un nivel más abajo: un intento directo
contra un estado terminal muere con `P0002`, no en silencio. El propio comentario de esa migración
declara "reabrir un período confirmado" como capacidad **prevista para el futuro**, no existente hoy —
y cuando exista, va a requerir motivo obligatorio y supersesión (mismo patrón que `revocaId`), nunca un
simple "volver un paso".

Un stepper cuyos círculos anteriores se ven clickeables y no responden es, en palabras de `ux-designer`,
un estado de error no diseñado — y esta persona tiene como regla explícita "diseñar el error, no solo el
camino feliz". Un clic mudo en un producto que maneja plata invita a desconfiar de todo el resto de la
UI, justo cuando la garantía de integridad es lo que más importa comunicar bien.

**Resolución**: sí hace falta un criterio de aceptación explícito. No alcanza con que el click no lleve a
ningún lado.

- Un paso **ya confirmado** (estado terminal post-`0028`) no tiene cursor de puntero ni hover de
  navegación — se muestra como estado (candado + check, tono "cerrado"), no como botón.
- Al enfocar/hacer hover sobre un paso cerrado, se muestra el motivo real en el vocabulario de la
  contadora (quién y cuándo lo confirmó) y un puente explícito hacia el mecanismo real de corrección
  (`revocaId`, supersesión), nombrado como "Corregir esta decisión" — nunca como un botón "atrás".
- Dos comportamientos distintos del stepper, no uno: pasos **previos a la confirmación** (elegir
  cliente, elegir cuenta, etc. — sin estado persistido todavía) navegables libremente hacia atrás; pasos
  **posteriores a `confirmarGrupo()`/`confirmarAsiento()`** pasan al modo "cerrado + motivo + camino de
  corrección".

**Hallazgo sobre lo ya publicado, no bloqueante hoy**: el CSS real de la Pantalla 1 (`.paso`,
`.paso.activo`) solo tiene dos estados — activo y default. No existe un tercer estado visual
"confirmado / no editable". Esto no rompe la Pantalla 1 ya publicada (el paso 1 nunca puede estar en ese
estado — es el primero, nada que confirmar todavía), pero **la Pantalla 2 en adelante necesita ese
tercer estado agregado al sistema de tokens antes de bocetarse** — requisito nuevo, no cubierto en
ningún documento anterior.

**Criterios de aceptación** (`analista-funcional`):

| AC | Cómo se comprueba |
|---|---|
| Un paso con estado terminal no responde a un click de navegación hacia ese paso | Test de UI: `disabled`/sin `onClick` en `.paso` con estado `confirmado` |
| Ningún flujo de la UI llama a `confirmarAsiento`/`confirmarGrupo` esperando "deshacer" | La única corrección es `revocaId` — cero call sites que reintenten un UPDATE ya cerrado |
| Un `conflicto`/`P0002` del backend sobre un paso terminal se traduce a "ya confirmado — para corregirlo, usá revocar", nunca a un error genérico | Test: fixture que fuerza el conflicto, assert sobre el copy mostrado |

---

## 2. Lo que esto cambia en lo ya construido

- **Pantalla 1 ("Elegir cliente"), ya publicada y aprobada**: sigue vigente tal como está. El caso de
  "vuelvo acá después de terminar una cuenta, viniendo de la pantalla de cierre del bucle" NO se agrega
  a la Pantalla 1 misma — la resolución del titular (§1.1) deja esa pantalla de cierre fuera de la
  numeración principal y como paso propio, no como una variante de entrada de Pantalla 1. No hace falta
  reabrir el boceto ya aprobado por este hallazgo.
- **El conteo pasa de 8 a 6 pasos**, fijado por el titular (§0): 1) Elegir cliente, 2) Subir extracto
  bancario, 3) Resumen de la extracción, 4) Procesar y tipificar, 5) Revisar e imputar (fusión de §1.2),
  6) Generar asiento contable — más la pantalla de cierre del bucle (§1.1), fuera de esa numeración.
- **El sistema de tokens de diseño necesita un tercer estado visual de paso** ("confirmado / cerrado"),
  antes de bocetar la Pantalla 2 en adelante (§1.3) — no estaba pedido en ningún documento previo.
- **La pantalla de cierre del bucle** (§1.1) es una pantalla nueva, no contemplada en el conteo original
  de 8 — vive fuera de esa numeración.

## 3. Pendiente antes de retomar el boceto pantalla por pantalla

1. ~~Recuperar o reconstruir el listado original de los 8 pasos~~ — **resuelto** (§0): el titular fijó
   la numeración final de 6 pasos de forma directa el 2026-09-15, sin necesidad de reconstruir la lista
   perdida.
2. Agregar el tercer estado visual de paso ("confirmado / cerrado") al sistema de tokens antes de
   bocetar Pantalla 2.
3. Con (2) resuelto, retomar el proceso de una pantalla a la vez (boceto → aprobación → código) para la
   Pantalla 2 ("Subir extracto bancario") en adelante, en el orden de la tabla de §0.

---

## 4. Coherencia de §1.3 con el paso 5 fusionado (convocatoria 2026-09-16)

> Convocatoria: `ux-designer`, sola (2026-09-16). Corrige una premisa con la que llegó la convocatoria:
> no existe ningún boceto de "Pantalla 5" — este dictamen es análisis sobre el texto de §1.2/§1.3 y el
> código citado ahí, no sobre una pantalla dibujada. A diferencia del resto de este documento, esta
> sección no tuvo convocatoria conjunta con `analista-funcional`; el punto 4 de la Resolución queda
> marcado explícitamente como pendiente de esa verificación, no como AC cerrado.

### Hallazgo

§1.3 fue escrito con la unidad "paso" tratada como átomo: pre-confirmación (navegable) vs.
post-confirmación (cerrado). En el conteo original de 8, "revisar tipificaciones" e "imputar a cuentas
contables" eran dos pasos separados, y cada uno tenía un único evento terminal que lo cerraba entero.

Con la fusión de §1.2, el paso 5 ("Revisar e imputar") ya no tiene un único evento terminal: contiene N
filas de `GrupoDecisionPendiente[]`, cada una con su propio `confirmarGrupo()` independiente — y §1.2 ya
estableció, como AC explícito, que "confirmar una fila no exige haber revisado en un paso anterior
separado" ni exige un "confirmar todo el paso" de una vez. Aplicar el candado de §1.3 al PASO completo
tal cual está escrito produce un estado sin sentido: con 12 de 23 grupos confirmados, ¿el círculo del
stepper está cerrado o abierto? Los dos AC originales de §1.3 ("no responde a click", "hover muestra
motivo") no tienen respuesta binaria en ese punto intermedio — y ese punto intermedio es el caso normal
del paso 5, no la excepción: un archivo de volumen real (Bracci, julio 2026 — citado en §1.2) tiene 563
grupos para decidir, no se resuelven en un solo gesto.

Además, `confirmarGrupo()` y `confirmarAsiento()` (paso 6) no son el mismo evento ni tienen el mismo
alcance: el primero cierra una fila; el segundo cierra el asiento completo, y es el que corresponde al
"punto de no retorno real" que describe §1.1. Tratarlos como si dispararan el mismo comportamiento de
paso (candado de paso completo) confunde dos niveles de inmutabilidad que el propio esquema (`0028`) ya
distingue por fila/entidad, no por paso del wizard.

### Resolución

El candado de §1.3 sigue siendo el contrato correcto — pero se aplica en **dos niveles distintos**, no
en uno:

1. **Nivel fila** (dentro del paso 5, en el contenido, no en el stepper): el contrato completo de §1.3
   se aplica tal cual, fila por fila. Apenas `confirmarGrupo()` cierra un grupo, esa fila puntual pasa a
   modo "cerrado" — sin cursor de edición inline, con candado+check, y con el mismo hover "quién y
   cuándo lo confirmó" + puente a "Corregir esta decisión" (`revocaId`). Las demás filas del mismo paso
   siguen abiertas y editables en simultáneo. Es una extensión directa de §1.3, aplicada al grano real
   del dominio (`GrupoDecisionPendiente`, no "paso").

2. **Nivel paso** (el círculo del stepper): mientras el wizard sigue en la sesión de esta cuenta, el
   círculo 5 del stepper **nunca entra en el modo "cerrado sin puntero"** de §1.3 — permanece navegable
   incluso con grupos ya confirmados adentro, porque siempre hay una razón legítima para volver (ver el
   resto de los grupos, corregir uno vía `revocaId`). El modo "cerrado sin puntero, solo hover" que
   §1.3 describe corresponde al evento de `confirmarAsiento()` en el paso 6 — ahí sí hay un único
   evento terminal de alcance completo, coherente con "punto de no retorno real" de §1.1. Cuando eso
   ocurre, el candado real de §1.3 aplica al stepper completo (los 6 círculos de esa cuenta), consistente
   con que la sesión completa del wizard para esa cuenta queda cerrada.

3. El círculo 5 necesita, mientras tanto, un estado visual propio — **no** "cerrado" ni "activo": progreso
   parcial, con contador (`12/23 confirmados`, en el vocabulario de Laura: "grupos"). Es una cuarta
   variante del sistema de tokens, adicional a la tercera que ya señaló §1.3 (el estado binario
   "confirmado/cerrado" a nivel paso) — acá se aclara que ese tercer estado nunca se usa tal cual en el
   paso 5 (no hay paso 5 "cerrado" antes de paso 6), y hace falta un cuarto: "en progreso, con contador".

4. Gate para avanzar de paso 5 a paso 6: cada grupo necesita haber llegado a un estado terminal —
   confirmado **o** marcado explícitamente `indeterminado` con su motivo — antes de habilitar el botón de
   avance. Un grupo sin tocar (ni confirmado ni marcado indeterminado) bloquea el avance; un grupo
   `indeterminado` con motivo explícito **no** bloquea, porque ya es una decisión tomada en el sentido de
   la regla dura de `ux-designer` ("el 'no sé' es un estado usable, no un hueco"). **Esto es una propuesta
   de criterio de producto, no una verificación de código** — a diferencia del resto de este documento, no
   fue confirmada contra un call site real ni por `analista-funcional`; queda marcada como pendiente de
   esa verificación antes de convertirse en AC cerrado.

### AC

| AC | Nivel | Cómo se comprueba |
|---|---|---|
| Una fila con `confirmarGrupo()` ya aplicado no tiene cursor de edición inline; las demás filas del mismo paso siguen editables | Fila | Test de UI: `disabled`/sin handler de edición solo en las filas con estado confirmado, no en el resto del paso |
| Hover sobre una fila cerrada muestra quién y cuándo la confirmó, y el puente "Corregir esta decisión" hacia `revocaId` | Fila | Mismo test que el AC de fila de §1.3, aplicado por fila en vez de por paso |
| El círculo 5 del stepper es clickeable/navegable en todo momento mientras la sesión del wizard sigue abierta, sin importar cuántos grupos tenga confirmados adentro | Paso | Test: click sobre el círculo 5 navega, con 0, algunos o todos los grupos confirmados |
| El círculo 5 nunca muestra el modo "cerrado sin puntero" de §1.3 antes de que ocurra `confirmarAsiento()` en paso 6 | Paso | Revisión de estados: el único evento que dispara ese modo para los 6 círculos es `confirmarAsiento()`, ningún `confirmarGrupo()` individual lo dispara por sí solo |
| El círculo 5 muestra un contador de progreso (`n/m`) mientras hay grupos mixtos (algunos confirmados, algunos no) | Paso | Fixture con confirmación parcial: el contador coincide con el conteo real de filas cerradas |
| **(propuesto, no verificado)** El botón de avance a paso 6 se habilita solo cuando cada grupo tiene estado confirmado o indeterminado explícito — nunca con un grupo sin tocar | Paso | Pendiente: verificar contra el código real de habilitación del botón (no identificado en este dictamen) antes de tomarlo como AC cerrado |

### Lo que no cambia

Los tres AC originales de §1.3 sobre el `confirmarAsiento()` de paso 6 siguen vigentes tal cual, sin
ajuste — paso 6 sí es el "paso" atómico con un único evento terminal que la redacción original de §1.3
asumía en general. El ajuste de esta sección es específico al paso 5 fusionado.

---

## 5. Estados de token pendientes, resueltos — Pantalla 2 bocetada (2026-09-16)

> Convocatoria: `ux-designer`, sola. Cierra el pendiente de §3 punto 2 (tercer estado visual de paso) y
> el de doc 36 §7 punto 1 (estado "próximamente"), antes de bocetar Pantalla 2 tal como pedían los dos
> documentos.

### Dónde viven los tokens — corrección de una atribución equivocada

Los tokens `--om-*` que doc 36 §5 citaba como "ya definidos en el Artifact de Pantalla 1" **no son del
boceto**: son el CSS del *editor* Claude Design (el canvas `appifact` como herramienta), compartido por
cualquier canvas — nunca visible dentro del `<x-dc>` que aísla el contenido real. El sistema de tokens
propio de Pantalla 1/2 vive en `content.files["Main.dc.html"]`, con su propio `:root` en español:
`--papel`, `--tinta`, `--tinta-suave`, `--registro`, `--propuesta`, `--confirmado`, `--alerta`,
`--linea`, `--superficie` — el mismo vocabulario que ya usan `.paso`/`.paso.activo`/`.etiqueta`. Doc 36
§5 queda con esta corrección pendiente de aplicarse ahí (ver también HANDOFF).

### Los dos estados, resueltos

Insertados en el `:root` real (Artifact de Pantalla 1, versión 3): tres tokens nuevos —
`--fondo-seleccionado`, `--fondo-mudo`, `--tinta-inactiva` — reusando `--confirmado` (ya existía, sin
usar) para el color del estado "cerrado", sin inventar paleta nueva.

- **"confirmado/cerrado"** (nivel paso, §1.3/§3): clase `.paso.cerrado` — candado + check, sin cursor de
  navegación, tooltip en hover/foco con "Confirmado por [quién] el [cuándo]" + el puente "Corregir esta
  decisión". Semántica real (`<button class="paso cerrado">`, no un `div` con `onClick`). **No se
  renderiza todavía en ningún boceto** (ni paso 1 de Pantalla 1 ni ningún paso de Pantalla 2 puede estar
  cerrado hoy) — queda definido en el sistema de tokens, listo para cuando se boceten los pasos 5/6.
- **"próximamente"** (sidebar, doc 36 §2 regla 2): `.nav-item[aria-disabled="true"]`, con
  `tabindex="0"` (nunca `disabled` nativo — sacaría el ítem del tab order y rompería el AC de foco de
  doc 36) y tooltip expuesto en hover **y** en foco. Sí está renderizado y funcionando en Pantalla 2 (ver
  abajo).

### Hallazgo nuevo — un tercer estado de paso que §1.3 nunca estiló: `.paso.default-navegable`

§1.3 definió en detalle el contrato de "cerrado" (pasos posteriores a la confirmación) pero nunca estiló
el otro lado de la misma distinción: "pasos previos a la confirmación... navegables libremente hacia
atrás". Pantalla 1 nunca necesitó ese estado (es el primer paso, no tiene ningún paso previo que
mostrar) — Pantalla 2 es la primera pantalla con un paso anterior real (paso 1, "Elegir cliente") que
tiene que verse clickeable. Agregado como `.paso.default-navegable` (cursor pointer + hover/foco con
`--registro`), extensión directa de §1.3, no un cambio de criterio.

### Boceto de Pantalla 2 — "Subir extracto bancario"

[Artifact](https://claude.ai/artifact/9aPArKYhBdMjX9zj6WLh6F), dentro del marco de navegación de doc 36
(header global + sidebar de 4 ítems + panel de contenido). Paso 1 en `.paso.default-navegable`, paso 2
activo, breadcrumb con el cliente real del paso 1 ("Estudio Demo S.A.", sintético). Contenido del paso:
selector de cuenta bancaria (3 cuentas sintéticas) + dropzone interactivo (PDF/Excel, hasta 20 MB,
alterna a chip de archivo cargado) + botón "Continuar" deshabilitado hasta elegir cuenta y cargar
archivo.

### Reconsideración (mismo día, 2026-09-16): Pantalla 1 SÍ recibe el marco ahora, no en PR4

Primera versión de esta sección decía que Pantalla 1 "no se reabría" (doc 36 ya lo permitía: el
reencuadre podía esperar al código). El titular reconsideró al revisar las dos pantallas lado a lado:
una con marco y otra sin él genera confusión real al leer el flujo completo — más barato resolverlo
ahora, con dos pantallas, que después con seis. **Pantalla 1 (versión 4) queda envuelta con el mismo
header global + sidebar + panel de contenido que Pantalla 2**, mismo método de cirugía quirúrgica del
JSON (`json.loads`/`json.dumps`, verificación `count==1` antes de cada uno de los tres reemplazos: el
bloque CSS de `.header` → `.header-global`/`.layout`/`.panel`, la apertura del `<body>`, y el cierre de
los divs nuevos antes de `</div></x-dc>`).

**El contenido de Pantalla 1 no cambió en nada** — mismo título "Elegir cliente", misma descripción,
las 6 tarjetas de cliente byte a byte iguales (verificado: 6 tarjetas, 6 botones "Elegir cliente" antes
y después). Lo único que cambió es el contenedor: el `<div class="header">` viejo (con el estudio, el
avatar y una flecha de dropdown) se reemplazó por el mismo `<div class="header-global">` de Pantalla 2
(avatar + "Laura" + botón "Salir"), y `<div class="stepper-bar">`/`<div class="contenido">` pasaron a
vivir dentro de `<div class="layout"><nav class="sidebar">...</nav><div class="panel">...` — mismo
sidebar de 4 ítems, "Cierre mensual" activo (es la sección donde vive el wizard). Balance de divs
verificado (73 apertura / 73 cierre) antes de publicar.

Las reglas CSS `.sidebar`/`.nav-item`/`.paso.cerrado`/`.paso.default-navegable` ya estaban en el sistema
de tokens de Pantalla 1 desde la sección anterior de este documento — no hizo falta duplicarlas, solo
agregar `.header-global`/`.layout`/`.panel` (reemplazando la `.header` vieja, que queda sin uso).

### Pendientes que quedan declarados, no resueltos acá

1. `.nav-item[aria-disabled="true"]` sobre un `<div>` (con `tabindex`, sin `onClick`) es una excepción al
   principio general "elemento real, nunca `role`/`onClick` en un div" de la propia herramienta de
   boceto — necesaria para que el AC de foco de doc 36 se cumpla (`disabled` nativo saca el elemento del
   tab order). Decisión de implementación pendiente de `frontend-dev` cuando esto se traduzca a React:
   ¿el mismo `<div>`, o `<button aria-disabled="true">` sin el atributo `disabled` nativo?
2. La variante de sidebar para rol `administrativo` (doc 36 AC2: los 3 ítems "próximamente" **ocultos**,
   no deshabilitados) no está bocetada — Pantalla 2 muestra solo la vista `socio`/`contador`.
3. El estado "confirmado/cerrado" a **nivel fila** (§4, grupos de `GrupoDecisionPendiente` en el paso 5)
   no tiene marcado de referencia todavía — cuando se boceté el paso 5, va a necesitar su propia
   estructura (probablemente una fila de tabla, no `<button class="paso">`), reusando los mismos tokens
   de color.
