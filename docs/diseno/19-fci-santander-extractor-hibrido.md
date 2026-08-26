# 19 — Extractor de FCI Santander: diseño híbrido (pdftotext + unpdf) y su expediente completo

> Documento autocontenido, mismo criterio que `17-fci-peps-plan.md` y `18-cuit-pegado-sin-separador.md`:
> si estás retomando esto sin haber visto la sesión que lo escribió, todo lo que hace falta saber está
> acá. `HANDOFF.md` tiene el registro cronológico; el detalle vive acá.

## Contexto

Primera validación del motor de FCI (`packages/fci`, ya validado contra Elite-IT SAS — E-2,
`docs/seguridad/registro-excepciones.md`) contra un extracto de **Banco Santander**, layout
completamente distinto del de Galicia (`packages/ingesta/src/fci-galicia/`). El documento real: 1 PDF,
2 páginas, 3 fondos en página 1 (página 2 es texto legal/firmas, sin tabla), autorizado bajo **E-5**
(`docs/seguridad/registro-excepciones.md`).

🔴 **Identidad del titular del documento: RESUELTA — Pannonica SAS**, confirmado por JP (addendum E-5,
2026-08-25). El encuadre original de la tarea asumía "El Prat S.A.S." por error, nunca verificado
contra la carátula real. Pannonica SAS es un cliente real y distinto del estudio, ya identificado por
JP y con plan de cuentas propio — no un archivo mal ubicado ni un cliente inventado.

🔴 **Tenant en el piloto: CONFIRMADO que NO tiene, 2026-08-25** (lectura de solo consulta contra
`tenant_node` en `sistema_contable_piloto` — 0 coincidencias por nombre, sobre 4 tenants totales).
Esto bloquea el `.xlsx` de entrega hasta que Pannonica se dé de alta como cliente nuevo del piloto
(mismo proceso que Bracci/ROKA/El Prat); no bloquea este extractor, que es genérico (no referencia
ningún cliente ni tenant) y por eso pudo escribirse y probarse sin esperar ninguna de las dos
confirmaciones.

## El hallazgo central: dos zonas de `y` disjuntas dentro del mismo documento

El primer diseño (mismo patrón que Galicia: agrupar fragmentos en filas geométricas por proximidad de
`y`, clasificar cada fila por su etiqueta + sus números en la MISMA fila) falló de una forma que llevó
varias rondas de descubrimiento a explicar. Resumen de la cadena de hallazgos, en orden:

1. **El patrón literal de Galicia (`FONDO - <nombre> CLASE <letra>`) da 0 matches** — layout distinto,
   esperado.
2. **`unpdf`/`pdf.js` (el extractor geométrico de todo el Módulo 1, `packages/ingesta/src/texto-pdf.ts`)
   pierde 2 de 3 apariciones de "SALDO INICIAL" y "SALDO FINAL"** en este documento — ni siquiera la
   palabra suelta "SALDO" aparece más de 1 vez en el texto que reconstruye `aFilas()`, contra las
   3+3=6 reales.
3. **Diagnóstico geométrico puro** (rango de `y` de fragmentos numéricos vs. de etiqueta, en página 1,
   sin agrupar en filas): los números viven en `y ∈ [468, 708]`; las etiquetas (SALDO/INICIAL/
   FINAL/Fondo/fecha) en `y ∈ [50, 327]`. **Cero superposición** — un salto de 140pt sin nada en el
   medio. Confirmado además con el conteo: 24 números medidos = exactamente 6 saldos × 1 importe + 6
   movimientos × 3 campos (cantidad/valor/importe).
4. El titular confirmó con captura de pantalla que el texto se **selecciona en orden visual correcto**
   — descarta que sea contenido roto/mal generado, pero el orden de SELECCIÓN de un lector de PDF
   (basado en el árbol de estructura/orden del content-stream) no tiene por qué coincidir con la
   coordenada `(x,y)` real de cada glifo que expone `pdf.js`. Conclusión: el generador del reporte
   probablemente posiciona la porción numérica de la tabla en coordenadas absolutas distintas de la
   plantilla estática de etiquetas — un patrón de generación de reportes (plantilla + capa de datos
   variables) con un desfasaje real de posicionamiento, no un documento corrupto.
5. **Intento de aislar la causa por fuente (`fontName` de `pdf.js`)**: 2 fuentes en la zona de
   etiquetas (`g_d0_f1`, `g_d0_f3`, ambas "sans-serif" genérico), NINGUNA falla por completo (79% y 51%
   de match, no 100%/0%). **No se pudo aislar la causa con precisión** — documentado así de franco, sin
   forzar una conclusión que la medición no sostiene.

## Decisión de diseño: dos fuentes de extracción, cada una para lo suyo

Dado que agrupar por proximidad geométrica no puede funcionar (no es un problema de tolerancia, es que
las dos zonas están en rangos de `y` disjuntos), el extractor final usa **dos fuentes, nunca mezcladas
de forma opaca**:

- **`pdftotext -layout`** (`etiquetasConPdftotext`, `packages/ingesta/src/fci-santander/
  extraer-posiciones.ts`) da la SECUENCIA de eventos de etiqueta — fondo / SALDO INICIAL / SALDO FINAL
  / movimiento (con su fecha y tipo). Nunca un número, nunca una posición geométrica.
- **`unpdf`** (`aFilas`, sin cambios) sigue siendo la ÚNICA fuente para cantidad/valor/importe/
  certificado — una cola numérica secuencial, ordenada por `(y descendente, x ascendente)`, consumida
  en el orden en que la secuencia de etiquetas la va necesitando (1 valor por SALDO, 3 por movimiento:
  cantidad, valor, importe, en ese orden de columna).

