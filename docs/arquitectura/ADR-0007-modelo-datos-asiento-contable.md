# ADR-0007 — Modelo de datos del asiento contable: número correlativo y trazabilidad movimiento↔renglón

## Contexto

Bloqueante para bocetar Pantalla 6 del wizard de demo ("Generar asiento contable"): antes de diseñar
número correlativo, granularidad y trazabilidad del asiento contable, el titular pidió verificar contra
el esquema y el código real qué de esto ya existe — para no inventar trabajo sobre algo ya resuelto
(PASO 0, más abajo). Modo plan obligatorio por tocar esquema (CLAUDE.md §3.2(a)).

**Esta tarea produce solo este documento y la entrada de HANDOFF correspondiente. Ninguna migración se
escribe ni se aplica acá — el ADR queda como diseño aprobado, pendiente de una tarea de implementación
separada.**

---

## PASO 0 — verificación contra el esquema y el código real, antes de diseñar nada

Tres agentes de exploración, en paralelo, cada uno trazando código real con cita de archivo:línea (no
supuestos). Resultado:

### 1. Encabezado/líneas del asiento: ya existe, no se toca

`asiento_propuesto` (encabezado) + `asiento_propuesto_renglon` (líneas) existen desde
`packages/data/migrations/0027_cierre_mensual.sql`, con totales servidos por una vista calculada
(`asiento_propuesto_totales`, siempre recalculada desde los renglones, nunca cacheada). Forma vigente
redefinida por `0028` (inmutabilidad post-terminal), `0040` (`corrige_asiento_id`), `0045`
(`confirmado_por`/`confirmado_en`).

**Número correlativo: confirmado ausente.** Grep exhaustivo de `numero|correlativo|secuencial|
nro_asiento|CREATE SEQUENCE|nextval|serial` contra las 47 migraciones da cero resultados sobre estas dos
tablas. El PK es `id uuid default gen_random_uuid()` — sin ningún correlativo humano/secuencial. Hueco
real.

**No hay columna de glosa/descripción libre** en ninguna de las dos tablas. Lo más cercano,
`referencia_origen` (renglón), es un puntero, no una glosa.

Hallazgo colateral, no bloqueante: el repo no usa Drizzle pese a lo que sugiere CLAUDE.md §2 — el acceso
es SQL crudo vía `tx.consultar(...)`. El tipo TS de mano (`packages/data/src/cierre/tipos.ts:287-296`)
está desincronizado del SQL vigente (le faltan `corrigeAsientoId`, `confirmadoPor`, `confirmadoEn`; el
tipo de renglón le falta `padronContraparteId`). Se documenta acá, no se corrige en este ADR.

### 2. Trazabilidad movimiento↔renglón: no existe integridad referencial real

`asiento_propuesto_renglon.referencia_origen` es `text` libre, **sin FK, sin CHECK de forma UUID,
nullable**. Por convención de aplicación contiene el UUID de `movimiento_bancario_crudo.id`, comparado
por cast (`::text`/`::uuid`) en tres puntos del código: `packages/data/src/cierre/lecturas.ts:118-127`
y `:124-125`, y `packages/ingesta/src/cierre/agrupar-decisiones-pendientes.ts:387-388` — nunca
integridad referencial garantizada por la base.

- **Split 1 movimiento → 2 renglones: siempre fijo** (partida doble automática banco+contrapartida, tipo
  `readonly [RenglonPropuesto, RenglonPropuesto]` en `packages/motor-conciliacion/src/resolver.ts:
  212-217`) — no es un split arbitrario/configurable.
- **Consolidación N movimientos → 1 línea: no existe** en ningún punto del código de producción —
  confirmado por ausencia total en `resolver.ts`, `escrituras.ts`, `conciliar-lote.ts` (procesa un
  movimiento a la vez, sin `groupBy` antes de escribir).
- **No existe ninguna tabla puente** movimiento↔línea con importe parcial — confirmado por enumeración
  completa de las 37 tablas del esquema.
