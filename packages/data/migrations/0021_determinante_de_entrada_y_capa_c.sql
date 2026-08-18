-- =============================================================================
-- 0021_determinante_de_entrada_y_capa_c.sql — el determinante de idempotencia deja
-- de ignorar la entrada, y capa C queda persistida con su evidencia
--
-- Expediente completo, con las mediciones y los ocho dictámenes:
--   `docs/diseno/11-migracion-0021-determinante-y-capa-c.md`
-- Bitácora: `HANDOFF.md` entrada 69 (P0/P1) y la que cierra esta migración.
--
-- ## Qué habilita, y qué arregla
--
-- `reconocimiento_movimiento.motor_digest` es hoy el determinante entero de la
-- idempotencia, y es `digestDeBanco(lexico) ⊕ VERSION_DEL_MOTOR`: CERO BYTES DE LA FILA
-- DEL CLIENTE. Pero la entrada del motor es MUTABLE — `recapturar-conceptos.ts:349-358`
-- reescribe `concepto_banco`, `concepto_completo` y `concepto_banco_estrategia`, y
-- `backfill-contraparte.ts:303-310` reescribe `contraparte_captura` (y no es de una sola
-- vez: es el mecanismo de re-hasheo cuando rote el pepper global). CUATRO de las cinco
-- columnas mutables son entrada del motor.
--
-- La consecuencia está declarada en `escrituras.ts:298-302`: un reproceso que cambie la
-- entrada sin cambiar la CLASE da no-op, con la interpretación vieja intacta. Fail-open y
-- silencioso.
--
-- 🔴 MEDIDO CONTRA EL CORPUS REAL, antes de escribir una línea de DDL (P0 del plan, sólo
-- lectura sobre el piloto, salida = sólo conteos): sobre 1830 movimientos, 1754 cambian de
-- `entrada_digest` al recapturar y **64 de ellos conservan la MISMA clase**. Esos 64 son
-- exactamente las filas que hoy quedarían con la interpretación vieja y un `no_op`
-- silencioso. La magnitud del bug, en filas, no en argumento.
--
-- Control cruzado que valida el método: los 76 que NO cambian coinciden EXACTO con las 76
-- filas de `concepto_banco_estrategia = 'no_publicado'` contadas por SQL independiente —
-- nunca tuvieron concepto capturado, así que la recaptura no las tocó. Dos caminos, mismo
-- número.
--
-- Y la segunda mitad la exige el propio DDL de 0014. `0014:426-432` declara el límite:
-- «el determinante de capa C incluye el estado del padrón, y ese determinante lo crea
-- 0015». 🔴 ESA `0015` NUNCA SE ESCRIBIÓ: el número se lo comió el expediente de seguridad.
-- Toda referencia a «0015 crea la contrapartida» —`0014:12`, `0014:429-430`,
-- `persistible.ts:135`, `reconocer-lote.ts:26`— es texto obsoleto y apunta acá.
--
-- ## Las decisiones de forma, con su motivo
--
--   1. EL DIGEST DE LA ENTRADA VIVE COMO COLUMNA GENERADA EN `movimiento_bancario_crudo`,
--      NO EN LA HIJA. Es estructuralmente imposible como generada en
--      `reconocimiento_movimiento`: una generada es FILA-LOCAL y la entrada vive en otra
--      tabla (medido: `cannot use subquery in column generation expression`). Vive donde la
--      entrada está en la misma fila, y el reconocimiento toma una FOTO HISTÓRICA con
--      trigger `BEFORE INSERT` + `not null`.
--
--   2. 🔴 Y NO SE ATA CON UNA FK, aunque parezca el idiom natural. MEDIDO: con
--      `on update restrict`, el primer reconocimiento CONGELA `concepto_banco` para siempre
--      y `recapturar-conceptos.ts` muere con `23503`; con `cascade` es peor, porque
--      reescribe en silencio el digest de una interpretación YA EMITIDA y ya vista por la
--      contadora. Las otras dos variantes tampoco salvan: `on update set null` acotado a una
--      columna NO EXISTE en PostgreSQL (`a column list with SET NULL is only supported for
--      ON DELETE actions`) y el `set null` pelado nulifica también `cliente_id`, que es
--      `not null`; y `no action deferrable` sólo mueve el error al `commit`.
--      **Una FK afirma un hecho PRESENTE; el determinante registra uno HISTÓRICO.**
--      Por eso el invariante baja hasta el trigger y no más.
--
--   3. 🔴 Y EL TRIGGER ACÁ NO QUEDA FAIL-OPEN, que era la objeción de `0014:684-688` contra
--      los triggers sobre tablas con `force row level security`. Ese trigger CUENTA (sin
--      filas visibles cuenta 0 y falla ABIERTO); éste COPIA (sin filas visibles deja NULL, y
--      el `not null` rechaza). Medido con la tabla origen bajo `force RLS`: el insert
--      legítimo entra; el de un movimiento que EXISTE pero la RLS OCULTA muere con
--      `null value in column "entrada_digest" violates not-null constraint`.
--      **Contar y copiar fallan en direcciones opuestas.** El `not null` es la mitad
--      portante: un `check` solo no cierra nada, porque sobre NULL da UNKNOWN y pasa.
--
--   4. `md5` Y NO `sha256`, contra el precedente de `version.ts`. La gemela vive en una
--      columna generada, que exige `IMMUTABLE`: `sha256` exige `bytea` y `text::bytea`
--      REINTERPRETA (`'\101'::bytea` = `'A'`), `convert_to(...,'UTF8')` NO es `IMMUTABLE`, y
--      `pgcrypto` no está instalado y es no-core (ADR-0000 §2). Volatilidad medida: `md5`,
--      `encode/decode`, `textcat`, `lpad`, `date_part(text,date)` y los casts numéricos son
--      `IMMUTABLE`; 🔴 `concat()`/`concat_ws()` son STABLE y NO entran, y `date::text` y
--      `timestamptz::text` tampoco.
--
--   5. LA FECHA VA COMO `YYYY-MM-DD` ARMADO CON `lpad(date_part(...))`, no como número de
--      días. `date_out` es STABLE, pero `date_part(text, date)` y `lpad` son IMMUTABLE, y la
--      generada compila y produce la fecha ISO legible (verificado en tabla descartable,
--      revertida). Eso deja que TypeScript siga hasheando la MISMA cadena legible.
--
--   6. EL DIGEST VA SOBRE `sign(importe)`, NO SOBRE `importe`. El motor SÓLO lee
--      `columnaOrigen` (`motor.ts:46`) y `EvidenciaDeMovimientoLeida` ni siquiera expone el
--      importe. Un importe corregido de -100 a -150 no mueve una sola clasificación, e
--      invalidar por eso entrena a la contadora a aceptar recálculos sin mirar — que es el
--      peor resultado posible (05 §5.2). El principio, verificable por el tipo:
--      **el digest es función de lo que el motor lee, y lo que el motor lee ES
--      `EvidenciaDeMovimientoLeida`.** Su gemela de TypeScript (`digestDeEntrada()`,
--      `packages/contabilidad/src/nucleo/entrada.ts`) recorre ese tipo POR EXCLUSIÓN, así
--      que un campo nuevo entra al digest solo en vez de nacer olvidado.
--
--   7. `bancoCodigo` NO ENTRA (ya está cubierto por `motor_digest`, que es POR BANCO, y vive
--      en `lote_ingesta` — otra tabla, que una generada no puede ver) y `movimientoId`
--      TAMPOCO (es la IDENTIDAD, no el contenido: con él adentro todo reproceso sería fila
--      nueva y la idempotencia desaparecería).
--
--   8. 🔴 `uq_recon_determinante` LLEVA `entrada_digest` Y **NO** `padron_manifestacion_id`.
--      Decisión del titular, contra la propuesta original. Si cada corrida insertara una
--      manifestación nueva Y la manifestación estuviera en el determinante, TODA corrida
--      produciría fila nueva siempre: se acabaría el no-op de 05 §5.2 y cada supersesión se
--      llevaría puesta la decisión que la contadora ya registró — un límite fail-closed y
--      ruidoso convertido en fail-open silencioso. La manifestación entra SÓLO COMO
--      EVIDENCIA (FK desde la contrapartida). El límite de `0014:426-432` QUEDA VIVO.
--      Consecuencia que se sigue sola: con la manifestación fuera, las cinco columnas de la
--      unicidad son TODAS `not null`, así que el `nulls not distinct` que haría falta con una
--      columna nullable NO se necesita. 🔴 Vuelve a ser obligatorio el día que la
--      manifestación entre a la unicidad: con `unique` clásico y una nullable en la tupla,
--      dos filas idénticas ENTRAN LAS DOS.
--
--   9. LA CONTRAPARTIDA ESCRIBE UNA FILA POR CADA EVALUACIÓN DE CAPA C, LOS SIETE ESTADOS —
--      y la regla se enuncia POR EVALUACIÓN, no por estado. Las dos formulaciones tienen hoy
--      la misma extensión; la de «por estado» dejaría que un octavo estado que «no diga nada»
--      nazca sin fila y rompa EN SILENCIO la lectura «presencia = capa C evaluó».
--      🔴 Y la regla densa es además la que MENOS expone: con la rala, la mera PRESENCIA de
--      fila es un predicado N2 («este movimiento tiene que ver con un socio») legible con una
--      consulta que no toca una sola columna N2 — el dato viaja en la CARDINALIDAD y
--      sobrevive a todo grant por columna y a todo export que «omita lo sensible». Con la
--      densa, la presencia equivale a `que_decide` (N1): información marginal cero.
--
--  10. `socio_id` NO VA EN EL PADRE, sólo en la satélite. MEDIDO que NINGÚN mecanismo
--      fila-local sostiene la consistencia entre un `padre.socio_id` y el conjunto de la
--      satélite: `check` con subconsulta no existe; la FK satélite→padre vuelve
--      INEXPRESABLES `multiples_socios` y `socio_fuera_de_vigencia` con 2+ socios; la FK
--      padre→satélite obliga a tirar `match_clase` y AUN ASÍ no atrapa un segundo socio
--      distinto; y el trigger que cuenta valida el instante del insert del padre y NUNCA MÁS
--      (medido: una transacción posterior agrega un segundo socio y nada falla). Para
--      `es_socio` el socio es único POR CONSTRUCCIÓN (`contrapartida.ts:231-244`), y un ≠1
--      falla RUIDOSO en la lectura, que es donde el error es visible en vez de silencioso.
--
--  11. LOS NOMBRES DE LAS COLUMNAS SON UNA DECISIÓN DE SEGURIDAD. El registro de
--      `clasificacion-campos.ts` clasifica POR NOMBRE DE COLUMNA, GLOBALMENTE
--      (`ColumnaSensible` aplana el mapeo sobre todas las tablas). Una columna `clase` en N2
--      metería el literal en la unión y `redactar` taparía TODO campo llamado `clase` de todo
--      log — incluido `reconocimiento_movimiento.clase`, que es N1 a propósito y es lo que
--      reporta la cola. Lección ya pagada dos veces (`motivo` → `motivo_codigo`, `importe` →
--      `importe_declarado`). Por eso: `resolucion_estado` y `match_clase`, NUNCA `estado` ni
--      `clase`.
--
--  12. 🔴 NO SE SIEMBRAN ESTAS TABLAS. `siembra_sintetica` es el único motivo de `conJob` que
--      escribe dominio, y `app_job` no recibe NI UN GRANT acá — y ESO es lo que lo detiene, no
--      la policy: `app_job` tiene BYPASSRLS y sus policies ni se evalúan. Si hacen falta datos
--      de desarrollo, se siembran bajo `conUsuario` y sintéticos.
--
-- ## Lo que esta migración NO hace, a propósito
--
-- 🔴 NO suelta el `padronDeclaradoCompleto: false` fijo de `reconocer-lote.ts:288`. Es un
-- paso propio, con su propia predicción falsable (cuántos movimientos cambian de estado con
-- el gate prendido, número que HOY NO EXISTE) y con su propio plan — es disparador (c) de
-- CLAUDE.md §3.2 por sí solo. Consecuencia declarada: `es_tercero_padron_completo` nace
-- estructuralmente INALCANZABLE, y `padron_manifestacion` nace SIN PRODUCTOR. A cambio se
-- gana lo único que importa acá: el día que algo falle, se sabrá si el problema es el esquema
-- o el gate.
--
-- ⚠️ Y NO ancla `motor_digest` a nada. Su referente es CÓDIGO, no vive en la base, y no
-- tiene ancla posible hoy ni nunca: cualquier tabla que lo espeje mueve la mentira una tabla
-- más allá. Queda cubierto por el trinquete de `VERSION_DEL_MOTOR` y su test, no por el
-- esquema.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. `movimiento_bancario_crudo.entrada_digest` (N2) — la entrada del motor, hasheada
-- -----------------------------------------------------------------------------
--
-- Gemela EXACTA de `digestDeEntrada()` (`packages/contabilidad/src/nucleo/entrada.ts`).
-- 🔴 VERIFICADA CONTRA EL CORPUS ANTES DE EXISTIR COMO COLUMNA: esta misma expresión corrió
-- como un `select` sobre los 1830 movimientos del piloto y coincidió con TypeScript en
-- **1830 de 1830**, con 542 digests distintos por cada lado — el mismo número que midió P0.
-- Y la medición se probó rompiéndola: con la expresión mutada, 1270 de 1346 divergen y los
-- digests distintos colapsan de 236 a 25. Discrimina.
--
-- ## El enmarcado por LONGITUD, y por qué el separador pelado no alcanza
--
-- Cada campo entra como `<longitud>:<valor>`, y el ausente como `-:`. Sin el prefijo de
-- longitud, dos entradas distintas pueden producir la misma cadena moviendo el separador de
-- lugar entre campos ADYACENTES. ⚠️ Y esa propiedad es la que se enuncia, no el caso: la
-- prueba de mutación de P0 encontró que el test original usaba dos campos NO adyacentes
-- (`conceptoBanco` y `conceptoCodigo`, con `conceptoBancoEstrategia` en el medio) y por eso
-- quedaba VERDE con el prefijo sacado. El test no ejercía nada.
--
-- ⚠️ Y la longitud se cuenta en PUNTOS DE CÓDIGO, no en unidades UTF-16: `length()` en
-- Postgres cuenta caracteres y `String.length` en JavaScript cuenta unidades UTF-16. Con
-- `.length` pelado, esta columna y su gemela habrían divergido sobre cualquier fila con un
-- carácter fuera del plano básico. Del lado TypeScript se corrige con `[...texto].length`.
--
-- 🔴 Por qué NINGÚN operando puede quedar NULL: `md5(a || '|' || b)` con UN SOLO operando
-- NULL da **NULL ENTERO**. La mutación de P1 lo reprodujo en vivo — los únicos que seguían
-- coincidiendo eran los de la rama `-:` y todo el resto dio NULL. Por eso cada columna
-- nullable va envuelta en su `case`, y por eso la columna se declara `not null`: si alguna
-- vez la expresión pudiera dar NULL, el `not null` lo dice en el acto en vez de dejar un
-- determinante vacío que compara igual contra todo.
--
-- ## Clasificación: N2, `exportable: false`
--
-- ⚠️ SIN PEPPER, y es una decisión con su deuda declarada. Una columna generada NO PUEDE
-- acceder a un secreto de entorno, así que el pepper y la generada son incompatibles. El
-- riesgo que se acepta: sin pepper, la misma glosa da el mismo digest en dos clientes del
-- mismo estudio, y un `contador` con membresía en ambos podría correlacionar con un join.
-- 🔴 Baja de severidad, verificada: el ataque exige acceso RLS a los DOS tenants, y
-- `concepto_banco` es **N2, no N2-R** — se lee directo bajo `conUsuario`, sin lectura
-- auditada. Quien puede correlacionar por el digest YA PUEDE correlacionar por la glosa
-- misma, con mejor resolución: el digest no agrega ninguna capacidad. Y el hallazgo, tal como
-- se enuncia, ya es cierto hoy de `fila_hash` (N2, comparable, sin pepper), que esta
-- migración no creó. **Queda declarado y NO cerrado:** el día que exista un rol que vea la
-- cola de revisión SIN ver los movimientos crudos, la premisa se cae y hay que revisitarlo.
--
-- ⚠️ COSTO OPERATIVO DECLARADO: `add column ... generated ... stored` REESCRIBE LA TABLA con
-- `ACCESS EXCLUSIVE`. Sobre las 1830 filas del piloto es despreciable, pero el número hay que
-- tomarlo en local con el corpus cargado ANTES de tocar el piloto, y va en el runbook.
alter table movimiento_bancario_crudo
  add column entrada_digest text
    generated always as (
      left(md5(
           case when importe < 0 then '6:debito' else '7:credito' end
        || '|' || case when concepto_banco is null then '-:'
                       else length(concepto_banco)::text || ':' || concepto_banco end
        || '|' || case when concepto_banco_estrategia in ('no_capturado', 'no_publicado') then '-:'
                       else length(concepto_banco_estrategia)::text || ':' || concepto_banco_estrategia end
        || '|' || case when concepto_codigo is null then '-:'
                       else length(concepto_codigo)::text || ':' || concepto_codigo end
        || '|' || case when concepto_completo is null then '-:'
                       when concepto_completo then '4:true' else '5:false' end
        || '|' || length(contraparte_captura)::text || ':' || contraparte_captura
        -- 🔴 `greatest(4, …)` y NO `lpad(…, 4, '0')` pelado: `lpad` con una cadena MÁS LARGA que el
        -- ancho pedido **TRUNCA**, no rellena. Con `lpad(y, 4, '0')`, el año 10000 sale `'1000'` y
        -- colisiona con el año 1000 — dos fechas distintas, el MISMO digest, medido sobre la columna
        -- real. Y el prefijo de longitud iba hardcodeado en `'10:'`, así que ni siquiera lo delataba:
        -- el enmarcado por longitud existe justamente para que el valor no pueda mentir su tamaño.
        -- Se calcula la longitud REAL, como hace la gemela de TypeScript (`enmarcar()` usa
        -- `[...texto].length`), que nunca tuvo este defecto.
        -- ⚠️ Para toda fecha de año de CUATRO dígitos la cadena es idéntica a la anterior (10
        -- caracteres, prefijo `10:`), así que **ningún digest del corpus medido cambia**: las 1830
        -- coincidencias de P1 siguen valiendo.
        || '|' || length(
                    lpad(date_part('year',  fecha)::text,
                         greatest(4, length(date_part('year', fecha)::text)), '0')
                 || '-' || lpad(date_part('month', fecha)::text, 2, '0')
                 || '-' || lpad(date_part('day',   fecha)::text, 2, '0')
                  )::text
              || ':' || lpad(date_part('year',  fecha)::text,
                             greatest(4, length(date_part('year', fecha)::text)), '0')
                     || '-' || lpad(date_part('month', fecha)::text, 2, '0')
                     || '-' || lpad(date_part('day',   fecha)::text, 2, '0')
      ), 16)
    ) stored
    not null;

