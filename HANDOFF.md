# HANDOFF — bitácora del proyecto

> Bitácora compartida entre **Claude Code** y **Codex**. Se escribe una entrada **apenas se cierra el
> DoD** de una tarea o decisión, no al final de la sesión. **Lo que no está acá o en los docs no existe
> para la otra herramienta.** Entrada más reciente arriba.

---

## 2026-08-10 (15) — 🔴 **`09-lecciones-aprendidas.md`**: el procedimiento para los cinco bancos que faltan

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **638 tests + 7 todo**. **Sin commits.**

> **Antes de escribir el adaptador del cuarto banco, leé `docs/diseno/09-lecciones-aprendidas.md`.** No es una
> bitácora: es el **procedimiento** (§7, doce pasos), las trampas medidas, y los **tres niveles de prueba**
> que hasta hoy no estaban escritos en ningún lado (§8).

### Por qué existe

Los tres primeros bancos costaron caro en errores que **se repitieron con caras distintas**, y ninguno se
manifestó como una excepción o un test rojo: **todos produjeron un resultado que cuadraba igual**. Con cinco
bancos por delante, escribirlos una vez sale más barato que volver a pagarlos.

Lo que el documento fija, en una línea cada uno:

1. **El error de los cuatro rostros: el límite que no se puso.** `includes` sin ancla · `TRANSF: ` con espacio
   final (84 movimientos) · `\d{22}` sin `\b` · banda de `x` sin corte derecho. **Todo patrón que localiza un
   dato necesita sus DOS límites.** Y los cuatro campos afectados **no se imprimen nunca**, así que un valor
   sucio ahí es invisible para siempre.
2. **Un fixture escrito desde la especificación no la verifica: la consagra.** Con la cadena completa —spec
   mal → adaptador → fixture → 64 tests verdes— y la contramedida: **probar por mutación**, revirtiendo cada
   premisa y contando los tests que caen. *Si una mutación no rompe nada, ese test no prueba lo que dice.*
3. **El destino de una línea es QUÉ ES, no DÓNDE ESTÁ**, con la tabla de los tres bancos que muestra que **el
   que mejor puntuaba era el que más perdía**.
4. **Los controles que solo existen si alguien los escribe**, y el patrón común: se comparan contra algo que
   **el documento declara** y que el adaptador **no produjo**.
5. **Predicciones falsables en vez de conjeturas** — con los dos casos de esta etapa, incluida **una
   hipótesis mía que se falsificó midiéndola** (los 160 conceptos: el cruce dio 0 de 160).
6. **Las herramientas y qué contesta cada una**: `pnpm probar`, `--caratula <n>` fragmento por fragmento, y
   las formas del residuo agrupadas.

### La pregunta del titular, contestada con evidencia

*"¿Cada desarrollo tiene su US en backlog y su plan de testing?"* — **verificado sobre el repo: no.**

| | Estado |
|---|---|
| Backlog de US | ❌ **No existe.** Cero artefactos en `docs/` |
| Criterios de aceptación | ✅ Existen y son **mejores que una US típica**: el "Done" por banco de `08` §3 son conteos exactos. Pero están por **etapa de ingeniería**, no por unidad de trabajo |
| Plan de testing | ❌ No existía. **Lo escribe `09` §8** |
| DoD | 🟡 Parcial (`docs/devops/03` §2), y **le falta el nivel funcional** |

**Los tres niveles que de hecho existen**, medidos: **14 archivos puros** (unitario) · **9 contra Postgres
real** con RLS y las tres credenciales (integración) · **`pnpm probar` contra el archivo real**
(funcional/aceptación).

🔴 **El tercero no está automatizado y no puede estarlo**: el gate no tiene acceso a `privado/`. Eso lo vuelve
un **paso manual obligatorio del DoD de cada banco** — y es literalmente el nivel que encontró el anexo
perdido, el error de la spec, los 84 conceptos y el CBU sin leer.

**Recomendación escrita en `09` §9:** para cinco bancos no hace falta un backlog formal. Hace falta que **§7
sea el DoD de cada uno**, con el paso 12 —correr contra el archivo real y comparar **cada** número—
**bloqueante**. Es el 90 % del valor de una US con el 10 % de la ceremonia.

---

## 2026-08-10 (14) — Los seis pendientes, cerrados. Y **un error en la especificación**, no en el código.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **638 tests + 7 todo**, 23 archivos.
Verificado contra los tres archivos reales. **Sin commits.**

### Los seis

| # | Qué | Resultado |
|---|---|---|
| 1 | CBU de Galicia | ✅ `cbu=si`. Por etiqueta, **solo en la carátula**, y con `\b` de los dos lados |
| 2 | Las 2 filas con fechas del residuo de Santander | ✅ **No llevan importe en ningún lado**: se corrige la spec, no el código |
| 3 | Titular de Macro | ✅ `titular=si documento=si`. `condicionIva=no`, **declarado**: ese banco no publica la etiqueta |
| 4 | `alicuotaPublicada` con dos tasas | ✅ **No se parte.** Hoy nadie calcula con ese valor y el consumidor futuro va a decir cuál importa |
| 5 | Sincronizar las specs con lo medido | ✅ Las cuatro (`02`, `06`, `07`, `08`) |
| 6 | Canario de INV-15 | ✅ **Declarado** con sus tres aserciones en `it.todo`: su sujeto es el Módulo 2 |

**Carátula completa en los tres bancos**, que era el arranque de la pregunta: *"si no se leen los encabezados,
ahí hay información del cliente… ¿se desecha?"*. Se desechaba. Ya no.

### 🔴 El hallazgo de fondo: la spec estaba mal, y ninguna capa podía verlo

`07` §2 declaraba que el CUIT venía con la razón social **pegada**. Es falso, y costó **dos intentos de
adaptador** antes de medirlo. La forma real, por fragmento:

```
  fila 2   x= 72.0  Aa(aa):                    ← el rótulo, SOLO
           x=360.2  AAAAAAA (####) AAAAAAA     ← otra columna
  fila 3   x= 72.0  AAAA
           x= 93.0  A{9} AAA                   ← la razón social, en DOS fragmentos
           x=364.4  A.A.A.A #{11}              ← el CUIT, otra columna. La fila TERMINA ahí
```

**Por qué sobrevivió:** era **el único renglón de la tabla de §2 sin una regex verificada en §2.1**. Todos
los demás tienen su patrón contado contra el archivo; ése se describió a ojo. Y de ahí sale una cadena que
ninguna capa rompe sola:

> la spec lo dice mal → el adaptador se escribe contra la spec → **el fixture del test también** → 64 tests
> verdes confirmando el mismo supuesto falso.

**Regla que queda:** *un renglón de especificación sin conteo verificado es un renglón no medido. Y un
fixture escrito desde la especificación no la verifica: la consagra.*

Correcciones aplicadas a `07`: **§2.0-bis** con la medición; **trampa 16 eliminada** (no existe); **trampas
21 y 22 nuevas** — el rótulo no abre la fila, y `Sr(es):` tiene su valor en el **renglón siguiente**
compartiendo baseline con el CUIT.

**La 22 es la peligrosa**, y tiene la firma del peor modo de falla del proyecto: un lector que corte *"todo
lo que sigue a la etiqueta en la fila"* **guarda el documento del titular adentro del campo del nombre** — y
es invisible, porque ese campo no se imprime nunca. Hoy no pasa porque el corte es **por banda de `x` con
límite derecho**, y hay **4 tests que caen** si alguien saca ese límite.

Es el mismo error con cuatro caras: el `contains` de `IDCB`, el ancla con espacio de `TRANSF:`, el `\b` que
faltaba en el CBU, y esta banda sin corte.

### Dos cosas de método que funcionaron

1. **Las predicciones falsables como instrumento.** Santander no adivinó si sus dos filas eran anexo perdido:
   escribió una **tabla donde tres mecanismos mueven los números distinto**. Salió `anexos=7, residuo=5`, que
   era una fila exacta de esa tabla, y se confirmó viendo **qué forma desapareció** del residuo. Una
   ambigüedad de documentación resuelta por medición, sin abrir el archivo.
2. **`--caratula <n>` imprime la carátula fragmento por fragmento**, con la `x` de cada uno. Es lo que
   distingue *"el rótulo trae el valor"* de *"el rótulo está solo y al lado hay otra columna"* — invisible en
   la forma de la fila entera, y es exactamente lo que decide si un lector se lleva puesta la columna vecina.

### Backlog nuevo, todo anotado en `08`

1. 🔴 **E1.1 está en 5 de 14, no cerrado.** Escribí "cerrado, los 14 puntos" y era falso; lo detectó
   `documentador` verificando contra el código. Corregido en `08` §3.
2. **`fragmentoEnVentanaDerecha` devuelve el primero de la ventana, parsee o no.** Era riesgo teórico del
   panel; ahora tiene síntoma medido: un rótulo largo **tapa** al importe que viene atrás.
3. **El residuo no significa lo mismo en los tres adaptadores.** Galicia mete ahí filas que **sí se leyeron**
   (número de cuenta, CBU): el residuo es *"lo que el autómata del cuerpo no consumió"*, no *"lo que nadie
   leyó"*. Santander ya lo resolvió con su unión cerrada de destinos y `sinDestino = 0`.
4. **El gate de verificadores no mira los archivos de test.** Medido: **61 identificadores, 0 con verificador
   válido** — pero eso es mérito de quien los escribió, no del control. Un CUIT sintético con verificador
   válido **puede pertenecerle a un contribuyente real**.
5. **`alta-cuenta.ts` sigue sin tests**, y es el que fija contra qué resuelven todos los extractos futuros de
   una cuenta. Se le corrigió hoy un `\b` que faltaba: sin él, una corrida de 23 dígitos se recortaba a 22 y
   el alta guardaba un **CBU plausible e inexistente**.
6. **Macro §8 no cierra consigo mismo**: el título dice 1460 filas de ruido y su tabla suma 1428, y ninguno
   incluye las 141 del residuo. Nunca se cerró contra `filas geométricas = 2865`.

---

## 2026-08-10 (13) — **22 renglones fiscales rescatados.** Anexos, E2 completa, y el residuo con destino declarado.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **606 tests + 4 todo**, 23 archivos (venía
de 517). Verificado contra los tres archivos reales. **Sin commits.**

### El hallazgo que originó todo

Al agregarle al script de verificación las **formas del residuo** —el texto con los dígitos a `9` y las
letras a `A`/`a`, que muestra la estructura sin un solo dato— apareció esto en Galicia:

```
×9  AAAAAAA A{11} AAAAA AA ##-##-#### A AA ##-##-#### ###.###,##
```

Nueve renglones con dos fechas y un importe. `02` §10 mide que su anexo tiene **exactamente 9 entradas**.
**Era el bloque impositivo entero, en el residuo, con `anexos=0`.**

Y al mirar los tres juntos salió la inversión que importa:

| Banco | `lineasNoInterpretadas` | `anexos` | Qué pasaba |
|---|---|---|---|
| Galicia | 47 | 0 | los 9 renglones **en el residuo**: se veían |
| Macro | 141 | 3 de 6 | los `D. 409/2018` estaban en `RUIDO_MACRO`: **descartados sin rastro** |
| **Santander** | **0** | **0** | **7 renglones en ningún lado** |

> 🔴 **El que mejor puntuaba en "líneas no interpretadas" era el que más perdía.** Su adaptador no reportaba
> lo que caía fuera de la región de tabla, y por eso sacaba 0.

**La regla que sale de esto: el destino de una línea es QUÉ ES, no DÓNDE ESTÁ.** "Fuera de la región de
tabla" es una ubicación, no un destino. Toda línea necesita uno declarado —movimiento, ruido con su regla,
anexo o residuo— y la ecuación tiene que cerrar. Es lo que `particionar` + `residuoDeParticion` del toolkit
ya proponían con **cero usuarios**, y cuyo comentario describía el caso con seis meses de anticipación.

### El resultado, contra los archivos reales

