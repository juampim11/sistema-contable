# 22 — Formato ICBC (Industrial and Commercial Bank of China (Argentina) S.A.), extracto de cuenta corriente en PDF

> Medido contra el PDF real del cliente en `privado/extractos/.../Banco Cta - Cte/ICBC/Resumen 06-2026
> ICBC.pdf` (1 página, **33 filas geométricas** vía `aFilas()`/`pdf.js`), con la misma disciplina que
> `20-formato-bancor.md`/`21-formato-nacion.md`: **solo estructura y geometría, ningún dato real**. Toda
> medición se hizo por `formaParaLog` — sin lectura cruda por shell. Las tres etiquetas del bloque de
> totales (`TOT.IMP.LEY COMP.` / `TOT.LEY COMP.$` / `SALDO FINAL`) las dio JP directamente en el pedido
> de esta tarea (mismo mecanismo que confirmó el bloque de totales de Bancor — `20-formato-bancor.md`
> §6 — sin que un agente necesitara leer texto crudo del documento).

## 0. Contexto: cliente real y por qué el documento es tan chico

Cliente detrás del extracto: **MEB Integración y Montaje S.A.S.** (razón social exacta a confirmar
contra la carátula real en el Paso 3, misma disciplina que ya usó Nación). Documento de **1 sola
página**, **33 filas geométricas**, con **9 filas de movimiento** — un extracto de baja actividad,
similar en tamaño al de Nación (HYJ SAS), no una falla de lectura: `paginas=1`,
`paginasSinTexto=[]`, `requiereOcr=false`.

## 1. Respuesta a las 4 hipótesis (en el orden pedido)

### H1 — ¿La rama GENÉRICA de `leerCaratula` (por etiqueta "Nº"/"C.B.U.:") ya reconoce número de
cuenta y CBU de este documento?

🔴 **NO. Refutada, por DOS motivos independientes, medidos con la función real `valorPorEtiqueta`
sobre `aLineas()` — no una reimplementación:**

1. **No hay ninguna etiqueta "Número de cuenta"/"Nro. de cuenta"/"Cuenta Nº"/"Cuenta N°" en el
   documento.** El número de cuenta aparece precedido solo por el símbolo `N°`, sin ninguna de las
   cuatro variantes de etiqueta que la rama genérica busca — `SIN MATCH`, confirmado.
2. **La etiqueta `C.B.U.:` SÍ existe, pero el valor viene partido en DOS grupos de dígitos con un
   separador entre ellos** (`########` + `##############`, 8 + 14 = 22), no como una corrida continua
   de 22 dígitos. El patrón de la rama genérica (`\b\d{22}\b`) exige dígitos consecutivos — `SIN
   MATCH`, confirmado. Con un patrón deliberadamente más laxo (dos corridas de dígitos separadas por
   espacio) sí matchea, lo que confirma que el valor está ahí, solo que partido.

**Conclusión: hace falta una 6ª rama de `leerCaratula`, mismo patrón que Bancor/Nación (geometría
`aFilas`, no `aLineas`).** No hay ahorro de código posible acá — a diferencia de lo que la hipótesis
dejaba abierto.

**Único match real, sin ambigüedad**: fila geométrica 7 (de 33), dentro de la ventana de carátula
(`< 20`), un solo fragmento contiene TODO el bloque: `N° ####/########/## C.B.U.: ######## ##############`.
Se barrió el documento completo buscando cualquier otra corrida de ≥15 dígitos o cualquier otro
fragmento con forma `NNN/NNNNNNN/NN` — **cero coincidencias fuera de esa fila**. El único candidato con
16 dígitos corridos que aparece en otra fila (fila 2) es el período (`dd-mm-aaaa AL dd-mm-aaaa`, ver
§1.2), de forma completamente distinta (con guiones, sin barras) — no es un decoy real.

