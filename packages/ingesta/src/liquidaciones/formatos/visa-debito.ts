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
import type { PalabraOcr, PaginaOcr } from '../../ocr.ts';
import type { FilaGeometrica } from '../../texto-pdf.ts';
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

/** Marcas del formato (vocabulario impreso por Visa, igual para todo comercio — nunca un dato del cliente). */
const MARCAS = [/RESUMEN MENSUAL DE LIQUIDACIONES A COMERCIOS/, /TARJETA DE DEBITO PESOS/];

/** Ver el comentario de cabecera: medido contra la página 1 del documento real. */
const TOLERANCIA_FILA_OCR = 20;

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

const RE_FECHA_TOKEN = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const RE_ENTERO_TOKEN = /^\d{3,}$/;

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
  return MARCAS.some((m) => m.test(texto));
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
  { concepto: 'arancel', esLinea: (t) => t.includes('ARANCEL') },
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

type CierreLeido = {
  readonly fechaDePago: string | null;
  readonly palabraFechaDePago: PalabraOcr | null;
  readonly numeroDeLiquidacion: string | null;
  readonly palabraNumero: PalabraOcr | null;
  readonly fechaPresentacion: string | null;
  readonly palabraFechaPresentacion: PalabraOcr | null;
};

function leerLineaDeCierre(fila: FilaOcr): CierreLeido {
  const fechas = fila.palabras.filter((p) => RE_FECHA_TOKEN.test(p.texto));
  const enteros = fila.palabras.filter((p) => RE_ENTERO_TOKEN.test(p.texto));

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

export function leerVisaDebito(entrada: EntradaDeLiquidacion): SalidaDeLiquidacion {
  const liquidaciones: LiquidacionLeida[] = [];
  const lineasNoInterpretadas: LineaNoInterpretadaDeLiquidacion[] = [];
  const confianzaDeCaptura: ConfianzaDeCampo[] = [];
  let totalConsolidadoDeclarado: string | undefined;

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

      const total = leerLineaDeTotal(fila);
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
