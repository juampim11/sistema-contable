/**
 * EL GATE DE `VERSION_DEL_MOTOR` — el único contador manual del versionado, hecho verificable.
 *
 * `digestDeBanco()` cubre los DATOS (léxico + catálogo) y no puede envejecer: se calcula. Este
 * archivo cubre el CÓDIGO, que es lo único que no se deriva de nada — y cuyo olvido falla ABIERTO y
 * EN SILENCIO (ver `src/nucleo/version.ts`, "Por qué un digest calculado"): si nadie bumpea,
 * reprocesar es no-op y el reconocimiento viejo —ahora incorrecto— queda protegido ACTIVAMENTE por
 * la regla de idempotencia de `05` §5.2. Persistir sobre una idempotencia que puede fallar en
 * silencio no tiene sentido, y por eso esto entra junto con `0014` y no después.
 *
 * ## 🔴 Se hashea POR EXCLUSIÓN, nunca por inclusión
 *
 * Mismo argumento que `CLAVES_DE_EVIDENCIA` en `version.ts`: con una lista de nombres, un archivo
 * nuevo de `nucleo/` nace OLVIDADO — que es el fail-open que este gate existe para cerrar. La lista
 * de cuatro que decía el docblock original ya se quedaba corta contra `contrapartida.ts`, cuya regla
 * de uniformidad de pepper YA cambió una vez y decide la `clase` y el `tipo` de la fila que `0014`
 * persiste. Entra todo `src/nucleo/*.ts` salvo las dos exclusiones de `NO_ENTRAN`, cada una con su
 * motivo escrito.
 *
 * ## 🔴 La aceptación es un TRINQUETE, no una regeneración
 *
 * Si aceptar fuera "escribir las huellas de ahora", entonces tocar `matcher.ts` + aceptar = verde
 * sin bump, o sea el agujero original con una ceremonia encima. Reglas:
 *
 *   - la huella cambió y `VERSION_DEL_MOTOR` subió  → se acepta y se apenda la entrada
 *   - la huella cambió y la versión NO subió        → SE RECHAZA, salvo `--sin-bump --motivo "..."`
 *   - la versión retrocede                          → se rechaza siempre
 *
 * `--sin-bump` no es una puerta trasera: es la salida CORRECTA para un cambio que demostrablemente
 * no altera ningún resultado (un docblock, un rename). Bumpear por un comentario invalidaría el
 * histórico de todos los clientes de todos los bancos — el "peor resultado posible" que `version.ts`
 * describe. El motivo queda commiteado y viaja al diff del PR, donde lo mira una persona: uno que
 * dice "typo en el comentario" pasa la revisión; uno que dice "simplifiqué el matcher" la frena.
 *
 * Por eso el artefacto es un LIBRO APPEND-ONLY de entradas y no una foto: un retroceso de versión o
 * el borrado de una entrada se ven en el diff.
 *
 * ## Por qué la huella va sobre los bytes crudos y no sobre el código sin comentarios
 *
 * Sacar los comentarios necesita un parser, o una regex frágil que puede fallar en la dirección
 * MALA (no mover la huella cuando el código sí cambió). Un control que falla abierto es peor que uno
 * ruidoso: se hashea el archivo entero y los falsos positivos los absorbe `--sin-bump`.
 *
 * 🔴 Y se normaliza a LF, que no es estética. Mismo motivo que `packages/data/scripts/migrar.ts`:
 * con `core.autocrlf` (default de Git for Windows) el checkout reescribe a CRLF y el sha256 cambia
 * SIN QUE NADIE HAYA EDITADO NADA. Un control que se dispara cuando no pasó nada es un control que
 * alguien termina desactivando.
 *
 *     pnpm motor:version                                      informa; sale 1 si está rojo
 *     pnpm motor:version:aceptar                              apenda una entrada (exige bump)
 *     pnpm motor:version:aceptar --sin-bump --motivo "..."    apenda sin bump, con la declaración
 *
 * EL GATE NO ES ESTE SCRIPT: es `tests/version-del-motor.test.ts`, que corre en `pnpm test` y por lo
 * tanto en CI. `.github/workflows/ci.yml` corre los pasos SUELTOS, no `pnpm verificar`, así que un
 * paso nuevo en el script compuesto no correría en CI — y un gate que existe en local y no en CI es
 * peor que no tenerlo, porque se cree que está. Este archivo es solo la aceptación.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { VERSION_DEL_MOTOR } from '../src/nucleo/version.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PAQUETE = join(AQUI, '..');
const NUCLEO = join(PAQUETE, 'src', 'nucleo');
const SALTO = String.fromCharCode(10);

export const RUTA_LIBRO = join(PAQUETE, 'version-del-motor.json');

/**
 * Las DOS exclusiones, cada una con su motivo. Sacar un archivo de acá es barato; agregarlo es CARO:
 * cada entrada es la promesa de que ese archivo no puede alterar un resultado persistido sin que el
 * cambio se detecte por otra vía.
 */
