/**
 * MUTACIONES de `0045_usuario_identidad_capacidades_r44.sql` — prueba por mutación de R44: toda
 * columna de autoría (`*_por`) en una policy `UPDATE`/`INSERT` tiene que estar atada a
 * `app.current_user_id()`, la identidad REAL de la sesión, nunca a un valor declarado en el payload.
 *
 * Alcance de esta batería: SOLO R44 (las 7 policies que `0045` tocó). La inmutabilidad post-terminal
 * (el trigger de `0028`, "ningún campo cambia una vez terminal") ya tiene su propia batería en
 * `mutaciones-0028-inmutabilidad-post-terminal.test.ts` — ese archivo también ganó, en esta misma
 * convocatoria, los mellizos `(R44)` de M-A1/M-A2/M-C1 que aíslan el aporte de R44 con el trigger
 * apagado. No se repite acá.
 *
 * `usuario_identidad`/`has_capacidad_en`/el alcance ampliado de `accessible_tenant_ids()`/
 * `has_role_on()` tienen su propia cobertura, separada (fuera de esta pasada — R44 es el foco).
 *
 * ## Las 7 policies tocadas por R44, y por qué DOS de ellas no estaban en el plan original
 *
 * `cierre_periodo_upd_cierre`, `pendiente_cierre_upd_general`, `pendiente_cierre_upd_dispensa`,
 * `confirmacion_grupo_ins`, `asiento_propuesto_upd_confirmar` estaban en el plan aprobado. Dos MÁS se
 * agregaron por una corrección posterior de `security-engineer` + `arquitecto-software`, en paralelo:
 * `cierre_periodo_upd_operativo` y `asiento_propuesto_upd_general` son las policies HERMANAS, más
 * anchas (incluyen `administrativo`), de dos de las anteriores — y sus `with_check` originales (0027)
 * no restringían la columna de autoría en absoluto. Como las policies permisivas del mismo comando se
 * combinan por `OR`, esa hermana sin check era una ruta de bypass COMPLETA, aunque la otra policy ya
 * estuviera bien cerrada. El eje "aislamiento" de esas dos, abajo, es el que reproduce EXACTAMENTE ese
 * agujero (payload ajeno colado junto con una transición operativa/no-confirmatoria).
 *
 * ## Los dos ejes, por cada policy
 *
 * 1. **Autoría**: el mismo UPDATE/INSERT que el caso legítimo, con la columna de autoría apuntando a
 *    un uuid AJENO (`USUARIOS.contadorA` u otro, según quién actúa) — tiene que morir por RLS.
 * 2. **Aislamiento**: la transición real sigue funcionando cuando la columna de autoría es la propia
 *    identidad de sesión (o queda sin tocar, en las policies condicionadas que no exigen la columna).
 *
 * ## Grant vs. RLS — cómo se descarta la ambigüedad de `42501` (CLAUDE.md, pedido explícito)
 *
 * Un `WITH CHECK` de RLS violado y un grant de columna faltante dan el MISMO `SQLSTATE 42501`. Cada
 * escenario de "autoría" de acá reutiliza EXACTAMENTE las mismas columnas que el escenario "aislamiento"
 * contiguo, que ya se probó exitoso — así que el grant está demostrado presente antes de atacar, y el
 * `42501` del ataque no puede ser por falta de privilegio. Además, `esperarRechazoRls()` verifica que el
 * mensaje real contenga "row-level security policy" (no solo el código), como segunda confirmación.
 *
 *                                                                          ─────────────────────
 *                                                                7 policies × 2 ejes = 14 `it()`
 *
 * Requisito previo: `0045` aplicada a local.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

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
 * Rechazo esperado por RLS (R44), no por grant: exige `42501` Y el texto real de Postgres para una
 * violación de `WITH CHECK` — así se descarta, sin ambigüedad, que el rechazo sea por columna no
 * grantable (ver nota de cabecera).
 */
