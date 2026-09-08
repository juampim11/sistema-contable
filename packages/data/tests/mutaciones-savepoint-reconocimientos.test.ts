/**
 * MUTACIÓN — el `SAVEPOINT` por pedido de `persistirReconocimientos` (Tanda 3, docs/diseno/
 * 31-replanteo-hacia-producto.md; `packages/data/src/contabilidad/escrituras.ts` L766+).
 *
 * CLAUDE.md §1.8 / ADR-0002 §B.0: una regla verificable no cuenta como control hasta que se probó
 * ROMPIÉNDOLA. El control acá NO es un CHECK/FK/trigger de DDL —eso ya lo cierra
 * `mutaciones-0041.test.ts` para `app.exigir_manifestacion_vigente()`— sino código de APLICACIÓN:
 * el `SAVEPOINT`/`try`/`catch` que evita que un `P0004` de UN pedido (el trigger de `0041`
 * detectando que `padron_manifestacion_id` fue revocada por otra transacción MIENTRAS corría el
 * lote) aborte la transacción del lote ENTERO.
 *
 * Reproduce la carrera EN VIVO con DOS CONEXIONES REALES a Postgres (dos `conUsuario()` distintos,
 * cada uno agarra su propia conexión del pool): mientras la transacción A (el lote) tiene un
 * SAVEPOINT abierto para el pedido 2, la conexión B revoca la manifestación que ese pedido cita y
 * COMMITEA — de verdad, no simulado.
 *
 * 🔴 Acá NO hace falta `pg_sleep`: a diferencia de `mutaciones-0041.test.ts` (que mide si el LOCK
 * de la función SQL gana o pierde una carrera de milisegundos), acá el orden lo garantiza un
 * `await` real sobre el `commit` de B —`conUsuario()` no resuelve su promesa hasta after `cliente.
 * query('commit')`— antes de que A toque el pedido 2. Eso es MÁS fuerte que un delay: no depende
 * de timing de red, depende de la semántica de la promesa. La ventana de carrera real (si el LOCK
 * de `0041` alcanza) ya está probada en `mutaciones-0041.test.ts`; este archivo prueba la CAPA DE
 * ARRIBA — qué hace `persistirReconocimientos` cuando esa ventana efectivamente se cruza.
 *
 * ## Conteo de mutaciones declarado: 1 mutación + 1 legítimo, en 2 `it`
 *
 *   L1 legítimo: pedido 1 (SIN relación con la manifestación, ver el hallazgo de abajo) entra →
 *      B revoca X y commitea → pedido 2 (PRIMER citador de X en el lote, ya revocada) muere P0004
 *      DENTRO del savepoint, se cuenta y NO deja fila huérfana → pedido 3 (sin relación con X, en
 *      la MISMA llamada que el 2) se persiste igual ........................... 0 mutaciones
 *   M1 🔴 mini-loop mutado, SIN SAVEPOINT/try/catch, corriendo la MISMA carrera (misma función
 *      real `persistirReconocimiento` por pedido, sólo cambia el wrapper del loop): el P0004 se
 *      propaga sin atajar, aborta TODA la transacción, y el pedido "3" —que con el código real
 *      sobrevive (ver L1)— se pierde entero, ni siquiera se intenta ................ 1 mutación
 *                                                                                  ─────────────
 *                                                                                  1 mutación, 1 legítimo
 *
 * ## 🔴 HALLAZGO sobre el mecanismo REAL (no sobre este test): la ventana de carrera es más
 * angosta de lo que el enunciado de la tarea supone
 *
 * El primer intento de este archivo hacía que EL PEDIDO 1 también citara a X (para reflejar "un
 * lote con varios pedidos citando la misma manifestación vigente" tal cual lo describe
 * `reconocer-lote.ts`). Ese intento SE COLGÓ hasta el timeout — no un bug del test, sino una
 * propiedad real del mecanismo, medida en vivo: cuando el pedido 1 cita a X y `app.exigir_
 * manifestacion_vigente()` (0041) toma `FOR UPDATE` sobre la fila de X, ESE LOCK LO RETIENE LA
 * TRANSACCIÓN DEL LOTE HASTA QUE TERMINA (commit o rollback) — los locks de fila de Postgres son
 * de ALCANCE TRANSACCIÓN, no de savepoint; `ROLLBACK TO SAVEPOINT` nunca los libera (documentado:
 * https://www.postgresql.org/docs/current/sql-rollback-to.html). Con ese lock retenido, la
 * conexión B —que para revocar X necesita `FOR KEY SHARE` sobre esa misma fila, vía
 * `fk_padron_manifestacion_revoca`— queda BLOQUEADA hasta que A termine. Y A (este test) estaba
 * esperando a que B terminara antes de seguir: deadlock de aplicación.
 *
 * Consecuencia para el mecanismo real, no sólo para este test: dentro de UN MISMO lote
 * (`reconocer-lote.ts` corre TODO el lote en una sola transacción), en cuanto el PRIMER movimiento
 * cita una manifestación vigente X y esa cita entra bien, esa transacción retiene el lock sobre X
 * hasta que el lote entero termina — así que NINGÚN otro proceso puede revocar X mientras ese lote
 * siga corriendo. La ventana de carrera que el `SAVEPOINT` de esta tarea protege NO es "cualquier
 * pedido del lote puede perder contra una revocación concurrente": es, como mucho, **el primer
 * pedido del lote que cita una manifestación dada** — todos los que la citan DESPUÉS, dentro del
 * mismo lote, ya están protegidos por el lock que el primero dejó tomado (si el primero pierde la
 * carrera y falla P0004, el lock igual queda tomado — sólo se soltó el INSERT vía savepoint, no el
 * lock — así que un segundo citador de la misma X en el mismo lote vería `v_revocada = true` de
 * inmediato, sin bloqueo, y fallaría también, consistente). Este archivo prueba exactamente esa
 * ventana angosta (pedido 2 como PRIMER citador de X en el lote) porque es la única reproducible
 * sin deadlock — y es, además, la única que puede ocurrir de verdad en producción.
 *
 * ## Por qué el mini-loop mutado es una refutación real y no un straw man
 *
 * M1 NO reimplementa `persistirReconocimiento` (la función por pedido, con sus cuatro pasos e
 * inserts) — la importa y la llama TAL CUAL. Lo único que M1 quita es el wrapper de
 * `persistirReconocimientos` (`escrituras.ts` L788-809: `savepoint` antes de cada pedido,
 * `release savepoint` en el camino feliz, `rollback to savepoint` + `release savepoint` sólo
 * cuando `error instanceof ErrorDeBase && error.codigo === 'ING_MANIFESTACION_REVOCADA'`). Borrar
 * ese `if` del código real y dejar `throw error` desnudo para TODO error —la mutación de manual
 * que pide CLAUDE.md §1.8— produce EXACTAMENTE el mismo mini-loop que M1 corre acá: mismo error,
 * mismo `for` sin protección, mismo resultado. No hay una segunda forma de "simular" esto porque
 * no hay una segunda función que reemplazar: la protección ES el wrapper, y M1 es ese wrapper
 * quitado, corriendo contra la base real.
 *
 * ## Fixtures
 *
 * Duplica su propio andamio mínimo (movimiento + manifestación + pedido armado a mano) en vez de
 * importarlo de `mutaciones-0021.test.ts`, `mutaciones-0041.test.ts` o
 * `caracterizacion-manifestacion-revocada-citable.test.ts` — ninguno de esos archivos exporta sus
 * helpers, y este archivo existe para no compartir su conteo de mutaciones con ningún otro (mismo
 * criterio que el docstring de `caracterizacion-manifestacion-revocada-citable.test.ts`).
 *
 * Ni un valor del material real: cliente y usuario salen de `sembrar()` (sintético), y las fechas
 * son literales de esta prueba.
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, con `0041` APLICADA y el
 * diff de Tanda 3 (`escrituras.ts`, `errores-pg.ts`, `reconocer-lote.ts`) en el working tree.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { escribirConAuditoria, type ContextoAuditado } from '../src/db/auditoria.ts';
import { ErrorDeBase } from '../src/db/errores-pg.ts';
import {
  persistirReconocimiento,
  persistirReconocimientos,
  type PedidoDePersistirReconocimiento,
} from '../src/contabilidad/escrituras.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

// -----------------------------------------------------------------------------
// Andamio mínimo — duplicado a propósito, ver docstring de arriba.
// -----------------------------------------------------------------------------

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

function n(fila: Fila): number {
  return Number(fila['n']);
}

/** Captura un `ErrorDeBase` y devuelve su código; cualquier otra cosa se relanza (un fallo del
 *  test tiene que verse como fallo del test, no taparse como "no dio el código esperado"). */
