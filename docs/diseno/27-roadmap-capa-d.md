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

**Migraciones `0027` (11 tablas + 1 vista), `0028` (endurecimiento de grants/trigger) y `0029`
(reproceso de `pendiente_cierre`, cierra B.8) aplicadas a LOCAL y al PILOTO (2026-08-30, `HANDOFF.md`
138, verificadas por consulta directa al catálogo).** Cero código de aplicación escribe o lee ninguna
de las 11 tablas todavía, con una única excepción parcial: el adaptador de ingesta del plan de cuentas.

Las 11 tablas: `cuenta`, `cuenta_atributo`, `documento_ingerido`, `cierre_cliente_periodo`,
`cierre_transicion`, `expectativa_fuente_cliente`, `fuente_cierre`, `pendiente_cierre`,
`pendiente_dispensa`, `asiento_propuesto`, `asiento_propuesto_renglon` — más la vista
`asiento_propuesto_totales` (reemplazó a `total_debe`/`total_haber` como columnas físicas: corrección
real de `26-migracion-cierre-mensual.md` §1.1, un trigger sin `SECURITY DEFINER` no puede escribir
columnas que le revocaron a `app_request`).

### B.2 — Lo único que ya tiene código real: el adaptador de plan de cuentas

`packages/ingesta/src/plan-cuentas/parser.ts` + `packages/data/src/cierre/escrituras.ts::altaPlanDeCuentas`
+ `apps/cli/src/alta-plan-cuentas.ts` — **construido y probado contra el archivo real de Bracci** (227
cuentas). Primero contra un tenant sintético (HANDOFF 129); **ahora aplicado contra el tenant REAL de
Bracci en el piloto** (`f84d9ecc-6d54-4009-8fb6-b6fa3f8d8579`, HANDOFF 139, Bloque 4): 227/227
`cuenta_atributo` sin residuo, árbol resuelto por `SUMARIZA` (nunca por `NIVEL`), las 4 cuentas
candidatas a socio con el `padron_socio_id` real correcto (mapeo confirmado por JP, D-25 Opción A —
nunca por matching de texto). Primera carga real de Capa D contra un cliente real del piloto.

**Para ROKA: aplicado contra el tenant REAL (`69479b8f-9b6a-4d6b-bdb2-bff817c2e750`, HANDOFF 140):
219/219 `cuenta_atributo` sin residuo, árbol resuelto por `SUMARIZA`.** La ambigüedad de mapeo a socio
resultó DISTINTA de lo que se suponía por analogía con Bracci — no son 4 cuentas pareadas Activo+Pasivo
para 2 personas, sino **4 cuentas, 1 por persona** (`1.2.4.300`/`1.2.4.400` en Activo,
`2.1.9.100`/`2.1.9.200` en Pasivo), contra las 4 personas reales en `padron_socio`. **2 de las 4
resueltas por evidencia documental real** (Gabriela y el familiar no-socio, este último verificado por
HMAC del CUIT contra `padron_socio.documento_hmac`, nunca por texto). **Las otras 2 quedaron
PROVISORIAS** — decisión de JP para destrabar el piloto sin esperar confirmación de Laura sobre cuál
socia es "Socio 1"/"Socio 2" — ver `10-deuda-declarada.md` B.10.

### B.3 — Los dos bloqueos concretos antes de escribir motor de verdad

