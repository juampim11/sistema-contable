# Modelo de imputación contable — diseño

> **Por qué existe este documento.** Se estaba a punto de diseñar la imputación sobre el **código de concepto
> del banco**. Se midió: de los cinco bancos que entregan planilla, **solo Galicia trae código**, y tres de los
> ocho no entregan planilla. El supuesto se cayó y el diseño se rehizo desde las **14 reglas de imputación** que
> escribió la contadora.
>
> **`knowledge/` está vacío** (verificado: 16 archivos, todos README o plantilla, `sources_status:
> esqueleto-sin-contenido`). Ninguna afirmación de este documento cita una norma, una RT ni un artículo. Donde
> hace falta respaldo normativo dice **"no tengo esa fuente cargada"** y queda como hueco, no como supuesto.
> _Validar con profesional matriculado._

---

## 0. Dos hechos que hay que tener presentes antes de leer

1. **No existe todavía ningún modelo de asiento ni de plan de cuentas en el repo.** Las seis migraciones crean
   tenancy, endurecimiento, auditoría e ingesta. Eso pesa sobre las reglas 6, 7, 12 y 13, que hablan de
   *cancelar un pasivo registrado previamente*: **hoy no hay contra qué cancelar**. Toda "cancelación" es una
   imputación a una cuenta, no un matching contra un pasivo. Escrito así para que nadie diseñe un matcheo
   contra una tabla que no existe.
2. **El cliente de mayor volumen entrega en papel.** Así que "lo agregamos después volviendo al archivo" no es
   una salida: para ese cliente puede no haber archivo al que volver.

---

## 1. La separación de responsabilidades: cinco capas, no dos

La intuición inicial —*reconocer* vs. *imputar*— tiene el corte principal bien y le faltan dos capas. Y las dos
que faltaban son justo donde fracasan las reglas de mayor volumen.

| Capa | Responsabilidad | De qué depende | Dónde vive |
|---|---|---|---|
| **A. Normalización de señales** | El formato del banco → un conjunto **cerrado y tipado** de hechos | Del banco | Módulo 1, `packages/ingesta` (ya existe) |
| **B. Reconocimiento** | `señales → tipoMovimiento + confianza + evidencia` | Del banco **y del cliente** | Módulo 2, motor puro |
| **C. Resolución de contrapartida** | `documento/CBU → socio \| organismo \| cuenta propia \| tercero` | **Solo del cliente** (padrones) | Módulo 2, servicio con I/O |
| **D. Imputación** | `(tipo, columnaOrigen, dimensión resuelta) → cuenta del plan del cliente` | Del **plan de cuentas del cliente, versionado**. Cero dependencia del banco | Módulo 2, tabla |
| **E. Composición** | Armar el asiento, balancear, adjuntar evidencia, decidir propuesta o cola | Del dominio contable | Módulo 2 |

### 1.1. Por qué C es una capa y no un detalle de B

**Tres de las 14 reglas —las de mayor volumen— no fallan por reconocimiento.** Reconocerlas es trivial: el texto
dice "TRANSFERENCIA". Fallan porque **falta un padrón**.

Y la prueba de que esto no se arregla con un banco mejor: **Galicia trae código de concepto y las reglas 10, 12
y 13 siguen indecidibles con él.** El código dice *que* es una transferencia; no dice si el CUIT del otro lado
es de un socio.

Meter esas reglas dentro de B haría parecer que el problema es de matcheo de texto. Separar C deja escrito que
el bloqueante es **un dato del cliente**, no del banco.

### 1.2. Por qué D es común "entre bancos" y no "única"

`común` = **independiente del banco**. No = una sola tabla para todos los clientes. La contadora simplifica
—*"todo lo que deben los clientes va contra esa cuenta"*— y otro cliente puede no simplificar igual. La
imputación se resuelve con el plan **vigente a la fecha del movimiento**, nunca con el de hoy.

### 1.3. El invariante que hace que la separación valga algo

> **El motor de imputación nunca ve el nombre del banco.** Su tipo de entrada no tiene `bancoCodigo`, y el
> paquete de imputación no puede importar nada de `adaptadores/`.

Es testeable por arquitectura, como las reglas que ya existen. Sin ese test, en tres bancos hay un
`if (banco === 'galicia')` en la imputación y la separación existe solo en este documento.