comment on column movimiento_bancario_crudo.entrada_digest is
  'N2, exportable:false. 16 hex de md5 sobre los SIETE campos que el motor lee de esta fila '
  '(EvidenciaDeMovimientoLeida menos movimientoId y bancoCodigo), en orden alfabético de sus '
  'claves y con enmarcado por LONGITUD (<len>:<valor>, ausente = "-:"). Gemela EXACTA de '
  'digestDeEntrada() (packages/contabilidad/src/nucleo/entrada.ts): verificada contra el '
  'corpus real en 1830 de 1830 antes de existir como columna, y la verificación se probó '
  'rompiendo la expresión. Va sobre el SIGNO del importe y no sobre el importe, porque el '
  'motor sólo lee columnaOrigen: un importe corregido no mueve una clasificación, e invalidar '
  'por eso entrena a la contadora a aceptar recálculos sin mirar. NO lleva pepper —una '
  'generada no puede leer un secreto de entorno— y por eso es comparable entre clientes, '
  'igual que fila_hash; el riesgo está declarado en el encabezado de 0021 y no cerrado.';


-- -----------------------------------------------------------------------------
-- 2. La foto histórica en `reconocimiento_movimiento`, y el determinante nuevo
-- -----------------------------------------------------------------------------
--
-- 🔴 SIN DEFAULT Y `not null` EN EL MISMO STATEMENT, a propósito: sobre una tabla CON filas
-- esto falla en el acto. Es el guard, y sale gratis — hoy `reconocimiento_movimiento` tiene
-- CERO filas en local y CERO en el piloto (verificado al preparar esta migración), así que la
-- foto histórica nace completa o la migración no entra. Una columna agregada nullable y
-- «endurecida después» dejaría filas sin determinante que comparan igual contra todo.
alter table reconocimiento_movimiento
  add column entrada_digest text not null;

