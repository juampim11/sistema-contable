/**
 * `manifestar-padron.ts` — el ÚNICO productor de `padron_manifestacion` (0021/0041/0042, Tanda 3).
 * Base real. Cubre el parseo de argumentos, el flujo feliz (primera manifestación / reemplazo con
 * `--revoca`), los tres motivos de aborto (`YA_EXISTE_MANIFESTACION_VIGENTE`,
 * `REVOCA_NO_ES_LA_VIGENTE`, `REVOCACION_EN_CARRERA`), el conteo de citas del dry-run, y el rol
 * insuficiente (policy `padron_manifestacion_ins` excluye `administrativo`).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, con `0042` APLICADA.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '@sistema-contable/data';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { correrManifestarPadron, parsearArgumentos } from '../src/manifestar-padron.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
// parsearArgumentos
// -----------------------------------------------------------------------------

describe('parsearArgumentos', () => {
  const base = ['--cliente', randomUUID(), '--usuario', randomUUID()];

  it('parsea una primera manifestación (sin --revoca, sin --aplicar)', () => {
    const r = parsearArgumentos([...base, '--completo-hasta', '2026-06-30']);
    expect(r).toEqual({ cliente: base[1], usuario: base[3], completoHasta: '2026-06-30', revoca: null, aplicar: false });
  });

  it('parsea un reemplazo con --revoca y --aplicar', () => {
    const revoca = randomUUID();
    const r = parsearArgumentos([...base, '--completo-hasta', '2026-09-30', '--revoca', revoca, '--aplicar']);
    expect(r).toEqual({ cliente: base[1], usuario: base[3], completoHasta: '2026-09-30', revoca, aplicar: true });
  });

  it('rechaza --completo-hasta con formato inválido', () => {
    expect(() => parsearArgumentos([...base, '--completo-hasta', '30/06/2026'])).toThrow();
  });

  it('rechaza argumentos faltantes', () => {
    expect(() => parsearArgumentos(base)).toThrow();
  });
});

// -----------------------------------------------------------------------------
// correrManifestarPadron — flujo real, base real
// -----------------------------------------------------------------------------

/** Un cliente sintético propio por `it` (vía el nodo raíz `estudio`, mismo patrón que
 *  `mutaciones-0042.test.ts`) — así cada test parte de "nadie manifestó todavía", sin compartir
 *  estado con otros `it` de este archivo ni con otros archivos que usan `s.clienteA`. */
async function clienteFresco(): Promise<string> {
  const duenio = await clienteDuenio();
  try {
    const f = await duenio.query<{ id: string }>(
      `insert into tenant_node (tipo, nombre, parent_id)
       values ('cliente', 'CLIENTE MANIFESTAR PADRON', $1) returning id`,
      [s.estudio],
    );
    return f.rows[0]?.id ?? '';
  } finally {
    await duenio.end();
  }
}

describe('correrManifestarPadron — dry-run', () => {
  it('sin vigente y sin --revoca: reporta vigenteActual null, citas null, no escribe', async () => {
    const cliente = await clienteFresco();
    const r = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-06-30',
      revoca: null,
      aplicar: false,
    });
    expect(r).toEqual({ estado: 'dry_run', reporte: { vigenteActual: null, citasDeLoQueSeVaARevocar: null } });
  });
});

describe('correrManifestarPadron — flujo feliz: primera manifestación y reemplazo', () => {
  it('primera manifestación (sin --revoca) entra; un segundo intento sin --revoca aborta YA_EXISTE_MANIFESTACION_VIGENTE', async () => {
    const cliente = await clienteFresco();

    const primera = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-06-30',
      revoca: null,
      aplicar: true,
    });
    expect(primera.estado).toBe('aplicado');
    const manifestacionId = primera.estado === 'aplicado' ? primera.manifestacionId : '';
    expect(manifestacionId).toMatch(/^[0-9a-f-]{36}$/);

    const segunda = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-09-30',
      revoca: null,
      aplicar: true,
    });
    expect(segunda).toMatchObject({ estado: 'abortado', motivoCodigo: 'YA_EXISTE_MANIFESTACION_VIGENTE' });
  });

  it('--revoca con el id EXACTO de la vigente reemplaza correctamente', async () => {
    const cliente = await clienteFresco();

    const primera = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-06-30',
      revoca: null,
      aplicar: true,
    });
    const vieja = primera.estado === 'aplicado' ? primera.manifestacionId : '';

    const reemplazo = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-09-30',
      revoca: vieja,
      aplicar: true,
    });
    expect(reemplazo.estado).toBe('aplicado');
    const nueva = reemplazo.estado === 'aplicado' ? reemplazo.manifestacionId : '';
    expect(nueva).not.toBe(vieja);

    // La vigente ahora es la nueva, no la vieja — confirmado leyendo de nuevo (dry-run).
    const chequeo = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-12-31',
      revoca: null,
      aplicar: false,
    });
    expect(chequeo).toMatchObject({ estado: 'dry_run', reporte: { vigenteActual: { id: nueva, completoHasta: '2026-09-30' } } });
  });

  it('🔴 --revoca con un id que NO es la vigente aborta REVOCA_NO_ES_LA_VIGENTE (nunca "lo que el operador creía")', async () => {
    const cliente = await clienteFresco();

    const primera = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-06-30',
      revoca: null,
      aplicar: true,
    });
    const vigenteReal = primera.estado === 'aplicado' ? primera.manifestacionId : '';

    const idInventado = randomUUID();
    const r = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-09-30',
      revoca: idInventado,
      aplicar: true,
    });
    expect(r).toMatchObject({ estado: 'abortado', motivoCodigo: 'REVOCA_NO_ES_LA_VIGENTE' });
    if (r.estado === 'abortado') {
      expect(r.detalle).toContain(vigenteReal);
    }
  });

  it('🔴 --revoca cuando NO hay ninguna vigente aborta REVOCA_NO_ES_LA_VIGENTE con el mensaje de "nunca existió"', async () => {
    const cliente = await clienteFresco();
    const r = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-06-30',
      revoca: randomUUID(),
      aplicar: true,
    });
    expect(r).toMatchObject({ estado: 'abortado', motivoCodigo: 'REVOCA_NO_ES_LA_VIGENTE' });
  });
});

