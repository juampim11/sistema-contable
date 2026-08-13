/**
 * ARMADO DEL LIBRO — puro. Sin base, sin disco, sin `conUsuario`. Filas ya resueltas entran,
 * `ExcelJS.Workbook` sale. Único archivo del repo que importa `exceljs` (plan `adaptive-herding-pillow`,
 * §"Ubicación").
 *
 * Diseño de columnas y hojas: `ux-designer`, ratificado por `contador-dominio` (HANDOFF pendiente de
 * cierre). Débito/Crédito se derivan del SIGNO de `importe` — `esquema.ts`: "crédito = +, débito = −.
 * El signo es el efecto sobre el saldo del BANCO" —, nunca Debe/Haber contable: esa conversión es del
 * Módulo 2 y se declara en la leyenda de la hoja de control.
 *
 * ⚠️ `import ExcelJS from 'exceljs'` — nunca `import { Workbook }`: el paquete es CJS y ese nombrado no
 * existe como export ESM (verificado en runtime al diseñar esto). Un cambio a ese import rompe en
 * silencio si no hay un test que lo ejercite — lo hay, ver `planilla.test.ts` Bloque B.
 */

import ExcelJS from 'exceljs';
import { importeCanonicoACentavos } from '../parseo-ar.ts';

// -----------------------------------------------------------------------------
// Tipos de entrada — ya resueltos por `exportar-planilla.ts`, nada de SQL ni de N2R acá.
// -----------------------------------------------------------------------------

export type FilaPlanilla = {
  readonly filaNumero: number;
  readonly cuentaBancariaId: string;
  readonly fecha: string; // 'YYYY-MM-DD'
  readonly fechaValor: string | null;
  readonly descripcion: string;
  readonly conceptoBanco: string | null;
  readonly conceptoCodigo: string | null;
  readonly conceptoCompleto: boolean | null;
  readonly conceptoBancoEstrategia: string | null;
  readonly importe: string; // canónico signado, '-4321.00'
  readonly saldo: string | null;
  readonly saldoEsAcreedor: boolean | null;
  readonly moneda: string;
  readonly referenciaExterna: string | null;
  readonly paginaPdf: number | null;
};

export type CabeceraCuenta = {
  readonly cuentaBancariaId: string;
  readonly bancoCodigo: string;
  readonly cuentaAlias: string | null;
  readonly moneda: string;
  readonly periodoDesde: string;
  readonly periodoHasta: string;
  readonly saldoInicialDeclarado: string | null;
  readonly saldoFinalDeclarado: string | null;
  readonly totalCreditosDeclarado: string | null;
  readonly totalDebitosDeclarado: string | null;
  readonly saldoFinalCalculado: string | null;
  readonly totalCreditosCalculado: string | null;
  readonly totalDebitosCalculado: string | null;
  readonly filasLeidas: number;
  readonly filasAceptadas: number;
  readonly verificacionEstado: string; // 'cuadra' | 'no_cuadra' | 'no_verificable'
};

export type DatosPlanilla = {
  readonly clienteId: string;
  readonly loteId: string;
  readonly bancoCodigo: string;
  readonly loteEstado: string;
  readonly adaptadorVersion: string;
  /** ISO instant. Lo inyecta el caller — este archivo nunca llama `new Date()` sin argumento. */
  readonly generadoEn: string;
  readonly correlacion: string;
  readonly motivoCodigo: string;
  readonly destinatarioCodigo: string;
  readonly cabeceras: readonly CabeceraCuenta[];
  readonly filas: readonly FilaPlanilla[];
};

export const MOTIVOS_LIBRO = [
  'importe_fuera_de_rango',
  'fecha_invalida',
  'cabecera_faltante',
  'demasiadas_filas',
] as const;
export type MotivoLibro = (typeof MOTIVOS_LIBRO)[number];

export type ResultadoLibro =
  | { readonly estado: 'armado'; readonly libro: ExcelJS.Workbook; readonly filas: number }
  | { readonly estado: 'abortado'; readonly motivoCodigo: MotivoLibro; readonly filaNumero?: number };