-- El trigger que COPIA. Sin `security definer` —el fail-closed depende de eso— y con el
-- `search_path` explícito de 0015. Si la RLS oculta el movimiento, el `select` no devuelve
-- fila, la asignación deja NULL y el `not null` de arriba rechaza el insert. Es el punto 3
-- del encabezado.
create or replace function app.verificar_entrada_digest() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  vivo text;
begin
  select m.entrada_digest into vivo
    from public.movimiento_bancario_crudo m
   where m.cliente_id = new.cliente_id
     and m.id = new.movimiento_id;

  -- Sin fila visible (movimiento inexistente, de otro cliente, u oculto por RLS) `vivo` queda NULL y
  -- la comparación de abajo da UNKNOWN: se cae por el `raise`. Es el mismo fail-closed que tenía la
  -- versión que COPIABA — con la diferencia de que ahora la razón se dice en el mensaje.
  if vivo is null or new.entrada_digest is distinct from vivo then
    raise exception
      'entrada_digest no coincide con el movimiento %: la fila declara % y el movimiento tiene %',
      new.movimiento_id, coalesce(new.entrada_digest, '<null>'), coalesce(vivo, '<sin fila visible>')
      using errcode = 'P0001';
  end if;
  return new;
end $$;

comment on function app.verificar_entrada_digest() is
  '🔴 VERIFICA que el entrada_digest que la aplicacion DECLARA haber leido coincida con el que el '
  'movimiento tiene en el instante del insert. NO lo COPIA, y ese es el punto: copiarlo registraba '
  'una entrada que el motor podia no haber leido nunca. Medido con una carrera real: reconocer:lote '
  'corre en UNA transaccion READ COMMITTED, lee la evidencia en el primer statement y insertaba '
  'muchos statements despues; un recapturar-conceptos que commitee en el medio quedaba DENTRO de la '
  'ventana, y la fila terminaba diciendo "me calcule con la entrada nueva" habiendose calculado con '
  'la vieja. Como entrada_persistida pasaba a ser igual a entrada_actual, todo reproceso posterior '
  'daba no_op: la interpretacion vieja quedaba para siempre. Era el bug de los 64 movimientos '
  'resucitado por concurrencia. '
  'NO es una FK y no puede serlo: una FK afirma un hecho PRESENTE y esto registra uno HISTORICO — '
  'medido que con on update restrict el primer reconocimiento congela concepto_banco para siempre y '
  'que con cascade reescribe el digest de una interpretacion ya emitida. Sin security definer a '
  'proposito: sin filas visibles el select deja NULL y el raise dispara igual. '
  '⚠️ Este trigger ABORTA LA TRANSACCION, o sea el lote entero. Es la RED, no el control primario: '
  'la aplicacion compara lo mismo ANTES de escribir (escrituras.ts) y descarta ese movimiento SOLO, '
  'contandolo en el reporte. Para llegar aca la entrada tiene que cambiar en los milisegundos entre '
  'esa lectura y este insert.';

create trigger trg_reconocimiento_entrada_digest
  before insert on reconocimiento_movimiento
  for each row execute function app.verificar_entrada_digest();

comment on column reconocimiento_movimiento.entrada_digest is
  'N2, exportable:false. FOTO del movimiento_bancario_crudo.entrada_digest en el instante en '
  'que se emitio este reconocimiento. Es la mitad del determinante que 0014 no tenia: sin '
  'ella, un reproceso que cambia la entrada sin cambiar la clase da no-op con la '
  'interpretacion vieja intacta — medido en 64 movimientos del corpus real. Lo llena el '
  'trigger trg_reconocimiento_entrada_digest, no la aplicacion: NO lleva grant de insert.';

-- 🔴 EL DETERMINANTE NUEVO. Se reemplaza la unicidad de 0014, que ignoraba la entrada.
alter table reconocimiento_movimiento
  drop constraint uq_recon_determinante;

alter table reconocimiento_movimiento
  add constraint uq_recon_determinante
    unique (cliente_id, movimiento_id, motor_digest, entrada_digest, es_propuesta);

comment on constraint uq_recon_determinante on reconocimiento_movimiento is
  'EL DETERMINANTE DE IDEMPOTENCIA, completo: el codigo del motor (motor_digest) Y la entrada '
  'que leyo (entrada_digest). Reemplaza a la de 0014, que era ciega a la entrada y por eso '
  'daba no-op sobre 64 movimientos del corpus real que habian cambiado de entrada sin cambiar '
  'de clase. NO incluye padron_manifestacion_id, y es una decision explicita: si cada corrida '
  'insertara una manifestacion nueva y la manifestacion estuviera aca, toda corrida produciria '
  'fila nueva SIEMPRE y cada supersesion se llevaria puesta la decision que la contadora ya '
  'registro — un limite fail-closed convertido en fail-open silencioso. El limite declarado en '
  '0014:426-432 QUEDA VIVO. Las cinco columnas son not null, asi que nulls not distinct no '
  'hace falta; vuelve a ser obligatorio el dia que entre una columna nullable a esta tupla.';

-- 🔴 RECORTE DEL GRANT DE INSERT: de tabla a POR COLUMNA.
--
-- Sintaxis medida en las dos direcciones, y el orden importa: `revoke insert (col)` sobre un
-- grant de TABLA es un **NO-OP SILENCIOSO**; lo que sí funciona es revocar el privilegio a
-- nivel tabla y volver a otorgarlo por columna. (⚠️ `0018:58-59` afirma que un `revoke` por
-- columna no saca un grant de columna: eso es FALSO —medido, sí lo saca— y esa frase NO se
-- propaga acá. Lo correcto es lo que dicen `0018:60` y `0020:107`.)
--
-- Qué cierra, y no es teórico: hoy `created_at` y `superseded_por` son insertables, o sea que
-- un tenant puede ANTEDATAR su propio reconocimiento (H-B textual, lo que 0019/0020 cerraron
-- para `ocurrido_en`) y puede insertar una fila NACIDA SUPERSEDED — que sale de
-- `uq_recon_vigente`, NUNCA aparece en la cola de la contadora, y nada falla.
--
-- ⚠️ `id` SÍ va en el grant, y es deliberado: el escritor de producción lo NOMBRA
-- (`escrituras.ts:323-326`), porque la supersesión escribe `superseded_por = <id nuevo>`
-- ANTES del insert. Copiar acá la forma de `0020` §1 rompería producción. El riesgo residual
-- es distinto del incidente #7: `id` es `uuid default gen_random_uuid()`, y para chocar hay
-- que adivinar 122 bits de CSPRNG de una fila que no se ve. Aceptado y declarado.
revoke insert on reconocimiento_movimiento from app_request;

-- 🔴 `entrada_digest` VA EN EL GRANT, y no debilita nada: es la aplicación DECLARANDO qué entrada
-- leyó, y `trg_reconocimiento_entrada_digest` la verifica contra el movimiento en el mismo statement.
-- Mentir exige escribir el valor verdadero, que es escribir el valor verdadero. Lo que se gana a
-- cambio es lo que la versión anterior no podía dar: cuando el trigger COPIABA, la fila registraba
-- la entrada del INSTANTE DEL INSERT, que bajo READ COMMITTED puede no ser la que el motor leyó.
grant insert (
    id, cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
    lado, que_decide, motivo_codigo, via, evidencia_entrada_lexico_id,
    evidencia_caracteres_matcheados, evidencia_hubo_cola
  ) on reconocimiento_movimiento to app_request;


-- -----------------------------------------------------------------------------
-- 3. `padron_manifestacion` (N2) — «declaro que el padrón de socios está completo»
-- -----------------------------------------------------------------------------
--
-- La premisa que le falta al motor para poder concluir «esta contraparte no es socio, es un
-- tercero». Sin ella el sistema queda —a propósito— en la posición conservadora de no
-- proponer nada: `04-imputacion-contable.md:270`, «sin padrón consultado, "no es socio" no es
-- una conclusión: es ausencia de control».
--
-- ## PK `uuid`, NUNCA `bigint generated always as identity`
--
-- 🔴 El incidente #7 se REPRODUJO en laboratorio para esta tabla: con `identity` + grant de
-- tabla, A inserta `OVERRIDING SYSTEM VALUE` con los ids 2 y 3 y EL CAMINO NORMAL DE B MUERE
-- con `23505`. Denegación cross-tenant en una tabla que todavía no existía. El uuid la cierra
-- de raíz.
--
-- ## Quién puede manifestar: `socio` y `contador`. El `administrativo` NO
--
-- Precedente en la tabla hermana, `0013:390-392`: «decidir quién es socio de un cliente es
-- criterio del contador». Manifestar es la misma decisión un nivel más arriba: no dice «esta
-- persona es socia», dice **«no hay ninguna otra que lo sea»**. Si no puede agregar un socio,
-- no puede declarar cerrada la lista. Y el argumento de `0014:518-524` —que sí deja entrar al
-- administrativo a `reconocimiento_movimiento`— NO transfiere: la manifestación no es una
-- propuesta, es LA PREMISA QUE CAMBIA EL RESULTADO DEL MOTOR, y el administrativo estaría
-- fabricando la premisa que convierte su propio trabajo en propuesta lista.
--
-- ## Sin `update` ni `delete` para nadie
--
-- Una manifestación errónea se SUPERSEDE con una fila nueva (`revoca_a`), jamás con un
-- `UPDATE`: una columna `revocada_en` actualizable no lleva autor, y el rastro diría que
-- quien manifestó fue quien revocó.
create table padron_manifestacion (
  -- (1) de la plantilla de ADR-0001 §5.
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references tenant_node(id) on delete restrict,

  -- 🔴 EL ALCANCE. La manifestación NO CADUCA POR RELOJ —el tiempo no altera el padrón—:
  -- caduca por alcance. La alteran (a) que cambie el conjunto de socios y (b) que el
  -- movimiento sea posterior a lo que la manifestación abarca. Sin esta columna, «el padrón
  -- está completo» declarado en marzo se aplicaría a un movimiento de diciembre con dos
  -- socios que entraron y uno que salió en el medio, y la premisa se extendería PARA SIEMPRE.
  -- `not null` SIN DEFAULT a propósito: `current_date` sería exactamente el error que la
  -- columna existe para impedir, y el default haría que la pregunta la conteste el esquema en
  -- silencio en vez de quien manifiesta.
  completo_hasta   date not null,

  -- N1. Qué manifestación reemplaza a ésta. `null` = ésta es la vigente.
  revoca_a         uuid,

  -- 🔴 `not null` PORTANTE: fuera de un contexto de request `app.current_user_id()` devuelve
  -- NULL y el insert se rechaza con `23502`. No lleva grant: no es elegible por quien escribe.
  manifestado_por  uuid not null default app.current_user_id(),
  manifestado_en   timestamptz not null default now(),

  -- (10) de la plantilla ampliada, y destino de la FK de DOS columnas de la contrapartida.
  constraint uq_padron_manifestacion_tenant unique (cliente_id, id),

  -- Destino de la FK de TRES columnas del espejo de alcance. Medido: 16 kB con 60 filas.
  constraint uq_padron_manifestacion_alcance unique (cliente_id, id, completo_hasta),

  -- (11) FK COMPUESTA tenant-consistente: la manifestación que ésta revoca es del MISMO
  -- cliente. Sin las dos columnas, una manifestación podría revocar la de otro estudio.
  constraint fk_padron_manifestacion_revoca
    foreign key (cliente_id, revoca_a)
    references padron_manifestacion (cliente_id, id)
    on delete restrict
);

