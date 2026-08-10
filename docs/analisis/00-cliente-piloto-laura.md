# Análisis del cliente piloto — estudio contable de Laura

**Fuente:** entrevista grabada (~68 min), transcripta con diarización. **El transcript NO está en este
repo**: vive en `privado/` (gitignoreado), mismo criterio que ADR-0002 §F.2 para los extractos
bancarios. Este documento es la versión **redactada**: se preserva el **proceso**, no los datos.

**Qué se quitó o generalizó a propósito:** nombres de sus clientes (se los llama "cliente A", "cliente
B"…), CUIT, números de cuenta, importes reales (se reemplazan por órdenes de magnitud cuando el orden
importa, y se omiten cuando no), y comentarios personales sin valor para el producto.

> ⚠️ **Corrección de una versión anterior de este documento, y la regla que deja.** La primera versión
> redactaba bien **campo por campo** —sin CUIT, sin cuentas, sin importes, sin razones sociales— y sin
> embargo el **conjunto** era un cuasi-identificador: para uno de los clientes del estudio combinaba un
> rubro descrito con mucha precisión, la provincia inferible por la entidad bancaria, el hecho de ser el
> de mayor volumen y la modalidad de entrega. En un mercado local, esa combinación identifica a una
> empresa. **La redacción campo por campo no alcanza: hay que redactar el conjunto, porque el ataque es
> la combinación.** Lo detectó el agente `seguridad-datos-financieros` (hallazgo G-6).
>
> Este documento fue corregido en consecuencia: los rubros se generalizan a sectores amplios, y no se
> dejan en la misma tabla los pares que identifican por cruce.

> **Distinción importante para leer esto:** "cliente" es ambiguo en este dominio y acá se usa así:
> **Laura es el cliente del producto** (el estudio). Las empresas a las que ella le hace la
> contabilidad son **los clientes del estudio** — los nodos hijos de la tenancy (ADR-0001 §2.1).

---

## 1. Qué hace hoy

### 1.1. El flujo del banco, punta a punta

```
El cliente del estudio le manda el extracto mensual          ← ella NO baja del banco:
   ├── en Excel   (lo que el banco exporta)                     no tiene las claves
   └── en PDF     (el resumen oficial)
        │
        ▼
Trabaja SOBRE EL EXCEL (porque puede filtrar), y usa el PDF para
   (a) resolver dudas de imputación de un concepto nuevo,
   (b) verificar el saldo final y que no falte nada.
        │
        ▼
Filtra por concepto (escribe "trans" en el filtro, selecciona todo, suma) y CLASIFICA
cada grupo de movimientos contra una cuenta contable.
        │
        ▼
Arma el asiento a mano en una planilla: verifica que DEBE = HABER, y que
saldo inicial + créditos − débitos = saldo final del PDF.
        │
        ▼
Va a su sistema contable y TIPEA el asiento línea por línea.
```

**Pide los dos formatos, y el motivo es el hallazgo más importante de toda la entrevista:**

1. **El Excel del banco pierde movimientos.** Los de los **últimos días hábiles del mes** no caen en el
   Excel de ese mes **ni** en el del siguiente. Se descubre al cierre de ejercicio, cuando los saldos no
   coinciden: "contabilizamos, contabilizamos… y cuando pedimos el PDF al cierre no coinciden los
   saldos". Peor si el último día hábil cae viernes. **El PDF siempre tiene todo.**
2. **El PDF trae datos que el Excel no.** El caso concreto: en un pago de honorarios, el Excel dice
   "pago de honorarios" y el **PDF trae el CUIT del destinatario** — que es lo que permite deducir a
   quién se le pagó. (En un banco el Excel también trae DNI; en otro "no siempre".)

> **Consecuencia de diseño, y contradice el supuesto natural:** el PDF **no** es el formato incómodo del
> que hay que escapar hacia el Excel. **El PDF es la fuente de verdad** y el Excel es el derivado
> conveniente. El Módulo 1 no "convierte PDF a Excel para poder trabajar": **reconstruye el dato
> completo desde la fuente autoritativa**. Ella misma cierra el círculo: *"si vos pudieses llevar todo
> ese nivel de detalle del PDF a un Excel, ya obviaría el otro Excel"*.

