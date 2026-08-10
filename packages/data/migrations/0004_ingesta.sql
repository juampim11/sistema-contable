-- =============================================================================
-- 0004_ingesta.sql — modelo de datos del Módulo 1 (ingesta de extractos bancarios)
--
-- Especificado en `docs/diseno/01-modulo-1-ingesta-bancaria.md` §7.1 y §8. Es la etapa E0 del plan y
-- **corre antes de la primera línea del adapter**: una tabla sin RLS forzada o una unicidad global sobre
-- un identificador de tercero es una fuga entre clientes, y arreglarla después de tener filas es una
-- migración destructiva.
--
-- SIETE TABLAS: el catálogo `banco` (N0, sin tenant) más seis con `cliente_id`.
--
-- ## Las seis enmiendas al contrato de ADR-0001 §5.1, con su motivo
--
--   1. **`fila_origen` NO vive en el movimiento.** Va a la satélite `movimiento_origen_crudo` (N2R).
--      Motivo medido: el archivo real del piloto trae 113 CUIT de terceros dentro de las filas crudas.
--      Si esa columna vive en `movimiento_bancario_crudo`, **toda** lectura de movimientos pasa al
--      régimen auditado — y auditar 326 filas por pantalla no es un control, es el ruido que **destruye**
--      la capacidad de detectar al administrativo que se baja la cartera (ADR-0002 H-8).
--
--   2. **`lote_ingesta.cuenta_bancaria_id` no existe.** Un archivo trae N cuentas, así que los
--      contadores y la verificación son **por cuenta**: `lote_ingesta_cuenta`.
--
--   3. **`movimiento_bancario_crudo.cuenta_bancaria_id` es NOT NULL** y apunta con una **FK de tres
--      columnas** a `lote_ingesta_cuenta`. Eso vuelve invariante de integridad referencial que la cuenta
--      de un movimiento sea una de las detectadas en ese lote, de ese cliente. Es la única defensa de
--      tenant que sobrevive a `BYPASSRLS`, a `COPY` y a un bug de la aplicación (ADR-0002 R12).
--
--   4. **La unicidad de fila es `(cliente_id, cuenta_bancaria_id, fila_hash)`.** Con dos cuentas en el
--      mismo archivo, `(cliente_id, fila_hash)` rechazaría filas legítimas.
--
--   5. **La identidad de la cuenta se separa de sus identificadores.** Un CBU y un número de cuenta
--      cambian; un extracto de hace ocho meses tiene que resolver con **el identificador vigente
--      entonces**. De ahí la serie con vigencia.
--
--   6. **`acceso_auditoria.accion` suma `rechazo`, más un check constraint.** Registrar un rechazo como
--      escritura es asentar algo falso en la única tabla append-only del sistema; y sin el check, un
--      valor mal escrito entra y el evento **desaparece de toda consulta del rastro**.
--
-- ## Lo que este módulo NO decide
--
-- La cuenta contable, la propuesta de asiento y el matching del tercero son del Módulo 2. La tabla se
-- llama *crudo* por eso. Tampoco se guardan acá las líneas que el adapter no interpretó: se reportan
-- por log con su **forma** (`formaParaLog`), nunca con su texto.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. `acceso_auditoria.accion`: el valor que falta y el check que nunca estuvo
-- -----------------------------------------------------------------------------
--
-- Un lote rechazado por INV-6 (el extracto declarado para el cliente A cuya cuenta resuelve al B) tiene
-- que dejar rastro. Hoy las acciones son de acceso y de escritura: registrar el rechazo como una
-- escritura sería asentar un hecho que no ocurrió.
--
-- Y el check constraint importa más de lo que parece: sin él, `accion = 'rechzo'` entra sin error y el
-- evento deja de aparecer en cualquier consulta que filtre por acción. El rastro queda con un agujero
-- que nadie ve, que es peor que no tener el evento.
--
-- La lista tiene que ser IDÉNTICA a la constante `ACCIONES` de `packages/data/src/db/auditoria.ts`, y hay
-- un test de catálogo que las compara. Vale la pena: la primera versión de este check omitía
-- `uso_credencial`, que el código sí emite — todo registro de uso de una credencial fiscal habría fallado
-- en el insert, y se habría descubierto el día que se integrara AFIP.
alter table acceso_auditoria
  add constraint acceso_auditoria_accion_chk
  check (accion in ('lectura', 'export', 'descarga', 'uso_credencial', 'escritura', 'borrado',
                    'rechazo'));

