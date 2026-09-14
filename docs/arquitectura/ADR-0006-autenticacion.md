# ADR-0006 — Autenticación: `AuthProvider` real, capacidades finas, choke point de auditoría

**Estado:** Aceptado
**Fecha:** 2026-09-14
**Depende de:** `ADR-0000-stack-infra.md` §3.2 (contrato `AuthProvider`, tres credenciales de base),
`ADR-0001-tenancy.md` §4 (membresías, roles, `has_role_on`/`accessible_tenant_ids`),
`ADR-0002-seguridad.md` (niveles de datos, R1-R42, choke point de auditoría R32, incidente #8).
**Contenido de dominio:** convocatoria real y en paralelo (`Agent()`) a `arquitecto-software`,
`security-engineer` y `seguridad-datos-financieros` sobre `docs/diseno/33-plan-deuda-pre-tanda-4.md`
§A.1/A.4/A.6, con síntesis de dos relevamientos de los sistemas hermanos (`admin-barrios`,
`trazabilidad-obra-gas`) como insumo. Decisiones de alcance y prioridad, del titular.
**Cierra:** A.1 (`AuthProvider` real), A.4 (choke point `leerConAuditoria` en todo camino de lectura
N2-R/N3 de la vista), A.6 (grants de `cierre_cliente_periodo`/`asiento_propuesto` — ver §0, ya estaba
cerrado).
**Numeración:** primer ADR con número real libre. `ADR-0003/0004/0005` están reservados en
`docs/diseno/31-replanteo-hacia-producto.md:394-398` para otro tema (memoria de decisiones de la Tanda 2,
guard PDF/Excel, tercer constructor de `propuesta`) y no se escribieron todavía — no se colisiona con
ellos.

> **Nota normativa, por el guardrail del agente:** `knowledge/` no tiene cargada la fuente sobre secreto
> fiscal, protección de datos personales ni transferencia internacional de datos (`ADR-0002` §G). Este
> ADR no afirma ninguna obligación legal sobre alojar identidades de staff en Supabase (región
> us-east-2, EE.UU.). Se registra la decisión técnica con el hueco normativo declarado, con el mismo
> criterio que ya rige en `docs/seguridad/registro-terceros.md`. **Validar con profesional matriculado.**

---

## Contexto

La Tanda 4 (`docs/diseno/31-replanteo-hacia-producto.md:575-649`) es la primera vez que el sistema
muestra datos de clientes reales en una interfaz visible, no CLI+Excel. Hoy no hay autenticación de
personas: la identidad entra por un GUC que setea `conUsuario()`
(`packages/data/src/db/conexion.ts:212-262`), y la atribución de una escritura es elegible dentro del
propio subárbol — incidente #8 (`docs/seguridad/registro-incidentes.md`). `docs/diseno/33-plan-deuda-
pre-tanda-4.md` declaró A.1 (`AuthProvider` real) bloqueante duro para esa tanda, y agrupó en la misma
convocatoria A.4 (el choke point de auditoría no está cableado en ningún camino de lectura N2-R/N3 que
la web vaya a usar) y A.6 (un hallazgo de grants sobre dos tablas de Capa D).

Infraestructura de destino: Supabase (proyecto "sistema-contable", región us-east-2/Ohio, organización
PBM Desarrollos Tecnologicos) + Vercel, mismo team. No se migran datos reales de Bracci/ROKA en esta
etapa — la recarga de esos clientes es un paso posterior, con su propia autorización, y este ADR no la
incluye.

---

## §0. A.6 ya estaba cerrado — corrección de dos documentos

Verificado contra el código antes de escribir este ADR: `packages/data/migrations/
0028_inmutabilidad_post_terminal_cierre.sql:94-98` acota el `grant update` por columna sobre
`cierre_cliente_periodo` y `asiento_propuesto`, y los tres triggers de esa migración
(`trg_cierre_periodo_inmutable`, `trg_asiento_propuesto_inmutable`, `trg_pendiente_cierre_inmutable`,
`0028:175-202`) son `before update` **sobre cualquier columna**, no `update of <columna de estado>` —
exactamente lo que cierra el vector que motivó el hallazgo. `packages/data/tests/grants-conjunto-
cerrado.test.ts` lo declara "CERRADO" en su encabezado y HANDOFF (211) lo reporta 20/20 verde.

`docs/diseno/10-deuda-declarada.md:815-826` y `docs/diseno/33-plan-deuda-pre-tanda-4.md` §A.6 siguen
diciendo "12/20 rojo, a propósito, convocatoria de seguimiento pendiente" — es documentación
desactualizada, no un hallazgo vigente. Se corrigen los dos documentos como parte de este ADR
(tarea de `documentador`, ver §16).

Lo que **sí** queda abierto, y que A.6 no cubría porque es un hallazgo distinto: toda columna `*_por`/
`*_en` de Capa D queda en el estado "identidad declarada, no autenticada"
(`0027_cierre_mensual.sql:306`) — el grant de INSERT las incluye y ninguna `with check` las ata a
`app.current_user_id()`. Se resuelve en §7 de este mismo ADR.

---

## §1. Identidad opaca: contrato `AuthProvider`

Se extiende el contrato ya decidido en `ADR-0000` §3.2, sin reabrirlo:

```ts
// packages/auth/src/auth-provider.ts
export type Sesion = {
  readonly usuarioId: string; // uuid — NUNCA lleva rol, ni capacidad, ni tenant
  readonly expiraEn: string;  // ISO 8601
};

export interface AuthProvider {
  iniciarSesion(credenciales: Credenciales): Promise<Sesion>;
  cerrarSesion(sesion: Sesion): Promise<void>;
  obtenerSesion(pedido: Request): Promise<Sesion | null>;
}
```

**Regla dura:** la identidad que cruza hacia los datos es solo un uuid. El rol y toda capacidad se
resuelven **siempre** en Postgres vía RLS (`app.accessible_tenant_ids()`, `app.has_capacidad_en()`, ver
§3) — nunca en la sesión, nunca en un claim del JWT, nunca comparado en TypeScript. Es la misma regla que
ya sostiene `ADR-0000` §3.1 ("Postgres decide, no TypeScript"), extendida hasta la capa de autenticación.

### Estructura del paquete

```
packages/auth/src/
  auth-provider.ts       — el contrato + Sesion (arriba)
  adapters/
    supabase.ts           — ÚNICO archivo del repo que importa @supabase/* y SUPABASE_SERVICE_ROLE_KEY
    local-fijo.ts          — identidad fija por config, habilitado SOLO con APP_ENTORNO=local
  cookies.ts              — LectorEscritorDeCookies { obtenerTodas(); establecerTodas() },
                             sin depender de next/* (lo implementa apps/web)
  registro.ts             — crearAuthProvider(): elige adapter por AUTH_PROVIDER, lanza si el
                             adapter no existe o si se pide el local fuera de `local`
  index.ts
```

`packages/auth` **no importa** `packages/data` (identidad ≠ datos) ni `next/*` (el framework queda
confinado a `apps/web`). El grafo de dependencias queda:

```
shared ← auth                (auth no importa data)
shared ← data
auth, data, ingesta, contabilidad, motor-conciliacion ← apps/web
                                                      ← apps/cli
```

---

## §2. Tabla puente `usuario_identidad` — degradación en el mismo punto donde se calcula el rol

`membership.user_id` sigue **sin FK** a ningún schema de auth (`ADR-0001:145`), pero necesita resolver
si esa identidad sigue activa **en el mismo lugar donde Postgres ya resuelve el rol**, no en TypeScript.
Se agrega una tabla puente, trivialmente 1:1 hoy, que existe para que dejar de serlo (rotar de
proveedor) no obligue a reescribir `membership`:

```sql
create table app.usuario_identidad (
  usuario_id      uuid primary key,          -- = membership.user_id = auth.users.id de Supabase
  proveedor       text not null,             -- 'supabase' | 'local'  (catálogo cerrado, árbitro en TS)
  sujeto_externo  text not null,
  activo          boolean not null default true,
  creado_en       timestamptz not null default now(),
  unique (proveedor, sujeto_externo)
);
```

Y `app.accessible_tenant_ids()`/`app.has_capacidad_en()` agregan `join usuario_identidad u on
u.usuario_id = m.user_id and u.activo` (`0001_tenancy.sql:220-246`). La baja de una persona
(§7) pone `activo=false` acá — nunca `delete`, porque `hecho_por`/`confirmado_por` referencian ese uuid
sin FK y borrarlo dejaría rastro huérfano.

**Por qué no una FK a `auth.users` ni un uuid propio distinto del de Supabase**: la primera viola
`ADR-0001:145` y ata el DDL a que exista el schema `auth` en local/CI; la segunda exige resolver
`sub → usuario_id` antes de `set_config`, es decir una lectura sin GUC. El costo de la tabla puente es
una fila por usuario; el beneficio es que rotar de proveedor de auth es una migración de datos, no de
esquema.

---

## §3. Capacidades finas — nunca dos riesgos distintos en la misma capacidad

El enum `app.rol_membership` (`0001_tenancy.sql:34-41`) **no se toca** ni se reescribe ninguna de las
policies existentes. Se agrega una capa **aditiva**, puramente en SQL:

```sql
create or replace function app.capacidades_de(rol app.rol_membership) returns text[]
  language sql immutable as $$
  select case rol
    when 'socio'          then array['ver_cliente','revelar_dato_restringido','confirmar_asiento',
                                      'cerrar_periodo','dispensar_pendiente','alta_cuenta_bancaria',
                                      'alta_socio','alta_contraparte','manifestar_padron_completo',
                                      'exportar','administrar_membresias','leer_auditoria']
    when 'contador'       then array['ver_cliente','revelar_dato_restringido','confirmar_asiento',
                                      'cerrar_periodo','dispensar_pendiente','alta_cuenta_bancaria',
                                      'alta_socio','alta_contraparte','manifestar_padron_completo']
    when 'administrativo' then array['ver_cliente','ingestar_extracto']
    when 'auditor'        then array['ver_cliente','revelar_dato_restringido','leer_auditoria']
    when 'admin_plataforma' then array[]::text[]  -- sin membresía en producción (§8): no ejerce nada
    when 'cliente_lectura' then array[]::text[]   -- sin uso en v1 (§9)
  end
$$;

create or replace function app.has_capacidad_en(nodo uuid, capacidad text) returns boolean
  language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1
    from membership m
    join usuario_identidad u on u.usuario_id = m.user_id and u.activo
    join tenant_node mn on mn.id = m.tenant_node_id
    join tenant_node tn on tn.id = nodo
    where m.user_id = app.current_user_id()
      and m.activo
      and capacidad = any(app.capacidades_de(m.rol))
      and (tn.path = mn.path or tn.path like mn.path || '.%')
  )
$$;
```

**Decisión: función `IMMUTABLE`, sin tabla de mapeo escribible** (recomendación de
`security-engineer`, preferida sobre la tabla `rol_capacidad` que propuso `arquitecto-software`). El
motivo: una tabla de mapeo es más flexible pero es superficie — cualquier grant sobre ella es escalada
potencial. Cambiar la matriz de capacidades es una migración revisable con su propia prueba de mutación,
igual que cualquier otro cambio a una función `security definer`. Este punto queda anotado para
confirmar con `dba-data` en la implementación, no como decisión reabierta.

**Combinaciones que quedan separadas a propósito** (nunca en la misma capacidad ni en el mismo rol por
default): `administrar_membresias` no acompaña a ningún `ver_*` (es el caso de `admin_plataforma`,
§8); `confirmar_asiento` (reversible por supersesión) no es lo mismo que `cerrar_periodo`
(irreversible, D-24); `ver_cliente` no incluye `exportar` (mirar no es sacar); `ingestar_extracto` no
incluye `alta_cuenta_bancaria` (el modo de falla real de E-1: dar de alta el CBU en el cliente que se
tenía a mano); `leer_auditoria` nunca la tiene quien es sujeto principal del rastro (`contador`,
`administrativo`).

**Cómo se evita que TypeScript decida**: la web puede consultar qué capacidades tiene la sesión sobre un
nodo para **ocultar botones**, nunca para autorizar. Si muestra un botón de más, la policy real devuelve
`42501` o 0 filas; si muestra uno de menos, es un bug de UX, no una fuga.

Las 109 policies existentes (`array['socio','contador']::app.rol_membership[]` y variantes,
`0004`/`0019`/`0027`) **no se tocan** en este ADR. Solo la policy nueva de `usuario_identidad`
(capacidad `administrar_membresias`) usa `has_capacidad_en` desde el día uno; es el primer consumidor
real, sin el cual la capa nace muerta.

---

## §4. Guard único de rutas — regla de código estilo R-B

```ts
// apps/web/src/servidor/sesion.ts
export async function conSesion<T>(
  fn: (sesion: SesionVerificada, tx: Tx) => Promise<T>,
): Promise<T> {
  const { data: { user } } = await supabase.auth.getUser(); // NUNCA getSession()
  if (!user) throw new SesionInvalida();
  return conUsuario(user.id, (tx) => fn({ usuarioId: user.id } as SesionVerificada, tx));
}
```

`SesionVerificada` lleva un símbolo no exportado (mismo truco que `ContextoAuditado`,
`auditoria.ts:93-98`): no se puede construir fuera de este archivo. **Sin membresía activa, el request
falla con 0 filas** (`accessible_tenant_ids()` ya filtra por `usuario_identidad.activo` y
`membership.activo`, §2) — es el único punto donde se degrada un usuario, tanto por baja de
membresía como por baja en Supabase (`getUser()` rechaza en el acto a un usuario baneado, sin caché).

**`getUser()`, nunca `getSession()`**: el segundo confía en la cookie sin validar contra el servidor de
Auth. Para esta etapa (una usuaria, tráfico ínfimo) la latencia de `getUser()` es irrelevante.

### Reglas de código nuevas (`packages/data/tests/reglas-de-codigo.test.ts`, próxima letra libre
verificada: `R-Q` es la última usada, se empieza en `R-R`)

| Regla | Qué prohíbe | Mutación de refutación |
|---|---|---|
| **R-R** | `@supabase/` solo en `packages/auth/src/adapters/supabase.ts` | plantar el import en otro archivo → rojo |
| **R-S** | `SERVICE_ROLE`/`auth.admin.` solo en el adapter y en `apps/cli/src/invitar-usuario.ts` | plantarlo en `apps/web` → rojo |
| **R-T** | `conUsuario(`/`conJob(` en `apps/web/` solo en `sesion.ts` | una ruta que llame `conUsuario` directo → rojo |
| **R-U** | `apps/web/src` sin sentencias SQL ni `.consultar(` | plantar un `select` en un handler → rojo |
| **R-V** | ningún literal de rol comparado en `apps/web`/`packages/auth` | `if (rol === 'socio')` en la web → rojo |
| **R-W** | todo `route.ts`/`actions.ts`/`page.tsx` con datos bajo `apps/web/src/app/**` importa `conSesion` | ruta nueva sin el import → rojo; moverla a un helper intermedio (refuta la versión ingenua de `trazabilidad-obra-gas`) → sigue rojo |
| **R-X** | `packages/auth`/`packages/data` no importan `next/` | plantar el import → rojo |
| **R-Y** | extiende R16: `set_config('app.user_id'` y `set`/`reset app.user_id` prohibidos fuera de `conexion.ts` | plantarlo en un lector de `packages/data` → rojo |

Y una línea en la cobertura del barrido (`reglas-de-codigo.test.ts:162-176`) que exige que
`apps/web/src/servidor/sesion.ts` y `packages/auth/src/index.ts` estén en `FUENTES` — sin eso, R-R…R-Y
pasan por vacío el día que alguien mueva la carpeta.

**Guard de arranque de la web** (análogo exacto de R18 para el proceso de request): si
`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL_JOB` o el DSN del dueño del esquema están definidos en el
proceso de `apps/web`, **no arranca**.

---

## §5. Rol `app_web` — A.4 se vuelve estructural en la base, no en la disciplina del código

```sql
create role app_web nologin;
-- select por columna, sin las 4 columnas N2R/N3:
--   cuenta_bancaria_identificador.numero
--   padron_socio_documento.documento
--   movimiento_origen_crudo.fila_origen
--   credencial_fiscal.material_cifrado
-- sin insert/update/delete salvo insert sobre acceso_auditoria
```

`ContextoAuditado`/`leerConAuditoria` (`packages/data/src/db/auditoria.ts`) siguen protegiendo la
**función**, no el nombre de la tabla — R32 hoy solo barre `movimiento_origen_crudo`
(`reglas-de-codigo.test.ts:470-545`). Este ADR generaliza ese barrido a las 4 tablas que devuelve
`tablasQueExigenAuditoriaEnLectura()` (`lectores-auditados.ts:60-64`), con allowlist por tabla.

**Decisión sobre la vista v1 (Tanda 4)**: `asiento_propuesto`, `asiento_propuesto_renglon` y
`movimiento_bancario_crudo` son **N2, no N2R** en el registro de clasificación — la vista puede
funcionar completa sin leer ni una columna N2R. Con el grant de `app_web` sin esas 4 columnas, un intento
de leerlas desde la web da `42501` en la base aunque el código lo pidiera — no depende de que nadie se
acuerde de usar el lector auditado.

**Extensión de `verificarCredencialDeRequest`** (`conexion.ts:115-188`): agrega
`has_column_privilege(current_user, tabla, columna, 'SELECT') = false` para las 4 columnas y
`has_table_privilege(current_user, tabla, 'INSERT'|'UPDATE'|'DELETE') = false` salvo
`acceso_auditoria` — si el DSN de Vercel apunta por error a `app_request` completo, la web no arranca.

---

## §6. Decisión sobre la vista v1: `descripcion`/`concepto_banco` completos — riesgo F4 aceptado por escrito

**Decisión del titular:** `movimiento_bancario_crudo.descripcion` y `concepto_banco` se muestran
**completos** (sin enmascarar), con permiso de edición dependiente del rol/perfil de quien mira.

**Condición explícita de esta elección, no un detalle secundario** (hallazgo F4 de
`seguridad-datos-financieros`): estas columnas son N2 en el registro de clasificación
(`clasificacion-campos.ts:432-437, 448-463`), pero el contenido real trae CUIT de terceros pegado sin
separador en una fracción medida del material real (incidente #11, 569/1346 filas de un lote) y sufijos
`DOC<11 dígitos>`. Mostrarlas completas en una pantalla permanente, sin `leerConAuditoria`, significa que
un dato con forma de N2R (identificador de un tercero) queda visible sin rastro de quién lo vio ni
cuándo, más allá del rastro grueso de apertura de cliente por sesión de §9. **Se acepta ese riesgo como
condición de esta decisión**, no como un hallazgo pendiente de otra tarea.

---

## §7. Autoría de Capa D — de "identidad declarada" a atada a la sesión

Hallazgo confirmado (`security-engineer` punto 2, `seguridad-datos-financieros` F2): ninguna `with
check` ata `confirmado_por`/`hecho_por`/`decidido_por`/`resuelto_por` a `app.current_user_id()` —
`cierre_periodo_upd_cierre` (`0027:366-370`), `cierre_transicion_ins_*` (`0027:428-435`),
`pendiente_cierre_upd_dispensa` (`0027:662-666`), `confirmacion_grupo_ins` (`0043:85-87`). El grant de
INSERT las incluye (`0027:306`, "N1: identidad declarada ≠ autenticada"), a diferencia del patrón
correcto que ya existe en `0021_capa_d_vocabulario_motivo.sql:437,483` (`manifestado_por … default
app.current_user_id()`, fuera del grant).

**Regla nueva de `ADR-0002` §B — R44**: *toda columna de autoría (`*_por`) de una tabla con `cliente_id`
se ata a `app.current_user_id()` en su `with check`, o sale de un `default` sin grant de columna sobre
ella. Ninguna tercera forma.* Mutación de refutación: un `update` que intente escribir un `*_por` distinto
del `current_user_id()` de la sesión tiene que morir; un `insert` que omita la columna tiene que
completarla con la identidad real, no con `null`.

**Cierre**: migración que (a) para las columnas ya con `default` sin uso de `current_user_id()`, agrega
la `with check`/trigger que las ata a la sesión (patrón `0021`); (b) `asiento_propuesto` no tiene columna
de autor de confirmación (`escrituras.ts:604-625` solo cambia estado) — se agrega, con el mismo patrón.
Entra en este ADR, no queda como deuda con fecha (decisión del titular, punto 5).

---

## §8. `admin_plataforma` — Opción A: cero membresía en tenants de producción

**Decisión del titular:** el administrador de plataforma **nunca** tiene membresía en ningún
`tenant_node` de producción. Toda administración de plataforma (alta del estudio, primera membresía de
Laura) corre por `conJob('alta_estudio')` (`conexion.ts:51`) — motivo que existe en la unión cerrada de
`MotivoJob` pero que **ningún código invoca todavía** (verificado, `grep` sin resultados fuera de
`siembra_sintetica`); este ADR lo escribe.

**Por qué esta opción y no la variante B** (membresía sin dato): hoy toda policy de lectura de dominio
filtra solo por subárbol (`0004:491-492`, `0027:345-346, 758-759`) sin mirar rol — cualquier membresía en
la raíz del estudio, `admin_plataforma` incluida, vería todo el N2 de todos los clientes. Cerrar eso por
la variante B exigiría tocar 40+ policies existentes. La Opción A logra el mismo invariante sin tocar
ninguna: `capacidades_de('admin_plataforma')` devuelve `array[]` (§3), y como además no hay fila de
`membership` para ese rol en producción, el invariante *"ninguna identidad con rol `admin_plataforma`
devuelve una fila de una tabla con `cliente_id`"* se cumple por las dos vías (sin capacidad y sin
membresía), y se prueba en vivo (§15).

**Soporte técnico**: no existe acceso de soporte a datos reales en esta etapa. Si el titular necesita
depurar algo, es con datos sintéticos o con una excepción registrada explícitamente por Laura (mismo
procedimiento que `ADR-0002` §F.3).

---

## §9. Roles del equipo y clientes finales

**Decisión del titular:** no hay una regla fija de "raíz del estudio" vs. "por cliente". El alcance de
clientes de cada persona del equipo (Laura, contadores, administrativos) se configura por membresía/rol,
caso a caso — puede ver todos los clientes del estudio o un subconjunto, según a qué nodo se le da de
alta la membresía. Los clientes finales (Bracci, ROKA, etc.) **nunca** acceden directamente al sistema en
esta etapa; un futuro acceso de solo lectura para alguien del lado del cliente final sería una instancia
aparte, resuelta también por rol cuando llegue su turno.

`cliente_lectura` queda en el enum sin ninguna policy propia que lo acote dentro de un cliente (H-3,
`ADR-0002:872`, sigue abierto) — se declara "sin uso hasta un ADR de portal" y un test en vivo asserta
**0 membresías con ese rol en producción**.

---

## §10. Usuarios de prueba con rol real por tenant — confirmado

Para que el titular (u otra persona) opere dentro de un tenant de prueba (Bracci, ROKA) con distintos
roles reales durante la etapa de demo, **no se crea un mecanismo de impersonación desde
`admin_plataforma`**. Se usan identidades de prueba reales, invitadas por el flujo normal de §11, con
membresía real y rol real en el tenant elegido. El email de cada identidad puede ser real (del titular o
de alguien del equipo) o creado puntualmente para testing — en ambos casos pasa por el mismo flujo. La
regla de "sin datos sintéticos" (que Laura confirme sobre datos reales) rige sobre **datos de negocio**,
no sobre identidades de usuario para QA: no hay excepción que declarar acá. Mismo rastro
(`membership_historia`, `acceso_auditoria`) que cualquier usuario real.

---

## §11. Invitación — nunca contraseña temporal

**Flujo:**

1. El alta del estudio y la primera membresía de Laura corren por `conJob('alta_estudio')` (acto único,
   scriptado, `hecho_por` nulo = mantenimiento, `0019:136-141`).
2. Laura (`socio`) invita a su equipo — `membership_wr` ya lo permite para roles no supervisores
   (`0019:270-278`). Un `auditor` no lo puede crear Laura (rol supervisor, `0019:252-257`); se provisiona
   por job registrado.
3. La invitación corre por un CLI (`apps/cli/src/invitar-usuario.ts`), en la máquina del titular, con
   `SUPABASE_SERVICE_ROLE_KEY` en el `.env` de infraestructura — **nunca** en Vercel ni en
   `apps/web/.env.local` (análogo exacto de R18 para `DATABASE_URL_JOB`). Dry-run por defecto.
4. Orden: primero `auth.admin.inviteUserByEmail()` (devuelve el `user.id`), después
   `insert into membership` con `conUsuario(socioId)`. Si el segundo paso falla, el usuario queda en
   `auth.users` sin membresía → 0 filas, falla cerrado. Se reintenta solo el segundo paso.
5. Invitación no aceptada: un CLI de listado cruza `membership.activo=true` con
   `last_sign_in_at is null`; el socio decide dar de baja.
6. **Baja** (criterio de cierre, punto 12 del titular): **un solo comando CLI** que hace las dos cosas
   juntas — `update membership set activo=false` (única columna otorgable, `0019:231-232`, deja rastro en
   `membership_historia`) y `auth.admin.updateUserById(…, { ban_duration: … })` en Supabase. Nunca borrar
   el usuario del proveedor: el uuid sigue resolviendo a una persona en el rastro histórico. Cambio de rol
   = baja + alta. **Un uuid de usuario nunca se reusa.**

---

## §12. Incidente #8 — qué cambia y qué no

**Cambia**: el uuid que entra a `set_config` (`conexion.ts:246`) pasa a ser uno que Supabase autenticó en
este request (`getUser()`, nunca `getSession()`). Cierra la mitad "quién está del otro lado" que hoy no
existe. Y hace verdad la declaración de que la atribución histórica del piloto **no es retroactiva**: los
valores `hecho_por`/`confirmado_por` del piloto local siguen siendo "el proceso que corrió con esa
sesión", no una persona real — sin necesidad de marca en datos, porque producción arranca vacía y el
piloto no se migra (§13).

**No cambia**: dentro de `fn(tx)`, código con acceso al DSN de `app_request` sigue pudiendo reescribir
`app.user_id` a mitad de transacción (medido, `registro-incidentes.md:56-64`). Se acota con R-Y (§4,
regla de código) y un tripwire en `Tx.consultar` que rechaza SQL que matchee `app.user_id` — no se
cierra. **Premisa declarada, no regla ✅**: quien controla el código de `packages/data`/`apps/cli` o el
DSN de `app_request` puede firmar como cualquier uuid del propio subárbol. Toda afirmación forense sobre
`hecho_por`/`user_id` vale "contra usuarios de la web", no "contra el equipo de desarrollo" — misma
cláusula que R38 (8).

---

## §13. Supabase como destino — precondición verificada, cerrada

Verificado por el titular en el SQL Editor del proyecto real, dos veces:

- `select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = current_user` →
  `rolbypassrls = true`. **P-1** (`ADR-0002:331`, recursión infinita si el dueño no tiene `BYPASSRLS`) no
  se activa. `app_job` se crea tal como está diseñado en `0001_tenancy.sql:287`.
- `pg_default_acl`: 24 filas totales, **ninguna sobre el schema `app`**.
- `information_schema.role_table_grants` sobre `app` para `anon`/`authenticated`/`service_role`: 0 filas.
- `pg_class` con `relkind='r'` bajo `public`: 0 filas.

**Regla explícita, no supuesto**: mientras ninguna tabla de dominio se cree en `public` (todo va a
`app`), el default ACL estándar de Supabase sobre `public` no tiene nada que exponer. Si alguna vez se
crea una tabla en `public` por error, el riesgo vuelve — se deja como nota de vigilancia, no como
control automático en este ADR.

**Migraciones se aplican con conexión directa (IPv6) o por el pooler en *session mode* (5432), nunca por
el pooler en *transaction mode* (6543)** — Supavisor en transaction mode no soporta `DO`/DDL de sesión
larga. `DATABASE_URL_APP` (rol `app_web`) sí va por el pooler en transaction mode: `set_config(…, true)`
es transaccional (R22 ya lo verifica) e INV-4 contiene un GUC de sesión pegado por otro cliente del
pooler.

---

## §14. Entornos y secretos

| Variable | Vercel Production | Vercel Preview | Máquina del titular | Guard |
|---|---|---|---|---|
| `APP_ENTORNO` | `produccion` (o `staging`, según §16) | — (Preview desactivado, ver abajo) | según base | `entorno.ts` sin default |
| `DATABASE_URL_APP` | pooler 6543, rol `app_web` | — | `app_request_dev` local | `verificarCredencialDeRequest` extendido (§5) |
| `SUPABASE_URL` + anon key | sí, server-only, **sin `NEXT_PUBLIC_`** | — | no hace falta | R37 |
| `SUPABASE_SERVICE_ROLE_KEY` | **ausente** | — | sí, solo para `invitar-usuario.ts` | R-S + guard de arranque §4 |
| `DATABASE_URL_JOB` / DSN del dueño | **ausente** | — | sí | guard de arranque §4 |

**Login 100% server-side, sin ningún `NEXT_PUBLIC_*`** (decisión del titular, punto 6): sin SDK de
Supabase en el navegador, sin claves en el bundle — coherente con `ADR-0002` §E.1 sin necesidad de
reescribirla.

**Preview de Vercel: se desactivan** hasta que exista un segundo proyecto Supabase dedicado a testing
(decisión del titular, punto 7). Evita que una URL de preview apunte al proyecto real.

---

## §15. Registro de terceros

Se agregan dos filas a `docs/seguridad/registro-terceros.md`, siguiendo el mismo criterio del paso 4 de
"Cómo se agrega un destino" que ya rige para cualquier destino — no un tratamiento especial: verificado
que no existe precedente de tratamiento más liviano para un proveedor de EE.UU. (Google Vision, AWS
Textract y Azure Document Intelligence están **rechazados** en ese mismo registro, no aceptados con nota
reducida).

| Destino | Qué se manda | Nivel máximo | Base / motivo | Hueco declarado |
|---|---|---|---|---|
| Supabase Auth (us-east-2) | email, hash de contraseña (administrado por el proveedor), marcas de sesión | N2 | Identidad de staff, no dato de cliente | Transferencia internacional de dato personal: no tengo esa fuente cargada (§G) |
| Vercel (hosting) | request logs con URL/IP | N1 (con R30 aplicando: ningún dato ≥N2 en URL) | Hosting de la aplicación | mismo hueco |

`email` se agrega a `CLAVES_SENSIBLES_EXTERNAS` en `clasificacion-campos.ts` en el mismo commit del
adapter (hoy no está, un `logger.info` con el email compilaría).

---

## §16. Alcance: qué entra y qué queda afuera

**Entra:** todo lo de §1-§15. **Entorno del primer login**: el proyecto Supabase actual, que pasará a
llamarse "staging" si se abre una producción formal aparte más adelante; primera ingesta real ahí, sin
datos sintéticos (decisión del titular, punto 1). **Datos Bracci/ROKA**: recarga desde cero cuando le
llegue el turno (nada de la demo se promueve), aprovechada como prueba end-to-end del sistema completo —
es un paso posterior, con su propia autorización, no de este ADR.

**Queda afuera a propósito:**

| Afuera | Qué se pierde | Por qué es aceptable |
|---|---|---|
| Diseño visual (`ux-designer`, logos de banco) | La vista v1 es funcional, no la experiencia imaginada | Condicionado en `doc 31` a que Laura complete las hojas de Excel primero |
| MFA para `socio` | Un solo factor protege el secreto fiscal en v1 | Decisión explícita del titular (punto 8), pospuesto a después de la Tanda 4 |
| B.12 (`decidido_por` en `cuenta_atributo`) | Sin auditoría por fila en esa tabla todavía | La Tanda 4 es de solo lectura; R-U (§4) hace visible el momento en que se agregue la primera escritura |
| Portal `cliente_lectura` | Sin acceso de clientes finales | Ningún cliente entra a la Tanda 4 (§9) |

---

## Decisión

Se adoptan: el contrato `AuthProvider` con identidad opaca (§1); la tabla puente `usuario_identidad`
(§2); las capacidades finas por función `IMMUTABLE` (§3); el guard único `conSesion` con las reglas de
código R-R a R-Y (§4); el rol `app_web` sin las 4 columnas N2R/N3 (§5); mostrar
`descripcion`/`concepto_banco` completos con el riesgo F4 aceptado por escrito (§6); la regla R44 que ata
toda autoría de Capa D a la sesión (§7); `admin_plataforma` sin membresía en producción, Opción A (§8);
roles del equipo configurados por membresía caso a caso (§9); usuarios de prueba con membresía real, sin
impersonación (§10); invitación por enlace, nunca contraseña temporal (§11); el residual declarado del
incidente #8 (§12); y el registro de Supabase/Vercel como terceros (§15).

## Consecuencias

- `apps/web` nace con Next.js (App Router), justificado por el destino Vercel confirmado y por ser el
  patrón ya probado en los dos sistemas hermanos.
- Ninguna de las 109 policies existentes se toca; el enum `rol_membership` tampoco.
- La primera pantalla de la Tanda 4 puede ser enteramente de datos N2 — ninguna columna N2R/N3 necesita
  aparecer en v1, lo cual simplifica el rol `app_web` a "sin esas 4 columnas" en vez de "con
  `leerConAuditoria` cableado para la web".
- El riesgo residual del incidente #8 permanece: la autenticación real cierra "quién entra", no "qué
  puede reescribir código con acceso al DSN". Se declara, no se resuelve.
- Preview de Vercel queda desactivado hasta que exista el segundo proyecto Supabase — costo operativo
  aceptado por decisión explícita.

## Criterio de cierre (invariantes verificables, no solo "ADR aprobado")

- Contador de un cliente A no ve cliente B: 404, no 403.
- Sesión sin membresía activa: 0 filas.
- Membresía desactivada, mismo token: 0 filas en el request siguiente.
- Usuario baneado en Supabase: rechazado en `conSesion`, antes de llegar a `conUsuario`.
- 0 membresías con rol `admin_plataforma` en cualquier tenant de producción (test en vivo).
- 0 membresías con rol `cliente_lectura` en producción (test en vivo).
- `app_web` sin privilegio sobre las 4 columnas N2R/N3, verificado contra el catálogo real de Postgres
  (`information_schema.column_privileges`), no inferido del `.sql`.
- 1 login real del titular o de Laura, de punta a punta, contra el proyecto Supabase real.
- `grants-conjunto-cerrado.test.ts` y `reglas-de-codigo.test.ts` verdes, con el conteo de tests subiendo
  según la predicción falsable de la convocatoria (ver anexo).

## Anexo

Los tres dictámenes completos (`arquitecto-software`, `security-engineer`, `seguridad-datos-
financieros`) y las 12 decisiones del titular quedan referenciados en `HANDOFF.md`, entrada que cierra
esta tarea.

---

_**Validar con profesional matriculado.**_