- **Hallazgo de bug**: el camino de reproceso/corrección (`reprocesarAsientoNoRevisado`,
  `corregirAsientoEntregado`, `packages/data/src/cierre/escrituras.ts:691-861`) inserta renglones **sin
  `referencia_origen` en absoluto** — el selector previo (`leerCandidatosDeReproceso`,
  `packages/data/src/cierre/lecturas.ts:553-570`) nunca trae `movimiento_id` a memoria porque selecciona
  por `cuenta_id`, no por movimiento. La traza se pierde por completo en ese camino, y ningún comentario
  del repo declara esto intencional (a diferencia de otros casos similares que sí lo declaran).

### 3. `confirmacion_grupo` vs. `GrupoDecisionPendiente`: dos entidades distintas, sin dato compartido

`confirmacion_grupo` (`packages/data/migrations/0043_confirmacion_grupo.sql`) es una regla de
clasificación reusable entre períodos `(cliente_id, banco_codigo, concepto_normalizado) → cuenta`, sin
noción de movimiento puntual ni de período — declarada explícitamente "en la capa de EXPORTACIÓN: nunca
escribe `reconocimiento_movimiento` ni `asiento_propuesto`" en el comentario de cabecera de esa
migración.

`GrupoDecisionPendiente` (`packages/ingesta/src/cierre/agrupar-decisiones-pendientes.ts`) es una vista
100% calculada en memoria por request (para el paso 5 del wizard), que agrupa movimientos por esa misma
clave `(bancoCodigo, conceptoBanco)` para presentación — y **descarta los IDs de movimiento individuales**
al construir el objeto de salida (`:77-89`, `:506-527`). No tiene `id` propio, nada se persiste.

**Conclusión**: son dos cosas genuinamente distintas que solo comparten la palabra "grupo" por la clave
de cruce que usan — no hay entidad de datos compartida ni id en común.

### Hallazgo central del PASO 0

El boceto ya aprobado de Pantalla 5/6 muestra "grupos" consolidando varios movimientos en una sola línea
de asiento. Capa D no tiene ningún mecanismo real de consolidación — cada movimiento reconocido produce
siempre sus propios 2 renglones. Esto reencuadra la pregunta de granularidad (§3 más abajo) como la
pregunta real a resolver antes de diseñar cualquier esquema nuevo.

---

## Convocatoria de diseño (5 agentes, sobre los hallazgos del PASO 0)

### §1. Granularidad — `contador-dominio`: una línea por movimiento, sin consolidar

`knowledge/` es un esqueleto (sin RT de FACPCE cargada) — sin cita normativa disponible, declarado
explícito por el agente convocado, sin arriesgar un número de norma de memoria. La decisión se apoya en
lo que el rol resuelve sin necesidad de norma: qué datos necesita un asiento para ser auditable.

- Cada movimiento tiene su propio comprobante de respaldo bancario — fusionar filas rompe esa
  trazabilidad 1:1 sin beneficio real más allá de menos líneas visibles.
- Precedente real ya cerrado en el piloto: ROKA, 267 movimientos → 267 asientos → 534 renglones, 0
  desbalanceados (`HANDOFF.md`, entrada 170).
- El problema de volumen visual ya tiene solución de presentación sin tocar la persistencia — mismo
  patrón que `agrupar-decisiones-pendientes.ts` usa para la cola de revisión de Pantalla 5.
- Construir la tabla puente de consolidación agregaría superficie nueva de bugs (RLS, FKs, índices,
  convocatoria de seguridad) para una decisión de negocio sin necesidad demostrada.

**Decisión: una línea de asiento por movimiento bancario. No se diseña ninguna tabla puente de
consolidación N:1 en este ADR.**

Pendiente sin resolver, declarado explícito: respaldo normativo específico de FACPCE/CCCN sobre
consolidación en libro diario — sin fuente cargada en `knowledge/` para afirmarlo ni descartarlo.

### §2. Arquitectura — `arquitecto-software`: formalizar la relación 1 movimiento → 2 renglones ya existente

`movimiento_bancario_crudo` ya tiene `unique (cliente_id, id)` (`uq_mov_crudo_tenant`,
`0004_ingesta.sql:465`) — la FK compuesta hacia esa tabla es construible sin migración previa de
unicidad.

