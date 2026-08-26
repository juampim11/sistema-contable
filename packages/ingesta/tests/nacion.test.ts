/**
 * ADAPTADOR NACIÓN — contra fixture SINTÉTICO, nunca contra el PDF real (`docs/diseno/21-formato-
 * nacion.md`). Coordenadas literales medidas del archivo real; texto, importes, CUIT y CBU
 * inventados.
 *
 * 🔴 El documento real mide UN SOLO movimiento (spec §0) — este fixture inventa varios escenarios
 * que el documento real no ejercita, con la MISMA geometría medida:
 * 1. Múltiples movimientos, mezcla de débito y crédito (el real es un débito único).
 * 2. Un concepto LARGO que se fusiona con la fecha en el primer fragmento y sigue en fragmentos
 *    adicionales de la misma banda — el real fusiona un concepto corto, sin poder confirmar si eso
 *    generaliza (spec §4, "no se declara sistemático").
 * 3. Una continuación de glosa en una fila separada (el real no tiene ninguna).
 * 4. Los dos códigos de residuo del XOR débito/crédito (ninguna columna, o las dos).
 * 5. Que una fila de carátula angosta (sin `$`, sin movimiento abierto) NO se reporte como residuo —
 *    regresión directa de la fila 5 del documento real (spec §8).
 */

import { describe, expect, it } from 'vitest';
import {
  adaptadorNacion,
  CAPACIDADES_NACION,
  leerNacion,
  reconoceNacion,
} from '../src/adaptadores/nacion.ts';
import { verificarAritmetica } from '../src/verificacion/invariantes.ts';
import {
  anexoExtractoSchema,
  cuentaConMovimientosSchema,
  movimientoBancarioCrudoSchema,
} from '../src/esquema.ts';
import type { FilaGeometrica } from '../src/texto-pdf.ts';

// -----------------------------------------------------------------------------
// Geometría literal de la especificación (docs/diseno/21-formato-nacion.md §3-4)
// -----------------------------------------------------------------------------

const X = {
  bandaConcepto: 65.1,
} as const;

// `comprobante`/`debito`/`saldo`: bordes derechos REALES, medidos contra el documento real (§4 de
// la spec, incluida la corrección de la ventana de saldo de [500,560) a [500,575)).
// `credito`: NO medido — el único movimiento real es un débito (spec §4, tabla de ventanas: "sin
// dato real"). Es un valor plausible dentro de la ventana declarada, inventado para este fixture,
// no una medición. Se corrige si un documento real con un crédito lo contradice.
const R = {
  comprobante: 290,
  debito: 380,
  credito: 480,
  saldo: 560,
} as const;

/** Mismo identificador sintético con dígito verificador INVÁLIDO que ya usa `bancor.test.ts`. */
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

/** Centavos → forma argentina (`1.234,56`), sin `$`. */
function importeAr(centavos: bigint): string {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  const entero = (abs / 100n).toString();
  const dec = (abs % 100n).toString().padStart(2, '0');
  return `${negativo ? '-' : ''}${conSeparadorDeMiles(entero)},${dec}`;
}

const CENT = 100n;

const NUMERO_CUENTA_SINTETICO = '9999999999'; // 10 dígitos, spec §2
const CBU_SINTETICO = '9990000090000000000001'; // 22 dígitos, mismo patrón que bancor.test.ts

