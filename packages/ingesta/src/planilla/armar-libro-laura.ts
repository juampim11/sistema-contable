/**
 * ARMADO DEL LIBRO DEL RELEVAMIENTO PARA LAURA — puro respecto de la base (recibe `ResultadoRelevamiento`
 * ya leído por `relevamiento-laura.ts`), pero no puro respecto de I/O: `hoja.protect()` de ExcelJS es
 * async, así que a diferencia de `armarLibro()` (síncrono) este constructor tiene que serlo también.
 * Sin disco, sin base — el único efecto async es interno a `exceljs`.
 *
 * Tercer archivo del repo que importa `exceljs` (después de `armar-libro.ts` y `fci-galicia/armar-
 * libro-fci.ts`) — mismo patrón: un archivo por tipo de artefacto, el CLI nunca importa `exceljs`
 * directo.
 *
 * ## Por qué las listas de contraparte NO están hardcodeadas acá
 *
 * El plan original (convocatoria completa: `motor-conciliacion-contable`, `contador-dominio`,
 * `qa-funcional`, `ux-designer`, `seguridad-datos-financieros`, `security-engineer`) da literales
 * concretos de `Lista_Bracci`/`Lista_ROKA` — nombres reales de socios de dos clientes reales del
 * piloto. Clasificación (`clasificacion-campos.ts`): `denominacion` de socio es N2, `exportable:
 * true`, y este relevamiento es siempre hacia `estudio_interno` — el mismo gate que ya autoriza esa
 * exposición en capa C (`exportar-planilla.ts`). O sea: el DATO puede viajar al `.xlsx` sin problema.
 *
 * Lo que este archivo evita es otra cosa — nombres reales de personas, escritos como literal de
 * TypeScript, quedarían en el historial de git PARA SIEMPRE, legibles por cualquier agente futuro que
 * abra este archivo, sin relación con si el export en sí está autorizado. Por eso `armarLibroLaura`
 * recibe las listas como parámetro (`OpcionesLibroLaura.listaBracci`/`listaRoka`): el CLI las toma de
 * un archivo JSON que JP aporta en el momento de la corrida real (`--listas`, nunca commiteado, nunca
 * dentro de `privado/`), y este módulo — y sus tests, con listas sintéticas — nunca las ve.
 */

import ExcelJS from 'exceljs';
import { contieneIdentificador } from '../glosa.ts';
import { importeCanonicoACentavos } from '../parseo-ar.ts';
import type {
  FilaAsientoAutomatico,
  FilaContraparte,
  FilaTipoSinCuenta,
  RenglonAsientoEjemplo,
  ResultadoDeCliente,
  ResultadoRelevamiento,
} from './relevamiento-laura.ts';

const FMT_MONEDA = '#,##0.00;[Red]-#,##0.00';
const FMT_FECHA = 'dd/mm/yyyy';

const MAX_CENTAVOS_SEGUROS = BigInt(Number.MAX_SAFE_INTEGER);

/** Mismo criterio que `armar-libro.ts::importeCanonicoANumeroExcel` — nunca truncar en silencio; acá
 *  además nunca esconder el dato: si no entra en un `double` sin mentir, se muestra el canónico crudo
 *  en vez de un número redondeado. Duplicado a propósito: `armar-libro.ts` no lo exporta y este
 *  archivo prefiere no acoplarse a su forma interna de reportar "no entra". */
