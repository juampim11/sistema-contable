# 16 — Research: preprocesamiento de imagen para `neto_acreditado` — refutado con evidencia, con una alternativa distinta medida

> 🔴 **PLAN DE RESEARCH — NO IMPLEMENTADO.** Ningún archivo de código de este documento existe
> todavía: ni dependencia nueva, ni cambio a `ocr.ts`/`texto-pdf.ts`/`visa-debito.ts`, ni cambio al
> gate. `pnpm verificar` sigue en `72 archivos / 1599 tests / 0 fallas` (HANDOFF, entrada 82) — este
> documento no lo movió porque no tocó código de producto. Escrito por `arquitecto-software`
> (convocado con `Agent()` real, este mismo documento es su dictamen), con experimentación real
> contra el documento del cliente, ejecutada y medida en esta sesión — no una comparación de folleto.

## Contexto

`docs/diseno/14-liquidaciones-tarjeta-plan.md` → commit 2 (adapter Visa débito) →
`docs/diseno/15-ocr-liquidaciones-plan.md` (OCR local con `tesseract.js`, implementado) →
`HANDOFF.md` entradas 80/81/82: el adapter de Visa débito cierra hoy **5 de ~21 liquidaciones** del
documento real (`privado/tarjetas/01-extracto_visa_debito_roka.pdf`). El campo `neto_acreditado`
—uno de los tres obligatorios para cerrar un bloque, junto a `ventasBrutas` y
`fechaPresentacion` (`cerrarLiquidacion`, `visa-debito.ts`)— falla en **14 de 21 filas medidas
(67 %)**. Diagnóstico carácter-por-carácter ya hecho (HANDOFF 81): el separador de miles/decimal
desaparece de la lectura OCR sin dejar rastro reconstruible, en seis tokens distintos. Ya se
descartó, con evidencia, tocar `parsearImporte`/`parseo-ar.ts` — aflojar la tolerancia produce un
importe con la magnitud y los centavos equivocados que pasa la validación como si fuera bueno, peor
que rechazarlo.

**Hipótesis a investigar, la que JP pidió**: el recuadro/énfasis visual que probablemente rodea la
línea del total final interfiere con la segmentación de caracteres de Tesseract — preprocesar la
imagen antes de `reconocerImagen()` podría resolverlo.

**Resultado de esta sesión, adelantado acá porque cambia el resto del documento**: la hipótesis del
recuadro **no se sostiene** frente a la evidencia medida. Lo que sí resuelve el síntoma —de forma
completa y reproducible, en la muestra medida— es **aislar la región de la fila en un recorte propio
antes de pedirle a Tesseract que la lea**, sin tocar un solo píxel. Ninguna técnica de
preprocesamiento probada (seis en JS puro, seis con OpenCV) supera a ese recorte solo; varias lo
empeoran. La consecuencia práctica es que **no hace falta ninguna dependencia nueva** —ni `sharp`,
ni `jimp`, ni Python/OpenCV— para este síntoma puntual.

### Corrección de una premisa del pedido, verificada antes de asumirla

El pedido decía *"`sharp` ya está en este repo — confirmalo vos mismo"*. Se confirmó, y es **falso**:
`grep` sobre todos los `package.json` del monorepo y sobre `pnpm-lock.yaml` no encuentra `sharp` ni
`jimp` en ninguna parte. No hay ninguna librería de manipulación de imagen instalada hoy —
`tesseract.js` es la única pieza de imagen del repo. Esto importa porque cambia el costo real de
"agregar preprocesamiento": no es aprovechar algo que ya está, es una dependencia nueva de punta a
punta (con o sin binarios nativos según la elección), con el costo que eso implica en CI y en los
cuatro entornos de despliegue de ADR-0000 §6. Dato que queda sin efecto práctico acá porque la
recomendación final es no agregar nada, pero que hay que corregir para que no quede flotando en la
próxima conversación.

---

## 0. Metodología del experimento — qué se midió y cómo

