# CLAUDE.md — Instrucciones para Claude Code (`<NOMBRE_PROYECTO>`)

> Puntero fino. La fuente de verdad vive en `docs/` y en las personas de `agents/personas/`. Codex usa
> `AGENTS.md`, que apunta a los mismos documentos. Mantener ambos sincronizados en lo operativo y **no**
> duplicar contenido de dominio acá.

## 0. Antes de tocar nada

1. Leé `docs/devops/01-entornos.md` (entornos), `02-sdlc-git-flow.md` (cómo se trabaja cada cambio) y
   `03-reglas-desarrollo-optimizado.md` (presupuesto de recursos y buenas prácticas).
2. Leé la última entrada de `HANDOFF.md` (o `<BITACORA>`) para saber en qué estado quedó el trabajo.
3. Si vas a trabajar en un dominio específico, **adoptá la persona** correspondiente en
   `agents/personas/<persona>.md` (o usá el subagente en `.claude/agents/`).

## 1. Reglas duras (no negociables)

> Base de arquitectura: **`docs/arquitectura/ADR-0000-stack-infra.md`** (stack y portabilidad),
> **`ADR-0001-tenancy.md`** (multi-tenancy y RLS), **`ADR-0002-seguridad.md`** (niveles de datos y
> reglas verificables). Ningún cambio puede contradecirlos.

1. **Agnóstico de proveedor:** ningún servicio de negocio llama directo a un SDK propietario. Todo pasa
   por las tres abstracciones propias — datos (Drizzle sobre Postgres), auth (`AuthProvider`),
   almacenamiento (`ObjectStorage` S3-compatible). Ver ADR-0000 §3.
2. **Aislamiento multi-tenant, verificado y no confiado:** toda tabla con datos de un cliente lleva
   `cliente_id`, `enable` **y** `force row level security`, y el predicado
   `cliente_id in (select app.accessible_tenant_ids())`. Ningún acceso sin pasar por
   `conUsuario()`. Unicidades **siempre** por cliente, nunca globales. Los siete renglones obligatorios
   están en ADR-0001 §5 y las reglas verificables en ADR-0002 §B.
3. **Lógica de negocio determinística; sin LLM en el núcleo.** Un modelo puede sugerir; lo que produce
   una propuesta con su score y su evidencia es código determinístico y testeado.
4. **Datos financieros de terceros: nunca en logs, nunca en un entorno de prueba, nunca a un servicio
   externo sin decisión registrada** (ADR-0002 §A y §D). El uuid del registro y el código de error
   alcanzan para depurar; el extracto no.
5. **Nada de secretos en el repo.** Todo por variables de entorno (`.env.example`).
6. **Los agentes fiscales y contables nunca inventan normativa.** `contador-dominio`,
   `fiscal-nacional-iva-ganancias`, `fiscal-ingresos-brutos-convenio-multilateral`,
   `integraciones-afip`, `balances-normas-tecnicas` y —en lo normativo— `seguridad-datos-financieros`
   responden **solo** con base en `knowledge/`, **citan la fuente** en cada afirmación (norma o RT +
   artículo/inciso + archivo de origen), **nunca inventan un número de norma ni de RT**, **marcan
   vigencia y fecha de verificación** de cada dato fiscal (topes y alícuotas cambian seguido) y
   **cierran con "Validar con profesional matriculado"** cuando el output tenga implicancia legal,
   fiscal o contable. Si falta la fuente: **"no tengo esa fuente cargada"**, nunca un supuesto.
   Ver `knowledge/README.md` y `docs/agents/guia-carga-conocimiento.md`.
7. **El sistema es ASISTIDO, no automático.** El motor de conciliación **propone** asientos con su
   evidencia y los deja en cola de revisión del contador; **nunca registra por su cuenta** (ver
   `agents/personas/motor-conciliacion-contable.md`). Y **un cliente nunca ve el dato de otro**: el
   aislamiento y el secreto fiscal son requisitos de diseño, no un detalle de implementación (ver
   `agents/personas/seguridad-datos-financieros.md`).