comment on constraint acceso_auditoria_accion_chk on acceso_auditoria is
  'Cierra el dominio de `accion`. Sin esto un valor mal escrito entra y el evento desaparece de toda '
  'consulta del rastro: un agujero silencioso en la única tabla append-only del sistema.';

-- -----------------------------------------------------------------------------
-- 1. `banco` — catálogo de referencia (N0, sin tenant)
-- -----------------------------------------------------------------------------
--
-- Es la lista de bancos que el sistema sabe leer, con la versión del adapter que los parsea. No tiene
-- `cliente_id` porque no contiene datos de nadie: es conocimiento del producto.
--
-- `capacidades` declara qué publica cada banco (si trae saldo por fila, si trae totales, si separa
-- crédito y débito en columnas). Sin esto, "el banco no publica el signo" y "el adapter está roto" son
-- indistinguibles — y el segundo se esconde detrás del primero.
create table banco (
  codigo       text primary key,
  nombre       text not null,
  capacidades  jsonb not null default '{}'::jsonb,
  activo       boolean not null default true,
  created_at   timestamptz not null default now(),

  constraint banco_codigo_chk check (codigo ~ '^[a-z0-9_]{2,32}$')
);

comment on table banco is
  'Catálogo N0 sin tenant: conocimiento del producto, no datos de un cliente. La escritura es del dueño '
  'del esquema (migración), no de la aplicación: un banco nuevo llega con su adapter, no por formulario.';

-- SIN RLS Y SIN POLICY, deliberadamente.
--
-- La primera versión de esta migración le puso `force row level security` y una `policy ... using (true)`
-- "por consistencia". El test de catálogo la rechazó, y tenía razón: R5 prohíbe el predicado abierto, y
-- una policy `true` es exactamente eso. La tentación era agregarle una excepción a la regla.
--
-- Pero la regla no estaba equivocada. Una policy `using (true)` no aísla nada: es RLS decorativa, y su
-- costo real es volver ambiguo el resultado del test — a partir de ahí "esta policy es abierta a
-- propósito" y "alguien se olvidó el predicado" se leen igual. R1 solo exige RLS a las tablas con columna
-- de tenant, y este catálogo no tiene ninguna porque no contiene datos de nadie.
grant select on banco to app_request;
grant select on banco to app_job;

-- -----------------------------------------------------------------------------
-- 2. `cuenta_bancaria` — la identidad estable de la cuenta (N2)
-- -----------------------------------------------------------------------------
--
-- Deliberadamente **sin números**: acá vive lo que no cambia. Los identificadores (número, CBU) son una
-- serie con vigencia en la tabla de abajo, porque cambian y porque son N2R.
create table cuenta_bancaria (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references tenant_node(id) on delete restrict,
  banco_codigo  text not null references banco(codigo) on delete restrict,
  moneda        char(3) not null default 'ARS',
  -- Etiqueta que le pone el estudio ("cuenta operativa", "sueldos"). N2: la elige una persona y puede
  -- decir más de lo que parece.
  alias         text,
  abierta_desde date,
  cerrada_en    date,
  created_at    timestamptz not null default now(),

  constraint cuenta_bancaria_moneda_chk check (moneda ~ '^[A-Z]{3}$'),
  -- (10) de la plantilla ampliada: habilita las FK compuestas de los hijos.
  constraint uq_cuenta_bancaria_tenant unique (cliente_id, id)
);

create index idx_cuenta_bancaria_cliente on cuenta_bancaria(cliente_id);

create trigger trg_cuenta_bancaria_cliente
  before insert or update of cliente_id on cuenta_bancaria
  for each row execute function app.exigir_nodo_cliente();

alter table cuenta_bancaria enable row level security;
alter table cuenta_bancaria force  row level security;

create policy cuenta_bancaria_sel on cuenta_bancaria for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

create policy cuenta_bancaria_wr on cuenta_bancaria for all
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert, update, delete on cuenta_bancaria to app_request;

