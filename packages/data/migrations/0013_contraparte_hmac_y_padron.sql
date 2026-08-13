-- =============================================================================
-- 0013_contraparte_hmac_y_padron.sql — los candidatos de contraparte de cada movimiento,
-- y el padrón de socios contra el cual el motor los resuelve
--
-- ## Qué habilita, y por qué es la única pieza del Módulo 2 que no se puede postergar
--
-- El motor del Módulo 2 tiene que distinguir "transferencia a un TERCERO" de "transferencia a
-- un SOCIO" — es la diferencia entre Proveedores y Cuenta Particular, y es la decisión que hoy
-- deja 978 movimientos de un solo banco (72,7 % de ese archivo) en `decision_humana`.
--
-- Para decidirlo hace falta comparar el identificador que viene en la glosa contra un padrón. El
-- identificador está en `movimiento_origen_crudo.fila_origen`, que es N2-R: leerlo cuesta un
-- evento de auditoría por lote. Capturar el candidato en el momento de la ingesta —cuando el
-- valor ya está en memoria— cuesta CERO lecturas nuevas. Cada día sin esta migración es otro día
-- de movimientos ingeridos cuyo candidato solo se puede recuperar volviendo a leer N2-R.
--
-- ## Las cuatro decisiones de forma, con su motivo
--
--   1. NO hay `contraparte_cbu_hmac`/`contraparte_documento_hmac` en el movimiento. Columnas
--      singulares hornean en la INGESTA una regla de negocio que todavía no existe: cuál de los
--      N identificadores de una glosa es la contraparte. El día que esa regla cambie habría que
--      volver a leer N2-R — reproduciendo el problema que esta migración existe para cerrar de
--      una vez. Van todos los candidatos a una satélite 0..N, y elegir es del motor (capa C),
--      código puro y testeado.
--
--   2. El padrón se parte en dos tablas, con el mismo patrón que
--      `movimiento_bancario_crudo`/`movimiento_origen_crudo`: `padron_socio` (N2, lo que el motor
--      consulta en CADA pasada, sin rol ni auditoría) y `padron_socio_documento` (N2-R, el
--      documento en claro, que se lee solo cuando una persona necesita verificar lo que cargó).
--      Sin el documento en claro en algún lado, el pepper de esta tabla no se puede rotar nunca.
--
--   3. El pepper de `movimiento_contraparte_identificador.identificador_hmac` y de `padron_socio.documento_hmac`
--      se deriva POR CLIENTE (`HKDF(pepper_global, cliente_id)`, en TypeScript —
--      `packages/shared/src/seguridad/hmac-identificador.ts`). Decisión de negocio: sin esto, un
--      `socio` con membership en varios clientes del estudio podría, comparando digests, notar
--      que dos clientes sin relación comparten una contraparte — minería de datos cruzada entre
--      clientes, sin ver un solo CUIT en claro. Este DDL no calcula el HKDF (vive en TS); lo que
--      sí verifica es la contracara: NINGUNA unicidad, índice o FK de acá compara un `hmac` entre
--      `cliente_id` distintos. Todas las claves arrancan con `cliente_id`.
--
--   4. `clase` es `('cuit', 'dni', 'cbu')` — TRES valores, no cuatro. `packages/ingesta/src/glosa.ts`
--      (`PATRONES`) nunca produce una etiqueta `'cuil'`: el CUIT y el CUIL son el mismo número
--      (`RE_CUIT` es un solo patrón para los dos) y la extracción los junta en el bucket `cuit`.
--      Un valor que ningún camino puede producir es una mentira en el esquema. `padron_socio.
--      documento_tipo` SÍ admite `'cuit'|'cuil'` como ETIQUETA (lo que la contadora tipeó), pero
--      el hash de los dos canoniza al mismo dominio (`hmacDocumento`, ver su comentario) — así un
--      socio cargado como CUIL matchea un candidato que el banco publicó y que la extracción
--      etiquetó `cuit`.
--
-- ## Los cuatro renglones extra de 0002 aplican SOLO a `padron_socio_documento`
--
-- Es la única tabla de esta migración con una columna N2-R. `movimiento_contraparte_identificador`
-- y `padron_socio` no tienen ninguna: es lo que mantiene el listado de movimientos y la pasada del
-- motor fuera del régimen auditado. Auditar cada pasada del motor sería el mismo ruido que la
-- enmienda 1 de 0004 existe para evitar (ADR-0002 H-8).
--
-- ⚠️ `padron_socio_documento` exige, en la MISMA tarea, su entrada en `LECTORES_AUDITADOS`
--    (`packages/data/src/db/lectores-auditados.ts`). Sin ella `tablasSinLectorAuditado()` deja de
--    estar vacía y el gate se pone rojo.
--
-- ⚠️ `contraparte_captura` se agrega `not null` y SIN default final (mismo procedimiento que 0007):
--    el insert de `packages/ingesta/src/persistir.ts` deja de funcionar hasta que lo declare. Esta
--    migración y ese cambio de código se aplican juntos, nunca por separado.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `movimiento_bancario_crudo.contraparte_captura` (N1) — el centinela
-- -----------------------------------------------------------------------------
--
-- Liviana a propósito: no identifica a nadie, solo dice si el candidato de contraparte de esa
-- fila se buscó y qué pasó. Misma familia que `concepto_banco_estrategia` de 0007.
--
-- Cuatro valores, no tres: `capturado_cuenta_propia` existe porque un candidato CBU que resulta
-- ser una cuenta DEL PROPIO cliente (transferencia entre cuentas propias, regla 10 de la
-- contadora) no se persiste como candidato de contraparte — sería un tercero que no es. Sin este
-- cuarto valor, esa fila se vería idéntica a "no había ningún identificador", y la regla 10 no
-- tendría de dónde salir sin comparar HMAC entre el espacio derivado (esta migración) y el global
-- (`cuenta_bancaria_identificador.cbu_hmac`) en tiempo de ejecución del motor — exactamente la
-- comparación cross-pepper que la derivación por cliente existe para no tener que hacer ahí.
--
-- ⚠️ EL BACKFILL VA POR `DEFAULT` Y NO POR `UPDATE`: esta tabla tiene `force row level security`,
-- que aplica las policies TAMBIÉN al dueño del esquema (ADR-0002 §C.0.bis). Un
-- `update movimiento_bancario_crudo set …` acá lo filtra `mov_crudo_wr` —que exige rol— y afecta
-- 0 filas, sin error. `alter table … add column … default` es DDL: no pasa por las policies.
alter table movimiento_bancario_crudo
  add column contraparte_captura text not null default 'no_capturado';