---

## 2. El hallazgo que simplifica todo: **el lado no lo elige la regla**

Se recorrieron las 14 reglas buscando una donde el lado del renglón imputado **no** sea el inverso de la columna
del banco. **No hay ninguna.**

La prueba más clara son las reglas 8 y 9: **la misma cuenta (Caja), los dos lados**, y el lado sale de la
columna. La contadora lo explica ella misma en la regla 8: *"aunque esta cuenta tenga saldo deudor, se registra
este movimiento al haber porque disminuye la caja y aumenta el banco"*.

Es partida doble: hay un solo renglón de contrapartida —Banco— y su lado está fijado por la columna.

> **`lado = columnaOrigen === 'credito' ? 'haber' : 'debe'`** para todo renglón imputado de un movimiento con
> una sola contrapartida. **La tabla de imputación guarda CUENTAS, nunca lados.**

**Consecuencia:** la inversión de signo —el error que la contadora señaló como el clásico del dominio— deja de
ser posible **por construcción**. Si el lado fuera un campo configurable, alguien lo configura mal y **el
asiento cuadra igual**.

### 2.1. La única excepción, y viene con su propio detector

Un movimiento cuya imputación se **desdobla** puede tener renglones de los dos lados: un rescate de FCI con
pérdida acredita Inversiones y debita Resultado. Y esa familia de tipos es **exactamente la misma** que necesita
un importe que el extracto no trae (inventario PEPS, arancel, capital vs. interés de una cuota).

O sea: *el único caso que necesita elegir lado es el mismo que necesita un dato ausente.* Un solo test cubre
los dos:

> **Si un tipo declara desdoble, tiene que declarar también su dato faltante, o no se propone.**

---

## 3. El catálogo de tipos

Régimen: **D** determinístico · **R** requiere padrón (determinístico una vez cargado) · **M** manual
obligatorio · **F** el tipo es determinístico pero **la cuenta depende de una fuente fiscal no cargada**.

| # | Tipo | Cuenta (naturaleza) | Lado | Rég. | Nota |
|---|---|---|---|---|---|
| 1 | `impuesto_debitos_creditos` | Ley débito-crédito (resultado, deudor) | inverso | **D** | El crédito por anulación va al HABER de **la misma** cuenta. Porción computable como pago a cuenta: **no tengo esa fuente cargada** |
| 2 | `comision_bancaria` | Gastos y comisiones bancarias | inverso | **D** | ⚠️ Colisiona con el pago de haberes: `SERVICIO ACREDITAMIENTO DE HABERES` es **comisión**, no sueldo |
| 3 | `iva_sobre_gasto_bancario` | IVA crédito fiscal (activo) | inverso | **F** | El tipo se reconoce bien. Que sea **computable** depende de condición IVA, afectación, prorrateo y requisitos: **no tengo esa fuente cargada** |
| 3b | `percepcion_impositiva` | Percepciones sufridas (activo) | inverso | **F** | **Tipo separado, no un caso de 3.** Sin él, una percepción entra como crédito fiscal: crédito inflado **y** percepción perdida |
| 4 | `interes_de_financiacion` | Intereses financiación | inverso | **D** | |
| 4b | `interes_por_descubierto` | ídem o cuenta propia | inverso | **D** | **No está en las 14.** Devenga por día y el cargo puede caer en otro mes: imputación temporal, **no tengo esa fuente cargada** |
| 5 | `retencion_iibb_bancaria` | Retenciones IIBB **por jurisdicción** | inverso | **F/M** | El tipo es D; la **cuenta** exige `jurisdiccion`, que Santander no publica. Una cuenta que mezcla jurisdicciones **cuadra** y la rechaza el fisco |
| 6 | `pago_de_obligacion_fiscal` | Pasivo fiscal — **cuál, lo elige ella** | inverso | **M** | Manual **pedido explícitamente** |
| 7 | `pago_de_haberes` | Sueldos a pagar (pasivo) | inverso | **D** | Determinístico **solo** si el concepto discrimina el pago de su comisión. No distingue neto de cargas ni retenciones: el pago del formulario de cargas es tipo 6, no 7 |
| 8 | `deposito_efectivo` | Caja (activo) | **haber** | **D** | ⚠️ No debe capturar depósito de **cheques** (13c) |
| 9 | `extraccion_efectivo` | Caja (activo) | **debe** | **D** | ⚠️ No debe capturar compra con tarjeta de débito: no es Caja |
| 10 | `transferencia_entre_cuentas_propias` | Fondos en tránsito | inverso | **R/M** | Manual **pedido explícitamente**. Requiere padrón de CBU propios |
| 11 | `acreditacion_tarjeta` | ver §5 | **haber** | **M** | Se propone **incompleto**, nunca cerrado |
| 12a | `pago_a_proveedor_transferencia` | Proveedores (pasivo) | **debe** | **R** | El default "no es socio" **solo vale si el padrón se consultó** |
| 12b | `retiro_de_socio` | Cuenta particular del socio **resuelto** | **debe** | **R** | La cuenta es función del socio: **no es constante** |
| 12c | `pago_con_cheque_propio` | Proveedores | **debe** | **R** | ⚠️ Ver §4 |
| 13a | `cobranza_de_cliente` | Deudores por ventas | **haber** | **R** | ídem 12a |
| 13b | `aporte_de_socio` | Cuenta particular del socio | **haber** | **R** | |
| 13c | `deposito_cheques_terceros` | Deudores por ventas | **haber** | **R** | ⚠️ Ver §4 |
| 14 | `cheque_rechazado` | Proveedores (si crédito) / Deudores (si débito) | inverso | **D** | **La cuenta la elige el lado, no el texto** |
| — | `indeterminado` | — | — | — | Obligatorio. **Su volumen es la métrica de salud del producto** |