-- (2) de la plantilla.
create index idx_padron_manifestacion_cliente on padron_manifestacion(cliente_id);

-- (3) la manifestación cuelga de un nodo `cliente`, nunca de un `estudio`.
create trigger trg_padron_manifestacion_cliente
  before insert or update of cliente_id on padron_manifestacion
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5).
alter table padron_manifestacion enable row level security;
alter table padron_manifestacion force  row level security;

-- (6) lectura sin chequeo de rol: cero columnas N2-R.
create policy padron_manifestacion_sel on padron_manifestacion for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) POR OPERACIÓN, nunca `for all` (0005). 🔴 SIN `administrativo`: ver el encabezado del
-- bloque. Y hay un segundo motivo, técnico y medido: mientras el incidente #8 esté abierto,
-- la lista de roles de esta policy ES el conjunto de identidades forjables en
-- `manifestado_por`. Sacar `administrativo` reduce ese conjunto en uno, por nodo. Es el único
-- control sobre #8 que una migración puede aplicar.
create policy padron_manifestacion_ins on padron_manifestacion for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador']::app.rol_membership[]) );

-- SIN policy de UPDATE ni de DELETE para NADIE: se supersede con `revoca_a`.
grant select on padron_manifestacion to app_request;

-- GRANT DE INSERT POR COLUMNA. Deja afuera `id`, `manifestado_por` y `manifestado_en`: los
-- tres son del mecanismo, no del escritor.
grant insert (cliente_id, completo_hasta, revoca_a) on padron_manifestacion to app_request;

comment on table padron_manifestacion is
  'La declaracion de que el padron de socios de este cliente esta COMPLETO, con su alcance. '
  'Es la premisa que habilita al motor a concluir "es un tercero" — sin ella el sistema no '
  'propone, a proposito. Append-only: una manifestacion erronea se supersede con una fila '
  'nueva (revoca_a), nunca se edita. 🔴 NACE SIN PRODUCTOR: reconocer-lote.ts:288 pasa '
  'padronDeclaradoCompleto=false fijo y soltarlo es un paso propio, fuera de 0021.';

comment on column padron_manifestacion.completo_hasta is
  'El ALCANCE de la declaracion. La manifestacion no caduca por reloj (el tiempo no altera el '
  'padron): caduca porque cambie el conjunto de socios o porque el movimiento sea posterior a '
  'lo que abarca. Sin default a proposito — current_date seria exactamente el error que esta '
  'columna existe para impedir. Una manifestacion no deberia atravesar un cierre de ejercicio.';

comment on constraint uq_padron_manifestacion_alcance on padron_manifestacion is
  'Destino de fk_recon_contrapartida_alcance. Es lo que vuelve INFALSIFICABLE el espejo '
  'padron_completo_hasta de reconocimiento_contrapartida: citar la manifestacion A con el '
  'alcance de B se rechaza con 23503. 🔴 Y ATA completo_hasta A SU INMUTABILIDAD: con una '
  'contrapartida viva, ni UPDATE ni DELETE de la manifestacion pasan. Eso NO es el modo de '
  'falla que mato a la FK del determinante: alla el UPDATE era un camino legitimo y vivo, aca '
  'ya estaba prohibido por diseño, asi que la FK mecaniza una decision tomada. ⚠️ La premisa '
  'depende de que NUNCA se otorgue update sobre esta tabla, incluido un grant de TABLA que un '
  'grep de grants por columna no ve (0004:502 es el precedente).';

comment on column padron_manifestacion.revoca_a is
  'Encadena la manifestacion que esta reemplaza. NULL = esta es la vigente. '
  '⚠️ REVOCAR NO RETIRA CITABILIDAD: nada en el esquema impide que una fila de '
  'reconocimiento_contrapartida cite, via padron_manifestacion_id, el id de UNA MANIFESTACION YA '
  'REVOCADA -- fk_recon_contrapartida_alcance (contra uq_padron_manifestacion_alcance) solo exige '
  'existencia + completo_hasta coincidente, nunca vigencia, y esta tabla es append-only sin UPDATE '
  'ni DELETE para nadie, asi que la fila revocada nunca desaparece. '
  '🔴 NO SE PUEDE CERRAR CON UNA POLICY: la validacion de una FK corre a nivel del owner de la '
  'tabla y nunca esta sujeta a RLS -- el control correcto, el dia que se decida cerrar esto, tiene '
  'que ser un CHECK/trigger sobre la fila citante o una unicidad parcial tipo uq_recon_vigente '
  '(0014:479), nunca una policy de SELECT que oculte las revocadas. '
  'EL GAP NO CRUZA TENANT: las dos FK que importan (fk_padron_manifestacion_revoca y '
  'fk_recon_contrapartida_manifestacion) llevan cliente_id, asi que solo se puede citar una '
  'manifestacion revocada DEL MISMO cliente -- es una falla de integridad contable dentro de un '
  'cliente, no una fuga entre clientes. '
  'ES TOLERABLE hoy porque reconocimiento_contrapartida NACE SIN PRODUCTOR (ver comment de la '
  'tabla) y porque es_tercero_padron_completo esta BLOQUEADO POR CODIGO -- el escritor con mas '
  'privilegio para citar esto es administrativo, via reconocimiento_contrapartida_ins, mientras '
  'que padron_manifestacion_ins EXCLUYE a administrativo de manifestar: quien puede citar una '
  'manifestacion vieja no es necesariamente quien la manifesto. '
  'DEJA DE SER TOLERABLE EN P5: "elegir la manifestacion" ahi nace como un order by completo_hasta '
  'desc limit 1 que cita la vigente por CONVENCION DE LA APLICACION, no por garantia de la base. '
  'Ver docs/diseno/11-migracion-0021-determinante-y-capa-c.md parrafo 5.10. Pinneado con '
  'packages/data/tests/caracterizacion-manifestacion-revocada-citable.test.ts, no arreglado.';

comment on column padron_manifestacion.manifestado_por is
  '🔴 QUE VALE Y QUE NO. Vale: que alguien con credencial de app_request y membresia '
  'habilitada sobre este cliente ejecuto esto en ese instante; la fecha no es elegible '
  '(DEFAULT sin grant) y el cliente tampoco (0020 lo midio: otro estudio da 42501). NO VALE: '
  'identificar a la persona — app.current_user_id() es un GUC que setea la propia sesion, y '
  'medido con la credencial real, set_config(app.user_id, <otro>, true) sale GENUINA Y MAL '
  'ATRIBUIDA. Identidad declarada no es identidad autenticada. Por eso va not null, sin grant '
  'de insert, sin update y sin delete: una mala atribucion reescribible es estrictamente peor. '
  '⚠️ CONDICION PARA LA INTERFAZ, no para el esquema: ninguna pantalla ni export puede '
  'presentar esta columna como PRUEBA DE AUTORIA. Si la cola dijera "padron declarado completo '
  'por Laura", la pantalla afirmaria mas de lo que el mecanismo sostiene — que es exactamente '
  'lo que 0019:85-90 hizo y 0020 tuvo que desmentir.';


