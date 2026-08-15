-- =============================================================================
-- 0016 — El `path` de `tenant_node` no se puede dejar incoherente. NUNCA.
--
-- 🔴 CIERRA EL INCIDENTE #2 (`docs/seguridad/registro-incidentes.md`).
--
-- ## El agujero
--
-- `app.rechazar_path_manual()` (0001:131-144) deja editar el `path` a mano cuando el GUC
-- `app.reparentando` vale 'on'. Ese GUC es un *customized option* de namespace: CUALQUIER SESION
-- lo prende con `set_config`, sin privilegio asociado. No es un control de autorización — es una
-- bandera que enciende el propio atacante.
--
-- Y la policy `tenant_node_wr` (0001:322-327) valida QUIEN escribe y QUE PADRE declara, nunca EL
-- VALOR del `path`. Como `app.accessible_tenant_ids()` resuelve el subárbol POR PATH, un `path`
-- fabricado mueve un nodo de subárbol a efectos de RLS.
--
-- Reproducido: un socio empuja un cliente PROPIO al subárbol de otro estudio, y el socio ajeno
-- pasa a verlo y a leer sus movimientos. Cae N2 y también N2-R — y por un mecanismo distinto del
-- incidente #1: `has_role_on()` resuelve por path, así que NO se anula, SE SATISFACE
-- LEGITIMAMENTE. Y no es sólo lectura: `mov_crudo_wr` admite `socio` con update/delete, y
-- `membership_wr` le permite crearse una membresía que SOBREVIVE a corregir el path.
--
-- Es H-1 reabierta por la puerta que el propio trigger dejó: el comentario de 0001:118-125
-- describe esta misma fuga con todas las letras.
--
-- ## Por qué un CONSTRAINT TRIGGER DIFERIDO y no el `before update of path` que ya existe
--
-- Las dos razones están MEDIDAS, y las dos rompen la variante "obvia" del fix:
--
--   (1) `app.reparentar_nodo()` reescribe el `path` del subárbol ANTES de mover el `parent_id`,
--       así que hay un estado intermedio incoherente POR DISEÑO. Un chequeo inmediato aborta ahí,
--       incluso con CERO descendientes.
--   (2) Un `BEFORE ROW` no ve las filas que el mismo `UPDATE` acaba de modificar: cada
--       descendiente leería el `path` VIEJO de su padre. Un `UPDATE` masivo de subárbol es
--       intrínsecamente incompatible con la validación inmediata fila a fila.
--
-- `deferrable initially deferred` corre al COMMIT, con el árbol ya entero. El estado intermedio
-- puede ser incoherente; el final, no. Es exactamente el invariante que `verificar_coherencia_path()`
-- ya verifica — la diferencia es que ahora NO SE PUEDE ESCRIBIR, en vez de detectarse después.
--
-- Con esto, `app.reparentar_nodo()` NO SE TOCA, ni una línea. Y `rechazar_path_manual()` y el GUC
-- quedan tal cual: pasan a ser el mensaje temprano y claro ("usá app.reparentar_nodo()"), que es
-- ergonomía, no control. El GUC deja de ser una excepción a la INTEGRIDAD y pasa a ser, como debió
-- ser siempre, una excepción a la PROHIBICION.
--
-- ## Por qué re-lee la fila en vez de usar `new`
--
-- Un `AFTER` diferido ve la tupla del EVENTO, no la final. En `reparentar_nodo()` el nodo movido
-- genera dos eventos (primero `path`, después `parent_id`) y el primero es incoherente. Se re-lee
-- por id para ver el estado final de verdad.
--
-- ## 🔴 Por qué `not found` es una VIOLACION y no un no-op — EL PUNTO QUE CIERRA EL INCIDENTE
--
-- Este trigger NO es `security definer`, así que la RLS le aplica. Y el ataque consiste
-- justamente en escribir un `path` que saca la fila del subárbol propio: MEDIDO, el trigger recibe
-- `found = false`, porque **el atacante se auto-oculta la fila que acaba de escribir**. Si eso se
-- tratara como "nada que validar", el ataque pasaría igual, con el trigger instalado, con el
-- nombre correcto y enganchado a la tabla correcta.
--
-- Es la misma clase de bug que R10 en el incidente #1: el control existía, se ejecutaba, y medía
-- lo que no había que medir.
--
-- ## Sobre los mensajes de error
--
-- Llevan el uuid y NADA MAS. El `path` contiene `nid` (un bigint secuencial) y R25 lo prohíbe
-- fuera de la base. El uuid del registro y el código de error alcanzan para depurar (ADR-0002 §D).
-- Igual no deben propagarse crudos al cliente (R28).
--
-- ## Costo (medido, PostgreSQL 16, 4806 nodos)
--
--   `reparentar_nodo()` 801 nodos    ~74 ms -> ~75 ms   dentro del ruido
--   alta de UN cliente               +67 us
--   `accessible_tenant_ids()`        CERO — no toca lectura, no agrega columnas ni índices
--   `has_role_on()`                  CERO — idem
--
-- El reparentado no paga nada porque el costo dominante ya lo paga `verificar_coherencia_path()`
-- dentro de `reparentar_nodo()`. Y la guarda del bucle de hijos NO es micro-optimización: sin
-- ella, un alta masiva bajo un mismo padre es O(n^2) (medido: 442 ms -> 1286 ms, +191 %).
-- =============================================================================

