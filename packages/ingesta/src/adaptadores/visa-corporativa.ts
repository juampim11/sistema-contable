/**
 * ADAPTADOR VISA CORPORATIVA — resumen de cuenta de tarjeta de crédito corporativa, PDF.
 *
 * Sigue el contrato de **adaptador bancario** (`registro.ts`), no el de liquidaciones a comercio
 * (`packages/ingesta/src/liquidaciones/`) — decisión ya cerrada por `arquitecto-software`: este
 * documento es el resumen que recibe el TITULAR de la tarjeta, no la liquidación que recibe un
 * comercio.
 *
 * Medido contra 3 resúmenes reales de un cliente del piloto (Bracci Repuestos S.A.S.), mayo, junio
 * y julio de 2026 — **solo forma geométrica** (`formaParaLog`/coordenadas), nunca el contenido. El
 * archivo de origen no se nombra acá (regla dura del proyecto: ni un dato de cliente en un
 * comentario).
 *
 * ## 🔴 Lo medido difiere de lo esperado antes de escribir este archivo — documentado, no corregido en silencio
 *
 * La expectativa previa era "encabezado en la página 1, listado de consumos en las páginas 2 a 4,
 * ~44-46 filas por página". **La geometría real de los 3 documentos la refuta**:
 *
 *   - Las páginas 2 a 5 son **términos y condiciones** (prosa legal, ~1 fragmento por fila) y una
 *     tabla de tasas — CERO filas con fecha en las tres. Confirmado con un barrido que cuenta filas
 *     cuyo primer fragmento tiene forma `##-##-##` en `x≈22.8`: **0** en páginas 3, 4 y 5 de los tres
 *     meses, y 0 en la página 2 del mes con menos actividad.
 *   - El listado de consumos entero vive en la **página 1**, con desborde a la **página 2** cuando no
 *     entra completo (medido: un mes desborda 7 filas, otro 5). Página 6 es una imagen (bug de OCR ya
 *     documentado en `docs/diseno/27-roadmap-capa-d.md:40`) y el contrato de este adaptador nunca la
 *     toca — `EntradaDeAdaptador` solo trae `filas: FilaGeometrica[]` de texto nativo.
 *   - El volumen real medido es **muy inferior** al esperado (decenas, no cientos, por mes). Se
 *     reporta el conteo real y no se ajusta la expectativa acá: es dato para que lo evalúe quien
 *     conduce, no una corrección que este archivo se atribuya solo.
 *
 * ## Cómo se separa un CONSUMO real de un renglón de intereses/cargos financieros
 *
 * La página 1 trae, después de la carátula, un bloque de **detalle de intereses y cargos** (tasas,
 * IVA sobre intereses, pago mínimo) que **también** arranca cada fila con una fecha `dd-mm-aa` — así
 * que "hay fecha" no alcanza para reconocer un consumo. La señal que sí separa los dos, medida en
 * los 3 documentos: **todo consumo real trae un código de comprobante de 6 dígitos** en
 * `x≈358-375` (`AUTH_CODE`, capturado como `referencias[].tipo:'operacion'`); el bloque de intereses
 * nunca lo trae. Con esa señal como compuerta, ninguna fila del bloque de intereses entra como
 * movimiento — queda en `lineasNoInterpretadas` con código `linea_fuera_de_zona`, visible y no
 * modelada en esta versión (no se inventa qué es cada renglón sin poder leer su etiqueta con
 * confianza — ver la nota sobre `formaParaLog` más abajo).
 *
 * ## Por qué no hay literales de etiqueta en el código de reconocimiento de filas
 *
 * Todo lo medido para diseñar las ventanas de columna se hizo **exclusivamente sobre la forma**
 * (`formaParaLog`: dígitos a `9`/`#`, mayúsculas a `A`, minúsculas a `a`) — nunca sobre el texto real
 * del documento. Eso significa que no hay certeza de la palabra exacta detrás de cada forma, y por
 * eso este archivo NO inventa literales en español para clasificar filas por posición o forma (sería
 * adivinar un rótulo que nunca se leyó). Las únicas cadenas literales que aparecen abajo
 * (`reconoceVisaCorporativa`) son el vocabulario que el propio pedido de esta tarea **ya midió y
 * confirmó presente** en los tres documentos — no una reconstrucción propia.
 *
 * ## Moneda extranjera: una segunda forma de columna de importe, medida y con salida fail-closed
 *
 * Un subconjunto de filas de consumo no trae importe en la ventana principal (`x∈[485,500]` borde
 * derecho) sino un código de 3 letras mayúsculas (forma de código de moneda ISO) más un importe
 * chico en `x∈[215,260]`. Se declara `moneda: 'USD'` **únicamente** cuando ese código coincide
 * EXACTO con `'USD'`; cualquier otro código de 3 letras (o su ausencia) deja la fila sin interpretar
 * — nunca se asume `ARS` por descarte ni se inventa otra moneda fuera de `MONEDAS`.
 *
 * ## Dos `CuentaDetectada`, una por moneda — nunca una cuenta con ARS y USD mezclados
 *
 * `cuenta_bancaria.moneda` es `char(3) not null` en el esquema físico: una fila, una moneda (V12,
 * `docs/diseno/01-modulo-1-ingesta-bancaria.md:313`). La primera versión de este adaptador armaba UNA
 * cuenta con los movimientos de las dos monedas adentro, y el lote daba `EST_MONEDA_MEZCLADA` apenas
 * había un consumo en dólares — confirmado por `code-reviewer` y `tester` en paralelo. La misma
 * tarjeta física es DOS posiciones (`leerVisaCorporativa` arma una `CuentaConMovimientos` por cada
 * valor de `MONEDAS`, `multiCuenta: true`) — mismo patrón que `macro.ts` (`armarCuentaDetectada`, una
 * cuenta por sección/moneda, no se copia su lógica de columnas). Confirmado por `arquitecto-software`
 * + `contador-dominio`: la partición es solo trazabilidad de captura y no contamina "un asiento por
 * resumen" (Módulo 2), porque cada línea sigue llevando su `moneda` de origen en el movimiento. Una
 * moneda con CERO movimientos ese mes emite igual su cuenta (0 movimientos es un lote legítimo, no un
 * error — mismo criterio que la cuenta en dólares de Macro).
 *
 * ## Signo: sin columna de saldo explotable, sin convención de signo confiable — consultado con `contador-dominio`
 *
 * `traeSaldoPorFila`/`cadenaDeSaldos` son `false`/`'no_disponible'` (medido: no hay columna de saldo
 * corrido explotable en ninguno de los 3 documentos). Sin cadena de saldos y sin signo confiable en
 * el importe (medido: un signo `-` explícito aparece en muy pocas filas), el criterio consultado y
 * confirmado por `contador-dominio` es:
 *
 *   1. Signo `-` explícito en el importe → `credito` (señal estructural inequívoca del documento).
 *   2. Sin signo, y la glosa NO matchea vocabulario de crédito (`VOCABULARIO_CREDITO`) → `debito`
 *      por defecto (es la mayoría medida: un consumo es, por default, un cargo a la cuenta).
 *   3. Sin signo, pero la glosa SÍ matchea vocabulario de crédito → **no se emite el movimiento**:
 *      dos señales estructurales se contradicen, y el default no puede ganar en silencio. Va a
 *      `lineasNoInterpretadas` con código `desconocido` — visible para revisión, nunca resuelto por
 *      la regla de mayoría.
 *
 * `origenSigno` queda `undefined`: el mecanismo (token con signo opcional + vocabulario de
 * contraste) no es ninguno de los tres valores de `ORIGENES_SIGNO` — mismo criterio que los cuatro
 * bancos que tampoco lo declaran.
 *
 * Pendiente, no implementado en esta versión (declarado, no escondido): el cruce contra un total de
 * página o de período para VALIDAR la partición fila por fila, que `contador-dominio` señaló como
 * la segunda pata que le falta a este criterio para ser más que "una mayoría estadística".
 */