### 3.1. Tipos que las 14 reglas no cubren y tienen que existir igual

Si no existen en el catálogo, **caen en silencio en una regla equivocada**:

`pago_tarjeta_corporativa` (cancela un pasivo de tarjeta, **no** Proveedores) · `suscripcion_fci` ·
`rescate_fci` · `compra_con_tarjeta_debito` · `debito_automatico_servicio` · `acreditacion_prestamo` ·
`cuota_prestamo` (desdobla capital + interés + IVA, y **ninguno de los tres está en el extracto**) ·
`compra_venta_de_divisas` · `movimiento_en_cero` (con `esMovimiento = false` + motivo) · `reverso_de_movimiento`.

### 3.2. Cuántas reglas piden manual: **dos explícitas**, no tres

Corrección a la premisa con la que se convocó el análisis. Tres reglas tienen un aside entre comillas, pero
solo dos piden intervención:

1. **Regla 6** — *"deberías dejar para que imputemos manualmente nosotros a qué cuenta de pasivo lo
   asignamos"*. **Manual explícito.** El débito dice *que* se pagó al organismo, no *qué* obligación cancela.
2. **Regla 10** — *"podrías dejar el ajuste manual para asignarlo"*. **Manual explícito.**
3. **Regla 11 NO pide manual.** Su aside —*"acá simplificamos la conta"*— es una **simplificación de la
   cuenta**, no un pedido de intervención. Y es justamente la que **tiene** que ir a manual aunque ella no lo
   haya pedido (§5). Decir "las tres piden manual" borraría el único caso donde el sistema debe advertir **en
   contra** de lo que el criterio escrito dice.
4. **Hay un cuarto, implícito:** la regla 12 escribe *"CUENTA PARTICULAR SOCIO XX"*. El `XX` es **un manual
   disfrazado de constante**: qué socio es una resolución, y si se hornea una cuenta por defecto, todos los
   retiros van al socio equivocado.

---

## 4. Dos reglas que quedan incompletas, y de qué depende

**Reglas 12c y 13c (cheques).** Si el cliente lleva circuito de valores, el cheque propio **ya canceló
Proveedores cuando se entregó**; el débito bancario al vencimiento cancela `Valores a pagar`. Imputarlo otra vez
a Proveedores **duplica la cancelación** y deja un residuo deudor permanente. Simétrico con el cheque de
terceros y `Cheques en cartera`.

La regla 14 es la prueba de que su modelo es internamente consistente **sin** circuito de valores: debita
Deudores al rechazo, lo que solo tiene sentido si Deudores se acreditó al depósito.

