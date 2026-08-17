# Dictamen `dba-data` — migración `0021`, determinante de idempotencia y grants

Todo lo medido corre contra **local** (`sistema-contable-postgres`, 5442), en transacciones
revertidas (`begin` … `rollback`, con savepoint por caso). **El piloto (5443) no se tocó.**
Postgres local: **16.13** (`server_version_num = 160013`).

---

## PREGUNTA 1 — ¿columna generada, o hash calculado en TypeScript?

### Dictamen

**Columna generada — pero en `movimiento_bancario_crudo`, no en `reconocimiento_movimiento`.**
El hash de la ENTRADA es *estructuralmente imposible* como columna generada en la tabla hija
(la entrada vive en otra tabla y una expresión de generación no admite subconsulta: medido).
Vive como columna generada en la tabla donde la entrada **sí** está en la misma fila, y
`reconocimiento_movimiento` toma una **foto histórica** de ese valor con un trigger
`BEFORE INSERT` + `not null`, que **falla CERRADO** (medido). Ni columna generada en la hija,
ni hash calculado en TypeScript.

### Donde discrepo con el planteo de la pregunta

**(D1) «un hash que pasa la aplicación es un hash sobre el que el escritor puede mentir; uno
`generated always` no» — es correcto, pero el corolario que la Pregunta 2 deriva de él es falso.**
Una columna generada **no es falsificable ni siquiera bajo un `grant insert` de tabla entera**:

```
### I2: insert NOMBRANDO la generada (con grant) 
ERROR:  cannot insert a non-DEFAULT value into column "entrada_digest"
DETAIL:  Column "entrada_digest" is a generated column.
```

Es el mecanismo de la columna generada, no el privilegio, el que rechaza. La lección de
`via_depth` (`0020` §3) **no transfiere**: `via_depth` es una columna *normal con `DEFAULT`* —
nombrable y elegible. Una generada no lo es nunca.

**(D2) «¿el trigger corre bajo `force row level security` y queda fail-open según el rol, como
declara `0014:684-688`?» — NO, y la diferencia es la razón por la que esta vía es viable.**
`0014` describe un trigger que **CUENTA** (`ambiguo` tiene 2+ candidatos): si la RLS le esconde
filas, cuenta 0, el predicado se satisface y falla **ABIERTO**. Un trigger que **COPIA** falla al
revés: si la RLS esconde la fila origen, el `select ... into` deja `NULL`, y el `not null` lo
rechaza. Medido, con la tabla origen bajo `enable` + `force row level security` y una policy que
oculta el otro cliente:

```
### X1: insert legítimo (cliente visible)      -> INSERT 0 1, digest = 2bf13f5d3ffa15fe
### X2: movimiento que EXISTE pero la RLS OCULTA
ERROR:  null value in column "entrada_digest" of relation "child" violates not-null constraint
```

**El `not null` es la mitad load-bearing de esta pareja, no decoración.** Medido aparte: un
`check` NO cierra el agujero, porque un `check` sobre `NULL` da `UNKNOWN` y **pasa**:

```
### S4: create table g2 (... h text generated ..., check (h ~ '^[0-9a-f]{16}$'));
insert into g2(b) values ('hola');  -> INSERT 0 1   h = 4d186321c1a7f0f3
insert into g2(b) values (null);    -> INSERT 0 1   <-- h = NULL, el check NO lo frena
```

**(D3) La «vía denormalizada validada por FK» funciona mecánicamente y hay que descartarla igual.**
La evalué a fondo porque es la que *parecía* la respuesta correcta —es literalmente el patrón de
`0017`, bajar el invariante a FK— y la medición la mata:

```
### F1: el hijo copia BIEN el digest             -> INSERT 0 1
### F2: el hijo MIENTE el digest
ERROR:  insert or update on table "child" violates foreign key constraint "child_fk"
DETAIL:  Key (...,0123456789abcdef) is not present in table "src".
### F3b: si la columna copiada es NULLABLE, MATCH SIMPLE no chequea NADA
        filas_fantasma_admitidas = 1
### F4: 🔴 UPDATE del concepto en el padre CON hijo vivo (on update restrict)
ERROR:  update or delete on table "src" violates foreign key constraint "child_fk" on table "child"
```

