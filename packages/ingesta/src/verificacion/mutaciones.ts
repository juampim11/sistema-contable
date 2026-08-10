/**
 * Mutadores — la verificación del verificador.
 *
 * ## Por qué existe
 *
 * Un detector con un test verde al lado no prueba nada: un parser que devuelve `[]` tiene **todos** los
 * detectores verdes. Lo que prueba que un detector existe es que **se ponga rojo cuando tiene que
 * ponerse**. Entonces se toma un extracto sintético coherente, se le aplica una mutación conocida, y
 * **la aserción es sobre el detector, no sobre el parser**.
 *
 * > Un detector que no se pone rojo ante su mutación **no existe**, aunque tenga un test verde al lado.
 *
 * Es el mismo patrón que ya vive en `packages/data/tests/catalogo.test.ts` ("el chequeo DETECTA una FK
 * simple entre tablas de dominio"), y por el mismo motivo: una regla que nunca vio un caso malo no está
 * verificada.
 *
 * ## Las mutaciones estructurales que faltan
 *
 * Cuatro de las diez del plan operan sobre el **texto** del extracto, no sobre los movimientos ya
 * parseados: borrar una página, mover la última línea de descripción al bloque siguiente, borrar la línea
 * de totales del texto, y vaciar el texto de algunas páginas. Esas necesitan el adapter, que es la etapa
 * siguiente (E3), y están declaradas como pendientes en `mutaciones.test.ts` en vez de omitidas — porque
 * una de ellas, **la glosa corrida, es el peor modo de falla del módulo**: sobrevive a todas las redes
 * aritméticas y arruina justo lo que hace valioso al PDF.
 */

import { centavosAImporte, importeCanonicoACentavos } from '../parseo-ar.ts';
import type { CuentaConMovimientos } from '../esquema.ts';

export const MUTACIONES = [
  'borrar_fila_del_medio',
  'duplicar_fila',
  'invertir_signo_de_un_debito',
  'intercambiar_importe_y_saldo',
  'alterar_total_declarado',
  'borrar_total_declarado',
  'reemplazar_importe_por_identificador',
  'fecha_fuera_de_periodo',
  'desordenar_fechas',
  'mezclar_moneda',
  'vaciar_movimientos',
] as const;
export type Mutacion = (typeof MUTACIONES)[number];

/** Copia profunda barata y suficiente: los movimientos son datos planos. */
function clonar(c: CuentaConMovimientos): CuentaConMovimientos {
  return {
    cuenta: { ...c.cuenta },
    movimientos: c.movimientos.map((m) => ({ ...m })),
    anexos: c.anexos.map((a) => ({ ...a })),
  };
}

function indiceDelMedio(largo: number): number {
  return Math.max(1, Math.floor(largo / 2));
}

export type OpcionesMutacion = {
  /**
   * Sobre qué fila operar. Por defecto, la del medio.
   *
   * Existe porque hizo falta: al **componer** dos mutaciones con el índice por defecto, duplicar y después
   * borrar caían en la misma posición y **se cancelaban exactamente** — el dato volvía a estar bien y la
   * verificación decía `cuadra`, con razón. El test estaba mal, no el detector, y es justo lo que la
   * verificación del verificador tiene que hacer notar.
   */
  readonly indice?: number;
};

/**
 * Aplica una mutación. **Devuelve una copia**: el fixture original nunca se toca, así cada test parte del
 * mismo estado y las mutaciones no se contaminan entre sí.
 */
