/**
 * ADAPTADOR BANCOR — contra fixture SINTÉTICO, nunca contra el PDF real (`docs/diseno/20-formato-
 * bancor.md`). Coordenadas literales medidas del archivo real; texto, importes, CUIT y CBU inventados.
 *
 * Tres cosas que este banco necesita probar y que los tres adapters anteriores no ejercitan:
 * 1. **El signo se deriva de la cadena de saldos**, nunca de una columna o un token — así que el test
 *    central no es "el importe se leyó bien", es "el crédito/débito salió del delta correcto".
 * 2. **Una fila sin saldo anterior contra el que comparar, o una fila cuya cadena no cierra en ninguna
 *    dirección, se reporta y NO se inventa** — fail-closed, con la fila excluida de `movimientos`.
 * 3. **Un renglón sin la forma de una continuación (pie legal, carátula de otra página) no se pega a la
 *    glosa del último movimiento** — el bug que motivó la revisión de `tech-lead` sobre el primer
 *    borrador de este adapter.
 */

import { describe, expect, it } from 'vitest';
import {
  adaptadorBancor,
  CAPACIDADES_BANCOR,
  leerBancor,
  reconoceBancor,
  verificarTotalesBancor,
} from '../src/adaptadores/bancor.ts';
import { verificarAritmetica } from '../src/verificacion/invariantes.ts';
import {
  anexoExtractoSchema,
  cuentaConMovimientosSchema,
  movimientoBancarioCrudoSchema,
} from '../src/esquema.ts';
import type { FilaGeometrica } from '../src/texto-pdf.ts';

// -----------------------------------------------------------------------------
// Geometría literal de la especificación (docs/diseno/20-formato-bancor.md §3)
// -----------------------------------------------------------------------------

const X = {
  fecha: 88.0,
  concepto: 172.2,
  referencia: 265.0,
} as const;

// Bordes derechos REALES, medidos contra las 186 filas del documento completo (no la primera pasada,
// que había anotado el borde izquierdo por error — ver la nota de `COLUMNAS` en `bancor.ts`).
const R = {
  importe: 420.9,
  saldo: 576.8,
} as const;

/**
 * Identificador sintético con dígito verificador INVÁLIDO a propósito — un verificador válido podría
 * pertenecerle a un contribuyente real (regla dura de `seguridad-datos-financieros`). Mismo valor que ya
 * usa `macro.test.ts` (`CUIT_INVENTADO`), verificado inválido contra `verificadorCuitEsValido`.
 *
 * 🔴 Hallazgo de `qa-automation`: el candidato original de este archivo (`20999999999`) tenía verificador
 * VÁLIDO — corregido acá.
 */
const CUIT_SINTETICO = '30000000000';

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
  pagina(n: number): void;
  agregar(fragmentos: readonly FragmentoDePrueba[]): void;
} {
  const filas: FilaGeometrica[] = [];
  let paginaActual = 1;
  let y = 800;
  return {
    filas,
    pagina(n: number): void {
      paginaActual = n;
      y = 800;
    },
    agregar(fragmentos: readonly FragmentoDePrueba[]): void {
      filas.push(filaGeometrica(fragmentos, paginaActual, y));
      y -= 12;
    },
  };
}

