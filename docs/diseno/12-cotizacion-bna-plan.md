# 12 — Plan de diseño: caché de cotización BNA (comprador/vendedor por fecha)

> 🔴 **PLAN APROBADO POR JP — NO IMPLEMENTADO.** Ningún archivo de código de este plan existe
> todavía en el filesystem. No hay migración `0022`. No se tocó el piloto. Este documento es el
> plan formal de CLAUDE.md §3.2, escrito en modo plan, con los cuatro dictámenes de agentes que
> lo sostienen — el estado exacto para retomar sin perder nada, incluso sin memoria de la sesión
> que lo escribió.

## Contexto

Laura (contadora del estudio) confirmó por audio que cada movimiento en las dos cuentas USD
del piloto (Santander USD, Macro USD) tiene que valuarse contra la cotización del Banco Nación
del día: comprador para acreditaciones, vendedor para débitos. No existe hoy ningún mecanismo en
el repo para consultar esa cotización — ni histórica ni actual.

Investigación previa (misma sesión, ya cerrada): no hay API oficial de BNA con históricos
accesibles. Se usa `api.argentinadatos.com` (`/v1/cotizaciones/dolares/oficial/{yyyy}/{mm}/{dd}`,
pública, sin auth) — ya validada en producción por un proyecto hermano
(`C:\Proyectos_Desa\control-gestion\src\adapters\fx.py`). JP confirmó explícitamente: (1) aceptar
esta fuente, (2) el criterio de fallback camina hacia atrás — última cotización publicada ≤ la
fecha del movimiento, nunca una posterior, (3) arrancar modo plan formal.

Se convocaron los cuatro agentes que exige la matriz de CLAUDE.md §3.1 para "migración, tabla o
columna nueva" + el que agregó `security-engineer` por el precedente de "unión cerrada a
propósito" (R19): **dba-data, security-engineer, seguridad-datos-financieros, arquitecto-software**
— los cuatro con dictamen entregado antes de escribir este plan. Sus hallazgos, sintetizados, son
el diseño de abajo.

**Nota sobre `0021`:** esta es una migración nueva e independiente, sin relación con `0021`.
`0021` ya está commiteada, aplicada al piloto y pusheada a `origin/main` (`1cb63ae`) — no hay
ningún cambio pendiente ahí.

---

## 1. Qué cambia y qué no

### Cambia (una sola migración, `0022_*`)

- **Tabla nueva** `cotizacion_bna`: `moneda char(3)`, `fecha date`, `compra numeric(12,4)`,
  `venta numeric(12,4)`, `fuente text default 'argentinadatos'`, `created_at timestamptz`.
  PK `(moneda, fecha)`. `check (compra > 0 and venta > 0 and venta >= compra)`. **Sin RLS**,
  mismo patrón que la tabla `banco` ya existente (catálogo de plataforma N0, sin `cliente_id` —
  confirmado por `seguridad-datos-financieros`: es la cotización oficial pública, idéntica para
  los tres clientes, sin ningún dato de nadie).
- **Clasificación obligatoria** (`packages/shared/src/seguridad/clasificacion-campos.ts`):
  entrada nueva, `columnaTenant: 'ninguna'` con motivo explícito, los campos en `nivel: 'N0'`.
- **Tres barridos existentes, actualizados en la misma tarea** (si no, el gate se pone rojo por
  diseño — es la garantía que esos tests existen para dar):
  - `packages/data/tests/catalogo.test.ts` — agregar `'cotizacion_bna'` a `SIN_RLS_CON_MOTIVO`.
  - `packages/data/tests/grants-conjunto-cerrado.test.ts` (R41) — filas nuevas: `app_job` con
    `insert, update` acotado a columnas sobre `cotizacion_bna`; `app_request` solo `select`.
    Nunca `grant` de tabla entera (mismo error que ya costó `membership`/`acceso_auditoria` en
    incidentes previos, según `security-engineer`).
  - `packages/data/tests/reglas-de-codigo.test.ts` — agregar `cotizaciones` (el paquete nuevo,
    ver abajo) a la lista de paquetes que `packages/data` no puede importar.
- **Motivo nuevo en `MotivoJob`** (`packages/data/src/db/conexion.ts:49-55`, unión cerrada a
  propósito): `cargar_cotizaciones` — verbo + qué se hace, sin nombrar el proveedor ni "fx"
  (patrón de `arquitecto-software`, consistente con los seis motivos existentes).