function importeLegible(canonico: string): string {
  const centavos = importeCanonicoACentavos(canonico);
  if (centavos === null) return canonico;
  const abs = centavos < 0n ? -centavos : centavos;
  if (abs > MAX_CENTAVOS_SEGUROS) return canonico;
  const n = Number(centavos) / 100;
  return new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function importeComoNumero(canonico: string): number | null {
  const centavos = importeCanonicoACentavos(canonico);
  if (centavos === null) return null;
  const abs = centavos < 0n ? -centavos : centavos;
  if (abs > MAX_CENTAVOS_SEGUROS) return null;
  return Number(centavos) / 100;
}

const RE_FECHA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `'YYYY-MM-DD'` → `'DD/MM/YYYY'`, sin pasar por `Date`: la zona horaria del host no tiene que
 *  importar acá (ADR-0000 §2.3), y es solo texto de exhibición, nunca una celda de fecha nativa (la
 *  columna "Ejemplo real" mezcla fecha+importe en un solo texto). */
function fechaIsoALegible(iso: string): string {
  const m = RE_FECHA_ISO.exec(iso);
  if (!m) return iso;
  const [, a, s, d] = m;
  return `${d}/${s}/${a}`;
}

function ejemploReal(fecha: string, importe: string): string {
  return `${fechaIsoALegible(fecha)} · ${importeLegible(importe)}`;
}

const EPOCH_EXCEL_UTC = Date.UTC(1899, 11, 30);
const MS_POR_DIA = 86_400_000;

/** Serial de Excel para una celda de fecha NATIVA (Hoja 3, columna "Fecha") — mismo cálculo que
 *  `armar-libro.ts::fechaIsoASerialExcel`, duplicado por la misma razón que `importeLegible`. */
function fechaIsoASerial(iso: string): number | null {
  const m = RE_FECHA_ISO.exec(iso);
  if (!m) return null;
  const [, a, s, d] = m;
  if (a === undefined || s === undefined || d === undefined) return null;
  const anio = Number(a);
  const mes = Number(s);
  const dia = Number(d);
  const ms = Date.UTC(anio, mes - 1, dia);
  const control = new Date(ms);
  if (control.getUTCFullYear() !== anio || control.getUTCMonth() + 1 !== mes || control.getUTCDate() !== dia) {
    return null;
  }
  return (ms - EPOCH_EXCEL_UTC) / MS_POR_DIA;
}

// -----------------------------------------------------------------------------
// Opciones — las dos listas de contraparte, aportadas por el llamador (ver header del archivo).
// -----------------------------------------------------------------------------

export type OpcionesLibroLaura = {
  /** ISO instant. Inyectado por el caller — este archivo nunca llama `new Date()` sin argumento. */
  readonly generadoEn: string;
  /** Opciones del desplegable de la Hoja 1 para el bloque de Bracci (incluida su fila de
   *  `retiro_de_socio`) — mínimo 2 (una respuesta real + "Otro (aclarar abajo)" o equivalente). */
  readonly listaBracci: readonly string[];
  /** Opciones del desplegable de la Hoja 1 para el bloque de ROKA. */
  readonly listaRoka: readonly string[];
};

export class ListaDeContraparteVaciaError extends Error {
  readonly codigo = 'LISTA_CONTRAPARTE_VACIA' as const;
  constructor(bloque: 'bracci' | 'roka') {
    super(`La lista de contraparte de ${bloque} está vacía — no se puede armar el desplegable de la Hoja 1.`);
    this.name = 'ListaDeContraparteVaciaError';
  }
}

/** Mismo criterio que `armar-libro.ts::validar()` para `importe_fuera_de_rango`: antes que escribir
 *  un Debe/Haber creíble y equivocado (y, peor acá, clasificado en el lado que no es — `esDebe` se
 *  deriva del número), se aborta la fila entera. Nunca el fallback silencioso a `0`. */
export class ImporteFueraDeRangoError extends Error {
  readonly codigo = 'IMPORTE_FUERA_DE_RANGO' as const;
  constructor(cliente: string, tipo: string) {
    super(
      `Hoja 3, cliente "${cliente}", tipo "${tipo}": un renglón de asiento tiene un importe que no ` +
        'entra en un double sin mentir. Se aborta antes de escribir el archivo — nunca un 0 en su lugar.',
    );
    this.name = 'ImporteFueraDeRangoError';
  }
}

/**
 * INV-13, EN EL WORKBOOK YA ARMADO — aserción de código, fail-closed (obligatorio, punto 6 del plan).
 * Recorre TODA celda de texto libre de TODAS las hojas (datos, headers, títulos, la hoja oculta de
 * listas) y corre `contieneIdentificador()`. Si matchea aunque sea una vez, LANZA — el llamador
 * (`apps/cli/src/exportar-relevamiento-laura.ts`) no escribe el archivo si esto lanza.
 *
 * Nunca se referencia el identificador encontrado en el mensaje del error (nombre de hoja + celda,
 * nunca el contenido) — mismo criterio que el resto del repo: el error lleva código y ubicación, nunca
 * el dato.
 */
export function verificarSinIdentificadores(libro: ExcelJS.Workbook): void {
  libro.eachSheet((hoja) => {
    hoja.eachRow({ includeEmpty: false }, (fila, filaNumero) => {
      fila.eachCell({ includeEmpty: false }, (celda, columnaNumero) => {
        const valor = celda.value;
        if (typeof valor !== 'string') return;
        if (contieneIdentificador(valor)) {
          throw new Error(
            `INV-13: la hoja "${hoja.name}" celda (fila ${filaNumero}, columna ${columnaNumero}) tiene ` +
              'forma de identificador (CUIT/CBU/documento). Se aborta antes de escribir el archivo.',
          );
        }
      });
    });
  });
}

// -----------------------------------------------------------------------------
// Hoja oculta de listas — soporte de las dos validaciones nombradas de la Hoja 1.
// -----------------------------------------------------------------------------

function armarHojaListas(
  libro: ExcelJS.Workbook,
  listaBracci: readonly string[],
  listaRoka: readonly string[],
): void {
  const hoja = libro.addWorksheet('Listas', { state: 'veryHidden' });
  listaBracci.forEach((v, i) => {
    hoja.getCell(i + 1, 1).value = v;
  });
  listaRoka.forEach((v, i) => {
    hoja.getCell(i + 1, 2).value = v;
  });
  libro.definedNames.add(`Listas!$A$1:$A$${listaBracci.length}`, 'Lista_Bracci');
  libro.definedNames.add(`Listas!$B$1:$B$${listaRoka.length}`, 'Lista_ROKA');
}

// -----------------------------------------------------------------------------
// Hoja 1 — Contrapartes
// -----------------------------------------------------------------------------

const ARGB_BANNER_CLIENTE = 'FF1F4E78'; // "Blue, Accent 1, Darker 50%" de Office — mismo criterio de
// contraste alto que `armar-libro.ts` (ARGB_IDENTIFICADO_POR_EL_SISTEMA), texto blanco encima.
const ARGB_RESUMEN = 'FFF2F0EC'; // gris claro — mismo tono que ARGB_CONTROL_INTERNO de armar-libro.ts.

function escribirFilaHoja1(
  hoja: ExcelJS.Worksheet,
  filaNumero: number,
  cliente: string,
  f: FilaContraparte,
  listaNombre: string,
): void {
  const fila = hoja.getRow(filaNumero);
  fila.getCell(1).value = cliente;
  fila.getCell(2).value = f.ejemploDescripcion;
  fila.getCell(3).value = f.cantidadMovimientos;
  fila.getCell(4).value = ejemploReal(f.ejemploFecha, f.ejemploImporte);
  fila.getCell(5).value = null;
  fila.getCell(6).value = null;
  fila.getCell(5).protection = { locked: false };
  fila.getCell(6).protection = { locked: false };
  fila.getCell(5).dataValidation = {
    type: 'list',
    allowBlank: true,
    formulae: [listaNombre],
    showErrorMessage: true,
    errorStyle: 'error', // "Stop" — nunca "Warning": Laura no puede dejar un valor fuera de la lista.
    errorTitle: 'Opción inválida',
    error: 'Elegí una opción de la lista desplegable.',
    showInputMessage: true,
    promptTitle: 'Contraparte',
    prompt: `Elegí quién es esta contraparte para ${cliente}.`,
  };
}

/** Escribe un bloque completo (banner + filas individuales + resumen) a partir de `filaInicio`.
 *  Devuelve la próxima fila libre. */
function escribirBloqueContrapartes(
  hoja: ExcelJS.Worksheet,
  filaInicio: number,
  cliente: ResultadoDeCliente,
  listaNombre: string,
): number {
  let filaActual = filaInicio;

  const banner = hoja.getRow(filaActual);
  banner.getCell(1).value = cliente.razonSocial.toUpperCase();
  hoja.mergeCells(filaActual, 1, filaActual, 6);
  banner.getCell(1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  banner.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB_BANNER_CLIENTE } };
  banner.getCell(1).alignment = { vertical: 'middle' };
  banner.height = 22;
  filaActual += 1;

  for (const f of cliente.contrapartes.filas) {
    escribirFilaHoja1(hoja, filaActual, cliente.razonSocial, f, listaNombre);
    filaActual += 1;
  }

  const resumen = hoja.getRow(filaActual);
  resumen.getCell(1).value = cliente.razonSocial;
  for (let col = 1; col <= 6; col += 1) {
    resumen.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB_RESUMEN } };
  }
  resumen.getCell(2).value =
    cliente.contrapartes.resumen.grupos === 0
      ? 'No quedó ninguna contraparte con menos de 3 apariciones — no hay resumen para esta cuenta.'
      : `El resto (${cliente.contrapartes.resumen.grupos} contrapartes con 1-2 apariciones, ` +
        `${cliente.contrapartes.resumen.movimientos} movimientos) queda para una segunda vuelta, ` +
        'no es necesario resolverlas ahora.';
  resumen.getCell(2).font = { italic: true };
  hoja.mergeCells(filaActual, 2, filaActual, 6);
  filaActual += 1;

  return filaActual;
}

