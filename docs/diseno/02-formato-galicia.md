# Especificación del formato — Galicia, cuenta corriente en pesos (PDF)

> **Estado:** medido sobre un archivo real de un período. **Sin un solo valor del cliente**: solo etiquetas
> impresas por el banco, posiciones, conteos y formas (`#` dígito, `A` mayúscula, `a` minúscula).
>
> **Fuente:** un único archivo, cuenta corriente en pesos. Lo que valga para otros períodos o tipos de
> cuenta está marcado como no determinado — no se supone.
>
> Revisado contra la corrida del adaptador (`pnpm probar --banco galicia --archivo <pdf>`): §3.1-bis (lo que
> la carátula publica y no se lee), §8.1 (sin truncado silencioso), §10.1 (el anexo se captura) y §14 (los 32
> literales confirmados).

---

## 1. El hallazgo que cambia el diseño del adaptador

**El layout NO es de ancho fijo en caracteres.** `pdf.js` emite **un solo carácter de espacio por hueco**,
sin importar que el hueco mida 5 pt o 236 pt. Así que `substring(i, j)` es inviable y `inferirCortes()` del
toolkit —que busca canales de espacios— no sirve para este banco.

Las columnas **sí** existen, pero en **puntos PDF**. De ahí `aFilas()` en `texto-pdf.ts`, que agrupa los
fragmentos por su coordenada `y` y expone la `x` de cada uno.

**Y el segundo hallazgo, del mismo peso:** el texto no sale ordenado por fila visual. `pdf.js` emite en
orden de content-stream, y en este banco el **importe y el saldo salen en una línea posterior a la fecha**
para **262 de 326** movimientos. Un parser que asuma "una línea = un movimiento" falla en el 80 % de las
filas.

| Vía | Filas reconstruidas | Anomalías |
|---|---|---|
| Geometría (`aFilas`, agrupando por `y`) | **326** | 0 |
| Líneas (`aLineas` + autómata de dos estados) | **326** | 0 en este archivo, pero depende del orden del stream, que no es contractual |

**Decisión: el adaptador usa la vía geométrica.** La de líneas funciona acá y no hay razón para apostar a
que el orden del content-stream se mantenga.

---

## 2. Extracción

| Dato | Valor |
|---|---|
| Páginas del PDF | **26** |
| Páginas con tabla de movimientos | **24** (1–24) |
| Página 25 | solo texto legal, cero movimientos |
| Página 26 | **cero caracteres** — y el pie del documento dice `Página N / 25` |
| Filas geométricas totales | 1204 |
| Filas con fecha en la columna de fecha | **326** |

**La página 26 es una página fantasma:** existe en el PDF y no existe para el banco. Un control del tipo
"toda página tiene movimientos o texto legal" se pone rojo por ella, y `paginas.length !== paginasDeclaradas`
**no** sirve como control de integridad en este banco. Por eso `extraerTexto` devuelve `paginasSinTexto` como
lista de números de página y `requiereOcr` solo si **ninguna** página tiene texto.

---

## 3. Carátula (página 1)

Las etiquetas son texto impreso por el banco: no son datos del cliente.

| Dato | Etiqueta impresa | Dónde está el valor | Forma |
|---|---|---|---|
| CUIT del titular | `CUIT del Responsable Impositivo :` | misma línea | `##-########-#` |
| Condición IVA | `IVA:` | misma línea | `Aaaaaaaaaaa aaaaaaaaa` |
| Cotitulares | `Cantidad de cotitulares:` | misma línea | `#` |
| Tipo de cuenta | `Tipo de cuenta` | **línea siguiente** | `Aaaaaa Aaaaaaaaa aa Aaaaa` |
| Número de cuenta | `Número de cuenta` | **línea siguiente** | `A° #######-# ###-#` |
| CBU | `CBU` | **línea siguiente** | `######################` |
| Período | `Período de movimientos` | **línea ANTERIOR**, dos fechas **pegadas** | `##/##/######/##/####` |
| Saldos | `Saldos` | **dos líneas ANTERIORES** | `$#.###.###,##` y `$###.###,##` |

### 3.1. Las tres trampas de la carátula

1. **No existe ninguna etiqueta `Saldo Anterior` ni `Saldo Final`.** Verificado por grep sobre las 1483
   líneas: los únicos textos con la raíz "saldo" son `Saldos` (título de sección), `Tasa Extraordinaria
   sobre Saldos Deudores` y `Saldo` (encabezado de columna). **Los dos importes están sin rótulo
   individual.**
