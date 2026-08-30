---
Roadmap consolidado, creado 2026-08-29 en modo plan (sin tocar código). Junta en un solo lugar lo
que hoy está repartido en HANDOFF.md, `23`/`24`/`25`/`26-migracion-cierre-mensual.md`,
`packages/ingesta/src/adaptadores/contrato.ts` (regla 4) y el commit `b4e95d5` (inventario real de
Bracci/ROKA sobre FCI y tarjeta corporativa). Convocatoria real: `documentador` (verificación de
estado contra el código) y `product-owner` (recomendación de orden de la sección 3).
---

# Roadmap de Capa D — motores de extracción y motor de asientos

> **Cuándo leer este documento**: es el punto de entrada para "¿por dónde seguimos?". Reemplaza la
> reconstrucción manual de HANDOFF + los cuatro documentos de diseño cada vez que hace falta decidir
> el próximo paso. Cuando algo de acá quede desactualizado, se corrige acá — no se abre un documento
> nuevo por cada actualización de estado.
>
> **Separación que se respeta en todo el documento**: Sección A es trabajo de **extracción** (Capa 1
> — un banco, un formato de FCI, un formato de tarjeta más; el resultado es "leí el documento
> correctamente"). Sección B es trabajo del **motor** (Capa 2 — la lógica de asiento; el resultado es
> "propuse el asiento contable correcto"). Nunca se mezclan en una sola lista de tareas: compiten por
> atención de forma distinta y las convoca gente distinta.

---

## Sección A — Motores de extracción (Capa 1)

