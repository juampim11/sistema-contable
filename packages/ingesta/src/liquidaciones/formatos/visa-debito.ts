/**
 * ADAPTER VISA DÉBITO — commit 2 de 4 del plan 14, retomado con el plan 15 (OCR), 2026-08-19.
 *
 * Antes de tocar este archivo, releer completos `docs/diseno/14-liquidaciones-tarjeta-plan.md` y
 * `docs/diseno/15-ocr-liquidaciones-plan.md`: acá se aplican, no se repiten.
 *
 * ## El documento real es 100% escaneado — confirma la premisa de Laura, no la excepción de BBVA
 *
 * `privado/tarjetas/01-extracto_visa_debito_roka.pdf`: 8 páginas, cero caracteres de texto nativo,
 * `/Image` sin `/Font`. Por eso este adapter recibe `PaginaOcr[]` (el resultado de `extraerConOcrSiHaceFalta`,
 * `../../ocr.ts`) y no `FilaGeometrica[]` — refutó la apuesta del commit 1, ver `registro.ts`.
 *
 * ## Estrategia de lectura: por ETIQUETA + proximidad, reimplementada local
 *
 * El plan 15 dejaba abierto probar primero banding por coordenada fija (como los ocho bancos). Se probó
 * primero y se descartó: el `x` de una misma etiqueta impresa por Visa varía entre liquidaciones del
 * mismo documento (la foto no tiene la estabilidad geométrica del PDF vectorial — perspectiva y recorte
 * de CamScanner mueven cada columna unos píxeles), así que un `[desde, hasta)` fijo no es confiable
 * columna a columna. Lo que **sí** es estable es la ETIQUETA IMPRESA (`ARANCEL`, `SIRTAC`, `ACRED EN CBU
 * NRO`…) — texto del FORMATO Visa, no un dato del comercio — y el hecho de que el valor que le
 * corresponde es siempre el **último importe con forma válida a la derecha, en la misma fila visual**.
 * Es la misma disciplina que `valorPorEtiqueta` (`adaptadores/toolkit.ts`) aplica a PDFs nativos,
 * reimplementada acá sobre palabras OCR — **nunca importada de `toolkit.ts`** (R-M: las dos familias no
 * se conocen).
 *
 * ## Fila visual = palabras OCR agrupadas por `y`, con tolerancia en PÍXELES (no puntos PDF)
 *
 * Medido contra el documento real (página 1): la altura de palabra mediana es ~17 px y el p75 ~22 px, en
 * una imagen de 2110×3033. Un primer valor de `TOLERANCIA_FILA_OCR` (10 px, bastante menor que la altura
 * de una palabra) **subestimaba** la variación real: la etiqueta de una línea de total y su importe —a
 * más de 1000 px de distancia horizontal, en extremos opuestos de la página— no caen exactamente en el
 * mismo `y` cuando el escaneo tiene la más mínima inclinación, y con tolerancia 10 el importe quedaba
 * huérfano en la fila de al lado (medido: 45 de 143 líneas candidatas sin importe capturado). Un barrido
 * sobre el documento real, contando líneas de total con importe capturado en cada tolerancia probada
 * (10, 13, 16, 20, 25 y 30 px), confirma que 20 px es el punto de mejor rendimiento (108 de 145 con
 * importe, contra 98 de 143 en 10) — después de ese punto empieza a fusionar de más y el rendimiento
 * cae. Sigue siendo bastante menor que el interlineado entre renglones de la tabla de comprobantes, así
 * que dos filas de contenido distinto no se mezclan.
 *
 * ## La forma del documento, medida (nunca un valor, solo estructura — anti-fuga)
 *
 * Cada liquidación es un bloque que repite el mismo patrón, de arriba hacia abajo:
 *  1. Encabezado de columnas de la tabla de comprobantes (se ignora: no aporta a `LiquidacionLeida`).
 *  2. Renglones "Venta ctdo" — el detalle de cupones que compone la liquidación (se ignoran: el plan no
 *     pide capturar el detalle transacción por transacción, solo los cinco totales de abajo).
 *  3. Cinco líneas de totales, cada una con una etiqueta a la izquierda y un importe a la derecha:
 *     `VENTAS C/DESCUENTO CONTADO`, `ARANCEL`, `IVA CRED.FISC.COMERCIO S/ARANC <tasa>%`,
 *     `RETENCION ING.BRUTOS SIRTAC`, `PERCEPCION IVA R.G. 2408 <tasa>%`, y el cierre `IMPORTE NETO DE
 *     PAGOS`. Dos de las cinco (IVA y percepción) imprimen su tasa junto al monto — las otras tres, no.
 *  4. Una línea de cierre `F.de Pago: ACRED EN CBU NRO: el día <fecha> $ <importe, repetido> Nro.Liq:
 *     <número> F.Pres <fecha>` — es el ancla que cierra el bloque y aporta `fechaDePago`,
 *     `numeroDeLiquidacion` y `fechaPresentacion`.
 *
 * El encabezado del documento (página 1, una sola vez) trae `Total presentado` y `Neto de pagos` —
 * el segundo es `totalConsolidadoDeclarado` para el eje 2 (`traeTotalDelEmisor: true`).
 *
 * ## Resultado medido contra el documento real, honesto — no un pipeline terminado
 *
 * De las liquidaciones del documento (ocho páginas, varias por página), este primer paso cierra un
 * subconjunto — no todas: el resto queda en `lineasNoInterpretadas` con su código (`renglon_sin_monto`
 * cuando la etiqueta se reconoció pero el importe no, `bloque_de_totales_no_interpretado` cuando la línea
 * de cierre apareció sin `ventasBrutas`/`netoAcreditado`/`fechaPresentacion` suficientes para construir
 * el bloque). La causa dominante medida no es la geometría —ya ajustada arriba— sino el reconocimiento
 * del propio token de importe: OCR sobre una foto de celular vía CamScanner pierde el separador de miles
 * o la coma decimal en una fracción real de los casos, y `parsearImporte` (`../../parseo-ar.ts`) es
 * **estricto a propósito** (exige coma decimal o separador de miles — es la misma regla que evita que un
 * CUIT se cuele como importe en los ocho adaptadores bancarios) y rechaza el token en vez de adivinar.
 * **Es la decisión correcta igual**: un importe adivinado mal y aceptado es estrictamente peor que uno
 * declarado no interpretado. La consecuencia directa es que el eje 2 (checksum del emisor) da
 * `no_cuadra` con el estado actual del parser — no porque la aritmética esté mal, sino porque la suma es
 * sobre un subconjunto de las liquidaciones del mes, nunca sobre todas: es un artefacto de la cobertura
 * parcial, no una contradicción del dato. Mejorarlo es la iteración siguiente —candidatos, sin
 * implementar acá: preprocesar la imagen antes de OCR (binarizar/aumentar contraste, que exigiría medir
 * si hace falta una dependencia nueva) o una búsqueda de importe por vecino-más-cercano en vez de
 * "última palabra con forma de importe en la fila"— y queda documentado para no perderse, no forzado
 * esta noche a costa de aceptar un valor que el documento no respalda.
 */