### 1.2. Sus reglas de clasificación (las dictó de memoria)

Son el insumo directo del **Módulo 2**, no del 1. Se registran acá porque las dijo ella:

| Lo que ve en el extracto | A qué cuenta va |
|---|---|
| Transferencias salientes, en general | **Proveedores** (no analiza proveedor por proveedor) |
| …salvo que sea al CUIT de un socio/dueño | **Cuentas particulares** ← el único control que hace siempre |
| …salvo que sea al organismo recaudador | **ARCA/AFIP**, y después lo abre por impuesto |
| Comisiones | Gastos y comisiones bancarias |
| IVA sobre comisiones | IVA crédito fiscal |
| Impuesto a los débitos y créditos | Su propia cuenta (el PDF lo discrimina por débito y por crédito) |
| Créditos con número de DNI | **Deudores por venta** (venta de mostrador cobrada por transferencia) |
| Acreditaciones de tarjetas | Tarjeta de crédito a cobrar (ya devengada antes) |
| Sueldos pagados por banco | Sueldos |
| Suscripción / rescate de FCI | Fondo común de inversión |
| Débito del organismo sin más detalle | Lo identifica **por fecha y monto** (sabe que "ese es IVA") |

**Dos cosas que dijo y que valen como regla de producto:**

- *"Si para vos no es complejo armar reglas específicas para cada cliente, lo podríamos hacer
  tranquilamente. Y que lo que no esté dentro de las reglas lo deje para ajuste manual."* → **Valida
  literalmente la regla dura de `CLAUDE.md` §1.7: asistido, no automático.** No hay que convencerla.
- *"Va a haber una generalidad, pero cada cliente tiene su particularidad."* → las reglas son
  **por cliente**, derivadas de un default general.

### 1.3. Herramientas que usa hoy

| Herramienta | Para qué | Nota |
|---|---|---|
| **Excel / Google Sheets** | Su superficie de trabajo real: filtra, clasifica, suma, arma el asiento, y mantiene el papel de trabajo de IVA y la proyección de Ganancias | Sheets le **rompe las fórmulas** del asiento; para eso abre Excel de escritorio |
| **Sistema contable propio** | Donde vuelca el asiento, tipeado a mano | **Tiene función de importación y nunca la usó** ← puerta de salida barata |
| Portal del organismo recaudador | "Mis comprobantes recibidos", constancias de inscripción, presentaciones | Todo manual, a mano |
| Un sistema de facturación económico para clientes muy chicos | Ordena a los más informales; valida CUIT contra el organismo y trae razón social y domicilio | Le falta traer la **actividad**, que es justo lo que ella necesita |
| Sistema de sueldos (recién contratado) | Liquidación, retenciones de 4ª categoría, DDJJ anual del trabajador | **Ya resuelto: fuera de alcance del producto** |
| Un sistema vertical de la actividad de un cliente | Listas de precios e imágenes de proveedores | Contexto, no alcance |

### 1.4. Cuellos de botella, en su orden de dolor

1. **Convertir el PDF a algo filtrable.** Es el más caro y el que nombró primero. Los conversores le
   devuelven basura: celdas fusionadas con varios movimientos adentro, **una hoja de Excel por cada hoja
   del PDF** (con ~80 hojas hay que unirlas a mano antes de poder filtrar), formatos de celda
   inconsistentes dentro del mismo archivo. *"Nunca logro bajarlo como el cuerpo de los movimientos."*
2. **Cada banco tiene su formato**, y un conversor armado para uno no sirve para el siguiente.
3. **Tipear el asiento** línea por línea en su sistema.
4. **Cruzar el IVA compras del cliente contra lo que el organismo tiene registrado** (§4.2).
5. **Clasificar las facturas de compra** en 3-4 categorías, proveedor por proveedor (§4.3).
6. **Mantener a mano los parámetros fiscales** (deducciones, escala, topes de aportes que cambian
   todos los meses) en sus planillas.

---

## 2. El dolor principal

Hay dos respuestas y las dio en este orden, que importa:

