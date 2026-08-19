/**
 * REGISTRO DE ADAPTADORES DE LIQUIDACIÓN — quién lee qué formato, y qué pasa cuando no está claro.
 *
 * Registro **propio**, separado del de los adaptadores bancarios. El porqué —los tres bloqueos duros—
 * está en `contrato.ts`; el más importante para este archivo es el tercero: compartir el registro
 * ampliaría la superficie del caso `ambiguo` sin ganar nada.
 *
 * ## Las cuatro respuestas posibles
 *
 * | Resultado | Cuándo | Qué hace el CLI |
 * |---|---|---|
 * | `encontrado` | exactamente **un** adapter reconoce el documento **y** coincide con lo declarado | sigue |
 * | `sin_adaptador` | **ninguno** lo reconoce | rechaza |
 * | `ambiguo` | **dos o más** lo reconocen | rechaza, revisión humana |
 * | `formato_declarado_no_coincide` | uno lo reconoce, pero no es el que el operador declaró | rechaza |
 *
 * ## Declarar + detectar + comparar: por qué no es "manual a secas" ni auto-detección
 *
 * El patrón es el del Módulo 1, verificado y no supuesto. El operador **declara** el formato
 * (`--formato`, obligatorio, sin default) y el adapter **detecta por contenido** y **veta** si no
 * coincide. La detección nunca ELIGE el formato: solo refuta una declaración incorrecta. Es la misma
 * garantía que ya tiene la ingesta bancaria, no una excepción a la restricción de "sin auto-detección".
 *
 * Y cuando no coincide, **no se dice cuál se detectó**. Si el operador se equivocó de carpeta, decirle
 * qué formato es el archivo confirma información de otro cliente. Que abra el archivo y lo mire.
 *
 * ## Nota para el commit 2 (dónde van a vivir los adapters)
 *
 * En `liquidaciones/formatos/`, **no** en `liquidaciones/adaptadores/`. Motivo concreto: la regla A1 de
 * `packages/data/tests/reglas-de-codigo.test.ts` filtra por `includes('/adaptadores/')` y exige que todo
 * `export type Entrada*`/`Salida*` tenga `Entrada|SalidaDeAdaptador` del lado derecho. Un
 * `type SalidaVisaDebito = SalidaDeLiquidacion` bajo un directorio llamado `adaptadores/` pondría en rojo
 * una regla ya probada, por un choque de nombres de carpeta y nada más.
 */

import type { FilaGeometrica } from '../texto-pdf.ts';
import type {
  CapacidadesDeFormato,
  LineaNoInterpretadaDeLiquidacion,
  LiquidacionLeida,
} from './esquema.ts';

/**
 * La entrada de un adapter: las **filas geométricas** del PDF, la misma vista que necesitó el primer
 * banco real (`pdf.js` emite un espacio por hueco, así que no hay columnas de ancho fijo en caracteres).
 *
 * ⚠️ **Elegida sin ningún adapter de liquidación medido.** Es la apuesta más barata —reusa la extracción
 * que ya existe— pero acá no hay evidencia todavía, a diferencia del contrato bancario, donde el shape lo
 * pidió un documento real. El commit 2 (Visa débito) la confirma o la refuta; si la refuta, se cambia
 * antes de que haya un segundo adapter que la copie.
 */
export type EntradaDeLiquidacion = { readonly filas: readonly FilaGeometrica[] };

/**
 * Lo que un adapter devuelve. El sobre con lo que identifica al archivo —hash, páginas, capacidades— lo
 * arma el comando, no el adapter: ver `LiquidacionProcesada` en `esquema.ts`.
 */
export type SalidaDeLiquidacion = {
  readonly liquidaciones: readonly LiquidacionLeida[];
  /**
   * Regla 3 del contrato: ninguna línea se descarta en silencio. Vacío significa "se interpretó todo",
   * y es una afirmación que el adapter hace explícitamente, no por omisión.
   */
  readonly lineasNoInterpretadas: readonly LineaNoInterpretadaDeLiquidacion[];
  /**
   * El total consolidado del emisor, cuando el formato lo publica (`traeTotalDelEmisor`). `undefined`
   * significa "no hay eje 2 que correr", **nunca** "cuadra".
   */
  readonly totalConsolidadoDeclarado?: string | undefined;
};

