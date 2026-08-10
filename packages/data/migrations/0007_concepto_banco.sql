-- =============================================================================
-- 0007_concepto_banco.sql — E4 acotado: lo que es REPROCESO IRRECUPERABLE si se agrega después
--
-- ## Por qué ahora y no en la migración siguiente
--
-- El ancho de la columna, el corte entre "concepto del banco" y "contraparte", y la página
-- de la que salió cada fila son **hechos del parseo**, y no están guardados en ningún lado:
-- `movimiento_origen_crudo.fila_origen` guarda las LÍNEAS (`lineas`, `glosaOriginal`), no la
-- GEOMETRÍA. En Galicia el concepto se trunca a 27 caracteres y **sigue en la línea
-- siguiente**, que es también donde vive la contraparte (`docs/diseno/02-formato-galicia.md`
-- §8): sin la geometría, separar una cosa de la otra ya no se puede.
--
-- Y para el cliente de mayor volumen **puede no haber archivo al que volver: entrega en
-- papel** (`docs/analisis/00-cliente-piloto-laura.md` §3.3).
--
-- ## Por qué esta tabla NO pasa al régimen de lectura auditada
--
-- `concepto_banco` se clasifica **N2, no N2-R**, y el check de prefijo del punto 5 es lo que
-- lo vuelve cierto **por construcción y no por convención** (INV-14). El riesgo es real y
-- está medido: en Macro, `TPUSH <nombre>` (569) + `TRANSF <nombre>` (409) son el **73 % del
-- archivo**, y el vocabulario trae el sufijo `DOC<###########>` que es el **documento de la
-- contraparte** (`docs/diseno/07-formato-macro.md` §12).
--
-- Si `concepto_banco` fuera N2-R, `tablasQueExigenRolEnLectura()` sumaría esta tabla sola y
-- tres tests de catálogo se pondrían rojos: haría falta `has_role_on` en `mov_crudo_sel`,
-- habría que partir `mov_crudo_wr` (hoy `for all`) y habría que declarar un lector auditado.
-- O sea: **auditar cada pantalla de movimientos** — el ruido que destruye la capacidad de
-- detectar el acceso masivo real (ADR-0002 H-8), que es exactamente para lo que existe la
-- satélite `movimiento_origen_crudo`.
--
-- ## Los cuatro renglones extra de 0002 NO aplican
--
-- Aplican a tablas con columnas N2-R/N3, y acá no se agrega ninguna. `unique (cliente_id,
-- id)` y la FK compuesta ya están desde 0004.
--
-- ⚠️ El `grant` de `app_request` sobre esta tabla es **a nivel de TABLA**, así que toda
-- columna nueva queda otorgada sola. Lo único que se interpone entre una columna nueva y
-- `app_request` es **su clasificación y su policy**. Por eso la decisión de nivel de arriba
-- es carga estructural y no una etiqueta.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `concepto_banco` (N2) — la clave de entrada al léxico del Módulo 2
-- -----------------------------------------------------------------------------
--
-- El esquema Zod ya lo tenía y la base NO: solo había `descripcion` y `concepto_codigo`.
-- Nullable a propósito: un banco puede no publicar concepto, y esa ausencia se **representa**,
-- no se rellena. Qué clase de ausencia es lo dice `concepto_banco_estrategia`.
alter table movimiento_bancario_crudo
  add column concepto_banco text;

comment on column movimiento_bancario_crudo.concepto_banco is
  'N2. El literal de concepto del banco, cortado de la MISMA glosa ya depurada que produce '
  '`descripcion` (ver mov_crudo_concepto_prefijo_chk). NO es N1: en Macro el 73 % del archivo '
  'son `TPUSH <nombre>` / `TRANSF <nombre>` y el vocabulario trae sufijos `DOC<11 dígitos>`. '
  'NO entra en el material de `fila_hash`: es un producto del parseo (ver hash.ts).';