> **12c, 13c y 14 son correctas si y solo si el cliente no lleva sub-mayor de valores.** Eso es un **atributo
> por cliente** (`usa_circuito_de_valores`), no una constante del producto. Hoy es un supuesto no escrito.

**Reglas 1, 2, 4 y 5 dicen "se suman".** Eso es la agregación de su **papel de trabajo manual**, no un criterio
de registración. Agregar al imputar rompe el uno-a-uno con la línea del extracto —que es la trazabilidad— y hace
que la anulación de la regla 1 **desaparezca dentro de un neto**.

> La imputación es **1:1 con el movimiento**. La agregación es **de la exportación**, y solo si su sistema
> contable no acepta un renglón por movimiento.

---

## 5. La regla 11 y la contradicción, resuelta

Las dos afirmaciones eran verdaderas y hablaban de cosas distintas. La contradicción se disuelve al separar
**qué cuenta** de **qué importe**:

- **Su simplificación es sobre la cuenta**: no lleva sub-mayor por cliente. Es una decisión de nivel de
  agregación, **legítima, y el sistema la respeta**. No produce ninguna afirmación falsa: produce menos detalle
  analítico, y ese detalle es suyo.
- **La objeción es sobre el importe**: llega el **neto**. Acreditar por el neto no es agregar menos: es
  **omitir hechos**. Cuatro:
  1. la cuenta de deudores queda con un **residuo deudor permanente y creciente**;
  2. el **arancel** nunca se registra → gastos subvaluados, resultado sobrevaluado;
  3. el **IVA sobre el arancel** nunca se computa → **es plata**;
  4. las **retenciones** nunca se registran como pago a cuenta → **es plata**.

Y el asiento **cuadra**, que es por lo que sobrevive.

### 5.1. La resolución

1. Se propone el **neto** contra su cuenta, con `estado: incompleto` y `motivo:
   componentes_no_disponibles`, y el movimiento queda **pendiente de completar con la liquidación**. Nunca
   cerrado, y **nunca se estima el bruto**.
2. **Se usa la cuenta que ella misma nombró en la entrevista.** El análisis de la entrevista dice *"Tarjeta de
   crédito a cobrar (ya devengada antes)"*; el documento de criterio dice "Deudores por ventas". **No son la
   misma afirmación** y el diseño difiere: con una cuenta separada el residuo queda **aislado, visible y
   reconciliable**; dentro de Deudores se disuelve entre las cobranzas y no se detecta nunca. **Hay que
   preguntárselo.**
3. **Qué se gana:** cero trabajo manual por movimiento y la cuenta Banco reconcilia al centavo. **Qué se
   pierde:** el gasto de arancel, su crédito fiscal, las retenciones como pago a cuenta, y las **ventas
   brutas** — que son el insumo del cruce contra el IVA débito y del sondeo de margen que ella misma describe
   como disparador de inspección. Un bruto subdeclarado con ventas correctas **hace ver el margen mal**.
4. **El argumento para llevarle:** ella ya resuelve esto con precisión **del lado pagador** (la tarjeta
   corporativa). La asimetría es el hallazgo, no una falta de criterio: **su propio criterio, aplicado
   simétricamente, arregla la regla 11.**

---

## 6. La escalera de evidencia, y la regla de degradación

De más fuerte a más débil. Una regla declara su **peldaño mínimo** y el motor calcula si era aplicable.

| Peld. | Evidencia | Disponibilidad **medida** |
|---|---|---|
| E1 | `columnaOrigen` (dirección) | Los 8. En Bancor es **derivada de la cadena de saldos**, no publicada |
| E2 | `conceptoCodigo` + `conceptoGrupoCodigo` + `conceptoOrigenDato` | **Solo Galicia, y solo si llegó el Excel** |
| E3 | Literal publicado + `conceptoNormalizado` | Los 5 con planilla y todos los PDF con texto. **Es el peldaño real del producto** |
| E4 | `referencias[]` tipadas (`vep`, `cheque`, `factura`, `comercio`, `terminal`) | Variable; se extraen **antes** de depurar la glosa |
| E5 | `contraparteDocumentoHmac` + `contraparteCbuHmac` + tipo | Depende de si el banco publica el documento en la glosa |
| E6 | `jurisdiccion` declarada | Bancor y Macro sí; **Santander no** |
| E7 | **Par / reverso**: otro movimiento de igual importe y signo opuesto en ventana | Calculable siempre sobre lo persistido |
| E8 | Atributos vigentes de cuenta y cliente | Siempre |