| | Galicia | Santander | Macro |
|---|---|---|---|
| **Anexos** | **0 → 9** | **0 → 7** | **3 → 6** |
| **`conceptoBanco`** | **0 → 326** | 158 | **1186 → 1270** |
| Residuo | 47 → **29** | 0 → **6** | 141 → **0** |
| Carátula | `titular`+`documento`+`condicionIva` ✅ | `documento` ✅ | **`cbu`** ✅ |
| Movimientos · rupturas · INV-13/14 | 326 · 0 · 0/0 | 158 · 0 · 0/0 | 1346 · 0 · 0/0 |

**22 renglones fiscales rescatados**, incluidos los tres del *importe computable como pago a cuenta*, que
**no existe como movimiento y no es derivable de ellos**. Y **ningún número financiero se movió**.

### Los tres hallazgos de los agentes

1. 🔴 **Macro: 84 movimientos sin concepto por un espacio.** Yo había conjeturado que los 160 faltantes eran
   las 160 filas de un solo fragmento de glosa; el agente **cruzó los conjuntos y dio 0 de 160**. La causa
   real: `TRANSF:` y `CREDIN:` **estaban** en el vocabulario, pero el ancla les agregaba un **espacio final**
   y el banco los imprime pegados (`TRANSF:ABC…`). El ancla no matcheaba nunca. Arreglo: un prefijo que
   termina en carácter no alfanumérico se delimita solo; uno que termina en letra sigue exigiendo el espacio,
   **con contraprueba de `TPUSHERIA`** para que la trampa del `contains` no vuelva por la ventana.
   `conceptoBanco` **1186 → 1270**, y los 76 restantes son exactamente el hueco declarado de
   `PAGO<n>-LIQ COMER`.
2. **Galicia: el canario dio limpio.** `glosaDe` usa `fragmentoEnX`, que devuelve **un solo fragmento**: si
   alguna fila tuviera dos, la glosa se estaría truncando en silencio —el mismo modo de falla que en Macro
   mutiló 1186 descripciones—. El agente **no lo arregló** porque `descripcion` entra en `hashFila` y
   cambiarlo movería los 326 hashes, y dejó la predicción falsable: `con conceptoBanco < 326` significa
   exactamente eso. **Salió 326/326: no hay truncado, y los hashes no se tocan.** De yapa,
   `conceptos distintos = 32`, que es **el vocabulario medido en `02` §14 al literal**.
3. **El índice de doble lectura funciona.** Mi propio test puso dos anexos que diferían solo en
   `atribucionCuenta` y `uq_anexo_sin_doble_lectura` los rechazó — idénticos en literal, período e importe
   **son el mismo renglón leído dos veces**. Quedó como test propio.

### Lo que se escribió

- **`anexoExtractoSchema` rediseñado**: `periodoDato` (4 situaciones medidas, incluida `periodo_de_emision`
  —el banco **declara** el período sin imprimirlo—), `atribucionCuenta`, `relacionConMovimientos`,
  `ordenEnLote`, e `importe` → **`importeDeclarado`** (un `sum(importe)` copiado del query de movimientos
  **no compila**). Era lo que bloqueaba a Santander, cuyo agente se había negado —con razón— a emitir anexos
  con el período del extracto.
- **`persistirAnexos`** con el ordinal **del lote** (por cuenta colisionaría en `uq_anexo_orden`) y
  `no_determinada ⇒ cuenta en NULL`, más INV-14 como puerta de admisión.
- **`packages/ingesta/tests/anexos.test.ts`**, 12 tests contra la base real.
- **E2 completa**: Galicia tiene sus **primeros 34 tests propios** y `leerPar` migrado a `parDeColumnas`.
- Santander: **`leerSantanderConDestinos()`** — 7 destinos en unión cerrada, `sinDestino` tiene que dar 0, y
  `leerSantander` delega para que no haya dos clasificaciones que puedan divergir.

### Lo que queda

1. **Galicia: el CBU está en el residuo** (`×1 #{22}`) y sale `cbu=no`. INV-6 resuelve por número, así que no
   bloquea — pero el CBU es el identificador primario del resolver. **Por etiqueta, nunca por patrón**: el
   cuerpo tiene 113 corridas de once dígitos que son CUIT de contrapartes.
2. **Santander: dos de sus 6 filas de residuo llevan fechas** (`… ##-##-#### aa ##-##-####`), que es la
   estructura de un rótulo de anexo. Salieron 7 anexos y §9 dice 5+2, así que probablemente sean rótulos ya
   capturados — pero su propio agente avisó que **§9 lista seis rótulos para "5 importes"** y que cuál no
   lleva importe no se sabe sin el archivo. Dos minutos de mirada.
3. **Macro: `titular` y `documento` en `no`.** Su carátula los trae **pegados** (`C.U.I.T <11 dígitos><razón
   social>`, `07` §2), o sea que hay que partirlos.
4. **`alicuotaPublicada` es un campo y Santander publica dos tasas** (TNA y CFTEA). Hoy van juntas para no
   perder ninguna; separarlas pide una columna y una migración.
5. **`07` §12 quedó corto, medido**: `PAGO<n>-LIQ COMER` tiene **dos** largos (8 dígitos ×70 y **11 ×6**), y
   `TRANSF:`/`CREDIN:` suman **84**, no "~90". Y §8 no inventariaba las 141 filas del residuo.
6. Sigue pendiente el **test canario de INV-15** end-to-end, que necesita el Módulo 2 para tener sujeto.

---

## 2026-08-10 (12) — **Los tres bancos leídos y verificados contra los archivos reales.** E1.1, E4 y la 0008.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **517 tests + 4 todo**, 21 archivos.
Migraciones **0007 y 0008 aplicadas** contra Postgres 16. **Sin commits.**

### El resultado que importa

`pnpm probar --banco <codigo> --archivo <pdf>` corrido contra los tres archivos reales. **No toca la base
ni el almacenamiento**: lee, parsea, verifica e imprime conteos sin un solo valor.

| | Galicia | Santander | Macro |
|---|---|---|---|
| Páginas / filas geométricas | 26 / 1204 | 11 / 414 | 45 / 2865 |
| Cuentas | 1 | **2** | **3 (0/11/1335)** |
| Movimientos | **326** | **158** | **1346** |
| Créditos / débitos | 116 / 210 | **75 / 83** | 1165 / 181 |
| Saldo negativo | 14 | 158 | 283 |
| Con referencia | 21 | 94 | 1221 |
| **Rupturas de cadena** | **0** | **0** | **0 en las tres cuentas** |
| Fechas distintas | 21 | 22 | 19 y 3 |
| INV-13 / INV-14 | 0 / 0 | 0 / 0 | 0 / 0 |
| Hashes únicos | 326/326 | 158/158 | **1346/1346** |
| Esquema Zod | valida | valida | valida |

**Todos los números coinciden con los medidos** en `02` §2.2, `06` §10 y `07` §10. Y dos de los tres
adaptadores los escribieron agentes que **nunca abrieron `privado/`**: trabajaron solo contra las
especificaciones.

**Los tres controles que solo se ven en un archivo real:**

1. **`INV-multicuenta` en Macro: `verificado=true, diferencias=0`.** Es el único control que detecta la
   mezcla de cuentas — con las tres encimadas habría dado **1 ruptura sobre 1346 (0,07 %)** y todo lo demás
   igual. Separó bien.
2. **El reparto 83/75 de Santander.** Era el criterio que la cadena de saldos **no** atrapa: un parser que
   ponga los 158 en una columna da 0 rupturas si además invierte el saldo.
3. **Las 4 fechas de octubre de Macro salieron como `observacion`** con el lote en `cuadra` — la capacidad
   `traeMovimientosFueraDelPeriodo` haciendo exactamente lo suyo.

### Cinco hallazgos de la corrida, ninguno de parseo

1. 🔴 **El CLI nunca cablea `lineasNoInterpretadas` a la verificación.** Lo loguea y no se lo pasa a
   `verificarAritmetica`, así que **`EST_LINEA_NO_INTERPRETADA` jamás dispara en producción** — el código
   existe, tiene test, y sostiene la regla *"un adaptador nunca descarta una línea en silencio"*.
2. 🔴 **Y antes de cablearlo hay que unificar el criterio, porque hoy la métrica NO es comparable:**
   Santander **0**, Galicia **47**, Macro **141** — y los tres leyeron bien. Santander no reporta lo que cae
   fuera de la región de tabla; Macro sí. Cablearlo tal cual **rechazaría Galicia y Macro y dejaría pasar
   Santander**, por una diferencia de convención y no de calidad.
   **Propuesta:** solo cuenta lo que cae **dentro** de la región de tabla —donde una línea perdida es un
   movimiento perdido—; lo de afuera va a un contador informativo aparte. Con ese criterio los tres deberían
   dar 0 y ahí sí se puede exigir.
3. **Galicia no captura `conceptoBanco`** (`con conceptoBanco=0`): el adaptador nunca se actualizó a E4 — se
   les avisó a los dos agentes que escribían adaptadores nuevos y no a él. **Y sus 326 filas ya están en la
   base del piloto con `concepto_banco = null`**, o sea que es reproceso, que es justo lo que E4 existía para
   evitar.
4. **A Macro le faltan 160 conceptos**, no 76 como se había previsto (`1186 de 1346`). Pista, no conclusión:
   `07` §7 midió **exactamente 160 filas con un solo fragmento de glosa**. Si son las mismas, el problema es
   dónde corta y no qué literales faltan. **No es un defecto: es la medida del hueco de vocabulario**, que es
   el insumo de la planilla para la contadora.
5. **Macro emite 3 de 6 anexos**: los tres `TOTAL COBRADO` (uno por cuenta) sí, los tres `D. 409/2018` no —
   su atribución es 0/2/1 y con el modelo viejo habría tenido que inventar la cuenta. **Con la `0008`
   colgando del lote ya se pueden capturar** con `atribucion_cuenta = no_determinada`.

**Un número para mirar, de baja prioridad:** la distribución de líneas de glosa de Galicia da
`1→64 2→28 3→115 4→9 5→109 7→1` (suma 326) y la medición inicial de `01` §2.2 decía
`{1:64, 3:27, 4:114, 5:9, 6:111, 8:1}` (también 326). Corridas por uno y con dos movimientos de diferencia
en tres baldes. Puede ser que las dos mediciones cuenten cosas distintas —líneas de texto vs. fragmentos de
glosa— pero es **el único número que no coincide exacto**, y es sobre la glosa, que es el producto.

### Lo demás que se hizo en esta entrada

- **E1.1, PARCIAL**: `EST_CUENTAS_NO_COINCIDEN` (con el test que muestra que el consolidado **cuadra igual**
  cuando se pierde una cuenta en `0,00`), `CAMPOS_DIFERENCIA` como enum cerrado, la guarda importe≠saldo de
  `parDeColumnas`, el contrato de `seccionesPorClave`, y la flag `y` que se escapaba de `.replace('g','')`.
  🔴 **En la entrada anterior escribí "E1.1 cerrado, los 14 puntos del panel" y era falso: eran cinco.** Lo
  detectó `documentador` verificando contra el código en vez de contra el documento. Corregido en `08` §3 con
  la lista de lo hecho y lo pendiente. Una tabla mal marcada es peor que una tabla larga: a lo que dice
  "cerrado" nadie vuelve.
- **E4 (`0007`)**: `concepto_banco` (N2), `concepto_completo` (N1), `concepto_banco_estrategia` (N1) y
  **`pagina_pdf`** —que estaba en el esquema y no se persistía—, con **INV-14 como `check` en la base**:
  `concepto_banco` tiene que ser **prefijo de `descripcion`**, así hereda la garantía de INV-13 por
  construcción y la tabla no pasa al régimen de lectura auditada.
- **`0008_anexos.sql`**: cuelga del **lote** con `cuenta_bancaria_id` nullable y `atribucion_cuenta`, porque
  la atribución del anexo a su cuenta **no es posicional en ninguno de los tres bancos**. Con
  `relacion_con_movimientos`, *"prohibido que entre en la suma"* deja de ser una prohibición no verificable y
  pasa a ser una condición sobre una columna (**INV-15**).
- **Colisión de exports encontrada por el adaptador de Macro:** dos `export *` de adaptadores chocan en
  `BANCO_CODIGO`/`VERSION` y **ESM omite el símbolo en silencio**. El índice pasó a exports por nombre.
- **E-1 ampliada y confirmada** por el titular el 2026-08-10: la excepción cubre a **todos los titulares** del
  material. Con sus tres controles nuevos y la condición de cierre (demo → prod arranca de cero).

