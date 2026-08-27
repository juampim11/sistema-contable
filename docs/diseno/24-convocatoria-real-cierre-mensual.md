---
Convocatoria REAL (Claude Code, agentes de `.claude/agents/` invocados de verdad vía `Agent()`, no
narrados) sobre las 14 preguntas abiertas de `docs/diseno/23-arquitectura-cierre-mensual.md` §4.2.
Creado: 2026-08-26, sesión en modo plan (no se tocó código ni migraciones). Cinco convocatorias en
paralelo: `contador-dominio` (P1-3), `plan-cuentas-multicliente` (P4-5), `arquitecto-software` y
`dba-data` en llamadas separadas (P6-8, para poder divergir), `motor-conciliacion-contable` (P10).
---

# Convocatoria real sobre la arquitectura del cierre mensual

> **Cuándo leer este documento**: junto con `23`, nunca solo. Acá está la respuesta real a las
> preguntas que `23` §4.2 dejó abiertas para "cuando esto pase a Claude Code" — y esta sesión es esa
> convocatoria. Las decisiones D-1 a D-12 de `23` §4.1 siguen vigentes salvo donde esta sección dice
> explícitamente que cambian.

## 0. Advertencia de fuentes — confirmada por dos agentes de forma independiente

`23` cita, entre backticks sueltos (`04`, `05`, `08`, `09`, `10`, `12`, `13`), documentos del set
`00`-`13` de **Project Knowledge de Claude.ai**, que **no están en este repo**. El propio encabezado
de `23` lo dice ("vive originalmente en Project Knowledge... no en el repo"), pero es fácil leerlo
rápido y asumir que esos números coinciden con `docs/diseno/04-imputacion-contable.md`,
`09-lecciones-aprendidas.md`, `10-deuda-declarada.md`, `12-cotizacion-bna-plan.md` de este repo.
**No coinciden.** `contador-dominio` y `motor-conciliacion-contable`, cada uno por su lado, verificaron
esos archivos del repo y confirmaron que existen con esos mismos números pero **contenido distinto**.

Ningún agente inventó contenido del set `00`-`13`. Donde una pregunta dependía de un detalle puntual
de esos documentos, el agente lo dice explícito abajo y razona con lo que sí tiene: el texto ya citado
dentro de `23`, el código real del repo, y — en el caso de la pregunta 10 — el documento real del repo
que resultó ser la fuente correcta (`docs/diseno/12-cotizacion-bna-plan.md`, que ya dejaba esta misma
pregunta pendiente en su §4).

**Si en algún momento hace falta cerrar un punto contra el texto original de Project Knowledge**, hay
que subir esos archivos al repo (como ya se hizo con `23`) o pasarlos en el contexto de una convocatoria
puntual. No se asumió contenido en ningún punto de este documento.

---

## 1. `contador-dominio` — preguntas 1, 2, 3

### P1 — Fecha de imputación cruzando el corte de mes (ROKA)

**Alcanza con la fecha por renglón, pero no dentro de un solo `asiento_propuesto` — hacen falta DOS,
uno por `cierre_id`.** `asiento_propuesto.cierre_id` es `NOT NULL` y apunta a un único
`cierre_cliente_periodo`, con `CHECK (total_debe = total_haber)` a nivel de asiento. Un renglón de
julio dentro de un asiento cuyo `cierre_id` es el de junio declararía una cosa en la fecha y otra en la
pertenencia — la misma clase de campo que dice algo distinto de lo que estructuralmente es, que ya
motivó la nota de columna sobre `confirmado_por`.

Criterio: **asiento de devengamiento** (`tipo=devengamiento`, `cierre_id`=junio, Debe Deudores por
Ventas / Haber Ventas + IVA Débito Fiscal, nace del Libro IVA Ventas) + **asiento de cancelación**
(`tipo=cancelacion`, `cierre_id`=julio, Debe Banco neto + comisión + retenciones / Haber Deudores por
Ventas). Deudores por Ventas queda con saldo abierto entre los dos — eso es lo que habilita
`cierre_anterior_id` (D-2): el saldo de cierre de junio es el de apertura de julio para esa cuenta, sin
partida abierta ni conciliación factura↔cobro (D-8 se mantiene).

`fecha_imputacion` por renglón sigue siendo útil, pero **dentro** del mismo `cierre_id` (ej. tres
liquidaciones de tarjeta de días distintos de julio, todas canceladas en el asiento de julio) — no para
cruzar el corte de período.