import { formaParaLog } from '@sistema-contable/shared/observabilidad';
import { luhnEsValido, RE_CUIT as RE_CUIT_COMPARTIDO, RE_PAN, sinEstado, ultimos4 } from '@sistema-contable/shared/seguridad';
import { centavosAImporte, importeACentavos, normalizar, parsearFecha } from '../parseo-ar.ts';
import { hashesDeCuenta, normalizarNumeroCuenta, type ClaveCuenta } from '../hash.ts';
import {
  MONEDAS,
  type CapacidadesAdaptador,
  type CuentaConMovimientos,
  type LineaNoInterpretada,
  type Moneda,
  type MovimientoBancarioCrudo,
} from '../esquema.ts';
import { fragmentoEnVentanaDerecha, fragmentoEnX, textoDeFila, type FilaGeometrica } from '../texto-pdf.ts';
import type { EntradaDeAdaptador, SalidaDeAdaptador } from './registro.ts';
import { contarDestinos, DESTINOS_BASE, type ConteoDeDestinos, type DestinoBase } from './toolkit.ts';

export const BANCO_CODIGO = 'visa_corporativa';
export const VERSION = 1;

/**
 * Capacidades declaradas — lo MEDIDO contra los 3 documentos reales, no lo ideal. Ver el comentario
 * de cabecera para el detalle de cada una.
 */