`F4` es el veredicto: **una FK afirma un hecho PRESENTE; el determinante tiene que registrar uno
HISTÓRICO.** Con `on update restrict`, el primer reconocimiento de un movimiento **congela
`concepto_banco` para siempre** y `recapturar-conceptos.ts` muere con `23503` — la recaptura
dejaría de existir como operación. Y `on update cascade` es peor: reescribiría en silencio el
digest de una interpretación ya emitida, que es exactamente lo que `0014` decisión 2 prohíbe.
**Rechazada.**

**(D4) Postgres 18 / `GENERATED ... VIRTUAL`: no cambia nada, y además no aplica.** Estamos en
16.13 (medido). Aunque estuviéramos en 18, una columna virtual sigue sin poder referenciar otra
tabla — la restricción que mata la opción en la hija no es el `STORED`, es el alcance a la fila.

### Volatilidad: qué es `IMMUTABLE` y qué no (medido, no de memoria)

`select provolatile from pg_proc` + verificación **ejecutando** un `create table ... generated`:

| Expresión | `provolatile` | ¿Entra en una generada? |
|---|---|---|
| `md5(text)`, `md5(bytea)` | `i` | ✅ (`T1`, `T8`) |
| `sha224/256/384/512(bytea)` | `i` | ✅ pero ver el 🔴 de abajo |
| `encode(bytea,text)`, `decode(text,text)` | `i` | ✅ |
| `text \|\| text` (`textcat`) | `i` | ✅ |
| `uuid \|\| text`, `text \|\| anynonarray` (`anytextcat`/`textanycat`) | `s` | ✅ *igual* — el parser interpone el cast y resuelve a `textcat` (`T2`, `T2b`) |
| `numeric::text`, `boolean::text`, `integer::text` | — | ✅ (`T6`, `D2`) |
| `length`, `left`, `coalesce`, `lower/upper/btrim/substr` | `i` | ✅ |
| `fecha - date 'literal'` → `integer::text` | `i` | ✅ (`D1`) |
| **`convert_to(text,name)`** | **`s`** | ❌ `generation expression is not immutable` (`T3`) |
| **`concat()` / `concat_ws()`** | **`s`** | ❌ (`T7`) |
| **`timestamptz::text`** | — | ❌ (`T5`) — depende de `TimeZone` |
| **`date::text`** | — | ❌ (`C1`) — depende de `DateStyle` |
| `now()`, `gen_random_uuid()` | `s` / `v` | ❌ |

🔴 **`sha256` sobre texto es una trampa, y por eso el hash va con `md5`.** `sha256` exige `bytea`.
El único camino inmutable a `bytea` desde `text` es el cast `::bytea` — que Postgres **acepta**
(`T4` creó la tabla) pero que **reinterpreta el texto como literal de `bytea`**:

```
### S1b: select 'ZZ\xGG'::text::bytea;
ERROR:  invalid input syntax for type bytea
```

Un `concepto_banco` recortado de una glosa que traiga una secuencia con barra invertida haría
**explotar el INSERT** en runtime (`22P02`), y `'\101'::bytea` = `'A'` significa que dos textos
distintos pueden hashear igual. `convert_to(...,'UTF8')` es la forma correcta y **no es
`IMMUTABLE`**. `pgcrypto` **no está instalado** (`digest`/`hmac` devuelven cero filas en
`pg_proc`) y además es extensión no-core, prohibida por ADR-0000 §2.

**Conclusión:** `left(md5(...), 16)` es el **único** camino inmutable, core y seguro desde texto.
Y es el correcto aquí por el fondo, no sólo por lo que se puede: el determinante es un
**detector de cambio**, no una primitiva de seguridad. La resistencia a colisión no está en el
modelo de amenaza — el escritor no elige la entrada arbitrariamente (es su propio extracto), y
fabricar una colisión sólo le compra negarse a sí mismo un reproceso. Sale **16 hex**, la misma
forma y el mismo `check` que `motor_digest`, que es lo que `0014` fijó como idiom del repo para
«identidad de un artefacto».
(`encode(sha256(decode(md5(x),'hex')),'hex')` sí compila — `T9` — pero es md5 con pasos de más.)

### Codificación null-safe: por qué lleva prefijo de longitud

`md5(a || '|' || b)` con un operando `NULL` da **`NULL` entero** (`S2`), y `text` en Postgres
**no puede contener el byte NUL** (`C3`: `invalid byte sequence for encoding "UTF8": 0x00`), así
que no hay separador reservado disponible. Se resuelve con **prefijo de longitud** por campo de
texto libre, que es inyectivo: `NULL` → `-:`, `''` → `0:`, y `'x|1:y'` no colisiona con
`('x','y')`. Medido (`C2`, `D3`).

