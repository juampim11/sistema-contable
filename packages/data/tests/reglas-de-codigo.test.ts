/**
 * BARRIDOS DE CÓDIGO — ADR-0002 R16, R17, R26 y R30.
 *
 * Reglas que no se verifican contra la base sino contra el propio repo. Son barridos de texto, sin
 * linter: 60 líneas que hacen cumplir cuatro reglas, en vez de una dependencia más y un archivo de
 * configuración que después nadie mira.
 *
 * Si algún día entra ESLint, estas reglas se mueven allá y este archivo desaparece. Hasta entonces,
 * existen y están verificadas, que es lo que importa.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { raizDelRepo } from '../../../tools/cargar-env.ts';

const RAIZ = raizDelRepo();
const IGNORAR = new Set(['node_modules', '.git', '.pnpm', 'dist', '.next', 'coverage']);

function archivosTs(dir: string, acumulado: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORAR.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) archivosTs(ruta, acumulado);
    else if (extname(ruta) === '.ts') acumulado.push(ruta);
  }
  return acumulado;
}

/**
 * Todo el código versionable, incluidas `apps/`.
 *
 * `apps/` se agregó al crear el CLI, y no es un detalle: **el CLI es el caso más expuesto** de las reglas
 * que este archivo verifica. Se corre a mano, en una terminal donde suele estar exportado el DSN del dueño
 * del esquema, y es el lugar donde un `new Pool()` propio o un `console.log` con una glosa entran sin que
 * nadie los mire en una revisión. Un barrido que solo cubra `packages/` deja afuera justo eso.
 */
const FUENTES = archivosTs(join(RAIZ, 'packages'))
  .concat(archivosTs(join(RAIZ, 'tools')))
  .concat(archivosTs(join(RAIZ, 'apps')));

function rel(ruta: string): string {
  return relative(RAIZ, ruta).split(sep).join('/');
}

/**
 * Este mismo archivo se excluye siempre: contiene, por necesidad, los patrones que busca (los regex y
 * los comentarios que los explican). Sin esta exclusión el barrido se encuentra a sí mismo y las
 * cuatro reglas fallan siempre — pasó al correrlo la primera vez.
 */
const ESTE_ARCHIVO = 'packages/data/tests/reglas-de-codigo.test.ts';

/** Devuelve los archivos (relativos) cuyo contenido matchea el patrón, excluyendo los permitidos. */
function infractores(patron: RegExp, permitidos: readonly string[] = []): string[] {
  return FUENTES.filter((ruta) => {
    const r = rel(ruta);
    if (r === ESTE_ARCHIVO) return false;
    if (permitidos.some((p) => r === p || r.startsWith(p))) return false;
    return new RegExp(patron.source, patron.flags).test(readFileSync(ruta, 'utf8'));
  }).map(rel);
}

describe('R16 — el contexto de tenant solo se setea con set_config(..., true)', () => {
  it('no existe ningún `SET app.` ni `SET SESSION` en el código', () => {
    // Un `SET` de sesión se pega a la conexión y el próximo request —de otro estudio— lo hereda.
    expect(infractores(/\bSET\s+(SESSION\s+)?app\./i)).toEqual([]);
  });

  it('no existe ningún set_config(..., false)', () => {
    // `false` = ámbito de sesión, o sea el mismo problema con otra sintaxis.
    expect(infractores(/set_config\([^)]*,\s*false\s*\)/i)).toEqual([]);
  });
});