function conSeparadorDeMiles(entero: string): string {
  return entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Centavos → forma argentina (`1.234,56`), sin `$`. */
function importeAr(centavos: bigint): string {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  const entero = (abs / 100n).toString();
  const dec = (abs % 100n).toString().padStart(2, '0');
  return `${negativo ? '-' : ''}${conSeparadorDeMiles(entero)},${dec}`;
}

const CENT = 100n;

/** Sintéticos: forma real medida (`NNNNN/NN`, 22 dígitos), valores inventados. */
const NUMERO_CUENTA_SINTETICO = '99999/99';
const CBU_SINTETICO = '9990000090000000000001'; // mismo patrón ya usado en santander.test.ts

/** Carátula común a todos los fixtures: letterhead + CUIT del titular + período + número + CBU. */
function agregarCaratula(h: ReturnType<typeof hoja>, desde: string, hasta: string): void {
  h.agregar([{ texto: 'Banco de la Provincia de Córdoba S.A.', x: 400 }]);
  h.agregar([{ texto: 'www.bancor.com.ar', x: 400 }]);
  h.agregar([{ texto: 'C.U.I.T. 30-99999999-9 - Responsable Inscripto', x: 380 }]);
  h.agregar([{ texto: 'Concepto sintetico S.A.', x: X.concepto }]);
  h.agregar([{ texto: CUIT_SINTETICO, x: 193.3 }]);
  h.agregar([{ texto: 'TITULAR', x: 193.3 }]);
  // Misma fila geométrica que el período, spec §2 — número de cuenta sin etiqueta propia, por forma.
  h.agregar([
    { texto: desde, x: 121.7 },
    { texto: hasta, x: 176.5 },
    { texto: NUMERO_CUENTA_SINTETICO, x: 311.3 },
    { texto: 'BANCA', x: 467.2 },
    { texto: 'DE', x: 492.5 },
    { texto: 'EMPRESAS', x: 505.1 },
  ]);
  // CBU en su propia fila, sin etiqueta propia, justo antes de RESPONSABLE INSCRIPTO — spec §2.
  h.agregar([
    { texto: CBU_SINTETICO, x: 130.1 },
    { texto: 'RESPONSABLE', x: 260.7 },
    { texto: 'INSCRIPTO', x: 311.3 },
  ]);
}

function agregarSaldoAnterior(h: ReturnType<typeof hoja>, saldoCent: bigint): void {
  h.agregar([{ texto: `SALDO RES. ANTERIOR ${importeAr(saldoCent)}`, x: X.concepto }]);
}

function agregarMovimiento(
  h: ReturnType<typeof hoja>,
  opciones: {
    readonly ddmm: string;
    readonly concepto: string;
    readonly referencia?: string;
    readonly importeCent: bigint;
    readonly saldoCent: bigint;
  },
): void {
  h.agregar([
    { texto: opciones.ddmm, x: X.fecha },
    { texto: opciones.concepto, x: X.concepto },
    ...(opciones.referencia ? [{ texto: opciones.referencia, x: X.referencia }] : []),
    enBordeDerecho(importeAr(opciones.importeCent), R.importe),
    enBordeDerecho(importeAr(opciones.saldoCent), R.saldo),
  ]);
}

// -----------------------------------------------------------------------------
// Fixture "limpio": 4 movimientos, cadena completa, 2 créditos + 2 débitos
// -----------------------------------------------------------------------------

function documentoLimpio(): readonly FilaGeometrica[] {
  const h = hoja();
  h.pagina(1);
  agregarCaratula(h, '01/06/2026', '30/06/2026');
  agregarSaldoAnterior(h, 10_000n * CENT);

  agregarMovimiento(h, {
    ddmm: '05/06',
    concepto: 'Concepto sintetico 1',
    referencia: '111111',
    importeCent: 1_000n * CENT,
    saldoCent: 11_000n * CENT, // 10.000 + 1.000 → crédito
  });
  // Continuación del movimiento 1: forma medida (11 dígitos + guion + palabras), spec §4.
  h.agregar([{ texto: '11111111111 - REFERENCIA EXTRA', x: X.concepto }]);

  agregarMovimiento(h, {
    ddmm: '06/06',
    concepto: 'Concepto sintetico 2',
    referencia: '222222',
    importeCent: 500n * CENT,
    saldoCent: 10_500n * CENT, // 11.000 − 500 → débito
  });

  agregarMovimiento(h, {
    ddmm: '07/06',
    concepto: 'Concepto sintetico 3',
    referencia: '333333',
    importeCent: 200n * CENT,
    saldoCent: 10_700n * CENT, // 10.500 + 200 → crédito
  });

  agregarMovimiento(h, {
    ddmm: '08/06',
    concepto: 'Concepto sintetico 4',
    referencia: '444444',
    importeCent: 15_000n * CENT,
    saldoCent: -4_300n * CENT, // 10.700 − 15.000 → débito, descubierto
  });

  h.agregar([{ texto: 'Total Comisión Mantenimiento:', x: 45.8 }, { texto: '$100,00', x: 252.3 }]);
  h.agregar([{ texto: '-', x: 10.0 }]);
  h.agregar([{ texto: 'Texto de ejemplo del pie legal, banco-generico, sin dato de nadie.', x: 43.9 }]);

  return h.filas;
}

describe('reconoceBancor', () => {
  it('reconoce el documento con las dos marcas del letterhead', () => {
    expect(reconoceBancor(documentoLimpio())).toBe(true);
  });

  it('no reconoce un documento sin las marcas', () => {
    const h = hoja();
    h.agregar([{ texto: 'Otro banco cualquiera', x: 400 }]);
    expect(reconoceBancor(h.filas)).toBe(false);
  });
});

describe('leerBancor — cadena de saldos deriva el signo', () => {
  const salida = leerBancor(documentoLimpio());

  it('arma exactamente una cuenta, con los 4 movimientos', () => {
    expect(salida.cuentas).toHaveLength(1);
    expect(salida.cuentas[0]?.movimientos).toHaveLength(4);
  });

  it('reparte 2 créditos y 2 débitos EN EL ORDEN CORRECTO — no solo el conteo, que un swap simétrico no rompe', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.map((x) => x.columnaOrigen)).toEqual(['credito', 'debito', 'credito', 'debito']);
    expect(m[0]?.credito).toBe('1000.00');
    expect(m[1]?.debito).toBe('500.00');
  });

  it('el movimiento 4 queda marcado como descubierto (saldo negativo)', () => {
    const m = salida.cuentas[0]?.movimientos[3];
    expect(m?.saldoEsAcreedor).toBe(true);
    expect(m?.saldo).toBe('-4300.00');
  });

  it('absorbe la línea de continuación en la descripción del movimiento 1', () => {
    const m = salida.cuentas[0]?.movimientos[0];
    expect(m?.descripcion).toContain('Concepto sintetico 1');
    expect(m?.descripcion).toContain('11111111111 - REFERENCIA EXTRA');
  });

  it('NO pega el pie legal a la glosa del último movimiento (el bug que motivó la revisión de diseño)', () => {
    const m = salida.cuentas[0]?.movimientos[3];
    expect(m?.descripcion).not.toContain('pie legal');
  });

  it('una etiqueta de totales DESCONOCIDA (no una de las 9 confirmadas) va a lineasNoInterpretadas, no se descarta ni se cuenta como movimiento', () => {
    // El fixture usa "Total Comisión Mantenimiento:", que no es ninguna de las 9 etiquetas reales
    // confirmadas por JP (spec §6) — tiene que caer al residuo genérico, no inventarse un anexo.
    const total = salida.lineasNoInterpretadas.find((l) => l.codigo === 'linea_fuera_de_zona');
    expect(total).toBeDefined();
    expect(salida.cuentas[0]?.movimientos).toHaveLength(4);
    expect(salida.cuentas[0]?.anexos).toHaveLength(0);
  });

  it('resuelve el período de carátula y lo usa para completar el año de cada fecha', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(salida.cuentas[0]?.cuenta.periodoDesde).toBe('2026-06-01');
    expect(m.every((x) => x.fecha.startsWith('2026-06'))).toBe(true);
  });

  it('captura el CUIT del titular anclado a la etiqueta TITULAR', () => {
    expect(salida.cuentas[0]?.cuenta.titularDocumento).toBe(CUIT_SINTETICO);
  });

  /**
   * Hallazgo real de la corrida contra el PDF real (no del fixture): sin `numero`/`cbu`, el lote parseaba
   * perfecto pero `resolverCuentaDelExtracto` (INV-6) lo habría rechazado igual — el CUIT del titular no
   * alcanza. Este test es la red para que no vuelva a pasar en silencio.
   */
  it('captura número de cuenta y CBU de la carátula — sin esto, INV-6 rechazaría el lote', () => {
    const cuenta = salida.cuentas[0]?.cuenta;
    expect(cuenta?.numero).toBe(NUMERO_CUENTA_SINTETICO);
    expect(cuenta?.cbu).toBe(CBU_SINTETICO);
    expect(cuenta?.numero !== undefined || cuenta?.cbu !== undefined).toBe(true);
  });

  it('declara destinos completos: ninguna fila queda sin clasificar', () => {
    expect(salida.destinos?.sinDestino).toBe(0);
    expect(salida.destinos?.total).toBe(documentoLimpio().length);
  });

  it('verificarAritmetica: cuadra, con V1/V5 tautológicos (la cadena es la fuente del signo, no una segunda señal)', () => {
    const cuenta = salida.cuentas[0];
    if (!cuenta) throw new Error('fixture sin cuenta');
    const v = verificarAritmetica(cuenta, {
      capacidades: CAPACIDADES_BANCOR,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    expect(v.estado).toBe('cuadra');
    expect(v.filasConRuptura).toHaveLength(0);
  });

  it('cada movimiento tiene hash único dentro de la cuenta', () => {
    const hashes = new Set((salida.cuentas[0]?.movimientos ?? []).map((m) => m.filaHash));
    expect(hashes.size).toBe(4);
  });

  /**
   * Hallazgo de `code-reviewer`: sin este test, un movimiento con `descripcionLineas: []` /
   * `descripcion: ''` habría pasado los 20 tests de arriba en verde — nada más en la suite corre el
   * `.parse()` del esquema. Mismo patrón que ya usan `macro.test.ts`/`santander.test.ts`.
   */
  it('cada movimiento y cada cuenta producidos validan contra el esquema Zod', () => {
    for (const m of salida.cuentas.flatMap((c) => c.movimientos)) {
      expect(() => movimientoBancarioCrudoSchema.parse(m)).not.toThrow();
    }
    for (const cuenta of salida.cuentas) {
      expect(() => cuentaConMovimientosSchema.parse(cuenta)).not.toThrow();
    }
  });
});