1. **Bloque 2 — backfill de `documento_ingerido` con los 3 lotes reales del piloto (Bancor/Nación/ICBC).
   ✅ CERRADO 2026-08-31 (Sesión 2a) — ver `HANDOFF.md` 141.** Estaba bloqueado por dos hallazgos de
   `docs/diseno/10-deuda-declarada.md`, ambos ya resueltos antes de esta sesión:
   - **B.7**: ✅ **CERRADO 2026-08-29 (Sesión 1, Bloque 1)** — veredicto **por cuenta, no por archivo**
     (convocatoria real a `analista-funcional` + `contador-dominio`, sin disenso; detalle completo en
     `10-deuda-declarada.md`). Queda pendiente el DDL que instrumenta la granularidad (extender
     `fuente_cierre` o tabla hija nueva) para un futuro lote multi-cuenta — decisión de `dba-data`, sin
     dueño todavía; los 3 lotes de Sesión 2a son mono-cuenta y no lo necesitaron.
   - **B.8**: ✅ **CERRADO 2026-08-30 (Bloque 2) — migración `0029` aplicada a LOCAL y al PILOTO,
     6/6 mutación verde, sin regresión en `0028`/`0027`.** `uq_pendiente_cierre_natural` pasa a índice
     parcial + `fk_pendiente_cierre_superseded` a `DEFERRABLE`; detalle completo en
     `10-deuda-declarada.md`. Alcance acotado a `pendiente_cierre` por decisión de JP — el mismo
     patrón en `documento_ingerido`/`expectativa_fuente_cliente`/`fuente_cierre` queda declarado como
     **B.9**, sin dueño (confirmado no bloqueante para Sesión 2a por dos agentes independientes,
     `HANDOFF.md` 141).

   **Resultado real (Sesión 2a):** los 3 lotes reales (Bancor/Contenedores Paoluc S.A.S.,
   Nación/H y J Servicios y Obras S.A.S., ICBC/MEB Integración y Montaje S.A.S.) tienen su fila en
   `documento_ingerido` — paridad 1:1, 0 filas perdidas, 0 de más, verificado por consulta directa
   contra el piloto. `packages/data/src/cierre/escrituras.ts::backfillDocumentoIngerido` +
   `apps/cli/src/backfill-documento-ingerido.ts`, 14 tests nuevos. Galicia/Macro/Santander (los 3
   lotes "viejos", multi-cuenta) quedan fuera a propósito — backfill aparte si hace falta.

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
| ✅ Cerrado (verificado 2026-08-30, Bloque 2) | **D-19** (nivel N1/N2 de `cierre_estado`/`asiento_estado`/`pendiente_estado`) — código YA escrito y en el gate: `clasificacion-campos.ts:1084-1225`, argumento explícito en `25-segunda-convocatoria-cierre-mensual.md:265`. Cobertura verificada completa contra las 11 tablas de `0027`, ninguna columna `*_estado` sin clasificar. Hallazgo menor no bloqueante: la vista `asiento_propuesto_totales` no tiene entrada propia en `CLASIFICACION` (el gate no la exige, `relkind='r'` en `catalogo.test.ts:120-141`, pero es una laguna de documentación) — agregarla cuando se convoque de nuevo a `dba-data`/`seguridad-datos-financieros` | — |
| ✅ Cerrado (verificado 2026-08-30, Bloque 2) | **D-18.b** (roles simétricos de `asiento_propuesto_renglon`) — decisión Y esquema (RLS) ya implementados: `0027_cierre_mensual.sql:786-876`, ratificado en `25-segunda-convocatoria-cierre-mensual.md:188-220`. `seguridad-datos-financieros` confirmó consistencia contra el precedente de `reconocimiento_contrapartida` | — |
| `backend-dev`, con `seguridad-datos-financieros` + `dba-data` re-verificando código contra decisión ya tomada | **D-18.a** (mecanismo `debe = haber`: chequeo antes de proponer + recálculo al confirmar) — genuinamente pendiente, pero de IMPLEMENTACIÓN, no de decisión: `0027_cierre_mensual.sql:15-28` ya fija que NO es un trigger (verificado no implementable sin `SECURITY DEFINER`), sino dos puntos de código TypeScript, explícitamente "fuera de alcance" de esa migración. Cero código en `packages/data/src/cierre/` ni en ningún otro paquete todavía (`tipos.ts` es solo tipos) | Bloqueado por lo mismo que el resto del motor: sin `motor-conciliacion-contable` arrancado, no hay dónde escribir el chequeo |
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

### Sesión 1 — Desbloquear el motor (sin escribir lógica de negocio todavía) — ✅ COMPLETA (2026-08-30)

**Qué se hace:** cerrar B.7 (semántica de período para documentos multi-cuenta) y B.8 (índice único
sin predicado parcial), resolver o registrar explícitamente D-18 y D-19, aplicar las migraciones
0027/0028 al piloto siguiendo `CLAUDE.md` §1.9 (listar lo pendiente, confirmar contra lo autorizado,
frenar ante cualquier exceso), y cargar el plan de cuentas real de Bracci (227 cuentas) en el tenant
real del piloto — hoy solo está probado contra un tenant sintético.

