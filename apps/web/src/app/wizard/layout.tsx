import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { conSesion, SesionInvalidaError } from '../../servidor/sesion.ts';
import { cerrarSesionAction } from './actions.ts';
import './marco.css';

/**
 * Header global — "Sistema Contable" (no una razón social de estudio: no existe esa lectura hoy,
 * nunca se fabrica) + "Sesión iniciada" (afirmación verdadera y verificable; `conSesion()` solo trae
 * `usuarioId`, ni nombre ni inicial son datos reales — un ícono con inicial fabricada simularía un
 * nombre que no existe). Dictamen de `ux-designer` (PR4, Pantalla 1).
 */
export default async function WizardLayout({ children }: { readonly children: ReactNode }) {
  try {
    await conSesion(async () => {});
  } catch (error) {
    if (error instanceof SesionInvalidaError) redirect('/login');
    throw error;
  }

  return (
    <div className="wizard-shell">
      <header className="wizard-header-global">
        <div className="wizard-estudio">Sistema Contable</div>
        <div className="wizard-usuario">
          <span className="wizard-avatar" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4 3.5-7 8-7s8 3 8 7" strokeLinecap="round" />
            </svg>
          </span>
          <span>Sesión iniciada</span>
          <form action={cerrarSesionAction}>
            <button type="submit" className="wizard-salir">
              Salir
            </button>
          </form>
        </div>
      </header>

      <div className="wizard-layout">
        <nav className="wizard-sidebar" aria-label="Secciones">
          <div className="wizard-nav-item activo" aria-current="page">
            <span className="wizard-nav-marca" aria-hidden="true" />
            <span className="wizard-nav-texto">
              <span>Cierre mensual</span>
            </span>
          </div>
          {ITEMS_PROXIMAMENTE.map((item) => (
            <div key={item.etiqueta} className="wizard-nav-item" tabIndex={0} aria-disabled="true">
              <span className="wizard-nav-marca" aria-hidden="true" />
              <span className="wizard-nav-texto">
                <span>{item.etiqueta}</span>
                <span className="wizard-nav-etiqueta-estado">Próximamente</span>
              </span>
              <div className="wizard-tooltip-proximamente" role="tooltip">
                {item.tooltip}
              </div>
            </div>
          ))}
        </nav>

        <div className="wizard-panel">{children}</div>
      </div>
    </div>
  );
}

const ITEMS_PROXIMAMENTE = [
  { etiqueta: 'Clientes', tooltip: 'Todavía no podés cargar clientes acá — decíselo a tu estudio si lo necesitás antes.' },
  { etiqueta: 'Plan de cuentas', tooltip: 'Todavía no podés ver el plan de cuentas acá — decíselo a tu estudio si lo necesitás antes.' },
  { etiqueta: 'Socios', tooltip: 'Todavía no podés ver el padrón de socios acá — decíselo a tu estudio si lo necesitás antes.' },
] as const;
