-- =============================================================================
-- 0010_dominios_cerrados_comentados.sql — la afirmación deja de ser una promesa
--
-- ## Qué encontró la auditoría
--
-- El repo tiene **diez `check` de dominio cerrado** cuya lista de valores está duplicada a mano en
-- una constante de TypeScript. Las listas coincidían, pero **solo una tenía test** (el de
-- `acceso_auditoria.accion`, migración 0004). Y tres lugares afirmaban **por escrito** que el test
-- existía para los suyos, cuando no existía:
--
--   * `0007_concepto_banco.sql` (§5)  — *"hay test de catálogo que las compara"*
--   * `0008_anexos.sql` (dominios cerrados) — *"Hay test de catálogo."*
--   * `packages/ingesta/src/esquema.ts` (`ESTRATEGIAS_CONCEPTO`) — idem
--
-- El único honesto era `0006_ajustes_cuenta.sql`: *"Este check necesita el mismo test"*. Tenía razón,
-- y a partir de ahora esa frase está **saldada**: el test existe y cubre los diez checks.
--
-- Una afirmación falsa sobre un control es peor que la ausencia del control, porque desactiva la
-- pregunta. Nadie vuelve a mirar un check del que ya leyó que está testeado.
--
-- ## Por qué la corrección viene en una migración NUEVA y no editando aquellas
--
-- El aplicador (`packages/data/scripts/migrar.ts`) guarda el **sha256 del archivo** y aborta si una
-- migración ya aplicada cambió, aunque el cambio sea un comentario `--`. Editar 0006, 0007 u 0008
-- para arreglar su prosa dejaría a toda base ya migrada sin poder correr `pnpm db:migrate`. Así que
-- la corrección va donde sí se puede escribir **y donde además es consultable**: en el comentario
-- del propio constraint, que vive en `pg_description` y se lee con `\d+` o con una consulta.
--
-- Efecto secundario buscado: la frase de 0007 y la de 0008 —*"hay test de catálogo"*— pasan a ser
-- **verdaderas** sin tocar el archivo, porque el test existe. La única que queda desactualizada es la
-- de 0006 (*"necesita el mismo test"*), y este archivo es su retractación.
--
-- ## Y el comentario no es decorativo: está verificado
--
-- El test parametrizado de `packages/data/tests/catalogo.test.ts` exige que el comentario de cada uno
-- de estos checks **nombre a la constante de TypeScript** contra la que se compara. Es la respuesta
-- directa al hallazgo: si la documentación puede mentir, se la pone bajo el mismo gate que el código.
--
-- ⚠️ Este archivo NO cambia ni una regla: solo `comment on constraint`. Reemplaza el comentario que
--    0004 y 0006 ya habían puesto sobre dos de estos checks, con el mismo contenido más la referencia
--    al test.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0002 — credenciales
-- -----------------------------------------------------------------------------
comment on constraint credencial_fiscal_ambiente_chk on credencial_fiscal is
  'Dominio cerrado. Lista IDÉNTICA a AMBIENTES_CREDENCIAL (packages/data/src/credenciales.ts). '
  'Comparada como conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

-- -----------------------------------------------------------------------------
-- 0004 — auditoría e ingesta
-- -----------------------------------------------------------------------------
comment on constraint acceso_auditoria_accion_chk on acceso_auditoria is
  'Dominio cerrado. Lista IDÉNTICA a ACCIONES (packages/data/src/db/auditoria.ts). La primera '
  'versión de este check omitía uso_credencial, que ACCIONES sí emite: todo registro de uso de una '
  'credencial fiscal habría fallado en el insert. Comparada como conjunto contra pg_constraint por '
  'el test de catálogo de dominios cerrados.';

comment on constraint lote_ingesta_estado_chk on lote_ingesta is
  'Dominio cerrado. Lista IDÉNTICA a ESTADOS_LOTE (packages/ingesta/src/esquema.ts), que se compone '
  'de ESTADOS_LOTE_PERSISTIDO más recibido y con_errores. `rechazado` NO es uno de ellos: un lote '
  'rechazado queda con_errores con su motivo_codigo. Comparada como conjunto contra pg_constraint '
  'por el test de catálogo de dominios cerrados.';

