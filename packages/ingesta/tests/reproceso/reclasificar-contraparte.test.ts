/**
 * `calcularReclasificacion` — el cálculo PURO de `reclasificar-contraparte.ts`. Sin base, sin
 * storage: vuelve a correr `depurarGlosa()` + `extraerCandidatosDeContraparte()` con el código
 * ACTUAL sobre `glosaOriginal` y compara contra lo persistido.
 *
 * Fixture `20111111112` (prefijo AFIP válido `20` + 8 dígitos + verificador, inventado — sin
 * relación con ningún CUIT real): el mismo sintético que
 * `packages/ingesta/tests/detectores-compartidos.test.ts` usa para el caso real que motiva esta
 * tarea — un CUIT pegado a una palabra, sin separador, que `RE_CUIT` no detectaba antes de
 * `cb084a0`.
 */

import { describe, expect, it } from 'vitest';
import { hmacIdentificador } from '@sistema-contable/shared/seguridad';
import {
  calcularReclasificacion,
  type CapturaDeContraparte,
  type InsumosDeReclasificacion,
} from '../../src/reproceso/reclasificar-contraparte.ts';

const CLIENTE = '11111111-1111-1111-1111-111111111111';
const CUIT_SINTETICO = '20111111112';

function insumos(args: {
  readonly filas: readonly { readonly movimientoId: string; readonly filaOrigen: unknown }[];
  readonly capturaPersistidaPorMovimiento: ReadonlyMap<string, CapturaDeContraparte>;
  readonly clasesPersistidasPorMovimiento?: ReadonlyMap<string, ReadonlySet<'cuit' | 'dni' | 'cbu'>>;
}): InsumosDeReclasificacion {
  return {
    filasOrigen: args.filas,
    digestsPropios: [],
    capturaPersistidaPorMovimiento: args.capturaPersistidaPorMovimiento,
    clasesPersistidasPorMovimiento: args.clasesPersistidasPorMovimiento ?? new Map(),
  };
}

describe('calcularReclasificacion — sin cambio', () => {
  it('una glosa que ya clasificaba bien (CUIT con separador, siempre detectado) da sinCambio', () => {
    const mov = 'aaaaaaaa-0000-0000-0000-000000000001';
    const r = calcularReclasificacion(
      CLIENTE,
      insumos({
        filas: [{ movimientoId: mov, filaOrigen: { glosaOriginal: 'TRANSF 30-71234567-8 VARIOS' } }],
        capturaPersistidaPorMovimiento: new Map([[mov, 'capturado']]),
        clasesPersistidasPorMovimiento: new Map([[mov, new Set(['cuit'])]]),
      }),
    );
    expect(r.reporte.sinCambio).toBe(1);
    expect(r.reporte.porTransicionDeCaptura).toEqual({ 'capturado->capturado': 1 });
    expect(r.reporte.candidatosNuevosPorClase).toEqual({});
    expect(r.aEscribir).toEqual([]);
  });
});

