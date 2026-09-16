import { afterAll, describe, expect, it, vi } from 'vitest';
import { logger } from '@sistema-contable/shared/observabilidad';
import {
  crearAdapterSupabase,
  CredencialesInvalidasError,
  FallaInfraestructuraAuthError,
  SupabaseEnvNoConfiguradoError,
  type ClienteSupabase,
} from '../src/adapters/supabase.ts';
import type { CookieAEstablecer, CookieLeida, LectorEscritorDeCookies } from '../src/cookies.ts';

const UUID_SINTETICO = '11111111-2222-4333-8444-555555555555';
const SUPABASE_URL_ORIGINAL = process.env['SUPABASE_URL'];
const SUPABASE_ANON_KEY_ORIGINAL = process.env['SUPABASE_ANON_KEY'];

process.env['SUPABASE_URL'] = 'https://proyecto-sintetico.supabase.co';
process.env['SUPABASE_ANON_KEY'] = 'clave-anon-sintetica';

afterAll(() => {
  if (SUPABASE_URL_ORIGINAL === undefined) delete process.env['SUPABASE_URL'];
  else process.env['SUPABASE_URL'] = SUPABASE_URL_ORIGINAL;
  if (SUPABASE_ANON_KEY_ORIGINAL === undefined) delete process.env['SUPABASE_ANON_KEY'];
  else process.env['SUPABASE_ANON_KEY'] = SUPABASE_ANON_KEY_ORIGINAL;
});

/**
 * `LectorEscritorDeCookies` de prueba — nunca toca cookies reales. Cada test lee `establecidas` para
 * verificar qué se intentó escribir, sin loguear el valor (mismo criterio que se le exige al adapter:
 * el valor de una cookie de sesión no aparece en ninguna salida, ni siquiera de test).
 */
function cookiesDePrueba(iniciales: readonly CookieLeida[] = []): LectorEscritorDeCookies & {
  establecidas: CookieAEstablecer[];
} {
  const establecidas: CookieAEstablecer[] = [];
  return {
    establecidas,
    obtenerTodas: () => iniciales,
    establecerTodas: (lista) => {
      establecidas.push(...lista);
    },
  };
}

/**
 * Cliente Supabase mockeado — inyectado vía el segundo argumento de `crearAdapterSupabase`, nunca
 * `vi.mock` global (evita que un mock de módulo se filtre a otros tests del paquete). Cero red real.
 */
function clienteMock(overrides: Partial<ClienteSupabase['auth']> = {}): ClienteSupabase {
  return {
    auth: {
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
      getUser: vi.fn(),
      ...overrides,
    },
  } as unknown as ClienteSupabase;
}

