# 32 — Lecciones aprendidas de proceso (HANDOFF 183-210) y protocolos para la Tanda 4

> **Para qué existe este documento.** No es de dominio contable — para eso está `09-lecciones-
> aprendidas.md` (bancos/adaptadores). Esto es **proceso**: cómo se citan números, cómo se distingue un
> dato real de uno de prueba, cómo se descubren los gates del motor, cómo se verifica antes de aceptar
> una explicación, y cómo se arma un entregable para un humano que no es programador. Sale de releer
> `HANDOFF.md` (183)-(210) completo, con foco en (196)-(210), antes de arrancar la Tanda 4 — la primera
> pieza que expone datos de clientes reales en una interfaz visible en vez de CLI+Excel, donde estos
> cinco errores salen más caros que en una consulta SQL que solo ve un agente.
>
> Cada sección trae el caso real que la motivó y una regla corta, verificable — no una promesa de "tener
> más cuidado".

---

## 1. Números citados de memoria sin revalidar

### Los tres casos reales de este rango

| Cifra citada | Entrada | Qué pasó | Número real | Dónde se corrigió |
|---|---|---|---|---|
| **"937 / 283 / 1246 / 26"** | previa a (200) | Cifras y fuente del criterio de los casos de IIBB Córdoba (ROKA), citadas para arrancar la tarea. **"No coincidían con la base real en ningún corte medido"** — ninguna de las cuatro. | **13** (un solo literal, `RETENCION IIBB CORDOBA RENTA FINANC`, 100% ROKA) | (200), antes de tocar `catalogo.ts`, en modo plan |
| **"93,7% / 95,6%"** | previa a (207) | JP citó estos dos porcentajes como "ya verificados" para el diseño del paquete final. Búsqueda completa del repo, HANDOFF incluido: **cero matches**. JP los descartó explícito al confirmarse que no existían. | **77,4% Bracci / 80,2% ROKA** (automático sobre el total) — medido esa misma sesión contra el piloto real | (207) §2, "Premisa del pedido corregida por JP" |
| **"6293" (total de promociones Bracci+ROKA)** | (196)/(198) | Un lote de ROKA (`ae762fda…`, dato de prueba de desarrollo, ver §2 de este documento) infló ROKA de 3843 a 4879 promociones. Total reportado: 1414+4879 = **6293**. Una corrección posterior, el 2026-09-08, **volvió a llegar a 6293** por una vía distinta y también errónea (tomó "los 3 lotes originales de ROKA por orden de identificador" en vez de los 3 lotes reales). | **5257** (1414 Bracci + 3843 ROKA), confirmado por **tres mediciones independientes que coinciden exacto** | (199), la corrección real — con `10-deuda-declarada.md` B.20/B.22 actualizados |

El tercer caso es el más caro de los tres: **el mismo número erróneo (6293) se reconstruyó dos veces por caminos distintos**, y las dos veces alguien lo tomó por bueno hasta que se le exigió una tercera vía de verificación independiente.

### La regla

> 🔴 **Ninguna cifra se usa para autorizar una acción (`--aplicar`, cerrar un ítem de deuda, reportarle un
> número a Laura) si no se puede señalar la consulta, el grep o el script concreto que la produjo EN LA
> MISMA TAREA que la usa.** Una cifra que viene de memoria, de una sesión anterior, o de un archivo de
> plan local (no versionado) se trata como **hipótesis sin medir**, nunca como dato — aunque "suene
> conocida" o coincida con lo que ya se creía.
>
> Corolario del caso "6293": **una cifra que se re-obtiene por un camino distinto y da el mismo número
> sospechoso no está confirmada — puede ser el mismo error de encuadre repetido dos veces.** Confirmar
> exige una tercera vía **estructuralmente distinta** de las dos primeras (en el caso real: medición
> limpia post-borrado + una medición histórica independiente ya escrita en HANDOFF + la síntesis del
> propio documento de diseño — tres fuentes que no comparten el mismo error de origen).