/**
 * Tope de filas del libro entero. Por encima, se aborta antes de tocar `exceljs` — un lote que lo supere
 * es la señal de que hay que volver a decidir el mecanismo (paginar, filtrar por cuenta), no degradarse
 * en silencio hacia un archivo lento o un OOM en la máquina de quien lo abre.
 */
export const MAX_FILAS = 50_000;

// -----------------------------------------------------------------------------
// Conversores — cada uno con su test de borde (`planilla.test.ts` Bloque A).
// -----------------------------------------------------------------------------

const MAX_CENTAVOS_SEGUROS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Canónico signado → número de punto flotante para una celda de Excel.
 *
 * `null` si el valor no entra en un `double` sin mentir — nunca un truncado ni un redondeo silencioso.
 * `numeric(18,2)` admite hasta 16 dígitos enteros; un `double` no. Antes que escribir un importe creíble
 * y equivocado (la lección de `parseo-ar.ts`), se aborta esa fila entera.
 */
export function importeCanonicoANumeroExcel(canonico: string): number | null {
  const centavos = importeCanonicoACentavos(canonico);
  if (centavos === null) return null;
  const abs = centavos < 0n ? -centavos : centavos;
  if (abs > MAX_CENTAVOS_SEGUROS) return null;
  return Number(centavos) / 100;
}

const EPOCH_EXCEL_UTC = Date.UTC(1899, 11, 30);
const MS_POR_DIA = 86_400_000;
const RE_FECHA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `'YYYY-MM-DD'` → serial de Excel (días desde 1899-12-30, la misma cuenta que usa Excel de verdad).
 *
 * Calculado con `Date.UTC`, nunca `new Date(string)`: el segundo depende de la zona horaria del proceso
 * que corre el script y corre la fecha un día (ADR-0000 §2.3). `Date.UTC` normaliza fechas imposibles
 * (`'2026-02-30'` → 2 de marzo), así que se verifica el ida y vuelta antes de aceptar el serial.
 */
export function fechaIsoASerialExcel(iso: string): number | null {
  const m = RE_FECHA_ISO.exec(iso);
  if (!m) return null;
  const [, a, s, d] = m;
  if (a === undefined || s === undefined || d === undefined) return null;
  const anio = Number(a);
  const mes = Number(s);
  const dia = Number(d);
  const ms = Date.UTC(anio, mes - 1, dia);
  const control = new Date(ms);
  if (
    control.getUTCFullYear() !== anio ||
    control.getUTCMonth() + 1 !== mes ||
    control.getUTCDate() !== dia
  ) {
    return null;
  }
  return (ms - EPOCH_EXCEL_UTC) / MS_POR_DIA;
}

// -----------------------------------------------------------------------------
// Validación previa — dos pasadas: primero se valida TODO, después se construye. Así nunca queda un
// workbook a medio armar por una fila que aborta en el medio.
// -----------------------------------------------------------------------------

function convertirImporteOpcional(v: string | null): number | null | 'invalido' {
  if (v === null) return null;
  const n = importeCanonicoANumeroExcel(v);
  return n === null ? 'invalido' : n;
}

