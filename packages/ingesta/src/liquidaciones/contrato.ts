/**
 * EL CONTRATO DE UN ADAPTADOR DE LIQUIDACIÓN — commit 1 de 4 del plan 14.
 *
 * Un adaptador de liquidación es lo **único** específico de cada formato (procesadora × tipo de
 * tarjeta). Todo lo demás —extracción y geometría del PDF, parseo de importes AR, hash de archivo,
 * verificación, persistencia— es genérico y en su mayor parte ya está escrito para el Módulo 1.
 *
 * ## Por qué es un contrato PROPIO y no el de los extractos bancarios
 *
 * Las tres reglas de abajo son deliberadamente las mismas que las de `adaptadores/contrato.ts` — están
 * probadas contra tres bancos reales y no hay motivo para inventar otras. Lo que **no** se comparte es
 * el contrato, por tres bloqueos duros medidos (plan 14 §1):
 *
 *  1. `lote_ingesta.banco_codigo` es `not null references banco(codigo)`, y Visa, Cabal o First Data
 *     **no son bancos**. Meterlos como filas de `banco` contaminaría un catálogo cuyas capacidades
 *     declaran cosas de extractos (saldo por fila, cadena de saldos) que no significan nada acá.
 *  2. La salida bancaria es `CuentaConMovimientos[]` + `ConsolidadoPorMoneda[]`: no tiene forma de
 *     liquidación, y ensancharla para que la tenga degradaría el tipo para los ocho bancos.
 *  3. Compartir el registro **amplía la superficie del caso `ambiguo`** —dos adapters que reconocen el
 *     mismo archivo— sin ganar nada. Y el caso es real: en el roster hay un PDF de Credicoop byte a byte
 *     idéntico a uno de ICBC.
 *
 * La separación está verificada por R-M (`packages/data/tests/reglas-de-codigo.test.ts`), que también
 * deja explícito lo que SÍ se comparte: la infraestructura del paquete (`../texto-pdf.ts`,
 * `../parseo-ar.ts`, `../hash.ts`, `../esquema.ts`). Ese reuso medido es la razón por la que esto es un
 * subárbol de `ingesta` y no un paquete nuevo.
 *
 * ## Las tres reglas del contrato, y por qué cada una
 *
 * ### 1. Un adaptador NO se autocertifica
 *
 * Devuelve lo que leyó y nada más. No decide si la liquidación "cuadra": eso lo calculan las funciones
 * puras de verificación —tres ejes ortogonales, ver `esquema.ts`— que no conocen al adaptador. Un
 * adaptador que se verificara a sí mismo estaría afirmando que leyó bien con la misma lógica con la que
 * leyó, y un error de lectura se vería como un documento correcto.
 *
 * ### 2. Un adaptador DECLARA sus capacidades
 *
 * `CapacidadesDeFormato` dice qué publica el emisor. Sin esa declaración, **"este formato no publica el
 * total consolidado" y "el parser no lo encontró" son indistinguibles** — y el segundo se esconde detrás
 * del primero para siempre. Es exactamente el caso medido: un proveedor publica resumen consolidado
 * mensual y otro no.
 *
 * ### 3. Un adaptador nunca descarta una línea en silencio
 *
 * Toda línea que no interpretó va a `lineasNoInterpretadas`, con su **forma** y **nunca su texto**. Es la
 * diferencia entre "leí 20 de 21 liquidaciones y te digo cuál no entendí" y "leí 20", que es el peor modo
 * de falla del módulo: un número plausible que nadie vuelve a mirar.
 *
 * ## Lo que un adaptador NO hace
 *
 * No clasifica contablemente, no propone asientos, no cruza contra el extracto y no estima nada. La
 * liquidación entra al motor contable como **argumento ya resuelto**, igual que el padrón y la
 * cotización: el núcleo de `packages/contabilidad` sigue puro y síncrono (R-J).
 */

import { formaParaLog } from '@sistema-contable/shared/observabilidad';

/**
 * Error del adaptador con **código**, no con mensaje libre.
 *
 * Un mensaje armado con el contenido del archivo filtra el dato al log, al stderr y al historial de la
 * terminal — y acá el dato es la facturación con tarjeta de un comercio identificable, porque la misma
 * invocación lleva el cliente y el formato declarados. El código alcanza para saber qué pasó, y la forma
 * de la línea para saber dónde.
 *
 * ## Qué puede nombrar un código y qué no (dictamen `seguridad-datos-financieros`)
 *
 * **Un código nombra lo que el parser no pudo hacer, nunca lo que el valor era.** Quedan explícitamente
 * fuera de la unión, y no por olvido:
 *
 *  - `ventas_cero`, `neto_negativo`, `contracargo_supera_ventas` — su sola aparición publica un hecho del
 *    negocio del cliente. Se usa `bloque_de_totales_no_interpretado`.
 *  - `arancel_fuera_de_rango`, `alicuota_inesperada` — además de publicar que el término negociado de
 *    este comercio es atípico, **implican un rango esperado compartido**, o sea una tasa en el catálogo
 *    N0 por la puerta de atrás. Un umbral *es* una tasa (R-O).
 *  - cualquier código que diga **qué formato se detectó** — rompe la garantía que el Módulo 1 ya tiene:
 *    la detección VETA la declaración y no revela qué encontró, para no confirmar el contenido de otra
 *    carpeta si el operador se equivocó de cliente. El único término válido vive en `registro.ts`.
 *  - `cuit_del_comercio_no_es_el_del_cliente` — confirma o refuta una relación CUIT↔cliente, o sea un
 *    oráculo. Se usa un booleano de coincidencia, sin decir qué difiere.
 *  - una jurisdicción nombrada dentro del código — las jurisdicciones activas son N2 (ADR-0002 §A.1).
 */