export const CAPACIDADES_VISA_CORPORATIVA: CapacidadesAdaptador = {
  familiaLayout: 'columnas-posicionales',
  cadenaDeSaldos: 'no_disponible',
  traeTotalesDeclarados: false,
  traeSaldoInicialDeclarado: false,
  // Medido (spec de la tarea): sin convención de signo confiable en el importe. El `-` explícito que
  // SÍ aparece en algunas filas es una señal puntual, no una columna publicada — ver la nota de
  // cabecera sobre el criterio de signo.
  traeSignoEnElImporte: false,
  traeSaldoPorFila: false,
  traeFechaValor: false,
  traeReferencia: true,
  traeCodigoDeConcepto: false,
  anioEnLaFecha: true,
  // 🔴 Corregido: NO es `false`. `cuenta_bancaria.moneda` es `char(3) not null` en el esquema físico —
  // una fila, una moneda (V12, `01-modulo-1-ingesta-bancaria.md:313`). Con movimientos ARS y USD
  // mezclados en una sola `CuentaDetectada` el lote daba `EST_MONEDA_MEZCLADA` siempre que hubiera al
  // menos un consumo en dólares. La misma tarjeta física es DOS posiciones (dos `CuentaDetectada`,
  // una por moneda) — mismo patrón que `macro.ts` (`armarCuentaDetectada`, una cuenta por sección/
  // moneda). Confirmado por `arquitecto-software` + `contador-dominio`: la partición es solo
  // trazabilidad de captura, no contamina "un asiento por resumen" (Módulo 2), porque cada línea en
  // USD sigue llevando su `moneda` de origen en el movimiento.
  multiCuenta: true,
  // Medido: hay filas con importe en moneda extranjera (código ISO de 3 letras + importe propio).
  multiMoneda: true,
  traeMovimientosFueraDelPeriodo: false,
  traeConsolidadoPorMoneda: false,
  declaraDestinos: true,
};

/**
 * Vocabulario que la propia tarea ya midió y confirmó presente en los 3 documentos (nunca una
 * reconstrucción propia a partir de la forma). `VISA` + al menos 2 de los otros cinco, en cualquier
 * fila del documento: alcanza para no colisionar con ningún adaptador bancario del roster (que
 * buscan letterhead de OTRO banco) ni con el de liquidaciones Visa a comercio (vocabulario de
 * `LIQUIDACION`/`COMERCIO`/`ARANCEL`, confirmado ausente acá por la propia tarea).
 */
