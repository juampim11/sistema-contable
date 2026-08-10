# Especificación del formato — Santander, cuenta corriente (PDF)

> **Estado:** medido sobre un archivo real de un período. **Sin un solo valor del cliente**: etiquetas
> impresas por el banco, posiciones en puntos PDF, conteos y formas.
> **Fuente:** un único archivo. Lo que valga para otros períodos está en §15, no determinado.
> Revisado contra la corrida del adaptador (`pnpm probar --banco santander --archivo <pdf>`): §9.1 y §9.2
> traen lo que la corrida amplió, §10.1 el Done cumplido.

---

## 0. El hallazgo que cambia el diseño

**El signo del importe NO está en el token.** Santander imprime `$ ##.###,##` en las dos columnas de importe,
**siempre sin signo — 0 de 158 filas traen un `-`**. La única fuente del signo es en qué columna cayó el
token, o sea la posición `x`.

En Galicia había dos evidencias redundantes (columna + signo del token). Acá hay **una sola señal directa**, y
su verificación es la cadena de saldos.

**Consecuencia:** `aLineas()` no es una alternativa degradada, es **imposible**. Las 60 líneas que traen el par
`(importe, saldo)` en la misma línea que la fecha son **indistinguibles entre débito y crédito**: el texto es
idéntico.

**Y la trampa de portar código:** `leerPar()` de `galicia.ts` devuelve `null` cuando el signo del token no
coincide con la columna. Acá **nunca coinciden porque el token no tiene signo** → copiado tal cual da **0
movimientos**.

---

## 1. Extracción

| Dato | Valor |
|---|---|
| Páginas | **11** |
| Con tabla de movimientos | **8** (2–9) |
| Sin texto | **ninguna** |
| `requiereOcr` | `false` |
| Filas geométricas | **414** |
| Líneas de `aLineas()` | 519 |
| Páginas declaradas (pie `N - M`) | **11 = reales** — sin página fantasma, al revés de Galicia |

Partición geométrica exacta, **residuo 0**: `414 = 158 movimientos + 98 continuaciones + 2 Saldo Inicial +
2 Saldo total + 9 encabezados + 8 cabeceras de cuenta + 7 pies + 1 "no tenés movimientos" + 129 fuera de tabla`.

---

## 2. Carátula: **todo rotulado**

Es donde Santander es mucho más benigno que Galicia. Las tres trampas de la carátula de Galicia no existen acá.

| Dato | Etiqueta impresa | Forma | Regex |
|---|---|---|---|
| CUIT | `CUIT:` | `##-########-#` | `/^CUIT:\s*(\d{2}-\d{8}-\d)$/` |
| Nº de cuenta | `Cuenta Corriente Nº` | `###-######/#` | `/^Cuenta Corriente(?: especial U\$S)? Nº\s*(\d{3}-\d{6}\/\d)/` |
| CBU | `CBU:` | `######################` | `valorPorEtiqueta(['CBU:'], /\d{22}/)` |
| Período desde | `Desde:` | `##/##/##` | `/^Desde:\s*(\d{2}\/\d{2}\/\d{2})$/` |
| Período hasta | `Hasta:` | `##/##/##` | `/^Hasta:\s*(\d{2}\/\d{2}\/\d{2})$/` |
| Saldo inicial | `Saldo Inicial` | `-$ #.###.###,##` | fragmento en `x≈115.0` |
| Saldo final | `Saldo total` | `-$ #.###.###,##` | etiqueta en `x≈386.7` |
| Acuerdo | `Acuerdo:` / `Vencimiento:` | `$ #.###.###,##` / `##/##/##` | por etiqueta sobre el texto de la fila |

### 2.1. Las tres trampas de la carátula

1. **`Nº` es U+00BA** (ordinal), no U+00B0 (grado). Verificado por codepoint. Un regex con `°` no engancha nunca.
2. **El "Saldo total en cuentas" de las páginas 1 y 2 es ilegible por fila**: sale en **tres fragmentos**
   (símbolo, entero, centavos) y los centavos están en **otro baseline** (2.7 pt arriba en p1, 4.2 en p2: son
   superíndice). Peor: los importes de **pesos y dólares comparten los mismos dos baselines**, así que la fila
   reconstruida mezcla las dos monedas. **No leer el saldo final de la carátula**: leerlo de la fila
   `Saldo total` de la tabla, que sale limpia en un fragmento.
