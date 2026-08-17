/**
 * EL DETERMINANTE DE LA ENTRADA — la mitad que `version.ts` no cubre.
 *
 * Plan `quirky-riding-music`, **P0**. Prerrequisito de la migración `0021`: sin esto, la regla de
 * idempotencia de `05-motor-de-reconocimiento.md` §5.2 sigue apoyada en un determinante que cubre el
 * CÓDIGO y no la ENTRADA.
 *
 * ## El agujero que cierra, declarado en el propio repo
 *
 * `motor_digest` (`version.ts`) es función del léxico ⊕ el catálogo alcanzable ⊕ `VERSION_DEL_MOTOR`:
 * **cero bytes de la fila del cliente**. Pero la entrada es MUTABLE — `recapturar-conceptos.ts`
 * reescribe `concepto_banco`, `concepto_completo`, `concepto_banco_estrategia` y `pagina_pdf`, y
 * `backfill-contraparte.ts` reescribe `contraparte_captura`, **y no es de una sola vez**: es el
 * mecanismo de re-hasheo cuando rote el pepper global.
 *
 * Consecuencia, textual en `packages/data/src/contabilidad/escrituras.ts:298-302`: *un reproceso que
 * cambie `concepto_banco` sin cambiar la clase da no-op con la interpretación vieja intacta*.
 * Fail-open y silencioso — el mismo modo de falla que `version.ts` describe para un contador manual.
 *
 * ## 🔴 Por exclusión, nunca por inclusión — y la exclusión se toma del TIPO DE ENTRADA DEL MOTOR
 *
 * Mismo argumento que `CLAVES_DE_EVIDENCIA` en `version.ts`: con una lista de inclusión, un campo
 * nuevo nace OLVIDADO, que es el fail-open que este archivo existe para cerrar. Por exclusión entra
 * solo, y lo peor que pasa es una invalidación de más — ruidosa y corregible.
 *
 * Y acá la exclusión tiene una propiedad que `version.ts` no podía tener: **el insumo es
 * `EvidenciaDeMovimientoLeida`, que ES el tipo de entrada del motor**. `reconocer()` no puede leer un
 * campo que no esté ahí. Así que «el digest cubre lo que el motor lee» no es una promesa: es una
 * consecuencia del tipo, y `entradaDelDigest()` recorre sus claves ordenadas.
 *
 * ## Por qué el signo del importe y no el importe
 *
 * Verificado: el motor lee `columnaOrigen` (`motor.ts:46`) y **nunca** `importe` —
 * `EvidenciaDeMovimientoLeida` ni siquiera lo expone, `lecturas.ts:324` lo colapsa a un signo antes de
 * entregarlo. Un importe corregido de `-100` a `-150` no cambia una sola clasificación, así que
 * invalidar la interpretación por eso sería entrenar a la contadora a aceptar recálculos sin mirar —
 * el peor resultado posible, el mismo que `version.ts` argumenta para `procedencia`.
 *
 * (`dba-data` propuso `importe::text` completo, con el argumento de que una remediación de importe —la
 * `0012`— *debe* invalidar la interpretación. Se descarta: la remediación de un importe cambia el
 * ASIENTO, que es capa D/E y todavía no existe, no el RECONOCIMIENTO. Si el día de mañana el importe
 * entra a la decisión, entra a `EvidenciaDeMovimientoLeida` primero, y de ahí al digest **solo**.)
 *
 * ## 🔴 `md5` y no `sha256`, contra el precedente de `version.ts`
 *
 * Divergencia deliberada, y medida por `dba-data` contra local. La expresión gemela vive en una
 * columna GENERADA de `movimiento_bancario_crudo`, que exige `IMMUTABLE`, y ahí `sha256` es una
 * trampa: exige `bytea`, y el único camino inmutable desde `text` es `::bytea`, que **reinterpreta el
 * texto como literal de bytea** — `'ZZ\xGG'::bytea` aborta en runtime con `22P02`, y
 * `'\101'::bytea = 'A'` hace que dos textos distintos hasheen igual. `convert_to(…,'UTF8')` es lo
 * correcto y NO es `IMMUTABLE`; `pgcrypto` no está instalado y es no-core (ADR-0000 §2).
 *
 * No es una primitiva de seguridad: es un DETECTOR DE CAMBIO. El escritor no elige la entrada
 * arbitrariamente, y fabricar una colisión sólo le compra negarse a sí mismo un reproceso.
 *
 * ## Encadenado con prefijo de longitud, no con un separador
 *
 * `md5(a || '|' || b)` con un operando `NULL` da **`NULL` entero** en SQL, y `text` no admite el byte
 * NUL — así que **no hay separador reservado**. El prefijo de longitud hace la codificación inyectiva:
 * `NULL` → `-:`, `''` → `0:`, y `'x|1:y'` no colisiona con el par `('x','y')`.
 *
 * ## Este archivo SÍ entra a la huella de `VERSION_DEL_MOTOR`
 *
 * Por exclusión, como todo `nucleo/` salvo `catalogo.ts` y `version.ts`. Es deliberado: cambiar la
 * fórmula del determinante de la entrada **debe** invalidar lo persistido, y hacerlo vía el trinquete
 * —que exige bump o motivo escrito y commiteado— es la dirección fail-closed. Hoy cuesta cero: hay
 * **0 reconocimientos persistidos** en local y en el piloto.
 *
 * Puro y síncrono (R-J). Sin regex ni comparación de texto libre (R-E).
 */

import { createHash } from 'node:crypto';