import { parsearFecha, parsearImporte } from '../../parseo-ar.ts';
import { normalizar } from '@sistema-contable/shared/texto';
import { reconocerRecorte, type PalabraOcr, type PaginaOcr } from '../../ocr.ts';
import type { FilaGeometrica, PixelesDePagina } from '../../texto-pdf.ts';
import { formaDeLineaDeLiquidacion } from '../contrato.ts';
import { evaluarConfianzaDeCaptura, type ConfianzaDeCampo } from '../captura.ts';
import type {
  CapacidadesDeFormato,
  LineaNoInterpretadaDeLiquidacion,
  LiquidacionLeida,
  RenglonDeLiquidacion,
} from '../esquema.ts';
import type { AdaptadorDeLiquidacion, EntradaDeLiquidacion, SalidaDeLiquidacion } from '../registro.ts';

export const FORMATO_CODIGO = 'visa_debito';
export const VERSION = 1;

/**
 * Capacidades medidas contra el documento real. `publicaBaseYAlicuotaPorRenglon: false` porque el
 * documento **nunca** imprime una base separada para estos cinco totales (solo etiqueta + importe, y en
 * dos casos también la tasa) — la tasa sola, sin base, no cumple "publica base Y alícuota".
 */
export const CAPACIDADES_VISA_DEBITO: CapacidadesDeFormato = {
  traeTotalDelEmisor: true,
  publicaBaseYAlicuotaPorRenglon: false,
  traePercepcionIva: true,
};