3. La cabecera de cuenta se repite en las 8 páginas de tabla y **sus `x` no son estables**: el mismo texto mide
   179.3 pt en p2 y 130.4 en p3–p9 (variante de fuente), lo que corre el importe de `Acuerdo:` de `r=423.5` a
   `r=374.6`. Esa línea se parsea **por etiqueta sobre el texto**, nunca por `x`.

### 2.2. Hay etiqueta de saldo, las dos

`Saldo Inicial` es una fila de la tabla con fecha, glosa rotulada y saldo, **sin importe**. `Saldo total` es
una fila con etiqueta a la izquierda y un único importe. **No hay que derivar nada por aritmética**; la
derivación de Galicia queda como control cruzado.

---

## 3. Cuerpo: seis columnas, en puntos PDF

Encabezado literal: `Fecha Comprobante Movimiento Débito Crédito Saldo en cuenta`.

| # | Columna | Alineación | `x` izquierdo | Borde derecho | Ventana |
|---|---|---|---|---|---|
| 1 | `Fecha` | izquierda | **23.0** | 23.4 ó 58.5 (§11.2) | `x = 23.0 ± 1.2` |
| 2 | `Comprobante` | izquierda | **65.0** | ≤ 103.9 | `x = 65.0 ± 1.2` |
| 3 | `Movimiento` (glosa) | izquierda | **115.0** | ≤ 274.8 | `x = 115.0 ± 1.2` |
| 4 | `Débito` | **derecha** | variable | **408.0** | `[404, 412]` |
| 5 | `Crédito` | **derecha** | variable | **492.0** | `[488, 496]` |
| 6 | `Saldo en cuenta` | **derecha** | variable | **578.0** | `[574.5, 582]` |

**Los tres bordes derechos son valores exactos, sin dispersión**: 83 fragmentos en `r=408.0`, 75 en `492.0`,
160 en `578.0`, con importes de 3 a 10 dígitos. Más limpio que Galicia.

**Tolerancia de `x` ≤ 1.2 pt obligatorio:** el bloque `Tasas de Acuerdos y Descubierto` tiene su fecha en
`x=25.0`, a 2.0 pt de la columna de fecha — con tolerancia 2.5 sus dos filas entran como movimientos.

`TOLERANCIA_FILA = 2.5` sirve: interlineado dentro de un movimiento **10.5–12.6 pt**, entre movimientos
**≥18.6 pt**. Ojo que 2.5 es *casi* los 2.7 pt del superíndice de la carátula: funciona por 0.2 pt.

---

## 4. Signo: dos columnas y **cero** notaciones de negativo en el importe

| Campo | Positivo | Negativo |
|---|---|---|
| Importe (débito y crédito) | `$ #.###,##` | **no existe** — 0 de 158 |
| Saldo | `$ #.###,##` (no observado en ARS) | `-$ #.###.###,##` — **signo antes del `$`** |
| `Saldo total` | ídem saldo | `-$ #.###.###,##` |
| `.xls` (importe **y** saldo) | `#.###,##` | `(#.###,##)` — **paréntesis** |

Todos los `-` son **U+002D**, verificado por codepoint. El saldo usa la 3ª notación de `parseo-ar.ts` y el
`.xls` la 4ª: **las dos ya están soportadas**.

**Distribución:** `Débito` 83 filas · `Crédito` 75. Ninguna con importe en las dos, ninguna sin importe.

---

## 5. Saldo por fila: la cadena cierra perfecto

- Semilla = `Saldo Inicial` declarado → **0 rupturas** en las 158 transiciones.
- `saldo[157] == Saldo total` → coincide.
- `saldoInicial + Σcréditos − Σdébitos == Saldo total` → coincide.

**Como el signo no viene en el token, la cadena es la única verificación del signo.** El peso lo lleva **V5**
(`ARIT_SIGNO_INVERTIDO`), no V2. Siguen habiendo dos señales independientes —columna y aritmética—, así que el
control cruzado no se pierde.

**Las 158 filas tienen saldo negativo** (descubierto todo el período). Consecuencia: **la notación del saldo
positivo en ARS queda no determinada**.

---

## 6. Fechas

- Cuerpo y carátula: **`dd/mm/aa`**. Una sola forma, 158 de 158. A diferencia de Galicia, no cambia entre
  carátula y cuerpo.