- **FK nullable**, no `NOT NULL`: solo el tipo `devengamiento` (vía `escribirAsientoAutomatico`) nace
  siempre de un movimiento; `ajuste_cierre`/`reimputacion_fci` no necesariamente tienen un movimiento
  bancario de origen.
- **El bug del camino de reproceso se corrige en la implementación de este ADR, independiente de
  cualquier otra decisión** — es prerrequisito para que la FK tenga sentido en todos los caminos de
  escritura, no solo en el feliz.
- Costo de revertir: si algún día se demuestra necesidad de consolidación, migrar de FK simple a tabla
  puente es mecánico y barato (`INSERT ... SELECT` cubre el histórico como caso degenerado 1:1). Al
  revés — construir la puente ahora y que nunca haga falta — es superficie de revisión desperdiciada.
  Esa asimetría es la que decide: FK ahora, puente gateada a una decisión de negocio futura.

Alternativas descartadas: construir la puente "por las dudas" (cablea lo indeterminado); CHECK de forma
UUID sin FK real (verifica forma, no integridad referencial); trigger de aplicación tipo
`app.exigir_nodo_cliente` en vez de FK nativa (reinventa lo que la FK ya hace en el resto del esquema).

Hallazgo colateral, declarado como pendiente separado (§ Pendientes): `pendiente_cierre.referencia_origen`
tiene el mismo patrón sin resolver — no se toca en este ADR.

### §3. Mecanismo del correlativo — `dba-data`

- **Contador por `cliente_id`**, nunca por `cierre_cliente_periodo` ni global — justificado contra el
  propio Caso B de `0040`: un asiento `ajuste_cierre` se imputa al cierre abierto, no al que corrige, así
  que original y ajuste (mismo libro legal del cliente) pueden confirmarse en cierres distintos; un
  reset por cierre los haría competir por los mismos números bajos.
- **Nunca `SEQUENCE` de Postgres**: `nextval()` no es transaccional — sobrevive a un `ROLLBACK`, folio
  "fantasma" si la confirmación aborta. **Nunca `COUNT(*)`**: race real bajo `READ COMMITTED` entre dos
  confirmaciones concurrentes del mismo cliente, y frágil de escribir correctamente contra
  `superseded_by_id`/`corrige_asiento_id`.
- **Tabla contadora dedicada + `SELECT ... FOR UPDATE`** dentro de la misma transacción que confirma el
  asiento — mismo patrón que `0041_manifestacion_vigente_al_citar.sql` ya usa para un problema
  estructural idéntico (recurso mutable por-tenant con carrera de escritura concurrente).
- **Momento de asignación: en la transición `propuesto → confirmado`**, no al proponer — evita huecos
  por propuestas descartadas (Caso A de `0040`), y es justo lo que un folio de Libro Diario es: la
  posición del asiento entregado, no del borrador.
- **Un asiento `superseded` no libera su número** — permanece asignado, igual que un folio de papel no
  se reutiliza cuando se corrige un asiento: se escribe el siguiente folio que lo corrige.
- Columna `numero_correlativo integer` directa en `asiento_propuesto`, `unique (cliente_id,
  numero_correlativo)` — NULL mientras el asiento está `propuesto` (Postgres excluye NULLs de un
  `unique` normal automáticamente, así que múltiples propuestas sin confirmar no compiten entre sí).
- **Protección de inmutabilidad, sin trigger nuevo**: como la asignación ocurre exactamente en la
  transición propuesto→confirmado (estado viejo no terminal), el trigger `trg_asiento_propuesto_inmutable`
  (`0028`) ni interviene en ese momento — y una vez confirmada la fila, cualquier intento posterior de
  tocar `numero_correlativo` cae bajo la misma protección genérica que ya cubre
  `confirmado_por`/`confirmado_en`.
- Alta de la fila contadora: en el mismo `conJob('alta_estudio', …)` que ya provisiona el resto del
  cliente nuevo (precedente `0019`/`0045`), con `INSERT ... ON CONFLICT (cliente_id) DO NOTHING` como
  cinturón adicional contra dos primeras-confirmaciones concurrentes de un cliente recién creado.

### §4. Refinamientos de superficie técnica — `security-engineer`

