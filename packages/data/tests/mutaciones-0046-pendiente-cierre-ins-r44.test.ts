/**
 * MUTACIONES de `0046_pendiente_cierre_ins_r44.sql` — prueba por mutación de `pendiente_cierre_ins`:
 * un INSERT nunca puede nacer ya resuelto/dispensado/superseded, sea cual sea el rol que lo ejecuta.
 *
 * Hallazgo cerrado (ver encabezado de la migración para el detalle completo, verificado línea por
 * línea contra `0027_cierre_mensual.sql:645-648` y `0045_usuario_identidad_capacidades_r44.sql`, no
 * asumido): `pendiente_cierre_ins` (`0027`) sólo exigía aislamiento de tenant + rol — nada sobre
 * `pendiente_estado`/`resuelto_por`/`resuelto_en`/`resolucion_id`/`superseded_by_id`. Un
 * `administrativo` (que SÍ tiene INSERT sobre esta tabla, `0027:668`, grant de tabla completa) podía
 * insertar directo una fila `pendiente_estado = 'dispensado'` con `resuelto_por` de un tercero —
 * bypaseando a la vez la autoría (R44) Y el gate de ROL que `pendiente_cierre_upd_dispensa` (`0045`)
 * le prohíbe explícito a `administrativo` por la vía de UPDATE.
 *
 * ## Por qué esto NO es sólo "R44 de autoría" (a diferencia de `mutaciones-0045-...test.ts`)
 *
 * El eje central de acá es el ESTADO, no sólo la autoría: aun forzando `resuelto_por`/`resuelto_en` a
 * `null`, un `administrativo` seguiría pudiendo insertar `pendiente_estado = 'dispensado'` directo —
 * sigue sin pasar por `pendiente_cierre_upd_dispensa`, sigue sin dejar un `pendiente_dispensa`
 * (append-only), sigue escapando el gate de confirmación de D-24
 * (`app.verificar_gate_confirmacion_cierre`, que sólo cuenta `pendiente_estado = 'abierto'`). Por eso
 * el eje B de abajo prueba justo ESO (dispensar sin forjar identidad, sólo el estado) — es el caso que
 * una lectura literal de "cerrar sólo `resuelto_por`/`resuelto_en`" habría dejado pasar.
 *
 * ## Grant vs. RLS — misma disciplina que `mutaciones-0045-...test.ts` (CLAUDE.md, pedido explícito)
 *
 * Un `WITH CHECK` de RLS violado y un `INSERT` sobre una columna sin grant dan el MISMO `SQLSTATE
 * 42501`. El grant de INSERT sobre `pendiente_cierre` sigue siendo de tabla completa (`0027`, sin
 * acotar — decisión de la propia migración `0046`, ver su encabezado), así que las cinco columnas que
 * el ataque intenta forjar YA están probadas grantables por el caso legítimo B/D de abajo antes de
 * atacar con ellas: el `42501` del ataque no puede ser por privilegio faltante. `esperarRechazoRls()`
 * además exige el texto real de una violación de `WITH CHECK` de Postgres, no sólo el código.
 *
 * ## Cobertura declarada (CLAUDE.md §1.8: conteo explícito)
 *
 *   A.1 legítimo (columnas omitidas, default real)      A.2 legítimo (columnas explícitas, en null)
 *   B.1 ATAQUE (dispensado + autoría forjada — el hallazgo original)
 *   B.2 ATAQUE (dispensado, SIN forjar autoría — el caso que "sólo resuelto_por/resuelto_en" no cierra)
 *   B.3 ATAQUE (mismo intento, ejecutado por socio/contador — el rol autorizado a dispensar por UPDATE
 *       tampoco puede saltarse el nacimiento 'abierto' por INSERT)
 *   C.1 ATAQUE (resolucion_id colado sin tocar pendiente_estado/resuelto_por)
 *   C.2 ATAQUE (superseded_by_id apuntando a una fila real y grantable por FK — muere por RLS, no por FK)
 *                                                                          ─────────────────────
 *                                                                          7 `it()`
 *
 * Requisito previo: `0046` aplicada a local.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
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

type ErrorPg = { readonly code: string; readonly constraint: string | null; readonly message: string };
const SIN_ERROR: ErrorPg = { code: '', constraint: null, message: '(no falló)' };

async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return SIN_ERROR;
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string };
    return {
      code: err.code ?? '(sin code)',
      constraint: err.constraint ?? null,
      message: err.message ?? String(e),
    };
  }
}

/**
 * Rechazo esperado por RLS (0046), no por grant ni por FK: exige `42501` Y el texto real de Postgres
 * para una violación de `WITH CHECK` — descarta sin ambigüedad que el rechazo sea por columna no
 * grantable (mismo mecanismo que `mutaciones-0045-...test.ts`).
 */