- `Detalle impositivo`: `dd-mm-aaaa`. El `.xls`: `dd/mm/aaaa`.
- **No hay fecha valor.**
- **22 fechas distintas**, del 30/05 al 30/06, **estrictamente no decrecientes** (0 desórdenes).
- El período arranca el último día del mes anterior, que es la fecha del `Saldo Inicial`.

---

## 7. Multi-línea: exactamente dos formas, nunca más

| Líneas de glosa | Movimientos |
|---|---|
| 1 | **60** |
| 2 | **98** |

**Máximo 2, nunca 3.** Galicia llegaba a 7 con 727 continuaciones; acá hay 98 y todas de una línea.

**Criterio geométrico:** nuevo movimiento ⟺ fragmento con `|x − 23.0| < 1.2` que matchea `dd/mm/aa`;
continuación ⟺ la fila tiene **un único fragmento** en `x ≈ 115.0` sin fragmento en la columna de fecha.

Verificado por conteo cerrado: **258** fragmentos en `x=115.0` = 158 glosas + 98 continuaciones + 2 etiquetas
`Saldo Inicial`. **Todo el contenido de la glosa está exactamente en `x=115.0`, sin excepción.** Y **0
movimientos partidos entre páginas**.

**El concepto no se trunca a ancho fijo** (línea 1: máx. 41 caracteres; continuaciones: 57). Y la semántica es
estable: **línea 1 = concepto del banco, línea 2 = contraparte o referencia**. Eso habilita el split que
Galicia no permitía.

---

## 8. Ruido

| Qué es | Cuántas | Criterio |
|---|---|---|
| Encabezado de tabla | **9** (p9 trae dos: pesos y dólares) | igualdad exacta |
| Cabecera de cuenta | **8** | `/^Cuenta Corriente.* Nº/` |
| Pie de página | 7 en tabla + 2 fuera | `/^\d{1,3} - \d{1,3}$/` **anclado a `x ≈ 536.9`** |
| Títulos de sección | 4 | `/^Movimientos en (pesos\|d[óo]lares)$/`, `Detalle impositivo`, `Tasas de Acuerdos…` |
| Cuenta vacía | 1 | `/^No ten[eé]s movimientos en .* este per[íi]odo\.$/` |
| Nota al pie | 2 | `/^\* Salvo error u omisi[óo]n/` |
| Carátula + legales (p1, 10, 11) | ~120 | fuera de la región de tabla |
| `Saldo Inicial` / `Saldo total` | 2 + 2 | **no son ruido: son datos de la verificación** |

**Dos trampas de ruido:**

1. **El pie es `N - M`, no `Página N / M`.** La regla `pie` de `RUIDO_COMUN` **no matchea nada** acá. Y
   `/^\d+ - \d+$/` suelto es peligrosamente genérico: hay que anclarlo por posición (`x ≈ 536.9`, `y ≈ 21.3`).
2. **Las 8 cabeceras de cuenta caen DENTRO de la región de tabla.** Sin regla propia van a
   `lineasNoInterpretadas`, y eso empuja el estado a `no_cuadra` por `EST_LINEA_NO_INTERPRETADA`. Medido: 8
   sin interpretar (7 cabeceras + 1 nota).

---

## 9. Totales y anexos

**No hay línea de totales de columna.** Santander **no publica** total de créditos ni de débitos. Lo único es
el saldo de cierre: `Saldo total` (etiqueta en `x=386.7`, importe en `r=574.0`), **una vez por cuenta**.

→ **`traeTotalesDeclarados: false`.** La verificación no se degrada: con `traeSaldoInicialDeclarado: true` y
`saldoFinalDeclarado` de `Saldo total`, V3/V4 corren y el estado puede llegar a `cuadra`. Pero **V2 no es
verificable**, y ese era el control que en Galicia atrapaba un crédito cargado como débito por el mismo
importe. Acá lo reemplaza V5.

**Dos bloques de anexo**, los dos en p9, **después** del último `Saldo total`:

1. `Detalle impositivo` — encabezado `Tipo de impuesto | Importe`, 5 importes con borde derecho **528.0**.
   Conceptos: `Totales de retencion impuesto ley 25413 del dd-mm-aaaa al dd-mm-aaaa`,
   `Total retencion impuesto ley 25413 por creditos` / `por debitos`,
   `Importe susceptible de ser computado contra otros tributos…`,
   `Por retencion impuesto ley 25413 por creditos alicuota ##,## %`,
   `Total Retención Régimen de Recaudación SIRCREB en el período de emisión`.
