/**
 * MUTACIONES de `0048_correlativo_asiento_propuesto.sql` — prueba por mutación de los CUATRO
 * mecanismos NUEVOS que esta migración agrega (CLAUDE.md §1.8, ADR-0002 §B.0): mutaciones elegidas
 * para REFUTAR, no para confirmar.
 *
 *   A. `uq_asiento_propuesto_numero` — dos asientos del MISMO cliente no pueden terminar con el
 *      mismo `numero_correlativo`; SÍ pueden coincidir entre clientes DISTINTOS (unicidad por
 *      cliente, nunca global — R25, ver comentario de la migración sobre `numero_correlativo`).
 *        A.1 legítimo: insertar con numero_correlativo=7 entra ................... legítimo
 *        A.2 🔴 ATAQUE: un segundo asiento del MISMO cliente con numero_correlativo=7 muere 23505
 *            sobre `uq_asiento_propuesto_numero` ................................. mutación
 *        A.3 control negativo: el MISMO numero_correlativo=7, cliente DISTINTO, entra sin chocar ... legítimo
 *
 *   B. `fk_asiento_renglon_movimiento` — FK compuesta tenant-safe: un `movimiento_bancario_id` de
 *      OTRO cliente, o uno inexistente, mueren por integridad referencial (23503), nunca se cuelan.
 *        B.1 legítimo: citar un movimiento REAL del MISMO cliente entra .......... legítimo
 *        B.2 🔴 ATAQUE (cross-tenant): citar el movimiento REAL de OTRO cliente, bajo el cliente_id
 *            propio, muere 23503 sobre `fk_asiento_renglon_movimiento` ............ mutación
 *        B.3 🔴 ATAQUE (referencia inventada): citar un uuid que no existe en
 *            `movimiento_bancario_crudo` muere con el mismo 23503 ................. mutación
 *
 *   C. `grant insert (cliente_id)` de `asiento_correlativo_cliente` — columna ACOTADA, no tabla
 *      completa (hallazgo de `security-engineer`, ver cabecera de `0048`): `app_request` no puede
 *      insertar un `siguiente_numero` explícito, sea cual sea el valor.
 *        C.1 legítimo: insertar solo `(cliente_id)` entra, `siguiente_numero` toma su default 1 ... legítimo
 *        C.2 🔴 ATAQUE: insertar `(cliente_id, siguiente_numero)` con un valor explícito muere
 *            42501 de ACL — nunca de RLS (el mensaje NO es el de una policy) ....... mutación
 *
 *   D. La policy de UPDATE (`asiento_correlativo_cliente_upd`, el "renglón 6-bis" de la migración)
 *      restringe la transición a `socio`/`contador` — un `administrativo` no puede tocar el
 *      contador, aunque tenga acceso de tenant a la fila.
 *        D.1 legítimo: `socio` actualiza `siguiente_numero` de su propio cliente, entra .. legítimo
 *        D.2 🔴 MUTACIÓN DE ESQUEMA, EN VIVO: con la policy MUTADA (sin el `has_role_on`, solo el
 *            predicado de tenant), un `administrativo` SÍ logra actualizar el contador —
 *            la vulnerabilidad que la policy real existe para cerrar ................ mutación
 *        D.3 el mecanismo REAL restaurado: el MISMO intento de `administrativo` afecta 0 filas,
 *            sin error — RLS con conjunto vacío de policies aplicables es DENY silencioso, mismo
 *            hallazgo que motivó agregar esta policy en primer lugar (ver cabecera de `0048`) ... legítimo
 *
 *   E. El TRIGGER `trg_asiento_propuesto_correlativo` / `app.asignar_numero_correlativo_asiento()` —
 *      NINGUNO de los bloques A-D lo ejercita: todos escriben `numero_correlativo` o la fila de
 *      `asiento_correlativo_cliente` DIRECTO por SQL, nunca a través de la transición real
 *      `propuesto→confirmado`. Sin este bloque, vaciar el cuerpo del trigger (o borrarlo entero)
 *      habría dejado los 11 `it` de A-D en verde igual — la mutación con más impacto real posible,
 *      elegida acá para refutar eso puntualmente.
 *        E.1 legítimo: confirmar el PRIMER asiento de un cliente RECIÉN CREADO (sin fila previa en
 *            `asiento_correlativo_cliente`: no hay backfill para un cliente que nace después de que
 *            `0048` ya se aplicó) autoprovisiona la fila y asigna numero_correlativo=1 .... legítimo
 *        E.2 control: confirmar un SEGUNDO asiento del mismo cliente asigna numero_correlativo=2,
 *            nunca reasigna 1 ................................................................. legítimo
 *        E.3 🔴 ATAQUE, mutación EN VIVO: el trigger SIN el `insert ... on conflict do nothing` de
 *            autoprovisión — confirmar el primer asiento de un cliente RECIÉN CREADO (fila
 *            inexistente, ninguna tarea de alta la creó) muere P0006 en vez de asignar 1: la línea
 *            de autoprovisión es la única razón por la que un cliente nuevo funciona sin un alta
 *            previa ........................................................................... mutación
 *
 *   F. CONCURRENCIA real del `for update` del trigger — la cabecera de `0048` documenta haberla
 *      verificado A MANO con dos conexiones y `pg_sleep` (sección final del archivo), pero eso no es
 *      un test automatizado. Acá queda automatizado, dos conexiones reales, mismo método que
 *      `mutaciones-0041.test.ts` (M1/L2): variantes del trigger con el MISMO `pg_sleep` en el mismo
 *      punto relativo, sólo cambia si el `select siguiente_numero` toma `for update` o no.
 *        F.1 🔴 ATAQUE, mutación EN VIVO: el trigger SIN `for update` en el `select` — dos
 *            confirmaciones concurrentes del MISMO cliente (asientos DISTINTOS) leen el MISMO
 *            `siguiente_numero` ANTES de que cualquiera incremente: la primera confirma con
 *            numero=1 y la SEGUNDA, con el mismo número YA calculado, muere 23505 contra
 *            `uq_asiento_propuesto_numero` de la sección A al intentar escribirlo — la unicidad de
 *            A es lo único que evita el peor desenlace (un folio duplicado silencioso); la
 *            concurrencia en sí YA está rota sin `for update`, aunque A la contenga ........ mutación
 *        F.2 el mecanismo REAL (`for update`, mismo `pg_sleep` en el mismo punto): la segunda
 *            confirmación queda BLOQUEADA hasta que la primera libera el lock, relee el contador YA
 *            incrementado, y las dos terminan con números DISTINTOS (1 y 2) — la carrera no se cuela
 *            ................................................................................ legítimo
 *                                                                              ─────────────────────
 *                                                                              7 mutaciones, 9 legítimos, 16 `it`
 *
 * Cada bloque usa un cliente SINTÉTICO PROPIO (creado bajo `s.estudio`, heredando el acceso de
 * `socio` por jerarquía de `path`) para no interferir con `s.clienteA`/`s.clienteB` de otras suites
 * ni entre sí — mismo criterio que `clienteFresco()` de `agrupar-decisiones-pendientes.test.ts`.
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`, con `0048` APLICADA.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

// -----------------------------------------------------------------------------
// Andamio mínimo — mismo estilo que `mutaciones-0041.test.ts`/`mutaciones-0042.test.ts`, duplicado a
// propósito (conteo de mutaciones propio, no compartido).
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

type ErrorPg = { readonly code: string; readonly constraint: string | null; readonly message: string };
const SIN_ERROR: ErrorPg = { code: '', constraint: null, message: '(no falló)' };

async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return SIN_ERROR;
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string };
    return { code: err.code ?? '(sin code)', constraint: err.constraint ?? null, message: err.message ?? String(e) };
  }
}

/** Rechazo esperado por ACL de grant de COLUMNA (0048, sección 1), no por RLS: mismo `42501` que una
 *  violación de `WITH CHECK`, pero el mensaje de Postgres para un grant de columna faltante NUNCA
 *  menciona "row-level security policy" — mismo criterio de desambiguación (invertido) que
 *  `esperarRechazoRls()` de `mutaciones-0045-...test.ts`/`mutaciones-0046-...test.ts`. */
