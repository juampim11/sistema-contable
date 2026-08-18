/**
 * CAPA C — RESOLUCIÓN DE CONTRAPARTIDA (Módulo 2). Plan `adaptive-herding-pillow`, P4.
 *
 * PURA: síncrona, sin I/O, sin `clienteId` de contexto (R-J — `nucleo/` no usa funciones que esperan; el
 * aislamiento cross-cliente H-6/INV-9 vive en `packages/data/src/contabilidad/lecturas.ts`,
 * `leerPadronYCandidatosDeContraparte`, que arma los argumentos de acá ANTES de invocar).
 *
 * `documento/CBU → socio | tercero`, contra el padrón de socios (`08-plan-de-construccion.md`
 * §5.bis) — nunca contra un padrón de terceros, que no existe por diseño.
 */

import { hmacIguales } from '@sistema-contable/shared/seguridad';
import type { EstadoResolucion } from './tipos.ts';

/**
 * Espejo TEXTUAL de `CandidatoContraparte` (`packages/ingesta/src/contraparte.ts:39-43`) y de
 * `Candidato` (`packages/data/src/contabilidad/lecturas.ts`). No se importa (R-B, prohibición
 * bidireccional `data`/`ingesta` ↔ `contabilidad`) — R-H bis mantiene los nombres de campo
 * sincronizados por barrido de texto en `reglas-de-codigo.test.ts`.
 */
export type CandidatoDeContraparte = {
  readonly clase: 'cuit' | 'dni' | 'cbu';
  readonly hmac: Buffer;
  readonly pepperId: string;
};

/**
 * Una fila de `padron_socio`, tal como la lee `leerPadronDeSocios` — el padrón COMPLETO del
 * cliente, sin filtrar por vigencia (la vigencia se evalúa acá, no en la lectura). Espejo textual
 * de `SocioDelPadron` (`packages/data/src/contabilidad/lecturas.ts`), mismo mecanismo R-H bis.
 *
 * Fechas como string `'YYYY-MM-DD'` (comparación lexicográfica = cronológica sobre ISO sin hora) —
 * nunca `Date`: la zona horaria del host no entra en una función pura (CLAUDE.md §2).
 *
 * `socioId` (acá) vs. `id` (en `data`) es divergencia de CONVENCIÓN, no descuido — `contabilidad`
 * siempre califica el identificador de fila, `data` lo deja desnudo. El adaptador está en
 * `apps/cli/src/resolver-contrapartida.ts` (`comoSocioDelPadron`).
 */
export type SocioDelPadron = {
  readonly socioId: string;
  readonly documentoHmac: Buffer;
  readonly pepperId: string;
  readonly vigenteDesde: string;
  readonly vigenteHasta: string | null;
};

/**
 * "El padrón se consultó de verdad" como tipo, no como convención — mismo idioma que
 * `ContextoAuditado` (`packages/data/src/db/auditoria.ts:78-83`). La marca es privada al módulo:
 * la única función que la construye es `marcarPadronConsultado`, acá abajo.
 *
 * `packages/data` NUNCA importa este tipo (R-B bidireccional): `leerPadronDeSocios` devuelve
 * `readonly SocioDelPadron[]` a secas. Envolver ese resultado en `PadronConsultado` es
 * responsabilidad de `apps/cli` (la única capa que importa `data` Y `contabilidad`), llamando a
 * `marcarPadronConsultado()` inmediatamente después de leer, antes de armar los argumentos de
 * `resolverContraparte`. Con esto, "padrón vacío" (`socios: []`, marcado) y "padrón nunca
 * consultado" (imposible de construir sin pasar por acá) son estados estructuralmente distintos.
 */
declare const marcaPadronConsultado: unique symbol;
export type PadronConsultado = {
  readonly [marcaPadronConsultado]: true;
  readonly socios: readonly SocioDelPadron[];
};

/** El ÚNICO lugar del monorepo donde se construye un `PadronConsultado` (test de catálogo estilo
 *  R-F, grep sobre `packages/contabilidad` + `packages/data` buscando el cast). */
export function marcarPadronConsultado(socios: readonly SocioDelPadron[]): PadronConsultado {
  return { socios } as unknown as PadronConsultado;
}

/** Un candidato del movimiento que matcheó (por HMAC) contra una fila del padrón. Nunca lleva
 *  `denominacion` — evidencia en pantalla es `socioId` (uuid) y `clase`, nada más. */
export type MatchDeContraparte = {
  readonly socioId: string;
  readonly clase: CandidatoDeContraparte['clase'];
};

/** Igual que `MatchDeContraparte`, con la ventana de vigencia adjunta — evidencia auditable de
 *  `socio_fuera_de_vigencia` sin volver a consultar la base. */
export type MatchFueraDeVigencia = MatchDeContraparte & {
  readonly vigenteDesde: string;
  readonly vigenteHasta: string | null;
};

/**
 * Los 7 estados de resolución (plan `adaptive-herding-pillow.md`, Ronda 1 `contador-dominio` +
 * `seguridad-datos-financieros`, Ronda 2 `motor-conciliacion-contable`). Unión discriminada por
 * `estado`; cada rama lleva SU evidencia — nunca un score inventado: el match es determinístico
 * (HMAC igual o no), no difuso.
 */