### El `check` de forma que acompaña al hash nuevo

Idéntico en forma a `reconocimiento_digest_chk`, y **acompañado de `not null`**, que es lo que
de verdad cierra el caso `NULL` (ver `S4`):

```sql
constraint mov_crudo_entrada_digest_chk check (entrada_digest ~ '^[0-9a-f]{16}$')   -- en el padre
constraint reconocimiento_entrada_digest_chk check (entrada_digest ~ '^[0-9a-f]{16}$') -- en el hijo
```

### Riesgos declarados de la Pregunta 1

1. 🔴 **El dueño superusuario puede falsificar la foto histórica, y NO puede falsificar la
   generada.** Es la diferencia dura entre las dos, medida:
   ```
   ### M4: set session_replication_role='replica'; insert ... entrada_digest='0000000000000000'
           digest_falsificado_por_el_dueno = 0000000000000000     <-- el trigger NO corrió
   ### M5: mismo bypass contra la COLUMNA GENERADA
           update src set cb='Y'  ->  entrada_digest = 57cec4137b614c87   <-- recalculó igual
   ```
   Es exactamente la condición **P-1** ya declarada, y no la agrava: quien puede hacer esto ya
   puede hacer `alter table`. Pero deja de ser cierto decir «no falsificable» a secas: lo correcto
   es **«no falsificable por `app_request` ni por `app_job`»**.
2. **Si alguien borra el trigger, el sistema se cae en vez de mentir** (`M3`:
   `null value in column "entrada_digest" ... violates not-null constraint`). Fail-closed y
   ruidoso — la dirección correcta.
3. **El digest es más sensible que el uso real del motor**: incluye `importe` y `fecha` completos
   aunque el motor sólo use el signo del importe y la fecha para vigencia de padrón. Es
   deliberado: una corrección de importe (remediación `0012`) **debe** invalidar la
   interpretación, no colarse debajo de ella. Costo: algún reproceso de más. Dirección correcta.
4. **Clasificación (para `seguridad-datos-financieros`, no la decido yo):** `entrada_digest` es un
   digest sobre material **N2** (`concepto_banco` N2, `importe` N2, `fecha` N2) — no hay ninguna
   columna N2-R en la entrada del motor, así que **la tabla NO entra al régimen de lectura
   auditada** y la decisión de `0014` (cabecera, §«los cuatro renglones extra») se mantiene. El
   precedente exacto ya existe en la misma tabla: `fila_hash` es
   `{ nivel: 'N2', exportable: false }` con la nota *«No es reversible, pero SÍ es comparable:
   publicarlo permitiría preguntar ¿tenés esta operación? desde afuera»*. **Propongo la misma
   clasificación**, en `clasificacion-campos.ts`, en la misma tarea.
5. **No hace falta índice nuevo.** El `select` del trigger va por `(cliente_id, id)`, que es
   `uq_mov_crudo_tenant` — el **mismo** índice que ya usa `fk_recon_movimiento` en cada insert.
   Costo por fila: una búsqueda que ya se estaba haciendo.
6. **No medido:** el costo real del `ALTER TABLE ... ADD COLUMN ... GENERATED` sobre las 1830
   filas del piloto. Es una reescritura con `ACCESS EXCLUSIVE`; sobre 1830 filas se espera
   milisegundos, pero **el número hay que tomarlo en local con el corpus cargado antes de
   ir al piloto** (local tiene hoy 0 movimientos, medido).

---

## PREGUNTA 2 — ¿se recorta el `grant insert` de tabla entera a columnas específicas?

### Dictamen

**Sí, se recorta — pero la razón principal NO es la columna de hash, es `created_at`.**
El hash queda protegido por el trigger con o sin recorte (medido); el recorte convierte una
mentira *silenciosamente corregida* en un `42501` ruidoso. Lo que hoy **sí** es un agujero real y
sin control es que `app_request` puede nombrar `created_at` y `superseded_por` en el INSERT.

### Donde discrepo con el planteo de la pregunta

**«si `0021` agrega una columna de hash, bajo un grant de tabla esa columna es nombrable por el
tenant desde el minuto cero, y el determinante lo elegiría quien escribe» — falso para esta
columna.** Con la columna llenada por trigger y `grant insert` de **tabla entera**, la mentira del
escritor **se sobrescribe en silencio**:

```
### M1: grant insert ON TABLE; app_request inserta entrada_digest='0000000000000000'
        INSERT 0 1 ;  quedo_guardado = a46f07eaf74bc0fa    <-- el digest VERDADERO
### M2: grant insert POR COLUMNA; mismo ataque
        ERROR:  permission denied for table child
```

