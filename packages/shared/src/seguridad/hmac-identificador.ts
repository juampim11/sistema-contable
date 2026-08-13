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

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** Longitud del digest. 32 bytes es lo que da sha256 y no hay razón para truncarlo. */
const LARGO_DIGEST = 32;

/**
 * Las tres formas de identificador que puede traer una glosa bancaria (migración 0013).
 *
 * `packages/ingesta/src/glosa.ts` (`PATRONES`) nunca produce una etiqueta distinta de estas tres:
 * el CUIT y el CUIL son el mismo número por forma (`RE_CUIT` es un solo patrón para los dos) y la
 * extracción los junta en el bucket `cuit`. Un cuarto valor `'cuil'` sería una etiqueta que ningún
 * camino de extracción puede producir — una mentira en el esquema.
 *
 * Idéntica a `mov_contraparte_clase_chk` (migración 0013); hay test de catálogo. Vive acá y no en
 * `packages/ingesta` porque `packages/contabilidad` (capa C, motor de reconocimiento) necesita el
 * tipo y no puede depender de `ingesta` ni de `data`.
 */
export const CLASES_IDENTIFICADOR_CONTRAPARTE = ['cuit', 'dni', 'cbu'] as const;
export type ClaseIdentificador = (typeof CLASES_IDENTIFICADOR_CONTRAPARTE)[number];

/**
 * Los tipos de documento con los que se identifica a un SOCIO — subconjunto de
 * `CLASES_IDENTIFICADOR_CONTRAPARTE` menos `cbu` y `dni`, más `cuil` como ETIQUETA (lo que la
 * contadora tipeó al cargar el padrón). `dni` queda afuera: no identifica a un socio ante ningún
 * organismo, y admitirlo abriría el padrón a un documento que después no matchea nada de lo que
 * publica un banco en una glosa.
 *
 * `hmacDocumento` (abajo) canoniza `'cuit'` y `'cuil'` al MISMO dominio de hash: son el mismo
 * número, y si no canonizaran, un socio cargado como `cuil` nunca matchearía un candidato que la
 * extracción etiquetó `cuit` (o viceversa) — la etiqueta documental existe para mostrarse en
 * pantalla, no para particionar el espacio de hash.
 *
 * Idéntica a `padron_socio_documento_tipo_chk`; hay test de catálogo.
 */
export const TIPOS_DOCUMENTO_SOCIO = ['cuit', 'cuil'] as const;
export type TipoDocumentoSocio = (typeof TIPOS_DOCUMENTO_SOCIO)[number];

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

// Misma razón que en `packages/data/src/db/auditoria.ts`: forma de uuid, sin exigir versión ni
// variante RFC — `shared` no puede depender de `zod` para esto sin sumar una dependencia solo para
// un regex.
const RE_UUID_CLIENTE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Memoiza el pepper derivado por `(pepperId, clienteId)`: 1830+ derivaciones en un solo backfill,
 *  y HKDF no es gratis. Sin exposición nueva — el pepper global ya vive en memoria del proceso. */
const cachePepperDerivado = new Map<string, Buffer>();

/**
 * Deriva un pepper POR CLIENTE a partir del pepper global del entorno, vía HKDF (RFC 5869).
 *
 * ## Por qué existe
 *
 * `hmacIdentificador()` usa un pepper único para todo el despliegue: el mismo CUIT de contraparte
 * produce el mismo digest en movimientos de clientes distintos del mismo estudio. Un `socio` con
 * membership en varios clientes podría, sin ver un solo CUIT en claro, notar que dos clientes sin
 * relación entre sí comparten una contraparte — minería de datos cruzada entre clientes, decisión
 * de negocio explícita para NO permitirla (plan `adaptive-herding-pillow`, Módulo 2).
 *
 * ## Por qué NO se exporta
 *
 * Ningún consumidor de este módulo recibe jamás el pepper, derivado o no: `pepperDelEntorno()` es
 * privado desde el día uno, y la API pública recibe el VALOR a hashear, nunca la clave
 * (`hmacIdentificador(valor)`). Exportar un `Buffer` de material de clave lo pondría en manos de
 * `apps/cli` y `packages/ingesta`, en una variable que se puede loguear, serializar en un mensaje
 * de error o pasar por un objeto que después cruza `redactar()` — que tapa por NOMBRE de clave, y
 * `pepper` no está en `CLAVES_SENSIBLES_EXTERNAS`.
 *
 * ## El guard de `clienteId`, el más importante de los tres
 *
 * HKDF no falla si `info` está vacío o es basura: devuelve una clave perfectamente válida, LA
 * MISMA para cualquier entrada de `info` inválida. Si `clienteId` fuera `''` por un bug de
 * llamador, la derivación colapsaría a un único pepper compartido — reintroduciendo el pepper
 * global en silencio, sin que nada se ponga rojo. Por eso se exige forma de uuid antes de derivar,
 * no después.
 */
