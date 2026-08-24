# 18 — El CUIT pegado sin separador a una palabra: hallazgo real, fix, y lo que queda abierto

> Fuente de verdad autocontenida de esta tarea. Quien retome esto no debería necesitar reconstruir
> nada de memoria ni releer el HANDOFF completo — todo lo que hace falta saber está acá.

## Contexto y cómo se llegó a esto

Tarea original: corregir la pérdida del CUIT de contraparte en el adapter de Macro (`packages/ingesta/src/adaptadores/macro.ts`),
donde una sesión previa (HANDOFF, 2026-08-21) había medido que **511 de 1331 movimientos (38%)** de
un lote real (Excel nativo vs. `descripcion` capturada) perdían el CUIT de la contraparte, y había
confirmado —sobre una muestra de 12 filas, contra el único PDF de Macro disponible en `privado/`— que
el dato **sí** está en el texto crudo del PDF: es un bug de extracción, no una fuente ausente.

**Primer intento (válido, pero no era la causa principal):** el banco a veces imprime el CUIT en la
columna `REFERENCIA` (x=264.0) en vez de en la glosa. `RE_REFERENCIA` (`/^\d{1,10}$/`) lo rechaza por
tener 11 dígitos y lo descarta entero. Se corrigió (agregarlo a la glosa cuando tiene forma de CUIT,
sin tocar `referencias`), con su propia ronda de 4 agentes, y **`tester` encontró y se corrigió un bug
real de duplicación** (cuando el CUIT ya está en la glosa Y en la columna, se pegaban dos CUIT juntos,
que `depurarGlosa` reclasificaba como un CBU falso, perdiendo el CUIT real). Este fix queda commiteado,
es correcto, pero **al medir el agregado contra el único PDF real disponible, los números no se
movieron nada** (511 con CUIT / 835 sin, idéntico antes y después) — porque ese documento, ya medido
en `docs/diseno/07-formato-macro.md:390`, **nunca** pone un CUIT en la columna `REFERENCIA` ("siempre
numérica, de 1 a 10 dígitos"). Confirmado además con un diagnóstico geométrico propio (0 filas de
movimiento, de 2865, con un fragmento CUIT-shaped en esa columna).

**La causa real, aportada por el usuario mirando el PDF con sus propios ojos:** el CUIT vive dentro de
`descripcion`, pegado sin separador a una palabra — `DOC` + CUIT, sin espacio ni guion entre ambos (el
valor real no se repite acá; ver §3 sobre por qué esto importa). Medido contra el mismo PDF real:

| Archivo real | Movimientos | Con patrón "letra pegada a CUIT" | `depurarGlosa` extrae CUIT (antes del fix) |
|---|---|---|---|
| Macro `11-2025 cta cte especial.pdf` | 1346 | **569 (42%)** | **0 (0%)** |
| Galicia `06-2026.pdf` | 326 | 0 | — |
| Galicia `07-2026 cta cte especial.pdf` | 1081 | 0 | — |
| Santander `06-2026.pdf` | 158 | 0 | — |

Esto explica la magnitud del 38% original mucho mejor que la columna `REFERENCIA`, y no depende de
ningún PDF perdido: se reproduce con datos reales disponibles hoy.

## 1. Causa raíz

`RE_CUIT` (`packages/shared/src/seguridad/detectores-forma.ts`), el detector de forma compartido entre
el redactor de logs (`redactar.ts`) y la depuración de glosa bancaria (`glosa.ts` → `contraparte.ts`),
anclaba con `\b` en los dos extremos: `/\b(20|23|24|25|26|27|30|33|34)-?\d{8}-?\d\b/g`. `\b` marca una
transición entre carácter de palabra (`\w`) y no-palabra. Una letra y un dígito son **los dos** `\w` —
no hay frontera entre ellos, así que el regex nunca encuentra dónde empezar a matchear un CUIT pegado
directo a una palabra.

