/**
 * `persistirReconocimiento` — el escritor real de `reconocimiento_contrapartida` +
 * `reconocimiento_contrapartida_patron_match` (migración `0038`, Mitad 1).
 *
 * No repite la cobertura de mecanismo de DDL (eso ya lo cierra `mutaciones-0038.test.ts` con prueba de
 * mutación en vivo); esto verifica el WIRING del escritor de TypeScript: qué escribe, cuándo, y sobre
 * todo CUÁNDO NO — el gate de la sección 4.
 *
 * Requisito previo: `0038` APLICADA.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { escribirConAuditoria } from '../src/db/auditoria.ts';
import { persistirReconocimiento, type PedidoDePersistirReconocimiento } from '../src/contabilidad/escrituras.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

const BANCO = 'banco_0038_wiring';

let s: Sembrado;
let cuentaId = '';
let loteId = '';

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ($1, 'BANCO 0038 WIRING', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const cuenta = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
       values ($1, $2, 'ARS', '0038 WIRING') returning id::text as id`,
      [s.clienteA, BANCO],
    );
    cuentaId = cuenta[0]?.id ?? '';
    const lote = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
       values ($1, $2, 'prueba-0038-wiring', 'archivo', 'hash_0038_wiring', 'recibido', 0)
       returning id::text as id`,
      [s.clienteA, BANCO],
    );
    loteId = lote[0]?.id ?? '';
    await tx.consultar(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
      [s.clienteA, loteId, cuentaId],
    );
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

let filaSeq = 0;
async function crearMovimiento(tx: Tx): Promise<{ readonly id: string; readonly entradaDigest: string }> {
  filaSeq += 1;
  const f = await tx.consultar<{ id: string; entrada_digest: string }>(
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, saldo, concepto_banco, concepto_completo, concepto_banco_estrategia, contraparte_captura)
     values ($1, $2, $3, $4, $5, '2026-06-15'::date, 'GLOSA WIRING', -100.00, 900.00, 'CONCEPTO', true,
             'columna_propia', 'capturado')
     returning id::text as id, entrada_digest`,
    [s.clienteA, loteId, cuentaId, filaSeq, randomUUID()],
  );
  const fila = f[0];
  if (!fila) throw new Error('no se creó el movimiento');
  return { id: fila.id, entradaDigest: fila.entrada_digest };
}

let patronSeq = 0;
async function altaPatron(tx: Tx): Promise<string> {
  patronSeq += 1;
  const f = await tx.consultar<{ id: string }>(
    `insert into padron_contraparte (cliente_id, patron, clasificacion, vigente_desde)
     values ($1, $2, 'proveedor', '2026-01-01'::date) returning id::text as id`,
    [s.clienteA, `PROVEEDOR WIRING ${patronSeq}`],
  );
  const id = f[0]?.id;
  if (!id) throw new Error('no se creó el patrón');
  return id;
}

let digestSeq = 0;
function motorDigestSintetico(): string {
  digestSeq += 1;
  return digestSeq.toString(16).padStart(16, '0');
}

/** El pedido base: `decision_humana` + `distinguir_tercero_de_socio`, único `queDecide` bajo el que
 *  `contrapartida` tiene sentido. */
function pedidoBase(mov: { id: string; entradaDigest: string }, digest: string): PedidoDePersistirReconocimiento {
  return {
    clienteId: s.clienteA,
    movimientoId: mov.id,
    reconocimientoId: randomUUID(),
    motorDigest: digest,
    entradaDigest: mov.entradaDigest,
    clase: 'decision_humana',
    tipo: 'pago_a_proveedor_transferencia',
    concepto: 'pago_con_transferencia_generico',
    polaridad: 'normal',
    lado: 'debe',
    via: 'texto_literal_exacto',
    queDecide: 'distinguir_tercero_de_socio',
    motivoCodigo: null,
    entradaLexicoId: 'galicia.pago_con_transferencia_generico',
    caracteresMatcheados: 12,
    huboCola: false,
    candidatos: [],
    contrapartida: null,
  };
}

function persistir(pedido: PedidoDePersistirReconocimiento) {
  return conUsuario(USUARIOS.socio, (tx) =>
    escribirConAuditoria(
      tx,
      {
        clienteId: pedido.clienteId,
        accion: 'escritura',
        recurso: 'reconocimiento_movimiento',
        motivo: 'prueba de wiring del escritor de contrapartida (0038)',
      },
      (ctx) => persistirReconocimiento(tx, ctx, pedido),
    ),
  );
}

async function contarContrapartida(reconocimientoId: string): Promise<{ readonly padre: number; readonly hijas: number }> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const padre = await tx.consultar<{ n: string }>(
      `select count(*)::text as n from reconocimiento_contrapartida where reconocimiento_id = $1`,
      [reconocimientoId],
    );
    const hijas = await tx.consultar<{ n: string }>(
      `select count(*)::text as n
         from reconocimiento_contrapartida_patron_match m
         join reconocimiento_contrapartida c on c.id = m.contrapartida_id
        where c.reconocimiento_id = $1`,
      [reconocimientoId],
    );
    return { padre: Number(padre[0]?.n ?? '-1'), hijas: Number(hijas[0]?.n ?? '-1') };
  });
}