**Lo que más le duele intelectualmente:** que su **valor agregado real** —la proyección mensual del
impuesto a las Ganancias, con comparativo de cinco ejercicios de márgenes— viva en una planilla hecha a
mano. Es lo que la diferencia y lo que hace que sus clientes "sepan todos los meses cuánto van a pagar",
en vez de enterarse al cierre.

**Lo que más tiempo le come, y por eso arranca por acá:** *"si es por tiempos, hoy lo que me está
llevando más tiempo son las conciliaciones de los bancos. Y es mucho más fácil de implementar que todo
eso."* Ella misma separó las dos cosas: la conciliación tiene **más conocimiento técnico** (nuestro) y
la proyección tiene más conocimiento de **dominio** (suyo).

> **Confirma la secuencia ya decidida** (Módulo 1 = ingesta bancaria) y da el motivo correcto: no es que
> sea lo más valioso, es lo que **más tiempo libera con menos conocimiento de dominio de por medio**.

Y el marco en el que evalúa todo: los sistemas del mercado son **o demasiado grandes** (un ERP donde usa
el 10% y paga por todo) **o demasiado chicos** (donde termina haciendo todo por afuera en planillas
satélite). *"Yo no necesito gestión de empresa, necesito un liquidador de impuestos que se nutra de
compras, ventas y movimientos de banco."*

---

## 3. Bancos y formatos — lo que ancla el Módulo 1

### 3.1. Los cinco bancos, textual

| Banco | Peso en su cartera | Lo que dijo |
|---|---|---|
| **Galicia** | ⬛⬛⬛⬛ | *"mis clientes trabajan con Galicia y con Santander. El 90% de mis clientes tienen esos dos bancos"* |
| **Santander** | ⬛⬛⬛⬛ | ídem. En su Excel **no siempre** trae el documento de la contraparte |
| **Macro** | ⬛ un solo cliente, de alto volumen | El del PDF de decenas de páginas y ~1.800 filas de Excel |
| **Nación** | ⬛ | *"podés tener algo con Nación y con Bancor"* |
| **Bancor** (Banco de Córdoba) | ⬛ | ídem |
| BBVA | ◻ posible | *"puede tener un BBVA, pero…"* — no confirmado en la entrevista |

**Cobertura:** Galicia + Santander ≈ **90% de los clientes del estudio**.

> ⚠️ **Corregido con el material a la vista.** En la entrevista nombró cinco bancos; los archivos reales
> traen **nueve**: a los cinco se suman **ICBC, Credicoop y BBVA** (que estaba como "posible"). El
> relevamiento medido de los ocho está en `docs/diseno/01-modulo-1-ingesta-bancaria.md` §2.1 y **reemplaza
> a esta tabla** para cualquier decisión técnica: esta refleja lo que ella dijo, aquélla lo que los
> archivos son.

### 3.2. Lo que sabemos de la estructura del PDF (del banco de mayor volumen)

Salió de que compartió pantalla y lo recorrió. Es lo que el parser tiene que manejar:

1. **Varias cuentas en UN mismo PDF.** La primera hoja lista las cuentas del titular: cuenta corriente
   especial en **dólares**, cuenta corriente especial en **pesos**, y cuenta corriente **bancaria**.
   Después el cuerpo va una cuenta después de la otra. **El cambio de cuenta se detecta por el cambio de
   la denominación en el encabezado** — ella lo dijo explícitamente: *"lo único que tenés que fijarte ahí
   es que si cambia esta denominación es porque cambió de cuenta"*.
   → **Un PDF produce N cuentas y M movimientos, y cada movimiento pertenece a UNA cuenta.** No es una
   tabla plana.
   ⚠️ **Corregido y mejorado con el archivo a la vista:** el encabezado repetido de cada página trae
   **el número de cuenta**, así que el ancla del cambio de cuenta es el **número**, no la denominación.
   Mejor de lo que suponía la entrevista — dos cuentas del mismo tipo tienen la misma denominación.
2. **Multi-moneda en el mismo archivo** (ARS y USD).
3. **Encabezados repetidos**: *"todos los cuerpos arrancan con fecha y tienen el mismo título en la
   columna, las 80 [hojas]"*. Es una ventaja: el encabezado es estable y repetido, se puede usar para
   anclar las columnas.
