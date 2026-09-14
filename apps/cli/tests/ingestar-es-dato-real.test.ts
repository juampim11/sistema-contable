/**
 * EL GUARD `--es-dato-real` — condición de salida de A.2 (`docs/diseno/33-plan-deuda-pre-tanda-4.md`).
 *
 * Alcance acotado a propósito: hoy no hay ningún consumidor real de `lote_ingesta.es_dato_real` (la
 * vista de solo lectura de la Tanda 4 todavía no existe), así que lo único mutation-testable es el
 * guard del parseo — que `--es-dato-real` sea obligatorio, sin default, vocabulario cerrado
 * (`'real' | 'prueba'`), y que el rechazo pase **antes** de tocar la base (`parsearArgumentos` es
 * una función pura, sin `conUsuario`, y `ingestar()` la corre antes de abrir el archivo).
 *
 * Requisito previo: ninguno — `parsearArgumentos` no toca la base.
 */

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parsearArgumentos } from '../src/ingestar.ts';

const CLIENTE = randomUUID();
const USUARIO = randomUUID();

const ARGV_BASE = [
  '--cliente',
  CLIENTE,
  '--archivo',
  'x.pdf',
  '--banco',
  'banco_cli',
  '--usuario',
  USUARIO,
] as const;

describe('--es-dato-real: obligatorio, sin default, vocabulario cerrado (B.22)', () => {
  it('CASO LEGÍTIMO: con --es-dato-real real, parsea y lo deja tipado en el resultado', () => {
    const a = parsearArgumentos([...ARGV_BASE, '--es-dato-real', 'real']);
    expect(a.esDatoReal).toBe('real');
  });

  it('CASO LEGÍTIMO: con --es-dato-real prueba, parsea igual', () => {
    const a = parsearArgumentos([...ARGV_BASE, '--es-dato-real', 'prueba']);
    expect(a.esDatoReal).toBe('prueba');
  });

  /**
   * MUTACIÓN DE REFUTACIÓN: sin el flag, tiene que fallar el parseo de Zod — ANTES de llegar a
   * `conUsuario`/abrir el archivo, porque `parsearArgumentos` no toca la base ni el filesystem.
   *
   * Verificado de verdad, no solo por inspección (ciclo verde→mutante→rojo→revertido→verde):
   * comentando la línea `esDatoReal: z.enum([...])` del esquema en `apps/cli/src/ingestar.ts` este
   * `it` se pone ROJO (`a.esDatoReal` queda `undefined`, `toThrow` no dispara), y restaurada la línea
   * vuelve a VERDE. El guard SÍ discrimina: no es un test que pasa "por construcción".
   */
  it('MUTACIÓN: sin --es-dato-real, no corre, y el mensaje explica el porqué (B.22)', () => {
    expect(() => parsearArgumentos([...ARGV_BASE])).toThrow(/es-dato-real/);
  });

  it('MUTACIÓN: un valor fuera del vocabulario cerrado tampoco corre', () => {
    expect(() => parsearArgumentos([...ARGV_BASE, '--es-dato-real', 'sintetico'])).toThrow(
      /es-dato-real/,
    );
  });

  it('el mensaje de error, sin --es-dato-real, dice "real" o "prueba" — no un valor libre', () => {
    try {
      parsearArgumentos([...ARGV_BASE]);
      expect.unreachable('debería haber lanzado');
    } catch (error) {
      expect((error as Error).message).toMatch(/"real"|"prueba"/);
    }
  });
});
