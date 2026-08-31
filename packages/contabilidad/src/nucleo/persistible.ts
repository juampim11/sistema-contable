/**
 * DE LA UNIÓN DISCRIMINADA A LA FILA — el mapeo que `0014` persiste.
 *
 * Vive acá y no en `packages/data` por decisión de `arquitecto-software` (Ronda 1): `data` no puede
 * importar `contabilidad` (R-A, y el barrido es de TEXTO, así que `import type` tampoco), de modo que
 * mapear allá forzaría un espejo sobre un TIPO SUMA — y el mecanismo de R-H/R-H bis compara presencia
 * de nombres por substring, que no puede verificar que `sin_reconocer` lleve `candidatos` ni que
 * `decision_humana` lleve `queDecide`. Sería un espejo NO verificado con la ceremonia de uno
 * verificado, que es peor que no tenerlo. Acá el árbitro es el compilador: `switch` exhaustivo con
 * chequeo `never`.
 *
 * Lo que queda del lado de `data` es solo el PEDIDO —una lista plana de escalares, igual que
 * `PedidoDeAltaDeSocio`— y el adaptador entre los dos vive en `apps/cli`, la única capa que importa
 * los dos paquetes. R-K (`packages/data/tests/reglas-de-codigo.test.ts`) vigila que las dos listas de
 * nombres no diverjan; sobre una lista plana, el substring sí alcanza.
 *
 * 🔴 ESTE ARCHIVO ENTRA A LA HUELLA DE `VERSION_DEL_MOTOR` (`scripts/version-del-motor.ts`), y tiene
 * que entrar: no cambia lo que `reconocer()` devuelve, pero sí lo que se ESCRIBE para un mismo digest
 * — o sea que un cambio acá rompe la promesa "mismo digest ⇒ misma fila" sobre la que se apoya el
 * no-op de `05` §5.2. Entra solo porque la huella es por exclusión; con una lista de nombres habría
 * nacido olvidado.
 *
 * Puro y síncrono (R-J). Sin comparación de texto libre (R-E): la PERTENENCIA de un id se verifica con
 * `Set.has`, nunca con un barrido sobre el id.
 */

import type { ConceptoCanonico } from './catalogo.ts';
import type { LexicoDeBanco } from './lexico.ts';
import type { Reconocimiento } from './reconocimiento.ts';
import type {
  ClaseDeReconocimiento,
  Lado,
  MotivoSinReconocer,
  Polaridad,
  QueDecide,
  TipoMovimiento,
  ViaEvidencia,
} from './tipos.ts';

// -----------------------------------------------------------------------------
// El id del léxico: PERTENENCIA, no forma
// -----------------------------------------------------------------------------

/**
 * 🔴 `EntradaLexico['id']` es `string` A SECAS (`lexico.ts:66`), así que tipar el campo con ese alias
 * NO RESTRINGE NADA: `'galicia.' + tokenDeLaGlosa` compila igual. El hallazgo de
 * `seguridad-datos-financieros` (Ronda 1) es correcto —el check de la base verifica FORMA, no
 * PERTENENCIA— pero la protección que pedía, implementada como estaba escrita, no protege.
 *
 * Esta marca sí: el único constructor es `idDelLexico()`, que exige que el id ESTÉ en el léxico del
 * banco. Mismo idiom que `ContextoAuditado` (`packages/data/src/db/auditoria.ts`) y `PadronConsultado`
 * (`contrapartida.ts`).
 */
declare const marcaIdDeLexico: unique symbol;
export type IdDeEntradaLexico = string & { readonly [marcaIdDeLexico]: true };

export const CODIGO_ID_LEXICO_DESCONOCIDO = 'RECON_ID_LEXICO_DESCONOCIDO' as const;

/**
 * 🔴 EL MENSAJE NO LLEVA EL ID. Si el id llegó armado con tokens de la glosa —el bug de una línea que
 * esta guarda existe para atajar— meterlo en el mensaje lo filtra al log, al stderr y al historial de
 * la terminal: el escenario exacto, reintroducido por el error que lo reporta. El código alcanza para
 * depurar, y el llamador ya sabe qué movimiento estaba procesando.
 */
export class IdDeLexicoDesconocidoError extends Error {
  // Asignada a mano, no como parameter property: el type-stripping de Node no las soporta.
  readonly codigo = CODIGO_ID_LEXICO_DESCONOCIDO;

