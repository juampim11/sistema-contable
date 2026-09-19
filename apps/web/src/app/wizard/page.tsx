/**
 * Pantalla 1 — "Elegir cliente" (doc 34 §0, primer paso real del wizard). Server Component: lee los
 * clientes accesibles al usuario logueado vía `conSesion()` + `leerClientesAccesibles()`
 * (`packages/data`, primera consumidora real de esa función).
 *
 * Dos datos del boceto aprobado ("N cuentas bancarias", "último extracto") NO se muestran acá —
 * dictamen de `ux-designer`: `leerClientesAccesibles` no los tiene y no hay grant de `app_web` sobre
 * esas tablas todavía (abrirlo es una migración nueva, con su propia convocatoria, fuera de esta
 * pieza). Se documenta como hallazgo declarado en HANDOFF, no como nota perdida.
 */
import Link from 'next/link';
import { conSesion } from '../../servidor/sesion.ts';
import { leerClientesAccesibles } from '@sistema-contable/data';
import { WizardStepper } from './stepper.tsx';
import './elegir-cliente.css';

export default async function ElegirClientePage() {
  const clientes = await conSesion((_sesion, tx) => leerClientesAccesibles(tx));

  return (
    <>
      <WizardStepper activo={1} />
      <div className="wizard-contenido">
        <h1>Elegir cliente</h1>
        <p className="wizard-subtitulo">Seleccioná el cliente sobre el que vas a trabajar este cierre.</p>

        {clientes.length === 0 ? (
          <div className="elegir-cliente-vacio">
            <p>Todavía no tenés ningún cliente asignado.</p>
            <p className="elegir-cliente-vacio-nota">Pedile a tu estudio que te dé acceso — así aparece acá.</p>
          </div>
        ) : (
          <div className="elegir-cliente-grilla">
            {clientes.map((cliente) => (
              // Pantalla 2 (subir extracto) todavía no existe -- llega en el próximo commit del
              // paso revertible. Este link ya queda armado, correcto, apuntando ahí.
              <Link key={cliente.id} href={`/wizard/${cliente.id}/subir`} className="elegir-cliente-tarjeta">
                <span className="elegir-cliente-nombre">{cliente.nombre}</span>
                <span className="elegir-cliente-boton" aria-hidden="true">
                  Elegir cliente
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
