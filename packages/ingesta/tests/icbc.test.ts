/**
 * ADAPTADOR ICBC — contra fixture SINTÉTICO, nunca contra el PDF real (`docs/diseno/22-formato-
 * icbc.md`). Coordenadas literales medidas del archivo real; texto, importes, CUIT y CBU inventados.
 *
 * 🔴 El documento real mide 9 movimientos (spec §0) — este fixture cubre VARIOS escenarios con la
 * MISMA geometría medida, para no repetir el error de fixture pobre ya señalado en este repo:
 * 1. Débito CON saldo declarado y débito SIN saldo declarado (spec §H3: 5/9 filas reales traen
 *    saldo, sin patrón de intervalo fijo — se verifica por puntos de control).
 * 2. Crédito CON saldo (única columna medida contra un solo caso real, spec §H2).
 * 3. Un movimiento sin comprobante/referencia (campo opcional).
 * 4. El signo atrás (`##,##-`) de la columna DEBITOS, spec §H2.
 * 5. El bloque de totales en UNA sola fila con 3 valores (spec §H4/§H4.1), incluida la fecha
 *    embebida `SALDO FINAL AL <fecha>` dentro del mismo fragmento que el segundo total.
 */

import { describe, expect, it } from 'vitest';
import { adaptadorIcbc, CAPACIDADES_ICBC, leerIcbc, reconoceICBC } from '../src/adaptadores/icbc.ts';
import { verificarAritmetica } from '../src/verificacion/invariantes.ts';
import {
  anexoExtractoSchema,
  cuentaConMovimientosSchema,
  lineaNoInterpretadaSchema,
  movimientoBancarioCrudoSchema,
} from '../src/esquema.ts';
import type { FilaGeometrica } from '../src/texto-pdf.ts';

// -----------------------------------------------------------------------------
// Geometría literal de la especificación (docs/diseno/22-formato-icbc.md §1.1, §H2, §H3, §H4)
// -----------------------------------------------------------------------------

const X = {
  fecha: 82,
  bandaConcepto: 107,
} as const;

// Bordes derechos REALES, medidos contra el documento real (spec §H2): debito SIEMPRE 427.0 (7/7
// muestras), saldo SIEMPRE 582.4 (6/6 muestras). `credito`: sin universo de datos (1 sola muestra
// real, 502.6) — valor plausible dentro de la ventana declarada, no una medición repetida.
const R = {
  referencia: 330,
  debito: 427,
  credito: 502,
  saldo: 582,
} as const;

const CUIT_SINTETICO = '30000000000';
/**
 * 🔴 Generados con `Math.random()` y verificados contra `esFuga()` (`tools/barrido-fuga.ts`, script
 * efímero, descartado) antes de commitear — no tipeados a mano. El barrido compara por VALOR contra
 * el material real de `privado/`, y varios intentos "prolijos" (bloques repetidos, secuencias
 * ascendentes/descendentes) colisionaron con un número de comprobante u operación real de algún
 * archivo del roster. Ningún patrón "se ve inventado" es garantía: solo lo es un valor verificado.
 */
const NUMERO_CUENTA_SINTETICO = '2641/76626413/47'; // 4/8/2 dígitos, spec §1 H1
const CBU_SINTETICO_GRUPO1 = '49563980'; // 8 dígitos
const CBU_SINTETICO_GRUPO2 = '35296153584813'; // 14 dígitos, spec §1 H1: CBU partido en 8+14

type FragmentoDePrueba = { readonly texto: string; readonly x: number; readonly ancho?: number };

function filaGeometrica(fragmentos: readonly FragmentoDePrueba[], pagina: number, y: number): FilaGeometrica {
  return {
    pagina,
    y,
    fragmentos: [...fragmentos]
      .map((f) => ({ texto: f.texto, x: f.x, y, ancho: f.ancho ?? f.texto.length * 5 }))
      .sort((a, b) => a.x - b.x),
  };
}

function enBordeDerecho(texto: string, derecha: number, ancho = 40): FragmentoDePrueba {
  return { texto, x: derecha - ancho, ancho };
}

