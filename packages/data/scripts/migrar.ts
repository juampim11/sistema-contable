/**
 * Aplicador de migraciones — ADR-0000 §5.
 *
 * Aplica en orden los `.sql` de `packages/data/migrations/`, una sola vez cada uno, registrando lo
 * aplicado en `_migraciones` con el hash del archivo. Corre con el **dueño del esquema**.
 *
 *   pnpm db:migrate            aplica lo pendiente
 *   pnpm db:migrate --estado   solo informa, no aplica
 *
 * POR QUÉ UN SCRIPT PROPIO Y NO `drizzle-kit migrate` (desvío consciente de ADR-0000 §5):
 * `drizzle-kit` genera DDL a partir de un esquema TypeScript y lleva su propio journal. Nuestras
 * migraciones son **SQL escrito a mano** (RLS, policies, triggers, roles, grants por columna) porque
 * eso es lo que Drizzle no modela. Aplicarlas con su journal es pelearse con la herramienta. Cuando
 * exista el esquema TS, `drizzle-kit` se usa para **generar** el DDL de tablas; el aplicador sigue
 * siendo este, que son 60 líneas y solo necesita un `DATABASE_URL` (o sea, igual de portable).
 *
 * NUNCA se edita una migración ya aplicada: el hash cambia y el script lo detecta y aborta.
 *
 * 🔴 EL HASH SE CALCULA SOBRE EL CONTENIDO NORMALIZADO A LF, y eso no es un detalle de estilo.
 * Con `core.autocrlf=true` (el default de Git for Windows) el checkout reescribe cada `.sql` a
 * CRLF y el sha256 cambia **sin que nadie haya editado nada**: el script abortaba con "ya fue
 * aplicada con otro contenido" en un repo intacto, y el mismo repo daba distinto en Windows y en
 * Linux. Un control que se dispara cuando no pasó nada es un control que alguien desactiva — y
 * este guarda algo que sí importa. `.gitattributes` ataca la otra mitad del problema (el working
 * tree); esto lo hace independiente de la plataforma incluso en una copia ya clonada.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const DIRECTORIO = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

type Migracion = { nombre: string; sql: string; hash: string };

function leerMigraciones(): Migracion[] {
  return readdirSync(DIRECTORIO)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((nombre) => {
      const sql = readFileSync(join(DIRECTORIO, nombre), 'utf8');
      // El hash va sobre el contenido, no sobre cómo lo codificó el checkout. Ver el encabezado.
      const normalizado = sql.replaceAll('\r\n', '\n');
      return {
        nombre,
        sql,
        hash: createHash('sha256').update(normalizado).digest('hex').slice(0, 16),
      };
    });
}

async function principal(): Promise<void> {
  const soloEstado = process.argv.includes('--estado');
  const dsn = process.env['DATABASE_URL'];
  if (!dsn) throw new Error('Falta DATABASE_URL (dueño del esquema). Ver .env.example.');

  const cliente = new Client({ connectionString: dsn });
  await cliente.connect();

  try {
    await cliente.query(`
      create table if not exists _migraciones (
        nombre      text primary key,
        hash        text not null,
        aplicada_en timestamptz not null default now()
      )
    `);

    const { rows: aplicadas } = await cliente.query<{ nombre: string; hash: string }>(
      'select nombre, hash from _migraciones',
    );
    const porNombre = new Map(aplicadas.map((f) => [f.nombre, f.hash]));

    for (const m of leerMigraciones()) {
      const hashAplicado = porNombre.get(m.nombre);

      if (hashAplicado === m.hash) {
        process.stdout.write(`  = ${m.nombre} (ya aplicada)\n`);
        continue;
      }
      if (hashAplicado !== undefined) {
        throw new Error(
          `${m.nombre} ya fue aplicada con otro contenido (hash ${hashAplicado} -> ${m.hash}). ` +
            'Una migración aplicada NO se edita: creá la siguiente con prefijo incremental.',
        );
      }
      if (soloEstado) {
        process.stdout.write(`  + ${m.nombre} (PENDIENTE)\n`);
        continue;
      }

      process.stdout.write(`  + ${m.nombre} … `);
      // Cada archivo trae su propio begin/commit; se ejecuta tal cual para no anidar transacciones.
      await cliente.query(m.sql);
      await cliente.query('insert into _migraciones (nombre, hash) values ($1, $2)', [
        m.nombre,
        m.hash,
      ]);
      process.stdout.write('aplicada\n');
    }
  } finally {
    await cliente.end();
  }
}

await principal();