### P2 — Tolerancia cero, contra el caso trivial de HYJ (1 movimiento)

**Ratificada sin excepción por volumen de actividad.** Con un solo movimiento la ecuación tiene un
único término, pero sigue siendo la misma identidad: si no cuadra con 1 movimiento, el error es
proporcionalmente **más** grave que con 200, no menos. Los dos casos legítimos identificados no son
excepciones a la tolerancia cero, son formas de aplicarla bien: (a) redondeo — la tolerancia se fija en
la unidad mínima de la moneda (ARS $0,01 / USD US$0,01), no se relaja; (b) saldo inicial no disponible
(junio de FCI sin mayo) — eso es `no_verificable`, D-9, no un descuadre.

### P3 — Fuente llega después del cierre confirmado (HYJ / BBVA)

**Criterio de materialidad**, no una regla única:

- **Material** → reabrir: `cierre_transicion` `confirmado → en_revision`, motivo obligatorio, supersede
  los `asiento_propuesto` confirmados afectados (mecanismo ya propuesto por `arquitecto-software` en
  `23` §2.4).
- **No material** → no se reabre. El movimiento se imputa en el período **siguiente**, con
  `referencia_origen` explícita al período de origen y una nota de "ajuste de período anterior".
- Distinto de D-7 (cotización corregida no reabre sola): D-7 es reinterpretación de un valor sobre
  datos completos; esto es un período que se cerró **incompleto**, sabiendo que le faltaba una fuente
  esperada.
- El umbral numérico de materialidad no lo fija `contador-dominio` acá — es política por cliente
  (`plan-cuentas-multicliente` + `product-owner`).

**Hallazgo que no estaba resuelto**: si `expectativa_fuente_cliente` de HYJ tiene BBVA `confirmada =
true`, el `pendiente_cierre` de documento faltante **no se cierra solo** (D-5b) mientras BBVA siga
bloqueada — lo cual sugiere que, tal como está descripto el flujo, **el cierre de HYJ no debería poder
llegar a `confirmado` con ese pendiente abierto**, salvo que exista una vía explícita de "confirmar con
reserva declarada" que hoy **no existe** en el enum de `estado`. Sin esa vía, la reapertura de BBVA el
día que se destrabe es una sorpresa retroactiva no anunciada. **Este punto queda abierto — ver D-14 más
abajo.**

**Postura provisoria mientras D-14 no se resuelva formal** (agregado 2026-08-26, a pedido explícito de
JP): hoy **no bloquea nada operativo** — `cierre_cliente_periodo` y `asiento_propuesto` no existen en
ninguna migración aplicada, así que ningún cierre de ningún cliente, HYJ incluido, se está confirmando
todavía por ningún camino de código real. No hace falta una vía manual de excepción ya: construir un
mecanismo de "confirmar con reserva" antes de tener el flujo de confirmación en sí sería superficie
nueva sin nadie que la use hoy. La postura es la contraria: **D-14 se documenta como limitación
conocida y aceptada mientras el paso 9 no se implemente**, pero pasa a ser **bloqueante en el momento
en que se escriba el código de confirmación (paso 9 / Capa D)** — no después. HYJ es el caso de trabajo
con una fuente viva y otra bloqueada simultáneas (D-12), así que va a ejercitar este camino el primer
día que alguien pruebe confirmar un cierre suyo. Quien implemente paso 9 no puede diferir esta decisión
"para más adelante" una segunda vez.

Validar con profesional matriculado.

---

## 2. `plan-cuentas-multicliente` — preguntas 4, 5

### P4 — Modelo de plan versionado: **vigencia por cuenta**, no versión completa

Descarta versión completa con supersesión por el mismo argumento que `23` §2.4 usó contra superseder
`cierre_cliente_periodo` entero: o se clona todo por un cambio puntual (volumen sin necesidad), o no se
clona y `plan_cuentas_version_id` es un wrapper vacío. Y no encaja con cómo Laura trabaja (cambios
puntuales no coordinados, no "publicaciones de versión").

Precedente directo ya usado dos veces en este repo: `cuenta_bancaria_identificador` (vigencia del
número de cuenta) y `padron_socio` (vigencia semiabierta del socio). Mismo patrón acá: identidad
estable + satélite versionado.

