/**
 * Guardia de PAN (`sinPan`, `visa-corporativa.ts`) — prueba de mutación OBLIGATORIA, hecha ANTES de
 * que `tester` entre (pedido explícito de JP, no negociable el orden).
 *
 * Prueba `sinPan()` directamente, no contra fixtures de PDF completos: más rápido y aísla el
 * mecanismo. Los números de tarjeta son SIEMPRE sintéticos — el de prueba pública de Visa
 * (`4111111111111111`, documentado por la propia industria para testing) y variantes generadas a
 * mano con el algoritmo de Luhn, nunca un dato real de ningún cliente.
 *
 * ## Las 6 mutaciones (aplicadas a mano sobre el código real, confirmado rojo, revertidas)
 *
 * 1. **Piso `13` → `14` en `RE_PAN`** (`detectores-forma.ts`): un PAN sintético Luhn-válido de 13
 *    dígitos (`4444444444448`) deja de truncarse. Confirmado ROJO en el test "acepta el piso de 13
 *    dígitos", revertido.
 * 2. **Techo `19` → `18` en `RE_PAN`**: un PAN sintético Luhn-válido de 19 dígitos
 *    (`4444444444444444442`) deja de truncarse. Confirmado ROJO en el test "acepta el techo de 19
 *    dígitos", revertido.
 * 3. **Se condiciona el truncado a `luhnEsValido(...)`** (el defecto real que este control existe
 *    para atrapar): con la condición agregada a mano en `sinPan`, un PAN sintético de 16 dígitos con
 *    un dígito alterado (`4111111111111112`, Luhn inválido — simula error de OCR) NO se trunca.
 *    Confirmado ROJO en el test "trunca aunque Luhn falle (simula un dígito mal leído por OCR)",
 *    revertido.
 * 4. **`ultimos4(soloDigitos)` → `soloDigitos.slice(0,4)`**: el valor devuelto pasa a terminar en los
 *    PRIMEROS 4 dígitos en vez de los últimos. Confirmado ROJO en el test "el valor devuelto termina
 *    en los últimos 4 dígitos reales", revertido.
 * 5. **Se quita el chequeo `soloDigitos === candidato`** ("solo dígitos, sin separadores"): con
 *    guiones (`'4111-1111-1111-1111'`) se trata como PAN-shaped cuando no debería — el regex
 *    compartido no cubre separadores, es una forma no medida. Confirmado ROJO en el test "un PAN con
 *    guiones NO se trata como PAN-shaped", revertido.
 * 6. **Se elimina el `\b` de `RE_PAN`** (`detectores-forma.ts`): una corrida de 22 dígitos (CBU)
 *    queda mal segmentada y una porción interna (19 dígitos) se trunca como si fuera PAN. Confirmado
 *    ROJO en el test "una corrida de 22 dígitos (forma de CBU) NO se trata como PAN", revertido.
 */
import { describe, expect, it } from 'vitest';
import { sinPan } from '../src/adaptadores/visa-corporativa.ts';

describe('guardia de PAN — casos legítimos (tienen que seguir pasando siempre)', () => {
  it('candidato null: sin cambios', () => {
    expect(sinPan(null)).toEqual({ valor: null, motivo: null });
  });

  it('"**** 1234" (4 dígitos visibles, bajo el piso de 13): sin cambios', () => {
    expect(sinPan('**** 1234')).toEqual({ valor: '**** 1234', motivo: null });
  });

  it('"12345678901" (11 dígitos, forma de CUIT/cuenta corta, no PAN): sin cambios', () => {
    expect(sinPan('12345678901')).toEqual({ valor: '12345678901', motivo: null });
  });

  it('"1234567890123456789012" (22 dígitos, forma de CBU, no PAN): sin cambios', () => {
    expect(sinPan('1234567890123456789012')).toEqual({
      valor: '1234567890123456789012',
      motivo: null,
    });
  });
});

describe('guardia de PAN — trunca cuando la forma es PAN-shaped', () => {
  // Número de TEST PÚBLICO de Visa, documentado por la industria para pruebas — NUNCA un PAN real.
  const PAN_TEST_PUBLICO = '4111111111111111';
  const PAN_TEST_PUBLICO_LUHN_INVALIDO = '4111111111111112';
  // Sintéticos generados a mano con el algoritmo de Luhn — piso y techo del rango 13-19.
  const PAN_13_LUHN_VALIDO = '4444444444448';
  const PAN_19_LUHN_VALIDO = '4444444444444444442';

  it('PAN de 16 dígitos, Luhn válido: se trunca, motivo pan_confirmado_luhn', () => {
    expect(sinPan(PAN_TEST_PUBLICO)).toEqual({ valor: '••••1111', motivo: 'pan_confirmado_luhn' });
  });

  it('trunca aunque Luhn falle (simula un dígito mal leído por OCR): motivo pan_shape_sin_luhn', () => {
    expect(sinPan(PAN_TEST_PUBLICO_LUHN_INVALIDO)).toEqual({
      valor: '••••1112',
      motivo: 'pan_shape_sin_luhn',
    });
  });

  it('acepta el piso de 13 dígitos (mutación 1: piso 13→14 lo rompe)', () => {
    expect(sinPan(PAN_13_LUHN_VALIDO)).toEqual({ valor: '••••4448', motivo: 'pan_confirmado_luhn' });
  });

  it('acepta el techo de 19 dígitos (mutación 2: techo 19→18 lo rompe)', () => {
    expect(sinPan(PAN_19_LUHN_VALIDO)).toEqual({ valor: '••••4442', motivo: 'pan_confirmado_luhn' });
  });

  it('el valor devuelto termina en los últimos 4 dígitos reales (mutación 4: primeros 4 lo rompe)', () => {
    const { valor } = sinPan(PAN_TEST_PUBLICO);
    expect(valor?.endsWith(PAN_TEST_PUBLICO.slice(-4))).toBe(true);
  });
});

describe('guardia de PAN — formas que NO son PAN-shaped, fail-closed', () => {
  it('un PAN con guiones NO se trata como PAN-shaped (mutación 5: quitar el chequeo lo rompe)', () => {
    expect(sinPan('4111-1111-1111-1111')).toEqual({
      valor: '4111-1111-1111-1111',
      motivo: null,
    });
  });

  it('una corrida de 22 dígitos (forma de CBU) NO se trata como PAN (mutación 6: quitar \\b de RE_PAN lo rompe)', () => {
    const cbuSintetico = '1234567890123456789012';
    expect(sinPan(cbuSintetico)).toEqual({ valor: cbuSintetico, motivo: null });
  });
});