2. `Tasas de Acuerdos y Descubierto` — 2 filas.

**Los dos son anexo, no movimientos.** El `Detalle impositivo` **resume impuestos que ya están como
movimientos** en el cuerpo (los 21+19 `Impuesto ley 25.413` y los 8 `sircreb`): sumarlo cuenta el impuesto dos
veces **y el asiento cuadra igual**. El `Interés cobrado` de las tasas también está en el cuerpo.

### 9.1. ⏳ La ambigüedad **"seis rótulos para cinco importes"** sigue abierta

La lista de conceptos de arriba tiene **seis** rótulos y el bloque publica **cinco** importes (borde derecho
528.0). **La spec nunca resolvió cuál de los seis no lleva importe**, y sigue sin resolverse. Lo que la
corrida contra el archivo real agrega es un dato, no la respuesta:

| Medición | Valor |
|---|---|
| Anexos emitidos | **7** = 5 del `Detalle impositivo` + 2 de `Tasas` |
| Filas en el residuo con código `fila_sin_importe` | **6** |
| De esas 6, con **estructura de rótulo de anexo** (rótulo + `#####` + dos fechas `dd-mm-aaaa`) | **2** |

**Los dos desenlaces posibles, y son incompatibles:**

1. **El bloque tiene 5 renglones y los 6 rótulos eran un error de conteo de la spec** (dos de los literales
   listados son en realidad el mismo renglón partido, o una línea de encabezado leída como concepto). En ese
   caso las 6 filas del residuo son ruido legítimo y **el anexo está completo**.
2. **El bloque tiene más de 5 renglones** y alguno viene **sin importe en la columna 528.0** —el rótulo con
   sus dos fechas está impreso y el importe cae en otro lado, o directamente no está—. En ese caso **se está
   perdiendo un renglón fiscal**, que es exactamente el modo de falla que este banco ya tuvo una vez (§0 de
   este documento y §3 del plan: los 7 renglones que desaparecían sin dejar rastro).

> **Pendiente de verificar contra el archivo, y es barato:** las 2 filas del residuo con estructura de
> rótulo llevan **dos fechas `dd-mm-aaaa`**, que es la firma del `Detalle impositivo` (§6: el cuerpo usa
> `dd/mm/aa`, el anexo `dd-mm-aaaa`). Alcanza con mirar dónde cae su importe —si es que hay uno— para cerrar
> la cuenta. **Hasta entonces no se supone ninguno de los dos desenlaces**, y el residuo se deja visible con
> su código: 6 filas que el adaptador reporta es mejor que 6 que descarta.

### 9.2. `alicuotaPublicada` es **un** campo y el bloque de tasas publica **dos**

`Tasas de Acuerdos y Descubierto` trae dos porcentajes por fila, en fragmento propio y en dos posiciones
medidas: el **TNA en `r=407.0`** y el **CFTEA en `487.0`** (§11.3 — los mismos dos que rozan las ventanas de
débito y crédito). El esquema del anexo tiene **un solo** `alicuotaPublicada`.

**Decisión, con su motivo:** se emiten **las dos juntas en el mismo campo, en orden de lectura**
(TNA primero, CFTEA después). No se elige una.

- **Por qué no elegir:** las dos son datos publicados y distintos —el CFTEA incluye cargos que la TNA no—, y
  quedarse con una **pierde la otra sin dejar rastro**. Un campo vacío se nota; un campo con la tasa
  equivocada, no.
- **Por qué se puede:** `alicuotaPublicada` es el **literal** publicado, nunca un número parseado. No hay
  aritmética que dependa de que sea una sola.
- **Lo que esto deja abierto:** si el consumidor de ese campo necesita las dos por separado, el arreglo es
  del **esquema** (dos campos o una lista tipada), no del adaptador. Anotado, no resuelto acá.

⚠️ **Y el recordatorio de clasificación:** estas dos tasas son **N2**, contra la intuición. No son alícuotas
legales publicadas: son **la tasa que este banco le cobra a este cliente** por su descubierto.

---

## 10. Respuesta esperada (el "Done" del adaptador)