function agregarLetterheadYCaratula(h: ReturnType<typeof hoja>, desde: string, hasta: string): void {
  h.agregar([{ texto: 'BANCO DE LA', x: 84.9 }]);
  h.agregar([{ texto: 'NACION ARGENTINA', x: 84.9 }]);
  h.agregar([{ texto: 'HOJA: 13', x: 513.0 }]);
  h.agregar([{ texto: 'CUIT 30-99999999-9 IVA RESPONSABLE INSCRIPTO', x: 84.9 }]);
  h.agregar([{ texto: 'SUC:142', x: 311.7 }]);
  // Fila de carátula angosta (nombre del titular sintético), SIN movimiento abierto — regresión de
  // la fila 5 del documento real (spec §8): no tiene que aparecer en `lineasNoInterpretadas`.
  h.agregar([{ texto: 'CONCEPTO SINTETICO S A S', x: 103.8 }]);
  h.agregar([
    { texto: 'CUIT:', x: 297.6 },
    { texto: CUIT_SINTETICO, x: 326.8 },
  ]);
  h.agregar([{ texto: `PERIODO INFORMADO: ${desde} AL ${hasta}`, x: 65.1 }]);
  h.agregar([{ texto: NUMERO_CUENTA_SINTETICO, x: 87.6 }]);
  h.agregar([{ texto: CBU_SINTETICO, x: 413.7 }]);
  h.agregar([
    { texto: 'FECHA', x: 74.7 },
    { texto: 'MOVIMIENTOS', x: 137.1 },
    { texto: 'COMPROB.', x: 242.7 },
    { texto: 'DEBITOS', x: 324.3 },
    { texto: 'CREDITOS', x: 415.5 },
    { texto: 'SALDO', x: 525.9 },
  ]);
}

function agregarSaldo(h: ReturnType<typeof hoja>, etiqueta: 'ANTERIOR' | 'FINAL', saldoCent: bigint): void {
  h.agregar([
    { texto: 'SALDO', x: 122.7 },
    { texto: etiqueta, x: 151.9 },
    enBordeDerecho(importeAr(saldoCent), R.saldo),
  ]);
}

function agregarMovimiento(
  h: ReturnType<typeof hoja>,
  opciones: {
    readonly ddmmaa: string;
    readonly conceptoPartes: readonly string[];
    readonly comprobante?: string;
    readonly columna: 'debito' | 'credito';
    readonly importeCent: bigint;
    readonly saldoCent: bigint;
  },
): void {
  const [primeraPalabra, ...resto] = opciones.conceptoPartes;
  const fusionado = `${opciones.ddmmaa} ${primeraPalabra ?? ''}`.trim();
  // Posicionamiento SECUENCIAL (no un paso fijo): el ancho por defecto de `filaGeometrica`
  // (`texto.length * 5`) hace que un paso fijo choque con la ventana de COMPROB. cuando una palabra
  // es larga — pasó en la primera versión de este fixture (`SINTETICO` caía justo en el borde
  // `x=235` y ganaba el `.find()` de `fragmentoEnVentanaDerecha` antes que el comprobante real).
  let cursor = X.bandaConcepto + fusionado.length * 5 + 5;
  const fragmentosResto = resto.map((palabra) => {
    const frag = { texto: palabra, x: cursor };
    cursor += palabra.length * 5 + 5;
    return frag;
  });
  h.agregar([
    // Fecha + arranque del concepto FUSIONADOS en un mismo fragmento — spec §4.
    { texto: fusionado, x: X.bandaConcepto },
    ...fragmentosResto,
    ...(opciones.comprobante ? [enBordeDerecho(opciones.comprobante, R.comprobante, 20)] : []),
    enBordeDerecho(
      importeAr(opciones.importeCent),
      opciones.columna === 'debito' ? R.debito : R.credito,
    ),
    enBordeDerecho(importeAr(opciones.saldoCent), R.saldo),
  ]);
}

function agregarAnexoLey25413(h: ReturnType<typeof hoja>, mes: string, importeCent: bigint): void {
  h.agregar([
    { texto: 'TOTAL', x: 65.1 },
    { texto: 'GRAV. LEY', x: 113.1 },
    { texto: '25413', x: 161.7 },
    { texto: 'DEL', x: 190.9 },
    { texto: 'MES', x: 210.3 },
    { texto: 'DE', x: 229.7 },
    { texto: mes, x: 244.3 },
    { texto: '$', x: 468.3 },
    { texto: importeAr(importeCent), x: 480 },
  ]);
}

// -----------------------------------------------------------------------------
// Fixture "limpio": 3 movimientos (2 débitos + 1 crédito), cadena de saldos consistente
// -----------------------------------------------------------------------------

