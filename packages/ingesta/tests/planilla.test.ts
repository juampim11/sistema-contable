/**
 * Export a Excel — `packages/ingesta/src/planilla/`. Plan `adaptive-herding-pillow`.
 *
 * Bloque A: los dos conversores puros, con sus bordes literales.
 * Bloque B: `armarLibro` puro + round-trip (serializar y releer con `exceljs`).
 * Bloque C/D (contra base real, `sembrar()`): ver `exportar-planilla.test.ts`.
 */

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  armarLibro,
  fechaIsoASerialExcel,
  importeCanonicoANumeroExcel,
  serializarLibro,
  type CabeceraCuenta,
  type DatosPlanilla,
  type FilaPlanilla,
} from '../src/planilla/armar-libro.ts';

// -----------------------------------------------------------------------------
// Bloque A — conversores
// -----------------------------------------------------------------------------

describe('importeCanonicoANumeroExcel', () => {
  it('convierte un importe signado simple', () => {
    expect(importeCanonicoANumeroExcel('-4321.00')).toBe(-4321);
    expect(importeCanonicoANumeroExcel('4321.00')).toBe(4321);
  });

  it('bordes de un centavo', () => {
    expect(importeCanonicoANumeroExcel('0.01')).toBe(0.01);
    expect(importeCanonicoANumeroExcel('-0.01')).toBe(-0.01);
  });

  it('el borde exacto de MAX_SAFE_INTEGER en centavos entra', () => {
    // 9007199254740991 centavos = 90071992547409.91
    expect(importeCanonicoANumeroExcel('90071992547409.91')).toBe(90071992547409.91);
  });

  it('un centavo más allá del borde no entra: null, nunca un número truncado', () => {
    expect(importeCanonicoANumeroExcel('90071992547409.92')).toBeNull();
    expect(importeCanonicoANumeroExcel('-90071992547409.92')).toBeNull();
  });

  it('formato argentino (coma) no es el canónico: null', () => {
    expect(importeCanonicoANumeroExcel('4321,00')).toBeNull();
  });

  it('texto sin forma de importe: null', () => {
    expect(importeCanonicoANumeroExcel('no es un importe')).toBeNull();
  });
});

describe('fechaIsoASerialExcel', () => {
  it('el ancla conocida de Excel: 1900-01-01 → serial 2', () => {
    expect(fechaIsoASerialExcel('1900-01-01')).toBe(2);
  });

  it('una fecha real da un entero', () => {
    expect(fechaIsoASerialExcel('2026-06-30')).toBe(46203);
  });

  it('fecha imposible (2026-02-30): Date.UTC normaliza, el ida y vuelta la caza → null', () => {
    expect(fechaIsoASerialExcel('2026-02-30')).toBeNull();
  });

  it('formato inválido: null', () => {
    expect(fechaIsoASerialExcel('30/06/2026')).toBeNull();
    expect(fechaIsoASerialExcel('no es una fecha')).toBeNull();
  });

  it('determinismo de zona horaria: el mismo resultado sin importar TZ del proceso', () => {
    const anterior = process.env['TZ'];
    try {
      process.env['TZ'] = 'Pacific/Kiritimati'; // UTC+14
      const a = fechaIsoASerialExcel('2026-07-01');
      process.env['TZ'] = 'Pacific/Niue'; // UTC-11
      const b = fechaIsoASerialExcel('2026-07-01');
      expect(a).toBe(b);
    } finally {
      if (anterior === undefined) delete process.env['TZ'];
      else process.env['TZ'] = anterior;
    }
  });
});

// -----------------------------------------------------------------------------
// Bloque B — armarLibro puro + round-trip
// -----------------------------------------------------------------------------

function cabeceraDePrueba(over: Partial<CabeceraCuenta> = {}): CabeceraCuenta {
  return {
    cuentaBancariaId: 'cta-1',
    bancoCodigo: 'sintetico',
    cuentaAlias: 'Cuenta operativa',
    moneda: 'ARS',
    periodoDesde: '2026-06-01',
    periodoHasta: '2026-06-30',
    saldoInicialDeclarado: '10000.00',
    saldoFinalDeclarado: '10500.00',
    totalCreditosDeclarado: '1000.00',
    totalDebitosDeclarado: '500.00',
    saldoFinalCalculado: '10500.00',
    totalCreditosCalculado: '1000.00',
    totalDebitosCalculado: '500.00',
    filasLeidas: 2,
    filasAceptadas: 2,
    verificacionEstado: 'cuadra',
    ...over,
  };
}

