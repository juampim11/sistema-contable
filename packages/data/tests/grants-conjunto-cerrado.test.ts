/**
 * **CERRADO (migración `0028`).** `cierre_cliente_periodo` y `asiento_propuesto` tenían un
 * `grant select, insert, update` a nivel TABLA (`0027_cierre_mensual.sql:372,784`) que
 * `security-engineer` marcó como hallazgo de seguridad BLOQUEANTE (HANDOFF 130): permitía reescribir
 * `confirmado_por`/`confirmado_en`/`periodo_desde`/`periodo_hasta`/`fecha_imputacion` sobre un
 * cierre/asiento YA confirmado, sin pasar por el gate de D-24 y sin dejar rastro.
 *
 * Convocatoria real (`arquitecto-software` + `dba-data` + `security-engineer`, más
 * `seguridad-datos-financieros` + `qa-automation` sobre el diseño concreto) encontró un desacuerdo
 * técnico real entre `dba-data` (proponía cerrarlo solo con RLS) y `arquitecto-software` (RLS sola no
 * alcanza porque la policy `FOR SELECT` da visibilidad total, independiente del `USING` de las
 * policies de `UPDATE`) — resuelto por verificación empírica contra Postgres real, no por autoridad:
 * `arquitecto-software` tenía razón. `0028` acota el grant a columnas explícitas y agrega un trigger
 * genérico `app.exigir_inmutabilidad_post_terminal()`, reusado tal cual en `pendiente_cierre` (cierra
 * también el hallazgo secundario no bloqueante de esa tabla). Detalle completo: HANDOFF (131 en
 * adelante), `0028_inmutabilidad_post_terminal_cierre.sql`.
 */

/**
 * R41 — **EL CONJUNTO DE GRANTS ES CERRADO**, y se compara con `toEqual`.
 *
 * ## Por qué existe, y por qué dejó de ser deuda
 *
 * `0021` bajó a la base la regla de frescura de la manifestación:
 * `reconocimiento_contrapartida.padron_completo_hasta` es un espejo atado por FK compuesta contra
 * `padron_manifestacion (cliente_id, id, completo_hasta)`. **Esa FK afirma un hecho PRESENTE**, así
 * que sólo es legítima porque `completo_hasta` es **INMUTABLE** — y `completo_hasta` es inmutable
 * por una única razón: `padron_manifestacion` nace **sin `update` y sin `delete`**, ni policy ni
 * grant. El día que alguien otorgue `update` sobre esa tabla, la FK pasa a afirmar un hecho que
 * dejó de ser cierto y **el control de frescura se cae en silencio**.
 *
 * O sea: la ausencia de esos grants no es higiene. Es **la premisa de un control**. Y una premisa
 * que nadie verifica es una premisa que ya se cayó y todavía no lo sabemos.
 *
 * ## 🔴 El error que esto previene YA PASÓ, y dos veces
 *
 * 1. `packages/data/migrations/0004_ingesta.sql:502` es
 *    `grant select, insert, update, delete on movimiento_bancario_crudo to app_request` — un grant
 *    de **TABLA**. En una sola sesión, **TRES agentes distintos** afirmaron por separado que
 *    `movimiento_bancario_crudo.fecha` era inmutable. Los tres grepearon `grant update (` —la
 *    sintaxis **por columna**— y los tres pasaron por encima de ese renglón. Verificar la **forma
 *    del artefacto** en vez de la **capacidad efectiva** es el patrón que este repo ya catalogó
 *    como R33 y R13.
 * 2. Los dos tests de grants que había (`catalogo.test.ts`, R32 y `via_depth`) usan
 *    `not.toContain`. Eso pregunta *«¿está esta columna de más?»*, que es lista de **prohibidos**;
 *    una columna otorgada de más que nadie pensó en prohibir **pasa verde**.
 *
 * Este archivo invierte la carga: **lista de permitidos**. Lo que está en la base y no está
 * declarado acá pone el gate rojo, sin que nadie haya tenido que anticiparlo.
 *
 * ## Alcance: TODO el esquema, no las cuatro tablas de `0021`. Y por qué
 *
 * El pedido admitía limitarse a `padron_manifestacion`, `reconocimiento_contrapartida`,
 * `reconocimiento_contrapartida_match` y `reconocimiento_movimiento`. **Se barre todo**, por tres
 * motivos medidos y no por prolijidad:
 *
 * - **Las listas a mano nacen incompletas, y este repo ya lo pagó**: `membership_historia` nació
 *   fuera de la allowlist de R1 y dejó de ser mirada; la lista de `truncate` de `ayuda.ts` no se
 *   enteró de `0019`. Una lista de cuatro tablas es una lista a mano con otro nombre.
 * - **El barrido completo es la única forma de que una TABLA NUEVA con grants entre sola.** Con la
 *   lista corta, `0022` puede crear una tabla con `grant update` de tabla y este archivo queda
 *   verde. Está probado por mutación (`M8`).
 * - **El costo medido es cero**: 621 filas efectivas, 67 renglones declarados, una consulta.
 *
 * ## Qué se barre, y por qué NO alcanza `information_schema.column_privileges`
 *
 * Se barre el **catálogo crudo** (`aclexplode` sobre `pg_class.relacl` y `pg_attribute.attacl`),
 * no la vista de `information_schema`, por dos razones:
 *
 * - `information_schema.column_privileges` **filtra por rol habilitado**: sólo muestra lo otorgado
 *   *a* o *por* un rol del usuario actual. Hoy el grantor es siempre el dueño y coincide, pero un
 *   grant hecho por otro grantor **desaparecería de la vista sin que nada se ponga rojo**. Es
 *   exactamente la vacuidad de R39c, una capa más abajo.
 * - La vista **sólo conoce los privilegios expresables por columna** (`SELECT`, `INSERT`, `UPDATE`,
 *   `REFERENCES`). 🔴 **`DELETE` no aparece nunca.** Y `delete` sobre `padron_manifestacion` mata
 *   la premisa de frescura igual de bien que `update`: borrada la manifestación, el espejo
 *   `padron_completo_hasta` afirma un hecho sobre una fila que ya no existe. Un test que sólo
 *   mirara `column_privileges` —que es lo que el dictamen §4.4 especificó— **habría quedado verde
 *   frente a ese grant**. Está medido: es la mutación `M5`.
 *
 * Como **control cruzado** —dos caminos, mismo número— el barrido crudo se compara además contra
 * `information_schema.column_privileges`, que es el camino que sí expande un grant de tabla a una
 * fila por columna. Si los dos dejan de coincidir, algo cambió en un supuesto y no en el esquema.
 *
 * ## Conteo de mutaciones declarado: 13 mutaciones + 3 casos legítimos, en 20 `it`
 *
 * Unidad de conteo: **una mutación = UNA capacidad efectiva alterada y ejercitada**, no un `it`.
 *
 * Elegidas **para refutar**, no para confirmar (ADR-0002 §B.0). Cada una nombra qué implementación
 * plausible mata; una mutación que no mata ninguna no está en la lista.
 *
 *   M1  grant de **TABLA** de más (`update on padron_manifestacion`) ....... el caso que motiva todo
 *   M2  grant por **columna** de más (`update (completo_hasta)`) ........... el mismo ataque, otra sintaxis
 *   M3  un privilegio de **menos** (`revoke insert (revoca_a)`) ............ que no sea sólo "no sobre nada"
 *   M4  grant a **`app_job`** sobre una tabla de `0021` .................... lo que lo detiene es el grant, no la policy
 *   M5  `grant delete` — **invisible a `column_privileges`** ............... refuta la especificación de §4.4
 *   M6  `grant trigger` — el otro privilegio sólo-de-tabla ................. refuta un barrido cableado a DELETE
 *   M7  grant a un **rol que no existía** .................................. refuta una lista de roles cableada
 *   M8  **tabla nueva** con grants ......................................... refuta una lista de tablas cableada
 *   M9  misma cobertura efectiva, **forma tabla → columna** ................ la única que prueba que R41b no sobra
 *   M10 el mismo grant **`with grant option`** ............................. refuta ignorar quién puede re-otorgar
 *   M11 barrido apuntado a un **esquema sin tablas** ....................... R39c: sin esto, M1–M10 pasan sin mirar nada
 *   M12 el recorte de `0021` **deshecho** (insert de tabla en
 *       `reconocimiento_movimiento`, 16 columnas → 20) .................... que la regresión de la propia 0021 se vea
 *   M13 `grant app_request to app_job` — un grant **HEREDADO** ............ el límite propio de este barrido, cerrado
 *
 *   L1  el esquema tal como está ........................................... VERDE
 *   L2  una tabla nueva **sin ningún grant** ............................... VERDE (no se exige que toda tabla tenga grants)
 *   L3  un rol nuevo **sin ningún grant** .................................. VERDE (no se exige que todo rol aparezca)
 *
 * L2 y L3 no son decorado: sin ellos, la implementación «toda tabla/rol tiene que estar declarada»
 * pasaría las trece mutaciones y rompería la próxima migración por un motivo falso.
 *
 * ## 🔴 El límite de este barrido, encontrado midiendo, y cerrado
 *
 * `aclexplode` devuelve el grant **DIRECTO**: a quién se le otorgó, textualmente. Un rol que hereda
 * por **membresía** no aparece en ninguna ACL y tiene el privilegio igual. Hoy hay una sola
 * membresía —`app_request_dev` es miembro de `app_request`, que es como se conecta el dev local— y
 * un `grant app_request to app_job` bastaría para que `app_job` (BYPASSRLS) leyera y escribiera
 * las cuatro tablas de `0021` **con este archivo en verde**.
 *
 * Por eso la **grafo de membresías también es un conjunto cerrado** (`MEMBRESIAS_DE_ROL`), y `M13`
 * lo prueba. Y por eso **no se retiran** los dos tests de `catalogo.test.ts`: `has_table_privilege`
 * y `has_column_privilege` SÍ resuelven la herencia, así que miden el privilegio **efectivo** por
 * un camino que éste no tiene. Son complementarios, no redundantes — ver el reporte al pie.
 *
 * ## Cómo se mide una mutación, sin tocar el esquema
 *
 * Cada mutación corre en una **transacción del dueño que siempre se rollbackea** —`grant`,
 * `create table`, `create role` y `create schema` son transaccionales en PostgreSQL—, con
 * `entornoActual() === 'local'` exigido, y al salir se verifica que el barrido volvió **idéntico**
 * al de antes. Es el mismo laboratorio que `mutaciones-0021.test.ts`, y el mismo motivo: un
 * rollback que no restaura sería peor que no mutar. 🔴 **El piloto no se toca ni para leer.**
 *
 * ## Y por qué cada mutación afirma QUÉ discrepancia, no sólo que hubo una
 *
 * Mismo criterio que `esperarRechazo()` en `mutaciones-0021.test.ts`: un `expect(...).not.toEqual([])`
 * pelado deja pasar que la discrepancia la detecte el detector equivocado. Acá cada mutación exige
 * la **entrada exacta** que tiene que aparecer, y `M5`/`M9`/`M10` exigen además que el otro barrido
 * quede **verde** — que es lo que prueba que son controles distintos y no tres nombres del mismo.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entornoActual } from '../src/db/entorno.ts';
import { clienteDuenio } from './ayuda.ts';

// -----------------------------------------------------------------------------
// LO DECLARADO — la lista de PERMITIDOS
// -----------------------------------------------------------------------------

/**
 * Privilegios **efectivos por columna**: el grant de tabla ya viene expandido a una fila por
 * columna, que es la forma en que la base los aplica de verdad. 67 renglones, 621 pares
 * `(tabla, columna, privilegio, rol)`.
 *
 * ⚠️ **Cómo se agrega un renglón acá.** Se lee del catálogo DESPUÉS de aplicar la migración, no se
 * copia del `.sql`: un `grant` de tabla en el `.sql` son N renglones acá, y ese desdoblamiento es
 * justamente lo que este archivo existe para hacer visible.
 */
