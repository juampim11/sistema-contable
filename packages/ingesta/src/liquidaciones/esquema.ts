/**
 * VOCABULARIO DE UNA LIQUIDACIÓN DE ADQUIRENTE — commit 1 de 4 del plan 14.
 *
 * Fuente de verdad: `docs/diseno/14-liquidaciones-tarjeta-plan.md`, aprobado por JP. **Antes de tocar
 * este archivo o continuar con el commit 2, releer ese plan completo — no asumirlo de memoria.**
 *
 * ## Qué problema resuelve este módulo
 *
 * La acreditación de tarjeta llega al extracto bancario **neta** de arancel, IVA y retenciones, y esos
 * componentes no están en el extracto en ninguna forma: están en la liquidación del adquirente. El
 * catálogo canónico (`packages/contabilidad/src/nucleo/catalogo.ts`) ya tiene decenas de movimientos
 * con `queDecide: 'completar_con_liquidacion_del_adquirente'` esperando exactamente este dato.
 *
 * ## Las dos decisiones de forma que gobiernan todo el archivo
 *
 * ### 1. El catálogo de conceptos es CÓDIGO, no una tabla
 *
 * Criterio fijado en el plan 14 §1, y vale para los que vengan: **tabla** es lo que recibe FK desde
 * filas de dominio o cambia sin deploy (`banco`, `cotizacion_bna`); **código** es lo que gobierna
 * comportamiento determinístico y cuya alta exige código nuevo de todos modos. Un concepto nuevo
 * necesita un parser que lo lea: la fila sola no sirve para nada. Al persistir, el concepto va como
 * `text` + `check constraint` espejo de esta unión (mismo patrón que `TIPOS_CUENTA`).
 *
 * ### 2. Cada renglón guarda base + alícuota publicada + monto, CRUDOS del documento
 *
 * Nunca un monto solo, y **nunca un monto reconstruido desde una tasa cableada en código**. Es la
 * condición que separa "el sistema lee lo que el agente retuvo" de "el sistema calcula la retención" —
 * este módulo hace lo primero. Su corolario está verificado por la regla R-O
 * (`packages/data/tests/reglas-de-codigo.test.ts`): en este subárbol no hay ni una tasa escrita.
 *
 * ## Clasificación de seguridad, ya decidida (dictamen `seguridad-datos-financieros`, 2026-08-19)
 *
 * Está acá para que el commit 3 —la migración— **no la invente**. `formato_liquidacion` es catálogo
 * N0 sin tenant (gemelo de `banco`), con capacidades booleanas y cero valores. `lote_liquidacion` es
 * espejo de `lote_ingesta`, incluida su regla escrita: **ni una columna ≥ N2** (si el lote lleva un N2,
 * observar el pipeline pasa al régimen auditado); período, número de liquidación y total neto **no van
 * en el lote**, van al satélite. Y en los renglones, con `cliente_id`:
 *
 * | Grupo | Nivel |
 * |---|---|
 * | Ventas brutas, base, monto, neto acreditado | **N2**, exportable |
 * | Alícuota publicada (la tasa cruda del documento) | **N2** — es el término negociado de ESTE comercio (H-6) |
 * | Fechas de liquidación y de pago | **N2**, exportable |
 * | Concepto, subtipo, estado de verificación y su motivo | **N1** — vocabulario del producto, igual entre clientes |
 * | Página e índice del renglón | **N1** — puntero de evidencia, precedente `pagina_pdf` |
 * | Número de liquidación del adquirente | **N2**. 🔴 Unicidad `(cliente_id, formato, numero)`, JAMÁS global: la numeración del adquirente es global entre comercios, así que un único global además de ser oráculo cross-tenant **colisiona** |
 * | Jurisdicción de la retención | **N2** (ADR-0002 §A.1 clasifica las jurisdicciones activas como N2) |
 * | CUIT del comercio | **N2-R** — recomendación fuerte: no persistirlo crudo; guardar `titular_declarado_coincide` booleano, mismo criterio que el Módulo 1 |
 * | Hashes de fila o de archivo | **N2**, `exportable: false` — no es reversible pero **es comparable** |
 *
 * Nada de esto entra a `clasificacion-campos.ts` todavía: ese registro es bidireccional
 * (`packages/data/tests/catalogo.test.ts` falla con "tablas en el registro que no existen en la base"),
 * así que adelantar una entrada sin migración pone el gate en rojo.
 */

