/**
 * AISLAMIENTO DE LAS TABLAS DEL MÓDULO 2 — migración `0013_contraparte_hmac_y_padron.sql`.
 *
 * Mismo criterio que `aislamiento-ingesta.test.ts` para el Módulo 1: la estructura (RLS forzada,
 * predicado canónico, FK compuestas) ya la verifica `catalogo.test.ts`; esto verifica el
 * COMPORTAMIENTO, con la misma credencial que va a usar la aplicación.
 *
 * `movimiento_contraparte_identificador` y `padron_socio` quedan explícitamente FUERA del barrido
 * de `packages/ingesta/tests/aislamiento-modulo-1.test.ts` (`FUERA_DEL_MODULO_1`) — su cobertura
 * de aislamiento vive acá, no ausente (`dba-data`, riesgo Nº4 de la ronda de revisión de `0013`:
 * "el arreglo tentador y equivocado" es excluir sin reemplazar).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '../src/db/conexion.ts';
import { leerConAuditoria } from '../src/db/auditoria.ts';
import {
  leerCandidatosDeContraparte,
  leerDocumentoDeSocio,
  leerPadronDeSocios,
  leerPadronYCandidatosDeContraparte,
  MovimientoAjenoAlClienteError,
} from '../src/contabilidad/lecturas.ts';
import { hmacDocumento } from '@sistema-contable/shared/seguridad';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;

const escenario = {
  cuentaA: '',
  loteA: '',
  movimientoA: '',
  movimientoB: '',
  socioA: '',
  socioB: '',
};

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ('banco_m2', 'BANCO MÓDULO 2', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const f1 = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
       values ($1, 'banco_m2', 'ARS', 'OPERATIVA M2 A') returning id::text as id`,
      [s.clienteA],
    );
    escenario.cuentaA = f1[0]?.id ?? '';

    const f2 = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
       values ($1, 'banco_m2', 'prueba-1', 'archivo', 'hash_m2_a', 'recibido', 0)
       returning id::text as id`,
      [s.clienteA],
    );
    escenario.loteA = f2[0]?.id ?? '';

    // `lote_ingesta_cuenta` es la FK que `fk_mov_crudo_lote_cuenta` exige antes de cualquier
    // movimiento — mismo requisito que `aislamiento-ingesta.test.ts`.
    const loteCuenta = async (clienteId: string, loteId: string, cuentaId: string): Promise<void> => {
      await tx.consultar(
        `insert into lote_ingesta_cuenta
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
            verificacion_estado)
         values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
        [clienteId, loteId, cuentaId],
      );
    };
    await loteCuenta(s.clienteA, escenario.loteA, escenario.cuentaA);

    // Un movimiento en cada cliente — se necesita la FK real para el bloque 4 (integridad referencial).
    const movimiento = async (clienteId: string, loteId: string, cuentaId: string | null): Promise<string> => {
      const f = await tx.consultar<{ id: string }>(
        `insert into movimiento_bancario_crudo
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
            fecha, descripcion, importe, saldo, concepto_banco_estrategia, contraparte_captura)
         values ($1, $2, $3, 1, $4, '2026-06-15', 'CONCEPTO M2', -100.00, 900.00, 'no_publicado',
                 'no_capturado')
         returning id::text as id`,
        [clienteId, loteId, cuentaId, `hash_m2_${clienteId}`],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó el movimiento');
      return id;
    };
    escenario.movimientoA = await movimiento(s.clienteA, escenario.loteA, escenario.cuentaA);

    // Cliente B, con su propio lote y cuenta.
    const cB = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
       values ($1, 'banco_m2', 'ARS', 'OPERATIVA M2 B') returning id::text as id`,
      [s.clienteB],
    );
    const loteB = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
       values ($1, 'banco_m2', 'prueba-1', 'archivo', 'hash_m2_b', 'recibido', 0)
       returning id::text as id`,
      [s.clienteB],
    );
    const cuentaBId = cB[0]?.id ?? '';
    const loteBId = loteB[0]?.id ?? '';
    await loteCuenta(s.clienteB, loteBId, cuentaBId);
    escenario.movimientoB = await movimiento(s.clienteB, loteBId, cuentaBId);

    // Un candidato de contraparte por movimiento — digest DERIVADO por cliente (hmacDocumento),
    // nunca `hmacIdentificador` pelada: es lo que este módulo agrega sobre el mecanismo del
    // Módulo 1.
    for (const [clienteId, movimientoId] of [
      [s.clienteA, escenario.movimientoA],
      [s.clienteB, escenario.movimientoB],
    ] as const) {
      await tx.consultar(
        `insert into movimiento_contraparte_identificador
           (cliente_id, movimiento_id, clase, identificador_hmac, pepper_id)
         values ($1, $2, 'cuit', $3, 'v1')`,
        [clienteId, movimientoId, hmacDocumento('cuit', '30712345678', clienteId)],
      );
    }

    // Un socio por cliente, con su documento en la satélite N2-R.
    for (const [clienteId, socioKey] of [
      [s.clienteA, 'socioA'],
      [s.clienteB, 'socioB'],
    ] as const) {
      const documento = clienteId === s.clienteA ? '20111111112' : '20222222223';
      const f = await tx.consultar<{ id: string }>(
        `insert into padron_socio
           (cliente_id, denominacion, documento_tipo, documento_hmac, documento_ultimos4, pepper_id,
            vigente_desde)
         values ($1, 'SOCIO DE PRUEBA', 'cuit', $2, $3, 'v1', '2026-01-01')
         returning id::text as id`,
        [clienteId, hmacDocumento('cuit', documento, clienteId), documento.slice(-4)],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó el socio');
      if (socioKey === 'socioA') escenario.socioA = id;
      else escenario.socioB = id;

      await tx.consultar(
        `insert into padron_socio_documento (cliente_id, socio_id, documento) values ($1, $2, $3)`,
        [clienteId, id, documento],
      );
    }
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('RLS sobre `movimiento_contraparte_identificador`: sin rol adicional, solo tenant', () => {
  const contar = async (usuario: string): Promise<number> =>
    conUsuario(usuario, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_contraparte_identificador',
      );
      return Number(f[0]?.n ?? '-1');
    });

  it('el contador de A ve solo el candidato de A', async () => {
    expect(await contar(USUARIOS.contadorA)).toBe(1);
  });

  it('el socio del estudio ve los de sus dos clientes', async () => {
    expect(await contar(USUARIOS.socio)).toBe(2);
  });

  it('el socio de OTRO estudio no ve ninguno', async () => {
    expect(await contar(USUARIOS.socioOtroEstudio)).toBe(0);
  });

  it('el administrativo SÍ puede leerla — a diferencia de la satélite N2R, no tiene rol exigido', async () => {
    expect(await contar(USUARIOS.administrativoA)).toBe(1);
  });
});

// -----------------------------------------------------------------------------
describe('el pepper derivado por cliente: el digest de A no es comparable con el de B', () => {
  it('el mismo documento hasheado para A y para B da dos digests distintos', () => {
    const paraA = hmacDocumento('cuit', '30712345678', s.clienteA);
    const paraB = hmacDocumento('cuit', '30712345678', s.clienteB);
    expect(paraA.equals(paraB)).toBe(false);
  });

  it('`cuit` y `cuil` canonizan al mismo dominio de hash — mismo digest para el mismo cliente', () => {
    const comoCuit = hmacDocumento('cuit', '20111111112', s.clienteA);
    const comoCuil = hmacDocumento('cuil', '20111111112', s.clienteA);
    expect(comoCuit.equals(comoCuil)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
describe('RLS sobre `padron_socio`: sin rol adicional', () => {
  const contar = async (usuario: string): Promise<number> =>
    conUsuario(usuario, async (tx) => {
      const f = await tx.consultar<{ n: string }>('select count(*)::text as n from padron_socio');
      return Number(f[0]?.n ?? '-1');
    });

  it('el contador de A ve solo el socio de A', async () => {
    expect(await contar(USUARIOS.contadorA)).toBe(1);
  });

  it('el socio de OTRO estudio no ve ninguno', async () => {
    expect(await contar(USUARIOS.socioOtroEstudio)).toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('`padron_socio_documento` exige rol en LECTURA, no solo tenant — mismo H-8 que `movimiento_origen_crudo`', () => {
  const contar = async (usuario: string): Promise<number> =>
    conUsuario(usuario, async (tx) => {
      const f = await tx.consultar<{ n: string }>('select count(*)::text as n from padron_socio_documento');
      return Number(f[0]?.n ?? '-1');
    });

  it('el administrativo NO puede leer el documento en claro', async () => {
    expect(await contar(USUARIOS.administrativoA), 'H-8: leyó el documento del socio').toBe(0);
  });

  it('el contador y el auditor sí lo leen', async () => {
    expect(await contar(USUARIOS.contadorA)).toBe(1);
    expect(await contar(USUARIOS.auditorA)).toBe(1);
  });

  it('el lector auditado (`leerDocumentoDeSocio`) deja rastro y devuelve el documento', async () => {
    const contarRastro = async (): Promise<number> =>
      conUsuario(USUARIOS.socio, async (tx) => {
        const f = await tx.consultar<{ n: string }>(
          `select count(*)::text as n from acceso_auditoria where recurso = 'padron_socio_documento'`,
        );
        return Number(f[0]?.n ?? '0');
      });

    const antes = await contarRastro();

    const documento = await conUsuario(USUARIOS.contadorA, async (tx) =>
      leerConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'lectura', recurso: 'padron_socio_documento' },
        (ctx) => leerDocumentoDeSocio(tx, ctx, { clienteId: s.clienteA, socioId: escenario.socioA }),
      ),
    );

    expect(documento?.documento).toBe('20111111112');
    expect(await contarRastro()).toBe(antes + 1);
  });
});

// -----------------------------------------------------------------------------
describe('integridad referencial: un candidato no puede colgar de un movimiento de OTRO cliente', () => {
  /**
   * Igual que INV-2/INV-3 del Módulo 1: se arma con el `socio`, que tiene membresía en los dos
   * clientes — es el caso más fuerte, porque la RLS no lo frena y lo único que queda en pie es la
   * FK compuesta.
   */
  it('la FK compuesta rechaza un candidato con `cliente_id` de A pero `movimiento_id` de B', async () => {
    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        tx.consultar(
          `insert into movimiento_contraparte_identificador
             (cliente_id, movimiento_id, clase, identificador_hmac, pepper_id)
           values ($1, $2, 'cuit', $3, 'v1')`,
          [s.clienteA, escenario.movimientoB, hmacDocumento('cuit', '20111111112', s.clienteA)],
        ),
      ),
    ).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------