-- -----------------------------------------------------------------------------
-- 4. `reconocimiento_contrapartida` (N2, 1:0..1) — qué resolvió capa C, y que corrió
-- -----------------------------------------------------------------------------
--
-- LA FILA ES EL HECHO: presencia = capa C evaluó este movimiento; ausencia = no lo evaluó.
-- No hay un `capa_c_corrida boolean` en el padre, y no es un olvido: sería una tercera columna
-- actualizable en una tabla cuyo grant de UPDATE es por columna justamente para cerrar ese
-- camino (`0014` decisión 9).
--
-- UNA FILA POR CADA EVALUACIÓN, los SIETE estados — ver el punto 9 del encabezado. Medido que
-- no hay costo que lo desaconseje: 234.000 filas (≈15 años de corridas mensuales del piloto)
-- pesan 83 MB, una corrida de 1300 inserts cuesta 232 ms contra 17 ms sin los índices únicos
-- (0,17 ms por fila), y el peor caso de bloat es CERO porque la tabla no admite `update` ni
-- `delete`. Y la supersesión no es por corrida sino por cambio: el no-op de
-- `escrituras.ts:303` corta antes del insert, así que una corrida que no cambia nada escribe
-- CERO filas acá.
--
-- NO TIENE DETERMINANTE PROPIO: es inmutable, se inserta en la MISMA TRANSACCIÓN que su padre
-- y hereda de él idempotencia y supersesión.
--
-- ## Lo que NO se persiste, y por qué
--
--   - `vigenteDesde`/`vigenteHasta` de los matches. Dos motivos independientes: (a) duplican
--     un hecho MUTABLE (`0013:417` da `grant update (vigente_hasta)`) y el sistema NO guarda
--     su historia, así que persistir una copia por movimiento materializaría el historial de
--     un hecho que se decidió no conservar; (b) con ellas adentro, `select resolucion_estado,
--     socio_id, vigente_hasta` devuelve LA FECHA DE SALIDA DE CADA EX-SOCIO desde la tabla que
--     se lista entera todos los meses, y `socio_fuera_de_vigencia` es un hecho de conflicto
--     societario.
--   - `pepperIdsCandidatos`/`pepperIdsPadron`. Son N1 y son estado de la PLATAFORMA, no del
--     cliente: durante una rotación la tabla se llenaría de miles de filas sin UN SOLO HECHO
--     DEL CLIENTE. Van al log.
--   - Cualquier texto libre. Es donde termina el nombre de un socio.
create table reconocimiento_contrapartida (
  -- (1) de la plantilla. PK `uuid`: ver el bloque 3. Acá el escritor NO necesita nombrar `id`
  -- (no hay supersesión que escriba un puntero antes del insert), así que no lleva grant.
  id                      uuid primary key default gen_random_uuid(),
  cliente_id              uuid not null references tenant_node(id) on delete restrict,

  reconocimiento_id       uuid not null,

  -- N2. Cuál de los 7 estados de `ResolucionDeContraparte` (`contrapartida.ts:90-101`).
  -- 🔴 `not null` LOAD-BEARING: sobre NULL los dos checks condicionales de abajo dan UNKNOWN
  -- y la fila ENTRA (medido). No es decoración.
  resolucion_estado       text not null,

  -- N1. Espejo de la clase FINAL del padre, atado por la FK de tres columnas contra
  -- `uq_recon_clase` (`0014:451`). Es el idiom de `reconocimiento_candidato.reconocimiento_clase`
  -- GENERALIZADO de una constante a una variable: allá la columna puede ser generada porque la
  -- clase es fija, acá varía con el estado, así que se escribe — pero la FK la vuelve
  -- INFALSIFICABLE, porque un valor que no coincida con la clase real del padre no encuentra
  -- fila y muere con `23503`. La garantía es referencial, no un check.
  reconocimiento_clase    text not null,

  -- 🔴 PRIMERA ANCLA DE LA SATÉLITE. Generada STORED, del lado REFERENCIADO de un `unique`
  -- usado por FK — medido que Postgres lo acepta, y que la mitad hija
  -- (`generated always as (true)`) NO SE PUEDE ESCRIBIR NI CON EL VALOR CORRECTO
  -- (`cannot insert a non-DEFAULT value into column`). Rechaza el MECANISMO, no el valor.
  -- `not null` EXPLÍCITO y no derivado de que `resolucion_estado` lo sea: medido que si esa
  -- premisa se cayera, la generada saldría NULL y el `unique` dejaría de discriminar.
  admite_matches          boolean generated always as
    (resolucion_estado in ('es_socio', 'multiples_socios', 'socio_fuera_de_vigencia'))
    stored not null,

  -- 🔴 SEGUNDA ANCLA, y no es redundante con la primera. Distingue «un socio» de «varios», que
  -- es lo que permite acotar `es_socio` a UNA fila satélite por índice parcial sin meter
  -- `socio_id` en el padre. Las dos garantías son ORTOGONALES: `admite_matches` garantiza que
  -- el padre ADMITE matches (por mecanismo); `regimen_matches` garantiza que el régimen
  -- declarado por la hija ES el del padre (por valor).
  regimen_matches         text generated always as (
    case resolucion_estado
      when 'es_socio'                then 'socio_unico'
      when 'multiples_socios'        then 'varios'
      when 'socio_fuera_de_vigencia' then 'varios'
      else                                'sin_matches'
    end) stored not null,

  -- N1. La manifestación en la que se apoyó ESTA resolución. Vínculo EXPLÍCITO, nunca «la
  -- última vigente» resuelta en tiempo de consulta. 🔴 Es el rastro que contesta la pregunta
  -- forense REAL el día que una manifestación resulte errónea: no «¿quién la leyó?» sino
  -- «¿qué propuestas se apoyaron en ESTA?», en O(1) y para siempre. Un rastro de lectura no la
  -- contesta nunca.
  padron_manifestacion_id uuid,

  -- 🔴 N1. ESPEJO ESTRUCTURAL del `completo_hasta` de la manifestación citada, NO ES DATO —
  -- misma figura y mismas palabras que `tenant_node.parent_path` (`0017:133-138`): es lo que
  -- vuelve FILA-LOCAL, y por lo tanto verificable con un check inmediato e inmune a la RLS, un
  -- invariante que de otro modo cruza dos tablas. Nadie lee el alcance DESDE acá; se lee de la
  -- manifestación. Nombre distinto del de la madre a propósito, para que se lea como espejo y
  -- no como copia.
  --
  -- ⚠️ Y ES EL ÚNICO ATRIBUTO QUE SE ESPEJA. La regla, escrita para que el cuarto no entre «ya
  -- que estamos»: la contrapartida espeja SÓLO lo que un invariante fila-local de esta tabla
  -- necesita. Cualquier otro atributo de `padron_manifestacion` es un join.
  padron_completo_hasta   date,

  -- N2. La fecha con la que se evaluó la vigencia de los socios. 🔴 NO es una denormalización
  -- de `movimiento.fecha`: es el PARÁMETRO con el que corrió `resolverContraparte`, que hoy
  -- sale de `ev.fecha` (`reconocer-lote.ts:288`). Ver el `comment on column`.
  resuelto_a_fecha        date not null,

  created_at              timestamptz not null default now(),

  -- ---------------------------------------------------------------------------
  -- Dominio cerrado. Lista IDÉNTICA a `ESTADOS_RESOLUCION`, y va sobre LOS SIETE, jamás sobre
  -- «los alcanzables» — literal `0014` decisión 7. Estado por estado, qué lo produce HOY:
  --   sin_candidatos               941 movimientos con `sin_identificador`. SE LLENA YA
  --                                (⚠️ 941 es COTA SUPERIOR: `contraparte_captura` tiene
  --                                 cuatro valores y TRES dan cero candidatos)
  --   sin_match_padron_incompleto  la rama negativa con el gate en false. SE LLENA YA
  --   es_socio                     espera que alguien cargue un socio (padrón en 0 filas)
  --   multiples_socios             ídem
  --   socio_fuera_de_vigencia      ídem
  --   pepper_desalineado           ídem, y sólo durante una rotación
  --   es_tercero_padron_completo   🔴 BLOQUEADO POR CÓDIGO (`reconocer-lote.ts:288`)
  -- ---------------------------------------------------------------------------
  constraint contrapartida_estado_chk
    check (resolucion_estado in (
      'sin_candidatos', 'es_socio', 'es_tercero_padron_completo',
      'sin_match_padron_incompleto', 'pepper_desalineado', 'multiples_socios',
      'socio_fuera_de_vigencia')),

  -- ---------------------------------------------------------------------------
  -- 🔴 LA PROMOCIÓN, FILA-LOCAL. Reemplaza a un check anterior que era INSATISFACIBLE:
  -- `retiro_de_socio`/`aporte_de_socio` salen EXCLUSIVAMENTE de la rama `es_socio`
  -- (`motor.ts:144-154`), que es una de las que NO tiene manifestación, así que exigirle una
  -- habría rechazado toda fila `retiro_de_socio`. Y aquel check tampoco era fila-local: `tipo`
  -- vive en el padre.
  --
  -- Escrito como `CASE` y NO como igualdad de booleanos a propósito: la forma
  -- `(estado in (...)) = (clase = 'propuesta')` daría VERDE a un padre `sin_reconocer` con un
  -- estado no promotor —`false = false` es true—, y el padre de una contrapartida nunca puede
  -- ser `sin_reconocer`: capa C sólo corre sobre `decision_humana` (`reconocer-lote.ts:283`).
  -- ---------------------------------------------------------------------------
  constraint contrapartida_promocion_chk check (
    case resolucion_estado
      when 'es_socio'                   then reconocimiento_clase = 'propuesta'
      when 'es_tercero_padron_completo' then reconocimiento_clase = 'propuesta'
      else                                   reconocimiento_clase = 'decision_humana'
    end
  ),

  -- ---------------------------------------------------------------------------
  -- 🔴 NULIDAD CONDICIONAL, BINARIA. La manifestación existe SI Y SÓLO SI la resolución usó el
  -- gate de padrón completo — o sea, sólo en `es_tercero_padron_completo`.
  --
  -- POR QUÉ NO INCLUYE `sin_match_padron_incompleto`, que es lo que el diseño proponía y los
  -- tres agentes de la ronda encontraron por separado: MEDIDO que con esa forma el check
  -- RECHAZA EL 100% de lo que el sistema produce hoy, y `reconocer:lote --aplicar` abortaría
  -- el lote entero en la primera corrida. Ese estado ES la rama en la que el gate dio `false`
  -- (`contrapartida.ts:202-205`), y hoy ese `false` es un literal: NO HAY MANIFESTACIÓN QUE
  -- CITAR, y NULL es el valor verdadero.
  --
  -- Y NULL acá significa, sin ambigüedad, **que no hubo manifestación**. No puede significar
  -- «la había y no alcanzaba»: el gate es un `boolean` pelado (`contrapartida.ts:166`) y
  -- `ResolucionDeContraparte` no tiene dónde alojar cuál manifestación se consultó — ese
  -- estado es INEXPRESABLE en el tipo que ES la evidencia. Si algún día el gate distingue las
  -- dos causas, este check se relaja JUNTO CON el bump de `VERSION_DEL_MOTOR` que ese cambio
  -- de tipo obliga (`contrapartida.ts` está dentro de la huella del motor), así que no puede
  -- volverse silenciosamente equivocado.
  -- ---------------------------------------------------------------------------
  -- 🔴 LA SEGUNDA MITAD NO ES COSMÉTICA: ES EL BYPASS DEL CONTROL DE FRESCURA. Medido: con
  -- `match simple` —el default—, un `padron_manifestacion_id` NO NULO con el espejo en NULL
  -- ENTRA, porque la FK compuesta SE SALTEA si alguna columna referenciadora es nula; y
  -- entonces `contrapartida_frescura_chk` evalúa sobre NULL, da UNKNOWN y PASA. O sea: sin este
  -- renglón, el control de frescura se desactiva dejando una columna vacía. Es la lección S4
  -- sobre una columna nueva.
  --
  -- ⚠️ Y `match full` NO sirve para cerrarlo, contra la intuición: con `cliente_id` (`not null`)
  -- ADENTRO de la FK, «todas nulas» es INALCANZABLE, así que `match full` deja la FK enforced
  -- siempre y RECHAZA el caso legítimo de las seis ramas sin manifestación (medido:
  -- `MATCH FULL does not allow mixing of null and nonnull key values`). Regla general que se
  -- sigue de esto y vale para todo el repo: **en un esquema tenant-consistente, `match full` es
  -- inutilizable en cualquier FK opcional**, porque la columna de tenant siempre está adentro y
  -- siempre es `not null`.
  constraint contrapartida_manifestacion_chk check (
        (resolucion_estado = 'es_tercero_padron_completo') = (padron_manifestacion_id is not null)
    and (resolucion_estado = 'es_tercero_padron_completo') = (padron_completo_hasta is not null)
  ),

  -- ---------------------------------------------------------------------------
  -- 🔴 LA FRESCURA DE LA MANIFESTACIÓN, FILA-LOCAL. Una manifestación NO caduca por reloj —el
  -- tiempo no altera el padrón—: caduca porque el movimiento sea POSTERIOR a lo que abarca.
  -- Con el espejo atado por FK, ese invariante deja de cruzar dos tablas y pasa a ser un check.
  -- Depende de `resuelto_a_fecha not null`: son un paquete, no dos columnas independientes.
  --
  -- ⚠️ QUÉ GARANTIZA Y QUÉ NO, y se escribe porque si no el control afirma más de lo que
  -- sostiene: garantiza que **el alcance citado cubre la fecha evaluada**. NO garantiza que
  -- **el alcance declarado sea cierto** — nada impide manifestar `completo_hasta` en 2099.
  -- Misma figura que el enunciado probatorio de `manifestado_por`.
  --
  -- 🔴 Y CUBRE UNA SOLA DE LAS DOS COSAS QUE ALTERAN UNA MANIFESTACIÓN. Las dos son: (a) que
  -- cambie el conjunto de socios, y (b) que el movimiento sea posterior al alcance. Esto es
  -- (b). Para (a) NO HAY MECANISMO, ni acá ni en la aplicación: `0013:409-417` da
  -- `grant insert` sobre `padron_socio` y `grant update (denominacion, vigente_hasta)`, así que
  -- el conjunto de socios PUEDE CAMBIAR después de manifestado y ninguna manifestación se
  -- entera. Queda declarado y abierto.
  -- ---------------------------------------------------------------------------
  constraint contrapartida_frescura_chk check (
    padron_manifestacion_id is null
    or padron_completo_hasta >= resuelto_a_fecha
  ),

  -- 1:0..1. Una sola resolución de capa C por reconocimiento; la segunda pasada sobre el mismo
  -- reconocimiento es un bug del productor, no un dato.
  constraint uq_recon_contrapartida_reconocimiento unique (cliente_id, reconocimiento_id),

  -- (10) de la plantilla ampliada.
  constraint uq_recon_contrapartida_tenant unique (cliente_id, id),

  -- Destinos de las dos FK de la satélite. Lógicamente redundantes con el anterior —si
  -- `(cliente_id, id)` es único, agregarle una columna sigue siéndolo— y existen SÓLO porque
  -- Postgres exige un unique de columnas EXACTAS del lado referenciado (medido:
  -- `there is no unique constraint matching given keys`). Mismo patrón que `uq_recon_propuesta`
  -- y `uq_recon_clase` de `0014:447-451`.
  constraint uq_recon_contrapartida_admite  unique (cliente_id, id, admite_matches),
  constraint uq_recon_contrapartida_regimen unique (cliente_id, id, regimen_matches),

  -- (11) FK COMPUESTA tenant-consistente y de TRES columnas: mismo cliente Y la clase real del
  -- padre. Es lo que vuelve infalsificable a `reconocimiento_clase`.
  constraint fk_recon_contrapartida_reconocimiento
    foreign key (cliente_id, reconocimiento_id, reconocimiento_clase)
    references reconocimiento_movimiento (cliente_id, id, clase)
    on delete restrict,

  -- (11) FK de DOS columnas: la manifestación citada existe y es del MISMO cliente.
  -- 🔴 NO es redundante con la de tres columnas de abajo, y esto está medido: con el espejo en
  -- NULL la de tres SE SALTEA y un `padron_manifestacion_id` INEXISTENTE entra sin que nada
  -- falle. Ésta lo rechaza por MECANISMO, sin depender de ningún check — mismo patrón que la
  -- generada booleana frente a `contrapartida_match_regimen_chk`.
  constraint fk_recon_contrapartida_manifestacion
    foreign key (cliente_id, padron_manifestacion_id)
    references padron_manifestacion (cliente_id, id)
    on delete restrict,

  -- (11) otra vez, y con TRES columnas: el espejo ES el de la manifestación citada. Es lo que
  -- vuelve infalsificable a `padron_completo_hasta` — medido que citar la manifestación A con
  -- el alcance de B muere con `23503`. Mismo mecanismo que `reconocimiento_clase` contra
  -- `uq_recon_clase`: la FK vuelve VERDADERO un valor escrito.
  --
  -- ⚠️ Y ATA `completo_hasta` A SU INMUTABILIDAD: con una contrapartida viva, ni `UPDATE` ni
  -- `DELETE` de la manifestación pasan (medido, `23503`). Eso NO es el modo de falla que mató a
  -- la FK del determinante: allá el `UPDATE` era un camino LEGÍTIMO Y VIVO
  -- (`recapturar-conceptos.ts`), y la FK lo habría matado; acá el `UPDATE` ya está prohibido
  -- por diseño —una manifestación errónea se supersede con una fila nueva, nunca se edita—, así
  -- que la FK MECANIZA UNA DECISIÓN TOMADA en vez de pelear contra una operación real.
  -- Cuando el referente es append-only, el hecho presente y el histórico son el MISMO hecho.
  -- 🔴 La premisa depende de que NUNCA se otorgue `update` sobre `padron_manifestacion` —
  -- incluido un grant de TABLA, que un grep de grants por columna NO VE (`0004:502` es el
  -- precedente que ya nos mordió). Lo cubre el test de grants por conjunto EXACTO.
  constraint fk_recon_contrapartida_alcance
    foreign key (cliente_id, padron_manifestacion_id, padron_completo_hasta)
    references padron_manifestacion (cliente_id, id, completo_hasta)
    on delete restrict
);

