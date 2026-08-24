/**
 * `medir-identidad-resuelta.ts` — guard sobre `QUE_DECIDE_CATEGORIA_A`: los 6 `queDecide` de categoría
 * (a) fijados en HANDOFF 93 (+ el agregado después, ver comentario del propio script), ni uno más ni
 * uno menos. Si esto cambia sin querer, el % de identidad resuelta se calcula mal en silencio.
 */
import { describe, expect, it } from 'vitest';
import { QUE_DECIDE, type QueDecide } from '@sistema-contable/contabilidad';
import { QUE_DECIDE_CATEGORIA_A } from '../src/medir-identidad-resuelta.ts';

describe('QUE_DECIDE_CATEGORIA_A', () => {
  it('son exactamente los 6 fijados — identidad resuelta, falta Capa D', () => {
    expect([...QUE_DECIDE_CATEGORIA_A].sort()).toEqual(
      [
        'completar_con_liquidacion_del_adquirente',
        'confirmar_computo_de_credito_fiscal',
        'confirmar_cuenta_propia_destino',
        'elegir_jurisdiccion_de_la_retencion',
        'elegir_cuenta_de_pasivo_del_impuesto',
        'completar_con_liquidacion_de_la_tarjeta',
      ].sort(),
    );
  });

  it('NO incluye distinguir_tercero_de_socio (categoría d) ni confirmar_hipotesis_del_lexico (categoría c)', () => {
    expect(QUE_DECIDE_CATEGORIA_A).not.toContain('distinguir_tercero_de_socio');
    expect(QUE_DECIDE_CATEGORIA_A).not.toContain('confirmar_hipotesis_del_lexico');
  });

  it('todos sus valores son QueDecide válidos del dominio cerrado', () => {
    for (const q of QUE_DECIDE_CATEGORIA_A) {
      expect(QUE_DECIDE as readonly QueDecide[]).toContain(q);
    }
  });
});