8. **Una regla verificable no cuenta como control hasta que se probó rompiéndola.** Toda regla de
   `ADR-0002` §B nueva o reescrita se cierra por **prueba de mutación** —se escribe el código
   defectuoso y se verifica que la regla se ponga roja—, con su **caso legítimo**, con el conteo de
   mutaciones declarado, y **eligiendo las mutaciones para refutar, no para confirmar**. Procedimiento
   completo: **ADR-0002 §B.0**. El porqué —cinco reglas verdes o amarillas con su propio defecto
   adentro, en dos días—: `docs/diseno/09-lecciones-aprendidas.md` §11. Y el corolario que gobierna
   los campos de estado: **un ⚠️ que nadie convierte en trabajo es un ✅ con más letras.**

9. 🔴 **Antes de aplicar cualquier migración a un entorno con datos reales: listar, confirmar, frenar.**
   La autorización del titular es **por migración**, nunca «lo pendiente». Así que:
   1. **Listar explícitamente qué está pendiente** en ese entorno, antes de correr nada.
   2. **Confirmar que la lista coincide EXACTO con lo autorizado.**
   3. **Frenar si aparece una sola migración de más** — no aplicarla y elevar.

   `pnpm db:migrate` **aplica TODAS las pendientes**: es el comando de «aplicá todo», y por eso
   nunca es el comando de una autorización puntual. **Esto no es una recomendación: es la regla, y
   rige para toda instrucción que toque el piloto.**

   > **Por qué está escrito como regla dura.** `HANDOFF.md` (2026-08-16, entrada 64): el titular
   > autorizó `0018` y **sólo** `0018`; el runbook —escrito cuando `0018` y `0019` iban juntas y no
   > actualizado cuando la decisión cambió— decía `pnpm db:migrate` pelado, y **`0019` entró al
   > piloto sin autorización**. Nada se perdió ni se corrompió, pero la línea se cruzó.
   > Y lo peor no fue el error puntual: **los runbooks de `0015`, `0016` y `0017` funcionaron por
   > casualidad** — en los tres casos lo pendiente coincidía con lo autorizado. **El control nunca
   > existió.** Es el mismo patrón que R33 y R13: un artefacto que dice una cosa y hace otra.

## 2. Convenciones técnicas

- **TypeScript estricto** de punta a punta; validación de límites con **Zod**. Stack completo y monorepo:
  ADR-0000 §2.
- **Ningún importe como `number` de JavaScript.** En base `numeric`; en TS `string` + utilidad de
  dominio. Zona horaria explícita, no la del host (ADR-0000 §2.3).
- Dominio en **español** (`cliente`, `asiento`, `movimiento`, `jurisdiccion`); plomería técnica genérica
  en inglés (`AuthProvider`, `ObjectStorage`). Comentarios en **español**.
- Commits: **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Una tarea = una rama (`feat/<slug>`). PRs chicos y revisables.
- Migraciones: **`drizzle-kit`**, SQL plano en `packages/data/migrations/NNNN_*.sql`. Nunca editar una ya
  aplicada; crear la siguiente con prefijo incremental. Corren con el **dueño del esquema**, nunca con
  `app_request`. Con Drizzle los tipos se infieren del esquema TS (no hay paso de "generar tipos").
- **Toda tabla de dominio nueva se crea con los siete renglones** de ADR-0001 §5 en la **misma**
  migración (y los **cuatro extra** del pie de `0002_endurecimiento.sql` si tiene columnas N2-R/N3).
  Una tabla con `cliente_id` sin RLS forzada es una fuga de datos entre clientes.
- **Toda columna nueva se clasifica** en `packages/shared/src/seguridad/clasificacion-campos.ts`, en la
  misma tarea. Sin entrada en el registro, el gate se pone rojo — no hay "sin clasificar".
- **Arranque local y gate:**
  ```bash
  pnpm db:up && pnpm db:migrate && pnpm db:setup   # infra + esquema + roles
  pnpm db:seed                                     # datos SINTÉTICOS (nunca reales)
  pnpm verificar                                   # typecheck + barrido + fixtures + la suite (gate)
  ```
  Detalle del runbook: ADR-0000 §4.1.

