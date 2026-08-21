/**
 * ADAPTER CABAL DÉBITO — plan 14, tercer formato. Diagnóstico previo en HANDOFF 89 (2026-08-20),
 * detalle de matching confirmado en esta sesión vía script temporal read-only + `formaDeLineaDeLiquidacion`
 * contra el PDF — nunca contra el audio del incidente #9 (`docs/seguridad/registro-incidentes.md`, fila 9).
 *
 * ## El documento es 100% escaneado, igual que los dos Visa — y cada liquidación es un bloque aislado
 *
 * `privado/tarjetas/03-extracto_cabal_liquidacion_roka.pdf`: enteramente escaneado (OCR). A diferencia de
 * Visa, Cabal **no publica un total consolidado del período** en ningún lugar del documento — cada
 * liquidación es un bloque independiente, sin checksum del emisor posible (HANDOFF 89, punto 5). De ahí
 * `traeTotalDelEmisor: false` en `CAPACIDADES_CABAL_DEBITO`, y por eso este adapter nunca busca ni
 * expone `totalConsolidadoDeclarado` — a diferencia de `visa-debito.ts`, no hay nada que buscar.
 *
 * ## La forma del documento — mismo patrón de bloque que Visa, un desglose repetido dos veces
 *
 * Cada liquidación repite, dos veces, el mismo desglose de conceptos (una vez parcial, una vez completo
 * — HANDOFF 89, punto 3): `total de ventas`, `arancel`, `IVA s/arancel` aparecen primero en una forma
 * reducida y después, más abajo, en la forma completa que además trae la retención de IIBB y el neto
 * final. La etiqueta impresa (no un dato del comercio) es lo único estable, igual que en los dos Visa.
 *
 * **Estrategia: dejar que la SEGUNDA aparición gane, por posición, no por vocabulario.** El acumulador
 * `pendientes` es un `Map` que se sobreescribe con `.set()` en cada match — igual mecanismo que ya usan
 * los dos Visa. Para `ventas_brutas`, `arancel` e `iva_21_sobre_arancel`, la condición de `esLinea`
 * matchea las DOS apariciones a propósito (nunca se intenta distinguir "cuál es la parcial" por
 * vocabulario, medido que no hay una etiqueta propia para eso): la del desglose completo, que aparece
 * después, sobreescribe a la del parcial sin código adicional — exactamente el criterio que HANDOFF 89
 * dejó pendiente ("por posición, no por vocabulario").
 *
 * ## `ventas_brutas`: por qué la condición necesita una segunda palabra, no solo `VENTA`
 *
 * Medido contra el documento real: el token `VENTA` también aparece en una fila de encabezado de columna
 * de la tabla de comprobantes, sin ningún importe — igual clase de ruido que ya resuelve
 * `!includes('FINANC')` en `visa-debito.ts` para `arancel`. Acá la fila de encabezado nunca trae la
 * palabra `TOTAL` junto a `VENTA`, y las dos filas reales del desglose (parcial y completo) sí la traen
 * las dos veces — así que `VENTA && TOTAL` aísla limpio las filas reales sin necesidad de excluir nada.
 *
 * ## `arancel` / `iva_21_sobre_arancel`: SIN el filtro de pipe/corchete que usa `visa-credito.ts`
 *
 * Medido contra el documento real (mismo método que `visa-credito.ts:49-58` aplicó para decidir lo
 * contrario): acá ese ruido de borde de tabla no aparece en las filas candidatas de estos dos conceptos.
 * En cambio, la etiqueta de IVA acá SÍ contiene la palabra completa `ARANCEL` (a diferencia de Visa, que
 * usa la forma abreviada `ARANC`), así que la exclusión mutua se resuelve con `!includes('IVA')` para
 * `arancel` — el filtro estructural de Visa no hacía falta, pero sí un filtro de vocabulario propio.
 *
 * **Condición de `security-engineer` (verde con condiciones, previo a este commit):** al no llevar el
 * filtro estructural de pipe/corchete, la única red contra un falso positivo (una fila de encabezado o
 * de párrafo legal que mencione estas palabras sin ser un total real) es el propio vocabulario — se
 * agrega el test de mutación correspondiente en `liquidaciones-cabal-debito-matching.test.ts`.
 *
 * ## `retencion_iibb_sirtac`: `SIRTAC` sola alcanza
 *
 * HANDOFF 89 dejó esto como "a determinar con más cuidado" porque, contadas por separado, ninguna de las
 * tres palabras candidatas (`SIRTAC`, `IIBB`/`INGRESOS BRUTOS`, `RETEN`) aislaba el concepto por sí sola.
 * Medido ahora la CO-OCURRENCIA por fila, no el conteo aislado: en toda fila real de este concepto las
 * tres aparecen juntas, y la única fuente de ruido con alguna de las tres (un párrafo genérico que
 * menciona ingresos brutos/retención sin nombrar el régimen) nunca trae `SIRTAC` — así que `SIRTAC` sola,
 * igual que en los dos Visa, aísla el concepto sin ambigüedad.
 *
 * ## `neto_acreditado`: comparte vocabulario con la candidata de inicio de bloque, no con el cierre
 *
 * El token `NETO` aparece pegado a la frase que además sirve para reconocer dónde arranca el siguiente
 * desglose (HANDOFF 89, punto 3: "el neto vive en la misma sección que cierra el bloque"). Medido: la
 * combinación `NETO && LIQUIDAR` aísla la o las filas del neto sin capturar la línea de cierre
 * (`ES_LINEA_CIERRE`, que nunca trae `NETO`) ni ninguna otra fila del bloque.
 *
 * ## `ES_LINEA_CIERRE`: PAGO + FECHA + variante de LIQUIDA, verificado contra el encabezado
 *
 * Candidata medida en HANDOFF 89 (punto 2, método 2). Verificado en esta sesión que la combinación nunca
 * dispara antes de la primera liquidación real (fila de carátula/encabezado del documento) — igual
 * garantía que ya tiene `ES_LINEA_CIERRE` en los dos Visa.
 *
 * ## El bloque final sin cierre: sin heurística nueva
 *
 * HANDOFF 89 (punto 2b) ya midió que la última liquidación del documento no tiene una fila con la forma
 * de `ES_LINEA_CIERRE` después — el mecanismo ya existente en los dos Visa (`pendientes.size > 0` al
 * final del documento → `bloque_de_totales_no_interpretado`) cubre el caso sin código nuevo.
 *
 * ## `traePercepcionIva: false` — sin percepción IVA RG2408 en ningún bloque (HANDOFF 89, punto 4)
 *
 * Por eso este adapter no declara ningún matcher para `percepcion_iva_rg2408`: a diferencia de los dos
 * Visa, el concepto no está en `LINEAS_DE_TOTAL` ni en la lista de renglones de `cerrarLiquidacion`.
 *
 * ## `publicaBaseYAlicuotaPorRenglon: false` — PREDICCIÓN POR ANALOGÍA, NO CONFIRMADA
 *
 * 🔴 Este valor **no** está confirmado contra el texto real del documento — es una predicción por
 * analogía con los dos Visa, que declaran `false` por la misma definición exacta: el campo exige que el
 * documento imprima una BASE separada (el monto sobre el que se aplica la tasa), no solo tasa+importe
 * (`visa-debito.ts:97-99`: "la tasa sola, sin base, no cumple 'publica base Y alícuota'"). Las filas de
 * `arancel`/`iva_21_sobre_arancel` que este adapter efectivamente captura (la aparición del desglose
 * completo, la que sobrevive al `.set()` final) muestran, en la medición estructural de esta sesión, como
 * mucho dos tokens con forma de importe — el mismo patrón tasa+monto que Visa, nunca tres o más de forma
 * consistente. Eso apoya la analogía pero no la prueba: si al leer el documento con más cuidado apareciera
 * una fila con una base impresa aparte, el valor correcto pasaría a ser `true`. No se lee la etiqueta real
 * para confirmar esto — hacerlo no aporta nada que la medición estructural ya no muestre, y correr un
 * script adicional solo para leer texto real sin necesidad operativa sería exactamente el tipo de
 * exposición que este módulo existe para evitar.
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

export const FORMATO_CODIGO = 'cabal_debito';
export const VERSION = 1;

/**
 * Capacidades medidas contra el documento real, salvo `publicaBaseYAlicuotaPorRenglon` — ver el
 * comentario de cabecera, sección dedicada: es una predicción por analogía con Visa, no confirmada.
 */