  constructor() {
    super(
      'Un id de entrada del léxico no pertenece al léxico del banco. Un id que aparece en la ' +
        'evidencia pero no en el léxico solo puede haber sido construido, y lo que se construye a ' +
        'partir de la glosa lleva adentro el dato del tercero.',
    );
    this.name = 'IdDeLexicoDesconocidoError';
  }
}

/** El conjunto se arma UNA vez por banco, no por movimiento: un lote son miles de filas. */
export function idsDelLexico(lexico: LexicoDeBanco): ReadonlySet<string> {
  const salida = new Set<string>();
  for (const entrada of lexico.entradas) salida.add(entrada.id);
  return salida;
}

function idDelLexico(id: string, validos: ReadonlySet<string>): IdDeEntradaLexico {
  if (!validos.has(id)) throw new IdDeLexicoDesconocidoError();
  return id as IdDeEntradaLexico;
}

// -----------------------------------------------------------------------------
// "Capa C ya corrió" como tipo, no como convención
// -----------------------------------------------------------------------------

/**
 * La tabla es append-oriented y capa C REESCRIBE `clase` y `tipo` (`motor.ts:145-166`). Escribir el
 * resultado de capa B y "arreglarlo" después obligaría a cambiar `clase`, lo que flipearía la columna
 * generada `es_propuesta` y satisfaría EN SILENCIO la FK de tres columnas que `05` §5.1 diseñó para
 * impedir que un pendiente tenga un asiento colgado. Por eso se escribe UNA vez, después de las dos
 * capas.
 *
 * Sin esta marca, esa restricción vive en un párrafo del plan: hoy `reconocer()` y
 * `aplicarContrapartida()` devuelven el MISMO tipo y nada distingue el antes del después. Mismo idiom
 * y mismo motivo que `PadronConsultado`: no es infalible —cualquiera puede llamar al constructor—
 * pero convierte un supuesto invisible en una línea visible y greppable.
 */
declare const marcaCapaCCorrida: unique symbol;
export type ReconocimientoFinal = {
  readonly [marcaCapaCCorrida]: true;
  readonly reconocimiento: Reconocimiento;
};

/** El ÚNICO lugar del monorepo donde se construye un `ReconocimientoFinal`. Se llama inmediatamente
 *  después de `aplicarContrapartida()`, nunca antes. */
export function marcarCapaCCorrida(reconocimiento: Reconocimiento): ReconocimientoFinal {
  return { reconocimiento } as unknown as ReconocimientoFinal;
}

// -----------------------------------------------------------------------------
// La fila
// -----------------------------------------------------------------------------

/**
 * Espejo 1:1 de las columnas de `reconocimiento_movimiento` (`0014`), más los candidatos que van a la
 * satélite. Escalares y un array de ids — nada anidado.
 *
 * 🔴 NO lleva descripción, ni importe, ni fecha, ni contraparte, ni la cola de un `prefijo_con_cola`
 * (`05` §6). Ninguna fila de esta tabla contiene un dato del cliente.
 *
 * ⚠️ NO lleva la evidencia de contrapartida (`evidenciaContrapartida`, los 7 estados de
 * `ResolucionDeContraparte`). El RESULTADO de capa C sí queda persistido —está en `clase` y `tipo`,
 * porque la promoción los reescribe— pero el POR QUÉ no: esas columnas las crea `0015`. Es una pérdida
 * REAL y declarada, no un olvido: hasta `0015`, la cola de revisión va a poder decir *qué* propuso el
 * motor pero no *con qué evidencia de contrapartida*, y los cinco estados que NO promueven quedan
 * indistinguibles entre sí. Se acepta porque `0014` es útil y revertible solo, y porque el
 * determinante de capa C (el estado del padrón) tampoco existe hasta `0015`.
 */
