-- =============================================================================
-- 0046_pendiente_cierre_ins_r44.sql — cierra `pendiente_cierre_ins`: nace SIEMPRE `abierto`, nunca ya
-- resuelto/dispensado, ni con autoría heredada
--
-- Hallazgo real (autorizado por el titular, reimplementado DE CERO y con convocatoria real —
-- `dba-data` + `security-engineer` en paralelo — después de que un trabajo NO autorizado sobre esta
-- misma familia de migraciones (0045) fuera revertido íntegro por no haber pasado por convocatoria):
--
-- `pendiente_cierre_ins` (`0027_cierre_mensual.sql:645-648`) sólo exige aislamiento de tenant + rol
-- (`socio`/`contador`/`administrativo`) — no restringe UNA SOLA columna de estado ni de resolución. El
-- grant de INSERT sobre `pendiente_cierre` (`0027:668`) es de TABLA COMPLETA, sin acotar por columna
-- (a diferencia del UPDATE de la misma tabla, que sí lo está desde siempre). Consecuencia verificada:
-- un `administrativo` — que SÍ tiene INSERT sobre esta tabla — podía insertar una fila que nace YA
-- `pendiente_estado = 'dispensado'`, con `resuelto_por` de un tercero cualquiera. Eso no es solo un
-- agujero de autoría (R44): es un bypass COMPLETO del gate de ROL que `pendiente_cierre_upd_dispensa`
-- (`0045`) le prohíbe explícito a `administrativo` por la vía de UPDATE — nunca pasa por esa policy,
-- nunca deja un `pendiente_dispensa` (append-only, `0027:707-709`, también acotado a `socio`/
-- `contador`), y una fila ya `'dispensado'` desde el nacimiento escapa para siempre el gate de
-- confirmación de D-24 (`app.verificar_gate_confirmacion_cierre`, `0027:916-942`, que sólo cuenta
-- pendientes `pendiente_estado = 'abierto'`). Es el mismo patrón, más grave, que R33/R13: un control
-- que vive en UN SOLO camino (la policy de UPDATE) y no en el dato mismo.
--
-- `docs/diseno/10-deuda-declarada.md` B.29 ya documenta el resto de la misma familia
-- (`cierre_cliente_periodo_ins`/`asiento_propuesto_ins`, sin autorización todavía — NO se tocan acá) y
-- señala, correcto, que el caso de `pendiente_cierre_ins` es el MÁS grave de los tres porque además
-- bypasea una autorización de rol, no sólo la autoría.
--
-- ## Verificado antes de escribir el fix (no asumido)
--
-- - `pendiente_cierre_ins` real, leída en `0027_cierre_mensual.sql:645-648`: sin restricción de
--   `pendiente_estado`/`resuelto_por`/`resuelto_en`/`resolucion_id`/`superseded_by_id`, tal como
--   describe el hallazgo.
-- - `grant select, insert on pendiente_cierre to app_request;` (`0027:668`) es de tabla completa —
--   confirmado también en `packages/data/tests/grants-conjunto-cerrado.test.ts` (la fila de
--   `pendiente_cierre|INSERT` lista las 14 columnas, o sea sin acotar). Ninguna migración posterior
--   (`0029`, `0031`, `0033`, `0034`) tocó esa policy ni ese grant.
-- - Único caller real de HOY que inserta en `pendiente_cierre`: `escribirPendienteDeImputacion`
--   (`packages/data/src/cierre/escrituras.ts:543-561`) — `insert into pendiente_cierre (cliente_id,
--   cierre_id, referencia_origen, motivo_codigo, evidencia) values (...)`. Nunca menciona
--   `pendiente_estado`, `resuelto_por`, `resuelto_en`, `resolucion_id` ni `superseded_by_id`: los cinco
--   quedan en su valor por omisión (`pendiente_estado` → DEFAULT `'abierto'`; los otros cuatro,
--   nullable sin default → `null`). El fix de abajo es un no-op para este caller.
--
-- ## Alcance del `with_check`, elegido y justificado (pedido explícito del encargo)
--
-- Cerrar SÓLO `resuelto_por`/`resuelto_en` (la condición literal que motivó el encargo) habría dejado
-- pasar la mitad más grave del hallazgo: un `administrativo` seguiría pudiendo insertar
-- `pendiente_estado = 'dispensado'` con `resuelto_por`/`resuelto_en` en `null` — sigue sin pasar por
-- `pendiente_cierre_upd_dispensa`, sigue sin dejar `pendiente_dispensa`, sigue escapando el gate de
-- D-24. B.29 ya lo dice explícito: el agravante real de este caso, a diferencia de
-- `cierre_cliente_periodo_ins`/`asiento_propuesto_ins`, es la autorización de ROL bypaseada
-- (`'dispensado'` sin ser `socio`/`contador`), no sólo la autoría. Por eso el `with_check` exige
-- `pendiente_estado = 'abierto'` — el único estado en el que un pendiente puede nacer, sea cual sea el
-- rol que lo inserta — más las cuatro columnas de resolución/supersesión en `null`: un pendiente recién
-- creado no puede citar su propia resolución, ni su propio superseder, todavía inexistentes. Ninguna de
-- las cuatro tiene caso legítimo de venir seteada al nacer (verificado arriba, y coherente con el
-- contrato de reproceso de `0029:36-43`: la fila NUEVA de una supersesión nace con `superseded_by_id`
-- en `null` — es la fila VIEJA la que se actualiza para apuntar a la nueva, nunca al revés).
--
-- ## `WITH CHECK`, no grant acotado por columna — elegido y justificado (pregunta explícita del encargo)
--
-- Dos formas disponibles para el mismo invariante: (a) `with_check` de RLS, o (b) `revoke`/`grant
-- insert (...)` acotando las columnas elegibles (mismo idiom que `cierre_transicion.hecho_por`,
-- `0045:345-349`, o `padron_manifestacion.manifestado_por`, `0021`). Se elige (a) por un motivo
-- concreto, no por preferencia de estilo: un `WITH CHECK` violado y un `INSERT` sobre una columna sin
-- grant dan el MISMO `SQLSTATE 42501` — si acotáramos el grant en vez de (o además de) escribir el
-- `with_check`, la prueba de mutación de abajo no podría distinguir "murió por la policy nueva" de
-- "murió porque `administrativo` nunca tuvo el grant de esa columna", que es exactamente la ambigüedad
-- que `mutaciones-0045-...test.ts` ya identificó y que este mismo encargo pide descartar reusando
-- columnas ya grantables. Dejar el grant de INSERT tal cual (tabla completa, sin acotar, como ya está
-- desde `0027`) es lo que permite que el caso de ataque de abajo pruebe la POLICY, no un privilegio
-- faltante. Acotar el grant además sería redundante (correcto, pero no aporta un invariante que el
-- `with_check` no dé ya) y no aporta nada distinto — décision consistente con dejar la fila de
-- `grants-conjunto-cerrado.test.ts` sin cambios.
--
-- Ninguna función/trigger/`SECURITY DEFINER` nuevo. Ninguna columna nueva — sin entrada nueva en
-- `clasificacion-campos.ts`. No toca `0045_usuario_identidad_capacidades_r44.sql` (migración ya
-- aplicada, no se edita) ni `docs/diseno/10-deuda-declarada.md` (B.29 ya refleja lo que queda fuera).
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