/**
 * `capacidades` va **tipado**, no `unknown`.
 *
 * El contrato bancario lo declara `unknown` por deuda histórica, no por diseño —`registro.ts` ya importa
 * tipos de su propio esquema, así que no hay ciclo que lo justifique—. Copiarlo acá dejaría la capacidad
 * declarada fuera del alcance de los tipos justo en el módulo cuya regla 2 dice que las capacidades son
 * la entrada del verificador.
 *
 * `formatoCodigo` es la clave **plana** (`'visa_debito'`). La procesadora y el tipo de tarjeta NO viven
 * acá: son columnas del catálogo N0 `formato_liquidacion` del commit 3, y tenerlas también en el contrato
 * TS crearía dos fuentes de verdad de la identidad del formato antes de que exista la tabla que las
 * reconcilie.
 */
export type AdaptadorDeLiquidacion = {
  readonly formatoCodigo: string;
  readonly version: number;
  readonly capacidades: CapacidadesDeFormato;
  reconoce(entrada: EntradaDeLiquidacion): boolean;
  leer(entrada: EntradaDeLiquidacion): SalidaDeLiquidacion;
};

export type ResolucionDeLiquidacion =
  | { readonly estado: 'encontrado'; readonly adaptador: AdaptadorDeLiquidacion }
  | { readonly estado: 'sin_adaptador'; readonly formatosRegistrados: readonly string[] }
  | { readonly estado: 'ambiguo'; readonly candidatos: readonly string[] }
  | {
      readonly estado: 'formato_declarado_no_coincide';
      readonly declarado: string;
      /** NO se dice cuál se detectó. Ver la nota del encabezado. */
    };

const ADAPTADORES_DE_LIQUIDACION = new Map<string, AdaptadorDeLiquidacion>();

/**
 * Registra un adapter. Lanza si el código ya está tomado: dos adapters para el mismo formato es un error
 * de programación —el que gane depende del orden de los imports— y por eso NO es un `ErrorDeLiquidacion`,
 * que nombra fallas de lectura de un documento.
 */
export function registrarAdaptadorDeLiquidacion(adaptador: AdaptadorDeLiquidacion): void {
  if (ADAPTADORES_DE_LIQUIDACION.has(adaptador.formatoCodigo)) {
    throw new Error(
      `Ya hay un adaptador registrado para "${adaptador.formatoCodigo}". Dos adaptadores para el ` +
        'mismo formato es un error de programación: el que gane depende del orden de los imports.',
    );
  }
  ADAPTADORES_DE_LIQUIDACION.set(adaptador.formatoCodigo, adaptador);
}

/** Solo para los tests: deja el registro limpio entre casos. */
export function limpiarRegistroDeLiquidaciones(): void {
  ADAPTADORES_DE_LIQUIDACION.clear();
}

export function formatosConAdaptador(): readonly string[] {
  return [...ADAPTADORES_DE_LIQUIDACION.keys()].sort();
}

export function adaptadorDeFormato(formatoCodigo: string): AdaptadorDeLiquidacion | undefined {
  return ADAPTADORES_DE_LIQUIDACION.get(formatoCodigo);
}

/**
 * Resuelve qué adapter lee este documento.
 *
 * `formatoDeclarado` es lo que dijo el operador. Se **compara**, no se obedece: el archivo manda.
 */
export function resolverAdaptadorDeLiquidacion(
  entrada: EntradaDeLiquidacion,
  formatoDeclarado: string,
): ResolucionDeLiquidacion {
  const candidatos = [...ADAPTADORES_DE_LIQUIDACION.values()].filter((a) => a.reconoce(entrada));

  const [unico] = candidatos;
  if (unico === undefined) {
    return { estado: 'sin_adaptador', formatosRegistrados: formatosConAdaptador() };
  }
  if (candidatos.length > 1) {
    return { estado: 'ambiguo', candidatos: candidatos.map((a) => a.formatoCodigo).sort() };
  }
  if (unico.formatoCodigo !== formatoDeclarado) {
    // El operador declaró un formato y el archivo es de otro. Pasa: se sube el PDF a la carpeta
    // equivocada. No se dice cuál se detectó.
    return { estado: 'formato_declarado_no_coincide', declarado: formatoDeclarado };
  }

  return { estado: 'encontrado', adaptador: unico };
}
