-- =============================================================================
-- 0018 — `app_request` puede COLGAR un nodo nuevo, pero no MOVER uno existente.
--
-- 🔴 Cierra ALTA-2 de la ronda de cierre de `0017`.
--
-- ## El agujero
--
-- `0017` §7 dejó a `app_request` con `update (parent_id, tipo, nombre, deleted_at, updated_at)`.
-- `parent_id` parecía inofensivo: la policy `tenant_node_wr` lo gatea con `has_role_on(parent_id)`,
-- así que un socio no puede colgar un nodo de un estudio ajeno.
--
-- Pero `trg_tenant_node_path_upd` (`0001:127`) **recalcula el `path` desde el padre** en cada
-- `update of parent_id`. O sea que `parent_id` es, de hecho, una vía de escritura del `path`.
-- Medido por `tester`, como socio, con `app_request`, sin el GUC y sin `reparentar_nodo()`:
--
--   update tenant_node
--      set parent_id = case id when <grupo> then <otro_nodo> else parent_id end
--    where path = '13.17' or path like '13.17.%';
--   -- UPDATE 4 / COMMIT / verificar_coherencia_path() = 0
--
-- Un subárbol de cuatro niveles relocalizado, coherente, **sin una sola fila en `acceso_auditoria`**.
-- El único rastro es `updated_at`. Es exactamente la operación que `ADR-0001` §8.2 declara como
-- `app_job` + `conJob('reparentar_nodo')`, ejecutada por el rol de la aplicación sin auditoría.
--
-- **Impacto de autorización, verificado punta a punta:** un `contador` con membresía SOLO sobre un
-- grupo veía 2 nodos; el socio movió un cliente bajo ese grupo; el contador pasó a ver 3, incluido
-- un cliente sobre el que no tiene membresía. No es cross-tenant —el `with check` confina el padre
-- nuevo al subárbol accesible— pero sí es una reasignación de visibilidad **interna** que nadie
-- autorizó y que no queda registrada.
--
-- 🔴 **Y es NO DETERMINÍSTICO**, que es lo que lo vuelve peor que un permiso de más. La misma
-- sentencia, sobre las mismas filas, con el mismo usuario:
--
--   orden físico del heap        resultado
--   padre antes que los hijos    COMMIT, árbol coherente
--   padre después                ERROR: viola tenant_node_parent_path_fk
--
-- Depende del orden en que el executor recorre el heap. Eso es la clase de bug que anda en
-- desarrollo y revienta en producción después de un `autovacuum`, en el camino más sensible que
-- tiene el esquema.
--
-- ## La decisión
--
-- **Colgar un nodo nuevo y mover uno existente son dos operaciones distintas, y sólo una es del
-- alcance de la aplicación.**
--
--   * `INSERT (… parent_id …)` — el alta de un cliente. La hace `app_request` y **se conserva**:
--     `packages/data/src/tenancy/escrituras.ts:120` la necesita, y colgar un nodo NUEVO no reasigna
--     la visibilidad de nada que ya existiera.
--   * `UPDATE (parent_id)` — mudar un nodo con su subárbol. **Se revoca para `app_request`.** Queda
--     exclusivamente en `app.reparentar_nodo()`, que corre con `app_job` vía `conJob`, deja motivo,
--     y es lo que `ADR-0001` §8.2 declaró desde el principio.
--
-- No es una restricción nueva: es hacer cumplir la que ya estaba escrita.
--
-- ## Por qué el `revoke` va a nivel tabla y después se re-otorga columna por columna
--
-- 🔴 `revoke update (parent_id) on tenant_node from app_request` sobre un grant de columna existente
-- **no lo saca**: hay que reconstruir la lista. Y peor, medido en la ronda del incidente #4:
-- `revoke update (col)` sobre un grant de TABLA es un **no-op silencioso** — la ACL queda idéntica,
-- sin error y sin warning. Por eso acá se revoca y se re-otorga, que es la única forma que deja el
-- estado que uno cree que deja.
-- =============================================================================

begin;

revoke update on tenant_node from app_request;

-- `parent_id` YA NO ESTÁ. El resto es igual que en `0017` §7.
grant update (tipo, nombre, deleted_at, updated_at) on tenant_node to app_request;

-- `app_job` conserva `parent_id` porque `app.reparentar_nodo()` corre con su identidad — no es
-- `security definer`. Y conserva `path`/`parent_path` por lo mismo. `nid` no lo escribe nadie.
-- Se re-declara entero para que la lista quede en un solo lugar y no haya que leer dos migraciones
-- para saber qué puede escribir cada rol.
revoke update on tenant_node from app_job;
grant update (parent_id, path, parent_path, tipo, nombre, deleted_at, updated_at)
  on tenant_node to app_job;

-- El INSERT no cambia: colgar un nodo nuevo sigue siendo del alcance de la aplicación.

commit;
