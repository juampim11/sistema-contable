# 36 — Marco de navegación más amplio: ¿el wizard es toda la aplicación?

> **Qué es este documento.** Responde al hallazgo del titular sobre el boceto de Pantalla 1 ("Elegir
> cliente", Artifact `2i58PAMpUiWay4UDxLkG6Q`) y el modelo de
> `docs/diseno/34-modelo-interaccion-wizard-demo.md` §0 (6 pasos): ambos se diseñaron como si el wizard
> de carga/procesamiento de extractos FUERA la aplicación completa, cuando el sistema real también
> necesita ABM de clientes del estudio, ABM de plan de cuentas y gestión de socios por cliente.
> Convocatoria real, en paralelo, a `ux-designer` (criterio visual) y `analista-funcional` (este
> documento: fundamento contra código/esquema real y requisitos verificables) — mismo patrón que la
> convocatoria original del doc 34, cada uno con su propio encabezado, sin narrar la voz del otro.
>
> **Alcance explícito**: NO se construye ninguna ABM acá. Es una decisión de layout/marco para que PR4
> arranque `apps/web` con la estructura correcta. Lo que sigue es evidencia — código, migraciones y una
> consulta de solo-lectura (agregados, sin contenido N2/N2-R) contra el Postgres del piloto real,
> corrida el 2026-09-16 — no intuición de diseño.

---

## Dictamen de analista-funcional

### 1. Qué tan reales son las tres secciones — verificado contra el esquema y el código

Las tres existen como dominio modelado, con tabla, RLS forzada y un CLI de escritura real. Ninguna es
especulación del hallazgo. Pero **ninguna de las tres tiene hoy un camino de lectura de conjunto ni de
edición** — solo alta (y, en un caso, baja) corridas por JP a mano, nunca por la contadora desde una
pantalla.

| Sección | Tabla(s) / migración | CLI real (`apps/cli/src/*.ts`) | Alta / Baja / Editar / Listar |
|---|---|---|---|
| ABM de clientes del estudio | `tenant_node` (tipo `cliente`), `0001_tenancy.sql` | `alta-cliente.ts` | **Solo alta.** Cuelga de un `estudio` existente vía `altaDeClienteEnEstudio`, bajo `conUsuario()` — la policy `tenant_node_wr` exige rol `socio`/`admin_plataforma` sobre el padre. Sin `listar-clientes.ts` ni `editar-cliente.ts`. |
| Plan de cuentas | `cuenta` + `cuenta_atributo` (identidad estable + vigencia versionada, D-15), `0027_cierre_mensual.sql` | `alta-plan-cuentas.ts` | **Alta masiva desde un `.xlsx`**, con `--confirmar`/dry-run — no hay alta de una cuenta suelta. `cuenta` **no tiene UPDATE ni DELETE para nadie** (identidad inmutable); lo único mutable es `cuenta_atributo.vigente_hasta`/`activa` (cerrar una vigencia). Sin listar. |
| Gestión de socios | `padron_socio` + `padron_socio_documento` (satélite N2-R), `0013_contraparte_hmac_y_padron.sql` | `alta-socio.ts` | **Alta y baja** (`--baja`) — el único de los tres con las dos operaciones. El documento (CUIT/CUIL) nunca por argumento: prompt oculto con doble tipeo. Sin listar. |

Las tres comparten el mismo patrón de autorización: la policy de INSERT excluye explícitamente al rol
`administrativo` (`cuenta_ins`, `padron_socio_ins`, `tenant_node_wr`: solo `socio`/`contador` o
`socio`/`admin_plataforma`) — decidir qué cliente, qué cuenta o quién es socio es criterio del contador,
nunca carga administrativa. Esto es un dato de negocio verificado, no una suposición: cualquier ABM
futura hereda esa misma restricción de rol, y el marco de navegación tiene que poder expresarla (ver
AC2 más abajo).

### 2. Volumen y urgencia real — verificado con consulta de solo lectura contra el piloto (2026-09-16)

Consulta agregada (`count(*)`, sin contenido N2/N2-R: sin `denominacion`, sin `documento`, sin
`nombre`) contra `sistema-contable-postgres-piloto`, corrida como superusuario de solo-conteo:

| Dominio | Total en el piloto hoy | Distribución | Cadencia real medida |
|---|---|---|---|
| `tenant_node` (tipo `cliente`) | **6** (+ 1 `estudio`) | — | 6 altas en ~7 semanas de piloto (desde el `2026-08-10` de la primera entrada de HANDOFF citada en este mismo doc de origen), esporádicas, ligadas a onboarding |
| `cuenta` (plan de cuentas) | **446** filas, pero solo en **2 de los 6 clientes** | 227 en un cliente, 219 en otro; **los otros 4 clientes tienen 0 cuentas cargadas** | Cada uno de los dos clientes con plan de cuentas lo recibió en **una sola fecha** (`2026-08-30`, `count(distinct creada_en::date) = 1` para cada uno) — carga masiva única al onboarding, no altas incrementales |
| `padron_socio` | **8** filas | 4 / 2 / 2 en tres clientes; los otros 3 clientes tienen 0 | Los 8 se cargaron en **2 sesiones de trabajo** (`2026-08-19` y `2026-08-24`), no 8 eventos independientes en el tiempo |

**Lectura de esto**: las tres ABMs son operaciones de **setup por cliente**, no de mantenimiento
recurrente. En 7 semanas de piloto real hubo 6 altas de cliente, 2 cargas de plan de cuentas y 2
sesiones de alta de socios — contra el volumen del propio wizard en el mismo período (un solo lote de
Bracci: 1081 filas de movimientos; ROKA: 267 asientos ya cerrados, HANDOFF 170). El wizard es la tarea
**mensual recurrente**; las tres ABMs son trabajo de **alta de cliente**, que hoy ocurre a mano, corrido
por JP (rol `socio`), nunca por la contadora desde una pantalla — porque no existe pantalla.

**Conclusión de urgencia**: baja. "Próximamente" (ítem deshabilitado en el nav) es aceptable para el
lanzamiento de PR4. Ninguna de las tres compite en frecuencia con el flujo que PR4 sí tiene que resolver
(el wizard).

### 2.bis. Hallazgo no pedido, pero que condiciona cualquier ABM futura: `apps/web` no tiene por dónde escribir

`packages/data/migrations/0047_rol_app_web.sql` (ya aplicada en local, **no aplicada en piloto** —
declarado en la propia migración: "piloto está 4 migraciones atrás") crea el rol `app_web`,
**exclusivamente de lectura**, con un `SELECT` en whitelist angosta **por columna**, justificada tabla
por tabla contra las consultas reales de los 6 pasos del wizard (`ADR-0006-autenticacion.md` §5).
Verificado línea por línea contra el archivo:

- `tenant_node`: SELECT concedido (`id, parent_id, tipo, nombre, deleted_at, created_at, updated_at`,
  sin `nid`/`path` — R25) para pintar el selector del paso 1. **Sin INSERT.** Dar de alta un cliente
  nuevo no tiene ningún camino desde `apps/web` hoy, ni siquiera parcial.
- `padron_socio` / `padron_socio_documento`: **cero grants a `app_web`**, ni lectura.
- `cuenta` (identidad base del plan de cuentas): **excluida a propósito** ("queda AFUERA a propósito:
  ni `agruparDecisionesPendientes()` ni `leerPlanDeCuentasCompleto()` la tocan"). `cuenta_atributo` sí
  tiene SELECT acotado (sin `respaldo` ni `padron_socio_id`) para el paso 5 — pero **sin INSERT**.
- Toda escritura desde `apps/web` está bloqueada **estructuralmente**, no por falta de pantalla: el
  propio §7.bis del ADR-0006 (el mecanismo de escritura de `app_web`, hoy acotado a
  `confirmacion_grupo` + capacidad `imputar_grupo` — es decir, solo el paso 5 del wizard) sigue
  "bloqueado" según el comentario de la migración, porque sus dos precondiciones (R44 aplicada+probada,
  el guard de `respaldo` movido adentro de `confirmarGrupo()`) no están cumplidas todavía. Y eso es
  **únicamente** para la confirmación de un grupo del wizard — ni siquiera roza las tres ABMs.

**Consecuencia directa para este dictamen**: construir cualquiera de las tres ABMs, aunque sea el
formulario más simple, exige dos decisiones que hoy no existen — (a) qué capacidad/rol autoriza esa
escritura desde la web (mismo patrón que la capacidad `imputar_grupo` en curso), y (b) una migración de
grants nueva, con su propia convocatoria de `dba-data` + `security-engineer` +
`seguridad-datos-financieros` (CLAUDE.md §3.1) — no es "agregar una pantalla", es abrir un camino de
escritura que ADR-0006 dejó **deliberadamente cerrado**. Esto no es una opinión de UX: es una
restricción de la base ya escrita, aplicada en local y verificada en la migración citada arriba.

Esto **refuerza** la conclusión del punto 2: el ítem "próximamente" no corre riesgo de quedar
a medio construir, porque el camino de escritura ni siquiera existe todavía a nivel de rol de base de
datos. Y fija un requisito para el día que se construya: la ABM no puede resolver con una query directa
del navegador contra `app_web` — necesita, como el resto de la escritura del sistema, un camino de
servidor bajo `conUsuario()` o una capacidad nueva simétrica a `imputar_grupo`, nunca una llamada
cliente→Postgres.

### 3. Criterios de aceptación para el marco mínimo (que no rompan a la vuelta)

Cada uno es falsable — se puede correr y ver rojo o verde, no es una declaración de intención.

**AC1 — Aislamiento estructural.** Agregar una entrada de nav de prueba (ej. una ruta stub sin
componente real) no modifica ni un archivo bajo `wizard/pasos/*`, ni cambia el árbol de componentes del
wizard. Se verifica con `git diff --stat` acotado a esos paths tras el cambio: **0 líneas**.

**AC2 — Visibilidad por rol, no por posición fija.** El marco tiene que poder ocultar (u ofrecer
deshabilitada con motivo) una entrada según `rol_membership` del usuario actual — porque las tres
ABMs reales, en la base, **ya excluyen** a `administrativo` de escribir (`cuenta_ins`,
`padron_socio_ins`: solo `socio`/`contador`; `tenant_node_wr`: solo `socio`/`admin_plataforma`). Mostrar
"ABM de socios" a un usuario `administrativo` y dejar que el submit falle recién en el backend (cuando
exista) es peor que no mostrarlo. Falsable: montar el nav con un usuario sintético de rol
`administrativo` y confirmar que las tres entradas no aparecen, o aparecen deshabilitadas con el
motivo — nunca activas y clickeables hacia un error de permisos.

**AC3 — El contexto de cliente persiste entre secciones.** Las tres ABMs y el wizard operan
`cliente_id`-scoped (la única excepción es la propia alta de cliente, que cuelga del `estudio` padre,
no de un cliente). El cliente elegido en el paso 1 del wizard tiene que sobrevivir a navegar a otra
sección del marco y volver, sin re-preguntar. Falsable: navegar wizard → otra sección → wizard, y
verificar que el cliente seleccionado sigue siendo el mismo `id`, no un estado que se reinicia.

**AC4 — Ítem deshabilitado sin infraestructura fantasma.** Un "próximamente" no dispara ningún fetch
contra `app_web` — ninguna de las tres tablas tiene grant de lectura completo hoy (ver 2.bis), así que
un intento de lectura real terminaría en un error de permisos de Postgres disfrazado de bug de UI.
Falsable: con devtools → Network abierto, clickear el ítem deshabilitado produce **cero requests**.

**AC5 — Predicción falsable, no tautológica.** Agregar el marco (con sus 3 entradas nuevas, activas o
no) **no cambia el conteo de pasos del wizard** (sigue siendo 6) ni renombra ninguno de los 6 nombres ya
fijados en doc 34 §0 ("Elegir cliente", "Subir extracto bancario", "Resumen de la extracción", "Procesar
y tipificar", "Revisar e imputar", "Generar asiento contable"). Se verifica comparando el stepper
renderizado antes/después del cambio de layout.

**El paso revertible más chico**: el layout/nav shell se puede mergear solo, sin ninguna ruta de ABM
real detrás de las entradas nuevas — coincide con el alcance explícito de la tarea ("NO se construye
ninguna ABM ahora") y con AC1/AC4 de arriba.

### Resumen para decidir

El hallazgo está bien fundado: las tres secciones son dominio real, con tabla, RLS y CLI de escritura —
no invención. Pero el volumen medido (6 clientes, 2 planes de cuentas, 2 sesiones de socios en 7
semanas) y la ausencia total de camino de escritura desde `apps/web` para las tres (2.bis) dicen lo
mismo desde dos ángulos distintos: **el marco de navegación debe reservar el lugar hoy** (para no
rediseñar el layout después), pero **construir cualquiera de las tres ABMs es explícitamente trabajo
posterior**, con su propia migración de grants y su propia convocatoria — no una extensión natural de
PR4.

---

## Dictamen de ux-designer

> Escrito sin haber visto todavía el dictamen de `analista-funcional` de arriba (convocatoria en
> paralelo, cada uno con su propio criterio independiente — mismo patrón que la convocatoria original del
> doc 34). Donde su evidencia de código/esquema confirma o afina algo de lo que sigue, lo señalo con una
> nota "(cruce con analista-funcional, arriba)" en vez de reescribir mi razonamiento sobre su hallazgo.

### 0. Por qué esto es un problema de diseño, no solo de layout técnico

El boceto de Pantalla 1 y el modelo de interacción del doc 34 se diseñaron pensando en la sesión de
carga de UNA cuenta bancaria: elegir cliente → subir extracto → revisar → asentar. Esa es la unidad de
trabajo correcta para el wizard en sí — pero **no es la unidad de trabajo de Laura durante el mes**.

Aplicando la regla de esta persona de partir de cómo trabaja hoy: Laura no abre el sistema una vez al
mes para cargar un extracto y cerrarlo. Abre el sistema, procesa varias cuentas de varios clientes en la
misma sesión (dato ya medido en doc 34 §1.1 — 67% de los clientes de ejemplo tienen más de una cuenta),
y en algún momento —no necesariamente en la misma sesión, pero sí en el mismo sistema— necesita mirar
"¿qué clientes tengo cargados?", "¿este cliente tiene bien el plan de cuentas?", "¿quién es el socio que
firma este cheque?". Hoy esas tres preguntas se responden mirando la carpeta del cliente o una planilla
aparte. El sistema real las va a tener que responder también, y un wizard que ocupa el 100% del marco no
tiene dónde poner esas respuestas sin taparse a sí mismo.

Esto no es agregar funcionalidad nueva: es reconocer que el diseño actual **asumió** (sin decisión
explícita) que el wizard es la aplicación completa. El grep del titular confirma que no hay ninguna
mención de esto en doc 34, doc 35 ni en `ADR-0006` §16 — es un gap real. El dictamen de arriba lo
confirma desde el esquema: las tres secciones tienen tabla, RLS y CLI de escritura reales (§1 de ese
dictamen) — no es un problema inventado por diseño, es plomería ya construida sin pantalla.

### 1. Respuesta a la pregunta 1 — sí, el wizard vive dentro de un marco más amplio

**Sí.** El wizard pasa a ser una **sección** dentro de una navegación de nivel superior, no el marco
completo de la pantalla. La sección se llama, en el vocabulario de Laura, **"Cierre mensual"** — no
"Wizard", no "Ingesta": es lo que ella hace, en sus palabras, cuando carga y revisa un extracto para
cerrar un período. El nombre de la sección importa tanto como su existencia: si el sistema le habla en
su propio vocabulario en todos lados salvo el nombre de la sección donde vive el 95% de su trabajo
mensual, ese único lugar mal nombrado es el que más fricción genera, porque es el que más usa.

**Secciones de la navegación, con su estado real hoy:**

| Sección | Vocabulario de Laura | Estado hoy | Respaldo en backend |
|---|---|---|---|
| Cierre mensual | "cargar y revisar un extracto" | **Construida** (es el wizard de 6 pasos, doc 34) | Ingesta, Capa C, `confirmacion_grupo`, `escrituras.ts` |
| Clientes | "la carpeta de cada cliente" | Sin pantalla | `tenant_node`, migración `0001` |
| Plan de cuentas | "el plan de cuentas de cada cliente" | Sin pantalla | `cuenta` + `cuenta_atributo`, migración `0027` |
| Socios | "quién firma, quién es socio" | Sin pantalla | `padron_socio` y relacionadas, migración `0013` |

**Por qué no alcanza con dejarlo para "cuando se construyan las ABMs"**: la razón de esta convocatoria no
es construirlas ya — es que el LAYOUT que se escriba en PR4 no tenga que rehacerse el día que se
construyan. Agregar un sidebar después de que `apps/web` ya tiene decenas de componentes asumiendo
"pantalla completa = wizard" es un costo de refactor real; reservar el marco ahora es gratis. El
dictamen de arriba mide además que esto no es urgente en contenido (§2: setup por cliente, no
mantenimiento recurrente) — lo cual respalda exactamente esta postura: reservar el lugar sí, construir
detrás todavía no.

### 2. Respuesta a la pregunta 2 — qué tan mínimo puede ser el marco

**Mínimo real, tres reglas:**

1. **El marco es un contenedor de navegación con ítems, no las pantallas detrás de esos ítems.** Un
   sidebar (ver §4 por qué sidebar y no nav superior) con 4 ítems. Uno lleva a algo construido. Tres
   llevan a un estado "próximamente" — una pantalla real, no un enlace roto, con un mensaje en el
   vocabulario de Laura ("Todavía no podés cargar clientes acá — decíselo a tu estudio si lo necesitás
   antes") y sin ningún control de formulario que sugiera que se puede interactuar.
2. **"Deshabilitado" no es "invisible" — con una excepción que ya está fundada en la base, no en gusto de
   diseño.** El error más fácil de cometer acá es ocultar los tres ítems no construidos hasta que
   existan — eso le esconde a Laura que el sistema *va* a tener esas secciones, y cuando aparezcan de
   golpe el día que se construyan, es un cambio de layout no anunciado. Mostrarlos ahora, marcados como
   no disponibles, cuesta un estado visual y ahorra esa sorpresa. La excepción es por **rol**, no por
   estado de construcción: el dictamen de arriba (AC2) verificó contra las policies reales que las tres
   ABMs excluyen `administrativo` de escribir (`cuenta_ins`, `padron_socio_ins`, `tenant_node_wr`) —
   para ese rol, el ítem se oculta directamente en vez de mostrarse deshabilitado, porque no hay ningún
   motivo de negocio real que mostrarle ("todavía no existe" es distinto de "no es para vos"; mezclar los
   dos mensajes en el mismo estado visual confunde más de lo que ahorra).
3. **Ningún dato de cliente se carga para pintar un ítem "próximamente".** El sidebar no hace un fetch a
   `tenant_node` ni a `padron_socio` para las secciones no construidas — son ítems estáticos. El día que
   se construya "Clientes" de verdad, ese ítem pasa a pedir datos reales; hasta entonces, cero riesgo de
   exposición por una sección que ni siquiera tiene pantalla. (Cruce con analista-funcional, arriba:
   2.bis y AC4 confirman esto desde el lado de la base — `app_web` no tiene grant de lectura completo
   para ninguna de las tres tablas hoy, así que un fetch real fallaría con un error de permisos
   disfrazado de bug de UI. La regla de diseño y la restricción de la base apuntan al mismo
   comportamiento por caminos independientes.)

**Lo que el marco NO incluye en esta etapa** (a propósito, y qué se pierde):

| Afuera | Qué se pierde | Por qué es aceptable ahora |
|---|---|---|
| Contenido real de "Clientes" (listado, alta, edición) | Laura no puede ver la lista de clientes desde el sistema | Sigue viendo su carpeta/Excel de clientes como hoy — no es una regresión, el sistema no se lo daba antes tampoco |
| Contenido real de "Plan de cuentas" | No puede editar ni ver el plan de cuentas por pantalla | Mismo caso — hoy lo ve en su Excel/el plan del estudio |
| Contenido real de "Socios" | No puede ver el padrón de socios por pantalla | Mismo caso |
| Búsqueda global, notificaciones, cualquier otro elemento típico de "producto real" que no sea navegación entre estas 4 secciones | Nada de eso existe todavía | No estaba pedido ni por el titular ni por `ADR-0006` §16 — agregarlo ahora sería alcance no pedido, decisión de `product-owner` si aparece |

**Criterios de aceptación** (mínimo del marco — complementan, no repiten, AC1-AC5 del dictamen de
`analista-funcional` arriba):

| AC | Cómo se comprueba |
|---|---|
| El sidebar muestra 4 ítems para un usuario `socio`/`contador`; 1 ítem para un usuario `administrativo` (los otros 3, ocultos por rol, no deshabilitados) | Inspección visual con dos usuarios sintéticos de rol distinto — mismo mecanismo de falsación que AC2 de arriba |
| Los ítems "próximamente" mostrados (para `socio`/`contador`) tienen `aria-disabled="true"` y ningún `onClick` que navegue | Test de UI: click en ítem no construido no cambia la URL ni el estado |
| El ítem "próximamente" muestra su mensaje en foco/hover, no solo con el mouse | Test de accesibilidad: navegación por teclado llega al ítem y expone el mensaje |
| El ítem "Cierre mensual" usa esa etiqueta exacta, no "Wizard" ni "Ingesta" | Revisión de copy contra este documento |

### 3. Respuesta a la pregunta 3 — el stepper no se toca en su lógica, solo cambia su contenedor

**El stepper queda como está — mismo comportamiento de 6 pasos, mismos estados por paso (incluido el
tercer estado "confirmado/cerrado" que doc 34 §1.3 y §3 ya pidieron agregar antes de bocetar Pantalla
2).** Lo único que cambia es que deja de ocupar el ancho completo del viewport: pasa a vivir dentro del
área de contenido, a la derecha de un sidebar angosto. Esto es exactamente lo que fija, como criterio
falsable, AC5 del dictamen de arriba: el marco no cambia el conteo de pasos (sigue siendo 6) ni renombra
ninguno de los 6 nombres ya fijados en doc 34 §0.

**Por qué el stepper no necesita rediseñarse:**

- Es información de progreso de una tarea (dónde está Laura dentro del cierre de esta cuenta), no
  navegación entre secciones de la aplicación (eso es lo que hace el sidebar). Son dos jerarquías
  distintas y no compiten por el mismo espacio si se apilan: sidebar = "qué parte del sistema", stepper =
  "qué parte de esta tarea".
- El ancho que pierde el stepper al convivir con un sidebar angosto (ver §4, ~220px) es perfectamente
  absorbible: el boceto actual de Pantalla 1 ya tiene margen lateral generoso alrededor del stepper — no
  está usando el 100% del ancho hoy tampoco.

**Lo que sí cambia, y hay que declararlo para que no se descubra tarde**: el header actual de Pantalla 1
(el que hoy ocupa "todo el marco superior", en palabras del titular) se **divide en dos niveles**:

1. **Header global** (nuevo, arriba de todo): identidad del estudio/usuario logueado, y es donde vive
   la salida de sesión. Ancho completo, altura fija y chica (una sola línea).
2. **Header de sección** (lo que hoy ya existe como header de Pantalla 1: nombre del paso, stepper):
   queda igual, pero ahora vive DENTRO del área de contenido, al lado del sidebar, no ocupando el ancho
   de la ventana.

**Criterios de aceptación:**

| AC | Cómo se comprueba |
|---|---|
| El stepper conserva sus 6 círculos y sus 3 estados (default/activo/confirmado) sin cambio de lógica | Diff de comportamiento: 0 cambios en las reglas de doc 34 §1.3 — mismo criterio de falsación que AC5 de arriba |
| El header global (nueva pieza) no repite ninguna etiqueta de paso del wizard | Revisión de copy: "Cierre mensual" en el sidebar, nombre del paso solo en el header de sección |
| El área de contenido (sidebar + panel de wizard) ocupa el 100% del alto disponible bajo el header global, sin scroll horizontal en ninguna resolución ≥ 1280px | Prueba visual en 2-3 anchos de referencia |

### 4. Por qué sidebar y no nav superior

Nav superior (tabs horizontales tipo "Cierre mensual | Clientes | Plan de cuentas | Socios" en una sola
fila bajo el header) fue la otra opción considerada. Se descarta por dos razones concretas, no por
preferencia estética:

1. **El stepper ya usa la fila horizontal superior para su propio progreso.** Apilar tabs de sección +
   stepper de tarea en el mismo eje horizontal, uno arriba del otro, es exactamente el "dos jerarquías
   compitiendo por el mismo espacio" que §3 evita separándolas en ejes distintos (vertical para sección,
   horizontal para progreso de tarea).
2. **Las secciones no construidas necesitan espacio para su estado "próximamente" sin robarle ancho al
   contenido.** Un sidebar angosto (~220px, colapsable a solo íconos si hace falta más adelante) dejado
   fijo a la izquierda dice "esto existe, ahí vive" sin competir por el ancho que el wizard y sus tablas
   ya necesitan (`ADR-0006` §16 pide tablas prolijas — les hace falta ancho).

### 5. Wireframe de la propuesta (descripción, no boceto pixel-perfect)

No modifiqué el Artifact publicado de Pantalla 1 para este documento — es un canvas de diseño con estado
propio (`appifact-doc`), y tocarlo a mano por fuera del editor real, para una propuesta de layout,
arriesgaba corromper un artefacto ya aprobado por una ganancia que un wireframe descriptivo cubre igual
de bien. Cuando se retome el boceto pantalla por pantalla (doc 34 §3, punto 3), quien lo haga parte de
esta descripción:

```
┌─────────────────────────────────────────────────────────────────┐
│  [Estudio X — Laura]                                    [Salir] │  ← header global, nuevo
├───────────────┬─────────────────────────────────────────────────┤
│               │  Elegir cliente                                 │
│ ● Cierre       │  ①──②──③──④──⑤──⑥                              │  ← header de sección + stepper,
│   mensual      │                                                 │     igual que hoy, contenedor angosto
│               │  [ ... contenido del paso actual del wizard ... ]│
│ ○ Clientes     │                                                 │
│   próximamente │                                                 │
│               │                                                 │
│ ○ Plan de      │                                                 │
│   cuentas      │                                                 │
│   próximamente │                                                 │
│               │                                                 │
│ ○ Socios       │                                                 │
│   próximamente │                                                 │
│               │                                                 │
└───────────────┴─────────────────────────────────────────────────┘
```

(Para un usuario `administrativo`, los tres ítems "próximamente" ni siquiera aparecen en el sidebar —
ver §2, regla 2 — así que ese wireframe representa la vista de `socio`/`contador`.)

Tokens a reusar del sistema ya existente en el Artifact publicado (evita inventar vocabulario visual
nuevo): `--om-bg-selected`/`--om-accent-primary` para el ítem activo del sidebar ("Cierre mensual"),
`--om-text-disabled` + `--om-bg-muted` para los ítems "próximamente", `--om-border-subtle` para la línea
divisoria entre sidebar y contenido. Ninguno de estos tokens es nuevo — ya están definidos en el
Artifact de Pantalla 1; lo nuevo es solo su aplicación a un ítem de sidebar en vez de a un paso del
stepper.

> **Corrección (2026-09-16, `ux-designer`, resolución de este pendiente — ver doc 34 §5):** los `--om-*`
> de arriba **no son del boceto** — son el CSS del *editor* Claude Design (la herramienta de canvas),
> compartido por cualquier `appifact`, nunca visible dentro del `<x-dc>` que aísla el contenido real. El
> sistema de tokens propio de Pantalla 1/2 vive en `content.files["Main.dc.html"]`, con su propio
> `:root` en español (`--papel`, `--tinta`, `--registro`, `--confirmado`, `--linea`, `--superficie`,
> …). Los tres tokens nuevos que sí se agregaron (`--fondo-seleccionado`, `--fondo-mudo`,
> `--tinta-inactiva`) están en ESE `:root`, no en `--om-*`. Detalle completo, con el CSS exacto de los
> dos estados y el boceto de Pantalla 2 que los usa: doc 34 §5.

### 6. Lo que esto cambia en lo ya construido y en lo pendiente

- **Pantalla 1**: **reencuadrada 2026-09-16** (versión 4 del Artifact) — ya NO queda pendiente para el
  código. Reconsideración del titular sobre lo que decía la versión original de este punto ("se
  reencuadra cuando se pase a código, no antes"): revisar Pantalla 1 y Pantalla 2 lado a lado con
  layouts distintos generaba confusión real al leer el flujo completo. Mismo método de cirugía
  quirúrgica que Pantalla 2 (ver doc 34 §5) — contenido sin cambios (título, descripción, las 6
  tarjetas), solo el contenedor: header-global + sidebar + panel, igual que Pantalla 2.
- **El tercer estado visual de paso del stepper** (doc 34 §1.3/§3): **resuelto 2026-09-16** — ver doc
  34 §5. El estado "próximamente" para ítems de sidebar también quedó resuelto ahí, en el mismo commit
  (distinto del estado "confirmado/cerrado" del stepper: uno es "no disponible todavía", el otro es "ya
  pasó y está cerrado").
- **Pendiente que queda, agregado por este documento**: la lógica de visibilidad por rol del sidebar (§2
  regla 2, §7 punto 2) todavía no está construida en código — hoy Pantalla 1 y Pantalla 2 muestran
  siempre la vista `socio`/`contador` (los 3 ítems "próximamente" visibles-deshabilitados). Eso se
  resuelve en PR4, no en el boceto — no es una pantalla nueva del wizard, es marco de aplicación.

### 7. Pendiente antes de construir esto en código

1. ~~Agregar el estado visual "próximamente" al sistema de tokens (junto con el estado
   "confirmado/cerrado" de doc 34 §3, punto 2)~~ — **resuelto 2026-09-16**, ver doc 34 §5.
2. La lógica de visibilidad por rol del sidebar (§2, regla 2) necesita el mismo tipo de convocatoria que
   pide 2.bis del dictamen de arriba para cualquier ABM real: no es solo un `if` de UI, es una decisión
   que toca `rol_membership` y las policies reales — `seguridad-datos-financieros` + `security-engineer`
   la revisan antes de que el sidebar decida qué mostrar según rol, no después.
3. Cuando arranque PR4 (`frontend-dev` + `ux-designer` + `seguridad-datos-financieros`, por matriz de
   `agents/README.md`), el layout nace con header global + sidebar + panel de contenido desde el primer
   componente — no se construye el wizard primero y se envuelve después.
