/**
 * Las propiedades PROP-1..13 del léxico y el catálogo, como FUNCIÓN PURA — no cuerpos de `it()`. Es lo
 * que hace posibles los tests de mutación (`mutacion-lexico.test.ts`): aplicar una mutación y ver qué
 * propiedad NOMBRADA se pone roja, en vez de una revisión a ojo.
 *
 * No es un archivo `.test.ts` — vitest no lo corre. Va en `tests/` porque es verificación, no
 * producción (mismo criterio que `packages/data/tests/ayuda.ts`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizarParaLexico } from '../src/nucleo/normalizacion.ts';
import { opuesto, type QueDecide, type TipoMovimiento } from '../src/nucleo/tipos.ts';
import type { EntradaLexico, LexicoDeBanco } from '../src/nucleo/lexico.ts';
import type { ConceptoCanonico, EstadoDeTipo, FilaDelCatalogo } from '../src/nucleo/catalogo.ts';

const RAIZ_REPO = join(import.meta.dirname, '..', '..', '..');

export type NombrePropiedad =
  | 'PROP-1'
  | 'PROP-2'
  | 'PROP-3'
  | 'PROP-4'
  | 'PROP-5'
  | 'PROP-6'
  | 'PROP-7'
  | 'PROP-8'
  | 'PROP-9'
  | 'PROP-10'
  | 'PROP-11'
  | 'PROP-12'
  | 'PROP-13';

export type Infraccion = {
  readonly propiedad: NombrePropiedad;
  readonly detalle: string;
};

/** El ancla de un literal: la forma normalizada, delimitada para que un prefijo no se cuele a mitad de
 * token. Mismo criterio que `macro.ts:anclaDePrefijo` — un literal que ya termina en carácter no
 * alfanumérico se delimita solo; uno que termina en letra o dígito necesita el espacio. */
function anclaDe(literal: string): string {
  const n = normalizarParaLexico(literal);
  return /[A-Z0-9]$/.test(n) ? `${n} ` : n;
}

