# 21 — Formato Banco Nación (Banco de la Nación Argentina), extracto de cuenta corriente en PDF

> Medido contra el PDF real del cliente en `privado/extractos/.../Banco Cta - Cte/Nacion/Resumen
> bancario Nacion 06-2026.pdf` (1 página, 43 filas geométricas vía `aFilas()`/`pdf.js`), con la misma
> disciplina que `20-formato-bancor.md`: **solo estructura y geometría, ningún dato real**. Toda
> medición se hizo por `formaParaLog` (dígitos y letras enmascarados) o, para el letterhead y la
> etiqueta regulatoria del anexo (información bancaria/normativa genérica, no dato del cliente — ver
> §1 y §6), lectura directa acotada a esas filas puntuales, nunca a la carátula del titular ni a los
> movimientos.

## 0. Contexto: cliente real y por qué esta cuenta se ve tan chica

Cliente detrás del extracto: **HYJ SAS**, mismo cliente que BBVA (bloqueado — ver `20-formato-
bancor.md` §0 para el precedente de un banco descartado por imagen pura; BBVA sigue igual). Esta es
la primera vía real para tener movimientos de HYJ en el sistema.

🔴 **El documento real mide UN SOLO movimiento en todo el período** (29/05/2026 al 30/06/2026). No es
una falla de lectura — `paginas=1`, `filas geométricas=43`, `esquema Zod: valida`, `VEREDICTO DEL
LOTE: cuadra` contra el archivo real — es una cuenta de muy baja actividad ese mes. **Consecuencia
directa: varias decisiones de este documento están medidas contra una muestra de UNO** y se marcan
así explícitamente en vez de presentarse como regla firme del banco. El fixture sintético de
`nacion.test.ts` cubre los casos que el documento real no ejercita (múltiples movimientos, mezcla de
débito/crédito, concepto largo) — inventados, no medidos, con la MISMA geometría de columnas.

## 1. Reconocimiento del documento

Letterhead partido en **dos filas** (a diferencia de Bancor, que trae el nombre del banco en una
sola línea): `BANCO DE LA` / `NACION ARGENTINA`. Información pública del banco, no dato del cliente.

**Marcas de reconocimiento** (líneas 0-1 del documento, EXIGIDAS CONSECUTIVAS):
- `BANCO DE LA`
- `NACION ARGENTINA`

🔴 **Hallazgo de `tester`: exigir las dos marcas en cualquier posición de las primeras 15 filas era
un ancla débil.** Son dos líneas cortas y genéricas — "NACION ARGENTINA" en particular puede
aparecer en el disclaimer de CUALQUIER banco que mencione al Banco de la Nación Argentina como
tercero, y si `pdf.js` la envuelve en su propia fila geométrica, un documento de otro banco quedaría
mal reconocido como Nación. `reconoceNacion` exige que las dos marcas aparezcan en filas
CONSECUTIVAS — la adyacencia real del letterhead medido (filas 0 y 1), no solo la presencia de las
dos en algún lugar del rango.

Seguido de (fila 2) una numeración interna del banco (`HOJA: NN`) que **no es la paginación de este
PDF** — es la numeración de hoja dentro de un reporte más amplio del banco, no se usa como
`paginasDeclaradas` (ver §8). Fila 3: el **CUIT del banco** (`CUIT ##-########-# IVA RESPONSABLE
INSCRIPTO`, con dashes y sin dos puntos) — **nunca confundir con el CUIT del titular** (§2, que trae
la etiqueta `CUIT:` con dos puntos, en fragmento separado del número). Fila 4: código de sucursal
(`SUC:###`).

## 2. Carátula (una sola vez, única página)

Entre el encabezado y el cuerpo: bloque con razón social + domicilio del titular, el **CUIT del
titular como DOS fragmentos** (`CUIT:` y el número de 11 dígitos, sin dashes, en un fragmento
posterior de la misma fila — a diferencia del CUIT del banco, que trae dashes y va pegado en un solo
fragmento con su leyenda), y el período.

