/**
 * Reaplica los `comment on constraint` y `comment on index` de una migración, leyéndolos del propio
 * `.sql`. Complemento obligado de `barrido-de-mutacion.ts`.
 *
 * 🔴 LA LECCIÓN QUE LO HIZO NECESARIO, y que no está escrita en ningún otro lado del repo:
 * `alter table drop constraint` + `add constraint` **NO conserva el COMMENT**, y
 * `drop index` + `create index` tampoco. `catalogo.test.ts` verifica que cada check nombre a su
 * constante de TypeScript **en el comment**, así que un barrido que restaura sólo la DEFINICIÓN deja
 * ese test rojo por una razón que no tiene nada que ver con lo que está midiendo — y quien lo vea va
 * a creer que rompió un control cuando sólo perdió una cadena de texto.
 *
 * ## Cómo se corre
 *
 *   node packages/data/scripts/restaurar-comentarios.ts [--migracion 0021_determinante_de_entrada_y_capa_c.sql]
 *
 * Sin `--migracion` toma la ÚLTIMA por orden de nombre, que es la que un barrido acaba de tocar.
 *
 * ⚠️ Los objetivos se DERIVAN del archivo, no se listan a mano: un `comment on` nuevo se reaplica
 * solo. Una lista a mano acá tendría el mismo defecto que la lista a mano del barrido.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const MIGRACIONES = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SALTO = String.fromCharCode(10);
const imprimir = (t: string): void => void process.stdout.write(t + SALTO);

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v === undefined || v.startsWith('--') ? undefined : v;
}

const archivo =
  argumento('migracion') ??
  readdirSync(MIGRACIONES)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .at(-1);
if (archivo === undefined) throw new Error('No hay migraciones.');

const lineas = readFileSync(join(MIGRACIONES, archivo), 'utf8').split(/\r?\n/);

/**
 * Extrae cada sentencia `comment on constraint|index` completa: arranca en la línea que la abre y
 * corta en la primera que termina en `;`. Los `comment on` de este repo son multilínea (cadenas
 * concatenadas), así que no alcanza con leer una línea.
 */
const sentencias: string[] = [];
for (let i = 0; i < lineas.length; i += 1) {
  const l = lineas[i] ?? '';
  if (!/^comment on (constraint|index) /.test(l)) continue;
  let j = i;
  while (j < lineas.length && !(lineas[j] ?? '').trimEnd().endsWith(';')) j += 1;
  if (j >= lineas.length) throw new Error(`Sentencia sin cerrar a partir de: ${l}`);
  sentencias.push(lineas.slice(i, j + 1).join(SALTO));
  i = j;
}

if (sentencias.length === 0) throw new Error(`No hay comentarios de constraint ni de índice en ${archivo}.`);

const c = new Client({ connectionString: process.env['DATABASE_URL'] });
await c.connect();
try {
  for (const s of sentencias) {
    await c.query(s);
    imprimir(`  OK ${(s.split(SALTO)[0] ?? '').slice(0, 96)}`);
  }
  imprimir(`${sentencias.length} comentario(s) reaplicado(s) desde ${archivo}.`);
} finally {
  await c.end();
}