-- -----------------------------------------------------------------------------
-- 3. `cuenta_bancaria_identificador` — serie con vigencia (N2R)
-- -----------------------------------------------------------------------------
--
-- ## Por qué el CBU se guarda hasheado y el número entero
--
-- La regla es: *un identificador que solo hace falta para **matchear** se guarda hasheado; uno que hace
-- falta para **consultar afuera** se guarda entero, N2R, con chequeo de rol y auditado.*
--
-- El CBU solo se usa para resolver a qué cuenta pertenece un extracto → `cbu_hmac` (HMAC con pepper de
-- servidor, nunca un hash pelado: un CBU tiene entropía baja y un sha256 sin pepper se revierte con un
-- diccionario). Más `cbu_ultimos4` para mostrárselo a una persona sin exponer el resto.
--
-- El número de cuenta sí hace falta entero: es con lo que se habla con el banco. Va N2R.
--
-- ## Por qué la consulta de resolución NUNCA pregunta "¿de quién es este CBU?"
--
-- Preguntarlo requeriría saltear la RLS, y eso construye un **oráculo cross-tenant**: con un CBU
-- cualquiera se averigua si es cliente de otro estudio. La resolución va siempre acotada al cliente
-- declarado en el comando (ADR-0001 §5.1, INV-6).
create table cuenta_bancaria_identificador (
  id                  uuid primary key default gen_random_uuid(),
  cliente_id          uuid not null references tenant_node(id) on delete restrict,
  cuenta_bancaria_id  uuid not null,
  -- N1: qué clase de cuenta es. No identifica a nadie.
  tipo_cuenta         text not null,
  -- N2R: el número tal como lo usa el banco.
  numero              text not null,
  -- N1: HMAC con pepper de servidor. NO es el CBU y no se puede revertir sin el pepper.
  cbu_hmac            bytea,
  -- N2 enmascarado: lo que se muestra en una pantalla.
  cbu_ultimos4        char(4),
  vigente_desde       date not null,
  vigente_hasta       date,
  created_at          timestamptz not null default now(),

  constraint cuenta_ident_tipo_chk
    check (tipo_cuenta in ('caja_ahorro', 'cuenta_corriente', 'cuenta_unica', 'otra')),
  constraint cuenta_ident_vigencia_chk
    check (vigente_hasta is null or vigente_hasta >= vigente_desde),
  constraint cuenta_ident_ultimos4_chk
    check (cbu_ultimos4 is null or cbu_ultimos4 ~ '^[0-9]{4}$'),
  -- Unicidad POR CLIENTE. Un `unique` global sobre `cbu_hmac` sería un oráculo: el error de clave
  -- duplicada le diría a un estudio que ese CBU ya está cargado en otro (ADR-0002 R6).
  constraint uq_cuenta_ident_cbu_cliente unique (cliente_id, cbu_hmac, vigente_desde),
  constraint uq_cuenta_ident_tenant unique (cliente_id, id),

  -- (11) FK COMPUESTA tenant-consistente.
  constraint fk_cuenta_ident_cuenta
    foreign key (cliente_id, cuenta_bancaria_id)
    references cuenta_bancaria (cliente_id, id)
    on delete restrict
);

create index idx_cuenta_ident_cliente on cuenta_bancaria_identificador(cliente_id);
-- El índice de resolución: SIEMPRE lleva cliente_id adelante, porque la consulta siempre lo lleva.
create index idx_cuenta_ident_resolucion
  on cuenta_bancaria_identificador(cliente_id, cbu_hmac)
  where cbu_hmac is not null;

create trigger trg_cuenta_ident_cliente
  before insert or update of cliente_id on cuenta_bancaria_identificador
  for each row execute function app.exigir_nodo_cliente();

alter table cuenta_bancaria_identificador enable row level security;
alter table cuenta_bancaria_identificador force  row level security;

-- (8) N2R: chequeo de rol también en LECTURA. Un `administrativo` con acceso al cliente puede ingestar
-- y no puede leer el número de cuenta completo.
create policy cuenta_ident_sel on cuenta_bancaria_identificador for select
  using ( cliente_id in (select app.accessible_tenant_ids())
          and app.has_role_on(cliente_id, array['socio','contador','auditor']::app.rol_membership[]) );

