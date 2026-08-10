-- =============================================================================
-- 0006_ajustes_cuenta.sql — tres correcciones que el panel encontró, todas antes del primer alta real
--
-- Las tres cuestan cero hoy porque hay **una** cuenta y no cuatrocientas. Después de la primera corrida,
-- cada una es una migración de datos.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `tipo_cuenta`: el check admitía CUATRO valores y el dominio tiene SEIS
-- -----------------------------------------------------------------------------
--
-- `TIPOS_CUENTA` de `packages/ingesta/src/esquema.ts` declara seis:
--   cuenta_corriente, cuenta_corriente_especial, caja_ahorro, cuenta_inversion,
--   tarjeta_corporativa, no_determinado
--
-- y el check de `0004` admitía cuatro: caja_ahorro, cuenta_corriente, cuenta_unica, otra.
--
-- ## Por qué importa, y no es cosmético
--
-- **El cliente piloto TIENE una cuenta corriente especial**, y con el check viejo se aplastaba a `'otra'`.
-- El tipo de cuenta decide dos cosas de dominio:
--
--   1. **si el descubierto es posible.** Una caja de ahorro no admite saldo negativo, así que un saldo
--      acreedor ahí es casi siempre un error de parseo o de convención — una señal gratis que con el tipo
--      aplastado a `'otra'` no se puede usar;
--   2. **si el saldo va a Banco o a Inversiones** en el balance.
--
-- Y `cuenta_unica` no está en el dominio del código: era un valor inventado en la migración. Dos listas del
-- mismo dominio en dos lenguajes distintos divergen — pasó también con `acceso_auditoria.accion`, y ahí hay
-- un test de catálogo que las compara. Este check necesita el mismo test.
alter table cuenta_bancaria_identificador
  drop constraint cuenta_ident_tipo_chk;

alter table cuenta_bancaria_identificador
  add constraint cuenta_ident_tipo_chk
  check (tipo_cuenta in ('cuenta_corriente', 'cuenta_corriente_especial', 'caja_ahorro',
                         'cuenta_inversion', 'tarjeta_corporativa', 'no_determinado'));

comment on constraint cuenta_ident_tipo_chk on cuenta_bancaria_identificador is
  'Los seis valores de TIPOS_CUENTA (packages/ingesta/src/esquema.ts). La lista tiene que ser IDÉNTICA: '
  'el tipo decide si el descubierto es posible y si el saldo va a Banco o a Inversiones.';

-- -----------------------------------------------------------------------------
-- 2. El CBU no puede terminar en `numero`
-- -----------------------------------------------------------------------------
--
-- `numero` existe para el **número de cuenta** entero, que hace falta para hablar con el banco. El CBU va
-- hasheado en `cbu_hmac`, porque solo se usa para matchear.
--
-- Nada en el esquema separaba las dos cosas, y el camino de menor resistencia al escribir el alta es
-- `numero = <el CBU, que es el identificador que leí de la carátula>`. Con eso el CBU queda **en claro** en
-- la base y la decisión de hashearlo se anula sin que nadie la revierta. Peor: el segundo camino del
-- resolver compara `regexp_replace(numero, '\D', '', 'g')`, así que empezaría a matchear CBU en claro —
-- dos caminos de resolución, uno de los cuales guarda lo que el otro decidió no guardar.
--
-- El check es preciso y sin falso positivo: **ningún número de cuenta argentino tiene 22 dígitos; el CBU
-- tiene exactamente 22.**
alter table cuenta_bancaria_identificador
  add constraint cuenta_ident_numero_no_es_cbu
  check (length(regexp_replace(numero, '\D', '', 'g')) <> 22);

comment on constraint cuenta_ident_numero_no_es_cbu on cuenta_bancaria_identificador is
  'Impide guardar un CBU en `numero`, que lo dejaría en claro. 22 dígitos exactos = CBU; ningún número de '
  'cuenta argentino los tiene. La regla del plan §8.7: hasheado si solo hace falta para matchear.';

-- -----------------------------------------------------------------------------
-- 3. `pepper_id`: para que el pepper se pueda rotar SIN pedirle el CBU a nadie
-- -----------------------------------------------------------------------------
--
-- ## El problema, que estaba mal documentado
--
-- El `.env.example` decía que rotar el pepper "obliga a recalcular la columna `cbu_hmac`". **Recalcular un
-- HMAC exige el CBU en claro, que el sistema deliberadamente no guarda.** Así que la afirmación era falsa y
-- el costo real de rotar era **pedirle los CBU otra vez a todos los clientes**.
--
-- Y el modo de falla es silencioso y contagioso: con el pepper nuevo el resolver devuelve
-- `cuenta_no_registrada` para todos los clientes a la vez; el operador —razonablemente— da de alta la cuenta
-- de nuevo; ahora hay dos identificadores vigentes y el resolver entra en `cuenta_ambigua` **para siempre**.
--
-- ## La solución, que hoy cuesta una columna
--
-- Cada fila declara con qué versión de pepper se calculó su HMAC. El resolver compara por versión, así que
-- la rotación es **incremental y sin pedirle nada a nadie**: el próximo extracto trae el CBU en la carátula
-- y ahí la fila se re-hashea y migra sola.
--
-- `v1` es el default para lo que ya esté cargado. El valor es un identificador de versión, **nunca** el
-- pepper ni una parte de él.
alter table cuenta_bancaria_identificador
  add column pepper_id text not null default 'v1';

alter table cuenta_bancaria_identificador
  add constraint cuenta_ident_pepper_chk check (pepper_id ~ '^v[0-9]{1,4}$');

-- El índice de resolución lleva la versión: una consulta que no la filtre compararía contra digests de otra
-- versión, que nunca van a coincidir — y "no coincide" es indistinguible de "la cuenta no está registrada".
drop index idx_cuenta_ident_resolucion;
create index idx_cuenta_ident_resolucion
  on cuenta_bancaria_identificador(cliente_id, pepper_id, cbu_hmac)
  where cbu_hmac is not null;

comment on column cuenta_bancaria_identificador.pepper_id is
  'Versión del pepper con el que se calculó cbu_hmac. Permite rotar el pepper de forma incremental sin '
  'volver a pedir el CBU: recalcular un HMAC exige el valor en claro, que a propósito no se guarda.';

commit;
