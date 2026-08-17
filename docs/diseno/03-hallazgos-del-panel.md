# Hallazgos del panel — antes del adaptador de Galicia

> Cuatro agentes trabajaron en paralelo sobre el material y el código: especificación del formato (→
> `02-formato-galicia.md`), **seguridad de la primera corrida real**, **estrategia de verificación del
> adaptador** y **qué capturar para el Módulo 2**.
>
> Este documento es lo accionable de los tres últimos. Lo que ya se arregló lleva ✅ con el archivo; lo que
> queda, ⏳ con su prioridad.
>
> **Estado de `knowledge/`: esqueleto sin contenido normativo.** Ninguna afirmación de este documento cita una
> RT, una resolución ni un artículo, porque no hay ninguna fuente cargada. Donde hacía falta una, dice
> **"no tengo esa fuente cargada"**. _Validar con profesional matriculado._

---

## 0. Lo que se arregló mientras el panel corría

Nueve bugs, todos **confirmados con una medición** antes de tocar nada. Ninguno lo había encontrado una
revisión.

| # | Bug | Cómo se confirmó | Dónde |
|---|---|---|---|
| 1 | **La glosa se comía el encabezado de la página siguiente, los totales y la carátula** — 9 de 80 filas, con el test en verde porque solo contaba filas | medición sobre el fixture | ✅ `toolkit.ts`: `particionar()` + ruido transparente vs. de corte |
| 2 | **El generador producía un fixture incoherente**: al forzar el débito grande calculaba `-(saldo + margen)` y con saldo ya negativo el importe quedaba **positivo** en la columna de débito | la verificación decía `no_cuadra` con razón | ✅ `extracto-sintetico.ts`, y ahora el generador **valida su propia salida** |
| 3 | **`glosa.ts` tomaba un importe por documento**: el patrón de 7-8 dígitos no excluía la coma, así que `1234567,89` → `[DOC],89` y el importe entraba a la lista de "documentos" | `depurarGlosa` sobre tres casos | ✅ `glosa.ts` |
| 4 | **`pnpm db:seed` borraba el rastro de auditoría append-only** y las siete tablas del Módulo 1, por un `cascade` con cinco tablas nombradas | lectura del comando + dependencias | ✅ `sembrar.ts`: enumerado, sin `cascade`, y aborta fuera de `local` o con lotes cargados |
| 5 | **`extraerTexto` dejaba el buffer detachado**: la segunda llamada tiraba `TypeError` | dos llamadas seguidas contra el PDF real | ✅ `texto-pdf.ts`: copia interna |
| 6 | **`requiereOcr` se calculaba por promedio**: 10 páginas con texto y 40 escaneadas promedian por encima del umbral | razonamiento + el caso de la página fantasma | ✅ `paginasSinTexto` por página |
| 7 | **El generador tenía el mes hardcodeado** (`/06/26`) mientras el período era parámetro, y **declaraba la página 4 dos veces** | inspección del fixture generado | ✅ mes derivado del período; secuencia `1..8` |
| 8 | **`.env` quedaba fuera del barrido de fuga**: `extname('.env')` es `''` | lectura del filtro | ✅ `barrido-fuga.ts` |
| 9 | **Las parameter properties no las soporta Node**: `tsc` compila, el proceso explota al importar | `pnpm fixtures:generar` falló | ✅ dos clases corregidas + **regla de código** que lo prohíbe |

Y un hallazgo que resultó **mejor de lo esperado**: al escribir el test de R28 se descubrió que **la RLS
forzada también suprime el `DETAIL: Failing row contains` de Postgres**. En una tabla sin RLS (`banco`) la
fila sale completa; en una tabla de dominio, no. Los siete renglones de ADR-0001 §5 dan una defensa que nadie
diseñó. Está escrito como test en `packages/data/tests/errores-pg.test.ts` — con la evidencia de los dos
lados, para que nadie concluya que la RLS es opcional en una tabla "auxiliar".

---

## 1. Seguridad de la primera corrida contra un archivo real

### 1.1. 🔴 Esta corrida **no** es "datos reales en un entorno de prueba"

ADR-0002 §A.1 dice, para N2 y N2-R: *"¿Entorno de prueba? **Nunca** — solo sintético"*. Cargar el CBU real de
un cliente y correr su PDF contra la base local contradice eso, y `APP_ENTORNO` hoy **no tiene ninguna
consecuencia**: con `local` el pipeline procesa material real sin objetar nada.

La base local vive en un volumen Docker de una máquina de escritorio: sin cifrado de disco declarado, sin
backup cifrado, sin retención, sin borrado con constancia. Y el PDF queda en MinIO local sin TLS. Todos los
controles del ADR siguen funcionando **dentro** de la base; ninguno protege el volumen.