/**
 * Marcas del formato (vocabulario impreso por Visa, igual para todo comercio — nunca un dato del
 * cliente). AND, no OR: mismo patrón que ya usa `reconoceVisaCredito` en `visa-credito.ts:164-167,257-262`
 * — dos constantes separadas, `&&` explícito.
 *
 * 🔴 **Corregido 2026-08-21 (HANDOFF 91/92) — bug funcional confirmado con evidencia, no de
 * aislamiento.** La marca genérica ("RESUMEN MENSUAL DE LIQUIDACIONES A COMERCIOS") también aparece
 * en el documento real de Visa crédito — verificado contra
 * `privado/tarjetas/02-extracto_visa_credito_roka.pdf`. Con `.some(...)` (OR), esa sola frase
 * alcanzaba para que este adapter reconociera un documento de crédito como propio. No era una fuga
 * entre clientes (el resolver compartido, `registro.ts`, falla cerrado a `ambiguo` cuando dos
 * adapters compiten) pero sí bloqueaba cualquier wiring de producción que registrara los tres
 * formatos juntos. Reproducido con un caso de test sintético antes de este fix (confirmado en rojo) y
 * con el mismo test en verde después — ver
 * `liquidaciones-visa-debito-reconocimiento.test.ts`.
 *
 * `MARCA_DEBITO` verificado contra el documento real de crédito (no solo asumido por simetría con
 * `MARCA_CREDITO`): la frase `TARJETA DE DEBITO PESOS` **no** aparece en
 * `privado/tarjetas/02-extracto_visa_credito_roka.pdf`.
 *
 * R-M no rige entre estos dos archivos (`reglas-de-codigo.test.ts:868-933`, la propia regla excluye
 * explícitamente "los hermanos de la familia" de la infracción — solo protege la frontera entre
 * `adaptadores/` y `liquidaciones/`), pero se mantiene el mismo patrón de duplicación local que ya
 * tenía este archivo y que usa `visa-credito.ts` para su propio par de marcas: cada adapter define su
 * copia, ninguno importa la constante del otro.
 */
const MARCA_GENERICA = /RESUMEN MENSUAL DE LIQUIDACIONES A COMERCIOS/;
/** Verificado: NO aparece en el documento real de crédito. Ver el comentario de arriba. */
const MARCA_DEBITO = /TARJETA DE DEBITO PESOS/;

/** Ver el comentario de cabecera: medido contra la página 1 del documento real. */
const TOLERANCIA_FILA_OCR = 20;

/**
 * Margen vertical (px) de la banda `[fila.y − MARGEN, fila.y + MARGEN)` que se recorta para el
 * reintento de `neto_acreditado` (plan 16, paso 3). Recortada contra `[0, pixeles.height]` — ver
 * `reintentarNetoAcreditado`.
 *
 * ## La evidencia que lo fija — barrido real, mismo criterio que `UMBRAL_CONFIANZA_MINIMA` (`captura.ts`)
 *
 * Medido corriendo el pipeline real (`extraerConOcrSiHaceFalta` + `reconocerRecorte`, la función de
 * producción, no una reimplementación) contra las 8 páginas del documento real
 * (`privado/tarjetas/01-extracto_visa_debito_roka.pdf`), sobre las **14 filas de `neto_acreditado` que
 * fallan hoy** (21 detectadas, 7 pasan / 14 fallan — coincide con HANDOFF 81/82 y con la medición
 * histórica de HANDOFF 83). Para cada margen candidato se recortó `[fila.y − margen, fila.y + margen)`
 * y se contó cuántas de las 14 filas recuperan un token con forma de importe válida
 * (`parsearImporte`, no negativo):
 *
 * | margen (px) | recuperadas / 14 |
 * |---|---|
 * | 30 | 13 |
 * | 40 | 13 |
 * | 50 | 13 |
 * | 60 | 13 |
 * | 70 | **14** |
 *
 * **70px es el único valor que recupera el 100 % de la muestra** — los otros cuatro empatan en 13/14
 * (la misma fila queda sin recuperar en los cuatro). Corrida **dos veces**, en lanzamientos de proceso
 * separados: el patrón fue **idéntico byte a byte** las dos veces (mismo total detectado, mismos
 * conteos por margen) — sin la variación entre lanzamientos que documenta HANDOFF 83 para la medición
 * de *cobertura del pipeline completo*. No se puede afirmar que esta medición puntual (recuperación
 * estructural por margen, sin pasar por `leerVisaDebito` entero) esté exenta de esa variación en
 * general — dos corridas no cierran esa duda —, pero el resultado observado acá es estable y el
 * patrón (70 gana, con margen claro sobre 30-60) es lo que gobierna la elección, no un número puntual
 * frágil.
 *
 * Por qué no se probó más allá de 70: fuera del alcance pedido para este paso (barrido 30-70). Un
 * margen mayor arriesga capturar contenido de la fila vecina (el documento es denso, con liquidaciones
 * apiladas) — si eso ocurriera, sería un "recuperado" estructuralmente correcto pero con el valor de
 * otra fila, y el eje 1 (`verificarAritmeticaPorLiquidacion`) es la red que lo detectaría, no esta
 * medición. Ver también: el mecanismo solo puede MEJORAR la cobertura (nunca la empeora) porque el
 * reintento únicamente se dispara cuando la primera lectura ya falló — no hay regresión posible sobre
 * las filas que hoy pasan.
 */