function filaDePrueba(over: Partial<FilaPlanilla> = {}): FilaPlanilla {
  return {
    filaNumero: 1,
    cuentaBancariaId: 'cta-1',
    fecha: '2026-06-05',
    fechaValor: null,
    descripcion: 'MOVIMIENTO DE PRUEBA',
    conceptoBanco: 'TRANSFERENCIA',
    conceptoCodigo: '900123',
    conceptoCompleto: true,
    conceptoBancoEstrategia: 'segmento_de_glosa',
    importe: '-4321.00',
    saldo: '5679.00',
    saldoEsAcreedor: false,
    moneda: 'ARS',
    referenciaExterna: null,
    paginaPdf: 1,
    ...over,
  };
}

function datosDePrueba(over: Partial<DatosPlanilla> = {}): DatosPlanilla {
  return {
    clienteId: 'cliente-1',
    loteId: 'lote-1',
    bancoCodigo: 'sintetico',
    loteEstado: 'procesado',
    adaptadorVersion: 'sintetico@1',
    generadoEn: '2026-08-12T00:00:00.000Z',
    correlacion: 'correlacion-1',
    motivoCodigo: 'demo_contadora',
    destinatarioCodigo: 'estudio_interno',
    cabeceras: [cabeceraDePrueba()],
    filas: [filaDePrueba()],
    ...over,
  };
}

async function releer(libro: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buffer = await serializarLibro(libro);
  const releido = new ExcelJS.Workbook();
  await releido.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return releido;
}