**Antes del alta:**

1. Declarar el entorno de la corrida como **productivo a los efectos de los controles** (agregar `piloto` a
   `ENTORNOS`, o correr con `APP_ENTORNO=produccion` contra una base tratada como tal).
2. Entrada en `docs/seguridad/registro-excepciones.md` con lo que §F.3.7 ya pide: **quién autorizó** (el
   titular del estudio, no un agente), qué se cargó, dónde quedó, **cuándo se destruye**.

**Esto es decisión del titular, no mía.** El registro existe y está vacío.

### 1.2. 🔴 El pepper de desarrollo convierte `cbu_hmac` en un hash pelado

El archivo de ejemplo traía un `IDENTIFICADOR_PEPPER` con un valor de desarrollo literal, la única
validación es `length >= 32`, y ese valor tiene 52: **pasa**. Si el alta se hace con el `.env` copiado del
`.example` —que es lo que va a pasar—, el `cbu_hmac` del CBU real queda calculado con una clave **pública**:
está en el repo, en cada clon, en cada caché de CI.

Y el propio archivo explica por qué eso no sirve: *"un sha256 sin secreto se revierte con un diccionario en
minutos"*. Un HMAC con clave conocida **es** un hash sin secreto. La protección para toda fila cargada con
ese pepper es **cero**, mientras el código dice que está cubierta.

**Es de una línea:** generar el pepper con `crypto.randomBytes(32).toString('base64')`, ponerlo solo en
`.env`, y que `pepperDelEntorno()` **aborte** si el valor es el del `.example` y el entorno no es `local`.

### 1.3. 🟡 El pepper de hoy **no se puede rotar** — y el `.env.example` afirma lo contrario

El `.env.example` y el plan §10.2 dicen que rotarlo "obliga a recalcular `cbu_hmac`". Recalcular un HMAC
exige **el CBU en claro**, que el sistema deliberadamente no guarda. Conclusión real: **rotar el pepper hoy
significa pedirle los CBU otra vez a todos los clientes.**

Y el modo de falla es silencioso y contagioso: con el pepper nuevo el resolver devuelve
`cuenta_no_registrada` para todos a la vez; el operador —razonablemente— da de alta la cuenta otra vez; ahora
hay dos identificadores vigentes y el resolver entra en `cuenta_ambigua` **para siempre**.

**Cuesta cero hoy porque hay una cuenta y no cuatrocientas:** una columna `pepper_id` en
`cuenta_bancaria_identificador`, y el resolver compara por versión. Con eso la rotación es incremental y sin
pedirle nada a nadie: el próximo extracto trae el CBU en la carátula y la fila se re-hashea sola.

### 1.4. 🔴 No hay choke point de **escritura** auditada

`leerConAuditoria` hizo estructural el control de lectura: leer una tabla N2-R **no compila** sin haber
dejado rastro. Para escritura no hay nada equivalente — `'escritura'` está en `ACCIONES` y en el check
constraint, y **no se emite en ningún lugar del repo**.

O sea que "el alta de la cuenta queda auditada" depende de que quien escriba el script se acuerde. Y el alta
de `cuenta_bancaria_identificador` es la fila de la que cuelga toda la cadena de confianza de INV-6.

**Falta `escribirConAuditoria(tx, pedido, fn)`**, simétrica de la de lectura, y que el insert viva detrás de
una firma que la exija.

### 1.5. 🔴 Tres fugas del camino "leer el PDF → insertar la fila"

1. **El historial de la terminal.** Un `--cbu 0170…` queda en
   `PSReadLine\ConsoleHost_history.txt`: texto plano, permanente, **fuera del repo, fuera del barrido, fuera
   del `.gitignore`**, y sincronizado a cualquier backup de perfil. Además la línea de comandos de un proceso
   la lee cualquier proceso del mismo usuario y la captura cualquier EDR.
   **→ el alta NO toma el identificador por argumento ni por variable de entorno: se lee de stdin sin eco.**
2. **`.env`** — ✅ ya corregido (§0.8).
3. **El contexto de un agente. 🔴** ADR-0002 §F.2.5 prohíbe *"pegar datos reales en el contexto de un agente
   o LLM"*, y §H.3.bis es el precedente: los ocho controles estaban cerrados y la fuga entró igual, por
   cuatro importes que un agente escribió en comentarios mientras miraba el archivo real.
   **→ el CBU lo lee una persona y lo tipea. Ningún agente abre `privado/extractos/`.** Y hay que escribirlo
   en `CLAUDE.md`/`AGENTS.md` como prohibición explícita: hoy la regla vive en el ADR, y el ADR no es lo que
   se lee antes de abrir un archivo.

