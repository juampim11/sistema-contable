# ADR-0001 — Multi-tenancy jerárquica y RLS (estudio → cliente)

**Estado:** Aceptado (diseño). **Implementación:** migración `0001_tenancy.sql` escrita; el resto del
esquema anida en ella.
**Fecha:** 2026-08-09
**Depende de:** `ADR-0000-stack-infra.md` (Postgres + Drizzle + migraciones SQL plano, sin extensiones).
**Ver también:** `ADR-0002-seguridad.md` (los controles que hacen que esto no se rompa).
**Origen:** diseño portado de `admin-barrios/docs/diseno/03-modelo-datos.md` §A (leído y verificado),
con el mapeo de dominio de este producto y las correcciones de §A.4 y §7.

> El SQL de este documento es **ilustrativo del diseño**; el que se aplica es
> `packages/data/migrations/0001_tenancy.sql`. Lo marcado **[validar]** es propuesta a confirmar con
> producto, no decisión tomada.

---

## 1. Decisión en una frase

**Base y esquema compartidos, aislamiento por fila con RLS de Postgres, sobre un árbol de tenancy con
materialized path.** El estudio contable es el nodo raíz; cada cliente del estudio es un nodo hijo; toda
fila de dominio nace con su `cliente_id` y ninguna consulta la ve sin pasar por
`app.accessible_tenant_ids()`.

---

## 2. Las dos jerarquías, que no se confunden nunca

Este es el principio del que dependen todos los demás.

```
TENANCÍA / ACCESO   (tabla tenant_node — la RLS vive acá)
  Estudio "Pérez & Asoc."           tipo=estudio   path=1
   ├─ Cliente "Molinos del Sur SA"  tipo=cliente   path=1.7
   ├─ Cliente "J. Gómez (humana)"   tipo=cliente   path=1.9
   └─ Grupo "Grupo Andes"           tipo=grupo     path=1.12      [previsto, sin uso hoy]
        ├─ Cliente "Andes SA"        tipo=cliente   path=1.12.15
        └─ Cliente "Andes Log SRL"   tipo=cliente   path=1.12.16

DOMINIO  (datos DENTRO de un cliente; NO son nodos de tenancy)
  Cliente "Molinos del Sur SA" (tenant_node 1.7)
   ├─ plan de cuentas → cuenta → asiento → renglón
   ├─ movimiento bancario crudo → propuesta de asiento
   ├─ jurisdicciones de IIBB activas (con vigencia)
   └─ comprobantes, liquidaciones, estados contables
```

**Regla mental:** si dos personas jamás deben ver los datos de la otra, la frontera es un **nodo de
tenancy**. Si es estructura interna de un mismo cliente (una cuenta, una jurisdicción, una cuenta
bancaria), es **dominio** y lleva la columna `cliente_id`.

Errores concretos que esta regla evita:
- Modelar la **cuenta bancaria** de un cliente como nodo de tenancy: no lo es. Es dominio; el aislamiento
  ya lo da el `cliente_id`.
- Modelar el **plan de cuentas** como jerarquía de tenancy porque "es un árbol". Es un árbol de dominio,
  dentro de un cliente. Son dos árboles distintos con dos propósitos distintos.
- Modelar la **jurisdicción de IIBB** como tenant. No lo es: un cliente tiene **varias a la vez**
  (Convenio Multilateral) — es un atributo versionado del cliente
  (`agents/personas/plan-cuentas-multicliente.md`).

### 2.1. Mapeo desde `admin-barrios`

| `admin-barrios` | `sistema-contable` | Nota |
|---|---|---|
| Administrador de barrios (raíz) | **Estudio contable** (raíz) | Quien opera el sistema |
| Barrio (hijo) | **Cliente del estudio** (hijo) | El sujeto fiscal: persona humana o sociedad |
| Subsector (nieto) | **Grupo económico** (`grupo`) | **Invertido de lugar**: acá el agrupador va *arriba* del cliente, no abajo. Ver §2.2 |
| `barrio_id` en toda tabla de dominio | **`cliente_id`** en toda tabla de dominio | Misma mecánica, mismo índice, misma política |

### 2.2. Profundidad variable, con una regla dura

El árbol admite **profundidad variable** (`estudio` → `grupo`? → `cliente`), pero:

> **Toda fila de dominio cuelga de un nodo de `tipo = 'cliente'`.** Nunca de un `estudio` ni de un
> `grupo`. Un asiento pertenece a un sujeto fiscal, no a una agrupación comercial.

Esto se verifica en la base (trigger `app.exigir_nodo_cliente`, §4.4), no por convención. `grupo` queda
**previsto y sin uso**: existe para el caso real de un dueño con varias sociedades que quiere ver las
dos, sin que eso obligue a darle acceso a toda la cartera del estudio. **[validar]** con producto si el
caso amerita habilitarlo en el MVP.

---

## 3. `tenant_node` — el árbol

```sql
create schema if not exists app;

create type app.tipo_tenant as enum ('estudio', 'grupo', 'cliente');

create table tenant_node (
  id          uuid primary key default gen_random_uuid(),  -- clave pública; las FK de dominio apuntan acá
  nid         bigint generated always as identity unique,   -- segmento del path: compacto e inmutable
  parent_id   uuid references tenant_node(id) on delete restrict,
  tipo        app.tipo_tenant not null,
  nombre      text not null,
  path        text not null,          -- '1', '1.7', '1.12.15' — mantenido por TRIGGER, no por la app
  deleted_at  timestamptz,            -- soft-delete: nunca borrado físico de un tenant con datos
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tenant_node_raiz_chk check (
    (tipo = 'estudio' and parent_id is null) or
    (tipo <> 'estudio' and parent_id is not null)
  )
);
```

**Por qué cada decisión:**

- **Segmento = `nid` (bigint identity), no el UUID ni el nombre.** Compacto (`1.12.15` en vez de tres
  UUID), **inmutable** (renombrar el cliente no toca el path) y numérico (nada de `%` ni `_` que escapar;
  y es un `ltree` válido si algún día se migra).
- **El path lo mantiene un trigger `BEFORE INSERT`, no la app.** Es un invariante de integridad: si lo
  calcula la app, un `INSERT` desde un job, una migración o una consola lo corrompe — y un path corrupto
  **es una fuga de aislamiento**, no un bug cosmético.
- **Consulta de subárbol:** `path = X or path like X || '.%'`. El `.` es obligatorio: sin él, `1.7`
  matchea `1.70` y un cliente ve otro. Es el bug clásico de este patrón.
- **`gen_random_uuid()` sin `pgcrypto`:** es core desde PostgreSQL 13; apuntamos a 16. Cumple el "cero
  extensiones" de ADR-0000 §6 — una extensión es una precondición de despliegue que no todo Postgres
  gestionado garantiza.
- **`on delete restrict`, no cascade.** Borrar un estudio no borra sus clientes ni su contabilidad.

---

## 4. Membresías, roles y funciones de RLS

### 4.1. `membership`

Una membresía en el nodo N otorga acceso a **N y a todo su subárbol**. Un usuario del estudio ve todos
sus clientes; un usuario de un cliente ve **solo** ese cliente; **dos clientes del mismo estudio jamás
se ven entre sí**.

```sql
-- [validar] roles tentativos, a confirmar con producto y con seguridad-datos-financieros
create type app.rol_membership as enum (
  'admin_plataforma',  -- staff del SaaS   [validar] ¿membresía o rol de BD? ver ADR-0002
  'socio',             -- titular del estudio: ve y firma todo su subárbol
  'contador',          -- prepara y revisa: registra asientos, liquida, confirma propuestas
  'administrativo',    -- carga y clasifica; NO confirma asientos ni presenta
  'auditor',           -- solo lectura, incluido el rastro de auditoría
  'cliente_lectura'    -- el cliente del estudio mirando lo suyo (portal futuro)
);

create table membership (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,       -- id que devuelve AuthProvider. SIN FK a un schema de auth: agnóstico
  tenant_node_id uuid not null references tenant_node(id) on delete cascade,
  rol            app.rol_membership not null,
  activo         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (user_id, tenant_node_id, rol)
);
```

**Los permisos son por membresía, no globales.** Un contador externo puede ser `contador` en el cliente
`1.7` y no tener nada en `1.9`. Por eso las escrituras verifican el rol **en el subárbol de esa fila**
(`app.has_role_on`), y no un "rol del usuario" global.

### 4.2. Las tres funciones

