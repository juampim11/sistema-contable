/**
 * EL DETERMINANTE DEL RECONOCIMIENTO — proyección semántica del motor, y su digest.
 *
 * Plan `replicated-zooming-pine`, P0. Prerrequisito de la migración `0014`: sin esto, la regla de
 * idempotencia de `05-motor-de-reconocimiento.md` §5.2 ("reprocesar con la misma versión es no-op")
 * no tiene sobre qué apoyarse.
 *
 * ## Por qué un digest calculado y no un contador que alguien bumpea
 *
 * Un contador manual falla ABIERTO y EN SILENCIO: si nadie lo bumpea, reprocesar es no-op y el
 * reconocimiento viejo —ahora incorrecto— queda protegido ACTIVAMENTE por la propia regla de
 * idempotencia. Y `catalogo.ts` es el archivo de más tráfico del módulo (P4, P7 y P8 le apendaron
 * filas), o sea el que más olvidos acumula. Un digest calculado en runtime no se puede olvidar.
 *
 * ## Por qué POR BANCO y no uno global
 *
 * Un digest global del catálogo invalidaría todos los reconocimientos de Galicia el día que entre un
 * banco nuevo con 20 conceptos que ningún léxico de Galicia alcanza — por un cambio demostrablemente
 * incapaz de alterarlos. El alcance real del determinante es el banco: el POSITIVO depende de la
 * entrada que disparó más el resto del léxico que pudo volverla ambigua (`matcher.ts`,
 * `entradasDistintas.size > 1`), y el NEGATIVO depende de todo el espacio de búsqueda del banco más
 * las filas del catálogo alcanzables desde él — porque `motor.ts:52` pasa `ladoEsperadoDe` AL
 * MATCHER, donde es la guarda que decide `no_encontrado`. El catálogo determina también los
 * negativos, no solo los positivos.
 *
 * ## 🔴 La proyección se construye POR EXCLUSIÓN, nunca por inclusión
 *
 * Se hashea TODO lo que se camina, salvo las claves de `CLAVES_DE_EVIDENCIA` — que son evidencia y no
 * decisión. La dirección importa: con una lista de inclusión, un campo nuevo en `FilaDelCatalogo`
 * nace OLVIDADO (el mismo fail-open que este archivo existe para cerrar); por exclusión, entra al
 * digest solo y lo peor que pasa es una invalidación de más, que es ruidosa y se corrige.
 *
 * Puro y síncrono (R-J). Sin regex ni comparación de texto libre (R-E): las claves se buscan con
 * `Set.has`, nunca con un barrido sobre el nombre.
 */

import { createHash } from 'node:crypto';
import { CATALOGO_CANONICO } from './catalogo.ts';
import type { ConceptoCanonico } from './catalogo.ts';
import type { LexicoDeBanco } from './lexico.ts';

/**
 * Versión del CÓDIGO del motor — lo único que no se puede derivar de los datos.
 *
 * Cubre TODO `nucleo/` salvo `catalogo.ts` (son DATOS, ya cubiertos por `digestDeBanco` POR BANCO) y
 * este mismo archivo (es el que mide). 🔴 POR EXCLUSIÓN, no por inclusión — el mismo argumento que
 * `CLAVES_DE_EVIDENCIA`, unos renglones más abajo: con una lista de nombres, un archivo nuevo de
 * `nucleo/` nace OLVIDADO. La lista de cuatro que decía este docblock ya se quedaba corta contra
 * `contrapartida.ts`, cuya regla de uniformidad de pepper YA cambió una vez y decide la `clase` y el
 * `tipo` de la fila que `0014` persiste.
 *
 * Es un contador manual, y su olvido es el modo de falla conocido — por eso no se deja librado a la
 * disciplina: `tests/version-del-motor.test.ts` compara la huella real contra el artefacto
 * commiteado (`version-del-motor.json`) y un cambio sin aceptar se pone ROJO. La aceptación es un
 * TRINQUETE: exige bump, o una declaración escrita de por qué ese cambio no puede alterar ningún
 * resultado (`pnpm motor:version:aceptar --sin-bump --motivo "…"`), que queda commiteada y la lee una
 * persona en el diff. Ver `scripts/version-del-motor.ts`.
 */
export const VERSION_DEL_MOTOR = 1;

/**
 * Las claves que son EVIDENCIA, no decisión. Cambiarlas no puede alterar lo que `reconocer()`
 * devuelve, así que no invalidan ningún reconocimiento persistido.
 *
 * 🔴 Sacar una clave de acá es barato y agregarla es CARO: cada entrada de esta lista es una promesa
 * de que ese campo no influye en el resultado. Antes de sumar una, verificar que `motor.ts` y
 * `matcher.ts` no la lean.
 *
 * - `procedencia`: de dónde salió la entrada (documento, sección, frecuencias medidas). Re-medir un
 *   corpus —`movimientos: 19` → `21`— no cambia ni un reconocimiento, y si entrara al digest
 *   invalidaría todo el histórico de todos los clientes, entrenando a la contadora a aceptar
 *   recálculos sin mirar. Ese es el peor resultado posible: destruye el 🔴 de §5.2.
 * - `motivoDelHueco` y `referencia`: prosa que explica un `sin_tipo_asignado` a una persona.
 * - `categoriaDelHueco`: discriminante estructural del POR QUÉ del hueco, pero `motor.ts` no lo lee —
 *   `resuelve: 'sin_tipo_asignado'` ya determina la salida por sí solo.
 */