### Lo que sigue

Los tres adaptadores leen bien. Lo pendiente es de **integración**, no de parseo: unificar y cablear
`lineasNoInterpretadas`, poner E4 en Galicia (y reprocesar sus 326), capturar los `D. 409/2018` con la tabla
nueva, escribir `persistirAnexos` + el test canario de INV-15, y medir los 160 conceptos de Macro para la
planilla de vocabulario de la contadora.

---

## 2026-08-10 (11) — El panel revisó E1 y encontró **seis bloqueantes**. Corregidos. Y se corrigió el alcance de E-1.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **412 tests + 4 todo**, y ahora `apps/`
**sí se typechequea**. **Sin commits.**

### Lo primero, porque es de proceso

**E1 se había hecho sin convocar a nadie.** La matriz de `agents/README.md` dice `seguridad-datos-financieros`
**obligatorio** ante datos de clientes o aislamiento, y `code-reviewer` antes de mergear, `tester` antes del
"Done". No se convocó a ninguno. Se convocaron después, sobre lo ya escrito, y **encontraron seis bloqueantes
con el gate en verde**.

⚠️ **Los wrappers de `.claude/agents/` NO están registrados como sub-agentes en la sesión.** El harness solo
expone los built-in (`Agent type 'code-reviewer' not found`). Se resolvió con el mecanismo portable que el
propio proyecto diseñó: **adopción de persona** (`agents/README.md`, el protocolo de Codex) — un agente
genérico que lee `agents/personas/<x>.md` completo y actúa con ese rol. Funciona igual. **Para que los
wrappers se registren hace falta reiniciar Claude Code** (o revisar `/agents`).

### Los seis bloqueantes, todos corregidos

| # | Qué | Cómo se veía | Fix |
|---|---|---|---|
| 1 | 🔴 **`estadoSegunVerificacion` persistía una cuenta con la verificación en `no_cuadra`** | El bloque de la cuenta vacía **retornaba antes del `switch`**. Una cuenta vacía con saldo inicial ≠ saldo final —el síntoma de que el parser perdió sus movimientos— se persistía con el lote en verde. Y `EST_SIN_MOVIMIENTOS` se había bajado a observación en el mismo cambio: **las dos redes se retiraron juntas** | Se exige `estado !== 'no_cuadra'`; si no, rechazo con el código de la diferencia |
| 2 | 🔴 **`apps/` estaba fuera del `include` de `tsconfig.json`** | Todo el cableado del CLI —el pipeline de once pasos, INV-6, INV-multicuenta— **nunca pasó por `tsc`**. Vitest corre `apps/*/tests` pero no typechequea: el gate verde no significaba lo que parecía. Al agregarlo aparecieron **dos errores reales** | `apps/` y `tools/` agregados |
| 3 | 🔴 **`alFecha: string \| undefined`** en la llamada a INV-6 | `periodoHasta` es opcional y **puede faltar de verdad**. El `undefined` llegaba a la consulta → cero candidatas → el operador recibía **`cuenta_no_pertenece_al_cliente`**, el mensaje más grave del módulo, por un problema de parseo de carátula | Guard previo con motivo propio `cuenta_sin_periodo` |
| 4 | 🔴 **INV-multicuenta se apagaba en silencio** si el adaptador devolvía la lista vacía | "El banco no lo publica" y "el parser de carátula falló" se veían **igual**. En el banco donde más falta hace, el literal viene con **dos espaciados distintos en el mismo archivo**: un regex que falle desactiva el único control que ve una mezcla, y el lote pasa con 1 ruptura sobre 1346 | Capacidad `traeConsolidadoPorMoneda` + `consolidado_no_encontrado` como **error**. Mismo precedente que `traeTotalesDeclarados` |
| 5 | 🔴 **`fragmentosEnBanda` tenía los dos extremos cerrados** | Con las coordenadas **que publica la especificación** (`70.8`, `264.0`) metía **las 1221 referencias adentro de la glosa**. Los tests no lo veían porque usaban `263.5`, un colchón inventado por mí: el borde nunca se ejercitaba | La banda es `[desde, hasta)`. Un test por extremo, con las coordenadas literales del documento |
| 6 | 🟠 **`habilitaPersistir` vs `estadoSegunVerificacion`**: dos criterios, contestando distinto | Para la cuenta vacía una decía `true` y la otra `false`. `habilitaPersistir` no la usaba nadie en producción, solo los tests | **Borrada.** El criterio vive en un solo lugar, que es lo que su propio comentario dice |

**Tres agentes convergieron independientemente en el nº 1.** Se reprodujo antes de aceptarlo:
`estado verificacion: no_cuadra` → `estadoSegunVerificacion: {"persistir":true}`.

### Lo que el panel confirmó que está bien

`hashesDeCuenta`, `U$S` (incluida la decisión de **no** agregar `US$` sin medirlo), `periodoPorEtiquetas`, la
semántica de bordes de `regionesDeTabla`, y —de `seguridad-datos-financieros`— que **E1 no rompe el
aislamiento entre clientes ni filtra un valor a un log hoy**. Los fixtures de `multibanco.test.ts` no traen
valores del material real (revisión independiente, además del barrido).

### Lo que queda abierto: **`08` §3, sección E1.1**

14 hallazgos priorizados. Los tres que más pesan:

1. **`EST_CUENTAS_NO_COINCIDEN`** — es el único agujero de mezcla que INV-multicuenta **no puede** ver: una
   cuenta con saldo final `0,00` cuya sección nunca se abre **desaparece del sistema y todo cierra**. La
   verificación está medida y escrita en `07` §14.2 y no existe en el código.
2. **`Diferencia.campo` es `z.string()` abierto** y sale a tres canales, uno de ellos una columna clasificada
   **N1** cuya nota dice *"ninguna diferencia lleva un valor"*. Hoy eso es cierto **por convención, no por el
   tipo**.
3. **El CLI usa el `logger` genérico** teniendo `loggerAcotado` escrito, y `consolidado`/`saldo_consolidado`
   no están en ninguna lista del redactor — y el importe canónico (`-98765.43`) **no lo tapa ningún detector**.

### El alcance de E-1, corregido

`docs/seguridad/registro-excepciones.md` decía *"un cliente del estudio, 8 bancos, período 06/2026"*. **Las
tres partes estaban mal**: son **varios clientes distintos** (por el CUIT de cada carátula), **cuántos no se
sabe**, y los períodos son **heterogéneos** (Macro es 11-2025). Se corrigió la fila, se agregó la sección de
corrección, y **tres controles nuevos** (6, 7 y 8): un tenant por titular sin excepción, identificador
provisorio opaco, e INV-6 probado con el cruce real.

🔴 **Decisión pendiente del titular, y es previa a cualquier ingesta de un segundo titular:** la autorización
registrada se dio sobre *"el cliente piloto"*. Esto son varios titulares que no son ese cliente. **No es
reversible**: `on delete restrict` + `acceso_auditoria` append-only sin `grant delete` significan que "después
lo borramos" no está disponible. Mientras tanto el material **se lee para medir formato** —que es lo que se
viene haciendo— pero **no se ingesta un segundo titular a la base del piloto**.

### El modelo del cliente provisorio (diseñado, no aplicado)

`plan-cuentas-multicliente` entregó el diseño. Lo esencial, en tres puntos:

- **El tenant no es la identidad: es el `uuid`.** `fila_hash`, `archivo_hash`, las FK compuestas, el prefijo
  `cliente/<uuid>/` en storage y `acceso_auditoria` cuelgan del uuid y **ninguno contiene la identidad del
  titular**. O sea que **no falta un dato para crear el tenant**: falta la *etiqueta*. El uuid que se asigna
  hoy es el definitivo.
- **De provisorio a real se RENOMBRA**, y es la única de las tres opciones con costo cero: `cliente_id` no
  cambia, así que no se toca ni una fila de dominio. Migrar exige `BYPASSRLS` sobre FK no deferrables, deja el
  objeto en el prefijo viejo (un `UPDATE` no mueve un `PUT`) y **parte el rastro append-only en dos
  titulares**; re-ingestar duplica el PDF y deja residuo imborrable. ADR-0001 §3 ya lo había previsto: el
  segmento del path es `nid`, no el nombre.
- **Un tenant por titular** (agrupados por HMAC del CUIT de carátula, con pepper, sin escribir el CUIT en
  ningún lado), todos colgando del mismo estudio. **Ante la duda: sobre-partir, nunca unir.**

**Falta una pieza que no existe:** hoy **no hay forma soportada de crear un nodo `cliente`** en la base del
piloto — los dos `insert into tenant_node` del repo están en `sembrar.ts` (que arranca con `truncate` de once
tablas) y en `tests/ayuda.ts`. Hace falta `pnpm alta:cliente`, con la forma de `alta-cuenta.ts`.

**Y una trampa de orden, medida:** `alta-cuenta.ts` pone `vigente_desde = periodo.desde` **del PDF que se le
pasa**. Con períodos heterogéneos, dar de alta con el de 06/2026 y después ingestar el de 11-2025 devuelve
`cuenta_no_registrada` **con la cuenta ya cargada**. La regla: **el alta de cada cuenta se hace con el
extracto más viejo de esa cuenta.**

### Lo que sigue

**E1.1** (`08` §3), empezando por `EST_CUENTAS_NO_COINCIDEN` y el cierre de `Diferencia.campo`. Después E2.

---

## 2026-08-10 (10) — **E1 cerrado**: las 10 piezas que Macro y Santander expusieron, con 57 tests nuevos

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **403 tests + 4 todo**, 19 archivos (antes
346). **Sin commits.**

> El punto de entrada sin contexto sigue siendo **`docs/diseno/08-plan-de-construccion.md`**, ya actualizado:
> E1 figura cerrado con dónde quedó cada pieza, y **E2 (tests del adaptador de Galicia) es lo que sigue**.

### Qué se hizo

Las **10 piezas de E1**, ninguna postergada. Todas nacieron del mismo modo de falla medido: **producen un
resultado plausible y equivocado** — los importes cuadran, la cadena de saldos cierra, el lote dice
`procesado`, y el dato está mal.

| # | Pieza | Archivo |
|---|---|---|
| 1 | `fragmentosEnBanda` | `packages/ingesta/src/texto-pdf.ts` |
| 2 | `verificarConsolidadoPorMoneda` (INV-multicuenta) + `EST_CONSOLIDADO_MONEDA` + `consolidadosPorMoneda` | `verificacion/invariantes.ts`, `esquema.ts`, `adaptadores/registro.ts`, `apps/cli/src/ingestar.ts` |
| 3 | `seccionesPorClave` | `adaptadores/toolkit.ts` |
| 4 | `regionesDeTabla` + `dentroDeAlgunaRegion` | `adaptadores/toolkit.ts` |
| 5 | `parDeColumnas` con `traeSignoEnElImporte` | `adaptadores/toolkit.ts` |
| 6 | `periodoPorEtiquetas` | `adaptadores/toolkit.ts` |
| 7 | `U$S` en `importeACentavos` (`RE_SIMBOLO_MONEDA`) | `parseo-ar.ts` |
| 8 | `EST_SIN_MOVIMIENTOS` **por archivo** | `invariantes.ts` + `persistir.ts` + CLI |
| 9 | Capacidad `traeMovimientosFueraDelPeriodo` | `esquema.ts` + `invariantes.ts` |
| 10 | `hashesDeCuenta` | `hash.ts` (y `galicia.ts` lo usa) |

Tests: **`packages/ingesta/tests/multibanco.test.ts`** (41, nuevo) y **`verificacion.test.ts`** (+16).

### Las cuatro decisiones que quedan escritas, no re-discutibles

1. **`EST_SIN_MOVIMIENTOS` es POR ARCHIVO** (la recomendación abierta en `06` §11.7, ahora decidida). Una
   cuenta vacía dentro de un lote que sí trajo movimientos es **observación**, y **se persiste** con cero
   movimientos. Guardarla no es completitud: **su saldo final declarado es lo que INV-multicuenta necesita**
   para que la suma por moneda cierre. Sin el dato del lote se conserva la regla estricta — el default falla
   del lado seguro.