import { z } from 'zod';
// El tri-estado se IMPORTA del esquema del paquete en vez de redeclararse: es literalmente el mismo
// dominio, y dos declaraciones que divergen en silencio es el modo de falla que R-H existe para tapar.
// R-M aísla las dos familias de ADAPTERS (`adaptadores/` ↔ `liquidaciones/`), no la infraestructura
// compartida del paquete — ese reuso medido es la razón por la que esto es un subárbol y no un paquete.
import { ESTADOS_VERIFICACION } from '../esquema.ts';

// -----------------------------------------------------------------------------
// Primitivas
// -----------------------------------------------------------------------------

/** Importe del documento: siempre positivo, tal como el adquirente lo publica. Nunca `number`. */
const importeNoNegativo = z
  .string()
  .regex(/^\d+\.\d{2}$/, 'importe canónico: string decimal con 2 decimales, p. ej. "4321.00"');

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha ISO aaaa-mm-dd');

/**
 * La tasa **tal como el documento la imprime**, como string y sin normalizar.
 *
 * Es un dato del renglón, no una constante: la tasa de arancel es un término negociado por comercio y
 * la de retención depende de un padrón por contribuyente. Por eso vive acá como *forma admisible* y
 * jamás como *valor* — ver R-O.
 */
const tasaPublicada = z
  .string()
  .regex(/^\d+(?:\.\d{1,4})?$/, 'la tasa se guarda cruda, como string decimal sin signo');

/**
 * "El documento lo publica" vs. "el documento no lo publica", como **unión discriminada** y no como
 * campo opcional.
 *
 * El plan ya modela la ausencia como valor nombrado en dos lugares (`no_publicada` para la jurisdicción
 * y para la base). Si además hubiera un `?: string | undefined`, el mismo hecho tendría dos
 * representaciones que pueden contradecirse sin que nada lo detecte. Con esto hay una sola, y
 * `no_publicado` es un resultado de primera clase: **nunca se deduce el valor que el emisor no imprimió.**
 */
function publicado<T extends z.ZodType>(valor: T) {
  return z.discriminatedUnion('estado', [
    z.object({ estado: z.literal('publicado'), valor }),
    z.object({ estado: z.literal('no_publicado') }),
  ]);
}

// -----------------------------------------------------------------------------
// El catálogo de conceptos
// -----------------------------------------------------------------------------

/**
 * Los formatos donde se midió cada concepto. Es la evidencia del catálogo, y es **dato del producto**:
 * dice en qué formatos aparece el concepto, no cuántas veces apareció en el documento de un cliente.
 *
 * La diferencia no es cosmética. El shape análogo del catálogo canónico (`porLiteral`) lleva un campo
 * `movimientos: number`, y ese conteo acá sería una medición del **volumen de actividad comercial de un
 * cliente identificable** — N2 por ADR-0002 §A.2 (agregar no desclasifica; la excepción exige k ≥ 20
 * sobre ≥ 5 clientes distintos, y acá hay uno). El tipo hace imposible el error, que es mejor que una
 * nota pidiendo cuidado.
 */
export const FORMATOS_MEDIDOS = ['visa_debito', 'visa_credito', 'cabal_debito'] as const;
export type FormatoMedido = (typeof FORMATOS_MEDIDOS)[number];

/**
 * Los conceptos medidos en los tres documentos reales analizados en la sesión de diseño.
 *
 * 🔴 **Abierto, elevado a JP:** `seguridad-datos-financieros` objetó el `21` de `iva_21_sobre_arancel`
 * — no como fuga (esa alícuota es idéntica para todo contribuyente, así que no singulariza a nadie)
 * sino por forma: una regla enunciada como "cero tasas **salvo** las normativas" tiene la estructura de
 * R33, y la excepción exige un juicio caso-por-caso que alguien va a hacer mal el día que escriba un
 * arancel esperado. El nombre se mantiene porque es el que fijó el plan 14 aprobado y el que lee Codex;
 * cambiarlo unilateralmente desincronizaría el documento del código. Si JP decide renombrarlo
 * (`iva_sobre_arancel`), el momento barato es **antes del commit 3**, que es donde el check constraint
 * lo congela. R-O no fuerza la decisión en ningún sentido: mira decimales y el signo de porcentaje, no
 * enteros dentro de un identificador.
 */