export type FilaDeReconocimiento = {
  readonly clase: ClaseDeReconocimiento;
  readonly tipo: TipoMovimiento | null;
  readonly concepto: ConceptoCanonico | null;
  readonly polaridad: Polaridad | null;
  readonly lado: Lado | null;
  readonly via: ViaEvidencia | null;
  readonly queDecide: QueDecide | null;
  readonly motivoCodigo: MotivoSinReconocer | null;
  readonly entradaLexicoId: IdDeEntradaLexico | null;
  /** Longitud del LITERAL del léxico que matcheó, no de la glosa: es propiedad de la entrada. */
  readonly caracteresMatcheados: number | null;
  /** ⚠️ El nombre engaña: `motor.ts:67` lo calcula como `entrada.matcheo.modo === 'prefijo_con_cola'`,
   *  o sea "la entrada ADMITE cola", no "esta glosa TRAJO cola". Cero información del movimiento —
   *  importa para que sea N1 y no N2. */
  readonly huboCola: boolean | null;
  /** Ids del léxico (`matcher.ts` devuelve las claves del índice), nunca literales ni glosa. */
  readonly candidatos: readonly IdDeEntradaLexico[];
};

/** El chequeo de exhaustividad. Va como parámetro y no como `const _x: never = r` porque
 *  `noUnusedLocals` rechaza lo segundo. Precedente: el `switch` de `aplicarContrapartida`. */
function jamas(_imposible: never, codigo: string): never {
  throw new Error(codigo);
}

/**
 * La única función que convierte un `Reconocimiento` en algo escribible.
 *
 * 🔴 NO recibe el id del léxico como parámetro, y eso es la mitad de la guarda: sale de
 * `r.evidencia.entradaLexicoId`, que solo puede haber salido de `motor.ts:64` (`entrada.id`). No hay
 * costura por donde entre un string armado. La otra mitad es `idDelLexico()`, que verifica PERTENENCIA.
 */
export function aFilaPersistible(
  final: ReconocimientoFinal,
  validos: ReadonlySet<string>,
): FilaDeReconocimiento {
  const r = final.reconocimiento;

  switch (r.clase) {
    case 'propuesta':
      return {
        clase: r.clase,
        tipo: r.tipo,
        concepto: r.concepto,
        polaridad: r.polaridad,
        lado: r.lado,
        via: r.via,
        queDecide: null,
        motivoCodigo: null,
        entradaLexicoId: idDelLexico(r.evidencia.entradaLexicoId, validos),
        caracteresMatcheados: r.evidencia.caracteresMatcheados,
        huboCola: r.evidencia.huboCola,
        candidatos: [],
      };

    case 'decision_humana':
      return {
        clase: r.clase,
        tipo: r.tipo,
        concepto: r.concepto,
        polaridad: r.polaridad,
        lado: r.lado,
        via: r.via,
        queDecide: r.queDecide,
        motivoCodigo: null,
        entradaLexicoId: idDelLexico(r.evidencia.entradaLexicoId, validos),
        caracteresMatcheados: r.evidencia.caracteresMatcheados,
        huboCola: r.evidencia.huboCola,
        candidatos: [],
      };

    case 'sin_reconocer':
      return {
        clase: r.clase,
        tipo: null,
        concepto: null,
        polaridad: null,
        lado: null,
        // `evidencia` es OPCIONAL en esta rama y depende del MOTIVO: ausente en `ambiguo`,
        // `concepto_no_catalogado` y `sin_evidencia_de_concepto`; presente en
        // `concepto_sin_tipo_asignado` y `reversa_incoherente`. La ausencia se representa con null,
        // nunca se rellena con un id inventado — `reconocimiento_forma_chk` de 0014 la exige exacta.
        // `via` vive DENTRO de `evidencia` en esta rama (a diferencia de `propuesta`/
        // `decision_humana`, que la tienen a nivel raíz): un `via: null` incondicional dejaba la fila
        // con evidencia a medias (3 de 4 no-nulas) cuando el motivo SÍ trae evidencia, y
        // `reconocimiento_forma_chk` la rechazaba entera.
        via: r.evidencia ? r.evidencia.via : null,
        queDecide: null,
        motivoCodigo: r.motivo,
        entradaLexicoId: r.evidencia ? idDelLexico(r.evidencia.entradaLexicoId, validos) : null,
        caracteresMatcheados: r.evidencia ? r.evidencia.caracteresMatcheados : null,
        huboCola: r.evidencia ? r.evidencia.huboCola : null,
        candidatos: r.candidatos.map((c) => idDelLexico(c, validos)),
      };

    default:
      return jamas(r, 'CLASE_DE_RECONOCIMIENTO_NO_CONTEMPLADA');
  }
}