function documentoLimpio(): readonly FilaGeometrica[] {
  const h = hoja();
  agregarLetterheadYCaratula(h, '29/05/2026', '30/06/2026');
  agregarSaldo(h, 'ANTERIOR', 10_000n * CENT);

  agregarMovimiento(h, {
    ddmmaa: '01/06/26',
    conceptoPartes: ['TRANSF.CRED', 'DE', 'TERCERO'],
    comprobante: '111',
    columna: 'debito',
    importeCent: 1_000n * CENT,
    saldoCent: 9_000n * CENT, // 10.000 − 1.000
  });
  // Continuación de glosa en fila separada — inventada, spec §8 (no medida contra un 2° documento).
  h.agregar([{ texto: 'DATO ADICIONAL DE LA OPERACION SINTETICA', x: 90 }]);

  agregarMovimiento(h, {
    ddmmaa: '15/06/26',
    conceptoPartes: ['ACREDITAMIENTO'],
    comprobante: '222',
    columna: 'credito',
    importeCent: 5_000n * CENT,
    saldoCent: 14_000n * CENT, // 9.000 + 5.000
  });

  agregarMovimiento(h, {
    ddmmaa: '28/06/26',
    conceptoPartes: ['DEBITO', 'AUTOMATICO'],
    comprobante: '333',
    columna: 'debito',
    importeCent: 20_000n * CENT,
    saldoCent: -6_000n * CENT, // 14.000 − 20.000 → descubierto
  });

  agregarSaldo(h, 'FINAL', -6_000n * CENT);
  agregarAnexoLey25413(h, 'JUNIO', 45n * CENT);

  // Bloque legal, ancho completo — tiene que caer en fueraDelCuerpo, no en residuo ni en continuación.
  h.agregar([
    { texto: 'Texto', x: 65.1 },
    { texto: 'legal', x: 120 },
    { texto: 'generico', x: 200 },
    { texto: 'sin dato de nadie www.bcra.gob.ar', x: 320 },
    { texto: 'fin', x: 500 },
  ]);

  return h.filas;
}

describe('reconoceNacion', () => {
  it('reconoce el documento con las dos marcas del letterhead partido en dos filas', () => {
    expect(reconoceNacion(documentoLimpio())).toBe(true);
  });

  it('no reconoce un documento sin las marcas', () => {
    const h = hoja();
    h.agregar([{ texto: 'Otro banco cualquiera', x: 400 }]);
    expect(reconoceNacion(h.filas)).toBe(false);
  });

  it('no reconoce con una sola de las dos marcas (letterhead partido: hacen falta las DOS filas)', () => {
    const h = hoja();
    h.agregar([{ texto: 'BANCO DE LA', x: 84.9 }]);
    expect(reconoceNacion(h.filas)).toBe(false);
  });
});