> **Cuando falta el peldaño mínimo de una regla, el resultado es `indeterminado` con `motivoFaltaEvidencia` —
> nunca el peldaño siguiente en silencio.**

Es la generalización de la lección del supuesto falsificado. Tres resultados distinguibles, no dos:
`propuesta` · `indeterminado_por_falta_de_evidencia` (la regla **no pudo correr**) · `ambiguo` (dos reglas de
igual especificidad: se listan los candidatos, **nunca se elige el más probable**).

Y el artefacto que impide repetir el error: **una matriz declarada `banco × tipo`** con el peldaño que
identifica ese tipo en ese banco. **Celda vacía = `indeterminado`, no una adivinanza por texto.** Es el mismo
patrón que `banco.capacidades`, que existe para que "el banco no publica el signo" y "el adaptador está roto" no
se vean igual.

### 6.1. El lado como evidencia es la regla, no la excepción

| Caso | Mismo literal, dos significados | Qué decide |
|---|---|---|
| 12a vs. 13a | "TRANSFERENCIA" | **El lado.** Proveedores vs. Deudores. **El mayor volumen de la cartera** |
| 8 vs. 9 | familia "EFECTIVO / VENTANILLA" | El lado. Caja al haber vs. al debe |
| 10 (sus dos patas) | literal idéntico en las dos cuentas | El lado |
| 1 (anulación) | mismo concepto de impuesto | El lado: crédito = HABER de la misma cuenta |
| 14 | "RECHAZO DE CHEQUE" | El lado |
| 2, 3, 4 reversados | misma comisión o interés | El lado: un crédito bajo un concepto de gasto **no es un ingreso**, es el reverso del gasto |

Por eso la clave de imputación es **`(tipo, columnaOrigen)`**, y cada tipo declara su simetría:
`misma_cuenta` · `cuenta_distinta` · **`lado_imposible`**, que es un detector gratis: un crédito bajo
`pago_de_haberes` o un débito bajo `acreditacion_tarjeta` no existen — es error de parseo o un reverso que
necesita una persona.

**Y una consecuencia para el contrato de entrada:** en Bancor la dirección es **derivada de la cadena de
saldos**, y seis tipos eligen cuenta por el lado. El reconocedor tiene que recibir
`columnaOrigenDato: 'publicada' | 'derivada_de_cadena'`. Es **derivable** de `banco.capacidades` +
`adaptadorVersion`, así que **no es columna nueva ni reproceso**; sí tiene que estar en el contrato. En Bancor,
un lote que rompe la cadena falla **antes** del reconocimiento: ahí la aritmética no es la red, es la fuente.

---

## 7. Lo que no se puede hacer determinístico, con el dato exacto que falta

| Regla / tipo | Dato faltante | ¿Reconstruible después? |
|---|---|---|
| 12b, 13b | **Padrón de CUIT/CUIL de socios por cliente, con vigencia** (un socio entra y sale) + el mapeo `socio → cuenta particular` | Sí, si el hmac del documento está en N2 |
| 12a, 13a | **El mismo padrón, para el default.** Sin padrón consultado, "no es socio" **no es una conclusión**: es ausencia de control | Sí |
| 10 | **Padrón de CBU de todas las cuentas propias**, incluidas las de los bancos que **no entregan planilla** — su pata puede no llegar nunca. Hay que declararlo, no descubrirlo | Solo si el CBU de la contraparte quedó hasheado en N2 |
| 6 | **Allowlist de CUIT de organismos** (N0) + catálogo de impuestos por cliente + **el pasivo previo, que no existe en el modelo** | El VEP sí, si se extrae hoy |
| 11 | **Liquidación del adquirente**: arancel, IVA, retenciones, y el número de comercio/terminal para el join | El join sí, si se captura hoy |
| 3, 3b | Cómputo del crédito fiscal y de las percepciones: **no tengo esa fuente cargada** | — |
| 5 | `jurisdiccion` cuando el banco no la publica + régimen de recaudación bancaria provincial: **no tengo esa fuente cargada** | **No**: si el banco no la nombra, no se deduce nunca |
| 1 | Porción computable como pago a cuenta: **no tengo esa fuente cargada**. Y el renglón del **anexo** que la trae **no es un movimiento** | El anexo, solo si se captura hoy |
| 12c, 13c, 14 | Atributo por cliente **`usa_circuito_de_valores`** + número de cheque en las dos puntas | Sí |
| `rescate_fci` | **Inventario PEPS de apertura por fondo** | **No** |
| USD | La cotización, su fuente y el criterio de valuación: **no tengo esa fuente cargada** | El campo sí; el valor no |
| Todos | Imputación temporal según RT **y su adopción por el Consejo Profesional de la jurisdicción del cliente** — sin adopción jurisdiccional una RT no rige. Y **ajuste por inflación** | — |

