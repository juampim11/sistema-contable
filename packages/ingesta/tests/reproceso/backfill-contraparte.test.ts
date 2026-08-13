/**
 * `leerInsumosDeBackfill` + `backfillearContraparteDeLote`, contra base real. Migración 0013.
 *
 * Simula el escenario real que motiva esta herramienta: un lote persistido ANTES de 0013, con
 * `contraparte_captura='no_capturado'` en todas sus filas y el identificador de la contraparte ya
 * guardado en `movimiento_origen_crudo` (N2-R) desde que se ingirió — exactamente lo que dejó
 * `alter table ... add column contraparte_captura ... default 'no_capturado'` sobre el histórico.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import {
  backfillearContraparteDeLote,
  leerInsumosDeBackfill,
  ROLES_QUE_BACKFILLEAN,
} from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../data/tests/ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('backfill_prueba', 'BANCO BACKFILL') on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Crea un lote "pre-0013": `n` movimientos, cada uno con un identificador distinto en
 *  `movimiento_origen_crudo`, y `contraparte_captura='no_capturado'` — el estado exacto que dejó el
 *  backfill de la 0013 sobre el histórico. Devuelve `loteId` + los ids de movimiento en orden. */
async function crearLotePre0013(
  clienteId: string,
  cantidad: number,
  identificadorPorFila: (i: number) => { readonly cuit?: readonly string[]; readonly documento?: readonly string[] },
): Promise<{ loteId: string; movimientoIds: string[] }> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const cuenta = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, 'backfill_prueba', 'ARS')
       returning id::text as id`,
      [clienteId],
    );
    const cuentaId = cuenta[0]?.id ?? '';

    const lote = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas, filas_aceptadas)
       values ($1, 'backfill_prueba', 'prueba@1', 'archivo', $2, 'procesado', $3, $3)
       returning id::text as id`,
      [clienteId, randomUUID(), cantidad],
    );
    const loteId = lote[0]?.id ?? '';

    await tx.consultar(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
      [clienteId, loteId, cuentaId],
    );

    const movimientoIds: string[] = [];
    for (let i = 0; i < cantidad; i += 1) {
      const mov = await tx.consultar<{ id: string }>(
        `insert into movimiento_bancario_crudo
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
            fecha, descripcion, importe, concepto_banco_estrategia, contraparte_captura)
         values ($1, $2, $3, $4, $5, '2026-06-15', 'CONCEPTO PRE-0013', -100.00, 'no_publicado',
                 'no_capturado')
         returning id::text as id`,
        [clienteId, loteId, cuentaId, i + 1, `hash_backfill_${clienteId}_${i}`],
      );
      const movId = mov[0]?.id;
      if (!movId) throw new Error('no se creó el movimiento');
      movimientoIds.push(movId);

      const ident = identificadorPorFila(i);
      await tx.consultar(
        `insert into movimiento_origen_crudo (cliente_id, movimiento_id, fila_origen) values ($1, $2, $3::jsonb)`,
        [
          clienteId,
          movId,
          JSON.stringify({
            lineas: ['CONCEPTO PRE-0013'],
            glosaOriginal: 'CONCEPTO PRE-0013',
            identificadores: { cuit: ident.cuit ?? [], cbu: [], documento: ident.documento ?? [] },
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

describe('backfill de contraparte — camino feliz', () => {
  it('dry-run reporta los conteos sin escribir; --aplicar backfillea captura + candidatos', async () => {
    const { loteId, movimientoIds } = await crearLotePre0013(s.clienteA, 3, (i) => {
      if (i === 0) return { cuit: ['30-71234567-8'] };
      if (i === 1) return { documento: ['1234567'] }; // dni válido
      return {}; // sin identificador
    });

    const insumos = await leerInsumosDeBackfill(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    expect(insumos.ok).toBe(true);
    if (!insumos.ok) return;
    expect(insumos.insumos.filasOrigen).toHaveLength(3);

    // La auditoría de LECTURA ya comiteó, aunque todavía no se aplicó nada.
    expect(await contarAuditoria(loteId, 'movimiento_origen_crudo', 'lectura')).toBe(1);

    const dry = await conUsuario(USUARIOS.socio, (tx) =>
      backfillearContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: false }, insumos.insumos),
    );
    expect(dry.estado).toBe('listo');
    if (dry.estado === 'listo') {
      expect(dry.conteo).toEqual({
        filasDelLote: 3,
        leidasDeN2R: 3,
        candidatosTotales: 2,
        sinIdentificador: 1,
        capturadoCuentaPropia: 0,
        descartadosPorForma: 0,
      });
    }

    // Dry-run no escribió nada.
    const siguenSinCapturar = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `select count(*)::text as n from movimiento_bancario_crudo
          where lote_ingesta_id = $1 and contraparte_captura = 'no_capturado'`,
        [loteId],
      );
      return Number(f[0]?.n ?? '0');
    });
    expect(siguenSinCapturar).toBe(3);

    const aplicado = await conUsuario(USUARIOS.socio, (tx) =>
      backfillearContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos.insumos),
    );
    expect(aplicado.estado).toBe('aplicado');
    if (aplicado.estado === 'aplicado') {
      expect(aplicado.filasActualizadas).toBe(3);
    }
    // La auditoría de ESCRITURA se sumó, la de lectura sigue siendo una sola.
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
    expect(capturas.map((c) => c.contraparte_captura)).toEqual(['capturado', 'capturado', 'sin_identificador']);

    const candidatos = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `select count(*)::text as n from movimiento_contraparte_identificador where cliente_id = $1
          and movimiento_id = any($2::uuid[])`,
        [s.clienteA, movimientoIds],
      );
      return Number(f[0]?.n ?? '0');
    });
    expect(candidatos).toBe(2);
  });

  it('segunda corrida: ya_backfilleado, cero escrituras nuevas', async () => {
    const { loteId } = await crearLotePre0013(s.clienteA, 1, () => ({ cuit: ['30-71234567-8'] }));
    const insumos1 = await leerInsumosDeBackfill(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    if (!insumos1.ok) throw new Error('insumos inválidos');
    await conUsuario(USUARIOS.socio, (tx) =>
      backfillearContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos1.insumos),
    );

    const insumos2 = await leerInsumosDeBackfill(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    if (!insumos2.ok) throw new Error('insumos inválidos');
    const segunda = await conUsuario(USUARIOS.socio, (tx) =>
      backfillearContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos2.insumos),
    );
    expect(segunda.estado).toBe('ya_backfilleado');
    expect(await contarAuditoria(loteId, 'movimiento_bancario_crudo', 'escritura')).toBe(1);
  });

  /**
   * `code-reviewer` (ronda de revisión de esta migración): el centinela original solo miraba
   * `contraparte_captura`, así que una vez `'capturado'` la herramienta nunca volvía a mirar el
   * lote — contradiciendo el propio comentario del archivo, que la declara "el mecanismo de
   * re-hasheo cuando el pepper GLOBAL rote". Este test ejercita justo eso: sin cambiar el secreto
   * (`IDENTIFICADOR_PEPPER`, que en este entorno de test no se puede regenerar), rotar SOLO la
   * VERSIÓN (`IDENTIFICADOR_PEPPER_ID`) ya alcanza para que la derivación produzca un digest
   * distinto — es lo que `pepperDerivadoPorCliente` documenta: el `pepper_id` viaja en el `info`
   * del HKDF, así que un id nuevo cambia la clave derivada aunque el secreto de base sea el mismo.
   */
  it('rotación de pepper: una fila ya `capturado` vuelve a quedar pendiente, y `sin_identificador` NO', async () => {
    const pepperIdOriginal = process.env['IDENTIFICADOR_PEPPER_ID'];
    try {
      const { loteId } = await crearLotePre0013(s.clienteA, 2, (i) =>
        i === 0 ? { cuit: ['30-71234567-8'] } : {},
      );

      const insumos1 = await leerInsumosDeBackfill(USUARIOS.socio, { clienteId: s.clienteA, loteId });
      if (!insumos1.ok) throw new Error('insumos inválidos');
      const primera = await conUsuario(USUARIOS.socio, (tx) =>
        backfillearContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos1.insumos),
      );
      expect(primera.estado).toBe('aplicado');

      // Rotación: solo la VERSIÓN cambia. `pepperIdActual()` lee esta env var en cada llamada.
      process.env['IDENTIFICADOR_PEPPER_ID'] = 'v2';

      const insumos2 = await leerInsumosDeBackfill(USUARIOS.socio, { clienteId: s.clienteA, loteId });
      if (!insumos2.ok) throw new Error('insumos inválidos');
      const dryRotado = await conUsuario(USUARIOS.socio, (tx) =>
        backfillearContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: false }, insumos2.insumos),
      );
      // NO "ya_backfilleado": la fila con candidato quedó pendiente de nuevo para v2.
      expect(dryRotado.estado).toBe('listo');
      if (dryRotado.estado === 'listo') {
        // Solo 1 fila pendiente (la de 'capturado'), no las 2: 'sin_identificador' no se reprocesa.
        expect(dryRotado.conteo.candidatosTotales).toBe(1);
      }

      const aplicadoRotado = await conUsuario(USUARIOS.socio, (tx) =>
        backfillearContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos2.insumos),
      );
      expect(aplicadoRotado.estado).toBe('aplicado');
      if (aplicadoRotado.estado === 'aplicado') {
        // Solo la fila rotada se reescribe — la de 'sin_identificador' no vuelve a tocarse.
        expect(aplicadoRotado.filasActualizadas).toBe(1);
      }

      // Los dos candidatos conviven: v1 (de la primera corrida) y v2 (de la rotación). Nunca se borra.
      const pepperIds = await conUsuario(USUARIOS.socio, async (tx) => {
        const f = await tx.consultar<{ pepper_id: string }>(
          `select pepper_id from movimiento_contraparte_identificador
            where cliente_id = $1 and movimiento_id in (
              select id from movimiento_bancario_crudo where lote_ingesta_id = $2
            ) order by pepper_id`,
          [s.clienteA, loteId],
        );
        return f.map((r) => r.pepper_id);
      });
      expect(pepperIds).toEqual(['v1', 'v2']);
    } finally {
      // Restaurar: el pre-flight de pepper y otros tests asumen la versión real del entorno.
      if (pepperIdOriginal === undefined) delete process.env['IDENTIFICADOR_PEPPER_ID'];
      else process.env['IDENTIFICADOR_PEPPER_ID'] = pepperIdOriginal;
    }
  });
});

