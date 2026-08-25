/**
 * ADAPTADOR BANCOR (Banco de la Provincia de Córdoba S.A.) — cuenta corriente en pesos, PDF.
 *
 * La especificación medida está en `docs/diseno/20-formato-bancor.md`. Este archivo la implementa y no
 * repite los números.
 *
 * ## Lo que distingue a este banco de los tres anteriores
 *
 * 1. **Una fila = un movimiento.** A diferencia de Galicia (par importe/saldo en una fila posterior a la
 *    fecha), acá la fila que trae la fecha ya trae concepto, referencia, importe y saldo completos. No
 *    hace falta un autómata que espere el cierre del bloque.
 * 2. **El importe es UNA sola columna, sin crédito/débito separados y sin signo** (spec §3, medido). La
 *    asignación se deriva de la cadena de saldos (spec §5): `delta = saldo(n) − saldo(n−1)`, comparación
 *    EXACTA en centavos, nunca por tolerancia — corrección de `tech-lead` sobre el primer borrador de la
 *    spec. Es un tercer mecanismo de signo, distinto de los dos que ya generaliza `parDeColumnas` (columna
 *    separada, o columna + token redundante): acá no hay ninguna columna que lo publique.
 * 3. **La fecha no trae año** (`dd/mm`): se resuelve contra el período de carátula, mismo criterio que
 *    Macro.
 * 4. **No corta `conceptoBanco`** de la glosa (spec §7, declarado): la banda de concepto mezcla literal y
 *    código de referencia sin un corte geométrico medido con confianza. Se declara ausente, no se inventa.
 */

import { formaParaLog } from '@sistema-contable/shared/observabilidad';
import { RE_CUIT as RE_CUIT_COMPARTIDO } from '@sistema-contable/shared/seguridad';
import { centavosAImporte, importeACentavos, importeCanonicoACentavos, parsearFecha } from '../parseo-ar.ts';
import { hashesDeCuenta, normalizarNumeroCuenta, type ClaveCuenta } from '../hash.ts';
import type {
  AnexoExtracto,
  CapacidadesAdaptador,
  CuentaConMovimientos,
  LineaNoInterpretada,
  MovimientoBancarioCrudo,
  RelacionAnexo,
} from '../esquema.ts';
import { fragmentoEnVentanaDerecha, fragmentoEnX, textoDeFila, type FilaGeometrica } from '../texto-pdf.ts';
import type { EntradaDeAdaptador, SalidaDeAdaptador } from './registro.ts';
import { contarDestinos, DESTINOS_BASE, type ConteoDeDestinos, type DestinoBase } from './toolkit.ts';

export const BANCO_CODIGO = 'bancor';
export const VERSION = 1;

/**
 * Capacidades declaradas — todas medidas contra el archivo real (`20-formato-bancor.md`), salvo
 * `traeMovimientosFueraDelPeriodo`, que se deja en `false` (conservador: la dirección que endurece el
 * control en vez de aflojarlo) porque no se corrió el barrido completo de las ~140 filas contra el
 * período — ver la nota de la spec §6.1.
 *
 * 🔴 `cadenaDeSaldos: 'completa'` **no es una segunda señal que contraste el signo, es la ÚNICA fuente**
 * (spec §5, hallazgo de `tech-lead`): con `traeSignoEnElImporte: false` y sin columna separada, todo
 * movimiento que `leerBancor` emite ya cumple la identidad de saldos por construcción — lo que no
 * cumpliera quedó excluido como residuo antes de llegar a `verificarAritmetica`. V1/V5 no son un control
 * independiente para este banco.
 */
export const CAPACIDADES_BANCOR: CapacidadesAdaptador = {
  familiaLayout: 'ancho-fijo',
  cadenaDeSaldos: 'completa',
  // El bloque final (spec §6) SÍ se captura, como `anexos[]` — 9 etiquetas confirmadas contra el
  // documento real. Pero no son `totalCreditosDeclarado`/`totalDebitosDeclarado` (eso es un total de
  // TODA la cuenta, y este bloque es un detalle de impuestos/retenciones): sigue en `false`.
  traeTotalesDeclarados: false,
  // "SALDO RES. ANTERIOR" viene con etiqueta explícita — no se deriva por aritmética, a diferencia de
  // Galicia.
  traeSaldoInicialDeclarado: true,
  traeSignoEnElImporte: false,
  traeSaldoPorFila: true,
  traeFechaValor: false,
  traeReferencia: true,
  traeCodigoDeConcepto: false,
  anioEnLaFecha: false,
  multiCuenta: false,
  multiMoneda: false,
  traeMovimientosFueraDelPeriodo: false,
  traeConsolidadoPorMoneda: false,
  declaraDestinos: true,
};