### 1.6. 🟡 Nada impide que el CBU entero termine en `numero`

`numero` es `not null` y existe para el **número de cuenta** entero. Nada en el esquema separa las dos cosas,
así que el camino de menor resistencia al escribir el alta es `numero = <el CBU que leí de la carátula>`. Ahí
el CBU queda **en claro** y la decisión de hashearlo se anula sin que nadie la revierta.

**Check constraint, y es preciso:** `check (length(regexp_replace(numero, '\D', '', 'g')) <> 22)`. Ningún
número de cuenta argentino tiene 22 dígitos; el CBU tiene exactamente 22.

### 1.7. 🔴 El objeto en el storage **no hace rollback**

El PDF se escribe **dentro** de la transacción. Cualquier fallo posterior —una constraint en la fila 143, la
verificación que no cuadra, un `kill`— deja el objeto en `cliente/<uuid>/extracto/<loteId>.pdf` con un
`loteId` **que no existe en la base**. El bucket no tiene listado y no hay inventario: es el extracto de un
cliente en un lugar del que el sistema no sabe, fuera de la retención, fuera de la auditoría y sin forma de
encontrarlo.

**Qué hacer:** el objeto se escribe **último**, después de que las filas entraron y la verificación pasó,
inmediatamente antes del commit; compensar con `eliminar()` en el `catch`, y `logger.error('objeto_huerfano')`
si la compensación también falla. Más un chequeo de reconciliación (claves del prefijo vs.
`lote_ingesta.archivo_clave`) en el job de mantenimiento.

**Y el corolario general:** *la auditoría de un efecto no transaccional se escribe y se commitea **antes** del
efecto, en su propia transacción.* Hoy `descarga.ts` audita dentro de la transacción y firma dentro: un
rollback posterior borraría el rastro y dejaría la URL viva — exactamente lo que el comentario de ese archivo
dice haber evitado.

### 1.8. 🔴 `fila_origen` es `jsonb not null` **sin forma declarada**

Se guarda la fila cruda **completa y sin depurar**: es la razón por la que la tabla existe. Lo que hay que
escribir es qué **no** puede llevar, porque hoy quien escriba el adaptador lo decide a las once de la noche:

1. **Nada que no sea de esa fila.** No el texto de la página, no el encabezado. Multiplicaría el extracto por
   326 filas y **una lectura auditada de una sola fila entregaría el documento completo** — el rastro diría
   "leyó una fila" y la realidad sería "se llevó el extracto". Destruye la proporcionalidad del rastro, que es
   la propiedad por la que se creó la satélite.
2. **Nada del titular** (razón social, CUIT, condición IVA, domicilio): es de la carátula, no de la fila.
3. **El nombre del archivo ni su ruta**: ya está excluido de `lote_ingesta` por diseño.
4. **Nada derivado del parseo** (`importe` signado, `filaHash`, versión del adaptador). Si el derivado vive
   junto al insumo, el día que se reinterprete el lote nadie sabe cuál de los dos es la verdad. **La satélite
   es el insumo.**

**→ `filaOrigenSchema` con `.strict()`, validado antes del insert.** El registro de clasificación clasifica la
**columna**; para un `jsonb`, eso es una etiqueta, no un control.

### 1.9. 🟡 El pipeline usa el logger genérico teniendo el acotado escrito

`loggerAcotado<Clave>()` fue la condición de salida nº 7, escrita porque *"un blocklist pierde siempre contra
el próximo campo"*. Y todo el Módulo 1 llama al `logger` genérico. La persistencia es donde entran los campos
nuevos (`filas_insertadas`, `verificacion_estado`, `filas_con_ruptura`): es el momento de cambiar, antes de que
haya veinte llamadas que migrar.

### 1.10. 🟡 R21 dice "staging por lote" y no hay tabla de staging. Hay que decidir por escrito

Recomendación: **no hay staging**, y R21 se reduce a lo que de verdad protege — **prohibido `COPY … FROM` sobre
tablas de dominio**. Un `insert … values` parametrizado con `app_request` y contexto ya evalúa `with check`
fila por fila, que es lo que R21 quería garantizar.

**Por qué hay que escribirlo:** si queda abierto, el día que 326 filas tarden alguien va a crear la tabla de
staging **sin RLS "porque es temporal"** — y una tabla temporal con 326 filas de un extracto real y sin
`cliente_id` es la fuga que R21 existe para evitar.

---

## 2. Estrategia de verificación del adaptador

### 2.1. De los 4 detectores que las mutaciones pendientes tienen que poner rojos, **existen cero**