const GRANTS_POR_COLUMNA: readonly {
  readonly tabla: string;
  readonly rol: string;
  readonly privilegio: string;
  readonly columnas: readonly string[];
}[] = [
  { tabla: 'acceso_auditoria', rol: 'app_job', privilegio: 'INSERT', columnas: ['accion', 'cliente_id', 'correlacion', 'motivo', 'recurso', 'recurso_id', 'user_id'] },
  { tabla: 'acceso_auditoria', rol: 'app_request', privilegio: 'INSERT', columnas: ['accion', 'cliente_id', 'correlacion', 'motivo', 'recurso', 'recurso_id', 'user_id'] },
  { tabla: 'acceso_auditoria', rol: 'app_request', privilegio: 'SELECT', columnas: ['accion', 'cliente_id', 'correlacion', 'id', 'motivo', 'ocurrido_en', 'recurso', 'recurso_id', 'user_id'] },
  { tabla: 'anexo_extracto', rol: 'app_request', privilegio: 'INSERT', columnas: ['alicuota_publicada', 'atribucion_cuenta', 'cliente_id', 'concepto_literal', 'created_at', 'cuenta_bancaria_id', 'id', 'importe_declarado', 'lote_ingesta_id', 'moneda', 'orden_en_lote', 'pagina_pdf', 'periodo_dato', 'periodo_desde', 'periodo_hasta', 'relacion_con_movimientos'] },
  { tabla: 'anexo_extracto', rol: 'app_request', privilegio: 'SELECT', columnas: ['alicuota_publicada', 'atribucion_cuenta', 'cliente_id', 'concepto_literal', 'created_at', 'cuenta_bancaria_id', 'id', 'importe_declarado', 'lote_ingesta_id', 'moneda', 'orden_en_lote', 'pagina_pdf', 'periodo_dato', 'periodo_desde', 'periodo_hasta', 'relacion_con_movimientos'] },
  { tabla: 'banco', rol: 'app_job', privilegio: 'SELECT', columnas: ['activo', 'capacidades', 'codigo', 'created_at', 'nombre'] },
  { tabla: 'banco', rol: 'app_request', privilegio: 'SELECT', columnas: ['activo', 'capacidades', 'codigo', 'created_at', 'nombre'] },
  // `cotizacion_bna` (0022): grants acotados por columna, no de tabla — `app_job` puede insertar y
  // corregir el VALOR cacheado (compra/venta/fuente), nunca la identidad de la fila (moneda/fecha
  // son la PK). `app_job` no tiene SELECT: la lectura para el motor es de `app_request`.
  { tabla: 'cotizacion_bna', rol: 'app_job', privilegio: 'INSERT', columnas: ['compra', 'fecha', 'fuente', 'moneda', 'venta'] },
  { tabla: 'cotizacion_bna', rol: 'app_job', privilegio: 'UPDATE', columnas: ['compra', 'fuente', 'venta'] },
  { tabla: 'cotizacion_bna', rol: 'app_request', privilegio: 'SELECT', columnas: ['compra', 'created_at', 'fecha', 'fuente', 'moneda', 'venta'] },
  { tabla: 'credencial_fiscal', rol: 'app_firmador', privilegio: 'INSERT', columnas: ['alg', 'ambiente', 'cliente_id', 'created_at', 'fingerprint_sha256', 'id', 'kek_id', 'material_cifrado', 'rotada_en', 'servicio', 'vence_en'] },
  { tabla: 'credencial_fiscal', rol: 'app_firmador', privilegio: 'SELECT', columnas: ['alg', 'ambiente', 'cliente_id', 'created_at', 'fingerprint_sha256', 'id', 'kek_id', 'material_cifrado', 'rotada_en', 'servicio', 'vence_en'] },
  { tabla: 'credencial_fiscal', rol: 'app_firmador', privilegio: 'UPDATE', columnas: ['alg', 'ambiente', 'cliente_id', 'created_at', 'fingerprint_sha256', 'id', 'kek_id', 'material_cifrado', 'rotada_en', 'servicio', 'vence_en'] },
  // 🔴 `material_cifrado` NO está acá: es la única columna `solo_firmador` del registro de
  // clasificación, y su ausencia en este renglón es lo que lo sostiene.
  { tabla: 'credencial_fiscal', rol: 'app_request', privilegio: 'SELECT', columnas: ['alg', 'ambiente', 'cliente_id', 'created_at', 'fingerprint_sha256', 'id', 'kek_id', 'rotada_en', 'servicio', 'vence_en'] },
  { tabla: 'credencial_fiscal_rotacion', rol: 'app_firmador', privilegio: 'INSERT', columnas: ['cliente_id', 'credencial_id', 'fingerprint_anterior', 'id', 'motivo', 'ocurrido_en', 'rotada_por'] },
  { tabla: 'credencial_fiscal_rotacion', rol: 'app_firmador', privilegio: 'SELECT', columnas: ['cliente_id', 'credencial_id', 'fingerprint_anterior', 'id', 'motivo', 'ocurrido_en', 'rotada_por'] },
  { tabla: 'credencial_fiscal_rotacion', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'credencial_id', 'fingerprint_anterior', 'id', 'motivo', 'ocurrido_en', 'rotada_por'] },
  { tabla: 'credencial_fiscal_rotacion', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'credencial_id', 'fingerprint_anterior', 'id', 'motivo', 'ocurrido_en', 'rotada_por'] },
  { tabla: 'cuenta_bancaria', rol: 'app_request', privilegio: 'INSERT', columnas: ['abierta_desde', 'alias', 'banco_codigo', 'cerrada_en', 'cliente_id', 'created_at', 'cuenta_id', 'id', 'moneda'] },
  { tabla: 'cuenta_bancaria', rol: 'app_request', privilegio: 'SELECT', columnas: ['abierta_desde', 'alias', 'banco_codigo', 'cerrada_en', 'cliente_id', 'created_at', 'cuenta_id', 'id', 'moneda'] },
  { tabla: 'cuenta_bancaria', rol: 'app_request', privilegio: 'UPDATE', columnas: ['abierta_desde', 'alias', 'banco_codigo', 'cerrada_en', 'cliente_id', 'created_at', 'cuenta_id', 'id', 'moneda'] },
  { tabla: 'cuenta_bancaria_identificador', rol: 'app_job', privilegio: 'SELECT', columnas: ['cbu_hmac', 'cliente_id'] },
  { tabla: 'cuenta_bancaria_identificador', rol: 'app_request', privilegio: 'INSERT', columnas: ['cbu_hmac', 'cbu_ultimos4', 'cliente_id', 'created_at', 'cuenta_bancaria_id', 'id', 'numero', 'pepper_id', 'tipo_cuenta', 'vigente_desde', 'vigente_hasta'] },
  { tabla: 'cuenta_bancaria_identificador', rol: 'app_request', privilegio: 'SELECT', columnas: ['cbu_hmac', 'cbu_ultimos4', 'cliente_id', 'created_at', 'cuenta_bancaria_id', 'id', 'numero', 'pepper_id', 'tipo_cuenta', 'vigente_desde', 'vigente_hasta'] },
  { tabla: 'cuenta_bancaria_identificador', rol: 'app_request', privilegio: 'UPDATE', columnas: ['cbu_hmac', 'cbu_ultimos4', 'cliente_id', 'created_at', 'cuenta_bancaria_id', 'id', 'numero', 'pepper_id', 'tipo_cuenta', 'vigente_desde', 'vigente_hasta'] },
  // `auditoria_seguridad_readonly` (0035, R42 — amplía 0023): agrupar por lote los movimientos
  // desactualizados (`detectar-lotes-desactualizados.ts`). Nunca `archivo_clave`/`motivo_codigo`/
  // `procesado_por` — el diagnóstico no necesita el archivo ni el detalle de un rechazo ni quién
  // corrió la ingesta, sólo agrupar y describir el lote.
  { tabla: 'lote_ingesta', rol: 'app_job', privilegio: 'SELECT', columnas: ['banco_codigo', 'cliente_id', 'created_at', 'estado', 'id'] },
  { tabla: 'lote_ingesta', rol: 'app_request', privilegio: 'INSERT', columnas: ['adaptador_version', 'archivo_clave', 'archivo_hash', 'banco_codigo', 'cliente_id', 'created_at', 'estado', 'filas_aceptadas', 'filas_leidas', 'filas_rechazadas', 'id', 'motivo_codigo', 'motivo_codigo_previo', 'origen', 'paginas_declaradas', 'paginas_sin_texto', 'procesado_por'] },
  { tabla: 'lote_ingesta', rol: 'app_request', privilegio: 'SELECT', columnas: ['adaptador_version', 'archivo_clave', 'archivo_hash', 'banco_codigo', 'cliente_id', 'created_at', 'estado', 'filas_aceptadas', 'filas_leidas', 'filas_rechazadas', 'id', 'motivo_codigo', 'motivo_codigo_previo', 'origen', 'paginas_declaradas', 'paginas_sin_texto', 'procesado_por'] },
  { tabla: 'lote_ingesta', rol: 'app_request', privilegio: 'UPDATE', columnas: ['adaptador_version', 'archivo_clave', 'archivo_hash', 'banco_codigo', 'cliente_id', 'created_at', 'estado', 'filas_aceptadas', 'filas_leidas', 'filas_rechazadas', 'id', 'motivo_codigo', 'motivo_codigo_previo', 'origen', 'paginas_declaradas', 'paginas_sin_texto', 'procesado_por'] },
  { tabla: 'lote_ingesta_cuenta', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'created_at', 'cuenta_bancaria_id', 'filas_aceptadas', 'filas_leidas', 'id', 'lote_ingesta_id', 'moneda', 'periodo_desde', 'periodo_hasta', 'saldo_final_calculado', 'saldo_final_declarado', 'saldo_inicial_declarado', 'total_creditos_calculado', 'total_creditos_declarado', 'total_debitos_calculado', 'total_debitos_declarado', 'verificacion_detalle', 'verificacion_estado'] },
  { tabla: 'lote_ingesta_cuenta', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'created_at', 'cuenta_bancaria_id', 'filas_aceptadas', 'filas_leidas', 'id', 'lote_ingesta_id', 'moneda', 'periodo_desde', 'periodo_hasta', 'saldo_final_calculado', 'saldo_final_declarado', 'saldo_inicial_declarado', 'total_creditos_calculado', 'total_creditos_declarado', 'total_debitos_calculado', 'total_debitos_declarado', 'verificacion_detalle', 'verificacion_estado'] },
  { tabla: 'lote_ingesta_cuenta', rol: 'app_request', privilegio: 'UPDATE', columnas: ['cliente_id', 'created_at', 'cuenta_bancaria_id', 'filas_aceptadas', 'filas_leidas', 'id', 'lote_ingesta_id', 'moneda', 'periodo_desde', 'periodo_hasta', 'saldo_final_calculado', 'saldo_final_declarado', 'saldo_inicial_declarado', 'total_creditos_calculado', 'total_creditos_declarado', 'total_debitos_calculado', 'total_debitos_declarado', 'verificacion_detalle', 'verificacion_estado'] },
  { tabla: 'membership', rol: 'app_job', privilegio: 'INSERT', columnas: ['activo', 'created_at', 'id', 'rol', 'tenant_node_id', 'user_id'] },
  { tabla: 'membership', rol: 'app_job', privilegio: 'SELECT', columnas: ['activo', 'created_at', 'id', 'rol', 'tenant_node_id', 'user_id'] },
  // Sólo `activo`: dar de baja una membresía es reversible; cambiarle el ROL es otra cosa.
  { tabla: 'membership', rol: 'app_job', privilegio: 'UPDATE', columnas: ['activo'] },
  { tabla: 'membership', rol: 'app_request', privilegio: 'INSERT', columnas: ['activo', 'created_at', 'id', 'rol', 'tenant_node_id', 'user_id'] },
  { tabla: 'membership', rol: 'app_request', privilegio: 'SELECT', columnas: ['activo', 'created_at', 'id', 'rol', 'tenant_node_id', 'user_id'] },
  { tabla: 'membership', rol: 'app_request', privilegio: 'UPDATE', columnas: ['activo'] },
  // 🔴 `via_depth`, `hecho_por`, `ocurrido_en` e `id` NO están en el INSERT: es lo único que sostiene
  // `0020` §3 (la fila del trigger se distingue de la escrita a mano) y que la FECHA no sea elegible.
  // Es la misma afirmación que `catalogo.test.ts` hace con `not.toContain`; acá queda cerrada por
  // conjunto, así que una CUARTA columna nombrable también se ve.
  { tabla: 'membership_historia', rol: 'app_job', privilegio: 'INSERT', columnas: ['activo_antes', 'activo_despues', 'membership_id', 'operacion', 'rol', 'tenant_node_id', 'user_id'] },
  { tabla: 'membership_historia', rol: 'app_job', privilegio: 'SELECT', columnas: ['activo_antes', 'activo_despues', 'hecho_por', 'id', 'membership_id', 'ocurrido_en', 'operacion', 'rol', 'tenant_node_id', 'user_id', 'via_depth'] },
  { tabla: 'membership_historia', rol: 'app_request', privilegio: 'INSERT', columnas: ['activo_antes', 'activo_despues', 'membership_id', 'operacion', 'rol', 'tenant_node_id', 'user_id'] },
  { tabla: 'membership_historia', rol: 'app_request', privilegio: 'SELECT', columnas: ['activo_antes', 'activo_despues', 'hecho_por', 'id', 'membership_id', 'ocurrido_en', 'operacion', 'rol', 'tenant_node_id', 'user_id', 'via_depth'] },
  // 🔴 Los tres renglones de abajo son el grant de TABLA de `0004:502`, expandido. `entrada_digest`
  // aparece en INSERT y UPDATE **sin que `0021` haya escrito una sola línea de grant**: la ACL de
  // tabla se aplica a toda columna presente, incluidas las que todavía no existían. Hoy no es
  // explotable —Postgres rechaza escribir una columna generada por MECANISMO, no por privilegio—,
  // pero es la demostración literal de por qué esta lista mira la capacidad efectiva y no el `.sql`.
  // `auditoria_seguridad_readonly` (0023, R40): diagnóstico de seguridad cross-tenant, de solo lectura.
  // Sólo las tres columnas que hacen falta para verificar aislamiento e integridad, nunca importe ni
  // saldo. La contención de escritura NO es el grant —`app_job` sigue siendo BYPASSRLS— sino
  // `set transaction read only` en `conJob` para ese motivo, que rechaza cualquier DML con `25006`.
  // `lote_ingesta_id` (0035, R42): la columna que faltaba para poder agrupar por lote — sin ella,
  // un movimiento desactualizado no se puede atribuir a NINGÚN lote.
  { tabla: 'movimiento_bancario_crudo', rol: 'app_job', privilegio: 'SELECT', columnas: ['cliente_id', 'descripcion', 'id', 'lote_ingesta_id'] },
  { tabla: 'movimiento_bancario_crudo', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'concepto_banco', 'concepto_banco_estrategia', 'concepto_codigo', 'concepto_completo', 'contraparte_captura', 'created_at', 'cuenta_bancaria_id', 'descripcion', 'entrada_digest', 'fecha', 'fecha_valor', 'fila_hash', 'fila_numero', 'id', 'importe', 'lote_ingesta_id', 'moneda', 'pagina_pdf', 'referencia_externa', 'saldo', 'saldo_es_acreedor'] },
  { tabla: 'movimiento_bancario_crudo', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'concepto_banco', 'concepto_banco_estrategia', 'concepto_codigo', 'concepto_completo', 'contraparte_captura', 'created_at', 'cuenta_bancaria_id', 'descripcion', 'entrada_digest', 'fecha', 'fecha_valor', 'fila_hash', 'fila_numero', 'id', 'importe', 'lote_ingesta_id', 'moneda', 'pagina_pdf', 'referencia_externa', 'saldo', 'saldo_es_acreedor'] },
  { tabla: 'movimiento_bancario_crudo', rol: 'app_request', privilegio: 'UPDATE', columnas: ['cliente_id', 'concepto_banco', 'concepto_banco_estrategia', 'concepto_codigo', 'concepto_completo', 'contraparte_captura', 'created_at', 'cuenta_bancaria_id', 'descripcion', 'entrada_digest', 'fecha', 'fecha_valor', 'fila_hash', 'fila_numero', 'id', 'importe', 'lote_ingesta_id', 'moneda', 'pagina_pdf', 'referencia_externa', 'saldo', 'saldo_es_acreedor'] },
  { tabla: 'movimiento_contraparte_identificador', rol: 'app_request', privilegio: 'INSERT', columnas: ['clase', 'cliente_id', 'created_at', 'id', 'identificador_hmac', 'movimiento_id', 'pepper_id'] },
  { tabla: 'movimiento_contraparte_identificador', rol: 'app_request', privilegio: 'SELECT', columnas: ['clase', 'cliente_id', 'created_at', 'id', 'identificador_hmac', 'movimiento_id', 'pepper_id'] },
  // `auditoria_seguridad_readonly` (0023, R40): mismo motivo que arriba, misma mecánica de contención.
  { tabla: 'movimiento_origen_crudo', rol: 'app_job', privilegio: 'SELECT', columnas: ['cliente_id', 'fila_origen', 'movimiento_id'] },
  { tabla: 'movimiento_origen_crudo', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'created_at', 'fila_origen', 'id', 'movimiento_id'] },
  { tabla: 'movimiento_origen_crudo', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'created_at', 'fila_origen', 'id', 'movimiento_id'] },
  // 🔴 LA PREMISA DE `0021`. Tres columnas de INSERT y nada más: sin `id` (lo pone el DEFAULT), sin
  // `manifestado_en` (la fecha NO es elegible) y sin `manifestado_por` (identidad declarada no es
  // identidad autenticada). Y **ningún** UPDATE ni DELETE, que es lo que vuelve `completo_hasta`
  // inmutable y lo que hace legítima la FK compuesta de `reconocimiento_contrapartida`.
  { tabla: 'padron_manifestacion', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'completo_hasta', 'revoca_a'] },
  { tabla: 'padron_manifestacion', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'completo_hasta', 'id', 'manifestado_en', 'manifestado_por', 'revoca_a'] },
  { tabla: 'padron_socio', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'created_at', 'denominacion', 'documento_hmac', 'documento_tipo', 'documento_ultimos4', 'id', 'pepper_id', 'vigente_desde', 'vigente_hasta'] },
  { tabla: 'padron_socio', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'created_at', 'denominacion', 'documento_hmac', 'documento_tipo', 'documento_ultimos4', 'id', 'pepper_id', 'vigente_desde', 'vigente_hasta'] },
  { tabla: 'padron_socio', rol: 'app_request', privilegio: 'UPDATE', columnas: ['denominacion', 'vigente_hasta'] },
  { tabla: 'padron_socio_documento', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'created_at', 'documento', 'id', 'socio_id'] },
  { tabla: 'padron_socio_documento', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'created_at', 'documento', 'id', 'socio_id'] },
  { tabla: 'reconocimiento_candidato', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'created_at', 'entrada_lexico_id', 'id', 'reconocimiento_clase', 'reconocimiento_id'] },
  { tabla: 'reconocimiento_candidato', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'created_at', 'entrada_lexico_id', 'id', 'reconocimiento_clase', 'reconocimiento_id'] },
  // `admite_matches` fuera del INSERT porque es generada; `id` y `created_at` porque los pone el
  // DEFAULT. Y sin UPDATE ni DELETE: la evidencia de capa C es append-only.
  { tabla: 'reconocimiento_contrapartida', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'padron_completo_hasta', 'padron_manifestacion_id', 'reconocimiento_clase', 'reconocimiento_id', 'resolucion_estado', 'resuelto_a_fecha'] },
  { tabla: 'reconocimiento_contrapartida', rol: 'app_request', privilegio: 'SELECT', columnas: ['admite_matches', 'cliente_id', 'created_at', 'id', 'padron_completo_hasta', 'padron_manifestacion_id', 'reconocimiento_clase', 'reconocimiento_id', 'regimen_matches', 'resolucion_estado', 'resuelto_a_fecha'] },
  { tabla: 'reconocimiento_contrapartida_match', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'contrapartida_id', 'match_clase', 'regimen_matches', 'socio_id'] },
  { tabla: 'reconocimiento_contrapartida_match', rol: 'app_request', privilegio: 'SELECT', columnas: ['admite_matches', 'cliente_id', 'contrapartida_id', 'created_at', 'id', 'match_clase', 'regimen_matches', 'socio_id'] },
  // 🔴 16 columnas y no 20: `0021` revocó el INSERT de TABLA y lo volvió a otorgar por columna, para
  // cerrar `created_at` (antedatar el propio reconocimiento) y `superseded_por` (nacer SUPERSEDED:
  // sale de `uq_recon_vigente`, nunca aparece en la cola, y nada falla). `id` SÍ, y es deliberado —
  // el escritor de producción lo NOMBRA.
  //
  // ⚠️ `entrada_digest` SÍ ESTÁ, y este renglón cambió: cuando el trigger COPIABA, la columna no
  // llevaba grant. Ahora la aplicación DECLARA qué entrada leyó y el trigger VERIFICA que coincida
  // con el movimiento — el grant no debilita nada porque mentir exige escribir el valor verdadero, y
  // a cambio cierra la carrera que hacía que la foto histórica registrara una entrada que el motor
  // nunca vio. Este test detectó el cambio, que es exactamente para lo que existe.
  { tabla: 'reconocimiento_movimiento', rol: 'app_request', privilegio: 'INSERT', columnas: ['clase', 'cliente_id', 'concepto', 'entrada_digest', 'evidencia_caracteres_matcheados', 'evidencia_entrada_lexico_id', 'evidencia_hubo_cola', 'id', 'lado', 'motivo_codigo', 'motor_digest', 'movimiento_id', 'polaridad', 'que_decide', 'tipo', 'via'] },
  { tabla: 'reconocimiento_movimiento', rol: 'app_request', privilegio: 'SELECT', columnas: ['clase', 'cliente_id', 'concepto', 'created_at', 'entrada_digest', 'es_propuesta', 'evidencia_caracteres_matcheados', 'evidencia_entrada_lexico_id', 'evidencia_hubo_cola', 'id', 'lado', 'motivo_codigo', 'motor_digest', 'movimiento_id', 'polaridad', 'que_decide', 'recalculo_disponible', 'superseded_por', 'tipo', 'via'] },
  { tabla: 'reconocimiento_movimiento', rol: 'app_request', privilegio: 'UPDATE', columnas: ['recalculo_disponible', 'superseded_por'] },
  { tabla: 'regla_imputacion', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'concepto', 'creada_en', 'cuenta_id', 'cuenta_resolucion', 'decidido_por', 'id', 'respaldo', 'rol_funcional_objetivo', 'tipo_movimiento', 'vigente_desde', 'vigente_hasta'] },
  { tabla: 'regla_imputacion', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'concepto', 'creada_en', 'cuenta_id', 'cuenta_resolucion', 'decidido_por', 'id', 'respaldo', 'rol_funcional_objetivo', 'tipo_movimiento', 'vigente_desde', 'vigente_hasta'] },
  { tabla: 'regla_imputacion', rol: 'app_request', privilegio: 'UPDATE', columnas: ['vigente_hasta'] },
  { tabla: 'tenant_node', rol: 'app_job', privilegio: 'INSERT', columnas: ['created_at', 'deleted_at', 'id', 'nombre', 'parent_id', 'tipo', 'updated_at'] },
  { tabla: 'tenant_node', rol: 'app_job', privilegio: 'SELECT', columnas: ['created_at', 'deleted_at', 'id', 'nid', 'nombre', 'parent_id', 'parent_path', 'path', 'tipo', 'updated_at'] },
  // `app_job` sí puede tocar `path`/`parent_path`/`parent_id` y `app_request` no: es la asimetría
  // deliberada de `0017:356` y `0018:70,78`. Queda declarada acá para que se vea de un vistazo.
  { tabla: 'tenant_node', rol: 'app_job', privilegio: 'UPDATE', columnas: ['deleted_at', 'nombre', 'parent_id', 'parent_path', 'path', 'tipo', 'updated_at'] },
  { tabla: 'tenant_node', rol: 'app_request', privilegio: 'INSERT', columnas: ['created_at', 'deleted_at', 'id', 'nombre', 'parent_id', 'tipo', 'updated_at'] },
  { tabla: 'tenant_node', rol: 'app_request', privilegio: 'SELECT', columnas: ['created_at', 'deleted_at', 'id', 'nid', 'nombre', 'parent_id', 'parent_path', 'path', 'tipo', 'updated_at'] },
  { tabla: 'tenant_node', rol: 'app_request', privilegio: 'UPDATE', columnas: ['deleted_at', 'nombre', 'tipo', 'updated_at'] },

  // --- Capa D, migración 0027 (HANDOFF 129/130) — leído del catálogo DESPUÉS de aplicar la
  // migración, no copiado del `.sql`, mismo criterio que el resto de este archivo. Todo a
  // `app_request` — cero grants a `app_job` sobre estas tablas (Capa D corre solo por `conUsuario`,
  // ningún motivo de `conJob` la toca). Verificado contra `0027_cierre_mensual.sql` línea por línea,
  // sin discrepancia, por dos agentes independientes (`dba-data` + `security-engineer`).
  //
  { tabla: 'cuenta', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'creada_en', 'id'] },
  { tabla: 'cuenta', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'creada_en', 'id'] },
  { tabla: 'cuenta_atributo', rol: 'app_request', privilegio: 'INSERT', columnas: ['activa', 'cliente_id', 'codigo', 'creada_en', 'cuenta_id', 'cuenta_padre_id', 'denominacion', 'id', 'nivel', 'padron_socio_id', 'respaldo', 'rol_funcional', 'vigente_desde', 'vigente_hasta'] },
  { tabla: 'cuenta_atributo', rol: 'app_request', privilegio: 'SELECT', columnas: ['activa', 'cliente_id', 'codigo', 'creada_en', 'cuenta_id', 'cuenta_padre_id', 'denominacion', 'id', 'nivel', 'padron_socio_id', 'respaldo', 'rol_funcional', 'vigente_desde', 'vigente_hasta'] },
  // Sólo `activa`/`vigente_hasta`: dar de baja o reabrir una cuenta es reversible; cambiarle el
  // código, la denominación, el padre o el rol_funcional es otra cosa (D-25, cuenta_particular_socio).
  { tabla: 'cuenta_atributo', rol: 'app_request', privilegio: 'UPDATE', columnas: ['activa', 'vigente_hasta'] },
  // `0028` cierra el hallazgo bloqueante (HANDOFF 130): grant de UPDATE acotado a las tres columnas
  // que la transición legítima escribe. `periodo_desde`/`periodo_hasta`/`tipo_periodo`/
  // `cierre_anterior_id` NUNCA fueron re-otorgadas — son identidad fijada al INSERT, sin camino
  // legítimo que las reescriba jamás. La inmutabilidad post-terminal de `cierre_estado`/
  // `confirmado_en`/`confirmado_por` la cierra el trigger `trg_cierre_periodo_inmutable`
  // (`app.exigir_inmutabilidad_post_terminal()`, `0028`), no una policy — verificado empíricamente
  // que un `USING` de RLS más estricto NO alcanza acá (ver comentario de la migración).
  { tabla: 'cierre_cliente_periodo', rol: 'app_request', privilegio: 'INSERT', columnas: ['cierre_anterior_id', 'cierre_estado', 'cliente_id', 'confirmado_en', 'confirmado_por', 'creado_en', 'id', 'periodo_desde', 'periodo_hasta', 'tipo_periodo'] },
  { tabla: 'cierre_cliente_periodo', rol: 'app_request', privilegio: 'SELECT', columnas: ['cierre_anterior_id', 'cierre_estado', 'cliente_id', 'confirmado_en', 'confirmado_por', 'creado_en', 'id', 'periodo_desde', 'periodo_hasta', 'tipo_periodo'] },
  { tabla: 'cierre_cliente_periodo', rol: 'app_request', privilegio: 'UPDATE', columnas: ['cierre_estado', 'confirmado_en', 'confirmado_por'] },
  { tabla: 'cierre_transicion', rol: 'app_request', privilegio: 'INSERT', columnas: ['cierre_id', 'cliente_id', 'estado_desde', 'estado_hasta', 'hecho_por', 'hecho_via', 'id', 'motivo', 'ocurrido_en'] },
  { tabla: 'cierre_transicion', rol: 'app_request', privilegio: 'SELECT', columnas: ['cierre_id', 'cliente_id', 'estado_desde', 'estado_hasta', 'hecho_por', 'hecho_via', 'id', 'motivo', 'ocurrido_en'] },
  { tabla: 'documento_ingerido', rol: 'app_request', privilegio: 'INSERT', columnas: ['banco_codigo', 'cliente_id', 'cobertura', 'creado_en', 'id', 'ingerido_en', 'lote_ingesta_id', 'objeto_almacenamiento', 'periodo_desde', 'periodo_hasta', 'superseded_by_id', 'tipo_documento'] },
  { tabla: 'documento_ingerido', rol: 'app_request', privilegio: 'SELECT', columnas: ['banco_codigo', 'cliente_id', 'cobertura', 'creado_en', 'id', 'ingerido_en', 'lote_ingesta_id', 'objeto_almacenamiento', 'periodo_desde', 'periodo_hasta', 'superseded_by_id', 'tipo_documento'] },
  { tabla: 'documento_ingerido', rol: 'app_request', privilegio: 'UPDATE', columnas: ['superseded_by_id'] },
  { tabla: 'expectativa_fuente_cliente', rol: 'app_request', privilegio: 'INSERT', columnas: ['banco_codigo', 'cliente_id', 'confirmada', 'creado_en', 'cuenta_bancaria_id', 'evidencia', 'id', 'origen', 'periodicidad', 'superseded_by_id', 'tipo_documento', 'vigencia_desde', 'vigencia_hasta'] },
  { tabla: 'expectativa_fuente_cliente', rol: 'app_request', privilegio: 'SELECT', columnas: ['banco_codigo', 'cliente_id', 'confirmada', 'creado_en', 'cuenta_bancaria_id', 'evidencia', 'id', 'origen', 'periodicidad', 'superseded_by_id', 'tipo_documento', 'vigencia_desde', 'vigencia_hasta'] },
  { tabla: 'expectativa_fuente_cliente', rol: 'app_request', privilegio: 'UPDATE', columnas: ['confirmada', 'superseded_by_id', 'vigencia_hasta'] },
  { tabla: 'fuente_cierre', rol: 'app_request', privilegio: 'INSERT', columnas: ['cierre_id', 'cliente_id', 'creado_en', 'cuenta_bancaria_id', 'documento_ingerido_id', 'estado_cuadratura', 'expectativa_id', 'id', 'superseded_by_id'] },
  { tabla: 'fuente_cierre', rol: 'app_request', privilegio: 'SELECT', columnas: ['cierre_id', 'cliente_id', 'creado_en', 'cuenta_bancaria_id', 'documento_ingerido_id', 'estado_cuadratura', 'expectativa_id', 'id', 'superseded_by_id'] },
  { tabla: 'fuente_cierre', rol: 'app_request', privilegio: 'UPDATE', columnas: ['estado_cuadratura', 'superseded_by_id'] },
  { tabla: 'pendiente_cierre', rol: 'app_request', privilegio: 'INSERT', columnas: ['cierre_id', 'cliente_id', 'creado_en', 'evidencia', 'expectativa_id', 'fuente_cierre_id', 'id', 'motivo_codigo', 'pendiente_estado', 'referencia_origen', 'resolucion_id', 'resuelto_en', 'resuelto_por', 'superseded_by_id'] },
  { tabla: 'pendiente_cierre', rol: 'app_request', privilegio: 'SELECT', columnas: ['cierre_id', 'cliente_id', 'creado_en', 'evidencia', 'expectativa_id', 'fuente_cierre_id', 'id', 'motivo_codigo', 'pendiente_estado', 'referencia_origen', 'resolucion_id', 'resuelto_en', 'resuelto_por', 'superseded_by_id'] },
  // El grant por columna no cambia (ya estaba acotado desde `0027`) — lo que cerró el hallazgo
  // secundario, no bloqueante, de `security-engineer` (HANDOFF 130: `resuelto_por`/`resuelto_en`/
  // `resolucion_id` reescribibles con el pendiente ya `resuelto`) fue el mismo trigger genérico de
  // `0028` (`trg_pendiente_cierre_inmutable`), reusado tal cual sobre esta tabla sin variante puntual.
  { tabla: 'pendiente_cierre', rol: 'app_request', privilegio: 'UPDATE', columnas: ['pendiente_estado', 'resolucion_id', 'resuelto_en', 'resuelto_por', 'superseded_by_id'] },
  { tabla: 'pendiente_dispensa', rol: 'app_request', privilegio: 'INSERT', columnas: ['cliente_id', 'dispensado_en', 'dispensado_por', 'id', 'motivo', 'pendiente_cierre_id'] },
  { tabla: 'pendiente_dispensa', rol: 'app_request', privilegio: 'SELECT', columnas: ['cliente_id', 'dispensado_en', 'dispensado_por', 'id', 'motivo', 'pendiente_cierre_id'] },
  // `0028`: mismo patrón que `cierre_cliente_periodo` arriba. `tipo`/`fecha_imputacion`/`cierre_id`
  // NUNCA fueron re-otorgadas — identidad fijada al INSERT. `asiento_estado`/`superseded_by_id` siguen
  // grantables porque son la transición legítima (confirmar, superseder) — la inmutabilidad post-
  // terminal la cierra `trg_asiento_propuesto_inmutable`, no la policy.
  { tabla: 'asiento_propuesto', rol: 'app_request', privilegio: 'INSERT', columnas: ['asiento_estado', 'cierre_id', 'cliente_id', 'creado_en', 'fecha_imputacion', 'id', 'superseded_by_id', 'tipo'] },
  { tabla: 'asiento_propuesto', rol: 'app_request', privilegio: 'SELECT', columnas: ['asiento_estado', 'cierre_id', 'cliente_id', 'creado_en', 'fecha_imputacion', 'id', 'superseded_by_id', 'tipo'] },
  { tabla: 'asiento_propuesto', rol: 'app_request', privilegio: 'UPDATE', columnas: ['asiento_estado', 'superseded_by_id'] },
  { tabla: 'asiento_propuesto_renglon', rol: 'app_request', privilegio: 'INSERT', columnas: ['asiento_id', 'cliente_id', 'creado_en', 'cuenta_id', 'cuenta_ref', 'debe', 'fecha_imputacion', 'fuente_cierre_id', 'haber', 'id', 'orden', 'padron_manifestacion_id', 'referencia_origen', 'valuacion_ref', 'verificacion_heredada'] },
  { tabla: 'asiento_propuesto_renglon', rol: 'app_request', privilegio: 'SELECT', columnas: ['asiento_id', 'cliente_id', 'creado_en', 'cuenta_id', 'cuenta_ref', 'debe', 'fecha_imputacion', 'fuente_cierre_id', 'haber', 'id', 'orden', 'padron_manifestacion_id', 'referencia_origen', 'valuacion_ref', 'verificacion_heredada'] },
  // La vista `asiento_propuesto_totales` (`security_invoker=true`, D-16 de HANDOFF 128): sin este
  // grant, el dueño del esquema bypassea RLS al resolverla — SELECT únicamente, nunca escritura (es
  // un agregado, no una tabla).
  { tabla: 'asiento_propuesto_totales', rol: 'app_request', privilegio: 'SELECT', columnas: ['asiento_id', 'cliente_id', 'total_debe', 'total_haber'] },
];

