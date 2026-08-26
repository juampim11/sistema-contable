/**
 * ADAPTADOR BANCO NACIÓN (Banco de la Nación Argentina) — cuenta corriente en pesos, PDF.
 *
 * La especificación medida está en `docs/diseno/21-formato-nacion.md`. Este archivo la implementa y
 * no repite los números. **Medido contra un documento real de un solo movimiento** (cliente HYJ SAS,
 * junio 2026) — varias decisiones de acá están marcadas explícitamente como diseñadas sin evidencia
 * de un segundo caso real, y se revisan cuando aparezca.
 *
 * ## Lo que distingue a este banco de los cuatro anteriores
 *
 * 1. **Fecha y arranque del concepto vienen PEGADOS en un solo fragmento geométrico**
 *    (`dd/mm/aa<resto sin espacio>`), a diferencia de los cuatro bancos previos, que siempre traen la
 *    fecha en su propio fragmento. Medido contra UN solo movimiento (spec §9) — no se puede confirmar
 *    todavía si es sistemático o una fusión de casualidad con un concepto corto.
 * 2. **DEBITOS y CREDITOS son columnas separadas** (`traeSignoEnElImporte: false`, mismo mecanismo
 *    que Santander/Macro) — nunca hace falta la cadena de saldos para asignar el signo, a diferencia
 *    de Bancor. `origenSigno: 'columna_separada'` en cada movimiento (paquete de `esquema.ts`).
 * 3. **`SALDO ANTERIOR`/`SALDO FINAL` son DOS fragmentos separados** (`SALDO` + `ANTERIOR`/`FINAL`),
 *    a diferencia de Bancor, que trae `SALDO RES. ANTERIOR` como un único literal. La distinción no
 *    afecta el reconocimiento por texto (`textoDeFila` los une igual), pero sí es una geometría
 *    distinta que el próximo banco con fragmentos sueltos puede necesitar.
 * 4. **La fecha SÍ trae año** (`dd/mm/aa`, 2 dígitos) — `anioEnLaFecha: true`, a diferencia de
 *    Bancor/Macro. `parsearFecha` ya soporta año de 2 dígitos nativamente.
 * 5. **El período de carátula viene en UN solo fragmento** (`"<etiqueta>: dd/mm/yyyy AL
 *    dd/mm/yyyy"`), no como dos fechas sueltas en la misma fila (Bancor). Se resuelve con un regex
 *    sobre el texto ya unido de la fila, no contando fragmentos de fecha.
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
import { fragmentosEnBanda, textoDeFila, type FilaGeometrica, type Fragmento } from '../texto-pdf.ts';
import type { EntradaDeAdaptador, SalidaDeAdaptador } from './registro.ts';
import { contarDestinos, DESTINOS_BASE, type ConteoDeDestinos, type DestinoBase } from './toolkit.ts';

export const BANCO_CODIGO = 'nacion';
export const VERSION = 1;

/**
 * Capacidades declaradas — medidas contra el único documento real disponible (`21-formato-
 * nacion.md`). `cadenaDeSaldos: 'completa'` y `traeSaldoPorFila: true` están confirmadas sobre UN
 * solo movimiento, no sobre un universo — se declaran así porque es lo medido, y se corrigen si un
 * segundo documento las refuta (mismo criterio de honestidad que ya usa `traeMovimientosFueraDelPeriodo`
 * en `esquema.ts`).
 */
export const CAPACIDADES_NACION: CapacidadesAdaptador = {
  familiaLayout: 'columnas-posicionales',
  cadenaDeSaldos: 'completa',
  traeTotalesDeclarados: false,
  traeSaldoInicialDeclarado: true,
  // DEBITOS y CREDITOS son columnas propias: el signo nunca viaja en el número mismo.
  traeSignoEnElImporte: false,
  traeSaldoPorFila: true,
  traeFechaValor: false,
  // El número de COMPROB. se persiste como referencia (tipo `operacion`).
  traeReferencia: true,
  traeCodigoDeConcepto: false,
  anioEnLaFecha: true,
  multiCuenta: false,
  multiMoneda: false,
  // No medido contra un archivo con movimientos fuera de período: conservador, como Bancor.
  traeMovimientosFueraDelPeriodo: false,
  traeConsolidadoPorMoneda: false,
  declaraDestinos: true,
};