export const CAPACIDADES_CABAL_DEBITO: CapacidadesDeFormato = {
  traeTotalDelEmisor: false,
  publicaBaseYAlicuotaPorRenglon: false,
  traePercepcionIva: false,
};

/**
 * Marcas del formato (vocabulario impreso por Cabal, igual para todo comercio — nunca un dato del
 * cliente). AND, no OR: mismo criterio que ya corrigió `visa-credito.ts` para no repetir el bug
 * documentado en `visa-debito.ts:111-124` (una sola frase compartida entre formatos, con `.some()`,
 * resolviendo `ambiguo` de más o reconociendo el formato equivocado). Cabal no comparte ninguna de las
 * dos frases con los dos Visa (medido: ni "TARJETA" ni "MENSUAL" aparecen en la página 1 de este
 * documento), así que la ambigüedad no es un riesgo medido hoy — pero AND es la forma correcta desde el
 * primer commit, no algo para corregir después.
 */
const MARCA_EMISOR = /CABAL/;
const MARCA_TIPO = /DEBITO/;

/** Ver el comentario de cabecera de `visa-debito.ts`: misma tolerancia, mismo criterio de agrupación. */
const TOLERANCIA_FILA_OCR = 20;

/**
 * Margen de reintento para `neto_acreditado`, reusando el mecanismo de `visa-debito.ts` (ver su propio
 * comentario para la medición que lo fija). No remedido acá: mismo pipeline de OCR, mismo tipo de
 * documento (foto vía CamScanner), sin motivo para esperar un comportamiento distinto.
 */
