/**
 * DETECTORES DE FORMA — compartidos entre el redactor de logs (`redactar.ts`, este paquete), la
 * depuración de glosa bancaria (`packages/ingesta/src/glosa.ts`) y el barrido de fuga (`tools/barrido-fuga.ts`,
 * que importa `DETECTORES` de `redactar.ts` y por lo tanto hereda esto automáticamente).
 *
 * ## Por qué existía la duplicación, y qué se centraliza acá
 *
 * `redactar.ts` y `glosa.ts` reconocían la misma familia de identificadores por FORMA del valor —CBU, CUIT,
 * una corrida larga de dígitos sin clasificar— cada uno con su propia copia, y las copias ya habían
 * divergido sin que nadie lo notara:
 *
 *   - el catch-all de 9+ dígitos era literal idéntico en los dos — duplicado sin necesidad;
 *   - el CBU usaba `\b` en uno y un lookaround-sin-guion en el otro. **No son equivalentes**: probado en
 *     vivo, un CBU pegado a un guión (`REF-9990000090000000000001`) no matchea NINGUNO de los cuatro
 *     patrones de `glosa.ts` (los cuatro excluyen dígito-y-guión en el lookaround, y en una corrida
 *     precedida por un guión no hay ninguna posición desde la que el motor pueda empezar), mientras que
 *     `\b\d{22}\b` sí lo atrapa. El estilo lookaround-sin-guion es el que tiene el agujero, no al revés —
 *     por eso acá se unifica hacia `\b` para los detectores de **longitud fija** (CBU, CUIT, documento) y
 *     el lookaround-que-excluye-separadores se reserva para el catch-all de longitud **variable**, donde
 *     hace falta para no comerse un importe (`1.234,56`) ni la cola de un UUID interno;
 *   - el CUIT no era ni siquiera el mismo patrón: `redactar.ts` exige un prefijo AFIP válido
 *     (`20|23|24|25|26|27|30|33|34`), `glosa.ts` aceptaba cualquier corrida de 11 dígitos con o sin guiones.
 *     Acá se centraliza la versión **estricta** (con prefijo) para los dos: el redactor puede permitirse
 *     tapar de menos algo que cae en el catch-all igual (con una etiqueta menos específica, no una fuga);
 *     `glosa.ts` no puede — y una corrida de 11 dígitos que no es un CUIT válido probablemente tampoco es
 *     el dato que ese renglón quiere describir, así que no hay costo real en exigir el prefijo ahí también.
 *
 * Cada consumidor arma su propia estructura de reporte encima de estos regex —`{nombre, patron, motivo}`
 * en el redactor, `{clase, re}` en la glosa— porque resuelven problemas distintos: el redactor necesita
 * explicar qué detector saltó, la glosa necesita elegir qué marcador imprimir (`[CUIT]`/`[CBU]`/`[DOC]`).
 * Este módulo deliberadamente NO impone una interfaz común: no le serviría a ninguno de los dos.
 *
 * ## El DNI (7-8 dígitos) es el hueco que motivó este módulo
 *
 * Hasta esta corrección `redactar.ts` no tenía detector de DNI — `redactarTexto('DNI 1234567 no
 * encontrado')` devolvía el texto entero, sin tapar nada. `glosa.ts` sí lo tenía (`documento`, línea
 * histórica), pero nunca se había propagado al redactor de logs. Es la misma clase de fuga que motivó la
 * corrección del redactor (un dato N2R de un tercero llegando entero a un log), así que acá se cierra para
 * los dos consumidores, no solo para uno.
 *
 * ## El orden en que cada consumidor aplica estos detectores importa, y es responsabilidad del consumidor
 *
 * Un CBU (22 dígitos) contiene corridas de 11 y de 8. Si el CUIT o el DNI se probaran primero, le comerían
 * una parte al CBU y dejarían el resto suelto — captura de menos, silenciosa. La regla, en los dos
 * consumidores: **CBU → CUIT → documento (DNI) → corrida larga (catch-all, siempre al final)**. Este
 * módulo no aplica el orden — cada `DETECTORES`/`PATRONES` es responsabilidad de quien arma el arreglo—
 * pero se documenta acá para que no se pierda al mover un detector de un lado a otro.
 *
 * ## Separadores comunes (espacio, guión, punto) — solo en CBU, y por qué NO en DNI
 *
 * Se agregan al CBU: es el identificador que un banco o un usuario puede escribir con separadores sin una
 * convención de agrupamiento publicada y estable, y 22 dígitos no colisiona con ningún otro formato del
 * repo. El CUIT no se ensancha (ya tiene forma publicada y fija, `##-########-#`, guión en dos posiciones
 * exactas): no estaba pedido y no está medido contra ningún archivo real con otra convención.
 *
 * 🔴 **El DNI (7-8 dígitos) NO lleva separadores, aunque se probó y se midió que rompía algo real.** La
 * primera versión de este módulo le agregaba separadores comunes al DNI igual que al CBU — y el propio
 * `tools/barrido-fuga.ts`, corrido en modo estricto después de agregarlo, encontró **34 falsos positivos**
 * en todo el repo: el formato **canónico de importe** (`centavosAImporte`, `-?\d+\.\d{2}`, p. ej.
 * `10000.00` — 5 dígitos, un punto, 2 decimales, exactamente 7 dígitos con un separador) matchea el mismo
 * patrón que un DNI de 7 dígitos con un punto adentro. Un importe canónico aparece en CADA fixture y CADA
 * tabla de saldos del repo — aceptar los 34 (y los que seguirían apareciendo) a la allowlist habría vuelto
 * inútil la señal del barrido para lo que sí importa. El DNI real en Argentina SÍ se escribe con puntos de
 * miles (`12.345.678`), pero la ambigüedad con un importe corto no se puede resolver sin contexto semántico
 * que este detector no tiene — así que la decisión, medida y no una corazonada, es: sin separadores en DNI.
 * `redactarTexto`/`contieneIdentificador` siguen tapando/extrayendo un DNI pegado (`12345678`), que es la
 * forma que de hecho aparece en una glosa o en un mensaje de error.
 *
 * Los separadores del CBU se arman **desenrollados** (`\d[\s\-.]?` repetido un número fijo de veces), no
 * con un grupo repetible (`(?:\d[\s\-.]?)+`): con un largo fijo no hay ambigüedad de partición posible
 * entre dígito y separador —las dos clases de carácter son disjuntas—, así que no hay superficie de ReDoS
 * que cubrir.
 *
 * 🔴 **El soporte de separadores del CBU sigue sin medir contra un archivo real** con esa forma —ningún
 * banco del roster publica hoy un CBU con espacios, guiones o puntos— pero, a diferencia del DNI, correr
 * el barrido en modo estricto no encontró ninguna colisión nueva. Si aparece un caso real con una
 * convención de agrupamiento distinta, medir y ajustar acá
 * (`docs/diseno/09-lecciones-aprendidas.md` §2: "un renglón sin conteo verificado es un renglón NO
 * MEDIDO").
 */

