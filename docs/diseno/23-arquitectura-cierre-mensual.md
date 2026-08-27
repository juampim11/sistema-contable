---
Documento de Project Knowledge — 14 (copiado al repo como docs/diseno/23-arquitectura-cierre-mensual.md
el 2026-08-26, para que Claude Code pueda leerlo — vive originalmente en Project Knowledge de
Claude.ai, no en el repo)
Creado: 2026-08-25 — sesión de diseño de arquitectura de producto sobre el flujo de cierre mensual
de `13`. Tres miradas separadas (contable / arquitectura / producto), en orden, cada una escrita
después de leer la anterior. **Es diseño de referencia, no implementación**: nada de esto se
escribió como código, y ninguna de las convocatorias de agentes de este documento fue real —
son dictámenes de diseño para preparar la convocatoria real, no para reemplazarla.
---

# Arquitectura del cierre mensual por cliente — diseño de referencia

> **Cuándo leer este documento**: antes de construir cualquier cosa que toque más de una fuente de
> datos de un mismo cliente (extractos + FCI + tarjetas + Libro IVA). Si lo que vas a construir toca
> una sola fuente y no persiste asientos, probablemente no lo necesites.
>
> **Qué NO cubre a propósito**: frontend, hosting y proveedor de nube. Son decisiones de
> infraestructura de distribución, se resuelven después sin afectar nada de lo que sigue.

## Restricciones heredadas — datos de entrada, no preguntas

Estas cuatro no se rediscuten en este documento. Se citan porque el diseño se apoya en ellas.

1. **Backend y base**: TypeScript + PostgreSQL con RLS. Construido y probado contra el piloto real.
2. **Patrón "nunca se edita, se supersede"** (`03`): probado a escala de un movimiento
   (`reconocimiento_contrapartida`, `padron_manifestacion`). Si escala a la unidad grande era la
   pregunta abierta de `13` — la sección 2 la responde, y la respuesta **no es un sí liso**.
3. **Firma de adapters nuevos** (`13`, 2026-08-25): cliente/tenant como parámetro explícito; banco y
   tipo de documento como valores de catálogo validables. Es, literalmente, el contrato de
   acoplamiento con la entidad central de este documento.
4. **`R40`**: todo índice único no-PK sobre tabla con columna de tenant incluye esa columna.

## 🔴 Dónde este diseño se corre de algo ya escrito — declarado antes de proponerlo

| Qué | Qué decía antes | Qué propone este documento | Por qué |
|---|---|---|---|
| Alcance del período | `13` habla de "cierre **mensual**" | La entidad lleva `tipo_periodo` (`mensual` \| `ejercicio`) desde el día uno | El eje 3 de FCI y el revalúo USD (`05`, `12`) son de **cierre de ejercicio**, no mensuales. Si el modelo fija "mes", esos ajustes no tienen dónde vivir y aparece una segunda entidad paralela |
| Supersesión a escala grande | `13` la plantea como hipótesis a validar | **Mixto**: supersesión donde hay contenido, máquina de estados con historial donde hay proceso | Ver §2.4. Superseder el cierre entero o duplica todo su contenido en cada corrección, o no significa nada |
| Registro de documentos ingeridos | `13` fija la firma de los adapters **nuevos**, sin migrar los viejos | Se propone una tabla de registro única (`documento_ingerido`) con **backfill de los 3 lotes existentes** | No contradice `13` — `13` habla de firmas de función, no de esquema. Pero toca datos reales del piloto (3 filas), así que hay que decirlo, no colarlo |
| Plan de cuentas versionado | `10` §2 lo recomienda con evidencia, **sin decisión formal** | Este diseño lo **asume** como dependencia (`plan_cuentas_version_id`) | Es una dependencia declarada, no una decisión tomada acá. Si `plan-cuentas-multicliente` decide vigencia por cuenta en vez de versión completa, la sección 2 cambia |

---

# 1. Dictamen de `contador-dominio`

## 1.1 ¿El flujo de 9 pasos tiene sentido contable? Sí, con cuatro pasos faltantes y un reordenamiento

El planteo de JP es correcto en su columna vertebral y describe bien el trabajo real. Lo que le falta
no son detalles: son cuatro momentos del cierre que el flujo, tal como está, no tiene dónde poner.

### Falta el paso 0 — apertura del período

El paso 1 arranca juntando documentación del mes. Pero un cierre contable no arranca en cero: arranca
en el estado de cierre del período anterior. Esto no es teoría, ya lastimó dos veces en este proyecto:

- **FCI, junio de Elite-IT: no verificable** porque su saldo inicial necesitaba el extracto de mayo,
  que no se tenía (`12` §7). Estructural, no bug.
- **El saldo inicial sin capas de costo** (`12` §4.1) sigue sin resolver de dónde sale cuando un
  cliente entra a mitad de ejercicio. Es la pregunta 3 de la ronda 3 a Laura.

El costeo PEPS es **dependiente del camino**: el resultado de un rescate de julio depende de qué
capas quedaron vivas en junio. Un cierre que no está encadenado al anterior no puede producir un
resultado de FCI correcto, y peor, puede producir uno que *parezca* correcto.

> **Paso 0 — apertura**: saldos contables de cierre del período anterior y stocks vivos (capas de
> FCI, tenencia en USD), o declaración explícita de "apertura sin historial" con el dato tomado de
> otra fuente. Nunca implícito.

### Falta el paso 3.5 — cuadratura por fuente, antes de consolidar

El paso 4 de JP ("consolidación y tipificación") supone que lo que se persistió está completo. No hay,
hoy, un control declarado que lo garantice por cuenta y por período: *saldo inicial del extracto +
movimientos capturados = saldo final del extracto*, tolerancia cero.

El proyecto ya sabe hacer esto — es exactamente la disciplina de ejes ortogonales que ya se aplicó en
liquidaciones de tarjeta (`09`, eje 1 aritmético, tolerancia cero) y en FCI (`12` §2). Lo que falta es
aplicarla al extracto bancario, que es la fuente que **no tiene hoy ningún eje declarado**. Y hay
evidencia de que hace falta: la reconciliación PDF↔Excel nativo de Santander dio 0% de coincidencia
exacta sin causa aislada (`11`, housekeeping), y la caracterización de `01` sobre "unas pocas líneas
no capturadas" puede estar subestimando el problema.

Sin este paso, el asiento del paso 7 puede balancear perfecto y estar incompleto. Un asiento que
balancea con movimientos faltantes es peor que uno que no balancea, porque no avisa.

### Falta el paso 5.5 — ajustes de cierre sin documento fuente

Este es el faltante más importante desde la mirada contable. Los pasos 1 a 5 son todos
**dirigidos por documento**: llega un papel, se procesa, sale un asiento. Pero un cierre contable
real incluye asientos que **ningún documento produce**:

- **Eje 3 de FCI** — valuación al cierre: cantidad remanente × valor unitario de cierre, y su
  devengamiento (`12` §2). Bloqueado por la ronda 3 de Laura.
- **Revalúo de tenencia en USD** — `05` documenta que las dos cuentas de resultado existen separadas
  y distintas en los planes reales: `Diferencia de Cambio` (por movimiento, realizada) y
  `Resultado Dif de Cotización (tenencia)` (revalúo a cierre). La distinción es real en la
  contabilidad de Laura; el modelo tiene que respetarla.