function armarHojaContrapartes(libro: ExcelJS.Workbook, datos: ResultadoRelevamiento, generadoEn: string): void {
  const hoja = libro.addWorksheet('Contrapartes');
  hoja.columns = [
    { header: 'Cliente', key: 'cliente', width: 16 },
    { header: 'Contraparte', key: 'contraparte', width: 46 },
    { header: 'Cantidad de veces', key: 'cantidad', width: 16 },
    {
      header: 'Ejemplo real (como aparece en el resumen bancario, no convertido a débito/haber contable)',
      key: 'ejemplo',
      width: 40,
    },
    { header: 'Tu respuesta', key: 'respuesta', width: 32 },
    { header: 'Aclaración', key: 'aclaracion', width: 32 },
  ];
  // `columns` escribe los headers en la fila 1 — se empuja todo una fila abajo para el título, mismo
  // idiom que `armar-libro.ts::armarHojaControl`.
  hoja.spliceRows(1, 0, []);
  hoja.getCell('A1').value = `Relevamiento para Laura — Contrapartes · Generado ${generadoEn}`;
  hoja.getCell('A1').font = { bold: true };
  hoja.mergeCells(1, 1, 1, 6);
  hoja.getRow(2).font = { bold: true };
  hoja.getRow(2).alignment = { vertical: 'middle', wrapText: true };
  hoja.views = [{ state: 'frozen', ySplit: 2 }];

  let filaActual = 3;
  filaActual = escribirBloqueContrapartes(hoja, filaActual, datos.bracci, 'Lista_Bracci');
  escribirBloqueContrapartes(hoja, filaActual, datos.roka, 'Lista_ROKA');
}

