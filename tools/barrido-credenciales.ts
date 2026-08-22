/**
 * BARRIDO DE CREDENCIALES EN ARCHIVOS TRACKEADOS — R37 (incidente #3).
 *
 * ## Qué problema resuelve, y por qué no alcanza con ignorar `.env.example`
 *
 * El incidente #3 fue: `.env.example` estaba **trackeado**, con valores reales en vez de marcadores,
 * y viajó a `origin/main` de un repositorio **público** con la contraseña del dueño del esquema
 * (superusuario) y la de `app_job` (`BYPASSRLS`) — las mismas que estaban vivas en el piloto.
 *
 * Sacar ese archivo del tracking cierra **el caso**. Esta herramienta cierra **la clase**: cualquier
 * archivo trackeado, se llame como se llame, que tenga forma de credencial adentro. Porque el
 * mecanismo no fue "alguien commiteó un `.env`" — fue "un archivo que documentaba variables se fue
 * llenando de valores". Eso puede pasar en un `docker-compose.yml`, en un workflow de CI, en un
 * `.md` del runbook, o en un script de despliegue.
 *
 * ## Por qué barre `git ls-files` y no el filesystem
 *
 * La pregunta que importa no es *"¿qué archivos hay?"* sino **"¿qué está trackeado?"** — que es lo
 * único que puede viajar a un remoto. Un archivo con secretos que está en disco pero ignorado no es
 * el incidente; uno trackeado sí. Barrer el filesystem mediría lo que es fácil de medir en vez de lo
 * que hay que garantizar, que es justo el error que R10 cometió dos veces (ADR-0002 §B.1).
 *
 * ## Las tres formas que detecta
 *
 *   (a) **Forma de archivo de entorno**: `.env`, `.env.loquesea`. Ninguno puede estar trackeado.
 *   (b) **URL con credenciales embebidas**: `<esquema>://<usuario>:<secreto>@host`. Es como viajó el
 *       `DATABASE_URL` del incidente: la contraseña no estaba solo en su variable, estaba **otra vez**
 *       adentro del DSN. Quien rote una y no la otra deja la mitad viva.
 *   (c) **Asignación de una clave de nombre secreto a un literal que no es marcador.**
 *
 * ## 🔴 Y la comprobación que de verdad habría atajado el incidente
 *
 * La allowlist de (c) NO alcanza para dejar pasar un valor: además se exige que ese literal **no
 * coincida con ningún valor de un `.env*` real de la máquina**. Ésa es exactamente la falla del #3 —
 * el valor "de ejemplo" y el valor **vivo del piloto** eran la misma cadena, y nadie lo notó durante
 * cinco días. Un literal descartable de CI es aceptable; el mismo literal siendo además la
 * credencial de un entorno real, no. Y eso no se puede permitir por allowlist.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { raizDelRepo } from './cargar-env.ts';

export type Hallazgo = {
  readonly archivo: string;
  readonly forma: 'archivo-de-entorno' | 'url-con-credencial' | 'asignacion' | 'valor-vivo';
  readonly clave: string;
  /** NUNCA el valor: solo su longitud y un hash corto. Un hallazgo no puede filtrar lo que denuncia. */
  readonly huella: string;
};

/**
 * Permitidos de (c), con motivo obligatorio. Un permitido NO exime de la comprobación de valor vivo.
 *
 * El motivo es parte del dato a propósito: un permitido sin razón escrita es una excepción que nadie
 * puede revisar después, y este archivo existe justamente porque una excepción sin revisar
 * (`!.env.example` en `.gitignore`) sobrevivió a toda la vida del repo.
 *
 * 🔴 Antes de agregar acá una excepción sobre `.github/workflows/ci.yml`: ¿por qué este valor no se
 * GENERA (`openssl rand -hex 24`, como el resto del bloque de `.env` de CI)? Ya pasó DOS veces
 * (`app_lectura_dev`, después `ci_lectura`/`ci_escritura`, HANDOFF entrada 99) que la respuesta
 * correcta era generar el valor, no documentar la excepción — un literal fijo en una clave con forma
 * `NOMBRE_SECRETO` hace que `ci.yml` se autodenuncie contra su propio `.env` generado, y ningún
 * permitido salva eso (`valor-vivo` pasa por encima de esta lista, a propósito). El test "el generador
 * de `.env` de CI nunca escribe un literal..." (`barrido-credenciales.test.ts`) fija esto — devops.
 */
