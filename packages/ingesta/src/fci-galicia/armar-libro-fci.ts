/**
 * ARMADO DEL LIBRO DE FCI — puro. Sin base, sin disco, sin `Tx`, sin auditoría, sin roles: recibe todo
 * ya calculado por argumento (mismo espíritu que `../planilla/armar-libro.ts`, que este archivo NO
 * reusa en lógica — esa hoja es de movimientos bancarios en pesos, esta es de cuotapartes de FCI —
 * pero sí en estilo: `ExcelJS.Workbook` construido a mano, headers en negrita, columnas con `numFmt`).
 *
 * ⚠️ `import ExcelJS from 'exceljs'` — nunca `import { Workbook }`: el paquete es CJS y ese nombrado
 * no existe como export ESM (mismo hallazgo que documenta `armar-libro.ts`).
 *
 * Ronda 2 del export (ajustes de Laura, HANDOFF): nombre real de fondo (ya no `fondo_N`, ver
 * `extraer-posiciones.ts`), fila de título con período por hoja de fondo, formato de número por TIPO
 * de columna (monto en pesos vs. cantidad de cuotaparte vs. precio de 6 decimales), y 3 columnas de
 * total nuevas en el Resumen.
 */

import ExcelJS from 'exceljs';
import { fechaIsoASerialExcel } from '../planilla/armar-libro.ts';

// -----------------------------------------------------------------------------
// Tipos de entrada — ya resueltos por quien llama (la simulación PEPS y el extractor), nada de
// aritmética de dominio acá.
// -----------------------------------------------------------------------------

export type FilaHojaFondo = {
  /** ISO, o `''` para la fila de cierre (esa fila no tiene fecha de movimiento propia). */
  readonly fecha: string;
  readonly tipo: 'suscripcion' | 'rescate' | 'cierre';
  /** Decimal canónico, `null` en la fila de cierre. */
  readonly cantidadDeCuotas: string | null;
  readonly precio: string | null;
  /** `cantidad × precio`, decimal canónico. */
  readonly total: string | null;
  /** Solo en filas `'rescate'` — suma de `ItemConsumo.resultado` de ESE rescate, ya formateada. */
  readonly rendimientoPorRescate: string | null;
  /** Espejo de `ResultadoConsumo.parcialmenteEstimado` de ESE rescate — `true`/`false` solo en filas
   *  `'rescate'`, `null` en `'suscripcion'`/`'cierre'` (no aplica: ahí no hay un `ResultadoConsumo`).
   *  Sin esto, el `.xlsx` no distingue un costo real de una capa de apertura sin precio conocido
   *  (`CapaFCI.costoConocido: false`) — que es el caso normal del primer corte de la serie. */
  readonly estimado: boolean | null;
  /** Solo en la fila `'cierre'` de cada corte — `tenenciaDeclarada`. */
  readonly stockAlCierre: string | null;
  /** Solo en `'cierre'` — `cotizacionDeclarada`. */
  readonly valorUnitarioAlCierre: string | null;
  /** Solo en `'cierre'` — `valorizadoDeclarada`. */
  readonly valuacionAlCierre: string | null;
};

export type FilaHojaResumen = {
  readonly corte: string;
  readonly porFondo: readonly {
    readonly fondo: string;
    /** `tenenciaDeclarada`. */
    readonly cantidad: string;
    /** `Σ (capa.cantidadRemanente × capa.precioUnitarioOrigen)` sobre las capas abiertas al cierre —
     *  YA CALCULADO por quien llama, este módulo solo lo escribe. */
    readonly valorHistorico: string;
    /** `valorizadoDeclarada`. */
    readonly valuacionAlCierre: string;
  }[];
  /** Suma de TODOS los rescates de TODOS los fondos en ESTE corte (mes) — no acumulado del ejercicio
   *  (confirmado contra `exportar-fci.ts`: filtra `consumos` por `cons.corte === c.corte` antes de
   *  sumar). El header de la columna dice "del mes" por esto mismo. */
  readonly rendimientoPorRescatesConsolidado: string;
  /** `true` si CUALQUIER rescate de CUALQUIER fondo en este corte fue parcialmente estimado — YA
   *  CALCULADO por quien llama (mismo criterio que `valorHistorico`), este módulo solo lo escribe. */
  readonly hayEstimadosEnElCorte: boolean;
  /** Suma de `porFondo[].cantidad` de ESTA MISMA fila (los 3 fondos de este corte) — YA CALCULADO por
   *  quien llama con `PuntoFijo`, este módulo solo lo escribe con el tratamiento de columna Total. */
  readonly cantidadTotal: string;
  /** Suma de `porFondo[].valorHistorico` de esta misma fila. */
  readonly valorHistoricoTotal: string;
  /** Suma de `porFondo[].valuacionAlCierre` de esta misma fila. */
  readonly valuacionAlCierreTotal: string;
};

