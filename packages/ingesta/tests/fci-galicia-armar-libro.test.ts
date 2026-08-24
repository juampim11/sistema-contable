/**
 * `armarLibroFci` — round-trip en memoria (sin serializar): arma el `ExcelJS.Workbook` y se releen sus
 * celdas con el mismo `exceljs`, comparando SOLO contra los datos sintéticos que este archivo arma —
 * nunca contra un archivo externo.
 *
 * Ronda 2 del export (ajustes de Laura): nombre de hoja con nombre real de fondo (ya no `fondo_N`),
 * fila de título con período por hoja de fondo, formato por tipo de columna ($ + 2 decimales para
 * montos; 2 decimales sin $ para cantidad de cuotas; 6 decimales sin $ para precio/cotización), y las
 * 2 columnas Total del Resumen (Valor histórico / Valuación al cierre — sin "Cantidad total": sumar
 * cuotapartes de fondos distintos no es una magnitud homogénea).
 *
 * Todas las cifras y nombres de este archivo son SINTÉTICOS (mismo criterio que
 * `packages/ingesta/src/parseo-ar.ts`, hallazgo H-A): ningún valor sale de un extracto real de ningún
 * cliente. Los nombres de fondo ("Fima Ahorro Pesos", "Fima Premium Renta Fija") son inventados —
 * mismo estilo que los productos reales de la familia FIMA de Galicia, pero no copiados de ningún PDF.
 */

import { describe, expect, it } from 'vitest';
import { fechaIsoASerialExcel } from '../src/planilla/armar-libro.ts';
import {
  armarLibroFci,
  NombreDeFondoVacioError,
  type FilaHojaFondo,
  type FilaHojaResumen,
} from '../src/fci-galicia/armar-libro-fci.ts';

const FMT_IMPORTE = '"$" #,##0.00';
const FMT_CANTIDAD = '#,##0.00';
const FMT_PRECIO = '#,##0.000000';

const FONDO_1 = 'Fima Ahorro Pesos';
const FONDO_2 = 'Fima Premium Renta Fija';
const PERIODO_LABEL = 'Enero–Febrero 2025';