- La familia general que este producto todavía no tocó: amortizaciones, devengamiento de intereses,
  provisiones.

El flujo de `13` no tiene ningún lugar donde esto ocurra. Si se construye tal cual, el primer cierre
de ejercicio va a chocar contra un modelo que solo sabe convertir documentos en asientos.

> Nota de honestidad: este paso queda **identificado pero no diseñable hoy**. Las dos piezas
> concretas que lo poblarían (eje 3 FCI, timing de la diferencia de cambio) están bloqueadas
> esperando respuesta de Laura. Lo correcto es dejarle el lugar en el modelo, no inventarle el
> contenido.

### Falta el bloqueo del paso 9 — cerrar tiene que cerrar

El paso 9 dice "se confirma el asiento y se cierra el proceso". Contablemente, cerrar un período
significa que ese período **deja de aceptar imputaciones nuevas** sin un acto explícito de
reapertura. Hoy nada de eso existe, y el problema ya está anticipado en el proyecto desde otro
ángulo: `09` Frente 1 deja abierta la pregunta de "cómo tratar una corrección retroactiva del valor
cacheado de cotización **sin reabrir en silencio un asiento ya propuesto**".

Es el mismo problema. Si el banco manda un extracto corregido de julio en septiembre, o si se
corrige una cotización cacheada, el julio confirmado no puede cambiar solo. La reapertura es un
evento con motivo, autor y rastro — no un efecto lateral de un `UPDATE`.

### Reordenamiento: el paso 6 no es un paso, es dos momentos distintos

El paso 6 ("se muestran los ítems que el sistema no pudo tipificar") está ubicado después del armado
preliminar del asiento y antes de verlo. En la práctica, hay **dos intervenciones humanas de
naturaleza contable distinta**, y colapsarlas oculta que una se puede delegar y la otra no:

1. **Resolución de identidad/tipificación** (antes de que el asiento se pueda armar): "¿esta
   transferencia es de la socia o de un cliente?". Es el paso 6 propiamente dicho, y es el que Laura
   ya está haciendo hoy en el export enriquecido (`05`).
2. **Revisión del asiento consolidado** (después de armado): "¿este asiento refleja bien el mes de
   este cliente?". Es un juicio profesional sobre el conjunto, no sobre una fila.

La segunda es la que compromete firma. La primera, no necesariamente. Es la diferencia entre "que lo
clasifiquemos nosotras" y "yo firmo el balance".

### El flujo corregido

| # | Paso | Estado en el sistema hoy |
|---|---|---|
| **0** | **Apertura: saldos y stocks del período anterior** | **No existe** |
| 1 | Recolección de documentación del período | Manual, fuera del sistema |
| 2 | Identificación e ingesta (cliente + banco + tipo de documento) | Resuelto a nivel de firma en adapters nuevos (`13`) |
| 3 | Procesamiento y persistencia por documento | Existe para extracto; preliminar para FCI; sin persistencia para tarjeta |
| **3.5** | **Cuadratura por fuente, tolerancia cero** | **Existe en FCI y tarjeta; no existe para extracto** |
| 4 | Consolidación multi-fuente (cruces internos, cálculos, liquidación↔extracto) | No existe la consolidación; existen las piezas sueltas |
| 5 | Tipificación y armado preliminar del asiento (Capa D) | No existe (Capa D sin arrancar) |
| **5.5** | **Ajustes de cierre sin documento fuente** | **No existe, y hoy no es diseñable (bloqueado por Laura)** |
| 6 | Resolución humana de pendientes | Existe el motivo (`queDecide`); falta el rastro de quién resolvió |
| 7 | Asiento consolidado a la vista | No existe |
| 8 | Reproceso / supersesión | Patrón probado a escala chica (`03`) |
| **9** | **Confirmación + bloqueo del período; reapertura como evento auditado** | **No existe** |

## 1.2 Qué necesita el asiento del paso 7 para ser correcto, viniendo de varias fuentes

Los dos casos de prueba reales que ya tenemos dicen cosas distintas y complementarias.

### Caso A — venta con tarjeta (`05`): tres fuentes, un asiento, dos fechas

El asiento que dio Laura tiene seis renglones. Su modelo es explícito: **la venta se devenga siempre
desde el Libro IVA Ventas contra Deudores por Ventas, sin importar el medio de pago; el movimiento
bancario de la acreditación no es la venta, es la cancelación de ese crédito.**

De ahí salen cuatro exigencias concretas:

1. **El asiento consolidado se alimenta de renglones de documentos distintos.** El renglón "Banco
   neto acreditado" viene del extracto; "comisión + IVA CF + retención IIBB + retención IVA" vienen
   de la **liquidación de la procesadora**, no del banco; "a Deudores por Ventas" cierra contra el
   devengamiento del Libro IVA Ventas. Tres fuentes. Sin liquidación ingerida, el asiento no cierra —
   y eso ya está identificado como el bloqueo más directo para ROKA (`05`, `09`).

2. **Cada renglón tiene que citar de qué documento y de qué línea salió.** No es prolijidad: es la
   única forma de responder "¿qué renglón es sospechoso?" cuando la fuente no cuadra. Y no cuadra
   seguido: Cabal débito da **0 de 4 liquidaciones que pasen la aritmética** (`09`).

3. **El estado de verificación de la fuente viaja hasta el renglón, sin colapsarse.** Si la comisión
   salió de un OCR marcado `dudoso`, el asiento tiene que mostrarlo. `09` ya fijó la doctrina: los
   ejes son ortogonales, "¿cierra la cuenta?" y "¿confío en esta lectura?" son dos preguntas
   distintas y nunca se funden en un solo estado.

4. **La fecha de imputación es por renglón, no por asiento — y puede cruzar el período.** Una venta
   del 30/06 acreditada el 02/07 devenga en junio y se cancela en julio. Un modelo que asume "el
   cierre de julio contiene solo cosas de julio" se rompe con el primer caso real.

   **Simplificación importante, apoyada en evidencia**: Laura confirmó que el formato del asiento es
   **agrupado por cuenta contable** (`05`). Eso significa que la cancelación va contra Deudores por
   Ventas **en bloque, no comprobante por comprobante**. El modelo **no necesita partida abierta ni
   conciliación factura↔cobro en la primera versión** — necesita solamente una regla de fecha de
   imputación declarada por renglón. Es una simplificación grande y está fundada en cómo trabaja
   ella, no en una conveniencia técnica.

### Caso B — FCI (`12`): el renglón que ningún documento produce

El asiento de reimputación (`Inversiones a Rendimientos inversiones`) es el caso testigo de un
renglón **sin origen documental**: nace del inventario PEPS, no de una línea de un PDF. Exigencias
propias:

5. **Referencia a las capas consumidas, no solo el total.** Ya está decidido en la implementación:
   *"no alcanza con `costo_estimado = true`, hace falta saber a qué capa y por qué"* (`12` §4.1). El
   asiento consolidado tiene que **preservar** esa referencia, no aplanarla en un importe.

6. **La frecuencia del asiento de reimputación está sin responder** (pregunta 7 de la ronda 3: ¿uno
   por rescate o uno mensual consolidado por fondo?). El modelo tiene que **soportar las dos**,
   porque la respuesta no está y elegir una ahora la fija en el esquema.

