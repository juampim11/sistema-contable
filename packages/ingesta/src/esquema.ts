/**
 * Esquema atómico de la ingesta bancaria — Módulo 1.
 *
 * Reconcilia dos fuentes: el contrato de **ADR-0001 §5.1** (`importe` signado, `unique (cliente_id,
 * fila_hash)`, `fila_origen` con el dato crudo) y el documento de contexto del proyecto (campos
 * `debito`/`credito` separados). **Se quedan los dos, y no es indecisión:** el extracto trae dos columnas
 * y así las nombra el banco; el asiento necesita un signo. Y la contadora fue explícita en que **el
 * débito bancario es lo inverso del débito contable** — mezclarlos es el error clásico del dominio.
 *
 * ---
 * ## Lo que el panel corrigió de la primera versión
 *
 * 1. **`credito`/`debito` usaban el regex CON signo** aunque el comentario decía "siempre positivos".
 *    Ahora hay dos tipos distintos, y un `refine` que ata el derivado al dato.
 * 2. **El verde-por-vacío estaba horneado en el contrato**: `hayTotalesEnElExtracto: false` con
 *    `cuadraContraTotales: true` era un objeto válido. Ahora es un **tri-estado**
 *    (`cuadra | no_cuadra | no_verificable`) y **lo calcula una función pura**, no lo declara el adapter.
 * 3. **`diferencias: string[]` era prosa.** Prosa armada con valores del extracto es la vía por la que un
 *    N2 llega a un log — el propio ADR-0002 ya se corrigió una vez por esto. Ahora son **códigos**.
 * 4. **Faltaban los campos de los que dependen las reglas del Módulo 2** (documento de la contraparte,
 *    código de concepto del banco) y los que sostienen los invariantes (`tipoFila`, `paginasDeclaradas`).
 *    Si el Módulo 1 no los captura hoy, el Módulo 2 vuelve al PDF — y para el cliente de mayor volumen
 *    **puede no haber PDF al que volver: entrega el extracto en papel.**
 *
 * ## El principio de diseño del piloto
 *
 * Lo que no se puede determinar sin información que todavía no tenemos **no se cablea: se declara como
 * capacidad o como parámetro**. `CapacidadesAdaptador` y `Tolerancias` existen para eso — cuando llegue
 * el dato, se cambia un valor, no una función.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Primitivas
// -----------------------------------------------------------------------------

/** Importe signado. Nunca `number` (ADR-0000 §2.3). */
const importe = z
  .string()
  .regex(/^-?\d+\.\d{2}$/, 'importe canónico: string decimal con 2 decimales, ej. "-4321.00"');

/** Importe del banco: siempre positivo. Es la columna tal como la publica el extracto. */
const importeNoNegativo = z
  .string()
  .regex(/^\d+\.\d{2}$/, 'la columna del banco es siempre positiva, ej. "4321.00"');

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha ISO aaaa-mm-dd');

export const MONEDAS = ['ARS', 'USD'] as const;
export const monedaSchema = z.enum(MONEDAS);
export type Moneda = z.infer<typeof monedaSchema>;

// -----------------------------------------------------------------------------
// Capacidades del adaptador — lo que hace que el pipeline sea genérico de verdad
// -----------------------------------------------------------------------------

export const FAMILIAS_LAYOUT = ['columnas-posicionales', 'ancho-fijo', 'imagen'] as const;
export const CADENAS_DE_SALDOS = ['completa', 'por_puntos_de_control', 'no_disponible'] as const;

/**
 * Qué publica cada banco. **No es documentación: es la entrada del verificador.**
 *
 * Sin esto, "un banco que no publica totales" y "un parser roto que no encontró los totales" se ven
 * exactamente igual. Con esto, el verificador sabe qué invariantes puede exigir y cuáles no aplican — y
 * `no_verificable` deja de ser una salida de emergencia para volverse una propiedad declarada del banco.
 *
 * Y es el lugar donde vive el principio del piloto: lo que de un banco todavía no sabemos se declara
 * acá y se corrige cambiando un booleano.
 */
