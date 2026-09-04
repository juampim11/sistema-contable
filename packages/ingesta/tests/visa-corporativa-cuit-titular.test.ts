/**
 * `leerCuitTitular()` (`visa-corporativa.ts`) — prueba de mutación (CLAUDE.md §1.8).
 *
 * Cierra el hallazgo confirmado 2026-09-04 contra los 3 documentos reales de Bracci: el criterio
 * "primer fragmento con forma de CUIT en las primeras 10 filas" capturaba el CUIT del BANCO emisor
 * (fila rotulada "CUIT Banco"), no el del titular. Fix: descartar la fila entera si contiene
 * "BANCO". Detalle completo del hallazgo real: `docs/diseno/10-deuda-declarada.md` §B.17.
 *
 * CUIT sintético (`30-71234567-3`, forma válida de `RE_CUIT`, dígito verificador NO validado —
 * `leerCuitTitular` no lo exige) — nunca un dato real de ningún cliente.
 *
 * ## La mutación (aplicada a mano sobre el código real, confirmado ROJO, revertida)
 *
 * Se comentó la línea `if (normalizar(textoDeFila(fila)).includes('BANCO')) continue;` (el fix
 * completo). Con la mutación activa, el caso "el único candidato está en una fila con 'CUIT Banco'"
 * vuelve a devolver el CUIT del banco en vez de `null` — confirmado ROJO en el test "reproduce el
 * caso real: única fila con forma de CUIT, rotulada 'CUIT Banco' -> null", revertida.
 */
import { describe, expect, it } from 'vitest';
import { leerCuitTitular } from '../src/adaptadores/visa-corporativa.ts';
import type { FilaGeometrica, Fragmento } from '../src/texto-pdf.ts';

const CUIT_SINTETICO_BANCO = '30-71234567-3';
const CUIT_SINTETICO_TITULAR = '20-99999999-6';

function frag(texto: string, x: number): Fragmento {
  return { texto, x, y: 0, ancho: texto.length * 5 };
}

function fila(pagina: number, y: number, textos: readonly string[]): FilaGeometrica {
  return { pagina, y, fragmentos: textos.map((t, i) => frag(t, i * 40)) };
}

describe('leerCuitTitular — caso legítimo (tiene que seguir pasando siempre)', () => {
  it('un CUIT en una fila que NO menciona "BANCO" se captura igual', () => {
    const filas: readonly FilaGeometrica[] = [
      fila(1, 900, ['VISA', 'CORPORATIVA']),
      fila(1, 880, ['Razon', 'Social', 'del', 'titular']),
      fila(1, 860, ['CUIT', CUIT_SINTETICO_TITULAR]),
    ];
    expect(leerCuitTitular(filas)).toBe(CUIT_SINTETICO_TITULAR);
  });

  it('si hay dos candidatos y el primero está en fila con "BANCO", se salta al siguiente legítimo', () => {
    const filas: readonly FilaGeometrica[] = [
      fila(1, 900, ['Banco', 'Emisor', 'S.A.', 'CUIT', 'Banco:', CUIT_SINTETICO_BANCO]),
      fila(1, 880, ['CUIT', 'Titular:', CUIT_SINTETICO_TITULAR]),
    ];
    expect(leerCuitTitular(filas)).toBe(CUIT_SINTETICO_TITULAR);
  });
});

describe('leerCuitTitular — reproduce el caso real de Bracci (el fix que cierra el hallazgo)', () => {
  it('reproduce el caso real: única fila con forma de CUIT, rotulada "CUIT Banco" -> null', () => {
    // Mismo patrón medido en los 3 documentos reales: la ÚNICA fila con forma de CUIT en toda la
    // ventana de carátula está rotulada "CUIT Banco", y no hay ningún otro candidato.
    const filas: readonly FilaGeometrica[] = [
      fila(1, 900, ['VISA', 'CORPORATIVA']),
      fila(1, 880, ['Razon', 'Social', 'del', 'titular']),
      fila(1, 718.8, ['CUIT', 'Banco:', CUIT_SINTETICO_BANCO]),
      fila(1, 700, ['Fecha', 'de', 'Cierre']),
    ];
    expect(leerCuitTitular(filas)).toBeNull();
  });

  it('nunca lanza sobre este caso — devuelve null, sin excepción', () => {
    const filas: readonly FilaGeometrica[] = [fila(1, 718.8, ['CUIT', 'Banco:', CUIT_SINTETICO_BANCO])];
    expect(() => leerCuitTitular(filas)).not.toThrow();
  });
});