### Segmentación dentro de `pdftotext`: por ANCLAS de contenido, no por longitud de línea

Dos diseños intermedios, descartados con evidencia real antes de llegar al final:

1. **Buscar `Fondo:` en cada línea del documento** — encontraba 7 coincidencias contra las 3 reales
   (menciones sueltas en título, texto legal de página 2, fila de títulos de columna repetida).
2. **Segmentar por LARGO de línea** (`-layout` rellena cada fila a un ancho fijo según su rol
   estructural — hipótesis inicial, viable en la medición del titular). **Descartada: NO es portable
   entre builds de `pdftotext`.** El titular mide con **Poppler 24.02.0** (líneas de encabezado de
   bloque ~118/171 caracteres, de dato ~185-187, siempre); este entorno de desarrollo corría **xpdf 4.00
   (Glyph & Cog)** y produce longitudes completamente distintas para el MISMO PDF — confirmado con
   `pdftotext -v` en los dos entornos. Poppler y xpdf son proyectos de código **distintos** (con un
   ancestro histórico común), cada uno con su propio algoritmo de layout. Ver §"Dependencia de build"
   más abajo.

**Diseño final, portable**: `comoEtiquetaDeSaldo` (contenido, no forma) ya encuentra los 6 SALDO
INICIAL/FINAL de forma confiable en cualquier build — son las ANCLAS. Cada par INICIAL→FINAL
consecutivo (alternancia validada estricta, `SaldoDesalineadoError` si no alterna) delimita un bloque;
el nombre del fondo se busca retrocediendo SOLO dentro de ese bloque (desde el INICIAL hacia atrás,
hasta el final del bloque anterior); los movimientos son las líneas ENTRE el INICIAL y el FINAL de ese
mismo bloque que empiezan con fecha + SUSCRIP/RESCATE.

**Verificación de consistencia interna** (`ConsistenciaInternaPdftotextError`): la cantidad TOTAL de
líneas con un encabezado `Fondo:` reconocible en toda la página 1 tiene que coincidir con la cantidad de
bloques SALDO INICIAL→FINAL ya armados — dos formas independientes de contar dentro de la MISMA fuente.
**No se cruza `unpdf` para "fondo"/"saldo"**: ya diagnosticado que `unpdf` no reconoce bien esas
palabras puntuales en este documento (mismo motivo de fondo — no identificado con precisión, ver arriba
— que ya afecta a SALDO). Cruzar contra una fuente que se sabe rota ahí no demuestra nada; solo
"movimiento" se cruza contra `unpdf` (`FuentesDesincronizadasError`), porque esa detección SÍ coincide
entre las dos fuentes en este documento.

## Regla nueva: reconcile-or-refuse

**Candidata a regla formal (R43 o el número que corresponda) en `ADR-0002-seguridad.md` §B — no
promovida formalmente en esta sesión** (la promoción formal exige la prueba de mutación de §B.0, no
hecha acá; queda como pendiente explícito, no como regla ya cerrada). Principio, aplicado ya en este
extractor:

> **Ningún extractor que compare dos fuentes para el mismo dato numérico o estructural puede reconciliar
> una discrepancia en silencio.** Nunca promediar, nunca elegir "la que parezca mejor", nunca completar
> con lo que falte. Si dos fuentes no coinciden, se aborta con el detalle exacto de la discrepancia —
> cuál categoría, cuántos encontró cada una — y se decide con esa información, no a ciegas.

Primer caso de aplicación: `SaldoDesalineadoError`, `EncabezadoDeFondoNoEncontradoError`,
`ConsistenciaInternaPdftotextError` y `FuentesDesincronizadasError` (los cuatro en
`fci-santander/extraer-posiciones.ts`) son variantes de esta misma regla — cada uno aborta con el
detalle exacto de qué no coincidió, nunca fuerza un emparejamiento.

## Dependencia de build: Poppler, no "cualquier `pdftotext`"

🔴 **Este extractor depende específicamente de la build Poppler de `pdftotext`, no de xpdf ni de
cualquier binario que resuelva ese nombre en el `PATH`.** Confirmado que dan resultados estructuralmente
distintos para el MISMO PDF real (xpdf 4.00: longitudes de línea no coinciden con el patrón esperado,
llevó a descartar la segmentación por longitud; Poppler 24.02.0: patrón limpio, validó toda la sesión).
Ver ADR-0000 §2.4 para la política general de licencias de dependencias externas (Poppler es GPL,
usado solo como subproceso, nunca importado — y con un punto pendiente de validación legal antes de
venta comercial, marcado ahí).

**Instalación en este entorno (Windows, Chocolatey):** `choco install poppler -y` (requiere shell
elevada — falló en esta sesión por falta de permisos de administrador, quedó pendiente de que JP lo
corra él mismo).

**Pendiente de fijar en el repo** (para que el mismo problema no reaparezca en otra máquina o en CI):
versión mínima de Poppler, y un chequeo de entorno (o nota en README/`package.json`) que documente la
dependencia explícita. Ver la entrada de `HANDOFF.md` que cierra esta tarea para el estado final de ese
punto.

## Estado de salida

Ver `HANDOFF.md`, entrada que cierra esta tarea, para: si la corrida final (con Poppler instalado)
cerró los 3 fondos completos, el resultado del Eje 1 (importe) y por qué se documenta como hipótesis de
negocio sin cerrar (no como bug), y qué queda pendiente (alta de Pannonica SAS como tenant del piloto
— confirmado que hoy NO lo tiene, bloquea el `.xlsx`; promoción formal de la regla reconcile-or-refuse;
validación legal de la dependencia GPL; fijar la versión de Poppler en el repo). La identidad del
titular (Pannonica SAS) y el estado de su tenant (sin dar de alta) ya están resueltos — ver más
arriba.
