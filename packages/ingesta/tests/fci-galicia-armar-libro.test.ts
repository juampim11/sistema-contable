/**
 * `armarLibroFci` — round-trip en memoria (sin serializar): arma el `ExcelJS.Workbook` y se releen sus
 * celdas con el mismo `exceljs`, comparando SOLO contra los datos sintéticos que este archivo arma —
 * nunca contra un archivo externo.
 *
 * Todas las cifras son SINTÉTICAS (mismo criterio que `packages/ingesta/src/parseo-ar.ts`, hallazgo
 * H-A): ningún valor sale de un extracto real de ningún cliente.
 */

import { describe, expect, it } from 'vitest';
import { fechaIsoASerialExcel } from '../src/planilla/armar-libro.ts';
import {
  armarLibroFci,
  type FilaHojaFondo,
  type FilaHojaResumen,
} from '../src/fci-galicia/armar-libro-fci.ts';

describe('armarLibroFci', () => {
  it('arma una hoja por fondo y una hoja Resumen, con filas y celdas correctas', () => {
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
        valorUnitarioAlCierre: '13.000000',
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
          { fondo: 'fondo_1', cantidad: '60.000000', valorHistorico: '650.00', valuacionAlCierre: '780.00' },
          { fondo: 'fondo_2', cantidad: '25.000000', valorHistorico: '400.00', valuacionAlCierre: '500.00' },
        ],
        rendimientoPorRescatesConsolidado: '85.00',
        // El rescate de fondo_1 en este corte fue `estimado: true` (capa de apertura) → el corte
        // completo queda marcado.
        hayEstimadosEnElCorte: true,
      },
      {
        corte: '2025-02-28',
        porFondo: [
          { fondo: 'fondo_1', cantidad: '60.000000', valorHistorico: '650.00', valuacionAlCierre: '800.00' },
          { fondo: 'fondo_2', cantidad: '25.000000', valorHistorico: '400.00', valuacionAlCierre: '510.00' },
        ],
        rendimientoPorRescatesConsolidado: '0.00',
        // Sin rescates en este corte → nada que estimar.
        hayEstimadosEnElCorte: false,
      },
    ];

    const libro = armarLibroFci({
      hojasPorFondo: [
        { fondo: 'fondo_1', filas: filasFondo1 },
        { fondo: 'fondo_2', filas: filasFondo2 },
      ],
      resumen,
    });

    expect(libro.worksheets.map((h) => h.name)).toEqual(['fondo_1', 'fondo_2', 'Resumen']);

    // Columnas de la hoja por fondo: 1 Fecha, 2 Tipo, 3 Cantidad, 4 Precio, 5 Total, 6 Rendimiento,
    // 7 Estimado, 8 Stock al cierre, 9 Valor unitario al cierre, 10 Valuación al cierre.
    const hojaFondo1 = libro.getWorksheet('fondo_1');
    if (!hojaFondo1) throw new Error('esperaba la hoja "fondo_1"');
    // Header (fila 1) + 3 filas de datos.
    expect(hojaFondo1.rowCount).toBe(4);
    expect(hojaFondo1.getRow(2).getCell(1).value).toBe(fechaIsoASerialExcel('2025-01-05'));
    expect(hojaFondo1.getRow(2).getCell(3).value).toBe(100); // Cantidad de cuotas
    expect(hojaFondo1.getRow(2).getCell(7).value).toBeFalsy(); // suscripción: "Estimado" no aplica
    expect(hojaFondo1.getRow(3).getCell(6).value).toBe(80); // Rendimiento por rescate
    expect(hojaFondo1.getRow(3).getCell(7).value).toBe('Sí'); // rescate parcialmente estimado
    expect(hojaFondo1.getRow(4).getCell(1).value).toBeNull(); // fila de cierre: sin fecha propia
    expect(hojaFondo1.getRow(4).getCell(7).value).toBeFalsy(); // cierre: "Estimado" no aplica
    expect(hojaFondo1.getRow(4).getCell(8).value).toBe(60); // Stock al cierre
    expect(hojaFondo1.getRow(4).getCell(10).value).toBe(780); // Valuación al cierre

    const hojaFondo2 = libro.getWorksheet('fondo_2');
    if (!hojaFondo2) throw new Error('esperaba la hoja "fondo_2"');
    expect(hojaFondo2.rowCount).toBe(3); // header + rescate + cierre
    expect(hojaFondo2.getRow(2).getCell(7).value).toBe('No'); // rescate con costo real, no estimado

    const hojaResumen = libro.getWorksheet('Resumen');
    if (!hojaResumen) throw new Error('esperaba la hoja "Resumen"');
    expect(hojaResumen.rowCount).toBe(3); // header + 2 cortes
    // Columnas: 1 Corte, 2-4 fondo_1 (cantidad/valorHistorico/valuación), 5-7 fondo_2,
    // 8 rendimiento consolidado, 9 "Incluye estimados".
    expect(hojaResumen.getRow(2).getCell(2).value).toBe(60);
    expect(hojaResumen.getRow(2).getCell(3).value).toBe(650);
    expect(hojaResumen.getRow(2).getCell(4).value).toBe(780);
    expect(hojaResumen.getRow(2).getCell(5).value).toBe(25);
    expect(hojaResumen.getRow(2).getCell(8).value).toBe(85);
    expect(hojaResumen.getRow(2).getCell(9).value).toBe('Sí'); // corte con un rescate estimado
    expect(hojaResumen.getRow(3).getCell(4).value).toBe(800);
    expect(hojaResumen.getRow(3).getCell(8).value).toBe(0);
    expect(hojaResumen.getRow(3).getCell(9).value).toBe('No'); // corte sin rescates estimados
  });

  it('un corte sin datos para un fondo deja esas celdas vacías, no en cero engañoso', () => {
    const resumen: readonly FilaHojaResumen[] = [
      {
        corte: '2025-01-31',
        porFondo: [{ fondo: 'fondo_1', cantidad: '10.000000', valorHistorico: '100.00', valuacionAlCierre: '110.00' }],
        rendimientoPorRescatesConsolidado: '0.00',
        hayEstimadosEnElCorte: false,
      },
      {
        corte: '2025-02-28',
        porFondo: [
          { fondo: 'fondo_1', cantidad: '10.000000', valorHistorico: '100.00', valuacionAlCierre: '115.00' },
          { fondo: 'fondo_2', cantidad: '5.000000', valorHistorico: '50.00', valuacionAlCierre: '55.00' },
        ],
        rendimientoPorRescatesConsolidado: '0.00',
        hayEstimadosEnElCorte: false,
      },
    ];

    const libro = armarLibroFci({ hojasPorFondo: [], resumen });
    const hojaResumen = libro.getWorksheet('Resumen');
    if (!hojaResumen) throw new Error('esperaba la hoja "Resumen"');

    // fondo_2 recién aparece en el segundo corte — en el primero, sus columnas quedan vacías.
    expect(hojaResumen.getRow(2).getCell(5).value).toBeNull();
    expect(hojaResumen.getRow(3).getCell(5).value).toBe(5);
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
        porFondo: [{ fondo: 'fondo_1', cantidad: '2.000000', valorHistorico: '2.00', valuacionAlCierre: '2.40' }],
        rendimientoPorRescatesConsolidado: '3.10',
        hayEstimadosEnElCorte: true,
      },
      {
        corte: '2025-04-30',
        porFondo: [{ fondo: 'fondo_1', cantidad: '2.000000', valorHistorico: '2.00', valuacionAlCierre: '2.50' }],
        rendimientoPorRescatesConsolidado: '0.00',
        hayEstimadosEnElCorte: false,
      },
    ];

    const libro = armarLibroFci({ hojasPorFondo: [{ fondo: 'fondo_1', filas }], resumen });

    const hoja = libro.getWorksheet('fondo_1');
    if (!hoja) throw new Error('esperaba la hoja "fondo_1"');
    expect(hoja.getRow(2).getCell(7).value).toBeFalsy(); // suscripción → vacío
    expect(hoja.getRow(3).getCell(7).value).toBe('Sí'); // rescate estimado
    expect(hoja.getRow(4).getCell(7).value).toBe('No'); // rescate NO estimado
    expect(hoja.getRow(5).getCell(7).value).toBeFalsy(); // cierre → vacío

    // Con un solo fondo: 1 Corte, 2-4 fondo_1, 5 rendimiento consolidado, 6 "Incluye estimados".
    const hojaResumen = libro.getWorksheet('Resumen');
    if (!hojaResumen) throw new Error('esperaba la hoja "Resumen"');
    expect(hojaResumen.getRow(2).getCell(6).value).toBe('Sí');
    expect(hojaResumen.getRow(3).getCell(6).value).toBe('No');
  });
});