**No es un defecto "de siempre":** `security-engineer` investigó el historial y confirmó, vía
`git log -p` de `glosa.ts`, que el patrón ORIGINAL de `glosa.ts` (antes de la centralización, commit
`ff2d992`, 2026-08-10 16:29) usaba un lookaround que excluía solo dígito/guion — **no tenía este bug**.
El bug entró recién con la centralización (`065fe10`, mismo día, 23:34) — **una regresión del propio
commit que decía cerrar la Parte B de seguridad**. El redactor (`redactar.ts`) sí lo tuvo desde su
primer commit (fundacional).

## 2. El fix — dos caras, la segunda pesa más

**No es solo un problema de calidad de datos en la ingesta.** `RE_CUIT` es el mismo detector que usa
`redactar.ts`. Antes del fix, un CUIT real pegado a una palabra **tampoco se redactaba en ningún log**
— es una fuga de datos personales de un tercero silenciosa en el control que existe específicamente
para evitarla, no un defecto de clasificación de contraparte. Sin evidencia de que haya llegado
efectivamente a un log real (no se revisaron logs de producción en esta tarea) — exposición **no
confirmada**, misma naturaleza que la mayoría de las filas de `docs/seguridad/registro-incidentes.md`.

**Registrado como fila #11 de esa bitácora** (no se repite el contenido acá — ver el archivo). Resumen
de su cierre, con los tres números que se debían:

- **Fix**: `RE_CUIT` cambió sus anclas de `\b`/`\b` a `(?<!\d)`/`(?!\d)` — permite letra inmediatamente
  antes/después (el caso real), sigue excluyendo dígito adyacente (no cambia el caso ya cubierto de
  "CUIT con un dígito de más pegado", que sigue cayendo en `corrida_larga`).
- **Prueba de mutación (ADR-0002 §B.0), corrida por `qa-automation`**: 10 mutaciones elegidas para
  refutar; 8/10 atrapadas por la suite existente, 2 sobrevivieron (una sin el lookbehind izquierdo, otra
  con el separador interno aceptando coma/punto) — ambas cerradas con un test nuevo cada una, sin tocar
  el regex de producción. Caso legítimo (CUIT sintético pegado a letra) confirmado en las 8 mutaciones
  que no lo atacaban.
- **Recontado contra el archivo real completo de Macro, post-fix**: de los 569 movimientos con el
  patrón, **569/569 (100%)** ahora extraen el CUIT — sube exacto desde 0/569.
- **Residuo de sobre-captura** (encontrado por `tester`: cualquier "letra + 11 dígitos con prefijo AFIP
  válido", ~9% al azar, ahora matchea): medido contra el mismo archivo real con
  `verificadorCuitEsValido` (dígito verificador AFIP, `packages/shared/src/seguridad/validador-documento.ts`)
  sobre los CUIT extraídos por `depurarGlosa` — **1080 CUIT extraídos en total, 0 con dígito
  verificador inválido (0% de falso positivo en la muestra real disponible)**. No se agregó test propio
  para este residuo — el costo queda declarado como riesgo residual conocido y acotado (defensa en
  profundidad: el lookaround sigue excluyendo dígito adyacente), no materializado en la única muestra
  medida. Es una muestra de 1 archivo: no es una garantía general.
- **Fuga corregida en el propio proceso**: el primer intento de `backend-dev` usó, como ejemplo
  ilustrativo en tres comentarios del código, el valor real que motivó el hallazgo (tomado literalmente
  del mensaje donde se describió el patrón). `code-reviewer`, corriendo `tools/barrido-fuga.ts --strict`,
  lo encontró (dígito verificador AFIP válido, confirmado) antes de cualquier commit. Reemplazado por un
  valor sintético (`DOC20111111112`) en los tres lugares; barrido re-corrido en verde. Ninguna versión
  commiteada tuvo el valor real.

## 3. Galicia y Santander: sin evidencia en esta muestra, no "descartado"

`seguridad-datos-financieros` fue explícito: con 1-2 archivos reales por banco, **"ausencia de
evidencia en esta muestra" no es "evidencia de ausencia"**. El mecanismo (código/referencia pegado
directo al CUIT sin separador) es una decisión de layout del PDF de cada banco, que puede variar por
tipo de cuenta, tipo de movimiento o versión del extracto no cubierta en esta muestra. **No usar esta
medición para decidir NO revisar el histórico ya ingerido de Galicia/Santander** — ver §5.

