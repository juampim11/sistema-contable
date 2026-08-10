-- =============================================================================
-- 0005_policies_sin_for_all.sql — cierra una clase de bug, no una instancia
--
-- ## Qué se descubrió
--
-- Las policies PERMISIVAS de Postgres se combinan con **OR**, y `for all` incluye SELECT. Por lo tanto,
-- en una tabla con lectura restringida, una policy de escritura `for all` que admita más roles que la de
-- lectura **anula la restricción de lectura**: el permiso más amplio gana.
--
-- Se descubrió corriendo el test de aislamiento del Módulo 1: el `administrativo` leyó las filas crudas
-- del cliente (los CUIT de las contrapartes, escenario H-8). La policy de lectura exigía
-- socio/contador/auditor y estaba **bien escrita**. Lo que la anulaba era la policy de escritura, que
-- admitía al administrativo porque ingestar es su trabajo.
--
-- El control se veía correcto leyendo la migración y no existía en la base.
--
-- ## Por qué esta migración toca `credencial_fiscal`, donde el bug NO se manifiesta
--
-- En `credencial_fiscal` (0002) las dos policies exigen `socio`, así que el OR no amplía nada: hoy no hay
-- fuga. Se cambia igual, y no por prolijidad.
--
-- La razón es que el patrón `for all` en una tabla con lectura restringida es una **bomba de tiempo con
-- fusible**: el día que alguien agregue un rol a la policy de escritura —un motivo perfectamente
-- razonable, como que el `contador` pueda cargar una credencial— la lectura se abre sola, sin que la
-- línea que se editó mencione la lectura en ningún lado. Y el test que lo detecta se agrega en esta misma
-- migración, así que dejar una excepción "que hoy no molesta" haría que el test naciera con una lista de
-- excepciones. Un test con excepciones deja de leerse.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- `credencial_fiscal`: se parte el `for all` en las tres operaciones.
--
-- El DELETE queda deliberadamente SIN policy: una credencial fiscal no se borra, se rota. La tabla
-- `credencial_fiscal_rotacion` es el rastro de eso, y borrar la credencial dejaría el rastro apuntando a
-- una fila que ya no existe.
drop policy credencial_fiscal_wr on credencial_fiscal;

create policy credencial_fiscal_ins on credencial_fiscal for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio']::app.rol_membership[]) );

create policy credencial_fiscal_upd on credencial_fiscal for update
  using      ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio']::app.rol_membership[]) )
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id, array['socio']::app.rol_membership[]) );

comment on table credencial_fiscal is
  'N3. Lectura: solo socio, y `material_cifrado` fuera del grant de app_request. Escritura declarada por '
  'operación (insert/update), NUNCA con `for all`: las policies permisivas se combinan con OR y un '
  '`for all` con más roles que la policy de lectura la anula sin mencionarla.';

commit;
