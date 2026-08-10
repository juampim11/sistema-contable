-- =============================================================================
-- 0003_auditoria_correlacion.sql — id de correlación generado por la aplicación
--
-- POR QUÉ EXISTE ESTA MIGRACIÓN (y no una edición de la 0001, que ya está aplicada):
--
-- El choke point de auditoría usaba `insert ... returning id` para devolver el id de la fila y poder
-- correlacionarla con las líneas de log. **Eso no funciona con una tabla append-only.**
--
-- Verificado contra Postgres 16: `INSERT ... RETURNING` aplica también la política de **SELECT** a la
-- fila devuelta. `acceso_auditoria` es justamente la tabla donde muchos roles escriben y pocos leen
-- (la policy de lectura exige socio o auditor), así que un `contador` o un `administrativo` podían
-- insertar el rastro pero el `RETURNING` fallaba con:
--
--     ERROR: new row violates row-level security policy for table "acceso_auditoria"
--
-- El mensaje es engañoso —parece un `with check` rechazando la escritura— y la escritura estaba
-- perfecta: lo que falla es la lectura de vuelta. Sin RETURNING, el mismo insert entra sin problemas.
--
-- SOLUCIÓN: el id de correlación lo genera la APLICACIÓN (uuid) y se inserta explícito. No hace falta
-- leer nada de vuelta, y el que escribe ya conoce el valor para ponerlo en su log.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- Nivel N1: es un identificador opaco generado por nosotros, no un dato del cliente. Va al log.
alter table acceso_auditoria
  add column correlacion uuid not null default gen_random_uuid();

comment on column acceso_auditoria.correlacion is
  'Id de correlación GENERADO POR LA APLICACIÓN y insertado explícito. Existe porque `returning` no '
  'sirve en una tabla append-only: RETURNING aplica la policy de SELECT, y quien escribe el rastro '
  'normalmente no puede leerlo. El default es una red por si alguien inserta sin pasarlo.';

-- Unicidad POR CLIENTE, nunca global (R6).
create unique index uq_acceso_auditoria_correlacion on acceso_auditoria(cliente_id, correlacion);

commit;