export type ResolucionDeContraparte =
  | { readonly estado: 'sin_candidatos' }
  | { readonly estado: 'es_socio'; readonly socioId: string; readonly matches: readonly MatchDeContraparte[] }
  | { readonly estado: 'es_tercero_padron_completo' }
  | { readonly estado: 'sin_match_padron_incompleto' }
  | {
      readonly estado: 'pepper_desalineado';
      readonly pepperIdsCandidatos: readonly string[];
      readonly pepperIdsPadron: readonly string[];
    }
  | { readonly estado: 'multiples_socios'; readonly matches: readonly MatchDeContraparte[] }
  | { readonly estado: 'socio_fuera_de_vigencia'; readonly matches: readonly MatchFueraDeVigencia[] };

/**
 * 🔴 EL DISCRIMINANTE Y LA CONSTANTE NO PUEDEN DIVERGIR, y esto lo hace un error de compilación en
 * vez de una convención. `ESTADOS_RESOLUCION` (`tipos.ts`) espeja el check `contrapartida_estado_chk`
 * de la base (`0021`), así que una rama agregada acá y no allá —o al revés— dejaría la base
 * aceptando un estado que el motor no produce, o al motor produciendo uno que la base rechaza en el
 * `insert`, en producción y con el lote a medio escribir.
 *
 * Se verifica en LAS DOS DIRECCIONES a propósito: `[A] extends [B]` sola dejaría pasar que la unión
 * tenga ramas de más. La constante exportada es lo que fuerza la evaluación — un `type` suelto no
 * rompe nada, y `noUnusedLocals` rechaza una variable local.
 */
type MismoConjunto<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const DOMINIO_DE_RESOLUCION_COHERENTE: MismoConjunto<
  EstadoResolucion,
  ResolucionDeContraparte['estado']
> = true;

type ResultadoAlineacionPepper =
  | { readonly alineado: true }
  | { readonly alineado: false; readonly pepperIdsCandidatos: readonly string[]; readonly pepperIdsPadron: readonly string[] };

/**
 * 🔴 Regla de UNIFORMIDAD de `pepper_id` (corregida en el cierre — `tester`, Ronda 3, encontró que la
 * regla de intersección original era insegura). Fail-closed real:
 *
 * **Alineado ⟺ candidatos y padrón, TODOS JUNTOS, usan exactamente UNA versión de pepper.** Cualquier
 * heterogeneidad — más de un valor de `pepperId` presente entre los candidatos y las filas del
 * padrón, sea cual sea la combinación — es `pepper_desalineado`.
 *
 * **Por qué la versión anterior (intersección + huérfano) era insegura**: alineaba si ALGÚN socio del
 * padrón compartía el pepper del candidato, sin importar que OTRO socio del mismo padrón estuviera en
 * otra versión. Escenario real que `tester` reprodujo ejecutando la función: Socio A (documento
 * hasheado en `v1`, nunca re-hasheado — no existe herramienta de rehash de `padron_socio` en esta
 * etapa) y Socio B (alta nueva, ya en `v2`) conviven en el mismo padrón. Un movimiento real de Socio A,
 * capturado DESPUÉS de la rotación (`pepperIdActual()` ya daba `v2` al momento de la captura,
 * `packages/ingesta/src/contraparte.ts:67`), produce un candidato `v2` — cuyo HMAC nunca puede
 * coincidir con la fila de Socio A (que sigue en `v1`). La regla anterior daba `alineado: true` porque
 * Socio B "cubría" el `v2` del candidato — y el movimiento de Socio A resolvía **`es_tercero_padron_
 * completo`**, la conversión silenciosa de socio en proveedor que toda esta regla existe para impedir.
 *
 * La regla de uniformidad es deliberadamente MÁS estricta que "alcanza con que alguna fila comparta
 * pepper": mientras el padrón no esté 100% re-hasheado a una sola versión, CUALQUIER resolución negativa
 * es sospechosa (no se puede descartar que el socio real esté "atrapado" en la versión vieja), así que
 * todo el lote pasa a `pepper_desalineado` — decisión humana, nunca una conversión automática. El costo
 * es más trabajo manual durante una rotación en curso; el error que evita es plata de un socio real
 * mal imputada. Mismo criterio de costo asimétrico que `contador-dominio` fijó para el gate de padrón
 * completo (Ronda 1).
 */
function alinearPepper(
  candidatos: readonly CandidatoDeContraparte[],
  socios: readonly SocioDelPadron[],
): ResultadoAlineacionPepper {
  if (socios.length === 0) return { alineado: true };

  const pepperIdsPadron = new Set(socios.map((s) => s.pepperId));
  const pepperIdsCandidatos = new Set(candidatos.map((c) => c.pepperId));
  const pepperIdsEnJuego = new Set([...pepperIdsPadron, ...pepperIdsCandidatos]);

  if (pepperIdsEnJuego.size > 1) {
    return {
      alineado: false,
      pepperIdsCandidatos: [...pepperIdsCandidatos],
      pepperIdsPadron: [...pepperIdsPadron],
    };
  }
  return { alineado: true };
}

