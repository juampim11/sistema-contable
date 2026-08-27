/**
 * PARSER del plan de cuentas — puro, sin base, sin `conUsuario`. Lee el `.xlsx` con las 6 columnas
 * conocidas (`CODIGO|DENOMINACION|NIVEL|RECIBE|SUMARIZA|MONETARIA`, header en la fila 4, datos desde
 * la fila 5 — formato confirmado contra el archivo real de Bracci Repuestos S.A.S.) y devuelve nodos +
 * anomalías. NUNCA corrige nada — ni el NIVEL declarado, ni una jerarquía cruzada, ni una denominación
 * duplicada. Reporta, quien decide es una persona.
 *
 * `import ExcelJS from 'exceljs'` — nunca `import { Workbook }` (el paquete es CJS, ver
 * `packages/ingesta/src/planilla/armar-libro.ts` para el precedente y el motivo).
 *
 * 🔴 Este archivo NUNCA imprime una denominación real por su cuenta — devuelve datos, no loguea. Quien
 * lo invoque desde una CLI corrida por un agente tiene que aplicar la regla de `registro-incidentes.md`
 * #14: vocabulario contable genérico se puede mostrar libre; una denominación que embebe nombre propio
 * de persona (`rolFuncional !== 'generica'`, hoy detectada por el prefijo "Cuenta Particular") nunca
 * por `Bash` ni por salida de herramienta de agente — solo un humano tecleando/leyendo directo, o el
 * agente describiendo por código/posición sin citar el texto literal.
 */

import ExcelJS from 'exceljs';

export type NodoPlanCuentas = {
  readonly fila: number;
  readonly codigo: string;
  readonly denominacion: string;
  readonly nivelDeclarado: number;
  /** Calculada caminando SUMARIZA hasta la raíz — NUNCA del campo NIVEL, que no es confiable. */
  readonly profundidadReal: number;
  readonly recibe: boolean;
  /** `null` para las raíces (SUMARIZA = "..." en el archivo). */
  readonly sumariza: string | null;
  readonly monetaria: boolean;
  /** Heurística de CANDIDATO, no clasificación autoritativa — la autoridad es la tabla de mapeo humana. */
  readonly rolFuncionalCandidato: 'generica' | 'cuenta_particular_socio';
};

export type TipoAnomaliaPlanCuentas =
  | 'nivel_vs_sumariza'
  | 'jerarquia_cruzada'
  | 'denominacion_duplicada'
  | 'recibe_con_hijos'
  | 'denominacion_placeholder'
  | 'sumariza_huerfano'
  | 'ciclo_sumariza';

/** Las dos únicas que impiden insertar (sin `cuentaPadreId` resoluble) — el resto son informativas. */
export const ANOMALIAS_BLOQUEANTES: readonly TipoAnomaliaPlanCuentas[] = [
  'sumariza_huerfano',
  'ciclo_sumariza',
];

export type AnomaliaPlanCuentas = {
  readonly tipo: TipoAnomaliaPlanCuentas;
  readonly codigo: string;
  /** Código y números, nunca texto libre del archivo — mismo criterio que `CodigoErrorAdaptador`. */
  readonly detalle: string;
};

export type ResultadoParseoPlanCuentas = {
  readonly nodos: readonly NodoPlanCuentas[];
  readonly anomalias: readonly AnomaliaPlanCuentas[];
  /** `false` si el archivo no usa codificación segmentada consistente — `jerarquia_cruzada` no se evaluó. */
  readonly jerarquiaCruzadaEvaluable: boolean;
};

export type CodigoErrorParserPlanCuentas = 'sin_hoja' | 'encabezado_no_reconocido' | 'sin_filas';

export class ErrorParserPlanCuentas extends Error {
  readonly codigo: CodigoErrorParserPlanCuentas;
  constructor(codigo: CodigoErrorParserPlanCuentas) {
    super(`plan-cuentas: ${codigo}`);
    this.codigo = codigo;
  }
}

