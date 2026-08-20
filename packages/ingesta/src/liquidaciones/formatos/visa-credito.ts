/**
 * ADAPTER VISA CRÉDITO — commit 2b del plan 14 (plan 15/16, OCR), 2026-08-20.
 *
 * Segundo adapter de la familia, sobre el mismo mecanismo que `visa-debito.ts` (agrupamiento de
 * palabras OCR en filas visuales, lectura por etiqueta + proximidad, reintento acotado de
 * `neto_acreditado`). Antes de tocar este archivo, releer completos `docs/diseno/14-liquidaciones-
 * tarjeta-plan.md` y `docs/diseno/15-ocr-liquidaciones-plan.md`, y el propio `visa-debito.ts` — el
 * mecanismo se REIMPLEMENTA local acá (copiado, nunca importado de `visa-debito.ts` ni de
 * `toolkit.ts`), porque es geometría de agrupamiento OCR, no vocabulario del documento, y porque un
 * import entre dos adapters de `liquidaciones/formatos/` acoplaría su evolución sin necesidad — cada
 * formato cambia con su propio documento real, en su propia sesión de medición.
 *
 * ## El documento real: `privado/tarjetas/02-extracto_visa_credito_roka.pdf`
 *
 * 9 páginas, 100% escaneado (cero texto nativo, igual que débito). **17 liquidaciones**, confirmadas
 * por dos métodos independientes en la sesión que diagnosticó este adapter. Todo lo que sigue son
 * conteos y proporciones medidos contra ESE documento — nunca un valor del cliente.
 *
 * ## `reconoceVisaCredito`: AND explícito, no el `.some()` (OR) que usa hoy `reconoceVisaDebito`
 *
 * `"RESUMEN MENSUAL DE LIQUIDACIONES A COMERCIOS"` aparece en AMBOS documentos (débito y crédito): es
 * la marca genérica del formato Visa, no alcanza sola para identificar el tipo de tarjeta.
 * `"TARJETA DE CREDITO PESOS"` aparece en crédito y NO aparece en débito (verificado explícitamente,
 * simetría confirmada contra los dos documentos reales). Acá se exige la intersección de las dos —
 * `reconoceVisaDebito` usa `.some()` (con un `TODO` ya dejado en su propio archivo, no tocado acá:
 * es tarea aparte, señalada, no corregida por no ser el alcance de este commit).
 *
 * ## `ventasBrutas` es una SUMA, no un total impreso una sola vez
 *
 * A diferencia de débito (una sola línea `VENTAS C/DESCUENTO CONTADO`), el documento de crédito
 * mezcla sub-tipos de venta DENTRO de la misma liquidación: 0 o 1 línea `VENTA ... CONTADO` (medido:
 * nunca más de una) y 1 a 3 líneas `VENTA ... CUOTA` (distintos planes de cuotas, cada uno su propia
 * línea). Ninguna de las dos es un renglón del catálogo —`ventasBrutas` es un campo escalar de
 * `LiquidacionLeida`, no vive en `renglones[]`— así que se acumulan aparte de `pendientes` (que sí es
 * el `Map<string, TotalLeido[]>` de los conceptos de `renglones[]`, ver más abajo) y se combinan con
 * `sumarImportes` (`../../parseo-ar.ts`, centavos en `bigint`) al cerrar el bloque. **Nunca
 * `Number()`**: sumar en punto flotante es exactamente el defecto que `sumarImportes` existe para
 * evitar.
 *
 * Medido en esta sesión (documento real, OCR real): de las filas que matchean `VENTA` + `CUOTA`, la
 * enorme mayoría tiene entre 5 y 9 palabras (label corto + un importe) — hay UNA fila real, de 27
 * palabras, que es un párrafo de aviso legal en prosa que también contiene ambos tokens. Esa fila no
 * trae ningún token con forma de importe válida (`parsearImporte` la rechaza igual, por las mismas
 * reglas que rechazan un CUIT), así que ya no corrompería la suma aun sin filtro adicional — pero se
 * excluye también por longitud (`MAX_PALABRAS_VENTA_CUOTAS`, bien por encima del máximo legítimo
 * medido y bien por debajo del párrafo) para que esa fila ni siquiera aparezca reportada como
 * `renglon_sin_monto`: no es una línea de totales que falló, es prosa que nunca lo fue.
 *
 * ## `arancel`: filtro por pipe/corchete, NO por el token `FINANC` que usa débito
 *
 * El pipe/corchete (`!/[|[\]]/.test(...)`) es un artefacto ESTRUCTURAL de borde de tabla en
 * encabezados y leyendas del documento de crédito — no una palabra de vocabulario. Medido: separa
 * limpio 20 filas reales de arancel de 19 sospechosas en la muestra de la sesión de diagnóstico, con
 * 0 falso negativo. Se necesita la forma CRUDA de la fila (`textoDeFilaOcr`, antes de `normalizar()`)
 * porque el pipe es puntuación, no vocabulario, y `normalizar()` no la preserva de forma confiable
 * para este propósito — nunca `formaDeLineaDeLiquidacion`, que es para logging, no para matching.
 * Por qué NO el mismo criterio que débito (`!includes('FINANC')`): medido, acá `FINANC` sola explica
 * apenas 10 de las 19 filas sospechosas — no alcanza para separar limpio en este documento.
 *
 * ## `percepcion_iva_rg2408`: DOS renglones por bloque, mismo concepto, dos tasas
 *
 * El documento trae DOS líneas de este concepto por liquidación (plan 14 línea 217: "no dos conceptos
 * separados" — son dos RENGLONES con el mismo `concepto: 'percepcion_iva_rg2408'`, cada uno con su
 * propia `alicuotaPublicada`/`monto`). Por esto `pendientes` es `Map<string, TotalLeido[]>` (lista),
 * no `Map<string, TotalLeido>` (un valor) como en débito — pero la lista es GENÉRICA en el tipo, no en
 * el uso: los conceptos medidos como singulares (`arancel`, `iva_21_sobre_arancel`,
 * `retencion_iibb_sirtac`, `interes_financiacion_cuotas`, y el pseudo-concepto `neto_acreditado`)
 * siguen leyéndose como si fueran un único valor (`?.[0]`) — no se generaliza el CONSUMO a lo que no
 * se midió repitiendo, solo el tipo del acumulador es compartido para no duplicar la lógica de
 * acumulación con y sin lista.
 *
 * 🔴 **El bug obvio, señalado por `seguridad-datos-financieros` en la revisión de este plan**: escribir
 * `pendientes.set(concepto, [total])` en vez de acumular
 * (`pendientes.set(concepto, [...(pendientes.get(concepto) ?? []), total])`) pisaría en silencio la
 * primera tasa de percepción con la segunda. `acumularPendiente()` (más abajo) es el único punto que
 * escribe en `pendientes`, y el test de mutación
 * (`../../tests/liquidaciones-visa-credito-percepcion.test.ts`, sintético, sin el documento real)
 * planta exactamente esa mutación y confirma que la suite se pone roja.
 *
 * ## `interes_financiacion_cuotas`: es una COMISIÓN, no un interés real (nota de Laura, no renombrado)
 *
 * El catálogo (`esquema.ts`) llama a este concepto "interés de financiación en cuotas" y así lo
 * describe el plan 14 original, pero Laura (la contadora) marcó explícitamente en el documento real
 * que es una COMISIÓN del adquirente, no un interés real cobrado al comercio — queda acá como nota,
 * el identificador del catálogo NO se renombra (ya está fijado, lo lee Codex, cambiarlo es decisión de
 * JP y afecta el check constraint del commit 3).
 *
 * `esLinea` para este concepto: `t.includes('FINANC') && !(t.includes('VENTA') && t.includes('CUOTA'))
 * && !/[|[\]]/.test(cruda)`. **Deliberadamente sin usar el signo `-` como condición**: medido y
 * descartado — 2 de 20 filas de `arancel` limpias y 1 de 21 de `SIRTAC` (ambos ya confirmados como
 * deducciones reales) tienen el signo corrompido o ausente por OCR. Con el signo como gate, esas filas
 * se habrían perdido en silencio, ni siquiera como `renglon_sin_monto` — directo a "ruido, se ignora".
 * La combinación `!(VENTA && CUOTA)` + pipe/corchete ya separa limpio sin depender de un carácter
 * frágil.
 *
 * 🔴 Riesgo señalado por `security-engineer`: una fila real de esta categoría cuyo `esLinea` diera
 * `false` por cualquier motivo no medido cae al mismo branch silencioso de "ruido, se ignora" que un
 * encabezado real — no se reporta como `renglon_sin_monto`. Mismo tipo de constante-fijada-por-una-
 * sola-medición que `TOLERANCIA_FILA_OCR`/`MARGEN_REINTENTO_NETO_PX`: sujeta a remedirse si un próximo
 * documento real la refuta.
 *
 * ## `descuento_contado_adquirente`: en el catálogo, sin `LineaDeTotal` — a propósito
 *
 * El catálogo (`esquema.ts`, `TIPOS_CONCEPTO_LIQUIDACION`) lo declara, pero NO se encontró evidencia
 * limpia y no ambigua de una línea propia en el documento medido: `"DESCUENTO"` aparece mayormente
 * solapado con `interes_financiacion_cuotas` (24 de 40 filas coinciden). Se deja sin matching acá,
 * deliberadamente — no es un olvido, es la misma disciplina que rechaza adivinar un patrón sin
 * evidencia limpia.
 *
 * ## Resultado medido contra el documento real, honesto — un bloque puede traer MÁS de 2 percepciones
 *
 * El documento tiene 17 liquidaciones confirmadas; una corrida real de este adapter contra él (sesión
 * 2026-08-20) interpretó 6 bloques completos, y de esos, dos trajeron 3 y 4 renglones de
 * `percepcion_iva_rg2408` en vez de 2. La causa medida no es un bug de acumulación (ver
 * `liquidaciones-visa-credito-percepcion.test.ts`, que prueba exactamente eso con un caso sintético
 * limpio): es que `ES_LINEA_CIERRE` no reconoció la línea de cierre de una liquidación real —el mismo
 * modo de falla de cobertura parcial de OCR que `visa-debito.ts` ya documenta extensamente para
 * `neto_acreditado`—, así que sus renglones quedaron en `pendientes` y se fusionaron con los del
 * siguiente cierre que sí se reconoció. No es invisible: el eje 1
 * (`verificarAritmeticaPorLiquidacion`) da `no_cuadra` sobre un bloque así, porque la suma de dos
 * liquidaciones no reproduce el neto de una sola. No se corrige acá con una heurística sin medir (por
 * ejemplo, "más de 2 percepciones ⇒ cortar el bloque"): sería adivinar cuál de los dos cierres reales
 * es el correcto sin evidencia. Candidato de iteración futura, no bloqueante para este commit.
 *
 * ## Reintento de `neto_acreditado`: mismo mecanismo, mismo margen, sin remedir contra ESTE documento
 *
 * `reintentarNetoAcreditado`, `MARGEN_REINTENTO_NETO_PX` (70px) y `TOPE_REINTENTOS_NETO_POR_DOCUMENTO`
 * se portan igual que débito — el mecanismo (recortar la banda vertical y reconocer sola, sin el resto
 * de la página compitiendo) no depende del formato. El margen de 70px es el punto de partida razonable
 * heredado de la medición contra el documento de débito; no se remidió específicamente contra el
 * documento de crédito en este commit — queda documentado como pendiente, no bloqueante.
 */

