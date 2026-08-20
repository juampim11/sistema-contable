/**
 * VERIFICACIÓN DE LIQUIDACIONES — commit 2 de 4 del plan 14.
 *
 * Dos funciones, dos ejes de los tres que declara `esquema.ts` (`EJES_DE_VERIFICACION`):
 *
 *  - `verificarAritmeticaPorLiquidacion`: eje 1, `aritmetica_por_liquidacion`. Completa en este commit.
 *  - `verificarChecksumDelEmisorMinimo`: eje 2, `checksum_del_emisor`. **Parcial**, ver su propio
 *    comentario — no es el diseño final.
 *
 * El eje 3 (`cruce_contra_extracto`) no vive acá: cruza contra el extracto bancario, que es otro
 * documento y otro commit (plan 14 §5, paso 4 en adelante).
 *
 * ## Mismo idiom aritmético que `verificacion/invariantes.ts`, sin compartir sus tipos
 *
 * Centavos en `bigint` vía `importeCanonicoACentavos`/`centavosAImporte` de `../parseo-ar.ts`: nunca
 * floats, nunca se recalcula una suma contra sí misma — se compara contra lo que **declara el
 * documento** (`netoAcreditado`, `totalConsolidadoDeclarado`), igual que allá se compara contra la
 * línea de totales del banco. Lo que NO se comparte: `CuentaConMovimientos`, `Verificacion` y el resto
 * del vocabulario de `../esquema.ts` (el de los extractos bancarios) son ajenos a esto — R-M lo prohíbe
 * y además no aplica: acá no hay cuenta ni movimiento, hay una liquidación.
 *
 * ## Un adaptador no se autocertifica (contrato.ts, regla 1) — y esta función es la que sí certifica
 *
 * `verificarAritmeticaPorLiquidacion` es pura y no conoce al adapter que produjo la `LiquidacionLeida`:
 * toma lo que el adapter leyó y lo compara contra lo que el documento declara. Un adapter que calculara
 * su propio "cuadra" estaría afirmando que leyó bien con la misma lógica con la que leyó.
 */

import { centavosAImporte, importeCanonicoACentavos } from '../parseo-ar.ts';
import { CATALOGO_DE_CONCEPTOS, type LiquidacionLeida, type ResultadoDeEje } from './esquema.ts';

/**
 * Eje 1 — ventas brutas menos lo que resta, más lo que suma, tiene que dar el neto acreditado, al
 * centavo.
 *
 * ## Por qué no itera sumando y restando "a ojo" por concepto
 *
 * El signo de cada concepto **no lo decide esta función**: lo decide `CATALOGO_DE_CONCEPTOS[concepto]
 * .efectoSobreElNeto`, que es la fuente de verdad única (esquema.ts ya lo advierte: "no dupliques esa
 * tabla a mano acá"). Si mañana se agrega un concepto nuevo con efecto `suma`, esta función no cambia:
 * solo lee el catálogo.
 *
 * ## `no_determinado` no participa con signo fijo — y si aparece con monto, el eje no se puede correr
 *
 * `percepcion_iva_rg2408` es el caso medido (esquema.ts §"Los conceptos con `efectoSobreElNeto:
 * 'no_determinado'`"): el corpus tiene dos tasas en el mismo bloque sin fórmula derivable contra
 * ninguna base probada. Sumarlo o restarlo con un signo supuesto haría que la verificación "cuadre" o
 * "no cuadre" por una decisión que nadie tomó — el mismo error de fondo que el proyecto ya evita en
 * otros lugares (la ausencia se representa, no se rellena). Por eso, apenas aparece un renglón con
 * `efectoSobreElNeto: 'no_determinado'` y monto ≠ 0, el eje entero se declara `no_verificable` con el
 * motivo `concepto_con_efecto_no_determinado` — no se sigue sumando el resto para ver si "casi cuadra".
 *
 * Un renglón `no_determinado` con monto **cero** no dispara esto: cero no tiene signo que importe, y
 * exigir `no_verificable` por un renglón en cero sería negar la verificación de liquidaciones donde el
 * formato declara el concepto pero el período no lo tuvo.
 */