/**
 * Privilegios que **NO se pueden expresar por columna** y que por lo tanto
 * `information_schema.column_privileges` no muestra jamás: `DELETE`, `TRUNCATE`, `TRIGGER`
 * (y `MAINTAIN` desde PG 17).
 *
 * 🔴 Este bloque es la mitad que faltaba en la especificación de §4.4. `grant delete on
 * padron_manifestacion` mata la premisa de frescura tan bien como `grant update`: borrada la
 * manifestación, el espejo `padron_completo_hasta` de `reconocimiento_contrapartida` afirma un
 * hecho sobre una fila que ya no existe.
 *
 * Que las cuatro tablas de `0021` NO figuren acá **es** la afirmación.
 */
const GRANTS_SOLO_DE_TABLA: readonly {
  readonly tabla: string;
  readonly rol: string;
  readonly privilegio: string;
}[] = [
  { tabla: 'cuenta_bancaria', rol: 'app_request', privilegio: 'DELETE' },
  { tabla: 'cuenta_bancaria_identificador', rol: 'app_request', privilegio: 'DELETE' },
  { tabla: 'movimiento_bancario_crudo', rol: 'app_request', privilegio: 'DELETE' },
  { tabla: 'tenant_node', rol: 'app_job', privilegio: 'DELETE' },
  { tabla: 'tenant_node', rol: 'app_request', privilegio: 'DELETE' },
];

