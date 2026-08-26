/**
 * ADAPTADOR ICBC (Industrial and Commercial Bank of China (Argentina) S.A.) — cuenta corriente en
 * pesos, PDF.
 *
 * La especificación medida está en `docs/diseno/22-formato-icbc.md`. Este archivo la implementa y no
 * repite los números. **Medido contra un documento real de UN solo cliente** (MEB Integración y
 * Montaje S.A.S., junio 2026, 1 página, 33 filas geométricas, 9 movimientos) — varias decisiones
 * están marcadas como medidas contra una muestra chica, y se revisan cuando aparezca un segundo
 * documento real.
 *
 * ## Lo que distingue a este banco de los cinco anteriores
 *
 * 1. **NINGÚN nombre de banco aparece como texto extraíble en la carátula.** `reconoceICBC` ancla en
 *    el encabezado de columnas (`FECHA CONCEPTO F.VALOR COMPROBANTE ORIGEN CANAL DEBITOS CREDITOS
 *    SALDOS`, literal confirmado, spec §1.1) — una secuencia de 9 palabras específica, no un
 *    letterhead.
 * 2. **DEBITOS/CREDITOS son columnas separadas (`origenSigno: 'columna_separada'`), con el importe de
 *    DEBITOS llevando un signo `-` FINAL redundante** (`importeACentavos` ya soporta esa notación,
 *    "signo atrás", spec §H2 — no hizo falta tocar `parseo-ar.ts`).
 * 3. **La fecha del cuerpo va en su propio fragmento** (`dd-mm`, con GUION, sin año — a diferencia de
 *    Nación, que la funde con el concepto). `anioEnLaFecha: false`, se resuelve contra el período.
 * 4. **El saldo por fila NO está en el 100% de los movimientos** (5/9 medido, spec §H3, sin patrón de
 *    intervalo fijo) — se verifica por puntos de control, mecanismo YA existente en
 *    `verificarAritmetica` (`invariantes.ts:132-135`), sin cambios.
 * 5. **El bloque de totales al pie está en UNA sola fila geométrica** con 3 valores (dos totales de
 *    impuesto + el saldo final, con su fecha embebida en el mismo fragmento que el segundo total) —
 *    a diferencia de Bancor (9 líneas) y Nación (una fila por concepto). El punto de corte entre el
 *    segundo total y la fecha NO es por conteo de dígitos: se ancla por forma de importe al frente y
 *    por el literal `SALDO FINAL AL` + forma de fecha al final (spec §H4.1).
 */

import { formaParaLog } from '@sistema-contable/shared/observabilidad';
import { RE_CUIT as RE_CUIT_COMPARTIDO } from '@sistema-contable/shared/seguridad';
import { centavosAImporte, importeACentavos, parsearFecha } from '../parseo-ar.ts';
import { hashesDeCuenta, normalizarNumeroCuenta, type ClaveCuenta } from '../hash.ts';
import type {
  AnexoExtracto,
  CapacidadesAdaptador,
  CuentaConMovimientos,
  LineaNoInterpretada,
  MovimientoBancarioCrudo,
} from '../esquema.ts';
import {
  fragmentosEnBanda,
  textoDeFila,
  type FilaGeometrica,
  type Fragmento,
} from '../texto-pdf.ts';
import type { EntradaDeAdaptador, SalidaDeAdaptador } from './registro.ts';
import { contarDestinos, DESTINOS_BASE, type ConteoDeDestinos, type DestinoBase } from './toolkit.ts';

export const BANCO_CODIGO = 'icbc';
export const VERSION = 1;

/**
 * Capacidades declaradas — medidas contra el único documento real disponible
 * (`22-formato-icbc.md`). `cadenaDeSaldos: 'por_puntos_de_control'` está medido (5/9 filas con
 * saldo, spec §H3): se declara así desde el día uno, no como un booleano optimista a corregir
 * después.
 */
