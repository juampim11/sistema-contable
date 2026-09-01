/**
 * CLI DE DETECCIÓN DE LOTES DESACTUALIZADOS — solo lectura, cross-tenant, sin argumentos.
 *
 *     pnpm detectar:lotes-desactualizados
 *
 * Sin `--aplicar`: no existe esa bandera, este comando es puramente informativo. Lista los lotes de
 * TODOS los clientes del entorno cuyos movimientos se calcularon con una versión del pipeline de
 * extracción de contraparte (`VERSION_DEL_EXTRACTOR`) anterior a la vigente, o sin ese campo (lotes
 * ingeridos antes de que existiera). Ver `packages/ingesta/src/reproceso/detectar-lotes-desactualizados.ts`.
 */

import { cerrarConexiones } from '@sistema-contable/data';
import { detectarLotesDesactualizados } from '@sistema-contable/ingesta';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);

function causaTipo(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'desconocido';
}

const esEjecucionDirecta = process.argv[1]
  ?.replace(/\\/g, '/')
  .endsWith('apps/cli/src/detectar-lotes-desactualizados.ts');

if (esEjecucionDirecta) {
  try {
    const lotes = await detectarLotesDesactualizados();
    process.stdout.write(`${JSON.stringify({ lotes, total: lotes.length }, null, 2)}${SALTO}`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