2. **El orden emitido de esos dos importes está invertido** respecto de la lectura visual: sale
   `[saldo final, saldo inicial]`. Con el período pasa lo mismo: sale `[hasta, desde]`.
3. Los tres títulos de sección están en **una sola fila visual** pero salen como tres líneas separadas y
   muy alejadas en el stream, con los valores intercalados. "Etiqueta → línea siguiente" no funciona para
   ellos.

### 3.1-bis. 🔴 Lo que la carátula publica y el adaptador **hoy no lee**

Medido en la corrida contra el archivo real. **Ninguno de estos es un fallo de extracción: el texto está, y
el adaptador no lo toma.** Se anota acá porque es la clase de hueco que después no se puede reparar sin
volver al PDF — y `08-plan-de-construccion.md` §E4 avisa que **para el cliente de mayor volumen puede no
haber archivo al que volver**.

| Dato | Estado | Detalle |
|---|---|---|
| **Número de cuenta** | ✅ **se lee** | Es lo que hace resoluble el lote por INV-6 |
| 🔴 **CBU** | **está en el documento y NO se lee** | Una fila con los **22 dígitos**, con su etiqueta `CBU` en la línea anterior (§3). `cuentaDetectadaSchema` **tiene el campo `cbu`** y este adaptador lo deja ausente |
| ⏳ **Cuatro renglones de carátula** con forma de **acuerdo de descubierto y su tasa** | **no se leen, y no hay dónde ponerlos** | `cuentaDetectadaSchema` **no tiene campo** para ninguno de los dos. El banco de `06` publica lo mismo con las etiquetas `Acuerdo:` / `Vencimiento:` |

**Por qué el CBU importa más de lo que parece:** es la segunda ancla de `resolverCuentaDelExtracto` (INV-6).
Con solo el número, un archivo cuyo número venga formateado distinto **no resuelve la cuenta y el lote se
rechaza entero** — teniendo el banco publicado el identificador que sí resolvería. Leerlo es una línea; no
leerlo es una dependencia de una sola forma de un solo campo.

⚠️ **El CBU no se imprime en ningún log ni en ninguna salida de diagnóstico.** El alta de cuenta ya lo lee
del PDF sin mostrarlo (`pnpm alta:cuenta`), y esa es la disciplina: leerlo y hashearlo, nunca imprimirlo.

**Lo de los cuatro renglones es una decisión de esquema, no del adaptador.** Sin campo declarado, el
adaptador no tiene dónde emitirlos, y **inventarle un campo suelto a la cuenta es peor que no leerlos**:
sería un dato de crédito del cliente sin clasificación de sensibilidad. Queda anotado, no resuelto acá.

### 3.2. Desambiguación obligatoria: por aritmética, no por posición

Como no hay etiqueta y el orden no es confiable, los saldos **se derivan**:

```
saldo_final   := saldo de la última fila           (verificado: coincide con el 3er importe de `Total`)
saldo_inicial := saldo(fila 1) − importe(fila 1)   (verificado: coincide con el otro importe de la carátula)
periodo_desde := min(las dos fechas)
periodo_hasta := max(las dos fechas)
```

Es más robusto que leer una etiqueta que no existe, y de paso queda verificado por triangulación.

**Ojo:** `periodo_desde` es de **mayo** y no hay ni un movimiento de mayo. La validación "toda fecha cae
dentro del período" pasa; la inversa —"el período arranca en la primera fecha de movimiento"— es **falsa**.

---

## 4. Cuerpo: seis columnas, en puntos PDF

| # | Columna | Alineación | `x` izquierdo del valor | Borde derecho |
|---|---|---|---|---|
| 1 | `Fecha` | izquierda | **38.4** | 72.5–74.0 |
| 2 | `Descripción` | izquierda | **82.2** | ≤ 209.5 |
| 3 | `Origen` | izquierda | **224.4** | ≤ 244.2 |
| 4 | `Crédito` | **derecha** | variable | **351.7–352.1** |
| 5 | `Débito` | **derecha** | variable | **465.1–465.4** |
| 6 | `Saldo` | **derecha** | variable | **578.5–578.8** |