-- ## LA TRAMPA DE `for all` EN UNA TABLA CON LECTURA RESTRINGIDA
--
-- Las policies PERMISIVAS de Postgres se combinan con **OR**, y `for all` incluye SELECT. Así que una
-- policy de escritura `for all` que admita más roles que la de lectura **anula** la restricción de
-- lectura: el permiso más amplio gana.
--
-- Se descubrió corriendo el test: el `administrativo` leyó las filas crudas del cliente. La policy
-- `mov_origen_sel` exigía socio/contador/auditor y estaba bien escrita — pero `mov_origen_wr for all`
-- admitía también al administrativo (que tiene que poder ESCRIBIR: ingestar es su trabajo), y el OR le
-- devolvió la lectura. El control se veía correcto en la migración y no existía en la base.
--
-- Por eso en las tablas N2R la escritura se declara con `for insert` / `for update` / `for delete`
-- explícitas, nunca con `for all`. El test de catálogo lo exige.
create policy cuenta_ident_ins on cuenta_bancaria_identificador for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

create policy cuenta_ident_upd on cuenta_bancaria_identificador for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

create policy cuenta_ident_del on cuenta_bancaria_identificador for delete
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio']::app.rol_membership[]) );

-- (9) El grant por COLUMNA de la plantilla ampliada excluye **lo N3**, y acá no hay nada N3.
--
-- La primera versión dejaba `numero` afuera del grant de `app_request` "por prudencia". Eso lo volvía
-- ilegible para TODOS los roles de la aplicación, incluido el contador que necesita el número completo
-- para hablar con el banco: la tabla habría quedado escribible y nunca legible.
--
-- N2R no significa "sin grant": significa **rol explícito en lectura** (la policy de arriba) **más
-- auditoría del acceso** (el lector auditado de `LECTORES_AUDITADOS`). Quitar el grant es el control de
-- N3, donde el dato no lo lee la app sino un proceso separado.
grant select, insert, update, delete on cuenta_bancaria_identificador to app_request;

-- El job de mantenimiento que detecta el MISMO CBU en dos clientes (plan §7.2.9) necesita contar
-- clientes distintos por HMAC. Se le da exactamente eso y nada más: no ve el número ni el alias, y su
-- salida es un incidente **con conteos, sin nombrar a ningún cliente**.
grant select (cliente_id, cbu_hmac) on cuenta_bancaria_identificador to app_job;

-- -----------------------------------------------------------------------------
-- 4. `lote_ingesta` — el ancla del pipeline (N1 ESTRICTO, a propósito)
-- -----------------------------------------------------------------------------
--
-- **Ni una sola columna ≥ N2.** Es una decisión de diseño, no una casualidad: si el lote llevara un dato
-- N2 (por ejemplo el nombre original del archivo, que suele traer la razón social del cliente), entonces
-- observar el pipeline —contar lotes, ver cuántos fallaron, graficar el ritmo de ingesta— pasaría al
-- régimen auditado. La observabilidad del sistema quedaría atada a la auditoría de acceso a datos, y una
-- de las dos se degradaría.
--
-- Por eso el nombre original del archivo **no se guarda acá**.
create table lote_ingesta (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references tenant_node(id) on delete restrict,
  banco_codigo     text not null references banco(codigo) on delete restrict,
  -- Versión del adapter que lo parseó: sin esto, un lote viejo no se puede reinterpretar sabiendo con
  -- qué reglas se leyó.
  adaptador_version text not null,
  origen           text not null,
  -- Clave en ObjectStorage: `cliente/<uuid>/extracto/<lote_uuid>.pdf`. El nombre es el ID del lote y
  -- NO el hash del contenido: una clave con el hash convierte al storage en un oráculo de "¿tenés este
  -- archivo exacto?" (plan §7.3).
  archivo_clave    text,
  -- Idempotencia. Es un digest del contenido, opaco, y se compara SOLO dentro del cliente.
  archivo_hash     text not null,
  paginas_declaradas integer,
  paginas_sin_texto  integer,
  filas_leidas     integer not null default 0,
  filas_aceptadas  integer not null default 0,
  filas_rechazadas integer not null default 0,
  estado           text not null,
  -- Código de la razón por la que no se aceptó, del vocabulario cerrado de `CODIGOS_DIFERENCIA`. Es un
  -- CÓDIGO y no un mensaje: un mensaje libre construido desde el archivo filtra su contenido al log.
  motivo_codigo    text,
  procesado_por    uuid,
  created_at       timestamptz not null default now(),

  constraint lote_ingesta_origen_chk check (origen in ('archivo', 'casilla', 'api')),
  -- Los cuatro estados del plan §8.5. `rechazado` no es uno de ellos: un lote rechazado queda
  -- `con_errores` con su `motivo_codigo`, y el rechazo se asienta en `acceso_auditoria` con
  -- `accion = 'rechazo'`.
  constraint lote_ingesta_estado_chk
    check (estado in ('recibido', 'procesado', 'procesado_con_observaciones', 'con_errores')),
  constraint lote_ingesta_conteos_chk
    check (filas_leidas >= 0 and filas_aceptadas >= 0 and filas_rechazadas >= 0
           and filas_aceptadas + filas_rechazadas <= filas_leidas),
  -- Idempotencia POR CLIENTE, nunca global (R6).
  constraint uq_lote_ingesta_archivo unique (cliente_id, archivo_hash),
  constraint uq_lote_ingesta_tenant unique (cliente_id, id)
);