function pepperDerivadoPorCliente(clienteId: string): Buffer {
  if (!RE_UUID_CLIENTE.test(clienteId)) {
    throw new Error(
      `pepperDerivadoPorCliente necesita un clienteId con forma de uuid, recibió "${clienteId}". ` +
        'Un valor vacío o inválido no rompe HKDF: produce la MISMA clave para cualquier cliente, y ' +
        'eso reintroduce el pepper global en silencio.',
    );
  }

  const pepperId = pepperIdActual();
  const clave = `${pepperId}:${clienteId.toLowerCase()}`;
  const cacheada = cachePepperDerivado.get(clave);
  if (cacheada) return cacheada;

  const ikm = pepperDelEntorno();
  const salt = Buffer.from('sistema-contable/contraparte/hkdf/v1', 'utf8');
  // `pepperId` viaja en el `info`, no solo en la columna que lo acompaña: si no dependiera de él,
  // alguien podría bumpear `IDENTIFICADOR_PEPPER_ID` sin cambiar el secreto y obtener una corrida
  // "rotada" con los mismos digests bajo una etiqueta nueva — una rotación que parece hecha y no
  // rotó nada. Con el id en el material, un `pepper_id` nuevo produce digests nuevos siempre.
  const info = Buffer.from(`contraparte:${pepperId}:${clienteId.toLowerCase()}`, 'utf8');
  const derivado = Buffer.from(hkdfSync('sha256', ikm, salt, info, LARGO_DIGEST));

  cachePepperDerivado.set(clave, derivado);
  return derivado;
}

/**
 * Colapsa la etiqueta del llamador al DOMINIO de hash. `cuit` y `cuil` son el mismo número —
 * misma estructura de 11 dígitos, mismo espacio de prefijos AFIP— así que canonizan al mismo
 * dominio: si no lo hicieran, un socio cargado como `cuil` en el padrón nunca matchearía un
 * candidato que la extracción de la glosa etiquetó `cuit` (o viceversa), en silencio.
 */
function dominioDeHash(tipo: ClaseIdentificador | TipoDocumentoSocio): 'cuit_cuil' | 'dni' | 'cbu' {
  if (tipo === 'dni') return 'dni';
  if (tipo === 'cbu') return 'cbu';
  return 'cuit_cuil';
}

/**
 * HMAC de un identificador de CONTRAPARTE (documento o CBU de un tercero), con pepper DERIVADO POR
 * CLIENTE — nunca el pepper global de `hmacIdentificador()`.
 *
 * Usada por `movimiento_contraparte_identificador.hmac` y `padron_socio.documento_hmac`
 * (migración 0013). El `tipo` entra como etiqueta de DOMINIO en el material hasheado
 * (`` `${dominio}:${normalizado}` ``), nunca en una columna separada: un CUIT y un DNI que
 * compartieran los mismos dígitos —hoy imposible por longitud, pero un atajo futuro podría
 * intentarlo— dan digests distintos siempre.
 *
 * Lanza sobre el mismo caso que `hmacIdentificador`: identificador vacío tras normalizar.
 */
export function hmacDocumento(
  tipo: ClaseIdentificador | TipoDocumentoSocio,
  valor: string,
  clienteId: string,
): Buffer {
  const normalizado = normalizarIdentificador(valor);
  if (normalizado.length === 0) {
    throw new Error('El identificador no tiene ni un dígito: no se puede hashear para búsqueda.');
  }
  const material = `${dominioDeHash(tipo)}:${normalizado}`;
  return createHmac('sha256', pepperDerivadoPorCliente(clienteId)).update(material, 'utf8').digest();
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
