/**
 * COSTEO PEPS DE UN RESCATE DE FCI — el núcleo puro de este paquete.
 *
 * Código puro, síncrono, sin SQL ni importe de `data`/`ingesta`/`almacenamiento` (mismo patrón que
 * `packages/contabilidad/src/nucleo`, ver R-B/R-G/R-J en `packages/data/tests/reglas-de-codigo.test.ts`).
 */

import { CERO, comparar, esCero, minimo, multiplicar, restar, type PuntoFijo } from './aritmetica.ts';
import type { CapaFCI, ItemConsumo, ResultadoConsumo } from './tipos.ts';

export const CODIGO_CONSUMO_INVALIDO = 'FCI_CONSUMO_INVALIDO' as const;

/**
 * Unión cerrada de las razones por las que `consumirRescate` rechaza su entrada. Es un identificador
 * de código, no un dato del cliente: no lleva ningún valor recibido, solo cuál guard disparó.
 */
const MOTIVOS_CONSUMO_INVALIDO = [
  'orden_no_peps',
  'cantidad_a_rescatar_negativa',
  'precio_rescate_negativo',
  'capa_cantidad_remanente_negativa',
  'capa_cantidad_original_negativa',
  'capa_precio_unitario_origen_negativo',
] as const;
type MotivoConsumoInvalido = (typeof MOTIVOS_CONSUMO_INVALIDO)[number];

/**
 * 🔴 El mensaje NUNCA lleva el valor recibido (mismo criterio que `DecimalInvalidoError` en
 * `aritmetica.ts`): solo el `motivo`, que es un identificador cerrado del propio código, nunca un dato
 * de la capa o del rescate. El `codigo` alcanza para depurar; el `motivo` acota a qué guard fue.
 */
export class ConsumoInvalidoError extends Error {
  readonly codigo = CODIGO_CONSUMO_INVALIDO;
  readonly motivo: MotivoConsumoInvalido;

  constructor(motivo: MotivoConsumoInvalido) {
    super(`Entrada inválida para consumirRescate (motivo: ${motivo}).`);
    this.name = 'ConsumoInvalidoError';
    this.motivo = motivo;
  }
}

/**
 * Recorre `capasOrdenadas` de la más vieja a la más nueva (PEPS) — el orden lo decide quien llama,
 * esta función no ordena ni reordena nada — consumiendo cada capa hasta agotarla o hasta agotar
 * `cantidadARescatar`, lo que pase primero.
 *
 * Una capa ya agotada (`cantidadRemanente` en cero) no aporta ningún `ItemConsumo`: incluirla con
 * cantidad consumida cero mezclaría "no tenía nada para dar" con "se tocó y no se le tomó nada", que
 * son dos hechos distintos para quien revise el resultado.
 *
 * Si `cantidadARescatar` excede la suma de remanentes de todas las capas: NO se inventa una capa
 * faltante ni se completa con precio 0 (regla dura del dominio, ya validada por `contador-dominio`).
 * Se consume lo que efectivamente hay y `cantidadSinCubrir` del resultado queda en lo que faltó —
 * SIEMPRE presente en el resultado, en `CERO` cuando el stock alcanzó, nunca ausente en silencio.
 *
 * Antes de consumir nada, valida sus entradas: un motor fiscal no puede producir en silencio un costo
 * PEPS invertido (capas fuera de orden) ni una cobertura fantasma (cantidades o precios negativos que
 * inflarían `cantidadSinCubrir` por debajo de lo real). Cualquiera de esas condiciones es un dato de
 * entrada roto, no un caso de negocio — se rechaza con `ConsumoInvalidoError` en vez de seguir.
 */
export function consumirRescate(
  capasOrdenadas: readonly CapaFCI[],
  cantidadARescatar: PuntoFijo,
  precioRescate: PuntoFijo,
): ResultadoConsumo {
  if (comparar(cantidadARescatar, CERO) < 0) {
    throw new ConsumoInvalidoError('cantidad_a_rescatar_negativa');
  }
  if (comparar(precioRescate, CERO) < 0) {
    throw new ConsumoInvalidoError('precio_rescate_negativo');
  }

  for (const capa of capasOrdenadas) {
    if (comparar(capa.cantidadRemanente, CERO) < 0) {
      throw new ConsumoInvalidoError('capa_cantidad_remanente_negativa');
    }
    if (comparar(capa.cantidadOriginal, CERO) < 0) {
      throw new ConsumoInvalidoError('capa_cantidad_original_negativa');
    }
    if (comparar(capa.precioUnitarioOrigen, CERO) < 0) {
      throw new ConsumoInvalidoError('capa_precio_unitario_origen_negativo');
    }
  }

  // PEPS exige más vieja a más nueva por `fecha` (ISO YYYY-MM-DD, comparable lexicográficamente). Se
  // valida el orden real en vez de confiar en el comentario de arriba: con capas invertidas, el cálculo
  // seguía adelante y daba un costo PEPS invertido sin ningún error.
  for (let i = 1; i < capasOrdenadas.length; i += 1) {
    const anterior = capasOrdenadas[i - 1]!;
    const actual = capasOrdenadas[i]!;
    if (actual.fecha < anterior.fecha) {
      throw new ConsumoInvalidoError('orden_no_peps');
    }
  }

  const items: ItemConsumo[] = [];
  let restante = cantidadARescatar;

  for (const capa of capasOrdenadas) {
    if (esCero(restante)) break; // ya se cubrió toda la cantidad pedida; las capas siguientes no se tocan
    if (esCero(capa.cantidadRemanente)) continue; // capa ya agotada por un rescate anterior: no aporta nada acá

    const cantidadConsumida = minimo(capa.cantidadRemanente, restante);
    const diferenciaDePrecio = restar(precioRescate, capa.precioUnitarioOrigen);

    items.push({
      capa,
      cantidadConsumida,
      resultado: multiplicar(cantidadConsumida, diferenciaDePrecio),
      // El precio de origen desconocido no se completa con un promedio ni con el precio de cierre
      // (contrato de esta tarea, ver tipos.ts): se propaga la marca al ítem para que quien revise el
      // resultado sepa que ESTE número puntual es una estimación, no un costo real.
      costoEstimado: !capa.costoConocido,
    });

    restante = restar(restante, cantidadConsumida);
  }

  return {
    items,
    cantidadCubierta: restar(cantidadARescatar, restante),
    cantidadSinCubrir: restante,
    parcialmenteEstimado: items.some((item) => item.costoEstimado),
  };
}