describe('leerNacion — camino feliz: 3 movimientos, mezcla débito/crédito', () => {
  const salida = leerNacion(documentoLimpio());

  it('arma exactamente una cuenta, con los 3 movimientos', () => {
    expect(salida.cuentas).toHaveLength(1);
    expect(salida.cuentas[0]?.movimientos).toHaveLength(3);
  });

  it('reparte débito/crédito EN EL ORDEN CORRECTO, por columna separada — no por cadena de saldos', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.map((x) => x.columnaOrigen)).toEqual(['debito', 'credito', 'debito']);
    expect(m[0]?.debito).toBe('1000.00');
    expect(m[1]?.credito).toBe('5000.00');
  });

  it('cada movimiento declara origenSigno=columna_separada (campo nuevo del contrato, paso 1)', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.every((x) => x.origenSigno === 'columna_separada')).toBe(true);
  });

  it('el concepto largo (4 fragmentos, fecha fusionada con el primero) se arma completo, sin truncar, y absorbe la continuación de fila separada (inventada, spec §8)', () => {
    const m = salida.cuentas[0]?.movimientos[0];
    expect(m?.descripcion).toBe(
      'TRANSF.CRED DE TERCERO DATO ADICIONAL DE LA OPERACION SINTETICA',
    );
  });

  it('captura el número de COMPROB. como referencia tipo operacion', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.map((x) => x.referencias?.[0]?.valor)).toEqual(['111', '222', '333']);
  });

  it('el tercer movimiento queda marcado como descubierto (saldo negativo)', () => {
    const m = salida.cuentas[0]?.movimientos[2];
    expect(m?.saldoEsAcreedor).toBe(true);
    expect(m?.saldo).toBe('-6000.00');
  });

  it('captura SALDO ANTERIOR y SALDO FINAL pese a ser DOS fragmentos (SALDO + etiqueta), spec §5', () => {
    expect(salida.cuentas[0]?.cuenta.saldoInicialDeclarado).toBe('10000.00');
    expect(salida.cuentas[0]?.cuenta.saldoFinalDeclarado).toBe('-6000.00');
  });

  it('resuelve el período literal de carátula (empieza un día antes del mes, no se fuerza)', () => {
    expect(salida.cuentas[0]?.cuenta.periodoDesde).toBe('2026-05-29');
    expect(salida.cuentas[0]?.cuenta.periodoHasta).toBe('2026-06-30');
  });

  it('declara coberturaPeriodo=completo (campo nuevo del contrato, paso 1)', () => {
    expect(salida.cuentas[0]?.cuenta.coberturaPeriodo).toBe('completo');
  });

  it('resuelve el año de 2 dígitos de cada fecha contra el período (anioEnLaFecha: true)', () => {
    const m = salida.cuentas[0]?.movimientos ?? [];
    expect(m.map((x) => x.fecha)).toEqual(['2026-06-01', '2026-06-15', '2026-06-28']);
  });

  it('captura el CUIT del titular anclado a la etiqueta CUIT: (nunca el CUIT del banco)', () => {
    expect(salida.cuentas[0]?.cuenta.titularDocumento).toBe(CUIT_SINTETICO);
  });

  it('captura número de cuenta (10 dígitos) y CBU (22 dígitos) — resoluble por INV-6', () => {
    expect(salida.cuentas[0]?.cuenta.numero).toBe(NUMERO_CUENTA_SINTETICO);
    expect(salida.cuentas[0]?.cuenta.cbu).toBe(CBU_SINTETICO);
  });

  it('captura el anexo Ley 25413 con el mes tal como lo escribe el banco, sin hardcodear el mes', () => {
    expect(salida.cuentas[0]?.anexos).toHaveLength(1);
    expect(salida.cuentas[0]?.anexos[0]?.conceptoLiteral).toBe('TOTAL GRAV. LEY 25413 DEL MES DE JUNIO');
    expect(salida.cuentas[0]?.anexos[0]?.importeDeclarado).toBe('45.00');
    expect(salida.cuentas[0]?.anexos[0]?.relacionConMovimientos).toBe('no_determinada');
  });

  it('NO reporta como residuo la fila de carátula angosta sin movimiento abierto (regresión fila 5 real, spec §8)', () => {
    const residuo = salida.lineasNoInterpretadas;
    expect(residuo.some((l) => l.codigo === 'linea_fuera_de_zona')).toBe(false);
    expect(residuo).toHaveLength(0);
  });

  it('el bloque legal de ancho completo NO se pega a la glosa del último movimiento', () => {
    const m = salida.cuentas[0]?.movimientos[2];
    expect(m?.descripcion).not.toContain('legal');
  });

  it('hashes únicos entre los 3 movimientos', () => {
    const hashes = salida.cuentas[0]?.movimientos.map((m) => m.filaHash) ?? [];
    expect(new Set(hashes).size).toBe(3);
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

  it('verificarAritmetica: cuadra — la cadena de saldos y el reparto débito/crédito cierran', () => {
    const cuenta = salida.cuentas[0];
    expect(cuenta).toBeDefined();
    if (!cuenta) return;
    const v = verificarAritmetica(cuenta, {
      capacidades: CAPACIDADES_NACION,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    expect(v.estado).toBe('cuadra');
    expect(v.filasConRuptura).toHaveLength(0);
  });
});

describe('leerNacion — el XOR débito/crédito, fail-closed', () => {
  it('ninguna columna con importe: residuo importe_en_columna_desconocida, no se inventa la columna', () => {
    const h = hoja();
    agregarLetterheadYCaratula(h, '29/05/2026', '30/06/2026');
    agregarSaldo(h, 'ANTERIOR', 1_000n * CENT);
    h.agregar([{ texto: '05/06/26 CONCEPTO SIN IMPORTE', x: X.bandaConcepto }]);
    const salida = leerNacion(h.filas);
    expect(salida.cuentas).toHaveLength(0); // sin movimientos, no arma cuenta
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'importe_en_columna_desconocida')).toBe(
      true,
    );
  });

  it('las DOS columnas con importe a la vez: mismo código de residuo, no se prioriza ninguna', () => {
    const h = hoja();
    agregarLetterheadYCaratula(h, '29/05/2026', '30/06/2026');
    agregarSaldo(h, 'ANTERIOR', 1_000n * CENT);
    h.agregar([
      { texto: '05/06/26 CONCEPTO CON LAS DOS COLUMNAS', x: X.bandaConcepto },
      enBordeDerecho(importeAr(100n * CENT), R.debito),
      enBordeDerecho(importeAr(100n * CENT), R.credito),
      enBordeDerecho(importeAr(900n * CENT), R.saldo),
    ]);
    const salida = leerNacion(h.filas);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'importe_en_columna_desconocida')).toBe(
      true,
    );
  });
});

