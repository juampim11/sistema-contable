/**
 * REDACTOR — ADR-0002 §D.
 *
 * Deriva del registro de clasificación (`clasificacion-campos.ts`): no hay una segunda lista.
 * Dos capas, porque un dato sensible llega de dos formas distintas:
 *
 *   1. **Por nombre de clave**: `{ cbu: '01701234...' }`. Se tapa la clave.
 *   2. **Por forma del valor**: un CUIT o un CBU dentro de un texto libre, un PEM, un base64 largo.
 *      Se tapa el fragmento. Esta capa es la que atrapa el caso real: el mensaje de error del driver
 *      de Postgres (`Key (cbu)=(0170...) already exists`), donde el dato viene DENTRO de un string.
 *
 * No reemplaza a las reglas: el logger **rechaza en tiempo de compilación** las claves sensibles
 * (R27). Esto es la red para lo que llega por texto y para lo que se serializa desde afuera.
 */

import { CLAVES_SENSIBLES_EXTERNAS, COLUMNAS_SENSIBLES } from './clasificacion-campos.ts';
import { RE_CBU, RE_CORRIDA_LARGA, RE_CUIT, RE_DNI, RE_PAN } from './detectores-forma.ts';

export const MARCA = '[REDACTADO]';

const CLAVES_A_TAPAR: ReadonlySet<string> = new Set([
  ...COLUMNAS_SENSIBLES,
  ...CLAVES_SENSIBLES_EXTERNAS,
]);

/** Se comparan sin `_`, sin `-` y en minúsculas: `razonSocial`, `razon_social` y `RAZON-SOCIAL` son la misma. */
function normalizarClave(clave: string): string {
  return clave.toLowerCase().replace(/[_\-\s]/g, '');
}

const CLAVES_NORMALIZADAS: ReadonlySet<string> = new Set(
  [...CLAVES_A_TAPAR].map(normalizarClave),
);

export function esClaveSensible(clave: string): boolean {
  return CLAVES_NORMALIZADAS.has(normalizarClave(clave));
}

/**
 * Detectores por forma del valor. Cada uno con su motivo, para que un hallazgo se pueda explicar.
 *
 * Ojo con el orden: los más específicos primero. El CBU (22 dígitos) tiene que taparse antes de que
 * un detector de "número largo" lo parta.
 */