- La carrera real a blindar es entre confirmaciones de **asientos distintos** del mismo cliente — la
  carrera "dos confirmaciones del mismo asiento" ya la resuelve el `UPDATE ... WHERE asiento_estado =
  'propuesto'` atómico existente en `confirmarAsiento()` (`escrituras.ts:619-629`).
- **No hace falta `SECURITY DEFINER` nuevo**, a diferencia de `0041`/`padron_manifestacion` (append-only
  por diseño): la tabla contadora es mutable por función — grant directo `select, update
  (siguiente_numero)` a `app_request`, invoker, dentro de RLS normal. Menos superficie `SECURITY
  DEFINER` para vigilar (R11 / `catalogo.test.ts`).
- Confirmado favorable: `apps/cli/src/confirmar-asientos.ts:166-190` ya hace `conUsuario()` una vez por
  asiento, no un lote entero en una sola transacción — el lock del contador se sostiene solo durante una
  transacción chica. **Se preserva este comportamiento a propósito**; si en el futuro alguien
  "optimiza" a una sola transacción por lote, el lock del contador quedaría retenido por todo el lote y
  serializaría confirmaciones que hoy corren independientes.
- Descartados: `SERIALIZABLE` (exige retry en todo el resto del código que toque estas tablas — invasivo)
  y advisory locks (no son sujetos a RLS ni a grant/revoke — rompen el principio de tenancy-vía-RLS de
  este repo; cualquier rol con conexión podría tomar el lock de cualquier cliente adivinando el hash).
- **La FK de trazabilidad tiene que ser compuesta tenant-safe**: `(cliente_id, movimiento_bancario_id)
  references movimiento_bancario_crudo (cliente_id, id)` — una FK simple contra `.id` no respeta RLS de
  la tabla referenciada (el chequeo de FK de Postgres corre con el privilegio del dueño de la tabla, no
  con RLS). Mismo idioma que ya usan `fk_asiento_renglon_cuenta`/`fk_asiento_renglon_fuente`/
  `fk_asiento_renglon_manifestacion` en la misma tabla, y 20+ instancias más en el esquema desde `0002`.
- Hallazgo de clasificación a corregir, no en este ADR (ver Pendientes): `pendiente_cierre.
  referencia_origen` está clasificado en `clasificacion-campos.ts:1432` como "digest", pero el código
  real (`escrituras.ts:555`) escribe el UUID crudo del movimiento — la nota de clasificación describe
  mal el dato.
- Grants nuevos (`numero_correlativo`, o la FK reemplazando `referencia_origen`) necesitan su propia
  justificación explícita contra una consulta real de `apps/web` — nunca heredados del grant que ya
  cubre el campo viejo (mismo criterio que `0047_rol_app_web.sql` ya documenta).
- Señalado, no resuelto acá: disciplina de mensaje de error (nunca interpolar `numero_correlativo` ni
  columnas N2 en un `RAISE EXCEPTION`), camino de sistema vía `conJob()` si algún día hace falta backfill
  retroactivo del correlativo, y la definición de si un asiento `superseded` implica algo sobre el
  correlativo del reemplazo (este ADR decide que no — cada confirmación real recibe folio nuevo, §3).

### §5. Clasificación y R25 — `seguridad-datos-financieros`

- `numero_correlativo` → **N1** (no revela contenido económico por sí solo, mismo tier que
  `corrige_asiento_id`). `movimiento_bancario_id` (FK nueva) → **N1** (mismo tier que
  `movimiento_bancario_crudo.id`).
- **`referencia_origen` hoy: verificado, NO es un vector de fuga entre clientes** — los tres puntos de
  comparación (§2) incluyen `cliente_id` en el predicado. Es riesgo de disponibilidad (cast sin
  sanitizar puede fallar) e integridad referencial no garantizada DENTRO del mismo cliente — hallazgo ya
  declarado y sin dueño en `HANDOFF.md:1958-1959`. **Este ADR es el vehículo para cerrarlo.**
