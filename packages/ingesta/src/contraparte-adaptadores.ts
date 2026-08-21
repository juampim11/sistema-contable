/**
 * Adaptadores entre `Candidato`/`SocioDelPadron` de `@sistema-contable/data` (lo que lee la base) y
 * `CandidatoDeContraparte`/`SocioDelPadron` de `@sistema-contable/contabilidad` (lo que espera el motor
 * puro, capa C). Únicos — antes duplicados byte a byte en `apps/cli/src/resolver-contrapartida.ts` y
 * `packages/ingesta/src/planilla/exportar-planilla.ts` (`code-reviewer`, plan "export enriquecido",
 * 2026-08-21): la razón que motivaba la duplicación ("`apps/cli` es la única capa que ve los dos
 * paquetes a la vez") dejó de ser cierta el día que `packages/ingesta` sumó
 * `@sistema-contable/contabilidad` como dependencia — ahora hay DOS capas, y compartir la función es
 * más simple que mantener dos copias sincronizadas a mano.
 *
 * R-B (`packages/data/tests/reglas-de-codigo.test.ts`) no se toca: sigue sin haber un import de
 * `contabilidad` DESDE `data`, ni de `data`/`ingesta` DESDE `contabilidad` — este archivo vive en
 * `ingesta`, que ya puede ver los dos.
 */

import type { Candidato, SocioDelPadron as SocioDelPadronLeido } from '@sistema-contable/data';
import type { CandidatoDeContraparte, SocioDelPadron } from '@sistema-contable/contabilidad';

export function comoCandidatoDeContraparte(c: Candidato): CandidatoDeContraparte {
  return { clase: c.clase, hmac: c.identificadorHmac, pepperId: c.pepperId };
}

export function comoSocioDelPadron(s: SocioDelPadronLeido): SocioDelPadron {
  return {
    socioId: s.id,
    documentoHmac: s.documentoHmac,
    pepperId: s.pepperId,
    vigenteDesde: s.vigenteDesde,
    vigenteHasta: s.vigenteHasta,
  };
}