| Mutación declarada | Estado del detector |
|---|---|
| `mover_ultima_linea_de_descripcion_al_bloque_siguiente` | **mal planteada**: el texto mutado es un extracto legítimo y ninguna red aritmética puede verlo. Se desdobla en tres tests (ver abajo) |
| `borrar_una_pagina_entera` | `EST_PAGINA_FALTANTE` y `EST_PAGINAS_DECLARADAS_NO_COINCIDEN` están **declarados y nunca se emiten**. V8 no está implementado |
| `borrar_la_linea_de_totales_del_texto` | **el `it.todo` está mal**: dice `→ no_verificable` y lo correcto es **`no_cuadra`** con `ARIT_TOTAL_CREDITOS`/`campo=totales_no_encontrados`. Un banco que dice publicar totales y un parser que no los encontró **no son lo mismo**, y degradar a `no_verificable` esconde el segundo detrás del primero |
| `vaciar_el_texto_de_dos_paginas` | `PDF_PAGINA_SIN_TEXTO` no existe en `CODIGOS_DIFERENCIA` |

**El desdoble de la primera** (es la que enseña más):

- **Test A — la ceguera, escrita.** Mover la continuación produce un extracto legítimo: los 80 importes,
  saldos, fechas, la cadena, los totales y el conteo quedan **idénticos**. Se afirma que la verificación da
  `cuadra` y que la salida difiere del esperado **solo** en `descripcionLineas` de dos movimientos. Deja
  escrito y ejecutable que ninguna red aritmética la ve.
- **Test B — la red que sí funciona.** Mutación distinta: poner un token con forma de importe **en las
  columnas de importe/saldo de una continuación**. Detector nuevo `EST_PAR_NO_EN_ULTIMA_LINEA`: si una línea
  **no final** del bloque trae token en esas columnas, es ambigüedad estructural → se rechaza, no se resuelve
  por preferencia.
- **Test C** — ninguna continuación arranca con fecha: el adaptador no puede crear una fila, y la línea va a
  `lineasNoInterpretadas` con `fila_sin_importe`.

### 2.2. Cinco agujeros donde **ningún** invariante ataja

| Mutación | Qué la ataja hoy |
|---|---|
| **Borrar una línea de continuación de glosa** | **NADA.** Importes, saldos, cadena, totales y conteo intactos. La única red posible es que el `esperado.json` declare `lineasPorMovimiento` |
| **Convertir una continuación en movimiento** (fecha + `0,00` + saldo repetido) | **NADA.** Cadena ✓, totales ✓ (0 no suma), hash ✓, refine ✓. Solo lo ve el conteo esperado — que en producción no existe |
| **Correr una columna 2 caracteres** | Parcial: `-1.234,56` → `1.234,56` **sigue siendo un importe válido con el signo cambiado**. Falta `columna_sin_ancla` a nivel página |
| **Borrar el encabezado de una página** | **NADA** si el adaptador ancla una vez y reusa. No hay chequeo de `paginasConEncabezado` contra nada |
| **Duplicar la carátula de la cuenta 1 al final** | **NADA**: no hay chequeo de unicidad de cuenta dentro del lote. Con la FK de tres columnas explota recién en la base, al final del job |

### 2.3. Los anti-patrones que van a aparecer

1. 🔴 **`toMatchSnapshot()`** sobre la salida del adaptador: la primera corrida escribe el snapshot y el test
   verifica que el adaptador siga siendo igual a sí mismo. Todo bug de la corrida 1 queda certificado.
   **→ prohibirlo por test de arquitectura.**
2. 🔴 **Regenerar `esperado.json` en el mismo commit que arregla el adaptador.** Es el snapshot con otro
   nombre. **→ `generar-fixtures.ts` no puede importar nada de `src/adaptadores/`.**
3. 🔴 **Comparar Σ calculada contra Σ calculada**: `expect(sum(movs)).toBe(cuenta.totalCreditosDeclarado)`
   donde los dos salen del adaptador es el chequeo que siempre pasa. La prueba de que el declarado viene del
   documento es **mutar el dígito en la línea `Total` del texto**: si el adaptador lo calcula en vez de
   leerlo, ese test **no se pone rojo** — y esa es la señal.
4. 🔴 **`toBeGreaterThan(0)` en lugar de igualdad.** Un adaptador que devuelve 1 fila pasa.
   ✅ ya corregido en `toolkit.test.ts`.
5. 🔴 **`expect(estado).not.toBe('no_cuadra')`** — pasa con `no_verificable`.
6. 🔴 **"alguno de estos códigos"**: deja pasar que la mutación esté detectada por el detector **equivocado**.
7. 🔴 **Definir las reglas de clasificación dentro del test**: el test demuestra que el fixture es
   clasificable, no que el adaptador lo clasifica. **Las reglas van en el producto.**
