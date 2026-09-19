'use server';

/**
 * Server Action de login — NO pasa por `conSesion()` a propósito (exención declarada de R-W, ver el
 * comentario en `reglas-de-codigo.test.ts`): establecer una sesión no puede requerir una que todavía
 * no existe. Arma su propio `AuthProvider` con el mismo `LectorEscritorDeCookies` que `sesion.ts` usa
 * para leer — acá, además, `@supabase/ssr` puede ESCRIBIR la cookie de sesión (una Server Action sí
 * tiene response mutable, a diferencia de un Server Component puro).
 *
 * El redirect de "sesión ya activa en `/login`" NO se implementa acá — nunca fue aprobado como
 * decisión final (HANDOFF, entrada 230/233).
 */
import { redirect } from 'next/navigation';
import {
  crearAuthProvider,
  CredencialesInvalidasError,
  FallaInfraestructuraAuthError,
} from '@sistema-contable/auth';
import { cookiesDeNextHeaders } from '../../servidor/sesion.ts';

export type EstadoLogin =
  | { readonly tipo: 'inicial' }
  | { readonly tipo: 'credenciales_invalidas' }
  | { readonly tipo: 'falla_infraestructura' };

// `ESTADO_LOGIN_INICIAL` NO vive acá: un archivo `'use server'` solo puede exportar funciones async
// (hallazgo real, medido en vivo con el navegador) — un `const` objeto revienta en runtime con "A
// 'use server' file can only export async functions, found object". El valor inicial se declara en
// `page.tsx`, que sí puede tener el literal.

export async function iniciarSesionAction(
  _previo: EstadoLogin,
  formData: FormData,
): Promise<EstadoLogin> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  const cookiesAdapter = await cookiesDeNextHeaders();
  const authProvider = crearAuthProvider(cookiesAdapter);

  try {
    await authProvider.iniciarSesion({ email, password });
  } catch (error) {
    if (error instanceof CredencialesInvalidasError) return { tipo: 'credenciales_invalidas' };
    if (error instanceof FallaInfraestructuraAuthError) return { tipo: 'falla_infraestructura' };
    throw error;
  }

  redirect('/wizard');
}