-- El default existió SOLO para poblar las filas ya cargadas. Se quita en el acto: si queda, "el
-- adaptador no declaró nada" y "esta fila es vieja" vuelven a ser indistinguibles.
alter table movimiento_bancario_crudo
  alter column contraparte_captura drop default;

alter table movimiento_bancario_crudo
  add constraint mov_crudo_contraparte_captura_chk
  check (contraparte_captura in ('no_capturado', 'sin_identificador', 'capturado', 'capturado_cuenta_propia'));

comment on constraint mov_crudo_contraparte_captura_chk on movimiento_bancario_crudo is
  'Dominio cerrado. Lista IDÉNTICA a CAPTURAS_CONTRAPARTE (packages/ingesta/src/esquema.ts). '
  '`no_capturado` es el valor del backfill de 0013 y ningún adaptador lo emite: sin él, "el banco '
  'no publica identificador" y "esta fila es anterior a 0013" se ven iguales para siempre. '
  'Comparada como conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

comment on column movimiento_bancario_crudo.contraparte_captura is
  'N1. Centinela de idempotencia del backfill de contraparte. NO identifica a nadie: es un hecho '
  'sobre el PROCESO, no sobre el valor — misma familia que `concepto_banco_estrategia`. La '
  'coherencia con `movimiento_contraparte_identificador` (`capturado` ⇔ hay al menos un candidato '
  'con el pepper vigente) NO es un constraint de la base: ver la nota del bloque 2.';