/** Las columnas, en puntos PDF (spec §3). */
const COLUMNAS = {
  fecha: { x: 88.0, tolerancia: 1.5 },
  concepto: { x: 172.2, tolerancia: 2 },
  referencia: { x: 265.0, tolerancia: 2 },
  importe: { desde: 360, hasta: 470 },
  saldo: { desde: 515, hasta: 535 },
} as const;

const RE_FECHA_CUERPO = /^\d{2}\/\d{2}$/;
const RE_FECHA_CON_ANIO = /^\d{2}\/\d{2}\/\d{4}$/;

/** Marcas del documento por las que se reconoce al banco (spec §1: letterhead, banco-genérico). */
const MARCAS = [/Banco de la Provincia de C[óo]rdoba S\.A\./i, /www\.bancor\.com\.ar/i];

/** La etiqueta que abre el cuerpo, con el saldo inicial (spec §3). */
const RE_SALDO_ANTERIOR = /^SALDO RES\. ANTERIOR\b/i;

/**
 * Lo que NO es un movimiento ni continuación (spec §2, §4): letterhead repetido por página, separador,
 * CUIT del banco. `SALDO RES. ANTERIOR` se intercepta ANTES de llegar acá (tiene que capturarse el saldo,
 * no solo descartarse) — no está en esta lista para no dejar dos caminos que hagan lo mismo.
 *
 * 🔴 A diferencia de Galicia, acá el ruido SÍ cierra el movimiento abierto (ver `leerBancor`): en este
 * banco un movimiento nunca continúa después de un salto de página — el letterhead que se repite en la
 * página siguiente no es una interrupción de glosa, es el final del bloque.
 */
const RUIDO_BANCOR: readonly { readonly patron: RegExp; readonly motivo: string }[] = [
  { patron: /^-+$/, motivo: 'Separador de pie de página.' },
  { patron: /^Banco de la Provincia de C[óo]rdoba S\.A\./i, motivo: 'Encabezado bancario, repetido por página.' },
  { patron: /www\.bancor\.com\.ar/i, motivo: 'Encabezado bancario (sitio web), repetido por página.' },
  { patron: /^C\.U\.I\.T\.\s/i, motivo: 'CUIT del banco (no del cliente), parte del encabezado.' },
];

/**
 * La forma de una línea de continuación (spec §4): arranca con una corrida de 5+ dígitos en la banda de
 * concepto — una referencia u operación asociada al movimiento anterior. **Deliberadamente estrecho**:
 * el texto del pie legal (varias oraciones, banco-genérico) también cae fuera de `RUIDO_BANCOR` y fuera
 * de la fecha, y si "continuación" fuera "cualquier texto con un movimiento abierto", ese pie terminaría
 * pegado a la glosa del último movimiento de la página — el mismo modo de falla que la spec del módulo
 * llama el peor: los números cuadran y la descripción queda contaminada.
 */
const RE_CONTINUACION = /^\d{5,}/;

/**
 * Cualquier línea del bloque de totales trae un importe con `$` — esto es lo que la distingue de un
 * movimiento del cuerpo (spec §6). Se usa PRIMERO para decidir "esto no es un movimiento", y DESPUÉS se
 * intenta anclar contra las 9 etiquetas conocidas (`ETIQUETAS_TOTALES_BANCOR`); lo que traiga `$` y no
 * matchee ninguna etiqueta conocida sigue reportándose como residuo — el vocabulario podría crecer.
 */
const RE_TOTAL_CON_SIGNO_PESOS = /\$\s*(?:[\d.]+,\d{2}|\d+\.\d{2})/;

