/**
 * Tanda 1 — agrupación (`docs/diseno/31-replanteo-hacia-producto.md`). `claveDeAgrupacion` pura,
 * `agruparFilas` (homogeneidad + exclusión de `distinguir_tercero_de_socio`), y las dos hojas nuevas
 * ("Grupos"/"Tarjeta pendiente") de `armarLibro`.
 *
 * El bloque final ("colisión real, no razonamiento") corre el MOTOR REAL (`reconocer()` +
 * `lexicoDe('galicia')`) sobre un par de literales reales de `catalogo.ts` — no un fixture inventado —
 * para probar que el mismo `(bancoCodigo, conceptoBanco)` puede resolver dos `identificacion`/
 * `categoriaEspecial` distintos (el riesgo que señalaron `tech-lead`, `contador-dominio` y
 * `ux-designer`, cada uno por su cuenta), y que `agruparFilas` lo maneja como "Mixto — ver detalle",
 * nunca silenciosamente como un grupo homogéneo.
 */

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { construirIndice, lexicoDe, reconocer, textoDeReconocimiento } from '@sistema-contable/contabilidad';
import type { EvidenciaDeMovimiento } from '@sistema-contable/contabilidad';
import {
  agruparFilas,
  armarLibro,
  claveDeAgrupacion,
  serializarLibro,
  type CabeceraCuenta,
  type CategoriaEspecial,
  type DatosPlanilla,
  type FilaPlanilla,
} from '../src/planilla/armar-libro.ts';

// -----------------------------------------------------------------------------
// Fixtures — mismo patrón que planilla.test.ts (builder + override + spread).
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
    conceptoCodigo: null,
    conceptoCompleto: true,
    conceptoBancoEstrategia: 'segmento_de_glosa',
    importe: '-4321.00',
    saldo: '5679.00',
    saldoEsAcreedor: false,
    moneda: 'ARS',
    referenciaExterna: null,
    paginaPdf: null,
    identificacion: null,
    confianza: null,
    pendiente: null,
    contraparteConocida: null,
    categoriaEspecial: null,
    cuentaContable: null,
    contraparte: null,
    requiereDecisionHumana: null,
    agrupable: true,
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

// -----------------------------------------------------------------------------
// `claveDeAgrupacion` — pura
// -----------------------------------------------------------------------------

describe('claveDeAgrupacion', () => {
  it('mismo banco + mismo texto (con espacios y mayúsculas distintas) → misma clave', () => {
    expect(claveDeAgrupacion('galicia', 'Transferencia  Recibida')).toBe(
      claveDeAgrupacion('galicia', '  transferencia recibida  '),
    );
  });

  it('mismo texto, distinto banco → clave distinta', () => {
    expect(claveDeAgrupacion('galicia', 'ACREDITAMIENTO')).not.toBe(claveDeAgrupacion('macro', 'ACREDITAMIENTO'));
  });

  it('conceptoBanco null → clave estable, distinta de cualquier texto real', () => {
    const clave = claveDeAgrupacion('galicia', null);
    expect(clave).toBe(claveDeAgrupacion('galicia', null));
    expect(clave).not.toBe(claveDeAgrupacion('galicia', '(sin concepto)'.toUpperCase()));
  });

  it('NUNCA usa la normalización del léxico (no colapsa dígitos ni tokens variables)', () => {
    // Dos referencias con solo el número de comprobante distinto tienen que quedar en grupos
    // DISTINTOS acá — la normalización que colapsaría eso es la del motor (`normalizarParaLexico`,
    // para matchear), no la de esta clave (para agrupar). Mezclarlas sería el bug del digest (187)
    // por la puerta de atrás.
    expect(claveDeAgrupacion('galicia', 'PAGO PROVEEDOR 000123')).not.toBe(
      claveDeAgrupacion('galicia', 'PAGO PROVEEDOR 000456'),
    );
  });
});

// -----------------------------------------------------------------------------
// `agruparFilas` — homogeneidad y exclusión de `distinguir_tercero_de_socio`
// -----------------------------------------------------------------------------

