/**
 * Stub deliberado — ADR-0006 §1. El adapter real se implementa en PR3 de ese ADR.
 *
 * Este archivo existe HOY, sin ningún SDK de Supabase instalado, para que la regla de código que
 * confina `@supabase/*` a un único archivo (R-R, `packages/data/tests/reglas-de-codigo.test.ts`)
 * tenga algo real que vigilar desde el día uno — antes de que el import de verdad llegue. No se
 * instala `@supabase/supabase-js` ni `@supabase/ssr` en esta tarea (fuera de alcance del PR1).
 */

import type { AuthProvider, Credenciales, Sesion } from '../auth-provider.ts';

const MENSAJE_NO_IMPLEMENTADO = 'adapter Supabase: implementar en PR 3 de ADR-0006';

export class AdapterSupabaseNoImplementadoError extends Error {
  readonly codigo = 'AUTH_SUPABASE_NO_IMPLEMENTADO' as const;
  constructor() {
    super(MENSAJE_NO_IMPLEMENTADO);
    this.name = 'AdapterSupabaseNoImplementadoError';
  }
}

/**
 * Único adapter del repo que en algún momento (PR3) va a importar `@supabase/*`. Hoy lanza en sus
 * tres métodos — a propósito, no es un olvido.
 */
export function crearAdapterSupabase(): AuthProvider {
  return {
    // `async` a propósito: así el `throw` se ve como una promesa rechazada (coherente con la firma
    // de `AuthProvider`, que devuelve `Promise<...>` en los tres métodos), no como una excepción
    // síncrona al invocar la función.
    async iniciarSesion(_credenciales: Credenciales): Promise<Sesion> {
      throw new AdapterSupabaseNoImplementadoError();
    },
    async cerrarSesion(_sesion: Sesion): Promise<void> {
      throw new AdapterSupabaseNoImplementadoError();
    },
    async obtenerSesion(_pedido: Request): Promise<Sesion | null> {
      throw new AdapterSupabaseNoImplementadoError();
    },
  };
}
