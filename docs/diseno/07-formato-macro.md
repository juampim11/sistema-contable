# Especificación del formato — Macro, resumen multi-cuenta (PDF)

> **Estado:** medido sobre un archivo real de un período (11-2025). **Sin un solo valor del cliente**.
> Revisado contra la corrida del adaptador (`pnpm probar --banco macro --archivo <pdf>`): §8.1, §9.1, §12,
> §12.2 y §14.6 traen lo que la corrida contradijo o amplió.
>
> **Este es el archivo más importante del roster para el diseño.** Lo usa un solo cliente, pero es el que más
> movimientos tiene (**1346**, 4,1× Galicia), trae **tres cuentas en un mismo resumen** y **transferencias
> entre esas cuentas**. Es el único que ejercita tres cosas modeladas y nunca probadas: multi-cuenta en un
> lote, la FK de tres columnas, y la regla 10 con **las dos patas presentes**.

---

## 1. Extracción

| Dato | Valor |
|---|---|
| Páginas | **45** |
| Sin texto | **ninguna** |
| `requiereOcr` | `false` |
| Filas geométricas | **2865** |
| Líneas (`aLineas`) | 2955 |
| Filas con fecha en la columna de fecha | **1346** |
| Páginas con movimientos | **45 de 45** |
| Páginas declaradas | **no existe el dato**: el pie dice `Hoja Nro.: N`, **sin total** |

**El hallazgo de Galicia se confirma en el tercer banco:** **0 líneas con dos espacios consecutivos sobre 2955**
y corrida máxima de espacios = **1**. `substring(i,j)` e `inferirCortes()` siguen inviables.

**Pero acá `aLineas()` reconstruye bien la fila visual** (1346 líneas arrancan con `dd/mm/aa`, sin desorden de
content-stream). **Y aun así hay que usar `aFilas()`, por una razón distinta a la de Galicia:**

> **Cada línea de movimiento trae exactamente 2 tokens con forma de importe — las 1346, sin excepción.** El
> primero es el importe y el segundo el saldo. **Nada en el texto dice si ese importe es débito o crédito**:
> eso lo dice únicamente la posición `x`.

| Vía | Filas | Signo asignable |
|---|---|---|
| Geometría (`aFilas`) | 1346 | **sí** (borde derecho 385.8 vs 465.6) |
| Líneas (`aLineas`) | 1346 | **no** — es indecidible |

---

## 2. Carátula — repetida en las 45 páginas

**No está solo en la p1**: los 8 renglones de cabecera y los 17 de leyendas se repiten en las 45. La tabla
`TIPO CUENTA SUCURSAL MONEDA CUENTA CBU` aparece **una sola vez** (p1).

| Dato | Etiqueta | Forma | Conteo |
|---|---|---|---|
| Período del archivo | `Resumen General Periodo del Extracto:` | `##/##/#### al ##/##/####` | 45 |
| Fecha de consolidación + hoja | `Saldos consolidados por moneda al` … `Hoja Nro.:` | `##/##/####` … `#` | 45 |
| Saldo consolidado por moneda | `Saldo Cuentas en PESOS` / `en DOLARES EE.UU.` | `#.###.###,##` | 90 |
| CUIT del titular | `C.U.I.T` | `#{11}` **solo, al final de la fila** — ver la corrección de abajo | 45 |
| Tipo + número de cuenta | `<TIPO> NRO.:` | `#-###-##########-#` | **47** |
| CBU | `Clave Bancaria Uniforme para Debito Directo:` | `#######-#-#############-#` | 47 |
| Saldo inicial | `SALDO ULTIMO EXTRACTO AL <fecha>` | `##/##/####` + importe | **3** |
| Saldo final | `SALDO FINAL AL DIA <fecha>` | ídem | **3** |

### 2.0-bis. 🔴 Corrección medida — el renglón del CUIT (2026-08-10)

**La versión anterior de la tabla decía `###########Aaaa…` pegados, y es FALSO.** Costó dos intentos de
adaptador antes de medirlo. La forma real de esa fila, con la `x` de cada fragmento:

```
  fila 3, p1   x=[72.0  93.0  364.4]
               AAAA A{9} AAA A.A.A.A #{11}
```

Tres hechos, y los tres contradicen o precisan lo que estaba escrito:

1. **La etiqueta es `C.U.I.T`** —cuatro letras con puntos— y eso sí era correcto.
2. **El CUIT son 11 dígitos corridos, sin guiones**, también correcto.
3. 🔴 **Después de los 11 dígitos NO HAY NADA: la fila termina ahí.** El CUIT **no** trae la razón social
   pegada. Y el rótulo está en el **tercer fragmento** (`x = 364.4`), con texto a su izquierda en `72.0` y
   `93.0`, así que **un patrón anclado con `^` no engancha nunca**.

**La razón social vive en otro lado, y con un patrón que §2 no tenía:**

```
  fila 2, p1   x= 72.0   Aa(aa):                    ← el rótulo, SOLO en su fragmento
               x=360.2   AAAAAAA (####) AAAAAAA     ← otra columna, no le pertenece
  fila 3, p1   x= 72.0   AAAA
               x= 93.0   A{9} AAA                   ← la razón social, en DOS fragmentos
               x=364.4   A.A.A.A #{11}              ← el CUIT, otra columna
```

> 🔴 **`Sr(es):` es una etiqueta cuyo valor está en el RENGLÓN SIGUIENTE**, no en el mismo. El rótulo va solo
> en `x = 72.0` y la razón social baja un renglón, **partida en dos fragmentos** (`72.0` y `93.0`). Es el
> mismo patrón que el CBU de otro banco del roster, y la primera aparición en éste.

**Y las dos filas tienen a su derecha una columna que no les pertenece**: el `(####)` en `x = 360.2` sobre la
del rótulo, y el propio `C.U.I.T` en `x = 364.4` sobre la del nombre. **Leer cualquiera de las dos "por texto
de fila" contamina el campo** — en el segundo caso, con el documento del titular adentro del nombre, que es
invisible para siempre porque el campo no se imprime. El corte tiene que ser **por banda de `x` con límite
derecho**, no por texto.

> **Por qué este error sobrevivió tanto:** es el **único renglón de la tabla de §2 que §2.1 no acompaña con
> una regex y su conteo verificado.** Todos los demás tienen su patrón probado contra el archivo; éste se
> describió a ojo. Un adaptador escrito contra esta tabla hereda el supuesto y sus tests pasan, porque el
> fixture también se escribe contra la tabla.

### 2.1. Regex por etiqueta, con su conteo verificado

