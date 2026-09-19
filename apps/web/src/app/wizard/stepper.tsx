/**
 * Stepper compartido de las 6 pantallas del wizard (doc 34 §0). Extraído a un componente propio desde
 * el primer uso (Pantalla 1) para que las 5 pantallas siguientes no dupliquen este HTML — solo pasan
 * `activo`.
 *
 * `.wizard-paso.cerrado`/`.default-navegable` (estado "confirmado", doc 34 §1.3/§3/§4) NO se
 * implementan todavía: el paso 1 nunca puede estar cerrado (es siempre el primero), así que no hay
 * caso real que ejercite esa variante hoy — se agrega cuando Pantalla 2 la necesite de verdad.
 */

const PASOS = [
  { numero: 1, etiqueta: 'Elegir cliente' },
  { numero: 2, etiqueta: 'Subir extracto' },
  { numero: 3, etiqueta: 'Resumen' },
  { numero: 4, etiqueta: 'Procesar y tipificar' },
  { numero: 5, etiqueta: 'Revisar e imputar' },
  { numero: 6, etiqueta: 'Generar asiento' },
] as const;

export function WizardStepper({ activo }: { readonly activo: number }) {
  return (
    <div className="wizard-stepper-bar">
      <div className="wizard-stepper">
        {PASOS.map((paso) => (
          <div key={paso.numero} className={paso.numero === activo ? 'wizard-paso activo' : 'wizard-paso'}>
            <span className="wizard-conector" aria-hidden="true" />
            <span className="wizard-circulo">{paso.numero}</span>
            <span className="wizard-etiqueta">{paso.etiqueta}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