| Métrica | Esperado |
|---|---|
| **Cuentas** | **2** (corriente en pesos + corriente especial U$S) |
| **Movimientos (ARS)** | **158** |
| Movimientos (USD) | **0** |
| `Débito` / `Crédito` | **83 / 75** |
| Con saldo negativo | **158** |
| Con valor en `Comprobante` | **94** |
| De una sola línea / continuaciones | **60 / 98** |
| Conceptos distintos | **29** |
| Fechas distintas | **22** |
| **Rupturas de cadena** | **0** |
| Páginas con tabla / encabezados | 8 / 9 |
| `lineasNoInterpretadas` | **0** con las reglas de §8 |

**Duplicados: ninguno.** 0 grupos con `(fecha, glosa, importe)` repetido — las 158 son únicas incluso sin el
saldo (al revés de Galicia, que tenía 7 grupos).

### 10.1. ✅ El "Done" se cumplió **entero** contra el archivo real

No parcialmente y no "salvo un renglón": **las once métricas de la tabla de arriba dieron el valor
esperado** en la corrida de `pnpm probar --banco santander --archivo <pdf>`. Las dos que valen subrayar
porque son las que **no** verifica la aritmética:

| Métrica | Esperado | Medido | Qué atrapa |
|---|---|---|---|
| **Conceptos distintos** | 29 | **29** | Que la glosa no se esté cortando ni pegando: 29 literales, los mismos del §12 |
| **Distribución de líneas de glosa** | 60 de una línea, 98 con continuación | **`1→60 2→98`** | Que las 98 continuaciones se hayan **absorbido en su movimiento** y no colapsado ni duplicado. Un adaptador que las pierda sigue dando 158 movimientos, 0 rupturas y el reparto 83/75 |

**Por qué se anota:** el criterio de Done de este banco ya decía que `estado === 'cuadra'` no alcanza y que
hay que exigir el **reparto 83/75**. Estas dos lo completan por el otro lado: el reparto cuida los importes,
`conceptos distintos` y `1→60 2→98` cuidan **la glosa, que es el producto**. Las cuatro juntas son lo que
hace que un resultado plausible-y-equivocado no pase.

**Lo que NO alcanza para el Done:** `estado === 'cuadra'`. Hay un segundo criterio propio de este banco:
**el reparto 83/75**. Un parser que se coma la distinción de columna y ponga los 158 en una sola produce 0
rupturas si además invierte el saldo. **Hay que exigir el reparto, no solo la cadena.**

---

## 11. Trampas concretas

### 11.1. El importe no tiene signo: solo la columna lo dice
Ver §0. Copiar `leerPar()` de Galicia da **0 movimientos**.

### 11.2. La fecha repetida sale con ancho ≈ 0
`pdf.js` reporta `width = 0.4` pt en **130** de las 158 filas y `35.5` en las otras 28. El texto está completo;
lo que está en cero es el avance: **Santander imprime la fecha una vez por grupo**. Regla verificada con 0
anomalías sobre 30 casos: `visible ⟺ cambia la fecha o cambia la página`.

- **El adaptador no pierde nada**: la fecha está en el texto de las 158. Arrastrarla del movimiento anterior
  sería peor, porque taparía un fallo de extracción.
- **`fragmentoEnVentanaDerecha` no sirve para la columna de fecha**: el borde derecho es 23.4 en 130 filas y
  58.5 en 28. Es el primer caso del proyecto donde **`Fragmento.ancho` miente**.

### 11.3. El TNA del anexo cae DENTRO de la ventana de `Débito`
El `##,##%` de la columna TNA tiene borde derecho **407.0** contra 408.0 de débito: **está dentro** de
`[404, 412]`. Hoy no explota porque `importeACentavos('57,00%')` devuelve `null` por el `%`, pero es un pelo.
Y el CFTEA está en **487.0**, a **1.0 pt** del borde de la ventana de crédito.
**Acotar la región de tabla no es opcional en este banco.** La deuda que Galicia dejó ⏳ acá es bloqueante.

### 11.4. `Saldo total` cae a 4 pt de la columna de saldo
Su importe tiene `r=574.0` y los saldos del cuerpo 578.0: la ventana `[572, 584]` engancha los dos. Se
identifica por su **etiqueta** en `x ≈ 386.7` — y esa `x` está encima del encabezado `Débito` (385.6), o sea
que un clasificador por columna la lee como un débito enorme.

