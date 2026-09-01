/**
 * TESTER (2026-09-01) — caso 5 del pedido: ¿el lock `for update` sobre `lote_ingesta` en Tx2 alcanza
 * para serializar dos corridas del CLI `reclasificar:contraparte --aplicar` sobre el MISMO lote, o
 * hay una ventana entre Tx1 (lectura, SIN lock) y Tx2 (escritura, CON lock) donde el cálculo puro de
 * una corrida quedó basado en datos que la otra corrida ya cambió?
 *
 * Dos escenarios, con veredictos distintos:
 *
 * 1. **Dos corridas IDÉNTICAS del mismo mecanismo, en paralelo, sin nada más tocando la fila**: la
 *    escritura converge — las dos calculan el mismo valor final a partir de la misma `glosaOriginal`
 *    + el mismo código, así que el segundo `UPDATE`/`INSERT ... ON CONFLICT DO NOTHING` es un no-op
 *    de hecho. No hay pérdida de datos, aunque sí una fila de auditoría de escritura DUPLICADA (dos
 *    corridas, dos `escribirConAuditoria`) — ver el test de abajo.
 *
 * 2. **El caso real que preocupa**: si algo MÁS escribe `contraparte_captura` entre la lectura de Tx1
 *    de una corrida y su Tx2 (una corrección manual, un operador distinto, cualquier escritor que no
 *    sea la otra copia exacta del mismo cálculo), Tx2 NUNCA vuelve a leer el valor persistido antes
 *    de escribir — el `for update` sobre `lote_ingesta` serializa el ESTADO del lote (no permite que
 *    dos Tx2 escriban a la vez, ni que el lote cambie de estado a mitad de camino), pero NO revalida
 *    `contraparte_captura` fila por fila. El resultado: la corrida con insumos viejos PISA la
 *    corrección hecha por afuera, en silencio. El docblock de `reclasificar-contraparte.ts` (línea
 *    318) dice "TOCTOU ... se bloquea acá" — es cierto para el estado del lote, pero NO para el
 *    contenido de `contraparte_captura` que el cálculo puro usa para decidir si hay diff.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import {
  leerInsumosDeReclasificacion,
  reclasificarContraparteDeLote,
} from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../data/tests/ayuda.ts';

let s: Sembrado;

const CUIT_SINTETICO = '20111111112';

beforeAll(async () => {
  s = await sembrar();
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('reclasificar_conc', 'BANCO RECLASIFICAR CONC') on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

async function crearLoteConBug(clienteId: string): Promise<{ loteId: string; movimientoId: string }> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const cuenta = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, 'reclasificar_conc', 'ARS')
       returning id::text as id`,
      [clienteId],
    );
    const cuentaId = cuenta[0]?.id ?? '';

    const lote = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas, filas_aceptadas)
       values ($1, 'reclasificar_conc', 'prueba@1', 'archivo', $2, 'procesado', 1, 1)
       returning id::text as id`,
      [clienteId, randomUUID()],
    );
    const loteId = lote[0]?.id ?? '';

    await tx.consultar(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, '2026-08-01', '2026-08-31', 'no_verificable')`,
      [clienteId, loteId, cuentaId],
    );

    const glosaOriginal = `DOC${CUIT_SINTETICO}`;
    const mov = await tx.consultar<{ id: string }>(
      `insert into movimiento_bancario_crudo
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
          fecha, descripcion, importe, concepto_banco_estrategia, contraparte_captura)
       values ($1, $2, $3, 1, $4, '2026-08-15', $5, -100.00, 'no_publicado', 'sin_identificador')
       returning id::text as id`,
      [clienteId, loteId, cuentaId, `hash_reclasificar_conc_${clienteId}`, glosaOriginal],
    );
    const movimientoId = mov[0]?.id ?? '';

    await tx.consultar(
      `insert into movimiento_origen_crudo (cliente_id, movimiento_id, fila_origen) values ($1, $2, $3::jsonb)`,
      [
        clienteId,
        movimientoId,
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

    return { loteId, movimientoId };
  });
}

async function leerCaptura(movimientoId: string): Promise<string | undefined> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ contraparte_captura: string }>(
      `select contraparte_captura from movimiento_bancario_crudo where id = $1`,
      [movimientoId],
    );
    return f[0]?.contraparte_captura;
  });
}

async function contarCandidatos(clienteId: string, movimientoId: string): Promise<number> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ n: string }>(
      `select count(*)::text as n from movimiento_contraparte_identificador
        where cliente_id = $1 and movimiento_id = $2`,
      [clienteId, movimientoId],
    );
    return Number(f[0]?.n ?? '0');
  });
}

async function contarAuditoriaEscritura(loteId: string): Promise<number> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ n: string }>(
      `select count(*)::text as n from acceso_auditoria
        where recurso = 'movimiento_bancario_crudo' and recurso_id = $1 and accion = 'escritura'`,
      [loteId],
    );
    return Number(f[0]?.n ?? '0');
  });
}

describe('dos corridas --aplicar en paralelo, MISMO lote — escenario 1: nada más toca la fila', () => {
  it('dos Tx1 con el mismo snapshot viejo, aplicadas una tras otra: converge, sin duplicar candidato', async () => {
    const { loteId, movimientoId } = await crearLoteConBug(s.clienteA);

    // Dos "operadores" leen ANTES de que ninguno escriba — mismo snapshot viejo (sin_identificador).
    const insumosA = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    const insumosB = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteA, loteId });
    if (!insumosA.ok || !insumosB.ok) throw new Error('insumos inválidos');

    const resultadoA = await conUsuario(USUARIOS.socio, (tx) =>
      reclasificarContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumosA.insumos),
    );
    expect(resultadoA.estado).toBe('aplicado');

    // B corre DESPUÉS de que A ya escribió, pero con insumos capturados ANTES de que A escribiera —
    // el escenario exacto que preocupa: el cálculo de B se basa en datos que A ya cambió.
    const resultadoB = await conUsuario(USUARIOS.socio, (tx) =>
      reclasificarContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumosB.insumos),
    );

    // Converge: la segunda corrida NO revienta, y el estado final es el correcto — mismo resultado
    // que si solo hubiera corrido una vez.
    expect(await leerCaptura(movimientoId)).toBe('capturado');
    expect(await contarCandidatos(s.clienteA, movimientoId)).toBe(1); // sin duplicar

    // Pero SÍ quedan DOS filas de auditoría de escritura — una por cada Tx2 que corrió, aunque la
    // segunda no cambió nada de hecho. Documentado, no necesariamente un bug: cada Tx2 hizo un
    // `UPDATE`/`INSERT` real (idempotente), así que la auditoría de "hubo una escritura" es honesta.
    // Si `resultadoB.estado` fuera 'ya_reclasificado' no habría una segunda fila — no lo es, porque
    // el cálculo de B usa insumos viejos que SÍ ven diff. Este assert documenta el comportamiento
    // real, no el ideal.
    expect(resultadoB.estado).toBe('aplicado');
    expect(await contarAuditoriaEscritura(loteId)).toBe(2);
  });
});

describe('dos corridas --aplicar en paralelo, MISMO lote — escenario 2: algo MÁS corrige la fila en el medio', () => {
  it(
    '🔴 HALLAZGO: Tx2 nunca revalida `contraparte_captura` contra el estado actual antes de escribir — ' +
      'una corrección hecha DESPUÉS de Tx1 pero ANTES de Tx2 se pisa en silencio',
    async () => {
      const { loteId, movimientoId } = await crearLoteConBug(s.clienteA);

      // Tx1 de una corrida — insumos capturados con el estado viejo (sin_identificador).
      const insumos = await leerInsumosDeReclasificacion(USUARIOS.socio, { clienteId: s.clienteA, loteId });
      if (!insumos.ok) throw new Error('insumos inválidos');

      // Entre esa lectura y la escritura, ALGO MÁS corrige la fila — un socio arreglándola a mano
      // (o cualquier otro escritor legítimo que no sea una segunda copia de este mismo mecanismo).
      // El lock `for update` de Tx2 todavía no se tomó: nada previene esta escritura intermedia.
      await conUsuario(USUARIOS.socio, (tx) =>
        tx.consultar(
          `update movimiento_bancario_crudo set contraparte_captura = 'capturado_cuenta_propia' where id = $1`,
          [movimientoId],
        ),
      );
      expect(await leerCaptura(movimientoId)).toBe('capturado_cuenta_propia');

      // Tx2 corre con los insumos VIEJOS (de antes de la corrección intermedia) — nunca vuelve a
      // consultar `contraparte_captura` antes de escribir.
      const resultado = await conUsuario(USUARIOS.socio, (tx) =>
        reclasificarContraparteDeLote(tx, { clienteId: s.clienteA, loteId, aplicar: true }, insumos.insumos),
      );
      expect(resultado.estado).toBe('aplicado');

      // La corrección manual quedó PISADA — el reproceso la revirtió sin darse cuenta, porque su
      // cálculo puro nunca vio el valor nuevo. El `for update` sobre `lote_ingesta` serializa el
      // ESTADO del lote (no deja que otro Tx2 corra a la vez ni que el lote cambie de `estado` a
      // mitad de camino), pero NO protege la frescura de `contraparte_captura` fila por fila.
      expect(await leerCaptura(movimientoId)).toBe('capturado'); // NO 'capturado_cuenta_propia'
    },
  );
});