describe('calcularReclasificacion — el caso real de hoy: sin_identificador -> capturado', () => {
  it('CUIT pegado a una palabra sin separador (DOC + CUIT): el bug de RE_CUIT ya no reproduce, se recaptura', () => {
    const mov = 'aaaaaaaa-0000-0000-0000-000000000002';
    const r = calcularReclasificacion(
      CLIENTE,
      insumos({
        filas: [{ movimientoId: mov, filaOrigen: { glosaOriginal: `DOC${CUIT_SINTETICO}` } }],
        // Lo que dejó el bug de `\b` (`RE_CUIT` no matcheaba una letra pegada): sin candidato.
        capturaPersistidaPorMovimiento: new Map([[mov, 'sin_identificador']]),
      }),
    );
    expect(r.reporte.sinCambio).toBe(0);
    expect(r.reporte.porTransicionDeCaptura).toEqual({ 'sin_identificador->capturado': 1 });
    expect(r.reporte.candidatosNuevosPorClase).toEqual({ cuit: 1 });
    expect(r.aEscribir).toHaveLength(1);
    expect(r.aEscribir[0]?.movimientoId).toBe(mov);
    expect(r.aEscribir[0]?.capturaNueva).toBe('capturado');
    expect(r.aEscribir[0]?.candidatos).toHaveLength(1);
    expect(r.aEscribir[0]?.candidatos[0]?.clase).toBe('cuit');
  });

  it('lote nunca tocado por 0013 (no_capturado): también recaptura y queda para escribir', () => {
    const mov = 'aaaaaaaa-0000-0000-0000-000000000003';
    const r = calcularReclasificacion(
      CLIENTE,
      insumos({
        filas: [{ movimientoId: mov, filaOrigen: { glosaOriginal: `${CUIT_SINTETICO}VARIOS` } }],
        capturaPersistidaPorMovimiento: new Map(), // sin entrada: default 'no_capturado'
      }),
    );
    expect(r.reporte.porTransicionDeCaptura).toEqual({ 'no_capturado->capturado': 1 });
    expect(r.aEscribir).toHaveLength(1);
  });

  // TESTER: la glosa REAL de ROKA no es solo `DOC<cuit>` pelado — trae el prefijo `TPUSH`, el
  // nombre de la contraparte y un número de operación alrededor. El regex de `RE_CUIT` no debería
  // importarle el contexto (usa lookaround, no separadores), pero se ejercita con la forma completa
  // para no confiar solo en el caso pelado.
  it('glosa con la forma completa de producción (TPUSH <nombre> DOC<cuit> <n>) también recaptura', () => {
    const mov = 'aaaaaaaa-0000-0000-0000-000000000009';
    const r = calcularReclasificacion(
      CLIENTE,
      insumos({
        filas: [
          { movimientoId: mov, filaOrigen: { glosaOriginal: `TPUSH JUAN CARLOS PEREZ DOC${CUIT_SINTETICO} 001` } },
        ],
        capturaPersistidaPorMovimiento: new Map([[mov, 'sin_identificador']]),
      }),
    );
    expect(r.reporte.porTransicionDeCaptura).toEqual({ 'sin_identificador->capturado': 1 });
    expect(r.aEscribir).toHaveLength(1);
    expect(r.aEscribir[0]?.candidatos[0]?.clase).toBe('cuit');
  });
});

describe('calcularReclasificacion — descartadosPorForma se mantiene igual', () => {
  it('una corrida larga (CBU truncado / número de operación) sigue descartándose, sin cambio de captura', () => {
    const mov = 'aaaaaaaa-0000-0000-0000-000000000004';
    // 13 dígitos: cae en RE_CORRIDA_LARGA -> bucket "documento" -> el guard de forma lo descarta
    // (no es ni 7-8 ni 22 dígitos). Mismo caso medido en contraparte.test.ts.
    const r = calcularReclasificacion(
      CLIENTE,
      insumos({
        filas: [{ movimientoId: mov, filaOrigen: { glosaOriginal: 'REF 1234567890123 FIN' } }],
        capturaPersistidaPorMovimiento: new Map([[mov, 'sin_identificador']]),
      }),
    );
    expect(r.reporte.sinCambio).toBe(1);
    expect(r.reporte.descartadosPorForma).toBe(1);
    expect(r.aEscribir).toEqual([]);
  });
});

describe('calcularReclasificacion — filas sin glosaOriginal legible', () => {
  it('una fila_origen con otra forma (sin glosaOriginal string) se cuenta y se salta, no revienta el lote', () => {
    const mov = 'aaaaaaaa-0000-0000-0000-000000000005';
    const r = calcularReclasificacion(
      CLIENTE,
      insumos({
        filas: [{ movimientoId: mov, filaOrigen: { otraCosa: true } }],
        capturaPersistidaPorMovimiento: new Map([[mov, 'sin_identificador']]),
      }),
    );
    expect(r.reporte.filasSinGlosaOriginal).toBe(1);
    expect(r.reporte.sinCambio).toBe(0);
    expect(r.aEscribir).toEqual([]);
  });
});