export const capacidadesAdaptadorSchema = z.object({
  familiaLayout: z.enum(FAMILIAS_LAYOUT),
  cadenaDeSaldos: z.enum(CADENAS_DE_SALDOS),
  traeTotalesDeclarados: z.boolean(),
  traeSaldoInicialDeclarado: z.boolean(),
  /** Cuando es `false`, el signo del importe **sale de la cadena de saldos**: la aritmética es la fuente. */
  traeSignoEnElImporte: z.boolean(),
  traeSaldoPorFila: z.boolean(),
  traeFechaValor: z.boolean(),
  traeReferencia: z.boolean(),
  traeCodigoDeConcepto: z.boolean(),
  /** Cuando es `false`, la fecha viene `dd/mm` y se resuelve contra el período. */
  anioEnLaFecha: z.boolean(),
  multiCuenta: z.boolean(),
  multiMoneda: z.boolean(),
  /**
   * ¿Este banco publica movimientos **con fecha fuera del período declarado**?
   *
   * Parecía una invariante universal y **es falsa en un banco medido**: el tercero del roster arranca la
   * cuenta corriente con **4 movimientos de octubre en un resumen de noviembre**
   * (`07-formato-macro.md` §6), con glosas `N/D FV …` y `RETENCION IIBB …`. Son movimientos legítimos que
   * el banco arrastró.
   *
   * Cuando es `true`, `EST_FECHA_FUERA_DE_PERIODO` baja a **observación**: se sigue reportando —el dato no
   * se pierde y queda en `verificacion_detalle`— pero no pone el lote en rojo. `fechasDentroDelPeriodo`
   * sigue diciendo la verdad.
   *
   * **Se declara por banco y con archivo de referencia, no se relaja para todos.** Relajarla globalmente
   * apagaría el control en los bancos donde una fecha de otro mes sí significa que se capturó una línea del
   * bloque equivocado.
   */
  traeMovimientosFueraDelPeriodo: z.boolean(),
  /**
   * ¿Este banco publica un **saldo consolidado por moneda** en la carátula?
   *
   * Es la entrada de INV-multicuenta, el único control que detecta que el adaptador mezcló, perdió o
   * duplicó una cuenta. Sin esta declaración, "el banco no lo publica" y "el parser de carátula no lo
   * encontró" se ven **exactamente igual** — y el segundo apaga el control en silencio, justo en el banco
   * donde más falta hace.
   *
   * No es hipotético: el tercer banco del roster imprime el mismo literal con **dos espaciados distintos**
   * en el mismo archivo (`07-formato-macro.md` §9). Un regex que falle por eso entrega la lista vacía, y el
   * lote con las tres cuentas mezcladas pasa en verde con 1 ruptura sobre 1346.
   *
   * Es el mismo razonamiento —y el mismo precedente— que `traeTotalesDeclarados`: *"si el banco DICE traer
   * totales y el parser no los encontró, no se degrada a no aplica: el parser falló"*.
   */
  traeConsolidadoPorMoneda: z.boolean(),
  /**
   * A2 (`docs/diseno/10-deuda-declarada.md` §2.1): ¿este adaptador clasifica CADA fila en uno de los
   * destinos de `DESTINOS_BASE` (`toolkit.ts`) y publica el recuento en `SalidaDeAdaptador.destinos`?
   *
   * Mismo razonamiento que `traeTotalesDeclarados`/`traeConsolidadoPorMoneda`: sin la declaración,
   * "este banco todavía no está instrumentado" y "el adaptador dejó de mandar el conteo" se ven
   * exactamente igual. Con `true`, `destinos === undefined` en la salida es un `error` del gate, no un
   * "no aplica" — ver `verificarDestinos`.
   */
  declaraDestinos: z.boolean(),
});
export type CapacidadesAdaptador = z.infer<typeof capacidadesAdaptadorSchema>;

// -----------------------------------------------------------------------------
// Cuenta detectada
// -----------------------------------------------------------------------------

/**
 * El tipo de cuenta. **Esta lista existe TRES veces** y las tres tienen que decir lo mismo: acá, en el check
 * `cuenta_ident_tipo_chk` (migración `0006`) y en `TIPOS_CUENTA_ALTA` (`packages/data/src/ingesta/
 * escrituras.ts`). No se pueden derivar entre sí sin el ciclo `data → ingesta`, que está prohibido, así que
 * el árbitro es el check: el test parametrizado de dominios cerrados compara **las dos** constantes contra
 * él, y por transitividad quedan iguales entre sí.
 *
 * Divergieron una vez: el check original de `0004` traía un `cuenta_unica` **inventado en la migración**, y
 * aplastaba a `otra` los cinco tipos reales.
 */
export const TIPOS_CUENTA = [
  'cuenta_corriente',
  'cuenta_corriente_especial',
  'caja_ahorro',
  'cuenta_inversion',
  'tarjeta_corporativa',
  'no_determinado',
] as const;

/**
 * Un PDF puede traer VARIAS cuentas y VARIAS monedas (verificado: un banco del roster trae tres cuentas
 * en un archivo). El resultado del parseo no es una tabla plana.
 *
 * ⚠️ **Los identificadores de acá son la ENTRADA del resolver, no lo que se persiste.** En la base, el
 * CBU y el número se guardan **hasheados** (para poder matchear sin leerlos) más los últimos 4 (para
 * mostrar). Ver el plan §8.7. Guardarlos enteros por inercia es el camino a un `unique` global, que
 * sería un oráculo cross-tenant (ADR-0002 H-10).
 */
export const cuentaDetectadaSchema = z.object({
  /** Denominación tal como la escribe el banco. Puede repetirse entre cuentas: NO es identificador. */
  denominacion: z.string().min(1),
  tipoCuenta: z.enum(TIPOS_CUENTA),
  /** El ancla real del cambio de cuenta cuando el banco lo publica en el encabezado repetido. */
  numero: z.string().optional(),
  cbu: z.string().optional(),
  moneda: monedaSchema,
  periodoDesde: fechaIso.optional(),
  periodoHasta: fechaIso.optional(),
  saldoInicialDeclarado: importe.optional(),
  saldoFinalDeclarado: importe.optional(),
  totalCreditosDeclarado: importeNoNegativo.optional(),
  totalDebitosDeclarado: importeNoNegativo.optional(),
  /** Datos del titular que el propio extracto declara. Sirven para validar que el archivo es del cliente. */
  titular: z.string().optional(),
  titularDocumento: z.string().optional(),
  titularCondicionIva: z.string().optional(),
});
export type CuentaDetectada = z.infer<typeof cuentaDetectadaSchema>;

// -----------------------------------------------------------------------------
// Movimiento
// -----------------------------------------------------------------------------

/** Clasificación ESTRUCTURAL, no contable. Decir "esta línea es el saldo anterior" es leer, no imputar. */
export const TIPOS_FILA = [
  'movimiento',
  'saldo_inicial',
  'saldo_final',
  'total',
  'anexo',
  'encabezado',
  'pie',
] as const;