describe('R17 — un único punto de conexión', () => {
  it('solo `packages/data/src/db/conexion.ts` construye un Pool de pg', () => {
    expect(infractores(/new\s+Pool\s*\(/, ['packages/data/src/db/conexion.ts'])).toEqual([]);
  });

  it('solo los scripts y los tests construyen un Client de pg directo', () => {
    // Los scripts (migrar, setup-roles) y la ayuda de tests corren como dueño del esquema, fuera del
    // camino del request. Ningún módulo de `src/` fuera de db/ puede abrir su propia conexión.
    const permitidos = [
      'packages/data/scripts/',
      'packages/data/tests/ayuda.ts',
      'packages/data/src/db/conexion.ts',
    ];
    expect(infractores(/new\s+Client\s*\(/, permitidos)).toEqual([]);
  });
});

describe('R26 — un solo logger', () => {
  it('no hay console.* fuera del logger', () => {
    expect(
      infractores(/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/, [
        'packages/shared/src/observabilidad/logger.ts',
      ]),
    ).toEqual([]);
  });

  it('los scripts escriben por process.stdout, no por console (son CLI, no aplicación)', () => {
    // Distinción deliberada: un script de migración informa a una persona en una terminal; eso no es
    // logging de aplicación y no pasa por el redactor. Lo que no puede hacer es imprimir datos de un
    // cliente — y no lo hace: imprime nombres de archivo de migración y nombres de rol.
    const scripts = FUENTES.filter((r) => rel(r).startsWith('packages/data/scripts/'));
    expect(scripts.length).toBeGreaterThan(0);
  });
});

describe('R30 — nada sensible en la clave de un objeto de storage', () => {
  it('la convención de clave documentada arranca con el uuid del cliente', () => {
    // Todavía no hay módulo de almacenamiento; cuando exista, este test verifica su constructor de
    // claves. Por ahora fija la convención para que no se invente otra: cliente/<uuid>/<tipo>/<uuid>.
    const convencion = /^cliente\/[0-9a-f-]{36}\/[a-z_]+\/[0-9a-f-]{36}$/;
    expect(
      'cliente/8daa9057-8027-43ba-81cf-97470ac18b28/extracto/0f0e0d0c-0b0a-0908-0706-050403020100',
    ).toMatch(convencion);
    // Y una clave "parlante" NO cumple.
    expect('empresa-de-prueba-07-sa/banco-x-julio.pdf').not.toMatch(convencion);
  });
});

describe('cobertura del barrido', () => {
  it('el barrido efectivamente ve los archivos del repo', () => {
    // Un barrido que no encuentra archivos pasa siempre. Este test evita ese falso verde.
    expect(FUENTES.length).toBeGreaterThan(10);
    expect(FUENTES.map(rel)).toContain('packages/data/src/db/conexion.ts');
    expect(FUENTES.map(rel)).toContain('packages/shared/src/observabilidad/logger.ts');
    // Y el CLI, que es el que más fácil se saltea las reglas: si dejara de estar barrido, este test avisa.
    expect(FUENTES.map(rel)).toContain('apps/cli/src/ingestar.ts');
  });
});
// -----------------------------------------------------------------------------
describe('sintaxis que `tsc` acepta y Node no puede ejecutar', () => {
  /**
   * Este repo corre **sin paso de build**: Node ejecuta los `.ts` con type-stripping. Y el
   * type-stripping no soporta todo lo que `tsc` compila.
   *
   * Las **parameter properties** (`constructor(readonly x: T)`) son el caso: `pnpm typecheck` pasa en
   * verde y el proceso explota al importar el módulo, con `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Pasó dos
   * veces en el mismo día, en dos clases de error distintas, y las dos veces se descubrió corriendo un
   * script — no en el typecheck, que es donde uno lo busca.
   *
   * Es exactamente el tipo de regla que tiene que ser mecánica: nadie se acuerda de una restricción del
   * runtime mientras escribe una clase.
   */
  it('ninguna clase usa parameter properties en el constructor', () => {
    const infractores: string[] = [];

    for (const ruta of FUENTES) {
      const contenido = readFileSync(ruta, 'utf8');
      // Un `constructor(` seguido, dentro de sus paréntesis, por `readonly`/`public`/`private`/`protected`.
      const re = /constructor\s*\(([^)]*)\)/gs;
      for (const m of contenido.matchAll(re)) {
        if (/(?:readonly|public|private|protected)\s+\w+\s*[?:]/.test(m[1] ?? '')) {
          infractores.push(rel(ruta));
        }
      }
    }

    expect(
      [...new Set(infractores)],
      'parameter properties: `tsc` las acepta y Node falla al ejecutar. Declará el campo y asignalo ' +
        'en el cuerpo del constructor.',
    ).toEqual([]);
  });

  /**
   * Los `enum` y los `namespace` tienen el mismo problema y por el mismo motivo: no se pueden borrar con
   * solo quitar los tipos, porque generan código. Se prohíben por adelantado.
   */
  it('nadie usa `enum` ni `namespace`', () => {
    const infractores = FUENTES.filter((ruta) => {
      if (rel(ruta) === ESTE_ARCHIVO) return false;
      return /^\s*(?:export\s+)?(?:const\s+)?enum\s+\w+|^\s*(?:export\s+)?namespace\s+\w+/m.test(
        readFileSync(ruta, 'utf8'),
      );
    });
    expect(infractores.map(rel)).toEqual([]);
  });
});
// -----------------------------------------------------------------------------
describe('las dependencias entre paquetes no pueden hacer ciclo', () => {
  /**
   * `packages/data` no puede importar `packages/ingesta`.
   *
   * Pasó: el script de alta de cuenta necesitaba leer el PDF —dominio de `ingesta`— y se escribió en
   * `packages/data/scripts`. Eso creó `data → ingesta → data`. **El typecheck lo aceptó** y la dependencia
   * circular quedó ahí igual, lista para dar un `undefined` al importar en el orden equivocado.
   *
   * La dirección correcta es una sola: `shared` ← `data` ← `ingesta`/`almacenamiento` ← `apps`. Un comando
   * que necesita las dos capas va en `apps/`, que es la que puede depender de todo.
   */
  it('`packages/data` no importa `packages/ingesta` ni `packages/almacenamiento`', () => {
    const deData = FUENTES.filter((r) => rel(r).startsWith('packages/data/'));
    expect(deData.length, 'no se está barriendo packages/data').toBeGreaterThan(5);

    const infractores = deData.filter((ruta) => {
      if (rel(ruta).includes('/tests/')) return false; // un test puede armar el escenario completo
      const c = readFileSync(ruta, 'utf8');
      return /@sistema-contable\/(?:ingesta|almacenamiento)/.test(c);
    });

    expect(
      infractores.map(rel),
      'ciclo de paquetes: data no puede depender de ingesta ni de almacenamiento. Si el comando necesita ' +
        'las dos capas, va en apps/.',
    ).toEqual([]);
  });

  it('`packages/shared` no importa ningún otro paquete del monorepo', () => {
    const deShared = FUENTES.filter(
      (r) => rel(r).startsWith('packages/shared/src/'),
    );
    const infractores = deShared.filter((ruta) =>
      /@sistema-contable\/(?:data|ingesta|almacenamiento|cli)/.test(readFileSync(ruta, 'utf8')),
    );
    // `shared` es la base: si depende de algo, todo el grafo se vuelve circular.
    expect(infractores.map(rel)).toEqual([]);
  });
});
// -----------------------------------------------------------------------------
describe('aislamiento entre bancos: un adaptador no puede romper a otro', () => {
  /**
   * La decisión de arquitectura: **un proceso de extracción por banco.** Si el banco X cambia el formato de
   * sus PDF, se toca X y nada más. Si aparece un banco nuevo, es un archivo nuevo.
   *
   * Estas dos reglas son lo que hace que eso sea cierto en el código y no solo en el documento.
   */
  it('ningún adaptador importa a otro adaptador', () => {
    const adaptadores = FUENTES.filter(
      (r) => rel(r).includes('/adaptadores/') && !rel(r).endsWith('toolkit.ts') &&
             !rel(r).endsWith('registro.ts') && !rel(r).endsWith('contrato.ts'),
    );

    const infractores: string[] = [];
    for (const ruta of adaptadores) {
      const propio = rel(ruta).split('/').at(-1)?.replace('.ts', '') ?? '';
      const contenido = readFileSync(ruta, 'utf8');
      for (const otro of adaptadores) {
        const nombre = rel(otro).split('/').at(-1)?.replace('.ts', '') ?? '';
        if (nombre === propio) continue;
        if (new RegExp(String.raw`from ['"]\./${nombre}\.ts['"]`).test(contenido)) {
          infractores.push(`${rel(ruta)} importa ${nombre}`);
        }
      }
    }

    expect(
      infractores,
      'un adaptador que importa a otro acopla dos bancos: un cambio de formato en uno rompe al otro',
    ).toEqual([]);
  });

  /**
   * Un adaptador no toca la base ni el storage: recibe lo que leyó otro y devuelve lo que entendió. Si
   * pudiera consultar, un banco podría empezar a depender del estado y su comportamiento dejaría de ser
   * reproducible desde el archivo — que es lo que hace que un fixture sirva de algo.
   */
  it('ningún adaptador importa `packages/data` ni `packages/almacenamiento`', () => {
    const infractores = FUENTES.filter((r) => {
      if (!rel(r).includes('/adaptadores/')) return false;
      return /@sistema-contable\/(?:data|almacenamiento)/.test(readFileSync(r, 'utf8'));
    });
    expect(infractores.map(rel)).toEqual([]);
  });

  /**
   * A1 (`docs/diseno/10-deuda-declarada.md` §2.4): el contrato compartido vive en `registro.ts`
   * (`EntradaDeAdaptador`/`SalidaDeAdaptador`). Un adaptador puede usarlo directo (Santander), aliasarlo
   * sin agregar nada (Galicia) o estrecharlo con una intersection cuando promete más que el mínimo
   * (Macro) — las tres son fachadas del contrato. Lo que no puede es declarar un objeto `Entrada*`/
   * `Salida*` PROPIO, paralelo al contrato: eso es exactamente lo que tenían Galicia y Macro antes de
   * A1, y lo que un quinto banco copia-pega si nadie lo impide.
   *
   * La regla mira el LADO DERECHO de la declaración, no el nombre: Galicia y Macro siguen declarando
   * `SalidaGalicia`/`SalidaMacro` a propósito (son la fachada), así que un chequeo por nombre se
   * rompería contra el propio diseño de A1.
   */
  it('todo Entrada*/Salida* fuera de registro.ts es fachada de XxxDeAdaptador, no un tipo propio', () => {
    const adaptadores = FUENTES.filter(
      (r) => rel(r).includes('/adaptadores/') && !rel(r).endsWith('registro.ts'),
    );
    const infractores: string[] = [];
    const declaracion = /export type (Entrada|Salida)\w*\s*=\s*([^;]+);/g;
    for (const ruta of adaptadores) {
      const contenido = readFileSync(ruta, 'utf8');
      for (const m of contenido.matchAll(declaracion)) {
        const derecha = (m[2] ?? '').trim();
        if (!/^(Entrada|Salida)DeAdaptador\b/.test(derecha)) {
          infractores.push(`${rel(ruta)}: ${m[0]}`);
        }
      }
    }
    expect(
      infractores,
      'un Entrada*/Salida* fuera de registro.ts solo puede ser alias o intersection de XxxDeAdaptador ' +
        '— un objeto propio es el patrón que A1 cerró',
    ).toEqual([]);
  });
});



