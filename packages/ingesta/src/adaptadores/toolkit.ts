/**
 * TOOLKIT DE LAYOUT — lo que el segundo y el tercer banco confirmaron que es compartido.
 *
 * ## La regla que se aplicó acá, y su resultado
 *
 * La versión anterior de este encabezado decía: *"esto se escribió antes de tener dos bancos, y el primero
 * casi no lo usa; **el segundo y el tercer banco deciden qué de acá sobrevive**"*. Ya se midieron los dos
 * (`06-formato-santander.md`, `07-formato-macro.md`) y este es el veredicto:
 *
 * | Función | Usuarios medidos | Veredicto |
 * |---|---|---|
 * | `valorPorEtiqueta` | Galicia (alta de cuenta), Santander (`CBU:`, `CUIT:`, `Acuerdo:`) | **queda** |
 * | `extraerPeriodo` | Galicia, Macro (anclado en la etiqueta) | **queda** |
 * | `clasificarRuido` / `particionar` / `agruparEnFilas` / `residuoDeParticion` / `RUIDO_COMUN` | **CERO en los tres bancos.** Santander las **nombra** en dos comentarios y no importa ninguna | **se deciden con el cuarto** |
 * | **`inferirCortes` / `cortarEnColumnas`** | **CERO en los tres bancos** | **se borran con el cuarto** |
 *
 * **Cola de anexo con rótulo partido — Macro y Santander, NO generalizada a propósito.** Los dos bancos
 * tienen la misma familia de problema (un rótulo de anexo que se parte en una línea de más), con mecánicas
 * de apareo genuinamente distintas: Macro cruza el corte de página y consume por cola FIFO sobre el
 * **documento entero** (`macro.ts`, `leerAnexosDelLote`); Santander está acotado a la **misma página** y al
 * rótulo **inmediato anterior** (`santander.ts`, `RE_COLA_PERIODO_DE_EMISION`). Forzar una función común con
 * dos casos que ya divergen en su regla de apareo es la misma trampa que ya evitó este archivo con una sola
 * implementación (revisión de Parte B de la quinta cara, 2026-08-10) — se deja anotado acá para que la
 * próxima vez que aparezca (un tercer banco con "rótulo con cola") el criterio no se decida a ciegas.
 *
 * 🔴 La primera fila decía *"Santander los ejercita"* y era **falso**: los tres adaptadores construyen su
 * autómata a mano. Queda escrito porque es el error que sostiene una abstracción muerta durante cinco
 * bancos más — y porque **esta tabla es el documento con el que se toma esa decisión**. Un encabezado
 * equivocado acá no es un comentario desactualizado: es el criterio de borrado apuntando al lado que no es.
 *
 * `inferirCortes` asume **columnas de ancho fijo en caracteres**, y los tres bancos medidos coinciden en que
 * eso no existe: `pdf.js` emite **un solo espacio por hueco**, sin importar que el hueco mida 5 pt o 236 pt.
 * Macro lo confirmó con el número más duro posible: **0 líneas con dos espacios consecutivos sobre 2955**.
 * Sigue acá con tests verdes contra el fixture sintético —que sí tiene ancho fijo— o sea que **el fixture
 * valida un layout que ningún banco del roster tiene**. Se borra al confirmarlo con el cuarto banco, no
 * antes: borrar sobre tres es una conclusión, borrar sobre uno era una corazonada.
 *
 * Las cuatro funciones nuevas (`periodoPorEtiquetas`, `regionesDeTabla`, `parDeColumnas`,
 * `seccionesPorClave`) entran por la misma regla, del otro lado: **cada una nació de un archivo real que sin
 * ella se lee mal**, y cada una dice de cuál en su comentario.
 *
 * La regla sigue en pie para lo que venga: no se "mejora" una función de este archivo para que le sirva a un
 * banco. Eso es exactamente cómo un cambio para uno rompe a otro, que es lo que la arquitectura por banco
 * existe para evitar. Lo que un banco necesita distinto se **parametriza** (ver `parDeColumnas`) o vive en su
 * adaptador.
 *
 * ## Lo que SÍ es infraestructura compartida, y no está acá
 *
 * `texto-pdf.ts` (extracción y geometría), `parseo-ar.ts` (importes y fechas), `verificacion/invariantes.ts`
 * (la aritmética), `persistir.ts`, y el pipeline de controles del CLI. Eso lo usan todos los bancos por
 * construcción — y **los controles no se duplican por banco a propósito**: ocho copias de INV-6 son ocho
 * oportunidades de que a una le falte.
 *
 * Cada función de este archivo es **pura y determinística**. Ninguna toca disco, ninguna loguea, ninguna
 * decide si el extracto cuadra.
 */

import {
  centavosAImporte,
  importeACentavos,
  normalizar,
  parsearFecha,
  type ImporteCanonico,
} from '../parseo-ar.ts';
import { fragmentoEnVentanaDerecha, type FilaGeometrica } from '../texto-pdf.ts';
// `sinEstado` vivía acá, duplicada peor en `tools/barrido-fuga.ts` (esa copia tapaba `g` y dejaba pasar
// `y`). Un solo lugar, en `packages/shared`, importado por los dos.
import { sinEstado } from '@sistema-contable/shared/seguridad';

// -----------------------------------------------------------------------------
// Carátula: leer POR ETIQUETA, nunca por patrón
// -----------------------------------------------------------------------------