7. **La cuenta se resuelve por rol funcional contra `cuenta_id` interno, nunca por código literal** —
   dictamen ya emitido por `plan-cuentas-multicliente` (`06`). Con tres planes reales en mano, el
   código `1.7.0.000` significa "Inversiones" en Bracci y "Bienes intangibles" en ROKA y Elite-IT
   (`10`, `12` §10).

### Lo mínimo, en una lista

**Por renglón:** `cuenta_id` interno · importe · signo · fecha de imputación · referencia a la fuente
(documento + línea) · estado de verificación heredado · referencia de resolución de identidad cuando
la cuenta es derivada (cuenta particular ← `socio_id`) · referencia de valuación cuando hubo
conversión de moneda (cotización usada: fuente, fecha, comprador/vendedor) o costeo (capas
consumidas).

**Por asiento:** cliente · período · **versión del plan de cuentas usada** · tipo (devengamiento /
cancelación / ajuste de cierre / reimputación) · la lista de fuentes que lo componen, con su estado
de completitud.

## 1.3 El paso 6 — no hay audiencias que modelar; la distinción real es de ciclo de vida

`13` identificó dos carriles en el paso 6: lo que requiere conocimiento específico de Laura sobre ese
cliente, y lo que requiere criterio contable general que cualquiera del equipo puede resolver. La
evidencia detrás es **una sola frase, dicha dos veces**: *"déjenlo para que lo clasifiquemos
nosotras"*, en la revisión del export enriquecido de Santander.

**🟢 Resuelto por JP (2026-08-25): es sistema→humano, no enrutamiento entre personas.** La frase
significa *"no lo intentes clasificar, esto lo hacemos a mano"* — el límite entre lo que el motor
propone y lo que resuelve una persona. **No hay ninguna audiencia que modelar.**

La lectura alternativa que se había considerado —enrutamiento a otra persona del estudio, con roles
y eventualmente permisos— queda descartada. Se deja escrita acá para que ninguna sesión futura la
vuelva a inferir de la misma frase.

### Lo que sí está bien fundado — y es una distinción de ciclo de vida, no de audiencia

Confirmado también por JP: buena parte de lo que hoy queda pendiente **no es una duda de criterio,
es un documento que todavía no entró al sistema** — comprobantes de ARCA, Libro IVA Compras, Libro
IVA Ventas.

Evidencia registrada:

- COMPRA DEBITO y honorarios, estructuralmente en `sin_reconocer` por falta de Libro IVA Compras
  (`02`, `05`).
- FCI y tarjeta corporativa en Galicia: literales ya reconocidos en el léxico, con su plantilla de
  asiento ya decidida, bloqueados como `implementacion_diferida` — 12,8% de los `sin_reconocer` de
  ese banco (`02`, 2026-08-24).
- `completar_con_liquidacion_del_adquirente`: 137 movimientos (`02`).

**La distinción real, entonces, es de ciclo de vida:**

| | Pendiente por documento faltante | Pendiente por decisión humana |
|---|---|---|
| Cómo se cierra | **Solo**, cuando la fuente que faltaba se registra contra el cierre | Alguien decide y deja el rastro |
| Dónde vive el problema | Paso 1/2 — completitud de la documentación | Paso 6 — cola de revisión |
| Qué hay que mostrarle a Laura | *"te faltan 2 de 5 documentos"* | *"estos 12 ítems necesitan que alguien los mire"* |

Y **no hace falta columna nueva para representarlo**: el `motivo` (`queDecide`) ya lo dice. Lo que
falta es **comportamiento**, no esquema:

> **Regla de diseño**: al registrar una `fuente_cierre` nueva contra un cierre, los pendientes
> abiertos de ese cierre se **re-evalúan**. Los que esperaban ese documento se cierran solos, sin
> intervención. Un pendiente que sigue abierto después de que llegó todo lo esperado **sí** es de la
> cola del paso 6.

**Sobre los comprobantes de ARCA, para que no se busque una API que no existe**: `08` §5 lo dejó
verificado contra el catálogo oficial completo — **no hay web service de lectura de Mis Comprobantes
ni de Libro IVA Digital**. La única vía compatible con la arquitectura es la (d) de `08` §5.3:
**el contador exporta el archivo y lo sube**, un adaptador de ingesta más. O sea, ARCA no es una
fuente aparte en este modelo: entra por el mismo `documento_ingerido`, con `tipo_documento` propio.
Es la misma familia de decisión que FCI y tarjetas, que `08` §10 y `11` ya recomiendan resolver
juntas.

### Conclusión del dictamen

> El paso 6 **no necesita una dimensión nueva en esta versión**. `queDecide` (8 valores) alcanza para
> decir por qué un pendiente está abierto. Lo único que conviene sumar es un rastro de **quién lo
> resolvió** (`resuelto_por`, `resuelto_en`) — que es un registro, no una compuerta de aprobación.

Queda **una sola** pregunta abierta del paso 6, y no bloquea nada de este diseño:

> Con el asiento del mes ya armado, ¿lo revisa o firma alguien distinto del que lo preparó, o lo
> cierra el mismo que lo procesa?

Importa para el paso 9. Hoy **no sabemos** si dentro del estudio existe un acto de aprobación
separado del de preparación — Laura o quien sea del estudio procesa toda la documentación y arma los
asientos; si después eso pasa por una firma, no está registrado en ningún lado del set `00`–`13`.
El único concepto de aprobación que el proyecto tiene escrito es *"el sistema propone, el contador
aprueba"*, que es el mismo límite sistema↔humano de arriba.

Mientras no haya respuesta, el diseño **no supone ningún circuito de firma interno**, y `confirmado_por`
es rastro de quién confirmó, no una compuerta.

> ⚠️ **Implicancia contable.** Esta sección describe criterios de cierre, imputación y valuación con
> efecto directo sobre el balance. Se apoya en lo que Laura describe y en la evidencia registrada en
> `05`, `09`, `10` y `12` — no en una revisión normativa propia. **Validar con profesional
> matriculado antes de que esto produzca un asiento real.**

---

# 2. Dictamen de `arquitecto-software`

Escrito después de leer la sección 1. Tres cosas del contador cambian el modelo respecto de lo que
`13` insinuaba: el encadenamiento con el período anterior, el paso 5.5 de cierre de ejercicio, y que
el paso 6 **no** suma ninguna dimensión nueva (ver §1.3 — se retiró una propuesta anterior por falta de evidencia).

## 2.1 La entidad central y sus vecinas — boceto concreto

Cinco tablas nuevas, más una que ya existe y hay que tocar. Todo lleva `cliente_id` y hereda las
policies de RLS existentes.

### `documento_ingerido` — el registro único de "qué se subió"

Es la pieza que hoy falta y que hace que todo lo demás sea uniforme. Es, literalmente, el paso 2 de
JP hecho esquema, y la decisión de BBVA de `13` (cliente explícito + banco y tipo de documento de
catálogo) **es su contrato de entrada**, ya tomada.