/**
 * Las 9 etiquetas del bloque de totales, confirmadas por JP contra el documento real (spec §6) — nunca
 * un agente leyó el literal. Ancladas al inicio (`^Total\s+...`), en orden de más específico a menos
 * para que `SIRCREB` sola (etiqueta 4) no capture por error a `SIRCREB CBA`/`C.A.B.A.`/`Sta. Fe.` — su
 * propio patrón exige que el `:` venga INMEDIATAMENTE después de `SIRCREB`, así que en la práctica el
 * orden no cambia el resultado, pero se mantiene explícito para que quede legible.
 *
 * `relacionConMovimientos` es `'resume_movimientos_del_cuerpo'` únicamente para las dos etiquetas con
 * cruce implementado (`verificarTotalesBancor`, spec §6.1) — las otras 7 quedan `'no_determinada'`:
 * fail-closed, no se afirma una relación que no se verificó.
 */
const ETIQUETAS_TOTALES_BANCOR: readonly {
  readonly patron: RegExp;
  readonly conceptoLiteral: string;
  readonly relacion: RelacionAnexo;
}[] = [
  {
    patron: /^Total\s+Impuesto\s+al\s+Valor\s+Agregado\b/i,
    conceptoLiteral: 'Total Impuesto al Valor Agregado',
    relacion: 'resume_movimientos_del_cuerpo',
  },
  {
    patron: /^Total\s+Imp\.?\s*L\.?\s*Competitiv\.?\s*Cr[eé]dito\s+Compensable\b/i,
    conceptoLiteral: 'Total Imp.L.Competitiv. Credito Compensable',
    relacion: 'no_determinada',
  },
  {
    patron: /^Total\s+Imp\.?\s*Ley\s+de\s+Competitividad\b/i,
    conceptoLiteral: 'Total Imp.Ley de Competitividad',
    relacion: 'no_determinada',
  },
  {
    patron: /^Total\s+SIRCREB\s+CBA\b/i,
    conceptoLiteral: 'Total SIRCREB CBA',
    relacion: 'resume_movimientos_del_cuerpo',
  },
  {
    patron: /^Total\s+SIRCREB\s+C\.?\s*A\.?\s*B\.?\s*A\.?\b/i,
    conceptoLiteral: 'Total SIRCREB C.A.B.A.',
    relacion: 'no_determinada',
  },
  {
    patron: /^Total\s+SIRCREB\s+Sta\.?\s*Fe\.?\b/i,
    conceptoLiteral: 'Total SIRCREB Sta. Fe.',
    relacion: 'no_determinada',
  },
  {
    // Anclada con `\s*:` para no capturar "SIRCREB CBA"/"SIRCREB C.A.B.A."/"SIRCREB Sta. Fe." — esas
    // tienen más palabras entre "SIRCREB" y el ":".
    patron: /^Total\s+SIRCREB\s*:/i,
    conceptoLiteral: 'Total SIRCREB',
    relacion: 'no_determinada',
  },
  {
    patron: /^Total\s+Percepciones\s+C\.?\s*A\.?\s*B\.?\s*A\.?\b/i,
    conceptoLiteral: 'Total Percepciones C.A.B.A.',
    relacion: 'no_determinada',
  },
  {
    patron: /^Total\s+Percepciones\s+por\s+consumos\s+en\s+el\s+exterior\b/i,
    conceptoLiteral: 'Total Percepciones por consumos en el exterior',
    relacion: 'no_determinada',
  },
];

/**
 * El importe del bloque de totales viene en DOS formatos dentro del MISMO bloque, confirmado por JP
 * contra el documento real (spec §6): argentino (`1.234,56`, coma decimal) cuando el importe es
 * distinto de cero, y con PUNTO decimal (`0.00`, sin separador de miles) cuando es cero — 5 de las 9
 * líneas, en el documento medido. Aceptar solo uno de los dos formatos deja esas líneas sin importe
 * pese a que la etiqueta matchea perfecto.
 */
function importeAnexoACentavos(token: string): bigint | null {
  if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(token)) return importeACentavos(token);
  const puntoDecimal = /^(\d+)\.(\d{2})$/.exec(token);
  if (puntoDecimal?.[1] !== undefined && puntoDecimal[2] !== undefined) {
    return BigInt(puntoDecimal[1]) * 100n + BigInt(puntoDecimal[2]);
  }
  return null;
}

