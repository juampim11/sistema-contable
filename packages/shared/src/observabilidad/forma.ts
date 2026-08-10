/**
 * `forma()` — la técnica que reemplaza al "logueá la línea así la vemos".
 *
 * ## El problema que resuelve
 *
 * Cuando un adapter no entiende una línea del extracto, lo que uno quiere hacer es loguear la línea.
 * Es lo natural y es la fuga más costosa del módulo: esa línea contiene el nombre y el documento de una
 * contraparte, y el log se rota, se indexa y se respalda **fuera del alcance de la RLS**. Y no hay
 * redactor que la salve: una razón social es texto sin patrón (ADR-0002 §C.0.bis).
 *
 * ## La solución
 *
 * Loguear la **forma**: cada dígito a `9`, cada letra mayúscula a `A`, cada minúscula a `a`, y la
 * puntuación y los espacios intactos. Alcanza para arreglar el adapter —se ve dónde están las columnas,
 * cuántos dígitos tiene cada campo, dónde cae el signo— y **no contiene ni un dato**.
 *
 * ```
 * línea real   →  (no se escribe, ni acá ni en un log)
 * forma        →  "99/99/99 AAAAAAAAA AAAA 9999999999 -9.999.999,99 999.999,99"
 * ```
 *
 * No es una idea de escritorio: **toda la especificación estructural del informe de seguridad de este
 * módulo se construyó así**, sin leer una sola línea real de un extracto.
 *
 * ## El contrato, corregido por su propio test
 *
 * La versión anterior usaba `9` para los dígitos y afirmaba que **"`forma()` de cualquier texto no
 * matchea ningún detector"**. El test lo refutó: la forma preserva la **estructura**, así que los
 * detectores —que son estructurales— siguen matcheando. `9999999999999999999999` matchea el detector de
 * CBU; `-9.999,99` matchea el de importe.
 *
 * Y no era un detalle cosmético: **el logger corre el redactor sobre todo lo que emite**, así que la forma
 * habría salido como `99/99/99 … [REDACTADO]` — perdiendo justo la parte que sirve para depurar.
 *
 * El arreglo es la máscara, no el contrato: los dígitos se enmascaran con **`#`**, que ningún detector
 * busca. Y el contrato queda partido en dos, cada uno verificable:
 *
 *   1. **`forma()`** no conserva ningún carácter de dato: **cero dígitos originales, cero letras
 *      originales**. Es la propiedad que garantiza que no filtra un valor.
 *   2. **`formaParaLog()`** —la que realmente va a un log— **no matchea ningún detector**. Colapsa las
 *      corridas largas, con lo que además cierra el único caso que quedaba (una corrida de letras de
 *      120+ caracteres matcheando el detector de base64).
 */

/**
 * Reduce un texto a su forma. Idempotente: `forma(forma(x)) === forma(x)`.
 *
 * Lo que se conserva a propósito, porque es lo que sirve para depurar y no identifica a nadie:
 * la **longitud**, la **posición** de cada campo, los **separadores** (`/ - . , : ; ( ) $ %`), los
 * **espacios** (incluida su cantidad, que es cómo se detecta una columna de ancho fijo) y el **signo**.
 */
export const MASCARA_DIGITO = '#';

export function forma(texto: string): string {
  let salida = '';
  for (const caracter of texto) {
    if (caracter >= '0' && caracter <= '9') salida += MASCARA_DIGITO;
    else if (/\p{Lu}/u.test(caracter)) salida += 'A';
    else if (/\p{Ll}/u.test(caracter)) salida += 'a';
    else salida += caracter;
  }
  return salida;
}

/** ¿Este texto ya es una forma? Útil para no enmascarar dos veces y para verificar el contrato. */
export function esForma(texto: string): boolean {
  return !/[0-9]/.test(texto) && !/[b-zB-Z]/.test(texto.replace(/[Aa]/g, ''));
}

/**
 * Forma acotada, para un log.
 *
 * Dos capas de prudencia sobre `forma()`:
 *  - **Colapsa las corridas largas** (`AAAAAAAAAAAA` → `A{12}`): un log no necesita 80 caracteres para
 *    decir "acá hay texto", y la longitud exacta de un nombre es un dato débil pero es un dato.
 *  - **Trunca** a un largo máximo, para que una línea patológica no llene el log.
 */
export function formaParaLog(texto: string, largoMaximo = 120): string {
  const colapsada = forma(texto).replace(
    /(.)\1{7,}/g,
    (corrida, caracter: string) => `${caracter}{${corrida.length}}`,
  );
  return colapsada.length <= largoMaximo
    ? colapsada
    : `${colapsada.slice(0, largoMaximo - 1)}…`;
}
