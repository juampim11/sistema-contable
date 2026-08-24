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