2. **Las invariantes que un banco falsifica se DECLARAN, no se relajan.** "Toda fecha cae dentro del período"
   es falsa en Macro (4 movimientos de octubre en un resumen de noviembre) y verdadera en el resto. Se agregó
   la capacidad `traeMovimientosFueraDelPeriodo`, que baja la diferencia a **observación** sin hacerla
   desaparecer: sigue en `verificacion_detalle` con su número de fila y `fechasDentroDelPeriodo` sigue en
   `false`. Relajarla para todos habría apagado el control donde sí sirve.
3. **INV-multicuenta rechaza el LOTE, y corre antes de persistir una sola fila.** Una mezcla de cuentas no se
   arregla descartando una fila: si el reparto está mal, **todas** las filas están atribuidas a la cuenta
   equivocada. Motivo nuevo: `consolidado_no_cuadra`.
4. **Los tres modos de "no puedo compararlo" de INV-multicuenta son `error`, no observación**
   (`saldo_final_ausente`, `moneda_sin_cuenta`, `moneda_sin_consolidado`). La tentación es marcarlos como
   atenuante y es al revés: el valor entero de la invariante es detectar que **falta una cuenta**, así que
   "falta el dato para compararla" es el síntoma, no la excusa.

### Dos cosas que salieron de escribirlo

- **`ParDeFila` estaba declarado dos veces** (galicia y toolkit) y `index.ts` re-exporta los dos módulos con
  `export *`. Galicia ahora **importa el tipo** del toolkit; su `leerPar` no se tocó.
- **El primer test de la cuenta vacía falló, y tenía razón.** `{...BASE, movimientos: []}` conserva los
  totales declarados de las 40 filas del fixture, así que daba `no_cuadra` por `ARIT_TOTAL_CREDITOS` — un
  rojo que no tenía nada que ver con lo que el test probaba. Se escribió a mano una cuenta vacía **con la
  forma real** (saldo inicial = saldo final, sin totales declarados). Queda anotado en el propio test: un
  fixture incoherente empuja a relajar el verificador.

### Lo que NO se tocó, a propósito

- **`galicia.ts` no migró a `parDeColumnas`.** La lógica es la misma salvo un detalle (token en las dos
  columnas: allá gana el crédito, acá es `null`) y sobre el archivo real da idéntico. Pero **lo único que
  respalda hoy a ese adaptador es una corrida contra un archivo que el gate no puede abrir**. La migración es
  condición de salida de **E2**, con los tests puestos. Está anotado en el docblock de `leerPar`.
- **`inferirCortes` / `cortarEnColumnas` siguen ahí**, con cero usuarios en los tres bancos. Se borran con el
  **cuarto**: borrar sobre tres es una conclusión, borrar sobre uno era una corazonada.
- **El camino `consolidado_no_cuadra` del CLI no tiene test de integración**: hoy ningún adaptador emite
  consolidados (Galicia no los publica), así que el camino está inerte. La lógica sí está cubierta con 9
  tests unitarios. Se cierra en **E3**, con el adaptador de Macro.

### Lo que sigue, en una línea

**E2**: los tests del adaptador de Galicia, que hoy funciona sin uno solo propio, más las cuatro mutaciones de
texto que están en `it.todo`. **Después** E3, los adaptadores de Santander y Macro, que son los que van a
ejercitar de verdad las diez piezas de E1.

---

## 2026-08-10 (9) — **PUNTO DE ENTRADA PARA RETOMAR SIN CONTEXTO.** Tres bancos medidos, arquitectura decidida.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **346 tests + 4 todo**. Los 326 movimientos
de Galicia persistidos en la base del piloto. **Sin commits.**

> **Si retomás sin el contexto de la conversación, leé `docs/diseno/08-plan-de-construccion.md`.** Es el punto
> de entrada: dice qué está hecho, qué está decidido, qué está abierto y en qué orden construir. Esta entrada
> es el resumen; ese documento es el mapa.

### Los documentos, y qué contiene cada uno

| Documento | Qué es |
|---|---|
| **`08-plan-de-construccion.md`** | 🔴 **Empezar acá.** Arquitectura decidida, estado del código, orden de construcción E1–E6, decisiones tomadas, preguntas para la contadora, deuda de seguridad, limpieza |
| `01-modulo-1-ingesta-bancaria.md` | El plan del Módulo 1 y sus 12 condiciones de salida (cerradas) |
| `02-formato-galicia.md` | Spec de Galicia — 326 movimientos, 17 trampas |
| `03-hallazgos-del-panel.md` | Los 4 informes del primer panel: seguridad, verificación, Módulo 2. Y §3.4.bis con la corrección del supuesto del código de concepto |
| `04-imputacion-contable.md` | El modelo de imputación desde las 14 reglas reales de la contadora |
| `05-motor-de-reconocimiento.md` | El motor de reconocimiento de tipo, con el léxico por banco |
| **`06-formato-santander.md`** | Spec de Santander — 158 movimientos, 2 cuentas |
| **`07-formato-macro.md`** | Spec de Macro — 1346 movimientos, **3 cuentas con transferencias entre ellas** |

### La arquitectura, en cuatro líneas

```
POR BANCO  1. Extracción y parseo del PDF        adaptadores/<banco>.ts
           ───────────── se persiste el extracto ─────────────
POR BANCO  2. Léxico: TEXTO del banco → concepto canónico     lexico/<banco>.ts  (DATOS)
ÚNICO      3. Catálogo: concepto → tipo de movimiento
ÚNICO      4. Imputación: (tipo, columnaOrigen) → cuenta del plan del cliente
```

**Duplicar lo que depende del banco es sano —aísla fallas—; duplicar lo que depende del criterio de la
contadora es peligroso —multiplica los lugares donde su decisión queda desactualizada.**

Evidencia medida de por qué la capa 2 es por banco: el impuesto a los débitos y créditos aparece como
`IMP. DEB. LEY 25413 GRAL.` **y** `IMPUESTO DEB.LEY 25413` (Galicia), `Impuesto ley 25.413 debito 0,6%`
(Santander), `N/D DBCR 25413 S/DB TASA GRAL` (Macro). **Tres bancos, cuatro grafías, un solo hecho.**

### La arquitectura por banco, validada con tres bancos

- Los **tres** necesitan la vista **geométrica**, por razones distintas: orden del content-stream (Galicia),
  y **el signo solo está en la columna** (Santander y Macro).
- `texto-pdf.ts`, `parseo-ar.ts`, `verificarAritmetica` y el pipeline de controles: **los tres sin modificar**.
- **`inferirCortes` sigue en CERO usuarios en los tres.** Ninguno tiene columnas de ancho fijo en caracteres:
  `pdf.js` emite un espacio por hueco. Borrar al confirmar con el cuarto banco.
- De las 5 piezas que le faltaron a Santander, **4 son genéricas**. Ese reparto es lo que valida la apuesta.

### Los tres hallazgos que cambian decisiones

1. 🔴 **Mezclar las cuentas de Macro da 1 ruptura sobre 1346 = 0,07 %.** Pasa cualquier umbral, "casi cuadra",
   y produce una cuenta inexistente con dos saldos encimados. **El único control que lo detecta** es el
   consolidado por moneda de la carátula contra la suma de los saldos finales — no tiene equivalente en Galicia
   y hay que agregarlo como invariante.
2. 🔴 **La regla 10 (transferencias entre cuentas propias) se reconoce por el PAR DE CONCEPTOS, no por
   importe+fecha+signo.** Ese criterio devuelve 5 pares en Macro y **2 son falsos positivos**: dos importes
   redondos que coinciden el mismo día. Con el criterio al revés se imputan como movimientos con terceros dos
   operaciones legítimas, **y el asiento cuadra igual**.
3. 🔴 **En Santander y Macro el importe NO lleva signo.** Copiar `leerPar()` de Galicia —que exige que el signo
   del token coincida con la columna— da **0 movimientos**.

### Corrección a un dato que quedó mal antes

Dije que solo Galicia tenía código de concepto. **Santander también**: su `.xls` es un **TSV en Latin-1
renombrado** con una columna `Cod. Operativo`, **29 códigos para 29 conceptos**. No se detectó antes porque
`exceljs` no lee ese formato. Son **2 de 5**, no 1 de 5 — y para Credicoop y Macro sigue sin medirse (sus `.xls`
son BIFF y no hay lector).

### Lo que se hizo en esta entrada

- **Se persistieron las especificaciones de Santander y Macro** (`06`, `07`), que solo existían en el contexto
  de la conversación. Cuestan ~20 min de medición cada una.
- **Se escribió `08-plan-de-construccion.md`** como punto de entrada sin contexto.
- **Multi-cuenta cableado en el CLI**: los pasos 8–10 corren **por cuenta** (INV-6 por cuenta, verificación por
  cuenta, y el veredicto del lote es el peor de sus cuentas). Antes hacía `cuentas[0]` y con Macro habría
  persistido la primera y descartado las otras dos **en silencio**.
- **Dos reglas de código nuevas**: ningún adaptador importa a otro, y ninguno importa `data` ni
  `almacenamiento`.
- **Advertencia medida en el toolkit**: un solo banco escrito, importa una función, seis exportaciones en cero.
  Con la regla: **el segundo y el tercer banco deciden qué sobrevive**.
- Se borraron los 15 scripts de análisis descartables (su contenido está en `02`, `06` y `07`). Se conservó
  `probar-galicia.ts`, que es la corrida de verificación con salida sin valores.

### Lo que sigue, en una línea

**E1 de `08` §3**: las 10 piezas que Macro y Santander expusieron, empezando por `fragmentosEnBanda` (sin ella
1186 de 1346 descripciones de Macro salen truncadas) y el `INV-multicuenta`. **Después** los tests del adaptador
de Galicia, que hoy funciona sin un solo test propio. **Recién después** los dos adaptadores nuevos.

**El motor de reconocimiento no arranca sin las 7 respuestas de `08` §5**, empezando por qué es
`ACREDITAMIENTO` — 78 movimientos, el concepto más frecuente del extracto de Galicia.

**Ojo con la base:** el piloto es `sistema_contable_piloto` (`ENV_FILE=.env.piloto`). `pnpm test` corre contra
la local de siempre y **aborta** si detecta lotes cargados.

---

## 2026-08-10 (8) — Galicia end-to-end: **326 movimientos persistidos**. Y un supuesto falsificado que rehizo el diseño del Módulo 2.

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **344 tests + 4 todo**. Los 326 movimientos
del extracto real en la base del piloto, verificación `cuadra`. **Sin commits.**

### 1. Lo que corrió de punta a punta

```
ingesta.parseada      filas_leidas=326  paginas=26  lineas_no_interpretadas=47
ingesta.verificada    verificacion_estado=cuadra   filas_con_ruptura=0
ingesta.persistida    filas_insertadas=326  estado=procesado
```

En la base: 326 movimientos, 326 filas crudas en la satélite, 326 hashes distintos, 14 en descubierto,
verificación `cuadra`, idempotencia confirmada (segunda corrida → `ya_procesado`). El objeto se escribió
**último**, después de que las filas entraron.

Todos los números coinciden con la especificación medida: 326 filas, 116 créditos, 210 débitos, 14 saldos
negativos, 21 con referencia, 0 rupturas, 25 páginas declaradas.

**Infraestructura del piloto:** base separada `sistema_contable_piloto` con `APP_ENTORNO=piloto` y
`.env.piloto` (gitignoreado). **Los tests truncan `tenant_node`**, así que compartir base habría borrado el
material real y su rastro de auditoría — hay guard en los dos lados. Excepción **E-1** registrada en
`docs/seguridad/registro-excepciones.md` con la autorización del titular y de la contadora. Pepper propio
generado (el de `.env.example` es público y no protege nada; hay guard que aborta).

### 2. Bugs corregidos en esta tanda