const MARGEN_REINTENTO_NETO_PX = 70;

/**
 * Tope de reintentos de OCR por `reconocerRecorte` en TODO el documento — cuenta **intentos** (cada
 * llamada, éxito o fracaso), no solo fallos: lo que se acota es tiempo/CPU total del lote, no la tasa de
 * éxito (una llamada como máximo por liquidación, porque el reintento solo dispara para
 * `neto_acreditado`).
 *
 * El número de liquidaciones de un documento es el conteo de líneas de cierre (`ES_LINEA_CIERRE`) que
 * detecta este mismo adapter — **no** un valor fijo citado de memoria: una cifra así queda
 * desactualizada en cuanto cambia el documento de medición o el método usado para contarlo (pasó una
 * vez ya: HANDOFF 86 corrige un "21" que en realidad contaba filas con forma de etiqueta de
 * `neto_acreditado`, HANDOFF 83, no bloques/líneas de cierre — el número real, verificado por dos
 * caminos independientes, es 19: 18 líneas de cierre + 1 bloque sin cerrar al final del documento).
 * `TOPE = 30` da margen amplio (casi el doble) sobre esa medición, y sigue dando margen razonable
 * aunque el conteo real de liquidaciones de otro documento varíe — sin dejar que un bug de matching
 * (una etiqueta que hiciera `esLinea` positivo de más, por ejemplo) dispare cientos de reintentos
 * contra un documento degenerado. Al llegar al tope, `SalidaDeLiquidacion.topeDeReintentosAlcanzado =
 * true` y las filas restantes que hubieran disparado un reintento caen directo a `renglon_sin_monto`
 * sin intentarlo — ver `reintentarNetoAcreditado`.
 */
export const TOPE_REINTENTOS_NETO_POR_DOCUMENTO = 30;

// -----------------------------------------------------------------------------
// Filas visuales sobre palabras OCR — reimplementado local, nunca importado de `toolkit.ts` (R-M).
// -----------------------------------------------------------------------------

type FilaOcr = { readonly pagina: number; readonly y: number; readonly palabras: readonly PalabraOcr[] };

function agruparPalabrasEnFilas(pagina: number, palabras: readonly PalabraOcr[]): readonly FilaOcr[] {
  const ordenadas = [...palabras].sort((a, b) => a.y - b.y || a.x - b.x);
  const filas: FilaOcr[] = [];
  let actual: PalabraOcr[] = [];
  let yActual: number | null = null;

  const cerrar = (): void => {
    if (actual.length === 0 || yActual === null) return;
    filas.push({ pagina, y: yActual, palabras: [...actual].sort((a, b) => a.x - b.x) });
    actual = [];
  };

  for (const p of ordenadas) {
    if (yActual === null || Math.abs(p.y - yActual) <= TOLERANCIA_FILA_OCR) {
      yActual ??= p.y;
      actual.push(p);
    } else {
      cerrar();
      yActual = p.y;
      actual = [p];
    }
  }
  cerrar();
  return filas;
}

function textoDeFilaOcr(fila: FilaOcr): string {
  return fila.palabras.map((p) => p.texto).join(' ');
}

/** Los tokens con forma de importe de la fila, en orden de `x` (izquierda a derecha). */
/**
 * Los tokens con forma de importe de la fila, **no negativos**: ninguno de los seis totales que este
 * adapter captura (ventas, cuatro deducciones, neto) puede ser negativo — `importeNoNegativo` en
 * `esquema.ts` lo prohíbe, mismo criterio que ya usan los ocho adaptadores bancarios para sus totales
 * declarados. 🔴 Medido: con la tolerancia de fila más ancha (ver más arriba), una fila puede absorber un
 * token vecino con signo —una columna `Dto.Financ.` en `0,00` u otro dato adyacente— y un filtro que
 * aceptara cualquier signo produciría un `netoAcreditado` inválido contra el esquema. Se rechaza acá,
 * antes de construir la liquidación: mejor un campo sin capturar (`renglon_sin_monto`,
 * `bloque_de_totales_no_interpretado`) que un valor con el signo equivocado.
 */
