-- =============================================================================
-- 0044_lote_ingesta_es_dato_real.sql — guard estructural: extracto real vs. fixture de desarrollo
--
-- Guard estructural: nada en el esquema distinguía "extracto real entregado por un cliente" de
-- "fixture/dato de prueba de desarrollo" en lote_ingesta -- hueco declarado en B.22
-- (docs/diseno/10-deuda-declarada.md), causante real de que el lote ae762fda (fixture de
-- desarrollo del adaptador de Macro) quedara mezclado en el piloto 21 dias (HANDOFF 199).
-- Precondicion de la vista de solo lectura de la Tanda 4 (docs/diseno/33-plan-deuda-pre-tanda-4.md A.2).
--
-- Convocatoria de seguridad PREVIA a esta migración (mismo protocolo que 0037-0043): `dba-data` +
-- `security-engineer` + `seguridad-datos-financieros`, en paralelo, sobre el diseño concreto de acá
-- abajo (guard-a2-lote-ingesta-es-dato-real).
--
-- CERO conexión al piloto: diseñada y aplicada solo contra LOCAL.
-- =============================================================================

begin;

-- DEFAULT constante en el ADD COLUMN es DDL puro: no pasa por RLS. Un UPDATE de backfill SI
-- quedaria sujeto a lote_ingesta_wr (force row level security activo, el dueño del esquema sin
-- BYPASSRLS) -- podria afectar 0 filas sin error (regla de dba-data: el backfill va por
-- ADD COLUMN ... DEFAULT, que es DDL y no pasa por las policies).
alter table lote_ingesta
  add column es_dato_real boolean not null default true;

alter table lote_ingesta
  alter column es_dato_real drop default;

comment on column lote_ingesta.es_dato_real is
  'true = extracto real entregado por el cliente; false = fixture/dato de prueba de desarrollo, '
  'nunca alimenta una medicion de produccion ni la vista de Tanda 4. NOT NULL sin default desde '
  'este punto: obliga a declararlo explicito en cada alta nueva (B.22).';

-- Inmutabilidad post-alta, dos capas (security-engineer + dba-data convergieron en paralelo, sin
-- verse entre si): el grant de 0004 es UPDATE a nivel TABLA COMPLETA, sin acotar columnas --
-- mismo patron que 0028 ya cerro como bloqueante para cierre_cliente_periodo/asiento_propuesto.
-- Sin esto, cualquier rol de escritura (socio/contador/administrativo via lote_ingesta_wr) podria
-- "blanquear" un lote de prueba despues del alta sin dejar mas rastro que el propio UPDATE.

revoke update on lote_ingesta from app_request;
grant update (
  estado, motivo_codigo, motivo_codigo_previo, archivo_clave, paginas_declaradas,
  paginas_sin_texto, filas_leidas, filas_aceptadas, filas_rechazadas, adaptador_version,
  banco_codigo, procesado_por
) on lote_ingesta to app_request;
-- Lista = exactamente las columnas que tocan los UPDATE legitimos de produccion hoy
-- (ingestar.ts, completar-lote.ts, recapturar-conceptos.ts) -- es_dato_real queda afuera a proposito.

create function app.impedir_cambio_es_dato_real() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  raise exception 'es_dato_real es inmutable una vez declarado (B.22)' using errcode = 'P0004';
end;
$$;

create trigger trg_lote_ingesta_es_dato_real_inmutable
  before update of es_dato_real on lote_ingesta
  for each row
  when (new.es_dato_real is distinct from old.es_dato_real)
  execute function app.impedir_cambio_es_dato_real();

commit;
