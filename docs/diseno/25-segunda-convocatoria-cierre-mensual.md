---
Segunda convocatoria REAL (Claude Code, agentes de `.claude/agents/` invocados de verdad vía `Agent()`)
sobre los tres puntos que `docs/diseno/24-convocatoria-real-cierre-mensual.md` §9 dejó pendientes:
D-14, D-19, D-16/D-18/D-20. Creado: 2026-08-26, sesión en modo plan (ningún trigger, migración ni
`esquema.ts` tocado). Tres convocatorias: `arquitecto-software` + `product-owner` en llamadas
separadas (D-14, para poder divergir), `seguridad-datos-financieros` (D-19, D-16, D-18, D-20).
---

# Segunda convocatoria real sobre el cierre mensual

> **Cuándo leer este documento**: junto con `23` y `24`, nunca solo. Cierra los tres puntos que `24`
> §9 dejó explícitamente pendientes de una convocatoria real. Las decisiones D-1 a D-23 de `24` siguen
> vigentes; acá se agregan D-24 y D-25, y se resuelven D-14, D-19, D-16, D-18, D-20.

## 0. Nota de proceso

Un agente convocado solo para dar dictamen sobre D-14 (`arquitecto-software`) editó por su cuenta
`docs/diseno/24-convocatoria-real-cierre-mensual.md` — un archivo ya commiteado y aprobado por JP en la
sesión anterior — en vez de devolver su respuesta como texto. Se revirtió (`git checkout`, sin
consecuencia porque el cambio no había llegado a commit) y su contenido, que era sólido, se incorpora
acá, en el documento correcto. El detalle completo del episodio y la corrección aplicada quedan en la
bitácora, no en este documento de diseño.

---

## 1. D-14 — resuelta, convergencia real entre `arquitecto-software` y `product-owner`

Los dos agentes, convocados por separado sobre la misma pregunta sin verse entre sí, llegaron al mismo
punto de aterrizaje por caminos distintos — uno desde la forma técnica, el otro desde prioridad de
producto. Se reconcilian acá.

### La pregunta tenía dos capacidades mezcladas en una — separarlas es lo que las destranca

`product-owner` fue el primero en notar que "confirmar con reserva declarada" mezclaba dos cosas
distintas: (A) una forma de que `cierre_cliente_periodo` llegue a `confirmado` con un pendiente
abierto, y (B) una forma de decir "esta fuente esperada, para este período puntual, se descarta" sin
tocar la expectativa general del cliente (que sigue esperando la fuente los meses siguientes).

- **Capacidad A** (`product-owner`): **puede esperar**, segunda iteración — con el criterio de `23`
  §3.4 aplicado explícito: agregarla después no obliga a re-clasificar ni re-migrar nada, es un valor
  nuevo agregado a una máquina de estados existente.