/** Corta el importe (cualquiera de los dos formatos) de una línea del bloque de totales. */
function leerImporteDeAnexo(texto: string): { readonly token: string; readonly cent: bigint } | null {
  const m = /\$\s*([\d.]+,\d{2}|\d+\.\d{2})/.exec(texto);
  if (!m?.[1]) return null;
  const cent = importeAnexoACentavos(m[1]);
  return cent === null ? null : { token: m[1], cent };
}

export type SalidaBancor = SalidaDeAdaptador & {
  readonly destinos: ConteoDeDestinos<DestinoBase>;
};

export function reconoceBancor(filas: readonly FilaGeometrica[]): boolean {
  const textos = filas.slice(0, 15).map(textoDeFila);
  return MARCAS.every((m) => textos.some((t) => m.test(t)));
}

/** Movimiento en construcción: en Bancor SIEMPRE cierra con su propia fila (spec §3). */
type MovimientoEnCurso = {
  readonly movimiento: MovimientoBancarioCrudo;
  lineasExtra: string[];
};

export function leerBancor(filas: readonly FilaGeometrica[]): SalidaBancor {
  const noInterpretadas: LineaNoInterpretada[] = [];
  const movimientos: MovimientoBancarioCrudo[] = [];
  const anexos: AnexoExtracto[] = [];
  let ordenDeAnexo = 0;
  const periodo = leerPeriodo(filas);

  const destinoDeFila = new Map<number, DestinoBase>();
  const marcar = (i: number, destino: DestinoBase): void => {
    destinoDeFila.set(i, destino);
  };

  let saldoAnteriorCent: bigint | null = null;
  let abierto: MovimientoEnCurso | null = null;
  let filaNumero = 0;

  /**
   * Cierra el movimiento en curso: absorbe sus líneas de continuación y recompila `descripcion` a
   * partir de `descripcionLineas` completo. El objeto ya está en `movimientos` (se empuja al abrirlo,
   * porque en Bancor un movimiento nunca necesita esperar más datos) — acá se lo MUTA en el lugar, no se
   * reconstruye, para no duplicar la lógica de armado.
   */
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

  for (const [indice, fila] of filas.entries()) {
    const texto = textoDeFila(fila);
    if (texto === '') {
      marcar(indice, 'ruido');
      continue;
    }

    const saldoInicial = leerSaldoAnterior(texto);
    if (saldoInicial !== null) {
      cerrarContinuaciones();
      saldoAnteriorCent = saldoInicial;
      marcar(indice, 'saldoDeclarado');
      continue;
    }

    if (RUIDO_BANCOR.some((r) => r.patron.test(texto))) {
      cerrarContinuaciones();
      marcar(indice, 'ruido');
      continue;
    }

    const fechaFrag = fragmentoEnX(fila, COLUMNAS.fecha.x, COLUMNAS.fecha.tolerancia);
    const abreMovimiento = fechaFrag !== undefined && RE_FECHA_CUERPO.test(fechaFrag.texto);

    /**
     * 🔴 El chequeo del bloque de totales va DESPUÉS de intentar abrir movimiento, no antes (hallazgo de
     * `tester`): evaluado contra `textoDeFila` completo, un `$` legítimo dentro del CONCEPTO de un
     * movimiento real (p. ej. una glosa que cita un importe) haría desaparecer la fila entera. Una fila
     * que además abre movimiento (fecha válida en su columna) nunca puede ser el bloque de totales — esa
     * sección no tiene fecha en `x≈88` (spec §6) — así que se prioriza abrir el movimiento primero.
     */
    if (!abreMovimiento && RE_TOTAL_CON_SIGNO_PESOS.test(texto)) {
      cerrarContinuaciones();

      const etiqueta = ETIQUETAS_TOTALES_BANCOR.find((e) => e.patron.test(texto));
      const importe = leerImporteDeAnexo(texto);

      if (etiqueta && importe) {
        // Anexo reconocido (spec §6): las 9 etiquetas confirmadas por JP, cualquiera de los dos
        // formatos de importe. `periodoDato: 'no_publicado'` — el bloque no declara período propio y
        // el sistema nunca lo rellena con el del extracto.
        ordenDeAnexo += 1;
        marcar(indice, 'anexo');
        anexos.push({
          tipoFila: 'anexo',
          conceptoLiteral: etiqueta.conceptoLiteral,
          ordenEnLote: ordenDeAnexo,
          atribucionCuenta: 'cuenta_unica_del_lote',
          periodoDato: 'no_publicado',
          importeDeclarado: centavosAImporte(importe.cent),
          moneda: 'ARS',
          relacionConMovimientos: etiqueta.relacion,
          paginaPdf: fila.pagina,
        });
        continue;
      }

      // Trae `$` pero no matchea ninguna de las 9 etiquetas conocidas (o el importe no se pudo leer):
      // se reporta, no se descarta — el vocabulario del bloque podría crecer en otro extracto.
      marcar(indice, 'residuo');
      noInterpretadas.push({
        codigo: 'linea_fuera_de_zona',
        forma: formaParaLog(texto, 80),
        paginaPdf: fila.pagina,
        indice,
      });
      continue;
    }

    if (abreMovimiento && fechaFrag) {
      cerrarContinuaciones();

      const fecha = parsearFecha(fechaFrag.texto, periodo ?? undefined);
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

      if (saldoAnteriorCent === null) {
        // No hay saldo del que derivar el signo: sin `SALDO RES. ANTERIOR` leído todavía, este
        // movimiento no se puede clasificar crédito/débito. Fail-closed: se reporta, no se adivina.
        marcar(indice, 'residuo');
        noInterpretadas.push({
          codigo: 'fila_sin_importe',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice,
        });
        continue;
      }

      const par = leerImporteYSaldo(fila);
      if (par === null) {
        marcar(indice, 'residuo');
        noInterpretadas.push({
          codigo: 'fila_sin_importe',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice,
        });
        continue;
      }

      const columna = columnaPorCadenaDeSaldos(saldoAnteriorCent, par.saldoCent, par.importeCent);
      if (columna === null) {
        // La cadena no cierra en ninguna dirección: la fila no se descarta, se reporta con su forma —
        // es exactamente el caso que este mecanismo existe para no encubrir (spec §5).
        marcar(indice, 'residuo');
        noInterpretadas.push({
          codigo: 'importe_en_columna_desconocida',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice,
        });
        saldoAnteriorCent = par.saldoCent;
        continue;
      }

      const glosa = glosaDe(fila);
      if (glosa === '') {
        // 🔴 Hallazgo de `code-reviewer`: sin esto, se emitía un movimiento con `descripcionLineas: []` y
        // `descripcion: ''`, un estado que `movimientoBancarioCrudoSchema` declara imposible
        // (`.min(1)` en las dos). Fail-closed, mismo criterio que `macro.ts` (`columna_sin_ancla`): la
        // cadena de saldos SÍ avanza (el dato del saldo es real, se leyó bien), pero no se arma un
        // movimiento sin glosa.
        saldoAnteriorCent = par.saldoCent;
        marcar(indice, 'residuo');
        noInterpretadas.push({
          codigo: 'columna_sin_ancla',
          forma: formaParaLog(texto, 60),
          paginaPdf: fila.pagina,
          indice,
        });
        continue;
      }

      saldoAnteriorCent = par.saldoCent;
      filaNumero += 1;
      const referencias = leerReferencia(fila);

      const movimiento = {
        tipoFila: 'movimiento',
        fecha,
        descripcionLineas: [glosa],
        descripcion: glosa,
        ...(columna === 'credito' ? { credito: par.importe } : { debito: par.importe }),
        columnaOrigen: columna,
        importe: columna === 'credito' ? par.importe : `-${par.importe}`,
        saldo: par.saldo,
        saldoEsAcreedor: par.saldoCent < 0n,
        moneda: 'ARS',
        cotizacionProvista: false,
        filaNumero,
        paginaPdf: fila.pagina,
        ...(referencias.length > 0 ? { referencias } : {}),
        filaHash: '',
      } as MovimientoBancarioCrudo;

      marcar(indice, 'movimiento');
      movimientos.push(movimiento);
      abierto = { movimiento, lineasExtra: [] };
      continue;
    }

    const conceptoFrag = fragmentoEnX(fila, COLUMNAS.concepto.x, COLUMNAS.concepto.tolerancia);
    const tieneFormaDeContinuacion = conceptoFrag !== undefined && RE_CONTINUACION.test(conceptoFrag.texto);

    if (abierto && tieneFormaDeContinuacion) {
      // Línea de continuación (spec §4): no cierra ni abre nada, ya está todo capturado en la fila de
      // fecha. Se agrega como línea extra de la glosa, para no perder el dato.
      const extra = texto.trim();
      if (extra !== '') abierto.lineasExtra.push(extra);
      marcar(indice, 'continuacion');
      continue;
    }
    if (abierto) {
      // No tiene la forma de una continuación: cierra el movimiento en vez de arriesgar que un renglón
      // ajeno (carátula de la página siguiente, pie legal) se pegue a la glosa del último movimiento.
      cerrarContinuaciones();
    }

    if (tieneFormaDeContinuacion) {
      // 🔴 Hallazgo de `tester`: tiene la FORMA de una continuación pero no hay movimiento abierto al
      // que atribuirla — antes cayía en silencio a `fueraDelCuerpo`. La spec (§4) promete que esto se
      // reporta, no que se descarta.
      marcar(indice, 'residuo');
      noInterpretadas.push({
        codigo: 'linea_fuera_de_zona',
        forma: formaParaLog(texto, 60),
        paginaPdf: fila.pagina,
        indice,
      });
      continue;
    }

    // Fuera de todo bloque: carátula, pie legal. Se cuenta, no se reporta como residuo — mismo criterio
    // que `fueraDelCuerpo` en `galicia.ts`/`santander.ts`/`macro.ts`.
    marcar(indice, 'fueraDelCuerpo');
  }
  // Cierra el último movimiento abierto: absorbe sus continuaciones, si las tuviera, antes de armar la
  // cuenta — el bucle terminó y nadie más va a llamar a `cerrarContinuaciones()`.
  cerrarContinuaciones();

  const cuenta = armarCuenta(filas, movimientos, periodo, anexos);
  return {
    cuentas: cuenta ? [cuenta] : [],
    lineasNoInterpretadas: noInterpretadas,
    paginasDeclaradas: leerPaginasDeclaradas(filas),
    destinos: contarDestinos(DESTINOS_BASE, destinoDeFila, filas.length),
  };
}