4. **Bloques que NO son movimientos** y hay que excluir: el detalle del impuesto a los débitos y
   créditos por cuenta (discriminado débito/crédito) al final de cada cuenta, y las líneas de saldo.
5. **Transferencias entre cuentas del mismo titular**: aparecen como movimiento en las dos cuentas y
   **no son ni pago ni cobranza**. Se detectan por "mismo titular" y por tener contrapartida de igual
   importe en la otra cuenta en la misma fecha.
6. **Número de referencia**: existe como columna propia en su Excel.
   ⚠️ **REFUTADO al medirlo.** No es clave: está **vacío en 128 de 326 filas** y tiene solo **141 valores
   distintos**. Sirve como atributo informativo y **no refuerza el `fila_hash`**. La clave que sí
   discrimina es `(fecha, importe, saldo)` — 326 valores distintos de 326. Ver
   `docs/diseno/01-modulo-1-ingesta-bancaria.md` §2.3 y §5.2.

### 3.3. Restricción operativa que cambia una prioridad

**El cliente de mayor volumen le trae el extracto EN PAPEL.** Son tantas hojas que lo hacen imprimir en
el banco: *"no me voy a poner a escanear todas las hojas"*. De ese cliente tiene digital la **cuenta más
corta** (~53 páginas), y "a veces".

> **Consecuencia:** el **fallback OCR** que el documento de contexto del drive pone como punto 4 del
> alcance **baja de prioridad**, y no se construye todavía.
>
> ⚠️ **Pero la premisa con la que llegué a eso era falsa, y hay que decirlo.** Escribí "los PDF que sí
> llegan son digitales con texto real" **antes** de tener los archivos. Con los archivos medidos: el
> **PDF de BBVA tiene 0 caracteres extraíbles en sus 6 páginas** — es imagen pura. La *conclusión* se
> mantiene (un banco, un cliente, uso bajo: no se construye OCR ahora), pero el caso **tiene que existir
> como test de rechazo con motivo**, nunca como "0 movimientos, todo cuadra". Y `requiereOcr` se decide
> **por página**, no por promedio del documento: 10 páginas con texto y 40 escaneadas promedian por
> encima de cualquier umbral.

### 3.4. Qué banco elegir para el primer adapter — **decisión pendiente, y por qué**

El documento `02` del drive fija el criterio: *"un adapter por banco… se generaliza la interfaz recién
con el segundo banco real"* y *"iterar con PDFs reales, no con un caso imaginado"*. Con eso:

| Candidato | A favor | En contra |
|---|---|---|
| **Galicia** o **Santander** | Cubren el **90%** de la cartera: el primer adapter sirve para casi todos | Ella no describió su estructura en detalle |
| **Macro** | Es el que **más tiempo le come** y el único cuya estructura describió en detalle (multi-cuenta, multi-moneda, 80 páginas) | Cubre **un** cliente; y ese cliente entrega en papel |

**Recomendación: arrancar por Galicia o Santander** (el que tenga PDF de muestra primero), porque el
primer adapter cubre el 90% de la cartera y el objetivo del incremento es que ella lo pueda usar el mes
que viene. **Macro segundo**, que además es el que va a forzar la generalización de la interfaz — el
paso 2 del criterio del drive — porque tiene multi-cuenta y multi-moneda en un archivo.

⛔ **No se puede cerrar sin el PDF.** Ver §7.

---

## 4. Condición fiscal de los clientes del estudio

### 4.1. Lo que se puede afirmar del transcript