```
/^Resumen General Periodo del Extracto:\s*(\d{2}\/\d{2}\/\d{4})\s+al\s+(\d{2}\/\d{2}\/\d{4})$/   → 45
/^Saldos consolidados por moneda al (\d{2}\/\d{2}\/\d{4}) Hoja Nro\.:\s*(\d+)$/                  → 45
/^Saldo Cuentas en (PESOS|DOLARES EE\.UU\.)\s/                                                   → 90
/^(CUENTA .+?) NRO\.:\s*(\S+)$/                                                                  → 47
/^Clave Bancaria Uniforme para Debito Directo:\s*(\S+)/                                          → 47
/^DETALLE DE MOVIMIENTO$/                                                                        → 47
/^FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO$/                                          → 47
/^SALDO ULTIMO EXTRACTO AL (\d{2}\/\d{2}\/\d{4})/                                                →  3
/^SALDO FINAL AL DIA (\d{2}\/\d{2}\/\d{4})/                                                      →  3
/^TOTAL COBRADO DEL IMP/                                                                         →  3
/^D\. 409\/2018 - IMPUESTO LEY 25413 COMPUTABLE/                                                 →  3
```

### 2.2. Los saldos vienen rotulados — lo contrario de Galicia

**Los dos, por cuenta, con el importe en la misma fila y en la columna `SALDO`.** No hay que derivar nada ni
desambiguar fechas pegadas. **Las tres trampas de la carátula de Galicia no existen acá.**

**Lo que NO viene:** ningún total de débitos ni de créditos. No hay línea `Total`. →
`traeTotalesDeclarados: false`, la fuerza pasa a la cadena de saldos.

### 2.3. `extraerPeriodo()` sirve — con un cuidado

Es el **segundo usuario** de esa función del toolkit, así que sobrevive la regla. Pero **no se puede escanear
"las primeras N filas y tomar el primer match"** como hace `leerGalicia`: la línea
`TOTAL COBRADO DEL IMP… DEL PERIODO ##/##/#### AL ##/##/####` también trae dos fechas y también matchea. Hay
que **anclar en la etiqueta** `Resumen General Periodo del Extracto:`.

---

## 3. Cuerpo: seis columnas, en puntos PDF

| # | Columna | Alineación | Posición del **valor** | Encabezado | Filas |
|---|---|---|---|---|---|
| 1 | `FECHA` | izquierda | **x = 33.0** exacto | x=37.2 | 1346/1346 |
| 2 | `DESCRIPCION` | izquierda | **primer fragmento x = 70.8**; **1–4 fragmentos**; borde hasta **297.6** | x=138.0 | 1346/1346 |
| 3 | `REFERENCIA` | izquierda | **x = 264.0** exacto | x=264.0 | 1221 |
| 4 | `DEBITOS` | **derecha** | **r = 385.8**, valor único | x=339.6, r=369.0 | **181** |
| 5 | `CREDITOS` | **derecha** | **r = 465.6**, valor único | x=419.4, r=453.0 | **1165** |
| 6 | `SALDO` | **derecha** | **r = 553.8**, valor único | x=516.0, r=537.0 | **1346** |

**Los tres bordes derechos son un valor único en todo el archivo**, no un rango. Tolerancia ±0.5 alcanza.

🔴 **Los bordes derechos del ENCABEZADO no sirven para inferir la ventana del valor:** `CREDITOS` termina en
453.0 y sus valores en 465.6; `DEBITOS` en 369.0 y sus valores en 385.8. Un adaptador que derive las ventanas
de la fila de encabezado **no engancha ni un importe**.

**Métrica vertical:** interlineado entre movimientos **exactamente 12.0 pt** (1301 deltas, un solo valor).
`TOLERANCIA_FILA = 2.5` es seguro por amplio margen; etiqueta y valor **siempre** comparten baseline.

---

## 4. Signo: una sola notación y **sin redundancia**

| Campo | Positivo | Negativo | Conteo |
|---|---|---|---|
| `DEBITOS` | `#.###,##` | **nunca** | 181 sin signo, 0 con |
| `CREDITOS` | `#.###,##` | **nunca** | 1165 sin signo, 0 con |
| `SALDO` | `#.###,##` | **`-#.###,##` — signo ADELANTE** | 1063 sin, **283 con** |

- Los 283 son **U+002D**, verificado por codepoint.
- **Las dos notaciones están INVERTIDAS respecto de Galicia** (allá: menos atrás en el saldo, adelante en el
  importe). `parseo-ar.ts` ya soporta las dos.
- No hay `$` ni símbolo de moneda en el cuerpo.

### 4.1. La diferencia de diseño más importante después de la multi-cuenta

| | Galicia | Macro |
|---|---|---|
| Evidencias del signo | **2** (columna + token) | **1** (solo la columna) |
| `traeSignoEnElImporte` | `true` | **`false`** |

**La redundancia se recupera de la cadena de saldos, y se midió:** `signo(saldo[i] − saldo[i−1])` coincide con
la columna en **1346 de 1346**, y en **0** casos el delta es cero. **Y solo funciona si la cadena se arma por
cuenta** (§14.4).

---

## 5. Saldo por fila: la cadena cierra **por cuenta**

| Cuenta | Movimientos | Rupturas |
|---|---|---|
| cta. cte. especial USD | 0 | n/a |
| cta. cte. especial ARS | 11 | **0** |
| cta. cte. bancaria ARS | 1335 | **0** |

**Cuatro triangulaciones independientes, todas `true`:**

1. `saldoInicialDeclarado + Σcréditos − Σdébitos == saldoFinalDeclarado` → las 3 cuentas.
2. `saldo(última fila) == saldoFinalDeclarado` → las 2 con movimientos.
3. 🔴 **`Saldo Cuentas en PESOS` (carátula) == Σ saldos finales de las 2 cuentas ARS** → **es la verificación
   que prueba que la separación multi-cuenta se hizo bien** (§14.4-bis).
4. `TOTAL COBRADO DEL IMP.S/CREDS. Y DEBS.` == `Σ(débito − crédito)` de los movimientos cuya glosa contiene
   `25413` → `true` en las dos cuentas.

**Si NO se separa por cuenta: 1 sola ruptura** (hay un único cambio de cuenta en orden de documento) y el
control cruzado del signo cae a 1345/1346. **1 ruptura sobre 1346 filas = 0,07 %: pasa cualquier umbral de
tolerancia, "casi cuadra", y produce una cuenta inexistente con dos saldos encimados.**

---

## 6. Fechas

- Cuerpo: **`dd/mm/aa`**, un único `x` (33.0) para los 1346 tokens.
- Carátula y líneas estructurales: **`dd/mm/aaaa`**.
- **No hay fecha valor** (0 filas con más de un token de fecha).
- **19 fechas distintas**, entre 2 y **164** movimientos por fecha.
- **Estrictamente no decrecientes por cuenta** (0 desórdenes).
- 🔴 **4 movimientos con fecha FUERA del período declarado**: la cta. cte. bancaria arranca con movimientos de
  **octubre** (`20/10/25`, `22/10/25`, dos cada uno) siendo el período `01/11 al 28/11`. Glosas `N/D FV …` y
  `RETENCION IIBB …`. **La validación "toda fecha cae dentro del período" es FALSA en este banco.** Es la
  contracara del hallazgo de Galicia (allá el período empezaba antes del primer movimiento).