/**
 * Las columnas, en puntos PDF (spec §3). `comprobante`/`debito`/`credito`/`saldo` son ventanas por
 * BORDE DERECHO (`fragmentoEnVentanaDerecha`): son importes o números cortos, alineados a la
 * derecha, igual criterio que todo el roster.
 *
 * 🔴 **Hallazgo de `tester`: las cuatro ventanas NO pueden compartir un valor límite.**
 * `fragmentoEnVentanaDerecha` es inclusiva en los DOS extremos (`derecha >= desde && derecha <=
 * hasta`) — a diferencia de `fragmentosEnBanda`, que documenta `[desde, hasta)` semi-abierto a
 * propósito. Con ventanas contiguas (`debito.hasta === credito.desde`, etc.), un fragmento cuyo
 * borde derecho cae EXACTO en ese valor compartido matchea las dos ventanas vecinas a la vez —
 * `tester` lo reprodujo con un crédito en `x=500`: ese mismo fragmento ganaba también la búsqueda
 * de `saldo` (por `.find()`, que devuelve el primero en orden de `x`), **reemplazando el saldo real
 * en silencio, sin ningún código en `lineasNoInterpretadas`**. Es la peor clase de falla del
 * módulo: un número creíble y equivocado. Por eso las cuatro ventanas de acá abajo dejan un margen
 * de 2pt SIN asignar entre cada una — un valor ahí no matchea ninguna ventana (falla cerrada, se
 * reporta como dato ausente) en vez de matchear dos a la vez (falla silenciosa).
 *
 * 🔴 La banda `[0, comprobante.desde)` es lo que separa "fecha + concepto" (que viven pegados en un
 * mismo fragmento, ver la nota de arriba) del resto de la fila — no hay una columna `fecha` propia
 * medible por `x`, así que no se declara una.
 */
const COLUMNAS = {
  bandaFechaYConcepto: { desde: 0, hasta: 235 },
  // Real: borde derecho 276.5.
  comprobante: { desde: 235, hasta: 300 },
  // Real: borde derecho 372.5.
  debito: { desde: 302, hasta: 390 },
  // 🔴 Sin dato real (spec §4): la única fila medida es un débito. Ventana plausible por simetría
  // con `debito` respecto del encabezado (`CREDITOS` en `x=415.5`) — a revisar contra el primer
  // documento real con un crédito.
  credito: { desde: 392, hasta: 495 },
  // Real: borde derecho 564.5. `hasta: 575`, corregido contra el borde derecho REAL (no supuesto
  // desde el borde izquierdo del rótulo): una ventana `hasta: 560` dejaba el importe justo AFUERA y
  // `fragmentoEnVentanaDerecha` devolvía `undefined` en el 100% de las filas de saldo — mismo tipo
  // de corrección que ya tuvo `bancor.ts` con su columna `saldo`.
  saldo: { desde: 497, hasta: 575 },
} as const;

/**
 * 🔴 **Hallazgo de `code-reviewer`, distinto del de `tester` arriba.** `fragmentoEnVentanaDerecha`
 * (`texto-pdf.ts`) busca en TODOS los fragmentos de la fila por borde DERECHO, sin mirar el
 * izquierdo. Un fragmento de la banda de concepto (`x < bandaFechaYConcepto.hasta`, por eso cuenta
 * como concepto) puede tener el borde DERECHO cayendo igual dentro de la ventana de una columna de
 * la derecha — un concepto largo, o `ancho` mal reportado por `pdf.js` (problema ya medido en
 * `06-formato-santander.md` §11.2) — y como los fragmentos están ordenados por `x` ascendente, ese
 * fragmento de concepto gana el `.find()` ANTES que el dato real de la columna. Reproducido de
 * verdad mientras se escribía `nacion.test.ts` (ver el comentario de `agregarMovimiento`).
 *
 * El piso `f.x >= bandaFechaYConcepto.hasta` excluye cualquier fragmento que EMPIECE en la banda de
 * concepto, sin importar cuánto se extienda su borde derecho — mismo espíritu que la verificación
 * de identidad `if (importeFrag === saldoFrag) return null` de `bancor.ts`/`toolkit.ts`, pero acá
 * el candidato a excluir no es otro campo monetario: es la banda de concepto entera.
 */