/**
 * Busca el valor que sigue a una etiqueta.
 *
 * ## Por qué por etiqueta y no por patrón
 *
 * Buscar "el primer número de 22 dígitos del documento" para encontrar el CBU parece equivalente y no lo
 * es: el extracto real del piloto tiene **113 corridas de once dígitos** en el cuerpo (los CUIT de las
 * contrapartes). Un patrón sin etiqueta encuentra el identificador de un tercero y lo toma por el del
 * titular — y el resultado es un extracto asignado a la cuenta equivocada, con todo cuadrando.
 *
 * La etiqueta la imprime el banco y está en la carátula. Es la única ancla confiable.
 *
 * @param lineas las líneas del documento, en orden
 * @param etiquetas variantes de la etiqueta (los bancos cambian "Nro." por "N°" entre versiones)
 * @param patronValor qué forma tiene el valor. Se busca DESPUÉS de la etiqueta, en la misma línea
 * @param maxLineasAdelante si el valor puede estar en una línea siguiente (algunos layouts lo parten)
 */
export function valorPorEtiqueta(
  lineas: readonly string[],
  etiquetas: readonly string[],
  patronValor: RegExp,
  maxLineasAdelante = 0,
): { readonly valor: string; readonly linea: number } | null {
  const etiquetasNormalizadas = etiquetas.map((e) => normalizar(e));

  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i] ?? '';
    const normalizada = normalizar(linea);

    for (const [j, etiqueta] of etiquetasNormalizadas.entries()) {
      const posicion = normalizada.indexOf(etiqueta);
      if (posicion === -1) continue;

      // Se busca en el texto ORIGINAL, no en el normalizado: `normalizar` quita acentos y colapsa
      // espacios, así que las posiciones no coinciden y el valor saldría cortado.
      const original = etiquetas[j] ?? '';
      const posOriginal = buscarIgnorandoAcentos(linea, original);
      const resto = posOriginal === -1 ? linea : linea.slice(posOriginal + original.length);

      const re = sinEstado(patronValor);
      const m = re.exec(resto);
      if (m?.[0]) return { valor: m[0], linea: i };

      // El valor puede estar en las líneas siguientes.
      for (let k = 1; k <= maxLineasAdelante && i + k < lineas.length; k += 1) {
        const siguiente = re.exec(lineas[i + k] ?? '');
        if (siguiente?.[0]) return { valor: siguiente[0], linea: i + k };
      }
    }
  }
  return null;
}

/** Índice de `aguja` en `texto`, ignorando acentos y mayúsculas, preservando las posiciones originales. */
export function buscarIgnorandoAcentos(texto: string, aguja: string): number {
  const plano = (s: string): string =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  return plano(texto).indexOf(plano(aguja));
}

// -----------------------------------------------------------------------------
// Columnas de ancho fijo: inferir los cortes en vez de hardcodearlos
// -----------------------------------------------------------------------------

/**
 * Infiere las posiciones de corte de un layout de ancho fijo.
 *
 * ## El razonamiento
 *
 * En un layout de columnas, hay posiciones de carácter donde **todas** las filas tienen un espacio: son los
 * canales entre columnas. Las posiciones donde alguna fila tiene un carácter son contenido. Encontrar los
 * canales es encontrar las columnas.
 *
 * ## Por qué inferirlos y no hardcodearlos
 *
 * Los índices a mano funcionan hasta que el banco corre una columna dos caracteres en la versión siguiente
 * del resumen. Y cuando eso pasa, el parser no falla: lee la fecha cortada, el importe cortado, y produce
 * filas que **casi** están bien. Inferirlos hace que el adaptador se adapte a ese cambio, y que si el
 * layout cambió de verdad, no encuentre canales y falle ruidoso.
 *
 * @param filas solo las líneas que SON movimientos (el encabezado y el ruido corren los canales)
 * @param minAnchoCanal cuántos espacios consecutivos hacen un canal. Uno solo aparece dentro de una glosa
 */
export function inferirCortes(filas: readonly string[], minAnchoCanal = 2): readonly number[] {
  if (filas.length === 0) return [];

  const largo = Math.max(...filas.map((f) => f.length));
  // `esCanal[i]` = todas las filas tienen espacio (o terminaron) en la posición i.
  const esCanal: boolean[] = [];
  for (let i = 0; i < largo; i += 1) {
    esCanal.push(filas.every((f) => i >= f.length || f[i] === ' '));
  }

  const cortes: number[] = [];
  let inicioCanal = -1;
  for (let i = 0; i <= largo; i += 1) {
    const canal = i < largo ? (esCanal[i] ?? false) : false;
    if (canal && inicioCanal === -1) inicioCanal = i;
    if (!canal && inicioCanal !== -1) {
      if (i - inicioCanal >= minAnchoCanal) {
        // El corte va al MEDIO del canal: así un dígito que se corre un carácter sigue cayendo en su
        // columna. Cortar en el borde deja el layout al filo de romperse por un espacio.
        cortes.push(Math.floor((inicioCanal + i) / 2));
      }
      inicioCanal = -1;
    }
  }
  return cortes;
}

/** Corta una línea en los índices dados. Los tramos vienen con `trim`. */
export function cortarEnColumnas(linea: string, cortes: readonly number[]): readonly string[] {
  const salida: string[] = [];
  let desde = 0;
  for (const corte of cortes) {
    salida.push(linea.slice(desde, corte).trim());
    desde = corte;
  }
  salida.push(linea.slice(desde).trim());
  return salida;
}

// -----------------------------------------------------------------------------
// Agrupar: la glosa que sigue en la línea de abajo
// -----------------------------------------------------------------------------

export type FilaAgrupada = {
  /** La línea que inicia el movimiento. */
  readonly principal: string;
  /** Las líneas de continuación, en orden. Su contenido va a la glosa o a las referencias. */
  readonly continuaciones: readonly string[];
  /** Índice de la línea principal en el arreglo original: sirve para reportar dónde falló algo. */
  readonly indice: number;
  readonly pagina: number;
};

