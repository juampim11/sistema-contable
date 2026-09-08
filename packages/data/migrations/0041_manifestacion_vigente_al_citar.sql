-- =============================================================================
-- 0041_manifestacion_vigente_al_citar.sql — una `reconocimiento_contrapartida` nueva no puede
-- citar una `padron_manifestacion` YA REVOCADA como si estuviera vigente.
--
-- Convocatoria (CLAUDE.md §3.1/§3.2): dba-data + security-engineer, misma sesión que la
-- caracterización del gap (ver abajo), 2026-09-08. Diseño validado en vivo con una prueba de
-- mutación de 4 casos ANTES de esta migración; se formaliza acá y el mecanismo queda pineado por
-- `packages/data/tests/mutaciones-0041.test.ts`.
--
-- ## El gap, con línea de origen
--
-- `packages/data/migrations/0021_determinante_de_entrada_y_capa_c.sql`, `comment on column
-- padron_manifestacion.revoca_a`, lo dice con todas las letras: «REVOCAR NO RETIRA CITABILIDAD —
-- nada en el esquema impide que una fila de reconocimiento_contrapartida cite, vía
-- padron_manifestacion_id, el id de UNA MANIFESTACIÓN YA REVOCADA». Las dos FK que protegen esa
-- columna (`fk_recon_contrapartida_manifestacion`, `fk_recon_contrapartida_alcance`) verifican
-- EXISTENCIA y que el espejo `padron_completo_hasta` coincida — nunca VIGENCIA. Ese mismo
-- comentario deja pineado (no arreglado) el comportamiento en
-- `packages/data/tests/caracterizacion-manifestacion-revocada-citable.test.ts` (CARACT-1), y dice
-- textualmente que el día que se cierre, «el control correcto... tiene que ser un CHECK/trigger
-- sobre la fila citante..., nunca una policy de SELECT que oculte las revocadas». Esta migración
-- es ese día. CARACT-1 se reescribe A PROPÓSITO en la misma tarea, con su nueva aserción de
-- rechazo — el propio comentario de ese test lo pedía así.
--
-- `padron_manifestacion` es append-only y sin UPDATE/DELETE para nadie (0021 §3): una
-- manifestación errónea se supersede con una fila NUEVA (`revoca_a`), nunca se edita.
--
-- ## Por qué TRIGGER y no una unicidad parcial sobre `padron_manifestacion`
--
-- El invariante que hace falta no es una propiedad de UNA fila de `padron_manifestacion` (tipo
-- «a lo sumo una vigente») — eso ni siquiera es la regla de negocio: pueden coexistir varias
-- cadenas de manifestación en el tiempo, y lo único prohibido es CITAR una que YA tiene una
-- revocadora. Eso es una condición sobre una fila de OTRA tabla (`reconocimiento_contrapartida`)
-- EN EL INSTANTE DE CITARLA, mirando el estado de TODAS las filas de `padron_manifestacion` con
-- `revoca_a` apuntando al id citado. No es fila-local en ninguna de las dos tablas por separado,
-- así que ni un CHECK (sin subconsultas) ni un índice único (que sólo ve la fila que se inserta)
-- lo expresan. El escalón que le toca, siguiendo el orden de preferencia de la persona (tipo →
-- check → FK → unique → trigger → aplicación), es el trigger — mismo patrón que
-- `trg_reconocimiento_entrada_digest` (0021) y `trg_asiento_propuesto_cierre_no_terminal` (0040):
-- «un INSERT tiene que mirar el estado ACTUAL de otra tabla antes de entrar».
--
-- ## 🔴 SECURITY DEFINER — MEDIDO QUE HACE FALTA, no una preferencia de estilo
--
-- El primer instinto de esta migración fue evitarlo: este repo tiene el hábito medido de esquivar
-- `security definer` en triggers nuevos (`0040:129-136`, «Invoker, sin SECURITY DEFINER
-- (0027/R11)», y dos incidentes de `HANDOFF.md` con el mismo argumento — «R11 no se toca y no
-- hace falta ningún ADR»). Se intentó ACÁ TAMBIÉN: `padron_manifestacion_sel` no chequea rol, así
-- que bajo INVOKER cualquier rol con membresía sobre `new.cliente_id` ya ve, sin bypass, todas
-- las manifestaciones (vigentes y revocadas) de su propio cliente — en apariencia, invoker
-- alcanzaba, igual que en los dos precedentes.
--
-- 🔴 MEDIDO QUE NO ALCANZA, y por una razón distinta a RLS: `SELECT ... FOR UPDATE` (y `FOR
-- SHARE`) exige privilegio `UPDATE` sobre la tabla en Postgres, además de `SELECT` — INDEPENDIENTE
-- de RLS, se evalúa ANTES de que la policy se toque. Reproducido en vivo, con el trigger en modo
-- invoker: `app_request` (bajo `conUsuario`) muere con
--   `permission denied for table padron_manifestacion` (SQLSTATE 42501, `aclcheck_error`,
--   `aclchk.c:2812`)
-- exactamente en el `perform ... for update`, ANTES de llegar a evaluar una sola policy. Y
-- `app_request` NO PUEDE tener update sobre esta tabla: es la premisa que sostiene TODO 0021 —
-- `padron_manifestacion` nace sin policy y sin grant de UPDATE/DELETE para nadie, y esa ausencia
-- es lo que hace que `completo_hasta` sea inmutable y que la FK de alcance
-- (`fk_recon_contrapartida_alcance`) sea legítima. `packages/data/tests/grants-conjunto-cerrado.
-- test.ts` (R41) verifica esa ausencia como conjunto CERRADO. Otorgarle a `app_request` un
-- `update` de "atajo" —aunque fuera sobre una columna muerta, sólo para poder lockear— REABRIRÍA
-- justo el agujero que 0021 cerró y que R41 vigila. No es una opción.
--
-- La única forma de tomar el lock sin ese grant es que la SENTENCIA corra con privilegios que ya
-- lo tengan — el dueño del esquema, que es superusuario (verificado, `ayuda.ts`). Eso es
-- exactamente lo que hace `security definer`. Acá SÍ hace falta, a diferencia de los dos
-- precedentes que la evitaron: no es «más robusto», es la única forma de expresar el lock sin
-- otorgarle a `app_request` un privilegio que el propio 0021 decidió que nunca tuviera.
--
-- ## 🔴 El costo: la TERCERA `SECURITY DEFINER`, y R11 se actualiza en esta misma tarea
--
-- `packages/data/tests/catalogo.test.ts`, R11, es un `toEqual` literal:
-- `['accessible_tenant_ids', 'has_role_on']`. Esta función es la tercera, y R11 se actualiza para
-- incluirla — a diferencia de los dos incidentes de HANDOFF citados arriba, ACÁ SÍ HACE FALTA
-- (medido, no elegido), así que la resolución «R11 no se toca» no aplica esta vez. Se deja
-- declarado para que quien lo audite no asuma que la ampliación fue arbitraria: el motivo es el
-- `42501` de arriba, reproducible.
--
-- ## El guard cross-tenant, y por qué hace falta EXACTAMENTE PORQUE es `security definer`
--
-- Una `security definer` que corre como el dueño del esquema (superusuario, `BYPASSRLS`) deja de
-- estar sujeta a la RLS de `padron_manifestacion` mientras ejecuta: sin nada más, sería un oráculo
-- que le dice a CUALQUIER insert (de cualquier tenant, con cualquier rol) si una manifestación de
-- OTRO cliente está revocada. El guard replica EXACTAMENTE el predicado de
-- `reconocimiento_contrapartida_ins` (misma tabla de tenant/rol) ANTES de tocar el privilegio
-- elevado: si el insert no pasaría esa policy de todos modos, la función no mira nada y devuelve
-- `new` sin más — la policy REAL rechaza el intento después con `42501` genérico, sin que este
-- trigger haya revelado si la manifestación citada existe, está vigente o está revocada.
--
-- 🔴 Y hay una segunda barrera, independiente del guard, verificada en vivo: esta función
-- devuelve `trigger`, y Postgres RECHAZA llamar directo a una función que devuelve `trigger`
-- (`SQLSTATE 0A000`, «trigger functions can only be called as triggers») — no hay forma de
-- invocarla por fuera del disparo de un INSERT real sobre `reconocimiento_contrapartida`. El
-- `revoke`/`grant execute` de abajo es entonces defensa en profundidad —mismo estilo que
-- `0001`/`0015` con `accessible_tenant_ids`/`has_role_on`—, no la garantía portante: la garantía
-- portante es el guard (contra el oráculo) y el tipo `trigger` (contra la llamada directa).
--
-- ## Por qué `FOR UPDATE` y no `FOR SHARE` — MEDIDO, no supuesto
--
-- La carrera real: transacción A cita `X` (esta trigger, sobre `reconocimiento_contrapartida`);
-- transacción B, concurrente, REVOCA `X` insertando una `padron_manifestacion` nueva con
-- `revoca_a = X` (eso es *todo* lo que hace falta para revocar: `padron_manifestacion` es
-- append-only, revocar NUNCA toca la fila `X`, sólo inserta una fila que la referencia por FK).
--
-- 🔴 Esa FK (`fk_padron_manifestacion_revoca`, 0021 §3) es la pieza que cierra la carrera, y es la
-- clave de por qué hace falta `FOR UPDATE` específicamente: Postgres, al insertar una fila que
-- REFERENCIA a `X` por foreign key, toma automáticamente un lock `FOR KEY SHARE` sobre `X` — el
-- más débil de los cuatro (`FOR KEY SHARE` < `FOR SHARE` < `FOR NO KEY UPDATE` < `FOR UPDATE`).
-- Por la matriz de conflictos de locks de fila de Postgres, `FOR KEY SHARE` NO conflictúa con
-- `FOR SHARE` (dos locks de la familia «share» conviven sin bloquearse) y SÍ conflictúa con
-- `FOR UPDATE` y `FOR NO KEY UPDATE`. Consecuencia MEDIDA con las dos conexiones reales del
-- mutante M2 de `mutaciones-0041.test.ts`: si esta trigger toma `FOR SHARE` sobre `X`, el INSERT
-- de B (que revoca `X`, y por lo tanto sólo necesita `FOR KEY SHARE` sobre `X`) NO SE BLOQUEA —
-- entra y commitea igual mientras A sigue "pensando" — y la carrera se cuela: A decide con la
-- foto vieja («no está revocada») y cita `X` después de que `X` ya fue revocada. Con `FOR UPDATE`,
-- en cambio, el intento de B de tomar su `FOR KEY SHARE` sobre `X` SÍ conflictúa con el
-- `FOR UPDATE` que A ya tiene, y B queda bloqueado hasta que A termina — momento en el que la
-- cronología ya quedó resuelta sin corrupción (A citó primero, o A releyó después de que B
-- terminó). **El invariante no es "hace falta ALGÚN lock": es que hace falta específicamente el
-- ÚNICO nivel de lock que conflictúa con lo que el lado que revoca toma por mecanismo (una FK).**
-- Ninguna combinación más débil lo cierra, y eso es justo lo que M1 (sin ningún lock) y M2
-- (`FOR SHARE`) prueban por separado, con el mismo `pg_sleep` inyectado en el mismo punto para
-- que la ventana de la carrera sea determinística en el test.
--
-- ## Qué NO cierra esta migración, a propósito
--
-- No cierra CARACT-2 de la caracterización (el gap nunca cruzó tenant: sigue sin cruzar, las FK
-- de tenant-consistencia de `reconocimiento_contrapartida` no cambian acá). No agrega vigencia por
-- reloj (`padron_manifestacion.completo_hasta` sigue siendo la única noción de alcance — ver
-- `0021` §3). No toca la lectura ("elegir la manifestación vigente" en P5 sigue siendo una
-- convención de la aplicación, `order by completo_hasta desc limit 1`, no una garantía de la
-- base): esta migración cierra la ESCRITURA (citar una revocada), no la lectura.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

