/**
 * EL GATE DE `VERSION_DEL_EXTRACTOR` — mismo mecanismo que
 * `packages/contabilidad/scripts/version-del-motor.ts`, adaptado al pipeline de extracción de
 * contraparte. Ver el docblock de `../src/version-extraccion.ts` para el POR QUÉ completo.
 *
 * ## La única diferencia real de forma con el gate del motor
 *
 * El motor hashea TODO `nucleo/` (un directorio, `readdirSync`). El extractor hashea TRES archivos
 * puntuales que viven en DOS paquetes distintos — no hay un directorio común que barrer — así que
 * acá la huella toma un **mapa nombre→ruta explícito** (`ARCHIVOS_DEL_EXTRACTOR`) en vez de un
 * `directorio`. Es la misma razón por la que el archivo que mide (`version-extraccion.ts`) no
 * necesita una lista `NO_ENTRAN`: simplemente no está en el mapa.
 *
 *     pnpm extractor:version                                      informa; sale 1 si está rojo
 *     pnpm extractor:version:aceptar                              apenda una entrada (exige bump)
 *     pnpm extractor:version:aceptar --sin-bump --motivo "..."    apenda sin bump, con la declaración
 *
 * EL GATE NO ES ESTE SCRIPT: es `tests/version-del-extractor.test.ts`, que corre en `pnpm test` y
 * por lo tanto en CI (mismo motivo que el motor: `.github/workflows/ci.yml` corre los pasos
 * SUELTOS, no `pnpm verificar`).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { VERSION_DEL_EXTRACTOR } from '../src/version-extraccion.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PAQUETE = join(AQUI, '..');
const RAIZ = join(PAQUETE, '..', '..');
const SALTO = String.fromCharCode(10);

export const RUTA_LIBRO = join(PAQUETE, 'version-del-extractor.json');

/**
 * Los TRES archivos del pipeline de extracción, con su ruta absoluta. Nombrados por su basename
 * (los tres son únicos entre sí), igual que `huellasDelMotor` nombra por basename dentro de
 * `nucleo/`.
 *
 * 🔴 Agregar un archivo acá es la forma correcta de ampliar el pipeline cubierto — nunca al revés
 * (sacar uno para "simplificar" el gate): cada entrada es la promesa de que ESE archivo participa
 * de qué candidato de contraparte produce una glosa dada.
 */
export const ARCHIVOS_DEL_EXTRACTOR: ReadonlyMap<string, string> = new Map([
  ['glosa.ts', join(PAQUETE, 'src', 'glosa.ts')],
  ['contraparte.ts', join(PAQUETE, 'src', 'contraparte.ts')],
  ['detectores-forma.ts', join(RAIZ, 'packages', 'shared', 'src', 'seguridad', 'detectores-forma.ts')],
]);

export const CODIGOS_DE_VERSION_EXTRACTOR = [
  'CODIGO_CAMBIADO_SIN_ACEPTAR',
  'ARCHIVO_NUEVO_SIN_ACEPTAR',
  'ARCHIVO_BORRADO_SIN_ACEPTAR',
  'VERSION_NO_COINCIDE_CON_EL_LIBRO',
  'LIBRO_NO_MONOTONO',
  'LIBRO_AUSENTE',
  'EXTRACTOR_VACIO',
] as const;
export type CodigoDeVersionExtractor = (typeof CODIGOS_DE_VERSION_EXTRACTOR)[number];

// -----------------------------------------------------------------------------
// Huellas
// -----------------------------------------------------------------------------

/** sha256 sobre el contenido NORMALIZADO A LF, 16 hex. Idéntico al de `version-del-motor.ts` y
 *  `migrar.ts` — mismo idiom para la misma idea ("identidad de un artefacto de código"). */
function huella(contenido: string): string {
  return createHash('sha256').update(contenido.replaceAll('\r\n', '\n'), 'utf8').digest('hex').slice(0, 16);
}

/** Parametrizable a propósito: sin poder apuntar a un mapa sintético, el rojo de este gate no se
 *  puede probar, y un control que nunca se probó rojo no existe (mismo criterio que el motor). */