```
documento_ingerido
  id                    uuid PK
  cliente_id            uuid NOT NULL          -- tenant
  tipo_documento        enum NOT NULL          -- extracto | fci | liquidacion_tarjeta | libro_iva_compras | libro_iva_ventas
  banco_id              uuid NULL              -- catálogo N0, null para libro IVA
  periodo_desde         date NOT NULL          -- declarado por el extractor, no derivado del nombre de archivo
  periodo_hasta         date NOT NULL
  cobertura             enum NOT NULL          -- completo | parcial | corte_a_fecha
  objeto_almacenamiento text NOT NULL
  ingerido_en           timestamptz NOT NULL
  superseded_by_id      uuid NULL              -- re-ingesta del mismo documento corregido
```

**Por qué una tabla y no tres FK nulables en la tabla del cierre.** El arco excluyente
(`lote_id` / `liquidacion_id` / `extraccion_fci_id`, uno no nulo) funciona con tres fuentes y se
rompe con la cuarta — y ya sabemos que vienen Libro IVA Compras y Ventas. Con `documento_ingerido`,
sumar una fuente nueva es una fila de catálogo, no una migración con columna nueva.

**Costo real, declarado**: `lote` ya existe con 3 filas reales en el piloto. Hay que colgarlas de
`documento_ingerido` con un backfill. Son **3 filas**, no una reescritura de los adapters viejos —
`13` decidió no migrar las *firmas* de Galicia/Macro/Santander, y esa decisión sigue intacta.

**Un documento puede satisfacer varias expectativas**: BBVA trae multi-cuenta en un solo PDF (`13`).
Por eso la relación con `fuente_cierre` es 1:N, no 1:1.

### `cierre_cliente_periodo` — la entidad central

```
cierre_cliente_periodo
  id                      uuid PK
  cliente_id              uuid NOT NULL
  tipo_periodo            enum NOT NULL          -- mensual | ejercicio
  periodo_desde           date NOT NULL
  periodo_hasta           date NOT NULL
  estado                  enum NOT NULL          -- abierto | en_ingesta | en_consolidacion
                                                 -- | en_revision | confirmado | anulado
  cierre_anterior_id      uuid NULL              -- encadenamiento; FK tenant-consistente
  plan_cuentas_version_id uuid NULL              -- congelado al confirmar. DEPENDENCIA, ver §2.5
  confirmado_en           timestamptz NULL
  confirmado_por          uuid NULL
```

`cierre_anterior_id` es el paso 0 del contador hecho columna: sin él, el motor de FCI no tiene de
dónde tomar las capas vivas y el revalúo USD no tiene stock de apertura.

`confirmado_por` arrastra la limitación del **incidente #8** (`04`): *identidad declarada no es
identidad autenticada*. La fila del rastro puede salir genuina y mal atribuida. El comentario de
columna que lo explica no es prolijidad — si alguien lo borra "por limpieza", el rastro vuelve a
leerse como prueba de autoría sin serlo.

### `expectativa_fuente_cliente` — el "2 de 5", y cómo se llena sin un formulario

La objeción obvia: *"¿cómo va a saber el sistema cuántos documentos faltan, si hay clientes con FCI
y otros sin, con tarjeta y sin?"*. La respuesta es que **la expectativa se deduce casi entera de
datos que ya existen**; no es una planilla que alguien completa por cliente.

```
expectativa_fuente_cliente
  id               uuid PK
  cliente_id       uuid NOT NULL
  tipo_documento   enum NOT NULL
  banco_id         uuid NULL
  cuenta_id        uuid NULL
  periodicidad     enum NOT NULL      -- mensual | anual | eventual
  origen           enum NOT NULL      -- declarado | inferido_de_movimiento | inferido_de_historico
  evidencia        jsonb NULL         -- qué disparó la inferencia (literal, movimiento, período)
  confirmada       boolean NOT NULL   -- el contador la ratificó o la descartó
  vigencia_desde   date NOT NULL
  vigencia_hasta   date NULL
  superseded_by_id uuid NULL
```

**Las cuatro fuentes de la expectativa, de más barata a más cara:**

| # | De dónde sale | Qué deduce | Costo |
|---|---|---|---|
| 1 | **Las cuentas bancarias ya declaradas** | ROKA tiene 3 cuentas en Macro → espera 3 extractos/mes. Bracci 2 en Galicia → 2 | Cero: el dato ya está en la base |
| 2 | **Literales del propio extracto** | `SUSCRIPCION FIMA` → tiene FCI. `ACREDITAMIENTO PRISMA/FIRSTDATA` → tiene tarjeta. `PAGO VISA EMPRESA` → tarjeta corporativa. `COMPRA DEBITO` → falta comprobante | Cero: **el motor ya lo emite hoy** |
| 3 | **Saldo de la cuenta puente** | Si "Fondos en tránsito" no cierra en cero al fin del período, falta el otro extremo de la transferencia → falta un extracto | Cero: es el razonamiento de la propia Laura (`05`) |
| 4 | **Histórico** | Llegó Cabal tres meses seguidos y este mes no → avisar | Cero |

El punto 2 es el que resuelve la objeción de fondo: **no hace falta preguntar "¿este cliente tiene
FCI?"**, el extracto lo delata. Y el motor ya lo dice — `completar_con_liquidacion_del_adquirente`
son 137 movimientos que significan literalmente "falta la liquidación" (`02`). Lo que falta no es
detectarlo: es **traducirlo de "137 filas dudosas" a "te falta 1 documento"**.

Solo el punto 1 es irreductible y tiene que estar declarado: un extracto nunca menciona las otras
cuentas del cliente. Ya está declarado hoy.

**Los dos límites reales, declarados para no venderlo mejor de lo que es:**

- **El primer período de un cliente nuevo, el sistema está ciego.** Sin histórico y sin movimientos
  ingeridos no hay de dónde inferir. La expectativa se puebla desde el segundo período, o alguien la
  declara a mano. Inevitable, no hay truco.
- **La deducción es asimétrica: solo detecta lo que deja rastro en el banco.** Si un cliente tiene
  FCI en un banco donde no ingerimos la cuenta corriente, no hay señal — **es exactamente el caso de
  Pannonica** (`12` §15), donde el material de FCI llegó por un canal aparte. Y el Libro IVA Compras
  hace falta siempre para un Responsable Inscripto, haya o no `COMPRA DEBITO` en el extracto (una
  compra pagada en efectivo no deja rastro bancario). Eso último se resuelve por **condición ante
  IVA**, que es justo el dato que `ws_sr_constancia_inscripcion` podría traer y hoy no tenemos
  (`08` §3.1, sin probar; es además el eje que `plan-cuentas-multicliente` va a necesitar igual).

**Consecuencia de producto**: `expectativa_fuente_cliente` no es "una tabla que alguien llena" sino
**una tabla que el sistema propone y el contador corrige** — `origen` + `evidencia` + `confirmada`
existen para eso. Mismo patrón que ya funcionó en el export enriquecido: el silencio en las filas de
confianza alta **es** la aprobación (`05`), no se le pide confirmar cada una.

Con esto, el sistema puede decir *"para ROKA, julio necesita 3 extractos + 1 liquidación + 1 resumen
de FCI, y hoy tengo 2 de 5"* — la pregunta que `13` señala como no representable hoy — sin haberle
pedido a nadie que cargue esa lista.

### `fuente_cierre` — el enganche uniforme

