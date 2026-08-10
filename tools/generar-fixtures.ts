/**
 * GENERA LOS FIXTURES. Determinístico: misma semilla, mismo archivo byte a byte.
 *
 * Que sea determinístico es lo que permite que el gate signifique algo: si cada corrida produjera un
 * fixture distinto, el diff de un commit sería ilegible y nadie notaría un cambio real entre el ruido.
 *
 *     pnpm fixtures:generar    → escribe el fixture y su respuesta esperada
 *     pnpm fixtures:verificar  → los 7 chequeos
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { textoExtractoSintetico } from '@sistema-contable/ingesta';
import { raizDelRepo } from './cargar-env.ts';

const DIR = join(raizDelRepo(), 'packages', 'ingesta', 'tests', 'fixtures');

/**
 * La especificación del fixture. Los números están elegidos, no puestos al azar:
 *   - `cuentas: 2` ejercita la variante multi-cuenta que el modelo soporta y la muestra real no tiene;
 *   - `lineasPorPagina: 22` fuerza varias páginas, así el encabezado se repite y hay que saltearlo;
 *   - 40 movimientos por cuenta alcanzan para que el dedupe y los repetidos aparezcan.
 */
const ESPEC = {
  semilla: 20260601,
  movimientosPorCuenta: 40,
  cuentas: 2,
  periodoDesde: '2026-06-01',
  periodoHasta: '2026-06-30',
  lineasPorPagina: 22,
} as const;

const r = textoExtractoSintetico(ESPEC);
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'extracto-sintetico.txt'), r.texto, 'utf8');
writeFileSync(
  join(DIR, 'extracto-sintetico.esperado.json'),
  `${JSON.stringify(r.esperado, null, 2)}\n`,
  'utf8',
);

process.stdout.write(
  `fixture generado: ${r.esperado.cuentas.length} cuenta(s), ` +
    `${r.esperado.cuentas.reduce((n, c) => n + c.movimientos, 0)} movimientos${String.fromCharCode(10)}`,
);