/**
 * R41b — **LA FORMA**, no la capacidad: qué privilegios están otorgados a nivel TABLA.
 *
 * Un grant de tabla y un grant por columna que hoy cubre todas las columnas son **indistinguibles**
 * en la capacidad efectiva, y **completamente distintos** en el futuro: el de tabla absorbe cada
 * columna nueva **en silencio, sin una línea de migración**. Ya pasó: `entrada_digest`, agregada por
 * `0021` a `movimiento_bancario_crudo`, quedó con `INSERT` y `UPDATE` para `app_request` por el
 * grant de tabla de `0004:502`.
 *
 * Por eso este segundo conjunto cerrado existe, y por eso hay una mutación (`M9`) cuyo único trabajo
 * es probar que **no es redundante** con el de arriba: cambia la forma sin cambiar la capacidad, y
 * sólo éste se pone rojo.
 *
 * ⚠️ Agregar un renglón acá **no** es un trámite: es declarar que esa tabla acepta columnas nuevas
 * con ese privilegio ya otorgado. Para un `SELECT` puede ser aceptable; para `INSERT`/`UPDATE` es
 * una decisión de seguridad que va con su motivo escrito.
 */
const GRANTS_A_NIVEL_TABLA: readonly string[] = [
  'acceso_auditoria|app_request|SELECT',
  'anexo_extracto|app_request|INSERT',
  'anexo_extracto|app_request|SELECT',
  // `0028`: SELECT/INSERT siguen sin acotar por columna (nunca fueron el problema); solo UPDATE se
  // acotó — por eso no aparece acá, ver GRANTS_POR_COLUMNA.
  'asiento_propuesto|app_request|INSERT',
  'asiento_propuesto|app_request|SELECT',
  'asiento_propuesto_renglon|app_request|INSERT',
  'asiento_propuesto_renglon|app_request|SELECT',
  'asiento_propuesto_totales|app_request|SELECT',
  'banco|app_job|SELECT',
  'banco|app_request|SELECT',
  'cierre_cliente_periodo|app_request|INSERT',
  'cierre_cliente_periodo|app_request|SELECT',
  'cierre_transicion|app_request|INSERT',
  'cierre_transicion|app_request|SELECT',
  'cotizacion_bna|app_request|SELECT',
  'credencial_fiscal|app_firmador|INSERT',
  'credencial_fiscal|app_firmador|SELECT',
  'credencial_fiscal|app_firmador|UPDATE',
  'credencial_fiscal_rotacion|app_firmador|INSERT',
  'credencial_fiscal_rotacion|app_firmador|SELECT',
  'credencial_fiscal_rotacion|app_request|INSERT',
  'credencial_fiscal_rotacion|app_request|SELECT',
  'cuenta|app_request|INSERT',
  'cuenta|app_request|SELECT',
  'cuenta_atributo|app_request|INSERT',
  'cuenta_atributo|app_request|SELECT',
  'cuenta_bancaria|app_request|DELETE',
  'cuenta_bancaria|app_request|INSERT',
  'cuenta_bancaria|app_request|SELECT',
  'cuenta_bancaria|app_request|UPDATE',
  'cuenta_bancaria_identificador|app_request|DELETE',
  'cuenta_bancaria_identificador|app_request|INSERT',
  'cuenta_bancaria_identificador|app_request|SELECT',
  'cuenta_bancaria_identificador|app_request|UPDATE',
  'documento_ingerido|app_request|INSERT',
  'documento_ingerido|app_request|SELECT',
  'expectativa_fuente_cliente|app_request|INSERT',
  'expectativa_fuente_cliente|app_request|SELECT',
  'fuente_cierre|app_request|INSERT',
  'fuente_cierre|app_request|SELECT',
  'lote_ingesta|app_request|INSERT',
  'lote_ingesta|app_request|SELECT',
  'lote_ingesta|app_request|UPDATE',
  'lote_ingesta_cuenta|app_request|INSERT',
  'lote_ingesta_cuenta|app_request|SELECT',
  'lote_ingesta_cuenta|app_request|UPDATE',
  'membership|app_job|INSERT',
  'membership|app_job|SELECT',
  'membership|app_request|INSERT',
  'membership|app_request|SELECT',
  'membership_historia|app_job|SELECT',
  'membership_historia|app_request|SELECT',
  'movimiento_bancario_crudo|app_request|DELETE',
  'movimiento_bancario_crudo|app_request|INSERT',
  'movimiento_bancario_crudo|app_request|SELECT',
  'movimiento_bancario_crudo|app_request|UPDATE',
  'movimiento_contraparte_identificador|app_request|INSERT',
  'movimiento_contraparte_identificador|app_request|SELECT',
  'movimiento_origen_crudo|app_request|INSERT',
  'movimiento_origen_crudo|app_request|SELECT',
  'padron_manifestacion|app_request|SELECT',
  'padron_socio|app_request|INSERT',
  'padron_socio|app_request|SELECT',
  'padron_socio_documento|app_request|INSERT',
  'padron_socio_documento|app_request|SELECT',
  'pendiente_cierre|app_request|INSERT',
  'pendiente_cierre|app_request|SELECT',
  'pendiente_dispensa|app_request|INSERT',
  'pendiente_dispensa|app_request|SELECT',
  'reconocimiento_candidato|app_request|INSERT',
  'reconocimiento_candidato|app_request|SELECT',
  'reconocimiento_contrapartida|app_request|SELECT',
  'reconocimiento_contrapartida_match|app_request|SELECT',
  'reconocimiento_movimiento|app_request|SELECT',
  'regla_imputacion|app_request|INSERT',
  'regla_imputacion|app_request|SELECT',
  'tenant_node|app_job|DELETE',
  'tenant_node|app_job|SELECT',
  'tenant_node|app_request|DELETE',
  'tenant_node|app_request|SELECT',
];