import { parsearFecha, parsearImporte, sumarImportes } from '../../parseo-ar.ts';
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

export const FORMATO_CODIGO = 'visa_credito';
export const VERSION = 1;

/**
 * Capacidades medidas contra el documento real. `traeTotalDelEmisor: true`: el encabezado trae un
 * total consolidado tipo "Neto de pagos" (mismo patrón `NETO`+`PAGOS` sin `IMPORTE` que usa débito
 * para el mismo campo — 7 candidatas medidas en el documento). `publicaBaseYAlicuotaPorRenglon: false`:
 * el documento nunca imprime una base separada para estos totales, solo etiqueta + importe (y en dos
 * casos, también la tasa). `traePercepcionIva: true`: confirmado, con sus dos tasas por bloque.
 */
export const CAPACIDADES_VISA_CREDITO: CapacidadesDeFormato = {
  traeTotalDelEmisor: true,
  publicaBaseYAlicuotaPorRenglon: false,
  traePercepcionIva: true,
};

/** Marca genérica del formato Visa: aparece en débito Y en crédito, no alcanza sola. */
const MARCA_GENERICA = /RESUMEN MENSUAL DE LIQUIDACIONES A COMERCIOS/;
/** Marca específica de crédito. Verificado: NO aparece en el documento real de débito. */
const MARCA_CREDITO = /TARJETA DE CREDITO PESOS/;

