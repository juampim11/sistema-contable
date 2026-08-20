# 15 — Plan de diseño: soporte OCR para liquidaciones de tarjeta fotografiadas/escaneadas

> 🔴 **PLAN DE RESEARCH + DISEÑO — NO IMPLEMENTADO.** Ningún archivo de código de este documento existe
> todavía en el filesystem: ni dependencia nueva, ni `ocr.ts`, ni regla de barrido, ni cambio al eje de
> verificación. Este documento sintetiza tres dictámenes reales (`arquitecto-software`,
> `motor-conciliacion-contable`, `contador-dominio`), convocados con `Agent()` en esta sesión, no
> narrados. El commit 2 del plan 14 (adapter Visa débito) sigue frenado hasta que esto se implemente.

## Contexto

El commit 2 de `docs/diseno/14-liquidaciones-tarjeta-plan.md` (primer adapter real, Visa débito) se
frenó: el documento real del cliente (`privado/tarjetas/01-extracto_visa_debito_roka.pdf`, gitignored)
resultó ser una foto/escaneo con CamScanner, no un PDF con texto nativo —
`extraerTexto()`/`aFilas()` de `packages/ingesta/src/texto-pdf.ts` dan `requiereOcr: true`, 0
caracteres extraídos en 8 páginas, y a nivel de bytes el archivo tiene referencias `/Image` y **0
`/Font`**. Verificado de forma independiente contra el archivo real, y contra un extracto bancario
real de Galicia (que sí extrae 30.590 caracteres) para descartar un bug del extractor.