-- -----------------------------------------------------------------------------
-- 2. `movimiento_contraparte_identificador` (N2, satélite 0..N por movimiento)
-- -----------------------------------------------------------------------------
--
-- Una glosa puede traer más de un identificador —ordenante y beneficiario en la misma línea es el
-- caso medido— y los dos son candidatos legítimos. La tabla guarda TODOS los que superan el guard
-- de forma y NO son la cuenta propia del cliente; ninguno de ellos está declarado como "la
-- contraparte real" — esa elección es del motor (capa C), no de la ingesta.
--
-- ## Por qué N2 y no N2-R
--
-- El valor guardado es un HMAC con pepper derivado por cliente: irreversible pero comparable —
-- misma propiedad que hace que `fila_hash` sea N2 y no N1. No sube a N2-R porque el motor
-- consulta esta tabla en CADA pasada de clasificación: con N2-R, cada pasada exigiría rol en
-- lectura y lector auditado, y el rastro se llenaría de eventos que no dicen nada — el ruido que
-- destruye la capacidad de detectar el acceso masivo real (ADR-0002 H-8).
--
-- ## Por qué NO hay constraint de coherencia con `contraparte_captura`
--
-- "`capturado` si y solo si existe al menos una fila acá" es un invariante ENTRE TABLAS. Un check
-- no puede llevar subconsulta, y el trigger que lo haría es peor que no tenerlo: corre como el
-- usuario que escribe, y esta tabla tiene `force row level security`, así que lo que el trigger
-- "ve" depende de quién escribe — fail-open y fail-closed en el mismo constraint según el rol. Y
-- hacerlo confiable exigiría `SECURITY DEFINER`, y R11 del catálogo declara que las ÚNICAS dos
-- funciones `SECURITY DEFINER` del sistema son `accessible_tenant_ids` y `has_role_on`. Queda en
-- la aplicación (una sola transacción escribe las dos cosas) y en su test.
create table movimiento_contraparte_identificador (
  -- (1) de la plantilla de ADR-0001 §5.
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references tenant_node(id) on delete restrict,

  movimiento_id uuid not null,

  -- N1. Qué FORMA tiene el identificador candidato. No identifica a nadie: es vocabulario del
  -- producto, y le dice a la capa C con qué comparar (un `cbu` se compara contra las cuentas
  -- propias del cliente en el motor; un `cuit`/`dni`, contra el padrón de socios).
  clase         text not null,

  -- N2. HMAC-SHA256 crudo, 32 bytes, con pepper DERIVADO POR CLIENTE (hmacDocumento). No es el
  -- identificador y no se puede revertir sin el pepper del entorno MÁS el cliente_id. Nunca
  -- hexadecimal: un texto invita a compararlo con `like`, y eso sobre un digest no significa nada.
  identificador_hmac bytea not null,

  -- N1. Versión del pepper GLOBAL del que se derivó el efectivo de esta fila (packages/shared/
  -- src/seguridad/hmac-identificador.ts: pepperIdActual()). Vive por fila —no en el movimiento—
  -- porque cada candidato se puede backfillear o re-derivar por separado, y porque durante una
  -- rotación conviven filas v1 y v2 del mismo movimiento.
  pepper_id     text not null,

  created_at    timestamptz not null default now(),

  -- ---------------------------------------------------------------------------
  -- Dominio cerrado. TRES valores — ver el punto 4 de la cabecera sobre por qué no hay 'cuil'.
  -- ---------------------------------------------------------------------------
  constraint mov_contraparte_clase_chk
    check (clase in ('cuit', 'dni', 'cbu')),

  -- 32 bytes es lo que devuelve sha256 crudo, sin truncar. El check atrapa el modo de falla real
  -- de una columna `bytea`: que alguien guarde el digest en hexadecimal (64 bytes) o un `Buffer`
  -- truncado. Los dos entrarían sin error y NUNCA matchearían — y "no matchea" es indistinguible
  -- de "no es socio", el peor resultado posible de este subsistema.
  constraint mov_contraparte_hmac_largo_chk
    check (octet_length(identificador_hmac) = 32),

  -- Misma forma de versión que `cuenta_ident_pepper_chk` de 0006. Identificador de versión, NUNCA
  -- el pepper ni una parte de él.
  constraint mov_contraparte_pepper_chk
    check (pepper_id ~ '^v[0-9]{1,4}$'),

  -- ---------------------------------------------------------------------------
  -- Unicidad. El orden de columnas NO es cosmético: define el índice, y sirve a las dos únicas
  -- consultas que existen sobre la tabla — el motor (`where cliente_id=$1 and movimiento_id=any($2)
  -- and pepper_id=$3`) y el backfill, cuyo centinela de idempotencia es "¿ya existe con el pepper
  -- OBJETIVO?" y no "¿ya tiene hmac?" (así la misma herramienta sirve para la corrida inicial y
  -- para una rotación futura). `pepper_id` va TERCERO, no último: al final degrada el filtro por
  -- versión a un filtro dentro del índice, el mismo error que 0009 §2 corrigió en
  -- `idx_cuenta_ident_resolucion`. El par `(clase, identificador_hmac)` al final es lo que dedupe.
  -- ---------------------------------------------------------------------------
  constraint uq_mov_contraparte_candidato
    unique (cliente_id, movimiento_id, pepper_id, clase, identificador_hmac),

  -- (10) de la plantilla ampliada.
  constraint uq_mov_contraparte_tenant unique (cliente_id, id),

  -- (11) FK COMPUESTA tenant-consistente. Vuelve imposible que un candidato cuelgue de un
  -- movimiento de OTRO cliente.
  constraint fk_mov_contraparte_movimiento
    foreign key (cliente_id, movimiento_id)
    references movimiento_bancario_crudo (cliente_id, id)
    on delete restrict
);