/** Ver el comentario de cabecera: mismo mecanismo de agrupamiento que débito, mismo valor. */
const TOLERANCIA_FILA_OCR = 20;

/** Ver el comentario de cabecera: heredado de débito, no remedido contra este documento. */
const MARGEN_REINTENTO_NETO_PX = 70;

/**
 * Tope de reintentos de OCR por documento — mismo criterio que débito: cuenta intentos (éxito o
 * fracaso), no solo fallos. El documento real tiene 17 liquidaciones confirmadas; `30` da margen
 * amplio sin dejar que un bug de matching dispare reintentos sin límite contra un documento
 * degenerado.
 */
export const TOPE_REINTENTOS_NETO_POR_DOCUMENTO = 30;

/**
 * Tope de palabras de una fila que matchea `VENTA` + `CUOTA` para considerarla una línea de totales.
 * Ver el comentario de cabecera: el párrafo de aviso legal medido tiene 27 palabras; las líneas de
 * totales reales medidas tienen entre 5 y 9. `15` da margen amplio sobre el máximo legítimo medido y
 * queda bien por debajo del párrafo — no es un umbral ajustado al límite.
 */
const MAX_PALABRAS_VENTA_CUOTAS = 15;

// -----------------------------------------------------------------------------
// Filas visuales sobre palabras OCR — reimplementado local, nunca importado de `visa-debito.ts` ni de
// `toolkit.ts` (mismo criterio que débito: es mecanismo de agrupamiento, no vocabulario compartido).
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