// -----------------------------------------------------------------------------
// Hoja 2 — Tipos sin cuenta
// -----------------------------------------------------------------------------

/** Vocabulario cerrado de traducción "en criollo" — solo los tipos que este relevamiento puede
 *  mostrar HOY (nunca `retiro_de_socio`, excluido en la consulta). Un tipo sin entrada acá cae a su
 *  propio código con guiones bajos reemplazados por espacios — nunca se inventa una palabra nueva
 *  (mismo criterio que `armar-libro.ts::TEXTO_TIPO_CUENTA`). */
const TEXTO_TIPO_CRIOLLO: Readonly<Record<string, string>> = {
  pago_de_haberes: 'Pago de sueldos al personal (importe neto, no incluye cargas sociales ni aportes)',
};

export function textoTipoCriollo(tipo: string): string {
  return TEXTO_TIPO_CRIOLLO[tipo] ?? tipo.replaceAll('_', ' ');
}

function armarHojaTiposSinCuenta(libro: ExcelJS.Workbook, datos: ResultadoRelevamiento, generadoEn: string): void {
  const hoja = libro.addWorksheet('Tipos sin cuenta');
  hoja.columns = [
    { header: 'Cliente', key: 'cliente', width: 16 },
    { header: 'Tipo', key: 'tipo', width: 48 },
    { header: 'Cantidad', key: 'cantidad', width: 12 },
    { header: 'Ejemplo real', key: 'ejemplo', width: 34 },
    { header: 'A qué cuenta va', key: 'cuenta', width: 32 },
  ];
  hoja.spliceRows(1, 0, []);
  hoja.getCell('A1').value = `Relevamiento para Laura — Tipos sin cuenta · Generado ${generadoEn}`;
  hoja.getCell('A1').font = { bold: true };
  hoja.mergeCells(1, 1, 1, 5);
  hoja.getRow(2).font = { bold: true };
  hoja.getRow(2).alignment = { vertical: 'middle', wrapText: true };
  hoja.views = [{ state: 'frozen', ySplit: 2 }];

  const escribirFila = (cliente: ResultadoDeCliente, f: FilaTipoSinCuenta): void => {
    hoja.addRow({
      cliente: cliente.razonSocial,
      tipo: textoTipoCriollo(f.tipo),
      cantidad: f.cantidadMovimientos,
      ejemplo: ejemploReal(f.ejemploFecha, f.ejemploImporte),
      cuenta: null,
    });
  };

  for (const f of datos.bracci.tiposSinCuenta) escribirFila(datos.bracci, f);
  for (const f of datos.roka.tiposSinCuenta) escribirFila(datos.roka, f);
}