| Fuente | Estado | Qué falta exactamente | Tamaño | Cliente real que lo necesita primero |
|---|---|---|---|---|
| **Galicia** (extracto cta cte, PDF) | ✅ Completo | Nada para uso actual. Hardcodeado a 1 cuenta por documento (regla 4 de `contrato.ts` sin aplicar todavía) — sin caso real que lo exija hoy | — | Bracci Repuestos S.A.S. (2 cuentas, cada una en documento propio — ya cubierto sin cambios) |
| **Santander** (extracto cta cte, PDF) | ✅ Completo | Nada. Ya genérico multi-cuenta (`multiCuenta: true`, `regionesDeTabla`) — es el ejemplo, junto con Macro, de la regla 4 ya cumplida | — | Cliente original del piloto (etiqueta genérica, sin razón social real cargada) |
| **Macro** (extracto multi-cuenta, PDF) | ✅ Completo | Nada. Genérico desde 2026-08-11 (`seccionesPorClave` por número de cuenta), confirmado contra 3 cuentas reales | — | ROKA (3 cuentas: corriente, especial, USD — ya cargado en el piloto) |
| **Bancor** (extracto cta cte, PDF) | ✅ Completo | Hardcodeado a 1 cuenta — sin caso real multi-cuenta que lo ejercite. Peor riesgo del roster si aparece uno: el signo depende solo de la cadena de saldos por cuenta, un merge de 2 cuentas podría cerrar aritméticamente en silencio | Grande, si aparece el caso | Contenedores Paoluc S.A.S. (94 movimientos, ya ingeridos) |
| **Nación** (extracto cta cte, PDF) | ✅ Completo | Hardcodeado a 1 cuenta, medido contra un solo documento con un solo movimiento — base de evidencia mínima | Grande, si aparece el caso | H y J Servicios y Obras S.A.S. (1 movimiento, ya ingerido) |
| **ICBC** (extracto cta cte, PDF) | ✅ Completo | Hardcodeado a 1 cuenta. Verificación más débil del roster (`cadenaDeSaldos: 'por_puntos_de_control'`, solo 5/9 filas con saldo) — un merge de cuentas tendría menos puntos de control para delatarse | Grande, si aparece el caso | MEB Integración y Montaje S.A.S. (9 movimientos, ya ingeridos) |
| **BBVA** (extracto cta cte) | 🔴 Bloqueado | Imagen pura, cero caracteres nativos — necesita OCR completo, no wireado para extractos bancarios (solo para tarjetas hoy). Nunca se escribió el adapter | Grande (OCR de tabla completa, no de campos puntuales como en tarjetas) | H y J Servicios y Obras S.A.S. (tiene esta cuenta bloqueada en paralelo con Nación ya funcionando — es HOY el caso real de "una fuente viva, otra bloqueada") |
| **FCI — layout Galicia** (`FONDO - X CLASE Y`) | ⚠️ Parcial, preliminar | Extractor sin oficializar (sin `contrato.ts`/`esquema.ts`/`persistir.ts`, sin `clienteId` en la salida — `23` §2.3 punto 1). Validado contra Elite-IT SAS (real, sin tenant). **Confirmado que NO es el formato de Bracci ni de ROKA** (cruce estructural, commit `b4e95d5`: 0 coincidencias del literal `FONDO - ... CLASE` en ninguno de los dos) | Mediano (oficializar el contrato) + hay que encontrar QUÉ cliente real usa este layout, si alguno del piloto | Elite-IT SAS (fuera del piloto) |
| **FCI — layout Santander** (`Fondo: X`) | ⚠️ Parcial, preliminar, y con un bloqueo de entorno nuevo | Extractor sin oficializar, mismos huecos que el de Galicia. Validado contra Pannonica SAS (real, sin tenant). **El cruce estructural sugiere que Bracci Y ROKA usan este layout** (3 y 6 coincidencias del literal `Fondo:` respectivamente, commit `b4e95d5`), pero **no confirmado con una corrida real**: el extractor tira `BuildDePdftotextIncorrectaError` en este entorno — problema del build de `pdftotext` instalado, no del documento | Chico (arreglar el build de Poppler) + mediano (oficializar el contrato, una vez confirmado) | Bracci Repuestos S.A.S. Y ROKA (los dos, si la hipótesis del layout se confirma) — sería el primer caso de un extractor de FCI que sirve a más de un cliente real del piloto |
| **Tarjeta — Cabal débito** | ✅ Construido | Nada de extracción. Conectar a persistencia es Sección B (Commits 3/4, esperando `documento_ingerido`) | — | Caso testigo del módulo de liquidaciones |
| **Tarjeta — Visa crédito** | ✅ Construido | Ídem | — | ROKA |
| **Tarjeta — Visa débito** | ✅ Construido, validado contra PDF real de ROKA (100% escaneado, 8 páginas — ejercitó el camino OCR completo) | Ídem | — | ROKA |
| **Tarjeta — Visa Corporativa** (Bracci) | 🔴 Sin empezar | Ninguno de los 3 formatos existentes la reconoce (`sin_adaptador` los tres, commit `b4e95d5`). Marca confirmada: VISA, en página con texto nativo (5 de 6 páginas; la 6ª ni tiene texto ni el OCR pudo decodificar su imagen — problema de entorno aparte). Es un producto Visa distinto de crédito/débito personal — layout propio a medir | Mediano — mismo patrón que los otros 3 (medir → especificar → construir → probar) | Bracci Repuestos S.A.S. |
| **Libro IVA Compras / Ventas** | 🔴 Sin empezar | Ningún adapter. `documento_ingerido.tipo_documento` ya reserva los dos valores (`libro_iva_compras`, `libro_iva_ventas`) desde la migración `0027` — el esquema no bloquea, falta todo el código. Es lo que más volumen de la cola del paso 6 destraba (`23` §1.3) | Grande — formato depende de qué exporta ARCA/el sistema de facturación de cada cliente, sin medir todavía | Cualquier cliente Responsable Inscripto — hoy ninguno tiene esta fuente conectada |
| **Comprobantes ARCA** | 🔴 Sin empezar, ni siquiera diseñado en detalle | D-5c ya decidió que entran por `documento_ingerido` (archivo que exporta el contador, no una API — `08` de Project Knowledge confirmó que no hay web service de lectura). Falta decidir si usan un `tipo_documento` propio o se apoyan en `libro_iva_compras`/`ventas` — no decidido | Grande, y depende de las 4 preguntas todavía sin responder a Laura (`24` §7, pregunta 14) | Ninguno todavía — bloqueado por la ronda de preguntas a Laura |

**Notas que no entran en la tabla:**

- La **regla 4** de `contrato.ts` ("un adaptador reconoce N cuentas, nunca asume 1") está escrita
  pero **no aplicada retroactivamente** a Galicia/Bancor/Nación/ICBC — los cuatro siguen hardcodeados
  a 1 cuenta. No es deuda urgente: ningún cliente real de esos cuatro bancos trajo nunca un documento
  multi-cuenta. Se vuelve tarea real el día que aparezca uno, no antes — medir primero, nunca suponer
  (mismo criterio que ya evitó tocar Macro sin necesidad en la tarea de inventario del 2026-08-28).