```sql
-- (1) Quién es el usuario actual. Alimentada por set_config('app.user_id', $1, true) por transacción.
--     Sin auth.uid(): el esquema no depende de que exista un schema de auth (ADR-0000 §3.1).
create or replace function app.current_user_id() returns uuid
  language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- (2) Subárbol accesible. STABLE => se evalúa una vez por query, no por fila.
--     SECURITY DEFINER con search_path FIJO: lee membership/tenant_node (que tienen RLS) sin recursión.
create or replace function app.accessible_tenant_ids() returns setof uuid
  language sql stable security definer set search_path = public, app as $$
  select distinct d.id
  from membership m
  join tenant_node n on n.id = m.tenant_node_id
  join tenant_node d on d.path = n.path or d.path like n.path || '.%'   -- el nodo y su subárbol
  where m.user_id = app.current_user_id()
    and m.activo
    and n.deleted_at is null
    and d.deleted_at is null
$$;

-- (3) Permiso por rol SOBRE un nodo, para escrituras finas.
create or replace function app.has_role_on(nodo_objetivo uuid, roles app.rol_membership[])
  returns boolean
  language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1
    from membership m
    join tenant_node mn on mn.id = m.tenant_node_id
    join tenant_node tn on tn.id = nodo_objetivo
    where m.user_id = app.current_user_id()
      and m.activo
      and m.rol = any(roles)
      and (tn.path = mn.path or tn.path like mn.path || '.%')
  )
$$;
```

**El `LIKE` corre sobre `tenant_node`, que es una tabla chica**, una vez por query. Las tablas grandes de
dominio se filtran por **igualdad indexada** `cliente_id in (…)`. Esa es la razón de ser del diseño: el
path resuelve *qué conjunto*, la igualdad hace el filtrado caliente.

**Por qué `SECURITY DEFINER` con `search_path` fijado:** sin `DEFINER` hay recursión de políticas (la
función lee tablas con RLS que a su vez llaman a la función). Sin `search_path` fijo, `DEFINER` es una
escalada de privilegios esperando un schema plantado en el path. Las dos mitades hacen falta.

### 4.3. Roles de base de datos

```sql
create role app_request nologin;              -- SUJETO A RLS. Lo usan la web y el CLI para trabajar.
create role app_job login bypassrls;          -- SALTEA RLS. Solo server-side, solo para tomar la cola.
```

⚠️ **Detalle de Postgres que importa y se pasa por alto:** los **atributos** de rol (`LOGIN`,
`BYPASSRLS`, `SUPERUSER`) **no se heredan** por pertenencia (`GRANT rol TO usuario`); los privilegios sí.
Por eso `app_job` es **el rol que se conecta** (`login`), y no un rol grupo al que se le concede
membresía: un usuario miembro de `app_job` **no** heredaría `BYPASSRLS` y las políticas se le aplicarían
igual. `app_request`, en cambio, sí funciona como rol grupo (solo necesita privilegios).

**Las contraseñas no van en la migración.** Los roles nacen sin contraseña; cada entorno crea su usuario
de login y le asigna la suya fuera del repo (`db:setup`).

**Las tablas las posee el dueño del esquema**, que no es `app_request`. De ahí `force row level
security`: el owner de una tabla ignora RLS por defecto, y `force` cierra ese agujero.

### 4.4. El invariante "el dominio cuelga de un cliente"

```sql
create or replace function app.exigir_nodo_cliente() returns trigger
  language plpgsql as $$
begin
  if not exists (
    select 1 from tenant_node n
    where n.id = new.cliente_id and n.tipo = 'cliente' and n.deleted_at is null
  ) then
    raise exception 'cliente_id % no es un nodo activo de tipo cliente', new.cliente_id;
  end if;
  return new;
end $$;
```

**Sin `SECURITY DEFINER`, a propósito:** corre con los privilegios de quien inserta, así que si la RLS le
oculta ese nodo, el `exists` da falso y el `INSERT` **falla**. Falla cerrado, que es la dirección
correcta. Un `DEFINER` acá convertiría el trigger en un oráculo de "¿existe el nodo X?" para tenants
ajenos. La política `with check` sigue siendo el control primario; el trigger es la red.

---

## 5. Cómo las tablas de dominio llevan el tenant (contrato para todo módulo futuro)

**Plantilla obligatoria.** Toda tabla con datos de un cliente:

```sql
create table <tabla> (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references tenant_node(id) on delete restrict,   -- (1)
  ...
  created_at  timestamptz not null default now()
);

create index idx_<tabla>_cliente on <tabla>(cliente_id);                     -- (2) SIEMPRE

create trigger trg_<tabla>_cliente                                            -- (3)
  before insert or update of cliente_id on <tabla>
  for each row execute function app.exigir_nodo_cliente();

alter table <tabla> enable row level security;                                -- (4)
alter table <tabla> force  row level security;                                -- (5) el owner tampoco

create policy <tabla>_sel on <tabla> for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );               -- (6)

create policy <tabla>_wr on <tabla> for all
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert, update, delete on <tabla> to app_request;               -- (7)
```

Los siete renglones son **no negociables** y verificables mecánicamente (ADR-0002). Faltar el (2) es un
problema de performance; faltar cualquiera de (4), (5), (6) es **una fuga de datos entre clientes**.

**`cliente_id` y no `tenant_path` como predicado caliente:** el UUID es estable ante re-parentado (mover
un cliente de grupo reescribe paths, **no** `cliente_id`), y la igualdad usa índice; un `LIKE` con
prefijo no constante desde un join no lo usa sobre tablas grandes.

### 5.1. El contrato del Módulo 1 — `movimiento_bancario_crudo`

**Estado verificado: en este repo no existe todavía ni una línea de código del Módulo 1** (no hay
`package.json`, ni `.ts`, ni `.sql` fuera de lo que crea este ADR). Por lo tanto no hay nada que
"agregar de forma aditiva": lo que corresponde es que el módulo **nazca** con la columna. Esta es la
forma obligatoria, lista para pegar en `0002_ingesta.sql` cuando se construya el módulo:

```sql
-- Lote: un archivo/casilla procesado. También lleva cliente_id (todo lo que se ingesta es DE alguien).
create table lote_ingesta (
  id                uuid primary key default gen_random_uuid(),
  cliente_id        uuid not null references tenant_node(id) on delete restrict,   -- ← DESDE YA
  cuenta_bancaria_id uuid,                    -- FK cuando exista la tabla; nullable hasta entonces
  banco_codigo      text not null,            -- qué adapter lo parseó
  origen            text not null,            -- 'archivo' | 'casilla' | 'api'
  archivo_clave     text,                     -- clave en ObjectStorage: cliente/<uuid>/extracto/...
  archivo_hash      text not null,            -- idempotencia: el mismo archivo no se procesa dos veces
  filas_leidas      integer not null default 0,
  filas_aceptadas   integer not null default 0,
  filas_rechazadas  integer not null default 0,
  estado            text not null,            -- 'recibido' | 'procesado' | 'con_errores'
  procesado_por     uuid,                     -- user_id del operador (o del job) — trazabilidad
  created_at        timestamptz not null default now(),
  unique (cliente_id, archivo_hash)           -- idempotencia POR CLIENTE, nunca global
);

-- El movimiento tal como vino, sin interpretar. La clasificación contable es del Módulo 2.
create table movimiento_bancario_crudo (
  id                uuid primary key default gen_random_uuid(),
  cliente_id        uuid not null references tenant_node(id) on delete restrict,   -- ← DESDE YA
  lote_ingesta_id   uuid not null references lote_ingesta(id) on delete restrict,
  -- dato crudo, preservado tal cual (ADR-0000: el dato de origen no se altera)
  fila_origen       jsonb not null,
  fila_hash         text  not null,           -- dedupe de la fila dentro del cliente
  fila_numero       integer not null,
  -- normalización mínima del Módulo 1 (nada de clasificación contable acá)
  fecha             date not null,
  fecha_valor       date,
  descripcion       text not null,
  importe           numeric(18,2) not null,   -- SIGNADO: negativo = débito. Nunca float
  saldo             numeric(18,2),
  moneda            char(3) not null default 'ARS',
  referencia_externa text,
  created_at        timestamptz not null default now(),
  unique (cliente_id, fila_hash)              -- idempotencia POR CLIENTE
);

create index idx_lote_ingesta_cliente on lote_ingesta(cliente_id);
create index idx_mov_crudo_cliente on movimiento_bancario_crudo(cliente_id);
create index idx_mov_crudo_cliente_fecha on movimiento_bancario_crudo(cliente_id, fecha);
-- + los siete renglones de la plantilla (§5) en las dos tablas
```