Los importes se localizan por su **borde derecho**, no por el izquierdo: el izquierdo se mueve con la
cantidad de dígitos. De ahí `fragmentoEnVentanaDerecha()` en `texto-pdf.ts`.

Métrica vertical: interlineado dentro de un movimiento ≈ **9.6 pt**; separación entre movimientos ≈ **22 pt**.
La tolerancia de agrupación por fila es **2.5 pt** y el número no es arbitrario: la etiqueta `Total` está en
`y=619` y sus importes en `y=620.5`, así que con menos de 1.5 pt la fila de totales se parte en dos y la
etiqueta se pierde.

---

## 5. Tres notaciones de signo en el mismo documento

| Campo | Positivo | Negativo |
|---|---|---|
| Importe (crédito/débito) | `#.###,##` | `-#.###,##` — **signo adelante** |
| Saldo | `#.###,##` | `#.###,##-` — **signo ATRÁS** |
| Totales | `$ #.###,##` | `-$ #.###,##` — **signo antes del `$`** |

**Es la trampa número uno.** Un `parsearImporte` único para importe y saldo pierde o invierte las **14 filas
con saldo negativo** (la cuenta estuvo en descubierto; páginas 2, 3 y 21). La primera pasada del análisis las
descartó en silencio y contó 312 filas en vez de 326.

Las tres notaciones ya están soportadas en `parseo-ar.ts` y tienen su test.

### 5.1. Signo redundante y coherente

| Columna | Filas | Con `-` | Sin signo |
|---|---|---|---|
| Crédito | **116** | 0 | 116 |
| Débito | **210** | **210** | 0 |

- Ninguna fila tiene importe en las dos columnas.
- Ninguna fila tiene cero importes.
- Cada fila tiene exactamente dos importes: el de crédito/débito y el saldo.

O sea que hay **dos evidencias independientes** del signo: la columna y el signo del token. Un adaptador que
derive el signo de una sola de las dos pierde el control cruzado — y `esquema.ts` tiene el refine que exige
que coincidan.

---

## 6. Cadena de saldos: cierra perfecto

Las 326 filas traen saldo acumulado, así que la cadena es la verificación fuerte:

- `saldo[i] === saldo[i−1] + importe[i]` para las 325 transiciones → **0 rupturas**.
- `saldo[0] − importe[0]` === el saldo inicial de la carátula → coincide.
- `saldo[325]` === tercer importe de `Total` === saldo final de la carátula → coincide.
- `Σ créditos` === primer importe de `Total` → coincide. `Σ débitos` === segundo → coincide.

**Esto es lo que hace que el "Done" del adaptador sea verificable**: hay un resultado conocido contra el cual
comparar. 326 filas, 0 rupturas, totales exactos.

---

## 7. Fechas

- Cuerpo: **`dd/mm/aa`** (dos dígitos de año).
- Carátula: `dd/mm/aaaa`.
- Bloque impositivo de la última página: **`dd-mm-aaaa`** (guiones).
- **No hay columna de fecha valor.**
- 21 fechas distintas, del 01/06 al 30/06, **estrictamente no decrecientes** (0 desórdenes).

---

## 8. Multi-línea: es la regla, no la excepción

| Líneas de glosa | Movimientos |
|---|---|
| 1 | 64 |
| 2 | 28 |
| 3 | **115** |
| 4 | 9 |
| 5 | **109** |
| 7 | 1 |

**Criterio geométrico (el que usa el adaptador):**

- **nuevo movimiento** ⇔ hay un fragmento con `|x − 38.4| < 1` que matchea `/^\d{2}\/\d{2}\/\d{2}$/`;
- **continuación** ⇔ el primer fragmento está en `x ≈ 82.2` (glosa) o `x ≈ 224.4` (Origen), y no hay
  fragmento en la columna de fecha.

Verificado: las 727 filas de continuación tienen **todas** su primer fragmento exactamente en `x = 82.2`. Las
únicas otras `x` de primer fragmento en el cuerpo son `35.4` (pie) y `286.2` (fila de totales).

**Y una trampa fina: el concepto del banco también se trunca y sigue en la línea siguiente.** No sirve
"línea 1 = concepto, línea 2+ = contraparte". El concepto en la fila de fecha llega a **27 caracteres**; las
continuaciones, a **20**. Ejemplos del vocabulario del banco: `SERVICIO ACREDITAMIENTO DE` → `HABERES`;
`COM. GESTION TRANSF.FDOS` → `ENTRE BCOS`.