---

## 2. Confusión entre datos reales, de prueba y de desarrollo

### El caso

El lote `ae762fda-8822-459f-a061-31d7ce26c785` (ROKA, banco Macro, movimientos fechados 2025-10-20/
2025-11-28) es el archivo que se usó para **validar el adaptador de Macro durante el desarrollo** —
nunca un extracto real entregado por un cliente. Quedó mezclado en el piloto real desde **2026-08-19**
(mismo día que la carga inicial de Bracci), por descuido, no por decisión.

Ya se había **identificado como tal** el 2026-09-01 (HANDOFF 164: *"ae762fda (nov-2025) era la prueba
técnica del adaptador, no el material real de Capa D"*) y quedó consistentemente **excluido de todo
trabajo real** desde entonces — pero nunca se llegó a **borrar**. Ocho días después (2026-09-09), al
activar la manifestación de padrón completo sobre "los 10 lotes reales" del piloto, entró sin que nadie
lo filtrara y contaminó una medición de producción (ver §1, caso "6293").

**Cómo se coló**: la única señal que existía era heurística y manual — la fecha de los movimientos, muy
anterior al resto del corpus del mismo cliente, cruzada a mano con `acceso_auditoria` para confirmar
cuándo se había cargado. Nada en el esquema lo marcaba.

### Qué se decidió (con la convocatoria de `seguridad-datos-financieros` de esta misma tarea)

El hueco sigue abierto en `10-deuda-declarada.md` (B.22, "criterio que falta"), con tres opciones sin
decidir. El dictamen de `seguridad-datos-financieros` (ver `33-plan-deuda-pre-tanda-4.md` §A.2) recomienda
una columna `lote_ingesta.es_dato_real boolean NOT NULL` **sin default** — nunca reutilizar `origen`
(son dos preguntas distintas: cómo llegó el archivo vs. si es real) ni depender solo de un proceso
humano de alta (mismo antipatrón que R33/R13: *"un control que depende de que alguien lo recuerde no es
un control"*).

### La regla

> 🟠 **El costo de esto NO es el mismo antes y después de que exista una interfaz humana.** Hoy el daño
> lo atrapa un agente/dev que interroga la base con SQL y tiene contexto para sospechar de una fecha
> rara. En cuanto una pantalla le muestre estos datos a Laura, ella no tiene ni el contexto ni la
> herramienta para distinguir "extracto real" de "fixture que alguien olvidó borrar" — y sobre esa
> pantalla va a confirmar asientos con implicancia fiscal real. **Por eso el guard mínimo (no
> necesariamente el cierre estructural completo) es precondición de la vista de solo lectura de la
> Tanda 4, no deuda postergable como el resto de B.22.**
>
> Regla de trabajo, hacia adelante y sin esperar a la migración: **todo archivo usado para desarrollar o
> validar un adaptador se identifica por convención de nombre ANTES de tocar el piloto real** (por
> ejemplo, un prefijo o carpeta reservada fuera de `privado/piloto_capa_d/`), y **se borra o se archiva
> explícitamente apenas termina de cumplir su función** — no "se deja ahí, ya se sabe que no es real".

---

## 3. Gates de negocio del motor descubiertos tarde, a escala completa

### El caso

`regla_imputacion` para `cobranza_de_cliente`/`pago_a_proveedor_transferencia` se cargó y aplicó sin
problema para Bracci — **1.177/1.177 y 237/237 movimientos con asiento real** (entrada 204). Al correr
el mismo dry-run contra ROKA, el número de "pasa a automático" quedó muy por debajo de lo predicho.

Causa: la mayoría de los movimientos de ROKA de esos 2 tipos resuelven vía `texto_prefijo_con_cola`
(`reconocimiento_movimiento.via`) — una vía que **nunca había estado entre las 4 vías calificadas de
D-31** (`VIAS_QUE_CALIFICAN`, `resolver.ts`). Medido: **~4.868 de los ~5.109 movimientos de ROKA**
(≈95%) pasaban por esa vía. El gate existía desde el diseño original del motor (`28-diseno-motor-
clasificacion.md`), nadie lo había tocado ni lo consideraba un problema — porque **hasta ese momento
nadie había corrido el corpus completo de un cliente que dependiera de esa vía a esa escala**. Bracci no
la usa (usa mayormente `segmento_de_glosa`); Bancor todavía no tiene léxico.

Se resolvió con convocatoria dual (`motor-conciliacion-contable` + `contador-dominio`) que dictaminó
promoverla con 3 condiciones — las 3 con prueba de mutación — sin relajar el veto duro de D-31 sobre la
familia socio, que sigue aplicando **antes** de evaluar qué vía calificó (mode-gate estructural,
independiente de la lista de vías).

### Por qué vale un catálogo, arrancando con lo ya conocido

Este no es el primer gate que se descubre por su impacto real recién al correr un cliente/corpus nuevo
completo — es un patrón. Un catálogo corto, mantenido junto al motor, evita que la próxima vez sea otra
sorpresa a mitad de una entrega:

| Gate | Dónde vive | Qué bloquea | Se ejercitó a escala completa recién en |
|---|---|---|---|
| **D-31 — vías calificadas para automático** | `resolver.ts`, `VIAS_QUE_CALIFICAN` | Que un movimiento pase a `automatico` si su vía de reconocimiento no está en la lista corta (hoy 5 de 6 vías) | ROKA, corpus completo de mayo-agosto (entrada 204) — Bracci nunca lo disparó |
| **D-31 — veto duro de familia socio** | `resolver.ts`, `estaVetadaPorFamiliaSocio()` | Que CUALQUIER movimiento de la familia socio pase a automático, sin excepción, sin importar cuántas vías califiquen | Nunca se relajó ni se violó — pero es la condición que toda promoción de vía tiene que verificar explícito (mismo patrón que casi se pisa con `confirmacion_grupo`, ver "insumo para el futuro" en (210)) |
| **D-28 — motivos de `pendiente_cierre` para el veto de socio** | `packages/data/src/cierre/tipos.ts`, `MOTIVOS_PENDIENTE_CIERRE` | Que un movimiento de socio caiga en la cola de revisión con un motivo LEGIBLE (`resolucion_manual_obligatoria_socio`), no uno que sugiera "falta configurar algo" | Implementado y cerrado en (0031, 2026-08-31) — el riesgo de reabrirlo está anotado como pendiente en (210), sin convocatoria propia todavía |

### La regla

> 🟡 **Antes de correr el corpus COMPLETO de un cliente nuevo (o de un cliente viejo contra una regla
> nueva) por primera vez, medir qué proporción de sus movimientos depende de cada gate del motor
> (D-28/D-29/D-31 y los que se agreguen) — no asumir que lo que valió para el cliente de referencia vale
> igual para el siguiente.** Un dry-run que solo mira el total automático/manual no alcanza; hace falta
> desagregar por vía de reconocimiento antes de prometer un número.
>
> Mantener el catálogo de arriba actualizado cada vez que se agregue o se modifique un gate — es barato
> de mantener y es exactamente lo que hubiera anticipado el caso de ROKA.

---

## 4. Verificación contra evidencia real antes de aceptar una explicación teórica

### El estándar — funcionó bien esta sesión, y hay que sostenerlo

**Caso 1 — el "susto de 6.512" (entrada 203).** Una consulta directa mostró 6.512 movimientos con
`clase='propuesta'` en tipos que, según el catálogo, no deberían llegar ahí por esa vía. Primera lectura:
parecía un bug. Antes de aceptar la explicación de "es un segundo constructor legítimo, documentado", se
verificó con **tres capas independientes**, no una:
1. **Git**: `created_at` real de las filas, comparado contra el commit del wiring — las filas son
   posteriores, no hay ventana en la que el código viejo pudiera haberlas creado.
2. **Esquema**: los 4 constraints de la migración `0021` hacen estructuralmente imposible que una fila
   cite una manifestación inexistente o fuera de alcance — la garantía vive en la base, no en la fecha
   del código.
3. **El propio commit**: el mensaje declara explícito de qué parte del plan es.

Recién con las tres capas alineadas, JP retiró la hipótesis alternativa.

**Caso 2 — las pruebas de concurrencia en vivo de `0041`/`0042`/`0043`.** Para el gap de vigencia de
`padron_manifestacion` (0041), la primera versión del diseño asumía que READ COMMITTED alcanzaba sin
lock explícito. **Se exigió una prueba real antes de fijar el diseño**: dos conexiones Postgres reales,
`pg_sleep`, sin mocks. Resultado: sin lock, la carrera se cuela; con `FOR SHARE` (propuesta más liviana),
**tampoco alcanza**; solo `FOR UPDATE` la cierra — confirmado repitiendo la misma prueba. Lo mismo se
exigió para la unicidad de revocación (0042, "carrera real con dos conexiones") y para
`confirmacion_grupo` (0043: sin el índice, las dos conexiones entran y quedan dos filas vigentes
contradictorias; con el índice, exactamente una — **repetido 3 veces contra flakiness**).

Lo que se hubiera aceptado sin esto: el argumento teórico de que "READ COMMITTED alcanza" — que la
propia prueba refutó.

### La regla, a sostener (no a corregir — ya es el estándar de este repo)

> ✅ **Ningún mecanismo de concurrencia se declara "seguro" por argumento teórico. Se prueba con ≥2
> conexiones reales y una ventana de carrera forzada (`pg_sleep` u orden explícito), ANTES de fijar el
> diseño — no como verificación posterior.** Y ninguna explicación de "esto no es un bug, es el
> mecanismo funcionando" se acepta con una sola fuente de evidencia cuando hay más de una disponible
> (git, esquema, mensaje de commit, consulta directa) — cruzarlas es barato comparado con el costo de
> una hipótesis equivocada que ya se reportó como cerrada.

---

## 5. Checklist de "documento para humano" antes de entregar algo a un cliente externo

### De dónde sale

El paquete final para Laura (Excel + instructivo) pasó por **al menos 4 rondas de corrección real**
sobre el mismo entregable (207 → 208 → 209 → el ajuste final de (209)), más un incidente de exposición
que no llegó a Laura mismo. Cada ronda encontró una clase de error distinta, no la misma repetida — eso
es lo que hace falta anticipar la próxima vez.

| Ronda | Qué encontró JP (o se autodetectó) | Corregido cómo |
|---|---|---|
| Diseño (207) | Un porcentaje citado ("93,7%/95,6%") que **no existía en ningún lado del repo** | Descartado, remedido contra el piloto real (§1) |
| `.xlsx` completo (208) | Contradicción "pendiente" / "no aplica" en dos columnas sobre el mismo hecho | `requiereRevision` derivado del MISMO valor que ya arma `cuentaAsignada`, nunca un segundo cálculo |
| `.xlsx` completo (208) | FCI mezclado, visible en unas hojas y ausente de los totales de otras | Filtro **estructural** (por `evidencia_entrada_lexico_id`), nunca por texto — un `ilike '%FIMA%'` se hubiera perdido los casos de ROKA/Macro, que usan otro literal |
| `.xlsx` completo (208) | Columna huérfana ("Si es NO: cuenta que hubieras usado") sin la pregunta OK/NO que la precedía | Sacada de `COLUMNAS_EJEMPLOS` |
| Apertura con librería estricta (209) | `errorStyle: 'error'` en `dataValidation` — OOXML inválido que **Excel de escritorio corrige en silencio al abrir**, invisible a typecheck/tests/corrida real | Corregido; verificación agregada: abrir el `.xlsx` con `openpyxl` (no con Excel de escritorio) antes de entregarlo |
| Revisión de contenido (209) | Frase de "validar con profesional matriculado" sonando redundante/inapropiada **hacia la propia contadora matriculada** que va a leerlo | Sacada del Acumulado y del instructivo |
| Incidente autodetectado (209) | El instructivo (datos reales de `privado/`) se publicó una vez como Artifact — infraestructura externa, exactamente lo que `privado/` existe para evitar | Autodetectado y reportado sin esperar a que lo notaran; nunca se volvió a usar Artifact para contenido de `privado/` |

### El checklist, para que el primer borrador ya pase la mayoría

1. **Toda cifra o porcentaje que aparezca en el texto del entregable** (resumen ejecutivo, instructivo)
   está medida contra el estado real en ESTA tarea — nunca citada de memoria (ver §1).
2. **Ninguna columna muestra dos señales contradictorias sobre el mismo hecho** (ej. "pendiente" en una
   columna y "no aplica" en la de al lado) — si dos columnas derivan de la misma condición, que la
   deriven del MISMO valor calculado, nunca de dos cálculos independientes que puedan divergir.
3. **Todo lo que se excluye de una hoja se excluye por criterio ESTRUCTURAL** (una clave, un tipo, un
   flag), nunca por coincidencia de texto — y se declara explícito en el propio documento (título de
   hoja, resumen), no solo en el código.
4. **Ninguna columna queda sin la pregunta o el contexto que la precede** — revisar cada hoja de punta a
   punta como la leería alguien sin el contexto de quien la armó, no solo columna por columna.
5. **El archivo final se abre con una librería estricta** (Python `openpyxl`, o equivalente), no solo
   con Excel de escritorio — Excel corrige XML inválido en silencio y esconde bugs reales.
6. **Ningún archivo con datos reales de `privado/` sale por una herramienta externa** (Artifact,
   pastebin, cualquier servicio de terceros) — se muestra en el chat o se convierte con una herramienta
   local (`pandoc`), siempre dentro del repo.
7. **No se envía hasta la confirmación explícita del humano responsable** — aunque los checks
   automáticos (typecheck, tests, Σdebe=Σhaber, apertura con librería estricta) den verde, el envío en sí
   espera la palabra explícita de JP, no se infiere de "todo está en verde".

---

## 6. Enmascarado/redacción verificado por argumento, no por prueba

### Los cuatro casos reales

Cuatro incidentes de seguridad de este período (`docs/seguridad/registro-incidentes.md`), sin
denominador técnico común — uno es un blocklist de dígitos, otro un regex de protocolo, otro directamente
la ausencia de cualquier enmascarado — pero con la misma causa raíz:

| Incidente | Fecha | Qué se asumió correcto sin probarlo contra la forma real | Qué reveló |
|---|---|---|---|
| **#14** | 2026-08-27 | Scripts efímeros que leyeron el `.xlsx` real de Bracci asumieron que una columna de "denominación contable" era vocabulario genérico seguro de imprimir — sin verificar que ese campo de texto libre pudiera traer, pegado, un nombre propio (`"Cuenta Particular <nombre>"`) | 2 nombres reales de socios + 2 `padron_socio_id` |
| **#15** | 2026-08-28 | La sesión venía enmascarando dígitos con `sed 's/[0-9]/X/g'` antes de imprimir — correcto casi siempre — pero 2 de los llamados puntuales contra el extracto real de Bracci se corrieron sin pasar por ese enmascarado, asumiendo (sin confirmar) que el resultado sería inocuo | Un valor con forma de importe/CBU + el CUIT real del cliente |
| **#16** | 2026-09-04 | Un script de sondeo protegía por **blocklist** (corridas de 3+ dígitos) en vez de por **allowlist** (solo el patrón exacto buscado) — asumido suficiente sin contemplar que la misma fila de rótulo trajera, pegado, texto libre no numérico | Nombre y apellido reales, repetidos en los 3 archivos procesados |
| **#18** | 2026-09-13 | Un `sed` de redacción asumía el prefijo `postgresql://`, nunca confirmado contra el DSN real de este repo (`postgres://`, sin la sílaba `ql`) — la sustitución no matcheaba nunca, y nadie lo notó antes de correrlo | La contraseña real de Postgres LOCAL |

En los cuatro casos, quien escribió el mecanismo de redacción confió en que el patrón "se veía bien"
leyéndolo, y lo corrió directo contra el dato real — sin antes confirmarlo contra un valor sintético de
la **misma forma exacta** (mismo separador, mismo prefijo, mismos caracteres de borde) que el dato real
iba a tener. Ninguno de los cuatro reescribió el mecanismo de un incidente anterior: cada uno inventó su
propia redacción ad hoc para su propio caso puntual.

### La regla

> 🔴 **Todo script que redacte o enmascare información sensible (nombres, CUIT, contraseñas,
> credenciales) antes de imprimir algo se prueba PRIMERO contra un valor sintético de la MISMA FORMA
> exacta del dato real** — mismo separador (`postgres://` vs. `postgresql://`, guion vs. punto), mismo
> prefijo/sufijo, mismos caracteres de borde — **antes** de correrlo contra el archivo, la base o el
> `.env` real. No alcanza con que el regex "se vea bien" leyéndolo: se corre una vez contra un fixture
> sintético con la forma exacta, se confirma que redacta lo que tiene que redactar, y recién ahí se
> corre contra el dato real.

### Deuda técnica declarada, no resuelta ahora

Candidato futuro, sin dueño y sin diseño todavía: un **helper único de redacción para sondeos ad hoc**
(distinto de `formaParaLog`/`redactar.ts`, que ya cubren el código de producción) — ya probado una vez
contra las formas reales conocidas, reusado siempre en vez de reescrito cada vez que hace falta un
chequeo puntual contra un documento real o un archivo de secretos. El patrón de los cuatro incidentes
sugiere que la solución no es "tener más cuidado la próxima vez" — eso ya se intentó cuatro veces y
falló cuatro veces, cada una con una forma distinta — sino no tener que escribir la redacción de nuevo
en cada sesión. Evaluar recién cuando se decida priorizarlo, no como parte de esta tarea.

---

## Otras lecciones del rango, breves

- **La convocatoria real (no solo nombrada) siguió funcionando cuando se ejerció**: (204) convocó en
  paralelo a `motor-conciliacion-contable` + `contador-dominio` antes de tocar D-31; (207) convocó
  cuatro agentes en paralelo sobre el diseño del entregable. Ambas con hallazgos reales incorporados —
  sostener el patrón, no relajarlo ahora que el roster ya está probado.
- **El gate verde sigue sin ser evidencia de nada por sí solo** — la allowlist desactualizada de R-F
  (dos veces: (203) y de nuevo declarada en B.26) y los 4 tests rotos de `aislamiento-modulo-1.test.ts`
  desde `0038` (declarado sin dueño en varias entradas) muestran que un rojo preexistente puede quedar
  "conocido" durante semanas sin que nadie lo cierre — confirmar con `git stash` que un fallo es
  preexistente (como se hizo en (204)/(209)) es necesario, pero no sustituye cerrarlo.
- **Modo plan (CLAUDE.md §3.2) se disparó correctamente por criterio (c)** en (200) — una edición de
  `catalogo.ts` que corre contra datos reales de ROKA entró en modo plan antes de tocar nada, y el propio
  plan frenó el cambio cuando `contador-dominio` objetó. Buen ejemplo de que el disparador funciona
  cuando se respeta.