const NO_ENTRAN: ReadonlyMap<string, string> = new Map([
  [
    'catalogo.ts',
    'DATOS: ya entra a digestDeBanco POR BANCO. Incluirlo acá obligaría a un bump global —que ' +
      'invalida Galicia— por apendar una fila de Santander, o sea exactamente la invalidación ' +
      'cruzada que el digest por banco existe para evitar.',
  ],
  [
    'version.ts',
    'Es EL QUE MIDE: su único efecto sobre el resultado es el digest mismo, que se recalcula solo ' +
      '(tocar canonizar o CLAVES_DE_EVIDENCIA ya mueve digestDeBanco). Además contiene la ' +
      'constante, así que incluirlo haría que todo bump moviera su propia huella.',
  ],
]);

export const CODIGOS_DE_VERSION = [
  'CODIGO_CAMBIADO_SIN_ACEPTAR',
  'ARCHIVO_NUEVO_SIN_ACEPTAR',
  'ARCHIVO_BORRADO_SIN_ACEPTAR',
  'VERSION_NO_COINCIDE_CON_EL_LIBRO',
  'LIBRO_NO_MONOTONO',
  'LIBRO_AUSENTE',
  'NUCLEO_VACIO',
] as const;
export type CodigoDeVersion = (typeof CODIGOS_DE_VERSION)[number];

// -----------------------------------------------------------------------------
// Huellas
// -----------------------------------------------------------------------------

/** sha256 sobre el contenido NORMALIZADO A LF, 16 hex. Idéntico al de `migrar.ts` — mismo idiom para
 *  la misma idea ("identidad de un artefacto de código"). */
function huella(contenido: string): string {
  return createHash('sha256').update(contenido.replaceAll('\r\n', '\n'), 'utf8').digest('hex').slice(0, 16);
}

/** Parametrizable a propósito: sin poder apuntar a un `nucleo/` sintético, el rojo de este gate no se
 *  puede probar, y un control que nunca se probó rojo no existe. Lo usa el test. */
export function huellasDelMotor(directorio: string = NUCLEO): ReadonlyMap<string, string> {
  const salida = new Map<string, string>();
  for (const nombre of readdirSync(directorio).sort()) {
    if (!nombre.endsWith('.ts')) continue;
    if (NO_ENTRAN.has(nombre)) continue;
    salida.set(nombre, huella(readFileSync(join(directorio, nombre), 'utf8')));
  }
  return salida;
}

// -----------------------------------------------------------------------------
// El artefacto commiteado
// -----------------------------------------------------------------------------

const esquemaEntrada = z.object({
  version: z.number().int().positive(),
  aceptada_en: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bump: z.boolean(),
  motivo: z.string().min(20).max(500),
  archivos: z.record(z.string().regex(/^[a-z0-9._-]+\.ts$/), z.string().regex(/^[0-9a-f]{16}$/)),
});

const esquemaLibro = z.object({
  algoritmo: z.literal('sha256-lf-16'),
  entradas: z.array(esquemaEntrada).min(1),
});

export type EntradaDelLibro = z.infer<typeof esquemaEntrada>;
export type LibroDeVersiones = z.infer<typeof esquemaLibro>;

/** Zod en el límite (CLAUDE.md §2): el artefacto es un archivo que entra al proceso. Un libro
 *  corrupto tiene que fallar acá con un código, no producir un `undefined` tres pasos después. */
export function leerLibro(ruta: string = RUTA_LIBRO): LibroDeVersiones | undefined {
  if (!existsSync(ruta)) return undefined;
  return esquemaLibro.parse(JSON.parse(readFileSync(ruta, 'utf8')));
}

// -----------------------------------------------------------------------------
// El gate
// -----------------------------------------------------------------------------

export type ResultadoDeVerificacion =
  | { readonly estado: 'ok'; readonly version: number; readonly archivos: number }
  | { readonly estado: 'rojo'; readonly codigo: CodigoDeVersion; readonly detalle: readonly string[] };