O sea: el recorte **no compra integridad del hash** (ya la tiene el trigger). Compra que el
intento falle **ruidoso** en vez de ser un no-op silencioso, y —esto sí es nuevo— cierra
`created_at`. Decirlo al revés sería atribuirle al grant un control que en realidad sostiene
el trigger, que es el error de razonamiento que este repo ya pagó tres veces.

### Estado real hoy (medido contra el esquema aplicado en local)

`relacl = {sistema_contable=arwdDxt/…, app_request=ar/…}` → grant de tabla, y las **19** columnas
dan `has_column_privilege(...,'INSERT') = t`, **incluidas `es_propuesta` (generada), `created_at`,
`superseded_por` y `recalculo_disponible`**.

### Qué entra y qué queda vedado

`escrituras.ts:323-329` nombra **exactamente 15** columnas. Ésas entran; el resto no.

| Columna | ¿INSERT? | Motivo |
|---|---|---|
| `id` | ✅ | La aplicación **elige** el uuid: la supersesión escribe `superseded_por = pedido.reconocimientoId` **antes** del INSERT (`escrituras.ts:314`). No es `identity` → el incidente #7 no aplica. |
| `cliente_id`, `movimiento_id`, `motor_digest`, `clase`, `tipo`, `concepto`, `polaridad`, `lado`, `que_decide`, `motivo_codigo`, `via`, `evidencia_entrada_lexico_id`, `evidencia_caracteres_matcheados`, `evidencia_hubo_cola` | ✅ | Son la fila que el motor produce. |
| **`entrada_digest`** (nueva) | ❌ | La escribe el trigger. Con grant, la mentira es un no-op silencioso (`M1`); sin grant, `42501` (`M2`). |
| **`es_propuesta`** (generada) | ❌ | 🔴 Postgres **acepta sin error** `grant insert (columna_generada)` (`G1`: `GRANT`). No hay red: la exclusión tiene que ser deliberada y con test. |
| **`created_at`** | ❌ | 🔴 **El agujero real de hoy.** Un tenant antedata su propio reconocimiento. Es H-B textual — `0019:88-90` lo cerró en la tabla nueva y `0020` §1 vedó `ocurrido_en` por lo mismo. Nadie lo escribe: `escrituras.ts` no lo nombra. |
| **`superseded_por`** | ❌ | 🔴 Hoy se puede insertar una fila **nacida superseded**: sale del predicado de `uq_recon_vigente`, nunca aparece en la cola de revisión, y nada falla. Conserva su `grant update`. |
| **`recalculo_disponible`** | ❌ | Sin productor (`0014` decisión 9). Conserva su `grant update`. |

### La sintaxis, y el modo de falla del `revoke` (medido en las dos direcciones)

La forma canónica del repo (`0017:338`, `0018:56-62`, `0020:107-110`) es **revocar a nivel tabla y
re-otorgar columna por columna**. Lo verifiqué en los dos sentidos:

```
### R1: grant POR COLUMNA -> revoke de TABLA
        residuo = (ninguna columna con attacl)        <-- el revoke de tabla SÍ limpia las columnas
        has_column_privilege('app_request',...,'b','INSERT') = f
### G5/R2: grant de TABLA -> revoke POR COLUMNA
        b_sigue_pudiendo = t                          <-- 🔴 NO-OP SILENCIOSO, confirmado
### R2b: grant POR COLUMNA -> revoke POR COLUMNA
        cliente_id=t, b=f                             <-- sí saca esa columna
```

⚠️ **Matiz sobre `0018:58-59`.** Ese comentario afirma que
*«`revoke update (parent_id)` sobre un grant de columna existente **no lo saca**»*. **Medido, sí lo
saca** (`R2b`). Lo que **no** funciona es `revoke` por columna sobre un grant de **tabla** (`G5`),
que es lo que dicen correctamente `0018:60` y `0020:107`. La **acción** de `0018` es correcta e
igual la mejor (revocar tabla y reconstruir deja el estado que uno cree que deja); lo que está
mal es la **primera** de las dos justificaciones. No se toca `0018` —está aplicada— pero conviene
no propagar la frase a `0021`.

### Tests: lo que hay y lo que falta

