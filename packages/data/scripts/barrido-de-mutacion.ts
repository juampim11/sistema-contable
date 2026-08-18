/**
 * BARRIDO DE MUTACIÓN SOBRE EL ESQUEMA — «¿qué control puedo BORRAR sin que la suite se entere?».
 *
 * Por cada constraint e índice único de las tablas que se le pasen: lo SACA de la base local, corre
 * el archivo de tests indicado, cuenta cuántos caen, y lo RESTAURA con su definición exacta leída del
 * catálogo. Un control cuyo retiro no rompe NADA no es un control: es un comentario con sintaxis SQL.
 *
 * ## Por qué esto existe como herramienta y no como el script de una sesión
 *
 * Nació para `0021` y encontró, en su PRIMERA corrida y con las 31 mutaciones escritas a mano EN
 * VERDE, dos controles que se podían borrar sin que un solo test se pusiera rojo. Uno de los dos no
 * era cobertura faltante: era un **bypass real** —una hija que declara `'varios'` bajo un padre
 * `es_socio` se escapa del índice PARCIAL y mete dos socios distintos bajo un `es_socio`— que
 * ninguna de las mutaciones especificadas tocaba. Ese hallazgo no lo produce escribir más tests: lo
 * produce preguntar al revés.
 *
 * Es el COMPLEMENTO del método de ADR-0002 §B.0, no su reemplazo. Aquel dice «probá la regla
 * rompiéndola»; éste pregunta «¿hay alguna regla que nadie esté probando?». Son direcciones
 * distintas, y este repo ya pagó tres veces el precio de tener sólo la primera.
 *
 * ## Cómo se corre
 *
 *   node packages/data/scripts/barrido-de-mutacion.ts \
 *     --tablas reconocimiento_contrapartida,reconocimiento_contrapartida_match \
 *     --tests packages/data/tests/mutaciones-0021.test.ts
 *
 * Sale con código 1 si algún control sobrevivió, así que sirve en CI tal cual.
 *
 * 🔴 SOLO CONTRA LOCAL, y con guard: hace DDL destructivo y `truncate`. Con `APP_ENTORNO` distinto de
 * `local` aborta antes de tocar nada.
 *
 * ## 🔴 DESPUÉS DE CORRER ESTO, RECREÁ LA BASE LOCAL
 *
 *     docker compose down -v && pnpm db:up && pnpm db:migrate && pnpm db:setup
 *
 * No es higiene: es corrección. `drop constraint` + `add constraint` deja el constraint como el MÁS
 * NUEVO de su tabla, y **Postgres evalúa las restricciones en orden de creación**. Cuando dos FK
 * cubren el mismo caso —`fk_recon_contrapartida_manifestacion` y `fk_recon_contrapartida_alcance`
 * sobre una manifestación inexistente, por ejemplo— cambia CUÁL DISPARA, y todo test que asserte el
 * NOMBRE del constraint se pone rojo sin que nada del esquema esté mal.
 *
 * Medido: tras un barrido incompleto, tres tests de `mutaciones-0021` quedaron rojos por esto y
 * volvieron a verde con sólo recrear la base. El guard de línea de base de abajo lo ataja —aborta si
 * la suite ya está roja antes de empezar—, pero conviene saber por qué pasa: el reflejo natural es
 * relajar la aserción a `/foreign key/`, y eso destruye justamente la discriminación que estos tests
 * existen para tener.
 *
 * ## 🔴 CÓMO LEER LA SALIDA — el barrido contamina sus PROPIAS mediciones posteriores
 *
 * Consecuencia directa de lo anterior: desde que recrea el PRIMER constraint, los tests
 * order-dependent quedan rojos para todo el resto de la corrida y aparecen en la lista de nombres de
 * cada control siguiente. Eso es RUIDO, no cobertura.
 *
 * La lectura correcta, y es la que importa:
 *   - **«0 rojos» es CONFIABLE.** El ruido sólo AGREGA rojos, nunca los quita, así que un control
 *     que sobrevive sobrevivió de verdad. Ése es el veredicto del script y su código de salida.
 *   - **La lista de NOMBRES no es confiable** después del primer control recreado: los que se repiten
 *     en todas las filas son el ruido de orden. Para atribuir con precisión qué test cubre qué
 *     control, hay que recrear la base y barrer ese control solo.
 *
 * Se deja así —en vez de recrear la base entre control y control— porque eso multiplicaría por
 * veintitantos el costo de una corrida para mejorar un dato secundario. El veredicto que el barrido
 * existe para dar no se ve afectado.
 *
 * ⚠️ La lista de controles se DERIVA del catálogo, nunca se escribe a mano: un constraint nuevo entra
 * al barrido solo. Es el mismo argumento por el que `version.ts` hashea POR EXCLUSIÓN — con una lista
 * a mano, el control nuevo nace fuera del barrido y en silencio.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SALTO = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const imprimir = (t: string): void => void process.stdout.write(t + SALTO);

function argumento(nombre: string): string {
  const i = process.argv.indexOf(`--${nombre}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`Falta --${nombre}. Ver el docblock de este archivo.`);
  }
  return v;
}

const TABLAS = argumento('tablas')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
const ARCHIVO_TESTS = argumento('tests');

/** Identificador del catálogo, no entrada de usuario — se valida igual: interpolar sin mirar es el
 *  hábito que un día recibe otra cosa. */
