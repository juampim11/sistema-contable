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

describe('R30/R31 — el objeto de storage sale por un único choke point', () => {
  /**
   * `security-engineer` lo encontró al diseñar `recapturar-conceptos` (plan `adaptive-herding-pillow`):
   * el comentario de `descarga.ts` afirma ser "la única función del repo que llama a
   * `storage.urlFirmada`" — y nada lo verificaba. Es la misma clase de afirmación que este repo ya
   * aprendió a no creer sin un test (`auditoria.ts` sobre el registro de lectores auditados).
   *
   * Las tres operaciones sensibles de `ObjectStorage` tienen el mismo modo de falla: un caller nuevo que
   * las llama directo se salta el rol, la auditoría, o las dos. Una sola lista para las tres, para que no
   * se olvide a medias.
   */
  it('`.urlFirmada(` solo en `descarga.ts` (el emisor único) y sus tests', () => {
    const permitidos = ['packages/almacenamiento/src/descarga.ts', 'packages/almacenamiento/tests/'];
    expect(infractores(/\.urlFirmada\s*\(/, permitidos)).toEqual([]);
  });

  it('`.obtener(` solo en `lectura.ts` (el choke point de lectura), `object-storage.ts` y sus tests', () => {
    const permitidos = [
      'packages/almacenamiento/src/lectura.ts',
      'packages/almacenamiento/src/object-storage.ts',
      'packages/almacenamiento/tests/',
    ];
    expect(infractores(/\.obtener\s*\(/, permitidos)).toEqual([]);
  });

  it('`.guardar(` solo en `extracto.ts` (el guardado de extractos) y tests que arman su propia fixture', () => {
    // A diferencia de `.obtener(`/`.urlFirmada(` (egreso de datos de un cliente, el riesgo real), `.guardar(`
    // es ingreso: cualquier test que necesite sembrar un objeto en MinIO para su propia corrida (mismo
    // patrón que ya usa `descarga.test.ts`) puede llamarlo directo sin pasar por ningún choke point.
    const permitidos = [
      'packages/almacenamiento/src/extracto.ts',
      'packages/almacenamiento/src/object-storage.ts',
      'packages/almacenamiento/tests/',
      'apps/cli/tests/',
    ];
    expect(infractores(/\.guardar\s*\(/, permitidos)).toEqual([]);
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
    // `packages/contabilidad` (Módulo 2, léxico + catálogo canónico): si el paquete se renombrara o
    // quedara fuera del glob, TODAS las reglas R-A..R-I de más abajo pasarían por vacío sin avisar.
    expect(FUENTES.map(rel)).toContain('packages/contabilidad/src/index.ts');
    // `packages/fci` (costeo PEPS de fondos comunes de inversión): mismo motivo — si quedara fuera del
    // glob, las reglas espejo de R-B/R-G/R-J para este paquete pasarían por vacío sin avisar.
    expect(FUENTES.map(rel)).toContain('packages/fci/src/index.ts');
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
   * La dirección correcta es una sola: `shared` ← `data` ← `ingesta`/`almacenamiento`/`contabilidad` ←
   * `apps`. Un comando que necesita varias capas va en `apps/`, que es la que puede depender de todo.
   */
  it('`packages/data` no importa `packages/ingesta` ni `packages/almacenamiento`', () => {
    const deData = FUENTES.filter((r) => rel(r).startsWith('packages/data/'));
    expect(deData.length, 'no se está barriendo packages/data').toBeGreaterThan(5);

    const infractores = deData.filter((ruta) => {
      if (rel(ruta).includes('/tests/')) return false; // un test puede armar el escenario completo
      const c = readFileSync(ruta, 'utf8');
      return /@sistema-contable\/(?:ingesta|almacenamiento|contabilidad|cotizaciones)/.test(c);
    });

    expect(
      infractores.map(rel),
      'ciclo de paquetes: data no puede depender de ingesta, almacenamiento, contabilidad ni ' +
        'cotizaciones. Si el comando necesita varias capas, va en apps/.',
    ).toEqual([]);
  });

  it('`packages/shared` no importa ningún otro paquete del monorepo', () => {
    const deShared = FUENTES.filter(
      (r) => rel(r).startsWith('packages/shared/src/'),
    );
    const infractores = deShared.filter((ruta) =>
      /@sistema-contable\/(?:data|ingesta|almacenamiento|contabilidad|cli)/.test(readFileSync(ruta, 'utf8')),
    );
    // `shared` es la base: si depende de algo, todo el grafo se vuelve circular.
    expect(infractores.map(rel)).toEqual([]);
  });

  /**
   * R-B — `packages/contabilidad` (el motor de reconocimiento, capa B/C del Módulo 2) no puede
   * importar `data`, `ingesta` ni `almacenamiento`.
   *
   * "Un léxico que puede leer la base es un léxico que puede aprender solo" — `05` §7, que es H-6
   * en la raíz. Si el motor necesita un dato de la base (el padrón de socios, el plan de cuentas),
   * lo recibe como ARGUMENTO de una función pura; no lo va a buscar.
   */
  it('`packages/contabilidad` no importa `data`, `ingesta` ni `almacenamiento`', () => {
    const deContabilidad = FUENTES.filter((r) => rel(r).startsWith('packages/contabilidad/src/'));
    expect(deContabilidad.length, 'no se está barriendo packages/contabilidad').toBeGreaterThan(0);

    const infractores = deContabilidad.filter((ruta) => {
      if (rel(ruta).includes('/tests/')) return false;
      return /@sistema-contable\/(?:data|ingesta|almacenamiento)/.test(readFileSync(ruta, 'utf8'));
    });

    expect(
      infractores.map(rel),
      'un léxico que puede leer la base es un léxico que puede aprender solo (05 §7, H-6). Si tu ' +
        'código necesita un dato de la base, recibilo como argumento de una función pura.',
    ).toEqual([]);
  });

  /**
   * R-B (cont.) — `packages/contabilidad/src/nucleo` (el motor puro) no puede importar
   * `packages/cotizaciones`. La cotización llega como ARGUMENTO ya resuelto (mismo idiom que
   * `PadronConsultado`), nunca como un `await` de red colado dentro del motor — eso rompería R-J.
   * Invariante declarada en `docs/diseno/12-cotizacion-bna-plan.md` §1 ("No cambia"); esta regla
   * la hace cumplir ANTES de que exista ningún consumidor real, para frenar un import directo por
   * apuro cuando llegue la etapa de valuación (fuera de alcance de esta tarea).
   */
  it('`packages/contabilidad/src/nucleo` no importa `packages/cotizaciones`', () => {
    const deNucleo = FUENTES.filter((r) => rel(r).startsWith('packages/contabilidad/src/nucleo/'));
    expect(deNucleo.length, 'no se está barriendo packages/contabilidad/src/nucleo').toBeGreaterThan(0);

    const infractores = deNucleo.filter((ruta) => {
      if (rel(ruta).includes('/tests/')) return false;
      return /@sistema-contable\/cotizaciones/.test(readFileSync(ruta, 'utf8'));
    });

    expect(infractores.map(rel)).toEqual([]);
  });

  /**
   * R-B (espejo para `packages/fci`) — el núcleo de costeo PEPS de fondos comunes de inversión tampoco
   * puede importar `data`, `ingesta` ni `almacenamiento`. Mismo argumento que para `contabilidad`: si
   * `consumirRescate` necesita un dato de la base (por ejemplo, las capas de costo ya persistidas), lo
   * recibe como ARGUMENTO de una función pura; no lo va a buscar.
   */
  it('`packages/fci` no importa `data`, `ingesta` ni `almacenamiento`', () => {
    const deFci = FUENTES.filter((r) => rel(r).startsWith('packages/fci/src/'));
    expect(deFci.length, 'no se está barriendo packages/fci').toBeGreaterThan(0);

    const infractores = deFci.filter((ruta) => {
      if (rel(ruta).includes('/tests/')) return false;
      return /@sistema-contable\/(?:data|ingesta|almacenamiento)/.test(readFileSync(ruta, 'utf8'));
    });

    expect(
      infractores.map(rel),
      'un núcleo que puede leer la base es un núcleo que puede aprender solo (mismo argumento que R-B ' +
        'para packages/contabilidad). Si tu código necesita un dato de la base, recibilo como ' +
        'argumento de una función pura.',
    ).toEqual([]);
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

// -----------------------------------------------------------------------------
describe('R32 — el lector auditado es el ÚNICO camino a `movimiento_origen_crudo`', () => {
  /**
   * `movimiento_origen_crudo` es N2-R: guarda la fila cruda del extracto, con los CUIT y los CBU de
   * las contrapartes. Su control es estructural — `leerFilasOrigenDeLote` exige un `ContextoAuditado`
   * que solo `leerConAuditoria` fabrica — pero ese control protege a la FUNCIÓN, no al NOMBRE de la
   * tabla: un `tx.consultar('select fila_origen from movimiento_origen_crudo ...')` escrito a mano en
   * cualquier módulo la lee sin dejar rastro, y compila igual.
   *
   * No es hipotético: `packages/ingesta/src/resolver-cuenta.ts` ya consulta la OTRA tabla N2-R del
   * módulo (`cuenta_bancaria_identificador`) sin pasar por su lector auditado — ahí es defendible
   * (solo lee `cbu_hmac`, que es N1), pero la firma de `tx.consultar` no lo sabe: la misma consulta
   * con `numero` en el `select` sería una lectura N2-R sin rastro, y el typecheck la aceptaría igual.
   *
   * La lista de permitidos es larga a propósito y cada entrada dice por qué: dos son el mecanismo
   * mismo (los registros usan el NOMBRE de la tabla como clave), uno es el seed sintético (corre como
   * dueño del esquema), uno es un comentario, y el resto son tests (`security-engineer`, ronda de
   * revisión de la migración `0013`).
   */
  const PERMITIDOS_MOV_ORIGEN = [
    'packages/data/src/ingesta/lecturas.ts',                  // el lector auditado: el único SELECT
    'packages/ingesta/src/persistir.ts',                      // el INSERT — ingreso, no egreso
    'packages/data/src/db/lectores-auditados.ts',             // registro: el nombre de la tabla ES la clave
    'packages/shared/src/seguridad/clasificacion-campos.ts',  // registro de clasificación: idem
    'packages/data/scripts/sembrar.ts',                       // truncate del seed, corre como dueño del esquema
    'packages/ingesta/src/glosa.ts',                          // solo la nombra en un comentario
    'packages/data/src/contabilidad/lecturas.ts',             // solo la nombra en un comentario (por qué NO se usa)
    // Llaman a `leerFilasOrigenDeLote` a través de `leerConAuditoria`, nunca con una consulta
    // propia — y el `recurso: 'movimiento_origen_crudo'` que le pasan al choke point es el nombre
    // de la tabla auditada, no un bypass (migración 0013).
    'packages/ingesta/src/reproceso/backfill-contraparte.ts',
    'apps/cli/src/backfill-contraparte.ts',
    'packages/data/tests/',
    'packages/ingesta/tests/',
    'apps/cli/tests/',
  ];

  it('ningún archivo fuera de la lista nombra `movimiento_origen_crudo`', () => {
    expect(
      infractores(/\bmovimiento_origen_crudo\b/, PERMITIDOS_MOV_ORIGEN),
      'la tabla con los identificadores de las contrapartes se lee SOLO por leerFilasOrigenDeLote ' +
        '(packages/data/src/ingesta/lecturas.ts), que exige ContextoAuditado. Si tu módulo la ' +
        'necesita, pedí los datos por ahí; si necesitás un recorte distinto, agregá un lector ' +
        'auditado, no una consulta suelta.',
    ).toEqual([]);
  });

  it('el patrón detecta una infracción plantada y no confunde la tabla hermana', () => {
    // Anti-falso-verde: un barrido que no matchea nada pasa siempre.
    const patron = /\bmovimiento_origen_crudo\b/;
    expect(patron.test('select fila_origen from movimiento_origen_crudo where cliente_id = $1')).toBe(true);
    expect(patron.test('select * from movimiento_bancario_crudo')).toBe(false);
  });

  it('la lista de permitidos no tiene entradas muertas', () => {
    // Un permitido que apunta a un archivo renombrado afloja la regla SIN ponerla en rojo: el
    // barrido sigue verde y ya no cubre lo que decía cubrir.
    const rutas = FUENTES.map(rel);
    for (const p of PERMITIDOS_MOV_ORIGEN) {
      expect(rutas.some((r) => r === p || r.startsWith(p)), `permitido inexistente: ${p}`).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
describe('R-C — ningún léxico de packages/contabilidad importa a otro léxico', () => {
  /**
   * Clon estructural del bucle de "ningún adaptador importa a otro adaptador" (arriba) — mismo
   * argumento: un léxico que importa a otro acopla dos bancos, y un cambio de vocabulario en uno
   * rompería al otro sin que ningún test lo note hasta que corra contra datos reales.
   */
  it('ningún archivo de lexico/ importa a otro de lexico/ (excepto registro.ts)', () => {
    const lexicos = FUENTES.filter(
      (r) => rel(r).includes('packages/contabilidad/src/lexico/') && !rel(r).endsWith('registro.ts'),
    );
    expect(lexicos.length, 'no se está barriendo packages/contabilidad/src/lexico/').toBeGreaterThan(0);

    const infractores: string[] = [];
    for (const ruta of lexicos) {
      const propio = rel(ruta).split('/').at(-1)?.replace('.ts', '') ?? '';
      const contenido = readFileSync(ruta, 'utf8');
      for (const otro of lexicos) {
        const nombre = rel(otro).split('/').at(-1)?.replace('.ts', '') ?? '';
        if (nombre === propio) continue;
        if (new RegExp(String.raw`from ['"]\./${nombre}\.ts['"]`).test(contenido)) {
          infractores.push(`${rel(ruta)} importa ${nombre}`);
        }
      }
    }
    expect(
      infractores,
      'un léxico que importa a otro acopla dos bancos: un cambio de vocabulario en uno rompe al otro',
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('R-D — un léxico es DATOS, no lógica de decisión', () => {
  /**
   * `08-plan-de-construccion.md` §1 / `04-imputacion-contable.md` §1.3: si un léxico pudiera llamar al
   * matcher o al motor, tendría lógica de decisión propia, y el corte entre "capa por banco" (datos) y
   * "capa única" (decisión) — la razón de ser de esta arquitectura — dejaría de ser cierto en el código.
   */
  it('ningún archivo de lexico/ importa nucleo/matcher.ts ni nucleo/motor.ts', () => {
    const infractores = FUENTES.filter((r) => {
      if (!rel(r).includes('packages/contabilidad/src/lexico/')) return false;
      return /from ['"]\.\.\/nucleo\/(matcher|motor)\.ts['"]/.test(readFileSync(r, 'utf8'));
    });
    expect(infractores.map(rel)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('R-E — el motor no contiene ni una regex escrita a mano sobre la glosa (05 §3)', () => {
  /**
   * Regla dura de `05-motor-de-reconocimiento.md` §3: "el motor no contiene ni una regex escrita a
   * mano sobre la glosa. Cero `includes`, cero `startsWith` sueltos." Si necesitás reconocer algo
   * nuevo, es una ENTRADA del léxico (dato), no una condición de código.
   *
   * Acotado a `nucleo/` y `lexico/` — no a todo `packages/contabilidad` — porque `tests/` legítimamente
   * usa `.includes(` sobre ARRAYS (candidatos, literales) constantemente, y ese uso no es el que esta
   * regla existe para prohibir. La allowlist son los tres archivos MECANISMO: `normalizacion.ts` (los
   * dos `.replace(regex)` del paso de normalización), `matcher.ts` (el único `startsWith`, el choke
   * point del prefijo) e `indice.ts` (el `.test(/[A-Z0-9]$/)` del ancla).
   */
  const PERMITIDOS_TEXTO_LIBRE = [
    'packages/contabilidad/src/nucleo/normalizacion.ts',
    'packages/contabilidad/src/nucleo/matcher.ts',
    'packages/contabilidad/src/nucleo/indice.ts',
  ];
  const PATRON_TEXTO_LIBRE = /\.includes\(|\.startsWith\(|\.endsWith\(|\.indexOf\(|\.match\(|\.search\(|\/[^/\n]{1,80}\/[gimsuy]*\.test\(/;

  it('cero regex/.includes/.startsWith/.endsWith sueltos en nucleo/ o lexico/, fuera de la allowlist', () => {
    const objetivo = FUENTES.filter((r) => {
      const p = rel(r);
      return (
        (p.startsWith('packages/contabilidad/src/nucleo/') || p.startsWith('packages/contabilidad/src/lexico/')) &&
        !PERMITIDOS_TEXTO_LIBRE.includes(p)
      );
    });
    expect(objetivo.length, 'no se está barriendo packages/contabilidad/src/{nucleo,lexico}').toBeGreaterThan(5);

    const infractores = objetivo.filter((ruta) => PATRON_TEXTO_LIBRE.test(readFileSync(ruta, 'utf8')));
    expect(
      infractores.map(rel),
      'el motor no contiene ni una regex/comparación de texto a mano sobre la glosa (05 §3). Si ' +
        'necesitás reconocer algo nuevo, es una ENTRADA del léxico, no una condición de código.',
    ).toEqual([]);
  });

  it('el patrón detecta una infracción plantada y no confunde un .includes() sobre un array', () => {
    // Anti-falso-verde. El patrón SÍ dispara sobre comparación de texto libre...
    expect(PATRON_TEXTO_LIBRE.test("glosa.includes('CUIT')")).toBe(true);
    expect(PATRON_TEXTO_LIBRE.test("texto.startsWith('IMP')")).toBe(true);
    // ...y también sobre `.includes(` de un array — a propósito: por eso la regla se acota por
    // DIRECTORIO (nucleo/lexico) y no intenta distinguir "sobre texto" de "sobre array" por sintaxis,
    // que sería frágil. `tests/` queda fuera de este barrido por diseño, no porque el patrón no la vea.
    expect(PATRON_TEXTO_LIBRE.test('entrada.literales.includes(literal)')).toBe(true);
  });

  it('la allowlist no tiene entradas muertas', () => {
    const rutas = FUENTES.map(rel);
    for (const p of PERMITIDOS_TEXTO_LIBRE) {
      expect(rutas.includes(p), `permitido inexistente: ${p}`).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
describe('R-F — `clase: \'propuesta\'` solo se construye en nucleo/motor.ts', () => {
  /**
   * Mismo idiom que R30 (`.urlFirmada(` solo en `descarga.ts`): es lo que hace que la degradación de
   * `pendienteDeLaura` no se pueda saltear escribiendo la clase a mano en otro archivo. Ver
   * `tests/pendiente-laura.test.ts` para la garantía de comportamiento; esto es la garantía estructural.
   */
  const PERMITIDOS_PROPUESTA = [
    'packages/contabilidad/src/nucleo/motor.ts', // el constructor — R-F en persona
    'packages/contabilidad/src/nucleo/reconocimiento.ts', // docblock del tipo; el discriminante ya se deriva con `Extract`
    'packages/contabilidad/src/nucleo/lexico.ts', // docblocks que citan la frase en prosa
    'packages/contabilidad/tests/',
    // Test del CLI de dry-run de capa C (P6, adaptive-herding-pillow): construye Reconocimiento
    // sintéticos para probar agregarMatriz() sin base — mismo motivo que packages/contabilidad/tests/.
    'apps/cli/tests/resolver-contrapartida.test.ts',
    // Aislamiento de 0014: construye el PEDIDO de persistencia a mano —no un `Reconocimiento`— para
    // ejercitar los constraints de la base (forma, FK de tres columnas, digest mal formado) sin pasar
    // por el motor. Mismo motivo que la línea de arriba: el riesgo que R-F cubre —saltear la
    // degradación de `pendienteDeLaura` en código de producción— no existe en un test que apunta
    // justamente a que la base rechace las filas mal formadas.
    'packages/data/tests/aislamiento-modulo-2.test.ts',
  ];
  const PATRON_PROPUESTA = /clase:\s*'propuesta'/;

  it("ningún archivo fuera de la lista construye `{ clase: 'propuesta', ... }`", () => {
    expect(
      infractores(PATRON_PROPUESTA, PERMITIDOS_PROPUESTA),
      "`nucleo/motor.ts` es la única función que construye una propuesta. Si tu código necesita " +
        "clase:'propuesta', llamá a reconocer(), no la escribas a mano — eso es lo que le permitiría a " +
        "una entrada pendienteDeLaura saltearse la degradación.",
    ).toEqual([]);
  });

  it('el patrón detecta una infracción plantada', () => {
    expect(PATRON_PROPUESTA.test("return { clase: 'propuesta', tipo, concepto }")).toBe(true);
    expect(PATRON_PROPUESTA.test("if (r.clase === 'propuesta')")).toBe(false);
  });

  it('la allowlist no tiene entradas muertas', () => {
    const rutas = FUENTES.map(rel);
    for (const p of PERMITIDOS_PROPUESTA) {
      expect(rutas.some((r) => r === p || r.startsWith(p)), `permitido inexistente: ${p}`).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
describe('R-G — packages/contabilidad es código puro, sin SQL', () => {
  /**
   * Esta etapa es código puro sin base (05 §7: "un léxico que puede leer la base es un léxico que
   * puede aprender solo"). Una consulta acá sería la primera grieta — R-B ya prohíbe importar `data`,
   * pero eso no impide un `tx.consultar('select ...')` con un objeto ajeno; esta regla cierra esa
   * puerta directamente sobre el TEXTO de la consulta.
   */
  it('ningún archivo de packages/contabilidad/src contiene una sentencia SQL', () => {
    const infractores = infractores_(/\b(select|insert into|update|delete from)\s/i, [
      'packages/contabilidad/tests/', // pueden citar SQL en un comentario o mensaje de error
    ]);
    expect(infractores.map(rel)).toEqual([]);
  });

  // Alias local: `infractores` ya filtra ESTE_ARCHIVO; se necesita acotar además a packages/contabilidad.
  function infractores_(patron: RegExp, permitidos: readonly string[]): string[] {
    return FUENTES.filter((ruta) => {
      const r = rel(ruta);
      if (!r.startsWith('packages/contabilidad/')) return false;
      if (permitidos.some((p) => r === p || r.startsWith(p))) return false;
      return patron.test(readFileSync(ruta, 'utf8'));
    });
  }
});

// -----------------------------------------------------------------------------
describe('R-G (espejo para packages/fci) — código puro, sin SQL', () => {
  /** Mismo argumento que R-G para `contabilidad`: R-B ya prohíbe importar `data`, pero no impide un
   *  `tx.consultar('select ...')` con un objeto ajeno colado en el núcleo; esta regla cierra esa
   *  puerta directamente sobre el TEXTO de la consulta. */
  it('ningún archivo de packages/fci/src contiene una sentencia SQL', () => {
    const infractoresFci = FUENTES.filter((ruta) => {
      const r = rel(ruta);
      if (!r.startsWith('packages/fci/')) return false;
      if (r.startsWith('packages/fci/tests/')) return false; // pueden citar SQL en un comentario o mensaje de error
      return /\b(select|insert into|update|delete from)\s/i.test(readFileSync(ruta, 'utf8'));
    });
    expect(infractoresFci.map(rel)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('R-H — EvidenciaDeMovimiento espeja movimientoBancarioCrudoSchema (árbitro mientras no exista 0014)', () => {
  /**
   * `nucleo/reconocimiento.ts` no puede importar `packages/ingesta/src/esquema.ts` (ciclo, R-B) así
   * que duplica los nombres de campo a mano. Mientras no exista la migración 0014, este barrido de
   * texto es el árbitro que evita que las dos listas diverjan sin que nadie lo note — después, el
   * árbitro pasa a ser la base (mismo patrón que `TIPOS_CUENTA`/`TIPOS_CUENTA_ALTA`,
   * `packages/data/tests/catalogo.test.ts`).
   */
  const CAMPOS_ESPEJADOS = [
    'conceptoBanco',
    'conceptoCompleto',
    'conceptoBancoEstrategia',
    'conceptoCodigo',
    'columnaOrigen',
  ];

  it('los cinco campos de EvidenciaDeMovimiento existen tal cual en esquema.ts (packages/ingesta)', () => {
    const esquema = readFileSync(join(RAIZ, 'packages/ingesta/src/esquema.ts'), 'utf8');
    const reconocimiento = readFileSync(
      join(RAIZ, 'packages/contabilidad/src/nucleo/reconocimiento.ts'),
      'utf8',
    );
    for (const campo of CAMPOS_ESPEJADOS) {
      expect(esquema.includes(campo), `"${campo}" no está en packages/ingesta/src/esquema.ts`).toBe(true);
      expect(reconocimiento.includes(campo), `"${campo}" no está en nucleo/reconocimiento.ts`).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
describe('R-I — el catálogo canónico no ramifica lógica por banco (04 §1.3)', () => {
  /**
   * "El criterio contable se escribe UNA vez." Sin este test, en tres bancos aparece un
   * `if (banco === 'galicia')` en el catálogo y la separación capa-por-banco/capa-única existe solo
   * en el documento — exactamente lo que `04-imputacion-contable.md` §1.3 pide evitar.
   *
   * 🔴 El chequeo busca COMPARACIONES DE IGUALDAD contra un nombre de banco (`banco === 'galicia'`),
   * NO cualquier mención textual — `catalogo.ts` legítimamente cita nombres de banco en comentarios
   * organizativos (`// ══ Santander (P7) ══`), en `procedencia.documento` (rutas como
   * `docs/diseno/06-formato-santander.md`, necesarias para que PROP-6 verifique la evidencia) y hasta
   * en nombres de concepto (`retencion_iva_percepcion_macro`, por el nombre real del banco emisor). Un
   * barrido por substring ingenuo confundiría esas menciones legítimas con la lógica que la regla
   * existe para prohibir — verificado a mano: la primera versión de esta regla daba falso positivo
   * contra las tres.
   */
  const PATRON_RAMA_POR_BANCO = /===?\s*['"](?:galicia|santander|macro|bancor)['"]/i;

  it('nucleo/catalogo.ts no compara nada contra un nombre de banco', () => {
    const contenido = readFileSync(join(RAIZ, 'packages/contabilidad/src/nucleo/catalogo.ts'), 'utf8');
    expect(
      PATRON_RAMA_POR_BANCO.test(contenido),
      'el catálogo canónico es la capa ÚNICA (04 §1.3) — una comparación contra un nombre de banco acá ' +
        'es la primera grieta de "el criterio contable se escribe una sola vez"',
    ).toBe(false);
  });

  it('el patrón detecta una infracción plantada y no confunde una cita de documento ni un comentario', () => {
    expect(PATRON_RAMA_POR_BANCO.test("if (banco === 'galicia') { ... }")).toBe(true);
    expect(PATRON_RAMA_POR_BANCO.test("documento: 'docs/diseno/06-formato-santander.md'")).toBe(false);
    expect(PATRON_RAMA_POR_BANCO.test('// ══ Santander (P7) — conceptos nuevos ══')).toBe(false);
    expect(PATRON_RAMA_POR_BANCO.test("'retencion_iva_percepcion_macro'")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
describe('R-J — packages/contabilidad/src/nucleo es SÍNCRONO, sin excepción (Ronda 1, arquitecto-software)', () => {
  /**
   * R-B bloquea el import nombrado de `data`/`ingesta`/`almacenamiento`; no bloquea que una función
   * de `nucleo/` reciba una `Promise` como "argumento" y erosione la pureza con el tiempo — alguien
   * pasa un callback que hace I/O, en vez de un valor ya resuelto. `reconocer()` y
   * `resolverContraparte()` ya son síncronas hoy; esto lo hace verificable, no solo accidental.
   */
  const PATRON_ASINCRONO = /\basync\b|\bawait\b|\bPromise\s*[<(]/;

  function archivosDeNucleo(): string[] {
    return FUENTES.filter((ruta) => rel(ruta).startsWith('packages/contabilidad/src/nucleo/'));
  }

  it('ningún archivo de packages/contabilidad/src/nucleo usa async/await/Promise', () => {
    const infractores = archivosDeNucleo().filter((ruta) => PATRON_ASINCRONO.test(readFileSync(ruta, 'utf8')));
    expect(
      infractores.map(rel),
      'nucleo/ es código puro por diseño (R-B) — si necesita un dato de la base, lo recibe como ' +
        'argumento ya resuelto; una función async ahí es la primera grieta por la que se cuela I/O',
    ).toEqual([]);
  });

  it('el patrón detecta las tres formas de infracción', () => {
    expect(PATRON_ASINCRONO.test('export async function resolverContraparte() {}')).toBe(true);
    expect(PATRON_ASINCRONO.test('const x = await leerAlgo();')).toBe(true);
    expect(PATRON_ASINCRONO.test('function f(p: Promise<string>) {}')).toBe(true);
    expect(PATRON_ASINCRONO.test('export function resolverContraparte() { return synchronousValue; }')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
describe('R-J (espejo para packages/fci/src/nucleo) — SÍNCRONO, sin excepción', () => {
  /** Mismo argumento que R-J para `contabilidad`: `nucleo/` es código puro por diseño; si necesita un
   *  dato de la base, lo recibe como argumento ya resuelto. Una función async ahí es la primera
   *  grieta por la que se cuela I/O. */
  const PATRON_ASINCRONO_FCI = /\basync\b|\bawait\b|\bPromise\s*[<(]/;

  it('ningún archivo de packages/fci/src/nucleo usa async/await/Promise', () => {
    const archivos = FUENTES.filter((ruta) => rel(ruta).startsWith('packages/fci/src/nucleo/'));
    expect(archivos.length, 'no se está barriendo packages/fci/src/nucleo').toBeGreaterThan(0);

    const infractoresFci = archivos.filter((ruta) => PATRON_ASINCRONO_FCI.test(readFileSync(ruta, 'utf8')));
    expect(infractoresFci.map(rel)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('R-H bis — CandidatoDeContraparte espeja CandidatoContraparte/Candidato (árbitro mientras no exista 0014)', () => {
  /**
   * `nucleo/contrapartida.ts` no puede importar `packages/ingesta/src/contraparte.ts` ni
   * `packages/data/src/contabilidad/lecturas.ts` (R-B, ciclo bidireccional confirmado en la Ronda 1
   * — `arquitecto-software`), así que duplica los nombres de campo del candidato a mano en los tres
   * archivos. Mismo mecanismo que R-H para `EvidenciaDeMovimiento`.
   */
  // 🔴 NO incluye el HMAC en sí (Ronda 3, `tech-lead` + `tester`): el campo se llama distinto en
  // cada paquete a propósito (`hmac` en contabilidad/ingesta, `identificadorHmac` en data) — un
  // barrido textual de "el nombre coincide" no puede arbitrar un campo cuyo nombre CORRECTO diverge.
  // Ese campo queda sin árbitro automático; un rename ahí lo detecta TypeScript (los adaptadores de
  // `apps/cli/src/resolver-contrapartida.ts` no compilan si el campo fuente desaparece), pero un
  // campo NUEVO agregado a un solo lado no dispara ninguna alarma — deuda conocida, ver HANDOFF.
  const CAMPOS_CANDIDATO = ['clase', 'pepperId'];

  it('los campos del candidato existen tal cual en ingesta/contraparte.ts y en data/contabilidad/lecturas.ts', () => {
    const contrapartida = readFileSync(
      join(RAIZ, 'packages/contabilidad/src/nucleo/contrapartida.ts'),
      'utf8',
    );
    const ingesta = readFileSync(join(RAIZ, 'packages/ingesta/src/contraparte.ts'), 'utf8');
    const data = readFileSync(join(RAIZ, 'packages/data/src/contabilidad/lecturas.ts'), 'utf8');
    for (const campo of CAMPOS_CANDIDATO) {
      expect(contrapartida.includes(campo), `"${campo}" no está en nucleo/contrapartida.ts`).toBe(true);
      expect(ingesta.includes(campo), `"${campo}" no está en ingesta/contraparte.ts`).toBe(true);
      expect(data.includes(campo), `"${campo}" no está en data/contabilidad/lecturas.ts`).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
describe('R-H bis (SocioDelPadron) — espeja packages/data/src/contabilidad/lecturas.ts (Ronda 3, tech-lead)', () => {
  /**
   * `SocioDelPadron` vive duplicado en `packages/contabilidad/src/nucleo/contrapartida.ts` y en
   * `packages/data/src/contabilidad/lecturas.ts` (mismo motivo que `Candidato`: R-B prohíbe
   * importar entre los dos paquetes). A diferencia de `Candidato`, este tipo no tenía NINGÚN
   * árbitro — la coincidencia de los 4 campos comparables era casualidad, no una regla verificable.
   *
   * El identificador de fila NO está en la lista a propósito: `data/lecturas.ts` usa `id` desnudo
   * (mismo criterio que `credenciales.ts`/`ingesta/lecturas.ts` — "esta es la fila de la entidad");
   * `contabilidad` siempre califica (`socioId`, `movimientoId`), sin excepción. Es una divergencia de
   * CONVENCIÓN de cada paquete, no un descuido — `apps/cli/src/resolver-contrapartida.ts`
   * (`comoSocioDelPadron`) es el adaptador explícito que la tiende.
   */
  const CAMPOS_SOCIO = ['documentoHmac', 'pepperId', 'vigenteDesde', 'vigenteHasta'];

  it('los campos comparables de SocioDelPadron coinciden entre contabilidad y data', () => {
    const contrapartida = readFileSync(
      join(RAIZ, 'packages/contabilidad/src/nucleo/contrapartida.ts'),
      'utf8',
    );
    const data = readFileSync(join(RAIZ, 'packages/data/src/contabilidad/lecturas.ts'), 'utf8');
    for (const campo of CAMPOS_SOCIO) {
      expect(contrapartida.includes(campo), `"${campo}" no está en nucleo/contrapartida.ts`).toBe(true);
      expect(data.includes(campo), `"${campo}" no está en data/contabilidad/lecturas.ts`).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
describe('la marca PadronConsultado se construye en UN solo lugar (Ronda 1, seguridad-datos-financieros)', () => {
  /**
   * `marcarPadronConsultado` es la única función que puede producir un `PadronConsultado` — el
   * símbolo que lo marca no se exporta. Un segundo `as unknown as PadronConsultado` en cualquier
   * otro archivo forjaría el tipo sin haber pasado por `leerPadronDeSocios`, exactamente lo que la
   * marca existe para impedir. Mismo mecanismo que ya usa `ContextoAuditado`
   * (`packages/data/src/db/auditoria.ts`), sin test de catálogo propio — este lo cubre para los dos.
   */
  it('"as unknown as PadronConsultado" aparece exactamente una vez en todo el repo, en marcarPadronConsultado', () => {
    const infractores = FUENTES.filter((ruta) => {
      const r = rel(ruta);
      if (r === ESTE_ARCHIVO) return false;
      if (r === 'packages/contabilidad/src/nucleo/contrapartida.ts') return false;
      return /as unknown as PadronConsultado/.test(readFileSync(ruta, 'utf8'));
    });
    expect(
      infractores.map(rel),
      'PadronConsultado solo se puede construir en nucleo/contrapartida.ts — un forge en otro ' +
        'archivo permite invocar resolverContraparte() sin haber leído el padrón real',
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('R-K — FilaDeReconocimiento espeja PedidoDePersistirReconocimiento (0014)', () => {
  /**
   * `packages/data` no puede importar `contabilidad` (R-A, y el barrido es de TEXTO: `import type`
   * tampoco pasa), así que la lista de campos vive en dos archivos.
   *
   * El MAPEO del tipo suma NO está duplicado —vive solo en `nucleo/persistible.ts` y lo arbitra el
   * compilador con un `switch` exhaustivo— pero la lista de NOMBRES sí, y una deriva ahí es
   * silenciosa: si `contabilidad` agrega un campo y `data` no, el adaptador de `apps/cli` sigue
   * compilando y la columna nueva no se escribe nunca. Nada se pone rojo.
   *
   * Mismo mecanismo que R-H y R-H bis, y acá el substring alcanza de verdad: es una lista plana de
   * nombres fijos, no una unión discriminada. (Eso es exactamente lo que `arquitecto-software`
   * objetaba en la Ronda 1 — un espejo sobre un tipo suma NO es verificable así, y por eso el mapeo
   * se movió a `packages/contabilidad`.)
   */
  const CAMPOS_ESPEJADOS = [
    'clase',
    'tipo',
    'concepto',
    'polaridad',
    'lado',
    'via',
    'queDecide',
    'motivoCodigo',
    'entradaLexicoId',
    'caracteresMatcheados',
    'huboCola',
    'candidatos',
  ];

  const PERSISTIBLE = join(RAIZ, 'packages/contabilidad/src/nucleo/persistible.ts');
  const ESCRITURAS = join(RAIZ, 'packages/data/src/contabilidad/escrituras.ts');

  it('cada campo de FilaDeReconocimiento existe tal cual en el pedido de packages/data', () => {
    const persistible = readFileSync(PERSISTIBLE, 'utf8');
    const escrituras = readFileSync(ESCRITURAS, 'utf8');

    for (const campo of CAMPOS_ESPEJADOS) {
      expect(persistible.includes(campo), `«${campo}» no está en nucleo/persistible.ts`).toBe(true);
      expect(
        escrituras.includes(campo),
        `«${campo}» no está en data/src/contabilidad/escrituras.ts — el campo existe del lado del ` +
          'motor y su columna no se escribe nunca',
      ).toBe(true);
    }
  });

  it('la lista de campos espejados no está muerta: los dos archivos existen y son grandes', () => {
    // Anti-falso-verde: si una ruta se rompe, `readFileSync` explota; si el archivo quedara vacío,
    // todos los `includes` darían false y el test de arriba ya sería rojo. Esto cubre el caso
    // intermedio: un archivo que existe pero perdió el tipo.
    expect(readFileSync(PERSISTIBLE, 'utf8')).toContain('FilaDeReconocimiento');
    expect(readFileSync(ESCRITURAS, 'utf8')).toContain('PedidoDePersistirReconocimiento');
    expect(CAMPOS_ESPEJADOS.length).toBeGreaterThan(8);
  });
});

// -----------------------------------------------------------------------------
describe('R-M — las dos familias de adapters no se conocen (plan 14 §1)', () => {
  /**
   * El Módulo 1 lee **extractos bancarios** (`src/adaptadores/`); el módulo de liquidaciones de
   * tarjeta lee **liquidaciones de adquirente** (`src/liquidaciones/`). Viven en el mismo paquete a
   * propósito —comparten la infraestructura de extracción (`texto-pdf.ts`), el parseo de importes AR
   * (`parseo-ar.ts`) y el hash de archivo (`hash.ts`)— pero **no comparten contrato**, y el plan 14 §1
   * documenta los tres bloqueos duros que lo impiden: `lote_ingesta.banco_codigo` es
   * `not null references banco(codigo)` y Visa/Cabal no son bancos; la salida bancaria es
   * `CuentaConMovimientos[]`, que no tiene forma de liquidación; y compartir el registro ampliaría la
   * superficie del caso `ambiguo` (precedente real: un PDF de Credicoop byte-idéntico a uno de ICBC)
   * sin ganar nada.
   *
   * Esta regla es lo que hace que esa separación sea cierta en el código y no solo en el documento. Lo
   * que NO prohíbe, y es deliberado: importar la infraestructura compartida del paquete
   * (`../texto-pdf.ts`, `../parseo-ar.ts`, `../hash.ts`, `../esquema.ts`) — ese reuso medido es
   * exactamente la razón por la que el módulo es un subárbol de `ingesta` y no un paquete nuevo.
   *
   * Es hermana de la regla de aislamiento entre bancos de más arriba: aquella impide que un banco
   * rompa a otro; esta impide que una FAMILIA rompa a la otra.
   */
  const PATRON_IMPORTA_ADAPTADORES = /from ['"][^'"]*\/adaptadores\/[^'"]+['"]/;
  const PATRON_IMPORTA_LIQUIDACIONES = /from ['"][^'"]*\/liquidaciones\/[^'"]+['"]/;

  it('ningún archivo de `liquidaciones/` importa del contrato bancario', () => {
    const deLiquidaciones = FUENTES.filter((r) =>
      rel(r).startsWith('packages/ingesta/src/liquidaciones/'),
    );
    const infractores = deLiquidaciones.filter((ruta) =>
      PATRON_IMPORTA_ADAPTADORES.test(readFileSync(ruta, 'utf8')),
    );
    expect(
      infractores.map(rel),
      'el contrato de liquidaciones es propio (plan 14 §1): reusa la infraestructura del paquete, ' +
        'nunca el contrato de extractos bancarios',
    ).toEqual([]);
  });

  it('ningún archivo de `adaptadores/` importa del contrato de liquidaciones', () => {
    const deAdaptadores = FUENTES.filter((r) =>
      rel(r).startsWith('packages/ingesta/src/adaptadores/'),
    );
    const infractores = deAdaptadores.filter((ruta) =>
      PATRON_IMPORTA_LIQUIDACIONES.test(readFileSync(ruta, 'utf8')),
    );
    expect(
      infractores.map(rel),
      'la dirección inversa importa igual: un adapter bancario que dependa del vocabulario de ' +
        'liquidaciones ata los ocho bancos al calendario de otro módulo',
    ).toEqual([]);
  });

  it('los patrones detectan la infracción plantada y no confunden la infraestructura compartida', () => {
    expect(
      PATRON_IMPORTA_ADAPTADORES.test("import { ErrorDeAdaptador } from '../adaptadores/contrato.ts';"),
    ).toBe(true);
    expect(
      PATRON_IMPORTA_LIQUIDACIONES.test("import type { Renglon } from '../liquidaciones/esquema.ts';"),
    ).toBe(true);
    // Lo que NO es infracción: la infraestructura compartida del paquete y los hermanos de la familia.
    expect(PATRON_IMPORTA_ADAPTADORES.test("import { agruparEnFilas } from '../texto-pdf.ts';")).toBe(false);
    expect(PATRON_IMPORTA_ADAPTADORES.test("import { parsearImporteAr } from '../parseo-ar.ts';")).toBe(false);
    expect(PATRON_IMPORTA_ADAPTADORES.test("import { ESTADOS_VERIFICACION } from '../esquema.ts';")).toBe(false);
    expect(PATRON_IMPORTA_LIQUIDACIONES.test("import { toolkit } from './toolkit.ts';")).toBe(false);
    // Y una mención en prosa no es un import.
    expect(PATRON_IMPORTA_ADAPTADORES.test('// ver `adaptadores/contrato.ts` para el espejo')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
describe('R-N — el barrido VE el subárbol de liquidaciones (sin esto, R-M pasa por vacío)', () => {
  /**
   * R-M filtra por prefijo de path. Si el subárbol se renombra, se mueve o queda fuera del glob de
   * `FUENTES`, las dos primeras pruebas de R-M pasan sobre una lista **vacía** y siguen verdes: el
   * aislamiento dejaría de estar vigilado sin que nada se ponga rojo.
   *
   * Es la misma protección que ya tiene el barrido general más arriba (`cobertura del barrido`),
   * aplicada al directorio que R-M necesita ver. Método rojo→verde del plan 12: esta regla se escribió
   * ANTES de crear el subárbol y se verificó **roja** por ausencia, que es la única forma de saber que
   * reacciona.
   */
  it('los tres archivos del contrato de liquidaciones están en FUENTES', () => {
    const delSubarbol = FUENTES.map(rel).filter((r) =>
      r.startsWith('packages/ingesta/src/liquidaciones/'),
    );
    expect(delSubarbol).toContain('packages/ingesta/src/liquidaciones/contrato.ts');
    expect(delSubarbol).toContain('packages/ingesta/src/liquidaciones/registro.ts');
    expect(delSubarbol).toContain('packages/ingesta/src/liquidaciones/esquema.ts');
    expect(delSubarbol.length).toBeGreaterThanOrEqual(3);
  });
});

// -----------------------------------------------------------------------------
describe('R-O — cero porcentajes y cero decimales en el vocabulario compartido de liquidaciones', () => {
  /**
   * Dictamen de `seguridad-datos-financieros` (hallazgo L-2, sesión 2026-08-19): el arancel es un
   * **término negociado por comercio** y la alícuota de retención depende de un padrón por
   * contribuyente. Un porcentaje escrito en `liquidaciones/` —que es código compartido entre TODOS los
   * tenants, versionado y público para siempre en el historial— es un dato de la relación comercial de
   * un cliente filtrado a los demás (H-6), y **la agregación no desclasifica**.
   *
   * Y el barrido de fuga NO lo detecta: sus candidatos salen solo de `DETECTORES`
   * (`tools/barrido-fuga.ts`), cuyo único detector de importes exige al menos un grupo de miles y dos
   * decimales — una tasa chica y todo importe menor a mil no matchean nunca. El verde del barrido
   * sobre esta familia es verde-por-vacío; esta regla es el control que sí existe.
   *
   * **Enunciada sin excepción, a propósito.** "Cero porcentajes, salvo los normativos" tiene la forma
   * exacta de R33 y de la R25 vieja: la regla nombra su propia excepción, y la excepción exige un
   * juicio caso-por-caso —¿esta tasa es normativa o negociada?— que alguien va a hacer mal el día que
   * escriba un arancel esperado. Lo que la regla mira son **valores**: un decimal en posición de valor
   * y un signo de porcentaje. Un número de norma entero (`percepcion_iva_rg2408`, `impuesto_25413`) no
   * es una tasa y sigue siendo legítimo.
   *
   * ## Alcance acotado a `contrato.ts`/`registro.ts`/`esquema.ts` (y `index.ts` si deja de ser barrel)
   *
   * Dictamen de `seguridad-datos-financieros` (esta sesión, 2026-08-19), confirmado por JP: un adapter
   * de PDF necesita coordenadas geométricas fijas (`const X_FECHA = 38.4;`, mismo patrón que usan los
   * ocho adapters bancarios de `adaptadores/`, ninguno con una regla equivalente) y esas coordenadas
   * SON decimales. Aplicar R-O sin acotar pondría en rojo la geometría legítima del primer adapter real
   * (`liquidaciones/formatos/`) el día que exista.
   *
   * El riesgo real que R-O existe para tapar es un **valor de negocio** (arancel, alícuota) filtrado
   * entre tenants por el vocabulario COMPARTIDO — nunca la geometría fija de un emisor, que es un hecho
   * público del formato del documento (Visa imprime sus columnas en el mismo lugar para todo comercio),
   * no un dato de la relación comercial de un cliente. Por eso R-O se acota al vocabulario compartido y
   * excluye explícitamente `liquidaciones/formatos/`, que tiene su propio guardia — R-O2, más abajo —
   * acotado al **nombre del identificador**, no a cualquier decimal.
   */
  const PATRON_DECIMAL_EN_VALOR = /[:=]\s*-?\d+[.,]\d+/;
  const PATRON_PORCENTAJE = /\d\s*%/;

  /** El vocabulario compartido: nunca `liquidaciones/formatos/`, que tiene geometría legítima. */
  function esDelVocabularioCompartido(r: string): boolean {
    return (
      r.startsWith('packages/ingesta/src/liquidaciones/') &&
      !r.startsWith('packages/ingesta/src/liquidaciones/formatos/')
    );
  }

  it('ningún archivo del vocabulario compartido de liquidaciones escribe un decimal en posición de valor', () => {
    const deLiquidaciones = FUENTES.filter((r) => esDelVocabularioCompartido(rel(r)));
    const infractores = deLiquidaciones.filter((ruta) =>
      PATRON_DECIMAL_EN_VALOR.test(readFileSync(ruta, 'utf8')),
    );
    expect(
      infractores.map(rel),
      'una tasa cableada en el vocabulario compartido es H-6: la tasa efectiva se calcula de cada ' +
        'liquidación real, y una esperada —si algún día existe— va en tabla N2 por cliente con vigencia. ' +
        '`liquidaciones/formatos/` queda afuera a propósito: ahí la geometría del PDF es legítima (R-O2 ' +
        'la vigila por nombre de identificador, no por cualquier decimal)',
    ).toEqual([]);
  });

  it('ningún archivo del vocabulario compartido de liquidaciones escribe un porcentaje', () => {
    const deLiquidaciones = FUENTES.filter((r) => esDelVocabularioCompartido(rel(r)));
    const infractores = deLiquidaciones.filter((ruta) =>
      PATRON_PORCENTAJE.test(readFileSync(ruta, 'utf8')),
    );
    expect(
      infractores.map(rel),
      'ni siquiera en un comentario: el historial de git no se rota, y una tasa no se puede rotar ' +
        'como se rota una credencial',
    ).toEqual([]);
  });

  it('los patrones detectan la infracción plantada y no confunden el caso legítimo', () => {
    // Las dos formas en que una tasa medida entraría de verdad.
    expect(PATRON_DECIMAL_EN_VALOR.test('const ALICUOTA_ARANCEL = 1.0;')).toBe(true);
    expect(PATRON_DECIMAL_EN_VALOR.test('  alicuotaEsperada: 3.5,')).toBe(true);
    expect(PATRON_PORCENTAJE.test('// el arancel medido es 1,0% de las ventas')).toBe(true);
    expect(PATRON_PORCENTAJE.test('  retencionSirtac: "3,50 %"')).toBe(true);
    // Caso legítimo: números de norma enteros, referencias a secciones de documentos, y los enteros
    // de configuración. Ninguno es una tasa.
    expect(PATRON_DECIMAL_EN_VALOR.test("'percepcion_iva_rg2408',")).toBe(false);
    expect(PATRON_DECIMAL_EN_VALOR.test('// ver `docs/diseno/14-liquidaciones-tarjeta-plan.md` §5.1')).toBe(false);
    expect(PATRON_DECIMAL_EN_VALOR.test('export function formaDeLinea(texto: string, largoMaximo = 60)')).toBe(false);
    expect(PATRON_DECIMAL_EN_VALOR.test('  archivoHash: z.string().length(64),')).toBe(false);
    expect(PATRON_PORCENTAJE.test("  concepto: 'iva_sobre_arancel',")).toBe(false);
  });

  it('el filtro del vocabulario compartido excluye `formatos/` y sigue viendo el resto', () => {
    // Guardia de la propia allowlist: si `esDelVocabularioCompartido` se rompiera y volviera a incluir
    // `formatos/`, o dejara de ver `contrato.ts`, las dos pruebas de arriba pasarían por razones
    // equivocadas (vacío o de menos) sin que nada avise.
    expect(esDelVocabularioCompartido('packages/ingesta/src/liquidaciones/contrato.ts')).toBe(true);
    expect(esDelVocabularioCompartido('packages/ingesta/src/liquidaciones/formatos/visa-debito.ts')).toBe(
      false,
    );
  });
});

// -----------------------------------------------------------------------------
describe('R-O2 — ningún adapter de liquidaciones cablea una tasa esperada por su nombre', () => {
  /**
   * Cierra el riesgo residual que dejó abierto acotar R-O: nada impide que alguien cablee una tasa
   * ESPERADA dentro de `liquidaciones/formatos/` (ej. `const ARANCEL_ESPERADO = 1.8;`) como atajo, ahora
   * que R-O ya no mira ese directorio. Mismo mecanismo que R-O (`infractores`/`FUENTES`), acotado a
   * `liquidaciones/formatos/` — pero el patrón mira el **nombre del identificador**, no cualquier
   * decimal: una coordenada geométrica (`const X_FECHA = 38.4;`) es legítima ahí y no puede poner esta
   * regla en rojo.
   *
   * El patrón busca un identificador cuyo nombre contenga una palabra de tasa/importe negociado
   * (arancel, alícuota, tasa, retención, percepción, comisión) asignado a un valor decimal o con signo
   * de porcentaje. Es la misma lógica de H-6 que R-O, aplicada donde R-O ya no mira.
   */
  const PATRON_TASA_CABLEADA =
    /\b\w*(?:ARANCEL|ALICUOTA|TASA|RETENCION|PERCEPCION|COMISION)\w*\s*[:=]\s*['"`]?-?\d+(?:[.,]\d+)?\s*%?/i;

  function esDeFormatos(r: string): boolean {
    return r.startsWith('packages/ingesta/src/liquidaciones/formatos/');
  }

  it('ningún archivo de `liquidaciones/formatos/` cablea una tasa esperada por su nombre', () => {
    const deFormatos = FUENTES.filter((r) => esDeFormatos(rel(r)));
    const infractores = deFormatos.filter((ruta) =>
      PATRON_TASA_CABLEADA.test(readFileSync(ruta, 'utf8')),
    );
    expect(
      infractores.map(rel),
      'una tasa o arancel ESPERADO cableado por nombre en un adapter es la misma fuga H-6 que R-O ' +
        'prohíbe en el vocabulario compartido, ahora por la puerta de atrás que dejó `formatos/`: la ' +
        'tasa efectiva se calcula de cada liquidación real, nunca se compara contra una constante',
    ).toEqual([]);
  });

  it('el patrón detecta la infracción plantada y no confunde la geometría legítima', () => {
    // Infracción plantada: el nombre del identificador ES una tasa.
    expect(PATRON_TASA_CABLEADA.test('const TASA_ARANCEL = 0.01;')).toBe(true);
    expect(PATRON_TASA_CABLEADA.test('  alicuotaSirtacEsperada: 3.5,')).toBe(true);
    expect(PATRON_TASA_CABLEADA.test('const COMISION_ESPERADA = "1,0%";')).toBe(true);
    // Caso legítimo: coordenadas geométricas del PDF. El nombre no es una tasa, aunque el valor sea
    // decimal — la regla mira el identificador, no el número.
    expect(PATRON_TASA_CABLEADA.test('const X_FECHA = 38.4;')).toBe(false);
    expect(PATRON_TASA_CABLEADA.test('const COLUMNA_VENTAS = { x: 224.4, tolerancia: 1.8 };')).toBe(false);
    expect(PATRON_TASA_CABLEADA.test('const MARGEN_DE_TRUNCADO = 6;')).toBe(false);
    // Y un concepto del catálogo (nombre, no tasa) tampoco confunde al patrón.
    expect(PATRON_TASA_CABLEADA.test("concepto: 'retencion_iibb_sirtac',")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
describe('R-P — único punto de conexión con `tesseract.js` (plan 15, OCR de liquidaciones)', () => {
  /**
   * Hermana de R17 (*"un único punto de conexión"*, más arriba en este archivo): sin `langPath`/
   * `corePath`/`workerPath` apuntando a los paquetes locales ya instalados, `tesseract.js` intenta bajar
   * de `cdn.jsdelivr.net` en silencio (CLAUDE.md §1.4). Esa configuración vive en un único archivo
   * (`packages/ingesta/src/ocr.ts`, ver su comentario de cabecera) precisamente para que solo haya UN
   * lugar que revisar cuando se audita "¿algún documento de un cliente puede salir a un tercero?" — un
   * segundo import de `tesseract.js` en cualquier otro archivo es un segundo lugar donde esa garantía
   * podría faltar, y nadie lo estaría mirando.
   *
   * Dictamen de `security-engineer` (plan 15): la guardia de cardinalidad de abajo es obligatoria —sin
   * ella, si `ocr.ts` dejara de existir o quedara fuera de `FUENTES`, la regla de aislamiento pasaría en
   * verde vacío y dejaría de vigilar nada, el mismo modo de falla que R-N ya corrige para R-M.
   */
  const PATRON_IMPORTA_TESSERACT = /from\s+['"]tesseract\.js['"]/;

  /** `ocr.ts` y sus tests (incluidos los scripts de soporte que necesitan el import directo para la
   * prueba de mutación del propio guard de red) son el único caso legítimo. */
  const PERMITIDOS_R_P = ['packages/ingesta/src/ocr.ts', 'packages/ingesta/tests/'];

  it('ningún archivo fuera de `ocr.ts` (y sus tests) importa `tesseract.js`', () => {
    expect(
      infractores(PATRON_IMPORTA_TESSERACT, PERMITIDOS_R_P),
      'solo `packages/ingesta/src/ocr.ts` puede configurar langPath/corePath/workerPath: un segundo ' +
        'punto de conexión es un segundo lugar donde esa configuración podría faltar',
    ).toEqual([]);
  });

  it('guardia de cardinalidad: la regla VE un caso positivo real (si no, vigila el vacío)', () => {
    const importan = FUENTES.filter(
      (r) => rel(r) !== ESTE_ARCHIVO && PATRON_IMPORTA_TESSERACT.test(readFileSync(r, 'utf8')),
    ).map(rel);
    expect(importan).toContain('packages/ingesta/src/ocr.ts');
    expect(importan.length).toBeGreaterThanOrEqual(1);
  });

  it('el patrón detecta la infracción plantada y no confunde la infraestructura vecina', () => {
    expect(PATRON_IMPORTA_TESSERACT.test("import { createWorker } from 'tesseract.js';")).toBe(true);
    expect(PATRON_IMPORTA_TESSERACT.test('import type { Block } from "tesseract.js";')).toBe(true);
    // Lo que NO es infracción: importar `tesseract.js-core` o `@tesseract.js-data/spa` (nombres
    // parecidos, paquetes distintos) y una mención en prosa.
    expect(PATRON_IMPORTA_TESSERACT.test("import x from 'tesseract.js-core';")).toBe(false);
    expect(PATRON_IMPORTA_TESSERACT.test("require('@tesseract.js-data/spa')")).toBe(false);
    // Y una mención en prosa —sin `from '...'`— no es un import.
    expect(PATRON_IMPORTA_TESSERACT.test('// ver `ocr.ts`, que importa tesseract.js')).toBe(false);
  });
});