begin;

create or replace function app.exigir_path_coherente() returns trigger
  language plpgsql
  -- R10 (incidente #1): `pg_temp` ULTIMO, y esquema calificado en todo el cuerpo.
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_path text;
  v_parent uuid;
  v_nid bigint;
  v_esperado text;
  v_hijo_malo uuid;
begin
  -- Estado FINAL de la fila, no la tupla del evento.
  select n.path, n.parent_id, n.nid
    into v_path, v_parent, v_nid
    from public.tenant_node n
   where n.id = new.id;

  -- 🔴 Falla cerrado: "no la veo" NO es "está bien". Ver el encabezado.
  if not found then
    raise exception 'tenant_node %: no se puede verificar la coherencia del path', new.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if v_parent is null then
    -- Raíz: el path es el nid solo (R15 — cada estudio es raíz).
    v_esperado := v_nid::text;
  else
    select p.path into v_esperado
      from public.tenant_node p
     where p.id = v_parent;
    if v_esperado is null then
      raise exception 'tenant_node %: no se puede verificar el padre', new.id
        using errcode = 'integrity_constraint_violation';
    end if;
    v_esperado := v_esperado || '.' || v_nid::text;
  end if;

  if v_path is distinct from v_esperado then
    raise exception 'tenant_node %: path incoherente con parent_id', new.id
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Y los hijos directos, SOLO si esta fila cambió de path: si no, quedaron colgando de un
  -- prefijo que ya no existe. Acotado a ese caso A PROPOSITO — ver el costo en el encabezado.
  if tg_op = 'UPDATE' and old.path is distinct from v_path then
    select h.id into v_hijo_malo
      from public.tenant_node h
     where h.parent_id = new.id
       and h.path is distinct from v_path || '.' || h.nid::text
     limit 1;
    if v_hijo_malo is not null then
      raise exception 'tenant_node %: el hijo % quedó con path incoherente', new.id, v_hijo_malo
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  return null;
end $$;

-- `create constraint trigger` no admite `or replace`. El `drop if exists` es seguro acá y NO
-- contradice el criterio de 0015: aquel prohibía dropear FUNCIONES con 49 policies colgando.
-- Un trigger nuevo no tiene dependientes.
drop trigger if exists trg_tenant_node_path_coherente on tenant_node;
create constraint trigger trg_tenant_node_path_coherente
  after insert or update of path, parent_id on tenant_node
  deferrable initially deferred
  for each row execute function app.exigir_path_coherente();

commit;