function validar(datos: DatosPlanilla): Extract<ResultadoLibro, { estado: 'abortado' }> | null {
  if (datos.filas.length > MAX_FILAS) {
    return { estado: 'abortado', motivoCodigo: 'demasiadas_filas' };
  }

  for (const c of datos.cabeceras) {
    const campos = [
      c.saldoInicialDeclarado,
      c.saldoFinalDeclarado,
      c.totalCreditosDeclarado,
      c.totalDebitosDeclarado,
      c.saldoFinalCalculado,
      c.totalCreditosCalculado,
      c.totalDebitosCalculado,
    ];
    if (campos.some((v) => convertirImporteOpcional(v) === 'invalido')) {
      return { estado: 'abortado', motivoCodigo: 'importe_fuera_de_rango' };
    }
  }

  const cuentaIds = new Set(datos.cabeceras.map((c) => c.cuentaBancariaId));
  for (const f of datos.filas) {
    if (!cuentaIds.has(f.cuentaBancariaId)) {
      return { estado: 'abortado', motivoCodigo: 'cabecera_faltante', filaNumero: f.filaNumero };
    }
    if (fechaIsoASerialExcel(f.fecha) === null) {
      return { estado: 'abortado', motivoCodigo: 'fecha_invalida', filaNumero: f.filaNumero };
    }
    if (f.fechaValor !== null && fechaIsoASerialExcel(f.fechaValor) === null) {
      return { estado: 'abortado', motivoCodigo: 'fecha_invalida', filaNumero: f.filaNumero };
    }
    if (importeCanonicoANumeroExcel(f.importe) === null) {
      return { estado: 'abortado', motivoCodigo: 'importe_fuera_de_rango', filaNumero: f.filaNumero };
    }
    if (f.saldo !== null && importeCanonicoANumeroExcel(f.saldo) === null) {
      return { estado: 'abortado', motivoCodigo: 'importe_fuera_de_rango', filaNumero: f.filaNumero };
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Formato
// -----------------------------------------------------------------------------

const FMT_MONEDA = '#,##0.00;[Red]-#,##0.00';
const FMT_FECHA = 'dd/mm/yyyy';

function textoConcepto(f: FilaPlanilla): string {
  const base =
    f.conceptoBanco ?? (f.conceptoBancoEstrategia === 'no_publicado' ? '(sin concepto del banco)' : '(no capturado)');
  return f.conceptoCompleto === false ? `${base}…` : base;
}

function etiquetaCuenta(c: CabeceraCuenta): string {
  return `${c.bancoCodigo} · ${c.cuentaAlias ?? '(sin alias)'} · ${c.moneda}`;
}

function textoVerificacion(estado: string): string {
  switch (estado) {
    case 'cuadra':
      return 'CUADRA';
    case 'no_cuadra':
      return 'NO CUADRA';
    case 'no_verificable':
      return 'NO VERIFICABLE — el banco no publica totales en este extracto';
    default:
      return estado;
  }
}

/** Nombre de hoja válido (≤31 chars, sin `[]:*?/\`), único dentro del libro. */
function nombreHoja(cabecera: CabeceraCuenta, usados: Set<string>): string {
  const base = `${cabecera.moneda} ${cabecera.cuentaAlias ?? cabecera.bancoCodigo}`
    .replace(/[[\]:*?/\\]/g, '-')
    .slice(0, 28);
  let candidato = base;
  let sufijo = 2;
  while (usados.has(candidato.toLowerCase())) {
    candidato = `${base} (${sufijo})`.slice(0, 31);
    sufijo += 1;
  }
  usados.add(candidato.toLowerCase());
  return candidato;
}

// -----------------------------------------------------------------------------
// Hoja "Control de saldos"
// -----------------------------------------------------------------------------

function armarHojaControl(libro: ExcelJS.Workbook, datos: DatosPlanilla): void {
  const hoja = libro.addWorksheet('Control de saldos', {
    views: [{ state: 'frozen', ySplit: 3 }],
  });

  hoja.columns = [
    { header: 'Cuenta', key: 'cuenta', width: 30 },
    { header: 'Moneda', key: 'moneda', width: 8 },
    { header: 'Período desde', key: 'desde', width: 13, style: { numFmt: FMT_FECHA } },
    { header: 'Período hasta', key: 'hasta', width: 13, style: { numFmt: FMT_FECHA } },
    { header: 'Saldo inicial (declarado)', key: 'saldoInicial', width: 18, style: { numFmt: FMT_MONEDA } },
    { header: 'Créditos (declarado)', key: 'creditos', width: 16, style: { numFmt: FMT_MONEDA } },
    { header: 'Débitos (declarado)', key: 'debitos', width: 16, style: { numFmt: FMT_MONEDA } },
    { header: 'Saldo final (declarado)', key: 'saldoFinalDecl', width: 18, style: { numFmt: FMT_MONEDA } },
    { header: 'Saldo final (calculado)', key: 'saldoFinalCalc', width: 18, style: { numFmt: FMT_MONEDA } },
    { header: 'Verificación', key: 'verificacion', width: 42 },
  ];
  // `columns` escribe los headers en la fila 1. Se empuja todo una fila abajo para dejarle lugar al
  // título — si se pusiera el título ANTES de fijar `columns`, `columns` lo pisaría en silencio.
  hoja.spliceRows(1, 0, []);
  hoja.getCell('A1').value =
    `Lote ${datos.loteId} · Banco ${datos.bancoCodigo} · Generado ${datos.generadoEn}`;
  hoja.getCell('A1').font = { bold: true };
  hoja.mergeCells(1, 1, 1, 10);
  const filaHeaders = hoja.getRow(2);
  filaHeaders.font = { bold: true };
  filaHeaders.alignment = { vertical: 'middle', wrapText: true };

  for (const c of datos.cabeceras) {
    hoja.addRow({
      cuenta: etiquetaCuenta(c),
      moneda: c.moneda,
      desde: fechaIsoASerialExcel(c.periodoDesde),
      hasta: fechaIsoASerialExcel(c.periodoHasta),
      saldoInicial: convertirImporteOpcional(c.saldoInicialDeclarado),
      creditos: convertirImporteOpcional(c.totalCreditosDeclarado),
      debitos: convertirImporteOpcional(c.totalDebitosDeclarado),
      saldoFinalDecl: convertirImporteOpcional(c.saldoFinalDeclarado),
      saldoFinalCalc: convertirImporteOpcional(c.saldoFinalCalculado),
      verificacion: textoVerificacion(c.verificacionEstado),
    });
  }

  const leyendaDesde = 3 + datos.cabeceras.length + 2;
  const leyenda = [
    'Cómo leer esta planilla',
    '— "Débito"/"Crédito" son del BANCO: si el movimiento sale o entra a la cuenta. NO son "Debe"/"Haber"',
    '  contables — esa conversión la propone el Módulo 2 y la revisás vos.',
    '— "s/d" significa que el dato no está disponible para esa fila (el banco no lo publica, o el',
    '  sistema no lo capturó todavía) — nunca significa un error.',
    '— Las columnas "Cuenta contable" y "Observación" están vacías a propósito: son tuyas, para',
    '  clasificar. El sistema todavía no propone nada.',
    '',
    // Procedencia: si este archivo aparece donde no debe, `correlacion` lo ata a su fila de auditoría
    // sin exponer nada del cliente (los cuatro son uuids/códigos internos, nunca datos N2).
    `Procedencia — cliente=${datos.clienteId} lote=${datos.loteId} correlacion=${datos.correlacion} ` +
      `motivo=${datos.motivoCodigo} destinatario=${datos.destinatarioCodigo}`,
  ];
  leyenda.forEach((linea, i) => {
    hoja.getCell(`A${leyendaDesde + i}`).value = linea;
  });
}

// -----------------------------------------------------------------------------
// Hoja de movimientos, una por cuenta
// -----------------------------------------------------------------------------

type ColumnaMov = { readonly header: string; readonly key: string; readonly width: number; readonly numFmt?: string };

function columnasMovimientos(filas: readonly FilaPlanilla[]): readonly ColumnaMov[] {
  const hayFechaValor = filas.some((f) => f.fechaValor !== null);
  const hayPaginaPdf = filas.some((f) => f.paginaPdf !== null);
  const hayAcreedor = filas.some((f) => f.saldoEsAcreedor === true);

  const columnas: ColumnaMov[] = [
    { header: 'Fecha', key: 'fecha', width: 12, numFmt: FMT_FECHA },
    { header: 'Concepto', key: 'concepto', width: 26 },
    { header: 'Débito (sale de la cuenta)', key: 'debito', width: 16, numFmt: FMT_MONEDA },
    { header: 'Crédito (entra a la cuenta)', key: 'credito', width: 16, numFmt: FMT_MONEDA },
    { header: 'Saldo', key: 'saldo', width: 16, numFmt: FMT_MONEDA },
  ];
  if (hayAcreedor) columnas.push({ header: 'Naturaleza del saldo', key: 'naturaleza', width: 14 });
  columnas.push({ header: 'Descripción', key: 'descripcion', width: 58 });
  if (hayFechaValor) columnas.push({ header: 'Fecha valor', key: 'fechaValor', width: 12, numFmt: FMT_FECHA });
  columnas.push(
    { header: 'Cuenta contable', key: 'cuentaContable', width: 26 },
    { header: 'Observación', key: 'observacion', width: 30 },
    { header: 'Cuenta', key: 'cuenta', width: 26 },
    { header: 'Moneda', key: 'moneda', width: 8 },
    { header: 'Cód. de concepto', key: 'codigoConcepto', width: 10 },
  );
  if (hayPaginaPdf) columnas.push({ header: 'Pág. del PDF', key: 'paginaPdf', width: 8 });
  columnas.push(
    { header: 'N° de fila (sistema)', key: 'filaNumero', width: 10 },
    { header: 'Importe con signo (control)', key: 'importe', width: 16, numFmt: FMT_MONEDA },
  );
  return columnas;
}

function armarHojaMovimientos(
  libro: ExcelJS.Workbook,
  cabecera: CabeceraCuenta,
  filas: readonly FilaPlanilla[],
  nombreDeHoja: string,
): number {
  const columnas = columnasMovimientos(filas);
  const cantColumnas = columnas.length;

  const hoja = libro.addWorksheet(nombreDeHoja, {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 7 }],
  });

  hoja.getCell('A1').value =
    `Cuenta ${etiquetaCuenta(cabecera)} · Período ${cabecera.periodoDesde} a ${cabecera.periodoHasta} · Lote de origen`;
  hoja.mergeCells(1, 1, 1, cantColumnas);

  const etiquetas = ['', 'Saldo inicial', 'Débitos', 'Créditos', 'Saldo final', 'Verificación'];
  etiquetas.forEach((t, i) => {
    hoja.getCell(3, i + 1).value = t;
  });
  hoja.getRow(3).font = { bold: true };

  const declarado = [
    'Declarado por el banco',
    convertirImporteOpcional(cabecera.saldoInicialDeclarado),
    convertirImporteOpcional(cabecera.totalDebitosDeclarado),
    convertirImporteOpcional(cabecera.totalCreditosDeclarado),
    convertirImporteOpcional(cabecera.saldoFinalDeclarado),
    '',
  ];
  declarado.forEach((v, i) => {
    hoja.getCell(4, i + 1).value = v as ExcelJS.CellValue;
  });

  const calculado = [
    'Calculado por el sistema',
    convertirImporteOpcional(cabecera.saldoInicialDeclarado),
    convertirImporteOpcional(cabecera.totalDebitosCalculado),
    convertirImporteOpcional(cabecera.totalCreditosCalculado),
    convertirImporteOpcional(cabecera.saldoFinalCalculado),
    textoVerificacion(cabecera.verificacionEstado),
  ];
  calculado.forEach((v, i) => {
    hoja.getCell(5, i + 1).value = v as ExcelJS.CellValue;
  });

  const primeraFilaDatos = 8;
  const ultimaFilaDatos = primeraFilaDatos + filas.length - 1;
  const colDebito = columnas.findIndex((c) => c.key === 'debito') + 1;
  const colCredito = columnas.findIndex((c) => c.key === 'credito') + 1;
  const letraDebito = hoja.getColumn(colDebito).letter;
  const letraCredito = hoja.getColumn(colCredito).letter;

  hoja.getCell(6, 1).value = 'Filtrado en pantalla';
  if (filas.length > 0) {
    hoja.getCell(6, colDebito).value = {
      formula: `SUBTOTAL(109,${letraDebito}${primeraFilaDatos}:${letraDebito}${ultimaFilaDatos})`,
    };
    hoja.getCell(6, colCredito).value = {
      formula: `SUBTOTAL(109,${letraCredito}${primeraFilaDatos}:${letraCredito}${ultimaFilaDatos})`,
    };
    hoja.getCell(6, cantColumnas).value = {
      formula: `SUBTOTAL(103,A${primeraFilaDatos}:A${ultimaFilaDatos})&" de ${filas.length} filas"`,
    };
  }
  [4, 5, 6].forEach((fila) => {
    hoja.getRow(fila).getCell(colDebito).numFmt = FMT_MONEDA;
    hoja.getRow(fila).getCell(colCredito).numFmt = FMT_MONEDA;
  });

  // Fila 7: encabezados de columna, con `columns` (arranca en la fila 1, así que se corta y se pega).
  columnas.forEach((c, i) => {
    const celda = hoja.getCell(7, i + 1);
    celda.value = c.header;
    hoja.getColumn(i + 1).width = c.width;
    if (c.numFmt) hoja.getColumn(i + 1).numFmt = c.numFmt;
  });
  hoja.getRow(7).font = { bold: true };
  hoja.getRow(7).alignment = { vertical: 'middle', wrapText: true };

  filas.forEach((f, indice) => {
    const fila = hoja.getRow(primeraFilaDatos + indice);
    const importe = importeCanonicoANumeroExcel(f.importe) ?? 0;
    const registro: Record<string, ExcelJS.CellValue> = {
      fecha: fechaIsoASerialExcel(f.fecha),
      concepto: textoConcepto(f),
      debito: importe < 0 ? -importe : null,
      credito: importe > 0 ? importe : null,
      saldo: f.saldo === null ? null : importeCanonicoANumeroExcel(f.saldo),
      naturaleza: f.saldoEsAcreedor === true ? 'ACREEDOR' : f.saldoEsAcreedor === false ? '' : null,
      descripcion: f.descripcion,
      fechaValor: f.fechaValor === null ? null : fechaIsoASerialExcel(f.fechaValor),
      cuentaContable: null,
      observacion: null,
      cuenta: etiquetaCuenta(cabecera),
      moneda: f.moneda,
      codigoConcepto: f.conceptoCodigo,
      paginaPdf: f.paginaPdf,
      filaNumero: f.filaNumero,
      importe,
    };
    columnas.forEach((c, i) => {
      fila.getCell(i + 1).value = registro[c.key] ?? null;
    });
  });

  if (filas.length > 0) {
    hoja.autoFilter = {
      from: { row: 7, column: 1 },
      to: { row: ultimaFilaDatos, column: cantColumnas },
    };
  }

  return filas.length;
}

// -----------------------------------------------------------------------------
// Punto de entrada
// -----------------------------------------------------------------------------

export function armarLibro(datos: DatosPlanilla): ResultadoLibro {
  const invalido = validar(datos);
  if (invalido) return invalido;

  const libro = new ExcelJS.Workbook();
  libro.creator = 'sistema-contable';
  libro.lastModifiedBy = 'sistema-contable';
  libro.created = new Date(datos.generadoEn);

  armarHojaControl(libro, datos);

  const filasPorCuenta = new Map<string, FilaPlanilla[]>();
  for (const f of datos.filas) {
    const arr = filasPorCuenta.get(f.cuentaBancariaId) ?? [];
    arr.push(f);
    filasPorCuenta.set(f.cuentaBancariaId, arr);
  }

  const nombresUsados = new Set<string>();
  let totalFilas = 0;
  for (const cabecera of datos.cabeceras) {
    const filasDeCuenta = filasPorCuenta.get(cabecera.cuentaBancariaId) ?? [];
    const nombre = nombreHoja(cabecera, nombresUsados);
    totalFilas += armarHojaMovimientos(libro, cabecera, filasDeCuenta, nombre);
  }

  return { estado: 'armado', libro, filas: totalFilas };
}

/** Serializa. Único punto asíncrono de este archivo. */
export async function serializarLibro(libro: ExcelJS.Workbook): Promise<Uint8Array> {
  const buffer = await libro.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
