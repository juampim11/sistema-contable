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
| 2 | Subir extracto bancario | Pendiente de boceto |
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
