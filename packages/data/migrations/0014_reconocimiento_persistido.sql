-- =============================================================================
-- 0014_reconocimiento_persistido.sql — el reconocimiento del motor, persistido,
-- con su determinante y su cadena de supersesión
--
-- ## Qué habilita
--
-- El Módulo 2 ya reconoce (capa B) y resuelve contrapartida (capa C), pero todo vive en
-- memoria: cada corrida vuelve a clasificar los ~1830 movimientos del corpus y ninguna deja
-- rastro de QUÉ se propuso ni CON QUÉ VERSIÓN del motor. Sin esta tabla no hay cola de
-- revisión, no hay idempotencia (`05-motor-de-reconocimiento.md` §5.2) y no hay dónde colgar
-- el asiento propuesto (§5.1). Esta migración crea el registro y sus invariantes; NO crea
-- todavía `padron_manifestacion` ni `reconocimiento_contrapartida` (0015) ni
-- `asiento_propuesto` (0016+).
--
-- ## Las nueve decisiones de forma, con su motivo
--
--   1. UNA sola columna determinante: `motor_digest`, 16 hex. Reemplaza a los contadores
--      `lexico_version`/`catalogo_version` que preveía el diseño. Un contador manual falla
--      ABIERTO y EN SILENCIO: si nadie lo bumpea, "reprocesar con la misma versión es no-op"
--      protege ACTIVAMENTE un reconocimiento que ya es incorrecto. El digest lo calcula
--      `digestDeBanco()` (`packages/contabilidad/src/nucleo/version.ts`) sobre la proyección
--      semántica del léxico de ESE banco ⊕ las filas del catálogo alcanzables desde él ⊕
--      `VERSION_DEL_MOTOR`. Es POR BANCO: un banco nuevo con 20 conceptos que ningún léxico
--      de Galicia alcanza no puede invalidar un solo reconocimiento de Galicia. Mismo
--      algoritmo y misma longitud que el hash de una migración aplicada
--      (`packages/data/scripts/migrar.ts`) — es el precedente del repo para "identidad de un
--      artefacto de código", y dos formas distintas para la misma idea invitan a
--      confundirlas.
--
--   2. LA PROMOCIÓN DE CAPA C ES UNA FILA NUEVA, NUNCA UN UPDATE. `motor.ts:145-166`
--      REESCRIBE `clase` y `tipo` (`decision_humana`/`pago_a_proveedor_transferencia` →
--      `propuesta`/`retiro_de_socio`): no agrega un dato al costado. Un UPDATE de `clase`
--      flipearía la columna generada `es_propuesta` de `false` a `true` y satisfaría EN
--      SILENCIO la FK que 05 §5.1 diseñó justamente para impedir que un pendiente tenga un
--      asiento colgado. Por eso capa C inserta y supersede, y por eso 0014 nace con la
--      supersesión completa en vez de dejarla para después.
--
--   3. LA FK DE SUPERSESIÓN LLEVA TRES COLUMNAS, NO DOS. Con `(cliente_id, superseded_por)`
--      lo único garantizado es "el sucesor es del mismo cliente" — un reconocimiento podría
--      quedar superseded por el reconocimiento de OTRO movimiento del mismo cliente, y la
--      cadena de historia de ese movimiento se partiría sin que nada falle. Va
--      `(cliente_id, movimiento_id, superseded_por)` contra `uq_recon_movimiento_id
--      (cliente_id, movimiento_id, id)`: mismo idiom que la FK de tres columnas de 0004
--      (enmienda 3) y por el mismo motivo — es la única defensa que sobrevive a que la
--      policy no aplique.
--
--   4. Y ES LA ÚNICA FK `deferrable initially deferred` DE ESTA MIGRACIÓN. La promoción
--      corre en el orden UPDATE-de-la-vieja → INSERT-de-la-nueva, porque en el orden inverso
--      las dos filas tienen `superseded_por is null` a la vez y `uq_recon_vigente` las
--      rechaza. En ese orden, el `superseded_por` de la vieja apunta a un id que todavía no
--      existe: sin `deferrable`, la FK dispara antes del INSERT. El índice parcial NO
--      necesita ser diferido —y tampoco podría serlo, un índice único no admite
--      `deferrable`— porque la fila vieja SALE del predicado en el mismo UPDATE.
--
--   5. `reconocimiento_forma_chk` ES CONDICIONAL POR `(clase, motivo_codigo)`, NO NULIDAD
--      GRUPAL. Verificado con grep sobre `motor.ts`: la evidencia está AUSENTE en
--      `sin_evidencia_de_concepto` (:49), `ambiguo` (:55) y `concepto_no_catalogado` (:58);
--      PRESENTE en `concepto_sin_tipo_asignado` (:75) y `reversa_incoherente` (:90). Un
--      check de nulidad grupal ("o toda la evidencia o ninguna") daría verde a un `ambiguo`
--      con evidencia adjunta, que es exactamente el estado que 05 §6 prohíbe: la cola de la
--      contadora mostraría una "prueba" de un match que el motor NO hizo. Los otros dos
--      motivos (`codigo_no_catalogado`, `evidencia_contradictoria`) el motor NUNCA los
--      produce hoy —ningún adaptador del roster emite `conceptoCodigo` (H3)— y para ellos el
--      check exige nulidad grupal: es lo más fuerte que se puede afirmar sin inventar el
--      comportamiento de código que no existe.
--
--   6. LA COLUMNA SE LLAMA `motivo_codigo`, NO `motivo`. El repo ya pagó esa trampa: el tipo
--      del logger rechazó `motivo=ordenante_desconocido` porque `motivo` es un nombre
--      clasificado N2, y el ADR-0002 §C.0.bis lo dejó escrito. Es un CÓDIGO de un dominio
--      cerrado, no prosa, y el nombre tiene que decirlo.
--
--   7. `reconocimiento_tipo_chk` VA SOBRE LOS 31 VALORES DE `TIPOS_MOVIMIENTO`, no sobre los
--      "habilitados" de `ESTADO_DE_LOS_TIPOS`. `retiro_de_socio` y `aporte_de_socio` están
--      marcados `sin_evidencia_en_el_roster` y sin embargo `motor.ts:147` los produce por
--      capa C: un check derivado de los habilitados rechazaría TODA la capa C. El estado de
--      un tipo es una afirmación sobre la evidencia del corpus, no sobre el dominio.
--
--   8. `reconocimiento_concepto_chk` ES UN CHECK CON LOS 71 VALORES, NO UNA TABLA DE
--      REFERENCIA. Decisión explícita: se asume una migración por banco nuevo. El catálogo
--      es CÓDIGO (N0) y se construye incrementalmente por banco (P4 Galicia, P7 Santander,
--      P8 Macro); una tabla de referencia lo convertiría en dato mutable en runtime y abriría
--      la puerta a que el motor escriba en un espacio compartido — exactamente lo que 05 §7
--      cierra en la raíz para no volverse un oráculo cross-cliente (H-6).
--
--   9. `superseded_por` Y `recalculo_disponible` SON LAS ÚNICAS DOS COLUMNAS ACTUALIZABLES,
--      y el grant es POR COLUMNA. Un reconocimiento no se corrige: se supersede. Si `clase`
--      o `tipo` fueran actualizables, la promoción de capa C podría hacerse "más fácil" con
--      un UPDATE y la decisión 2 se perdería sin que nadie lo note.
--
-- ## Los cuatro renglones extra de 0002: cuáles aplican y cuáles no
--
-- NINGUNA de las dos tablas tiene una columna N2-R ni N3, así que (8) —chequeo de rol
-- también en LECTURA— NO aplica, y (9) es un `grant select` liso porque no hay nada N3 que
-- excluir. Es a propósito: el motor y la cola de revisión leen esto en cada pasada, y
-- meterlo en el régimen auditado llenaría el rastro de eventos que no dicen nada — el ruido
-- que destruye la capacidad de detectar el acceso masivo real (ADR-0002 H-8, mismo criterio
-- que la enmienda 1 de 0004 y que el bloque 2 de 0013).  (10) y (11) sí aplican y están.
--
-- ⚠️ ESTA MIGRACIÓN EXIGE, EN LA MISMA TAREA, UNA CONSTANTE NUEVA EN TYPESCRIPT.
--    `reconocimiento_clase_chk` tiene forma de dominio cerrado y HOY NO TENÍA constante que
--    lo espeje: `clase` era una unión de tipos en `reconocimiento.ts`, no un array en
--    runtime. El test de cobertura inversa de `packages/data/tests/catalogo.test.ts` ("todo
--    check con forma de dominio cerrado está en la tabla de pares") recorre la base entera y
--    se pone ROJO. Se declara `CLASES_RECONOCIMIENTO` en `packages/contabilidad/src/nucleo/
--    tipos.ts` y se DERIVA de ella el discriminante de `Reconocimiento` —no se repite la
--    lista—, y se agrega su fila en `DOMINIOS_CERRADOS`.
--
-- ⚠️ Y EXIGE MOVER LAS FILAS DE `dominios-pendientes.test.ts`. Los cuatro dominios que ese
--    archivo declaraba "sin check todavía" (`TIPOS_MOVIMIENTO`, `VIAS_EVIDENCIA`,
--    `QUE_DECIDE`, `MOTIVOS_SIN_RECONOCER`) YA TIENEN check acá: se mueven a
--    `DOMINIOS_CERRADOS`, se borran de allá, y se reemplaza la nota "⏳ TODAVÍA NO TIENE
--    CHECK EN LA BASE" de cada constante por la fórmula del repo. Se suman
--    `CONCEPTOS_CANONICOS`, `POLARIDADES`, `LADOS` y `CLASES_RECONOCIMIENTO`: son OCHO
--    dominios cerrados, no cuatro. (`LADOS` y `POLARIDADES` estaban fuera de TODAS las redes
--    —ni siquiera tenían la nota— así que nada habría notado que 0014 se escribiera sin sus
--    checks.)
--
-- ⚠️ Y EXIGE LAS DOS TABLAS EN `clasificacion-campos.ts`, con TODAS sus columnas —incluidas
--    las generadas `es_propuesta` y `reconocimiento_clase`. Sin eso el test de catálogo se
--    pone rojo (reglas 1 y 2 del registro). NO exige nada en `lectores-auditados.ts`: no hay
--    una sola columna N2-R acá, y agregarla sería declarar un lector que nadie usa.
--
-- ⚠️ `fk_recon_movimiento` ES `on delete restrict`: a partir de esta migración, un
--    movimiento que ya tiene un reconocimiento NO se puede borrar, y por lo tanto tampoco un
--    lote que lo contenga. Es el mismo régimen que ya imponen `movimiento_origen_crudo`
--    (0004) y `movimiento_contraparte_identificador` (0013), y es deliberado: un
--    reconocimiento superseded es la historia de lo que el motor propuso, y borrarlo por la
--    puerta de atrás de una re-ingesta la perdería. CAMBIO DE COMPORTAMIENTO OBSERVABLE,
--    confirmado por el titular: es coherente con el principio de "reprocesar, no editar" que
--    ya rige el resto del sistema.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `reconocimiento_movimiento` (N2) — qué dijo el motor, con qué versión, y qué lo
--    reemplazó
-- -----------------------------------------------------------------------------
--
-- ## Por qué N2 y no N2-R
--
-- `tipo` y `concepto` son una INTERPRETACIÓN del movimiento de un cliente ("esto es un pago
-- a un proveedor"), no el dato de un tercero: no hay acá ni un CUIT, ni una glosa, ni un
-- importe. La evidencia guarda el `id` de la entrada del léxico —que es CÓDIGO, N0— y nunca
-- el texto que matcheó (05 §6). Eso es lo que mantiene a esta tabla fuera del régimen de
-- lectura auditada, y es un requisito de que la cola de revisión sea usable: se lista entera,
-- todos los meses.
--
-- ## Por qué la evidencia vive en columnas planas y no en un `jsonb`
--
-- Un `jsonb` no admite un check por clave sin volverse ilegible, y las cuatro claves de
-- `EvidenciaDelMatch` son fijas desde que el tipo existe. Planas, `via` tiene su dominio
-- cerrado verificado contra `VIAS_EVIDENCIA` y la presencia/ausencia del grupo es
-- verificable por `motivo_codigo` — que es el invariante que esta migración existe para
-- sostener.
--
-- ## Una sola columna `via` para dos campos de TypeScript
--
-- `Reconocimiento.via` (nivel superior de `propuesta`/`decision_humana`) y
-- `EvidenciaDelMatch.via` son EL MISMO VALOR por construcción: `motor.ts:61-65` arma
-- `evidenciaDelMatch` con la misma `via` que devuelve el matcher y la copia a los dos
-- lugares. Persistirla dos veces sería crear la posibilidad de que difieran en la base sin
-- que difieran en el código.
create table reconocimiento_movimiento (
  -- (1) de la plantilla de ADR-0001 §5.
  id                 uuid primary key default gen_random_uuid(),
  cliente_id         uuid not null references tenant_node(id) on delete restrict,

  movimiento_id      uuid not null,

  -- N1. EL DETERMINANTE. 16 hex de `digestDeBanco(lexico)`. No es dato del cliente: es la
  -- identidad del artefacto de código que produjo esta fila. Ver el punto 1 de la cabecera.
  motor_digest       text not null,

  -- N2. Cuál de las tres clases de `Reconocimiento` (05 §5). Tres, no dos más un booleano:
  -- son tres trabajos distintos para la persona.
  clase              text not null,

  -- La columna generada de 05 §5.1, literal. Existe para que `asiento_propuesto` (0016+)
  -- pueda referenciar `(cliente_id, reconocimiento_id, true)` y un asiento colgado de un
  -- pendiente sea IMPOSIBLE en la base, no improbable en la aplicación.
  es_propuesta       boolean generated always as (clase = 'propuesta') stored,

  -- N2. La interpretación. Presentes en `propuesta` y `decision_humana`, nulos en
  -- `sin_reconocer` — lo exige `reconocimiento_forma_chk`.
  tipo               text,
  concepto           text,
  polaridad          text,
  lado               text,

  -- N2. Qué decisión concreta le queda a la persona. Solo en `decision_humana`.
  que_decide         text,

  -- N2. Por qué no se pudo reconocer. Solo en `sin_reconocer`. `_codigo` y no `motivo` a
  -- propósito: ver el punto 6 de la cabecera.
  motivo_codigo      text,

  -- La evidencia (`EvidenciaDelMatch`). Grupo de cuatro columnas cuya presencia depende de
  -- `(clase, motivo_codigo)` — ver el punto 5 de la cabecera.
  via                             text,
  -- N2. `<banco>.<concepto>[.<matiz>]`. Es un identificador de CÓDIGO, pero determina el
  -- concepto del movimiento de un cliente tan directamente como la columna `concepto`: se
  -- clasifica por lo que revela, no por la forma que tiene.
  evidencia_entrada_lexico_id     text,
  -- N1. Cuántos caracteres del literal matchearon. Acotado por el largo del literal del
  -- léxico (N0), no por el de la glosa: no es un oráculo sobre el texto del cliente.
  evidencia_caracteres_matcheados integer,
  evidencia_hubo_cola             boolean,

  -- N1. Qué fila reemplazó a esta. `null` = esta es la vigente.
  superseded_por       uuid,

  -- N1. 🔴 Sin productor HOY, declarado a propósito: es lo que hace que un arreglo del
  -- léxico NO descarte en silencio el trabajo de la contadora (05 §5.2). El recálculo
  -- levanta la bandera; la persona opta.
  recalculo_disponible boolean not null default false,

  created_at         timestamptz not null default now(),

  -- ---------------------------------------------------------------------------
  -- Los OCHO dominios cerrados. Cada lista es IDÉNTICA a su constante de TypeScript y el
  -- test de catálogo las compara como conjunto contra `pg_constraint`.
  -- ---------------------------------------------------------------------------
  constraint reconocimiento_clase_chk
    check (clase in ('propuesta', 'decision_humana', 'sin_reconocer')),

  constraint reconocimiento_tipo_chk
    check (tipo in (
      'impuesto_debitos_creditos', 'comision_bancaria', 'iva_sobre_gasto_bancario',
      'percepcion_impositiva', 'interes_de_financiacion', 'interes_por_descubierto',
      'retencion_iibb_bancaria', 'pago_de_obligacion_fiscal', 'pago_de_haberes',
      'deposito_efectivo', 'extraccion_efectivo', 'transferencia_entre_cuentas_propias',
      'acreditacion_tarjeta', 'pago_a_proveedor_transferencia', 'retiro_de_socio',
      'pago_con_cheque_propio', 'cobranza_de_cliente', 'aporte_de_socio',
      'deposito_cheques_terceros', 'cheque_rechazado', 'indeterminado',
      'pago_tarjeta_corporativa', 'suscripcion_fci', 'rescate_fci', 'compra_con_tarjeta_debito',
      'debito_automatico_servicio', 'acreditacion_prestamo', 'cuota_prestamo',
      'compra_venta_de_divisas', 'movimiento_en_cero', 'reverso_de_movimiento')),

  constraint reconocimiento_concepto_chk
    check (concepto in (
      'impuesto_25413_sobre_debitos', 'impuesto_25413_sobre_creditos',
      'devolucion_impuesto_25413_sobre_creditos', 'comision_de_transferencia',
      'comision_de_acreditacion_de_haberes', 'comision_de_cheque_pagado',
      'comision_de_mantenimiento_de_cuenta', 'comision_de_extraccion',
      'iva_sobre_comision_bancaria', 'percepcion_iva', 'pago_a_proveedor_inmediato',
      'pago_con_transferencia_generico', 'transferencia_a_terceros', 'pago_a_proveedores_snp',
      'transferencia_cuentas_propias', 'acreditamiento', 'transferencia_recibida_de_terceros',
      'pago_a_organismo_fiscal_afip', 'anulacion_acreditamiento_firstdata',
      'extraccion_efectivo_autoservicio', 'pago_cheque_propio',
      'compra_con_tarjeta_debito_generica', 'rescate_fci', 'suscripcion_fci', 'pago_de_servicios',
      'debito_automatico_de_servicio', 'pago_tarjeta_corporativa_visa',
      'transferencia_cash_management', 'acreditacion_tarjeta_first_data_visa',
      'acreditacion_tarjeta_first_data_master', 'acreditacion_tarjeta_first_data_debito',
      'acreditacion_tarjeta_getnet', 'retencion_sircreb', 'credito_transferencia_online_banking',
      'pago_recibido_como_proveedor', 'echeq_recibido_debito', 'impuesto_de_sellos',
      'debito_automatico_generico', 'iva_21_regimen_transparencia_fiscal',
      'iva_10_5_regimen_transparencia_fiscal', 'percepcion_iva_rg_2408',
      'interes_por_descubierto_cobrado', 'deposito_de_efectivo',
      'transferencia_realizada_generica', 'pago_de_honorarios', 'snp_debito_directo',
      'transferencia_inmediata_generica', 'comision_gestion_de_cobertura',
      'comision_de_mantenimiento_de_cuenta_dolares', 'transferencia_macronline_debito',
      'transferencia_minorista_distinto_titular', 'pago_cheque_de_camara',
      'comision_de_deposito_o_rechazo_de_cheque', 'comision_administracion_de_valores',
      'comision_administracion_de_chequera', 'debito_fiscal_iva_basico',
      'retencion_iva_percepcion_macro', 'retencion_iibb_cordoba_renta_financiera',
      'pago_de_remuneraciones', 'acreditacion_cheque_remesas', 'deposito_canje_interno_fv',
      'cheque_devuelto_canje_interno', 'cheque_devuelto_remesas', 'cheque_canje_interno',
      'retiro_caja_ahorro', 'extraccion_efectivo_idcb_pyme',
      'transferencia_mo_ccdo_distinto_titular', 'transferencia_con_token', 'acreditacion_credin',
      'cheque_circuito_cerrado', 'transferencia_electronica_datanet')),

  constraint reconocimiento_polaridad_chk
    check (polaridad in ('normal', 'reversa')),

  constraint reconocimiento_lado_chk
    check (lado in ('debe', 'haber')),

  constraint reconocimiento_via_chk
    check (via in (
      'codigo_y_texto_concordantes', 'codigo_concepto', 'texto_literal_exacto',
      'texto_prefijo_unico', 'texto_prefijo_con_cola', 'texto_con_codigo_no_catalogado')),

  constraint reconocimiento_decide_chk
    check (que_decide in (
      'elegir_cuenta_de_pasivo_del_impuesto', 'confirmar_cuenta_propia_destino',
      'distinguir_tercero_de_socio', 'completar_con_liquidacion_del_adquirente',
      'confirmar_computo_de_credito_fiscal', 'elegir_jurisdiccion_de_la_retencion',
      'completar_con_liquidacion_de_la_tarjeta', 'confirmar_hipotesis_del_lexico')),

  constraint reconocimiento_motivo_chk
    check (motivo_codigo in (
      'concepto_no_catalogado', 'concepto_sin_tipo_asignado', 'codigo_no_catalogado',
      'evidencia_contradictoria', 'ambiguo', 'reversa_incoherente', 'sin_evidencia_de_concepto')),

  -- ---------------------------------------------------------------------------
  -- Forma del determinante. 16 hex EN MINÚSCULA, exacto: es lo que devuelve
  -- `createHash('sha256')...digest('hex').slice(0, 16)`. El check atrapa los dos modos de
  -- falla reales — el digest completo de 64 sin cortar, y una mayúscula de un `toUpperCase`
  -- de camino. Los dos entrarían sin error en una columna `text` y NUNCA matchearían contra
  -- el digest recalculado: cada corrida creería que el léxico cambió y reprocesaría todo,
  -- que es la falla EXACTAMENTE OPUESTA a la que el digest existe para evitar.
  --
  -- `text` y no `char(16)`: `char` rellena con blancos y `'abc '::char(16) = 'abc'` da true,
  -- así que un digest corto compararía igual a uno correcto. Y no `bytea`: el productor
  -- devuelve hex, y convertirlo de ida y vuelta agrega un paso donde equivocarse sin ganar
  -- nada — son 8 bytes de diferencia.
  -- ---------------------------------------------------------------------------
  constraint reconocimiento_digest_chk
    check (motor_digest ~ '^[0-9a-f]{16}$'),

  -- La forma de `EntradaLexico.id` (`<banco>.<concepto>[.<matiz>]`), verificada contra las
  -- 90 entradas de los tres léxicos del roster. Es la PUERTA DE ADMISIÓN que mantiene a esta
  -- columna en el lado del código: ninguna glosa —que lleva espacios y mayúsculas— entra.
  -- Mismo mecanismo que `padron_socio_denominacion_sin_identificador_chk` de 0013.
  --
  -- ⚠️ Es una condición de FORMA, no de PERTENENCIA: que el id EXISTA en el léxico no lo
  -- puede verificar la base (el léxico es código). Eso lo cierra `idDelLexico()` en
  -- `packages/contabilidad/src/nucleo/persistible.ts`, con `Set.has` contra los ids reales.
  constraint reconocimiento_entrada_lexico_chk
    check (evidencia_entrada_lexico_id ~ '^[a-z0-9_]+(\.[a-z0-9_]+){1,2}$'),

  -- Un match de 0 caracteres no es un match: sería un `texto_literal_exacto` contra el
  -- literal vacío, que ningún léxico puede declarar.
  constraint reconocimiento_caracteres_chk
    check (evidencia_caracteres_matcheados > 0),

  -- Una fila que se supersede a sí misma se ve vigente y superseded a la vez, y saca al
  -- movimiento del índice parcial para siempre: no volvería a tener reconocimiento vigente y
  -- nada fallaría. Los ciclos de largo 2+ NO son expresables en un check — quedan en la
  -- aplicación, que solo escribe hacia adelante.
  constraint reconocimiento_no_autosupersesion_chk
    check (superseded_por <> id),

  -- ---------------------------------------------------------------------------
  -- 🔴 EL CHECK QUE HACE QUE UNA FILA IMPOSIBLE SEA IMPOSIBLE.
  --
  -- Condicional por `(clase, motivo_codigo)` y no nulidad grupal. La tabla de presencia de
  -- evidencia está VERIFICADA contra `packages/contabilidad/src/nucleo/motor.ts`:
  --
  --   motivo                        evidencia   dónde
  --   ----------------------------- ----------- --------------
  --   sin_evidencia_de_concepto     AUSENTE     motor.ts:49
  --   ambiguo                       AUSENTE     motor.ts:55
  --   concepto_no_catalogado        AUSENTE     motor.ts:58
  --   concepto_sin_tipo_asignado    PRESENTE    motor.ts:75
  --   reversa_incoherente           PRESENTE    motor.ts:90
  --   codigo_no_catalogado          —           el motor NUNCA lo produce (H3)
  --   evidencia_contradictoria      —           el motor NUNCA lo produce (H3)
  --
  -- Para los dos últimos el check exige NULIDAD GRUPAL (todo o nada), y queda declarado acá:
  -- son los dos motivos que dependen de `conceptoCodigo`, que ningún adaptador del roster
  -- emite. Afirmar la presencia o la ausencia de su evidencia sería inventar el
  -- comportamiento de código que no existe; la nulidad grupal es lo más fuerte que se puede
  -- afirmar sin hacerlo. El día que un adaptador emita código, el motivo que se agregue cae
  -- en la rama `else` y entra con evidencia completa o sin nada — nunca a medias.
  --
  -- 🔴 ESTE CHECK ES UNA FOTO DE `motor.ts` DE HOY, Y FALLA CERRADO. Si mañana `ambiguo`
  -- empieza a llevar evidencia, el INSERT es rechazado con el nombre de este constraint —
  -- ruidoso, en el acto, y con el arreglo en una migración nueva (0014 no se edita). Es la
  -- dirección correcta del error: lo contrario sería un check laxo que deja pasar la fila
  -- incoherente y que nadie descubre hasta que la contadora ve una prueba de un match que no
  -- ocurrió. El test que mantiene las dos listas atadas vive en
  -- `packages/contabilidad/tests/forma-persistible.test.ts`.
  -- ---------------------------------------------------------------------------
  constraint reconocimiento_forma_chk check (
    case clase

      when 'propuesta' then
           num_nonnulls(tipo, concepto, polaridad, lado) = 4
       and que_decide    is null
       and motivo_codigo is null
       and num_nonnulls(via, evidencia_entrada_lexico_id,
                        evidencia_caracteres_matcheados, evidencia_hubo_cola) = 4

      when 'decision_humana' then
           num_nonnulls(tipo, concepto, polaridad, lado) = 4
       and que_decide    is not null
       and motivo_codigo is null
       and num_nonnulls(via, evidencia_entrada_lexico_id,
                        evidencia_caracteres_matcheados, evidencia_hubo_cola) = 4

      when 'sin_reconocer' then
           num_nonnulls(tipo, concepto, polaridad, lado) = 0
       and que_decide    is null
       and motivo_codigo is not null
       and case motivo_codigo
             when 'sin_evidencia_de_concepto' then
               num_nonnulls(via, evidencia_entrada_lexico_id,
                            evidencia_caracteres_matcheados, evidencia_hubo_cola) = 0
             when 'ambiguo' then
               num_nonnulls(via, evidencia_entrada_lexico_id,
                            evidencia_caracteres_matcheados, evidencia_hubo_cola) = 0
             when 'concepto_no_catalogado' then
               num_nonnulls(via, evidencia_entrada_lexico_id,
                            evidencia_caracteres_matcheados, evidencia_hubo_cola) = 0
             when 'concepto_sin_tipo_asignado' then
               num_nonnulls(via, evidencia_entrada_lexico_id,
                            evidencia_caracteres_matcheados, evidencia_hubo_cola) = 4
             when 'reversa_incoherente' then
               num_nonnulls(via, evidencia_entrada_lexico_id,
                            evidencia_caracteres_matcheados, evidencia_hubo_cola) = 4
             else
               num_nonnulls(via, evidencia_entrada_lexico_id,
                            evidencia_caracteres_matcheados, evidencia_hubo_cola) in (0, 4)
           end

      else false
    end
  ),

  -- ---------------------------------------------------------------------------
  -- IDEMPOTENCIA. "Reprocesar con la misma versión es no-op" (05 §5.2) se sostiene acá: un
  -- segundo INSERT con el mismo `(cliente, movimiento, digest, es_propuesta)` es rechazado
  -- por la base, no evitado por un `if` de la aplicación.
  --
  -- 🔴 `es_propuesta` VA COMO CUARTA COLUMNA, Y NO ES COSMÉTICO. Sin ella, la promoción de
  -- capa C sería IMPOSIBLE: capa C corre con el MISMO léxico y el MISMO digest que capa B
  -- (no lo toca), así que su fila nueva colisionaría siempre contra la de capa B. Es la
  -- columna generada la que las separa, porque capa C SOLO produce filas cuando promueve
  -- `decision_humana` → `propuesta` (`motor.ts:145-166`; los otros 5 estados de
  -- `ResolucionDeContraparte` devuelven el reconocimiento sin cambios y no insertan nada).
  --
  -- ⚠️ LÍMITE DECLARADO: dos corridas de capa C sobre el mismo movimiento con el mismo
  -- digest y un PADRÓN distinto —el socio se dio de alta entre una y otra— colisionan acá y
  -- la segunda es rechazada. Es fail-CLOSED y es correcto que lo sea hoy: el determinante de
  -- capa C incluye el estado del padrón, y ese determinante lo crea 0015
  -- (`padron_manifestacion`). Cuando exista, 0015 reemplaza esta unicidad por una que lo
  -- incluya. Hasta entonces, la promoción de un movimiento es de una sola vía y el error es
  -- ruidoso en vez de silencioso.
  -- ---------------------------------------------------------------------------
  constraint uq_recon_determinante
    unique (cliente_id, movimiento_id, motor_digest, es_propuesta),

  -- (10) de la plantilla ampliada.
  constraint uq_recon_tenant unique (cliente_id, id),

  -- 05 §5.1, literal. Destino de la FK de `asiento_propuesto`, que NO se crea acá (0016+):
  --   reconocimiento_es_propuesta boolean not null default true check (reconocimiento_es_propuesta),
  --   foreign key (cliente_id, reconocimiento_id, reconocimiento_es_propuesta)
  --     references reconocimiento_movimiento (cliente_id, id, es_propuesta)
  -- La unicidad va HOY porque una unique constraint no se puede agregar después sobre una
  -- tabla con datos sin un rewrite, y porque su ausencia haría que 0016 "resuelva" el
  -- problema con un check de aplicación.
  constraint uq_recon_propuesta unique (cliente_id, id, es_propuesta),

  -- Destino de la FK de los hijos que solo pueden colgar de una clase. Hoy:
  -- `reconocimiento_candidato` (solo `sin_reconocer`).
  constraint uq_recon_clase unique (cliente_id, id, clase),

  -- Destino de la FK de supersesión. Es la pieza del punto 3 de la cabecera: sin esta
  -- unicidad de tres columnas, la FK de supersesión no puede llevar `movimiento_id`.
  constraint uq_recon_movimiento_id unique (cliente_id, movimiento_id, id),

  -- (11) FK COMPUESTA tenant-consistente.
  constraint fk_recon_movimiento
    foreign key (cliente_id, movimiento_id)
    references movimiento_bancario_crudo (cliente_id, id)
    on delete restrict,

  -- (11) otra vez, y con TRES columnas: el sucesor es del mismo cliente Y DEL MISMO
  -- MOVIMIENTO. `deferrable initially deferred` por el orden UPDATE→INSERT (punto 4).
  constraint fk_recon_superseded
    foreign key (cliente_id, movimiento_id, superseded_por)
    references reconocimiento_movimiento (cliente_id, movimiento_id, id)
    on delete restrict
    deferrable initially deferred
);

-- 🔴 UN SOLO RECONOCIMIENTO VIGENTE POR MOVIMIENTO. Índice único PARCIAL: la fila superseded
-- sale del predicado, así que la historia completa convive sin pelearse con la unicidad.
-- Mismo idiom que `uq_padron_socio_vigente` de 0013 y por el mismo motivo — sin él, dos
-- corridas del motor dejarían dos reconocimientos vigentes del mismo movimiento y la cola de
-- revisión mostraría el mismo movimiento dos veces, con propuestas distintas y sin forma de
-- saber cuál rige. No va como `exclusion constraint` porque no hace falta rango; y no puede
-- ser `deferrable` —un índice único no lo admite— y no lo necesita: ver el punto 4.
create unique index uq_recon_vigente
  on reconocimiento_movimiento (cliente_id, movimiento_id)
  where superseded_por is null;

comment on index uq_recon_vigente is
  'Un solo reconocimiento vigente por movimiento. Índice único PARCIAL: la fila superseded '
  'sale del predicado y la historia convive. Sirve además a la consulta de la cola de '
  'revisión (where cliente_id = $1 and movimiento_id = any($2) and superseded_por is null).';

-- (2) de la plantilla. Es el renglón literal del ADR: `uq_recon_tenant` y
-- `uq_recon_movimiento_id` ya arrancan con `cliente_id` y lo cubrirían, pero la plantilla se
-- escribe entera para que nadie tenga que razonar sobre prefijos de índices ajenos para
-- saber si el renglón está. (`docs/diseno/10-deuda-declarada.md` §1.2 propone enmendar el
-- renglón; hasta que el ADR se enmiende, se cumple literal.)
create index idx_reconocimiento_movimiento_cliente on reconocimiento_movimiento(cliente_id);

-- NO se crea ningún índice más. Las dos consultas que existen —la cola de revisión y el
-- centinela de idempotencia— las sirven `uq_recon_vigente` y `uq_recon_determinante`. Sin
-- datos reales todavía en la tabla, un índice de acceso extra sería costo de escritura contra
-- una consulta que nadie midió: se agrega el día que la consulta exista, con su plan.

-- (3) el reconocimiento cuelga de un nodo `cliente`, nunca de un `estudio`.
create trigger trg_reconocimiento_movimiento_cliente
  before insert or update of cliente_id on reconocimiento_movimiento
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5). El (5) le aplica las políticas también al dueño del esquema.
alter table reconocimiento_movimiento enable row level security;
alter table reconocimiento_movimiento force  row level security;

-- (6) lectura sin chequeo de rol: ninguna columna N2-R, y la cola de revisión se lista
-- entera todos los meses.
create policy reconocimiento_sel on reconocimiento_movimiento for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) escritura declarada POR OPERACIÓN y NUNCA con `for all` (0005): las policies
-- permisivas se combinan con OR y `for all` incluye SELECT, así que una escritura que
-- admita más roles que la lectura la anula sin mencionarla.
--
-- El `administrativo` entra: correr el motor es clasificar, que es su trabajo (`0001_tenancy
-- .sql`: "carga y clasifica; NO confirma ni presenta"). Lo que el motor produce es una
-- PROPUESTA; confirmarla es otra tabla y otro rol.
create policy reconocimiento_ins on reconocimiento_movimiento for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