const MARGEN_REINTENTO_NETO_PX = 70;

/** Ver el comentario de `visa-debito.ts`: mismo criterio, el número de liquidaciones lo cuenta este
 * mismo adapter (`ES_LINEA_CIERRE`), no un valor fijo citado de memoria. */
export const TOPE_REINTENTOS_NETO_POR_DOCUMENTO = 30;

// -----------------------------------------------------------------------------
// Filas visuales sobre palabras OCR — reimplementado local, igual que los dos Visa (no se comparte
// entre los tres adapters de liquidaciones: tercera repetición del mismo patrón, queda anotado al pie
// de este archivo para que `tech-lead` lo evalúe cuando corresponda, fuera del alcance de este commit).
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
 * Mismo criterio base que `visa-debito.ts`: por default nunca acepta un importe negativo (ver su
 * comentario — una fila puede absorber un token vecino con signo). `permitirNotacionNegativa` lo abre
 * para los tres conceptos que el documento real de Cabal imprime con el signo al final — ver el
 * comentario de `CONCEPTOS_QUE_ADMITEN_NOTACION_NEGATIVA`.
 */
function importesDeFila(fila: FilaOcr, permitirNotacionNegativa: boolean): readonly PalabraOcr[] {
  return fila.palabras.filter((p) => {
    const v = parsearImporte(p.texto);
    return v !== null && (permitirNotacionNegativa || !v.startsWith('-'));
  });
}

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

export function reconoceCabalDebito(entrada: EntradaDeLiquidacion): boolean {
  const primera = entrada.paginas[0];
  if (primera === undefined) return false;
  const texto = textoDePaginaParaDeteccion(primera);
  return MARCA_EMISOR.test(texto) && MARCA_TIPO.test(texto);
}

// -----------------------------------------------------------------------------
// Lectura de una liquidación: etiqueta + proximidad
// -----------------------------------------------------------------------------