**El período viene en UN SOLO fragmento** (`"<etiqueta>: dd/mm/yyyy AL dd/mm/yyyy"`), a diferencia
de Bancor, que trae las dos fechas del período como dos fragmentos sueltos en la misma fila. Se
resuelve con un regex sobre el texto ya unido de la fila (`RE_PERIODO`), no contando fragmentos de
fecha.

🔴 **El período declarado empieza un día antes del mes calendario**: `29/05/2026 AL 30/06/2026` para
el corte de junio. Se captura **tal cual lo declara el documento** — nunca se fuerza al primer día
del mes — porque es el ciclo que el banco define, no un recorte. `coberturaPeriodo: 'completo'` en
`cuentaDetectadaSchema` (ver `esquema.ts`): es el ciclo COMPLETO tal como Nación lo declara, no una
cobertura parcial.

Más abajo en la carátula: el número de cuenta (**10 dígitos corridos, sin etiqueta textual propia
medida** — se ancla por forma, `RE_NUMERO_CUENTA_NACION`) y el CBU (**22 dígitos corridos, sin
etiqueta propia**, mismo criterio que Bancor con su propio CBU).

## 3. El encabezado de columnas — confirmado por longitud de forma

Fila 17 trae 6 fragmentos cuya longitud de forma coincide exactamente con el literal esperado:

| Columna | `x` del encabezado | Forma medida |
|---|---|---|
| FECHA | 74.7 | `AAAAA` (5) |
| MOVIMIENTOS | 137.1 | `A{11}` (11) |
| COMPROB. | 242.7 | `AAAAAAA.` (7+punto) |
| DEBITOS | 324.3 | `AAAAAAA` (7) |
| CREDITOS | 415.5 | `A{8}` (8) |
| SALDO | 525.9 | `AAAAA` (5) |

## 4. El cuerpo — fecha y concepto vienen PEGADOS en un mismo fragmento

🔴 **Diferencia real contra los cinco bancos anteriores, medida contra UN SOLO movimiento — no se
generaliza como regla firme de Nación.** En la fila del movimiento medida, el primer fragmento (banda
`x < 235`) es `dd/mm/aa<resto sin espacio>`: fecha y arranque del concepto **fusionados por `pdf.js`
en un único fragmento**, sin el espacio que separa fecha de concepto en Galicia/Santander/Macor/
Bancor. El resto del concepto, si lo hay, puede seguir en fragmentos adicionales dentro de la misma
banda (medido: dos fragmentos cortos adicionales en la única fila real).

**Por qué no se declara sistemático:** un concepto corto pudo fusionarse con la fecha por casualidad
geométrica (poco espacio entre columnas cuando el token es corto); un concepto largo podría empezar
más separado, o partirse distinto. **Revisar cuando llegue un segundo documento real de este banco**
— el fixture sintético (`nacion.test.ts`) cubre la MISMA geometría con un concepto largo para no
depender solo de la muestra real, pero eso es un caso inventado, no una segunda medición.

El adapter resuelve esto con un regex sobre el texto YA UNIDO de la banda `[0, 235)`
(`fragmentosEnBanda` + `RE_FECHA_Y_RESTO = /^(\d{2}\/\d{2}\/\d{2})\s*(.*)$/`), no con
`fragmentoEnX` por fragmento — la fusión hace que no exista una columna `fecha` propia medible por
`x` distinta de la banda concepto.

**La fecha SÍ trae año** (`dd/mm/aa`, 2 dígitos) — a diferencia de Bancor/Macor, que no lo traen.
`anioEnLaFecha: true`. `parsearFecha` ya soporta año de 2 dígitos nativamente (`packages/ingesta/src/
parseo-ar.ts`), sin cambios.

Las columnas de importe, medidas (puntos PDF, ventana por borde derecho — `fragmentoDeColumna`,
`nacion.ts`):

