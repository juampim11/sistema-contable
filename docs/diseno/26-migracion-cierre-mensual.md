---
Primera migración real de Capa D del cierre mensual. Sesión en modo plan (aprobado por JP con tres
condiciones), 2026-08-27. Cierra D-25 (segunda convocatoria puntual) y corre la convocatoria completa
de `agents/README.md` §3.1 (`dba-data` + `security-engineer` + `seguridad-datos-financieros` +
`arquitecto-software`) sobre el diseño completo antes de escribir `0027_cierre_mensual.sql`.
---

# Migración `0027` — esquema del cierre mensual

> **Cuándo leer este documento**: junto con `23`, `24` y `25`. Las 25 decisiones de esas tres
> convocatorias son la especificación; este documento es su implementación en esquema — y encontró
> tres correcciones reales que ninguna de las tres rondas anteriores había visto, porque recién acá
> el diseño se enfrentó al SQL concreto.

## 0. Paso 0 — D-25 cerrada en una vuelta

`plan-cuentas-multicliente` + `dba-data`, convocados por separado: **se adopta `padron_socio_id`**.
`plan-cuentas-multicliente` ajustó la forma — el `CHECK` no es contra un literal único
(`rol_funcional = 'cuenta_particular_socio'`), es contra una **familia nombrada** de roles ligados a
un socio puntual, porque `aporte_de_socio`/`retiro_de_socio` (ya reales, citados en `23` §4.2 P9)
tendrían el mismo hueco si quedaran afuera. `denominacion` se mantiene **siempre editable e
independiente** del FK — nunca derivada de `padron_socio.denominacion` — porque son dos máquinas de
versionado distintas (el socio se corrige in-place, la cuenta versiona por vigencia semiabierta).
`dba-data` confirmó la forma técnica: FK compuesta directa, `CHECK` de fila simple sin subquery, sin
índice nuevo (sin consulta que lo justifique todavía). No hizo falta separar `cuenta_atributo` de
esta migración.

## 1. Paso 2 — convocatoria completa, hallazgos reales

Cuatro agentes, con el diseño concreto de las 11 tablas. Tres correcciones **reales** salieron de acá,
ninguna de las tres rondas anteriores las había visto:

### 1.1 CORRECCIÓN A D-18 — `total_debe`/`total_haber` NO son columnas físicas

**Qué decía D-18 (`24` §3, primera convocatoria)**: `total_debe`/`total_haber` viven en
`asiento_propuesto` como columnas físicas, mantenidas por un trigger `AFTER INSERT/UPDATE/DELETE` sobre
`asiento_propuesto_renglon`, y "dejan de ser escribibles por `app_request`" — con un `CHECK
(total_debe = total_haber)` de tabla como defensa en profundidad.

**Por qué esa forma no se sostiene, verificado en esta convocatoria**: un trigger sin `SECURITY
DEFINER` (prohibido en esta tarea) corre con los privilegios de quien dispara el DML — revocarle el
`UPDATE` de esas columnas a `app_request` también se lo revoca al propio trigger, que las necesita
para escribir. `dba-data` y `security-engineer` lo confirmaron y propusieron la salida mínima: dejar
el grant de `UPDATE` abierto igual (técnicamente escribible), con la garantía real viviendo en el
recálculo al confirmar, no en el grant. **`arquitecto-software` encontró un agujero que esa salida
mínima no cerraba**: el paso 7 (revisión humana, **antes** de confirmar) le muestra al contador ese
mismo caché — si un `UPDATE` directo sobre `asiento_propuesto` (sin tocar un solo renglón) puede
corromperlo, la revisión puede mentir aunque el acto de confirmar, después, recalcule bien.

**Corrección adoptada**: se retira la forma de D-18 tal como estaba escrita. `total_debe`/
`total_haber` se reemplazan por la vista `asiento_propuesto_totales` (`security_invoker = true`,
PG16), calculada siempre desde los renglones — nunca una columna que un `UPDATE` pueda desincronizar.
No hay caché que proteger ni `SECURITY DEFINER` que evitar: el problema desaparece de raíz, no se
mitiga. Costo asumido y explícito: se pierde el `CHECK (total_debe = total_haber)` de tabla — se
compensa con verificación en dos puntos de código determinístico, fuera de esta migración (Capa D):
al proponer (TypeScript, antes del `INSERT` de los renglones) y al confirmar (recálculo dentro de
`conUsuario`, que es la mitad de D-18 que SÍ sobrevive sin cambios).

