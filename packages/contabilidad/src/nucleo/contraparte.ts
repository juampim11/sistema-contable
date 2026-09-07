/**
 * CAPA C — EVIDENCIA DE CONTRAPARTE POR NOMBRE (Módulo 2, `padron_contraparte`, migración `0037`).
 *
 * PURA: síncrona, sin I/O — mismo criterio que `contrapartida.ts` (misma carpeta). Resuelve una
 * pregunta DISTINTA de la de `contrapartida.ts`: esa decide `socio | tercero` por HMAC exacto de
 * documento; ésta decide, dado que YA se sabe que no es socio (o que la resolución de socio no
 * aplicó todavía), CUÁL proveedor/cliente conocido por NOMBRE matchea la glosa — evidencia
 * estructuralmente más débil, que nunca puede competir con el HMAC exacto.
 *
 * Conectado al pipeline real desde el 2026-09-06 (`motor.ts:adjuntarEvidenciaDeContraparte`, los 3
 * call sites de `apps/cli`/`packages/ingesta`) — ver `docs/diseno/29-padron-contraparte.md` §4.
 */

/** Dominio cerrado. Lista IDÉNTICA a `padron_contraparte_clasificacion_chk` (migración `0037`).
 *  Comparada como conjunto contra `pg_constraint` por el test de catálogo de dominios cerrados. */
export const CLASIFICACIONES_CONTRAPARTE = ['proveedor', 'cliente', 'otro'] as const;
export type ClasificacionContraparte = (typeof CLASIFICACIONES_CONTRAPARTE)[number];

/** Una fila de `padron_contraparte`, tal como la lee el futuro `leerPadronDeContrapartes` — el
 *  padrón COMPLETO del cliente. `patron` YA viene normalizado (mismo contrato que `padron_socio`
 *  con `documentoHmac`: la normalización vive una sola vez, en TypeScript, antes de escribir). */
export type PatronDeContraparte = {
  readonly contraparteId: string;
  readonly patron: string;
  readonly clasificacion: ClasificacionContraparte;
};

/**
 * Los cuatro estados. Tri-estado explícito de consulta (mismo espíritu que `contraparte_captura`,
 * 0013) MÁS la ambigüedad fail-closed (mismo criterio que `multiples_socios` en `contrapartida.ts`):
 *
 *   - `no_aplica`      → NO SE CONSULTÓ: la resolución de socio ya cerró el caso (`es_socio`).
 *   - `sin_match`      → SE CONSULTÓ, ningún patrón matcheó.
 *   - `match`          → un solo patrón matcheó.
 *   - `multiples_patrones` → dos o más patrones matchean la misma glosa — nunca se elige el más
 *     específico, va a decisión humana (mismo espíritu que `multiples_socios`).
 *
 * Ningún estado toca `clase`/`propuesta`: eso es responsabilidad exclusiva de quien integre esto al
 * pipeline real, respetando la regla dura de `docs/diseno/29-padron-contraparte.md` §1.2 — un match
 * de nombre nunca promueve `decision_humana → propuesta` por sí solo.
 */
/** Dominio cerrado. Lista IDÉNTICA a `contrapartida_patron_origen_chk` (migración `0039`). Solo las
 *  variantes `match`/`multiples_patrones` de `EvidenciaDeContraparte` lo llevan — `no_aplica` no
 *  consultó nada y `sin_match` no tiene nada que atribuir. */
export const ORIGENES_EVIDENCIA_CONTRAPARTE = ['concepto_banco', 'descripcion'] as const;
export type OrigenEvidenciaContraparte = (typeof ORIGENES_EVIDENCIA_CONTRAPARTE)[number];

export type EvidenciaDeContraparte =
  | { readonly estado: 'no_aplica' }
  | { readonly estado: 'sin_match' }
  | {
      readonly estado: 'match';
      readonly contraparteId: string;
      readonly clasificacion: ClasificacionContraparte;
      readonly origen: OrigenEvidenciaContraparte;
    }
  | {
      readonly estado: 'multiples_patrones';
      readonly contraparteIds: readonly string[];
      readonly origen: OrigenEvidenciaContraparte;
    };

/** Dominio cerrado. Lista IDÉNTICA a `contrapartida_patron_estado_chk` (migración `0038`), derivada de
 *  `EvidenciaDeContraparte['estado']`. Si esa unión gana un quinto estado, este array (y el check) se
 *  quedan cortos y hay que actualizar los dos juntos, nunca uno solo. */
export const ESTADOS_EVIDENCIA_CONTRAPARTE = ['no_aplica', 'sin_match', 'match', 'multiples_patrones'] as const;

/** Dominio cerrado, subconjunto: los regímenes de `reconocimiento_contrapartida_patron_match` que
 *  ADMITEN matches (migración `0038`). Lista IDÉNTICA a `contrapartida_patron_match_regimen_chk`.
 *  No es la misma constante que la satélite hermana de socio ('socio_unico' vs 'patron_unico'). */
