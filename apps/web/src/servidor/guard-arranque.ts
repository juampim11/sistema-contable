/**
 * Guard de arranque del proceso `apps/web` — análogo a `verificarCredencialDeRequest`
 * (`packages/data/src/db/conexion.ts`, R18), del lado de identidad en vez de datos.
 *
 * Dictamen de `security-engineer` (convocatoria PR4): un chequeo en TEST no alcanza — existe para
 * atrapar un error de CONFIGURACIÓN DE DESPLIEGUE (una variable de servidor filtrada al proceso web),
 * algo que CI no puede ver. Corre en runtime, una vez por instancia, desde `instrumentation.ts`.
 *
 * Pura (recibe el `env`, no lee `process.env` directo) — testable sin depender del proceso real.
 */

const VARIABLES_PROHIBIDAS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL_JOB',
  'DATABASE_URL', // DSN del dueño del esquema — mismo criterio que R18 para app_job/app_request.
] as const;

export class VariableDeServidorFiltradaError extends Error {
  readonly codigo = 'AUTH_VARIABLE_DE_SERVIDOR_FILTRADA' as const;
  constructor(readonly variable: string) {
    super(
      `El proceso de apps/web tiene "${variable}" configurada — esa credencial es del servidor de ` +
        'jobs/migraciones, nunca de la app web. Revisar la configuración de despliegue (Vercel/CI): ' +
        'apps/web solo necesita DATABASE_URL_APP, SUPABASE_URL y SUPABASE_ANON_KEY.',
    );
    this.name = 'VariableDeServidorFiltradaError';
  }
}

export function verificarGuardDeArranque(env: Record<string, string | undefined> = process.env): void {
  for (const variable of VARIABLES_PROHIBIDAS) {
    if (env[variable] !== undefined && env[variable] !== '') {
      throw new VariableDeServidorFiltradaError(variable);
    }
  }
}