function importesDeFila(fila: FilaOcr): readonly PalabraOcr[] {
  return fila.palabras.filter((p) => {
    const v = parsearImporte(p.texto);
    return v !== null && !v.startsWith('-');
  });
}

// Sin sufijo "_TOKEN" a propósito: dispara R37 (barrido de credenciales) por la substring "TOKEN",
// mismo falso positivo ya corregido una vez en contrato.ts (TOKEN_NUMERICO → PATRON_NUMERICO).
const RE_FECHA = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const RE_ENTERO = /^\d{3,}$/;

// -----------------------------------------------------------------------------
// Reconocimiento
// -----------------------------------------------------------------------------

function textoDePaginaParaDeteccion(pagina: readonly FilaGeometrica[] | PaginaOcr): string {
  if ('palabras' in pagina) {
    return normalizar(pagina.palabras.map((p) => p.texto).join(' '));
  }
  return normalizar(pagina.map((f) => f.fragmentos.map((frag) => frag.texto).join(' ')).join(' '));
}

export function reconoceVisaDebito(entrada: EntradaDeLiquidacion): boolean {
  const primera = entrada.paginas[0];
  if (primera === undefined) return false;
  const texto = textoDePaginaParaDeteccion(primera);
  return MARCA_GENERICA.test(texto) && MARCA_DEBITO.test(texto);
}

// -----------------------------------------------------------------------------
// Lectura de una liquidación: etiqueta + proximidad
// -----------------------------------------------------------------------------

/** Definición de una de las cinco líneas de total, en el orden en que el documento las imprime. */
type LineaDeTotal = {
  readonly concepto: RenglonDeLiquidacion['concepto'] | 'ventas_brutas' | 'neto_acreditado';
  readonly esLinea: (normalizada: string) => boolean;
};

const LINEAS_DE_TOTAL: readonly LineaDeTotal[] = [
  {
    concepto: 'ventas_brutas',
    esLinea: (t) => t.includes('VENTA') && t.includes('CONTADO') && t.includes('DESCUENTO'),
  },
  {
    concepto: 'arancel',
    // `!includes('FINANC')` excluye el encabezado de columnas de la tabla de comprobantes ("... Dto.
    // Arancel Dto. Financ ..."), que también contiene "ARANCEL" y no tiene importe que capturar.
    // Medido contra el documento real: 42 → 22 coincidencias, 22 → 2 sin importe, 0 regresión sobre
    // líneas reales (HANDOFF, entrada del 2026-08-20).
    esLinea: (t) => t.includes('ARANCEL') && !t.includes('FINANC'),
  },
  {
    concepto: 'iva_21_sobre_arancel',
    esLinea: (t) => t.includes('IVA') && t.includes('ARANC') && !t.includes('PERCEP'),
  },
  { concepto: 'retencion_iibb_sirtac', esLinea: (t) => t.includes('SIRTAC') },
  { concepto: 'percepcion_iva_rg2408', esLinea: (t) => t.includes('PERCEP') },
  {
    concepto: 'neto_acreditado',
    esLinea: (t) => t.includes('IMPORTE') && t.includes('NETO') && t.includes('PAGO'),
  },
];

const ES_LINEA_CIERRE = (t: string): boolean => t.includes('ACRED') && t.includes('PAGO');

/** Un total leído: el importe canónico y la palabra OCR de la que salió (para la confianza del eje 4). */
type TotalLeido = {
  readonly monto: string;
  readonly palabraMonto: PalabraOcr;
  readonly alicuota?: { readonly valor: string; readonly palabra: PalabraOcr };
};

function leerLineaDeTotal(fila: FilaOcr): TotalLeido | null {
  const importes = importesDeFila(fila);
  const ultimo = importes.at(-1);
  if (!ultimo) return null;
  const monto = parsearImporte(ultimo.texto);
  if (monto === null) return null;

  if (importes.length > 1) {
    const primero = importes[0];
    const valorAlicuota = primero ? parsearImporte(primero.texto) : null;
    if (primero && valorAlicuota !== null) {
      return { monto, palabraMonto: ultimo, alicuota: { valor: valorAlicuota, palabra: primero } };
    }
  }
  return { monto, palabraMonto: ultimo };
}

/** Estado mutable del reintento de `neto_acreditado`, compartido por todo el documento. */
type EstadoReintentoNeto = { contador: number; topeAlcanzado: boolean };