function identificador(n: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new Error(`Identificador no admitido: ${n}`);
  return n;
}

type Conteo = { readonly fallados: number; readonly pasados: number; readonly nombres: readonly string[] };

function contar(salida: string): Conteo {
  const limpio = salida.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(limpio);
  if (!m) return { fallados: -1, pasados: -1, nombres: [] };
  const nombres = [...limpio.matchAll(/[×x]\s+.*?>\s*([ML]-[A-Za-z0-9]+)/g)].map((x) => x[1] as string);
  return { fallados: Number(m[1] ?? 0), pasados: Number(m[2]), nombres: [...new Set(nombres)] };
}

function correrSuite(): Conteo {
  try {
    return contar(
      execFileSync(
        'node',
        [join(RAIZ, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ARCHIVO_TESTS, '--reporter=basic'],
        { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 },
      ),
    );
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return contar(String(e.stdout ?? '') + String(e.stderr ?? ''));
  }
}

const c = new Client({ connectionString: process.env['DATABASE_URL'] });
await c.connect();

if ((process.env['APP_ENTORNO'] ?? 'local') !== 'local') {
  await c.end();
  throw new Error('El barrido hace DDL destructivo y truncate. Corre SOLO contra local.');
}

const listaTablas = TABLAS.map(identificador);
const enLista = listaTablas.map((_, i) => `$${i + 1}`).join(', ');

// 🔴 DERIVADOS del catálogo. Se excluyen las PK: sacarlas rompe la identidad de la fila, no un
// invariante de negocio, y el ruido taparía lo que sí importa.
const constraints = (
  await c.query<{ tabla: string; nombre: string; def: string }>(
    `select rel.relname as tabla, con.conname as nombre, pg_get_constraintdef(con.oid) as def
       from pg_constraint con join pg_class rel on rel.oid = con.conrelid
      where rel.relname in (${enLista}) and con.contype <> 'p'
      order by rel.relname, con.conname`,
    listaTablas,
  )
).rows;

// Índices que NO respaldan un constraint (esos ya entran arriba): los `create unique index` sueltos,
// que es donde viven los únicos PARCIALES — y el parcial fue justamente el que tenía el bypass.
const indices = (
  await c.query<{ nombre: string; def: string }>(
    `select i.indexname as nombre, i.indexdef as def
       from pg_indexes i
       left join pg_constraint con on con.conname = i.indexname
      where i.tablename in (${enLista}) and con.oid is null
      order by i.indexname`,
    listaTablas,
  )
).rows;

const base = correrSuite();
imprimir(`LINEA DE BASE (esquema intacto): ${base.pasados} pasados, ${base.fallados} fallados`);
if (base.fallados !== 0) {
  await c.end();
  throw new Error('La suite ya está roja con el esquema intacto: el barrido mediría ruido, no controles.');
}
imprimir(`Controles derivados del catálogo: ${constraints.length} constraint(s) + ${indices.length} índice(s)${SALTO}`);

/** Con el control fuera, la suite COMMITEA filas que lo violan: hay que limpiarlas antes de devolver
 *  el constraint, o el `alter table` muere con «is violated by some row». */
const limpiar = async (): Promise<void> => {
  await c.query(`truncate ${listaTablas.join(', ')} cascade`);
};

const sobrevivientes: string[] = [];
const linea = (fallados: number, nombre: string, nombres: readonly string[]): string =>
  `${String(fallados).padStart(3)} rojos  al sacar ${nombre.padEnd(42)} ${nombres.join(' ') || '(NINGUNO: SOBREVIVIO)'}`;

/**
 * 🔴 NO TODO CONTROL ES BARRIBLE AISLADAMENTE, y el barrido tiene que decirlo en vez de morirse.
 *
 * Un `unique` que es destino de una FK no se puede dropear: Postgres responde `2BP01` («other
 * objects depend on it»). Con `cascade` se llevaría puesta la FK, y entonces el barrido ya no
 * mediría ESE control sino los dos a la vez — que es exactamente la confusión que existe para
 * evitar. Se reporta como NO BARRIBLE, con el dependiente nombrado, y se sigue.
 *
 * Lo descubrió este mismo script al derivar la lista del catálogo: la lista a mano que lo precedió
 * no incluía ningún `unique`, así que el caso nunca aparecía. Es el argumento de la derivación,
 * demostrado sobre sí mismo.
 */
const noBarribles: string[] = [];

for (const { tabla, nombre, def } of constraints) {
  try {
    await c.query(`alter table ${identificador(tabla)} drop constraint ${identificador(nombre)}`);
  } catch (error) {
    const e = error as { code?: string; detail?: string };
    if (e.code !== '2BP01') throw error;
    noBarribles.push(`${nombre} — ${e.detail ?? 'otro objeto depende de él'}`);
    imprimir(`  -- ${nombre.padEnd(46)} no barrible aisladamente (2BP01)`);
    continue;
  }
  let r: Conteo;
  try {
    r = correrSuite();
  } finally {
    await limpiar();
    await c.query(`alter table ${identificador(tabla)} add constraint ${identificador(nombre)} ${def}`);
    const vuelto = (
      await c.query<{ def: string }>('select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1', [nombre])
    ).rows[0]?.def;
    if (vuelto !== def) throw new Error(`NO SE RESTAURO ${nombre}: "${vuelto}" != "${def}"`);
  }
  if (r.fallados === 0) sobrevivientes.push(nombre);
  imprimir(linea(r.fallados, nombre, r.nombres));
}

for (const { nombre, def } of indices) {
  await c.query(`drop index ${identificador(nombre)}`);
  let r: Conteo;
  try {
    r = correrSuite();
  } finally {
    await limpiar();
    await c.query(def);
    const vuelto = (await c.query<{ def: string }>('select indexdef as def from pg_indexes where indexname = $1', [nombre]))
      .rows[0]?.def;
    if (vuelto !== def) throw new Error(`NO SE RESTAURO ${nombre}`);
  }
  if (r.fallados === 0) sobrevivientes.push(nombre);
  imprimir(linea(r.fallados, nombre, r.nombres));
}

await c.end();

// 🔴 `drop constraint` + `add constraint` NO conserva el COMMENT, y `drop index` + `create index`
// tampoco. `catalogo.test.ts` verifica que cada check nombre a su constante de TypeScript EN EL
// COMMENT, así que sin este paso el barrido deja ESE test rojo por un motivo ajeno a lo que mide — y
// quien lo vea va a creer que rompió un control cuando sólo perdió una cadena de texto.
imprimir(`${SALTO}Reaplicando los comentarios (el DDL de arriba no los conserva)...`);
execFileSync('node', [join(RAIZ, 'packages', 'data', 'scripts', 'restaurar-comentarios.ts')], {
  cwd: RAIZ,
  stdio: 'inherit',
});

if (noBarribles.length > 0) {
  imprimir(`${SALTO}=== NO BARRIBLES AISLADAMENTE (otro objeto depende de ellos) ===`);
  imprimir(noBarribles.map((n) => `  ${n}`).join(SALTO));
  imprimir('  Su cobertura la prueban las mutaciones del dependiente, no este barrido.');
}

imprimir(`${SALTO}=== SOBREVIVIENTES (control sin un solo test que lo detecte) ===`);
imprimir(sobrevivientes.length === 0 ? '  ninguno' : sobrevivientes.map((n) => `  ${n}`).join(SALTO));
process.exit(sobrevivientes.length === 0 ? 0 : 1);
