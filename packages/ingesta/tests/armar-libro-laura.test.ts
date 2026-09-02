/**
 * `armar-libro-laura.ts` — sin base, sin disco. Datos enteramente SINTÉTICOS (ningún nombre ni cifra
 * calcada de Bracci o ROKA — ver el header de `armar-libro-laura.ts` sobre por qué las listas nunca
 * viven en código versionado).
 */

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { cuitSintetico, prng } from '@sistema-contable/data';
import {
  armarLibroLaura,
  ListaDeContraparteVaciaError,
  textoTipoCriollo,
  verificarSinIdentificadores,
  type ResultadoRelevamiento,
} from '@sistema-contable/ingesta';

function clienteVacio(clienteId: string, razonSocial: string): ResultadoRelevamiento['bracci'] {
  return {
    clienteId,
    razonSocial,
    correlacion: 'correlacion-de-prueba',
    contrapartes: { clienteId, filas: [], resumen: { grupos: 0, movimientos: 0 } },
    tiposSinCuenta: [],
    asientosAutomaticos: [],
  };
}

function resultadoSintetico(overrides: {
  readonly bracci?: Partial<ResultadoRelevamiento['bracci']>;
  readonly roka?: Partial<ResultadoRelevamiento['roka']>;
} = {}): ResultadoRelevamiento {
  return {
    bracci: { ...clienteVacio('cliente-1', 'CLIENTE SINTETICO UNO'), ...overrides.bracci },
    roka: { ...clienteVacio('cliente-2', 'CLIENTE SINTETICO DOS'), ...overrides.roka },
  };
}

const OPCIONES_BASE = {
  generadoEn: '2026-01-20T12:00:00.000Z',
  listaBracci: ['Es un cliente', 'Socio sintético A', 'Otro (aclarar abajo)'],
  listaRoka: ['Es un cliente', 'Socio sintético B', 'Otro (aclarar abajo)'],
};

describe('textoTipoCriollo', () => {
  it('pago_de_haberes tiene el texto EXACTO del plan aprobado', () => {
    expect(textoTipoCriollo('pago_de_haberes')).toBe(
      'Pago de sueldos al personal (importe neto, no incluye cargas sociales ni aportes)',
    );
  });

  it('un tipo sin traducción cae a su propio código con espacios — nunca inventa una palabra', () => {
    expect(textoTipoCriollo('comision_bancaria')).toBe('comision bancaria');
  });
});

describe('verificarSinIdentificadores — INV-13, fail-closed', () => {
  it('un workbook limpio no lanza', () => {
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Hoja');
    hoja.getCell('A1').value = 'CONCEPTO DE PRUEBA SIN IDENTIFICADORES';
    expect(() => verificarSinIdentificadores(libro)).not.toThrow();
  });

  it('mutación real: un CUIT sintético en una celda revienta ANTES de que nadie escriba el archivo', () => {
    // `cuitSintetico` (mismo generador que `extracto-sintetico.ts`): dígito verificador deliberadamente
    // inválido, no pertenece a ningún contribuyente real — pero tiene la FORMA que
    // `contieneIdentificador()` detecta, que es lo único que esta prueba necesita.
    const cuit = cuitSintetico(prng(1));
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Hoja');
    hoja.getCell('B4').value = `CONTACTO CUIT ${cuit} PARA CONSULTAS`;
    expect(() => verificarSinIdentificadores(libro)).toThrow(/INV-13/);
  });

  it('la aserción también recorre hojas ocultas (la hoja "Listas" de armarLibroLaura)', () => {
    const cuit = cuitSintetico(prng(2));
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Oculta', { state: 'veryHidden' });
    hoja.getCell('A1').value = `CUIT ${cuit} DE PRUEBA`;
    expect(() => verificarSinIdentificadores(libro)).toThrow(/INV-13/);
  });
});

describe('armarLibroLaura', () => {
  it('lanza ListaDeContraparteVaciaError si alguna de las dos listas viene vacía', async () => {
    const datos = resultadoSintetico();
    await expect(armarLibroLaura(datos, { ...OPCIONES_BASE, listaBracci: [] })).rejects.toBeInstanceOf(
      ListaDeContraparteVaciaError,
    );
    await expect(armarLibroLaura(datos, { ...OPCIONES_BASE, listaRoka: [] })).rejects.toBeInstanceOf(
      ListaDeContraparteVaciaError,
    );
  });

  it('arma las 3 hojas más la hoja oculta de listas, con las razones sociales en los banners', async () => {
    const datos = resultadoSintetico({
      bracci: {
        contrapartes: {
          clienteId: 'cliente-1',
          filas: [
            {
              clienteId: 'cliente-1',
              cantidadMovimientos: 5,
              algunMovimientoConMultiplesCandidatos: false,
              ejemploDescripcion: 'CONTRAPARTE SINTETICA UNO',
              ejemploFecha: '2026-01-10',
              ejemploImporte: '-1234.56',
              esRetiroDeSocio: false,
            },
            {
              clienteId: 'cliente-1',
              cantidadMovimientos: 2,
              algunMovimientoConMultiplesCandidatos: false,
              ejemploDescripcion: 'RETIRO SINTETICO DE SOCIO',
              ejemploFecha: '2026-01-11',
              ejemploImporte: '-500.00',
              esRetiroDeSocio: true,
            },
          ],
          resumen: { grupos: 3, movimientos: 4 },
        },
        tiposSinCuenta: [],
      },
      roka: {
        tiposSinCuenta: [
          {
            clienteId: 'cliente-2',
            tipo: 'pago_de_haberes',
            cantidadMovimientos: 2,
            cantidadConceptosDistintos: 2,
            ejemploDescripcion: 'PAGO SINTETICO DE HABERES',
            ejemploFecha: '2026-01-12',
            ejemploImporte: '-9000.00',
          },
        ],
      },
    });

    const libro = await armarLibroLaura(datos, OPCIONES_BASE);

    const nombres = libro.worksheets.map((h) => h.name);
    expect(nombres).toEqual(expect.arrayContaining(['Contrapartes', 'Tipos sin cuenta', 'Asientos automáticos', 'Listas']));

    const hojaListas = libro.getWorksheet('Listas');
    expect(hojaListas?.state).toBe('veryHidden');

    const hojaContrapartes = libro.getWorksheet('Contrapartes');
    expect(hojaContrapartes).toBeDefined();
    const textoDeLaHoja = JSON.stringify(hojaContrapartes?.getSheetValues());
    expect(textoDeLaHoja).toContain('CLIENTE SINTETICO UNO');
    expect(textoDeLaHoja).toContain('CLIENTE SINTETICO DOS');
    expect(textoDeLaHoja).toContain('CONTRAPARTE SINTETICA UNO');
    expect(textoDeLaHoja).toContain('RETIRO SINTETICO DE SOCIO');

    const hojaTipos = libro.getWorksheet('Tipos sin cuenta');
    const textoDeTipos = JSON.stringify(hojaTipos?.getSheetValues());
    // El texto en criollo, no el código crudo `pago_de_haberes`.
    expect(textoDeTipos).toContain('Pago de sueldos al personal');

    // La verificación INV-13 ya corrió DENTRO de `armarLibroLaura` sin lanzar — repetirla acá confirma
    // que el libro devuelto también pasa la aserción de forma independiente.
    expect(() => verificarSinIdentificadores(libro)).not.toThrow();
  });
});