| Campo | ventana `[desde, hasta]` | Medido |
|---|---|---|
| COMPROB. | `[235, 300]` | fragmento de 3 dígitos, borde derecho real 276.5 |
| DEBITOS | `[302, 390]` | fragmento de importe, borde derecho real 372.5 |
| CREDITOS | `[392, 495]` | 🔴 **sin dato real** (la única fila medida es un débito) — ver nota abajo |
| SALDO | `[497, 575]` | fragmento de importe, borde derecho real 564.5 |

🔴 **Las cuatro ventanas dejan 2pt de zona muerta entre cada una — hallazgo real de `tester`, no
prolijidad.** `fragmentoEnVentanaDerecha` es inclusiva en los DOS extremos; con ventanas contiguas
(`debito.hasta === credito.desde`, etc.), un fragmento cuyo borde derecho cae EXACTO en el valor
compartido matchea las dos ventanas vecinas a la vez. `tester` lo reprodujo con un crédito en
`x=500`: ese mismo fragmento ganaba también la búsqueda de `saldo` (por `.find()`, que devuelve el
primero en orden de `x`) y **reemplazaba el saldo real en silencio**, sin ningún código en
`lineasNoInterpretadas` — el peor modo de falla del módulo. Con el margen de 2pt, un valor en la
zona muerta no matchea ninguna ventana (falla cerrada, se reporta como dato ausente) en vez de
matchear dos a la vez (falla silenciosa).

🔴 **Segundo hallazgo, de `code-reviewer`, distinto del de arriba: un fragmento de la banda de
concepto también puede colar por su borde DERECHO.** `fragmentoEnVentanaDerecha` busca por borde
derecho sobre TODOS los fragmentos de la fila, sin mirar el izquierdo — un fragmento de concepto
(borde izquierdo `< 235`, por eso cuenta como concepto) puede tener el borde derecho cayendo igual
dentro de la ventana de `COMPROB.` (texto largo, o `ancho` mal reportado por `pdf.js`, ya medido en
`06-formato-santander.md` §11.2), y por tener menor `x` gana el `.find()` antes que el dato real de
la columna. Reproducido de verdad mientras se escribía el fixture de test. `fragmentoDeColumna`
(`nacion.ts`, reemplaza el uso directo de `fragmentoEnVentanaDerecha`) exige además que el
candidato tenga el borde IZQUIERDO `>= 235` — cierra este segundo vector sin reabrir el primero.

🔴 **La ventana CREDITOS es la única de las cuatro que nunca se ejerció contra el documento real.**
No es un supuesto de borde (como era `saldo` antes de la corrección) — es una ventana completamente
sin medir, elegida por simetría con `DEBITOS` respecto del encabezado (`x=415.5`). El fixture
sintético (`nacion.test.ts`) la usa como valor plausible, declarado como inventado en su propio
comentario, no como medición. **Revisar contra el primer documento real de Nación que traiga un
crédito** — mismo tipo de corrección que ya tuvo `saldo` en esta misma tarea (hallazgo de
`tech-lead`).

🔴 **La ventana de SALDO se corrigió de `[500, 560)` a `[500, 575)` contra el borde derecho real
(564.5), no contra el borde izquierdo del fragmento (545.1).** La primera versión, basada solo en el
`x` izquierdo visto en el diagnóstico de carátula, dejaba el importe justo AFUERA de la ventana y
`fragmentoEnVentanaDerecha` devolvía `undefined` en el 100% de las filas de saldo (incluidas `SALDO
ANTERIOR`/`SALDO FINAL`) — mismo tipo de corrección que ya tuvo `bancor.ts` con su propia columna
`saldo` (`20-formato-bancor.md` §3, nota 🔴 sobre `importe`/`saldo`). Corregido y reverificado contra
el archivo real: `VEREDICTO DEL LOTE: cuadra`, `saldoInicialDeclarado=sí saldoFinalDeclarado=sí`.