-- (2) de la plantilla.
create index idx_mov_contraparte_cliente on movimiento_contraparte_identificador(cliente_id);

-- NO se crea un índice `(cliente_id, pepper_id, identificador_hmac)` — el sentido inverso, "qué movimientos
-- mencionan a este tercero". No existe esa consulta hoy: la capa C recibe los candidatos de un
-- movimiento y el padrón completo como parámetros, compara en memoria. Se agrega el día que la
-- consulta exista, con su plan medido.

-- (3) el candidato cuelga de un nodo `cliente`, nunca de un `estudio`.
create trigger trg_mov_contraparte_cliente
  before insert or update of cliente_id on movimiento_contraparte_identificador
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5). El (5) le aplica las políticas también al dueño del esquema.
alter table movimiento_contraparte_identificador enable row level security;
alter table movimiento_contraparte_identificador force  row level security;

-- (6) lectura sin chequeo de rol: no hay ninguna columna N2-R, y el motor la consulta en cada
-- pasada.
create policy mov_contraparte_sel on movimiento_contraparte_identificador for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) escritura declarada POR OPERACIÓN y no con `for all` (0005: las policies permisivas se
-- combinan con OR y `for all` incluye SELECT).
--
-- El `administrativo` PUEDE insertar: el candidato se calcula durante la ingesta, que es su
-- trabajo. Lo que no puede es leer el valor de origen del que salió (`movimiento_origen_crudo`).
create policy mov_contraparte_ins on movimiento_contraparte_identificador for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE para NADIE: un candidato mal calculado no se edita — se vuelve a correr el
-- backfill con el pepper objetivo, y la fila nueva convive con la vieja hasta que la rotación
-- termine.
grant select, insert on movimiento_contraparte_identificador to app_request;

-- app_job no recibe nada: la ingesta y el backfill corren como app_request, bajo `conUsuario`.

comment on table movimiento_contraparte_identificador is
  'Satélite N2 de movimiento_bancario_crudo: 0..N candidatos de identificador de contraparte por '
  'movimiento, en HMAC (pepper derivado por cliente). NINGUNO está declarado como "la contraparte" '
  '— elegir es del motor (capa C, función pura), no de la ingesta.';