## 4. El fix de `macro.ts` (columna `REFERENCIA`) sigue siendo válido

Aunque no explica el 38% original, el defecto que corrige es real (confirmado leyendo el código: un
CUIT en la columna `REFERENCIA` se descartaba entero) y queda commiteado por separado. No se descarta.

## 5. ✅ CERRADO 2026-08-23 — el histórico ya ingerido: sin fuga de confidencialidad, clasificación de contraparte sí afectada

**Hallazgo original de `seguridad-datos-financieros`** (sesión anterior): `depurarGlosa` hace
`texto.replace(regex, ...)` — lo que el regex no matcheaba, sobrevivía literal en
`movimiento_bancario_crudo.descripcion`, columna N2 leída sin pasar por el lector auditado (INV-13).
Antes del fix, la hipótesis era que un CUIT pegado a una palabra **no se redactaba en absoluto** —
riesgo de secreto fiscal expuesto en datos ya persistidos del piloto.

**Mecanismo construido para medirlo, con su propio modo plan** (2026-08-23): `MotivoJob` nuevo
`auditoria_seguridad_readonly` (**R42**, `docs/arquitectura/ADR-0002-seguridad.md` §B.2 — fila `R42`
de esa tabla), con dos capas de contención (`set transaction read only` + grant `select` acotado por
columna, migración `0023`) y rastro estructurado reusable (`registrarUsoSoloLectura`). Dos rondas
completas de 5 agentes + una revisión liviana; commiteado (`fbf163e`) antes de tocar piloto.

> ⚠️ **Nota de desambiguación (pedida explícitamente por el titular):** esta **R42** es exclusivamente
> la de `docs/arquitectura/ADR-0002-seguridad.md` §B.2 — auditoría de solo lectura sobre `conJob`.
> **No** es la misma regla que un eventual "R42" de otro documento (por ejemplo, uno de Project
> Knowledge sobre plan de cuentas, fuera de este repo): son catálogos de reglas independientes con
> numeración propia, y coincide el número por casualidad de conteo, no por relación de contenido. Ante
> cualquier cita de "R42" sin archivo de origen explícito, la referencia de ESTA regla es siempre
> `ADR-0002-seguridad.md` §B.2, fila `R42` — nunca asumir que se trata de la otra.

**La tensión que resuelve `registrarUsoSoloLectura`, y por qué hace falta un mecanismo propio** (pedido
explícito del titular, verificado leyendo el código, no asumido del propio documento):

`conJob` (`packages/data/src/db/conexion.ts:274-313`) es la credencial que salta la RLS para un trabajo
de sistema — no hay un usuario humano detrás de la llamada, así que construye **siempre** su `Tx` con
`usuarioId: null` (`envolver(cliente, null)`, línea 300; comentario del propio código, línea 296-298:
"`motivo_job` y no `motivo`"). El choke point normal para dejar rastro de una lectura N2-R,
`leerConAuditoria` (`packages/data/src/db/auditoria.ts`), exige `tx.usuarioId` para fabricar el
`ContextoAuditado` que necesita — y con `usuarioId` siempre `null`, **ningún** `MotivoJob` puede
invocarlo. No es un descuido de este motivo puntual: es estructural al mecanismo de jobs (mismo texto,
casi literal, en el comentario de cabecera de `packages/data/src/db/auditoria-solo-lectura.ts:6-9`).
Sin nada más, el único rastro que deja una corrida de `conJob('auditoria_seguridad_readonly', …)` es el
`logger.warn('db.job.bypassrls', { motivo_job, entorno })` genérico que emite `conJob` en **cada**
llamada (línea 299) — sin cliente, sin alcance, sin conteo de filas leídas: insuficiente para responder
"quién vio el CUIT de qué tercero, cuándo" (R32).