## 2.1. Puntos de entrada obligatorios (no hay alternativa "más rápida")

| Para… | Se usa | Nunca |
|---|---|---|
| Leer o escribir datos de un cliente | `conUsuario(usuarioId, fn)` de `packages/data` | Un `Pool`/`Client` propio, ni `app_job` |
| Un trabajo de sistema | `conJob(motivo, fn)` — el motivo es una **unión cerrada** | Agregarle un motivo nuevo sin ADR. `'ingesta_bancaria'` **no está** y es a propósito |
| Loguear | `logger` de `@sistema-contable/shared/observabilidad` | `console.*` (el gate lo rechaza) |
| Leer algo N2-R/N3 | `leerConAuditoria(tx, pedido, fn)` | Leerlo directo: no deja rastro |
| Datos para desarrollo o tests | el generador de `packages/data/src/seed/sintetico.ts` | Un dump de producción, ni un CUIT real |
- **Flujo completo** (ramas → entornos → deploy → versionado): `docs/devops/02-sdlc-git-flow.md`.
  Versionado en `CHANGELOG.md`.

## 3. Sub-agentes disponibles (`.claude/agents/`)

Roster y protocolo portable: `agents/README.md`. Los nombres del sub-agente y de su persona son el
mismo (= filename en `agents/personas/`).

**Genéricos (del template):**

| Sub-agente | Para qué |
|---|---|
| `code-reviewer` | Revisa el diff: bugs de correctitud + simplificación/reuso/eficiencia |
| `documentador` | Docs, README, CHANGELOG y bitácora sincronizados con el código |
| `tester` | Verificación adversarial y estrategia de test (intenta romper antes del "Done") |

**De dominio (perfiles super-senior):**

| Sub-agente | Para qué |
|---|---|
| `contador-dominio` | Plan de cuentas, criterios de asientos, cierre de balance, RT de FACPCE — define **cómo se registra** |
| `fiscal-nacional-iva-ganancias` | IVA (débito/crédito, prorrateo, retenciones y percepciones) y Ganancias (personas humanas y sociedades), incluido SIRE |
| `fiscal-ingresos-brutos-convenio-multilateral` | IIBB unilateral y Convenio Multilateral (coeficiente unificado, regímenes especiales, SIFERE) — separado del fiscal nacional por la complejidad del reparto interjurisdiccional |
| `integraciones-afip` | Rieles técnicos de AFIP/ARCA (webservices, certificados, SIRE, padrón) y seguimiento de cambios normativos |
| `motor-conciliacion-contable` | Motor que clasifica movimientos bancarios contra el plan de cuentas y **propone** asientos a revisión del contador (reusa el motor de `trazabilidad-obra-gas`) |
| `plan-cuentas-multicliente` | Versiona por cliente los atributos que cambian su tratamiento (condición ante IVA, forma societaria, jurisdicciones de IIBB, plan propio) |
| `balances-normas-tecnicas` | Estados contables según RT de FACPCE, incluida la variante RT 41 para PyMEs — define **cómo se presenta** |
| `seguridad-datos-financieros` | Secreto fiscal y datos bancarios/tributarios de terceros: aislamiento entre clientes, roles, credenciales, trazabilidad — **obligatorio** ante datos de clientes, dinero, permisos o aislamiento |

**Técnicos (roster de ingeniería):**

| Sub-agente | Para qué |
|---|---|
| `product-owner` | Alcance y prioridad: qué se construye, qué se posterga, qué traba de verdad |
| `analista-funcional` | Convierte lo que dice la contadora en especificación **verificable**, con sus casos borde y su medición |
| `arquitecto-software` | Límites entre módulos, decisiones caras de revertir, ADR |
| `tech-lead` | Coherencia **entre** implementaciones del mismo patrón (los ocho adaptadores) |
| `backend-dev` | Dominio, servicios, acceso a datos, CLI, jobs, adaptadores |
| `frontend-dev` | `apps/web` cuando exista: cola de revisión del contador |
| `ux-designer` | Flujo y formato del entregable para quien hoy hace el trabajo a mano |
| `dba-data` | Esquema, migraciones, índices, RLS **como mecanismo de la base** |
| `devops` | Entornos, CI, migraciones en el pipeline, secretos, el gate |
| `qa-funcional` | Cobertura del **negocio**: que los casos de todos los meses estén cubiertos |
| `qa-automation` | La suite y el gate: que **cada test discrimine** (prueba por mutación) |
| `security-engineer` | Superficie técnica: authN/authZ, secretos, dependencias, configuración |