describe('leerNacion — fechas y glosas vacías, fail-closed', () => {
  it('fecha inválida en el fragmento fusionado: residuo fecha_ilegible, no se descarta en silencio', () => {
    const h = hoja();
    agregarLetterheadYCaratula(h, '29/05/2026', '30/06/2026');
    agregarSaldo(h, 'ANTERIOR', 1_000n * CENT);
    h.agregar([
      { texto: '32/13/26 CONCEPTO', x: X.bandaConcepto },
      enBordeDerecho(importeAr(100n * CENT), R.debito),
      enBordeDerecho(importeAr(900n * CENT), R.saldo),
    ]);
    const salida = leerNacion(h.filas);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'fecha_ilegible')).toBe(true);
  });

  it('fecha válida sin nada de glosa: residuo columna_sin_ancla, no se arma un movimiento sin descripción', () => {
    const h = hoja();
    agregarLetterheadYCaratula(h, '29/05/2026', '30/06/2026');
    agregarSaldo(h, 'ANTERIOR', 1_000n * CENT);
    h.agregar([
      { texto: '05/06/26', x: X.bandaConcepto },
      enBordeDerecho(importeAr(100n * CENT), R.debito),
      enBordeDerecho(importeAr(900n * CENT), R.saldo),
    ]);
    const salida = leerNacion(h.filas);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'columna_sin_ancla')).toBe(true);
  });
});

describe('leerNacion — destinos (A2/C5)', () => {
  it('declara destinos con residuo cero en el documento limpio', () => {
    const salida = leerNacion(documentoLimpio());
    expect(salida.destinos.sinDestino).toBe(0);
  });
});

/**
 * Regresión de 3 hallazgos reales de `tester` (no cubiertos por el fixture original):
 * 1-2. Las ventanas de COMPROB./DEBITOS/CREDITOS/SALDO compartían un valor límite exacto —
 *      `fragmentoEnVentanaDerecha` es inclusiva en los dos extremos, así que un fragmento en ese
 *      límite matcheaba DOS ventanas a la vez. El caso más grave: un crédito con borde derecho en
 *      el viejo límite compartido con `saldo` **reemplazaba el saldo real en silencio** (ganaba el
 *      `.find()` por tener menor `x`), sin ningún código en `lineasNoInterpretadas` — el peor modo
 *      de falla del módulo, un número creíble y equivocado. Corregido con un margen de 2pt sin
 *      asignar entre cada ventana (`COLUMNAS` en `nacion.ts`).
 * 3. `SALDO ANTERIOR`/`SALDO FINAL` con el importe fuera de ventana no dejaba ninguna señal: la
 *    fila se marcaba igual `saldoDeclarado` (telemetría engañosa) y `lineasNoInterpretadas` quedaba
 *    vacío. Es la misma columna que ya falló una vez por esto (spec §4) — sin este guardrail,
 *    puede volver a fallar en silencio la próxima vez.
 * 4. `reconoceNacion` exigía las dos marcas del letterhead en CUALQUIER posición de las primeras 15
 *    filas, sin exigir que fueran consecutivas — un documento de OTRO banco cuyo disclaimer
 *    mencione "Banco de la Nación Argentina" como tercero, envuelto por `pdf.js` en dos filas con
 *    ese texto exacto, quedaría mal reconocido como Nación.
 */
