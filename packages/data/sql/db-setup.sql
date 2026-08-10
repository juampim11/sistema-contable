-- =============================================================================
-- db-setup.sql — usuarios de login LOCALES para los roles de la migración 0001
--
-- Los roles (`app_request`, `app_job`) los crea 0001_tenancy.sql SIN CONTRASEÑA: un secreto nunca va
-- al repo ni a una migración versionada. Este script crea los usuarios de login de ESTA máquina y
-- les asigna la contraseña que le pases por parámetro.
--
-- USO (las contraseñas salen de tu .env, NO están acá):
--
--   psql "$DATABASE_URL" \
--     -v app_user="$APP_DB_USER" -v app_pass="$APP_DB_PASSWORD" -v job_pass="$JOB_DB_PASSWORD" \
--     -f packages/data/sql/db-setup.sql
--
-- Se corre DESPUÉS de la migración 0001 y con el DUEÑO DEL ESQUEMA.
-- Es idempotente: se puede volver a correr para rotar la contraseña local.
--
-- EN UN ENTORNO REAL ESTO NO SE CORRE ASÍ: las contraseñas las emite el almacén de secretos del
-- proveedor (Secret Manager, Secrets Manager, variables del hosting) y se rotan desde ahí. Este
-- script existe para que `local` funcione sin inventar tooling. Ver ADR-0002 §E.
-- =============================================================================

\set ON_ERROR_STOP on

-- NOTA DE psql: las variables `:'x'` NO se interpolan dentro de un bloque `DO $$ ... $$` — psql no
-- sustituye adentro de una cadena entre comillas (y `$$` lo es), así que el `:` llega al servidor y
-- es un error de sintaxis. Se resuelve con `\gexec`: se ARMA el comando con format() y psql ejecuta
-- el texto resultante. (Salió de correr esto de verdad, no de suponerlo.)

-- 1. Usuario de login para el rol de REQUEST (sujeto a RLS).
--    Es miembro de app_request: hereda sus privilegios. NO hereda atributos (no tiene BYPASSRLS),
--    que es exactamente lo que queremos: las políticas se le aplican.
select format('create role %I login', :'app_user')
 where not exists (select 1 from pg_roles where rolname = :'app_user')
\gexec

select format('alter role %I password %L', :'app_user', :'app_pass')
\gexec

select format('grant app_request to %I', :'app_user')
\gexec

-- 2. Contraseña del rol de JOBS.
--    `app_job` es EL rol que se conecta (tiene LOGIN y BYPASSRLS propios): los atributos de rol no
--    se heredan por pertenencia, así que no sirve un usuario "miembro de app_job" — no tendría el
--    bypass. Ver el comentario largo en 0001_tenancy.sql §5.
select format('alter role app_job password %L', :'job_pass')
\gexec

-- 3. Verificación: que quedó como esperamos, y no al revés.
--    app_request debe tener rolbypassrls = false. Si esto sale en true, el aislamiento no existe.
select
  rolname,
  rolcanlogin  as puede_conectarse,
  rolbypassrls as saltea_rls
from pg_roles
where rolname in ('app_request', 'app_job', :'app_user')
order by rolname;

\echo ''
\echo 'Revisá la tabla de arriba: app_request y el usuario de request DEBEN tener saltea_rls = f.'
\echo 'Solo app_job puede tener saltea_rls = t.'