8. 🔴 **Una mutación de texto que no encuentra su objetivo** no cambia nada y el test queda verde para
   siempre. Cada mutación asegura primero **que el texto cambió, y cómo**.

### 2.4. Rasgos que le faltan al fixture

Sin estos, el adaptador no se puede desarrollar contra el fixture y hay que mirar el archivo real — que es
exactamente lo que el gate existe para evitar.

| Prioridad | Rasgo | Qué habilita |
|---|---|---|
| 🔴 | **Continuación con importe en las columnas de importe/saldo** | el test B de §2.1 |
| 🔴 | **Continuación que arranca con fecha** | el test C de §2.1 |
| 🔴 | **Delimitador de página** (`\f`) + `extracto-sintetico.paginas.json` | construir `TextoDelPdf.paginas` sin re-derivarla del encabezado, que es circular |
| 🔴 | **Pie con total de páginas declarado** (`Hoja 3 de 7`) | `EST_PAGINAS_DECLARADAS_NO_COINCIDEN`, y el caso "26 físicas vs 25 declaradas" |
| 🔴 | **Pares `(fecha, importe)` repetidos** — 7 grupos en el real, **0** en el fixture | que `(fecha, importe)` **no** sea clave. Hoy un cruce con esa clave pasa todos los tests y falla contra el archivo real |
| 🔴 | **Bloque de anexo posterior al `Total`**, con tres períodos | `anexoExtractoSchema` (hoy `anexos: []` siempre) y la regla "prohibido que entre en la suma" |
| 🔴 | **Indentación variable de continuación** y un movimiento con espacio adelante | forzar que el inicio de fila se ancle en la **columna de fecha**, no en `/^\s{4}/` |
| 🔴 | **Segundo fixture con otra forma** | `reconoce() === false` y `resolverAdaptador → sin_adaptador`. Con un solo fixture el registro no se puede probar en negativo |
| 🟡 | Empate genuino, cuenta en USD, página con encabezado y cero movimientos, importe `0,00`, glosa con la palabra `Total`, glosa con `�`, variante de dos columnas | V12, el guarda `imp !== 0n`, `ordinalEnEmpate`, `EST_ENCODING_ROTO` |

✅ Ya corregidos de esta lista: la numeración de páginas del fixture y el mes hardcodeado (§0.7).

---

## 3. Qué capturar hoy para que el Módulo 2 sea posible

### 3.1. El problema de fondo: **capturado y no persistido = no capturado**

El esquema Zod captura ~30 campos y la migración persiste 14. Lo que el adaptador capture y la base no guarde
sobrevive **solo** dentro de `movimiento_origen_crudo.fila_origen`, que es N2-R con lector auditado. Un
Módulo 2 que necesite leer ahí para clasificar 326 filas por pantalla **pasa toda la clasificación al régimen
auditado** — el H-8 que la satélite existía para evitar.

### 3.2. Campos que faltan, por costo de agregarlos después

| Falta | Por qué lo necesita el asiento | Si se captura después |
|---|---|---|
| **Tabla de `anexos`** — no existe ninguna | El bloque posterior al `Total` trae renglones que **no son movimientos** y cubren períodos distintos | **No es reconstruible desde los movimientos.** Y el cliente de mayor volumen entrega en papel: ahí no hay PDF al que volver |
| **`jurisdiccion`** (no está ni en el esquema ni en la base) | Una retención provincial sin jurisdicción no se computa como pago a cuenta en su fisco. Una sola cuenta "Retenciones IIBB" que mezcla jurisdicciones **cuadra**, y se descubre cuando la provincia la rechaza | Ilegible después: dos bancos la nombran, uno no |
| **`credito`/`debito` + `columna_origen`** | Es la doble evidencia (posición + signo) de la conversión banco→contable | Nadie puede auditar la inversión de signo, que es el error clásico que la contadora señaló |
| **`concepto_grupo_codigo` + el literal publicado + `conceptoNormalizado`** | La base tiene solo `concepto_codigo`. Un código sin grupo y sin literal no se audita ni se mapea | Es el insumo de la corrección de las reglas por texto libre |
| **`referencias[]` con tipo** (la base tiene un solo `referencia_externa`) | El número de factura **empareja la comisión con su IVA**; el de comercio/terminal es el join con la liquidación del adquirente; el VEP identifica el pago | Los identificadores viajan en la glosa y la glosa se depura: si no se extraen hoy, se pierden hoy |
| **`pagina_pdf`** | La evidencia del asiento tiene que apuntar a la hoja | reproceso puro |
| **`cotizacion` + `cotizacionProvista`** | Un movimiento en USD no tiene valor en pesos y el extracto no lo trae | Si el campo no existe, alguien lo va a completar con la cotización de hoy: **valuación retroactiva inventada** |
| **`es_movimiento` + `motivo_exclusion`** | "Supe y decidí que no es movimiento" ≠ "no supe" | Ninguna corrida vieja es auditable |
| **`tipo_cuenta`** | 🔴 **Bug abierto:** el esquema tiene 6 valores, el check de `0004` admite **4**, y aplasta `cuenta_corriente_especial` —que el piloto **tiene**— a `'otra'`. El tipo decide si el descubierto es posible | migración de datos ya cargados |