export const TIPOS_CONCEPTO_LIQUIDACION = [
  'arancel',
  'iva_21_sobre_arancel',
  'retencion_iibb_sirtac',
  'percepcion_iva_rg2408',
  'descuento_contado_adquirente',
  'interes_financiacion_cuotas',
] as const;
export type TipoConceptoLiquidacion = (typeof TIPOS_CONCEPTO_LIQUIDACION)[number];

/**
 * Sobre qué base se calcula cada concepto. **Estructura del formato, nunca el valor de la base.**
 *
 * `no_publicada` es un término de primera clase: la percepción de IVA aparece en el corpus medido sin
 * fórmula derivable contra ninguna base probada, y eso se registra como lo que es —un dato que el
 * emisor publica ya calculado— en vez de adivinarle una base.
 */
export const BASES_DE_CALCULO = ['ventas_brutas', 'arancel', 'no_publicada'] as const;
export type BaseDeCalculo = (typeof BASES_DE_CALCULO)[number];

/**
 * Los sub-tipos de venta que un mismo documento puede mezclar.
 *
 * Visa crédito trae contado y cuotas **en la misma liquidación**, cada uno con su base y su propia
 * alícuota de IVA. Se modelan como renglones con concepto propio, **no** como columnas fijas: es la
 * restricción original de JP, y es lo que permite que un cuarto formato entre sin tocar el esquema.
 */
export const SUBTIPOS_DE_VENTA = ['contado', 'cuotas', 'no_discriminado'] as const;
export type SubtipoDeVenta = (typeof SUBTIPOS_DE_VENTA)[number];

/**
 * Qué le hace el concepto al neto acreditado.
 *
 * Entra a la aritmética del eje 1 (ventas − deducciones = neto) en el commit 2. `no_determinado` no es
 * pereza: en el corpus medido el signo de la percepción no quedó probado, y el plan es explícito en que
 * su fórmula queda pendiente de `fiscal-nacional-iva-ganancias`. Un supuesto acá haría cuadrar o no
 * cuadrar la verificación por una decisión que nadie tomó.
 */
export const EFECTOS_SOBRE_EL_NETO = ['resta', 'suma', 'no_determinado'] as const;
export type EfectoSobreElNeto = (typeof EFECTOS_SOBRE_EL_NETO)[number];

export type ProcedenciaDeConcepto = {
  readonly fuente: 'corpus_medido';
  readonly documento: string;
  readonly seccion: string;
  readonly formatos: readonly FormatoMedido[];
};

export type DefinicionDeConcepto = {
  readonly baseDeCalculo: BaseDeCalculo;
  readonly efectoSobreElNeto: EfectoSobreElNeto;
  readonly procedencia: ProcedenciaDeConcepto;
};

/**
 * El catálogo. Estructura y evidencia; **cero valores, cero tasas** (R-O).
 *
 * La `procedencia` cita el documento **trackeado** que resume lo medido, nunca el archivo del cliente:
 * un nombre de archivo bajo `privado/` puede contener una razón social o un número de comercio, y eso es
 * texto sin patrón que ningún control de este repo detecta (ADR-0002 §C.0.bis).
 */
const PLAN = 'docs/diseno/14-liquidaciones-tarjeta-plan.md';