---

## 7. Multi-línea: **no existe**

**Cero líneas de continuación.** Verificado por tres vías: 1346 movimientos = 1346 filas; las únicas filas sin
fecha con primer fragmento en la banda de glosa son **231** y todas están fuera de la tabla (`x=72.0`: 225 del
bloque `Sr(es):` de la carátula; `x=96.0`: 6 de `SALDO ULTIMO`/`SALDO FINAL`); interlineado uniforme de 12.0 pt.

🔴 **La glosa de movimiento arranca en `x=70.8`, la carátula en `x=72.0` — 1.2 pt.** La tolerancia de
`fragmentoEnX` para la glosa tiene que ser **< 1.2**, no 1.8.

**Criterio de movimiento:** fragmento con `|x − 33.0| < 1` que matchea `dd/mm/aa`. **No hace falta autómata de
continuación.**

🔴 **Lo que sí hace falta y Galicia no necesitaba: la glosa viene en 1–4 fragmentos por fila** (160 filas con
1, 340 con 2, **814 con 3**, 32 con 4). `fragmentoEnX(fila, 70.8)` devuelve **solo el primero** y perdería el
resto — **1186 de 1346 descripciones saldrían truncadas**, que es el peor modo de falla: los números cuadran y
la descripción queda mutilada.

**Glosa de 9 a 54 caracteres, sin truncado a ancho fijo** (Galicia truncaba a 27/20).

**Trampa fina:** **113 movimientos tienen un fragmento de glosa cuyo borde derecho pasa `x=264.0`** (hasta
297.6), o sea que la glosa **invade visualmente `REFERENCIA`**. De esos 113, **0 tienen referencia** — el banco
solo deja desbordar cuando la celda está vacía. La detección por `x == 264.0` exacto es correcta (1221 valores
+ 47 encabezados = 1268 fragmentos en 264.0), pero **una banda de glosa cortada en 264 pierde texto** y **una
regla "referencia = cualquier fragmento a la derecha de 260" captura glosa.**

---

## 8. Ruido: 1460 filas

| Qué es | Cuántas | Criterio |
|---|---|---|
| Leyendas legales (17 × 45) | 765 | primer fragmento en `x ∈ {20.2, 20.3}`, `y < 120` |
| Cabecera de carátula (8 × 45) | 360 | §2.1 |
| `Saldo Cuentas en …` | 90 | prefijo |
| `FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO` | 47 | igualdad |
| `DETALLE DE MOVIMIENTO` | 47 | igualdad |
| `<TIPO> NRO.:` + `Clave Bancaria…` | 47 + 47 | **no son ruido: son la señal de cuenta** (§14.2) |
| `SALDO ULTIMO` / `SALDO FINAL` | 3 + 3 | **dato de verificación** |
| Anexo impositivo | 12 | §9 |
| Separador `- - - -` | 3 | `/^- - -/` |
| Tabla `TIPO CUENTA SUCURSAL…` + 3 filas | 4 | solo p1 |

**No hay** pie con paginación concatenada al título, ni identificador de documento en el pie, ni página
fantasma. Tres trampas de Galicia que acá no existen.

### 8.1. 🔴 Lo que este inventario NO tenía, medido al escribir el adaptador

**El residuo arrancó en 141 filas** que ninguna regla de la tabla de arriba explicaba. Medidas una por una,
eran **seis bloques conocidos** — ninguno era un renglón nuevo del banco, y ninguno estaba acá. Llevarlo a
**0** no agregó tolerancia: agregó destino.

| Qué es | Cuántas | Criterio | Por qué faltaba |
|---|---|---|---|
| **Encabezado de sucursal**, arriba a la derecha (rótulo + **domicilio**) | **90** = 2 × 45 | **geométrico**: primer fragmento en `x ≈ 360.0`; las 90 con `y > 780` | No tiene literal estable: la segunda línea es el domicilio de la sucursal |
| **Leyenda de la columna izquierda de la carátula** | **45** | **geométrico**: `x ≈ 25.6` | Ahí también cae la etiqueta del período (otras 45), que se lee aparte y **antes**. `x = 25.6` no roza nada: legales en 20.2/20.3, titular en 72.0, anexo en 28.8 |
| **Datos de la tabla `TIPO CUENTA SUCURSAL MONEDA CUENTA CBU`** de la p1 | **3** | **posicional**: entre el título y la regla de subrayado que la cierra, sin salir de la página | El título sí estaba inventariado; sus tres filas de datos **no tienen literal propio** |
| **Regla de subrayado** que cierra esa tabla | **1** | `/^_{5,}$/` — un único fragmento de **125** guiones bajos | Un renglón sin un solo carácter del documento: se puede escribir el patrón entero |
| **Segunda línea de la leyenda `ESTIMADO CLIENTE …`** del anexo | **2** | **posicional**: fila siguiente, misma página, a un interlineado | La primera línea arranca con el literal; **la segunda no arranca con ningún literal propio** |

`90 + 45 + 3 + 1 + 2 = 141`.

> **La regla que sale de acá, y vale para los tres bancos:** *"fuera de la región de tabla"* es **una
> ubicación, no un destino**. Toda fila necesita un destino declarado —movimiento, ruido **con su regla**,
> anexo o residuo— y la ecuación tiene que cerrar. Ver `08-plan-de-construccion.md` §3.

**Dos de los seis se explican por posición y no por texto ni por `x`** (las 3 de la tabla de cuentas y las 2
de la leyenda del anexo): son bloques de continuación de un renglón que sí tiene literal. Es una tercera
clase de regla, además de la textual y la geométrica.

⚠️ **Contradicción anotada, no resuelta:** el título de este §8 dice **1460** y su propia tabla suma **1428**.
Ni 1428 ni 1460 incluyen las 141 de arriba, ni las 225 filas del bloque `Sr(es):` que §7 mide aparte. Los
tres conteos se produjeron en pasadas distintas y **nunca se cerraron contra `filas geométricas = 2865`**.
Hace falta una medición que reparta las 2865 sin residuo — que es exactamente lo que el adaptador ya hace
para `lineasNoInterpretadas` y este documento todavía no refleja.

---

## 9. Totales y anexo

**No hay línea `Total`.** Ni por cuenta ni del archivo. Lo único declarado es el par saldo inicial / final
**por cuenta**.

**Sí hay anexo impositivo, por cuenta, después de `SALDO FINAL AL DIA`:**

```
TOTAL COBRADO DEL IMP.S/CREDS. Y DEBS. EN CTAS. BANCARIAS DEL PERIODO <F4> AL <F4>   <IMP>
D. 409/2018 - IMPUESTO LEY 25413 COMPUTABLE CONTRA OTROS TRIBUTOS DEL PERIODO <F4> AL <F4>
(S.E.U.O.)                                                                          <IMP>
ESTIMADO CLIENTE, TENGA EN CUENTA QUE UD. PUDIERA ESTAR ALCANZADO POR BENEFICIOS FISCALES…
```