async function capturarErrorDeBase(fn: () => Promise<unknown>): Promise<{ readonly codigo: string }> {
  try {
    await fn();
    return { codigo: '' };
  } catch (e) {
    if (e instanceof ErrorDeBase) return { codigo: e.codigo };
    throw e;
  }
}

function comoSocio<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

const BANCO = 'banco_mut_savepoint_recon';

let s: Sembrado;
let filaSeq = 0;
let digestSeq = 0;
let cuenta = { clienteId: '', cuentaId: '', loteId: '' };

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ($1, 'BANCO MUT SAVEPOINT RECON', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const c = await una(
      ej,
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
       values ($1, $2, 'ARS', 'MUT SAVEPOINT RECON') returning id::text as id`,
      [s.clienteA, BANCO],
    );
    const lote = await una(
      ej,
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
       values ($1, $2, 'prueba-mut-savepoint-recon', 'archivo', $3, 'recibido', 0)
       returning id::text as id`,
      [s.clienteA, BANCO, `hash_mut_savepoint_recon_${randomUUID()}`],
    );
    await ej(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
          verificacion_estado)
       values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
      [s.clienteA, String(lote['id']), String(c['id'])],
    );
    cuenta = { clienteId: s.clienteA, cuentaId: String(c['id']), loteId: String(lote['id']) };
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

