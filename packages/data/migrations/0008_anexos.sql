-- =============================================================================
-- 0008_anexos.sql — el bloque que NO son movimientos, y que hoy se descarta al procesar
--
-- ## Por qué ahora
--
-- Es lo único de la lista de E4 que **se pierde** en vez de encarecerse. `fila_origen` es por
-- MOVIMIENTO, y el anexo no es un movimiento: hoy el adaptador lo lee y `persistirCuenta` lo
-- tira. No hay de dónde recuperarlo salvo del archivo, y para el cliente de mayor volumen
-- puede no haber archivo: entrega en papel.
--
-- Y trae un renglón que **no existe como movimiento y no es derivable de ellos**: el importe
-- computable como pago a cuenta (Galicia `… CREDITO COMPUTABLE COMO PAGO A CUENTA`, Santander
-- `Importe susceptible de ser computado contra otros tributos`, Macro `D. 409/2018`).
--
-- ## Las tres cosas que este diseño se niega a inventar
--
--   1. **De qué cuenta es.** Galicia tiene una sola cuenta; Santander pone los dos bloques
--      DESPUÉS del último `Saldo total` de DOS cuentas; Macro atribuye `TOTAL COBRADO` (3) y
--      reparte `D. 409/2018` **0/2/1**, con uno cruzando el corte de página. `cuenta_bancaria_id`
--      es NULLABLE y `atribucion_cuenta` dice CUÁL de los tres casos es, para que "no sé de qué
--      cuenta es" no se pueda leer como "es del lote entero".
--   2. **Qué período cubre.** El bloque cubre períodos DISTINTOS del extracto (Galicia: tres).
--      Hay cuatro situaciones medidas, no dos. `periodo_dato` las separa. **El sistema NUNCA
--      rellena el período del anexo con el del extracto**: sería un hecho fiscal fabricado que
--      cuadra, la misma clase de error que una cotización completada con la de hoy.
--   3. **Si su importe ya está en el cuerpo.** Medido en Santander: el `Detalle impositivo`
--      resume los 21+19 `Impuesto ley 25.413` y los 8 `sircreb` que YA son movimientos.
--      `relacion_con_movimientos` lo persiste, y con eso "prohibido sumarlo" deja de ser una
--      prohibición no verificable y pasa a ser una condición sobre una columna (INV-15).
--
-- ## Lo que esta migración NO puede hacer, dicho para que nadie crea que sí
--
-- Ninguna barrera de Postgres impide un `union all` entre esta tabla y `movimiento_bancario_crudo`.
-- Lo que hay es: el nombre `importe_declarado` (un `sum(importe)` copiado NO compila), el importe
-- NO SIGNADO contra el signado del movimiento, `relacion_con_movimientos`, y **el test canario del
-- doble conteo, que es lo que de verdad lo sostiene**. Ver INV-15.
--
-- ## Los cuatro renglones extra de 0002 NO aplican
--
-- No hay columnas N2R ni N3. `concepto_literal` se mantiene en N2 por el check de identificador
-- de abajo: si fuera N2R, `tablasQueExigenRolEnLectura()` sumaría esta tabla y haría falta rol en
-- lectura, escritura por operación y lector auditado. Los renglones (10) y (11) sí van.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