- **R25 (`ADR-0002-seguridad.md`, reescrita 2026-08-16) es determinante para el diseño del correlativo**:
  "ninguna columna cuyo valor provenga de un secuencial COMPARTIDO ENTRE TENANTS sale en API/URL/export/
  mensaje al usuario" — precedente del incidente #7 (`tenant_node.nid`, `acceso_auditoria.id`). Si el
  correlativo fuera una secuencia global, sería el tercer miembro de esa clase prohibida y, además,
  nunca podría mostrarse al contador (perdería su razón de ser — "asiento #142"). **El diseño de §3
  (correlativo por cliente) es el único que permite `exportable: true` sin romper R25** — confirma la
  decisión, no la cuestiona.
- Caveat honesto: `exportable` hoy no es un control automático salvo el test de N3 — es documentación,
  no enforcement, hasta que exista esa regla. Se deja anotado, no se resuelve en este ADR.
- Sin fuente normativa cargada sobre obligación legal de correlatividad — mismo pendiente que §1.

---

## Decisión

1. **Granularidad: una línea de asiento por movimiento bancario, sin consolidar.** No se construye
   ninguna tabla puente de consolidación N:1 en este ADR — sin necesidad demostrada (§1).
2. **Trazabilidad**: formalizar `asiento_propuesto_renglon.referencia_origen` como FK compuesta
   nullable `(cliente_id, movimiento_bancario_id) references movimiento_bancario_crudo (cliente_id,
   id)` — reemplaza el campo `text` suelto. Cierra el hallazgo declarado y sin dueño de
   `HANDOFF.md:1958-1959` (§2, §4, §5).
3. **Corrección de bug, no opcional**: los dos escritores de reproceso (`reprocesarAsientoNoRevisado`,
   `corregirAsientoEntregado`) empiezan a llevar `movimiento_bancario_id` — hoy la traza se pierde por
   completo en ese camino (§2).
4. **Número correlativo**: columna `numero_correlativo integer` en `asiento_propuesto`, `unique
   (cliente_id, numero_correlativo)`, asignado por trigger en la transición `propuesto → confirmado` vía
   tabla contadora `asiento_correlativo_cliente(cliente_id pk, siguiente_numero)` lockeada con `SELECT
   ... FOR UPDATE` dentro de la misma transacción — nunca `SEQUENCE` ni `COUNT(*)`. Por cliente, nunca
   global (R25). Sin `SECURITY DEFINER` nuevo (§3, §4, §5).
5. **Glosa/descripción de encabezado**: ningún agente convocado encontró necesidad demostrada de una
   columna de glosa libre — la trazabilidad a nivel renglón (§2) y la columna "Concepto" que ya tiene el
   boceto aprobado de Pantalla 6 resuelven la descripción a nivel línea. No se diseña una columna de
   glosa nueva en este ADR por falta de necesidad, no por olvido.
6. **Clasificación**: `numero_correlativo` → N1; `movimiento_bancario_id` (FK) → N1 (§5).

### Forma de la migración propuesta (para una tarea de implementación futura, no aplicada acá)

`packages/data/migrations/0048_correlativo_asiento_propuesto.sql` (siguiente número libre — `0047` es
la última migración aplicada hoy):

1. Tabla `asiento_correlativo_cliente` — los siete renglones de ADR-0001 §5, `cliente_id uuid primary
   key references tenant_node(id) on delete restrict` (una fila por cliente; desviación puntual y
   documentada del boilerplate `id uuid` + `unique(cliente_id,id)`, porque nada más referencia esta
   fila — mismo criterio que `0027` ya usa para justificar desvíos puntuales del template), `
   siguiente_numero integer not null default 1`, RLS forzada, policy de `select` estándar, `grant
   select, update (siguiente_numero) to app_request`.
2. `alter table asiento_propuesto add column numero_correlativo integer;` + `constraint
   uq_asiento_propuesto_numero unique (cliente_id, numero_correlativo)`.
3. Trigger `BEFORE UPDATE ... WHEN (new.asiento_estado = 'confirmado' and old.asiento_estado is
   distinct from 'confirmado')`, invoker, sin `SECURITY DEFINER`, que hace `SELECT siguiente_numero ...
   FOR UPDATE` sobre la fila del cliente + incremento + `new.numero_correlativo := …`.