/** Corta el saldo inicial de `SALDO RES. ANTERIOR <importe>`, o `null` si la línea no es esa. */
function leerSaldoAnterior(texto: string): bigint | null {
  if (!RE_SALDO_ANTERIOR.test(texto)) return null;
  const m = /([\d.]+,\d{2})\s*$/.exec(texto);
  if (!m?.[1]) return null;
  return importeACentavos(m[1]);
}

function glosaDe(fila: FilaGeometrica): string {
  const f = fragmentoEnX(fila, COLUMNAS.concepto.x, COLUMNAS.concepto.tolerancia);
  return f?.texto.trim() ?? '';
}

function leerReferencia(
  fila: FilaGeometrica,
): readonly { readonly tipo: 'operacion'; readonly valor: string }[] {
  const f = fragmentoEnX(fila, COLUMNAS.referencia.x, COLUMNAS.referencia.tolerancia);
  const valor = f?.texto.trim();
  return valor ? [{ tipo: 'operacion', valor }] : [];
}

function leerImporteYSaldo(
  fila: FilaGeometrica,
): { readonly importe: string; readonly importeCent: bigint; readonly saldo: string; readonly saldoCent: bigint } | null {
  const saldoFrag = fragmentoEnVentanaDerecha(fila, COLUMNAS.saldo.desde, COLUMNAS.saldo.hasta);
  if (!saldoFrag) return null;
  const saldoCent = importeACentavos(saldoFrag.texto);
  if (saldoCent === null) return null;

  const importeFrag = fragmentoEnVentanaDerecha(fila, COLUMNAS.importe.desde, COLUMNAS.importe.hasta);
  if (!importeFrag || importeFrag === saldoFrag) return null;
  const importeCentSinSigno = importeACentavos(importeFrag.texto);
  if (importeCentSinSigno === null) return null;
  // El importe NUNCA trae signo en este banco (spec §3): si el parser leyera uno negativo, algo está mal
  // con la columna, no con el dato — se rechaza la fila en vez de asumir cuál mitad está mal.
  if (importeCentSinSigno < 0n) return null;

  return {
    importe: centavosAImporte(importeCentSinSigno),
    importeCent: importeCentSinSigno,
    saldo: centavosAImporte(saldoCent),
    saldoCent,
  };
}

