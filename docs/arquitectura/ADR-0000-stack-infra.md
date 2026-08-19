# ADR-0000 — Stack e infraestructura (agnóstico de proveedor)

**Estado:** Aceptado
**Fecha:** 2026-08-09
**Ámbito:** todo el producto. Es el ADR de cabecera: ningún otro documento puede contradecirlo.
**Contexto de origen:** criterio heredado de dos proyectos hermanos, leídos y verificados —
`C:\Proyectos_Desa\admin-barrios\docs\arquitectura\00-stack-infra.md` (stack y abstracciones) y
`C:\Proyectos_Desa\trazabilidad-obra-gas` (motor de conciliación). **Rutas de otro repo, no de este.**
Este ADR **no copia** ese documento: reusa las decisiones que ya se probaron y corrige lo que en este
dominio cambia (ver la nota de §3.1 sobre `auth.uid()`).

---

## 1. Contexto

El producto es un SaaS para **estudios contables argentinos**: un estudio administra la contabilidad y
los impuestos de **muchos clientes**. Arranca por el **Módulo 1: ingesta bancaria**, y después crece
hacia conciliación asistida, liquidaciones impositivas y estados contables.

Tres restricciones definen este ADR:

1. **El proveedor de despliegue NO está decidido.** Puede terminar en Google Cloud, AWS,
   Vercel + Supabase o self-hosted. Cualquier decisión que ate el código a un proveedor hoy se paga
   cara después.
2. **Multi-tenancy desde el diseño, no después.** El aislamiento entre clientes de un estudio no es una
   feature: es una precondición. Se resuelve en ADR-0001 y este ADR le tiene que dar el sustrato
   (Postgres con RLS, sin features propietarias).
3. **El Módulo 1 no necesita una app web.** Necesita leer extractos, normalizarlos y guardarlos. Montar
   Next.js para eso es peso sin uso, pero la estructura tiene que estar lista para cuando haga falta.

Tensión a resolver: reusar lo que ya funciona en los proyectos hermanos **sin** heredar su acople
(`trazabilidad-obra-gas` quedó pegado a Supabase y a Vercel).

---

## 2. Decisión — Stack base

- **TypeScript de punta a punta**, estricto (`strict: true`). Mismo criterio que los proyectos hermanos.
- **Zod** para validación de límites: todo dato que entra al sistema (fila de un extracto, payload de
  un endpoint, respuesta de un servicio externo) se parsea contra un esquema antes de tocar el dominio.
- **PostgreSQL** como base, sin importar quién lo hostee. **Sin extensiones no-core y sin features
  propietarias** — es lo que mantiene el aislamiento portable (ADR-0001 §A.6).
- **Next.js (App Router) + React** para la web, **cuando haya web**. Ver §2.2: no es el Módulo 1.
- **Node.js 22 LTS o superior.** `[verificar en la máquina]` los paquetes se publican como **TS
  fuente** (sin paso de build), con extensión `.ts` explícita en los imports, apoyándose en el
  type-stripping nativo de Node — el mismo patrón que ya corre en `admin-barrios`. Al inicializar el
  repo hay que **fijar la versión en `.nvmrc` y en `engines`** y confirmar que esa versión resuelve los
  imports `.ts` sin flags; si no, se agrega el flag o un runner y se anota acá.

### 2.1. Monorepo desde el primer commit

El monorepo nace ahora aunque haya carpetas vacías: reestructurar después es una migración que no vale
la pena pagar.

```
sistema-contable/
├── apps/
│   ├── cli/                ← Módulo 1: punto de entrada de la ingesta bancaria. ARRANCA ACÁ.
│   ├── worker/             ← job runner de larga duración (cuando haya cola de trabajo)
│   └── web/                ← Next.js App Router (cuando haya UI para el contador)
└── packages/
    ├── shared/             ← dominio PURO + esquemas Zod + tipos. Sin I/O, sin SDK, sin DB.
    ├── data/               ← capa de datos neutral: Drizzle + Postgres + migraciones SQL + RLS
    ├── auth/               ← AuthProvider (interfaz + adapters)
    ├── almacenamiento/     ← ObjectStorage (interfaz S3-compatible)
    └── ingesta/            ← Módulo 1: adapters por banco (parseo puro, sin I/O de base)
```