function fragmentoDeColumna(fila: FilaGeometrica, desde: number, hasta: number): Fragmento | undefined {
  return fila.fragmentos.find((f) => {
    if (f.x < COLUMNAS.bandaFechaYConcepto.hasta) return false;
    const derecha = f.x + f.ancho;
    return derecha >= desde && derecha <= hasta;
  });
}

/** `dd/mm/aa` al ARRANQUE del texto de la banda fecha+concepto (spec §9: fusionados en un fragmento). */
const RE_FECHA_Y_RESTO = /^(\d{2}\/\d{2}\/\d{2})\s*(.*)$/;

/** Marcas del documento por las que se reconoce al banco (spec §1: letterhead partido en dos filas). */
const MARCAS = [/^BANCO DE LA$/i, /^NACION ARGENTINA$/i];

const RE_SALDO_ANTERIOR = /^SALDO\s+ANTERIOR\b/i;
const RE_SALDO_FINAL = /^SALDO\s+FINAL\b/i;

/**
 * Lo que NO es un movimiento ni continuación (spec §2): letterhead partido en dos líneas, CUIT DEL
 * BANCO (con la leyenda fija "IVA RESPONSABLE INSCRIPTO" — nunca confundir con el CUIT del titular,
 * que trae la etiqueta `CUIT:` con dos puntos, ver `leerCuitTitular`), la numeración interna de hoja
 * del banco, y el código de sucursal.
 */
const RUIDO_NACION: readonly { readonly patron: RegExp; readonly motivo: string }[] = [
  { patron: /^BANCO DE LA$/i, motivo: 'Letterhead bancario (línea 1 de 2), repetido por página.' },
  { patron: /^NACION ARGENTINA$/i, motivo: 'Letterhead bancario (línea 2 de 2), repetido por página.' },
  { patron: /^HOJA:\s*\d+$/i, motivo: 'Numeración interna de hoja del banco, no es paginación del PDF.' },
  {
    patron: /^CUIT\s+\d{2}-\d{8}-\d\s+IVA\s+RESPONSABLE\s+INSCRIPTO$/i,
    motivo: 'CUIT del banco (no del titular) con su condición ante IVA, parte del encabezado.',
  },
  { patron: /^SUC:\s*\d+$/i, motivo: 'Código de sucursal, parte del encabezado.' },
];

/**
 * El período: UN solo fragmento con las dos fechas y el conector `AL` (spec §2, a diferencia de
 * Bancor, que trae dos fragmentos de fecha sueltos). Se busca sobre `textoDeFila` completo — la
 * etiqueta que antecede varía y no hace falta anclarla, la forma `fecha AL fecha` ya es específica.
 */
const RE_PERIODO = /(\d{2}\/\d{2}\/\d{4})\s*AL\s*(\d{2}\/\d{2}\/\d{4})/i;

/**
 * El anexo Ley 25413 (spec §6): `TOTAL GRAV. LEY 25413 DEL MES DE <mes>`, con el mes variable —
 * nunca se hardcodea el nombre del mes, es un hecho del período, no del banco. Mismo criterio que
 * `RE_TOTAL_CON_SIGNO_PESOS`/`ETIQUETAS_TOTALES_BANCOR` de `bancor.ts`: se usa el signo `$` para
 * decidir "esto no es un movimiento" y DESPUÉS se intenta anclar el literal conocido.
 */