function hoja(): {
  readonly filas: FilaGeometrica[];
  agregar(fragmentos: readonly FragmentoDePrueba[]): void;
} {
  const filas: FilaGeometrica[] = [];
  let y = 800;
  return {
    filas,
    agregar(fragmentos: readonly FragmentoDePrueba[]): void {
      filas.push(filaGeometrica(fragmentos, 1, y));
      y -= 12;
    },
  };
}

function conSeparadorDeMiles(entero: string): string {
  return entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Centavos (no negativos) → forma argentina (`1.234,56`), sin `$` ni signo. */
function importeAr(centavosAbs: bigint): string {
  const entero = (centavosAbs / 100n).toString();
  const dec = (centavosAbs % 100n).toString().padStart(2, '0');
  return `${conSeparadorDeMiles(entero)},${dec}`;
}

/** Columna DEBITOS: signo ATRÁS (spec §H2) — redundante con la columna, no con el signo del centro. */
function importeDebito(centavosAbs: bigint): string {
  return `${importeAr(centavosAbs)}-`;
}

const CENT = 100n;

function agregarEncabezado(h: ReturnType<typeof hoja>): void {
  h.agregar([
    { texto: 'FECHA CONCEPTO F.VALOR COMPROBANTE ORIGEN CANAL DEBITOS CREDITOS SALDOS', x: X.fecha },
  ]);
}

function agregarPeriodo(h: ReturnType<typeof hoja>, desde: string, hasta: string): void {
  h.agregar([{ texto: `PERIODO ${desde} AL ${hasta}`, x: 368 }]);
}

function agregarCuitTitular(h: ReturnType<typeof hoja>): void {
  h.agregar([{ texto: `CUIT N° ${CUIT_SINTETICO.slice(0, 2)}-${CUIT_SINTETICO.slice(2, 10)}-${CUIT_SINTETICO.slice(10)}`, x: 368 }]);
}

function agregarNumeroYCbu(h: ReturnType<typeof hoja>): void {
  h.agregar([
    {
      texto: `N° ${NUMERO_CUENTA_SINTETICO} C.B.U.: ${CBU_SINTETICO_GRUPO1} ${CBU_SINTETICO_GRUPO2}`,
      x: 107,
    },
  ]);
}

function agregarSaldoAnterior(h: ReturnType<typeof hoja>, fecha: string, saldoCent: bigint): void {
  h.agregar([
    { texto: 'SALDO ULTIMO', x: 204.4 },
    { texto: `EXTRACTO AL ${fecha}`, x: 259.0 },
    enBordeDerecho(importeAr(saldoCent), R.saldo),
  ]);
}

function agregarMovimiento(
  h: ReturnType<typeof hoja>,
  opciones: {
    readonly ddmm: string;
    readonly concepto: string;
    readonly referencia?: string;
    readonly columna: 'debito' | 'credito';
    readonly importeCent: bigint;
    readonly saldoCent?: bigint;
  },
): void {
  h.agregar([
    { texto: opciones.ddmm, x: X.fecha },
    { texto: opciones.concepto, x: X.bandaConcepto },
    ...(opciones.referencia ? [enBordeDerecho(opciones.referencia, R.referencia, 20)] : []),
    opciones.columna === 'debito'
      ? enBordeDerecho(importeDebito(opciones.importeCent), R.debito)
      : enBordeDerecho(importeAr(opciones.importeCent), R.credito),
    ...(opciones.saldoCent === undefined ? [] : [enBordeDerecho(importeAr(opciones.saldoCent), R.saldo)]),
  ]);
}

function agregarTotales(
  h: ReturnType<typeof hoja>,
  total1Cent: bigint,
  total2Cent: bigint,
  saldoFinalFecha: string,
  saldoFinalCent: bigint,
): void {
  h.agregar([
    { texto: 'TOT.IMP.LEY COMP.:', x: 82.6 },
    { texto: importeAr(total1Cent), x: 196.0 },
    { texto: 'TOT.LEY COMP.$', x: 242.2 },
    { texto: `${importeAr(total2Cent)}(*) SALDO FINAL AL ${saldoFinalFecha}`, x: 347.2 },
    enBordeDerecho(importeAr(saldoFinalCent), R.saldo),
  ]);
}

// -----------------------------------------------------------------------------
// Fixture "limpio": 5 movimientos, mezcla débito/crédito, mezcla con/sin saldo por fila
// -----------------------------------------------------------------------------

function documentoLimpio(): readonly FilaGeometrica[] {
  const h = hoja();
  agregarEncabezado(h);
  agregarPeriodo(h, '01-06-2026', '30-06-2026');
  agregarCuitTitular(h);
  agregarNumeroYCbu(h);
  agregarSaldoAnterior(h, '31/05/2026', 10_000n * CENT);

  // m1: débito, SIN saldo declarado (punto de control abierto).
  agregarMovimiento(h, {
    ddmm: '01-06',
    concepto: 'PAGO PROVEEDOR SINTETICO',
    referencia: '1111',
    columna: 'debito',
    importeCent: 1_000n * CENT,
  });

  // m2: débito, CON saldo (10.000 - 1.000 - 500 = 8.500 — no se verifica contra m1 porque m1 no
  // trae saldo: la cadena por puntos de control salta el par, spec §H3).
  agregarMovimiento(h, {
    ddmm: '05-06',
    concepto: 'COMISION MANTENIMIENTO',
    referencia: '1112',
    columna: 'debito',
    importeCent: 500n * CENT,
    saldoCent: 8_500n * CENT,
  });

  // m3: crédito, CON saldo — cierra el ÚNICO par verificable de la cadena de saldos (m2 → m3):
  // 8.500 + 5.000 = 13.500.
  agregarMovimiento(h, {
    ddmm: '15-06',
    concepto: 'TRANSFERENCIA RECIBIDA',
    referencia: '1113',
    columna: 'credito',
    importeCent: 5_000n * CENT,
    saldoCent: 13_500n * CENT,
  });

  // m4: débito, SIN saldo (segundo punto de control abierto).
  agregarMovimiento(h, {
    ddmm: '20-06',
    concepto: 'DEBITO AUTOMATICO SEGUROS',
    referencia: '1114',
    columna: 'debito',
    importeCent: 2_000n * CENT,
  });

  // m5: débito, SIN referencia (campo opcional), CON saldo (13.500 - 2.000 - 300 = 11.200; no
  // se verifica contra m3 porque m4 no trae saldo — punto de control).
  agregarMovimiento(h, {
    ddmm: '28-06',
    concepto: 'IMPUESTO SELLOS',
    columna: 'debito',
    importeCent: 300n * CENT,
    saldoCent: 11_200n * CENT,
  });

  agregarTotales(h, 45n * CENT, 1_234n * CENT, '30/06/2026', 11_200n * CENT);

  // Bloque legal, ancho completo — tiene que caer en fueraDelCuerpo, no en residuo ni en continuación.
  h.agregar([
    { texto: 'Texto', x: X.fecha },
    { texto: 'legal', x: 120 },
    { texto: 'generico sin dato de nadie www.bcra.gob.ar', x: 320 },
  ]);

  return h.filas;
}

describe('reconoceICBC', () => {
  it('reconoce el documento por el encabezado de columnas (único literal bancario-genérico disponible, spec §1.1)', () => {
    expect(reconoceICBC(documentoLimpio())).toBe(true);
  });

  it('no reconoce un documento sin el encabezado', () => {
    const h = hoja();
    h.agregar([{ texto: 'Otro banco cualquiera', x: 400 }]);
    expect(reconoceICBC(h.filas)).toBe(false);
  });

  it('no reconoce un encabezado parecido pero incompleto (faltan columnas)', () => {
    const h = hoja();
    h.agregar([{ texto: 'FECHA CONCEPTO DEBITOS CREDITOS SALDOS', x: X.fecha }]);
    expect(reconoceICBC(h.filas)).toBe(false);
  });
});

describe('leerIcbc — camino feliz: 5 movimientos, mezcla débito/crédito, con y sin saldo por fila', () => {
  const salida = leerIcbc(documentoLimpio());

  it('arma exactamente una cuenta, con los 5 movimientos', () => {
    expect(salida.cuentas).toHaveLength(1);
    expect(salida.cuentas[0]?.movimientos).toHaveLength(5);
  });

  it('reparte débito/crédito por columna separada, en el orden correcto', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.map((x) => x.columnaOrigen)).toEqual(['debito', 'debito', 'credito', 'debito', 'debito']);
    expect(m[0]?.debito).toBe('1000.00');
    expect(m[2]?.credito).toBe('5000.00');
  });

  it('cada movimiento declara origenSigno=columna_separada (campo del paso 1 del contrato)', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.every((x) => x.origenSigno === 'columna_separada')).toBe(true);
  });

  it('el signo atrás de DEBITOS (##,##-) se lee igual que un signo adelante: importe siempre negativo, debito siempre positivo', () => {
    const m = salida.cuentas[0]?.movimientos[0];
    expect(m?.debito).toBe('1000.00');
    expect(m?.importe).toBe('-1000.00');
  });

  it('exactamente 3 de los 5 movimientos traen saldo por fila (m2, m3, m5) — el resto queda undefined, no inventado', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.map((x) => x.saldo)).toEqual([undefined, '8500.00', '13500.00', undefined, '11200.00']);
  });

  it('captura el número de COMPROBANTE como referencia tipo operacion, ausente cuando no está (m5)', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.map((x) => x.referencias?.[0]?.valor)).toEqual(['1111', '1112', '1113', '1114', undefined]);
  });

  it('captura SALDO ULTIMO EXTRACTO AL (spec §1.1) y el saldo final embebido en el bloque de totales', () => {
    expect(salida.cuentas[0]?.cuenta.saldoInicialDeclarado).toBe('10000.00');
    expect(salida.cuentas[0]?.cuenta.saldoFinalDeclarado).toBe('11200.00');
  });

  it('resuelve el período literal de carátula (PERIODO ... AL ..., guion, mayúscula)', () => {
    expect(salida.cuentas[0]?.cuenta.periodoDesde).toBe('2026-06-01');
    expect(salida.cuentas[0]?.cuenta.periodoHasta).toBe('2026-06-30');
  });

  it('declara coberturaPeriodo=completo (campo del paso 1 del contrato)', () => {
    expect(salida.cuentas[0]?.cuenta.coberturaPeriodo).toBe('completo');
  });

  it('resuelve la fecha dd-mm (sin año) contra el período — anioEnLaFecha: false', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.map((x) => x.fecha)).toEqual([
      '2026-06-01',
      '2026-06-05',
      '2026-06-15',
      '2026-06-20',
      '2026-06-28',
    ]);
  });

  it('captura el CUIT del TITULAR (nunca "del banco" — corrección del incidente #13)', () => {
    // El documento real trae el CUIT CON guiones (spec §1.1); RE_CUIT_COMPARTIDO devuelve el match
    // tal cual aparece en el texto, sin normalizar.
    expect(salida.cuentas[0]?.cuenta.titularDocumento).toBe(
      `${CUIT_SINTETICO.slice(0, 2)}-${CUIT_SINTETICO.slice(2, 10)}-${CUIT_SINTETICO.slice(10)}`,
    );
  });

  it('captura número de cuenta (formato dddd/dddddddd/dd) y CBU (partido en 8+14, unido a 22 dígitos)', () => {
    expect(salida.cuentas[0]?.cuenta.numero).toBe(NUMERO_CUENTA_SINTETICO);
    expect(salida.cuentas[0]?.cuenta.cbu).toBe(`${CBU_SINTETICO_GRUPO1}${CBU_SINTETICO_GRUPO2}`);
  });

  it('captura los dos totales del bloque como anexos, con el corte NO basado en conteo de dígitos (spec §H4.1)', () => {
    const anexos = salida.cuentas[0]?.anexos ?? [];
    expect(anexos).toHaveLength(2);
    expect(anexos[0]?.conceptoLiteral).toBe('TOT.IMP.LEY COMP.');
    expect(anexos[0]?.importeDeclarado).toBe('45.00');
    expect(anexos[1]?.conceptoLiteral).toBe('TOT.LEY COMP.$');
    expect(anexos[1]?.importeDeclarado).toBe('1234.00');
    expect(anexos.every((a) => a.relacionConMovimientos === 'no_determinada')).toBe(true);
  });

  it('NO reporta como residuo las filas de carátula (período, CUIT, número/CBU) sin movimiento abierto', () => {
    expect(salida.lineasNoInterpretadas).toHaveLength(0);
  });

  it('el bloque legal de ancho completo NO se pega a la glosa del último movimiento', () => {
    const m = salida.cuentas[0]?.movimientos[4];
    expect(m?.descripcion).not.toContain('legal');
  });

  it('hashes únicos entre los 5 movimientos', () => {
    const hashes = salida.cuentas[0]?.movimientos.map((m) => m.filaHash) ?? [];
    expect(new Set(hashes).size).toBe(5);
  });

  it('valida contra el esquema Zod completo (cuenta + movimientos + anexos)', () => {
    const cuenta = salida.cuentas[0];
    expect(cuenta && cuentaConMovimientosSchema.safeParse(cuenta).success).toBe(true);
    for (const m of cuenta?.movimientos ?? []) {
      expect(movimientoBancarioCrudoSchema.safeParse(m).success).toBe(true);
    }
    for (const a of cuenta?.anexos ?? []) {
      expect(anexoExtractoSchema.safeParse(a).success).toBe(true);
    }
  });

  it('verificarAritmetica: cuadra — el único par con saldo en las dos puntas (m2→m3) cierra, y los huecos NO cuentan como ruptura (puntos de control, spec §H3)', () => {
    const cuenta = salida.cuentas[0];
    expect(cuenta).toBeDefined();
    if (!cuenta) return;
    const v = verificarAritmetica(cuenta, {
      capacidades: CAPACIDADES_ICBC,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    expect(v.estado).toBe('cuadra');
    expect(v.filasConRuptura).toHaveLength(0);
    // V5': el último saldo (m5, 11.200,00) contra el saldo final declarado en el bloque de totales.
    expect(v.diferencias).toHaveLength(0);
  });

  it('los 3 movimientos con saldo declarado en este fixture quedan como deudor (saldoEsAcreedor: false) — los tres saldos son positivos', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.map((x) => x.saldoEsAcreedor)).toEqual([undefined, false, false, undefined, false]);
  });
});