comment on constraint mov_contraparte_clase_chk on movimiento_contraparte_identificador is
  'Dominio cerrado. Lista IDÉNTICA a CLASES_IDENTIFICADOR_CONTRAPARTE '
  '(packages/shared/src/seguridad/hmac-identificador.ts). TRES valores, no cuatro: '
  '`packages/ingesta/src/glosa.ts` nunca produce una etiqueta `cuil`, el CUIT y el CUIL son el '
  'mismo número. Comparada como conjunto contra pg_constraint por el test de catálogo de dominios '
  'cerrados.';

comment on column movimiento_contraparte_identificador.identificador_hmac is
  'N2. HMAC-SHA256 (32 bytes crudos) del identificador normalizado a dígitos, con dominio de hash '
  '(cuit_cuil|dni|cbu) y pepper DERIVADO POR CLIENTE (hmacDocumento). N2 y no N1 —a diferencia de '
  '`cuenta_bancaria_identificador.cbu_hmac`— porque es el identificador de un TERCERO: '
  'irreversible pero comparable, la misma propiedad que pone a `fila_hash` en N2. No sube a N2-R '
  'porque el motor lo consulta en cada pasada.';

comment on column movimiento_contraparte_identificador.pepper_id is
  'N1. Versión del pepper GLOBAL con el que se derivó el efectivo de ESTA fila. Vive por fila y no '
  'en el movimiento: cada candidato se re-hashea por separado, y durante una rotación conviven v1 '
  'y v2 del mismo movimiento.';

-- -----------------------------------------------------------------------------
-- 3. `padron_socio` (N2) — contra qué se resuelve un candidato
-- -----------------------------------------------------------------------------
--
-- Lo que el motor lee en cada pasada: no puede tener ni una columna N2-R. El documento en claro
-- vive en la satélite del bloque 4. Misma partición que
-- `movimiento_bancario_crudo`/`movimiento_origen_crudo`.
--
-- ## Vigencia SEMIABIERTA `[vigente_desde, vigente_hasta)`
--
-- Un extracto de hace ocho meses tiene que resolverse con el padrón DE ENTONCES. El filtro del
-- motor es `vigente_desde <= f and (vigente_hasta is null or f < vigente_hasta)`, y el check de
-- abajo es `>` estricto —no `>=` como `cuenta_ident_vigencia_chk` de 0004— porque con `>=` entra
-- `[d, d)`: una fila que existe y que NINGUNA fecha satisface.
create table padron_socio (
  id                 uuid primary key default gen_random_uuid(),
  cliente_id         uuid not null references tenant_node(id) on delete restrict,

  -- N2. Nombre o razón social del socio, como lo escribe la contadora.
  denominacion       text not null,

  -- N1. Unión cerrada de DOS valores. `dni` NO está: un DNI no identifica a un socio ante ningún
  -- organismo — un socio de una sociedad tiene CUIT o CUIL. La satélite del bloque 2 SÍ admite
  -- `dni` porque ahí se guarda lo que el banco escribió, no lo que el estudio decidió.
  documento_tipo     text not null,

  -- N2. HMAC-SHA256 crudo del documento normalizado, con dominio 'cuit_cuil' (hmacDocumento) y
  -- pepper derivado por cliente. Es con lo único que se compara: el documento en claro no entra
  -- en ninguna consulta del motor.
  documento_hmac     bytea not null,

  -- N2 enmascarado: lo que se le muestra a una persona sin exponer el resto.
  documento_ultimos4 char(4) not null,

  -- N1. Versión del pepper GLOBAL. Ver 0006 §3.
  pepper_id          text not null,

  -- N2. Vigencia SEMIABIERTA. Ver la cabecera del bloque.
  vigente_desde      date not null,
  vigente_hasta      date,

  created_at         timestamptz not null default now(),

  constraint padron_socio_documento_tipo_chk
    check (documento_tipo in ('cuit', 'cuil')),

  constraint padron_socio_hmac_largo_chk
    check (octet_length(documento_hmac) = 32),

  constraint padron_socio_ultimos4_chk
    check (documento_ultimos4 ~ '^[0-9]{4}$'),

  constraint padron_socio_pepper_chk
    check (pepper_id ~ '^v[0-9]{1,4}$'),

  -- `>` y no `>=`: ver la cabecera del bloque.
  constraint padron_socio_vigencia_chk
    check (vigente_hasta is null or vigente_hasta > vigente_desde),

  constraint padron_socio_denominacion_no_vacia_chk
    check (btrim(denominacion) <> ''),

  -- ---------------------------------------------------------------------------
  -- 🔴 EL CHECK QUE MANTIENE `denominacion` EN N2 Y A ESTA TABLA FUERA DEL RÉGIMEN AUDITADO.
  --
  -- Mismo mecanismo que `anexo_literal_sin_identificador_chk` de 0008: donde no hay una columna
  -- padre de la cual ser prefijo, la garantía se pone como PUERTA DE ADMISIÓN. Sin este check, el
  -- camino de menor resistencia al cargar un socio ("MARTINEZ SRL 30712345678" en denominación)
  -- deja el documento en claro en una columna N2 que se lee sin rol y sin auditoría, anulando en
  -- silencio la partición del bloque 4.
  --
  -- Siete dígitos es la clase de identificador más corta (`RE_DNI`, 7-8); tapa también CUIT/CUIL
  -- (11) y CBU (22). Estructural: sobrevive a BYPASSRLS, a un COPY y a un bug de la aplicación.
  -- ---------------------------------------------------------------------------
  constraint padron_socio_denominacion_sin_identificador_chk
    check (denominacion !~ '[0-9]{7}'),

  -- ---------------------------------------------------------------------------
  -- Unicidad, en dos piezas, POR CLIENTE las dos. Un `unique` global sobre `documento_hmac` sería
  -- un oráculo cross-tenant (R6) — y sería insatisfacible: con el pepper derivado por cliente el
  -- mismo documento produce digests distintos en cada uno.
  -- ---------------------------------------------------------------------------
  constraint uq_padron_socio_serie
    unique (cliente_id, pepper_id, documento_hmac, vigente_desde),

  -- (10) de la plantilla ampliada. Es el padre de la FK compuesta del bloque 4.
  constraint uq_padron_socio_tenant unique (cliente_id, id)
);