> **Estado (2026-08-29): Bloque 1 CERRADO** (B.7, ver arriba). Commit `06ad47b`.
> **Estado (2026-08-30): SESIÓN CAPA D COMPLETA — los 4 bloques cerrados y verificados, extendida a
> los DOS clientes de prueba del piloto (Bracci y ROKA), no solo Bracci.** Bloque 2 CERRADO (B.8 +
> D-18 + D-19 — D-18.a queda pendiente pero de implementación futura del motor, no de decisión, no es
> deuda de este bloque). Migraciones `0027`/`0028`/`0029` aplicadas al PILOTO (`HANDOFF.md` 138),
> verificadas por consulta directa al catálogo, una por una. **Bloque 4 CERRADO** (`HANDOFF.md` 139):
> las 227 cuentas reales de Bracci cargadas en su tenant real del piloto, con el mapeo real de socios
> confirmado por JP — primera carga real de Capa D contra un cliente real, no sintético. El "Bloque 3"
> original de esta sección (ver más abajo) se fusionó en la práctica con el trabajo de migraciones al
> piloto ya cerrado arriba. **Extensión a ROKA CERRADA** (`HANDOFF.md` 140): 219 cuentas reales
> cargadas en el tenant real de ROKA (`69479b8f-...`) — 2 de las 4 cuentas de socio confirmadas por
> evidencia documental + verificación por HMAC, 2 provisorias por decisión de JP, pendientes de
> confirmación de Laura (`10-deuda-declarada.md` B.10, sin bloquear el cierre de esta sesión).
>
> **Commits:** solo `06ad47b` (Bloque 1, B.7) está commiteado a `main`. El resto del trabajo de esta
> sesión (Bloque 2 — migración `0029` + tests; Bloque 4 — carga real de Bracci; extensión ROKA — carga
> real + `HANDOFF.md` 140 + este documento + `10-deuda-declarada.md` B.10) está aplicado y verificado
> contra el piloto real, pero **todavía sin commitear** — `git status` al cierre de esta entrada
> muestra `HANDOFF.md`, `docs/diseno/10-deuda-declarada.md` y este archivo modificados, más
> `packages/data/migrations/0029_pendiente_cierre_reproceso.sql` y su test de mutación sin trackear.
> No hay hashes de commit reales para esa parte todavía — no se inventan acá.

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

### Sesión 2a — Backfill real — ✅ COMPLETA (2026-08-31)

**Qué se hizo:** backfillear `documento_ingerido` con los 3 lotes reales ya ingeridos
(Bancor/Nación/ICBC), desbloqueado por la sesión 1. Alcance acotado a solo el backfill — la lógica de
clasificación (lo que el documento original agrupaba en esta misma sesión) se movió a la Sesión 2b,
sin arrancar todavía.

**Por qué esta y no otra antes:** backfillear sin haber cerrado B.7/B.8 hubiera sido re-trabajo.

**Convocatoria real:** `dba-data` (mapeo de columnas, resolución de `cobertura` sin fuente en Capa 1),
`seguridad-datos-financieros` + `security-engineer` en paralelo (guard R18, TOCTOU, no loguear
`objeto_almacenamiento`, `conErroresTraducidos` en el INSERT, centinela de idempotencia).

**Criterio de aceptación (números): CUMPLIDO.** Backfill con paridad 1:1 — 3 filas backfilleadas en
`documento_ingerido` = 3 lotes ya ingeridos en Capa 1 (Bancor/Nación/ICBC), 0 filas perdidas, 0 de
más, verificado por consulta directa contra el piloto. Detalle completo: `HANDOFF.md` 141.

**Commits:** ninguno todavía — código, tests y backfill real aplicados y verificados contra el piloto,
pero sin commitear (`HANDOFF.md` 141, punto 10).

### Sesión 2b — Primera clasificación (esquema CERRADO e IMPLEMENTADO, código NO empezado)

**Actualización 2026-08-31 (sesión nocturna autónoma):** diseño de D-29 cerrado con acuerdo real de
`dba-data` + `contador-dominio` + `plan-cuentas-multicliente` (`28-diseno-motor-clasificacion.md`
§2), y su esquema — más D-27/D-28/D-30 — **implementado y aplicado contra LOCAL** (migraciones
`0030_regla_imputacion.sql`, `0031_capa_d_vocabulario_motivo.sql`,
`0032_documento_ingerido_lote_fk.sql`; sin push, sin tocar el piloto). Detalle en `HANDOFF.md` y en
`28-diseno-motor-clasificacion.md` §6/§7. **Lo que sigue sin empezar es el código del motor en sí**
(ítem E de la lista de la sesión nocturna, no llegó a arrancar).

**Qué se hace:** con `documento_ingerido` ya poblado por la Sesión 2a, arrancar la lógica de
asignación de cuenta en sí — la primera versión de `motor-conciliacion-contable` — sobre el caso más
simple disponible con datos reales, generando `pendiente_cierre` para al menos un período real.

**Por qué esta y no otra antes:** escribir la lógica de clasificación antes de tener datos reales en
`documento_ingerido` hubiera sido probarla contra fixtures, que es exactamente lo que ya se evitó en
otros bloques de este proyecto (nunca datos reales sintetizados para bypasear el problema).

**Convocatoria (pendiente, todavía no realizada):** `motor-conciliacion-contable` + `contador-dominio`
(reglas de clasificación y criterio de asiento), `plan-cuentas-multicliente` (mapeo cuenta-atributo
del cliente en cuestión), `qa-funcional` (definir en números qué es "clasificado" vs "pendiente de
revisión").

**Criterio de aceptación (números):** `pendiente_cierre` generado para al menos 1 período real, con
el primer número concreto de valor: % de movimientos clasificados automáticamente vs. % que cae a
revisión manual.

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