- **Paquete nuevo `packages/cotizaciones`**: interfaz `ProveedorCotizaciones`
  (`obtener(moneda, fecha): Promise<{compra, venta, fuente} | null>`) + único adapter concreto
  `argentinadatos.ts` (fetch inyectable para testear sin red, respuesta validada con Zod antes
  de tocar el dominio — mismo criterio que ADR-0000 §3 ya exige, `AbortController` con timeout
  explícito porque el `fetch` nativo de Node no lo tiene por default, URL por variable de entorno
  con el valor actual como default de desarrollo, nunca hardcodeada). Nunca importado desde
  `packages/contabilidad/src/nucleo`.
- **Comando nuevo** `apps/cli/src/actualizar-cotizaciones.ts`: orquesta fetch (**fuera** de
  cualquier transacción) → walk-back en la base → `upsert` final dentro de un `conJob(...)`
  **corto**, sin I/O de red adentro. Es el hallazgo bloqueante de `security-engineer`: el pool
  de jobs tiene `max: 4` conexiones compartidas con `migracion`/`mantenimiento`/etc. — un fetch
  externo lento colgado dentro de esa transacción agotaría el pool para toda la plataforma.
- **Documentación de arquitectura** (recomendación de `arquitecto-software`, no opcional: el ADR
  hoy afirma algo que la migración volvería falso si no se corrige):
  - `ADR-0000-stack-infra.md`: subsección `§3.4` nueva — "cuarto tipo de contacto con un
    proveedor externo: datos de referencia (cotizaciones, y lo que venga después)", mismo patrón
    de interfaz + adapter reemplazable que ya rige auth/storage/datos.
  - `ADR-0002-seguridad.md`: reescribir la fila **R19** — hoy dice "`app_job` solo tiene DML
    sobre `tenant_node` y `membership`; sobre dominio no tiene nada", y deja de ser cierto.
  - `docs/seguridad/registro-terceros.md`: entrada nueva para `argentinadatos.com`, aunque R35
    no lo exija en sentido estricto (no se manda ningún dato de cliente) — es el primer destino
    de red externo del repo, y `security-engineer` recomienda dejarlo escrito por costumbre.

### No cambia — alcance explícito, a propósito

- **`packages/contabilidad/src/nucleo` sigue síncrono, sin red, sin cambios en este plan.** La
  lógica de valuación (qué hace el motor cuando la cotización falta, cómo entra comprador/vendedor
  al asiento) es una etapa POSTERIOR y separada — necesita convocar `contador-dominio` +
  `motor-conciliacion-contable` para dos decisiones de negocio que este plan deja explícitamente
  sin resolver (ver "Lo que se pierde", abajo). El límite que sí queda fijado ahora: cuando esa
  etapa llegue, la ausencia de cotización se recibe como un argumento ya resuelto (mismo idiom que
  `PadronConsultado`), nunca como un `await` colado dentro del motor — eso rompería R-J.
- **No se aplica nada al piloto.** Todo el trabajo de este plan queda en local; la autorización
  del piloto (si corresponde) es un pedido aparte, después, bajo CLAUDE.md §1.9.
- **No se construye un scraper.** Se usa la API pública ya validada en producción por
  `control-gestion` — investigación ya cerrada.
- **Lo que se pierde, con lo recortado:** sin la etapa de valuación en el motor, esta migración
  por sí sola no hace que ningún movimiento se clasifique distinto — es infraestructura (caché +
  adaptador) sin consumidor todavía. Es intencional: separar "¿de dónde sale el dato?" (esta
  etapa) de "¿qué hace el motor con el dato?" (la próxima, con su propia convocatoria).

---

## 2. Qué se mide

- `pnpm verificar` en verde de punta a punta (conteo exacto de archivos/tests se toma al empezar,
  como línea de base — hoy 66 archivos / 1521 tests / 0 fallas).
- El barrido de grants (R41, `grants-conjunto-cerrado.test.ts`) tiene que dar **rojo antes** de
  agregar las filas nuevas de `cotizacion_bna` (confirma que el conjunto cerrado reacciona de
  verdad, no que "debería") y **verde después**.