**Formato medido del número de cuenta**: `dddd/dddddddd/dd` — tres grupos separados por `/` (4, 8 y 2
dígitos), a diferencia de Bancor (`NNNNN/NN`, dos grupos) y de Nación (10 dígitos corridos sin
separador). **Formato medido del CBU**: 22 dígitos partidos en dos grupos (8 + 14) con un separador —
a diferencia de Bancor/Nación, que lo traen como una corrida única de 22.

### H2 — ¿DEBITOS y CREDITOS son dos columnas con coordenada `x` propia en la mayoría de las filas?

✅ **SÍ, confirmado por posición — con una particularidad: el importe de DEBITOS trae un signo `-`
FINAL redundante (sufijo, no prefijo), CREDITOS no trae signo.**

De las 9 filas de movimiento, **8 caen en la columna con borde derecho ≈427.0** (el importe termina en
`-`, ej. forma `##.###,##-`) y **1 sola cae en una columna con borde derecho ≈502.6** (sin signo, ej.
forma `#.###.###,##`). La distancia entre los dos bordes (≈75.6 pt) es demasiado grande para ser
variación de cantidad de dígitos del mismo campo — son dos columnas geométricamente distintas, y
coincide con la posición de los literales del encabezado (`DEBITOS`, 7 letras, en `x=372.4`;
`CREDITOS`, 8 letras, en `x=443.8` — confirmado por longitud de forma, mismo método que Nación §3).

**Consecuencia para el contrato**: `origenSigno: 'columna_separada'`, igual que Nación — el signo lo
decide la columna, no un token. El signo `-` final en la columna DEBITOS es **redundante** con la
columna (mismo rol que el token de Galicia, ver `parDeColumnas`/`traeSignoEnElImporte` de
`toolkit.ts`).

