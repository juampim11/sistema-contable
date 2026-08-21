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
    tipoCuenta: null,
    cbuUltimos4: null,
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
    identificacion: null,
    confianza: null,
    pendiente: null,
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
    estadoEnriquecimiento: 'no_sin_lexico',
    motorDigest: null,
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

  it('"Cuenta contable"/"Observación" NO están en esta entrega (JP, ajuste 5: nada las lee hasta ' +
    'que exista Capa D — pedirle a Laura que las complete hoy es ruido, no señal)', async () => {
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
    expect(headers).not.toContain('Cuenta contable');
    expect(headers).not.toContain('Observación');
  });

  it('el header trae "Tipo de movimiento"/"Qué falta" y respeta lo que traiga la fila', async () => {
    const r = armarLibro(
      datosDePrueba({
        filas: [
          filaDePrueba({ filaNumero: 1, identificacion: 'Comisión bancaria', pendiente: null }),
          filaDePrueba({
            filaNumero: 2,
            importe: '10.00',
            identificacion: 'Indeterminado',
            pendiente: 'El sistema no reconoce este texto.',
          }),
        ],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = hoja.getRow(7).values as unknown[];
    const colTipo = headers.findIndex((v) => v === 'Tipo de movimiento');
    const colQueFalta = headers.findIndex((v) => v === 'Qué falta');
    expect(colTipo).toBeGreaterThan(0);
    expect(colQueFalta).toBeGreaterThan(0);
    expect(hoja.getCell(8, colTipo).value).toBe('Comisión bancaria');
    expect(hoja.getCell(8, colQueFalta).value).toBeFalsy();
    expect(hoja.getCell(9, colTipo).value).toBe('Indeterminado');
    expect(hoja.getCell(9, colQueFalta).value).toBe('El sistema no reconoce este texto.');
  });

  it('🔴 ajuste 7 (JP): "Confianza" es una columna propia entre "Tipo de movimiento" y "Qué falta" — ' +
    'nunca un sufijo pegado al texto del tipo, para no romper el filtro de Excel', async () => {
    const r = armarLibro(
      datosDePrueba({
        filas: [
          filaDePrueba({ filaNumero: 1, identificacion: 'Cobranza de cliente', confianza: 'Alta', pendiente: null }),
          filaDePrueba({
            filaNumero: 2,
            importe: '10.00',
            identificacion: 'Cobranza de cliente',
            confianza: 'A confirmar',
            pendiente: 'Depende del padrón de socios.',
          }),
        ],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = hoja.getRow(7).values as unknown[];
    const colTipo = headers.findIndex((v) => v === 'Tipo de movimiento');
    const colConfianza = headers.findIndex((v) => v === 'Confianza');
    const colQueFalta = headers.findIndex((v) => v === 'Qué falta');
    expect(colConfianza).toBe(colTipo + 1); // inmediatamente después (ux-designer)
    expect(colConfianza).toBeLessThan(colQueFalta);
    // "identificacion" NUNCA lleva un sufijo — es el mismo texto sin importar la confianza, así el
    // filtro de Excel por "Tipo de movimiento" agrupa las dos filas bajo un único valor.
    expect(hoja.getCell(8, colTipo).value).toBe('Cobranza de cliente');
    expect(hoja.getCell(9, colTipo).value).toBe('Cobranza de cliente');
    expect(hoja.getCell(8, colConfianza).value).toBe('Alta');
    expect(hoja.getCell(9, colConfianza).value).toBe('A confirmar');
  });
});

/** Busca, en la hoja "Control de saldos", la primera celda de columna A que empieza con el prefijo
 *  dado — mismo criterio en todo el archivo de leer la leyenda por contenido, no por fila fija (la
 *  posición depende de `cabeceras.length`). */
function celdaDeControl(hoja: ExcelJS.Worksheet, prefijo: string): string | undefined {
  let encontrada: string | undefined;
  hoja.eachRow((fila) => {
    const v = fila.getCell(1).value;
    if (typeof v === 'string' && v.startsWith(prefijo)) encontrada = v;
  });
  return encontrada;
}

// -----------------------------------------------------------------------------
// Ajuste 1 (2026-08-21) — dos cuentas sin alias no pueden quedar indistinguibles
// -----------------------------------------------------------------------------

describe('armarLibro — desambiguación de hojas sin alias (ajuste 1)', () => {
  it('🔴 caso real que reportó JP: dos cuentas Macro ARS sin alias, distinto tipo_cuenta — ' +
    'nombres de pestaña y etiquetas DISTINTOS, sin depender del "(2)" ciego de Excel', async () => {
    const r = armarLibro(
      datosDePrueba({
        cabeceras: [
          cabeceraDePrueba({
            cuentaBancariaId: 'cta-cc',
            bancoCodigo: 'macro',
            cuentaAlias: null,
            tipoCuenta: 'cuenta_corriente',
            cbuUltimos4: null,
          }),
          cabeceraDePrueba({
            cuentaBancariaId: 'cta-especial',
            bancoCodigo: 'macro',
            cuentaAlias: null,
            tipoCuenta: 'cuenta_corriente_especial',
            cbuUltimos4: null,
          }),
        ],
        filas: [
          filaDePrueba({ filaNumero: 1, cuentaBancariaId: 'cta-cc' }),
          filaDePrueba({ filaNumero: 1, cuentaBancariaId: 'cta-especial', importe: '10.00' }),
        ],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const nombresDeHoja = releido.worksheets.map((w) => w.name);
    expect(nombresDeHoja).toEqual(['Control de saldos', 'ARS macro Cta.Cte', 'ARS macro Cta.Esp']);
    // Ninguna pestaña lleva el "(2)" de colisión ciega — la desambiguación real evitó que hiciera falta.
    expect(nombresDeHoja.some((n) => n.includes('(2)'))).toBe(false);

    const hojaCC = releido.getWorksheet('ARS macro Cta.Cte');
    const hojaEspecial = releido.getWorksheet('ARS macro Cta.Esp');
    expect(hojaCC?.getCell('A1').value).toContain('macro · Cuenta corriente · ARS');
    expect(hojaEspecial?.getCell('A1').value).toContain('macro · Cuenta corriente especial · ARS');
  });

  it('con CBU cargado, la etiqueta DENTRO de la hoja lo muestra — pero la pestaña NUNCA lo lleva', async () => {
    const r = armarLibro(
      datosDePrueba({
        cabeceras: [cabeceraDePrueba({ cuentaAlias: null, tipoCuenta: 'cuenta_corriente', cbuUltimos4: '1234' })],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    expect(hoja?.name).not.toContain('1234');
    expect(hoja?.getCell('A1').value).toContain('····1234');
  });

  it('con alias cargado, tipoCuenta/cbuUltimos4 no cambian nada (camino ya probado, sin tocar)', async () => {
    const r = armarLibro(
      datosDePrueba({
        cabeceras: [
          cabeceraDePrueba({ cuentaAlias: 'Cuenta operativa', tipoCuenta: 'cuenta_corriente', cbuUltimos4: '9999' }),
        ],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    expect(hoja?.getCell('A1').value).toContain('Cuenta operativa');
    expect(hoja?.getCell('A1').value).not.toContain('9999');
  });
});

// -----------------------------------------------------------------------------
// Ajuste 2 (2026-08-21) — color de encabezado por origen del dato
// -----------------------------------------------------------------------------

describe('armarLibro — color de encabezado por origen del dato (ajuste 2)', () => {
  it('gris para lo que publica el banco, azul para lo que identifica el sistema — ' +
    '"Cuenta contable"/"Observación" no existen en esta entrega (ajuste 4/5)', async () => {
    const r = armarLibro(datosDePrueba());
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = hoja.getRow(7).values as unknown[];
    const argbDe = (header: string): string | undefined => {
      const col = headers.findIndex((v) => v === header);
      if (col < 1) return undefined; // columna no existe (ajuste 5): sin celda que consultar
      const fill = hoja.getCell(7, col).fill;
      return fill && fill.type === 'pattern' ? (fill.fgColor?.argb as string | undefined) : undefined;
    };
    expect(argbDe('Fecha')).toBe('FFE7E6E6');
    expect(argbDe('Descripción')).toBe('FFE7E6E6');
    expect(argbDe('Tipo de movimiento')).toBe('FF5B9BD5');
    expect(argbDe('Confianza')).toBe('FF5B9BD5');
    expect(argbDe('Qué falta')).toBe('FF5B9BD5');
    expect(argbDe('Corrección / Identidad')).toBe('FFFFE699');
    expect(argbDe('Comentarios')).toBe('FFFFE699');
    expect(argbDe('Cuenta contable')).toBeUndefined();
    expect(argbDe('Observación')).toBeUndefined();
    expect(argbDe('N° de fila (sistema)')).toBe('FFF2F0EC');
    expect(argbDe('Importe con signo (control)')).toBe('FFF2F0EC');
  });

  it('la leyenda de "Control de saldos" explica los tres colores', async () => {
    const r = armarLibro(datosDePrueba());
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.getWorksheet('Control de saldos');
    if (!hoja) throw new Error('falta la hoja de control');
    expect(celdaDeControl(hoja, '— Los encabezados de la hoja de movimientos están coloreados')).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// Feedback de Laura (JP): "Corrección / Identidad" + "Comentarios"
// -----------------------------------------------------------------------------

describe('armarLibro — columnas de feedback de Laura', () => {
  it('🔴 posición: inmediatamente después de "Qué falta", antes de "Cuenta" (ux-designer)', async () => {
    const r = armarLibro(datosDePrueba());
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = (hoja.getRow(7).values as unknown[]).filter((v): v is string => typeof v === 'string');
    const iQueFalta = headers.indexOf('Qué falta');
    const iPrincipal = headers.indexOf('Corrección / Identidad');
    const iComentarios = headers.indexOf('Comentarios');
    const iCuenta = headers.indexOf('Cuenta');
    expect(iPrincipal).toBe(iQueFalta + 1);
    expect(iComentarios).toBe(iPrincipal + 1);
    expect(iCuenta).toBe(iComentarios + 1);
  });

  it('🔴 las dos columnas están SIEMPRE vacías al exportar, sin importar la clase/confianza de la fila — nadie las pre-llena', async () => {
    const r = armarLibro(
      datosDePrueba({
        filas: [
          filaDePrueba({ filaNumero: 1, identificacion: 'Comisión bancaria', confianza: 'Alta', pendiente: null }),
          filaDePrueba({
            filaNumero: 2,
            importe: '10.00',
            identificacion: 'Pago a proveedor (transferencia)',
            confianza: 'A confirmar',
            pendiente: 'Depende del padrón de socios.',
          }),
          filaDePrueba({ filaNumero: 3, importe: '20.00', identificacion: 'Indeterminado', confianza: null, pendiente: 'Decinos qué es.' }),
        ],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.worksheets[1];
    if (!hoja) throw new Error('falta la hoja');
    const headers = hoja.getRow(7).values as unknown[];
    const colPrincipal = headers.findIndex((v) => v === 'Corrección / Identidad');
    const colComentarios = headers.findIndex((v) => v === 'Comentarios');
    for (const fila of [8, 9, 10]) {
      expect(hoja.getCell(fila, colPrincipal).value).toBeFalsy();
      expect(hoja.getCell(fila, colComentarios).value).toBeFalsy();
    }
  });

  it('la leyenda explica el principio de silencio=aprobación, en las dos direcciones del riesgo', async () => {
    const r = armarLibro(datosDePrueba());
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.getWorksheet('Control de saldos');
    if (!hoja) throw new Error('falta la hoja de control');
    expect(celdaDeControl(hoja, '— "Corrección / Identidad" y "Comentarios" son las únicas columnas')).toBeDefined();
    // Riesgo 1 (JP): que Laura piense que hay que escribir "OK" en las ~900 filas de "Alta".
    expect(celdaDeControl(hoja, '  Ojo con las dos lecturas erróneas: NO hace falta escribir "OK"')).toBeDefined();
    // Riesgo 2 (JP): que una fila vacía en "A confirmar" se lea como "ya resuelta".
    expect(celdaDeControl(hoja, '  pendiente, solo que todavía nadie la miró.')).toBeDefined();
    expect(celdaDeControl(hoja, '  · Amarillo/dorado: son las dos columnas que llenás VOS')).toBeDefined();
  });
});

describe('armarLibro — sello del motor, las 4 ramas de EstadoEnriquecimiento (puro, sin DB)', () => {
  it('"si": imprime la versión real del motor y el lote', async () => {
    const r = armarLibro(datosDePrueba({ estadoEnriquecimiento: 'si', motorDigest: 'deadbeefcafebabe' }));
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.getWorksheet('Control de saldos');
    if (!hoja) throw new Error('falta la hoja de control');
    expect(celdaDeControl(hoja, 'Motor de reconocimiento')).toBe(
      'Motor de reconocimiento — versión deadbeefcafebabe · corrida el 2026-08-12T00:00:00.000Z sobre el lote lote-1',
    );
  });

  it.each([
    ['no_destinatario', 'el destinatario de este export no recibe la propuesta del sistema'],
    ['no_tope_superado', 'el lote supera el tope de movimientos para esta corrida'],
    ['no_sin_lexico', 'no hay léxico registrado para este banco'],
  ] as const)('"%s": explica por qué no corrió, nunca un dato falso', async (estado, fragmento) => {
    const r = armarLibro(datosDePrueba({ estadoEnriquecimiento: estado, motorDigest: null }));
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.getWorksheet('Control de saldos');
    if (!hoja) throw new Error('falta la hoja de control');
    expect(celdaDeControl(hoja, 'Motor de reconocimiento')).toBe(`Motor de reconocimiento — no se ejecutó — ${fragmento}.`);
  });

  it('🔴 estado imposible ("si" con motorDigest null) nunca imprime "undefined" — code-reviewer', async () => {
    // `DatosPlanilla` no impide esta combinación en tiempo de compilación (code-reviewer lo señaló) —
    // se fuerza en runtime para verificar que el fallback defensivo de `textoSelloDelMotor` no
    // imprima basura si algún día alguien la produce por error.
    const r = armarLibro(datosDePrueba({ estadoEnriquecimiento: 'si', motorDigest: null }));
    if (r.estado !== 'armado') throw new Error('no armó');
    const releido = await releer(r.libro);
    const hoja = releido.getWorksheet('Control de saldos');
    if (!hoja) throw new Error('falta la hoja de control');
    const texto = celdaDeControl(hoja, 'Motor de reconocimiento');
    expect(texto).not.toContain('undefined');
    expect(texto).toContain('inconsistencia interna');
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
