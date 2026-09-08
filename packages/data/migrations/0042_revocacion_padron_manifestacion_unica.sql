-- =============================================================================
-- 0042_revocacion_padron_manifestacion_unica.sql — dos invocaciones concurrentes de
-- `manifestar-padron.ts --revoca X` no pueden insertar las dos con `revoca_a = X`.
--
-- Convocatoria (CLAUDE.md §3.1/§3.2): dba-data + security-engineer, misma semana que 0041,
-- 2026-09-08. `motor-conciliacion-contable` y `contador-dominio` encontraron el hueco en
-- convocatorias independientes: `manifestar-padron.ts` (en construcción) valida "X es la vigente"
-- y RECIÉN DESPUÉS inserta la revocadora — check-then-act sin lock. Dos corridas concurrentes,
-- cada una viendo "todavía no hay conflicto", podrían insertar las dos con `revoca_a = X`: dos
-- cadenas vivas simultáneas, silencioso hasta que `leerManifestacionVigente`
-- (packages/data/src/contabilidad/lecturas.ts) explota con "más de una vigente" — fail-closed
-- correcto, pero DESPUÉS del hecho.
--
-- ## Por qué UNICIDAD y no TRIGGER (a diferencia de 0041)
--
-- `0041` necesitó `SECURITY DEFINER` + `FOR UPDATE` porque su invariante cruzaba DOS tablas
-- (¿esta `reconocimiento_contrapartida` cita una `padron_manifestacion` YA revocada por OTRA fila
-- de `padron_manifestacion`?) y una FK simple no expresa "mirar el estado de otras filas de la
-- misma tabla en el instante de decidir". Acá el invariante es distinto y más simple: es una
-- propiedad de LA PROPIA `padron_manifestacion` — "a lo sumo una fila con `revoca_a = X`, para
-- cada `X`" — y eso SÍ lo expresa un índice único parcial, sin ningún trigger, siguiendo el orden
-- de preferencia (tipo → check → FK → unique → trigger → aplicación): acá alcanza con `unique`.
--
-- ## Por qué COMPUESTO `(cliente_id, revoca_a)` y no `revoca_a` solo — dos razones, no una
--
-- (a) Regla dura (CLAUDE.md §1.2): unicidades siempre por cliente, nunca globales. La forma
-- compuesta replica exactamente la de `fk_padron_manifestacion_revoca` (0021:448-451): mismo par
-- de columnas, misma tenant-consistencia. Confirmado en vivo (`dba-data`) que el índice NO
-- reemplaza el trabajo de esa FK: un intento cross-cliente de revocar la fila de OTRO cliente
-- muere por `fk_padron_manifestacion_revoca` (`23503`), nunca llega a evaluar este índice.
--
-- (b) 🔴 Hallazgo real de `security-engineer`, no solo estilo: un índice único SIN `cliente_id`
-- sería un ORÁCULO CROSS-TENANT, por el ORDEN de evaluación de constraints en Postgres. El índice
-- único se verifica DURANTE el INSERT; la FK se verifica DESPUÉS, en un trigger `AFTER ROW`. Si un
-- cliente A intenta `revoca_a = X` (id de una manifestación de OTRO cliente B) y X **ya fue
-- revocada por B**, un índice único GLOBAL dispararía `23505` (conflicto de unicidad) ANTES de que
-- la FK tuviera oportunidad de rechazar por `23503` — A podría distinguir, por el código de error,
-- si X ya está revocada o no: un oráculo booleano cross-tenant (acotado — no revela contenido, y
-- no deja residuo porque la sentencia completa se deshace — pero real, verificado por mecanismo,
-- no supuesto). Con `(cliente_id, revoca_a)` compuesto, la ventana se cierra del todo: para que el
-- índice conflictúe con el intento de A, tendría que existir ya una fila con
-- `(cliente_id=A, revoca_a=X)` — imposible si X es de B. El intento de A siempre cae en el mismo
-- `23503` genérico, sin distinguir estado.
--
-- ## Evidencia EN VIVO (dos conexiones reales, sin `pg_sleep` — no hace falta)
--
-- Un índice único no tiene ventana TOCTOU que forzar: la inserción toma el "value lock" de la
-- clave ANTES de decidir si hay conflicto, así que no hace falta ningún `pg_sleep` para hacerlo
-- determinístico (a diferencia de `0041`, donde la carrera dependía de un check-then-act explícito
-- en PL/pgSQL). Medido con dos conexiones `app_request` concurrentes, 3 corridas seguidas: siempre
-- exactamente 1 INSERT entra y el otro muere `23505` (unique_violation) sobre
-- `uq_padron_manifestacion_revoca_a` — nunca las dos entran, nunca las dos mueren. Pineado en
-- `packages/data/tests/mutaciones-0042.test.ts`.
--
-- ## Qué NO cierra esta migración, a propósito
--
-- No traduce el `23505` a un mensaje de operador — `conErroresTraducidos` ya lo reduce a
-- `ErrorDeBase{codigo:'ING_DUPLICADO', constraint:'uq_padron_manifestacion_revoca_a'}` (sin fuga
-- de datos, R28), pero el CLI (`manifestar-padron.ts`, fuera de esta migración) necesita un catch
-- específico sobre ese `constraint` — mismo patrón que `BajaMismoDiaDeAltaError`
-- (`escrituras.ts`) — para mostrarle al operador algo accionable ("alguien más ya revocó esta
-- manifestación mientras vos decidías, volvé a correr sin --revoca para ver el estado actual") en
-- vez del genérico. Es trabajo del escritor del CLI, no de esta migración.
--
-- No reemplaza a `0041`: son invariantes distintos (`0041` impide CITAR una revocada desde
-- `reconocimiento_contrapartida`; `0042` impide que DOS revocaciones de la MISMA fila entren las
-- dos). No agrega ningún grant nuevo — el `insert` de `revoca_a` ya está otorgado por columna
-- desde `0021`; el índice no necesita grant propio.
--
-- 🔴 ANTES DE APLICAR A PILOTO: verificar que no existan ya dos filas con el mismo `revoca_a` no
-- nulo (el CLI que causaría esa duplicación todavía se está construyendo, así que es improbable,
-- pero si existieran el `CREATE UNIQUE INDEX` fallaría explícito al aplicar — fail-closed
-- correcto, no silencioso, pero mejor confirmarlo antes que durante un runbook de piloto).
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

create unique index uq_padron_manifestacion_revoca_a
  on padron_manifestacion (cliente_id, revoca_a)
  where revoca_a is not null;

comment on index uq_padron_manifestacion_revoca_a is
  'A lo sumo una fila puede revocar la misma manifestación, POR CLIENTE. Cierra la carrera de '
  'manifestar-padron.ts --revoca X (check-then-act sin lock, hallado por motor-conciliacion-'
  'contable y contador-dominio, 2026-09-08): dos invocaciones concurrentes, ambas viendo "X '
  'todavía vigente", ya no pueden insertar las dos con revoca_a = X — la segunda muere 23505 '
  '(unique_violation) en el propio INSERT, antes de comprometerse. Compuesto (cliente_id, '
  'revoca_a), nunca revoca_a solo — CLAUDE.md §1.2 (unicidades siempre por cliente) Y un hallazgo '
  'real de security-engineer: un índice global sería un oráculo cross-tenant por el ORDEN de '
  'evaluación de constraints (el unique corre antes que la FK, en un trigger AFTER ROW). '
  'Verificado en vivo con dos conexiones app_request reales: exactamente 1/2 entra, 3 corridas '
  'seguidas. NO reemplaza a fk_padron_manifestacion_revoca (0021): esa FK sigue siendo la que '
  'impide revocar una fila de OTRO cliente (23503) — confirmado en vivo, el índice compuesto '
  'nunca llega a evaluarse en ese camino.';

commit;