create index idx_lote_ingesta_cliente on lote_ingesta(cliente_id);
create index idx_lote_ingesta_estado on lote_ingesta(cliente_id, estado);

create trigger trg_lote_ingesta_cliente
  before insert or update of cliente_id on lote_ingesta
  for each row execute function app.exigir_nodo_cliente();

alter table lote_ingesta enable row level security;
alter table lote_ingesta force  row level security;

create policy lote_ingesta_sel on lote_ingesta for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- El `administrativo` PUEDE ingestar: es el trabajo que hace. Lo que no puede es descargar el archivo
-- después (plan §7.3) — eso se controla en el emisor de URL firmada, no acá.
create policy lote_ingesta_wr on lote_ingesta for all
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

grant select, insert, update on lote_ingesta to app_request;

-- -----------------------------------------------------------------------------
-- 5. `lote_ingesta_cuenta` — una fila por cuenta detectada en el archivo
-- -----------------------------------------------------------------------------
--
-- Enmienda 2: un archivo trae N cuentas, así que los contadores y la verificación son por cuenta. Y es
-- el **padre de la FK de tres columnas** del movimiento, que es lo que vuelve imposible que un
-- movimiento apunte a una cuenta que no fue detectada en ese lote.
--
-- La verificación es **tri-estado** y la calcula una función pura sobre los datos, nunca el adapter
-- sobre sí mismo: `no_verificable` es un resultado legítimo y distinto de `cuadra`. Un banco que no
-- publica totales no puede producir un "cuadra" — decir que cuadra cuando no hay contra qué comparar es
-- el peor modo de falla del módulo, porque cierra la pregunta.
create table lote_ingesta_cuenta (
  id                  uuid primary key default gen_random_uuid(),
  cliente_id          uuid not null references tenant_node(id) on delete restrict,
  lote_ingesta_id     uuid not null,
  cuenta_bancaria_id  uuid not null,
  periodo_desde       date not null,
  periodo_hasta       date not null,
  moneda              char(3) not null default 'ARS',
  -- Lo que el documento DECLARA. Nullable porque no todo banco lo publica, y ese "no lo publica" es un
  -- dato: es lo que hace que la verificación dé `no_verificable` en vez de `cuadra`.
  saldo_inicial_declarado numeric(18,2),
  saldo_final_declarado   numeric(18,2),
  total_creditos_declarado numeric(18,2),
  total_debitos_declarado  numeric(18,2),
  -- Lo que se CALCULÓ sobre las filas.
  saldo_final_calculado   numeric(18,2),
  total_creditos_calculado numeric(18,2),
  total_debitos_calculado  numeric(18,2),
  filas_leidas        integer not null default 0,
  filas_aceptadas     integer not null default 0,
  verificacion_estado text not null,
  -- Los códigos de diferencia y las filas donde se rompió la cadena de saldos. Códigos y números de
  -- fila: ninguna diferencia lleva un VALOR, para que el diagnóstico no sea el canal de fuga.
  verificacion_detalle jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),

  constraint lote_cuenta_periodo_chk check (periodo_hasta >= periodo_desde),
  constraint lote_cuenta_moneda_chk check (moneda ~ '^[A-Z]{3}$'),
  constraint lote_cuenta_verif_chk
    check (verificacion_estado in ('cuadra', 'no_cuadra', 'no_verificable')),
  constraint lote_cuenta_conteos_chk
    check (filas_leidas >= 0 and filas_aceptadas >= 0 and filas_aceptadas <= filas_leidas),

  -- La cuenta aparece una sola vez por lote.
  constraint uq_lote_cuenta_natural unique (cliente_id, lote_ingesta_id, cuenta_bancaria_id),
  constraint uq_lote_cuenta_tenant unique (cliente_id, id),

  constraint fk_lote_cuenta_lote
    foreign key (cliente_id, lote_ingesta_id)
    references lote_ingesta (cliente_id, id)
    on delete restrict,
  constraint fk_lote_cuenta_cuenta
    foreign key (cliente_id, cuenta_bancaria_id)
    references cuenta_bancaria (cliente_id, id)
    on delete restrict
);

