# 29 — `padron_contraparte`: catálogo de proveedores/clientes conocidos por nombre

> Diseño cerrado por convocatoria (dos rondas), **sin código ni migración aplicada todavía**. Este
> documento es el registro que la convocatoria de origen no tuvo — nació y se cerró en una sesión de
> Claude Code y, hasta escribirse este archivo, no existía en ningún lado del repo (ver §5).

## 0. Motivación

Hallazgo real de Laura (la contadora), 2026-09-04: varios proveedores de un cliente del piloto no se
clasifican solos porque el léxico de Capa C (`packages/contabilidad/src/lexico/galicia.ts`) reconoce el
**patrón genérico** de la glosa bancaria (ej. `TRF INMED PROVEED` → concepto `pago_a_proveedor_inmediato`)
pero eso solo dice "esto es un pago a ALGÚN proveedor" — no dice A CUÁL. El movimiento queda con la cuenta
genérica o en `decision_humana`.

Este documento **no repite ningún nombre real** de proveedor/cliente — se refiere a ellos por cantidad o
patrón, siguiendo la restricción explícita de las dos convocatorias.

## 1. Convocatoria 1 — diseño de la tabla (arquitecto-software + contador-dominio + dba-data)

### 1.1 ¿Tabla nueva o extensión de `padron_socio`?

**Tabla nueva. `padron_socio` no se toca.**

Dos argumentos independientes, convergentes:

- **arquitecto-software**: `padron_socio.documento_hmac/documento_tipo/pepper_id` son `not null` porque
  *todo* socio tiene CUIT/CUIL — un proveedor conocido solo por nombre no tiene ese dato, y volverlo
  nullable rompería un invariante que `resolverContraparte` hoy confía ciegamente. Además, la política de
  escritura de `padron_socio` (`socio`/`contador`, sin `administrativo`) está justificada por el riesgo de
  cargar mal un SOCIO — riesgo mayor que cargar mal un proveedor. Mezclar poblaciones fuerza una sola
  política para dos decisiones de autorización distintas. Mismo patrón que el propio `0013` ya aplicó dos
  veces ("vocabulario cerrado, sin mezclar conceptos").
- **dba-data**: el documento de un socio está en la lista N2-R de ADR-0002 §A.1 (identificador que
  habilita fraude). Un **nombre comercial** está clasificado **N2** en los tres precedentes ya escritos en
  el repo (`tenant_node.nombre`, `padron_socio.denominacion`, `cuenta_atributo.denominacion`) — nunca
  N2-R.

**Consecuencia de diseño:** `padron_contraparte` **no necesita la partición N2/N2-R** de `padron_socio`
(sin HMAC, sin pepper, sin satélite, sin lector auditado) — es estructuralmente **más simple** que su
precedente, no una copia con más columnas.

### 1.2 ¿Cuándo se consulta: antes o después del léxico genérico?

**Después, como refinamiento — nunca como constructor de `propuesta` por sí sola.**

Confirmado contra el pipeline real (`packages/contabilidad/src/nucleo/motor.ts` + `catalogo.ts` +
`contrapartida.ts`): el léxico decide QUÉ tipo de hecho es; el HMAC contra `padron_socio` decide
SOCIO-o-TERCERO; `padron_contraparte` (match de texto) decidiría CUÁL tercero — tercer paso, subordinado a
los dos anteriores.

**Regla explícita, la decisión más importante de la ronda 1:**

- Si `resolverContraparte` ya dio `es_tercero_padron_completo` → el reconocimiento ya es `propuesta`
  genérica; `padron_contraparte` solo **enriquece** (agrega evidencia de cuál proveedor/cliente), sin
  tocar `clase`. No rompe el invariante "solo dos constructores de `propuesta`".