// -----------------------------------------------------------------------------
// Hoja 3 — Asientos automáticos
// -----------------------------------------------------------------------------
//
// Formato de asiento de libro diario clásico, no tabla plana (JP, ajuste post-entrega): por cada
// (cliente, tipo) van DOS filas — la del Debe arriba, sin sangría, y la del Haber abajo, con
// sangría — más una fila en blanco de separación antes del próximo asiento. "Debe" y "Haber" son
// columnas propias (nunca una columna "Importe" con el lado como texto al lado).

const COL_DEBE = 7;
const COL_HABER = 8;
const COL_RESPUESTA = 9;
const COL_CUENTA_ALTERNATIVA = 10;
const COL_COMENTARIOS = 11;

/** Contador secuencial de la hoja (1, 2, 3...), NUNCA un fragmento de `asientoIdEjemplo` (un uuid) —
 *  se probó y un recorte de 8 caracteres hex puede caer, por azar, en una secuencia que
 *  `contieneIdentificador()` lee con forma de documento (todos dígitos) y aborta la escritura
 *  (INV-13, fail-closed — funcionó como corresponde, encontrado corriendo la corrida real, no en la
 *  convocatoria). Un número de orden simple no tiene ese riesgo estructural: nunca tiene forma de
 *  CUIT/CBU/documento, sea cual sea el valor. */
function referenciaDeAsiento(numeroDeOrden: number): string {
  return `Asiento ${numeroDeOrden}`;
}