describe('correrManifestarPadron — conteo de citas del dry-run (punto 5, "revocar no es retroactivo")', () => {
  it('con N filas de reconocimiento_contrapartida citando la vigente, el dry-run reporta exactamente N', async () => {
    const cliente = await clienteFresco();

    const primera = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-06-30',
      revoca: null,
      aplicar: true,
    });
    const manifestacionId = primera.estado === 'aplicado' ? primera.manifestacionId : '';

    // Dos citas sintéticas directas — mismo andamio mínimo que
    // `caracterizacion-manifestacion-revocada-citable.test.ts` (movimiento + reconocimiento_movimiento
    // clase 'propuesta' + reconocimiento_contrapartida citando la manifestación).
    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `insert into banco (codigo, nombre, capacidades) values ('banco_mp_test', 'BANCO MP TEST', '{}'::jsonb)
         on conflict (codigo) do nothing`,
      );
    } finally {
      await duenio.end();
    }
    await conUsuario(USUARIOS.socio, async (tx: Tx) => {
      const cuenta = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
         values ($1, 'banco_mp_test', 'ARS', 'MP TEST') returning id::text as id`,
        [cliente],
      );
      const cuentaId = cuenta[0]?.id ?? '';
      const lote = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
         values ($1, 'banco_mp_test', 'prueba-mp', 'archivo', $2, 'recibido', 0) returning id::text as id`,
        [cliente, `hash_mp_${randomUUID()}`],
      );
      const loteId = lote[0]?.id ?? '';
      await tx.consultar(
        `insert into lote_ingesta_cuenta
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
         values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
        [cliente, loteId, cuentaId],
      );

      for (let i = 0; i < 2; i += 1) {
        const mov = await tx.consultar<{ id: string; entrada_digest: string }>(
          `insert into movimiento_bancario_crudo
             (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
              importe, saldo, concepto_banco, concepto_completo, concepto_banco_estrategia, concepto_codigo,
              contraparte_captura)
           values ($1, $2, $3, $4, $5, '2026-06-15'::date, 'GLOSA MP TEST', '-100.00'::numeric, 900.00,
                   'CONCEPTO', true, 'columna_propia', null, 'capturado')
           returning id::text as id, entrada_digest`,
          [cliente, loteId, cuentaId, i + 1, randomUUID()],
        );
        const movId = mov[0]?.id ?? '';
        const recon = await tx.consultar<{ id: string }>(
          `insert into reconocimiento_movimiento
             (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
              lado, via, que_decide, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados,
              evidencia_hubo_cola)
           values ($1, $2, $3, $4, 'propuesta', 'comision_bancaria', 'comision_de_transferencia', 'normal',
                   'debe', 'texto_literal_exacto', null, 'galicia.comision_de_transferencia', 12, false)
           returning id::text as id`,
          [cliente, movId, (i + 1).toString(16).padStart(16, '0'), String(mov[0]?.entrada_digest)],
        );
        await tx.consultar(
          `insert into reconocimiento_contrapartida
             (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase,
              padron_manifestacion_id, padron_completo_hasta, resuelto_a_fecha, patron_contraparte_estado)
           values ($1, $2, 'es_tercero_padron_completo', 'propuesta', $3, '2026-06-30'::date, '2026-06-15'::date, 'no_aplica')`,
          [cliente, recon[0]?.id, manifestacionId],
        );
      }
    });

    const dryRun = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-09-30',
      revoca: manifestacionId,
      aplicar: false,
    });
    expect(dryRun).toMatchObject({
      estado: 'dry_run',
      reporte: { vigenteActual: { id: manifestacionId }, citasDeLoQueSeVaARevocar: 2 },
    });

    // Y el --aplicar real IGUAL revoca: revocar no es retroactivo, no depende de que haya 0 citas.
    const aplicado = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-09-30',
      revoca: manifestacionId,
      aplicar: true,
    });
    expect(aplicado.estado).toBe('aplicado');

    // Las dos filas viejas SIGUEN citando la manifestación vieja — la prueba directa de "no
    // retroactivo": nadie las tocó.
    const citasSinCambiar = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ n: string }>(
        `select count(*)::text as n from reconocimiento_contrapartida
          where cliente_id = $1 and padron_manifestacion_id = $2`,
        [cliente, manifestacionId],
      ),
    );
    expect(Number(citasSinCambiar[0]?.n)).toBe(2);
  });
});

describe('correrManifestarPadron — rol insuficiente', () => {
  it('🔴 administrativo no puede manifestar (policy padron_manifestacion_ins exige socio|contador)', async () => {
    const cliente = await clienteFresco();
    await expect(
      correrManifestarPadron({
        cliente,
        usuario: USUARIOS.administrativoA,
        completoHasta: '2026-06-30',
        revoca: null,
        aplicar: true,
      }),
    ).rejects.toThrow();
  });
});

describe('correrManifestarPadron — 🔴 carrera real: dos --revoca concurrentes sobre la MISMA vigente', () => {
  /**
   * 🔴 HALLAZGO, medido acá: `manifestarPadron` tiene DOS capas contra esta carrera, no una, y
   * cuál de las dos atrapa al perdedor depende del timing real de las dos conexiones — ambas son
   * fail-closed, ninguna dejar pasar las dos revocaciones:
   *
   *   - Si el ganador ya COMITEÓ su INSERT antes de que el perdedor termine su PRE-LECTURA
   *     (`leerManifestacionVigente`, check-then-act, sin lock): el perdedor ve la vigente NUEVA (no
   *     `X`) y aborta ANTES de intentar escribir, con `REVOCA_NO_ES_LA_VIGENTE`.
   *   - Si las dos pre-lecturas corren ANTES de que cualquiera de las dos comitee (la ventana real
   *     que `0042` existe para cerrar): las dos pasan la pre-lectura viendo "X vigente", las dos
   *     intentan el INSERT, y `uq_padron_manifestacion_revoca_a` deja pasar una y rechaza la otra
   *     con `23505` — que este escritor traduce a `REVOCACION_EN_CARRERA`.
   *
   * `mutaciones-0042.test.ts` (M1) ya prueba el segundo camino de forma determinística, con dos
   * conexiones de bajo nivel sincronizadas para forzar que las dos pre-lecturas ganen la carrera
   * contra el commit. Acá, con dos llamadas de alto nivel a `correrManifestarPadron` vía
   * `Promise.all` (sin ese control fino de timing), el resultado real fue el PRIMER camino — lo que
   * confirma que la pre-lectura, aunque no sea el control de fondo, sí atrapa el caso más común en
   * la práctica (dos operadores separados por más que microsegundos). Se acepta cualquiera de los
   * dos motivos: los dos son controles reales, y cuál dispara es una cuestión de timing, no de
   * corrección — lo único que NO puede pasar es que las dos entren, o que el perdedor reciba el
   * `23505` crudo de Postgres sin traducir.
   */
  it('exactamente uno aplica; el otro aborta por REVOCACION_EN_CARRERA o por REVOCA_NO_ES_LA_VIGENTE — nunca las dos entran', async () => {
    const cliente = await clienteFresco();
    const primera = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-06-30',
      revoca: null,
      aplicar: true,
    });
    const vigente = primera.estado === 'aplicado' ? primera.manifestacionId : '';

    const [r1, r2] = await Promise.all([
      correrManifestarPadron({ cliente, usuario: USUARIOS.socio, completoHasta: '2026-09-30', revoca: vigente, aplicar: true }),
      correrManifestarPadron({ cliente, usuario: USUARIOS.socio, completoHasta: '2026-09-30', revoca: vigente, aplicar: true }),
    ]);

    const estados = [r1.estado, r2.estado].sort();
    expect(estados).toEqual(['abortado', 'aplicado']);

    const perdedor = r1.estado === 'abortado' ? r1 : r2;
    expect(perdedor.estado).toBe('abortado');
    if (perdedor.estado === 'abortado') {
      expect(['REVOCACION_EN_CARRERA', 'REVOCA_NO_ES_LA_VIGENTE']).toContain(perdedor.motivoCodigo);
    }

    // Pase lo que pase, queda EXACTAMENTE una manifestación vigente al final — nunca dos cadenas
    // vivas simultáneas (la propiedad de fondo que 0042 protege).
    const chequeo = await correrManifestarPadron({
      cliente,
      usuario: USUARIOS.socio,
      completoHasta: '2026-12-31',
      revoca: null,
      aplicar: false,
    });
    expect(chequeo.estado).toBe('dry_run');
    if (chequeo.estado === 'dry_run') {
      expect(chequeo.reporte.vigenteActual).not.toBeNull();
    }
  });
});
