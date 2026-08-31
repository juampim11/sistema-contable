---
Convocatoria de diseño real (no simulada) — 2026-08-31, sesión de re-entrada tras el cierre de
Sesión 2a (`HANDOFF.md` 141, `27-roadmap-capa-d.md`). Objetivo: primera versión de diseño de
`motor-conciliacion-contable` — cómo un `movimiento_bancario_crudo` ya clasificado por Capa C se
traduce en `cuenta_id` + `debe`/`haber`. **Modo plan, cero código.** Precedida por 3 agentes
`Explore` (solo lectura, estado real del esquema/Capa C/caso H y J) y convocatoria real a 4 agentes:
`contador-dominio`, `motor-conciliacion-contable`, `plan-cuentas-multicliente`, `qa-funcional` —
cada uno solo-lectura, sin escritura de archivos. Sus dictámenes completos quedaron en la sesión que
produjo este documento; acá se sintetizan.

**Actualización 2026-08-31 (sesión de re-entrada, misma fecha):** ronda de cierre real de D-29
(§2), convocatoria a `contador-dominio` + `plan-cuentas-multicliente` + `dba-data`, cada uno viendo
la respuesta de los otros dos antes de responder. Modo plan, cero código, cero DDL. D-29 cerrada con
acuerdo real — ver §2 y `HANDOFF.md`.
---

# 28 — Diseño del motor de clasificación (Sesión 2b) — primera convocatoria real

> **Cuándo leer este documento**: antes de escribir una sola línea de código de
> `motor-conciliacion-contable`. Es el punto de partida de la Sesión 2b de
> `27-roadmap-capa-d.md` ("primera clasificación", hasta acá no empezada).
>
> **Qué NO es este documento**: no es una migración, no es una tabla de imputación diseñada en
> detalle, no es una decisión cerrada donde los agentes convocados no coincidieron. Donde hay
> divergencia real entre agentes, queda escrita como divergencia — no se fuerza consenso.

---

## 0. Hallazgos base, verificados antes de convocar (no supuestos)

- **Caso de mano — H y J Servicios y Obras S.A.S.**: tenant `26e90bbb-991c-4d3b-9ab8-799aaea1a8e3`,
  1 movimiento real, banco Nación, ya en `documento_ingerido` (id `3bdbbb3a-960c-4e20-bb06-
  3207055389d2`, período `2026-05-29`/`2026-06-30`, cobertura `completo`). **Capa C todavía no
  clasificó ese movimiento** — hoy hay **0 filas en `reconocimiento_movimiento` en todo el
  proyecto**, local y piloto, no es un problema específico de H y J. **H y J no tiene plan de
  cuentas cargado** — a diferencia de Bracci (227 cuentas) y ROKA (219), ambos ya reales en el
  piloto (`27-roadmap-capa-d.md` §B.2).
- **Corrección de premisa, encontrada por dos agentes de forma independiente** (`motor-conciliacion-
  contable` y `qa-funcional`, sin coordinación entre ellos, cada uno auditando el esquema por su
  cuenta): `pendiente_cierre.motivo_codigo` tiene **hoy 2 valores** (`documento_faltante`,
  `cotizacion_no_disponible`), no 8 como asumía la convocatoria al arrancar. El "8" es `QUE_DECIDE`,
  el enum de Capa B/C (`packages/contabilidad/src/nucleo/tipos.ts`) — un dominio de esquema
  **distinto**, sin relación estructural con `pendiente_cierre`. Queda corregido acá.
- **Esquema de Capa D (migraciones `0027`/`0028`/`0029`) ya aplicado, cero código de aplicación**
  sobre `pendiente_cierre`, `asiento_propuesto`, `asiento_propuesto_renglon`,
  `cierre_cliente_periodo`, `fuente_cierre`. El único código real de Capa D hoy es
  `altaPlanDeCuentas` y `backfillDocumentoIngerido` (`packages/data/src/cierre/escrituras.ts`).
- **Capa C (`Reconocimiento`, `packages/contabilidad`) nunca resuelve `cuenta_id`.** Su salida es
  `{clase: propuesta|decision_humana|sin_reconocer, tipo: TipoMovimiento (31 valores cerrados),
  concepto, polaridad, lado, via: ViaEvidencia (6 valores, SIN score numérico — "la confianza ES la
  vía, sin score inventado", decisión de diseño ya tomada), evidencia}`.