-- (2) de la plantilla, literal.
create index idx_reconocimiento_contrapartida_cliente
  on reconocimiento_contrapartida(cliente_id);

-- NO se crea `(cliente_id, resolucion_estado)`. MEDIDO sobre 78.000 filas de un cliente: con
-- índice 4,7 ms, sin índice 13,8 ms, y el índice pesa 1704 kB. Compra 9 ms sobre una consulta
-- QUE TODAVÍA NO EXISTE EN EL CÓDIGO. La que sí existe —la cola, joineando contra los
-- reconocimientos vigentes— va por `uq_recon_contrapartida_reconocimiento` con Heap Fetches: 0
-- (0,06 ms la fila suelta). Se agrega el día que la consulta exista, con su plan. Mismo
-- criterio que `0014:727-730`.

-- (3)
create trigger trg_reconocimiento_contrapartida_cliente
  before insert or update of cliente_id on reconocimiento_contrapartida
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5).
alter table reconocimiento_contrapartida enable row level security;
alter table reconocimiento_contrapartida force  row level security;

-- (6) lectura sin chequeo de rol: cero columnas N2-R/N3, y esto es lo que la cola de revisión
-- lista entera todos los meses. Los renglones (8) y (9) del pie de `0002` NO APLICAN, y es
-- DERIVABLE, no una opinión: `tablasQueExigenRolEnLectura()` excluye la tabla sola. 🔴 Si una
-- sola columna terminara en N2-R, la tabla entra sola en `tablasSinLectorAuditado()` y el gate
-- se pone rojo — por eso el padrón entra como FK a la manifestación y NUNCA como digest de
-- `padron_socio_documento.documento`, que es N2-R y arrastraría a toda la cola al régimen
-- auditado.
create policy reconocimiento_contrapartida_sel on reconocimiento_contrapartida for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) POR OPERACIÓN, nunca `for all` (0005). Acá el `administrativo` SÍ entra: esto es SALIDA
-- DEL MOTOR, mismo criterio que `reconocimiento_candidato` (`0014:746-749`). Es la diferencia
-- exacta con `padron_manifestacion`, que es una PREMISA y no una salida.
create policy reconocimiento_contrapartida_ins on reconocimiento_contrapartida for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- SIN policy de UPDATE ni de DELETE para NADIE: un resultado mal calculado no se edita, se
-- supersede el reconocimiento entero y la contrapartida nueva cuelga de la fila nueva.
grant select on reconocimiento_contrapartida to app_request;

-- GRANT DE INSERT POR COLUMNA. Deja afuera `id`, `created_at` y las dos generadas. `created_at`
-- afuera cierra el mismo agujero que `0014` dejó vivo (un tenant antedatando su propia fila).
grant insert (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase,
              padron_manifestacion_id, padron_completo_hasta, resuelto_a_fecha)
  on reconocimiento_contrapartida to app_request;

comment on table reconocimiento_contrapartida is
  'Que resolvio capa C sobre este movimiento: uno de los 7 estados de ResolucionDeContraparte, '
  'con el vinculo a la manifestacion de padron en la que se apoyo. LA FILA ES EL HECHO: '
  'presencia = capa C evaluo; ausencia = no la evaluo. Una fila POR CADA EVALUACION, y la regla '
  'se enuncia por evaluacion y no por estado — un octavo estado que "no diga nada" y quedara '
  'sin fila rompería esa lectura en silencio. 1:0..1 de reconocimiento_movimiento, inmutable, '
  'sin determinante propio: hereda idempotencia y supersesion del padre.';

comment on column reconocimiento_contrapartida.admite_matches is
  'Columna GENERADA STORED, del lado REFERENCIADO de uq_recon_contrapartida_admite. Su mitad '
  'hija es generated always as (true) y NO SE PUEDE ESCRIBIR NI CON EL VALOR CORRECTO: rechaza '
  'el MECANISMO, no el valor. Se conserva junto a regimen_matches aunque parezca subsumida, y '
  'esta medido por que: con la FK de regimen SOLA, un match "sin_matches" colgado de un '
  'sin_candidatos lo rechaza el CHECK y no la FK —el padre existe con ese valor— y al mutar el '
  'check la fila ENTRA. Con esta FK lo rechaza el mecanismo. ⚠️ Lo que NO cubre, medido: un '
  'UPDATE entre dos estados que ambos admiten (es_socio -> multiples_socios) pasaria en '
  'silencio; lo cierra la AUSENCIA de grant de UPDATE en esta tabla, no la FK.';

comment on column reconocimiento_contrapartida.resuelto_a_fecha is
  'N2. La fecha con la que se evaluo la vigencia de los socios — el PARAMETRO de la corrida, no '
  'la fecha del movimiento. 🔴 La diferencia importa y esta medida: hoy sale de ev.fecha '
  '(reconocer-lote.ts:288), y ese archivo esta FUERA de la huella de VERSION_DEL_MOTOR, que '
  'solo recorre packages/contabilidad/src/nucleo. Un cambio a ev.fechaValor —existe, es N2— no '
  'moveria entrada_digest (que lee la columna fecha) ni motor_digest, y las filas historicas '
  'quedarian indistinguibles de las nuevas. NO se llena por trigger a proposito: un trigger que '
  'copiara movimiento.fecha garantizaria la igualdad POR CONSTRUCCION y con eso eliminaria '
  'justamente el grado de libertad que esta columna existe para observar — seguiria escribiendo '
  'la fecha del movimiento mientras el motor evalua con otra. Y NO lleva FK contra el '
  'movimiento: esta medido que con on update restrict congela la fecha del movimiento y con '
  'cascade reescribe una evaluacion ya emitida. El control es un TEST que asserta la igualdad '
  'con movimiento.fecha, y se pone rojo el dia que alguien cambie el criterio — que es EL '
  'EVENTO A DETECTAR, no un bug a arreglar volviendo atras.';