const CLAVES_DE_EVIDENCIA: ReadonlySet<string> = new Set([
  'procedencia',
  'motivoDelHueco',
  'referencia',
  'categoriaDelHueco',
]);

/**
 * Claves que entran al digest como PRESENCIA (`true`/ausente), nunca por contenido.
 *
 * `pendienteDeLaura` es `{pregunta, hipotesis, referencia, desde}` y vive en el léxico y el catálogo,
 * que son CÓDIGO (N0). Lo que altera el resultado es que ESTÉ —degrada la clase a `decision_humana`,
 * `lexico.ts:46`—, no cómo esté redactada la pregunta. Reformular una hipótesis no debe invalidar
 * nada; agregarla o sacarla sí.
 */
const CLAVES_SOLO_PRESENCIA: ReadonlySet<string> = new Set(['pendienteDeLaura']);

/**
 * Serialización CANÓNICA: claves ordenadas alfabéticamente, para que el digest no dependa del orden
 * en que alguien escribió los campos del literal. Sin esto, mover una línea de `catalogo.ts` sin
 * cambiar nada movería el digest.
 *
 * El ORDEN DE LOS ARRAYS sí se preserva, y es a propósito: en `literales`, el orden decide cuál gana
 * cuando dos normalizan igual (`indice.ts`, último asignado gana), así que es semántico.
 */
function canonizar(valor: unknown): string {
  if (valor === null || valor === undefined) return 'n';
  if (typeof valor === 'string') return JSON.stringify(valor);
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);

  if (Array.isArray(valor)) {
    const partes: string[] = [];
    for (const item of valor) partes.push(canonizar(item));
    return '[' + partes.join(',') + ']';
  }

  if (typeof valor === 'object') {
    const objeto = valor as Record<string, unknown>;
    const claves = Object.keys(objeto).sort();
    const partes: string[] = [];
    for (const clave of claves) {
      if (CLAVES_DE_EVIDENCIA.has(clave)) continue;
      if (objeto[clave] === undefined) continue;
      if (CLAVES_SOLO_PRESENCIA.has(clave)) {
        partes.push(JSON.stringify(clave) + ':true');
        continue;
      }
      partes.push(JSON.stringify(clave) + ':' + canonizar(objeto[clave]));
    }
    return '{' + partes.join(',') + '}';
  }

  return 'n';
}

/**
 * Los conceptos que ESE léxico puede alcanzar. Es lo que acota el digest al banco: las filas del
 * catálogo de otros bancos no entran, y por eso un banco nuevo no invalida a los existentes.
 *
 * Se ordenan para que el digest no dependa del orden de declaración de las entradas.
 */
function conceptosAlcanzados(lexico: LexicoDeBanco): readonly ConceptoCanonico[] {
  const vistos = new Set<ConceptoCanonico>();
  for (const entrada of lexico.entradas) vistos.add(entrada.concepto);
  return [...vistos].sort();
}

/**
 * La proyección semántica de un banco, en texto. Se expone —además del digest— porque un digest que
 * cambió no dice QUÉ cambió: al depurar, comparar dos proyecciones es la única forma de verlo.
 */
export function proyeccionDeBanco(lexico: LexicoDeBanco): string {
  const filas: string[] = [];
  for (const concepto of conceptosAlcanzados(lexico)) {
    filas.push(JSON.stringify(concepto) + ':' + canonizar(CATALOGO_CANONICO[concepto]));
  }

  return canonizar({
    banco: lexico.banco,
    estrategiaDelAdaptador: lexico.estrategiaDelAdaptador,
    elAdaptadorPuedeTruncar: lexico.elAdaptadorPuedeTruncar,
    entradas: lexico.entradas,
    versionDelMotor: VERSION_DEL_MOTOR,
  }) + '|catalogo{' + filas.join(',') + '}';
}

/**
 * El determinante que se persiste en `reconocimiento_movimiento.motor_digest` (migración `0014`).
 *
 * 16 hex, misma longitud y mismo algoritmo que el hash de una migración aplicada
 * (`packages/data/scripts/migrar.ts`) — no por estética: es el precedente del repo para "identidad de
 * un artefacto de código", y usar dos formas distintas para la misma idea invita a confundirlas.
 */
export function digestDeBanco(lexico: LexicoDeBanco): string {
  return createHash('sha256').update(proyeccionDeBanco(lexico), 'utf8').digest('hex').slice(0, 16);
}