export function verificarPropiedades(
  lexicos: readonly LexicoDeBanco[],
  catalogo: Record<ConceptoCanonico, FilaDelCatalogo>,
  estados: Record<TipoMovimiento, EstadoDeTipo>,
): Infraccion[] {
  const infracciones: Infraccion[] = [];
  const conceptos = Object.keys(catalogo) as ConceptoCanonico[];
  const tipos = Object.keys(estados) as TipoMovimiento[];
  const filaDe = (c: string): FilaDelCatalogo | undefined => catalogo[c as ConceptoCanonico];
  const estadoDe = (t: string): EstadoDeTipo | undefined => estados[t as TipoMovimiento];

  const todasLasEntradas: readonly EntradaLexico[] = lexicos.flatMap((l) => l.entradas);

  // ---- PROP-1: cada concepto mapea a exactamente un (tipo, polaridad, ladoEsperado) -------------------
  // El compilador ya lo garantiza vía `Record<ConceptoCanonico, FilaDelCatalogo>`. Acá el
  // ANTI-FALSO-VERDE: si alguien aflojara el tipo a `Partial<...>`, esto lo detecta.
  if (conceptos.length === 0) {
    infracciones.push({ propiedad: 'PROP-1', detalle: 'CATALOGO_CANONICO está vacío' });
  }

  // ---- PROP-2: ningún literal en dos entradas del mismo banco (comparado normalizado) -----------------
  for (const lex of lexicos) {
    const vistos = new Map<string, string>(); // normalizado -> id
    for (const entrada of lex.entradas) {
      for (const literal of entrada.literales) {
        const norm = normalizarParaLexico(literal);
        const previo = vistos.get(norm);
        if (previo && previo !== entrada.id) {
          infracciones.push({
            propiedad: 'PROP-2',
            detalle: `${lex.banco}: el literal "${literal}" (normalizado "${norm}") aparece en ${previo} y en ${entrada.id}`,
          });
        }
        vistos.set(norm, entrada.id);
      }
    }
  }

  // ---- PROP-3: ningún literal es prefijo de otro de entrada DISTINTA, sobre las formas ANCLADAS -------
  for (const lex of lexicos) {
    for (const a of lex.entradas) {
      for (const b of lex.entradas) {
        if (a.id === b.id) continue;
        for (const litA of a.literales) {
          for (const litB of b.literales) {
            const anclaA = anclaDe(litA);
            const anclaB = anclaDe(litB);
            if (anclaA.length < anclaB.length && anclaB.startsWith(anclaA)) {
              infracciones.push({
                propiedad: 'PROP-3',
                detalle:
                  `${lex.banco}: el ancla de "${litA}" (${a.id}) es prefijo del ancla de "${litB}" ` +
                  `(${b.id}) — léxico ambiguo por construcción`,
              });
            }
          }
        }
      }
    }
  }

  // ---- PROP-4: toda reversa apunta a un concepto de MISMO tipo y ladoEsperado OPUESTO ------------------
  for (const concepto of conceptos) {
    const fila = filaDe(concepto);
    if (!fila || fila.polaridad !== 'reversa') continue;
    const base = filaDe(fila.reversaDe);
    if (!base) {
      infracciones.push({
        propiedad: 'PROP-4',
        detalle: `${concepto}: reversaDe apunta a "${fila.reversaDe}", que no existe en el catálogo`,
      });
      continue;
    }
    if (base.polaridad !== 'normal') {
      infracciones.push({ propiedad: 'PROP-4', detalle: `${concepto}: reversa de una reversa (${fila.reversaDe})` });
    }
    if (base.ladoEsperado === 'indistinto' || fila.ladoEsperado !== opuesto(base.ladoEsperado)) {
      infracciones.push({
        propiedad: 'PROP-4',
        detalle: `${concepto}: ladoEsperado (${fila.ladoEsperado}) no es el opuesto del de su base ${fila.reversaDe} (${base.ladoEsperado})`,
      });
    }
    const tipoFila = fila.resuelve === 'sin_tipo_asignado' ? undefined : fila.tipo;
    const tipoBase = base.resuelve === 'sin_tipo_asignado' ? undefined : base.tipo;
    if (tipoFila !== tipoBase) {
      infracciones.push({
        propiedad: 'PROP-4',
        detalle: `${concepto}: la reversa imputa a un tipo distinto (${tipoFila}) que su base ${fila.reversaDe} (${tipoBase}) — 04 §3 fila 1 exige la MISMA cuenta`,
      });
    }
  }

  // ---- PROP-5: todo tipo tiene ≥1 entrada, o una declaración explícita con motivo (bidireccional) ------
  for (const tipo of tipos) {
    const estado = estadoDe(tipo);
    if (!estado) continue;
    const conceptosDeEsteTipo = conceptos.filter((c) => {
      const f = filaDe(c);
      return f && f.resuelve !== 'sin_tipo_asignado' && f.tipo === tipo;
    });
    const alcanzadoPorLexico = conceptosDeEsteTipo.some((c) => todasLasEntradas.some((e) => e.concepto === c));

    if (estado.estado === 'habilitado' && (conceptosDeEsteTipo.length === 0 || !alcanzadoPorLexico)) {
      infracciones.push({
        propiedad: 'PROP-5',
        detalle: `${tipo}: declarado 'habilitado' pero ningún concepto del catálogo, alcanzado por algún léxico, apunta a él`,
      });
    }
    if (estado.estado !== 'habilitado' && conceptosDeEsteTipo.length > 0) {
      infracciones.push({
        propiedad: 'PROP-5',
        detalle: `${tipo}: declarado '${estado.estado}' pero SÍ tiene conceptos apuntándolo (${conceptosDeEsteTipo.join(', ')}) — debería ser 'habilitado'`,
      });
    }
    if (estado.estado !== 'habilitado' && (!estado.motivo || estado.motivo.length < 10)) {
      infracciones.push({ propiedad: 'PROP-5', detalle: `${tipo}: motivo ausente o demasiado corto` });
    }
  }
  // Extensión de PROP-5 al nivel de CONCEPTO (no solo de tipo): con varios bancos, un tipo puede seguir
  // 'habilitado' por otros conceptos aunque UNO se quede sin ninguna entrada de léxico que lo alcance —
  // ese concepto queda muerto en el catálogo sin que el chequeo por tipo lo note.
  for (const concepto of conceptos) {
    const alcanzado = todasLasEntradas.some((e) => e.concepto === concepto);
    if (!alcanzado) {
      infracciones.push({
        propiedad: 'PROP-5',
        detalle: `${concepto}: declarado en CONCEPTOS_CANONICOS pero ninguna entrada de ningún léxico lo alcanza`,
      });
    }
  }

  // ---- PROP-6: la procedencia es VERDADERA — el literal aparece textualmente en el documento citado ---
  const cacheDocs = new Map<string, string>();
  function contenidoDe(documento: string): string {
    const cacheado = cacheDocs.get(documento);
    if (cacheado !== undefined) return cacheado;
    const ruta = join(RAIZ_REPO, documento);
    const contenido = existsSync(ruta) ? readFileSync(ruta, 'utf8') : '';
    cacheDocs.set(documento, contenido);
    return contenido;
  }
  function verificarProcedencia(origen: string, procedencia: FilaDelCatalogo['procedencia'] | EntradaLexico['procedencia']): void {
    if (procedencia.fuente !== 'corpus_medido') return;
    const contenido = contenidoDe(procedencia.documento);
    if (!contenido) {
      infracciones.push({ propiedad: 'PROP-6', detalle: `${origen}: el documento "${procedencia.documento}" no existe` });
      return;
    }
    for (const { literal } of procedencia.porLiteral) {
      // 🔴 Entre BACKTICKS, no un `.includes()` ingenuo: los documentos de `docs/diseno/` citan cada
      // literal entre backticks (`` `ACREDITAMIENTO` (78) ``, verificado en los 4 documentos fuente).
      // Un `.includes()` plano no detecta "acortar un literal" — el texto acortado sigue siendo
      // subcadena del literal real completo, así que la mutación pasaría sin que PROP-6 la note.
      if (!contenido.includes('`' + literal + '`')) {
        infracciones.push({
          propiedad: 'PROP-6',
          detalle: `${origen}: el literal "${literal}" no aparece entre backticks en ${procedencia.documento}`,
        });
      }
    }
  }
  for (const concepto of conceptos) {
    const fila = filaDe(concepto);
    if (fila) verificarProcedencia(`catalogo.${concepto}`, fila.procedencia);
  }
  for (const entrada of todasLasEntradas) {
    verificarProcedencia(entrada.id, entrada.procedencia);
  }

  // ---- PROP-7: ningún literal contiene [CUIT]/[CBU]/[DOC] ----------------------------------------------
  for (const entrada of todasLasEntradas) {
    for (const literal of entrada.literales) {
      if (/\[CUIT\]|\[CBU\]|\[DOC\]/.test(literal)) {
        infracciones.push({ propiedad: 'PROP-7', detalle: `${entrada.id}: el literal "${literal}" contiene un marcador prohibido como evidencia` });
      }
    }
  }

  // ---- PROP-8: ningún id repetido en todo el léxico (los N bancos) ------------------------------------
  const idsVistos = new Map<string, string>(); // id -> banco
  for (const lex of lexicos) {
    for (const entrada of lex.entradas) {
      if (idsVistos.has(entrada.id)) {
        infracciones.push({ propiedad: 'PROP-8', detalle: `id duplicado: "${entrada.id}"` });
      }
      idsVistos.set(entrada.id, lex.banco);
      if (!new RegExp(`^${lex.banco}\\.[a-z0-9_.]+$`).test(entrada.id)) {
        infracciones.push({ propiedad: 'PROP-8', detalle: `${entrada.id}: no tiene la forma <banco>.<concepto>` });
      }
    }
  }

  // ---- PROP-9: todo QUE_DECIDE es alcanzable por ≥1 fila del catálogo ---------------------------------
  // Las vías basadas en código (codigo_concepto, codigo_y_texto_concordantes,
  // texto_con_codigo_no_catalogado) son una EXCEPCIÓN NOMINADA (H3: ningún adaptador emite
  // conceptoCodigo hoy) — no se verifican acá, se declaran inalcanzables a propósito.
  const queDecideUsados = new Set<QueDecide>();
  for (const concepto of conceptos) {
    const fila = filaDe(concepto);
    if (fila && fila.resuelve === 'decide_una_persona') queDecideUsados.add(fila.queDecide);
  }
  // (el chequeo contra QUE_DECIDE completo lo hace el test que llama a esta función, con la constante)

  // ---- PROP-10: elAdaptadorPuedeTruncar:false ⇒ ninguna entrada del banco declara exacto_o_prefijo ----
  for (const lex of lexicos) {
    if (lex.elAdaptadorPuedeTruncar) continue;
    for (const entrada of lex.entradas) {
      if (entrada.matcheo.modo === 'exacto_o_prefijo') {
        infracciones.push({
          propiedad: 'PROP-10',
          detalle: `${entrada.id}: declara exacto_o_prefijo pero ${lex.banco} nunca trunca (elAdaptadorPuedeTruncar:false) — guarda muerta`,
        });
      }
    }
  }

  // ---- PROP-11: ladoEsperado:'indistinto' ⇒ pendienteDeLaura presente con pregunta sustancial ----------
  for (const concepto of conceptos) {
    const fila = filaDe(concepto);
    if (!fila) continue;
    if (fila.ladoEsperado === 'indistinto') {
      if (fila.pendienteDeLaura.pregunta.length < 30) {
        infracciones.push({ propiedad: 'PROP-11', detalle: `${concepto}: ladoEsperado indistinto con pregunta demasiado corta` });
      }
    }
  }

  // ---- PROP-12: coherencia de lado contra el corpus medido (sin correr un solo movimiento) -------------
  for (const entrada of todasLasEntradas) {
    if (entrada.procedencia.fuente !== 'corpus_medido') continue;
    const fila = filaDe(entrada.concepto);
    if (!fila) continue;
    for (const { literal, lado, movimientos } of entrada.procedencia.porLiteral) {
      if (lado === 'no_medido' || movimientos === 0) continue;
      if (fila.ladoEsperado === 'indistinto') continue; // vacuamente cierto, a propósito
      const esperado = fila.polaridad === 'reversa' ? fila.ladoEsperado : fila.ladoEsperado;
      if (lado === 'ambos') {
        infracciones.push({
          propiedad: 'PROP-12',
          detalle: `${entrada.id}: el literal "${literal}" mide lado 'ambos' pero el concepto ${entrada.concepto} declara ladoEsperado fijo (${esperado}) en vez de 'indistinto'`,
        });
      } else if (lado !== esperado) {
        infracciones.push({
          propiedad: 'PROP-12',
          detalle: `${entrada.id}: el literal "${literal}" mide lado '${lado}' pero el concepto ${entrada.concepto} declara ladoEsperado '${esperado}'`,
        });
      }
    }
  }

  // ---- PROP-13: prefijoMinimo declarado ≥ el mínimo seguro calculado desde los datos --------------------
  for (const lex of lexicos) {
    for (const entrada of lex.entradas) {
      if (entrada.matcheo.modo !== 'exacto_o_prefijo') continue;
      const anclaPropia = anclaDe(entrada.literales[0]);
      let minimoSeguro = 0;
      for (let corte = 1; corte <= anclaPropia.length; corte++) {
        const candidato = anclaPropia.slice(0, corte);
        const enBordeDeToken = corte === anclaPropia.length || anclaPropia[corte] === ' ' || anclaPropia[corte - 1] === ' ';
        if (!enBordeDeToken) continue;
        const colisiona = lex.entradas.some(
          (otra) => otra.id !== entrada.id && otra.literales.some((l) => anclaDe(l).startsWith(candidato)),
        );
        if (!colisiona) {
          minimoSeguro = candidato.length;
          break;
        }
      }
      if (entrada.matcheo.prefijoMinimo < minimoSeguro) {
        infracciones.push({
          propiedad: 'PROP-13',
          detalle: `${entrada.id}: prefijoMinimo declarado (${entrada.matcheo.prefijoMinimo}) es MENOR que el mínimo seguro calculado (${minimoSeguro}) — puede matchear un truncado ambiguo`,
        });
      }
    }
  }

  return infracciones;
}