// -----------------------------------------------------------------------------
// Formato — uno por TIPO de columna, no a ciegas en todas (ajuste de Laura): un monto en pesos lleva
// signo $ y 2 decimales; una cantidad de cuotaparte no lleva $ y son 2 decimales (así la muestra el
// extracto real de Galicia); un precio (cotización de la cuotaparte) necesita su precisión real de 6
// decimales — forzarlo a 2 lo redondearía y dejaría de coincidir con el extracto del banco.
// -----------------------------------------------------------------------------

const FMT_CANTIDAD = '#,##0.00';
const FMT_IMPORTE = '"$" #,##0.00';
const FMT_PRECIO = '#,##0.000000';
const FMT_FECHA = 'dd/mm/yyyy';

const TEXTO_TIPO: Readonly<Record<FilaHojaFondo['tipo'], string>> = {
  suscripcion: 'Suscripción',
  rescate: 'Rescate',
  cierre: 'Cierre de corte',
};

/** Decimal canónico → `number` para una celda de Excel. Único borde de salida hacia un formato sin
 *  precisión arbitraria — la aritmética real ya se hizo en `PuntoFijo` antes de llegar acá. */
function numeroOpcional(texto: string | null): number | null {
  return texto === null ? null : Number(texto);
}

/** `boolean | null` → texto legible para Laura ('Sí'/'No'), nunca un booleano crudo en la celda —
 *  `null` (no aplica) queda como celda vacía, mismo criterio que `TEXTO_TIPO`. */
function textoSiNo(valor: boolean | null): string {
  return valor === null ? '' : valor ? 'Sí' : 'No';
}

// -----------------------------------------------------------------------------
// Formato visual — colores suaves, consistentes entre las hojas de fondo y la de Resumen (no hace
// falta que sean idénticos, sí de la misma familia). ARGB de ExcelJS (`FFRRGGBB`).
// -----------------------------------------------------------------------------

/** Encabezado de columna — celeste suave ("Blue, Accent 1, Lighter 80%" de Office, no un tono
 *  inventado), consistente en las 3 hojas de fondo y en el Resumen. */
const ARGB_ENCABEZADO = 'FFDDEBF7';
/** Columnas de Total del Resumen — dorado suave ("Gold, Accent 4, Lighter 80%" de Office), para que se
 *  distingan a simple vista de las columnas por fondo, en header y en dato (negrita + relleno). */
const ARGB_TOTAL = 'FFFFF2CC';
/** Borde fino de las celdas de datos — gris neutro, no compite con los rellenos de arriba. */
const ARGB_BORDE = 'FFBFBFBF';

const BORDE_FINO: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: ARGB_BORDE } },
  left: { style: 'thin', color: { argb: ARGB_BORDE } },
  bottom: { style: 'thin', color: { argb: ARGB_BORDE } },
  right: { style: 'thin', color: { argb: ARGB_BORDE } },
};

function aplicarBordeFila(fila: ExcelJS.Row, cantColumnas: number): void {
  for (let i = 1; i <= cantColumnas; i += 1) {
    fila.getCell(i).border = BORDE_FINO;
  }
}