export type CodigoErrorLiquidacion =
  | 'sin_texto'
  | 'caratula_no_reconocida'
  | 'layout_inesperado'
  | 'periodo_no_reconocido'
  | 'bloque_de_conceptos_no_reconocido'
  | 'bloque_de_totales_no_interpretado'
  | 'sin_renglones';

/**
 * Cuarta clase del repo con esta misma forma (`ErrorDeAdaptador`, `ErrorDeTenancy`, `ErrorDeBase`), y
 * eso la hace el patrón vigente, no una copia oportunista: cada subsistema tiene su propio vocabulario
 * cerrado de códigos y su propio `name` en el log, que es lo que hace legible el diagnóstico.
 *
 * **Umbral declarado, no promesa:** si aparece una quinta, sube un `ErrorConCodigo<T>` genérico a
 * `packages/shared`. Antes no: hoy obligaría a tocar los tres adapters bancarios y sus tests en el commit
 * que justamente no debe tocarlos, y un genérico degrada `error.codigo` a `string` en cualquier `catch`
 * sin narrowing — que es justo la propiedad que hace útil al código.
 */
export class ErrorDeLiquidacion extends Error {
  // Declaradas y asignadas a mano, no como parameter properties: el type-stripping de Node no las
  // soporta y este repo corre sin paso de build. `tsc` las acepta, así que el error solo aparece al
  // ejecutar.
  readonly codigo: CodigoErrorLiquidacion;
  /** Forma de la línea que falló, si aplica. NUNCA su texto. */
  readonly formaDeLaLinea: string | undefined;

  constructor(codigo: CodigoErrorLiquidacion, formaDeLaLinea?: string) {
    super(`Liquidacion: ${codigo}${formaDeLaLinea === undefined ? '' : ` (forma=${formaDeLaLinea})`}`);
    this.name = 'ErrorDeLiquidacion';
    this.codigo = codigo;
    this.formaDeLaLinea = formaDeLaLinea;
  }
}

/**
 * Marca de número, aplicada ANTES de reducir la línea a su forma. **Todo token numérico, sin excepción.**
 *
 * La primera versión enmascaraba solo los importes *con decimales* (tres alternativas: con separador de
 * miles, sin él, con punto decimal). `code-reviewer` la refutó ejecutándola, y el modo de falla era peor
 * que no enmascarar nada:
 *
 * | entrada | forma que iba al log |
 * |---|---|
 * | `TOTAL LIQUIDADO   <importe con miles y decimales>` | `AAAAA A{9}   <$>` ✅ |
 * | `TOTAL LIQUIDADO   <importe con miles, sin decimales>` | `AAAAA A{9}   <$><$>#` 🔴 |
 * | `TOTAL LIQUIDADO   <importe sin separadores>` | `AAAAA A{9}   #######` 🔴 |
 *
 * O sea: **la cantidad de marcas quedaba en función de la cantidad de dígitos**, que es publicar la
 * magnitud con otra notación. Y una fecha `dd.mm.aa` se comía a medias, ensuciando el diagnóstico.
 *
 * Un token numérico entero **también** se enmascara, y eso corrige la versión anterior en un segundo
 * punto: el número de liquidación del adquirente está clasificado N2 (ver la tabla de `esquema.ts`), así
 * que dejarlo salir como máscara de dígitos era exactamente la fuga que esta función existe para tapar.
 * Lo que se conserva —cuántos campos hay, dónde caen las columnas, los separadores, el signo— es todo lo
 * que el diagnóstico del parser necesita.
 */
const TOKEN_NUMERICO = /-?\d[\d.,]*\d|-?\d/g;

/** Lo que reemplaza al número. Sin letras ni dígitos, así `forma()` lo deja intacto. */
const MARCA_NUMERO = '<$>';

/**
 * La forma de una línea de liquidación, para un log. **Un paso más que en el extracto, y hace falta.**
 *
 * Hallazgo L-1 de `seguridad-datos-financieros`: `forma()` conserva la longitud y los separadores, y en
 * un importe no hay corrida larga del mismo carácter que `formaParaLog` pueda colapsar. En un extracto
 * eso es tolerable —una línea es una entre miles y su significado es opaco para quien lee el log—, pero
 * en una liquidación **la etiqueta fija el campo**: la forma de la línea de totales sería el orden de
 * magnitud de la facturación mensual con tarjeta de un comercio identificado, en stderr y en los logs de
 * CI, atribuido por el `--cliente` de la misma invocación.
 *
 * Así que primero se borra la magnitud y después se toma la forma. Lo que queda —cuántos campos hay,
 * dónde caen las columnas, dónde está el signo— es todo lo que sirve para arreglar el parser.
 *
 * ```
 * "TOTAL LIQUIDADO   1.234.567,89"  →  "AAAAA AAAAAAAA   <$>"
 * ```
 *
 * Es local a este subárbol a propósito: en el extracto bancario la longitud del importe sí aporta al
 * diagnóstico y el contexto es distinto, así que `formaParaLog` no cambia.
 */
export function formaDeLineaDeLiquidacion(texto: string, largoMaximo = 60): string {
  return formaParaLog(texto.replace(TOKEN_NUMERICO, MARCA_NUMERO), largoMaximo);
}
