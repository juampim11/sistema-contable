/**
 * SIMULACIÓN DE UN FONDO A TRAVÉS DE VARIOS CORTES.
 *
 * Encadena `consumirRescate` (`@sistema-contable/fci`) corte a corte para UN fondo: arma capas de
 * costo PEPS (apertura + suscripciones) y las va consumiendo con cada rescate, en el mismo orden en
 * que aparecen en el documento. Código puro, síncrono, sin I/O — nunca toca un PDF ni la base; todo lo
 * que necesita entra ya resuelto (mismo patrón que `verificar-posicion.ts` en este directorio).
 */

import {
  aPuntoFijo,
  CERO,
  consumirRescate,
  esCero,
  restar,
  sumar,
  type CapaFCI,
  type PuntoFijo,
  type ResultadoConsumo,
} from '@sistema-contable/fci';
import type { MovimientoFci } from './extraer-posiciones.ts';

export type CorteDeFondo = {
  readonly corte: string;
  /** ISO, primer día del período de este corte — usado SOLO para fechar la capa de apertura cuando
   *  este es el primer corte de la serie. */
  readonly periodoDesde: string;
  /** Decimal canónico — solo se usa del PRIMER corte de la serie, para calcular la apertura. */
  readonly tenenciaDeclarada: string;
  /** En orden de documento (ya validado monótono por fecha, aguas arriba en `extraer-posiciones.ts`). */
  readonly movimientos: readonly MovimientoFci[];
};

export type ConsumoDeCorte = {
  readonly corte: string;
  readonly fecha: string;
  readonly cantidad: string;
  readonly precio: string;
  readonly resultado: ResultadoConsumo;
};

export type SnapshotDeCorte = {
  readonly corte: string;
  /** Capas con remanente > 0 al cierre de este corte (para calcular "valor histórico" del resumen). */
  readonly capasAbiertas: readonly CapaFCI[];
};

export type SimulacionFondo = {
  /** Uno por rescate, en orden cronológico. */
  readonly consumos: readonly ConsumoDeCorte[];
  /** Uno por corte, tomado DESPUÉS de procesar sus movimientos. */
  readonly snapshots: readonly SnapshotDeCorte[];
};

function sumaPorTipo(movimientos: readonly MovimientoFci[], tipo: MovimientoFci['tipo']): PuntoFijo {
  return movimientos
    .filter((m) => m.tipo === tipo)
    .reduce((acumulado, m) => sumar(acumulado, aPuntoFijo(m.cantidad)), CERO);
}

/**
 * Capa de apertura del primer corte de la serie: si `tenenciaFinal = apertura + Σsusc − Σresc`,
 * despejando, `apertura = tenenciaFinal − Σsusc + Σresc` — con los propios movimientos del primer
 * corte. Se crea SIEMPRE, aunque dé cero o negativo: un dato de apertura inconsistente no es trabajo
 * de esta función (no es quien conoce la regla de negocio sobre qué hacer con una entrada rota) —
 * `consumirRescate` ya rechaza explícitamente una capa con `cantidadOriginal` negativa si llega a
 * tocarse (`ConsumoInvalidoError('capa_cantidad_original_negativa')`).
 */
function capaDeApertura(primerCorte: CorteDeFondo): CapaFCI {
  const suscripto = sumaPorTipo(primerCorte.movimientos, 'suscripcion');
  const rescatado = sumaPorTipo(primerCorte.movimientos, 'rescate');
  const cantidad = sumar(restar(aPuntoFijo(primerCorte.tenenciaDeclarada), suscripto), rescatado);
  return {
    id: 'apertura',
    fecha: primerCorte.periodoDesde,
    cantidadOriginal: cantidad,
    cantidadRemanente: cantidad,
    precioUnitarioOrigen: CERO,
    origen: 'apertura',
    costoConocido: false,
  };
}

export function simularFondo(cortesOrdenados: readonly CorteDeFondo[]): SimulacionFondo {
  if (cortesOrdenados.length === 0) return { consumos: [], snapshots: [] };

  const consumos: ConsumoDeCorte[] = [];
  const snapshots: SnapshotDeCorte[] = [];

  // Mutable a propósito, pero cada capa que cambia se REEMPLAZA (nunca se muta): `CapaFCI` es
  // `readonly` y otros ítems (`ResultadoConsumo.items[].capa`) pueden seguir referenciando el objeto
  // anterior.
  let capasVigentes: CapaFCI[] = [capaDeApertura(cortesOrdenados[0]!)];
  let contadorSuscripcion = 0;

  for (const corte of cortesOrdenados) {
    for (const movimiento of corte.movimientos) {
      if (movimiento.tipo === 'suscripcion') {
        contadorSuscripcion += 1;
        const cantidad = aPuntoFijo(movimiento.cantidad);
        // Ya viene en orden cronológico: agregar al final mantiene `capasVigentes` ordenado por
        // `fecha` sin ordenar a mano (ver el porqué en el comentario de más abajo).
        capasVigentes = [
          ...capasVigentes,
          {
            id: `susc_${contadorSuscripcion}`,
            fecha: movimiento.fecha,
            cantidadOriginal: cantidad,
            cantidadRemanente: cantidad,
            precioUnitarioOrigen: aPuntoFijo(movimiento.precio),
            origen: 'suscripcion',
            costoConocido: true,
          },
        ];
        continue;
      }

      // Nunca se ordena `capasVigentes` a mano: si el orden se rompió aguas arriba, es
      // `consumirRescate` quien lo rechaza con `ConsumoInvalidoError('orden_no_peps')` — enmascararlo
      // con un `.sort()` acá escondería el problema real.
      const resultado = consumirRescate(
        capasVigentes,
        aPuntoFijo(movimiento.cantidad),
        aPuntoFijo(movimiento.precio),
      );

      const consumidaPorId = new Map(
        resultado.items.map((item) => [item.capa.id, item.cantidadConsumida] as const),
      );
      capasVigentes = capasVigentes.map((capa) => {
        const consumida = consumidaPorId.get(capa.id);
        return consumida === undefined
          ? capa
          : { ...capa, cantidadRemanente: restar(capa.cantidadRemanente, consumida) };
      });

      consumos.push({
        corte: corte.corte,
        fecha: movimiento.fecha,
        cantidad: movimiento.cantidad,
        precio: movimiento.precio,
        resultado,
      });
    }

    snapshots.push({
      corte: corte.corte,
      capasAbiertas: capasVigentes.filter((capa) => !esCero(capa.cantidadRemanente)),
    });
  }

  return { consumos, snapshots };
}