-- 🔴 UNA SOLA VIGENCIA ABIERTA por (cliente, pepper, documento). Impide el modo de falla "ambiguo
-- PERMANENTE" que 0006 §3 describe: dos altas del mismo socio con fechas de inicio distintas
-- dejarían dos filas vigentes, y el motor encontraría dos socios sin poder resolver nunca más,
-- porque nada lo deshace solo. Va como índice único parcial y no como `exclusion constraint`
-- sobre `daterange` porque la parte de igualdad exigiría `btree_gist`, y ADR-0000 §6 prohíbe
-- extensiones no-core.
create unique index uq_padron_socio_vigente
  on padron_socio (cliente_id, pepper_id, documento_hmac)
  where vigente_hasta is null;

comment on index uq_padron_socio_vigente is
  'Una sola vigencia abierta por (cliente, pepper, documento). Impide que un segundo alta del '
  'mismo socio con otra fecha de inicio deje dos filas vigentes: el motor devolvería dos socios y '
  'el movimiento quedaría ambiguo de forma permanente. Mismo modo de falla que 0006 §3 describió y '
  'que 0009 §1 cerró para las cuentas. `pepper_id` va adentro para no bloquear la rotación.';

-- (2) de la plantilla, y además el índice de la consulta real del motor: se trae el padrón
-- COMPLETO de un cliente y se filtra vigencia en memoria (son unidades de filas por cliente, no
-- miles). No hay índice por `documento_hmac` suelto: esa sería la forma de un oráculo.
create index idx_padron_socio_cliente on padron_socio(cliente_id);

