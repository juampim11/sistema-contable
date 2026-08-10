/**
 * Lectura y validación del entorno — ADR-0002 §E.1.
 *
 * Dos reglas que valen más que el resto de este archivo:
 *
 *   1. **`APP_ENTORNO` es obligatoria y SIN default.** Lo que no está declarado explícitamente como
 *      desarrollo se trata como producción. Es lista de permitidos, no de prohibidos. Un default es
 *      justamente el modo de falla que esta variable existe para eliminar.
 *   2. **Cada proceso lee SOLO su DSN.** El de request no puede leer el de jobs: si lo hace, es un
 *      error de arranque, no un warning (R18).
 */

import { z } from 'zod';

/**
 * Los cuatro entornos.
 *
 * **`piloto` no es un sinónimo de `local`.** Es la máquina de trabajo corriendo contra una base que contiene
 * **material real de un cliente**, con autorización registrada (`docs/seguridad/registro-excepciones.md`
 * E-1). La distinción existe porque cambia qué se puede correr:
 *
 * | | `local` | `piloto` |
 * |---|---|---|
 * | Datos | sintéticos | **reales, de un cliente** |
 * | `pnpm db:seed` | sí | **no**: truncaría el rastro de auditoría |
 * | `pnpm test` | sí | **no**: el helper de siembra trunca `tenant_node` |
 * | Pepper de `.env.example` | tolerado | **rechazado** |
 *
 * Sin esta separación, `pnpm test` —que se corre veinte veces por día— **borra el material del piloto y su
 * rastro de auditoría**, y la pérdida no deja hueco: deja vacío.
 */
export const ENTORNOS = ['local', 'piloto', 'staging', 'produccion'] as const;
export type Entorno = (typeof ENTORNOS)[number];

const esquemaEntorno = z.enum(ENTORNOS);

export function entornoActual(): Entorno {
  const crudo = process.env['APP_ENTORNO'];
  const r = esquemaEntorno.safeParse(crudo);
  if (!r.success) {
    throw new Error(
      `APP_ENTORNO es obligatoria y sin default. Valores permitidos: ${ENTORNOS.join(' | ')}. ` +
        `Recibido: ${crudo === undefined ? '(no definida)' : JSON.stringify(crudo)}. Ver .env.example.`,
    );
  }
  return r.data;
}

export function esLocal(): boolean {
  return entornoActual() === 'local';
}

const esquemaDsn = z.string().min(1).startsWith('postgres');

function leerDsn(nombre: string): string {
  const r = esquemaDsn.safeParse(process.env[nombre]);
  if (!r.success) {
    throw new Error(
      `Falta o es inválida la variable ${nombre} (tiene que ser un DSN de Postgres). Ver .env.example.`,
    );
  }
  return r.data;
}

/** DSN del rol SUJETO A RLS (`app_request`). Es el único que puede atender a una persona. */
export function dsnRequest(): string {
  return leerDsn('DATABASE_URL_APP');
}

/**
 * DSN del rol que SALTEA RLS (`app_job`). Solo lo lee un proceso de servidor, y solo para la
 * whitelist de ADR-0002 R19. Que esta función exista no habilita a usarla: ver `conJob`.
 */
export function dsnJob(): string {
  return leerDsn('DATABASE_URL_JOB');
}

/** DSN del dueño del esquema. SOLO scripts de migración. Ningún proceso que atienda pedidos. */
export function dsnDuenio(): string {
  return leerDsn('DATABASE_URL');
}
