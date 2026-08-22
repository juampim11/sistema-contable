# 17 — Costeo PEPS de Fondos Comunes de Inversión: núcleo puro (paso 1 de N)

> 🟢 **PASO IMPLEMENTADO Y VERIFICADO — sin commitear todavía.** `packages/fci/` existe en el
> filesystem (núcleo puro: `consumirRescate` + aritmética de punto fijo + sus tests), sin migración,
> sin persistencia, sin Capa D, sin adapter de PDF. Es el "paso revertible más chico" de un plan más
> grande que sigue abierto — ver la sección 5 y "Qué queda pendiente" al final.

## Contexto

Laura (contadora del estudio) necesita que el sistema calcule el costo PEPS ("primero entrado,
primero salido") de los rescates de cuotapartes de Fondos Comunes de Inversión: cada rescate consume
capas de costo — cada capa nace de una suscripción o del saldo de apertura del ejercicio — de la más
vieja a la más nueva, y puede tocar más de una capa en un mismo rescate. El caso real que motivó este
paso: un rescate que no se cubre con una sola capa y se reparte en la siguiente, verificado a mano
contra un Excel real de la contadora — las cifras concretas de ese caso real no viven en este
documento ni en el repo (barrido de fuga, ADR-0002 §F.2); el test que lo reproduce usa cantidades
sintéticas con la misma estructura (ver `packages/fci/tests/consumirRescate.test.ts`).

No existe hoy en el repo ningún mecanismo para este cálculo. Este paso arranca el subsistema por el
núcleo — la mecánica de consumo de capas, sin decidir nada de dónde salen los datos ni a qué cuenta
contable van — porque es la parte que se puede fijar con certeza hoy, y todo lo demás (persistencia,
lectura del extracto, mapeo a cuenta) depende de decisiones que todavía no están tomadas (ver las 9
preguntas abiertas, sección "Pendiente").

## 1. Qué cambia y qué no

### Cambia

- **Paquete nuevo `packages/fci`**, núcleo puro, sin dependencia de `data`/`ingesta`/`almacenamiento`
  (mismo patrón que `packages/contabilidad/src/nucleo` — ver R-B/R-G/R-J más abajo):
  - `src/nucleo/aritmetica.ts` — utilidad de **punto fijo** propia sobre `bigint`, escala de 6
    decimales (tipo nominal `PuntoFijo = bigint & { marca }`, para que un `bigint` cualquiera —un id,
    un contador— no se cuele donde se espera un importe ya escalado). Expone `aPuntoFijo`,
    `formatear`, `sumar`, `restar`, `comparar`, `esCero`, `minimo`, `multiplicar`. Sin librería decimal
    externa (`decimal.js` o similar): el repo no tenía ninguna utilidad de este tipo (CLAUDE.md §2
    prohíbe `number` de JS para importes) y agregar una dependencia nueva no es una decisión de quien
    escribe el código de dominio — corresponde a `dba-data` + `security-engineer`, y solo si aparece
    un caso real de pérdida de precisión (ver la decisión explícita en "Predicción falsable").
  - `src/nucleo/tipos.ts` — `CapaFCI` (con `id` y `fecha` como identidad estable y clave de orden),
    `ItemConsumo`, `ResultadoConsumo`, y el rol funcional emitido como **dato**: `RolFCI`, unión
    cerrada de exactamente **dos** valores — `'inversiones_fci' | 'resultado_rescate_fci'` — nunca
    resuelto a cuenta contable por este núcleo.
  - `src/nucleo/consumirRescate.ts` — la función central: recorre `capasOrdenadas` (ya ordenadas por
    quien llama) consumiendo cada capa hasta agotarla o hasta agotar `cantidadARescatar`. Nunca agrega
    el resultado entre capas (un rescate puede mezclar tramos con costo conocido y estimado). Si la
    cantidad pedida excede el remanente total, no inventa una capa ni completa con precio 0:
    `cantidadSinCubrir` queda en lo que faltó, **siempre presente** en el resultado (en `CERO` cuando
    el stock alcanzó). Valida sus entradas antes de operar y rechaza con `ConsumoInvalidoError`
    (motivo cerrado, nunca el dato recibido en el mensaje) ante: capas fuera de orden PEPS por
    `fecha`, cantidad a rescatar negativa, precio de rescate negativo, o cualquier campo negativo
    dentro de una capa (remanente, original, precio unitario de origen).
  - `tests/consumirRescate.test.ts` (6 casos) y `tests/aritmetica.test.ts` (21 casos, nuevo en la
    ronda de fixup) — incluye el caso real de rescate partido en 2 capas, un caso de rescate a
    pérdida, y el caso de empate exacto de redondeo en ambos signos (ver "Truncamiento", abajo).
  - `package.json` + `src/index.ts` mínimos, registrados en el workspace (`pnpm-lock.yaml` se
    actualizó solo por el alta).
- **Barrido de arquitectura**: filas espejo de R-B, R-G y R-J agregadas en
  `packages/data/tests/reglas-de-codigo.test.ts` para `packages/fci`, igual que ya existen para
  `packages/contabilidad` — más la línea que exige que `packages/fci/src/index.ts` esté cubierto por
  el glob del barrido (si el paquete quedara fuera del glob, las reglas espejo pasarían por vacío sin
  avisar).
- **Truncamiento en `multiplicar`, documentado y testeado**: la división entera de `bigint` en
  JavaScript trunca hacia cero, nunca redondea — ni en el empate exacto de la mitad del último dígito.
  Ejemplo real del comentario en `aritmetica.ts`: `1.000003 × -1.5 = -1.500004` (no `-1.500005`). Es
  una decisión explícita de esta utilidad de bajo nivel (redondear es decisión de negocio, no de
  aritmética), verificada a mano: matemáticamente correcto para `bigint` con truncamiento hacia cero.

### No cambia — alcance explícito, a propósito

- **Sin migración.** No hay tabla `capa_fci` ni ninguna persistencia. El motivo formal por el que este
  paso no dispara el modo-plan-por-esquema de CLAUDE.md §3.2(a): no hay esquema todavía, es
  exactamente lo que se recorta.
- **Sin Capa D (plan de cuentas por cliente).** El contrato `ResolverCuentaPorRol` que traduciría
  `RolFCI` a una cuenta contable real está **bloqueado a propósito** — Capa D no existe todavía como
  subsistema. `RolFCI` viaja como dato para que, cuando Capa D exista, el enganche sea directo sin
  rediseñar este núcleo.
- **Sin adapter de lectura del extracto de FCI de Galicia.** Este paso no lee ningún archivo real —
  el núcleo recibe `CapaFCI[]` ya construidas, de donde sea que vengan.
- **Sin los roles de valuación al cierre** (`diferencia_fci_a_devengar`, `resultado_tenencia_fci`):
  bloqueados hasta que Laura confirme el mecanismo de devengamiento (pregunta 1 de la lista de
  abajo). Agregarlos ahora sería inventar una decisión de negocio no confirmada.
- **Sin verificación contra los 3 extractos reales de Galicia** (invariante de cantidades): queda
  para la próxima etapa, vía script enmascarado — no se hizo en este paso.
- **Lo que se pierde, con lo recortado:** este paquete, solo, no calcula ningún costo real todavía —
  es mecánica pura sin ningún consumidor que le entregue capas reales ni que use su resultado. Es
  intencional: separar "¿cómo se consume una capa PEPS?" (este paso) de "¿de dónde salen las capas?"
  y "¿a qué cuenta va el resultado?" (etapas siguientes, cada una con su propia convocatoria).

## 2. Qué se mide

- `pnpm vitest run packages/fci packages/data/tests/reglas-de-codigo.test.ts` → **3 archivos, 92
  tests, todos verdes** (medido de forma independiente, no solo el reporte del agente que implementó).
- `pnpm typecheck` limpio.
- El caso de rescate partido entre dos capas (cifras sintéticas en el test, estructura confirmada
  contra un Excel real de la contadora) verificado a mano.
- Lectura manual del código final de `consumirRescate.ts`, `tipos.ts`, `aritmetica.ts` y
  `aritmetica.test.ts`, confirmando el truncamiento hacia cero como matemáticamente correcto (no un
  bug) para el caso de empate exacto.

## 3. Predicción falsable

| Si sale... | Significa... |
|---|---|
| Capas pasadas fuera de orden por `fecha` (más nueva antes que más vieja) | `consumirRescate` rechaza con `ConsumoInvalidoError('orden_no_peps')` — nunca calcula un costo PEPS invertido en silencio |
| `cantidadARescatar` excede la suma de remanentes de todas las capas | El resultado trae `cantidadSinCubrir` mayor que `CERO` con exactamente lo que faltó — nunca se inventa una capa ni se completa con precio 0 |
| Una capa o el rescate trae un valor negativo (cantidad, precio) | Se rechaza con el motivo específico del guard, nunca se silencia en un `cantidadSinCubrir` inflado |
| `multiplicar` opera sobre un empate exacto del último dígito descartado | El resultado trunca hacia cero en ambos signos (ej. `-1.500004`, no `-1.500005`) — comportamiento documentado y testeado, no un bug a corregir |
| Aparece un caso real (no hipotético) de pérdida de precisión con la aritmética de punto fijo actual | Recién ahí se convoca a `dba-data` + `security-engineer` para evaluar una librería decimal externa — nunca antes, y nunca por anticipación |
| Se agrega un tercer rol funcional a `RolFCI` sin que Laura haya confirmado el mecanismo correspondiente | Es una decisión de negocio inventada, no tomada — no debería pasar el `code-reviewer` de la etapa que lo intente |

## 4. Qué agentes se convocaron (para armar el plan, antes de escribir código)

- **`arquitecto-software`** — decidió paquete propio (`packages/fci`, no una carpeta dentro de
  `contabilidad`), contrato con Capa D bloqueado explícitamente, sin migración en esta etapa.
- **`plan-cuentas-multicliente`** — acotó los roles funcionales a los 2 que se necesitan hoy (no 4);
  el contrato `ResolverCuentaPorRol` queda bloqueado hasta que exista Capa D.
- **`contador-dominio`** — validó la mecánica de capas y el criterio PEPS; señaló un posible cuarto
  eje —`Intereses ganados FCI`— como pregunta nueva para la contadora (pregunta 9, abajo), no como
  decisión a tomar ahora.
- **`dba-data`** — confirmó que el motor arranca sin tabla, con un esbozo de escala numérica para
  cuando llegue la migración real.

**Convocados en la revisión paralela de la implementación (4 agentes, ronda 1):**

- **`contador-dominio`** — `CapaFCI` necesitaba un campo de identidad estable (`id`) para que la
  futura glosa de Capa D pueda distinguir una capa de otra; el `costoEstimado: boolean` en sí estaba
  bien tal como estaba.
- **`qa-automation`** — faltaba un caso de rescate a pérdida (resultado negativo); dio el caso con
  números exactos y sugirió el helper `capa(overrides)` para el fixture del test.
- **`code-reviewer`** — hallazgo **bloqueante**: `multiplicar` truncaba hacia cero en un empate exacto
  sin documentarlo ni testearlo; hallazgo should-fix: sin guard de entradas negativas, un dato
  negativo producía un resultado silenciosamente incorrecto en vez de un error.
- **`tester`** — confirmó con casos ejecutados que capas sin ordenar producían un costo PEPS
  invertido en silencio, y que cantidades negativas producían `cantidadSinCubrir` mayor que lo
  pedido — ambos sin ningún error: "basura silenciosa" en un motor fiscal.

Los 6 puntos consolidados de esa revisión se aplicaron en una segunda ronda de implementación (`id`/
`fecha` en `CapaFCI`, guard de orden PEPS, guards de negativos, comentario de truncamiento, el archivo
nuevo de tests de aritmética, el caso de pérdida, el helper `capa(overrides)`).

**A convocar en la próxima etapa** (fuera de este paso): `contador-dominio` para las preguntas de
negocio pendientes (ver abajo); `dba-data` + `security-engineer` + `seguridad-datos-financieros`
cuando se diseñe la migración real (obligatorio por CLAUDE.md §3.1, todavía no aplica porque no hay
esquema en este paso); `backend-dev` para escribir el adapter de lectura; `code-reviewer` antes de
cerrar cada etapa siguiente, como en cualquier cambio no trivial.

## 5. El paso revertible más chico

**Este paso, ya implementado**: `packages/fci/src/nucleo/{tipos.ts,aritmetica.ts,consumirRescate.ts}`
+ sus tests (`tests/consumirRescate.test.ts`, `tests/aritmetica.test.ts`) + las filas espejo en
`packages/data/tests/reglas-de-codigo.test.ts`. Sin commitear todavía (a propósito — no se pidió
commit). Reversible con un `rm -rf packages/fci` y revertir el diff de `reglas-de-codigo.test.ts`,
sin tocar ninguna base ni ningún entorno real: no hay migración que deshacer.

Los pasos siguientes, cada uno con su propio commit y su propia convocatoria, en orden:

1. Verificar el eje 1 (invariante de cantidades) contra los 3 extractos reales de Galicia, vía script
   enmascarado.
2. El adapter de lectura del extracto FCI de Galicia.
3. Capa D (plan de cuentas por cliente) y el contrato `ResolverCuentaPorRol`.
4. Los roles de valuación al cierre, una vez que Laura confirme el mecanismo de devengamiento.

## Pendiente — 9 preguntas abiertas para Laura

No se responden acá: son decisiones de negocio que le corresponden a la contadora, no a quien
documenta ni a quien implementa.

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
   identificados, o entra dentro de alguno de ellos?

## Pendiente — no bloqueante, para el próximo paquete con el mismo patrón

Sugerencia de `code-reviewer`: deduplicar las filas espejo de R-B/R-G/R-J en
`reglas-de-codigo.test.ts` con un generador, en vez de copiar el bloque a mano cada vez. Vale la pena
cuando entre un tercer paquete con este mismo patrón (núcleo puro sin SQL, sin async, sin importar
`data`) — no ahora, con solo dos.