/** 16 hex, la forma que exige `reconocimiento_digest_chk`. Sintético y monotónico. */
function motorDigestSintetico(): string {
  digestSeq += 1;
  return digestSeq.toString(16).padStart(16, '0');
}

/** Movimiento nuevo, mínimo — un `fila_numero`/`fila_hash` por llamada, así que dos pedidos nunca
 *  chocan entre sí. `fecha` fija en `2026-06-15`, adentro del alcance de toda manifestación que
 *  arma este archivo (`completo_hasta = '2026-06-30'`). */
async function crearMovimiento(
  ej: Ejecutar,
  glosaSufijo: string,
): Promise<{ readonly id: string; readonly entradaDigest: string }> {
  filaSeq += 1;
  const f = await una(
    ej,
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, saldo, concepto_banco, concepto_completo, concepto_banco_estrategia, concepto_codigo,
        contraparte_captura)
     values ($1, $2, $3, $4, $5, '2026-06-15'::date, $6, '-100.00'::numeric, 900.00,
             'CONCEPTO', true, 'columna_propia', null, 'capturado')
     returning id::text as id, entrada_digest`,
    [cuenta.clienteId, cuenta.loteId, cuenta.cuentaId, filaSeq, randomUUID(), `GLOSA MUT SAVEPOINT ${glosaSufijo}`],
  );
  return { id: String(f['id']), entradaDigest: String(f['entrada_digest']) };
}

/** `completo_hasta` fijo en `'2026-06-30'` (sin `revocaA`) o `'2026-09-30'` (revocando `revocaA`) —
 *  mismos literales que `mutaciones-0041.test.ts`, sin necesidad de parametrizarlos acá. */
async function crearManifestacion(ej: Ejecutar, revocaA: string | null = null): Promise<string> {
  const f = revocaA
    ? await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta, revoca_a)
         values ($1, '2026-09-30'::date, $2) returning id::text as id`,
        [cuenta.clienteId, revocaA],
      )
    : await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta)
         values ($1, '2026-06-30'::date) returning id::text as id`,
        [cuenta.clienteId],
      );
  return String(f['id']);
}

/** El shape EXACTO que arma `apps/cli/src/reconocer-lote.ts` en la rama `es_tercero_padron_
 *  completo`: `clase: 'propuesta'`, y `padronManifestacionId`/`padronCompletoHasta` tomados de
 *  la manifestación citada, nunca inventados (ver el comentario de `PedidoDePersistirReconocimiento.
 *  contrapartida` en `escrituras.ts`). Mismos literales de tipo/concepto/vía que usan
 *  `mutaciones-0041.test.ts` y `caracterizacion-manifestacion-revocada-citable.test.ts` para un
 *  padre `propuesta` — combinación ya probada contra los CHECK de `reconocimiento_movimiento`. */
function pedidoCitandoManifestacion(params: {
  readonly movimientoId: string;
  readonly entradaDigest: string;
  readonly manifestacionId: string;
  readonly completoHasta: string;
}): PedidoDePersistirReconocimiento {
  return {
    clienteId: cuenta.clienteId,
    movimientoId: params.movimientoId,
    reconocimientoId: randomUUID(),
    motorDigest: motorDigestSintetico(),
    entradaDigest: params.entradaDigest,
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
    candidatos: [],
    contrapartida: {
      resolucionEstado: 'es_tercero_padron_completo',
      resueltoAFecha: '2026-06-15',
      padronManifestacionId: params.manifestacionId,
      padronCompletoHasta: params.completoHasta,
      patronContraparteEstado: 'sin_match',
      patronContraparteIds: [],
      patronContraparteOrigen: null,
    },
  };
}

/** El "pedido 3": SIN relación ninguna con la manifestación — mismo shape que el `pedido()` de
 *  `mutaciones-0021.test.ts` para `decision_humana`/`distinguir_tercero_de_socio`. Existe para que
 *  su persistencia (o su pérdida, en la versión mutada) sea la prueba de que el LOTE sigue —no
 *  para ejercitar nada del gate de manifestación. */
function pedidoSinManifestacion(params: {
  readonly movimientoId: string;
  readonly entradaDigest: string;
}): PedidoDePersistirReconocimiento {
  return {
    clienteId: cuenta.clienteId,
    movimientoId: params.movimientoId,
    reconocimientoId: randomUUID(),
    motorDigest: motorDigestSintetico(),
    entradaDigest: params.entradaDigest,
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

/** Cuenta las filas de `reconocimiento_movimiento` de un movimiento — 0 o 1 (un movimiento nuevo
 *  nunca tiene más de un reconocimiento vigente, y acá cada movimiento es nuevo). */
async function reconocimientosDe(ej: Ejecutar, movimientoId: string): Promise<number> {
  return n(
    await una(ej, `select count(*)::int as n from reconocimiento_movimiento where movimiento_id = $1`, [
      movimientoId,
    ]),
  );
}

/** Cuenta las filas de `reconocimiento_contrapartida` colgadas de un movimiento, vía join —
 *  necesario porque `reconocimiento_contrapartida` no tiene `movimiento_id` propio. */
async function contrapartidasDe(ej: Ejecutar, movimientoId: string): Promise<number> {
  return n(
    await una(
      ej,
      `select count(*)::int as n
         from reconocimiento_contrapartida c
         join reconocimiento_movimiento r
           on r.cliente_id = c.cliente_id and r.id = c.reconocimiento_id
        where r.movimiento_id = $1`,
      [movimientoId],
    ),
  );
}

// =============================================================================
// L1 — legítimo: el código REAL (persistirReconocimientos, CON savepoint) sobrevive la carrera
// =============================================================================
describe('savepoint por pedido en persistirReconocimientos (Tanda 3) — L1 legítimo', () => {
  it(
    'L1 pedido 1 (sin relación con X) entra → B revoca X y COMMITEA → pedido 2 (PRIMER citador de X en el lote) muere P0004 sin dejar huérfano → pedido 3 se persiste igual',
    async () => {
      const manX = await comoSocio((ej) => crearManifestacion(ej));

      const mov1 = await comoSocio((ej) => crearMovimiento(ej, 'PEDIDO1'));
      const mov2 = await comoSocio((ej) => crearMovimiento(ej, 'PEDIDO2'));
      const mov3 = await comoSocio((ej) => crearMovimiento(ej, 'PEDIDO3'));

      // 🔴 pedido1 NO cita a X — ver el hallazgo del docstring del archivo: si citara a X y
      // entrara bien, el `FOR UPDATE` que toma `app.exigir_manifestacion_vigente()` (0041) queda
      // RETENIDO por la transacción del lote hasta que ésta termine (los locks de fila de Postgres
      // son de transacción, no de savepoint — `ROLLBACK TO SAVEPOINT` no los libera). Eso
      // bloquearía a la conexión B cuando intente revocar X (su INSERT necesita `FOR KEY SHARE`
      // sobre X vía `fk_padron_manifestacion_revoca`) hasta que A commitee — y A está esperando a
      // que B termine antes de seguir. Deadlock de aplicación, medido en vivo (el primer intento de
      // este archivo tenía `pedido1` citando a X y el test colgó hasta el timeout). Por eso pedido1
      // es un pedido SIN relación con la manifestación: sólo así queda libre el camino para que la
      // revocación de B entre y commitee ANTES de que alguien en el lote haya tomado el lock.
      const pedido1 = pedidoSinManifestacion({ movimientoId: mov1.id, entradaDigest: mov1.entradaDigest });
      const pedido2 = pedidoCitandoManifestacion({
        movimientoId: mov2.id,
        entradaDigest: mov2.entradaDigest,
        manifestacionId: manX,
        completoHasta: '2026-06-30',
      });
      const pedido3 = pedidoSinManifestacion({ movimientoId: mov3.id, entradaDigest: mov3.entradaDigest });

      const resultado = await conUsuario(USUARIOS.socio, async (tx) => {
        const ej = desdeTx(tx);
        // Un solo evento de auditoría para todo el lote — mismo criterio que `reconocer-lote.ts`
        // ("Un solo evento de auditoría por LOTE, no por movimiento").
        const ctx: ContextoAuditado = await escribirConAuditoria(
          tx,
          {
            clienteId: cuenta.clienteId,
            accion: 'escritura',
            recurso: 'reconocimiento_movimiento',
            motivo: 'prueba de mutación del savepoint de persistirReconocimientos (Tanda 3)',
          },
          (c) => Promise.resolve(c),
        );

        const argsLote = { clienteId: cuenta.clienteId, loteIngestaId: cuenta.loteId, motorDigest: 'mut-savepoint-recon' };
        const r1 = await persistirReconocimientos(tx, ctx, argsLote, [pedido1]);

        // 🔴 CONEXIÓN B — REAL Y SEPARADA (otro `conUsuario`, otra conexión del pool). Revoca X y
        // COMMITEA antes de que A toque el pedido 2. `await` sobre este `conUsuario` no resuelve
        // hasta DESPUÉS de `cliente.query('commit')` (ver `conexion.ts`), así que al volver acá el
        // commit de B ya es un hecho consumado — no hace falta pg_sleep ni delay artificial.
        await conUsuario(USUARIOS.socio, async (txB) => {
          const ejB = desdeTx(txB);
          await ejB(
            `insert into padron_manifestacion (cliente_id, completo_hasta, revoca_a)
             values ($1, '2026-09-30'::date, $2)`,
            [cuenta.clienteId, manX],
          );
        });

        // Pedido 2 (pisa la revocación) y pedido 3 (ajeno a la manifestación), en la MISMA llamada:
        // es la forma exacta en la que `persistirReconocimientos` recorre un lote real.
        const r2 = await persistirReconocimientos(tx, ctx, argsLote, [pedido2, pedido3]);

        // El savepoint tiene que haber deshecho el insert de reconocimiento_movimiento del pedido 2
        // DENTRO de la misma transacción, antes de seguir con el pedido 3 — no sólo al final.
        const huerfanoDentro = await reconocimientosDe(ej, mov2.id);

        return { r1, r2, huerfanoDentro };
      });

      // ---- Los resúmenes que devuelve el código real ----
      expect(resultado.r1.creados, 'pedido 1 (sin carrera) se persiste normal').toBe(1);
      expect(resultado.r1.manifestacionRevocadaDuranteLaCorrida, 'pedido 1 no pisó ninguna carrera').toBe(0);

      expect(
        resultado.r2.manifestacionRevocadaDuranteLaCorrida,
        'pedido 2 tiene que contarse como carrera detectada — un valor > 0 NO es un error',
      ).toBe(1);
      expect(
        resultado.r2.creados,
        'pedido 3 tiene que persistirse IGUAL después de la carrera del pedido 2: el lote sigue',
      ).toBe(1);

      expect(
        resultado.huerfanoDentro,
        'el ROLLBACK TO SAVEPOINT del pedido 2 tiene que deshacer el insert en reconocimiento_movimiento, dentro de la misma transacción',
      ).toBe(0);

      // ---- Verificación POST-COMMIT, con una lectura fresca (otra conexión más) ----
      const verificacion = await comoSocio(async (ej) => ({
        mov1Recon: await reconocimientosDe(ej, mov1.id),
        mov2Recon: await reconocimientosDe(ej, mov2.id),
        mov2Contrapartida: await contrapartidasDe(ej, mov2.id),
        mov3Recon: await reconocimientosDe(ej, mov3.id),
      }));

      expect(verificacion.mov1Recon, 'pedido 1 quedó commiteado de verdad').toBe(1);
      expect(
        verificacion.mov2Recon,
        'pedido 2 (el que pisó la revocación) NO puede haber dejado NINGUNA fila en reconocimiento_movimiento, ni siquiera después del commit',
      ).toBe(0);
      expect(
        verificacion.mov2Contrapartida,
        'pedido 2 tampoco puede haber dejado fila en reconocimiento_contrapartida',
      ).toBe(0);
      expect(
        verificacion.mov3Recon,
        'pedido 3 quedó commiteado igual: la prueba de que el lote sigue después de la carrera',
      ).toBe(1);
    },
    20_000,
  );
});

// =============================================================================
// M1 — 🔴 mutación: SIN savepoint/try/catch, el mismo P0004 aborta TODO el lote
// =============================================================================
describe('savepoint por pedido en persistirReconocimientos (Tanda 3) — M1 🔴 mutación', () => {
  it(
    'M1 🔴 mini-loop SIN SAVEPOINT/try/catch: el P0004 del pedido "2" se propaga y el pedido "3" (que con el código real sobrevive) se pierde ENTERO',
    async () => {
      if (entornoActual() !== 'local') {
        throw new Error(`Esta prueba corre SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
      }

      const manZ = await comoSocio((ej) => crearManifestacion(ej));

      const movRoto2 = await comoSocio((ej) => crearMovimiento(ej, 'ROTO2'));
      const movRoto3 = await comoSocio((ej) => crearMovimiento(ej, 'ROTO3'));

      const pedidoRoto2 = pedidoCitandoManifestacion({
        movimientoId: movRoto2.id,
        entradaDigest: movRoto2.entradaDigest,
        manifestacionId: manZ,
        completoHasta: '2026-06-30',
      });
      const pedidoRoto3 = pedidoSinManifestacion({
        movimientoId: movRoto3.id,
        entradaDigest: movRoto3.entradaDigest,
      });

      /**
       * 🔴 EL MINI-LOOP MUTADO. Llama a la MISMA `persistirReconocimiento` real, pedido por pedido
       * — nunca la reimplementa — pero SIN el `savepoint`/`try`/`catch` que agrega
       * `persistirReconocimientos` (`escrituras.ts` L788-809). Es, letra por letra, el resultado de
       * borrar `if (error instanceof ErrorDeBase && error.codigo === 'ING_MANIFESTACION_REVOCADA')`
       * del código real y dejar `throw error` desnudo para todo error: no hay una versión mutada
       * DISTINTA de esto, porque la protección completa ES ese bloque.
       */
      async function loopRotoSinSavepoint(
        tx: Tx,
        ctx: ContextoAuditado,
        pedidos: readonly PedidoDePersistirReconocimiento[],
      ): Promise<{ readonly creados: number }> {
        let creados = 0;
        for (const pedido of pedidos) {
          const r = await persistirReconocimiento(tx, ctx, pedido); // 🔴 sin savepoint, sin catch
          if (r.estado === 'creado') creados += 1;
        }
        return { creados };
      }

      const error = await capturarErrorDeBase(() =>
        conUsuario(USUARIOS.socio, async (tx) => {
          const ctx: ContextoAuditado = await escribirConAuditoria(
            tx,
            {
              clienteId: cuenta.clienteId,
              accion: 'escritura',
              recurso: 'reconocimiento_movimiento',
              motivo: 'mutación: mini-loop sin savepoint (prueba de que el control real hace falta)',
            },
            (c) => Promise.resolve(c),
          );

          // Misma conexión B real y separada, mismo orden garantizado por el await del commit.
          await conUsuario(USUARIOS.socio, async (txB) => {
            const ejB = desdeTx(txB);
            await ejB(
              `insert into padron_manifestacion (cliente_id, completo_hasta, revoca_a)
               values ($1, '2026-09-30'::date, $2)`,
              [cuenta.clienteId, manZ],
            );
          });

          return loopRotoSinSavepoint(tx, ctx, [pedidoRoto2, pedidoRoto3]);
        }),
      );

      expect(
        error.codigo,
        'sin el savepoint el P0004 se propaga TAL CUAL — el mismo código que el control real atrapa y neutraliza',
      ).toBe('ING_MANIFESTACION_REVOCADA');

      // 🔴 LA PRUEBA DURA, contra la base real: nada de este lote quedó commiteado. `conUsuario()`
      // hace ROLLBACK completo al recibir el throw (ver `conexion.ts:251-257`) — ni siquiera el
      // pedido "roto2" (el que disparó el error) queda con nada, y "roto3" —que con el código real
      // (L1, arriba) se persiste igual— acá se pierde ENTERO: el `for` sin catch ni siquiera llegó
      // a intentarlo.
      const verificacion = await comoSocio(async (ej) => ({
        roto2Recon: await reconocimientosDe(ej, movRoto2.id),
        roto3Recon: await reconocimientosDe(ej, movRoto3.id),
      }));

      expect(verificacion.roto2Recon, 'roto2 no dejó nada — coincide con el control real (L1)').toBe(0);
      expect(
        verificacion.roto3Recon,
        '🔴 MUTACIÓN REFUTADA: SIN el savepoint, roto3 TAMBIÉN se pierde — con el código real (L1) se persiste igual',
      ).toBe(0);
    },
    20_000,
  );
});
