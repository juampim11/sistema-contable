/**
 * `verificadorCuitEsValido` — movida desde `packages/data/src/seed/sintetico.ts` (Módulo 2, capa C).
 */

import { describe, expect, it } from 'vitest';
import { verificadorCuitEsValido } from '../src/seguridad/validador-documento.ts';

describe('verificadorCuitEsValido', () => {
  it('acepta un CUIT con dígito verificador correcto (30-71234567-1)', () => {
    expect(verificadorCuitEsValido('30712345671')).toBe(true);
  });

  it('rechaza el mismo CUIT con el dígito verificador cambiado', () => {
    expect(verificadorCuitEsValido('30712345670')).toBe(false);
  });

  it('acepta con guiones — normaliza antes de validar', () => {
    expect(verificadorCuitEsValido('30-71234567-1')).toBe(true);
  });

  it('rechaza un largo distinto de 11 dígitos, sin excepción', () => {
    expect(verificadorCuitEsValido('1234567')).toBe(false);
    expect(verificadorCuitEsValido('307123456789')).toBe(false);
    expect(verificadorCuitEsValido('')).toBe(false);
  });
});