- Si dio cualquier otro estado que deja en `decision_humana` (incluido `sin_candidatos`, sospechado como
  el caso real de estos proveedores — sin CUIT/CBU en la glosa) → un match de NOMBRE **no promueve** a
  `propuesta`. Es evidencia estructuralmente más débil que el HMAC exacto que hoy protege contra la
  "conversión silenciosa de socio en proveedor" (`contrapartida.ts`, regla de alineación de pepper).
  Promover por nombre sería una decisión de negocio nueva (contador-dominio + product-owner), no algo
  que esta ronda resuelva.
- Si HMAC dio `es_socio` → `padron_contraparte` ni se consulta.

**Consecuencia:** no hace falta gate de "padrón completo" como el de `padron_socio` — "no match" nunca es
una conclusión acá, solo evidencia ausente. El "sin match" debe quedar registrado explícito (mismo
tri-estado que `contraparte_captura` de `0013`: "se consultó y no hubo match" ≠ "nunca se consultó") —
detalle de implementación, no cerrado en este documento.

### 1.3 Granularidad de `clasificacion` (contador-dominio)

**`proveedor | cliente | otro` alcanza como clasificación de FAMILIA de cuenta.** No hace falta más
granularidad de tipo de proveedor (habitual/ocasional, con/sin retención, condición IVA) — eso es
resolución fiscal al registrar la factura de compra, no del pago bancario.

Recomienda declarar explícito que **`otro` anula el default de proveedor/cliente** cuando el tercero es
conocido por otra vía (ej. empleado) — no dejarlo como categoría residual implícita.

Caso borde señalado, no bloqueante hoy: un tercero que es proveedor unos meses y cliente otros
necesitaría vigencia en la clasificación, no más valores de enum.