describe('calcularReclasificacion — caso 3 del panel de tester: capturado_cuenta_propia no se reclasifica como tercero', () => {
  it('un movimiento ya capturado_cuenta_propia, con el mismo CBU propio en digestsPropios, sigue sin cambio', () => {
    const mov = 'aaaaaaaa-0000-0000-0000-000000000007';
    const CBU_PROPIO = '9990000090000000000101';
    const digestPropio = hmacIdentificador(CBU_PROPIO);
    const r = calcularReclasificacion(CLIENTE, {
      filasOrigen: [{ movimientoId: mov, filaOrigen: { glosaOriginal: `TRANSF ${CBU_PROPIO} ENTRE CUENTAS` } }],
      digestsPropios: [digestPropio],
      capturaPersistidaPorMovimiento: new Map([[mov, 'capturado_cuenta_propia']]),
      clasesPersistidasPorMovimiento: new Map(),
    });
    // Sigue viéndose como la cuenta propia: NO se trata como un candidato de tercero nuevo.
    expect(r.reporte.porTransicionDeCaptura).toEqual({ 'capturado_cuenta_propia->capturado_cuenta_propia': 1 });
    expect(r.reporte.candidatosNuevosPorClase).toEqual({});
    expect(r.aEscribir).toEqual([]);
  });

  it('si `digestsPropios` llega vacío (cuenta propia dada de baja/no releída), SÍ se recaptura como candidato de tercero — comportamiento esperado, no un bug: el reproceso siempre usa el padrón de cuentas propias VIGENTE, no el de la ingesta original', () => {
    const mov = 'aaaaaaaa-0000-0000-0000-000000000008';
    const CBU_PROPIO = '9990000090000000000101';
    const r = calcularReclasificacion(CLIENTE, {
      filasOrigen: [{ movimientoId: mov, filaOrigen: { glosaOriginal: `TRANSF ${CBU_PROPIO} ENTRE CUENTAS` } }],
      digestsPropios: [], // el padrón vigente ya no reconoce este CBU como propio
      capturaPersistidaPorMovimiento: new Map([[mov, 'capturado_cuenta_propia']]),
      clasesPersistidasPorMovimiento: new Map(),
    });
    expect(r.reporte.porTransicionDeCaptura).toEqual({ 'capturado_cuenta_propia->capturado': 1 });
    expect(r.aEscribir).toHaveLength(1);
    expect(r.aEscribir[0]?.candidatos[0]?.clase).toBe('cbu');
  });
});

describe('calcularReclasificacion — candidatosQueDeberianRemoverse, reportado y NUNCA escrito', () => {
  it('una clase persistida que el cálculo actual ya no reproduce se cuenta, y la fila NO se agrega a aEscribir solo por eso', () => {
    const mov = 'aaaaaaaa-0000-0000-0000-000000000006';
    // Glosa sin ningún identificador hoy, pero con una clase 'dni' persistida — caso sintético
    // para ejercitar el conteo de "debería removerse" sin depender de un bug real reproducible.
    const r = calcularReclasificacion(
      CLIENTE,
      insumos({
        filas: [{ movimientoId: mov, filaOrigen: { glosaOriginal: 'TRANSFERENCIA SIN IDENTIFICADOR' } }],
        capturaPersistidaPorMovimiento: new Map([[mov, 'capturado']]),
        clasesPersistidasPorMovimiento: new Map([[mov, new Set(['dni'])]]),
      }),
    );
    expect(r.reporte.candidatosQueDeberianRemoverse).toBe(1);
    // captura SÍ cambia (capturado -> sin_identificador): la fila entra a aEscribir por eso, pero
    // sin ningún candidato nuevo — nunca se genera un DELETE, ver la cabecera del módulo.
    expect(r.reporte.porTransicionDeCaptura).toEqual({ 'capturado->sin_identificador': 1 });
    expect(r.aEscribir).toHaveLength(1);
    expect(r.aEscribir[0]?.candidatos).toEqual([]);
  });
});