create policy reconocimiento_upd on reconocimiento_movimiento for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- SIN policy de DELETE para NADIE: un reconocimiento no se borra — se supersede. Es el
-- registro de qué propuso el motor y con qué versión, y borrarlo destruiría la única prueba
-- de por qué la contadora vio lo que vio.
grant select, insert on reconocimiento_movimiento to app_request;

-- 🔴 GRANT DE UPDATE POR COLUMNA. Es lo que hace estructuralmente imposible el atajo que la
-- decisión 2 de la cabecera prohíbe: sin privilegio sobre `clase` ni sobre `tipo`, la
-- promoción de capa C NO PUEDE hacerse con un UPDATE ni por error ni por apuro. El
-- privilegio de columna se chequea ANTES que la policy, así que esto no depende de RLS.
grant update (superseded_por, recalculo_disponible) on reconocimiento_movimiento to app_request;

-- app_job NO RECIBE NADA, y ESO es lo que lo detiene — no la policy. `app_job` tiene
-- BYPASSRLS: sus policies ni siquiera se evalúan. Lo único que lo para es la ausencia del
-- GRANT, que se chequea antes. El motor corre bajo `conUsuario`, como `app_request`, y no
-- hay ningún motivo de `conJob` que lo alcance (la unión de motivos es cerrada y no incluye
-- ninguno de reconocimiento, a propósito).