### 11.5. `Saldo Inicial` es una fila con fecha y sin importe
Tiene fecha en `x=23.0`, glosa en 115.0, saldo en 578.0 y **ningún** fragmento en las columnas de importe. Un
autómata que exija el par la reporta como `fila_sin_importe`; uno que la acepte inventa un movimiento con
importe cero. Criterio: fecha + glosa `/^Saldo Inicial$/` + saldo + sin importe → **saldo inicial declarado**.

### 11.6. Dos cuentas con geometría IDÉNTICA
Las dos tablas usan **exactamente** los mismos `x` y los mismos bordes derechos. Lo único que las distingue es
el título `Movimientos en pesos` / `en dólares` y la cabecera `Cuenta Corriente Nº` / `Cuenta Corriente
especial U$S Nº`. Un adaptador que ignore la sección mete las dos cuentas en una, **y la cadena igual cierra**
si la segunda está vacía.

### 11.7. La cuenta en dólares está vacía y es legítima
Trae `Saldo Inicial`, la leyenda `No tenés movimientos en dólares este período.` y `Saldo total`, con **cero**
movimientos. `EST_SIN_MOVIMIENTOS` es un error por diseño ("0 movimientos nunca es éxito") y **aplicado por
cuenta pone rojo un archivo correcto**. 🔴 **Decisión abierta: ¿la invariante es por archivo o por cuenta?**

### 11.8. `U$S` no es `$`
`importeACentavos` pela el prefijo con `/^(-)?\s*\$\s*/`, que deja la `U` y devuelve `null`. Los saldos de la
cuenta en dólares son ilegibles. **Cambio de una línea en `parseo-ar.ts`.**

### 11.9. Ocho glosas traen un importe embebido
Las continuaciones del SIRCREB llevan la base de cálculo (`… ##,##% sobre $###.###,##`) en el texto. Están en
`x=115.0`, así que la geometría no las confunde — pero son **importes de un tercero dentro de una
descripción**: pasan a `depurarGlosa`, no al log.

### 11.10. El período está en dos filas distintas
`Desde:` y `Hasta:` salen en fragmentos separados y en **filas geométricas distintas** (14 pt).
`extraerPeriodo()` exige las dos fechas en la misma cadena y devuelve `null` acá. Hace falta
`periodoPorEtiquetas(filas, /^Desde:/, /^Hasta:/)`.

### 11.11. El concepto no dice el signo — y a veces dice lo contrario
Medido:

- **Un mismo concepto en las dos columnas:** `Pago comercios first data master nro.liq.` tiene **6 débitos y
  11 créditos**, con el mismo número de comprobante.
- `Impuesto ley 25.413 credito 0,6%` es **débito en 21 de 21**. "Credito" describe la base gravada, no el lado.
- `Echeq canje interno recibido 24hs` y `Echeq clearing recibido 48hs` son **débito en 6 de 6**, aunque digan
  "recibido".

**Cualquier mapeo del léxico por palabra clave (`credito`, `recibido`, `debito`) se equivoca en al menos 27 de
158 filas.** El signo sale de la columna; el concepto sirve para la cuenta contable, **nunca** para el signo.

### 11.12. La fuente es estable pero no se usa
Nombres estables entre páginas (al revés de Galicia). Igual **no** se usa: la variación de ancho de §11.2 y la
de la cabecera muestran que la métrica de fuente es lo menos confiable del archivo.

### 11.13. `unpdf` emite dos avisos por página
`Math.sumPrecise is not a function` y `Cannot substitute the font…`. **Ninguno afecta el texto extraído**, pero
van a `stderr` en cada corrida. Decidir si se silencian.

---

## 12. Vocabulario del banco — 29 conceptos

Etiquetas impresas por el banco, sin nombres de contrapartes. `(frecuencia · D débito / C crédito)`.