type LineaDeTotal = {
  readonly concepto: RenglonDeLiquidacion['concepto'] | 'ventas_brutas' | 'neto_acreditado';
  readonly esLinea: (normalizada: string) => boolean;
};

const LINEAS_DE_TOTAL: readonly LineaDeTotal[] = [
  {
    // Ver el comentario de cabecera: excluye el encabezado de columna de la tabla de comprobantes, que
    // trae VENTA sin TOTAL y sin importe.
    concepto: 'ventas_brutas',
    esLinea: (t) => t.includes('VENTA') && t.includes('TOTAL'),
  },
  {
    // La etiqueta de IVA acá contiene la palabra completa ARANCEL (a diferencia de Visa, que usa la
    // forma abreviada ARANC) — la exclusión mutua es por vocabulario, no por estructura.
    concepto: 'arancel',
    esLinea: (t) => t.includes('ARANCEL') && !t.includes('IVA'),
  },
  {
    concepto: 'iva_21_sobre_arancel',
    esLinea: (t) => t.includes('IVA') && t.includes('ARANC'),
  },
  {
    // SIRTAC sola alcanza: ver el comentario de cabecera, la co-ocurrencia con IIBB/RETEN es siempre
    // conjunta en la fila real, y el único ruido con alguna de las tres nunca trae SIRTAC.
    //
    // 🔴 LÍMITE CONOCIDO, no cerrado en este commit. A diferencia de `arancel`/`iva_21_sobre_arancel`,
    // esta fila trae dos importes con forma válida cuando el OCR la lee completa — consistente con que
    // el concepto SÍ publique una base separada además del monto (al revés de lo que se predijo para
    // `publicaBaseYAlicuotaPorRenglon`, que solo se midió para arancel/IVA, nunca para este concepto).
    // `leerLineaDeTotal` toma el ÚLTIMO importe de la fila como monto — correcto cuando los dos números
    // se leen enteros. Pero medido contra el documento real: en varias liquidaciones el OCR separa la
    // parte decimal del monto real en un token aparte (un problema de espaciado, no de la fórmula),
    // ese token partido no parsea como importe válido, y el ÚNICO importe que sobrevive entero termina
    // siendo la base — que mi código toma como si fuera el monto, sin forma de distinguir
    // estructuralmente "esta fila nunca tuvo un segundo número" de "lo tuvo y el OCR lo rompió". Eso
    // corrompe el eje 1 en las liquidaciones donde pasa. Mismo criterio que ya documenta
    // `visa-debito.ts` para su propia cobertura parcial de OCR (`neto_acreditado`, plan 16): cobertura
    // parcial con la causa medida y escrita es un cierre legítimo, no forzar un heurístico de "reunir
    // tokens partidos" sin medirlo aparte. Candidato para un commit futuro, análogo al plan 16: un
    // reintento de OCR sobre el recorte de esta fila específica cuando el importe no parsea.
    concepto: 'retencion_iibb_sirtac',
    esLinea: (t) => t.includes('SIRTAC'),
  },
  {
    concepto: 'neto_acreditado',
    esLinea: (t) => t.includes('NETO') && t.includes('LIQUIDAR'),
  },
];

/**
 * Los tres conceptos que RESTAN se imprimen, medido contra el documento real, con el signo AL FINAL del
 * monto (`765,00-`) — notación contable de deducción, que `parsearImporte` ya reconoce
 * (`parseo-ar.ts:118`, la misma forma que un banco usa para "saldo acreedor"). A diferencia de Visa
 * (donde el mismo dato se imprime en positivo, sin signo), acá excluir todo negativo —el criterio que
 * `visa-debito.ts` aplica siempre— descartaba la fila entera como sin importe. `ventas_brutas` y
 * `neto_acreditado` NO están en este conjunto: siguen excluyendo cualquier negativo, mismo criterio y
 * misma razón que Visa (una fila puede absorber un token vecino con signo, y un total nunca es
 * negativo).
 */
const CONCEPTOS_QUE_ADMITEN_NOTACION_NEGATIVA = new Set<LineaDeTotal['concepto']>([
  'arancel',
  'iva_21_sobre_arancel',
  'retencion_iibb_sirtac',
]);