/**
 * El único rol excluido del barrido, y por qué se excluye **con su propia aserción**.
 *
 * Toda relación de `public` es del dueño del esquema, que bajo la premisa **P-1** es `rolsuper` en
 * local y en el piloto. Su entrada en la ACL no es un grant que alguien escribió: es un artefacto de
 * `create table`, y da igual, porque un superusuario saltea el sistema de privilegios entero.
 *
 * 🔴 Pero excluir un nombre a mano es abrir un agujero, así que el conjunto de dueños **también** es
 * cerrado: si aparece una relación con otro dueño, el test se pone rojo antes de excluir nada.
 */
const DUENIO_DEL_ESQUEMA = 'sistema_contable';

/**
 * 🔴 **EL GRAFO DE MEMBRESÍAS, TAMBIÉN CERRADO.** `miembro` hereda todo lo de `de`.
 *
 * Un privilegio heredado no figura en ninguna ACL, así que el barrido de arriba **no lo ve**. Con
 * una sola línea —`grant app_request to app_job`— `app_job`, que es `BYPASSRLS`, pasaría a leer y
 * escribir las cuatro tablas de `0021` sin que ni una entrada del conjunto de grants cambie.
 *
 * `app_request_dev` → `app_request` es la única membresía legítima: es el rol con `login` con el que
 * se conecta el entorno local; `app_request` es `nologin` a propósito.
 */