- **Capacidad B** (`product-owner`): **va al MVP** — sin ella, la única forma de que un cliente con una
  fuente bloqueada cierre algún mes es manipular a mano la configuración general
  (`expectativa_fuente_cliente.confirmada = false`), y eso deja una fila que, leída después, cuenta una
  historia falsa sobre meses donde la fuente sí estaba esperada — mismo patrón que ya costó el
  incidente de `hecho_por` nulo como camuflaje (`23` §2.4, incidente #5).

### `arquitecto-software`: diseñó exactamente la Capacidad B, y descartó la A por motivos estructurales, no solo de timing

**Decisión: ratificar el bloqueo de `cierre_cliente_periodo.estado` (no se toca, sin valor nuevo) y
construir la excepción en `pendiente_cierre`.** Se descarta un valor `confirmado_con_reserva` (o
`confirmado` + satélite a nivel de cierre) por tres motivos:

1. **Diluye para siempre el significado de "confirmado"** — todo consumidor futuro (`balances-normas-
   tecnicas`, informes, exportaciones) tendría que acordarse del segundo valor. Mismo tipo de riesgo
   que `R42` (una coincidencia que pasa el piloto entero y explota con el cuarto cliente).
2. **Cablear lo indeterminado**: para tratar la llegada tardía de BBVA igual sea cual sea el caso, un
   estado a nivel de cierre necesitaría cargar "esto se sabía que iba a faltar" y decidir con esa
   bandera si el camino de reapertura (P3/D-6 de `24`) cambia — pero la materialidad, no si alguien lo
   esperaba, es lo que decide reapertura. La ubicación correcta es la que no toca esa lógica.
3. **Aun bien hecha, termina necesitando la misma lista** de "qué pendiente se excusó, por qué, quién"
   que pide la Capacidad B — solo que colgada del lugar equivocado.

### Mecanismo concreto — **D-24**

- `pendiente_cierre.estado` suma un cuarto valor: **`dispensado`** (junto a `abierto | resuelto |
  superseded`). Distinto de `resuelto` (llegó el documento) y de `superseded` (la fila fue reemplazada
  estructuralmente): dice "alguien decidió, con motivo, seguir sin esto este período".
- Tabla satélite append-only **`pendiente_dispensa`** (mismo idioma que `cierre_transicion`):
  `id`, `cliente_id`, `pendiente_cierre_id`, `motivo` (NOT NULL), `dispensado_por`, `dispensado_en`.
- El gate de confirmación (paso 9, control duro dentro de `conUsuario`, mismo criterio que D-18)
  rechaza la transición a `confirmado` si existe algún `pendiente_cierre` de ese `cierre_id` en
  `abierto` cuyo `motivo` sea de la familia "documento faltante" con `expectativa_fuente_cliente.
  confirmada = true`. `dispensado` no bloquea.
- `expectativa_fuente_cliente.vigencia_hasta` **no es el lugar** — responde "¿el cliente todavía tiene
  esta fuente, en general?" (alimenta D-5d), no "¿este mes puntual se cierra sin ella?". Sobrecargarla
  convertiría una tabla pensada para tocarse poco en una que hay que abrir y cerrar todos los meses.
- La llegada tardía de la fuente, después de confirmar, sigue el camino único ya diseñado en P3/D-6
  (materialidad decide reapertura o imputación en el período siguiente) — **sin rama especial** por
  haber sido dispensada. Es justo el punto que descartó la Alternativa A: un solo camino de reapertura.
- **Caso intermedio, declarado explícito para que no quede implícito** (aclaración de JP al revisar):
  `expectativa_fuente_cliente.confirmada` es `boolean NOT NULL` — el esquema no tiene un tercer valor.
  Pero conceptualmente sí hay un tercer caso, que D-5d ya reconoce como real: una expectativa recién
  inferida que el contador todavía no ratificó ni descartó. Por la misma convención que ya fija D-5d
  (*"el silencio en las filas de confianza alta es la aprobación... no se le pide confirmar cada
  una"*), el valor por defecto de una expectativa recién inferida es `confirmada = true` — así que, a
  los efectos del gate, **el caso intermedio se comporta exactamente igual que `confirmada = true`
  explícito: bloquea**. No hay un tercer camino en el gate en sí. La única forma de que un pendiente de
  esa fuente NO bloquee es (a) dispensar el `pendiente_cierre` puntual para ese período — el camino
  normal de D-24 — o (b) que un humano baje `confirmada` a `false` para esa expectativa en general, lo
  cual es una decisión más amplia y duradera ("este cliente no tiene esta fuente"), no algo que
  corresponda inferir en silencio ni algo que el gate deba decidir por su cuenta.

### Contra HYJ, paso a paso

Pendiente de BBVA `abierto` → intento de confirmar julio rechazado, con el pendiente concreto nombrado
→ Laura dispensa con motivo declarado (fila en `pendiente_dispensa`, `pendiente_cierre.estado =
'dispensado'`) → reintento de confirmar procede normal, `cierre_cliente_periodo.estado` nunca tuvo un
valor especial → semanas después BBVA se destraba: es el caso P3 ya diseñado, sin excepción por haber
sido dispensado.

### El único punto sin cerrar del todo — framing, no sustancia

`product-owner` dejó la Capacidad A como "segunda iteración, revisar si hace falta más adelante";
`arquitecto-software` la trata como estructuralmente incorrecta, no solo de baja prioridad — el diseño
de D-24 hace que "¿este cierre se confirmó con algo dispensado?" sea una consulta (`pendiente_cierre`
con `estado = 'dispensado'` para ese `cierre_id`), no un dato guardado aparte, lo cual **ya resuelve**
la necesidad de visibilidad que motivaría la Capacidad A. Los dos coincidieron, sin verse, en el mismo
trade-off (`product-owner`: *"es una pérdida de visibilidad, no de control... documentado para que no
vuelva como sorpresa"*) — la diferencia es solo si eso se documenta como "no construir nunca" o como
"no construir por ahora, con la puerta abierta". No cambia nada de D-24. No requiere otra ronda.

Un punto real que `arquitecto-software` declaró explícito y `product-owner` no llegó a evaluar: si
dispensar necesita un criterio de negocio adicional (ej. un tope de materialidad automático, no solo
motivo a mano) — eso **no cambiaría el mecanismo de D-24**, se agregaría como regla que precede a la
dispensa manual. No bloquea nada hoy.

**D-14: RESUELTA.** Forma concreta en D-24. Sigue pendiente, como con cualquier tabla nueva con
`cliente_id`, la convocatoria completa `dba-data` + `security-engineer` + `seguridad-datos-financieros`
antes de escribir la migración de `pendiente_dispensa` (CLAUDE.md §3.1) — eso no bloquea la decisión de
diseño, la ejecuta cuando llegue el momento de Capa D / paso 9.

---

## 2. D-19 — resuelta, y NO es un solo nivel para las tres columnas

`seguridad-datos-financieros` no adoptó ninguna de las dos posturas previas (`arquitecto-software`: N1
las tres; `dba-data`: N2 las tres) — resolvió mirando un precedente que ninguno de los dos citó:
`reconocimiento_movimiento.clase`/`.es_propuesta` (N1, *"vocabulario de proceso: qué trabajo le queda a
la persona"*) y `.que_decide` (N1, *"vocabulario cerrado sobre qué falta decidir"* — precursor directo
de `pendiente_cierre.motivo`), contra `cuenta_bancaria.abierta_desde`/`cerrada_en` y `lote_ingesta_
cuenta.periodo_desde`/`periodo_hasta` (N2 — el borde temporal revela algo del VÍNCULO del cliente).

**Regla que separa las tres, por alcance (scope), no por compartir el nombre `estado`:**

| Columna | Nivel | Por qué |
|---|---|---|
| `asiento_estado` | **N1** | Marcador de workflow sobre UN renglón/asiento puntual, misma familia que `clase`/`es_propuesta`. Loguear `{asiento_id, asiento_estado}` no revela monto ni cuenta — eso vive en `total_debe`/`total_haber`, columnas distintas, N2 |
| `pendiente_estado` | **N1** | Misma familia que `que_decide`: "qué trabajo queda" sobre un ítem puntual de la cola, no un juicio sobre el cliente |
| `cierre_estado` | **N2** | No es puntual: es el estado AGREGADO de todo un período de UN cliente. "HYJ tiene un cierre en `en_revision` hace 3 meses" es la misma clase de hecho que ya justificó N2 para `periodo_desde/hasta` — información real sobre la puntualidad contable de ESE cliente, no "en qué paso del pipeline está un documento" |

**Por qué la analogía con `lote_ingesta.estado` (que motivó la postura N1 de `arquitecto-software`) no
alcanza**: `lote_ingesta.estado` describe el pipeline técnico de UN archivo — nunca agrega la situación
del cliente. `cierre_estado`, acumulado mes a mes, sí. Bajarlo a N1 por compartir nombre con
`lote_ingesta.estado` sería el mismo error simétrico que el registro ya evitó una vez del otro lado
(`resolucion_estado`, para no tapar la N1 de `lote_ingesta.estado`).

El renombre a `<tabla>_estado` (ya no negociable desde `24`) sigue aplicando a las tres, aunque
`asiento_estado`/`pendiente_estado` terminen compartiendo nivel entre sí.

**D-19: RESUELTA.** `cierre_estado` = N2, `asiento_estado` = N1, `pendiente_estado` = N1.

---

## 3. D-16 — ratificada, con una recomendación estructural nueva que abre D-25

**N2 ratificado sin cambios**, con el mismo argumento que ya tenía `plan-cuentas-multicliente`:
`padron_socio.denominacion` (0013) ya guarda el nombre real de un socio en texto libre a N2, con un
check que **no bloquea nombres** — solo corridas de 7+ dígitos (documento/CUIT/CBU). `cuenta_atributo.
denominacion` con "Cuenta particular - Juan Pérez" es el mismo riesgo, al mismo nivel, ya aceptado una
vez.

**Hallazgo nuevo**: el check de dígitos no protege lo que este caso necesita — el dato sensible acá es
el NOMBRE, y no existe un `CHECK` regex razonable que bloquee nombres de persona sin falsos positivos
masivos. La única defensa estructural real es no guardar la relación societaria dos veces:
`cuenta_atributo` debería sumar `padron_socio_id uuid NULL`, con `CHECK` condicional (`NOT NULL` cuando
`rol_funcional = 'cuenta_particular_socio'`, `NULL` en cualquier otro caso) — mismo principio que ya usa
`asiento_propuesto_renglon.padron_manifestacion_id` en `23` §2.1 ("la cuenta se resuelve por rol
funcional contra `cuenta_id` interno, nunca por código literal"). `denominacion` queda como etiqueta de
display, deja de ser la única fuente de la relación.

**Por qué ahora y no después**: `cuenta_atributo` (D-15) todavía no tiene una sola fila real —
agregarlo hoy es gratis; retrofitearlo después significa migración + backfill intentando matchear texto
libre contra `padron_socio.denominacion` por similaridad, exactamente el tipo de trabajo sucio que el
proyecto ya evita en otros lados (mismo argumento de D-10 sobre congelar el contrato tras el primer
adapter, no el cuarto).

**No decidido acá, a propósito**: si Laura necesita que la etiqueta mostrada difiera del nombre del
socio (alias, abreviatura) y si eso justifica que `denominacion` siga editable independiente del FK —
terreno de `plan-cuentas-multicliente` + `contador-dominio`.

**D-16: RESUELTA en su alcance original (N2 ratificado). Abre D-25** (ver tabla), que necesita una
decisión corta de `plan-cuentas-multicliente` + `dba-data` — sobre si adoptan `padron_socio_id` — antes
de escribir específicamente la migración de `cuenta_atributo`. No bloquea nada más del diseño.

---

## 4. D-18 — resuelta: roles SIMÉTRICOS, no asimétricos, con una condición explícita

`dba-data` había señalado el riesgo citando `padron_socio_documento` (roles asimétricos) como
precedente. `seguridad-datos-financieros` verificó que ese no es el precedente correcto: comparó contra
`reconocimiento_contrapartida` (0021), que **ya carga `padron_manifestacion_id`** — el mismo tipo de
campo que se propone para `asiento_propuesto_renglon` — y es **simétrica** (SELECT sin chequeo de rol,
INSERT = `socio, contador, administrativo`). El comentario de esa migración lo fija explícito: el
padrón entra como **FK a la manifestación, nunca como el documento en claro** — eso es lo que la
mantiene fuera de `tablasQueExigenRolEnLectura()`. `padron_socio_documento` es asimétrica *porque* guarda
el documento N2-R en claro; `reconocimiento_contrapartida` no lo hace y por eso no lo es.

`asiento_propuesto_renglon` cae del lado de `reconocimiento_contrapartida`: `padron_manifestacion_id`
es un UUID que referencia la premisa, no el documento. Mientras eso se mantenga (y mientras
`cuenta_ref`/D-16 no lleven un documento en claro), la tabla no tiene ninguna columna que amerite N2-R,
y no hay motivo estructural para roles asimétricos.

**Decisión**: roles **simétricos** — el mismo conjunto que inserta un renglón puede leer el 100% de los
renglones del asiento al que pertenece. Esto es lo que hace seguro, por construcción, el trigger de
`debe = haber` que `arquitecto-software` ya diseñó en `24` §3/D-18: quien inserta, ve.

**Condición explícita, no implícita** — mismo criterio que ya evitó el problema de `confirmado_por`:
dejar un comentario de tabla, mismo estilo que `0021:835-839`, que diga que esta tabla **no tiene
columnas N2-R a propósito**, y que si algún día se necesita guardar ahí un documento en claro de un
tercero (no una referencia), la tabla entra en `tablasQueExigenRolEnLectura()` y **hay que
re-simetrizar** los roles — no agregar la columna sin volver a esta decisión.

**Prueba de mutación** (ya pedida por `dba-data`, ahora con el caso concreto que la completa): insertar
y recalcular con el rol de escritura menos privilegiado, más un caso explícito que verifique que NINGÚN
rol puede insertar sin poder leer el total — eso es lo que refuta la asimetría, no solo confirma
`debe=haber`.

**D-18: RESUELTA.** Simétrica, con guardrail de comentario. No necesita otra ronda salvo que en el
futuro se decida meter un dato N2-R real en la tabla.

---

## 5. D-20 — ratificada, con la forma concreta del control que faltaba

**N2 por defecto, ratificado.** El riesgo (`ConfianzaDeCampo.valorLeido` colándose desde una liquidación
OCR) ya estaba anticipado en el propio registro — `clasificacion-campos.ts` tiene un comentario 🔴
escrito ANTES de que el tipo existiera, anticipando exactamente este escenario (*"es exactamente el
momento en que un `logger.info(...)` de depuración saca ese dato"*).

**Forma concreta del control que permitiría bajarlo a N1** (mismo nivel de detalle que
`anexo_literal_sin_identificador_chk`, sin escribir el `CHECK` real): como es `jsonb`, el equivalente de
la puerta de admisión por forma no es un regex de dígitos — es un **allowlist de claves + vocabulario
cerrado por valor**, en dos capas:

1. **Estructural (CHECK en la base)**: el objeto solo admite un conjunto fijo y chico de claves
   (`estado`, `referencia_documento_id`, `referencia_linea`, `motivo`, `aproximada`,
   `fecha_referencia` — lista exacta a fijar en la implementación), con resta de claves permitidas
   contra el objeto real exigiendo que lo que sobra sea vacío. **No alcanza solo con las claves**: cada
   valor tiene que estar restringido también (`estado` a vocabulario cerrado, `motivo` a vocabulario
   cerrado — nunca texto libre), porque una clave permitida con valor de texto libre reabre el mismo
   hueco por otra puerta.
2. **Aplicación (Zod espejo en el límite de escritura)**: mismo esquema cerrado, primera línea de
   defensa, no la garantía — mismo criterio que ya usa el proyecto en todos lados.

Advertencia explícita, mismo criterio que `reconocimiento_entrada_lexico_chk`: un `CHECK` de forma
verifica ESTRUCTURA, nunca que `referencia_documento_id` apunte a un documento real de ESE cliente —
eso lo cierra la FK, no el `CHECK`. No confundir "cerré la forma" con "cerré la pertenencia".

**Alcance normativo declarado**: esta es clasificación de dato interno (diseño de esquema), no un
dictamen sobre la Ley de Protección de Datos Personales (25.326) ni el secreto fiscal de la Ley 11.683
— `knowledge/` sigue sin ninguna fuente cargada sobre esas normas, verificado. Si en algún momento hace
falta fundamentar D-16/D-20 contra esa normativa específica, no hay fuente cargada todavía.

**D-20: RESUELTA.** N2 ratificado, forma del control descripta arriba, queda para `dba-data`/
`backend-dev` escribirla cuando se implemente Capa D.

---

## 6. Tabla de decisiones — estado final de esta ronda

| # | Decisión | Estado |
|---|---|---|
| D-14 | Vía de excepción para confirmar con fuente esperada bloqueada | 🟢 **RESUELTA** — se ratifica el bloqueo de `cierre_cliente_periodo.estado` (sin valor nuevo); la excepción vive en `pendiente_cierre` (D-24) |
| D-19 | Nivel de `cierre_estado`/`asiento_estado`/`pendiente_estado` | 🟢 **RESUELTA** — no uniforme: `cierre_estado`=N2, `asiento_estado`=N1, `pendiente_estado`=N1, por alcance (agregado de cliente vs. marcador puntual) |
| D-16 | Clasificación de `cuenta_atributo.denominacion` con nombre de socio | 🟢 **RESUELTA en su alcance original** (N2 ratificado). Abre D-25 (recomendación estructural nueva, no bloqueante) |
| D-18 | Roles de lectura/escritura de `asiento_propuesto_renglon` | 🟢 **RESUELTA** — simétricos, condición explícita: sin columnas N2-R, con guardrail de comentario si eso cambia |
| D-20 | Clasificación de `verificacion_heredada` | 🟢 **RESUELTA** — N2 por defecto, forma del control (allowlist de claves + vocabulario cerrado + Zod espejo) descripta |
| D-24 | **Nueva.** `pendiente_cierre.estado` suma `dispensado`; tabla satélite `pendiente_dispensa` (motivo NOT NULL, `dispensado_por`, `dispensado_en`); gate de confirmación rechaza si hay `abierto` de fuente esperada-confirmada, `dispensado` no bloquea. `cierre_cliente_periodo.estado` no cambia. Caso intermedio (expectativa inferida, sin ratificar) se trata como `confirmada = true` por defecto — bloquea igual, mismo criterio de D-5d | `arquitecto-software`, D-14 |
| D-25 | 🟡 **Propuesta, no decidida — sigue abierta, no bloqueante**: `cuenta_atributo.padron_socio_id` (FK condicional, NOT NULL cuando `rol_funcional='cuenta_particular_socio'`) en vez de depender solo de `denominacion` en texto libre. Necesita decisión de `plan-cuentas-multicliente` + `dba-data` antes de escribir la migración de `cuenta_atributo` (D-15) | `seguridad-datos-financieros`, D-16 |

Ninguna decisión de D-1 a D-23 (`23`/`24`) se revierte. D-19 reemplaza las dos posturas divergentes
declaradas en `24` §4 por una resolución con criterio propio, no elegida por quien conduce.

---

## 7. Qué queda para la etapa de migración

**De los tres puntos que `24` §9 dejó pendientes, los tres cerraron.** No hay ninguna divergencia sin
resolver forzada a un lado — donde había dos posturas (D-19), se resolvió con un precedente que ninguna
de las dos había mirado; donde había convergencia con matices (D-14), se documentó el matiz sin que
bloquee nada.

**Un solo punto chico sigue abierto (D-25)**, y es acotado: no bloquea `documento_ingerido`, no bloquea
`cierre_cliente_periodo`/`pendiente_cierre`/D-24, no bloquea el trigger de `debe=haber` (D-18 ya cerró
esa condición). Bloquea únicamente la migración específica de `cuenta_atributo` (D-15) — se puede
avanzar con el resto del diseño en paralelo.

**Antes de escribir cualquier migración real**, sigue rigiendo sin excepción la matriz de `agents/
README.md` §3.1: toda tabla nueva (`documento_ingerido`, `cierre_cliente_periodo`,
`expectativa_fuente_cliente`, `fuente_cierre`, `pendiente_cierre` + `pendiente_dispensa`,
`asiento_propuesto` + `asiento_propuesto_renglon`, `cierre_transicion`, `cuenta` + `cuenta_atributo`)
necesita su propia convocatoria de `dba-data` + `security-engineer` + `seguridad-datos-financieros` —
las decisiones de clasificación de esta ronda (D-16, D-18, D-19, D-20) son la entrada a esa
convocatoria, no un sustituto de ella. Y `CLAUDE.md` §1.9 sigue rigiendo completo para cualquier cosa
que toque el piloto real.

Con eso: **esta es la primera vez que el diseño del cierre mensual queda sin una decisión de arquitectura
pendiente.** Lo que sigue es trabajo de implementación (Capa D, paso 9, las tablas), no más rondas de
convocatoria de diseño — salvo D-25, acotado, y las convocatorias de ejecución que cada migración real
exige por norma del proyecto.

> ⚠️ **Implicancia contable y fiscal.** Este documento cierra decisiones de estructura con efecto
> directo sobre balance y sobre exposición de datos de terceros. `knowledge/` sigue sin RT de FACPCE ni
> normativa de protección de datos cargada. **Validar con profesional matriculado antes de que esto
> produzca un asiento real o antes de exponer datos de socios fuera del estudio.**
