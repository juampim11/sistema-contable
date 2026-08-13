import type { ConceptoCanonico } from './catalogo.ts';

/**
 * Los tipos del léxico — SOLO tipos, cero datos. Espejo de la sección 1 del plan aprobado
 * (`adaptive-herding-pillow.md`).
 */

export type LiteralDelBanco = string;

/**
 * El lado MEDIDO de un literal en el corpus, con su tri-estado explícito.
 *
 * `no_medido` no es lo mismo que `ambos`: aplastarlos borra la única señal que valida el catálogo sin
 * etiquetas humanas (PROP-12). Mismo criterio que `no_capturado` en `CAPTURAS_CONTRAPARTE`
 * (`packages/ingesta/src/esquema.ts`): "no lo sé" es un valor, no la ausencia de valor.
 */
export type LadoMedido = 'debe' | 'haber' | 'ambos' | 'no_medido';

export type EvidenciaDeLiteral = {
  readonly literal: LiteralDelBanco;
  /** Frecuencia medida en el corpus. `0` es legítimo: vocabulario publicado sin movimientos. */
  readonly movimientos: number;
  readonly lado: LadoMedido;
};

/**
 * De dónde salió esta entrada. PROP-6 la exige VERDADERA: el literal citado tiene que aparecer
 * textualmente en el documento y sección declarados.
 */
export type Procedencia =
  | {
      readonly fuente: 'corpus_medido';
      readonly documento: string;
      readonly seccion: string;
      readonly porLiteral: readonly [EvidenciaDeLiteral, ...EvidenciaDeLiteral[]];
    }
  | { readonly fuente: 'anexo_del_banco'; readonly documento: string; readonly seccion: string }
  | { readonly fuente: 'etiquetado_de_laura'; readonly fecha: string; readonly nota: string }
  | { readonly fuente: 'inferido_del_vocabulario'; readonly porQue: string };

/**
 * El marcador de hipótesis abierta. NO es un booleano a propósito: un flag no dice qué se preguntó, y
 * la pregunta es el único entregable que la contadora puede responder.
 *
 * 🔴 Su presencia degrada la clase a `decision_humana` — nunca produce `clase: 'propuesta'`. Garantizado
 * en tres redes (tipo, choke point R-F, enumeración exhaustiva) — ver `tests/pendiente-laura.test.ts`.
 */
export type PendienteDeLaura = {
  readonly pregunta: string;
  readonly hipotesis: string;
  readonly referencia: string;
  readonly desde: string; // ISO
};

/**
 * Cómo puede matchear esta entrada. Cierra el conjunto de vías POR ENTRADA: una entrada que no admite
 * prefijo no puede caer en `prefijo_unico` ni por accidente ni por un cambio futuro del matcher.
 */
export type MatcheoDeEntrada =
  | { readonly modo: 'exacto' }
  | { readonly modo: 'exacto_o_prefijo'; readonly prefijoMinimo: number }
  | { readonly modo: 'prefijo_con_cola' };

export type EntradaLexico = {
  /** `<banco>.<concepto>[.<matiz>]`. Es lo que se guarda como evidencia (05 §6) — nunca el texto. */
  readonly id: string;
  readonly concepto: ConceptoCanonico;
  /** 2+ = sinónimos de UNA entrada (truncado, con/sin acento). Nunca dos conceptos distintos. */
  readonly literales: readonly [LiteralDelBanco, ...LiteralDelBanco[]];
  readonly matcheo: MatcheoDeEntrada;
  readonly procedencia: Procedencia;
  /** Si está, esta entrada NUNCA produce `clase: 'propuesta'`. */
  readonly pendienteDeLaura?: PendienteDeLaura;
};

export type LexicoDeBanco = {
  /** El `banco_codigo`. Duplicado del registro de adaptadores a propósito (R-B: sin dependencia). */
  readonly banco: string;
  /** Espejo de `ESTRATEGIAS_CONCEPTO` (`packages/ingesta/src/esquema.ts`). */
  readonly estrategiaDelAdaptador: 'segmento_de_glosa' | 'prefijo_anclado' | 'columna_propia';
  /**
   * ¿Este banco puede emitir `conceptoCompleto: false`? Con `false` acá, ninguna entrada del banco
   * puede declarar `exacto_o_prefijo` (PROP-10) — una guarda que nunca corre es una guarda que nadie
   * prueba.
   */
  readonly elAdaptadorPuedeTruncar: boolean;
  readonly entradas: readonly EntradaLexico[];
};