describe('leerBancor — fail-closed: hallazgos de code-reviewer/tester sobre el primer borrador', () => {
  it('una fila con importe y saldo válidos pero SIN concepto se reporta, no se emite un movimiento con descripción vacía', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);
    // Fila de movimiento sin fragmento en la banda de concepto (spec: `glosaDe` no encuentra nada).
    h.agregar([
      { texto: '05/06', x: X.fecha },
      enBordeDerecho(importeAr(1_000n * CENT), R.importe),
      enBordeDerecho(importeAr(11_000n * CENT), R.saldo),
    ]);

    const salida = leerBancor(h.filas);
    expect(salida.cuentas).toHaveLength(0); // el único movimiento del archivo quedó excluido
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'columna_sin_ancla')).toBe(true);
    // Ningún movimiento con forma inválida llegó a construirse.
    for (const l of salida.lineasNoInterpretadas) {
      expect(l.codigo).not.toBe('desconocido');
    }
  });

  it('una fecha decoy en la misma fila del período no lo confunde: se ignora la fila ambigua y se toma el período real', () => {
    const h = hoja();
    h.pagina(1);
    h.agregar([{ texto: 'Banco de la Provincia de Córdoba S.A.', x: 400 }]);
    h.agregar([{ texto: 'www.bancor.com.ar', x: 400 }]);
    // Fila con TRES fechas — el período no puede ser esta fila: se ignora, no se toman las dos primeras.
    h.agregar([
      { texto: '15/07/2026', x: 100 },
      { texto: '01/06/2026', x: 150 },
      { texto: '30/06/2026', x: 200 },
    ]);
    h.agregar([{ texto: CUIT_SINTETICO, x: 193.3 }]);
    h.agregar([{ texto: 'TITULAR', x: 193.3 }]);
    // La fila real del período, con exactamente dos fechas.
    h.agregar([{ texto: '01/06/2026', x: 121.7 }, { texto: '30/06/2026', x: 176.5 }]);
    agregarSaldoAnterior(h, 10_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'Concepto sintetico 1',
      importeCent: 1_000n * CENT,
      saldoCent: 11_000n * CENT,
    });

    const salida = leerBancor(h.filas);
    expect(salida.cuentas[0]?.cuenta.periodoDesde).toBe('2026-06-01');
    expect(salida.cuentas[0]?.cuenta.periodoHasta).toBe('2026-06-30');
    expect(salida.cuentas[0]?.movimientos[0]?.fecha).toBe('2026-06-05');
  });

  it('un `$importe` dentro del CONCEPTO de un movimiento legítimo no lo hace desaparecer como bloque de totales', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'TRANSF RECIBIDA $1.234,56 REF',
      importeCent: 1_000n * CENT,
      saldoCent: 11_000n * CENT,
    });

    const salida = leerBancor(h.filas);
    expect(salida.cuentas[0]?.movimientos).toHaveLength(1);
    expect(salida.cuentas[0]?.movimientos[0]?.descripcion).toContain('TRANSF RECIBIDA');
  });

  it('una línea con FORMA de continuación pero sin movimiento abierto se reporta, no se pierde en fueraDelCuerpo', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    // Ninguna fila de "SALDO RES. ANTERIOR" ni movimiento todavía: esta línea de forma "continuación"
    // llega sin nada que la preceda.
    h.agregar([{ texto: '11111111111 - HUERFANA', x: X.concepto }]);

    const salida = leerBancor(h.filas);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'linea_fuera_de_zona')).toBe(true);
  });

  it('el ruido (letterhead de la página siguiente) SÍ cierra el movimiento abierto, sin bloque de totales de por medio', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'Concepto sintetico 1',
      importeCent: 1_000n * CENT,
      saldoCent: 11_000n * CENT,
    });
    // Salto de página: el letterhead se repite ANTES de cualquier separador/bloque de totales.
    h.pagina(2);
    h.agregar([{ texto: 'Banco de la Provincia de Córdoba S.A.', x: 400 }]);
    // Fila con FORMA de continuación, pero DESPUÉS del ruido: si el ruido no cerrara el movimiento 1,
    // esto se pegaría a su glosa por error — es exactamente lo que este test tiene que atrapar.
    h.agregar([{ texto: '99999999999 - NO ES DEL MOVIMIENTO 1', x: X.concepto }]);
    agregarMovimiento(h, {
      ddmm: '06/06',
      concepto: 'Concepto sintetico 2',
      importeCent: 500n * CENT,
      saldoCent: 10_500n * CENT,
    });

    const salida = leerBancor(h.filas);
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m).toHaveLength(2);
    // El letterhead de la página 2 NO quedó pegado a la glosa del movimiento 1.
    expect(m[0]?.descripcion).not.toContain('Banco de la Provincia');
    // Ni la línea de forma-continuación posterior al ruido: el movimiento 1 ya estaba cerrado.
    expect(m[0]?.descripcion).not.toContain('NO ES DEL MOVIMIENTO 1');
    // Y esa línea huérfana se reporta, no se pierde en `fueraDelCuerpo`.
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'linea_fuera_de_zona')).toBe(true);
  });

  it('una línea que arranca con 2 a 4 dígitos (fuera de la forma de continuación) cierra el movimiento en vez de absorberse', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'Concepto sintetico 1',
      importeCent: 1_000n * CENT,
      saldoCent: 11_000n * CENT,
    });
    // Forma medida de continuación exige 5+ dígitos (spec §4): esto NO califica.
    h.agregar([{ texto: '1234 texto corto', x: X.concepto }]);

    const salida = leerBancor(h.filas);
    const m = salida.cuentas[0]?.movimientos[0];
    expect(m?.descripcion).not.toContain('1234');
  });

  it('un importe negativo leído en la columna de importe se rechaza (la columna nunca trae signo en este banco)', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);
    h.agregar([
      { texto: '05/06', x: X.fecha },
      { texto: 'Concepto sintetico 1', x: X.concepto },
      enBordeDerecho(`-${importeAr(1_000n * CENT)}`, R.importe),
      enBordeDerecho(importeAr(11_000n * CENT), R.saldo),
    ]);

    const salida = leerBancor(h.filas);
    expect(salida.cuentas).toHaveLength(0);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'fila_sin_importe')).toBe(true);
  });

  it('un importe CERO no se clasifica arbitrariamente como crédito: se reporta indeterminado', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'Concepto sintetico 1',
      importeCent: 0n,
      saldoCent: 10_000n * CENT, // sin efecto en el saldo
    });

    const salida = leerBancor(h.filas);
    expect(salida.cuentas).toHaveLength(0);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'importe_en_columna_desconocida')).toBe(
      true,
    );
  });
});