```
cuenta                    -- identidad ESTABLE, la que cita todo asiento (FK compuesta, R42)
  id, cliente_id, creada_en

cuenta_atributo           -- lo que CAMBIA, vigencia semiabierta [desde, hasta)
  id, cliente_id, cuenta_id, codigo, denominacion, nivel, cuenta_padre_id,
  rol_funcional, activa, vigente_desde, vigente_hasta, respaldo, creada_en
  -- una sola vigencia ABIERTA por cuenta (índice parcial where vigente_hasta is null,
  --  mismo mecanismo que uq_padron_socio_vigente de 0013)
```

**`plan_cuentas_version_id` se retira** de `cierre_cliente_periodo` y de `asiento_propuesto`. En
`asiento_propuesto_renglon` se reemplaza por `cuenta_id` (FK estable) + `cuenta_ref` (jsonb, cita
congelada de `{codigo, denominacion, rol_funcional}` vigente a `fecha_imputacion`, capturada al
confirmar — mismo mecanismo que `valuacion_ref`, D-7).

**Contra ROKA**: si Laura renombra/reclasifica una cuenta a mitad de período, la fila `cuenta_atributo`
vigente se cierra y se abre una nueva con el mismo `cuenta_id`. Un cierre ya confirmado no vuelve a leer
`cuenta_atributo` — sus renglones ya tienen `cuenta_ref` congelado, así que no cambia. Un recálculo de
un período cerrado resuelve `cuenta_atributo` vigente **a la fecha original**, dando el mismo resultado.

**Lo que el modelo NO decide** (queda para `contador-dominio`): si un cambio dado es *rename* (mismo
`cuenta_id`) o *reclasificación de fondo* (da de baja una cuenta y da de alta otra) — eso es tratamiento
contable, no forma del dato.

### P5 — Clasificación de denominación de cuenta con nombre de socio: **N2 propuesto**, sujeto a ratificación

`clasificacion-campos.ts` clasifica por lo que la columna **revela**, no por en qué tabla vive
(precedente: `tenant_node.nombre` se clasifica por el caso más sensible). `cuenta_atributo.denominacion`
en la mayoría de los casos no dice nada de una persona, pero en el caso "Cuenta particular - [nombre]"
es indistinguible en forma de `padron_socio.denominacion` (N2). Se clasifica por el peor caso: **N2, sin
N2-R** — mismo argumento de usabilidad que ya sostiene a `padron_socio.denominacion` fuera del régimen
auditado (se lee en cada pantalla, cada combo de imputación).

Recomienda el mismo tipo de puerta de admisión que ya usa `padron_socio_denominacion_sin_identificador_chk`
(rechazar corridas de 7+ dígitos, para que un CUIT no quede en claro en una columna sin auditoría).

**Explícitamente NO decidido por este agente**: el nivel final, la forma exacta del check, y si
convendría forzar una referencia a `padron_socio_id` en vez de nombre embebido en texto libre —
**terreno de `seguridad-datos-financieros`**, condicional (ver §5 de este documento).

**Impacto D-1..D-12**: ninguna se contradice — todas asumían la *existencia* de `plan_cuentas_version_id`
como dependencia, no su forma. Se agrega **D-15** (ver tabla final).

---

## 3 y 4. `arquitecto-software` y `dba-data` — preguntas 6, 7, 8 (llamadas separadas, con divergencia real)

Ambos leyeron `23` §2 completo (incluido, para `arquitecto-software`, su propio dictamen del
2026-08-25) y lo revisaron con ojo crítico en vez de ratificarlo. Coinciden en la mayoría, divergen en
un punto real — marcado explícito en §4.4.

### P6 — `documento_ingerido` + backfill de 3 lotes: **desacoplar crear de backfillear**, y el riesgo real no es el que `23` señalaba

**Acuerdo entre los dos**: crear las 6 tablas de §2.1 **ahora**, vacías, con RLS desde el día uno, bajo
el gate normal de §3.1 (no bajo §1.9, porque no hay dato real en juego todavía). **Backfillear las 3
filas reales recién con el primer consumidor real** — Commits 3/4 de liquidaciones o el arranque de
Capa D, no atado a que exista Libro IVA (la genericidad de `documento_ingerido` permite sumar una
fuente nueva por `ALTER TYPE ... ADD VALUE`, aditivo).