**Cuatro cosas que rompen un parser del anexo:**

1. **Dos variantes de espaciado del mismo literal:** `IMP.S/CREDS. Y DEBS. EN CTAS. BANCARIAS` (2 veces) y
   `IMP.S/CREDS.Y DEBS.EN CTAS.BANCARIAS` (1 vez, p45). **Igualdad exacta no sirve.**
2. **Dos variantes de la línea `D. 409/2018`:** dos con el importe en la **fila siguiente**
   (`(S.E.U.O.) <IMP>`) y una con `DEL PERIODO AL <F4> (S.E.U.O.) <IMP>` **inline y sin fecha de inicio**.
3. **Un `D. 409/2018` cruza el corte de página**: la etiqueta en p1 `y=151.4` y su `(S.E.U.O.) <IMP>` en p2
   `y=496.3`, **después del encabezado de cuenta repetido de p2**. Es el único elemento que se parte entre
   páginas.
4. 🔴 **La atribución del anexo a la cuenta NO es posicional.** Hay 3 líneas `D. 409/2018` para 3 cuentas, y el
   reparto medido en orden de documento es **0 / 2 / 1**. **No determinado** a qué cuenta corresponde cada una.

🔴 **Los 178 importes de fuera de la tabla caen en la ventana de `SALDO`** (borde derecho 553.8, **idéntico**
al del cuerpo, no aproximado como en Galicia):

| Fuente | Filas |
|---|---|
| `… Tasa Efec. Anual: <IMP>` (el segundo importe) | 44 |
| `Saldo Cuentas en PESOS` / `en DOLARES EE.UU.` | 90 |
| `SALDO ULTIMO` / `SALDO FINAL` | 6 |
| `TOTAL COBRADO` / `(S.E.U.O.)` / `D. 409` inline | 6 |

**Hay que acotar la región de tabla, y acá es peor que en Galicia**: allá el anexo estaba al final; acá los
falsos saldos están **arriba de cada página** y **entre las cuentas**. El criterio que funciona: **un saldo se
lee solo de una fila que ya se reconoció como movimiento** (fecha en `x=33.0`), nunca barriendo la página.

### 9.1. Los tres `D. 409/2018` **sí se capturan** — medido contra el archivo real

La versión anterior de esta spec dejaba el renglón como "no determinado" y el adaptador **lo descartaba por
eso mismo**. Era el error: *"no sé de qué cuenta es"* no es motivo para perder **el único renglón del
documento que no se puede reconstruir desde los movimientos** (el importe computable como pago a cuenta).

| Renglón | `atribucion_cuenta` | `relacion_con_movimientos` | Evidencia |
|---|---|---|---|
| `TOTAL COBRADO DEL IMP.S/CREDS. Y DEBS.` (3) | `publicada_por_cuenta` | `resume_movimientos_del_cuerpo` | El banco lo imprime **dentro** de la sección, y §5 mide que coincide con `Σ(débito − crédito)` de las glosas con `25413`: su importe **ya está** en el cuerpo |
| `D. 409/2018 … COMPUTABLE CONTRA OTROS TRIBUTOS` (3) | **`no_determinada`** | `no_esta_en_los_movimientos` | Reparto 0/2/1 sobre 3 cuentas: la atribución no es posicional. Se emite igual, **con la cuenta ausente y el motivo declarado** |

**Que esté impreso dentro de una sección no es evidencia de a qué cuenta pertenece.** Las dos filas están
impresas dentro de una sección y solo una de ellas es atribuible: lo que las separa es la evidencia, no la
posición — y es exactamente lo que declara la columna `atribucion_cuenta`.

#### El apareo del que cruza el corte de página: **orden de lectura, una sola vez**

De los tres `D. 409/2018`, uno trae el importe inline y dos lo traen en una fila `(S.E.U.O.) <IMP>`
posterior; **uno de esos dos cruza el corte de página** (etiqueta en la p1, cola en la p2).

🔴 **Las colas se consumen en orden de lectura del documento y una sola vez — nunca por cercanía.** En la p2
hay dos colas, y **la primera aparece *antes* que la etiqueta propia de esa página**: es la cola del renglón
de la p1. Un apareo "la `(S.E.U.O.)` más cercana" **cruza los dos importes**, y los dos renglones salen
plausibles y con el importe del otro. Por eso la cola se busca sobre el documento entero, no dentro de la
página ni de la sección; y `paginaPdf` del anexo es la de la **etiqueta**, no la del importe.

---

## 10. Conteo esperado (el "Done" del adaptador)

| Métrica | Total | esp. USD | esp. ARS | cta. cte. ARS |
|---|---|---|---|---|
| **Movimientos** | **1346** | **0** | **11** | **1335** |
| `CREDITOS` | 1165 | 0 | 3 | 1162 |
| `DEBITOS` | 181 | 0 | 8 | 173 |
| En ambas / sin importe / sin saldo | **0 / 0 / 0** | — | — | — |
| Saldo negativo | **283** | 0 | 0 | 283 |
| Con `REFERENCIA` | 1221 | 0 | 9 | 1212 |
| **Rupturas por cuenta** | **0** | 0 | **0** | **0** |
| Rupturas si se mezclan | **1** | — | — | — |
| Fechas distintas | 19 | 0 | 3 | 19 |
| Fechas fuera del período | **4** | 0 | 0 | **4** |
| Continuaciones | **0** | — | — | — |
| Fragmentos de glosa por fila | **1–4** | — | — | — |
| Saldo inicial / final declarados | sí | sí | sí | sí |
| Totales de déb./créd. | **no** | no | no | no |

**Duplicados:** **7 grupos, 19 filas**, hasta **4 repeticiones** de `(cuenta, fecha, glosa, importe)`. Con el
saldo: **0 grupos**. 🔴 **Pero la clave tiene que incluir la CUENTA**: sin ella, dos movimientos idénticos en
cuentas distintas colapsan.

**Referencias:** 1108 distintas y **1 compartida entre cuentas** (el `0` de las transferencias internas, §14.5).
**La referencia no es única y no sirve como clave de fila.** Siempre numérica, de 1 a 10 dígitos, vacía en 125.

**Lo que NO alcanza para el Done:** las 1346 filas con `cuadra`. Además: **2 cuentas con movimientos separadas**
(no una de 1346), **la glosa completa** (los 1–4 fragmentos), y **el consolidado de la carátula cuadrando
contra la suma de los saldos finales en ARS**.

---

## 11. Trampas