function aplicarFillFila(fila: ExcelJS.Row, cantColumnas: number, argb: string): void {
  for (let i = 1; i <= cantColumnas; i += 1) {
    fila.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  }
}

// -----------------------------------------------------------------------------
// Nombre de hoja — mismo criterio que `armar-libro.ts`: ≤31 chars, sin caracteres inválidos, único.
// -----------------------------------------------------------------------------

/** Nombre de hoja vacío tras sanear el nombre del fondo — un PDF mal extraído que deja el nombre
 *  reducido a puros caracteres inválidos. Falla cerrado (`throw`), nunca `addWorksheet('', ...)` en
 *  silencio (hallazgo de `security-engineer`, ronda 2). */
export class NombreDeFondoVacioError extends Error {
  constructor() {
    super('El nombre del fondo quedó vacío después de sanear caracteres inválidos de hoja de Excel.');
    this.name = 'NombreDeFondoVacioError';
  }
}

function nombreDeHojaFondo(fondo: string, usados: Set<string>): string {
  // Excel también prohíbe un nombre de hoja que empiece o termine con apóstrofe — `security-engineer`
  // (ronda 2), no cubierto por el regex de caracteres inválidos de abajo.
  const base = fondo
    .replace(/[[\]:*?/\\]/g, '-')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 28);
  if (base === '') throw new NombreDeFondoVacioError();
  let candidato = base;
  let sufijo = 2;
  while (usados.has(candidato.toLowerCase())) {
    candidato = `${base} (${sufijo})`.slice(0, 31);
    sufijo += 1;
  }
  usados.add(candidato.toLowerCase());
  return candidato;
}

// -----------------------------------------------------------------------------
// Hoja por fondo
// -----------------------------------------------------------------------------

function armarHojaFondo(
  libro: ExcelJS.Workbook,
  nombreDeHoja: string,
  fondo: string,
  periodoLabel: string,
  filas: readonly FilaHojaFondo[],
): void {
  const hoja = libro.addWorksheet(nombreDeHoja, { views: [{ state: 'frozen', ySplit: 2 }] });

  hoja.columns = [
    { header: 'Fecha', key: 'fecha', width: 12, style: { numFmt: FMT_FECHA } },
    { header: 'Tipo de movimiento', key: 'tipo', width: 18 },
    { header: 'Cantidad de cuotas', key: 'cantidad', width: 18, style: { numFmt: FMT_CANTIDAD } },
    { header: 'Precio', key: 'precio', width: 16, style: { numFmt: FMT_PRECIO } },
    { header: 'Total', key: 'total', width: 18, style: { numFmt: FMT_IMPORTE } },
    { header: 'Rendimiento por rescate', key: 'rendimiento', width: 22, style: { numFmt: FMT_IMPORTE } },
    { header: 'Estimado', key: 'estimado', width: 12 },
    { header: 'Stock al cierre', key: 'stock', width: 16, style: { numFmt: FMT_CANTIDAD } },
    { header: 'Valor unitario al cierre', key: 'valorUnitario', width: 22, style: { numFmt: FMT_PRECIO } },
    { header: 'Valuación al cierre', key: 'valuacion', width: 20, style: { numFmt: FMT_IMPORTE } },
  ];
  const cantColumnas = hoja.columns.length;

  // `columns` escribe los headers en la fila 1. Se empuja todo una fila abajo para dejarle lugar a la
  // fila de título — si se pusiera el título ANTES de fijar `columns`, `columns` lo pisaría en
  // silencio (mismo mecanismo que `armar-libro.ts`, `armarHojaControl`).
  hoja.spliceRows(1, 0, []);
  hoja.getCell('A1').value = `${fondo} — ${periodoLabel}`;
  hoja.getCell('A1').font = { bold: true, size: 13 };
  hoja.getCell('A1').alignment = { vertical: 'middle' };
  hoja.mergeCells(1, 1, 1, cantColumnas);

  const filaHeader = hoja.getRow(2);
  filaHeader.font = { bold: true };
  filaHeader.alignment = { vertical: 'middle', wrapText: true };
  aplicarFillFila(filaHeader, cantColumnas, ARGB_ENCABEZADO);

  filas.forEach((f, indice) => {
    const fila = hoja.getRow(3 + indice);
    fila.getCell(1).value = f.fecha === '' ? null : fechaIsoASerialExcel(f.fecha);
    fila.getCell(2).value = TEXTO_TIPO[f.tipo];
    fila.getCell(3).value = numeroOpcional(f.cantidadDeCuotas);
    fila.getCell(4).value = numeroOpcional(f.precio);
    fila.getCell(5).value = numeroOpcional(f.total);
    fila.getCell(6).value = numeroOpcional(f.rendimientoPorRescate);
    fila.getCell(7).value = textoSiNo(f.estimado);
    fila.getCell(8).value = numeroOpcional(f.stockAlCierre);
    fila.getCell(9).value = numeroOpcional(f.valorUnitarioAlCierre);
    fila.getCell(10).value = numeroOpcional(f.valuacionAlCierre);
    aplicarBordeFila(fila, cantColumnas);
  });
}

