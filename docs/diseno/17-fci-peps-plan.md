# 17 — Costeo PEPS de Fondos Comunes de Inversión: estado completo

> **Este documento es la fuente única y autocontenida del estado de FCI.** Si estás retomando esto
> sin haber visto la sesión que lo escribió (otra sesión de Claude Code, Codex, o la conversación de
> Claude.ai que originó el pedido): todo lo que hace falta saber está acá. `HANDOFF.md` tiene el
> registro cronológico de las entradas (103-108, 114) pero el detalle vive acá, no repartido.
>
> 🟢 **Paso 1 (núcleo puro) — commiteado.** `packages/fci/` en `main` (`a1189e2`, `9de816c`), sin
> migración, sin persistencia, sin Capa D, sin adapter de PDF.
>
> 🟢 **Paso 2 (verificación del eje 1 contra los 3 extractos reales) — commiteado.** Julio y agosto
> cierran **EXACTO en los 3 fondos**, con atribución de movimientos por fondo real (patrón literal
> `FONDO - <nombre> CLASE <letra>`, dado por el titular). Junio no es verificable con este lote de 3
> archivos (estructural, falta el extracto de mayo, no un bug). Ver sección 4.
>
> 🟢 **Paso 3 (`consumirRescate` contra la secuencia real) — commiteado.** Cero errores en los 3
> fondos × 3 cortes encadenados; el fondo más activo reprodujo el mecanismo de rescate partido entre
> múltiples capas (el caso real que motivó el subsistema); chequeo de coherencia final exacto en los
> 3 fondos. Ver sección 5.
>
> 🟢 **Paso 4 (export `.xlsx` para el estudio) — commiteado y corrido contra el dato real.** Extensión
> de `extraer-posiciones.ts` + `simular-fondo.ts`/`armar-libro-fci.ts` nuevos (commit `6320972`, 14
> tests nuevos) más el script de orquestación genérico `packages/ingesta/scripts/exportar-fci.ts`
> (recibe todo por `--config`, nunca datos de cliente en el repo). Corrida real contra los 3 PDF de
> Elite-IT: las 5 predicciones falsables cumplidas exacto. `SendUserFile` se evaluó como canal de
> entrega y se **descartó** por incompatibilidad de retención — ver sección 6.
>
> 🟡 **Bloqueado, esperando a Laura.** Las 9 preguntas de la sección "Pendiente" se enviaron
> (ronda 3, `.docx`, fuera del repo) el **2026-08-22**. Hasta que conteste, no hay más trabajo de
> **diseño** posible en FCI — el export del Paso 4 no dependía de esas respuestas (es un entregable
> sobre la mecánica ya validada, no una decisión de negocio nueva) y por eso pudo cerrarse igual. Ver
> "Bloqueado, explícitamente" más abajo para qué depende de qué.

## Contexto