const MEMBRESIAS_DE_ROL: readonly string[] = ['app_request_dev → app_request'];

// -----------------------------------------------------------------------------
// El barrido
// -----------------------------------------------------------------------------

type Barrido = {
  /** Cuántas relaciones vio. Cero = el barrido no está mirando nada (R39c). */
  readonly relaciones: number;
  /** `tabla.columna|PRIVILEGIO|rol` — la capacidad EFECTIVA, con el grant de tabla ya expandido. */
  readonly porColumna: readonly string[];
  /** `tabla|PRIVILEGIO|rol` — privilegios no expresables por columna (DELETE/TRUNCATE/TRIGGER). */
  readonly soloDeTabla: readonly string[];
  /** `tabla|rol|PRIVILEGIO` — la FORMA: qué está otorgado a nivel tabla. */
  readonly aNivelTabla: readonly string[];
  /** Todo grant con `with grant option`, en cualquiera de los dos niveles. */
  readonly conOpcionDeGrant: readonly string[];
  /** Dueños distintos de las relaciones barridas. */
  readonly duenios: readonly string[];
};

/**
 * Lee el catálogo CRUDO. No usa `information_schema` a propósito (ver el encabezado): esa vista
 * filtra por rol habilitado y no conoce `DELETE`.
 *
 * `relkind in ('r','p','v','m','f')` — tablas, particionadas, vistas, materializadas y foráneas. Las
 * vistas entran aunque hoy no haya ninguna: una vista con un grant es una puerta lateral, y tiene
 * que nacer roja acá en vez de depender de que alguien se acuerde.
 */
async function barrer(db: Client, esquema: string): Promise<Barrido> {
  const { rows } = await db.query<{ clase: string; entrada: string }>(
    `with rel as (
       select c.oid, c.relname, c.relacl, pg_get_userbyid(c.relowner) as duenio
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f')
     ),
     col as (
       select r.oid, r.relname, r.duenio, a.attname, a.attacl
         from rel r
         join pg_attribute a on a.attrelid = r.oid
        where a.attnum > 0 and not a.attisdropped
     ),
     acl_rel as (
       select r.relname, r.duenio,
              case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end::text as rol,
              x.privilege_type as priv, x.is_grantable
         from rel r cross join lateral aclexplode(r.relacl) x
     ),
     acl_col as (
       select c.relname, c.duenio, c.attname,
              case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end::text as rol,
              x.privilege_type as priv, x.is_grantable
         from col c cross join lateral aclexplode(c.attacl) x
     ),
     -- 🔴 La expansión, explícita: un privilegio otorgado a nivel TABLA vale sobre TODA columna
     -- presente, incluidas las que no existían cuando se escribió el grant.
     efectivo as (
       select relname, attname, priv, rol, duenio from acl_col
       union
       select c.relname, c.attname, a.priv, a.rol, c.duenio
         from acl_rel a
         join col c on c.relname = a.relname
        where a.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
     )
     -- 🔴 TODO va con ::text explícito, y NO es cosmético. relname y attname son de tipo "name"
     -- (63 caracteres), y el tipo de la columna de un UNION ALL lo fija la PRIMERA rama: sin estos
     -- casts la columna entera resuelve a "name" y toda entrada de 64 caracteres o más SE TRUNCA EN
     -- SILENCIO. Medido: ...|SELECT|app_request quedaba ...|SELECT|app_reque, y el conjunto de la
     -- base divergía del declarado por un motivo que no tenía nada que ver con los grants.
     -- Se descubrió corriéndolo, no leyéndolo.
     select 'RELACION'::text as clase, relname::text as entrada from rel
     union all
     select 'DUENIO'::text, duenio::text from rel
     union all
     select 'COLUMNA'::text, relname::text || '.' || attname::text || '|' || priv || '|' || rol
       from efectivo where rol <> duenio
     union all
     select 'SOLO_TABLA'::text, relname::text || '|' || priv || '|' || rol
       from acl_rel
      where rol <> duenio and priv not in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
     union all
     select 'NIVEL_TABLA'::text, relname::text || '|' || rol || '|' || priv
       from acl_rel where rol <> duenio
     union all
     select 'OPCION'::text, relname::text || '|' || priv || '|' || rol
       from acl_rel where rol <> duenio and is_grantable
     union all
     select 'OPCION'::text, relname::text || '.' || attname::text || '|' || priv || '|' || rol
       from acl_col where rol <> duenio and is_grantable`,
    [esquema],
  );

  const de = (clase: string): string[] =>
    [...new Set(rows.filter((f) => f.clase === clase).map((f) => f.entrada))].sort();

  return {
    relaciones: de('RELACION').length,
    porColumna: de('COLUMNA'),
    soloDeTabla: de('SOLO_TABLA'),
    aNivelTabla: de('NIVEL_TABLA'),
    conOpcionDeGrant: de('OPCION'),
    duenios: de('DUENIO'),
  };
}

/** Lo declarado, aplanado a la misma forma que devuelve el barrido. */
const DECLARADO_POR_COLUMNA: readonly string[] = GRANTS_POR_COLUMNA.flatMap((g) =>
  g.columnas.map((c) => `${g.tabla}.${c}|${g.privilegio}|${g.rol}`),
).sort();

const DECLARADO_SOLO_DE_TABLA: readonly string[] = GRANTS_SOLO_DE_TABLA.map(
  (g) => `${g.tabla}|${g.privilegio}|${g.rol}`,
).sort();

const DECLARADO_A_NIVEL_TABLA: readonly string[] = [...GRANTS_A_NIVEL_TABLA].sort();

/**
 * Las discrepancias, **etiquetadas**. Devolver una lista de strings y no un booleano es lo que
 * permite que cada mutación exija la entrada exacta que tiene que aparecer: un
 * `expect(...).not.toEqual([])` pelado deja pasar que la discrepancia la detecte el detector
 * equivocado, que es el mismo defecto que `esperarRechazo()` evita en `mutaciones-0021.test.ts`.
 */
function discrepancias(b: Barrido): string[] {
  const fuera: string[] = [];

  // 🔴 R39c PRIMERO, y con salida temprana. Un barrido apuntado a un esquema vacío devuelve cero
  // filas: el diagnóstico real es "no vio ninguna tabla", y sin la salida temprana quedaría sepultado
  // bajo 621 líneas de FALTA que no dicen nada.
  if (b.relaciones === 0) {
    fuera.push('VACUIDAD: el barrido no vio ninguna relación — no está mirando el esquema');
    return fuera;
  }

  const diff = (etiqueta: string, enLaBase: readonly string[], declarado: readonly string[]): void => {
    const dec = new Set(declarado);
    const base = new Set(enLaBase);
    for (const x of enLaBase) if (!dec.has(x)) fuera.push(`${etiqueta} SOBRA: ${x}`);
    for (const x of declarado) if (!base.has(x)) fuera.push(`${etiqueta} FALTA: ${x}`);
  };

  diff('POR_COLUMNA', b.porColumna, DECLARADO_POR_COLUMNA);
  diff('SOLO_DE_TABLA', b.soloDeTabla, DECLARADO_SOLO_DE_TABLA);
  diff('A_NIVEL_TABLA', b.aNivelTabla, DECLARADO_A_NIVEL_TABLA);

  for (const x of b.conOpcionDeGrant) fuera.push(`CON_OPCION_DE_GRANT: ${x}`);
  for (const d of b.duenios) if (d !== DUENIO_DEL_ESQUEMA) fuera.push(`DUENIO INESPERADO: ${d}`);

  return fuera.sort();
}

// -----------------------------------------------------------------------------
// El laboratorio de mutación
// -----------------------------------------------------------------------------