Y el renombre pendiente: `importe` → **`importeSignado`**. `importe` a secas es el campo que alguien manda al
asiento sin pensar.

### 3.3. La depuración de la glosa **rompe seis reglas** de la contadora

El corte es nítido: **no toca ninguna regla que decida por texto, nombre o concepto; rompe todas las que
tienen por clave un número.**

1. **"Créditos con número de DNI → Deudores por venta"**: el DNI queda `[DOC]`, y `[DOC]` también lo produce
   un número de operación o una fecha compacta. **La presencia del marcador no prueba que haya un documento.**
2. **"Transferencia al CUIT de un socio → Cuentas particulares"**: necesita el **valor** para comparar contra
   el padrón de socios. Es el único control que la contadora hace siempre.
3. **"Débito del organismo recaudador → ARCA"**: el CUIT de un organismo público **no es** el dato de un
   tercero que nunca consintió — es N0. Enmascararlo es costo sin beneficio: hace falta una **allowlist** de
   organismos y del propio banco.
4. **"IVA sobre comisiones → crédito fiscal"**: el número de factura empareja la comisión con su IVA, y un
   número con ceros a la izquierda tiene **exactamente 8 dígitos** → `[DOC]`. Se rompe el par.
5. **"Acreditaciones de tarjeta"**: el número de comercio/terminal es la clave de join con la liquidación del
   adquirente, y las **271 corridas de 8 dígitos** medidas en el extracto son justamente terminales.
6. **"Débito del organismo sin más detalle: por fecha y monto"**: el VEP y las fechas compactas → `[DOC]`.

**Ningún valor se pierde** (están en la satélite). Lo que se rompe es el **régimen de acceso**: clasificar
obligaría a leer N2-R por fila. La salida que no sacrifica ninguna de las dos cosas, en la tabla N2:

- **`contraparte_documento_tipo`** (`'cuit' | 'dni' | null`): un tipo no identifica a nadie y resuelve (1).
- **`contraparte_documento_hmac`**, con el mismo pepper: compara contra el padrón de socios y contra la lista
  de organismos **sin leer el valor**. Determinístico y testeable; resuelve (2) y (3).
- **`referencias[]` con tipos cerrados**, extraídas **antes** de depurar y persistidas en N2: un número de
  factura, de VEP o de comercio **no es dato personal**. Resuelve (4), (5) y (6).

### 3.4. El código de concepto: dos de tres confirmados, **uno refutado**

- **Regla de haberes vs. comisión del servicio de haberes: confirmado**, con una precisión que cambia la
  implementación — el arreglo exige el **concepto** (6 dígitos), no el **grupo**, que es lo que causó el
  error. Y el signo no discrimina: el pago de haberes y su comisión son **los dos débitos**.
- **Regla de percepción capturada como crédito fiscal: confirmado solo el falso positivo.** El código separa
  "IVA" de "percepción" y ahí el error desaparece. **No hace correcto el asiento:** que ese IVA sea crédito
  fiscal computable depende de la condición ante IVA, de la afectación a actividad gravada, del prorrateo y de
  los requisitos de cómputo. Sobre todo eso: **no tengo esa fuente cargada**. El Módulo 2 **no puede cablear**
  "IVA → crédito fiscal": propone y deja el prorrateo al contador.
- **Regla de acreditaciones de tarjeta: REFUTADA.** El código dice *que* es una acreditación de tarjeta, que
  es lo que el texto ya decía. El error es que **el importe llega neto** de arancel, IVA y retenciones, y esos
  componentes **no están en el extracto en ninguna forma**: están en la liquidación del adquirente. El código
  no cambia una coma del asiento.
  **El plan se contradice acá:** §3.3 dice que los tres errores desaparecen con el código y §11 dice que sin
  la liquidación esa regla queda mal para siempre. **La segunda es la correcta.** Tratamiento honesto:
  registrar el cobro del **neto** con marca de incompleto y mandarlo a ajuste manual. Nunca proponer el asiento
  por el neto (cuadra y deja un residuo permanente), y **nunca estimar el bruto**.

### 3.4.bis. CORRECCIÓN — el código de concepto lo tiene UN banco de ocho

