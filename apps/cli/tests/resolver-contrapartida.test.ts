/**
 * `resolver-contrapartida.ts` — el CLI de dry-run de capa C. Plan `adaptive-herding-pillow`, P6.
 *
 * Dos niveles: `agregarMatriz`/`parsearArgumentos` puros (sin base), y el flujo completo contra
 * Postgres real — la primera vez que `reconocer()` (capa B) corre sobre filas reales de
 * `movimiento_bancario_crudo`, encadenado con `resolverContraparte()` (capa C).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { hmacDocumento } from '@sistema-contable/shared/seguridad';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { escribirAltaDeSocio } from '../src/alta-socio.ts';
import { agregarMatriz, parsearArgumentos, resolverContrapartidaDeLote } from '../src/resolver-contrapartida.ts';
import type { Reconocimiento, ResolucionDeContraparte } from '@sistema-contable/contabilidad';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
  // sembrar() trunca `banco` junto con el resto (mismo patrón que backfill-contraparte.test.ts):
  // la fila 'galicia' de la migración 0011 no sobrevive. Se re-crea con el dueño del esquema.
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades, activo)
       values ('galicia', 'BANCO GALICIA (test)', '{}'::jsonb, true)
       on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

describe('parsearArgumentos', () => {
  it('parsea --cliente --usuario --lote-id sin --padron-completo', () => {
    const cliente = randomUUID();
    const usuario = randomUUID();
    const loteId = randomUUID();
    const args = parsearArgumentos(['--cliente', cliente, '--usuario', usuario, '--lote-id', loteId]);
    expect(args).toEqual({ cliente, usuario, loteId, padronCompleto: false });
  });

  it('reconoce --padron-completo como bandera', () => {
    const cliente = randomUUID();
    const usuario = randomUUID();
    const loteId = randomUUID();
    const args = parsearArgumentos([
      '--cliente', cliente, '--usuario', usuario, '--lote-id', loteId, '--padron-completo',
    ]);
    expect(args.padronCompleto).toBe(true);
  });

  it('rechaza argumentos faltantes', () => {
    expect(() => parsearArgumentos([])).toThrow();
  });
});

function decisionHumana(): Extract<Reconocimiento, { clase: 'decision_humana' }> {
  return {
    clase: 'decision_humana',
    tipo: 'pago_a_proveedor_transferencia',
    concepto: 'transferencia_a_terceros',
    polaridad: 'normal',
    lado: 'debe',
    via: 'texto_literal_exacto',
    evidencia: { entradaLexicoId: 'x', via: 'texto_literal_exacto', caracteresMatcheados: 5, huboCola: false },
    queDecide: 'distinguir_tercero_de_socio',
  };
}

function propuestaDesde(
  base: Extract<Reconocimiento, { clase: 'decision_humana' }>,
  tipo: Extract<Reconocimiento, { clase: 'propuesta' }>['tipo'],
  resolucion: ResolucionDeContraparte,
): Extract<Reconocimiento, { clase: 'propuesta' }> {
  return {
    clase: 'propuesta',
    tipo,
    concepto: base.concepto,
    polaridad: base.polaridad,
    lado: base.lado,
    via: base.via,
    evidencia: base.evidencia,
    evidenciaContrapartida: resolucion,
  };
}

describe('agregarMatriz — pura, sin base', () => {
  it('cuenta por clase antes/después y por estado de resolución', () => {
    const antes = decisionHumana();
    const despuesEsSocio = propuestaDesde(antes, 'retiro_de_socio', { estado: 'es_socio', socioId: 'socio-1', matches: [] });
    const despuesSinMatch: Reconocimiento = {
      ...antes,
      evidenciaContrapartida: { estado: 'sin_match_padron_incompleto' },
    };

    const matriz = agregarMatriz([
      { antes, despues: despuesEsSocio },
      { antes, despues: despuesSinMatch },
    ]);

    expect(matriz.porClaseAntes).toEqual({ propuesta: 0, decision_humana: 2, sin_reconocer: 0 });
    expect(matriz.porClaseDespues).toEqual({ propuesta: 1, decision_humana: 1, sin_reconocer: 0 });
    expect(matriz.porEstadoDeResolucion.es_socio).toBe(1);
    expect(matriz.porEstadoDeResolucion.sin_match_padron_incompleto).toBe(1);
    expect(matriz.sociosInvolucrados).toBe(1);
  });

  /** `sociosInvolucrados` es un conteo de socios DISTINTOS, no de filas ni de movimientos (H-2,
   *  `0021`). Sin este caso, un `socios.size` cambiado por un contador de movimientos pasaría
   *  verde: los dos dan 1 cuando hay un solo movimiento. */
  it('cuenta socios DISTINTOS, no movimientos ni matches', () => {
    const antes = decisionHumana();
    const conA = propuestaDesde(antes, 'retiro_de_socio', { estado: 'es_socio', socioId: 'socio-A', matches: [] });
    const otraDeA = propuestaDesde(antes, 'retiro_de_socio', { estado: 'es_socio', socioId: 'socio-A', matches: [] });
    const conB = propuestaDesde(antes, 'retiro_de_socio', { estado: 'es_socio', socioId: 'socio-B', matches: [] });

    expect(agregarMatriz([{ antes, despues: conA }, { antes, despues: otraDeA }]).sociosInvolucrados).toBe(1);
    expect(agregarMatriz([{ antes, despues: conA }, { antes, despues: conB }]).sociosInvolucrados).toBe(2);
  });

  it('lista vacía → todo en cero', () => {
    const matriz = agregarMatriz([]);
    expect(matriz.porClaseAntes).toEqual({ propuesta: 0, decision_humana: 0, sin_reconocer: 0 });
    expect(matriz.sociosInvolucrados).toBe(0);
  });

  /**
   * 🔴 EL TEST DE SEGURIDAD DE H-2, REESCRITO SOBRE LA PROPIEDAD.
   *
   * La versión anterior corría sobre `agregarMatriz([])` y afirmaba `not.toMatch(/denominacion/i)`.
   * **No ejercía nada**: un agregado de CERO entradas no puede contener un dato del cliente viniera
   * de donde viniera, así que el assert pasaba con o sin fuga. Es la misma falla que la mutación M4
   * encontró en P0 de `0021` — un caso que no alcanza la propiedad que dice cubrir.
   *
   * La propiedad real es: **`Matriz` se publica entera a stdout con `process.stdout.write`, que
   * ESQUIVA el redactor, así que ningún identificador de socio puede aparecer en el resultado — por
   * más que la ENTRADA esté llena de ellos.** Por eso acá la entrada trae los tres estados que
   * cargan `socioId` (`es_socio`, `multiples_socios`, `socio_fuera_de_vigencia`), con valores
   * reconocibles, y se busca cada uno en el JSON serializado.
   *
   * Discrimina el cambio de H-2 exactamente: con la forma vieja (`sociosInvolucrados: string[]`)
   * este test se pone ROJO, porque 'socio-secreto-A' viajaba en el resultado.
   */
  it('🔴 H-2: ningún identificador de socio sale en el resultado, aunque la entrada esté llena', () => {
    const antes = decisionHumana();
    const entradas = [
      { antes, despues: propuestaDesde(antes, 'retiro_de_socio', {
        estado: 'es_socio', socioId: 'socio-secreto-A', matches: [{ socioId: 'socio-secreto-A', clase: 'cuit' as const }],
      }) },
      { antes, despues: { ...antes, evidenciaContrapartida: {
        estado: 'multiples_socios' as const,
        matches: [{ socioId: 'socio-secreto-B', clase: 'cuit' as const }, { socioId: 'socio-secreto-C', clase: 'cbu' as const }],
      } } as Reconocimiento },
      { antes, despues: { ...antes, evidenciaContrapartida: {
        estado: 'socio_fuera_de_vigencia' as const,
        matches: [{ socioId: 'socio-secreto-D', clase: 'cuit' as const, vigenteDesde: '2020-01-01', vigenteHasta: '2021-01-01' }],
      } } as Reconocimiento },
    ];

    const serializado = JSON.stringify(agregarMatriz(entradas));

    for (const secreto of ['socio-secreto-A', 'socio-secreto-B', 'socio-secreto-C', 'socio-secreto-D']) {
      expect(serializado, `el identificador ${secreto} salió en la Matriz, que se publica a stdout sin redactor`)
        .not.toContain(secreto);
    }
    // Y el conteo sigue siendo información útil: cuatro socios distintos entre las tres entradas.
    expect(agregarMatriz(entradas).sociosInvolucrados).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Flujo completo — Postgres real. Conecta reconocer() (capa B) con resolverContraparte() (capa C)
// por primera vez desde filas reales.
// -----------------------------------------------------------------------------

async function crearLoteGaliciaConMovimiento(args: {
  readonly clienteId: string;
  readonly conceptoBanco: string;
  readonly importe: string;
  readonly fecha: string;
}): Promise<{ readonly loteId: string; readonly movimientoId: string }> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const cuenta = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, 'galicia', 'ARS')
       returning id::text as id`,
      [args.clienteId],
    );
    const cuentaId = cuenta[0]?.id ?? '';
    const lote = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas, filas_aceptadas)
       values ($1, 'galicia', 'prueba@1', 'archivo', $2, 'procesado', 1, 1)
       returning id::text as id`,
      [args.clienteId, randomUUID()],
    );
    const loteId = lote[0]?.id ?? '';
    await tx.consultar(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
      [args.clienteId, loteId, cuentaId],
    );
    const mov = await tx.consultar<{ id: string }>(
      `insert into movimiento_bancario_crudo
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
          importe, concepto_banco, concepto_completo, concepto_banco_estrategia, contraparte_captura)
       values ($1, $2, $3, 1, $4, $5::date, $6, $7::numeric, $6, true, 'segmento_de_glosa', 'capturado')
       returning id::text as id`,
      [args.clienteId, loteId, cuentaId, `hash_resolver_${randomUUID()}`, args.fecha, args.conceptoBanco, args.importe],
    );
    return { loteId, movimientoId: mov[0]?.id ?? '' };
  });
}