create or replace function app.exigir_manifestacion_vigente() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_revocada boolean;
begin
  if new.padron_manifestacion_id is null then
    return new;
  end if;

  if not (
    new.cliente_id in (select app.accessible_tenant_ids())
    and app.has_role_on(new.cliente_id, array['socio','contador','administrativo']::app.rol_membership[])
  ) then
    return new; -- deja que la policy de INSERT (que corre DESPUÉS) rechace la fila por tenant/rol.
  end if;

  -- LOCK PRIMERO, y el orden importa: si esto se reordenara a "leer y después lockear", la
  -- ventana entre las dos lecturas reabriría la misma carrera que este trigger existe para cerrar.
  perform 1
    from public.padron_manifestacion
   where cliente_id = new.cliente_id
     and id = new.padron_manifestacion_id
     for update;

  -- Con el lock ya tomado: si una transacción concurrente estaba revocando `X` (insertando una fila
  -- que referencia `X` por `fk_padron_manifestacion_revoca`, lo que toma `FOR KEY SHARE` sobre `X`),
  -- o bien ya terminó ANTES de que consiguiéramos el `FOR UPDATE` (y esta lectura la ve, fresca, por
  -- ser una sentencia nueva bajo READ COMMITTED) o bien todavía no había arrancado (y no puede
  -- arrancar hasta que soltemos el lock, así que no hay ambigüedad posible sobre el estado leído acá).
  select exists (
    select 1 from public.padron_manifestacion
     where cliente_id = new.cliente_id
       and revoca_a = new.padron_manifestacion_id
  ) into v_revocada;

  if v_revocada then
    raise exception
      'padron_manifestacion_id % ya fue revocada: no se puede citar como vigente',
      new.padron_manifestacion_id
      using errcode = 'P0004';
  end if;

  return new;
