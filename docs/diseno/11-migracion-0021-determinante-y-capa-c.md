# `0021` — el determinante de idempotencia, y capa C persistida

> 🔴 **PUNTO DE ENTRADA PARA RETOMAR SIN EL CHAT.** Este documento es el expediente completo de la
> migración `0021`: el plan aprobado, las mediciones, los **seis dictámenes del panel** y las decisiones
> del titular. Se escribió porque el plan anterior de `0021` se aprobó en sesión y **nunca se escribió**
> (`HANDOFF` 54: el archivo se sobrescribió con el de `0015`), y porque cuatro de los seis dictámenes
> existían sólo en la sesión que los produjo.
>
> Bitácora: `HANDOFF.md` entrada **69** (2026-08-17).
> Plan de sesión (fuera del repo, no autoritativo): `quirky-riding-music.md`.

---

## 0. Estado al cerrar la sesión del 2026-08-17

| | |
|---|---|
| `main` | `2065c3d`. ⚠️ `origin/main` sigue en `a95d24f` — nada pusheado, decisión del titular |
| Esquema local **y** piloto | **`0020`**, mismo hash, sin drift |
| Dueño del esquema | `sistema_contable`, `rolsuper = true` en los dos entornos (premisa **P-1**) |
| Piloto | 1830 movimientos crudos · 3 lotes · 3 clientes · **0 reconocimientos persistidos** · `padron_socio` **vacío** |
| Local | **0 movimientos**, 0 reconocimientos |
| PostgreSQL | **16.13** (local) |
| Gate | `pnpm verificar`: **62 archivos, 1440 tests, 0 fallas** |
| Aplicado a alguna base | **NADA.** P0 y P1 no tienen DDL |

**Trabajo en el árbol, sin commitear al escribir esto:** `packages/contabilidad/src/nucleo/entrada.ts`
(nuevo) · `packages/contabilidad/tests/entrada.test.ts` (nuevo, 17 tests) ·
`packages/contabilidad/src/index.ts` (barril) · `packages/contabilidad/version-del-motor.json`
(trinquete aceptado `--sin-bump`) · `HANDOFF.md` · este documento.

---

## 1. El problema

`reconocimiento_movimiento.motor_digest` es el determinante de idempotencia. Es `sha256` de la
proyección semántica del léxico ⊕ el catálogo alcanzable ⊕ `VERSION_DEL_MOTOR`
(`packages/contabilidad/src/nucleo/version.ts:148-172`): **cero bytes de la fila del cliente**.

Pero la entrada es **mutable**:

| Mutador | Columnas que reescribe |
|---|---|
| `packages/ingesta/src/reproceso/recapturar-conceptos.ts:349-358` | `concepto_banco`, `concepto_completo`, `concepto_banco_estrategia`, `pagina_pdf` |
| `packages/ingesta/src/reproceso/backfill-contraparte.ts:303-310` | `contraparte_captura` — **y no es de una sola vez**: es el mecanismo de re-hasheo cuando rote el pepper global |

Consecuencia declarada en `packages/data/src/contabilidad/escrituras.ts:298-302`: *un reproceso que
cambie `concepto_banco` sin cambiar la clase da no-op con la interpretación vieja intacta.* **Fail-open
y silencioso.**

**La entrada real del motor son 8 campos** (`packages/data/src/contabilidad/lecturas.ts:266-277`,
`EvidenciaDeMovimientoLeida`): `bancoCodigo`, `conceptoBanco`, `conceptoCompleto`,
`conceptoBancoEstrategia`, `conceptoCodigo`, `columnaOrigen`, `fecha`, `contraparteCaptura`.
**Cuatro de las cinco columnas mutables son entrada del motor** (`pagina_pdf` no lo es).

### La segunda mitad: el DDL de `0014` la exige

`0014_reconocimiento_persistido.sql:12` declara que **no** crea `padron_manifestacion` ni
`reconocimiento_contrapartida`, y `0014:426-432` declara el límite:

> *«dos corridas de capa C sobre el mismo movimiento con el mismo digest y un PADRÓN distinto colisionan
> acá y la segunda es rechazada… el determinante de capa C incluye el estado del padrón, y ese
> determinante lo crea 0015. Cuando exista, 0015 reemplaza esta unicidad por una que lo incluya.»*