| # | Bug | Cómo se encontró |
|---|---|---|
| 1 | **El autómata del adaptador cerraba el movimiento antes de leer la glosa.** En la vista geométrica el par `(importe, saldo)` está en la **misma fila que la fecha**, no después: cerrar al verlo descartaba las continuaciones. **777 líneas perdidas con los 326 movimientos correctos** — §6.4 literal | corriendo contra el archivo real |
| 2 | **`importeACentavos` usado sobre valores ya canónicos.** Las dos funciones son inversas de `centavosAImporte` en dominios distintos y confundirlas **no da error de tipos**. Explicaba las tres fallas restantes: los 14 saldos en descubierto leídos como positivos, `ARIT_SALDO_INICIAL` y `ARIT_SALDO_FINAL` | ídem |
| 3 | **`extraerPeriodo` rechazaba el caso real.** Yo había puesto un control de "período invertido = parseo mal hecho" y el banco emite las fechas en orden `[hasta, desde]`: el control rechazaba lo normal y la vigencia caía a un fallback inventado. Ahora min/max, y **el fallback no existe** | el alta imprimió `2000-01-01` |
| 4 | **El CLI nunca cargaba el `.env`.** Funcionaba **solo en tests**, donde vitest lo carga. La peor forma de estar roto: quien lo corre a mano concluye que el problema es su máquina | corriendo el CLI |
| 5 | **Un archivo que no es un PDF lanzaba** en vez de rechazar con código: el lote quedaba en `recibido` **sin motivo**, o sea sin nadie mirándolo | los tests del CLI |
| 6 | **Ciclo de paquetes** `data → ingesta → data`: el typecheck lo aceptaba. El script de alta se movió a `apps/cli` y hay **regla de código** que lo prohíbe | typecheck |
| 7 | El logger tipado **rechazó mi propia línea de log** con `cbu_ultimos4`: es N2 y no va a un log ni en su forma parcial | typecheck |

### 3. 🔴 El supuesto que se cayó, y por qué importa

Se afirmó —yo— que **"el código de concepto está en el Excel"** y se estuvo a punto de diseñar la imputación
contable sobre eso. **Se midió y es falso.** De los cinco bancos que entregan planilla, **solo Galicia trae
código**; tres de los ocho no entregan planilla; y hay **cuatro tecnologías** distintas detrás de la palabra
"Excel" (`.xlsx` ZIP, `.xls` BIFF, texto renombrado, HTML renombrado).

Corregido en `03-hallazgos-del-panel.md` §3.4.bis y en el plan §3.3.

**El rediseño está en dos documentos nuevos**, con el equipo convocado sobre las **14 reglas reales** de la
contadora (`privado/…/leer bancos.txt`) en vez del código de concepto:

- **`docs/diseno/04-imputacion-contable.md`** — el modelo de imputación
- **`docs/diseno/05-motor-de-reconocimiento.md`** — el motor de reconocimiento de tipo

### 4. Los cinco hallazgos del rediseño que cambian decisiones

1. **La separación son cinco capas, no dos.** La que faltaba: **resolución de contrapartida** (padrones). Tres
   de las 14 reglas —las de mayor volumen— no fallan por reconocimiento sino porque **falta un padrón**. Y la
   prueba: **Galicia trae código de concepto y esas reglas siguen indecidibles con él.**
2. **`lado = columnaOrigen === 'credito' ? 'haber' : 'debe'`** para todo renglón con una sola contrapartida.
   **La tabla de imputación guarda CUENTAS, nunca lados.** Se recorrieron las 14 reglas y no hay una sola
   excepción: las reglas 8 y 9 son la prueba —misma cuenta, los dos lados, y el lado sale de la columna. Con eso
   **la inversión de signo deja de ser posible por construcción**.
3. **Los 14 tipos NO cubren el material del piloto.** Medido en la base: **14 movimientos de FCI**, **6 de
   percepción de IVA** y **11 de compra con débito** no entran en ninguna de las 14 reglas. El motor tiene que
   poder decir *"reconozco el concepto y no tengo tipo para él"* — que es distinto de *"no reconozco el
   concepto"*. El primero es un **hueco de producto**; el segundo, un literal nuevo.
4. **Cuatro de los 14 tipos tienen CERO evidencia** en el vocabulario medido (intereses de financiación,
   SIRCREB, depósitos en efectivo, cheque rechazado). **No se pueden escribir hoy** sin inventar vocabulario.
5. **El anexo del banco es un set etiquetado POR EL BANCO** para dos tipos: la suma de lo reconocido como
   impuesto ley 25.413 sobre débitos tiene que igualar el total que el banco publica en el anexo. **Es la
   verificación más fuerte disponible y no necesita ni una etiqueta humana.** Exige la tabla de anexos, que hoy
   no existe.

### 5. 🔴 Tres cosas que hay que preguntarle a la contadora antes de escribir el motor

1. **¿Qué es `ACREDITAMIENTO`?** **78 movimientos, todos crédito** — el concepto más frecuente del extracto
   (medido en la base). Si es acreditación de adquirente —y en el mismo vocabulario está
   `ANULAC. ACRED. FIRSTDATA.`— entonces **78 movimientos van a decisión humana** por falta de la liquidación
   del adquirente, y eso cambia todo el volumen del piloto.
2. **Tarjetas: ¿"Deudores por ventas" o "Tarjeta de crédito a cobrar"?** Dijo las dos cosas en documentos
   distintos y el diseño difiere: con cuenta separada el residuo del neteo queda **aislado y reconciliable**;
   dentro de Deudores se disuelve entre las cobranzas y **no se detecta nunca**.
3. **¿Sus clientes llevan circuito de valores** (cheques a pagar / en cartera)? De eso depende que las reglas
   12c, 13c y 14 estén bien o **dupliquen la cancelación**.

Más: **etiquetar el corpus de vocabulario** (32 literales de Galicia + los de Santander, `literal → tipo`). Es
el único insumo humano que el motor necesita para ser verificable, **y no son datos de sus clientes**: son las
etiquetas que imprime el banco.

Y una decisión que le corresponde al titular: **la regla 11 hay que advertirla aunque ella no lo pidió**. Su
simplificación es sobre **la cuenta** (legítima, se respeta); el problema es el **importe**: el neto omite el
arancel, su IVA y las retenciones. Son plata, y el asiento cuadra igual.

### 6. Lo que sigue, en orden

1. **Tests del adaptador contra el fixture sintético.** Hoy el adaptador funciona contra el archivo real y
   **no tiene un solo test propio** — al revés de como debería ser. Con las cuatro mutaciones de texto, que
   ahora sí tienen sujeto.
2. **Los campos que son reproceso si se agregan después** (`04` §9 y `05` §9). Los dos más urgentes:
   **`conceptoBanco` no se persiste** (el esquema Zod lo tiene, la migración `0004` no) y
   **`conceptoCompleto`** — `ACREDITAMIENTO` tiene 14 caracteres y **no se puede saber si está truncado**; el
   ancho de la columna es un hecho del parseo y **no es reconstruible después**. Más la tabla de **anexos**.
3. **El lector de Excel y el cruce PDF↔Excel.** La clave **no puede ser `(fecha, importe)`** (7 grupos con 19
   filas repetidas): tiene que ser `(fecha, importe, saldo)`, único 326/326.
4. **El segundo banco (Santander).** Es la prueba real de si el toolkit sirve: si sale en un archivo chico, la
   apuesta era correcta; si hay que reescribir el pipeline, está mal factorizado — y es mejor saberlo con dos
   bancos que con ocho.
5. Recién después, el motor de reconocimiento — **con las respuestas de §5 en mano.**

**Ojo:** la base del piloto es `sistema_contable_piloto` (`ENV_FILE=.env.piloto`). `pnpm test` corre contra la
base local de siempre y **aborta** si detecta lotes cargados.

---

## 2026-08-10 (7) — Panel de 4 agentes + toolkit del adaptador. **9 bugs propios corregidos.**

**Herramienta:** Claude Code, sesión autónoma. **Estado:** `pnpm verificar` verde — **340 tests + 4 todo**
(18 archivos), los 18 invariantes SQL con las tres credenciales, gate de fixtures 7/7, barrido verde en los
dos modos. **Sin commits.**

**El adaptador de Galicia NO está escrito, y es a propósito.** El panel encontró que faltan piezas que van
antes. Están abajo, y el orden está en `docs/diseno/03-hallazgos-del-panel.md` §4.

### Lo nuevo que hay para leer

| Documento | Qué tiene |
|---|---|
| **`docs/diseno/02-formato-galicia.md`** | La especificación del formato, medida sobre el archivo real y **sin un solo valor del cliente**. 326 filas, 0 rupturas de cadena, totales exactos. 17 trampas, con cuáles ya están resueltas |
| **`docs/diseno/03-hallazgos-del-panel.md`** | Los tres informes consolidados: seguridad de la primera corrida real, estrategia de verificación del adaptador, y qué capturar para el Módulo 2 |

### El hallazgo que cambia el diseño del adaptador

**El layout de Galicia NO es de ancho fijo en caracteres.** `pdf.js` emite **un espacio por hueco**, sin
importar que mida 5 pt o 236 pt. Así que `substring(i, j)` es inviable y `inferirCortes()` no sirve para ese
banco. Y el importe y el saldo **salen en una línea posterior a la fecha** en 262 de 326 filas: un parser que
asuma "una línea = un movimiento" falla en el 80 % de las filas.

De ahí **`aFilas()`** en `texto-pdf.ts`: agrupa fragmentos por coordenada `y` y expone la `x` de cada uno.
Verificado contra el PDF real: **326 filas con fecha en la columna de fecha**, que es el número esperado.

### Los 9 bugs propios, todos confirmados con una medición antes de tocar nada

| # | Bug | Dónde |
|---|---|---|
| 1 | **La glosa se comía el encabezado de la página siguiente, los totales y la carátula** — 9 de 80 filas, con el test verde porque solo contaba filas | `toolkit.ts`: `particionar()` + ruido transparente vs. de corte |
| 2 | **El generador producía un fixture incoherente** (importe positivo en la columna de débito) y la verificación decía `no_cuadra` con razón — pero por culpa del generador | `extracto-sintetico.ts`, y ahora **valida su propia salida** |
| 3 | **`glosa.ts` tomaba un importe por documento**: `1234567,89` quedaba como `[DOC],89` | `glosa.ts` |
| 4 | **`pnpm db:seed` borraba el rastro de auditoría append-only** y las 7 tablas del Módulo 1, por un `cascade` | `sembrar.ts`: enumerado, sin `cascade`, aborta fuera de `local` o con lotes cargados |
| 5 | **`extraerTexto` dejaba el buffer detachado**: la segunda llamada tiraba `TypeError` | `texto-pdf.ts` |
| 6 | **`requiereOcr` por promedio**: 10 páginas con texto y 40 escaneadas promedian por encima del umbral | `paginasSinTexto` por página |
| 7 | **Mes hardcodeado** en el generador y **página 4 declarada dos veces** | mes derivado del período; secuencia 1..8 |
| 8 | **`.env` fuera del barrido** (`extname('.env')` devuelve vacío) | `barrido-fuga.ts` |
| 9 | **Parameter properties**: `tsc` compila y Node explota al importar | 2 clases + **regla de código** que lo prohíbe |

Y **el check `tipo_cuenta` de `0004` admitía 4 valores contra los 6 del dominio**, aplastando la
`cuenta_corriente_especial` que el piloto tiene. Corregido en `0006`.

### Un hallazgo mejor de lo esperado

Al escribir el test de R28 se descubrió que **la RLS forzada suprime el `DETAIL: Failing row contains` de
Postgres**. En `banco` (sin RLS) la fila sale completa; en una tabla de dominio, no. Los siete renglones de
ADR-0001 §5 dan una defensa que nadie diseñó, y está escrito como test con la evidencia de los dos lados
(`packages/data/tests/errores-pg.test.ts`) para que nadie concluya que la RLS es opcional en una tabla
"auxiliar".

**No reemplaza al traductor de errores** (`errores-pg.ts`, nuevo): eso cubre las tablas sin RLS, el `where`, y
el hecho de que re-lanzar el error del driver arrastra `stack` y `parameters`.

### Lo nuevo en código

- **`packages/ingesta/src/adaptadores/`** — `contrato.ts` (un adaptador **no se autocertifica**, declara sus
  capacidades y nunca descarta una línea en silencio), `registro.ts` (detecta el banco por **contenido** y lo
  compara contra lo declarado; el estado `ambiguo` existe porque hay dos PDF byte-idénticos en el roster) y
  `toolkit.ts` (carátula por etiqueta, cortes inferidos, partición contada, período con fechas pegadas).
