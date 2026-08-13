/**
 * `normalizarParaLexico()` — los efectos medidos contra el corpus real, uno por caso nombrado. Cada
 * caso es la evidencia de por qué el paso 1 (puntuación → espacio) tiene la forma exacta que tiene.
 */

import { describe, expect, it } from 'vitest';
import { normalizarParaLexico } from '../src/nucleo/normalizacion.ts';

describe('normalizarParaLexico', () => {
  it('une el par truncado a 27 caracteres de Galicia (IMP. DEB. / IMPUESTO DEB.)', () => {
    expect(normalizarParaLexico('IMP. DEB. LEY 25413 GRAL.')).toBe('IMP DEB LEY 25413 GRAL');
    expect(normalizarParaLexico('IMPUESTO DEB.LEY 25413')).toBe('IMPUESTO DEB LEY 25413');
  });

  it('conserva la distinción S/DB vs S/CR de Macro (lados opuestos, no colapsan)', () => {
    expect(normalizarParaLexico('N/D DBCR 25413 S/DB TASA GRAL')).toBe('N D DBCR 25413 S DB TASA GRAL');
    expect(normalizarParaLexico('N/C DBCR 25413 S/CR TASA GRAL')).toBe('N C DBCR 25413 S CR TASA GRAL');
  });

  it('N/D y ND no colisionan entre sí tras normalizar', () => {
    expect(normalizarParaLexico('N/D COMISION TRANSFERENCIAS')).toBe('N D COMISION TRANSFERENCIAS');
    expect(normalizarParaLexico('ND CHEQUE DEVUELTO REMESAS')).toBe('ND CHEQUE DEVUELTO REMESAS');
  });

  it('el paso 0 (NFD) resuelve las dos grafías con/sin acento de Macro', () => {
    expect(normalizarParaLexico('N/D COMISIÓN ADMINISTRACIÓN DE CHEQUERA')).toBe(
      'N D COMISION ADMINISTRACION DE CHEQUERA',
    );
  });

  it('el paso 0 (toUpperCase) resuelve Sentence Case y Title Case de Santander sin enumerar la grafía', () => {
    expect(normalizarParaLexico('Iva percepcion rg 2408')).toBe('IVA PERCEPCION RG 2408');
    expect(normalizarParaLexico('Iva Percepcion Rg 2408')).toBe('IVA PERCEPCION RG 2408');
  });

  it('NO toca los dos puntos: TRANSF: y TRANSF no colapsan (el ancla auto-delimitante de Macro)', () => {
    expect(normalizarParaLexico('TRANSF:')).toBe('TRANSF:');
    expect(normalizarParaLexico('TRANSF')).toBe('TRANSF');
    expect(normalizarParaLexico('TRANSF:')).not.toBe(normalizarParaLexico('TRANSF '));
  });

  it('el marcador de identificador enmascarado sobrevive el paso 1', () => {
    expect(normalizarParaLexico('PAGO[DOC]-LIQ COMER')).toBe('PAGO[DOC] LIQ COMER');
  });

  it('conserva los dígitos: 25413 sigue distinguible', () => {
    expect(normalizarParaLexico('IMP. CRE. LEY 25413')).toContain('25413');
  });
});