**Esa `0015` nunca se escribió**: el número se lo comió el expediente de seguridad (incidente #1). Toda
referencia a «0015 crea la contrapartida» en el código —`0014:12`, `0014:429-430`,
`persistible.ts:135`, `reconocer-lote.ts:26`— es **texto obsoleto**.

---

## 2. Lo medido — P0 y P1

### 2.1 P0 — la medición que podía falsificar el plan, y no lo hizo

`packages/contabilidad/src/nucleo/entrada.ts` → `digestDeEntrada()`, puro, **por exclusión**, sin DDL.
Medido **sólo lectura contra el piloto**, por `conUsuario`, con el guard R18 y las dos compuertas de
`resolver-contrapartida.ts`. Salida: **sólo conteos**.

| Lote | Movs | Digests distintos | Cambia el digest | **…y la `clase` es la MISMA** | …y la clase cambia | No cambia |
|---|---|---|---|---|---|---|
| macro | 1346 | 236 | 1270 | **14** | 1256 | 76 |
| galicia | 326 | 168 | 326 | **40** | 286 | 0 |
| santander | 158 | 138 | 158 | **10** | 148 | 0 |
| **total** | **1830** | **542** | **1754** | 🔴 **64** | 1690 | 76 |

🔴 **64 movimientos del corpus real** habrían quedado con la interpretación vieja intacta y un `no_op`
silencioso. **Es la magnitud del bug, en filas medidas.**

**Control cruzado que valida el método:** los 76 que **no** cambian coinciden **exacto** con las 76
filas de `concepto_banco_estrategia = 'no_publicado'` contadas por SQL independiente — son las que nunca
tuvieron concepto capturado. Dos caminos, mismo número.

### 2.2 La prueba de mutación de P0 — 8 mutaciones, y una sobrevivió

| # | Mutación | Mata a | Resultado |
|---|---|---|---|
| M1 | la IDENTIDAD entra (se saca `movimientoId` de la exclusión) | (3) | ✅ |
| M2 | `bancoCodigo` entra | (4) | ✅ |
| M3 | **por INCLUSIÓN**: lista fija en vez de recorrer por exclusión | (6) | ✅ |
| M4 | separador pelado, sin prefijo de longitud | (7) | 🔴 **SOBREVIVIÓ** → test reescrito |
| M5 | el ausente colapsa a cadena vacía | (8) | ✅ |
| M6 | el digest no se recorta a 16 | (2) | ✅ |
| M7 | un campo REAL de entrada queda fuera | (5) | ✅ |
| M8 | longitud en unidades UTF-16 en vez de puntos de código | (11) | ✅ *(mutación nueva, ver abajo)* |

🔴 **M4 dejaba el test de inyectividad en VERDE.** El caso usaba `conceptoBanco` y `conceptoCodigo`, que
en el orden alfabético **no son adyacentes** —se interpone `conceptoBancoEstrategia`—, y la colisión de
un `join` con separador sólo existe entre campos **adyacentes**. El test no ejercía nada: misma falla
que `HANDOFF` (52) documenta para P0 de `0014`. Reescrito sobre la **propiedad** (campos adyacentes),
con la nota de que hoy el dominio cerrado de `conceptoBancoEstrategia` la vuelve inalcanzable — *se
enuncia sobre la propiedad, no sobre el caso* (lección de R25, R33, R36).

Y al reescribirlo apareció **M8, un defecto propio que nadie pidió buscar**: `texto.length` en
JavaScript cuenta **unidades UTF-16** y `length()` en Postgres cuenta **caracteres**. Con `.length`
pelado, la función y su gemela del DDL habrían divergido sobre cualquier fila con un carácter fuera del
plano básico, y P1 lo habría encontrado recién contra la base. Corregido a `[...texto].length`.

### 2.3 P1 — TS ≡ SQL, sin aplicar una línea de DDL

La expresión candidata corrió **como un `select`**, no como columna generada.

| | |
|---|---|
| Movimientos comparados | **1830** |
| TS ≡ SQL | **1830 / 1830** |
| Divergen | **0** |
| Digests distintos por TS / por SQL | **542 / 542** — el mismo número de P0 |

**Y la medición se probó rompiéndola:** con la expresión SQL mutada, **1270 de 1346 divergen** y los
digests distintos por SQL colapsan de 236 a 25.

La mutación además **reprodujo en vivo la trampa que motiva el enmarcado**: los 76 que seguían
coincidiendo son los de la rama `-:`, y el resto dio `NULL`, porque `md5(a || '|' || b)` **con un solo
operando NULL da NULL entero**.

---

## 3. Decisiones cerradas

### 3.1 Del titular

1. **Una sola migración `0021`** con las dos mitades (determinante + capa C).
2. 🔴 **`uq_recon_determinante` lleva `entrada_digest` y NO `padron_manifestacion_id`.** Cierra el bug
   medido en 64 movimientos y esquiva el fail-open denunciado por `motor-conciliacion-contable`. La
   manifestación entra **sólo como evidencia (FK)**. El límite fail-closed y ruidoso de `0014:426-432`
   **queda vivo**, y la mitad del padrón vuelve a ser deuda con su propia medición.
   > **Consecuencia que se sigue sola:** con la manifestación fuera, las cinco columnas de la unicidad
   > son **todas `not null`**, así que el `nulls not distinct` que `dba-data` midió como bloqueante **ya
   > no hace falta**. Se declara en el DDL *por qué no está*, y que vuelve a ser obligatorio el día que
   > la mitad del padrón entre.
3. **`resolucion_estado` es N2.**

### 3.2 De la medición (P0/P1), contra lo que el panel proponía

| Decisión | Contra qué | Motivo medido |
|---|---|---|
| El digest va sobre **`sign(importe)`**, no sobre `importe` | `dba-data` proponía `importe::text` | El motor **sólo** lee `columnaOrigen` (`motor.ts:46`); `EvidenciaDeMovimientoLeida` ni expone el importe. Un importe corregido de `-100` a `-150` no mueve una clasificación, e invalidar por eso entrena a la contadora a aceptar recálculos sin mirar |
| **`md5`**, no `sha256` | precedente de `version.ts` | La gemela vive en una generada que exige `IMMUTABLE`. `sha256` exige `bytea`, y `text::bytea` **reinterpreta** (`'ZZ\xGG'::bytea` → `22P02`; `'\101'::bytea = 'A'`). `convert_to(…,'UTF8')` no es `IMMUTABLE`. **`pgcrypto` no está instalado** y es no-core (ADR-0000 §2) |
| La fecha va como **`YYYY-MM-DD` armado con `lpad(date_part(…))`** | `dba-data` proponía `(fecha - date '2000-01-01')` | 🔴 **Medido:** `date_out` es STABLE, pero `date_part(text,date)` y `lpad` son **IMMUTABLE**, y una generada con `lpad(date_part('year',f)::text,4,'0') || '-' || …` **compila y produce `YYYY-MM-DD`** (verificado en tabla descartable, revertida). El rodeo era innecesario y obligaba a TypeScript a hashear un número de días |
| `bancoCodigo` **NO entra** | — | Ya cubierto por `motor_digest`, que es **por banco**; y vive en `lote_ingesta`, **otra tabla**, así que una generada no lo puede ver |
| `movimientoId` **NO entra** | — | Es la IDENTIDAD, no el contenido. Con él adentro, todo reproceso sería fila nueva |

### 3.3 El principio que resuelve la pregunta 1 del roadmap

> **El digest es función de lo que el motor lee, y lo que el motor lee ES `EvidenciaDeMovimientoLeida`.**

Por eso `digestDeEntrada()` recorre las claves de ese tipo **ordenadas y por exclusión**: `reconocer()`
no puede leer un campo que no esté ahí, así que «el digest cubre lo que el motor lee» no es una promesa,
es una consecuencia del tipo.

### 3.4 Correcciones a documentos del repo que quedaron demostradas

- 🔴 **`10-deuda-declarada.md` §0.0 A.1 apoya mal la pregunta 1.** Dice que el invariante tiene
  *«exactamente la forma»* de `path = f(parent_id, nid)` de `0017` y deriva «columna generada».
  **`0017_path_por_construccion.sql` NO usa una columna generada**: usa columna espejo plana + `CHECK`
  fila-local + FK compuesta `match full deferrable` + trigger (`0017:131, 180-182, 198-202, 213-232`).
  El precedente real de generada+`unique` es `0014:184` (`es_propuesta`), con **expresión inline pura**.
  En todo el repo **no hay una sola generada que invoque una función de usuario**.
- ⚠️ **`0018:58-59` afirma algo falso.** Dice que *«`revoke update (parent_id)` sobre un grant de
  columna existente no lo saca»*. **Medido, sí lo saca.** Lo que no funciona es `revoke` por columna
  sobre un grant de **tabla** (no-op silencioso), que es lo que dicen correctamente `0018:60` y
  `0020:107`. La **acción** de `0018` es correcta; la justificación primera está mal. `0018` está
  aplicada y **no se toca** — pero **la frase no se propaga a `0021`**.

---

## 4. Los seis dictámenes del panel

> Convocados con `Agent()` real (§3.1). `dba-data` y `security-engineer` midieron **todo** contra local
> (5442) en transacciones revertidas; **el piloto no se tocó**.
>
> **Adjuntos en el repo** (copiados del directorio de planes de la sesión, que no es durable):
> `adjuntos/0021-dictamen-dba-data.md` (con toda la evidencia ejecutada cruda),
> `adjuntos/0021-dictamen-arquitecto-software.md` y `adjuntos/0021-plan-de-sesion.md`.
> 🔴 **Los otros cuatro dictámenes NO tenían archivo: los resúmenes de §4.3 a §4.6 son la única copia
> que existe.** Están escritos completos a propósito, no como síntesis.

### 4.1 `dba-data` — medido contra local, PG 16.13

**Dictamen 1 — columna generada, pero en `movimiento_bancario_crudo`, no en la hija.** El hash de la
entrada es *estructuralmente imposible* como generada en `reconocimiento_movimiento`; vive como generada
donde la entrada está en la misma fila, y el reconocimiento toma una **foto histórica** con trigger
`BEFORE INSERT` + `not null`.

🔴 **Mató la FK que proponía `arquitecto-software`, midiendo (`F4`):**

```
### F4: UPDATE del concepto en el padre CON hijo vivo (on update restrict)
ERROR:  update or delete on table "src" violates foreign key constraint "child_fk" on table "child"
```

> **Una FK afirma un hecho PRESENTE; el determinante registra uno HISTÓRICO.**

Con `restrict`, el primer reconocimiento **congela `concepto_banco` para siempre** y
`recapturar-conceptos.ts` muere con `23503`. Con `cascade` es peor: reescribe en silencio el digest de
una interpretación **ya emitida**. Por eso el invariante baja hasta el **trigger y no más**.

🔴 **Y el trigger acá NO queda fail-open**, que era la objeción de `0014:684-688`. Ese trigger **CUENTA**
(sin filas visibles cuenta 0, falla ABIERTO); éste **COPIA** (sin filas visibles deja `NULL`, y el
`not null` rechaza). Medido con la tabla origen bajo `force RLS`:

```
### X1: insert legítimo (cliente visible)   -> INSERT 0 1, digest = 2bf13f5d3ffa15fe
### X2: movimiento que EXISTE pero la RLS OCULTA
ERROR:  null value in column "entrada_digest" ... violates not-null constraint
```

**Contar y copiar fallan en direcciones opuestas.** El `not null` es la mitad load-bearing: un `check`
solo no cierra nada, porque sobre `NULL` da `UNKNOWN` y pasa (`S4`).

**Volatilidad medida:** `md5`, `encode/decode`, `textcat`, casts numéricos → `IMMUTABLE`.
**`concat()`/`concat_ws()` son `STABLE`** y no entran. `date::text` y `timestamptz::text` tampoco.

**Dictamen 2 — sí se recorta el grant, pero la premisa de la pregunta es falsa.** Con la columna llenada
por trigger y `grant insert` de tabla, la mentira **se sobrescribe en silencio** (`M1`: el insert entra y
queda el digest verdadero). El recorte **no compra integridad** — compra que el intento falle
**ruidoso**. Y la lección de `via_depth` **no transfiere**: una generada no es falsificable ni bajo grant
de tabla (`cannot insert a non-DEFAULT value` — rechaza el **mecanismo**, no el privilegio).

🔴 **Pero el recorte va igual, por dos agujeros vivos HOY en `0014`:**

| Columna | Qué habilita hoy |
|---|---|
| **`created_at`** | Un tenant **ANTEDATA su propio reconocimiento**. H-B textual — lo que `0019:88-90` y `0020` §1 cerraron para `ocurrido_en`. Nadie lo escribe |
| **`superseded_por`** | Se puede insertar una fila **NACIDA SUPERSEDED**: sale de `uq_recon_vigente`, **nunca aparece en la cola**, y nada falla |
| `es_propuesta` | Postgres **acepta sin error** `grant insert` sobre una generada (`G1`). No hay red |
| `recalculo_disponible` | Sin productor (`0014` decisión 9) |

**Sintaxis, medida en ambas direcciones:** `revoke` a nivel **TABLA** + `grant` por columna. `revoke
insert (col)` sobre grant de tabla es **no-op silencioso** (`G5`); `revoke insert` de tabla **sí** limpia
los grants de columna sin residuo (`R1`).

**Hallazgo `nulls not distinct` (N1/N2)** — quedó **sin efecto** por la decisión §3.1.2, pero se
conserva: con `unique` clásico y una columna nullable en la tupla, **dos filas idénticas entran las dos**.

**Riesgo declarado:** el dueño superusuario **sí** falsifica la foto histórica
(`session_replication_role='replica'` saltea el trigger, `M4`) y la generada **no** (`M5`). Es **P-1**,
ya declarada. Se escribe *«no falsificable por `app_request` ni `app_job`»*, **no** *«no falsificable»*.

**No medido cuando se escribió este dictamen — MEDIDO después, ver §5.9:** el costo del
`ADD COLUMN … GENERATED` sobre las 1830 filas del piloto (rewrite con
`ACCESS EXCLUSIVE`). **Hay que tomarlo en local con el corpus cargado antes de tocar el piloto.**

### 4.2 `arquitecto-software`

**Aporte que desbloqueó el diseño:** la entrada del motor **sí es fila-local** — los 7 campos salen de
la misma fila de `movimiento_bancario_crudo`; el octavo (`bancoCodigo`) está cubierto transitivamente.

**Dictamen: columnas explícitas en la unicidad, NUNCA un hash enrollado.** Dos motivos independientes:
(a) un hash enrollado **no se puede atar por FK a nada**; (b) la composición dejaría de ser un hecho del
esquema, y cambiar qué entra sería un commit de TypeScript que invalida en silencio todo lo persistido,
sin migración y sin diff que alguien lea. *«Es `catalogo_version` con otro disfraz — lo objeté una vez,
lo objeto igual acá.»*

🔴 **Ya hay una cuarta y una quinta fuente de variación, descubiertas sólo por enumerar:** los
**candidatos de contraparte** (`movimiento_contraparte_identificador`, mutables, **en otra tabla** — no
los alcanza ninguna generada) y el **`pepper_id` de la corrida** (una rotación cambia el resultado de
capa C sin tocar código, fila ni padrón).

**`padron_digest`, si alguna vez entra, va sobre el padrón COMPLETO del cliente**, no sobre el
subconjunto que matchea — *el negativo depende de todo el espacio de búsqueda*. Analogía exacta:
**banco : catálogo :: cliente : padrón**.

🔴 **Restricción dura:** si el estado del padrón se calculara sobre `padron_socio_documento.documento`
(**N2-R**), **`reconocimiento_movimiento` entera cae al régimen de lectura auditada y la cola de revisión
se vuelve inusable.** (Converge con `seguridad-datos-financieros` por otro camino.)

**`motor_digest` no tiene ancla posible en la base, hoy ni nunca** — su referente es CÓDIGO. Cualquier
tabla que lo espeje mueve la mentira una tabla más allá. **Se declara así en el encabezado de `0021`.**

🔴 **Dos gates nuevos, sin los cuales el diseño es PEOR que la alternativa:**

1. **El DDL es por INCLUSIÓN y `version.ts` se construyó por EXCLUSIÓN a propósito.** Una columna nueva
   en `movimiento_bancario_crudo` que el motor empiece a leer **nace fuera del digest, en silencio**.
   Cierre: un test que lea `pg_attribute` y exija que toda columna esté **o** dentro de la expresión de
   la generada, **o** en una lista `COLUMNAS_FUERA_DEL_DETERMINANTE` **con su motivo escrito**. Es el
   mecanismo de `catalogo.test.ts:102-124`.
2. **`COMPONENTES_DEL_DETERMINANTE` en TS ↔ `conkey` de `uq_recon_determinante`.** Verificado: hoy
   **ningún test ata un `unique` a una constante de TS**.

**Objeción de alcance, registrada:** `reconocimiento_contrapartida` aparece **una sola vez en todo el
repo** (`0014:12`). No overrulea al titular —*«una sola migración es defendible por proceso: cada
migración es un evento de autorización sobre el piloto, y el incidente de `0019` costó caro»*— pero pone
la condición de que **su forma esté escrita y ratificada ANTES de abrir el `.sql`**. *«Lo que objeto no
es el número de archivos: es diseñar una tabla adentro de la migración que la aplica.»*

### 4.3 `seguridad-datos-financieros`

🔴 **1. El nombre de cada columna nueva es una decisión de seguridad.** El registro de
`clasificacion-campos.ts` clasifica **por nombre de columna, globalmente** (`ColumnaSensible` aplana el
mapeo sobre todas las tablas, `:822-830`). Una columna `clase` en N2 mete el literal `'clase'` en la
unión y hace que `redactar` tape **todo** campo llamado `clase` de todo log — incluido
`reconocimiento_movimiento.clase`, que es N1 a propósito y es lo que reporta la cola. Lección ya pagada
dos veces (`motivo` → `motivo_codigo`, `importe` → `importe_declarado`).
→ **`match_clase` y `resolucion_estado`, nunca `clase` ni `estado`.**

🔴 **2. Un `entrada_digest` sin pepper correlaciona entre clientes del mismo estudio.** Sin pepper,
`TRANSF JUAN PEREZ DOC20123456789` da el mismo digest en dos clientes; un `contador` con membresía en
ambos hace un join y obtiene las contrapartes compartidas **sin leer un solo CUIT**. Es la minería
cruzada que `hmac-identificador.ts:147-157` declara prohibida por decisión de negocio.

> ⚠️ **Verificado por quien conduce (§3.1 regla 5) y BAJA la severidad:** el ataque exige acceso RLS a
> los **dos** tenants, y `concepto_banco` es **N2, no N2-R**
> (`clasificacion-campos.ts:415-426`) — se lee directo bajo `conUsuario`, sin lectura auditada
> (`lecturas.ts:288-329` es un `select` plano). **Quien puede correlacionar por el digest ya puede
> correlacionar por la glosa misma, con mejor resolución.** Y el hallazgo, tal como está enunciado, **ya
> es cierto hoy de `fila_hash`** (N2, comparable, sin pepper), que este plan no creó.
>
> **Decisión: generada sin pepper**, clasificada **N2 / `exportable: false`** citando `fila_hash`. A
> cambio se conserva la no-falsificabilidad y el cierre del modo de falla de concurrencia.
> **Queda declarado, no cerrado:** el día que exista un rol que vea la cola de revisión **sin** ver los
> movimientos crudos, la premisa se cae y hay que revisitarlo.

**3. `socio_id` → N2, ratificado** (antecedente de `HANDOFF:1913-1914`, nunca aplicado porque era para
la `0015` que no se escribió). Con N1, el tipo `ColumnaSensible` **compila** `logger.info(…, {socioId})`
y el redactor no lo intercepta. Rompe `escrituras.ts:78-83` y `:161`, que van en la misma tarea.

**4. Qué de capa C NO se persiste:**

| Campo | Dictamen |
|---|---|
| `vigenteDesde` / `vigenteHasta` | **No van.** (a) duplican un hecho **mutable** (`0013:417` da `grant update (vigente_hasta)`) y divergen en silencio; (b) 🔴 con ellas adentro, `select resolucion_estado, socio_id, vigente_hasta` devuelve **la fecha de salida de cada ex-socio** desde la tabla que se lista entera todos los meses. `socio_fuera_de_vigencia` es un hecho de conflicto societario |
| `pepperIdsCandidatos` / `pepperIdsPadron` | **No van a la tabla** (son N1; van al log). `pepper_desalineado` es estado de la **plataforma**: durante una rotación la tabla se llenaría de miles de filas sin **un solo hecho del cliente** |
| texto libre en `padron_manifestacion` | **No va.** Es donde termina el nombre de un socio. Si hace falta, `motivo_codigo` cerrado |

**5. Régimen de auditoría: las tres tablas quedan fuera, y es mecánico.** Con cero columnas N2-R/N3,
`tablasQueExigenRolEnLectura()` (`:1009-1013`) las excluye **por derivación**. Si una sola terminara en
N2-R, la tabla entra sola en `tablasSinLectorAuditado()` y **el gate se pone rojo**.

🔴 **6. El rastro que contesta la pregunta forense no es un log: es una FK.** El día que una
manifestación resulte errónea, la pregunta no es *«¿quién la leyó?»* sino ***«¿qué propuestas se
apoyaron en ESTA manifestación?»*** — y eso lo responde `reconocimiento_contrapartida.padron_manifestacion_id`
en O(1), para siempre. Un rastro de lectura no lo responde nunca.

**7. Quién puede manifestar: `socio` y `contador`. El `administrativo` NO.** Precedente en la tabla
hermana, `0013:390-392`: *«decidir quién es socio de un cliente es criterio del contador»*. Manifestar es
la misma decisión un nivel más arriba: no dice *«esta persona es socia»*, dice **«no hay ninguna otra que
lo sea»**. El argumento de `0014:518-524` **no transfiere**: la manifestación no es una propuesta, es
**la premisa que cambia el resultado del motor** — el administrativo estaría fabricando la premisa que
convierte su propio trabajo en propuesta lista. **R38 en forma general.**

**8. El enunciado probatorio de `manifestado_por`, para el `comment on column`.** Vale: que alguien con
credencial de `app_request` y membresía habilitada sobre este cliente ejecutó esto en ese instante; la
**fecha no es elegible** (DEFAULT sin grant), el **cliente tampoco** (`0020` lo midió: otro estudio da
`42501`). **No vale:** identificar a la persona. 🔴 *Identidad declarada no es identidad autenticada.*
Por eso `manifestado_por` va `not null`, **sin `grant update`, sin `delete`**: una mala atribución
reescribible es estrictamente peor que el #8.

**9. El reemplazo del flag hardcodeado tiene una trampa de seguridad.** Si la lectura fuera *«¿existe
alguna manifestación de este cliente?»*, el flag pasa de `false` para siempre a **`true` para siempre** —
falla **ABIERTO y EN SILENCIO**, el defecto exacto que `0014` decisión 1 rechazó.

**10. Son dos pasos revertibles, no uno.** Mientras el flag esté en `false`, `padron_manifestacion` **no
cambia nada observable**. El cambio de `reconocer-lote.ts:288` **sí** — disparador (c) de §3.2.

**Dos hallazgos fuera de alcance:**

- 🔴 **H-1 — `loggerAcotado` no verifica su allowlist contra el registro.** `logger.ts:150-170` tipa los
  campos como `Partial<Record<Clave, ValorLoggeable>>` y hace `as CamposLoggeables`: **`Clave` no se
  intersecta con `ClaveProhibida` en ningún lado.** Con `socio_id` en N2 deja de ser hipotético —
  `alta-socio.ts:65-75` ya declara `'socio_id'` y lo emite en `:253` y `:294`: **siguen compilando**, y
  el redactor los degrada a `[REDACTADO]`, perdiendo el único asidero para depurar un alta **sin que
  nada avise**.
- 🔴 **H-2 — `resolver-contrapartida.ts:309` publica `sociosInvolucrados` a stdout sin redactor.**
  `process.stdout.write` lo esquiva. **El día que `socio_id` sea N2 —o sea, con `0021`— esa línea
  publica una lista N2 en stdout**, y `pnpm resolver:contrapartida > salida.json` deja en disco, sin
  clasificar y sin rastro, la lista de socios de un cliente. Arreglo recomendado: dejar sólo el conteo.

**No verificado:** 🔴 normativa — *«no tengo esa fuente cargada»*. `knowledge/_FUENTES.md:50` lista
secreto fiscal y protección de datos personales como material **pendiente**. No se afirma número de
norma, plazo de conservación ni deber de notificación.

### 4.4 `security-engineer` — todo medido contra local

🔴 **EL HALLAZGO MÁS PESADO — R6 deja de discriminar.** `catalogo.test.ts:332-335` sólo mira un índice
único si **alguna de sus columnas está clasificada N2/N2R/N3**. `motor_digest` es **N1** con buen
argumento. **Si el determinante nuevo se clasifica N1, un índice único GLOBAL sobre él pasa R6 en
verde** — y es un **oráculo cross-tenant vivo**. Medido en laboratorio, con A que **no ve** ninguna fila
de B:

```
A inserta un digest que B ya tiene   ->  23505 duplicate key ... "uq_lab_global"
A inserta un digest que no existe    ->  INSERT 0 1
```

Bajo RLS, Postgres **suprime el `DETAIL`** con los valores pero **no el nombre del constraint** — la
fuga es de existencia, y alcanza porque **el valor de sondeo lo elige el atacante**.

> *Es exactamente el caso que `CLAUDE.md` describe: un control impecable sobre el nivel de clasificación
> equivocado.*

**Regla nueva R40:**

> **Todo índice único que NO sea la clave primaria, sobre una tabla que tiene columna de tenant, incluye
> la columna de tenant.** Sin importar la clasificación de sus columnas, si es `create unique index` o
> `unique constraint`, ni la **posición** de la columna de tenant.

Enunciada sobre la **propiedad**. **Nace verde y sin excepciones:** los únicos sobre tablas con
`cliente_id` que no incluyen `cliente_id` son **16 y las 16 son la PK**; con `indisprimary = false` la
línea de base es **0 filas**.

**Prueba de mutación de R40 — 6 mutaciones + el caso legítimo:**

| # | Mutación | Debe dar | Qué refuta |
|---|---|---|---|
| 1 | único global sobre el determinante clasificado **N1** | **ROJO en R40, VERDE en R6** | **La única que prueba que R40 no es redundante con R6** |
| 2 | único global expresado como CONSTRAINT, no como INDEX | ROJO | Una implementación que barra sólo uno de los dos |
| 3 | `(motor_digest, cliente_id)` — tenant presente pero **NO primero** | **VERDE** (legítimo) | El ingenuo `cols[0] === 'cliente_id'` |
| 4 | índice **parcial** (`uq_recon_vigente` real) | **VERDE** (legítimo) | Una implementación que rechace todo índice parcial |
| 5 | barrido apuntado a un esquema vacío | **ROJO por vacuidad** | R39c: con el barrido roto, 1–3 pasarían sin mirar nada |
| 6 | único global sobre otra tabla con otra columna de tenant | ROJO | Una implementación acoplada a una tabla en vez de al catálogo |

🔴 **Incidente #7 REPRODUCIDO en laboratorio.** Con `bigint generated always as identity` + grant de
tabla, A inserta `OVERRIDING SYSTEM VALUE` con ids 2 y 3, y **el camino normal de B muere con `23505`**.
→ **PK `uuid`, no negociable.** Evita además la mitad *fuga* de H-A.

🔴 **El escritor de producción NOMBRA `id`** (`escrituras.ts:323-326`), porque la supersesión escribe
`superseded_por = <id nuevo>` **antes** del insert. **Copiar la forma de `0020` §1 al pie rompe
producción.** El riesgo residual es distinto del #7: `id` es `uuid default gen_random_uuid()`, y para
chocar hay que **adivinar 122 bits de CSPRNG de una fila que no se ve**. Riesgo aceptado y declarado.

**Orden de precedencia, medido:** `privilegio de columna (42501) → trigger BEFORE INSERT (P0001) →
policy RLS → FK/unique`. Confirma y amplía `0014:539-542`.

**El test que falta.** En todo el repo hay **un solo** test con cobertura inversa de conjunto cerrado
(`membership-supervision.test.ts:573`); los de `catalogo.test.ts:1158` y `:1194` usan `not.toContain`,
así que **una columna otorgada de más pasa verde**. Va un `toEqual` del conjunto **exacto** contra
`information_schema.column_privileges` — que sí expande un grant de tabla a una fila por columna (medido:
16 filas → 20). `has_table_privilege` **no sirve**: bajo grant por columna da `false`.

**`app_job`:** cero privilegios sobre toda tabla de dominio de Módulo 1 y 2 (medido). Ningún motivo de
`MotivoJob` alcanza a las tablas nuevas. 🔴 **La excepción a vigilar es `siembra_sintetica`** — el único
motivo que escribe dominio. **Dictamen: no se siembran estas tablas.**

**Defectos preexistentes reportados, que NO se arreglan acá:**

- **R11 se verifica por `proname` suelto** (`catalogo.test.ts:535-543`), sin esquema ni aridad: una
  sobrecarga o una homónima en el otro esquema pasa verde.
- **R7 ya es vacua bajo P-1** — 116 relaciones con owner `sistema_contable`, que tiene `bypassrls` por
  ser superusuario. El test sólo falla si el owner es `app_job`. **No marcar R7 ✅ por esto.**

### 4.5 `contador-dominio`

🔴 **D-1 (BLOQUEANTE) — el check de `arquitecto-software` es insatisfacible.**
`retiro_de_socio`/`aporte_de_socio` salen **exclusivamente** de la rama `es_socio` (`motor.ts:144-154`),
que es una de las ramas **sin** `padron_manifestacion_id`: toda fila `retiro_de_socio` sería rechazada.
Y **no es fila-local** — `tipo` vive en `reconocimiento_movimiento` y la manifestación en
`reconocimiento_contrapartida`; un `check` no cruza tablas. Además apunta al riesgo equivocado:
`es_socio` es el estado con evidencia **positiva**; la manifestación existe para respaldar la
**ausencia** de match.

**Reemplazo propuesto**, fila-local, usando `uq_recon_clase` (`0014:451`):

```sql
constraint contrapartida_promocion_chk check (
  (resolucion_estado in ('es_socio', 'es_tercero_padron_completo'))
  = (reconocimiento_clase = 'propuesta')
)
```

**D-2 — «se resuelve por join contra `padron_socio`» reconstruye la ventana de HOY, no la usada.**
`vigente_hasta` es actualizable (`0013:417`). No pide revertir la decisión de no duplicar; pide cerrarla
por el otro lado (ver `resuelto_a_fecha` y `recalculo_disponible`).

**1. Los cinco no promotores se distinguen; ninguno es ruido.** El criterio no es «¿es información?»
sino **«¿cambia lo que la persona tiene que hacer?»**:

| Estado | Qué tiene que hacer la persona |
|---|---|
| `sin_candidatos` | Buscar el comprobante. **No es un problema del padrón** |
| `sin_match_padron_incompleto` | Completar el padrón y manifestarlo. **La de mayor rendimiento** |
| `pepper_desalineado` | **Nada contable.** Es trabajo de sistemas |
| `multiples_socios` | Elegir cuál, o partir el movimiento |
| `socio_fuera_de_vigencia` | Decidir si la ventana está mal o si es un movimiento con un **ex**-socio |

🔴 **El caso que obliga:** `pepper_desalineado` confundido con `sin_match_padron_incompleto` produce la
conclusión errónea **con apariencia de diligencia** — la contadora abre el padrón, ve al socio cargado y
vigente, concluye «entonces esto es un tercero», y firma la conversión **con el padrón correcto
delante**.

**Y `match_clase` importa:** el CUIT/DNI identifica **a la persona**; el CBU identifica **una cuenta**,
que puede estar a nombre de otro, ser conjunta o haber cambiado de titular. *Un match sólo por CBU es
evidencia más débil y la persona tiene que verlo antes de aceptar.*

**2. Frescura de la manifestación — ratifica el núcleo y CORRIGE su propia formulación de la Ronda 1.**
«Una manifestación por corrida» era un proxy: **un control que se firma por reflejo dejó de ser un
control**. La regla correcta:

- **No caduca por reloj.** El tiempo no altera el padrón. Lo alteran (a) que cambie el conjunto de
  socios, y (b) que el movimiento sea posterior a lo que la manifestación abarca.
- **Alcance por `completo_hasta` (date, `not null`)**, no por lote ni por sesión. Valor por defecto
  sugerido: el cierre del período que se procesa. **Una manifestación no debería atravesar un cierre de
  ejercicio.**
- **Vínculo explícito, siempre**: la fila guarda el `id` de la manifestación en la que se apoyó, nunca
  «la última vigente» resuelta en tiempo de consulta.

**3. La enumeración de dos es correcta y completa.** `retiro_de_socio`/`aporte_de_socio` aparecen como
`tipo:` en **un solo lugar del repo**: `motor.ts:147`. `pago_a_proveedor_transferencia` sale de
`motor.ts:159` **más 14 filas** de `catalogo.ts`; `cobranza_de_cliente` de `motor.ts:159` **más 5**. No
son exclusivos y meterlos en el check rechazaría toda la capa B de transferencias.

**4. La consecuencia contable, ratificada y agravada.** Imputar un retiro de socio a Proveedores
**cancela un pasivo que no existe**. Activo total sin cambio, resultado sin cambio, **el balance cierra**
— el error es de contrapartida y de clasificación, no de importe, **por eso sobrevive**. Acumulativo:
Proveedores subvaluado y la cuenta particular sin registrar el retiro.

🔴 **Ningún control aguas abajo lo detecta antes del cierre.** La **conciliación bancaria es ciega** (la
cuenta Banco queda idéntica; el error está del otro lado del asiento). El único control automatizable que
lo ataja es el **cotejo con comprobante de respaldo** — un pago a proveedor sin factura ni orden de pago.

🔴 **La asimetría que fija el diseño:** el error **inverso** (tercero tratado como socio) es **ruidoso**
— deja un saldo en la cuenta particular que **el socio mismo reclama**. El error socio→proveedor **no
tiene quien lo reclame**. Por eso el sistema debe ser fail-closed hacia «no promover a tercero», y **la
evidencia persistida de capa C es el control compensatorio de un error que no tiene detector**.

⚠️ **Corrección de alcance que fija la prioridad:** hoy `reconocer-lote.ts:288` pasa `false` fijo, así que
**el error del punto 4 NO es alcanzable — y se vuelve alcanzable exactamente el día que la manifestación
exista.** Corolario: **la regla de frescura no puede quedar para después; nace en la misma migración o no
nace.**

**Necesitaría fuente y no la tiene cargada:** naturaleza/valuación/exposición de la Cuenta Particular de
Socios (RT de FACPCE + adopción del Consejo de la jurisdicción); impacto fiscal (crédito fiscal de IVA
computado indebidamente, disposición de fondos a favor de terceros en Ganancias); plazos de conservación
del rastro. 🔴 **La forma societaria de los tres clientes del piloto: no la sabe y no la asume** — importa
para **capa D**, no para esta migración. *Validar con profesional matriculado.*

### 4.6 `motor-conciliacion-contable`

🔴 **DISCREPANCIA (BLOQUEANTE, y el titular la resolvió a su favor): `padron_manifestacion_id` NO puede
ir en la unicidad.** Si cada corrida inserta una manifestación nueva **y** la manifestación está en el
determinante, **toda corrida produce fila nueva siempre**: se acaba el no-op de `05` §5.2, se supersede
en cada pasada un reconocimiento que no cambió, y **cada supersesión se lleva puesta la decisión que la
contadora ya registró**. Convierte un límite **fail-closed y ruidoso** en un **fail-open silencioso**.

> ⚠️ Nótese que `contador-dominio` **corrigió en este mismo panel** la premisa «una manifestación por
> corrida» (ver 4.5 punto 2). Con manifestaciones estables la objeción pierde fuerza — pero el titular
> decidió igual dejar la manifestación **fuera** de la unicidad (§3.1.2).

**1. Una tabla + satélite.** El argumento de `0013` §2 / `0014:662-688` aplica **con más fuerza que en el
precedente que lo fundó**: `reconocimiento_candidato.entrada_lexico_id` no podía tener FK (el léxico es
código); acá el elemento es **`socio_id`, una fila real de `padron_socio`**. Un `uuid[]` admitiría un
match apuntando a un socio de **otro cliente** sin que nada falle.

**La FK, exacta.** En el padre:

```sql
admite_matches boolean generated always as
  (resolucion_estado in ('es_socio','multiples_socios','socio_fuera_de_vigencia')) stored,
constraint uq_recon_contrapartida_admite unique (cliente_id, id, admite_matches)
```

y en la satélite `admite_matches boolean generated always as (true) stored`, con
`foreign key (cliente_id, contrapartida_id, admite_matches)`. Es literal el idiom de `0014:671-679`: **la
columna hija no se puede escribir ni con el valor correcto**.

🔴 **`socio_id` NO va también en el padre.** Para `es_socio` los matches apuntan **todos al mismo socio**
por construcción (`contrapartida.ts:231-244`), así que sería una copia — y una que la base **no puede**
mantener sincronizada. *«Capa D imputaría a la cuenta particular del socio A mientras la evidencia que ve
la contadora dice B, en silencio, con plata adentro.»* Sin la columna, un `es_socio` con ≠1 socio distinto
**falla ruidoso en la lectura**.

**2. Una fila por cada resolución que `resolverContraparte()` produjo** — los 7 estados, `sin_candidatos`
incluido. 🔴 **El argumento decisivo:** con `padron_socio` en **0 filas** en el piloto, el 100% de las
resoluciones cae hoy en `sin_candidatos` o `sin_match_padron_incompleto`, y **ninguna promueve**. Con la
regla «sólo cuando hay algo que decir», `reconocimiento_contrapartida` **nace y se queda vacía** contra
los 1830 movimientos. *Una tabla de evidencia que no se puede verificar corriéndola es el artefacto que
dice una cosa y hace otra.*

**Sobre H-8:** no aplica. `0014:90-97` argumenta contra meter estas tablas en el **régimen auditado**;
una fila de negocio por evaluación no es un evento de auditoría. El denominador no es 1830 sino
**≈1150-1500** (capa C sólo se invoca sobre `decision_humana` + `distinguir_tercero_de_socio`).

**Predicción falsable propuesta para `0021`** — dos números por caminos independientes:

```
count(reconocimiento_contrapartida)                              == reporte.porQueDecide['distinguir_tercero_de_socio']
count(... where resolucion_estado='sin_candidatos')              == reporte.contrapartidaSinCandidato
```

*Si no coinciden, hay un movimiento marcado `capturado` sin fila en
`movimiento_contraparte_identificador`, o al revés — un defecto real de ingesta que hoy nada detecta.*

**3. «Capa C corrió»: la fila ES el hecho.** `ReconocimientoFinal` (`persistible.ts:107-117`) afirma *«el
pipeline ofreció las dos capas»*, no *«se evaluó este movimiento»* — se llama sobre **todos**
(`reconocer-lote.ts:307-310`). Presencia de fila = capa C evaluó; ausencia = no. **No** un
`capa_c_corrida boolean` en `reconocimiento_movimiento`: sería una tercera columna actualizable en una
tabla cuyo grant de UPDATE es por columna justamente para cerrar ese camino.

**4. Sin score, y acá con más razón que en capa B.** En capa B la vía **es** una gradación ordenada
(`05:117-124`). En capa C la comparación es `hmacIguales(...)`: **igualdad de 32 bytes**. No hay nada
entre «igual» y «distinto». ⚠️ **`match_clase` tiene hoy un solo valor alcanzable, `'cuit'`, por
construcción** (`contrapartida.ts:189-191`): `hmacDocumento` canoniza al dominio `cuit_cuil` y
`padron_socio` sólo admite ese. **Va igual, con su check sobre los tres, y ANOTADA** — una columna que
parece llevar información y lleva una constante es peor que no tenerla.

**5. La fila de contrapartida NO tiene determinante propio.** Es 1:0..1, inmutable, insertada en la misma
transacción; hereda idempotencia y supersesión del padre.

| Caso de reproceso | Veredicto | Por qué |
|---|---|---|
| (a) mismo léxico, padrón, entrada | **no-op** | Ya funciona: `escrituras.ts:303` compara digest **y** clase |
| (b) padrón con un socio nuevo | **fila nueva sólo si cambió la respuesta de ESTE movimiento** | Superseder ~1150 porque se cargó un socio ajeno re-encola trabajo hecho |
| (b′) el mismo socio se da de baja después | **error ruidoso** | `ReconocimientoDigestYaEnLaCadenaError` — *«volver a un estado histórico es una decisión humana»* |
| (c) `concepto_banco` recapturado sin cambio de clase | **debe ser fila nueva; hoy es no-op silencioso** | Es **exactamente lo que P0 midió: 64 movimientos** |
| (d) rotación de pepper | **debe ser fila nueva; hoy es no-op silencioso** 🔴 | `sin_match_padron_incompleto` → `pepper_desalineado` es `decision_humana` → `decision_humana`, mismo digest |

🔴 **El agujero que destapa:** el no-op de `escrituras.ts:303` es **ciego a los cambios de estado dentro
de `decision_humana`**. **Mitigación de costo cero que sí cabe en `0021`:** que `reconocer:lote` **cuente
y reporte** los movimientos cuyo `resolucion_estado` recalculado difiere del persistido, **sin escribir
nada**. Vive en el CLI, no en el esquema.

**6. Seis de siete estados sin productor: aceptable, con dos condiciones.** Corrección del conteo:
**un solo estado está bloqueado por código** (`es_tercero_padron_completo`, por `reconocer-lote.ts:288`);
cuatro esperan que alguien cargue un socio; y **dos se llenan en la primera corrida**
(`sin_candidatos` — 941 movimientos con `sin_identificador` — y `sin_match_padron_incompleto`). *La tabla
nace **ejercitada**, no vacía.*
**Condición 1:** anotación estado por estado en el DDL (precedente `recalculo_disponible`).
**Condición 2:** el check va sobre **los 7**, jamás sobre «los alcanzables» — literal `0014` decisión 7.

---

## 5. Las dos diferencias — RECONCILIADAS (2ª ronda del panel, 2026-08-17)

> Se convocó una **segunda ronda** con `Agent()` real: `contador-dominio` y
> `motor-conciliacion-contable` con la posición del otro puesta enfrente, más `dba-data` (¿la base
> sostiene cada forma?) y `seguridad-datos-financieros` (obligatorio, §3.1). Los cuatro con
> prohibición de escribir archivos. Lo de abajo **reemplaza** el enunciado original, que quedó
> demostrado como **mal redactado**.

### 5.1 🔴 Diferencia 1 — NO EXISTÍA. La `§5` original registró como bloqueante una coincidencia

La frase *«fila cuando hay algo que decir»* **nunca estuvo en el dictamen de `contador-dominio`**.
Verificado por grep sobre `docs/`: aparece dos veces, y las dos son **§4.6 caracterizando la posición
ajena** y **§5 copiando esa caracterización**. Lo que §4.5 punto 1 dice es *«los cinco no promotores se
distinguen; ninguno es ruido»* — cinco no promotores + dos promotores = **los siete**. Los dos agentes
sostenían lo mismo desde el principio.

**DECISIÓN: una fila por cada evaluación de capa C, los SIETE estados.** Cuatro motivos, en orden:

1. 🔴 **La regla se enuncia POR EVALUACIÓN, no por estado** — y acá sí había un residuo real. Las dos
   formulaciones tienen hoy la **misma extensión** y distinta **intensión**: la regla por estado deja
   que un octavo estado futuro «que no diga nada» nazca sin fila y rompa **en silencio** la lectura
   «presencia = capa C evaluó». Va con esas palabras al `comment on table`.
2. 🔴 **La opción rala convierte la PRESENCIA DE FILA en un predicado N2 legible sin tocar una columna
   N2** (`seguridad-datos-financieros`). Con la regla rala,
   `select movimiento_id from reconocimiento_contrapartida` —sólo columnas N1— devuelve *«qué
   movimientos tienen que ver con un socio»*. El dato viaja en la **cardinalidad**, así que sobrevive a
   todo grant por columna, a todo enmascarado y a todo export que «omita las columnas sensibles». Con
   la regla densa la presencia equivale a `que_decide` (N1): información marginal **cero**.
   **La opción con más filas es la que expone menos.**
3. **`0021` no cerraría su propia deuda declarada.** `persistible.ts:130-136` dice que hoy *«los cinco
   estados que NO promueven quedan indistinguibles entre sí»* y que lo cierra esta migración. Con la
   regla rala, `sin_candidatos` seguiría indistinguible de «capa C no corrió».
4. **No hay costo que lo justifique** (`dba-data`, medido sobre **234.000 filas** = 15 años de corridas
   mensuales del piloto): **83 MB**, **232 ms** por corrida de 1300 inserts (17 ms sin los 4 únicos),
   `Heap Fetches: 0` en la consulta de la cola, y **bloat máximo cero** porque la tabla no admite
   `update` ni `delete`. Y la supersesión **no es por corrida sino por cambio**: el no-op de
   `escrituras.ts:303` corta antes del insert, así que una corrida que no cambia nada escribe **0**
   filas, no 1300.

**Lo que el código ya decía y ningún dictamen de la 1ª ronda usó:** `aplicarContrapartida()`
(`motor.ts:143-174`) adjunta `evidenciaContrapartida` en **los siete** estados. El modelo en memoria ya
tiene una fila por evaluación; la regla rala habría introducido una asimetría que el código puro no
tiene.

### 5.2 Diferencia 2 — `socio_id` SÓLO EN LA SATÉLITE. Los cuatro convergen, y el fundamento cambió

Los dos agentes **cambiaron de posición**: `motor-conciliacion-contable` retiró su argumento
(*«sería una copia»*) al notar que la propuesta del otro no duplicaba nada —escalar en el padre para
`es_socio`, satélite sólo para los múltiples—, y `contador-dominio` **retiró la columna**:
*«una copia sólo aporta si puede diferir; si puede diferir es un riesgo; si no puede diferir es
redundante»*.

🔴 **Lo que decide no es ninguno de esos dos argumentos, sino la medición de `dba-data`** contra
PG 16.13 — los **cuatro** mecanismos posibles, y ninguno sostiene la consistencia:

| Mecanismo | Resultado medido |
|---|---|
| `check` con subconsulta | `cannot use subquery in check constraint` |
| FK satélite→padre por `socio_id` | Sostiene el invariante correcto pero vuelve **inexpresables** `multiples_socios` y `socio_fuera_de_vigencia` con 2+ socios (`23503`). Mismo defecto de forma que **D-1** |
| FK padre→satélite | Obliga a recortar la unicidad y **tirar `match_clase`** (medido: el mismo socio por CUIT y por CBU se rechaza) — y **aun así** no atrapa un segundo socio distinto en la satélite |
| Trigger que cuenta | Valida el instante del insert del padre **y nunca más**: medido que una transacción **posterior** agrega un segundo socio a una fila ya validada y **nada falla** |

Sin la columna, `es_socio` tiene un solo socio **por construcción** (`contrapartida.ts:231-244`) y un
`≠1` **falla ruidoso en la lectura**. 🔴 **La mutación que lo prueba es sobre la EXCEPCIÓN, no sobre el
conteo:** cambiar `left join` por `join` hace **desaparecer** la fila en vez de fallar, y un test de
conteo quedaría **verde**.

### 5.3 🔴 Dos diferencias NUEVAS que la 1ª ronda no vio, y una de ellas abortaba el piloto

**(a) La nulidad de `padron_manifestacion_id` — CERRADA en forma BINARIA ESTRICTA.**
`0021-plan-de-sesion.md:369` la fijaba `not null` en `es_tercero_padron_completo` **y** en
`sin_match_padron_incompleto`. Los tres agentes la encontraron **insatisfacible por separado**
(`contador-dominio` la llamó *D-1 bis*), y `dba-data` la midió: **rechaza el 100% de lo que el motor
produce hoy** — la primera corrida de `reconocer:lote --aplicar` contra el piloto **abortaría el lote
entero**. Es la misma clase de defecto que D-1: un constraint insatisfacible para una rama que el motor
produce.

```sql
constraint contrapartida_manifestacion_chk check (
  (resolucion_estado = 'es_tercero_padron_completo') = (padron_manifestacion_id is not null)
)
```

`contador-dominio` **ratificó la forma binaria y retiró la laxa** que él mismo había propuesto, con el
argumento que la cierra: la rama laxa **no tiene caso legítimo ejercitable** — el gate entra como
`boolean` pelado (`contrapartida.ts:166`) y `ResolucionDeContraparte` **no tiene dónde alojar** cuál
manifestación se consultó, así que un `sin_match_padron_incompleto` con manifestación no es difícil de
producir: es **inexpresable en el tipo que ES la evidencia**. Y el costo futuro es **cero, verificado**:
para hacerla producible hay que tocar `contrapartida.ts`, que está **dentro** de `huellasDelMotor()`
(`NO_ENTRAN` sólo excluye `catalogo.ts` y `version.ts`, `version-del-motor.ts:78-91`) — o sea que la
relajación viaja obligatoriamente con un bump de `VERSION_DEL_MOTOR`. **Una binaria escrita hoy no puede
volverse silenciosamente equivocada.**

**(b) El ancla de la satélite — CERRADA en una COMPOSICIÓN, que no es el DDL de ninguno de los dos.**
`dba-data` midió `admite_matches boolean` y funciona (`A1`–`A7`: la generada `stored` sirve del lado
**referenciado** de un `unique` usado por FK, y la hija `generated always as (true)` **no se puede
escribir ni con el valor correcto**). `motor-conciliacion-contable` propuso `regimen_matches` de **tres**
valores, que compra la **cardinalidad ≤1 de `es_socio` garantizada por la base** vía índice único
parcial, **sin** `socio_id` en el padre.

🔴 **Medido que hacen falta LAS DOS, y por qué:**

| Mecanismo | Qué garantiza | ¿Falsificable? |
|---|---|---|
| `admite_matches` generada + FK | el padre **admite** matches | No: rechaza el **mecanismo**, no el valor (`I4.8`) |
| `regimen_matches` escribible + FK | el régimen declarado **es** el del padre | No: la FK rechaza el valor (`I3.1`, `I3.2`) |
| índice único parcial | **≤1 fila** bajo `socio_unico` | No (`I4.4`) |

**`I3.4` es la medición que obliga a conservar la booleana:** con `regimen_matches` sola, un match
`sin_matches` colgado de un `sin_candidatos` **lo rechaza el `check`, no la FK** —el padre
`sin_candidatos` **existe** en el único con el valor `'sin_matches'`, así que la FK lo aceptaría—, y al
mutar el `check` **entra**. O sea: la forma de una sola FK vuelve el `check` **load-bearing**, que es
literalmente el defecto que `0014:671-679` describe para justificar la generada constante. Con las dos
FK (`I4.6`), ese caso lo rechaza la **FK booleana**, por mecanismo, y el `check` pasa de garantía a
cinturón. Va igual, con el `comment on constraint` diciendo que **no** es el control.

**No se puede resolver con una generada en la hija:** `cannot use subquery in column generation
expression` (`I4.1`) — una generada es fila-local por definición y no puede derivar el régimen del padre.

### 5.4 🔴 Diferencia CUATRO — el índice parcial garantiza «≤1 FILA», no «≤1 SOCIO»

Apareció **sólo al medir** (`I2.3`) y es la única con costo funcional real. «≤1 socio distinto entre N
filas» **no es expresable como `unique`** en PostgreSQL — medido por los dos caminos posibles (`I2.3` y
`B4.5`). El índice garantiza *≤1 fila*, así que **un mismo socio matcheando por dos vías (CUIT y CBU)
—un solo socio, dos filas— es rechazado con `23505`.**

**VOTO de `contador-dominio`: VA el índice.** Y la razón por la que no resigna nada de su §4.5 es la
distinción que él mismo hizo: su advertencia era sobre el match **sólo por CBU** —el más débil—, que es
**una sola fila** y **el índice no lo toca**: entra y la persona lo ve. Lo que el índice bloquea es
**CUIT + CBU juntos**, el caso **corroborado**, el más fuerte. 🔴 **El índice cuesta corroboración sobre
evidencia fuerte, nunca la alerta sobre evidencia débil.**

Lo que el índice impide es el error que §4.5 marcó **sin detector aguas abajo y sin reclamante** — capa D
imputando a la cuenta particular de un socio mientras la evidencia nombra a dos; la conciliación bancaria
es ciega (la cuenta Banco queda idéntica), el balance cierra, y a diferencia del error inverso **nadie lo
reclama**.

🔴 **CONDICIÓN DURA — la pérdida se acepta como ABORTO RUIDOSO, jamás como deduplicación silenciosa.**
Lo medido es que el índice **rechaza con `23505` y aborta el lote**, no que «se persista una sola vía».
El día que el multi-vía sea alcanzable, **la aplicación NO deduplica para satisfacerlo**: que el `23505`
suba. Deduplicar sería persistir una vía y descartar la otra sin decirlo — **el patrón `galicia.ts`**, y
estrictamente peor que no tener el índice, porque la contadora vería una vía creyendo que es toda la
evidencia. Misma figura que `resuelto_a_fecha`: **detector de cambio, no restricción a satisfacer.**

**El índice NO retira el invariante de lectura.** Garantiza `≤1`, **no `≥1`**: un `es_socio` con **cero**
filas satélite sigue siendo insertable y dejaría a capa D sin sujeto. `ContrapartidaEsSocioSinMatchError`
y su test **siguen siendo obligatorios**. Índice (`≤1`) + excepción de lectura (`≥1`) = exactamente 1.

⚠️ **Corrección al fundamento de la inalcanzabilidad, verificada — el guardián NO es el que se citó.**
Se había atribuido a que `uq_mov_contraparte_candidato` excluiría dos candidatos con el mismo hmac.
**No lo hace:** `0013:191-192` lleva **`clase` en la clave**, así que dos filas con el mismo hmac y
distinta clase pasan. Lo que vuelve inalcanzable el multi-vía es la **separación de dominios de hash**:
`movimiento_contraparte_identificador.identificador_hmac` se deriva con dominio `(cuit_cuil|dni|cbu)`
según la clase (`0013:257-259`) y `padron_socio.documento_hmac` usa **sólo** `'cuit_cuil'` (`0013:294`).
🔴 **Importa y no es pedantería:** el día que alguien unifique el dominio de hash para que un CBU del
padrón pueda matchear, **`uq_mov_contraparte_candidato` no lo va a frenar** — y quien crea que esa
unicidad es el guardián va a hacer el cambio pensando que está cubierto.

### 5.5 🔴 El error que cometieron TRES agentes por separado, y lo que se llevó puesto

`contador-dominio`, `seguridad-datos-financieros` y `dba-data` afirmaron, **cada uno por su lado**, que
`movimiento_bancario_crudo.fecha` es inmutable. Los tres grepearon `grant update` —la **sintaxis** por
columna— en vez de la **capacidad**. Hay un grant de **TABLA**, nunca recortado:

```
packages/data/migrations/0004_ingesta.sql:502
grant select, insert, update, delete on movimiento_bancario_crudo to app_request;
```

**`fecha` es actualizable por `app_request`.** Sobre esa premisa falsa, `seguridad-datos-financieros`
propuso blindar `resuelto_a_fecha` con una FK compuesta contra `unique (cliente_id, id, fecha)` — que es
**exactamente la FK que `dba-data` ya había matado midiendo en `F4`** (con `restrict` congela la fecha
del movimiento para siempre; con `cascade` reescribe el parámetro de una evaluación ya emitida) — y
`dba-data` construyó sobre ella su razón para **no** incluir la columna. **Las conclusiones de dominio
sobrevivieron; los mecanismos propuestos para sostenerlas, no.**

> **Corolario que excede `0021`** (`contador-dominio`, y queda como ítem para `tech-lead` +
> `qa-automation`): el barrido de grants debería enumerar **capacidades efectivas** por rol y columna
> vía `information_schema.column_privileges`, no textos de migración. Tres agentes independientes
> fallaron igual porque verificaron contra la **forma del artefacto** en vez de contra el **hecho**.

### 5.6 `resuelto_a_fecha` — ENTRA, escrita por la aplicación

**Entra**, y sobre la premisa correcta. El argumento de `motor-conciliacion-contable` para no incluirla
—*«la fecha entra en `entrada_digest`, así que un cambio se supersede solo»*— cubre que cambie **el
valor de la columna**, no que cambie **cuál columna se lee**. Verificado: `huellasDelMotor()` recorre
**sólo** `packages/contabilidad/src/nucleo/*.ts` (`version-del-motor.ts:68,116-124`), así que
`apps/cli/src/reconocer-lote.ts` está **fuera**; y la expresión de §7 lee `m.fecha`, **no**
`m.fecha_valor` (que existe y es N2, `clasificacion-campos.ts:398`). El día que alguien cambie
`reconocer-lote.ts:288` de `ev.fecha` a `ev.fechaValor`, **no se mueve ningún digest** y las filas
históricas quedan indistinguibles de las nuevas.

🔴 **NO por trigger y NO por FK.** El trigger `BEFORE INSERT` que copia `movimiento.fecha` que propuso
`dba-data` garantizaría la igualdad **por construcción** — y así elimina justamente el grado de libertad
que la columna existe para observar: seguiría escribiendo `movimiento.fecha` mientras el motor evalúa
con otra, **afirmando con total confianza el parámetro equivocado**. La FK está muerta por `F4`.

**Forma:** `resuelto_a_fecha date not null`, **sin default, sin trigger, sin FK, sin `grant update`**,
escrita por la aplicación. **N2**, espejando `movimiento_bancario_crudo.fecha` (`:397`); no arrastra la
tabla al régimen auditado. **El control es un test que asserta `resuelto_a_fecha = movimiento.fecha`** —
que se pone rojo exactamente el día que alguien cambie el criterio, que es **el evento a detectar**. Con
las tres condiciones de `contador-dominio`: (1) corre sobre una corrida que **el propio test produce**,
nunca contra el histórico del piloto —si no, un cambio legítimo lo deja rojo para siempre sobre filas
que **deben** conservar su valor viejo, y alguien lo borra—; (2) su **mutación** obligatoria es pasar
`ev.fechaValor` y verificar el rojo, con la corrida normal como caso legítimo; (3) va anotado como
**DETECTOR DE CAMBIO, no como restricción**: el día que se ponga rojo la respuesta correcta es **decidir
el criterio contable** (`fecha` de operación vs. `fecha_valor` de acreditación — cuestión abierta de
devengamiento, *«no tengo esa fuente cargada»*), **nunca** «arreglarlo» volviendo atrás.

### 5.7 `completo_hasta` — ENTRA en `0021`. Visto de `product-owner` y `ux-designer`

Los dos ratificaron, y `product-owner` con un motivo de alcance que ningún dictamen anterior había
puesto: 🔴 **la columna no agrega un evento de autorización, lo EVITA.** `padron_manifestacion` ya entra
en `0021` por la FK de P4, y dentro de esa misma migración la columna cuesta cero (tabla vacía, sin
backfill, sin productor que romper). Dejarla para P5 convertiría P5 —hoy **un cambio de código de una
línea**, revertible en local— en **un cambio de esquema con su propia autorización sobre el piloto**.
*El recurso escaso acá no es la columna: es el evento de autorización*, y el incidente de `0019` es la
factura. `not null` sin default: ratificado — con **cero productores** hoy, «bloquea el alta» es una
objeción vacía, y `null`-permitido-y-endurecer-después es la peor de las tres opciones porque **paga la
migración extra Y deja el esquema permitiendo la premisa sin alcance**.

🔴 **`ux-designer` ratifica la columna y RECHAZA la captura tal como estaba imaginada**, y esto es
condición de P5, no del DDL: *«"el padrón está completo HASTA tal fecha" le pide a la contadora que
acote su propia ignorancia — y eso no es un dato que ella tenga»*. El hecho que sí tiene es **quiénes
son los socios**; lo que no puede tener es la garantía de que no se le escapó nadie. Puesta como campo
`date` obligatorio, se llena con **el valor que deje pasar el formulario** — y el incentivo es
asimétrico: **una fecha corta la obliga a volver, una fecha larga la deja tranquila, y nada penaliza
`2030-12-31`**. Agravante verificado: **hoy no hay pantalla**, así que «el formulario» sería
`--completo-hasta 2026-12-31` en una terminal, sin la lista de socios delante y quedando en el historial.

**La formulación que sí puede contestar:** no preguntar una fecha — pedir que **confirme la lista de
socios para el período que está procesando**, con la consecuencia contable escrita al lado (*«si falta
alguno, sus retiros se van a proponer como pagos a Proveedores en vez de Cuentas particulares»* — que es
literalmente su control de todos los meses). `completo_hasta` se **deriva** del período del lote, no se
tipea; el techo por cierre de ejercicio se **calcula** (no es diciembre y es distinto por cliente).
Condiciones que quedan para P5: **el camino «no declaro» entero y sin castigo** (si declarar fuera
requisito para recibir el Excel, va a declarar cualquier cosa: *la manifestación es un desbloqueo, jamás
un peaje*); **nada de flag `--completo-hasta`** —si hace falta CLI antes de la pantalla, TTY obligatorio
al estilo `prompt-oculto.ts` y la lista fuera de `stdout` redirigible, que es H-2—; y **falta un
entregable que no estaba en el plan: la pantalla de la revocación** (*«¿qué propuestas se apoyaron en la
declaración vieja?»* — si nadie construye esa vista, la FK justifica su costo en teoría y no devuelve
nada en la práctica).

### 5.8 🔴 La frescura BAJA A LA BASE — y la forma obvia tenía el control desactivado adentro

`contador-dominio` había dado el invariante `completo_hasta >= resuelto_a_fecha` por **no expresable**
(«cruza dos tablas»). **Sí lo es**, con espejo + `unique` de columnas exactas + FK compuesta + `check`
fila-local: es `0017` literal (`parent_path`), y el propio `0017:50-58` da la razón de fondo — *Postgres
exime a `check`/`unique`/`foreign key` de la RLS por diseño; los triggers no*.

**Por qué acá la FK sobrevive al teorema que mató a las otras dos** (`F4`, y la de `resuelto_a_fecha`
contra `movimiento.fecha`): **el referente es append-only**. `padron_manifestacion` nace sin `update` ni
`delete`, **por privilegio y por policy**, dos mecanismos independientes — verificado *como capacidad y
no como sintaxis*: cero `alter default privileges` en todo el repo. El corolario que completa el
teorema: 🔴 **cuando el referente es append-only, el hecho presente y el histórico son el MISMO hecho, y
la objeción desaparece con él.** Y el `23503` al intentar un `UPDATE` de `completo_hasta` no es el modo
de falla de `F4` — allá el `UPDATE` era un camino **legítimo y vivo** (`recapturar-conceptos.ts`); acá
está **prohibido por diseño**, así que la FK **mecaniza una decisión tomada** en vez de pelear contra una
operación real.

🔴 **Y la forma obvia tenía el control desactivado adentro.** Medido: con `match simple` —el default—, un
`padron_manifestacion_id` **no nulo con el espejo en `NULL` ENTRA**, porque la FK compuesta **se saltea**
si alguna columna referenciadora es nula; y entonces el check de frescura evalúa sobre `NULL`, da
`UNKNOWN` y **pasa**. El control se desactiva dejando una columna vacía — lección `S4` sobre una columna
nueva. ⚠️ **Y `match full` NO lo cierra**: con `cliente_id` (`not null`) adentro de la FK, «todas nulas»
es inalcanzable, así que queda enforced siempre y **rechaza el caso legítimo** de las seis ramas sin
manifestación. **Regla general que se sigue y vale para todo el repo: en un esquema tenant-consistente,
`match full` es inutilizable en cualquier FK opcional.**

Se cierra con **tres** piezas: el check de nulidad sobre **las dos** columnas, la FK de **dos** columnas
(que ataja el `padron_manifestacion_id` colgado **por mecanismo**) y la de **tres** (que vuelve
infalsificable el espejo). **8 mutaciones rojas + 3 casos legítimos verdes, ya corridos.**

⚠️ **Y un argumento que quien conduce había dado por bueno queda REFUTADO, medido:** el de
`0014:444-446` («no se puede agregar después sin rewrite») **no transfiere** — agregarlo después cuesta
**20 ms**, o cero lock con `NOT VALID` + `VALIDATE`, porque la tabla nace vacía y `ADD COLUMN` nullable
es metadata-only desde PG 11. El motivo real es otro y es más fuerte: **hacerlo después es otro evento de
autorización sobre el piloto**, y P5 fue diseñado como un paso de código **sin** migración.

**Condiciones de `arquitecto-software`, adoptadas:** el espejo se llama `padron_completo_hasta` (nombre
distinto del de la madre, para que se lea como espejo y no como copia); lleva `comment` de «**NO es
dato**» en las palabras de `0017:133-138`; y 🔴 **es el ÚNICO atributo que se espeja** — cualquier otro
de `padron_manifestacion` es un join, escrito para que el cuarto no entre «ya que estamos». El espejo
**NO entra** en `uq_recon_determinante`: la decisión 8 del titular sigue viva.

**Y el límite honesto, que va al `comment`:** la base garantiza que **el alcance citado cubre la fecha
evaluada**, nunca que **el alcance declarado sea cierto** — nada impide manifestar `2099-12-31`. 🔴 Y
cubre **una** de las dos cosas que alteran una manifestación: la (b) de `contador-dominio` (el
movimiento es posterior al alcance). Para la **(a) —que cambie el conjunto de socios— NO HAY MECANISMO**,
ni en la base ni en la aplicación: `0013:409-417` permite insertar socios y actualizar `vigente_hasta`
después de manifestado, y ninguna manifestación se entera.

### 5.9 ✅ El costo del `ADD COLUMN … GENERATED`, MEDIDO — el número que faltaba

🔴 **Con datos SINTÉTICOS, nunca con el corpus real.** El plan decía «medir en local con el corpus
cargado», y eso **choca con la regla dura de `CLAUDE.md` §1.4**: datos financieros de terceros nunca
en un entorno de prueba. Las 1830 filas reales viven en el piloto y **no se copian a local ni para
medir**. Lo que el número tiene que capturar es el costo del rewrite —volumen, ancho de fila y costo
de evaluar la expresión—, no el contenido semántico, así que se generaron 1830 filas sintéticas con
longitudes de glosa y proporciones de nulos comparables. Corrido desde el repo y **borrado al
terminar**, mismo criterio que los scripts de P0 y P1.

| Qué | Medido |
|---|---|
| **`ADD COLUMN … GENERATED … STORED`, 1830 filas** | 🔴 **137,1 ms** (0,075 ms por fila) |
| `UPDATE` de una columna equivalente (contraste) | 103,3 ms |
| `ADD COLUMN` nullable sin default (contraste) | 5,6 ms |
| Crecimiento **permanente** de la tabla | **+33 kB (+12 %)** — 278 kB → 311 kB tras `VACUUM FULL` |
| Espacio **transitorio** durante el `ALTER` | **~1,9×** la tabla (278 → 524 kB), recuperable |

**Lo que el desglose dice, y es lo que decide:** de los 137 ms, **103 son evaluar la expresión y
escribir las filas**; el rewrite estructural en sí son los ~34 ms restantes. Contra los 5,6 ms de un
`ADD COLUMN` vacío (metadata-only desde PG 11), el costo es real pero está **dominado por el `md5`, no
por el `ALTER`**. Sobre 1830 filas, la ventana de `ACCESS EXCLUSIVE` es de **una décima de segundo**.

⚠️ **Y el dato operativo que hay que llevar al runbook, que no estaba en ningún dictamen:** el
crecimiento aparente inicial (casi el doble) **no es el costo de la columna** — son 33 kB permanentes
y el resto es espacio transitorio del rewrite. Pero mientras el `ALTER` corre, **la tabla necesita
espacio en disco para casi el doble de su tamaño**. Con este volumen son kilobytes; la propiedad se
declara igual, porque es la que escala mal el día que la tabla tenga millones de filas.

### 5.11 🔴 Las pruebas de mutación del DDL — y los DOS controles que sobrevivieron al primer barrido

`packages/data/tests/mutaciones-0021.test.ts`: **37 mutaciones + 16 casos legítimos**, con el conteo
declarado en el encabezado. Pero el valor no está en el número: está en que **no se confió en el
conteo**. Se escribió un **barrido** que saca cada control del esquema local, corre el archivo, cuenta
los rojos y lo restaura con su definición exacta leída del catálogo.

🔴 **La primera corrida —con las 31 mutaciones especificadas y sus 15 legítimos EN VERDE— dejó DOS
controles que se podían borrar de la base sin que un solo test se pusiera rojo:**

**(1) `fk_recon_contrapartida_match_regimen` — y no era cobertura faltante, era un BYPASS REAL.**
`uq_recon_contrapartida_match_socio_unico` es un índice **parcial**
(`where regimen_matches = 'socio_unico'`). Un escritor que cuelgue de un padre `es_socio` una hija que
**declare `'varios'`** queda **fuera del predicado del índice** y puede meter **dos socios distintos
bajo un `es_socio`** — exactamente el error «sin detector aguas abajo y sin reclamante» que el índice
existe para cerrar. La FK booleana **pasa** (el padre admite matches) y el check de régimen **pasa**
(`'varios'` está en el dominio). **Lo único que lo cierra es la FK por valor.** O sea: los tres
controles cubren cosas distintas y **ninguno es redundante** — lo contrario de lo que sugería llamar
«cinturón» al check. Corregido en el `comment on constraint` y en el `comment on index`.

**(2) `contrapartida_estado_chk` — cubierto por ESTRUCTURA, nunca por CONDUCTA.** `catalogo.test.ts`
compara el texto del check contra `ESTADOS_RESOLUCION`, pero nadie medía qué pasa **sin** el check:
un octavo estado **entra y nace con `admite_matches = false` y `regimen_matches = 'sin_matches'`** — el
«rompe en silencio» que el `comment on table` describe, ahora medido y no argumentado.

**Barrido final: cero sobrevivientes.**

#### Tres correcciones MEDIDAS a la especificación de las mutaciones

La especificación que se le pasó a `qa-automation` tenía **tres atribuciones erróneas**, y las tres
importan porque un test escrito contra ellas habría quedado rojo — y el reflejo sería relajar la
aserción a `/foreign key/`, que es lo que destruye la discriminación:

| # | La especificación decía | Medido |
|---|---|---|
| 4 | manifestación inexistente + espejo poblado → `fk_…_alcance` | **`fk_…_manifestacion`** (fallan las dos; dispara la creada primero) |
| 8 | manifestación de otro cliente → `fk_…_alcance` | **`fk_…_manifestacion`** (ídem) |
| 5 | inexistente + espejo NULL → `fk_…_manifestacion`, «la única que prueba que la FK de dos no es redundante» | 🔴 **`contrapartida_manifestacion_chk`** — y esa afirmación **no puede ser cierta**: el check vuelve INALCANZABLE el estado que esa FK ataja, así que dispara antes y la FK **nunca se evalúa** |

Eso obligó a un cambio de método: **siete de las 37 mutaciones mutan el DDL**, porque son invariantes
cuyo mecanismo portante está **tapado por otro que dispara primero**. Corren en una transacción del
dueño que **siempre se rollbackea**, con guard de entorno, el constraint defectuoso agregado
`not valid` —descubierto corriéndolo: filas legítimas ya commiteadas hacían morir el `alter table`
antes del insert— y verificación al salir de que el rollback restauró la definición original.

**Los cuatro resultados que valen:**

- 🔴 **`M-A6b`**: con el check de nulidad reducido a la forma «obvia» (sólo la primera mitad), una
  manifestación **vencida medio año** con el espejo en NULL **ENTRA** — la frescura evalúa
  `NULL >= fecha`, da UNKNOWN y pasa. **El control se desactiva dejando una columna vacía.**
  Confirmado que la segunda mitad no es cosmética.
- **`M-A5b` + `M-A5c`**: con el check reducido, la FK de dos columnas queda en pie; con el check
  reducido **y** esa FK fuera, la fila **entra**. La FK de dos columnas **no** es redundante y la de
  tres **no** la cubre.
- **`M-C17b`**: con `(estado in (…)) = (clase = 'propuesta')`, un padre `sin_reconocer` con estado no
  promotor **entra** (`false = false`). El `CASE` es lo único que ata la clase a un valor por rama.
- **`M-D20b`**: con la forma del check que proponía el plan original, el estado que **hoy produce el
  100% del corpus** se pone rojo. El costo de la forma descartada, medido.

**`M-F27` — el bug de los 64 movimientos:** se corrió la mutación contra la suite completa (sacar la
tercera condición del no-op en `escrituras.ts`). **Es el ÚNICO test de los 1493 que se pone rojo.**

**`L-F25`** fija los **16 hex literales** de diez filas sintéticas —no sólo «SQL ≡ TS», porque una
mutación que rompiera las dos gemelas a la vez quedaría verde—, incluida la del emoji fuera del plano
básico (10 puntos de código vs. 11 unidades UTF-16), con su mutación `.length` pelado.

#### Lo que NO se pudo cubrir, y por qué

1. **`resuelto_a_fecha = movimiento.fecha`** y su mutación (`ev.fechaValor`): **no hay productor** —
   ningún código escribe `reconocimiento_contrapartida` todavía, y el test tiene que correr sobre una
   corrida que él mismo produzca.
2. **`ContrapartidaEsSocioSinMatchError`** (el `≥1`): no hay lector. `L-B13` deja documentado que la
   base **no** lo cubre, para que nadie borre la excepción de lectura por «redundante».
3. **El camino real de `es_tercero_padron_completo`**: inalcanzable hasta P5. Los bloques A y D
   ejercitan el DDL por SQL directo, nunca por el productor.
4. 🔴 **El test de grants por conjunto EXACTO — y no es un ítem menor: es la PREMISA de `M-A10`.** La
   inmutabilidad de `completo_hasta` depende de que nunca se otorgue `update` sobre
   `padron_manifestacion`, **incluido un grant de TABLA que un grep por columna no ve**. Hoy esa
   premisa **no la protege ningún test**.

#### Dos hallazgos laterales

- 🔴 **`packages/data/tests/ayuda.ts` afirmaba algo falso**, en el archivo que define para qué sirve
  `clienteDuenio()`: decía que el nodo raíz no lo puede crear el dueño *«porque `force row level
  security` le aplica las políticas también a él»*. **Medido: `sistema_contable` es `rolsuper` y el
  insert le funciona sin GUC ninguno.** La conclusión («`clienteDuenio()` mide mecanismo») sigue en
  pie, por otra razón. Importa porque de la premisa falsa se sigue una trampa: **cualquier test que
  intente medir una POLICY a través de `clienteDuenio()` pasa EN VACÍO**. Corregido.
- ⚠️ **Metodológico, para el próximo barrido:** `drop constraint` + `add constraint` **no conserva el
  `COMMENT`**, y `drop index` + `create index` tampoco. `catalogo.test.ts` exige que cada check nombre
  a su constante **en el comment**, así que un barrido que sólo restaura la definición deja ese test
  rojo por un motivo ajeno al control que se está midiendo.
- ⚠️ **Colisión deliberada, anotada:** `concepto_banco_estrategia` en `'no_capturado'` y en
  `'no_publicado'` producen el **mismo `entrada_digest`**, porque las dos colapsan al `-:`. Es
  correcto —el motor no puede leer esa diferencia—, pero la consecuencia es que **un movimiento que
  pase de una a otra no supersede**.

### 5.10 Lo que sigue abierto

- **`completo_hasta`** en `padron_manifestacion`: `contador-dominio` lo quiere **en `0021`**
  (`date not null`, sin default) con el argumento de que la tabla nace con `grant insert` y **sin**
  `update`/`delete`, así que una manifestación sin alcance queda como premisa permanente e
  incorregible. Sostiene que el visto de `product-owner`/`ux-designer` condiciona **P5** (quién tipea la
  fecha y con qué valor sugerido), **no** el DDL. **Falta la convocatoria de esos dos.**
- ⚠️ **El riesgo de gate rojo que `dba-data` declaró como «el más probable de toda la migración» quedó
  ACOTADO, verificado por quien conduce leyendo el detector** (`catalogo.test.ts:1021`,
  `FORMA_DOMINIO_CERRADO = /^CHECK \(\((\w+) = ANY \(ARRAY\[(.+)\]\)\)\)$/`, anclada a los dos extremos):
  - `contrapartida_promocion_chk` (forma `CASE`) y `contrapartida_manifestacion_chk` (igualdad de
    booleanos) **NO matchean** → no exigen fila. Riesgo descartado.
  - El test admite **dos checks contra la misma constante**: la clave del `Set` de cobertura es
    `d.check`, el **nombre del constraint**, no la constante (`:1109`). Riesgo descartado.
  - **Sí** exigen fila tres: `contrapartida_estado_chk` (previsto — es lo que obliga a mover
    `ESTADOS_RESOLUCION`), `contrapartida_match_clase_chk` (constante ya existente
    `CLASES_IDENTIFICADOR_CONTRAPARTE`) y `contrapartida_match_regimen_chk`. 🔴 **El tercero es el punto
    fino:** `('socio_unico','varios')` es un dominio de **dos** valores que no existe en TypeScript
    —el real es de **tres** y vive en la generada del padre—. Se resuelve declarando una constante
    **verdadera** («los regímenes que admiten matches», derivada de `ESTADOS_RESOLUCION`), nunca
    inventando un dominio de dos para contentar al gate.
- 🔴 **`ESTADOS_RESOLUCION` hay que moverla** de `apps/cli/src/resolver-contrapartida.ts:125-133` a
  `packages/contabilidad/src/nucleo/tipos.ts` y **derivar de ella** el discriminante de
  `ResolucionDeContraparte`, más su fila en `DOMINIOS_CERRADOS`. Es el movimiento que `0014` hizo con
  `CLASES_RECONOCIMIENTO`.
- **Reclasificar `padron_socio_documento.socio_id` a N2** en la misma tarea: con `socio_id` en N2 el
  literal entra igual en la unión global, y dejarla N1 haría que el registro diga **dos cosas del mismo
  nombre**. El gate **no** lo detecta (`redactor.test.ts:44-47` tolera N1-en-una-tabla/N2-en-otra).
- 🔴 **Ninguna de las clasificaciones N2 nuevas tiene gate propio.** Bajar una N2 a N1 **no dispara
  nada**: el registro atrapa el error de más (N2-R indebido) a los gritos y el de menos **en silencio**.
  Se cierran con test de **afirmación positiva** (`nivelDe(tabla, col) === 'N2'`) + `@ts-expect-error`
  sobre `logger.info`, y su **prueba de mutación**. Sin eso son comentarios.
- **H-1** (`loggerAcotado` no intersecta su allowlist con `ClaveProhibida`) y **H-2**
  (`resolver-contrapartida.ts:309` publica `sociosInvolucrados` a stdout esquivando el redactor) dejan
  de ser hipotéticos **con esta migración**, porque es la que sube `socio_id` a N2. Van en la misma
  tarea.
- 🔴 **`reconocer-lote.ts` fija qué entra a capa C (`:283`), con qué fecha y con qué gate (`:288`), y
  está FUERA del gate que existe para detectar que el motor cambió.** El test de §5.6 es un parche
  puntual sobre un agujero general. Ítem propio para `tech-lead` + `qa-automation`.
- 🔴 **El criterio (a) de la frescura NO tiene mecanismo** (§5.8): el conjunto de socios puede cambiar
  después de manifestado y ninguna manifestación se entera. Ni base ni aplicación.
- 🔴 **`padron_manifestacion` no tiene noción de «vigente»** (`arquitecto-software`). `revoca_a` encadena,
  pero nada impide N manifestaciones no revocadas con alcances superpuestos o contradictorios, ni dos
  revocando a la misma. Las dos tablas hermanas lo resuelven con índice único parcial (`uq_recon_vigente`
  `0014:479`, `uq_padron_socio_vigente` `0013:363`); acá no hay equivalente. **Para `0021` es tolerable**
  —la resolución cita un id explícito, que es el diseño elegido—; **para P5 no**: «elegir la
  manifestación» va a nacer como un `order by completo_hasta desc limit 1` que nadie va a llamar decisión.
- **El test de grants por conjunto EXACTO** (`toEqual` contra `information_schema.column_privileges`) deja
  de ser «el test que falta» y pasa a ser 🔴 **condición del control de frescura**: la inmutabilidad de
  `completo_hasta` es hoy verdadera pero **no está protegida por ningún test**, y un `grant update` de
  **tabla** agregado en una migración futura pasaría el gate — que es exactamente lo que `0004:502`
  demuestra que pasa.
- **Los dos gates de `arquitecto-software` (§4.2), con tres precisiones nuevas para el primero:**
  (i) `entrada_digest` es columna de `movimiento_bancario_crudo`, así que necesita entrada
  **auto-referencial** en la lista o el gate nace rojo; (ii) 🔴 el emparejamiento tiene que ser por
  **límite de palabra, nunca `includes`** — la expresión contiene `concepto_completo`, así que un
  substring daría «cubierta» a una columna futura llamada `completo`, y contiene `concepto_banco` y
  `concepto_banco_estrategia`, uno prefijo del otro; (iii) **motivo no vacío exigido por el test**, o la
  lista se llena de `''` en la primera tanda y el gate mide presencia en vez de decisión.
- **H-1 estructural**: `loggerAcotado` sigue sin intersectar su unión de claves con `ClaveProhibida`. En
  esta tarea se sacó `'socio_id'` **a mano** de `CamposAltaSocio`; el arreglo real es una línea de tipo,
  con su prueba de mutación, y es ítem propio.

---

## 6. Los pasos, y dónde quedó cada uno

| Paso | Qué | Estado |
|---|---|---|
| **P0** | `digestDeEntrada()` puro, por exclusión, + 17 tests + 8 mutaciones | ✅ **CERRADO**, medido: 64 |
| **P1** | La expresión SQL verificada contra el corpus, **como `select`, sin DDL** | ✅ **CERRADO**: 1830/1830, 0 divergencias |
| **P2** | Trigger + `entrada_digest` en la hija + `determinante` generado + unicidad nueva + recorte del grant | ⏳ por escribir |
| **P3** | `padron_manifestacion` + FK | ⏳ **DESBLOQUEADO** — §5 reconciliada (2026-08-17). Falta el visto de `product-owner`/`ux-designer` sobre `completo_hasta` |
| **P4** | `reconocimiento_contrapartida` + satélite | ⏳ **DESBLOQUEADO** — forma escrita y ratificada por `contador-dominio` **y** `motor-conciliacion-contable` (condición de `arquitecto-software`, §4.2), con el DDL medido por `dba-data` y la clasificación de `seguridad-datos-financieros` |
| **P5** | *Fuera de `0021`.* Soltar el `false` de `reconocer-lote.ts:288` | ⏳ paso propio, disparador (c) |

⚠️ **Honestidad sobre la reversibilidad:** si P2–P4 van en un archivo, van en **una transacción**, y **la
unidad revertible en el piloto es la migración, no el paso**. Los pasos son revertibles **en local**,
cada uno verificado solo contra una base descartable creada desde template.

🔴 **La aplicación al piloto es una autorización aparte del titular**, con `CLAUDE.md` §1.9 corrido
completo: `ENV_FILE=.env.piloto pnpm db:migrate --estado` → listar → confirmar que coincide **exacto** →
frenar si aparece una de más. **Nunca `pnpm db:migrate` pelado.**

### Costo fijo que arrastra toda columna nueva

| Qué | Dónde | Si falta |
|---|---|---|
| Clasificación N0–N3 | `packages/shared/src/seguridad/clasificacion-campos.ts:729-785` | `catalogo.test.ts:102-120` rojo |
| Constante TS + fila en `DOMINIOS_CERRADOS` + `comment on constraint` que la nombre | `catalogo.test.ts:938-1006`, `:1101`, `:1125` | Sólo si el check tiene forma de dominio cerrado |
| `CAMPOS_ESPEJADOS` (R-K) | `packages/data/tests/reglas-de-codigo.test.ts:805-818` | Si la columna es escribible desde la app |
| El `on conflict` del insert | `packages/data/src/contabilidad/escrituras.ts:328` | **Cambia sí o sí** |

🔴 **`ESTADOS_RESOLUCION` está en el lugar equivocado:** hoy vive en
`apps/cli/src/resolver-contrapartida.ts:125-133`, no en `packages/contabilidad/src/nucleo/tipos.ts`. Hay
que **moverla y derivar de ella el discriminante** de `ResolucionDeContraparte`, más su fila en
`DOMINIOS_CERRADOS`. Es el movimiento que `0014` hizo con `CLASES_RECONOCIMIENTO`.

---

## 7. La expresión SQL verificada (P1)

> Corrió como `select` contra el piloto y coincidió con TypeScript en **1830 de 1830**.
> Es la candidata para `movimiento_bancario_crudo.entrada_digest generated always as (…) stored`.

```sql
left(md5(
    case when m.importe < 0 then '6:debito' else '7:credito' end
 || '|' || case when m.concepto_banco is null then '-:'
                else length(m.concepto_banco)::text || ':' || m.concepto_banco end
 || '|' || case when m.concepto_banco_estrategia in ('no_capturado','no_publicado') then '-:'
                else length(m.concepto_banco_estrategia)::text || ':' || m.concepto_banco_estrategia end
 || '|' || case when m.concepto_codigo is null then '-:'
                else length(m.concepto_codigo)::text || ':' || m.concepto_codigo end
 || '|' || case when m.concepto_completo is null then '-:'
                when m.concepto_completo then '4:true' else '5:false' end
 || '|' || length(m.contraparte_captura)::text || ':' || m.contraparte_captura
 || '|' || '10:' || lpad(date_part('year',  m.fecha)::text, 4, '0')
                 || '-' || lpad(date_part('month', m.fecha)::text, 2, '0')
                 || '-' || lpad(date_part('day',   m.fecha)::text, 2, '0')
  ), 16)
```

**Orden de los campos:** alfabético de las claves de `EvidenciaDeMovimientoLeida`, sin `movimientoId` ni
`bancoCodigo` — `columnaOrigen`, `conceptoBanco`, `conceptoBancoEstrategia`, `conceptoCodigo`,
`conceptoCompleto`, `contraparteCaptura`, `fecha`.

---

## 8. Apéndice — las dos mediciones, reproducibles

> Se corrieron desde `apps/cli/src/` (por la resolución de paquetes del workspace) y **se borraron del
> repo** al terminar: son mediciones, no herramientas. Se conservan acá para poder repetirlas.
> Copia también en el scratchpad de la sesión.

**Invocación (sólo lectura contra el piloto):**

```bash
ENV_FILE=.env.piloto \
P0_USUARIO=11111111-1111-1111-1111-111111111111 \
P0_LOTES="69479b8f-9b6a-4d6b-bdb2-bff817c2e750:ae762fda-8822-459f-a061-31d7ce26c785:macro,\
f84d9ecc-6d54-4009-8fb6-b6fa3f8d8579:63050700-a053-4b13-8d82-5cdf9dbbe065:galicia,\
80741296-8cbf-4a4f-bcf1-8e8cb1c57584:95985da8-5bba-4128-9d91-840fe6f146ef:santander" \
node apps/cli/src/medir-p0.ts
```

**P0** — lee por `conUsuario`, calcula `digestDeEntrada(ev)` con la entrada actual y con
`comoAntesDeLaRecaptura(ev)` (`conceptoBanco`, `conceptoCompleto` y `conceptoBancoEstrategia` en
`undefined`, que es como `0007` los backfilleó), corre `reconocer()` sobre las dos y cuenta:
`digestCambia`, `digestCambiaYClaseIGUAL` (**el número**), `digestCambiaYClaseDISTINTA`, `digestIgual`.
Guard **R18** + rechazo si la credencial saltea RLS. **Salida: sólo conteos.**

**P1** — mismo acceso; corre la expresión de §7 como `select` y compara contra `digestDeEntrada(ev)`
movimiento por movimiento. Reporta `total`, `coinciden`, `divergen`, digests distintos por cada lado, y
hasta 10 divergencias con `movimiento_id` + los **dos digests** (nunca el contenido).

**Mutación de P0** — parchea `entrada.ts`, corre la suite con `--reporter=json`, verifica qué `it` se
puso rojo, y **restaura el original**. Las 8 mutaciones están en §2.2.

---

## 9. Índice de lo que este expediente cierra y lo que deja abierto

**Cierra:** `10-deuda-declarada.md` §0.0 **A.1** queda con su plan escrito, sus dos preguntas de diseño
dictaminadas y su premisa **medida** (64). Las correcciones de §3.4 hay que aplicarlas a
`10-deuda-declarada.md` §0.0 A.1 (la premisa mal apoyada de `0017`).

**Abre / deja pendiente:**

- 🔴 **R40** en `ADR-0002` §B, con sus 6 mutaciones (§4.4).
- 🔴 **R6 no discrimina** — hallazgo permanente, independiente de `0021`.
- 🔴 Los dos agujeros vivos de `0014`: `created_at` y `superseded_por` insertables (§4.1).
- 🔴 **H-1** (`loggerAcotado`) y **H-2** (`resolver-contrapartida.ts:309`) — §4.3.
- Los dos gates nuevos de `arquitecto-software` (§4.2).
- El test de grants con cobertura **inversa de conjunto cerrado** (§4.4).
- Las dos diferencias de §5.
- La deuda del **pepper** en `entrada_digest`, declarada y no cerrada (§4.3 punto 2).
- ~~El costo del `ADD COLUMN … GENERATED` sobre 1830 filas: **no medido**.~~ ✅ **MEDIDO** — ver §5.9.
- Correcciones documentales: `0018:58-59` no se propaga; `persistible.ts:130-136` deja de ser cierto
  cuando exista capa C persistida; `0014:12` y `:429-430` citan una `0015` que es en realidad `0021`.

### 8.1 `medir-p0.ts`

```ts
/**
 * P0 del plan `quirky-riding-music` — LA MEDICIÓN QUE PUEDE FALSIFICAR EL PLAN.
 *
 * Pregunta: ¿cuántos movimientos del corpus cambian de `entrada_digest` por una mutación de la
 * entrada que YA ocurrió (la recaptura de conceptos de `0007`), y —de esos— cuántos conservan la
 * MISMA `clase`?
 *
 * Ese segundo número ES la magnitud del bug declarado en `escrituras.ts:298-302`: son exactamente los
 * movimientos donde un reproceso daría `no_op` con la interpretación vieja intacta. Si da CERO, la
 * premisa de `0021` es falsa y hay que replantear.
 *
 * 🔴 SÓLO LECTURA. Entra por `conUsuario` (CLAUDE.md §2.1). No escribe una fila, no abre transacción de
 * escritura, no toca el esquema. La salida son CONTEOS: ninguna proyección, ningún `concepto_banco`,
 * ningún dato de cliente sale de este proceso.
 */
import {
  conUsuario,
  cerrarConexiones,
  leerEvidenciaDeMovimientos,
  verificarCredencialDeRequest,
  type EvidenciaDeMovimientoLeida,
} from '@sistema-contable/data';
import { construirIndice, lexicoDe, reconocer, digestDeEntrada, type IndiceDeLexico } from '@sistema-contable/contabilidad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const USUARIO = process.env.P0_USUARIO as string;
const LOTES = (process.env.P0_LOTES as string).split(',').map((s) => {
  const [cliente, lote, banco] = s.split(':');
  return { cliente: cliente as string, lote: lote as string, banco: banco as string };
});

/** La entrada tal como estaba ANTES de que corriera `recapturar-conceptos.ts`: la `ALTER TABLE` de
 *  `0007` backfilleó `concepto_banco`/`concepto_completo` con NULL y la estrategia con
 *  `'no_capturado'`, que `lecturas.ts:314-322` colapsa a `undefined`. */
function comoAntesDeLaRecaptura(ev: EvidenciaDeMovimientoLeida): EvidenciaDeMovimientoLeida {
  return { ...ev, conceptoBanco: undefined, conceptoCompleto: undefined, conceptoBancoEstrategia: undefined };
}

function evidenciaDeMotorDesde(ev: EvidenciaDeMovimientoLeida) {
  return {
    bancoCodigo: ev.bancoCodigo,
    conceptoBanco: ev.conceptoBanco,
    conceptoCompleto: ev.conceptoCompleto,
    conceptoBancoEstrategia: ev.conceptoBancoEstrategia,
    conceptoCodigo: ev.conceptoCodigo,
    columnaOrigen: ev.columnaOrigen,
  };
}

const total = {
  movimientos: 0,
  sinLexico: 0,
  digestsDistintos: new Set<string>(),
  digestCambia: 0,
  digestCambiaYClaseIGUAL: 0,
  digestCambiaYClaseDISTINTA: 0,
  digestIgual: 0,
};

const porLote: unknown[] = [];

// R18: el guard de arranque es obligatorio. Y las mismas dos compuertas que `resolver-contrapartida.ts`
// — una credencial que saltea RLS mediría contra filas que el motor nunca ve en producción, o sea que
// el número saldría bien y sería mentira.
const credencial = await verificarCredencialDeRequest();
if (credencial.salteaRls || credencial.esSuperusuario) {
  throw new Error('la credencial saltea RLS: la medición no sería representativa');
}
if (!credencial.contextoLocalAislado) throw new Error('contexto no aislado');

for (const { cliente, lote, banco } of LOTES) {
  const fila = await conUsuario(USUARIO, async (tx) => {
    const evidencias = await leerEvidenciaDeMovimientos(tx, { clienteId: cliente, loteIngestaId: lote });
    const lexico = lexicoDe(banco);
    const indice: IndiceDeLexico | undefined = lexico ? construirIndice(lexico) : undefined;

    let cambia = 0;
    let cambiaClaseIgual = 0;
    let cambiaClaseDistinta = 0;
    let igual = 0;
    let sinLexico = 0;
    const distintos = new Set<string>();

    for (const ev of evidencias) {
      const dAhora = digestDeEntrada(ev);
      distintos.add(dAhora);
      total.digestsDistintos.add(dAhora);

      const antes = comoAntesDeLaRecaptura(ev);
      const dAntes = digestDeEntrada(antes);

      if (dAhora === dAntes) {
        igual += 1;
        continue;
      }
      cambia += 1;

      if (!indice) {
        sinLexico += 1;
        continue;
      }
      const rAhora = reconocer(evidenciaDeMotorDesde(ev), indice);
      const rAntes = reconocer(evidenciaDeMotorDesde(antes), indice);
      if (rAhora.clase === rAntes.clase) cambiaClaseIgual += 1;
      else cambiaClaseDistinta += 1;
    }

    return {
      banco,
      movimientos: evidencias.length,
      digestsDistintos: distintos.size,
      digestCambia: cambia,
      digestCambiaYClaseIGUAL: cambiaClaseIgual,
      digestCambiaYClaseDISTINTA: cambiaClaseDistinta,
      digestIgual: igual,
      sinLexico,
    };
  });

  porLote.push(fila);
  total.movimientos += fila.movimientos;
  total.digestCambia += fila.digestCambia;
  total.digestCambiaYClaseIGUAL += fila.digestCambiaYClaseIGUAL;
  total.digestCambiaYClaseDISTINTA += fila.digestCambiaYClaseDISTINTA;
  total.digestIgual += fila.digestIgual;
  total.sinLexico += fila.sinLexico;
}

console.log(
  JSON.stringify(
    {
      porLote,
      total: { ...total, digestsDistintos: total.digestsDistintos.size },
    },
    null,
    2,
  ),
);

await cerrarConexiones();
```

### 8.2 `medir-p1.ts`

```ts
/**
 * P1 del plan `quirky-riding-music` — ¿la expresión SQL y la de TypeScript dan EL MISMO digest?
 *
 * Predicción falsable del plan: *«si los digests contados en la base ≠ los contados en TS, la expresión
 * SQL y la de TS divergen — y hay que saberlo acá, no en P3»*.
 *
 * 🔴 SIN DDL. La expresión candidata corre como un `select`, no como columna generada: no se agrega
 * ninguna columna, no se aplica ninguna migración, no se escribe una fila. Sólo lectura, por
 * `conUsuario`, con el guard R18. La salida son CONTEOS y —si hay divergencia— el `movimiento_id` y
 * los DOS DIGESTS, nunca el contenido que los produjo.
 */
import {
  conUsuario,
  cerrarConexiones,
  leerEvidenciaDeMovimientos,
  verificarCredencialDeRequest,
} from '@sistema-contable/data';
import { digestDeEntrada } from '@sistema-contable/contabilidad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const USUARIO = process.env.P1_USUARIO as string;
const LOTES = (process.env.P1_LOTES as string).split(',').map((s) => {
  const [cliente, lote, banco] = s.split(':');
  return { cliente: cliente as string, lote: lote as string, banco: banco as string };
});

/**
 * La expresión candidata para la columna generada de `movimiento_bancario_crudo.entrada_digest`.
 *
 * Espeja `digestDeEntrada()` campo por campo, en el MISMO orden (alfabético de las claves de
 * `EvidenciaDeMovimientoLeida`, sin `movimientoId` ni `bancoCodigo`) y con el MISMO enmarcado
 * (prefijo de longitud, `-:` para el ausente).
 *
 * 🔴 `lpad(date_part(...))` y NO `fecha::text`: `date_out` es STABLE (depende de `DateStyle`) y una
 * columna generada exige IMMUTABLE. Medido: `date_part(text, date)` y `lpad` son IMMUTABLE, así que
 * la fecha ISO se puede armar a mano — no hace falta el rodeo de `(fecha - date '2000-01-01')`, que
 * habría obligado a que TypeScript hashease un número de días en vez de la fecha legible.
 *
 * 🔴 `length()` de Postgres cuenta CARACTERES, igual que `[...texto].length` en TS. Con `texto.length`
 * pelado del lado de TS, las dos habrían divergido sobre cualquier carácter fuera del plano básico.
 */
const EXPRESION = `left(md5(
    case when m.importe < 0 then '6:debito' else '7:credito' end
 || '|' || case when m.concepto_banco is null then '-:'
                else length(m.concepto_banco)::text || ':' || m.concepto_banco end
 || '|' || case when m.concepto_banco_estrategia in ('no_capturado','no_publicado') then '-:'
                else length(m.concepto_banco_estrategia)::text || ':' || m.concepto_banco_estrategia end
 || '|' || case when m.concepto_codigo is null then '-:'
                else length(m.concepto_codigo)::text || ':' || m.concepto_codigo end
 || '|' || case when m.concepto_completo is null then '-:'
                when m.concepto_completo then '4:true' else '5:false' end
 || '|' || length(m.contraparte_captura)::text || ':' || m.contraparte_captura
 || '|' || '10:' || lpad(date_part('year',  m.fecha)::text, 4, '0')
                 || '-' || lpad(date_part('month', m.fecha)::text, 2, '0')
                 || '-' || lpad(date_part('day',   m.fecha)::text, 2, '0')
  ), 16)`;

let total = 0;
let coinciden = 0;
const divergentes: { movimientoId: string; ts: string; sql: string }[] = [];
const distintosTs = new Set<string>();
const distintosSql = new Set<string>();

const credencial = await verificarCredencialDeRequest();
if (credencial.salteaRls || credencial.esSuperusuario) throw new Error('la credencial saltea RLS');
if (!credencial.contextoLocalAislado) throw new Error('contexto no aislado');

for (const { cliente, lote } of LOTES) {
  await conUsuario(USUARIO, async (tx) => {
    const evidencias = await leerEvidenciaDeMovimientos(tx, { clienteId: cliente, loteIngestaId: lote });

    const filas = await tx.consultar<{ id: string; d: string }>(
      `select m.id::text as id, ${EXPRESION} as d
         from movimiento_bancario_crudo m
        where m.cliente_id = $1 and m.lote_ingesta_id = $2`,
      [cliente, lote],
    );
    const porId = new Map(filas.map((f) => [f.id, f.d]));

    for (const ev of evidencias) {
      total += 1;
      const ts = digestDeEntrada(ev);
      const sql = porId.get(ev.movimientoId) ?? '<sin fila>';
      distintosTs.add(ts);
      distintosSql.add(sql);
      if (ts === sql) coinciden += 1;
      else if (divergentes.length < 10) divergentes.push({ movimientoId: ev.movimientoId, ts, sql });
    }
  });
}

console.log(
  JSON.stringify(
    {
      total,
      coinciden,
      divergen: total - coinciden,
      digestsDistintosTs: distintosTs.size,
      digestsDistintosSql: distintosSql.size,
      primerasDivergencias: divergentes,
    },
    null,
    2,
  ),
);

await cerrarConexiones();
```

### 8.3 `mutar-p0.mjs` — la prueba de mutación

```js
/**
 * Prueba de mutación de P0 (CLAUDE.md §1.8 / ADR-0002 §B.0).
 * Escribe el código DEFECTUOSO, corre la suite, y verifica que se ponga ROJA.
 * Las mutaciones se eligen para REFUTAR, no para confirmar.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OBJETIVO = 'packages/contabilidad/src/nucleo/entrada.ts';
const original = readFileSync(OBJETIVO, 'utf8');

const MUTACIONES = [
  {
    id: 'M1',
    que: 'la IDENTIDAD entra al digest (se saca movimientoId de la exclusión)',
    esperaRojo: ['(3)'],
    esperaVerde: ['(5)', '(6)'],
    parche: (s) => s.replace("new Set(['movimientoId', 'bancoCodigo'])", "new Set(['bancoCodigo'])"),
  },
  {
    id: 'M2',
    que: 'bancoCodigo entra al digest (divergiría de la generada del DDL)',
    esperaRojo: ['(4)'],
    esperaVerde: ['(3)'],
    parche: (s) => s.replace("new Set(['movimientoId', 'bancoCodigo'])", "new Set(['movimientoId'])"),
  },
  {
    id: 'M3',
    que: 'POR INCLUSIÓN: lista fija de siete campos en vez de recorrer por exclusión',
    esperaRojo: ['(6)'],
    esperaVerde: ['(3)', '(4)', '(5)', '(7)', '(8)'],
    parche: (s) =>
      s.replace(
        '  const claves = Object.keys(entrada).sort();',
        "  const claves = ['columnaOrigen','conceptoBanco','conceptoBancoEstrategia','conceptoCodigo','conceptoCompleto','contraparteCaptura','fecha'];",
      ),
  },
  {
    id: 'M4',
    que: 'separador pelado sin prefijo de longitud (encadenado NO inyectivo)',
    esperaRojo: ['(7)'],
    esperaVerde: ['(3)', '(4)', '(6)'],
    parche: (s) =>
      s.replace("  return String([...texto].length) + ':' + texto;", '  return texto;'),
  },
  {
    id: 'M8',
    que: 'longitud en unidades UTF-16 en vez de puntos de código (divergiría de length() de PG)',
    esperaRojo: ['(11)'],
    esperaVerde: ['(7)', '(8)'],
    parche: (s) =>
      s.replace(
        "  return String([...texto].length) + ':' + texto;",
        "  return String(texto.length) + ':' + texto;",
      ),
  },
  {
    id: 'M5',
    que: 'el ausente colapsa a cadena vacía (undefined indistinguible de \'\')',
    esperaRojo: ['(8)'],
    esperaVerde: ['(9)'],
    parche: (s) => s.replace("if (valor === null || valor === undefined) return '-:';", "if (valor === null || valor === undefined) return '0:';"),
  },
  {
    id: 'M6',
    que: 'el digest no se recorta a 16 (forma que el check del DDL rechaza)',
    esperaRojo: ['(2)'],
    esperaVerde: ['(3)', '(5)'],
    parche: (s) => s.replace(".digest('hex').slice(0, 16)", ".digest('hex')"),
  },
  {
    id: 'M7',
    que: 'un campo REAL de entrada queda fuera (contraparteCaptura excluido)',
    esperaRojo: ['(5)'],
    esperaVerde: ['(3)', '(4)', '(6)'],
    parche: (s) =>
      s.replace(
        "new Set(['movimientoId', 'bancoCodigo'])",
        "new Set(['movimientoId', 'bancoCodigo', 'contraparteCaptura'])",
      ),
  },
];

function correr() {
  try {
    const salida = execSync(
      'npx vitest run packages/contabilidad/tests/entrada.test.ts --reporter=json --outputFile=' +
        JSON.stringify(process.env.TMP_JSON),
      { encoding: 'utf8', stdio: 'pipe' },
    );
    return salida;
  } catch {
    /* rojo es lo esperado */
  }
  return null;
}

const TMP = process.env.TMP_JSON;
const resultados = [];

for (const m of MUTACIONES) {
  const mutado = m.parche(original);
  if (mutado === original) {
    resultados.push({ id: m.id, veredicto: '🔴 EL PARCHE NO APLICÓ — mutación inválida', detalle: m.que });
    continue;
  }
  writeFileSync(OBJETIVO, mutado);
  correr();
  let rojos = [];
  try {
    const j = JSON.parse(readFileSync(TMP, 'utf8'));
    for (const a of j.testResults ?? []) {
      for (const t of a.assertionResults ?? []) {
        if (t.status === 'failed') rojos.push(t.title.slice(0, 5));
      }
    }
  } catch (e) {
    rojos = ['<no se pudo leer el reporte>'];
  }
  const cubre = m.esperaRojo.every((r) => rojos.some((x) => x.includes(r)));
  const falsoRojo = m.esperaVerde.filter((v) => rojos.some((x) => x.includes(v)));
  resultados.push({
    id: m.id,
    que: m.que,
    esperaRojo: m.esperaRojo.join(','),
    rojosReales: [...new Set(rojos)].join(',') || '(NINGUNO)',
    veredicto:
      rojos.length === 0
        ? '🔴 MUTACIÓN SOBREVIVE — el test NO discrimina'
        : cubre && falsoRojo.length === 0
          ? '✅ mata, y sólo lo que debía'
          : cubre
            ? '⚠️ mata, pero también se cayó ' + falsoRojo.join(',')
            : '🔴 se puso rojo OTRO test, no el que debía',
  });
  writeFileSync(OBJETIVO, original);
}

writeFileSync(OBJETIVO, original);
console.log(JSON.stringify(resultados, null, 2));
```