**Sin colisión verificada, literal por literal**, entre las dos reglas de default de Laura ("TRF INMED
PROVEED → proveedor salvo excepción", "TRANSFERENCIA DE TERCEROS → cliente salvo socio") y el léxico
existente de `galicia.ts`. Dos patrones "primos" (pago a proveedores por otro canal bancario, y transferencias
genéricas de egreso) quedan **fuera** de las reglas que Laura dio — no extender el default por analogía sin
confirmación de ella.

### 1.4 Mecanismo de matcheo (arquitecto-software + dba-data)

- Reusar el **vocabulario de diseño** del léxico (`galicia.ts`): modos cerrados, evidencia explícita,
  normalización antes de comparar, cero regex suelta. **No** reusar la función `reconocerPorTexto` tal
  cual — ancla en posición 0 de un campo ya aislado; el nombre del proveedor aparece como substring en
  texto libre de la glosa. Necesita su propia función pura en `nucleo/`, con su propia prueba de mutación
  (CLAUDE.md §1.8).
- **v1: match exacto post-normalización, sin `prefijoMinimo` por fila** — conservador, mismo criterio que
  ya usa `galicia.ts` ("conservador nunca es incorrecto, solo subóptimo").
- **Sin índice de patrón/`LIKE` en Postgres.** El motor trae el padrón completo del cliente (unidades de
  filas, no miles) y compara **en memoria**, con `normalizar()` de `packages/shared/src/texto/normalizar.ts`
  aplicado a los dos lados — la normalización vive una sola vez, en TypeScript; la base solo verifica la
  POSCONDICIÓN con checks (mayúsculas, recortado, sin espacios dobles, sin marcas NFD sueltas), nunca
  reimplementa el algoritmo.
- **La ambigüedad entre patrones (uno substring de otro) no la resuelve la base.** Se guardan todos los
  patrones vigentes del cliente; el criterio de desempate es del motor (capa C), mismo patrón que
  `movimiento_contraparte_identificador`. Semántica exacta del desempate: **pendiente**, no resuelta en
  este documento.

### 1.5 Diseño de tabla (dba-data) — ilustrativo, no aplicado

```sql
-- ILUSTRATIVO. No aplicar sin re-verificar el número de migración libre real (ver §4).
create table padron_contraparte (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      uuid not null references tenant_node(id) on delete restrict,

  -- N2. Ya normalizado por la aplicación (normalizar()) antes de escribir.
  patron          text not null,

  -- N2. Mismo argumento que subió cuenta_atributo.rol_funcional a N2: afirma un hecho real de la
  -- relación comercial de ESTE cliente con un tercero puntual.
  clasificacion   text not null,

  -- N2. Vigencia SEMIABIERTA — ver nota abajo, punto abierto.
  vigente_desde   date not null,
  vigente_hasta   date,

  created_at      timestamptz not null default now(),

  constraint padron_contraparte_patron_no_vacio_chk       check (btrim(patron) <> ''),
  constraint padron_contraparte_patron_mayuscula_chk      check (patron = upper(patron)),
  constraint padron_contraparte_patron_recortado_chk      check (patron = btrim(patron)),
  constraint padron_contraparte_patron_sin_espacios_dobles_chk check (patron !~ '  '),
  constraint padron_contraparte_patron_sin_marcas_chk     check (patron !~ '[̀-ͯ]'),

  -- MISMO guardia que padron_socio_denominacion_sin_identificador_chk: puerta de admisión contra un
  -- CUIT tipeado por error en `patron`.
  constraint padron_contraparte_patron_sin_documento_chk  check (patron !~ '[0-9]{7}'),

  constraint padron_contraparte_clasificacion_chk check (clasificacion in ('proveedor', 'cliente', 'otro')),
  constraint padron_contraparte_vigencia_chk check (vigente_hasta is null or vigente_hasta > vigente_desde),

  constraint uq_padron_contraparte_serie unique (cliente_id, patron, vigente_desde),
  constraint uq_padron_contraparte_tenant unique (cliente_id, id)
);

create unique index uq_padron_contraparte_vigente
  on padron_contraparte (cliente_id, patron) where vigente_hasta is null;

create index idx_padron_contraparte_cliente on padron_contraparte(cliente_id);

create trigger trg_padron_contraparte_cliente
  before insert or update of cliente_id on padron_contraparte
  for each row execute function app.exigir_nodo_cliente();

alter table padron_contraparte enable row level security;
alter table padron_contraparte force  row level security;

create policy padron_contraparte_sel on padron_contraparte for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- Sin `administrativo`: decidir que un tercero es proveedor/cliente cambia la imputación de TODOS sus
-- movimientos, pasados y futuros, sin que nada falle — mismo argumento que padron_socio_ins/upd.
create policy padron_contraparte_ins on padron_contraparte for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

create policy padron_contraparte_upd on padron_contraparte for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

-- Sin DELETE: un patrón mal cargado se CIERRA (vigente_hasta), nunca se borra.
grant select, insert on padron_contraparte to app_request;

-- 🔴 Update SOLO de vigente_hasta. A diferencia de padron_socio.denominacion (etiqueta cosmética),
-- `patron` ES la clave funcional de matching: un typo no es cosmético. Corregirlo es cerrar la serie
-- y dar de alta la nueva.
grant update (vigente_hasta) on padron_contraparte to app_request;

-- app_job no recibe nada: el alta corre como app_request, bajo conUsuario.
```

**Clasificación propuesta para `clasificacion-campos.ts`** (a confirmar por `seguridad-datos-financieros`
cuando se implemente):

| Columna | Nivel | Motivo |
|---|---|---|
| `id`, `cliente_id` | N1 | estándar |
| `patron` | **N2** | mismo tier que `tenant_node.nombre`/`padron_socio.denominacion` |
| `clasificacion` | **N2** | mismo argumento que `cuenta_atributo.rol_funcional` |
| `vigente_desde`/`vigente_hasta` | **N2** | vigencia de una relación comercial real |
| `created_at` | N1 | estándar |

### 1.6 Punto abierto — RESUELTO al aprobar la implementación (§6)

**¿`padron_contraparte` necesita vigencia `[vigente_desde, vigente_hasta)` real?** arquitecto-software no
encontró razón estructural para copiarla de `padron_socio` ("un proveedor no deja de ser proveedor con la
misma semántica que un socio deja la sociedad") y lo dejó como pregunta abierta para
contador-dominio/product-owner. dba-data la incluyó en su DDL ilustrativo por "mismo criterio que
`padron_socio`", sin resolver la tensión. **Decisión de JP al aprobar el plan de implementación
(2026-09-05): SÍ, mismo patrón semiabierto que `padron_socio`** — así quedó escrito en la migración `0037`
(§6).

## 2. Convocatoria 2 — enlace con `cuenta_id` (dba-data + plan-cuentas-multicliente)

Motivo: `proveedor|cliente|otro` alcanza para la FAMILIA de cuenta, pero **no** para que Capa D proponga
la cuenta ESPECÍFICA de cada proveedor — ese enlace faltaba y es lo que resuelve esta ronda.

### 2.1 Verificación empírica (plan-cuentas-multicliente)

Consulta de solo lectura contra el piloto (mismo patrón que `packages/data/scripts/respaldar-piloto.ts`,
sin ningún `INSERT`/`UPDATE`), sobre los dos únicos clientes con plan de cuentas real cargado (227 y 219
cuentas activas). Resultado, **sin ningún nombre real**:

- Familia "Proveedores"/"acreedor" en `cuenta_atributo` (vigencia abierta): 3-5 cuentas por cliente, todas
  en `nivel = 4`, `codigo` de longitud fija.
- `rol_funcional` en ambos clientes: solo `generica`/`cuenta_particular_socio` activos. **Cero** rastro de
  un rol ligado a proveedor puntual.
- Las longitudes de `denominacion` de esas cuentas **coinciden casi exactamente entre los dos clientes** —
  evidencia de que son rótulos genéricos de un plan modelo, no cuentas individuales por tercero real (si
  llevaran nombre de proveedor, las longitudes serían tan dispares como los propios proveedores de cada
  cliente).

**Conclusión empírica: hoy, en los dos únicos clientes reales, todo pago a proveedor imputa a un puñado de
cuentas genéricas — cero casos de sub-cuenta por proveedor.**

### 2.2 Discrepancia entre los dos dictámenes, y cómo se resolvió

| | dba-data | plan-cuentas-multicliente |
|---|---|---|
| Mecanismo propuesto | `padron_contraparte.cuenta_id` (FK que **resuelve** la cuenta destino, nullable, fallback al genérico si NULL) | `padron_contraparte_id` como FK de **evidencia** en el asiento propuesto (no resuelve cuenta) |
| Base del argumento | Precedente de forma: mismo patrón que `cuenta_bancaria.cuenta_id` (pata "banco" de D-29, `0030`) | Evidencia empírica: 0 casos reales de sub-cuenta por proveedor en los 2 clientes verificados |

Los dos coinciden en **no** agregar un quinto valor `'por_contraparte'` a `regla_imputacion.cuenta_resolucion`
— `0030` prohíbe explícitamente ampliar `rol_funcional` con conceptos contables, y agregar mecanismo sin
caso real repetiría lo que el propio `0030` ya evitó con `'por_jurisdiccion'`/`'por_impuesto'`.

**Decisión de JP (2026-09-04): se adopta el mecanismo de plan-cuentas-multicliente — evidencia, no
resolución de cuenta.** Razón explícita: verificación empírica > precedente de forma cuando no hay ningún
caso real que use la granularidad más pesada. `dba-data` había diseñado por analogía con `cuenta_bancaria`
sin haber verificado si el caso de uso existía; `plan-cuentas-multicliente` sí lo verificó contra el
piloto real y encontró que no.

**Consecuencia de diseño, declarada explícita para que no se reabra sin necesidad real:**

- La cuenta destino de un pago a proveedor/cobranza de cliente sigue siendo la genérica, resuelta como
  hoy por `regla_imputacion` (tipo_movimiento/concepto).
- `padron_contraparte` se enlaza al asiento como **evidencia trazable** (`padron_contraparte_id` en
  `asiento_propuesto_renglon`, mismo trato que `padron_manifestacion_id`) — permite que el asiento
  propuesto diga "esto matcheó contra el patrón de contraparte tal" sin mover la cuenta.
- **Si en el futuro un cliente real necesita cuenta propia para un proveedor puntual** (proveedor grande,
  litigio, moneda distinta — caso hipotético, no observado hoy), **el mecanismo ya existe sin tocar nada
  de este diseño**: alta de `cuenta` + `cuenta_atributo` por el contador/socio, con vigencia y
  `respaldo`, y una fila de `regla_imputacion` con `cuenta_resolucion = 'fija'` apuntando a esa cuenta
  para ese caso puntual. **No se pre-construye un campo `cuenta_id` nullable "por si acaso"** — mismo
  criterio de no sobre-especificar que ya aplicó `0030`.

### 2.3 Pendiente previo, no resuelto por esta convocatoria

`plan-cuentas-multicliente` señala que `distinguir_tercero_de_socio` (77,5 % de `decision_humana` en la
medición registrada en `HANDOFF.md`, ~línea 7306-7358) sigue siendo el problema real y **previo** a este:
antes de decidir a qué cuenta imputar, hay que resolver si el movimiento es socio o tercero — eso lo
resuelve `padron_socio`, no `padron_contraparte`. Este diseño no lo cierra ni lo reemplaza.

## 3. Resumen de decisiones cerradas

1. Tabla nueva `padron_contraparte`, N2 simple, sin HMAC/pepper/satélite/lector auditado.
2. Se consulta DESPUÉS del léxico y de `padron_socio`, solo como refinamiento — nunca promueve
   `decision_humana → propuesta` por sí sola.
3. `clasificacion ∈ {'proveedor', 'cliente', 'otro'}` — alcanza para familia de cuenta.
4. Match de texto exacto post-normalización (v1), en memoria en el motor — sin `LIKE`/índice de patrón en
   la base; ambigüedad la resuelve el motor, no la base.
5. RLS: `socio`/`contador` en escritura, sin `administrativo`, sin `for all`, sin DELETE. `patron`/
   `clasificacion` inmutables una vez escritos (solo `vigente_hasta` editable).
6. **Sin enlace a `cuenta_id`.** El vínculo con el asiento es de evidencia (`padron_contraparte_id`),
   nunca de resolución de cuenta. La cuenta destino sigue siendo la genérica actual.
7. Migración propia (verificar el número libre real antes de aplicar — no asumir `0037`, ver §4), nunca
   junto con otro frente.
8. Carga de proveedores/clientes reales: por CLI nuevo (`alta-contraparte.ts`, sin prompt oculto — `patron`
   no es N2-R), nunca por seed en el DDL. Confirmación explícita de la contadora, patrón por patrón y
   clasificación por clasificación, antes de cada alta contra el piloto.

## 4. Pendiente explícito para la implementación (fuera de este documento)

- Verificar el número de migración libre real en `packages/data/migrations/` al momento de escribirla —
  no asumir el visto durante el diseño.
- Función pura de matcheo en `nucleo/` + su prueba de mutación (CLAUDE.md §1.8), antes de `tester`.
- Semántica exacta de desempate entre patrones ambiguos (uno substring de otro) — no resuelta acá.
- Resolver el punto abierto de vigencia (§1.6) antes de fijar el DDL final.
- Clasificación real en `packages/shared/src/seguridad/clasificacion-campos.ts`, en la misma tarea que la
  migración — confirmar con `seguridad-datos-financieros`.
- Convocatoria completa de implementación, por la matriz de `agents/README.md` §3.1: `dba-data` +
  `security-engineer` + `seguridad-datos-financieros` (tabla nueva con `cliente_id`), `qa-automation`
  (prueba de mutación del matcher).
- CLAUDE.md §1.9 aplica en dos capas separadas cuando se llegue al piloto: la migración de esquema
  (listar-confirmar-frenar) y las altas reales por CLI (confirmación explícita de la contadora, no
  heredada de ningún precedente de exposición anterior).

## 5. Nota de proceso

Este diseño se cerró en dos convocatorias formales de Claude Code (arquitecto-software + contador-dominio
+ dba-data, después dba-data + plan-cuentas-multicliente), con dictámenes completos revisados por JP antes
de sintetizar. **Ninguna de las dos rondas se había persistido a `docs/` hasta este documento** — quedaron
solo en la sesión que las produjo, hasta que `dba-data`, en la segunda ronda, corrió `grep -rn
"padron_contraparte"` sobre el repo completo y confirmó cero resultados. Este documento cierra ese hueco.
Sin él, el diseño no existiría para Codex ni para la próxima sesión — mismo riesgo ya registrado en
[[planes-y-dictamenes-van-al-repo]].

## 6. Implementación (`0037`) — cerrada, sin conectar al pipeline

Convocatoria previa a escribir el DDL real: `security-engineer` + `seguridad-datos-financieros` sobre
el DDL concreto de §1.5 (exigido por CLAUDE.md §3.1 para toda migración/RLS, no cubierto por las dos
rondas de diseño). Un solo hallazgo bloqueante, corregido:

- **El guardia `patron !~ '[0-9]{7}'` tenía un vector de evasión medido en este repo**
  (`packages/shared/src/seguridad/detectores-forma.ts`): un CUIT con separadores de miles
  ("30.712.345.678") no tiene ninguna corrida de 7 dígitos *consecutivos*. Corregido a
  `patron !~ '[0-9]([[:space:].-]?[0-9]){6,}'` — 7+ dígitos con separador OPCIONAL entre cada uno.
  Puerta de admisión CONSERVADORA: un nombre real con una cadena larga de dígitos (código postal,
  número de sucursal) puede rechazarse como falso positivo — trade-off aceptado, mismo criterio que
  `padron_socio`; el CLI lo indica con claridad en el mensaje de error.
- **`asiento_propuesto_renglon.padron_contraparte_id` necesita FK COMPUESTA**, no simple — confirmado
  contra el DDL real de esa tabla (mismo patrón que `fk_asiento_renglon_manifestacion`). Sin la FK
  compuesta, un renglón de un cliente podría citar, como evidencia, el patrón de OTRO cliente — RLS no
  protege el `INSERT` del hijo contra ese vector. Verificado con mutación de DDL en vivo
  (`mutaciones-0037.test.ts`, bloque G): con una FK reducida a una sola columna, el cruce entra; con la
  FK compuesta real, se rechaza (`23503`).

Entregado en esta tarea:

- Migración `packages/data/migrations/0037_padron_contraparte.sql` — tabla, RLS, el enlace de evidencia.
- `packages/contabilidad/src/nucleo/contraparte.ts` — `resolverEvidenciaDeContraparte()`, la función
  pura con el corte de `es_socio` como regla dura. Prueba de mutación en vivo
  (`packages/contabilidad/tests/contraparte.test.ts`): comentar el corte da rojo, restaurarlo da verde.
- `packages/data/src/contabilidad/escrituras.ts` — `altaDeContraparte`/`bajaDeContraparte`.
- `apps/cli/src/alta-contraparte.ts` — CLI de alta/baja, sin prompt oculto (`patron` no es N2-R).
- `packages/data/tests/mutaciones-0037.test.ts` — 9 mutaciones + 8 legítimos sobre los checks/FK
  propios de esta migración (incluidas las dos mutaciones de DDL en vivo de arriba).
- Clasificación en `clasificacion-campos.ts`, registro en `catalogo.test.ts` (dominio cerrado) y en
  `grants-conjunto-cerrado.test.ts` (conjunto de grants).

**No conectado a propósito** (ver §4): `motor.ts`/`aplicarContrapartida`, la lectura de
`padron_contraparte` en `lecturas.ts`, y la persistencia de `padron_contraparte_id` al escribir un
renglón real. Es la integración pendiente, con su propia convocatoria si hace falta. Tampoco se cargó
ningún proveedor real — paso posterior, con confirmación de la contadora nombre por nombre.

**Nada de esto se aplicó contra el piloto.** Solo migración local, verificada con `--estado` de
solo lectura contra el piloto antes de tocar nada en local (confirmó que el piloto está limpio y que
`0037` es lo único pendiente ahí).