export function verificarAritmeticaPorLiquidacion(liquidacion: LiquidacionLeida): ResultadoDeEje {
  const eje = 'aritmetica_por_liquidacion' as const;

  // `null` no debería pasar nunca acá: el esquema ya validó la forma de cada importe (regex de
  // `importeNoNegativo`). Se trata como 0 en vez de arrojar: un adapter no puede tirar abajo la
  // verificación de las demás liquidaciones del lote por un dato que el propio schema ya blindó.
  const ventas = importeCanonicoACentavos(liquidacion.ventasBrutas) ?? 0n;
  const neto = importeCanonicoACentavos(liquidacion.netoAcreditado) ?? 0n;

  let acumulado = ventas;

  for (const renglon of liquidacion.renglones) {
    const definicion = CATALOGO_DE_CONCEPTOS[renglon.concepto];
    const monto = importeCanonicoACentavos(renglon.monto) ?? 0n;

    if (definicion.efectoSobreElNeto === 'no_determinado') {
      if (monto !== 0n) {
        return { eje, estado: 'no_verificable', motivo: 'concepto_con_efecto_no_determinado' };
      }
      continue;
    }

    acumulado = definicion.efectoSobreElNeto === 'resta' ? acumulado - monto : acumulado + monto;
  }

  return { eje, estado: acumulado === neto ? 'cuadra' : 'no_cuadra' };
}

/**
 * Eje 2 — Σ liquidaciones == total consolidado publicado por el emisor.
 *
 * 🔴 **PARCIAL / MÍNIMA, no el diseño final del eje 2.** Esta implementación existe únicamente para la
 * medición #2 que pide el plan 14 §5 (paso 2: "acá se miden los números concretos que el DDL del paso 3
 * necesita") contra Visa débito, que sí publica total consolidado (`traeTotalDelEmisor: true`). El
 * diseño completo del eje 2 —incluido cómo se agrupan las liquidaciones cuando hay más de un período o
 * más de una tarjeta en el mismo lote, y cómo se reporta una diferencia localizada en vez de un
 * booleano global— se define recién con el adapter de Cabal, que **no** tiene total declarado
 * (`traeTotalDelEmisor: false`) y va a forzar el caso general con `no_verificable,
 * emisor_no_publica_total`. Cualquiera que toque este archivo después de ese commit tiene que revisar
 * esta función, no asumir que quedó cerrada acá.
 *
 * `totalConsolidadoDeclarado` llega ya en su forma `publicado(...)` (esquema.ts): `no_publicado` es
 * "no hay eje 2 que correr" para ESTE lote, y se distingue de `emisor_no_publica_total` —que es una
 * propiedad del FORMATO, declarada en `capacidades.traeTotalDelEmisor`— porque un formato que sí
 * publica total puede tener, en un lote puntual, un documento donde ese total no se pudo leer. Esta
 * función no conoce `capacidades`: quien la llama decide qué motivo corresponde cuando no hay total.
 */
export function verificarChecksumDelEmisorMinimo(
  liquidaciones: readonly LiquidacionLeida[],
  totalConsolidadoDeclarado: string,
): ResultadoDeEje {
  const eje = 'checksum_del_emisor' as const;

  const declarado = importeCanonicoACentavos(totalConsolidadoDeclarado);
  let suma = 0n;
  for (const liquidacion of liquidaciones) {
    // `null` no debería pasar: mismo argumento que en `verificarAritmeticaPorLiquidacion`, el esquema
    // ya validó la forma.
    suma += importeCanonicoACentavos(liquidacion.netoAcreditado) ?? 0n;
  }

  return { eje, estado: declarado !== null && declarado === suma ? 'cuadra' : 'no_cuadra' };
}

/** Expuesta solo para que un consumidor pueda mostrar la suma calculada sin recalcularla. */
export function sumaDeNetosAcreditados(liquidaciones: readonly LiquidacionLeida[]): string {
  let suma = 0n;
  for (const liquidacion of liquidaciones) {
    suma += importeCanonicoACentavos(liquidacion.netoAcreditado) ?? 0n;
  }
  return centavosAImporte(suma);
}
