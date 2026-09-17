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
| 2 | Subir extracto bancario | Bocetado 2026-09-16, dentro del marco de doc 36 (header global + sidebar + panel), identidad visual v7 (§6) — [Artifact](https://claude.ai/artifact/9aPArKYhBdMjX9zj6WLh6F). Aprobado por el titular 2026-09-16 |
| 3 | Resumen de la extracción | Bocetado 2026-09-16, directo en v7 (§6) — [Artifact](https://claude.ai/artifact/TcfskR3FGnpPYMhHLiEbqX). Aprobado por el titular 2026-09-16 |
| 4 | Procesar y tipificar | Bocetado 2026-09-16, directo en v7 (§6) — [Artifact](https://claude.ai/artifact/PC8iw6y82qvoFm6cop6nQj). Aprobado por el titular 2026-09-16 |
| 5 | Revisar e imputar (fusión de "revisar tipificaciones" + "imputación a cuentas contables", ver §1.2) | Bocetado 2026-09-17, directo en v7 (§6) — [Artifact](https://claude.ai/artifact/56z4WvmKMUUtq9m95arYZK). Aprobado por el titular |
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

## 6. Exploración de dirección visual y síntesis final — solo Pantalla 1 (2026-09-16)

> El titular rechazó la identidad "libro contable" de §5 (IBM Plex Serif + paleta ocre/verde/ladrillo)
> por acercarse demasiado a la estética SaaS genérica (Odoo/Salesforce). Pidió 3 exploraciones reales, no
> convergentes entre sí, con espíritu de referencia Mercury (banking): tipografía distintiva, uso audaz
> del blanco, layout no obvio — pero sin dejar de ser software de trabajo (dos horas diarias), no una
> landing de marketing. Restricciones que se mantuvieron en las tres: nunca logos/isotipos reales de
> banco (monograma + color de marca, ya resuelto en §5), sin reabrir la estructura funcional validada (6
> pasos, sidebar de 4 ítems, header global), y los mismos 6 registros sintéticos de cliente byte a byte.

### Las tres direcciones exploradas

Convocatoria a `ux-designer`, con instrucción explícita de **no converger** — cada dirección en su
propio Artifact nuevo, sin compartir archivo entre ellas (lección de colisión de agentes en paralelo, ya
aplicada antes en este mismo repo con doc 36):

| Dirección | Eje | Artifact | Resultado |
|---|---|---|---|
| A | Tipografía | [Artifact](https://claude.ai/artifact/T9UTzxcAZs9FfVBmp9dZwa) (Main + specimen tipográfico) | Fraunces (nombre/título) + JetBrains Mono tabular (toda cifra) + Inter retirado a rótulo/nav/acción. Reestructuró la grilla en folio de filas con regla, estilo libro mayor. |
| B | Layout | [Artifact](https://claude.ai/artifact/QoUVSwkqfw59QXdS4U76P6) | Cola priorizada en vez de grilla de clientes. **Descartada por completo** — el titular quiere volver a la grilla del boceto original, no una cola. |
| C | Paleta | [Artifact](https://claude.ai/artifact/NMQwcNbd8UBTFa4Lxr6nEJ) (Main + estrategia cromática) | Escritorio oscuro + tarjetas claras ("papel sobre escritorio") + acento bordó exclusivo de acción/paso activo. Superficie oscura de la exploración: muy extrema (casi negro) — ajustada en la síntesis. |

### Decisión del titular — síntesis, no una cuarta exploración

- **B se descarta por completo.** Vuelve la grilla de 6 tarjetas del boceto original — nunca la cola
  priorizada.
- **C es la base**, con un ajuste: la superficie oscura del "escritorio" (header, sidebar, barra de
  stepper, fondo del panel) se aclara respecto de la exploración — `--escritorio: #322D26` /
  `--escritorio-hondo: #26221C`, lejos del casi-negro que probaba C. El acento bordó
  (`--acento: #8C2F39`) se mantiene **exclusivo** de la acción primaria ("Elegir cliente") y del círculo
  del paso activo del stepper — nunca ítem activo de sidebar, nunca focus ring, nunca texto de cuerpo,
  nunca fondo decorativo.
- **A se combina con C**: Fraunces para nombre de cliente y títulos, JetBrains Mono tabular para toda
  cifra sin excepción (fechas, cantidades de cuentas), Inter retirado a rótulos/navegación/acción — nunca
  compite con el dato ni con el nombre del cliente.
- **Estructura de contenido — decisión de `ux-designer`, a su criterio como pidió el titular**: se
  mantiene la **grilla de tarjetas** del boceto original, no el folio de filas con regla de la dirección
  A. Motivo: el folio de A resolvía bien el eje tipográfico en aislamiento, pero la grilla de tarjetas es
  la estructura ya validada funcionalmente (doc 34/36) y reabrirla no estaba pedido — la tipografía de A
  se aplicó *sobre* la tarjeta existente (nombre en Fraunces, cifras en JetBrains Mono dentro de cada
  `.dato`), sin cambiar el contenedor. La tarjeta pasó de borde a **sombra** (0 10px 24px + 0 2px 6px,
  negro con alpha): sobre el escritorio oscuro, una sombra lee mejor como objeto físico apoyado encima
  que un borde, que compite poco contra un fondo casi tan claro como el borde mismo.
- **Modo claro/oscuro: NO se construye ahora.** Una sola paleta clara y definitiva (la de esta síntesis).
  Nota del propio `ux-designer`, para que quede registrada como estimación realista y no como promesa
  liviana: agregar modo oscuro más adelante va a requerir un **segundo set completo de tokens revisado a
  mano** (nunca una inversión automática de los valores actuales — la paleta actual ya está pensada para
  verse bien en un único sentido de contraste) más la **lógica de preferencia guardada** (persistencia
  por usuario, no solo `prefers-color-scheme`). No es trabajo gratis cuando llegue el momento, aunque hoy
  no haga falta.

### Resultado — Pantalla 1, versión 6 (escritorio oscuro) — SUPERADA, ver corrección de rumbo más abajo

> **Esta versión ya no es la vigente.** El titular la probó y confirmó que el escritorio oscuro por
> defecto es demasiado invasivo para un uso diario de 2 horas. Queda descrita acá tal cual se construyó
> porque **no se descarta**: es la base archivada, lista para cuando se construya un modo oscuro real
> (ver la sub-sección "Corrección de rumbo" más abajo). La versión vigente, por defecto, es la v7 de la
> siguiente sub-sección.

[Artifact](https://claude.ai/artifact/2i58PAMpUiWay4UDxLkG6Q) — contenido histórico de la **versión 6**
del Artifact (superada en el mismo Artifact por la versión 7 de más abajo; el link es el mismo porque es
el mismo Artifact con historial de versiones, no un archivo separado). Verificado antes de publicar:
6 tarjetas de cliente byte a byte iguales a las de §5 (mismo nombre, misma cantidad de cuentas, misma
fecha de último extracto), 4 ítems de sidebar, 6 pasos de stepper con etiqueta, header-global,
contenedor `.breadcrumb` vacío, balance de divs 73/73. Los tokens de estado de la cola de revisión
(`--estado-indeterminado`, `--estado-conciliado`, `--estado-rechazado`) se agregaron ya declarados en el
`:root`, **deliberadamente separados** del acento de marca — para que "esto se puede clickear" (acento)
nunca se confunda con "este es el estado del dato" (estos tres). No se usan todavía en el contenido de
esta pantalla; quedan listos para cuando se boceté la cola de revisión (paso 5).

**Ajustes de criterio que `ux-designer` tomó sin que se los pidieran explícitamente** (declarados para
que el titular los confirme o los corrija):

1. Valores exactos de `--escritorio`/`--escritorio-hondo` (el titular pidió "menos invasivo" en
   prosa, sin un hex; el agente eligió estos dos valores como punto medio entre la exploración C y un
   escritorio casi blanco).
2. El header y la sidebar también pasan a fondo oscuro (`--escritorio-hondo`), no solo el panel de
   contenido — coherencia visual de todo el "marco" como una sola superficie de escritorio.
3. El ítem activo de la sidebar ("Cierre mensual") usa un realce neutro (`rgba` sobre texto claro), no
   el acento bordó — para no romper la exclusividad del acento.
4. Los focus rings usan el texto claro neutro, nunca el acento — mismo motivo.
5. Las tarjetas cambiaron de borde a sombra, y se quitó el fondo rayado de "papel de libro contable" de
   §5 (ya no aplica: el escritorio es liso, el papel real ahora son las tarjetas).

**Pantalla 2 queda fuera de alcance de esta síntesis** — su Artifact sigue con la paleta "libro
contable" de §5, ahora divergente de la de Pantalla 1. Queda pendiente, no resuelto acá, para cuando el
titular autorice seguir con Pantalla 2 en adelante.

### Corrección de rumbo (2026-09-16) — v7: superficie clara por defecto; v6 archivada para el modo oscuro futuro

El titular probó la v6 (escritorio oscuro) y confirmó que resulta demasiado invasiva para 2 horas
diarias de uso. Decisión explícita: **la v6 no se descarta** — queda documentada tal cual arriba, como
la base ya construida para cuando se implemente un modo oscuro real (ver la nota de modo claro/oscuro
más arriba: ese trabajo futuro sigue necesitando un segundo set de tokens revisado a mano, no una
inversión automática, más la lógica de preferencia guardada — la v6 adelanta el primer paso de ese
trabajo, pero no lo completa). Se pide una **v7**, no una cuarta exploración: mismo criterio de
tipografía A + estrategia de paleta C, pero con la superficie clara como base, dejando a criterio de
`ux-designer` el tono exacto de "papel".

**Qué cambia en v7 (convocatoria puntual a `ux-designer`, un solo agente, un solo Artifact):**

- **Tres niveles de luminosidad ascendente**, dentro de una sola familia cálida de "papel envejecido"
  (nunca blanco puro, para no recaer en la estética SaaS genérica ya rechazada al pedir las 3
  direcciones): `--marco: #EAE1CD` (header, sidebar, stepper-bar — el más profundo de los tres, mismo
  vocabulario que el "marco" de doc 36), `--lienzo: #F2ECE0` (fondo del panel de contenido), `--papel:
  #FBF8F1` (la tarjeta de cliente, el más claro). Reemplaza la oposición dura "escritorio oscuro / papel
  claro" de v6 — sin esa oposición de contraste, la jerarquía se rehace por gradiente de luminosidad,
  cada salto sutil (todos en el rango ~0.82–0.93) para que se perciba como jerarquía y no como bloques
  de color compitiendo.
- **Familia de texto/borde consolidada en una sola** (ya no hacen falta dos, una por fondo oscuro y otra
  por fondo claro): `--tinta`/`--tinta-suave` sin cambio de valor, `--tinta-mudo` (fusiona
  `--texto-claro-mudo` y `--tinta-inactiva` de v6 — sus alphas, 0.34 y 0.32, ya eran casi idénticos) y
  `--linea` (fusiona `--linea-clara` y `--linea-papel`).
- **Sin cambio de valor ni de regla de exclusividad**: `--acento`/`--acento-hover`/`--acento-tinta`
  (`#8C2F39`, exclusivo del botón "Elegir cliente" y el paso activo del stepper), `--confirmado`, los
  tres `--estado-*` de cola de revisión, y los 6 `--banco-*`. Tipografía A intacta: Fraunces en
  nombre/título, JetBrains Mono tabular en toda cifra, Inter en rótulos/nav/acción. Grilla de tarjetas
  intacta, mismos 6 registros sintéticos byte a byte.
- **Ajuste de criterio no pedido explícitamente, declarado**: `.tarjeta` pasó a `border: 1px solid
  var(--linea)` + sombra mucho más liviana que en v6 (`0 1px 2px rgba(...,.05), 0 8px 20px
  rgba(...,.06)`). Motivo: contra un `--lienzo` de luminosidad parecida a `--papel`, la sombra sola de
  v6 (pensada para separar contra un fondo oscuro) ya no alcanza para leerse como objeto apoyado; hace
  falta también el hairline de borde.
- Los tooltips (`.tooltip-cerrado`, `.tooltip-proximamente`) se mantienen como elementos flotantes de
  alto contraste independientes de la superficie de base — fondo `--tinta` sólido, texto en `--papel`
  reusado como "tinta clara sobre fondo oscuro puntual" (no se inventó un token nuevo solo para ese
  caso).

**Resultado — Pantalla 1, versión 7 (vigente por defecto)**

[Artifact](https://claude.ai/artifact/2i58PAMpUiWay4UDxLkG6Q) (versión 7, mismo Artifact, versión más
reciente). Verificado antes de publicar y releído en vivo después: 6 tarjetas de cliente byte a byte
iguales, 4 ítems de sidebar, 6 pasos de stepper con etiqueta, header-global, `.breadcrumb` vacío, balance
de divs 73/73, cero rastro de `--escritorio`/`--texto-claro` (confirmado por grep sobre el contenido
publicado — la v6 quedó totalmente reemplazada en esta versión del Artifact, no mezclada).

**A partir de acá, toda referencia a "la identidad visual de Pantalla 1" en este documento y en doc 36
es la v7 (superficie clara)**, salvo que se diga explícitamente "v6" o "modo oscuro archivado".

### Pantalla 2 traída a v7 (2026-09-16, mismo día)

Convocatoria puntual a `ux-designer`, un solo agente. A diferencia de Pantalla 1, el Artifact de
Pantalla 2 es del formato "Design" canvas moderno (archivos publicados discretos, no JSON embebido), así
que el agente pudo leer y publicar directo, sin la cirugía de JSON que exige el formato viejo de
Pantalla 1 — publicó él mismo, verificó él mismo antes de publicar, y yo verifiqué de nuevo contra el
contenido publicado en vivo antes de darlo por cerrado (misma disciplina de "nunca confiar en el reporte
del agente sin releer el estado real" de toda esta sesión).

**Qué cambió**: mismo mapeo de tokens y tipografía que Pantalla 1 v7 — `--marco`/`--lienzo`/`--papel` en
vez de la paleta "libro contable" vieja, Fraunces/Inter/JetBrains Mono en vez de IBM Plex Sans/Mono/
Serif, acento bordó `#8C2F39` exclusivo del botón "Continuar" (equivalente de "Elegir cliente" en
Pantalla 1) y del círculo del paso activo del stepper. El selector de cuenta bancaria (monogramas
Galicia/Nación/Santander) y el dropzone/archivo-cargado — específicos de Pantalla 2, sin equivalente en
Pantalla 1 — pasaron a vivir sobre `--papel` (mismo criterio que la tarjeta de cliente de Pantalla 1: un
objeto de primer plano se separa del `--lienzo` por luminosidad, no por oposición). Los 6 tokens
`--banco-*` no cambiaron de valor.

**Qué NO cambió**: la lógica interactiva completa (`<script data-dc-script>` con `Component extends
DCLogic`, todos los `onClick`/`sc-if`/bindings de estado) quedó byte a byte idéntica — verificado por
comparación de string exacta, no a ojo. Mismo cliente en el breadcrumb ("Estudio Demo S.A."), mismas 3
cuentas bancarias con sus últimos 4 dígitos, mismo archivo de ejemplo ("extracto_agosto_2026.pdf",
"340 KB"). Balance de divs 52/52 antes y después.

[Artifact](https://claude.ai/artifact/9aPArKYhBdMjX9zj6WLh6F) (versión 5). **Pantalla 2 queda aprobada
en v7** — con esto, Pantalla 1 y Pantalla 2 comparten el mismo lenguaje visual completo (tokens,
tipografía, disciplina de exclusividad del acento). No queda ninguna pantalla bocetada con la paleta
"libro contable" vieja de §5.

### Pantalla 3 bocetada directo en v7 (2026-09-16, sin pase de identidad aparte)

Primera pantalla nueva del wizard bocetada ya con v7 desde el arranque — no hubo palette vieja que
reemplazar ni pase de identidad posterior, a diferencia de Pantalla 1 y Pantalla 2. Convocatoria puntual
a `ux-designer`, mismo criterio de siempre: copió tal cual el `:root`, `.header-global`, `.sidebar`/
`.nav-item`, `.stepper`/`.paso` y `.breadcrumb` de Pantalla 2 v7, y diseñó desde cero solo lo específico
de esta pantalla.

**Stepper**: pasos 1 y 2 en `.paso.default-navegable` (navegables hacia atrás — ya no hay nada que
mostrar de esos pasos en esta pantalla), paso 3 `.paso.activo`, pasos 4-6 sin estado especial. Breadcrumb
extendido con un segundo segmento respecto de Pantalla 2 ("Cliente: Estudio Demo S.A. · Cuenta: Banco
Galicia ····4821") — necesario acá porque el resumen es específico de una cuenta, no solo de un cliente.

**Contenido — grounding en lo que el motor de ingesta real extrae** (no inventado): una ficha de resumen
sobre `--papel` (mismo criterio de primer plano que la tarjeta de Pantalla 1 y el selector/dropzone de
Pantalla 2) con período (`01/08/2026 – 31/08/2026`), saldo inicial (`$ 1.482.350,00`), saldo final
(`$ 1.647.910,55`) y cantidad de movimientos detectados (`47`) — exactamente los campos que el adaptador
de Galicia extrae y verifica por triangulación (`docs/diseno/02-formato-galicia.md` §3.2/§6/§11: período
por min/max de fecha, saldos derivados por aritmética de la cadena, cantidad de movimientos como medida
de "Done"). Todos los datos son **sintéticos**, coherentes con el resto del wizard.

**Corrección del titular sobre el primer boceto**: `ux-designer` había reusado `--estado-indeterminado`
(reservado desde Pantalla 1 "para cuando Pantalla 5 lo necesite") para la nota de calidad de extracción
de esta pantalla ("2 movimientos con importe no pudieron leerse automáticamente — se van a marcar para
revisión manual en el paso 5"). El titular la rechazó: son dos significados semánticamente distintos
aunque el peso visual sea parecido. `--estado-indeterminado` (y sus dos hermanos, `--estado-conciliado`/
`--estado-rechazado`) son sobre una **decisión humana todavía no tomada** — la cola de revisión de
Pantalla 5, donde alguien decide si un movimiento concilia. La nota de Pantalla 3 es sobre **una falla de
lectura automática del motor**, sin ninguna decisión humana pendiente todavía. Corrección aplicada:

- `--estado-indeterminado`/`--estado-conciliado`/`--estado-rechazado` quedan **intactos, sin uso**,
  reservados tal cual para Pantalla 5 — comentario del `:root` reescrito para dejar explícita la
  distinción ("sobre una decisión humana todavía no tomada", nota de la corrección del titular).
- Token nuevo, propio: **`--advertencia-sistema: #C99A3B`** — mismo valor ámbar que
  `--estado-indeterminado` (misma familia visual de "atención"), pero declarado como un token
  semánticamente distinto, no un alias. Es el único token de esta pantalla para "el sistema no pudo leer
  algo automáticamente", sin relación con la cola de revisión.
- `.nota-calidad` (fondo, borde, color del ícono) pasó de `var(--estado-indeterminado)` a
  `var(--advertencia-sistema)` — verificado con grep: cero ocurrencias de `var(--estado-indeterminado)`
  en el cuerpo de la pantalla, la declaración del token sigue en `:root` sin usar.

[Artifact](https://claude.ai/artifact/TcfskR3FGnpPYMhHLiEbqX) (versión 2, con esta corrección ya
aplicada). Verificado antes de publicar y releído en vivo contra el contenido publicado (no solo el
reporte del agente): balance de divs 52/52, 6 pasos con etiqueta, 4 ítems de sidebar, header-global,
breadcrumb con los dos valores esperados, ficha de resumen con sus 3 cifras intacta, `--estado-indeterminado`
declarado con 0 usos en el cuerpo, `--advertencia-sistema` usado exactamente 3 veces (todas dentro de
`.nota-calidad`), acento bordó limitado a exactamente 3 apariciones (círculo del paso activo ×2 + botón
"Continuar" ×1) — ninguna fuga a otro elemento. **Aprobada por el titular.**

### Pantalla 4 bocetada directo en v7 (2026-09-16)

Convocatoria puntual a `ux-designer`, mismo criterio que Pantalla 3: copió tal cual el `:root`,
`.header-global`, `.sidebar`/`.nav-item`, `.stepper`/`.paso` y `.breadcrumb` de Pantalla 3 v7, y diseñó
desde cero solo el contenido de "Procesar y tipificar". Con la lección de la corrección anterior
(Pantalla 3) ya incorporada en la consigna, el agente evitó de entrada el mismo error: no tocó
`--estado-indeterminado`/`--estado-conciliado`/`--estado-rechazado` (siguen intactos, reservados para
Pantalla 5, comentados en el `:root` con la razón), ni reusó `--advertencia-sistema` (declarado el mismo
día para una falla de *lectura* del extracto — no aplica a la clasificación automática normal de esta
pantalla).

**Stepper**: pasos 1, 2 y 3 en `.paso.default-navegable`, paso 4 `.paso.activo`, pasos 5-6 sin estado
especial. Breadcrumb idéntico al de Pantalla 3 (cliente + cuenta), mismos 47 movimientos (continuidad del
dataset sintético a través del wizard).

**Contenido — cumple la regla dura más importante del producto (CLAUDE.md §1.7: el sistema es asistido,
nunca automático)**: un aviso `.aviso-no-registro`, primero en la pantalla, antes de cualquier cifra, en
tono neutro (sobre `--papel`, borde `--linea`, ícono en `--tinta-suave` — nunca ámbar de advertencia ni
verde de confirmado): *"Esto es una propuesta del sistema, no un registro. Ningún asiento se contabilizó
todavía — en el próximo paso vas a confirmar, corregir o dejar pendiente cada movimiento, uno por uno."*
Debajo, una ficha de resultado sobre `--papel` (mismo criterio de primer plano que Pantalla 3): "47 de 47
movimientos analizados" + barra de progreso llena, y dos cifras agregadas sin listar movimiento por
movimiento — "Con propuesta de asiento" (39) y "Para revisar en el próximo paso" (8). No lista los 47
movimientos uno por uno — esta pantalla reduce la decisión, no la información; la cola real fila por fila
es Pantalla 5.

**Ajustes de criterio que `ux-designer` tomó, ninguno pedido explícito, ninguno pendiente**:
1. Las dos cifras (39/8) usan la misma tipografía y el mismo `--tinta` neutro, sin distinguir por color.
   Motivo: colorear "alta confianza" vs. "necesita revisión" sugeriría que una categoría ya está resuelta
   y la otra no — mismo riesgo que ya motivó separar `--advertencia-sistema` de `--estado-indeterminado`
   en Pantalla 3. Las dos son igual de "propuesta sin registrar" frente a la regla dura §1.7.
2. El check de "proceso completo" y la barra de progreso usan `--tinta` neutro, deliberadamente no
   `--confirmado` (verde) — ese token es específicamente el estado de paso/fila ya confirmado por una
   persona (§1.3/§4); "el motor terminó de clasificar" es un evento automático sin decisión humana.
3. No hizo falta ningún token nuevo de confianza/incertidumbre — el punto 1 evitó la necesidad y evita
   repetir el patrón que motivó la corrección anterior.

[Artifact](https://claude.ai/artifact/PC8iw6y82qvoFm6cop6nQj). Verificado antes de publicar y releído en
vivo contra el contenido publicado: balance de divs 48/48, 6 pasos con etiqueta, 4 ítems de sidebar,
header-global, breadcrumb con cliente + cuenta, cero ocurrencias de `var(--estado-indeterminado)`,
`var(--estado-conciliado)`, `var(--estado-rechazado)` ni `var(--advertencia-sistema)` en el cuerpo (los
cuatro quedan declarados con comentario explicando por qué no aplican acá), acento bordó limitado a
exactamente 3 apariciones. **Aprobada por el titular.**

### Pantalla 5 bocetada directo en v7 (2026-09-17) — la más compleja de las seis

Convocatoria puntual a `ux-designer`, con grounding contra código real (no solo contra el texto de este
documento): `packages/ingesta/src/cierre/agrupar-decisiones-pendientes.ts` (contrato
`GrupoDecisionPendiente`, cálculo de `cuentaPropuesta`/`requiereRevision`), `packages/data/src/cierre/
escrituras.ts` (`confirmarGrupo`/`revocaId` — confirmado: exige `cuentaId` siempre, no existe un
`indeterminado` persistido en el esquema hoy) y `packages/contabilidad/src/nucleo/texto-humano.ts`
(vocabulario real de movimientos, para no inventar texto).

**Candado por fila, no por paso (§4 punto 1)**: clase nueva `.grupo.cerrado` (distinta de `.paso.cerrado`
del stepper — objetos DOM distintos) — candado + check + "Confirmada por Laura · 16/09/2026 14:32" +
"Corregir esta decisión" → `revocaId`. A diferencia de `.paso.cerrado` (que muestra ese detalle solo en
hover), acá queda **siempre visible en línea** — ajuste de criterio del agente: con el ancho de una fila
completa es más legible para escanear muchas filas cerradas seguidas que esconder el detalle detrás de
un hover.

**Cuarto estado del stepper — `.paso.en-progreso` (§4 puntos 2-3)**: el círculo 5 sigue siendo un
`<button>` real, siempre clickeable mientras la sesión sigue abierta — nunca "cerrado sin puntero"
mientras haya grupos sin resolver, sin importar cuántos ya estén confirmados. Muestra un chip `n/m`
("2/21 grupos") con el mismo acento bordó que el círculo activo (no es un cuarto uso del acento, es el
mismo uso ya permitido en "paso activo/en-progreso"). Declarado en el CSS, como intención de diseño no
verificada todavía: si en un futuro paso posterior se mirara hacia atrás un paso 5 "en progreso pero no
activo" (sesión distinta), `.paso.en-progreso` sin `.activo` mostraría el mismo chip en tono neutro — no
construido ni verificado, queda anotado para cuando corresponda.

**Primer uso real de los 3 tokens `--estado-*`** (reservados desde Pantalla 1, doc 34 §6 anterior),
mapeo semántico **aprobado por el titular tal cual**:
- `--estado-conciliado` (verde-azulado): badge inicial de fila cuando el motor propone con alta
  confianza (`cuentaPropuesta !== null && !requiereRevision`). No implica fila resuelta.
- `--estado-indeterminado` (ámbar): un solo significado — "la cuenta correcta no está determinada" — en
  dos momentos: badge inicial cuando el motor tiene candidato pero duda (`requiereRevision === true`), y
  estado final de fila cuando la contadora la marca explícita "No sé" con motivo.
- `--estado-rechazado` (rojo): un solo significado — "no hay ninguna cuenta propuesta vigente que valga
  aceptar" — en dos caminos: badge inicial cuando `cuentaPropuesta === null` ("sin regla"), y el botón
  "No es esta cuenta" cuando la contadora rechaza explícitamente la propuesta del motor.
- `--confirmado` (reusado, no uno de los 3 nuevos): candado de fila ya confirmada — mismo verde que ya
  usan los pasos cerrados del stepper, evita inventar un cuarto color.

**"Marcar indeterminado con motivo" — honestidad declarada, sin backing real en el esquema hoy**:
`confirmarGrupo()` exige `cuentaId` siempre; no existe columna de estado/motivo en `confirmacion_grupo`.
Botón terciario "No sé / marcar para después" (`--estado-indeterminado`, nunca acento) deja la fila en
`.grupo.indeterminado-marcado` con el motivo entre comillas y un link "Volver a revisar" — deliberadamente
distinto de "Corregir esta decisión" (no hay `revocaId` real detrás, la fila es trivialmente reabrible sin
candado real). Mismo criterio de honestidad que ya usa doc 34 §4 punto 4 ("propuesto, no verificado").

**Asiento propuesto — corrección del titular sobre el primer boceto**: la primera versión mostraba el
asiento como una oración en prosa con flecha ("Debe X $N — Haber Y $N"). El titular la rechazó: pidió una
**tabla real de dos columnas (Debe | Haber)**, mismo patrón que un libro diario contable real. Corrección
aplicada: tabla `Cuenta | Debe | Haber` por fila con asiento propuesto (7 de las 9 filas del boceto — las
2 restantes son "sin regla"/marcadas indeterminado, sin asiento que mostrar) — la cuenta debitada con su
importe en la celda Debe (Haber vacío en esa fila), la acreditada con su importe en Haber (Debe vacío),
importes en JetBrains Mono tabular (`.num`) alineados a la derecha con ancho de columna fijo (130px) para
que alineen entre las 7 tablas. Se sacó el ícono de flecha (sin equivalente natural en una tabla de dos
filas). [Artifact](https://claude.ai/artifact/56z4WvmKMUUtq9m95arYZK) (versión 3, con la corrección ya
aplicada).

**Nota anticipada para Pantalla 6** (opinión del agente, no una decisión tomada ni un boceto): Pantalla 6
("Generar asiento contable") consolida los grupos ya resueltos del paso 5 en el asiento final que
efectivamente se registra — el momento real de `confirmarAsiento()` (CLAUDE.md regla dura §1.7). Ese
asiento consolidado probablemente tenga más de 2 líneas (varios grupos, posible agrupación de líneas que
comparten cuenta y lado — decisión de `contador-dominio`, no de diseño) y casi seguro va a necesitar el
mismo componente `.tabla-asiento` construido acá, que ya soporta N filas sin cambio de estructura, más
un total al pie (suma Debe = suma Haber, el chequeo de balance que toda contadora espera ver antes de
confirmar). Queda anotado para cuando se boceté Pantalla 6 — no es un compromiso de diseño cerrado.

**Dataset**: 9 de 21 grupos representativos mostrados (de los 47 movimientos totales de Pantalla 3/4),
con "Cargar más grupos" al pie. Gate hacia paso 6: botón "Continuar" deshabilitado + "Te faltan resolver
19 de 21 grupos para continuar — confirmados o marcados indeterminado, los dos cuentan" — marcado en el
propio CSS como "propuesto, no verificado contra código real", mismo criterio que doc 34 §4 punto 4.

Verificado antes de publicar y releído en vivo contra el contenido publicado, en ambas rondas (boceto
inicial y corrección de la tabla): balance de divs 109/109, botones 28/28, selects 1/1, tablas 7/7 con
sus `<tr>`/`<td>` balanceados, 6 pasos con etiqueta, 4 ítems de sidebar, header-global, breadcrumb, los 3
`--estado-*` con usos reales (a diferencia de Pantallas 1-4, donde quedaban reservados sin uso), acento
bordó limitado a la acción primaria + el stepper (nunca en botones de fila). **Aprobada por el titular.**