export const DETECTORES: readonly { nombre: string; patron: RegExp; motivo: string }[] = [
  {
    nombre: 'clave_privada_pem',
    patron: /-----BEGIN[\s\S]*?-----END[^-]*-----/g,
    motivo: 'Material criptográfico en claro (N3).',
  },
  {
    nombre: 'clave_privada_pem_parcial',
    patron: /-----BEGIN [A-Z ]+-----/g,
    motivo: 'Encabezado de clave privada: aunque esté truncada, no se loguea.',
  },
  {
    nombre: 'cbu',
    // Forma centralizada en `detectores-forma.ts`, compartida con `glosa.ts`: mismo patrón, con soporte de
    // separadores comunes (espacio, guión, punto). Ver el comentario de ese módulo para el caso medido
    // (un CBU pegado a un guión) que justifica `\b` en vez de un lookaround que excluye el guión.
    patron: RE_CBU,
    motivo: 'CBU (22 dígitos) — N2R.',
  },
  {
    nombre: 'cuenta_con_separadores',
    // Un número de cuenta escrito con guiones o espacios (`0170-1234-5678901234`) NO matchea el
    // patrón de 22 dígitos. Salió de correr INV-8: venía dentro del nombre de un archivo.
    //
    // Los lookarounds NO son decorativos: sin ellos el patrón matchea la cola de un UUID
    // (`…-0000-0000-000000000001`) y el redactor tapa los identificadores internos, que son
    // justamente lo que SÍ tiene que quedar para poder depurar. Pasó al correr el test.
    patron: /(?<![\da-fA-F-])\d{3,4}[-\s]\d{3,5}[-\s]\d{6,14}(?![\da-fA-F-])/g,
    motivo: 'Número de cuenta con separadores — N2R.',
  },
  {
    nombre: 'cuit',
    // Forma centralizada en `detectores-forma.ts`, compartida con `glosa.ts` (que antes aceptaba
    // cualquier corrida de 11 dígitos sin validar prefijo — acá se unificó hacia la versión estricta).
    patron: RE_CUIT,
    motivo: 'CUIT/CUIL — N2R.',
  },
  {
    nombre: 'pan',
    // Forma centralizada en `detectores-forma.ts` (visa-corporativa.ts, `sinPan`). Valor de triage,
    // no de protección: el camino de glosa bancaria ya está cerrado por `RE_CORRIDA_LARGA` sin tocar
    // nada — esta entrada tapa un PAN (13-19 dígitos) si llegara a aparecer en un texto libre que
    // pase por el redactor (un mensaje de error, por ejemplo), antes de que el catch-all lo capture
    // con una etiqueta menos específica.
    patron: RE_PAN,
    // N2R, no N3 (`niveles.ts:14-16`): un PAN es un identificador directo que habilita fraude —
    // mismo nivel que CBU/CUIT. N3 es para lo que habilita ACTUAR en nombre del cliente (clave
    // fiscal, clave privada, DSN), que no es el caso de un número de tarjeta.
    motivo: 'Número de tarjeta (PAN, 13-19 dígitos) — N2R.',
  },
  {
    nombre: 'documento',
    // 🔴 Hasta acá el redactor no tenía detector de DNI: `redactarTexto('DNI 1234567 no encontrado')`
    // devolvía el texto entero, sin tapar nada. Es la misma clase de fuga que motivó el catch-all
    // `corrida_larga` de más abajo (un identificador de un tercero que ningún detector reconocía) — la
    // diferencia es que acá el hueco era total: 7-8 dígitos ni siquiera caen en el catch-all (que empieza
    // en 9). `glosa.ts` ya tenía este detector para la glosa bancaria; nunca se había propagado acá.
    // Forma centralizada en `detectores-forma.ts` — ver ahí el motivo de excluir la coma del lookaround
    // (no comerse el decimal de un importe sin separador de miles).
    patron: RE_DNI,
    motivo: 'DNI (7-8 dígitos) — N2R.',
  },
  {
    nombre: 'jwt',
    patron: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    motivo: 'Token de sesión o de webservice — N3.',
  },
  {
    nombre: 'dsn_con_credencial',
    patron: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@]+@[^\s]+/gi,
    motivo: 'DSN o URL con usuario y contraseña — N3.',
  },
  {
    nombre: 'base64_largo',
    patron: /\b[A-Za-z0-9+/]{120,}={0,2}\b/g,
    motivo: 'Blob base64 largo: puede ser un certificado, un archivo o un dump.',
  },
  {
    nombre: 'importe_ar',
    // Importe en formato argentino: separador de miles con punto y dos decimales con coma.
    //
    // No existía, y era la mitad del agujero H-C: un saldo o un importe dentro de un texto libre
    // —el `detail` de un error, un mensaje armado a mano— pasaba el redactor entero. Se limita al
    // formato LOCAL a propósito: un detector de la forma canónica (`-?\d+\.\d{2}`) matchearía
    // duraciones (`1830.00`) y conteos, y un redactor que tapa los conteos deja de servir para
    // depurar, que es la otra forma de fallar.
    patron: /(?<![\d,.])-?\d{1,3}(?:\.\d{3})+,\d{2}(?![\d,.])/g,
    motivo: 'Importe en formato argentino — N2.',
  },
  {
    nombre: 'corrida_larga',
    // 🔴 Va AL FINAL a propósito: es el catch-all, y el orden "los más específicos primero" (comentario
    // de arriba) tiene que ganarle cuando aplica, para que el detector que se reporta sea el preciso
    // (`cbu`, `cuit`) y no éste.
    //
    // Es la propagación de `packages/ingesta/src/glosa.ts` (mismo patrón, mismo argumento: "un
    // identificador parcial sigue siendo un identificador"), que nunca llegó hasta acá. El agujero era
    // real y se midió: un CBU de 23 dígitos (uno más que el publicado) o un CUIT con un dígito pegado no
    // matcheaban `cbu` ni `cuit` —los dos anclan con `\b` a los dos lados, y una corrida más larga rompe
    // el límite derecho— y **`redactarTexto` los dejaba pasar enteros**. En un LECTOR ese límite faltante
    // captura de más y se nota; en un REDACTOR captura de menos y no se nota nunca — es la cara más grave
    // de "todo dato posicional necesita sus dos límites" (`docs/diseno/09-lecciones-aprendidas.md` §1):
    // acá el límite estaba puesto, pero no se había propagado al archivo hermano.
    //
    // 9 dígitos porque es el piso de `glosa.ts` (ahí lo eligieron por ser más corto que el CUIT de 11).
    // Los lookarounds excluyen separadores para no comerse un importe (que siempre lleva coma decimal)
    // ni la cola de un uuid interno, que es justo lo que tiene que quedar legible para depurar.
    //
    // Forma centralizada en `detectores-forma.ts`, idéntica carácter por carácter a la que ya tenía
    // `glosa.ts` — antes eran dos copias que podían divergir sin que nadie lo notara.
    patron: RE_CORRIDA_LARGA,
    motivo: 'Corrida larga de dígitos sin clasificar — puede ser un identificador parcial o completo.',
  },
];