> **`security-engineer` y `seguridad-datos-financieros` NO se solapan y ante datos de clientes se
> convocan LOS DOS.** El primero pregunta *"¿por dónde se entra y por dónde sale?"* — dice si el control
> está **bien construido**. El segundo pregunta *"¿qué dato es sensible en este negocio?"* — dice si el
> control **protege lo que hay que proteger**. Un control impecable sobre el nivel de clasificación
> equivocado no sirve, y una clasificación correcta sin control tampoco.

**Matriz de convocatoria y guardrails detallados: `agents/README.md`.** Los agentes fiscales y contables
leen **exclusivamente** de `knowledge/` (regla dura §1.6). Qué cargar primero y de dónde:
`docs/agents/guia-carga-conocimiento.md`.

---

## 3.1. Reglas de delegación (**no es opcional: es la forma de trabajar por defecto**)

**No se desarrolla solo.** Quien conduce **orquesta**: por cada tarea, convoca a los agentes de la tabla
y recién después integra, verifica y decide. Los agentes **reportan**; quien conduce **aplica**.

> **Por qué está escrito como regla y no como sugerencia.** El Módulo 1 se construyó sin este roster. Al
> convocar al panel después, con `pnpm verificar` en verde, aparecieron **seis bloqueantes** — uno
> persistía una cuenta cuya verificación decía `no_cuadra`, y otro dejaba `apps/` fuera del typecheck.
> **El gate verde no sustituye al panel.**

| Si la tarea toca… | Convocar **siempre** |
|---|---|
| **Migración, tabla o columna nueva, cambio de RLS** | `dba-data` + `security-engineer` + `seguridad-datos-financieros` |
| **Código nuevo o modificado** (no trivial) | `code-reviewer` antes de cerrar; `backend-dev` o `frontend-dev` para escribirlo |
| **Decisiones de alcance y prioridad** | `product-owner` |
| **Una regla de negocio, un criterio de aceptación, material nuevo del estudio** | `analista-funcional` (+ el agente de dominio que corresponda) |
| **Testing** | `qa-funcional` (cobertura del negocio) y `qa-automation` (la suite y el gate); `tester` para el intento adversarial antes del "Done" |
| **Dos o más implementaciones del mismo patrón** | `tech-lead` |
| **Límites entre módulos, dependencias, ADR** | `arquitecto-software` |
| **Entornos, CI, gate, secretos, despliegue** | `devops` |
| **Pantallas y flujo de usuario** | `ux-designer` + `frontend-dev` + `seguridad-datos-financieros` |
| **Datos de clientes, dinero, permisos, aislamiento** | `seguridad-datos-financieros` — **obligatorio**, + `security-engineer` |
| **Plan de cuentas, asientos, cierre** | `contador-dominio` |
| **IVA, Ganancias, retenciones nacionales, SIRE** | `fiscal-nacional-iva-ganancias` |
| **IIBB, coeficientes, jurisdicciones, SIFERE** | `fiscal-ingresos-brutos-convenio-multilateral` |
| **Webservices, certificados, padrón** | `integraciones-afip` |
| **Clasificar movimientos / proponer asientos** | `motor-conciliacion-contable` + `contador-dominio` |
| **Modelo del cliente, atributos con vigencia, alta de tenant** | `plan-cuentas-multicliente` |
| **Estados contables, exposición, RT** | `balances-normas-tecnicas` |
| **Cerrar una feature o una decisión** | `documentador` (y escribir la entrada en `HANDOFF.md`) |

**Cómo se convoca, en concreto:**