function armarHojaAsientos(libro: ExcelJS.Workbook, datos: ResultadoRelevamiento, generadoEn: string): void {
  const hoja = libro.addWorksheet('Asientos automáticos');
  hoja.columns = [
    { header: 'Cliente', key: 'cliente', width: 16 },
    { header: 'Tipo', key: 'tipo', width: 30 },
    { header: 'Cantidad (incluye reversas)', key: 'cantidad', width: 14 },
    { header: 'Fecha', key: 'fecha', width: 12, style: { numFmt: FMT_FECHA } },
    { header: 'Referencia', key: 'referencia', width: 16 },
    { header: 'Cuenta', key: 'cuentaTexto', width: 42 },
    { header: 'Debe', key: 'debe', width: 16, style: { numFmt: FMT_MONEDA } },
    { header: 'Haber', key: 'haber', width: 16, style: { numFmt: FMT_MONEDA } },
    { header: '¿Está bien así?', key: 'respuesta', width: 16 },
    { header: 'Si es NO: cuenta que hubieras usado', key: 'cuentaAlternativa', width: 32 },
    { header: 'Comentarios', key: 'comentarios', width: 28 },
  ];
  hoja.spliceRows(1, 0, []);
  hoja.getCell('A1').value = `Relevamiento para Laura — Asientos automáticos · Generado ${generadoEn}`;
  hoja.getCell('A1').font = { bold: true };
  hoja.mergeCells(1, 1, 1, 11);

  // Fila de aclaración fija, arriba de los encabezados (JP, ajuste post-entrega): esta hoja muestra
  // UN ejemplo por tipo, no el listado completo — "Cantidad" es el total de los 3 meses juntos, no
  // solo del ejemplo mostrado. Sin esto, alguien podría leer la hoja como si tuviera que revisar
  // caso por caso.
  hoja.spliceRows(2, 0, []);
  hoja.getCell('A2').value =
    'Esta hoja muestra, para cada tipo de movimiento, UN EJEMPLO representativo de cómo el sistema ' +
    'arma el asiento — no la lista completa de casos. La columna "Cantidad" es el total de veces ' +
    'que ese tipo de movimiento aparece SUMANDO los tres meses juntos (mayo, junio y julio 2026), ' +
    'no solo en la fecha del ejemplo. Si el criterio contable del ejemplo te parece correcto, se ' +
    'aplica igual a todos los casos de ese mismo tipo — no hace falta que revises caso por caso.';
  hoja.getCell('A2').font = { italic: true };
  hoja.getCell('A2').alignment = { wrapText: true, vertical: 'middle' };
  hoja.mergeCells(2, 1, 2, 11);
  hoja.getRow(2).height = 45;

  hoja.getRow(3).font = { bold: true };
  hoja.getRow(3).alignment = { vertical: 'middle', wrapText: true };
  hoja.views = [{ state: 'frozen', ySplit: 3 }];

  let filaActual = 4;
  let totalReversas = 0;
  let numeroDeAsiento = 0;
  const anclasParaFormatoCondicional: string[] = [];

  const escribirEntrada = (cliente: ResultadoDeCliente, f: FilaAsientoAutomatico): void => {
    totalReversas += f.cantidadReversas;
    numeroDeAsiento += 1;

    const renglonesOrdenados = [...f.renglones].sort((a, b) => a.orden - b.orden);
    const porLado = new Map<'debe' | 'haber', RenglonAsientoEjemplo>();
    for (const r of renglonesOrdenados) {
      const debeNumero = importeComoNumero(r.debe);
      const haberNumero = importeComoNumero(r.haber);
      if (debeNumero === null || haberNumero === null) {
        throw new ImporteFueraDeRangoError(cliente.razonSocial, f.tipo);
      }
      // Exactamente uno de los dos es no-cero por renglón (resolver.ts) — nunca los dos a la vez.
      porLado.set(debeNumero > 0 ? 'debe' : 'haber', r);
    }
    const renglonDebe = porLado.get('debe');
    const renglonHaber = porLado.get('haber');
    if (!renglonDebe || !renglonHaber) {
      throw new ImporteFueraDeRangoError(cliente.razonSocial, f.tipo);
    }

    const filaAncla = filaActual;

    // Fila del Debe — SIN sangría.
    const filaDebe = hoja.getRow(filaActual);
    filaDebe.getCell(1).value = cliente.razonSocial;
    filaDebe.getCell(2).value = textoTipoCriollo(f.tipo);
    filaDebe.getCell(3).value = f.cantidadTotal;
    const serial = fechaIsoASerial(f.fechaImputacion);
    filaDebe.getCell(4).value = serial;
    filaDebe.getCell(4).numFmt = FMT_FECHA;
    filaDebe.getCell(5).value = referenciaDeAsiento(numeroDeAsiento);
    filaDebe.getCell(6).value =
      renglonDebe.cuentaCodigo !== null && renglonDebe.cuentaDenominacion !== null
        ? `${renglonDebe.cuentaCodigo} · ${renglonDebe.cuentaDenominacion}`
        : '(sin cita de cuenta)';
    filaDebe.getCell(6).alignment = { indent: 0 };
    filaDebe.getCell(COL_DEBE).value = importeComoNumero(renglonDebe.debe);
    filaDebe.getCell(COL_DEBE).numFmt = FMT_MONEDA;
    filaActual += 1;

    // Fila del Haber — CON sangría (Excel "aumentar sangría", `alignment.indent`), un nivel.
    const filaHaber = hoja.getRow(filaActual);
    filaHaber.getCell(6).value =
      renglonHaber.cuentaCodigo !== null && renglonHaber.cuentaDenominacion !== null
        ? `${renglonHaber.cuentaCodigo} · ${renglonHaber.cuentaDenominacion}`
        : '(sin cita de cuenta)';
    filaHaber.getCell(6).alignment = { indent: 1 };
    filaHaber.getCell(COL_HABER).value = importeComoNumero(renglonHaber.haber);
    filaHaber.getCell(COL_HABER).numFmt = FMT_MONEDA;
    filaActual += 1;

    const filaFin = filaActual - 1;
    hoja.mergeCells(filaAncla, 1, filaFin, 1);
    hoja.mergeCells(filaAncla, 2, filaFin, 2);
    hoja.mergeCells(filaAncla, 3, filaFin, 3);
    hoja.mergeCells(filaAncla, 4, filaFin, 4);
    hoja.mergeCells(filaAncla, 5, filaFin, 5);
    hoja.mergeCells(filaAncla, COL_RESPUESTA, filaFin, COL_RESPUESTA);
    hoja.mergeCells(filaAncla, COL_CUENTA_ALTERNATIVA, filaFin, COL_CUENTA_ALTERNATIVA);
    hoja.mergeCells(filaAncla, COL_COMENTARIOS, filaFin, COL_COMENTARIOS);

    // Desplegable simple OK/NO (JP, ajuste post-entrega) — reemplaza el "✔/✗/comentario" de texto
    // libre. Lista inline (dos valores fijos): no hace falta la hoja oculta de `Listas` para esto.
    const celdaRespuesta = hoja.getCell(filaAncla, COL_RESPUESTA);
    celdaRespuesta.protection = { locked: false };
    celdaRespuesta.dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"OK,NO"'],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Opción inválida',
      error: 'Elegí "OK" o "NO" de la lista desplegable.',
      showInputMessage: true,
      promptTitle: '¿Está bien así?',
      prompt: 'Elegí OK si el asiento es correcto, o NO si hay que corregirlo.',
    };
    hoja.getCell(filaAncla, COL_CUENTA_ALTERNATIVA).protection = { locked: false };
    // Comentarios SIEMPRE editable y visible, haya elegido OK o NO (JP: por si quiere aclarar algo
    // igual habiendo puesto OK) — no depende de la respuesta.
    hoja.getCell(filaAncla, COL_COMENTARIOS).protection = { locked: false };

    // Fila en blanco de separación entre asientos — nunca mergeada, nunca con datos.
    filaActual += 1;

    anclasParaFormatoCondicional.push(`${hoja.getColumn(COL_CUENTA_ALTERNATIVA).letter}${filaAncla}`);
  };

  for (const f of datos.bracci.asientosAutomaticos) escribirEntrada(datos.bracci, f);
  for (const f of datos.roka.asientosAutomaticos) escribirEntrada(datos.roka, f);

  if (anclasParaFormatoCondicional.length > 0) {
    const colRespuesta = hoja.getColumn(COL_RESPUESTA).letter;
    const colAlternativa = hoja.getColumn(COL_CUENTA_ALTERNATIVA).letter;
    hoja.addConditionalFormatting({
      ref: anclasParaFormatoCondicional.join(' '),
      rules: [
        {
          type: 'expression',
          // Resalta la celda de "cuenta alternativa" de la fila ancla de cada asiento cuando la
          // respuesta es "NO" y todavía no completó esa columna — nunca bloqueante, solo visual.
          // La fila del literal (4) tiene que coincidir con la primera fila de datos real (`filaActual`
          // arranca en 4 más arriba) — es la que Excel usa como ancla para desplazar el resto de los
          // `ref` no contiguos por offset relativo.
          formulae: [`AND($${colRespuesta}4="NO",$${colAlternativa}4="")`],
          priority: 1,
          style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } } },
        },
      ],
    });
  }

  const filaNota = filaActual + 1;
  hoja.getCell(`A${filaNota}`).value =
    'Los totales incluyen algunas reversas/anulaciones reales — no es un error de conteo.' +
    (totalReversas > 0
      ? ` En total, ${totalReversas} de los asientos contados arriba son reversas/anulaciones.`
      : '');
  hoja.getCell(`A${filaNota}`).font = { italic: true };
  hoja.mergeCells(filaNota, 1, filaNota, 11);
}