create table anexo_extracto (
  -- (1) de la plantilla de ADR-0001 §5.
  id                  uuid primary key default gen_random_uuid(),
  cliente_id          uuid not null references tenant_node(id) on delete restrict,

  -- Cuelga del LOTE, no de la cuenta. Ver el punto 1 de la cabecera.
  lote_ingesta_id     uuid not null,

  -- NULLABLE a propósito, y solo cuando `atribucion_cuenta` lo autoriza.
  cuenta_bancaria_id  uuid,

  -- N1. Unión cerrada: por qué esta fila tiene (o no tiene) cuenta.
  atribucion_cuenta   text not null,

  -- N1. Ordinal 1-based en orden de lectura del documento. ES LA IDENTIDAD DE LA FILA:
  -- el anexo no tiene clave natural (ver el comentario de uq_anexo_orden).
  orden_en_lote       integer not null,

  -- N1. Hecho de la extracción. Para el `D. 409/2018` que cruza el corte de página, es la
  -- página donde arranca la ETIQUETA, no donde cae el importe.
  pagina_pdf          integer not null,

  -- N2. El rótulo TAL COMO lo imprime el banco. **No se normaliza**: Macro publica el mismo
  -- literal con dos espaciados distintos en el mismo archivo y esas son dos grafías reales.
  -- Normalizar para comparar es trabajo del léxico del Módulo 2, que es CÓDIGO.
  concepto_literal    text not null,

  -- N2. Nullable las dos. Ver el punto 2 de la cabecera y `periodo_dato`.
  periodo_desde       date,
  periodo_hasta       date,
  periodo_dato        text not null,

  -- N2. **NO se llama `importe`**, y no es cosmético: un `sum(importe)` o un `union all`
  -- copiado del query de movimientos no compila. Y es NO SIGNADO contra el importe signado del
  -- movimiento, así que una suma cruzada da basura visible en vez de un total plausible.
  importe_declarado   numeric(18,2) not null,
  moneda              char(3) not null default 'ARS',

  -- N2. **No es N1.** La intuición dice "una alícuota la fija el Estado", y el material la
  -- desmiente: el bloque `Tasas de Acuerdos y Descubierto` de Santander y los 44
  -- `Tasa Efec. Anual` de Macro NO son alícuotas legales — son la tasa que ese banco le cobra
  -- a ESE cliente por su descubierto. Es precio negociado. Se clasifica por el caso peor.
  -- Es el LITERAL publicado, no un número parseado: una tasa en float es el mismo error que un
  -- importe en float.
  alicuota_publicada  text,

  -- N1. Unión cerrada. Es lo que hace verificable el invariante del doble conteo (INV-15).
  relacion_con_movimientos text not null,

  created_at          timestamptz not null default now(),

  -- ---------------------------------------------------------------------------
  -- Dominios cerrados. La lista tiene que ser IDÉNTICA a la del código: ya divergieron dos
  -- veces (`acceso_auditoria.accion` en 0004, `tipo_cuenta` en 0006). Hay test de catálogo.
  -- ---------------------------------------------------------------------------
  constraint anexo_atribucion_chk
    check (atribucion_cuenta in ('publicada_por_cuenta', 'cuenta_unica_del_lote', 'no_determinada')),

  -- `cuenta_unica_del_lote` va SEPARADO de `publicada_por_cuenta` a propósito: la evidencia es
  -- distinta (aritmética del lote vs. el banco diciéndolo). El día que el banco de una sola
  -- cuenta mande un archivo de dos, la deducción deja de valer — y con un solo valor eso sería
  -- invisible.
  constraint anexo_atribucion_coherencia_chk
    check ((cuenta_bancaria_id is null) = (atribucion_cuenta = 'no_determinada')),

  constraint anexo_periodo_dato_chk
    check (periodo_dato in ('publicado_completo', 'publicado_solo_hasta',
                            'periodo_de_emision', 'no_publicado')),

  -- Las cuatro situaciones MEDIDAS. `periodo_de_emision` (el banco declara que es el período
  -- del extracto sin imprimir fechas: Santander SIRCREB) NO es lo mismo que `no_publicado`, y
  -- NINGUNO de los dos autoriza a copiar el período de `lote_ingesta_cuenta` a estas columnas.
  constraint anexo_periodo_coherencia_chk
    check (
      (periodo_dato = 'publicado_completo'
         and periodo_desde is not null and periodo_hasta is not null)
      or (periodo_dato = 'publicado_solo_hasta'
         and periodo_desde is null and periodo_hasta is not null)
      or (periodo_dato in ('periodo_de_emision', 'no_publicado')
         and periodo_desde is null and periodo_hasta is null)
    ),
  constraint anexo_periodo_orden_chk
    check (periodo_desde is null or periodo_hasta is null or periodo_hasta >= periodo_desde),

  constraint anexo_relacion_chk
    check (relacion_con_movimientos in ('resume_movimientos_del_cuerpo',
                                        'no_esta_en_los_movimientos',
                                        'no_determinada')),

  -- ---------------------------------------------------------------------------
  -- 🔴 EL CHECK QUE MANTIENE `concepto_literal` EN N2 Y NO EN N2R.
  --
  -- Es el equivalente del check de prefijo de 0007. Allá `concepto_banco` heredaba INV-13 por
  -- ser prefijo de `descripcion`; acá el literal NO TIENE PADRE del cual ser prefijo, así que la
  -- garantía se pone como puerta de admisión: ninguna corrida de 7+ dígitos entra.
  --
  -- Siete es la clase de identificador más corta de `glosa.ts` (documento de 7-8); tapa también
  -- CUIT (11) y CBU (22). MEDIDO contra los literales de los tres bancos: la corrida de dígitos
  -- más larga es de 5 (`25413`, `27743`, `2408`, `2018`) — las fechas van con separadores y las
  -- alícuotas con coma. No hay falso positivo en el material real.
  --
  -- Estructural, no convención: sobrevive a BYPASSRLS, a un COPY y a un bug de la aplicación.
  -- ---------------------------------------------------------------------------
  constraint anexo_literal_sin_identificador_chk
    check (concepto_literal !~ '[0-9]{7}'),

  constraint anexo_literal_no_vacio_chk check (btrim(concepto_literal) <> ''),
  constraint anexo_moneda_chk  check (moneda ~ '^[A-Z]{3}$'),
  constraint anexo_orden_chk   check (orden_en_lote > 0),
  constraint anexo_pagina_chk  check (pagina_pdf > 0),
  -- No signado, contra el importe SIGNADO del movimiento. Ver la cabecera.
  constraint anexo_importe_chk check (importe_declarado >= 0),

  -- ---------------------------------------------------------------------------
  -- Unicidad. **El anexo no tiene clave natural**, y forzar una rompe algo:
  --   * `(literal, periodo)` colisiona: Macro tiene 3 `TOTAL COBRADO` que pueden compartir período;
  --   * normalizar el literal para deduplicar borra la grafía impresa, que es dato medido;
  --   * y con `cuenta_bancaria_id` NULL un unique normal no dedupe nada, porque los NULL no
  --     comparan iguales — justo en las filas `no_determinada`, que son las que se repiten.
  --
  -- La identidad es la POSICIÓN en el documento. Y a diferencia de `filaHash` —de donde el
  -- ordinal se sacó por ser producto del parseo— acá el ordinal NO es clave de dedupe entre
  -- ingestas: esa la da `lote_ingesta.unique (cliente_id, archivo_hash)`. Solo tiene que ser
  -- estable dentro de un lote, que es una sola pasada del adaptador.
  -- ---------------------------------------------------------------------------
  constraint uq_anexo_orden unique (cliente_id, lote_ingesta_id, orden_en_lote),
  -- (10) de la plantilla ampliada: habilita una satélite futura sin migración destructiva.
  constraint uq_anexo_tenant unique (cliente_id, id),

  -- ---------------------------------------------------------------------------
  -- (11) FK COMPUESTAS. Van las DOS, y la primera no es redundante.
  --
  -- ⚠️ La segunda funciona con `cuenta_bancaria_id` NULL porque Postgres usa **MATCH SIMPLE**
  -- por defecto: si cualquier columna de la FK es NULL, la restricción no se evalúa. Es lo que
  -- queremos. **`MATCH FULL` rechazaría toda fila `no_determinada`** — no lo "mejores".
  --
  -- Y por eso hace falta la primera: para las filas sin cuenta es la ÚNICA que ata la fila a un
  -- lote del mismo cliente, que es la defensa de tenant que sobrevive a BYPASSRLS.
  -- ---------------------------------------------------------------------------
  constraint fk_anexo_lote
    foreign key (cliente_id, lote_ingesta_id)
    references lote_ingesta (cliente_id, id)
    on delete restrict,
  constraint fk_anexo_cuenta
    foreign key (cliente_id, lote_ingesta_id, cuenta_bancaria_id)
    references lote_ingesta_cuenta (cliente_id, lote_ingesta_id, cuenta_bancaria_id)
    on delete restrict
);