describe('armarLibroFci', () => {
  it('arma una hoja por fondo (con nombre real) y una hoja Resumen, con filas y celdas correctas', () => {
    const filasFondo1: readonly FilaHojaFondo[] = [
      {
        fecha: '2025-01-05',
        tipo: 'suscripcion',
        cantidadDeCuotas: '100.000000',
        precio: '10.000000',
        total: '1000.00',
        rendimientoPorRescate: null,
        estimado: null,
        stockAlCierre: null,
        valorUnitarioAlCierre: null,
        valuacionAlCierre: null,
      },
      {
        fecha: '2025-01-20',
        tipo: 'rescate',
        cantidadDeCuotas: '40.000000',
        precio: '12.000000',
        total: '480.00',
        rendimientoPorRescate: '80.00',
        estimado: true,
        stockAlCierre: null,
        valorUnitarioAlCierre: null,
        valuacionAlCierre: null,
      },
      {
        fecha: '',
        tipo: 'cierre',
        cantidadDeCuotas: null,
        precio: null,
        total: null,
        rendimientoPorRescate: null,
        estimado: null,
        stockAlCierre: '60.000000',
        valorUnitarioAlCierre: '13.123456',
        valuacionAlCierre: '780.00',
      },
    ];
    // fondo_2 trae UN rescate NO estimado (costo real) — cubre el caso `estimado: false`, que
    // `filasFondo1` no ejercita (su único rescate es `estimado: true`).
    const filasFondo2: readonly FilaHojaFondo[] = [
      {
        fecha: '2025-01-18',
        tipo: 'rescate',
        cantidadDeCuotas: '5.000000',
        precio: '21.000000',
        total: '105.00',
        rendimientoPorRescate: '5.00',
        estimado: false,
        stockAlCierre: null,
        valorUnitarioAlCierre: null,
        valuacionAlCierre: null,
      },
      {
        fecha: '',
        tipo: 'cierre',
        cantidadDeCuotas: null,
        precio: null,
        total: null,
        rendimientoPorRescate: null,
        estimado: null,
        stockAlCierre: '25.000000',
        valorUnitarioAlCierre: '20.000000',
        valuacionAlCierre: '500.00',
      },
    ];

    const resumen: readonly FilaHojaResumen[] = [
      {
        corte: '2025-01-31',
        porFondo: [
          { fondo: FONDO_1, cantidad: '60.000000', valorHistorico: '650.00', valuacionAlCierre: '780.00' },
          { fondo: FONDO_2, cantidad: '25.000000', valorHistorico: '400.00', valuacionAlCierre: '500.00' },
        ],
        rendimientoPorRescatesConsolidado: '85.00',
        // El rescate de fondo_1 en este corte fue `estimado: true` (capa de apertura) → el corte
        // completo queda marcado.
        hayEstimadosEnElCorte: true,
        valorHistoricoTotal: '1050.00',
        valuacionAlCierreTotal: '1280.00',
      },
      {
        corte: '2025-02-28',
        porFondo: [
          { fondo: FONDO_1, cantidad: '60.000000', valorHistorico: '650.00', valuacionAlCierre: '800.00' },
          { fondo: FONDO_2, cantidad: '25.000000', valorHistorico: '400.00', valuacionAlCierre: '510.00' },
        ],
        rendimientoPorRescatesConsolidado: '0.00',
        // Sin rescates en este corte → nada que estimar.
        hayEstimadosEnElCorte: false,
        valorHistoricoTotal: '1050.00',
        valuacionAlCierreTotal: '1310.00',
      },
    ];

    const libro = armarLibroFci({
      hojasPorFondo: [
        { fondo: FONDO_1, filas: filasFondo1 },
        { fondo: FONDO_2, filas: filasFondo2 },
      ],
      resumen,
      periodoLabel: PERIODO_LABEL,
    });

    expect(libro.worksheets.map((h) => h.name)).toEqual([FONDO_1, FONDO_2, 'Resumen']);

    // Columnas de la hoja por fondo: 1 Fecha, 2 Tipo, 3 Cantidad, 4 Precio, 5 Total, 6 Rendimiento,
    // 7 Estimado, 8 Stock al cierre, 9 Valor unitario al cierre, 10 Valuación al cierre.
    // Fila 1 = título (fondo + período), fila 2 = header, fila 3+ = datos.
    const hojaFondo1 = libro.getWorksheet(FONDO_1);
    if (!hojaFondo1) throw new Error(`esperaba la hoja "${FONDO_1}"`);
    expect(hojaFondo1.getCell('A1').value).toBe(`${FONDO_1} — ${PERIODO_LABEL}`);
    // Fila de título fusionada a lo ancho de las 10 columnas — la celda maestra es A1; el resto del
    // rango (ej. J1) apunta a A1 como `master` y espeja su valor (así lee `exceljs` una celda
    // mergeada: `.value` nunca es un hueco, devuelve el valor de la maestra).
    expect(hojaFondo1.getCell('A1').master).toBe(hojaFondo1.getCell('A1'));
    expect(hojaFondo1.getCell('J1').master).toBe(hojaFondo1.getCell('A1'));
    expect(hojaFondo1.getCell('J1').value).toBe(`${FONDO_1} — ${PERIODO_LABEL}`);

    // Header (fila 2) + título (fila 1) + 3 filas de datos.
    expect(hojaFondo1.rowCount).toBe(5);
    expect(hojaFondo1.getRow(2).getCell(1).value).toBe('Fecha');
    expect(hojaFondo1.getRow(3).getCell(1).value).toBe(fechaIsoASerialExcel('2025-01-05'));
    expect(hojaFondo1.getRow(3).getCell(3).value).toBe(100); // Cantidad de cuotas
    expect(hojaFondo1.getRow(3).getCell(7).value).toBeFalsy(); // suscripción: "Estimado" no aplica
    expect(hojaFondo1.getRow(4).getCell(6).value).toBe(80); // Rendimiento por rescate
    expect(hojaFondo1.getRow(4).getCell(7).value).toBe('Sí'); // rescate parcialmente estimado
    expect(hojaFondo1.getRow(5).getCell(1).value).toBeNull(); // fila de cierre: sin fecha propia
    expect(hojaFondo1.getRow(5).getCell(7).value).toBeFalsy(); // cierre: "Estimado" no aplica
    expect(hojaFondo1.getRow(5).getCell(8).value).toBe(60); // Stock al cierre
    expect(hojaFondo1.getRow(5).getCell(9).value).toBe(13.123456); // Valor unitario, precisión completa
    expect(hojaFondo1.getRow(5).getCell(10).value).toBe(780); // Valuación al cierre

    // Formato por tipo de columna — NUNCA a ciegas. "Precio" y "Valor unitario al cierre" (columnas 4
    // y 9) llevan 6 decimales SIN `$`; nunca el formato de importe (redondearía la cotización real).
    expect(hojaFondo1.getColumn(4).numFmt).toBe(FMT_PRECIO);
    expect(hojaFondo1.getColumn(9).numFmt).toBe(FMT_PRECIO);
    expect(hojaFondo1.getColumn(4).numFmt).not.toBe(FMT_IMPORTE);
    expect(hojaFondo1.getColumn(9).numFmt).not.toBe(FMT_IMPORTE);
    // "Cantidad de cuotas" y "Stock al cierre" (columnas 3 y 8) son CANTIDAD, no monto: sin `$`.
    expect(hojaFondo1.getColumn(3).numFmt).toBe(FMT_CANTIDAD);
    expect(hojaFondo1.getColumn(8).numFmt).toBe(FMT_CANTIDAD);
    // "Total", "Rendimiento por rescate" y "Valuación al cierre" (columnas 5, 6, 10) SÍ son montos.
    expect(hojaFondo1.getColumn(5).numFmt).toBe(FMT_IMPORTE);
    expect(hojaFondo1.getColumn(6).numFmt).toBe(FMT_IMPORTE);
    expect(hojaFondo1.getColumn(10).numFmt).toBe(FMT_IMPORTE);

    // Encabezado en negrita, con relleno de color (mismo tratamiento en las 3 hojas).
    expect(hojaFondo1.getRow(2).font?.bold).toBe(true);
    expect(hojaFondo1.getRow(2).getCell(1).fill).toMatchObject({
      type: 'pattern',
      pattern: 'solid',
    });
    // Bordes finos en una celda de datos, pero NO en la fila de título.
    expect(hojaFondo1.getRow(3).getCell(1).border?.top?.style).toBe('thin');
    expect(hojaFondo1.getCell('A1').border).toBeUndefined();

    // Freeze panes: con la fila de título arriba del encabezado, el freeze tiene que dejar visible
    // título + encabezado (ySplit: 2), no solo el encabezado.
    expect(hojaFondo1.views[0]).toMatchObject({ state: 'frozen', ySplit: 2 });

    const hojaFondo2 = libro.getWorksheet(FONDO_2);
    if (!hojaFondo2) throw new Error(`esperaba la hoja "${FONDO_2}"`);
    expect(hojaFondo2.getCell('A1').value).toBe(`${FONDO_2} — ${PERIODO_LABEL}`);
    expect(hojaFondo2.rowCount).toBe(4); // título + header + rescate + cierre
    expect(hojaFondo2.getRow(3).getCell(7).value).toBe('No'); // rescate con costo real, no estimado

    const hojaResumen = libro.getWorksheet('Resumen');
    if (!hojaResumen) throw new Error('esperaba la hoja "Resumen"');
    expect(hojaResumen.rowCount).toBe(3); // header + 2 cortes (sin fila de título: eso es solo fondos)
    // Columnas: 1 Corte, 2-4 fondo1 (cantidad/valorHistorico/valuación), 5-7 fondo2,
    // 8 rendimiento del mes, 9 "Incluye estimados", 10-11 las 2 columnas Total (sin "Cantidad total":
    // sumar cuotapartes de fondos distintos no es una magnitud homogénea — decisión del titular).
    expect(hojaResumen.getRow(1).getCell(8).value).toBe('Rendimiento por rescates del mes');
    expect(hojaResumen.getRow(1).getCell(10).value).toBe('Valor histórico total');
    expect(hojaResumen.getRow(1).getCell(11).value).toBe('Valuación al cierre total');

    expect(hojaResumen.getRow(2).getCell(2).value).toBe(60);
    expect(hojaResumen.getRow(2).getCell(3).value).toBe(650);
    expect(hojaResumen.getRow(2).getCell(4).value).toBe(780);
    expect(hojaResumen.getRow(2).getCell(5).value).toBe(25);
    expect(hojaResumen.getRow(2).getCell(8).value).toBe(85);
    expect(hojaResumen.getRow(2).getCell(9).value).toBe('Sí'); // corte con un rescate estimado
    expect(hojaResumen.getRow(3).getCell(4).value).toBe(800);
    expect(hojaResumen.getRow(3).getCell(8).value).toBe(0);
    expect(hojaResumen.getRow(3).getCell(9).value).toBe('No'); // corte sin rescates estimados

    // Las 2 columnas Total — valor y tratamiento visual (negrita + relleno) distinto.
    expect(hojaResumen.getRow(2).getCell(10).value).toBe(1050);
    expect(hojaResumen.getRow(2).getCell(11).value).toBe(1280);
    expect(hojaResumen.getRow(3).getCell(11).value).toBe(1310);
    expect(hojaResumen.getRow(2).getCell(10).font?.bold).toBe(true);
    expect(hojaResumen.getRow(2).getCell(10).fill).toMatchObject({ type: 'pattern', pattern: 'solid' });
    // Formato de las columnas Total: las dos son montos en pesos (mismo criterio que "Valor
    // histórico"/"Valuación al cierre" del Resumen) — con `$`.
    expect(hojaResumen.getColumn(10).numFmt).toBe(FMT_IMPORTE);
    expect(hojaResumen.getColumn(11).numFmt).toBe(FMT_IMPORTE);
    // Header de la hoja Resumen también en negrita con relleno (fila 1, sin fila de título).
    expect(hojaResumen.getRow(1).font?.bold).toBe(true);
    expect(hojaResumen.getRow(1).getCell(1).fill).toMatchObject({ type: 'pattern', pattern: 'solid' });
    // Bordes finos en una celda de datos del Resumen.
    expect(hojaResumen.getRow(2).getCell(1).border?.top?.style).toBe('thin');
  });

  it('un corte sin datos para un fondo deja esas celdas vacías, no en cero engañoso', () => {
    const resumen: readonly FilaHojaResumen[] = [
      {
        corte: '2025-01-31',
        porFondo: [
          { fondo: FONDO_1, cantidad: '10.000000', valorHistorico: '100.00', valuacionAlCierre: '110.00' },
        ],
        rendimientoPorRescatesConsolidado: '0.00',
        hayEstimadosEnElCorte: false,
        valorHistoricoTotal: '100.00',
        valuacionAlCierreTotal: '110.00',
      },
      {
        corte: '2025-02-28',
        porFondo: [
          { fondo: FONDO_1, cantidad: '10.000000', valorHistorico: '100.00', valuacionAlCierre: '115.00' },
          { fondo: FONDO_2, cantidad: '5.000000', valorHistorico: '50.00', valuacionAlCierre: '55.00' },
        ],
        rendimientoPorRescatesConsolidado: '0.00',
        hayEstimadosEnElCorte: false,
        valorHistoricoTotal: '150.00',
        valuacionAlCierreTotal: '170.00',
      },
    ];

    const libro = armarLibroFci({ hojasPorFondo: [], resumen, periodoLabel: PERIODO_LABEL });
    const hojaResumen = libro.getWorksheet('Resumen');
    if (!hojaResumen) throw new Error('esperaba la hoja "Resumen"');

    // fondo_2 recién aparece en el segundo corte — en el primero, sus columnas quedan vacías.
    expect(hojaResumen.getRow(2).getCell(5).value).toBeNull();
    expect(hojaResumen.getRow(3).getCell(5).value).toBe(5);
    // Los totales, en cambio, SÍ están presentes en las dos filas (ya vienen calculados por el
    // llamador con los fondos que efectivamente aparecen en cada corte). Columna 10 = Valor histórico
    // total (sin "Cantidad total": ver el comentario de `FilaHojaResumen`).
    expect(hojaResumen.getRow(2).getCell(10).value).toBe(100);
    expect(hojaResumen.getRow(3).getCell(10).value).toBe(150);
  });

  it('"Estimado" e "Incluye estimados" muestran texto legible (Sí/No/vacío), nunca el booleano crudo', () => {
    const filas: readonly FilaHojaFondo[] = [
      {
        fecha: '2025-03-05',
        tipo: 'suscripcion',
        cantidadDeCuotas: '10.000000',
        precio: '1.000000',
        total: '10.00',
        rendimientoPorRescate: null,
        estimado: null, // no aplica: no es un rescate
        stockAlCierre: null,
        valorUnitarioAlCierre: null,
        valuacionAlCierre: null,
      },
      {
        fecha: '2025-03-10',
        tipo: 'rescate',
        cantidadDeCuotas: '5.000000',
        precio: '1.500000',
        total: '7.50',
        rendimientoPorRescate: '2.50',
        estimado: true, // tocó una capa con costoConocido: false
        stockAlCierre: null,
        valorUnitarioAlCierre: null,
        valuacionAlCierre: null,
      },
      {
        fecha: '2025-03-15',
        tipo: 'rescate',
        cantidadDeCuotas: '3.000000',
        precio: '1.200000',
        total: '3.60',
        rendimientoPorRescate: '0.60',
        estimado: false, // costo real, todas las capas tocadas con costoConocido: true
        stockAlCierre: null,
        valorUnitarioAlCierre: null,
        valuacionAlCierre: null,
      },
      {
        fecha: '',
        tipo: 'cierre',
        cantidadDeCuotas: null,
        precio: null,
        total: null,
        rendimientoPorRescate: null,
        estimado: null, // no aplica: no es un rescate
        stockAlCierre: '2.000000',
        valorUnitarioAlCierre: '1.200000',
        valuacionAlCierre: '2.40',
      },
    ];

    const resumen: readonly FilaHojaResumen[] = [
      {
        corte: '2025-03-31',
        porFondo: [{ fondo: FONDO_1, cantidad: '2.000000', valorHistorico: '2.00', valuacionAlCierre: '2.40' }],
        rendimientoPorRescatesConsolidado: '3.10',
        hayEstimadosEnElCorte: true,
        valorHistoricoTotal: '2.00',
        valuacionAlCierreTotal: '2.40',
      },
      {
        corte: '2025-04-30',
        porFondo: [{ fondo: FONDO_1, cantidad: '2.000000', valorHistorico: '2.00', valuacionAlCierre: '2.50' }],
        rendimientoPorRescatesConsolidado: '0.00',
        hayEstimadosEnElCorte: false,
        valorHistoricoTotal: '2.00',
        valuacionAlCierreTotal: '2.50',
      },
    ];

    const libro = armarLibroFci({
      hojasPorFondo: [{ fondo: FONDO_1, filas }],
      resumen,
      periodoLabel: 'Marzo–Abril 2025',
    });

    const hoja = libro.getWorksheet(FONDO_1);
    if (!hoja) throw new Error(`esperaba la hoja "${FONDO_1}"`);
    // Fila 1 = título, fila 2 = header, fila 3+ = datos (antes era fila 1 = header, fila 2+ = datos).
    expect(hoja.getRow(3).getCell(7).value).toBeFalsy(); // suscripción → vacío
    expect(hoja.getRow(4).getCell(7).value).toBe('Sí'); // rescate estimado
    expect(hoja.getRow(5).getCell(7).value).toBe('No'); // rescate NO estimado
    expect(hoja.getRow(6).getCell(7).value).toBeFalsy(); // cierre → vacío

    // Con un solo fondo: 1 Corte, 2-4 fondo1, 5 rendimiento del mes, 6 "Incluye estimados",
    // 7-8 las 2 columnas Total (Valor histórico / Valuación al cierre).
    const hojaResumen = libro.getWorksheet('Resumen');
    if (!hojaResumen) throw new Error('esperaba la hoja "Resumen"');
    expect(hojaResumen.getRow(2).getCell(6).value).toBe('Sí');
    expect(hojaResumen.getRow(3).getCell(6).value).toBe('No');
  });

  it('un nombre de fondo que sanea a vacío aborta con NombreDeFondoVacioError, nunca una hoja sin nombre', () => {
    // Solo espacios (o solo apóstrofes) — un fragmento de PDF mal extraído que no aporta ningún
    // caracter válido de nombre (hallazgo de `security-engineer`/`code-reviewer`, ronda 2). Los
    // caracteres inválidos de Excel (`[]/\?:*`) se REEMPLAZAN por `-`, no se eliminan — un nombre
    // compuesto solo por esos no sanea a vacío, así que ese no es el caso de prueba correcto.
    expect(() =>
      armarLibroFci({
        hojasPorFondo: [{ fondo: '   ', filas: [] }],
        resumen: [],
        periodoLabel: PERIODO_LABEL,
      }),
    ).toThrow(NombreDeFondoVacioError);
    expect(() =>
      armarLibroFci({
        hojasPorFondo: [{ fondo: "''", filas: [] }],
        resumen: [],
        periodoLabel: PERIODO_LABEL,
      }),
    ).toThrow(NombreDeFondoVacioError);
  });

  it('un nombre de fondo que empieza o termina con apóstrofe se recorta, no rompe el nombre de hoja', () => {
    const libro = armarLibroFci({
      hojasPorFondo: [{ fondo: "'Fima Ahorro'", filas: [] }],
      resumen: [],
      periodoLabel: PERIODO_LABEL,
    });
    expect(libro.worksheets.map((h) => h.name)).toEqual(['Fima Ahorro', 'Resumen']);
  });

  it('un nombre de fondo saneado que colisiona con "Resumen" no pisa la hoja fija', () => {
    const libro = armarLibroFci({
      hojasPorFondo: [{ fondo: 'Resumen', filas: [] }],
      resumen: [],
      periodoLabel: PERIODO_LABEL,
    });
    // La hoja del fondo se sufija ("Resumen (2)"); la hoja fija "Resumen" sigue siendo la del
    // consolidado — nunca dos hojas con el mismo nombre (OOXML inválido, `exceljs` no lo valida solo).
    expect(libro.worksheets.map((h) => h.name)).toEqual(['Resumen (2)', 'Resumen']);
  });

  it('un nombre de fondo que empieza con "=", "+", "-" o "@" nunca se interpreta como fórmula', () => {
    // `exceljs` tipa cualquier `string` de JS como Cell.Types.String (nunca como fórmula, que exige un
    // objeto `{formula: ...}`) — pero se fija con un test propio, no solo confiando en la librería
    // (hallazgo de `security-engineer`, ronda 2).
    const libro = armarLibroFci({
      hojasPorFondo: [{ fondo: '=SUM(A1:A9)', filas: [] }],
      resumen: [],
      periodoLabel: PERIODO_LABEL,
    });
    const hoja = libro.worksheets[0]!;
    expect(hoja.getCell('A1').value).toBe(`=SUM(A1:A9) — ${PERIODO_LABEL}`);
    expect(hoja.getCell('A1').type).not.toBe(6); // ExcelJS.ValueType.Formula === 6
  });
});