comment on column reconocimiento_contrapartida.padron_completo_hasta is
  'N1. ESPEJO ESTRUCTURAL del completo_hasta de la manifestacion citada. 🔴 NO ES DATO: es lo '
  'que vuelve FILA-LOCAL —y por lo tanto verificable con un check inmediato, inmune a la RLS— '
  'el invariante de frescura, que de otro modo cruza dos tablas y un check no lleva '
  'subconsulta. Mismas palabras y mismo idiom que tenant_node.parent_path (0017:133-138). '
  'Nadie lee el alcance DESDE aca: se lee de la manifestacion. Infalsificable por '
  'fk_recon_contrapartida_alcance. Nombre distinto del de la madre a proposito, para que se '
  'lea como espejo y no como copia — y ES EL UNICO ATRIBUTO QUE SE ESPEJA: cualquier otro '
  'atributo de padron_manifestacion es un join.';

comment on constraint contrapartida_frescura_chk on reconocimiento_contrapartida is
  'LA FRESCURA DE LA MANIFESTACION, fila-local. Una manifestacion no caduca por reloj (el '
  'tiempo no altera el padron): caduca porque el movimiento sea POSTERIOR a lo que abarca. '
  '⚠️ QUE GARANTIZA Y QUE NO: garantiza que el alcance CITADO cubre la fecha evaluada; NO '
  'garantiza que el alcance DECLARADO sea cierto — nada impide manifestar completo_hasta en '
  '2099. Misma figura que el enunciado probatorio de manifestado_por. 🔴 Y cubre UNA de las dos '
  'cosas que alteran una manifestacion: (b) que el movimiento sea posterior al alcance. Para '
  '(a) que cambie el conjunto de socios NO HAY MECANISMO — 0013:409-417 permite insertar socios '
  'y actualizar vigente_hasta despues de manifestado, y ninguna manifestacion se entera. '
  'Depende de resuelto_a_fecha not null y de la segunda mitad de '
  'contrapartida_manifestacion_chk: los tres son un paquete.';

comment on constraint contrapartida_estado_chk on reconocimiento_contrapartida is
  'Dominio cerrado. Lista IDENTICA a ESTADOS_RESOLUCION (packages/contabilidad/src/nucleo/'
  'tipos.ts), de la que se DERIVA el discriminante de ResolucionDeContraparte. Va sobre LOS '
  'SIETE, jamas sobre los alcanzables: literal 0014 decision 7. Hoy dos se llenan en la primera '
  'corrida, cuatro esperan que alguien cargue un socio, y es_tercero_padron_completo esta '
  'bloqueado por reconocer-lote.ts:288.';

comment on constraint contrapartida_promocion_chk on reconocimiento_contrapartida is
  'La promocion de capa C, fila-local. Verificado contra motor.ts:134-166: solo es_socio y '
  'es_tercero_padron_completo reescriben clase a propuesta; los otros cinco se quedan en '
  'decision_humana con la evidencia adjunta. Escrito como CASE y no como igualdad de booleanos '
  'a proposito: la forma (estado in (...)) = (clase = propuesta) daria verde a un padre '
  'sin_reconocer con un estado no promotor, y el padre de una contrapartida nunca puede ser '
  'sin_reconocer. Reemplaza a un check anterior que era INSATISFACIBLE: exigia manifestacion a '
  'retiro_de_socio, que sale de la rama es_socio, que no tiene manifestacion.';

comment on constraint contrapartida_manifestacion_chk on reconocimiento_contrapartida is
  'La manifestacion existe SI Y SOLO SI la resolucion uso el gate de padron completo, o sea '
  'solo en es_tercero_padron_completo. NO incluye sin_match_padron_incompleto: MEDIDO que esa '
  'forma rechaza el 100% de lo que el motor produce hoy y abortaria el primer lote. Ese estado '
  'ES la rama en la que el gate dio false, y hoy ese false es un literal: no hay manifestacion '
  'que citar. NULL aca significa, sin ambiguedad, QUE NO HUBO MANIFESTACION — no puede '
  'significar "la habia y no alcanzaba", porque el gate es un boolean pelado y '
  'ResolucionDeContraparte no tiene donde alojar cual se consulto. El not null de '
  'resolucion_estado es la mitad portante: sobre NULL este check da UNKNOWN y pasa. '
  '🔴 LA SEGUNDA MITAD (padron_completo_hasta) NO ES COSMETICA: ES EL BYPASS DEL CONTROL DE '
  'FRESCURA. Medido: con match simple —el default— un padron_manifestacion_id no nulo con el '
  'espejo en NULL ENTRA, porque la FK compuesta se saltea si alguna columna referenciadora es '
  'nula, y entonces contrapartida_frescura_chk evalua sobre NULL, da UNKNOWN y pasa. Sin este '
  'renglon el control de frescura se desactiva dejando una columna vacia. ⚠️ Y match full NO '
  'sirve para cerrarlo: con cliente_id (not null) adentro de la FK, "todas nulas" es '
  'inalcanzable, asi que match full deja la FK enforced siempre y rechaza el caso legitimo de '
  'las seis ramas sin manifestacion. En un esquema tenant-consistente, match full es '
  'inutilizable en cualquier FK opcional.';


-- -----------------------------------------------------------------------------
-- 5. `reconocimiento_contrapartida_match` (N2, satélite 0..N) — a qué socios matcheó
-- -----------------------------------------------------------------------------
--
-- `MatchDeContraparte[]` va a una satélite y no a un `uuid[]` en el padre por lo mismo que
-- `reconocimiento_candidato` (`0014:662-669`) y los candidatos de contraparte de `0013` §2,
-- PERO CON MÁS FUERZA QUE EN EL PRECEDENTE QUE LO FUNDÓ: allá el elemento era un id del
-- léxico, que es CÓDIGO y no podía tener FK; acá el elemento es `socio_id`, UNA FILA REAL de
-- `padron_socio`. Un `uuid[]` admitiría un match apuntando a un socio de OTRO CLIENTE sin que
-- nada falle.
create table reconocimiento_contrapartida_match (
  id                uuid primary key default gen_random_uuid(),
  cliente_id        uuid not null references tenant_node(id) on delete restrict,

  contrapartida_id  uuid not null,

  -- N2. Constante. No se puede escribir ni con el valor correcto. Mitad hija de la FK que
  -- vuelve IMPOSIBLE un match colgado de un estado que no admite matches.
  admite_matches    boolean generated always as (true) stored not null,

  -- N2. Escribible, pero no falsificable: la FK sólo encuentra padre si el valor coincide con
  -- el del padre, y el check mata `'sin_matches'`. ⚠️ El check es RED, no la garantía — ver el
  -- `comment on constraint`.
  regimen_matches   text not null,

  -- 🔴 N2. El socio del padrón contra el que matcheó un candidato. NUNCA la denominación ni el
  -- documento: la evidencia en pantalla es el uuid y la vía, nada más
  -- (`contrapartida.ts:70-75`). N2 y no N2-R a propósito — con N2-R esta tabla entraría sola en
  -- `tablasQueExigenRolEnLectura()` y la cola de revisión se volvería inusable.
  socio_id          uuid not null,

  -- N1. La FORMA del identificador que matcheó, no su valor — mismo criterio y misma
  -- clasificación que `movimiento_contraparte_identificador.clase`. Importa contablemente: el
  -- CUIT/DNI identifica A LA PERSONA; el CBU identifica UNA CUENTA, que puede estar a nombre de
  -- otro, ser conjunta o haber cambiado de titular, así que un match sólo por CBU es evidencia
  -- más débil y la persona tiene que verlo antes de aceptar.
  -- ⚠️ ANOTADA: hoy tiene UN SOLO VALOR ALCANZABLE, `'cuit'`, por construcción
  -- (`contrapartida.ts:189-191`). Va igual con su check sobre los tres —el estado de un valor
  -- es una afirmación sobre la evidencia del corpus, no sobre el dominio (`0014` decisión 7)—
  -- y va anotada, porque una columna que parece llevar información y lleva una constante es
  -- peor que no tenerla.
  match_clase       text not null,

  created_at        timestamptz not null default now(),

  -- Dominio cerrado. Lista IDÉNTICA a `CLASES_IDENTIFICADOR_CONTRAPARTE`
  -- (`packages/shared/src/seguridad/hmac-identificador.ts`), la misma que
  -- `mov_contraparte_clase_chk` de `0013`.
  constraint contrapartida_match_clase_chk
    check (match_clase in ('cuit', 'dni', 'cbu')),

  -- Dominio cerrado, subconjunto: los regímenes que ADMITEN matches.
  constraint contrapartida_match_regimen_chk
    check (regimen_matches in ('socio_unico', 'varios')),

  -- El mismo socio por la misma vía dos veces en la misma contrapartida no es un dato: es un
  -- bug del productor. `match_clase` VA EN LA CLAVE: el mismo socio puede matchear
  -- legítimamente por CUIT y por CBU, y esa diferencia es evidencia que la persona tiene que
  -- ver.
  constraint uq_recon_contrapartida_match_socio
    unique (cliente_id, contrapartida_id, socio_id, match_clase),

  -- (10) de la plantilla ampliada.
  constraint uq_recon_contrapartida_match_tenant unique (cliente_id, id),

  -- (11) FK COMPUESTA de TRES columnas: mismo cliente Y un padre que ADMITE matches. Es la que
  -- rechaza POR MECANISMO — ver el comment de `admite_matches` en el padre.
  constraint fk_recon_contrapartida_match_padre
    foreign key (cliente_id, contrapartida_id, admite_matches)
    references reconocimiento_contrapartida (cliente_id, id, admite_matches)
    on delete restrict,

  -- (11) otra vez, por VALOR: el régimen declarado es el del padre.
  constraint fk_recon_contrapartida_match_regimen
    foreign key (cliente_id, contrapartida_id, regimen_matches)
    references reconocimiento_contrapartida (cliente_id, id, regimen_matches)
    on delete restrict,

  -- 🔴 (11) otra vez, y es LA RAZÓN DE SER de la satélite frente a un `uuid[]`: el socio existe
  -- y es de ESTE cliente. ⚠️ Medido que NO filtra existencia cross-tenant: un socio de otro
  -- cliente y un socio inexistente dan el MISMO error, y Postgres SUPRIME los valores del
  -- DETAIL cuando el escritor no ve las filas.
  constraint fk_recon_contrapartida_match_socio
    foreign key (cliente_id, socio_id)
    references padron_socio (cliente_id, id)
    on delete restrict
);