/** Tapa en un texto todo lo que matchee un detector. Devuelve el texto y qué detectores saltaron. */
export function redactarTexto(texto: string): { texto: string; detectores: string[] } {
  let resultado = texto;
  const saltaron: string[] = [];
  for (const { nombre, patron } of DETECTORES) {
    // `patron` es global: se re-crea el lastIndex en cada uso para no arrastrar estado entre llamadas.
    const re = new RegExp(patron.source, patron.flags);
    if (re.test(resultado)) {
      saltaron.push(nombre);
      resultado = resultado.replace(new RegExp(patron.source, patron.flags), MARCA);
    }
  }
  return { texto: resultado, detectores: saltaron };
}

/** ¿Este texto contiene algo que no debería salir? Es el corazón del test INV-8. */
export function contieneDatoSensible(texto: string): boolean {
  return redactarTexto(texto).detectores.length > 0;
}

const PROFUNDIDAD_MAXIMA = 8;

/**
 * Redacta una estructura completa: tapa las claves sensibles por nombre y los valores por forma.
 *
 * Un `Error` se reduce a nombre + mensaje redactado. **La `stack` no se conserva**: suele traer
 * variables locales, y el `detail`/`where` del driver de Postgres viene con valores de fila —
 * exactamente la fuga de ADR-0002 R28.
 */
export function redactar(valor: unknown, profundidad = 0): unknown {
  if (valor === null || valor === undefined) return valor;
  if (profundidad > PROFUNDIDAD_MAXIMA) return '[PROFUNDIDAD_MAXIMA]';

  if (typeof valor === 'string') return redactarTexto(valor).texto;
  if (typeof valor === 'number' || typeof valor === 'boolean' || typeof valor === 'bigint') return valor;
  if (valor instanceof Date) return valor.toISOString();

  if (valor instanceof Error) {
    return {
      nombre: valor.name,
      mensaje: redactarTexto(valor.message).texto,
      // Sin stack, sin `detail`, sin `where`, sin los parámetros ligados de la query.
    };
  }

  if (Array.isArray(valor)) {
    return valor.map((v) => redactar(v, profundidad + 1));
  }

  if (typeof valor === 'object') {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
      salida[clave] = esClaveSensible(clave) ? MARCA : redactar(v, profundidad + 1);
    }
    return salida;
  }

  // Funciones, símbolos y lo que no sepamos serializar: no se loguean.
  return '[NO_SERIALIZABLE]';
}

/** Enmascarados para mostrar en pantalla cuando el rol puede ver el dato pero no hace falta completo. */
export function ultimos4(valor: string): string {
  const limpio = valor.replace(/\D/g, '');
  return limpio.length <= 4 ? '••••' : `••••${limpio.slice(-4)}`;
}

export function cuitParcial(cuit: string): string {
  const d = cuit.replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 2)}-•••••••-${d.slice(10)}` : '••-•••••••-•';
}

export function huella(sha256: string): string {
  return sha256.length <= 8 ? sha256 : `${sha256.slice(0, 8)}…`;
}
