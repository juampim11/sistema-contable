-- =============================================================================
-- 0030_regla_imputacion.sql — D-29: las dos patas de `tipo_movimiento → cuenta_id`
--
-- Diseño cerrado en `docs/diseno/28-diseno-motor-clasificacion.md` §2 (ronda de cierre real,
-- 2026-08-31: `dba-data` + `contador-dominio` + `plan-cuentas-multicliente`, sesión de re-entrada
-- diurna) e implementado en la sesión nocturna autónoma inmediata siguiente, con convocatoria propia
-- de `dba-data` (diseño de esquema) + `security-engineer` + `seguridad-datos-financieros` (auditoría
-- de la forma antes de escribir el DDL). Retoma `docs/diseno/04-imputacion-contable.md` §8, nunca
-- reconciliado con `23`/`27` hasta esa ronda de cierre.
--
-- CERO conexión al piloto en el diseño ni en la aplicación de esta migración (sesión nocturna
-- autónoma, JP no disponible — límite duro de la sesión). Aplicada solo contra LOCAL.
--
-- ## Pata "contrapartida" — tabla nueva `regla_imputacion`
--
-- `rol_funcional` (D-29) se queda en sus 4 valores de identidad societaria — NUNCA se amplía con
-- conceptos contables. La resolución vive acá, por cliente, versionada por vigencia, retomando el
-- `cuentaResolucion: 'fija' | 'por_socio' | 'por_jurisdiccion' | 'por_impuesto'` de `04`§8.
--
-- Hallazgos incorporados de la convocatoria de esta noche, ninguno inventado:
--
-- - **FK compuesta tenant-consistente** en `cuenta_id` (`security-engineer`, R12): sin ella, RLS
--   filtra la LECTURA de la fila de regla, pero no impide que su contenido señale a la cuenta de otro
--   cliente.
-- - **`socio`/`contador`, nunca `administrativo`** en escritura (condición de cierre de
--   `contador-dominio` en D-29 §2, ratificada por `plan-cuentas-multicliente` y confirmada por
--   `security-engineer` y `seguridad-datos-financieros` como el precedente MÁS estricto de Capa D —
--   el mismo trato que `cuenta`/`cuenta_atributo`, no el de las otras seis tablas de `0027` que sí
--   admiten `administrativo`).
-- - **`UPDATE` solo por column-grant sobre `vigente_hasta`** (`security-engineer`): la disciplina de
--   "nunca pisar un valor" se hace mecánica, no solo documentada — mismo patrón que
--   `grant update (vigente_hasta, activa) on cuenta_atributo`.
-- - **Unicidad de vigencia abierta con `nulls not distinct`** (`security-engineer` +
--   `dba-data`, mismo mecanismo que `uq_cuenta_atributo_vigente`/`uq_padron_socio_vigente`): sin
--   ella, dos reglas con `concepto IS NULL` abiertas a la vez no chocan (`NULL ≠ NULL` en Postgres) y
--   el motor queda con ambigüedad permanente.
-- - **`decidido_por` nueva** (`security-engineer` H3 + `seguridad-datos-financieros`,
--   convergentes sin coordinarse): `cuenta_atributo` —el precedente que D-29 cita para la
--   gobernanza— no tiene columna de actor, a diferencia de TODO el resto de Capa D (`resuelto_por`,
--   `hecho_por`, `confirmado_por`, `dispensado_por`). Esta tabla decide a qué cuenta va la plata de
--   cada tipo de movimiento — impacto contable mayor que renombrar una cuenta — así que no se
--   propaga el hueco: se corrige acá, en un `create table` que todavía no existe.
-- - **`tipo_movimiento` y `concepto` son el MISMO dominio cerrado que `reconocimiento_movimiento`**
--   (`0014`, `TIPOS_MOVIMIENTO`/`CONCEPTOS_CANONICOS` de `packages/contabilidad/src/nucleo/`) — el
--   `CHECK` es copia literal del de `0014`, nunca una lista redactada a mano dos veces. `concepto` es
--   vocabulario CERRADO, no texto libre (resuelve la pregunta 3(c) que dejó abierta
--   `seguridad-datos-financieros`: no aplica el riesgo de inyección de comportamiento que señaló
--   `security-engineer` para un campo de texto libre, porque no lo es).
-- - **`rol_funcional_objetivo`** (no `tipo_movimiento` comparado contra un valor de rol): evita el
--   antipatrón que `04`§1.3 ya prohíbe para el banco ("`if (banco === 'galicia')`") — acá sería
--   "`if (tipo === rol)`". Solo acepta la familia ligada a socio (nunca `'generica'`), mismo criterio
--   de equivalencia que `cuenta_atributo_padron_socio_chk`.
--
-- ## BLOQUEADO, sin resolver esta noche — documentado, no inventado
--
-- - **`respaldo` sigue como prosa libre** (mismo patrón que `cuenta_atributo.respaldo`), heredando el
--   mismo hueco nunca cerrado del incidente #14 (`docs/seguridad/registro-incidentes.md`):
--   `seguridad-datos-financieros` (H1) señala que puede terminar citando un CUIT o un nombre de socio
--   sin que el mecanismo de clasificación por columna lo vea. Decisión entre "`respaldo` estructurado"
--   y "prosa libre + guardia de escritura" — **BLOQUEADO, necesita a JP**. No es un bloqueo nuevo de
--   esta tabla: es el mismo hueco de `cuenta_atributo.respaldo` que esta tabla, al copiar el patrón,
--   también hereda sin resolver.
-- - **`'por_jurisdiccion'`/`'por_impuesto'`**: declaradas en el dominio, SIN columnas de resolución
--   (ver `packages/data/src/cierre/tipos.ts`, `CUENTA_RESOLUCIONES`) — diseñar esas dos columnas
--   ahora sería inventar un mecanismo de negocio que ningún documento cerró (`dba-data`).
-- - **Unicidad de `cuenta_bancaria.cuenta_id`** (¿una cuenta contable puede ser destino de más de una
--   cuenta bancaria del mismo cliente?) queda SIN `unique` — `dba-data` no encontró documento que lo
--   confirme en ningún sentido.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `regla_imputacion` — pata "contrapartida" de D-29 (`04-imputacion-contable.md` §8)
-- -----------------------------------------------------------------------------
create table regla_imputacion (
  id                      uuid primary key default gen_random_uuid(),
  cliente_id              uuid not null references tenant_node(id) on delete restrict,

  tipo_movimiento         text not null,
  -- NULL = regla para todo el tipo_movimiento; con valor = override para un concepto puntual.
  concepto                text,

  cuenta_resolucion       text not null,
  -- Solo poblado cuando cuenta_resolucion = 'fija'.
  cuenta_id               uuid,
  -- Solo poblado cuando cuenta_resolucion = 'por_socio'.
  rol_funcional_objetivo  text,

  vigente_desde           date not null,
  vigente_hasta           date,
  -- Qué decisión acredita el alta/cambio — mismo patrón que cuenta_atributo.respaldo. BLOQUEADO
  -- (ver cabecera): sigue como prosa libre, mecanismo de guardia sin resolver, a cargo de JP.
  respaldo                text not null,
  -- Identidad declarada de quién dio de alta esta regla — nunca nulo (mismo criterio que hecho_por,
  -- incidente #5: "el nulo no es información, es camuflaje"). Hallazgo nuevo de esta convocatoria,
  -- no existe en `cuenta_atributo` (el precedente que D-29 cita) — no se propaga el hueco acá.
  decidido_por            uuid not null,
  creada_en               timestamptz not null default now(),

  constraint regla_imputacion_tipo_chk
    check (tipo_movimiento in (
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

  constraint regla_imputacion_concepto_chk
    check (concepto is null or concepto in (
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

  constraint regla_imputacion_resolucion_chk
    check (cuenta_resolucion in ('fija', 'por_socio', 'por_jurisdiccion', 'por_impuesto')),

  -- EQUIVALENCIA, no implicación (mismo argumento que cuenta_atributo_padron_socio_chk, 0027):
  -- 'fija' EXIGE cuenta_id; cualquier otra resolución LO RECHAZA si viene cargado por error.
  constraint regla_imputacion_cuenta_chk
    check ( (cuenta_resolucion = 'fija') = (cuenta_id is not null) ),
  constraint regla_imputacion_rol_chk
    check ( (cuenta_resolucion = 'por_socio') = (rol_funcional_objetivo is not null) ),
  constraint regla_imputacion_rol_valores_chk
    check (rol_funcional_objetivo is null
           or rol_funcional_objetivo in ('cuenta_particular_socio', 'aporte_de_socio',
                                          'retiro_de_socio')),

  constraint regla_imputacion_vigencia_chk
    check (vigente_hasta is null or vigente_hasta > vigente_desde),

  constraint uq_regla_imputacion_tenant unique (cliente_id, id),
  constraint uq_regla_imputacion_serie
    unique nulls not distinct (cliente_id, tipo_movimiento, concepto, vigente_desde),

  constraint fk_regla_imputacion_cuenta
    foreign key (cliente_id, cuenta_id) references cuenta (cliente_id, id) on delete restrict
);

create index idx_regla_imputacion_cliente on regla_imputacion(cliente_id);

-- Una sola vigencia ABIERTA por (cliente, tipo, concepto) — mismo mecanismo que
-- uq_cuenta_atributo_vigente / uq_padron_socio_vigente. `nulls not distinct` es imprescindible: sin
-- ella, dos filas con concepto IS NULL abiertas al mismo tiempo NO chocan y el motor queda con
-- ambigüedad permanente (security-engineer, esta convocatoria).
create unique index uq_regla_imputacion_vigente
  on regla_imputacion (cliente_id, tipo_movimiento, concepto) nulls not distinct
  where vigente_hasta is null;

create trigger trg_regla_imputacion_cliente
  before insert or update of cliente_id on regla_imputacion
  for each row execute function app.exigir_nodo_cliente();

alter table regla_imputacion enable row level security;
alter table regla_imputacion force  row level security;

create policy regla_imputacion_sel on regla_imputacion for select
  using ( cliente_id in (select app.accessible_tenant_ids()) );
  -- Abierta a todo el tenant (mismo criterio que cuenta/cuenta_atributo): administrativo necesita
  -- LEER a qué cuenta se imputa un tipo, aunque no pueda decidirlo.

-- Definir a qué cuenta imputa un tipo de movimiento es la misma clase de decisión que renombrar o
-- reclasificar una cuenta — nunca `administrativo` (condición de cierre de contador-dominio en D-29
-- §2, avalada por plan-cuentas-multicliente y confirmada como el precedente MÁS estricto de Capa D
-- por security-engineer/seguridad-datos-financieros).
create policy regla_imputacion_ins on regla_imputacion for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

-- UPDATE solo para CERRAR una vigencia (nunca reescribir tipo/concepto/resolución/cuenta de una serie
-- ya escrita) — mismo patrón exacto que cuenta_atributo_upd, mecanizado por column-grant abajo.
create policy regla_imputacion_upd on regla_imputacion for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );

grant select, insert on regla_imputacion to app_request;
grant update (vigente_hasta) on regla_imputacion to app_request;
-- Nunca a app_job: ningún camino de sistema tiene por qué escribir reglas de imputación contable
-- (security-engineer, mismo argumento que ya cerró el repo con 'ingesta_bancaria', CLAUDE.md §2.1).

comment on constraint regla_imputacion_tipo_chk on regla_imputacion is
  'Vocabulario cerrado, ver TIPOS_MOVIMIENTO (packages/contabilidad/src/nucleo/tipos.ts). Mismo '
  'dominio que reconocimiento_movimiento.tipo (0014) — copia literal del CHECK, no redactada a mano.';
comment on constraint regla_imputacion_resolucion_chk on regla_imputacion is
  'Vocabulario cerrado, ver CUENTA_RESOLUCIONES (packages/data/src/cierre/tipos.ts). '
  'por_jurisdiccion/por_impuesto declaradas sin columna de resolución todavía — D-29.';

-- -----------------------------------------------------------------------------
-- 2. `cuenta_bancaria.cuenta_id` — pata "banco" de D-29 (columna, no tabla nueva)
-- -----------------------------------------------------------------------------
--
-- Mapeo fijo 1:1 por cliente, sin vigencia (a diferencia de la pata contrapartida). `cuenta_bancaria`
-- ya tiene los siete renglones y su gobernanza de escritura YA es la pedida (`cuenta_bancaria_wr for
-- all`, `socio`/`contador`, nunca `administrativo`, 0004:146-150) — coincidencia verificada por
-- `dba-data`, no supuesta. La policy existente cubre la columna nueva sin tocarla.
alter table cuenta_bancaria add column cuenta_id uuid;

alter table cuenta_bancaria add constraint fk_cuenta_bancaria_cuenta_imputacion
  foreign key (cliente_id, cuenta_id) references cuenta (cliente_id, id) on delete restrict;

-- Sin `unique` sobre cuenta_id: si una cuenta contable puede ser destino legítimo de más de una
-- cuenta bancaria del mismo cliente es una pregunta de contador-dominio, no de esquema — BLOQUEADO,
-- ver cabecera. Se agrega en una migración aditiva si la respuesta es "no".

commit;