1. **En paralelo cuando el trabajo es independiente** — un agente por archivo o por área. Si dos van a
   tocar lo mismo, se secuencian o se les prohíbe explícitamente el archivo compartido.
2. **Se les dice qué NO tocar.** Los archivos compartidos los toca quien conduce; el agente **reporta el
   diff** que necesita.
3. 🔴 **`privado/` está prohibido para todo agente**, siempre y sin excepción.
4. **Si `.claude/agents/` no está registrado en la sesión** (`Agent type '...' not found`), se usa el
   mecanismo portable del propio repo: un agente genérico que **adopte la persona** leyendo
   `agents/personas/<nombre>.md` completo. Es el mismo protocolo que usa Codex (`AGENTS.md`).
5. **Lo que el agente afirma se verifica** antes de aplicarlo. Ya pasó que un agente reportara mal, y
   también que uno corrigiera a quien conducía: las dos cosas se resuelven mirando el código.
6. 🔴 **Escribir "convoca: X" en un plan NO es convocar.** Pasó dos veces en este repo — el Módulo 1
   completo, y después una tanda de fixes de seguridad en la misma sesión que escribió este párrafo —
   que la tabla de arriba estuviera citada y aun así nadie llamara al agente. La intención escrita no
   ejecuta sola. La convocatoria es **estructural, no una promesa de texto**:
   - Toda tarea que caiga en la matriz de arriba se crea en el sistema de tareas **junto con** una
     tarea hija `convocar <agente> para <tarea>` por cada agente de la fila, con `addBlockedBy` sobre
     la tarea de implementación.
   - La tarea de implementación **no arranca** — no se marca `in_progress`, no hay `Edit`/`Write` sobre
     los archivos afectados — mientras la de convocatoria siga `pending`.
   - La tarea de convocatoria se marca `completed` únicamente después de una llamada real a `Agent()`
     cuyo reporte quedó incorporado. **El fallback de la regla 4 (persona no registrada) satisface esto
     igual, porque sigue siendo un `Agent()` separado** —`subagent_type: general-purpose` con el prompt
     de adopción, no `subagent_type: <nombre-de-la-persona>`— que produce una opinión de verdad
     independiente. Lo que **NO** satisface el gate, y no reemplaza ninguna convocatoria: narrar
     `=== [Persona] ===` dentro de la propia respuesta de quien conduce, sin invocar `Agent()`. Eso es
     el protocolo de Codex (`AGENTS.md` §5, una sola herramienta, sin subagentes) — en Claude Code, con
     subagentes disponibles, es exactamente el trabajar-solo-con-disfraz que esta regla existe para
     impedir. Nunca se marca `completed` por describir la convocatoria en un documento.
   - Es **inspeccionable**: alcanza con mirar `TaskList` para saber si la convocatoria existió y
     bloqueó, sin depender de que quien conduce lo recuerde o lo declare.

## 3.2. Modo plan obligatorio (**se planifica antes de tocar código, no después**)

**Antes del primer `Edit`/`Write`** sobre un cambio que dispare esta regla, se entra en modo plan y se
presenta un plan con estos cinco puntos. Recién después de que el usuario lo aprueba (`ExitPlanMode`)
arranca la implementación.

**Se activa cuando el cambio cumple cualquiera de estas** (no hace falta que se cumplan todas):

- **(a) Esquema o migración** — tabla, columna, RLS. Lo mismo que ya dispara `dba-data` +
  `security-engineer` + `seguridad-datos-financieros` en la matriz de §3.1.
- **(b) Seguridad, permisos, credenciales o datos de clientes** — aislamiento, visibilidad, secreto
  fiscal. Sin importar cantidad de archivos.
- **(c) Modifica (no crea de cero) un adaptador, motor o consulta que ya corre contra datos de un
  cliente o en producción.** Sin importar cantidad de archivos: el caso real que motiva este
  disparador es un diff de un solo archivo (`galicia.ts`, `HANDOFF.md` 2026-08-10 (17) §4 y (18) §3)
  que truncaba en silencio la razón social de un tercero en 814 de 1346 filas medidas — sin tocar
  esquema y sin ser "seguridad" en el sentido estricto de permisos o credenciales.
