# CHANGELOG

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado: **SemVer**, con las
reglas de `docs/devops/02-sdlc-git-flow.md` §5 — la versión **se corta al desplegar a producción**, no
al mergear.

> **Este archivo dice QUÉ cambió y qué significa para quien opera el sistema.** El **por qué**, lo
> medido y lo que quedó abierto viven en `HANDOFF.md` (bitácora), en `docs/arquitectura/ADR-*.md`
> (decisiones) y en `docs/seguridad/registro-incidentes.md` (incidentes). Acá se enlaza; no se copia.
>
> 🔴 **Regla no negociable** (`02-sdlc-git-flow.md` §5, regla de oro 4): un cambio que altera **qué
> significa un dato ya reportado** se declara **explícitamente** en la sección «Significado de datos ya
> reportados». Si esa sección dice «ninguno», es una **afirmación**, no un olvido.

---

## [Sin desplegar]

**El sistema nunca se desplegó a producción.** Hay dos entornos con datos: `local` (sintético) y
`piloto` (material real bajo la excepción **E-1** de `docs/seguridad/registro-excepciones.md`).
Producción arranca **vacía** y procesa desde cero: nada del piloto se promueve. Por eso todavía no hay
`v0.1.0`.

### Significado de datos ya reportados

**Ninguno declarado hasta hoy.** 🔴 **Y esto es un supuesto, no un hecho verificado:** el único
artefacto que salió del sistema hacia una persona es el export a Excel para el estudio. **Decisión
abierta, para `product-owner` + `analista-funcional`:** ¿ese export cuenta como «dato reportado» a los
efectos de la regla de oro 4? Si la respuesta es **sí**, entonces `0009` (unicidad y resolución de
cuenta) y `0012` (remediación de lote) hay que evaluarlos retroactivamente contra esta sección. **No se
decide acá.**

### Seguridad

Cinco incidentes registrados el 2026-08-15/16. El detalle —alcance, ventana y lo que **no** se puede
determinar— está en `docs/seguridad/registro-incidentes.md`.

- 🔴 **#1 — escalada de privilegios por shadowing de `pg_temp`.** **CONTROL CERRADO** con **R10 +
  R10 bis + R10 ter**, reescritas **dos veces el mismo día** y cerradas por **mutación** (40 corridas).
- 🔴 **#2 — ruptura del árbol de tenancía por edición manual de `tenant_node.path`.** **CONTROL
  CERRADO, con alcance declarado**: el `path` deja de ser un dato vigilado y pasa a ser una **función
  de `(parent_id, nid)`** que la base no puede dejar de cumplir. Control: **R36**, enunciada sobre el
  **predicado** y no sobre el mecanismo.
- 🔴 **#3 — credenciales de base commiteadas en un repositorio público.** **9 credenciales rotadas** en
  los dos entornos; `.env.example` fuera del tracking. Control: **R37 + R37 bis**, que reemplazan a
  R33. 🔴 **El cierre es del CONTROL, no de la exposición**: un secreto commiteado se considera público
  para siempre.
- 🔴 **#4 — defectos del control de integridad del árbol.** **ABIERTO** por el defecto **E** (el
  `DETAIL` del driver). A, B, C y D cerrados por `0017` y `0018`.
- 🔴 **#5 — el padrón de derechos es escribible por el sujeto del control, sin rastro.** **ABIERTO.**
- **Reglas verificables nuevas:** R36, R37, R37 bis (`ADR-0002` §B). **R13 y R33 quedan marcadas
  insuficientes** y reemplazadas.

### Añadido

| Migración | Qué agrega |
|---|---|
| `0001` | Multi-tenancy jerárquica (estudio → cliente) con RLS forzada. **Base de todo lo demás** |
| `0002` | Endurecimiento: grants por columna para N3, los cuatro renglones extra de N2-R/N3 |
| `0003` | Id de correlación generado por la aplicación |
| `0004` | Modelo de datos del **Módulo 1** — ingesta de extractos bancarios |
| `0007` | Concepto del banco tal como lo emite (agregarlo después habría sido reproceso irrecuperable) |
| `0008` | Los bloques del extracto que **no** son movimientos y hasta entonces se descartaban |
| `0011` | Catálogo de bancos, poblado con los tres códigos construidos |
| `0013` | Candidatos de contraparte por movimiento (HMAC) y **padrón de socios** |
| `0014` | Reconocimiento del motor **persistido**, con su determinante y su cadena de supersesión — **Módulo 2** |
| `0017` | `tenant_node.parent_path` (**N1, no exportable**: contiene `nid`, R25). No es un dato: es lo que vuelve **fila-local** el invariante del árbol |