- **`packages/ingesta/src/persistir.ts`** — "todo o nada". `no_cuadra` deja cero filas. `no_verificable` da
  `procesado_con_observaciones`, que **no es** `procesado`.
- **`packages/data/src/db/errores-pg.ts`** — traductor de errores de Postgres (R28).
- **`texto-pdf.ts`** — `aFilas()`, `fragmentoEnVentanaDerecha()`, `paginasSinTexto`.
- **`0006_ajustes_cuenta.sql`** — el check de `tipo_cuenta`, el check que impide guardar el CBU en `numero`
  (22 dígitos exactos = CBU), y **`pepper_id`** para poder rotar el pepper sin volver a pedir los CBU.
- **Guard del pepper**: aborta si es el valor de `.env.example` y el entorno no es `local`.

### Lo que hay que resolver ANTES de la primera corrida real (dos son tuyas)

1. **Generar un pepper propio** y ponerlo en `.env`. Va primero: recalcular `cbu_hmac` después exige el CBU en
   claro, que el sistema **no guarda**. El guard ya está, pero solo aborta fuera de `local`.
2. **Decidir el encuadre de la corrida** (hallazgos §1.1): ADR-0002 §A.1 dice que datos N2/N2-R **nunca** van a
   un entorno de prueba. Cargar el CBU real y correr el PDF contra la base local lo contradice. Hace falta
   declarar el entorno y una entrada en `docs/seguridad/registro-excepciones.md` con **quién autorizó** — eso
   es tuyo, no mío.
3. **`escribirConAuditoria`**: hoy `escritura` está en `ACCIONES` y **no se emite en ningún lugar del repo**. El
   alta de la cuenta es la fila de la que cuelga INV-6 y quedaría sin rastro.
4. **El objeto se guarda dentro de la transacción**: un fallo posterior deja el PDF huérfano en un lugar del que
   el sistema no sabe, sin listado y sin inventario. Va último, con compensación.
5. **`fila_origen` es `jsonb not null` sin forma declarada** — hace falta `filaOrigenSchema` con `.strict()`.
6. **El identificador no puede entrar por argumento del CLI**: queda en el historial de PowerShell, que está
   fuera del repo, del barrido y del `.gitignore`. Va por stdin sin eco.
7. **Ningún agente abre `privado/extractos/`.** Hay que escribirlo en `CLAUDE.md` y `AGENTS.md`: hoy la regla
   vive en el ADR, y el ADR no es lo que se lee antes de abrir un archivo.

### Y antes del adaptador

- **Los 4 detectores que las mutaciones de texto tienen que poner rojos: existen cero.** Y uno de los `it.todo`
  está **mal planteado** — dice `no_verificable` y lo correcto es `no_cuadra`.
- **Cinco agujeros donde ningún invariante ataja**: borrar una continuación de glosa, convertir una continuación
  en movimiento, correr una columna dos caracteres, borrar el encabezado de una página, duplicar la carátula.
- **Ocho rasgos que le faltan al fixture** para poder desarrollar sin mirar el archivo real, que es justo lo que
  el gate existe para evitar. Sobre todo: pares `(fecha, importe)` repetidos (7 grupos en el real, **0** en el
  fixture) y un **segundo fixture** para poder probar `reconoce()` en negativo.

### Para el Módulo 2, decidido ahora porque después es reproceso

- **La depuración de la glosa rompe 6 de las 14 reglas de la contadora** — todas las que tienen por clave un
  número. Solución sin sacrificar el aislamiento: `contraparte_documento_tipo`, `contraparte_documento_hmac`
  (mismo pepper) y `referencias[]` extraídas **antes** de depurar.
- **La regla de tarjetas queda mal igual con el código de concepto**: el importe llega **neto** y los
  componentes no están en el extracto. El plan se contradice consigo mismo; §11 es la versión correcta.
- **`saldo_es_acreedor` tiene la ambigüedad horneada en el nombre**: significa cosas opuestas según el libro, y
  mapear la palabra del banco derecho al booleano **invierte todos los saldos**. Se deriva de la cadena.
- **`knowledge/` está vacío.** Cuatro respuestas quedan en "no tengo esa fuente cargada": cómputo del crédito
  fiscal, régimen de recaudación bancaria provincial, criterio de las RT sobre imputación temporal, y no
  compensación de saldos.

**Ojo con la base local:** se aplicó `0006`.

---

## 2026-08-10 (6) — **Las 12 condiciones de salida del Módulo 1, CERRADAS**

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **277 tests + 4 todo**, 15 archivos de
test; los 18 invariantes SQL con las tres credenciales; el gate de fixtures con sus 7 chequeos.
**Sin commits.**

### Lo que se cerró en esta entrada (9, 6, 8, 10, 11)

| # | Qué | Dónde |
|---|---|---|
| 9 | `packages/almacenamiento`: `ObjectStorage` con **dos credenciales** (lectura/escritura), clave canónica, **emisor único de URL firmada** y el orden **resolver→guardar** | `src/{clave,object-storage,extracto,descarga}.ts` + 26 tests |
| 6 | **INV-6 completo**: resolvedor de cuenta por HMAC con pepper, acotado siempre al cliente declarado | `packages/ingesta/src/resolver-cuenta.ts` + 11 tests |
| 8 | **INV-13**: la glosa se depura antes de ser `descripcion` | `packages/ingesta/src/glosa.ts` + 17 tests |
| 10 | **Fixture sintético + gate de 7 chequeos**, reproducible byte a byte | `tools/{generar,verificar}-fixtures.ts` + 13 tests |
| 11 | **CLI con el guard de R18**, `--cliente` obligatorio, rechazo con `accion='rechazo'` | `apps/cli/src/ingestar.ts` + 10 tests |

### Las decisiones que hay que conocer antes de seguir

1. **El orden resolver→guardar es control de flujo, no disciplina.** No existe una función `guardar` para
   extractos: la única forma es `guardarExtractoTrasResolver(storage, pedido, resolver)`, que **recibe el
   resolvedor y lo ejecuta ella misma**. Guardar primero "para no perder el archivo" escribe el PDF de un
   cliente bajo el prefijo de otro, y a partir de ahí el socio del cliente equivocado se lo baja
   **legítimamente**, con auditoría normal y sin que nada falle.
2. **La clave del objeto lleva el id del LOTE, nunca el hash del contenido.** Una clave derivada del
   contenido vuelve al storage un oráculo de "¿tenés este archivo exacto?".
3. **`administrativo` puede ingestar y NO puede descargar.** Es H-8 literal. Y el `auditor` tampoco:
   verifica que el proceso ocurrió sin necesitar el documento.
4. **La resolución NUNCA pregunta "¿de quién es este CBU?"** — requeriría saltear la RLS y sería un oráculo
   cross-tenant. Va siempre acotada al cliente declarado, y por eso el rechazo **no puede decir** de quién
   es la cuenta (hay un test que verifica que el uuid del otro cliente no aparezca en el resultado).
5. **`cuenta_no_registrada` exige alta por una persona.** Si el archivo pudiera crear la cuenta, el archivo
   definiría la verdad y el control sería tautológico: todo extracto resolvería siempre.
6. **INV-13 es lo que SOSTIENE que `descripcion` sea N2.** Si la glosa conserva el CUIT de una contraparte,
   el dato es de un tercero que nunca consintió nada —o sea N2R— y leer movimientos tendría que pasar por el
   lector auditado. Los identificadores se extraen a la satélite; el **nombre propio se conserva a
   propósito**, porque es lo que el contador necesita para clasificar.
7. **El TTL de la URL firmada tiene tope DURO de 300 s**: se recorta, no se confía en el llamador.

### Los seis hallazgos, ninguno encontrado por una revisión

Están en el plan §10.1 con detalle. El más grave: **la trampa de `for all`** — las policies permisivas de
Postgres se combinan con `OR` y `for all` incluye `SELECT`, así que la policy de escritura de
`movimiento_origen_crudo` (que admite al administrativo porque ingestar es su trabajo) **anulaba** la de
lectura restringida. El control se veía correcto en la migración y no existía en la base. Los otros cinco:
el barrido ciego que daba verde, `LECTORES_AUDITADOS` con strings a un archivo inexistente, `ACCIONES` vs.
el check constraint divergiendo, el CBU truncado por el ancho de columna que ningún patrón reconocía, y el
fixture con fechas desordenadas que habría hecho fallar V7 por culpa del fixture.

### Lo que NO está, dicho explícitamente

- **Ningún adapter de banco.** El CLI rechaza con `adapter_no_disponible` **y lo dice**. Guardar el archivo
  y dejar el lote en `procesado` con cero movimientos sería el peor modo de falla: un lote que nadie
  vuelve a mirar.
- Las **4 mutaciones de texto** siguen `it.todo`: necesitan un adapter para tener sujeto.
- El **pepper** (`IDENTIFICADOR_PEPPER`) es de desarrollo. En producción viene del almacén de secretos.

### Lo que sigue

**E1 del plan §9**: el primer adapter (Galicia), sobre el fixture sintético — nunca sobre el PDF real. El
gate de fixtures existe justamente para que el parser no se calibre contra el archivo del cliente.

**Comandos nuevos:** `pnpm fixtures:generar`, `pnpm fixtures:verificar`, `pnpm barrido:aceptar`,
`pnpm hooks:instalar`, `pnpm ingesta --cliente <uuid> --archivo <ruta> --banco <cod> --usuario <uuid>`.
`pnpm verificar` ahora corre typecheck + barrido + gate de fixtures + tests.

**Ojo con la base local:** se aplicaron `0004` y `0005` sobre base recreada. Si ya tenías la base migrada,
recreala: `drop database` + `pnpm db:migrate && pnpm db:setup`. Y `pnpm install` (hay tres paquetes nuevos:
`almacenamiento`, `apps/cli`, y el SDK de S3).

---

## 2026-08-10 (5) — Condiciones de salida del Módulo 1: nº 4 y nº 5 cerradas (E0 completa)

**Herramienta:** Claude Code. **Estado:** `pnpm verificar` verde — **200 tests + 4 todo**, y los 18
invariantes SQL con las tres credenciales sobre base recreada desde cero. **Sin commits.**

### Condición nº 4 — barrido de detectores sobre el REPO (`tools/barrido-fuga.ts`)

Es el control que faltaba: el redactor mira logs, INV-8 mira el logger, R33 mira secretos, y **nadie
miraba el código fuente ni la documentación**, que es donde había entrado la fuga.

**Cuatro correcciones salieron de probar el control en vez de darlo por bueno.** Están documentadas en
ADR-0002 §H.3.bis, y cada una invalidaba la versión anterior:

1. La primera versión fallaba con **18 hallazgos y los 18 eran ejemplos sintéticos legítimos**. La
   pregunta estaba mal: no es "¿hay algo con forma de importe?" sino "¿hay algún **valor del archivo real**
   en el repo?".
2. El cruce por substring dio **9 falsos positivos**, todos embebidos en ruido binario: con 13,5 M de
   caracteres, un token de ocho dígitos aparece por azar. Se pasó a cruce **por token**.
3. Normalizar quitando la coma decimal hacía colisionar el importe `1.111,11` con un **número de operación**
   `111111`. La coma se conserva.
4. **El control era ciego y daba verde.** Leía solo `.txt`, y el material real son PDF y Excel: al plantar
   un importe real **no lo detectó**. Se agregaron los lectores (inflado de streams Flate y entradas ZIP,
   cadenas en Latin-1 y UTF-16) y se hizo **simétrica la definición** — los mismos detectores de los dos
   lados. Recién ahí el importe real plantado apareció, y desapareció al quitarlo.

Dos modos: **estricto** (con `privado/`, cruza contra el material real) y **CI** (allowlist de **huellas**,
nunca valores, en `tools/barrido-aceptados.json`). Corre en `.githooks/pre-commit` —se instala con
`pnpm hooks:instalar`— y como paso de CI. La allowlist **no exime del cruce estricto**: eximir a un test
sería dejar abierta la puerta que el barrido cierra.

### Condición nº 5 — `0004_ingesta.sql` + registro de clasificación + catálogo verde

**Siete tablas**: `banco` (N0 sin tenant) más `cuenta_bancaria`, `cuenta_bancaria_identificador` (N2R),
`lote_ingesta` (N1 estricto), `lote_ingesta_cuenta`, `movimiento_bancario_crudo`,
`movimiento_origen_crudo` (N2R). Las seis enmiendas al contrato de ADR-0001 §5.1 están escritas con su
motivo en la cabecera de la migración. Clasificación completa en `clasificacion-campos.ts`.