export const CAPACIDADES_ICBC: CapacidadesAdaptador = {
  familiaLayout: 'columnas-posicionales',
  cadenaDeSaldos: 'por_puntos_de_control',
  // 🔴 `TOT.IMP.LEY COMP.`/`TOT.LEY COMP.$` (capturados como anexos, spec §H4) son totales de
  // IMPUESTO, no la suma agregada de créditos/débitos que `cuenta.totalCreditosDeclarado`/
  // `totalDebitosDeclarado` exige para V2. El documento real no publica esa suma en ningún lado —
  // `false`, no un `true` que dejaría el lote en `no_cuadra` por `totales_no_encontrados` siempre.
  traeTotalesDeclarados: false,
  traeSaldoInicialDeclarado: true,
  // DEBITOS y CREDITOS son columnas propias: el signo nunca depende de derivarlo de la cadena.
  traeSignoEnElImporte: false,
  // No en el 100% de las filas (spec §H3) — `traeSaldoPorFila` describe si la CAPACIDAD existe, y
  // `verificarAritmetica` ya trata los huecos como puntos de control, no como ruptura.
  traeSaldoPorFila: true,
  // Declarado en el encabezado (F.VALOR) pero SIN dato en ninguna de las 9 filas medidas (spec §1.1).
  traeFechaValor: false,
  // El número de COMPROBANTE se persiste como referencia (tipo `operacion`).
  traeReferencia: true,
  traeCodigoDeConcepto: false,
  anioEnLaFecha: false,
  multiCuenta: false,
  multiMoneda: false,
  // No medido contra un archivo con movimientos fuera de período: conservador, mismo criterio que
  // Bancor/Nación.
  traeMovimientosFueraDelPeriodo: false,
  traeConsolidadoPorMoneda: false,
  declaraDestinos: true,
};

/**
 * Las columnas, en puntos PDF (spec §H2, §1.1). `referencia`/`debito`/`credito`/`saldo` son
 * ventanas por BORDE DERECHO (`fragmentoDeColumna`, definida más abajo con el mismo piso de banda
 * de concepto que ya usa `nacion.ts`).
 *
 * 🔴 **Dead zone entre ventanas, mismo criterio que Nación** (`fragmentoEnVentanaDerecha` es
 * inclusiva en los dos extremos): `debito.hasta` y `credito.desde` dejan 2pt sin asignar, igual entre
 * `credito` y `saldo`. Medido: `debito` cierra siempre en borde 427.0 (7 muestras), `credito` en
 * 502.6 (1 sola muestra — spec §H2, sin dato real de un segundo crédito), `saldo` en 582.4 (6
 * muestras).
 */
const COLUMNAS = {
  bandaConcepto: { desde: 0, hasta: 293 },
  // Real: borde derecho hasta 343.0 (spec §1.1: un caso trae un token extra pegado). Ventana ancha a
  // propósito para no perder ese caso.
  referencia: { desde: 295, hasta: 345 },
  // Real: borde derecho SIEMPRE 427.0 (7/7 muestras).
  debito: { desde: 395, hasta: 429 },
  // 🔴 Sin universo de datos real (spec §H2): la única fila medida es un crédito, borde 502.6.
  // Ventana con margen sobre esa única medición — a revisar contra un segundo crédito real.
  credito: { desde: 431, hasta: 505 },
  // Real: borde derecho SIEMPRE 582.4 (6/6 muestras).
  saldo: { desde: 507, hasta: 583 },
} as const;

/**
 * El fragmento en la ventana `[desde,hasta]` por borde derecho, EXCLUYENDO cualquier fragmento cuyo
 * borde izquierdo caiga dentro de la banda de concepto — mismo hallazgo de `code-reviewer` que ya
 * corrigió `nacion.ts`: un fragmento de concepto puede desbordar por la derecha hacia la ventana de
 * una columna vecina.
 */
function fragmentoDeColumna(fila: FilaGeometrica, desde: number, hasta: number): Fragmento | undefined {
  return fila.fragmentos.find((f) => {
    if (f.x < COLUMNAS.bandaConcepto.hasta) return false;
    const derecha = f.x + f.ancho;
    return derecha >= desde && derecha <= hasta;
  });
}

