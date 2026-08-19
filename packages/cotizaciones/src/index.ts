/**
 * Barrel del paquete `@sistema-contable/cotizaciones` — ADR-0000 §3.5.
 *
 * Solo el contrato y el único adapter concreto. El comando que orquesta fetch → walk-back →
 * `conJob('cargar_cotizaciones')` es un paso posterior y separado (`docs/diseno/12-cotizacion-bna-plan.md`
 * §5): este paquete no importa `@sistema-contable/data` ni ningún otro paquete del monorepo.
 */

export type { Cotizacion, ProveedorCotizaciones } from './proveedor.ts';
export {
  crearAdapterArgentinaDatos,
  type ConfigArgentinaDatos,
  type FetchInyectable,
} from './adaptadores/argentinadatos.ts';