function esperarRechazoDeGrant(actual: ErrorPg, porque: string): void {
  expect(actual.code, porque).toBe('42501');
  expect(
    actual.message,
    `${porque} — y el mensaje NO tiene que ser el de una policy de RLS (eso confundiría "sin grant" ` +
      `con "RLS lo bloqueó"): "${actual.message}"`,
  ).not.toMatch(/row-level security policy/);
}

function comoUsuario<T>(usuarioId: string, fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(usuarioId, (tx) => fn(desdeTx(tx)));
}

let s: Sembrado;

beforeAll(async () => {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de mutación de 0048 corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
// Fixtures compartidos: un cliente sintético NUEVO por escenario, bajo `s.estudio` (herencia de
// `socio` por jerarquía de `path` — no hace falta membresía explícita para él).
// -----------------------------------------------------------------------------

let nodoSeq = 0;
async function clienteFresco(etiqueta: string): Promise<string> {
  nodoSeq += 1;
  const duenio = await clienteDuenio();
  try {
    const f = await duenio.query<{ id: string }>(
      `insert into tenant_node (tipo, nombre, parent_id) values ('cliente', $1, $2) returning id`,
      [`MUT0048 ${etiqueta} ${nodoSeq}`, s.estudio],
    );
    const id = f.rows[0]?.id;
    if (!id) throw new Error('no se pudo crear el cliente fresco');
    return id;
  } finally {
    await duenio.end();
  }
}

async function otorgarMembresia(clienteId: string, userId: string, rol: string): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(`insert into membership (user_id, tenant_node_id, rol) values ($1, $2, $3::app.rol_membership)`, [
      userId,
      clienteId,
      rol,
    ]);
  } finally {
    await duenio.end();
  }
}

let periodoSeq = 0;
async function crearCierre(ej: Ejecutar, clienteId: string): Promise<string> {
  periodoSeq += 1;
  const mes = String(1 + (periodoSeq % 12)).padStart(2, '0');
  const anio = 2033 + Math.floor(periodoSeq / 12);
  const desde = `${anio}-${mes}-01`;
  const f = await una(
    ej,
    `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
     values ($1, 'mensual', $2::date, ($2::date + interval '1 month - 1 day')::date)
     returning id::text as id`,
    [clienteId, desde],
  );
  return String(f['id']);
}