end;
$$;

comment on function app.exigir_manifestacion_vigente() is
  'Cierra el gap declarado en el comment on column padron_manifestacion.revoca_a de 0021: '
  '"REVOCAR NO RETIRA CITABILIDAD". BEFORE INSERT sobre reconocimiento_contrapartida — no sobre '
  'padron_manifestacion, que sigue sin UPDATE/DELETE para nadie y append-only. '
  '🔴 SECURITY DEFINER, MEDIDO QUE HACE FALTA (no preferencia de estilo, y contra el hábito de '
  'este repo de evitarlo — 0040:129-136, HANDOFF incidente #5): SELECT...FOR UPDATE/FOR SHARE '
  'exige privilegio UPDATE sobre la tabla en Postgres, independiente de RLS, y app_request NO '
  'tiene ni puede tener update sobre padron_manifestacion (esa ausencia ES la premisa de frescura '
  'de 0021, vigilada por R41/grants-conjunto-cerrado.test.ts). Reproducido en vivo bajo invoker: '
  '"permission denied for table padron_manifestacion" (42501, aclcheck_error) en el FOR UPDATE, '
  'antes de tocar una sola policy. La única forma de tomar el lock sin otorgarle ese privilegio a '
  'app_request es correr como el dueño del esquema. '
  'Consecuencia: esta es la TERCERA security definer del esquema — R11 (catalogo.test.ts) se '
  'actualiza en esta misma tarea para incluirla, con este motivo citado, a diferencia de los dos '
  'incidentes anteriores donde invoker alcanzaba y R11 se dejó intacta. '
  '🔴 EL GUARD cross-tenant/rol (arriba del lock) es LO QUE VUELVE SEGURO EL BYPASS: sin él, esta '
  'función —corriendo como superusuario BYPASSRLS mientras evalúa— sería un oráculo que le '
  'contesta a cualquier tenant si la manifestación de OTRO está revocada. Replica el predicado '
  'EXACTO de reconocimiento_contrapartida_ins: si ese insert no pasaría esa policy de todos modos, '
  'la función no mira nada, devuelve new, y la policy real rechaza después con 42501 genérico. '
  'Segunda barrera, independiente e INDEPENDIENTE del grant de abajo: devuelve trigger, y Postgres '
  'rechaza llamar directo a una función trigger (0A000, verificado en vivo) — no hay forma de '
  'invocarla fuera de un INSERT real sobre reconocimiento_contrapartida. '
  '🔴 FOR UPDATE, no FOR SHARE, y no es intercambiable: revocar una manifestación es un INSERT en '
  'padron_manifestacion que referencia a la revocada por fk_padron_manifestacion_revoca, y esa FK '
  'toma automáticamente un lock FOR KEY SHARE sobre la fila referenciada. FOR KEY SHARE NO '
  'conflictúa con FOR SHARE (dos locks "share" conviven) y SÍ conflictúa con FOR UPDATE. Medido en '
  'vivo con dos conexiones reales (mutaciones-0041.test.ts M1/M2): sin lock, o con FOR SHARE, la '
  'revocación concurrente entra y commitea DURANTE la ventana en la que esta función ya leyó '
  '"vigente" y todavía no decidió — la carrera se cuela. Con FOR UPDATE, el INSERT que revoca '
  'queda BLOQUEADO hasta que esta transacción termina, y la cronología queda sin corrupción '
  'posible. El lock se toma ANTES de leer revoca_a, nunca después: leer y lockear en el orden '
  'inverso reabre la misma ventana.';