**Los nombres de contraparte vienen truncados a 20 caracteres, cortados a mitad de palabra.** El adaptador
guarda lo truncado y **no intenta** reconstruirlo ni matchearlo por igualdad exacta contra un padrón.

### 8.1. ✅ No hay truncado silencioso de glosa — la duda quedó **resuelta por medición**

Era una duda abierta del toolkit: `fragmentoEnX(fila, x)` devuelve **un solo** fragmento, y si la columna de
descripción trajera más de uno por fila, la glosa saldría cortada **sin que nada se ponga rojo** — que es lo
que pasa en Macro, donde la glosa viene en 1–4 fragmentos y `fragmentoEnX` sola trunca 1186 de 1346.

**Medido contra el archivo real: `con conceptoBanco = 326` sobre 326 movimientos.** O sea que **las 326 filas
tienen exactamente un fragmento en la columna de descripción**: acá `fragmentoEnX` no pierde nada, y la
migración a `fragmentosEnBanda` no es urgente en este banco (sí lo es en Macro).

🔴 **Cuidado con cómo se lee este resultado.** Dice que no se pierde texto **dentro de la fila**; **no** dice
que la glosa esté completa. El concepto truncado a 27 y las contrapartes a 20 son truncado **del banco**,
impreso así en el documento, y siguen siendo ciertos. Son dos cosas distintas: una es un defecto del parser
—acá no lo hay— y la otra un hecho del formato —acá lo hay, y no se reconstruye—.

---

## 9. Ruido: 166 líneas que no son movimiento

| Qué es | Cuántas | Criterio |
|---|---|---|
| Título/pie `Resumen de Cuenta Corriente en Pesos` | 25 | igualdad exacta |
| Pie con paginación **concatenado** al título | 25 | `/^Página \d+ \/ \d+/` — **sin `$`** |
| Identificador de documento del pie | 25 | `/^\d{17}[A-Z]$/` |
| Encabezado de tabla repetido | **24** | igualdad exacta |
| Línea de totales | 1 | `/^Total\s/` |
| Bloque `Consolidado de retención de impuestos` | 1 + 1 + 9×3 | todo lo posterior a `Total` |
| Carátula | ~20 | solo página 1 |
| Leyendas legales | ~18 | quedan fuera del autómata |

**El pie concatena la paginación con el título sin separador** (`Página N / 25Resumen de Cuenta…`), así que
un patrón anclado con `$` no engancha nunca.

---

## 10. Totales

Una sola línea, etiqueta `Total`, en la página 24, justo después de la última fila:

```
Total  $ ##.###.###,##  -$ ##.###.###,##  $ #.###.###,##
        └ créditos       └ débitos          └ saldo final
```

Y un **segundo bloque**, `Consolidado de retención de impuestos`, con **9 entradas** de 3 líneas
(`PERIODO COMPRENDIDO ENTRE EL dd-mm-aaaa Y EL dd-mm-aaaa` / concepto / importe). Conceptos publicados por el
banco: `TOTAL IMPUESTO I.V.A. SOBRE DEBITOS`, `TOTAL RETENCION IMPUESTO LEY 25.413 SOBRE CREDITOS` /
`SOBRE DEBITOS`, `TOTAL MENSUAL RETENCION IMPUESTO LEY 25.413 …`, `… CREDITO COMPUTABLE COMO PAGO A CUENTA`.

**Ese bloque es un `anexo`, no movimientos.** Cubre **tres períodos distintos** del extracto y sumarlo con
los movimientos cuenta el impuesto dos veces **y el asiento cuadra igual** — la peor clase de error de este
dominio.

### 10.1. ✅ Las 9 entradas **se capturan**, con `atribucion_cuenta = cuenta_unica_del_lote`

La deuda que decía *"`anexoExtractoSchema` existe y **no hay tabla** donde persistirlo"* está cerrada: la
tabla de anexos es la migración **0008**, y las 9 entradas se emiten.

**El valor de atribución es `cuenta_unica_del_lote`, y existe separado de `publicada_por_cuenta` a
propósito:**