- El **bloqueo de `pdftotext`** (FCI-Santander) es infraestructura del entorno de esta sesión/worktree,
  no del proyecto en general — antes de darlo por bloqueado en otra máquina, confirmar la versión del
  binario instalado.

---

## Sección B — El motor de Capa D (Capa 2)

### B.1 — Dónde está el esquema, en una frase

**Migraciones `0027` (11 tablas + 1 vista) y `0028` (endurecimiento de grants/trigger) aplicadas a
LOCAL, nunca al piloto.** Cero código de aplicación escribe o lee ninguna de las 11 tablas todavía,
con una única excepción parcial: el adaptador de ingesta del plan de cuentas.

Las 11 tablas: `cuenta`, `cuenta_atributo`, `documento_ingerido`, `cierre_cliente_periodo`,
`cierre_transicion`, `expectativa_fuente_cliente`, `fuente_cierre`, `pendiente_cierre`,
`pendiente_dispensa`, `asiento_propuesto`, `asiento_propuesto_renglon` — más la vista
`asiento_propuesto_totales` (reemplazó a `total_debe`/`total_haber` como columnas físicas: corrección
real de `26-migracion-cierre-mensual.md` §1.1, un trigger sin `SECURITY DEFINER` no puede escribir
columnas que le revocaron a `app_request`).

### B.2 — Lo único que ya tiene código real: el adaptador de plan de cuentas

`packages/ingesta/src/plan-cuentas/parser.ts` + `packages/data/src/cierre/escrituras.ts::altaPlanDeCuentas`
+ `apps/cli/src/alta-plan-cuentas.ts` — **construido y probado contra el archivo real de Bracci** (227
cuentas, HANDOFF 129): 227/227 `cuenta_atributo`, árbol resuelto por `SUMARIZA` (nunca por `NIVEL`),
7 tipos de anomalía detectados sin corregir nada solo. Corrió contra un tenant **sintético**, nunca
contra el piloto real de Bracci — la carga real está pendiente, con autorización puntual (`CLAUDE.md`
§1.9).

**Para ROKA (Bloque 3 de la tarea de HANDOFF 132): sin empezar.** Incluye una ambigüedad sin resolver
todavía: 4 cuentas candidatas a "cuenta particular de socio" contra `padron_socio`, con el mismo
criterio D-25 que Bracci (Opción A, mapeo manual, el adaptador aborta si falta una entrada — nunca
adivina por matching de texto).

### B.3 — Los dos bloqueos concretos antes de escribir motor de verdad

1. **Bloque 2 — backfill de `documento_ingerido` con los 3 lotes reales del piloto (Bancor/Nación/ICBC).**
   Bloqueado por dos hallazgos de `docs/diseno/10-deuda-declarada.md`:
   - **B.7**: la semántica de `periodo_desde`/`periodo_hasta` para documentos multi-cuenta no está
     cerrada — hoy el período vive en `lote_ingesta_cuenta` (por cuenta), no en `lote_ingesta` (por
     archivo), y un backfill que compute `MIN`/`MAX` en silencio puede mentir si una cuenta se abrió a
     mitad de mes (caso real: Macro/ROKA, un archivo con 3 cuentas).
   - **B.8**: `uq_pendiente_cierre_natural` no tiene predicado parcial — una fila de reproceso no puede
     compartir clave natural con la que reemplaza. No bloquea `0028` (que solo gobierna la fila vieja),
     pero sí bloquea el flujo real de reproceso de `pendiente_cierre`.

   **Esto no bloquea crear las 6 tablas vacías** (ya están, desde `0027`) — bloquea específicamente
   poner las 3 filas reales adentro.

2. **Commits 3/4 de liquidaciones** (conectar Cabal/Visa a persistencia real) — esperan a que
   `documento_ingerido` tenga al menos un backfill o un flujo de alta nuevo funcionando, para no crear
   un registro paralelo (D-11, ratificado en `23` §3.2).

### B.4 — Qué convocatoria hace falta para la lógica de asignación de cuenta (todavía no convocada)

Ninguna sesión convocó todavía, de forma real, el diseño de **cómo un movimiento bancario o una línea
de liquidación se traduce en `cuenta_id` + `debe`/`haber`** — la pieza central del motor. Lo que sí
está resuelto (D-1 a D-23 de `23`/`24`/`25`) es la forma de las tablas alrededor de esa pieza, no la
pieza en sí. Falta, con las preguntas ya identificadas y sin responder:

