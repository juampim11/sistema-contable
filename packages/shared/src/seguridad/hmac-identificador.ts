/**
 * HMAC DE UN IDENTIFICADOR PARA BÚSQUEDA — con pepper de servidor, no un hash pelado.
 *
 * ## Por qué no `sha256(cbu)`
 *
 * Un CBU tiene 22 dígitos, y de esos los primeros tres son el banco y hay un dígito verificador: el
 * espacio real es chico y **completamente enumerable**. Un `sha256` sin secreto se revierte con un
 * diccionario en minutos, así que guardarlo así es guardar el CBU con un paso extra.
 *
 * El pepper cambia eso: sin el secreto, el diccionario no se puede construir. Y es un **pepper** y no un
 * salt por fila a propósito — un salt distinto por fila haría imposible la búsqueda por igualdad, que es
 * justamente para lo que existe esta columna.
 *
 * ## Qué protege y qué no
 *
 * Protege contra alguien que obtiene un dump de la base sin el `.env` (backup filtrado, réplica mal
 * configurada, disco de un proveedor). **No** protege contra alguien que tiene los dos: con el pepper y la
 * tabla se puede enumerar. Eso está declarado, no disimulado: para el número de cuenta, que sí hace falta
 * entero, el control es otro (N2R con rol en lectura y lector auditado).
 *
 * La regla general del plan §8.7: *un identificador que solo hace falta para **matchear** se guarda
 * hasheado; uno que hace falta para **consultar afuera** se guarda entero, N2R, con rol y auditoría.*
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Longitud del digest. 32 bytes es lo que da sha256 y no hay razón para truncarlo. */
const LARGO_DIGEST = 32;

/**
 * Normaliza el identificador antes de hashear.
 *
 * **Sin esto el HMAC no sirve para buscar**: el mismo CBU escrito `0170-1234-5678901234` y
 * `01701234567890 1234` daría dos digests distintos, y el extracto no matchearía con la cuenta dada de
 * alta a mano. Se conservan solo los dígitos, que es la identidad real del identificador.
 */
export function normalizarIdentificador(valor: string): string {
  return valor.replace(/\D/g, '');
}

/**
 * El valor que trae `.env.example`. Está acá para poder **rechazarlo**, no para usarlo.
 *
 * El `.env.example` está escrito para copiarse, así que el pepper de desarrollo termina en el `.env` de
 * cualquiera. Y un HMAC con una clave que está en el repo, en cada clon y en cada caché de CI **es un hash
 * sin secreto**: exactamente lo que el comentario de arriba dice que no sirve, porque un CBU tiene 22
 * dígitos con banco y verificador adentro y el espacio es enumerable.
 *
 * O sea que la protección de `cbu_hmac` para toda fila cargada con este valor es **cero**, mientras el
 * código dice que está cubierta. El guard existe para que eso no pueda pasar fuera de `local`.
 */
const PEPPER_DE_EJEMPLO = 'pepper_de_desarrollo_no_usar_en_produccion_0001';

/** Versión del pepper en uso. Va a `cuenta_bancaria_identificador.pepper_id` (migración 0006). */
export function pepperIdActual(): string {
  return process.env['IDENTIFICADOR_PEPPER_ID'] ?? 'v1';
}

function pepperDelEntorno(): Buffer {
  const pepper = process.env['IDENTIFICADOR_PEPPER'];
  if (!pepper || pepper.length < 32) {
    throw new Error(
      'Falta IDENTIFICADOR_PEPPER (mínimo 32 caracteres). Es el secreto de servidor con el que se ' +
        'hashean los identificadores de cuenta para búsqueda; sin él, un sha256 de un CBU se revierte ' +
        'con un diccionario. Ver .env.example y ADR-0002 §E.',
    );
  }

  // El entorno se lee acá y no se importa de `packages/data`: `shared` no puede depender de `data`.
  const entorno = process.env['APP_ENTORNO'];
  if (pepper === PEPPER_DE_EJEMPLO && entorno !== 'local') {
    throw new Error(
      `IDENTIFICADOR_PEPPER es el valor de ejemplo del repo y APP_ENTORNO es "${entorno ?? 'sin definir'}". ` +
        'Ese valor es PÚBLICO: está en .env.example, en cada clon y en cada caché de CI, así que el HMAC ' +
        'que produce no protege nada. Generá uno propio de 32 bytes al azar en base64 y ponelo ' +
        'solo en .env (o en el almacén de secretos). Ver ADR-0002 §E.',
    );
  }

  return Buffer.from(pepper, 'utf8');
}

/**
 * HMAC-SHA256 del identificador normalizado. Devuelve el digest crudo, que es lo que va a la columna
 * `bytea` — no un hexadecimal, porque un texto invita a compararlo con `like` y eso no tiene sentido
 * sobre un digest.
 *
 * Lanza si el identificador queda vacío después de normalizar: hashear la cadena vacía produce un digest
 * perfectamente válido que matchearía contra cualquier otra fila cargada con un valor vacío, y ese es un
 * falso positivo de resolución de cuenta — el peor tipo, porque asigna el extracto a una cuenta ajena.
 */
export function hmacIdentificador(valor: string): Buffer {
  const normalizado = normalizarIdentificador(valor);
  if (normalizado.length === 0) {
    throw new Error('El identificador no tiene ni un dígito: no se puede hashear para búsqueda.');
  }
  return createHmac('sha256', pepperDelEntorno()).update(normalizado, 'utf8').digest();
}

/** Comparación en tiempo constante. Sobre un digest de búsqueda el riesgo es teórico, pero es gratis. */
export function hmacIguales(a: Buffer, b: Buffer): boolean {
  if (a.length !== LARGO_DIGEST || b.length !== LARGO_DIGEST) return false;
  return timingSafeEqual(a, b);
}

/**
 * Los últimos cuatro dígitos **crudos**, para guardar en la columna `cbu_ultimos4`.
 *
 * No confundir con `ultimos4()` de `redactar.ts`, que devuelve `••••1234` para **mostrar**. Son dos cosas
 * distintas y por eso tienen dos nombres: lo que se guarda en la columna no puede llevar los puntos de
 * relleno, y lo que se pinta en una pantalla no puede ser el valor pelado.
 */
export function ultimos4ParaGuardar(valor: string): string | null {
  const n = normalizarIdentificador(valor);
  return n.length >= 4 ? n.slice(-4) : null;
}