create trigger trg_reconocimiento_contrapartida_manifestacion_vigente
  before insert on reconocimiento_contrapartida
  for each row execute function app.exigir_manifestacion_vigente();

comment on trigger trg_reconocimiento_contrapartida_manifestacion_vigente on reconocimiento_contrapartida is
  'Sólo dispara si la fila cita una padron_manifestacion (padron_manifestacion_id not null) — la '
  'inmensa mayoría de los estados de capa C no citan ninguna (0021 §4, contrapartida_manifestacion_'
  'chk). Corre ANTES que trg_reconocimiento_contrapartida_cliente en el orden de disparo (Postgres '
  'ordena BEFORE ROW triggers alfabéticamente por nombre: "cliente" < "manifestacion_vigente"), '
  'pero los dos son independientes — ninguno depende de que el otro haya corrido antes. NO '
  'reemplaza a fk_recon_contrapartida_manifestacion ni a fk_recon_contrapartida_alcance (0021 §4): '
  'esas dos siguen verificando existencia + espejo de alcance, evaluadas DESPUÉS de este trigger '
  'como parte del cierre del INSERT; ésta es la tercera pata, VIGENCIA, que ninguna FK expresa '
  'porque depende del estado de OTRAS filas de padron_manifestacion en el instante de citar, no '
  'de la fila citada por sí sola.';

-- Defensa en profundidad, NO la garantía portante (ver el comment de la función): esta función
-- devuelve `trigger` y Postgres ya rechaza cualquier llamada directa por SQL, venga de quien
-- venga. Mismo estilo que `0001`/`0015` con las otras dos `security definer` del esquema.
revoke all on function app.exigir_manifestacion_vigente() from public;
grant execute on function app.exigir_manifestacion_vigente() to app_request;

commit;