| # | Trampa | Medida |
|---|---|---|
| 1 | **Tres cuentas en un archivo**, con un `<TIPO> NRO.:` repetido 47 veces | §14 |
| 2 | **La cadena es por cuenta.** Mezclada da 1 ruptura y "casi cuadra" | 1 vs 0 |
| 3 | **El signo NO está en el token**: la columna es la única evidencia | 0 de 1346 |
| 4 | El saldo lleva el menos **ADELANTE** — al revés que Galicia | 283 |
| 5 | **La glosa viene en 1–4 fragmentos.** `fragmentoEnX` sola trunca | 1186 filas con ≥2 |
| 6 | La glosa **desborda hacia `REFERENCIA`** (hasta `x=297.6`) | 113 |
| 7 | Carátula en `x=72.0` y glosa en `x=70.8` — **1.2 pt** | tolerancia < 1.2 |
| 8 | **Los bordes del encabezado no son los del valor** (453.0 vs 465.6) | 0 aciertos |
| 9 | `Tasa Efec. Anual` cae **exactamente** en el borde de `SALDO` (553.8) | 44 |
| 10 | `Saldo Cuentas en …` también cae en la ventana de `SALDO` | 90 |
| 11 | **4 movimientos con fecha fuera del período** | 4 |
| 12 | Sin totales de déb./créd. → `traeTotalesDeclarados: false` | 0 líneas `Total` |
| 13 | El anexo `D. 409/2018` **cruza el corte de página**; en la p2 la cola ajena aparece **antes** que la etiqueta propia → apareo en **orden de lectura**, nunca por cercanía (§9.1) | 1 de 3 |
| 14 | El anexo tiene **dos variantes de espaciado** y **dos formas** | 2 + 2 |
| 15 | La atribución del anexo a su cuenta **no es posicional** (0/2/1) → se emite con `no_determinada`, no se descarta (§9.1) | 3 de 3 capturados |
| 21 | `TRANSF:<token>` se imprime **pegado**: un ancla con espacio final pierde **84** movimientos con todo lo demás en verde (§12) | 84 |
| 22 | `PAGO<n>-LIQ COMER` viene en **dos largos** (8 y 11 dígitos) y hoy **no se puede capturar** sin romper INV-14 (§12.2) | 70 + 6 = 76 |
| 16 | ~~`CUIT` y razón social pegados sin separador~~ **NO EXISTE** — ver §2.0-bis. Las dos trampas reales de ese bloque son la 21 y la 22 | — |
| 17 | En la tabla de cuentas, la fila de la cuenta en **dólares** trae `MONEDA` y `CUENTA` **en un solo fragmento** (`x=331.2`), las de pesos separados (331.2 y 373.2). **Parsear esa tabla por `x` falla justo en la moneda extranjera** | 1 de 3 |
| 18 | 🔴 **`IDCB` es la trampa del `contains` en Macro**: `N/D DBCR 25413 S/DB TASA GRAL` es el impuesto y `N/D IDCB GRAL. EXTRAC EFVO PYME` es una **extracción de efectivo**. Un `includes('IDCB')` los suma: **medido, la conciliación del anexo pasa de `true` a `false`**. Con `25413` da `true` | verificado |
| 19 | La `REFERENCIA` **se repite entre cuentas** | 1 colisión |
| 20 | 7 grupos de duplicados; el hash necesita **cuenta + saldo + ordinal** | 19 filas |
| 21 | 🔴 **El rótulo de la carátula NO abre su fila.** `C.U.I.T` es el **tercer** fragmento (`x = 364.4`), con texto a la izquierda en `72.0` y `93.0`: **cualquier patrón anclado con `^` falla siempre**. Costó dos intentos de adaptador antes de medirlo | §2.0-bis |
| 22 | 🔴 **`Sr(es):` tiene su valor en el RENGLÓN SIGUIENTE**, y esa fila comparte baseline con el `C.U.I.T` de la columna derecha. Un lector que corte "todo lo que sigue a la etiqueta en la fila" **guarda el documento del titular adentro del campo del nombre** — y es invisible, porque ese campo no se imprime nunca | §2.0-bis |

---

## 12. Vocabulario del banco

**Conceptos sin contraparte** (etiquetas del banco, con frecuencia):

`N/D Transf. MacrOnline E-set D/T` (29) · `N/D Comision Trf. MacrOL E-set` (22) ·
`N/D DBCR 25413 S/DB TASA GRAL` (17) · `N/D DBCR 25413 S/CR TASA GRAL` (17) · `PAGO DE CHEQUE DE CAMARA` (16) ·
`DEBITO FISCAL IVA BASICO` (7) · `N/D DB TRANSF MINORISTA DIST TIT` (7) · `N/D COMISION TRANSFERENCIAS` (7) ·
`RETENCION IIBB CORDOBA RENTA FINANC` (6) · `N/D DB PAGO REMUNERACIONES` (6) · `RETENCION IVA PERCEPCION` (5) ·
`N/D FV IMPDBCR 25413 S/DB TASA GRAL` (5) · `ACREDITACION CHEQUE REMESAS` (5) ·
`N/C CR TRANSF AUT SDO MISMO TIT` (3) · `N/D DB TR..AUT.SDO.MISMO TIT.` (3) · `IMP. AFIP` (3) ·
`CHEQUE CANJE INTERNO` (3) · `RETIRO CAJ.AH.` (2) · `N/D IDCB GRAL. EXTRAC EFVO PYME` (2) ·
`N/C DBCR 25413 S/CR TASA GRAL` (2) · y con 1 cada uno: `N/D COM RETIRO EFECTIVO POR CAJA`,
`COMISION TRANSFERE`, `DEPOSITO EN EFECTIVO CTA. CTE.`, `N/C FV CR DEPOSITO CANJE INTERNO`,
`N/D FV CHEQ.DEV. DEP.CJE. INTERNO`, `N/D FV COMISION DEPOSITO Ó RECH CHE`,
`N/D COMISION DEPOSITO O RECH CHEQ`, `N/C FV IMPDBCR 25413 S/CR TASA GRAL`,
`N/D FV IMPDBCR 25413 S/CR TASA GRAL`, `N/D COMISION ADM.VALORES AL COBRO C`,
`N/D COMISIÓN ADMINISTRACIÓN DE CHEQUERA`, `N/D MANTENIMIENTO MENSUAL PAQUETE`,
`N/D COMISION CHQ PAG CLEARING`, `ND CHEQUE DEVUELTO REMESAS`.

**Prefijos con contraparte** (el nombre va después y no se reporta): `TPUSH ` (**569**) · `TRANSF ` (**409**) ·
`PAGO<########>-LIQ COMER <procesadora>` (**76**, en **dos largos** — ver abajo) · `TRF MO CCDO DIST T - <n>` (9) ·
`TRANSF:<token>-<n>` y `CREDIN:<token>-<n>` (**84** = 78 + 6) · `CCERR <razón social> <n> CIRC.CERRADO` (5) ·
`TEF DATANET PR <razón social>` (4) · `10 Sol.Resc <n> <n>` (7) · `10 Liq.Susc <n> <n>` (3).

**Dos correcciones de esta sección, medidas al escribir el adaptador:**

1. 🔴 **`PAGO<n>-LIQ COMER` tiene DOS variantes de largo del número embebido**, no una:
   **8 dígitos en 70 movimientos** y **11 dígitos en 6**. La medición original solo vio la de 8 y ya daba el
   total 76 — o sea que el total estaba bien **y la forma estaba incompleta**: los dos largos suman los 76.
   Un patrón `PAGO\d{8}-` engancha 70 de 76 y deja 6 sin explicación aparente.