drop policy pendiente_cierre_ins on pendiente_cierre;

create policy pendiente_cierre_ins on pendiente_cierre for insert
  with check ( cliente_id in (select app.accessible_tenant_ids())
               and app.has_role_on(cliente_id,
                     array['socio','contador','administrativo']::app.rol_membership[])
               and pendiente_estado = 'abierto'
               and resuelto_por is null
               and resuelto_en is null
               and resolucion_id is null
               and superseded_by_id is null );

comment on policy pendiente_cierre_ins on pendiente_cierre is
  'R44 + gate de rol (0046): un INSERT nunca puede nacer ya resuelto/dispensado/superseded -- '
  'pendiente_estado tiene que ser ''abierto'' y resuelto_por/resuelto_en/resolucion_id/superseded_by_id '
  'tienen que venir en null. Sin esto, un administrativo (con INSERT pero sin UPDATE de dispensa, '
  '0045: pendiente_cierre_upd_dispensa) podía crear directamente un pendiente ''dispensado'' con '
  'resuelto_por de un tercero -- bypaseando el gate de rol Y la autoría a la vez, sin pasar nunca por '
  'pendiente_dispensa ni por el gate de confirmación de D-24 (app.verificar_gate_confirmacion_cierre, '
  '0027). Único caller real hoy (escribirPendienteDeImputacion, escrituras.ts) nunca setea estas cinco '
  'columnas -- no-op para él. Grant de INSERT queda de tabla completa, sin acotar (como ya estaba desde '
  '0027): el invariante vive en el with_check, no en el grant, para que la prueba de mutación pueda '
  'distinguir "policy violada" de "columna sin grant" (mismo SQLSTATE 42501 para ambas).';

commit;