describe('adapter Supabase real (ADR-0006 §1/§4/§17, PR3)', () => {
  describe('iniciarSesion', () => {
    it('credenciales válidas devuelven una Sesion opaca (uuid + expiraEn), nunca el token', async () => {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const cliente = clienteMock({
        signInWithPassword: vi.fn().mockResolvedValue({
          data: {
            user: { id: UUID_SINTETICO },
            session: { access_token: 'jwt-sintetico-nunca-expuesto', expires_at: expiresAt },
          },
          error: null,
        }),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      const sesion = await adapter.iniciarSesion({ email: 'laura@ejemplo.test', password: 'x' });

      expect(sesion).toEqual({ usuarioId: UUID_SINTETICO, expiraEn: new Date(expiresAt * 1000).toISOString() });
      expect(Object.keys(sesion)).toEqual(['usuarioId', 'expiraEn']);
    });

    it('contraseña incorrecta lanza CredencialesInvalidasError, con el mismo mensaje que email inexistente', async () => {
      const cliente = clienteMock({
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: null, session: null },
          error: { status: 400, message: 'Invalid login credentials' },
        }),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      await expect(adapter.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(CredencialesInvalidasError);
    });

    it('el mensaje de CredencialesInvalidasError nunca incluye el email intentado (verificación de la mutación: interpolar rompe esto)', async () => {
      const emailDelIntento = 'nombre-real@ejemplo.test';
      const cliente = clienteMock({
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: null, session: null },
          error: { status: 400, message: `no user found for ${emailDelIntento}` },
        }),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      try {
        await adapter.iniciarSesion({ email: emailDelIntento, password: 'y' });
        expect.unreachable('tenía que lanzar');
      } catch (e) {
        expect((e as Error).message).not.toContain(emailDelIntento);
        expect((e as Error).message).toBe('credenciales inválidas');
      }
    });

    it('usuario baneado (status 403) también cae en CredencialesInvalidasError, no en un tipo distinto', async () => {
      const cliente = clienteMock({
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: null, session: null },
          error: { status: 403, message: 'User is banned' },
        }),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      await expect(adapter.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(CredencialesInvalidasError);
    });

    it('un 5xx del proveedor lanza FallaInfraestructuraAuthError, no CredencialesInvalidasError', async () => {
      const cliente = clienteMock({
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: null, session: null },
          error: { status: 500, message: 'internal server error' },
        }),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      await expect(adapter.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(FallaInfraestructuraAuthError);
    });

    it('una excepción de red (fetch falla) lanza FallaInfraestructuraAuthError', async () => {
      const cliente = clienteMock({
        signInWithPassword: vi.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED')),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      await expect(adapter.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(FallaInfraestructuraAuthError);
    });

    it('sin expires_at en la sesión (estado imposible del SDK), lanza FallaInfraestructuraAuthError — nunca inventa una Sesion ya vencida (hallazgo de code-reviewer, PR3)', async () => {
      const cliente = clienteMock({
        signInWithPassword: vi.fn().mockResolvedValue({
          data: {
            user: { id: UUID_SINTETICO },
            session: { access_token: 'jwt-sintetico', expires_at: undefined },
          },
          error: null,
        }),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      await expect(adapter.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(FallaInfraestructuraAuthError);
    });
  });

  describe('cerrarSesion', () => {
    it('llama signOut con scope "local" (ADR-0006 §17 — no revoca otras sesiones del mismo usuario)', async () => {
      const signOut = vi.fn().mockResolvedValue({ error: null });
      const cliente = clienteMock({ signOut });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      await adapter.cerrarSesion({ usuarioId: UUID_SINTETICO, expiraEn: new Date().toISOString() });

      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('un error de signOut se traduce a FallaInfraestructuraAuthError', async () => {
      const cliente = clienteMock({
        signOut: vi.fn().mockResolvedValue({ error: { status: 500, message: 'x' } }),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      await expect(
        adapter.cerrarSesion({ usuarioId: UUID_SINTETICO, expiraEn: new Date().toISOString() }),
      ).rejects.toThrow(FallaInfraestructuraAuthError);
    });
  });

  describe('obtenerSesion', () => {
    it('con cookie válida, usa getUser() y devuelve la Sesion opaca', async () => {
      const cliente = clienteMock({
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: UUID_SINTETICO } }, error: null }),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      const sesion = await adapter.obtenerSesion(new Request('http://localhost/cualquier-ruta'));

      expect(sesion?.usuarioId).toBe(UUID_SINTETICO);
      expect(Object.keys(sesion ?? {})).toEqual(['usuarioId', 'expiraEn']);
    });

    it('sin cookie (getUser sin usuario) devuelve null, nunca lanza', async () => {
      const cliente = clienteMock({
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { status: 401, message: 'no session' } }),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      await expect(adapter.obtenerSesion(new Request('http://localhost/x'))).resolves.toBeNull();
    });

    it('una excepción (red caída) también devuelve null, nunca lanza', async () => {
      const cliente = clienteMock({
        getUser: vi.fn().mockRejectedValue(new Error('network down')),
      });
      const adapter = crearAdapterSupabase(cookiesDePrueba(), cliente);

      await expect(adapter.obtenerSesion(new Request('http://localhost/x'))).resolves.toBeNull();
    });

    it('sin SUPABASE_URL/SUPABASE_ANON_KEY, devuelve null (nunca lanza) PERO lo hace visible con logger.error — no queda indistinguible de "sin sesión" (hallazgo bloqueante de code-reviewer, PR3)', async () => {
      const original = { url: process.env['SUPABASE_URL'], key: process.env['SUPABASE_ANON_KEY'] };
      delete process.env['SUPABASE_URL'];
      delete process.env['SUPABASE_ANON_KEY'];
      const espiaError = vi.spyOn(logger, 'error').mockImplementation(() => {});

      try {
        // Sin cliente inyectado: fuerza el camino real, que arma el cliente y lee las variables.
        const adapter = crearAdapterSupabase(cookiesDePrueba());
        const sesion = await adapter.obtenerSesion(new Request('http://localhost/x'));

        expect(sesion).toBeNull();
        expect(espiaError).toHaveBeenCalledTimes(1);
        expect(espiaError.mock.calls[0]?.[0]).toBe('auth.supabase.obtener_sesion.config_invalida');
      } finally {
        espiaError.mockRestore();
        if (original.url !== undefined) process.env['SUPABASE_URL'] = original.url;
        if (original.key !== undefined) process.env['SUPABASE_ANON_KEY'] = original.key;
      }
    });
  });

  describe('variables de entorno', () => {
    it('sin SUPABASE_URL/SUPABASE_ANON_KEY, construir el cliente real lanza SupabaseEnvNoConfiguradoError', async () => {
      const original = { url: process.env['SUPABASE_URL'], key: process.env['SUPABASE_ANON_KEY'] };
      delete process.env['SUPABASE_URL'];
      delete process.env['SUPABASE_ANON_KEY'];

      // Sin cliente inyectado: fuerza el camino real, que arma el cliente y lee las variables.
      const adapter = crearAdapterSupabase(cookiesDePrueba());
      await expect(adapter.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(
        SupabaseEnvNoConfiguradoError,
      );

      if (original.url !== undefined) process.env['SUPABASE_URL'] = original.url;
      if (original.key !== undefined) process.env['SUPABASE_ANON_KEY'] = original.key;
    });
  });
});