**Dependencia que esta corrección asume, declarada explícita para quien implemente Capa D**: la vista
es correcta porque nunca hay un cliente leyéndola a mitad de una transacción de escritura ajena —
Postgres/MVCC hace que una lectura fuera de la transacción que inserta los renglones solo vea el
estado antes de empezar o el estado ya comiteado completo, nunca un punto intermedio. Eso es cierto
**siempre y cuando el paso 7 (revisión humana) lea la vista en una consulta/transacción NUEVA, después
de que la transacción que propone el asiento (Capa D insertando todos sus renglones) ya haya hecho
`commit`** — que es como ya funciona el flujo descripto en `23` §1.1 (proponer y revisar son pasos
distintos, no la misma transacción). Si alguna implementación futura mostrara la vista dentro de la
misma transacción que todavía está insertando renglones, vería un total parcial y real — no corrupto,
pero sí incompleto — que reflejaría fielmente un asiento a medio construir. No es un caso a blindar
con esquema; es una regla de cuándo se lee, para Capa D.

### 1.2 CORRECCIÓN A D-24 — el gate no vivía en ningún lado verificable, mecanizado en dos capas

**Qué decía D-24 (`25` §1, segunda convocatoria)**: el gate de confirmación — rechazar
`cierre_estado → confirmado` si queda un `pendiente_cierre` `abierto` de fuente esperada-confirmada —
era "control duro dentro de `conUsuario`, mismo criterio que D-18". Es decir: vivía en la función de
aplicación que confirma.

**Por qué esa forma no se sostiene**: `security-engineer` encontró que nada en el ESQUEMA impedía que
otro camino de código —un script de soporte, un job de mantenimiento futuro, un endpoint nuevo escrito
sin acordarse de este gate— hiciera `UPDATE cierre_cliente_periodo SET cierre_estado='confirmado'`
directo, sin pasar por la función que sí lo evalúa. Es el mismo patrón que ya costó R33/R13 en este
repo: un control que depende de que el código lo recuerde no es un control.

**Corrección adoptada**: el gate se mecaniza en DOS capas, ninguna con `SECURITY DEFINER`, y **ninguna
de las dos sustituye a la otra** — cierran caminos distintos:

1. **RLS por rol y por valor** (`arquitecto-software`): `administrativo` tiene una policy de `UPDATE`
   cuyo `with check` excluye explícitamente `'confirmado'`/`'anulado'` como valor destino — solo
   `socio`/`contador` pueden escribir esos dos valores. Cierra "alguien con menos permiso del que
   debería".
2. **Trigger `BEFORE UPDATE OF cierre_estado`** (`security-engineer`): corre para **cualquier** rol que
   llegue a intentar la transición — incluido `socio`/`contador` por un camino que no sea la función
   oficial de confirmar —, consultando `pendiente_cierre` + `expectativa_fuente_cliente` del mismo
   tenant — invoker, intra-tenant, sin `DEFINER`. Cierra "alguien con el permiso correcto, pero
   saltándose el control de negocio".

### 1.2.bis 🔴 Límite de la capa 2, encontrado al revisar esta sección — no cerrado en esta migración

El trigger de 1.2 punto 2 es atómico **dentro de la transacción que confirma**: el `SELECT` de
`pendiente_cierre` y la escritura de `cierre_estado` ocurren como una sola operación de Postgres (si el
trigger no rechaza, el `UPDATE` se aplica; si rechaza, nada se aplica) — no hay una ventana propia
donde "se chequeó, pero todavía no se escribió". Ninguna de las dos capas necesitaba `SECURITY
DEFINER` para lograr esto.