El barrido de catálogo **no cubre el renglón (7)**. Sólo hay verificaciones puntuales escritas a
mano, y **una sola** con cobertura inversa de conjunto cerrado en todo el repo:
`packages/data/tests/membership-supervision.test.ts:573` (`toEqual` sobre
`information_schema.column_privileges` filtrado por `table_schema='public'`).

Los tests de grant existentes son **todos de cobertura positiva o negativa por nombre**, ninguno
de conjunto cerrado:
- `packages/data/tests/catalogo.test.ts:1158` — sobre `acceso_auditoria` sólo asserta que `id` y
  `ocurrido_en` **no** están; **no** compara contra las siete columnas de `0020` §1. Una columna
  otorgada de más pasa verde.
- `packages/data/tests/catalogo.test.ts:1194` — `via_depth` por `not.toContain`, misma limitación.
- `packages/data/tests/path-coherente.test.ts:400` — el único uso de `pg_attribute.attacl`.

**Hace falta un test nuevo, con cobertura INVERSA de conjunto cerrado**, calcado de
`membership-supervision.test.ts:573`:

```sql
select grantee, column_name
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'reconocimiento_movimiento'
   and privilege_type = 'INSERT' and grantee in ('app_request','app_job')
 order by grantee, column_name
```
`toEqual` contra las 15 columnas esperadas. Sin `toEqual` de conjunto, el 🔴 que `0020` dejó
escrito para `via_depth` —*«el día que alguien re-otorgue de tabla entera copiando la plantilla de
ADR-0001 §5, el control desaparece SIN QUE NADA se ponga rojo»*— vuelve a valer palabra por
palabra acá.

Y un segundo test, para el trigger: `has_column_privilege('app_request', 'reconocimiento_movimiento',
'entrada_digest', 'INSERT') = false`.

### Prueba de mutación (ADR-0002 §B.0 / CLAUDE.md §1.8)

**7 mutaciones, elegidas para REFUTAR.** Las siete ya corrieron en local; van a la suite.

| # | Mutación (el defecto escrito a propósito) | Qué debe pasar | Medido |
|---|---|---|---|
| 1 | `check` sin `not null` en `entrada_digest` | debe quedar ROJA: `insert` con `NULL` pasa el check | ✅ `S4` |
| 2 | `grant insert` de tabla en vez de por columna | debe quedar ROJA: el ataque a `created_at` entra | ✅ `M1` / `G2` |
| 3 | trigger borrado | `not null` lo caza (`23502`), no pasa silencioso | ✅ `M3` |
| 4 | movimiento de otro tenant (RLS lo oculta) | fail-CLOSED, no fail-open | ✅ `X2` |
| 5 | escritor nombra `entrada_digest` | `42501`, no valor elegido | ✅ `M2` / `X3` |
| 6 | `revoke insert (col)` en vez de `revoke insert on table` | debe quedar ROJA: no-op silencioso | ✅ `G5` |
| 7 | determinante con `unique` clásico y padrón `NULL` | debe quedar ROJA: dos filas idénticas entran | ✅ `N1` |
| **caso legítimo** | insert normal de las 15 columnas, movimiento propio | `INSERT 0 1`, digest correcto | ✅ `X1`, `I1` |

🔴 **La mutación 7 es un hallazgo de forma, no de grants**, y es bloqueante para la mitad del
padrón: `unique` trata los `NULL` como distintos, así que dos filas de capa B (sin manifestación
de padrón) **no colisionarían jamás**:

```
### N1: unique (c,m,d,pad)                      -> filas_duplicadas_admitidas = 2   🔴
### N2: unique NULLS NOT DISTINCT (c,m,d,pad)   -> 23505 duplicate key value        ✅
```
`nulls not distinct` es PG15+ y **está disponible** en 16.13.

---

## EL DDL QUE PROPONGO