create trigger trg_padron_socio_cliente
  before insert or update of cliente_id on padron_socio
  for each row execute function app.exigir_nodo_cliente();

alter table padron_socio enable row level security;
alter table padron_socio force  row level security;

-- (6) lectura sin chequeo de rol: ni una columna N2-R. El motor la consulta en cada pasada.
create policy padron_socio_sel on padron_socio for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) escritura por operación, y SIN `administrativo`. Decidir quién es socio de un cliente es
-- criterio del contador: mal cargado, cambia la imputación de todos los movimientos de esa
-- persona sin que nada falle.
create policy padron_socio_ins on padron_socio for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador']::app.rol_membership[]) );

create policy padron_socio_upd on padron_socio for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador']::app.rol_membership[]) );

-- Sin policy de DELETE: un alta de socio no se borra, se CIERRA (`vigente_hasta`) — borrarla haría
-- que un extracto de hace ocho meses se reinterprete con un padrón que ya no contiene a quien sí
-- era socio. Y de todas formas la FK `on delete restrict` desde `padron_socio_documento` lo hace
-- estructuralmente imposible.
grant select, insert on padron_socio to app_request;

-- 🔴 GRANT DE UPDATE POR COLUMNA. Lo único que se corrige de un socio ya cargado es un error de
-- tipeo en la denominación y el cierre de su vigencia. `documento_hmac`/`documento_tipo`/
-- `pepper_id`/`vigente_desde` son inmutables — no por convención: `padron_socio_documento` es
-- append-only y guarda el documento en claro de ESE alta, así que un UPDATE del hmac lo
-- desincronizaría de su satélite en silencio. Cambiar el documento de un socio es cerrar la
-- vigencia y dar de alta la serie nueva.
grant update (denominacion, vigente_hasta) on padron_socio to app_request;

comment on table padron_socio is
  'Padrón de socios por cliente, con vigencia SEMIABIERTA [desde, hasta). Es contra esto que el '
  'motor decide si una transferencia va a Proveedores o a Cuenta Particular. N2 sin ninguna '
  'columna N2-R a propósito: se consulta en cada pasada del motor, y el documento en claro vive en '
  'la satélite `padron_socio_documento`.';

comment on constraint padron_socio_documento_tipo_chk on padron_socio is
  'Dominio cerrado. Lista IDÉNTICA a TIPOS_DOCUMENTO_SOCIO '
  '(packages/shared/src/seguridad/hmac-identificador.ts). Son DOS valores y `dni` no está: un DNI '
  'no identifica a un socio ante ningún organismo. Comparada como conjunto contra pg_constraint '
  'por el test de catálogo de dominios cerrados.';

comment on constraint padron_socio_denominacion_sin_identificador_chk on padron_socio is
  'Equivalente del check de admisión de 0008, donde no hay una columna padre de la cual ser '
  'prefijo. Ninguna corrida de 7+ dígitos entra en la denominación. Es lo que mantiene '
  '`denominacion` en N2 y a esta tabla fuera del régimen de lectura auditada.';

comment on column padron_socio.vigente_hasta is
  'N2. Vigencia SEMIABIERTA: la fila aplica a `f` cuando `vigente_desde <= f < vigente_hasta`. El '
  'check exige `>` estricto (y no `>=` como 0004) porque `[d, d)` es un intervalo que ninguna '
  'fecha satisface.';