**Por qué esto importa ahora y no después:** agregar `cliente_id not null` a una tabla que ya tiene filas
obliga a inventar un valor para las existentes, y a rehacer **todas** las políticas, índices y unicidades
(`unique (fila_hash)` global → `unique (cliente_id, fila_hash)`). Eso es una migración destructiva. Con
un solo cliente piloto el valor es fijo y el costo hoy es **cero**.

**Consecuencias concretas de nacer con la columna** — no es una columna decorativa:

1. Las **claves de unicidad son por cliente**. Dos clientes pueden tener el mismo hash de fila (misma
   descripción, mismo importe, misma fecha) sin colisionar. Un `unique` global sería un bug que aparece
   con el segundo cliente.
2. La **clave del objeto en storage** arranca con `cliente/<uuid>/` (ADR-0000 §3.3).
3. El **CLI exige el cliente** como argumento obligatorio: `pnpm ingesta --cliente <uuid> --archivo <x>`.
   Sin cliente no corre. No hay default, ni "el único que hay".
4. La **idempotencia** (`archivo_hash`, `fila_hash`) se evalúa dentro del cliente, nunca cruzando.

**Lo que el Módulo 1 NO decide** (queda para el Módulo 2, `motor-conciliacion-contable`): la cuenta
contable, la propuesta de asiento, el matching del tercero. La tabla se llama *crudo* por eso.

### 5.1.bis. Enmiendas a §5.1 que salieron de medir el material real

`0004_ingesta.sql` **no** implementa §5.1 al pie de la letra, y las diferencias no son de estilo. Cada una
tiene su motivo escrito en la cabecera de la migración; el resumen:

| # | §5.1 decía | La migración hace | Por qué |
|---|---|---|---|
| 1 | `fila_origen` dentro de `movimiento_bancario_crudo` | va a la satélite **`movimiento_origen_crudo`** (N2R) | La fila cruda trae 113 CUIT de terceros. Si vive en el movimiento, **toda** lectura de movimientos pasa al régimen auditado, y auditar 326 filas por pantalla **destruye** la capacidad de detectar el acceso masivo real (H-8) |
| 2 | `lote_ingesta.cuenta_bancaria_id` | no existe; hay **`lote_ingesta_cuenta`** | Un archivo trae N cuentas: los contadores y la verificación son por cuenta |
| 3 | FK simple al lote | **FK de tres columnas** `(cliente_id, lote_ingesta_id, cuenta_bancaria_id)` | Vuelve invariante referencial que la cuenta de un movimiento sea una de las detectadas en ese lote. Es la única defensa que sobrevive a `BYPASSRLS`, a `COPY` y a un bug de la app |
| 4 | `unique (cliente_id, fila_hash)` | **`unique (cliente_id, cuenta_bancaria_id, fila_hash)`** | Con dos cuentas en el mismo archivo, la versión de §5.1 rechaza filas legítimas |
| 5 | los números en la cuenta | **`cuenta_bancaria_identificador`**, serie con vigencia | Un CBU y un número cambian: un extracto de hace ocho meses tiene que resolver con el identificador vigente **entonces** |
| 6 | `accion` sin dominio cerrado | `rechazo` **+ check constraint** | Un rechazo no es una escritura; y sin el check un valor mal escrito entra y el evento **desaparece de toda consulta del rastro** |

Y una regla nueva que no estaba en la plantilla, porque se descubrió corriendo el test: **en una tabla con
lectura restringida, la escritura NO se declara con `for all`**. Las policies permisivas se combinan con
`OR` y `for all` incluye `SELECT`, así que una escritura que admita más roles que la lectura **la anula sin
mencionarla**. Ver `0005` y el test de catálogo que prohíbe el patrón.

### 5.2. Atributos fiscales del cliente

El **nodo** `tenant_node` guarda tenancy: identidad y lugar en el árbol. Los **atributos que cambian el
tratamiento** del cliente (condición ante IVA, forma societaria, jurisdicciones de IIBB activas, plan de
cuentas propio) son **dominio versionado por vigencia** y se diseñan en su propio ADR, con el criterio de
`agents/personas/plan-cuentas-multicliente.md`: series con `vigente_desde`/`vigente_hasta`, nunca un
campo pisado, y todo cálculo lee **el valor vigente al período**. No van como columnas de
`tenant_node`.