-- -----------------------------------------------------------------------------
-- 2. `concepto_completo` (N1) — el ancho de la columna, que no es reconstruible
-- -----------------------------------------------------------------------------
--
-- `ACREDITAMIENTO` de Galicia son **78 movimientos** —el concepto más frecuente del
-- extracto— y con 14 caracteres no se puede saber si está completo o si es el prefijo de
-- algo más largo. El corte NO es por cantidad de caracteres (la fuente del PDF es
-- proporcional): es **geométrico**, y la geometría no se persiste.
--
-- SIN DEFAULT, y es deliberado: `true` por default haría indistinguible "el concepto entró
-- entero" de "nadie lo miró". Es el mismo modo de falla que el tri-estado de
-- `verificacion_estado` cierra en este módulo (`no_verificable` ≠ `cuadra`).
alter table movimiento_bancario_crudo
  add column concepto_completo boolean;

comment on column movimiento_bancario_crudo.concepto_completo is
  'N1. Hecho del PARSEO, no del valor: si el concepto entró entero o lo cortó el ancho de la '
  'columna. Es una propiedad del layout del banco, la misma para todos sus clientes — misma '
  'familia que `saldo_es_acreedor`. Tiene que ser N1 para que "el adaptador está truncando '
  'todo" se pueda diagnosticar por log y por métrica sin auditar una lectura.';

-- -----------------------------------------------------------------------------
-- 3. `concepto_banco_estrategia` (N1) — de dónde salió el corte
-- -----------------------------------------------------------------------------
--
-- Vuelve auditable **en los datos** de dónde vino cada concepto, y hace honesto el backfill:
-- sin esta columna, después de 0007 nadie puede distinguir tres cosas que el Módulo 2
-- contaría igual al armar el léxico —"esta fila es anterior a 0007", "el banco no publica
-- concepto para esta fila", y "vino de una columna propia del Excel"—.
--
-- ⚠️ EL BACKFILL VA POR `DEFAULT` Y NO POR `UPDATE`, Y NO ES ESTILO:
-- esta tabla tiene `force row level security`, que le aplica las políticas **también al dueño
-- del esquema** (ADR-0002 §C.0.bis: por eso el dueño no puede sembrar el nodo raíz). Un
-- `update movimiento_bancario_crudo set …` acá lo filtra `mov_crudo_wr` —que exige
-- `accessible_tenant_ids()` y rol— y afecta **0 filas, sin error**. `ALTER TABLE … ADD COLUMN
-- … DEFAULT` es DDL: no pasa por las policies.
alter table movimiento_bancario_crudo
  add column concepto_banco_estrategia text not null default 'no_capturado';

-- El default existió SOLO para poblar las filas ya cargadas. Se quita en el acto: si queda,
-- "el adaptador no declaró nada" y "esta fila es vieja" vuelven a ser indistinguibles, que es
-- justo lo que esta columna existe para evitar. Quitarlo obliga a que `persistir.ts` lo
-- declare en cada insert — la rotura es en compilación y en el primer test, que es donde
-- tiene que estar.
alter table movimiento_bancario_crudo
  alter column concepto_banco_estrategia drop default;

comment on column movimiento_bancario_crudo.concepto_banco_estrategia is
  'N1. Unión cerrada: de dónde salió el corte de `concepto_banco` (INV-14). `no_capturado` es '
  'el valor del backfill de 0007 y ningún adaptador lo emite.';

-- -----------------------------------------------------------------------------
-- 4. `pagina_pdf` (N1) — el puntero de evidencia, y el renglón más barato de la lista
-- -----------------------------------------------------------------------------
--
-- Estaba en el esquema Zod, lo usa la verificación para localizar una ruptura… y **no se
-- persistía**: el insert de `persistir.ts` no lo llevaba y `fila_origen` tampoco. O sea que
-- de un movimiento guardado no se puede volver a la página del documento del que salió.
--
-- Es un hecho de la extracción, no se deriva de nada guardado, y es lo que le da al asiento
-- propuesto un puntero verificable a su evidencia — que es la diferencia entre "el sistema
-- dice esto" y "el sistema dice esto, y acá está de dónde lo sacó".
--
-- Nullable: las filas ya cargadas no lo tienen y **no se puede recalcular sin reprocesar**.
alter table movimiento_bancario_crudo
  add column pagina_pdf integer;