- **Gestor:** `pnpm` workspaces (`pnpm-workspace.yaml` en la raíz, `hoist=false` para que cada paquete
  importe solo lo que declara). **Sin Turborepo**: con cinco paquetes, `pnpm -r` alcanza.
- **Regla de dependencias (verificable en un test de arquitectura):** `packages/shared` y
  `packages/ingesta` **no importan** `packages/data`, ni `@aws-sdk/*`, ni ningún SDK de proveedor. El
  dominio no conoce infraestructura. Lo que rompe esa regla no entra.

### 2.2. Decisión: el Módulo 1 arranca **sin app web**

**`apps/cli` + `packages/ingesta`, no Next.js.** Motivos:

- Lo que el Módulo 1 tiene que hacer —tomar un extracto (archivo o casilla), parsearlo, normalizarlo,
  persistirlo con su `cliente_id` y dejar trazabilidad— es un **proceso**, no una pantalla.
- Un CLI es **el mejor banco de pruebas de la tenancy**: obliga a resolver explícitamente "con qué
  identidad y con qué credencial de base corre esto", que es justo donde los sistemas multi-tenant se
  rompen (ADR-0002). Una UI lo esconde detrás de una sesión.
- El CLI **no se tira** cuando llegue la web: queda como el disparador de la ingesta por lote y como el
  camino de reproceso. La web, cuando exista, invoca la misma función de `packages/ingesta`.
- `apps/web` queda **creada como carpeta prevista**, vacía. Cuando arranque, no hay que mover nada.

> **Consecuencia operativa:** hasta que exista `apps/web`, no hay `AuthProvider` implementado (§3.2).
> El CLI corre con una **identidad de operador explícita** pasada por configuración, y eso es
> suficiente para ejercitar la RLS. Lo que **no** se hace es dejar el CLI corriendo sin identidad
> "porque todavía no hay auth" — ver ADR-0002.

### 2.3. Dinero y fechas

- **Ningún importe se representa como `number` de JavaScript.** En base: `numeric` (escala explícita);
  en TypeScript: `string`, y la aritmética por una utilidad de dominio en `packages/shared`. Un
  importe en punto flotante es un error de redondeo esperando una liquidación.
- **Zona horaria explícita** (`America/Argentina/Cordoba` por configuración, no por default del host):
  un período fiscal mal atribuido por zona horaria es un error contable.
- La representación exacta del importe (escala de `numeric`, o entero de centavos) se fija en el ADR
  del modelo de dominio; para el Módulo 1 alcanza `numeric(18,2)` + `string` (ver ADR-0001 §5).

---

## 3. Decisión — Agnóstico de proveedor: tres abstracciones

**Regla dura (§1 de `CLAUDE.md`):** ningún servicio de negocio llama **directamente** a un SDK
propietario. El SDK del proveedor queda **detrás de un adapter**, reemplazable sin tocar el negocio.
Los puntos de contacto con un proveedor externo son datos, auth, almacenamiento y —desde `0022`—
datos de referencia (§3.5): ya no son tres, son cuatro.

### 3.1. Datos — Drizzle sobre Postgres, con RLS portable

**Decisión: Drizzle (no Prisma).**

| Motivo | Detalle |
|---|---|
| Sin motor binario aparte | Prisma lleva su *query engine*; Drizzle no → imagen Docker más liviana, sin binarios por plataforma. |
| SQL-transparente | Permite `set_config('app.user_id', $1, true)` **dentro de la misma transacción** antes de la query — exactamente lo que necesita el patrón RLS de ADR-0001. |
| Migraciones en SQL plano | `drizzle-kit` genera `.sql` versionados en el repo, aplicables contra **cualquier** `DATABASE_URL`. Sin motor de migración propietario. |

