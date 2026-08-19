import { z } from 'zod';
import type { Cotizacion, ProveedorCotizaciones } from '../proveedor.ts';

const URL_BASE_DEFAULT = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial';
const TIMEOUT_MS_DEFAULT = 10_000;
const USER_AGENT = 'sistema-contable-cotizaciones/1.0';

/**
 * Respuesta real del proveedor — MEDIDA contra la API, no contra documentación de terceros:
 * `{ casa: 'oficial', compra: number, venta: number, fecha: 'yyyy-mm-dd' }`. `.passthrough()`:
 * cualquier campo extra que el proveedor agregue no rompe la validación — solo se exige lo que
 * este adapter usa.
 */
const esquemaRespuesta = z
  .object({
    compra: z.number().finite().positive(),
    venta: z.number().finite().positive(),
  })
  .passthrough();

/** `numeric(12,4)`: máximo real medido son 2 decimales — 4 decimales fijos no pierde nada. */
function aDecimalString(n: number): string {
  return n.toFixed(4);
}

function formatearFecha(fecha: Date): string {
  const y = fecha.getUTCFullYear();
  const m = String(fecha.getUTCMonth() + 1).padStart(2, '0');
  const d = String(fecha.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

export type FetchInyectable = (url: string, init?: RequestInit) => Promise<Response>;

export type ConfigArgentinaDatos = {
  readonly urlBase?: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchInyectable;
};

function configDelEntorno(): { urlBase: string; timeoutMs: number } {
  return {
    urlBase: process.env['COTIZACIONES_ARGENTINADATOS_URL_BASE'] ?? URL_BASE_DEFAULT,
    timeoutMs: TIMEOUT_MS_DEFAULT,
  };
}

/**
 * Único adapter concreto de `ProveedorCotizaciones` para `api.argentinadatos.com` (oficial BNA).
 *
 * Solo soporta `moneda === 'USD'` hoy: las dos cuentas del piloto (Santander USD, Macro USD) son
 * en dólares; EUR necesitaría OTRO proveedor sin histórico por fecha (ver `control-gestion`,
 * proyecto hermano) — fuera de alcance. Otra moneda LANZA, nunca devuelve `null` (`null`
 * significa específicamente "sin cotización publicada esa fecha", no "no soportado").
 *
 * 🔴 El timeout es una CARRERA con un timer propio (`Promise.race`), no una simple pasada del
 * `AbortSignal` a `fetch`. Si solo se le pasara el signal y se confiara en que `fetch` lo respeta,
 * un `fetch` inyectado en un test que ignore el signal (un mock hostil, no cooperativo — a
 * diferencia del `fetch` nativo, que sí lo respeta) colgaría el adapter para siempre. Con la
 * carrera, el timeout gana pase lo que pase con la promesa del fetch.
 */
export function crearAdapterArgentinaDatos(config: ConfigArgentinaDatos = {}): ProveedorCotizaciones {
  const delEntorno = configDelEntorno();
  const urlBase = config.urlBase ?? delEntorno.urlBase;
  const timeoutMs = config.timeoutMs ?? delEntorno.timeoutMs;
  const fetchImpl = config.fetch ?? fetch;

  return {
    async consultar(moneda: string, fecha: Date): Promise<Cotizacion | null> {
      if (moneda !== 'USD') {
        throw new Error(`crearAdapterArgentinaDatos: moneda no soportada '${moneda}' (solo USD)`);
      }

      const url = `${urlBase}/${formatearFecha(fecha)}`;
      const controlador = new AbortController();
      let temporizador: ReturnType<typeof setTimeout>;
      const promesaTimeout = new Promise<never>((_resolve, reject) => {
        temporizador = setTimeout(() => {
          controlador.abort();
          reject(new Error(`crearAdapterArgentinaDatos: timeout de ${timeoutMs}ms consultando ${url}`));
        }, timeoutMs);
      });

      let respuesta: Response;
      try {
        respuesta = await Promise.race([
          fetchImpl(url, {
            headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
            signal: controlador.signal,
          }),
          promesaTimeout,
        ]);
      } finally {
        clearTimeout(temporizador!);
      }

      if (respuesta.status === 404) return null;
      if (!respuesta.ok) {
        throw new Error(`crearAdapterArgentinaDatos: HTTP ${respuesta.status} de ${url}`);
      }

      const cuerpo: unknown = await respuesta.json();
      const parseado = esquemaRespuesta.safeParse(cuerpo);
      if (!parseado.success) {
        throw new Error(`crearAdapterArgentinaDatos: respuesta con forma inesperada de ${url}`);
      }

      return {
        compra: aDecimalString(parseado.data.compra),
        venta: aDecimalString(parseado.data.venta),
        fuente: 'argentinadatos',
      };
    },
  };
}
