/**
 * Adapter real — ADR-0006 §1/§4/§17, PR3.
 *
 * Único archivo del repo que importa `@supabase/*` (R-R). Usa `@supabase/ssr` — no un cliente "bare"
 * de `@supabase/supabase-js` — porque el adapter necesita leer/escribir la sesión vía cookies
 * (`LectorEscritorDeCookies`, `../cookies.ts`), ya decidido en PR1 (ver el comentario de cabecera de
 * ese archivo). Solo la clave anon: `SUPABASE_SERVICE_ROLE_KEY` queda reservada para
 * `apps/cli/src/invitar-usuario.ts` (R-S, ADR-0006 §4) — ningún método de este adapter la necesita,
 * `cerrarSesion` incluido (§17: revoca con la anon key + el token que ya sostienen las cookies
 * inyectadas, no con privilegio de admin).
 *
 * La identidad que cruza hacia `Sesion` es solo el `usuarioId` (uuid) de Supabase + `expiraEn` — nunca
 * el JWT ni ningún dato de la cookie: `Sesion` sigue siendo opaca (§1).
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { logger } from '@sistema-contable/shared/observabilidad';
import type { AuthProvider, Credenciales, Sesion } from '../auth-provider.ts';
import type { CookieAEstablecer, LectorEscritorDeCookies, OpcionesDeCookie } from '../cookies.ts';

/**
 * Se deriva del propio `createServerClient` en vez de importar `SupabaseClient` de
 * `@supabase/supabase-js` — con `exactOptionalPropertyTypes` (tsconfig del repo), mezclar los tipos
 * genéricos por default de los dos paquetes dispara "Type instantiation is excessively deep" en el
 * compilador. Mismo cliente en runtime, tipo derivado sin el conflicto.
 */
export type ClienteSupabase = ReturnType<typeof createServerClient>;

export class SupabaseEnvNoConfiguradoError extends Error {
  readonly codigo = 'AUTH_SUPABASE_ENV_NO_CONFIGURADO' as const;
  constructor() {
    super('SUPABASE_URL y SUPABASE_ANON_KEY tienen que estar configuradas. Ver .env.example.');
    this.name = 'SupabaseEnvNoConfiguradoError';
  }
}

/**
 * Credenciales inválidas, cuenta inexistente o cuenta baneada — un solo tipo, a propósito (hallazgo de
 * `security-engineer`, convocatoria de PR3): distinguir estos tres casos en el mensaje de error
 * confirmaría del lado del servidor la existencia o el estado de una cuenta ante quien intenta el
 * login — la misma fuga que "verificar del lado del servidor" existe para evitar. Mensaje fijo, sin
 * interpolar nada que venga de Supabase ni del propio intento de login.
 */
export class CredencialesInvalidasError extends Error {
  readonly codigo = 'AUTH_CREDENCIALES_INVALIDAS' as const;
  constructor() {
    super('credenciales inválidas');
    this.name = 'CredencialesInvalidasError';
  }
}

/**
 * Falla de infraestructura: red caída, timeout, 5xx del proveedor, o el propio
 * `LectorEscritorDeCookies` inyectado tirando (cookie corrupta/truncada). Deliberadamente separado de
 * `CredencialesInvalidasError` — es seguro exponer que "Supabase está caído" sin revelar nada de una
 * cuenta puntual.
 */
export class FallaInfraestructuraAuthError extends Error {
  readonly codigo = 'AUTH_FALLA_INFRAESTRUCTURA' as const;
  constructor() {
    super('no se pudo contactar al proveedor de autenticación');
    this.name = 'FallaInfraestructuraAuthError';
  }
}

/** Cota conservadora para `expiraEn` en `obtenerSesion` — ver el comentario ahí. */
const MARGEN_EXPIRACION_MS = 5 * 60 * 1000;

function variablesDeEntorno(): { url: string; anonKey: string } {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  if (!url || !anonKey) throw new SupabaseEnvNoConfiguradoError();
  return { url, anonKey };
}

