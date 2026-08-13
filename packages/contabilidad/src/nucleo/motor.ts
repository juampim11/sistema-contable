import { CATALOGO_CANONICO } from './catalogo.ts';
import type { ConceptoCanonico, FilaDelCatalogo } from './catalogo.ts';
import { construirIndice } from './indice.ts';
import type { IndiceDeLexico } from './indice.ts';
import { reconocerPorTexto } from './matcher.ts';
import type { Lado } from './tipos.ts';
import type { PendienteDeLaura } from './lexico.ts';
import type { EvidenciaDeMovimiento, Reconocimiento } from './reconocimiento.ts';
import type { ResolucionDeContraparte } from './contrapartida.ts';

const CACHE_INDICES = new Map<string, IndiceDeLexico>();

function indiceCacheado(indice: IndiceDeLexico): IndiceDeLexico {
  const clave = indice.lexico.banco;
  const cacheado = CACHE_INDICES.get(clave);
  if (cacheado && cacheado.lexico === indice.lexico) return cacheado;
  CACHE_INDICES.set(clave, indice);
  return indice;
}

function ladoEsperadoDe(concepto: ConceptoCanonico): Lado | 'indistinto' {
  const fila = CATALOGO_CANONICO[concepto];
  return fila.ladoEsperado;
}

function pendienteDe(fila: FilaDelCatalogo, entradaPendiente: PendienteDeLaura | undefined): PendienteDeLaura | undefined {
  if (entradaPendiente) return entradaPendiente;
  if (fila.ladoEsperado === 'indistinto') return fila.pendienteDeLaura;
  if (fila.resuelve === 'decide_una_persona') return fila.pendienteDeLaura;
  return undefined;
}

/**
 * `motor.ts` tiene 🔴 DOS constructores de `clase: 'propuesta'` (R-F, `PERMITIDOS_PROPUESTA` en
 * `reglas-de-codigo.test.ts`) — `reconocer()` (capa B, reconocimiento de concepto) y
 * `aplicarContrapartida()` (capa C, resolución de contrapartida), más abajo. Nada FUERA de este
 * archivo puede construir `propuesta` — no es "el único archivo" en el sentido de que haya uno
 * solo, es el único LUGAR donde el invariante R-F vive, con dos entradas.
 *
 * Puro: no lee la base, no recibe conexión ni `Tx`. `lexico` se pasa como argumento (no se importa el
 * registro acá) para que el test pueda ejercitar el motor con un léxico sintético sin depender de
 * `lexico/registro.ts`.
 */