describe('armarLibro — camino feliz', () => {
  it('arma dos hojas: Control de saldos + una por cuenta', async () => {
    const r = armarLibro(datosDePrueba());
    expect(r.estado).toBe('armado');
    if (r.estado !== 'armado') return;
    expect(r.filas).toBe(1);

    const releido = await releer(r.libro);
    expect(releido.getWorksheet('Control de saldos')).toBeDefined();
    expect(releido.worksheets.length).toBe(2);
  });

  it('el buffer serializado es un zip real (magic PK)', async () => {
    const r = armarLibro(datosDePrueba());
    if (r.estado !== 'armado') throw new Error('no armó');
    const buffer = await serializarLibro(r.libro);
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  it('el importe es un NÚMERO real, no texto, con el formato correcto', async () => {
    const r = armarLibro(datosDePrueba());
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja de movimientos');

    const filaEncabezados = hoja.getRow(7).values as unknown[];
    const colImporteSigno = filaEncabezados.findIndex((v) => v === 'Importe con signo (control)');
    expect(colImporteSigno).toBeGreaterThan(0);

    const celda = hoja.getCell(8, colImporteSigno);
    expect(typeof celda.value).toBe('number');
    expect(celda.value).toBe(-4321);
  });

  it('débito y crédito se derivan del signo: nunca los dos con valor en la misma fila', async () => {
    const r = armarLibro(
      datosDePrueba({
        filas: [filaDePrueba({ filaNumero: 1, importe: '-100.00' }), filaDePrueba({ filaNumero: 2, importe: '200.00' })],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = hoja.getRow(7).values as unknown[];
    const colDebito = headers.findIndex((v) => v === 'Débito (sale de la cuenta)');
    const colCredito = headers.findIndex((v) => v === 'Crédito (entra a la cuenta)');

    // Fila de débito (importe negativo): débito=100, crédito vacío.
    expect(hoja.getCell(8, colDebito).value).toBe(100);
    expect(hoja.getCell(8, colCredito).value).toBeFalsy();
    // Fila de crédito (importe positivo): crédito=200, débito vacío.
    expect(hoja.getCell(9, colCredito).value).toBe(200);
    expect(hoja.getCell(9, colDebito).value).toBeFalsy();
  });

  it('un saldo NULL se representa como celda vacía, nunca 0', async () => {
    const r = armarLibro(datosDePrueba({ filas: [filaDePrueba({ saldo: null })] }));
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = hoja.getRow(7).values as unknown[];
    const colSaldo = headers.findIndex((v) => v === 'Saldo');
    const valor = hoja.getCell(8, colSaldo).value;
    expect(valor === null || valor === undefined).toBe(true);
  });

  it('pagina_pdf todo-NULL: la columna se omite del todo', () => {
    const r = armarLibro(datosDePrueba({ filas: [filaDePrueba({ paginaPdf: null })] }));
    if (r.estado !== 'armado') throw new Error('no armó');
    const hoja = r.libro.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = (hoja.getRow(7).values as unknown[]).filter(Boolean);
    expect(headers).not.toContain('Pág. del PDF');
  });

  it('una descripción que arranca con "=" vuelve como texto plano, nunca como fórmula', async () => {
    const r = armarLibro(datosDePrueba({ filas: [filaDePrueba({ descripcion: '=SUM(A1)' })] }));
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = hoja.getRow(7).values as unknown[];
    const colDescripcion = headers.findIndex((v) => v === 'Descripción');
    const celda = hoja.getCell(8, colDescripcion);
    expect(celda.value).toBe('=SUM(A1)');
    expect(typeof celda.value).toBe('string');
  });

  it.each(['+2+3', '-2-3', '@SUM(A1)', '\t=1', '\r=1'])(
    'glosa "%s" (otro disparador de fórmula) también vuelve como texto plano',
    async (glosa) => {
      const r = armarLibro(datosDePrueba({ filas: [filaDePrueba({ descripcion: glosa })] }));
      if (r.estado !== 'armado') throw new Error('no armó');
      const releido = await releer(r.libro);
      const hoja = releido.worksheets[1];
      if (!hoja) throw new Error('falta la hoja');
      const headers = hoja.getRow(7).values as unknown[];
      const colDescripcion = headers.findIndex((v) => v === 'Descripción');
      expect(typeof hoja.getCell(8, colDescripcion).value).toBe('string');
    },
  );

  it('panel congelado y autofiltro cubren el rango correcto', () => {
    const r = armarLibro(datosDePrueba());
    if (r.estado !== 'armado') throw new Error('no armó');
    const hoja = r.libro.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    expect(hoja.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 7 });
    expect(hoja.autoFilter).toMatchObject({ from: { row: 7, column: 1 } });
  });

  it('las columnas de clasificación (Cuenta contable, Observación) están vacías en cada fila', async () => {
    const r = armarLibro(
      datosDePrueba({
        filas: [filaDePrueba({ filaNumero: 1 }), filaDePrueba({ filaNumero: 2, importe: '10.00' })],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = hoja.getRow(7).values as unknown[];
    const colCuentaContable = headers.findIndex((v) => v === 'Cuenta contable');
    const colObservacion = headers.findIndex((v) => v === 'Observación');
    for (const fila of [8, 9]) {
      expect(hoja.getCell(fila, colCuentaContable).value).toBeFalsy();
      expect(hoja.getCell(fila, colObservacion).value).toBeFalsy();
    }
  });
});

describe('armarLibro — abortos', () => {
  it('más de MAX_FILAS: aborta con demasiadas_filas sin tocar exceljs', () => {
    const filas = Array.from({ length: 50_001 }, (_, i) => filaDePrueba({ filaNumero: i + 1 }));
    const r = armarLibro(datosDePrueba({ filas }));
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'demasiadas_filas' });
  });

  it('importe fuera de rango: aborta con el filaNumero exacto, no arma nada', () => {
    const r = armarLibro(
      datosDePrueba({ filas: [filaDePrueba({ filaNumero: 7, importe: '99999999999999.99' })] }),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'importe_fuera_de_rango', filaNumero: 7 });
  });

  it('fecha inválida: aborta con el filaNumero exacto', () => {
    const r = armarLibro(datosDePrueba({ filas: [filaDePrueba({ filaNumero: 3, fecha: '2026-02-30' })] }));
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'fecha_invalida', filaNumero: 3 });
  });

  it('una fila con cuentaBancariaId sin cabecera: cabecera_faltante', () => {
    const r = armarLibro(
      datosDePrueba({ filas: [filaDePrueba({ filaNumero: 9, cuentaBancariaId: 'cta-fantasma' })] }),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'cabecera_faltante', filaNumero: 9 });
  });
});

describe('armarLibro — volumen real', () => {
  it('1400 filas (el volumen medido de Macro) arma sin error', () => {
    const filas = Array.from({ length: 1400 }, (_, i) =>
      filaDePrueba({ filaNumero: i + 1, fecha: '2026-06-05', importe: i % 2 === 0 ? '-10.00' : '10.00' }),
    );
    const inicio = Date.now();
    const r = armarLibro(datosDePrueba({ filas }));
    expect(r.estado).toBe('armado');
    if (r.estado === 'armado') expect(r.filas).toBe(1400);
    expect(Date.now() - inicio).toBeLessThan(5000);
  });
});
