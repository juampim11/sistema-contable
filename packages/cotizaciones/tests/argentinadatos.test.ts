/**
 * `crearAdapterArgentinaDatos` — sin red real, en todos los casos: el `fetch` viaja siempre
 * inyectado por `config.fetch`. Nada de esta suite depende de que `api.argentinadatos.com` esté
 * arriba, ni consume la cuota de la API pública.
 */

import { describe, expect, it, vi } from 'vitest';
import { crearAdapterArgentinaDatos } from '../src/adaptadores/argentinadatos.ts';
import type { FetchInyectable } from '../src/adaptadores/argentinadatos.ts';

describe('crearAdapterArgentinaDatos — camino feliz', () => {
  it('resuelve compra/venta como string con 4 decimales, y fuente = argentinadatos', async () => {
    const fetchMock = vi.fn<FetchInyectable>(async () =>
      ({
        status: 200,
        ok: true,
        json: async () => ({ casa: 'oficial', compra: 1465, venta: 1515, fecha: '2026-08-18' }),
      }) as unknown as Response,
    );

    const adapter = crearAdapterArgentinaDatos({ fetch: fetchMock });
    const cotizacion = await adapter.consultar('USD', new Date('2026-08-18T00:00:00Z'));

    expect(cotizacion).toEqual({ compra: '1465.0000', venta: '1515.0000', fuente: 'argentinadatos' });

    // La URL le pide al proveedor exactamente el día pedido, y el User-Agent viaja siempre.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('2026/08/18');
    expect((init?.headers as Record<string, string>)['User-Agent']).toBe(
      'sistema-contable-cotizaciones/1.0',
    );
  });
});

describe('crearAdapterArgentinaDatos — sin cotización publicada esa fecha', () => {
  it('404 del proveedor resuelve null, no lanza', async () => {
    const fetchMock = vi.fn(async () => ({ status: 404, ok: false }) as unknown as Response);
    const adapter = crearAdapterArgentinaDatos({ fetch: fetchMock });

    await expect(adapter.consultar('USD', new Date('2026-08-18T00:00:00Z'))).resolves.toBeNull();
  });
});

describe('crearAdapterArgentinaDatos — moneda no soportada', () => {
  it('rechaza SIN llamar al fetch inyectado', async () => {
    const fetchMock = vi.fn();
    const adapter = crearAdapterArgentinaDatos({ fetch: fetchMock as unknown as typeof fetch });

    await expect(adapter.consultar('EUR', new Date('2026-08-18T00:00:00Z'))).rejects.toThrow(
      /no soportada/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('crearAdapterArgentinaDatos — forma de respuesta inesperada', () => {
  it('rechaza cuando compra no es un número', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({ status: 200, ok: true, json: async () => ({ compra: 'no-es-numero', venta: 1515 }) }) as unknown as Response,
    );
    const adapter = crearAdapterArgentinaDatos({ fetch: fetchMock });

    await expect(adapter.consultar('USD', new Date('2026-08-18T00:00:00Z'))).rejects.toThrow();
  });

  it('rechaza cuando falta venta', async () => {
    const fetchMock = vi.fn(
      async () => ({ status: 200, ok: true, json: async () => ({ compra: 1465 }) }) as unknown as Response,
    );
    const adapter = crearAdapterArgentinaDatos({ fetch: fetchMock });

    await expect(adapter.consultar('USD', new Date('2026-08-18T00:00:00Z'))).rejects.toThrow();
  });
});

describe('crearAdapterArgentinaDatos — HTTP no-200 no-404', () => {
  it('un 500 del proveedor rechaza', async () => {
    const fetchMock = vi.fn(async () => ({ status: 500, ok: false }) as unknown as Response);
    const adapter = crearAdapterArgentinaDatos({ fetch: fetchMock });

    await expect(adapter.consultar('USD', new Date('2026-08-18T00:00:00Z'))).rejects.toThrow(/HTTP 500/);
  });
});

describe('crearAdapterArgentinaDatos — el mock-que-cuelga', () => {
  /**
   * La predicción falsable más importante de este paso (`12-cotizacion-bna-plan.md` §2 y §3): un
   * mock hostil que nunca resuelve y que IGNORA el `AbortSignal` a propósito — a diferencia del
   * `fetch` nativo, que sí lo respeta. Si el adapter dependiera solo de que `fetch` cumpla el
   * signal, esto colgaría para siempre.
   *
   * Esto prueba que el adapter NUNCA se cuelga para siempre, aunque el fetch inyectado ignore el
   * AbortSignal. Lo que esto NO prueba todavía: que el pool de jobs (max: 4) no se sature con esto
   * corriendo en paralelo al resto de la suite — esa garantía depende de que el fetch corra SIEMPRE
   * afuera de un `conJob()`, y hoy `packages/cotizaciones` no importa `packages/data` (no hay ningún
   * pool acá para saturar). La mitad que falta se mide cuando exista `actualizar-cotizaciones.ts`
   * (paso posterior, fuera de esta tarea).
   */
  it('el timeout gana la carrera aunque el fetch inyectado nunca resuelva ni respete el abort', async () => {
    const fetchQueCuelga = vi.fn(() => new Promise<Response>(() => {}));
    const adapter = crearAdapterArgentinaDatos({ fetch: fetchQueCuelga, timeoutMs: 30 });

    const inicio = performance.now();
    await expect(adapter.consultar('USD', new Date('2026-08-18T00:00:00Z'))).rejects.toThrow(/timeout/);
    const transcurrido = performance.now() - inicio;

    // Margen generoso: si el adapter volviera a colgarse para siempre, esto falla por el assert de
    // tiempo mucho antes que por el timeout global de vitest.
    expect(transcurrido).toBeLessThan(500);
  });
});