**DEBITOS y CREDITOS son columnas separadas, sin token de signo redundante** —
`traeSignoEnElImporte: false`, mismo mecanismo que Santander/Macro (a diferencia de Bancor, que
deriva el signo de la cadena de saldos porque no tiene columnas separadas). `origenSigno:
'columna_separada'` en cada movimiento (campo nuevo de `esquema.ts`, ver `HANDOFF.md`). Exactamente
una de las dos columnas tiene que traer un importe por fila — ninguna, o las dos, se reporta como
`importe_en_columna_desconocida` en vez de adivinar.

## 5. `SALDO ANTERIOR` / `SALDO FINAL` — dos fragmentos separados, no un literal único

🔴 **Diferencia explícita respecto de Bancor, no una variante menor.** Bancor trae `SALDO RES.
ANTERIOR` como UN SOLO literal (`RE_SALDO_ANTERIOR` de `bancor.ts` matchea ese string entero). Acá
`SALDO` y `ANTERIOR` (o `FINAL`) son DOS fragmentos geométricos separados, con el importe en un
tercer fragmento en la ventana de SALDO. La distinción **no cambia la detección por texto** —
`textoDeFila` une los fragmentos igual, así que `RE_SALDO_ANTERIOR = /^SALDO\s+ANTERIOR\b/i` matchea
sin problema sobre el texto ya unido — pero es una geometría de origen distinta que un futuro banco
con fragmentos sueltos (en vez de literales pre-armados) puede necesitar tener en cuenta si alguna
vez hiciera falta anclar por `x` en vez de por texto.

🔴 **Fail-closed explícito, hallazgo de `tester`: sin importe legible en la ventana de SALDO, la fila
NUNCA queda marcada `saldoDeclarado` en silencio.** La ventana de SALDO ya falló una vez en esta
misma tarea (nota de §4) — sin este guardrail, la próxima vez que la ventana esté mal medida,
`cuenta.saldoInicialDeclarado`/`saldoFinalDeclarado` quedarían `undefined` sin ningún rastro en
`lineasNoInterpretadas`, y la fila igual contaría como "esto se leyó". Ahora reporta
`fila_sin_importe` y el destino de la fila pasa a `residuo`.

## 6. El anexo — Ley 25413, mismo mecanismo que Bancor

Después de `SALDO FINAL`, una fila con el bloque de gravamen: **`TOTAL GRAV. LEY 25413 DEL MES DE
<mes>`**, seguido de `$` y el importe. El nombre del mes (confirmado contra el documento real: fijo
en su forma regulatoria, variable en el mes que nombra) **nunca se hardcodea** — es un hecho del
período, no del banco (`RE_ETIQUETA_LEY_25413` acepta cualquier mes). El `conceptoLiteral` persistido
es el texto completo tal como lo escribe el banco, mes incluido — no se recorta a una forma fija,
porque el propio campo (`anexoExtractoSchema.conceptoLiteral`, `esquema.ts`) documenta "no se
normaliza".

