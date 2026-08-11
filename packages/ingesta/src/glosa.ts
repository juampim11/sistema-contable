/**
 * INV-13 — LA GLOSA SE DEPURA ANTES DE SER `descripcion`.
 *
 * ## Por qué esto existe, y por qué no es cosmético
 *
 * `movimiento_bancario_crudo.descripcion` está clasificada **N2**, y de esa clasificación depende algo
 * concreto: que el contador pueda listar movimientos **sin** pasar por el lector auditado. Si tuviera que
 * auditarse cada lectura de 326 filas, la auditoría se llenaría de ruido y dejaría de servir para detectar
 * el acceso masivo real (ADR-0002 H-8).
 *
 * Pero la glosa que publica el banco trae **CUIT y CBU de las contrapartes**: en el extracto real del
 * piloto hay 113 corridas de once dígitos. Un CUIT de un tercero es dato de una persona que **no es
 * cliente del estudio y nunca consintió nada**: es N2R, no N2.
 *
 * O sea: **si la descripción conserva los identificadores, la clasificación N2 es falsa**, y con ella se
 * cae el permiso de leer movimientos sin auditar. No es que "convendría limpiarla": es que la tabla estaría
 * mal clasificada y el control de N2R no se estaría aplicando a un dato que lo exige.
 *
 * La solución es separar. Los identificadores se extraen a la **fila cruda** (`movimiento_origen_crudo`,
 * N2R, con rol en lectura y lector auditado) y la `descripcion` queda con la parte que sirve para
 * clasificar contablemente —el concepto, el nombre— sin los identificadores.
 *
 * ## Lo que NO puede hacer, declarado
 *
 * **No saca el nombre propio ni la razón social.** Es texto sin patrón y el redactor no puede reconocerlo
 * (ADR-0002 §C.0.bis). Y tampoco debería sacarlo: el nombre de la contraparte es exactamente lo que el
 * contador necesita para clasificar el movimiento. Por eso `descripcion` sigue siendo N2 y no N1 — no es
 * un dato inocuo, es un dato que el contador tiene derecho a ver sin ceremonia.
 *
 * Lo que INV-13 garantiza es más acotado y verificable: **ningún identificador con forma** —CUIT, CBU,
 * número de documento— sobrevive en la descripción.
 */

import { RE_CBU, RE_CORRIDA_LARGA, RE_CUIT, RE_DNI } from '@sistema-contable/shared/seguridad';
import { normalizar } from './parseo-ar.ts';

/** Marcadores estables. Se conserva la posición del identificador sin conservar su valor. */
export const MARCADOR = {
  cuit: '[CUIT]',
  cbu: '[CBU]',
  documento: '[DOC]',
} as const;

export type GlosaDepurada = {
  /** Lo que va a `movimiento_bancario_crudo.descripcion`. Sin identificadores. */
  readonly descripcion: string;
  /**
   * Los identificadores encontrados, para la fila cruda N2R. **Valores**, no marcadores: acá sí van
   * enteros, porque la satélite es el lugar del sistema donde un dato de tercero puede vivir con su
   * control puesto.
   */
  readonly identificadores: {
    readonly cuit: readonly string[];
    readonly cbu: readonly string[];
    readonly documento: readonly string[];
  };
};

/**
 * Los patrones, en el orden en que se aplican. **El orden importa**: un CBU tiene 22 dígitos y contiene
 * corridas de 11 y de 8, así que si el CUIT se buscara primero le comería los primeros once dígitos de un
 * CBU y dejaría los otros once sueltos en la descripción. De más largo a más corto.
 */