export const CATALOGO_DE_CONCEPTOS = {
  arancel: {
    baseDeCalculo: 'ventas_brutas',
    efectoSobreElNeto: 'resta',
    procedencia: {
      fuente: 'corpus_medido',
      documento: PLAN,
      seccion: 'Contexto — lo medido en los tres documentos',
      formatos: ['visa_debito', 'visa_credito', 'cabal_debito'],
    },
  },
  iva_21_sobre_arancel: {
    baseDeCalculo: 'arancel',
    efectoSobreElNeto: 'resta',
    procedencia: {
      fuente: 'corpus_medido',
      documento: PLAN,
      seccion: 'Contexto — lo medido en los tres documentos',
      formatos: ['visa_debito', 'visa_credito', 'cabal_debito'],
    },
  },
  retencion_iibb_sirtac: {
    baseDeCalculo: 'ventas_brutas',
    efectoSobreElNeto: 'resta',
    procedencia: {
      fuente: 'corpus_medido',
      documento: PLAN,
      seccion: 'Contexto — lo medido en los tres documentos',
      formatos: ['visa_debito', 'visa_credito', 'cabal_debito'],
    },
  },
  percepcion_iva_rg2408: {
    // Dos tasas distintas en el mismo bloque, sin fórmula derivable contra ninguna base probada. Se
    // captura el importe tal como el documento lo publica: la captura no espera a la fórmula.
    baseDeCalculo: 'no_publicada',
    efectoSobreElNeto: 'no_determinado',
    procedencia: {
      fuente: 'corpus_medido',
      documento: PLAN,
      seccion: 'Contexto — lo medido en los tres documentos',
      formatos: ['visa_debito', 'visa_credito'],
    },
  },
  descuento_contado_adquirente: {
    baseDeCalculo: 'ventas_brutas',
    efectoSobreElNeto: 'resta',
    procedencia: {
      fuente: 'corpus_medido',
      documento: PLAN,
      seccion: 'Contexto — Visa crédito, sub-tipos de venta',
      formatos: ['visa_credito'],
    },
  },
  interes_financiacion_cuotas: {
    baseDeCalculo: 'ventas_brutas',
    efectoSobreElNeto: 'resta',
    procedencia: {
      fuente: 'corpus_medido',
      documento: PLAN,
      seccion: 'Contexto — Visa crédito, sub-tipos de venta',
      formatos: ['visa_credito'],
    },
  },
} as const satisfies Record<TipoConceptoLiquidacion, DefinicionDeConcepto>;

// -----------------------------------------------------------------------------
// Capacidades del formato
// -----------------------------------------------------------------------------

/**
 * Qué publica cada formato. **No es documentación: es la entrada del verificador.**
 *
 * Sin esta declaración, "este formato no publica el total" y "el parser no lo encontró" se ven
 * exactamente igual, y el segundo se esconde detrás del primero para siempre.
 *
 * 🔴 **Tres campos, no siete, y es deliberado.** Cada capacidad entra con el invariante que la lee; una
 * capacidad que nadie verifica es un booleano decorativo. Estas tres son las medidas contra documento en
 * la sesión de diseño. Las demás (fecha de pago, discriminación de sub-tipo, publicación de la
 * jurisdicción, número de liquidación) entran con el adapter que las ejercite — agregar una capacidad
 * cuando hay un solo adapter es lo más barato que va a estar nunca.
 */
export const capacidadesDeFormatoSchema = z.object({
  /**
   * ¿El emisor publica un total consolidado del período contra el cual sumar las liquidaciones?
   *
   * Primera capacidad real medida y la que hace falta desde el día uno: es verdadera en Visa y **falsa
   * en Cabal**, donde cada liquidación es un bloque independiente sin checksum del emisor. Cuando es
   * falsa, el eje 2 da `no_verificable` con motivo `emisor_no_publica_total` — que no es "sin
   * verificación posible": ese formato usa el eje 3 (cruce contra extracto) como su control mensual.
   */
  traeTotalDelEmisor: z.boolean(),
  /** ¿Cada renglón viene con su base y su tasa, o solo con el monto ya calculado? */
  publicaBaseYAlicuotaPorRenglon: z.boolean(),
  /** Falsa en el formato del tercer proveedor medido, que no trae percepción en ningún bloque. */
  traePercepcionIva: z.boolean(),
});
export type CapacidadesDeFormato = z.infer<typeof capacidadesDeFormatoSchema>;

// -----------------------------------------------------------------------------
// Verificación: tres ejes ORTOGONALES
// -----------------------------------------------------------------------------

/**
 * Los tres ejes, que son tres y no uno.
 *
 * Corrección de `motor-conciliacion-contable` sobre la primera versión del diseño, que los colapsaba en
 * un solo estado. Colapsados, un formato sin checksum del emisor se leería como "no verificable" a secas
 * —y en los hechos, como *nada que hacer*—, cuando en realidad su aritmética interna cierra sola (eje 1)
 * y su control mensual real es el cruce contra el extracto (eje 3). Cada eje se responde por separado.
 */