- **`cuenta_atributo.rol_funcional`** es hoy un catálogo de **4 valores** (`generica`,
  `cuenta_particular_socio`, `aporte_de_socio`, `retiro_de_socio`), marcado explícitamente
  **PROVISIONAL** en el comentario de la migración `0027` — pendiente de que `contador-dominio` lo
  cierre. Sin relación estructural hoy con `tipo_movimiento`.
- **Hallazgo nuevo de esta convocatoria, no documentado antes**: `documento_ingerido`/`fuente_cierre`
  no tienen FK física hacia `lote_ingesta`/`movimiento_bancario_crudo` — solo
  `objeto_almacenamiento` como string igual a `lote_ingesta.archivo_clave`. Es un gap de esquema
  real que el motor va a pisar apenas se escriba código (ver D-27).

---

## 1. Pregunta 1 — camino completo desde `Reconocimiento` hasta `cuenta_id`, con H y J

La cadena física real, verificada:

```
movimiento_bancario_crudo (Capa 1)
      │  movimiento_id (FK)
      ▼
reconocimiento_movimiento (Capa B/C, YA PERSISTIDO en esquema, 0 filas hoy)
      │
      │   ⚠️ SIN enganche físico hacia acá ⚠️
      ▼
documento_ingerido → fuente_cierre → pendiente_cierre / asiento_propuesto_renglon
```

**Qué falta, exactamente:**

1. **El importe, la fecha y la descripción del movimiento NO viajan en `Reconocimiento`** ni en su
   entrada (`EvidenciaDeMovimiento`) — es una regla de diseño ya tomada (`04-imputacion-contable.md`
   §3), no una omisión. Viven en `movimiento_bancario_crudo`. Conclusión: el **servicio de I/O** de
   Capa D (nunca el motor puro) tiene que hacer el JOIN explícito
   `reconocimiento_movimiento.movimiento_id → movimiento_bancario_crudo` para tener esos datos.
2. **El enganche `documento_ingerido`/`fuente_cierre` ↔ `movimiento_bancario_crudo` no es una FK**,
   es una correspondencia por rango: `(cliente_id, cuenta_bancaria_id, fecha entre periodo_desde y
   periodo_hasta)`. Una reingesta o un documento con período solapado podría romper esa
   correspondencia en silencio — hoy no hay guardia contra eso (ver D-27).
3. **Para H y J específicamente, ninguna de las dos piezas existe**: ni el `Reconocimiento` de Capa C
   (nunca corrió), ni el plan de cuentas (nunca se cargó). Son dos bloqueos de **datos**, no de
   mecanismo — el mecanismo en sí no está probado como roto, está simplemente sin insumos.

---

## 2. Pregunta 2 — dónde vive la regla `tipo_movimiento → cuenta_id`

**D-29 — CERRADA (2026-08-31), ronda de cierre real con `contador-dominio` + `plan-cuentas-
multicliente` + `dba-data`, cada uno respondiendo habiendo visto la posición de los otros dos.**
Reemplaza la divergencia sin resolver que dejó la primera convocatoria (Sesión 2b, más abajo se
conserva el historial). Acuerdo real de los tres — `plan-cuentas-multicliente` concedió de forma
explícita, no forzada.

### Decisión final

`rol_funcional` **se queda tal como está** (4 valores, marca **identidad societaria** únicamente —
nunca "para qué sirve la cuenta en general" ni "a qué cuenta imputar tal concepto"). La resolución
`tipo_movimiento → cuenta_id` se separa en dos piezas nuevas:

1. **Pata "banco"**: `cuenta_bancaria_id → cuenta_id`, mapeo fijo 1:1 por cliente. Resuelve la mitad
   de cada asiento, para los 31 tipos, de una sola vez.