```
fuente_cierre
  id                    uuid PK
  cliente_id            uuid NOT NULL
  cierre_id             uuid NOT NULL
  documento_ingerido_id uuid NOT NULL
  expectativa_id        uuid NULL          -- null = llegó algo que nadie esperaba (caso legítimo)
  cuenta_id             uuid NULL
  estado_cuadratura     jsonb NOT NULL     -- resultado multi-eje, ver §2.3
  superseded_by_id      uuid NULL
```

`expectativa_id` nulo es un caso real y esperable, no un error: llegó un documento que la
configuración del cliente no preveía. El sistema lo registra y lo muestra; no lo rechaza.

### `pendiente_cierre` — la cola del paso 6, con las dos dimensiones

```
pendiente_cierre
  id                          uuid PK
  cliente_id                  uuid NOT NULL
  cierre_id                   uuid NOT NULL
  fuente_cierre_id            uuid NULL          -- null para pendientes de consolidación
  referencia_origen           text NULL          -- digest del renglón de la fuente
  motivo                      enum NOT NULL      -- el queDecide actual, 8 valores
  estado                      enum NOT NULL      -- abierto | resuelto | superseded
  resuelto_por                uuid NULL          -- rastro, no compuerta de aprobación
  resuelto_en                 timestamptz NULL
  resolucion_id               uuid NULL
  superseded_by_id            uuid NULL
```

**Sin columna de destinatario ni de carril** — ver §1.3. `queDecide` (`motivo`) alcanza para decir
por qué el pendiente está abierto; `resuelto_por` deja rastro de quién lo cerró. Si la respuesta de
Laura confirma que hay enrutamiento real entre personas del estudio, es una columna más con un
enum — barato de agregar, porque no obliga a re-clasificar nada (hoy no hay ningún pendiente
persistido).

### `asiento_propuesto` + `asiento_propuesto_renglon` — el paso 7

```
asiento_propuesto
  id                      uuid PK
  cliente_id              uuid NOT NULL
  cierre_id               uuid NOT NULL
  tipo                    enum NOT NULL   -- devengamiento | cancelacion | ajuste_cierre | reimputacion
  fecha_imputacion        date NOT NULL
  plan_cuentas_version_id uuid NOT NULL
  total_debe              numeric NOT NULL
  total_haber             numeric NOT NULL
  estado                  enum NOT NULL   -- propuesto | confirmado | superseded
  superseded_by_id        uuid NULL
  CHECK (total_debe = total_haber)

asiento_propuesto_renglon
  id                        uuid PK
  cliente_id                uuid NOT NULL
  asiento_id                uuid NOT NULL
  orden                     int NOT NULL
  cuenta_id                 uuid NOT NULL      -- interno, nunca código del cliente (R42)
  debe                      numeric NOT NULL DEFAULT 0
  haber                     numeric NOT NULL DEFAULT 0
  fecha_imputacion          date NOT NULL      -- por renglón: puede diferir del asiento (§1.2, punto 4)
  fuente_cierre_id          uuid NULL          -- null = renglón sin origen documental (reimputación FCI)
  referencia_origen         text NULL
  verificacion_heredada     jsonb NOT NULL
  padron_manifestacion_id   uuid NULL          -- cuando la cuenta es derivada de identidad
  valuacion_ref             jsonb NULL         -- cotización usada, o capas de FCI consumidas
```

**Sobre el invariante debe = haber, con honestidad.** Materializar los totales con un `CHECK` es la
parte fácil. Mantenerlos coherentes con los renglones exige un trigger, y un trigger corre bajo RLS —
lección del **incidente #2**: *"un invariante verificado con la visibilidad del escritor no es un
invariante"* (`04`). Acá el agregado es intra-tenant, así que el riesgo es menor que en el caso de la
jerarquía, pero **no es cero y no hay que declararlo resuelto**. La posición recomendada: el control
duro vive en el acto de confirmar (verificación explícita, recalculada), y el `CHECK` es defensa en
profundidad, no la garantía. Que quede escrito así en el comentario de columna.

**El asiento cita, no recalcula.** `valuacion_ref` guarda la cotización usada (fuente, fecha, tipo),
no una fórmula que se re-evalúe. Si mañana se corrige el valor cacheado de BNA, el asiento confirmado
sigue diciendo lo que dijo. Esto responde de forma directa la pregunta que `09` Frente 1 dejó abierta
("cómo tratar una corrección retroactiva sin reabrir en silencio un asiento ya propuesto"): no se
reabre solo, porque el asiento no depende del valor vivo.

## 2.2 `R40` aplicado, tabla por tabla

Todos los índices únicos no-PK, con la columna de tenant adelante y parcializados por vigencia donde
hay supersesión:

```sql
-- un solo cierre vigente por cliente/tipo/período
UNIQUE (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
  WHERE superseded_by_id IS NULL;

-- un documento no se registra dos veces para el mismo alcance
UNIQUE (cliente_id, tipo_documento, banco_id, periodo_desde, periodo_hasta, objeto_almacenamiento)
  WHERE superseded_by_id IS NULL;

-- una expectativa vigente por combinación
UNIQUE (cliente_id, tipo_documento, banco_id, cuenta_id, vigencia_desde);

-- una fuente por (cierre, documento, cuenta)
UNIQUE (cliente_id, cierre_id, documento_ingerido_id, cuenta_id)
  WHERE superseded_by_id IS NULL;

-- orden de renglón estable dentro del asiento
UNIQUE (cliente_id, asiento_id, orden);

-- un pendiente vigente por origen
UNIQUE (cliente_id, cierre_id, fuente_cierre_id, referencia_origen, motivo)
  WHERE superseded_by_id IS NULL;
```

Advertencia heredada de `03` (ítem 1 del bloque no bloqueante): **ningún `ON CONFLICT` contra estos
índices parciales** — el índice de cardinalidad no es una clave de upsert.