const RE_TOTAL_CON_SIGNO_PESOS = /\$\s*(?:[\d.]+,\d{2}|\d+\.\d{2})/;
const RE_ETIQUETA_LEY_25413 = /^TOTAL\s+GRAV\.\s+LEY\s+25413\s+DEL\s+MES(?:\s+DE\s+\p{L}+)?/iu;

export type SalidaNacion = SalidaDeAdaptador & {
  readonly destinos: ConteoDeDestinos<DestinoBase>;
};

/**
 * 🔴 **Hallazgo de `tester`: las dos marcas exigidas en CUALQUIER posición de las primeras 15 filas
 * es un ancla débil.** Son dos líneas cortas y genéricas — "NACION ARGENTINA" en particular puede
 * aparecer en el disclaimer de CUALQUIER banco que mencione al Banco de la Nación Argentina como
 * tercero, y si `pdf.js` la envuelve en su propia fila geométrica, un documento de OTRO banco
 * quedaría mal reconocido como Nación (o disparando `banco_ambiguo` si además el banco real también
 * reconoce el archivo). El letterhead real mide las dos marcas en filas CONSECUTIVAS (0 y 1) — se
 * exige esa adyacencia, no solo la presencia de las dos en algún lugar del rango.
 */
export function reconoceNacion(filas: readonly FilaGeometrica[]): boolean {
  const textos = filas.slice(0, 15).map(textoDeFila);
  const [marcaUno, marcaDos] = MARCAS;
  if (!marcaUno || !marcaDos) return false;
  for (let i = 0; i < textos.length - 1; i += 1) {
    if (marcaUno.test(textos[i] ?? '') && marcaDos.test(textos[i + 1] ?? '')) return true;
  }
  return false;
}

/** Movimiento en construcción: en Nación, igual que Bancor, SIEMPRE cierra con su propia fila. */
type MovimientoEnCurso = {
  readonly movimiento: MovimientoBancarioCrudo;
  lineasExtra: string[];
};