**El riesgo real, medido por `dba-data` contra el código, no es `objeto_almacenamiento NOT NULL`** (ese
está garantizado: `apps/cli/src/ingestar.ts` revierte el lote entero si el guardado del archivo falla).
**Es `periodo_desde`/`periodo_hasta`.** Hoy el período vive en `lote_ingesta_cuenta`, **por cuenta**, no
en `lote_ingesta` (por archivo). El lote real de Macro/ROKA es **un solo archivo con 3 cuentas**, cada
una con su propio período — colgarlo de `documento_ingerido` con un único `periodo_desde/hasta` por
archivo puede **mentir** si una cuenta se abrió a mitad de mes. `dba-data` recomienda que el script de
backfill falle explícito (no compute en silencio) si las cuentas de un mismo lote traen períodos
distintos, y que el comentario de columna diga qué representa el campo cuando el documento es
multi-cuenta. **Esta es información nueva que `23` §2.3 punto 2 no tenía** — cambia el orden de
prioridad del backfill: hay que cerrar esta semántica ANTES de escribir el script, no en paralelo.

### P7 — `debe = haber`: ratificado el mecanismo, con matices reales entre los dos dictámenes

**Coinciden en la mecánica de fondo**: control duro en el acto de confirmar (`conUsuario`, nunca
`conJob`), `CHECK` como defensa en profundidad (no la garantía), y si el recálculo no cuadra el asiento
**queda en `propuesto`**, no se rechaza — no hace falta un estado nuevo.

**`arquitecto-software`** agrega el mecanismo físico completo, copiado del patrón ya probado en este
repo por `entrada_digest` (migración 0021): `total_debe`/`total_haber` dejan de ser escribibles por
`app_request`, un trigger `AFTER INSERT/UPDATE/DELETE` los mantiene, y al confirmar se recalcula desde
los renglones vigentes ignorando el caché — todo dentro de una única transacción. Concluye que el
incidente #2 (agregado que cruza la frontera de RLS del escritor) **no se da acá por construcción**,
porque el agregado es intra-tenant e intra-asiento y quien confirma ya ve el 100% de los renglones.

**`dba-data`** confirma que el mecanismo específico del incidente #2 (visibilidad auto-referencial: la
columna que se valida determina la visibilidad de la fila que la contiene) **no aplica** acá — pero
señala un riesgo **distinto y real**: el trigger corre `invoker`, sujeto a la policy de **lectura**, no
de escritura. Ya hay precedente en el repo de esa asimetría (`padron_socio_documento`: `auditor` lee,
no escribe). Si `asiento_propuesto_renglon` termina con roles de lectura/escritura distintos (plausible,
porque carga `padron_manifestacion_id` y `valuacion_ref`), el trigger puede **subcuentar sin error**, y
el `CHECK` pasaría sobre un total mal calculado. Recomienda: antes de escribir el trigger como defensa
en profundidad, auditar el conjunto de roles de lectura vs. escritura de la tabla con
`seguridad-datos-financieros`; y la prueba de mutación obligatoria (CLAUDE.md §1.8) tiene que insertar
con el **rol de escritura menos privilegiado**, no con el dueño del esquema.

**Síntesis**: el mecanismo de `arquitecto-software` es correcto como diseño, pero **no se puede
implementar sin la auditoría de roles que pide `dba-data` primero** — si no, el trigger puede dar una
falsa sensación de seguridad exactamente en el escenario que ya costó un incidente real en este repo.

### P8 — Clasificación de columnas nuevas: **acuerdo en 4 de 5 puntos, divergencia real en `estado`**

**Acuerdo**: `confirmado_por`/`resuelto_por`/`hecho_por` = N1, mismo patrón que
`padron_manifestacion.manifestado_por` ("identidad declarada no es identidad autenticada"). `valuacion_ref`
= N2 (plata del propio cliente). `verificacion_heredada` = N2 por defecto **hasta que exista un `CHECK`**
que garantice que solo lleva códigos y referencias, nunca un valor crudo — ambos señalan el mismo riesgo
concreto: si algún día copia el objeto de confianza de una liquidación OCR tal cual, se cuela
`valorLeido` (ya en `CLAVES_SENSIBLES_EXTERNAS`) dentro de una tabla que se lista todos los meses.

**Divergencia real, no reconciliada — sobre `estado` de `cierre_cliente_periodo`/`asiento_propuesto`/`pendiente_cierre`**:

| | `arquitecto-software` | `dba-data` |
|---|---|---|
| Nivel propuesto | **N1** (metadato de proceso) | **N2** (hecho de negocio: si el cierre de julio de un cliente está confirmado o abierto habla de SU puntualidad contable) |
| Nombre de columna | Mantiene `estado` bare | Renombrar a `<tabla>_estado` (`cierre_estado`, `asiento_estado`, `pendiente_estado`) |
| Argumento | El registro ya clasifica `lote_ingesta.estado` como N1 — para no romper esa clasificación (`clasificacion-campos.ts` es un `Set<string>` **global por nombre de columna**, no por tabla+columna), mantiene el nombre y el nivel juntos | El mismo hecho estructural (registro global por nombre) es la razón para **no** reusar el nombre bare: ya hay precedente exacto — `reconocimiento_contrapartida` tuvo que renombrar su columna a `resolucion_estado` para poder ser N2 sin tapar la clasificación N1 de `lote_ingesta.estado` (`clasificacion-campos.ts` líneas 878-882, comentario explícito en el propio archivo) |

`dba-data` señala un hecho verificable en el código (el `Set<string>` global y el precedente de
`resolucion_estado`) que `arquitecto-software` no llegó a examinar — la parte de la afirmación sobre el
**mecanismo de colisión de nombres** no es opinable, está en el archivo. La parte que sigue siendo
criterio (¿es `estado` de un cierre N1 o N2?) es la que queda genuinamente abierta entre los dos.

**Resolución de esta convocatoria**: se adopta el hallazgo de `dba-data` sobre el **renombre** como
no negociable (`cierre_estado`/`asiento_estado`/`pendiente_estado`, nunca `estado` bare) porque es un
hecho mecánico del registro de clasificación, no una preferencia. El **nivel** (N1 vs N2) de esas tres
columnas queda **sin cerrar** — se marca en D-19 como pendiente de ratificación por
`seguridad-datos-financieros` cuando se implemente, con las dos posiciones documentadas.

### Hallazgos adicionales de `dba-data`, no pedidos explícitamente pero relevantes

1. **Contradicción interna en `23`**: §2.2 pone un índice único de `cierre_cliente_periodo` con
   `WHERE superseded_by_id IS NULL`, pero esa tabla no tiene esa columna en §2.1 — y §2.4 dice
   explícitamente que `cierre_cliente_periodo` **no se supersede** (usa máquina de estados). Falta
   decidir la condición real (¿`WHERE estado <> 'anulado'`?) antes de escribir la migración.
2. **NULL no se deduplica en `UNIQUE`**: los índices de `fuente_cierre` (`cuenta_id` nullable —
   Libro IVA no tiene cuenta) y `pendiente_cierre` (`fuente_cierre_id`, `referencia_origen` nullable)
   no protegen nada en el caso con ambos NULL. Hay que decidir el caso NULL antes de la migración real.
3. **Faltan las FKs compuestas explícitas** tenant-consistentes en el boceto (`asiento_propuesto_renglon`
   → `asiento_propuesto`, y las demás hijas → `cierre_cliente_periodo`) — conceptualmente asumidas, no
   escritas. Mismo patrón que ya usa `0004` (`uq_lote_ingesta_tenant` + FK de 2 columnas en el hijo).

---

## 5. Pregunta 9 (`seguridad-datos-financieros`) — sigue sin activarse

Condición de activación: confirmación explícita de que hay enrutamiento real de pendientes entre
personas del estudio. **No la hay** — no cambió desde `23` §4.2. Queda documentada, sin convocar, tal
como pedía la tarea. Si la ronda de preguntas a Laura (§7 de este documento) confirma enrutamiento real,
se activa recién ahí.

---

## 6. `motor-conciliacion-contable` — pregunta 10

### Corrección de fuente, antes del diseño

`23` cita "`09` Frente 1" para esta pregunta. Verificado: **no es**
`docs/diseno/09-lecciones-aprendidas.md` de este repo (confirmado leyéndolo — trata de errores de
parseo de adaptadores bancarios, nada de cotizaciones). La fuente real, que sí está en el repo y ya
dejaba esta pregunta pendiente en su propio §4, es **`docs/diseno/12-cotizacion-bna-plan.md`** (plan
aprobado, aplicado como migración `0022`). Es literalmente la convocatoria que ese documento dejó
pendiente.

Estado real verificado: `cotizacion_bna(moneda, fecha, compra, venta, fuente, created_at)` existe y está
aplicada, **sin** columna que marque una fila como aproximada. `apps/cli/src/actualizar-cotizaciones.ts`
(el comando que la puebla) **no existe todavía** — coincide con lo que dice `23`.

### Diseño en dos capas

**Capa 1 — servicio de I/O** (`resolverCotizacion(moneda, fechaMovimiento, hoy)`, solo lee la tabla +
un calendario estático, nunca hace fetch):