/**
 * Agrupa cada movimiento con sus líneas de continuación.
 *
 * ## Por qué esto es una función aparte y no un `if` dentro del adaptador
 *
 * Es la fuente de **dos errores opuestos**, y los dos producen un resultado plausible:
 *
 *   - tomar una continuación por un movimiento nuevo → **inventa una fila** (el conteo sube, y como la
 *     continuación no tiene importe, la fila entra con importe cero o con basura);
 *   - ignorar la continuación → **pierde la referencia** de la operación, que es justamente el dato con el
 *     que el Módulo 2 va a matchear el tercero.
 *
 * ## El bug que tenía la primera versión, medido
 *
 * La primera versión trataba **toda** línea que no empezaba con fecha como continuación del movimiento
 * anterior. Sobre el fixture eso metió, adentro de la glosa de 9 de las 80 filas, el **encabezado de la
 * página siguiente**, la **línea de totales**, el **saldo final** y la **carátula de la segunda cuenta**.
 *
 * Y el test pasaba, porque su única aserción era `filas.length === 80`. O sea: el peor modo de falla del
 * módulo —la glosa corrida, §6.4— ocurriendo en el caso base, con un test verde encima.
 *
 * De ahí el tercer parámetro. Una línea de **ruido corta el bloque**: no se absorbe ni arrastra a las que
 * vienen después. Es la diferencia entre "esta línea no empieza con fecha" y "esta línea es la
 * continuación de un movimiento", que no son lo mismo aunque en el caso fácil coincidan.
 *
 * @param esInicioDeFila el criterio del banco. Casi siempre "hay fecha en la columna de fecha"
 * @param esRuido corta el bloque. Sin esto, el encabezado de la página siguiente entra en la glosa
 */
export function agruparEnFilas(
  lineas: readonly { readonly texto: string; readonly pagina: number }[],
  esInicioDeFila: (texto: string) => boolean,
  esRuido: (texto: string) => boolean = () => false,
): readonly FilaAgrupada[] {
  const filas: FilaAgrupada[] = [];
  /** Si la última fila sigue abierta a continuaciones. Una línea de ruido la cierra. */
  let bloqueAbierto = false;

  for (const [i, linea] of lineas.entries()) {
    if (esInicioDeFila(linea.texto)) {
      filas.push({
        principal: linea.texto,
        continuaciones: [],
        indice: i,
        pagina: linea.pagina,
      });
      bloqueAbierto = true;
      continue;
    }

    if (esRuido(linea.texto)) {
      // Se descarta **sin absorberla** y sin cerrar el bloque.
      //
      // No cierra porque el ruido estructural aparece en medio de un movimiento: cuando una glosa
      // continúa en la página siguiente, entre el movimiento y su continuación hay un encabezado. Cerrar
      // ahí dejaría esa continuación huérfana — y perder la referencia de la operación es el otro de los
      // dos errores opuestos, no la solución al primero.
      continue;
    }

    const ultima = filas.at(-1);
    if (ultima === undefined || !bloqueAbierto) {
      // Una continuación antes del primer movimiento, o después de un corte, no es una continuación: es
      // carátula, encabezado o algo que el adaptador no entendió. El llamador la ve en
      // `lineasNoInterpretadas`, que es donde tiene que estar para que no se pierda en silencio.
      continue;
    }
    filas[filas.length - 1] = {
      ...ultima,
      continuaciones: [...ultima.continuaciones, linea.texto],
    };
  }

  return filas;
}

/**
 * Partición completa de las líneas del documento. **La ecuación tiene que cerrar.**
 *
 * ## Por qué la partición se CUENTA y no se declara
 *
 * `verificarAritmetica` recibe `coberturaDeLineasCompleta` por su contexto, o sea que hoy **la declara el
 * adaptador**. Eso es exactamente el autocertificado que el contrato prohíbe para los totales: un adaptador
 * que se comió el encabezado en la glosa reporta cobertura completa y residuo cero, con razón desde su
 * punto de vista y falso desde el del documento.
 *
 * Esta función devuelve el recuento **por destino**, para que un tercero pueda verificar
 *
 *     Σ(1 + continuaciones) + ruido + noInterpretadas === lineas.length
 *
 * sin preguntarle nada al adaptador. Si la cuenta no cierra, hay líneas que se perdieron en el camino — y
 * "se perdieron en silencio" es el modo de falla que este módulo entero existe para evitar.
 */
/**
 * Tipos de ruido que **cierran** el bloque de glosa.
 *
 * La distinción salió de una línea del fixture que quedaba sin explicar: una glosa que continúa **después
 * del corte de página**, o sea con el encabezado de la página nueva en el medio. Eso es un caso legítimo y
 * frecuente en un extracto real.
 *
 * Así que el ruido se parte en dos clases:
 *
 *   - **transparente** (encabezado, pie, separador, línea vacía, leyenda legal): aparece *dentro* de la
 *     tabla y no significa que el movimiento haya terminado. Se descarta y el bloque sigue abierto.
 *   - **de corte** (totales, carátula): marca el **fin de la sección**. Lo que venga después no puede ser
 *     la continuación del último movimiento.
 *
 * Sin esta distinción hay que elegir entre perder continuaciones o absorber encabezados, y las dos
 * opciones son errores.
 */
export const RUIDO_QUE_CIERRA_BLOQUE: readonly TipoDeRuido[] = ['totales', 'caratula'];

export type Particion = {
  readonly filas: readonly FilaAgrupada[];
  /** Por tipo de ruido, para poder decir *qué* se descartó y no solo cuánto. */
  readonly ruido: Readonly<Record<TipoDeRuido, number>>;
  /** Índices de las líneas que ninguna regla explicó. Van a `lineasNoInterpretadas`. */
  readonly noInterpretadas: readonly number[];
  readonly totalLineas: number;
};