| Convocatoria | Sobre qué | Por qué todavía no se hizo |
|---|---|---|
| `contador-dominio` + `motor-conciliacion-contable` | Reglas de imputación por concepto/literal → `cuenta_id`, reusando el léxico ya escrito en `packages/contabilidad` (Módulo 2) como insumo, no como reemplazo | Depende de que el plan de cuentas versionado (D-15, `cuenta`/`cuenta_atributo`) tenga al menos un cliente real cargado para probar contra algo — hoy solo hay una corrida sintética |
| `plan-cuentas-multicliente` | Cómo se resuelve `rol_funcional` → `cuenta_id` cuando el mismo concepto (ej. "aporte de socio") tiene que resolver contra el plan **propio** de cada cliente, no un código universal (R42) | Bloqueado por lo mismo: sin plan de cuentas real cargado, no hay con qué probar la resolución |
| `arquitecto-software` + `dba-data` | D-18 (trigger de `debe = haber`, con la auditoría de roles que `dba-data` pidió antes de escribirlo) y D-19 (nivel N1/N2 de `cierre_estado`) — las dos únicas divergencias/pendientes reales que dejó `24` §9 | Nunca se hizo la ronda de seguimiento — quedó explícitamente anotada como "para la próxima convocatoria" en `24` §9 y sigue sin correr |
| `seguridad-datos-financieros` | D-16 (clasificación de `cuenta_atributo.denominacion` con nombre de socio) y D-20 (forma exacta del `CHECK` de `verificacion_heredada`) | Mismo motivo — pendiente desde `24`/`25`, nunca ejecutada como convocatoria de escritura de código (sí como convocatoria de diseño, ya cerrada en `25`) |
| `contador-dominio` | Confirmar contra Laura las 4 preguntas que siguen abiertas (`24` §7: timing de diferencia de cambio, cuenta puente de Bracci, quién firma el asiento, las 4 de ARCA) | Nunca se mandó la ronda 3 completa — sigue pendiente desde antes de `23` |

**Ninguna de estas cinco es "escribir código todavía"**: son las convocatorias de diseño/decisión que
tienen que cerrar ANTES de que `contador-dominio` + `motor-conciliacion-contable` puedan especificar
la lógica de asignación con algo más que el criterio de un solo cliente sintético.

### B.5 — Cómo se prueba: Bracci primero, ROKA después — ya decidido, no a redecidir

**Bracci es el caso simple a propósito** (una sola fuente por tipo — Galicia cta cte + cta especial,
FCI, tarjeta — sin multi-banco, sin transferencias entre cuentas propias): sirve para probar el
mecanismo de extremo a extremo (documento → `fuente_cierre` → `pendiente_cierre` → `asiento_propuesto`)
sin la complejidad de consolidar. **Nunca es el caso que valida el diseño multi-fuente** (D-12, `23`
§3.5) — eso lo hace ROKA a propósito, con sus 3 cuentas Macro + FCI + (sin tarjeta, confirmado no
faltante) — y potencialmente ahora también el layout de FCI compartido con Bracci, si se confirma.

Orden real, tal como ya lo fija `23` §3.5 y `24` D-12: **Bracci valida el mecanismo. ROKA valida que el
mecanismo no se rompe con más de una fuente.** No se invierte el orden, y no se da Bracci por "listo
para producción" sin haber corrido también ROKA — un diseño que solo pasó contra Bracci pasa el piloto
entero en verde y explota con el primer cliente real multi-fuente (mismo patrón que ya costó la trampa
de `R42` en `10-deuda-declarada.md` §1).

---

## Sección C — Recomendación de orden para las próximas 3-4 sesiones

> Convocatoria real a `product-owner`, 2026-08-29. No es una lista de todo el backlog: es lo
> inmediato, con su motivo.

### La tensión, resuelta primero

Frenar la extracción "porque sí" (banco nuevo, formato nuevo, porque es fácil y da progreso visible)
durante las próximas tres sesiones. Hoy hay 6 bancos reales cerrados y 3 formatos de tarjeta
validados contra documentos reales: eso ya es más fuente de la que el motor puede consumir, porque el
motor tiene **cero** código. Seguir sumando extracción en este momento es exactamente el patrón que
castiga `09-lecciones-aprendidas.md`: gate verde (o, acá, "cobertura creciente") que no se traduce en
el output que le importa a Laura, el asiento propuesto. No hay un cliente real esperando un banco
nuevo ni Libro IVA/comprobantes ARCA todavía — eso descarta esas líneas de este tramo sin costo real
(nadie las está esperando).