export function huellasDelExtractor(
  archivos: ReadonlyMap<string, string> = ARCHIVOS_DEL_EXTRACTOR,
): ReadonlyMap<string, string> {
  const salida = new Map<string, string>();
  for (const [nombre, ruta] of [...archivos.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!existsSync(ruta)) continue;
    salida.set(nombre, huella(readFileSync(ruta, 'utf8')));
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
  | { readonly estado: 'rojo'; readonly codigo: CodigoDeVersionExtractor; readonly detalle: readonly string[] };

/** `detalle` lleva SOLO nombres de archivo del repo (N0). Nunca contenido. */
export function verificar(
  args: {
    readonly archivos?: ReadonlyMap<string, string>;
    readonly ruta?: string;
    readonly version?: number;
  } = {},
): ResultadoDeVerificacion {
  const version = args.version ?? VERSION_DEL_EXTRACTOR;
  const actuales = huellasDelExtractor(args.archivos ?? ARCHIVOS_DEL_EXTRACTOR);

  // Anti-falso-verde: si el mapa se rompe (una ruta que dejó de existir, un mapa vacío pasado por
  // error), todo lo de abajo pasa por vacío sin avisar.
  if (actuales.size < 3) {
    return { estado: 'rojo', codigo: 'EXTRACTOR_VACIO', detalle: [`archivos barridos: ${actuales.size}`] };
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
  readonly archivos?: ReadonlyMap<string, string>;
  readonly ruta?: string;
  readonly version?: number;
}): ResultadoDeAceptacion {
  if (args.motivo.trim().length < 20) return { estado: 'rechazado', codigo: 'MOTIVO_INSUFICIENTE' };

  const version = args.version ?? VERSION_DEL_EXTRACTOR;
  const ruta = args.ruta ?? RUTA_LIBRO;
  const actuales = huellasDelExtractor(args.archivos ?? ARCHIVOS_DEL_EXTRACTOR);
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
  'Trinquete de VERSION_DEL_EXTRACTOR. Cada entrada es una huella de packages/ingesta/src/glosa.ts, ' +
  'packages/ingesta/src/contraparte.ts y packages/shared/src/seguridad/detectores-forma.ts (sha256 ' +
  'normalizado a LF, 16 hex), APENDADA nunca reescrita. El gate vive en ' +
  'packages/ingesta/tests/version-del-extractor.test.ts. Se apenda con pnpm extractor:version:aceptar; ' +
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
  .endsWith('packages/ingesta/scripts/version-del-extractor.ts');

if (esEjecucionDirecta) {
  imprimir('');
  if (process.argv.includes('--aceptar')) {
    const r = aceptar({
      sinBump: process.argv.includes('--sin-bump'),
      motivo: valorDeArgumento('--motivo'),
      hoy: new Date().toISOString().slice(0, 10),
    });
    if (r.estado === 'sin_cambios') {
      imprimir(`  nada que aceptar: VERSION_DEL_EXTRACTOR=${r.version} y ningun archivo del extractor cambio.`);
      imprimir('');
      process.exit(0);
    }
    if (r.estado === 'rechazado') {
      imprimir(`  RECHAZADO [${r.codigo}]`);
      if (r.codigo === 'BUMP_FALTANTE') {
        imprimir('  El codigo del extractor cambio y VERSION_DEL_EXTRACTOR sigue igual. O bumpeas la');
        imprimir('  constante (y todo lote ya ingerido queda para reclasificar), o declaras por que este');
        imprimir('  cambio no puede alterar ningun resultado:');
        imprimir('    pnpm extractor:version:aceptar --sin-bump --motivo "..."');
      }
      if (r.codigo === 'MOTIVO_INSUFICIENTE') {
        imprimir('  El motivo va commiteado y lo lee una persona en el diff: minimo 20 caracteres.');
      }
      if (r.codigo === 'VERSION_RETROCEDE') {
        imprimir('  VERSION_DEL_EXTRACTOR es menor que la ultima entrada del libro. El trinquete no baja.');
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
    imprimir(`  version del extractor: ${r.version}, ${r.archivos} archivo(s) verificados. OK.`);
    imprimir('');
    process.exit(0);
  }
  imprimir(`  ROJO [${r.codigo}]`);
  for (const d of r.detalle) imprimir(`    - ${d}`);
  imprimir('');
  process.exit(1);
}
