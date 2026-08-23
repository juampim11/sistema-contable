/**
 * RASTRO DE USO DE UN MOTIVO DE SOLO LECTURA DE `conJob` — ADR-0002 R42.
 *
 * `leerConAuditoria` (`./auditoria.ts`) es el choke point normal para dejar rastro de una lectura de
 * un dato N2-R: escribe en `acceso_auditoria` **antes** de leer, y exige `tx.usuarioId` para fabricar
 * el `ContextoAuditado`. Pero `conJob` (`./conexion.ts`) construye SIEMPRE su `Tx` con
 * `usuarioId: null` (`envolver(cliente, null)`) — es una tensión ESTRUCTURAL del mecanismo de jobs,
 * no un descuido de un motivo puntual: **ningún** `MotivoJob` puede invocar `leerConAuditoria`, porque
 * no hay identidad de usuario detrás de la credencial que saltea RLS.
 *
 * `auditoria_seguridad_readonly` es el primer motivo que de verdad necesita dejar ese rastro: lee
 * columnas N2-R (`movimiento_origen_crudo.fila_origen`) cross-tenant, con la credencial de job. Sin
 * esto, el único rastro que queda es el `logger.warn('db.job.bypassrls', { motivo_job, entorno })`
 * genérico que emite `conJob` en cada corrida — sin cliente, sin alcance, sin conteo de filas.
 *
 * Esta función NO reemplaza `acceso_auditoria`: es un log estructurado, propio de esta familia de
 * eventos, que complementa al rastro genérico de `conJob` con lo que solo el SCRIPT que corre la
 * consulta conoce (a cuántos clientes tocó, cuántas filas leyó). La llama el script explícitamente
 * DESPUÉS de correr su consulta — nunca `conJob` en sí, que no tiene esa información.
 *
 * Es el mecanismo REUSABLE: cualquier motivo futuro de `conJob` que necesite dejar rastro de una
 * lectura que `leerConAuditoria` no puede cubrir (misma tensión de `usuarioId` null) llama a esta
 * misma función con su propio `motivoJob` — no es un parche pensado solo para
 * `auditoria_seguridad_readonly`.
 */

import { z } from 'zod';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { entornoActual } from './entorno.ts';
import type { MotivoJob } from './conexion.ts';

/**
 * LOGGER ACOTADO para esta familia de eventos (mismo patrón que `logger.ts` líneas ~128-149 y su uso
 * en `apps/cli/src/backfill-contraparte.ts`): unión CERRADA de campos, verificada en compilación —
 * cualquier otra clave no compila, así que un campo nuevo entra cuando alguien lo agrega acá, que es
 * el momento en que se piensa su nivel.
 *
 * `detalle` es una etiqueta libre y corta de la corrida puntual (qué se corrió, no qué se encontró) —
 * NUNCA un valor de dato leído: nada que venga de una fila de `movimiento_origen_crudo` o
 * `movimiento_bancario_crudo` entra acá.
 *
 * `cliente_ids` (revisión 2026-08-23, `security-engineer` + `seguridad-datos-financieros`): reemplaza
 * al `clientes_tocados` original (un conteo). `cliente_id` está clasificado **N1/exportable** en
 * `clasificacion-campos.ts` — no es un dato sensible, es un identificador técnico. Pero un conteo
 * agregado ("8 clientes") no permite responder SI el diagnóstico tocó un cliente fuera del alcance
 * autorizado; una lista de uuid sí, directo en la línea de log, sin cruzar con nada más.
 *
 * `ocurrido_en` (misma revisión): marca de tiempo propia del evento, calculada DENTRO de esta función
 * en el momento de la llamada — no queda a criterio del llamador (que podría demorarse en invocarla
 * después de correr la consulta) ni de la infraestructura de logs externa (que podría no preservar el
 * instante exacto de la corrida).
 */
type CampoUsoSoloLectura =
  | 'motivo_job'
  | 'entorno'
  | 'ocurrido_en'
  | 'cliente_ids'
  | 'filas_leidas'
  | 'detalle';

const log = loggerAcotado<CampoUsoSoloLectura>();

const esquemaContador = z.number().int().nonnegative();

// Mismo patrón que `esquemaUsuarioId`/`RE_UUID` en `./conexion.ts`: valida FORMA de uuid, no linaje
// RFC — el proveedor de identidad puede emitir v4, v7 u otro formato, y acá importa que no sea una
// inyección, no la versión.
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esquemaClienteIds = z.array(z.string().regex(RE_UUID, 'no tiene forma de uuid'));

// 100: `detalle` es una ETIQUETA de la corrida ("qué se corrió"), no un campo de contenido — un
// número redondo, cómodo para una frase corta tipo "medicion-incidente-11", y chico a propósito para
// que nadie lo use como lugar donde pegar un fragmento de dato leído.
const esquemaDetalle = z.string().max(100);

export type DatosUsoSoloLectura = {
  /** El `MotivoJob` de la corrida — tipado, nunca un `string` suelto. */
  readonly motivoJob: MotivoJob;
  /** Los `cliente_id` distintos que tocó la consulta (N1/exportable: identificador, no dato sensible). */
  readonly clienteIds: readonly string[];
  /** Total de filas leídas por la consulta. */
  readonly filasLeidas: number;
  /** Etiqueta libre y corta de la corrida (qué se corrió). Nunca un valor de dato. */
  readonly detalle?: string;
};

/**
 * Deja el rastro de una corrida de `conJob` con un motivo de solo lectura. Se llama DESPUÉS de correr
 * la consulta, con lo que el script ya sabe: alcance (clientes) y volumen (filas).
 */
export function registrarUsoSoloLectura(datos: DatosUsoSoloLectura): void {
  const ocurridoEn = new Date().toISOString();
  const clienteIds = esquemaClienteIds.parse(datos.clienteIds);
  const filasLeidas = esquemaContador.parse(datos.filasLeidas);
  const detalle = datos.detalle === undefined ? undefined : esquemaDetalle.parse(datos.detalle);

  log.info('auditoria_solo_lectura.uso', {
    motivo_job: datos.motivoJob,
    entorno: entornoActual(),
    ocurrido_en: ocurridoEn,
    cliente_ids: clienteIds,
    filas_leidas: filasLeidas,
    detalle,
  });
}