/** La fecha del cuerpo: su propio fragmento, arranque de fila, SIN año (spec §1.1). */
const RE_FECHA_CUERPO = /^\d{2}-\d{2}$/;

/** El encabezado de columnas (spec §1.1) — único literal disponible para reconocer el banco. */
const RE_ENCABEZADO_ICBC =
  /^FECHA\s+CONCEPTO\s+F\.VALOR\s+COMPROBANTE\s+ORIGEN\s+CANAL\s+DEBITOS\s+CREDITOS\s+SALDOS$/i;

/**
 * `SALDO ULTIMO EXTRACTO AL dd/mm/yyyy` (spec §1.1: fecha con BARRA, a diferencia del período).
 *
 * 🔴 **Sin ancla `$` al final, a propósito** — medido contra el documento real: la etiqueta y el
 * importe comparten la MISMA fila geométrica (fila 9 real: `SALDO ULTIMO` + `EXTRACTO AL
 * 31/05/2026` + el importe, los tres fragmentos en un solo `y`). `textoDeFila` los une con un
 * espacio, así que un ancla `$` justo después de la fecha nunca matchearía contra el archivo real —
 * mismo tipo de error que ya costó una corrida fallida contra el piloto en Nación (período en
 * mayúscula). El importe se lee aparte, por columna (`fragmentoDeColumna`), nunca de este regex.
 */
const RE_SALDO_ANTERIOR = /^SALDO\s+ULTIMO\s+EXTRACTO\s+AL\s+(\d{2}\/\d{2}\/\d{4})/i;

/**
 * El bloque de totales (spec §H4/§H4.1): UNA fila, 5 fragmentos, 3 valores. El corte entre el
 * segundo total y la fecha embebida NO es por conteo de dígitos — es por forma de importe al frente
 * y por el literal `SALDO FINAL AL` + forma de fecha (con BARRA) al final. El `(*)` es OPCIONAL: la
 * ancla real es el literal, no el asterisco.
 */
const RE_ETIQUETA_TOTAL_1 = /^TOT\.IMP\.LEY\s+COMP\.:?$/i;
const RE_ETIQUETA_TOTAL_2 = /^TOT\.LEY\s+COMP\.\$$/i;
const RE_TOTAL_2_Y_SALDO_FINAL =
  /^([\d.]+,\d{2})\s*(?:\(\*\))?\s*SALDO\s+FINAL\s+AL\s+(\d{2}\/\d{2}\/\d{4})$/i;

/** El período: `PERIODO dd-mm-aaaa AL dd-mm-aaaa` (spec §1.1) — fecha con GUION, conector en mayúscula.
 * NO se reusa `extraerPeriodo` de `toolkit.ts`: esa función es case-sensitive y solo acepta el
 * conector en minúscula, el mismo defecto que ya rompió contra Nación (HANDOFF 121/122). */
const RE_PERIODO = /(\d{2})-(\d{2})-(\d{4})\s*AL\s*(\d{2})-(\d{2})-(\d{4})/i;

export type SalidaIcbc = SalidaDeAdaptador & {
  readonly destinos: ConteoDeDestinos<DestinoBase>;
};

/** `reconoceICBC`: ancla en el encabezado de columnas, único literal bancario-genérico disponible. */
export function reconoceICBC(filas: readonly FilaGeometrica[]): boolean {
  return filas.slice(0, 15).some((f) => RE_ENCABEZADO_ICBC.test(textoDeFila(f)));
}

/** Movimiento en construcción: en ICBC, cada fila con fecha cierra su propio movimiento. */
type MovimientoEnCurso = {
  readonly movimiento: MovimientoBancarioCrudo;
  lineasExtra: string[];
};

