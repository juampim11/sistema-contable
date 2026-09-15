/**
 * Contrato `AuthProvider` — ADR-0006 §1 (extiende el ya decidido en `ADR-0000-stack-infra.md` §3.2,
 * sin reabrirlo).
 *
 * **Regla dura:** la identidad que cruza hacia los datos es SOLO un uuid. El rol y toda capacidad se
 * resuelven SIEMPRE en Postgres vía RLS (`app.accessible_tenant_ids()`, `app.has_capacidad_en()`) —
 * nunca en la sesión, nunca en un claim, nunca comparado en TypeScript. `Sesion` no lleva, y no puede
 * llevar, ningún campo de rol ni de capacidad: eso es lo que la hace "opaca".
 */

/** Identidad autenticada, opaca. Nada más que un uuid y su vencimiento. */
export type Sesion = {
  /** uuid — el mismo valor que alimenta `set_config('app.user_id', ...)` dentro de `conUsuario()`. */
  readonly usuarioId: string;
  /** ISO 8601. */
  readonly expiraEn: string;
};

/**
 * Forma mínima de credenciales de login que cualquier adapter tiene que poder recibir.
 *
 * Decisión de diseño (dentro del margen de este PR): el ADR no fija el shape exacto de
 * `Credenciales` — solo el nombre del tipo. Se elige email/password porque es lo que va a usar el
 * adapter de Supabase (PR3) y lo que alcanza para el adapter de desarrollo (que en la práctica no
 * necesita validar nada: la identidad sale de `DEV_USER_ID`, no de estas credenciales). Si un futuro
 * proveedor necesita otra forma (SSO, magic link), este tipo se extiende ahí, no acá.
 */
export type Credenciales = {
  readonly email: string;
  readonly password: string;
};

export interface AuthProvider {
  iniciarSesion(credenciales: Credenciales): Promise<Sesion>;
  cerrarSesion(sesion: Sesion): Promise<void>;
  /**
   * `pedido` es el `Request` (Web API estándar) del framework que atiende el pedido. Se recibe tal
   * cual, sin envolverlo en un tipo de Next.js: `packages/auth` no importa `next/*` (R-X) — el
   * framework queda confinado a `apps/web`.
   */
  obtenerSesion(pedido: Request): Promise<Sesion | null>;
}