**Disciplina anti-fuga aplicada de punta a punta** (detalle de cumplimiento en la sección final): los
bytes de imagen se mantuvieron en memoria del proceso Node de punta a punta; el intercambio con el
subproceso Python fue por bytes en memoria (`cv2.imdecode`/`imencode` sobre buffers, sin archivo);
nunca se imprimió ni logueó texto reconocido por OCR ni la imagen; lo único persistido son dos
archivos de estructura pura (geometría en píxeles + conteos pass/fail + confianza numérica), sin
contenido, en el scratchpad de la sesión — borrados al cerrar (confirmado al final).

### Fase 1 — localizar el síntoma, sin tocar nada

Se corrió el pipeline real (`extraerConOcrSiHaceFalta` + `reconocerImagen`, sin modificar) contra las
8 páginas del documento real, agrupando palabras en filas con la **misma tolerancia** que usa el
adapter (20 px) y aplicando la **misma regla de reconocimiento** de la línea de `neto_acreditado`
(`t.includes('IMPORTE') && t.includes('NETO') && t.includes('PAGO')`, normalizada). Resultado:
**21 filas candidatas, 7 pasan / 14 fallan** — coincide exactamente con lo ya reportado en HANDOFF 81,
medido de forma independiente en esta sesión como control de que el punto de partida es el correcto.

### Fase 2 — candidatas de preprocesamiento, contra una muestra real

Se seleccionaron **9 filas** de las 21: **6 que fallaban** (una por página, páginas 2 a 7, para no
concentrar la muestra en una sola liquidación) y **3 que ya pasaban** (páginas 1, 4 y 6, como control
de regresión — si una técnica arregla lo roto pero rompe lo sano, no es una mejora neta). Para cada
fila se extrajo el recorte de píxeles crudos de esa página (vía `unpdf.extractImages`, la misma ruta
que ya usa `imagenDePagina` — nunca se rasterizó de nuevo ni se tocó `texto-pdf.ts`), con **±50 px de
margen vertical y el ancho completo de la página** (para no asumir dónde empieza o termina un
eventual recuadro).

Se probaron **trece variantes** por fila — el recorte sin tocar (control) más doce técnicas:

**JS puro, sin dependencia nueva** (seis):
| Técnica | Qué hace | Apunta a |
|---|---|---|
| `j0_original` | el recorte, sin ningún procesamiento | control — mide el efecto de AISLAR, no de preprocesar |
| `j1_upscale_bilinear_3x` | reescala 3× por interpolación bilineal | resolución del trazo del separador |
| `j2_otsu_global` | binarización con umbral de Otsu (histograma global) | contraste global |
| `j3_adaptativo_local` | umbral local por media de bloque (ventana 31 px, vía imagen integral) | binarización adaptativa |
| `j4_contraste_percentil` | estiramiento de contraste (recorte percentil 2–98) | contraste local aproximado |
| `j5_lineas_heuristica` | detecta corridas oscuras continuas (fila/columna) y las blanquea | **la hipótesis del recuadro, directo** |
| `j6_combo` | contraste + adaptativo + upscale 2× | mejor combinación ingenua |

**Python/OpenCV, en un venv aislado, nunca instalado en el repo** (seis):
| Técnica | Qué hace | Apunta a |
|---|---|---|
| `p1_adaptive_threshold_gaussian` | `cv2.adaptiveThreshold`, gaussiano, ventana 31 | binarización adaptativa real (no aproximada) |
| `p2_clahe_otsu` | CLAHE (contraste local real, no disponible en JS puro) + Otsu | contraste local real |
| `p3_eliminacion_lineas` | apertura morfológica con kernels rectangulares largos (horizontal + vertical) + resta | **la hipótesis del recuadro, con la herramienta correcta para eso** |
| `p4_upscale_cubic_3x` | `cv2.resize` interpolación cúbica, 3× | resolución, sin modelo entrenado |
| `p5_denoise_adaptive` | `fastNlMeansDenoising` + umbral adaptativo | ruido tipo escaneo de celular/CamScanner |
| `p6_pipeline_combinado` | denoise + eliminación de líneas + CLAHE + upscale | el intento de "mejor caso realista" |

Cada variante se volvió a codificar como PNG (mismo formato que produce `imagenDePagina` hoy) y se
pasó, sin cambios, a `reconocerImagen()` de `ocr.ts` — la función real de producción, no una
reimplementación. Se midió, por variante: si algún token de la fila ahora tiene forma de importe
válida según `parsearImporte` (booleano), y la confianza cruda de Tesseract del token encontrado
(0–100, dato numérico, no el texto). Nunca se registró el texto reconocido.