function esperarRechazoRls(actual: ErrorPg, porque: string): void {
  expect(actual.code, porque).toBe('42501');
  expect(
    actual.message,
    `${porque} — y el mensaje tiene que ser el de una policy de RLS, no el de un grant de columna: "${actual.message}"`,
  ).toMatch(/row-level security policy/);
}

function comoUsuario<T>(usuarioId: string, fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(usuarioId, (tx) => fn(desdeTx(tx)));
}

let s: Sembrado;
const BANCO = 'banco_0045';

beforeAll(async () => {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de mutación de 0045 corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  s = await sembrar();
  // `banco` es catálogo N0 sin RLS/policy — app_request no tiene grants (0004, deliberado). Se siembra
  // con el dueño del esquema, mismo criterio que `mutaciones-0043-...test.ts`.
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ($1, 'BANCO DE PRUEBA 0045') on conflict do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }
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

// `cierre_periodo_ins` (0027) exige `socio`/`contador` -- `administrativo` NUNCA puede crear un cierre.
// Los escenarios de A.2/B.2 que actúan como `administrativoA` necesitan un cierre YA EXISTENTE, creado
// por alguien con permiso, para no confundir "no puede insertar el cierre" con lo que la policy
// `_upd_operativo`/`_upd_general` realmente restringe.
function crearCierreComo(usuarioCreador: string, periodo: string): Promise<string> {
  return comoUsuario(usuarioCreador, (ej) => crearCierre(ej, periodo));
}

// =============================================================================
// A — `cierre_cliente_periodo`
// =============================================================================
describe('0045 R44 A.1 — cierre_periodo_upd_cierre: confirmar', () => {
  it('aislamiento: confirmar con la PROPIA identidad de sesión funciona', async () => {
    await comoUsuario(USUARIOS.socio, async (ej) => {
      const cierreId = await crearCierre(ej, '2030-01-01');
      const fila = await una(
        ej,
        `update cierre_cliente_periodo
           set cierre_estado = 'confirmado', confirmado_en = now(), confirmado_por = $2
         where cliente_id = $1 and id = $3
         returning confirmado_por::text as "confirmadoPor"`,
        [s.clienteA, USUARIOS.socio, cierreId],
      );
      expect(fila['confirmadoPor']).toBe(USUARIOS.socio);
    });
  });

  it('autoría: confirmar atribuyéndolo a un tercero (mismo UPDATE que el caso legítimo, columna que ya se probó grantable) muere por RLS', async () => {
    const error = await capturar(() =>
      comoUsuario(USUARIOS.socio, async (ej) => {
        const cierreId = await crearCierre(ej, '2030-01-15');
        return ej(
          `update cierre_cliente_periodo
             set cierre_estado = 'confirmado', confirmado_en = now(), confirmado_por = $2
           where cliente_id = $1 and id = $3`,
          [s.clienteA, USUARIOS.contadorA, cierreId],
        );
      }),
    );
    esperarRechazoRls(
      error,
      'confirmado_por = un uuid ajeno (USUARIOS.contadorA) tiene que morir, aunque quien ejecuta ' +
        '(USUARIOS.socio) tenga el rol correcto para confirmar',
    );
  });
});

describe('0045 R44 A.2 — cierre_periodo_upd_operativo: el agujero real que cerró la corrección posterior', () => {
  it('aislamiento: una transición operativa que no toca confirmado_por funciona (columna queda en null)', async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2030-02-01');
    await comoUsuario(USUARIOS.administrativoA, async (ej) => {
      const fila = await una(
        ej,
        `update cierre_cliente_periodo set cierre_estado = 'en_ingesta'
         where cliente_id = $1 and id = $2
         returning cierre_estado as "cierreEstado", confirmado_por::text as "confirmadoPor"`,
        [s.clienteA, cierreId],
      );
      expect(fila['cierreEstado']).toBe('en_ingesta');
      expect(fila['confirmadoPor']).toBeNull();
    });
  });

  it('autoría: colar confirmado_por = un tercero JUNTO con una transición operativa (fila NO terminal) muere por RLS — el agujero que encontró security-engineer + arquitecto-software', async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2030-02-15');
    const error = await capturar(() =>
      comoUsuario(USUARIOS.administrativoA, async (ej) => {
        // La fila NUNCA llega a terminal (queda en 'en_ingesta') -- el trigger de 0028 no la alcanza.
        // Antes de la corrección, cierre_periodo_upd_operativo no restringía confirmado_por en su
        // propio with_check, así que este UPDATE pasaba entero por el OR entre policies permisivas.
        return ej(
          `update cierre_cliente_periodo set cierre_estado = 'en_ingesta', confirmado_por = $2
           where cliente_id = $1 and id = $3`,
          [s.clienteA, USUARIOS.contadorA, cierreId],
        );
      }),
    );
    esperarRechazoRls(
      error,
      'confirmado_por = un tercero, colado junto con una transición NO terminal, tiene que morir por ' +
        'RLS -- si esto pasara, un administrativo podría preatribuir una confirmación futura a ' +
        'cualquier persona antes de que la fila llegue a terminal',
    );
  });
});