alter table movimiento_bancario_crudo
  add constraint mov_crudo_pagina_pdf_chk
  check (pagina_pdf is null or pagina_pdf > 0);

comment on column movimiento_bancario_crudo.pagina_pdf is
  'N1. Página del documento de la que salió la fila. Hecho de la extracción: no se deriva de '
  'nada guardado. Es el puntero de evidencia del asiento propuesto.';

-- -----------------------------------------------------------------------------
-- 5. Los checks. El de prefijo es el que sostiene el nivel N2.
-- -----------------------------------------------------------------------------

-- La lista tiene que ser IDÉNTICA a `ESTRATEGIAS_CONCEPTO` de `packages/ingesta/src/esquema.ts`.
-- Dos listas del mismo dominio en dos lenguajes ya divergieron dos veces en este repo
-- (`acceso_auditoria.accion` y `tipo_cuenta`): hay test de catálogo que las compara.
alter table movimiento_bancario_crudo
  add constraint mov_crudo_concepto_estrategia_chk
  check (concepto_banco_estrategia in
         ('no_capturado', 'no_publicado', 'columna_propia', 'prefijo_anclado',
          'segmento_de_glosa'));

-- Coherencia ausencia/presencia: hay concepto si y solo si la estrategia dice que se capturó.
alter table movimiento_bancario_crudo
  add constraint mov_crudo_concepto_coherencia_chk
  check ((concepto_banco is null)
         = (concepto_banco_estrategia in ('no_capturado', 'no_publicado')));

-- `concepto_completo` es un hecho SOBRE el concepto: sin concepto no tiene sujeto, y con
-- concepto es obligatorio. `true` por omisión sería una afirmación que nadie hizo.
alter table movimiento_bancario_crudo
  add constraint mov_crudo_concepto_completo_chk
  check ((concepto_banco is null) = (concepto_completo is null));

-- Cadena vacía ≠ null. "No hay concepto" y "el concepto vino vacío" son hechos distintos, y
-- el léxico del Módulo 2 los cuenta distinto.
alter table movimiento_bancario_crudo
  add constraint mov_crudo_concepto_no_vacio_chk
  check (concepto_banco is null or btrim(concepto_banco) <> '');

-- 🔴 EL CHECK QUE SOSTIENE QUE `concepto_banco` SEA N2 Y NO N2-R (INV-14).
--
-- `concepto_banco` tiene que ser **prefijo literal de `descripcion`**, que ya pasó por
-- `depurarGlosa` (INV-13). Con esto es **imposible** guardar en `concepto_banco` algo que no
-- esté ya en `descripcion`: todo identificador que INV-13 sacó, acá ya está sacado. La
-- garantía se **hereda**, no se vuelve a prometer.
--
-- Es una defensa estructural, no una convención: sobrevive a `BYPASSRLS`, a un `COPY` y a un
-- bug de la aplicación — las tres cosas contra las que una policy no sirve.
--
-- `columna_propia` queda exenta porque viene de OTRO artefacto (el `.xls` de Santander trae
-- `Cod. Operativo` + `Concepto` en celdas propias) y no es prefijo de la glosa del PDF. Es el
-- único punto donde la garantía es de test y no de base, y queda declarado acá para que nadie
-- lo descubra después.
--
-- Si este check dispara al correr un adaptador, la respuesta es **arreglar el adaptador**, no
-- aflojar el check: que dispare significa que `concepto_banco` se construyó de un texto
-- distinto del depurado, que es exactamente el bug que este renglón existe para atrapar.
alter table movimiento_bancario_crudo
  add constraint mov_crudo_concepto_prefijo_chk
  check (concepto_banco is null
         or concepto_banco_estrategia = 'columna_propia'
         or starts_with(descripcion, concepto_banco));

comment on constraint mov_crudo_concepto_prefijo_chk on movimiento_bancario_crudo is
  'INV-14. `concepto_banco` sale de la glosa YA DEPURADA: al exigirlo prefijo de `descripcion` '
  'hereda la garantía de INV-13 y no puede contener el identificador de un tercero. Es lo que '
  'mantiene la columna en N2 y la tabla fuera del régimen de lectura auditada.';

commit;
