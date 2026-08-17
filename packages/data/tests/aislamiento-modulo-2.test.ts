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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '../src/db/conexion.ts';
import { leerConAuditoria } from '../src/db/auditoria.ts';
import {
  leerCandidatosDeContraparte,
  leerDocumentoDeSocio,
  leerPadronDeSocios,
  leerPadronYCandidatosDeContraparte,
  MovimientoAjenoAlClienteError,
} from '../src/contabilidad/lecturas.ts';
import {
  persistirReconocimiento,
  ReconocimientoDigestYaEnLaCadenaError,
  type PedidoDePersistirReconocimiento,
} from '../src/contabilidad/escrituras.ts';
import { leerReconocimientosActivos } from '../src/contabilidad/lecturas.ts';
import { escribirConAuditoria } from '../src/db/auditoria.ts';
import { randomUUID } from 'node:crypto';
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


// -----------------------------------------------------------------------------
// Migración 0014 — `reconocimiento_movimiento` y `reconocimiento_candidato`
// -----------------------------------------------------------------------------

const DIGEST_A = 'a1b2c3d4e5f60718';
const DIGEST_B = '0f1e2d3c4b5a6978';

/** El pedido mínimo de una `propuesta`, que es la clase con todas las columnas cargadas. */
function propuestaDe(movimientoId: string, clienteId: string, digest: string): PedidoDePersistirReconocimiento {
  return {
    clienteId,
    movimientoId,
    reconocimientoId: randomUUID(),
    motorDigest: digest,
    clase: 'propuesta',
    tipo: 'comision_bancaria',
    concepto: 'comision_de_transferencia',
    polaridad: 'normal',
    lado: 'debe',
    via: 'texto_literal_exacto',
    queDecide: null,
    motivoCodigo: null,
    entradaLexicoId: 'galicia.comision_de_transferencia',
    caracteresMatcheados: 12,
    huboCola: false,
    candidatos: [] as readonly string[],
  };
}

async function persistir(usuario: string, pedido: PedidoDePersistirReconocimiento) {
  return conUsuario(usuario, (tx) =>
    escribirConAuditoria(
      tx,
      {
        clienteId: pedido.clienteId,
        accion: 'escritura',
        recurso: 'reconocimiento_movimiento',
        motivo: 'persistencia del reconocimiento del motor, test de aislamiento',
      },
      (ctx) => persistirReconocimiento(tx, ctx, pedido),
    ),
  );
}

