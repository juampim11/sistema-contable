/**
 * Forma mínima de un lector/escritor de cookies — ADR-0006 §1.
 *
 * Un adapter de sesión basado en cookies (el de Supabase, PR3, vía `@supabase/ssr`) necesita leer
 * todas las cookies del pedido y poder fijar una lista nueva en la respuesta. Este tipo describe esa
 * forma sin importar nada de `next/*` (R-X): quien implementa `LectorEscritorDeCookies` en
 * `apps/web` es responsable de adaptarlo a `next/headers`, no al revés.
 */

/** Una cookie tal como llega en el pedido: solo nombre y valor. */
export type CookieLeida = {
  readonly nombre: string;
  readonly valor: string;
};

/**
 * Atributos de una cookie al fijarla. Ninguno es obligatorio: el caller decide cuáles setear y el
 * framework destino completa el resto con sus propios defaults.
 */
export type OpcionesDeCookie = {
  readonly dominio?: string;
  readonly ruta?: string;
  readonly maxEdadSegundos?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: 'lax' | 'strict' | 'none';
};

/** Una cookie a escribir: nombre, valor y sus opciones (si las hay). */
export type CookieAEstablecer = CookieLeida & {
  readonly opciones?: OpcionesDeCookie;
};

/**
 * Lo único que un adapter de sesión basado en cookies necesita del framework que lo hospeda: leer
 * todas las cookies del pedido, y fijar una lista nueva. Nada de `get`/`set` individual — el SDK de
 * Supabase (y cualquier otro que siga el mismo patrón) trabaja con la lista completa de una vez.
 */
export type LectorEscritorDeCookies = {
  readonly obtenerTodas: () => readonly CookieLeida[];
  readonly establecerTodas: (cookies: readonly CookieAEstablecer[]) => void;
};
