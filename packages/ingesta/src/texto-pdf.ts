/**
 * Extracción de texto de un PDF — capa de I/O del Módulo 1.
 *
 * Usa **`unpdf`**, reusando la decisión de `trazabilidad-obra-gas` (ADR-0000 §7): no depende de
 * archivos de datos externos (fuentes, cmaps) que en un bundle recortado desaparecen, y es más simple
 * que `pdf-parse` + asegurarse de que esos archivos estén presentes.
 *
 * **Detección de OCR necesario, no OCR.** Si el PDF no tiene texto extraíble (viene escaneado), esta
 * capa lo **informa** y el adapter falla con un motivo claro. No se implementa el fallback OCR todavía:
 * el análisis del cliente piloto mostró que los extractos que llegan tienen texto real, y el único que
 * viene en papel **no se escanea** (`docs/analisis/00-cliente-piloto-laura.md` §3.3). El punto de
 * extensión queda marcado; construirlo antes de tener un caso real sería trabajo sin destino.
 *
 * ## Dos vistas del PDF, y por qué hacen falta las dos
 *
 * | Vista | Qué da | Cuándo sirve |
 * |---|---|---|
 * | `aLineas()` | el texto partido en líneas, en el orden del content-stream | bancos cuyo layout sobrevive al orden del stream |
 * | `aFilas()` | los fragmentos con su **coordenada `x` e `y`** | el resto — o sea, el caso normal |
 *
 * La medición sobre el primer banco real dejó claro que `aLineas()` **no alcanza**: `pdf.js` emite en
 * orden de content-stream, y en ese banco el importe y el saldo —que visualmente están en la misma fila
 * que la fecha— salen en una línea **posterior** para 262 de 326 movimientos. Un parser que asuma "una
 * línea = un movimiento" falla en el 80 % de las filas.
 *
 * Y la geometría resuelve algo más: `pdf.js` emite **un solo carácter de espacio por hueco**, sin importar
 * que el hueco mida 5 pt o 236 pt. Así que **no existen columnas de ancho fijo en caracteres** y cualquier
 * `substring(i, j)` es inviable. Las columnas sí existen, pero en puntos PDF.
 */

import { getDocumentProxy } from 'unpdf';

export type TextoDelPdf = {
  readonly paginas: readonly string[];
  /**
   * Páginas **sin texto**, 1-based. Es el dato que importa, no el promedio.
   *
   * La primera versión decidía `requiereOcr` con el **promedio** de caracteres por página, y eso es un
   * detector roto: un PDF con 10 páginas de texto y 40 escaneadas promedia por encima del umbral y reporta
   * `false` habiendo perdido 40 páginas. El promedio esconde exactamente el caso que hay que detectar.
   */
  readonly paginasSinTexto: readonly number[];
  /** true solo si **ninguna** página tiene texto: es un PDF imagen entero y haría falta OCR. */
  readonly requiereOcr: boolean;
};

/** Debajo de esto, una página no tiene texto de verdad. */
const CARACTERES_MINIMOS_POR_PAGINA = 40;

export async function extraerTexto(contenido: Uint8Array): Promise<TextoDelPdf> {
  const paginas = await paginasDeTexto(contenido);

  const paginasSinTexto: number[] = [];
  paginas.forEach((p, i) => {
    if (p.replace(/\s/g, '').length < CARACTERES_MINIMOS_POR_PAGINA) paginasSinTexto.push(i + 1);
  });

  return {
    paginas,
    paginasSinTexto,
    // Si alguna página trae texto, el archivo es procesable y las páginas vacías son un hallazgo
    // localizado, no un motivo de rechazo global.
    requiereOcr: paginas.length > 0 && paginasSinTexto.length === paginas.length,
  };
}

/**
 * Un fragmento de texto con su posición en la página, en puntos PDF.
 *
 * `x` crece hacia la derecha e `y` **hacia arriba** (origen abajo a la izquierda). Por eso las filas se
 * ordenan por `y` **descendente**: la primera fila de la tabla tiene el `y` más grande.
 */
export type Fragmento = {
  readonly texto: string;
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
};

export type FilaGeometrica = {
  readonly pagina: number;
  /** Baseline de la fila. */
  readonly y: number;
  /** Fragmentos ordenados por `x` ascendente: el orden visual de izquierda a derecha. */
  readonly fragmentos: readonly Fragmento[];
};

