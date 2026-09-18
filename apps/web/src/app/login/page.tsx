'use client';

/**
 * Login — 4 estados (HANDOFF 230, diseño aprobado 2026-09-17): vacío (submit deshabilitado hasta
 * completar los dos campos), cargando (inputs + botón deshabilitados), credenciales inválidas (un solo
 * mensaje para inválidas/inexistentes/baneadas — evita confirmar del lado del servidor la existencia
 * de una cuenta) y falla de infraestructura (distinta a propósito: "nosotros fallamos", no "te
 * equivocaste"). Layout de dos paneles (marca + formulario), patrón de composición copiado de
 * `trazabilidad-obra-gas` — sin su paleta.
 *
 * Fidelidad visual NO verificada contra los dos Artifacts aprobados (viven fuera del repo, en
 * claude.ai) — esta es una traducción de la especificación ESCRITA (HANDOFF 230, doc 34 §7.2), lista
 * para que `ux-designer`/`frontend-dev` la ajusten contra el diseño real.
 */
import { useActionState, useState } from 'react';
import { iniciarSesionAction, type EstadoLogin } from './actions.ts';

const ESTADO_INICIAL: EstadoLogin = { tipo: 'inicial' };

export default function LoginPage() {
  const [estado, accion, pendiente] = useActionState(iniciarSesionAction, ESTADO_INICIAL);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const ambosCompletos = email.trim() !== '' && password.trim() !== '';

  return (
    <main className="login-layout">
      <section className="login-panel-marca" aria-hidden="true">
        <span className="login-monograma">SC</span>
        <p className="login-nombre">Sistema Contable</p>
        <p className="login-nota-marca">nombre de trabajo — pendiente de decisión de marca</p>
      </section>

      <section className="login-panel-formulario">
        <form action={accion}>
          <h1>Ingresar</h1>

          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pendiente}
            required
          />

          <label htmlFor="password">Contraseña</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pendiente}
            required
          />

          <button type="submit" disabled={pendiente || !ambosCompletos}>
            {pendiente ? 'Ingresando…' : 'Ingresar'}
          </button>

          {estado.tipo === 'credenciales_invalidas' && (
            <p role="alert" className="login-error login-error-credenciales">
              Credenciales inválidas.
            </p>
          )}
          {estado.tipo === 'falla_infraestructura' && (
            <p role="alert" className="login-error login-error-infraestructura">
              No pudimos contactar al proveedor de autenticación — probá de nuevo en unos minutos.
            </p>
          )}
        </form>
      </section>
    </main>
  );
}