### 7.1. El mecanismo que hace visible lo no automatizable

Mejor que "ajuste manual" a secas: **cuentas puente con reconciliación obligatoria de cierre.**

- **`FONDOS EN TRÁNSITO`** para la regla 10: cada pata se registra cuando llega. Si el saldo no es cero al
  cierre, **falta una pata** — y se ve, en vez de descubrirse por diferencia de saldos al cierre de ejercicio,
  que es el dolor que originó el proyecto.
- **`TARJETAS A LIQUIDAR`** para la regla 11: el residuo **es** el arancel + IVA + retenciones no registrados, y
  queda **cuantificado en una cuenta** en vez de disuelto en Deudores.

---

## 8. Cómo se modela, y por qué cada cosa vive donde vive

Criterio: **qué cambia y quién lo cambia.**

| Artefacto | Dónde | Por qué ahí |
|---|---|---|
| **Catálogo de tipos** | Unión cerrada TS (`as const`) **+ check constraint + test de catálogo** | Es conocimiento del producto: un tipo llega con el código que lo reconoce, igual que un banco llega con su adaptador. Un archivo de configuración permitiría un tipo sin reconocimiento — un valor muerto. **El test de catálogo no es opcional:** dos listas del mismo dominio en dos lenguajes ya divergieron dos veces en este repo |
| **Reglas de reconocimiento — modelo** | Tabla **N0 sin tenant**, por migración (patrón `banco`) | Es el default del producto por banco. La escribe quien escribe el adaptador |
| **Reglas de reconocimiento — por cliente** | Tabla **N2 con los siete renglones** | Ella pidió reglas por cliente y **no va a abrir un PR**. Overlay por especificidad, orden determinístico, y el id de la regla aplicada viaja en la evidencia |
| **Tabla de imputación** | Tabla **N2 por cliente, versionada por vigencia**; el modelo se **deriva** | El plan de cuentas es por cliente y versionado; se resuelve con la vigencia a la **`fecha` del movimiento**, nunca "hoy" |
| **Padrones** (socios, cuentas propias, adquirentes) | N2/N2R por cliente, HMAC + `pepper_id` | Datos del cliente. La allowlist de **organismos** es la única N0 |

**Tres decisiones que hay que escribir o alguien las resuelve mal a las once de la noche:**

1. **Las reglas modelo y las del cliente son dos tablas, no una con `cliente_id` nullable.** Con `cliente_id`
   NULL el predicado de tenant **excluye** la fila y los defaults se vuelven invisibles; ampliar la policy para
   aceptar NULL introduce el predicado abierto que R5 prohíbe. Es el mismo razonamiento por el que `banco` quedó
   **sin RLS** en vez de con `using (true)`.
2. **El predicado de una regla es de un conjunto cerrado** (`literal_exacto`, `prefijo`, `codigo_concepto`,
   `grupo_concepto`, `tipo_referencia`, `documento_en_padron`, `es_reverso_de`), **nunca una expresión regular
   escrita por un usuario**. Una regex en una tabla es lógica sin cota dentro de un dato: no se revisa en un PR
   y puede colgar el job.
3. **La cuenta no siempre es una constante:** `cuentaResolucion: 'fija' | 'por_socio' | 'por_jurisdiccion' |
   'por_impuesto'`. Sin esto alguien hornea `SOCIO XX`.

**Y lo que explícitamente NO es configuración:** la partida doble, el balanceo, y la derivación
`lado = f(columnaOrigen)`. Eso es código con invariantes. **Un lado configurable es un asiento que cuadra y está
invertido.**