export function particionar(
  lineas: readonly { readonly texto: string; readonly pagina: number }[],
  esInicioDeFila: (texto: string) => boolean,
  reglas: readonly ReglaDeRuido[],
  esContinuacion: (texto: string) => boolean,
): Particion {
  const ruido: Record<TipoDeRuido, number> = {
    encabezado: 0,
    pie: 0,
    leyenda_legal: 0,
    separador: 0,
    vacia: 0,
    totales: 0,
    caratula: 0,
  };
  const noInterpretadas: number[] = [];
  const filas: FilaAgrupada[] = [];
  let bloqueAbierto = false;

  for (const [i, linea] of lineas.entries()) {
    if (esInicioDeFila(linea.texto)) {
      filas.push({ principal: linea.texto, continuaciones: [], indice: i, pagina: linea.pagina });
      bloqueAbierto = true;
      continue;
    }

    const clase = clasificarRuido(linea.texto, reglas);
    if (clase !== null) {
      ruido[clase.tipo] += 1;
      // Solo el ruido de CORTE cierra el bloque. Ver `RUIDO_QUE_CIERRA_BLOQUE`.
      if (RUIDO_QUE_CIERRA_BLOQUE.includes(clase.tipo)) bloqueAbierto = false;
      continue;
    }

    const ultima = filas.at(-1);
    if (bloqueAbierto && ultima !== undefined && esContinuacion(linea.texto)) {
      filas[filas.length - 1] = {
        ...ultima,
        continuaciones: [...ultima.continuaciones, linea.texto],
      };
      continue;
    }

    // Ni movimiento, ni ruido conocido, ni continuación reconocible. Se reporta: es el residuo, y el
    // residuo es el dato más importante para saber si el adaptador entendió el documento.
    noInterpretadas.push(i);
  }

  return { filas, ruido, noInterpretadas, totalLineas: lineas.length };
}

/**
 * Verifica que la partición cubra todas las líneas. Devuelve el faltante, o `0` si cierra.
 *
 * Se calcula desde la partición, no desde lo que el adaptador diga: es el chequeo que hace que la cobertura
 * sea un hecho medido y no una afirmación.
 */
export function residuoDeParticion(p: Particion): number {
  const enFilas = p.filas.reduce((n, f) => n + 1 + f.continuaciones.length, 0);
  const enRuido = Object.values(p.ruido).reduce((n, x) => n + x, 0);
  return p.totalLineas - (enFilas + enRuido + p.noInterpretadas.length);
}

// -----------------------------------------------------------------------------
// Ruido: descartar, pero nunca en silencio
// -----------------------------------------------------------------------------

export const TIPOS_DE_RUIDO = [
  'encabezado',
  'pie',
  'leyenda_legal',
  'separador',
  'vacia',
  'totales',
  'caratula',
] as const;
export type TipoDeRuido = (typeof TIPOS_DE_RUIDO)[number];

export type ReglaDeRuido = {
  readonly tipo: TipoDeRuido;
  readonly patron: RegExp;
  /** Por qué esta línea no es un movimiento. Se escribe para que la regla se pueda discutir. */
  readonly motivo: string;
};

/**
 * Clasifica una línea como ruido, o devuelve `null` si podría ser un movimiento.
 *
 * **Devolver el tipo y no un booleano** es deliberado: `totales` y `caratula` son ruido para el cuerpo pero
 * son **datos** para la verificación. Un `esRuido(): boolean` obligaría a buscarlos dos veces, y la segunda
 * búsqueda es donde se pierde la línea de totales de un banco que la escribe distinto.
 */
export function clasificarRuido(
  linea: string,
  reglas: readonly ReglaDeRuido[],
): { readonly tipo: TipoDeRuido; readonly motivo: string } | null {
  if (linea.trim().length === 0) {
    return { tipo: 'vacia', motivo: 'Línea en blanco.' };
  }
  for (const r of reglas) {
    const re = sinEstado(r.patron);
    if (re.test(linea)) return { tipo: r.tipo, motivo: r.motivo };
  }
  return null;
}

/**
 * Reglas de ruido que aparecen en **todos** los bancos del roster. Un adaptador las extiende con las suyas.
 */
export const RUIDO_COMUN: readonly ReglaDeRuido[] = [
  {
    tipo: 'separador',
    patron: /^[\s\-_=*.]+$/,
    motivo: 'Línea de guiones o puntos: separador visual, no tiene contenido.',
  },
  {
    tipo: 'pie',
    patron: /^\s*(?:P[áa]gina|Pag\.?|Hoja)\s+\d+/i,
    motivo: 'Numeración de página.',
  },
  {
    tipo: 'encabezado',
    patron: /^\s*Fecha\s+(?:Concepto|Descripci[óo]n|Detalle|Movimiento)/i,
    motivo: 'Fila de títulos de columna. Se repite en cada página.',
  },
];

// -----------------------------------------------------------------------------
// Períodos
// -----------------------------------------------------------------------------

/**
 * Extrae un período de un texto donde las dos fechas pueden venir **pegadas sin separador**.
 *
 * Ese caso está en el material real y rompe cualquier `split`: `01/06/202630/06/2026` parece una sola fecha
 * larga. Se resuelve con un patrón que toma dos fechas completas consecutivas sin exigir nada entre ellas.
 */