Sobre RLS: **no escribir funciones `SECURITY DEFINER` nuevas para esto.** La condición dura de `04`
sigue vigente (la recursión en `accessible_tenant_ids()` solo no explota porque el dueño del esquema
es superusuario). Toda tabla nueva se apoya en las policies existentes. Si alguna función nueva
resultara inevitable, `search_path` con `pg_temp` excluido, sin excepción (incidente #1).

## 2.3 Qué les falta a los contratos de salida actuales — campo por campo

Los tres contratos existentes (`movimiento_bancario_crudo` + reconocimiento, `FondoExtraido` /
`MovimientoFci`, y el contrato de liquidaciones de `09`) no pueden alimentar la entidad central tal
como están. Falta esto, y es específico:

| # | Campo faltante | Extracto | FCI | Liquidación | Por qué |
|---|---|---|---|---|---|
| 1 | `clienteId` en el contrato de salida | ✅ (adapters nuevos) | ❌ | ❌ | El script de FCI es preliminar y trabaja sin tenant — Pannonica ni siquiera lo tiene (`12` §15). Ya decidido para adapters nuevos (`13`), falta llevarlo a FCI y tarjeta |
| 2 | `periodoDesde` / `periodoHasta` / `cobertura` declarados por el extractor | ❌ | ⚠️ implícito (corte a fecha) | ⚠️ por liquidación | Hoy el período se deriva por fuera, para el nombre del archivo exportado (`01`). Para amarrar documento↔cierre tiene que ser un campo del contrato, no una inferencia |
| 3 | `saldoInicial` / `saldoFinal` declarados | ❌ | ⚠️ se extrae, no se normaliza | n/a | Es lo que habilita el paso 3.5. El dato existe en el PDF — el extractor de FCI-Santander tuvo que pelearse con `SALDO INICIAL`/`FINAL` (`09` Frente 4) — pero no viaja en el contrato |
| 4 | `verificacion` multi-eje normalizada | ❌ (sin ejes) | ✅ 3 ejes | ✅ 4 ejes | Hace falta un tipo común. **`no_verificable` tiene que ser valor de primera clase**: Cabal no publica total (`09`), junio de FCI no es verificable sin el extracto de mayo (`12` §7). No inventar un booleano |
| 5 | Digest estable por renglón | ✅ (`entrada_digest`, 0021) | ❌ | ❌ | Sin esto, un renglón del asiento no puede citar su origen ni la supersesión puede decir qué cambió. Mismo criterio que 0021: **columna generada por la base, no hash en TypeScript** |
| 6 | `moneda` explícita en el movimiento + hueco de valuación | ⚠️ vive en la cuenta | ⚠️ | ⚠️ | Hoy la moneda es propiedad de la cuenta (Santander USD, Macro USD). Funciona mientras una cuenta sea monomoneda; es frágil y no sobrevive al primer caso raro |
| 7 | Referencia de capa consumida en el resultado | n/a | ⚠️ existe en el motor, no en la salida | n/a | `12` §4.1 ya lo decidió como propiedad del cálculo. Falta que salga por el contrato hacia el cierre |
| 8 | N cuentas por documento | ✅ (BBVA) | ✅ (N fondos) | ✅ (N liquidaciones) | Ya resuelto en los tres, pero el contrato tiene que devolverlo explícito para que `fuente_cierre` arme N filas contra un `documento_ingerido` |

**Lo que ya funciona y no hay que tocar**: la premisa "extractor por banco, salida normalizada" está
validada dos veces — en Módulo 1 con tres bancos, y en FCI con dos bancos de estructura de PDF
completamente distinta que respetaron el mismo contrato (`12` §15). El diseño se apoya en eso, no lo
reemplaza.

## 2.4 🔴 ¿Escala la supersesión a la unidad grande? No tal cual — la respuesta es mixta

Es la pregunta abierta de `13` y merece una respuesta argumentada, no un sí cómodo.

Superseder un movimiento es barato: una fila, sin dependientes. Superseder un
`cierre_cliente_periodo` completo tiene dos salidas y las dos son malas:

- **Si se copia todo el contenido** (fuentes, pendientes, asientos, renglones), el volumen se
  multiplica en cada corrección. Un cierre con 3 extractos, 19 liquidaciones y 3 fondos, corregido
  cuatro veces, son cuatro copias completas de todo.
- **Si no se copia**, la fila nueva apunta a los mismos hijos y la supersesión no significa nada: no
  se sabe qué era distinto antes.

**Propuesta: supersesión donde hay contenido, máquina de estados con historial donde hay proceso.**

| Entidad | Mecanismo |
|---|---|
| `asiento_propuesto`, `asiento_propuesto_renglon` | **Supersesión** — es contenido, y el rastro de qué se propuso antes tiene valor contable real |
| `pendiente_cierre` y su resolución | **Supersesión** — mismo criterio que `reconocimiento_contrapartida` |
| `fuente_cierre`, `documento_ingerido` | **Supersesión** — re-ingesta de un documento corregido |
| `expectativa_fuente_cliente` | **Supersesión** — misma evidencia que el plan de cuentas: la configuración cambia y hay que poder explicar un cierre viejo |
| `cierre_cliente_periodo` | **Máquina de estados + `cierre_transicion` append-only** — no se supersede |

```
cierre_transicion
  id              uuid PK
  cliente_id      uuid NOT NULL
  cierre_id       uuid NOT NULL
  estado_desde    enum NOT NULL
  estado_hasta    enum NOT NULL
  motivo          text NOT NULL
  ocurrido_en     timestamptz NOT NULL
  hecho_por       uuid NULL
```

Reabrir un julio confirmado es una transición `confirmado → en_revision` con motivo obligatorio, que
a su vez **supersede los asientos confirmados de ese cierre**. Eso da el paso 9 del contador —
bloqueo real con reapertura auditada— sin duplicar el contenido entero.

Una advertencia heredada de `03` para `cierre_transicion`: el `hecho_por` nulo no es información, es
camuflaje. Ese fue el patrón exacto que costó cerrar el incidente #5 (`04`). Que la columna no acepte
nulo, o que el nulo tenga un significado declarado y pinneado por test.

## 2.5 Dependencias que este diseño no resuelve

- **`plan_cuentas_version_id` no tiene tabla detrás.** El modelo de plan versionado no existe y su
  forma está formalmente sin decidir (`10` §2 lo recomienda con evidencia real —Laura renombró
  cuentas de ROKA entre dos exportaciones— pero sin convocatoria). Todo el diseño de
  `asiento_propuesto` cuelga de eso.
- **`cuenta_id` interno tampoco existe todavía** — es la salida del adapter de ingesta del plan de
  cuentas, sin escribir (`10` §8).
- **P4/P5** (persistencia real de Capa C): `padron_manifestacion_id` como referencia del renglón
  supone que Capa C persiste. Hoy corre en dry-run desde 0021 (`03`, `11`).

---

# 3. Dictamen de `product-owner`

Escrito con las dos secciones anteriores a la vista.

## 3.1 ¿Hay que frenar los bancos nuevos? No. Pero la ventana se cierra pronto

**No frenar.** El riesgo de retrabajo de seguir con Bancor/ICBC/Nación es bajo y acotado, porque la
decisión más importante ya está tomada: los adapters nuevos reciben cliente explícito y tratan banco
y tipo de documento como catálogo (`13`). Eso **es** el contrato de acoplamiento con
`documento_ingerido`. Lo que les va a faltar son tres campos del contrato de salida (período cubierto,
saldo inicial/final declarado, digest por renglón), y agregarlos a adapters recién escritos es
barato.

Pero hay una secuencia que genera notablemente menos retrabajo que la otra:

> **Terminar BBVA (en curso) → congelar el contrato de salida común con lo aprendido de BBVA →
> recién ahí ICBC / Nación / Bancor.**

Congelar el contrato después del **primero** de los cuatro, no después del cuarto. La diferencia es
retrofitear 1 adapter o retrofitear 4. BBVA es además el mejor candidato para fijarlo, porque es el
que tiene multi-cuenta en un solo documento — el caso que obliga a que el contrato devuelva N cuentas
(§2.3, punto 8).

> 🔴 **Nota agregada al copiar este documento al repo (2026-08-26)**: en los hechos, BBVA terminó
> bloqueado (imagen pura, sin capa de texto — ver `09` Frente 5) y **Bancor fue el primer banco
> nuevo en cerrar**, no BBVA. El contrato de salida se congeló igual, antes de Nación, incorporando
> lo aprendido de Bancor en su lugar (`coberturaPeriodo`, `origenSigno` — el campo de digest por
> renglón se descartó del contrato de `packages/ingesta`, queda pendiente para `documento_ingerido`).
> Nación e ICBC ya cerraron también, cada uno con cliente real onboardado en el piloto. Ver `09`
> Frentes 6, 7 y 8, y `11`.

## 3.2 Lo que sí conviene frenar — y es una cosa sola

**No persistir ningún asiento hasta que la entidad central exista.** Y hay un ítem específico del
backlog parado justo en esa frontera, que es donde está el retrabajo más caro evitable hoy:

> **Commits 3 y 4 del plan 14** (liquidaciones de tarjeta: migración `formato_liquidacion` /
> `lote_liquidacion` / renglones + CLI de ingesta). Esa migración debería nacer **colgada de
> `documento_ingerido`**, no como un registro paralelo. Si se ejecuta antes, hay que migrarla
> después — con datos reales adentro y una convocatoria completa de seguridad de por medio.

Esto ratifica y extiende lo que `12` §11 ya decía por su cuenta ("el adapter oficial de ingesta de
FCI depende de Capa D, no se construye antes"). Es la misma frontera, vista desde la otra fuente.

Lo que **no** hay que frenar: el registro de los tres adapters de liquidación en `registro.ts`
(`11`, listo para ejecutar) — eso es reconocimiento, no persistencia. Y P4/P5 puede correr en
paralelo sin tocar nada de esto.

## 3.3 Orden propuesto

| # | Trabajo | Bloquea a | Convocatoria |
|---|---|---|---|
| 1 | Terminar BBVA | — | la que ya tiene |
| 2 | **Congelar el contrato de salida común** (los 8 campos de §2.3) — es TypeScript, sin migración | 3, 5 | `arquitecto-software` + `motor-conciliacion-contable` |
| 3 | Migración: `documento_ingerido` + backfill de 3 lotes + `cierre_cliente_periodo` + `cierre_transicion` + `expectativa_fuente_cliente` + `fuente_cierre` | 4, 6 | **completa**: `dba-data` + `security-engineer` + `seguridad-datos-financieros` + `arquitecto-software` |
| 4 | Commits 3/4 de liquidaciones, colgados de `documento_ingerido` | asiento de ROKA | la ya prevista en `09` |
| 5 | ICBC / Nación / Bancor con el contrato nuevo | — | la de cada adapter |
| 6 | Capa D formal + `pendiente_cierre` + `asiento_propuesto` | pasos 5–9 del flujo | `contador-dominio` + `plan-cuentas-multicliente` |
| ∥ | P4/P5 (persistencia real de Capa C) — en paralelo, sin dependencia | 6 | ya prevista |

## 3.4 Mínimo viable vs. segunda iteración

**La regla que separa las dos listas** (y que JP puede aplicar solo, sin volver a este documento):

> Va al MVP todo lo que, si se agrega después, **obligue a re-clasificar o re-migrar datos ya
> acumulados**. Queda para después todo lo que sea **agregar filas o valores** a algo que ya existe.

**MVP — lo mínimo para dejar de generar deuda:**

- `documento_ingerido` + el contrato de salida común. Sin esto, cada adapter nuevo y cada módulo
  nuevo suma deuda.
- `cierre_cliente_periodo` con `estado`, `tipo_periodo` y `cierre_anterior_id`, **aunque el flujo se
  opere a mano al principio**. Los tres campos son caros de agregar después: `tipo_periodo` obliga a
  re-clasificar todos los cierres existentes, `cierre_anterior_id` obliga a reconstruir cadenas
  hacia atrás.
- `expectativa_fuente_cliente` + `fuente_cierre` — el "2 de 5". Barato, y es lo que le da valor
  visible a Laura antes de que exista un solo asiento: el sistema le dice qué falta antes de que se
  dé cuenta ella.
- Supersesión en pendiente y asiento; `cierre_transicion` desde el día uno.
- Los estados `confirmado` y `anulado` en el enum desde el principio, aunque la reapertura no se
  implemente todavía.

**Segunda iteración — puede esperar sin generar deuda:**

- `asiento_propuesto` completo. Depende de Capa D, que depende del plan de cuentas versionado, que
  no existe.
- El paso 5.5 (ajustes de cierre sin documento): eje 3 de FCI y revalúo USD — **bloqueados por Laura
  de todos modos**, no por falta de diseño.
- La reapertura efectiva de un cierre confirmado. Se puede vivir un tiempo con "se anula y se
  rehace", siempre que el estado exista en el enum.
- Cualquier enrutamiento de pendientes entre personas del estudio, si la respuesta de Laura confirma
  que existe. Falla la regla de arriba: agregar la columna después no obliga a re-clasificar nada.
- Cierre de ejercicio operativo (`tipo_periodo = 'ejercicio'`). **El campo va desde el día uno; el
  flujo puede esperar.**

## 3.5 🔴 Riesgo de producto que hay que nombrar: el piloto no ejercita nada de esto

Bracci es un cliente de **un banco y una fuente**. Un diseño de cierre multi-fuente validado contra
Bracci pasa verde entero y explota con el primer caso real.

Es exactamente el mismo patrón que `10` §1 ya identificó para `R42`: las seis cuentas del asiento de
tarjeta coinciden de código en los dos planes **por casualidad**, así que una violación de `R42` en
el módulo de tarjetas *pasaría el piloto entero sin fallar* y explotaría con el cuarto cliente. La
lección se transfiere directo.

**Recomendación concreta**: el caso de trabajo obligatorio del diseño **no es Bracci**.

- **Caso primario: ROKA, julio 2026** — 3 cuentas en Macro (dos ARS, una USD) + las 3 liquidaciones
  reales de tarjeta que ya están analizadas (`09`) + la cuenta USD que necesita valuación. Es el
  único cliente del piloto que ejercita multi-fuente de verdad.
- **Caso secundario: H y J Servicios y Obras S.A.S.** (BBVA + Banco Nación, junio 2026) — el primer
  caso real de multi-banco, encontrado al revisar los extractos nuevos (`13`). No es cliente del
  piloto, pero es el único ejemplo concreto de la premisa central de este documento.

> 🔴 **Nota agregada al copiar este documento al repo (2026-08-26)**: H y J Servicios y Obras S.A.S.
> **ya es cliente del piloto** (tenant `26e90bbb-991c-4d3b-9ab8-799aaea1a8e3`), con su cuenta de
> Banco Nación cargada y verificada (1 movimiento, `cuadra`). Su cuenta de BBVA sigue bloqueada por
> OCR. Es, hoy, el primer caso REAL (no hipotético) de un cliente con una fuente viva y otra
> estructuralmente bloqueada al mismo tiempo — dato real disponible para validar
> `expectativa_fuente_cliente` con una fuente en estado `pendiente` genuino. Ver `13`, `09` Frente 7.

Y una consecuencia operativa que sale de ahí: **la valuación de Macro USD deja de ser un ítem suelto
del backlog y pasa a ser parte del caso de prueba del cierre.** Hoy está bloqueada por dos cosas
distintas — el comando `actualizar-cotizaciones.ts` sin escribir (`09` Frente 1, listo para ejecutar)
y el conflicto de timing de la diferencia de cambio sin respuesta de Laura (`05`). La primera se
puede destrabar sola; la segunda hay que incluirla en la próxima tanda de preguntas.

---

# 4. Síntesis — qué queda decidido y qué queda abierto

## 4.1 Decisiones de diseño tomadas en esta sesión

Se toman acá porque son consecuencia directa de evidencia ya registrada, no de una preferencia.

| # | Decisión | Fundada en |
|---|---|---|
| D-1 | La entidad central lleva `tipo_periodo` (mensual/ejercicio) desde el día uno | Eje 3 FCI y revalúo USD son de cierre de ejercicio (`05`, `12`) |
| D-2 | El cierre se encadena al anterior (`cierre_anterior_id`) | PEPS es dependiente del camino; junio de FCI no verificable sin mayo (`12` §7) |
| D-3 | Registro único `documento_ingerido`, no arco excluyente de FK nulables | Ya vienen Libro IVA Compras y Ventas como cuarta y quinta fuente |
| D-4 | El paso 6 **no suma dimensión nueva**: `queDecide` + `resuelto_por`. Sin destinatario, sin carril, sin roles | JP confirmó que *"lo clasificamos nosotras"* es el límite sistema↔humano, no enrutamiento entre personas del estudio |
| D-5 | `confirmado_por` es **rastro de quién confirmó, no compuerta**. El diseño no supone circuito de firma interno al estudio | El único "aprueba" escrito en el proyecto es sistema↔humano. Si la respuesta pendiente dice que no hay acto separado, la columna se puede sacar |
| D-5b | Un pendiente por documento faltante **se cierra solo** al registrarse la fuente. Se re-evalúan los pendientes abiertos en cada alta de `fuente_cierre` | §1.3 — es distinción de ciclo de vida, no de audiencia. No requiere esquema nuevo |
| D-5c | Los comprobantes de ARCA **no son fuente aparte**: entran como archivo exportado por el contador, mismo `documento_ingerido` | `08` §5 verificó contra el catálogo oficial que no existe API de lectura |
| D-5d | La expectativa de fuentes se **infiere** (cuentas declaradas + literales del extracto + cuenta puente + histórico) y el contador la corrige; no se carga a mano | §2.1 — el motor ya emite las señales; el primer período de un cliente nuevo es el único punto ciego, declarado |
| D-6 | Supersesión para contenido; máquina de estados + historial para el cierre | §2.4 — superseder el cierre entero o duplica todo o no significa nada |
| D-7 | El asiento **cita** valuación y plan de cuentas; no los recalcula | Responde la pregunta abierta de `09` Frente 1 sobre corrección retroactiva |
| D-8 | **Sin partida abierta en la primera versión** — solo regla de fecha de imputación por renglón | Laura confirmó formato de asiento agrupado por cuenta contable (`05`) |
| D-9 | `no_verificable` es valor de primera clase del estado de cuadratura | Cabal no publica total; junio de FCI sin mayo (`09`, `12`) |
| D-10 | Congelar el contrato de salida común después de BBVA, antes de ICBC | Retrofitear 1 adapter, no 4 |
| D-11 | Commits 3/4 de liquidaciones esperan a `documento_ingerido` | Es el retrabajo más caro evitable hoy |
| D-12 | Caso de trabajo del diseño = ROKA + H y J, nunca Bracci | Mismo patrón que la trampa de `R42` en `10` §1 |

## 4.2 Preguntas abiertas para convocatoria **real** (no simulada) al implementar

Ninguna de las convocatorias de este documento fue real. Estas son las que hay que hacer de verdad,
con los agentes del roster, cuando esto pase a Claude Code:

**`contador-dominio`**
1. La regla de fecha de imputación cuando el devengamiento y la cancelación caen en meses distintos
   (venta 30/06, acreditación 02/07). ¿El renglón de cancelación se imputa en julio contra un
   Deudores por Ventas que quedó vivo, y alcanza con la fecha por renglón?
2. Ratificar que el paso 3.5 (cuadratura por fuente) es un invariante de tolerancia cero para el
   extracto bancario, igual que en FCI y liquidaciones — o si hay un caso legítimo de descuadre.
3. Qué pasa contablemente si una fuente llega **después** de confirmado el cierre.

**`contador-dominio` + `plan-cuentas-multicliente`** (la convocatoria pausada desde el 2026-08-21)
4. El modelo de plan versionado: versión completa con supersesión vs. vigencia por cuenta. **Bloquea
   `plan_cuentas_version_id` y, con él, todo `asiento_propuesto`.**
5. Clasificación de datos de la denominación de socios en el plan (`10` §5), sin resolver.

**`arquitecto-software` + `dba-data`**
6. `documento_ingerido` con backfill de los 3 lotes vs. arco excluyente. Es una migración contra
   datos reales del piloto, con `CLAUDE.md §1.9` de por medio.
7. Cómo se garantiza debe = haber sin caer en "invariante verificado con la visibilidad del
   escritor" (§2.1). Hoy la posición es "el control duro vive en el acto de confirmar" — hay que
   ratificarla o mejorarla.
8. Clasificación N0/N1/N2 de cada columna nueva. En particular: ¿el `estado` de un cierre es dato de
   negocio o metadato?

**`seguridad-datos-financieros`** — *condicional: solo si Laura confirma que hay enrutamiento real*
9. Si la cola del paso 6 alguna vez se reparte entre personas distintas del estudio, aparece una
   superficie de exposición nueva: mostrarle un ítem a alguien que quizás no debería ver la relación
   societaria de ese cliente. Este agente **ya bloqueó exactamente eso una vez** — en el export
   enriquecido encontró que `retiro_de_socio` / `aporte_de_socio` exponían relación societaria por
   fila para destinatarios externos al estudio (`06`, `05`). **Mientras el paso 6 no se reparta, la
   pregunta no está abierta**: el hallazgo del export ya está tratado y no se crea nada nuevo. Queda
   anotada acá para que no haya que redescubrirla el día que la respuesta de Laura la active.

**`motor-conciliacion-contable`**
10. Qué hace el motor si falta la cotización de una fecha puntual (ya abierta en `09` Frente 1, sigue
    sin dueño).

**Para Laura** — se suman a la ronda 3 ya enviada, no la reemplazan
11. El timing de la diferencia de cambio (`05`, sin enviar todavía) — ahora con más urgencia, porque
    ROKA es el caso de trabajo del diseño.
12. La confirmación de la cuenta puente de Bracci (`05`, sin enviar).
13. 🆕 **La única del paso 6 que sigue abierta** (§1.3): con el asiento del mes ya armado, ¿lo
    revisa o firma alguien distinto del que lo preparó, o lo cierra el mismo que lo procesa? No
    bloquea nada — define si `confirmado_por` se queda o se saca.
14. 🆕 Las cuatro de §12 de ARCA (`08`, nunca enviadas) suben de prioridad: de dónde saca hoy
    compras y ventas, y si los clientes ya le tienen delegados servicios. Ahora no son solo
    conversación de producto — definen cómo entra la fuente que destraba la parte más grande de la
    cola del paso 6.

## 4.3 Qué **no** se decidió acá, a propósito

Frontend, hosting, proveedor de nube. Sigue fuera de alcance y nada de lo diseñado acá depende de
esas decisiones — se pueden tomar después sin volver a abrir este documento.

---

> ⚠️ **Implicancia contable y fiscal.** Este documento propone estructura para un cierre contable
> mensual y de ejercicio, con efecto directo sobre balance y liquidación de impuestos. Se apoya en lo
> que Laura describe y en la evidencia registrada en el set `00`–`13`, no en una revisión normativa
> propia. **Validar con profesional matriculado antes de que esto produzca un asiento real.**