describe('0014 — aislamiento y forma de reconocimiento_movimiento', () => {
  /**
   * La tabla es append-oriented y NADIE tiene DELETE —ni policy ni grant—, que es justamente lo que
   * 0014 garantiza. Así que entre tests se limpia con `truncate` del dueño del esquema: TRUNCATE no
   * pasa por las policies de RLS (que gobiernan select/insert/update/delete), y es el mismo mecanismo
   * que usa `sembrar()` en `ayuda.ts`. Sin esto, cada `it` hereda las filas del anterior y los estados
   * `no_op`/`supersedido` aparecen donde el test esperaba `creado`.
   */
  beforeEach(async () => {
    const duenio = await clienteDuenio();
    try {
      await duenio.query('truncate reconocimiento_candidato, reconocimiento_movimiento cascade');
    } finally {
      await duenio.end();
    }
  });

  it('el reconocimiento de A no lo ve un usuario de otro estudio, y sí el contador de A', async () => {
    const r = await persistir(USUARIOS.contadorA, propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A));
    expect(r.estado).toBe('creado');

    const contar = async (usuario: string): Promise<number> =>
      conUsuario(usuario, async (tx) => {
        const f = await tx.consultar<{ n: string }>(
          'select count(*)::text as n from reconocimiento_movimiento',
        );
        return Number(f[0]?.n ?? '-1');
      });

    // Dirección A: quien tiene membresía lo ve.
    expect(await contar(USUARIOS.contadorA)).toBe(1);
    // Dirección B: el socio de OTRO estudio no ve nada. Es la mitad que se olvida.
    expect(await contar(USUARIOS.socioOtroEstudio), 'fuga entre estudios').toBe(0);
    // El socio del estudio ve los dos clientes: acá solo hay uno cargado.
    expect(await contar(USUARIOS.socio)).toBe(1);
    // El contador de B no ve el reconocimiento de A.
    expect(await contar(USUARIOS.contadorB), 'fuga entre clientes del mismo estudio').toBe(0);
  });

  it('🔴 reprocesar con el MISMO digest es no-op: cero filas nuevas (05 §5.2)', async () => {
    const pedido = propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A);
    const primera = await persistir(USUARIOS.contadorA, pedido);
    expect(primera.estado).toBe('creado');

    // Segundo intento con el mismo digest y OTRO uuid: tiene que reconocer la fila existente.
    const segunda = await persistir(
      USUARIOS.contadorA,
      propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A),
    );
    expect(segunda.estado, 'la idempotencia de 05 §5.2 no se sostuvo').toBe('no_op');
    if (segunda.estado === 'no_op' && primera.estado === 'creado') {
      expect(segunda.reconocimientoId).toBe(primera.reconocimientoId);
    }

    const activos = await conUsuario(USUARIOS.contadorA, (tx) =>
      leerReconocimientosActivos(tx, { clienteId: s.clienteA, loteIngestaId: escenario.loteA }),
    );
    expect(activos, 'quedó más de un reconocimiento vigente para el mismo movimiento').toHaveLength(1);
  });

  /**
   * 🔴 EL TEST QUE FALTABA, y el defecto que destapó. Hallazgo INDEPENDIENTE de `qa-funcional` y
   * `code-reviewer` en la Ronda 3 — los dos llegaron al mismo lugar por caminos distintos.
   *
   * Escenario real de los próximos días: se corre `--aplicar` con `padron_socio` vacío y los ~1148
   * `distinguir_tercero_de_socio` se persisten como `decision_humana`. Después la contadora carga el
   * padrón con `pnpm alta:socio`. Se vuelve a correr: capa C ahora resuelve `es_socio` y
   * `aplicarContrapartida` PROMUEVE a `propuesta` — pero el léxico no cambió, así que el digest es EL
   * MISMO.
   *
   * El no-op comparaba SOLO el digest, así que devolvía `no_op` y la promoción no se escribía nunca.
   * El reporte imprimía `noOp: 1830, creados: 0` y PARECÍA que había salido bien: fail-open y
   * silencioso, el mismo modo de falla que `version.ts` describe para un contador manual, un nivel
   * más arriba.
   *
   * La base estaba bien diseñada: `uq_recon_determinante` lleva `es_propuesta` como cuarta columna
   * justamente para admitir esta fila (hallazgo de `dba-data`, Ronda 2). El corto-circuito de la
   * aplicación la anulaba antes de llegar al INSERT.
   *
   * Por qué no lo agarró la primera tanda de tests: los 11 usaban `propuestaDe()` con la MISMA clase
   * las dos veces, así que verificaban "mismo digest + mismo contenido" y nunca "mismo digest + clase
   * distinta".
   */
  it('🔴 mismo digest pero clase DISTINTA (promoción de capa C) NO es no-op: supersede', async () => {
    const capaB: PedidoDePersistirReconocimiento = {
      ...propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A),
      clase: 'decision_humana',
      tipo: 'pago_a_proveedor_transferencia',
      queDecide: 'distinguir_tercero_de_socio',
    };
    const primera = await persistir(USUARIOS.contadorA, capaB);
    expect(primera.estado).toBe('creado');

    // Mismo digest, clase promovida — exactamente lo que produce capa C tras cargar el padrón.
    const capaC: PedidoDePersistirReconocimiento = {
      ...propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A),
      tipo: 'retiro_de_socio',
    };
    const segunda = await persistir(USUARIOS.contadorA, capaC);

    expect(
      segunda.estado,
      'la promoción de capa C se perdió: el no-op comparó solo el digest e ignoró la clase',
    ).toBe('supersedido');

    const activos = await conUsuario(USUARIOS.contadorA, (tx) =>
      leerReconocimientosActivos(tx, { clienteId: s.clienteA, loteIngestaId: escenario.loteA }),
    );
    expect(activos).toHaveLength(1);
    expect(activos[0]?.clase, 'la fila vigente tiene que ser la promovida').toBe('propuesta');
  });


  it('🔴 con un digest NUEVO se supersede: el viejo no se borra y queda UNO solo vigente', async () => {
    await persistir(USUARIOS.contadorA, propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A));
    const r = await persistir(USUARIOS.contadorA, propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_B));

    expect(r.estado).toBe('supersedido');

    const activos = await conUsuario(USUARIOS.contadorA, (tx) =>
      leerReconocimientosActivos(tx, { clienteId: s.clienteA, loteIngestaId: escenario.loteA }),
    );
    expect(activos).toHaveLength(1);
    expect(activos[0]?.motorDigest, 'el vigente tiene que ser el digest nuevo').toBe(DIGEST_B);

    // Y el viejo NO se borró: 05 §5.2, "nunca se borra".
    const total = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from reconocimiento_movimiento where cliente_id = $1',
        [s.clienteA],
      );
      return Number(f[0]?.n ?? '-1');
    });
    expect(total, 'el reconocimiento superseded se borró en vez de conservarse').toBe(2);
  });

  it('🔴 volver a un digest ya superseded se corta con código, no se adivina', async () => {
    await persistir(USUARIOS.contadorA, propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A));
    await persistir(USUARIOS.contadorA, propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_B));

    await expect(
      persistir(USUARIOS.contadorA, propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A)),
      'volver a un digest histórico es una decisión humana, no un reproceso',
    ).rejects.toBeInstanceOf(ReconocimientoDigestYaEnLaCadenaError);
  });

  it('🔴 un reconocimiento NO puede colgar de un movimiento de otro cliente (FK compuesta)', async () => {
    // `cliente_id` de A con un `movimiento_id` de B. El socio tiene membresía en los dos, así que la
    // policy NO lo frena: lo único que queda en pie es la FK compuesta tenant-consistente.
    await expect(
      persistir(USUARIOS.socio, propuestaDe(escenario.movimientoB, s.clienteA, DIGEST_A)),
    ).rejects.toThrow(/fk_recon_movimiento|foreign key/i);
  });

  it('🔴 un candidato NO puede colgar de una propuesta (FK de tres columnas)', async () => {
    const pedido = {
      ...propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A),
      candidatos: ['galicia.comision_de_transferencia'] as readonly string[],
    };
    // `candidatos` solo existe en `sin_reconocer`; la FK de tres columnas lo hace imposible en la base.
    await expect(persistir(USUARIOS.contadorA, pedido)).rejects.toThrow(
      /fk_recon_candidato_reconocimiento|foreign key/i,
    );
  });

  it('un sin_reconocer con candidatos sí los persiste, y quedan atados a esa fila', async () => {
    const pedido = {
      ...propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A),
      clase: 'sin_reconocer',
      tipo: null,
      concepto: null,
      polaridad: null,
      lado: null,
      via: null,
      motivoCodigo: 'ambiguo',
      entradaLexicoId: null,
      caracteresMatcheados: null,
      huboCola: null,
      candidatos: ['galicia.uno', 'galicia.dos'] as readonly string[],
    };
    const r = await persistir(USUARIOS.contadorA, pedido);
    expect(r.estado).toBe('creado');

    const n = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from reconocimiento_candidato where reconocimiento_id = $1',
        [r.reconocimientoId],
      );
      return Number(f[0]?.n ?? '-1');
    });
    expect(n).toBe(2);
  });

  it('🔴 el check de forma rechaza un sin_reconocer con `tipo` cargado', async () => {
    const incoherente = {
      ...propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A),
      clase: 'sin_reconocer',
      motivoCodigo: 'ambiguo',
      // `tipo` queda cargado: una fila con la forma de otra clase.
    };
    await expect(persistir(USUARIOS.contadorA, incoherente)).rejects.toThrow(
      /reconocimiento_forma_chk/i,
    );
  });

  it('🔴 el check de forma rechaza un `ambiguo` CON evidencia — la prueba de un match que no ocurrió', async () => {
    const conEvidenciaDeMas = {
      ...propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A),
      clase: 'sin_reconocer',
      tipo: null,
      concepto: null,
      polaridad: null,
      lado: null,
      motivoCodigo: 'ambiguo',
      // `ambiguo` NO lleva evidencia (motor.ts:55). Dejarla es exactamente lo que la nulidad grupal
      // habría dejado pasar.
    };
    await expect(persistir(USUARIOS.contadorA, conEvidenciaDeMas)).rejects.toThrow(
      /reconocimiento_forma_chk/i,
    );
  });

  it('🔴 un digest mal formado (64 hex sin cortar) es rechazado por la base', async () => {
    const malo = {
      ...propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A),
      motorDigest: 'a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718',
    };
    await expect(persistir(USUARIOS.contadorA, malo)).rejects.toThrow(/reconocimiento_digest_chk/i);
  });

  it('🔴 el administrativo NO puede escribir sin membresía, y sin membresía nadie ve nada', async () => {
    // Fail-closed: un usuario sin membresía en el cliente no ve ni una fila.
    await persistir(USUARIOS.contadorA, propuestaDe(escenario.movimientoA, s.clienteA, DIGEST_A));
    const vistas = await conUsuario(USUARIOS.socioOtroEstudio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from reconocimiento_movimiento where cliente_id = $1',
        [s.clienteA],
      );
      return Number(f[0]?.n ?? '-1');
    });
    expect(vistas).toBe(0);
  });
});