async function agregarCandidato(args: {
  readonly clienteId: string;
  readonly movimientoId: string;
  readonly documento: string;
  readonly pepperId: string;
}): Promise<void> {
  const hmac = hmacDocumento('cuit', args.documento, args.clienteId);
  await conUsuario(USUARIOS.socio, (tx) =>
    tx.consultar(
      `insert into movimiento_contraparte_identificador (cliente_id, movimiento_id, clase, identificador_hmac, pepper_id)
       values ($1, $2, 'cuit', $3, $4)`,
      [args.clienteId, args.movimientoId, hmac, args.pepperId],
    ),
  );
}

describe('resolverContrapartidaDeLote — flujo completo (base real)', () => {
  it('un candidato que matchea un socio del padrón promueve a propuesta (retiro_de_socio, lado debe)', async () => {
    const documento = '20999900001';
    const socio = await escribirAltaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      denominacion: 'SOCIO RESOLVER SRL',
      documentoTipo: 'cuit',
      documento,
      vigenciaDesde: '2026-01-01',
    });
    expect(socio.estado).toBe('alta');

    const { loteId, movimientoId } = await crearLoteGaliciaConMovimiento({
      clienteId: s.clienteA,
      conceptoBanco: 'TRANSFERENCIA A TERCEROS',
      importe: '-1000.00',
      fecha: '2026-06-15',
    });
    await agregarCandidato({ clienteId: s.clienteA, movimientoId, documento, pepperId: 'v1' });

    const r = await resolverContrapartidaDeLote({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      loteId,
      padronCompleto: false,
    });

    expect(r.estado).toBe('reportado');
    if (r.estado === 'reportado') {
      expect(r.porClaseDespues.propuesta).toBe(1);
      expect(r.porEstadoDeResolucion.es_socio).toBe(1);
      expect(r.sociosInvolucrados).toBe(1);
      // Nunca la denominación en el reporte.
      expect(JSON.stringify(r)).not.toMatch(/SOCIO RESOLVER SRL/);
    }
  });

  it('🔴 candidato con pepper distinto al del padrón → pepper_desalineado, NUNCA es_tercero_padron_completo', async () => {
    const documento = '20999900002';
    await escribirAltaDeSocio({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      denominacion: 'SOCIO PEPPER SRL',
      documentoTipo: 'cuit',
      documento,
      vigenciaDesde: '2026-01-01',
    });

    const { loteId, movimientoId } = await crearLoteGaliciaConMovimiento({
      clienteId: s.clienteA,
      conceptoBanco: 'TRANSFERENCIA A TERCEROS',
      importe: '-500.00',
      fecha: '2026-06-15',
    });
    // Candidato de OTRO documento, pero con pepper 'v99' (inexistente en el padrón real, que está
    // todo en 'v1') — fuerza la rama de desalineamiento sin depender de una rotación real.
    await agregarCandidato({ clienteId: s.clienteA, movimientoId, documento: '20111111112', pepperId: 'v99' });

    const r = await resolverContrapartidaDeLote({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      loteId,
      padronCompleto: true, // gate activo A PROPÓSITO — ni así debería dar es_tercero
    });

    expect(r.estado).toBe('reportado');
    if (r.estado === 'reportado') {
      expect(r.porEstadoDeResolucion.pepper_desalineado).toBe(1);
      expect(r.porEstadoDeResolucion.es_tercero_padron_completo).toBe(0);
      expect(r.porClaseDespues.propuesta).toBe(0);
    }
  });
});