comment on constraint lote_ingesta_origen_chk on lote_ingesta is
  'Dominio cerrado. Lista IDÉNTICA a ORIGENES_LOTE (packages/ingesta/src/esquema.ts). Hoy el único '
  'emisor es el CLI y siempre escribe archivo. Comparada como conjunto contra pg_constraint por el '
  'test de catálogo de dominios cerrados.';

comment on constraint lote_cuenta_verif_chk on lote_ingesta_cuenta is
  'Dominio cerrado. Lista IDÉNTICA a ESTADOS_VERIFICACION (packages/ingesta/src/esquema.ts). Es el '
  'tri-estado: un booleano en false no distingue "no cuadra" de "no se pudo verificar". Comparada '
  'como conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

-- -----------------------------------------------------------------------------
-- 0006 — tipo de cuenta. Acá está la retractación del "necesita el mismo test"
-- -----------------------------------------------------------------------------
--
-- 0006 fue el único honesto: dijo que el test faltaba. Ya no falta, y este check es el que MÁS lo
-- necesitaba, porque su lista está copiada a mano en DOS lugares de TypeScript, no en uno:
-- TIPOS_CUENTA (el dominio) y TIPOS_CUENTA_ALTA (lo que acepta el alta de cuenta). No se pueden
-- derivar una de otra sin crear el ciclo de paquetes data → ingesta, que está prohibido y verificado.
-- El test compara LAS DOS contra este check: si las dos tienen que ser iguales al check, son iguales
-- entre sí, y la base queda de árbitro.
comment on constraint cuenta_ident_tipo_chk on cuenta_bancaria_identificador is
  'Dominio cerrado. Lista IDÉNTICA a TIPOS_CUENTA (packages/ingesta/src/esquema.ts) Y a '
  'TIPOS_CUENTA_ALTA (packages/data/src/ingesta/escrituras.ts): este check es el árbitro entre las '
  'dos copias, que no pueden derivarse una de otra sin el ciclo data -> ingesta. El tipo decide si '
  'el descubierto es posible y si el saldo va a Banco o a Inversiones. Comparada como conjunto '
  'contra pg_constraint por el test de catálogo de dominios cerrados.';

-- -----------------------------------------------------------------------------
-- 0007 — estrategia del concepto
-- -----------------------------------------------------------------------------
comment on constraint mov_crudo_concepto_estrategia_chk on movimiento_bancario_crudo is
  'Dominio cerrado. Lista IDÉNTICA a ESTRATEGIAS_CONCEPTO (packages/ingesta/src/esquema.ts). Hace '
  'auditable EN LOS DATOS de dónde salió el corte del concepto. Comparada como conjunto contra '
  'pg_constraint por el test de catálogo de dominios cerrados.';

-- -----------------------------------------------------------------------------
-- 0008 — anexos
-- -----------------------------------------------------------------------------
comment on constraint anexo_atribucion_chk on anexo_extracto is
  'Dominio cerrado. Lista IDÉNTICA a ATRIBUCIONES_ANEXO (packages/ingesta/src/esquema.ts). La '
  'atribución NO es posicional en ninguno de los tres bancos medidos: se declara. Comparada como '
  'conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

comment on constraint anexo_periodo_dato_chk on anexo_extracto is
  'Dominio cerrado. Lista IDÉNTICA a PERIODOS_ANEXO (packages/ingesta/src/esquema.ts). Cuatro '
  'situaciones MEDIDAS, no dos: el sistema nunca rellena el período del anexo con el del extracto. '
  'Comparada como conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

comment on constraint anexo_relacion_chk on anexo_extracto is
  'Dominio cerrado. Lista IDÉNTICA a RELACIONES_ANEXO (packages/ingesta/src/esquema.ts). Es lo que '
  'convierte el invariante del doble conteo (INV-15) en una condición sobre una columna. Comparada '
  'como conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

commit;