/**
 * De dónde salió el corte de `conceptoBanco`. **Unión cerrada, declarada por fila.**
 *
 * Existe para que la procedencia del concepto sea auditable **en los datos** y no solo en un test. Sin
 * ella, tres cosas distintas se ven iguales para siempre y el léxico del Módulo 2 las cuenta juntas:
 * "esta fila es anterior a la migración 0007", "el banco no publica concepto para esta fila" y "el concepto
 * vino de una columna propia del Excel".
 *
 * El `check` `mov_crudo_concepto_estrategia_chk` (migración `0007`) tiene esta misma lista. Dos listas del
 * mismo dominio en dos lenguajes ya divergieron dos veces en este repo, así que el test parametrizado de
 * dominios cerrados (`packages/data/tests/catalogo.test.ts`) lee los valores del `check` desde
 * `pg_constraint` y los compara **como conjunto** contra esta constante.
 *
 * ⚠️ Esa afirmación era **falsa hasta que el test se escribió**: durante varias migraciones este comentario
 * prometía una comparación que no existía. Ahora existe y cubre los diez dominios cerrados del esquema —
 * incluido uno de cobertura que se pone rojo si alguien agrega un `check` de este tipo sin su constante.
 */
export const ESTRATEGIAS_CONCEPTO = [
  /** Fila anterior a la migración `0007`. **Ningún adaptador lo emite**: es el valor del backfill. */
  'no_capturado',
  /** El adaptador miró y el banco no publica concepto para esa fila. */
  'no_publicado',
  /**
   * Vino en una celda propia de otro artefacto (el `.xls` de un banco trae `Cod. Operativo` + `Concepto`).
   * **No es prefijo de la glosa del PDF**, así que queda exenta del `check` de INV-14 — y por eso, para esta
   * estrategia, la verificación de que no lleva un identificador tiene que correr **en código**.
   */
  'columna_propia',
  /**
   * El valor pertenece a la lista **cerrada** de etiquetas del banco, **anclada al inicio**. Nunca por
   * `contains`: en un banco del roster `N/D DBCR … S/DB` y `N/C DBCR … S/CR` son la misma raíz con lados
   * opuestos, y un `includes` los confunde.
   */
  'prefijo_anclado',
  /** El segmento de concepto cortado **geométricamente** de la glosa. */
  'segmento_de_glosa',
] as const;
export type EstrategiaConcepto = (typeof ESTRATEGIAS_CONCEPTO)[number];

/**
 * Qué pasó con la búsqueda del/de los candidato(s) de contraparte en esta fila (migración 0013).
 *
 * `no_capturado` es el valor del backfill y NINGÚN adaptador lo emite: sin él, "el banco no
 * publica ningún identificador en esta glosa" y "esta fila es anterior a 0013" se ven iguales para
 * siempre, y el motor las cuenta juntas. Mismo tri-estado (más un cuarto valor) que
 * `ESTRATEGIAS_CONCEPTO` de 0007.
 *
 * `capturado_cuenta_propia`: el único candidato CBU encontrado resultó ser una cuenta DEL PROPIO
 * cliente (transferencia entre cuentas propias) — no se persiste como candidato de contraparte
 * (`packages/ingesta/src/contraparte.ts`), así que sin este valor la fila se vería idéntica a "no
 * había ningún identificador".
 *
 * Idéntica a `mov_crudo_contraparte_captura_chk` (migración 0013); hay test de catálogo.
 */
export const CAPTURAS_CONTRAPARTE = [
  'no_capturado',
  'sin_identificador',
  'capturado',
  'capturado_cuenta_propia',
] as const;
export type CapturaContraparte = (typeof CAPTURAS_CONTRAPARTE)[number];

export const TIPOS_REFERENCIA = [
  'factura',
  'cheque',
  'operacion',
  'comercio',
  'terminal',
  'vep',
  'otra',
] as const;

/**
 * Identificador encontrado en la glosa. **Se extrae, NO se decide de quién es.**
 *
 * La zona gris del alcance, resuelta a favor del Módulo 1: extraer un patrón con dígito verificador
 * válido es extracción, no criterio contable, y dejarlo para después obliga a re-parsear todos los PDF —
 * de un cliente que entrega en papel. Decidir si ese documento es de un socio es del Módulo 2.
 *
 * ⚠️ Se extrae **del campo correcto**, no por longitud de dígitos en cualquier parte de la glosa: en un
 * solo extracto hay 271 corridas de 8 dígitos que son terminales y comercios, no documentos.
 */
export const candidatoIdentificacionSchema = z.object({
  tipo: z.enum(['cuit', 'cuil', 'dni']),
  valor: z.string().min(7),
  /** En qué línea de continuación apareció: es lo que permite auditar la extracción. */
  lineaIndice: z.number().int().nonnegative(),
  verificadorValido: z.boolean(),
});

