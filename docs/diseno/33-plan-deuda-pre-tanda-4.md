# 33 — Plan de resolución de deuda técnica: antes vs. después de la Tanda 4

> **Para qué existe.** Consolida `docs/diseno/10-deuda-declarada.md` (todo el ítem B.1-B.26 y la sección
> C) contra lo que la **Tanda 4** (`docs/diseno/31-replanteo-hacia-producto.md` líneas 575-649: ADR de
> auth + vista de solo lectura para Laura — la primera vez que el sistema expone datos de clientes
> reales en una interfaz visible, no CLI+Excel) va a tocar o depender. Separa lo que hay que resolver
> **antes** de esa tanda de lo que puede esperar **sin riesgo** después.
>
> **Con qué se armó.** Relevamiento propio de `10-deuda-declarada.md` completo (secciones 0.0, A, B, C,
> 1, 2, 5) + convocatoria real a `product-owner` (prioridad) y `seguridad-datos-financieros` (qué dato es
> sensible y cuándo), en paralelo, cada uno con su propio dictamen — no solo nombrados. Donde los dos
> coinciden, se marca así; donde uno agregó algo que el otro no había nombrado, también.

---

## A. Antes de arrancar la Tanda 4 (bloqueante o precondición)

### A.1 🔴 B.4 — `AuthProvider` / login real. Bloqueante duro, no negociable.

No es una interpretación de prioridad: el propio `31-replanteo-hacia-producto.md` dice literal "Tanda 4
— ADR de auth + vista de solo lectura" y el diagrama de dependencias del mismo documento marca la vista
como dependiente de auth (B.4). Hoy la identidad entra por un GUC que setea la sesión (incidente #8) —
no hay autenticación de personas en ningún lado del sistema.

**Por qué no se puede recortar como si fuera una feature más**: una vista que muestra datos de clientes
reales sin login no es un MVP acotado, es exponer secreto fiscal sin control de acceso (dictamen de
`seguridad-datos-financieros`).

**Dos implicancias de diseño que hay que tener presentes al escribir el ADR, no descubrirlas después**
(`seguridad-datos-financieros`):
1. El rol tiene que ser **verificado del lado del servidor en cada request**, nunca declarado por el
   cliente/token sin validar — es el modelo de referencia para toda superficie humana que venga después.
2. **No es retroactivo**: los valores históricos de `hecho_por`/`confirmado_por`/`resuelto_por`/
   `decidido_por` del piloto (Bracci, ROKA) van a seguir siendo "atribución de GUC de sesión", no de una
   persona real, aunque AuthProvider exista después. Si alguna vez hace falta auditar "quién confirmó
   este asiento en julio", la respuesta correcta es "el proceso que corrió con esa sesión" — dejarlo
   declarado ahora evita que alguien lo asuma distinto más adelante.

**Criterio de cierre, en números** (`product-owner`): ADR de auth aprobado + `AuthProvider` implementado
+ al menos 1 login real de Laura funcionando de punta a punta, **antes** de que la vista se le muestre —
0 accesos a la vista sin sesión autenticada.

**Convocatoria que exige CLAUDE.md §3.1 + lo que agrega este relevamiento**: `arquitecto-software` +
`security-engineer` + `seguridad-datos-financieros` (los tres, no solo los dos que dice la matriz
genérica de "esquema/RLS" — acá se está definiendo además el modelo de roles y qué ve cada uno).
Agrupar en la MISMA convocatoria, porque `security-engineer` va a estar en la mesa de todos modos:
- El choke point de `leerConAuditoria` sobre lecturas N2-R/N3 (ver A.4).
- El hallazgo de grants a nivel tabla sobre `cierre_cliente_periodo`/`asiento_propuesto` (ver A.6).

### A.2 🟠 Guard mínimo de dato-real-vs-prueba (B.22) — precondición de la VISTA, no del ADR en sí.

`10-deuda-declarada.md` B.22 deja el hueco abierto: nada en el esquema distingue "extracto real
entregado por un cliente" de "fixture de desarrollo" (el caso real: el lote `ae762fda…` de ROKA, ver
`32-lecciones-y-protocolos-de-sesion.md` §2). Con tres opciones sin decidir.

