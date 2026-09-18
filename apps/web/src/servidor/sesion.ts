/**
 * `conSesion()` — ÚNICO punto de `apps/web` autorizado a abrir una transacción con identidad
 * (ADR-0006 §4, R-T). Ningún `route.ts`/`page.tsx`/`actions.ts` llama `conUsuario`/`conJob` directo —
 * todos pasan por acá.
 *
 * `SesionVerificada` lleva un símbolo NO exportado (mismo truco que `ContextoAuditado`,
 * `packages/data/src/db/auditoria.ts:93-98`): no se puede construir fuera de este archivo, así que una
 * función que la pida en su firma solo puede recibirla de `conSesion()`.
 */

import { cookies } from 'next/headers';
import { conUsuario, type Tx } from '@sistema-contable/data';
import {
  crearAuthProvider,
  type CookieAEstablecer,
  type LectorEscritorDeCookies,
  type OpcionesDeCookie,
  type Sesion,
} from '@sistema-contable/auth';

declare const marcaSesionVerificada: unique symbol;
export type SesionVerificada = {
  readonly [marcaSesionVerificada]: true;
  readonly usuarioId: string;
};

export class SesionInvalidaError extends Error {
  readonly codigo = 'SESION_INVALIDA' as const;
  constructor() {
    super('No hay una sesión válida — se esperaba conUsuario() con identidad real.');
    this.name = 'SesionInvalidaError';
  }
}

/**
 * Adapta `next/headers` (async en Next 15) al `LectorEscritorDeCookies` framework-agnóstico que
 * `packages/auth` espera (R-X: ese paquete no puede importar `next/*`). `establecerTodas` puede
 * lanzar cuando corre dentro de un Server Component puro (sin response mutable) — se ignora ese caso
 * a propósito, mismo criterio que el proyecto hermano `trazabilidad-obra-gas`: el refresco de cookies
 * de sesión ocurre en la Server Action de login/logout, que sí puede escribirlas.
 */
export async function cookiesDeNextHeaders(): Promise<LectorEscritorDeCookies> {
  const store = await cookies();
  return {
    obtenerTodas: () => store.getAll().map(({ name, value }) => ({ nombre: name, valor: value })),
    establecerTodas: (lista: readonly CookieAEstablecer[]) => {
      try {
        for (const { nombre, valor, opciones } of lista) {
          store.set(nombre, valor, mapearOpciones(opciones));
        }
      } catch {
        // Server Component sin response mutable — ver el docblock de arriba.
      }
    },
  };
}

function mapearOpciones(opciones: OpcionesDeCookie | undefined): Record<string, unknown> {
  if (!opciones) return {};
  const resultado: Record<string, unknown> = {};
  if (opciones.dominio !== undefined) resultado['domain'] = opciones.dominio;
  if (opciones.ruta !== undefined) resultado['path'] = opciones.ruta;
  if (opciones.maxEdadSegundos !== undefined) resultado['maxAge'] = opciones.maxEdadSegundos;
  if (opciones.httpOnly !== undefined) resultado['httpOnly'] = opciones.httpOnly;
  if (opciones.secure !== undefined) resultado['secure'] = opciones.secure;
  if (opciones.sameSite !== undefined) resultado['sameSite'] = opciones.sameSite;
  return resultado;
}

/** Pura, exportada solo para test — separada de `conSesion()` porque `next/headers` no corre fuera
 *  del runtime de Next (no se puede ejercitar `conSesion()` completo en vitest de forma realista). */
export function usuarioIdDeSesion(sesion: Sesion | null): string {
  if (!sesion) throw new SesionInvalidaError();
  return sesion.usuarioId;
}

/**
 * `AuthProvider.obtenerSesion(pedido: Request)` — los dos adapters reales (`dev-identidad-fija`,
 * `supabase`) ignoran `pedido` (la identidad sale de `DEV_USER_ID` o de las cookies inyectadas,
 * nunca de releer el `Request`) — un `Request` sintético alcanza, no hay uno real disponible en un
 * Server Component/Server Action.
 */
const PEDIDO_SINTETICO = new Request('http://localhost/');

export async function conSesion<T>(
  fn: (sesion: SesionVerificada, tx: Tx) => Promise<T>,
): Promise<T> {
  const cookiesAdapter = await cookiesDeNextHeaders();
  const authProvider = crearAuthProvider(cookiesAdapter);
  const sesion = await authProvider.obtenerSesion(PEDIDO_SINTETICO);
  const usuarioId = usuarioIdDeSesion(sesion);
  const sesionVerificada = { usuarioId } as unknown as SesionVerificada;
  return conUsuario(usuarioId, (tx) => fn(sesionVerificada, tx));
}