`Pago comercios first data visa nro.liq.` (29·C) · `Impuesto ley 25.413 credito 0,6%` (21·**D**) ·
`Impuesto ley 25.413 debito 0,6%` (19·D) · `Pago comercios first data master nro.liq.` (17·**6D + 11C**) ·
`Pago comercios first data m. deb nro.liq.` (10·C) · `Transferencia recibida` (10·C) ·
`Regimen de recaudacion sircreb y` (8·D, truncado) · `Transf recibida cvu mismo titular` (8·C) ·
`Credito transf online banking emp` (3·C) · `Echeq canje interno recibido 24hs` (3·**D**) ·
`Echeq clearing recibido 48hs` (3·**D**) · `Iva 21% reg de transfisc ley27743` (3·D) ·
`Cobro de interes por descubierto` (2·D) · `Iva 10,5% reg trans fisc ley 27743` (2·D) ·
`Iva percep rg 2408 alic reducida` (2·D) · `Impuesto de sellos` (2·D) · `Deposito de efectivo` (2·C) ·
`Pago a proveedores recibido` (2·C) · `Iva percepcion rg 2408` (2·D) · `Debito automatico` (1·D) ·
`Transferencia realizada` (1·D) · `Comision gestion de cobertura` (1·D) · `Pago de servicios` (1·D) ·
`Pago de honorarios` (1·D) · `Snp debito directo` (1·D) · `Pago comercios getnet nro.liq.` (1·**D**) ·
`Comision por servicio de cuenta` (1·D) · `Comision servicio cuenta dolares` (1·D) ·
`Transferencia inmediata` (1·D).

**Notas para el léxico:**

- **Sentence case**, no mayúsculas. El `.xls` los publica en **Title Case**: dos grafías del mismo catálogo →
  normalizar antes de comparar.
- Casi sin pares casi-sinónimos (al revés de Galicia): los cuatro `Pago comercios…` y los cuatro `Iva…` son
  conceptos distintos, no truncamientos.
- El único truncado es `Regimen de recaudacion sircreb y`, colgado en la conjunción.
- **`Comision servicio cuenta dolares` es un débito en la cuenta en PESOS.** El gasto de una cuenta se cobra
  en la otra: un motor que agrupe por moneda desde el concepto se equivoca.
- **Pares acoplados que siempre viajan juntos** (buen caso de prueba):
  `Cobro de interes por descubierto` + `Iva 10,5%…` + `Iva percep rg 2408…` + `Impuesto de sellos` (2 tríos
  completos), y `Comision…` + `Iva 21%…` + `Iva percepcion rg 2408`.

---

## 13. Qué del toolkit sirve

**Sirve tal cual, verificado:** `aFilas()` + `TOLERANCIA_FILA = 2.5` · `fragmentoEnX()` (tolerancia 1.2) ·
`fragmentoEnVentanaDerecha()` (bordes con **cero** dispersión) · `textoDeFila()` · `importeACentavos()` (ya
soporta la 3ª y la 4ª notación) · `centavosAImporte` / `importeCanonicoACentavos` · `parsearFecha` (158/158) ·
`hashFila` / `asignarOrdinales` · `verificarAritmetica` + `esquema.ts` · `extraerTexto` / `paginasSinTexto` ·
`valorPorEtiqueta` (para `CBU:`, `CUIT:`, `Acuerdo:`) · `clasificarRuido` / `particionar` ·
**y el autómata de `leerGalicia` transfiere entero** (abrir con fecha, cerrar con la próxima, absorber abajo).

**Piezas nuevas — cuatro de cinco son genéricas:**

| # | Qué falta | ¿Dónde va? |
|---|---|---|
| 1 | **`parDeColumnas()` con la redundancia del signo parametrizada** por `traeSignoEnElImporte` | **Toolkit** — primera de dos familias |
| 2 | **`regionesDeTabla(filas, reEncabezado, reCierre)`** | **Toolkit** — bloqueante acá (§11.3) |
| 3 | **Multi-cuenta / multi-moneda**, y la decisión de `EST_SIN_MOVIMIENTOS` por cuenta | **Toolkit** + `invariantes.ts` |
| 4 | **`U$S` como símbolo** en `importeACentavos` | **Toolkit** — una línea |
| 5 | **`periodoPorEtiquetas(filas, reDesde, reHasta)`** | **Toolkit** |
| 6 | Pie `N - M` anclado por `x` | **Adaptador** (el patrón genérico es inseguro) |

**Santander resuelve mejor que Galicia:** saldos rotulados (sin derivar ni desambiguar), sin página fantasma,
sin duplicados, bordes exactos, glosa de a lo sumo 2 líneas con semántica estable, concepto sin truncar.

**Santander empeora:** el signo depende de una sola señal, no publica totales (V2 no verificable), dos cuentas
y dos anexos, y un anexo cae a 1 pt de una ventana del cuerpo.