export function extraerPeriodo(
  texto: string,
): { readonly desde: string; readonly hasta: string } | null {
  const re =
    /(\d{2})[/\-.](\d{2})[/\-.](\d{2,4})\s*(?:a(?:l)?|hasta|-|—)?\s*(\d{2})[/\-.](\d{2})[/\-.](\d{2,4})/;
  const m = re.exec(texto);
  if (!m) return null;

  const iso = (d: string, mes: string, a: string): string => {
    const anio = a.length === 2 ? `20${a}` : a;
    return `${anio}-${mes}-${d}`;
  };

  const primera = iso(m[1] ?? '', m[2] ?? '', m[3] ?? '');
  const segunda = iso(m[4] ?? '', m[5] ?? '', m[6] ?? '');

  /**
   * **Se toma min y max, no "la primera es desde".**
   *
   * La primera versión rechazaba el período invertido, razonando que era un parseo mal hecho. El archivo
   * real lo refutó: `pdf.js` emite en orden de content-stream, y el banco del piloto emite las dos fechas
   * **en orden `[hasta, desde]`** — la de la izquierda visual sale segunda. Así que el control rechazaba el
   * caso normal, y el período caía a un fallback sin que nadie lo notara.
   *
   * El orden de emisión no es una propiedad del documento, es un detalle del extractor. Cuál de las dos
   * fechas es el inicio del período **sí** es una propiedad: es la menor. Eso no depende de ningún extractor.
   */
  const desde = primera <= segunda ? primera : segunda;
  const hasta = primera <= segunda ? segunda : primera;

  // Un período de un solo día es posible; uno de cero no: las dos fechas iguales significa que se leyó la
  // misma celda dos veces.
  if (desde === hasta) return null;
  return { desde, hasta };
}

/**
 * Período leído de **dos etiquetas separadas**, que pueden estar en filas distintas.
 *
 * ## Por qué `extraerPeriodo` no alcanza
 *
 * Esa función exige las dos fechas en **la misma cadena**. En el segundo banco del roster
 * (`06-formato-santander.md` §11.10) `Desde:` y `Hasta:` salen en fragmentos separados y en **filas
 * geométricas distintas**, a 14 pt una de otra: `extraerPeriodo` devuelve `null` y el adaptador se queda sin
 * período. Y sin período no hay `EST_FECHA_FUERA_DE_PERIODO`, ni resolución del año en los bancos que
 * publican `dd/mm`, ni `periodo_desde`/`hasta` en `lote_ingesta_cuenta`.
 *
 * ## Dos diferencias deliberadas con `extraerPeriodo`
 *
 * 1. **Acá el rótulo dice cuál es cuál**, así que NO se toma mínimo y máximo: se toma lo que dice la
 *    etiqueta. Si el resultado viene invertido (`desde > hasta`) es que se leyó mal, y devolver el par dado
 *    vuelta escondería el error. → `null`.
 * 2. **`desde === hasta` es un resultado válido.** En `extraerPeriodo` significa que se leyó dos veces la
 *    misma celda, porque las dos fechas salen del mismo texto; acá salen de dos etiquetas distintas, y un
 *    extracto de un solo día es un documento posible.
 *
 * Cada regex tiene que traer **un grupo de captura** con la fecha. Se busca sobre los textos en orden y se
 * toma la primera aparición de cada etiqueta: la carátula está antes del cuerpo en todos los bancos medidos.
 */
export function periodoPorEtiquetas(
  textos: readonly string[],
  reDesde: RegExp,
  reHasta: RegExp,
): { readonly desde: string; readonly hasta: string } | null {
  const buscar = (re: RegExp): string | null => {
    // Sin la flag `g`: un regex global lleva estado (`lastIndex`) entre llamadas y saltearía apariciones.
    const sinGlobal = sinEstado(re);
    for (const texto of textos) {
      const m = sinGlobal.exec(texto);
      const capturado = m?.[1];
      if (capturado === undefined) continue;
      const iso = parsearFecha(capturado);
      if (iso !== null) return iso;
    }
    return null;
  };

  const desde = buscar(reDesde);
  const hasta = buscar(reHasta);
  if (desde === null || hasta === null) return null;
  if (desde > hasta) return null;
  return { desde, hasta };
}

// -----------------------------------------------------------------------------
// Región de tabla: dónde empieza y dónde termina el cuerpo
// -----------------------------------------------------------------------------

/** Tramo del documento donde vive el cuerpo de la tabla. Índices **exclusivos** en los dos extremos. */
export type RegionDeTabla = {
  /** Índice de la fila de encabezado que abrió la región. El cuerpo empieza en `desde + 1`. */
  readonly indiceEncabezado: number;
  /** Índice de la fila de cierre, o `null` si la región llega al final del documento. */
  readonly indiceCierre: number | null;
  /** Cuántas veces se repitió el encabezado adentro de esta región (uno por página, típicamente). */
  readonly repeticionesDeEncabezado: number;
};

/**
 * Acota el cuerpo de la tabla entre su encabezado de columnas y su línea de cierre.
 *
 * ## Por qué acotar no es opcional, medido en los dos bancos nuevos
 *
 * Las ventanas de columna se definen en puntos PDF, y **fuera de la tabla hay importes que caen adentro de
 * esas mismas ventanas**:
 *
 *   - Santander (`06` §11.3): el `##,##%` de la columna TNA del anexo tiene borde derecho **407.0** contra
 *     **408.0** de la columna de débito — **está adentro** de la ventana `[404, 412]`. Hoy no explota de
 *     casualidad, porque `importeACentavos('57,00%')` devuelve `null` por el `%`. El CFTEA está a **1.0 pt**
 *     del borde de la ventana de crédito.
 *   - Macro (`07` §9): **178 importes de fuera de la tabla caen en la ventana de saldo**, con borde derecho
 *     **553.8 idéntico** al del cuerpo. Y a diferencia de Galicia —donde el anexo estaba al final— acá están
 *     **arriba de cada página** y **entre las cuentas**.
 *
 * ## Las dos decisiones del autómata
 *
 * 1. **Un encabezado repetido NO abre una región nueva.** Se repite una vez por página (47 veces para 3
 *    cuentas en Macro, 9 veces para 2 en Santander). Tratarlo como apertura partiría la tabla en una región
 *    por página, y con eso la cadena de saldos se rompería en cada corte de hoja.
 * 2. **Una línea de cierre sin región abierta se ignora.** El cierre de un banco (`Saldo total`,
 *    `SALDO FINAL AL DIA`) es un literal que también puede aparecer en la carátula.
 *
 * La región **no incluye** ni la fila de encabezado ni la de cierre: las dos son datos de la verificación
 * —el cierre trae el saldo final declarado— y las lee el adaptador por su cuenta, no barriendo el cuerpo.
 */