// =============================================================================
// B — `asiento_propuesto`
// =============================================================================
describe('0045 R44 B.1 — asiento_propuesto_upd_confirmar: confirmar', () => {
  async function crearAsiento(ej: Ejecutar, fecha: string): Promise<string> {
    const cierreId = await crearCierre(ej, fecha);
    const a = await una(
      ej,
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', $3) returning id::text as id`,
      [s.clienteA, cierreId, fecha],
    );
    return String(a['id']);
  }

  it('aislamiento: confirmar con la PROPIA identidad de sesión funciona', async () => {
    await comoUsuario(USUARIOS.contadorA, async (ej) => {
      const asientoId = await crearAsiento(ej, '2030-03-01');
      const fila = await una(
        ej,
        `update asiento_propuesto
           set asiento_estado = 'confirmado', confirmado_por = $2, confirmado_en = now()
         where cliente_id = $1 and id = $3
         returning confirmado_por::text as "confirmadoPor"`,
        [s.clienteA, USUARIOS.contadorA, asientoId],
      );
      expect(fila['confirmadoPor']).toBe(USUARIOS.contadorA);
    });
  });

  it('autoría: confirmar atribuyéndolo a un tercero (mismas columnas que el caso legítimo) muere por RLS', async () => {
    const error = await capturar(() =>
      comoUsuario(USUARIOS.contadorA, async (ej) => {
        const asientoId = await crearAsiento(ej, '2030-03-08');
        return ej(
          `update asiento_propuesto
             set asiento_estado = 'confirmado', confirmado_por = $2, confirmado_en = now()
           where cliente_id = $1 and id = $3`,
          [s.clienteA, USUARIOS.socio, asientoId],
        );
      }),
    );
    esperarRechazoRls(
      error,
      'confirmado_por = un uuid ajeno (USUARIOS.socio) tiene que morir, aunque USUARIOS.contadorA ' +
        'tenga rol de sobra para confirmar',
    );
  });
});