async function crearAsientoPropuesto(
  ej: Ejecutar,
  args: { readonly clienteId: string; readonly cierreId: string; readonly numeroCorrelativo?: number },
): Promise<string> {
  const f = await una(
    ej,
    `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion, numero_correlativo)
     values ($1, $2, 'devengamiento', '2033-06-15'::date, $3)
     returning id::text as id`,
    [args.clienteId, args.cierreId, args.numeroCorrelativo ?? null],
  );
  return String(f['id']);
}

const BANCO = 'banco_mut_0048';
let filaSeq = 0;

/** Un movimiento bancario REAL para `clienteId` — la única forma legítima de satisfacer la FK
 *  compuesta de la sección B. */
async function crearMovimiento(clienteId: string): Promise<string> {
  filaSeq += 1;
  return comoUsuario(USUARIOS.socio, async (ej) => {
    const cuenta = await una(
      ej,
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, $2, 'ARS') returning id::text as id`,
      [clienteId, BANCO],
    );
    const lote = await una(
      ej,
      `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
       values ($1, $2, 'prueba-mut-0048', 'archivo', $3, 'recibido', true)
       returning id::text as id`,
      [clienteId, BANCO, `hash_mut_0048_${randomUUID()}`],
    );
    await ej(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, '2033-06-01', '2033-06-30', 'no_verificable')`,
      [clienteId, String(lote['id']), String(cuenta['id'])],
    );
    const mov = await una(
      ej,
      `insert into movimiento_bancario_crudo
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
          concepto_banco, concepto_banco_estrategia, concepto_completo, importe, contraparte_captura)
       values ($1, $2, $3, $4, $5, '2033-06-15'::date, 'GLOSA MUT 0048', 'CONCEPTO', 'columna_propia',
               true, '-100.00'::numeric, 'no_capturado')
       returning id::text as id`,
      [clienteId, String(lote['id']), String(cuenta['id']), filaSeq, randomUUID()],
    );
    return String(mov['id']);
  });
}

beforeAll(async () => {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      BANCO,
      'BANCO MUT 0048',
    ]);
  } finally {
    await duenio.end();
  }
});

// =============================================================================
// A — `uq_asiento_propuesto_numero`: unicidad POR CLIENTE, nunca global
// =============================================================================
describe('0048 A — uq_asiento_propuesto_numero: mismo cliente colisiona, cliente distinto no', () => {
  it('A.1 legítimo: insertar un asiento con numero_correlativo=7 entra', async () => {
    const clienteX = await clienteFresco('A-X');
    await comoUsuario(USUARIOS.socio, async (ej) => {
      const cierreX = await crearCierre(ej, clienteX);
      const id = await crearAsientoPropuesto(ej, { clienteId: clienteX, cierreId: cierreX, numeroCorrelativo: 7 });
      expect(id, 'el primer asiento con numero_correlativo=7 tiene que entrar').toBeTruthy();
    });
  });

  it('A.2 🔴 ATAQUE: un segundo asiento del MISMO cliente con numero_correlativo=7 muere 23505', async () => {
    const clienteX = await clienteFresco('A-X');
    await comoUsuario(USUARIOS.socio, async (ej) => {
      const cierreX = await crearCierre(ej, clienteX);
      await crearAsientoPropuesto(ej, { clienteId: clienteX, cierreId: cierreX, numeroCorrelativo: 7 });

      const error = await capturar(() => crearAsientoPropuesto(ej, { clienteId: clienteX, cierreId: cierreX, numeroCorrelativo: 7 }));
      expect(error.code, 'un segundo asiento del MISMO cliente con el MISMO folio tiene que morir').toBe('23505');
      expect(error.constraint, 'sobre el índice de unicidad de 0048').toBe('uq_asiento_propuesto_numero');
    });
  });

  it('A.3 control negativo: el MISMO numero_correlativo, en un cliente DISTINTO, entra sin chocar (R25: unicidad por cliente, nunca global)', async () => {
    const clienteX = await clienteFresco('A-X');
    const clienteY = await clienteFresco('A-Y');
    await comoUsuario(USUARIOS.socio, async (ej) => {
      const cierreX = await crearCierre(ej, clienteX);
      await crearAsientoPropuesto(ej, { clienteId: clienteX, cierreId: cierreX, numeroCorrelativo: 7 });

      const cierreY = await crearCierre(ej, clienteY);
      const idY = await crearAsientoPropuesto(ej, { clienteId: clienteY, cierreId: cierreY, numeroCorrelativo: 7 });
      expect(idY, 'el mismo folio 7, en OTRO cliente, tiene que entrar: la unicidad es por cliente').toBeTruthy();
    });
  });
});