**Veredicto:** la vista geométrica y la localización por posición transfieren **sin modificación** entre dos
layouts que no comparten una coordenada. Los cinco faltantes son de <30 líneas y cuatro son reusables.

---

## 14. El `.xls`: es un **TSV en Latin-1** y trae un código de concepto

Primeros bytes: `0d 0a 0d 0a 0d 0a 0d 0a`. **No es BIFF ni ZIP.**

| Dato | Valor |
|---|---|
| Formato real | **TSV**, delimitador **TAB** (1129 tabs, 0 `;`) |
| Salto de línea | **CRLF** (185 líneas) |
| Codificación | **Latin-1 / cp1252** — hay que decodificar explícito |
| Columnas | `Fecha` · `Suc. Origen` · `Desc. Sucursal` · **`Cod. Operativo`** · `Referencia` · `Concepto` · `Importe Pesos` · `Saldo Pesos` |
| Filas de movimiento | **159** |
| Secciones | `Movimientos del Día` (1 fila) y `Ultimos Movimientos` (**158**) |

### 14.1. El cruce contra el PDF

- **Las 158 filas de `Ultimos Movimientos` son exactamente los 158 del PDF.** Multiset de `(fecha, importe con
  signo)`: **0 filas del PDF ausentes**, **1 del `.xls` ausente del PDF** (la de `Movimientos del Día`, con
  fecha posterior al cierre — no es una discrepancia).
- **El signo coincide en las 158**, y eso es la **confirmación independiente de la lectura por columna**: el
  `.xls` trae una sola columna con el signo explícito (paréntesis), el PDF solo la posición, y dan lo mismo.
  **Es la verificación más valiosa del análisis.**
- **Orden inverso**: fechas descendentes y también invertido dentro de cada día. Invirtiendo, la cadena cierra
  con **1 sola ruptura** (la fila extra).
- Los 159 saldos son **todos distintos**: es saldo por fila, no de cierre de día.

### 14.2. 🔴 Lo que el `.xls` trae y el PDF no

**`Cod. Operativo`: 29 códigos distintos para los 29 conceptos.** Es el `banco_concepto` codificado que
Galicia publica en su Excel y que se creía exclusivo suyo. **Santander también lo tiene** — verificado en tres
casos que el código y el concepto se corresponden 1 a 1 en las frecuencias (21, 19, 8).

También: `Referencia` (104 valores únicos de 159), `Suc. Origen`, `Desc. Sucursal`, y el `Concepto` con el
detalle separado por ` - ` **en una sola celda** (confirma el split de §7).

**El `.xls` NO trae:** el anexo impositivo, columnas separadas de débito/crédito, ni el número de cuenta
estructurado.

**Recomendación:** el `.xls` no reemplaza al PDF, pero **el mapeo `Cod. Operativo` → concepto vale una pasada
dedicada** antes de congelar el léxico del Módulo 2.

---

## 15. No determinado

- La notación del **saldo positivo en pesos**: las 158 están en descubierto.
- Si un movimiento puede tener **más de una** continuación (acá máx. 1).
- Si un movimiento puede **partirse entre páginas** (acá ninguno).
- Si la **cuenta en dólares con movimientos** usa la misma geometría (el cuerpo está vacío).
- Si los bordes derechos son estables entre períodos y tipos de cuenta.
- Si `Comprobante` puede ser no numérico o multilínea (acá 2–8 dígitos, vacío en 64 de 158).
- Si el `Detalle impositivo` puede cubrir más de un período (acá coincide con el del extracto).
- ⏳ **Cuántos renglones tiene realmente el `Detalle impositivo`**: 6 rótulos listados, 5 importes emitidos y
  6 filas de residuo con `fila_sin_importe`, 2 de ellas con estructura de rótulo. **Pendiente de verificar
  contra el archivo**, con los dos desenlaces en §9.1. Es el único lugar de este banco donde podría estar
  perdiéndose un renglón fiscal.
- Si `alicuotaPublicada` tiene que separar TNA y CFTEA en dos campos: hoy van juntas en orden de lectura
  para no perder ninguna (§9.2). La decisión es del esquema, no del adaptador.
- Cómo detectar la **condición ante IVA**: sale en la carátula sin etiqueta.
- Si el pie `N - M` puede venir concatenado a otro texto (acá sale limpio).