2. **Pata "contrapartida"**: tabla nueva de reglas de imputación **por cliente**, clave
   `(cliente_id, tipo_movimiento[, concepto], vigencia) → cuenta_id`. Retoma el diseño de
   `04-imputacion-contable.md` §8 (N2 por cliente, versionada, con `cuentaResolucion: 'fija' |
   'por_socio' | 'por_jurisdiccion' | 'por_impuesto'`), nunca reconciliado con `23`/`27` hasta esta
   convocatoria. La rama `'por_socio'` delega en `cuenta_atributo.rol_funcional` + `padron_socio_id`
   + `ResolucionDeContraparte` (ya la produce Capa C) — solo para los tipos ligados a un socio
   puntual, **resolviendo el `rol_funcional` vigente a la fecha del movimiento**, no el rol actual
   (condición de cierre de `plan-cuentas-multicliente`, sin verificar explícitamente en ninguna
   respuesta anterior — queda anotada acá para que `dba-data` no la pase por alto al migrar).

**Regla operativa para trazar la línea, hacia el próximo concepto que aparezca** (criterio de
`dba-data`, ratificado sin reservas por `contador-dominio` y por `plan-cuentas-multicliente` en su
concesión): un valor va a `rol_funcional` únicamente si **(i)** el conjunto de valores posibles lo
define el **producto**, no el plan de un cliente puntual, y **(ii)** dispara una regla de negocio
**transversal a todo el sistema** (como el veto duro de auto-resolución + el veto de exposición de la
familia socio en `exportar-planilla.ts:84-90`) — no solo "resuelve a qué cuenta imputar". Si hace
falta mirar el plan de UN cliente para decidir el nombre o la cantidad de valores, es dato de cliente
→ va a la tabla, nunca al enum.

**Gobernanza de la tabla nueva** (condición de cierre de `contador-dominio`, avalada por
`plan-cuentas-multicliente`): mismo control de acceso que `cuenta`/`cuenta_atributo`
(`0027_cierre_mensual.sql:88-91,192-193`) — escritura restringida a `socio`/`contador`, nunca
`administrativo`. Decidir a qué cuenta imputa un tipo de movimiento es la misma clase de decisión
contable que renombrar o reclasificar una cuenta, no una carga administrativa.

**Disciplina de la tabla nueva** (condiciones de cierre de `plan-cuentas-multicliente`, sin
objeción de los otros dos):

- Misma disciplina de vigencia que `cuenta_atributo` — `desde`/`hasta` + respaldo del cambio, nunca
  un valor pisado en su lugar.
- **No reescribe historia**: un cambio posterior en la regla de imputación nunca altera a qué
  `cuenta_id` apuntan los `asiento_propuesto_renglon` ya generados con la regla vigente al momento de
  generarse.

### Por qué cerró así — el argumento que de verdad lo decidió

El dato empírico que motivó esta ronda (verificado contra el archivo real,
`Plan de cuentas ROKA REPUESTOS SAS.xlsx`, corriendo `packages/ingesta/src/plan-cuentas/parser.ts`
sin CLI intermedia): ROKA (multi-banco, 3 cuentas Macro — cta cte, cta cte especial, cta en dólares)
tiene **una sola** cuenta `4.2.5.200 "Gastos y comisiones bancarias"` para las tres — la duda que la
Posición B original había dejado abierta (¿"comisión bancaria" es 1 cuenta por cliente o depende de
la cuenta de origen?) se resuelve a favor de la Posición B: **no depende del origen**, al menos en
este cliente. (Cuentas relacionadas pero distintas del mismo archivo, para que no se confundan:
`4.2.3.310 "Impuesto al Débito Bancario"`, `4.2.4.500 "Comisiones Tarjetas de Crédito"`,
`4.2.4.510 "Comisiones sobre ventas"`.)

Ese dato **no fue lo que cerró la decisión** — la propia `plan-cuentas-multicliente` lo señala en su
concesión: si esa hubiera sido la única objeción en juego, su posición seguiría de pie. Lo que la
hizo ceder fue un argumento estructural, independiente del dato de ROKA:

- `cuenta_atributo.rol_funcional` es `text not null`, **una fila = un rol** — una relación 1:1 entre
  cuenta y concepto (reforzada por el propio `CHECK (cliente_id, rol_funcional)` único por vigencia
  que la Posición B original proponía sumar).
- El problema real, `tipo_movimiento → cuenta_id`, tiene **31 valores cerrados de `tipo_movimiento`**
  que no tienen por qué alinearse 1:1 con la granularidad de cuentas de cada plan — es una relación
  **N:1** (varios tipos pueden converger en una cuenta; un cliente puede querer separar mañana lo que
  hoy comparte cuenta). Una columna 1:1 no puede expresarlo sin inflar el enum con variantes que no
  son roles societarios reales — el mismo riesgo de "hornear variantes" que `04-imputacion-contable.md`
  §8 ya advertía, y que la Posición B terminaba reproduciendo por otra vía.