create index idx_lote_cuenta_cliente on lote_ingesta_cuenta(cliente_id);
create index idx_lote_cuenta_lote on lote_ingesta_cuenta(cliente_id, lote_ingesta_id);

create trigger trg_lote_cuenta_cliente
  before insert or update of cliente_id on lote_ingesta_cuenta
  for each row execute function app.exigir_nodo_cliente();

alter table lote_ingesta_cuenta enable row level security;
alter table lote_ingesta_cuenta force  row level security;

create policy lote_cuenta_sel on lote_ingesta_cuenta for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

create policy lote_cuenta_wr on lote_ingesta_cuenta for all
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

grant select, insert, update on lote_ingesta_cuenta to app_request;

-- -----------------------------------------------------------------------------
-- 6. `movimiento_bancario_crudo` — el movimiento normalizado (N2)
-- -----------------------------------------------------------------------------
--
-- Es donde trabaja el contador, así que **no** puede estar bajo régimen auditado por fila: el dato crudo
-- que lo obligaría a estarlo vive en la satélite de abajo (enmienda 1).
--
-- `importe` es SIGNADO en `numeric(18,2)`: negativo = débito. Nunca un float — un float no puede
-- representar 0,01 y la cadena de saldos deja de cerrar por acumulación de error, que es exactamente la
-- señal que este módulo usa para detectar un parseo mal hecho.
create table movimiento_bancario_crudo (
  id                 uuid primary key default gen_random_uuid(),
  cliente_id         uuid not null references tenant_node(id) on delete restrict,
  lote_ingesta_id    uuid not null,
  cuenta_bancaria_id uuid not null,
  fila_numero        integer not null,
  -- Dedupe dentro de la cuenta. El material del hash NO incluye la denominación de la cuenta ni el
  -- nombre del cliente: incluirlos haría que el mismo movimiento cambie de hash al renombrar la cuenta.
  fila_hash          text not null,
  fecha              date not null,
  fecha_valor        date,
  descripcion        text not null,
  importe            numeric(18,2) not null,
  saldo              numeric(18,2),
  -- Un banco del roster publica el saldo como acreedor sin signo: sin esta marca, la cadena de saldos se
  -- interpreta al revés y el error es silencioso.
  saldo_es_acreedor  boolean,
  moneda             char(3) not null default 'ARS',
  -- Código de concepto que publica el banco, cuando lo publica. Es lo que permite clasificar por código
  -- en vez de por texto libre de la glosa (tres de las catorce reglas de la contadora producen un
  -- asiento incorrecto justamente por matchear texto libre).
  concepto_codigo    text,
  referencia_externa text,
  created_at         timestamptz not null default now(),

  constraint mov_crudo_moneda_chk check (moneda ~ '^[A-Z]{3}$'),
  constraint mov_crudo_fila_chk check (fila_numero > 0),
  -- Enmienda 4: la unicidad lleva la cuenta. Con dos cuentas en el mismo archivo,
  -- `(cliente_id, fila_hash)` rechazaría filas legítimas.
  constraint uq_mov_crudo_fila unique (cliente_id, cuenta_bancaria_id, fila_hash),
  constraint uq_mov_crudo_tenant unique (cliente_id, id),

  -- Enmienda 3: la FK de TRES columnas. Vuelve imposible que un movimiento apunte a una cuenta que no
  -- fue detectada en ese lote, de ese cliente — incluso con BYPASSRLS, con COPY o con un bug de la app.
  constraint fk_mov_crudo_lote_cuenta
    foreign key (cliente_id, lote_ingesta_id, cuenta_bancaria_id)
    references lote_ingesta_cuenta (cliente_id, lote_ingesta_id, cuenta_bancaria_id)
    on delete restrict
);