**RLS sin atarse a `auth.uid()` de Supabase.** Las políticas se escriben contra una función propia:

```sql
create schema if not exists app;
create or replace function app.current_user_id() returns uuid as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$ language sql stable;
```

En cualquier Postgres (Cloud SQL, RDS, Supabase, contenedor propio), la app hace
`set_config('app.user_id', $1, true)` al abrir cada transacción, después de validar la sesión vía
`AuthProvider`. Si el despliegue termina siendo Supabase y se quiere aprovechar su Auth, el **adapter**
alimenta ese mismo `app.user_id` — la función **no** delega a `auth.uid()`, y por lo tanto el esquema no
depende de que exista el schema `auth`.

> **Diferencia deliberada con `admin-barrios`:** ahí `app.current_user_id()` hace
> `coalesce(current_setting(...), auth.uid())`. Acá se deja **solo** `current_setting`, porque el
> `coalesce` obliga a instalar un stub de `auth.uid()` en todo Postgres que no sea Supabase (si la
> función no existe, la política falla) — un requisito de despliegue que este ADR quiere evitar. El
> costo es nulo: el adapter de Supabase, si algún día se usa, setea `app.user_id` como cualquier otro.

**Tres credenciales de base, una por tipo de proceso** (esto es seguridad, y se detalla en ADR-0002):

| Rol de Postgres | Quién la recibe | Puede |
|---|---|---|
| dueño del esquema | **solo** los scripts de migración | DDL. Ningún proceso que atienda pedidos la ve. |
| `app_request` | la web y el CLI/worker **para hacer el trabajo** | leer/escribir **sujeto a RLS** |
| `app_job` (`BYPASSRLS`) | **solo** el worker, y solo para tomar trabajo de la cola | saltear políticas. Nunca llega al cliente. |

### 3.2. Auth — detrás de una interfaz

```ts
// Contrato ilustrativo (packages/auth). La implementación concreta se elige con el hosting.
export interface AuthProvider {
  iniciarSesion(credenciales: Credenciales): Promise<Sesion>;
  cerrarSesion(sesion: Sesion): Promise<void>;
  obtenerSesion(pedido: Request): Promise<Sesion | null>;
}
```

Del `AuthProvider` sale un `usuarioId` (uuid), y **ese** es el valor que alimenta `app.user_id`. El
negocio nunca importa `@supabase/supabase-js` ni el SDK de Cognito ni el de Identity Platform.

**Adapter inicial: abierto**, depende del hosting (Supabase Auth / Cognito / Google Identity Platform /
GoTrue self-hosted). Para el Módulo 1 alcanza un adapter de desarrollo que resuelve una identidad fija
declarada por configuración, **habilitado solo con `APP_ENTORNO=local`** (ver ADR-0002).

### 3.3. Almacenamiento — interfaz S3-compatible

**Decisión: `@aws-sdk/client-s3` como único cliente**, apuntado por configuración. Envuelto en una
interfaz propia, porque el dominio no habla S3:

```ts
export interface ObjectStorage {
  guardar(clave: string, cuerpo: Buffer, contentType: string): Promise<void>;
  obtener(clave: string): Promise<Buffer>;
  urlFirmada(clave: string, expiraEnSegundos: number): Promise<string>;
  eliminar(clave: string): Promise<void>;
}
```

| Destino | Cómo |
|---|---|
| Local | **MinIO** en Docker (§4) |
| AWS | S3 real — mismo cliente, solo cambia endpoint/credenciales |
| Google Cloud | Cloud Storage por su **API XML interoperable con S3** + claves HMAC. `[verificar]` al elegir GCP: confirmar que el subconjunto que usamos (put/get/**URL firmada**/multipart) funciona con el cliente S3; si algo no, se escribe un adapter nativo de GCS **detrás de la misma interfaz** — el dominio no se toca. |
| Supabase | Supabase Storage expone endpoint S3-compatible — mismo cliente |