/** `detalle` lleva SOLO nombres de archivo del repo (N0). Nunca contenido. */
export function verificar(
  args: { readonly directorio?: string; readonly ruta?: string; readonly version?: number } = {},
): ResultadoDeVerificacion {
  const version = args.version ?? VERSION_DEL_MOTOR;
  const actuales = huellasDelMotor(args.directorio ?? NUCLEO);

  // Anti-falso-verde: si el barrido se rompe, todo lo de abajo pasa por vacío sin avisar.
  if (actuales.size < 5) {
    return { estado: 'rojo', codigo: 'NUCLEO_VACIO', detalle: [`archivos barridos: ${actuales.size}`] };
  }

  const libro = leerLibro(args.ruta ?? RUTA_LIBRO);
  if (!libro) return { estado: 'rojo', codigo: 'LIBRO_AUSENTE', detalle: [] };

  for (let i = 1; i < libro.entradas.length; i += 1) {
    const previa = libro.entradas[i - 1];
    const actual = libro.entradas[i];
    if (previa && actual && actual.version < previa.version) {
      return { estado: 'rojo', codigo: 'LIBRO_NO_MONOTONO', detalle: [`entrada ${i}`] };
    }
  }

  const ultima = libro.entradas.at(-1);
  if (!ultima) return { estado: 'rojo', codigo: 'LIBRO_AUSENTE', detalle: [] };

  if (ultima.version !== version) {
    return {
      estado: 'rojo',
      codigo: 'VERSION_NO_COINCIDE_CON_EL_LIBRO',
      detalle: [`constante=${version}`, `libro=${ultima.version}`],
    };
  }

  const nuevos = [...actuales.keys()].filter((n) => ultima.archivos[n] === undefined);
  if (nuevos.length > 0) return { estado: 'rojo', codigo: 'ARCHIVO_NUEVO_SIN_ACEPTAR', detalle: nuevos };

  const borrados = Object.keys(ultima.archivos).filter((n) => !actuales.has(n));
  if (borrados.length > 0) return { estado: 'rojo', codigo: 'ARCHIVO_BORRADO_SIN_ACEPTAR', detalle: borrados };

  const cambiados = [...actuales].filter(([n, h]) => ultima.archivos[n] !== h).map(([n]) => n);
  if (cambiados.length > 0) return { estado: 'rojo', codigo: 'CODIGO_CAMBIADO_SIN_ACEPTAR', detalle: cambiados };

  return { estado: 'ok', version, archivos: actuales.size };
}

// -----------------------------------------------------------------------------
// La aceptación — el trinquete
// -----------------------------------------------------------------------------

export type ResultadoDeAceptacion =
  | { readonly estado: 'sin_cambios'; readonly version: number }
  | {
      readonly estado: 'aceptado';
      readonly version: number;
      readonly bump: boolean;
      readonly cambiados: readonly string[];
    }
  | { readonly estado: 'rechazado'; readonly codigo: 'BUMP_FALTANTE' | 'VERSION_RETROCEDE' | 'MOTIVO_INSUFICIENTE' };

export function aceptar(args: {
  readonly sinBump: boolean;
  readonly motivo: string;
  readonly hoy: string;
  readonly directorio?: string;
  readonly ruta?: string;
  readonly version?: number;
}): ResultadoDeAceptacion {
  if (args.motivo.trim().length < 20) return { estado: 'rechazado', codigo: 'MOTIVO_INSUFICIENTE' };

  const version = args.version ?? VERSION_DEL_MOTOR;
  const ruta = args.ruta ?? RUTA_LIBRO;
  const actuales = huellasDelMotor(args.directorio ?? NUCLEO);
  const libro = leerLibro(ruta);
  const ultima = libro?.entradas.at(-1);

  const archivos: Record<string, string> = {};
  for (const nombre of [...actuales.keys()].sort()) archivos[nombre] = actuales.get(nombre) as string;

  // Arranque en frío: no hay libro todavía. La primera entrada es la línea de base.
  if (!ultima) {
    escribir(ruta, { algoritmo: 'sha256-lf-16', entradas: [] }, {
      version,
      aceptada_en: args.hoy,
      bump: false,
      motivo: args.motivo,
      archivos,
    });
    return { estado: 'aceptado', version, bump: false, cambiados: [...actuales.keys()] };
  }

  if (version < ultima.version) return { estado: 'rechazado', codigo: 'VERSION_RETROCEDE' };

  const cambiados = [...actuales].filter(([n, h]) => ultima.archivos[n] !== h).map(([n]) => n);
  const borrados = Object.keys(ultima.archivos).filter((n) => !actuales.has(n));
  const hayDiff = cambiados.length > 0 || borrados.length > 0;

  if (!hayDiff && version === ultima.version) return { estado: 'sin_cambios', version };

  // 🔴 EL TRINQUETE. Sin esto, aceptar sería la forma corta de poner el gate en verde sin bumpear.
  const bump = version > ultima.version;
  if (!bump && !args.sinBump) return { estado: 'rechazado', codigo: 'BUMP_FALTANTE' };

  escribir(ruta, libro ?? { algoritmo: 'sha256-lf-16', entradas: [] }, {
    version,
    aceptada_en: args.hoy,
    bump,
    motivo: args.motivo,
    archivos,
  });
  return { estado: 'aceptado', version, bump, cambiados: [...cambiados, ...borrados] };
}