export const REGIMENES_CON_MATCHES_PATRON = ['patron_unico', 'varios'] as const;

/** Las dos glosas candidatas contra las que se intenta matchear, en orden de intento. Ambas tienen
 *  que venir YA normalizadas por el llamador (`normalizar()`) — esta función no normaliza nada,
 *  mismo criterio que el resto del archivo. */
export type GlosasCandidatas = {
  /** El segmento que ya extrae Capa B (`concepto_banco`) — se prueba PRIMERO: es la superficie más
   *  chica y, cuando alcanza (Macro, vocabulario cerrado y anclado), la más precisa. */
  readonly conceptoBanco: string;
  /** La glosa completa del banco (`descripcion`) — se prueba SOLO si `conceptoBanco` da `sin_match`.
   *  Convocatoria `dba-data`/`security-engineer`/`seguridad-datos-financieros` (2026-09-06, corpus
   *  real de Bracci): para Galicia/Santander, `concepto_banco` es un corte geométrico que nunca
   *  llega al nombre del proveedor (medido: 79/79 apariciones reales en `descripcion`, 0/79 en
   *  `concepto_banco`); para Bancor/ICBC/Nación, `concepto_banco` ni se captura. */
  readonly descripcion: string;
};

type ResultadoDeMatch =
  | { readonly estado: 'sin_match' }
  | { readonly estado: 'match'; readonly contraparteId: string; readonly clasificacion: ClasificacionContraparte }
  | { readonly estado: 'multiples_patrones'; readonly contraparteIds: readonly string[] };

function matchearContraGlosa(
  glosaNormalizada: string,
  patrones: readonly PatronDeContraparte[],
): ResultadoDeMatch {
  const matches = patrones.filter((p) => glosaNormalizada.includes(p.patron));

  if (matches.length === 0) {
    return { estado: 'sin_match' };
  }

  if (matches.length > 1) {
    return { estado: 'multiples_patrones', contraparteIds: matches.map((m) => m.contraparteId) };
  }

  const unico = matches[0] as PatronDeContraparte;
  return { estado: 'match', contraparteId: unico.contraparteId, clasificacion: unico.clasificacion };
}

/**
 * Resuelve la evidencia de contraparte de UN movimiento, dado el `estado` que ya produjo
 * `resolverContraparte` (`contrapartida.ts`) para ese mismo movimiento sobre `padron_socio`.
 *
 * 🔴 EL CORTE DE `es_socio` VA PRIMERO, Y NO ES COSMÉTICO — es la regla dura no negociable del
 * diseño: un match de nombre es evidencia estructuralmente más débil que el HMAC exacto que hoy
 * protege contra la "conversión silenciosa de socio en proveedor" (`alinearPepper`,
 * `contrapartida.ts`). Si el corte se moviera después de consultar `patrones`, un movimiento cuyo
 * candidato matchea por HMAC contra un socio real Y cuya glosa también matchea por texto contra un
 * patrón de `padron_contraparte` terminaría mezclando las dos evidencias — exactamente lo que este
 * corte existe para impedir. Ver la prueba de mutación (`contraparte.test.ts`, F5).
 *
 * 🔴 FALLBACK SECUENCIAL, NUNCA MERGE (convocatoria 2026-09-06, hallazgo `dba-data`): se intenta
 * `glosas.conceptoBanco` primero; si y solo si da `sin_match`, se reintenta con
 * `glosas.descripcion` — y ese segundo resultado REEMPLAZA al primero, nunca se combinan las dos
 * listas de matches. Sumar los `contraparteId` de las dos pasadas arriesgaría contar el mismo
 * patrón dos veces como si fueran dos matches distintos y degradar a `multiples_patrones` por una
 * ambigüedad que no existe. Si `conceptoBanco` ya dio `match`/`multiples_patrones`, `descripcion`
 * NUNCA se consulta — el resultado lleva `origen: 'concepto_banco'` y ahí termina.
 *
 * Match v1: substring exacto, sin prefijo mínimo — conservador, mismo criterio que `galicia.ts`
 * ("conservador nunca es incorrecto, solo subóptimo"). La ambigüedad entre patrones (uno substring
 * de otro) no se resuelve acá: se listan todos los que matchean y decide una persona.
 */
export function resolverEvidenciaDeContraparte(
  resolucionSocio: 'es_socio' | (string & {}),
  glosas: GlosasCandidatas,
  patrones: readonly PatronDeContraparte[],
): EvidenciaDeContraparte {
  if (resolucionSocio === 'es_socio') {
    return { estado: 'no_aplica' };
  }

  const porConceptoBanco = matchearContraGlosa(glosas.conceptoBanco, patrones);
  if (porConceptoBanco.estado !== 'sin_match') {
    return { ...porConceptoBanco, origen: 'concepto_banco' };
  }

  const porDescripcion = matchearContraGlosa(glosas.descripcion, patrones);
  if (porDescripcion.estado !== 'sin_match') {
    return { ...porDescripcion, origen: 'descripcion' };
  }

  return { estado: 'sin_match' };
}