La **clave del objeto lleva el `cliente_id` como primer segmento** (`cliente/<uuid>/extracto/<...>`):
así el aislamiento es visible en el storage, y una política de bucket por prefijo es posible más
adelante sin migrar objetos.

---

### 3.4. Estado del monorepo al cerrar las condiciones del Módulo 1

Lo que existe hoy, con lo que hace cada pieza:

| Paquete | Qué es |
|---|---|
| `packages/shared` | Niveles y clasificación de datos, redactor de logs, `forma()`, logger acotado, HMAC de identificadores |
| `packages/data` | `conUsuario`/`conJob`, choke point de auditoría, registro de lectores auditados, migraciones, generador sintético |
| `packages/ingesta` | Parseo AR, esquemas Zod, hash de fila, verificación aritmética y mutaciones, resolvedor de cuenta (INV-6), depuración de glosa (INV-13), generadores de fixture |
| `packages/almacenamiento` | `ObjectStorage` S3-compatible con **dos credenciales**, clave canónica, emisor único de URL firmada, y el orden resolver→guardar |
| `apps/cli` | El comando de ingesta. Corre el guard de R18 **antes de abrir el archivo** |

**`apps/web` sigue sin existir**, como decidió §2.2: el Módulo 1 arranca sin app web. `apps/worker`
tampoco — la ingesta corre por CLI con `conUsuario()`, no como job.

**Sobre las dos credenciales de almacenamiento** (§3.3 las menciona; acá el motivo): el compose crea dos
cuentas de servicio en MinIO y el código las usa como tales. El proceso que emite URL de descarga **no
necesita poder escribir**, y el que ingesta no necesita leer objetos de otros lotes. Con una sola
credencial, un RCE en cualquiera de los dos caminos tiene los dos permisos. En AWS son dos políticas de
IAM; en GCP, dos claves HMAC. El código no cambia.

---

### 3.5. Datos de referencia — cuarto punto de contacto con un proveedor externo

**Decisión: `packages/cotizaciones`, mismo patrón de interfaz + adapter reemplazable que ya rige
datos/auth/almacenamiento.** Origen: el motor necesita valuar movimientos en USD contra la
cotización oficial del Banco Nación (comprador/vendedor por fecha) — `docs/diseno/12-cotizacion-bna-plan.md`.
No hay API oficial de BNA con histórico accesible; se usa `api.argentinadatos.com`, ya validada en
producción por el proyecto hermano `control-gestion`.

```ts
// Contrato (packages/cotizaciones/src/proveedor.ts).
export type ProveedorCotizaciones = {
  readonly consultar: (moneda: string, fecha: Date) => Promise<Cotizacion | null>;
};
```

El dominio nunca importa el cliente HTTP de un proveedor de cotizaciones a mano: pasa por
`ProveedorCotizaciones`, con `argentinadatos.ts` como único adapter concreto hoy (fetch inyectable
para testear sin red, respuesta validada con Zod antes de tocar cualquier otra capa, timeout
explícito porque `fetch` de Node no lo trae por default, URL por variable de entorno con el valor
actual como default de desarrollo — nunca hardcodeada). Si el proveedor cambia, se escribe un
adapter nuevo **detrás de la misma interfaz**; el negocio no se toca.

**`null` es "el proveedor no publicó cotización para esa fecha", nunca "hubo un fallo".** Un
timeout, un error de red o una respuesta con forma inesperada se LANZAN: confundirlos con ausencia
de dato haría que el motor tratara un fallo de infraestructura como si el mercado no hubiera
cotizado ese día.

**`cotizacion_bna` es un catálogo N0 sin `cliente_id`**, mismo patrón que `banco` (§3.1, 0004): la
cotización oficial es idéntica para todos los clientes, sin dato de nadie. `packages/cotizaciones`
en sí no importa `packages/data` ni ningún otro paquete del monorepo — el comando que escribe la
caché (fetch fuera de la transacción → `conJob('cargar_cotizaciones')` corto) es una capa aparte,
en `apps/cli`, y un paso posterior a este primer commit.