describe('leerPadronDeSocios / leerCandidatosDeContraparte — capa C, N2 puro sin auditoría', () => {
  it('leerPadronDeSocios trae solo el padrón del cliente pedido, sin denominación', async () => {
    const padron = await conUsuario(USUARIOS.contadorA, (tx) => leerPadronDeSocios(tx, s.clienteA));
    expect(padron).toHaveLength(1);
    expect(padron[0]?.id).toBe(escenario.socioA);
    expect(JSON.stringify(padron)).not.toMatch(/SOCIO DE PRUEBA/);
  });

  it('leerCandidatosDeContraparte agrupa por movimientoId — cada movimiento solo ve los suyos', async () => {
    const mapa = await conUsuario(USUARIOS.socio, (tx) =>
      leerCandidatosDeContraparte(tx, {
        clienteId: s.clienteA,
        movimientoIds: [escenario.movimientoA],
      }),
    );
    expect(mapa.size).toBe(1);
    expect(mapa.get(escenario.movimientoA)).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
describe('leerPadronYCandidatosDeContraparte — el guardrail de H-6/INV-9 (Ronda 1, seguridad-datos-financieros)', () => {
  /**
   * El caso real de H-6: `USUARIOS.socio` tiene membresía legítima en clienteA Y clienteB — las dos
   * lecturas (padrón de A, candidatos del movimiento) pasan RLS individualmente. El riesgo es que el
   * LLAMADOR pida el padrón de A pero pase el `movimientoId` de B por error: sin el guardrail, esa
   * fila desaparecería en silencio del resultado (0 candidatos, indistinguible de "sin evidencia").
   */
  it('camino feliz: movimientoId que sí pertenece al cliente pedido', async () => {
    const r = await conUsuario(USUARIOS.socio, (tx) =>
      leerPadronYCandidatosDeContraparte(tx, {
        clienteId: s.clienteA,
        movimientoIds: [escenario.movimientoA],
      }),
    );
    expect(r.padron).toHaveLength(1);
    expect(r.candidatosPorMovimiento.get(escenario.movimientoA)).toHaveLength(1);
  });

  it('🔴 aborta con MovimientoAjenoAlClienteError si el movimiento es de OTRO cliente — aunque el usuario tenga membership en los dos', async () => {
    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        leerPadronYCandidatosDeContraparte(tx, {
          clienteId: s.clienteA,
          movimientoIds: [escenario.movimientoB], // de clienteB, no de clienteA
        }),
      ),
    ).rejects.toThrow(MovimientoAjenoAlClienteError);
  });

  it('el error no revela el padrón ni los candidatos — se aborta ANTES de leerlos', async () => {
    let error: unknown;
    try {
      await conUsuario(USUARIOS.socio, (tx) =>
        leerPadronYCandidatosDeContraparte(tx, { clienteId: s.clienteA, movimientoIds: [escenario.movimientoB] }),
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MovimientoAjenoAlClienteError);
    if (error instanceof MovimientoAjenoAlClienteError) {
      expect(error.movimientoIdsAjenos).toEqual([escenario.movimientoB]);
    }
  });
});
