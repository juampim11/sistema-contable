/**
 * ARMADO DEL LIBRO DE FCI — puro. Sin base, sin disco, sin `Tx`, sin auditoría, sin roles: recibe todo
 * ya calculado por argumento (mismo espíritu que `../planilla/armar-libro.ts`, que este archivo NO
 * reusa en lógica — esa hoja es de movimientos bancarios en pesos, esta es de cuotapartes de FCI —
 * pero sí en estilo: `ExcelJS.Workbook` construido a mano, headers en negrita, columnas con `numFmt`).
 *
 * ⚠️ `import ExcelJS from 'exceljs'` — nunca `import { Workbook }`: el paquete es CJS y ese nombrado
 * no existe como export ESM (mismo hallazgo que documenta `armar-libro.ts`).
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
  /** Suma de TODOS los rescates de TODOS los fondos en este corte. */
  readonly rendimientoPorRescatesConsolidado: string;
  /** `true` si CUALQUIER rescate de CUALQUIER fondo en este corte fue parcialmente estimado — YA
   *  CALCULADO por quien llama (mismo criterio que `valorHistorico`), este módulo solo lo escribe. */
  readonly hayEstimadosEnElCorte: boolean;
};

// -----------------------------------------------------------------------------
// Formato — cantidades de cuotaparte con más decimales que un importe en pesos.
// -----------------------------------------------------------------------------

const FMT_CANTIDAD = '#,##0.000000';
const FMT_IMPORTE = '#,##0.00';
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
// Nombre de hoja — mismo criterio que `armar-libro.ts`: ≤31 chars, sin caracteres inválidos, único.
// -----------------------------------------------------------------------------

function nombreDeHojaFondo(fondo: string, usados: Set<string>): string {
  const base = fondo.replace(/[[\]:*?/\\]/g, '-').slice(0, 28);
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
  filas: readonly FilaHojaFondo[],
): void {
  const hoja = libro.addWorksheet(nombreDeHoja, { views: [{ state: 'frozen', ySplit: 1 }] });

  hoja.columns = [
    { header: 'Fecha', key: 'fecha', width: 12, style: { numFmt: FMT_FECHA } },
    { header: 'Tipo de movimiento', key: 'tipo', width: 18 },
    { header: 'Cantidad de cuotas', key: 'cantidad', width: 18, style: { numFmt: FMT_CANTIDAD } },
    { header: 'Precio', key: 'precio', width: 14, style: { numFmt: FMT_IMPORTE } },
    { header: 'Total', key: 'total', width: 16, style: { numFmt: FMT_IMPORTE } },
    { header: 'Rendimiento por rescate', key: 'rendimiento', width: 20, style: { numFmt: FMT_IMPORTE } },
    { header: 'Estimado', key: 'estimado', width: 12 },
    { header: 'Stock al cierre', key: 'stock', width: 16, style: { numFmt: FMT_CANTIDAD } },
    { header: 'Valor unitario al cierre', key: 'valorUnitario', width: 20, style: { numFmt: FMT_IMPORTE } },
    { header: 'Valuación al cierre', key: 'valuacion', width: 18, style: { numFmt: FMT_IMPORTE } },
  ];
  hoja.getRow(1).font = { bold: true };
  hoja.getRow(1).alignment = { vertical: 'middle', wrapText: true };

  for (const f of filas) {
    hoja.addRow({
      fecha: f.fecha === '' ? null : fechaIsoASerialExcel(f.fecha),
      tipo: TEXTO_TIPO[f.tipo],
      cantidad: numeroOpcional(f.cantidadDeCuotas),
      precio: numeroOpcional(f.precio),
      total: numeroOpcional(f.total),
      rendimiento: numeroOpcional(f.rendimientoPorRescate),
      estimado: textoSiNo(f.estimado),
      stock: numeroOpcional(f.stockAlCierre),
      valorUnitario: numeroOpcional(f.valorUnitarioAlCierre),
      valuacion: numeroOpcional(f.valuacionAlCierre),
    });
  }
}

// -----------------------------------------------------------------------------
// Hoja "Resumen" — una fila por corte, columnas agrupadas por fondo con header concatenado
// ("fondo_1 — Cantidad"): el pedido no exige fusionar celdas ni reproducir layout exacto, solo que sea
// reconocible y que los números sean correctos — se prioriza código simple sobre fidelidad visual.
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
        width: 20,
        style: { numFmt: FMT_IMPORTE },
      },
      {
        header: `${fondo} — Valuación al cierre`,
        key: `${fondo}__valuacion`,
        width: 20,
        style: { numFmt: FMT_IMPORTE },
      },
    );
  }
  columnas.push(
    {
      header: 'Rendimiento por rescates (consolidado)',
      key: 'rendimientoConsolidado',
      width: 26,
      style: { numFmt: FMT_IMPORTE },
    },
    { header: 'Incluye estimados', key: 'hayEstimados', width: 16 },
  );
  hoja.columns = columnas;
  hoja.getRow(1).font = { bold: true };
  hoja.getRow(1).alignment = { vertical: 'middle', wrapText: true };

  for (const fila of resumen) {
    const registro: Record<string, string | number | null> = {
      corte: fechaIsoASerialExcel(fila.corte) ?? fila.corte,
      rendimientoConsolidado: Number(fila.rendimientoPorRescatesConsolidado),
      hayEstimados: textoSiNo(fila.hayEstimadosEnElCorte),
    };
    for (const fondo of fondos) {
      const porFondo = fila.porFondo.find((p) => p.fondo === fondo);
      registro[`${fondo}__cantidad`] = porFondo ? Number(porFondo.cantidad) : null;
      registro[`${fondo}__valorHistorico`] = porFondo ? Number(porFondo.valorHistorico) : null;
      registro[`${fondo}__valuacion`] = porFondo ? Number(porFondo.valuacionAlCierre) : null;
    }
    hoja.addRow(registro);
  }
}

// -----------------------------------------------------------------------------
// Punto de entrada
// -----------------------------------------------------------------------------

export function armarLibroFci(datos: {
  readonly hojasPorFondo: readonly { readonly fondo: string; readonly filas: readonly FilaHojaFondo[] }[];
  readonly resumen: readonly FilaHojaResumen[];
}): ExcelJS.Workbook {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'sistema-contable';
  libro.lastModifiedBy = 'sistema-contable';

  const nombresUsados = new Set<string>();
  for (const { fondo, filas } of datos.hojasPorFondo) {
    armarHojaFondo(libro, nombreDeHojaFondo(fondo, nombresUsados), filas);
  }
  armarHojaResumen(libro, datos.resumen);

  return libro;
}

/** Serializa. Único punto asíncrono de este archivo. */
export async function serializarLibroFci(libro: ExcelJS.Workbook): Promise<Uint8Array> {
  const buffer = await libro.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