/**
 * Corre `fn` con los grants mutados, sobre una transacción del dueño que **siempre** se rollbackea.
 *
 * `grant`, `revoke`, `create table`, `create schema` y `create role` son todos transaccionales en
 * PostgreSQL, así que nada de esto llega al disco. Tres guardas:
 *   1. `entornoActual() === 'local'`, o lanza. 🔴 El piloto no se toca ni para leer.
 *   2. `rollback` en el `finally`, antes de cerrar la conexión.
 *   3. Al salir se verifica que el barrido volvió **idéntico** al de antes de mutar. Un rollback que
 *      no restaura dejaría el esquema local distinto del de la migración y todos los tests
 *      siguientes medirían otra cosa, sin decirlo.
 */
async function conGrantsMutados(
  ddl: readonly string[],
  fn: (db: Client) => Promise<void>,
): Promise<void> {
  if (entornoActual() !== 'local') {
    throw new Error(
      `Las pruebas de mutación de grants corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`,
    );
  }
  const duenio = await clienteDuenio();
  try {
    const antes = await barrer(duenio, 'public');
    await duenio.query('begin');
    try {
      for (const sentencia of ddl) await duenio.query(sentencia);
      await fn(duenio);
    } finally {
      await duenio.query('rollback');
      const despues = await barrer(duenio, 'public');
      expect(despues, 'el rollback de la mutación de grants NO restauró el esquema').toEqual(antes);
    }
  } finally {
    await duenio.end();
  }
}

/**
 * Las membresías de rol, que viven en `pg_auth_members` y no en ninguna ACL. Se excluyen los roles
 * internos de PostgreSQL (`pg_read_all_data` y compañía), que no los otorga este proyecto.
 */
async function membresias(db: Client): Promise<string[]> {
  const { rows } = await db.query<{ e: string }>(
    `select r.rolname::text || ' → ' || g.rolname::text as e
       from pg_auth_members m
       join pg_roles r on r.oid = m.member
       join pg_roles g on g.oid = m.roleid
      where g.rolname not like 'pg\_%' and r.rolname not like 'pg\_%'`,
  );
  return [...new Set(rows.map((f) => f.e))].sort();
}

/** El barrido de `public` con sus discrepancias ya calculadas. */
async function discrepanciasDe(db: Client): Promise<string[]> {
  return discrepancias(await barrer(db, 'public'));
}

// -----------------------------------------------------------------------------

let db: Client;

beforeAll(async () => {
  db = await clienteDuenio();
});

afterAll(async () => {
  await db?.end();
});

// -----------------------------------------------------------------------------
describe('R41 — el conjunto de grants es CERRADO (caso legítimo)', () => {
  it('L1: el esquema tal como está no tiene ni un grant de más ni uno de menos', async () => {
    const b = await barrer(db, 'public');

    // Se afirma primero lo LEGIBLE —qué sobra y qué falta— y recién después la igualdad de
    // conjuntos. El orden importa para el mensaje de error, no para el resultado.
    expect(
      discrepancias(b),
      'el conjunto de grants efectivos difiere del declarado. SOBRA = alguien otorgó algo que nadie ' +
        'declaró (y si es un grant de TABLA, ya está absorbiendo toda columna futura). FALTA = se ' +
        'revocó algo que el código sigue necesitando, o se agregó una columna a una tabla con grant ' +
        'por columna sin otorgarla.',
    ).toEqual([]);

    // La igualdad de conjunto, literal. Redundante con lo de arriba a propósito: es la aserción que
    // el dictamen §4.4 pidió, y no depende de que `discrepancias()` esté bien escrita.
    expect(b.porColumna).toEqual(DECLARADO_POR_COLUMNA);
    expect(b.soloDeTabla).toEqual(DECLARADO_SOLO_DE_TABLA);
    expect(b.aNivelTabla).toEqual(DECLARADO_A_NIVEL_TABLA);
  });

  it('L1b: el barrido crudo coincide con information_schema — dos caminos, mismo número', async () => {
    // Control cruzado. `information_schema.column_privileges` es el camino que el dictamen §4.4
    // propuso: expande un grant de tabla a una fila por columna. El barrido de este archivo lo hace a
    // mano sobre `aclexplode`. Si los dos dejan de coincidir, o la vista cambió de semántica o la
    // expansión de acá está mal — y en cualquiera de los dos casos hay que mirarlo, no seguir.
    const { rows } = await db.query<{ e: string }>(
      `select table_name || '.' || column_name || '|' || privilege_type || '|' || grantee as e
         from information_schema.column_privileges
        where table_schema = 'public' and grantee <> $1`,
      [DUENIO_DEL_ESQUEMA],
    );
    const porLaVista = [...new Set(rows.map((f) => f.e))].sort();
    const porElCatalogo = [...(await barrer(db, 'public')).porColumna];

    expect(porLaVista, 'el barrido crudo y information_schema divergen').toEqual(porElCatalogo);
    expect(porLaVista.length, 'el control cruzado no comparó nada').toBeGreaterThan(100);
  });

  it('🔴 L1c: `padron_manifestacion` no tiene UPDATE ni DELETE de NADIE — la premisa de 0021', async () => {
    // Se deriva del conjunto cerrado, pero se enuncia aparte porque es LA afirmación de la que
    // depende la FK compuesta de `reconocimiento_contrapartida`. Quien abra este archivo dentro de un
    // año tiene que encontrarla escrita, no tener que derivarla de 621 renglones.
    const b = await barrer(db, 'public');
    const sobreLaTabla = [...b.porColumna, ...b.soloDeTabla].filter((x) =>
      x.startsWith('padron_manifestacion'),
    );
    expect(
      sobreLaTabla.filter((x) => x.includes('|UPDATE|') || x.includes('|DELETE|')),
      'con UPDATE o DELETE sobre padron_manifestacion, `completo_hasta` deja de ser inmutable y la FK ' +
        'compuesta de reconocimiento_contrapartida pasa a afirmar un hecho que ya no es cierto. El ' +
        'control de frescura se cae EN SILENCIO: nada falla, la fila sigue ahí, y el espejo miente.',
    ).toEqual([]);
    expect(sobreLaTabla.length, 'el filtro no encontró la tabla: no está midiendo nada').toBe(9);
  });

  it('🔴 L1d: `app_job` no tiene NADA sobre las cuatro tablas de 0021', async () => {
    // Lo que detiene a `app_job` no es una policy: es que no tiene un solo grant. Ningún motivo de
    // `MotivoJob` alcanza estas tablas, y `siembra_sintetica` —el único que escribe dominio— no las
    // siembra. Si un día alguien le otorga algo, `app_job` es BYPASSRLS: la policy no lo va a frenar.
    const b = await barrer(db, 'public');
    const tablasDe0021 = [
      'padron_manifestacion',
      'reconocimiento_contrapartida',
      'reconocimiento_contrapartida_match',
      'reconocimiento_movimiento',
    ];
    expect(
      [...b.porColumna, ...b.soloDeTabla].filter(
        (x) => x.endsWith('|app_job') && tablasDe0021.some((t) => x.startsWith(t)),
      ),
      'app_job es BYPASSRLS: un grant suyo sobre estas tablas no lo frena ninguna policy',
    ).toEqual([]);
  });

  it('🔴 L1e: el grafo de MEMBRESÍAS de rol es el declarado', async () => {
    // El otro camino por el que un rol consigue un privilegio, y el que ninguna ACL muestra.
    expect(
      await membresias(db),
      'una membresía de rol no declarada reparte TODOS los privilegios del rol otorgante sin tocar ' +
        'una sola ACL: el conjunto cerrado de grants queda verde y el privilegio existe igual.',
    ).toEqual([...MEMBRESIAS_DE_ROL].sort());
  });

  it('L2 (legítimo): una tabla NUEVA sin ningún grant no rompe nada', async () => {
    // Refuta la implementación «toda tabla tiene que estar declarada», que pasaría las 13 mutaciones
    // y rompería la próxima migración por un motivo falso.
    await conGrantsMutados(
      ['create table tabla_sin_grants_lab (id uuid primary key, cliente_id uuid not null)'],
      async (c) => {
        expect(await discrepanciasDe(c)).toEqual([]);
      },
    );
  });

  it('L3 (legítimo): un rol NUEVO sin ningún grant no rompe nada', async () => {
    await conGrantsMutados(['create role rol_sin_grants_lab nologin'], async (c) => {
      expect(await discrepanciasDe(c)).toEqual([]);
    });
  });
});