export const PERMITIDOS: readonly { readonly archivo: string; readonly clave: string; readonly motivo: string }[] = [
  {
    archivo: '.github/workflows/ci.yml',
    clave: 'PGPASSWORD',
    motivo:
      'Contenedor de servicio EFIMERO del runner: nace y muere con el job, solo en loopback, y no ' +
      'lo comparte ningun entorno. Queda permitido SOLO mientras el valor no coincida con ninguno ' +
      'de un .env real — esa parte no la exime este permitido, la verifica `valoresVivos`.',
  },
  {
    archivo: '.github/workflows/ci.yml',
    clave: 'IDENTIFICADOR_PEPPER_ID',
    motivo:
      'Es el IDENTIFICADOR de version del pepper (`v1`), no el pepper. Matchea porque `PEPPER` esta ' +
      'en NOMBRE_SECRETO — el regex es mas ancho que el concepto, y eso se corrige junto con 0017. ' +
      'Un identificador de version no es una credencial; el valor secreto es IDENTIFICADOR_PEPPER.',
  },
  {
    archivo: 'packages/shared/src/seguridad/hmac-identificador.ts',
    clave: 'PEPPER_DE_EJEMPLO',
    motivo:
      'Es el valor que el codigo RECHAZA, no uno que use: existe para que arrancar con el pepper de ' +
      'ejemplo falle fuerte en vez de producir HMAC reproducibles. Sacarlo del archivo sacaria el control.',
  },
  {
    archivo: 'packages/shared/tests/forma.test.ts',
    clave: 'postgres',
    motivo: 'DSN sintetico: la fixture con la que se prueba que el redactor tapa una URL con credenciales.',
  },
  {
    archivo: 'packages/shared/tests/redactor.test.ts',
    clave: 'postgres',
    motivo: 'Idem: sin un DSN de mentira adentro, el test del redactor no tendria que redactar nada.',
  },
  {
    archivo: 'tools/barrido-fuga.test.ts',
    clave: 'postgres',
    motivo:
      'DSN sintetico: la fixture con la que se prueba que el barrido de fuga detecta un DSN. Sin un ' +
      'DSN de mentira adentro, ese test no tendria nada que encontrar.',
  },
];

const FORMA_ENV = /(^|\/)\.env(\.[^/]+)?$/;