comment on table reconocimiento_movimiento is
  'Qué dijo el motor sobre un movimiento, con qué versión (motor_digest) y qué fila lo '
  'reemplazó (superseded_por). Append-oriented: nunca se borra y solo se actualizan dos '
  'columnas. N2 sin ninguna columna N2-R a propósito — la evidencia guarda el id de la '
  'entrada del léxico, que es CÓDIGO, nunca el texto que matcheó (05 §6).';

comment on column reconocimiento_movimiento.motor_digest is
  'N1. 16 hex de digestDeBanco(lexico) (packages/contabilidad/src/nucleo/version.ts): la '
  'proyección semántica del léxico de ESE banco, las filas del catálogo alcanzables desde él '
  'y VERSION_DEL_MOTOR. Determinante calculado, no contador manual: un contador que nadie '
  'bumpea deja la idempotencia protegiendo ACTIVAMENTE un reconocimiento ya incorrecto. '
  'Misma longitud y mismo algoritmo que el hash de una migración aplicada (migrar.ts).';

comment on column reconocimiento_movimiento.es_propuesta is
  'Columna GENERADA (05 §5.1, literal). Destino de la FK de asiento_propuesto (0016+), que '
  'vuelve imposible en la base un asiento colgado de un pendiente. Y cuarta columna de '
  'uq_recon_determinante: es lo único que separa la fila de capa B de la de capa C, que '
  'comparten digest.';