Laura (contadora del estudio) necesita que el sistema calcule el costo PEPS ("primero entrado,
primero salido") de los rescates de cuotapartes de Fondos Comunes de Inversión: cada rescate consume
capas de costo — cada capa nace de una suscripción o del saldo de apertura del ejercicio — de la más
vieja a la más nueva, y puede tocar más de una capa en un mismo rescate. El caso real que motivó este
paso: un rescate que no se cubre con una sola capa y se reparte en la siguiente, verificado a mano
contra un Excel real de la contadora — las cifras concretas de ese caso real no viven en este
documento ni en el repo (barrido de fuga, ADR-0002 §F.2); los tests que lo reproducen usan cantidades
sintéticas con la misma estructura.

El cliente de prueba es **Elite-IT SAS** — fuera del piloto, sin tenant en la base — autorizado bajo
`docs/seguridad/registro-excepciones.md` **E-2** (ver esa entrada para el detalle de la autorización
y el método reforzado: cero fragmentos de texto real en el contexto de ningún agente, solo
booleanos/categorías, scripts efímeros mostrados antes de correr y borrados después).

## 1. El núcleo puro (`packages/fci`) — paso 1

### Qué se construyó

- **Paquete nuevo `packages/fci`**, núcleo puro, sin dependencia de `data`/`ingesta`/`almacenamiento`
  (mismo patrón que `packages/contabilidad/src/nucleo` — ver R-B/R-G/R-J en
  `packages/data/tests/reglas-de-codigo.test.ts`):
  - `src/nucleo/aritmetica.ts` — utilidad de **punto fijo** propia sobre `bigint`, escala de 6
    decimales (tipo nominal `PuntoFijo = bigint & { marca }`). Expone `aPuntoFijo`, `formatear`,
    `sumar`, `restar`, `comparar`, `esCero`, `minimo`, `multiplicar`. Sin librería decimal externa: el
    repo no tenía ninguna utilidad de este tipo (CLAUDE.md §2 prohíbe `number` de JS para importes) y
    agregar una dependencia no es decisión de quien escribe el código de dominio — corresponde a
    `dba-data` + `security-engineer`, y solo si aparece un caso real de pérdida de precisión (nunca
    pasó en esta ronda).
  - `src/nucleo/tipos.ts` — `CapaFCI` (con `id` y `fecha` como identidad estable y clave de orden),
    `ItemConsumo`, `ResultadoConsumo`, y el rol funcional emitido como **dato**: `RolFCI`, unión
    cerrada de exactamente **dos** valores — `'inversiones_fci' | 'resultado_rescate_fci'` — nunca
    resuelto a cuenta contable por este núcleo.
  - `src/nucleo/consumirRescate.ts` — la función central: recorre `capasOrdenadas` (ya ordenadas por
    quien llama) consumiendo cada capa hasta agotarla o hasta agotar `cantidadARescatar`. Nunca agrega
    el resultado entre capas. Si la cantidad pedida excede el remanente total, `cantidadSinCubrir`
    queda en lo que faltó, **siempre presente** en el resultado. Valida sus entradas y rechaza con
    `ConsumoInvalidoError` (motivo cerrado, nunca el dato recibido en el mensaje) ante: capas fuera de
    orden PEPS por `fecha`, cantidad a rescatar negativa, precio de rescate negativo, o cualquier
    campo negativo dentro de una capa.
  - `tests/consumirRescate.test.ts` (13 casos) y `tests/aritmetica.test.ts` (21 casos) — incluyen el
    caso real de rescate partido en 2 capas (cifras sintéticas, estructura real), un caso de rescate a
    pérdida, y el empate exacto de redondeo en ambos signos.
- **Barrido de arquitectura**: filas espejo de R-B, R-G y R-J para `packages/fci` en
  `packages/data/tests/reglas-de-codigo.test.ts`, igual que ya existen para `packages/contabilidad`.
- **Truncamiento en `multiplicar`, documentado y testeado**: la división entera de `bigint` en
  JavaScript trunca hacia cero, nunca redondea. Ejemplo real del comentario: `1.000003 × -1.5 =
  -1.500004` (no `-1.500005`). Decisión explícita (redondear es negocio, no aritmética), verificada a
  mano.

### Los dos roles que SÍ están creados, y los dos que NO — y por qué

| Rol | Estado | Por qué |
|---|---|---|
| `inversiones_fci` | ✅ Creado | Lo usa `consumirRescate` hoy — activo de tenencia. |
| `resultado_rescate_fci` | ✅ Creado | Lo usa `consumirRescate` hoy — resultado del eje 2 (ganancia/pérdida del rescate). |
| `diferencia_fci_a_devengar` | ❌ Afuera | Pertenece al eje 3 (valuación al cierre). Meterlo ahora fijaría en código un mecanismo de devengamiento que Laura todavía no confirmó (pregunta 1) — se agrega junto con el cálculo que lo use, no antes. |
| `resultado_tenencia_fci` | ❌ Afuera | Mismo motivo — depende de la pregunta 1, y de la 2 (signo negativo) y la 9 (posible cuarto componente). |

`plan-cuentas-multicliente` había catalogado un universo de **5** roles posibles (ver su dictamen
completo, sección 2, más abajo); el usuario recortó a los **2** que `consumirRescate` toca de verdad, con el
criterio explícito de "no rellenar un tipo cerrado para no volver a tocarlo después" — los otros 3
quedan fuera de este código hasta que el eje 3 se diseñe.

### Bug real encontrado y corregido en esta pieza (ronda de revisión 1)

`tester` y `code-reviewer` (independientemente) confirmaron con casos ejecutados que:
- Capas pasadas **fuera de orden** producían un costo PEPS **invertido, sin ningún error** — "basura
  silenciosa" en un motor fiscal.
- Cantidades **negativas** (capa o rescate) producían un `cantidadSinCubrir` mayor que lo pedido, sin
  ningún error tampoco.

Corregido: `consumirRescate` ahora valida orden PEPS por `fecha` y rechaza cualquier campo negativo,
con `ConsumoInvalidoError` y su motivo cerrado — nunca el dato recibido en el mensaje.

### Qué se mide

- `pnpm vitest run packages/fci packages/data/tests/reglas-de-codigo.test.ts` → **verde** (medido de
  forma independiente, no solo el reporte del agente que implementó).
- `pnpm typecheck` limpio.

### Predicción falsable (todavía vigente para este núcleo)

| Si sale... | Significa... |
|---|---|
| Capas pasadas fuera de orden por `fecha` | `consumirRescate` rechaza con `ConsumoInvalidoError('orden_no_peps')` — nunca calcula un costo PEPS invertido en silencio |
| `cantidadARescatar` excede la suma de remanentes | `cantidadSinCubrir` trae exactamente lo que faltó — nunca se inventa una capa ni se completa con precio 0 |
| Una capa o el rescate trae un valor negativo | Se rechaza con el motivo específico del guard |
| `multiplicar` opera sobre un empate exacto | Trunca hacia cero en ambos signos — documentado, no un bug |
| Aparece un caso real de pérdida de precisión con la aritmética actual | Recién ahí se convoca a `dba-data` + `security-engineer` — nunca antes |
| Se agrega un tercer rol funcional sin que Laura confirmara el mecanismo | Decisión de negocio inventada — no debería pasar revisión |

## 2. Los 4 dictámenes originales, completos (no solo su mención)

Convocados **antes de escribir código**, en modo plan (CLAUDE.md §3.2). Cada uno es un `Agent()` real
y separado — verificado en esta misma sesión que los 23 subagentes del roster son reales y distintos
(ver `agents/README.md`, sección "Registro runtime vs. disco", confirmación 2026-08-22).

### `arquitecto-software` — dónde vive el motor de capas

**Decisión: paquete propio `packages/fci`, no una carpeta dentro de `packages/contabilidad`.**
`packages/contabilidad/src/nucleo` vive bajo tres invariantes verificados por test de arquitectura:
sin SQL (R-G), síncrono y sin `Promise` (R-J), y lo externo entra como argumento ya resuelto (R-B). El
motor de reconocimiento clasifica un movimiento contra un léxico — sin estado entre movimientos. FCI
necesita lo contrario: leer capas abiertas **acumuladas en el tiempo** y consumirlas de la más vieja a
la más nueva. Es un componente de naturaleza distinta, no una extensión del matcher.

El límite copia el par ya establecido `contabilidad` ↔ `packages/data/src/contabilidad/*`:
`packages/fci/src/nucleo` (puro) + `packages/data/src/fci/{lecturas,escrituras}.ts` (orquestación
transaccional, tarea futura) — con el mismo mecanismo de tipos espejados que ya usa `contabilidad`
para no importar `data` directo.

`consumirRescate` reusa la **forma** de `repartirFIFO`
(`trazabilidad-obra-gas/src/services/conciliacion/imputacion-service.ts`: recorrer buckets ordenados,
consumir con remanente, un ítem por bucket tocado) pero **no su aritmética** — esa función usa
`number` de JS con redondeo manual, lo cual viola la regla dura de este repo.

**Contrato con Capa D: bloqueado, a propósito.** FCI no resuelve `cuenta_id`. Sin Capa D no hay ni un
`plan_cuenta` real contra el cual testear un `ResolverCuentaPorRol` — construirlo ahora sería cablear
una suposición.

**Esquema: no en esta tarea.** El paso revertible más chico es el núcleo 100% en memoria, sin
migración — mismo criterio que `docs/diseno/12-cotizacion-bna-plan.md`.

### `plan-cuentas-multicliente` — roles funcionales y resolución de cuenta

**Catálogo completo de roles identificado: 5** (no solo los 2 que terminaron en el código):
`inversiones_fci` (activo — tenencia), `diferencia_fci_a_devengar` (activo — devengamiento),
`resultado_rescate_fci` (resultado), `resultado_tenencia_fci` (resultado — **un solo rol, no dos por
signo**: el signo lo produce el cálculo, no la resolución de cuenta), y el rol implícito "sin cuenta
FCI-específica" para el cliente que no distingue nada.

`diferencia_fci_a_devengar` se declara en el catálogo conceptual con estado
`tratamiento: pendiente_de_definición` — el rol existe como concepto, el mecanismo no.

**Un rol sin resolver nunca falla en silencio ni cae a un default hardcodeado.** Dos estados válidos:
resolución explícita del cliente (una cuenta específica, o una genérica que el cliente designó), o
`pendiente` en cola de revisión humana — nunca un fallback implícito del sistema que nadie configuró.

**Contrato mínimo, sin construir Capa D entera:**
```
ResolverCuentaPorRol(clienteId, rolFuncional, fecha)
  -> { estado: "resuelto", cuentaId }
   | { estado: "pendiente", motivo: "sin_configuracion" | "rol_no_aplicable" | "plan_no_cargado" }
```
Nunca `cuenta_id | null` — `null` pierde el motivo. Declarar esta interfaz ahora desacopla el motor de
que Capa D no exista todavía; la implementación real (plan versionado por cliente) queda para cuando
el modelo cliente-con-atributos-versionados exista en esquema.

**Es caso general, no específico de Elite-IT**: la asimetría de "no hay cuenta FCI-específica para
resultado negativo" en el plan de cuentas real de Elite-IT no se generaliza como regla — el modelo
permite tanto una cuenta compartida por signo como dos cuentas separadas, sin asumir cuál rige.

### `contador-dominio` — validación contable del modelo de capas

Verificó `knowledge/` antes de responder: **vacío** (`sources_status: esqueleto-sin-contenido`) — por
guardrail, no cita ningún número de norma ni de RT; lo que sigue es criterio de diseño de partida
doble, no una afirmación normativa.

1. El modelo de capas (costo conocido/desconocido, `costoEstimado` cuando toca una capa de apertura
   sin precio) es correcto como mecánica de costeo PEPS. Falta, desde trazabilidad: el asiento que
   toque una capa estimada debería llevar una **referencia explícita en el detalle/glosa** ("incluye
   capa de apertura con costo estimado"), y si el estudio quiere trazabilidad fuerte, una **cuenta
   puente** en vez de cargar directo mezclado con resultado firme — criterio de diseño, no normativo.
2. Que `4.1.2.400` (resultado del rescate, en el plan real de Elite-IT) sea una cuenta **compartida**
   con otros instrumentos es práctica común, no una señal de plan subdividido de menos. El motor no
   debe asumir exclusividad de la cuenta: el detalle por instrumento va en el auxiliar/comprobante,
   aunque la cuenta sea compartida.
3. Un rescate `parcialmente_estimado` que luego se conoce (la contadora carga el costo real de la
   capa de apertura): con el período **abierto**, corregir el asiento ya cargado es razonable; con el
   período **cerrado**, el criterio general de cambio de estimación contable es **prospectivo** — se
   reconoce la diferencia en el período en que se conoce, no se reabre el asiento anterior (criterio
   general, sin cita de RT — no cargada).
4. **Hallazgo nuevo, no en el diseño original**: el plan de cuentas real de Elite-IT muestra que el
   eje 3 no es un solo cálculo — hay al menos dos estados (diferencia no devengada / devengada), y
   `4.1.2.700 Intereses ganados FCI` sugiere un **posible cuarto componente** (rendimiento/
   distribución del fondo) distinto de los tres ejes ya modelados. No se resuelve acá — pasó a ser la
   **pregunta 9** para Laura.

Cierra con: *validar con profesional matriculado*.

### `dba-data` — esquema y persistencia

1. **Sin tabla es el paso correcto.** Verificar contra 3 extractos reales es un problema de lógica de
   asignación PEPS, no de durabilidad — se prueba con fixtures y un snapshot en memoria. Persistir sin
   haber validado el algoritmo invierte el orden: construir el invariante de base sobre una regla de
   negocio todavía no verificada.
2. **Esbozo de esquema para cuando llegue el momento** (NO aplicado en esta ronda): `fci_capa_costo`
   (`cantidad_original numeric(18,6)`, `cantidad_remanente numeric(18,6)`, `precio_unitario_origen
   numeric(18,6)`, `origen`, `costo_conocido`, + los 7 renglones de ADR-0001 §5) y
   `fci_rescate_consumo` (FK compuesta `(cliente_id, capa_id)`, `cantidad_tomada numeric(18,6)`).
   **Escala `numeric(18,6)` marcada como estimación, no medida** — el descubrimiento de formato de la
   sección 4 (abajo) sí midió esta escala contra los 3 PDF reales y la **confirmó exacta** (6
   decimales para cuotapartes).
3. **Vive en `packages/data` junto al resto** — es dato del cliente como cualquier otro, no un
   catálogo N0 sin tenant como `cotizacion_bna`.
4. **Hueco señalado, no cerrado**: no está definido si `fci_rescate_consumo` es *append-only* o
   *mutable* cuando un rescate se recalcula — convocar `contador-dominio` + `analista-funcional` antes
   de escribir el esquema real, para no decidir la forma de la tabla dos veces.

## 3. El paso revertible más chico — historia completa

El primer commit real fue el núcleo puro: `packages/fci/src/nucleo/{tipos.ts,aritmetica.ts,
consumirRescate.ts}` + sus tests + las filas espejo en `reglas-de-codigo.test.ts` —
**commiteado** (`a1189e2`, `9de816c`; el fixup de la ronda de revisión fue parte del mismo commit
inicial). Reversible en su momento con un `rm -rf packages/fci`, sin tocar ninguna base: no había
migración que deshacer. Los pasos siguientes (2 y 3) se hicieron cada uno con su propio commit.

## 4. Verificación del eje 1 contra los 3 extractos reales (Elite-IT) — paso 2, cerrado

**Descubrimiento de formato** (4 pasadas de scripts efímeros, metadatos únicamente — conteos,
longitudes, coordenadas geométricas, histogramas de cantidad de decimales, nunca un fragmento de
texto): confirmó que Galicia usa 6 decimales para cantidades de cuotapartes y 2 para importes en
pesos, y una tabla de posición compacta con 4 campos por fondo en columnas geométricas estables entre
los 3 archivos.

**Dos correcciones del titular sobre la semántica**, ninguna adivinable por metadatos:

1. La tabla de posición trae, por fondo, **una sola tenencia** (cantidad de cuotapartes a ese corte) —
   no "anterior" y "actual" en la misma fila. El tercer campo numérico de la fila (7-8 dígitos
   enteros) no es una cantidad: es el saldo **valorizado en pesos** (tenencia × cotización), y no
   participa del eje 1. La hipótesis inicial del extractor comparaba una cantidad de cuotapartes
   contra un importe en pesos — de ahí que el consolidado no cerrara en el primer intento.
2. **El invariante se verifica ENTRE documentos, no dentro de uno solo.** El `saldoInicial` de un
   corte es la tenencia declarada del mismo fondo en el corte inmediato anterior — hay que traerla del
   PDF previo, no de este documento. Por eso junio (el primer corte del lote) no tiene con qué
   verificarse: necesitaría el extracto de mayo, que no forma parte de este lote de 3 archivos.

**Resultado, con `packages/ingesta/src/fci-galicia/{aritmetica-posicion.ts,verificar-posicion.ts,
extraer-posiciones.ts}`** (extractor PRELIMINAR, no el adapter oficial — ver "Bloqueado" abajo):

| Corte | Consolidado | Por fondo |
|---|---|---|
| 2025-06-30 | No verificable con este lote (falta el corte de mayo) — estructural, no bug | No verificable |
| 2025-07-31 | **Cierra exacto** | **Cierra exacto en los 3 fondos** |
| 2025-08-29 | **Cierra exacto** | **Cierra exacto en los 3 fondos** |

### El verificador puro (`verificar-posicion.ts`) y el bug real de signo invertido

Antes de tocar ningún PDF, se escribió y commiteó el verificador puro: `verificarPosicionFondo`
compara `saldoInicial + Σsuscripciones − Σrescates` contra la tenencia **declarada**, tolerancia cero,
y si no cierra devuelve solo una categoría acotada del delta (`'<0.01' | '0.01-1' | '>1'`) — **nunca
el delta exacto, nunca un valor real**, regla de seguridad de datos de E-2, no de diseño.

Revisión paralela de 4 agentes (`seguridad-datos-financieros`, `qa-automation`, `code-reviewer`,
`tester`) sobre la primera versión encontró, los 4 de forma independiente, el mismo problema:

> **Las cantidades de entrada aceptaban signo negativo sin validar.** `code-reviewer` lo demostró
> ejecutando el código: `verificarPosicionFondo({ saldoInicialDeclarado: '100.000000', rescates:
> ['-10.000000'], tenenciaFinalDeclarada: '110.000000' })` devolvía `{ cierra: true }` — un rescate
> cargado con el signo invertido (error típico de extracción de PDF: convención de signo del
> documento, o un menos tipográfico mal interpretado) hacía que el invariante **"cerrara" sobre un
> documento que en los hechos no cierra**. Es la misma clase de falla silenciosa que ya motivó la
> regla dura de CLAUDE.md §3.2(c) (el caso `galicia.ts` truncando razón social) — un verificador que
> existe específicamente para detectar discrepancias, no detectándola.

**Corregido**: la aritmética de este módulo (`aritmetica-posicion.ts`) rechaza cualquier signo en el
parseo — las cantidades de FCI (saldo, suscripción, rescate, tenencia) nunca son negativas en este
dominio, el signo de la OPERACIÓN (sumar o restar) ya lo decide la fórmula, nunca el texto de origen.
Con el fix: 13 tests, incluidos los 2 bordes de categoría y la propagación de error a través de la
función completa.

### La atribución por fondo — tres intentos, el tercero resuelto

**Intento 1 — heurística de eliminación** (sin segmentación): comparar la tenencia de cada fondo
contra el corte anterior; si exactamente 1 cambió, atribuirle todos los movimientos del corte.
Funcionó para julio (1 solo fondo activo ese mes) pero no servía para agosto (los 3 cambiaron a la
vez) — quedaba, a propósito, como limitación documentada, no forzada.

**Intento 2 — segmentación heurística, sin patrón literal**: reconocer el encabezado de sección por
forma genérica (fragmentos sin fecha/número/palabra clave). Produjo una **regresión real**: julio
dejó de cerrar en 2 de los 3 fondos, agosto solo capturó 4 de ~21 movimientos reales. **Descartado a
pedido explícito del titular** — la indicación, sin ver el documento, no alcanzaba para reconstruir el
patrón; seguir afinándolo a ciegas era scope creep sobre la tarea. Queda como decisión documentada,
no como código borrado sin rastro: el intento 2 nunca se commiteó.

**Intento 3 — patrón literal exacto, dado por el titular: confirmado.** El titular especificó el
patrón real de plantilla del banco (confirmado explícitamente como NO siendo dato de cliente):
`FONDO - <nombre> CLASE <letra>` delimita cada bloque de movimientos, y debajo viene la cabecera de
columnas repetida (Fecha de concertación / Descripción / Cantidad de Cuotas / Valor / Monto Neto de
la Operación / Fecha de Liquidación). El orden de los bloques **no alcanza** para unirlos con la tabla
de posición: un fondo sin ningún movimiento en el corte directamente NO imprime su bloque (confirmado
por conteo: julio tiene 1 solo encabezado real, junio y agosto tienen 3). La unión final es por el
**nombre** capturado en el encabezado — pero tampoco por igualdad exacta: ese nombre es una versión
ABREVIADA del nombre completo de la tabla de posición (medido: ~12 caracteres contra ~20-25), así que
se unen por "uno contiene al otro" sobre las claves normalizadas (nunca expuestas, ni siquiera
internamente registradas en ningún log). Con este método: **julio y agosto cierran exacto en los 3
fondos.**

Revisión de `code-reviewer` sobre la versión final del patrón literal encontró y corrigió dos riesgos
más antes de cerrar: (1) un bloque repetido por salto de página (mismo fondo, cabecera reimpresa)
creaba un segundo grupo y perdía los movimientos de la continuación — se fusiona por clave exacta
antes de crear un grupo nuevo; (2) una coincidencia "contiene" ambigua (dos fondos con prefijo de
familia en común) se resolvía en silencio con el primer candidato — ahora lanza
`AtribucionFondoAmbiguaError` en vez de adivinar. Ninguno de los dos casos ocurre en los 3 PDF reales
medidos, pero quedan cubiertos.

## 5. `consumirRescate` contra la secuencia real de movimientos — paso 3, cerrado

Objetivo final de la ronda (pedido explícito del titular): correr el núcleo PEPS del paso 1 contra los
movimientos reales extraídos en el paso 2, encadenando los 3 cortes, para ver la mecánica completa
funcionar de punta a punta contra datos reales — **no** para comparar contra el número exacto de
Laura (ese número no está disponible en esta sesión, ni podría estarlo: es un dato real de un
cliente, y el método de E-2 nunca expone valores, solo booleanos y conteos).

**Extensión necesaria del extractor**: cada movimiento ahora trae, además de la cantidad, su
**precio** (cotización de esa operación) y su **fecha** (resuelta a ISO vía `parsearFecha` de
`parseo-ar.ts`), en un campo `movimientos` que preserva el ORDEN de documento — `consumirRescate`
exige capas en orden cronológico y lo valida él mismo.

**Capa de apertura**: para junio (sin corte previo en el lote), la cantidad que había ANTES de sus
propios movimientos capturados se calcula por aritmética (`tenencia declarada en junio − suscripciones
de junio + rescates de junio`) y se modela como una capa con **precio `0` explícito y
`costoConocido: false`** — nunca una estimación disfrazada de precio real, mismo criterio que fijó
`contador-dominio` en el paso 1.

**Resultado, simulando junio→julio→agosto para los 3 fondos:**
- **Cero errores** (`ConsumoInvalidoError`) en ningún rescate de ningún fondo.
- El fondo con más actividad reprodujo el mecanismo que motivó todo el subsistema: **varios rescates
  partidos entre múltiples capas** (hasta **6 capas** tocadas en un solo rescate) — el mismo patrón
  del caso real de Laura (`C9 = -20352.01 - C6` en su Excel).
- **Chequeo de coherencia final, en los 3 fondos**: la suma de remanentes de capas al final de la
  simulación coincide EXACTO con la tenencia declarada en el extracto de agosto — confirma que la
  mecánica completa (capas, consumo PEPS, capa de apertura) es consistente con el eje 1 ya validado.

Revisión de `code-reviewer` sobre la extensión del extractor corrigió tres puntos antes de cerrar: los
agregados de cantidad (el eje 1) se calculan directo de las filas crudas, nunca a través de
`movimientos` — un problema de fecha en un fondo no debe tumbar ese cálculo, ni el de otro fondo;
`movimientos` se valida monótono por fecha antes de exponerse, aislado por fondo
(`movimientosConfiables: false` si no, nunca un orden dudoso en silencio); y se agregó el rango de `x`
medido para el fragmento de precio, que faltaba.

**En ningún momento de todo el paso 3 salió un valor real** (cantidad, precio, resultado de PEPS) al
contexto de ningún agente ni a ningún documento — todo lo de arriba son booleanos, conteos y
comparaciones de igualdad, tal como exige el método reforzado de E-2.

## 6. Export `.xlsx` para el estudio — paso 4, cerrado

**Contexto.** Con el eje 1 (sección 4) y `consumirRescate` contra la secuencia real (sección 5) ya
commiteados, el objetivo de esta sesión fue producir un entregable concreto para el estudio: un libro
Excel con el costeo PEPS de los 3 fondos de Elite-IT, corte a corte. Plan formal en modo plan (CLAUDE.md
§3.2, disparado por §3.2(c) — modifica un extractor que ya corre contra dato real— y §3.2(d) — más de 3
archivos).

**Re-verificación previa, no rediseño.** Antes de tocar código, se corrió de nuevo (script efímero,
método reforzado de E-2) la atribución por fondo de la sección 4: mismo resultado — 3 encabezados en
junio y agosto, 1 en julio, eje 1 exacto en los 3 fondos julio y agosto. Confirma que la sección 4
sigue vigente, no la reemplaza.

### Qué se construyó

- **`extraer-posiciones.ts` extendido**: captura `cotizacionDeclarada`/`valorizadoDeclarada` — dos
  campos que el extractor ya reconocía y validaba (son parte de la fila de 4 campos de la sección 4)
  pero descartaba al armar el resultado. Necesarios para que el libro muestre la cotización de cada
  corte, no solo la cantidad.
- **`simular-fondo.ts`** (nuevo, puro): encadena `consumirRescate` (paquete `packages/fci`, sección 1)
  corte a corte para un fondo, reusando exactamente la mecánica ya validada en la sección 5 — no
  reimplementa PEPS, orquesta el núcleo ya cerrado.
- **`armar-libro-fci.ts`** (nuevo, puro): arma el `ExcelJS.Workbook` — una hoja por fondo + una hoja
  Resumen consolidada. Columna "Estimado" (por fila) / "Incluye estimados" (por hoja) para que el
  estudio distinga, sin ambigüedad, un costo real de uno que arrastra la capa de apertura sin precio
  conocido (mismo criterio `costoConocido: false` fijado por `contador-dominio` en la sección 1).
- **14 tests nuevos** entre `fci-galicia-extraer-posiciones.test.ts` (7), `fci-galicia-simular-fondo.test.ts`
  (4) y `fci-galicia-armar-libro.test.ts` (3) — medido contra el commit real, no solo reportado.
- **`packages/ingesta/scripts/exportar-fci.ts`**: el único archivo que en runtime toca `privado/` —
  por regla (CLAUDE.md §3.1.3), ningún agente lo toca, lo escribe quien conduce. Es **genérico**:
  recibe rutas de PDF, fechas de corte y etiqueta de salida por `--config <archivo.json>`; el config
  real con los datos de Elite-IT vive en `privado/` (gitignorado), nunca en el repo. Esto corrige un
  primer intento (`exportar-fci-elite-it.ts`, con el nombre del cliente y rutas reales hardcodeadas en
  el propio código) que `security-engineer` señaló como fuera del alcance que E-2 autoriza para código
  que sí se commitea — ese archivo se descartó antes de llegar a un commit (no aparece en el historial
  de git).

### Revisión

`code-reviewer` encontró, sobre el script de orquestación, dos hallazgos bloqueantes: faltaba el
chequeo de `movimientosConfiables` (riesgo de descartar movimientos en silencio si un fondo quedó con
`movimientos: []` por fecha no monótona — ver sección 5) y la marca `costoEstimado`/`parcialmenteEstimado`
que devuelve `consumirRescate` se perdía al armar el export, sin forma de que el estudio distinguiera un
resultado real de uno estimado. Ambos corregidos, más hallazgos menores (todos corregidos) y, tras
genericizar el script, un hallazgo adicional no bloqueante: el orden cronológico de `config.cortes` no
se verificaba antes de simular — corregido también (el script aborta si no viene ascendente).
`seguridad-datos-financieros` y `security-engineer` revisaron en paralelo: sin hallazgos bloqueantes —
confirmaron que la salida por consola es solo booleanos/conteos/rutas (nunca un valor real), que no
hace falta entrada nueva en `clasificacion-campos.ts` (sin persistencia, Capa D sigue bloqueada), y que
la carpeta de salida está cubierta por `/privado/` en `.gitignore`.

### Commit y corrida real

**Commit `6320972`** (9 archivos: `exportar-fci.ts`, `armar-libro-fci.ts`, `simular-fondo.ts`,
`extraer-posiciones.ts`, los 3 archivos de test, `package.json`, `pnpm-lock.yaml`) — a `main`, con
`pnpm typecheck` limpio y `pnpm vitest run packages/ingesta/tests packages/fci
packages/data/tests/reglas-de-codigo.test.ts` en verde (37 test files / 799 tests, medido de forma
independiente). Commiteado **antes** de correr contra el dato real, mismo orden que las secciones 4 y 5.

**Corrida real** (quien conduce, no un agente — `privado/` está prohibido para todo agente):
`privado/extractos/Sistematizacion Conciliacion Bancaria/FCI/export/fci_elite-it_junio-agosto-2025.xlsx`.

### Predicción falsable — las 5, cumplidas exacto

| Predicción | Resultado |
|---|---|
| `cantidadConsistenteEntreCortes` | `true` |
| `movimientosConfiables` en los 3 fondos × 3 cortes | `true` en todos |
| `rescatesConSinCubrir` | `false` |
| Conteo de filas por hoja | `[3, 3, 42]` — idéntico a lo ya medido en la sección 4 |
| `incluyeEstimados` | `false` |

### `SendUserFile`: evaluado y descartado, no "no hacía falta"

Se evaluó entregar el `.xlsx` al usuario con la herramienta `SendUserFile` del harness. Se
**descartó explícitamente** — `security-engineer` confirmó, citando `code.claude.com/docs/en/data-usage`
y `.../tools-reference`, que esa herramienta pasa el archivo por infraestructura de Anthropic
(transcript sincronizado, retención estándar ~30 días, sin mecanismo de borrado propio del estudio
salvo Zero Data Retention no verificado para esta cuenta) — incompatible con el TTL de 7 días que
`docs/seguridad/registro-excepciones.md` fija para exports N2-R (mismo criterio que ya usa la sección
"Exports N2-R declarados" de ese archivo, aplicado acá aunque este flujo no pasa por
`pnpm exportar:excel`). El usuario decidió entregar solo el path local — el archivo ya está en su disco,
sesión CLI local — y que la evaluación quede registrada como decisión tomada, no como "no hizo falta".
Addendum completo: `docs/seguridad/registro-excepciones.md` §E-2.

## Bloqueado, explícitamente — qué depende de qué

| Bloqueado | Por qué (la causa real, no solo "falta Laura") |
|---|---|
| **Capa D** (plan de cuentas por cliente, versionado) | **No existe el modelo** — no hay ninguna migración de plan de cuentas ni de cliente-con-atributos-versionados en el repo hoy. No es "falta la respuesta de Laura": es una pieza de arquitectura entera sin construir, con su propia convocatoria (`arquitecto-software` + `dba-data` + `plan-cuentas-multicliente`) cuando se decida arrancarla. |
| **Eje 3** (valuación al cierre / devengamiento) | Depende directo de las preguntas **1** (mecanismo de devengo), **2** (convención de signo negativo) y **9** (si `4.1.2.700` es un cuarto componente) — ninguna se puede inventar sin romper la regla dura de "nunca una decisión de negocio no confirmada". |
| **Adapter oficial de ingesta** (`contrato.ts`/`esquema.ts`/`persistir.ts`, como Galicia/Santander/Macro) | Depende de que Capa D exista (el adapter necesita saber a qué cuenta imputar) — y de que se resuelva la atribución por fondo para meses con más de un fondo activo simultáneamente de forma reusable (el extractor de esta ronda es preliminar, con rangos de `x` medidos contra solo 3 archivos). |
| **Persistencia de capas** (`fci_capa_costo`, `fci_rescate_consumo`) | Esbozada por `dba-data` (sección 2) pero no medida contra un caso de recálculo real — falta decidir si `fci_rescate_consumo` es append-only o mutable, con `contador-dominio` + `analista-funcional`. |

## Pendiente — 9 preguntas para Laura: ENVIADAS, esperando respuesta

**Enviadas el 2026-08-22** (ronda 3, documento `.docx`, fuera del repo — no en esta sesión de código).
No se responden acá: son decisiones de negocio que le corresponden a la contadora, no a quien
documenta ni a quien implementa. Hasta que conteste, no hay más trabajo de diseño posible en FCI (ver
"Bloqueado, explícitamente" arriba).

1. Mecanismo de "Dif. Cotizac. FCI a devengar" → "Resultado por tenencia FCI": ¿es un paso separado o
   una imputación directa?
2. Resultado por tenencia negativo: ¿cuenta genérica, o alguna otra convención?
3. Saldo inicial sin capas de costo: ¿de dónde sale ese dato hoy?
4. ¿Algún cliente tiene FCI en dólares?
5. Retenciones o comisiones sobre FCI en otros bancos que no sean Galicia (confirmado: en Galicia no
   hay).
6. Traspasos entre fondos o reinversión automática de renta, en otros clientes o bancos.
7. Asiento de reimputación del eje 2: ¿uno por rescate, o uno mensual consolidado por fondo?
8. Elite-IT: ¿alta de tenant nueva, o análisis acotado a una auditoría puntual?
9. `4.1.2.700 Intereses ganados FCI`: ¿es un cuarto componente distinto de los tres ejes ya
   identificados, o entra dentro de alguno de ellos? (pregunta agregada por `contador-dominio`, no
   estaba en la ronda original del titular).

## Pendiente — no bloqueante, para el próximo paquete con el mismo patrón

Sugerencia de `code-reviewer`: deduplicar las filas espejo de R-B/R-G/R-J en
`reglas-de-codigo.test.ts` con un generador, en vez de copiar el bloque a mano cada vez. Vale la pena
cuando entre un tercer paquete con este mismo patrón (núcleo puro sin SQL, sin async, sin importar
`data`) — no ahora, con solo dos.

## Cómo retomar esto, en una frase

**Nada que hacer en FCI hasta que Laura conteste la ronda 3.** Cuando conteste: releer las 9
preguntas de arriba con sus respuestas, actualizar esta misma sección (no crear un doc nuevo), y
recién ahí decidir si arranca el eje 3, Capa D, o el adapter oficial — en ese orden de dependencia,
según la tabla de "Bloqueado, explícitamente".