/**
 * Reintento ACOTADO, solo para `neto_acreditado` (nunca para los otros cuatro conceptos de
 * `LINEAS_DE_TOTAL`): cuando `leerLineaDeTotal` no encontró un importe válido en la fila agrupada por
 * texto, se recorta la banda vertical `[fila.y − MARGEN, fila.y + MARGEN)` de la página cruda —recortada
 * contra `[0, pixeles.height]`— y se le vuelve a pedir a Tesseract que la lea SOLA, sin el resto de la
 * página densa compitiendo por la segmentación automática (dictamen `arquitecto-software`,
 * `docs/diseno/16-preprocesamiento-neto-acreditado-plan.md`: aislar la fila en su propio recorte, sin
 * preprocesar un solo píxel, recupera el 100 % de la muestra medida — ninguna técnica de preprocesamiento
 * la supera).
 *
 * **Nunca propaga una excepción.** Un `ErrorDeOcr` (cualquiera de sus códigos) o cualquier otro error de
 * `reconocerRecorte` se trata exactamente igual que "el reintento no recuperó nada": cae a
 * `renglon_sin_monto` como si no se hubiera intentado. El texto de la fila o el error crudo nunca entran
 * a un string armado — si hace falta describir algo, es `formaDeLineaDeLiquidacion`, nunca el texto ni el
 * objeto de error.
 *
 * `estado.contador` cuenta **intentos** (cada llamada a `reconocerRecorte`, éxito o fracaso), no solo
 * fallos: lo que se acota es tiempo/CPU total del lote, no la tasa de éxito. Ver
 * `TOPE_REINTENTOS_NETO_POR_DOCUMENTO`.
 */
async function reintentarNetoAcreditado(
  pixeles: PixelesDePagina | null | undefined,
  numeroPagina: number,
  fila: FilaOcr,
  estado: EstadoReintentoNeto,
): Promise<TotalLeido | null> {
  if (!pixeles) return null; // sin píxeles disponibles para esta página: no hay nada que recortar.

  if (estado.contador >= TOPE_REINTENTOS_NETO_POR_DOCUMENTO) {
    estado.topeAlcanzado = true;
    return null;
  }

  const y0 = Math.max(0, fila.y - MARGEN_REINTENTO_NETO_PX);
  const y1 = Math.min(pixeles.height, fila.y + MARGEN_REINTENTO_NETO_PX);
  if (y0 >= y1) return null; // banda degenerada (página sin alto útil): nada que recortar, no es un intento.

  estado.contador += 1;
  try {
    const recorte = await reconocerRecorte(pixeles, y0, y1);
    const filaRecorte: FilaOcr = {
      pagina: numeroPagina,
      y: fila.y,
      palabras: [...recorte.palabras].sort((a, b) => a.x - b.x),
    };
    return leerLineaDeTotal(filaRecorte);
  } catch {
    return null;
  }
}

type CierreLeido = {
  readonly fechaDePago: string | null;
  readonly palabraFechaDePago: PalabraOcr | null;
  readonly numeroDeLiquidacion: string | null;
  readonly palabraNumero: PalabraOcr | null;
  readonly fechaPresentacion: string | null;
  readonly palabraFechaPresentacion: PalabraOcr | null;
};

function leerLineaDeCierre(fila: FilaOcr): CierreLeido {
  const fechas = fila.palabras.filter((p) => RE_FECHA.test(p.texto));
  const enteros = fila.palabras.filter((p) => RE_ENTERO.test(p.texto));

  const fechaPagoTok = fechas[0] ?? null;
  const fechaPresTok = fechas.length > 1 ? (fechas.at(-1) ?? null) : null;
  const numeroTok = enteros[0] ?? null;

  return {
    fechaDePago: fechaPagoTok ? parsearFecha(fechaPagoTok.texto) : null,
    palabraFechaDePago: fechaPagoTok,
    numeroDeLiquidacion: numeroTok ? numeroTok.texto : null,
    palabraNumero: numeroTok,
    fechaPresentacion: fechaPresTok ? parsearFecha(fechaPresTok.texto) : null,
    palabraFechaPresentacion: fechaPresTok,
  };
}

// -----------------------------------------------------------------------------
// El adapter
// -----------------------------------------------------------------------------