- **Evidencia real de cómo trabaja Laura** (`contador-dominio`, no inventada): `HANDOFF.md:5991` — no
  se le re-pregunta la cuenta destino una vez que respondió, la respuesta "queda vigente" y se reusa
  hacia adelante. Ella no piensa "esta cuenta ES la cuenta de comisión" como propiedad fija de la
  cuenta — **resuelve movimiento por movimiento**, con memoria de decisiones anteriores. Eso es la
  forma de una tabla de reglas versionada, no la de un atributo 1:1 del plan de cuentas.
- El propio patrón del repo lo confirma (`dba-data`): `banco` (tabla) absorbió 3 altas de banco
  (`0024`/`0025`/`0026`) sin tocar nunca un `CHECK` ni un enum TS, puro `insert ... on conflict`; en
  cambio `pendiente_cierre.motivo_codigo` (`CHECK`, nació con 2 valores en `0027`) ya quedó anotado
  para su primera reapertura por migración (D-28) a las dos sesiones de nacer, y el propio comentario
  de `0027` sobre `rol_funcional` ya asumía que se reabriría — cero veces en este repo un catálogo
  cerrado con `CHECK` absorbió una necesidad de dato-por-cliente sin volver a una migración.

### Punto de acuerdo real, ya sentado antes de esta ronda y sin reabrir

Para `tipo_movimiento` de **cardinalidad abierta** (`pago_a_proveedor_transferencia`,
`cobranza_de_cliente` — N cuentas candidatas posibles, no una), **ningún mapeo estático cierra el
caso**: hace falta evidencia de Capa C + propuesta del motor + confirmación del contador. Coinciden
los tres agentes de la ronda de cierre y los de la convocatoria original.

---

## 3. Pregunta 3 — criterio en números: automático vs. `pendiente_cierre`

De `qa-funcional`, sin score numérico inventado (respetando la decisión de diseño ya tomada en Capa
C: "la confianza ES la vía"):

```
automático  ⟺  clase = 'propuesta'
             ∧  via ∈ {codigo_y_texto_concordantes, codigo_concepto,
                        texto_literal_exacto, texto_prefijo_unico}
             ∧  resolución de cuenta con EXACTAMENTE 1 candidata
             ∧  rol_funcional resultante ∉ {retiro_de_socio, aporte_de_socio,
                                              cuenta_particular_socio}

pendiente_cierre  en cualquier otro caso, con motivo_codigo nuevo:
  - 'cuenta_no_configurada'  si hay 0 candidatas
  - 'cuenta_ambigua'         si hay más de 1 candidata
```

**La excepción de la familia socio es dura**: nunca auto-resuelve, aunque haya exactamente 1
candidata perfecta — mismo criterio que ya aplicó `seguridad-datos-financieros` al vetar la
exposición de `retiro_de_socio`/`aporte_de_socio` fila por fila en el export enriquecido
(`packages/ingesta/src/planilla/exportar-planilla.ts:84-90`). Resolver la cuenta automáticamente acá
es la misma afirmación de relación societaria, un paso más adelante en el pipeline.

**Con H y J**: el % no es un criterio útil sobre este caso — `N=1` es degenerado (solo puede dar 0%
o 100%, y da 100% por construcción, no por calidad del criterio: no hay plan de cuentas, así que
"0 candidatas" está garantizado sin necesidad de correr nada). **El número de aceptación de la
Sesión 2b se mide sobre el corpus de Bracci** (plan de cuentas real ya cargado), no sobre H y J.

---

## 4. Pregunta 4 — dónde se registra el resultado

**No hace falta tabla nueva para el camino feliz.** `asiento_propuesto_renglon` (estado `propuesto`)
ya es la propuesta automática a revisión: nace `propuesto`, nunca se autoconfirma por diseño de RLS,
es auditable (`cuenta_ref` cita el plan vigente, `verificacion_heredada` trae la trazabilidad),
write-once (corregir es superseder el `asiento_propuesto` entero).

