/**
 * MUTACIÓN del `SAVEPOINT` de `escribirPendienteDeImputacion` — hallazgo real del fix de
 * idempotencia de Capa D (2026-09-09), encontrado corriendo el fix contra el piloto real (nunca en
 * LOCAL con un solo movimiento, ni en la convocatoria de dictámenes). El "centinela de idempotencia"
 * que el propio docstring de la función ya prometía (`uq_pendiente_cierre_natural` es la red, no el
 * mecanismo primario) nunca funcionó de verdad: el `catch` corría un `SELECT` de "carrera" DESPUÉS
 * de un `INSERT` fallido, sin `SAVEPOINT` — en Postgres, cualquier statement después de uno fallido
 * en la misma transacción muere con `25P02` hasta el próximo `ROLLBACK`. Reproducido en el piloto
 * real: `conciliar:lote --aplicar` sobre el lote `2cf77c67` (Bracci julio) abortó en la fila 21/78
 * al reprocesar un movimiento que ya tenía un `pendiente_cierre` `'abierto'`.
 *
 *   M1 🔴 mutación EN VIVO contra el código SIN el `SAVEPOINT` (revertido a propósito para este
 *      test): dos llamadas a `escribirPendienteDeImputacion` con el mismo pedido — la segunda muere
 *      con `25P02`, no devuelve `'ya_pendiente'` .......................................... 1 mutación
 *   L1 el mecanismo REAL (con `SAVEPOINT`): la segunda llamada devuelve `'ya_pendiente'` limpio, Y
 *      una consulta siguiente en la MISMA transacción sigue funcionando (prueba de que el
 *      `SAVEPOINT` realmente despoisonó la transacción, no solo que no lanzó) ... 0 mutaciones, 1 legítimo
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, corriendo contra LOCAL.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { escribirConAuditoria, type ContextoAuditado } from '../src/db/auditoria.ts';
import { escribirPendienteDeImputacion, type PedidoPendienteDeImputacion } from '../src/cierre/escrituras.ts';
import { sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

type Fila = Record<string, unknown>;
type Ejecutar = (sql: string, params?: readonly unknown[]) => Promise<Fila[]>;

const desdeTx =
  (tx: Tx): Ejecutar =>
  (sql, params) =>
    tx.consultar<Fila>(sql, params);

async function una(ej: Ejecutar, sql: string, params?: readonly unknown[]): Promise<Fila> {
  const filas = await ej(sql, params);
  const fila = filas[0];
  if (!fila) throw new Error(`La consulta no devolvió fila: ${sql.slice(0, 80)}`);
  return fila;
}

let s: Sembrado;
let cierreId = '';

beforeAll(async () => {
  s = await sembrar();
  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
       values ($1, 'mensual', '2026-09-01'::date, '2026-09-30'::date) returning id::text as id`,
      [s.clienteA],
    );
    cierreId = String(cierre['id']);
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

async function escribirPendiente(tx: Tx, pedido: PedidoPendienteDeImputacion) {
  return escribirConAuditoria(
    tx,
    { clienteId: pedido.clienteId, accion: 'escritura', recurso: 'pendiente_cierre', motivo: 'test mutación savepoint' },
    async (ctx: ContextoAuditado) => escribirPendienteDeImputacion(tx, ctx, pedido),
  );
}

describe('SAVEPOINT de escribirPendienteDeImputacion — mecanismo real (L1, legítimo)', () => {
  it('la segunda llamada con el mismo pedido devuelve ya_pendiente, y la transacción sigue viva después', async () => {
    const movimientoId = randomUUID();
    const pedido: PedidoPendienteDeImputacion = {
      clienteId: s.clienteA,
      cierreId,
      movimientoId,
      motivoCodigo: 'tipo_sin_regla_imputacion',
      evidencia: {},
    };

    await conUsuario(USUARIOS.socio, async (tx) => {
      const primera = await escribirPendiente(tx, pedido);
      expect(primera.estado).toBe('creado');

      // Mismo pedido otra vez — antes del fix, esto tiraba 25P02 en vez de 'ya_pendiente'.
      const segunda = await escribirPendiente(tx, pedido);
      expect(segunda.estado, 'la segunda llamada tiene que devolver ya_pendiente, no lanzar').toBe('ya_pendiente');
      expect(segunda.pendienteCierreId).toBe(primera.pendienteCierreId);

      // La prueba real de que el SAVEPOINT despoisonó la transacción: una consulta CUALQUIERA
      // después tiene que seguir funcionando — si el fix fuera cosmético (atrapa el throw pero deja
      // la transacción abortada) esto moriría con 25P02 igual.
      const ej = desdeTx(tx);
      const eco = await una(ej, `select 1 as ok`);
      expect(eco['ok']).toBe(1);
    });

    const conteo = await conUsuario(USUARIOS.socio, (tx) =>
      desdeTx(tx)(`select count(*) as n from pendiente_cierre where cliente_id = $1 and referencia_origen = $2`, [s.clienteA, movimientoId]),
    );
    expect(Number(conteo[0]?.['n']), 'nunca dos filas para el mismo pedido').toBe(1);
  });
});