-- 🔴 LA CARDINALIDAD DE `es_socio`, EN LA BASE. Índice único PARCIAL, mismo idiom que
-- `uq_recon_vigente` (`0014:479`) y `uq_padron_socio_vigente` (`0013:363`).
create unique index uq_recon_contrapartida_match_socio_unico
  on reconocimiento_contrapartida_match (cliente_id, contrapartida_id)
  where regimen_matches = 'socio_unico';

comment on index uq_recon_contrapartida_match_socio_unico is
  'GARANTIZA: bajo es_socio (regimen_matches = socio_unico) hay A LO SUMO UNA fila de match. '
  'Existe porque un es_socio con dos socios distintos es el error SIN DETECTOR AGUAS ABAJO: '
  'capa D imputaria a la cuenta particular de uno mientras la evidencia exhibe dos. La '
  'conciliacion bancaria NO LO VE —la cuenta Banco queda identica, el importe es correcto y el '
  'balance cierra; el error esta del otro lado del asiento— y a diferencia del error inverso '
  '(un tercero tratado como socio, que el socio mismo reclama al ver su saldo), ESTE NO TIENE '
  'QUIEN LO RECLAME: sobrevive hasta el cierre, o mas. '
  '⚠️ PRECIO CONOCIDO Y ACEPTADO A OJOS ABIERTOS: "<=1 SOCIO distinto entre N filas" NO ES '
  'EXPRESABLE como unique en PostgreSQL (medido por las dos formas posibles). Este indice '
  'garantiza "<=1 FILA". La diferencia es un mismo socio matcheando por DOS VIAS (CUIT y CBU): '
  'un solo socio, dos filas, RECHAZADO con 23505. Se acepto porque hoy es ESTRUCTURALMENTE '
  'INALCANZABLE, no improbable: padron_socio.documento_hmac usa el dominio de hash cuit_cuil '
  '(0013:294) y solo un candidato de clase cuit produce ese dominio (0013:257-259, '
  'contrapartida.ts:188-191). ⚠️ uq_mov_contraparte_candidato NO es el guardian de esto: lleva '
  'clase en la clave (0013:191-192) y admitiria dos filas con el mismo hmac y distinta clase. '
  '🔴 SI ESTE INDICE DISPARA, alguien cambio el dominio de hash del padron — y eso exige una '
  'migracion. La respuesta correcta es DECIDIR COMO SE EXHIBE UN MATCH MULTI-VIA y rediseñar el '
  'regimen; NO es borrar el indice, ni relajarlo, ni DEDUPLICAR EN LA APLICACION para que pase. '
  'Deduplicar seria registrar menos de lo observado sin decirlo, que es peor que no tener el '
  'indice: la contadora veria una via creyendo que es toda la evidencia. El aborto es el '
  'detector; el silencio no lo es. '
  'LO QUE NO GARANTIZA: que exista AL MENOS una fila. Un es_socio sin matches se ataja en la '
  'lectura (ContrapartidaEsSocioSinMatchError), no aca. Indice (<=1) + excepcion de lectura '
  '(>=1) = exactamente 1. Y no aplica a multiples_socios ni a socio_fuera_de_vigencia, donde '
  'varias filas son el hecho. '
  '🔴 ESTE INDICE NO SE SOSTIENE SOLO, y esto se descubrio por barrido de mutaciones: es PARCIAL '
  '(where regimen_matches = socio_unico), asi que una hija que DECLARE varios bajo un padre '
  'es_socio queda FUERA del predicado y podria meter dos socios distintos. La FK booleana pasa '
  '(el padre admite matches) y contrapartida_match_regimen_chk pasa (varios esta en el dominio). '
  'Lo unico que cierra ese bypass es fk_recon_contrapartida_match_regimen, que ata el regimen '
  'declarado por la hija al del padre. Esa FK NO es un cinturon: junto con este indice ES la '
  'cardinalidad. Sacarla deja el error sin detector. '
  '🔴 EL VECTOR CONCRETO, medido: "on conflict (cliente_id, contrapartida_id) do nothing" PELADO no '
  'compila contra este indice -- es parcial, y sin el WHERE que matchee su predicado Postgres no lo '
  'toma como arbitro y aborta con "no hay restriccion unique o exclusion que coincida" antes de '
  'escribir nada. El vector real es la forma COMPLETA: '
  '"on conflict (cliente_id, contrapartida_id) where regimen_matches = ''socio_unico'' do nothing" '
  '-- ese WHERE es lo que hace que Postgres SI lo tome como arbitro, y ahi la colision se traga en '
  'silencio. Es el camino natural del que copia el idiom de escrituras.ts:458 (que usa ON CONFLICT '
  'correctamente para OTRO indice, uq_recon_determinante, NO parcial) y lo "arregla" agregandole el '
  'WHERE cuando la forma pelada le tira el error de arriba. El INSERT de esta tabla tiene que dejar '
  'subir el 23505, nunca ataparlo con ON CONFLICT en ninguna de las dos formas.';

-- (2)
create index idx_reconocimiento_contrapartida_match_cliente
  on reconocimiento_contrapartida_match(cliente_id);

-- NO se crea `(cliente_id, socio_id)` —el sentido inverso, «qué movimientos matchearon contra
-- este socio»—. Es una consulta que VA a existir (es el insumo de la revisión de un socio dado
-- de baja), pero todavía no existe: se agrega el día que se escriba, con su plan medido. Mismo
-- criterio, palabra por palabra, que `0014:727-730`.

-- (3)
create trigger trg_reconocimiento_contrapartida_match_cliente
  before insert or update of cliente_id on reconocimiento_contrapartida_match
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5).
alter table reconocimiento_contrapartida_match enable row level security;
alter table reconocimiento_contrapartida_match force  row level security;

-- (6)
create policy reconocimiento_contrapartida_match_sel
  on reconocimiento_contrapartida_match for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) POR OPERACIÓN, nunca `for all`.
create policy reconocimiento_contrapartida_match_ins
  on reconocimiento_contrapartida_match for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE, ni policy ni grant. `app_job` no recibe nada.
grant select on reconocimiento_contrapartida_match to app_request;
grant insert (cliente_id, contrapartida_id, regimen_matches, socio_id, match_clase)
  on reconocimiento_contrapartida_match to app_request;

comment on table reconocimiento_contrapartida_match is
  'Satelite N2 de reconocimiento_contrapartida: 0..N socios contra los que matchearon los '
  'candidatos de contraparte del movimiento, con la via por la que matchearon. Solo puede '
  'colgar de un estado que ADMITE matches (es_socio, multiples_socios, socio_fuera_de_vigencia) '
  'y eso es integridad referencial, no una convencion. Va como satelite y no como uuid[] porque '
  'el elemento es una FILA REAL de padron_socio: un array admitiria un match apuntando a un '
  'socio de otro cliente sin que nada falle. NO lleva vigente_desde/vigente_hasta aunque '
  'MatchFueraDeVigencia los traiga: duplicarian un hecho MUTABLE cuya historia el sistema '
  'decidio no conservar, y expondrian la fecha de salida de cada ex-socio desde la tabla que se '
  'lista entera todos los meses.';

comment on column reconocimiento_contrapartida_match.socio_id is
  'N2. Seudonimo estable de una persona humana ligada a este cliente: opaco pero ENLAZABLE, la '
  'misma propiedad que pone a identificador_hmac en N2. Se distingue de movimiento_id (N1), que '
  'identifica una transaccion y no a alguien. Agregado por lineas de log daria el perfil de un '
  'socio real desde un almacen que no tiene RLS ni frontera de tenant. NO va tambien en el '
  'padre: esta MEDIDO que ningun mecanismo fila-local sostiene la consistencia entre un '
  'padre.socio_id y el conjunto de esta tabla (check con subconsulta no existe; la FK '
  'satelite->padre vuelve inexpresables multiples_socios y socio_fuera_de_vigencia; la FK '
  'padre->satelite obliga a tirar match_clase y aun asi no atrapa un segundo socio distinto; y '
  'el trigger que cuenta valida el instante del insert del padre y nunca mas). Para es_socio el '
  'socio es unico POR CONSTRUCCION (contrapartida.ts:231-244) y un distinto-de-1 falla RUIDOSO '
  'en la lectura, que es donde el error es visible en vez de silencioso.';

comment on column reconocimiento_contrapartida_match.admite_matches is
  'Columna GENERADA CONSTANTE. No se puede escribir ni con el valor correcto: es la mitad hija '
  'de la FK de tres columnas que restringe el padre a los estados que admiten matches. Mas '
  'fuerte que default + check, donde la garantia depende de que el check siga diciendo lo mismo.';

comment on constraint contrapartida_match_regimen_chk on reconocimiento_contrapartida_match is
  'Dominio cerrado. Lista IDENTICA a REGIMENES_CON_MATCHES (packages/contabilidad/src/nucleo/'
  'tipos.ts): los regimenes que ADMITEN matches. ⚠️ Es un SUBCONJUNTO del dominio de la generada '
  'del padre, que tiene tres valores (socio_unico, varios, sin_matches): se espeja lo que este '
  'check afirma, no el dominio completo. '
  '⚠️ ES RED, NO LA GARANTIA. Lo que impide que un match cuelgue de un estado sin matches es '
  'fk_recon_contrapartida_match_padre: MEDIDO que la FK de regimen SOLA no alcanza —el padre '
  'sin_candidatos existe con regimen_matches = sin_matches y la FK lo aceptaria— y que al mutar '
  'este check la fila ENTRA. La FK de la generada booleana lo rechaza por MECANISMO. Por eso '
  'admite_matches se conserva aunque regimen_matches parezca subsumirla. '
  '🔴 Y NO LEER ESTO COMO "la FK de regimen es prescindible": es al reves. Un barrido de mutaciones '
  'midio que fk_recon_contrapartida_match_regimen es lo UNICO que impide declarar varios bajo un '
  'padre es_socio para escaparse del indice parcial uq_recon_contrapartida_match_socio_unico y meter '
  'dos socios distintos. Los tres controles cubren cosas DISTINTAS y ninguno es redundante.';

comment on constraint contrapartida_match_clase_chk on reconocimiento_contrapartida_match is
  'Dominio cerrado. Lista IDENTICA a CLASES_IDENTIFICADOR_CONTRAPARTE '
  '(packages/shared/src/seguridad/hmac-identificador.ts), la misma que mov_contraparte_clase_chk '
  'de 0013. NO lleva cuil: un CUIT y un CUIL son el mismo numero y ningun extractor puede '
  'asignar esa etiqueta por forma. ⚠️ Hoy solo cuit es alcanzable (hmacDocumento canoniza al '
  'dominio cuit_cuil y padron_socio solo admite ese).';