export function mutar(
  original: CuentaConMovimientos,
  mutacion: Mutacion,
  opciones: OpcionesMutacion = {},
): CuentaConMovimientos {
  const c = clonar(original);
  const i = Math.min(
    Math.max(1, opciones.indice ?? indiceDelMedio(c.movimientos.length)),
    Math.max(0, c.movimientos.length - 1),
  );

  switch (mutacion) {
    // La fila perdida en el medio del archivo: el caso que la contadora descubre al cierre de ejercicio.
    case 'borrar_fila_del_medio':
      c.movimientos.splice(i, 1);
      return c;

    // La fila contada dos veces: pasa cuando un bloque cruza el corte de página.
    case 'duplicar_fila': {
      const fila = c.movimientos[i];
      if (fila) c.movimientos.splice(i, 0, { ...fila });
      return c;
    }

    // El error de mayor daño contable: invierte el asiento y el balanceo NO lo detecta.
    case 'invertir_signo_de_un_debito': {
      const fila = c.movimientos.find((m) => m.debito !== undefined);
      if (fila?.debito) {
        const magnitud = fila.debito;
        Object.assign(fila, {
          columnaOrigen: 'credito',
          credito: magnitud,
          debito: undefined,
          importe: magnitud,
        });
      }
      return c;
    }

    // Importe y saldo son tokens VECINOS en el texto: confundirlos es un error de separación de columnas.
    case 'intercambiar_importe_y_saldo': {
      const fila = c.movimientos[i];
      if (fila?.saldo) {
        const saldoViejo = fila.saldo;
        const impCent = importeCanonicoACentavos(fila.importe) ?? 0n;
        Object.assign(fila, {
          importe: saldoViejo,
          saldo: centavosAImporte(impCent),
          columnaOrigen: (importeCanonicoACentavos(saldoViejo) ?? 0n) < 0n ? 'debito' : 'credito',
          credito: undefined,
          debito: undefined,
        });
        const v = importeCanonicoACentavos(saldoViejo) ?? 0n;
        if (v < 0n) fila.debito = centavosAImporte(-v);
        else fila.credito = centavosAImporte(v);
      }
      return c;
    }

    // Un dígito cambiado en la línea de totales: el parser leyó mal la red de seguridad.
    case 'alterar_total_declarado': {
      const actual = importeCanonicoACentavos(c.cuenta.totalCreditosDeclarado ?? '0.00') ?? 0n;
      c.cuenta.totalCreditosDeclarado = centavosAImporte(actual + 1000n);
      return c;
    }

    // Sin totales, el resultado tiene que ser `no_verificable`. NUNCA `cuadra`.
    case 'borrar_total_declarado':
      delete c.cuenta.totalCreditosDeclarado;
      delete c.cuenta.totalDebitosDeclarado;
      return c;

    // El caso que `importeACentavos` habilitaba: un identificador de 11 dígitos leído como importe.
    case 'reemplazar_importe_por_identificador': {
      const fila = c.movimientos[i];
      if (fila) {
        Object.assign(fila, {
          importe: '20123456789.00',
          credito: '20123456789.00',
          debito: undefined,
          columnaOrigen: 'credito',
        });
      }
      return c;
    }

    // Una fecha de la glosa (vencimiento de una factura) capturada como fecha del movimiento.
    case 'fecha_fuera_de_periodo': {
      const fila = c.movimientos[i];
      if (fila) fila.fecha = '2019-01-15';
      return c;
    }

    // Señal de que se cruzó un límite de cuenta o de bloque sin detectarlo.
    case 'desordenar_fechas': {
      const a = c.movimientos[i];
      const b = c.movimientos[i + 1];
      if (a && b) {
        const tmp = a.fecha;
        a.fecha = b.fecha;
        b.fecha = tmp;
        if (a.fecha === b.fecha) b.fecha = '2000-01-01';
      }
      return c;
    }

    // Sumar entre monedas no es un bug de redondeo: es un importe sin significado.
    case 'mezclar_moneda': {
      const fila = c.movimientos[i];
      if (fila) fila.moneda = fila.moneda === 'ARS' ? 'USD' : 'ARS';
      return c;
    }

    // El parser roto que reporta éxito: "0 movimientos, todo cuadra".
    case 'vaciar_movimientos':
      c.movimientos = [];
      return c;

    default: {
      const nunca: never = mutacion;
      throw new Error(`mutación no implementada: ${String(nunca)}`);
    }
  }
}

/** Qué código de diferencia tiene que aparecer para cada mutación. Es el contrato del test. */
export const CODIGO_ESPERADO: Readonly<Record<Mutacion, readonly string[]>> = {
  borrar_fila_del_medio: ['ARIT_CADENA_ROTA', 'ARIT_TOTAL_CREDITOS', 'ARIT_TOTAL_DEBITOS'],
  duplicar_fila: ['ARIT_CADENA_ROTA', 'EST_HASH_DUPLICADO'],
  invertir_signo_de_un_debito: ['ARIT_CADENA_ROTA', 'ARIT_SIGNO_INVERTIDO'],
  intercambiar_importe_y_saldo: ['ARIT_CADENA_ROTA'],
  alterar_total_declarado: ['ARIT_TOTAL_CREDITOS'],
  borrar_total_declarado: [],
  reemplazar_importe_por_identificador: ['ARIT_CADENA_ROTA'],
  fecha_fuera_de_periodo: ['EST_FECHA_FUERA_DE_PERIODO'],
  desordenar_fechas: ['EST_FECHA_NO_MONOTONA'],
  mezclar_moneda: ['EST_MONEDA_MEZCLADA'],
  vaciar_movimientos: ['EST_SIN_MOVIMIENTOS'],
} as const;

/** Mutaciones que exigen el adapter (operan sobre el TEXTO). Etapa E3, declaradas para no omitirlas. */
export const MUTACIONES_DE_TEXTO_PENDIENTES = [
  'mover_ultima_linea_de_descripcion_al_bloque_siguiente',
  'borrar_una_pagina_entera',
  'borrar_la_linea_de_totales_del_texto',
  'vaciar_el_texto_de_dos_paginas',
] as const;