-- (2) de la plantilla: SIEMPRE, y con cliente_id primero porque la consulta siempre lo lleva.
create index idx_anexo_cliente on anexo_extracto(cliente_id);
create index idx_anexo_lote    on anexo_extracto(cliente_id, lote_ingesta_id);

-- DETECCIÓN de doble lectura, no dogma. El candidato natural es el `D. 409/2018` de Macro, que
-- **cruza el corte de página** (etiqueta en p1, su `(S.E.U.O.) <IMP>` en p2 después del
-- encabezado repetido): es el único elemento del documento que se parte entre páginas, y
-- `uq_anexo_orden` no lo atraparía porque el adaptador le daría dos ordinales distintos.
--
-- `nulls not distinct` es lo que lo hace servir: sin eso, las filas con `cuenta_bancaria_id`
-- NULL —las que más se repiten— nunca colisionarían.
--
-- MEDIDO: no dispara en ninguno de los tres bancos (las dos variantes de espaciado de Macro
-- difieren en el literal; los 3 `TOTAL COBRADO` difieren en la cuenta; los 5+2 de Santander y
-- los 9 de Galicia difieren en literal o período). Si algún día dispara sobre un archivo real,
-- se mira PRIMERO si el adaptador leyó dos veces; recién si el banco de verdad repite un
-- renglón idéntico se afloja, y con la medición escrita.
create unique index uq_anexo_sin_doble_lectura
  on anexo_extracto (cliente_id, lote_ingesta_id, concepto_literal, periodo_desde, periodo_hasta,
                     importe_declarado, cuenta_bancaria_id)
  nulls not distinct;