/**
 * Deriva crédito/débito de la cadena de saldos (spec §5). Comparación EXACTA en centavos —
 * `tech-lead`: no hay float que redondear, así que una tolerancia sería el único punto del módulo donde
 * una fila mal leída podría colarse como "cierra igual".
 */
function columnaPorCadenaDeSaldos(
  saldoAnteriorCent: bigint,
  saldoActualCent: bigint,
  importeCent: bigint,
): 'credito' | 'debito' | null {
  // Hallazgo de `tester`/`code-reviewer`: con importe 0 las dos ramas de abajo son ciertas a la vez
  // (delta === 0 === -0), y "crédito" ganaría por orden del `if`, no por evidencia. No medido contra el
  // archivo real (§8 no sugiere movimientos de importe cero) — se declara indeterminado en vez de
  // arbitrario.
  if (importeCent === 0n) return null;
  const delta = saldoActualCent - saldoAnteriorCent;
  if (delta === importeCent) return 'credito';
  if (delta === -importeCent) return 'debito';
  return null;
}

/**
 * El período de carátula: dos fechas `dd/mm/yyyy` en la misma fila (spec §2), sin conector entre ellas.
 *
 * 🔴 **Exactamente dos, no "al menos dos"** (hallazgo de `tester`): con `>= 2` una fila con una tercera
 * fecha decoy —una fecha de emisión, por ejemplo, compartiendo baseline con el período— tomaría las
 * primeras dos por posición sin ninguna garantía de que sean el período real, y un período invertido
 * rechaza el archivo entero en silencio (`parsearFecha` compara ISO contra él). Con `=== 2`, una fila
 * ambigua simplemente no califica y se sigue buscando — fail-closed, no plausible-y-mal.
 */