export function leerNacion(filas: readonly FilaGeometrica[]): SalidaNacion {
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
  let filaNumero = 0;

  /** Cierra el movimiento en curso, absorbiendo sus líneas de continuación — mismo mecanismo que Bancor. */
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

  /**
   * `SALDO ANTERIOR`/`SALDO FINAL` (spec §5): misma lectura y mismo fail-closed para las dos
   * etiquetas — lo único que cambia entre ellas es a qué variable se asigna el resultado, así que
   * eso queda en el `if` del caller, no acá (hallazgo de `code-reviewer`: duplicación real entre
   * los dos bloques).
   *
   * 🔴 Sin importe legible en la ventana de saldo, `undefined` NUNCA se disfraza de
   * `saldoDeclarado`: una ventana mal medida (ya pasó una vez con esta misma columna, spec §4) tiene
   * que dejar rastro en `lineasNoInterpretadas`, no telemetría que dice "esto se leyó" cuando no se
   * leyó nada.
   */
  const leerSaldoDeclarado = (indice: number, fila: FilaGeometrica, texto: string): bigint | null => {
    cerrarContinuaciones();
    const frag = fragmentoDeColumna(fila, COLUMNAS.saldo.desde, COLUMNAS.saldo.hasta);
    const cent = frag ? importeACentavos(frag.texto) : null;
    if (cent === null) {
      marcar(indice, 'residuo');
      noInterpretadas.push({
        codigo: 'fila_sin_importe',
        forma: formaParaLog(texto, 60),
        paginaPdf: fila.pagina,
        indice,
      });
    } else {
      marcar(indice, 'saldoDeclarado');
    }
    return cent;
  };

  for (const [indice, fila] of filas.entries()) {
    const texto = textoDeFila(fila);
    if (texto === '') {
      marcar(indice, 'ruido');
      continue;
    }

    if (RE_SALDO_ANTERIOR.test(texto)) {
      const cent = leerSaldoDeclarado(indice, fila, texto);
      if (cent !== null) saldoAnteriorDeclarado = centavosAImporte(cent);
      continue;
    }

    if (RE_SALDO_FINAL.test(texto)) {
      const cent = leerSaldoDeclarado(indice, fila, texto);
      if (cent !== null) saldoFinalDeclarado = centavosAImporte(cent);
      continue;
    }

    const ruido = RUIDO_NACION.find((r) => r.patron.test(texto));
    if (ruido) {
      cerrarContinuaciones();
      marcar(indice, 'ruido');
      continue;
    }

    const bandaTexto = fragmentosEnBanda(fila, COLUMNAS.bandaFechaYConcepto.desde, COLUMNAS.bandaFechaYConcepto.hasta);
    const matchFecha = RE_FECHA_Y_RESTO.exec(bandaTexto);

    if (matchFecha?.[1] !== undefined) {
      cerrarContinuaciones();

      const fecha = parsearFecha(matchFecha[1], periodo ?? undefined);
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

      const glosa = (matchFecha[2] ?? '').trim();
      if (glosa === '') {
        // Fail-closed, mismo criterio que `bancor.ts`: no se arma un movimiento sin glosa.
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

      // Exactamente una de las dos columnas tiene que traer un importe. Ninguna, o las dos, es un
      // dato que no se puede clasificar — se reporta, no se adivina (mismo criterio que el XOR de
      // `movimientoBancarioCrudoSchema`).
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

      const importeCent = columna === 'debito' ? debitoCent! : creditoCent!;
      const importeToken = centavosAImporte(importeCent);

      const saldoFrag = fragmentoDeColumna(fila, COLUMNAS.saldo.desde, COLUMNAS.saldo.hasta);
      const saldoCent = saldoFrag ? importeACentavos(saldoFrag.texto) : null;

      const comprobFrag = fragmentoDeColumna(fila, COLUMNAS.comprobante.desde, COLUMNAS.comprobante.hasta);
      const comprobante = comprobFrag?.texto.trim();

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
        ...(comprobante ? { referencias: [{ tipo: 'operacion', valor: comprobante }] } : {}),
        filaHash: '',
      } as MovimientoBancarioCrudo;

      marcar(indice, 'movimiento');
      movimientos.push(movimiento);
      abierto = { movimiento, lineasExtra: [] };
      continue;
    }

    if (!RE_TOTAL_CON_SIGNO_PESOS.test(texto)) {
      // No es ni apertura de movimiento ni anexo: puede ser continuación de la glosa abierta.
      if (abierto) {
        const banda = fragmentosEnBanda(fila, COLUMNAS.bandaFechaYConcepto.desde, COLUMNAS.bandaFechaYConcepto.hasta);
        const tieneAlgoFueraDeLaBanda = fila.fragmentos.some((f) => f.x >= COLUMNAS.bandaFechaYConcepto.hasta);
        if (banda !== '' && !tieneAlgoFueraDeLaBanda) {
          abierto.lineasExtra.push(banda);
          marcar(indice, 'continuacion');
          continue;
        }
        cerrarContinuaciones();
      }
      // 🔴 Sin evidencia real de la forma de una continuación huérfana (sin movimiento abierto) en
      // este banco: NO se reporta como residuo acá, a diferencia de `bancor.ts`. Inventar ese patrón
      // generaría falsos positivos sobre la propia carátula real medida (fila 5 del documento: banda
      // angosta, sin `$`, sin movimiento abierto — es carátula legítima, no una anomalía). Se cuenta
      // como `fueraDelCuerpo`, mismo criterio que la carátula de los cuatro bancos anteriores.
      marcar(indice, 'fueraDelCuerpo');
      continue;
    }

    // Bloque de totales (spec §6): tiene `$` y no abrió movimiento.
    cerrarContinuaciones();
    const etiquetaMatch = RE_ETIQUETA_LEY_25413.exec(texto);
    const mImporte = /\$\s*([\d.]+,\d{2}|\d+\.\d{2})/.exec(texto);
    const importeAnexoCent = mImporte?.[1] ? importeACentavos(mImporte[1]) : null;

    if (etiquetaMatch && importeAnexoCent !== null) {
      ordenDeAnexo += 1;
      marcar(indice, 'anexo');
      anexos.push({
        tipoFila: 'anexo',
        // El literal completo, tal como lo escribe el banco — incluye el mes, que varía por período.
        conceptoLiteral: etiquetaMatch[0].replace(/\s+/g, ' ').trim(),
        ordenEnLote: ordenDeAnexo,
        atribucionCuenta: 'cuenta_unica_del_lote',
        periodoDato: 'no_publicado',
        importeDeclarado: centavosAImporte(importeAnexoCent),
        moneda: 'ARS',
        relacionConMovimientos: 'no_determinada',
        paginaPdf: fila.pagina,
      });
      continue;
    }

    marcar(indice, 'residuo');
    noInterpretadas.push({
      codigo: 'linea_fuera_de_zona',
      forma: formaParaLog(texto, 80),
      paginaPdf: fila.pagina,
      indice,
    });
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
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function leerPeriodo(filas: readonly FilaGeometrica[]): { desde: string; hasta: string } | null {
  for (const fila of filas.slice(0, 20)) {
    const m = RE_PERIODO.exec(textoDeFila(fila));
    if (!m?.[1] || !m[2]) continue;
    const desdeIso = aIso(m[1]);
    const hastaIso = aIso(m[2]);
    if (desdeIso && hastaIso) return { desde: desdeIso, hasta: hastaIso };
  }
  return null;
}

/**
 * El CUIT del titular: anclado a la etiqueta `CUIT:` (con dos puntos) como fragmento propio, seguido
 * por el número en un fragmento posterior de la misma fila. **Nunca el CUIT del banco** (spec §2):
 * ese viene sin etiqueta de dos puntos, con la leyenda fija "IVA RESPONSABLE INSCRIPTO" pegada, y ya
 * se descarta antes por `RUIDO_NACION`.
 */
function leerCuitTitular(filas: readonly FilaGeometrica[]): string | null {
  for (const fila of filas.slice(0, 20)) {
    const frags = fila.fragmentos;
    const idxEtiqueta = frags.findIndex((f) => /^CUIT:?$/i.test(f.texto.trim()));
    if (idxEtiqueta === -1) continue;
    for (let k = idxEtiqueta + 1; k < frags.length; k += 1) {
      const candidato = frags[k]?.texto.trim() ?? '';
      const m = RE_CUIT_COMPARTIDO.exec(candidato);
      RE_CUIT_COMPARTIDO.lastIndex = 0;
      if (m?.[0]) return m[0];
    }
  }
  return null;
}

/** El número de cuenta: 10 dígitos corridos, sin etiqueta textual propia medida (spec §2). */
const RE_NUMERO_CUENTA_NACION = /^\d{10}$/;

function leerNumeroDeCuentaNacion(filas: readonly FilaGeometrica[]): string | null {
  for (const fila of filas.slice(0, 20)) {
    const frag = fila.fragmentos.find((f) => RE_NUMERO_CUENTA_NACION.test(f.texto));
    if (frag) return frag.texto;
  }
  return null;
}

/** El CBU: 22 dígitos corridos, sin etiqueta textual propia medida (spec §2). */
const RE_CBU_NACION = /^\d{22}$/;

function leerCbuNacion(filas: readonly FilaGeometrica[]): string | null {
  for (const fila of filas.slice(0, 20)) {
    const frag = fila.fragmentos.find((f) => RE_CBU_NACION.test(f.texto));
    if (frag) return frag.texto;
  }
  return null;
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
  const numero = leerNumeroDeCuentaNacion(filas);
  const cbu = leerCbuNacion(filas);

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
      // 'completo': el ciclo de Nación arranca un día antes del mes calendario (spec §2) — es el
      // ciclo COMPLETO tal como el banco lo define, no un recorte.
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

export const adaptadorNacion = {
  bancoCodigo: BANCO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_NACION,
  reconoce: (e: EntradaDeAdaptador): boolean => reconoceNacion(e.filas),
  leer: (e: EntradaDeAdaptador): SalidaNacion => leerNacion(e.filas),
} as const;