/**
 * Los cuatro patrones, en el orden en que se aplican, ahora centralizados en
 * `packages/shared/src/seguridad/detectores-forma.ts` — compartidos con el redactor de logs
 * (`redactar.ts`). Antes cada archivo tenía su propia copia, y ya habían divergido: ver el comentario de
 * ese módulo para el caso medido (un CBU pegado a un guión que el lookaround-sin-guión de acá dejaba pasar
 * entero, mientras el `\b` de `redactar.ts` sí lo atrapaba) y para por qué el CUIT ahora exige prefijo
 * válido en vez de aceptar cualquier corrida de 11 dígitos.
 *
 * **`PATRONES` se exporta** para que el test de paridad estructural (`detectores-compartidos.test.ts`)
 * pueda afirmar que este archivo y `redactar.ts` importan del mismo catálogo — no una copia con el mismo
 * contenido.
 */
export const PATRONES = [
  { clase: 'cbu' as const, re: RE_CBU },
  { clase: 'cuit' as const, re: RE_CUIT },
  /**
   * Documento (DNI): 7 u 8 dígitos, con separadores comunes opcionales (ver `detectores-forma.ts`). Es el
   * más ambiguo de los cuatro (un número de operación también tiene esta forma), y el lookaround que
   * excluye la coma —el fix del bug original de este archivo: sin él, un importe sin separador de miles
   * (`1234567,89`) entregaba sus siete dígitos a este patrón— viaja con el patrón importado.
   */
  { clase: 'documento' as const, re: RE_DNI },
  /**
   * Corrida larga de dígitos: 9 o más, que no cayó en ninguna clase anterior.
   *
   * Salió de mirar el fixture generado. El layout de columnas **trunca** la glosa, así que un CBU de 22
   * dígitos en el texto libre queda cortado en 13: no matchea el patrón de CBU, no matchea el de CUIT (11)
   * ni el de documento (7-8), y **sobrevive en la descripción**. Un identificador parcial sigue siendo un
   * identificador — con 13 de los 22 dígitos de un CBU se lo termina de adivinar.
   *
   * No hay riesgo de comerse un importe: un importe siempre lleva coma decimal, y el lookbehind excluye
   * los separadores.
   */
  { clase: 'documento' as const, re: RE_CORRIDA_LARGA },
] as const;

/**
 * Depura la glosa.
 *
 * ## Sobre el falso positivo del documento
 *
 * El patrón de 7-8 dígitos también matchea un número de operación o de comprobante, que **no** es un dato
 * personal. Se enmascara igual, y es una decisión consciente: perder un número de operación de la
 * descripción cuesta un poco de contexto al clasificar; dejar pasar un DNI de un tercero rompe la
 * clasificación N2 de la columna y con ella el permiso de leer sin auditar.
 *
 * El número de operación no se pierde: sigue en la fila cruda, y el adapter lo captura aparte en
 * `referencias` cuando el banco lo publica en su propia columna — que es de donde tiene que salir, no de
 * un patrón sobre texto libre.
 */
export function depurarGlosa(glosa: string): GlosaDepurada {
  const encontrados: Record<'cuit' | 'cbu' | 'documento', string[]> = {
    cuit: [],
    cbu: [],
    documento: [],
  };

  let texto = glosa;
  for (const { clase, re } of PATRONES) {
    texto = texto.replace(new RegExp(re.source, re.flags), (m) => {
      encontrados[clase].push(m);
      return MARCADOR[clase];
    });
  }

  return {
    // `normalizar` colapsa los espacios que deja el reemplazo y pasa a mayúsculas, que es la forma en que
    // el clasificador del Módulo 2 va a comparar.
    descripcion: normalizar(texto),
    identificadores: {
      cuit: encontrados.cuit,
      cbu: encontrados.cbu,
      documento: encontrados.documento,
    },
  };
}

/**
 * El invariante, como función. Es lo que el test corre sobre toda descripción producida, y lo que el
 * pipeline puede llamar como aserción antes de persistir.
 *
 * Se implementa con los **mismos patrones** que la depuración: si algún día se agrega una clase de
 * identificador, el verificador la conoce sin que nadie lo actualice aparte. Dos listas divergen.
 */
export function contieneIdentificador(descripcion: string): boolean {
  return PATRONES.some(({ re }) => new RegExp(re.source, re.flags).test(descripcion));
}
