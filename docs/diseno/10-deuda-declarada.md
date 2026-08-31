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

## 0.0. 🧭 ROADMAP — qué falta, al 2026-08-16

> **Actualizado al cierre del expediente de seguridad** (`0015` a `0020`, incidentes #1 a #8),
> mergeado a `main` en `cd9fe95`. Esta sección es **el índice de lo que falta**; el detalle de cada
> línea vive en el documento que se cita.
>
> 🔴 **Cómo leer el orden:** lo de arriba **bloquea** a lo de abajo. La deuda de seguridad no es una
> lista paralela al producto: la recursión de RLS es una precondición de despliegue, y el determinante
> de idempotencia es una precondición del reproceso.

### A. Lo próximo, ya decidido

| | Qué | Estado |
|---|---|---|
| **A.1** | 🔴 **`0021` — rediseño del determinante de idempotencia.** El determinante persistido (`motor_digest`) cubre **el CÓDIGO, no la ENTRADA**, y la entrada es **mutable**: `recapturar-conceptos.ts` y `backfill-contraparte.ts` hacen `UPDATE` sobre `movimiento_bancario_crudo`. Un reproceso que cambie `concepto_banco` sin cambiar la clase **da no-op con la interpretación vieja intacta** — está declarado en `escrituras.ts:296-300` | ⚠️ **PLAN ESCRITO Y PREMISA MEDIDA (2026-08-17).** Expediente completo: **`11-migracion-0021-determinante-y-capa-c.md`**. Panel de 6 convocado; **P0 y P1 cerrados sin una línea de DDL**. 🔴 **La magnitud del bug, medida sobre el corpus real: 64 movimientos** (de 1830, 1754 cambian de digest y 64 conservan la clase). Faltan P2–P4 |
| **A.2** | 🔴 **La condición dura del dueño del esquema** — ver §6 de `08-plan-de-construccion.md`. **Antes de reconfigurar el dueño como NO superusuario en NINGÚN entorno**, hay que resolver la recursión infinita de RLS | Tarea propia con `security-engineer` + `arquitecto-software` + `dba-data` |

✅ **Las dos preguntas de diseño ya fueron al panel y están DICTAMINADAS** (2026-08-17). El detalle, con
la evidencia ejecutada, está en `11-migracion-0021-determinante-y-capa-c.md` §3 y §4. Resumen:

1. **¿Columna generada + `unique`, o hash calculado en TypeScript?** → **Generada en
   `movimiento_bancario_crudo`** (donde la entrada es fila-local) **+ foto histórica por trigger
   `BEFORE INSERT` + `not null`** en `reconocimiento_movimiento`.
   🔴 **Y la premisa de esta pregunta, tal como estaba escrita acá, era FALSA:**
   `0017_path_por_construccion.sql` **NO usa una columna generada** — usa columna espejo plana + `CHECK`
   fila-local + FK compuesta `match full deferrable` + trigger (`0017:131, 180-182, 198-202, 213-232`).
   El precedente real de generada+`unique` es `0014:184` (`es_propuesta`), con expresión **inline pura**;
   en todo el repo no hay una generada que invoque una función de usuario.
   🔴 **Y la FK que ese patrón sugería quedó descartada por medición:** *una FK afirma un hecho
   PRESENTE; el determinante registra uno HISTÓRICO* — con `on update restrict` el primer reconocimiento
   **congela `concepto_banco` para siempre** y `recapturar-conceptos.ts` muere con `23503`.
2. **¿Se recorta el `grant insert`?** → **Sí, pero la premisa también era falsa.** Una generada **no es
   falsificable ni bajo grant de tabla** (`cannot insert a non-DEFAULT value`: rechaza el mecanismo, no
   el privilegio), y una columna llenada por trigger **se sobrescribe en silencio**. El recorte no compra
   integridad: compra que el intento falle **ruidoso**.
   🔴 **El recorte va igual, por dos agujeros vivos HOY en `0014`**: `created_at` insertable (un tenant
   **antedata** su propio reconocimiento) y `superseded_por` insertable (una fila **nacida superseded**
   sale del índice parcial, **nunca llega a la cola de la contadora**, y nada falla).

**Dato que simplifica A.1:** el piloto tiene **1830 movimientos y CERO reconocimientos persistidos**.
No hay backfill, no hay filas que migrar, no hay riesgo sobre datos existentes. La migración es de
esquema puro.

### B. El producto, donde estaba

| | Qué | Bloqueado por |
|---|---|---|
| **B.1** | **Capa D — imputación** (qué cuenta se debita y cuál se acredita) | El **plan de cuentas del cliente**, que no existe todavía |
| **B.2** | **Capa E — composición del asiento** | Ídem B.1 |
| **B.3** | **La cola de revisión del contador** (`apps/web`) — el sistema es **asistido**: el motor propone y la contadora decide. Hoy no hay dónde decidir | Convoca `ux-designer` + `frontend-dev` + `seguridad-datos-financieros` |
| **B.4** | **Login / `AuthProvider`** — hoy la identidad entra por un GUC que setea la sesión (**incidente #8**). No hay autenticación de personas en ningún lado | Es la otra mitad del #8: sin aplicación que firme, `hecho_por` no vale como atribución |
| **B.5** | **FCI y tarjetas** — suscripción y rescate de FCI con **inventario PEPS**, pago de tarjeta corporativa, y la **liquidación del adquirente**. `01-modulo-1-ingesta-bancaria.md` marca el inventario PEPS de apertura como *«lo único que no se puede reconstruir después»* y la liquidación del adquirente como *«sin ella la regla 11 queda mal para siempre»* | Material del estudio + `contador-dominio`. **Alta prioridad de captura, aunque el cálculo venga después** |
| **B.6** | **`knowledge/` sigue vacío** — siete huecos normativos. Los cuatro que el Módulo 2 consume directo: crédito fiscal, percepciones, régimen de recaudación bancaria provincial, y porción computable del impuesto a los débitos y créditos | Es la razón por la que los agentes fiscales contestan *«no tengo esa fuente cargada»*. **Eso es el guardrail funcionando, no una falla a compensar** — pero tiene costo operativo real desde el incidente #3 |
| **B.7** | ✅ **CERRADO (2026-08-29, Sesión 1 de `27-roadmap-capa-d.md`, Bloque 1). Veredicto: el período se declara POR CUENTA, no por archivo.** Convocatoria real a `analista-funcional` + `contador-dominio`, cada uno por separado, ambos coinciden sin disenso: un solo rango `periodo_desde`/`periodo_hasta` por archivo (`documento_ingerido`, agregado tipo `MIN`/`MAX`) no puede distinguir "la cuenta USD recién existe desde el 15" (apertura real, cierre completo igual) de "falta la primera quincena del extracto" (documento incompleto, no se puede cerrar) — son las dos lecturas opuestas que un agregado ciego confunde, y es exactamente el caso real de Macro/ROKA que motivó el hallazgo original de `dba-data`. `contador-dominio` agrega el argumento de fondo: la pregunta que el contador necesita responder para cerrar el mes es "¿tengo la fuente completa de CADA cuenta?", que es una pregunta por cuenta, no por documento. **Hallazgo adicional de `analista-funcional`, no nombrado antes**: la columna `cobertura` de `documento_ingerido` (`completo`/`parcial`/`corte_a_fecha`) tiene el mismo defecto estructural — un valor por archivo no puede representar "completo para 2 cuentas, parcial para la tercera" — cualquier cierre de B.7 que no la incluya vuelve a mentir por la misma vía. **Queda para Bloque 2 (`dba-data`), sin decidir acá**: DÓNDE vive la granularidad por cuenta en el esquema — dos candidatas ya existentes, `fuente_cierre` (ya tiene `documento_ingerido_id` + `cuenta_bancaria_id`, hoy sin período) o una tabla hija nueva tipo `documento_ingerido_cuenta` (espejo de `lote_ingesta_cuenta`) — la diferencia es de TIMING: `fuente_cierre` nace recién al asignarse a un `cierre_id`, y la comparación "tengo 2 de 5 fuentes" parece necesitar la cobertura por cuenta antes de que exista ese cierre. **No medido, queda para `dba-data`/`qa-funcional` antes de escribir el backfill**: si los 3 lotes reales ya ingeridos (Bancor/Nación/ICBC) tienen hoy períodos divergentes entre cuentas — ninguno de los 3 es multi-cuenta, así que no bloquea el backfill trivial. **Pendiente de Laura, sin resolver por supuesto** (`contador-dominio`): cómo se determina el período real de cada cuenta en el PDF de Macro (fecha de apertura declarada por el banco vs. inferida por ausencia de movimientos — la segunda es un dato frágil, cuenta inactiva ≠ cuenta recién abierta) | Cerraba precondición del **backfill** (D-17 de `24`). El DDL que instrumenta la granularidad por cuenta queda para Bloque 2, no crea trabajo nuevo para Bloque 1 |
| **B.8** | ✅ **CERRADO (2026-08-30, Bloque 2 de `27-roadmap-capa-d.md`). Migración `0029_pendiente_cierre_reproceso.sql` aplicada a LOCAL y al PILOTO** (verificada por consulta directa al catálogo en ambos entornos — `HANDOFF.md` 138). Convocatoria real a `dba-data` + `arquitecto-software`, sin disenso en el fondo. `uq_pendiente_cierre_natural` (`0027_cierre_mensual.sql`) no tiene predicado parcial, a diferencia de lo que ya pedía el diseño de referencia (`23-arquitectura-cierre-mensual.md` §2.2, línea 520: *"parcializados por vigencia donde hay supersesión"*) — y del precedente ya aplicado en la MISMA migración (`uq_cierre_periodo_vigente`, `0027:324-328`, índice parcial). **El fix no es solo el predicado**: `dba-data` encontró que el trigger de `0028` (`trg_pendiente_cierre_inmutable`) exige, para superseder, un único `UPDATE` sobre la fila vieja que fije `superseded_by_id` a un `id` que la fila nueva TODAVÍA no tiene (si se inserta después) — con predicado parcial solo, ambas filas coexisten un instante bajo el mismo predicado y el `INSERT` sigue chocando 23505. Se necesitan DOS cambios de DDL, no uno: (1) `uq_pendiente_cierre_natural` pasa a índice parcial `... NULLS NOT DISTINCT WHERE superseded_by_id IS NULL` (mismo idiom que `uq_recon_vigente` de `0014` y `uq_cierre_periodo_vigente` de `0027`); (2) `fk_pendiente_cierre_superseded` pasa a `DEFERRABLE INITIALLY DEFERRED`, para poder hacer `UPDATE` de la vieja (con el `id` de la nueva, generado por la aplicación, no por el default) ANTES del `INSERT` de la nueva. Sin (2), (1) solo no alcanza. Ninguna FK apunta a la clave natural (todas usan el surrogate `(cliente_id, id)`), así que el cambio es seguro desde ese ángulo; `idx_pendiente_cierre_gate` es ortogonal (filtra por `pendiente_estado`, no por esta unique). **Hallazgo nuevo de `arquitecto-software`, no bloquea B.8 pero queda registrado**: el mismo patrón (`unique nulls not distinct` sin predicado parcial en una tabla con `superseded_by_id`) se repite, sin síntoma todavía porque nada las ejercita, en `documento_ingerido` (`uq_documento_ingerido_natural`, `0027:243-245`, con self-FK igual de no-deferrable) y, de forma parcial (comparten la unique sin predicado, sin confirmar si comparten el mismo mecanismo de FK), en `expectativa_fuente_cliente` (`uq_expectativa_natural`, `0027:474-476`) y `fuente_cierre` (`uq_fuente_cierre_natural`, `0027:531-532`). **Alcance decidido por JP (2026-08-30): `0029` se acota a `pendiente_cierre`.** Mismo principio que ya
se aplicó con Macro/Bancor (medir antes de tocar algo "porque se parece" — no hay síntoma medido en las
otras tres tablas todavía, así que corregirlas ahora sería suponer, no corregir). El hallazgo de
`arquitecto-software` sobre `documento_ingerido`/`expectativa_fuente_cliente`/`fuente_cierre` queda
declarado como **B.9** (ver abajo), sin dueño, para que una convocatoria futura confirme con evidencia
si de verdad comparten el defecto — no por parecido de forma. Confirmado por ambos agentes: no hace
falta tocar el trigger de `0028` (gobierna solo la fila vieja, ortogonal a esta unique) ni
`SECURITY DEFINER` nuevo. **Aplicado con modo plan formal previo** (`CLAUDE.md` §3.2, plan aprobado por
JP). **Prueba de mutación: `mutaciones-0029-pendiente-cierre-reproceso.test.ts`, 6/6 verde** (3
legítimos incluido el caso cross-tenant, 1 ataque de duplicado activo, 2 mutaciones de refutación — una
por cada componente del fix, índice y FK; el caso de "cliente_id fuera del índice" quedó
explícitamente NO incluido, con su motivo documentado en el propio archivo: no es construible como
mutación que discrimine en este esquema, `cierre_id` ya ata cada fila a un único cliente por FK
compuesta). El test legítimo de supersesión de `mutaciones-0028-inmutabilidad-post-terminal.test.ts`
(antes con el workaround de `referencia_origen` distinto) se reescribió para probar el caso real —
**16/16 verde, sin regresión**. `mutaciones-0027.test.ts`: **10/10, sin regresión**. `pnpm typecheck` y
barrido de fuga limpios. **Aplicada al piloto (2026-08-30), verificada por catálogo — `HANDOFF.md` 138.** | Ya no bloquea el
flujo real de reproceso de `pendiente_cierre` — el esquema lo soporta; falta el código de aplicación
(Capa D, todavía sin implementar) |
| **B.9** | 🟡 **Hallazgo declarado, sin dueño, NO verificado con síntoma real** (`arquitecto-software`,
convocatoria de B.8, 2026-08-30). El mismo patrón de B.8 (`unique nulls not distinct` sobre la clave
natural, sin predicado parcial, en una tabla con `superseded_by_id`) aparece también en
`documento_ingerido` (`uq_documento_ingerido_natural`, `0027_cierre_mensual.sql:243-245`, con self-FK
igual de no-`deferrable`) y, de forma parcial —comparten la unique sin predicado, sin confirmar si
comparten el mismo mecanismo de FK de supersesión— en `expectativa_fuente_cliente`
(`uq_expectativa_natural`, `0027:474-476`) y `fuente_cierre` (`uq_fuente_cierre_natural`, `0027:531-532`).
JP decidió explícitamente NO corregirlas junto con B.8: sin un flujo real que las ejercite todavía, no
hay forma de confirmar que necesitan el mismo fix (índice parcial + FK deferrable) y no otra variante.
**Cierre:** antes de que cualquiera de las tres tenga un flujo de reproceso real (Capa D en implementación),
medir si el mismo choque de `INSERT` ocurre, con el mismo método que ya destapó B.8
(`mutaciones-0028-inmutabilidad-post-terminal.test.ts`) — no asumir que sí por la similitud de forma | No
bloquea nada hoy: ninguna de las tres tiene todavía un flujo de reproceso real que la ejercite |
| **B.10** | 🟠 **2 de las 4 cuentas de socio de ROKA (`69479b8f-...`), asignadas PROVISORIAMENTE — pendiente de confirmación de Laura, HANDOFF (140).** El plan de cuentas real de ROKA tiene 4 códigos ligados a persona (`1.2.4.300`, `1.2.4.400` en Activo; `2.1.9.100`, `2.1.9.200` en Pasivo — 1 código por persona, no pareado Activo+Pasivo como Bracci). De los 4 `padron_socio_id` reales cargados: **2 confirmados por evidencia documental real** (`1.2.4.300`=Gabriela, único alta de ROKA de la tanda de entrada 73; `1.2.4.400`="Cuenta Particular Socio 4"=el familiar NO-socio, resuelto en `privado/02-Consultas-Laura-2026-08-21.md` §1.5 pregunta 8, y verificado por HMAC del CUIT documentado contra `padron_socio.documento_hmac` — nunca por texto ni por orden). **Los otros 2 (`2.1.9.100`, `2.1.9.200`) quedan SIN documento que resuelva cuál de las dos socias restantes es "Socio 1" y cuál "Socio 2"** — decisión explícita de JP para destrabar el piloto: asignados a los 2 `padron_socio_id` restantes (verificados por HMAC que NO son el familiar, o sea que son socias reales) en orden de `created_at` ascendente. Marcados `"confirmado": false` en el JSON de mapeo (fuera del repo, scratchpad de sesión, nunca commiteado) | Ninguno — la carga real (219/219) ya está aplicada al piloto. Cuando Laura conteste cuál socia es "Socio 1"/"Socio 2", volver a esta tarea: si el orden asumido resultó incorrecto, el fix es un `UPDATE` de `cuenta_atributo.padron_socio_id` para esas 2 filas puntuales, con su propio registro de auditoría — no una re-carga completa |

| **B.11** | 🟡 **Riesgo ACEPTADO, documentado (D-27, sesión nocturna autónoma 2026-08-31, `dba-data`):
NO hay guardia contra reingesta/período parcialmente solapado en `documento_ingerido`/
`fuente_cierre` ↔ `lote_ingesta` (correspondencia por rango `cliente_id, cuenta_bancaria_id, fecha ∈
periodo`).** `0032_documento_ingerido_lote_fk.sql` SÍ agregó la FK física
`documento_ingerido.lote_ingesta_id → lote_ingesta` (gap más grave, ya cerrado: `lote_ingesta.
archivo_clave` es nullable y sin `unique`, así que el enganche por string previo podía matchear más
de una fila sin desempate). Lo que sigue SIN guardia es el solape de rango en sí. Motivo de aceptar
el riesgo, no de ignorarlo: (1) la vía idiomática de Postgres (`EXCLUDE USING gist` sobre
`daterange`) está bloqueada estructuralmente — `btree_gist` es una extensión no-core que ADR-0000 §6
prohíbe, ya confirmado por `0009`/`0013` para vigencias MÁS simples; la alternativa sin extensión es
un trigger procedural con `SELECT ... FOR UPDATE`, pieza de concurrencia no trivial; (2)
`uq_documento_ingerido_natural` (`0027`) ya bloquea el caso más común (mismo archivo, mismo período
exacto) — lo que queda sin cubrir es un período PARCIALMENTE solapado, error humano de carga
administrativa, no un evento del flujo automático; (3) hoy CERO código de aplicación ejercita este
camino (Capa D de código no arrancó) | Revisar quirúrgicamente cuando arranque la Sesión 2b de
código sobre Bracci (`27-roadmap-capa-d.md` §B.5) — si el patrón de carga real muestra reingestas
frecuentes, se sube de prioridad con datos medidos, no con una hipótesis |

| **B.12** | 🟡 **Hueco declarado, sin resolver (sesión nocturna autónoma 2026-08-31, hallazgo
convergente de `security-engineer` H3 + `seguridad-datos-financieros`, sin coordinarse entre sí):
`cuenta_atributo` no tiene NINGUNA columna de identidad de quién dio de alta o cambió una fila** —
a diferencia de TODO el resto de Capa D (`resuelto_por` en `pendiente_cierre`, `hecho_por` en
`cierre_transicion`, `confirmado_por` en `cierre_cliente_periodo`, `dispensado_por` en
`pendiente_dispensa`, y ahora `decidido_por` en `regla_imputacion`, agregada esa misma noche
precisamente para no propagar este hueco a la tabla nueva). Mitigación PARCIAL, no estructural:
`apps/cli/src/alta-plan-cuentas.ts` envuelve el alta en `escribirConAuditoria`, que deja un registro
en `acceso_auditoria` con `user_id` — pero es **por invocación** (quién dio de alta el lote de N
cuentas), no por fila, y nada en el esquema impide un `INSERT`/`UPDATE` directo sobre
`cuenta_atributo` que se salte ese wrapper: es el mismo patrón que este repo ya catalogó como
R33/R13 ("un control que depende de que el código lo recuerde no es un control"). Distinto de B.11:
acá no hay alternativa técnica bloqueada — agregar una columna `decidido_por uuid not null` a
`cuenta_atributo` es una migración aditiva sin backfill (la tabla tiene datos reales en el piloto,
así que el backfill de las filas existentes, si hace falta, es tarea aparte) | Diferido a la Sesión
2b de código sobre Bracci — mismo momento en que se revisa B.11 (`27-roadmap-capa-d.md` §B.5),
convocar `dba-data` para la migración cuando se decida cerrarlo |

### C. Deuda técnica que no bloquea, pero se cobra sola

- **La deuda de seguridad abierta**: `08-plan-de-construccion.md` §6.0 — nueve líneas, de bloqueante de
  despliegue a higiene.
- **El lote-ancla se pierde en todo camino de excepción** (§1.1 de este documento).
- **`pnpm db:seed` roto contra una base desde cero**: faltan `movimiento_contraparte_identificador` y
  `membership_historia` en la lista de `truncate` de `sembrar.ts`. La suite corre porque
  `tests/ayuda.ts` sí las tiene — **el runbook no**.
- **`0016_path_coherente.sql` quedó en el historial de migraciones** aunque `0017` la reemplazó por
  completo. No se toca (una migración aplicada no se edita), pero quien lea el directorio va a
  encontrar dos migraciones del mismo invariante.
- 🟡 **Validación legal de Poppler (`pdftotext`) como subproceso externo, pendiente — sin dueño.**
  `packages/ingesta/src/fci-santander/extraer-posiciones.ts` invoca `pdftotext` (Poppler, licencia GPL)
  como binario de sistema vía `node:child_process`, nunca importado/linkeado — ADR-0000 §2.4 documenta
  el criterio ("GPL solo como proceso externo separado"). Ese criterio es la práctica de la industria,
  **no fue revisado por un abogado**. Cierre: antes de vender este producto a un **segundo estudio o
  cliente externo al piloto**, confirmar con asesoría legal que el patrón sostiene la distribución
  comercial tal como está planteada — y, si no, decidir reemplazo de binario o cambio de modelo de
  distribución. Detalle completo: `docs/arquitectura/ADR-0000-stack-infra.md` §2.4.
- 🟡 **Promoción de "reconcile-or-refuse" a regla formal (candidata R43) en `ADR-0002-seguridad.md`
  §B — pendiente, sin dueño.** Principio ya aplicado en código (`SaldoDesalineadoError`,
  `EncabezadoDeFondoNoEncontradoError`, `ConsistenciaInternaPdftotextError`,
  `FuentesDesincronizadasError` — `fci-santander/extraer-posiciones.ts`): ningún extractor que compare
  dos fuentes para el mismo dato numérico/estructural puede reconciliar una discrepancia en silencio,
  siempre abortar con el detalle exacto. Documentado como principio en
  `docs/diseno/19-fci-santander-extractor-hibrido.md`, **no promovido formalmente todavía**: la
  promoción a regla de `ADR-0002` §B exige la **prueba de mutación de §B.0** (código defectuoso que la
  ponga roja, caso legítimo, conteo de mutaciones declarado) — esa prueba es parte de la tarea de
  cierre, no un paso posterior opcional.
- 🟡 **Ninguna herramienta de la sesión de trabajo fuerza `formaParaLog` sobre un comando de shell
  suelto contra un documento real — pendiente, sin dueño.** `registro-incidentes.md` fila **12**
  (2026-08-25): un agente corrió `pdftotext -layout ... \| sed 's/[0-9]/9/g'` directo por Bash para medir
  la estructura de un PDF real, redactando solo dígitos — dos cadenas de letras (razón social, nombre de
  titular) quedaron en texto plano en la salida. El código de producción está bien (`formaParaLog` cubre
  letras y dígitos, y es lo que usan `probar-adaptador.ts` y los scripts de medición del propio módulo);
  el hueco es que **nada impide que un agente use el binario de sistema directo en vez del script del
  proyecto**. No hay lint ni test que pueda cubrir esto — es un hábito de trabajo, no una regla
  verificable de ADR-0002 §B. Cierre, si alguna vez se decide cerrar: un wrapper de repo para lecturas
  ad hoc de un documento real (`pnpm medir <archivo>` con salida ya pasada por `formaParaLog`), para que
  la vía rápida sea también la segura — hoy la vía rápida (`pdftotext` a mano) es la insegura.
- 🟡 **Bloque de totales/comisiones de Bancor (página final del extracto), literal no confirmado —
  pendiente, sin dueño.** `docs/diseno/20-formato-bancor.md` §6: 9 líneas con patrón `etiqueta: $importe`
  detectadas por estructura, pero sin el texto exacto de la etiqueta confirmado contra el documento real
  (el clasificador de permisos bloqueó una lectura cruda adicional, correctamente — ver incidente #12 de
  `registro-incidentes.md`). Hoy van a `lineasNoInterpretadas` (`linea_fuera_de_zona`), no a `anexos[]`:
  `anexoExtractoSchema` exige el literal real, no una forma. Cierre: confirmar las 9 etiquetas contra el
  PDF real (o uno nuevo del mismo banco) y promoverlas a `anexos[]` con su `relacionConMovimientos`.
- 🟡 **`--banco <código no catalogado>` pierde el lote-ancla, sin rastro en `acceso_auditoria` —
  preexistente, no específico de Bancor.** Hallazgo de `security-engineer` al revisar
  `0024_catalogo_bancor.sql`: en `apps/cli/src/ingestar.ts`, el PASO 4 inserta en `lote_ingesta` con
  `banco_codigo` referenciando `banco(codigo)` (FK). Si el operador declara un código que no está en el
  catálogo (hoy: `bbva`, `icbc`, `nacion`), el `insert` viola la FK **antes** de que exista el lote-ancla
  — la transacción revierte sin dejar fila de auditoría, al revés de lo que el propio comentario del
  archivo promete ("el lote se crea antes de todo... para que el rechazo tenga dónde asentarse"). No es
  una fuga (sale por `redactar()`, código de salida distinto de cero), pero es peor observabilidad que el
  camino de un banco catalogado sin adapter (que sí falla con rastro, vía `sin_adaptador` en el PASO 6).
  Cierre: validar `--banco` contra el catálogo ANTES del PASO 4, con su propio motivo de rechazo
  auditado, en vez de dejar que la FK sea el único guardia.
- 🟠 **Las 11 tablas de `0027_cierre_mensual.sql` no estaban registradas en dos verificadores de drift
  independientes — CERRADO PARCIAL (2026-08-27, HANDOFF 130): 9 tablas + 1 vista declaradas, 2 tablas
  quedan sin declarar A PROPÓSITO por un hallazgo de seguridad bloqueante sin resolver.** La migración
  `0027` (commit `9aacbe9`, HANDOFF 128) agregó `cierre_cliente_periodo`, `pendiente_cierre`,
  `pendiente_dispensa`, `fuente_cierre`, `expectativa_fuente_cliente`, `cuenta`, `cuenta_atributo`,
  `asiento_propuesto`, `asiento_propuesto_renglon`, `documento_ingerido` y `cierre_transicion` — once
  tablas con `cliente_id` — más la vista `asiento_propuesto_totales` (encontrada al extraer el estado
  real, no nombrada en el pedido original: el barrido de grants también la ve).
  - **`packages/ingesta/tests/aislamiento-modulo-1.test.ts`: CERRADO, 16/16 verde.** Las 11 tablas
    entraron a `FUERA_DEL_MODULO_1` con motivo real por tabla — `documento_ingerido` con motivo
    distinto a propósito ("hoy vacía, conexión futura pendiente", D-17 de `25-segunda-convocatoria-
    cierre-mensual.md`, no "nunca la va a llenar Módulo 1").
  - **`packages/data/tests/grants-conjunto-cerrado.test.ts`: 12/20 SIGUE ROJO, a propósito.** Al
    convocar `dba-data` + `security-engineer` sobre el diseño concreto, `security-engineer` encontró
    que `cierre_cliente_periodo` y `asiento_propuesto` tienen un `grant update` a nivel TABLA (no
    acotado por columna, a diferencia de las otras nueve) que permite reescribir
    `confirmado_por`/`confirmado_en`/`fecha_imputacion` sobre un registro YA confirmado, sin pasar por
    el gate de D-24 (el trigger sólo dispara `UPDATE OF cierre_estado`) y sin dejar rastro. **Hallazgo
    BLOQUEANTE** — esas dos tablas NO se declararon; el archivo compara el esquema completo en casi
    todos sus tests, así que 2 tablas sin declarar siguen contaminando 12 de sus 20 tests (antes: 16
    tests rojos en total entre los dos archivos por 11 tablas sin declarar; ahora: 12, todos por estas
    2). Convocatoria de seguimiento pendiente (`arquitecto-software` + `dba-data` +
    `security-engineer`) para decidir el cierre real del grant — recién ahí estas dos tablas se
    declaran y el archivo vuelve a verde completo.
  - **No es una fuga ni un privilegio ejercido de más** en las 9 tablas + vista ya declaradas: son
    grants que Postgres ya tenía desde `0027`, verificados línea por línea contra el `.sql` por dos
    agentes independientes, sin discrepancia.
  - Hallazgo de proceso aparte, separado, no cerrado acá: 13 de los últimos 15 pushes a `main` corren
    con CI en rojo (incluidos `9aacbe9` y `e67a256`), sin que nada bloquee seguir commiteando —
    precedente ya documentado sin cerrar (`HANDOFF.md:~10249`). Detalle completo de todo lo de arriba:
    `HANDOFF.md` (130).
- 🔴 **`.githooks/pre-commit` corrompe el índice de git en un worktree — CONFIRMADO (2026-08-29, Sesión 1
  Capa D, Bloque 1), ya no es hipótesis. Dueño: `security-engineer` (no `devops`/`qa-automation` como
  decía la entrada anterior — ver por qué, abajo).** Síntoma ya descrito sin causa en `HANDOFF.md`
  (2026-08-28, entrada 132, §C.3): al commitear desde un worktree, `git status` pasa a mostrar los ~450
  archivos del repo como borrados-y-sin-trackear a la vez, de forma no destructiva (el working tree queda
  intacto; `git reset` reconstruye el índice sin tocar nada).
  - **Causa raíz, ahora verificada leyendo el código, no solo inferida por `GIT_TRACE`**: git exporta
    `GIT_INDEX_FILE=<worktree>/index` al invocar el hook, y ese valor se hereda por los procesos hijos.
    `repoSintetico()` (`tools/barrido-credenciales.test.ts:47-60`) invoca `execFileSync('git', ['init'…])`
    y `execFileSync('git', ['add', '-f', '.'])` con `cwd` en un tmpdir propio pero **sin despojar el
    `env` heredado** — el `GIT_INDEX_FILE` inherited tiene prioridad sobre el descubrimiento por `cwd`,
    así que esos comandos escriben en el ÍNDICE REAL del worktree en vez del sintético. **Reproducido
    directamente**: el test pasa 19/19 corrido a mano (`npx vitest run`, sin `GIT_INDEX_FILE` en el
    entorno) y falla 1-5/19 corrido vía `git commit` real (con el hook, que sí exporta la variable) —
    la única diferencia entre ambas corridas es esa variable de entorno.
  - **Hallazgo NUEVO en esta sesión, más grave que el original**: el mismo patrón está en
    `archivosTrackeados()` (`tools/barrido-credenciales.ts:157-162`, código de **producción**, no de
    test) — `execFileSync('git', ['ls-files', '-z'], { cwd: raiz, ... })` tampoco despoja el `env`
    heredado. Es la función que decide qué archivos escanea el detector de fuga de credenciales real
    (R37, el mismo que investigó el incidente #3). Un intento de arreglo acotado solo a `repoSintetico()`
    (probado y revertido en esta sesión, sin commitear) deja `archivosTrackeados()` con el mismo defecto
    cuando se la llama con un `raiz` explícito — los tests de mutación de R37 (los que plantan una
    credencial en un repo sintético y esperan que el barrido la detecte) empiezan a fallar en falso
    NEGATIVO bajo el hook, exactamente lo que R13/R10 ya enseñaron que es el peor tipo de falla de un
    detector de seguridad: verde donde debería estar rojo.
  - **Por qué el dueño cambia de `devops`/`qa-automation` a `security-engineer`**: no es un test flaky
    cualquiera — es el detector de credenciales de producción operando sobre el índice equivocado
    durante su propia prueba de mutación, dentro del mismo hook que lo usa como gate real antes de cada
    commit. Necesita su propia convocatoria y verificación (mismo criterio que ADR-0002 §B.0: probar
    rompiendo, no solo corregir y asumir), no un parche de paso en una tarea de otro dominio — por eso
    NO se aplicó el fix en esta sesión (revertido explícitamente, ver HANDOFF de esta fecha).
  - **Cierre propuesto, sin aplicar**: despojar `GIT_INDEX_FILE`/`GIT_DIR`/`GIT_WORK_TREE`/
    `GIT_COMMON_DIR` del `env` en los tres call sites (`repoSintetico()` ×2 y `archivosTrackeados()` ×1),
    y agregar un caso de prueba que reproduzca el escenario del hook (`GIT_INDEX_FILE` seteado) para que
    la regresión, si vuelve, se detecte sin depender de commitear desde un worktree real.
- El resto de las secciones de este documento.

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

### 1.8 🟡 El `PUT` al storage no participa de la transacción: un fallo POSTERIOR deja el objeto huérfano, confirmado contra el piloto

Manifestación concreta de lo que §1.4 ya señalaba en abstracto ("el `PUT` corre dentro de la
transacción [de Postgres, pero el storage no participa de esa transacción]"), confirmada por primera vez
contra un dato real: HANDOFF 2026-08-11 (44), `completar-lote.ts` corrió contra el piloto con la
migración `0012` sin aplicar ahí. `guardarExtractoTrasResolver` hizo el `PUT` con éxito (log
`extracto.guardado`), y el `update` de `lote_ingesta` que sigue **después** falló por la columna
inexistente. `conUsuario` revirtió Postgres entero, pero el objeto en S3/MinIO **no tiene reversa**: quedó
en el bucket real, sin ningún `archivo_clave` que lo señale.

**No es una fuga** (nada lista por prefijo, nada lo sirve sin `archivo_clave`) y **es autocurativo en
este caso puntual**: la clave es determinística (`cliente_id` + `lote_id`, `clave.ts`), así que la
próxima corrida exitosa vuelve a hacer `PUT` sobre la misma clave (sobreescribe con contenido idéntico,
sin duplicar nada) y esta vez si el `update` tiene éxito, `archivo_clave` sí lo termina señalando. **Pero
el mecanismo general sigue sin reversa**: si el fallo posterior no fuera transitorio/reintentable (por
ejemplo, un error real de negocio que aborta la corrida para siempre en vez de una migración pendiente),
el objeto quedaría huérfano permanentemente, sin que nada en el sistema lo detecte. **Cierre correcto,
pendiente**: mover el `PUT` fuera de la transacción por completo (guardar primero bajo una clave
provisoria/con TTL, confirmar después) o un job de barrido que compare objetos existentes contra
`lote_ingesta.archivo_clave` — ninguna de las dos se intentó acá, alcance de una tarea aparte.

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

🔴 **C5 confirmado contra archivo real, con un hallazgo pendiente de investigar (Santander,
2026-08-11).** `pnpm probar` contra los tres archivos reales: Macro y Galicia coinciden exacto con la
predicción del punto anterior (`fueraDelCuerpo`/`residuo` como se esperaba, `INV-destinos:
diferencias=0` en los dos). **Santander mide `residuo=5`** — la primera vez que se mide contra archivo
real (antes solo contra el fixture sintético); no había una predicción numérica escrita para
compararlo, a diferencia de Macro/Galicia.

Formas de las 5 líneas (`a`=minúscula, `A`=inicial mayúscula, `#`=dígito — nunca el texto real, mismo
criterio del propio `pnpm probar`; guardadas en `HANDOFF.md` 2026-08-11 (31) para que sobrevivan un
resumen de contexto):

```
×1  Aaaaaaa aa a{9} a{8} aaa ##### aaa ##-##-#### aa ##-##-####
×1  Aaaaaaa a{11} aa aaa a{9} aaaaaa aaaaa a{8} aaa ##-##-#### …
×1  Aa{8} Aa{8}
×1  Aaaaa Aaaa Aaaaaa Aaaaaa Aa{10} AAA AAA AAAAA Aaaaaaa aaaaa…
×1  aaaaa aaaaa
```

**Hipótesis descartada, con la traza completa que la refuta:** el primer intento sospechó de
`RE_ANEXO_RESUMEN`/`RE_ANEXO_COMPUTABLE` (`santander.ts`) por case-sensitivity, contra las palabras
"Sircreb"/"Importe susceptible..." que las formas 1 y 2 parecían sugerir por longitud de palabra. **Es
incorrecto**: los dos regex se llaman una sola vez cada uno, siempre contra `normalizar(literal)`
(`parseo-ar.ts:312`, que ya hace `.toUpperCase()`) — agregarles la flag `i` no cambia nada, porque el
texto ya llega en mayúsculas. Además, `relacionDelRenglon` (donde viven esos regex) no decide si una
fila cae en residuo: solo clasifica una fila que **ya se emitió** como anexo. La lección para la
próxima vez: coincidencia de longitud de palabra en una `forma()` no es una traza de código — hay que
seguir la cadena de llamadas hasta el punto real donde se decide el destino.

**Los tres candidatos reales**, siguiendo la cadena completa del bucle de armado
(`santander.ts`, función que arma `anexos` a partir de `clasificarBloque`, ~línea 1150-1190), en el
orden en que se evalúan:

1. `RE_CORRIDA_DE_IDENTIFICADOR.test(conceptoLiteral)` (línea ~1162) — una corrida de 7+ dígitos
   seguidos → residuo `desconocido`. Las formas no muestran ninguna corrida de 7+ (el `#####` de la
   forma 1 son 5), así que es el candidato menos probable, pero no descartado sin ver el literal
   completo (podría haber más dígitos fuera de la ventana capturada por `formaParaLog`, que trunca a
   120 caracteres).
2. `periodoDelRenglon(conceptoLiteral)` devuelve `null` (línea ~1166-1170) — rango de fechas invertido
   (`hasta < desde`) o no parseable → residuo `fecha_ilegible`. Las formas 1 y 2 tienen las dos un
   `del ##-##-#### al ##-##-####`: **es el candidato más plausible** para esas dos, pero hay que
   confirmar si las fechas parsean y en qué orden vienen.
3. Sin importe emparejado (línea ~1188-1191) → residuo `fila_sin_importe`. Aplica a cualquiera de las
   5, en particular a las formas 3 y 5 (más cortas, sin patrón de fecha visible) — un rótulo cuyo
   importe suelto esperado no aparece donde el apareo lo busca.

**Qué hace falta para cerrar esto — le toca al usuario, no a un agente** (dato real, `--caratula` lee
la carátula/cuerpo fragmento por fragmento con su `x`, sigue sin imprimir un valor pero hay que
correrlo contra el archivo real): `pnpm probar --banco santander --archivo <ruta> --caratula <n>` con
`n` lo bastante grande para cubrir los índices de las 5 líneas de residuo (que el mismo `pnpm probar`
imprime en `no interpretadas=`), comparar la forma completa (sin el truncado a 120) contra los tres
candidatos de arriba, y decidir código por código cuál aplica.

**Contingencia aplicada mientras tanto** (`verificarDestinos`, `packages/ingesta/src/verificacion/
invariantes.ts`): `residuo > 0` bajó de severidad `error` a `observación` — **el residuo se sigue
viendo en el log, pero no rechaza el lote**. `sinDestino > 0` y `destinos===undefined &&
declaraDestinos` NO están cubiertos por esta contingencia, siguen en `error` (son violaciones más
estructurales, no el mismo tipo de hallazgo). Restaurar a `error` es cambiar una línea
(`severidadResiduo`, comentario 🔴 en el propio código) cuando el residuo de Santander se explique o
baje a 0.

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

### 2.10 🟡 `unpdf` tira `Warning: TypeError: Math.sumPrecise is not a function` — benigno, confirmado

**Verificado contra archivo real** (A2, confirmación con el usuario, 2026-08-11): al correr `pnpm probar`
contra los PDF reales de Galicia (4 veces) y Santander (8 veces) aparece este warning al arrancar la
lectura. **No aparece con Macro.**

**De dónde sale, rastreado hasta el código fuente.** No es de este repo: `grep -r "sumPrecise"
packages/` da cero resultados, y `creditos`/`debitos` en `verificacion/invariantes.ts` son `BigInt`
acumulados a mano (`0n`), sin ningún `Math.sumPrecise` en el camino. Sale de la copia minificada de
`pdf.js` que empaqueta `unpdf` (`packages/ingesta/src/texto-pdf.ts`, `node_modules/.pnpm/unpdf@1.8.0/
.../dist/pdfjs.mjs`) — **17 usos, los 17 en código de escritura/subseteo de fuentes, formularios XFA
y guardado de PDF** (`GlyfTable.getSize()`, `Glyph.getSize()`, apariencias de campos de formulario,
MD5 para guardar). Ninguno está en el camino de decodificación de texto que `aFilas`/`extraerTexto`
consumen.

**Por qué falla.** `Math.sumPrecise` es una API de V8 muy nueva (propuesta TC39 en etapa 3). No existe
como global ni en Node v24.14.0 (confirmado) — la versión de `pdf.js` que trae `unpdf@1.8.0` la llama
sin comprobar si existe. Es un bug de esa dependencia, no de este repo.

**Por qué no rompe nada.** `pdf.js` tiene su propio `warn()` (`console.warn('Warning: '+e)`, confirmado
leyendo el bundle) — el error se atrapa y se loguea, no se propaga: si fuera una excepción sin atrapar,
el script se habría caído antes de imprimir el LOTE, y en cambio corrió completo hasta el veredicto.
Verificado además de forma empírica, no solo por lectura de código: en la corrida real de Galicia,
`verificoTotales=true` sin `ARIT_TOTAL_CREDITOS`/`ARIT_TOTAL_DEBITOS` — la suma de créditos/débitos
calculada por este repo (ajena por completo a `Math.sumPrecise`) coincidió exacta con el total que
declara la carátula del banco, más `hashes únicos = total` y cadena de saldos sin rupturas. Si el texto
extraído hubiera salido corrompido, ese cruce habría fallado con error, no en silencio.

**Por qué en Galicia/Santander y no en Macro.** Se investigó una hipótesis (¿correlaciona con
`traeTotalesDeclarados`/el camino V2 de verificación de totales?) y **se descartó con datos reales**:
Santander tiene `traeTotalesDeclarados: false` (no publica totales, usa V5) y el warning apareció igual,
8 veces. Los 17 usos están en fuentes/formularios del PDF, así que la correlación real es con la
estructura interna de cada archivo (fuentes embebidas, campos de formulario), no con qué verificación
corre de este lado.

**Qué hacer:** actualizar `unpdf` cuando exista una versión que no dependa de `Math.sumPrecise` sin
guardia, o reportarlo upstream. No bloqueante — no toca el veredicto de ningún lote.

---

### 2.11 🟡 `alta-cuenta.ts` duplica 3 regex de `santander.ts`; el guardrail cruzado solo cubre 1 de las 3

**Contexto:** el fix de `leerCaratula` multi-cuenta (HANDOFF 2026-08-11 (34) y su enmienda) duplicó a
propósito `RE_CABECERA_CUENTA`, `RE_NUMERO_CUENTA_EN_CABECERA` y `RE_ES_DOLARES` de
`packages/ingesta/src/adaptadores/santander.ts` en `apps/cli/src/alta-cuenta.ts` — no se importan
porque `packages/ingesta/src/index.ts` prohíbe exponer el vocabulario interno de un adaptador (§2.4).

**El hallazgo (`code-reviewer`, en la revisión de ese mismo fix):** el test guardrail
(`apps/cli/tests/alta-cuenta.test.ts`, describe `guardrail cruzado con santander.ts`) corre la misma
cadena literal contra `leerCaratula` y contra `reconoceSantander`, la única función pública que ejercita
`RE_CABECERA_CUENTA`. Pero `reconoceSantander` **no** evalúa `RE_NUMERO_CUENTA_EN_CABECERA` ni
`RE_ES_DOLARES` — esas dos regex duplicadas no tienen ningún cross-check automatizado. Hoy están
verificadas carácter por carácter contra el original (confirmado con `JSON.stringify`/`codePointAt`
sobre las dos copias, mismo `º` = U+00BA en las dos), pero una divergencia futura en `santander.ts:388`
o `:391` que no se replique acá pasaría el gate en verde.

**Por qué no se cerró en el mismo commit:** cerrarlo de verdad pide invocar `leerSantander` (que sí usa
las tres regex) con un `FilaGeometrica[]` completo — encabezado de columnas, región de tabla, cierre
con "Saldo total" — del mismo tamaño que las fixtures de `santander.test.ts` (~300 líneas). Es
desproporcionado para un fix puntual de `leerCaratula`, que ni siquiera arma `FilaGeometrica`.

**Qué hacer:** si se toca `alta-cuenta.ts` o `santander.ts` de nuevo, extender el guardrail para
ejercitar `leerSantander` con una fixture mínima (cabecera + "No tenés movimientos en ... este
período", sin movimientos reales) y comparar `cuentas[].numero`/`.moneda` contra lo que devuelve
`leerCaratula` para el mismo texto. No bloqueante — las tres copias están verificadas manualmente hoy.

---

### 2.12 🟡 Mismo hueco que §2.11, ahora para las dos regex de Macro (`RE_SECCION_MACRO`/`RE_CBU_MACRO`)

**Contexto:** el fix de `leerCaratula` para Macro (HANDOFF 2026-08-11 (38)) duplicó
`RE_SECCION_MACRO`/`RE_CBU_MACRO` de `packages/ingesta/src/adaptadores/macro.ts` en
`apps/cli/src/alta-cuenta.ts`, mismo motivo que §2.11 (`index.ts` prohíbe exponer vocabulario interno
de un adaptador). A diferencia de Santander, el *particionado* en secciones (`seccionesPorClave`) SÍ se
reusa importada — es infraestructura compartida de `toolkit.ts`, no vocabulario privado (`tech-lead`,
HANDOFF (38)) — así que la superficie duplicada acá es más chica: solo las dos regex y dos funciones
puramente derivadas (`tipoDeCuentaDelTituloMacro`/`monedaDelTituloMacro`).

**El hallazgo (`tech-lead`, en el diseño del mismo fix):** `reconoceMacro` (la función pública que el
adaptador real usa para reconocer el formato) no ejercita ni `RE_SECCION_MACRO` ni `RE_CBU_MACRO` — su
`MARCAS` usa `RE_ENCABEZADO_TABLA` y dos etiquetas de carátula distintas. No hay hoy ninguna función
pública de `macro.ts` que sirva de guardrail cruzado automatizado para estas dos regex, a diferencia de
`RE_CABECERA_CUENTA` de Santander (que sí tiene `reconoceSantander` como guardrail).

**Verificación hecha en su lugar:** corrida empírica de solo-conteo contra el archivo real del piloto
(nunca contenido, solo conteos y categorías) confirmando que las dos regex matchean sobre `aLineas()`
tal como se esperaba: 47 matches de `RE_SECCION_MACRO` (3 números de cuenta distintos, tipos
`corriente`/`especial`, monedas `ARS`/`USD`), 47 matches de `RE_CBU_MACRO`, con **las 47 dando
exactamente 22 dígitos** después de limpiar guiones. Confirma el diseño contra el archivo real, pero no
es un guardrail automatizado que el gate vuelva a correr — es una medición puntual de esta sesión.

**Qué hacer:** mismo camino que §2.11 — si se agrega superficie pública angosta a `macro.ts` (por
ejemplo, exportar `claveDeSeccion` como `claveDeSeccionMacro`, que ya es exactamente la función que
`seccionesPorClave` recibe en producción), un test podría correr la misma cadena literal contra las dos
copias. Decisión de superficie pública del paquete, no de este fix puntual. No bloqueante.

### 2.13 🔴 `fragmentoEnVentanaDerecha` es inclusiva en los DOS extremos — riesgo NO VERIFICADO en Galicia/Santander/Macro/Bancor

**Contexto:** construyendo el 5° adapter (Nación, `HANDOFF.md` 2026-08-26 (121)), `tester` encontró que
`fragmentoEnVentanaDerecha` (`texto-pdf.ts`) — a diferencia de `fragmentosEnBanda`, que documenta
`[desde, hasta)` semi-abierto **a propósito** (ver el comentario de esa función) — hace
`derecha >= desde && derecha <= hasta`, **inclusiva en los dos extremos**. Con dos ventanas contiguas
que comparten un valor límite exacto (`ventanaA.hasta === ventanaB.desde`), un fragmento cuyo borde
derecho cae justo ahí matchea las DOS ventanas a la vez — y por `.find()` sobre fragmentos ordenados
por `x` ascendente, la ventana equivocada puede ganar **en silencio**. En Nación esto llegó a
reemplazar el saldo real de una fila por el valor de un crédito vecino, sin ningún código en
`lineasNoInterpretadas` — el peor modo de falla del módulo, un número creíble y equivocado.

**Lo que se corrigió:** `nacion.ts` (2pt de zona muerta entre `comprobante`/`debito`/`credito`/
`saldo`, más un piso de borde izquierdo contra la banda de concepto — `code-reviewer` encontró un
segundo vector relacionado, distinto al de los límites compartidos).

**Lo que NO se hizo, y por qué queda acá y no como nota suelta:** `Galicia`/`Santander`/`Macro`/
`Bancor` **usan la misma función compartida** (`bancor.ts:523,528`; `galicia.ts:1136,1167`;
`santander.ts:1604-1607,1615`; `toolkit.ts:693,698-699` vía `parDeColumnas`, que a su vez usan
Santander y Macro) y **no se auditaron** en esta tarea — estaba fuera de alcance ("no retrofitear
los cuatro adapters existentes"). **No hay evidencia hoy de que alguno tenga ventanas contiguas con
este problema** (es una hipótesis de patrón, no un bug confirmado en esos cuatro) — pero los cuatro
ya procesan datos reales de clientes en el piloto (Bancor: Contenedores Paoluc S.A.S., HANDOFF
(120)), así que si la hipótesis fuera cierta en alguno, el riesgo no es teórico.

**Qué hacer:** `tech-lead` audita `COLUMNAS`/`VENTANAS` de los cuatro adapters buscando pares de
ventanas contiguas (`X.hasta === Y.desde`) pasadas a `fragmentoEnVentanaDerecha`. Si aparece alguna,
aplicar el mismo tipo de corrección (margen entre ventanas, o el piso de borde izquierdo si el vector
es el de `code-reviewer`) — con su propio test de regresión, mismo criterio que Nación. Alternativa de
fondo, más cara: endurecer `fragmentoEnVentanaDerecha` a `[desde, hasta)` como ya hace
`fragmentosEnBanda`, y correr la suite completa de los cinco adapters para confirmar que ningún test
existente dependía de la inclusión del límite superior. **Prioridad baja** (sin evidencia de bug real
todavía) pero **no se resuelve solo**: queda para la próxima vez que se toque cualquiera de los cuatro
adapters, o antes si aparece un `no_cuadra`/`no_verificable` inexplicado en producción sobre alguno de
ellos.

### 2.14 🔴 La rama Bancor de `leerCaratula` (`alta-cuenta.ts`) tiene la misma falta de chequeo de ambigüedad que `tester` encontró y corrigió en la rama Nación

**Contexto:** dando de alta el 5° cliente real de la serie (HYJ SAS, Banco Nación,
`docs/seguridad/registro-excepciones.md` E-6), `tester` atacó la rama Nación nueva de `leerCaratula`
(`apps/cli/src/alta-cuenta.ts`) y encontró que `.find()` tomaba el PRIMER match de
`RE_NUMERO_CUENTA_NACION`/`RE_CBU_NACION` dentro de la ventana de carátula **sin verificar si había un
segundo** — un decoy de 10 dígitos (código de sucursal, teléfono, comprobante) antes del dato real
ganaba en silencio. Es exactamente el riesgo que la cabecera del propio archivo prohíbe ("dar de alta
una cuenta con el identificador de un tercero") y que las ramas Macro/Santander sí resuelven contando
candidatas y fallando ruidoso ante más de una.

**Corregido en Nación**, con su test de regresión (`apps/cli/tests/alta-cuenta.test.ts`, sección
Nación: dos tests de decoy, uno para número y uno para CBU, más uno que confirma que el MISMO valor
repetido no es ambigüedad).

**NO corregido en Bancor — mismo patrón exacto, mismo archivo, código ya usado contra un cliente real
(Contenedores Paoluc S.A.S., `HANDOFF.md` (120)).** `tester` lo señaló explícitamente al encontrar el
bug en Nación: la rama Bancor (líneas 494-520 al momento de este hallazgo) usa el mismo `.find()`
sin conteo de candidatas para `RE_NUMERO_CUENTA_BANCOR`/`RE_CBU_BANCOR`. No se corrigió en esta tarea
porque:
- Es código ya usado contra datos reales de OTRO cliente — tocarlo pide su propia revisión completa
  (`tech-lead` + `security-engineer`), no un fix de pasada dentro de una tarea de Nación.
- El único documento real de Bancor disponible (`docs/diseno/20-formato-bancor.md`) ya se auditó
  contra este vector cuando se escribió — no hay evidencia de que el bug se haya disparado ahí, pero
  tampoco se verificó con un test adversarial dedicado en su momento.

**Qué hacer:** `tech-lead` decide si conviene subir el chequeo de ambigüedad (contar + deduplicar +
fallar si `> 1`) a una función compartida del toolkit de `alta-cuenta.ts` que las dos ramas
geométricas (Bancor y Nación) usen igual — evita que la próxima rama geométrica (un 3er banco sin
etiqueta) repita el mismo hueco por tercera vez. Aplicar después a Bancor, con su propio test de
regresión y con la misma disciplina de "medido contra el archivo real, no solo el fixture sintético".
**Prioridad media** (a diferencia de §2.13, acá SÍ hay un caso real ya cargado en el piloto con esta
clase de código sin el guardrail) — no bloquea ningún alta en curso, pero no queda para "cuando se
toque Bancor de todos modos": es el tipo de hallazgo que hay que agendar.

### 2.15 🟡 `reconoceNacion`/`reconoceBancor` sin cruce de ambigüedad en `alta-cuenta.ts` (a diferencia del pipeline de ingesta real)

**Contexto:** mismo ataque de `tester` de §2.14. El pipeline real de ingesta (`ingestar.ts`) resuelve
el banco con `resolverAdaptador`, que corre **todos** los adaptadores registrados contra el documento
y devuelve `ambiguo` si más de uno reconoce el mismo archivo (el caso real ya documentado: un PDF de
Credicoop byte-idéntico a uno de ICBC). `alta-cuenta.ts` **no pasa por ese mecanismo** — llama
`reconoceBancor`/`reconoceNacion` de forma aislada, cada uno contra sus propias marcas, sin verificar
si el documento también matchea el letterhead de otro banco. `tester` construyó un documento
simulado cuyo pie de página, envuelto por casualidad de layout en dos filas geométricas consecutivas,
coincide exacto con las dos marcas de Nación — la rama se activa igual y lee número/CBU del cuerpo de
un documento ajeno.

**No es un vector garantizado en la práctica** (depende de una coincidencia de layout específica), y
`reconoceNacion` ya es más estricto que `reconoceBancor` en este mismo archivo (exige adyacencia de
fila, no solo presencia en 15 filas) — pero la asimetría estructural con `ingestar.ts` es real: un
script que da de alta cuentas reales no tiene la misma red que el pipeline de lectura cotidiana.

**Qué hacer:** evaluar (`arquitecto-software`/`tech-lead`) si `alta-cuenta.ts` debería correr
`resolverAdaptador` (o una versión liviana del mismo cruce) contra los bancos ya registrados antes de
tomar la primera rama geométrica que matchee, en vez de evaluarlas en cascada `if/else if`.
**Prioridad baja** — no hay caso real medido, es un vector de layout específico, y el operador
siempre declara `--banco` de antemano (que es exactamente lo que este script no cruza contra lo
detectado, a diferencia de `resolverAdaptador`).

### 2.16 🟡 La ventana de carátula geométrica (`FILAS_DE_CARATULA_BANCOR`/`NACION`) es global al documento, no por página

**Contexto:** mismo ataque de `tester`. `filasGeometricas.slice(0, N)` corta sobre el array completo
de filas del PDF sin filtrar por `fila.pagina` — con una página 1 corta (menos de `N` filas), el
corte se completa leyendo filas de la página 2, que pueden no ser carátula de nadie. **No se dispara
hoy**: el único documento real de Nación tiene 43 filas en una sola página, y el de Bancor mide 3
páginas pero su carátula real cabe dentro de las primeras 20 filas de la página 1 (ver
`20-formato-bancor.md`). **Prioridad baja, deuda declarada sin caso real** — se revisa si aparece un
documento real con una carátula de página 1 más corta que la ventana.

### 2.17 🟡 `extraerPeriodo` (`toolkit.ts`, compartida con Galicia/Macro) es case-sensitive — no lee el conector "AL" en mayúsculas

**Contexto:** primera corrida real de `alta-cuenta.ts` contra el PDF real de HYJ SAS (Banco Nación,
`docs/seguridad/registro-excepciones.md` E-6). La rama Nación de `leerCaratula` leyó número y CBU
correctamente (por geometría), pero el paso compartido posterior — `extraerPeriodo(lineas.join(...))`
— falló con "No pude leer el período del resumen" contra un documento real y válido.

**Causa, confirmada por medición (no supuesta):** el regex de `extraerPeriodo`
(`(?:a(?:l)?|hasta|-|—)`, sin flag `i`) exige el conector en MINÚSCULAS. El documento real de Nación
imprime el conector en MAYÚSCULAS ("AL") — confirmado con `formaParaLog` contra el archivo real (el
token se enmascaró como dos letras mayúsculas). Galicia y Macro, los otros dos usuarios de esta
función, aparentemente siempre lo imprimen en minúsculas — nunca se había medido el caso mayúsculas
hasta ahora.

**Resuelto puntualmente, sin tocar la función compartida:** `alta-cuenta.ts` agregó
`RE_PERIODO_NACION`/`extraerPeriodoNacion`, duplicados a propósito (mismo criterio que
`RE_NUMERO_CUENTA_NACION`/`RE_CBU_NACION`), usados solo cuando `esNacion`. Decisión explícita de JP:
**no tocar `extraerPeriodo` compartida bajo la presión de un alta real** — agregarle el flag `i`
ensancharía la superficie de match para Galicia/Macro sin que nadie lo haya revisado contra sus
documentos reales.

**Qué hacer:** cuando haya convocatoria real de `tech-lead` (+ quien tenga a mano los documentos
reales de Galicia/Macro para reverificar que agregar `i` no introduce un falso positivo), evaluar si
`extraerPeriodo` debería aceptar el conector en cualquier capitalización de una vez por todas —
sacaría la duplicación de `alta-cuenta.ts` y cerraría el mismo hueco para cualquier banco futuro.
**Prioridad baja**: el caso real de Nación ya está resuelto por su cuenta propia, sin bloquear nada.

🔴 **ANOTACIÓN 2026-08-26 (`tech-lead`, revisión del 6° adapter — ICBC) — SEGUNDO caso real del
mismo defecto, sube la prioridad de "cuándo" pero no la de "ahora".** `docs/diseno/22-formato-
icbc.md` §1.1 mide el mismo problema exacto contra el PDF real de MEB Integración y Montaje S.A.S.:
el período se imprime `PERIODO dd-mm-aaaa AL dd-mm-aaaa`, con `AL` en MAYÚSCULA — `icbc.ts` resuelve
con su propio `RE_PERIODO` local (con `/i`), mismo patrón de duplicación deliberada que ya usa
`nacion.ts`, nunca tocando `extraerPeriodo` compartida. **Con dos bancos reales (Nación e ICBC)
midiendo el conector en mayúscula y CERO midiéndolo en minúscula desde que existe el caso**, el
argumento de "agregar `i` amplía sin revisar" empieza a pesar menos que "dos de dos documentos
nuevos ya lo necesitan". Sigue siendo **no bloqueante** (los dos casos reales están resueltos por su
cuenta propia) — pero el día que aparezca un 7° banco con el mismo síntoma, corresponde resolverlo de
fondo en `extraerPeriodo` en vez de agregar una cuarta copia local.

---

### 2.18 🟡 Cuatro hallazgos no bloqueantes del panel del 6° adapter (ICBC), declarados con dueño

Del panel completo convocado para `icbc.ts` (`seguridad-datos-financieros` + `tech-lead` +
`code-reviewer` + `tester` + `qa-automation`, 2026-08-26). Los bugs reales que encontraron
(crédito con signo atrás sin normalizar, pérdida silenciosa del comprobante con texto pegado, y la
falta de registro en `apps/cli/src/ingestar.ts`) se corrigieron en la misma tarea — esta entrada es
solo lo que quedó **declarado, no bloqueante**:

1. **`fragmentoDeColumna` duplicado entre `nacion.ts` y `icbc.ts`** (mismo guard: excluir fragmentos
   con borde izquierdo dentro de la banda de concepto). `tech-lead`: con DOS usuarios reales ya se
   cumple el umbral propio de este repo para subir a compartido — candidato a `texto-pdf.ts`
   (parametrizado por `bandaHasta`, no `toolkit.ts`: geometría/extracción vive en `texto-pdf.ts` por
   convención ya escrita en la cabecera de `toolkit.ts`). Dueño sugerido: `backend-dev` +
   `tech-lead`, próxima vez que se toque cualquiera de los dos adapters.
2. **El bloque de totales de `icbc.ts` puede caer en `fueraDelCuerpo` en vez de `residuo`** cuando el
   primer fragmento no matchea `RE_ETIQUETA_TOTAL_1` — a diferencia de Bancor/Nación, donde cualquier
   fila con `$` no reconocida siempre va a `residuo`. No se disparó contra el único documento real
   medido (los tests lo confirman), pero es una asimetría de fail-closed frente al resto del roster.
   Dueño sugerido: quien reabra `icbc.ts` para un segundo documento real.
3. **`nacion.ts` no tiene el mismo guard de valor absoluto que `icbc.ts` aplica ahora a DEBITOS y
   CREDITOS.** Hoy inofensivo (0 tokens firmados medidos en el único documento real de Nación), pero
   es un hueco de coherencia entre los adaptadores de la familia `columna_separada`
   (Santander/Macro/Nación/ICBC). Dueño sugerido: la próxima vez que se toque `nacion.ts`.
4. **`RE_NUMERO_CUENTA_ICBC`/`RE_CBU_ICBC` matchean sobre `textoDeFila(fila)` (la fila entera ya
   unida), no por fragmento con ancla `^...$` completa como `nacion.ts`/`bancor.ts`.**
   `seguridad-datos-financieros`: severidad BAJA, sin evidencia de explotación (ventana acotada a la
   carátula, un único fragmento real portador del dato, confirmado por barrido del documento
   completo). Sugerido armonizar con el patrón del roster antes de un segundo documento real de
   ICBC, no bloqueante para esta tarea.

### 2.19 🟡 Ningún adapter geométrico reordena min/max su propio período — solo Bancor lo declaró a propósito

Hallazgo de `tech-lead`, revisión de la 6ª rama de `alta-cuenta.ts` (ICBC), 2026-08-26. La CLI
(`extraerPeriodoNacion`/`extraerPeriodoIcbc` en `alta-cuenta.ts`) heredó la lección de
`toolkit.ts:483-492` (`extraerPeriodo` compartida): el orden en que `pdf.js` emite las dos fechas del
período es un detalle del extractor, no una propiedad del documento — por eso se toma **min/max**,
nunca "la primera es desde".

**Ninguno de los tres `leerPeriodo` de los adapters reales (`icbc.ts:447-456`, `nacion.ts:453-461`,
`bancor.ts:574-585`) tiene esa misma defensa** — asignan el primer grupo capturado a `desde` y el
segundo a `hasta`, directo. Para **Bancor es deliberado y documentado**
(`bancor.ts:565-572`, hallazgo de `tester`: un período invertido tiene que rechazar el archivo
entero en silencio — fail-closed, no "plausible y mal"). **Para Nación e ICBC no hay ningún
comentario que confirme que un período invertido efectivamente falla cerrado aguas abajo** — es un
supuesto no verificado, la misma clase de supuesto que ya costó una corrida fallida contra el piloto
en Nación (conector en mayúscula, HANDOFF 121/122).

**No bloquea nada hoy** (`alta-cuenta.ts`, el único camino que da de alta cuentas reales en el
piloto, sí reordena) — es deuda del pipeline de ingesta mensual. Dueño sugerido: quien mida un
segundo documento real de cualquiera de los dos bancos, o quien construya el caso de test que
confirme qué pasa hoy con un período invertido en cada adapter.

### 2.20 🟡 El chequeo de ambigüedad (dedupe + contar + fallar si `>1`) está duplicado DOS veces en `alta-cuenta.ts`, sin extraerse

Hallazgo de `tech-lead`, misma revisión. `10-deuda-declarada.md` §2.14/§2.15 ya pedían este cruce
—"con uno es una apuesta, con dos no"— y ahora hay **dos usuarios reales funcionando sin
incidentes**: la rama Nación (`alta-cuenta.ts:635-677`) y la rama ICBC (`:700-749`), con la misma
forma exacta (deduplicar por clave, contar candidatos, fallar ruidoso si sobrevive más de uno) salvo
que Nación dedupea por valor único y ICBC por par de grupos.

**Ya cruzó el umbral que este mismo rol usa para decidir extracción** — no es una sugerencia para
"cuando aparezca la próxima rama": la próxima rama ya apareció (ICBC) y repitió la duplicación en vez
de extraer. Recomendado: un helper parametrizado (`unicoCandidatoOFallar` o similar, por
dedupe-key/mensaje) usado por las dos ramas, y aplicado a Bancor en la misma tarea para cerrar §2.14
con el tercer usuario real (Bancor sigue sin el chequeo de ambigüedad en absoluto). No bloquea el
alta de ningún cliente — es reuso de estructura, no un bug. Dueño sugerido: `backend-dev` +
`tech-lead`, próxima tarea que toque `alta-cuenta.ts`.

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

## 5. Export a Excel para Laura (`pnpm exportar:excel`) — deuda declarada en el propio diseño

> A diferencia de las secciones 1 y 2 (auditoría retrospectiva del Módulo 1 ya construido), esto es
> deuda que la propia tarea declaró **al diseñarse**, no algo que un agente auditor encontró después:
> plan `adaptive-herding-pillow`, cerrado en `HANDOFF.md` 2026-08-12 (46). Va acá porque el criterio es
> el mismo — que nadie la redescubra desde cero.

### 5.1 🟡 `acceso_auditoria` no tiene columna `destinatario`

ADR-0002 §A.1 exige que todo export N2-R quede auditado "con motivo **y** destinatario" — dos datos, no
uno. La tabla `acceso_auditoria` solo tiene `motivo` (`text`, N2, append-only). `exportar-planilla.ts`
codifica los dos adentro de esa única columna: `"<motivo_codigo>|dest:<destinatario_codigo>"`, los dos
de vocabulario cerrado (`z.enum` en el CLI, nunca texto libre del operador).

**Por qué no se corrigió acá:** agregar la columna es una migración, y esta tarea no tocaba el esquema
de auditoría (CLAUDE.md §3.2(a) la dispararía de nuevo si se sumara sin plan propio). Además
`acceso_auditoria` ya tiene filas históricas con `accion='export'` (`descarga.ts`) sin este campo: una
migración real tiene que decidir si retrocompleta esas filas o las deja `NULL`.

**Qué hace falta para cerrarlo:** migración + `dba-data` + `seguridad-datos-financieros` (toca el modelo
de auditoría, dispara la matriz de §3.1) para decidir si la columna nueva reemplaza el parseo compuesto
de `motivo` en **todos** los lugares que ya lo generan, no solo en el export nuevo.

### 5.2 ✅ CERRADO (2026-08-12, misma sesión) — el TTL de 7 días ahora se calcula y se loguea

`apps/cli/src/exportar-excel.ts` agrega `TTL_DIAS_RECOMENDADO = 7` y `destruccionRecomendada(generadoEn)`
(`new Date(generadoEn)` con argumento, nunca `new Date()` a secas). El resultado `'exportado'` lleva
`destruirAntesDe` y el evento `exportar.completado` loguea `destruir_antes_de`. Test agregado al camino
feliz de `apps/cli/tests/exportar-excel.test.ts`. **No se tocó la leyenda "Procedencia" del workbook**
(queda con `cliente`/`lote`/`correlacion`/`motivo`/`destinatario`, sin la fecha de destrucción) — eso
sigue pendiente si se quiere que el recordatorio viaje con el archivo y no solo con el log; alcance menor,
declarado, no bloqueante. **El borrado del archivo sigue siendo un acto humano** (ADR-0002 §F.3.8) — lo
único que se automatizó es el cálculo y el recordatorio, nunca la destrucción en sí.

<details>
<summary>Diagnóstico original (antes del cierre), para trazabilidad</summary>

El diseño aprobado por el usuario ("adelante con el export, con controles completos, MÁS TTL y borrado
explícitos declarados") preveía que `pnpm exportar:excel` imprimiera/logueara una fecha de destrucción
recomendada (`generado_en + 7 días`) en el evento `exportar.completado`, como recordatorio automático —
así quedó descrito en el plan y en el pedido de cierre de esta misma tarea.

**Verificado contra el código el 2026-08-12 (cierre de la tarea, documentador): no está implementado.**
Ni `apps/cli/src/exportar-excel.ts` (el evento `exportar.completado` solo loguea `cliente_id`,
`lote_id`, `banco_codigo`, `correlacion`, `filas`, `cuentas`, `archivo_nombre`, `archivo_bytes` —
buscado en el archivo, no hay campo de fecha derivada), ni
`packages/ingesta/src/planilla/exportar-planilla.ts`, ni `armar-libro.ts` (que sí escribe `generado_en`
en la celda `A1` y en la leyenda "Procedencia" de `Control de saldos`, pero nunca una fecha calculada a
partir de él) tienen ningún cálculo de TTL. Búsqueda de `ttl`/`destruc`/`7 d[ií]as` en los tres archivos
y sus tests: cero resultados salvo el comentario que **menciona** que el export "no tiene TTL" como
contraste con una descarga.

**Consecuencia práctica:** el control sigue vigente como decisión (es un acto humano registrado, tal
como decidió el titular — ver el procedimiento nuevo en `docs/seguridad/registro-excepciones.md`), pero
hoy depende **enteramente** de que quien corre el export calcule `generado_en + 7 días` a mano y lo
registre — nada en el sistema se lo recuerda ni lo verifica, y el propio archivo `.xlsx` tampoco lleva
la fecha de destrucción en su leyenda (solo `cliente`/`lote`/`correlacion`/`motivo`/`destinatario`).

**Por qué no se corrigió acá:** el documentador no escribe código de producción
(`agents/personas/documentador.md`, "Qué NO hace"). Cerrarlo es código real (un campo derivado en el
`logger.info` y en la leyenda del workbook) más su test.

**Qué hace falta para cerrarlo:** sumar al evento `exportar.completado` un campo
`destruye_recomendado_en` (ISO), calculado como `generadoEn + 7 días`, y agregarlo a la leyenda
"Procedencia" de `armar-libro.ts` (para que el recordatorio viaje con el archivo, no solo con el log).
Cambio chico, sin tocar esquema ni RLS — candidato a que lo tome `backend-dev` sin plan de §3.2 propio,
salvo que se decida sumarlo junto con 5.1.

</details>

---

## 6. Orden sugerido para retomar

1. **Antes del cuarto banco, sí o sí:** 2.4 (entradas del contrato + regla de código), 2.1 paso 1
   (vocabulario de destinos al toolkit), 2.9 (plantilla). Son las tres que evitan que el problema se
   multiplique por cinco.
2. **Cuando haya una tarea propia:** 1.1 (el lote-ancla), 2.2 (V3 tautológica en Galicia), 2.3 (el
   período faltante que descarta 326 movimientos).
3. **Cuando el volumen lo pida:** 1.2, 1.3, 1.4.
4. **Con `pnpm probar` en la mano y nunca de otra forma:** 2.5, 2.6, 2.8.
5. **5.2 (TTL calculado y logueado) ya está cerrado** (2026-08-12, misma sesión que lo abrió). Queda 5.1
   (columna `destinatario`), que espera a una migración propia del modelo de auditoría — no bloqueante
   para la próxima corrida real de `exportar:excel`.