/**
 * Las 9 etiquetas reales del bloque de totales de Bancor (spec §6) — confirmadas por JP mirando el
 * documento completo, no leídas por ningún agente. Vocabulario bancario genérico (nombre de tributo o
 * régimen de retención), mismo criterio N0 que el resto del léxico de concepto.
 */
function agregarBloqueDeTotales(h: ReturnType<typeof hoja>): void {
  const filas: readonly [string, string][] = [
    ['Total Impuesto al Valor Agregado', '$1.234,56'],
    ['Total Imp.Ley de Competitividad', '$2.500,00'],
    ['Total Imp.L.Competitiv. Credito Compensable', '$0.00'],
    ['Total SIRCREB', '$0.00'],
    ['Total SIRCREB CBA', '$300,00'],
    ['Total SIRCREB C.A.B.A.', '$0.00'],
    ['Total SIRCREB Sta. Fe.', '$0.00'],
    ['Total Percepciones C.A.B.A.', '$0.00'],
    ['Total Percepciones por consumos en el exterior', '$50,00'],
  ];
  for (const [etiqueta, importe] of filas) {
    h.agregar([{ texto: `${etiqueta}:`, x: 45.8 }, { texto: importe, x: 252.3 }]);
  }
}

describe('leerBancor — bloque de totales (spec §6, 9 etiquetas confirmadas por JP)', () => {
  function documentoConTotales(): readonly FilaGeometrica[] {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'Concepto sintetico 1',
      importeCent: 1_000n * CENT,
      saldoCent: 11_000n * CENT,
    });
    agregarBloqueDeTotales(h);
    h.agregar([{ texto: '-', x: 10.0 }]);
    return h.filas;
  }

  it('las 9 líneas se reconocen y van a anexos[], no a lineasNoInterpretadas', () => {
    const salida = leerBancor(documentoConTotales());
    const anexos = salida.cuentas[0]?.anexos ?? [];
    expect(anexos).toHaveLength(9);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'linea_fuera_de_zona')).toBe(false);
  });

  it('acepta los DOS formatos de importe dentro del mismo bloque — coma decimal Y punto decimal', () => {
    const anexos = leerBancor(documentoConTotales()).cuentas[0]?.anexos ?? [];
    const conComa = anexos.find((a) => a.conceptoLiteral === 'Total Impuesto al Valor Agregado');
    const conPunto = anexos.find((a) => a.conceptoLiteral === 'Total SIRCREB');
    expect(conComa?.importeDeclarado).toBe('1234.56');
    expect(conPunto?.importeDeclarado).toBe('0.00');
  });

  it('cada anexo valida contra el esquema Zod, con la relación declarada por etiqueta', () => {
    const anexos = leerBancor(documentoConTotales()).cuentas[0]?.anexos ?? [];
    for (const a of anexos) {
      expect(() => anexoExtractoSchema.parse(a)).not.toThrow();
    }
    const sircrebCba = anexos.find((a) => a.conceptoLiteral === 'Total SIRCREB CBA');
    expect(sircrebCba?.relacionConMovimientos).toBe('resume_movimientos_del_cuerpo');
    const percepciones = anexos.find((a) => a.conceptoLiteral === 'Total Percepciones C.A.B.A.');
    expect(percepciones?.relacionConMovimientos).toBe('no_determinada');
  });

  it('no confunde "Total SIRCREB" (sola) con "Total SIRCREB CBA"/"C.A.B.A."/"Sta. Fe."', () => {
    const anexos = leerBancor(documentoConTotales()).cuentas[0]?.anexos ?? [];
    const literales = anexos.map((a) => a.conceptoLiteral);
    expect(literales).toContain('Total SIRCREB');
    expect(literales).toContain('Total SIRCREB CBA');
    expect(literales).toContain('Total SIRCREB C.A.B.A.');
    expect(literales).toContain('Total SIRCREB Sta. Fe.');
    expect(new Set(literales).size).toBe(9); // las 9, sin duplicados ni colisiones
  });
});