---

## 6. Cómo la aplicación abre una transacción

Es donde el patrón se rompe en producción, así que queda escrito:

```ts
// packages/data — ilustrativo del contrato, no la implementación
export async function conUsuario<T>(usuarioId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // (a) set_config con local=true → vive SOLO en esta transacción
    await tx.execute(sql`select set_config('app.user_id', ${usuarioId}, true)`);
    return fn(tx);
  });
}
```

- **`set_config(..., true)` dentro de una transacción explícita**, nunca `SET` de sesión. Con pooling en
  *transaction mode* (pgBouncer, Supavisor, Cloud SQL con pooler), un `SET` de sesión **se pega a la
  conexión** y el próximo request —de otro estudio— la hereda. Eso es una **fuga de tenant**, y es
  silenciosa.
- **Sin `usuarioId` no hay acceso.** Si `app.user_id` no está seteado, `app.current_user_id()` devuelve
  `null`, `accessible_tenant_ids()` devuelve vacío y **toda consulta devuelve cero filas**. Falla
  cerrado: la ausencia de identidad no da acceso total, da acceso nulo.
- **El job es el caso peligroso.** Patrón obligatorio (portado de `admin-barrios`): `app_job` se usa
  **solo** para tomar el trabajo de la cola; el trabajo real corre con `conUsuario()` bajo la identidad
  de quien lo pidió. Un job que hace todo con `BYPASSRLS` es un sistema sin aislamiento con pasos extra.

---

## 7. Endurecer el aislamiento sin rediseñar

El modelo lógico no cambia en ningún nivel; extraer un cliente es un **copiado filtrado por
`cliente_id`**:

| Nivel | Qué es | Qué cambia |
|---|---|---|
| **0 — Pooled (default)** | Base y esquema compartidos, RLS por fila | — |
| **1 — Rol dedicado** | Rol de BD y conexión propios para un estudio grande | Credencial por tenant; RLS igual |
| **2 — Schema por tenant** | Mismas tablas en un schema propio | `search_path`; lo elige `packages/data` |
| **3 — Base por tenant** | `DATABASE_URL` propio (aislamiento físico) | Enrutamiento tenant→conexión detrás de `packages/data` |

Que esto sea posible **depende de que toda fila nazca con `cliente_id`**. Es el argumento de §5.1.

---

## 8. Riesgos y casos borde (heredados y verificados)

1. **`1.7` vs `1.70`.** El `LIKE` sin el punto (`n.path || '%'`) hace que un cliente vea otro. Siempre
   `path = X or path like X || '.%'`. **Test obligatorio** (ADR-0002 §C).
2. **Re-parentado.** Mover un cliente de grupo reescribe `path` del nodo y sus descendientes;
   **`cliente_id` no cambia** → la RLS sigue correcta sin tocar el dominio. Correr con `app_job`, en
   transacción. **[validar]** si el producto siquiera permite mover un cliente entre estudios (probable
   que no: cambiar de estudio es más un alta nueva que una mudanza).
3. **`SET` de sesión + pooling.** Ver §6. Es el bug más caro del patrón.
4. **Recursión de políticas.** Resuelta con `SECURITY DEFINER` + `search_path` fijo (§4.2).
5. **Tabla nueva sin RLS.** Una migración que crea una tabla de dominio y se olvida los renglones (4)(5)
   de §5 la deja **legible para todos los tenants**. Se verifica con un test que recorre el catálogo
   (ADR-0002).
6. **Usuario con membresías en nodos no relacionados.** `accessible_tenant_ids()` devuelve la **unión**
   de subárboles disjuntos; las escrituras se controlan con `has_role_on(cliente_id, …)` por fila. Es el
   caso del contador externo que atiende clientes de dos estudios.
7. **Borrado.** `on delete restrict` en `parent_id` y en `cliente_id`; soft-delete (`deleted_at`) para
   tenants. **Nunca** cascada de tenancy a datos financieros.
8. **El nodo raíz y la primera membresía.** Alguien tiene que crear el estudio y su primer socio **antes**
   de que exista una sesión que pueda verlo. Eso corre con el dueño del esquema o con `app_job`, en un
   script de alta explícito y auditado — **no** por un endpoint abierto. **[validar]** el flujo de alta
   de estudio.