**Pero `conUsuario()` abre la transacción con `begin` sin isolation level explícito — READ COMMITTED,
el default de Postgres — y eso deja una ventana de carrera teórica, no cerrada por esta migración**:
si una transacción T2 inserta un `pendiente_cierre` nuevo (`documento_faltante`, `abierto`, contra una
expectativa confirmada) para el MISMO cierre, y esa inserción confirma (commit) en el instante exacto
posterior a que el trigger de una transacción T1 ya evaluó su `SELECT` (encontrando cero pendientes)
pero antes de que T1 termine de confirmar, T1 puede confirmar igual — el trigger no vuelve a
re-evaluar. Es la misma clase de ventana que existe en cualquier patrón "leer invariante, después
escribir" bajo READ COMMITTED sin lock explícito; no es un defecto específico de este trigger. Ninguno
de los cuatro dictámenes de esta convocatoria evaluó isolation level — es un hallazgo de esta revisión,
no de la convocatoria original. **No se cierra en esta migración**: dado que confirmar es un acto
humano deliberado, no una operación de alta frecuencia, se considera un riesgo residual aceptable por
ahora, pero queda declarado — no descubierto — para que quien implemente Capa D decida si lo cierra
con un lock explícito (`SELECT ... FOR UPDATE` sobre el `cierre_cliente_periodo` al confirmar) o con
`SERIALIZABLE` en esa transacción puntual.

### 1.3 `pendiente_cierre` necesitaba una columna que ningún boceto anterior tenía: `expectativa_id`

Hallazgo propio de esta migración, no de una convocatoria previa: un pendiente de `documento_faltante`
describe un documento que **nunca llegó** — por definición, no tiene `fuente_cierre` (esa tabla solo
existe para lo que sí se ingirió). Sin una referencia directa a la expectativa, el gate del punto 1.2
no tiene con qué unir. Se agregó `pendiente_cierre.expectativa_id` (FK tenant-consistente, nullable —
los pendientes de `cotizacion_no_disponible` no la usan).

## 2. Otros hallazgos de la convocatoria, incorporados

- **Seis tablas sin `unique(cliente_id, id)`** (`dba-data`): bloqueante mecánico — sin ese renglón las
  FK compuestas que el boceto de `23` ya asumía no se pueden crear. Agregado a las seis.
- **`banco_codigo`, no `banco_id`** (`dba-data`): `banco.codigo` es la PK real (`0004`), no existe
  `banco.id`.
- **`hecho_por` NUNCA nulo, ni para transiciones automáticas** (`seguridad-datos-financieros` +
  `arquitecto-software`, con precedente medido en el incidente de `membership_historia`): se agrega
  `hecho_via` (`manual`|`automatico`) como columna propia, atribuyendo siempre a la persona real cuya
  acción disparó la transición.
- **`for all` descartado en las once tablas** (los cuatro agentes convergieron, con argumentos
  complementarios): ninguna tiene columna N2-R, así que el mecanismo del incidente de
  `movimiento_origen_crudo` no aplica por lectura restringida — pero `auditor` lee las once y no
  escribe ninguna, y varias tienen asimetría real de autorización por VALOR (`administrativo` propone/
  consolida, nunca confirma/dispensa). `for all` no puede expresar esa asimetría.
- **Quién puede dispensar** (`arquitecto-software`, hallazgo nuevo — D-24 nunca lo había fijado): mismo
  peso que confirmar, `socio`/`contador` únicamente, nunca `administrativo`.
- **`cuenta_atributo.rol_funcional` es N2, no N1** (`seguridad-datos-financieros`, corrigiendo la
  premisa de la convocatoria): afirma un hecho real sobre la relación societaria del cliente, mismo
  argumento que ya clasificó `admite_matches` en N2 pese a ser vocabulario cerrado.
- **`pendiente_cierre.motivo` → `motivo_codigo`** (verificado contra
  `packages/contabilidad/src/nucleo/tipos.ts:139-141`): mismo mecanismo que ya forzó el renombre de
  `estado` (D-19). `cierre_transicion.motivo` y `pendiente_dispensa.motivo` SÍ se quedan como `motivo`
  — ahí es prosa libre genuina.
- **Contradicción `23` §2.2 vs §2.4 sobre `cierre_cliente_periodo.superseded_by_id`**: no existe esa
  columna (usa máquina de estados). El índice único de "un cierre vigente" usa
  `WHERE cierre_estado <> 'anulado'`.

## 3. Lo que NO decidió esta convocatoria — deuda declarada, explícita