function esperarRechazoRls(actual: ErrorPg, porque: string): void {
  expect(actual.code, porque).toBe('42501');
  expect(
    actual.message,
    `${porque} — y el mensaje tiene que ser el de una policy de RLS, no el de un grant de columna o ` +
      `una FK: "${actual.message}"`,
  ).toMatch(/row-level security policy/);
}

function comoUsuario<T>(usuarioId: string, fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(usuarioId, (tx) => fn(desdeTx(tx)));
}

let s: Sembrado;

beforeAll(async () => {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de mutación de 0046 corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

async function crearCierre(ej: Ejecutar, periodo: string): Promise<string> {
  const f = await una(
    ej,
    `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
     values ($1, 'mensual', $2, $2::date + interval '1 month' - interval '1 day')
     returning id::text as id`,
    [s.clienteA, periodo],
  );
  return String(f['id']);
}

// `cierre_periodo_ins` (0027) exige `socio`/`contador` -- `administrativo` NUNCA puede crear un cierre,
// así que los escenarios que actúan como `administrativoA` necesitan un cierre YA EXISTENTE.
function crearCierreComo(usuarioCreador: string, periodo: string): Promise<string> {
  return comoUsuario(usuarioCreador, (ej) => crearCierre(ej, periodo));
}

// =============================================================================
// A — legítimo: un pendiente nace 'abierto', columnas de resolución en null
// =============================================================================
describe('0046 A — pendiente_cierre_ins: nacimiento legítimo', () => {
  it('A.1 legítimo: columnas de resolución OMITIDAS (caso real de escribirPendienteDeImputacion) — pendiente_estado default abierto', async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2031-01-01');
    await comoUsuario(USUARIOS.administrativoA, async (ej) => {
      const fila = await una(
        ej,
        `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo)
         values ($1, $2, 'documento_faltante')
         returning pendiente_estado as "pendienteEstado", resuelto_por::text as "resueltoPor",
                   resuelto_en as "resueltoEn", resolucion_id::text as "resolucionId",
                   superseded_by_id::text as "supersededById"`,
        [s.clienteA, cierreId],
      );
      expect(fila['pendienteEstado']).toBe('abierto');
      expect(fila['resueltoPor']).toBeNull();
      expect(fila['resueltoEn']).toBeNull();
      expect(fila['resolucionId']).toBeNull();
      expect(fila['supersededById']).toBeNull();
    });
  });

  it('A.2 legítimo: columnas de resolución EXPLÍCITAS pero en null — demuestra que las 5 columnas son grantables antes de atacar con ellas', async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2031-01-08');
    await comoUsuario(USUARIOS.administrativoA, async (ej) => {
      const fila = await una(
        ej,
        `insert into pendiente_cierre
           (cliente_id, cierre_id, motivo_codigo, pendiente_estado, resuelto_por, resuelto_en,
            resolucion_id, superseded_by_id)
         values ($1, $2, 'documento_faltante', 'abierto', null, null, null, null)
         returning pendiente_estado as "pendienteEstado"`,
        [s.clienteA, cierreId],
      );
      expect(fila['pendienteEstado']).toBe('abierto');
    });
  });
});