// -----------------------------------------------------------------------------
// Punto de entrada
// -----------------------------------------------------------------------------

/**
 * Arma el libro entero. Async — a diferencia de `armarLibro()` — porque `hoja.protect()` de ExcelJS
 * devuelve una `Promise`.
 *
 * Corre `verificarSinIdentificadores` como último paso, ANTES de devolver el workbook — si lanza, el
 * llamador nunca llega a `serializarLibroLaura`/escribir a disco (obligatorio, punto 6 del plan).
 */
export async function armarLibroLaura(
  datos: ResultadoRelevamiento,
  opciones: OpcionesLibroLaura,
): Promise<ExcelJS.Workbook> {
  if (opciones.listaBracci.length < 2) throw new ListaDeContraparteVaciaError('bracci');
  if (opciones.listaRoka.length < 2) throw new ListaDeContraparteVaciaError('roka');

  const libro = new ExcelJS.Workbook();
  libro.creator = 'sistema-contable';
  libro.lastModifiedBy = 'sistema-contable';
  libro.created = new Date(opciones.generadoEn);

  armarHojaListas(libro, opciones.listaBracci, opciones.listaRoka);
  armarHojaContrapartes(libro, datos, opciones.generadoEn);
  armarHojaTiposSinCuenta(libro, datos, opciones.generadoEn);
  armarHojaAsientos(libro, datos, opciones.generadoEn);

  const hojaContrapartes = libro.getWorksheet('Contrapartes');
  if (hojaContrapartes) {
    // Protegida: solo "Tu respuesta"/"Aclaración" quedan editables (ya marcadas `locked: false` al
    // escribir cada fila, `escribirFilaHoja1`). Password vacía — esto no es un control de seguridad,
    // es una traba contra el error de tipeo accidental sobre una celda de solo lectura.
    await hojaContrapartes.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  }

  verificarSinIdentificadores(libro);

  return libro;
}

/** Serializa. Reexportado con nombre propio para que el CLI de este relevamiento no tenga que
 *  importar `armar-libro.ts` solo por esta función — mismo cuerpo que `serializarLibro()` de ahí. */
export async function serializarLibroLaura(libro: ExcelJS.Workbook): Promise<Uint8Array> {
  const buffer = await libro.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