export function leerIcbc(filas: readonly FilaGeometrica[]): SalidaIcbc {
  const noInterpretadas: LineaNoInterpretada[] = [];
  const movimientos: MovimientoBancarioCrudo[] = [];
  const anexos: AnexoExtracto[] = [];
  let ordenDeAnexo = 0;
  const periodo = leerPeriodo(filas);

  const destinoDeFila = new Map<number, DestinoBase>();
  const marcar = (i: number, destino: DestinoBase): void => {
    destinoDeFila.set(i, destino);
  };

  let saldoAnteriorDeclarado: string | undefined;
  let saldoFinalDeclarado: string | undefined;
  let abierto: MovimientoEnCurso | null = null;

  const cerrarContinuaciones = (): void => {
    if (!abierto) return;
    if (abierto.lineasExtra.length > 0) {
      abierto.movimiento.descripcionLineas.push(...abierto.lineasExtra);
      abierto.movimiento.descripcion = abierto.movimiento.descripcionLineas
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    abierto = null;
  };

  let filaNumero = 0;

  for (const [indice, fila] of filas.entries()) {
    const texto = textoDeFila(fila);
    if (texto === '') {
      marcar(indice, 'ruido');
      continue;
    }

    if (RE_ENCABEZADO_ICBC.test(texto)) {
      cerrarContinuaciones();
      marcar(indice, 'ruido');
      continue;
    }

    const saldoAnteriorMatch = RE_SALDO_ANTERIOR.exec(texto);
    if (saldoAnteriorMatch) {
      cerrarContinuaciones();
      const saldoFrag = fragmentoDeColumna(fila, COLUMNAS.saldo.desde, COLUMNAS.saldo.hasta);
      const cent = saldoFrag ? importeACentavos(saldoFrag.texto) : null;
      if (cent === null) {
        marcar(indice, 'residuo');
        noInterpretadas.push({
          codigo: 'fila_sin_importe',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice,
        });
      } else {
        saldoAnteriorDeclarado = centavosAImporte(cent);
        marcar(indice, 'saldoDeclarado');
      }
      continue;
    }

    // El bloque de totales: UNA fila con la primera etiqueta al frente (spec §H4). Se testea antes
    // que la banda de fecha porque su primer fragmento no tiene forma de fecha.
    const primerFrag = fila.fragmentos[0];
    if (primerFrag && RE_ETIQUETA_TOTAL_1.test(primerFrag.texto.trim())) {
      cerrarContinuaciones();
      const total1Frag = fila.fragmentos[1];
      const etiqueta2Frag = fila.fragmentos[2];
      const total2YSaldoFrag = fila.fragmentos[3];
      const saldoFinalFrag = fila.fragmentos[4];

      const total1Cent = total1Frag ? importeACentavos(total1Frag.texto) : null;
      const etiqueta2Ok = etiqueta2Frag ? RE_ETIQUETA_TOTAL_2.test(etiqueta2Frag.texto.trim()) : false;
      const match2 = total2YSaldoFrag ? RE_TOTAL_2_Y_SALDO_FINAL.exec(total2YSaldoFrag.texto.trim()) : null;
      const total2Cent = match2?.[1] ? importeACentavos(match2[1]) : null;
      const saldoFinalCent = saldoFinalFrag ? importeACentavos(saldoFinalFrag.texto) : null;

      if (total1Cent === null || !etiqueta2Ok || !match2 || total2Cent === null || saldoFinalCent === null) {
        marcar(indice, 'residuo');
        noInterpretadas.push({
          codigo: 'linea_fuera_de_zona',
          forma: formaParaLog(texto, 140),
          paginaPdf: fila.pagina,
          indice,
        });
        continue;
      }

      marcar(indice, 'anexo');
      ordenDeAnexo += 1;
      anexos.push({
        tipoFila: 'anexo',
        conceptoLiteral: 'TOT.IMP.LEY COMP.',
        ordenEnLote: ordenDeAnexo,
        atribucionCuenta: 'cuenta_unica_del_lote',
        periodoDato: 'no_publicado',
        importeDeclarado: centavosAImporte(total1Cent),
        moneda: 'ARS',
        relacionConMovimientos: 'no_determinada',
        paginaPdf: fila.pagina,
      });
      ordenDeAnexo += 1;
      anexos.push({
        tipoFila: 'anexo',
        conceptoLiteral: 'TOT.LEY COMP.$',
        ordenEnLote: ordenDeAnexo,
        atribucionCuenta: 'cuenta_unica_del_lote',
        periodoDato: 'no_publicado',
        importeDeclarado: centavosAImporte(total2Cent),
        moneda: 'ARS',
        relacionConMovimientos: 'no_determinada',
        paginaPdf: fila.pagina,
      });

      saldoFinalDeclarado = centavosAImporte(saldoFinalCent);
      continue;
    }

    const fechaFrag = fila.fragmentos[0];
    const esFilaDeMovimiento = fechaFrag !== undefined && RE_FECHA_CUERPO.test(fechaFrag.texto.trim());

    if (esFilaDeMovimiento) {
      cerrarContinuaciones();

      const fecha = parsearFecha(fechaFrag.texto.trim(), periodo ?? undefined);
      if (fecha === null) {
        marcar(indice, 'residuo');
        noInterpretadas.push({
          codigo: 'fecha_ilegible',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice,
        });
        continue;
      }

      const glosa = fragmentosEnBanda(fila, COLUMNAS.bandaConcepto.desde, COLUMNAS.bandaConcepto.hasta)
        .replace(fechaFrag.texto, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (glosa === '') {
        marcar(indice, 'residuo');
        noInterpretadas.push({
          codigo: 'columna_sin_ancla',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice,
        });
        continue;
      }

      const debitoFrag = fragmentoDeColumna(fila, COLUMNAS.debito.desde, COLUMNAS.debito.hasta);
      const creditoFrag = fragmentoDeColumna(fila, COLUMNAS.credito.desde, COLUMNAS.credito.hasta);
      const debitoCent = debitoFrag ? importeACentavos(debitoFrag.texto) : null;
      const creditoCent = creditoFrag ? importeACentavos(creditoFrag.texto) : null;

      const columna: 'credito' | 'debito' | null =
        debitoCent !== null && creditoCent === null
          ? 'debito'
          : creditoCent !== null && debitoCent === null
            ? 'credito'
            : null;

      if (columna === null) {
        marcar(indice, 'residuo');
        noInterpretadas.push({
          codigo: 'importe_en_columna_desconocida',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice,
        });
        continue;
      }

      /**
       * 🔴 **Hallazgo de `tester`: el signo atrás (spec §H2) no es exclusivo de DEBITOS.** La
       * defensa original solo tomaba valor absoluto del lado de `debito` — la columna CREDITOS del
       * documento real está medida sobre UN solo caso (spec §H2, "sin universo de datos real"), así
       * que no hay evidencia de que nunca traiga el mismo signo redundante. Sin este `abs()` acá
       * también, un crédito firmado armaba `credito: "-500.00"` — un valor que
       * `movimientoBancarioCrudoSchema` declara imposible (`importeNoNegativo`) pero que el adapter
       * dejaba pasar sin ningún código en `lineasNoInterpretadas`: el mismo modo de falla que el
       * resto del módulo existe para evitar, un dato creíble y equivocado en vez de un `null` limpio.
       * El importe canónico de CUALQUIER columna del banco es siempre no-negativo — se toma el valor
       * absoluto sin importar de qué lado vino ni si el fragmento traía o no el guion final.
       */
      const debitoAbsCent = debitoCent !== null && debitoCent < 0n ? -debitoCent : debitoCent;
      const creditoAbsCent = creditoCent !== null && creditoCent < 0n ? -creditoCent : creditoCent;
      const importeAbsCent = columna === 'debito' ? debitoAbsCent! : creditoAbsCent!;
      const importeToken = centavosAImporte(importeAbsCent);

      const saldoFrag = fragmentoDeColumna(fila, COLUMNAS.saldo.desde, COLUMNAS.saldo.hasta);
      const saldoCent = saldoFrag ? importeACentavos(saldoFrag.texto) : null;

      /**
       * 🔴 **Hallazgo de `code-reviewer`: `/^\d+/` descartaba en silencio el texto pegado al número
       * (spec §1.1, fila real con forma `#### AAAA`, borde derecho 343.0 — número agregado a la
       * spec en la misma revisión que este fix).** Cortar al primer prefijo numérico perdía el resto
       * del fragmento sin dejar rastro en `lineasNoInterpretadas` ni en ningún otro campo — la
       * clase de fuga silenciosa que el resto de este archivo evita a propósito. Se captura el
       * fragmento COMPLETO, sin recortar, mismo criterio que `comprobFrag?.texto.trim()` de
       * `nacion.ts`: el consumidor decide qué hacer con un sufijo, el parser no lo tira.
       */
      const referenciaFrag = fragmentoDeColumna(fila, COLUMNAS.referencia.desde, COLUMNAS.referencia.hasta);
      const referencia = referenciaFrag?.texto.trim() || undefined;

      filaNumero += 1;
      const movimiento = {
        tipoFila: 'movimiento',
        fecha,
        descripcionLineas: [glosa],
        descripcion: glosa,
        ...(columna === 'credito' ? { credito: importeToken } : { debito: importeToken }),
        columnaOrigen: columna,
        origenSigno: 'columna_separada',
        importe: columna === 'credito' ? importeToken : `-${importeToken}`,
        ...(saldoCent === null ? {} : { saldo: centavosAImporte(saldoCent), saldoEsAcreedor: saldoCent < 0n }),
        moneda: 'ARS',
        cotizacionProvista: false,
        filaNumero,
        paginaPdf: fila.pagina,
        ...(referencia ? { referencias: [{ tipo: 'operacion', valor: referencia }] } : {}),
        filaHash: '',
      } as MovimientoBancarioCrudo;

      marcar(indice, 'movimiento');
      movimientos.push(movimiento);
      abierto = { movimiento, lineasExtra: [] };
      continue;
    }

    // No es encabezado, saldo anterior, totales ni apertura de movimiento: puede ser continuación de
    // la glosa abierta (mismo criterio que Nación/Bancor) — solo si TODO el contenido cae dentro de
    // la banda de concepto.
    if (abierto) {
      const banda = fragmentosEnBanda(fila, COLUMNAS.bandaConcepto.desde, COLUMNAS.bandaConcepto.hasta);
      const tieneAlgoFueraDeLaBanda = fila.fragmentos.some((f) => f.x >= COLUMNAS.bandaConcepto.hasta);
      if (banda !== '' && !tieneAlgoFueraDeLaBanda) {
        abierto.lineasExtra.push(banda);
        marcar(indice, 'continuacion');
        continue;
      }
      cerrarContinuaciones();
    }

    // Fila de carátula/pie sin movimiento abierto: no se reporta como residuo (mismo criterio que
    // Nación — el bloque legal, dirección del titular, etc. tiene esta misma forma geométrica).
    marcar(indice, 'fueraDelCuerpo');
  }
  cerrarContinuaciones();

  const cuenta = armarCuenta(filas, movimientos, periodo, anexos, saldoAnteriorDeclarado, saldoFinalDeclarado);
  return {
    cuentas: cuenta ? [cuenta] : [],
    lineasNoInterpretadas: noInterpretadas,
    paginasDeclaradas: undefined,
    destinos: contarDestinos(DESTINOS_BASE, destinoDeFila, filas.length),
  };
}

function aIso(ddmmyyyy: string): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(ddmmyyyy);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function leerPeriodo(filas: readonly FilaGeometrica[]): { desde: string; hasta: string } | null {
  for (const fila of filas.slice(0, 10)) {
    const m = RE_PERIODO.exec(textoDeFila(fila));
    if (!m?.[1] || !m[2] || !m[3] || !m[4] || !m[5] || !m[6]) continue;
    const desdeIso = aIso(`${m[1]}-${m[2]}-${m[3]}`);
    const hastaIso = aIso(`${m[4]}-${m[5]}-${m[6]}`);
    if (desdeIso && hastaIso) return { desde: desdeIso, hasta: hastaIso };
  }
  return null;
}

/**
 * El CUIT del TITULAR: anclado a la etiqueta `CUIT N°` como fragmento propio (spec §1.1 —
 * corrección 2026-08-26: este bloque es del TITULAR, nunca del banco, pese a compartir fila con
 * datos de la sucursal — ver `docs/seguridad/registro-incidentes.md` #13).
 */
function leerCuitTitular(filas: readonly FilaGeometrica[]): string | null {
  for (const fila of filas.slice(0, 10)) {
    const texto = textoDeFila(fila);
    if (!/^CUIT\s+N°/i.test(texto)) continue;
    const m = RE_CUIT_COMPARTIDO.exec(texto);
    RE_CUIT_COMPARTIDO.lastIndex = 0;
    if (m?.[0]) return m[0];
  }
  return null;
}

/** El número de cuenta (spec §1, H1): `dddd/dddddddd/dd`, tres grupos, sin etiqueta de texto propia. */
const RE_NUMERO_CUENTA_ICBC = /(?<!\d)\d{4}\/\d{8}\/\d{2}(?!\d)/;

/** El CBU (spec §1, H1): 22 dígitos partidos en DOS grupos (8+14) con un espacio, tras `C.B.U.:`. */
const RE_CBU_ICBC = /C\.B\.U\.:\s*(\d{8})\s+(\d{14})/i;

function leerNumeroYCbu(filas: readonly FilaGeometrica[]): { numero: string | null; cbu: string | null } {
  for (const fila of filas.slice(0, 10)) {
    const texto = textoDeFila(fila);
    const mNumero = RE_NUMERO_CUENTA_ICBC.exec(texto);
    const mCbu = RE_CBU_ICBC.exec(texto);
    if (mNumero || mCbu) {
      return {
        numero: mNumero?.[0] ?? null,
        cbu: mCbu ? `${mCbu[1]}${mCbu[2]}` : null,
      };
    }
  }
  return { numero: null, cbu: null };
}

function armarCuenta(
  filas: readonly FilaGeometrica[],
  movimientos: readonly MovimientoBancarioCrudo[],
  periodo: { readonly desde: string; readonly hasta: string } | null,
  anexos: readonly AnexoExtracto[],
  saldoInicialDeclarado: string | undefined,
  saldoFinalDeclarado: string | undefined,
): CuentaConMovimientos | null {
  if (movimientos.length === 0) return null;

  const titularDocumento = leerCuitTitular(filas);
  const { numero, cbu } = leerNumeroYCbu(filas);

  const clave: ClaveCuenta = {
    bancoCodigo: BANCO_CODIGO,
    numeroNormalizado: normalizarNumeroCuenta(numero ?? 'sin_numero'),
    moneda: 'ARS',
  };
  const hashes = hashesDeCuenta(
    clave,
    movimientos.map((m) => ({
      fecha: m.fecha,
      importe: m.importe,
      saldo: m.saldo ?? null,
      descripcion: m.descripcion,
    })),
  );
  const conHash = movimientos.map((m, i) => ({ ...m, filaHash: hashes[i] ?? '' }));

  return {
    cuenta: {
      denominacion: 'CUENTA CORRIENTE EN PESOS',
      tipoCuenta: 'cuenta_corriente',
      moneda: 'ARS',
      ...(periodo ? { periodoDesde: periodo.desde, periodoHasta: periodo.hasta } : {}),
      coberturaPeriodo: 'completo',
      ...(saldoInicialDeclarado === undefined ? {} : { saldoInicialDeclarado }),
      ...(saldoFinalDeclarado === undefined ? {} : { saldoFinalDeclarado }),
      ...(numero === null ? {} : { numero }),
      ...(cbu === null ? {} : { cbu }),
      ...(titularDocumento === null ? {} : { titularDocumento }),
    },
    movimientos: conHash,
    anexos: [...anexos],
  };
}

export const adaptadorIcbc = {
  bancoCodigo: BANCO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_ICBC,
  reconoce: (e: EntradaDeAdaptador): boolean => reconoceICBC(e.filas),
  leer: (e: EntradaDeAdaptador): SalidaIcbc => leerIcbc(e.filas),
} as const;