**Ambos convocados coinciden en partirlo en dos, no tratarlo todo-o-nada** (divergencia explícita de
`product-owner` respecto de tratarlo como un solo ítem): el **cierre estructural completo** (migración,
decisión de dónde vive la marca) puede esperar; pero Tanda 4 **no puede salir sin algún guard**, porque
este defecto ya contaminó una medición interna dos veces, y el próximo consumidor no va a ser un agente
con SQL — va a ser Laura confiando en una pantalla.

**Recomendación de diseño, consolidada** (`seguridad-datos-financieros`):
- Columna `lote_ingesta.es_dato_real boolean NOT NULL`, **sin default** (obliga a declarar en cada
  `INSERT`) — no la opción (b) de reutilizar `origen` (son dos preguntas distintas: cómo llegó el
  archivo vs. si es real) ni la opción (c) sola de un proceso humano de alta (antipatrón R33/R13: "un
  control que depende de que alguien lo recuerde no es un control").
- Clasificación **N1** (metadato operativo, no identifica a nadie).
- Promoverla a **regla verificable de ADR-0002 §B**, cerrada con prueba de mutación (CLAUDE.md §1.8): el
  caso legítimo es la propia suite de test; la mutación de refutación es insertar un fixture con
  `es_dato_real = false` y confirmar que la consulta/vista de producción lo excluye.

**Criterio de cierre mínimo aceptable si se necesita ir más rápido**: una allowlist explícita de lotes
reales confirmados en la consulta que alimenta la vista, aunque el cierre estructural completo (columna +
regla verificable) se resuelva después.

**Estado (2026-09-13, `backend-dev`):** cierre estructural completo **implementado y verificado contra
LOCAL** — migración `packages/data/migrations/0044_lote_ingesta_es_dato_real.sql` (columna `boolean not
null` sin default, grant de `UPDATE` acotado por columna sin incluir `es_dato_real`, trigger
`trg_lote_ingesta_es_dato_real_inmutable`), flag obligatorio `--es-dato-real real|prueba` en
`apps/cli/src/ingestar.ts` (sin default, vocabulario cerrado), clasificación N1 en
`clasificacion-campos.ts`, y prueba de mutación del guard del CLI en
`apps/cli/tests/ingestar-es-dato-real.test.ts` (ciclo verde→mutante→rojo→revertido→verde confirmado
real). **Migración `0044` SIN APLICAR TODAVÍA AL PILOTO**: aplicarla ahí requiere su propia autorización
explícita, listando y confirmando SOLO esa migración (CLAUDE.md §1.9 — nunca `pnpm db:migrate` pelado).
No se corrió una verificación puntual de candidatos post-2026-09-09 contra el piloto: este agente no
tiene acceso a ese entorno desde su sesión de trabajo, así que se declara explícito en vez de asumir que
no hay candidatos — queda pendiente para quien aplique `0044` al piloto.

### A.3 🟡 Reclasificación N1→N2 de `padron_contraparte_id` en `asiento_propuesto_renglon`

Ya declarado en `10-deuda-declarada.md` (bullet sin número, cerca de la línea 890): clasificado N1 por
una analogía incorrecta (con `padron_manifestacion_id`, que es un puntero de versión, no de identidad).
El precedente correcto ya existe para la columna hermana de `0038`: N2.

**Por qué sube de prioridad con Tanda 4** (`seguridad-datos-financieros`): `clasificacion-campos.ts` es
la fuente única que alimenta el redactor de logs, el armador de exports **y el serializador de
API/vista**. Con una consulta SQL manual, un dev con criterio no comete el error aunque la clasificación
esté mal — con un endpoint automático detrás de una UI, la clasificación **es** el control.

**Cierre**: edición de una línea en `packages/shared/src/seguridad/clasificacion-campos.ts`, sin tocar
la migración `0037` ya aplicada. Hacerlo **antes** de que Tanda 4 escriba el primer endpoint que
serialice esta columna, no después.

### A.4 🟡 Cablear `leerConAuditoria` en todo camino de lectura N2-R/N3 de la vista

Hallazgo propio de `seguridad-datos-financieros`, no nombrado en `10-deuda-declarada.md` como tal:
`ADR-0002-seguridad.md` (R32) ya declara el mecanismo (`leerConAuditoria`,
`packages/data/src/db/auditoria-solo-lectura.ts`) pero también declara que **no está cableado en todo
camino de lectura N2-R/N3** — hoy es tolerable porque el único lector es un agente/dev con
`conUsuario()`/`conJob()` y HANDOFF como rastro informal.

**Por qué deja de ser tolerable con Tanda 4**: en cuanto la vista le muestre CBU, CUIT o cualquier N2-R a
Laura, la pregunta "¿quién vio el dato fiscal de este cliente, y cuándo?" tiene que poder responderse
por consulta a `acceso_auditoria`, no por HANDOFF.

**Cierre**: el ADR de B.4 (A.1) incluye explícito que todo endpoint de la vista que lea N2-R/N3 pasa por
`leerConAuditoria`, sin excepción, verificado con test — no asumir que "ya existe el mecanismo" alcanza
si nadie lo conecta al camino nuevo.

### A.5 🟡 B.12 — `cuenta_atributo` sin columna de auditoría por fila (`decidido_por`)

**Condicional, no bloqueante per se** (ambos convocados coinciden): mientras Tanda 4 se mantenga
estrictamente de **solo lectura** (así la define el propio doc 31), nadie escribe `cuenta_atributo`
desde la pantalla y B.12 no aplica todavía.

**La condición que lo vuelve bloqueante, explícita**: en el instante en que se agregue la primera acción
de escritura/confirmación desde la interfaz (y el propio JP ya dejó escrita una ambición de UI alta que
es terreno fértil para que alguien proponga "de paso confirmá esto desde acá" — precedente de scope
creep ya documentado en CLAUDE.md §3.2 con el caso `galicia.ts`), B.12 se vuelve bloqueante en el acto.

🔴 **Revisar OBLIGATORIAMENTE en el mismo momento en que se diseñe la primera escritura/confirmación
desde la interfaz de la Tanda 4 — no dejarlo pasar como nota archivada.**

**Recomendación**: dado que la migración ya está diseñada en el propio B.12 (`decidido_por uuid not
null`, backfill aparte si hace falta) y es aditiva, evaluar cerrarla en la misma tanda que B.4 si el
presupuesto lo permite — es más barato ahora, con `dba-data` ya convocado por el ADR de auth, que abrir
una convocatoria aparte el día que alguien agregue la primera escritura.

### A.6 🟡 Vigilancia, agrupar con la convocatoria de A.1 (no bloqueante en sí)

Hallazgo de `security-engineer` ya declarado en `10-deuda-declarada.md` sección C:
`grants-conjunto-cerrado.test.ts` tiene 12/20 tests rojos a propósito porque `cierre_cliente_periodo` y
`asiento_propuesto` tienen un `grant update` a **nivel tabla** (no acotado por columna) que permite
reescribir `confirmado_por`/`confirmado_en`/`fecha_imputacion` sobre un registro ya confirmado, sin pasar
por el gate de D-24 y sin dejar rastro.

No bloquea una vista de solo lectura (nadie escribe desde ahí), pero `asiento_propuesto` es exactamente
una tabla que la vista va a leer, y el ADR de auth va a tocar roles de todos modos — agruparlo ahora es
más barato que una convocatoria separada después (`product-owner`).

---

## B. Puede esperar sin riesgo, después de la Tanda 4

Confirmado por `product-owner` (ninguno de estos toca identidad, sesión, ni la superficie que la vista
de solo lectura va a exponer — son deuda de exactitud contable/extractor o de higiene de tests, ortogonal
a "quién puede ver qué en pantalla"):

- **B.9** — patrón `unique nulls not distinct` sin predicado parcial en 3 tablas, sin síntoma real todavía.
- **B.11** — sin guardia de solape de período en `documento_ingerido`/`fuente_cierre` (riesgo aceptado,
  sin código de aplicación que lo ejercite).
- **B.13** — sin función real que abra/encuentre un `cierre_cliente_periodo` (bloquea la Sesión 3 del
  roadmap de Capa D, no la Tanda 4).
- **B.14** — hueco de red de test sobre `Promise.all` compartido (sin síntoma con la versión actual de
  `pg`).
- **B.15/B.16** — reglas de imputación de ROKA pendientes de confirmación de dominio (impuesto a los
  débitos, `pago_de_haberes`).
- **B.17 (residual)** — tarjeta corporativa de Bracci bloqueada por dato externo (ningún ancla real en el
  documento) — el mecanismo ya está cerrado, falta el dato, no código.
- **B.21** — `mutaciones-0038.test.ts` 7/12 rojo, pre-existente a la Tanda 3, sin relación con lo que la
  Tanda 4 toca.
- **B.23** — 13 casos de IIBB Córdoba (ROKA), bloqueado por dato externo (constancia de inscripción +
  confirmación de Laura), no por código.
- **B.24/B.25** — Excel legacy de Macro sin lector, guard de tolerancia de redondeo nunca ejercitado —
  ninguno de los dos toca la superficie de la vista.
- **B.26** — allowlist de R-F desactualizada (2 archivos de test), higiene de suite.

Y la sección C completa de `10-deuda-declarada.md` (deuda de seguridad histórica de `08-plan-de-
construccion.md` §6.0, el lote-ancla perdido en excepción, `pnpm db:seed` roto, `0016` huérfana,
validación legal de Poppler, `.env.example` gitignoreado, promoción de "reconcile-or-refuse" a R43,
separador decimal corrupto por OCR, layout de FCI Bracci pausado, wrapper de `formaParaLog`, totales de
Bancor sin confirmar, `--banco` no catalogado sin rastro, `.githooks/pre-commit` y `GIT_INDEX_FILE`,
guard de `sembrar()` por etiqueta en vez de DSN real, `descripcion` excluida del digest,
`regla_imputacion_concepto_chk` fuera de `DOMINIOS_CERRADOS`) — **salvo el hallazgo de grants ya movido a
A.6** — sigue siendo deuda de exactitud/higiene, no de superficie de acceso.

Las secciones 1 y 2 de `10-deuda-declarada.md` (auditoría de `dba-data` sobre el modelo de datos, y de
`tech-lead` sobre coherencia entre adaptadores de banco) son deuda del Módulo 1/2, anterior a este
relevamiento y sin relación con auth/tenancy visible — quedan en el orden que ya propone la sección 6 de
ese mismo documento ("Orden sugerido para retomar"), sin cambios.

La sección 5 (export a Excel, ítem 5.1: columna `destinatario` en `acceso_auditoria`) también puede
esperar — toca el modelo de auditoría de un camino distinto (export CLI), no la vista.

---

## C. Verificación puntual pedida: ¿el gap de R-B sigue cerrado?

**Sí, confirmado.** El commit `3b21667` (HANDOFF 210) cerró el ajuste de R-B para
`armar-libro.ts`/`armar-libro-laura.ts` en la misma sesión en que se encontró. Verificación posterior de
esa misma sesión: **212/213 verde**, el único rojo es `R-F` (allowlist desactualizada, ya declarada como
B.26 — deuda conocida, no una regresión de R-B). Sigue cerrado al 2026-09-13, sin acción pendiente.

---

## D. Orden sugerido para arrancar

1. **A.2 (guard mínimo dato-real-vs-prueba)** — rápido, bajo riesgo, y desbloquea confiar en cualquier
   medición que se haga después contra el piloto real.
2. **A.3 (reclasificación N1→N2 de `padron_contraparte_id`)** — una línea, sin migración, se puede hacer
   en paralelo con lo de arriba.
3. **Convocatoria formal de A.1 (B.4/AuthProvider)**: `arquitecto-software` + `security-engineer` +
   `seguridad-datos-financieros`, agrupando en la misma mesa A.4 (choke point de `leerConAuditoria`) y
   A.6 (grants de `asiento_propuesto`/`cierre_cliente_periodo`) — y decidiendo ahí mismo si A.5 (B.12)
   se cierra en la misma tanda o se declara guardia explícita de "solo lectura, revisar en cuanto se
   agregue la primera escritura".
4. **Implementación del ADR de auth** — `AuthProvider` + login real, con el criterio de cierre de A.1.
5. **Convocatoria a `ux-designer`** (nunca usado en este proyecto todavía) para el diseño visual de la
   vista — condicionado, como ya dice `31-replanteo-hacia-producto.md`, a que las Tandas 1-2 demuestren
   que Laura completa las hojas de Excel. No se convoca antes de eso.
