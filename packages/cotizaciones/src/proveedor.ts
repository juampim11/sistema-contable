/**
 * Contrato de proveedores de cotización — ADR-0000 §3.5.
 *
 * `compra`/`venta` son `string`, nunca `number` de JS (CLAUDE.md §2: ningún importe como number).
 * `consultar` devuelve `null` ÚNICAMENTE cuando el proveedor no publicó cotización para esa fecha
 * (ej. 404 del proveedor). Cualquier otro fallo (timeout, red, forma de respuesta inválida) se
 * LANZA: quien llama decide qué hacer con un fallo real — nunca se confunde con "no hay dato".
 */

export type Cotizacion = {
  readonly compra: string;
  readonly venta: string;
  readonly fuente: string;
};

export type ProveedorCotizaciones = {
  readonly consultar: (moneda: string, fecha: Date) => Promise<Cotizacion | null>;
};