### Cuatro problemas encontrados por los tests, no por la revisión

1. **Bug de seguridad real: la trampa de `for all`.** Las policies permisivas de Postgres se combinan con
   **OR**, y `for all` incluye SELECT. La policy de escritura de `movimiento_origen_crudo` admitía al
   `administrativo` (ingestar es su trabajo) y eso **anulaba** la policy de lectura restringida: el
   administrativo leía las filas crudas con los CUIT de las contrapartes — escenario H-8 sin descargar
   nada. La policy de lectura estaba bien escrita; el control se veía correcto en la migración y no existía
   en la base. Corregido declarando la escritura por operación. **`0005_policies_sin_for_all.sql`** aplica
   lo mismo a `credencial_fiscal`, donde el bug hoy NO se manifiesta pero el patrón es una bomba con
   fusible. Hay un test de catálogo que prohíbe el patrón, no la instancia.
2. **`LECTORES_AUDITADOS` era decorativo.** Guardaba **strings**, y `credencial_fiscal` apuntaba a
   `packages/data/src/credenciales.ts`, **que no existía**. El test pasaba porque verificaba que hubiera
   entrada, no que el lector existiera. Ahora el registro guarda la **referencia a la función** (vive en
   `db/lectores-auditados.ts` para no crear un ciclo), y hubo que escribir los tres lectores de verdad.
3. **`ACCIONES` (TS) y el check constraint (SQL) divergían**: el check omitía `uso_credencial`, que el
   código sí emite. Todo registro de uso de una credencial fiscal habría fallado el día que se integrara
   AFIP. Hay un test que compara las dos listas.
4. **`numero` fuera del grant de `app_request`** lo volvía ilegible para TODOS los roles. N2R no significa
   "sin grant": significa rol en lectura **más** auditoría. Sin grant es el control de N3.

### Estado de las 12 condiciones de salida (plan §10)

| # | Condición | Estado |
|---|---|---|
| 1 | Datos reales fuera de los comentarios de `packages/ingesta/src/*` | ✅ verificado, 0 ocurrencias |
| 2 | `.gitignore` anclado, sin negaciones de fixtures | ✅ |
| 3 | Commitear el `.gitignore` antes de `packages/` | ⏳ **tarea del usuario** (no hago commits) |
| 4 | Barrido de detectores sobre el repo, en pre-commit y CI | ✅ 22 tests propios + prueba end-to-end |
| 5 | `0004_ingesta.sql` + clasificación + catálogo verde | ✅ 31 catálogo + 16 aislamiento de ingesta |
| 6 | Test completo de INV-6 (4 casos × 3 aserciones) | ⏳ necesita el resolvedor de cuenta |
| 7 | Logger con allowlist + detector `importe_ar` + `forma()` | ✅ |
| 8 | INV-13: ninguna `descripcion` matchea los detectores | ⏳ necesita el adapter |
| 9 | `packages/almacenamiento` con emisor único de URL firmada | ⏳ |
| 10 | Fixture sintético + `pnpm fixtures:verificar` (7 chequeos) | ⚠️ generador hecho; falta el gate |
| 11 | `accion='rechazo'` + check constraint + guard desde el CLI | ⚠️ base hecha (0004); falta el CLI |
| 12 | `verificarAritmetica` pura + mutaciones | ✅ 11 mutaciones en rojo por su detector |

### Lo que sigue

Condición 9 (`packages/almacenamiento`), después 6 y 8 —que necesitan el resolvedor de cuenta y el
adapter—, y 10 y 11. Recién con las 12 arranca E1.

**Ojo con la base local:** `0004` y `0005` se aplicaron sobre una base **recreada desde cero** (se
corrigieron dos veces antes de que viajaran a un commit). Si otra herramienta ya tenía la base migrada,
tiene que recrearla: `drop database` + `pnpm db:migrate && pnpm db:setup`.

---

## 2026-08-09 (4) — Análisis del cliente piloto + plan del Módulo 1 (panel de 6 agentes)

**Herramienta:** Claude Code. **Estado:** plan cerrado, **construcción del adapter NO iniciada** por
decisión del panel. **Sin commits.**

### Qué se hizo

1. **Transcript de la entrevista** (~68 min) guardado en `privado/laura-transcript.txt`, **fuera del
   repo**. De los cinco formatos se eligió el **VTT** (el único con diarización) y se convirtió a 255
   turnos de conversación. `privado/` agregado al `.gitignore`.
2. **`docs/analisis/00-cliente-piloto-laura.md`** — análisis redactado de la entrevista.
3. **Llegaron los archivos reales**: 8 bancos con PDF, varios con Excel, más FCI (3) y tarjetas (2), y
   **tres documentos de criterio escritos por la contadora** (14 reglas de clasificación bancaria, FCI con
   PEPS, y el circuito de reimputación de tarjetas). El conector de Drive por MCP apunta a la cuenta de
   trabajo y no alcanza la carpeta personal: los archivos se copiaron a `privado/extractos/`.
4. **Panel de 6 agentes**, cada uno adoptando su persona, todos sobre el material real.
5. **`docs/diseno/01-modulo-1-ingesta-bancaria.md`** — el plan completo, escrito para los **8 bancos**.

### El hallazgo que hubo que arreglar antes que nada

`seguridad-datos-financieros` encontró **importes y una glosa del extracto REAL en los comentarios** de
`packages/ingesta/src/{parseo-ar,esquema,hash}.ts`. Verificado contra el archivo: los cinco tokens
presentes. Un comentario viaja al historial de git, a los PRs, al CI y al contexto de cada agente — donde
no hay redactor que lo tape. **Corregido y verificado: 0 ocurrencias.** Y el mecanismo importa más que el
síntoma: **ningún control existente lo detectaba** (el redactor mira logs, INV-8 mira el logger, nadie
mira los comentarios). Falta un barrido de detectores sobre el repo en pre-commit y en CI.

También se corrigió el `.gitignore`: `/privado/` **anclado** (sin anclar hacía desaparecer fixtures
legítimos en silencio) y **eliminadas las negaciones `!**/fixtures/**/*.pdf|xlsx`**, que eran el único
camino por el que un extracto real podía entrar con un `git add -A`.

### Hechos medidos que reemplazan supuestos

- **7 PDFs, no 8**: el de Credicoop es byte-idéntico al de ICBC. **BBVA es imagen pura** (0 caracteres).
- **Galicia reconstruido entero**: 326 movimientos, **cadena de saldos sin una sola ruptura en 325**,
  sumas exactas contra la línea `Total`. La verificación es exacta, no aproximada.
- **Leer por líneas sirve para 3 de 8 bancos.** **Bancor no publica signo**: el débito/crédito sale de la
  cadena de saldos, o sea que la aritmética es **la fuente**, no la red.
- **Detrás de "Excel" hay tres tecnologías**; el `.xls` de Santander es un TSV en Latin-1.
- **`(fecha, importe)` no es clave** (19 colisiones); `(fecha, importe, saldo)` sí (326/326).
- **La ruta y el nombre del archivo no acreditan nada** — hay tres casos de archivo mal ubicado en el
  material de origen. INV-6 no es hipótesis.

### Correcciones a documentos y código propios

Seis refutaciones al análisis (el número de referencia **no** es clave; la premisa del OCR era falsa; nueve
bancos y no cinco; el ancla de cuenta es el número; el padrón es N2R con `estudio_id` y no N0/N1;
PDF/Excel se complementan al revés de lo escrito), **más un cuasi-identificador**: el documento redactaba
bien campo por campo y el **conjunto** identificaba por cruce a una empresa. Regla que deja: **hay que
redactar el conjunto, no solo cada campo.**

Y **once bugs medidos** en el código del Módulo 1, listados en el plan §3.2. Los tres peores fallan en
verde: `importeACentavos` acepta cualquier cadena de dígitos (295 tokens por extracto); `centavosAImporte`
y `importeACentavos` **no son inversas** (Σ = 0 y una verificación que cuadra contra la nada); y
`verificacionSchema` permite `hayTotales: false` con `cuadra: true` — **el verde por vacío está horneado en
el contrato**.

### Tres reglas de la contadora producen un asiento incorrecto

Auditadas contra el extracto real: la 3 (una percepción de IVA mandada a crédito fiscal), la 7 (la comisión
del banco por el servicio de haberes mandada a Sueldos a pagar) y la 11 (la acreditación de tarjeta neta
imputada al bruto). **Los tres desaparecen matcheando código de concepto en vez de texto libre.** Hay que
confirmarlas con ella: son de su criterio, no nuestro.

### Por qué NO se construyó el adapter

El panel lo bloqueó, y coincido: **12 condiciones de salida** en el plan §10. Las dos que lo resumen:
`verificarAritmetica` como función pura con sus cinco ecuaciones, y `mutaciones.test.ts` con sus diez
mutaciones. Sin esas dos, **los 8 bancos son ocho apuestas**.

### Lo próximo

1. Aprobar el plan (o corregirlo).
2. Las 12 condiciones de salida de §10 — dos ya están hechas.
3. Pedirle a Laura las 10 cosas de §11. Las tres urgentes: **padrón de CUIT de socios**, **inventario PEPS
   de apertura** y **liquidación del adquirente de tarjetas** (esta última no está en ningún módulo del
   diseño y sin ella la regla 11 queda mal para siempre).

---

## 2026-08-09 (3) — Cierre de Fase 0: los 7 puntos de ADR-0002 §H.3 que necesitaban código

**Herramienta:** Claude Code. **Estado:** cerrado, con **1 punto parcial declarado**. **Sin commits.**

### Qué se hizo

Scaffolding del monorepo (`pnpm` workspaces, TypeScript estricto, Node 24 con type-stripping nativo
verificado) y los siete puntos:

| # | Punto | Estado |
|---|---|---|
| 1 | `conUsuario()` único punto + guard de arranque | ✅ `packages/data/src/db/conexion.ts` |
| 2 | FK compuestas tenant-consistentes | ✅ `0002_endurecimiento.sql` |
| 3 | Registro de clasificación + redactor de logs | ✅ `packages/shared/src/seguridad/` + `observabilidad/logger.ts` |
| 4 | Policy de rol en lectura para N2-R/N3 | ✅ `0002` + grant a nivel **columna** |
| 5 | Choke point de auditoría | ✅ `packages/data/src/db/auditoria.ts` |
| 6 | Tests de catálogo en CI | ⚠️ tests ✅ y pasando; **el workflow no se ejecutó** (no puedo correr GitHub Actions) |
| 7 | Generador de datos sintéticos | ✅ `packages/data/src/seed/sintetico.ts` + `pnpm db:seed` |

**Gate:** `pnpm verificar` = typecheck estricto + **72 tests, todos pasando**. Más las **3 pasadas SQL**
(18 aserciones) con las tres credenciales distintas. Migraciones `0001`, `0002` y `0003` aplicadas.

### Cuatro hallazgos que salieron de correrlo (no de suponerlo)

1. **`INSERT ... RETURNING` aplica también la política de `SELECT`.** En una tabla append-only —muchos
   escriben, pocos leen— el `returning` falla con *"new row violates row-level security policy"*, que
   hace pensar que el problema es la escritura cuando la escritura está bien. → El id de correlación lo
   genera la aplicación (`0003_auditoria_correlacion.sql`).
2. **El redactor no puede tapar una razón social.** Es texto sin patrón. El barrido INV-8 lo encontró con
   el nombre de un archivo dentro de un `Error`. → **El redactor es la red, no la defensa**: la defensa
   es el tipo cerrado del logger y la regla de no armar mensajes de error con datos del cliente. Quedó
   como test explícito del límite.
3. **El tipo del logger encontró un error en el propio ADR-0002 §D**: el ejemplo usaba `motivo=`, y
   `motivo` es una columna N2. Corregido a `motivo_codigo` en el ADR y en el código.
4. **Limpiar no es una operación de la aplicación.** Ni `app_job` ni `app_request` pueden borrar el rastro
   de auditoría ni las credenciales, y las FK `on delete restrict` bloquean el borrado del árbol: la
   limpieza de tests y de seed la hace el dueño del esquema con `TRUNCATE`.