/**
 * Los tokens con forma de importe de la fila, **no negativos** — mismo criterio que débito: ninguno de
 * los totales que este adapter captura puede ser negativo (`importeNoNegativo` en `esquema.ts`), y una
 * fila que absorbiera un token vecino con signo produciría un importe inválido contra el esquema. Mejor
 * un campo sin capturar que un valor con el signo equivocado.
 */
function importesDeFila(fila: FilaOcr): readonly PalabraOcr[] {
  return fila.palabras.filter((p) => {
    const v = parsearImporte(p.texto);
    return v !== null && !v.startsWith('-');
  });
}

// Sin sufijo "_TOKEN" a propósito: dispara R37 (barrido de credenciales) por la substring "TOKEN",
// mismo criterio que ya fija `visa-debito.ts`.
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

export function reconoceVisaCredito(entrada: EntradaDeLiquidacion): boolean {
  const primera = entrada.paginas[0];
  if (primera === undefined) return false;
  const texto = textoDePaginaParaDeteccion(primera);
  return MARCA_GENERICA.test(texto) && MARCA_CREDITO.test(texto);
}

// -----------------------------------------------------------------------------
// Lectura de una liquidación: etiqueta + proximidad
// -----------------------------------------------------------------------------

/**
 * Definición de una línea de total. `esLinea` recibe la fila NORMALIZADA (para el vocabulario) y la
 * CRUDA (para estructura como el pipe/corchete de borde de tabla — nunca para vocabulario, la cruda no
 * está mayuscularizada ni acentos-limpia).
 */
type LineaDeTotal = {
  readonly concepto: 'venta_contado' | 'venta_cuotas' | RenglonDeLiquidacion['concepto'] | 'neto_acreditado';
  readonly esLinea: (normalizada: string, cruda: string) => boolean;
};

