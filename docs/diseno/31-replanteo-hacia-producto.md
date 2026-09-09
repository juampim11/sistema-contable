# 31 — Replanteo de flujo hacia un producto real

> Convocatoria de relevamiento funcional y diseño, 2026-09-08. Modo análisis y diseño puro — nada de
> esto tocó código ni el piloto. Motivador: después de ~2 meses de trabajo y una semana entera dedicada
> a `padron_contraparte` (diseño, migración, integración, medición contra el piloto real — HANDOFF
> 183-194), la conclusión medida y verificada es que el mecanismo funciona técnicamente (78 matches
> reales de 79 posibles en 3 meses de Bracci, 0 fallidos, cero desvíos) pero **no reduce el tiempo real
> de trabajo de Laura** — le ahorra pensar el nombre del proveedor, no el clic de confirmar cada una de
> las mismas líneas de revisión que ya tenía antes. Este documento junta los 5 dictámenes íntegros de la
> convocatoria (`analista-funcional`, `product-owner`, `arquitecto-software`, `tech-lead`,
> `contador-dominio`) y la síntesis aprobada por JP sin ajustes.

## Dos ideas de partida de JP — insumo para el relevamiento, no mandato

1. Si un extracto trae 200 transacciones que dicen "FORCOR" (proveedor ya conocido), en vez de 200
   confirmaciones individuales, una sola línea que agrupe: "hay 200 transacciones que matchean FORCOR,
   ¿las aprobás todas?" — una decisión, no 200.