Había un precedente directo en este repo: **BBVA**, un banco del Módulo 1, tuvo el mismo síntoma
exacto (`docs/diseno/01-modulo-1-ingesta-bancaria.md` §2.1/§10.2/§12 — "imagen pura, 6 páginas, cero
caracteres extraíbles"). La decisión tomada entonces fue **no construir OCR**: el adapter de BBVA no
existe, el CLI rechaza con `adapter_no_disponible`, anotado "se decide con el dato en mano, no antes"
— asumiendo que el caso escaneado era la excepción, a la espera de un segundo caso que justificara el
costo.

**Dato nuevo de Laura (contadora del estudio), que invalida ese precedente para este módulo**: el
formato normal en que estos comercios reciben la liquidación de tarjeta es **impreso** — lo
escaneado/fotografiado no es el caso raro, es el patrón recurrente. No hay versión digital nativa
esperando del otro lado. Con este dato, "esperar un segundo caso" ya no aplica: **OCR pasa de opcional
a requisito real** para que el módulo de liquidaciones sirva para algo.

Se convocó a tres agentes con `Agent()` real, cada uno con su dictamen completo incorporado abajo:
`arquitecto-software` (librería, dónde vive, costo), `motor-conciliacion-contable` (si la invariante
aritmética ya construida alcanza como red de seguridad ante ruido de OCR), `contador-dominio` (severidad
contable/fiscal de un dato mal leído que entra a una propuesta de asiento).

---

## 1. Qué cambia y qué no

### Cambia (cuando se implemente — nada de esto existe todavía)

- **Librería: `tesseract.js` v7, 100% local (WASM, sin red en runtime)**, con `langPath`/`corePath`
  apuntando a los paquetes de datos ya instalados (`@tesseract.js-data/spa`) — nunca a la descarga por
  defecto desde `cdn.jsdelivr.net` que la librería intenta si no se configura. Esa configuración **es
  la condición de cierre** que hace que el módulo cumpla CLAUDE.md §1.4 (nada de un documento de un
  cliente, ni siquiera indirectamente, sale a un tercero) — no es un detalle de implementación.
  Alternativa local más rápida evaluada y descartada por ahora: `tesseract-wasm` (robertknight) — 10x
  más rápido y ~20x más liviano, pero v0.11.0 sin garantía semver y sin la solidez documental de
  bbox+confidence por palabra que sí tiene el TSV de tesseract.js. Se reevalúa si el volumen de OCR
  crece mucho (hoy: un cliente, pocas liquidaciones/mes — mismo criterio de escala que ya usó este
  repo para BBVA, aplicado esta vez a la elección de librería madura, no a "hacer o no OCR").
- **Servicios en la nube (Google Vision, AWS Textract, Azure Document Intelligence API estándar):
  descartados por CLAUDE.md §1.4** — mandarían el documento completo de un cliente (facturación, CUIT)
  a un tercero sin decisión registrada. Investigado el caso límite real (Azure ofrece contenedores
  *disconnected* on-premise, que sí cumplirían la regla de datos): descartado igual, por costo/operación
  desproporcionados (licencia comercial + 8 cores/10-24GB dedicados) contra el volumen real. Estos
  cuatro rechazos —con su motivo propio cada uno— se agregan a
  `docs/seguridad/registro-terceros.md` cuando se implemente, para que la próxima vez que alguien
  proponga "¿probamos Vision?" la respuesta ya esté escrita.
- **Ubicación: `packages/ingesta/src/ocr.ts`**, hermano de `texto-pdf.ts`/`parseo-ar.ts`/`hash.ts` —
  **no** dentro de `texto-pdf.ts` (que hoy es liviano y sin dependencias pesadas; meter WASM+datos de
  idioma ahí penalizaría a los siete de ocho bancos que nunca necesitan OCR), **no** un paquete nuevo.
  Al vivir fuera de `adaptadores/` y de `liquidaciones/`, R-M ya lo deja importable por las dos
  familias sin tocar ninguna regla existente (mismo trato que `texto-pdf.ts` hoy).
- **Choke point verificable, no una interfaz agnóstica.** Regla nueva en
  `packages/data/tests/reglas-de-codigo.test.ts`, hermana de R17 (*"un único punto de conexión"*):
  **solo `packages/ingesta/src/ocr.ts` (y sus tests) puede importar `'tesseract.js'`**. Se evaluó y
  descartó una interfaz tipo `AuthProvider`/`ObjectStorage`: esas existen porque hay variabilidad real
  de proveedor con credenciales por entorno; acá no hay, ni la va a haber en el horizonte previsible
  (la nube está excluida por regla dura, y no hay una segunda implementación local real que justifique
  el costo). El choke point da la misma reversibilidad (cambiar de librería es tocar un archivo) sin
  pagar la interfaz.
- **Tipo de salida nuevo, NO reusar `FilaGeometrica`/`Fragmento`.** No es solo "falta el campo de
  confianza": el sistema de coordenadas es distinto (píxeles de imagen, no puntos PDF vectoriales) y,
  más de fondo, **el supuesto de columna-en-`x`-fijo que sostiene el banding de los adapters bancarios
  no es cierto sobre una foto** (perspectiva, rotación, recorte distinto en cada captura mueven cada
  columna). Tipo propuesto, deliberadamente chico:
  ```ts
  export type PalabraOcr = {
    readonly texto: string;
    readonly x: number; readonly y: number;   // píxeles de la imagen, y hacia ABAJO
    readonly ancho: number; readonly alto: number;
    readonly confianza: number;                // 0–100, tal como lo publica tesseract
  };
  export type PaginaOcr = { readonly pagina: number; readonly palabras: readonly PalabraOcr[] };
  ```
  Sin una función de agrupado en "filas" genérica todavía: agrupar por `y` con tolerancia fija (como
  `aFilas()`) puede partir mal una fila sobre una foto rotada — esa decisión es del primer adapter
  real, con el documento real en mano.
- **Estrategia de lectura: por etiqueta + proximidad, no banding por coordenada fija** — consecuencia
  directa del punto anterior. Coherente con el criterio que el plan 14 ya fijó para lectura por
  etiqueta (`valorPorEtiqueta`, "nunca por patrón") y con R-O2 (nombres de tasa no cableados). Queda
  como **pregunta abierta de diseño para el commit que retome el adapter**, no resuelta acá.
- **Extraer el JPEG embebido, no rasterizar la página.** El propio diagnóstico que motivó esta sesión
  (`/Image` sin `/Font`) sugiere que el archivo real ya trae la imagen embebida por página — si se
  confirma, se extraen esos bytes directo para `worker.recognize()`, evitando una dependencia nueva y
  pesada (`node-canvas`/`@napi-rs/canvas`, con binarios nativos) para rasterizar. **Verificación
  pendiente contra el archivo real**, no una afirmación cerrada.
- **Un CUARTO eje de verificación, separado — nunca fusionado con el tri-estado existente
  (`EJES_DE_VERIFICACION` de `esquema.ts`).** Dictamen de `motor-conciliacion-contable`: la aritmética
  ya construida (`verificarAritmeticaPorLiquidacion`) es una red real con tolerancia cero para los
  campos que suma (`ventasBrutas`, `netoAcreditado`, `monto` de cada renglón) — un dígito mal leído en
  esos campos casi siempre rompe la ecuación. Pero **no cubre**: `alicuotaPublicada` y `base` (no
  participan de la suma, solo `monto` lo hace), `numeroDeLiquidacion`, fechas, `jurisdiccion` y
  `caveatDeComputoFiscal` (ninguno es un término de la ecuación), ni el caso de dos errores
  correlacionados que se compensan (posible cuando el ruido de OCR es sistemático por columna, no
  aleatorio dígito a dígito). Fusionar esto en el eje 1 repetiría, en sentido inverso, el error que el
  propio plan 14 ya corrigió una vez (colapsar ejes ortogonales en un solo estado): "¿cierra la
  aritmética?" y "¿confío en esta lectura?" son preguntas distintas, y la segunda puede ser falsa aun
  con la primera en verde.
  - Vive en la capa de ingestión/adapter (`ocr.ts` o el adapter que lo consuma), no en
    `verificacion.ts` — es una propiedad de **cómo se leyó**, no de si lo leído es consistente.
  - **Granularidad por campo**, no un score global de documento: una lista de rutas de campo con su
    valor reconocido y su confianza cruda — mismo espíritu que ya usa el proyecto para evidencia
    (qué campo, con qué score).
  - **Mismo mecanismo de tri-estado con roster cerrado** que ya usa el resto del módulo, por
    consistencia: `confiable | dudoso | no_evaluable` (`no_evaluable` para texto nativo — el eje no
    corrió, distinto de "corrió y no encontró motivo de duda").
  - **Nunca bloquea ni reemplaza el eje aritmético.** No se usa confianza alta para promover
    `no_cuadra` a `cuadra`, ni confianza baja para relajar un `no_cuadra` real — son señales que se
    suman, nunca que se cancelan. La combinación peligrosa que este eje existe para atrapar es
    exactamente `confianza baja` + `cuadra`: el caso que la aritmética sola no puede ver.
  - **Consecuencia obligatoria sobre el matching**: si `numeroDeLiquidacion` cae en `dudoso`, la vía 1
    de la escalera (`por_numero_de_liquidacion`, plan 14 §1) no se trata como match fuerte para esa
    liquidación — degrada a `por_fecha_y_neto` aunque el string haya matcheado contra alguna glosa. Un
    número mal leído que por coincidencia matchea el número real de OTRO movimiento del mismo comercio
    es peor que no tener vía fuerte.
- **Señal barata adicional, sin tabla nueva: comparación intra-lote.** Un arancel es un término
  negociado que no cambia liquidación a liquidación dentro del mismo mes. Si 20 de 21 liquidaciones de
  un lote traen la misma `alicuotaPublicada` y una difiere, es una señal de desvío fuerte y gratis —
  calculada dentro del propio lote, sin cablear ningún valor esperado (no viola R-O/R-O2: no hay
  constante, hay una comparación entre filas ya leídas). Es el punto de partida barato antes de que
  exista la tabla N2 por cliente con vigencia que el plan 14 ya dejaba como trabajo futuro para Vía B
  — los dos no compiten, uno es el arranque, el otro la versión madura con memoria entre lotes.
- **La cola de revisión necesita mostrar origen y confianza, no solo el valor.** Dictamen de
  `contador-dominio`: un contador que revisa 21 liquidaciones no relee cada dígito contra el papel —
  necesita poder **focalizar** en los renglones de fuente menos confiable. Sin declarar "esto vino de
  OCR, con esta confianza" por renglón, un valor mal leído es indistinguible en pantalla de uno
  extraído de texto nativo. Recomendación de diseño (no de pixel — eso es `ux-designer`): origen de
  lectura (nativo/OCR) visible, confianza visible si el motor la da, y el estado de verificación
  aritmética **no reemplaza** esa señal — son cosas distintas. Candidato adicional, más barato de lo
  que parece dado que ya habría geometría por palabra: mostrar el recorte de imagen original junto al
  valor dudoso en la cola de revisión, para confirmar con un vistazo en vez de confiar a ciegas.
- El ranking de exposición fiscal por concepto se discutió pero no forma parte de este plan — ver
  "No cambia".

### No cambia — alcance explícito, a propósito

- **Nada se implementa en esta sesión.** Es research + diseño, igual que el plan 14 en su momento.
- **El núcleo aritmético (`verificarAritmeticaPorLiquidacion`, `verificarChecksumDelEmisorMinimo`) no
  se toca ni se relaja.** Sigue siendo la única fuente de verdad sobre si la ecuación cierra; el eje
  de confianza es un complemento, nunca un sustituto ni un modificador de su resultado.
- **Ninguna interfaz agnóstica nueva tipo `AuthProvider`.** Se evaluó explícitamente y se descartó —
  ver arriba.
- **Ningún servicio de OCR en la nube**, ni siquiera el caso límite (Azure disconnected) que sí
  cumpliría la regla de datos — descartado por costo/operación, dejado anotado como evaluado y
  rechazado, no como nunca considerado.
- **Ranking de exposición por concepto — discutido, NO es criterio de producto todavía.** Posición de
  `contador-dominio`: `iva_21_sobre_arancel` (y su análogo eventual 10,5% sobre cuotas) con mayor
  exposición relativa por alimentar directo un crédito fiscal de una DDJJ nacional sujeta a cruce
  sistemático — candidato a revisión obligatoria, no solo señalización. `retencion_iibb_sirtac` y
  `percepcion_iva_rg2408` con exposición intermedia (afectan el cómputo de un pago a cuenta del propio
  cliente) — la percepción, además, es hoy el renglón con **menor capacidad de auto-verificación** (sin
  fórmula conocida, sin aritmética de respaldo), lo que ya la marca como de revisión obligatoria
  independientemente de la severidad fiscal. `arancel`, `descuento_contado_adquirente`,
  `interes_financiacion_cuotas` con exposición fiscal directa más baja (gasto/resultado financiero
  propio), aunque igual exigen revisión por su efecto en el resultado del ejercicio.
  `contador-dominio` lo marca explícito: es su criterio de exposición desde el rol de registración, no
  una tabla normativa — antes de fijarlo como regla del sistema (con umbrales o gates reales) tiene que
  pasar por `fiscal-nacional-iva-ganancias` (IVA crédito fiscal, RG 2408) y
  `fiscal-ingresos-brutos-convenio-multilateral` (SIRTAC), ninguno de los dos convocado en esta sesión.
  **Validar con profesional matriculado.**
- **El diseño de "agrupar palabras OCR en filas lógicas" y la estrategia exacta de lectura por
  etiqueta+proximidad no se cierran acá** — quedan para el commit que retome el adapter de Visa
  débito, con el documento real en mano.
- **El commit 2 del plan 14 sigue exactamente donde quedó**: sin adapter `visa_debito` registrado
  (equivalente funcional al patrón BBVA — `resolverAdaptadorDeLiquidacion` da `sin_adaptador`, no hay
  código de rechazo adicional escrito). R-O acotada, R-O2 y `verificacion.ts` (ambos ejes, con el
  comentario que marca el checksum del emisor como parcial) siguen cerrados y verificados de la sesión
  anterior — nada de esto se toca ni se deshace.
- **No se toca `docs/seguridad/registro-terceros.md` en esta sesión** — la entrada de los cuatro
  servicios evaluados-y-rechazados se agrega recién cuando se implemente (mismo momento en que se
  instala la dependencia real), no en el research.

---

## 2. Qué se mide (cuando se implemente)

- Contra el archivo real (`privado/tarjetas/01-extracto_visa_debito_roka.pdf`): si el `/Image`
  embebido es extraíble directo (JPEG) sin rasterizar la página — confirma o refuta la elección de no
  agregar `node-canvas`.
- Tamaño real post-`pnpm install` con solo el paquete de idioma `spa` (estimado en el dictamen: ~43 MB
  combinados `tesseract.js` + `tesseract.js-core` + `@tesseract.js-data/spa`) y tiempo agregado a CI —
  convocatoria pendiente a `devops`.
- Accuracy real del reconocimiento contra las 21 liquidaciones del documento real (nunca reportado
  como valor literal, mismo criterio anti-fuga que el commit 2: conteo de campos `confiable` vs.
  `dudoso`, no el texto reconocido).
- Cuántas de las 21 liquidaciones cierran la invariante aritmética con los valores que produce el OCR
  real — la misma medición #4 que quedó pendiente del commit 2, ahora alcanzable.
- Que `ocr.ts` nunca llama a la red en una corrida sin conexión (condición de cierre de CLAUDE.md
  §1.4) — test que fuerza el error si `langPath`/`corePath` no están configurados a los paquetes
  locales.

## 3. Predicción falsable

| Si sale... | Significa... |
|---|---|
| El `/Image` del PDF real es un JPEG embebido extraíble sin rasterizar | No hace falta `node-canvas`/`@napi-rs/canvas`; el extractor de `ocr.ts` es más simple de lo previsto |
| El `/Image` NO es directamente extraíble (compresión rara, múltiples capas) | Hay que rasterizar la página, y entra una dependencia nueva con binarios nativos — revisar el costo antes de seguir |
| La confianza por palabra de tesseract.js correlaciona razonablemente con errores reales medidos a mano sobre una muestra chica | El eje de "confianza de captura" es una señal útil tal como está diseñado |
| La confianza por palabra NO correlaciona bien (alta confianza con error real, o viceversa) | El diseño del eje 4 necesita algo más que el score crudo de tesseract — revisar antes de construir la UI que lo muestra |
| Aparece al menos un caso real de dos errores de OCR que se compensan y la ecuación "cuadra" con datos falsos | Confirma que la aritmética sola no alcanza (dictamen de `motor-conciliacion-contable`), y sube la prioridad del eje 4 de "nice to have" a "bloqueante" |
| El banding por coordenada fija (como los adapters bancarios) SÍ funciona razonablemente sobre las fotos reales, con una tolerancia más ancha | La estrategia "por etiqueta + proximidad" prevista puede simplificarse — hay que confirmarlo contra el documento real antes de descartar la geometría fija por completo |

## 4. Qué agentes se convocan

**Ya convocados y con dictamen entregado, en esta sesión** (satisface CLAUDE.md §3.1 de forma
estructural — `Agent()` real, no narrado):

- `arquitecto-software` — librería (tesseract.js vs. alternativas locales y en la nube, con
  investigación real vía WebSearch/npm), ubicación (`ocr.ts`, choke point verificable vs. interfaz
  agnóstica), tipo de salida (`PalabraOcr`/`PaginaOcr`, por qué no reusar `FilaGeometrica`), costo
  (tamaño, CDN por defecto, gate).
- `motor-conciliacion-contable` — si la invariante aritmética alcanza como red de seguridad (no, con
  cuatro modos de falla concretos), diseño del eje 4 separado (`confiable/dudoso/no_evaluable`),
  consecuencia sobre la escalera de matching, señal intra-lote.
- `contador-dominio` — severidad contable/fiscal de un dato mal leído, qué necesita ver la revisión
  humana para cumplir su función, ranking de exposición por concepto. Marca explícito qué de su
  dictamen necesita fuente normativa que `knowledge/` no tiene hoy ("no tengo esa fuente cargada" para
  plazos de cómputo y régimen aplicable) y a quién corresponde consultar.

**A convocar al implementar** (fuera de esta tarea):

- `devops` — impacto real de la dependencia nueva (~43 MB) en `pnpm install` y en el caché de CI.
- `seguridad-datos-financieros` — confirmar que la configuración de `ocr.ts` (sin CDN, sin red en
  runtime) cumple de verdad CLAUDE.md §1.4 antes de cerrar el commit que la instale, y revisar la
  clasificación de los campos nuevos (`confianza`, origen de lectura) en
  `clasificacion-campos.ts` cuando corresponda.
- `security-engineer` — junto con el anterior, dependencia nueva = superficie nueva (matriz de §3.1).
- `fiscal-nacional-iva-ganancias` y `fiscal-ingresos-brutos-convenio-multilateral` — antes de que el
  ranking de exposición por concepto de `contador-dominio` se convierta en un umbral real del
  sistema.
- `ux-designer` — cómo se muestra origen/confianza/recorte en la cola de revisión, sin resolverlo acá.
- `backend-dev` escribe el código cuando se implemente; `code-reviewer` revisa antes de cerrar;
  `qa-funcional`/`qa-automation`/`tester` al cerrar cada etapa.

## 5. Decisiones que quedan para JP

- **Idioma**: `spa` solo, o `spa+eng` (por si hay sellos/textos en inglés en algún documento) — afecta
  el tamaño de instalación (+13.9 MB si se agrega `eng`).
- **Si el ranking de exposición por concepto se usa ya como guía de prioridad de revisión, o se espera
  el dictamen fiscal antes de aplicarlo en cualquier forma** (aunque sea no vinculante).
- **Orden real de implementación**: ¿el primer commit real mide accuracy contra el documento real
  ANTES de construir el eje 4 completo (research empírico primero, diseño final después), o se
  construyen los dos juntos con el diseño de este documento ya como base suficiente?

## 6. El paso revertible más chico (para cuando se implemente)

No arranca en esta sesión. El primer paso sugerido, coherente con el método del plan 14: agregar
`tesseract.js` + `ocr.ts` + su choke point verificable + confirmar contra el documento real si el
`/Image` es extraíble sin rasterizar, y medir accuracy real — **sin** construir todavía el eje 4 de
confianza ni tocar la cola de revisión. Revertible completo borrando `ocr.ts`, la dependencia y la
regla de barrido nueva. El eje 4, el ranking por concepto con validación fiscal, y la UI de revisión
son pasos separados y posteriores, cada uno con su propia convocatoria.