// =============================================================================
// B — ATAQUE: nacer ya 'dispensado' — el hallazgo real, con y sin autoría forjada
// =============================================================================
describe('0046 B — pendiente_cierre_ins: nacer ya dispensado, con cualquier rol', () => {
  it("B.1 ATAQUE: administrativo inserta 'dispensado' con resuelto_por de un tercero (el hallazgo original) — muere por RLS", async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2031-02-01');
    const error = await capturar(() =>
      comoUsuario(USUARIOS.administrativoA, async (ej) =>
        ej(
          `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado, resuelto_por, resuelto_en)
           values ($1, $2, 'documento_faltante', 'dispensado', $3, now())`,
          [s.clienteA, cierreId, USUARIOS.contadorA],
        ),
      ),
    );
    esperarRechazoRls(
      error,
      "administrativo insertando un pendiente ya 'dispensado' con resuelto_por de un tercero tiene " +
        'que morir -- es exactamente el bypass de rol (pendiente_cierre_upd_dispensa) + autoría (R44) ' +
        'que motivó esta migración',
    );
  });

  it("B.2 ATAQUE: administrativo inserta 'dispensado' SIN forjar autoría (resuelto_por/resuelto_en en null) -- el caso que cerrar SOLO resuelto_por/resuelto_en no habría bloqueado", async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2031-02-08');
    const error = await capturar(() =>
      comoUsuario(USUARIOS.administrativoA, async (ej) =>
        ej(
          `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
           values ($1, $2, 'documento_faltante', 'dispensado')`,
          [s.clienteA, cierreId],
        ),
      ),
    );
    esperarRechazoRls(
      error,
      "un pendiente_estado = 'dispensado' al nacer, aunque resuelto_por/resuelto_en queden en null, " +
        'tiene que morir igual -- sigue siendo un administrativo dispensando por INSERT lo que ' +
        '0045 le prohíbe por UPDATE, sin dejar pendiente_dispensa ni pasar por el gate de D-24',
    );
  });

  it("B.3 ATAQUE: socio (SÍ autorizado a dispensar por UPDATE) tampoco puede nacer un pendiente ya 'dispensado' por INSERT", async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2031-02-15');
    const error = await capturar(() =>
      comoUsuario(USUARIOS.socio, async (ej) =>
        ej(
          `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado, resuelto_por, resuelto_en)
           values ($1, $2, 'documento_faltante', 'dispensado', $3, now())`,
          [s.clienteA, cierreId, USUARIOS.socio],
        ),
      ),
    );
    esperarRechazoRls(
      error,
      'ni el rol MÁS amplio (socio, autorizado a dispensar por UPDATE) puede saltarse el nacimiento ' +
        "'abierto' -- el invariante es sobre el CAMINO (INSERT vs. UPDATE), no sobre quién lo ejecuta",
    );
  });
});

// =============================================================================
// C — ATAQUE: colar resolución/supersesión al nacer, sin tocar pendiente_estado/resuelto_por
// =============================================================================
describe('0046 C — pendiente_cierre_ins: resolucion_id/superseded_by_id al nacer', () => {
  it('C.1 ATAQUE: resolucion_id seteado al nacer (estado abierto, sin autoría forjada) muere por RLS', async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2031-03-01');
    const error = await capturar(() =>
      comoUsuario(USUARIOS.administrativoA, async (ej) =>
        ej(
          `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado, resolucion_id)
           values ($1, $2, 'documento_faltante', 'abierto', gen_random_uuid())`,
          [s.clienteA, cierreId],
        ),
      ),
    );
    esperarRechazoRls(
      error,
      'un pendiente recién nacido no puede citar su propia resolución -- resolucion_id tiene que ' +
        'quedar en null al INSERT, sea cual sea pendiente_estado',
    );
  });

  it('C.2 ATAQUE: superseded_by_id apuntando a una fila real (FK satisfecha, diferida) muere por RLS, no por FK', async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2031-03-08');
    const error = await capturar(() =>
      comoUsuario(USUARIOS.administrativoA, async (ej) => {
        const otra = await una(
          ej,
          `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo)
           values ($1, $2, 'documento_faltante') returning id::text as id`,
          [s.clienteA, cierreId],
        );
        return ej(
          `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado, superseded_by_id)
           values ($1, $2, 'documento_faltante', 'abierto', $3)`,
          [s.clienteA, cierreId, otra['id']],
        );
      }),
    );
    esperarRechazoRls(
      error,
      'una fila recién insertada no puede nacer ya superseded_by_id apuntando a otra fila real -- eso ' +
        'demuestra que el rechazo es por la policy nueva, no por la FK (que acá SÍ estaría satisfecha)',
    );
  });
});
