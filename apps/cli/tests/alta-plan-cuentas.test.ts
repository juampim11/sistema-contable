/**
 * `alta-plan-cuentas.ts` — funciones puras del CLI: `argumentos` (parseo) y `resolverFilas` (mapeo
 * código→padronSocioId, D-25 Opción A: nunca asume por matching de texto, aborta si falta una entrada).
 * No ejercita el flujo completo contra la base (eso lo cubre `packages/data/tests/alta-plan-cuentas.test.ts`
 * sobre `altaPlanDeCuentas` directo) ni imprime ninguna denominación real — fixture 100% sintético.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NodoPlanCuentas, ResultadoParseoPlanCuentas } from '@sistema-contable/ingesta';
import { argumentos, resolverFilas } from '../src/alta-plan-cuentas.ts';

describe('argumentos — parseo', () => {
  const cliente = randomUUID();
  const usuario = randomUUID();

  it('parsea con --confirmar y --vigente-desde explícitos', () => {
    const r = argumentos([
      '--cliente', cliente,
      '--usuario', usuario,
      '--archivo', 'ruta/al/plan.xlsx',
      '--mapeo', 'ruta/al/mapeo.json',
      '--confirmar',
      '--vigente-desde', '2026-08-27',
    ]);
    expect(r).toEqual({
      cliente,
      usuario,
      archivo: 'ruta/al/plan.xlsx',
      mapeo: 'ruta/al/mapeo.json',
      confirmar: true,
      vigenteDesde: '2026-08-27',
    });
  });

  it('sin --confirmar → dry-run (confirmar=false), sin --mapeo → undefined', () => {
    const r = argumentos(['--cliente', cliente, '--usuario', usuario, '--archivo', 'x.xlsx']);
    expect(r.confirmar).toBe(false);
    expect(r.mapeo).toBeUndefined();
  });

  it('🔴 rechaza --cliente sin forma de uuid', () => {
    expect(() =>
      argumentos(['--cliente', 'no-es-un-uuid', '--usuario', usuario, '--archivo', 'x.xlsx']),
    ).toThrow();
  });

  it('🔴 rechaza --archivo faltante', () => {
    expect(() => argumentos(['--cliente', cliente, '--usuario', usuario])).toThrow();
  });
});

// `NodoPlanCuentas` sintético mínimo — solo los campos que `resolverFilas` efectivamente lee.
function nodo(parcial: Partial<NodoPlanCuentas> & Pick<NodoPlanCuentas, 'codigo'>): NodoPlanCuentas {
  return {
    fila: 5,
    codigo: parcial.codigo,
    denominacion: parcial.denominacion ?? `DENOMINACION ${parcial.codigo}`,
    nivelDeclarado: parcial.nivelDeclarado ?? 1,
    profundidadReal: parcial.profundidadReal ?? 1,
    recibe: parcial.recibe ?? true,
    sumariza: parcial.sumariza ?? null,
    monetaria: parcial.monetaria ?? false,
    rolFuncionalCandidato: parcial.rolFuncionalCandidato ?? 'generica',
  };
}

function resultado(nodos: readonly NodoPlanCuentas[]): ResultadoParseoPlanCuentas {
  return { nodos, anomalias: [], jerarquiaCruzadaEvaluable: true };
}

const OPCIONES_BASE = { usuario: 'usr', vigenteDesde: '2026-08-27', archivoRef: 'archivo.xlsx', mapeoRef: null };

describe('resolverFilas — nunca asume por matching de texto (D-25, Opción A)', () => {
  it('nodo genérico no necesita entrada en el mapeo', () => {
    const r = resolverFilas(resultado([nodo({ codigo: '1.0.0.000' })]), {}, OPCIONES_BASE);
    expect(r.faltantesEnMapeo).toEqual([]);
    expect(r.filas).toHaveLength(1);
    expect(r.filas[0]?.padronSocioId).toBeNull();
  });

  it('🔴 nodo candidato a socio SIN entrada en el mapeo → faltantesEnMapeo, se excluye de `filas`', () => {
    const r = resolverFilas(
      resultado([nodo({ codigo: '1.2.4.300', rolFuncionalCandidato: 'cuenta_particular_socio' })]),
      {},
      OPCIONES_BASE,
    );
    expect(r.faltantesEnMapeo).toEqual(['1.2.4.300']);
    expect(r.filas).toEqual([]);
  });

  it('🔴 entrada EXPLÍCITA null en el mapeo (socio todavía no resuelto) también cuenta como faltante, nunca inserta con null', () => {
    const r = resolverFilas(
      resultado([nodo({ codigo: '1.2.4.300', rolFuncionalCandidato: 'cuenta_particular_socio' })]),
      { '1.2.4.300': null },
      OPCIONES_BASE,
    );
    expect(r.faltantesEnMapeo).toEqual(['1.2.4.300']);
    expect(r.filas).toEqual([]);
  });

  it('con el mapeo completo, resuelve padronSocioId y arma el respaldo referenciando el archivo de mapeo', () => {
    const socioId = randomUUID();
    const r = resolverFilas(
      resultado([nodo({ codigo: '1.2.4.300', rolFuncionalCandidato: 'cuenta_particular_socio' })]),
      { '1.2.4.300': socioId },
      { ...OPCIONES_BASE, mapeoRef: 'mapeo-socios.json' },
    );
    expect(r.faltantesEnMapeo).toEqual([]);
    expect(r.filas[0]?.padronSocioId).toBe(socioId);
    expect(r.filas[0]?.respaldo).toContain('mapeo-socios.json');
  });

  it('nodo genérico NO referencia el mapeo en el respaldo, aunque exista mapeoRef', () => {
    const r = resolverFilas(resultado([nodo({ codigo: '1.0.0.000' })]), {}, { ...OPCIONES_BASE, mapeoRef: 'mapeo-socios.json' });
    expect(r.filas[0]?.respaldo).not.toContain('mapeo-socios.json');
  });

  it('cuentaPadreCodigo sale de `sumariza` del nodo, no del campo NIVEL', () => {
    const r = resolverFilas(
      resultado([nodo({ codigo: '1.1.0.000', sumariza: '1.0.0.000', nivelDeclarado: 9, profundidadReal: 2 })]),
      {},
      OPCIONES_BASE,
    );
    expect(r.filas[0]?.cuentaPadreCodigo).toBe('1.0.0.000');
    expect(r.filas[0]?.nivel).toBe(2);
  });

  it('varios nodos: los faltantes no bloquean a los que sí resolvieron', () => {
    const socioId = randomUUID();
    const r = resolverFilas(
      resultado([
        nodo({ codigo: '1.0.0.000' }),
        nodo({ codigo: '1.2.4.300', rolFuncionalCandidato: 'cuenta_particular_socio' }),
        nodo({ codigo: '2.1.9.100', rolFuncionalCandidato: 'cuenta_particular_socio' }),
      ]),
      { '1.2.4.300': socioId },
      OPCIONES_BASE,
    );
    expect(r.faltantesEnMapeo).toEqual(['2.1.9.100']);
    expect(r.filas.map((f) => f.codigo)).toEqual(['1.0.0.000', '1.2.4.300']);
  });
});