- **(d) 3 o más archivos**, salvo que el cambio sea puramente mecánico y sin cambio de comportamiento
  observable (rename, fix de import, reformateo) — en ese caso se declara así en una línea del mensaje
  de commit y no dispara el plan.

Ante la duda de si aplica, se activa: el costo de un plan de más es un párrafo; el de uno de menos ya
se pagó tres veces en este repo (ver el porqué, abajo).

**El plan contiene, siempre, estos cinco puntos:**

1. **Qué cambia y qué no.** Alcance explícito — qué archivo o módulo queda afuera **a propósito**, y
   **qué se pierde** con lo que se recorta (mismo criterio que dejó a Bancor "en pausa total" mientras
   se cerraba otra parte del trabajo). *No negociable: sin esto no hay decisión de alcance, hay una
   intención.*
2. **Qué se mide.** El criterio de aceptación en números — el conteo de `pnpm verificar`, el resultado
   del barrido, o la línea de base que corresponda. *No negociable: sin número no hay forma de
   verificar el cierre.*
3. **Predicción falsable de los números que se van a mover.** El método de
   `docs/diseno/09-lecciones-aprendidas.md` §5, generalizado: una tabla de "si sale X, significa Y",
   escrita **antes** de tocar código. *Negociable a una línea — incluida la respuesta explícita "no hay
   baseline, se mide en el paso 1" cuando el plan es exploratorio: eso no es saltear el campo, es una
   respuesta honesta.*
4. **Qué agentes se convocan.** Los que exige la matriz de §3.1 para este tipo de tarea, nombrados
   acá — se convierten directo en las tareas `convocar <agente>` con `addBlockedBy` que bloquean la
   implementación. *No negociable: es la razón de existir de esta regla — capturar la convocatoria
   antes de escribir código, porque después ya se demostró que no pasa.*
5. **El paso revertible más chico.** La unidad mínima que se puede probar, mergear o deshacer sola
   (mismo espíritu que "una tarea = una rama, PRs chicos" de §2). *Negociable a una línea — "el cambio
   ya es atómico" es una respuesta válida cuando no aplica descomponerlo.*

> **Por qué está escrito como regla y no como sugerencia.** `HANDOFF.md` (2026-08-10, entradas 17 y
> 18): se ejecutaron Parte 0 y Parte B de un plan de seis partes **sin convocar al panel** que exige
> §3.1 — la misma falla del Módulo 1, la **tercera vez**. Se frenó el trabajo a mitad de camino, se
> hizo una revisión retroactiva (`code-reviewer` + `seguridad-datos-financieros`) y aparecieron
> hallazgos **reales**: faltaba el detector de DNI en el redactor, `galicia.ts` truncaba una razón
> social partida en silencio, y `main` tenía el CI roto por una allowlist que nadie había regenerado.
> La corrección, en los hechos, fue escribir el plan completo y dejarlo aprobado por el usuario antes
> de seguir. Esta sección convierte esa corrección puntual en regla: **la Parte D de ese mismo plan es
> esta sección.**

**Relación con §3.1:** no la reemplaza. El punto 4 de acá **nombra** a quién se convoca; §3.1 sigue
rigiendo **cómo** se convoca y cuándo una tarea de convocatoria se marca `completed`. Un plan que dice
"convoca: X" en el punto 4 y no lo hace tiene el mismo problema que describe §3.1 punto 6 — la
intención escrita no ejecuta sola.

**Trazabilidad:** el plan aprobado se resume en la entrada de `HANDOFF.md` que cierra la tarea (§4).
Un plan que solo existió en la sesión no existe para la otra herramienta.

## 4. Handoff

Escribí una entrada en `HANDOFF.md` **apenas se cierra el DoD** de una tarea o decisión (no esperes al
final de la sesión). La otra herramienta (Codex) lee la misma bitácora y retoma. **Lo que no está
escrito en `HANDOFF.md` o en los docs, no existe para la otra herramienta.**