describe('verificarTotalesBancor — cruce opcional (spec §6.1)', () => {
  it('cierra: la suma de RECAU.SIRCREB CBA coincide con el anexo declarado', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'RECAU.SIRCREB CBA',
      importeCent: 300n * CENT,
      saldoCent: 10_300n * CENT,
    });
    h.agregar([{ texto: 'Total SIRCREB CBA:', x: 45.8 }, { texto: '$300,00', x: 252.3 }]);

    const cuenta = leerBancor(h.filas).cuentas[0];
    if (!cuenta) throw new Error('fixture sin cuenta');
    const [resultado] = verificarTotalesBancor(cuenta);
    expect(resultado?.coincide).toBe(true);
    expect(resultado?.declarado).toBe('300.00');
    expect(resultado?.calculado).toBe('300.00');
  });

  it('NO cierra: reporta la diferencia, nunca la fuerza a cuadrar', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);
    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'RECAU.SIRCREB CBA',
      importeCent: 300n * CENT,
      saldoCent: 10_300n * CENT,
    });
    // El anexo declara 350, pero el cuerpo solo trae 300 de SIRCREB CBA.
    h.agregar([{ texto: 'Total SIRCREB CBA:', x: 45.8 }, { texto: '$350,00', x: 252.3 }]);

    const cuenta = leerBancor(h.filas).cuentas[0];
    if (!cuenta) throw new Error('fixture sin cuenta');
    const [resultado] = verificarTotalesBancor(cuenta);
    expect(resultado?.coincide).toBe(false);
    expect(resultado?.declarado).toBe('350.00');
    expect(resultado?.calculado).toBe('300.00');
  });

  it('sin anexo con ese conceptoLiteral, no hay resultado para ese cruce (no se inventa)', () => {
    const cuenta = leerBancor(documentoLimpio()).cuentas[0];
    if (!cuenta) throw new Error('fixture sin cuenta');
    expect(verificarTotalesBancor(cuenta)).toHaveLength(0);
  });
});

