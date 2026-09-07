/**
 * `confirmar-asientos.ts` — el CLI de reconciliación manual (migración `0040`, Mitad 1, Paso 2).
 * Base real. Confirma que reusa la transición `asiento_propuesto_upd_confirmar` (`0027`) y que el
 * trigger de inmutabilidad post-terminal (`0028`) sigue vigente: no se puede reconfirmar dos veces,
 * ni por el escritor ni por SQL directo.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, con `0040` APLICADA.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '@sistema-contable/data';
import { sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { confirmarAsientos, parsearArgumentos } from '../src/confirmar-asientos.ts';

let s: Sembrado;
let cierreAbiertoId = '';

let periodoSeq = 0;
async function crearCierreAbierto(tx: Tx): Promise<string> {
  periodoSeq += 1;
  const mes = String(1 + (periodoSeq % 12)).padStart(2, '0');
  const anio = 2022 + Math.floor(periodoSeq / 12);
  const desde = `${anio}-${mes}-01`;
  const f = await tx.consultar<{ id: string }>(
    `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta, cierre_estado)
     values ($1, 'mensual', $2::date, ($2::date + interval '1 month - 1 day')::date, 'abierto')
     returning id::text as id`,
    [s.clienteA, desde],
  );
  const id = f[0]?.id;
  if (!id) throw new Error('no se creó el cierre sintético');
  return id;
}

async function crearAsiento(estado: 'propuesto' | 'confirmado'): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ id: string }>(
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion, asiento_estado)
       values ($1, $2, 'devengamiento', '2026-06-15'::date, $3)
       returning id::text as id`,
      [s.clienteA, cierreAbiertoId, estado],
    );
    const id = f[0]?.id;
    if (!id) throw new Error('no se creó el asiento sintético');
    return id;
  });
}

async function estadoDe(asientoId: string): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ asiento_estado: string }>(`select asiento_estado from asiento_propuesto where id = $1`, [asientoId]);
    return f[0]?.asiento_estado ?? '';
  });
}

beforeAll(async () => {
  s = await sembrar();
  cierreAbiertoId = await conUsuario(USUARIOS.socio, (tx) => crearCierreAbierto(tx));
});

afterAll(async () => {
  await cerrarConexiones();
});

describe('parsearArgumentos', () => {
  const base = ['--cliente', randomUUID(), '--usuario', randomUUID()];

  it('dry-run por defecto (sin --aplicar), con un solo --asiento-id', () => {
    const asientoId = randomUUID();
    const r = parsearArgumentos([...base, '--asiento-id', asientoId]);
    expect(r).toEqual({ cliente: base[1], usuario: base[3], asientoIds: [asientoId], aplicar: false });
  });

  it('🔴 --asiento-id es repetible: junta todos los valores en un array, en orden', () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    const r = parsearArgumentos([...base, '--asiento-id', a, '--asiento-id', b, '--asiento-id', c, '--aplicar']);
    expect(r).toEqual({ cliente: base[1], usuario: base[3], asientoIds: [a, b, c], aplicar: true });
  });

  it('🔴 rechaza sin ningún --asiento-id — nunca "todo lo pendiente"', () => {
    expect(() => parsearArgumentos(base)).toThrow();
  });

  it('rechaza un --asiento-id que no es uuid', () => {
    expect(() => parsearArgumentos([...base, '--asiento-id', 'no-es-un-uuid'])).toThrow();
  });
});

describe('confirmarAsientos — dry-run nunca escribe', () => {
  it('un asiento "propuesto": dry-run lo diagnostica "confirmable" y NO lo confirma', async () => {
    const asientoId = await crearAsiento('propuesto');
    const r = await confirmarAsientos({ cliente: s.clienteA, usuario: USUARIOS.socio, asientoIds: [asientoId], aplicar: false });
    expect(r).toEqual({ estado: 'dry_run', reporte: [{ asientoId, diagnostico: 'confirmable', aplicado: false }] });

    expect(await estadoDe(asientoId), 'el dry-run no debe haber escrito nada').toBe('propuesto');
  });

  it('un asiento ya "confirmado": dry-run lo diagnostica "ya_terminal" con el estado real', async () => {
    const asientoId = await crearAsiento('confirmado');
    const r = await confirmarAsientos({ cliente: s.clienteA, usuario: USUARIOS.socio, asientoIds: [asientoId], aplicar: false });
    expect(r).toEqual({
      estado: 'dry_run',
      reporte: [{ asientoId, diagnostico: 'ya_terminal', asientoEstado: 'confirmado', aplicado: false }],
    });
  });

  it('un asiento inexistente: dry-run lo diagnostica "no_encontrado"', async () => {
    const asientoId = randomUUID();
    const r = await confirmarAsientos({ cliente: s.clienteA, usuario: USUARIOS.socio, asientoIds: [asientoId], aplicar: false });
    expect(r).toEqual({ estado: 'dry_run', reporte: [{ asientoId, diagnostico: 'no_encontrado', aplicado: false }] });
  });
});

describe('confirmarAsientos --aplicar — confirma un "propuesto", el resto queda explícito sin escribir', () => {
  it('un lote mixto (confirmable + ya_terminal + no_encontrado): solo el confirmable pasa a "confirmado"', async () => {
    const confirmable = await crearAsiento('propuesto');
    const yaConfirmado = await crearAsiento('confirmado');
    const inexistente = randomUUID();

    const r = await confirmarAsientos({
      cliente: s.clienteA,
      usuario: USUARIOS.socio,
      asientoIds: [confirmable, yaConfirmado, inexistente],
      aplicar: true,
    });
    expect(r).toEqual({
      estado: 'aplicado',
      reporte: [
        { asientoId: confirmable, diagnostico: 'confirmable', aplicado: true, resultado: 'confirmado' },
        { asientoId: yaConfirmado, diagnostico: 'ya_terminal', asientoEstado: 'confirmado', aplicado: false },
        { asientoId: inexistente, diagnostico: 'no_encontrado', aplicado: false },
      ],
    });

    expect(await estadoDe(confirmable)).toBe('confirmado');
    expect(await estadoDe(yaConfirmado), 'el ya-confirmado no debe haber sido tocado de nuevo').toBe('confirmado');
  });

  it('🔴 la carrera: --aplicar dos veces sobre el mismo asiento — la segunda da conflicto explícito, sin throw', async () => {
    const asientoId = await crearAsiento('propuesto');

    const primera = await confirmarAsientos({ cliente: s.clienteA, usuario: USUARIOS.socio, asientoIds: [asientoId], aplicar: true });
    expect(primera).toEqual({ estado: 'aplicado', reporte: [{ asientoId, diagnostico: 'confirmable', aplicado: true, resultado: 'confirmado' }] });

    // La segunda corrida relee (no reusa el diagnóstico de la primera) — encuentra 'confirmado', así
    // que ni siquiera intenta el UPDATE: diagnóstico 'ya_terminal', aplicado:false. El escritor mismo
    // (probado en `persistencia-reproceso-0040.test.ts` vía `reprocesarAsientoNoRevisado`) da
    // 'conflicto' cuando SÍ llega a intentar el UPDATE contra una fila que cambió DESPUÉS del
    // diagnóstico — acá se ejercita el otro borde de la misma garantía: nunca doble-confirma.
    const segunda = await confirmarAsientos({ cliente: s.clienteA, usuario: USUARIOS.socio, asientoIds: [asientoId], aplicar: true });
    expect(segunda).toEqual({
      estado: 'aplicado',
      reporte: [{ asientoId, diagnostico: 'ya_terminal', asientoEstado: 'confirmado', aplicado: false }],
    });
  });

  it('🔴 EN VIVO: el trigger de inmutabilidad de 0028 sigue intacto — reconfirmar por SQL directo (bypass del escritor) muere con P0002', async () => {
    const asientoId = await crearAsiento('confirmado');

    const error: { code?: string } = await conUsuario(USUARIOS.socio, async (tx) => {
      try {
        await tx.consultar(`update asiento_propuesto set asiento_estado = 'confirmado' where id = $1`, [asientoId]);
        return {};
      } catch (e) {
        return e as { code?: string };
      }
    });
    expect(error.code, 'reconfirmar un asiento ya confirmado, aun por SQL directo, tiene que morir por trg_asiento_propuesto_inmutable (P0002)').toBe(
      'P0002',
    );
  });
});