comment on column reconocimiento_movimiento.superseded_por is
  'N1. La fila que reemplazó a esta, del MISMO movimiento (FK de tres columnas). Se escribe '
  'ANTES de insertar la sucesora —por eso la FK es deferrable initially deferred— para que '
  'la vieja salga del predicado de uq_recon_vigente en el mismo statement.';

comment on column reconocimiento_movimiento.recalculo_disponible is
  'N1. Sin productor todavía. Es la contracara del 🔴 de 05 §5.2: un reconocimiento con '
  'decisión humana registrada NO se recalcula solo — se marca acá y la persona opta. Sin la '
  'columna, el día que exista el recálculo el camino de menor resistencia descarta en '
  'silencio el trabajo de la contadora.';

comment on column reconocimiento_movimiento.evidencia_entrada_lexico_id is
  'N2. El id de la entrada del léxico que matcheó (banco.concepto[.matiz]), NUNCA el texto '
  '(05 §6). Se clasifica N2 y no N1 pese a ser un identificador de código: determina el '
  'concepto del movimiento de un cliente tan directamente como la columna concepto.';

comment on constraint reconocimiento_clase_chk on reconocimiento_movimiento is
  'Dominio cerrado. Lista IDÉNTICA a CLASES_RECONOCIMIENTO (packages/contabilidad/src/nucleo/'
  'tipos.ts), de la que se DERIVA el discriminante de Reconocimiento en reconocimiento.ts. '
  'Tres clases y no dos más un booleano: son tres trabajos distintos para la persona (05 §5). '
  'Comparada como conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