const COMENTARIO =
  'Trinquete de VERSION_DEL_MOTOR. Cada entrada es una huella de packages/contabilidad/src/nucleo/' +
  '*.ts (sha256 normalizado a LF, 16 hex), APENDADA nunca reescrita. El gate vive en ' +
  'packages/contabilidad/tests/version-del-motor.test.ts. Se apenda con pnpm motor:version:aceptar; ' +
  'una entrada con "bump": false declara que ese cambio de codigo NO puede alterar ningun resultado ' +
  'persistido, y su "motivo" es lo que revisa una persona en el diff del PR.';

function escribir(ruta: string, libro: LibroDeVersiones, entrada: EntradaDelLibro): void {
  const contenido = {
    _comentario: COMENTARIO,
    algoritmo: libro.algoritmo,
    entradas: [...libro.entradas, entrada],
  };
  writeFileSync(ruta, JSON.stringify(contenido, null, 2) + SALTO, 'utf8');
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function imprimir(texto: string): void {
  process.stdout.write(texto + SALTO);
}

function valorDeArgumento(bandera: string): string {
  const i = process.argv.indexOf(bandera);
  return i === -1 ? '' : (process.argv[i + 1] ?? '');
}

const esEjecucionDirecta = process.argv[1]
  ?.replaceAll('\\', '/')
  .endsWith('packages/contabilidad/scripts/version-del-motor.ts');

if (esEjecucionDirecta) {
  imprimir('');
  if (process.argv.includes('--aceptar')) {
    const r = aceptar({
      sinBump: process.argv.includes('--sin-bump'),
      motivo: valorDeArgumento('--motivo'),
      hoy: new Date().toISOString().slice(0, 10),
    });
    if (r.estado === 'sin_cambios') {
      imprimir(`  nada que aceptar: VERSION_DEL_MOTOR=${r.version} y ningun archivo de nucleo/ cambio.`);
      imprimir('');
      process.exit(0);
    }
    if (r.estado === 'rechazado') {
      imprimir(`  RECHAZADO [${r.codigo}]`);
      if (r.codigo === 'BUMP_FALTANTE') {
        imprimir('  El codigo de nucleo/ cambio y VERSION_DEL_MOTOR sigue igual. O bumpeas la constante');
        imprimir('  (y todo reconocimiento persistido queda para recalcular, 05 5.2), o declaras por que');
        imprimir('  este cambio no puede alterar ningun resultado:');
        imprimir('    pnpm motor:version:aceptar --sin-bump --motivo "..."');
      }
      if (r.codigo === 'MOTIVO_INSUFICIENTE') {
        imprimir('  El motivo va commiteado y lo lee una persona en el diff: minimo 20 caracteres.');
      }
      if (r.codigo === 'VERSION_RETROCEDE') {
        imprimir('  VERSION_DEL_MOTOR es menor que la ultima entrada del libro. El trinquete no baja.');
      }
      imprimir('');
      process.exit(1);
    }
    imprimir(`  aceptado: version ${r.version} (bump=${r.bump}), ${r.cambiados.length} archivo(s).`);
    imprimir('');
    process.exit(0);
  }

  const r = verificar();
  if (r.estado === 'ok') {
    imprimir(`  version del motor: ${r.version}, ${r.archivos} archivo(s) de nucleo/ verificados. OK.`);
    imprimir('');
    process.exit(0);
  }
  imprimir(`  ROJO [${r.codigo}]`);
  for (const d of r.detalle) imprimir(`    - ${d}`);
  imprimir('');
  process.exit(1);
}