const MARCADOR_RAIZ = '...';
const ENCABEZADO_ESPERADO = ['CODIGO', 'DENOMINACION', 'NIVEL', 'RECIBE', 'SUMARIZA', 'MONETARIA'];
const PREFIJO_CUENTA_PARTICULAR = 'cuenta particular';
/** Lista provisional — se amplía con evidencia real de otros clientes, no por adivinar. */
const PATRONES_PLACEHOLDER = ['disponible'];

function celda(valor: ExcelJS.CellValue): string {
  return valor === null || valor === undefined ? '' : String(valor).trim();
}

function esSiNo(valor: ExcelJS.CellValue): boolean {
  return celda(valor).toUpperCase() === 'SI';
}

function segmentosNumericos(codigo: string): number[] {
  return codigo.split('.').map((s) => Number.parseInt(s, 10));
}

export async function cargarPlanDeCuentas(buffer: Buffer): Promise<ResultadoParseoPlanCuentas> {
  const wb = new ExcelJS.Workbook();
  // `exceljs` trae su propio tipo `Buffer` (desfasado del de `@types/node` instalado) — mismo Buffer
  // en runtime, tipos estructuralmente incompatibles. Cast puntual, no un `any` de alcance amplio.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) throw new ErrorParserPlanCuentas('sin_hoja');

  const filaEncabezado = ws.getRow(4);
  const encabezadoReal = ENCABEZADO_ESPERADO.map((_, i) => celda(filaEncabezado.getCell(i + 1).value));
  const encabezadoOk = ENCABEZADO_ESPERADO.every(
    (esperado, i) => encabezadoReal[i]?.toUpperCase() === esperado,
  );
  if (!encabezadoOk) throw new ErrorParserPlanCuentas('encabezado_no_reconocido');

  type Cruda = {
    fila: number;
    codigo: string;
    denominacion: string;
    nivelDeclarado: number;
    recibe: boolean;
    sumarizaCruda: string;
    monetaria: boolean;
  };
  const crudas: Cruda[] = [];
  for (let r = 5; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const codigo = celda(row.getCell(1).value);
    if (!codigo) continue;
    crudas.push({
      fila: r,
      codigo,
      denominacion: celda(row.getCell(2).value),
      nivelDeclarado: Number(row.getCell(3).value),
      recibe: esSiNo(row.getCell(4).value),
      sumarizaCruda: celda(row.getCell(5).value),
      monetaria: esSiNo(row.getCell(6).value),
    });
  }
  if (crudas.length === 0) throw new ErrorParserPlanCuentas('sin_filas');

  const porCodigo = new Map(crudas.map((c) => [c.codigo, c]));
  const anomalias: AnomaliaPlanCuentas[] = [];

  // --- profundidad real por SUMARIZA, con guarda de ciclos ---
  const profundidadCache = new Map<string, number>();
  const CICLO = -1;
  function profundidadReal(codigo: string, visitados: Set<string> = new Set()): number {
    const cacheada = profundidadCache.get(codigo);
    if (cacheada !== undefined) return cacheada;
    if (visitados.has(codigo)) return CICLO;
    visitados.add(codigo);
    const c = porCodigo.get(codigo);
    if (!c || c.sumarizaCruda === MARCADOR_RAIZ) {
      profundidadCache.set(codigo, 1);
      return 1;
    }
    const padre = profundidadReal(c.sumarizaCruda, visitados);
    const propia = padre === CICLO ? CICLO : padre + 1;
    profundidadCache.set(codigo, propia);
    return propia;
  }

  // --- huérfanos y ciclos (bloqueantes) ---
  const ciclosDetectados = new Set<string>();
  for (const c of crudas) {
    if (c.sumarizaCruda !== MARCADOR_RAIZ && !porCodigo.has(c.sumarizaCruda)) {
      anomalias.push({
        tipo: 'sumariza_huerfano',
        codigo: c.codigo,
        detalle: `SUMARIZA="${c.sumarizaCruda}" no existe en el plan`,
      });
    }
    if (profundidadReal(c.codigo) === CICLO) {
      ciclosDetectados.add(c.codigo);
      anomalias.push({ tipo: 'ciclo_sumariza', codigo: c.codigo, detalle: 'SUMARIZA entra en ciclo' });
    }
  }

  // --- NIVEL declarado vs. profundidad real ---
  for (const c of crudas) {
    if (ciclosDetectados.has(c.codigo)) continue;
    const p = profundidadReal(c.codigo);
    if (p !== c.nivelDeclarado) {
      anomalias.push({
        tipo: 'nivel_vs_sumariza',
        codigo: c.codigo,
        detalle: `NIVEL declarado=${c.nivelDeclarado}, profundidad real por SUMARIZA=${p}`,
      });
    }
  }

  // --- jerarquía cruzada, con guarda de "¿el archivo usa codificación segmentada consistente?" ---
  const segCounts = new Set(crudas.map((c) => c.codigo.split('.').length));
  const jerarquiaCruzadaEvaluable = segCounts.size === 1;
  if (jerarquiaCruzadaEvaluable) {
    for (const c of crudas) {
      if (c.sumarizaCruda === MARCADOR_RAIZ || ciclosDetectados.has(c.codigo)) continue;
      const padre = porCodigo.get(c.sumarizaCruda);
      if (!padre) continue; // ya reportado como huérfano
      const segPadre = segmentosNumericos(padre.codigo);
      const trailingCeros = (() => {
        let k = 0;
        for (let i = segPadre.length - 1; i >= 0 && segPadre[i] === 0; i--) k++;
        return k;
      })();
      const segPropios = segmentosNumericos(c.codigo);
      const padreImplicado = [...segPropios];
      for (let i = 0; i < trailingCeros && i < padreImplicado.length; i++) {
        padreImplicado[padreImplicado.length - 1 - i] = 0;
      }
      const coincide = padreImplicado.every((v, i) => v === segPadre[i]);
      if (!coincide) {
        anomalias.push({
          tipo: 'jerarquia_cruzada',
          codigo: c.codigo,
          detalle: `código sugiere otra rama; SUMARIZA real="${padre.codigo}"`,
        });
      }
    }
  }

  // --- RECIBE=SI con hijos ---
  const tieneHijos = new Set(crudas.map((c) => c.sumarizaCruda));
  for (const c of crudas) {
    if (c.recibe && tieneHijos.has(c.codigo)) {
      anomalias.push({ tipo: 'recibe_con_hijos', codigo: c.codigo, detalle: 'RECIBE=SI pero tiene hijos' });
    }
  }

  // --- denominación duplicada ---
  const porDenom = new Map<string, string[]>();
  for (const c of crudas) {
    const k = c.denominacion.toLowerCase();
    const lista = porDenom.get(k) ?? [];
    lista.push(c.codigo);
    porDenom.set(k, lista);
  }
  for (const [, codigos] of porDenom) {
    if (codigos.length > 1) {
      for (const codigo of codigos) {
        anomalias.push({
          tipo: 'denominacion_duplicada',
          codigo,
          detalle: `mismo texto que ${codigos.filter((x) => x !== codigo).join(', ')}`,
        });
      }
    }
  }

  // --- placeholder ---
  for (const c of crudas) {
    if (PATRONES_PLACEHOLDER.includes(c.denominacion.toLowerCase())) {
      anomalias.push({ tipo: 'denominacion_placeholder', codigo: c.codigo, detalle: 'denominación genérica/placeholder' });
    }
  }

  const nodos: NodoPlanCuentas[] = crudas.map((c) => ({
    fila: c.fila,
    codigo: c.codigo,
    denominacion: c.denominacion,
    nivelDeclarado: c.nivelDeclarado,
    profundidadReal: profundidadReal(c.codigo) === CICLO ? -1 : profundidadReal(c.codigo),
    recibe: c.recibe,
    sumariza: c.sumarizaCruda === MARCADOR_RAIZ ? null : c.sumarizaCruda,
    monetaria: c.monetaria,
    rolFuncionalCandidato: c.denominacion.toLowerCase().startsWith(PREFIJO_CUENTA_PARTICULAR)
      ? 'cuenta_particular_socio'
      : 'generica',
  }));

  return { nodos, anomalias, jerarquiaCruzadaEvaluable };
}