✅ **Verificado contra el código, no queda abierto para el Paso 2: `importeACentavos`
(`parseo-ar.ts:97-98,118`) YA acepta el signo atrás** (`765.432,10-`, "notación contable de saldo
acreedor", una de las cuatro notaciones que la función ya documenta como observadas) — no hace falta
extender la función compartida. `icbc.ts` puede llamarla tal cual sobre el fragmento de DEBITOS.

🔴 **Sobre 9 filas, 8 son débito y solo 1 es crédito** — la ventana CREDITOS queda en la misma
situación que la de Nación (`21-formato-nacion.md` §4): medida contra UN SOLO caso real, no un
universo. Se declara así, no como regla firme.

### H3 — ¿En qué proporción de filas de movimiento aparece SALDO, y con qué patrón?

**5 de 9 filas de movimiento (55,6%) traen un valor en la ventana de SALDO** (borde derecho ≈582.4,
misma columna que el saldo inicial declarado, fila 9, y que el saldo final del bloque de totales, fila
20). Las otras 4 no traen ningún fragmento en esa columna.

🔴 **Sin patrón de intervalo fijo** (no es "cada N filas"): las filas SIN saldo son la 1ª, 2ª, 5ª y 7ª
del bloque de movimientos (índices geométricos 10, 11, 14, 16); las filas CON saldo son la 3ª, 4ª, 6ª,
8ª y 9ª (índices 12, 13, 15, 17, 18). No hay forma de confirmar contra la forma enmascarada si el
patrón real es "un saldo por grupo de movimientos del mismo día" (hipótesis plausible, consistente con
que dos filas sin saldo consecutivas — 10 y 11 — aparezcan juntas al principio) sin leer el dato real,
así que **queda sin confirmar la causa, solo medida la proporción**.

**Consecuencia para el contrato y la verificación**: exactamente el mecanismo que
`verificarAritmetica` (`packages/ingesta/src/verificacion/invariantes.ts:132-135`) **ya implementa y
no necesita cambios** — cuando `anterior.saldo` o `actual.saldo` es `undefined`, la cadena salta ese
par sin marcarlo como ruptura ("Cadena por puntos de control: el banco no imprime saldo en todas las
filas. No es una ruptura."). El adapter de ICBC solo tiene que **emitir `saldo: undefined` cuando la
ventana no trae fragmento** — mismo patrón exacto que ya usa `nacion.ts` (`...(saldoCent === null ? {}
: { saldo: ... })`). **No hace falta escribir un mecanismo nuevo de puntos de control**: ya existe,
compartido, y ya lo usan los cinco adaptadores del roster.

### H4 — El bloque de totales al pie: ¿cuántos valores, con qué patrón de espaciado?

🔴 **Confirmado: todo en UNA sola fila geométrica (fila 20 de 33), a diferencia de Bancor (9 líneas,
una por etiqueta) y de Nación (una fila por concepto).** La fila trae **5 fragmentos**, que
corresponden a **3 valores conceptuales**:

| Fragmento | `x` | Forma | Interpretación |
|---|---|---|---|
| 1 | 82.6 | `AAA.AAA.AAA AAAA.:` | Etiqueta `TOT.IMP.LEY COMP.:` (dato de JP) |
| 2 | 196.0 | `##.###,##` | Valor 1 |
| 3 | 242.2 | `AAA.AAA AAAA.$` | Etiqueta `TOT.LEY COMP.$` (dato de JP) |
| 4 | 347.2 | `#.###,##(*) AAAAA AAAAA AA ##/##/####` | Valor 2 + nota `(*)` + etiqueta `SALDO FINAL AL <fecha>` (dato de JP), **los tres pegados en un solo fragmento** |
| 5 | 540.4 | `###.###,##` | Valor 3 = el saldo final — misma columna (borde derecho ≈582.4) que el saldo inicial (fila 9) y que el saldo de cada movimiento (§H3) |

**La fecha del fragmento 4 es la del "SALDO FINAL AL"**, no un cuarto valor — mismo formato `dd/mm/yyyy`
que el resto del período (a diferencia de las fechas del cuerpo, que van con guion y sin año, §1.2 más
abajo).

**Consecuencia para el diseño del Paso 2**: NO hay una fila propia de "SALDO FINAL" como en
Bancor/Nación — el saldo final está embebido en la misma fila que los dos totales de impuesto. El
lector tiene que:
1. Reconocer la fila por su primera etiqueta (`TOT.IMP.LEY COMP.`).
2. Leer el fragmento 2 como el primer total (candidato a `AnexoExtracto`, mismo mecanismo que Bancor
   §6 — dos anexos de "Total Imp...Ley de Competitividad", vocabulario ya conocido del roster).
3. Leer, DENTRO del fragmento 4 (con un regex sobre su texto ya unido, no por fragmento — mismo
   mecanismo que usa Nación para fecha+concepto pegados, `21-formato-nacion.md` §4), el segundo total y
   la etiqueta `SALDO FINAL AL <fecha>`.
4. Leer el fragmento 5 como el importe del saldo final declarado, por la misma ventana de columna que
   ya usa el resto del documento.

**Nota `(*)`**: hay una fila de pie (fila 30 de 33) con el texto de la nota al pie, estructura de
disclaimer estándar — no es dato del cliente, es leyenda regulatoria genérica del banco. Confirmar el
literal exacto cuando se lea con autorización en el Paso 2 (no fue necesario para responder esta
hipótesis).

### H4.1 — Confirmación explícita del punto de corte dentro del fragmento 4, ANTES de escribir el regex

🔴 **Pedido de JP, con precedente directo: el fallo del período de Nación fue justo esta clase de
error — un separador que "parece obvio" en el único caso medido y no generaliza** (`extraerPeriodo`
exigía `al`/`hasta` en minúsculas porque nadie verificó el caso mayúscula, HANDOFF 121). Antes de
escribir el regex de `icbc.ts`, se deja explícito **cómo** se determina el corte entre "valor 2" y
"fecha embebida" dentro del fragmento 4 — y la respuesta es: **NO por una cantidad fija de dígitos
antes de la fecha.**

Fragmento 4, forma completa, sin truncar: `#.###,##(*) AAAAA AAAAA AA ##/##/####`

Desglosado posición por posición:

| Tramo | Forma | Qué es |
|---|---|---|
| `#.###,##` | número con coma decimal | **Valor 2** (el segundo total) |
| `(*)` | literal fijo | nota al pie — puede faltar en un futuro documento sin footnote |
| ` ` | espacio | separador |
| `AAAAA` | 5 mayúsculas | candidato `SALDO` (por longitud) |
| ` ` | espacio | separador |
| `AAAAA` | 5 mayúsculas | candidato `FINAL` (por longitud) |
| ` ` | espacio | separador |
| `AA` | 2 mayúsculas | candidato `AL` (por longitud) |
| ` ` | espacio | separador |
| `##/##/####` | fecha con **BARRA**, con año | la fecha del saldo final |

**El ancla NO es "contar N dígitos antes de la fecha".** Son DOS anclas de forma, cada una
independiente de la longitud de la otra:

1. **El valor 2 se reconoce por SU PROPIA forma de importe** (`^[\d.]+,\d{2}`, el mismo patrón que
   `RE_IMPORTE` de `parseo-ar.ts` ya usa para el resto del documento) — matchea desde el **principio**
   del fragmento, sin importar cuántos dígitos tenga.
2. **La fecha se reconoce por SU PROPIA forma de fecha** (`\d{2}/\d{2}/\d{4}$`, anclada al **final**
   del fragmento) — sin importar cuántos caracteres la preceden.
3. **Lo que queda en el medio se valida contra el LITERAL conocido** `SALDO FINAL AL` (case-insensitive,
   mismo criterio que `RE_SALDO_ANTERIOR`/`RE_SALDO_FINAL` de `nacion.ts` y las 9 etiquetas de
   `bancor.ts` §6) — nunca se asume por posición ni por conteo de caracteres. Si el texto entre las dos
   anclas NO matchea ese literal (con o sin el `(*)`, que es opcional en el regex), el fragmento entero
   se reporta como no interpretado — fail-closed, no se inventa un corte.

**Por qué esto no repite el error de Nación**: el error de Nación no era "cortar por posición" — era
que el regex exigía una **grafía exacta** (minúscula) sin haberla verificado contra mayúscula. Acá el
riesgo análogo sería asumir el `(*)` como obligatorio (si un futuro documento no trae footnote en esa
línea, el corte se rompe) — por eso el regex de `icbc.ts` lo marca **opcional** (`(?:\(\*\))?`), y la
verdadera ancla de cierre es el literal `SALDO FINAL AL`, no el asterisco. **La longitud de "5, 5, 2"
letras usada acá arriba es solo para IDENTIFICAR el candidato de literal por forma** (mismo método que
`21-formato-nacion.md` §3 usa para confirmar encabezados) — el regex del adapter matchea el texto
literal esperado, no la longitud.

**Tercera convención de fecha distinta, dentro del MISMO documento — confirmado, no asumido:**

| Dónde | Formato | Separador | Año |
|---|---|---|---|
| Período de carátula (fila 2) | `dd-mm-aaaa` | guion | sí |
| Fecha de cada movimiento (cuerpo) | `dd-mm` | guion | no |
| Fecha embebida en "SALDO FINAL AL" (fila 20) | `dd/mm/aaaa` | **barra** | sí |

Las tres conviven en el mismo PDF. El regex de `SALDO FINAL AL` usa **su propio** patrón de fecha con
barra (`\d{2}/\d{2}/\d{4}`), nunca el de guion del resto del documento — escribirlo genérico
("cualquier separador") sin haber confirmado esto sería el mismo tipo de supuesto no verificado que ya
costó una corrida contra el piloto en Nación.

## 1.1. Hallazgos estructurales adicionales, no pedidos por las 4 hipótesis pero necesarios para el Paso 2

- **La fecha del cuerpo NO trae año** (`dd-mm`, con GUION, no barra — a diferencia de los cinco bancos
  anteriores, todos con `/`). Va en su **propio fragmento**, separado del concepto (a diferencia de
  Nación, donde fecha y concepto vienen pegados) — más parecido a Bancor/Santander/Macro en ese sentido,
  pero con separador `-` en vez de `/`. Se resuelve contra el período de carátula, igual criterio que
  Bancor/Macro (`anioEnLaFecha: false`).
- ✅ **Confirmado, literal exacto**: `PERIODO 01-06-2026 AL 30-06-2026` (fecha `dd-mm-aaaa` con guion,
  conector `AL` en MAYÚSCULA, un solo fragmento). **Hace falta regex propia, NO se reusa `extraerPeriodo`
  de `toolkit.ts`**: esa función es case-sensitive y solo acepta el conector en minúscula
  (`a(?:l)?|hasta`) — el mismo defecto que ya rompió contra Nación (HANDOFF 121/122). Mismo patrón que
  `RE_PERIODO` de `nacion.ts` (con `/i`), pero con fecha `dd-mm-aaaa` en vez de `dd/mm/aaaa`. Nunca se
  toca la función compartida — mismo criterio ya fijado para Nación.
- ✅ **Columna de referencia/comprobante — número trazado, hallazgo de `code-reviewer` (revisión del
  Paso 2).** Un fragmento de 4 dígitos en `x≈305.2`, presente en las 9 filas de movimiento, con ancho
  **CONSISTENTE `16.8` en 8 de 9 filas** (borde derecho 322.0). **La 9ª fila (el único crédito real,
  §H2) mide ancho `37.8`, borde derecho `343.0`, forma `#### AAAA`** — el número de comprobante con
  un token de 4 letras pegado al lado, en el mismo fragmento de `pdf.js`. Este número (343.0) es el
  que sostiene la ventana `referencia: { desde: 295, hasta: 345 }` de `icbc.ts` — quedaba solo en el
  comentario del código, sin trazarse acá, hasta esta revisión. **El adapter captura el fragmento
  COMPLETO** (`referenciaFrag.texto.trim()`, sin recortar al prefijo numérico): un recorte por regex
  descartaba en silencio el token pegado, sin dejar rastro en `lineasNoInterpretadas` — corregido.
  Candidato a `referencias: [{ tipo: 'operacion', ... }]`, mismo rol que `COMPROB.` de Nación.
  🔴 **Deuda declarada, no bloqueante**: si un futuro documento real trae un fragmento de referencia
  con borde derecho `> 345` (más texto pegado del medido acá), `fragmentoDeColumna` no lo encuentra y
  la fila queda indistinguible de "sin referencia" — no hay hoy una señal de residuo para ese caso
  específico. Se revisa cuando aparezca.
- ✅ **`SALDO ANTERIOR` (fila 9), literal confirmado**: `SALDO ULTIMO EXTRACTO AL <fecha>` — la fecha
  va con **BARRA** (`dd/mm/yyyy`), no con guion — coherente con las otras dos etiquetas "…AL
  `dd/mm/yyyy`" del documento (`SALDO FINAL AL`, §H4.1), a diferencia del `PERIODO`/las fechas del
  cuerpo, que van con guion. El importe cae en la misma columna de saldo (`x=540.4`), confirmando
  `traeSaldoInicialDeclarado: true`.
- ✅ **Encabezado de columnas (fila 8), literal confirmado**: `FECHA CONCEPTO F.VALOR COMPROBANTE
  ORIGEN CANAL DEBITOS CREDITOS SALDOS` — 9 nombres de columna en 6 fragmentos geométricos (el
  fragmento de `x=212.8` resulta ser `F.VALOR COMPROBANTE ORIGEN CANAL`, cuatro etiquetas pegadas en
  un solo fragmento de `pdf.js`). 🔴 **Declarado ≠ medido, mismo principio de siempre**: el documento
  real solo puebla, de esas 4, la columna `COMPROBANTE` (el fragmento de 4 dígitos en `x≈305`, ya
  identificado en §1.1 como columna de referencia — encaja exacto con el nombre real de la columna).
  `F.VALOR`, `ORIGEN` y `CANAL` no tienen NINGÚN fragmento propio en ninguna de las 9 filas de
  movimiento medidas — se declaran `traeFechaValor: false` / sin capturar `origen`/`canal` hasta que
  un documento real los pueble, no se inventan vacíos.
- 🔴 **CORRECCIÓN 2026-08-26, sobre un supuesto que resultó falso — ver `docs/seguridad/
  registro-incidentes.md` #13.** El párrafo original de esta sección asumía, por analogía posicional
  con Nación, que fila 0 era el letterhead del banco y fila 4 el CUIT del banco. **Las dos cosas son
  del TITULAR, confirmado por JP**: fila 0 (bloque izquierdo, `x≈62-120`, tres líneas) es la razón
  social y el domicilio de MEB; fila 4-5 (bloque derecho, `x≈368`, misma columna donde caen período,
  hoja y sucursal) trae el **CUIT y la condición ante IVA del TITULAR**, no del banco — pese a estar
  agrupado con datos que sí son del documento/sucursal (HOJA N°, SUCURSAL, PERIODO). **El layout
  correcto**:
  - Bloque IZQUIERDO (filas 0-3): razón social + domicilio del titular (3 líneas). N2, nunca se lee
    crudo salvo lo ya autorizado por el pedido de la tarea (la razón social, que JP ya dio).
  - Bloque DERECHO (filas 1-6): mezcla — `RESUMEN MENSUAL` (fila 1, genérico), `PERIODO <fecha> AL
    <fecha>` (fila 2, genérico — **literal confirmado, con el conector `AL` en MAYÚSCULA y fechas con
    GUION, exactamente como predecía §1.1**), `HOJA N° NNNN` (fila 3, genérico), **`CUIT N°
    ##-########-#` + `IVA : <condición>` (filas 4-5, del TITULAR — nunca leer o loguear crudo)**,
    `SUCURSAL <ciudad>` (fila 6, genérico — atributo de la sucursal emisora, no del cliente).
  - `leerCuitTitular`/`titularCondicionIva` (Paso 2) tienen que anclar a este bloque derecho (fila
    4-5), NUNCA asumir "es del banco" por su posición — es exactamente el supuesto que falló acá.
  - **Ningún fragmento de la carátula medida contiene el nombre "ICBC" ni ningún otro nombre de
    banco.** `reconoceICBC` no puede anclar en una marca de letterhead como Bancor/Nación — se ancla
    en el **encabezado de columnas**, que sí es literal bancario genérico y ya fue leído con
    autorización: `FECHA CONCEPTO F.VALOR COMPROBANTE ORIGEN CANAL DEBITOS CREDITOS SALDOS` (fila 8),
    una secuencia de 9 palabras específica y poco probable de aparecer en el disclaimer de otro banco
    — mismo criterio de "ancla específica, no genérica" que corrigió `reconoceNacion` (spec de
    Nación §1).

## 2. Lo que este documento NO permite medir todavía

- **Multi-página / multi-cuenta**: el único documento real es de 1 página, 1 cuenta — mismo límite que
  Nación (`21-formato-nacion.md` §8, pregunta abierta de `tech-lead`).
- **Continuación de glosa**: ninguna fila de movimiento parece requerirla (concepto corto, cabe en su
  propio fragmento) — a confirmar contra un segundo documento.
- **Vocabulario de concepto**: no leído (fuera del alcance de esta medición, se lee con autorización en
  el Paso 2).

## 3. Respuesta directa a las cuatro hipótesis (resumen)

| # | Hipótesis | Resultado |
|---|---|---|
| 1 | ¿Rama genérica alcanza? | **NO** — hace falta 6ª rama geométrica (mismo patrón Bancor/Nación) |
| 2 | ¿DEBITOS/CREDITOS columnas separadas? | **SÍ** — `origenSigno: 'columna_separada'`, con signo `-` final redundante solo en DEBITOS |
| 3 | ¿Proporción de filas con SALDO? | **55,6% (5/9)**, sin patrón de intervalo fijo — se verifica por puntos de control, mecanismo YA existente en `verificarAritmetica`, sin cambios |
| 4 | ¿Estructura del bloque de totales? | **1 sola fila, 5 fragmentos, 3 valores** (2 totales de impuesto + saldo final con su fecha embebida) |