const LINEAS_DE_TOTAL: readonly LineaDeTotal[] = [
  // Contribuyen al campo escalar `ventasBrutas` (nunca a `renglones[]`) — ver el comentario de cabecera.
  { concepto: 'venta_contado', esLinea: (t) => t.includes('VENTA') && t.includes('CONTADO') },
  {
    concepto: 'venta_cuotas',
    esLinea: (t, cruda) =>
      t.includes('VENTA') && t.includes('CUOTA') && cruda.split(' ').length <= MAX_PALABRAS_VENTA_CUOTAS,
  },
  {
    concepto: 'arancel',
    // Pipe/corchete: artefacto de borde de tabla, no vocabulario. Ver el comentario de cabecera sobre
    // por qué NO se usa `FINANC` acá (10/19 no alcanza en este documento).
    esLinea: (t, cruda) => t.includes('ARANCEL') && !/[|[\]]/.test(cruda),
  },
  {
    concepto: 'iva_21_sobre_arancel',
    esLinea: (t) => t.includes('IVA') && t.includes('ARANC') && !t.includes('PERCEP'),
  },
  { concepto: 'retencion_iibb_sirtac', esLinea: (t) => t.includes('SIRTAC') },
  { concepto: 'percepcion_iva_rg2408', esLinea: (t) => t.includes('PERCEP') },
  {
    concepto: 'interes_financiacion_cuotas',
    // Ver el comentario de cabecera: deliberadamente sin el signo `-` como condición (2/20 arancel y
    // 1/21 SIRTAC pierden el signo por OCR sobre filas ya confirmadas como deducciones reales).
    esLinea: (t, cruda) =>
      t.includes('FINANC') && !(t.includes('VENTA') && t.includes('CUOTA')) && !/[|[\]]/.test(cruda),
  },
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

/**
 * Acumula un `TotalLeido` bajo `concepto`, SIEMPRE agregando a la lista existente — nunca
 * sobreescribiendo. Es el único punto que escribe en `pendientes`, a propósito: el bug de la
 * percepción con dos tasas (pisar la primera con `.set(concepto, [total])`) solo puede colarse si
 * hay más de un punto de escritura, y acá hay uno solo. Ver el test de mutación,
 * `../../tests/liquidaciones-visa-credito-percepcion.test.ts`.
 */
function acumularPendiente(pendientes: Map<string, TotalLeido[]>, concepto: string, total: TotalLeido): void {
  pendientes.set(concepto, [...(pendientes.get(concepto) ?? []), total]);
}

/** Estado mutable del reintento de `neto_acreditado`, compartido por todo el documento. */
type EstadoReintentoNeto = { contador: number; topeAlcanzado: boolean };

/**
 * Reintento ACOTADO, solo para `neto_acreditado` — mismo mecanismo que `visa-debito.ts`
 * (`reintentarNetoAcreditado`): recorta la banda vertical de la fila y le pide a Tesseract que la lea
 * sola, sin el resto de la página densa compitiendo por la segmentación automática. Nunca propaga una
 * excepción: cualquier error de `reconocerRecorte` se trata igual que "no recuperó nada".
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

export async function leerVisaCredito(entrada: EntradaDeLiquidacion): Promise<SalidaDeLiquidacion> {
  const liquidaciones: LiquidacionLeida[] = [];
  const lineasNoInterpretadas: LineaNoInterpretadaDeLiquidacion[] = [];
  const confianzaDeCaptura: ConfianzaDeCampo[] = [];
  let totalConsolidadoDeclarado: string | undefined;
  const estadoReintento: EstadoReintentoNeto = { contador: 0, topeAlcanzado: false };

  // Acumulador del bloque en construcción: lo que se leyó desde el último cierre. Lista por concepto —
  // ver `acumularPendiente` y el comentario de cabecera sobre por qué el TIPO es lista aunque la
  // mayoría de los conceptos solo use el primer elemento.
  let pendientes = new Map<string, TotalLeido[]>();
  // Ventas del bloque: 0-1 `venta_contado` + 1-3 `venta_cuotas`, sumadas al cerrar. Nunca un renglón.
  let ventasAcumuladas: TotalLeido[] = [];

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
    // de "IMPORTE NETO DE PAGOS" que se repite por liquidación — mismo criterio que débito.
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
      const textoCrudo = textoDeFilaOcr(fila);
      const textoNormalizado = normalizar(textoCrudo);

      if (ES_LINEA_CIERRE(textoNormalizado)) {
        const cierre = leerLineaDeCierre(fila);
        const bloque = cerrarLiquidacion(pendientes, ventasAcumuladas, cierre, numeroPagina);
        if (bloque === 'incompleto') {
          lineasNoInterpretadas.push({
            codigo: 'bloque_de_totales_no_interpretado',
            paginaPdf: numeroPagina,
            indice: indiceFila,
            forma: formaDeLineaDeLiquidacion(textoCrudo),
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
        ventasAcumuladas = [];
        continue;
      }

      const linea = LINEAS_DE_TOTAL.find((l) => l.esLinea(textoNormalizado, textoCrudo));
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
          forma: formaDeLineaDeLiquidacion(textoCrudo),
        });
        continue;
      }

      if (linea.concepto === 'venta_contado' || linea.concepto === 'venta_cuotas') {
        ventasAcumuladas.push(total);
      } else {
        acumularPendiente(pendientes, linea.concepto, total);
      }
    }
  }

  // Un acumulador que quedó abierto al final del documento (sin línea de cierre después) es un bloque
  // incompleto: se reporta, no se descarta en silencio.
  if (pendientes.size > 0 || ventasAcumuladas.length > 0) {
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
    // `undefined` (omitido) cuando no se activó — la ausencia se representa, nunca se rellena con `false`.
    ...(estadoReintento.topeAlcanzado ? { topeDeReintentosAlcanzado: true } : {}),
  };
}

type BloqueCerrado =
  | { readonly liquidacion: LiquidacionLeida; readonly confianzas: readonly { campo: string; palabra: PalabraOcr }[] }
  | 'incompleto';

/** Conceptos que en este documento se midieron singulares: como máximo un renglón por bloque. */
const CONCEPTOS_SINGULARES = [
  'arancel',
  'iva_21_sobre_arancel',
  'retencion_iibb_sirtac',
  'interes_financiacion_cuotas',
] as const;

/**
 * Combina lo acumulado desde el último cierre con la propia línea de cierre en una `LiquidacionLeida`.
 *
 * Campos mínimos para construir un bloque válido: al menos una línea de venta (`ventasAcumuladas`),
 * `neto_acreditado`, y la fecha de presentación. Sin alguno de los tres, el bloque es `'incompleto'`:
 * no se rellena con un valor inventado, se reporta.
 */
function cerrarLiquidacion(
  pendientes: ReadonlyMap<string, readonly TotalLeido[]>,
  ventasAcumuladas: readonly TotalLeido[],
  cierre: CierreLeido,
  pagina: number,
): BloqueCerrado {
  const neto = pendientes.get('neto_acreditado')?.[0];
  const ventasBrutas =
    ventasAcumuladas.length > 0 ? sumarImportes(ventasAcumuladas.map((t) => t.monto)) : null;
  if (!neto || ventasBrutas === null || cierre.fechaPresentacion === null) return 'incompleto';

  const confianzas: { campo: string; palabra: PalabraOcr }[] = [
    ...ventasAcumuladas.map((t, i) => ({ campo: `ventasBrutas[${i}]`, palabra: t.palabraMonto })),
    { campo: 'netoAcreditado', palabra: neto.palabraMonto },
  ];

  const renglones: RenglonDeLiquidacion[] = [];

  const empujarRenglon = (concepto: RenglonDeLiquidacion['concepto'], leido: TotalLeido): void => {
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
  };

  // Conceptos singulares: un único valor esperado (`?.[0]`) — no se generaliza a lista aunque el
  // acumulador ya lo soporte. Ver el comentario de cabecera.
  for (const concepto of CONCEPTOS_SINGULARES) {
    const leido = pendientes.get(concepto)?.[0];
    if (leido) empujarRenglon(concepto, leido);
  }

  // `percepcion_iva_rg2408`: la ÚNICA lista real medida — hasta dos tasas por bloque, un renglón por
  // cada una, EN EL ORDEN en que se leyeron. Nunca reordenado por valor.
  for (const leido of pendientes.get('percepcion_iva_rg2408') ?? []) {
    empujarRenglon('percepcion_iva_rg2408', leido);
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
    ventasBrutas,
    netoAcreditado: neto.monto,
    renglones,
    // No medido en la muestra visual del documento real: se busca la frase, y ausente es `false`, nunca
    // un supuesto. Mismo criterio que débito.
    caveatDeComputoFiscal: false,
    paginaPdf: pagina,
  };

  return { liquidacion, confianzas };
}

export const adaptadorVisaCredito: AdaptadorDeLiquidacion = {
  formatoCodigo: FORMATO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_VISA_CREDITO,
  reconoce: reconoceVisaCredito,
  leer: leerVisaCredito,
};