/**
 * `OpcionesDeCookie.sameSite` no acepta booleano ni `undefined` como valor asignado
 * (`exactOptionalPropertyTypes`); `@supabase/ssr` sí lo permite. Se normaliza acá, omitiendo la clave
 * en vez de asignarle `undefined` cuando no hay valor útil.
 */
function opcionesDesdeSupabase(opciones: CookieOptions | undefined): OpcionesDeCookie | undefined {
  if (!opciones) return undefined;
  const resultado: { -readonly [K in keyof OpcionesDeCookie]?: OpcionesDeCookie[K] } = {};
  if (opciones.domain !== undefined) resultado.dominio = opciones.domain;
  if (opciones.path !== undefined) resultado.ruta = opciones.path;
  if (opciones.maxAge !== undefined) resultado.maxEdadSegundos = opciones.maxAge;
  if (opciones.httpOnly !== undefined) resultado.httpOnly = opciones.httpOnly;
  if (opciones.secure !== undefined) resultado.secure = opciones.secure;
  if (opciones.sameSite !== undefined && opciones.sameSite !== false) {
    resultado.sameSite = opciones.sameSite === true ? 'strict' : opciones.sameSite;
  }
  return resultado;
}

/** Construye el cliente `@supabase/ssr` ligado al lector/escritor de cookies del pedido actual. */
function clienteServidor(cookies: LectorEscritorDeCookies): ClienteSupabase {
  const { url, anonKey } = variablesDeEntorno();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookies.obtenerTodas().map(({ nombre, valor }) => ({ name: nombre, value: valor })),
      setAll: (lista) => {
        const aEstablecer: CookieAEstablecer[] = lista.map(({ name, value, options }) => {
          const opcionesMapeadas = opcionesDesdeSupabase(options);
          return opcionesMapeadas
            ? { nombre: name, valor: value, opciones: opcionesMapeadas }
            : { nombre: name, valor: value };
        });
        cookies.establecerTodas(aEstablecer);
      },
    },
  });
}

/**
 * Adapter real de Supabase.
 *
 * @param cookies Lector/escritor de cookies del pedido actual — lo implementa `apps/web` (vía
 *   `next/headers`, sin que este paquete importe `next/*`, R-X).
 * @param clienteInyectado Solo para tests: evita construir el cliente real (y por lo tanto la llamada
 *   de red) cuando ya se tiene un cliente Supabase mockeado. Nunca se usa en código de producción.
 */