```sql
-- =============================================================================
-- 0021 — bloque «determinante de la ENTRADA». (La mitad de `padron_manifestacion`
-- y `reconocimiento_contrapartida` va aparte, con sus siete renglones de ADR-0001 §5.)
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. El digest de la ENTRADA, donde la entrada vive: COLUMNA GENERADA.
--
-- Es `generated always as ... stored` y no un valor que pase la aplicación porque
-- MEDIDO: una generada no se puede escribir ni con `grant insert` de TABLA ENTERA
-- (`cannot insert a non-DEFAULT value into column`), y ni siquiera un superusuario
-- con `session_replication_role='replica'` la falsifica — recalcula igual. Es el
-- único escalón de esta migración que sobrevive a P-1.
--
-- 🔴 `md5` Y NO `sha256`. `sha256` exige `bytea`, y el único camino inmutable
-- desde `text` es el cast `::bytea`, que REINTERPRETA el texto como literal de
-- bytea: `'ZZ\xGG'::bytea` aborta con 22P02 y `'\101'::bytea` = 'A'. Un
-- `concepto_banco` recortado de una glosa haría explotar el INSERT en runtime.
-- `convert_to(...,'UTF8')` es la forma correcta y NO es IMMUTABLE (medido: la
-- generada se rechaza). `pgcrypto` no está instalado y es no-core (ADR-0000 §2).
-- No es una primitiva de seguridad: es un DETECTOR DE CAMBIO. 16 hex, la misma
-- forma que `motor_digest` — dos formas para la misma idea invitan a confundirlas.
--
-- 🔴 PREFIJO DE LONGITUD EN CADA TEXTO LIBRE. `md5(a || '|' || b)` con un operando
-- NULL da NULL ENTERO (medido), y `text` no puede contener el byte NUL (medido:
-- 'invalid byte sequence for encoding UTF8: 0x00'), así que no hay separador
-- reservado. El prefijo de longitud hace la codificación inyectiva: NULL -> `-:`,
-- '' -> `0:`, y `'x|1:y'` no colisiona con el par ('x','y').
--
-- 🔴 `fecha` VA COMO ENTERO. `date::text` NO es IMMUTABLE (depende de `DateStyle`)
-- y la generada se rechaza; `timestamptz::text` tampoco (`TimeZone`), y `concat_ws`
-- tampoco (es STABLE). La resta de fechas sí lo es.
--
-- Cubre EXACTAMENTE las siete columnas que `leerEvidenciaDeMovimientos`
-- (`packages/data/src/contabilidad/lecturas.ts:303`) selecciona de esta tabla.
-- `banco_codigo` NO entra: viene del join a `lote_ingesta` y ya está cubierto
-- porque `motor_digest` es POR BANCO (`0014` decisión 1).
--
-- ⚠️ Es más sensible que el uso real del motor: incluye `importe` y `fecha`
-- completos aunque el motor sólo use el signo y la vigencia del padrón. A
-- propósito — una remediación de importe (`0012`) DEBE invalidar la
-- interpretación, no colarse debajo de ella. El costo es un reproceso de más.
-- -----------------------------------------------------------------------------
alter table movimiento_bancario_crudo
  add column entrada_digest text not null generated always as (
    left(md5(
         coalesce(length(concepto_banco)::text, '-') || ':' || coalesce(concepto_banco, '')
      || '|' || coalesce(concepto_completo::text, '-')
      || '|' || length(concepto_banco_estrategia)::text || ':' || concepto_banco_estrategia
      || '|' || coalesce(length(concepto_codigo)::text, '-') || ':' || coalesce(concepto_codigo, '')
      || '|' || importe::text
      || '|' || (fecha - date '2000-01-01')::text
      || '|' || length(contraparte_captura)::text || ':' || contraparte_captura
    ), 16)
  ) stored;

alter table movimiento_bancario_crudo
  add constraint mov_crudo_entrada_digest_chk check (entrada_digest ~ '^[0-9a-f]{16}$');

comment on column movimiento_bancario_crudo.entrada_digest is
  'N2 (exportable:false, mismo criterio que fila_hash). 16 hex de las SIETE columnas que el motor '
  'lee de esta fila. GENERADA: no se puede escribir ni con grant de tabla entera, ni con '
  'session_replication_role=replica (medido). Es el determinante de la ENTRADA que a motor_digest '
  'le falta: motor_digest cubre el CÓDIGO, y la entrada es MUTABLE '
  '(recapturar-conceptos.ts y backfill-contraparte.ts hacen UPDATE sobre esta tabla). '
  'Es además el productor que le faltaba a recalculo_disponible: un join contra '
  'reconocimiento_movimiento.entrada_digest lista todo reconocimiento vigente cuya entrada cambió.';

-- -----------------------------------------------------------------------------
-- 2. La FOTO HISTÓRICA en el reconocimiento.
--
-- 🔴 POR QUÉ NO ES UNA FK CONTRA LA GENERADA DEL PADRE, que es lo que el patrón de
-- `0017` sugeriría. MEDIDO: con `(cliente_id, movimiento_id, entrada_digest)
-- references movimiento_bancario_crudo (cliente_id, id, entrada_digest)` la mentira
-- del hijo muere (23503, bien) PERO el primer reconocimiento de un movimiento
-- CONGELA `concepto_banco` para siempre: `update movimiento_bancario_crudo set
-- concepto_banco = ...` aborta con 23503 y `recapturar-conceptos.ts` deja de
-- existir como operación. Una FK afirma un hecho PRESENTE; esta columna registra
-- uno HISTÓRICO — qué entrada tenía el movimiento CUANDO se lo interpretó. Y
-- `on update cascade` es peor: reescribiría en silencio el digest de una
-- interpretación ya emitida, justo lo que `0014` decisión 2 prohíbe.
-- Por eso el invariante baja hasta el trigger y no más: es el escalón más bajo
-- disponible para un hecho histórico.
-- -----------------------------------------------------------------------------
alter table reconocimiento_movimiento
  add column entrada_digest text not null;   -- (la tabla está VACÍA: 0 filas en local y en piloto)

alter table reconocimiento_movimiento
  add constraint reconocimiento_entrada_digest_chk check (entrada_digest ~ '^[0-9a-f]{16}$');

-- 🔴 NO es `security definer` (R11 limita eso a dos funciones) y NO tiene que serlo:
-- el trigger COPIA, y un trigger que copia FALLA CERRADO. MEDIDO contra una tabla
-- con `force row level security`: si la policy le esconde la fila de origen, el
-- `select ... into` deja NULL y el `not null` de arriba rechaza el INSERT (23502).
-- Es la diferencia con el trigger que `0014:684-688` descarta, que CUENTA: ése, sin
-- filas visibles, cuenta 0, satisface el predicado y falla ABIERTO. Contar y copiar
-- fallan en direcciones opuestas.
-- `search_path` explícito con `pg_temp` al final, por `0015_search_path_pg_temp.sql`.
create function app.copiar_entrada_digest() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  select m.entrada_digest into new.entrada_digest
    from public.movimiento_bancario_crudo m
   where m.cliente_id = new.cliente_id
     and m.id = new.movimiento_id;
  return new;
end;
$$;

-- Sólo BEFORE INSERT: la foto se toma una vez. `entrada_digest` no tiene grant de
-- UPDATE para nadie, y un reconocimiento no se corrige — se supersede.
-- No hace falta índice nuevo: el select va por `uq_mov_crudo_tenant (cliente_id, id)`,
-- el MISMO índice que `fk_recon_movimiento` ya recorre en cada insert de esta tabla.
create trigger trg_reconocimiento_entrada_digest
  before insert on reconocimiento_movimiento
  for each row execute function app.copiar_entrada_digest();

comment on column reconocimiento_movimiento.entrada_digest is
  'N2 (exportable:false). Foto de movimiento_bancario_crudo.entrada_digest AL MOMENTO de la '
  'interpretación. La escribe app.copiar_entrada_digest() y NADIE tiene grant de insert ni de '
  'update sobre ella: con grant de tabla la mentira del escritor se sobrescribía en silencio, sin '
  'grant devuelve 42501 (medido). Si el trigger desaparece, el not null lo caza con 23502 — falla '
  'cerrado. ⚠️ Residual declarado: el dueño, que HOY es superusuario (P-1), la falsifica con '
  'session_replication_role=replica. La generada del padre NO (medido).';

-- -----------------------------------------------------------------------------
-- 3. EL DETERMINANTE NUEVO. Tres dimensiones: CÓDIGO ⊕ ENTRADA ⊕ PADRÓN.
--
-- `0014:426-432` dejó declarado el límite que esto levanta. Y agrega la dimensión
-- que `escrituras.ts:298-302` declaró sin cubrir: un reproceso que cambia
-- `concepto_banco` sin cambiar la clase daba no-op con la interpretación vieja
-- intacta. Con `entrada_digest` en el determinante, esa fila es OTRA fila.
--
-- 🔴 `NULLS NOT DISTINCT`, Y NO ES COSMÉTICO. Capa B no consulta el padrón, así que
-- `padron_manifestacion_id` es NULL en toda fila de capa B. MEDIDO: con un `unique`
-- clásico, dos filas de capa B idénticas ENTRAN LAS DOS —`unique` trata los NULL
-- como distintos— y la idempotencia entera desaparece justo en el camino más
-- transitado. Es PG15+ y estamos en 16.13 (verificado).
--
-- ⚠️ EXIGE, EN LA MISMA TAREA, cambiar `escrituras.ts`: el corto-circuito de no-op
-- (:303) compara `motor_digest` y `clase`, y tiene que comparar TAMBIÉN
-- `entrada_digest` — si no, la base admite la fila nueva pero la aplicación nunca
-- llega a intentarla, y el arreglo queda sin efecto. Y el `on conflict` (:328) pasa
-- a nombrar las cinco columnas.
-- -----------------------------------------------------------------------------
alter table reconocimiento_movimiento
  drop constraint uq_recon_determinante,
  add  constraint uq_recon_determinante
    unique nulls not distinct
      (cliente_id, movimiento_id, motor_digest, entrada_digest, padron_manifestacion_id, es_propuesta);

-- -----------------------------------------------------------------------------
-- 4. EL GRANT, RECORTADO A LAS 15 COLUMNAS QUE `escrituras.ts:323-329` NOMBRA.
--
-- 🔴 Va `revoke` a nivel TABLA y después se re-otorga columna por columna. MEDIDO
-- en las dos direcciones: `revoke insert (col)` sobre un grant de TABLA es un NO-OP
-- SILENCIOSO (la ACL queda idéntica, sin error y sin warning), y `revoke insert` de
-- tabla SÍ limpia los grants de columna sin dejar residuo. Es la forma canónica de
-- `0017:338`, `0018:56` y `0020:107`.
--
-- Lo que esto compra, ordenado por lo que de verdad cierra:
--   · `created_at`      -> 🔴 hoy un tenant ANTEDATA su propio reconocimiento. Es
--                          H-B textual: `0019:88-90` lo cerró en la tabla nueva y
--                          `0020` §1 vedó `ocurrido_en` por lo mismo.
--   · `superseded_por`  -> 🔴 hoy se puede insertar una fila NACIDA SUPERSEDED: sale
--                          del predicado de `uq_recon_vigente`, nunca aparece en la
--                          cola de revisión, y nada falla. Conserva su grant de UPDATE.
--   · `es_propuesta`    -> Postgres ACEPTA SIN ERROR `grant insert` sobre una columna
--                          generada (medido). No hay red: la exclusión es deliberada.
--   · `entrada_digest`  -> convierte un no-op silencioso en 42501 (medido). El trigger
--                          ya sostenía la integridad; esto sostiene el RUIDO.
--   · `recalculo_disponible` -> sin productor (`0014` decisión 9).
--
-- `id` SÍ entra: la aplicación elige el uuid porque la supersesión escribe
-- `superseded_por = pedido.reconocimientoId` ANTES del INSERT (`escrituras.ts:314`).
-- No es `identity`, así que el incidente #7 no aplica.
--
-- ⚠️ CONSECUENCIA PARA EL FUTURO, igual que `0020:121`: con grant por columna, la
-- próxima columna de esta tabla NO es insertable y falla en RUNTIME, no en la
-- migración. Toda columna nueva se agrega al grant en LA MISMA migración que la crea.
-- -----------------------------------------------------------------------------
revoke insert on reconocimiento_movimiento from app_request;

grant insert (
  id, cliente_id, movimiento_id, motor_digest,
  clase, tipo, concepto, polaridad, lado,
  que_decide, motivo_codigo,
  via, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados, evidencia_hubo_cola
) on reconocimiento_movimiento to app_request;

-- `grant select` y `grant update (superseded_por, recalculo_disponible)` de `0014`
-- NO se tocan. `app_job` sigue sin recibir nada.

commit;
```

### Lo que esta migración exige en la misma tarea (o no cierra)

1. `packages/data/src/contabilidad/escrituras.ts` — el no-op de `:303` compara también
   `entrada_digest`; el `on conflict` de `:328` nombra las cinco columnas. **Sin esto el DDL no
   sirve para nada**: la base admitiría la fila y la aplicación nunca la intentaría.
2. `packages/shared/src/seguridad/clasificacion-campos.ts` — las dos columnas nuevas, `N2` /
   `exportable: false`, con el precedente `fila_hash` citado. Sin entrada, el gate se pone rojo.
3. El test de **cobertura inversa de conjunto cerrado** del grant (arriba), que hoy no existe para
   ninguna tabla salvo `membership`.
4. Las **7 mutaciones** de la tabla de arriba, en la suite.
5. `padron_manifestacion` y `reconocimiento_contrapartida` con los **siete renglones** de
   ADR-0001 §5, policies **por operación** (nunca `for all`), unicidades **por cliente**, y la FK
   de `padron_manifestacion_id` desde `reconocimiento_movimiento`. Fuera del alcance de estas dos
   preguntas; el `unique` de arriba ya la referencia y **no compila sin ella**.