Todo el §3.4 de arriba razona sobre "el código de concepto del banco" como si fuera un dato disponible. **Se
midió y no lo es.** La conclusión de arriba se escribió sobre una muestra de uno y hay que leerla con esta
corrección al lado.

Medición de las planillas de los ocho bancos (columnas: texto del banco, sin datos de clientes):

| Banco | Planilla | Columnas de concepto | ¿Código? | Uso real |
|---|---|---|---|---|
| **Galicia** | `.xlsx`, 16 col. | `Grupo de Conceptos` (11 distintos) + `Concepto` (34 distintos) | **SÍ** | mucho |
| Santander | **texto renombrado a `.xls`** | `Referencia`, `Concepto` | no | mucho |
| Bancor | `.xlsx`, 6 col. | `CONCEPTO/EMPRESA - N° DE OPERACIÓN` | no | mucho |
| Macro | `.xls` BIFF | `Nro. de Referencia`, `Concepto` | no | mucho, un cliente con muchísimos movimientos |
| Credicoop | `.xls` BIFF | `Concepto` | no | poco |
| ICBC, Nación, BBVA | **ninguna** | solo el PDF | no | poco |

**Uno de cinco.** Y en los otros cuatro el "Concepto" es **texto libre** — se vieron valores como
`Impuesto Ley 25.413 Debito 0,6%`, `Debito Comercio Fiserv`, `Snp Debito Directo - Flexxus`.

Además hay **cuatro tecnologías distintas** detrás de la palabra "Excel": `.xlsx` (ZIP), `.xls` BIFF (OLE2),
texto delimitado renombrado a `.xls`, y —según el análisis previo— HTML renombrado. Un solo lector no las cubre.

**Qué se cae de §3.4:** el arreglo de las reglas por "matchear el código en vez del texto" **solo aplica a
Galicia**. Para los otros siete bancos el reconocimiento tiene que funcionar con la evidencia que haya, y eso
cambia el diseño: no es un detalle de implementación.

**Qué sigue en pie:** `conceptoOrigenDato: 'pdf' | 'excel' | 'ninguno'` sigue haciendo falta, y por una razón
más fuerte que la original. En Galicia el código está en el Excel y no en el PDF, así que llega por el cruce;
si el Excel falta —o el cliente entrega papel— **no hay código**. Sin ese campo, "este banco no publica código",
"el Excel no llegó" y "el código vino vacío" se ven igual, y el sistema caería en silencio al matcheo por texto
justo cuando menos hay que confiar en él.

**Cómo se rediseña:** separando **reconocer** de **imputar**. El reconocimiento del tipo de movimiento depende
del banco y de la evidencia que ese banco entregue; la imputación —qué cuenta y qué lado— es del dominio
contable y es **una sola tabla común a todos los bancos**, derivada de las 14 reglas de la contadora. El
diseño de las dos piezas está en `04-imputacion-contable.md`.

### 3.5. `saldo_es_acreedor`: **la ambigüedad está horneada en el nombre**

La palabra significa cosas opuestas en dos libros:

- En el extracto, dicho desde los libros **del banco**: *saldo acreedor* = el banco le debe al cliente =
  **el cliente tiene fondos**.
- En los libros **del cliente**: *saldo acreedor* en la cuenta Banco = saldo en el haber = **descubierto**.

El repo usa la segunda convención. **Si el adaptador de un banco que imprime la palabra la mapea derecho a
ese booleano, todos los saldos normales quedan marcados como descubierto y el signo de la cadena entera se
invierte** — literalmente el error que la marca vino a prevenir. El nombre garantiza el error.

**En orden:**

1. Capturar **lo publicado, literal**: `saldoLeyendaPublicada: 'acreedor' | 'deudor' | null`.
2. Declarar la convención en `capacidades`: `convencionSaldo: 'perspectiva_banco' | 'perspectiva_cliente' | 'signo'`.
3. **Derivar el signo de la cadena de saldos, no de la palabra.** La desambiguación se vuelve verificable: se
   toma un movimiento de dirección conocida —una comisión bancaria es siempre débito— y se comprueba que la
   cadena lo interprete así. Si no coincide, el adaptador tiene la convención al revés y **falla el lote**.
4. El derivado contable se llama por lo que significa: **`saldoEnDescubierto`**, y es **tri-estado**: "no
   publicado" ≠ "no descubierto".

**Si el descubierto es real:** la cuenta deja de ser activo y es pasivo (adelanto en cuenta corriente), y
**no se compensa** con otra cuenta bancaria de saldo positivo. La norma que respalda la no compensación:
**no tengo esa fuente cargada**. Devenga intereses, comisiones e IVA sobre esos intereses, con devengamiento
por día —acá sí pesa la fecha valor— y el cargo puede caer en otro mes que el del devengamiento; el
tratamiento fiscal: **no tengo esa fuente cargada**.