Hay dos excepciones reales, no arbitrarias, y las dos quedan para la **sesión 4**, no antes: el 4º
formato de tarjeta (Visa corporativa de Bracci) y la confirmación con corrida real del layout
Santander-style de FCI para Bracci/ROKA. Las dos son prerrequisito para cerrar el mes **completo** de
Bracci — el caso que el plan ya eligió como primero — no "extracción por sumar". Si el motor funciona
pero Bracci tiene una tarjeta sin extractor, el primer entregable a Laura queda incompleto por una
fuente, no por el motor. Eso sí traba el objetivo final; un banco 7 sin cliente esperando, no.

Nota sobre BBVA: sigue bloqueado y no entra en este tramo. No es una traba real ahora mismo — H y J
Servicios tiene su cuenta de Nación funcionando de forma independiente, así que el supuesto
documentable es "el mes de H y J se cierra con Nación; BBVA queda pendiente y se declara como fuente
faltante en el entregable de ese cliente hasta que haya OCR de tabla completa." Incompleto y con
workaround, no bloqueo.

### Sesión 1 — Desbloquear el motor (sin escribir lógica de negocio todavía)

**Qué se hace:** cerrar B.7 (semántica de período para documentos multi-cuenta) y B.8 (índice único
sin predicado parcial), resolver o registrar explícitamente D-18 y D-19, aplicar las migraciones
0027/0028 al piloto siguiendo `CLAUDE.md` §1.9 (listar lo pendiente, confirmar contra lo autorizado,
frenar ante cualquier exceso), y cargar el plan de cuentas real de Bracci (227 cuentas) en el tenant
real del piloto — hoy solo está probado contra un tenant sintético.

**Por qué esta y no otra antes:** es literalmente imposible escribir la lógica de asignación de cuenta
(la pieza de valor real) mientras el esquema de Capa D solo existe en local y el backfill de
`documento_ingerido` está bloqueado. Esta sesión no agrega ninguna feature visible; destraba todo lo
que sigue. Es la sesión más aburrida y la más urgente.

**Convocatoria:** `dba-data` + `security-engineer` + `seguridad-datos-financieros` (migración a un
entorno con datos reales, carga de plan de cuentas de un cliente real), `analista-funcional` +
`contador-dominio` (cerrar la semántica de período de B.7, que es una decisión de negocio, no solo
técnica), `plan-cuentas-multicliente` (alta del tenant real de Bracci), `backend-dev` (implementación
de los fixes).

**Criterio de aceptación (números):** B.7 y B.8 en 0 issues abiertos. Migraciones 0027/0028
confirmadas aplicadas al piloto por consulta directa (no por supuesto — ya pasó dos veces que una
migración quedó aplicada solo en local). 227 cuentas de Bracci verificadas por conteo en el tenant
real, 0 quedando solo en el tenant sintético como única copia. D-18 y D-19 cerrados o con decisión de
riesgo aceptado registrada con fecha y motivo — 0 ítems sin dueño.

### Sesión 2 — Backfill real + primera clasificación

**Qué se hace:** backfillear `documento_ingerido` con los 3 lotes reales ya ingeridos
(Bancor/Nación/ICBC), ahora desbloqueado por la sesión 1. Con eso adentro, arrancar la lógica de
asignación de cuenta en sí — la primera versión de `motor-conciliacion-contable` — sobre el caso más
simple disponible con datos reales, generando `pendiente_cierre` para al menos un período real.

**Por qué esta y no otra antes:** backfillear sin haber cerrado B.7/B.8 hubiera sido re-trabajo.
Escribir la lógica de clasificación antes de tener datos reales en `documento_ingerido` hubiera sido
probarla contra fixtures, que es exactamente lo que ya se evitó en otros bloques de este proyecto
(nunca datos reales sintetizados para bypasear el problema).

**Convocatoria:** `motor-conciliacion-contable` + `contador-dominio` (reglas de clasificación y
criterio de asiento), `plan-cuentas-multicliente` (mapeo cuenta-atributo del cliente en cuestión),
`qa-funcional` (definir en números qué es "clasificado" vs "pendiente de revisión").