4. `alter table asiento_propuesto_renglon add column movimiento_bancario_id uuid;` + `constraint
   fk_asiento_renglon_movimiento foreign key (cliente_id, movimiento_bancario_id) references
   movimiento_bancario_crudo (cliente_id, id) on delete restrict`. Migración de datos: backfill desde
   `referencia_origen::uuid` donde el cast sea válido; `referencia_origen` queda deprecado, no se
   elimina en la misma migración (dos pasos, para poder verificar el backfill antes de dropear).
5. Ajuste de `escribirAsientoAutomatico`, `reprocesarAsientoNoRevisado`, `corregirAsientoEntregado`
   (`packages/data/src/cierre/escrituras.ts`) y `leerCandidatosDeReproceso`
   (`packages/data/src/cierre/lecturas.ts`) para leer/escribir `movimiento_bancario_id` en vez de
   `referencia_origen`.
6. Entradas nuevas en `packages/shared/src/seguridad/clasificacion-campos.ts` para
   `numero_correlativo` y `movimiento_bancario_id` (N1 ambas, §5).

Cada regla verificable nueva de esta lista (la FK compuesta, el `unique` del correlativo, el trigger de
asignación) necesita su prueba de mutación (CLAUDE.md §1.8) en el momento de implementación real — no en
este ADR de diseño.

---

## Pendientes declarados, explícitamente NO resueltos en este ADR

- **Tabla puente de consolidación N:1** — no construida, sin necesidad demostrada (§1). Reconvocar a
  `contador-dominio` si aparece un caso real de volumen que la presentación sola no resuelva.
- **Respaldo normativo (FACPCE/CCCN)** sobre correlatividad y consolidación de asientos — `knowledge/`
  es un esqueleto, sin fuente cargada (§1, §5).
- **`pendiente_cierre.referencia_origen`** — mismo patrón sin FK que `asiento_propuesto_renglon.
  referencia_origen`, no tocado en este ADR (hallazgo de `arquitecto-software`, §2).
- **Corrección de la nota de clasificación** de `pendiente_cierre.referencia_origen` en
  `clasificacion-campos.ts:1432` (dice "digest", el código escribe UUID crudo) — hallazgo de
  `security-engineer`, pendiente de fix separado (§4).
- **Ajuste de boceto pendiente — no es solo Pantalla 6, también Pantalla 5 (versión 3, ya mergeada a
  `main`)**: el boceto de Pantalla 6 muestra "12 grupos consolidados" como si cada grupo fuera una línea
  de asiento — no corresponde a la granularidad decidida acá (una línea por movimiento, sin consolidar).
  Pero Pantalla 5 (aprobada y ya mergeada) tiene el mismo problema en su propia tabla `.tabla-asiento`:
  cada fila de "grupo" ya muestra un Debe/Haber consolidado (por ejemplo, "6 movimientos" resumidos en
  un solo par de renglones), algo que Capa D nunca produciría así. No es un ajuste pendiente solo de
  Pantalla 6 — es una corrección sobre una pantalla ya aprobada y mergeada. Camino más probable para esa
  corrección futura (sugerencia de `contador-dominio`, no resuelta en este ADR): una solución de
  **presentación** sobre el modelo 1:1 real, mismo patrón que ya usa
  `agrupar-decisiones-pendientes.ts` para agrupar visualmente sin tocar la persistencia — nunca
  construir la tabla puente de consolidación solo para esto. Este ADR no ajusta ningún boceto — queda
  declarado como trabajo de diseño visual separado, sobre Pantalla 5 y Pantalla 6 las dos, a retomar
  explícitamente.
- **Prueba de mutación** (CLAUDE.md §1.8) de cada regla verificable nueva — corresponde al momento de
  implementación real, no a este ADR de diseño.

---

## Consecuencias

- Pantalla 6 (y, según el pendiente de arriba, también Pantalla 5) no puede darse por cerrada
  visualmente hasta que se resuelva el ajuste de granularidad — queda bloqueado, no descartado.