**Sí falta algo, chico, para lo que no se resuelve solo**: una columna `evidencia jsonb` en
`pendiente_cierre` (mismo patrón de allowlist + vocabulario cerrado que ya usa
`verificacion_heredada`) — hoy `pendiente_cierre` no tiene ningún campo de evidencia estructurada.
`reconocimiento_candidato` (migración `0014`) ya cubre la evidencia de ambigüedad de **Capa C**, no
se duplica; lo que falta es el motivo por el que **Capa D** no pudo resolver la cuenta, que es un
problema distinto y sin lugar hoy.

No se diseña el DDL acá — es tarea de `dba-data` en la sesión de código, con la migración de D-28.

---

## 5. Pregunta 5 — ejercicio de mano con H y J: BLOQUEADO

**Resultado unánime entre los 4 agentes convocados: no se puede ejecutar el ejercicio hoy.** Dos
bloqueos independientes, confirmados por triangulación:

1. **Capa C no clasificó el movimiento** — 0 filas en `reconocimiento_movimiento` en todo el
   proyecto (local y piloto), no es específico de H y J pero sí lo alcanza igual que a cualquier
   otro movimiento real hoy.
2. **H y J no tiene plan de cuentas cargado** — 0 filas en `cuenta`/`cuenta_atributo` para su tenant.
   `plan-cuentas-multicliente` verificó por grep que no hay ninguna mención de un plan de cuentas de
   H y J en `HANDOFF.md` ni en `docs/diseno/*.md`, y **no pudo determinar si es un bloqueo de datos
   (falta el archivo) o de proceso** (el archivo existe y nadie corrió `alta-plan-cuentas`) sin
   inventar la respuesta. Queda como **pregunta directa a JP**, no como supuesto.

**Lo único que sí se puede afirmar, sin correr nada**: si el mecanismo completo existiera hoy, el
resultado determinístico esperado sería que **el 100% de los movimientos de H y J caen a
`pendiente_cierre`** (motivo nuevo, algo como `cliente_sin_plan_de_cuentas`) — es el comportamiento
**correcto** de un sistema asistido frente a datos incompletos, no una falla del motor.

### Recomendación sobre el caso de mano de la Sesión 2b de código (con la salvedad de D-12)

Dado que H y J está bloqueado, la recomendación es usar **Bracci** como caso de mano de la próxima
sesión de código real, por ser el único cliente con plan de cuentas cargado y con Capa C corrible
hoy sobre datos reales.