/** Ver el comentario de cabecera: PAGO + FECHA + variante de LIQUIDA, verificado que no dispara sobre
 * el encabezado del documento. */
const ES_LINEA_CIERRE = (t: string): boolean => t.includes('PAGO') && t.includes('FECHA') && /LIQUID/.test(t);

type TotalLeido = {
  readonly monto: string;
  readonly palabraMonto: PalabraOcr;
  readonly alicuota?: { readonly valor: string; readonly palabra: PalabraOcr };
};

/** `RenglonDeLiquidacion.monto` y `LiquidacionLeida.ventasBrutas`/`netoAcreditado` son siempre no
 * negativos por esquema — el signo de una nota contable de deducción nunca se preserva en el dato. */
function absoluto(importe: string): string {
  return importe.startsWith('-') ? importe.slice(1) : importe;
}

function leerLineaDeTotal(fila: FilaOcr, permitirNotacionNegativa: boolean): TotalLeido | null {
  const importes = importesDeFila(fila, permitirNotacionNegativa);
  const ultimo = importes.at(-1);
  if (!ultimo) return null;
  const montoParseado = parsearImporte(ultimo.texto);
  if (montoParseado === null) return null;
  const monto = permitirNotacionNegativa ? absoluto(montoParseado) : montoParseado;

  if (importes.length > 1) {
    const primero = importes[0];
    const valorAlicuota = primero ? parsearImporte(primero.texto) : null;
    if (primero && valorAlicuota !== null) {
      return {
        monto,
        palabraMonto: ultimo,
        alicuota: {
          valor: permitirNotacionNegativa ? absoluto(valorAlicuota) : valorAlicuota,
          palabra: primero,
        },
      };
    }
  }
  return { monto, palabraMonto: ultimo };
}

type EstadoReintentoNeto = { contador: number; topeAlcanzado: boolean };

/** Mismo mecanismo que `visa-debito.ts` — ver su comentario para el detalle completo. Reusado sin
 * cambios de diseño: mismo pipeline de OCR, mismo tipo de documento. */