export const movimientoBancarioCrudoSchema = z
  .object({
    tipoFila: z.literal('movimiento'),
    fecha: fechaIso,
    fechaValor: fechaIso.optional(),

    /** Las líneas de continuación **en orden**, sin unir. Ahí vive la contraparte. */
    descripcionLineas: z.array(z.string()).min(1),
    /**
     * Concatenación conveniente de `descripcionLineas`.
     *
     * ⚠️ **INVARIANTE INV-13, y es lo que sostiene que este campo sea N2 y no N2R:** no puede contener
     * un identificador de tercero. Si el adapter le pega las líneas que traen un CUIT, la columna hereda
     * N2R y arrastra toda la tabla al régimen de lectura auditada (ADR-0002, hallazgo H-D).
     */
    descripcion: z.string().min(1),
    /**
     * El concepto del banco, separado de la descripción: es sobre esto que matchean las reglas.
     *
     * ⚠️ **INVARIANTE INV-14, y es lo que sostiene que este campo sea N2 y no N2-R:** se corta de la glosa
     * **ya depurada**, así que tiene que ser **prefijo de `descripcion`**. Hay un `check` en la base que lo
     * exige (`mov_crudo_concepto_prefijo_chk`, migración 0007) — o sea que la garantía no depende de que el
     * adaptador se porte bien.
     *
     * Por qué hace falta: en un banco del roster el 73 % del archivo son `TPUSH <nombre>` y
     * `TRANSF <nombre>`, y su vocabulario trae el sufijo `DOC<11 dígitos>`, que es el **documento de la
     * contraparte**. Sin el invariante, un corte ingenuo mete el identificador de un tercero acá y arrastra
     * la tabla entera al régimen de lectura auditada.
     */
    conceptoBanco: z.string().optional(),
    /**
     * ¿El concepto entró entero, o lo cortó el ancho de la columna?
     *
     * **No es reconstruible después.** `ACREDITAMIENTO` de un banco del roster son **78 movimientos** —el
     * concepto más frecuente del extracto— y con 14 caracteres no se puede saber si está completo. El corte
     * no es por cantidad de caracteres (la fuente del PDF es proporcional): es **geométrico**, y la
     * geometría no se persiste.
     */
    conceptoCompleto: z.boolean().optional(),
    /** De dónde salió el corte de `conceptoBanco`. Ver `ESTRATEGIAS_CONCEPTO`. */
    conceptoBancoEstrategia: z.enum(ESTRATEGIAS_CONCEPTO).optional(),
    conceptoCodigo: z.string().optional(),
    conceptoGrupoCodigo: z.string().optional(),
    /** La columna "Origen" del extracto. Fusionarla con la descripción destruye el identificador. */
    origen: z.string().optional(),

    contraparteNombre: z.string().optional(),
    contraparteBanco: z.string().optional(),
    candidatosIdentificacion: z.array(candidatoIdentificacionSchema).default([]),

    referencias: z
      .array(z.object({ tipo: z.enum(TIPOS_REFERENCIA), valor: z.string().min(1) }))
      .default([]),
    /** La referencia de mayor jerarquía, si el banco publica alguna. **No es clave**: puede faltar. */
    referenciaExterna: z.string().optional(),

    /** La columna del banco. `importe` se DERIVA de esto, no al revés. */
    columnaOrigen: z.enum(['credito', 'debito']),
    credito: importeNoNegativo.optional(),
    debito: importeNoNegativo.optional(),
    /** Derivado y signado: crédito = +, débito = −. El signo es el efecto sobre el saldo del banco. */
    importe,
    saldo: importe.optional(),
    /** Derivado: un saldo acreedor invierte la naturaleza de la cuenta (descubierto). */
    saldoEsAcreedor: z.boolean().optional(),

    moneda: monedaSchema,
    /** Cotización para moneda extranjera. El extracto NO la trae: se declara ausente, no se deduce. */
    cotizacion: importe.optional(),
    cotizacionProvista: z.boolean().default(false),

    /** Índice dentro de su cuenta, 1-based. Para señalar "la fila 143". **No entra en el hash.** */
    filaNumero: z.number().int().positive(),
    paginaPdf: z.number().int().positive(),
    /** Dedupe dentro del cliente y de la cuenta. Ver `hash.ts`. */
    filaHash: z.string().length(64),
  })
  .refine((m) => (m.credito === undefined) !== (m.debito === undefined), {
    message: 'todo movimiento tiene crédito XOR débito',
  })
  .refine(
    (m) =>
      m.columnaOrigen === 'credito' ? m.credito !== undefined : m.debito !== undefined,
    { message: 'columnaOrigen tiene que coincidir con la columna que trae el importe' },
  )
  .refine(
    (m) => (m.credito !== undefined ? m.importe === m.credito : m.importe === `-${m.debito ?? ''}`),
    {
      message:
        'importe tiene que ser el derivado exacto de la columna del banco. Un importe incoherente con ' +
        'su columna no rompe ninguna suma y pasa silencioso: es el modo de falla que este refine cierra',
    },
  )
  /**
   * INV-14, las dos cláusulas que se pueden verificar sin la glosa depurada.
   *
   * La tercera —que `conceptoBanco` sea prefijo de la `descripcion` **depurada**— no se puede chequear acá,
   * porque la depuración ocurre al persistir. Vive en `persistirCuenta` y, como red final, en el `check`
   * `mov_crudo_concepto_prefijo_chk` de la migración 0007.
   */
  .refine(
    (m) =>
      (m.conceptoBanco === undefined) ===
      (m.conceptoBancoEstrategia === undefined ||
        m.conceptoBancoEstrategia === 'no_capturado' ||
        m.conceptoBancoEstrategia === 'no_publicado'),
    {
      message:
        'hay conceptoBanco si y solo si la estrategia declara que se capturó. Un concepto sin estrategia ' +
        'declarada hace indistinguible "el banco no lo publica" de "el adaptador no lo miró"',
    },
  )
  .refine((m) => (m.conceptoBanco === undefined) === (m.conceptoCompleto === undefined), {
    message:
      'conceptoCompleto es un hecho SOBRE el concepto: sin concepto no tiene sujeto, y con concepto es ' +
      'obligatorio. Asumirlo `true` sería afirmar algo que nadie verificó',
  });

export type MovimientoBancarioCrudo = z.infer<typeof movimientoBancarioCrudoSchema>;

// -----------------------------------------------------------------------------
// Anexos: el bloque que NO son movimientos y que igual hay que capturar
// -----------------------------------------------------------------------------

/**
 * El bloque posterior a la línea de totales (consolidado de retenciones e impuestos).
 *
 * **No son movimientos y no se descartan.** Tres razones medidas: cubre **períodos distintos** del
 * extracto (uno coincide con el ciclo del resumen y otros dos son meses calendario completos); incluye un
 * renglón —el importe computable como pago a cuenta— que **no existe como movimiento** y no es derivable
 * de ellos; y cada banco lo publica con un rótulo distinto, así que el que no se captura se pierde.
 *
 * ⚠️ **PROHIBIDO que entre en la suma de movimientos.** Si entra, el impuesto queda contado dos veces y
 * el asiento cuadra igual — que es la peor clase de error de este dominio.
 */