export const EJES_DE_VERIFICACION = [
  /** Ventas − deducciones = neto, al centavo, dentro de una liquidación. */
  'aritmetica_por_liquidacion',
  /** Σ liquidaciones == total consolidado publicado por el emisor. */
  'checksum_del_emisor',
  /** Cada liquidación contra el crédito del extracto bancario. */
  'cruce_contra_extracto',
] as const;
export type EjeDeVerificacion = (typeof EJES_DE_VERIFICACION)[number];

/**
 * Por qué un eje no se pudo verificar. **Roster cerrado, y arranca con un solo motivo a propósito.**
 *
 * El repo ya tiene la disciplina de que la cantidad de `no_verificable` no puede crecer sin que crezca
 * la lista de motivos, y la simétrica de que una allowlist no puede tener entradas muertas. Un roster
 * poblado por adelantado con motivos que ningún adapter produce todavía nace en conflicto con las dos.
 * `emisor_no_publica_total` es el motivo original **medido**: el tercer proveedor no publica total
 * consolidado.
 *
 * `concepto_con_efecto_no_determinado` se agrega en el commit 2 (adapter Visa débito), y es la
 * contracara del eje 1 (`aritmetica_por_liquidacion`, ver `verificacion.ts`): `percepcion_iva_rg2408`
 * tiene `efectoSobreElNeto: 'no_determinado'` en el catálogo porque su fórmula no está probada contra
 * ninguna base — así que si un renglón con ese efecto trae un monto ≠ 0, el eje 1 no puede sumarlo ni
 * restarlo con ningún signo, y `no_verificable` con este motivo es la única respuesta honesta. Genérico
 * a propósito: cualquier concepto futuro con el mismo `efectoSobreElNeto: 'no_determinado'` reusa este
 * motivo, no necesita uno propio.
 */
export const MOTIVOS_NO_VERIFICABLE = [
  'emisor_no_publica_total',
  'concepto_con_efecto_no_determinado',
] as const;
export type MotivoNoVerificable = (typeof MOTIVOS_NO_VERIFICABLE)[number];

/**
 * El resultado de UN eje. El motivo y el estado están atados: `no_verificable` **exige** motivo, y
 * cualquier otro estado lo prohíbe. Sin ese refine, `no_verificable` sin motivo vuelve a ser la salida
 * de emergencia que en tres sprints usan todos los formatos.
 */
export const resultadoDeEjeSchema = z
  .object({
    eje: z.enum(EJES_DE_VERIFICACION),
    estado: z.enum(ESTADOS_VERIFICACION),
    motivo: z.enum(MOTIVOS_NO_VERIFICABLE).optional(),
  })
  .refine((r) => (r.estado === 'no_verificable') === (r.motivo !== undefined), {
    message: '`no_verificable` exige motivo del roster cerrado; ningún otro estado lo admite',
  });
export type ResultadoDeEje = z.infer<typeof resultadoDeEjeSchema>;

// -----------------------------------------------------------------------------
// La liquidación
// -----------------------------------------------------------------------------

export const renglonDeLiquidacionSchema = z.object({
  concepto: z.enum(TIPOS_CONCEPTO_LIQUIDACION),
  subtipoVenta: z.enum(SUBTIPOS_DE_VENTA),
  /** La base **crudo del documento**, no recalculada. `no_publicado` cuando el emisor no la imprime. */
  base: publicado(importeNoNegativo),
  /** La tasa **cruda del documento**. Las dos tasas de la percepción son atributo del renglón. */
  alicuotaPublicada: publicado(tasaPublicada),
  monto: importeNoNegativo,
  /**
   * La jurisdicción de la retención, **solo si el documento la publica**. Nunca se deduce del CUIT, ni
   * del domicilio, ni de la tasa: deducirla es inventar un dato fiscal de un tercero.
   */
  jurisdiccion: publicado(z.string().min(1)),
  paginaPdf: z.number().int().positive().optional(),
});
export type RenglonDeLiquidacion = z.infer<typeof renglonDeLiquidacionSchema>;

