/**
 * REGISTRO DE LECTORES AUDITADOS — por cada tabla con columnas ≥ N2R, la función que es la única
 * autorizada a leerla.
 *
 * ## Por qué este archivo existe aparte, y por qué el registro guarda la FUNCIÓN
 *
 * La primera versión de este registro vivía en `auditoria.ts` y guardaba **strings**:
 *
 *     credencial_fiscal: 'leerMetadatosCredencial (packages/data/src/credenciales.ts)'
 *
 * Ese archivo **no existía**. El test de catálogo pasaba igual, porque verificaba que la tabla tuviera
 * una entrada — no que el lector existiera. Un control que se satisface escribiendo una cadena de texto
 * no es un control: es un comentario con forma de código.
 *
 * Ahora el registro guarda la **referencia a la función**. Si el lector no existe, no compila. Y el test
 * verifica además que sea invocable, así que una entrada no se puede llenar con un `undefined` ni con un
 * objeto vacío.
 *
 * Vive separado de `auditoria.ts` para no crear un ciclo de imports: los lectores importan el tipo
 * `ContextoAuditado` de allá, y este registro los importa a ellos.
 */

import { CLASIFICACION, exigeRolEnLectura } from '@sistema-contable/shared/seguridad';
import type { NombreTabla } from '@sistema-contable/shared/seguridad';
import { leerMetadatosCredencial } from '../credenciales.ts';
import { leerFilasOrigenDeLote, leerIdentificadoresDeCuenta } from '../ingesta/lecturas.ts';

export type LectorAuditado = {
  /** La función real. Si no existe, esto no compila. */
  readonly fn: (...args: never[]) => Promise<unknown>;
  /** Dónde vive, para el mensaje de error del test. Documental, no es la verificación. */
  readonly donde: string;
};

export const LECTORES_AUDITADOS: Readonly<Partial<Record<NombreTabla, LectorAuditado>>> = {
  credencial_fiscal: {
    fn: leerMetadatosCredencial as LectorAuditado['fn'],
    donde: 'packages/data/src/credenciales.ts',
  },
  cuenta_bancaria_identificador: {
    fn: leerIdentificadoresDeCuenta as LectorAuditado['fn'],
    donde: 'packages/data/src/ingesta/lecturas.ts',
  },
  movimiento_origen_crudo: {
    fn: leerFilasOrigenDeLote as LectorAuditado['fn'],
    donde: 'packages/data/src/ingesta/lecturas.ts',
  },
};

/**
 * Tablas que, por su clasificación, exigen pasar por el choke point. **Derivado del registro de
 * clasificación**, nunca escrito a mano: una columna nueva N2R agrega su tabla acá sola, y el test se
 * pone rojo hasta que tenga lector.
 */
export function tablasQueExigenAuditoriaEnLectura(): NombreTabla[] {
  return (Object.keys(CLASIFICACION) as NombreTabla[]).filter((t) =>
    Object.values(CLASIFICACION[t].campos).some((c) => exigeRolEnLectura(c.nivel)),
  );
}

/**
 * Tablas N2R/N3 **sin** lector declarado. Es lo que el test exige que esté vacío.
 *
 * Hoy está vacía. `credencial_fiscal` tenía su lector declarado pero no escrito, y al pasar el registro
 * de strings a funciones eso dejó de poder disimularse: hubo que escribirlo. El punto de diseño de quién
 * ESCRIBE `material_cifrado` sigue abierto (ADR-0002 §H.4) — leerlo y escribirlo son cosas distintas.
 */
export function tablasSinLectorAuditado(): NombreTabla[] {
  return tablasQueExigenAuditoriaEnLectura().filter((t) => LECTORES_AUDITADOS[t] === undefined);
}