function leerPeriodo(filas: readonly FilaGeometrica[]): { desde: string; hasta: string } | null {
  for (const fila of filas.slice(0, 40)) {
    const fechas = fila.fragmentos.filter((f) => RE_FECHA_CON_ANIO.test(f.texto));
    if (fechas.length !== 2) continue;
    const [desde, hasta] = fechas;
    if (!desde || !hasta) continue;
    const desdeIso = aIso(desde.texto);
    const hastaIso = aIso(hasta.texto);
    if (desdeIso && hastaIso) return { desde: desdeIso, hasta: hastaIso };
  }
  return null;
}

function aIso(ddmmyyyy: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** `Hoja N de M`-equivalente: no se midió una etiqueta de paginación declarada distinta de `paginas`. */
function leerPaginasDeclaradas(_filas: readonly FilaGeometrica[]): number | undefined {
  return undefined;
}

/** El CUIT del titular: 11 dígitos corridos, ancla en la etiqueta `TITULAR` que viene DESPUÉS (spec §2). */
function leerCuitTitular(filas: readonly FilaGeometrica[]): string | null {
  const textos = filas.slice(0, 30).map(textoDeFila);
  for (const [i, t] of textos.entries()) {
    if (t.trim().toUpperCase() !== 'TITULAR') continue;
    for (let k = 1; k <= 2 && i - k >= 0; k += 1) {
      const candidato = textos[i - k]?.trim() ?? '';
      const m = RE_CUIT_COMPARTIDO.exec(candidato);
      RE_CUIT_COMPARTIDO.lastIndex = 0;
      if (m?.[0]) return m[0];
    }
  }
  return null;
}

function armarCuenta(
  filas: readonly FilaGeometrica[],
  movimientos: readonly MovimientoBancarioCrudo[],
  periodo: { readonly desde: string; readonly hasta: string } | null,
  anexos: readonly AnexoExtracto[],
): CuentaConMovimientos | null {
  if (movimientos.length === 0) return null;

  const titularDocumento = leerCuitTitular(filas);

  const clave: ClaveCuenta = {
    bancoCodigo: BANCO_CODIGO,
    // Sin número de cuenta con etiqueta propia medido en este archivo (spec §2: el ancla de identidad es
    // el CUIT del titular, no un número de cuenta). Se normaliza `'sin_numero'` como el resto del roster
    // hace cuando el dato no está — INV-6 resuelve igual por CUIT/CBU cuando estén disponibles.
    numeroNormalizado: normalizarNumeroCuenta('sin_numero'),
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

  const primera = movimientos[0];
  const ultima = movimientos[movimientos.length - 1];
  const saldoInicialCent = primera ? importeCanonicoACentavos(primera.saldo ?? '') : null;
  const importePrimeraCent = primera ? importeCanonicoACentavos(primera.importe) : null;
  const saldoInicial =
    saldoInicialCent !== null && importePrimeraCent !== null
      ? centavosAImporte(saldoInicialCent - importePrimeraCent)
      : undefined;

  return {
    cuenta: {
      denominacion: 'CUENTA CORRIENTE EN PESOS',
      tipoCuenta: 'cuenta_corriente',
      moneda: 'ARS',
      ...(periodo ? { periodoDesde: periodo.desde, periodoHasta: periodo.hasta } : {}),
      ...(saldoInicial === undefined ? {} : { saldoInicialDeclarado: saldoInicial }),
      ...(ultima?.saldo === undefined ? {} : { saldoFinalDeclarado: ultima.saldo }),
      ...(titularDocumento === null ? {} : { titularDocumento }),
    },
    movimientos: conHash,
    anexos: [...anexos],
  };
}

/**
 * Los dos cruces del bloque de totales que SÍ tienen literal de cuerpo confirmado (spec §6.1, sugeridos
 * por JP): "Total SIRCREB CBA" contra la suma de movimientos `RECAU.SIRCREB CBA`, y "Total Impuesto al
 * Valor Agregado" contra la suma de movimientos `IVA 21%` + `COMISIONES`.
 *
 * 🔴 El segundo cruce (`IVA 21%`/`COMISIONES`) se busca por SUBSTRING sobre `descripcion` —no está
 * medido geométricamente por este adapter, es el literal que indicó JP leyendo el documento. El primero
 * (`RECAU.SIRCREB CBA`) sí es un literal ya confirmado independientemente (spec §8).
 *
 * Función PURA, separada del contrato `SalidaDeAdaptador` — no cambia lo que ya consume el registro ni
 * el CLI. **Nunca fuerza a que cuadre**: si no hay anexo con ese `conceptoLiteral`, no hay resultado
 * para ese cruce; si la suma no coincide, `coincide: false` y las dos cifras quedan expuestas para que
 * quien la use decida qué hacer — mismo criterio que el resto del proyecto (reportar, no reconciliar).
 */
export type VerificacionTotalBancor = {
  readonly conceptoLiteral: string;
  readonly declarado: string;
  readonly calculado: string;
  readonly coincide: boolean;
};

const CRUCES_DE_TOTALES: readonly { readonly conceptoLiteral: string; readonly contieneEnGlosa: readonly string[] }[] =
  [
    { conceptoLiteral: 'Total SIRCREB CBA', contieneEnGlosa: ['RECAU.SIRCREB CBA'] },
    { conceptoLiteral: 'Total Impuesto al Valor Agregado', contieneEnGlosa: ['IVA 21%', 'COMISIONES'] },
  ];

export function verificarTotalesBancor(cuenta: CuentaConMovimientos): readonly VerificacionTotalBancor[] {
  const magnitud = (importeCanonico: string): bigint => {
    const c = importeCanonicoACentavos(importeCanonico) ?? 0n;
    return c < 0n ? -c : c;
  };

  const resultados: VerificacionTotalBancor[] = [];
  for (const cruce of CRUCES_DE_TOTALES) {
    const anexo = cuenta.anexos.find((a) => a.conceptoLiteral === cruce.conceptoLiteral);
    if (!anexo) continue;

    const sumaCent = cuenta.movimientos
      .filter((m) =>
        cruce.contieneEnGlosa.every((token) => m.descripcion.toUpperCase().includes(token.toUpperCase())),
      )
      .reduce((acc, m) => acc + magnitud(m.importe), 0n);

    resultados.push({
      conceptoLiteral: cruce.conceptoLiteral,
      declarado: anexo.importeDeclarado,
      calculado: centavosAImporte(sumaCent),
      coincide: sumaCent === (importeCanonicoACentavos(anexo.importeDeclarado) ?? 0n),
    });
  }
  return resultados;
}

export const adaptadorBancor = {
  bancoCodigo: BANCO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_BANCOR,
  reconoce: (e: EntradaDeAdaptador): boolean => reconoceBancor(e.filas),
  leer: (e: EntradaDeAdaptador): SalidaBancor => leerBancor(e.filas),
} as const;