---

## 4. Arranque local con Docker

`docker-compose.yml` en la raíz levanta **Postgres + MinIO**, y nada más. Sin proveedor, sin nube, sin
cuenta en ningún servicio.

### 4.1. Cómo levantarlo (verificado de punta a punta)

```bash
# 1. Configuración local (el .env no se commitea; los valores son de desarrollo)
cp .env.example .env

# 2. Infraestructura: Postgres + MinIO + bucket y cuentas de servicio
docker compose up -d postgres minio minio-init
docker compose ps          # postgres y minio "healthy"; minio-init "Exited (0)" = terminó bien

# 3. Esquema de tenancy (con el DUEÑO DEL ESQUEMA)
#    Todavía no hay toolchain (no hay package.json), así que se aplica con el psql del contenedor.
#    Cuando exista, esto es: pnpm drizzle-kit migrate
docker compose exec -T postgres psql -U sistema_contable -d sistema_contable -v ON_ERROR_STOP=1 \
  < packages/data/migrations/0001_tenancy.sql

# 4. Usuarios de login locales (las contraseñas salen de tu .env, no del repo)
docker compose exec -T postgres psql -U sistema_contable -d sistema_contable -v ON_ERROR_STOP=1 \
  -v app_user=app_request_dev -v app_pass=app_request_dev -v job_pass=app_job_dev \
  < packages/data/sql/db-setup.sql
#    La última consulta imprime los roles: app_request y app_request_dev DEBEN tener saltea_rls = f.
#    Solo app_job puede tener saltea_rls = t. Si no es así, el aislamiento no existe.

# 5. Verificar el aislamiento (18 aserciones, tres pasadas, una por rol)
docker compose exec -T postgres psql -U sistema_contable -d sistema_contable -v ON_ERROR_STOP=1 -v ddl=1 \
  < packages/data/sql/tests/0001_aislamiento.test.sql
docker compose exec -T -e PGPASSWORD="$JOB_DB_PASSWORD" postgres \
  psql -h 127.0.0.1 -U app_job -d sistema_contable -v ON_ERROR_STOP=1 \
  < packages/data/sql/tests/0001_aislamiento.test.sql
docker compose exec -T -e PGPASSWORD="$APP_DB_PASSWORD" postgres \
  psql -h 127.0.0.1 -U app_request_dev -d sistema_contable -v ON_ERROR_STOP=1 \
  < packages/data/sql/tests/0001_aislamiento.test.sql
#    Tiene que terminar en: === PASADA 2 COMPLETA: T1..T14 PASARON ===
```

Postgres queda en `localhost:5432`, MinIO API en `localhost:9000` (consola en `localhost:9001`).

> ⚠️ **Si esos puertos están ocupados por otro proyecto de la máquina**, `docker compose up` falla con
> *"port is already allocated"* (pasó al probarlo: el 9001 estaba tomado). Se cambian los tres puertos en
> **tu `.env`** — ni el compose ni el código se tocan.

El CLI del Módulo 1 correrá en el **host** contra estos contenedores. Cuando exista `apps/web`, entra al
compose como un servicio con `profiles: ["web"]`.

- Postgres: `localhost:5432` · MinIO API: `localhost:9000` · consola MinIO: `localhost:9001`.
- **Los puertos se publican en `127.0.0.1`, no en todas las interfaces.** Una base de desarrollo con
  contraseña de desarrollo, alcanzable desde la red del café, es una base pública.
- `minio-init` es un contenedor de un solo uso: crea el bucket y **dos cuentas de servicio** (una de
  solo lectura, una de escritura). Ninguna aplicación usa la cuenta root del storage — es el espejo
  local de lo que en la nube son dos políticas de IAM.