| Dato | Qué dijo | Confianza |
|---|---|---|
| **Responsables inscriptos en IVA** | Todo su relato gira alrededor de IVA compras / IVA ventas, posición mensual y DDJJ de IVA | Alta |
| **Personas humanas y sociedades** | Menciona la escala para personas humanas responsables inscriptos **y** la alícuota societaria. Además **constituye** las sociedades de sus clientes | Alta |
| **Monotributo** | **No lo menciona nunca** | — |
| **Ingresos Brutos** | Sí, y con un problema propio: **alícuota por actividad**. Un cliente con dos actividades (ferretería y corralón) se liquidaba con un reparto estadístico (p. ej. 70/30) de la base imponible | Alta |
| **Punto de venta por actividad** | El organismo empezó a exigirlo **este año**; en la práctica no se cumple y no se controla. Un cliente que vende de las dos actividades en la misma factura no va a emitir dos | Alta |
| **Convenio Multilateral** | ⚠️ **NO SE MENCIONA EN NINGÚN MOMENTO.** Hay un solo indicio indirecto: un cliente con **sede en otra provincia** | Baja |
| Actividades presentes | Comercio minorista y mayorista de materiales, comercio de mostrador, agropecuario, y representación comercial de productos industriales | Alta — **generalizado a propósito** (ver la nota de cabecera: el rubro preciso, cruzado con la provincia y el volumen, identificaba a una empresa) |
| Ingresos financieros | Los excedentes de capital de trabajo se invierten (FCI); los **intereses ganados son base de IIBB** y ella los separa como ingresos extraordinarios | Alta |

### 4.2. El otro cruce que hace a mano (candidato fuerte de roadmap)

Compara el **IVA compras que le manda el cliente** contra **"Mis comprobantes recibidos"** del organismo:

- Si el organismo tiene **menos o igual** que el cliente → no se preocupa.
- Si el organismo tiene **más**, y se repite mes a mes desde el inicio del ejercicio → señal de que el
  cliente está sub-declarando compras. Es un **control preventivo de inspección**, y es la razón por la
  que lleva el registro acumulado desde el arranque del ejercicio.
- **Cómo lo hace:** baja los dos listados y cruza **por número de factura**, que es lo único que no se
  duplica ("por razón social no puedo, por monto no puedo, porque si cambia un centavo…").
- **El problema mecánico concreto:** el organismo entrega el comprobante como **un solo campo**
  (`punto de venta` + `-` + `número`, con ceros a la izquierda), y el sistema del cliente lo entrega en
  **dos columnas separadas**. Tiene que **concatenar** antes de poder cruzar. *"Me lleva un montón de
  tiempo, y encima gratis."*
- **Tolerancia temporal obligatoria:** una factura emitida el último día de un mes puede llegarle al
  cliente al mes siguiente. El organismo ya la tiene; el cliente todavía no. Un cruce sin ventana de
  desfasaje produce falsos positivos todos los meses.

### 4.3. Clasificación de compras — el insight que cambia el modelo de datos

Clasifica cada factura de compra en **~4 categorías**: costo directo (relacionado con el margen bruto),
bienes de uso, locaciones de servicio, y otros. Lo necesita porque son las categorías de la DDJJ de IVA
**y** porque el organismo hace **sondeos automáticos de margen de rentabilidad por rubro**: si todo se
manda a costo, el margen declarado cae por debajo del promedio del rubro y eso dispara inspección.

**El insight:** *"no es lo mismo que yo cambie cubiertas si tengo un taxi o si compro y vendo lechuga.
Para el taxista es costo; para el verdulero es un gasto."*

> **Un mismo proveedor tiene clasificación DISTINTA según el cliente del estudio.** Y una entidad puede
> ser **proveedor de un cliente y cliente de otro** al mismo tiempo.
>
> Modelo que se desprende: un **padrón de terceros** (identificado por CUIT, con razón social y actividad
> traídas del organismo) + una tabla de **clasificación por (cliente_del_estudio, tercero)**.
>
> ⚠️ **Corregido:** escribí que "el padrón compartido es N0/N1 y transversal". **No puede ser.** Guarda
> CUIT (N2R) y razón social (N2), y un derivado hereda el nivel máximo de sus insumos. Que el dato sea de
> origen público no lo desclasifica: **el conjunto** —qué entidades tocó este estudio— es el grafo de su
> cartera. El padrón lleva **`estudio_id`** y es N2R; lo único N0 es el **nomenclador de actividades**. Y
> la clasificación lleva `cliente_id`, con la policy escrita sobre esa columna y **nunca** sobre
> `estudio_id`: escribirla sobre el estudio no es una fuga entre estudios, es una fuga **entre clientes
> del mismo estudio**. ⚠️ Ojo: es justo la forma de fuga cross-tenant del hallazgo **H-6** de ADR-0002 (que el
> sistema sugiera en un cliente algo aprendido en otro). El padrón se comparte; la clasificación y las
> relaciones comerciales, **nunca**.