| Caso | Detección | Resultado |
|---|---|---|
| Fecha futura | `fechaMovimiento > hoy` | `no_disponible` / `fecha_futura` |
| Día hábil sin fila cacheada | no está en el calendario de no-hábiles, sin fila exacta | `no_disponible` / `no_cargada` — **nunca camina hacia atrás**: es indistinguible de un hueco real de datos |
| Fin de semana / feriado bancario | está en el calendario de no-hábiles | camina hacia atrás **dentro del caché ya cargado** (sin fetch) hasta la fila hábil más cercana → `aproximada: true` con la fecha real citada; si tampoco la encuentra, `no_disponible` |
| Día hábil, fila exacta | — | `exacta` |

**Capa 2 — motor puro**: recibe `CotizacionResuelta` ya armado (mismo idiom que `PadronConsultado` de
`packages/contabilidad/src/nucleo/contrapartida.ts`), nunca resuelve la fecha por sí mismo.

- `disponible: true` (exacta o `aproximada`) → **se propone**, normal. Si `aproximada`, la evidencia del
  renglón lo cita explícito ("cotización BNA del [fecha hábil anterior], movimiento del [fecha feriado]").
  No bloquea — bloquear todo movimiento de fin de semana ahogaría la cola sin necesidad, y es una regla
  declarada, no una suposición.