const MARCA_VISA = 'VISA';
const VOCABULARIO_RESUMEN = [
  'CONSUMOS',
  'PAGO MINIMO',
  'SALDO ANTERIOR',
  'SALDO ACTUAL',
  'FECHA DE CIERRE',
  'FECHA DE VENCIMIENTO',
];
const MINIMO_VOCABULARIO = 2;

export function reconoceVisaCorporativa(filas: readonly FilaGeometrica[]): boolean {
  const textoCompleto = filas.map((f) => normalizar(textoDeFila(f))).join(' ');
  if (!textoCompleto.includes(MARCA_VISA)) return false;
  const coincidencias = VOCABULARIO_RESUMEN.filter((v) => textoCompleto.includes(normalizar(v))).length;
  return coincidencias >= MINIMO_VOCABULARIO;
}

// -----------------------------------------------------------------------------
// Columnas — puntos PDF, medidos contra los 3 documentos reales (spec de la tarea + medición propia).
// -----------------------------------------------------------------------------

/** El encabezado se repite arriba de cada página, siempre en el mismo `y` en los 3 documentos. */
const Y_MINIMO_CUERPO = 690;
/** El pie (código de control + paginación) siempre en el mismo `y`, en los 3 documentos. */
const Y_MAXIMO_CUERPO = 35;

/** La fecha `dd-mm-aa`, siempre el fragmento más a la izquierda de su fila. */
const X_FECHA = 22.8;
const TOL_FECHA = 3;
const RE_FECHA_MOVIMIENTO = /^\d{2}-\d{2}-\d{2}$/;

/** Código de comprobante (6 dígitos): la compuerta que separa un consumo real del bloque de intereses. */
const VENTANA_AUTH_CODE = { desde: 358, hasta: 376 };
const RE_AUTH_CODE = /^\d{6}$/;

/** Importe principal (pesos): borde derecho consistente a los 0.3pt en las filas medidas. */
const VENTANA_IMPORTE_PRINCIPAL = { desde: 485, hasta: 500 };
/** Importe en moneda extranjera: borde derecho variable, ventana más ancha. */
const VENTANA_IMPORTE_SECUNDARIO = { desde: 215, hasta: 260 };
/** Código de moneda (forma ISO de 3 letras), entre la glosa y el importe secundario. */
const VENTANA_CODIGO_MONEDA = { desde: 185, hasta: 210 };
const RE_CODIGO_MONEDA = /^[A-Z]{3}$/;

/** Banda de glosa: desde justo después de la fecha hasta antes del código de comprobante. Une marcador,
 *  comercio, cuota y —cuando aplica— el código de moneda y su importe chico (redundante con el campo
 *  estructurado, no se excluye a propósito: separar la banda por sub-tipo de fila es más frágil que
 *  aceptar la redundancia). */
const BANDA_GLOSA = { desde: 65, hasta: VENTANA_AUTH_CODE.desde };

/**
 * Vocabulario de CONTRASTE para el signo (nunca de clasificación contable — eso es Módulo 2). Términos
 * genéricos de un resumen de tarjeta argentino, ninguno leído del documento real: pago, nota de
 * crédito, devolución, reverso, anulación, bonificación, ajuste a favor.
 */
const VOCABULARIO_CREDITO: readonly RegExp[] = [
  /\bPAGO\b/,
  /N\s*\/?\s*C\b/,
  /NOTA\s+DE\s+CREDITO/,
  /DEVOLUCION/,
  /REVERSO/,
  /ANULACION/,
  /BONIFICACION/,
  /AJUSTE\s+A\s+FAVOR/,
];

function pareceCredito(glosa: string): boolean {
  const n = normalizar(glosa);
  return VOCABULARIO_CREDITO.some((re) => re.test(n));
}

// -----------------------------------------------------------------------------
// Guardia de PAN — diseño cerrado de `security-engineer`, implementado tal cual (no se rediseña acá).
// -----------------------------------------------------------------------------