| Valor | Qué evidencia lo respalda |
|---|---|
| `publicada_por_cuenta` | **El banco lo dice**: imprime el renglón dentro de la sección de esa cuenta |
| **`cuenta_unica_del_lote`** | **Aritmética del lote**: el archivo trae una sola cuenta, así que no hay otra a la que pueda pertenecer. **El banco no lo dice** |
| `no_determinada` | El banco lo publica y no se puede establecer de qué cuenta es (el caso de Macro, `07` §9.1) |

🔴 **Por qué no alcanzaba con un solo valor.** Los dos primeros producen hoy el mismo resultado —la única
cuenta del lote— y por eso la tentación es fusionarlos. Pero **la deducción de `cuenta_unica_del_lote` deja
de valer el día que Galicia mande un archivo de dos cuentas**, y con un solo valor **ese cambio sería
invisible**: el mismo campo, el mismo resultado plausible, y una atribución que pasó de cierta a inventada
sin que nada lo marque. Con dos valores, el día que el lote traiga dos cuentas la evidencia se cae sola.

Nada de esto cambia la regla de fondo: **el anexo no entra en la suma de los movimientos** — eso lo declara
`relacion_con_movimientos`, no la atribución.

**Y sus 9 importes caen dentro de la ventana `x` de la columna `Saldo`** (borde derecho 582.3 contra
578.5–578.8 del cuerpo). Un clasificador que barra toda la página los cuenta como saldos: hay que **acotar la
región de tabla** desde el encabezado hasta la línea `Total`.

---

## 11. Respuesta esperada (el "Done" del adaptador)

| Métrica | Esperado |
|---|---|
| **Filas de movimiento** | **326** |
| Con importe en Crédito | 116 |
| Con importe en Débito | 210 |
| Con saldo negativo (notación `#,##-`) | 14 |
| Con valor en `Origen` | 21 |
| Movimientos de una sola línea | 64 |
| Líneas de continuación | 727 |
| Conceptos distintos | 32 |
| Fechas distintas | 21 |
| **Rupturas de la cadena** | **0** |
| Páginas con tabla | 24 |

**Lo que NO alcanza para el Done:** `estado === 'cuadra'`. Un adaptador que devuelve las 326 filas con todas
las descripciones vacías cuadra perfecto. **La descripción es el producto.**

### 11.1. Duplicados: la clave de fila necesita el saldo

**7 grupos, 26 filas**, con hasta **7 repeticiones exactas** del trío `(fecha, concepto, importe)` — típico de
la comisión y el IVA que acompañan cada transferencia. Agregando el saldo acumulado, las 326 quedan únicas.

`hash.ts` ya incluye el saldo como discriminador. Sin eso, **26 movimientos legítimos colapsarían en 7**.

---

## 12. Trampas, consolidadas

Las que ya están resueltas en código llevan ✅; las que quedan para el adaptador, ⏳.

| # | Trampa | Estado |
|---|---|---|
| 1 | Saldo con menos **al final**, importe con menos adelante | ✅ `parseo-ar.ts` |
| 2 | Importe y saldo en una línea **posterior** a la fecha | ✅ `aFilas()` geométrico |
| 3 | Sin etiqueta de saldo inicial/final, y en orden invertido | ✅ desambiguación por aritmética (§3.2) |
| 4 | Dos fechas del período **pegadas**, en orden `[hasta, desde]` | ✅ `extraerPeriodo()` toma min/max |
| 5 | `Origen` multi-línea y no solo numérico | ⏳ |
| 6 | El valor de `Origen` viaja **pegado** al inicio de la línea de cierre | ⏳ |
| 7 | El concepto se trunca a 27 y sigue abajo | ⏳ |
| 8 | Contrapartes truncadas a 20, cortadas a mitad de palabra | ⏳ no reconstruir |
| 9 | **`fontName` no es estable entre páginas** (`g_d0_f3` vs `g_d0_f4`) | ✅ se usa posición, nunca fuente |
| 10 | Los importes del anexo caen en la ventana de `Saldo` | ✅ el anexo se lee **acotado desde la línea `Total`**, no barriendo el documento (§10.1) |
| 11 | `Total` con etiqueta e importes en baselines distintos (1.5 pt) | ✅ `TOLERANCIA_FILA = 2.5` |
| 12 | El pie concatena paginación con título | ⏳ patrón sin `$` |
| 13 | **Página fantasma**: 26 físicas, 25 declaradas | ✅ `paginasSinTexto` por página |
| 14 | **`extraerTexto` dejaba el buffer detachado** | ✅ copia interna en `documento()` |
| 15 | 7 grupos de filas duplicadas por `(fecha, concepto, importe)` | ✅ el hash incluye el saldo |
| 16 | `periodo_desde` de mayo sin movimientos de mayo | ✅ documentado |
| 17 | `DEV.IMP.CRED.LEY 25413` y `ANULAC. ACRED.` son **reversas** | ⏳ Módulo 2: no mapear por prefijo |

