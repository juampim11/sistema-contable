/**
 * `calibrar-lexico-metadatos.ts` — solo la parte pura (`contarPatrones`, `parsearArgumentos`): sin
 * Postgres. La corrida real contra el piloto la hace JP en su propia terminal (E-4, método reforzado).
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Reconocimiento } from '@sistema-contable/contabilidad';
import { contarPatrones, parsearArgumentos } from '../src/calibrar-lexico-metadatos.ts';

function sinReconocer(): Reconocimiento {
  return { clase: 'sin_reconocer', motivo: 'sin_evidencia_de_concepto', candidatos: [], evidencia: undefined };
}

function propuesta(): Reconocimiento {
  return {
    clase: 'propuesta',
    tipo: 'deposito_efectivo',
    concepto: 'deposito_de_efectivo',
    polaridad: 'normal',
    lado: 'haber',
    via: 'texto_literal_exacto',
    evidencia: { entradaLexicoId: 'x', via: 'texto_literal_exacto', caracteresMatcheados: 3, huboCola: false },
  };
}

describe('parsearArgumentos', () => {
  it('parsea cliente/usuario/lote-id', () => {
    const cliente = randomUUID();
    const usuario = randomUUID();
    const loteId = randomUUID();
    expect(parsearArgumentos(['--cliente', cliente, '--usuario', usuario, '--lote-id', loteId])).toEqual({
      cliente,
      usuario,
      loteId,
    });
  });

  it('rechaza argumentos faltantes', () => {
    expect(() => parsearArgumentos(['--cliente', randomUUID()])).toThrow();
  });
});

describe('contarPatrones — nunca expone el texto, solo conteos', () => {
  it('cuenta 0 sobre un lote sin filas sin_reconocer', () => {
    const r = contarPatrones([propuesta(), propuesta()], ['DEPOSITO EFECTIVO', 'DEPOSITO EFECTIVO']);
    expect(r.totalSinReconocer).toBe(0);
    expect(Object.values(r.porPatron).every((n) => n === 0)).toBe(true);
  });

  it('detecta el literal ya reconocido de FCI (sin_reconocer, pero el patrón ya matchea)', () => {
    const r = contarPatrones([sinReconocer()], ['SUSCRIPCION FIMA CLASE A']);
    expect(r.totalSinReconocer).toBe(1);
    expect(r.porPatron['ya_reconocido_suscripcion_fima']).toBe(1);
    expect(r.porPatron['candidato_fci_generico']).toBe(1);
    expect(r.porPatron['ya_reconocido_acreditamiento']).toBe(0);
  });

  it('detecta un candidato de Plan de Pagos AFIP que el léxico todavía no cubre', () => {
    const r = contarPatrones([sinReconocer(), sinReconocer()], ['PLAN DE PAGOS AFIP CUOTA 3', 'OTRA COSA']);
    expect(r.totalSinReconocer).toBe(2);
    expect(r.porPatron['candidato_plan_pagos_afip']).toBe(1);
    expect(r.porPatron['contiene_afip']).toBe(1);
  });

  it('cuenta sinConceptoBanco por separado, no lo mezcla con "no matchea ningún patrón"', () => {
    const r = contarPatrones([sinReconocer()], [undefined]);
    expect(r.totalSinReconocer).toBe(1);
    expect(r.sinConceptoBanco).toBe(1);
    expect(Object.values(r.porPatron).every((n) => n === 0)).toBe(true);
  });

  it('🔴 candidato_cobro_de_tarjeta NO va anclado — matchea aunque el texto tenga un prefijo antes', () => {
    // Regresión del bug que encontró JP: este patrón estaba anclado (`^COBRO DE TARJETA`), copiado
    // por error del patrón de al lado (`ya_reconocido_acreditamiento`, que sí ancla a propósito). Un
    // candidato nuevo no puede asumir que el texto empieza justo ahí.
    const r = contarPatrones([sinReconocer()], ['REF 001234 COBRO DE TARJETA CREDITO- DEUDORES POR VENTAS']);
    expect(r.porPatron['candidato_cobro_de_tarjeta']).toBe(1);
  });

  it('el resultado nunca contiene el texto de conceptoBanco, solo números', () => {
    const r = contarPatrones([sinReconocer()], ['UN TEXTO QUE NO DEBERIA APARECER EN LA SALIDA']);
    const json = JSON.stringify(r);
    expect(json).not.toContain('TEXTO');
    expect(json).not.toContain('APARECER');
  });
});
