# Dictamen de arquitectura — migración `0021` (determinante de idempotencia + capa C)

> `arquitecto-software`. Modo plan, sin DDL escrito. Insumo para el plan §3.2 que el titular apruebe.

## Discrepancia con el planteo (al principio, no enterrada)

1. **La "cuarta fuente de variación" del punto 2 no es hipotética: ya está.** Son los candidatos de
   contraparte del movimiento (`movimiento_contraparte_identificador`, que `backfill-contraparte.ts`
   apenda) y el `pepper_id` de la corrida. Son cuatro, no tres.
2. **El alcance "una sola migración" incluye una tabla sin especificación escrita.**
   `reconocimiento_contrapartida` no tiene forma declarada en ningún lado del repo — sólo el nombre,
   en `0014:12`. Y no participa del determinante. Objeción fundada: se diseña en su propio paso.
3. **La razón que `0014` dio para juntar ya no aplica.** `0014:444-446` justifica meter la unicidad
   ahora porque "no se puede agregar después sobre una tabla con datos sin rewrite". Hoy el piloto
   tiene CERO reconocimientos: partir nunca va a ser más barato que ahora.

## 1. Dónde vive el invariante

**Híbrido, y la frontera se declara por componente.** Columna `generated ... stored` en
`movimiento_bancario_crudo` (la entrada ES fila-local: los 7 campos que lee el motor son columnas de
esa fila) + espejo en `reconocimiento_movimiento` atado por FK compuesta — idiom literal de `0017`
(`parent_path` + `check` fila-local + FK compuesta diferida `no action`).

Cobertura:

| Componente | Lo cubre | Cómo |
|---|---|---|
| `entrada_digest` | **La base** | `generated` en crudo + FK compuesta desde el reconocimiento vigente |
| `padron_digest` | **La base, parcialmente** | FK a `padron_manifestacion` (el valor tiene que existir); que el digest refleje el padrón: app + test |
| `motor_digest` | **Sólo app + test** | Su referente es CÓDIGO, no vive en la base. Irreducible |

Descartado: (b) hash puro en TS — el escritor puede mentir, y bajo concurrencia miente sin querer.
Descartado: crudo append-only (haría desaparecer el problema) — cuesta re-fundar la ingesta.

## 2. Composición del determinante

**Columnas explícitas en la unicidad, nunca un hash enrollado.** Razón de mecanismo, no de elegancia:
un hash enrollado **no se puede atar por FK a nada**, y perdería el único componente que la base sí
puede sostener.

`uq_recon_determinante (cliente_id, movimiento_id, motor_digest, entrada_digest, padron_digest, es_propuesta)`

La cuarta fuente que aparezca **ensancha la tupla y eso es una migración**, con un test que ate el
conjunto de columnas del constraint a una constante de TS (`COMPONENTES_DEL_DETERMINANTE`). Hoy ese
gate no existe para `unique` — hay que escribirlo.

## 3. Acoplamiento

Real entre *unicidad* y *`padron_manifestacion`*. **Inexistente** entre unicidad y
`reconocimiento_contrapartida`. Recomendación: `0021` = determinante + manifestación;
`reconocimiento_contrapartida` en su propio paso, con su spec ratificada antes.

## 4. Los cinco puntos de §3.2

1. **Qué cambia y qué no** — cambia `movimiento_bancario_crudo` (+1 generada, +1 unique),
   `reconocimiento_movimiento` (+espejos, +FK, +unicidad nueva) y nace `padron_manifestacion`.
   Queda afuera a propósito: `reconocimiento_contrapartida` (se pierde la evidencia de capa C
   persistida — por eso el piloto no persiste capa C hasta que exista) y `asiento_propuesto`.
2. **Qué se mide** — conteo de `pnpm verificar`; digests distintos sobre el corpus local;
   movimientos que cambian de clase al soltar el gate hardcodeado.
3. **Predicción falsable** — tabla por paso, escrita antes del DDL (§5 de `09-lecciones`).
4. **Agentes** — `dba-data`, `security-engineer`, `seguridad-datos-financieros` (obligatorios),
   `contador-dominio`, `motor-conciliacion-contable`, `qa-automation`, `tester`, `code-reviewer`.
5. **Paso revertible más chico** — P0 función de digest (mueve un número, no es no-op);
   P1 generada en crudo (carga sola el riesgo `IMMUTABLE`); P2 espejo+FK+unicidad; P3 manifestación;
   P4 soltar el gate; P5 `reconocimiento_contrapartida`.

## Riesgos a verificar ANTES del DDL (no asumidos)

- ¿La expresión del digest puede ser `IMMUTABLE`? (`md5` sí; `date::text` y `to_char` NO lo son).
- ¿`match full` con todas las columnas de la FK en NULL queda satisfecha? (para la FK parcial).
- ¿Una generada `stored` sirve del lado REFERENCIADO de un `unique` usado por FK?
  (del lado referenciante ya está probado: `0014:696`).
