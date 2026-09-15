/**
 * Adapter de desarrollo — ADR-0006 §1 / `ADR-0000-stack-infra.md` §3.2.
 *
 * Identidad FIJA, declarada por configuración (`DEV_USER_ID`), habilitada SOLO con
 * `APP_ENTORNO=local`. Fuera de `local` no hay ninguna identidad "de mentira" que valga: lanza, tanto
 * al construir el adapter como al invocar cualquiera de sus métodos (defensa en dos capas, para el
 * caso en que el entorno cambie a mitad de proceso).
 *
 * NOTA DE DISEÑO — decisión tomada dentro del margen de este PR, se reporta explícitamente:
 * `packages/data/src/db/entorno.ts` ya resuelve exactamente este mismo problema (`entornoActual()`,
 * catálogo cerrado + zod, sin default). La consigna de esta tarea pedía reusar ese patrón "y no
 * reimplementarlo" — pero `ADR-0006` §1 dice, en el mismo párrafo que describe este archivo, que
 * `packages/auth` **no importa** `packages/data` ("identidad ≠ datos"), y lo deja explícito en el
 * grafo de dependencias (`shared ← auth`, sin flecha desde `data`). Importar `entorno.ts` acá
 * resolvería la consigna literal rompiendo la regla de arquitectura del propio ADR que este PR
 * implementa. Se optó por NO importar `packages/data` y duplicar el PATRÓN (zod + catálogo cerrado
 * + mensaje sin default) en miniatura, acá. Queda para `arquitecto-software` decidir si en algún
 * momento este catálogo de entornos se extrae a `packages/shared` para que ninguno de los dos lo
 * reimplemente — no se resuelve por cuenta propia en este PR.
 */

import { z } from 'zod';
import type { AuthProvider, Credenciales, Sesion } from '../auth-provider.ts';

/**
 * Mismo catálogo cerrado que `ENTORNOS` de `packages/data/src/db/entorno.ts` — duplicado a
 * propósito, ver la nota de cabecera. Si cambia allá, cambia acá: hoy no hay una tercera fuente que
 * lo derive para ambos paquetes.
 */
const ENTORNOS_CONOCIDOS = ['local', 'piloto', 'staging', 'produccion'] as const;
const esquemaEntorno = z.enum(ENTORNOS_CONOCIDOS);

/** Mismo criterio que `entornoActual()`: obligatoria y SIN default. Lo no declarado es producción. */
function entornoActualDeAuth(): string {
  const crudo = process.env['APP_ENTORNO'];
  const r = esquemaEntorno.safeParse(crudo);
  if (!r.success) {
    throw new Error(
      `APP_ENTORNO es obligatoria y sin default. Valores permitidos: ${ENTORNOS_CONOCIDOS.join(' | ')}. ` +
        `Recibido: ${crudo === undefined ? '(no definida)' : JSON.stringify(crudo)}. Ver .env.example.`,
    );
  }
  return r.data;
}

export class AdapterLocalFueraDeEntornoLocalError extends Error {
  readonly codigo = 'AUTH_LOCAL_FUERA_DE_ENTORNO_LOCAL' as const;
  constructor(entorno: string) {
    super(
      `El adapter dev-identidad-fija solo puede usarse con APP_ENTORNO=local. Entorno actual: ${entorno}.`,
    );
    this.name = 'AdapterLocalFueraDeEntornoLocalError';
  }
}

export class DevUserIdNoConfiguradoError extends Error {
  readonly codigo = 'DEV_USER_ID_NO_CONFIGURADO' as const;
  constructor() {
    super('DEV_USER_ID no está configurada o no tiene forma de uuid. Ver .env.example.');
    this.name = 'DevUserIdNoConfiguradoError';
  }
}

/** Forma de un uuid, sin exigir versión ni variante RFC (mismo criterio que `conexion.ts`). */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Duración fija de la sesión de desarrollo: no hay renovación, es un adapter de solo-local. */
const DURACION_SESION_MS = 1000 * 60 * 60 * 12; // 12 horas

function verificarHabilitado(): void {
  const entorno = entornoActualDeAuth();
  if (entorno !== 'local') throw new AdapterLocalFueraDeEntornoLocalError(entorno);
}

function usuarioIdDeConfig(): string {
  const crudo = process.env['DEV_USER_ID'];
  if (!crudo || !RE_UUID.test(crudo)) throw new DevUserIdNoConfiguradoError();
  return crudo;
}

function sesionDeDesarrollo(): Sesion {
  return {
    usuarioId: usuarioIdDeConfig(),
    expiraEn: new Date(Date.now() + DURACION_SESION_MS).toISOString(),
  };
}

/**
 * Adapter de desarrollo: identidad fija por config (`DEV_USER_ID`), habilitado solo con
 * `APP_ENTORNO=local`. Lanza `AdapterLocalFueraDeEntornoLocalError` de inmediato si se construye
 * fuera de `local` — no hace falta invocar ningún método para que falle.
 */
export function crearAdapterLocalFijo(): AuthProvider {
  verificarHabilitado();

  return {
    async iniciarSesion(_credenciales: Credenciales): Promise<Sesion> {
      verificarHabilitado();
      return sesionDeDesarrollo();
    },
    async cerrarSesion(_sesion: Sesion): Promise<void> {
      verificarHabilitado();
    },
    async obtenerSesion(_pedido: Request): Promise<Sesion | null> {
      verificarHabilitado();
      return sesionDeDesarrollo();
    },
  };
}