describe('0038 — persistirReconocimiento: `contrapartida: null` no escribe nada', () => {
  it('un pedido sin evidencia de padrón de nombres no toca ninguna de las dos tablas nuevas', async () => {
    const mov = await conUsuario(USUARIOS.socio, (tx) => crearMovimiento(tx));
    const pedido = pedidoBase(mov, motorDigestSintetico());
    const r = await persistir(pedido);
    expect(r.estado).toBe('creado');
    const { padre, hijas } = await contarContrapartida(pedido.reconocimientoId);
    expect({ padre, hijas }).toEqual({ padre: 0, hijas: 0 });
  });
});

describe('0038 — persistirReconocimiento: `contrapartida` no-null escribe el padre y 0..N hijas', () => {
  it('`patronContraparteIds: []` (sin_match) escribe el padre y CERO filas satélite', async () => {
    const mov = await conUsuario(USUARIOS.socio, (tx) => crearMovimiento(tx));
    const pedido: PedidoDePersistirReconocimiento = {
      ...pedidoBase(mov, motorDigestSintetico()),
      contrapartida: {
        resolucionEstado: 'sin_candidatos',
        resueltoAFecha: '2026-06-15',
        padronManifestacionId: null,
        padronCompletoHasta: null,
        patronContraparteEstado: 'sin_match',
        patronContraparteIds: [],
      },
    };
    const r = await persistir(pedido);
    expect(r.estado).toBe('creado');
    const { padre, hijas } = await contarContrapartida(pedido.reconocimientoId);
    expect({ padre, hijas }).toEqual({ padre: 1, hijas: 0 });
  });

  it('`patronContraparteIds` con 1 id (match) escribe 1 fila satélite `patron_unico`', async () => {
    const mov = await conUsuario(USUARIOS.socio, (tx) => crearMovimiento(tx));
    const patronId = await conUsuario(USUARIOS.socio, (tx) => altaPatron(tx));
    const pedido: PedidoDePersistirReconocimiento = {
      ...pedidoBase(mov, motorDigestSintetico()),
      contrapartida: {
        resolucionEstado: 'sin_candidatos',
        resueltoAFecha: '2026-06-15',
        padronManifestacionId: null,
        padronCompletoHasta: null,
        patronContraparteEstado: 'match',
        patronContraparteIds: [patronId],
      },
    };
    const r = await persistir(pedido);
    expect(r.estado).toBe('creado');
    const { padre, hijas } = await contarContrapartida(pedido.reconocimientoId);
    expect({ padre, hijas }).toEqual({ padre: 1, hijas: 1 });

    const regimen = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ regimen_matches: string; padron_contraparte_id: string }>(
        `select m.regimen_matches, m.padron_contraparte_id::text as padron_contraparte_id
           from reconocimiento_contrapartida_patron_match m
           join reconocimiento_contrapartida c on c.id = m.contrapartida_id
          where c.reconocimiento_id = $1`,
        [pedido.reconocimientoId],
      ),
    );
    expect(regimen).toEqual([{ regimen_matches: 'patron_unico', padron_contraparte_id: patronId }]);
  });

  it('`patronContraparteIds` con 2 ids (multiples_patrones) escribe 2 filas satélite `varios`', async () => {
    const mov = await conUsuario(USUARIOS.socio, (tx) => crearMovimiento(tx));
    const [p1, p2] = await conUsuario(USUARIOS.socio, async (tx) => [await altaPatron(tx), await altaPatron(tx)]);
    const pedido: PedidoDePersistirReconocimiento = {
      ...pedidoBase(mov, motorDigestSintetico()),
      contrapartida: {
        resolucionEstado: 'sin_candidatos',
        resueltoAFecha: '2026-06-15',
        padronManifestacionId: null,
        padronCompletoHasta: null,
        patronContraparteEstado: 'multiples_patrones',
        patronContraparteIds: [p1 as string, p2 as string],
      },
    };
    const r = await persistir(pedido);
    expect(r.estado).toBe('creado');
    const { padre, hijas } = await contarContrapartida(pedido.reconocimientoId);
    expect({ padre, hijas }).toEqual({ padre: 1, hijas: 2 });

    const regimenes = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ regimen_matches: string }>(
        `select distinct m.regimen_matches
           from reconocimiento_contrapartida_patron_match m
           join reconocimiento_contrapartida c on c.id = m.contrapartida_id
          where c.reconocimiento_id = $1`,
        [pedido.reconocimientoId],
      ),
    );
    expect(regimenes).toEqual([{ regimen_matches: 'varios' }]);
  });

  it('`es_socio` promovido a `propuesta` con `patronContraparteEstado: no_aplica` escribe el padre y CERO hijas', async () => {
    // El caso que la corrección del comentario de `reconocimiento.ts` (punto 1) hace posible: el
    // pedido de persistencia sale de `resolucion.estado` directo, no de `Reconocimiento.evidenciaContraparte`
    // (que queda `undefined` en esta rama).
    const mov = await conUsuario(USUARIOS.socio, (tx) => crearMovimiento(tx));
    const pedido: PedidoDePersistirReconocimiento = {
      ...pedidoBase(mov, motorDigestSintetico()),
      clase: 'propuesta',
      queDecide: null,
      contrapartida: {
        resolucionEstado: 'es_socio',
        resueltoAFecha: '2026-06-15',
        padronManifestacionId: null,
        padronCompletoHasta: null,
        patronContraparteEstado: 'no_aplica',
        patronContraparteIds: [],
      },
    };
    const r = await persistir(pedido);
    expect(r.estado).toBe('creado');
    const { padre, hijas } = await contarContrapartida(pedido.reconocimientoId);
    expect({ padre, hijas }).toEqual({ padre: 1, hijas: 0 });
  });
});

