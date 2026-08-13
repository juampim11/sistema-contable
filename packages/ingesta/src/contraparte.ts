/**
 * CANDIDATOS DE CONTRAPARTE — extrae, de los identificadores que `depurarGlosa` ya separó, los
 * candidatos que se persisten en `movimiento_contraparte_identificador` (migración 0013).
 *
 * Función PURA: no toca la base ni storage. La usan dos caminos distintos —
 * `packages/ingesta/src/persistir.ts` (lotes nuevos, el valor ya está en memoria) y
 * `packages/ingesta/src/reproceso/backfill-contraparte.ts` (histórico, tras leer la satélite N2R
 * de movimientos vía el lector auditado) — y el resultado tiene que ser idéntico para los dos: la
 * misma glosa produce los mismos candidatos, se calcule cuando se calcule.
 *
 * ## El guard de forma, y por qué hace falta pese a que `glosa.ts` ya clasificó
 *
 * `depurarGlosa` agrupa por CLASE DE PATRÓN, no por identidad garantizada:
 *   - `identificadores.cuit` — ya pasó por `RE_CUIT` (11 dígitos, prefijo AFIP válido): siempre 11.
 *   - `identificadores.cbu` — ya pasó por `RE_CBU` (22 dígitos con separadores opcionales): siempre
 *     22 tras normalizar.
 *   - `identificadores.documento` — es la UNIÓN de dos patrones distintos: `RE_DNI` (7-8 dígitos
 *     pegados) Y `RE_CORRIDA_LARGA` (9+ dígitos, el catch-all). Un CBU truncado por el ancho de una
 *     columna cae acá con 13 dígitos, y también un número de operación de 10. Ninguno de los dos es
 *     un documento: el guard separa por LARGO tras normalizar y descarta lo que no tiene forma de
 *     DNI (7-8 dígitos exactos).
 *
 * Sin este guard, un número de operación etiquetado `dni` produce un HMAC que nunca va a matchear
 * nada — ocupa el slot de "hay identificador" sin serlo, ruido que parece señal
 * (`security-engineer`, ronda de revisión de `0013`).
 *
 * ## El filtro "es la cuenta propia del cliente"
 *
 * Antes de persistir un candidato `cbu`, se compara —en espacio GLOBAL, transitorio, NUNCA
 * persistido— contra los digests de `cuenta_bancaria_identificador.cbu_hmac` del mismo cliente. Si
 * matchea, no es una contraparte: es la cuenta propia del cliente apareciendo en una transferencia
 * entre cuentas propias (regla 10). No se persiste como candidato — la señal queda en
 * `captura: 'capturado_cuenta_propia'` cuando no queda ningún otro candidato genuino en la fila.
 */

import { hmacDocumento, hmacIdentificador, hmacIguales, pepperIdActual } from '@sistema-contable/shared/seguridad';
import type { GlosaDepurada } from './glosa.ts';

export type CandidatoContraparte = {
  readonly clase: 'cuit' | 'dni' | 'cbu';
  readonly hmac: Buffer;
  readonly pepperId: string;
};

export type ExtraccionContraparte = {
  readonly candidatos: readonly CandidatoContraparte[];
  readonly captura: 'sin_identificador' | 'capturado' | 'capturado_cuenta_propia';
  /** Cuántos identificadores se descartaron por no tener la forma de su clase (nunca hasheados). */
  readonly descartadosPorForma: number;
};

function normalizarADigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}

/**
 * Extrae los candidatos de contraparte de una glosa ya depurada.
 *
 * `digestsPropios` son los `cbu_hmac` (espacio GLOBAL, pepper del entorno) de las cuentas del
 * cliente — se comparan una sola vez por candidato CBU, nunca se persisten.
 */
export function extraerCandidatosDeContraparte(
  identificadores: GlosaDepurada['identificadores'],
  clienteId: string,
  digestsPropios: readonly Buffer[],
): ExtraccionContraparte {
  const pepperId = pepperIdActual();
  const candidatos: CandidatoContraparte[] = [];
  let descartadosPorForma = 0;
  let huboCuentaPropia = false;

  for (const cuit of identificadores.cuit) {
    if (normalizarADigitos(cuit).length !== 11) {
      descartadosPorForma += 1;
      continue;
    }
    candidatos.push({ clase: 'cuit', hmac: hmacDocumento('cuit', cuit, clienteId), pepperId });
  }

  for (const documento of identificadores.documento) {
    const largo = normalizarADigitos(documento).length;
    if (largo !== 7 && largo !== 8) {
      // Vino de RE_CORRIDA_LARGA (9+ dígitos): número de operación o CBU truncado, no un DNI.
      descartadosPorForma += 1;
      continue;
    }
    candidatos.push({ clase: 'dni', hmac: hmacDocumento('dni', documento, clienteId), pepperId });
  }

  for (const cbu of identificadores.cbu) {
    if (normalizarADigitos(cbu).length !== 22) {
      descartadosPorForma += 1;
      continue;
    }
    // Comparación transitoria en espacio GLOBAL — nunca persistida, nunca logueada.
    const digestGlobal = hmacIdentificador(cbu);
    const esCuentaPropia = digestsPropios.some((propio) => hmacIguales(propio, digestGlobal));
    if (esCuentaPropia) {
      huboCuentaPropia = true;
      continue;
    }
    candidatos.push({ clase: 'cbu', hmac: hmacDocumento('cbu', cbu, clienteId), pepperId });
  }

  const captura: ExtraccionContraparte['captura'] =
    candidatos.length > 0 ? 'capturado' : huboCuentaPropia ? 'capturado_cuenta_propia' : 'sin_identificador';

  return { candidatos, captura, descartadosPorForma };
}
