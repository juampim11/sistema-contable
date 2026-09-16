/**
 * `crearAuthProvider()` — elige el adapter por `AUTH_PROVIDER` (ADR-0006 §1).
 *
 * Catálogo CERRADO: un valor fuera de la lista lanza, nunca cae a un adapter por default. Mismo
 * criterio que `MotivoJob` en `packages/data/src/db/conexion.ts` (unión cerrada, sin agregar un caso
 * nuevo sin decisión explícita).
 */

import { z } from 'zod';
import type { AuthProvider } from './auth-provider.ts';
import type { LectorEscritorDeCookies } from './cookies.ts';
import { crearAdapterLocalFijo } from './adapters/local-fijo.ts';
import { crearAdapterSupabase } from './adapters/supabase.ts';

/**
 * Los adapters que existen hoy. `cognito` | `identity-platform` | `gotrue` figuran en el comentario
 * de `.env.example:89` como opciones futuras, pero ninguno tiene código: agregarlos acá sin
 * implementarlos sería el mismo error de fondo que `MotivoJob` (`packages/data/src/db/conexion.ts`)
 * ya evita con su unión cerrada — un valor en el catálogo sin adapter real detrás.
 */
export const ADAPTERS_AUTH = ['dev-identidad-fija', 'supabase'] as const;
export type AdapterAuth = (typeof ADAPTERS_AUTH)[number];

const esquemaAdapterAuth = z.enum(ADAPTERS_AUTH);

export class AuthProviderDesconocidoError extends Error {
  readonly codigo = 'AUTH_PROVIDER_DESCONOCIDO' as const;
  constructor(recibido: string | undefined) {
    super(
      `AUTH_PROVIDER tiene que ser uno de: ${ADAPTERS_AUTH.join(' | ')}. ` +
        `Recibido: ${recibido === undefined ? '(no definida)' : JSON.stringify(recibido)}. Ver .env.example.`,
    );
    this.name = 'AuthProviderDesconocidoError';
  }
}

export class CookiesNoProvistasParaSupabaseError extends Error {
  readonly codigo = 'AUTH_COOKIES_NO_PROVISTAS' as const;
  constructor() {
    super(
      'AUTH_PROVIDER=supabase necesita un LectorEscritorDeCookies (el adapter usa @supabase/ssr, ' +
        'ver packages/auth/src/cookies.ts) — crearAuthProvider(cookies) sin ese argumento no alcanza.',
    );
    this.name = 'CookiesNoProvistasParaSupabaseError';
  }
}

/**
 * Lee `AUTH_PROVIDER` y devuelve el adapter correspondiente.
 *
 * Lanza `AuthProviderDesconocidoError` si el valor no está en `ADAPTERS_AUTH`. Para
 * `dev-identidad-fija` fuera de `APP_ENTORNO=local`, el guard vive en `crearAdapterLocalFijo()`
 * (`AdapterLocalFueraDeEntornoLocalError`) — no se duplica ese chequeo acá: un solo lugar que
 * decide si el adapter local está habilitado.
 *
 * `cookies` es opcional acá (`dev-identidad-fija` y el catálogo desconocido nunca lo necesitan) pero
 * obligatorio en la práctica para `supabase` — lanza `CookiesNoProvistasParaSupabaseError` si falta,
 * en vez de construir un adapter que fallaría recién al invocar un método.
 */
export function crearAuthProvider(cookies?: LectorEscritorDeCookies): AuthProvider {
  const crudo = process.env['AUTH_PROVIDER'];
  const r = esquemaAdapterAuth.safeParse(crudo);
  if (!r.success) throw new AuthProviderDesconocidoError(crudo);

  switch (r.data) {
    case 'dev-identidad-fija':
      return crearAdapterLocalFijo();
    case 'supabase':
      if (!cookies) throw new CookiesNoProvistasParaSupabaseError();
      return crearAdapterSupabase(cookies);
  }
}