/**
 * 🔴 Hallazgo de `qa-automation`: el único test de `verificarAritmetica` del fixture feliz solo
 * ejercita el camino "hueco no rompe" (puntos de control). Mutar `CAPACIDADES_ICBC.cadenaDeSaldos`
 * a `'no_disponible'` dejaba la suite entera en 30/30 verde — la declaración específica de ICBC
 * (`por_puntos_de_control`, spec §H3) no estaba sostenida por ningún test. Este describe cierra el
 * complemento: una ruptura REAL entre dos filas que SÍ traen saldo en las dos puntas.
 */
describe('leerIcbc — verificarAritmetica detecta una ruptura real en la cadena de puntos de control', () => {
  it('dos movimientos consecutivos con saldo en las dos puntas, pero el segundo NO es saldoAnterior+importe: no_cuadra, con la fila exacta en filasConRuptura', () => {
    const h = hoja();
    agregarEncabezado(h);
    agregarPeriodo(h, '01-06-2026', '30-06-2026');
    agregarSaldoAnterior(h, '31/05/2026', 1_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05-06',
      concepto: 'PRIMER MOVIMIENTO CON SALDO',
      referencia: '1001',
      columna: 'debito',
      importeCent: 100n * CENT,
      saldoCent: 900n * CENT, // 1.000 - 100 = 900, correcto
    });
    agregarMovimiento(h, {
      ddmm: '10-06',
      concepto: 'SEGUNDO MOVIMIENTO, SALDO ROTO A PROPOSITO',
      referencia: '1002',
      columna: 'debito',
      importeCent: 100n * CENT,
      // Debería ser 900 - 100 = 800; se declara 750 para forzar la ruptura.
      saldoCent: 750n * CENT,
    });
    const salidaRota = leerIcbc(h.filas);
    const cuenta = salidaRota.cuentas[0];
    expect(cuenta).toBeDefined();
    if (!cuenta) return;
    const v = verificarAritmetica(cuenta, {
      capacidades: CAPACIDADES_ICBC,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    expect(v.estado).toBe('no_cuadra');
    const segundoMovimiento = cuenta.movimientos[1];
    expect(v.filasConRuptura).toEqual([segundoMovimiento?.filaNumero]);
    expect(v.diferencias.some((d) => d.codigo === 'ARIT_CADENA_ROTA')).toBe(true);
  });
});

describe('leerIcbc — el XOR débito/crédito, fail-closed', () => {
  it('ninguna columna con importe: residuo importe_en_columna_desconocida, no se inventa la columna', () => {
    const h = hoja();
    agregarEncabezado(h);
    agregarPeriodo(h, '01-06-2026', '30-06-2026');
    agregarSaldoAnterior(h, '31/05/2026', 1_000n * CENT);
    h.agregar([
      { texto: '05-06', x: X.fecha },
      { texto: 'CONCEPTO SIN IMPORTE', x: X.bandaConcepto },
    ]);
    const salida = leerIcbc(h.filas);
    expect(salida.cuentas).toHaveLength(0);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'importe_en_columna_desconocida')).toBe(
      true,
    );
  });

  it('las DOS columnas con importe a la vez: mismo código de residuo, no se prioriza ninguna', () => {
    const h = hoja();
    agregarEncabezado(h);
    agregarPeriodo(h, '01-06-2026', '30-06-2026');
    agregarSaldoAnterior(h, '31/05/2026', 1_000n * CENT);
    h.agregar([
      { texto: '05-06', x: X.fecha },
      { texto: 'CONCEPTO CON LAS DOS COLUMNAS', x: X.bandaConcepto },
      enBordeDerecho(importeDebito(100n * CENT), R.debito),
      enBordeDerecho(importeAr(100n * CENT), R.credito),
    ]);
    const salida = leerIcbc(h.filas);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'importe_en_columna_desconocida')).toBe(
      true,
    );
  });
});

