/**
 * Carga `.env` de la raíz sin sumar una dependencia. 25 líneas, y evita un paquete más en el árbol.
 *
 * No sobrescribe una variable ya definida en el ambiente: en CI y en un contenedor manda el ambiente,
 * y un `.env` olvidado en el disco no puede pisarlo.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function raizDelRepo(): string {
  // .../tools/cargar-env.ts -> la raíz es un nivel arriba de tools/
  // fileURLToPath y no `new URL(...).pathname`: en Windows el pathname viene como "/C:/..." y hay que
  // sacarle la barra a mano. Es un bug clásico y la librería estándar ya lo resuelve.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Carga las variables de un archivo de entorno.
 *
 * `ENV_FILE` permite apuntar a otro archivo, y existe por una razón concreta: **el piloto corre contra una
 * base distinta de la de los tests**. Los tests truncan `tenant_node` y todo lo que cuelga, así que compartir
 * base significaría que un `pnpm test` borra el material real de un cliente y su rastro de auditoría — y la
 * pérdida no deja hueco, deja vacío.
 *
 *     ENV_FILE=.env.piloto pnpm alta:cuenta …
 *
 * El archivo del piloto está gitignoreado igual que el `.env`.
 */
export function cargarEnv(
  archivo = join(raizDelRepo(), process.env['ENV_FILE'] ?? '.env'),
): void {
  if (!existsSync(archivo)) return;

  for (const linea of readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;

    const igual = limpia.indexOf('=');
    if (igual <= 0) continue;

    const clave = limpia.slice(0, igual).trim();
    let valor = limpia.slice(igual + 1).trim();

    // Un comentario al final de la línea no es parte del valor.
    const comentario = valor.indexOf(' #');
    if (comentario > -1) valor = valor.slice(0, comentario).trim();

    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }

    if (process.env[clave] === undefined) process.env[clave] = valor;
  }
}