// -----------------------------------------------------------------------------
// Hoja "Resumen" — una fila por corte, columnas agrupadas por fondo con header concatenado
// ("<fondo> — Cantidad"): el pedido no exige fusionar celdas ni reproducir layout exacto, solo que sea
// reconocible y que los números sean correctos — se prioriza código simple sobre fidelidad visual.
// Sin fila de título (esa es solo para las hojas de fondo — ver `armarHojaFondo`): el header sigue en
// la fila 1.
// -----------------------------------------------------------------------------

function armarHojaResumen(libro: ExcelJS.Workbook, resumen: readonly FilaHojaResumen[]): void {
  const hoja = libro.addWorksheet('Resumen', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });

  // Unión de fondos en orden de primera aparición — si la composición de fondos cambia de corte a
  // corte (alta o baja de un fondo a mitad de serie), igual arma una sola tabla, con celda vacía donde
  // ese corte no trae ese fondo.
  const fondos: string[] = [];
  for (const fila of resumen) {
    for (const porFondo of fila.porFondo) {
      if (!fondos.includes(porFondo.fondo)) fondos.push(porFondo.fondo);
    }
  }

  const columnas: {
    readonly header: string;
    readonly key: string;
    readonly width: number;
    readonly style?: { readonly numFmt: string };
  }[] = [{ header: 'Corte', key: 'corte', width: 12, style: { numFmt: FMT_FECHA } }];
  for (const fondo of fondos) {
    columnas.push(
      { header: `${fondo} — Cantidad`, key: `${fondo}__cantidad`, width: 18, style: { numFmt: FMT_CANTIDAD } },
      {
        header: `${fondo} — Valor histórico`,
        key: `${fondo}__valorHistorico`,
        width: 22,
        style: { numFmt: FMT_IMPORTE },
      },
      {
        header: `${fondo} — Valuación al cierre`,
        key: `${fondo}__valuacion`,
        width: 22,
        style: { numFmt: FMT_IMPORTE },
      },
    );
  }
  columnas.push(
    {
      header: 'Rendimiento por rescates del mes',
      key: 'rendimientoConsolidado',
      width: 26,
      style: { numFmt: FMT_IMPORTE },
    },
    { header: 'Incluye estimados', key: 'hayEstimados', width: 16 },
    // Cantidad de cuotapartes, no un monto en pesos — FMT_CANTIDAD (sin `$`), no FMT_IMPORTE, mismo
    // criterio que "Cantidad de cuotas"/"Stock al cierre" de la hoja por fondo.
    { header: 'Cantidad total', key: 'cantidadTotal', width: 18, style: { numFmt: FMT_CANTIDAD } },
    {
      header: 'Valor histórico total',
      key: 'valorHistoricoTotal',
      width: 22,
      style: { numFmt: FMT_IMPORTE },
    },
    {
      header: 'Valuación al cierre total',
      key: 'valuacionAlCierreTotal',
      width: 24,
      style: { numFmt: FMT_IMPORTE },
    },
  );
  hoja.columns = columnas;
  const cantColumnas = columnas.length;

  const filaHeader = hoja.getRow(1);
  filaHeader.font = { bold: true };
  filaHeader.alignment = { vertical: 'middle', wrapText: true };
  aplicarFillFila(filaHeader, cantColumnas, ARGB_ENCABEZADO);

  // Las 3 columnas de Total (posición 1-based, resuelta UNA vez) llevan el tratamiento visual distinto
  // que pide el punto 4 del pedido — negrita + relleno dorado, tanto en el header (pisando el celeste
  // de arriba) como en cada celda de dato.
  const clavesTotal = ['cantidadTotal', 'valorHistoricoTotal', 'valuacionAlCierreTotal'] as const;
  const indicesTotal = clavesTotal.map((clave) => columnas.findIndex((c) => c.key === clave) + 1);
  for (const indice of indicesTotal) {
    hoja.getCell(1, indice).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB_TOTAL } };
  }

  for (const fila of resumen) {
    const registro: Record<string, string | number | null> = {
      corte: fechaIsoASerialExcel(fila.corte) ?? fila.corte,
      rendimientoConsolidado: Number(fila.rendimientoPorRescatesConsolidado),
      hayEstimados: textoSiNo(fila.hayEstimadosEnElCorte),
      cantidadTotal: Number(fila.cantidadTotal),
      valorHistoricoTotal: Number(fila.valorHistoricoTotal),
      valuacionAlCierreTotal: Number(fila.valuacionAlCierreTotal),
    };
    for (const fondo of fondos) {
      const porFondo = fila.porFondo.find((p) => p.fondo === fondo);
      registro[`${fondo}__cantidad`] = porFondo ? Number(porFondo.cantidad) : null;
      registro[`${fondo}__valorHistorico`] = porFondo ? Number(porFondo.valorHistorico) : null;
      registro[`${fondo}__valuacion`] = porFondo ? Number(porFondo.valuacionAlCierre) : null;
    }
    const filaExcel = hoja.addRow(registro);
    aplicarBordeFila(filaExcel, cantColumnas);
    for (const indice of indicesTotal) {
      const celda = filaExcel.getCell(indice);
      celda.font = { bold: true };
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB_TOTAL } };
    }
  }
}