/**
 * De qué cuenta es el anexo. **La atribución NO es posicional en ninguno de los tres bancos medidos**, así
 * que se declara en vez de deducirse.
 */
export const ATRIBUCIONES_ANEXO = [
  /** El banco lo imprime dentro de la sección de la cuenta. `cuentaBancariaId` obligatorio. */
  'publicada_por_cuenta',
  /**
   * El lote tiene **una sola** cuenta, así que la atribución es cierta por aritmética. Va separado de
   * `publicada_por_cuenta` a propósito: la evidencia es distinta, y el día que ese banco mande un archivo
   * de dos cuentas la deducción deja de valer — con un solo valor, ese cambio sería invisible.
   */
  'cuenta_unica_del_lote',
  /** El banco lo publica y **no se puede establecer** de qué cuenta es. `cuentaBancariaId` ausente. */
  'no_determinada',
] as const;
export type AtribucionAnexo = (typeof ATRIBUCIONES_ANEXO)[number];

/**
 * Qué publica el banco sobre el período del anexo. **Cuatro situaciones medidas, no dos.**
 *
 * Hacer las fechas opcionales a secas las aplastaría a una sola y perdería justo lo que este esquema quería
 * proteger: **el bloque cubre períodos DISTINTOS del extracto** (un banco publica tres).
 *
 * 🔴 **El sistema NUNCA rellena el período del anexo con el del extracto.** Sería un hecho fiscal fabricado
 * que cuadra — la misma clase de error que una cotización completada con la de hoy.
 */
export const PERIODOS_ANEXO = [
  /** Las dos fechas impresas. */
  'publicado_completo',
  /** Solo la de cierre: hay una variante medida `DEL PERIODO AL <fecha>`, sin inicio. */
  'publicado_solo_hasta',
  /**
   * El banco **declara** que es el período del extracto sin imprimir fechas (`… en el período de emisión`).
   * **No es lo mismo que `no_publicado`**: acá el banco dice cuál es, y la resolución la hace el Módulo 2
   * explícitamente, nunca un default.
   */
  'periodo_de_emision',
  /** El banco no dice nada del período de ese renglón. */
  'no_publicado',
] as const;
export type PeriodoAnexo = (typeof PERIODOS_ANEXO)[number];

/**
 * ¿El importe de este renglón **ya está** en los movimientos del cuerpo?
 *
 * Es lo que convierte el invariante del doble conteo —*"prohibido que entre en la suma"*, una prohibición
 * que nadie puede chequear— en una **condición sobre una columna**, que sí se testea (INV-15).
 *
 * Medido: el detalle impositivo de un banco resume los 21+19 movimientos del impuesto al cheque y los 8 de
 * SIRCREB **que ya están en el cuerpo**. Sumarlo cuenta el impuesto dos veces y el asiento cuadra igual.
 */
export const RELACIONES_ANEXO = [
  /** Su importe YA está en `movimiento_bancario_crudo`. **Nunca se registra.** */
  'resume_movimientos_del_cuerpo',
  /** El renglón que **no existe** como movimiento: lo único candidato a registración. */
  'no_esta_en_los_movimientos',
  /** El adaptador no lo sabe. Se trata como `resume_…` — fail-closed: no registrar de más. */
  'no_determinada',
] as const;
export type RelacionAnexo = (typeof RELACIONES_ANEXO)[number];

/**
 * El bloque posterior a la línea de totales (consolidado de retenciones e impuestos).
 *
 * **No son movimientos y no se descartan.** Tres razones medidas: cubre **períodos distintos** del
 * extracto; incluye un renglón —el importe computable como pago a cuenta— que **no existe como movimiento**
 * y no es derivable de ellos; y cada banco lo publica con un rótulo distinto, así que el que no se captura
 * se pierde.
 *
 * ⚠️ **PROHIBIDO que entre en la suma de movimientos.** Si entra, el impuesto queda contado dos veces y el
 * asiento cuadra igual — la peor clase de error de este dominio. Por eso el campo se llama
 * `importeDeclarado` y no `importe`: un `sum(importe)` copiado del query de movimientos **no compila**.
 *
 * ## Y por qué esto dejó de ser teórico
 *
 * Corrido contra los tres archivos reales: un banco tenía sus **9 renglones de anexo en el residuo**, otro
 * capturaba **3 de 6**, y el tercero los perdía **sin dejar rastro** —ni en anexos ni en el residuo— porque
 * su adaptador no reporta lo que cae fuera de la región de tabla. El que mejor puntuaba en
 * `lineasNoInterpretadas` era el que más perdía.
 */