/**
 * Resuelve la contraparte de UN movimiento (0..N candidatos — la satélite es 0..N por diseño, no
 * batch: mismo patrón que `extraerCandidatosDeContraparte`, `packages/ingesta/src/contraparte.ts`).
 *
 * `padronDeclaradoCompleto`: el gate exigido por `contador-dominio` (Ronda 1) — sin él, "no
 * matcheó" nunca se propone automáticamente como tercero (`04-imputacion-contable.md:270`: "sin
 * padrón consultado, 'no es socio' no es una conclusión: es ausencia de control").
 */
export function resolverContraparte(
  candidatosDelMovimiento: readonly CandidatoDeContraparte[],
  padron: PadronConsultado,
  fechaDelMovimiento: string,
  padronDeclaradoCompleto: boolean,
): ResolucionDeContraparte {
  // (1) Sin candidatos: no hay nada que comparar.
  if (candidatosDelMovimiento.length === 0) {
    return { estado: 'sin_candidatos' };
  }

  const socios = padron.socios;

  // (2) Alineación de pepper — ANTES de buscar cualquier match. Un HMAC comparado bajo peppers
  //     distintos nunca puede dar un match verdadero (son dominios de hash distintos): hacer la
  //     búsqueda igual escondería el problema real bajo un resultado que PARECE "no es socio".
  const alineacion = alinearPepper(candidatosDelMovimiento, socios);
  if (!alineacion.alineado) {
    return {
      estado: 'pepper_desalineado',
      pepperIdsCandidatos: alineacion.pepperIdsCandidatos,
      pepperIdsPadron: alineacion.pepperIdsPadron,
    };
  }

  // (3) Búsqueda de matches — contra TODO el padrón, vigente o no. Filtrar por vigencia acá haría
  //     `socio_fuera_de_vigencia` estructuralmente inalcanzable. Comparación timing-safe.
  //     Nota de propiedad: un candidato 'dni'/'cbu' nunca puede matchear — `hmacDocumento` canoniza
  //     'cuit'/'cuil' al dominio 'cuit_cuil' y `padron_socio` solo admite ese dominio; no hace
  //     falta filtrar por `clase` a mano, sale gratis del diseño del hash.
  const matches: Array<{ candidato: CandidatoDeContraparte; socio: SocioDelPadron }> = [];
  for (const candidato of candidatosDelMovimiento) {
    for (const socio of socios) {
      if (socio.pepperId === candidato.pepperId && hmacIguales(socio.documentoHmac, candidato.hmac)) {
        matches.push({ candidato, socio });
      }
    }
  }

  // (4) Ningún candidato matcheó ninguna fila (vigente o no) → rama negativa, decide el gate.
  if (matches.length === 0) {
    return padronDeclaradoCompleto
      ? { estado: 'es_tercero_padron_completo' }
      : { estado: 'sin_match_padron_incompleto' };
  }

  // (5) Hay evidencia positiva. Filtro de vigencia semiabierta [vigenteDesde, vigenteHasta) a la
  //     fecha DEL MOVIMIENTO, nunca a hoy.
  const enVigencia = (s: SocioDelPadron): boolean =>
    s.vigenteDesde <= fechaDelMovimiento && (s.vigenteHasta === null || fechaDelMovimiento < s.vigenteHasta);

  const vigentes = matches.filter((m) => enVigencia(m.socio));

  // (6) Hubo match(es), pero ninguno vigente a la fecha → evidencia real e inconsistente con la
  //     fecha. Nunca se reinterpreta como "es tercero": hay evidencia, la fecha la contradice, un
  //     tercero no tiene evidencia.
  if (vigentes.length === 0) {
    const fueraDeVigencia: MatchFueraDeVigencia[] = matches.map((m) => ({
      socioId: m.socio.socioId,
      clase: m.candidato.clase,
      vigenteDesde: m.socio.vigenteDesde,
      vigenteHasta: m.socio.vigenteHasta,
    }));
    return { estado: 'socio_fuera_de_vigencia', matches: fueraDeVigencia };
  }

  // (7) Entre los vigentes, ¿matchean socios DISTINTOS? — 0..N candidatos por movimiento pueden
  //     matchear, cada uno, contra un socio vigente distinto, legítimamente. Nunca se elige el más
  //     probable: se listan todos y va a decisión humana.
  const socioIdsDistintos = new Set(vigentes.map((m) => m.socio.socioId));
  const evidenciaVigente: MatchDeContraparte[] = vigentes.map((m) => ({
    socioId: m.socio.socioId,
    clase: m.candidato.clase,
  }));

  if (socioIdsDistintos.size > 1) {
    return { estado: 'multiples_socios', matches: evidenciaVigente };
  }

  // (8) Un solo socio vigente (socioIdsDistintos.size === 1, ya descartados 0 y >1 arriba) —
  //     único caso que promueve directo, sin gate: un match es evidencia real sin importar si el
  //     padrón está completo.
  return { estado: 'es_socio', socioId: [...socioIdsDistintos][0] as string, matches: evidenciaVigente };
}