`registrarUsoSoloLectura` (`packages/data/src/db/auditoria-solo-lectura.ts`) resuelve esa tensión sin
tocar `leerConAuditoria` ni simular una identidad de usuario que no existe: es un log estructurado
propio de esta familia de eventos (`loggerAcotado`, evento `auditoria_solo_lectura.uso`) que el
**script** de diagnóstico llama explícitamente **después** de correr su consulta — nunca `conJob` en
sí, que no tiene esa información —, con lo que solo el script conoce: `motivo_job` (tipado,
`MotivoJob`, nunca un `string` suelto), `entorno`, `cliente_ids` (**lista** de uuid tocados, no un
conteo — revisión 2026-08-23 de `security-engineer` + `seguridad-datos-financieros`: un conteo agregado
no permite responder SI el diagnóstico tocó un cliente fuera del alcance autorizado), `filas_leidas` y
un `detalle` opcional de máximo 100 caracteres que nunca es un valor de dato leído, con `ocurrido_en`
calculado **dentro** de la propia función (no a criterio del llamador). No reemplaza `acceso_auditoria`:
la complementa para el único caso donde el camino auditado normal es imposible de invocar. Queda
pensado para reusarse en cualquier `MotivoJob` futuro con la misma tensión, no solo en este.

🔴 **Advertencia honesta, no cerrada por esta revisión:** la fila `R42` del ADR, escrita al commitear
`fbf163e` (antes de que corriera el script real), deja anotado que "nadie llama todavía a esta función
desde un script real contra el piloto — eso entra cuando se escriba el diagnóstico". El diagnóstico real
sí corrió después (HANDOFF 111-112, ver más abajo), pero fue un **script efímero, corrido y borrado**
(mismo método reforzado de E-2 que usa el frente FCI) — no queda en el repo ningún archivo que permita
confirmar si esa corrida invocó `registrarUsoSoloLectura` de verdad. No se afirma que sí lo haya hecho:
sería inventar sobre un archivo que ya no existe. Y la fila `R42` del ADR tampoco se actualizó después
de la corrida (`git log` sobre `ADR-0002-seguridad.md` no muestra ningún commit posterior a `fbf163e`)
— así que, tal como queda escrita hoy, la propia regla sigue describiendo el mecanismo como no invocado
todavía. Quien retome esto y necesite asegurarse de que el rastro estructurado se dejó de verdad en esa
corrida puntual: no hay forma de confirmarlo desde el repo; habría que preguntarle a quien corrió el
script, o exigir que el próximo uso de este motivo llame a `registrarUsoSoloLectura` sin excepción antes
de darlo por hecho.

**Cada migración con su propia autorización explícita, en los términos exactos de CLAUDE.md §1.9
(listar, confirmar, frenar) — detalle real, sacado de HANDOFF (111), no la frase corta que este
documento tenía antes:**

Antes de tocar el piloto, `--estado` (solo lectura) mostró **dos** migraciones pendientes, no una:
`0022_cotizacion_bna.sql` (**ajena a este frente** — catálogo N0 sin RLS, aplicada a LOCAL desde el
2026-08-19 vía commit `54d353d`, nunca había llegado a piloto por despliegue escalonado **por diseño**,
confirmado contra `docs/diseno/12-cotizacion-bna-plan.md:91-92` y HANDOFF (76), no un olvido) y
`0023_auditoria_seguridad_readonly.sql`. Se frenó, se listaron las dos explícitamente, se confirmó con
el usuario — autorización separada para cada una, no "lo pendiente" en bloque.

Antes de tocar piloto con cualquiera de las dos, el usuario pidió commitear `0023` primero (sin
versionar todavía era, para él, un riesgo de pérdida — precedente reciente: el único PDF de Macro ya
perdido durante esta misma investigación). El primer intento de commit lo bloqueó el pre-commit hook
(barrido de fuga en modo estricto): un CUIT real con dígito verificador válido había quedado como
ejemplo en la fila #11 de `registro-incidentes.md`, escrito por `security-engineer` en la sesión
anterior — la misma clase de fuga que ya se había corregido una vez en `detectores-forma.ts` (§2 más
arriba). Corregido a un valor sintético, barrido re-corrido en verde, recién ahí el commit `fbf163e`
entró.

