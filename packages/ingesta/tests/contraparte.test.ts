/**
 * `extraerCandidatosDeContraparte` — pura, sin base. Migración 0013.
 *
 * Cubre lo que el guard de forma existe para atajar: `glosa.ts` agrupa por CLASE DE PATRÓN, no por
 * identidad garantizada — el bucket `documento` mezcla DNI real (7-8 dígitos) con corridas largas
 * (números de operación, CBU truncados). Sin el guard, esas corridas se hashearían como si fueran
 * un DNI, ocupando el slot de "hay identificador" sin serlo.
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacDocumento, hmacIdentificador } from '@sistema-contable/shared/seguridad';
import { extraerCandidatosDeContraparte } from '../src/contraparte.ts';

const CLIENTE = '11111111-1111-1111-1111-111111111111';
const OTRO_CLIENTE = '22222222-2222-2222-2222-222222222222';

const SIN_IDENTIFICADORES = { cuit: [], cbu: [], documento: [] };

describe('extraerCandidatosDeContraparte — camino feliz', () => {
  it('sin ningún identificador: captura = sin_identificador, cero candidatos', () => {
    const r = extraerCandidatosDeContraparte(SIN_IDENTIFICADORES, CLIENTE, []);
    expect(r).toEqual({ candidatos: [], captura: 'sin_identificador', descartadosPorForma: 0 });
  });

  it('un CUIT de 11 dígitos produce un candidato clase=cuit', () => {
    const r = extraerCandidatosDeContraparte(
      { cuit: ['30-71234567-8'], cbu: [], documento: [] },
      CLIENTE,
      [],
    );
    expect(r.captura).toBe('capturado');
    expect(r.candidatos).toHaveLength(1);
    expect(r.candidatos[0]?.clase).toBe('cuit');
    expect(r.candidatos[0]?.pepperId).toBeTruthy();
    // El digest tiene que coincidir con lo que produce la función pública directo — mismo dominio.
    expect(r.candidatos[0]?.hmac.equals(hmacDocumento('cuit', '30-71234567-8', CLIENTE))).toBe(true);
  });

  it('un documento de 7 dígitos produce un candidato clase=dni', () => {
    const r = extraerCandidatosDeContraparte({ cuit: [], cbu: [], documento: ['1234567'] }, CLIENTE, []);
    expect(r.captura).toBe('capturado');
    expect(r.candidatos[0]?.clase).toBe('dni');
  });

  it('un documento de 8 dígitos también produce dni (los dos largos válidos)', () => {
    const r = extraerCandidatosDeContraparte({ cuit: [], cbu: [], documento: ['12345678'] }, CLIENTE, []);
    expect(r.candidatos[0]?.clase).toBe('dni');
  });

  it('varios identificadores en la misma glosa (ordenante + beneficiario) dan varios candidatos', () => {
    const r = extraerCandidatosDeContraparte(
      { cuit: ['30-71234567-8', '20-11111111-2'], cbu: [], documento: [] },
      CLIENTE,
      [],
    );
    expect(r.candidatos).toHaveLength(2);
    expect(r.captura).toBe('capturado');
  });
});

describe('el guard de forma — el motivo por el que existe esta función y no un pasamano directo', () => {
  it('una corrida de 9+ dígitos en el bucket "documento" (RE_CORRIDA_LARGA) se DESCARTA, nunca se hashea como dni', () => {
    // 13 dígitos: el caso medido de un CBU truncado por el ancho de columna (docs/diseno/09-lecciones-aprendidas.md).
    const r = extraerCandidatosDeContraparte({ cuit: [], cbu: [], documento: ['1234567890123'] }, CLIENTE, []);
    expect(r.candidatos).toEqual([]);
    expect(r.captura).toBe('sin_identificador');
    expect(r.descartadosPorForma).toBe(1);
  });

  it('un CUIT que no normaliza a 11 dígitos (dato corrupto) se descarta, no se hashea', () => {
    const r = extraerCandidatosDeContraparte({ cuit: ['123456789'], cbu: [], documento: [] }, CLIENTE, []);
    expect(r.candidatos).toEqual([]);
    expect(r.descartadosPorForma).toBe(1);
  });

  it('un CBU que no normaliza a 22 dígitos se descarta, no se hashea', () => {
    const r = extraerCandidatosDeContraparte({ cuit: [], cbu: ['123456789012345'], documento: [] }, CLIENTE, []);
    expect(r.candidatos).toEqual([]);
    expect(r.descartadosPorForma).toBe(1);
  });

  it('mezcla: un documento válido (7 dígitos) y uno inválido (10) en la misma fila — solo el válido se hashea', () => {
    const r = extraerCandidatosDeContraparte(
      { cuit: [], cbu: [], documento: ['1234567', '1234567890'] },
      CLIENTE,
      [],
    );
    expect(r.candidatos).toHaveLength(1);
    expect(r.candidatos[0]?.clase).toBe('dni');
    expect(r.descartadosPorForma).toBe(1);
    expect(r.captura).toBe('capturado');
  });
});

describe('el filtro "es la cuenta propia del cliente" — regla 10, transferencia entre cuentas propias', () => {
  const CBU_PROPIO = '9990000090000000000101';

  it('un CBU que matchea una cuenta propia del cliente NO se persiste como candidato', () => {
    const digestPropio = hmacIdentificador(CBU_PROPIO);
    const r = extraerCandidatosDeContraparte({ cuit: [], cbu: [CBU_PROPIO], documento: [] }, CLIENTE, [
      digestPropio,
    ]);
    expect(r.candidatos).toEqual([]);
    expect(r.captura).toBe('capturado_cuenta_propia');
    // No es un descarte por forma — el CBU tiene forma correcta, se descarta por ser la cuenta propia.
    expect(r.descartadosPorForma).toBe(0);
  });

  it('un CBU que NO matchea ninguna cuenta propia SÍ se persiste como candidato genuino', () => {
    const digestDeOtraCuenta = hmacIdentificador('9990000090000000000199');
    const r = extraerCandidatosDeContraparte({ cuit: [], cbu: ['9990000090000000000101'], documento: [] }, CLIENTE, [
      digestDeOtraCuenta,
    ]);
    expect(r.candidatos).toHaveLength(1);
    expect(r.candidatos[0]?.clase).toBe('cbu');
    expect(r.captura).toBe('capturado');
  });

  it('el candidato CBU persistido usa el pepper DERIVADO por cliente, no el global', () => {
    const r = extraerCandidatosDeContraparte({ cuit: [], cbu: ['9990000090000000000101'], documento: [] }, CLIENTE, []);
    const digestGlobal = hmacIdentificador('9990000090000000000101');
    const digestDerivado = hmacDocumento('cbu', '9990000090000000000101', CLIENTE);
    expect(r.candidatos[0]?.hmac.equals(digestGlobal)).toBe(false);
    expect(r.candidatos[0]?.hmac.equals(digestDerivado)).toBe(true);
  });

  it('con dos candidatos CBU, uno propio y uno de tercero: el propio se descarta, el tercero se persiste', () => {
    const digestPropio = hmacIdentificador(CBU_PROPIO);
    const r = extraerCandidatosDeContraparte(
      { cuit: [], cbu: [CBU_PROPIO, '9990000090000000009999'], documento: [] },
      CLIENTE,
      [digestPropio],
    );
    expect(r.candidatos).toHaveLength(1);
    expect(r.candidatos[0]?.clase).toBe('cbu');
    expect(r.captura).toBe('capturado');
  });
});

describe('el pepper derivado por cliente cierra la correlación cross-cliente', () => {
  it('el mismo CUIT hasheado para dos clientes distintos da dos digests distintos', () => {
    const paraUno = extraerCandidatosDeContraparte({ cuit: ['30-71234567-8'], cbu: [], documento: [] }, CLIENTE, []);
    const paraOtro = extraerCandidatosDeContraparte(
      { cuit: ['30-71234567-8'], cbu: [], documento: [] },
      OTRO_CLIENTE,
      [],
    );
    expect(paraUno.candidatos[0]?.hmac.equals(paraOtro.candidatos[0]?.hmac ?? randomBytes(32))).toBe(false);
  });
});