comment on constraint reconocimiento_tipo_chk on reconocimiento_movimiento is
  'Dominio cerrado. Lista IDÉNTICA a TIPOS_MOVIMIENTO (packages/contabilidad/src/nucleo/'
  'tipos.ts): los 31 valores, NO los habilitados de ESTADO_DE_LOS_TIPOS. retiro_de_socio y '
  'aporte_de_socio están marcados sin_evidencia_en_el_roster y sin embargo motor.ts:147 los '
  'produce por capa C — un check derivado de los habilitados rechazaría toda la capa C. '
  'Comparada como conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

comment on constraint reconocimiento_concepto_chk on reconocimiento_movimiento is
  'Dominio cerrado. Lista IDÉNTICA a CONCEPTOS_CANONICOS (packages/contabilidad/src/nucleo/'
  'catalogo.ts). Va como CHECK y no como tabla de referencia: el catálogo es CÓDIGO (N0) y se '
  'construye incrementalmente por banco, así que se asume UNA MIGRACIÓN POR BANCO NUEVO. Una '
  'tabla de referencia lo volvería dato mutable en runtime y abriría la puerta a que el motor '
  'escriba en un espacio compartido (H-6). Comparada como conjunto contra pg_constraint por '
  'el test de catálogo de dominios cerrados.';

