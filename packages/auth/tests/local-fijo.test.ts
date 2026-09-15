import { afterEach, describe, expect, it } from 'vitest';
import {
  AdapterLocalFueraDeEntornoLocalError,
  crearAdapterLocalFijo,
  DevUserIdNoConfiguradoError,
} from '../src/adapters/local-fijo.ts';

/** Uuid sintético, sin ningún vínculo con datos reales (ADR-0002 §F.2). */
const UUID_SINTETICO = '11111111-2222-4333-8444-555555555555';

const APP_ENTORNO_ORIGINAL = process.env['APP_ENTORNO'];
const DEV_USER_ID_ORIGINAL = process.env['DEV_USER_ID'];

function restaurar(clave: string, valorOriginal: string | undefined): void {
  if (valorOriginal === undefined) delete process.env[clave];
  else process.env[clave] = valorOriginal;
}

afterEach(() => {
  restaurar('APP_ENTORNO', APP_ENTORNO_ORIGINAL);
  restaurar('DEV_USER_ID', DEV_USER_ID_ORIGINAL);
});

describe('adapter local-fijo — habilitado SOLO con APP_ENTORNO=local (ADR-0006 §1)', () => {
  it('en local, con DEV_USER_ID configurado, iniciarSesion resuelve la identidad fija', async () => {
    process.env['APP_ENTORNO'] = 'local';
    process.env['DEV_USER_ID'] = UUID_SINTETICO;

    const adapter = crearAdapterLocalFijo();
    const sesion = await adapter.iniciarSesion({ email: 'x', password: 'y' });

    expect(sesion.usuarioId).toBe(UUID_SINTETICO);
    expect(new Date(sesion.expiraEn).getTime()).toBeGreaterThan(Date.now());
  });

  it('en local, obtenerSesion y cerrarSesion también resuelven/aceptan la identidad fija', async () => {
    process.env['APP_ENTORNO'] = 'local';
    process.env['DEV_USER_ID'] = UUID_SINTETICO;

    const adapter = crearAdapterLocalFijo();
    const sesion = await adapter.obtenerSesion(new Request('http://localhost/cualquier-ruta'));

    expect(sesion).not.toBeNull();
    expect(sesion?.usuarioId).toBe(UUID_SINTETICO);
    await expect(adapter.cerrarSesion(sesion as NonNullable<typeof sesion>)).resolves.toBeUndefined();
  });

  it.each(['piloto', 'staging', 'produccion'] as const)(
    'fuera de local (%s) lanza al CONSTRUIR el adapter, sin necesidad de invocar ningún método',
    (entorno) => {
      process.env['APP_ENTORNO'] = entorno;
      process.env['DEV_USER_ID'] = UUID_SINTETICO;

      expect(() => crearAdapterLocalFijo()).toThrow(AdapterLocalFueraDeEntornoLocalError);
    },
  );

  it('si el entorno cambia después de construir el adapter, cada método lo vuelve a verificar', async () => {
    process.env['APP_ENTORNO'] = 'local';
    process.env['DEV_USER_ID'] = UUID_SINTETICO;
    const adapter = crearAdapterLocalFijo();

    process.env['APP_ENTORNO'] = 'produccion';
    await expect(adapter.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(
      AdapterLocalFueraDeEntornoLocalError,
    );
  });

  it('en local, sin DEV_USER_ID configurado (o con forma inválida), lanza DevUserIdNoConfiguradoError', async () => {
    process.env['APP_ENTORNO'] = 'local';
    delete process.env['DEV_USER_ID'];
    const adapterSinConfig = crearAdapterLocalFijo();
    await expect(adapterSinConfig.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(
      DevUserIdNoConfiguradoError,
    );

    process.env['DEV_USER_ID'] = 'no-tiene-forma-de-uuid';
    const adapterConFormaInvalida = crearAdapterLocalFijo();
    await expect(adapterConFormaInvalida.iniciarSesion({ email: 'x', password: 'y' })).rejects.toThrow(
      DevUserIdNoConfiguradoError,
    );
  });
});
