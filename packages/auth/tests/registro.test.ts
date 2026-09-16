import { afterEach, describe, expect, it } from 'vitest';
import { AdapterLocalFueraDeEntornoLocalError } from '../src/adapters/local-fijo.ts';
import {
  AuthProviderDesconocidoError,
  CookiesNoProvistasParaSupabaseError,
  crearAuthProvider,
} from '../src/registro.ts';
import type { LectorEscritorDeCookies } from '../src/cookies.ts';

function cookiesDePrueba(): LectorEscritorDeCookies {
  return { obtenerTodas: () => [], establecerTodas: () => {} };
}

const UUID_SINTETICO = '11111111-2222-4333-8444-555555555555';

const APP_ENTORNO_ORIGINAL = process.env['APP_ENTORNO'];
const AUTH_PROVIDER_ORIGINAL = process.env['AUTH_PROVIDER'];
const DEV_USER_ID_ORIGINAL = process.env['DEV_USER_ID'];

function restaurar(clave: string, valorOriginal: string | undefined): void {
  if (valorOriginal === undefined) delete process.env[clave];
  else process.env[clave] = valorOriginal;
}

afterEach(() => {
  restaurar('APP_ENTORNO', APP_ENTORNO_ORIGINAL);
  restaurar('AUTH_PROVIDER', AUTH_PROVIDER_ORIGINAL);
  restaurar('DEV_USER_ID', DEV_USER_ID_ORIGINAL);
});

describe('crearAuthProvider — catálogo cerrado (ADR-0006 §1)', () => {
  it('lanza AuthProviderDesconocidoError con un valor fuera del catálogo', () => {
    process.env['AUTH_PROVIDER'] = 'cognito';
    expect(() => crearAuthProvider()).toThrow(AuthProviderDesconocidoError);
  });

  it('lanza AuthProviderDesconocidoError si AUTH_PROVIDER no está definida', () => {
    delete process.env['AUTH_PROVIDER'];
    expect(() => crearAuthProvider()).toThrow(AuthProviderDesconocidoError);
  });

  it('"dev-identidad-fija" en local devuelve un adapter funcional', async () => {
    process.env['APP_ENTORNO'] = 'local';
    process.env['AUTH_PROVIDER'] = 'dev-identidad-fija';
    process.env['DEV_USER_ID'] = UUID_SINTETICO;

    const provider = crearAuthProvider();
    const sesion = await provider.iniciarSesion({ email: 'x', password: 'y' });
    expect(sesion.usuarioId).toBe(UUID_SINTETICO);
  });

  it('"dev-identidad-fija" fuera de local lanza AdapterLocalFueraDeEntornoLocalError, sin invocar ningún método', () => {
    process.env['APP_ENTORNO'] = 'produccion';
    process.env['AUTH_PROVIDER'] = 'dev-identidad-fija';

    expect(() => crearAuthProvider()).toThrow(AdapterLocalFueraDeEntornoLocalError);
  });

  it('"supabase" sin cookies lanza CookiesNoProvistasParaSupabaseError, sin construir nada', () => {
    process.env['AUTH_PROVIDER'] = 'supabase';

    expect(() => crearAuthProvider()).toThrow(CookiesNoProvistasParaSupabaseError);
  });

  it('"supabase" con cookies devuelve el adapter real (construir no lanza)', () => {
    process.env['AUTH_PROVIDER'] = 'supabase';

    const provider = crearAuthProvider(cookiesDePrueba());
    expect(provider).toBeDefined();
  });
});