describe('leerBancor — fail-closed: la cadena no cierra, o no hay de qué derivar', () => {
  it('un movimiento antes de "SALDO RES. ANTERIOR" se reporta, no se inventa el signo', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    // Sin agregarSaldoAnterior: el primer movimiento llega sin saldo del que derivar el signo.
    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'Concepto sintetico 1',
      importeCent: 1_000n * CENT,
      saldoCent: 11_000n * CENT,
    });

    const salida = leerBancor(h.filas);
    expect(salida.cuentas).toHaveLength(0);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'fila_sin_importe')).toBe(true);
  });

  it('una fila cuyo delta no coincide con el importe en ninguna dirección queda excluida, y la cadena sigue desde SU saldo', () => {
    const h = hoja();
    h.pagina(1);
    agregarCaratula(h, '01/06/2026', '30/06/2026');
    agregarSaldoAnterior(h, 10_000n * CENT);

    agregarMovimiento(h, {
      ddmm: '05/06',
      concepto: 'Concepto sintetico 1',
      importeCent: 1_000n * CENT,
      saldoCent: 11_000n * CENT, // cierra: crédito
    });
    agregarMovimiento(h, {
      ddmm: '06/06',
      concepto: 'Concepto ilegible',
      importeCent: 500n * CENT,
      saldoCent: 50_000n * CENT, // no cierra en ninguna dirección contra 11.000
    });
    agregarMovimiento(h, {
      ddmm: '07/06',
      concepto: 'Concepto sintetico 3',
      importeCent: 1_000n * CENT,
      saldoCent: 51_000n * CENT, // cierra CONTRA el saldo de la fila anterior (50.000), no contra 11.000
    });

    const salida = leerBancor(h.filas);
    const movimientos = salida.cuentas[0]?.movimientos ?? [];
    expect(movimientos).toHaveLength(2); // la fila del medio queda afuera
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'importe_en_columna_desconocida')).toBe(
      true,
    );
    expect(movimientos[1]?.saldo).toBe('51000.00');
  });
});