/**
 * Se aplica a TODO valor capturado por patrón sobre texto crudo que esté por asignarse a
 * `CuentaDetectada.numero` o `.cbu`. Nunca al resultado de `depurarGlosa`, que corre aparte y ya está
 * protegido.
 *
 * `candidato === null` → sin cambios. Si no es forma PURA de PAN (solo dígitos, sin separadores, y
 * matcheando `RE_PAN`) → sin cambios. Si SÍ es forma de PAN: Luhn decide el MOTIVO que queda
 * registrado (`pan_confirmado_luhn` / `pan_shape_sin_luhn`), **nunca si se trunca** — se trunca
 * SIEMPRE que la forma sea PAN-shaped, válido o no el checksum (falla cerrado: un PAN real mal leído
 * por OCR puede fallar Luhn y seguir siendo un PAN real). Se trunca a últimos 4, NUNCA se descarta la
 * línea entera.
 */
// Exportada SOLO para el test de mutación de `visa-corporativa.test.ts` (pedido explícito: probar
// contra la función directamente, no contra fixtures de PDF completos). No forma parte del contrato
// `Adaptador` — no está en `adaptadorVisaCorporativa` ni en `registro.ts`.
export function sinPan(candidato: string | null): { readonly valor: string | null; readonly motivo: string | null } {
  if (candidato === null) return { valor: null, motivo: null };

  const soloDigitos = candidato.replace(/\D/g, '');
  // "Sin separadores": el candidato TIENE que ser YA puro-dígito. Si `soloDigitos` difiere del
  // original (había guiones, espacios, puntos), no se considera forma de PAN — el regex compartido
  // (`RE_PAN`) no cubre separadores, y "parece PAN si le saco el ruido" no es lo mismo que "es PAN".
  const esFormaPura = soloDigitos === candidato && candidato.length > 0;
  const esFormaDePan = esFormaPura && sinEstado(RE_PAN).test(candidato);

  if (!esFormaDePan) return { valor: candidato, motivo: null };

  const motivo = luhnEsValido(soloDigitos) ? 'pan_confirmado_luhn' : 'pan_shape_sin_luhn';
  return { valor: ultimos4(soloDigitos), motivo };
}

// -----------------------------------------------------------------------------
// Lectura
// -----------------------------------------------------------------------------

export type SalidaVisaCorporativa = SalidaDeAdaptador & {
  readonly destinos: ConteoDeDestinos<DestinoBase>;
};