comment on constraint reconocimiento_polaridad_chk on reconocimiento_movimiento is
  'Dominio cerrado. Lista IDÉNTICA a POLARIDADES (packages/contabilidad/src/nucleo/tipos.ts). '
  'La polaridad es una INTERPRETACIÓN, no un hecho del documento: una reversa es el mismo '
  'tipo que su base con el lado invertido, nunca un tipo aparte (05 §4). Comparada como '
  'conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

comment on constraint reconocimiento_lado_chk on reconocimiento_movimiento is
  'Dominio cerrado. Lista IDÉNTICA a LADOS (packages/contabilidad/src/nucleo/tipos.ts). El '
  'lado sale de columnaOrigen (04 §2) y, a diferencia de la polaridad, es un hecho del '
  'documento. Comparada como conjunto contra pg_constraint por el test de catálogo de '
  'dominios cerrados.';

comment on constraint reconocimiento_via_chk on reconocimiento_movimiento is
  'Dominio cerrado. Lista IDÉNTICA a VIAS_EVIDENCIA (packages/contabilidad/src/nucleo/'
  'tipos.ts). La confianza ES la vía, sin score inventado (05 §2.1), y la lista está ordenada '
  'por precedencia: el código gana sobre el texto. Las tres vías basadas en código quedan '
  'declaradas pero inalcanzables hoy (H3: ningún adaptador emite conceptoCodigo). Comparada '
  'como conjunto contra pg_constraint por el test de catálogo de dominios cerrados.';