// -----------------------------------------------------------------------------
describe('R41 — prueba de mutación: 13 mutaciones, elegidas para refutar', () => {
  it('🔴 M1: un grant de TABLA de más (`update on padron_manifestacion`) lo pone rojo', async () => {
    // EL CASO QUE MOTIVA TODO EL ARCHIVO. Es la forma exacta de `0004:502`, la que tres agentes no
    // vieron grepeando `grant update (`. Una sola línea, y la premisa de frescura de 0021 muere.
    await conGrantsMutados(['grant update on padron_manifestacion to app_request'], async (c) => {
      const d = await discrepanciasDe(c);
      // Se expande a las SEIS columnas, que es lo que un `grep` no muestra y esta lista sí.
      expect(d).toContain('POR_COLUMNA SOBRA: padron_manifestacion.completo_hasta|UPDATE|app_request');
      expect(d).toContain('POR_COLUMNA SOBRA: padron_manifestacion.manifestado_por|UPDATE|app_request');
      expect(d.filter((x) => x.startsWith('POR_COLUMNA SOBRA: padron_manifestacion'))).toHaveLength(6);
      // Y la FORMA también se queja, porque el grant es de tabla.
      expect(d).toContain('A_NIVEL_TABLA SOBRA: padron_manifestacion|app_request|UPDATE');
    });
  });

  it('M2: un grant por COLUMNA de más (`update (completo_hasta)`) lo pone rojo', async () => {
    // El mismo ataque con la otra sintaxis. Es la mínima expresión: UNA columna, la que la FK usa.
    await conGrantsMutados(
      ['grant update (completo_hasta) on padron_manifestacion to app_request'],
      async (c) => {
        expect(await discrepanciasDe(c)).toEqual([
          'POR_COLUMNA SOBRA: padron_manifestacion.completo_hasta|UPDATE|app_request',
        ]);
      },
    );
  });

  it('M3: un privilegio de MENOS (`revoke insert (revoca_a)`) lo pone rojo', async () => {
    // Sin esta mutación, una implementación que sólo mirara «qué sobra» —o sea `not.toContain`, que
    // es literalmente lo que hoy hacen los dos tests de `catalogo.test.ts`— pasaría verde.
    await conGrantsMutados(
      ['revoke insert (revoca_a) on padron_manifestacion from app_request'],
      async (c) => {
        expect(await discrepanciasDe(c)).toEqual([
          'POR_COLUMNA FALTA: padron_manifestacion.revoca_a|INSERT|app_request',
        ]);
      },
    );
  });

  it('🔴 M4: un grant a `app_job` sobre una tabla de 0021 lo pone rojo', async () => {
    await conGrantsMutados(['grant select on reconocimiento_contrapartida to app_job'], async (c) => {
      const d = await discrepanciasDe(c);
      expect(d).toContain('A_NIVEL_TABLA SOBRA: reconocimiento_contrapartida|app_job|SELECT');
      expect(d).toContain(
        'POR_COLUMNA SOBRA: reconocimiento_contrapartida.resolucion_estado|SELECT|app_job',
      );
      expect(d.filter((x) => x.startsWith('POR_COLUMNA SOBRA:'))).toHaveLength(11);
    });
  });

  it('🔴 M5: `grant delete` — invisible a `column_privileges` — lo pone rojo igual', async () => {
    // LA MUTACIÓN QUE REFUTA LA ESPECIFICACIÓN DE §4.4. `DELETE` no es expresable por columna, así
    // que `information_schema.column_privileges` NO lo muestra: un test escrito exactamente como el
    // dictamen lo especificó habría quedado VERDE con este grant puesto. Y borrada la manifestación,
    // el espejo `padron_completo_hasta` afirma un hecho sobre una fila que ya no existe.
    await conGrantsMutados(['grant delete on padron_manifestacion to app_request'], async (c) => {
      const b = await barrer(c, 'public');

      // 🔴 La mitad "por columna" queda VERDE. Eso es el hallazgo, no un efecto colateral.
      expect(
        b.porColumna,
        'si esto fallara, DELETE se estaría viendo por columna y M5 no probaría nada',
      ).toEqual(DECLARADO_POR_COLUMNA);

      expect(discrepancias(b)).toEqual([
        'A_NIVEL_TABLA SOBRA: padron_manifestacion|app_request|DELETE',
        'SOLO_DE_TABLA SOBRA: padron_manifestacion|DELETE|app_request',
      ]);
    });
  });

  it('M6: `grant trigger` — el otro privilegio sólo-de-tabla — lo pone rojo', async () => {
    // Refuta un barrido cableado a `DELETE`. Y no es teórico: con `trigger` sobre la tabla, un rol
    // que consiguiera `create` en algún esquema (R39) podría colgarle un trigger propio.
    await conGrantsMutados(
      ['grant trigger on reconocimiento_contrapartida_match to app_request'],
      async (c) => {
        expect(await discrepanciasDe(c)).toEqual([
          'A_NIVEL_TABLA SOBRA: reconocimiento_contrapartida_match|app_request|TRIGGER',
          'SOLO_DE_TABLA SOBRA: reconocimiento_contrapartida_match|TRIGGER|app_request',
        ]);
      },
    );
  });

  it('M7: un grant a un ROL que no existía lo pone rojo', async () => {
    // Refuta la implementación cableada a `('app_request','app_job','app_firmador')`, que es la que
    // sale sola de mirar las migraciones. Un rol nuevo con grants es el camino más barato para que
    // aparezca una credencial que nadie modeló.
    await conGrantsMutados(
      [
        'create role rol_intruso_lab nologin',
        'grant select on padron_manifestacion to rol_intruso_lab',
      ],
      async (c) => {
        const d = await discrepanciasDe(c);
        expect(d).toContain('A_NIVEL_TABLA SOBRA: padron_manifestacion|rol_intruso_lab|SELECT');
        expect(d).toContain(
          'POR_COLUMNA SOBRA: padron_manifestacion.manifestado_por|SELECT|rol_intruso_lab',
        );
      },
    );
  });

  it('M8: una TABLA NUEVA con grants lo pone rojo', async () => {
    // Refuta la implementación cableada a una lista de tablas — que es exactamente lo que el pedido
    // admitía («como mínimo las tablas de 0021»). Con la lista corta, `0022` puede crear una tabla
    // con `grant update` de tabla y este archivo queda verde. ES la justificación de barrer todo.
    await conGrantsMutados(
      [
        'create table tabla_nueva_lab (id uuid primary key, cliente_id uuid not null, dato text)',
        'grant select, update on tabla_nueva_lab to app_request',
      ],
      async (c) => {
        const d = await discrepanciasDe(c);
        expect(d).toContain('POR_COLUMNA SOBRA: tabla_nueva_lab.dato|SELECT|app_request');
        expect(d).toContain('POR_COLUMNA SOBRA: tabla_nueva_lab.dato|UPDATE|app_request');
        expect(d).toContain('A_NIVEL_TABLA SOBRA: tabla_nueva_lab|app_request|SELECT');
      },
    );
  });

  it('🔴 M9: misma capacidad, otra FORMA (tabla → columna) — sólo R41b se pone rojo', async () => {
    // LA ÚNICA QUE PRUEBA QUE R41b NO ES REDUNDANTE CON R41. Se revoca el SELECT de tabla sobre
    // `padron_manifestacion` y se re-otorga por columna cubriendo las SEIS columnas: la capacidad
    // efectiva de hoy es idéntica, byte por byte. Lo que cambia es el futuro — con grant de tabla, la
    // columna que agregue `0022` nace legible; por columna, no.
    //
    // La dirección inversa (columna → tabla con cobertura completa) es la peligrosa, y la cubre el
    // mismo detector: lo que R41b compara es el conjunto de FORMA, en las dos direcciones.
    await conGrantsMutados(
      [
        'revoke select on padron_manifestacion from app_request',
        `grant select (cliente_id, completo_hasta, id, manifestado_en, manifestado_por, revoca_a)
           on padron_manifestacion to app_request`,
      ],
      async (c) => {
        const b = await barrer(c, 'public');

        // 🔴 La capacidad efectiva NO cambió. Si esto fallara, la mutación no estaría aislando la
        // forma y M9 no probaría nada.
        expect(b.porColumna, 'la mutación cambió la capacidad, no sólo la forma').toEqual(
          DECLARADO_POR_COLUMNA,
        );

        expect(discrepancias(b)).toEqual([
          'A_NIVEL_TABLA FALTA: padron_manifestacion|app_request|SELECT',
        ]);
      },
    );
  });

  it('🔴 M10: el mismo grant `with grant option` lo pone rojo', async () => {
    // La capacidad por columna tampoco cambia acá: cambian los repartidores. Un rol que puede
    // re-otorgar puede dárselo a cualquiera, y ese grant de segunda mano no lo autoriza ninguna
    // migración. Sin esta mutación, una implementación que ignorara `is_grantable` pasa las once
    // restantes.
    await conGrantsMutados(
      ['grant select on padron_manifestacion to app_request with grant option'],
      async (c) => {
        const b = await barrer(c, 'public');
        expect(
          b.porColumna,
          'la opción de grant no debería cambiar la capacidad por columna',
        ).toEqual(DECLARADO_POR_COLUMNA);
        expect(discrepancias(b)).toEqual([
          'CON_OPCION_DE_GRANT: padron_manifestacion|SELECT|app_request',
        ]);
      },
    );
  });

  it('🔴 M11: el barrido apuntado a un esquema SIN TABLAS se pone rojo por vacuidad', async () => {
    // R39c. Sin esto, M1–M10 pasan sin mirar nada el día que la consulta se rompa —un `relkind` mal
    // escrito, un `nspname` que ya no existe— y el archivo entero se vuelve un adorno verde.
    await conGrantsMutados(['create schema esquema_vacio_lab'], async (c) => {
      const b = await barrer(c, 'esquema_vacio_lab');
      expect(b.relaciones).toBe(0);
      expect(discrepancias(b)).toEqual([
        'VACUIDAD: el barrido no vio ninguna relación — no está mirando el esquema',
      ]);
    });
  });

  it('🔴 M12: deshacer el recorte de 0021 (insert de TABLA en reconocimiento_movimiento) lo pone rojo', async () => {
    // La regresión concreta que `0021` vino a cerrar: con `grant insert` de tabla vuelven a ser
    // nombrables `created_at` (antedatar el propio reconocimiento) y `superseded_por` (nacer
    // SUPERSEDED: sale de `uq_recon_vigente`, nunca aparece en la cola, y nada falla).
    await conGrantsMutados(
      [
        'revoke insert on reconocimiento_movimiento from app_request',
        'grant insert on reconocimiento_movimiento to app_request',
      ],
      async (c) => {
        const d = await discrepanciasDe(c);
        expect(d).toContain(
          'POR_COLUMNA SOBRA: reconocimiento_movimiento.created_at|INSERT|app_request',
        );
        expect(d).toContain(
          'POR_COLUMNA SOBRA: reconocimiento_movimiento.superseded_por|INSERT|app_request',
        );
        expect(d).toContain('A_NIVEL_TABLA SOBRA: reconocimiento_movimiento|app_request|INSERT');
        // 16 declaradas → 20 efectivas: las CUATRO que el recorte cierra
        // (`created_at`, `superseded_por`, `es_propuesta`, `recalculo_disponible`). Eran cinco hasta
        // que `entrada_digest` pasó a llevar grant, cuando el trigger dejó de copiarla y pasó a
        // verificar lo que la aplicación declara.
        expect(d.filter((x) => x.startsWith('POR_COLUMNA SOBRA:'))).toHaveLength(4);
      },
    );
  });

  it('🔴 M13: `grant app_request to app_job` — un privilegio HEREDADO — lo pone rojo', async () => {
    // LA MUTACIÓN QUE CIERRA EL LÍMITE DEL PROPIO BARRIDO. Una membresía no aparece en ninguna ACL,
    // así que el conjunto cerrado de grants queda VERDE mientras `app_job` —que es BYPASSRLS— pasa a
    // leer y escribir las cuatro tablas de `0021`. Es la forma más barata de que un control por ACL
    // deje de discriminar, y no la habría visto sin medir el archivo terminado.
    await conGrantsMutados(['grant app_request to app_job'], async (c) => {
      // 🔴 Los tres conjuntos de grants quedan INTACTOS. Eso es el hallazgo, no un efecto colateral.
      expect(
        await discrepanciasDe(c),
        'si esto fallara, la membresía se estaría viendo en alguna ACL y M13 no probaría nada',
      ).toEqual([]);

      // Y el privilegio efectivo SÍ cambió: es lo que `has_table_privilege` resuelve y `aclexplode`
      // no. Se mide acá para que quede escrito que los dos caminos no son intercambiables.
      const { rows } = await c.query<{ puede: boolean }>(
        `select has_table_privilege('app_job', 'padron_manifestacion', 'SELECT') as puede`,
      );
      expect(rows[0]?.puede, 'la membresía tiene que haber otorgado el privilegio de verdad').toBe(
        true,
      );

      expect(await membresias(c)).toContain('app_job → app_request');
    });
  });
});