/**
 * 🔴 Hallazgo real, encontrado de forma independiente por `tester` Y por `qa-automation`: la
 * columna CREDITOS está medida sobre UN solo caso real (spec §H2, "sin universo de datos") — nada
 * garantiza que nunca traiga el mismo signo atrás redundante que DEBITOS. La primera versión de
 * `icbc.ts` solo tomaba valor absoluto del lado `debito`; un crédito firmado armaba
 * `credito: "-500.00"`, que viola `importeNoNegativo` del esquema, sin ningún residuo que lo
 * atrapara. Corregido: la columna CREDITOS también toma valor absoluto, simétrico a DEBITOS.
 */
describe('leerIcbc — el signo atrás también se normaliza del lado CREDITOS (regresión del hallazgo de tester/qa-automation)', () => {
  it('un crédito con signo atrás (##,##-) queda positivo en columnaOrigen=credito, nunca negativo', () => {
    const h = hoja();
    agregarEncabezado(h);
    agregarPeriodo(h, '01-06-2026', '30-06-2026');
    agregarSaldoAnterior(h, '31/05/2026', 1_000n * CENT);
    h.agregar([
      { texto: '05-06', x: X.fecha },
      { texto: 'CREDITO CON SIGNO ATRAS SINTETICO', x: X.bandaConcepto },
      // Mismo formato que `importeDebito`, pero en la ventana de CREDITOS — el caso que la spec
      // (§H2) no descarta por falta de un segundo documento real.
      enBordeDerecho(importeDebito(500n * CENT), R.credito),
      enBordeDerecho(importeAr(1_500n * CENT), R.saldo),
    ]);
    const salida = leerIcbc(h.filas);
    const m = salida.cuentas[0]?.movimientos[0];
    expect(m?.columnaOrigen).toBe('credito');
    expect(m?.credito).toBe('500.00');
    expect(m?.importe).toBe('500.00');
    expect(movimientoBancarioCrudoSchema.safeParse(m).success).toBe(true);
  });
});