Se reusa **tal cual** el mecanismo de `bancor.ts`: el signo `$` decide primero "esto no es un
movimiento" (`RE_TOTAL_CON_SIGNO_PESOS`), y DESPUÉS se intenta anclar el literal conocido. `atribucion
Cuenta: 'cuenta_unica_del_lote'` (documento de una sola cuenta, igual que Bancor). `relacionConMovi
mientos: 'no_determinada'` — fail-closed: no hay cruce verificado contra el cuerpo, a diferencia de
las dos etiquetas de Bancor que sí lo tienen (`verificarTotalesBancor`); acá no se midió un concepto
de movimiento equivalente al gravamen para cruzar.

## 7. El bloque legal / disclaimer — texto corrido, cuenta como `fueraDelCuerpo`

Después del anexo: un bloque de texto corrido (disclaimer de depósitos, con una URL institucional
incluida) que se extiende por el ancho completo de la página en varias filas. **No tiene la forma de
una continuación de glosa** (fragmentos más allá de `x=235`, a diferencia de una continuación
legítima que solo tiene contenido dentro de la banda `[0, 235)`) — se cuenta como `fueraDelCuerpo`,
mismo criterio que el pie legal de Galicia/Santander/Macro/Bancor. Después: filas separadoras
(`____`) y un pie de página con la numeración interna del banco.

## 8. Continuación de glosa — diseñada, no medida contra un segundo documento

🔴 **El documento real no tiene ningún caso de continuación de glosa** (el único movimiento cierra
completo en su propia fila, igual que Bancor). La regla del adapter — mientras hay un movimiento
abierto, una fila cuyo contenido cae ENTERO dentro de la banda `[0, 235)` (sin ningún fragmento a la
derecha) se trata como continuación — está **diseñada por analogía con Bancor, no confirmada contra
un segundo caso real de Nación**. Revisar cuando aparezca un documento con glosas largas.

**A propósito, NO se reporta como residuo una fila con esa misma forma cuando NO hay movimiento
abierto** (a diferencia de `bancor.ts`, que sí lo hace con su propio patrón de continuación,
`/^\d{5,}/`, mucho más específico por contenido). Medido contra el documento real: la fila 5 de la
carátula (nombre/domicilio del titular) tiene exactamente esa forma geométrica — banda angosta, sin
`$`, sin movimiento abierto — y es carátula legítima, no una anomalía. Inventar una regla de residuo
por forma geométrica sola, sin un contenido distintivo que la acote (como sí tiene Bancor), generaría
falsos positivos sobre la carátula de **todo** documento de Nación.

🔴 **Pregunta abierta, no resuelta acá (hallazgo de `tech-lead`): ¿se repite la carátula por página en
un documento Nación multi-página?** El único documento real es de 1 sola página, así que esto no se
pudo medir. Si la carátula SÍ se repitiera por página (como el letterhead de Bancor/Galicia), la
asimetría de este §8 seguiría siendo correcta — sigue siendo carátula, no una continuación huérfana
real —, pero conviene confirmarlo con el primer documento real de Nación de más de una página, en vez
de asumirlo por analogía con otros bancos.

## 9. Capacidades declaradas

| Capacidad | Valor | Medido / diseñado |
|---|---|---|
| `familiaLayout` | `columnas-posicionales` | medido (encabezados con literal propio, §3) |
| `cadenaDeSaldos` | `completa` | medido sobre 1 movimiento — **no confirmado sobre un universo** |
| `traeTotalesDeclarados` | `false` | no medido ningún total de créditos/débitos separado |
| `traeSaldoInicialDeclarado` | `true` | medido (`SALDO ANTERIOR`) |
| `traeSignoEnElImporte` | `false` | medido (columnas DEBITOS/CREDITOS separadas) |
| `traeSaldoPorFila` | `true` | medido sobre 1 movimiento |
| `traeFechaValor` | `false` | no medida columna de fecha valor |
| `traeReferencia` | `true` | medido (COMPROB.) |
| `traeCodigoDeConcepto` | `false` | no medido código de concepto separado |
| `anioEnLaFecha` | `true` | medido (`dd/mm/aa`) |
| `multiCuenta` | `false` | 1 página, 1 cuenta |
| `multiMoneda` | `false` | sin evidencia de USD |
| `traeMovimientosFueraDelPeriodo` | `false` | conservador, no medido (1 solo movimiento, dentro del período) |
| `traeConsolidadoPorMoneda` | `false` | no aplica, cuenta única |
| `declaraDestinos` | `true` | instrumentado desde el día uno |

## 10. Lo que NO se resuelve en esta tarea

- **ICBC** queda afuera (particularidad propia: columna de saldo no publicada en todas las filas —
  se mide aparte).
- **Ningún wrapper de cliente explícito** en el adapter — mismo criterio ya descartado por
  `tech-lead` para Bancor: no hay caller real en el pipeline que lo use.
- El digest por renglón (para citar "de qué línea de qué documento salió un dato") **no es un campo
  de este contrato** — es columna generada por Postgres, capa de persistencia, pendiente de
  `documento_ingerido` (ver `HANDOFF.md`).