export function regionesDeTabla(
  textos: readonly string[],
  reEncabezado: RegExp,
  reCierre: RegExp,
): readonly RegionDeTabla[] {
  const testear = (re: RegExp, texto: string): boolean =>
    sinEstado(re).test(texto);

  const regiones: RegionDeTabla[] = [];
  let abierta: { indiceEncabezado: number; repeticiones: number } | null = null;

  const cerrar = (indiceCierre: number | null): void => {
    if (!abierta) return;
    regiones.push({
      indiceEncabezado: abierta.indiceEncabezado,
      indiceCierre,
      repeticionesDeEncabezado: abierta.repeticiones,
    });
    abierta = null;
  };

  for (const [i, texto] of textos.entries()) {
    if (testear(reEncabezado, texto)) {
      // Repetición del encabezado de página: la región sigue siendo la misma. Ver decisión 1.
      if (abierta) abierta.repeticiones += 1;
      else abierta = { indiceEncabezado: i, repeticiones: 1 };
      continue;
    }
    // Ver decisión 2: sin región abierta, un cierre no cierra nada.
    if (abierta && testear(reCierre, texto)) cerrar(i);
  }
  cerrar(null);

  return regiones;
}

/** ¿El índice `i` cae dentro del cuerpo de alguna región? Encabezado y cierre quedan **afuera**. */
export function dentroDeAlgunaRegion(
  regiones: readonly RegionDeTabla[],
  i: number,
): boolean {
  return regiones.some(
    (r) => i > r.indiceEncabezado && (r.indiceCierre === null || i < r.indiceCierre),
  );
}

// -----------------------------------------------------------------------------
// El par (importe, saldo): una familia con la redundancia del signo parametrizada
// -----------------------------------------------------------------------------

/** Ventana del **borde derecho** de una columna de importes, en puntos PDF. */
export type VentanaDerecha = { readonly desde: number; readonly hasta: number };

export type ColumnasDeImporte = {
  readonly credito: VentanaDerecha;
  readonly debito: VentanaDerecha;
  readonly saldo: VentanaDerecha;
};

export type ParDeFila = {
  /** **Signado**: crédito positivo, débito negativo. Es el efecto sobre el saldo del banco. */
  readonly importe: ImporteCanonico;
  readonly saldo: ImporteCanonico;
  readonly columna: 'credito' | 'debito';
};

/**
 * Lee el par `(importe, saldo)` de una fila, localizando las columnas por su **borde derecho**.
 *
 * El borde derecho y no el izquierdo porque el izquierdo se mueve con la cantidad de dígitos: es la
 * diferencia entre un parser que sobrevive a que un importe pase de seis a siete cifras y uno que no.
 *
 * ## `traeSignoEnElImporte`: dos familias de banco, no dos ramas de un `if`
 *
 * Es la generalización que el segundo y el tercer banco obligaron a escribir, y **copiar el lector del
 * primero da cero movimientos**:
 *
 * | | Galicia | Santander | Macro |
 * |---|---|---|---|
 * | Evidencias del signo | **2** (columna + token) | **1** (solo la columna) | **1** (solo la columna) |
 * | `traeSignoEnElImporte` | `true` | **`false`** | **`false`** |
 * | Tokens con signo | los negativos | **0 de 158** | **0 de 1346** |
 *
 * - Con **`true`**, el signo del token y la columna son **redundantes**, y esta función los **cruza**: que
 *   coincidan es un control gratis, que no coincidan es un hallazgo → `null`. Derivar el signo de la columna
 *   tiraría la segunda señal a la basura.
 * - Con **`false`**, el token **nunca** trae signo. Si trajera uno, no es un negativo: es un token mal
 *   separado o una fila que no es un movimiento → `null`. El signo se **deriva** de la columna, y su
 *   verificación pasa a ser la cadena de saldos (V5, `ARIT_SIGNO_INVERTIDO`), que sigue siendo independiente.
 *
 * ## Un token en las DOS columnas es `null`, no "gana el crédito"
 *
 * Medido: los tres bancos tienen **cero** filas con importe en ambas columnas. Un fragmento en las dos
 * ventanas significa que las ventanas se solapan o que la fila no es un movimiento. Preferir una de las dos
 * produciría una fila plausible con la mitad del dato inventado.
 */
export function parDeColumnas(
  fila: FilaGeometrica,
  columnas: ColumnasDeImporte,
  opciones: { readonly traeSignoEnElImporte: boolean },
): ParDeFila | null {
  const saldoFrag = fragmentoEnVentanaDerecha(fila, columnas.saldo.desde, columnas.saldo.hasta);
  if (!saldoFrag) return null;
  const saldoCent = importeACentavos(saldoFrag.texto);
  if (saldoCent === null) return null;

  const creditoFrag = fragmentoEnVentanaDerecha(fila, columnas.credito.desde, columnas.credito.hasta);
  const debitoFrag = fragmentoEnVentanaDerecha(fila, columnas.debito.desde, columnas.debito.hasta);

  // Ni en ninguna ni en las dos. Ver la nota de arriba.
  if (!creditoFrag === !debitoFrag) return null;

  const columna = creditoFrag ? ('credito' as const) : ('debito' as const);
  const importeFrag = creditoFrag ?? debitoFrag;
  if (!importeFrag) return null;

  /**
   * **El mismo fragmento no puede ser el importe Y el saldo.**
   *
   * Si las ventanas se solapan —por un ajuste de coordenadas, o por un banco cuyo saldo queda cerca de la
   * columna de crédito, que ya está medido a 4 pt en uno del roster— el mismo token entra en las dos y sale
   * un par **plausible con la mitad inventada**: importe = saldo, la cadena da un delta igual al saldo, y
   * nada lo contradice. Es el mismo defecto que la función ya rechaza para "un importe en las dos
   * columnas", entrando por la otra puerta.
   */
  if (importeFrag === saldoFrag) return null;

  const importeCent = importeACentavos(importeFrag.texto);
  if (importeCent === null) return null;

  const signoEsperado = columna === 'credito' ? 1n : -1n;

  if (opciones.traeSignoEnElImporte) {
    // Redundante: se cruza. El cero no tiene signo y no contradice nada.
    const signoLeido = importeCent === 0n ? signoEsperado : importeCent > 0n ? 1n : -1n;
    if (signoLeido !== signoEsperado) return null;
    return {
      importe: centavosAImporte(importeCent),
      saldo: centavosAImporte(saldoCent),
      columna,
    };
  }

  // El banco NO publica signo en el importe: un token firmado es un token mal leído.
  if (importeCent < 0n) return null;
  return {
    importe: centavosAImporte(signoEsperado * importeCent),
    saldo: centavosAImporte(saldoCent),
    columna,
  };
}