---

## 13. No determinado

No se supone nada de esto — se mide cuando haya un segundo archivo.

- Si el signo del saldo negativo es siempre `U+002D` o si en otros períodos aparece `U+2212`. En este
  archivo son todos `U+002D`, verificado por codepoint.
- Si existen movimientos partidos entre dos páginas. En este archivo **no hay ninguno**.
- Si `Origen` puede contener importes o fechas. Acá solo códigos de ≤4 caracteres.
- Si el ancho de columna en pt es estable entre períodos y entre tipos de cuenta.
- El cruce contra el `.xlsx` del mismo período: **no se hizo**, y es una verificación cruzada barata que
  conviene correr antes de congelar el adaptador.
- ⏳ **Dónde van el acuerdo de descubierto y su tasa** (4 renglones de carátula, §3.1-bis): `cuentaDetectada`
  no tiene campo. Es una decisión de esquema —con su clasificación de sensibilidad— y hasta que exista, el
  adaptador no los emite.

---

## 14. Vocabulario del banco

32 conceptos distintos. Sirven como set de prueba y como insumo del catálogo `banco_concepto` del Módulo 2.
**No son datos del cliente**: son las etiquetas que imprime el banco.

✅ **Los 32 quedaron confirmados contra el archivo real:** el adaptador reporta `conceptos distintos = 32`.
No es una redundancia con la lista de abajo —que se contó a mano sobre el texto extraído—: es que **el corte
del concepto que hace el adaptador produce exactamente el mismo vocabulario**. Un corte que se llevara un
carácter de más o de menos daría 33, 34 o 40, con los importes y la cadena igual de verdes.

`ACREDITAMIENTO` (78) · `TRF INMED PROVEED` (70) · `IMP. CRE. LEY 25413` (21) · `IMP. DEB. LEY 25413 GRAL.`
(19) · `IVA` (17) · `COM. GESTION TRANSF.FDOS` (12) · `COMPRA DEBITO` (11) · `TRANSF. CTAS PROPIAS` (11) ·
`RESCATE FIMA` (10) · `TRANSFERENCIAS CASH` (8) · `PAGO CON TRANSFERENCIA` (7) · `TRANSF. A TERCEROS` (5) ·
`PERCEP. IVA` (5) · `PAGO DE SERVICIOS` (5) · `SERVICIO ACREDITAMIENTO DE` (4) · `SNP PAGO A PROVEEDORES` (4)
· `IMPUESTO DEB.LEY 25413` (4) · `TRANSFERENCIA A TERCEROS` (4) · `TRANSF. AFIP` (4) · `SUSCRIPCION FIMA` (4)
· `ANULAC. ACRED. FIRSTDATA.` (3) · `DEV.IMP.CRED.LEY 25413` (3) · `DEB. AUTOM. DE SERV.` (3) ·
`CHEQUE PAGADOR NRO.` (3) · `COMISION CHEQUE PAGADO POR` (3) · `PAGO VISA EMPRESA` (2) ·
`COMISION SERVICIO DE CUENTA` (1) · `EXTRACCION EN AUTOSERVICIO` (1) · `COMISION EXTRACCION EN` (1) ·
`SERVICIO PAGO A PROVEEDORES` (1) · `TRANSFERENCIA DE TERCEROS` (1) · `PERCEPCION RG 5617/24` (1).

**Cuidado con los pares casi sinónimos** (`TRANSF. A TERCEROS` / `TRANSFERENCIA A TERCEROS`,
`IMP. DEB. LEY 25413 GRAL.` / `IMPUESTO DEB.LEY 25413`, `SNP PAGO A PROVEEDORES` /
`SERVICIO PAGO A PROVEEDORES`): **algunos son el mismo concepto truncado a 27 caracteres**, no conceptos
distintos. Otro motivo para clasificar por **código** y no por el literal de la glosa.