export function leerVisaCorporativa(filas: readonly FilaGeometrica[]): SalidaVisaCorporativa {
  const noInterpretadas: LineaNoInterpretada[] = [];
  // `filaNumero` acá es un PLACEHOLDER (`0`): el campo real es "índice DENTRO DE SU CUENTA" (esquema.ts)
  // y esta lectura arma DOS cuentas (una por moneda, ver `armarCuenta` más abajo) — el número real se
  // asigna DESPUÉS de partir por moneda, nunca en este bucle.
  const movimientos: MovimientoBancarioCrudo[] = [];

  const destinoDeFila = new Map<number, DestinoBase>();
  const marcar = (i: number, destino: DestinoBase): void => {
    destinoDeFila.set(i, destino);
  };

  for (const [indice, fila] of filas.entries()) {
    const texto = textoDeFila(fila);
    if (texto === '') {
      marcar(indice, 'ruido');
      continue;
    }

    // Encabezado repetido por página / pie de página: siempre en el mismo `y`, en los 3 documentos.
    if (fila.y > Y_MINIMO_CUERPO || fila.y < Y_MAXIMO_CUERPO) {
      marcar(indice, 'ruido');
      continue;
    }

    const fechaFrag = fragmentoEnX(fila, X_FECHA, TOL_FECHA);
    const esFilaConFecha = fechaFrag !== undefined && RE_FECHA_MOVIMIENTO.test(fechaFrag.texto);

    if (!esFilaConFecha) {
      // Ni encabezado, ni pie, ni fila con fecha de consumo: prosa legal, carátula intermedia, tabla
      // de tasas. Se cuenta, no se reporta como residuo — mismo criterio que `fueraDelCuerpo` en el
      // resto del roster.
      marcar(indice, 'fueraDelCuerpo');
      continue;
    }

    const authFrag = fila.fragmentos.find(
      (f) => f.x >= VENTANA_AUTH_CODE.desde && f.x <= VENTANA_AUTH_CODE.hasta && RE_AUTH_CODE.test(f.texto),
    );

    if (!authFrag) {
      // Tiene fecha pero no código de comprobante: es el bloque de intereses/cargos financieros de la
      // carátula, no un consumo. No modelado en esta versión — se reporta, no se inventa qué es.
      marcar(indice, 'residuo');
      noInterpretadas.push({
        codigo: 'linea_fuera_de_zona',
        forma: formaParaLog(texto, 80),
        paginaPdf: fila.pagina,
        indice,
      });
      continue;
    }

    const fecha = parsearFecha(fechaFrag.texto);
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

    const glosa = fragmentosEnBandaGlosa(fila);
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

    const resultadoImporte = leerImporteYMoneda(fila);
    if (resultadoImporte === null) {
      marcar(indice, 'residuo');
      noInterpretadas.push({
        codigo: 'fila_sin_importe',
        forma: formaParaLog(texto, 60),
        paginaPdf: fila.pagina,
        indice,
      });
      continue;
    }

    const { importeCent, moneda } = resultadoImporte;
    const absCent = importeCent < 0n ? -importeCent : importeCent;
    const tieneSignoNegativo = importeCent < 0n;

    // Criterio de signo consultado y confirmado por `contador-dominio` (ver el comentario de
    // cabecera): signo explícito → credito; sin signo y sin vocabulario de crédito → debito por
    // defecto; sin signo PERO con vocabulario de crédito → ambiguo, no se emite el movimiento.
    if (!tieneSignoNegativo && pareceCredito(glosa)) {
      marcar(indice, 'residuo');
      noInterpretadas.push({
        codigo: 'desconocido',
        forma: formaParaLog(texto, 60),
        paginaPdf: fila.pagina,
        indice,
      });
      continue;
    }

    const columna: 'credito' | 'debito' = tieneSignoNegativo ? 'credito' : 'debito';
    const importeToken = centavosAImporte(absCent);

    const movimiento = {
      tipoFila: 'movimiento',
      fecha,
      descripcionLineas: [glosa],
      descripcion: glosa,
      ...(columna === 'credito' ? { credito: importeToken } : { debito: importeToken }),
      columnaOrigen: columna,
      importe: columna === 'credito' ? importeToken : `-${importeToken}`,
      moneda,
      cotizacionProvista: false,
      // Placeholder: se renumera por cuenta (por moneda) en `armarCuenta`.
      filaNumero: 0,
      paginaPdf: fila.pagina,
      referencias: [{ tipo: 'operacion' as const, valor: authFrag.texto }],
      filaHash: '',
    } as MovimientoBancarioCrudo;

    marcar(indice, 'movimiento');
    movimientos.push(movimiento);
  }

  // Una `CuentaDetectada` POR MONEDA — nunca movimientos ARS y USD mezclados en la misma cuenta
  // (V12: `cuenta_bancaria.moneda` es `char(3) not null`, una fila = una moneda). Mismo patrón que
  // `macro.ts` (`armarCuentaDetectada`, una cuenta por sección/moneda): si el documento trajo AL MENOS
  // un movimiento (en cualquier moneda), se emiten las DOS cuentas — incluida la que dio 0 movimientos
  // ese mes, que es un lote legítimo y no un error (mismo criterio que la cuenta en dólares de Macro).
  const cuentas =
    movimientos.length === 0
      ? []
      : MONEDAS.map((moneda) => armarCuenta(filas, movimientos.filter((m) => m.moneda === moneda), moneda));

  return {
    cuentas,
    lineasNoInterpretadas: noInterpretadas,
    paginasDeclaradas: undefined,
    destinos: contarDestinos(DESTINOS_BASE, destinoDeFila, filas.length),
  };
}