Y su idea de automatización, textual: al dar de alta un proveedor, validar el CUIT contra el organismo,
traer **la actividad**, y ofrecer ahí mismo el tilde de clasificación para **ese** cliente.

---

## 5. Vocabulario (insumo de UX y de nombres del producto)

Se usa **su** vocabulario, no el de un ERP. Lo que dijo, tal cual:

| Ella dice | Significa | Nota para el producto |
|---|---|---|
| **"Papel de trabajo"** | La planilla donde liquida un impuesto | Candidato a nombre de entidad de primera clase |
| **"Volcar"** | Cargar el asiento en el sistema contable | *"y este asiento después me voy al sistema y lo vuelco"* |
| **"Clasificar"** | Asignar cada movimiento a una cuenta | **Usar este verbo, no "categorizar" ni "taggear"** |
| **"Imputar"** | Dónde va contablemente una partida | |
| **"Ajuste manual"** | Lo que el sistema no resuelve y decide ella | Ya es su expresión para la cola de revisión |
| **"Cajonear"** | Demorar el registro de comprobantes | Su término para lo que el control de §4.2 detecta |
| **"Devengar"** | Registrar en el período que corresponde | |
| **"Cuenta especial" / "cuenta corriente"** | Dos cuentas del mismo titular en el mismo banco | El PDF trae las dos |
| **"Deudores por venta"** | Lo que le entra de clientes | |
| **"Cuentas particulares"** | Movimientos de los socios/dueños | El control que siempre hace |
| **"Ley débito-crédito"** | Impuesto sobre los créditos y débitos | Lo nombra así, no por su número de ley |
| **"Proyección de ganancias"** | Su cálculo mensual anticipado | Es **su** valor agregado; el nombre ya existe |
| **"Margen bruto" / "margen neto"** | Los que compara contra 5 ejercicios | |
| **"F931", "SICORE/SIJP", "CIRADIG"** | Presentaciones y sistemas del organismo | Vocabulario que el producto debe reconocer |
| **"El 1351"** | DDJJ anual de retenciones al trabajador | Área de sueldos: fuera de alcance |
| **"La escala del artículo 90"** | La escala progresiva de Ganancias | ⚠️ **Su vocabulario, no una cita.** La numeración del artículo en el texto ordenado vigente **hay que verificarla** antes de escribirla en cualquier parte del producto (`knowledge/` está vacío; regla de `CLAUDE.md` §1.6) |

**Y la distinción que hay que respetar en toda la UI**, porque la explicó ella y es fuente de errores:

> **El débito bancario es lo inverso del débito contable.** *"Desde la terminología bancaria, el débito
> es un descuento en la cuenta. Desde la terminología contable, el débito aumentaría una cuenta. Son
> inversos."* → Las columnas del extracto se llaman **como las llama el banco** (débito/crédito de la
> cuenta), y la conversión de signo al asiento es explícita y visible, nunca implícita.

---

## 6. Ideas y features que mencionó

Ordenadas por lo que ella misma priorizó:

| # | Feature | Quién la propuso | Módulo |
|---|---|---|---|
| 1 | PDF del extracto → tabla atomizada filtrable, **conservando el detalle que el Excel pierde** | Ella | **1** |
| 2 | Clasificación por reglas **por cliente**, con lo no resuelto en cola de "ajuste manual" | Ella (aceptó y pidió) | 2 |
| 3 | **Export en el formato de importación de su sistema contable** en vez de tipear | Él, ella confirmó que existe | 2 |
| 4 | Detección de **transferencias entre cuentas del mismo titular** (no son pago ni cobranza) | Ella | 2 |
| 5 | Identificar el débito del organismo y **que ella clasifique qué impuesto es** | Ella, textual: *"que vos me lo identifiques como ARCA y yo clasifique qué impuesto es"* | 2 |
| 6 | Cruce IVA compras cliente ↔ comprobantes del organismo, **con tolerancia temporal** | Ella | 3 |
| 7 | Padrón de terceros por CUIT (razón social + **actividad**) con clasificación **por cliente** | Ella | 3 |
| 8 | **Proyección mensual de Ganancias** con comparativo de 5 ejercicios y márgenes | Ella | 4 |
| 9 | Papel de trabajo de IVA **unificado** (un solo formato para todos los clientes) | Ella | 4 |
| 10 | Parámetros fiscales (deducciones, escala, topes) mantenidos **por el producto**, no por ella | Ella, por comparación con su sistema de sueldos nuevo | 4 |
| 11 | Reparto de base imponible de IIBB por actividad | Ella | 4 |
| 12 | Cruce contra el Excel del banco para **detectar los movimientos que el Excel perdió** | Él | 1-2 |