export const liquidacionLeidaSchema = z.object({
  numeroDeLiquidacion: publicado(z.string().min(1)),
  fechaPresentacion: fechaIso,
  fechaDePago: publicado(fechaIso),
  /**
   * `z.literal` y **no** un enum, a propósito: el corpus medido es enteramente en moneda local. Un
   * formato en otra moneda tiene que fallar ruidosamente en la validación, no coercionarse en silencio
   * contra un supuesto que nadie escribió.
   */
  moneda: z.literal('ARS'),
  ventasBrutas: importeNoNegativo,
  netoAcreditado: importeNoNegativo,
  renglones: z.array(renglonDeLiquidacionSchema),
  /**
   * ¿El documento imprime el caveat de que no es válido para el cómputo de retenciones o percepciones?
   *
   * Es un **hecho del documento**, y por eso lo lee el parser. Su consecuencia contable no: la distinción
   * entre `registrado` (el hecho económico ocurrió, el asiento entra con la liquidación como evidencia) y
   * `computable_confirmado` (el cómputo fiscal formal exige el comprobante habilitante) es de la capa
   * contable, y hoy **no tenemos esa fuente cargada** en `knowledge/`. Validar con profesional matriculado.
   */
  caveatDeComputoFiscal: z.boolean(),
  paginaPdf: z.number().int().positive().optional(),
});
export type LiquidacionLeida = z.infer<typeof liquidacionLeidaSchema>;

/**
 * ⚠️ **La FORMA de la línea, nunca la línea** — y acá hace falta un paso más que en el extracto.
 * Ver `formaDeLineaDeLiquidacion` en `contrato.ts`: en una liquidación la etiqueta fija el campo, así que
 * la forma de la línea de totales sería la magnitud de la facturación mensual del comercio, en un log.
 */
export const CODIGOS_LINEA_NO_INTERPRETADA = [
  'bloque_de_conceptos_no_reconocido',
  'bloque_de_totales_no_interpretado',
  'renglon_sin_monto',
  'fecha_ilegible',
  'linea_fuera_de_zona',
  'pdf_sin_texto',
  'desconocido',
] as const;
export type CodigoLineaNoInterpretada = (typeof CODIGOS_LINEA_NO_INTERPRETADA)[number];

export const lineaNoInterpretadaDeLiquidacionSchema = z.object({
  codigo: z.enum(CODIGOS_LINEA_NO_INTERPRETADA),
  paginaPdf: z.number().int().positive(),
  indice: z.number().int().nonnegative(),
  /** Producto de `formaDeLineaDeLiquidacion`. Nunca el texto. */
  forma: z.string(),
});
export type LineaNoInterpretadaDeLiquidacion = z.infer<typeof lineaNoInterpretadaDeLiquidacionSchema>;

/**
 * El documento entero, ya leído. Espejo estructural de `ExtractoParseado` del Módulo 1: el sobre con lo
 * que identifica al archivo, alrededor de lo que devolvió el adapter.
 *
 * `backend-dev` objetó incluirlo en este commit por no tener todavía productor ni consumidor. Se
 * mantiene por dos razones: el plan 14 §5.1 lo nombra explícitamente como entregable del paso 1, y su
 * análogo bancario ocupa exactamente este lugar (lo arma el CLI, que acá llega en el commit 4). Si al
 * escribir ese comando la forma resulta otra, se corrige entonces: no persiste nada todavía.
 */
export const liquidacionProcesadaSchema = z.object({
  formatoCodigo: z.string().min(1),
  adaptadorVersion: z.number().int().positive(),
  capacidades: capacidadesDeFormatoSchema,
  /** sha256 del archivo: idempotencia del lote. */
  archivoHash: z.string().length(64),
  paginas: z.number().int().positive(),
  /** Por página, no por promedio: un PDF mixto con páginas escaneadas promedia por encima del umbral. */
  paginasSinTexto: z.array(z.number().int().positive()),
  liquidaciones: z.array(liquidacionLeidaSchema),
  /**
   * El total consolidado que publica el emisor, si lo publica. Ausente significa "no hay eje 2 que
   * correr", nunca "cuadra" — la distinción es la mitad del valor del tri-estado.
   */
  totalConsolidadoDeclarado: publicado(importeNoNegativo),
  lineasNoInterpretadas: z.array(lineaNoInterpretadaDeLiquidacionSchema),
});
export type LiquidacionProcesada = z.infer<typeof liquidacionProcesadaSchema>;