// -----------------------------------------------------------------------------
// Secciones de cuenta: el encabezado se repite y NO abre una cuenta nueva
// -----------------------------------------------------------------------------

export type SeccionDetectada = {
  /** La clave que devolvió el detector. Es el **número de cuenta**, no el título. */
  readonly clave: string;
  /** Índices de las filas de la sección, en orden. Incluye las filas de encabezado. */
  readonly indices: readonly number[];
  /** Índice del **primer** encabezado que la abrió. */
  readonly indiceApertura: number;
  /** Cuántas veces apareció su encabezado. En un resumen de 45 páginas son decenas. */
  readonly repeticionesDeEncabezado: number;
};

export type Seccionado = {
  readonly secciones: readonly SeccionDetectada[];
  /** Índices anteriores al primer encabezado: carátula, leyendas, tabla de cuentas. */
  readonly indicesSinSeccion: readonly number[];
};

/**
 * Reparte las filas en secciones de cuenta, **reabriendo** la sección cuando la clave se repite.
 *
 * ## Es la función que decide si un adaptador separa las cuentas o las mezcla
 *
 * Medido en el tercer banco (`07-formato-macro.md` §14.2): el encabezado `<TIPO> NRO.: <numero>` aparece
 * **47 veces para 3 cuentas** — se repite en cada página. Con "cada encabezado abre una cuenta" el
 * adaptador emite **47 cuentas** y `uq_lote_cuenta_natural` revienta; o peor, si el número se normaliza
 * distinto **no revienta** y quedan 47 filas de cuenta con la cadena de saldos partida en 45 pedazos.
 *
 * Y con la lógica opuesta —una sola cuenta para todo el archivo— pasa lo que ese mismo documento midió:
 * mezclar las tres cuentas de Macro da **1 ruptura sobre 1346 = 0,07 %**. Pasa cualquier umbral de
 * tolerancia, "casi cuadra", y produce **una cuenta inexistente con dos saldos encimados**.
 *
 * ## La trampa de orden que la reapertura resuelve sola
 *
 * En la página 2 de ese archivo hay **dos** encabezados: primero se repite el de la cuenta que venía —para
 * colgarle la cola de su anexo, que cruza el corte de página— y **después** empieza la nueva. Un autómata
 * que cierre la sección al ver cualquier encabezado le atribuye el anexo a la cuenta equivocada. Con
 * reapertura por clave, esas filas vuelven a su sección sin ningún caso especial.
 *
 * ## Qué NO decide esta función — y hay que componerla, no usarla sola
 *
 * **Cuál es la clave.** Eso lo sabe el banco y va en el detector: **el número de cuenta, nunca la
 * denominación** —que en ese archivo se repite entre cuentas y no distingue nada—. El detector devuelve
 * `null` para toda fila que no sea un encabezado de sección, y **tiene que devolver la clave ya
 * normalizada** (hay `normalizarNumeroCuenta` en `hash.ts`): dos grafías del mismo número dan dos secciones,
 * y el propio documento avisa que *"si el número se normaliza distinto, no revienta y quedan 47 filas de
 * cuenta"*.
 *
 * **Qué filas pertenecen de verdad a la cuenta.** `indicesSinSeccion` cubre **solo el prólogo**: después del
 * primer encabezado, *toda* fila cae en la sección que estuviera abierta, incluidas las de nivel archivo.
 * Medido en el banco multi-cuenta, a partir de la página 2 eso son **360 filas de carátula, 90 consolidados,
 * 765 leyendas legales y 44 períodos** repartidos entre las tres secciones, y **ninguna pertenece a ninguna
 * cuenta**. Un adaptador que lea el período o el saldo "de las filas de su sección" va a encontrar el dato
 * **del archivo** adentro de cada cuenta y no lo va a notar, porque en el archivo medido los valores
 * coinciden. El día que difieran —un alta a mitad de mes, que el propio documento nombra— cada sección
 * hereda el período de la anterior.
 *
 * > **Composición obligatoria: `indices` ∩ `dentroDeAlgunaRegion(regiones, i)`.** El cuerpo de una cuenta es
 * > la intersección de su sección con la región de tabla. Ninguna de las dos alcanza sola.
 *
 * **Un encabezado que el detector no entiende es INVISIBLE.** No abre sección, no cae en
 * `indicesSinSeccion`, no reporta nada: sus movimientos se le atribuyen a la cuenta anterior. Por eso el
 * conteo de secciones se verifica contra un literal **distinto** del documento — ver
 * `verificarConteoDeCuentas` en `verificacion/invariantes.ts`.
 *
 * **La verificación de que el conteo dio bien no está acá:** es que la cantidad de secciones coincida con la
 * cantidad de `SALDO ULTIMO` / `SALDO FINAL` del documento (3 y 3 en ese archivo). Un número distinto es
 * error de sectorización, y esta función no puede detectarlo sola.
 */