---

## 9. Qué hay que capturar en el Módulo 1, ahora

Criterio: **si agregarlo después obliga a volver al archivo, va ahora** — y para el cliente de mayor volumen
puede no haber archivo.

| Campo | Por qué es reproceso |
|---|---|
| 🔴 **`contraparteCbuHmac`** (+ `pepper_id`) en N2 | **Hueco encontrado en el análisis anterior:** se resolvió el régimen de acceso para el **documento** y **se olvidó el CBU**. Y la regla 10 es justo la que **no tiene documento de tercero**: la contraparte es el propio cliente, identificada por CBU. Sin el hmac en N2, la regla 10 tiene que leer N2-R **por fila** — el escenario H-8 exacto que la satélite existe para evitar. `glosa.ts` ya extrae las corridas de 22 dígitos: el valor está, falta el derivado |
| 🔴 `conceptoOrigenDato: 'pdf' \| 'excel' \| 'ninguno'` | Si el Excel llegó una vez y no se conserva, "no hay código" y "el código vino vacío" se ven igual para siempre |
| 🔴 `conceptoLiteralPublicado` + `conceptoNormalizado` + `conceptoGrupoCodigo` | Es el peldaño E3, el **real** para 4 de 5 bancos. Vive solo en el archivo |
| 🔴 `referencias[]` tipadas, extraídas **antes** de depurar la glosa | VEP, cheque, factura, comercio y terminal se pierden en la depuración |
| 🔴 `contraparteDocumentoTipo` + `contraparteDocumentoHmac` + `pepper_id` | Sin `pepper_id` la rotación rompe el matching **en silencio** |
| 🔴 `jurisdiccion` + `jurisdiccionDato: 'publicada' \| 'no_publicada'` | Ilegible después: dos bancos la nombran, uno no |
| 🔴 `anexos[]` | No derivable de los movimientos, y trae el renglón del computable que **no es** un movimiento |
| 🔴 `esMovimiento` + `motivoExclusion` | "Supe y decidí que no" ≠ "no supe" |
| 🔴 `cotizacion` + `cotizacionProvista: false` | Si el campo no existe, alguien lo completa con la cotización de hoy: **valuación retroactiva inventada** |
| 🔴 `paginaPdf` | La evidencia del asiento apunta a la hoja |

**Lo que NO hace falta capturar** — dicho para que nadie agregue una columna:

- **`columnaOrigenDato`**: derivable de `banco.capacidades` + `adaptadorVersion`. No es columna, es contrato.
- **Pares y reversos (E7)**: se calculan en Módulo 2 sobre filas persistidas.
- **`tipoMovimiento`**: **el Módulo 1 no lo persiste.** Depende de reglas por cliente y de padrones que no
  existen. Persistirlo hoy congela una clasificación hecha **sin la evidencia que la decide**.

---

## 10. Las cuatro preguntas para la contadora

Se suman a las diez que ya están en el plan §11.

1. **Tarjetas: ¿"Deudores por ventas" o "Tarjeta de crédito a cobrar"?** Dijo las dos cosas en documentos
   distintos, y el diseño difiere (§5).
2. **¿Sus clientes llevan circuito de valores** (cheques a pagar / cheques en cartera)? De la respuesta depende
   que las reglas 12c, 13c y 14 estén bien o **dupliquen la cancelación** (§4).
3. **¿La agregación por concepto la necesita, o la hacía porque tipeaba a mano?** Si su sistema importa un
   renglón por movimiento, se gana trazabilidad gratis.
4. **¿Qué hacer con un SIRCREB sin jurisdicción publicada?** Cuenta genérica o ajuste manual. Una cuenta que
   mezcla jurisdicciones **cuadra** y la rechaza el fisco.

---

_**Validar con profesional matriculado.** Los huecos normativos quedan nombrados con "no tengo esa fuente
cargada": cómputo del crédito fiscal, percepciones, régimen de recaudación bancaria provincial, porción
computable del impuesto a los débitos y créditos, imputación temporal según RT y su adopción jurisdiccional,
valuación en moneda extranjera, y ajuste por inflación. Los cuatro primeros los consume el Módulo 2
directamente._