describe('0038 — el gate: solo se escribe si el PADRE se creó/supersedió EN ESTA LLAMADA', () => {
  it('un `no_op` (mismo digest, misma clase, misma entrada) con `contrapartida` no-null NO agrega una segunda fila', async () => {
    const mov = await conUsuario(USUARIOS.socio, (tx) => crearMovimiento(tx));
    const digest = motorDigestSintetico();
    const patronId = await conUsuario(USUARIOS.socio, (tx) => altaPatron(tx));
    const contrapartida = {
      resolucionEstado: 'sin_candidatos',
      resueltoAFecha: '2026-06-15',
      padronManifestacionId: null,
      padronCompletoHasta: null,
      patronContraparteEstado: 'match' as const,
      patronContraparteIds: [patronId],
    };

    const primera = pedidoBase(mov, digest);
    const primeraConContrapartida: PedidoDePersistirReconocimiento = { ...primera, contrapartida };
    const r1 = await persistir(primeraConContrapartida);
    expect(r1.estado).toBe('creado');

    // 🔴 Mismo `reconocimientoId` NUEVO (uuid propio, como en el llamador real) pero mismo digest,
    // clase y entrada: `persistirReconocimiento` lo detecta como no-op y NO INSERTA la fila padre
    // nueva. Si el gate de contrapartida no mirara el `estado`, este segundo intento chocaría contra
    // `fk_recon_contrapartida_reconocimiento` (el `reconocimiento_id` nuevo no existe) o, peor,
        // silenciosamente no pasaría por acá.
    const segunda = pedidoBase(mov, digest);
    const segundaConContrapartida: PedidoDePersistirReconocimiento = { ...segunda, contrapartida };
    const r2 = await persistir(segundaConContrapartida);
    expect(r2.estado).toBe('no_op');

    const { padre, hijas } = await contarContrapartida(primeraConContrapartida.reconocimientoId);
    expect({ padre, hijas }, 'un no_op no puede agregar una segunda fila de contrapartida al mismo reconocimiento').toEqual({
      padre: 1,
      hijas: 1,
    });
  });

  it('una promoción de capa C (mismo digest, clase DISTINTA) supersede y escribe la contrapartida de la fila NUEVA, no la vieja', async () => {
    const mov = await conUsuario(USUARIOS.socio, (tx) => crearMovimiento(tx));
    const digest = motorDigestSintetico();

    const vieja = pedidoBase(mov, digest);
    const viejaConContrapartida: PedidoDePersistirReconocimiento = {
      ...vieja,
      contrapartida: {
        resolucionEstado: 'sin_match_padron_incompleto',
        resueltoAFecha: '2026-06-15',
        padronManifestacionId: null,
        padronCompletoHasta: null,
        patronContraparteEstado: 'sin_match',
        patronContraparteIds: [],
      },
    };
    const r1 = await persistir(viejaConContrapartida);
    expect(r1.estado).toBe('creado');

    const nueva = pedidoBase(mov, digest);
    const nuevaConContrapartida: PedidoDePersistirReconocimiento = {
      ...nueva,
      clase: 'propuesta',
      queDecide: null,
      contrapartida: {
        resolucionEstado: 'es_socio',
        resueltoAFecha: '2026-06-15',
        padronManifestacionId: null,
        padronCompletoHasta: null,
        patronContraparteEstado: 'no_aplica',
        patronContraparteIds: [],
      },
    };
    const r2 = await persistir(nuevaConContrapartida);
    expect(r2.estado).toBe('supersedido');

    const { padre: padreVieja } = await contarContrapartida(viejaConContrapartida.reconocimientoId);
    const { padre: padreNueva, hijas: hijasNueva } = await contarContrapartida(nuevaConContrapartida.reconocimientoId);
    expect({ padreVieja, padreNueva, hijasNueva }).toEqual({ padreVieja: 1, padreNueva: 1, hijasNueva: 0 });
  });
});