export async function leerVisaDebito(entrada: EntradaDeLiquidacion): Promise<SalidaDeLiquidacion> {
  const liquidaciones: LiquidacionLeida[] = [];
  const lineasNoInterpretadas: LineaNoInterpretadaDeLiquidacion[] = [];
  const confianzaDeCaptura: ConfianzaDeCampo[] = [];
  let totalConsolidadoDeclarado: string | undefined;
  const estadoReintento: EstadoReintentoNeto = { contador: 0, topeAlcanzado: false };

  // Acumulador del bloque en construcción: lo que se leyó desde el último cierre.
  let pendientes = new Map<string, TotalLeido>();

  for (let indicePagina = 0; indicePagina < entrada.paginas.length; indicePagina += 1) {
    const pagina = entrada.paginas[indicePagina];
    const esOcr = entrada.usoOcrEnPagina[indicePagina] === true;
    const numeroPagina = indicePagina + 1;

    if (!esOcr || pagina === undefined || !('palabras' in pagina)) {
      // El documento real de este formato es enteramente escaneado: no medido, no se inventa un lector
      // para geometría nativa. Se reporta la página entera como no interpretada, nunca se ignora.
      lineasNoInterpretadas.push({
        codigo: 'desconocido',
        paginaPdf: numeroPagina,
        indice: 0,
        forma: formaDeLineaDeLiquidacion('[pagina con texto nativo, formato no medido para este caso]'),
      });
      continue;
    }

    const filas = agruparPalabrasEnFilas(numeroPagina, pagina.palabras);

    // El total consolidado del emisor ("Neto de pagos:") vive en el encabezado del documento, distinto
    // de "IMPORTE NETO DE PAGOS" que se repite por liquidación — se excluye por la palabra `IMPORTE`,
    // que solo aparece en la segunda. Se busca en cualquier página (medido solo en la 1, no se asume).
    if (totalConsolidadoDeclarado === undefined) {
      for (const fila of filas) {
        const normalizada = normalizar(textoDeFilaOcr(fila));
        if (!normalizada.includes('NETO') || !normalizada.includes('PAGOS') || normalizada.includes('IMPORTE')) {
          continue;
        }
        const importes = importesDeFila(fila);
        const ultimo = importes.at(-1);
        const valor = ultimo ? parsearImporte(ultimo.texto) : null;
        if (valor !== null) totalConsolidadoDeclarado = valor;
      }
    }

    for (let indiceFila = 0; indiceFila < filas.length; indiceFila += 1) {
      const fila = filas[indiceFila];
      if (!fila) continue;
      const textoNormalizado = normalizar(textoDeFilaOcr(fila));

      if (ES_LINEA_CIERRE(textoNormalizado)) {
        const cierre = leerLineaDeCierre(fila);
        const bloque = cerrarLiquidacion(pendientes, cierre, numeroPagina);
        if (bloque === 'incompleto') {
          lineasNoInterpretadas.push({
            codigo: 'bloque_de_totales_no_interpretado',
            paginaPdf: numeroPagina,
            indice: indiceFila,
            forma: formaDeLineaDeLiquidacion(textoDeFilaOcr(fila)),
          });
        } else {
          liquidaciones.push(bloque.liquidacion);
          const idx = liquidaciones.length - 1;
          for (const c of bloque.confianzas) {
            confianzaDeCaptura.push(
              evaluarConfianzaDeCaptura(`liquidaciones[${idx}].${c.campo}`, c.palabra.texto, c.palabra.confianza),
            );
          }
        }
        pendientes = new Map();
        continue;
      }

      const linea = LINEAS_DE_TOTAL.find((l) => l.esLinea(textoNormalizado));
      if (linea === undefined) continue; // encabezado de tabla, renglón de detalle, ruido: reconocido, se ignora.

      let total = leerLineaDeTotal(fila);
      if (total === null && linea.concepto === 'neto_acreditado') {
        // Reintento ACOTADO, solo para este concepto. Ver `reintentarNetoAcreditado`.
        total = await reintentarNetoAcreditado(
          entrada.pixelesDePagina[indicePagina],
          numeroPagina,
          fila,
          estadoReintento,
        );
      }
      if (total === null) {
        lineasNoInterpretadas.push({
          codigo: 'renglon_sin_monto',
          paginaPdf: numeroPagina,
          indice: indiceFila,
          forma: formaDeLineaDeLiquidacion(textoDeFilaOcr(fila)),
        });
        continue;
      }
      pendientes.set(linea.concepto, total);
    }
  }

  // Un acumulador que quedó abierto al final del documento (sin línea de cierre después) es un bloque
  // incompleto: se reporta, no se descarta en silencio.
  if (pendientes.size > 0) {
    lineasNoInterpretadas.push({
      codigo: 'bloque_de_totales_no_interpretado',
      paginaPdf: entrada.paginas.length,
      indice: 0,
      forma: formaDeLineaDeLiquidacion('[bloque sin linea de cierre al final del documento]'),
    });
  }

  return {
    liquidaciones,
    lineasNoInterpretadas,
    ...(totalConsolidadoDeclarado === undefined ? {} : { totalConsolidadoDeclarado }),
    confianzaDeCaptura,
    // `undefined` (omitido) cuando no se activó — mismo patrón que `totalConsolidadoDeclarado`: la
    // ausencia se representa, nunca se rellena con `false`.
    ...(estadoReintento.topeAlcanzado ? { topeDeReintentosAlcanzado: true } : {}),
  };
}