// =============================================================================
// B — `fk_asiento_renglon_movimiento`: FK compuesta tenant-safe
// =============================================================================
describe('0048 B — fk_asiento_renglon_movimiento: cross-tenant e inexistente mueren, el real entra', () => {
  async function prepararAsiento(clienteId: string): Promise<{ readonly asientoId: string; readonly cuentaId: string }> {
    return comoUsuario(USUARIOS.socio, async (ej) => {
      const cierreId = await crearCierre(ej, clienteId);
      const asientoId = await crearAsientoPropuesto(ej, { clienteId, cierreId });
      const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [clienteId]);
      return { asientoId, cuentaId: String(cuenta['id']) };
    });
  }

  const cuentaRef = JSON.stringify({ codigo: '1.1.1', denominacion: 'BANCO MUT 0048', rolFuncional: 'generica' });

  async function insertarRenglon(args: {
    readonly clienteId: string;
    readonly asientoId: string;
    readonly cuentaId: string;
    readonly orden: number;
    readonly movimientoBancarioId: string;
  }): Promise<unknown> {
    return comoUsuario(USUARIOS.socio, (ej) =>
      ej(
        `insert into asiento_propuesto_renglon
           (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion, movimiento_bancario_id)
         values ($1, $2, $3, $4, $5::jsonb, 100.00, 0, '2033-06-15'::date, $6::uuid)`,
        [args.clienteId, args.asientoId, args.orden, args.cuentaId, cuentaRef, args.movimientoBancarioId],
      ),
    );
  }

  it('B.1 legítimo: citar un movimiento REAL del MISMO cliente entra', async () => {
    const clienteX = await clienteFresco('B-X');
    const movX = await crearMovimiento(clienteX);
    const { asientoId, cuentaId } = await prepararAsiento(clienteX);

    const error = await capturar(() =>
      insertarRenglon({ clienteId: clienteX, asientoId, cuentaId, orden: 1, movimientoBancarioId: movX }),
    );
    expect(error.code, 'citar el movimiento REAL del mismo cliente tiene que entrar').toBe('');
  });

  it('B.2 🔴 ATAQUE cross-tenant: citar el movimiento REAL de OTRO cliente, bajo el cliente_id propio, muere 23503', async () => {
    const clienteX = await clienteFresco('B-X');
    const clienteY = await clienteFresco('B-Y');
    const movY = await crearMovimiento(clienteY);
    const { asientoId, cuentaId } = await prepararAsiento(clienteX);

    const error = await capturar(() =>
      insertarRenglon({ clienteId: clienteX, asientoId, cuentaId, orden: 1, movimientoBancarioId: movY }),
    );
    expect(
      error.code,
      'un renglón de clienteX no puede citar el movimiento_bancario_id de clienteY: la FK compuesta ' +
        '(cliente_id, movimiento_bancario_id) no encuentra esa combinación',
    ).toBe('23503');
    expect(error.constraint, 'sobre la FK compuesta tenant-safe de 0048').toBe('fk_asiento_renglon_movimiento');
  });

  it('B.3 🔴 ATAQUE referencia inventada: un uuid que no existe en movimiento_bancario_crudo muere con el mismo 23503', async () => {
    const clienteX = await clienteFresco('B-X');
    const { asientoId, cuentaId } = await prepararAsiento(clienteX);

    const error = await capturar(() =>
      insertarRenglon({ clienteId: clienteX, asientoId, cuentaId, orden: 1, movimientoBancarioId: randomUUID() }),
    );
    expect(error.code, 'un movimiento_bancario_id que no existe para NINGÚN cliente tiene que morir igual').toBe('23503');
    expect(error.constraint).toBe('fk_asiento_renglon_movimiento');
  });
});

// =============================================================================
// C — `grant insert (cliente_id)` de `asiento_correlativo_cliente`: columna ACOTADA
// =============================================================================
describe('0048 C — grant insert (cliente_id): app_request no puede forjar siguiente_numero al nacer', () => {
  it('C.1 legítimo: insertar solo (cliente_id) entra, siguiente_numero toma su default 1', async () => {
    const clienteX = await clienteFresco('C-X');
    await comoUsuario(USUARIOS.socio, async (ej) => {
      const fila = await una(
        ej,
        `insert into asiento_correlativo_cliente (cliente_id) values ($1) returning siguiente_numero as "siguienteNumero"`,
        [clienteX],
      );
      expect(fila['siguienteNumero'], 'siguiente_numero tiene que nacer en 1, del default de la tabla').toBe(1);
    });
  });

  it('C.2 🔴 ATAQUE: insertar (cliente_id, siguiente_numero) con un valor explícito muere 42501 de ACL, nunca de RLS', async () => {
    const clienteX = await clienteFresco('C-X');
    const error = await capturar(() =>
      comoUsuario(USUARIOS.socio, (ej) =>
        ej(`insert into asiento_correlativo_cliente (cliente_id, siguiente_numero) values ($1, $2)`, [clienteX, 999]),
      ),
    );
    esperarRechazoDeGrant(
      error,
      'un socio, con acceso de tenant y rol de sobra, TAMPOCO puede forjar siguiente_numero al ' +
        'insertar: el grant de columna lo impide antes de que RLS tenga oportunidad de evaluar nada',
    );
  });
});