- La implementación real de este ADR (migración `0048` + ajustes de código) es una tarea separada,
  todavía no iniciada, que va a requerir su propio modo plan (esquema de por medio) y su propia
  convocatoria formal de `dba-data` + `security-engineer` + `seguridad-datos-financieros` como tareas
  `convocar <agente>` reales (CLAUDE.md §3.1), no solo la convocatoria de diseño ya hecha acá.
- El hallazgo declarado y sin dueño sobre `referencia_origen` (`HANDOFF.md:1958-1959`) queda con dueño:
  este ADR y la migración que lo implemente.

## Criterio de cierre

Este ADR se considera implementado cuando: la migración `0048` (o el número que le corresponda al
momento real) está aplicada, la FK compuesta y el correlativo pasan su prueba de mutación, los tres
escritores de renglones (`escribirAsientoAutomatico`, `reprocesarAsientoNoRevisado`,
`corregirAsientoEntregado`) escriben `movimiento_bancario_id` de forma consistente, y Pantalla 5/6
reflejan la granularidad real (una línea por movimiento) o documentan explícitamente por qué no.

### Estado de implementación (actualizado 2026-09-17) — Frente 1 (datos/backend) CERRADO; ADR completo sigue PARCIAL por Pantalla 5/6

`HANDOFF.md` (entradas 229 y 230) — no reescribir acá el detalle, solo el estado contra el criterio de
arriba:

- ✅ Migración `0048` escrita, aplicada y verificada localmente — con una desviación real y documentada
  respecto de la "Forma de la migración propuesta" de este mismo ADR: `asiento_correlativo_cliente` es
  **autoprovisora** (`INSERT (cliente_id) ... ON CONFLICT DO NOTHING` dentro del trigger de asignación),
  no depende de un `conJob('alta_estudio')` futuro como preveía §3 — medido en vivo que sin
  autoprovisión, un `SELECT ... FOR UPDATE` sin policy de `UPDATE` sobre esa tabla devuelve 0 filas en
  silencio (no un `42501`) para un cliente efímero de test, rompiendo un test de seguridad real. Ver la
  migración (cabecera) para el detalle medido completo.
- ✅ El hallazgo de `security-engineer` sobre el `grant insert` de tabla completa (primera versión de la
  migración) corregido a `insert (cliente_id)` — verificado en vivo.
- ✅ Gate verde con el mismo baseline preexistente (8 rojos ya conocidos, ninguno nuevo);
  `grants-conjunto-cerrado.test.ts` actualizado y 23/23 verde.
- ✅ **Cerrado (entrada 230)**: `escrituras.ts`/`lecturas.ts`, `reprocesar-capa-d.ts`,
  `agrupar-decisiones-pendientes.ts` y dos lectores adicionales encontrados en vivo durante la propia
  tarea (`relevamiento-laura.ts`, `paquete-cierre-bracci-roka-2026-05-a-08.ts`) ya escriben/leen
  `movimiento_bancario_id` — ningún escritor/lector de producción de `asiento_propuesto_renglon` sigue
  citando `referencia_origen`. `pendiente_cierre.referencia_origen` sigue vigente a propósito (hallazgo
  declarado aparte, `0048` no lo migra).
- ✅ **Cerrado (entrada 230)**: `packages/data/tests/mutaciones-0048.test.ts` — 16 tests (7 mutaciones +
  9 legítimos), incluida la autoprovisión del contador y la concurrencia real del `FOR UPDATE`
  (`qa-automation` encontró que ninguno de los dos tenía test automatizado, solo la reproducción manual
  documentada en la cabecera de `0048`, y los cerró).
- ❌ **Sigue sin cerrar, fuera del alcance de la entrada 230**: Pantalla 5/6 siguen sin reflejar la
  granularidad real (una línea por movimiento) — pendiente de diseño visual separado (ver este mismo
  ADR, sección de Pendientes, y doc 34).

**Conclusión**: el Frente 1 (modelo de datos + aplicación) queda **completamente cerrado** — cumple los
primeros tres puntos del criterio de arriba. El ADR como un todo sigue **parcialmente abierto** por el
cuarto punto (ajuste de boceto de Pantalla 5/6), que es una tarea de diseño visual separada, no de
backend, y no bloquea el trabajo siguiente sobre datos/backend (PR4).