**Deskew evaluado y descartado de la lista de candidatas**: la tolerancia de fila (20 px, ya
calibrada contra el documento real) existe precisamente para absorber la inclinación típica de un
escaneo con celular, y el recorte de esta prueba es demasiado angosto en altura (~130 px) para que
una rotación residual mueva el separador de columna en un carácter — no hay mecanismo plausible por
el que enderezar la imagen antes de OCR cambie el resultado en un recorte de esta escala. No se
gastó tiempo de cómputo probándolo sin motivo.

---

## Resultado agregado (9 filas × 13 variantes = 117 corridas de OCR reales)

| Técnica | Recupera importe | Confianza promedio cuando recupera |
|---|---|---|
| `j0_original` (recorte solo, sin tocar un píxel) | **9/9** | **94,0** |
| `j5_lineas_heuristica` (JS, hipótesis del recuadro) | 9/9 | 94,0 |
| `j4_contraste_percentil` | 9/9 | 93,8 |
| `p2_clahe_otsu` (Python) | 9/9 | 91,3 |
| `j3_adaptativo_local` | 9/9 | 88,1 |
| `p5_denoise_adaptive` (Python) | 9/9 | 87,3 |
| `j6_combo` | 9/9 | 85,6 |
| `p1_adaptive_threshold_gaussian` (Python) | 8/9 | 85,3 — **regresión**: rompe una fila que el recorte solo resolvía |
| `p3_eliminacion_lineas` (Python, hipótesis del recuadro **con la herramienta correcta**) | 9/9 nominal | **79,4 — la más baja de todas**, incluye al menos un caso de confianza 0 (un token con forma de importe pero sin respaldo real de reconocimiento) |
| `j1_upscale_bilinear_3x` | 4/9 | 96,0 cuando corre — **bloqueada 5/9 veces** por el límite de tamaño existente (ver abajo) |
| `p4_upscale_cubic_3x` (Python) | 4/9 | 95,3 — mismo bloqueo |
| `p6_pipeline_combinado` (Python) | 4/9 | 88,5 — mismo bloqueo, y hereda la debilidad de `p3` |

### Lectura del resultado, sin adornos

1. **Aislar la fila en su propio recorte, sin ningún preprocesamiento, resuelve el 100 % de la
   muestra fallida** (6/6) y no rompe ninguna de las 3 que ya pasaban (9/9 total). La confianza
   promedio (94,0) es la más alta de las trece variantes, empatada con la única técnica de
   preprocesamiento que la iguala.
2. **La técnica que apunta directo a la hipótesis del recuadro con la herramienta correcta para esa
   tarea (`p3`, morfología de OpenCV) es la que peor rinde entre las que "funcionan"** — la confianza
   más baja de toda la tabla, con al menos un caso de recuperación espuria (confianza 0: un token
   que tiene forma de importe por casualidad, no porque el reconocimiento haya sido real). Esto
   **refuta la forma fuerte de la hipótesis de JP**: no es el recuadro lo que corrompe el separador,
   porque limpiarlo específicamente no ayuda más que no hacer nada, y en la variante Python del
   mismo objetivo, ayuda menos y con peor calidad.
3. **Ninguna técnica de preprocesamiento supera al recorte solo.** Las que empatan (`j5`, `j4`) no
   agregan nada sobre aislar; las que quedan por debajo (`j3`, `j6`, `p1`, `p2`, `p5`) restan
   confianza sin ganar cobertura; `p1` directamente introduce una regresión.