describe('0045 R44 B.2 — asiento_propuesto_upd_general: el agujero real (hermana de B.1)', () => {
  // `asiento_propuesto_ins` (0027) sí admite `administrativo` -- pero `cierre_periodo_ins` NO, así que
  // el cierre tiene que existir de antes (creado por `socio`/`contador`), igual que en A.2.
  async function crearAsientoASuperseder(
    ej: Ejecutar,
    cierreId: string,
    fecha: string,
  ): Promise<{ viejoId: string; nuevoId: string }> {
    const viejo = await una(
      ej,
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', $3) returning id::text as id`,
      [s.clienteA, cierreId, fecha],
    );
    const nuevo = await una(
      ej,
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', $3) returning id::text as id`,
      [s.clienteA, cierreId, fecha],
    );
    return { viejoId: String(viejo['id']), nuevoId: String(nuevo['id']) };
  }

  it('aislamiento: superseder (destino <> confirmado) sin tocar confirmado_por funciona', async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2030-04-01');
    await comoUsuario(USUARIOS.administrativoA, async (ej) => {
      const { viejoId, nuevoId } = await crearAsientoASuperseder(ej, cierreId, '2030-04-01');
      const fila = await una(
        ej,
        `update asiento_propuesto set asiento_estado = 'superseded', superseded_by_id = $3
         where cliente_id = $1 and id = $2
         returning asiento_estado as "asientoEstado", confirmado_por::text as "confirmadoPor"`,
        [s.clienteA, viejoId, nuevoId],
      );
      expect(fila['asientoEstado']).toBe('superseded');
      expect(fila['confirmadoPor']).toBeNull();
    });
  });

  it('autoría: colar confirmado_por = un tercero JUNTO con la supersesión (destino <> confirmado) muere por RLS — el agujero que encontró security-engineer + arquitecto-software', async () => {
    const cierreId = await crearCierreComo(USUARIOS.socio, '2030-04-08');
    const error = await capturar(() =>
      comoUsuario(USUARIOS.administrativoA, async (ej) => {
        const { viejoId, nuevoId } = await crearAsientoASuperseder(ej, cierreId, '2030-04-08');
        // asiento_estado nunca pasa por 'confirmado' -- with_check de asiento_propuesto_upd_general
        // original (0027) sólo excluía ese destino, sin tocar confirmado_por. Antes de la corrección,
        // un administrativo podía preatribuir la confirmación de OTRO asiento futuro acá.
        return ej(
          `update asiento_propuesto
             set asiento_estado = 'superseded', superseded_by_id = $3, confirmado_por = $4
           where cliente_id = $1 and id = $2`,
          [s.clienteA, viejoId, nuevoId, USUARIOS.contadorA],
        );
      }),
    );
    esperarRechazoRls(
      error,
      'confirmado_por = un tercero, colado junto con una supersesión (nunca pasa por confirmado), ' +
        'tiene que morir por RLS -- administrativo no debería poder preatribuir una confirmación',
    );
  });
});

// =============================================================================
// C — `pendiente_cierre`
// =============================================================================
describe('0045 R44 C.1 — pendiente_cierre_upd_general: resolver', () => {
  async function crearPendiente(ej: Ejecutar, periodo: string): Promise<string> {
    const cierreId = await crearCierre(ej, periodo);
    const p = await una(
      ej,
      `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
       values ($1, $2, 'documento_faltante', 'abierto') returning id::text as id`,
      [s.clienteA, cierreId],
    );
    return String(p['id']);
  }

  it('aislamiento: resolver con la PROPIA identidad de sesión funciona', async () => {
    await comoUsuario(USUARIOS.contadorA, async (ej) => {
      const pendienteId = await crearPendiente(ej, '2030-05-01');
      const fila = await una(
        ej,
        `update pendiente_cierre
           set pendiente_estado = 'resuelto', resuelto_por = $2, resuelto_en = now()
         where cliente_id = $1 and id = $3
         returning resuelto_por::text as "resueltoPor"`,
        [s.clienteA, USUARIOS.contadorA, pendienteId],
      );
      expect(fila['resueltoPor']).toBe(USUARIOS.contadorA);
    });
  });

  it('autoría: resolver atribuyéndolo a un tercero (mismas columnas que el caso legítimo) muere por RLS', async () => {
    const error = await capturar(() =>
      comoUsuario(USUARIOS.contadorA, async (ej) => {
        const pendienteId = await crearPendiente(ej, '2030-05-08');
        return ej(
          `update pendiente_cierre
             set pendiente_estado = 'resuelto', resuelto_por = $2, resuelto_en = now()
           where cliente_id = $1 and id = $3`,
          [s.clienteA, USUARIOS.socio, pendienteId],
        );
      }),
    );
    esperarRechazoRls(
      error,
      'resuelto_por = un uuid ajeno (USUARIOS.socio) tiene que morir, aunque USUARIOS.contadorA tenga ' +
        'rol de sobra para resolver',
    );
  });
});