- **Un fetch real contra `api.argentinadatos.com`**, antes de cerrar el DDL final, para confirmar
  la escala decimal real de `compra`/`venta` — `dba-data` señaló explícito que `numeric(12,4)`
  es una estimación razonable, no una medición; se mide antes de fijarla en la migración (mismo
  método que P0 de `0021`: medir contra el dato real antes de escribir DDL).
- Un test que ejercite el límite "fetch afuera de la transacción" con un mock que **cuelga**
  (nunca resuelve) — confirma que el pool de jobs (`max: 4`) no se satura mientras el resto de la
  suite corre en paralelo. Es el mutante que refuta la premisa, no uno que la confirma
  (`arquitecto-software`).

## 3. Predicción falsable

| Si sale... | Significa... |
|---|---|
| La migración `0022` aplica y `pnpm verificar` sigue en rojo por `grants-conjunto-cerrado.test.ts` o `catalogo.test.ts` sin haber tocado esos archivos | El conjunto cerrado funciona como se espera — hay que agregar las filas, no es un bug |
| El fetch real trae `compra`/`venta` con más de 4 decimales | `numeric(12,4)` se queda corto — hay que revisar la escala antes de cerrar el DDL, no después de aplicarlo |
| El fetch real devuelve un shape distinto al `{compra, venta}` documentado por `control-gestion` (ej. campos renombrados, `null` en vez de ausencia) | El adapter y su validación Zod necesitan ajustarse — mejor encontrarlo en el plan que en producción |
| El mock-que-cuelga satura el pool de jobs igual (otros tests con `conJob` empiezan a fallar por timeout mientras corre) | El diseño "fetch afuera de la tx" está mal implementado — hay que revisar antes de considerar el paso cerrado |
| El mock-que-cuelga NO satura el pool | Confirma que el límite arquitectónico se sostiene en la práctica, no solo en el papel — recién ahí se puede dar por cerrado ese punto |

## 4. Qué agentes se convocan

**Ya convocados y con dictamen entregado, antes de este plan** (satisface CLAUDE.md §3.1 de
forma estructural, no como promesa de texto):

- `dba-data` — diseño de la tabla, PK, walk-back sin índice extra, grants, motivo de `MotivoJob`.
- `security-engineer` — superficie de red externa, el hallazgo bloqueante del pool de jobs,
  grants acotados por columna, fail-closed ante fetch fallido.
- `seguridad-datos-financieros` — clasificación N0 confirmada, sin RLS por diseño (patrón `banco`),
  sin necesidad de `leerConAuditoria`.
- `arquitecto-software` — paquete nuevo (`packages/cotizaciones`), nombre del motivo de `MotivoJob`,
  necesidad de adenda a `ADR-0000` §3 y reescritura de R19, límite de acoplamiento con
  `packages/contabilidad`.

**A convocar en la PRÓXIMA etapa** (valuación en el motor, fuera de este plan): `contador-dominio`
+ `motor-conciliacion-contable` — para las dos preguntas de negocio que este plan deja abiertas:
(a) qué hace el motor cuando no hay cotización cacheada para una fecha (¿cola de revisión
completa, o el asiento se registra en USD y la valuación es un paso posterior?), y (b) si una
corrección retroactiva del valor cacheado (el `upsert` pisa una fila ya escrita) puede reabrir
implícitamente un asiento ya propuesto con la cotización vieja — hallazgo de
`seguridad-datos-financieros` (H-4), con un ángulo de integridad de datos, no solo de negocio.

**Al implementar esta etapa** (cuando se retome): `backend-dev` escribe el código;
`code-reviewer` revisa antes de cerrar, como en cualquier cambio no trivial.

## 5. El paso revertible más chico

**Un commit único**: migración `0022` (tabla + su clasificación + los tres barridos actualizados)
más el paquete `packages/cotizaciones` con **solo el adapter** (`ProveedorCotizaciones` +
`argentinadatos.ts`, sin el comando de `apps/cli` todavía) — probado en local, sin tocar el
piloto. Reversible con un `DROP TABLE` sobre una base que nunca vio esta migración en ningún
entorno real.

El comando `actualizar-cotizaciones.ts` (el job que efectivamente escribe filas) y, más adelante,
la integración con el motor de valuación quedan como pasos **separados y posteriores**, cada uno
con su propio commit chico — no se mezclan con este primer paso, que es puro esquema + adaptador
sin consumidor.