describe('leerIcbc — fechas y glosas vacías, fail-closed', () => {
  it('fecha inválida: residuo fecha_ilegible, no se descarta en silencio', () => {
    const h = hoja();
    agregarEncabezado(h);
    agregarPeriodo(h, '01-06-2026', '30-06-2026');
    agregarSaldoAnterior(h, '31/05/2026', 1_000n * CENT);
    h.agregar([
      { texto: '32-13', x: X.fecha },
      { texto: 'CONCEPTO', x: X.bandaConcepto },
      enBordeDerecho(importeDebito(100n * CENT), R.debito),
    ]);
    const salida = leerIcbc(h.filas);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'fecha_ilegible')).toBe(true);
  });

  it('fecha válida sin nada de glosa: residuo columna_sin_ancla, no se arma un movimiento sin descripción', () => {
    const h = hoja();
    agregarEncabezado(h);
    agregarPeriodo(h, '01-06-2026', '30-06-2026');
    agregarSaldoAnterior(h, '31/05/2026', 1_000n * CENT);
    h.agregar([
      { texto: '05-06', x: X.fecha },
      enBordeDerecho(importeDebito(100n * CENT), R.debito),
    ]);
    const salida = leerIcbc(h.filas);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'columna_sin_ancla')).toBe(true);
  });
});