Dos correcciones de infraestructura, también de correrlo: el detector de cuentas con separadores
matcheaba **UUIDs** (arreglado con lookarounds), y `z.uuid()` de Zod 4 valida versión/variante RFC y
rechaza uuids que Postgres acepta → se valida la **forma**, no el linaje RFC.

### Un punto de diseño abierto, declarado

**Quién escribe `credencial_fiscal.material_cifrado`**: hoy nadie puede por el camino normal (la policy
exige `socio`, el grant de columna es solo de `app_firmador`, y el firmador no tiene membresía). Es
correcto que `app_request` y `app_job` no puedan; falta definir cómo entra la credencial la primera vez.
**Se resuelve con `integraciones-afip`**, que es su dominio. Ver ADR-0002 §H.4.

### Lo próximo

1. **Analizar el transcript de la conversación con Laura** (pedido del usuario) — pendiente de recibirlo.
2. Recién después: **Módulo 1** (extracción de extractos PDF), con `0004_ingesta.sql` según el contrato de
   ADR-0001 §5.1. Falta definir el **banco piloto** y de dónde sale el PDF real (que **no** puede entrar
   al repo: ADR-0002 §F.2).

---

## 2026-08-09 (2) — Base de arquitectura: stack, tenancy y seguridad (3 ADRs + migración verificada)

**Herramienta:** Claude Code. **Estado:** cerrado. **Sin commits** (pedido explícito del usuario).

### Qué se hizo

1. **`docs/arquitectura/ADR-0000-stack-infra.md`** — TypeScript estricto + Zod; monorepo pnpm desde el
   primer commit; **el Módulo 1 arranca sin app web** (`apps/cli` + `packages/ingesta`, decisión
   fundamentada en §2.2); las tres abstracciones (Drizzle/Postgres, `AuthProvider`, `ObjectStorage`
   S3-compatible); migraciones `drizzle-kit` en SQL plano; Docker local; y la tabla de portabilidad para
   **Google Cloud / AWS / Vercel+Supabase / self-hosted**.
2. **`ADR-0001-tenancy.md`** — tenancy jerárquica portada de `admin-barrios`: **estudio = raíz, cliente =
   hijo**, `tenant_node` con materialized path, `membership`, las tres funciones (`app.current_user_id`,
   `app.accessible_tenant_ids`, `app.has_role_on`), roles `app_request` / `app_job`, la **plantilla de
   siete renglones** obligatoria para toda tabla de dominio, y el contrato del Módulo 1.
3. **`ADR-0002-seguridad.md`** — cinco niveles de datos (N0/N1/N2/N2-R/N3) con control por nivel; **35
   reglas verificables** (R1–R35) con su estado; 18 invariantes de aislamiento; política de logging con
   ejemplos aceptable/inaceptable; custodia y rotación de credenciales fiscales; datos de prueba;
   huecos normativos G-1..G-8. Contenido producido por el agente **`seguridad-datos-financieros`**,
   convocado explícitamente.
4. **`packages/data/migrations/0001_tenancy.sql`** — escrita **y aplicada contra PostgreSQL 16 real**.
5. **`packages/data/sql/tests/0001_aislamiento.test.sql`** — **18 aserciones, todas pasando** (tres
   pasadas, una por rol). Ver §C.0 del ADR-0002 para la lista.
6. **`docker-compose.yml` + `.env.example` + `.gitignore` + `packages/data/sql/db-setup.sql`** —
   infraestructura local levantada y verificada de punta a punta (runbook en ADR-0000 §4.1).
7. **`docs/seguridad/`** — `registro-terceros.md`, `registro-incidentes.md`, `registro-excepciones.md`
   (vacíos, con su procedimiento).
8. **Sync**: `CLAUDE.md` §1 (cuatro reglas duras reales, ya sin placeholders) y §2 (convenciones del
   stack); `AGENTS.md` §0 (ADRs como lectura obligatoria) y §2 (las tres reglas de esquema).

### Un bug real encontrado y corregido

El agente `seguridad-datos-financieros` encontró que el diseño portado tenía el trigger de `path` **solo
en `BEFORE INSERT`** (hallazgo H-1, crítico). Consecuencia: un `update tenant_node set parent_id = …`
dejaba el `path` viejo, y como `accessible_tenant_ids()` resuelve el subárbol **por path**, un usuario de
un estudio empezaba a ver clientes de otro — en silencio. **Corregido**: trigger en `update of
parent_id`, trigger que rechaza editar `path` a mano, `app.verificar_coherencia_path()` (para CI y para
un job en producción) y `app.reparentar_nodo()` que aborta si deja el árbol incoherente. Verificado con
las aserciones P1-A..P1-D.

### Dos cosas que salieron de correrlo, no de suponerlo

- **El dueño del esquema NO puede sembrar el nodo raíz:** `force row level security` le aplica las
  políticas también a él. La siembra la hace `app_job`. Corolario: **en producción el dueño del esquema
  no debe ser superusuario** (un superusuario ignora RLS siempre).
- **`BYPASSRLS` saltea políticas, no otorga privilegios**, y los **atributos** de rol no se heredan por
  `GRANT`. Por eso `app_job` es el rol que se conecta y necesita grants explícitos — y por eso **ni él
  puede borrar `acceso_auditoria`** (verificado en P1-0).

### Estado verificado (respuesta a las tres preguntas del usuario)

| Pregunta | Respuesta |
|---|---|
| ¿Soporta multi-tenant? | **Sí, y está probado** contra Postgres real: 18 aserciones, incluidas las dos direcciones del aislamiento, la herencia de subárbol, el fallo cerrado sin identidad y la trampa del prefijo de path. |
| ¿Tiene niveles de seguridad definidos? | **Sí, definidos** (5 niveles + 35 reglas + 18 invariantes). **Parcialmente implementados**: lo que vive en la base está hecho y verificado; lo que necesita código está listado como condición de salida en ADR-0002 §H.3. |
| ¿Es agnóstico de despliegue? | **Sí, por diseño**, con 3 puntos a confirmar contra el proveedor elegido (roles con `BYPASSRLS`, pooling en transaction mode, URL firmadas en Cloud Storage). ADR-0000 §6 y §9. |

### Lo próximo, en orden

1. **Scaffolding del monorepo** (`package.json`, `pnpm-workspace.yaml`, `tsconfig`), porque siete de los
   ocho puntos de ADR-0002 §H.3 necesitan que exista código.
2. **`conUsuario()` en `packages/data`** con el guard de arranque que rechaza `BYPASSRLS`/superusuario en
   el proceso de request, y el registro de clasificación de campos.
3. **Módulo 1 (ingesta)** con `0002_ingesta.sql` según el contrato de ADR-0001 §5.1 — `cliente_id` desde
   la primera fila, unicidad `(cliente_id, fila_hash)`, FK compuestas tenant-consistentes.

---

## 2026-08-09 — Alta de los agentes de dominio + esqueleto de `knowledge/`

**Herramienta:** Claude Code. **Estado:** cerrado. **Sin commits** (pedido explícito del usuario).

### Qué se hizo

1. **8 agentes de dominio** dados de alta con la estructura portable de 3 archivos
   (`agents/personas/<n>.md` + `agents/wrappers-claude/<n>.md` + `.claude/agents/<n>.md`):
   `contador-dominio`, `fiscal-nacional-iva-ganancias`,
   `fiscal-ingresos-brutos-convenio-multilateral`, `integraciones-afip`,
   `motor-conciliacion-contable`, `plan-cuentas-multicliente`, `balances-normas-tecnicas`,
   `seguridad-datos-financieros`.
2. **`.claude/agents/` creado y activado** con los 11 wrappers (8 nuevos + los 3 genéricos del template,
   que no estaban activados).
3. **Esqueleto de `knowledge/`** (carpetas + un README por carpeta, **sin contenido normativo**):
   `nacional/{iva,ganancias,sire}`, `interjurisdiccional/convenio-multilateral/{regimen-general,
   regimenes-especiales,sifere}`, `provincial/` (con `_PLANTILLA-provincia.md`, **sin ninguna provincia
   creada**), `clientes/` (con `_PLANTILLA-jurisdicciones-activas.md`), más `README.md`,
   `JURISDICCIONES-ACTIVAS.md` y `_FUENTES.md`.
4. **`docs/agents/guia-carga-conocimiento.md`**: qué cargar primero, en qué orden y de qué fuente
   oficial. Mínimo viable = IVA + Ganancias nacional, y el IIBB de la primera provincia real.
5. **Sync de tablas** en `agents/README.md` (roster completo + guardrails + matriz de convocatoria +
   checklist de sincronía), `CLAUDE.md` (§1.6 y §1.7 nuevas reglas duras; §3 tabla de sub-agentes) y
   `AGENTS.md` (§1 las dos reglas que Codex tiene que tener presentes; §3 roster y puntero a `knowledge/`).

### Decisiones que quedan escritas

- **Dos agentes fiscales, no uno.** El reparto interjurisdiccional (coeficientes, atribución de ingresos
  y gastos, regímenes especiales, SIFERE) tiene complejidad propia y no se resuelve con criterios
  nacionales. Están separados a propósito y se derivan trabajo entre sí.
- **No hay "jurisdicción activa" única.** A diferencia de `admin-barrios`, acá un cliente puede tener
  **varias jurisdicciones simultáneas** por Convenio Multilateral. Modelado como **colección con
  vigencia** por cliente (`knowledge/JURISDICCIONES-ACTIVAS.md` +
  `agents/personas/plan-cuentas-multicliente.md`).
- **Asistido, no automático** (regla dura `CLAUDE.md` §1.7): el motor de conciliación **propone** con
  evidencia y deja en cola de revisión del contador; nunca registra solo, ni con score máximo.
- **Ninguna provincia creada en `knowledge/provincial/`**, a propósito: la ley impositiva es anual y un
  relevamiento "por las dudas" envejece antes de usarse. Se crea la primera cuando se sepa la del
  cliente piloto.
- **El motor de conciliación del gas está disponible y verificado en disco**
  (`C:\Proyectos_Desa\trazabilidad-obra-gas\src\services\conciliacion\{matcher,reglas,reversas,
  imputacion-service}.ts`, `src/domain/cuit.ts`, `src/lib/normalizar-texto.ts`). El análisis de reuso ya
  escrito para el otro producto (`admin-barrios\docs\diseno\02-reuso-conciliacion.md`) sirve de base;
  **no** se copió código todavía.

### Supuestos marcados

- **Nombre del proyecto = `sistema-contable`** (el del repo). Se usó en los wrappers. Los placeholders
  `<NOMBRE_PROYECTO>`, `<REGLA_DURA_1..4>` y los de `docs/devops/*` **siguen sin completar**: no eran
  parte del pedido.
- **`AFIP` → `ARCA`**: el cambio de denominación del organismo está anotado como `[A VERIFICAR]`.
  Denominación exacta, URLs y nombres de servicio se verifican contra fuente oficial antes de escribirlos
  en un doc o en código.
- **Números de norma y de RT**: el único que aparece afirmado en todo lo escrito es **RT 41** (variante
  para entes pequeños/medianos), porque lo indicó el usuario al definir el alcance del agente — y aun así
  queda sujeto a verificación contra FACPCE al cargarlo. Ningún otro número de norma se escribió.

### Qué NO se tocó (a pedido)

**Ingesta bancaria** y **tenancy**: etapa siguiente. Las personas de `motor-conciliacion-contable` y
`plan-cuentas-multicliente` delimitan explícitamente qué **no** deciden todavía sobre esos dos temas.

### Lo próximo, en orden

1. **Cargar `knowledge/nacional/iva/` y `knowledge/nacional/ganancias/`** — es lo único que desbloquea a
   `fiscal-nacional-iva-ganancias` para toda la cartera. Hoy `knowledge/` está vacío y **todos** los
   agentes fiscales responden "no tengo esa fuente cargada".
2. **Definir la provincia del cliente piloto** y si es unilateral o de Convenio → crear
   `knowledge/provincial/<provincia>/iibb/` desde la plantilla; si es de Convenio, cargar además
   `interjurisdiccional/convenio-multilateral/`.
3. Recién después: ingesta bancaria y tenancy.