comment on constraint reconocimiento_decide_chk on reconocimiento_movimiento is
  'Dominio cerrado. Lista IDÉNTICA a QUE_DECIDE (packages/contabilidad/src/nucleo/tipos.ts). '
  'Son 8 y no 5: los 3 nuevos salieron del corpus real y los ratificó contador-dominio; cada '
  'uno protege una cuenta o una decisión distinta. Comparada como conjunto contra '
  'pg_constraint por el test de catálogo de dominios cerrados.';

comment on constraint reconocimiento_motivo_chk on reconocimiento_movimiento is
  'Dominio cerrado. Lista IDÉNTICA a MOTIVOS_SIN_RECONOCER (packages/contabilidad/src/nucleo/'
  'tipos.ts). La columna se llama motivo_codigo y no motivo a propósito: es un CÓDIGO de '
  'dominio cerrado, no prosa, y motivo es un nombre que el repo ya clasificó N2 (ADR-0002 '
  '§C.0.bis). Comparada como conjunto contra pg_constraint por el test de catálogo de '
  'dominios cerrados.';

comment on constraint reconocimiento_forma_chk on reconocimiento_movimiento is
  'La forma de cada clase, y la presencia de la evidencia CONDICIONADA POR MOTIVO. Verificada '
  'contra motor.ts: ausente en sin_evidencia_de_concepto (:49), ambiguo (:55) y '
  'concepto_no_catalogado (:58); presente en concepto_sin_tipo_asignado (:75) y '
  'reversa_incoherente (:90); nulidad grupal para codigo_no_catalogado y '
  'evidencia_contradictoria, que el motor NUNCA produce hoy (H3). Una nulidad grupal para '
  'todos daría verde a un ambiguo con evidencia adjunta: una prueba, en la cola de la '
  'contadora, de un match que el motor no hizo.';

comment on constraint reconocimiento_digest_chk on reconocimiento_movimiento is
  '16 hex en minúscula, exacto. Atrapa los dos modos de falla reales: el digest completo de '
  '64 sin cortar y una mayúscula de camino. Los dos entrarían sin error y ninguno matchearía '
  'nunca contra el digest recalculado — cada corrida creería que el léxico cambió y '
  'reprocesaría todo, la falla opuesta a la que el digest existe para evitar.';

comment on constraint fk_recon_superseded on reconocimiento_movimiento is
  'FK de TRES columnas: el sucesor es del mismo cliente Y DEL MISMO MOVIMIENTO. Con dos '
  'columnas lo único garantizado sería el cliente, y la cadena de historia de un movimiento '
  'podría quedar apuntando al reconocimiento de otro sin que nada falle. deferrable initially '
  'deferred porque la promoción escribe en el orden UPDATE-de-la-vieja e INSERT-de-la-nueva, '
  'que es el único orden que satisface uq_recon_vigente statement a statement.';