Y una señal gratis que hoy no se puede usar: un "saldo acreedor" en una **caja de ahorro** es casi siempre
error de parseo, porque la caja de ahorro no admite descubierto. No se puede usar porque el `tipo_cuenta` de
`0004` no distingue la cuenta corriente especial (§3.2).

### 3.6. Fecha contable vs. fecha valor

Para el asiento manda la **fecha contable** — la que el banco imputa a la cuenta: es la que hace que la cuenta
Banco reconcilie con el extracto y la que define el período de la partida. La **fecha valor** es dato
financiero (disponibilidad, devengamiento de intereses del descubierto) y **no mueve el período del asiento**.
Las dos están capturadas y persistidas — correcto.

**¿Criterio de las RT sobre esto? No tengo esa fuente cargada.** No hay ninguna RT en `knowledge/`, ni número
ni texto, y la **adopción por el Consejo Profesional** de la jurisdicción del cliente tampoco: sin adopción
jurisdiccional una RT no rige. Lo anterior es criterio de práctica, a validar.

Dos consecuencias de diseño que sí se pueden afirmar:

- **V7 corre sobre `fecha`, nunca sobre `fecha_valor`.** La fecha valor puede ir hacia atrás legítimamente. Si
  alguien la usa, V7 se rompe por un dato correcto y el camino de menor resistencia es relajar V7 — el mismo
  patrón del hallazgo del fixture con fechas desordenadas.
- **El período del asiento sale de `fecha`, no del período del extracto.** Un movimiento de los últimos días
  hábiles que aparece en el extracto siguiente pertenece al mes de su fecha: es el dolor que originó el
  proyecto. Y el ejercicio del cliente **no es calendario**.

### 3.7. Lo que el Módulo 1 **no** hace, con su motivo contable

1. **Asignar la cuenta contable, aunque el concepto sea obvio.** El mismo concepto va a cuentas distintas
   según el cliente, y el plan de cuentas es por cliente y versionado.
2. **Netear** comisión + IVA, o la acreditación contra su arancel. Destruye el crédito fiscal y las
   retenciones, y **un neto no se des-netea después**.
3. **Agrupar o sumar por concepto.** Rompe el uno-a-uno con la línea del extracto, que es la trazabilidad.
4. **Traducir el signo a debe/haber.** La conversión al asiento es explícita y del Módulo 2.
5. **Deducir una cotización.** Produce un asiento que cuadra y está mal.
6. **Marcar "es transferencia entre cuentas propias" o "es CUIT de socio".** Requieren padrón: el Módulo 1
   captura la **evidencia** que lo hace decidible.
7. **Sumar los anexos con los movimientos.** El impuesto queda contado dos veces **y el asiento cuadra igual**.
8. **Descartar líneas sin registrar la decisión.** La aritmética se verificaría contra un universo filtrado a
   criterio del parser.
9. **Devengar o reimputar por fecha.** La imputación temporal es criterio.
10. **Rellenar por diferencia** un importe o un total ausente. Un valor tapón hace cerrar la cadena **por
    construcción** y destruye el único detector que había. Para eso existe `no_verificable`.
11. **Dar de alta la cuenta o el tercero automáticamente.** El archivo definiría la verdad.
12. **Calcular la alícuota del impuesto a los débitos y créditos** ni la porción computable como pago a
    cuenta. Es fiscal y **no tengo esa fuente cargada**.
13. **Aceptar un lote parcial "para no perder el trabajo".**

---

## 4. Orden de trabajo recomendado

Nada de esto es opcional antes de `galicia.ts`, y el orden importa:

1. **Los 🔴 de seguridad de §1** — el pepper va **primero**, porque recalcular después exige el CBU en claro.
2. **Los rasgos 🔴 que le faltan al fixture** (§2.4), y extender el chequeo 7 del gate para que no se pierdan.
3. **Ampliar `esperado.json`** con `lineasPorMovimiento`, `paginas` y `paginasDeclaradas`.
4. **Los códigos de diferencia que faltan** e implementar V8 y la partición contada en `invariantes.ts`.
5. **Corregir el `it.todo` de los totales** y desdoblar el de la glosa corrida en tres tests.
6. **Recién ahí el adaptador.**

_**Validar con profesional matriculado.** Y antes de eso: cargar `knowledge/`. Las cuatro respuestas que hoy
quedan en "no tengo esa fuente cargada" —cómputo del crédito fiscal, régimen de recaudación bancaria
provincial, criterio de las RT sobre imputación temporal, y no compensación de saldos— son las que el Módulo 2
necesita para que sus propuestas valgan algo._