**Explícitamente fuera de alcance:** liquidación de sueldos (ya resuelta con otro producto), gestión
empresarial / ERP (facturación, cobranzas, cheques), y contabilidad de los dos clientes que usan su
propio sistema.

---

## 7. Qué afina, confirma o contradice lo ya decidido

### 7.1. Confirma

| Decisión previa | Evidencia |
|---|---|
| **Asientos asistidos, nunca automáticos** (`CLAUDE.md` §1.7) | Lo pidió ella con esas palabras: reglas + "ajuste manual" para el resto |
| **Tenancy estudio → cliente** (ADR-0001) | Su realidad exacta: un estudio, muchos clientes aislados |
| **Multi-estudio como producto, no a medida** | *"tengo otros estudios que tienen la misma necesidad, vendéselo"* → refuerza **R15** (ningún nodo por encima de los estudios) |
| **Plan de cuentas por cliente derivado de un modelo** (`plan-cuentas-multicliente`) | Copia un plan general y adecúa denominaciones por cliente |
| **Reglas y atributos por cliente** | *"cada cliente tiene su particularidad"* |
| **Un adapter por banco** (doc `02` del drive) | *"cada banco tiene su formato; si armás uno para uno y querés levantar otro, ya no te sirve"* |
| **Aislamiento como requisito, no feature** | Maneja datos de decenas de empresas; un cruce entre dos de sus clientes es un problema profesional para ella |
| **Presupuesto de recursos ajustado** (`03-reglas-desarrollo-optimizado.md`) | *"no le podés cobrar mucho al cliente, entonces no podés estar gastando una fortuna en sistema"* |

### 7.2. Afina (cambia una prioridad, no una decisión)

1. **El PDF es la fuente de verdad, no el formato incómodo.** El Excel del banco **pierde movimientos**.
   Esto cambia el encuadre del Módulo 1 y agrega una feature que nadie había pedido: **comparar el PDF
   contra el Excel del banco y reportar lo que el Excel perdió.** Es un argumento de venta por sí solo.
   ⚠️ **Refinado al medirlo**, y el matiz importa: el Excel es **más rico en CAMPOS** (trae grupo y código
   de concepto, comprobante, terminal, observaciones del cliente y leyendas como columnas propias, todo lo
   que el PDF mezcla en la glosa), y el PDF es autoritativo en **qué filas existen y en los saldos**. No es
   "el PDF trae más": es **PDF = completitud de filas; Excel = riqueza de campos**, y conviene **unirlos**.
   Dato que templa la expectativa: en el mes medido, el Excel **no perdió nada** — la feature vale, y el
   comparador necesita un test de mutación para no pasar en verde por casualidad.
2. **El OCR baja de prioridad** (§3.3): los PDF que llegan tienen texto; el que viene en papel no se
   escanea. Se deja el punto de extensión, no se construye.
3. **Un PDF ≠ una tabla.** Trae **varias cuentas y varias monedas**, con bloques que no son movimientos.
   El esquema tiene que modelar **cuenta** explícitamente (ADR-0001 §5.1 ya previó
   `cuenta_bancaria_id`; queda confirmado que no es opcional).
4. **El primer entregable útil para ella es un Excel/CSV**, no una pantalla. Su superficie de trabajo es
   la planilla. Coincide con ADR-0000 §2.2 (el Módulo 1 arranca sin app web) y le da una razón de
   negocio, no solo técnica.
