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
  /** Qué es el movimiento, según el motor de reconocimiento (`textoDeReconocimiento` de
   *  `@sistema-contable/contabilidad`) — `null` cuando el enriquecimiento no corrió para esta fila
   *  (ver `EstadoEnriquecimiento` más abajo), nunca cuando SÍ corrió: ahí siempre hay texto ("Sin
   *  tipo asignable"/"Indeterminado" incluidos), un hueco sería indistinguible de un bug. */
  readonly identificacion: string | null;
  /** Qué tan firme es `identificacion` — "Alta"/"A confirmar", o `null` para "Indeterminado" (no hay
   *  hipótesis de la que dudar) o cuando el enriquecimiento no corrió. Columna separada, ajuste 7
   *  (JP): un calificador de texto pegado a `identificacion` rompía el filtro de Excel por "Tipo de
   *  movimiento" — dos valores de texto distintos para lo que debía ser un solo filtro. */
  readonly confianza: string | null;
  /** Qué le falta decidir a la persona antes de poder tipear "Cuenta contable" — `null` cuando la
   *  fila ya está identificada sin decisión pendiente (clase `propuesta`) o cuando el enriquecimiento
   *  no corrió. */
  readonly pendiente: string | null;
  /** `padron_contraparte` (0037) — `null` salvo que el motor haya matcheado (o ambiguado) contra un
   *  proveedor/cliente conocido por nombre en `distinguir_tercero_de_socio`. Columna separada de
   *  `pendiente` a propósito (mismo principio que ya separó `confianza`): es una pregunta distinta
   *  ("¿lo conocemos?"), no una variante del "qué falta". Solo la CLASIFICACIÓN, nunca el nombre
   *  matcheado — decisión de JP, 2026-09-06 (ver `textoDeContraparteConocida`,
   *  `@sistema-contable/contabilidad`). */
  readonly contraparteConocida: string | null;
  /** Vocabulario cerrado (`CategoriaEspecial`, más abajo) — calculado en `exportar-planilla.ts` a
   *  partir de `que_decide` (nunca de `tipo`: `contador-dominio`, Tanda 1 — un filtro por `tipo`
   *  metería `acreditacion_tarjeta_getnet` en la categoría equivocada, y las filas `sin_reconocer`
   *  de tarjeta ni siquiera tienen `tipo` en la base). `null` salvo `tarjeta_pendiente`, y también
   *  `null` cuando el enriquecimiento no corrió — mismo gate/degradación que `identificacion`. */
  readonly categoriaEspecial: CategoriaEspecial | null;
  /** `false` SOLO para `distinguir_tercero_de_socio` (`decision_humana`) — esa fila nunca se agrupa
   *  con otra aunque comparta `(bancoCodigo, conceptoBanco)`: dos contrapartes distintas pueden
   *  compartir el mismo texto genérico del banco, y agruparlas arriesgaría aprobar en bloque "son
   *  terceros" sobre un movimiento que en realidad es de un socio no declarado
   *  (`seguridad-datos-financieros`, Tanda 1). `true` por default, incluido cuando el enriquecimiento
   *  no corrió — sin ese dato no hay nada que excluir. */
  readonly agrupable: boolean;
};

/**
 * Por qué una fila puede llegar SIN `identificacion`/`pendiente` — vocabulario cerrado, nunca texto
 * libre, porque además de explicar la leyenda de la hoja de control, decide qué línea de sello
 * imprimir. `si` es el único estado con `motorDigest` no nulo.
 */
export const ESTADOS_ENRIQUECIMIENTO = ['si', 'no_destinatario', 'no_tope_superado', 'no_sin_lexico'] as const;
export type EstadoEnriquecimiento = (typeof ESTADOS_ENRIQUECIMIENTO)[number];

/**
 * Categoría especial de presentación (Tanda 1, `docs/diseno/31-replanteo-hacia-producto.md`) —
 * vocabulario cerrado, nunca texto libre. Hoy cubre un solo caso: el hueco medido en
 * `docs/diseno/14-liquidaciones-tarjeta-plan.md` (plan aprobado, sin implementar) — movimientos de
 * tarjeta cuyo asiento queda incompleto hasta contar con la liquidación del adquirente/de la tarjeta.
 */
export const CATEGORIAS_ESPECIALES = ['tarjeta_pendiente'] as const;
export type CategoriaEspecial = (typeof CATEGORIAS_ESPECIALES)[number];