export const anexoExtractoSchema = z.object({
  tipoFila: z.literal('anexo'),
  /** El rótulo **tal como lo escribe el banco**. No se normaliza: dos grafías del mismo literal son dos
   *  hechos del documento, y normalizar es trabajo del léxico del Módulo 2, que es código. */
  conceptoLiteral: z.string().min(1),

  /** Ordinal 1-based en orden de lectura. **Es la identidad de la fila**: el anexo no tiene clave natural. */
  ordenEnLote: z.number().int().positive(),
  atribucionCuenta: z.enum(ATRIBUCIONES_ANEXO),

  /**
   * Nullable las dos, según `periodoDato`. Eran obligatorias y el material lo refutó: hay una variante
   * inline **sin fecha de inicio**, y tres de los cinco conceptos del detalle impositivo de otro banco **no
   * traen fechas**.
   */
  periodoDesde: fechaIso.optional(),
  periodoHasta: fechaIso.optional(),
  periodoDato: z.enum(PERIODOS_ANEXO),

  /** **No se llama `importe` a propósito.** Ver la nota del esquema. */
  importeDeclarado: importeNoNegativo,
  moneda: monedaSchema.default('ARS'),

  /**
   * El **literal** publicado, nunca un número parseado: una tasa en float es el mismo error que un importe
   * en float. Y es **N2**, contra la intuición: los bloques de tasas de dos bancos del roster no son
   * alícuotas legales — son la tasa que ese banco le cobra a ese cliente por su descubierto.
   *
   * ## ⚠️ Puede contener MÁS DE UNA alícuota, y por eso nadie lo parsea a ciegas
   *
   * El bloque de tasas de un banco del roster publica **dos** en el mismo renglón —TNA y CFTEA, en columnas
   * distintas (`06-formato-santander.md` §11.3)—, y este campo es uno solo. Se emiten **las dos juntas, en
   * orden de lectura**, porque quedarse con una perdería un dato que el banco publicó.
   *
   * **Decisión (2026-08-10): no se parte en dos columnas todavía.** Partirlo cuesta una columna y una
   * migración, y hoy **nadie calcula con este valor**: el Módulo 2 lo necesitaría para el cómputo del
   * crédito fiscal, y para eso hace falta la fuente normativa que `knowledge/` **no tiene cargada**. Cablear
   * ahora una estructura para un cálculo que todavía no se puede escribir es exactamente lo que este
   * proyecto evita — se parte el día que haya un consumidor real, que además va a decir **cuál** de las dos
   * tasas le importa.
   *
   * Mientras tanto el contrato es: **es texto para mostrar y para auditar, no un número para operar.** Quien
   * lo quiera usar en una cuenta tiene que resolver antes cuántas alícuotas trae y cuál corresponde.
   */
  alicuotaPublicada: z.string().optional(),

  relacionConMovimientos: z.enum(RELACIONES_ANEXO),
  paginaPdf: z.number().int().positive(),
})
  .refine(
    (a) =>
      a.periodoDato === 'publicado_completo'
        ? a.periodoDesde !== undefined && a.periodoHasta !== undefined
        : a.periodoDato === 'publicado_solo_hasta'
          ? a.periodoDesde === undefined && a.periodoHasta !== undefined
          : a.periodoDesde === undefined && a.periodoHasta === undefined,
    {
      message:
        'las fechas tienen que ser coherentes con periodoDato. Mismo predicado que el check ' +
        'anexo_periodo_coherencia_chk de la migración 0008: dos listas del mismo dominio divergen',
    },
  )
  .refine(
    (a) => a.periodoDesde === undefined || a.periodoHasta === undefined || a.periodoHasta >= a.periodoDesde,
    { message: 'el período del anexo no puede terminar antes de empezar' },
  );
export type AnexoExtracto = z.infer<typeof anexoExtractoSchema>;

// -----------------------------------------------------------------------------
// Verificación — códigos, tri-estado, y calculada por función pura
// -----------------------------------------------------------------------------

/** Códigos de diferencia. **Nunca prosa**: la prosa con valores adentro llega a un log. */
export const CODIGOS_DIFERENCIA = [
  'ARIT_TOTAL_CREDITOS',
  'ARIT_TOTAL_DEBITOS',
  'ARIT_SALDO_FINAL',
  'ARIT_SALDO_INICIAL',
  'ARIT_CADENA_ROTA',
  'ARIT_SIGNO_INVERTIDO',
  'ARIT_IMPORTE_INCOHERENTE',
  'EST_FECHA_FUERA_DE_PERIODO',
  'EST_FECHA_NO_MONOTONA',
  'EST_PAGINA_FALTANTE',
  'EST_PAGINAS_DECLARADAS_NO_COINCIDEN',
  'EST_LINEA_NO_INTERPRETADA',
  'EST_HASH_DUPLICADO',
  'EST_MONEDA_MEZCLADA',
  'EST_SIN_MOVIMIENTOS',
  /**
   * INV-multicuenta: el consolidado por moneda de la carátula **no coincide** con la suma de los saldos
   * finales de las cuentas de esa moneda. Ver `verificarConsolidadoPorMoneda`.
   */
  'EST_CONSOLIDADO_MONEDA',
  /**
   * El documento **declara** N cuentas y el adaptador leyó otra cantidad. Ver `verificarConteoDeCuentas`.
   *
   * Es el único control que ve una cuenta que **nunca se abrió**: si su saldo final es `0,00`, no mueve el
   * consolidado, no rompe ninguna cadena, y desaparece del sistema con todo cerrando.
   */
  'EST_CUENTAS_NO_COINCIDEN',
  /**
   * A2 (C5): el adaptador **declara** que clasifica destinos (`capacidades.declaraDestinos: true`) y la
   * salida no trae `destinos`. Mismo precedente que `EST_CONSOLIDADO_MONEDA`/`consolidado_no_encontrado`:
   * la declaración existe para que "todavía no lo instrumenté" y "el adaptador dejó de mandar el conteo"
   * no se vean igual. Ver `verificarDestinos` (`verificacion/invariantes.ts`).
   */
  'EST_DESTINOS_NO_DECLARADOS',
  /**
   * A2 (C5): `destinos.sinDestino > 0` — quedó una fila que ninguna rama del lector clasificó en uno de
   * los `DESTINOS_BASE` (`toolkit.ts`). La partición que `contarDestinos` mide no cerró: es un hueco en
   * el lector, no un dato del documento. Ver `verificarDestinos`.
   */
  'EST_DESTINOS_SIN_CLASIFICAR',
] as const;
export type CodigoDiferencia = (typeof CODIGOS_DIFERENCIA)[number];