2. Si aparece un nombre nuevo, no cargado en el padrón, agrupar igual ("150 transacciones con este
   nombre, parece proveedor, no está dado de alta") y ofrecer el alta de proveedor EN EL MOMENTO, desde
   la misma pantalla de revisión — sin CLI aparte, sin paso manual separado.

Más un problema de input sin resolver: un cliente puede entregar, para el mismo mes, un PDF, un Excel
del mismo extracto, o ambos — sin criterio claro de cuál usar ni protección contra procesar el mismo
movimiento dos veces (vivido esta semana con ROKA: PDF escaneado corrupto, Excel del mismo mes idéntico
y confiable, resuelto a mano).

## Restricción no negociable

El sistema nunca contabiliza 100% automático sin intervención humana (CLAUDE.md §1.7) — no se toca. Lo
que sí se revisó con criterio de dominio: dónde el guard actual protege contra un riesgo real y dónde es
más estricto de lo que el riesgo justifica.

---

## Dictamen 1/5 — `product-owner`

### 1. Diagnóstico honesto

**El problema de fondo no es de clasificación ni de input: es que la cola de revisión tiene la
granularidad equivocada y un gate que Laura ya cumple.**

Dos hechos medidos, cruzados:

- **Laura nunca decidió por movimiento.** Su proceso (`docs/analisis/00-cliente-piloto-laura.md`
  §1.1-1.2): filtra por concepto, suma, clasifica *el grupo* contra una cuenta; el único control por
  fila es "¿es CUIT de socio?". Una planilla de 1871 filas es **más trabajo** que su Excel, no menos.
- **`distinguir_tercero_de_socio` está trabado por `padronDeclaradoCompleto: false`, hardcodeado**
  (`apps/cli/src/reconocer-lote.ts:322`, `contrapartida.ts:221`). Los dos clientes ya tienen
  `padron_socio` cargado con HMAC. ROKA: los 2084 `ING TRANSF:` dieron 100% `sin_match_padron_incompleto`
  — tienen identificador, no son socios, y el motor igual pregunta. Bracci: 570/1149 con identificador
  sin match, 579 sin identificador.

Ranking por "tiempo de Laura ahorrado / semana de construcción":

| # | Frente | Decisiones que saca (3 meses, 2 clientes) | Costo | Ratio |
|---|---|---|---|---|
| 1 | **Aprendizaje/gate**: declaración por cliente "padrón de socios completo desde X" + 2 `regla_imputacion` por cliente | ROKA ≥2084 seguros; Bracci ~700. **≈2800 de 5265 (53%)** | ~1 semana | ~2800/sem |
| 2 | **Cola**: entregable agrupado por (concepto, lado, cuenta) por mes, excepciones aparte | El residuo (~2400) pasa a **≤40 líneas/mes/cliente** | ~1 semana | ~2300/sem |
| 3 | **Input PDF/Excel** | **0** decisiones de Laura. Ahorra horas de JP y evita doble carga | ~2 días | 0 para Laura |
| — | Clasificación (léxico, `padron_contraparte`) | 78/1414 (5,5%) — ya medido esta semana | 1 semana gastada | ~80/sem |

La cuenta cierra sola: el frente 1 no escribe lógica nueva, activa el gate que `contador-dominio` ya
diseñó (`04-imputacion-contable.md` §7, reglas 12a/13a: "sin padrón consultado, no es socio no es
conclusión" — *con* padrón declarado, sí lo es).

### 2. El próximo paso real para Laura

**Una cosa: el asiento mensual de Bracci julio 2026, agrupado por cuenta, con la lista de excepciones
al pie.** Es su papel de trabajo, hecho.

Métrica antes/después:
- Hoy (julio): 1081 movimientos → 518 propuestos + **563 filas para que decida** (447 + 116).
- Objetivo: **≤40 líneas revisadas + ≤60 excepciones nominadas**. 0 asientos `confirmado` sin ella.

Predicción falsable antes de tocar código: si soltar el gate promueve <30% de los 1414 de Bracci,
`sin_candidatos` domina y el frente 2 pasa a primero; si promueve >50%, el orden se sostiene.

Por qué esta y no otra: es la única que cambia la unidad de trabajo de Laura de "movimiento" a "grupo",
que es como ya trabaja. Reusa lo construido: la agrupación por `identificador_hmac` con corte ≥3 ya
existe en `relevamiento-laura.ts`; el reproceso por supersesión (`0040`) ya corrió contra 1680 asientos
reales con 0 fallidos.

### 3. Orden de prioridad

1. **Declaración de padrón completo por cliente** (Mitad 2 de `0038`): columna N2 con `declarado_por`,
   `vigente_desde`, `respaldo`; CLI de alta; 3 call sites; mutación (el gate en `false` debe seguir
   dando `decision_humana`). Convoca `contador-dominio` + `seguridad-datos-financieros` + `dba-data`.
   **Se difiere:** nada — es la palanca.
2. **2 `regla_imputacion` por cliente** para los tipos que destraba el punto 1, confirmadas por Laura.
   Sin esto, el 53% promovido cae en `pendiente_cierre` por `tipo_sin_regla_imputacion`.
3. **Entregable agrupado** (Excel, no pantalla): asiento por cuenta + excepciones. Reusa
   `relevamiento-laura.ts` + `exportar-planilla.ts`. Convoca `ux-designer` + `contador-dominio`.
4. **Criterio PDF/Excel, como regla operativa, no como arquitectura:** PDF es la fuente de verdad
   (Laura lo dijo); Excel solo cuando el PDF falla verificación, y se registra `origen_formato` en el
   lote. Guard mínimo: unicidad `(cliente, cuenta_bancaria, período)` salvo supersesión explícita. **Se
   difiere la fusión PDF+Excel**: se pierde la riqueza de campos del Excel, aceptable porque hoy nada la
   consume.
5. **Export en el formato de importación de su sistema**: el que mata "tipear". **Trabado de verdad**
   por un dato que solo Laura tiene. Se pregunta ahora; mientras, el Excel del punto 3 es el workaround.

**Ideas de JP:**
- **Idea 1 ("200 FORCOR → una línea"): no sirve tal cual.** Agrupar por nombre matcheado cubre 78
  movimientos de Bracci (2%). Alternativa: agrupar por (concepto, lado, cuenta) — la unidad de Laura —
  y por `identificador_hmac` dentro del grupo para las excepciones.
- **Idea 2 (alta de proveedor en el momento): no ahora.** Por diseño el alta no promueve nada
  (`29-padron-contraparte.md` §1.2) y todo proveedor imputa a la cuenta genérica (§2.1): saber *cuál*
  proveedor no cambia el asiento. Costo 0 clics ahorrados. Se difiere hasta que exista un cliente con
  cuenta por proveedor.

### 4. Qué NO construir

1. **`apps/web` / pantalla de revisión**: Laura trabaja en Excel; una pantalla con 1871 filas es la
   misma cola con otro marco. Antes cambia la granularidad, después el medio.
2. **Más `padron_contraparte`** (alta proactiva, fuzzy matching, `cuenta_id` por proveedor, cargar
   ROKA): techo medido 5,5%.
3. **Fusión PDF+Excel como cambio de contrato de ingesta.**
4. **Cuenta especial de Bracci y "cierre = balance"**: no traban el entregable de julio.

### 5. Riesgo de producto: aprobar en bloque

Qué puede salir mal: un socio nuevo sin cargar en `padron_socio` → sus cobros/pagos caen en "tercero" y
se aprueban con el grupo. Es exactamente el riesgo que Laura ya corre hoy con su control manual por
CUIT; el HMAC lo hace mejor, no peor.

Cómo se hace visible y reversible sin 200 clics:
- **Un grupo es homogéneo por evidencia o no es grupo**: mismo concepto, lado, vía, estado de
  resolución. `es_socio`, `multiples_socios`, `socio_fuera_de_vigencia`, `pepper_desalineado` **nunca**
  entran en un grupo — van nominados, uno por uno.
- Cada línea de grupo muestra n, suma, importe máximo y "0 coincidencias con padrón de socios".
- **Reversión = una corrección de regla, no 200 clics**: `reprocesar-capa-d.ts` ya supersede en bloque
  con trail. Un socio agregado tarde al padrón → bump de versión → reproceso de Capa C → los suyos
  salen del grupo.
- La aprobación del grupo queda como decisión con `decidido_por` + `respaldo` (patrón `regla_imputacion`),
  nunca como 200 `confirmado` individuales que atestigüen una revisión que no ocurrió (HANDOFF 193 §3).

### Decisiones que solo JP puede tomar

1. Pedirle a Laura que **declare completo el padrón de socios** de Bracci y ROKA (y desde qué fecha).
2. Aceptar que **el residuo `sin_candidatos`** siga en decisión humana agrupada, o abrir con
   `contador-dominio` + Laura la pregunta de si "salida sin identificador → Proveedores por default" es
   su regla real.
3. Preguntarle a Laura **qué sistema y qué formato de importación** usa.
4. Confirmar que **la meta del próximo entregable es "≤40 líneas + excepciones para julio de Bracci"**.

---

## Dictamen 2/5 — `analista-funcional`

Hechos medidos que ordenan todo lo que sigue:

- **Bracci: 1414 `distinguir_tercero_de_socio` y `contrapartidaSinCandidato = 0` en los 5 lotes** —
  casi el 100% de esa cola **ya tiene el CUIT de la contraparte capturado y hasheado**. `padron_socio`
  puede resolverlos por HMAC exacto; lo único que lo impide es `padronDeclaradoCompleto = false`
  hardcodeado.
- `padron_contraparte` cubre **78 de 1414 (5,5%)** por nombre. El HMAC cubriría ~1414.
- Agrupando por `identificador_hmac`: Bracci **856 contrapartes distintas, 620 aparecen una sola vez**.
  La cola larga es real.

### A. Regla de agrupación

**"Mismo caso repetido" = misma pregunta al humano, no misma glosa.** Clave en dos niveles, por
`cliente_id`:

1. `reconocimiento_movimiento.que_decide` (o `motivo_codigo` si `sin_reconocer`) + `concepto` canónico
   + `lado`. Agrupa lo que se resuelve con **una regla vigente**. Cubre las 457 `decision_humana`
   restantes de Bracci y las 435 `sin_reconocer`.
2. Dentro de `distinguir_tercero_de_socio`: `movimiento_contraparte_identificador.identificador_hmac`
   cuando `contraparte_captura = 'capturado'`; **solo si `sin_identificador`**, `patron` de
   `padron_contraparte` matcheado o, en su defecto, `normalizar(descripcion)` sin el literal del léxico.

**Importe NO entra en la clave** (el motor no lo lee). Sí se muestra: conteo, mín, máx, suma,
primer/último `fecha`, `via`, `patron_contraparte_estado`.

Casos borde:
- **Mismo nombre, dos proveedores**: con HMAC son dos grupos por construcción. Con nombre solo,
  colapsan; por eso el nombre es clave de último recurso y nunca promueve.
- **Nombre que también es socio**: si el CUIT matchea `padron_socio` → `es_socio` → `propuesta` y
  `no_aplica`. El grupo por nombre nunca se forma. Sin CUIT capturado no hay forma de detectarlo: es el
  riesgo que justifica que "nombre" no promueva.
- **Excepción dentro de 200**: si difiere en un campo de la clave, ya es otro grupo. Si difiere solo en
  importe, la aprobación es todo-o-nada y el outlier se marca por rango; "aprobar todo menos X" es v2.
- **NO MEDIDO**: cardinalidad de grupos por nivel 1 y 2 en Bracci. Predicción falsable: nivel 1 ≤ 60
  grupos; nivel 2 ≥ 300 (cola larga). Si nivel 2 da > 300, agrupar por contraparte **no** reduce
  decisiones: el mecanismo correcto es el de E.

**Sobre la idea 1 de JP, explícito: tal como está, no mueve Bracci.** "200 FORCOR, ¿aprobás?" responde
"es tercero" con evidencia de nombre, cuando el CUIT ya lo responde con evidencia más fuerte para las
1414 en **una** decisión (E). Y en Capa D no cambia cuenta: 0 sub-cuentas por proveedor en los dos
clientes. La forma válida de la idea es la revisión agregada de Capa D que ya se hizo en (193): "1414
asientos `pago_a_proveedor` → Proveedores genérica, ¿ok el criterio?".

### B. Alta en el momento

Vale como **evidencia**, no como ahorro de decisiones (5,5%). Flujo, pre-completado:

1. Línea de grupo `sin_match` con N ≥ 3: patrón candidato = tokens comunes a las N glosas normalizadas,
   quitando el literal del léxico y toda corrida de 7+ dígitos (evita `patron_sin_documento_chk`). Si
   quedan < 2 tokens → "patrón: a completar", sin sugerencia.
2. Clasificación sugerida por `lado`: debe → proveedor, haber → cliente. `vigencia-desde` = mín `fecha`
   del grupo.
3. Laura corrige o acepta → `altaDeContraparte` existente → re-correr `resolverEvidenciaDeContraparte`
   en memoria sobre el mismo lote → reportar "matchearon M de N".
4. **Dos gestos, no uno.** El alta agrega evidencia; la pregunta socio/tercero se responde por período
   (E), nunca por grupo.

Casos borde: patrón post-normalización ilegible → mostrar la glosa original al lado; CUIT en el texto
→ el guard rechaza. **"Sin CLI aparte" exige `apps/web` fase 2, que no existe.** Versión sin UI: columna
"dar de alta como" en la planilla, y un script que consume la respuesta y corre las altas en lote.

### C. PDF / Excel / ambos

Hechos: `lote_ingesta` es único por `(cliente_id, archivo_hash)` → dos archivos = dos lotes. `fila_hash`
incluye `normalizar(descripcion)`. El PDF trunca la razón social a 20 caracteres y el Excel no → **mismo
movimiento, hash distinto, doble inserción sin que ninguna constraint dispare.** `fila_hash` no alcanza.

Regla decidible:
- **Mismo extracto** = `(cliente_id, cuenta_bancaria_id, periodo_desde, periodo_hasta)` de
  `lote_ingesta_cuenta`, con `saldo_inicial_declarado`/`saldo_final_declarado` iguales.
- **Mismo movimiento entre formatos** = `(cuenta, fecha, importe, saldo, ordinal)` — sin `descripcion`.
  `saldo` es el discriminador del banco, medido 326/326 en Galicia. Banco sin saldo por fila → la regla
  degrada y se declara `no_verificable`.
- **Cuál gana**: el que `verificacion_estado = 'cuadra'`. Llega uno y cuadra → el segundo se rechaza con
  `extracto_duplicado_por_formato`, salvo `--reemplaza <lote_id>`. El primero `no_cuadra`/`con_errores`
  (caso ROKA) → el segundo entra y lo supersede (`documento_ingerido.superseded_by_id` ya existe para
  esto). Los dos cuadran y difieren en el conjunto de claves → **ninguno avanza a Capa B**; se reporta
  el diff. Nunca fusión fila a fila.
- El guard vive en ingesta, antes de Capa B: `reconocimiento_movimiento` es por `movimiento_id` y un
  duplicado produce asiento duplicado sin síntoma.

**NO MEDIDO**: invariancia de `(fecha, importe, saldo)` entre PDF y xlsx. Predicción: 326/326
coinciden. Excel del home banking con layout distinto = adaptador propio; los `.xls` de Macro fueron
"descartados por decisión previa" — decisión a reabrir.

### D. Criterios de aceptación

Métrica: **decisiones humanas distintas por cliente por trimestre**, con "movimientos cubiertos por
decisión" como segunda.

| | Bracci hoy (medido) | Después (predicción) |
|---|---|---|
| Filas con pedido de decisión | 2306 (1871 + 435) | 892 |
| `distinguir_tercero_de_socio` | 1414 filas | 1 manifestación |
| Decisiones distintas (nivel 1) | NO MEDIDO | ≤ 60 |
| Asientos a revisión agregada | 1626 | ~3040, por `tipo` |

Si nivel 1 > 150, la clave es demasiado fina. **NO MEDIDO**: si `regla_imputacion` de Bracci/ROKA cubre
`pago_a_proveedor_transferencia` y `cobranza_de_cliente`; sin eso, las 1414 caen a `pendiente_cierre` en
Capa D, no a asiento.

### E. Seguridad: condición medible

El guard `false` protege contra el error socio→proveedor, que es silencioso. El mecanismo que lo cubre
**ya está diseñado**: `padron_manifestacion` con `completo_hasta` y `manifestado_por` (0021), sin
escritor de producción. Condición para promover con menos fricción, no automático:

1. `padron_socio` ≥ 1 vigente para el cliente (Bracci 2, ROKA 4).
2. Manifestación por `socio`/`contador` con `completo_hasta ≥ periodo_hasta` del lote; nunca cruza
   cierre de ejercicio.
3. En el lote: `pepper_desalineado = 0` **y** `es_socio ≥ 1` (Bracci 14/994). Un padrón que no matchea
   nada no prueba que sea el pepper correcto.
4. `contrapartidaSinCandidato = 0`: lo `sin_identificador` sigue en `decision_humana` por diseño.

### Tres decisiones de JP

1. **Cablear la manifestación de padrón completo** antes que seguir invirtiendo en `padron_contraparte`.
2. **Formato del próximo piloto a Laura**: planilla agrupada v2 o empezar `apps/web` fase 1-2. "Alta en
   el momento" solo existe en la segunda.
3. **Política PDF/Excel**: adoptar "gana el que cuadra + clave sin descripción", medirla sobre Galicia
   06-2026, y reabrir el descarte de los Excel de Macro.

---

## Dictamen 3/5 — `arquitecto-software`

### A. Dónde vive cada cosa

| Pieza | Capa | Reusa tal cual | No alcanza |
|---|---|---|---|
| **Memoria de confirmaciones** | Persistencia, junto a `reconocimiento_movimiento` | `uq_recon_vigente`/`superseded_por` (0014), FK de tres columnas, `recalculo_disponible` (0014, **sin productor desde el día uno**) | `confirmar-asientos.ts`: Capa D solo ve `propuesta`. `regla_imputacion`: resuelve tipo→cuenta después de la promoción |
| **Alta en el momento** | Cola de revisión llamando a `altaDeContraparte` | `padron_contraparte` completo, policy socio/contador, guard anti-documento | Nada nuevo en esquema; solo cambia el punto de entrada |
| **Agrupación** | Cola de revisión, en memoria | `padron_contraparte_id` como clave estable | La clave por texto de glosa no se persiste nunca |
| **Multi-formato** | Ingesta (`lote_ingesta`, `lote_ingesta_cuenta`) | `documento_ingerido.superseded_by_id` como idiom | `archivo_hash`/`fila_hash` no cruzan formatos |

Diagnóstico central: **hoy nada persiste lo que Laura decide.** La columna "Corrección / Identidad"
vuelve en un Excel y muere. 05 §5.2 previó "reconocimiento con decisión humana registrada" y 0014 le
dejó `recalculo_disponible`; la tabla nunca se escribió. Sin esa tabla, agrupación estable, promoción
condicionada y recálculo seguro no tienen sobre qué apoyarse. **Es LA pieza faltante.**

### B. Mecanismo mínimo de memoria

**Tabla nueva `decision_revision`** (siete renglones de ADR-0001 §5), append-only:

- `reconocimiento_id` → FK compuesta `(cliente_id, id)` a `reconocimiento_movimiento`. Cita la versión
  que la persona vio.
- `decision_codigo` — dominio cerrado: `es_tercero_proveedor | es_tercero_cliente | es_tercero_otro |
  es_socio | ratifica_propuesta | rechaza_propuesta`. Nunca `estado`/`clase`/`motivo_codigo`.
- `padron_contraparte_id` nullable, FK compuesta; equivalencia con `decision_codigo like
  'es_tercero_%'` por CHECK.
- `decidido_por not null default app.current_user_id()`; `revoca_a` para superseder. Sin UPDATE ni
  DELETE para nadie.
- Policy de INSERT socio/contador, sin `administrativo`.
- Índice parcial: una decisión vigente por `(cliente_id, reconocimiento_id) where revoca_a is null`.
- Sin `comentario` libre en v1 — deuda declarada, mismo tier que H1/0030.

Descartados: atributo con vigencia en `padron_contraparte` (mezcla un hecho de la relación comercial
con decisiones por movimiento; `patron` es inmutable por diseño); `regla_imputacion` extendida (0030
prohíbe expandirla).

**Qué cuenta como confirmación:** una fila de `decision_revision` escrita bajo `conUsuario`. El Excel es
**transporte**, no registro: un CLI `registrar-decisiones.ts` lee la planilla devuelta, dry-run por
defecto, selector explícito por lote, una transacción por movimiento con reporte de fallidos.

**Productor de `recalculo_disponible`, por fin:** en `persistirReconocimiento`, si el vigente tiene
decisión abierta, **no se supersede**: se marca `recalculo_disponible = true`. Fail-closed a favor del
trabajo de la contadora.

### C. Agrupación

Dos niveles, y el límite entre ambos es lo que importa:

1. **Nivel estable — por `padron_contraparte_id` + `tipo` + `lado`.** Clave = uuids y vocabulario
   cerrado; se puede citar como evidencia. Hoy cubre 79 de 1414.
2. **Nivel candidato — por glosa normalizada, solo en memoria, solo para producir un alta.** Laura ve
   "estas 200 filas comparten `FORCOR`", da de alta el patrón, y el grupo **pasa** al nivel 1. La clave
   de texto nunca toca la base.

Lo que se persiste es **una `decision_revision` por movimiento**, nunca "una por grupo". El grupo es un
artefacto de UI; `grupo_lote_id uuid` opcional sirve para auditar "esto se decidió en bloque de N", sin
cargar texto.

**Reproceso / `VERSION_DEL_MOTOR`:** la decisión sobrevive (cita el reconocimiento viejo); su
aplicabilidad a la versión nueva es humana pero en bloque: un CLI `ratificar-tras-reproceso.ts`
supersede el reconocimiento y escribe la decisión nueva con `revoca_a` → vieja, agrupado por nivel 1.
Bump = un clic por grupo, no 9055 líneas.

**Re-ingesta:** `fila_hash` lleva saldo, `movimiento_id` es estable; la decisión sigue al movimiento.

### D. Multi-formato

`uq_lote_ingesta_archivo` es por bytes (PDF ≠ Excel); `fila_hash` no cruza formatos. Hoy nada impide dos
lotes sobre la misma cuenta-período: ingerir PDF y Excel duplica todos los movimientos en silencio. No
existe ningún adaptador Excel.

Mecanismo mínimo, sin fusión de filas:

- "El mismo extracto" = `(cliente_id, cuenta_bancaria_id, periodo_desde, periodo_hasta)`.
- Columna `lote_ingesta_cuenta.superseded_by_id` + índice único parcial sobre esa cuádrupla `where
  superseded_by_id is null`. Segundo formato del mismo período = `--reemplaza-lote <id>` explícito.
- `formato_origen` (`pdf | xlsx | csv`) como capacidad declarada. Cuál gana no se cablea: parámetro por
  banco el día que exista un segundo adaptador real.
- Solapamiento parcial necesita `btree_gist` (contrib — decisión de `dba-data`). Deuda declarada, no v1.

### E. Promoción condicionada

**No hay condición segura hoy**, porque la evidencia "N confirmaciones previas sin excepción" **no
existe** — cero decisiones persistidas. Lo que falta es B.

Con B en pie, dos variantes:

**v1 — ratificación en bloque (recomendada, sin tocar el motor).** La `clase` no cambia; R-F sigue con
dos constructores; `padron_contraparte` sigue sin promover. La cola presenta el grupo de nivel 1 con su
historial y Laura ratifica en un clic. Cada movimiento sigue con decisión humana registrada. Cumple
§1.7 sin discusión.

**v2 — regla de promoción (necesita ADR).** Tabla `regla_promocion_contraparte` con evidencia
**congelada** al declararla (`evidencia_confirmaciones int`, `evidencia_hasta date`). Guard verificable:
alta rechazada si existe decisión contraria (mutación: registrar decisión contraria → rojo); excepción
posterior cierra `vigente_hasta` de la regla (mutación: quitar el cierre → rojo); el motor **no lee
`importe`** — el tope se evalúa en el gate de persistencia, no en `reconocer()`; reversión en bloque vía
FK compuesta `reconocimiento_contrapartida.regla_promocion_id`. Sería un **tercer constructor de
`propuesta`**: cambia R-F y `PERMITIDOS_PROPUESTA`. Por eso ADR, no mitad.

### F. Caro vs barato

**Caro de revertir → ADR primero:** (1) decisión persistida como entidad de primer nivel; (2) "una
fuente vigente por cuenta-período"; (3) el tercer constructor de `propuesta` (solo si se va a v2).

**Barato, en mitades:** alta desde la planilla devuelta; agrupación en memoria en
`exportar-planilla.ts`; `registrar-decisiones.ts` dry-run; productor de `recalculo_disponible`;
ratificación en bloque.

### G. Estabilidad

- **Digest:** las decisiones no son entrada del motor; no entran a `entrada_digest` ni `motor_digest`.
  R-L vigila.
- **TOCTOU:** `for update`/`for share` en todo escritor nuevo; una transacción por movimiento;
  `fallidos_en_esta_corrida` en el reporte.
- **Prosa libre:** `decision_codigo` cerrado; sin comentario en v1; `grupo_lote_id` uuid, nunca glosa.
- **Guard de tests / piloto:** ninguna tabla nueva con grant a `app_job`; ninguna migración de esta
  línea toca el piloto antes de cerrar el guard de `sembrar()` por DSN real.

### ADR a escribir antes de tocar código

1. **ADR-0003 — La cola de revisión tiene memoria.** `decision_revision`, quién escribe, relación con
   supersesión y `recalculo_disponible`.
2. **ADR-0004 — Una fuente vigente por cuenta-período.** Formato como capacidad del adaptador,
   supersesión de lote.
3. **ADR-0005 (condicional) — Tercer constructor de `propuesta` por regla de contraparte.** Solo si la
   ratificación en bloque no alcanza.

---

## Dictamen 4/5 — `contador-dominio`

`knowledge/` sigue vacío (16 archivos, todos README/plantilla, `sources_status: esqueleto-sin-contenido`),
así que ninguna afirmación de abajo cita norma ni RT; todo es criterio profesional marcado como tal.

### A. Agrupación: es una decisión legítima, si es una decisión sobre una regla y no sobre 200 hechos

Aprobar 200 movimientos "FORCOR" en un gesto **es legítimo** cuando lo que la contadora aprueba es *una
regla de imputación aplicada N veces*, no N juicios independientes. Laura ya trabaja así.

Dos límites que no se negocian:

1. **La agrupación es de la decisión, nunca del asiento.** Aprobar en bloque produce 200
   `asiento_propuesto` individuales confirmados, cada uno citando su línea de extracto — nunca un
   asiento neto.
2. **Lo que tiene que ver en la línea agrupada:** cantidad, suma, rango de fechas, **mínimo y máximo de
   importe** (no solo la suma), lado, concepto del léxico, cuenta bancaria origen, cuenta contable
   propuesta, y la lista desplegable.

**Un grupo no se aprueba en bloque** cuando: mezcla lados; mezcla conceptos del léxico; un miembro
tiene evidencia contradictoria de socio (`multiples_socios`, `socio_fuera_de_vigencia`,
`pepper_desalineado`) o `multiples_patrones`; un importe cae fuera del rango histórico confirmado; o el
movimiento cae en un cierre ya terminal.

### B. Qué es "el mismo caso, repetido"

Contablemente: `(tipo, columnaOrigen) → cuenta`, más la contrapartida resuelta. Todo pago a proveedor
imputa a un puñado de cuentas genéricas, sin subcuenta por tercero. "El mismo caso" es: **mismo
proveedor + mismo concepto del léxico + mismo lado + misma cuenta destino ya confirmada**.

No integra el criterio de imputación pero sí el de riesgo: el importe. No aplica al pago bancario: IVA
discriminado y condición del proveedor. Sí cambia la cuenta y el extracto no lo dice: **anticipo vs.
cancelación** — excepción que Laura conoce por la factura, no por el banco.

### C. Match de proveedor vs. "no es socio": son afirmaciones distintas, y la primera alcanza

El criterio original ("sin padrón consultado, no es socio no es conclusión") es sobre la rama negativa.
Un match de `padron_contraparte` es **evidencia positiva de identidad**. Para ese movimiento, eso sí es
una conclusión, con estas condiciones:

- `padron_socio` corrió primero y **no** dio evidencia positiva (`es_socio` corta antes). Estados
  admitidos: `sin_candidatos`, `sin_match_padron_incompleto`.
- Match **único** (`multiples_patrones` no promueve), patrón dado de alta por socio/contador.
- El padrón de socios tiene contenido: "consultado y vacío" no vale como "consultado".

Riesgo residual: un socio que además factura (honorarios) y aparece con razón social propia; lo cierra
solo el HMAC de socio. Recomendación: un estado de promoción **nuevo** (`es_tercero_por_contraparte_
confirmada`), nunca reusar `es_tercero_padron_completo`.

Y el dato que hay que decir aunque duela: esto mueve 79 de 1414 en Bracci y 0 en ROKA. **La palanca
real de `distinguir_tercero_de_socio` es la manifestación de padrón completo** — una declaración de
Laura, por cliente y con fecha, que ya tiene tabla y que nadie invoca.

### D. Condiciones concretas, y la reversa

| Condición | Riesgo que cierra | Qué deja abierto | Valor propuesto |
|---|---|---|---|
| Mismo patrón, match único | "a quién" | socio homónimo → lo cierra el HMAC previo | obligatoria |
| Mismo concepto del léxico + mismo lado | naturaleza del hecho | anticipo vs. cancelación | obligatoria; agrupar por concepto, no por tipo |
| Misma cuenta bancaria | nada contable | — | criterio de lectura, no de seguridad |
| N confirmaciones previas idénticas | que la regla sea recurrencia y no un mes raro | cambio de relación comercial | **N = 3, en ≥ 2 períodos distintos**; excepción resetea N |
| Tope por movimiento | outlier escondido en el bloque | — | fuera de **[mín, máx] × 2** de las N confirmadas → sale del grupo. Sin tope nominal en pesos (caduca con inflación) |
| Tope por grupo | error sistémico del patrón | — | suma del grupo vs. mismo proveedor del período anterior, mostrado, no bloqueante |
| Período abierto | escritura en cierre terminal | — | ya lo impone `0040` |

**Reversa.** Como cada miembro es su propio asiento, la reversa es **por miembro**: Caso A si sigue
`propuesto`; Caso B (`ajuste_cierre`, histórico intacto) si ya está `confirmado`. Lo que falta: un
identificador común de lote de aprobación como evidencia, y **reversa en bloque por la misma causa** —
hoy es la Mitad 2 cerrada en contra (HANDOFF 188). Aprobación en bloque sin reversa en bloque es
asimétrica; hay que reabrir esa decisión al menos para "deshacer un lote de aprobación".

### E. Alta en el momento: nombre + clasificación alcanza para el asiento del pago

El asiento del pago bancario es Proveedores (debe) / Banco (haber). **No necesita CUIT ni condición
IVA**: el pago no lleva IVA; crédito fiscal, retenciones y condición del proveedor se resuelven con la
factura, y eso es de `fiscal-nacional-iva-ganancias`. Ese asiento parcial es legítimo y completo como
registro del pago.

Condiciones del alta: mostrar cuántos movimientos históricos matchearían con ese patrón antes de
confirmarlo; rechazar un patrón que también matchee la denominación de un socio; clasificación
explícita.

**Validar con profesional matriculado.** Decisiones que solo Laura puede tomar: (1) declarar el padrón
de socios completo por cliente, con fecha; (2) N y el factor de tope; (3) qué cuenta genérica para cada
proveedor; (4) si el cliente lleva circuito de valores; (5) qué socios también facturan honorarios; (6)
qué pagos son anticipo y no cancelación.

---

## Dictamen 5/5 — `tech-lead`

### Calibración (medida esta semana)

- Tabla nueva completa (7 renglones + escritor + clasificación + mutaciones + 3 agentes): **4-6
  commits, 1 migración**.
- CLI con dry-run + selector explícito, reusando un escritor existente: **1-2 commits**.
- Cambio en `nucleo/` con bump: reproceso de todo el corpus, 1 `--aplicar` por lote con backup.
- Hecho verificado: un `reconocer-lote --aplicar` **sí escribe cuando cambia `clase`** aunque el digest
  de entrada no cambie — un cambio de *datos* (padrón, manifestación) se propaga sin bump, con corridas
  por lote.

### 1. Agrupación en la cola

**Tamaño:** solo visual (hoja "Por contraparte" + columna clave de grupo): **1-2 commits, 0
migraciones, sin bump**. "Una decisión por grupo" es la pieza 3.
**Riesgo de coherencia:** ya hay dos claves de agrupación (`relevamiento-laura.ts` en SQL, el matcher
de `padron_contraparte` en TS). Unificar en una función pura `claveDeAgrupacion`. Convoca `ux-designer`
+ `seguridad-datos-financieros`.
**Bug reintroducible:** el del digest (187) si la clave se calcula dentro del objeto de evidencia.
Control: la clave vive en `armar-libro`, aguas abajo.

### 2. Alta de proveedor "en el momento"

**Tamaño:** hoja "Altas" en la planilla + modo `--desde-planilla <xlsx>` en `alta-contraparte.ts`, dry-run
por defecto: **1-2 commits, 0 migraciones, sin bump**.
**Costo operativo oculto:** después de cada tanda de altas hace falta `reconocer-lote --aplicar` por
lote. Es runbook, no código.
**Coherencia:** reusar `escribirAltaDeContraparte` sin tocarlo. Convoca `security-engineer` +
`seguridad-datos-financieros` + `code-reviewer`.
**Bug reintroducible:** prosa libre con dato sensible — una celda con CUIT. Control:
`RE_POSIBLE_DOCUMENTO_EN_TEXTO` por celda antes de Zod.

### 3. Memoria de confirmaciones

**Lo que ya existe:** la "memoria" generalizable son los catálogos (`padron_contraparte`,
`padron_socio`, `regla_imputacion`). Falta el registro por movimiento de la decisión no generalizable.
**Tamaño:** tabla `decision_revision` + escritor + CLI `importar-decisiones.ts`: **5-7 commits, 1
migración, sin bump** — la decisión no toca `reconocimiento_movimiento` ni el motor. Convocatoria
obligatoria: `dba-data` + `security-engineer` + `seguridad-datos-financieros` + `contador-dominio` +
`analista-funcional`.
**Coherencia:** espejar `pendiente_cierre`/`pendiente_dispensa` (0027): estado + `resuelto_por` +
supersesión con índice parcial + FK `deferrable`, append-only.
**Bug reintroducible:** TOCTOU entre importar decisión y un reproceso que supersede el reconocimiento —
`for share` sobre el vigente.

### 4. Multi-formato PDF/Excel

**Hechos:** los 8 adaptadores leen geometría de PDF; no existe ningún lector de Excel de extracto. La
idempotencia por `(cliente_id, archivo_hash)` no impide el doble procesamiento entre formatos.
**Tamaño, en dos:** (4a) guard contra doble ingesta por (cliente, cuenta, período solapado): **3-5
commits**. (4b) Familia de adaptadores Excel: tamaño de "banco nuevo" cada uno (Grande). Sin bump en
ninguno.
**Mitad chica:** 4a solo.
**Bug reintroducible:** digest — un campo nuevo del Excel en el objeto de evidencia cambia el digest del
100% del corpus.

### 5. Promoción condicionada

**Ya existe, sin productor:** `resolverContraparte(..., padronDeclaradoCompleto)` y
`padron_manifestacion` (0021) están construidos; los 3 call sites pasan `false` hardcodeado.
**Tamaño:** (a) cerrar el gap "manifestación revocada citable": **2-4 commits**. (b) CLI
`manifestar-padron.ts`: **1-2**. (c) wiring de los 3 call sites: **1-2**. Sin bump. Pero es **reproceso
real de corpus**: cada lote con `--aplicar` y backup.
**Mitad chica:** flag `--simular-padron-completo` en `resolver-contrapartida.ts` (solo lectura).
**Bug reintroducible:** guard que mira etiqueta y no la fuente (190) — el gate lee la manifestación
vigente de la base, nunca un flag/env.

### 6. Superficie de revisión

**Veredicto: `apps/web` NO es prerequisito de 1-2-3.** El round-trip planilla → hojas completadas →
CLIs de import con dry-run cubre el primer piloto mostrable. La web exige auth (`AuthProvider`, B.4 —
ADR con `arquitecto-software` + `security-engineer`, semanas) que hoy no existe.

### Grafo de dependencias

```
2 (altas batch) ──► 3 (decisión persistida) ──► 1-con-decisión
1-visual (independiente)          6 ◄── auth (B.4) + escritores de 2 y 3
5a (gap manifestación revocada) ──► 5b (productor) ──► 5c (wiring + reproceso por lote)
4a (guard doble ingesta) independiente;  4b (Excel) independiente y grande
```

### Secuencia propuesta

**Tanda 1 — medir y agrupar (sin migraciones):** 1-visual + 2 + 5-mitad-chica.
**Tanda 2 — memoria (1 migración):** 3 + 4a.
**Tanda 3 — promoción (reproceso real):** 5a-5c, solo si `contador-dominio` y Laura aceptan manifestar.
**Tanda 4 — decidir la web:** ADR de auth + vista de solo lectura, solo si Tandas 1-2 demostraron que
Laura completa las hojas.

### Dos incertidumbres y su medición barata

1. **Cuántos flipean con el gate encendido.** Medición: el flag de solo lectura de 5-mitad-chica.
2. **Si Laura completa hojas de Excel** (conductual, no técnica). Medición: mandar la hoja "Altas" con
   el próximo export y contar filas completadas al primer ciclo.

---

## SÍNTESIS — plan priorizado (aprobada por JP sin ajustes)

### Diagnóstico consolidado (unánime)

1. **`padron_contraparte` no es la palanca.** Techo medido: 5,5% (78/1414). Funciona, queda, no se
   invierte más ahí.
2. **La palanca real ya está construida y nadie la invoca:** `padron_manifestacion` (0021) +
   `padronDeclaradoCompleto`, hardcodeado `false` en 3 call sites. Casi el 100% de los 1414+3851
   `distinguir_tercero_de_socio` ya tienen el CUIT capturado y hasheado (`contrapartidaSinCandidato =
   0`); `padron_socio` los resuelve por HMAC en cuanto Laura declare el padrón completo.
3. **Nada persiste lo que Laura decide.** El Excel vuelve y muere. `arquitecto-software` lo llama LA
   pieza faltante; `tech-lead` lo dimensiona: 1 migración, 5-7 commits, sin bump.

### Veredicto sobre las dos ideas de JP

| Idea | Veredicto | Forma que sí sirve |
|---|---|---|
| **1. "200 FORCOR → una línea"** | **No tal cual.** Cubre el 5,5%; y aprobar "es tercero" por nombre es evidencia más débil que el CUIT ya capturado. | Agrupar por (concepto del léxico, lado, cuenta destino), con el HMAC dentro del grupo para separar excepciones. La línea muestra n, suma, mín/máx, rango de fechas, cuenta propuesta. Legítimo porque aprueba una regla aplicada N veces, nunca un asiento neto. |
| **2. Alta de proveedor en el momento** | **No ahora como prioridad; sí como pieza barata.** No cambia el asiento — ahorra 0 clics. | Hoja "Altas" en la planilla + `alta-contraparte.ts --desde-planilla` con dry-run. "Sin CLI aparte" literal exige `apps/web`, que no es prerequisito de nada de lo de abajo. |

### Respuesta a la pregunta de seguridad

**No hay condición segura hoy para promover por nombre, y la razón es estructural:** la evidencia "N
confirmaciones previas sin excepción" no existe porque no se persiste ninguna decisión. Lo que sí
existe y es seguro con menos fricción, en orden:

- **Ahora (sin tocar el motor):** manifestación de padrón completo por cliente y fecha, con las 4
  condiciones de `analista-funcional`.
- **Con memoria de decisiones (Tanda 2):** ratificación en bloque — la clase no cambia, cada movimiento
  lleva decisión humana registrada, un clic por grupo.
- **Solo con ADR (después, si hace falta):** tercer constructor de `propuesta` por regla de
  contraparte, con las condiciones de `contador-dominio`: match único + `padron_socio` corrido sin
  evidencia positiva + `socios.length > 0` + mismo concepto y lado + N = 3 en ≥ 2 períodos + tope
  [mín, máx] × 2 + evidencia congelada + cierre automático ante la primera excepción + reversa en
  bloque.
- **Asimetría a resolver antes de cualquier aprobación en bloque:** aprobar en bloque sin poder
  deshacer en bloque es asimétrico. Reabrir Mitad 2 de `0040` al menos para "deshacer un lote de
  aprobación", o limitar el tamaño del lote.

### El plan, en tandas

| Tanda | Piezas | Tamaño | Migraciones / bump | Qué ve Laura al final |
|---|---|---|---|---|
| **0 — medir (1 día, solo lectura)** | (a) flag `--simular-padron-completo`; (b) cardinalidad real de grupos nivel 1 y nivel 2 en Bracci; (c) si `regla_imputacion` cubre `pago_a_proveedor_transferencia` y `cobranza_de_cliente` | 1-2 commits | 0 / no | Nada todavía. Decide el orden de las tandas 2 y 3 |
| **1 — agrupar y preguntar (sin migraciones)** | Planilla agrupada v2 + hoja "Altas" + `alta-contraparte --desde-planilla` + función única `claveDeAgrupacion` | 3-5 commits | 0 / no | Julio de Bracci, de 563 filas a ≤40 líneas + ≤60 excepciones, más el número medido de la manifestación |
| **2 — memoria (1 migración)** | `decision_revision` + `importar-decisiones.ts` + productor de `recalculo_disponible` + guard 4a | 8-12 commits | 1-2 / no | Nada se pregunta dos veces; ningún mes se procesa dos veces; ratificación en bloque |
| **3 — promoción real (reproceso)** | Cerrar gap manifestación + `manifestar-padron.ts` + wiring + 2 `regla_imputacion` por cliente + corrida por lote | 6-10 commits + ~9 `--aplicar` | 1 / no | El salto de `propuesta` por cliente, medido contra la predicción de la Tanda 0 |
| **4 — decidir la superficie** | ADR de auth + vista de solo lectura, solo si Laura completó las hojas | ADR + 4-8 commits | — | — |

> **Visión explícita de JP para la Tanda 4 (2026-09-09), a preservar hasta que le llegue el turno.**
> No es una pantalla funcional genérica: tiene que tener un **nivel visual alto**. Ejemplo concreto
> que dio JP: al subir un extracto, la selección de banco muestra el **logo real de cada banco**
> (Galicia, Macro, Santander, etc.), no un dropdown de texto plano. La experiencia de carga y revisión
> tiene que sentirse cuidada y profesional desde el primer contacto visual — es un diferenciador real
> para mostrarle a Laura o a cualquier cliente potencial nuevo, no un detalle cosmético de último
> momento. Queda pendiente de una **convocatoria propia a `ux-designer`** (nunca usado en este
> proyecto todavía) cuando la Tanda 4 se habilite — condicionada, como ya dice la tabla de arriba, a
> que el flujo por planilla (Tandas 1-2) demuestre primero que Laura completa las hojas. No se
> convoca ni se diseña nada de esto ahora.

> 🔴 **Corrección final (2026-09-09 — reemplaza la corrección del 2026-09-08 de más abajo en el
> historial de este bloque, que llegó a una conclusión equivocada sobre el origen de "3843").** La
> corrida real de Tanda 3 se ejecutó primero sobre 10 lotes (6 Bracci + 4 ROKA), pero uno de los 4 de
> ROKA (`ae762fda-8822-459f-a061-31d7ce26c785`, fechas 2025-10-20/11-28) resultó ser **dato de
> prueba de desarrollo** — el archivo usado para validar el adaptador de Macro, nunca un extracto
> real, mezclado en el piloto desde `2026-08-19` por descuido (HANDOFF 164 ya lo había identificado
> como tal el 2026-09-01, pero nunca se eliminó). Se confirmó que ningún otro cliente del piloto
> tiene el mismo problema, se midió el impacto, y **se eliminó del piloto** el 2026-09-09 (backup
> previo, borrado verificado en una transacción de 11 tablas con `ROLLBACK` automático si algo no
> coincidía — los 11 conteos coincidieron, `COMMIT` aplicado).
>
> **La cifra "3843 ROKA promoviendo" de la Tanda 0 era correcta desde el principio** — la corrección
> del 2026-09-08 (más abajo) concluyó lo contrario porque, al recalcular, se tomaron por error "los 3
> lotes originales de ROKA" incluyendo el de prueba, en vez de los 3 lotes reales (mayo/junio/julio
> 2026). Verificado por TRES vías independientes que coinciden exacto: la medición limpia post-
> borrado (3843 promociones + 8 residual), una medición de HANDOFF anterior e independiente
> (2026-09-02: "ROKA 3 meses, 5109 movimientos, 3851 `distinguir_tercero_de_socio`" — `3851 =
> 3843+8`), y esta misma síntesis del documento ("1414 Bracci, 3851 ROKA"). **El número real y final
> es 5257** (1414 Bracci + 3843 ROKA), sobre 9055 movimientos, 9 lotes (6+3) — no 6293/10401/10.
> Detalle completo paso a paso: `HANDOFF.md` (199, la corrección) y `10-deuda-declarada.md` (B.20
> actualizado, B.22 cerrado).
>
> <details><summary>Corrección del 2026-09-08 (histórica, su conclusión sobre el origen de "3843"
> quedó reemplazada arriba — se deja sin borrar por disciplina de no reescribir lo que se creyó en su
> momento)</summary>
>
> El "~9 `--aplicar`" de la fila de arriba y la cifra "3843 ROKA promoviendo" que circuló como
> "predicción de la Tanda 0" nunca quedaron escritas en ningún documento versionado del repo — un
> grep completo de `HANDOFF.md` y `docs/` no encuentra "3843" en ninguna entrada anterior a esta
> corrección. Era una proyección de planificación (de un archivo de plan local de la sesión, no de un
> doc del repo), calculada sobre el corpus de ROKA de ese momento (3 lotes), y nunca se sometió a la
> misma verificación cruzada que sí se le exigió al número final de esta entrada. El corpus de ROKA
> creció a 4 lotes entre esa proyección y la corrida real (ingesta operativa normal). El número real
> y verificado es 4879 promociones en ROKA (1414 Bracci + 4879 ROKA = 6293 total).
>
> </details>

**Precondiciones de seguridad para toda la línea** (unánimes, no negociables): ninguna migración nueva
toca el piloto antes de cerrar el guard de `sembrar()` por DSN real (10-deuda-declarada, 0039);
decisiones y claves de grupo nunca entran al objeto de evidencia del motor (bug del digest, 187); `for
share`/`for update` en todo escritor nuevo (188); vocabulario cerrado, cero prosa libre nueva (193);
`app_job` sin grants en ninguna tabla nueva.

### Qué NO se construye

- Más `padron_contraparte` (fuzzy, subcuenta por proveedor, cargar ROKA por ahora): techo 5,5%.
- `apps/web` antes de que el round-trip por planilla demuestre que Laura completa las hojas.
- Fusión PDF+Excel fila a fila: la regla es una fuente vigente por cuenta-período, gana la que cuadra.
  Adaptadores Excel: tamaño de "banco nuevo" cada uno, solo si se mide que aportan algo.
- Promoción por heurística de N apariciones dentro de `nucleo/`: bump + reproceso total + ADR; la
  manifestación logra más con menos.

### Decisiones que solo JP puede tomar (consolidadas de los 5)

1. **Pedirle a Laura la manifestación de padrón de socios completo** por cliente y con fecha.
2. **Aceptar la meta del próximo entregable:** "julio de Bracci en ≤40 líneas + excepciones".
3. **Política PDF/Excel:** adoptar "una fuente vigente por cuenta-período, gana la que cuadra" y
   reabrir el descarte de los Excel de Macro solo si la Tanda 0 muestra que aportan algo.
4. **Tres preguntas para Laura:** qué socios también facturan honorarios, qué sistema y formato de
   importación usa, y si acepta N = 3 y tope ×2 como criterio de recurrencia.

### ADR a escribir antes de tocar código

`ADR-0003` (la cola tiene memoria — `decision_revision`), `ADR-0004` (una fuente vigente por
cuenta-período). `ADR-0005` (tercer constructor de `propuesta`) solo si después de la Tanda 2 la
ratificación en bloque no alcanza.