**Criterio de aceptación (números):** backfill con paridad 1:1 — filas backfilleadas en
`documento_ingerido` = filas ya ingeridas en Capa 1 para esos 3 lotes, 0 filas perdidas.
`pendiente_cierre` generado para al menos 1 período real, con el primer número concreto de valor: %
de movimientos clasificados automáticamente vs. % que cae a revisión manual.

### Sesión 3 — Primer entregable real para Laura

**Qué se hace:** cerrar el circuito hasta `asiento_propuesto` para un mes real completo de Bracci (el
caso simple ya elegido), y producir el primer archivo exportable comparable contra la planilla de
Laura — el entregable más chico que ya sirve, no una pantalla.

**Por qué esta y no otra antes:** es la primera vez en todo el proyecto que existe algo para mostrarle
a la contadora que no sea extracción. Antes de esto no hay nada que comparar; después, cada sesión
adicional de motor tiene un punto de comparación real.

**Convocatoria:** `motor-conciliacion-contable` + `contador-dominio` (validar que lo propuesto es
correcto contra criterio contable), `qa-funcional` (criterio de aceptación en números, no en "que ande
bien"), `ux-designer` (formato del export/cola de revisión — primera vez que un humano externo al
equipo técnico lo mira), `seguridad-datos-financieros` (dato real de un cliente circulando por código
nuevo).

**Criterio de aceptación (números):** N asientos propuestos para el mes real de Bracci, cada uno con
evidencia trazable (movimiento origen + cuenta + score) — 0 asientos escritos directo a libro (el
sistema es asistido, no automático, no negociable). % de esas líneas que, según `contador-dominio`,
coincide con lo que Laura hubiera tipeado a mano para ese mes.

### Sesión 4 — Cerrar el universo de fuentes de Bracci + decidir ROKA

**Qué se hace:** ahora sí, extracción — pero acotada a lo que cierra a Bracci: el 4º formato de
tarjeta (Visa corporativa) y la corrida real (no solo el análisis estructural) que confirme o refute
el layout Santander-style de FCI para Bracci y ROKA. Con eso resuelto, decisión explícita y
documentada sobre abrir el Bloque 3 (ROKA, caso multi-fuente) para el motor, incluyendo resolver antes
la ambigüedad de mapeo a socio que ROKA tiene pendiente — no arrancar ROKA con esa ambigüedad todavía
abierta.

**Por qué esta y no antes:** hacerla antes de la sesión 3 hubiera sido volver al patrón de "sumar
extracción" sin haber probado primero que el motor entrega valor con lo que ya existe. Hacerla después
demora sin necesidad el cierre completo del caso ya elegido.

**Convocatoria:** `backend-dev` + `tech-lead` (mantener coherencia de patrón entre los 4 formatos de
tarjeta), `devops` (el problema de entorno de `pdftotext` que bloqueó la corrida real de FCI — barato
de resolver en paralelo, no compite por la misma atención que el resto de la sesión),
`plan-cuentas-multicliente` + `analista-funcional` (la ambigüedad de mapeo a socio de ROKA antes de
decidir si se abre).

**Criterio de aceptación (números):** 4º formato de tarjeta validado contra documento real de Bracci
(mismo criterio que los 3 anteriores — nunca contra fixture sintético). FCI confirmado o refutado con
corrida real para 2/2 clientes (Bracci y ROKA). Decisión de apertura de ROKA registrada con fecha y
motivo, y ambigüedad de mapeo a socio cerrada o con supuesto documentado antes de que arranque
cualquier código de ROKA.

### Qué se pierde con este orden (explícito)

Ningún banco nuevo ni formato de tarjeta "genérico" avanza en este tramo — se pierde la sensación de
progreso visible de extracción, pero no se pierde nada que un cliente real esté esperando hoy. Libro
IVA y comprobantes ARCA quedan completamente fuera de esta ventana. BBVA sigue bloqueado con
workaround documentado (Nación de H y J alcanza para su cierre parcial). Nada de esto toca un control
de aislamiento ni el secreto fiscal — eso no es alcance negociable y no se recorta acá.

---

> ⚠️ **Implicancia contable y fiscal.** Este documento consolida decisiones de estructura y de
> proceso con efecto directo sobre balance y sobre datos de terceros. No agrega ninguna decisión
> nueva de dominio — remite a `23`/`24`/`25`/`26`, que ya llevan su propia advertencia. **Validar con
> profesional matriculado antes de que cualquiera de estas piezas produzca un asiento real.**
