/**
 * LISTAR `salida/` — utilidad de solo lectura, sin base, sin motor. Lee cada `.xlsx` de la carpeta y
 * muestra su sello (hoja "Control de saldos") para que JP elija a mano cuál exportar vigente, sin abrir
 * cada archivo uno por uno.
 *
 * Ajuste 3 del export enriquecido (JP, 2026-08-21, HANDOFF): entre "un symlink/nombre fijo que apunte al
 * último export de cada lote" (opción a) y "un listado manual con el sello" (opción b), se eligió (b) —
 * menos código nuevo, cero riesgo sobre el camino de escritura ya verificado (`exportar-excel.ts`), y
 * evita el problema de symlinks en Windows (requiere privilegio elevado o modo desarrollador, sin
 * garantía en la máquina de quien lo corra) y la pregunta sin respuesta obvia de "cuál gana si el mismo
 * lote se exportó con dos `--destinatario` distintos". El borrado sigue siendo 100% manual — mismo
 * criterio que `TTL_DIAS_RECOMENDADO` de `apps/cli/src/exportar-excel.ts`: un acto humano, nunca
 * automático (ADR-0002 §F.3.8).
 *
 *     pnpm salida:listar
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { raizDelRepo } from '../../../tools/cargar-env.ts';

const SALTO = String.fromCharCode(10);

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

/** El sello vive como la ÚLTIMA línea no vacía de la columna A de "Control de saldos" — mismo criterio
 *  que `textoSelloDelMotor` en `armar-libro.ts`: siempre empieza con "Motor de reconocimiento". Un
 *  archivo de ANTES de este ajuste (sin sello) devuelve `null`, se declara, no se inventa un valor. */
function selloDe(hoja: ExcelJS.Worksheet | undefined): string | null {
  if (!hoja) return null;
  let sello: string | null = null;
  hoja.eachRow((fila) => {
    const v = fila.getCell(1).value;
    if (typeof v === 'string' && v.startsWith('Motor de reconocimiento')) sello = v;
  });
  return sello;
}

async function main(): Promise<void> {
  const dirSalida = join(raizDelRepo(), 'salida');
  let nombres: string[];
  try {
    nombres = readdirSync(dirSalida).filter((n) => n.endsWith('.xlsx') && !n.startsWith('~$'));
  } catch {
    imprimir(`(no existe ${dirSalida} — nada que listar)`);
    return;
  }

  if (nombres.length === 0) {
    imprimir(`(${dirSalida} está vacío)`);
    return;
  }

  type Fila = { readonly nombre: string; readonly mtime: Date; readonly sello: string | null };
  const filas: Fila[] = [];

  for (const nombre of nombres) {
    const ruta = join(dirSalida, nombre);
    const mtime = statSync(ruta).mtime;
    let sello: string | null;
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(ruta);
      sello = selloDe(wb.getWorksheet('Control de saldos'));
    } catch (error) {
      sello = `(no se pudo leer: ${error instanceof Error ? error.constructor.name : 'error desconocido'})`;
    }
    filas.push({ nombre, mtime, sello });
  }

  filas.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  imprimir(`${filas.length} archivo(s) en ${dirSalida}, más reciente primero:`);
  imprimir('');
  for (const f of filas) {
    imprimir(f.nombre);
    imprimir(`  generado (mtime archivo): ${f.mtime.toISOString()}`);
    imprimir(`  sello: ${f.sello ?? '(sin sello — export previo al ajuste de reproducibilidad)'}`);
    imprimir('');
  }
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.stack : String(error)}${SALTO}`);
  process.exitCode = 1;
});