2. **`TRANSF:<token>-<n>` + `CREDIN:<token>-<n>` son 84, no "~90"**: 78 del primero y 6 del segundo. El
   "~90" era una estimación y quedó reemplazado por el conteo.

🔴 **Y la trampa que costó 84 movimientos:** el banco imprime `TRANSF:<token>` **pegado, sin espacio**. Un
ancla de prefijo que agregue el espacio final —lo natural cuando la etiqueta es una palabra— no engancha
ninguno de los 84, **con todo lo demás en verde**: los importes cuadran, la cadena cierra, y 84 movimientos
quedan sin concepto. El ancla se construye del literal tal como se imprime.

**Sufijos estructurales dentro de la glosa** (no son contraparte): `SUC.: ###` (sucursal del banco),
`DOC<###########>` (documento de la contraparte — **enmascarado**), `VAR`, `VARIOS`, `CUO`, `TRANSF`.

### 12.1. Hallazgos para el motor de reconocimiento

- **§0.A del motor, confirmado con dos pares nuevos:** `IDCB` (trampa 18), y `N/D DBCR 25413 S/DB` vs
  `N/C DBCR 25413 S/CR` — **misma raíz, lados opuestos**, y el `N/C` es una **reversa** (crédito). Seguros bajo
  prefijo anclado, letales bajo `contains`.
- **§0.B — dos de los cuatro tipos sin evidencia en Galicia SÍ la tienen acá:** tipo **8 depósitos en efectivo**
  → `DEPOSITO EN EFECTIVO CTA. CTE.`; tipo **14 cheque rechazado** → `ND CHEQUE DEVUELTO REMESAS`,
  `N/D FV CHEQ.DEV. DEP.CJE. INTERNO`. Siguen sin evidencia el **4** (intereses de financiación) y el **5**
  (SIRCREB — acá la retención provincial se publica como `RETENCION IIBB CORDOBA RENTA FINANC`, que **no es
  SIRCREB**).
- **§0.C ampliado:** además de FCI (`10 Sol.Resc` / `10 Liq.Susc`, 10 mov.) y percepción de IVA
  (`RETENCION IVA PERCEPCION`, `DEBITO FISCAL IVA BASICO`), dos huecos nuevos: **liquidación de tarjeta /
  procesadora** (`PAGO<n>-LIQ COMER <procesadora>`, **76 movimientos**, el segundo concepto más frecuente) y
  **cheque de pago diferido en circuito cerrado** (`CCERR … CIRC.CERRADO`, 5).
- 🔴 **`TPUSH` (569) + `TRANSF` (409) = 978 de 1346 = 73 % del archivo son transferencias recibidas de
  terceros.** El motor tiene que resolver bien ese único caso o no resuelve nada.
- 🔴 **El motor recibe un hueco de concepto de exactamente 76 movimientos** —los `PAGO<n>-LIQ COMER`, el
  segundo concepto más frecuente— que hoy **no llegan con `conceptoBanco`**. No es una omisión del léxico:
  es incapturable con una etiqueta estática por la interacción entre INV-13 e INV-14. Ver §12.2.

### 12.2. 🔴 El hueco de concepto: **exactamente 76 movimientos**, y por qué hoy no se pueden capturar

El vocabulario del §12 se captura con una **lista cerrada anclada al inicio de la glosa**, sin fallback a
"lo que no reconozco es concepto" — es lo que sostiene INV-14 (`concepto_banco` prefijo de la descripción
depurada) y con él la clasificación **N2** de la columna. Fuera de esa lista queda **un solo hueco**:

> **`PAGO<########>-LIQ COMER <procesadora>` — 76 movimientos**, el segundo concepto más frecuente del
> archivo, sin `conceptoBanco`.

**No es un olvido: hoy es incapturable, y el motivo es una interacción entre dos invariantes.**

1. La glosa se persiste **depurada** (INV-13): `depurarGlosa` **enmascara los dígitos embebidos**, así que
   lo que llega a `descripcion` es `PAGO[DOC]-LIQ COMER …`, no el literal impreso.
2. INV-14 exige que `concepto_banco` sea **prefijo literal** de esa descripción ya depurada — es un `check`
   de la base (`mov_crudo_concepto_prefijo_chk`, migración 0007), no una convención.

**Ninguna etiqueta estática puede ser prefijo de la glosa depurada**, porque el hueco de dígitos está en el
medio y la máscara lo reemplaza. Capturarlo con la etiqueta `PAGO` a secas —o con el literal completo—
**haría rebotar el lote entero con `concepto_banco_no_es_prefijo`**. El hueco se declara; no se tapa
aflojando el invariante que mantiene la tabla fuera del régimen de lectura auditada.

**Las dos salidas posibles, ninguna elegida todavía:**

- **Una forma de etiqueta con hueco variable** (patrón, no literal), que produzca un `conceptoBanco` que
  siga siendo prefijo de la glosa **después** de depurar — o sea, con la máscara adentro de la etiqueta.
- **El corte geométrico**: `concepto_banco_estrategia = 'columna_propia'`, que es la vía que INV-14 ya
  exceptúa. No hay columna de concepto en este banco, así que hoy no aplica.

Es el mismo caso que §5 de `08-plan-de-construccion.md` deja para la contadora (liquidación de procesadora
de pagos, uno de los tipos que las 14 reglas no cubren): **76 movimientos, y hoy el motor no tiene ni la
etiqueta**.

---

## 13. Qué del toolkit sirve

**Sirve tal cual:** `extraerTexto` + `paginasSinTexto` · `aFilas()` + `TOLERANCIA_FILA = 2.5` (interlineado
12.0 pt) · `textoDeFila()` · `fragmentoEnVentanaDerecha()` para los tres importes · `parseo-ar.ts` /
`importeACentavos` (ya soporta menos adelante y atrás) · `extraerPeriodo()` **anclado en la etiqueta**.

**Sirve con ajuste:** `fragmentoEnX()` — **tolerancia ≤ 1.0 para la glosa**, no 1.8 (§7) · `parsearFecha` con
período — **pero el período no acota** (4 fechas de octubre) · `hash.ts` — **la `ClaveCuenta` deja de ser una
constante del adaptador**: hay una por cuenta detectada.

**Sigue en cero usuarios:** `inferirCortes` / `cortarEnColumnas`. **Confirmado en el tercer banco.**

**`EntradaGalicia = { filas }` es la segunda evidencia** de que la vista geométrica es la normal y no la
excepción: ya se puede cambiar el contrato del adaptador.

### 13.1. Piezas nuevas

1. 🔴 **`fragmentosEnBanda(fila, desde, hasta): string`** — une los 1–4 fragmentos de glosa. Sin esto la
   descripción sale truncada, **y la descripción es el producto**. Va a `texto-pdf.ts` (es geometría).