describe('agruparFilas', () => {
  it('agrupa por banco+conceptoBanco, sin importar clase/que_decide (sintético, ilustrativo)', () => {
    const cabeceras = new Map([['cta-1', cabeceraDePrueba()]] as const);
    const filas = [
      filaDePrueba({ filaNumero: 1, conceptoBanco: 'COMISION' }),
      filaDePrueba({ filaNumero: 2, conceptoBanco: 'COMISION' }),
      filaDePrueba({ filaNumero: 3, conceptoBanco: 'OTRO CONCEPTO' }),
    ];
    const grupos = agruparFilas(filas, cabeceras);
    expect(grupos).toHaveLength(2);
    const grande = grupos[0]!;
    expect(grande.cantidad).toBe(2);
    expect(grande.conceptoBanco).toBe('COMISION');
  });

  it('sin umbral mínimo, sin carpeta "Varios": un grupo de 1 se muestra igual', () => {
    const cabeceras = new Map([['cta-1', cabeceraDePrueba()]] as const);
    const grupos = agruparFilas([filaDePrueba()], cabeceras);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.cantidad).toBe(1);
  });

  it('🔴 dos "motivos" reales que comparten (bancoCodigo, conceptoBanco): caen en el MISMO grupo, ' +
    'marcado "Mixto — ver detalle", nunca con un valor arbitrario de un miembro cualquiera', () => {
    // No es un caso sintético: son los dos resultados REALES que produce el motor sobre el mismo
    // literal 'galicia'/'ACREDITAMIENTO' según el lado — ver el bloque de más abajo, que corre el
    // motor de verdad y confirma que estos dos valores son los que realmente salen. Este test prueba
    // la mitad "presentación": que `agruparFilas` los junta (misma clave, por diseño) y los declara
    // mixtos en vez de mostrar uno de los dos como si fuera el único.
    const cabeceras = new Map([['cta-1', cabeceraDePrueba({ bancoCodigo: 'galicia' })]] as const);
    const filas = [
      filaDePrueba({
        filaNumero: 1,
        conceptoBanco: 'ACREDITAMIENTO',
        importe: '1000.00', // crédito → lado 'haber', coincide con `ladoEsperado`
        identificacion: 'Acreditación de tarjeta (cobro con tarjeta)',
        categoriaEspecial: 'tarjeta_pendiente',
      }),
      filaDePrueba({
        filaNumero: 2,
        conceptoBanco: 'ACREDITAMIENTO',
        importe: '-1000.00', // débito → lado 'debe', reversa_incoherente
        identificacion: 'Indeterminado',
        categoriaEspecial: null,
      }),
    ];
    const grupos = agruparFilas(filas, cabeceras);
    expect(grupos).toHaveLength(1); // misma clave: se juntan
    const [grupo] = grupos;
    expect(grupo!.cantidad).toBe(2);
    expect(grupo!.tipoDeMovimiento).toBe('Mixto — ver detalle');
    expect(grupo!.categoriaEspecial).toBeNull(); // NUNCA rutea a "Tarjeta pendiente" sin unanimidad
  });

  it('grupo homogéneo con categoriaEspecial unánime rutea a "tarjeta_pendiente"', () => {
    const cabeceras = new Map([['cta-1', cabeceraDePrueba({ bancoCodigo: 'galicia' })]] as const);
    const filas = [
      filaDePrueba({
        filaNumero: 1,
        conceptoBanco: 'ACREDITAMIENTO',
        identificacion: 'Acreditación de tarjeta (cobro con tarjeta)',
        categoriaEspecial: 'tarjeta_pendiente',
      }),
      filaDePrueba({
        filaNumero: 2,
        conceptoBanco: 'ACREDITAMIENTO',
        identificacion: 'Acreditación de tarjeta (cobro con tarjeta)',
        categoriaEspecial: 'tarjeta_pendiente',
      }),
    ];
    const grupos = agruparFilas(filas, cabeceras);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.tipoDeMovimiento).toBe('Acreditación de tarjeta (cobro con tarjeta)');
    expect(grupos[0]!.categoriaEspecial).toBe('tarjeta_pendiente' satisfies CategoriaEspecial);
  });

  it('🔴 distinguir_tercero_de_socio NUNCA se agrupa con otro, aunque comparta banco+concepto — ' +
    'dos contrapartes reales pueden compartir el mismo texto genérico del banco', () => {
    const cabeceras = new Map([['cta-1', cabeceraDePrueba()]] as const);
    const filas = [
      filaDePrueba({ filaNumero: 1, conceptoBanco: 'TRANSFERENCIA RECIBIDA', agrupable: false }),
      filaDePrueba({ filaNumero: 2, conceptoBanco: 'TRANSFERENCIA RECIBIDA', agrupable: false }),
      // Una tercera fila SÍ agrupable, mismo texto — para confirmar que la exclusión es de las dos
      // primeras entre sí, no un apagado global de la clave para ese texto.
      filaDePrueba({ filaNumero: 3, conceptoBanco: 'TRANSFERENCIA RECIBIDA', agrupable: true }),
    ];
    const grupos = agruparFilas(filas, cabeceras);
    // 2 singulares (uno por fila no agrupable) + 1 grupo de la tercera fila = 3 grupos, ninguno de
    // cantidad 2 ni 3.
    expect(grupos).toHaveLength(3);
    expect(grupos.every((g) => g.cantidad === 1)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// `armarLibro` — enrutamiento a "Grupos" / "Tarjeta pendiente"
// -----------------------------------------------------------------------------

describe('armarLibro — enrutamiento de grupos (Tanda 1)', () => {
  it('un grupo con categoriaEspecial unánime va a "Tarjeta pendiente", nunca a "Grupos"', async () => {
    const r = armarLibro(
      datosDePrueba({
        filas: [
          filaDePrueba({ filaNumero: 1, categoriaEspecial: 'tarjeta_pendiente' }),
          filaDePrueba({ filaNumero: 2, categoriaEspecial: 'tarjeta_pendiente' }),
        ],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const buffer = await serializarLibro(r.libro);
    const releido = new ExcelJS.Workbook();
    await releido.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(releido.getWorksheet('Tarjeta pendiente')).toBeDefined();
    expect(releido.getWorksheet('Grupos')).toBeUndefined();

    const hoja = releido.getWorksheet('Tarjeta pendiente')!;
    const headers = hoja.getRow(3).values as unknown[];
    const colCantidad = headers.findIndex((v) => v === 'Cantidad de movimientos');
    expect(hoja.getCell(4, colCantidad).value).toBe(2);
  });

  it('un grupo mixto (categoriaEspecial no unánime) va a "Grupos", nunca a "Tarjeta pendiente"', async () => {
    const r = armarLibro(
      datosDePrueba({
        filas: [
          filaDePrueba({ filaNumero: 1, categoriaEspecial: 'tarjeta_pendiente', identificacion: 'A' }),
          filaDePrueba({ filaNumero: 2, categoriaEspecial: null, identificacion: 'B' }),
        ],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const buffer = await serializarLibro(r.libro);
    const releido = new ExcelJS.Workbook();
    await releido.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(releido.getWorksheet('Grupos')).toBeDefined();
    expect(releido.getWorksheet('Tarjeta pendiente')).toBeUndefined();

    const hoja = releido.getWorksheet('Grupos')!;
    const headers = hoja.getRow(3).values as unknown[];
    const colTipo = headers.findIndex((v) => v === 'Tipo de movimiento');
    expect(hoja.getCell(4, colTipo).value).toBe('Mixto — ver detalle');
  });

  it('🔴 "Tarjeta pendiente" NO es un solo grupo indiferenciado: se subdivide por (banco, ' +
    'conceptoBanco) exactamente igual que "Grupos" — mismo mecanismo, misma clave. Con los DOS ' +
    'literales reales que hoy tiene Bracci para completar_con_liquidacion_del_adquirente ' +
    '(`catalogo.ts`: `ACREDITAMIENTO` 249 casos, `ANULAC. ACRED. FIRSTDATA.` 10 casos)', async () => {
    const r = armarLibro(
      datosDePrueba({
        filas: [
          filaDePrueba({
            filaNumero: 1,
            conceptoBanco: 'ACREDITAMIENTO',
            identificacion: 'Acreditación de tarjeta (cobro con tarjeta)',
            categoriaEspecial: 'tarjeta_pendiente',
          }),
          filaDePrueba({
            filaNumero: 2,
            conceptoBanco: 'ACREDITAMIENTO',
            identificacion: 'Acreditación de tarjeta (cobro con tarjeta)',
            categoriaEspecial: 'tarjeta_pendiente',
          }),
          filaDePrueba({
            filaNumero: 3,
            conceptoBanco: 'ANULAC. ACRED. FIRSTDATA.',
            identificacion: 'Acreditación de tarjeta (cobro con tarjeta)',
            categoriaEspecial: 'tarjeta_pendiente',
          }),
        ],
      }),
    );
    if (r.estado !== 'armado') throw new Error('no armó');
    const buffer = await serializarLibro(r.libro);
    const releido = new ExcelJS.Workbook();
    await releido.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    const hoja = releido.getWorksheet('Tarjeta pendiente')!;
    const headers = hoja.getRow(3).values as unknown[];
    const colConcepto = headers.findIndex((v) => v === 'Concepto del banco');
    const colCantidad = headers.findIndex((v) => v === 'Cantidad de movimientos');

    // Dos filas, no una: cada literal de banco distinto es SU PROPIO grupo, aunque las dos compartan
    // `categoriaEspecial: 'tarjeta_pendiente'` y la misma `identificacion`. Orden: cantidad
    // descendente, así que el grupo de 2 (ACREDITAMIENTO) va primero.
    expect(hoja.getCell(4, colConcepto).value).toBe('ACREDITAMIENTO');
    expect(hoja.getCell(4, colCantidad).value).toBe(2);
    expect(hoja.getCell(5, colConcepto).value).toBe('ANULAC. ACRED. FIRSTDATA.');
    expect(hoja.getCell(5, colCantidad).value).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// 🔴 Colisión real (no razonamiento) — motor de verdad, literal real de `catalogo.ts`
// -----------------------------------------------------------------------------

describe('colisión real: mismo (bancoCodigo, conceptoBanco), dos resultados distintos', () => {
  const lexico = lexicoDe('galicia');
  if (!lexico) throw new Error('falta el léxico de galicia — no debería poder pasar');
  const indice = construirIndice(lexico);

  function evidencia(columnaOrigen: 'credito' | 'debito'): EvidenciaDeMovimiento {
    return {
      bancoCodigo: 'galicia',
      conceptoBanco: 'ACREDITAMIENTO', // literal real, `catalogo.ts` (`galicia.acreditamiento`),
      // medido 78 movimientos, `porLiteral: [{ literal: 'ACREDITAMIENTO', lado: 'haber' }]`.
      conceptoCompleto: true,
      conceptoBancoEstrategia: undefined,
      conceptoCodigo: undefined,
      columnaOrigen,
    };
  }

  it('crédito (lado "haber", coincide con ladoEsperado): decision_humana, completar_con_liquidacion_del_adquirente', () => {
    const r = reconocer(evidencia('credito'), indice);
    expect(r.clase).toBe('decision_humana');
    if (r.clase !== 'decision_humana') return;
    expect(r.queDecide).toBe('completar_con_liquidacion_del_adquirente');
    expect(r.tipo).toBe('acreditacion_tarjeta');
    expect(textoDeReconocimiento(r).identificacion).toBe('Acreditación de tarjeta (cobro con tarjeta)');
  });

  it('🔴 débito (lado "debe", MISMO literal, MISMO banco): sin_reconocer/reversa_incoherente — ' +
    'el motor resuelve distinto el mismo (bancoCodigo, conceptoBanco) según el lado, tal como ' +
    'predijeron tech-lead/contador-dominio/ux-designer, cada uno por su cuenta', () => {
    const r = reconocer(evidencia('debito'), indice);
    expect(r.clase).toBe('sin_reconocer');
    if (r.clase !== 'sin_reconocer') return;
    expect(r.motivo).toBe('reversa_incoherente');
    expect(textoDeReconocimiento(r).identificacion).toBe('Indeterminado');
  });

  it('las dos filas anteriores comparten la MISMA claveDeAgrupacion — la colisión es real, no hipotética', () => {
    const claveCredito = claveDeAgrupacion('galicia', 'ACREDITAMIENTO');
    const claveDebito = claveDeAgrupacion('galicia', 'ACREDITAMIENTO');
    expect(claveCredito).toBe(claveDebito);
  });

  it('agrupadas de punta a punta (motor real → FilaPlanilla → agruparFilas): "Mixto — ver detalle", nunca un valor mentiroso', () => {
    const rCredito = reconocer(evidencia('credito'), indice);
    const rDebito = reconocer(evidencia('debito'), indice);
    if (rCredito.clase !== 'decision_humana' || rDebito.clase !== 'sin_reconocer') {
      throw new Error('el motor cambió de comportamiento — este test ya no prueba lo que dice probar');
    }

    const categoriaCredito: CategoriaEspecial | null =
      rCredito.queDecide === 'completar_con_liquidacion_del_adquirente' ? 'tarjeta_pendiente' : null;

    const cabeceras = new Map([['cta-1', cabeceraDePrueba({ bancoCodigo: 'galicia' })]] as const);
    const filas: FilaPlanilla[] = [
      filaDePrueba({
        filaNumero: 1,
        conceptoBanco: 'ACREDITAMIENTO',
        identificacion: textoDeReconocimiento(rCredito).identificacion,
        categoriaEspecial: categoriaCredito,
      }),
      filaDePrueba({
        filaNumero: 2,
        conceptoBanco: 'ACREDITAMIENTO',
        identificacion: textoDeReconocimiento(rDebito).identificacion,
        categoriaEspecial: null,
      }),
    ];

    const grupos = agruparFilas(filas, cabeceras);
    expect(grupos).toHaveLength(1); // se juntan: misma clave
    expect(grupos[0]!.tipoDeMovimiento).toBe('Mixto — ver detalle');
    expect(grupos[0]!.categoriaEspecial).toBeNull(); // nunca rutea a "Tarjeta pendiente" sin unanimidad
  });
});