Aplicadas a piloto en dos pasos separados, cada uno con su propia autorización:

1. **`0022` sola.** `0023` se movió temporalmente fuera de `packages/data/migrations/` para que
   `pnpm db:migrate` (con el `DATABASE_URL` de `.env.piloto`) solo viera `0022` pendiente. Aplicada,
   verificada con `--estado`, `0023` devuelta a su lugar (confirmado con `ls` real, no supuesto).
2. **`0023`.** Mostrada completa en el chat, autorización explícita del usuario, aplicada con
   `pnpm db:migrate` normal — era la única pendiente en ese momento.

`--estado` final contra piloto: las 23 migraciones, todas `= aplicada`, nada más pendiente. En este caso
puntual no apareció ninguna migración de más que frenar — pero el paso 1 de la regla (listar antes de
correr nada) se cumplió igual, con las dos nombradas antes de tocar cualquier cosa.

**Casi se mide mal, y se corrigió antes de correr (HANDOFF 112):** en la revisión final del script,
`security-engineer` encontró que el filtro SQL usaba `!~` en vez de `~` para "no redactado" — con ese
bug, la consulta habría contado filas **bien** redactadas como expuestas: el peor error posible en una
medición de seguridad (falsa tranquilidad, no falsa alarma). Corregido junto con 2 errores de
TypeScript estricto (`TS18048`, acceso a fila posiblemente `undefined`) encontrados por el mismo agente
corriendo `tsc --noEmit`, antes de correr contra datos reales.

**Medición real, con todo el pattern-matching corriendo en SQL (nunca una fila cruda salió a Node):**

| | Piloto (3 clientes, 2911 movimientos) |
|---|---|
| Con patrón "letra pegada a CUIT" en `glosaOriginal` | **569** |
| De esos, sin redactar en `descripcion` | **0 (0%)** |

**Investigado el resultado antes de aceptarlo** (0 era inesperado: el código desplegado en el momento
de la ingesta debía tener el mismo bug de `\b`). Explicación real, confirmada con dos diagnósticos de
seguimiento (solo agregados — longitud y presencia de marcador, nunca texto): los 569 CUIT **sí se
redactaban**, pero **mal clasificados** — capturados por el catch-all genérico `documento`
(marcador `[DOC]`, 5 caracteres) en vez de `cuit` (`[CUIT]`, 6 caracteres), porque `RE_CORRIDA_LARGA`
(el catch-all de 9+ dígitos) nunca tuvo el bug de `\b`: sus lookaround ya excluían solo dígito/guion/
punto/coma, sin excluir letra. Confirmado exacto: diferencia de longitud `glosaOriginal` − `descripcion`
= 6 caracteres en las 569 filas, sin una sola excepción (11 dígitos − `[DOC]` de 5 = 6); y **569/569**
tienen el literal `[DOC]` en `descripcion`.

**Conclusión:** el fix de `RE_CUIT` (regla dura, ya cerrado) sigue siendo necesario y correcto — corrige
la **clasificación** de contraparte (`identificadores.documento` en vez de `identificadores.cuit`, que
es por qué `distinguir_tercero_de_socio` fallaba para estos movimientos) — pero **no había fuga de
confidencialidad en el histórico ya ingerido del piloto**: el dato nunca estuvo expuesto sin redactar en
una columna sin auditoría. **No hace falta ninguna herramienta de reproceso/backfill para
confidencialidad.** Sí puede valer la pena, en una tarea aparte, re-clasificar retroactivamente estos
569 movimientos (mover el identificador de `documento` a `cuit` en los datos ya persistidos) para que
`distinguir_tercero_de_socio` los reconozca sin esperar a que se re-ingieran — decisión de negocio, no
de seguridad, y fuera del alcance de esta tarea.