/** `<esquema>://<usuario>:<secreto>@host` */
const URL_CON_CRED = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[A-Za-z0-9._~%-]+:[^\s@/'"`<>${}]+@/g;

/**
 * Solo **UPPER_SNAKE**, y sensible a mayúsculas: las claves de entorno se escriben así, mientras que
 * `pepperId`, `credentials` o `secretoDelLote` son identificadores de código. Sin esa distinción el
 * barrido devuelve 73 hallazgos de los cuales 66 son nombres de variables — y un barrido con 90 % de
 * ruido es un barrido que alguien apaga.
 */
/** Exportada para `tools/barrido-credenciales.test.ts` — el caso que fija que el generador de `.env`
 *  de CI nunca escribe un literal para una clave con esta forma (ver el caso "el generador de .env de
 *  CI nunca escribe un literal..."). */
export const NOMBRE_SECRETO =
  '[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|ACCESS_KEY|PRIVATE_KEY|API_KEY|PEPPER|CREDENTIAL)[A-Z0-9_]*';

const ASIGNACION = new RegExp(
  `(?:^|[\\s"'\`{,(])(${NOMBRE_SECRETO})\\s*[:=]\\s*["'\`]?([^\\s"'\`,;)}]+)`,
  'g',
);

/** Un marcador no es una credencial. Todo lo demás sí, hasta que se demuestre lo contrario. */
export function esMarcador(valor: string): boolean {
  if (!valor) return true;
  // `<poner-una-clave>`, `${VAR}`, `$VAR`, `{{ secrets.X }}`
  if (/^[<${]/.test(valor)) return true;
  // `${VAR:?mensaje}` — el idiom de docker-compose para "obligatoria, sin default". Es lo CONTRARIO
  // de una credencial horneada: el `:-default` sí lo es, y ése no entra por acá.
  if (/^\?/.test(valor)) return true;
  if (/^(x{3,}|\.{3,}|-+|_+)$/i.test(valor)) return true;
  // Un número no es una credencial. `MINIMO_LARGO_TOKEN = 12` no es un secreto.
  if (/^\d+$/.test(valor)) return true;
  if (/^(changeme|cambiar|poner|tu-|your-|placeholder|redacted|ejemplo|example)/i.test(valor)) return true;
  // Referencias de código, no literales: `process.env.X`, `config.y`, `leer('X')`, tipos de TS.
  if (/^(process\b|config\b|env\b|leer\(|requerido\(|z\.|string|number|boolean|readonly|new\b|null|undefined|true|false)/.test(valor)) return true;
  if (/^[A-Za-z_$][\w$]*\.[\w$]/.test(valor)) return true;
  return false;
}

/** Huella no reversible: longitud + sha256 corto. Nunca el valor. */
function huellaDe(valor: string): string {
  return `len=${valor.length} sha=${createHash('sha256').update(valor).digest('hex').slice(0, 8)}`;
}

export function archivosTrackeados(raiz = raizDelRepo()): readonly string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: raiz, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/**
 * Valores de los `.env*` REALES de la máquina — nunca trackeados, siempre locales.
 *
 * Se ignoran los valores muy cortos y los que son marcadores: si `APP_ENTORNO=local`, no se va a
 * denunciar cada aparición de la palabra `local` en el repo.
 */
export function valoresVivos(raiz = raizDelRepo()): ReadonlySet<string> {
  const vivos = new Set<string>();
  for (const nombre of ['.env', '.env.piloto', '.env.local', '.env.produccion']) {
    const ruta = join(raiz, nombre);
    if (!existsSync(ruta)) continue;
    for (const linea of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
      if (!linea.includes('=') || linea.trim().startsWith('#')) continue;
      const i = linea.indexOf('=');
      const clave = linea.slice(0, i).trim();
      const valor = linea.slice(i + 1).trim();
      // Solo claves de nombre secreto: el resto no son credenciales y generarían falsos positivos.
      if (!new RegExp(`^${NOMBRE_SECRETO}$`).test(clave)) continue;
      if (valor.length < 8 || esMarcador(valor)) continue;
      vivos.add(valor);
    }
  }
  return vivos;
}

export function barrer(raiz = raizDelRepo()): readonly Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  const vivos = valoresVivos(raiz);
  const permitido = (archivo: string, clave: string): boolean =>
    PERMITIDOS.some((p) => p.archivo === archivo && p.clave === clave);

  for (const archivo of archivosTrackeados(raiz)) {
    // (a) — no hace falta abrirlo: el nombre ya lo condena.
    if (FORMA_ENV.test(archivo)) {
      hallazgos.push({ archivo, forma: 'archivo-de-entorno', clave: archivo, huella: '' });
      continue;
    }

    let texto: string;
    try {
      texto = readFileSync(join(raiz, archivo), 'utf8');
    } catch {
      continue;
    }
    if (texto.includes('\0')) continue; // binario

    // Este archivo contiene, por necesidad, los patrones que busca.
    if (archivo === 'tools/barrido-credenciales.ts' || archivo === 'tools/barrido-credenciales.test.ts') continue;

    for (const m of texto.matchAll(URL_CON_CRED)) {
      const esquema = m[0].split(':')[0] ?? '';
      if (permitido(archivo, esquema)) continue;
      hallazgos.push({ archivo, forma: 'url-con-credencial', clave: esquema, huella: huellaDe(m[0]) });
    }

    for (const m of texto.matchAll(ASIGNACION)) {
      const clave = m[1] ?? '';
      const valor = m[2] ?? '';
      if (esMarcador(valor)) continue;

      // 🔴 Coincidir con un valor VIVO es violación siempre, permitido o no. Es el incidente #3.
      if (vivos.has(valor)) {
        hallazgos.push({ archivo, forma: 'valor-vivo', clave, huella: huellaDe(valor) });
        continue;
      }
      if (permitido(archivo, clave)) continue;
      hallazgos.push({ archivo, forma: 'asignacion', clave, huella: huellaDe(valor) });
    }
  }
  return hallazgos;
}

/** Negaciones de `.gitignore` que vuelven a admitir un archivo de entorno. Fue el vector exacto. */
export function negacionesDeEnv(raiz = raizDelRepo()): readonly string[] {
  const ruta = join(raiz, '.gitignore');
  if (!existsSync(ruta)) return [];
  return readFileSync(ruta, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('!') && FORMA_ENV.test(l.slice(1)));
}
