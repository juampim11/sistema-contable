/**
 * `leerInsumosDeReclasificacion` + `reclasificarContraparteDeLote`, contra base real. Mismo nivel de
 * integración que `backfill-contraparte.test.ts` — el cálculo puro ya está cubierto en
 * `reclasificar-contraparte.test.ts` (sin base). Acá se ejercita la parte que SÍ toca Postgres: las
 * dos transacciones, la auditoría, el lock, y que el UPDATE + los INSERT realmente escriban lo que
 * el cálculo puro predijo.
 *
 * Simula el escenario real que motiva esta herramienta (HANDOFF 158-159): un lote persistido con
 * `contraparte_captura = 'sin_identificador'` porque `RE_CUIT` no detectaba un CUIT pegado a una
 * palabra sin separador (bug de `\b`, corregido en `cb084a0`) — pero `movimiento_origen_crudo` YA
 * tiene la `glosaOriginal` cruda guardada, así que el código ACTUAL sí la recaptura.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import {
  leerInsumosDeReclasificacion,
  reclasificarContraparteDeLote,
  ROLES_QUE_RECLASIFICAN,
} from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../data/tests/ayuda.ts';

let s: Sembrado;

const CUIT_SINTETICO = '20111111112';

beforeAll(async () => {
  s = await sembrar();
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('reclasificar_prueba', 'BANCO RECLASIFICAR') on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Crea un lote con `n` movimientos, cada uno con su `glosaOriginal` cruda en `movimiento_origen_crudo`
 *  y el `contraparte_captura` que dejó el bug (`capturaDelBug`, por índice). Devuelve `loteId` +
 *  los ids de movimiento en orden. */