describe('leerIcbc — SALDO ULTIMO EXTRACTO AL sin importe legible, fail-closed', () => {
  it('sin importe en la ventana de saldo: residuo explícito, nunca queda "leído" en silencio', () => {
    const h = hoja();
    agregarEncabezado(h);
    h.agregar([
      { texto: 'SALDO ULTIMO', x: 204.4 },
      { texto: 'EXTRACTO AL 31/05/2026', x: 259.0 },
      // sin importe en la ventana de saldo [507,583]
    ]);
    const salida = leerIcbc(h.filas);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'fila_sin_importe')).toBe(true);
  });
});

describe('leerIcbc — bloque de totales, fail-closed contra el literal esperado', () => {
  it('si la etiqueta SALDO FINAL AL no matchea (literal distinto), la fila entera va a residuo — no se adivina el corte por conteo de dígitos', () => {
    const h = hoja();
    agregarEncabezado(h);
    agregarPeriodo(h, '01-06-2026', '30-06-2026');
    agregarSaldoAnterior(h, '31/05/2026', 1_000n * CENT);
    h.agregar([
      { texto: 'TOT.IMP.LEY COMP.:', x: 82.6 },
      { texto: importeAr(45n * CENT), x: 196.0 },
      { texto: 'TOT.LEY COMP.$', x: 242.2 },
      // Etiqueta distinta a "SALDO FINAL AL" — el regex no puede adivinar el corte por posición.
      { texto: `${importeAr(1_234n * CENT)}(*) OTRO TEXTO CUALQUIERA 30/06/2026`, x: 347.2 },
      enBordeDerecho(importeAr(1_000n * CENT), R.saldo),
    ]);
    const salida = leerIcbc(h.filas);
    expect(salida.cuentas).toHaveLength(0); // sin movimientos, no arma cuenta
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'linea_fuera_de_zona')).toBe(true);
  });

  it('el corte funciona SIN el asterisco de nota al pie — el ancla real es el literal, no el "(*)" (spec §H4.1)', () => {
    const h = hoja();
    agregarEncabezado(h);
    agregarPeriodo(h, '01-06-2026', '30-06-2026');
    agregarSaldoAnterior(h, '31/05/2026', 1_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05-06',
      concepto: 'UNICO MOVIMIENTO',
      referencia: '9999',
      columna: 'debito',
      importeCent: 100n * CENT,
      saldoCent: 900n * CENT,
    });
    h.agregar([
      { texto: 'TOT.IMP.LEY COMP.:', x: 82.6 },
      { texto: importeAr(45n * CENT), x: 196.0 },
      { texto: 'TOT.LEY COMP.$', x: 242.2 },
      // Sin "(*)" — el regex lo declara opcional.
      { texto: `${importeAr(1_234n * CENT)} SALDO FINAL AL 30/06/2026`, x: 347.2 },
      enBordeDerecho(importeAr(900n * CENT), R.saldo),
    ]);
    const salida = leerIcbc(h.filas);
    expect(salida.cuentas[0]?.anexos).toHaveLength(2);
    expect(salida.cuentas[0]?.cuenta.saldoFinalDeclarado).toBe('900.00');
  });
});