-- -----------------------------------------------------------------------------
-- 2. `reconocimiento_candidato` (N2, satélite 0..N) — a qué entradas del léxico apuntaba
-- -----------------------------------------------------------------------------
--
-- `Reconocimiento.candidatos` es un `readonly string[]` que SOLO existe en la variante
-- `sin_reconocer`. Va a una satélite y no a un `text[]` en el padre por lo mismo que los
-- candidatos de contraparte de 0013 §2: un array no admite FK, no admite unicidad por
-- elemento y no admite el check de forma por elemento — tres invariantes que acá sí se
-- pueden sostener.
--
-- ## `reconocimiento_clase` es una columna GENERADA CONSTANTE, no un default con check
--
-- Es la mitad hija de una FK de tres columnas contra `uq_recon_clase (cliente_id, id,
-- clase)`. Con `default 'sin_reconocer' + check`, un INSERT que declare explícitamente otro
-- valor es rechazado por el check — pero la garantía depende de que el check exista y siga
-- diciendo lo mismo. `generated always as (...) stored` es más fuerte: la columna NO SE PUEDE
-- ESCRIBIR, ni siquiera con el valor correcto (Postgres rechaza el INSERT con "cannot insert
-- a non-DEFAULT value into column"). Un candidato colgado de una `propuesta` o de una
-- `decision_humana` no es improbable: es imposible, y lo es por integridad referencial.
--
-- ## Lo que NO es un constraint acá
--
-- "`ambiguo` tiene 2+ candidatos" y "`sin_evidencia_de_concepto` tiene 0" son invariantes
-- ENTRE TABLAS: un check no lleva subconsulta, y el trigger que lo haría corre como quien
-- escribe sobre una tabla con `force row level security` —fail-open y fail-closed en el
-- mismo constraint según el rol— y hacerlo confiable exigiría SECURITY DEFINER, que R11
-- limita a dos funciones. Queda en la aplicación (una sola transacción escribe las dos
-- cosas) y en su test. Mismo razonamiento, palabra por palabra, que el bloque 2 de 0013.
create table reconocimiento_candidato (
  id                   uuid primary key default gen_random_uuid(),
  cliente_id           uuid not null references tenant_node(id) on delete restrict,

  reconocimiento_id    uuid not null,

  -- N1. Constante. No se puede escribir: ver la cabecera del bloque.
  reconocimiento_clase text generated always as ('sin_reconocer') stored,

  -- N2. Id de la entrada del léxico, nunca el texto. Misma clasificación y mismo motivo que
  -- `reconocimiento_movimiento.evidencia_entrada_lexico_id`.
  entrada_lexico_id    text not null,

  created_at           timestamptz not null default now(),

  constraint reconocimiento_candidato_entrada_chk
    check (entrada_lexico_id ~ '^[a-z0-9_]+(\.[a-z0-9_]+){1,2}$'),

  -- El mismo candidato dos veces en el mismo reconocimiento no es un dato: es un bug del
  -- productor. `matcher.ts:65` los desduplica por `Map` y los ordena, así que el ORDEN no es
  -- semántico y no se persiste — son un conjunto de empatados, no una lista de preferencia.
  constraint uq_recon_candidato_entrada
    unique (cliente_id, reconocimiento_id, entrada_lexico_id),

  -- (10) de la plantilla ampliada.
  constraint uq_recon_candidato_tenant unique (cliente_id, id),

  -- (11) FK COMPUESTA tenant-consistente, de TRES columnas: mismo cliente Y clase
  -- `sin_reconocer`. Es lo que vuelve imposible un candidato colgado de una propuesta.
  constraint fk_recon_candidato_reconocimiento
    foreign key (cliente_id, reconocimiento_id, reconocimiento_clase)
    references reconocimiento_movimiento (cliente_id, id, clase)
    on delete restrict
);

-- (2) de la plantilla.
create index idx_reconocimiento_candidato_cliente on reconocimiento_candidato(cliente_id);

-- NO se crea un índice `(cliente_id, entrada_lexico_id)` — el sentido inverso, "qué
-- movimientos quedaron ambiguos por esta entrada del léxico". Es una consulta que va a
-- existir (es el insumo del informe de promoción de 05 §7), pero todavía no existe: se
-- agrega el día que se escriba, con su plan medido.

-- (3)
create trigger trg_reconocimiento_candidato_cliente
  before insert or update of cliente_id on reconocimiento_candidato
  for each row execute function app.exigir_nodo_cliente();

-- (4) y (5).
alter table reconocimiento_candidato enable row level security;
alter table reconocimiento_candidato force  row level security;

-- (6)
create policy reconocimiento_candidato_sel on reconocimiento_candidato for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );

-- (7) por operación, nunca `for all`.
create policy reconocimiento_candidato_ins on reconocimiento_candidato for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[]) );

-- Sin UPDATE ni DELETE para nadie, ni policy ni grant: un candidato mal calculado no se
-- edita — se supersede el reconocimiento entero y los candidatos nuevos cuelgan de la fila
-- nueva. app_job no recibe nada.
grant select, insert on reconocimiento_candidato to app_request;

comment on table reconocimiento_candidato is
  'Satélite N2 de reconocimiento_movimiento: 0..N entradas del léxico a las que apuntaba un '
  'reconocimiento que NO se pudo resolver. Solo puede colgar de un sin_reconocer, y eso es '
  'integridad referencial (FK de tres columnas contra una columna generada constante), no una '
  'convención. Ids del léxico, nunca texto (05 §6).';

comment on column reconocimiento_candidato.reconocimiento_clase is
  'Columna GENERADA CONSTANTE. No se puede escribir ni con el valor correcto: es la mitad '
  'hija de la FK de tres columnas que restringe el padre a clase = sin_reconocer. Más fuerte '
  'que default + check, donde la garantía depende de que el check siga diciendo lo mismo.';

comment on constraint fk_recon_candidato_reconocimiento on reconocimiento_candidato is
  'FK de TRES columnas contra uq_recon_clase: mismo cliente Y clase sin_reconocer. Un '
  'candidato colgado de una propuesta o de una decision_humana es IMPOSIBLE en la base, '
  'incluso bajo BYPASSRLS, COPY o un bug de la aplicación.';

commit;