/**
 * Tolerancia vertical para agrupar fragmentos en una fila, en puntos.
 *
 * **1.5 pt no alcanza y el número no es arbitrario**: en el primer banco real, la etiqueta `Total` está en
 * `y=619` y sus tres importes en `y=620.5`. Con una tolerancia menor la fila de totales se parte en dos y
 * la etiqueta se pierde — justo la línea que la verificación necesita. Con 2.5 pt se unen, y sigue siendo
 * bastante menor que el interlineado medido dentro de un movimiento (≈9.6 pt).
 */
export const TOLERANCIA_FILA = 2.5;

/**
 * Extrae los fragmentos con su geometría y los agrupa en filas visuales.
 *
 * Es la vista que un adapter de columnas necesita: las columnas se identifican por la posición `x` (o por
 * el borde derecho, cuando el banco alinea los importes a la derecha), no por índices de carácter.
 */
export async function aFilas(contenido: Uint8Array): Promise<readonly FilaGeometrica[]> {
  const pdf = await documento(contenido);
  const salida: FilaGeometrica[] = [];

  for (let n = 1; n <= pdf.numPages; n += 1) {
    const pagina = await pdf.getPage(n);
    const contenidoTexto = await pagina.getTextContent();

    const fragmentos: Fragmento[] = [];
    for (const item of contenidoTexto.items as readonly {
      str?: string;
      transform?: readonly number[];
      width?: number;
    }[]) {
      const texto = item.str ?? '';
      if (texto.trim() === '') continue;
      fragmentos.push({
        texto,
        x: item.transform?.[4] ?? 0,
        y: item.transform?.[5] ?? 0,
        ancho: item.width ?? 0,
      });
    }

    // Agrupar por baseline. Se recorre de `y` mayor a menor, que es de arriba hacia abajo en la página.
    const porY = [...fragmentos].sort((a, b) => b.y - a.y || a.x - b.x);
    let actual: Fragmento[] = [];
    let yActual: number | null = null;

    const cerrar = (): void => {
      if (actual.length === 0 || yActual === null) return;
      salida.push({
        pagina: n,
        y: yActual,
        fragmentos: [...actual].sort((a, b) => a.x - b.x),
      });
      actual = [];
    };

    for (const f of porY) {
      if (yActual === null || Math.abs(f.y - yActual) <= TOLERANCIA_FILA) {
        yActual ??= f.y;
        actual.push(f);
      } else {
        cerrar();
        yActual = f.y;
        actual = [f];
      }
    }
    cerrar();
  }

  return salida;
}

/**
 * Texto de una fila geométrica, con los fragmentos separados por un espacio.
 *
 * Sirve para las reglas de ruido y para reportar la **forma** de una fila que no se entendió. No sirve para
 * localizar columnas: para eso está la posición.
 */