-- -----------------------------------------------------------------------------
-- 4. `padron_socio_documento` (N2-R, satélite) — el documento en claro
-- -----------------------------------------------------------------------------
--
-- Un renglón por alta, inmutable. Existe por dos motivos:
--
--   1. Sin él, el pepper de `padron_socio` no se puede rotar nunca. Recalcular un HMAC exige el
--      valor original, y a diferencia de `cuenta_bancaria_identificador.cbu_hmac` —cuya rotación
--      es perezosa porque el próximo extracto trae el CBU otra vez— acá no hay ninguna fuente que
--      vuelva a traer el documento de un socio.
--   2. La contadora tiene que poder verificar lo que cargó. Con `documento_ultimos4` no alcanza
--      para distinguir un CUIT bien cargado de uno con dos dígitos permutados.
--
-- Régimen: exactamente el de `movimiento_origen_crudo` — rol en LECTURA, escritura POR OPERACIÓN,
-- sin UPDATE ni DELETE, y lector auditado obligatorio en `LECTORES_AUDITADOS`.
create table padron_socio_documento (
  id         uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references tenant_node(id) on delete restrict,

  socio_id   uuid not null,

  -- N2-R. El documento de un tercero, en claro y NORMALIZADO A DÍGITOS (sin separadores) — para
  -- que `hmacDocumento` recalculado desde esta columna reproduzca `padron_socio.documento_hmac`
  -- EXACTAMENTE.
  --
  -- La forma es la de `RE_CUIT` (packages/shared/src/seguridad/detectores-forma.ts): prefijo AFIP
  -- válido (20|23|24|25|26|27|30|33|34) + 8 dígitos + verificador, sin separadores.
  --
  -- ⚠️ El DÍGITO VERIFICADOR (mod 11) NO se valida acá: una migración aplicada no se edita, la
  --    rama `dv = 10` del algoritmo tiene más de una variante en circulación y este repo no
  --    inventa normativa (CLAUDE.md §1.6). El verificador lo valida el alta, en TypeScript.
  documento  text not null,

  created_at timestamptz not null default now(),

  constraint padron_socio_doc_forma_chk
    check (documento ~ '^(20|23|24|25|26|27|30|33|34)[0-9]{9}$'),

  -- UN renglón por alta: si hubiera N, "cuál es el documento de esta serie" sería ambiguo.
  constraint uq_padron_socio_doc_socio unique (cliente_id, socio_id),
  constraint uq_padron_socio_doc_tenant unique (cliente_id, id),

  -- (11) FK COMPUESTA tenant-consistente.
  constraint fk_padron_socio_doc_socio
    foreign key (cliente_id, socio_id)
    references padron_socio (cliente_id, id)
    on delete restrict
);

create index idx_padron_socio_doc_cliente on padron_socio_documento(cliente_id);

create trigger trg_padron_socio_doc_cliente
  before insert or update of cliente_id on padron_socio_documento
  for each row execute function app.exigir_nodo_cliente();

alter table padron_socio_documento enable row level security;
alter table padron_socio_documento force  row level security;

-- (8) N2-R: chequeo de rol también en LECTURA. Misma lista que `cuenta_ident_sel` y
-- `mov_origen_sel` de 0004: el `auditor` entra, el `administrativo` no (escenario H-8).
create policy padron_socio_doc_sel on padron_socio_documento for select
  using ( cliente_id in (select app.accessible_tenant_ids())
          and app.has_role_on(cliente_id, array['socio','contador','auditor']::app.rol_membership[]) );

-- Escritura POR OPERACIÓN, nunca `for all` (0005): acá la lista de escritura y la de lectura son
-- distintas (`auditor` lee y no escribe), así que un `for all` le devolvería la lectura a quien no
-- la tiene.
create policy padron_socio_doc_ins on padron_socio_documento for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE para nadie: es la evidencia de qué documento se cargó en ese alta.

-- (9) El grant por COLUMNA de la plantilla ampliada excluye lo N3, y acá no hay nada N3.
grant select, insert on padron_socio_documento to app_request;

-- app_job no recibe nada.

comment on table padron_socio_documento is
  'Satélite N2-R de padron_socio: el documento del socio en claro, un renglón por alta, '
  'inmutable. Existe para que el pepper se pueda ROTAR y para que una persona pueda verificar lo '
  'que cargó. Se lee con rol y con auditoría, y solo en un acto puntual: el motor NUNCA la '
  'consulta.';

comment on column padron_socio_documento.documento is
  'N2-R. Documento de un tercero, en claro y normalizado a dígitos (sin separadores). La forma es '
  'la de RE_CUIT (packages/shared/src/seguridad/detectores-forma.ts). El dígito verificador NO se '
  'valida en la base a propósito.';

commit;