### Cambiado

- **`0005`** — se eliminan las policies `for all`: cierra una **clase** de bug, no una instancia.
  🔴 Con un límite que el incidente #5 hizo visible: **sólo se aplicó a `credencial_fiscal`**;
  `membership` quedó afuera.
- **`0006`** — tres correcciones del panel sobre `cuenta`, todas **antes** del primer alta real.
- **`0009`** — unicidad de cuenta e índices de resolución. 🔴 **Cambia contra qué resuelven los
  extractos**: candidato a evaluarse en «Significado de datos ya reportados».
- **`0010`** — los dominios cerrados dejan de ser una promesa del código y pasan a `check` comentados.
- **`0015`** — 🔴 **`search_path` endurecido y `TEMPORARY` revocado de `public`.** Un rol de aplicación
  **ya no puede crear tablas temporales**. Si algún proceso propio dependía de eso, deja de funcionar y
  hay que concederle el privilegio explícitamente, con decisión escrita. Regla: **R10** y sus dos
  complementos.
- **`0017`** — 🔴 **el invariante de `tenant_node.path` baja de `constraint trigger` a `check` +
  `foreign key`.** Es **referencial**, y Postgres exime a `check`/`unique`/`foreign key` de la RLS **por
  diseño**; los triggers no. Consecuencias visibles: **R11 no se toca y no hizo falta ningún ADR**;
  `app_request` y `app_job` **pierden el `update` de tabla entera** sobre `tenant_node` y pasan a grants
  **por columna** (`nid` no lo escribe nadie); reparentar 801 nodos pasa de **~630 ms a ~148 ms** y un
  nodo hoja de **17,4 ms a 6,2 ms**; se paga **+24 % de tamaño**.
- **`0018`** — 🔴 **`app_request` pierde el `UPDATE` sobre `parent_id`** y conserva el `INSERT`. Colgar
  un nodo nuevo (el alta de un cliente) sigue siendo del alcance de la aplicación; **mover uno
  existente no**: queda en `app.reparentar_nodo()` con `app_job`, que es lo que `ADR-0001` §8.2
  declaraba desde el principio. **No es una restricción nueva: es hacer cumplir la que ya estaba
  escrita.**

### Corregido

- **`0012`** — remediación de un lote atrapado por el bug de atomicidad.
- **`0017`** — los **dos falsos positivos** que `0016` introducía: alta + borrado y alta + baja lógica
  **en la misma transacción** vuelven a commitear. Eso destrabó
  `packages/data/sql/tests/0001_aislamiento.test.sql`, que estaba **rojo en CI**.
- **CI** — el `.env` de integración se **genera con secretos aleatorios de un solo uso** en vez de
  copiarse de un archivo versionado. Antes hacía `cp .env.example .env`, y ese archivo se destrackeó
  por el incidente #3: **CI moría en el primer paso**, y por eso nadie vio que un test estaba en rojo.

### Retirado antes de cualquier release

- 🔴 **`0016_path_coherente.sql` — aplicada a local y piloto, y reemplazada por `0017` a las horas.**
  Nunca llegó a un release, así que **no hay nada que anunciar a un consumidor**; se declara igual
  porque **estuvo aplicada en el entorno con material real**. Su `constraint trigger` y su función los
  dropea `0017`.
  🔴 **Y por qué se reemplazó, que es lo único que hay que recordar de ella:** verificaba el invariante
  con un trigger `invoker` que **re-leía la fila bajo la RLS del escritor**, y **atribuía el cierre del
  incidente a la rama equivocada**. Ver el incidente **#4**.
  **Las migraciones no se editan ni se borran: `0016` queda en el árbol, aplicada, y `0017` la
  subsume.**

### Notas de operación

- **Aplicar `0017` requiere una ventana `no force row level security`** para el backfill de
  `parent_path`. 🔴 **Medido con un dueño NO superusuario** —lo que `ADR-0002` exige en producción, y
  que en local no se nota porque el dueño local sí lo es—: sin esa ventana el `update` afecta **0 filas
  EN SILENCIO** y el `add constraint` recién aborta después. La ventana **no es una exposición**: el
  `alter table` toma `ACCESS EXCLUSIVE` y lo retiene hasta el commit, y toda la migración es **una**
  transacción. **Su verificación va ADENTRO de la ventana**: afuera leería 0 filas y sería verde por
  vacuidad.
- **`0017` aborta si el árbol ya está incoherente.** Es a propósito: eso es estado del incidente #2 y
  hay que repararlo **antes**, no durante la migración.
- 🔴 **`0018` está aplicada a LOCAL y NO al piloto.** Espera confirmación explícita del titular.