---

## 9. Índices

```sql
create unique index uq_tenant_node_path        on tenant_node(path);
create index        idx_tenant_node_path_prefix on tenant_node(path text_pattern_ops); -- subárbol
create index        idx_tenant_node_parent      on tenant_node(parent_id);
create index        idx_membership_user_activo  on membership(user_id) where activo;
create index        idx_membership_node         on membership(tenant_node_id);
-- Dominio: la FK cliente_id SIEMPRE indexada, en cada tabla (renglón (2) de §5)
```

`text_pattern_ops` es necesario para que `LIKE 'prefijo%'` use índice cuando la collation **no** es `C`
—el caso de Cloud SQL, RDS y Supabase—. Sin eso, cada resolución de subárbol es un scan.

---

## 10. Nota de implementación (Drizzle)

Las **tablas** se declaran en TS de Drizzle (tipos inferidos, sin generador externo). Los **enums, RLS,
políticas, triggers, funciones `app.*` y roles** van escritos a mano en las migraciones SQL planas:
Drizzle no los modela. Es la razón por la que ADR-0000 §5 exige SQL plano y no un DSL de migración.

Migraciones previstas:

| Archivo | Contenido | Estado |
|---|---|---|
| `0001_tenancy.sql` | schema `app`, enums, `tenant_node`, `membership`, triggers de path (insert **y** update), las tres funciones + `app.verificar_coherencia_path()` + `app.reparentar_nodo()`, `app.exigir_nodo_cliente`, roles, RLS, `acceso_auditoria`, índices | ✅ **aplicada y verificada** |
| `0002_endurecimiento.sql` | `grant insert` de auditoría a `app_job`; rol `app_firmador`; `credencial_fiscal` (N3, con grant a nivel columna y policy de rol en **lectura**); `credencial_fiscal_rotacion` con la primera **FK compuesta tenant-consistente** | ✅ **aplicada y verificada** |
| `0003_auditoria_correlacion.sql` | id de correlación generado por la aplicación, porque `insert ... returning` aplica la policy de `SELECT` y no sirve en una tabla append-only | ✅ **aplicada y verificada** |
| `0004_ingesta.sql` | **Siete tablas**: `banco` (N0 sin tenant), `cuenta_bancaria`, `cuenta_bancaria_identificador` (N2R), `lote_ingesta` (N1 estricto), `lote_ingesta_cuenta`, `movimiento_bancario_crudo`, `movimiento_origen_crudo` (N2R). Los siete renglones **+ los cuatro extra** en las dos N2R. Más el check constraint de `acceso_auditoria.accion`. **Seis enmiendas a §5.1**, ver §5.1.bis | ✅ **aplicada y verificada** |
| `0005_policies_sin_for_all.sql` | Parte el `for all` de `credencial_fiscal` en insert/update. Las policies permisivas se combinan con **OR** y `for all` incluye SELECT: una escritura con más roles que la lectura la **anula**. Encontrado corriendo el test, no leyendo la migración | ✅ **aplicada y verificada** |
| `0006_dominio_contable.sql` | plan de cuentas, asientos, atributos del cliente con vigencia | Módulo 2+ |

> El aplicador es `packages/data/scripts/migrar.ts` (`pnpm db:migrate`): registra lo aplicado con el
> **hash del archivo**, así que editar una migración ya aplicada no es una recomendación sino un error
> que aborta. Desvío consciente de ADR-0000 §5 explicado en el encabezado de ese script.

---

## 11. Abierto / a validar

- Enum `rol_membership` definitivo, y si `admin_plataforma` es membresía o **rol de BD** (una membresía
  de staff que vea todo es un objetivo de ataque con nombre propio).
- Si se habilita `grupo` en el MVP (§2.2).
- Tabla local `app_user` (espejo del usuario de Auth) vs. `user_id` suelto contra el `AuthProvider`.
- Políticas fila-a-fila **dentro** de un cliente (que un `cliente_lectura` no vea todo lo del cliente,
  p. ej. sueldos) por encima del aislamiento de tenant.
- Flujo de alta de estudio y primera membresía (§8.8).
- Si el producto permite mover un cliente entre estudios (§8.2).
- Representación definitiva del importe (ADR-0000 §9.7).