describe('leerIcbc — destinos (A2/C5)', () => {
  it('declara destinos con residuo cero en el documento limpio', () => {
    const salida = leerIcbc(documentoLimpio());
    expect(salida.destinos.sinDestino).toBe(0);
  });
});

describe('adaptadorIcbc — el objeto que consume el registro', () => {
  it('expone bancoCodigo, version y capacidades coherentes con reconoce()/leer()', () => {
    expect(adaptadorIcbc.bancoCodigo).toBe('icbc');
    expect(adaptadorIcbc.reconoce({ filas: documentoLimpio() })).toBe(true);
    expect(adaptadorIcbc.leer({ filas: documentoLimpio() }).cuentas).toHaveLength(1);
  });
});

/** Sugerencia de `code-reviewer`: un documento con movimientos pero SIN línea de PERIODO no puede
 * perder la fecha en silencio — cada movimiento tiene que caer en `fecha_ilegible`, nunca armarse
 * con una fecha inventada. */
describe('leerIcbc — sin línea de PERIODO, fail-closed', () => {
  it('sin PERIODO en la carátula, ningún movimiento con fecha dd-mm (sin año) puede resolverse: todos van a fecha_ilegible, cero cuentas', () => {
    const h = hoja();
    agregarEncabezado(h);
    // Sin agregarPeriodo(...) a propósito.
    agregarSaldoAnterior(h, '31/05/2026', 1_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05-06',
      concepto: 'MOVIMIENTO SIN PERIODO EN LA CARATULA',
      referencia: '2001',
      columna: 'debito',
      importeCent: 100n * CENT,
    });
    const salida = leerIcbc(h.filas);
    expect(salida.cuentas).toHaveLength(0);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'fecha_ilegible')).toBe(true);
  });
});

