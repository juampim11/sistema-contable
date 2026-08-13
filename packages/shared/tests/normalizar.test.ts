/**
 * `normalizar()` — movida byte por byte desde `packages/ingesta/src/parseo-ar.ts`, que la
 * re-exporta. Alimenta `fila_hash` (identidad de fila de un movimiento bancario): estos casos
 * fijan el comportamiento exacto para que el movimiento no reprocese nada como fila nueva.
 */

import { describe, expect, it } from 'vitest';
import { normalizar } from '../src/texto/normalizar.ts';

describe('normalización de texto', () => {
  it('quita acentos, colapsa espacios y pasa a mayúsculas', () => {
    expect(normalizar('  Comisión   de   Servicio ')).toBe('COMISION DE SERVICIO');
  });

  it('CONSERVA el marcador de encoding roto en vez de borrarlo', () => {
    // El "Excel" de un banco del roster es un TSV en Latin-1: confundir un carácter roto con una letra
    // hace que dos filas distintas parezcan la misma en el cruce PDF↔Excel.
    expect(normalizar('COMISI�N')).toContain('�');
  });
});