export function reconocer(evidencia: EvidenciaDeMovimiento, indiceDelBanco: IndiceDeLexico): Reconocimiento {
  const indice = indiceCacheado(indiceDelBanco);
  const lado: Lado = evidencia.columnaOrigen === 'credito' ? 'haber' : 'debe';

  if (evidencia.conceptoBanco === undefined) {
    return { clase: 'sin_reconocer', motivo: 'sin_evidencia_de_concepto', candidatos: [], evidencia: undefined };
  }

  const resultado = reconocerPorTexto(evidencia.conceptoBanco, evidencia.conceptoCompleto, lado, indice, ladoEsperadoDe);

  if (resultado.resultado === 'ambiguo') {
    return { clase: 'sin_reconocer', motivo: 'ambiguo', candidatos: resultado.candidatos, evidencia: undefined };
  }
  if (resultado.resultado === 'no_encontrado') {
    return { clase: 'sin_reconocer', motivo: 'concepto_no_catalogado', candidatos: [], evidencia: undefined };
  }

  const { entrada, via, caracteresMatcheados } = resultado;
  const fila = CATALOGO_CANONICO[entrada.concepto];
  const evidenciaDelMatch = {
    entradaLexicoId: entrada.id,
    via,
    caracteresMatcheados,
    huboCola: entrada.matcheo.modo === 'prefijo_con_cola',
  };

  if (fila.resuelve === 'sin_tipo_asignado') {
    return {
      clase: 'sin_reconocer',
      motivo: 'concepto_sin_tipo_asignado',
      candidatos: [entrada.id],
      evidencia: evidenciaDelMatch,
    };
  }

  // INV-M2-1 — coherencia de reversa. `fila.ladoEsperado` YA es el lado esperado de ESTA fila —
  // para una reversa, es el lado propio de la reversa (verificado independiente contra la base por
  // PROP-4, que exige `ladoEsperado === opuesto(base.ladoEsperado)` como consistencia entre las dos
  // filas, no como fórmula de derivación acá). 'indistinto' es vacuamente coherente, a propósito.
  if (fila.ladoEsperado !== 'indistinto') {
    const esperado = fila.ladoEsperado;
    if (lado !== esperado) {
      return {
        clase: 'sin_reconocer',
        motivo: 'reversa_incoherente',
        candidatos: [entrada.id],
        evidencia: evidenciaDelMatch,
      };
    }
  }

  const pendiente = pendienteDe(fila, entrada.pendienteDeLaura);

  if (fila.resuelve === 'propone' && !pendiente) {
    return {
      clase: 'propuesta',
      tipo: fila.tipo,
      concepto: entrada.concepto,
      polaridad: fila.polaridad,
      lado,
      via,
      evidencia: evidenciaDelMatch,
    };
  }

  // `fila.resuelve === 'decide_una_persona'`, o `'propone'` degradado por `pendienteDeLaura`.
  const queDecide = fila.resuelve === 'decide_una_persona' ? fila.queDecide : 'confirmar_hipotesis_del_lexico';
  return {
    clase: 'decision_humana',
    tipo: fila.tipo,
    concepto: entrada.concepto,
    polaridad: fila.polaridad,
    lado,
    via,
    evidencia: evidenciaDelMatch,
    queDecide,
    ...(pendiente ? { pendienteDeLaura: pendiente } : {}),
  };
}

/**
 * Segundo constructor de `clase: 'propuesta'` de este archivo (capa C — ver el docblock de
 * `reconocer()` arriba). PURA: no toca ningún `Reconocimiento` que no sea `decision_humana` con
 * `queDecide: 'distinguir_tercero_de_socio'` — pasa el resto sin cambios, identidad estructural.
 *
 * Reglas de promoción (`04-imputacion-contable.md`, `contador-dominio` Ronda 1): `lado === 'debe'`
 * → 12b/12a; `lado === 'haber'` → 13b/13a. Los otros 5 estados de `ResolucionDeContraparte` nunca
 * promueven — se quedan en `decision_humana`, con la evidencia adjunta para que la persona vea
 * POR QUÉ.
 */
export function aplicarContrapartida(
  reconocimiento: Reconocimiento,
  resolucion: ResolucionDeContraparte,
): Reconocimiento {
  if (reconocimiento.clase !== 'decision_humana') return reconocimiento;
  if (reconocimiento.queDecide !== 'distinguir_tercero_de_socio') return reconocimiento;

  const { concepto, polaridad, lado, via, evidencia } = reconocimiento;

  switch (resolucion.estado) {
    case 'es_socio':
      return {
        clase: 'propuesta',
        tipo: lado === 'debe' ? 'retiro_de_socio' : 'aporte_de_socio',
        concepto,
        polaridad,
        lado,
        via,
        evidencia,
        evidenciaContrapartida: resolucion,
      };

    case 'es_tercero_padron_completo':
      return {
        clase: 'propuesta',
        tipo: lado === 'debe' ? 'pago_a_proveedor_transferencia' : 'cobranza_de_cliente',
        concepto,
        polaridad,
        lado,
        via,
        evidencia,
        evidenciaContrapartida: resolucion,
      };

    case 'sin_match_padron_incompleto':
    case 'sin_candidatos':
    case 'pepper_desalineado':
    case 'multiples_socios':
    case 'socio_fuera_de_vigencia':
      return { ...reconocimiento, evidenciaContrapartida: resolucion };
  }
}

export { construirIndice };