describe('leerNacion / reconoceNacion — regresión de hallazgos de tester', () => {
  it('un importe cuyo borde derecho cae en la zona muerta entre CREDITOS y SALDO no matchea NINGUNA de las dos (antes de la corrección, un valor así habría podido matchear las dos a la vez)', () => {
    const h = hoja();
    agregarLetterheadYCaratula(h, '29/05/2026', '30/06/2026');
    agregarSaldo(h, 'ANTERIOR', 1_000n * CENT);
    h.agregar([
      { texto: '05/06/26 CONCEPTO EN ZONA MUERTA', x: X.bandaConcepto },
      enBordeDerecho(importeAr(300n * CENT), 496), // ni credito [392,495) ni saldo [497,575)
    ]);
    const salida = leerNacion(h.filas);
    expect(salida.cuentas).toHaveLength(0);
    expect(
      salida.lineasNoInterpretadas.some((l) => l.codigo === 'importe_en_columna_desconocida'),
    ).toBe(true);
  });

  it('SALDO ANTERIOR con el importe fuera de la ventana de saldo: residuo explícito, nunca queda "leído" en silencio', () => {
    const h = hoja();
    agregarLetterheadYCaratula(h, '29/05/2026', '30/06/2026');
    h.agregar([
      { texto: 'SALDO', x: 122.7 },
      { texto: 'ANTERIOR', x: 151.9 },
      enBordeDerecho(importeAr(1_000n * CENT), 620), // fuera de [497,575)
    ]);
    const salida = leerNacion(h.filas);
    expect(salida.lineasNoInterpretadas.some((l) => l.codigo === 'fila_sin_importe')).toBe(true);
  });

  it('un fragmento de concepto cuyo borde DERECHO cae en la ventana de COMPROB. no le gana al comprobante real (hallazgo de code-reviewer, distinto del de zona muerta de arriba)', () => {
    const h = hoja();
    agregarLetterheadYCaratula(h, '29/05/2026', '30/06/2026');
    agregarSaldo(h, 'ANTERIOR', 1_000n * CENT);
    h.agregar([
      { texto: '05/06/26 CONCEPTO', x: X.bandaConcepto },
      // Borde IZQUIERDO en la banda de concepto (200 < 235, cuenta como concepto), pero borde
      // DERECHO (260) cayendo DENTRO de la ventana de COMPROB. — el vector geométrico que
      // `fragmentoEnVentanaDerecha` (busca solo por borde derecho) no distinguía del comprobante
      // real. `fragmentoDeColumna` exige además borde izquierdo `>= 235`.
      { texto: 'PALABRA', x: 200, ancho: 60 },
      enBordeDerecho('999', R.comprobante, 20),
      enBordeDerecho(importeAr(500n * CENT), R.debito),
      enBordeDerecho(importeAr(500n * CENT), R.saldo),
    ]);
    const salida = leerNacion(h.filas);
    const m = salida.cuentas[0]?.movimientos[0];
    expect(m?.referencias?.[0]?.valor).toBe('999');
    expect(m?.descripcion).toBe('CONCEPTO PALABRA');
  });

  it('reconoceNacion exige las dos marcas en filas CONSECUTIVAS — no alcanza con que aparezcan sueltas en el rango', () => {
    const h = hoja();
    h.agregar([{ texto: 'Un texto cualquiera que menciona BANCO DE LA competencia', x: 65 }]);
    h.agregar([{ texto: 'algo intermedio, sin relacion', x: 65 }]);
    h.agregar([{ texto: 'y despues NACION ARGENTINA en otro contexto', x: 65 }]);
    expect(reconoceNacion(h.filas)).toBe(false);
  });
});

describe('adaptadorNacion — el objeto que consume el registro', () => {
  it('expone bancoCodigo, version y capacidades coherentes con reconoce()/leer()', () => {
    expect(adaptadorNacion.bancoCodigo).toBe('nacion');
    expect(adaptadorNacion.reconoce({ filas: documentoLimpio() })).toBe(true);
    expect(adaptadorNacion.leer({ filas: documentoLimpio() }).cuentas).toHaveLength(1);
  });
});