export function seccionesPorClave(
  textos: readonly string[],
  claveDeEncabezado: (texto: string) => string | null,
): Seccionado {
  const porClave = new Map<string, { indices: number[]; indiceApertura: number; repeticiones: number }>();
  const orden: string[] = [];
  const indicesSinSeccion: number[] = [];
  let actual: string | null = null;

  for (const [i, texto] of textos.entries()) {
    const clave = claveDeEncabezado(texto);

    if (clave !== null) {
      const existente = porClave.get(clave);
      if (existente) {
        // Ya vista: NO es una cuenta nueva, es el encabezado repetido de la página.
        existente.repeticiones += 1;
        existente.indices.push(i);
      } else {
        porClave.set(clave, { indices: [i], indiceApertura: i, repeticiones: 1 });
        orden.push(clave);
      }
      actual = clave;
      continue;
    }

    if (actual === null) {
      indicesSinSeccion.push(i);
      continue;
    }
    porClave.get(actual)?.indices.push(i);
  }

  return {
    secciones: orden.map((clave) => {
      const s = porClave.get(clave);
      return {
        clave,
        indices: s?.indices ?? [],
        indiceApertura: s?.indiceApertura ?? 0,
        repeticionesDeEncabezado: s?.repeticiones ?? 0,
      };
    }),
    indicesSinSeccion,
  };
}

// -----------------------------------------------------------------------------
// Destinos (A2, `docs/diseno/10-deuda-declarada.md` §2.1) — vocabulario compartido de los tres bancos
// -----------------------------------------------------------------------------

/**
 * Los siete destinos posibles de una fila del documento, para cualquier banco. **Unión cerrada.**
 *
 * Nacieron en `santander.ts` (`DestinoSantander`) y se generalizan acá porque describen el **pipeline**,
 * no al banco: toda fila o se vuelve un movimiento, o alimenta uno, o es dato de verificación, o es
 * ruido con regla escrita, o es un renglón de anexo, o está fuera del cuerpo, o no se entendió —
 * verificado contra el código de los tres adaptadores, ninguno de los 7 queda vacío por no aplicar. Una
 * unión por banco conservaría el defecto que A2 existe para sacar: el residuo no era comparable entre
 * adaptadores (`09-lecciones-aprendidas.md` §3).
 *
 * - `movimiento` — la fila que abre un movimiento emitido.
 * - `continuacion` — una fila que aportó glosa, comprobante o par a un movimiento abierto, o texto a un
 *   rótulo de anexo que envolvió. No tiene registro propio: su contenido está adentro del registro de
 *   otra fila.
 * - `saldoDeclarado` — saldo inicial o final **rotulado**: dato de la verificación, no ruido.
 * - `ruido` — una regla escrita lo explica (encabezado, título, leyenda, pie). Siempre **con su regla**.
 * - `anexo` — un renglón emitido de un bloque de anexo.
 * - `fueraDelCuerpo` — fuera de toda región de tabla y de todo bloque de anexo, y ninguna regla la
 *   explica: carátula y leyendas legales. Se **cuenta** y no pone el lote en rojo — es la distinción
 *   entera del diseño (`verificarDestinos`, `verificacion/invariantes.ts`).
 * - `residuo` — va a `lineasNoInterpretadas`, con su forma. Empuja el lote a `no_cuadra`.
 */
export const DESTINOS_BASE = [
  'movimiento',
  'continuacion',
  'saldoDeclarado',
  'ruido',
  'anexo',
  'fueraDelCuerpo',
  'residuo',
] as const;
export type DestinoBase = (typeof DESTINOS_BASE)[number];

export type ConteoDeDestinos<D extends string> = Readonly<Record<D, number>> & {
  /**
   * Filas que **ninguna** rama del lector marcó. Tiene que dar **0**: es el control de la partición, y
   * es lo que hace que "toda fila tiene un destino declarado" sea un hecho medido y no una afirmación
   * del autor. Mismo razonamiento que `residuoDeParticion` en este archivo.
   */
  readonly sinDestino: number;
  readonly total: number;
};

/**
 * Cuenta las filas por destino, genérico en la unión `D` que reciba el llamador.
 *
 * `noUncheckedIndexedAccess: true` vuelve incierto el tipo de `conteo[destino]` con `D` genérico, así
 * que el acumulador interno es un `Map<D, number>` (no un record indexado) y el resultado se
 * materializa con un único cast local: sano por construcción porque `D` viene de `destinosPosibles`.
 *
 * Un destino marcado que `destinosPosibles` no contiene es un error de programación, no un dato del
 * documento — mismo precedente que `registrarAdaptador` (`registro.ts`): **lanza**, no silencia.
 */
export function contarDestinos<D extends string>(
  destinosPosibles: readonly D[],
  destinoDeFila: ReadonlyMap<number, D>,
  total: number,
): ConteoDeDestinos<D> {
  const acumulador = new Map<D, number>(destinosPosibles.map((d) => [d, 0]));
  for (const destino of destinoDeFila.values()) {
    const previo = acumulador.get(destino);
    if (previo === undefined) {
      throw new Error(
        `contarDestinos: "${destino}" no está en destinosPosibles (${destinosPosibles.join(', ')}). ` +
          'Un destino fuera de la unión declarada es un error de programación del adaptador.',
      );
    }
    acumulador.set(destino, previo + 1);
  }
  // Sano por construcción: `acumulador` tiene exactamente las claves de `destinosPosibles` (se
  // inicializó con todas, y `set` solo corre sobre claves ya presentes en el guard de arriba).
  const conteo = Object.fromEntries(acumulador) as Record<D, number>;
  return { ...conteo, sinDestino: total - destinoDeFila.size, total };
}