/**
 * Los valores posibles de `Diferencia.campo`. **Vocabulario cerrado, y eso es una defensa, no un prolijo.**
 *
 * Era `z.string()` abierto: el único agujero de texto libre de un objeto que por lo demás está cerrado
 * (`codigo` es enum, `filaNumero` y `paginaPdf` son enteros). Y por ese agujero salen **tres canales**:
 *
 *   1. el log del CLI, que además **prefiere `campo` sobre `codigo`** al armar la línea;
 *   2. `lote_ingesta_cuenta.verificacion_detalle`, clasificado **N1** en el registro de campos con la nota
 *      *"NINGUNA diferencia lleva un valor"* — una clasificación que era cierta **por convención**;
 *   3. el stdout de `probar-galicia.ts`, que corre **sobre el material real**.
 *
 * Y las tres capas del logger fallan si alguna vez lleva un valor: la clave no está en el blocklist, el CLI
 * usa el logger genérico, y el detector de importes está limitado al formato local `1.234,56` — la forma
 * canónica del proyecto (`-98765.43`) **pasa entera**.
 *
 * Con el enum, un `campo: \`esperado_${suma}\`` **no compila**. Es la diferencia entre que el nivel N1 de
 * `verificacion_detalle` sea una afirmación y que sea una propiedad del tipo.
 */
export const CAMPOS_DIFERENCIA = [
  /** V2: el banco declara totales y el parser no los encontró. */
  'totales_no_encontrados',
  /** V5': el saldo de la última fila contra el declarado (redundante con V4, a propósito). */
  'ultimo_saldo',
  // INV-multicuenta — los cinco modos de `EST_CONSOLIDADO_MONEDA`. Ver `verificarConsolidadoPorMoneda`.
  'consolidado_no_encontrado',
  'consolidado_duplicado',
  'consolidado_ilegible',
  'moneda_sin_cuenta',
  'moneda_sin_consolidado',
  'saldo_final_ausente',
] as const;
export type CampoDiferencia = (typeof CAMPOS_DIFERENCIA)[number];

export const diferenciaSchema = z.object({
  codigo: z.enum(CODIGOS_DIFERENCIA),
  severidad: z.enum(['error', 'observacion']),
  /** Dónde. Es lo que hace depurable el hallazgo sin publicar ningún valor. */
  filaNumero: z.number().int().positive().optional(),
  paginaPdf: z.number().int().positive().optional(),
  /** Qué chequeo, de un vocabulario **cerrado**. Ver `CAMPOS_DIFERENCIA`: nunca un valor. */
  campo: z.enum(CAMPOS_DIFERENCIA).optional(),
});
export type Diferencia = z.infer<typeof diferenciaSchema>;

export const ESTADOS_VERIFICACION = ['cuadra', 'no_cuadra', 'no_verificable'] as const;

/**
 * El resultado de la verificación.
 *
 * **`estado` es un tri-estado y no dos booleanos**, y la diferencia es la mitad del valor: un booleano en
 * `false` no distingue "no cuadra" de "no se pudo verificar". Y con dos booleanos,
 * `hayTotales: false` + `cuadra: true` era un objeto **válido**: el verde-por-vacío estaba en el contrato.
 *
 * `no_verificable` **exige** entrada en el roster de bancos con el motivo escrito, y un test falla si la
 * cantidad de `no_verificable` crece sin que crezca la lista de motivos. Sin eso, en tres sprints todos
 * los bancos están ahí.
 */
export const verificacionSchema = z.object({
  estado: z.enum(ESTADOS_VERIFICACION),

  cantidadMovimientos: z.number().int().nonnegative(),
  totalCreditosCalculado: importeNoNegativo,
  totalDebitosCalculado: importeNoNegativo,
  saldoFinalCalculado: importe.optional(),

  /** Qué se pudo verificar y qué no aplicaba, según las capacidades declaradas del banco. */
  verificoTotales: z.boolean(),
  verificoSaldos: z.boolean(),
  verificoCadena: z.boolean(),
  cadenaDeSaldosUsada: z.enum(CADENAS_DE_SALDOS),
  /** Filas donde la cadena se rompe. Es lo que convierte "no cuadra" en "se rompe en la fila 143". */
  filasConRuptura: z.array(z.number().int().positive()),

  paginasConEncabezado: z.number().int().nonnegative(),
  paginasSinMovimientos: z.number().int().nonnegative(),
  coberturaDeLineasCompleta: z.boolean(),
  fechasDentroDelPeriodo: z.boolean(),
  fechasMonotonas: z.boolean(),

  diferencias: z.array(diferenciaSchema),
});
export type Verificacion = z.infer<typeof verificacionSchema>;

// -----------------------------------------------------------------------------
// Resultado del parseo
// -----------------------------------------------------------------------------

export const cuentaConMovimientosSchema = z.object({
  cuenta: cuentaDetectadaSchema,
  movimientos: z.array(movimientoBancarioCrudoSchema),
  anexos: z.array(anexoExtractoSchema).default([]),
});
export type CuentaConMovimientos = z.infer<typeof cuentaConMovimientosSchema>;

/**
 * El saldo consolidado **por moneda** que el banco imprime en la carátula.
 *
 * ## Es el único control que detecta que se mezcló, se perdió o se duplicó una cuenta
 *
 * Toda la demás aritmética del documento —la cadena de saldos, la ecuación de la cuenta, los totales— se
 * calcula **dentro** de una cuenta, así que cierra igual si el adaptador se comió la separación. Medido en
 * el tercer banco (`07-formato-macro.md` §14.4-bis): mezclar sus tres cuentas da **1 ruptura sobre 1346 =
 * 0,07 %**. Pasa cualquier umbral de tolerancia, "casi cuadra", y deja **una cuenta inexistente con dos
 * saldos encimados**.
 *
 * El consolidado es la única ecuación que **cruza** cuentas, y por eso es la única que no cierra cuando la
 * sectorización está mal. **No tiene equivalente en el primer banco del roster**, que trae una sola cuenta.
 *
 * El importe es **signado**: una cuenta en descubierto consolida negativo.
 */