create index idx_mov_crudo_cliente on movimiento_bancario_crudo(cliente_id);
create index idx_mov_crudo_cliente_fecha on movimiento_bancario_crudo(cliente_id, fecha);
create index idx_mov_crudo_lote on movimiento_bancario_crudo(cliente_id, lote_ingesta_id);
create index idx_mov_crudo_cuenta_fecha
  on movimiento_bancario_crudo(cliente_id, cuenta_bancaria_id, fecha);

create trigger trg_mov_crudo_cliente
  before insert or update of cliente_id on movimiento_bancario_crudo
  for each row execute function app.exigir_nodo_cliente();

alter table movimiento_bancario_crudo enable row level security;
alter table movimiento_bancario_crudo force  row level security;

create policy mov_crudo_sel on movimiento_bancario_crudo for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

create policy mov_crudo_wr on movimiento_bancario_crudo for all
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

grant select, insert, update, delete on movimiento_bancario_crudo to app_request;

-- -----------------------------------------------------------------------------
-- 7. `movimiento_origen_crudo` — la fila tal como vino (N2R, satélite)
-- -----------------------------------------------------------------------------
--
-- Enmienda 1. Acá vive `fila_origen`: el dato de origen **no se altera nunca** (ADR-0000), porque es lo
-- único que permite reinterpretar un lote cuando se descubre que el adapter leyó mal una columna.
--
-- Y es N2R porque contiene los datos de los terceros de la contraparte —113 CUIT en un solo archivo del
-- piloto—, que son personas que no son clientes del estudio y que nunca consintieron nada.
create table movimiento_origen_crudo (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references tenant_node(id) on delete restrict,
  movimiento_id uuid not null,
  -- La fila cruda, sin interpretar. N2R.
  fila_origen   jsonb not null,
  created_at    timestamptz not null default now(),

  constraint uq_mov_origen_movimiento unique (cliente_id, movimiento_id),
  constraint uq_mov_origen_tenant unique (cliente_id, id),

  constraint fk_mov_origen_movimiento
    foreign key (cliente_id, movimiento_id)
    references movimiento_bancario_crudo (cliente_id, id)
    on delete restrict
);

create index idx_mov_origen_cliente on movimiento_origen_crudo(cliente_id);

create trigger trg_mov_origen_cliente
  before insert or update of cliente_id on movimiento_origen_crudo
  for each row execute function app.exigir_nodo_cliente();

alter table movimiento_origen_crudo enable row level security;
alter table movimiento_origen_crudo force  row level security;

-- (8) N2R: rol en LECTURA. El `administrativo` que ingesta el archivo no puede volver a leer las filas
-- crudas después: es el escenario H-8 (bajarse la cartera antes de irse) sin necesidad de descargar
-- ningún PDF.
create policy mov_origen_sel on movimiento_origen_crudo for select
  using ( cliente_id in (select app.accessible_tenant_ids())
          and app.has_role_on(cliente_id, array['socio','contador','auditor']::app.rol_membership[]) );

-- Ver la nota sobre la trampa de `for all` más arriba: acá es EL caso. El administrativo tiene que poder
-- insertar (ingestar es su trabajo) y no tiene que poder leer. Con `for all` habría podido leer, y de
-- hecho pudo hasta que el test lo mostró.
create policy mov_origen_ins on movimiento_origen_crudo for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE para nadie: el dato de origen NO se altera (ADR-0000). Es lo único que permite
-- reinterpretar un lote cuando se descubre que el adapter leyó mal una columna.

grant select, insert on movimiento_origen_crudo to app_request;

comment on table movimiento_origen_crudo is
  'Satélite N2R de movimiento_bancario_crudo. Existe para que leer movimientos NO obligue a auditar cada '
  'fila: auditar 326 filas por pantalla destruye la capacidad de detectar el acceso masivo real.';

commit;