async function crearLoteConBug(
  clienteId: string,
  glosaYCapturaPorFila: (i: number) => { readonly glosaOriginal: string; readonly capturaDelBug: string },
  cantidad: number,
): Promise<{ loteId: string; movimientoIds: string[] }> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const cuenta = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, 'reclasificar_prueba', 'ARS')
       returning id::text as id`,
      [clienteId],
    );
    const cuentaId = cuenta[0]?.id ?? '';

    const lote = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas, filas_aceptadas)
       values ($1, 'reclasificar_prueba', 'prueba@1', 'archivo', $2, 'procesado', $3, $3)
       returning id::text as id`,
      [clienteId, randomUUID(), cantidad],
    );
    const loteId = lote[0]?.id ?? '';

    await tx.consultar(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, '2026-08-01', '2026-08-31', 'no_verificable')`,
      [clienteId, loteId, cuentaId],
    );

    const movimientoIds: string[] = [];
    for (let i = 0; i < cantidad; i += 1) {
      const { glosaOriginal, capturaDelBug } = glosaYCapturaPorFila(i);
      const mov = await tx.consultar<{ id: string }>(
        `insert into movimiento_bancario_crudo
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
            fecha, descripcion, importe, concepto_banco_estrategia, contraparte_captura)
         values ($1, $2, $3, $4, $5, '2026-08-15', $6, -100.00, 'no_publicado', $7)
         returning id::text as id`,
        [clienteId, loteId, cuentaId, i + 1, `hash_reclasificar_${clienteId}_${i}`, glosaOriginal, capturaDelBug],
      );
      const movId = mov[0]?.id;
      if (!movId) throw new Error('no se creó el movimiento');
      movimientoIds.push(movId);

      // Lo que persistía `depurarGlosa()` CON el bug: sin identificador (el CUIT pegado no se
      // detectaba, y por eso `identificadores.cuit` quedó vacío en la fila cruda).
      await tx.consultar(
        `insert into movimiento_origen_crudo (cliente_id, movimiento_id, fila_origen) values ($1, $2, $3::jsonb)`,
        [
          clienteId,
          movId,
          JSON.stringify({
            lineas: [glosaOriginal],
            glosaOriginal,
            identificadores: { cuit: [], cbu: [], documento: [] },
            columnaOrigen: null,
            candidatosIdentificacion: [],
            referencias: [],
          }),
        ],
      );
    }

    return { loteId, movimientoIds };
  });
}

async function contarAuditoria(loteId: string, recurso: string, accion: string): Promise<number> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ n: string }>(
      `select count(*)::text as n from acceso_auditoria
        where recurso = $1 and recurso_id = $2 and accion = $3`,
      [recurso, loteId, accion],
    );
    return Number(f[0]?.n ?? '0');
  });
}

// -----------------------------------------------------------------------------

describe('reclasificar-contraparte — camino feliz', () => {
  it('dry-run reporta la transición sin_identificador->capturado; --aplicar corrige captura + agrega candidato', async () => {
    const { loteId, movimientoIds } = await crearLoteConBug(
      s.clienteA,
      (i) =>
        i === 0
          ? { glosaOriginal: `DOC${CUIT_SINTETICO}`, capturaDelBug: 'sin_identificador' }
          : { glosaOriginal: 'ACREDITACION CHEQUE REMESAS', capturaDelBug: 'sin_identificador' },
      2,
    );

    const insumos = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    expect(insumos.ok).toBe(true);
    if (!insumos.ok) return;
    expect(insumos.insumos.filasOrigen).toHaveLength(2);
    expect(await contarAuditoria(loteId, 'movimiento_origen_crudo', 'lectura')).toBe(1);

    const dry = await conUsuario(USUARIOS.socio, (tx) =>
      reclasificarContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: false }, insumos.insumos),
    );
    expect(dry.estado).toBe('listo');
    if (dry.estado === 'listo') {
      expect(dry.reporte.porTransicionDeCaptura).toEqual({
        'sin_identificador->capturado': 1,
        'sin_identificador->sin_identificador': 1,
      });
      expect(dry.reporte.sinCambio).toBe(1);
      expect(dry.reporte.candidatosNuevosPorClase).toEqual({ cuit: 1 });
    }

    // Dry-run no escribió nada.
    const capturaAntes = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ contraparte_captura: string }>(
        `select contraparte_captura from movimiento_bancario_crudo where id = $1`,
        [movimientoIds[0]],
      );
      return f[0]?.contraparte_captura;
    });
    expect(capturaAntes).toBe('sin_identificador');

    const aplicado = await conUsuario(USUARIOS.socio, (tx) =>
      reclasificarContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos.insumos),
    );
    expect(aplicado.estado).toBe('aplicado');
    if (aplicado.estado === 'aplicado') {
      expect(aplicado.filasActualizadas).toBe(1);
    }
    expect(await contarAuditoria(loteId, 'movimiento_bancario_crudo', 'escritura')).toBe(1);
    expect(await contarAuditoria(loteId, 'movimiento_origen_crudo', 'lectura')).toBe(1);

    const capturas = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ id: string; contraparte_captura: string }>(
        `select id::text as id, contraparte_captura from movimiento_bancario_crudo
          where lote_ingesta_id = $1 order by fila_numero`,
        [loteId],
      );
      return f;
    });
    expect(capturas.map((c) => c.contraparte_captura)).toEqual(['capturado', 'sin_identificador']);

    // `descripcion` NUNCA se toca — sigue siendo lo que se insertó al crear el lote de prueba.
    const descripciones = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ descripcion: string }>(
        `select descripcion from movimiento_bancario_crudo where id = $1`,
        [movimientoIds[0]],
      );
      return f[0]?.descripcion;
    });
    expect(descripciones).toBe(`DOC${CUIT_SINTETICO}`);

    const candidatos = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ clase: string }>(
        `select clase from movimiento_contraparte_identificador where cliente_id = $1 and movimiento_id = $2`,
        [s.clienteA, movimientoIds[0]],
      );
      return f;
    });
    expect(candidatos.map((c) => c.clase)).toEqual(['cuit']);
  });

  it('segunda corrida: ya_reclasificado, cero escrituras nuevas', async () => {
    const { loteId } = await crearLoteConBug(
      s.clienteA,
      () => ({ glosaOriginal: `DOC${CUIT_SINTETICO}`, capturaDelBug: 'sin_identificador' }),
      1,
    );

    const insumos1 = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    if (!insumos1.ok) throw new Error('insumos inválidos');
    await conUsuario(USUARIOS.socio, (tx) =>
      reclasificarContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos1.insumos),
    );

    const insumos2 = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    if (!insumos2.ok) throw new Error('insumos inválidos');
    const segunda = await conUsuario(USUARIOS.socio, (tx) =>
      reclasificarContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos2.insumos),
    );
    expect(segunda.estado).toBe('ya_reclasificado');
    expect(await contarAuditoria(loteId, 'movimiento_bancario_crudo', 'escritura')).toBe(1);
  });

  it('un lote ya al día (sin diferencia) da ya_reclasificado también en dry-run', async () => {
    const { loteId } = await crearLoteConBug(
      s.clienteA,
      () => ({ glosaOriginal: 'ACREDITACION CHEQUE REMESAS', capturaDelBug: 'sin_identificador' }),
      1,
    );
    const insumos = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    if (!insumos.ok) throw new Error('insumos inválidos');
    const dry = await conUsuario(USUARIOS.socio, (tx) =>
      reclasificarContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: false }, insumos.insumos),
    );
    expect(dry.estado).toBe('ya_reclasificado');
  });
});

describe('reclasificar-contraparte — aislamiento y validación', () => {
  it('lote de otro cliente: lote_no_encontrado', async () => {
    const { loteId } = await crearLoteConBug(s.clienteA, () => ({ glosaOriginal: 'X', capturaDelBug: 'sin_identificador' }), 1);
    const insumos = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteB, loteId });
    expect(insumos.ok).toBe(false);
    if (!insumos.ok) expect(insumos.motivoCodigo).toBe('lote_no_encontrado');
  });

  it('rol insuficiente: contador no puede reclasificar (ROLES_QUE_RECLASIFICAN = socio)', async () => {
    expect(ROLES_QUE_RECLASIFICAN).toEqual(['socio']);
    const { loteId } = await crearLoteConBug(s.clienteA, () => ({ glosaOriginal: 'X', capturaDelBug: 'sin_identificador' }), 1);
    const insumos = await leerInsumosDeReclasificacion(USUARIOS.contadorA, { clienteId: s.clienteA, loteId });
    expect(insumos.ok).toBe(false);
    if (!insumos.ok) expect(insumos.motivoCodigo).toBe('rol_insuficiente');
  });

  it('lote con_errores: lote_no_reclasificable', async () => {
    const { loteId } = await crearLoteConBug(s.clienteA, () => ({ glosaOriginal: 'X', capturaDelBug: 'sin_identificador' }), 1);
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar(`update lote_ingesta set estado = 'con_errores' where id = $1`, [loteId]),
    );
    const insumos = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    expect(insumos.ok).toBe(false);
    if (!insumos.ok) expect(insumos.motivoCodigo).toBe('lote_no_reclasificable');
  });

  // TESTER (caso 6 del pedido): el rol se chequea DOS VECES — Tx1 (`leerInsumosDeReclasificacion`) y
  // DE NUEVO al tope de Tx2 (`reclasificarContraparteDeLote`, línea "Rol, DE NUEVO"). Las tres pruebas
  // de arriba solo ejercitan el guard de Tx1. Este caso ejercita el de Tx2 en rojo si se lo sacara:
  // insumos leídos con `socio` (Tx1 pasa), pero Tx2 corre bajo la conexión de `contadorA` — el mismo
  // patrón que un operador que perdió el rol `socio` justo en la ventana entre las dos transacciones.
  it('rol insuficiente en Tx2 aunque Tx1 haya pasado: la membership se re-verifica, no se confía en la de Tx1', async () => {
    // Glosa que SÍ produce diff (`DOC${CUIT}` -> recaptura como `capturado`) — con una glosa sin
    // identificador (`'X'`) el cálculo puro daría `aEscribir=[]` y el resultado sería
    // `ya_reclasificado` incluso sin el guard de rol, dejando el mutante sin detectar.
    const { loteId } = await crearLoteConBug(
      s.clienteA,
      () => ({ glosaOriginal: `DOC${CUIT_SINTETICO}`, capturaDelBug: 'sin_identificador' }),
      1,
    );
    const insumos = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    if (!insumos.ok) throw new Error('insumos inválidos');

    const resultado = await conUsuario(USUARIOS.contadorA, (tx) =>
      reclasificarContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos.insumos),
    );
    expect(resultado.estado).toBe('abortado');
    if (resultado.estado === 'abortado') expect(resultado.motivoCodigo).toBe('rol_insuficiente');

    // Y no escribió nada.
    const captura = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ contraparte_captura: string }>(
        `select contraparte_captura from movimiento_bancario_crudo where lote_ingesta_id = $1`,
        [loteId],
      );
      return f[0]?.contraparte_captura;
    });
    expect(captura).toBe('sin_identificador');
  });
});