export function textoDeFila(fila: FilaGeometrica): string {
  return fila.fragmentos.map((f) => f.texto).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * El fragmento cuyo **borde izquierdo** cae en `x`, con tolerancia. Para columnas alineadas a la izquierda.
 */
export function fragmentoEnX(
  fila: FilaGeometrica,
  x: number,
  tolerancia = 1.5,
): Fragmento | undefined {
  return fila.fragmentos.find((f) => Math.abs(f.x - x) <= tolerancia);
}

/**
 * El fragmento cuyo **borde derecho** cae dentro de la ventana. Para columnas alineadas a la derecha, que
 * es cómo todo banco imprime los importes: el borde izquierdo se mueve con la cantidad de dígitos, el
 * derecho no.
 */
export function fragmentoEnVentanaDerecha(
  fila: FilaGeometrica,
  desde: number,
  hasta: number,
): Fragmento | undefined {
  return fila.fragmentos.find((f) => {
    const derecha = f.x + f.ancho;
    return derecha >= desde && derecha <= hasta;
  });
}

/**
 * Une **todos** los fragmentos cuyo borde izquierdo cae en la banda `[desde, hasta]`.
 *
 * ## Por qué existe: `fragmentoEnX` devuelve UNO y hay bancos que parten la glosa
 *
 * Medido en el tercer banco (`07-formato-macro.md` §7): la descripción viene en **1 a 4 fragmentos** por
 * fila (160 filas con 1, 340 con 2, **814 con 3**, 32 con 4). `fragmentoEnX(fila, 70.8)` devuelve solo el
 * primero, y con eso **1186 de 1346 descripciones salen truncadas**.
 *
 * Es el peor modo de falla del módulo: los importes cuadran, la cadena de saldos cierra, el lote dice
 * `procesado` — y el producto, que es la descripción, queda mutilado. Nadie lo mira otra vez.
 *
 * ## La selección es por borde IZQUIERDO, y no es un detalle
 *
 * En ese mismo banco, **113 fragmentos de glosa desbordan visualmente hacia la columna de referencia**: su
 * borde derecho llega a `x=297.6` cuando la referencia arranca en `264.0`. Seleccionar por borde derecho
 * los dejaría afuera; cortar el texto en `264.0` perdería el desborde. Con el borde izquierdo, un fragmento
 * que **empieza** dentro de la banda entra entero, aunque se derrame.
 *
 * La contracara: la banda tiene que **terminar antes** de la columna siguiente, y por eso **`hasta` es
 * EXCLUSIVO** mientras `desde` es inclusivo — la banda es `[desde, hasta)`.
 *
 * Eso no es una preferencia de estilo, es lo que hace que la firma sea usable con las coordenadas que
 * publica la especificación. La primera versión tenía los dos extremos cerrados, y con eso la llamada
 * natural —`fragmentosEnBanda(fila, 70.8, 264.0)`, que son los dos valores medidos— **metía las 1221
 * referencias adentro de la glosa**. Los tests no lo veían porque usaban `263.5`, un colchón inventado por
 * el autor: el borde nunca se ejercitaba. Lo encontró el panel, por dos vías distintas.
 *
 * Con `[desde, hasta)`, el límite de una banda es la coordenada de la columna siguiente, que es como se lee
 * el documento. Hay un test por cada extremo.
 *
 * ## Por qué se une con un espacio
 *
 * Es lo mismo que hace `textoDeFila`, y hay evidencia de que es correcto: las reglas de sección de ese
 * banco (`/^(CUENTA .+?) NRO\.:\s*…$/`) matchean **47 de 47** sobre filas de varios fragmentos armadas así.
 * O sea que este extractor parte en límites de palabra, no en medio de una. Si algún banco lo hiciera en
 * medio de una palabra, la separación correcta sería por el hueco geométrico —y ahí sí haría falta otra
 * función, porque `Fragmento.ancho` **miente** en al menos un banco del roster
 * (`06-formato-santander.md` §11.2).
 *
 * Los fragmentos de una `FilaGeometrica` ya vienen ordenados por `x` ascendente: el orden es el visual.
 */
export function fragmentosEnBanda(fila: FilaGeometrica, desde: number, hasta: number): string {
  return fila.fragmentos
    .filter((f) => f.x >= desde && f.x < hasta)
    .map((f) => f.texto)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parte cada página en líneas limpias, conservando el número de página.
 *
 * No se descarta nada acá: quién es encabezado repetido y qué es ruido lo decide **el adapter del
 * banco**, porque es distinto en cada uno. Esta capa no interpreta.
 */
export type LineaConPagina = { readonly pagina: number; readonly texto: string };

export function aLineas(texto: TextoDelPdf): LineaConPagina[] {
  const salida: LineaConPagina[] = [];
  texto.paginas.forEach((contenido, i) => {
    for (const cruda of contenido.split(/\r?\n/)) {
      const limpia = cruda.replace(/ /g, ' ').trimEnd();
      if (limpia.trim() === '') continue;
      salida.push({ pagina: i + 1, texto: limpia });
    }
  });
  return salida;
}

// -----------------------------------------------------------------------------

/**
 * Abre el PDF con una **copia** del buffer.
 *
 * `pdf.js` se apropia del `ArrayBuffer` y lo deja *detached*: una segunda llamada con la misma vista tira
 * `TypeError: Cannot perform Construct on a detached ArrayBuffer`. Y llamar dos veces es lo normal —una
 * para el texto y otra para la geometría—, así que la copia va acá y no en el llamador, donde se olvida.
 */
async function documento(contenido: Uint8Array): Promise<{
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: readonly unknown[] }>;
  }>;
}> {
  return getDocumentProxy(new Uint8Array(contenido)) as never;
}

async function paginasDeTexto(contenido: Uint8Array): Promise<readonly string[]> {
  const { extractText } = await import('unpdf');
  const pdf = await documento(contenido);
  const { text } = await extractText(pdf as never, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((p) => p ?? '');
}
