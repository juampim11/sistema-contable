/**
 * REGISTRO DE ADAPTADORES — quién lee qué banco, y qué pasa cuando no está claro.
 *
 * ## Las tres respuestas posibles, y por qué son tres y no dos
 *
 * | Resultado | Cuándo | Qué hace el CLI |
 * |---|---|---|
 * | `encontrado` | exactamente **un** adaptador reconoce el documento | sigue |
 * | `sin_adaptador` | **ninguno** lo reconoce | rechaza con `adapter_no_disponible` |
 * | `ambiguo` | **dos o más** lo reconocen | rechaza con `banco_ambiguo`, revisión humana |
 *
 * El caso `ambiguo` existe porque es real: en el roster de bancos hay un PDF de Credicoop que es **byte a
 * byte idéntico** a uno de ICBC (alguien guardó el archivo equivocado). Si el registro eligiera "el primer
 * adaptador que dice que sí", ese archivo se leería con el parser del banco equivocado y produciría filas
 * plausibles. Rechazar y pedir intervención humana es la única salida correcta.
 *
 * ## Por qué el banco se detecta y no se pasa como argumento
 *
 * El CLI recibe `--banco`, pero eso es lo que **declara** el operador, y el operador se equivoca: sube el
 * PDF de Santander a la carpeta de Galicia. Así que el registro detecta por el **contenido** y compara: si
 * lo declarado no coincide con lo detectado, se rechaza. Es el mismo razonamiento de INV-6 aplicado al
 * banco en vez de al cliente.
 */

import type { FilaGeometrica } from '../texto-pdf.ts';
import type {
  ConsolidadoPorMoneda,
  CuentaConMovimientos,
  LineaNoInterpretada,
} from '../esquema.ts';

/**
 * La entrada del registro: las **filas geométricas**.
 *
 * El contrato original pasaba texto y líneas. El primer banco real mostró que la vista que hace falta es la
 * geométrica —`pdf.js` emite un espacio por hueco, así que no hay columnas de ancho fijo en caracteres— y que
 * el importe sale en una línea distinta de la fecha en el 80 % de las filas. Con un solo banco escrito no se
 * puede saber si eso es la regla o la excepción, así que el registro pide lo que el banco real necesita y la
 * decisión de generalizar espera al segundo adaptador.
 */
export type EntradaDeAdaptador = { readonly filas: readonly FilaGeometrica[] };

export type SalidaDeAdaptador = {
  readonly cuentas: readonly CuentaConMovimientos[];
  readonly lineasNoInterpretadas: readonly LineaNoInterpretada[];
  readonly paginasDeclaradas: number | undefined;
  /**
   * El saldo consolidado **por moneda** que declara la carátula, si el banco lo publica.
   *
   * Es la entrada de INV-multicuenta (`verificarConsolidadoPorMoneda`), el único control que detecta que el
   * adaptador mezcló, perdió o duplicó una cuenta. **Opcional porque hay bancos que no lo publican** — y
   * ausente significa "no hay qué comparar", nunca "cuadra".
   */
  readonly consolidadosPorMoneda?: readonly ConsolidadoPorMoneda[] | undefined;
  /**
   * Cuántas cuentas **declara el documento**, contadas desde un literal DISTINTO del que se usó para
   * sectorizar.
   *
   * En el banco multi-cuenta del roster son los pares `SALDO ULTIMO EXTRACTO AL` / `SALDO FINAL AL DIA`
   * (3 y 3 para 3 cuentas). **No vale contar las secciones**: eso es preguntarle al adaptador lo mismo dos
   * veces, y el contrato prohíbe el autocertificado justamente porque un error de lectura se vería como un
   * documento correcto.
   *
   * `undefined` = el banco no publica nada equivalente. Se declara; no se degrada a "cuadra".
   * Ver `verificarConteoDeCuentas`.
   */
  //
  // `?: number | undefined` y no `?: number`: con `exactOptionalPropertyTypes` los dos no son lo mismo, y
  // un adaptador que **calcula** el valor y a veces le da `undefined` —el caso real: el documento no
  // declara nada— no puede omitir la propiedad. Es el mismo estilo que `paginasDeclaradas` de acá arriba.
  readonly cuentasDeclaradas?: number | undefined;
};

export type Adaptador = {
  readonly bancoCodigo: string;
  readonly version: number;
  readonly capacidades: unknown;
  reconoce(entrada: EntradaDeAdaptador): boolean;
  leer(entrada: EntradaDeAdaptador): SalidaDeAdaptador;
};

export type ResolucionAdaptador =
  | { readonly estado: 'encontrado'; readonly adaptador: Adaptador }
  | { readonly estado: 'sin_adaptador'; readonly bancosRegistrados: readonly string[] }
  | { readonly estado: 'ambiguo'; readonly candidatos: readonly string[] }
  | {
      readonly estado: 'banco_declarado_no_coincide';
      readonly declarado: string;
      /** NO se dice cuál se detectó: si el operador se equivocó de carpeta, decirle qué banco es el
       *  archivo confirma información de otro cliente. Que abra el archivo y lo mire. */
    };

const ADAPTADORES = new Map<string, Adaptador>();

/**
 * Registra un adaptador. Lanza si el código ya está tomado: dos adaptadores para el mismo banco es un error
 * de programación, y el último que gane silenciosamente sería imposible de diagnosticar.
 */
export function registrarAdaptador(adaptador: Adaptador): void {
  if (ADAPTADORES.has(adaptador.bancoCodigo)) {
    throw new Error(
      `Ya hay un adaptador registrado para "${adaptador.bancoCodigo}". Dos adaptadores para el mismo ` +
        'banco es un error de programación: el que gane depende del orden de los imports.',
    );
  }
  ADAPTADORES.set(adaptador.bancoCodigo, adaptador);
}

/** Solo para los tests: deja el registro limpio entre casos. */
export function limpiarRegistro(): void {
  ADAPTADORES.clear();
}

export function bancosConAdaptador(): readonly string[] {
  return [...ADAPTADORES.keys()].sort();
}

export function adaptadorDe(bancoCodigo: string): Adaptador | undefined {
  return ADAPTADORES.get(bancoCodigo);
}

/**
 * Resuelve qué adaptador lee este documento.
 *
 * `bancoDeclarado` es lo que dijo el operador. Se **compara**, no se obedece: el archivo manda.
 */
export function resolverAdaptador(
  entrada: EntradaDeAdaptador,
  bancoDeclarado: string,
): ResolucionAdaptador {
  const candidatos = [...ADAPTADORES.values()].filter((a) => a.reconoce(entrada));

  if (candidatos.length === 0) {
    return { estado: 'sin_adaptador', bancosRegistrados: bancosConAdaptador() };
  }
  if (candidatos.length > 1) {
    return { estado: 'ambiguo', candidatos: candidatos.map((a) => a.bancoCodigo).sort() };
  }

  const unico = candidatos[0];
  if (!unico) return { estado: 'sin_adaptador', bancosRegistrados: bancosConAdaptador() };

  if (unico.bancoCodigo !== bancoDeclarado) {
    // El operador declaró un banco y el archivo es de otro. Pasa: se sube el PDF a la carpeta equivocada.
    // No se dice cuál se detectó — ver la nota del tipo.
    return { estado: 'banco_declarado_no_coincide', declarado: bancoDeclarado };
  }

  return { estado: 'encontrado', adaptador: unico };
}