export function crearAdapterSupabase(
  cookies: LectorEscritorDeCookies,
  clienteInyectado?: ClienteSupabase,
): AuthProvider {
  const cliente = () => clienteInyectado ?? clienteServidor(cookies);

  return {
    async iniciarSesion(credenciales: Credenciales): Promise<Sesion> {
      // `cliente()` puede lanzar `SupabaseEnvNoConfiguradoError` (config faltante) — deliberadamente
      // AFUERA del try/catch de abajo, que es solo para la llamada de red: un error de configuración
      // no es una falla de infraestructura transitoria, y no tiene que quedar tapado como una.
      const c = cliente();
      let respuesta: Awaited<ReturnType<ClienteSupabase['auth']['signInWithPassword']>>;
      try {
        respuesta = await c.auth.signInWithPassword(credenciales);
      } catch {
        throw new FallaInfraestructuraAuthError();
      }

      const { data, error } = respuesta;
      if (error) {
        if ((error.status ?? 500) >= 500) throw new FallaInfraestructuraAuthError();
        throw new CredencialesInvalidasError();
      }
      if (!data.user || !data.session || !data.session.expires_at) throw new FallaInfraestructuraAuthError();

      return {
        usuarioId: data.user.id,
        expiraEn: new Date(data.session.expires_at * 1000).toISOString(),
      };
    },

    async cerrarSesion(_sesion: Sesion): Promise<void> {
      // Mismo criterio que `iniciarSesion`: `cliente()` afuera del try/catch de la llamada de red.
      const c = cliente();
      try {
        // scope 'local': revoca solo esta sesión puntual, no todas las de este usuario en otros
        // dispositivos (ADR-0006 §17). No usa `_sesion` — la sesión a cerrar es la que ya sostienen
        // las cookies inyectadas, coherente con que `Sesion` es opaca (nunca lleva el token).
        const { error } = await c.auth.signOut({ scope: 'local' });
        if (error) throw new FallaInfraestructuraAuthError();
      } catch {
        // Cualquier falla acá (la de arriba o una excepción de red) es la misma categoría — no hace
        // falta distinguir instancia, el catch la pisa igual (hallazgo de `code-reviewer`, PR3).
        throw new FallaInfraestructuraAuthError();
      }
    },

    async obtenerSesion(_pedido: Request): Promise<Sesion | null> {
      // `_pedido` no se usa: las cookies llegan por el `LectorEscritorDeCookies` inyectado en la
      // construcción del adapter (framework-agnostic, R-X), no releyendo el Request acá.

      // `cliente()` en su propio try/catch, SEPARADO del de la llamada de red de abajo (hallazgo
      // bloqueante de `code-reviewer`, PR3): este método está contratado a "nunca lanza" (§1, `Sesion
      // | null`), así que un `SupabaseEnvNoConfiguradoError` no puede propagar como en `iniciarSesion`/
      // `cerrarSesion` — pero tampoco puede quedar indistinguible de "no hay sesión": sin esto, un
      // despliegue con `SUPABASE_URL`/`SUPABASE_ANON_KEY` mal configuradas deja a TODOS los usuarios
      // "deslogueados" en cada request, sin ningún rastro. Se hace visible con `logger.error` — que
      // redacta `causa` automáticamente (nombre + mensaje, sin stack) — y devuelve `null` igual.
      let c: ClienteSupabase;
      try {
        c = cliente();
      } catch (e) {
        logger.error('auth.supabase.obtener_sesion.config_invalida', undefined, e);
        return null;
      }

      try {
        // getUser(), nunca getSession() (ADR-0006 §4): valida contra el servidor de Auth en cada
        // llamada, en vez de confiar en la cookie sin verificar. Por eso, a propósito, este método
        // NO llama también a getSession() para leer el expires_at real (sería la misma cookie sin
        // validar que la regla existe para evitar) — expiraEn queda como cota conservadora, no como
        // el vencimiento exacto del token. Ningún control de seguridad depende de esta precisión: la
        // autorización real es RLS en Postgres (ADR-0001), no esta fecha.
        const { data, error } = await c.auth.getUser();
        if (error) {
          // Mismo criterio que el catch de `cliente()` arriba: "no hay sesión" (sin cookie, cookie
          // vencida/inválida — un 4xx normal, pasa en cada visita anónima) no es lo mismo que "no pude
          // verificar porque Supabase falló" (5xx, rate limit sin status claro). Lo primero es
          // silencioso a propósito (loguearlo en cada request sin sesión sería ruido constante); lo
          // segundo se hace visible, mismo mecanismo que el hallazgo bloqueante de `code-reviewer` ya
          // corrigió para el error de configuración — `logger.error` redacta `causa` automáticamente.
          if ((error.status ?? 500) >= 500) {
            logger.error('auth.supabase.obtener_sesion.falla_verificacion', undefined, error);
          }
          return null;
        }
        if (!data.user) return null;

        return { usuarioId: data.user.id, expiraEn: new Date(Date.now() + MARGEN_EXPIRACION_MS).toISOString() };
      } catch (e) {
        // Una excepción acá (red caída, timeout) SIEMPRE es "no pude verificar", nunca "no hay sesión"
        // — se distingue de la rama de arriba justamente porque no hubo respuesta que interpretar.
        logger.error('auth.supabase.obtener_sesion.falla_verificacion', undefined, e);
        return null;
      }
    },
  };
}