- **`cuenta_atributo.rol_funcional`**: la lista completa de valores (más allá del provisional
  `generica`/`cuenta_particular_socio`/`aporte_de_socio`/`retiro_de_socio`) es de `contador-dominio` —
  ampliarla después es aditivo (`ALTER TYPE`/valor de `check` nuevo), no re-clasifica nada.
- **`asiento_renglon_montos_chk` (`debe = 0 or haber = 0`)**: asunción propia de esta migración (un
  renglón nunca es de los dos lados a la vez), no ratificada por `contador-dominio` — es el patrón
  contable estándar, pero queda declarado como supuesto, no como decisión.
- **`verificacion_heredada.motivo`** (el campo interno del jsonb, no la columna de `pendiente_cierre`):
  el `CHECK` de la migración cierra las CLAVES permitidas y el vocabulario de `estado`, pero no cierra
  el vocabulario de este `motivo` interno — queda para Zod en el límite de escritura (D-20, capa de
  aplicación), fuera de esta migración.
- **Backfill de `documento_ingerido`**: sigue esperando al primer consumidor real (D-17), no a esta
  migración. La tabla nace vacía.

## 4. Verificación de esta sesión

- `pnpm typecheck`: limpio (`clasificacion-campos.ts`, `packages/data/src/cierre/tipos.ts`,
  `aislamiento-0027.test.ts`, `mutaciones-0027.test.ts`).
- **`packages/data/tests/catalogo.test.ts`: 4 de 65 tests en rojo, ESPERADO.** La clasificación de las
  once tablas ya está escrita en `clasificacion-campos.ts`, pero la migración `0027` todavía no está
  aplicada — el test que compara "tablas clasificadas" contra "tablas que existen en la base" ve once
  tablas fantasma. Se pone verde solo cuando se aplique la migración. No es una falla de diseño.
- `aislamiento-0027.test.ts` y `mutaciones-0027.test.ts`: escritos, siguiendo el patrón exacto de
  `aislamiento-0021`/`mutaciones-0021` (código SQLSTATE + nombre de constraint, nunca
  `rejects.toThrow()` a secas). **No corren todavía** — necesitan la migración aplicada contra la base
  local. Cubren: la equivalencia `rol_funcional`⟺`padron_socio_id` (D-25), que un renglón nunca es
  debe y haber a la vez, el gate de D-24 en sus dos capas (RLS + trigger, incluido el caso dispensado),
  y el `CHECK` de confirmación conjunta (`confirmado_en`+`confirmado_por`).
- Barrido de fuga: pendiente de correr antes de cualquier commit (mismo protocolo de siempre).
- **Nada se aplicó a ninguna base** — ni local, ni piloto. `CLAUDE.md` §1.9 sigue rigiendo completo
  para el paso siguiente.

## 5. Archivos de esta tarea

- `packages/data/migrations/0027_cierre_mensual.sql` (nuevo, sin aplicar).
- `packages/shared/src/seguridad/clasificacion-campos.ts` (11 tablas nuevas agregadas al registro).
- `packages/data/src/cierre/tipos.ts` (nuevo — solo tipos, nada de lectura/escritura: Capa D en sí es
  tarea aparte).
- `packages/data/tests/aislamiento-0027.test.ts`, `packages/data/tests/mutaciones-0027.test.ts`
  (nuevos, sin correr).
- Este documento.

## 6. Qué sigue

Avisar a JP con el `.sql` listo para su revisión. Si aprueba aplicarlo primero a local: `pnpm db:up &&
pnpm db:migrate && pnpm db:setup`, después `pnpm test packages/data/tests/aislamiento-0027.test.ts
packages/data/tests/mutaciones-0027.test.ts` y `pnpm test packages/data/tests/catalogo.test.ts` para
confirmar que los 4 rojos de hoy se ponen verdes. Recién después de eso — y con autorización puntual,
nunca implícita — se conversa sobre el piloto (`CLAUDE.md` §1.9).

> ⚠️ **Implicancia contable y fiscal.** Este esquema soporta un cierre contable con efecto directo
> sobre balance. `knowledge/` sigue sin RT de FACPCE cargada. **Validar con profesional matriculado
> antes de que esto produzca un asiento real.**