export type CabeceraCuenta = {
  readonly cuentaBancariaId: string;
  readonly bancoCodigo: string;
  readonly cuentaAlias: string | null;
  /** `cuenta_bancaria_identificador.tipo_cuenta` (N1, "no identifica a nadie" — el propio schema) del
   *  identificador vigente al cierre del período, si lo hay. `null` cuando no corrió el enriquecimiento
   *  (mismo gate que `identificacion`/`pendiente` de `FilaPlanilla`) o cuando la cuenta no tiene ningún
   *  identificador cargado. Se usa para desambiguar el TÍTULO de la hoja cuando falta `cuentaAlias`
   *  (ajuste 1, 2026-08-21) — nunca `cbuUltimos4` ahí, esa va solo dentro del contenido de la hoja
   *  (`seguridad-datos-financieros`: la pestaña es la única superficie visible sin abrir el archivo). */
  readonly tipoCuenta: string | null;
  /** `cuenta_bancaria_identificador.cbu_ultimos4` (N2 enmascarado, "lo que se muestra en una
   *  pantalla" — el propio schema). Mismo gate y mismo origen que `tipoCuenta`. Va DENTRO de la hoja
   *  (título de "Control de saldos" y de la hoja de movimientos), nunca en el nombre de la pestaña. */
  readonly cbuUltimos4: string | null;
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
  readonly estadoEnriquecimiento: EstadoEnriquecimiento;
  /** `digestDeBanco()` de `@sistema-contable/contabilidad` — identidad del código del motor que
   *  produjo `identificacion`/`pendiente` en esta corrida. `null` salvo `estadoEnriquecimiento ===
   *  'si'`. Se calcula EN EL LLAMADOR (`exportar-planilla.ts`), nunca acá — este archivo se declara a
   *  sí mismo "puro, sin base, sin disco" y correr el motor rompería esa garantía. */
  readonly motorDigest: string | null;
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

/**
 * Clave de agrupación — ÚNICA para la cola de revisión (Tanda 1, `docs/diseno/
 * 31-replanteo-hacia-producto.md`). Por MOVIMIENTO, no por decisión: nunca lee `clase`/`que_decide`/
 * `motivo_codigo` — es una propiedad del banco y del texto que publicó, no del estado de la decisión
 * que el motor resolvió (decisión de JP, confirmada tres veces en la sesión que diseñó esto).
 *
 * Normalización LIVIANA (trim + colapsar espacios + mayúsculas) — nunca `normalizarParaLexico` del
 * motor: esta clave se calcula AGUAS ABAJO del reconocimiento, sobre `FilaPlanilla` ya reducida, nunca
 * sobre el objeto de evidencia — usar la normalización del léxico acá mezclaría el bug del digest
 * (HANDOFF 187) por la puerta de atrás.
 */
function normalizarParaAgrupar(texto: string): string {
  return texto.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function claveDeAgrupacion(bancoCodigo: string, conceptoBanco: string | null): string {
  const concepto = conceptoBanco === null ? '(sin concepto)' : normalizarParaAgrupar(conceptoBanco);
  return `${bancoCodigo}::${concepto}`;
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

/**
 * `tipo_cuenta` completo (para `etiquetaCuenta`, sin límite de largo) y abreviado (para `nombreHoja`,
 * ≤31 chars entre banco+moneda+CBU). Vocabulario cerrado: espeja `cuenta_ident_tipo_chk` — 🔴 la
 * versión VIGENTE es la de `0006_ajustes_cuenta.sql` (seis valores), que reemplazó el check original de
 * cuatro de `0004_ingesta.sql` (encontrado por un test que rompió contra la base real, no por lectura
 * de código — la migración `0004` sola es la fuente vieja). Mismo dominio que `TIPOS_CUENTA`
 * (`packages/ingesta/src/esquema.ts`). Un valor fuera de los seis conocidos (no debería pasar, es un
 * check de la base) cae al propio código sin traducir — nunca inventa una palabra.
 */
const TEXTO_TIPO_CUENTA: Readonly<Record<string, string>> = {
  cuenta_corriente: 'Cuenta corriente',
  cuenta_corriente_especial: 'Cuenta corriente especial',
  caja_ahorro: 'Caja de ahorro',
  cuenta_inversion: 'Cuenta de inversión',
  tarjeta_corporativa: 'Tarjeta corporativa',
  no_determinado: 'Tipo de cuenta no determinado',
};
const TEXTO_TIPO_CUENTA_ABREVIADO: Readonly<Record<string, string>> = {
  cuenta_corriente: 'Cta.Cte',
  cuenta_corriente_especial: 'Cta.Esp',
  caja_ahorro: 'C.Ahorro',
  cuenta_inversion: 'Cta.Inv',
  tarjeta_corporativa: 'Tarjeta',
  no_determinado: 'S/Tipo',
};

/**
 * Cuando falta `cuentaAlias`, desambigua con `tipoCuenta`/`cbuUltimos4` en vez de dejar que dos cuentas
 * reales distintas queden con el mismo texto (`ux-designer` + `seguridad-datos-financieros`, ajuste 1,
 * 2026-08-21). `cbuUltimos4` es N2 enmascarado pero SOLO va acá adentro (contenido de la hoja), nunca
 * en `nombreHoja` — la pestaña es la única superficie visible sin abrir el archivo.
 */
function etiquetaCuenta(c: CabeceraCuenta): string {
  if (c.cuentaAlias !== null) return `${c.bancoCodigo} · ${c.cuentaAlias} · ${c.moneda}`;
  if (c.tipoCuenta === null) return `${c.bancoCodigo} · (sin alias) · ${c.moneda}`;
  const tipo = TEXTO_TIPO_CUENTA[c.tipoCuenta] ?? c.tipoCuenta;
  const cbu = c.cbuUltimos4 !== null ? ` ····${c.cbuUltimos4}` : '';
  return `${c.bancoCodigo} · ${tipo}${cbu} · ${c.moneda}`;
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
/** Nombre de pestaña — NUNCA `cbuUltimos4` (ver `etiquetaCuenta`): sin alias, el único discriminador
 *  es `tipoCuenta` (N1). Si dos cuentas colisionan igual (mismo banco/moneda/tipo, sin alias), el "(2)"
 *  ciego de Excel del loop de abajo queda como residual aceptable — la desambiguación real está DENTRO
 *  de la hoja (`seguridad-datos-financieros`, ajuste 1, 2026-08-21). */
function nombreHoja(cabecera: CabeceraCuenta, usados: Set<string>): string {
  const identificador =
    cabecera.cuentaAlias ??
    (cabecera.tipoCuenta !== null
      ? `${cabecera.bancoCodigo} ${TEXTO_TIPO_CUENTA_ABREVIADO[cabecera.tipoCuenta] ?? cabecera.tipoCuenta}`
      : cabecera.bancoCodigo);
  const base = `${cabecera.moneda} ${identificador}`.replace(/[[\]:*?/\\]/g, '-').slice(0, 28);
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
  // Reescrita varias veces (ux-designer): primero cuando "el sistema todavía no propone nada" dejó de
  // ser cierto con `identificacion`/`pendiente`; después (ajuste 4/5/6) para sacar "Cuenta contable"/
  // "Observación" y explicar el calificador "(sin confirmar)"; ahora (ajuste 7, JP + ux-designer +
  // contador-dominio, HANDOFF 95) porque ese calificador rompía el filtro de Excel por "Tipo de
  // movimiento" — pasa a la columna separada "Confianza".
  const leyenda = [
    'Cómo leer esta planilla',
    '— "Débito"/"Crédito" son del BANCO: si el movimiento sale o entra a la cuenta. NO son "Debe"/"Haber"',
    '  contables — esa conversión es la etapa siguiente, todavía sin diseñar.',
    '— "s/d" significa que el dato no está disponible para esa fila (el banco no lo publica, o el',
    '  sistema no lo capturó todavía) — nunca significa un error.',
    '— "Tipo de movimiento" es lo que el sistema reconoció que ES el movimiento (ej. "Comisión',
    '  bancaria", "Pago de haberes"), a partir del texto o el código que publica el banco.',
    '  "Indeterminado" es una respuesta válida, no un hueco: el sistema no encontró evidencia',
    '  suficiente para decidir.',
    '— "Confianza" dice qué tan firme es ESE tipo, sin tocar el texto de "Tipo de movimiento" (así el',
    '  filtro por esa columna agrupa bien, sin importar la confianza). "Alta" = el sistema lo da por',
    '  firme. "A confirmar" = es un default provisorio, puede cambiar cuando resuelvas "Qué falta"',
    '  (mismo criterio que "(según padrón)" en retiro/aporte de socio: la etiqueta no suena más segura',
    '  de lo que el sistema realmente sabe). Vacía cuando el tipo ya es "Indeterminado": ahí no hay',
    '  hipótesis de la que dudar, falta identificarlo entero.',
    '— "Qué falta" separa dos preguntas distintas: si "Confianza" dice "A confirmar", la pregunta es',
    '  CONFIRMAR QUÉ ES (la hipótesis puede estar mal); si dice "Alta", el tipo ya es firme y la',
    '  pregunta es qué DATO puntual falta para completar la imputación (qué impuesto, a qué cuenta,',
    '  qué jurisdicción). Vacía cuando el movimiento ya está identificado del todo.',
    '— "Corrección / Identidad" y "Comentarios" son las únicas columnas que llenás VOS.',
    '  Achican tu trabajo si las leés así:',
    '  · Fila con "Confianza" = "Alta": dejala VACÍA si estás de acuerdo con lo que dice "Tipo de',
    '    movimiento" — el silencio ES tu aprobación, no hace falta que escribas "OK" ni nada parecido.',
    '    Solo escribís algo si querés CORREGIR (ej. dice "Transferencia de terceros" y vos sabés que',
    '    es un pago a un proveedor puntual).',
    '  · Fila con "Confianza" = "A confirmar", o "Tipo de movimiento" = "Indeterminado": ahí el sistema',
    '    te está preguntando de verdad. Si sabés la respuesta, completá esa fila — es la que más',
    '    ayuda.',
    '  · "Comentarios" es siempre opcional, en cualquier fila, para una aclaración que no cambia el',
    '    tipo (ej. "este mes vino duplicado en el resumen").',
    '  Ojo con las dos lecturas erróneas: NO hace falta escribir "OK" en las que ya están en "Alta" —',
    '  eso sería llenar ~900 filas al pedo. Y una fila vacía en "A confirmar" NO está resuelta: sigue',
    '  pendiente, solo que todavía nadie la miró.',
    '— Esta planilla todavía NO incluye una columna para que asignes la cuenta contable — el sistema',
    '  identifica QUÉ ES el movimiento, nunca A QUÉ CUENTA VA, y esa siguiente etapa (Capa D) todavía',
    '  no está diseñada. Esta primera vuelta valida si estas columnas te sirven.',
    '— Tip: si tenés muchos movimientos del mismo tipo, filtrá por "Tipo de movimiento" (▼ en el',
    '  encabezado) — el filtro agrupa todo bajo el mismo texto, sin importar la confianza.',
    '— Los encabezados de la hoja de movimientos están coloreados según de dónde sale el dato:',
    '  · Gris: lo publicó el banco tal cual (Fecha, Concepto, Débito, Crédito, Saldo, Descripción y',
    '    el resto de los datos del extracto). Es lectura, no hay nada para decidir ahí.',
    '  · Azul: lo identificó el sistema ("Tipo de movimiento", "Confianza", "Qué falta") — también es',
    '    lectura, el sistema te dice qué ES el movimiento y qué tan seguro está, nunca elige una cuenta.',
    '  · Amarillo/dorado: son las dos columnas que llenás VOS ("Corrección / Identidad"',
    '    y "Comentarios") — ahí sí hay algo para decidir, con la regla de silencio=aprobación de arriba.',
    '  (Las columnas grises al final — "N° de fila", "Importe con signo" — son control interno del',
    '  sistema; ignoralas salvo que algo no cuadre.)',
    '',
    // Procedencia: si este archivo aparece donde no debe, `correlacion` lo ata a su fila de auditoría
    // sin exponer nada del cliente (los cuatro son uuids/códigos internos, nunca datos N2).
    `Procedencia — cliente=${datos.clienteId} lote=${datos.loteId} correlacion=${datos.correlacion} ` +
      `motivo=${datos.motivoCodigo} destinatario=${datos.destinatarioCodigo}`,
    textoSelloDelMotor(datos),
  ];
  leyenda.forEach((linea, i) => {
    hoja.getCell(`A${leyendaDesde + i}`).value = linea;
  });
}

/**
 * Sello de reproducibilidad — vive en el `.xlsx`, NUNCA en la base (`packages/data`, sin cambios: `0`
 * migraciones, `0` filas nuevas en `reconocimiento_movimiento`). El cálculo se hace en memoria en cada
 * corrida (`exportar-planilla.ts`) y nunca se persiste — deuda deliberada por urgencia, declarada en
 * HANDOFF, con la persistencia real (P4/P5 del roadmap) pendiente. Este renglón es lo que permite
 * responder, mirando el propio archivo, CON QUÉ VERSIÓN del motor y CUÁNDO se generó — sin esto, dos
 * corridas del mismo lote en fechas distintas podrían diferir sin ningún rastro de cuál las produjo.
 */
function textoSelloDelMotor(datos: DatosPlanilla): string {
  if (datos.estadoEnriquecimiento === 'si' && datos.motorDigest !== null) {
    return (
      `Motor de reconocimiento — versión ${datos.motorDigest} · corrida el ${datos.generadoEn} ` +
      `sobre el lote ${datos.loteId}`
    );
  }
  const razon: Record<Exclude<EstadoEnriquecimiento, 'si'>, string> = {
    no_destinatario: 'no se ejecutó — el destinatario de este export no recibe la propuesta del sistema',
    no_tope_superado: 'no se ejecutó — el lote supera el tope de movimientos para esta corrida',
    no_sin_lexico: 'no se ejecutó — no hay léxico registrado para este banco',
  };
  // `estadoEnriquecimiento: 'si'` con `motorDigest: null` no debería poder pasar (el llamador siempre
  // los setea juntos), pero el tipo no lo impide (`code-reviewer`, plan "export enriquecido") — fallback
  // explícito en vez de un `razon['si']` == `undefined` silencioso ("Motor de reconocimiento —
  // undefined.").
  const texto =
    datos.estadoEnriquecimiento === 'si'
      ? 'versión no disponible pese a haber corrido — inconsistencia interna, avisale a sistemas'
      : razon[datos.estadoEnriquecimiento];
  return `Motor de reconocimiento — ${texto}.`;
}

// -----------------------------------------------------------------------------
// Hoja de movimientos, una por cuenta
// -----------------------------------------------------------------------------

type ColumnaMov = { readonly header: string; readonly key: string; readonly width: number; readonly numFmt?: string };

/**
 * Color de fondo del ENCABEZADO de columna, agrupado por de dónde sale el dato (`ux-designer`, ajuste
 * 2, 2026-08-21) — para que Laura vea de un vistazo qué es lectura y qué es su trabajo pendiente, sin
 * tener que leer la leyenda cada vez. ARGB de ExcelJS (`FFRRGGBB`).
 *
 * `ARGB_IDENTIFICADO_POR_EL_SISTEMA` corregido en ajuste 4 (JP + `ux-designer`, HANDOFF 94): el celeste
 * pastel original (`FFD9E1F2`) daba ratio de contraste 1.05:1 contra el gris — prácticamente el mismo
 * color. `FF5B9BD5` ("Blue, Accent 1" de Office, no un tono inventado) da 2.37:1 contra el gris y 7.1:1
 * contra el texto negro en negrita del encabezado (por encima del mínimo AA, 4.5:1) — y se sostiene en
 * daltonismo rojo-verde e impresión en blanco y negro, donde dos pasteles casi-gris colapsan juntos.
 * Verde quedó descartado a propósito: en esta paleta ya significa "lectura del sistema, revisalo" — un
 * verde ahí se leería como "ya está validado", justo lo contrario.
 *
 * `ARGB_APORTE_DE_LAURA` (`ux-designer`, feedback de Laura): tercer eje de tinte (dorado), no una
 * variación de luminosidad de los otros dos — así no compite con el gris (banco) ni el azul (sistema)
 * en la lectura de un vistazo. `FFFFE699` ("Gold, Accent 4, Lighter 40%" de Office) da ~17:1 de
 * contraste contra el texto negro en negrita del encabezado, el más alto de los tres colores, y por
 * estar en el eje amarillo-azul (no rojo-verde) se sostiene en daltonismo rojo-verde. Verde
 * descartado por la misma razón que en el azul ("ya validado" es lo opuesto al mensaje); rojo/naranja
 * descartado porque connota error, y esto no es un error — es una oportunidad de completar. Una sola
 * variante para las dos columnas (no un tono por columna): la paleta ya usa "un color = una categoría
 * de origen del dato" en todo el archivo: dos amarillos apenas distintos sugerirían una cuarta
 * categoría inexistente. La jerarquía principal/secundaria la da la posición y el ancho, no el color.
 */
const ARGB_EXTRAIDO_DEL_BANCO = 'FFE7E6E6';
const ARGB_IDENTIFICADO_POR_EL_SISTEMA = 'FF5B9BD5';
const ARGB_CONTROL_INTERNO = 'FFF2F0EC';
const ARGB_APORTE_DE_LAURA = 'FFFFE699';

const COLOR_POR_COLUMNA: Readonly<Record<string, string>> = {
  fecha: ARGB_EXTRAIDO_DEL_BANCO,
  concepto: ARGB_EXTRAIDO_DEL_BANCO,
  debito: ARGB_EXTRAIDO_DEL_BANCO,
  credito: ARGB_EXTRAIDO_DEL_BANCO,
  saldo: ARGB_EXTRAIDO_DEL_BANCO,
  naturaleza: ARGB_EXTRAIDO_DEL_BANCO,
  descripcion: ARGB_EXTRAIDO_DEL_BANCO,
  fechaValor: ARGB_EXTRAIDO_DEL_BANCO,
  cuenta: ARGB_EXTRAIDO_DEL_BANCO,
  moneda: ARGB_EXTRAIDO_DEL_BANCO,
  codigoConcepto: ARGB_EXTRAIDO_DEL_BANCO,
  paginaPdf: ARGB_EXTRAIDO_DEL_BANCO,
  identificacion: ARGB_IDENTIFICADO_POR_EL_SISTEMA,
  confianza: ARGB_IDENTIFICADO_POR_EL_SISTEMA,
  pendiente: ARGB_IDENTIFICADO_POR_EL_SISTEMA,
  contraparteConocida: ARGB_IDENTIFICADO_POR_EL_SISTEMA,
  qEsQuienEs: ARGB_APORTE_DE_LAURA,
  comentarios: ARGB_APORTE_DE_LAURA,
  filaNumero: ARGB_CONTROL_INTERNO,
  importe: ARGB_CONTROL_INTERNO,
};

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
  // "Tipo de movimiento"/"Confianza"/"Qué falta" (ux-designer, plan "export enriquecido",
  // 2026-08-21). "Cuenta contable"/"Observación" se sacaron de esta entrega (JP, ajuste 5: nada lee lo
  // que Laura escriba ahí todavía — es Capa D, sin diseñar). "Confianza" separada de "Tipo de
  // movimiento" (ajuste 7, JP): un calificador de texto pegado a `identificacion` rompía el filtro de
  // Excel por esa columna — dos valores de texto distintos para el mismo tipo. `width: 16` (ux-
  // designer): contenido fijo y corto ("Alta"/"A confirmar"), no ancho variable como las otras dos.
  columnas.push(
    { header: 'Tipo de movimiento', key: 'identificacion', width: 30 },
    { header: 'Confianza', key: 'confianza', width: 16 },
    // padron_contraparte (0037): columna nueva, misma familia de origen ("identificado por el
    // sistema") que sus vecinas — separada de "Qué falta" por el mismo principio que ya separó
    // "Confianza" de "Tipo de movimiento" (una pregunta por columna), pero ANTES de "Qué falta" y
    // no después: "Qué falta" tiene que seguir inmediatamente adyacente a "Corrección / Identidad"
    // (ux-designer, test dedicado en `planilla.test.ts`) — ningún dato del sistema puede intercalarse
    // entre la última pregunta del sistema y la primera columna de Laura.
    { header: 'Contraparte conocida', key: 'contraparteConocida', width: 34 },
    { header: 'Qué falta', key: 'pendiente', width: 42 },
    // Feedback de Laura (`ux-designer`): vacías en las 1830 filas, siempre — nadie las pre-llena.
    // "Alta" + vacía = aprobación tácita (silencio); "A confirmar"/"Indeterminado" es donde el
    // sistema pregunta de verdad. Ver el bullet nuevo de la leyenda, `armarHojaControl`.
    { header: 'Corrección / Identidad', key: 'qEsQuienEs', width: 34 },
    { header: 'Comentarios', key: 'comentarios', width: 24 },
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
  // Color de fondo por origen del dato (ver `COLOR_POR_COLUMNA`) — solo el encabezado, no la columna
  // entera: pintar cada celda de datos sería ruido visual sin agregar información nueva.
  columnas.forEach((c, i) => {
    const celda = hoja.getCell(7, i + 1);
    celda.value = c.header;
    hoja.getColumn(i + 1).width = c.width;
    if (c.numFmt) hoja.getColumn(i + 1).numFmt = c.numFmt;
    const argb = COLOR_POR_COLUMNA[c.key];
    if (argb) celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
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
      identificacion: f.identificacion,
      confianza: f.confianza,
      pendiente: f.pendiente,
      qEsQuienEs: null, // feedback de Laura — siempre vacía al exportar, nunca pre-llenada
      comentarios: null,
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
// Agrupación (Tanda 1) — dos hojas nuevas: "Grupos" y "Tarjeta pendiente".
// -----------------------------------------------------------------------------

export type GrupoDeMovimientos = {
  readonly clave: string;
  readonly bancoCodigo: string;
  readonly conceptoBanco: string | null;
  readonly cantidad: number;
  readonly totalDebito: number;
  readonly totalCredito: number;
  /** `identificacion` compartida por todas las filas del grupo, o `'Mixto — ver detalle'` si divergen.
   *  No es hipotético: `motor.ts` puede resolver el mismo `(banco, texto)` distinto según `lado`
   *  (matcheo por prefijo truncado, o el chequeo de `ladoEsperado` que corre DESPUÉS de que el léxico
   *  ya resolvió una entrada) — ver el test con el par real de `catalogo.ts` (`galicia` /
   *  `ACREDITAMIENTO`). */
  readonly tipoDeMovimiento: string;
  /** `null` salvo que TODAS las filas del grupo compartan la misma `categoriaEspecial` no nula —
   *  unanimidad, nunca mayoría (`tech-lead` + `contador-dominio`, Tanda 1: un grupo mixto nunca rutea
   *  silenciosamente a "Tarjeta pendiente"). */
  readonly categoriaEspecial: CategoriaEspecial | null;
  readonly ejemplo: FilaPlanilla;
  readonly ejemploCuentaEtiqueta: string;
};

function totalesDelGrupo(miembros: readonly FilaPlanilla[]): { totalDebito: number; totalCredito: number } {
  let totalDebito = 0;
  let totalCredito = 0;
  for (const m of miembros) {
    const importe = importeCanonicoANumeroExcel(m.importe) ?? 0;
    if (importe < 0) totalDebito += -importe;
    else totalCredito += importe;
  }
  return { totalDebito, totalCredito };
}

/** El miembro más antiguo del grupo (fecha, después `filaNumero` para desempatar) — determinístico,
 *  no depende del orden de llegada de `datos.filas`. */
function ejemploDelGrupo(miembros: readonly FilaPlanilla[]): FilaPlanilla {
  const [primero] = [...miembros].sort((a, b) =>
    a.fecha === b.fecha ? a.filaNumero - b.filaNumero : a.fecha < b.fecha ? -1 : 1,
  );
  // `miembros` nunca está vacío (invariante de `agruparFilas`) — el `!` documenta esa garantía, no la
  // reemplaza: si algún día deja de cumplirse, es preferible un `TypeError` acá a un `undefined`
  // silencioso más abajo en `armarHojaGrupos`.
  return primero!;
}

function construirGrupo(
  clave: string,
  miembros: readonly FilaPlanilla[],
  cabecerasPorCuenta: ReadonlyMap<string, CabeceraCuenta>,
): GrupoDeMovimientos {
  const primero = miembros[0];
  if (!primero) throw new Error('construirGrupo: grupo vacío — invariante de agruparFilas rota');
  const bancoCodigo = cabecerasPorCuenta.get(primero.cuentaBancariaId)?.bancoCodigo ?? '(banco desconocido)';

  const identificaciones = new Set(miembros.map((m) => m.identificacion));
  const categorias = new Set(miembros.map((m) => m.categoriaEspecial));
  const homogeneo = identificaciones.size <= 1 && categorias.size <= 1;

  const ejemplo = ejemploDelGrupo(miembros);
  const cabeceraEjemplo = cabecerasPorCuenta.get(ejemplo.cuentaBancariaId);

  return {
    clave,
    bancoCodigo,
    conceptoBanco: primero.conceptoBanco,
    cantidad: miembros.length,
    ...totalesDelGrupo(miembros),
    tipoDeMovimiento: homogeneo ? (primero.identificacion ?? 'Indeterminado') : 'Mixto — ver detalle',
    categoriaEspecial: homogeneo ? primero.categoriaEspecial : null,
    ejemplo,
    ejemploCuentaEtiqueta: cabeceraEjemplo ? etiquetaCuenta(cabeceraEjemplo) : '(cuenta desconocida)',
  };
}

/**
 * Agrupa TODAS las filas del lote (no solo las que piden decisión) por `claveDeAgrupacion` —
 * `distinguir_tercero_de_socio` (`!agrupable`) queda afuera: cada una de esas filas es su propio
 * grupo de 1, nominada individualmente, nunca agrupada con otra (ver el comentario de `agrupable` en
 * `FilaPlanilla`). Sin umbral mínimo, sin carpeta "Varios" — todo grupo se muestra (decisión de JP).
 * Orden: cantidad descendente (`ux-designer`, mismo criterio que `relevamiento-laura.ts`).
 */
export function agruparFilas(
  filas: readonly FilaPlanilla[],
  cabecerasPorCuenta: ReadonlyMap<string, CabeceraCuenta>,
): readonly GrupoDeMovimientos[] {
  const porClave = new Map<string, FilaPlanilla[]>();
  const singulares: FilaPlanilla[] = [];

  for (const fila of filas) {
    if (!fila.agrupable) {
      singulares.push(fila);
      continue;
    }
    const bancoCodigo = cabecerasPorCuenta.get(fila.cuentaBancariaId)?.bancoCodigo ?? '(banco desconocido)';
    const clave = claveDeAgrupacion(bancoCodigo, fila.conceptoBanco);
    const arr = porClave.get(clave) ?? [];
    arr.push(fila);
    porClave.set(clave, arr);
  }

  const grupos: GrupoDeMovimientos[] = [];
  for (const [clave, miembros] of porClave) {
    grupos.push(construirGrupo(clave, miembros, cabecerasPorCuenta));
  }
  // Cada singular con una clave propia (sufijo `individual:<filaNumero>`) — nunca colisiona con el
  // grupo "real" del mismo banco+concepto, ni entre dos singulares con el mismo texto.
  singulares.forEach((fila) => {
    const bancoCodigo = cabecerasPorCuenta.get(fila.cuentaBancariaId)?.bancoCodigo ?? '(banco desconocido)';
    const claveIndividual = `${claveDeAgrupacion(bancoCodigo, fila.conceptoBanco)}::individual:${fila.filaNumero}`;
    grupos.push(construirGrupo(claveIndividual, [fila], cabecerasPorCuenta));
  });

  return grupos.sort((a, b) => b.cantidad - a.cantidad);
}

const ARGB_TARJETA_PENDIENTE = 'FFCFC1E8';

/** Reusa el mismo hecho contable que ya explica `packages/contabilidad/src/nucleo/texto-humano.ts`
 *  para `completar_con_liquidacion_del_adquirente`/`completar_con_liquidacion_de_la_tarjeta` — sin
 *  importar ese paquete acá (`armar-libro.ts` es puro y sin esa dependencia, `tech-lead`, Tanda 1):
 *  esto es una decisión de PRESENTACIÓN del export, no un concepto nuevo del núcleo. Si el texto de
 *  origen cambia, este banner puede quedar desactualizado — riesgo aceptado, es una etiqueta
 *  informativa, no una fuente de verdad contable. */
const BANNER_TARJETA_PENDIENTE =
  'Estos son movimientos de tarjeta que el sistema ya identificó (cobro con tarjeta o pago de ' +
  'tarjeta corporativa), pero el asiento queda incompleto hasta contar con la liquidación del ' +
  'adquirente o de la tarjeta — un documento que hoy el sistema no procesa ' +
  '(docs/diseno/14-liquidaciones-tarjeta-plan.md, plan aprobado, sin implementar). ' +
  'No hace falta que revises estos grupos todavía: no hay nada para aprobar.';

const COLUMNAS_GRUPOS: readonly ColumnaMov[] = [
  { header: 'Tipo de movimiento', key: 'tipoDeMovimiento', width: 30 },
  { header: 'Concepto del banco', key: 'conceptoBanco', width: 26 },
  { header: 'Banco', key: 'bancoCodigo', width: 10 },
  { header: 'Cantidad de movimientos', key: 'cantidad', width: 14 },
  { header: 'Total débito (sale)', key: 'totalDebito', width: 16, numFmt: FMT_MONEDA },
  { header: 'Total crédito (entra)', key: 'totalCredito', width: 16, numFmt: FMT_MONEDA },
  { header: 'Ejemplo — Fecha', key: 'ejemploFecha', width: 12, numFmt: FMT_FECHA },
  { header: 'Ejemplo — Débito', key: 'ejemploDebito', width: 14, numFmt: FMT_MONEDA },
  { header: 'Ejemplo — Crédito', key: 'ejemploCredito', width: 14, numFmt: FMT_MONEDA },
  { header: 'Ejemplo — Descripción', key: 'ejemploDescripcion', width: 50 },
  { header: 'Cuenta (del ejemplo)', key: 'ejemploCuenta', width: 22 },
];

const FILA_ENCABEZADOS_GRUPOS = 3;
const PRIMERA_FILA_DATOS_GRUPOS = 4;

/** Hoja "Grupos" (`tabColorArgb` ausente) o "Tarjeta pendiente" (`tabColorArgb` presente, quinta
 *  categoría visual — `ux-designer`: no reusa gris/azul/dorado porque cada uno ya significa otra cosa,
 *  y rojo/naranja connotan error, que esto no es). Sin umbral mínimo: se llama con `grupos.length ===
 *  0` nunca — el caller decide si la hoja se arma o no. */
function armarHojaGrupos(
  libro: ExcelJS.Workbook,
  nombreDeHoja: string,
  titulo: string,
  grupos: readonly GrupoDeMovimientos[],
  tabColorArgb?: string,
): void {
  const hoja = libro.addWorksheet(nombreDeHoja, { views: [{ state: 'frozen', ySplit: FILA_ENCABEZADOS_GRUPOS }] });
  if (tabColorArgb) hoja.properties.tabColor = { argb: tabColorArgb };

  hoja.getCell('A1').value = titulo;
  hoja.getCell('A1').font = { bold: true };
  hoja.getCell('A1').alignment = { wrapText: true, vertical: 'middle' };
  hoja.mergeCells(1, 1, 1, COLUMNAS_GRUPOS.length);
  if (tabColorArgb) hoja.getRow(1).height = 60;

  COLUMNAS_GRUPOS.forEach((c, i) => {
    const celda = hoja.getCell(FILA_ENCABEZADOS_GRUPOS, i + 1);
    celda.value = c.header;
    hoja.getColumn(i + 1).width = c.width;
    if (c.numFmt) hoja.getColumn(i + 1).numFmt = c.numFmt;
    if (tabColorArgb) celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tabColorArgb } };
  });
  hoja.getRow(FILA_ENCABEZADOS_GRUPOS).font = { bold: true };
  hoja.getRow(FILA_ENCABEZADOS_GRUPOS).alignment = { vertical: 'middle', wrapText: true };

  grupos.forEach((g, indice) => {
    const fila = hoja.getRow(PRIMERA_FILA_DATOS_GRUPOS + indice);
    const ejemploImporte = importeCanonicoANumeroExcel(g.ejemplo.importe) ?? 0;
    const registro: Record<string, ExcelJS.CellValue> = {
      tipoDeMovimiento: g.tipoDeMovimiento,
      conceptoBanco: g.conceptoBanco ?? '(sin concepto)',
      bancoCodigo: g.bancoCodigo,
      cantidad: g.cantidad,
      totalDebito: g.totalDebito || null,
      totalCredito: g.totalCredito || null,
      ejemploFecha: fechaIsoASerialExcel(g.ejemplo.fecha),
      ejemploDebito: ejemploImporte < 0 ? -ejemploImporte : null,
      ejemploCredito: ejemploImporte > 0 ? ejemploImporte : null,
      ejemploDescripcion: g.ejemplo.descripcion,
      ejemploCuenta: g.ejemploCuentaEtiqueta,
    };
    COLUMNAS_GRUPOS.forEach((c, i) => {
      fila.getCell(i + 1).value = registro[c.key] ?? null;
    });
  });

  if (grupos.length > 0) {
    hoja.autoFilter = {
      from: { row: FILA_ENCABEZADOS_GRUPOS, column: 1 },
      to: { row: FILA_ENCABEZADOS_GRUPOS - 1 + grupos.length, column: COLUMNAS_GRUPOS.length },
    };
  }
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

  // Agrupación (Tanda 1) — ANTES de las hojas por cuenta, para que "Grupos" quede segunda en el
  // libro (`ux-designer`: Control de saldos → Grupos → una por cuenta → Tarjeta pendiente al final).
  const cabecerasPorCuenta = new Map(datos.cabeceras.map((c) => [c.cuentaBancariaId, c] as const));
  const grupos = agruparFilas(datos.filas, cabecerasPorCuenta);
  const gruposTarjeta = grupos.filter((g) => g.categoriaEspecial === 'tarjeta_pendiente');
  const gruposNormales = grupos.filter((g) => g.categoriaEspecial !== 'tarjeta_pendiente');

  if (gruposNormales.length > 0) {
    armarHojaGrupos(
      libro,
      'Grupos',
      `Grupos por banco + concepto · Lote ${datos.loteId} · Generado ${datos.generadoEn}`,
      gruposNormales,
    );
  }

  const filasPorCuenta = new Map<string, FilaPlanilla[]>();
  for (const f of datos.filas) {
    const arr = filasPorCuenta.get(f.cuentaBancariaId) ?? [];
    arr.push(f);
    filasPorCuenta.set(f.cuentaBancariaId, arr);
  }

  // "Grupos"/"Tarjeta pendiente" reservados de antemano: una cuenta real sin alias nunca puede
  // colisionar con estos nombres (mismo mecanismo de `nombreHoja`, minúsculas).
  const nombresUsados = new Set<string>(['grupos', 'tarjeta pendiente']);
  let totalFilas = 0;
  for (const cabecera of datos.cabeceras) {
    const filasDeCuenta = filasPorCuenta.get(cabecera.cuentaBancariaId) ?? [];
    const nombre = nombreHoja(cabecera, nombresUsados);
    totalFilas += armarHojaMovimientos(libro, cabecera, filasDeCuenta, nombre);
  }

  if (gruposTarjeta.length > 0) {
    armarHojaGrupos(libro, 'Tarjeta pendiente', BANNER_TARJETA_PENDIENTE, gruposTarjeta, ARGB_TARJETA_PENDIENTE);
  }

  return { estado: 'armado', libro, filas: totalFilas };
}

/** Serializa. Único punto asíncrono de este archivo. */
export async function serializarLibro(libro: ExcelJS.Workbook): Promise<Uint8Array> {
  const buffer = await libro.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