/** Sugerencia de `qa-automation`: `lineasNoInterpretadas` no solo tiene que traer el código
 * esperado — tiene que ser, cada una, un `LineaNoInterpretada` válido contra el esquema Zod
 * completo (forma enmascarada, página positiva, índice no negativo). */
describe('leerIcbc — cada entrada de lineasNoInterpretadas valida contra el esquema Zod', () => {
  it('los 5 códigos de residuo que este adapter puede emitir producen objetos válidos', () => {
    const h = hoja();
    agregarEncabezado(h);
    agregarPeriodo(h, '01-06-2026', '30-06-2026');
    // fila_sin_importe: SALDO ULTIMO sin importe en la ventana.
    h.agregar([
      { texto: 'SALDO ULTIMO', x: 204.4 },
      { texto: 'EXTRACTO AL 31/05/2026', x: 259.0 },
    ]);
    // importe_en_columna_desconocida: ninguna columna con importe.
    h.agregar([
      { texto: '05-06', x: X.fecha },
      { texto: 'SIN IMPORTE', x: X.bandaConcepto },
    ]);
    // fecha_ilegible.
    h.agregar([
      { texto: '32-13', x: X.fecha },
      { texto: 'FECHA INVALIDA', x: X.bandaConcepto },
      enBordeDerecho(importeDebito(100n * CENT), R.debito),
    ]);
    // columna_sin_ancla: fecha válida, sin glosa.
    h.agregar([{ texto: '06-06', x: X.fecha }, enBordeDerecho(importeDebito(100n * CENT), R.debito)]);
    // linea_fuera_de_zona: etiqueta de totales que no matchea el literal de SALDO FINAL AL.
    h.agregar([
      { texto: 'TOT.IMP.LEY COMP.:', x: 82.6 },
      { texto: importeAr(45n * CENT), x: 196.0 },
      { texto: 'TOT.LEY COMP.$', x: 242.2 },
      { texto: `${importeAr(1_234n * CENT)} ETIQUETA DISTINTA`, x: 347.2 },
      enBordeDerecho(importeAr(100n * CENT), R.saldo),
    ]);

    const salida = leerIcbc(h.filas);
    const codigos = salida.lineasNoInterpretadas.map((l) => l.codigo);
    expect(new Set(codigos)).toEqual(
      new Set([
        'fila_sin_importe',
        'importe_en_columna_desconocida',
        'fecha_ilegible',
        'columna_sin_ancla',
        'linea_fuera_de_zona',
      ]),
    );
    for (const l of salida.lineasNoInterpretadas) {
      expect(lineaNoInterpretadaSchema.safeParse(l).success).toBe(true);
    }
  });
});
