/**
 * CAPA C — EVIDENCIA DE CONTRAPARTE POR NOMBRE (Módulo 2, `padron_contraparte`, migración `0037`).
 *
 * PURA: síncrona, sin I/O — mismo criterio que `contrapartida.ts` (misma carpeta). Resuelve una
 * pregunta DISTINTA de la de `contrapartida.ts`: esa decide `socio | tercero` por HMAC exacto de
 * documento; ésta decide, dado que YA se sabe que no es socio (o que la resolución de socio no
 * aplicó todavía), CUÁL proveedor/cliente conocido por NOMBRE matchea la glosa — evidencia
 * estructuralmente más débil, que nunca puede competir con el HMAC exacto.
 *
 * NO se conecta al pipeline real (`motor.ts`) en esta tarea — ver `docs/diseno/29-padron-contraparte.md`
 * §4 y el plan de implementación: es una integración posterior, deliberada.
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
export type EvidenciaDeContraparte =
  | { readonly estado: 'no_aplica' }
  | { readonly estado: 'sin_match' }
  | { readonly estado: 'match'; readonly contraparteId: string; readonly clasificacion: ClasificacionContraparte }
  | { readonly estado: 'multiples_patrones'; readonly contraparteIds: readonly string[] };

/** Dominio cerrado. Lista IDÉNTICA a `contrapartida_patron_estado_chk` (migración `0038`), derivada de
 *  `EvidenciaDeContraparte['estado']`. Si esa unión gana un quinto estado, este array (y el check) se
 *  quedan cortos y hay que actualizar los dos juntos, nunca uno solo. */
export const ESTADOS_EVIDENCIA_CONTRAPARTE = ['no_aplica', 'sin_match', 'match', 'multiples_patrones'] as const;

/** Dominio cerrado, subconjunto: los regímenes de `reconocimiento_contrapartida_patron_match` que
 *  ADMITEN matches (migración `0038`). Lista IDÉNTICA a `contrapartida_patron_match_regimen_chk`.
 *  No es la misma constante que la satélite hermana de socio ('socio_unico' vs 'patron_unico'). */
export const REGIMENES_CON_MATCHES_PATRON = ['patron_unico', 'varios'] as const;

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
 * `glosaNormalizada` y `patron.patron` tienen que venir YA normalizados por el llamador
 * (`normalizar()`, `packages/shared/src/texto/normalizar.ts`) — esta función no normaliza nada: el
 * algoritmo vive una sola vez, mismo criterio que la puerta de admisión de la base (0037) verifica
 * la poscondición sin recalcularla.
 *
 * Match v1: substring exacto, sin prefijo mínimo — conservador, mismo criterio que `galicia.ts`
 * ("conservador nunca es incorrecto, solo subóptimo"). La ambigüedad entre patrones (uno substring
 * de otro) no se resuelve acá: se listan todos los que matchean y decide una persona.
 */
export function resolverEvidenciaDeContraparte(
  resolucionSocio: 'es_socio' | (string & {}),
  glosaNormalizada: string,
  patrones: readonly PatronDeContraparte[],
): EvidenciaDeContraparte {
  if (resolucionSocio === 'es_socio') {
    return { estado: 'no_aplica' };
  }

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