describe('CAPACIDADES_BANCOR', () => {
  it('declara el signo derivado de la cadena, nunca publicado', () => {
    expect(CAPACIDADES_BANCOR.traeSignoEnElImporte).toBe(false);
    expect(CAPACIDADES_BANCOR.cadenaDeSaldos).toBe('completa');
  });

  it('no promete totales declarados (el bloque final no tiene literal confirmado)', () => {
    expect(CAPACIDADES_BANCOR.traeTotalesDeclarados).toBe(false);
  });

  it('declara destinos, mismo contrato que los tres adapters existentes', () => {
    expect(CAPACIDADES_BANCOR.declaraDestinos).toBe(true);
  });

  it('familiaLayout es ancho-fijo, no columnas-posicionales', () => {
    expect(CAPACIDADES_BANCOR.familiaLayout).toBe('ancho-fijo');
  });
});

describe('adaptadorBancor — contrato del registro', () => {
  it('leer()/reconoce() aceptan la forma EntradaDeAdaptador ({ filas }), no el arreglo pelado', () => {
    const filas = documentoLimpio();
    expect(adaptadorBancor.reconoce({ filas })).toBe(true);
    const salida = adaptadorBancor.leer({ filas });
    expect(salida.cuentas).toHaveLength(1);
  });

  it('bancoCodigo y version están declarados', () => {
    expect(adaptadorBancor.bancoCodigo).toBe('bancor');
    expect(adaptadorBancor.version).toBe(1);
  });
});
