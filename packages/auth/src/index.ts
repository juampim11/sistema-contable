export type { AuthProvider, Credenciales, Sesion } from './auth-provider.ts';
export type {
  CookieAEstablecer,
  CookieLeida,
  LectorEscritorDeCookies,
  OpcionesDeCookie,
} from './cookies.ts';
export { ADAPTERS_AUTH, AuthProviderDesconocidoError, crearAuthProvider } from './registro.ts';
export type { AdapterAuth } from './registro.ts';
export {
  AdapterLocalFueraDeEntornoLocalError,
  crearAdapterLocalFijo,
  DevUserIdNoConfiguradoError,
} from './adapters/local-fijo.ts';
export { AdapterSupabaseNoImplementadoError, crearAdapterSupabase } from './adapters/supabase.ts';