## 6. Qué NO se hizo, a propósito, en esta tarea

- Ningún cambio a `RE_CBU`/`RE_DNI`/`RE_CORRIDA_LARGA` — el problema medido es específico de `RE_CUIT`.
- Ningún reproceso ni backfill sobre datos ya persistidos — ver §5, es la decisión pendiente.
- Ninguna migración ni cambio de esquema.
- Ningún valor real de cliente en ningún archivo commiteado — todos los CUIT de ejemplo en código y
  tests son sintéticos (dígitos repetidos, prefijo AFIP válido, nunca un CUIT real).

## 7. Commits de este frente, en orden cronológico

Verificado con `git log --oneline` y `git show --stat` sobre cada uno — no asumido de este documento ni
de HANDOFF. Son exactamente dos, ambos del 2026-08-23:

1. **`fbf163e`** (15:05:40 -0300) — `feat(data): MotivoJob auditoria_seguridad_readonly (R42), grant
   angosto + rastro estructurado`. El mecanismo completo de §5: `conJob`, la migración
   `0023_auditoria_seguridad_readonly.sql` (**incluida en este commit — no tiene commit propio**), la
   fila `R42` del ADR, `registrarUsoSoloLectura` y sus tests (9 archivos). Commiteado **antes** de tocar
   el piloto, a pedido explícito del usuario.
2. **`cb084a0`** (15:31:14 -0300) — `fix(ingesta): CUIT de contraparte pegado sin separador — Macro
   REFERENCIA + RE_CUIT`. Lleva **juntos** los dos fixes de §2 y §4 de este documento (el fix de
   `RE_CUIT` en `packages/shared/src/seguridad/detectores-forma.ts` y el fix de la columna `REFERENCIA`
   en `packages/ingesta/src/adaptadores/macro.ts`), sus tests, la fila #11 de
   `docs/seguridad/registro-incidentes.md`, y este mismo documento en su versión original (7 archivos,
   confirmado con `git show cb084a0 --stat`).

**No es parte de este frente, pero se aplicó al piloto en la misma ventana de autorización que `0023`**
(ver §5): `54d353d` (2026-08-19) — `feat(data): 0022 — caché de cotización BNA, paso 1`. Se cita acá
solo para que quede claro por qué `--estado` mostraba dos migraciones pendientes y no una al momento de
tocar el piloto — el contenido de `0022` es ajeno a CUIT/R42 y no se documenta acá (ver
`docs/diseno/12-cotizacion-bna-plan.md`).

## Cómo retomar

1. **Decisión de producto pendiente, sin dueño técnico todavía** (HANDOFF 113): decidir si vale la pena
   re-clasificar retroactivamente los 569 movimientos del piloto que quedaron con su identificador en
   `identificadores.documento` en vez de `identificadores.cuit` (§5) — mover el candidato de
   contraparte de una clase a otra en datos ya persistidos, para que `distinguir_tercero_de_socio` los
   reconozca sin esperar una re-ingesta. No es una decisión de seguridad (§5: sin fuga, los datos ya
   estaban redactados) — es de impacto en datos que Laura (la contadora) ya pudo haber visto y trabajado
   con la clasificación actual. La revisa el titular por separado.
2. Si aparece un PDF real nuevo de Galicia o Santander (más allá de los 3 ya medidos en §3): repetir el
   mismo diagnóstico de "letra pegada a CUIT" antes de asumir que el patrón no existe ahí.
3. Si se necesita confirmar que `registrarUsoSoloLectura` (§5) se invocó de verdad en la corrida real
   del diagnóstico: no se puede, desde el repo — el script era efímero y se borró (§5, nota de
   advertencia). Si hace falta esa garantía hacia adelante, dejarla como exigencia explícita del próximo
   script que use este `MotivoJob`, no como algo ya cerrado.
4. Entrada de HANDOFF que cierra esta tarea (y la de FCI en paralelo): referencia a este documento y a
   la fila #11 de `docs/seguridad/registro-incidentes.md` — no repite contenido.