/**
 * La forma que este módulo hashea. Es estructuralmente `EvidenciaDeMovimientoLeida` de
 * `packages/data/src/contabilidad/lecturas.ts:266-277`, declarada acá para que `nucleo/` no dependa
 * de `data/` (R-J: el núcleo es puro y no conoce la capa de acceso a datos).
 *
 * 🔴 La coherencia entre las dos NO se confía: la vigila R-L (`packages/data/tests/reglas-de-codigo.test.ts`),
 * que compara las claves de las dos declaraciones como CONJUNTO. Si alguien agrega un campo a la
 * lectura del motor y no acá, la regla se pone roja — que es exactamente la dirección que el diseño
 * por exclusión necesita para no volverse por inclusión de contrabando.
 */
export type EntradaDelMovimiento = {
  readonly movimientoId: string;
  readonly bancoCodigo: string;
  readonly conceptoBanco: string | undefined;
  readonly conceptoCompleto: boolean | undefined;
  readonly conceptoBancoEstrategia:
    | 'segmento_de_glosa'
    | 'prefijo_anclado'
    | 'columna_propia'
    | undefined;
  readonly conceptoCodigo: string | undefined;
  readonly columnaOrigen: 'credito' | 'debito';
  readonly fecha: string;
  readonly contraparteCaptura:
    | 'no_capturado'
    | 'sin_identificador'
    | 'capturado'
    | 'capturado_cuenta_propia';
};

/**
 * Las dos claves que NO son entrada, con su motivo. Todo lo demás entra **solo**.
 *
 * 🔴 Sacar una clave de acá es barato; agregarla es CARO: cada entrada de esta lista es una promesa de
 * que ese campo no puede alterar el reconocimiento **o** de que ya está cubierto por otro
 * determinante. Antes de sumar una, verificar contra `motor.ts` y `matcher.ts`.
 *
 * - `movimientoId`: es la IDENTIDAD de la fila, no su contenido. Incluirlo haría que el digest de dos
 *   movimientos idénticos difiriera, y el determinante dejaría de detectar lo único que tiene que
 *   detectar — que la entrada de ESTE movimiento cambió. La identidad ya está en la unicidad
 *   `(cliente_id, movimiento_id, …)`.
 * - `bancoCodigo`: **ya está cubierto transitivamente por `motor_digest`, que es POR BANCO**
 *   (`version.ts`, "Por qué POR BANCO y no uno global"). Y hay una segunda razón, que es la que lo
 *   vuelve no negociable: `banco_codigo` vive en `lote_ingesta`, **otra tabla**, y una columna
 *   generada de Postgres sólo puede referenciar columnas de la MISMA fila. Incluirlo acá haría
 *   divergir esta función de su gemela en el DDL — que es justo lo que la predicción de P1 mide.
 */
const CLAVES_QUE_NO_SON_ENTRADA: ReadonlySet<string> = new Set(['movimientoId', 'bancoCodigo']);

/**
 * Un campo, con prefijo de longitud. Inyectivo: ver la cabecera.
 *
 * `undefined` y `null` colapsan al mismo `-:` a propósito — en la base los dos son `NULL`, y el
 * determinante tiene que dar lo mismo de los dos lados o P1 falla por una diferencia que no es real.
 */
function enmarcar(valor: unknown): string {
  if (valor === null || valor === undefined) return '-:';
  const texto = String(valor);
  // 🔴 PUNTOS DE CÓDIGO, no unidades UTF-16. `texto.length` en JavaScript cuenta unidades UTF-16 y
  // `length(text)` en Postgres cuenta CARACTERES: para todo lo que esté fuera del plano básico los dos
  // difieren (un emoji da 2 en JS y 1 en PG), y esta función tiene una gemela en una columna generada
  // del DDL que TIENE que dar el mismo valor. Con `.length` pelado, P1 reportaría una divergencia
  // TS↔SQL recién contra la base, y sobre un puñado de filas — el peor lugar para encontrarla.
  return String([...texto].length) + ':' + texto;
}

/**
 * La proyección de la entrada, en texto. Se expone —además del digest— por el mismo motivo que
 * `proyeccionDeBanco()`: un digest que cambió no dice QUÉ cambió, y comparar dos proyecciones es la
 * única forma de verlo al depurar. Sin esto, la primera investigación duele.
 *
 * ⚠️ Contiene material N2 (`conceptoBanco` es N2 — en un banco del roster el 73 % del archivo trae el
 * nombre de la contraparte). **Nunca se loguea, nunca se exporta, nunca sale de un proceso.** Es una
 * herramienta de diagnóstico local, y por eso devuelve texto en vez de escribirlo en ningún lado.
 */
export function proyeccionDeEntrada(entrada: EntradaDelMovimiento): string {
  const claves = Object.keys(entrada).sort();
  const partes: string[] = [];
  for (const clave of claves) {
    if (CLAVES_QUE_NO_SON_ENTRADA.has(clave)) continue;
    partes.push(enmarcar((entrada as Record<string, unknown>)[clave]));
  }
  return partes.join('|');
}

/**
 * El determinante de la entrada que se persiste en `movimiento_bancario_crudo.entrada_digest`
 * (migración `0021`) y del que `reconocimiento_movimiento` toma una foto histórica.
 *
 * 16 hex, misma longitud que `motor_digest` y que el hash de una migración aplicada — el precedente
 * del repo para "identidad de un artefacto". Distinto algoritmo, por el motivo de la cabecera.
 */
export function digestDeEntrada(entrada: EntradaDelMovimiento): string {
  return createHash('md5').update(proyeccionDeEntrada(entrada), 'utf8').digest('hex').slice(0, 16);
}