- **No hay servicio de auth** en el compose: no hace falta hasta que exista el modelo de usuarios.
- **No hay servicio de app** todavía: el CLI del Módulo 1 corre en el host (`pnpm ingesta ...`) contra
  esos dos contenedores. Cuando exista `apps/web`, entra con `--profile app`.

**Cada servicio recibe solo las variables que le corresponden** — sin `env_file` genérico, con la lista
enumerada. Esa enumeración *es* el control: es lo que impide que el proceso que atiende pedidos reciba
la credencial que saltea la RLS (ADR-0002).

---

## 5. Migraciones — herramienta neutral

**`drizzle-kit`**: archivos `.sql` versionados en `packages/data/migrations/NNNN_*.sql`, aplicables con
`drizzle-kit migrate` contra cualquier `DATABASE_URL`.

- **Nunca se edita una migración ya aplicada**; se crea la siguiente con prefijo incremental.
- **Las migraciones corren con el dueño del esquema**, nunca con `app_request`.
- Lo que Drizzle no modela (RLS, políticas, triggers, funciones `app.*`, roles) va **escrito a mano en
  el `.sql`** de la migración. Es la razón por la que las migraciones son SQL plano y no un DSL.
- Migración inicial: **`0001_tenancy.sql`** (ver ADR-0001) — el esquema `app`, `tenant_node`,
  `membership`, funciones, roles y la plantilla de políticas. Todo lo que venga después **anida** en
  esto.

---

## 6. Portabilidad de despliegue — el mismo código en los cuatro

Cambia **configuración**, nunca código de negocio:

| | Google Cloud | AWS | Vercel + Supabase | Self-hosted (VPS/Docker) |
|---|---|---|---|---|
| **App / CLI** | Cloud Run (contenedor) | ECS / App Runner | Vercel (web) + el CLI donde corra | Contenedor propio |
| **Datos** | Cloud SQL Postgres | RDS Postgres | Postgres de Supabase | Contenedor Postgres |
| **Conexión** | `DATABASE_URL` (Cloud SQL Connector o IP privada) | `DATABASE_URL` | `DATABASE_URL` (pooler en **transaction mode**) | `DATABASE_URL` |
| **RLS** | `app.current_user_id()` ← `set_config` | ídem | ídem (el adapter setea `app.user_id`) | ídem |
| **Auth** | Identity Platform / GoTrue | Cognito / GoTrue | Supabase Auth | GoTrue en contenedor |
| **Storage** | Cloud Storage (API XML S3) `[verificar §3.3]` | S3 | Supabase Storage (S3-compat) | MinIO |
| **Jobs / crons** | Cloud Scheduler → mismo handler | EventBridge → mismo handler | Vercel Cron → mismo handler | cron del SO / systemd timer |
| **Migraciones** | `drizzle-kit migrate` | ídem | ídem | ídem |

**Ningún renglón obliga a tocar `packages/shared`, `packages/ingesta` ni el dominio.** Solo cambian
variables de entorno y qué adapter concreto se instancia en el arranque.

**Lo que hace que esto sea verdad, y no una intención:**

1. RLS con `current_setting`, sin `auth.uid()` → el aislamiento no depende del proveedor de auth.
2. Materialized path en `text`, **cero extensiones** → no hace falta `CREATE EXTENSION` en el host.
3. Migraciones en SQL plano → no hace falta el CLI de ningún proveedor.
4. Job runner **detrás de una interfaz**, no `vercel.json` → el disparador es intercambiable.
5. Los tres SDK de proveedor detrás de adapters → se cambia el adapter, no el negocio.

**Lo que sí se verifica al elegir proveedor** (no es portabilidad gratuita): pooling en *transaction
mode* compatible con `set_config(...,true)`; que el host permita **crear roles** (`app_request`,
`app_job` con `BYPASSRLS`) — en algunos Postgres gestionados los privilegios de superusuario están
recortados; y las URL firmadas del storage. Los tres están en §9.

---

## 7. Qué se reutiliza de los proyectos hermanos