5. **La salida final del Módulo 2 es un archivo importable a su sistema**, no un módulo contable
   completo. Baja muchísimo el alcance de lo que hay que construir para que deje de tipear.

### 7.3. Contradice / obliga a revisar

1. ⚠️ **Convenio Multilateral no aparece en la entrevista.** Estaba asumido como parte del alcance del
   MVP (doc `00` del drive: *"IVA + Ganancias + Ingresos Brutos, incluyendo Convenio Multilateral"*) y
   como uno de los ocho agentes de dominio. Con el piloto a la vista, **CM no es prioridad de carga de
   `knowledge/` ni de producto**.
   **Qué NO cambia:** el **modelo de datos** sigue soportando varias jurisdicciones simultáneas por
   cliente (ADR-0001 §5.2). Es exactamente la decisión que no hay que revertir: modelarlo cuesta cero
   hoy y una migración destructiva después. **Qué cambia:** el orden de
   `docs/agents/guia-carga-conocimiento.md` — primero IVA y Ganancias nacional (que ya era el mínimo
   viable), después IIBB de **una** provincia, y CM recién cuando aparezca un cliente que lo necesite.
2. ⚠️ **Monotributo no aparece.** El atributo "condición ante IVA" del cliente sigue siendo necesario,
   pero el caso a soportar primero es **responsable inscripto**, no monotributo.
3. ⚠️ **`balances-normas-tecnicas` es menos urgente de lo que parecía.** Ella firma balances, pero su
   necesidad inmediata no es la exposición según RT: es la **proyección** y que el balance mantenga
   razonabilidad entre ejercicios. El agente sigue teniendo sentido; su turno es más tarde.
4. ⚠️ **El cierre de ejercicio NO es diciembre**, y es un dato por cliente que ella misma decide al
   constituir la sociedad: los distribuye a lo largo del año para repartir su carga de trabajo, y evita
   diciembre porque es el mes de mayor cruce de información del organismo.
   → **Todo cálculo acumulado (la proyección, el control de §4.2) corre sobre el ejercicio del cliente,
   no sobre el año calendario.** Es un atributo versionado del cliente y un supuesto que, si se hornea
   como "enero-diciembre", rompe el producto para casi toda su cartera.
5. ⚠️ **La conversación no fijó precio ni modelo comercial**, y ella lo pidió explícitamente ("contame
   cómo son los costos"). Quedó abierto de común acuerdo: primero una prueba de concepto.

---

## 8. Lo que falta para cerrar el Módulo 1

| Falta | Por qué bloquea | Quién lo destraba |
|---|---|---|
| **El PDF real de un banco** (2-3 meses, un banco) | Sin él, el mapeo de columnas del adapter es una adivinanza — y es exactamente lo que el doc `02` del drive dice que no hay que hacer | Laura (los iba a subir a una carpeta compartida) |
| **Qué banco es el primero** | Galicia/Santander cubren el 90%; Macro es el más doloroso. Recomendación en §3.4 | Decisión de JP, atada a qué PDF llegue primero |
| **El Excel del banco del mismo período** | Habilita la feature de §7.2.1 (detectar lo que el Excel perdió) y confirma la clave única | Laura |
| Un ejemplo de su **papel de trabajo de IVA** y de la **proyección de Ganancias** | Insumo de los módulos 3 y 4, no del 1 | Laura (hay uno en el disco de JP, sin analizar todavía) |
| El **formato de importación** de su sistema contable | Define la salida del Módulo 2 | Laura |

---

_Redactado a partir del transcript de `privado/`. No contiene CUIT, números de cuenta, importes ni
razones sociales, y los rubros están generalizados **a propósito** para que la combinación de atributos no
identifique por cruce (ver la nota de cabecera). No afirmo que sea imposible identificar a nadie: afirmo
que se redactó el conjunto y no solo cada campo, y que la afirmación de la versión anterior —"nada de lo
que está acá permite identificar a un cliente del estudio"— era **más fuerte que lo que el contenido
sostenía**. Las afirmaciones fiscales de este
documento son **lo que dijo la entrevistada**, no doctrina verificada: `knowledge/` está vacío y ninguna
norma se cita por número (`CLAUDE.md` §1.6). **Validar con profesional matriculado.**_