**Pero eso es un punto de partida, no el caso de validación completo del motor** — con la salvedad
explícita de **D-12** (`23-arquitectura-cierre-mensual.md`: *"el caso de trabajo del diseño = ROKA +
H y J, nunca Bracci"*), fundada en que un diseño multi-fuente validado solo contra Bracci —un
cliente de una sola fuente— pasa el piloto entero en verde y explota con el primer caso real
multi-fuente, el mismo patrón que ya costó la trampa de `R42` (`10-deuda-declarada.md` §1). **ROKA
(multi-fuente: 3 cuentas Macro + FCI) sigue siendo necesario antes de dar el motor por probado de
verdad.** El orden ya lo fija `27-roadmap-capa-d.md` §B.5 — *"Bracci valida el mecanismo. ROKA valida
que el mecanismo no se rompe con más de una fuente"* — y esta convocatoria no lo cambia: lo ratifica,
con el hallazgo adicional de que Bracci es además hoy el único cliente con datos suficientes para
arrancar el circuito de punta a punta.

---

## 6. Decisiones — D-26 a D-33

Continúa la numeración de `23`/`24`/`25`/`26`, que llega hasta D-25. Ninguna decisión D-26 en
adelante existía antes de esta convocatoria (confirmado por grep sobre `docs/diseno/`).

| # | Decisión | Fuente |
|---|---|---|
| D-26 | Importe/fecha/descripción no viajan en `Reconocimiento` (por diseño, `04`§3); el servicio de I/O de Capa D los reúne por JOIN `reconocimiento_movimiento.movimiento_id → movimiento_bancario_crudo` | `motor-conciliacion-contable` |
| D-27 | Gap de esquema, sin FK física, entre `documento_ingerido`/`fuente_cierre` y `lote_ingesta`/`movimiento_bancario_crudo` — se resuelve hoy por rango `(cliente_id, cuenta_bancaria_id, fecha ∈ periodo)`, documentado como supuesto de "sin solape", o con FK nueva — pendiente de convocar `dba-data`. **Candidato a sumarse como ítem nuevo de `10-deuda-declarada.md`, sección B, sin dueño todavía** | `motor-conciliacion-contable` |
| D-28 | `pendiente_cierre.motivo_codigo` (hoy 2 valores) necesita migración que amplíe su dominio con motivos de Capa D — candidatos: `cuenta_no_configurada`, `cuenta_ambigua`, `tipo_sin_regla_imputacion`, `cliente_sin_plan_de_cuentas`. Vocabulario exacto lo cierra `contador-dominio` + `analista-funcional`; migración es de `dba-data` | `motor-conciliacion-contable` + `qa-funcional` (fusionado) |
| D-29 | 🟢 **CERRADA (2026-08-31, ronda de cierre real)** — ver §2. `rol_funcional` sin ampliar; tabla nueva de reglas de imputación por cliente (`04`§8) para `tipo_movimiento → cuenta_id`, con la regla operativa, la gobernanza y la disciplina de vigencia ya escritas en §2. Acuerdo real de los tres, `plan-cuentas-multicliente` concedió su posición original | `dba-data` + `contador-dominio` + `plan-cuentas-multicliente` (ronda de cierre) |
| D-30 | Camino feliz: `asiento_propuesto_renglon` (`propuesto`) ya es la propuesta — sin tabla nueva. Falta columna `evidencia jsonb` en `pendiente_cierre` | `motor-conciliacion-contable` |
| D-31 | Criterio automático/manual — fórmula exacta de §3, sin score inventado, con excepción dura de la familia socio | `qa-funcional` |
| D-32 | Corrección de premisa: `pendiente_cierre.motivo_codigo` tiene 2 valores hoy, no 8 (el 8 es `QUE_DECIDE`, dominio distinto de Capa B/C) | `motor-conciliacion-contable` + `qa-funcional` |
| D-33 | El % de aceptación de la Sesión 2b se mide sobre el corpus de Bracci, nunca sobre H y J (`N=1` degenerado) | `qa-funcional` |

**Sin número D, por ser constatación y no decisión**: H y J queda al 100% en `pendiente_cierre` hasta
tener plan de cuentas + Capa C corrida sobre su movimiento; el motivo del plan de cuentas faltante
(dato vs. proceso) es pregunta directa a JP, no un supuesto de ningún agente convocado.

---

## 7. Qué queda para la próxima convocatoria (de código, no de diseño)

- **D-29 ya cerrada (§2)** — queda escribir la migración: `dba-data` diseña la tabla nueva de reglas
  de imputación (`04`§8, clave `(cliente_id, tipo_movimiento[, concepto], vigencia) → cuenta_id`),
  con la gobernanza (`socio`/`contador`, nunca `administrativo`) y la disciplina de vigencia/no-
  reescritura-de-historia ya fijadas en §2. No se escribe DDL en esta sesión de diseño.
- `dba-data`: migración de D-27 (si se decide corregir el gap de FK) y D-28 (ampliar
  `pendiente_cierre.motivo_codigo` + la columna `evidencia jsonb` de D-30).
- `contador-dominio` + `analista-funcional`: cerrar el vocabulario exacto de los motivos nuevos de
  D-28.
- Preguntar a JP por qué H y J no tiene plan de cuentas (dato vs. proceso) — no bloquea Bracci.
- Arrancar Sesión 2b de código sobre Bracci, con la salvedad de D-12 ya incorporada: Bracci es punto
  de partida, ROKA sigue siendo el caso de validación multi-fuente antes de dar el motor por probado.

---

> ⚠️ **Implicancia contable y fiscal.** Este documento describe criterios de clasificación y
> registración con efecto directo sobre el balance. Ninguna afirmación de este documento cita norma
> ni Resolución Técnica porque no corresponde — es diseño de mecanismo, no criterio normativo; donde
> el mecanismo roza lo impositivo (cómputo de crédito fiscal, percepciones, régimen de recaudación
> bancaria provincial, porción computable del impuesto a los débitos y créditos), `contador-dominio`
> ya dejó registrado que **no tiene esa fuente cargada** (`knowledge/` vacío,
> `sources_status: esqueleto-sin-contenido`) — no se inventa. **Validar con profesional matriculado
> antes de que cualquiera de estas piezas produzca un asiento real.**