async function reintentarNetoAcreditado(
  pixeles: PixelesDePagina | null | undefined,
  numeroPagina: number,
  fila: FilaOcr,
  estado: EstadoReintentoNeto,
): Promise<TotalLeido | null> {
  if (!pixeles) return null;

  if (estado.contador >= TOPE_REINTENTOS_NETO_POR_DOCUMENTO) {
    estado.topeAlcanzado = true;
    return null;
  }

  const y0 = Math.max(0, fila.y - MARGEN_REINTENTO_NETO_PX);
  const y1 = Math.min(pixeles.height, fila.y + MARGEN_REINTENTO_NETO_PX);
  if (y0 >= y1) return null;

  estado.contador += 1;
  try {
    const recorte = await reconocerRecorte(pixeles, y0, y1);
    const filaRecorte: FilaOcr = {
      pagina: numeroPagina,
      y: fila.y,
      palabras: [...recorte.palabras].sort((a, b) => a.x - b.x),
    };
    // Solo se llama para `neto_acreditado` (ver el caller): nunca admite notación negativa.
    return leerLineaDeTotal(filaRecorte, false);
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

/**
 * A diferencia de Visa (dos fechas en la línea de cierre: pago y presentación), la línea de cierre de
 * Cabal trae UNA sola fecha — medido contra el documento real, consistente en las liquidaciones que
 * cierran. Esa única fecha se asigna al campo que el esquema exige sin excepción
 * (`fechaPresentacion`); `fechaDePago` queda sin publicar. No hay evidencia suficiente en la estructura
 * medida para distinguir con confianza una segunda fecha propia de "pago" en esta fila — hay otras
 * fechas en filas cercanas del bloque, pero no se pudo determinar qué campo representan sin leer el
 * texto real, y adivinar sería peor que declararlo `no_publicado`.
 */
function leerLineaDeCierre(fila: FilaOcr): CierreLeido {
  const fechas = fila.palabras.filter((p) => RE_FECHA.test(p.texto));
  const enteros = fila.palabras.filter((p) => RE_ENTERO.test(p.texto));

  const fechaTok = fechas[0] ?? null;
  const numeroTok = enteros[0] ?? null;

  return {
    fechaDePago: null,
    palabraFechaDePago: null,
    numeroDeLiquidacion: numeroTok ? numeroTok.texto : null,
    palabraNumero: numeroTok,
    fechaPresentacion: fechaTok ? parsearFecha(fechaTok.texto) : null,
    palabraFechaPresentacion: fechaTok,
  };
}

// -----------------------------------------------------------------------------
// El adapter
// -----------------------------------------------------------------------------

export async function leerCabalDebito(entrada: EntradaDeLiquidacion): Promise<SalidaDeLiquidacion> {
  const liquidaciones: LiquidacionLeida[] = [];
  const lineasNoInterpretadas: LineaNoInterpretadaDeLiquidacion[] = [];
  const confianzaDeCaptura: ConfianzaDeCampo[] = [];
  const estadoReintento: EstadoReintentoNeto = { contador: 0, topeAlcanzado: false };

  // Acumulador del bloque en construcción. Cabal no publica total consolidado (capacidades.traeTotalDelEmisor
  // = false): a diferencia de visa-debito.ts, este adapter nunca busca ni construye un
  // `totalConsolidadoDeclarado`.
  let pendientes = new Map<string, TotalLeido>();

  for (let indicePagina = 0; indicePagina < entrada.paginas.length; indicePagina += 1) {
    const pagina = entrada.paginas[indicePagina];
    const esOcr = entrada.usoOcrEnPagina[indicePagina] === true;
    const numeroPagina = indicePagina + 1;

    if (!esOcr || pagina === undefined || !('palabras' in pagina)) {
      lineasNoInterpretadas.push({
        codigo: 'desconocido',
        paginaPdf: numeroPagina,
        indice: 0,
        forma: formaDeLineaDeLiquidacion('[pagina con texto nativo, formato no medido para este caso]'),
      });
      continue;
    }

    const filas = agruparPalabrasEnFilas(numeroPagina, pagina.palabras);

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
      if (linea === undefined) continue;

      let total = leerLineaDeTotal(fila, CONCEPTOS_QUE_ADMITEN_NOTACION_NEGATIVA.has(linea.concepto));
      if (total === null && linea.concepto === 'neto_acreditado') {
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
      // `.set()` sobreescribe: la segunda aparición de un concepto (desglose completo) gana sobre la
      // primera (parcial) sin código adicional — ver el comentario de cabecera.
      pendientes.set(linea.concepto, total);
    }
  }

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
    confianzaDeCaptura,
    ...(estadoReintento.topeAlcanzado ? { topeDeReintentosAlcanzado: true } : {}),
  };
}

type BloqueCerrado =
  | { readonly liquidacion: LiquidacionLeida; readonly confianzas: readonly { campo: string; palabra: PalabraOcr }[] }
  | 'incompleto';

/** Mismos campos mínimos que `visa-debito.ts`: `ventasBrutas`, `netoAcreditado`, `fechaPresentacion`. */
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
  // Sin percepcion_iva_rg2408: capacidades.traePercepcionIva es false, y el concepto no está en
  // LINEAS_DE_TOTAL — nunca puede aparecer en pendientes.
  for (const concepto of ['arancel', 'iva_21_sobre_arancel', 'retencion_iibb_sirtac'] as const) {
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
    // No medido en la muestra estructural del documento real: se busca la frase, y ausente es `false`,
    // nunca un supuesto — mismo criterio que `visa-debito.ts`.
    caveatDeComputoFiscal: false,
    paginaPdf: pagina,
  };

  return { liquidacion, confianzas };
}

export const adaptadorCabalDebito: AdaptadorDeLiquidacion = {
  formatoCodigo: FORMATO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_CABAL_DEBITO,
  reconoce: reconoceCabalDebito,
  leer: leerCabalDebito,
};