- `disponible: false` → el renglón **no se propone**. `pendiente_cierre` con motivo nuevo
  **`cotizacion_no_disponible`** (ningún valor existente de la unión cerrada de `motivo` nombra "falta un
  dato de referencia externo"). Se autocierra por el mismo mecanismo de D-5b, disparado por la carga de
  `cotizacion_bna` en vez de por alta de `fuente_cierre` — mismo comportamiento, evento distinto.

**Contra ROKA (cuenta USD Macro)**: día hábil con job corrido → propuesta normal citando fuente/fecha.
Fin de semana → propuesta con `aproximada: true`. Job no corrido todavía → sin propuesta, pendiente que
se resuelve solo apenas corra el job, sin que nadie del estudio decida nada a mano.

**Deuda explícita, no resuelta acá**: falta una tabla de calendario de feriados bancarios (N0, sin
`cliente_id`, mismo perfil que `banco`) — no existe hoy en el repo. Queda para `dba-data`.

---

## 7. Preguntas 11 a 14 — para Laura, no respondidas en esta convocatoria

Listadas tal como pide la tarea, no se responden acá:

11. Timing de la diferencia de cambio (`05` de Project Knowledge, sin enviar) — ahora con más urgencia
    porque ROKA es el caso de trabajo del diseño.
12. Confirmación de la cuenta puente de Bracci (sin enviar).
13. 🆕 La única pregunta del paso 6 que sigue abierta: con el asiento del mes armado, ¿lo revisa/firma
    alguien distinto del que lo preparó, o lo cierra el mismo que lo procesa? Define si `confirmado_por`
    se queda o se saca del modelo.
14. 🆕 Las cuatro preguntas de ARCA (de dónde saca hoy compras y ventas, si los clientes le tienen
    delegados servicios): suben de prioridad, porque definen cómo entra la fuente que destraba la parte
    más grande de la cola del paso 6.

Ninguna cambia por esta convocatoria — siguen igual que en `23` §4.2.

---

## 8. Tabla de decisiones actualizada

### D-1 a D-12 — de `23` §4.1, con nota de qué cambió

| # | Decisión (resumen) | Estado tras esta convocatoria |
|---|---|---|
| D-1 | `tipo_periodo` desde el día uno | Sin cambios |
| D-2 | `cierre_anterior_id`, encadenamiento | **Se precisa** (P1): el encadenamiento es lo que explica cómo el saldo de Deudores por Ventas viaja de un `asiento_propuesto` a otro cuando la venta cruza el corte de mes |
| D-3 | `documento_ingerido`, registro único | **Se desacopla** (P6): crear la tabla ahora ≠ backfillear los 3 lotes reales ahora. Ver D-17 |
| D-4 | Paso 6 sin dimensión nueva | Sin cambios |
| D-5 | `confirmado_por` es rastro, no compuerta | Sin cambios (ratificado también por P8: N1, "identidad declarada ≠ autenticada") |
| D-5b | Pendiente por documento faltante se cierra solo | **Se extiende** dos veces: (P3) hace falta la misma regla para un cierre YA confirmado, vía `cierre_transicion`, no solo para uno abierto; (P10) el trigger también aplica a `cotizacion_no_disponible`, disparado por la carga de `cotizacion_bna` |
| D-5c | ARCA entra por `documento_ingerido` | Sin cambios |
| D-5d | Expectativa de fuentes se infiere | Sin cambios |
| D-6 | Supersesión mixta / `cierre_transicion` | **Se completa** (P3): el gatillo de reapertura es la MATERIALIDAD de la fuente tardía, no su sola llegada, y se distingue de D-7 |
| D-7 | El asiento cita, no recalcula | **Se extiende** (P10): la cotización resuelta también cita (fuente, fecha real usada, si es aproximada) en vez de recalcular |
| D-8 | Sin partida abierta, fecha por renglón | **Se precisa** (P1): resuelve diferencias de fecha DENTRO de un mismo `cierre_id`; cruzar un período real exige DOS `asiento_propuesto` |
| D-9 | `no_verificable` primera clase | **Ratificado explícito** (P2, sin excepción por volumen) y extendido (P10: `aproximada` es la misma familia de valor de primera clase) |
| D-10 | Congelar contrato tras 1er adapter | Sin cambios (superado en los hechos por Bancor, ya anotado en `23`) |
| D-11 | Liquidaciones esperan a `documento_ingerido` | Sin cambios |
| D-12 | Caso de trabajo = ROKA + HYJ, nunca Bracci | **Ratificado y usado en los 5 dictámenes de esta convocatoria** |

### D-13 en adelante — nuevas, renumeradas de forma coherente (cada agente había numerado por su cuenta)

| # | Decisión | Origen |
|---|---|---|
| D-13 | **Paso 3.5 (cuadratura tolerancia cero para extracto bancario) pasa a ser decisión formal**, sin excepción por volumen de actividad | `contador-dominio`, P2 |
| D-14 | 🟡 **Abierta, no resuelta**: falta una vía de "confirmar con reserva declarada" en el enum de `estado` de `cierre_cliente_periodo`, para el caso HYJ (fuente esperada y confirmada que sigue bloqueada). Sin esa vía, según el flujo tal como está descripto, el cierre no debería llegar a `confirmado` mientras el pendiente siga abierto — o hay que decidir explícitamente lo contrario. **Postura provisoria**: limitación conocida y aceptada mientras el paso 9 (confirmación) no exista en código — no hace falta vía manual de excepción hoy — pero es **bloqueante para escribir ese código**, no postergable una segunda vez | `contador-dominio`, P3 |
| D-15 | Plan de cuentas versionado por **vigencia por cuenta** (`cuenta` + `cuenta_atributo`), no por versión completa. `plan_cuentas_version_id` se retira de `cierre_cliente_periodo` y `asiento_propuesto`; se reemplaza por `cuenta_id` (FK estable) + `cuenta_ref` (cita congelada, mismo mecanismo que `valuacion_ref`) | `plan-cuentas-multicliente`, P4 |
| D-16 | 🟡 **Propuesta, sujeta a ratificación de `seguridad-datos-financieros`**: denominación de cuenta con nombre de socio embebido = N2 (mismo nivel que `padron_socio.denominacion`), con puerta de admisión tipo `_sin_identificador_chk` | `plan-cuentas-multicliente`, P5 |
| D-17 | `documento_ingerido`: crear las 6 tablas ahora (vacías, gate normal §3.1); backfillear los 3 lotes reales recién con el primer consumidor real (Commits 3/4 de liquidaciones o Capa D). **Antes de backfillear**, cerrar la semántica de `periodo_desde`/`periodo_hasta` para documentos multi-cuenta (riesgo real medido por `dba-data`, no el que señalaba `23` originalmente) | `arquitecto-software` + `dba-data`, P6 |
| D-18 | `debe = haber`: control duro en el acto de confirmar (`conUsuario`, nunca `conJob`), trigger que mantiene `total_debe`/`total_haber` (mismo patrón que `entrada_digest`, 0021) como defensa en profundidad, `CHECK` como tercera capa. **Antes de implementar el trigger**, auditar con `seguridad-datos-financieros` si `asiento_propuesto_renglon` va a tener roles de lectura/escritura asimétricos (riesgo real señalado por `dba-data`, distinto del incidente #2 pero de la misma familia) | `arquitecto-software` + `dba-data`, P7 |
| D-19 | 🟡 **Divergencia no reconciliada**: columnas `estado` de `cierre_cliente_periodo`/`asiento_propuesto`/`pendiente_cierre` se renombran a `<tabla>_estado` (no negociable — hecho mecánico del registro global de clasificación, precedente `resolucion_estado`). El **nivel** (N1 según `arquitecto-software`, metadato de proceso / N2 según `dba-data`, hecho de negocio) queda sin cerrar, pendiente de `seguridad-datos-financieros` | `arquitecto-software` + `dba-data`, P8 |
| D-20 | `valuacion_ref` = N2. `verificacion_heredada` = N2 por defecto hasta que exista un `CHECK` que garantice que solo lleva códigos/referencias, nunca un valor crudo (riesgo concreto: `ConfianzaDeCampo.valorLeido` de OCR de liquidaciones) | `arquitecto-software` + `dba-data`, P8 |
| D-21 | `confirmado_por`/`resuelto_por`/`hecho_por` = N1, nota de columna "identidad declarada ≠ identidad autenticada" (mismo patrón `manifestado_por`) | `arquitecto-software` + `dba-data`, P8 |
| D-22 | Cotización BNA en dos capas: servicio de I/O resuelve la fecha (nunca el motor puro, nunca fetch en caliente) y produce `CotizacionResuelta` (idiom `PadronConsultado`). Fin de semana/feriado: camina hacia atrás SOLO dentro del caché, `aproximada: true`, se propone igual. Día hábil sin cargar o fecha futura: no se propone, `pendiente_cierre` motivo nuevo `cotizacion_no_disponible`, autocierre por D-5b extendido | `motor-conciliacion-contable`, P10 |
| D-23 | 🟡 **Deuda declarada**: falta tabla de calendario de feriados bancarios (N0, sin `cliente_id`) para que D-22 funcione — no existe hoy en el repo | `motor-conciliacion-contable`, P10 |

### Hallazgos adicionales, fuera de la tabla D (bugs de diseño en `23` §2, no preguntas de la convocatoria)

1. `23` §2.2 vs §2.4 se contradicen sobre si `cierre_cliente_periodo` tiene `superseded_by_id` (el
   índice único de §2.2 lo usa; §2.4 dice que esa tabla no se supersede). Decidir la condición real del
   índice único antes de escribir la migración.
2. Los índices únicos de `fuente_cierre` (`cuenta_id` nullable) y `pendiente_cierre` (`fuente_cierre_id`,
   `referencia_origen` nullable) no deduplican el caso con NULL — Postgres no compara NULLs como iguales
   en un `UNIQUE`. Decidir el caso NULL antes de la migración real.
3. Faltan las FKs compuestas tenant-consistentes explícitas en el boceto de §2.1 (conceptualmente
   asumidas, no escritas) — mismo patrón que `0004`.

(`dba-data`, hallazgos no pedidos explícitamente, surgidos de revisar §2 con ojo crítico.)

---

## 9. Qué queda para la próxima convocatoria

- **D-14** (vía de "confirmar con reserva") y **D-19** (nivel de `estado`) son las dos únicas
  divergencias/gaps genuinos sin cerrar de esta ronda — requieren una decisión de
  `arquitecto-software`/`product-owner` (D-14) y de `seguridad-datos-financieros` (D-19), no una
  opinión más de los mismos agentes.
- **D-16** y **D-20** están "propuestas, sujetas a ratificación" — necesitan la convocatoria real y
  obligatoria a `seguridad-datos-financieros` que la matriz de `agents/README.md` exige para cualquier
  cambio que toque datos de clientes, ANTES de que se escriba la migración real.
- **D-18** necesita la auditoría de roles de lectura/escritura de `asiento_propuesto_renglon` con
  `seguridad-datos-financieros` antes de escribir el trigger.
- **D-23** (calendario de feriados bancarios) es trabajo nuevo y chico para `dba-data`, no bloqueante
  para nada de lo demás.
- Ninguna migración ni línea de código se escribió en esta sesión — es exclusivamente convocatoria de
  decisiones, como pedía la tarea.

> ⚠️ **Implicancia contable y fiscal.** Este documento extiende decisiones de estructura para el cierre
> mensual y de ejercicio, con efecto directo sobre balance. Se apoya en el criterio de `contador-dominio`
> sin cita normativa cargada (`knowledge/` sigue vacío de RT de FACPCE) y en la evidencia ya registrada
> en `23` y en el código real del repo. **Validar con profesional matriculado antes de que esto produzca
> un asiento real.**