/** Separador común entre dígitos: espacio, guión o punto. Opcional entre cada par. */
const SEPARADOR = '[\\s\\-.]?';

/** Arma `\d<sep>?` repetido, para una corrida de `cantidad` dígitos con separadores opcionales entre ellos. */
function digitosConSeparador(cantidad: number): string {
  if (cantidad < 1) throw new Error('cantidad tiene que ser >= 1');
  return `\\d${SEPARADOR}`.repeat(cantidad - 1) + '\\d';
}

/**
 * CBU: 22 dígitos, con separadores comunes opcionales entre cualquier par de dígitos. `\b` a los dos
 * lados: una corrida de 23 dígitos no tiene que recortarse a 22
 * (`docs/diseno/09-lecciones-aprendidas.md` §1, "Lectura del CBU") — con `\b`, no matchea nada, y falla
 * ruidoso en vez de guardar un CBU plausible e inexistente.
 */
export const RE_CBU = new RegExp(`\\b${digitosConSeparador(22)}\\b`, 'g');

/**
 * CUIT/CUIL: prefijo válido de persona física o jurídica (`20|23|24|25|26|27|30|33|34`), 8 dígitos de
 * documento/orden, 1 dígito verificador — con guión opcional en los dos huecos, la forma que el banco
 * publica (`##-########-#`). Es la versión estricta: no acepta cualquier corrida de 11 dígitos.
 */
export const RE_CUIT = /\b(20|23|24|25|26|27|30|33|34)-?\d{8}-?\d\b/g;

/**
 * Documento (DNI): 7 u 8 dígitos PEGADOS, sin separadores internos — ver el comentario de arriba sobre por
 * qué (colisiona con el importe canónico). Es el más ambiguo de los cuatro —un número de operación también
 * tiene esta forma— así que en los dos consumidores va INMEDIATAMENTE ANTES del catch-all, nunca antes de
 * CBU o CUIT.
 *
 * Los lookarounds excluyen dígito, guión, punto Y COMA a los dos lados — no `\b` — por un motivo medido y
 * específico de este detector: sin excluir la coma, un importe sin separador de miles (`1234567,89`) le
 * entrega sus siete dígitos enteros a este patrón (el bug original de `glosa.ts`, ya corregido ahí). Sin
 * excluir el punto, el decimal de un importe canónico (`1234567.89`) tendría el mismo problema.
 */
export const RE_DNI = /(?<![\d\-.,])\d{7,8}(?![\d\-.,])/g;

/**
 * Corrida larga: 9 dígitos o más que no cayeron en ningún detector anterior. Un identificador parcial
 * sigue siendo un identificador. El piso es 9, no 7: un conteo de 7-8 dígitos (bytes, filas, duración) es
 * demasiado común en diagnóstico para taparlo por defecto — ese piso está test-verificado en
 * `packages/shared/tests/redactor.test.ts`. Sin soporte de separadores a propósito: es el backstop de
 * longitud variable, y ensancharlo con separadores le haría comerse importes y colas de UUID, que es
 * justamente lo que sus lookarounds excluyen.
 */
export const RE_CORRIDA_LARGA = /(?<![\d\-.,])\d{9,}(?![\d\-.,])/g;

/**
 * Copia de un regex **sin las flags que llevan estado**: `g` y `y`.
 *
 * Las dos hacen que `exec`/`test` arrastren `lastIndex` entre llamadas, así que un patrón reusado sobre
 * varias líneas **saltea apariciones** — y el salteo es silencioso: no falla, devuelve menos.
 *
 * Vivía duplicada: una vez en `packages/ingesta/src/adaptadores/toolkit.ts` (que la usa para buscar por
 * etiqueta) y una vez, peor, como `.flags.replace('g', '')` en `tools/barrido-fuga.ts` — esa variante
 * **tapaba `g` y dejaba pasar `y`**, el mismo bug de clase que ya se había corregido acá. Un solo lugar,
 * con las dos flags.
 */
export function sinEstado(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
}
