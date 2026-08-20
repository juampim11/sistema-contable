/**
 * EJE 4 — CONFIANZA DE CAPTURA. Plan 15 §1 ("Un CUARTO eje de verificación, separado"), retomado
 * 2026-08-19 junto con el commit 2 del plan 14. Antes de tocar este archivo, releer
 * `docs/diseno/15-ocr-liquidaciones-plan.md` completo.
 *
 * ## Por qué es un cuarto eje y no una extensión del eje 1
 *
 * Dictamen de `motor-conciliacion-contable`: `verificarAritmeticaPorLiquidacion` (`verificacion.ts`) es
 * una red real con tolerancia cero, pero solo cubre los campos que participan de la ecuación
 * (`ventasBrutas`, `netoAcreditado`, `monto` de cada renglón). No cubre `alicuotaPublicada`, `base`,
 * `numeroDeLiquidacion`, fechas, `jurisdiccion` ni `caveatDeComputoFiscal` — ninguno es un término de la
 * suma —, y tampoco cubre el caso de dos errores de OCR que se compensan entre sí (la aritmética "cuadra"
 * con un dígito mal leído en cada lado). "¿Cierra la aritmética?" y "¿confío en esta lectura?" son
 * preguntas distintas, y la segunda puede ser falsa aun con la primera en verde — por eso este eje
 * **nunca** consulta ni modifica el resultado del eje 1, y viceversa: son señales que se suman como
 * evidencia, nunca que se cancelan entre sí.
 *
 * ## Por qué vive en `liquidaciones/` y no en `formatos/`
 *
 * Es vocabulario COMPARTIDO entre cualquier adapter de liquidación que use OCR (hoy solo Visa débito,
 * mañana potencialmente otros) — por eso cae bajo R-O (cero decimales/porcentajes en posición de valor)
 * y por eso `UMBRAL_CONFIANZA_MINIMA` es **entero**: la confianza que publica `tesseract.js` es 0–100
 * con posibles decimales nativos, y acá se trunca antes de guardarla (nunca se persiste el formato
 * nativo de la librería, que podría cambiar entre versiones).
 *
 * ## Nunca loguear `valorLeido`
 *
 * `valorLeido` está en `CLAVES_SENSIBLES_EXTERNAS` (`packages/shared/src/seguridad/clasificacion-campos.ts`,
 * paso 0 del plan 15): el tipo del logger ya lo rechaza en compilación. Si hace falta diagnosticar una
 * `ConfianzaDeCampo`, se loguea `campo` + `estado` + `confianzaOcr` — nunca `valorLeido`.
 */

export const ESTADOS_CONFIANZA_CAPTURA = ['confiable', 'dudoso', 'no_evaluable'] as const;
export type EstadoConfianzaCaptura = (typeof ESTADOS_CONFIANZA_CAPTURA)[number];

/**
 * La confianza de UN campo capturado.
 *
 * `confianzaOcr: null` **solo** cuando `estado === 'no_evaluable'` (texto nativo: el eje no corrió). El
 * corolario está en `evaluarConfianzaDeCaptura`, no acá: este tipo no lo impone con un `refine` porque
 * vive fuera de Zod (es una función pura, no un límite de validación de entrada) — el test de mutación
 * de `UMBRAL_CONFIANZA_MINIMA` es lo que verifica que la única función que lo construye respeta la regla.
 */
export type ConfianzaDeCampo = {
  readonly campo: string;
  readonly valorLeido: string;
  readonly confianzaOcr: number | null;
  readonly estado: EstadoConfianzaCaptura;
};

/**
 * Umbral mínimo de confianza (entero, 0–100) para que un campo capturado por OCR se declare `confiable`.
 * Por debajo, `dudoso`.
 *
 * ## La evidencia que lo fija (condición 1 de JP, `HANDOFF.md`)
 *
 * Medido corriendo el pipeline OCR real (`extraerConOcrSiHaceFalta` + `reconocerImagen`) contra las 8
 * páginas del documento real (`privado/tarjetas/01-extracto_visa_debito_roka.pdf`), a nivel de
 * **palabra** reconocida (no hay todavía distribución a nivel de CAMPO capturado porque este commit es
 * el primero que arma `LiquidacionLeida` completas — la distribución de campo, más angosta que la de
 * palabra suelta, queda para medir en una iteración posterior si el umbral no da abasto): de 5649
 * palabras reconocidas, 3354 con confianza ≥90, 999 entre 70 y 89, 403 entre 50 y 69, 893 <50 —
 * promedio 78,5.
 *
 * `70` separa lo que tesseract reconoce con alta certeza estructural (≥90, más de la mitad del corpus)
 * más un margen (70 a 89, alrededor de un sexto más) de lo que ya empieza a ser sospechoso: el bloque
 * por debajo de 50 —bastante más de un octavo del total— concentra el ruido real del escaneo (sombras de
 * CamScanner, bordes, encabezados repetidos), y ponerlo en la categoría `dudoso` es la decisión
 * conservadora — sube más a revisión humana de lo estrictamente necesario, nunca menos.
 * `seguridad-datos-financieros`: un umbral que degrada `dudoso` a `confiable` por error es exactamente lo
 * que la prueba de mutación de abajo existe para atrapar.
 */
export const UMBRAL_CONFIANZA_MINIMA = 70;

/**
 * Evalúa la confianza de UN campo capturado. Función pura: no toca el eje 1, no toca el adapter.
 *
 * `confianzaOcr: null` es la señal de "texto nativo, el eje no corrió" — no un valor faltante de OCR.
 * Cuando el campo sí vino de OCR, la confianza se **trunca** a entero (R-O: nada de decimales en
 * posición de valor en el vocabulario compartido) antes de compararla contra el umbral y antes de
 * guardarla en `confianzaOcr`.
 */
export function evaluarConfianzaDeCaptura(
  campo: string,
  valorLeido: string,
  confianzaOcr: number | null,
): ConfianzaDeCampo {
  if (confianzaOcr === null) {
    return { campo, valorLeido, confianzaOcr: null, estado: 'no_evaluable' };
  }
  const entera = Math.trunc(confianzaOcr);
  return {
    campo,
    valorLeido,
    confianzaOcr: entera,
    estado: entera < UMBRAL_CONFIANZA_MINIMA ? 'dudoso' : 'confiable',
  };
}
