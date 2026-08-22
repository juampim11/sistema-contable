/**
 * TIPOS DEL NÚCLEO DE COSTEO PEPS DE FCI.
 *
 * Contrato de negocio ya decidido (no se rediseña acá): una capa de costo se consume de la más vieja
 * a la más nueva, y un rescate puede tocar más de una capa. El resultado nunca se agrega — cada capa
 * tocada aporta su propio `ItemConsumo`, con su propio resultado y su propio estado de estimación.
 */

import type { PuntoFijo } from './aritmetica.ts';

/**
 * Una capa de costo puede nacer de la apertura del ejercicio (el saldo con el que arrancó el cliente)
 * o de una suscripción posterior. La distinción importa porque una capa de `apertura` para un cliente
 * que entra a mitad de ejercicio puede no traer el precio real — de ahí `costoConocido`.
 */
export const ORIGENES_CAPA = ['apertura', 'suscripcion'] as const;
export type OrigenCapa = (typeof ORIGENES_CAPA)[number];

/**
 * Los dos roles funcionales que puede necesitar declarar quien consume el resultado de un rescate,
 * para saber a qué cuenta se refiere sin que esta función resuelva ninguna cuenta contable — eso es
 * criterio de `contador-dominio`, no de este núcleo.
 *
 * 🔴 Unión cerrada de SOLO estos dos valores. Los roles de valuación al cierre están bloqueados en el
 * plan y no se agregan acá "por si": una unión abierta a futuro es exactamente el tipo de decisión que
 * no le toca a esta tarea.
 */
export const ROLES_FCI = ['inversiones_fci', 'resultado_rescate_fci'] as const;
export type RolFCI = (typeof ROLES_FCI)[number];

/**
 * Una capa de costo de un fondo común de inversión, tal como la ve `consumirRescate`. La cantidad
 * ORIGINAL no la usa el consumo en sí (PEPS solo mira el remanente), pero viaja en el tipo porque
 * `ItemConsumo` referencia la capa completa — sin ella, quien recibe el resultado no podría reconstruir
 * cuánto quedó consumido de esa capa en total a lo largo de sucesivos rescates.
 */
export type CapaFCI = {
  /** Identidad estable de la capa, opaca para este núcleo: la asigna quien la construye (Capa D, otra
   *  tarea, la va a usar para glosar el asiento y distinguir "esta capa puntual" de otra del mismo
   *  `origen`). Este código no la genera ni le da forma — solo exige que no esté vacía. */
  readonly id: string;
  /** Fecha de origen de la capa (apertura o suscripción), ISO `YYYY-MM-DD`. Cumple dos roles: identidad
   *  temporal para la futura glosa del asiento, y la clave de orden que `consumirRescate` valida en
   *  runtime — PEPS exige que `capasOrdenadas` venga de más vieja a más nueva por este campo. */
  readonly fecha: string;
  readonly cantidadOriginal: PuntoFijo;
  readonly cantidadRemanente: PuntoFijo;
  readonly precioUnitarioOrigen: PuntoFijo;
  readonly origen: OrigenCapa;
  /** `false` cuando el precio de origen de la capa no se conoce (apertura de ejercicio sin ese dato).
   *  Nunca se completa con un promedio ni con el precio de cierre — eso lo decidió `contador-dominio`
   *  y es una regla dura del dominio, no una opción de implementación. */
  readonly costoConocido: boolean;
};

/**
 * Lo que produjo el consumo de UNA capa dentro de un rescate. Nunca se agrega con el de otra capa: el
 * resultado impositivo de un rescate puede mezclar tramos con costo conocido y estimado, y agregarlos
 * de entrada le esconde esa mezcla a quien tiene que revisarlo.
 */
export type ItemConsumo = {
  readonly capa: CapaFCI;
  readonly cantidadConsumida: PuntoFijo;
  /** `(precioRescate - capa.precioUnitarioOrigen) * cantidadConsumida`, en la escala de `aritmetica.ts`. */
  readonly resultado: PuntoFijo;
  /** Espejo de `!capa.costoConocido` — se repite acá para que quien lea solo los ítems (sin volver a
   *  mirar cada `capa`) sepa cuáles resultados son estimados. */
  readonly costoEstimado: boolean;
};

/**
 * El resultado completo de `consumirRescate`. `cantidadSinCubrir` está SIEMPRE presente —en `CERO`
 * cuando el stock alcanzó— porque la ausencia de cobertura se representa, nunca se rellena en
 * silencio con una capa inventada o un precio 0.
 */
export type ResultadoConsumo = {
  readonly items: readonly ItemConsumo[];
  readonly cantidadCubierta: PuntoFijo;
  readonly cantidadSinCubrir: PuntoFijo;
  /** `true` si CUALQUIER ítem tiene `costoEstimado: true`. */
  readonly parcialmenteEstimado: boolean;
};