describe('backfill de contraparte — aislamiento y validación', () => {
  it('lote de otro cliente: lote_no_encontrado', async () => {
    const { loteId } = await crearLotePre0013(s.clienteA, 1, () => ({}));
    const insumos = await leerInsumosDeBackfill(USUARIOS.socio, { clienteId: s.clienteB, loteId });
    expect(insumos.ok).toBe(false);
    if (!insumos.ok) expect(insumos.motivoCodigo).toBe('lote_no_encontrado');
  });

  it('rol insuficiente: contador no puede correr el backfill (ROLES_QUE_BACKFILLEAN = socio)', async () => {
    expect(ROLES_QUE_BACKFILLEAN).toEqual(['socio']);
    const { loteId } = await crearLotePre0013(s.clienteA, 1, () => ({}));
    const insumos = await leerInsumosDeBackfill(USUARIOS.contadorA, { clienteId: s.clienteA, loteId });
    expect(insumos.ok).toBe(false);
    if (!insumos.ok) expect(insumos.motivoCodigo).toBe('rol_insuficiente');
  });

  it('lote con_errores: lote_no_backfilleable', async () => {
    const { loteId } = await crearLotePre0013(s.clienteA, 1, () => ({}));
    await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar(`update lote_ingesta set estado = 'con_errores' where id = $1`, [loteId]),
    );
    const insumos = await leerInsumosDeBackfill(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    expect(insumos.ok).toBe(false);
    if (!insumos.ok) expect(insumos.motivoCodigo).toBe('lote_no_backfilleable');
  });
});
