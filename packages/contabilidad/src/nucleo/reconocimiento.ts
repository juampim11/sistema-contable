import type {
  ClaseDeReconocimiento,
  Lado,
  MotivoSinReconocer,
  Polaridad,
  QueDecide,
  TipoMovimiento,
  ViaEvidencia,
} from './tipos.ts';
import type { ConceptoCanonico } from './catalogo.ts';
import type { PendienteDeLaura } from './lexico.ts';
import type { ResolucionDeContraparte } from './contrapartida.ts';
import type { EvidenciaDeContraparte } from './contraparte.ts';

/**
 * La entrada del motor.
 *
 * 🔴 NO TIENE `descripcion`, NI `importe`, NI contraparte, NI identificadores. Eso no es economía: es
 * la regla dura de `05` §3 hecha IMPOSIBLE en vez de detectable. Un barrido de texto (R-E) detecta un
 * `includes` sobre la glosa; un tipo de entrada sin glosa hace que no compile.
 *
 * Espejo de `movimientoBancarioCrudoSchema` (`packages/ingesta/src/esquema.ts`) — duplicado porque
 * `contabilidad` no puede importar `ingesta`. El árbitro mientras no exista la migración 0014 es R-H
 * (`packages/data/tests/reglas-de-codigo.test.ts`).
 */
export type EvidenciaDeMovimiento = {
  readonly bancoCodigo: string;
  readonly conceptoBanco: string | undefined;
  readonly conceptoCompleto: boolean | undefined;
  readonly conceptoBancoEstrategia: 'segmento_de_glosa' | 'prefijo_anclado' | 'columna_propia' | undefined;
  /** Hoy siempre `undefined`: ningún adaptador del roster lo emite (H3). */
  readonly conceptoCodigo: string | undefined;
  /** `lado = columnaOrigen === 'credito' ? 'haber' : 'debe'` (04 §2). */
  readonly columnaOrigen: 'credito' | 'debito';
};

/** Lo que se guarda como prueba. Ids del léxico, nunca texto (`05` §6). */
export type EvidenciaDelMatch = {
  readonly entradaLexicoId: string;
  readonly via: ViaEvidencia;
  readonly caracteresMatcheados: number;
  readonly huboCola: boolean;
};

/**
 * 🔴 Los tres discriminantes se DERIVAN de `CLASES_RECONOCIMIENTO` (`tipos.ts`) con `Extract`, no se
 * escriben a mano. `Extract` no es decorativo: si alguien borra un valor de la constante, el `Extract`
 * correspondiente colapsa a `never` y ESTA variante deja de ser construible — el error aparece acá, en
 * el tipo, y no como una fila rechazada por `reconocimiento_clase_chk` en runtime.
 */
export type Reconocimiento =
  | {
      readonly clase: Extract<ClaseDeReconocimiento, 'propuesta'>;
      readonly tipo: TipoMovimiento;
      readonly concepto: ConceptoCanonico;
      readonly polaridad: Polaridad;
      readonly lado: Lado;
      readonly via: ViaEvidencia;
      readonly evidencia: EvidenciaDelMatch;
      /** Solo presente cuando `aplicarContrapartida` (capa C, `motor.ts`) promovió esta propuesta.
       *  Ausente en toda propuesta de capa B (reglas 1-9, 11, 14). */
      readonly evidenciaContrapartida?: ResolucionDeContraparte;
      /** SIEMPRE undefined en esta rama, verificado: `adjuntarEvidenciaDeContraparte` corta en
       *  `clase !== 'decision_humana'`, y para cuando se la llama sobre esta fila la promoción de
       *  `aplicarContrapartida` (si vino de `resolucion.estado === 'es_socio'`) ya ocurrió — el campo
       *  se declara igual, por paralelismo de forma con la rama de abajo, pero nunca se llena. La
       *  evidencia de `padron_contraparte` para las filas promovidas NO sale de este campo (ver
       *  `packages/data/src/contabilidad/escrituras.ts`: el pedido de persistencia la recibe de
       *  `resolucion.estado` directamente en `reconocer-lote.ts`, no de `Reconocimiento`). */
      readonly evidenciaContraparte?: EvidenciaDeContraparte;
    }
  | {
      readonly clase: Extract<ClaseDeReconocimiento, 'decision_humana'>;
      readonly tipo: TipoMovimiento;
      readonly concepto: ConceptoCanonico;
      readonly polaridad: Polaridad;
      readonly lado: Lado;
      readonly via: ViaEvidencia;
      readonly evidencia: EvidenciaDelMatch;
      readonly queDecide: QueDecide;
      readonly pendienteDeLaura?: PendienteDeLaura;
      /** Solo presente cuando `queDecide === 'distinguir_tercero_de_socio'` Y ya se corrió capa C.
       *  Es el "POR QUÉ" que la persona ve: uno de los 5 estados que no promueven. */
      readonly evidenciaContrapartida?: ResolucionDeContraparte;
      /** Hermano de `evidenciaContrapartida`, para `padron_contraparte` (0037). Solo presente
       *  cuando `queDecide === 'distinguir_tercero_de_socio'` — uno de `sin_match`/`match`/
       *  `multiples_patrones` (nunca `'no_aplica'` acá: ese estado implica `es_socio`, que ya
       *  promovió a `propuesta` antes de llegar a esta rama). */
      readonly evidenciaContraparte?: EvidenciaDeContraparte;
    }
  | {
      readonly clase: Extract<ClaseDeReconocimiento, 'sin_reconocer'>;
      readonly motivo: MotivoSinReconocer;
      readonly candidatos: readonly string[];
      readonly evidencia: EvidenciaDelMatch | undefined;
    };