// =============================================================================
// D — policy de UPDATE (`asiento_correlativo_cliente_upd`): socio/contador, nadie más
// =============================================================================
describe('0048 D — la policy de UPDATE restringe la transición a socio/contador', () => {
  const POLICY_REAL = `
    drop policy if exists asiento_correlativo_cliente_upd on asiento_correlativo_cliente;
    create policy asiento_correlativo_cliente_upd on asiento_correlativo_cliente for update
      using      ( cliente_id in (select app.accessible_tenant_ids())
                   and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) )
      with check ( cliente_id in (select app.accessible_tenant_ids())
                   and app.has_role_on(cliente_id, array['socio','contador']::app.rol_membership[]) );
  `;
  // 🔴 MUTANTE: mismo predicado de tenant, SIN el chequeo de rol — la vulnerabilidad concreta que
  // `asiento_correlativo_cliente_upd` (0048, sección 1) existe para cerrar.
  const POLICY_MUTADA_SIN_ROL = `
    drop policy if exists asiento_correlativo_cliente_upd on asiento_correlativo_cliente;
    create policy asiento_correlativo_cliente_upd on asiento_correlativo_cliente for update
      using      ( cliente_id in (select app.accessible_tenant_ids()) )
      with check ( cliente_id in (select app.accessible_tenant_ids()) );
  `;

  async function conPolicyMutada<T>(ddlMutante: string, fn: () => Promise<T>): Promise<T> {
    if (entornoActual() !== 'local') {
      throw new Error(`Las pruebas de mutación de esquema corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
    }
    const duenio = await clienteDuenio();
    try {
      await duenio.query(ddlMutante);
    } finally {
      await duenio.end();
    }
    try {
      return await fn();
    } finally {
      const restaurador = await clienteDuenio();
      try {
        await restaurador.query(POLICY_REAL);
      } finally {
        await restaurador.end();
      }
    }
  }

  it('D.1 legítimo: socio actualiza el contador de su propio cliente, entra', async () => {
    const clienteX = await clienteFresco('D-X');
    await comoUsuario(USUARIOS.socio, async (ej) => {
      await una(ej, `insert into asiento_correlativo_cliente (cliente_id) values ($1) returning cliente_id::text as id`, [clienteX]);
      const filas = await ej(
        `update asiento_correlativo_cliente set siguiente_numero = 2 where cliente_id = $1
         returning siguiente_numero as "siguienteNumero"`,
        [clienteX],
      );
      expect(filas, 'socio tiene rol de sobra para completar la transición').toHaveLength(1);
      expect(filas[0]?.['siguienteNumero']).toBe(2);
    });
  });

  it(
    'D.2 🔴 MUTACIÓN DE ESQUEMA, EN VIVO: con la policy MUTADA (sin has_role_on), un administrativo SÍ logra tocar el contador',
    async () => {
      const clienteX = await clienteFresco('D-X');
      await otorgarMembresia(clienteX, USUARIOS.administrativoA, 'administrativo');
      await comoUsuario(USUARIOS.socio, (ej) =>
        ej(`insert into asiento_correlativo_cliente (cliente_id) values ($1)`, [clienteX]),
      );

      await conPolicyMutada(POLICY_MUTADA_SIN_ROL, async () => {
        const filas = await comoUsuario(USUARIOS.administrativoA, (ej) =>
          ej(
            `update asiento_correlativo_cliente set siguiente_numero = 99 where cliente_id = $1
             returning siguiente_numero as "siguienteNumero"`,
            [clienteX],
          ),
        );
        expect(
          filas,
          'LA MUTACIÓN SE CUELA: sin el chequeo de rol, administrativo (acceso de tenant, sin socio/' +
            'contador) puede pisar el contador de folios igual',
        ).toHaveLength(1);
      });
    },
    10_000,
  );

  it('D.3 el mecanismo REAL (restaurado): el MISMO intento de administrativo afecta 0 filas, sin error', async () => {
    const clienteX = await clienteFresco('D-X');
    await otorgarMembresia(clienteX, USUARIOS.administrativoA, 'administrativo');
    await comoUsuario(USUARIOS.socio, (ej) => ej(`insert into asiento_correlativo_cliente (cliente_id) values ($1)`, [clienteX]));

    const filas = await comoUsuario(USUARIOS.administrativoA, (ej) =>
      ej(
        `update asiento_correlativo_cliente set siguiente_numero = 100 where cliente_id = $1
         returning siguiente_numero as "siguienteNumero"`,
        [clienteX],
      ),
    );
    expect(
      filas,
      'con la policy REAL, administrativo NO puede completar la transición: 0 filas afectadas, SIN ' +
        'error — el mismo "RLS con conjunto vacío de policies aplicables es DENY silencioso" que ' +
        'motivó agregar esta policy (ver cabecera de 0048)',
    ).toHaveLength(0);
  });
});

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Misma forma que `confirmarAsiento()` (`escrituras.ts:624-634`), en SQL crudo — la transición real
 *  que dispara `trg_asiento_propuesto_correlativo`. `confirmado_por` tiene que ser el mismo usuario
 *  de la sesión (R44, `asiento_propuesto_upd_confirmar`, `0045`). */
async function confirmar(
  ej: Ejecutar,
  args: { readonly clienteId: string; readonly asientoId: string; readonly usuarioId: string },
): Promise<Fila> {
  return una(
    ej,
    `update asiento_propuesto
        set asiento_estado = 'confirmado', confirmado_por = $3, confirmado_en = now()
      where cliente_id = $1 and id = $2 and asiento_estado = 'propuesto'
      returning numero_correlativo as "numeroCorrelativo"`,
    [args.clienteId, args.asientoId, args.usuarioId],
  );
}

// =============================================================================
// E — el TRIGGER en sí (`app.asignar_numero_correlativo_asiento()`): A-D nunca lo ejercitan
// =============================================================================

/** Copia EXACTA de la función tal como quedó en `0048` (líneas 285-336), para restaurar después de
 *  mutarla en vivo — mismo patrón que `FUNCION_REAL` de `mutaciones-0041.test.ts`. */
const FN_CORRELATIVO_REAL = `
create or replace function app.asignar_numero_correlativo_asiento() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_numero integer;
begin
  insert into public.asiento_correlativo_cliente (cliente_id)
  values (new.cliente_id)
  on conflict (cliente_id) do nothing;

  select siguiente_numero into v_numero
    from public.asiento_correlativo_cliente
   where cliente_id = new.cliente_id
     for update;

  if not found then
    raise exception
      'cliente_id % no tiene fila en asiento_correlativo_cliente después de intentar autoprovisionarla',
      new.cliente_id
      using errcode = 'P0006';
  end if;

  update public.asiento_correlativo_cliente
     set siguiente_numero = v_numero + 1
   where cliente_id = new.cliente_id;

  new.numero_correlativo := v_numero;
  return new;
end;
$$;
`;

/** 🔴 MUTANTE de E.3: idéntica, SIN el `insert ... on conflict do nothing` de autoprovisión — la
 *  línea que `security-engineer`/la corrección medida al ADR agregaron (ver cabecera de `0048`). */
const FN_CORRELATIVO_SIN_AUTOPROVISION = `
create or replace function app.asignar_numero_correlativo_asiento() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_numero integer;
begin
  -- 🔴 SIN el insert de autoprovisión: si la fila no existe todavía, no hay quién la cree acá.
  select siguiente_numero into v_numero
    from public.asiento_correlativo_cliente
   where cliente_id = new.cliente_id
     for update;

  if not found then
    raise exception
      'cliente_id % no tiene fila en asiento_correlativo_cliente (mutante E.3, sin autoprovisión)',
      new.cliente_id
      using errcode = 'P0006';
  end if;

  update public.asiento_correlativo_cliente
     set siguiente_numero = v_numero + 1
   where cliente_id = new.cliente_id;

  new.numero_correlativo := v_numero;
  return new;
end;
$$;
`;

async function conFuncionCorrelativoMutada<T>(ddlMutante: string, fn: () => Promise<T>): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(`Las pruebas de mutación de trigger corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`);
  }
  const duenio = await clienteDuenio();
  try {
    await duenio.query(ddlMutante);
  } finally {
    await duenio.end();
  }
  try {
    return await fn();
  } finally {
    const restaurador = await clienteDuenio();
    try {
      await restaurador.query(FN_CORRELATIVO_REAL);
    } finally {
      await restaurador.end();
    }
  }
}

describe('0048 E — el trigger asigna el correlativo en la transición real, con autoprovisión', () => {
  it('E.1 legítimo: confirmar el primer asiento de un cliente RECIÉN CREADO autoprovisiona la fila y asigna numero_correlativo=1', async () => {
    const clienteX = await clienteFresco('E-X');
    await comoUsuario(USUARIOS.socio, async (ej) => {
      const previa = await ej(`select 1 as x from asiento_correlativo_cliente where cliente_id = $1`, [clienteX]);
      expect(
        previa,
        'un cliente recién creado (nace DESPUÉS de que 0048 ya se aplicó) no tiene fila en el ' +
          'contador: el backfill de la migración sólo alcanzó a los clientes que ya existían',
      ).toHaveLength(0);

      const cierreX = await crearCierre(ej, clienteX);
      const asientoId = await crearAsientoPropuesto(ej, { clienteId: clienteX, cierreId: cierreX });

      const confirmado = await confirmar(ej, { clienteId: clienteX, asientoId, usuarioId: USUARIOS.socio });
      expect(confirmado['numeroCorrelativo'], 'el primer asiento de un cliente nuevo tiene que arrancar en 1').toBe(1);

      const contador = await una(
        ej,
        `select siguiente_numero as "siguienteNumero" from asiento_correlativo_cliente where cliente_id = $1`,
        [clienteX],
      );
      expect(contador['siguienteNumero'], 'la autoprovisión deja el contador en 2 (1 ya usado)').toBe(2);
    });
  });

  it('E.2 control: confirmar un segundo asiento del mismo cliente asigna numero_correlativo=2, nunca reasigna 1', async () => {
    const clienteX = await clienteFresco('E-X');
    await comoUsuario(USUARIOS.socio, async (ej) => {
      const cierreX = await crearCierre(ej, clienteX);
      const asiento1 = await crearAsientoPropuesto(ej, { clienteId: clienteX, cierreId: cierreX });
      const asiento2 = await crearAsientoPropuesto(ej, { clienteId: clienteX, cierreId: cierreX });

      const c1 = await confirmar(ej, { clienteId: clienteX, asientoId: asiento1, usuarioId: USUARIOS.socio });
      expect(c1['numeroCorrelativo']).toBe(1);

      const c2 = await confirmar(ej, { clienteId: clienteX, asientoId: asiento2, usuarioId: USUARIOS.socio });
      expect(c2['numeroCorrelativo'], 'el segundo asiento confirmado del mismo cliente tiene que ser 2').toBe(2);
    });
  });

  it('E.3 🔴 ATAQUE, mutación EN VIVO: sin el insert de autoprovisión, confirmar el primer asiento de un cliente nuevo muere P0006', async () => {
    const clienteX = await clienteFresco('E-X');
    const asientoId = await comoUsuario(USUARIOS.socio, async (ej) => {
      const cierreX = await crearCierre(ej, clienteX);
      return crearAsientoPropuesto(ej, { clienteId: clienteX, cierreId: cierreX });
    });

    await conFuncionCorrelativoMutada(FN_CORRELATIVO_SIN_AUTOPROVISION, async () => {
      const error = await capturar(() =>
        comoUsuario(USUARIOS.socio, (ej) => confirmar(ej, { clienteId: clienteX, asientoId, usuarioId: USUARIOS.socio })),
      );
      expect(
        error.code,
        'LA MUTACIÓN SE CUELA: sin el insert de autoprovisión, un cliente recién creado no puede ' +
          'confirmar su primer asiento — muere P0006 en vez de asignar numero_correlativo=1',
      ).toBe('P0006');
    });
  });
});

// =============================================================================
// F — CONCURRENCIA real del `for update`: dos confirmaciones simultáneas del MISMO cliente
// =============================================================================

/** 🔴 MUTANTE de F.1: el `select` SIN `for update`, con el MISMO `pg_sleep` en el mismo punto
 *  relativo (después de leer, antes de decidir/escribir) que la variante real de F.2 — mismo
 *  criterio que `mutaciones-0041.test.ts` M1 vs L2: "mismo experimento, distinto lock". */
const FN_CORRELATIVO_SIN_LOCK_CON_SLEEP = `
create or replace function app.asignar_numero_correlativo_asiento() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_numero integer;
begin
  insert into public.asiento_correlativo_cliente (cliente_id)
  values (new.cliente_id)
  on conflict (cliente_id) do nothing;

  -- 🔴 SIN "for update": lee sin lock, dos transacciones concurrentes pueden leer el MISMO valor.
  select siguiente_numero into v_numero
    from public.asiento_correlativo_cliente
   where cliente_id = new.cliente_id;

  perform pg_sleep(1); -- inyectado SOLO para el test: fuerza el entrelazado determinístico.

  if not found then
    raise exception 'cliente_id % no tiene fila en asiento_correlativo_cliente', new.cliente_id
      using errcode = 'P0006';
  end if;

  update public.asiento_correlativo_cliente
     set siguiente_numero = v_numero + 1
   where cliente_id = new.cliente_id;

  new.numero_correlativo := v_numero;
  return new;
end;
$$;
`;

/** El mecanismo REAL (`for update`), con el MISMO `pg_sleep` en el MISMO punto relativo que la
 *  mutante de arriba — la segunda transacción bloquea EN el `for update`, no en el `pg_sleep`. */
const FN_CORRELATIVO_REAL_CON_SLEEP = `
create or replace function app.asignar_numero_correlativo_asiento() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_numero integer;
begin
  insert into public.asiento_correlativo_cliente (cliente_id)
  values (new.cliente_id)
  on conflict (cliente_id) do nothing;

  select siguiente_numero into v_numero
    from public.asiento_correlativo_cliente
   where cliente_id = new.cliente_id
     for update;

  perform pg_sleep(1); -- inyectado SOLO para el test, mismo punto relativo que la mutante sin lock.

  if not found then
    raise exception 'cliente_id % no tiene fila en asiento_correlativo_cliente', new.cliente_id
      using errcode = 'P0006';
  end if;

  update public.asiento_correlativo_cliente
     set siguiente_numero = v_numero + 1
   where cliente_id = new.cliente_id;

  new.numero_correlativo := v_numero;
  return new;
end;
$$;
`;

type ResultadoCarrera = {
  numeroA: number | null;
  numeroB: number | null;
  erroA: string | null;
  erroB: string | null;
};

/**
 * Dos conexiones reales, cada una confirmando un asiento DISTINTO del MISMO cliente. `clienteA`
 * arranca primero y nunca compite con nadie (siempre resuelve limpio); `clienteB` arranca 300ms
 * después. Se espera a que A termine y se lo commitea ANTES de esperar a B — así, si B estaba
 * bloqueada esperando el lock de A (mecanismo real), el commit de A es lo que la libera; si B nunca
 * estuvo bloqueada (mutante sin lock), esto no cambia nada porque B ya venía corriendo sola.
 */
async function correrCarreraCorrelativo(args: {
  readonly clienteId: string;
  readonly asientoA: string;
  readonly asientoB: string;
}): Promise<ResultadoCarrera> {
  const clienteA = await clienteDuenio();
  const clienteB = await clienteDuenio();
  const resultado: ResultadoCarrera = { numeroA: null, numeroB: null, erroA: null, erroB: null };
  try {
    await clienteA.query('begin');
    await clienteA.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);
    const confirmarA = clienteA.query<{ numero_correlativo: number }>(
      `update asiento_propuesto set asiento_estado = 'confirmado', confirmado_por = $3, confirmado_en = now()
        where cliente_id = $1 and id = $2 and asiento_estado = 'propuesto'
        returning numero_correlativo`,
      [args.clienteId, args.asientoA, USUARIOS.socio],
    );

    await esperar(300); // deja que A entre al pg_sleep (ya leyó/lockeó antes de dormir)

    await clienteB.query('begin');
    await clienteB.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);
    const confirmarB = clienteB.query<{ numero_correlativo: number }>(
      `update asiento_propuesto set asiento_estado = 'confirmado', confirmado_por = $3, confirmado_en = now()
        where cliente_id = $1 and id = $2 and asiento_estado = 'propuesto'
        returning numero_correlativo`,
      [args.clienteId, args.asientoB, USUARIOS.socio],
    );

    try {
      const resA = await confirmarA;
      resultado.numeroA = resA.rows[0]?.numero_correlativo ?? null;
      await clienteA.query('commit');
    } catch (e) {
      resultado.erroA = (e as { code?: string }).code ?? String(e);
      await clienteA.query('rollback').catch(() => {});
    }

    try {
      const resB = await confirmarB;
      resultado.numeroB = resB.rows[0]?.numero_correlativo ?? null;
      await clienteB.query('commit');
    } catch (e) {
      resultado.erroB = (e as { code?: string }).code ?? String(e);
      await clienteB.query('rollback').catch(() => {});
    }

    return resultado;
  } finally {
    await clienteA.end().catch(() => {});
    await clienteB.end().catch(() => {});
  }
}

async function prepararClienteYDosAsientos(etiqueta: string): Promise<{
  readonly clienteId: string;
  readonly asientoA: string;
  readonly asientoB: string;
}> {
  const clienteId = await clienteFresco(etiqueta);
  return comoUsuario(USUARIOS.socio, async (ej) => {
    // Fila del contador PRE-CREADA a propósito: aísla el mecanismo bajo prueba (el `for update` del
    // incremento) del mecanismo de autoprovisión (ya cubierto por el bloque E) — un solo mecanismo
    // por test.
    await ej(`insert into asiento_correlativo_cliente (cliente_id) values ($1)`, [clienteId]);
    const cierreId = await crearCierre(ej, clienteId);
    const asientoA = await crearAsientoPropuesto(ej, { clienteId, cierreId });
    const asientoB = await crearAsientoPropuesto(ej, { clienteId, cierreId });
    return { clienteId, asientoA, asientoB };
  });
}

describe('0048 F — concurrencia real del for update: dos confirmaciones simultáneas del mismo cliente', () => {
  it(
    'F.1 🔴 ATAQUE EN VIVO, SIN for update: dos confirmaciones concurrentes leen el mismo siguiente_numero y la segunda muere 23505 contra uq_asiento_propuesto_numero',
    async () => {
      const { clienteId, asientoA, asientoB } = await prepararClienteYDosAsientos('F-X');

      const resultado = await conFuncionCorrelativoMutada(FN_CORRELATIVO_SIN_LOCK_CON_SLEEP, () =>
        correrCarreraCorrelativo({ clienteId, asientoA, asientoB }),
      );

      expect(resultado.numeroA, 'A no compite con nadie: tiene que confirmar limpio con numero=1').toBe(1);
      expect(resultado.erroA).toBeNull();
      expect(
        resultado.erroB,
        'LA CARRERA SE COLÓ: sin for update, B leyó el mismo siguiente_numero que A ANTES de que A ' +
          'incrementara, y al intentar escribir el mismo folio muere contra la unicidad de la ' +
          'sección A — la concurrencia del trigger está rota aunque A contenga el peor desenlace',
      ).toBe('23505');
      expect(resultado.numeroB, 'B no llegó a confirmar: la carrera se lo impidió').toBeNull();
    },
    15_000,
  );

  it(
    'F.2 el mecanismo REAL (for update, mismo pg_sleep en el mismo punto): las dos confirmaciones terminan con números DISTINTOS (1 y 2)',
    async () => {
      const { clienteId, asientoA, asientoB } = await prepararClienteYDosAsientos('F-X');

      const resultado = await conFuncionCorrelativoMutada(FN_CORRELATIVO_REAL_CON_SLEEP, () =>
        correrCarreraCorrelativo({ clienteId, asientoA, asientoB }),
      );

      expect(resultado.erroA, 'A tiene que confirmar limpio, nadie compite antes que ella').toBeNull();
      expect(resultado.numeroA).toBe(1);
      expect(
        resultado.erroB,
        'con for update, B espera a que A libere el lock, relee el contador YA incrementado, y ' +
          'confirma sin chocar contra la unicidad',
      ).toBeNull();
      expect(resultado.numeroB, 'B tiene que quedar en 2: relee el contador después de que A lo incrementó').toBe(2);
    },
    15_000,
  );
});