| Pieza | Origen | Acción |
|---|---|---|
| Diseño de tenancy jerárquica + RLS | `admin-barrios/docs/diseno/03-modelo-datos.md` §A | **Portado** en ADR-0001 con el mapeo estudio→cliente |
| Separación de tres credenciales de base | `admin-barrios` (compose + `.env.example`) | **Portada** — es el control de ADR-0002 |
| Motor de conciliación (matcher puro, reglas, reversas, FIFO, helpers de CUIT y normalización) | `trazabilidad-obra-gas/src/services/conciliacion/*`, `src/domain/cuit.ts`, `src/lib/normalizar-texto.ts` | **Reuso en el Módulo 2**, no ahora. Ver `agents/personas/motor-conciliacion-contable.md` |
| Patrón de parseo AR (`1.234,56`, `dd/mm/aaaa`) y adapters de extracto | `trazabilidad-obra-gas/src/services/ingestion/*` | **Reuso del patrón** en `packages/ingesta` (Módulo 1); **no** el mapeo de columnas de un banco concreto |
| `exceljs` (XLSX), `unpdf` (texto de PDF), `imapflow`/`mailparser` (casilla), `date-fns` | `trazabilidad-obra-gas` | Paquetes npm de propósito general, sin acople → **se reusan** |
| RLS con `auth.uid()` directo; `SUPABASE_SERVICE_ROLE_KEY`; `vercel.json` crons; hacks de bundle serverless | `trazabilidad-obra-gas` | **NO se portan.** Reemplazos en §3.1, §3.3 y §6 |

---

## 8. Consecuencias

- **Se paga plomería al principio:** interfaces + adapters + tres credenciales + compose, antes de la
  primera línea de negocio. Se paga una vez; migrar un negocio acoplado cuesta órdenes de magnitud más.
- **El monorepo suma configuración desde el día 1** con carpetas vacías (`apps/web`, `apps/worker`).
  Es a propósito: evita una reestructuración después.
- **`app.current_user_id()` es una pieza nueva** que hay que probar en los dos modos (con y sin
  proveedor de auth) cuando se implemente el `AuthProvider` real.
- **El CLI sin auth real** es un riesgo si no se acota: se acota en ADR-0002 (identidad explícita,
  adapter de desarrollo solo con `APP_ENTORNO=local`).
- **La portabilidad tiene un costo de verificación**, no cero: los tres puntos de §6 hay que
  confirmarlos contra el proveedor elegido antes de dar por buena la migración.

---

## 9. Abierto — a confirmar (no inventado)

1. **Proveedor de despliegue final**: no decidido. Este ADR es válido para los cuatro.
2. **Adapter de Auth inicial**: depende del hosting. Hoy no hay ninguno implementado.
3. **Versión exacta de Node y resolución de imports `.ts`** `[verificar en la máquina]` — §2.
4. **Cloud Storage con el cliente S3**: confirmar el subconjunto usado, en especial **URL firmadas**,
   si se elige GCP (§3.3).
5. **Creación de roles en el Postgres gestionado elegido**: confirmar que se puede crear un rol con
   `BYPASSRLS` (o definir la alternativa: función `SECURITY DEFINER` acotada en lugar del rol).
6. **Pooling en transaction mode** compatible con `set_config(...,true)` en el proveedor elegido.
7. **Representación definitiva del importe** (escala de `numeric` vs. entero de centavos): se fija en
   el ADR del modelo de dominio; el Módulo 1 usa `numeric(18,2)` (ADR-0001 §5).
8. **Motor de generación de PDF**: no aplica todavía (no hay documentos emitidos en el Módulo 1).

---

_Ver `ADR-0001-tenancy.md` (multi-tenancy jerárquica y RLS), `ADR-0002-seguridad.md` (niveles de
seguridad y reglas verificables), `docs/devops/01-entornos.md` (entornos, cuando se decida el hosting) y
`docs/devops/02-sdlc-git-flow.md` (flujo de trabajo)._