-- (3) el anexo cuelga de un nodo `cliente`, nunca de un `estudio`.
create trigger trg_anexo_cliente
  before insert or update of cliente_id on anexo_extracto
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5). El (5) le aplica las políticas también al dueño del esquema.
alter table anexo_extracto enable row level security;
alter table anexo_extracto force  row level security;

-- (6) lectura: sin chequeo de rol, porque no hay ninguna columna N2R. El contador lista los
-- anexos igual que los movimientos, sin ceremonia.
create policy anexo_sel on anexo_extracto for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) escritura declarada POR OPERACIÓN y no con `for all`, aunque la lectura no esté
-- restringida: el anexo es una transcripción del documento y el dato de origen no se altera
-- (ADR-0000), igual que `movimiento_origen_crudo`. De paso esquiva de raíz la trampa del
-- `for all`, que combina policies con OR e incluye SELECT.
--
-- El `administrativo` PUEDE insertar: ingestar es su trabajo.
create policy anexo_ins on anexo_extracto for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE para nadie: corregir un anexo mal leído es reprocesar el lote, no editar
-- lo que el documento decía.
grant select, insert on anexo_extracto to app_request;

-- app_job no recibe nada: la ingesta corre como app_request.

-- -----------------------------------------------------------------------------
-- Comentarios
-- -----------------------------------------------------------------------------

comment on table anexo_extracto is
  'El bloque posterior a la línea de totales: consolidado de retenciones e impuestos. NO son '
  'movimientos y NO se descartan — cubre períodos distintos del extracto y trae el renglón del '
  'importe computable como pago a cuenta, que no existe como movimiento. '
  'INV-15: solo `relacion_con_movimientos = no_esta_en_los_movimientos` es candidato a '
  'registración. Sumar el resto cuenta el impuesto DOS VECES y el asiento cuadra igual.';

comment on column anexo_extracto.cuenta_bancaria_id is
  'NULLABLE, y solo cuando `atribucion_cuenta = no_determinada`. La atribución del anexo a su '
  'cuenta NO es posicional: Macro reparte `D. 409/2018` 0/2/1 entre 3 cuentas y Santander pone '
  'los dos bloques después del último `Saldo total` de las dos.';

comment on column anexo_extracto.periodo_dato is
  'Cuál de las cuatro situaciones medidas es. `periodo_de_emision` (el banco declara que es el '
  'período del extracto sin imprimir fechas) NO es `no_publicado`. Ninguno de los dos autoriza '
  'a copiar el período del extracto: el bloque cubre períodos DISTINTOS.';

comment on column anexo_extracto.importe_declarado is
  'No se llama `importe` a propósito: un `sum(importe)` o un `union all` copiado del query de '
  'movimientos no compila. Y es NO SIGNADO contra el importe signado del movimiento.';

comment on column anexo_extracto.relacion_con_movimientos is
  'Convierte "prohibido sumarlo" —que nadie puede verificar— en una condición sobre una columna. '
  'Medido: el `Detalle impositivo` de un banco resume los impuestos que YA están como '
  'movimientos. `no_determinada` se trata como `resume_…` (fail-closed: no registrar de más).';

comment on constraint anexo_literal_sin_identificador_chk on anexo_extracto is
  'Equivalente del check de prefijo de 0007, donde no hay `descripcion` de la cual ser prefijo: '
  'puerta de admisión. Ninguna corrida de 7+ dígitos (documento, CUIT, CBU) entra al literal. Es '
  'lo que mantiene `concepto_literal` en N2 y la tabla fuera del régimen de lectura auditada.';

commit;
