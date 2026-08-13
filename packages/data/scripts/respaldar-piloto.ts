/**
 * RESPALDO DEL PILOTO — `pg_dump` manual, vía `docker exec`. Nace del incidente del 2026-08-12: un
 * `docker volume rm` de la base de desarrollo se llevó puesta la del piloto porque en ese momento
 * compartían volumen, y no existía ni un respaldo ni un script para hacerlo. `docker-compose.piloto.yml`
 * cierra la causa de raíz (contenedor propio); esto es la red que falta si igual pasa algo — un bug de
 * Docker, un disco que falla, un `rm -rf` mal apuntado al volumen nuevo.
 *
 * **Manual a propósito, no un cron.** El pedido explícito fue "que exista y quede documentado cómo
 * correrlo" — no un mecanismo automático. Automatizarlo es la mejora obvia del día que alguien lo
 * necesite y no esté: se deja declarado como el paso siguiente, no resuelto acá.
 *
 *     pnpm respaldar:piloto
 *
 * Apunta SIEMPRE al contenedor y a la base del piloto — está hardcodeado a propósito, no lee
 * `ENV_FILE`: es una herramienta de un solo uso y el peor error posible es que alguien la corra
 * pensando que respalda el piloto y en realidad respalde otra cosa por una variable mal seteada.
 *
 * Formato `-F c` (custom, comprimido) — no `.sql` plano: permite restaurar tablas sueltas con
 * `pg_restore -t <tabla>` sin tener que aplicar el dump completo, y es bastante más chico.
 *
 * ## Cómo restaurar
 *
 *     docker exec -i sistema-contable-postgres-piloto pg_restore -U sistema_contable \
 *       --clean --if-exists --no-owner -d sistema_contable_piloto \
 *       < respaldos/<archivo>.dump
 *
 * `--clean --if-exists`: dropea lo que ya exista antes de restaurar, para que un restore sobre una
 * base que ya tiene esquema (por ejemplo, recién migrada) no choque con objetos duplicados.
 * `--no-owner`: el dump se hizo con el usuario `sistema_contable`; si el que restaura corre con otro
 * usuario, no hace falta que el owner original exista en el destino.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { raizDelRepo } from '../../../tools/cargar-env.ts';

const CONTENEDOR = 'sistema-contable-postgres-piloto';
const USUARIO_DB = 'sistema_contable';
const BASE = 'sistema_contable_piloto';

function marcaDeTiempo(): string {
  // AAAAMMDD-HHMMSS en UTC, sin separadores que compliquen un nombre de archivo en Windows.
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '-');
}

function main(): void {
  const directorio = join(raizDelRepo(), 'respaldos');
  mkdirSync(directorio, { recursive: true });

  const archivo = join(directorio, `piloto_${marcaDeTiempo()}.dump`);

  // `docker exec` con `pg_dump -Fc` escribiendo a stdout DENTRO del contenedor, redirigido al
  // archivo en el host — así no hace falta instalar `pg_dump` en la máquina que corre esto, solo
  // Docker (mismo criterio de portabilidad que el resto del repo, ADR-0000).
  const salida = execFileSync(
    'docker',
    ['exec', CONTENEDOR, 'pg_dump', '-U', USUARIO_DB, '-d', BASE, '-F', 'c'],
    { maxBuffer: 1024 * 1024 * 1024 },
  );

  writeFileSync(archivo, salida);

  process.stdout.write(`Respaldo escrito: ${archivo}\n`);
  process.stdout.write(`Tamaño: ${(salida.length / 1024 / 1024).toFixed(2)} MB\n`);
  process.stdout.write('\n');
  process.stdout.write('Para restaurar:\n');
  process.stdout.write(
    `  docker exec -i ${CONTENEDOR} pg_restore -U ${USUARIO_DB} --clean --if-exists --no-owner ` +
      `-d ${BASE} < ${archivo}\n`,
  );
}

main();