2. **Autómata de secciones de cuenta** (§14.2). Lógica de banco → `macro.ts`. El contrato ya lo soporta
   (`cuentas` es un array), pero `armarCuenta` hay que generalizar a una por sección.
3. **Verificación por cuenta**, con `saldoInicialDeclarado` por sección.
4. 🔴 **Control nuevo, gratis y fuerte:** `Saldo Cuentas en <moneda>` == Σ saldos finales de esa moneda. **No
   tiene equivalente en Galicia** y es lo único que detecta que se perdió o se mezcló una cuenta.

### 13.2. Capacidades

```ts
export const CAPACIDADES_MACRO: CapacidadesAdaptador = {
  familiaLayout: 'columnas-posicionales',
  cadenaDeSaldos: 'completa',
  traeTotalesDeclarados: false,      // ← no hay línea Total
  traeSaldoInicialDeclarado: true,   // ← con etiqueta real, no derivado
  traeSignoEnElImporte: false,       // ← el token nunca lleva signo
  traeSaldoPorFila: true,
  traeFechaValor: false,
  traeReferencia: true,
  traeCodigoDeConcepto: false,
  anioEnLaFecha: true,
  multiCuenta: true,                 // ← el primero del roster
  multiMoneda: true,                 // ← declarado, NO ejercitado (§14.6)
};
```

---

## 14. MULTI-CUENTA — la sección más importante

### 14.1. Tres cuentas, misma sucursal

| # | Título impreso | Moneda | Movimientos |
|---|---|---|---|
| 1 | `CUENTA CORRIENTE ESPECIAL EN DOLARES` | DOLARES | **0** |
| 2 | `CUENTA CORRIENTE ESPECIAL EN PESOS` | PESOS | **11** |
| 3 | `CUENTA CORRIENTE BANCARIA` | PESOS | **1335** |

El primer dígito del número codifica el tipo y coincide con el 3.er grupo del CBU. **No se usa como criterio:**
es una correlación observada en un archivo, no una regla publicada.

### 14.2. Cómo se detecta el cambio de cuenta

**No hay una carátula por cuenta.** La carátula es **del archivo** y se repite en las 45 páginas. Lo que abre
una sección es un **encabezado con el número dentro**:

```
CUENTA CORRIENTE ESPECIAL EN PESOS NRO.: <numero>
Clave Bancaria Uniforme para Debito Directo: <cbu>[ Tasa Nom. Anual: <imp> Tasa Efec. Anual: <imp>]
DETALLE DE MOVIMIENTO
FECHA DESCRIPCION REFERENCIA DEBITOS CREDITOS SALDO
```

```
nueva sección ⇔ textoDeFila(fila) matchea
    /^(CUENTA(?: [A-ZÁÉÍÓÚÑ.]+)+) NRO\.:\s*(\d-\d{3}-\d{10}-\d)$/
```

**Verificado: 47 matches, 3 números distintos.**

🔴 **La regex sola NO basta: el encabezado se REPITE en cada página.** Reparto medido: 1 para la cuenta en
dólares (p1), **2** para la especial en pesos (p1 y p2), **44** para la cta. cte. bancaria (p2–p45).

**El criterio completo, y es el que decide si el adaptador separa o mezcla:**

```
1. leer (titulo, numero) del match
2. si `numero` YA SE VIO en este lote → NO es cuenta nueva: es el encabezado repetido
   de la página. Se reabre la sección existente y se le siguen sumando movimientos.
3. si `numero` es nuevo → alta de sección, con su período, saldo inicial, saldo final y anexo.
```

**Sin el paso 2 el adaptador emite 47 cuentas en vez de 3** y `uq_lote_cuenta_natural` revienta — o peor, si el
número se normaliza distinto, **no revienta** y quedan 47 filas de cuenta con la cadena partida en 45 pedazos.

**Señales secundarias, ninguna suficiente sola:**

| Señal | Conteo | Por qué no alcanza |
|---|---|---|
| `- - - -` (separador) | **3** | Solo separa **entre** cuentas, no en las 43 repeticiones internas |
| `DETALLE DE MOVIMIENTO` / `FECHA DESCRIPCION…` | 47 / 47 | Se repiten por página |
| `SALDO ULTIMO EXTRACTO AL` | **3** | **Uno por cuenta**, pero llega **después** del encabezado |
| `SALDO FINAL AL DIA` | **3** | Uno por cuenta. Buen criterio de **cierre** |

**El par `SALDO ULTIMO` / `SALDO FINAL` (3 y 3) es la verificación de que el conteo de cuentas dio bien.** Si el
adaptador emite un número distinto de cuentas, hay error de sectorización.

🔴 **Trampa de orden:** en la p2 hay **dos encabezados de cuenta**: primero se repite el de la cuenta que venía
(para colgarle la cola del anexo, §9.3) y **después** empieza la nueva. Un autómata que cierre la sección al ver
cualquier encabezado **atribuye el anexo a la cuenta equivocada**.

### 14.3. Qué es por cuenta y qué del archivo

| Dato | Alcance | Etiqueta |
|---|---|---|
| **Período** | 🔵 **del archivo** | `Resumen General Periodo del Extracto:` — 45 apariciones, un solo valor, **fuera** de toda sección |
| **Saldo inicial** | 🟢 **por cuenta** | `SALDO ULTIMO EXTRACTO AL` — 3 |
| **Saldo final** | 🟢 **por cuenta** | `SALDO FINAL AL DIA` — 3 |
| **Totales déb./créd.** | ⚫ **no existen** | — |
| **Anexo impositivo** | 🟢 por cuenta (`TOTAL COBRADO`, 3) pero el `D. 409/2018` reparte 0/2/1 → **atribución no determinada** |
| **Saldo consolidado por moneda** | 🔵 **del archivo** | `Saldo Cuentas en …` — 45 cada uno |

En este archivo las fechas de saldo son iguales en las 3 cuentas (`31/10/2025` y `28/11/2025`), así que
`periodo_desde`/`hasta` de `lote_ingesta_cuenta` se pueden llenar con el del archivo. **Que sean iguales es un
hecho medido, no una garantía**: las etiquetas son por cuenta y podrían diferir (alta a mitad de mes). El
adaptador debería tomarlas **de la sección** y usar el período del archivo solo como fallback.

### 14.4. La cadena cierra por cuenta

Ver §5. **Mezcladas: 1 ruptura sobre 1346 = 0,07 %.** Pasa cualquier umbral, "casi cuadra", y produce una
cuenta inexistente con dos saldos encimados.

### 14.4-bis. 🔴 El control que detecta la mezcla

```
Saldo Cuentas en PESOS            == Σ (saldo final declarado de cada cuenta ARS)   → true
Saldo Cuentas en DOLARES EE.UU.   == saldo final de la cuenta USD                   → true
```

**Verificado `true`. Es la única aritmética del documento que NO cierra si el adaptador mezcla, pierde o
duplica una cuenta.** No tiene equivalente en Galicia y debería ser un invariante nuevo (`INV-multicuenta`).