function fragmentosEnBandaGlosa(fila: FilaGeometrica): string {
  return fila.fragmentos
    .filter((f) => f.x >= BANDA_GLOSA.desde && f.x < BANDA_GLOSA.hasta)
    .map((f) => f.texto)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function leerImporteYMoneda(fila: FilaGeometrica): { readonly importeCent: bigint; readonly moneda: Moneda } | null {
  const principal = fragmentoEnVentanaDerecha(fila, VENTANA_IMPORTE_PRINCIPAL.desde, VENTANA_IMPORTE_PRINCIPAL.hasta);
  if (principal) {
    const cent = importeACentavos(principal.texto);
    return cent === null ? null : { importeCent: cent, moneda: 'ARS' };
  }

  // Sin columna principal: el sub-patrón de moneda extranjera (medido). Se declara USD únicamente
  // cuando el código coincide EXACTO — cualquier otro código de 3 letras queda sin interpretar.
  const codigoMonedaFrag = fila.fragmentos.find(
    (f) => f.x >= VENTANA_CODIGO_MONEDA.desde && f.x <= VENTANA_CODIGO_MONEDA.hasta && RE_CODIGO_MONEDA.test(f.texto),
  );
  if (!codigoMonedaFrag || codigoMonedaFrag.texto !== 'USD') return null;

  const secundario = fragmentoEnVentanaDerecha(fila, VENTANA_IMPORTE_SECUNDARIO.desde, VENTANA_IMPORTE_SECUNDARIO.hasta);
  if (!secundario) return null;
  const cent = importeACentavos(secundario.texto);
  return cent === null ? null : { importeCent: cent, moneda: 'USD' };
}

// -----------------------------------------------------------------------------
// Carátula
// -----------------------------------------------------------------------------

/**
 * El CUIT del titular: por FORMA (`RE_CUIT`), acotado a las primeras 10 filas de carátula, toma el
 * PRIMERO que encuentra.
 *
 * 🔴 **Medido, no supuesto** (hallazgo de `code-reviewer`: "el primero que aparece" es un riesgo real
 * si el emisor imprime SU PROPIO CUIT antes que el del titular en esa ventana). Contra los 3
 * documentos reales: hay **exactamente 1** fragmento con forma de CUIT en las primeras 10 filas, en
 * los 3 meses — mismo índice de fila y misma `x`, cluster junto a la razón social y el domicilio
 * (contenido evidentemente dinámico/por-cliente, no el letterhead genérico de las 2 filas
 * anteriores). No hay un segundo candidato con el que discriminar en esta ventana, así que "el
 * primero" no es ambiguo hoy. **No se verificó leyendo la etiqueta real** (regla dura: nunca se lee
 * contenido real del documento, solo forma) — si un documento futuro imprime el CUIT del emisor
 * DENTRO de las primeras 10 filas, este criterio se rompe en silencio y hay que anclar por posición
 * relativa a una etiqueta, no por "el primero".
 */
function leerCuitTitular(filas: readonly FilaGeometrica[]): string | null {
  for (const fila of filas.slice(0, 10)) {
    for (const f of fila.fragmentos) {
      const m = sinEstado(RE_CUIT_COMPARTIDO).exec(f.texto);
      if (m?.[0]) return m[0];
    }
  }
  return null;
}

/**
 * El número de tarjeta: no encontrado en ningún documento medido (spec de la tarea + medición
 * propia contra la carátula real) — es probable que este banco no lo publique. Se busca igual, por
 * si un documento futuro sí lo trae: cualquier fragmento de la carátula con forma PURA de PAN
 * (13-19 dígitos, `RE_PAN`) pasa por `sinPan()` ANTES de asignarse — nunca el valor completo.
 */
function leerNumeroDeTarjeta(filas: readonly FilaGeometrica[]): string | null {
  for (const fila of filas.slice(0, 10)) {
    for (const f of fila.fragmentos) {
      const candidato = /^\d+$/.test(f.texto) ? f.texto : null;
      const { valor, motivo } = sinPan(candidato);
      if (motivo !== null && valor !== null) return valor;
    }
  }
  return null;
}

/**
 * Arma UNA `CuentaConMovimientos` para UNA moneda — la misma tarjeta física es dos posiciones (V12,
 * ver `CAPACIDADES_VISA_CORPORATIVA.multiCuenta`). Se llama una vez por cada valor de `MONEDAS`, SIEMPRE
 * que el documento haya traído al menos un movimiento en cualquier moneda — incluida la moneda que dio
 * `movimientosDeEstaMoneda.length === 0` ese mes: es un lote legítimo (mismo criterio que la cuenta en
 * dólares de `macro.ts`), no se omite la cuenta.
 */
function armarCuenta(
  filas: readonly FilaGeometrica[],
  movimientosDeEstaMoneda: readonly MovimientoBancarioCrudo[],
  moneda: Moneda,
): CuentaConMovimientos {
  const titularDocumento = leerCuitTitular(filas);
  const numero = leerNumeroDeTarjeta(filas);

  // 🔴 Nota de `code-reviewer`, sin caso real hoy (los 3 documentos medidos nunca publican un PAN, ver
  // `leerNumeroDeTarjeta`): si algún día `numero` SÍ trae el valor enmascarado de `sinPan()`
  // (`••••1234`), `normalizarNumeroCuenta` le saca los `•` y queda un `numeroNormalizado` de 4
  // dígitos — dos tarjetas reales distintas que terminan en el mismo 4 colisionarían en la misma
  // `ClaveCuenta`. No es un problema hoy (nunca se ejercita); si aparece el primer documento con PAN
  // publicado, este hash necesita una sal adicional (CUIT del titular, por ejemplo) antes de usarse.
  //
  // `moneda` SÍ entra en la clave (a diferencia de una lectura de una sola cuenta): es lo que separa
  // el hash de la posición en ARS del de la posición en USD, aunque las dos compartan
  // `numeroNormalizado` — mismo criterio que `macro.ts` con sus tres cuentas.
  const clave: ClaveCuenta = {
    bancoCodigo: BANCO_CODIGO,
    numeroNormalizado: normalizarNumeroCuenta(numero ?? 'sin_numero'),
    moneda,
  };

  // `filaNumero` es el índice DENTRO DE ESTA CUENTA (esquema.ts) — se renumera acá, 1-based, en el
  // mismo orden de lectura del documento (`movimientosDeEstaMoneda` ya viene filtrado preservando el
  // orden de aparición).
  const conNumero = movimientosDeEstaMoneda.map((m, i) => ({ ...m, filaNumero: i + 1 }));

  const hashes = hashesDeCuenta(
    clave,
    conNumero.map((m) => ({
      fecha: m.fecha,
      importe: m.importe,
      saldo: m.saldo ?? null,
      descripcion: m.descripcion,
    })),
  );
  const conHash = conNumero.map((m, i) => ({ ...m, filaHash: hashes[i] ?? '' }));

  return {
    cuenta: {
      // Constante, no leída del documento — mismo criterio que `nacion.ts`/`bancor.ts` cuando no hay
      // etiqueta de producto confiable medida. Misma denominación en las dos monedas: es la MISMA
      // tarjeta física, dos posiciones — no hay dos productos distintos que nombrar distinto.
      denominacion: 'TARJETA DE CREDITO CORPORATIVA VISA',
      tipoCuenta: 'tarjeta_corporativa',
      moneda,
      ...(numero === null ? {} : { numero }),
      ...(titularDocumento === null ? {} : { titularDocumento }),
    },
    movimientos: conHash,
    anexos: [],
  };
}

export const adaptadorVisaCorporativa = {
  bancoCodigo: BANCO_CODIGO,
  version: VERSION,
  capacidades: CAPACIDADES_VISA_CORPORATIVA,
  reconoce: (e: EntradaDeAdaptador): boolean => reconoceVisaCorporativa(e.filas),
  leer: (e: EntradaDeAdaptador): SalidaVisaCorporativa => leerVisaCorporativa(e.filas),
} as const;
