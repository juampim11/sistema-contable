# Registro de excepciones — datos reales fuera de producción

> **Procedimiento completo: `docs/arquitectura/ADR-0002-seguridad.md` §F.3.**
>
> Este registro existe para un solo caso: **hubo que sacar un dato real de producción para reproducir un
> bug.** La respuesta por defecto a ese pedido es **no**, y solo se llega acá después de agotar la
> reproducción sintética (§F.1). Un agente no autoriza esto ni lo asume: lo autoriza el titular del
> estudio, explícitamente, antes de extraer nada.

## Excepciones otorgadas

| # | Fecha | Bug | Qué se extrajo (campos, no valores) | Anonimizado en origen | Autorizado por | Dónde quedó | Se destruye | Destruido |
|---|---|---|---|---|---|---|---|---|
| **E-1** | 2026-08-10 | No es un bug: es la **construcción del piloto** (Módulo 1, primer adaptador), en encuadre de **PoC de viabilidad** — parseo, extracción y generación del asiento | Extractos bancarios completos de **varios clientes del estudio (cantidad indeterminada)**, 8 bancos, **períodos heterogéneos** (verificado al menos 11-2025 y 06-2026): carátula (CUIT, número de cuenta, CBU, titular, condición IVA) y cuerpo (fecha, concepto, importe, saldo, contrapartes con sus CUIT). Más el transcript de la entrevista | **No** — se trabaja con el material tal como lo entregó el estudio | **Juan Pablo Marchini** (titular del proyecto), **acordado con la contadora del estudio**. **Ampliación a varios titulares confirmada explícitamente el 2026-08-10** — ver §E-1 | `privado/extractos/` y `privado/laura-transcript.txt`, gitignoreados y anclados; base local Docker; MinIO local | **Sin fecha, con criterio: al pasar a producción.** Prod arranca **vacía** y procesa desde cero; nada de la demo se promueve (`docs/devops/01-entornos.md` §0.bis) | — |
| **E-2** | 2026-08-22 | No es un bug: es descubrimiento de formato para construir/calibrar el futuro parser de posición FCI — mismo encuadre de "construcción y calibración" que E-1, alcance menor (un cliente, un tipo de documento, sin carga a base ni generación de asiento) | 3 archivos PDF: extracto de **POSICIÓN** de FCI (tenencias + movimientos por fondo) de Banco Galicia, cortes 30/06, 31/07 y 29/08 de 2025, de **Elite-IT SAS** (identificado por su CUIT en la carátula del documento, no transcripto acá — mismo criterio que el resto de este registro) — cliente **fuera del piloto, sin tenant en la base hoy** | **No** — se trabaja con el material tal cual, bajo **método reforzado**: cero fragmentos de texto (ni enmascarados) llegan al contexto de ningún agente; solo metadatos estructurales en el descubrimiento, y booleano `cierra/no-cierra` por fondo+corte en la verificación (delta solo como categoría acotada) | **"No asumo que E-1 cubre esto, registrá primero. Dos motivos, no uno: (1) el documento es distinto — extracto de posición de FCI (tenencias + movimientos por fondo), no extracto de cuenta corriente, que es lo que procesa Módulo 1; (2) el cliente es distinto — estos 3 PDF son de Elite-IT, que no es cliente del piloto y no tiene tenant en la base hoy. E-1 está scoped a Módulo 1 y al piloto, no a cualquier extracto real de cualquier cliente. Dejá constancia explícita [...] de que se amplía el alcance para: extractos de FCI (tipo de documento nuevo) de Elite-IT (cliente fuera del piloto, sin tenant), bajo el mismo método reforzado [...]. Una vez registrado, seguí con el descubrimiento de formato." — Juan Pablo Marchini, 2026-08-22** | `privado/extractos/Sistematizacion Conciliacion Bancaria/FCI/` (ya existente, gitignoreado). Ningún derivado persiste: no se carga a `packages/data` ni a ninguna base — Elite-IT no tiene tenant y esta tarea no lo crea. Script efímero en el scratchpad de la sesión, fuera del repo, borrado tras usarlo | El PDF original no genera un derivado con TTL propio (sin fixture, sin export). Pendiente y fuera del repo: revisar/borrar el output del script y este pedido en el transcript local de la sesión (mismo criterio que el incidente #9), a cargo de JP al cerrar la sesión | — |
| **E-5** | 2026-08-24 | No es un bug: es descubrimiento de formato + primera validación del motor de FCI (`packages/fci` + `consumirRescate`) contra un **cliente real del estudio** — excepción nueva, no ampliación de E-2, por los mismos dos motivos que separaron E-2 de E-1 (documento distinto, cliente distinto) | 1 archivo PDF: extracto de **POSICIÓN** de FCI de **Banco Santander**, corte 06-2026, de **Pannonica SAS** (cliente real del estudio, identidad confirmada 2026-08-25 tras un addendum de corrección — ver §E-5; NO es El Prat S.A.S., que fue la atribución original errónea; tenant en el piloto: **confirmado que NO tiene, 2026-08-25 — ver addendum**) | **No** — se trabaja con el material tal cual, bajo el mismo **método reforzado** que E-2/E-4: cero fragmentos de texto real (ni enmascarados) al contexto de ningún agente; descubrimiento solo con metadatos estructurales, y offsets angostos descritos en términos gruesos si el rango por sí solo insinúa el contenido; verificación como booleano `cierra/no-cierra` y categoría acotada de delta, nunca el valor exacto | Ver §E-5 para el detalle y la cita completa — Juan Pablo Marchini, 2026-08-24 | `privado/extractos/Sistematizacion Conciliacion Bancaria/FCI/Santander/` (ya existente, gitignoreado). **Sin carga a `packages/data`: E-5 NO autoriza ninguna persistencia contra el piloto, bajo ningún concepto — solo lectura de metadatos y validación en memoria.** Script(s) efímero(s) en el scratchpad de la sesión, fuera del repo, mostrados antes de correr y borrados después | El PDF original no genera un derivado con TTL propio salvo el `.xlsx` de validación (ver §E-5 para su TTL, mismo criterio que el addendum de E-2). Pendiente, a cargo de JP: revisar/borrar el output local de la sesión al cerrarla | — |

### E-1 — el detalle, porque esta excepción no es como las otras

Las demás excepciones de este registro son para **reproducir un bug**: se extrae lo mínimo, se anonimiza en
origen y se destruye al cerrar. Esta es distinta y hay que decirlo con precisión, porque el encuadre define
qué controles corresponden.

**Qué es:** el material real del estudio se usa para **construir y calibrar** el Módulo 1. No hay forma de
escribir un adaptador de extractos sin el formato real, y el formato solo existe dentro de los archivos.

**Encuadre, fijado por el titular: es un PoC.** La contadora entregó el material para **evaluar viabilidad de
parseo, extracción y generación del asiento**, sin identificar cliente ni período. La falta de metadatos y las
inconsistencias de período son **esperables en este encuadre y no son el foco**: se resuelven con workaround
—un identificador de cliente ficticio cuando no hay dato— y solo se le pide aclaración a la contadora si algo
**traba** el avance.

### Corrección del alcance — 2026-08-10

La primera redacción decía *"un cliente del estudio, 8 bancos, período 06/2026"*. **Las tres partes eran
incorrectas o incompletas**, y el error no es de forma: el alcance declarado es lo que determina qué controles
alcanzan.

| Lo que decía | Lo que es |
|---|---|
| **un** cliente del estudio | **varios clientes distintos** — se ve por el CUIT de cada carátula |
| (implícito: se sabe cuántos) | **cuántos, no se sabe.** En encuadre de PoC no hace falta contarlos para avanzar |
| período **06/2026** | **períodos heterogéneos.** `docs/diseno/07-formato-macro.md` está medido sobre **11-2025**. No se asume que exista un período común |

**Qué cambia con eso, que es lo único que importa acá:** con un solo cliente, "todo el material va al mismo
tenant local" era correcto por accidente. Con varios, **cargar todos los extractos bajo un solo `cliente_id`
mezcla carteras dentro de la base** y desactiva de hecho lo único que el Módulo 1 tiene para demostrar —INV-6,
RLS forzada, unicidad por cliente—. El aislamiento dejaría de estar bajo prueba justo en el entorno donde hay
material real. De ahí los controles **6 a 8**, que son nuevos.

### Ampliación confirmada — 2026-08-10

La autorización original se dio sobre "el cliente piloto", y el material resultó ser de **varios titulares**.
Se planteó la diferencia al titular del proyecto, con la consecuencia sobre la mesa —**no es reversible**:
`on delete restrict` sobre `cliente_id` y una `acceso_auditoria` append-only sin `grant delete` significan
que *"después lo borramos"* **no es una opción disponible**— y la respuesta fue explícita:

> **"Sí, la excepción cubre a todos los titulares del material."** — Juan Pablo Marchini, 2026-08-10.

Queda registrado, entonces, que la ampliación **se decidió sabiendo** que el radio de daño ya no es la cartera
de un cliente sino la de N, y que la carga a la base local no se deshace. **Los controles 6, 7 y 8 de la lista
de abajo son la contrapartida de esa autorización**, no una recomendación: un tenant por titular sin
excepción, identificador provisorio opaco, e INV-6 probado con el cruce real.

Y sigue en pie la condición de cierre: **esto es una demo; al pasar a producción todo lo cargado se borra o se
levanta un entorno limpio desde cero** (`docs/devops/01-entornos.md` §0.bis).

**Quién lo decidió:** el titular del proyecto, **acordado previamente con la contadora del estudio**. La
decisión está tomada con la objeción de seguridad sobre la mesa: ADR-0002 §A.1 dice que un dato N2/N2-R
**nunca** va a un entorno de prueba, y §F.2.4 prohíbe restaurar datos reales en un entorno no productivo. El
titular decidió avanzar. Queda registrado que el criterio del ADR se conocía. **El alcance mayor —varios
clientes en vez de uno— no reabre esa decisión, pero sí agranda el radio de daño: no es la cartera de un
cliente, son N.**

**Consecuencia inmediata, que es lo que importa de este registro:** dado que hay material real en juego, **el
entorno local se trata como productivo a los efectos de los controles**. En concreto:

1. **El pepper de `cbu_hmac` no puede ser el de `.env.example`** — ese valor es público (está en el repo, en
   cada clon y en cada caché de CI), así que el HMAC que produce no protege nada. Hay un guard que aborta.
2. **`pnpm db:seed` no corre** con lotes de ingesta cargados: truncaría el rastro de auditoría append-only.
   Hay un guard que aborta.
3. **Ningún valor del material entra al repo.** Lo verifica `pnpm barrido` en modo estricto, cruzando cada
   candidato contra los caracteres extraídos del material real. **Con varios clientes, el modo estricto tiene
   que cruzar contra TODOS los archivos, no contra los del primero**: un barrido que enumera de menos da
   verde y es ciego — ya pasó una vez (ADR-0002 §H.3.bis, corrección 4).
4. **Ningún valor del material entra al contexto de un agente.** La lectura del CBU para el alta la hace un
   **script** que lo toma del PDF, calcula el HMAC e inserta, **sin imprimirlo nunca**.
5. **Al repo entran solo fixtures sintéticos**, con su gate de 7 chequeos.
6. 🆕 **Un `tenant_node` de tipo `cliente` por cada titular distinto, sin excepción.** **Prohibido cargar dos
   carátulas de titulares distintos bajo el mismo `cliente_id`**, aunque sea "para probar rápido": eso es una
   mezcla de carteras en la base, no un atajo de desarrollo, y no se deshace (ver arriba: `on delete
   restrict` + auditoría append-only). Ante la duda de si dos archivos son del mismo titular: **sobre-partir,
   nunca unir.** Partir de más se arregla; unir de más es irreversible.
7. 🆕 **El identificador del cliente provisorio es opaco.** No puede contener: CUIT ni fragmento suyo, razón
   social ni iniciales ni apodo reconocible, banco, número de cuenta, CBU ni sus últimos 4, período, ni el
   nombre del archivo original (ni un hash de él: es estable y se revierte con un diccionario de razones
   sociales del padrón — la misma lógica por la que `cbu_hmac` lleva pepper). Un `uuid` y una etiqueta
   secuencial sin significado. **El mapeo provisorio↔real, si alguna vez se escribe, es N2-R**: fuera del
   repo, nunca en un `.md`, nunca en el contexto de un agente. Lo preferible es **no escribirlo**: para el
   PoC alcanza con que los titulares sean distintos, y sin mapeo el material local queda seudonimizado.
8. 🆕 **INV-6 se prueba con el cruce, no solo con el camino feliz.** Con un solo cliente no había contra quién
   cruzar. Ingestar el archivo del titular A declarando `--cliente B` **tiene que** terminar en
   `cuenta_no_pertenece_al_cliente`, cero filas en los dos, rechazo auditado y log sin el CBU. Es lo que
   convierte el aislamiento de "verificado en sintético" a "verificado en el material que lo rompe".

**Y el modo de falla más probable, que no es un control pero conviene tener escrito:** con titulares
provisorios anónimos, el operador no va a saber qué `--cliente` declarar y va a probar. INV-6 lo rechaza
—bien—, pero el atajo tentador es dar de alta el CBU en el cliente que tenía a mano. Eso **satisface el
control con la atribución equivocada**. La regla: el alta de la cuenta y la ingesta se hacen desde el mismo
archivo, en el mismo paso, con el mismo `cliente_id`. `cuenta_no_registrada` **nunca** se resuelve dando de
alta "en el que sea".

**Sin fecha de destrucción pero CON criterio (decisión del titular, 2026-08-10):** el material es el insumo
del producto, no de un bug, así que no hay una fecha de calendario. Pero sí hay un evento:

> **Esto es una DEMO. Al pasar a producción, todo lo cargado se borra o se levanta un entorno limpio desde
> cero. Producción arranca vacía y procesa la información desde cero.**

De ahí tres reglas que cierran el riesgo de que la excepción se vuelva permanente por inercia:

1. **Nada de la demo se promueve.** El camino a producción es **esquema + código**, nunca datos. No hay
   `pg_dump` del piloto a prod, ni migración de tenants, ni copia del bucket.
2. **Los identificadores no sobreviven.** En producción se genera un **pepper nuevo**, y eso por sí solo
   vuelve irreproducibles los `cbu_hmac` de la demo — que es exactamente lo que se busca.
3. **Las altas se rehacen en producción**, por una persona del estudio, con la identidad real. Ningún tenant
   provisorio llega a prod.

Lo que **sigue** abierto es dónde vive el material mientras dura la demo y con qué protección (ADR-0000 §9).
Mientras siga en una máquina de escritorio, esta fila es una **deuda abierta**, no una excepción cerrada. **Y
la deuda es proporcional a la cantidad de titulares, no a la cantidad de archivos.** Detalle del encuadre de
entornos: `docs/devops/01-entornos.md` §0.bis.

**Lo que sigue sin resolverse y no depende de este registro:** el sujeto de dato más numeroso del material no
es el cliente del estudio — son **las contrapartes de sus extractos**, terceros que no tienen relación con el
estudio y que no consintieron nada. Con varios titulares ese conjunto **se multiplica y además se cruza**: la
misma contraparte puede aparecer en los extractos de dos clientes distintos, y esa coincidencia es en sí misma
una relación comercial que el sistema no debería poder revelar. Qué corresponde con sus datos es el hueco de
mayor volumen del producto y **no hay fuente cargada en `knowledge/`** para responderlo (ADR-0002 §G, G-1 a
G-4).

### E-2 — el detalle: extracto de posición FCI de un cliente fuera del piloto, sin carga a la base

**Por qué es una excepción nueva, no una ampliación de E-1** (los dos motivos que fijó JP): el
documento es distinto — extracto de POSICIÓN de FCI (tenencias + movimientos por fondo), no el
extracto de cuenta corriente que procesa Módulo 1 — y el cliente es distinto: Elite-IT SAS no es
cliente del piloto y no tiene tenant hoy. E-1 está scoped a Módulo 1 y al piloto, no a cualquier
extracto real de cualquier cliente.

**Encuadre:** descubrimiento de formato de un tipo de documento nuevo, para construir/calibrar el
futuro parser de posición FCI — mismo espíritu de "construcción y calibración" que E-1, alcance mucho
más chico.

**Método reforzado, ya dictaminado por `seguridad-datos-financieros`, sin reinventar:**
1. Descubrimiento: cero fragmentos de texto real en el contexto de ningún agente, ni enmascarados —
   solo metadatos (conteo de páginas/líneas, longitud de línea, offsets de columna, matches de patrón
   como booleano/conteo).
2. Verificación: `cierra: true/false` por fondo y corte; si no cierra, el delta se reporta como
   categoría acotada, nunca el valor exacto.
3. Script efímero en el scratchpad de la sesión, fuera del repo; se muestra completo en el chat para
   aprobación de JP **antes** de correr (regla fijada tras el incidente #10); se borra después.

**Sin carga a la base: controles 6-8 de E-1 son no-aplica declarado, no hueco silencioso.** El plan
aprobado no toca `packages/data`; Elite-IT no tiene tenant y esta tarea no lo crea. Sin `INSERT`, no
hay fila que aislar: tenant por titular (6), identificador opaco (7) e INV-6 con cruce (8) no aplican
**hoy**. Si una tarea futura carga este material, los tres rigen igual que en E-1, sin excepción, con
alta de tenant aparte y su propia convocatoria a `dba-data` + `security-engineer` +
`seguridad-datos-financieros`.

**Retención residual, mismo patrón que el incidente #9.** El PDF no genera derivado con TTL propio. Lo
que sí puede quedar es el output del script (booleano/categoría, no dato en claro) y este mismo pedido
en el transcript local de la sesión. Pendiente, fuera del repo, a cargo de JP: revisar y borrar los
archivos locales de esta sesión al cerrarla.

### Addendum E-2 (2026-08-23) — export `.xlsx` real generado, y `SendUserFile` evaluado y descartado

**(a) Hubo un Paso 2 con un `.xlsx` real.** A diferencia del descubrimiento de formato original (solo
metadatos/booleanos, sin derivado persistido), esta sesión generó un archivo real:
`privado/extractos/Sistematizacion Conciliacion Bancaria/FCI/export/fci_elite-it_junio-agosto-2025.xlsx`
— 3 hojas por fondo + hoja Resumen, costeo PEPS de Elite-IT. Es **N2-R** por el mismo criterio que la
sección "Exports N2-R declarados" de este archivo (ADR-0002 §A.2, regla 2: un derivado hereda el nivel
máximo de sus insumos), aunque este flujo **no pasa por `pnpm exportar:excel`** — es un **one-off fuera
del piloto**, corrido con `packages/ingesta/scripts/exportar-fci.ts` (genérico, recibe rutas y config
por `--config`, nunca hardcodeadas) contra un cliente (Elite-IT) que no tiene tenant en la base y sobre
el cual esta tarea no persiste nada. No genera `acceso_auditoria` (no hay `INSERT`, no hay lectura vía
`conUsuario`/`leerConAuditoria`) ni un JSON de salida con `destruirAntesDe` calculado por el script,
porque ese mecanismo es específico de `pnpm exportar:excel` (`packages/ingesta/src/planilla/`) y este
flujo es otro. Por eso se documenta manualmente acá, con el **mismo TTL de 7 días** que ya usa esa
sección por analogía, a cargo de JP:

| # | Fecha | Motivo | Cliente | Generado el | Se destruye el | Corrido por | Dónde quedó | Destruido |
|---|---|---|---|---|---|---|---|---|
| E-2/1 | 2026-08-23 | Entregable de costeo PEPS para el estudio (one-off fuera del piloto, no `pnpm exportar:excel`) | Elite-IT SAS (fuera del piloto, sin tenant) | 2026-08-23 | 2026-08-30 (generado + 7 días, mismo criterio que "Exports N2-R declarados") | Juan Pablo Marchini | `privado/extractos/Sistematizacion Conciliacion Bancaria/FCI/export/fci_elite-it_junio-agosto-2025.xlsx` | — |

**(b) `SendUserFile` (herramienta del harness): evaluada y descartada como canal de entrega — no
"no hizo falta".** Antes de decidir cómo entregar el `.xlsx` al usuario se evaluó `SendUserFile` y se
descartó explícitamente. `security-engineer` confirmó, con cita textual de
`code.claude.com/docs/en/data-usage` y `.../tools-reference`, que esa herramienta pasa el archivo por
infraestructura de Anthropic: transcript sincronizado, retención estándar de aproximadamente 30 días,
sin mecanismo de borrado propio del estudio salvo Zero Data Retention (no verificado para esta cuenta).
Eso es **incompatible con el TTL de 7 días** que este mismo registro fija para exports N2-R — un canal
que retiene ~30 días no puede ser el vehículo de un dato que el estudio se comprometió a destruir en 7.
El usuario decidió: **solo se entrega el path local** (el archivo ya está en el disco de quien conduce
la sesión, sesión CLI local) y que esta evaluación quede registrada como decisión tomada con su motivo
real, para que no se repita la pregunta en la próxima sesión que necesite entregar un N2-R.

### Addendum E-2 (2026-08-24) — nombre real de fondo expuesto como nombre de hoja: decisión propia, no heredada

En la ronda 2 del export (mismo `.xlsx`, `packages/ingesta/src/fci-galicia/extraer-posiciones.ts`),
`FondoExtraido.fondo` pasó a exponer el nombre real del fondo (columna "nombre" de la tabla de posición
del extracto, ~20-25 caracteres) como nombre de hoja del `.xlsx` — antes era un rótulo opaco `fondo_N`.

🔴 **Esta es una decisión de exposición NUEVA, con su propio motivo — no una extensión de la
autorización de segmentación** (esa cubre específicamente el patrón `FONDO - <nombre ABREVIADO> CLASE
<letra>`, ~12 caracteres, usado para delimitar bloques de movimientos; es un dato distinto del nombre
completo de la tabla de posición, aunque ambos identifiquen el mismo fondo). `seguridad-datos-financieros`,
convocado específicamente para esta decisión (sin citar la autorización anterior como si ya la
cubriera), razonó por estructura y dominio que es altamente probable que sea seguro, pero no llegó a
confirmarlo con certeza — no tiene acceso a `privado/` para verificarlo empíricamente contra los 3 PDF
reales. Pidió una verificación visual puntual del titular.

**Verificación**: booleana, hecha por el titular (Juan Pablo Marchini) mirando directamente los 3 PDF
reales de Elite-IT (no una inferencia ni una cifra transcripta a ningún agente ni a este documento) —
"la columna 'Fondo' de la tabla de posición trae únicamente 'FIMA `<nombre>` CLASE `<letra>`' en los
tres cortes (junio, julio, agosto), sin ningún dato de cuenta, comitente o apodo ligado a Elite-IT".
Confirmada en el chat de diseño de la sesión del 2026-08-24, antes de regenerar el `.xlsx` con el
nombre real. Con esta confirmación: el nombre real de fondo es dato de producto del banco (familia
FIMA de Galicia), no dato de Elite-IT, y puede exponerse como nombre de hoja — decisión registrada
acá, no solo en la conversación.

### E-3 — placeholder de demo insertado en El Prat (Santander): no es un caso de §F.3

**Por qué esta sección no encaja en la tabla de arriba.** Todo lo que precede es sobre **sacar** un dato
real de producción — extraerlo para reproducir un bug, con autorización previa y destrucción posterior.
Esto es lo inverso: **insertar** un dato **sintético, explícitamente marcado como falso**, en el padrón
de un cliente real del piloto. El riesgo no es secreto fiscal filtrado (no sale nada real) — es que en
el futuro alguien confunda la fila con un dato verdadero. Por eso va como subsección propia, mismo
estilo que el detalle de E-1/E-2, y no como fila de la tabla.

**Qué es:** Laura (la contadora del estudio) marcó 2-3 filas de El Prat en el export enriquecido como
"es socia", sin dar nombre ni CUIT — no hay base para saber si es una persona o más de una. Se carga
**una sola fila** placeholder en `padron_socio` ("Socia 1 (El Prat) — placeholder demo, sin CUIT real,
pendiente confirmar con Laura"), para que el sistema pueda imputar esos movimientos mientras se espera
la confirmación real — sin inventar una segunda fila sin evidencia (`docs/diseno/00-cliente-piloto-laura.md`,
mismo criterio de minimizar que §F.1 de este documento).

**El identificador, y por qué es imposible que colisione con una persona real** (Ronda 1 de convocatoria
— `dba-data` + `security-engineer` + `seguridad-datos-financieros`, tres correcciones sucesivas antes de
cerrar el diseño):

1. **Forma válida** — 11 dígitos, prefijo AFIP real (`27`, persona física) — pasa el mismo constraint de
   forma que cualquier alta real (`padron_socio_doc_forma_chk`, migración `0013`).
2. **Cuerpo fuera de cualquier rango real de asignación, Y verificado contra el material real con
   `pnpm barrido`, no solo razonado.** Confirmado contra fuente pública (RENAPER, Disposición
   4678/2019, vía búsqueda web en esta sesión): el DNI argentino es monotónico y en 2026 va de números
   bajos históricos hasta ~70-71 millones (los recién nacidos desde 2023 arrancan en 70.000.000; el
   tramo 60.000.000-69.999.999 está reservado pero **sí** se usa para CUIT/CUIL real de extranjeros, así
   que no sirve como "vacío"). El cuerpo elegido, `98.765.432`, está muy por encima de cualquier
   asignación real o previsible durante la vida útil de este piloto.
   - **Primera propuesta, descartada:** reusar el cuerpo del CUIT `CANARIO` de
     `packages/data/src/seed/sintetico.ts` (`'30-99999999-0'`). `seguridad-datos-financieros` lo objetó
     en Ronda 1: ese valor está reservado en exclusiva para los tests anti-fuga INV-5/INV-8 (el propio
     archivo lo dice: "no se usan para nada más") — reusarlo acá no es una fuga, pero rompe la propiedad
     que el canario necesita (que sea inconfundible con cualquier otro dato, incluido este placeholder).
   - **Segunda propuesta, también descartada — y por qué importa cómo se descartó:** un cuerpo con un
     solo dígito repetido ocho veces "sonaba" fuera de rango por el mismo razonamiento del punto 2, pero
     **`code-reviewer` corrió `pnpm barrido` (modo estricto, `privado/` presente) y encontró que ese
     cuerpo SÍ aparece como coincidencia dentro del material real** — una repetición de dígito tiene
     probabilidad no despreciable de aparecer como substring de un número más largo, con el volumen de
     datos reales que hay en `privado/`. El valor descartado no se deja escrito acá, ni siquiera como
     ejemplo — es exactamente el tipo de candidato que el barrido existe para atrapar, y este mismo
     registro no es una excepción a esa regla. La lección, para cualquier valor sintético futuro en este
     repo: **razonar "está fuera de rango" no alcanza — hay que correr `pnpm barrido` contra el valor
     elegido y confirmarlo en verde antes de fijarlo**, nunca asumirlo.
3. **Dígito verificador deliberadamente inválido.** Para la base `2798765432` el verificador real da `0`
   (algoritmo de `packages/shared/src/seguridad/validador-documento.ts`); el valor final usa `1`. Ni
   corrigiendo el dígito a mano el resultado se vuelve una identidad real: el cuerpo mismo ya está fuera
   de rango.

**Valor final: `27-98765432-1`** (normalizado: `27987654321`) — verificado en verde con `pnpm barrido`
en modo estricto contra el material real de `privado/`.

**Cómo se carga — el script es de un solo uso, no un `alta-socio.ts` con el checksum salteado.**
`apps/cli/src/alta-socio-placeholder-demo.ts`. Diseño corregido dos veces en Ronda 1 antes de escribir
código:
- **No "salta la validación de checksum" en general** — acepta **únicamente** el valor exacto de arriba
  (comparación `===`), no cualquier CUIT con forma válida y verificador inválido. `security-engineer` y
  `seguridad-datos-financieros` coincidieron: un bypass genérico reabriría la única defensa que existe
  contra un CUIT real mal tipeado.
- **El `--cliente` está hardcodeado** (El Prat, `80741296-8cbf-4a4f-bcf1-8e8cb1c57584`), no es argumento
  de la CLI — `dba-data`: un script que aceptara cualquier tenant podría, por error de tipeo, insertar
  este placeholder en el padrón de OTRO cliente real, fila que después no se puede borrar
  (`padron_socio_documento` no tiene `grant delete`/`update` para nadie).
- Todo lo demás del camino estándar se preserva sin cambios: hasheo HMAC+pepper (`altaDeSocio`, sin
  ninguna rama especial), prompt oculto de doble tipeo (`pedirValorConfirmado`), RLS y rol
  `socio`/`contador` sobre el tenant vía `conUsuario`/`escribirConAuditoria`. El motivo de auditoría dice
  explícito "PLACEHOLDER DEMO", para que un auditor futuro distinga esto de un alta real sin tener que
  adivinar por el número.
- Test de guard (mismo patrón que `packages/data/scripts/sembrar.ts:113-124`):
  `verificadorCuitEsValido(DOCUMENTO_PLACEHOLDER) === false`, falla ruidoso si algún día no lo es.

**Consecuencia a tener presente, no un bug:** como `documento_hmac` se deriva por cliente, reusar este
mismo valor una segunda vez en El Prat mientras la primera fila siga con vigencia abierta va a fallar
por el índice único parcial `uq_padron_socio_vigente` (fail-closed, correcto). Si algún día hace falta
un segundo placeholder ahí, necesita su propio valor — este script es de un solo uso, no una herramienta
general.

**Autorizado por:** Juan Pablo Marchini, sesión del 2026-08-24, sobre el diseño ya corregido por los tres
agentes de Ronda 1 ("Aprobado, con las correcciones que salieron de los cuatro dictámenes... [1] Cuerpo
sintético corregido... El script acepta ÚNICAMENTE ese valor exacto"). El cuerpo que JP aprobó en esa
misma sesión (dígito repetido ocho veces, no reproducido en este documento — ver punto 2 de arriba) fue
el que `code-reviewer` descartó después con evidencia de `pnpm barrido` — la autorización de JP cubre el
diseño (valor único, `--cliente` hardcodeado, verificador inválido), no el dígito exacto, que se
corrigió una vez más tras su aprobación.

**No aplica ninguna fecha de destrucción:** no es un dato extraído con TTL — es una fila marcada,
destinada a permanecer hasta que Laura confirme la identidad real y se dé de baja (`bajaDeSocio`) a favor
de un alta real.

**Corrida real, 2026-08-24:** ejecutada por Juan Pablo Marchini, `ENV_FILE=.env.piloto`, con
`pnpm alta:socio:placeholder-demo --usuario 11111111-1111-1111-1111-111111111111 --vigencia-desde
2025-10-20`. Resultado: `socio_id = 4fe4c6f9-9880-4a33-a84f-4fe580081cc9`, entorno confirmado `piloto`.
Documento tipeado: el valor placeholder exacto de arriba, dos veces, formato sin guiones
(`27987654321`) para evitar el mismo desfasaje de formato entre las dos tipeadas que ya había fallado
una vez en la Parte 1.

---

### E-4 — lectura de `descripcion` real del piloto para calibrar 4 reglas de léxico provisorias

**Por qué hace falta esta excepción y no alcanza con la clasificación N2 de la columna.** Para escribir
el regex de 4 reglas de léxico provisorias (Galicia: suscripción FCI, formato de cobro de tarjeta, Plan
de Pagos AFIP; ver `HANDOFF.md` para el detalle completo) hacía falta ver la glosa bancaria original de
un puñado de filas `Indeterminado` del piloto. `descripcion` de `movimiento_bancario_crudo` está
clasificada **N2**, no N2-R (`packages/shared/src/seguridad/clasificacion-campos.ts`) — pero N2 en la
base **no autoriza automáticamente** que ese texto entre al contexto de un agente (LLM externo): ADR-0002
§A.2 regla 5 dice explícito que eso es decisión registrada del titular, no algo que un agente se
autoconceda. Y la premisa "ya está redactada de identificadores" es además **falsa contra la evidencia
real de este mismo repo**: el incidente #11 (`docs/diseno/18-cuit-pegado-sin-separador.md`) midió que
569/1346 filas (42%) de un lote tenían un CUIT de tercero pegado sin separador en `descripcion`, en
Galicia y Santander — los mismos dos bancos que esta calibración necesitaba leer.

**Método reforzado, mismo criterio que E-2 — cero texto al contexto de un agente:**
1. **JP corre el script él mismo** (`apps/cli/src/calibrar-lexico-metadatos.ts`), en su propia terminal,
   contra el tenant y lote que corresponda.
2. El script computa, para cada movimiento en clase `sin_reconocer`/tipo `indeterminado` del lote, si su
   `conceptoBanco` matchea contra una lista de patrones candidatos (escritos por quien conduce la sesión,
   a partir del criterio de dominio ya validado por `contador-dominio`) — y devuelve **solo el conteo
   agregado por patrón**, nunca el texto de ningún movimiento individual.
3. Si con esos conteos alcanza para decidir el regex final, no hace falta ningún paso más — el texto real
   nunca cruza a la conversación.
4. Si hiciera falta un ejemplo literal para terminar de calibrar un patrón, lo redacta y tokeniza **JP
   mismo**, sustituyendo cualquier dato de un tercero por un token sintético, antes de pasarlo — mismo
   patrón que el Addendum E-2 del 24/08 (verificación visual hecha por el titular, nunca transcripta a un
   agente).

**Addendum (2026-08-24) — paso 4 activado: `apps/cli/src/listar-conceptobanco-sin-reconocer.ts`.**
Con `calibrar-lexico-metadatos.ts` corregido (ancla de más en `candidato_cobro_de_tarjeta`, hallazgo de
JP) y las tres categorías candidatas nuevas (tarjeta, Plan de Pagos AFIP, "contiene AFIP") en **cero en
los dos lotes de Galicia, sobre 156 filas `sin_reconocer` combinadas**, quedó claro que el vocabulario
de Laura (su propia interpretación en la columna "Corrección/Identidad") no es el literal que imprime
el banco. Hace falta ver ejemplos reales para saber qué literal buscar — mismo método reforzado, un
script más: lista `conceptoBanco` real (texto crudo, N2) de las filas `sin_reconocer` de un lote,
**en la terminal de JP, nunca en el contexto de un agente**. JP lo corre, lo mira, y pasa de vuelta
solo los literales que hagan falta, ya redactados/tokenizados si corresponde.

**Autorizado por:** Juan Pablo Marchini, sesión del 2026-08-24 — "AUTORIZO la excepción E-4: JP corre el
script de lectura él mismo, solo booleanos/conteos de patrón llegan a tu contexto, nunca el texto de
descripcion. Mismo método reforzado que E-2. Registrala antes de correr nada, como corresponde."

**Alcance, explícito:** solo Galicia y Santander, solo los conceptos FCI/tarjeta/Plan de Pagos AFIP de
esta calibración puntual. El ítem de "Impuestos y Tasas" (que requeriría un tipo canónico nuevo en el
catálogo cerrado de 31 tipos, cambio de esquema real) queda **fuera** de esta excepción — tiene su propia
convocatoria y su propio modo plan, documentado como hallazgo separado en `HANDOFF.md`.

**Retención residual, mismo patrón que E-2 y el incidente #9:** el script no genera ningún derivado con
dato real — solo conteos, que quedan en la salida de la terminal de JP y, agregados, en `HANDOFF.md`.
Pendiente, a cargo de JP: revisar y borrar el output local de la corrida al cerrar la sesión.

---

### E-5 — extracto de posición FCI de Santander, cliente REAL del estudio (Pannonica SAS): primera validación

🔴 **Identidad corregida el 2026-08-25 — ver el addendum de resolución más abajo.** El encuadre
original de esta excepción (lo que sigue en esta sección, tal como se escribió el 2026-08-24) asumía
que el cliente era **El Prat S.A.S.** Es **incorrecto**: la carátula real del PDF identifica al
titular como **Pannonica SAS** — un cliente real y distinto del estudio, ya identificado por JP y con
plan de cuentas propio, que nunca se había cruzado con material de FCI hasta esta tarea. No es un
archivo mal ubicado ni un cliente inventado. Se deja el texto original sin reescribir (tachado en
espíritu, no en forma) para que quede el rastro de la corrección — el addendum de abajo es la versión
vigente.

**Por qué es excepción nueva, no una ampliación de E-2 (los mismos dos motivos que separaron E-2 de
E-1).** El documento es distinto — extracto de POSICIÓN de FCI de **Banco Santander**, no el de
Galicia que cubre E-2 ni el extracto de cuenta corriente de Módulo 1/E-1 — y el cliente es distinto:
~~El Prat S.A.S.~~ **Pannonica SAS** (ver corrección arriba), un cliente real del estudio — no un
externo sin ningún rastro en el sistema, como Elite-IT en E-2.

**Encuadre:** descubrimiento de formato de un layout nuevo (Santander, distinto del de Galicia ya
confirmado no-generalizable) + primera corrida real del motor de FCI (`packages/fci`,
`consumirRescate`) contra un cliente real del estudio — validación, no construcción de un adapter
oficial.

**Método reforzado, mismo criterio que E-2/E-4, sin reinventar:**
1. Descubrimiento: cero fragmentos de texto real en el contexto de ningún agente, ni siquiera el mío —
   solo metadatos (conteo de páginas/líneas, longitud de línea, offsets de columna, matches de patrón
   como booleano/conteo). Si un offset es tan angosto que el rango por sí solo ya insinúa fuertemente
   el contenido de la columna, se describe en términos gruesos ("columna numérica corta hacia la
   izquierda de la tabla") en vez del rango exacto, siempre que eso alcance para que `backend-dev`
   implemente el extractor.
2. Verificación: `cierra: true/false` por fondo (Eje 1, si hay con qué verificarlo — con un solo corte
   disponible puede no serlo, ver más abajo) y `movimientosConfiables`/`rescatesConSinCubrir` como
   booleanos (Eje 2); si un delta no cierra, se reporta como categoría acotada, nunca el valor exacto.
3. Script(s) efímero(s) en el scratchpad de la sesión, fuera del repo; se muestran completos antes de
   correr y se borran después.

🔴 **E-5 NO autoriza ninguna persistencia contra el piloto, bajo ningún concepto.** Solo lectura de
metadatos, extracción en memoria y validación del motor. Ningún `conUsuario`/`conJob`, ninguna fila
nueva en `packages/data`, ningún asiento. Si en el futuro este mismo material (u otro de FCI de
Pannonica) se usa para una tarea de persistencia real — Capa D, alta de cuentas FCI en el plan del
cliente, etc. — **esa es una excepción NUEVA** (la siguiente letra libre en este registro), nunca una
reinterpretación de E-5. Confirmación explícita de JP, incorporada acá como parte del texto de la
excepción, no como nota aparte.

**Con un solo corte disponible (junio 2026, sin corte anterior en la carpeta), el Eje 1 puede no ser
verificable esta ronda** — depende de si el propio documento de Santander trae un campo de "saldo
inicial"/"saldo anterior" propio (a determinar en el descubrimiento) o si, como Galicia, solo declara
el saldo al cierre y necesita el corte anterior para encadenar. Si no es verificable, se documenta como
limitación estructural (mismo caso que junio de Elite-IT en E-2), nunca se fuerza con un dato inventado.

**Autorizado por:** Juan Pablo Marchini, sesión del 2026-08-24, con tres confirmaciones incorporadas al
método de arriba: (1) que E-5 deje escrito, explícito y no implícito, que no autoriza persistencia; (2)
que un offset angosto que insinúe contenido se reporte en términos gruesos, no como rango exacto; (3)
que el `.xlsx` final quede en `privado/extractos/Sistematizacion Conciliacion Bancaria/FCI/export/`
(gitignoreado), nunca en `salida/` (esa carpeta ya acumuló archivos de corridas de prueba sin limpiar
en una sesión anterior). Con esas tres confirmaciones, la aprobación fue: **"Aprobado [...] Empezá por
el descubrimiento de formato (metadata-only, script efímero) y reportame la predicción falsable de la
tabla [...] antes de escribir una sola línea del extractor nuevo."**

**Retención residual, mismo patrón que E-2/E-4.** El PDF original no genera derivado con TTL propio
salvo el `.xlsx` de validación, si se llega a generar — ese se registra con su propio TTL de 7 días
cuando exista (mismo criterio que el addendum de E-2, sección "Exports N2-R declarados"). Pendiente,
fuera del repo, a cargo de JP: revisar y borrar los archivos locales de esta sesión al cerrarla.

### Addendum E-5 (2026-08-24) — discrepancia de titular: "PANNONICA SAS" en la carátula del PDF, no
"El Prat S.A.S." — 🔴 BLOQUEA la asociación al tenant hasta confirmar

Al verificar la estructura del documento (mirándolo él mismo, no yo — mismo método reforzado), **JP
encontró que la carátula del PDF identifica al titular como "PANNONICA SAS"**, no "El Prat S.A.S." como
asumía el encuadre original de esta excepción (arriba, y el pedido que abrió la tarea).

**No se sabe todavía si son la misma entidad** (nombre comercial "El Prat" vs. razón social "Pannonica
SAS", como pasa con muchas pymes) **o si el documento está archivado bajo el cliente equivocado** en
`privado/extractos/.../FCI/Santander/`. Las dos son posibles y tienen consecuencias opuestas: si es la
misma entidad, no hay problema — el nombre comercial y la razón social frecuentemente difieren. Si NO
lo es, este documento es de un tercero ajeno al piloto que terminó mal archivado, y ninguna fila de este
registro autorizaría procesarlo bajo el tenant de El Prat.

🔴 **Mientras esto no se confirme, NADA de este documento se asocia al tenant de El Prat
(`80741296-8cbf-4a4f-bcf1-8e8cb1c57584`) ni a ningún otro.** El extractor nuevo
(`fci-santander/extraer-posiciones.ts`) es código **genérico** — parsea estructura de un PDF, sin
referencia a ningún cliente ni tenant, igual que `fci-galicia/extraer-posiciones.ts` — y por eso puede
seguir escribiéndose y probándose sin esperar la confirmación. Lo que SÍ queda bloqueado hasta
confirmar: cualquier `HANDOFF.md`, `.xlsx` de export, o documento que **afirme** que este resultado es
de "El Prat" — se refiere como "titular del PDF de esta corrida, identidad pendiente de confirmar (ver
E-5)" hasta que JP la confirme contra Laura o sus propios registros.

**Hallazgo adicional de la misma revisión manual, sin cerrar:** el conteo de `rescate` del script de
descubrimiento (2 filas) **no coincidió** con lo que JP contó mirando el PDF — algún patrón del script
está mal calibrado (posiblemente el mismo problema que ya documentó `docs/diseno/06-formato-santander.md`
§11.2 sobre este banco: texto que se repite o se omite según cambia la página/el grupo). Queda como
hallazgo abierto para cuando se calibre el regex real del extractor — no bloquea escribir el extractor
(que no depende de este conteo agregado, solo del descubrimiento lo usó como señal), pero si el
extractor real también da un conteo distinto del que JP ve a mano, es señal de que falta ajustar el
patrón, no de que el dato esté mal.

*(Nota, 2026-08-25: este hallazgo quedó resuelto en el trabajo de código de la misma tarea — el
extractor final identifica movimientos por línea completa de `pdftotext`, no por el conteo agregado
del script de descubrimiento, y sus 4 campos por línea se verificaron limpios contra el documento
real. Detalle completo: `docs/diseno/19-fci-santander-extractor-hibrido.md`.)*

### Addendum E-5 (2026-08-25) — identidad RESUELTA: el cliente es Pannonica SAS, no El Prat

**Confirmado por JP.** El PDF procesado en esta tarea (`Reporte FCI junio Santander 06-2026.pdf`)
pertenece a **Pannonica SAS** — un cliente real y distinto del estudio, **no** El Prat S.A.S. Las dos
hipótesis que dejaba abiertas el addendum anterior (nombre comercial vs. razón social del mismo
cliente, o archivo mal ubicado de un tercero) quedan **descartadas las dos**: es un cliente real
propio, correctamente archivado bajo su propio nombre — la atribución errónea fue del encuadre
original de esta tarea (que asumió "El Prat" sin verificarlo contra la carátula), no del archivo.

**Pannonica SAS, lo que se sabe:** identificado por JP, con **plan de cuentas ya disponible** en el
estudio. Nunca se había cruzado con material de FCI hasta esta sesión.

🔴 **CONFIRMADO 2026-08-25 — Pannonica SAS NO tiene tenant dado de alta en el piloto.** Verificado por
lectura directa (solo `select count(*)`, sin escribir nada) contra `tenant_node` en
`sistema_contable_piloto`: 0 coincidencias por nombre, sobre un total de 4 tenants registrados en esa
base. "Identificado y con plan de cuentas" no es lo mismo que "dado de alta como tenant" — eran dos
hechos independientes, y el segundo resultó negativo.

**El `.xlsx` de entrega queda BLOQUEADO** hasta que Pannonica se dé de alta como cliente nuevo del
piloto — mismo proceso ya usado para Bracci/ROKA/El Prat, alta real, nunca un tenant provisorio
inventado para destrabar la entrega. Pendiente nuevo de backlog, a cargo de JP: decidir si/cuándo se
da de alta a Pannonica. Hasta entonces, esta tarea queda con la validación técnica (estructura, Eje 2)
cerrada, pero sin entregable generado.

**Todas las referencias a "El Prat" dentro de esta sección E-5 (el texto original de 2026-08-24) son
la atribución errónea que este addendum corrige** — no se reescribieron todas individualmente, se
marcaron o se dejaron con nota. Ninguna otra sección de este registro (E-1, E-2, E-3, E-4) se ve
afectada: E-3 es sobre El Prat de verdad, en un tema no relacionado (`padron_socio`), y sigue vigente
tal cual.

**Verificado en el código:** el extractor (`fci-santander/extraer-posiciones.ts`) es genérico — no
tiene ningún nombre de cliente ni UUID de tenant hardcodeado (ni de El Prat ni de Pannonica) — por eso
no necesitó ningún cambio de código con esta corrección, solo de atribución en la documentación.

---

### E-6 — alta de cliente REAL completo, razón social conocida desde el alta, directo al piloto: Contenedores Paoluc S.A.S. (Bancor)

**Por qué es excepción nueva, y no una repetición del procedimiento de 2026-08-11.** Los 3 clientes
originales del piloto (uno por banco: Galicia, Santander, Macro) se dieron de alta con `alta-cliente.ts`
usando una **etiqueta provisoria genérica** en `tenant_node.nombre` — el propio script rechaza técnicamente
cualquier forma de CUIT, y documenta como convención "nunca la razón social real", porque en ese momento
**no se sabía** la razón social; se descubrió después (Bracci, ROKA), viviendo solo en HANDOFF, nunca en
la base. Acá el criterio es el inverso, decisión explícita de JP: cargar clientes reales **ya
identificados** directo al piloto desde el arranque, con su razón social real en `tenant_node.nombre`
desde el día uno — porque mientras no se sepa con qué cliente(s) se hace el piloto final, sumar clientes
reales mejora la muestra real de aislamiento multi-tenant (RLS) con más de tres/cuatro clientes
conviviendo. Es el primero de una serie, no un caso puntual.

**El contraste que hay que dejar explícito — dos reglas distintas, no una relajación general:**
- **La razón social real SÍ va por argumento de shell** (`--nombre "Contenedores Paoluc S.A.S."`).
  Riesgo aceptado explícitamente por JP: `tenant_node.nombre` es N2, protegido por RLS del propio
  subárbol (solo lo ve quien ya tiene membership en ESE cliente) — el riesgo real de pasarlo por
  argumento es el mismo que ya rige para cualquier dato N2 en este proyecto (queda en el historial de
  `PSReadLine` de esa máquina), y JP decidió que ese riesgo es aceptable para este campo.
- **El CUIT NUNCA va por argumento de shell, bajo ningún concepto** — sigue yendo, sin excepción,
  por el prompt oculto de doble tipeo ya existente (`pedirCbuConfirmado`/`pedirValorOculto`,
  `apps/cli/src/alta-cuenta.ts`/`alta-socio.ts`), cuando algún flujo lo necesite. Esta excepción **no
  toca esa regla en absoluto** — de hecho, este flujo puntual (alta de cliente + cuenta Bancor) **no
  necesitó ningún CUIT**: confirmado por grep sobre las 24 migraciones que ningún cliente-tenant en este
  sistema tiene su CUIT guardado en ningún lado del esquema (todas las apariciones de "cuit" son de
  `padron_socio`/contrapartes, un dato distinto). Que el nombre real se acepte por shell no relaja nada
  sobre el CUIT — son dos decisiones separadas, con dos criterios de riesgo distintos.

**Hallazgo real durante la ejecución, con su propia autorización puntual:** la migración
`0024_catalogo_bancor.sql` (alta de `bancor` en el catálogo, ya revisada por `dba-data`/
`security-engineer` y aplicada en local) **no estaba aplicada en el piloto**. El primer intento de
`alta-cuenta.ts` falló limpio con `ING_FK (cuenta_bancaria_banco_codigo_fkey)` — verificado por consulta
directa que la transacción hizo rollback completo (0 filas en `cuenta_bancaria`/
`cuenta_bancaria_identificador` para el cliente nuevo antes del segundo intento). Se listó `--estado`
contra piloto (una sola migración pendiente, la misma dos veces seguidas), JP autorizó explícitamente
esa migración puntual, se aplicó, se verificó `bancor` en el catálogo del piloto, y se retomó desde
`alta-cuenta.ts` sin rehacer el alta de cliente ya hecha — mismo criterio de CLAUDE.md §1.9 (listar,
confirmar, frenar) aunque esto no sea DDL de esquema, es una autorización puntual sobre datos reales.

**Procedimiento seguido, cada paso verificado antes del siguiente:**
1. `pnpm respaldar:piloto` — backup fresco, hash SHA-256 registrado en `HANDOFF.md`.
2. Membership del usuario operador verificada activa (`socio`, en el estudio raíz) antes de escribir.
3. `pnpm alta:cliente` — tenant nuevo, razón social real, `tenant_node` 4→5 (verificado por conteo).
4. Migración `0024` al piloto (ver hallazgo arriba), verificada con `--estado` y con el catálogo.
5. `pnpm alta:cuenta` — cuenta Bancor, número y CBU leídos del PDF real (nunca por argumento), CBU
   guardado solo como HMAC.
6. `pnpm ingesta` — 94 movimientos persistidos, `cuadra`, 9 anexos, verificado por consulta directa a
   `movimiento_bancario_crudo` (no solo el output del CLI): 94 filas para el lote, 94 para el
   `cliente_id` (aislamiento correcto, sin mezcla con otro cliente), 94 hashes únicos de 94.

**Esta excepción autoriza**: razón social real en `tenant_node.nombre` por argumento de shell, para
clientes reales ya identificados que se den de alta directo al piloto de acá en más — mismo criterio
para Bancor/ICBC/Nación u otros bancos cuando corresponda. **No autoriza** guardar el CUIT del cliente
en ningún lado (no hay dónde hoy, y este flujo no lo necesita) ni relaja en nada la regla del CUIT por
prompt oculto para cualquier otro flujo que sí lo requiera.

---

### E-7 — FCI (Bracci, ROKA) y tarjeta corporativa (Bracci): descubrimiento de formato, método reforzado

**Por qué es excepción nueva, y no una ampliación de E-1.** Mismo criterio que ya fijó E-2: el documento
es distinto del extracto de cuenta corriente que cubre E-1 (FCI = posición de fondos; tarjeta corporativa
= liquidación de la procesadora), y aunque Bracci y ROKA sí son clientes cubiertos por E-1 para sus
extractos bancarios, **la cobertura de E-1 es por tipo de documento, no por cliente** — no se hereda a un
tipo de documento nuevo sin su propia excepción (memoria operativa: "no heredar autorización de
exposición"). Encontrado por `seguridad-datos-financieros`, convocado durante el inventario de Capa D del
2026-08-28 (`docs/diseno/23-arquitectura-cierre-mensual.md`), al confirmar que ninguna fila de este
registro cubre estos dos tipos de documento para estos dos clientes.

**Encuadre:** descubrimiento de formato — confirmar si el extractor `fci-galicia` o `fci-santander`
(ambos preliminares, `packages/ingesta/src/fci-*`) reconoce el layout real de Bracci/ROKA, y si alguno de
los 3 formatos de liquidación registrados (`cabal_debito`/`visa_credito`/`visa_debito`,
`packages/ingesta/src/liquidaciones/formatos/`) reconoce la tarjeta corporativa de Bracci. Mismo espíritu
que E-2: construcción y calibración, no carga a la base — **sin `INSERT`, sin tenant nuevo, sin tocar el
piloto**.

**Método reforzado** (mismo dictamen que E-2/E-4/E-5, aplicado por `seguridad-datos-financieros` en esta
convocatoria):
1. Cero fragmentos de texto real en el contexto de ningún agente, ni enmascarados — solo metadatos
   (conteo de páginas, `requiereOcr`, cantidad de fondos, movimientos por fondo, `movimientosConfiables`,
   qué formato de liquidación coincide como categoría/booleano).
2. Script efímero (`packages/ingesta/scripts/_sondeo-efimero-e7.ts`), mostrado completo en el chat para
   que JP lo vea antes/junto con su corrida — regla fijada tras el incidente #10 —, corrido por quien
   conduce (autorizado explícitamente por JP para esta tarea, a diferencia de E-2 donde lo corrió JP en
   su propia terminal: acá el script en sí nunca imprime texto real, solo conteos/booleanos, así que la
   garantía la da el script, no quién lo ejecuta). Se borra al cerrar la tarea, nunca se commitea.
3. Reusa exclusivamente funciones ya auditadas y en producción (`extraerPosicionesFci`,
   `extraerPosicionesFciSantander`, `extraerConOcrSiHaceFalta`, `resolverAdaptadorDeLiquidacion`) — no
   escribe ningún parser nuevo ni adivina estructura por su cuenta.

**Sin carga a la base: controles 6-8 de E-1 son no-aplica declarado.** El script no importa
`packages/data`, no llama `conUsuario`/`conJob`, no hay `INSERT`. Si una tarea futura persiste este
material (oficializar el adapter de FCI, conectar liquidaciones a `documento_ingerido`), los tres
controles rigen igual que en E-1, con su propia convocatoria completa (`dba-data` + `security-engineer`
+ `seguridad-datos-financieros`) — sin excepción por venir de esta medición.

**Retención residual, mismo patrón que E-2/incidente #9.** El PDF no genera derivado con TTL propio. Lo
que puede quedar es la salida del script (conteos/booleanos, no dato en claro) en el transcript local de
la sesión — pendiente, fuera del repo, a cargo de JP, revisar y borrar al cerrar la sesión.

---

## Antes de pedir una excepción

Estos tres pasos cierran la mayoría de los casos sin tocar un dato real:

1. **El log ya trae lo necesario**: `request_id`, `cliente_id`, `lote_id`, `movimiento_id`, códigos de
   error y conteos (ADR-0002 §D). Con el uuid del registro se llega al caso en producción sin extraerlo.
2. **Construir el caso sintético desde la descripción.** Si la descripción no alcanza para reproducirlo,
   **eso es un hallazgo de observabilidad del dominio** — anotarlo como tal, porque va a volver a pasar.
3. **Minimizar antes de pedir:** el registro que falla, no la tabla; los campos necesarios, no la fila;
   un movimiento, no el extracto.

## Si igual hace falta

- **La anonimización corre del lado de producción.** Sale el fixture ya redactado; **el dato en claro
  nunca sale**. Reemplazo consistente de CUIT/CBU/nombres por tokens sintéticos; importes escalados por
  un factor fijo, salvo que el importe **sea** la causa del bug.
- **Verificar el fixture antes de moverlo**: correrle los detectores de INV-8 (regex de CUIT, CBU,
  `-----BEGIN`, base64 largo) y buscar los valores originales. Si algo matchea, no se mueve.
- **Canal controlado** (repo o almacén del proyecto). Nunca chat, mail ni captura de pantalla.
- **TTL obligatorio.** Si el fixture quedó equivalente-a-sintético puede quedar como caso de regresión;
  si conserva cualquier rastro, se destruye al cerrar el bug y se anota la fecha en la última columna.
  Una fila sin fecha de destrucción y con TTL vencido es un incidente abierto.

## Exports N2-R declarados — fuera del alcance de §F.3, mismo criterio de cierre

> **Por qué esto es distinto de todo lo de arriba.** §F.3 (y el registro de "Excepciones otorgadas") es
> para **sacar un dato real de producción para reproducir un bug**: hace falta autorización previa del
> titular, y por defecto la respuesta es no. Un export a `.xlsx` corrido con `pnpm exportar:excel`
> (`packages/ingesta/src/planilla/`, plan `adaptive-herding-pillow`, `HANDOFF.md` 2026-08-12 (46)) es
> otra cosa: es un entregable del propio producto para quien ya tiene rol sobre esos datos (el estudio,
> para su propio cliente), auditado en `acceso_auditoria` con `accion='export'` y motivo+destinatario de
> vocabulario cerrado ANTES de leer un solo movimiento. No necesita la autorización previa de §F.3. Pero
> el archivo resultante es **N2-R** (ADR-0002 §A.2, regla 2 — un derivado hereda el nivel máximo de sus
> insumos, y `descripcion` trae CUIT de terceros en la glosa) y sale de la base a un filesystem sin RLS,
> así que necesita el mismo cierre de TTL/destrucción que el resto de este registro.

**Decisión del titular (misma tarea):** el archivo no tiene borrado automático ni fecha de calendario
fija en el sistema — la destrucción es un acto humano registrado, mismo criterio que ADR-0002 §F.3.8. La
recomendación es **7 días desde `generado_en`**.

✅ **Cerrado (2026-08-12, misma sesión que lo abrió): el script SÍ calcula esa fecha.** `pnpm exportar:excel`
devuelve `destruirAntesDe` en su JSON de salida y la loguea como `destruir_antes_de` en
`exportar.completado` (`docs/diseno/10-deuda-declarada.md` §5.2). Sigue sin escribirla en la leyenda
"Procedencia" del propio `.xlsx` — completar la fila de abajo con el valor del log/JSON de salida, no
recalcularla a mano.

### Cómo registrar una corrida de `pnpm exportar:excel`

Completar una fila después de cada corrida real (nunca antes: recién con el archivo generado hay
`correlacion` y `generado_en` para completar la fila):

1. **Motivo / Destinatario**: los códigos exactos pasados a `--motivo`/`--destinatario` — vocabulario
   cerrado (`MOTIVOS_EXPORT`/`DESTINATARIOS_EXPORT`, `packages/ingesta/src/planilla/exportar-planilla.ts`).
2. **Cliente / Lote**: los uuid de `--cliente`/`--lote-id` usados.
3. **Correlación**: el uuid `correlacion` — aparece en la línea de log `exportar.completado` y en la
   leyenda "Procedencia" de la pestaña `Control de saldos` **dentro del propio archivo** (así el archivo
   se ata a su fila de `acceso_auditoria` sin depender de haber guardado el log:
   `select * from acceso_auditoria where correlacion = '<uuid>'`).
4. **Generado el**: el timestamp que trae el nombre del archivo
   (`movimientos_<cliente8>_<banco_codigo>_<lote8>_<timestampUTC>.xlsx` — el segmento de banco puede
   faltar si el lote no se pudo resolver antes de nombrarlo) y la celda `A1` de `Control de saldos`. El
   nombre es una **etiqueta legible**, no una clave: la clave real de correlación es `correlacion`
   (punto 3), nunca parsear el nombre del archivo para identificar el lote.
5. **Se destruye el**: el valor de `destruirAntesDe` (JSON de salida) / `destruir_antes_de` (log) — ya
   calculado por el script como `generado_en + 7 días`, no hace falta recalcularlo.
6. **Corrido por**: quién ejecutó el comando.
7. **Dónde quedó**: `salida/<nombre>.xlsx` y, si se copió fuera de ahí (por ejemplo para mandárselo a la
   contadora), **también** esa copia — con el **mismo** TTL, no uno nuevo.
8. Al llegar la fecha: borrar el archivo (y sus copias) y completar **Destruido** con la fecha real. Una
   fila con TTL vencido y sin **Destruido** es un incidente abierto, mismo criterio que el resto de este
   documento.

| # | Fecha | Motivo | Destinatario | Cliente | Lote | Correlación | Generado el | Se destruye el | Corrido por | Dónde quedó | Destruido |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | |

*(fila vacía a propósito — se completa con la primera corrida real contra el piloto, no antes)*