describe('0045 R44 C.2 — pendiente_cierre_upd_dispensa: dispensar', () => {
  async function crearPendiente(ej: Ejecutar, periodo: string): Promise<string> {
    const cierreId = await crearCierre(ej, periodo);
    const p = await una(
      ej,
      `insert into pendiente_cierre (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
       values ($1, $2, 'documento_faltante', 'abierto') returning id::text as id`,
      [s.clienteA, cierreId],
    );
    return String(p['id']);
  }

  it('aislamiento: dispensar con la PROPIA identidad de sesión funciona', async () => {
    await comoUsuario(USUARIOS.socio, async (ej) => {
      const pendienteId = await crearPendiente(ej, '2030-06-01');
      const fila = await una(
        ej,
        `update pendiente_cierre
           set pendiente_estado = 'dispensado', resuelto_por = $2, resuelto_en = now()
         where cliente_id = $1 and id = $3
         returning resuelto_por::text as "resueltoPor"`,
        [s.clienteA, USUARIOS.socio, pendienteId],
      );
      expect(fila['resueltoPor']).toBe(USUARIOS.socio);
    });
  });

  it('autoría: dispensar atribuyéndolo a un tercero (mismas columnas que el caso legítimo) muere por RLS', async () => {
    const error = await capturar(() =>
      comoUsuario(USUARIOS.socio, async (ej) => {
        const pendienteId = await crearPendiente(ej, '2030-06-08');
        return ej(
          `update pendiente_cierre
             set pendiente_estado = 'dispensado', resuelto_por = $2, resuelto_en = now()
           where cliente_id = $1 and id = $3`,
          [s.clienteA, USUARIOS.contadorA, pendienteId],
        );
      }),
    );
    esperarRechazoRls(
      error,
      'resuelto_por = un uuid ajeno (USUARIOS.contadorA) tiene que morir, aunque USUARIOS.socio tenga ' +
        'rol de sobra para dispensar',
    );
  });
});

// =============================================================================
// D — `confirmacion_grupo_ins` (INSERT puro, igualdad ciega)
// =============================================================================
describe('0045 R44 D — confirmacion_grupo_ins', () => {
  async function crearCuenta(ej: Ejecutar): Promise<string> {
    const f = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [s.clienteA]);
    return String(f['id']);
  }

  it('aislamiento: insertar con la PROPIA identidad de sesión funciona', async () => {
    await comoUsuario(USUARIOS.socio, async (ej) => {
      const cuentaId = await crearCuenta(ej);
      const fila = await una(
        ej,
        `insert into confirmacion_grupo (cliente_id, banco_codigo, concepto_banco, cuenta_id, respaldo, confirmado_por)
         values ($1, $2, 'concepto d1 legitimo', $3, 'respaldo de prueba valido', $4)
         returning confirmado_por::text as "confirmadoPor"`,
        [s.clienteA, BANCO, cuentaId, USUARIOS.socio],
      );
      expect(fila['confirmadoPor']).toBe(USUARIOS.socio);
    });
  });

  it('autoría: insertar atribuyéndolo a un tercero (mismas columnas que el caso legítimo) muere por RLS', async () => {
    const error = await capturar(() =>
      comoUsuario(USUARIOS.socio, async (ej) => {
        const cuentaId = await crearCuenta(ej);
        return ej(
          `insert into confirmacion_grupo (cliente_id, banco_codigo, concepto_banco, cuenta_id, respaldo, confirmado_por)
           values ($1, $2, 'concepto d2 ataque', $3, 'respaldo de prueba valido', $4)`,
          [s.clienteA, BANCO, cuentaId, USUARIOS.contadorA],
        );
      }),
    );
    esperarRechazoRls(
      error,
      'confirmado_por = un uuid ajeno (USUARIOS.contadorA) tiene que morir -- sin este check, un ' +
        'request de browser podría atribuir la confirmación a otra persona (ADR-0006 §7.bis)',
    );
  });
});
