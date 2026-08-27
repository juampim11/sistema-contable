/**
 * `plan-cuentas/parser.ts` — parser puro del plan de cuentas, sin base. Fixture 100% SINTÉTICO, armado
 * en memoria con `exceljs` (nunca el archivo real de ningún cliente) — cubre al menos una instancia de
 * cada tipo de anomalía real encontrado contra el archivo de Bracci Repuestos S.A.S. (HANDOFF de esta
 * tarea), para que una futura "mejora" del parser no las silencie sin que un test lo note.
 */

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  ANOMALIAS_BLOQUEANTES,
  cargarPlanDeCuentas,
  ErrorParserPlanCuentas,
  type AnomaliaPlanCuentas,
} from '../src/plan-cuentas/parser.ts';

const ENCABEZADO = ['CODIGO', 'DENOMINACION', 'NIVEL', 'RECIBE', 'SUMARIZA', 'MONETARIA'] as const;
/** Marcador de raíz del archivo real — `SUMARIZA` literal para las cuatro raíces de Bracci. */
const RAIZ = '...';

type FilaCruda = readonly [
  codigo: string,
  denominacion: string,
  nivel: number,
  recibe: boolean,
  sumariza: string,
  monetaria: boolean,
];

async function libro(
  filas: readonly FilaCruda[],
  opciones: { readonly encabezado?: readonly string[]; readonly sinHoja?: boolean } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  if (opciones.sinHoja) {
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }
  const ws = wb.addWorksheet('Hoja1');
  ws.getRow(1).getCell(1).value = 'PLAN DE CUENTAS — FIXTURE SINTÉTICO DE TEST';
  const encabezado = opciones.encabezado ?? ENCABEZADO;
  encabezado.forEach((h, i) => {
    ws.getRow(4).getCell(i + 1).value = h;
  });
  filas.forEach(([codigo, denominacion, nivel, recibe, sumariza, monetaria], idx) => {
    const row = ws.getRow(5 + idx);
    row.getCell(1).value = codigo;
    row.getCell(2).value = denominacion;
    row.getCell(3).value = nivel;
    row.getCell(4).value = recibe ? 'SI' : 'NO';
    row.getCell(5).value = sumariza;
    row.getCell(6).value = monetaria ? 'SI' : 'NO';
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function porTipo(anomalias: readonly AnomaliaPlanCuentas[], tipo: AnomaliaPlanCuentas['tipo']): readonly AnomaliaPlanCuentas[] {
  return anomalias.filter((a) => a.tipo === tipo);
}

describe('cargarPlanDeCuentas — errores estructurales, antes de cualquier anomalía de contenido', () => {
  it('🔴 sin hoja alguna → ErrorParserPlanCuentas("sin_hoja")', async () => {
    const buf = await libro([], { sinHoja: true });
    await expect(cargarPlanDeCuentas(buf)).rejects.toMatchObject({ codigo: 'sin_hoja' });
    await expect(cargarPlanDeCuentas(buf)).rejects.toBeInstanceOf(ErrorParserPlanCuentas);
  });

  it('🔴 encabezado que no matchea el esperado → "encabezado_no_reconocido"', async () => {
    const buf = await libro([['1.0.0.000', 'ACTIVO', 1, false, RAIZ, false]], {
      encabezado: ['CODIGO', 'NOMBRE', 'NIVEL', 'RECIBE', 'SUMARIZA', 'MONETARIA'],
    });
    await expect(cargarPlanDeCuentas(buf)).rejects.toMatchObject({ codigo: 'encabezado_no_reconocido' });
  });

  it('🔴 encabezado ok pero sin ninguna fila de datos → "sin_filas"', async () => {
    const buf = await libro([]);
    await expect(cargarPlanDeCuentas(buf)).rejects.toMatchObject({ codigo: 'sin_filas' });
  });
});

describe('cargarPlanDeCuentas — profundidad real por SUMARIZA (nunca por NIVEL ni por el código)', () => {
  it('la raíz (SUMARIZA="...") tiene profundidadReal=1 sin importar el NIVEL declarado', async () => {
    const buf = await libro([['1.0.0.000', 'ACTIVO', 1, false, RAIZ, false]]);
    const r = await cargarPlanDeCuentas(buf);
    expect(r.nodos[0]).toMatchObject({ codigo: '1.0.0.000', profundidadReal: 1, sumariza: null });
    expect(r.anomalias).toEqual([]);
  });

  it('cadena de 3 niveles resuelve profundidadReal correcta y no marca nivel_vs_sumariza cuando coincide', async () => {
    const buf = await libro([
      ['1.0.0.000', 'ACTIVO', 1, false, RAIZ, false],
      ['1.1.0.000', 'CAJA Y BANCOS', 2, false, '1.0.0.000', false],
      ['1.1.1.000', 'CAJA', 3, true, '1.1.0.000', true],
    ]);
    const r = await cargarPlanDeCuentas(buf);
    const porCodigo = new Map(r.nodos.map((n) => [n.codigo, n]));
    expect(porCodigo.get('1.1.1.000')?.profundidadReal).toBe(3);
    expect(porTipo(r.anomalias, 'nivel_vs_sumariza')).toEqual([]);
  });
});

describe('cargarPlanDeCuentas — un fixture combinado, una instancia de cada anomalía real de Bracci', () => {
  // Códigos elegidos para que cada rama sea independiente de las demás (una anomalía no contamina el
  // conteo de otra) — mismo criterio que separar los casos M-A1/M-A2 en mutaciones-0027.test.ts.
  const FILAS: readonly FilaCruda[] = [
    // --- raíces ---
    ['1.0.0.000', 'ACTIVO', 1, false, RAIZ, false],
    ['2.0.0.000', 'PASIVO', 1, false, RAIZ, false],

    // --- nivel_vs_sumariza: NIVEL declarado (5) no coincide con la profundidad real (4) ---
    ['1.1.0.000', 'CAJA Y BANCOS', 2, false, '1.0.0.000', false],
    ['1.1.1.000', 'CAJA', 3, true, '1.1.0.000', true],
    ['1.1.1.100', 'CAJA EN PESOS', 5, true, '1.1.1.000', true],

    // --- recibe_con_hijos: 1.1.1.000 (arriba) RECIBE=SI pero tiene a 1.1.1.100 como hijo ---
    // (ya cubierto por las tres filas de arriba: no hace falta fila aparte)

    // --- jerarquia_cruzada: el código de 1.2.1.000 sugiere colgar de 1.2.0.000, pero SUMARIZA real
    //     apunta a 1.3.0.000 — mismo patrón que 4.2.2.730/4.2.4.720 en el archivo real de Bracci ---
    ['1.2.0.000', 'BIENES DE CAMBIO', 2, false, '1.0.0.000', false],
    ['1.3.0.000', 'OTRO RUBRO DE ACTIVO', 2, false, '1.0.0.000', false],
    ['1.2.1.000', 'MERCADERIAS', 3, true, '1.3.0.000', true],

    // --- denominacion_duplicada: mismo texto en dos ramas distintas (activo/pasivo) ---
    ['1.4.0.000', 'DEUDORES VARIOS', 2, true, '1.0.0.000', true],
    ['2.1.0.000', 'PASIVO CORRIENTE', 2, false, '2.0.0.000', false],
    ['2.1.1.000', 'DEUDORES VARIOS', 3, true, '2.1.0.000', true],

    // --- denominacion_placeholder ---
    ['1.5.0.000', 'disponible', 2, true, '1.0.0.000', true],

    // --- sumariza_huerfano (bloqueante): SUMARIZA apunta a un código que no existe en el plan.
    //     NIVEL=2 a propósito: sin padre resoluble, profundidadReal cae al tratamiento de raíz (1+1=2)
    //     — con NIVEL=2 este caso queda AISLADO (solo sumariza_huerfano), sin ensuciar el conteo de
    //     nivel_vs_sumariza con un efecto colateral del huérfano en vez de un caso propio. ---
    ['9.9.9.999', 'CUENTA HUERFANA', 2, true, '9.9.9.000', true],

    // --- ciclo_sumariza (bloqueante): dos nodos que se referencian entre sí ---
    ['8.1.0.000', 'CICLO A', 2, false, '8.2.0.000', false],
    ['8.2.0.000', 'CICLO B', 2, false, '8.1.0.000', false],

    // --- rolFuncionalCandidato: prefijo "Cuenta Particular" (patrón real de Bracci) ---
    ['1.6.0.000', 'Cuenta Particular Test Socio', 2, true, '1.0.0.000', true],
  ];

  it('detecta las 7 anomalías, cada una en el código correcto, y nada más', async () => {
    const buf = await libro(FILAS);
    const r = await cargarPlanDeCuentas(buf);

    expect(r.jerarquiaCruzadaEvaluable).toBe(true);

    expect(porTipo(r.anomalias, 'nivel_vs_sumariza').map((a) => a.codigo)).toEqual(['1.1.1.100']);
    expect(porTipo(r.anomalias, 'recibe_con_hijos').map((a) => a.codigo)).toEqual(['1.1.1.000']);
    expect(porTipo(r.anomalias, 'jerarquia_cruzada').map((a) => a.codigo)).toContain('1.2.1.000');
    expect(porTipo(r.anomalias, 'denominacion_duplicada').map((a) => a.codigo).sort()).toEqual([
      '1.4.0.000',
      '2.1.1.000',
    ]);
    expect(porTipo(r.anomalias, 'denominacion_placeholder').map((a) => a.codigo)).toEqual(['1.5.0.000']);
    expect(porTipo(r.anomalias, 'sumariza_huerfano').map((a) => a.codigo)).toEqual(['9.9.9.999']);
    expect(porTipo(r.anomalias, 'ciclo_sumariza').map((a) => a.codigo).sort()).toEqual([
      '8.1.0.000',
      '8.2.0.000',
    ]);
  });

  it('las anomalías bloqueantes son exactamente sumariza_huerfano y ciclo_sumariza', () => {
    expect([...ANOMALIAS_BLOQUEANTES].sort()).toEqual(['ciclo_sumariza', 'sumariza_huerfano']);
  });

  it('los nodos en ciclo quedan con profundidadReal=-1 (sentinela), nunca con un número inventado', async () => {
    const buf = await libro(FILAS);
    const r = await cargarPlanDeCuentas(buf);
    const porCodigo = new Map(r.nodos.map((n) => [n.codigo, n]));
    expect(porCodigo.get('8.1.0.000')?.profundidadReal).toBe(-1);
    expect(porCodigo.get('8.2.0.000')?.profundidadReal).toBe(-1);
  });

  it('un nodo en ciclo NO se reporta también como nivel_vs_sumariza (evita ruido duplicado sobre el mismo defecto)', async () => {
    const buf = await libro(FILAS);
    const r = await cargarPlanDeCuentas(buf);
    const codigosNivel = new Set(porTipo(r.anomalias, 'nivel_vs_sumariza').map((a) => a.codigo));
    expect(codigosNivel.has('8.1.0.000')).toBe(false);
    expect(codigosNivel.has('8.2.0.000')).toBe(false);
  });

  it('rolFuncionalCandidato: solo el nodo con prefijo "Cuenta Particular" es candidato a socio, el resto es genérica', async () => {
    const buf = await libro(FILAS);
    const r = await cargarPlanDeCuentas(buf);
    const candidatos = r.nodos.filter((n) => n.rolFuncionalCandidato !== 'generica');
    expect(candidatos.map((n) => n.codigo)).toEqual(['1.6.0.000']);
    expect(r.nodos.find((n) => n.codigo === '1.0.0.000')?.rolFuncionalCandidato).toBe('generica');
  });

  it('la denominación se devuelve tal cual el archivo, nunca modificada (R42)', async () => {
    const buf = await libro(FILAS);
    const r = await cargarPlanDeCuentas(buf);
    expect(r.nodos.find((n) => n.codigo === '1.5.0.000')?.denominacion).toBe('disponible');
    expect(r.nodos.find((n) => n.codigo === '1.6.0.000')?.denominacion).toBe('Cuenta Particular Test Socio');
  });
});

describe('cargarPlanDeCuentas — un huérfano sin padre resoluble puede reportar dos anomalías a la vez', () => {
  it('sumariza_huerfano + nivel_vs_sumariza en el mismo código, cuando el NIVEL declarado no coincide con el fallback de profundidad (1+1=2)', async () => {
    const buf = await libro([
      ['1.0.0.000', 'ACTIVO', 1, false, RAIZ, false],
      // SUMARIZA no existe → profundidadReal cae al tratamiento de raíz (2), pero NIVEL dice 4:
      // el parser NUNCA "corrige" ni prioriza una anomalía sobre otra — reporta las dos.
      ['9.9.9.999', 'CUENTA HUERFANA', 4, true, '9.9.9.000', true],
    ]);
    const r = await cargarPlanDeCuentas(buf);
    expect(porTipo(r.anomalias, 'sumariza_huerfano').map((a) => a.codigo)).toEqual(['9.9.9.999']);
    expect(porTipo(r.anomalias, 'nivel_vs_sumariza').map((a) => a.codigo)).toEqual(['9.9.9.999']);
  });
});

describe('cargarPlanDeCuentas — guarda de "¿el archivo usa codificación segmentada consistente?"', () => {
  it('con códigos de distinta cantidad de segmentos, jerarquiaCruzadaEvaluable=false y NO se reporta jerarquia_cruzada', async () => {
    const buf = await libro([
      ['1', 'ACTIVO', 1, false, RAIZ, false],
      ['1.1', 'CAJA Y BANCOS', 2, false, '1', false],
      // Este nodo, con la heurística de segmentos, luciría "cruzado" si se evaluara — pero el archivo
      // no es segmentado consistente (longitudes 1, 2 y 4 mezcladas), así que el parser se abstiene.
      ['9.9.9.999', 'CAJA EN PESOS', 3, true, '1.1', true],
    ]);
    const r = await cargarPlanDeCuentas(buf);
    expect(r.jerarquiaCruzadaEvaluable).toBe(false);
    expect(porTipo(r.anomalias, 'jerarquia_cruzada')).toEqual([]);
  });
});