export const consolidadoPorMonedaSchema = z.object({
  moneda: monedaSchema,
  importe,
  paginaPdf: z.number().int().positive().optional(),
});
export type ConsolidadoPorMoneda = z.infer<typeof consolidadoPorMonedaSchema>;

export const lineaNoInterpretadaSchema = z.object({
  codigo: z.enum([
    'fila_sin_importe',
    'importe_en_columna_desconocida',
    'fecha_ilegible',
    'linea_fuera_de_zona',
    'columna_sin_ancla',
    'pdf_sin_texto',
    'desconocido',
  ]),
  paginaPdf: z.number().int().positive(),
  indice: z.number().int().nonnegative(),
  /**
   * ⚠️ **La FORMA de la línea, nunca la línea.** Dígitos a `9`, mayúsculas a `A`, minúsculas a `a`.
   * Alcanza para arreglar el adapter y no contiene ni un dato — y es lo único que se puede loguear.
   * El texto crudo, si hace falta, vive en la tabla satélite N2R, nunca acá.
   */
  forma: z.string(),
});
export type LineaNoInterpretada = z.infer<typeof lineaNoInterpretadaSchema>;

export const extractoParseadoSchema = z.object({
  bancoCodigo: z.string().min(1),
  adaptadorVersion: z.number().int().positive(),
  capacidades: capacidadesAdaptadorSchema,
  /** sha256 del archivo: idempotencia del lote. */
  archivoHash: z.string().length(64),
  paginas: z.number().int().positive(),
  /** Lo que el propio documento dice que tiene. Contado ≠ declarado significa **faltan hojas**. */
  paginasDeclaradas: z.number().int().positive().optional(),
  /** Por página, no por promedio: un PDF mixto con 40 páginas escaneadas promedia por encima del umbral. */
  paginasSinTexto: z.array(z.number().int().positive()),
  cuentas: z.array(cuentaConMovimientosSchema),
  /**
   * Lo que la carátula declara **por moneda**, para todo el archivo. Vacío en el banco que no lo publica —
   * y esa ausencia se lee como "no hay INV-multicuenta que correr", no como "cuadra".
   */
  consolidadosPorMoneda: z.array(consolidadoPorMonedaSchema).default([]),
  lineasNoInterpretadas: z.array(lineaNoInterpretadaSchema),
});
export type ExtractoParseado = z.infer<typeof extractoParseadoSchema>;

// -----------------------------------------------------------------------------
// El lote — el vocabulario cerrado de la tabla `lote_ingesta`
// -----------------------------------------------------------------------------

/**
 * Los dos estados con los que un lote queda **con filas adentro**.
 *
 * Va separado de `ESTADOS_LOTE` porque es el tipo de retorno de `estadoSegunVerificacion`: la persistencia
 * **no puede** devolver `recibido` (todavía no leyó nada) ni `con_errores` (ese camino no persiste ninguna
 * fila). Antes era una unión literal repetida a mano en tres firmas de `persistir.ts` más una variable del
 * CLI — la misma clase de duplicación que este bloque existe para cerrar, un nivel más abajo.
 */
export const ESTADOS_LOTE_PERSISTIDO = ['procesado', 'procesado_con_observaciones'] as const;
export type EstadoLotePersistido = (typeof ESTADOS_LOTE_PERSISTIDO)[number];

/**
 * Los cuatro estados de `lote_ingesta.estado` (`lote_ingesta_estado_chk`, migración `0004`).
 *
 * **Esta constante no existía.** Era una de las dos listas cerradas del Módulo 1 sin contraparte en
 * TypeScript: los cuatro valores vivían como literales sueltos en `apps/cli/src/ingestar.ts` y en las firmas
 * de `packages/ingesta/src/persistir.ts`. Sin una lista contra la cual comparar, el test de catálogo no
 * tenía **nada** que verificar del check que más se escribe del módulo — el que toca todos los lotes, dos
 * veces cada uno.
 *
 * La composición con el spread de `ESTADOS_LOTE_PERSISTIDO` es deliberada: si los dos estados persistidos se
 * repitieran acá a mano, la lista de cuatro y la de dos podrían divergir **entre sí**, que es exactamente el
 * problema que se está resolviendo contra la base.
 *
 * `rechazado` **no** es uno de ellos: un lote rechazado queda `con_errores` con su `motivo_codigo`, y el
 * rechazo se asienta además en `acceso_auditoria` con `accion = 'rechazo'`.
 */
export const ESTADOS_LOTE = ['recibido', ...ESTADOS_LOTE_PERSISTIDO, 'con_errores'] as const;
export type EstadoLote = (typeof ESTADOS_LOTE)[number];

/**
 * De dónde entró el archivo (`lote_ingesta.origen`, `lote_ingesta_origen_chk` de la migración `0004`).
 *
 * También faltaba. Hoy el único emisor es el CLI y siempre escribe `archivo`; los otros dos valores están en
 * la base desde `0004` porque el plan los contempla. Declararlos acá es lo que hace que el día que exista la
 * casilla, el valor salga de un tipo y no de una cadena escrita adentro de un `insert` — donde ni el
 * typecheck ni el check de la base avisan hasta que el insert corre.
 */
export const ORIGENES_LOTE = ['archivo', 'casilla', 'api'] as const;
export type OrigenLote = (typeof ORIGENES_LOTE)[number];