// -----------------------------------------------------------------------------
// Punto de entrada
// -----------------------------------------------------------------------------

export function armarLibroFci(datos: {
  readonly hojasPorFondo: readonly { readonly fondo: string; readonly filas: readonly FilaHojaFondo[] }[];
  readonly resumen: readonly FilaHojaResumen[];
  /** Período cubierto por el export, ya armado por quien llama (ej. `"Junio–Agosto 2025"`) — este
   *  módulo no calcula fechas, solo lo imprime en la fila de título de cada hoja de fondo. */
  readonly periodoLabel: string;
}): ExcelJS.Workbook {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'sistema-contable';
  libro.lastModifiedBy = 'sistema-contable';

  // Sembrado con 'resumen' (hallazgo de `security-engineer`, ronda 2): la hoja fija `Resumen` se
  // agrega DESPUÉS de las hojas por fondo, y `ExcelJS` no valida nombres de hoja duplicados — un fondo
  // real cuyo nombre saneado colisionara con "Resumen" produciría un `.xlsx` con dos hojas del mismo
  // nombre, estructuralmente inválido. Antes de exponer el nombre real del fondo (ronda 1: `fondo_N`
  // opaco) este caso era inalcanzable.
  const nombresUsados = new Set<string>(['resumen']);
  for (const { fondo, filas } of datos.hojasPorFondo) {
    armarHojaFondo(libro, nombreDeHojaFondo(fondo, nombresUsados), fondo, datos.periodoLabel, filas);
  }
  armarHojaResumen(libro, datos.resumen);

  return libro;
}

/** Serializa. Único punto asíncrono de este archivo. */
export async function serializarLibroFci(libro: ExcelJS.Workbook): Promise<Uint8Array> {
  const buffer = await libro.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