4. **El upscaling queda bloqueado por una guarda de producción ya existente y correcta.**
   `MAX_DIMENSION_PX = 6000` en `ocr.ts` (comentario: *"el doble de una página A4 a 300dpi ya es
   sospechoso"*) rechaza el recorte ×3 en la mayoría de los casos: el ancho de página real del
   documento (1963–2110 px) × 3 da 5889–6330 px, a caballo del límite. No se está proponiendo tocar
   ese límite — es una guarda de seguridad deliberada (`security-engineer`, plan 15) contra un PDF
   corrupto o una imagen desproporcionada — pero cualquier estrategia futura de upscaling tiene que
   dimensionarlo contra este límite antes de asumir que funciona.
5. **Mecanismo probable, no probado línea por línea**: la explicación más consistente con "el mismo
   píxel produce un resultado distinto según cuánta página lo rodea" es que la segmentación
   automática de página de Tesseract (PSM automático, sin fijar en `ocr.ts` hoy) se confunde con
   varios bloques de liquidación visualmente similares repetidos en una página densa, y agrupa o
   recorta mal la región del total final cuando compite con el resto del layout. No se instrumentó
   la salida de segmentación de Tesseract para confirmarlo con certeza — es la explicación más
   simple compatible con el patrón medido, no una afirmación cerrada.

### Honestidad sobre el alcance de la muestra — no sobregeneralizar

- Se midieron **6 de las 14 filas que fallan** (43 %), no las 14. Elegidas para cubrir páginas
  distintas, no una liquidación particular — pero siguen siendo del **mismo documento, mismo cliente,
  mismo lote de escaneo**. No hay evidencia todavía de que el mismo patrón se repita en Visa crédito,
  Cabal, o un documento futuro de otro comercio.
- El resultado es "recuperación estructural" (¿el token ahora tiene forma de importe válida?), no
  "el valor es el correcto". No se pudo verificar el valor real por la disciplina anti-fuga —
  verificarlo con exactitud es del resorte del eje aritmético (`verificarAritmeticaPorLiquidacion`)
  cuando esto se implemente, no de esta investigación.
- **9 filas es una muestra chica.** El punto de este research no es cerrar el número final, es
  decidir la **dirección** de la próxima inversión (recorte-y-reintento, no una librería de imagen) con
  evidencia real en vez de la hipótesis de partida. La medición completa contra las 14 filas queda
  como parte del "Qué se mide" de la implementación futura (§2).

---

## 1. Qué cambia y qué no (cuando se implemente — nada de esto existe todavía)

### Cambia

- **Estrategia: reintento de OCR sobre un recorte aislado, no preprocesamiento de imagen.** Cuando
  el adapter reconoce la ETIQUETA de una línea de total (`LINEAS_DE_TOTAL` ya la matchea hoy) pero
  `leerLineaDeTotal` no encuentra un importe válido, en vez de reportar `renglon_sin_monto`
  directamente, se recorta la región de esa fila (el `y` de la fila, ya calculado por
  `agruparPalabrasEnFilas`, con el mismo margen medido en este research) y se vuelve a pedir
  reconocimiento **solo de ese recorte**. Si el reintento produce un importe válido, se usa (con su
  propia confianza de Tesseract, por el eje 4 ya existente); si no, se reporta `renglon_sin_monto`
  como hoy — el reintento es un intento adicional, nunca reemplaza el resultado si el primer paso ya
  funcionó.
- **Cero dependencia nueva.** Ni `sharp`, ni `jimp`, ni Python/OpenCV. El único trabajo nuevo es de
  arquitectura interna: exponer los píxeles crudos de una página **antes** de que `imagenDePagina`
  los empaquete en PNG. Hoy `imagenDePagina` (`texto-pdf.ts`) hace las dos cosas juntas
  (`extractImages` → elegir la de mayor área → codificar PNG) sin un punto medio reusable. Se separa
  en dos: una función que da los píxeles crudos (`{data, width, height, channels}`, el tipo que
  `unpdf.extractImages` ya devuelve) y `imagenDePagina` como envoltorio delgado sobre eso que sigue
  dando exactamente el mismo PNG que da hoy — refactor puro, sin cambio de comportamiento
  observable para los llamadores existentes.
- **El recorte y el segundo `reconocerImagen()` viven dentro de `ocr.ts`**, que sigue siendo el
  único importador de `tesseract.js` (R-P intacta, sin segundo punto de conexión). Candidato de
  firma: `reconocerRecorte(pixeles: PixelesDePagina, y0: number, y1: number): Promise<PaginaOcr>` —
  cropea, codifica a PNG (reusa el mismo encoder que ya existe adentro de `texto-pdf.ts`, movido o
  compartido, no duplicado dos veces) y llama a `reconocerImagen` con el resultado.
- **El punto de enganche es genérico, no específico de `neto_acreditado`.** La medición de este
  research se concentró en esa línea porque es el cuello de botella medido, pero el mecanismo
  (etiqueta reconocida + importe no parseable → reintento aislado) aplica igual a las otras cuatro
  líneas de `LINEAS_DE_TOTAL` (`ventas_brutas`, `arancel`, `iva_21_sobre_arancel`,
  `retencion_iibb_sirtac`, `percepcion_iva_rg2408`) sin código adicional por concepto — es la misma
  rama de `leerVisaDebito` la que hoy construye `renglon_sin_monto`, y el reintento se inserta ahí
  una sola vez.
- **El eje 4 (confianza de captura) no cambia de diseño.** Un valor recuperado por reintento sigue
  pasando por `evaluarConfianzaDeCaptura` con la confianza real que le dé Tesseract en ese segundo
  pase — si el reintento recupera el token pero con confianza baja, cae en `dudoso` igual que hoy,
  correctamente. El mecanismo de seguridad existente ya cubre este caso sin que este plan tenga que
  inventar nada nuevo.

### No cambia — alcance explícito, a propósito

- **`parsearImporte`/`parseo-ar.ts` no se toca.** Sigue siendo estricto — la decisión de HANDOFF 81
  se reafirma: el reintento cambia CUÁNTO de la página ve Tesseract, nunca cuánta tolerancia tiene el
  parser. Son palancas distintas; esta investigación midió la primera, la segunda ya se descartó con
  evidencia en una sesión anterior.
- **Ninguna dependencia de imagen nueva** — ni ahora ni, según lo medido, en el horizonte cercano de
  este síntoma puntual. `sharp`/`jimp`/Python-OpenCV quedan **evaluados y no adoptados**, con el
  motivo (ninguna mejora medida sobre aislar el recorte) para que la próxima vez que alguien
  proponga "¿probamos con `sharp`?" la respuesta ya esté escrita — mismo criterio que
  `docs/seguridad/registro-terceros.md` usa para los servicios de OCR en la nube.
- **`ocr.ts` sigue con un worker por llamada** (diseño ya documentado y vigente). El reintento
  significa más llamadas a `reconocerImagen`, no un cambio al ciclo de vida del worker — dimensionar
  el costo de latencia agregado es parte de "Qué se mide" (§2), no se resuelve acá.
- **`MAX_DIMENSION_PX`/`MAX_BYTES_IMAGEN`/`TIMEOUT_RECONOCIMIENTO_MS` no se tocan.** El upscaling no
  forma parte de la recomendación, así que no hace falta revisar el límite que lo bloquea.
- **Nada de esto se implementa en esta sesión.** Research + arquitectura únicamente.
- **Visa crédito y Cabal, sin tocar.** Este research es sobre Visa débito, el único adapter que
  existe hoy.

---

## 2. Qué se mide (cuando se implemente)

- Contra las **14 filas completas** que fallan hoy (no solo las 6 de la muestra de este research):
  ¿cuántas recupera el reintento-sobre-recorte? La predicción falsable de abajo separa los casos.
- Regresión: ninguna de las 7 filas que hoy pasan puede empeorar con el reintento activo (el
  reintento solo se dispara si el primer paso falló).
- **Total de liquidaciones cerradas** (hoy 5 de ~21) — ¿sube, y a cuánto?
- Latencia agregada por lote de 8 páginas: cuántos reintentos dispara un documento real y cuánto
  tiempo de pared agrega — dato que hoy no existe (el research midió corridas aisladas, no un lote
  completo con la lógica de reintento integrada).
- `pnpm verificar` sigue en verde; R-P sigue con un único importador de `tesseract.js` (la función
  de recorte vive en `ocr.ts`, no agrega un segundo punto de conexión).
- El eje 2 (checksum del emisor) — con más liquidaciones cerradas, ¿se acerca a `cuadra` o sigue
  `no_cuadra` por cobertura parcial? (mismo artefacto ya documentado en HANDOFF 80, no se espera que
  cambie de naturaleza, solo de magnitud).

## 3. Predicción falsable

| Si sale... | Significa... |
|---|---|
| El reintento sobre recorte aislado recupera las 14 filas de `neto_acreditado` con una tasa cercana al 100 % medido en la muestra de 6 | La estrategia generaliza al documento completo; extenderla de entrada a los otros cuatro conceptos de `LINEAS_DE_TOTAL` es la consecuencia lógica |
| Recupera bastante menos de 14 (deja varias sin resolver, no solo 1-2 sueltas) | Hay una segunda causa distinta de la que aisló este research — recién ahí se justifica retomar preprocesamiento de imagen, con la evidencia de CUÁLES filas siguen fallando después del reintento (no antes) |
| El reintento introduce una regresión sobre alguna de las 7 filas que hoy pasan | El recorte no es tan neutral como midió esta muestra chica — hay que acotar más el disparador (por ejemplo, solo cuando el primer paso realmente falló, nunca "por las dudas") |
| El costo de latencia agregado por lote de 8 páginas resulta molesto para el volumen real (a validar con Laura/`devops`, no hay umbral fijado hoy) | Vale la pena cachear los píxeles crudos de la página en memoria del propio lote en vez de volver a llamar `extractImages` en cada reintento — optimización interna, no cambia la estrategia |
| Un documento futuro (Visa crédito, Cabal, u otro comercio) muestra el mismo síntoma de `neto_acreditado` y el reintento-sobre-recorte NO lo recupera | La causa de fondo no es "página densa con bloques repetidos" sino algo específico de este documento — hay que revisar la hipótesis del recuadro (o buscar una tercera) con evidencia del documento nuevo, y ahí sí reconsiderar preprocesamiento |

## 4. Qué agentes se convocan

**Ya convocado, con dictamen entregado en este documento**: `arquitecto-software` — técnica de
investigación (JS vs. Python, experimentación real contra el documento), refutación de la hipótesis
del recuadro con evidencia, diseño de la alternativa (reintento sobre recorte, sin dependencia
nueva), corrección de la premisa sobre `sharp`.

**A convocar al implementar** (fuera de esta tarea):

- `security-engineer` — aunque no hay dependencia nueva ni superficie de red nueva, `ocr.ts` gana una
  función exportada nueva (`reconocerRecorte` o el nombre que se fije); confirmar que sigue sin tocar
  nada externo y que el guard de `langPath`/`corePath`/`workerPath` sigue aplicando igual al segundo
  `createWorker`.
- `seguridad-datos-financieros` — el reintento sigue produciendo `ConfianzaDeCampo.valorLeido` (N2,
  ya clasificado); confirmar que el segundo pase de OCR no abre ninguna ruta nueva de log accidental
  y que la clasificación existente cubre el campo recuperado igual que el de primera pasada.
- `backend-dev` — implementación de `pixelesDePagina`, `reconocerRecorte`, y el punto de enganche en
  `leerVisaDebito`.
- `code-reviewer` — antes de cerrar cualquier commit.
- `qa-funcional`/`qa-automation`/`tester` — al cerrar, con la medición completa de §2 contra las 14
  filas.
- **No hace falta** `dba-data` (sin migración), ni ningún agente fiscal/contable (esto es extracción
  técnica, no cambia semántica contable ni normativa).

## 5. Decisiones que quedan para JP

- **¿Implementar el reintento-sobre-recorte ahora** (siguiente commit sobre el plan 14/15) **o medir
  primero contra las 14 filas completas en un paso de solo-medición**, sin tocar el adapter todavía?
- **¿El reintento se implementa genérico desde el día uno** (los cinco conceptos de
  `LINEAS_DE_TOTAL`) **o se acota primero a `neto_acreditado`** (el cuello de botella medido) y se
  extiende después con evidencia de que hace falta?
- **Si el reintento no alcanza el 100 % sobre las 14 filas completas**: ¿se retoma preprocesamiento
  de imagen —con qué técnica, dado que ninguna de las doce probadas mostró ventaja clara sobre el
  recorte solo— o se acepta la cobertura resultante como el límite actual del enfoque, documentado,
  sin forzarlo más?
- **Prioridad relativa**: este trabajo (reintento sobre recorte) vs. continuar con Visa crédito/Cabal
  (plan 14, adapters restantes) vs. los commits 3-4 pendientes del plan 14 (migración + CLI). No es
  parte de este research decidir el orden.

## 6. El paso revertible más chico (para cuando se implemente)

1. **Refactor puro, sin dependencia ni cambio de comportamiento**: separar `imagenDePagina`
   (`texto-pdf.ts`) en una función de píxeles crudos + un envoltorio que codifica a PNG igual que hoy.
   Revertible: un solo commit, mismo output verificado byte a byte contra el actual.
2. **`reconocerRecorte` en `ocr.ts`** (crop + encode + `reconocerImagen`), sin engancharla todavía a
   ningún adapter. Revertible: borrar la función nueva, `ocr.ts` sigue siendo el único importador de
   `tesseract.js`, sin cambio a R-P.
3. **El punto de enganche en `leerVisaDebito`**: cuando `leerLineaDeTotal` da `null`, intentar el
   recorte antes de reportar `renglon_sin_monto`. Acá se mide §2 contra las 14 filas reales.
   Revertible: sacar el `if` que dispara el reintento, vuelve al comportamiento actual exacto.

Ningún paso agrega una dependencia. Si en el paso 3 la medición contra las 14 filas completas refuta
la generalización de esta muestra chica, revertir es borrar código propio, nunca desinstalar nada.

---

## Anexo — Observación de stack completo (NO desarrollada, para decisión de JP)

Pedido explícito de JP: anotar acá, sin proponer ni diseñar, cualquier evidencia de un problema de
fondo en el **stack completo** del producto (no en esta pieza puntual) que haya aparecido en el
camino.

**No se encontró ninguno en esta sesión.** Lo más cercano a un hallazgo "de stack" fue la premisa
falsa sobre `sharp` (§Contexto) — pero es un dato puntual sobre este research, corregido en el cuerpo
del documento, no un problema estructural del producto. La interacción entre upscaling y
`MAX_DIMENSION_PX` (§0) tampoco califica: es un límite deliberado de `ocr.ts` funcionando como está
diseñado, no un defecto. No hay nada más para anotar acá esta vez.

---

## Confirmación de limpieza (disciplina anti-fuga, §obligatoria del pedido)

- **Scripts de investigación**: tres archivos temporales se crearon dentro de
  `packages/ingesta/scripts/` (`tmp-fase1-baseline.ts`, `tmp-fase2-preprocesamiento.ts`,
  `tmp-png-encoder.ts`) para poder reusar `reconocerImagen`/`parsearImporte`/`normalizar` reales sin
  modificar ningún archivo de producto. **Los tres se borraron** antes de cerrar esta sesión;
  `git status` confirma árbol de trabajo limpio (no llegaron a `git add`, nunca se commitearon).
- **Script Python** (`preprocess_cv2.py`) y el **venv aislado** (`venv-ocr/`, con
  `opencv-python-headless` + `numpy`) vivieron en el scratchpad de la sesión, nunca en el repo. Se
  borran al cerrar este documento (confirmado abajo). Ningún paquete quedó instalado de forma
  permanente en el proyecto — `package.json`/`pnpm-lock.yaml` sin tocar, verificado con `git status`.
- **Imágenes del documento real**: todo el pipeline de recorte/preprocesamiento operó sobre
  `Uint8ClampedArray`/`Uint8Array` en memoria del proceso Node, o como bytes en memoria intercambiados
  con el subproceso Python (`cv2.imdecode`/`imencode` sobre buffers — nunca un archivo). **No se
  escribió ningún archivo de imagen a disco en ningún momento** de esta investigación, ni en el
  scratchpad ni en ningún directorio temporal del SO — a diferencia de la sesión anterior
  (`pagina-1.png`, ya corregida), acá no hizo falta ni el fallback de archivo temporal porque
  `cv2.imdecode`/`imencode` trabajan sobre buffers directamente.
- **Contenido reconocido por OCR**: nunca impreso, nunca logueado, nunca escrito a ningún archivo —
  ni en los scripts de investigación ni en este documento. Los dos archivos de resultados
  intermedios (`tmp-fase1-resultados.json`, `fase2-log.txt`) contienen exclusivamente geometría en
  píxeles, booleanos de pass/fail y confianza numérica de Tesseract — se borran junto con el resto
  del scratchpad de investigación al cerrar esta tarea.