type BloqueCerrado =
  | { readonly liquidacion: LiquidacionLeida; readonly confianzas: readonly { campo: string; palabra: PalabraOcr }[] }
  | 'incompleto';

/**
 * Combina lo acumulado desde el último cierre con la propia línea de cierre en una `LiquidacionLeida`.
 *
 * Campos mínimos para construir un bloque válido: `ventasBrutas`, `netoAcreditado`, y la fecha de
 * presentación (única no envuelta en `publicado()` — siempre requerida por el esquema). Sin alguno de
 * los tres, el bloque es `'incompleto'`: no se rellena con un valor inventado, se reporta.
 */
function cerrarLiquidacion(
  pendientes: ReadonlyMap<string, TotalLeido>,
  cierre: CierreLeido,
  pagina: number,
): BloqueCerrado {
  const ventas = pendientes.get('ventas_brutas');
  const neto = pendientes.get('neto_acreditado');
  if (!ventas || !neto || cierre.fechaPresentacion === null) return 'incompleto';

  const confianzas: { campo: string; palabra: PalabraOcr }[] = [
    { campo: 'ventasBrutas', palabra: ventas.palabraMonto },
    { campo: 'netoAcreditado', palabra: neto.palabraMonto },
  ];

  const renglones: RenglonDeLiquidacion[] = [];
  for (const concepto of ['arancel', 'iva_21_sobre_arancel', 'retencion_iibb_sirtac', 'percepcion_iva_rg2408'] as const) {
    const leido = pendientes.get(concepto);
    if (!leido) continue;
    renglones.push({
      concepto,
      subtipoVenta: 'no_discriminado',
      base: { estado: 'no_publicado' },
      alicuotaPublicada: leido.alicuota
        ? { estado: 'publicado', valor: leido.alicuota.valor }
        : { estado: 'no_publicado' },
      monto: leido.monto,
      jurisdiccion: { estado: 'no_publicado' },
      paginaPdf: pagina,
    });
    confianzas.push({ campo: `renglones[${renglones.length - 1}].monto`, palabra: leido.palabraMonto });
    if (leido.alicuota) {
      confianzas.push({
        campo: `renglones[${renglones.length - 1}].alicuotaPublicada`,
        palabra: leido.alicuota.palabra,
      });
    }
  }

  if (cierre.palabraFechaDePago) confianzas.push({ campo: 'fechaDePago', palabra: cierre.palabraFechaDePago });
  if (cierre.palabraNumero) confianzas.push({ campo: 'numeroDeLiquidacion', palabra: cierre.palabraNumero });
  if (cierre.palabraFechaPresentacion) {
    confianzas.push({ campo: 'fechaPresentacion', palabra: cierre.palabraFechaPresentacion });
  }

  const liquidacion: LiquidacionLeida = {
    numeroDeLiquidacion: cierre.numeroDeLiquidacion
      ? { estado: 'publicado', valor: cierre.numeroDeLiquidacion }
      : { estado: 'no_publicado' },
    fechaPresentacion: cierre.fechaPresentacion,
    fechaDePago: cierre.fechaDePago ? { estado: 'publicado', valor: cierre.fechaDePago } : { estado: 'no_publicado' },
    moneda: 'ARS',
    ventasBrutas: ventas.monto,
    netoAcreditado: neto.monto,
    renglones,
    // No medido en la muestra visual del documento real: se busca la frase, y ausente es `false`, nunca
    // un supuesto. Ver el comentario de cabecera.
    caveatDeComputoFiscal: false,
    paginaPdf: pagina,
  };

  return { liquidacion, confianzas };
}

export const adaptadorVisaDebito: AdaptadorDeLiquidacion = {
  formatoCodigo: FORMATO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_VISA_DEBITO,
  reconoce: reconoceVisaDebito,
  leer: leerVisaDebito,
};