### 14.5. 🔴 Transferencias entre las cuentas del archivo

**Hay 3 pares, con las dos patas presentes.**

| Evidencia | Coincide |
|---|---|
| Importe | ✔ exacto |
| Fecha | ✔ misma (03/11, 10/11, 18/11) |
| Signo | ✔ opuesto (crédito en la especial ARS, débito en la cta. cte. ARS) |
| `REFERENCIA` | ✔ igual — **pero el valor es `0`**: es un relleno, **no sirve como evidencia** |
| **Concepto** | ✔ **par cerrado del vocabulario**: `N/C CR TRANSF AUT SDO MISMO TIT` ↔ `N/D DB TR..AUT.SDO.MISMO TIT.` |

**Dirección:** las 3 salen de la cta. cte. bancaria y entran a la especial en pesos. Nunca al revés.

#### El hallazgo que cambia la regla 10

**"Mismo importe + misma fecha + signo opuesto + cuentas distintas" NO es suficiente.** Ese criterio devuelve
**5 pares, de los cuales 2 son FALSOS POSITIVOS**:

| Par | Pata A | Pata B | ¿Real? |
|---|---|---|---|
| 1, 2, 3 | `N/C CR TRANSF AUT SDO MISMO TIT` | `N/D DB TR..AUT.SDO.MISMO TIT.` | ✅ |
| 4, 5 | `RETIRO CAJ.AH.` (débito) | `10 Sol.Resc …` (crédito) | ❌ |

Los falsos son dos importes redondos que coinciden por casualidad el mismo día. El concepto los refuta:
`RETIRO CAJ.AH.` transfiere a una **caja de ahorro que no está en el archivo**, y `10 Sol.Resc` es un **rescate
de FCI**. Sin exigir misma fecha, el criterio devuelve **8** pares: 5 falsos.

> **La pata de una transferencia entre cuentas propias se reconoce por el PAR DE CONCEPTOS del vocabulario del
> banco. El importe, la fecha y el signo son la CONFIRMACIÓN, no el criterio.**

Al revés se imputan como movimientos con terceros dos operaciones legítimas — **y el asiento cuadra igual**,
porque el importe y el signo están bien; lo que queda mal es la cuenta de contrapartida.

**Y el corolario incómodo:** `RETIRO CAJ.AH.` **sí es** una transferencia a una cuenta propia, solo que la
contrapartida no está en el archivo. **El sistema no puede decidirlo con este documento.** Hace falta un estado
que hoy no existe: *"reconozco el concepto, la contrapartida es una cuenta propia que no está en el lote"*.

### 14.6. Moneda extranjera: estructura sí, datos no

- La estructura **existe y está impresa**: cuenta `EN DOLARES`, consolidado `en DOLARES EE.UU.` separado, y
  columna `MONEDA` con `DOLARES` / `PESOS`.
- **Cero movimientos** en la cuenta en dólares. Saldos inicial y final `0,00`.
- **`multiMoneda` se declara `true` pero NO está ejercitado.**
- 🔴 **La cuenta en dólares tiene su propio `TOTAL COBRADO`, y se emite en `USD`.** La moneda del anexo es
  la de **la sección en la que el banco lo imprime** —la misma columna en la que alinea los saldos de esa
  cuenta—, no `ARS` por default. Es el único renglón medido de la cuenta en dólares, y **suponerle pesos
  habría inventado una conversión**: un hecho fiscal fabricado, en la moneda equivocada, que cuadra igual
  porque nada en el documento lo contradice. Que la cuenta esté vacía no la exime del anexo.
- **No determinado:** si hay cotización, si el saldo de una cuenta USD se expresa en USD o en ARS, si el importe
  lleva símbolo. **No hay un solo movimiento en dólares, así que no se supone nada.**
- 🔴 Trampa medida: en la tabla de cuentas, la fila de la cuenta en dólares emite `MONEDA` y `CUENTA` **en un
  único fragmento** (`x=331.2`); las de pesos los separan (331.2 y 373.2). **Parsear esa tabla por `x` falla
  justo en la fila de moneda extranjera.** El tipo/moneda hay que leerlo del **título de la sección**.

### 14.7. Volumen y escala

| Métrica | Valor |
|---|---|
| Movimientos | **1346** (4,1× Galicia) |
| Páginas | 45 |
| Filas geométricas | 2865 |
| Movimientos por página | 11 a 31 (31 en 42 de 45) |
| Movimientos por fecha | 2 a **164** |
| Tamaño | 266 KB |
| `aFilas()` + análisis | pocos segundos, sin problemas de memoria |

**Sin problema de escala en la extracción.** Dos puntos de atención en la **persistencia**:

1. **1346 inserts en una transacción** bajo `conUsuario()`. Galicia validó 326. **Medir el batch antes de
   congelar.**
2. **164 movimientos en una misma fecha** y 7 grupos de duplicados: la clave necesita **cuenta + saldo +
   ordinal**. Con la cuenta afuera, dos movimientos idénticos en cuentas distintas colapsan.

---

## 15. No determinado

- Si los bordes derechos (385.8 / 465.6 / 553.8) son estables entre períodos y tipos de cuenta.
- Si el saldo negativo puede venir con el menos **atrás** o con `U+2212` (acá los 283 son U+002D adelante).
- Todo lo de moneda extranjera (§14.6), **salvo la moneda del anexo**: el `TOTAL COBRADO` de la cuenta en
  dólares se emite en **USD** (§14.6), que sí está medido.
- A qué cuenta corresponde cada línea `D. 409/2018` (reparto 0/2/1). **No bloquea la captura**: los 3 se
  emiten con `atribucion_cuenta = no_determinada` (§9.1). Lo no determinado es la cuenta, no el renglón.
- 🔴 **Cómo capturar `PAGO<########>-LIQ COMER` (76 movimientos) sin romper INV-14.** Es el único hueco de
  concepto del archivo y hoy es incapturable con una etiqueta estática: la depuración de INV-13 enmascara
  los dígitos embebidos y ninguna etiqueta literal es prefijo de la glosa depurada. Hacen falta **etiquetas
  con hueco variable** o un corte geométrico. Detalle y las dos salidas posibles en §12.2.
- Si puede haber cuentas con movimientos **intercaladas** (acá las secciones son **contiguas**: 11 y después
  1335, un solo cambio). La lógica de "reabrir sección por número" lo soporta, **no está probada**.
- Si aparece una **caja de ahorro** en el mismo resumen (el vocabulario la nombra en `RETIRO CAJ.AH.`, pero no
  está en la tabla de cuentas).
- 🔴 **El cruce contra el `.xls` NO se hizo.** El hermano `11-2025.xls` es **BIFF8 legacy** (OLE2, magic
  `D0 CF 11 E0`) y `exceljs` —la única dependencia de Excel del repo— **no lee `.xls`, solo `.xlsx`**. Es una
  verificación cruzada barata que hoy requiere una dependencia nueva. Deuda anotada.
