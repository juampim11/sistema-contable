/**
 * PRUEBAS DE MUTACIÓN DEL DDL DE `0021_determinante_de_entrada_y_capa_c.sql`.
 *
 * Condición de cierre de la migración: ADR-0002 §B.0 y CLAUDE.md §1.8 — **una regla verificable no
 * cuenta como control hasta que se probó rompiéndola**. Acá cada constraint de `0021` se ejercita
 * con la fila DEFECTUOSA que tiene que rechazar, con su **caso legítimo** al lado, y con la
 * aserción EXACTA del código SQLSTATE y del NOMBRE del constraint — nunca `rejects.toThrow()`
 * pelado, que deja pasar que el error lo detecte el detector equivocado.
 *
 * ## Conteo de mutaciones declarado: 37 mutaciones + 16 casos legítimos, en 44 `it`
 *
 * **Unidad de conteo: una mutación = UNA escritura defectuosa ejercitada**, no un `it`. Varios `it`
 * agrupan dos o tres mutaciones que comparten el mismo escenario (`M-E22` ejercita los tres
 * regímenes posibles sobre el mismo padre) — separarlos costaría un movimiento y un reconocimiento
 * de más por caso y no compraría nada.
 *
 *   Bloque A — frescura de la manifestación y su espejo ......  12 mutaciones,  7 legítimos
 *   Bloque B — cardinalidad de `es_socio` ....................   2 mutaciones,  3 legítimos
 *   Bloque C — la promoción ..................................   4 mutaciones,  1 legítimo
 *   Bloque D — la nulidad binaria de la manifestación ........   3 mutaciones,  1 legítimo
 *   Bloque E — la satélite y el aislamiento ..................   8 mutaciones,  1 legítimo
 *   Bloque F — el determinante y la foto histórica ...........   2 mutaciones,  2 legítimos
 *   Bloque G — lo que el BARRIDO encontró sin cobertura ......   6 mutaciones,  1 legítimo
 *                                                               ─────────────────────────────
 *                                                                37 mutaciones, 16 legítimos
 *
 * ## 🔴 EL BARRIDO, y por qué el bloque G existe
 *
 * El conteo de arriba **no se declaró de memoria**: se midió sacando cada control del esquema local,
 * corriendo este archivo, contando los rojos y devolviéndolo con su definición exacta leída del
 * catálogo. Matriz final — rojos que produce el retiro de cada control, y QUIÉN los produce:
 *
 *   contrapartida_manifestacion_chk .............. 9   M-A5 M-A5b M-A6 M-A6b M-A7 M-D19 M-D20b M-D21
 *   fk_recon_contrapartida_manifestacion ......... 5   M-A4 M-A5 M-A5b M-A8 M-A10
 *   contrapartida_promocion_chk .................. 4   M-C15 M-C16 M-C17 M-C17b
 *   fk_recon_contrapartida_alcance ............... 2   M-A3 M-A10
 *   contrapartida_match_regimen_chk .............. 2   M-E22 M-E22b
 *   fk_recon_contrapartida_match_padre ........... 2   M-E22 M-E22b
 *   fk_recon_contrapartida_match_regimen ......... 2   M-G28 M-G29
 *   uq_recon_contrapartida_match_socio_unico ..... 2   M-B11 M-B12
 *   contrapartida_estado_chk ..................... 2   M-G30 M-G31
 *   contrapartida_frescura_chk ................... 1   M-A1
 *   fk_recon_contrapartida_match_socio ........... 1   M-E23
 *                                                      ────────────────────────────────
 *                                                      SOBREVIVIENTES: ninguno
 *
 * 🔴 Pero la PRIMERA corrida del barrido dejó **DOS SOBREVIVIENTES** —controles que se podían borrar
 * de la base sin que UN SOLO test de las 31 mutaciones originales se pusiera rojo—:
 * `fk_recon_contrapartida_match_regimen` y `contrapartida_estado_chk`. Eso no es un detalle: era
 * cobertura APARENTE, con las 31 mutaciones y sus 15 casos legítimos en verde. El bloque G son los
 * casos que los matan, y el primero destapó un **bypass real del índice de cardinalidad** que
 * ninguna de las 31 tocaba (ver `M-G28`).
 *
 * ⚠️ Y el barrido enseñó algo que hay que dejar escrito para el próximo que lo corra:
 * `drop constraint` + `add constraint` **NO conserva el `COMMENT`**, y `drop index` + `create index`
 * tampoco. `catalogo.test.ts` verifica que cada check NOMBRE a su constante de TypeScript en el
 * comment — así que un barrido que sólo restaura la definición deja ESE test rojo por un motivo que
 * no tiene nada que ver con lo que estaba midiendo. Hay que reaplicar los `comment on` de la
 * migración al restaurar.
 *
 * ## 🔴 SIETE de las 37 mutaciones MUTAN EL DDL, y no hay otra forma de escribirlas
 *
 * Son `M-A5b`, `M-A5c`, `M-A6b`, `M-C17b`, `M-D20b`, `M-E22b` y `M-G31`.
 *
 * Hay invariantes cuyo mecanismo portante está TAPADO por otro control que dispara antes. El caso
 * canónico: la FK de dos columnas `fk_recon_contrapartida_manifestacion` existe para atajar un
 * `padron_manifestacion_id` inexistente CON el espejo en NULL, pero
 * `contrapartida_manifestacion_chk` vuelve ese estado INALCANZABLE — así que un insert nunca puede
 * demostrar que esa FK sirve. La única prueba posible es **escribir el DDL defectuoso** y ver quién
 * queda en pie. Eso es exactamente una prueba de mutación, y sin ella los tres mecanismos de la
 * frescura son indistinguibles de uno solo con dos adornos.
 *
 * Se hace SEGURO así: la mutación corre en una **transacción del dueño del esquema que siempre se
 * rollbackea** (el DDL de PostgreSQL es transaccional), con `entornoActual() === 'local'` exigido y
 * el `finally` cerrando la conexión. Cada bloque mutado verifica al salir que el constraint volvió
 * con su definición original — un rollback que no restaura sería peor que no mutar.
 *
 * ⚠️ MEDIDO Y ANOTADO PORQUE CAMBIA LO QUE ESTOS TESTS AFIRMAN: en local el dueño del esquema
 * (`sistema_contable`) es **superusuario y `BYPASSRLS`** (verificado sobre `pg_roles`). Así que los
 * casos que corren por `clienteDuenio()` miden **MECANISMO PURO** —constraints, columnas generadas—
 * y nunca una policy ni un grant. Es lo correcto para una prueba de mutación de DDL, y es la razón
 * por la que el resto de los casos va por `conUsuario()`: ahí sí está la credencial de la
 * aplicación, con sus grants por columna y sus policies.
 *
 * ## Ni un valor del material real
 *
 * Todo literal es sintético. Los CUIT de `padron_socio` entran como HMAC fabricado con `md5`, no
 * como número: no hay un identificador real ni uno con verificador válido —que podría pertenecerle
 * a un contribuyente de verdad— en ninguna parte de este archivo.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { escribirConAuditoria } from '../src/db/auditoria.ts';
import {
  persistirReconocimiento,
  type PedidoDePersistirReconocimiento,
} from '../src/contabilidad/escrituras.ts';
// Ruta relativa y no el nombre del paquete: `packages/data` NO depende de `@sistema-contable/
// contabilidad` (y no debería — el núcleo es puro y la capa de datos no lo importa en producción).
// Es el mismo camino que usa `catalogo.test.ts:46-56` para leer los dominios cerrados.
import {
  digestDeEntrada,
  type EntradaDelMovimiento,
} from '../../contabilidad/src/nucleo/entrada.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

// -----------------------------------------------------------------------------
// Andamio: una forma única de ejecutar SQL, para que los mismos constructores sirvan tanto sobre
// `conUsuario()` (credencial de la aplicación) como sobre la transacción del dueño (DDL mutado).
// -----------------------------------------------------------------------------

type Fila = Record<string, unknown>;
type Ejecutar = (sql: string, params?: readonly unknown[]) => Promise<Fila[]>;

const desdeTx = (tx: Tx): Ejecutar => (sql, params) => tx.consultar<Fila>(sql, params);
const desdeCliente =
  (c: Client): Ejecutar =>
  async (sql, params) =>
    (await c.query<Fila>(sql, (params ?? []) as unknown[])).rows;

async function una(ej: Ejecutar, sql: string, params?: readonly unknown[]): Promise<Fila> {
  const filas = await ej(sql, params);
  const fila = filas[0];
  if (!fila) throw new Error(`La consulta no devolvió fila: ${sql.slice(0, 80)}`);
  return fila;
}

/**
 * El error de Postgres, con su código y su constraint. Se afirma sobre ESTOS DOS y no sobre el
 * texto del mensaje: el texto cambia de versión a versión y `toThrow(/foreign key/)` da verde
 * cuando dispara una FK que no es la que el test dice probar.
 */
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
 * Igual que `capturar()`, pero acotado a un SAVEPOINT.
 *
 * 🔴 Hace falta y no es cosmético: `conUsuario()` corre TODO dentro de una transacción, así que un
 * insert que falla la deja abortada y el siguiente statement devuelve `25P02`
 * (`current transaction is aborted`) — un test que midiera dos rechazos seguidos afirmaría
 * `25P02` creyendo que afirma el constraint. Se descubrió corriéndolo: **cuatro casos de este
 * archivo daban 25P02 y la primera versión de las aserciones lo habría tomado por bueno si el
 * criterio fuera `rejects.toThrow()`.**
 */
let savepointSeq = 0;
async function capturarAislado(ej: Ejecutar, fn: () => Promise<unknown>): Promise<ErrorPg> {
  savepointSeq += 1;
  const punto = `sp_0021_${savepointSeq}`; // entero generado acá: no hay interpolación de entrada
  await ej(`savepoint ${punto}`);
  try {
    await fn();
    await ej(`release savepoint ${punto}`);
    return SIN_ERROR;
  } catch (e) {
    await ej(`rollback to savepoint ${punto}`);
    const err = e as { code?: string; constraint?: string; message?: string };
    return {
      code: err.code ?? '(sin code)',
      constraint: err.constraint ?? null,
      message: err.message ?? String(e),
    };
  }
}

/** Aserción exacta: código SQLSTATE y nombre del constraint, los dos. */
function esperarRechazo(actual: ErrorPg, code: string, constraint: string, porque: string): void {
  expect({ code: actual.code, constraint: actual.constraint }, porque).toEqual({ code, constraint });
}

// -----------------------------------------------------------------------------
// Constructores de filas. Sintéticos, y con identificadores que no le pertenecen a nadie.
// -----------------------------------------------------------------------------

/** Un uuid que NO existe en la base. Va literal para que el test diga qué está probando. */
const UUID_INEXISTENTE = '00000000-0000-4000-8000-0000000000ff';
const OTRO_UUID_INEXISTENTE = '00000000-0000-4000-8000-0000000000ee';

const BANCO = 'banco_0021';

type Cuenta = { readonly clienteId: string; readonly cuentaId: string; readonly loteId: string };

type ColumnasDeMovimiento = {
  fecha: string;
  descripcion: string;
  importe: string;
  conceptoBanco: string | null;
  conceptoCompleto: boolean | null;
  conceptoBancoEstrategia: string;
  conceptoCodigo: string | null;
  contraparteCaptura: string;
};

const MOVIMIENTO_BASE: ColumnasDeMovimiento = {
  fecha: '2026-06-15',
  descripcion: 'GLOSA',
  importe: '-100.00',
  conceptoBanco: 'CONCEPTO',
  conceptoCompleto: true,
  conceptoBancoEstrategia: 'columna_propia',
  conceptoCodigo: null,
  contraparteCaptura: 'capturado',
};

/** `fila_numero` monotónico de proceso: dos filas de este archivo nunca chocan entre sí. */
let filaSeq = 0;

async function crearMovimiento(
  ej: Ejecutar,
  cuenta: Cuenta,
  cambios: Partial<ColumnasDeMovimiento> = {},
): Promise<{ readonly id: string; readonly entradaDigest: string }> {
  const c = { ...MOVIMIENTO_BASE, ...cambios };
  filaSeq += 1;
  const f = await una(
    ej,
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, saldo, concepto_banco, concepto_completo, concepto_banco_estrategia, concepto_codigo,
        contraparte_captura)
     values ($1, $2, $3, $4, $5, $6::date, $7, $8::numeric, 900.00, $9, $10, $11, $12, $13)
     returning id::text as id, entrada_digest`,
    [
      cuenta.clienteId,
      cuenta.loteId,
      cuenta.cuentaId,
      filaSeq,
      randomUUID(),
      c.fecha,
      c.descripcion,
      c.importe,
      c.conceptoBanco,
      c.conceptoCompleto,
      c.conceptoBancoEstrategia,
      c.conceptoCodigo,
      c.contraparteCaptura,
    ],
  );
  return { id: String(f['id']), entradaDigest: String(f['entrada_digest']) };
}

type Clase = 'propuesta' | 'decision_humana' | 'sin_reconocer';

let digestSeq = 0;
/** 16 hex, la forma que exige `reconocimiento_digest_chk`. Sintético y monotónico. */
function motorDigestSintetico(): string {
  digestSeq += 1;
  return digestSeq.toString(16).padStart(16, '0');
}

/**
 * Un padre para la contrapartida: movimiento nuevo + reconocimiento nuevo con la clase pedida.
 * Uno por caso, porque `uq_recon_vigente` admite un solo reconocimiento activo por movimiento y
 * `uq_recon_contrapartida_reconocimiento` una sola contrapartida por reconocimiento.
 */
async function crearReconocimiento(
  ej: Ejecutar,
  cuenta: Cuenta,
  clase: Clase,
  cambios: Partial<ColumnasDeMovimiento> = {},
): Promise<{ readonly id: string; readonly movimientoId: string; readonly entradaDigest: string }> {
  const mov = await crearMovimiento(ej, cuenta, cambios);
  const digest = motorDigestSintetico();

  if (clase === 'sin_reconocer') {
    const f = await una(
      ej,
      `insert into reconocimiento_movimiento
         (cliente_id, movimiento_id, motor_digest, clase, motivo_codigo)
       values ($1, $2, $3, 'sin_reconocer', 'ambiguo')
       returning id::text as id`,
      [cuenta.clienteId, mov.id, digest],
    );
    return { id: String(f['id']), movimientoId: mov.id, entradaDigest: mov.entradaDigest };
  }

  const f = await una(
    ej,
    `insert into reconocimiento_movimiento
       (cliente_id, movimiento_id, motor_digest, clase, tipo, concepto, polaridad, lado, via,
        que_decide, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados, evidencia_hubo_cola)
     values ($1, $2, $3, $4, 'comision_bancaria', 'comision_de_transferencia', 'normal', 'debe',
             'texto_literal_exacto', $5, 'galicia.comision_de_transferencia', 12, false)
     returning id::text as id`,
    [
      cuenta.clienteId,
      mov.id,
      digest,
      clase,
      clase === 'decision_humana' ? 'distinguir_tercero_de_socio' : null,
    ],
  );
  return { id: String(f['id']), movimientoId: mov.id, entradaDigest: mov.entradaDigest };
}

const INSERT_CONTRAPARTIDA = `insert into reconocimiento_contrapartida
    (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase,
     padron_manifestacion_id, padron_completo_hasta, resuelto_a_fecha)
  values ($1, $2, $3, $4, $5, $6::date, $7::date)
  returning id::text as id`;

/**
 * ⚠️ El campo se llama `claseEspejada` y NO `clase` por dos motivos, los dos deliberados: (1) lo que
 * se escribe es `reconocimiento_clase`, el ESPEJO de la clase del padre, no la clase de un
 * `Reconocimiento`; y (2) ese nombre de campo con el literal de la clase promovida dispara R-F de
 * `reglas-de-codigo.test.ts`
 * —la regla que impide construir una propuesta a mano fuera de `nucleo/motor.ts`—, y la salida
 * correcta es nombrar bien el campo, NO agregar este archivo a la allowlist de la regla. Un fixture
 * que empuja a relajar el verificador es el peor desenlace posible.
 */
type PedidoContrapartida = {
  readonly clienteId: string;
  readonly reconocimientoId: string;
  readonly estado: string;
  readonly claseEspejada: string;
  readonly manifestacionId?: string | null;
  readonly completoHasta?: string | null;
  readonly resueltoAFecha?: string;
};

function insertarContrapartida(ej: Ejecutar, p: PedidoContrapartida): Promise<Fila[]> {
  return ej(INSERT_CONTRAPARTIDA, [
    p.clienteId,
    p.reconocimientoId,
    p.estado,
    p.claseEspejada,
    p.manifestacionId ?? null,
    p.completoHasta ?? null,
    p.resueltoAFecha ?? '2026-06-15',
  ]);
}

const INSERT_MATCH = `insert into reconocimiento_contrapartida_match
    (cliente_id, contrapartida_id, regimen_matches, socio_id, match_clase)
  values ($1, $2, $3, $4, $5)`;

function insertarMatch(
  ej: Ejecutar,
  clienteId: string,
  contrapartidaId: string,
  regimen: string,
  socioId: string,
  clase = 'cuit',
): Promise<Fila[]> {
  return ej(INSERT_MATCH, [clienteId, contrapartidaId, regimen, socioId, clase]);
}

/** Padre + contrapartida, para los casos de la satélite. */
async function crearContrapartida(
  ej: Ejecutar,
  cuenta: Cuenta,
  estado: string,
  clase: Clase,
): Promise<string> {
  const padre = await crearReconocimiento(ej, cuenta, clase);
  const f = await insertarContrapartida(ej, {
    clienteId: cuenta.clienteId,
    reconocimientoId: padre.id,
    estado,
    claseEspejada: clase,
  });
  const id = f[0]?.['id'];
  if (!id) throw new Error('no se creó la contrapartida');
  return String(id);
}

// -----------------------------------------------------------------------------
// El laboratorio de mutación de DDL
// -----------------------------------------------------------------------------

/**
 * Corre `fn` con el DDL mutado, sobre una transacción del dueño que **siempre** se rollbackea.
 *
 * 🔴 Tres guardas, y las tres importan:
 *   1. `entornoActual() === 'local'`, o lanza. Mutar el esquema fuera de local no se discute.
 *   2. `rollback` en el `finally`, antes de cerrar la conexión: el DDL de PostgreSQL es
 *      transaccional, así que nada de esto llega al disco.
 *   3. Al salir se verifica que la definición del constraint mutado volvió a ser la original. Un
 *      rollback que no restaura dejaría el esquema local distinto del de la migración y todos los
 *      tests siguientes medirían otra cosa — sin decirlo.
 *
 * ⚠️ El constraint defectuoso se agrega `not valid`, y el motivo salió de correrlo: los `it`
 * anteriores de este mismo archivo COMMITEAN filas legítimas, y una de las formas mutadas
 * (`M-D20b`) las rechaza — el `alter table` moría con
 * `check constraint … is violated by some row` antes de llegar al insert que el test quiere medir.
 * `not valid` saltea la validación de lo YA existente y se sigue aplicando ENTERO a todo insert
 * nuevo, que es exactamente lo que la mutación necesita. No debilita nada: el caso medido es
 * siempre un insert.
 */
async function conDdlMutado<T>(
  constraintsAVerificar: readonly string[],
  ddl: readonly string[],
  fn: (lab: { readonly ej: Ejecutar; readonly cuenta: Cuenta }) => Promise<T>,
): Promise<T> {
  return conDuenio(async (ej, crudo) => {
    const antes = await definicionesDe(ej, constraintsAVerificar);
    for (const sentencia of ddl) await crudo(sentencia);
    try {
      return await fn({ ej, cuenta: escenario.a });
    } finally {
      // El `rollback` lo hace `conDuenio`; acá se verifica que restaure. Se lee la definición
      // DESPUÉS de deshacer, en la misma conexión.
      await crudo('rollback');
      const despues = await definicionesDe(ej, constraintsAVerificar);
      expect(despues, 'el rollback del DDL mutado NO restauró el esquema').toEqual(antes);
    }
  });
}

/**
 * Una transacción del dueño del esquema, con el contexto de tenant seteado y **rollback siempre**.
 *
 * El dueño es superusuario y `BYPASSRLS` (medido), así que acá se mide MECANISMO PURO: constraints
 * y columnas generadas, nunca una policy ni un grant. El `set_config` va igual — si algún día el
 * dueño deja de ser superusuario, este harness sigue andando en vez de empezar a devolver 0 filas
 * sin error (H-14). Y es lo que llena `manifestado_por`, que es `not null` con
 * `default app.current_user_id()`.
 */
async function conDuenio<T>(
  fn: (ej: Ejecutar, crudo: (sql: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  if (entornoActual() !== 'local') {
    throw new Error(
      `Las pruebas de mutación de DDL corren SOLO en local y APP_ENTORNO es "${entornoActual()}".`,
    );
  }
  const duenio = await clienteDuenio();
  const ej = desdeCliente(duenio);
  const crudo = (sql: string): Promise<unknown> => duenio.query(sql);
  try {
    await duenio.query('begin');
    await duenio.query(`select set_config('app.user_id', $1, true)`, [USUARIOS.socio]);
    return await fn(ej, crudo);
  } finally {
    try {
      await duenio.query('rollback');
    } finally {
      await duenio.end();
    }
  }
}

async function definicionesDe(
  ej: Ejecutar,
  nombres: readonly string[],
): Promise<Record<string, string>> {
  const filas = await ej(
    `select conname, pg_get_constraintdef(oid) as def
       from pg_constraint where conname = any($1::text[]) order by conname`,
    [nombres],
  );
  return Object.fromEntries(filas.map((f) => [String(f['conname']), String(f['def'])]));
}

// -----------------------------------------------------------------------------
// Escenario
// -----------------------------------------------------------------------------

let s: Sembrado;

const escenario = {
  a: { clienteId: '', cuentaId: '', loteId: '' } as Cuenta,
  b: { clienteId: '', cuentaId: '', loteId: '' } as Cuenta,
  socioA1: '',
  socioA2: '',
  socioB1: '',
  /** Alcance `2026-06-30`, del cliente A. */
  manA: '',
  /** Alcance `2026-12-31`, del cliente A. Existe para poder MENTIR el espejo. */
  manAmplia: '',
  /** Alcance `2026-06-30`, del cliente B. Existe para el caso cross-tenant. */
  manB: '',
};

const ALCANCE_A = '2026-06-30';
const ALCANCE_AMPLIO = '2026-12-31';

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ($1, 'BANCO 0021', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);

    for (const [clave, clienteId] of [
      ['a', s.clienteA],
      ['b', s.clienteB],
    ] as const) {
      const cuenta = await una(
        ej,
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
         values ($1, $2, 'ARS', $3) returning id::text as id`,
        [clienteId, BANCO, `0021 ${clave.toUpperCase()}`],
      );
      const lote = await una(
        ej,
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
         values ($1, $2, 'prueba-0021', 'archivo', $3, 'recibido', 0)
         returning id::text as id`,
        [clienteId, BANCO, `hash_0021_${clave}`],
      );
      await ej(
        `insert into lote_ingesta_cuenta
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
            verificacion_estado)
         values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
        [clienteId, String(lote['id']), String(cuenta['id'])],
      );
      escenario[clave] = {
        clienteId,
        cuentaId: String(cuenta['id']),
        loteId: String(lote['id']),
      };
    }

    // Tres socios: dos en A (para la cardinalidad) y uno en B (para el cross-tenant).
    // 🔴 El HMAC se FABRICA con md5 y no se deriva de un CUIT: un identificador sintético con
    // verificador válido puede pertenecerle a un contribuyente real.
    const socio = async (clienteId: string, semilla: string): Promise<string> => {
      const f = await una(
        ej,
        `insert into padron_socio
           (cliente_id, denominacion, documento_tipo, documento_hmac, documento_ultimos4, pepper_id,
            vigente_desde)
         values ($1, $2, 'cuit', decode(md5($3), 'hex') || decode(md5($3), 'hex'), '0000', 'v1',
                 '2026-01-01')
         returning id::text as id`,
        [clienteId, `SOCIO SINTETICO ${semilla}`, `0021-${semilla}`],
      );
      return String(f['id']);
    };
    escenario.socioA1 = await socio(s.clienteA, 'a1');
    escenario.socioA2 = await socio(s.clienteA, 'a2');
    escenario.socioB1 = await socio(s.clienteB, 'b1');

    const manifestacion = async (clienteId: string, hasta: string): Promise<string> => {
      const f = await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta) values ($1, $2::date)
         returning id::text as id`,
        [clienteId, hasta],
      );
      return String(f['id']);
    };
    escenario.manA = await manifestacion(s.clienteA, ALCANCE_A);
    escenario.manAmplia = await manifestacion(s.clienteA, ALCANCE_AMPLIO);
    escenario.manB = await manifestacion(s.clienteB, ALCANCE_A);
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Atajo: corre `fn` con la credencial de la aplicación (grants por columna + policies). */
function comoApp<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

// =============================================================================
// BLOQUE A — la frescura de la manifestación y su espejo
// =============================================================================
describe('0021 A — la frescura de la manifestación y su espejo (12 mutaciones, 7 legítimos)', () => {
  it('M-A1 🔴 `padron_completo_hasta` un día ANTERIOR a `resuelto_a_fecha` muere por `contrapartida_frescura_chk`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_tercero_padron_completo',
          claseEspejada: 'propuesta',
          manifestacionId: escenario.manA,
          completoHasta: ALCANCE_A, // 2026-06-30
          resueltoAFecha: '2026-07-01', // un día DESPUÉS del alcance
        });
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'contrapartida_frescura_chk',
      'una resolución apoyada en una manifestación que NO cubre la fecha evaluada entró a la base',
    );
  });

  it('L-A2 legítimo: `padron_completo_hasta` IGUAL a `resuelto_a_fecha` ENTRA — refuta un `>` en vez de `>=`', async () => {
    const id = await comoApp(async (ej) => {
      const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
      const f = await insertarContrapartida(ej, {
        clienteId: escenario.a.clienteId,
        reconocimientoId: padre.id,
        estado: 'es_tercero_padron_completo',
        claseEspejada: 'propuesta',
        manifestacionId: escenario.manA,
        completoHasta: ALCANCE_A,
        resueltoAFecha: ALCANCE_A, // el borde exacto
      });
      return f[0]?.['id'];
    });
    // Sin este caso, `>` y `>=` serían indistinguibles y el borde —el día EXACTO en que la
    // manifestación deja de cubrir— es el único que se ejercita todos los meses.
    expect(id, 'el borde inclusivo del alcance quedó rechazado: el check dice `>` y no `>=`').toBeTruthy();
  });

  it('M-A3 🔴 el espejo MENTIDO (la manifestación A citada con el alcance de otra) muere por `fk_recon_contrapartida_alcance`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_tercero_padron_completo',
          claseEspejada: 'propuesta',
          manifestacionId: escenario.manA, // alcance real: 2026-06-30
          completoHasta: ALCANCE_AMPLIO, // el de OTRA manifestación: 2026-12-31
          resueltoAFecha: '2026-06-15',
        });
      }),
    );
    // Es el caso que vuelve INFALSIFICABLE al espejo: sin la FK de tres columnas, escribir un
    // alcance ajeno alcanzaría para que la frescura diera verde sobre una premisa que no existe.
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_alcance',
      'el espejo del alcance es falsificable: se citó una manifestación con el alcance de otra',
    );
  });

  it('M-A4 🔴 una manifestación INEXISTENTE con el espejo poblado muere por `fk_recon_contrapartida_manifestacion`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_tercero_padron_completo',
          claseEspejada: 'propuesta',
          manifestacionId: UUID_INEXISTENTE,
          completoHasta: ALCANCE_A,
          resueltoAFecha: '2026-06-15',
        });
      }),
    );
    /**
     * ⚠️ CORRECCIÓN MEDIDA A LA ESPECIFICACIÓN. El plan atribuía este rechazo a
     * `fk_recon_contrapartida_alcance`. Las DOS FK fallan sobre esta fila, y Postgres dispara la
     * primera en orden de creación, que es la de DOS columnas. Un test escrito contra la
     * atribución del plan habría quedado ROJO — y el que lo escribiera habría "arreglado" el test
     * relajando la aserción a `/foreign key/`, que es lo que este archivo existe para no hacer.
     */
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_manifestacion',
      'se citó una manifestación que no existe',
    );
  });

  it('M-A5 una manifestación INEXISTENTE con el espejo NULL muere por `contrapartida_manifestacion_chk`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_tercero_padron_completo',
          claseEspejada: 'propuesta',
          manifestacionId: UUID_INEXISTENTE,
          completoHasta: null,
          resueltoAFecha: '2026-06-15',
        });
      }),
    );
    /**
     * 🔴 SEGUNDA CORRECCIÓN MEDIDA. El plan decía que ésta es «la única que prueba que la FK de dos
     * columnas no es redundante». **No lo es, y no puede serlo:** el check de nulidad hace que
     * `padron_manifestacion_id is not null` con `padron_completo_hasta is null` sea un estado
     * INALCANZABLE, así que el check dispara ANTES y la FK de dos columnas nunca se evalúa.
     * La contribución propia de esa FK sólo se puede exhibir MUTANDO EL CHECK: es M-A5b.
     */
    esperarRechazo(
      error,
      '23514',
      'contrapartida_manifestacion_chk',
      'el check de nulidad binaria no atajó una manifestación citada sin su espejo',
    );
  });

  it('M-A5b 🔴 con el check reducido a UNA MITAD, la FK de DOS columnas queda en pie — la prueba de que NO es redundante', async () => {
    const error = await conDdlMutado(
      ['contrapartida_manifestacion_chk'],
      [
        'alter table reconocimiento_contrapartida drop constraint contrapartida_manifestacion_chk',
        // La forma "obvia": sólo la primera mitad, sin el renglón del espejo.
        `alter table reconocimiento_contrapartida add constraint contrapartida_manifestacion_chk
           check ((resolucion_estado = 'es_tercero_padron_completo') = (padron_manifestacion_id is not null))
           not valid`,
      ],
      async ({ ej, cuenta }) => {
        const padre = await crearReconocimiento(ej, cuenta, 'propuesta');
        return capturar(() =>
          insertarContrapartida(ej, {
            clienteId: cuenta.clienteId,
            reconocimientoId: padre.id,
            estado: 'es_tercero_padron_completo',
            claseEspejada: 'propuesta',
            manifestacionId: UUID_INEXISTENTE,
            completoHasta: null,
            resueltoAFecha: '2026-06-15',
          }),
        );
      },
    );
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_manifestacion',
      'con el check mutado, la FK de DOS columnas no atajó la manifestación inexistente: entonces ' +
        'sí es redundante y sobra del DDL',
    );
  });

  it('M-A5c 🔴 con el check reducido Y la FK de dos columnas fuera, la fila ENTRA — la de TRES columnas NO la cubre', async () => {
    const error = await conDdlMutado(
      ['contrapartida_manifestacion_chk', 'fk_recon_contrapartida_alcance'],
      [
        'alter table reconocimiento_contrapartida drop constraint contrapartida_manifestacion_chk',
        `alter table reconocimiento_contrapartida add constraint contrapartida_manifestacion_chk
           check ((resolucion_estado = 'es_tercero_padron_completo') = (padron_manifestacion_id is not null))
           not valid`,
        'alter table reconocimiento_contrapartida drop constraint fk_recon_contrapartida_manifestacion',
      ],
      async ({ ej, cuenta }) => {
        const padre = await crearReconocimiento(ej, cuenta, 'propuesta');
        return capturar(() =>
          insertarContrapartida(ej, {
            clienteId: cuenta.clienteId,
            reconocimientoId: padre.id,
            estado: 'es_tercero_padron_completo',
            claseEspejada: 'propuesta',
            manifestacionId: UUID_INEXISTENTE,
            completoHasta: null,
            resueltoAFecha: '2026-06-15',
          }),
        );
      },
    );
    /**
     * El resultado ESPERADO es que la fila ENTRE. Es la mitad refutadora del par M-A5b/M-A5c: sin
     * ella, «la FK de dos columnas sirve» sería compatible con «la de tres ya lo cubría». La FK
     * compuesta de TRES columnas SE SALTEA cuando `padron_completo_hasta` es nula (`match simple`,
     * el default), así que un `padron_manifestacion_id` colgado entra sin que nada falle.
     */
    expect(
      error,
      'la FK de TRES columnas atajó la manifestación inexistente con el espejo NULL: entonces la ' +
        'FK de dos columnas SÍ es redundante y el argumento del DDL es falso',
    ).toEqual(SIN_ERROR);
  });

  it('M-A6 🔴 una manifestación VÁLIDA con el espejo NULL muere por `contrapartida_manifestacion_chk` (la segunda mitad NO es cosmética)', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_tercero_padron_completo',
          claseEspejada: 'propuesta',
          manifestacionId: escenario.manA,
          completoHasta: null,
          resueltoAFecha: '2026-06-15',
        });
      }),
    );
    esperarRechazo(
      error,
      '23514',
      'contrapartida_manifestacion_chk',
      'una manifestación citada SIN su espejo entró: el control de frescura queda desactivado',
    );
  });

  it('M-A6b 🔴 con el check reducido a una mitad, una manifestación VENCIDA con el espejo NULL ENTRA: el control de frescura queda DESACTIVADO', async () => {
    const error = await conDdlMutado(
      ['contrapartida_manifestacion_chk'],
      [
        'alter table reconocimiento_contrapartida drop constraint contrapartida_manifestacion_chk',
        `alter table reconocimiento_contrapartida add constraint contrapartida_manifestacion_chk
           check ((resolucion_estado = 'es_tercero_padron_completo') = (padron_manifestacion_id is not null))
           not valid`,
      ],
      async ({ ej, cuenta }) => {
        const padre = await crearReconocimiento(ej, cuenta, 'propuesta');
        return capturar(() =>
          insertarContrapartida(ej, {
            clienteId: cuenta.clienteId,
            reconocimientoId: padre.id,
            estado: 'es_tercero_padron_completo',
            claseEspejada: 'propuesta',
            manifestacionId: escenario.manA, // alcance real 2026-06-30
            completoHasta: null, // el espejo vacío
            resueltoAFecha: '2027-01-01', // MEDIO AÑO después del alcance
          }),
        );
      },
    );
    /**
     * 🔴 ESTA ES LA MUTACIÓN MÁS IMPORTANTE DEL BLOQUE. La fila ENTRA, y con ella una resolución
     * apoyada en una manifestación que NO cubre la fecha evaluada: `contrapartida_frescura_chk`
     * evaluó `NULL >= '2027-01-01'`, dio UNKNOWN y PASÓ. O sea que la forma "obvia" del check de
     * nulidad —la que escribió el plan original y la que cualquiera escribiría de nuevo— trae el
     * bypass del control de frescura adentro: **el control se desactiva dejando una columna vacía.**
     * Con el DDL real, el mismo insert muere en M-A6.
     */
    expect(
      error,
      'con el check mutado la fila NO entró: entonces la segunda mitad del check es cosmética y el ' +
        'argumento del DDL (S4 sobre una columna nueva) es falso',
    ).toEqual(SIN_ERROR);
  });

  it('M-A7 el espejo poblado SIN manifestación muere por `contrapartida_manifestacion_chk`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_tercero_padron_completo',
          claseEspejada: 'propuesta',
          manifestacionId: null,
          completoHasta: ALCANCE_A,
          resueltoAFecha: '2026-06-15',
        });
      }),
    );
    // La dirección inversa de M-A6, y hace falta: un check que sólo mirara una dirección dejaría
    // pasar un alcance inventado sin ninguna manifestación detrás.
    esperarRechazo(
      error,
      '23514',
      'contrapartida_manifestacion_chk',
      'entró un alcance sin manifestación que lo respalde',
    );
  });

  it('M-A8 la manifestación de OTRO cliente, con su alcance REAL, muere por `fk_recon_contrapartida_manifestacion`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_tercero_padron_completo',
          claseEspejada: 'propuesta',
          manifestacionId: escenario.manB, // del cliente B
          completoHasta: ALCANCE_A, // su alcance de verdad, para que la mentira no sea el espejo
          resueltoAFecha: '2026-06-15',
        });
      }),
    );
    /**
     * ⚠️ TERCERA CORRECCIÓN MEDIDA a la atribución del plan (decía `fk_..._alcance`). Las dos FK
     * llevan `cliente_id`, así que las dos rechazan; dispara la de dos columnas.
     *
     * Se arma con `USUARIOS.socio`, que tiene membresía en A **y** en B: la RLS no lo frena y lo
     * único que queda en pie es la FK compuesta. Es el caso fuerte, igual que INV-2/INV-3.
     */
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_manifestacion',
      'una resolución del cliente A se apoyó en la manifestación de otro estudio',
    );
  });

  it('L-A9 legítimo: los SEIS estados sin gate de padrón entran con las dos columnas en NULL — refuta un `not null` y refuta `match full`', async () => {
    const estados = [
      ['sin_candidatos', 'decision_humana'],
      ['sin_match_padron_incompleto', 'decision_humana'],
      ['pepper_desalineado', 'decision_humana'],
      ['multiples_socios', 'decision_humana'],
      ['socio_fuera_de_vigencia', 'decision_humana'],
      ['es_socio', 'propuesta'],
    ] as const;

    const ids = await comoApp(async (ej) => {
      const creados: unknown[] = [];
      for (const [estado, clase] of estados) {
        const padre = await crearReconocimiento(ej, escenario.a, clase);
        const f = await insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado,
          claseEspejada: clase,
        });
        creados.push(f[0]?.['id']);
      }
      return creados;
    });

    /**
     * Los seis son el caso legítimo de TODO el bloque A, y son dos refutaciones a la vez:
     *   - refutan un `not null` sobre `padron_manifestacion_id`/`padron_completo_hasta`;
     *   - refutan `match full` en las FK compuestas — con `cliente_id` (`not null`) adentro, «todas
     *     nulas» es inalcanzable, así que `match full` quedaría enforced SIEMPRE y rechazaría estos
     *     seis. Hoy son el 100% de lo que el motor produce.
     */
    expect(ids.filter(Boolean), 'una de las seis ramas sin manifestación quedó rechazada').toHaveLength(6);
  });

  it('M-A10 🔴 un `UPDATE` de `completo_hasta` con una contrapartida viva muere con `23503` — la inmutabilidad es DELIBERADA, no un bug', async () => {
    // Se mide con el DUEÑO (superusuario) a propósito: con `app_request` el update muere antes por
    // falta de grant y de policy, y entonces el test no diría nada del INVARIANTE. Acá lo único que
    // queda en pie es la FK — el mismo argumento que `ayuda.ts` da para `clienteJob()`.
    const { error, errorDelete } = await conDuenio(async (ej) => {
      const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
      await insertarContrapartida(ej, {
        clienteId: escenario.a.clienteId,
        reconocimientoId: padre.id,
        estado: 'es_tercero_padron_completo',
        claseEspejada: 'propuesta',
        manifestacionId: escenario.manA,
        completoHasta: ALCANCE_A,
        resueltoAFecha: '2026-06-15',
      });
      return {
        error: await capturarAislado(ej, () =>
          ej(`update padron_manifestacion set completo_hasta = $2::date where id = $1`, [
            escenario.manA,
            ALCANCE_AMPLIO,
          ]),
        ),
        errorDelete: await capturarAislado(ej, () =>
          ej(`delete from padron_manifestacion where id = $1`, [escenario.manA]),
        ),
      };
    });

    /**
     * 🔴 SE DOCUMENTA LA CONDUCTA, NO SE CORRIGE. Una manifestación errónea se supersede con una
     * fila nueva (`revoca_a`), jamás con un `UPDATE`: una columna `revocada_en` actualizable no
     * lleva autor y el rastro diría que quien manifestó fue quien revocó. Así que la FK MECANIZA
     * una decisión ya tomada, y no pelea contra una operación real — que es la diferencia exacta
     * con la FK que se descartó para el determinante (`F4`: ahí el `UPDATE` era un camino vivo).
     * El día que este test se ponga verde por el `UPDATE`, alguien otorgó un grant que no debía.
     */
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_alcance',
      'se pudo REESCRIBIR el alcance de una manifestación ya citada por una resolución emitida',
    );
    esperarRechazo(
      errorDelete,
      '23503',
      'fk_recon_contrapartida_manifestacion',
      'se pudo BORRAR una manifestación ya citada por una resolución emitida',
    );
  });

  it('L-A10b legítimo: la manifestación que NADIE citó sí se puede borrar — refuta un `on delete restrict` que fuera un bloqueo total', async () => {
    const borradas = await conDuenio(async (ej) => {
      const f = await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta) values ($1, '2026-09-30')
         returning id::text as id`,
        [escenario.a.clienteId],
      );
      const r = await ej(`delete from padron_manifestacion where id = $1 returning id::text as id`, [
        String(f['id']),
      ]);
      return r.length;
    });
    // Sin este caso, M-A10 sería compatible con «nada se puede borrar nunca», que es otro control.
    expect(borradas, 'el `restrict` frena incluso a la manifestación sin citas: no discrimina').toBe(1);
  });
});

// =============================================================================
// BLOQUE B — la cardinalidad de `es_socio`
// =============================================================================
describe('0021 B — la cardinalidad de `es_socio` (2 mutaciones, 3 legítimos)', () => {
  it('M-B11 🔴 dos filas satélite con socios DISTINTOS bajo un `es_socio` mueren con `23505`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const cp = await crearContrapartida(ej, escenario.a, 'es_socio', 'propuesta');
        await insertarMatch(ej, escenario.a.clienteId, cp, 'socio_unico', escenario.socioA1);
        return insertarMatch(ej, escenario.a.clienteId, cp, 'socio_unico', escenario.socioA2);
      }),
    );
    /**
     * Es el error SIN DETECTOR AGUAS ABAJO: capa D imputaría a la cuenta particular de uno mientras
     * la evidencia exhibe dos. La conciliación bancaria no lo ve (la cuenta Banco queda idéntica,
     * el importe es correcto, el balance cierra) y, a diferencia del error inverso —un tercero
     * tratado como socio, que el socio mismo reclama al ver su saldo—, éste NO TIENE QUIEN LO
     * RECLAME: sobrevive hasta el cierre, o más.
     */
    esperarRechazo(
      error,
      '23505',
      'uq_recon_contrapartida_match_socio_unico',
      'un `es_socio` quedó con DOS socios distintos y nadie aguas abajo lo va a notar',
    );
  });

  it('M-B12 🔴 el MISMO socio por dos vías bajo un `es_socio` TAMBIÉN muere con `23505` — PRECIO CONOCIDO Y ACEPTADO, no un bug', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const cp = await crearContrapartida(ej, escenario.a, 'es_socio', 'propuesta');
        await insertarMatch(ej, escenario.a.clienteId, cp, 'socio_unico', escenario.socioA1, 'cuit');
        // El MISMO socio, por CBU: un solo socio, dos filas.
        return insertarMatch(ej, escenario.a.clienteId, cp, 'socio_unico', escenario.socioA1, 'cbu');
      }),
    );
    /**
     * 🔴 EL ÍNDICE GARANTIZA «≤1 FILA», NO «≤1 SOCIO». «≤1 socio distinto entre N filas» NO ES
     * EXPRESABLE como `unique` en PostgreSQL (medido por las dos formas posibles), y ésta es la
     * diferencia: un mismo socio matcheando por CUIT y por CBU —un solo socio, dos filas— es
     * RECHAZADO. Se aceptó porque hoy es ESTRUCTURALMENTE INALCANZABLE: `padron_socio.documento_hmac`
     * usa el dominio de hash `cuit_cuil` y sólo un candidato de clase `cuit` produce ese dominio.
     *
     * 🔴 ESTE TEST NO ES UN BUG A ARREGLAR, Y LO QUE SE ASSERTA ES EL ABORTO. Si algún día dispara
     * en producción, alguien cambió el dominio de hash del padrón — y la respuesta correcta es
     * DECIDIR CÓMO SE EXHIBE UN MATCH MULTI-VÍA y rediseñar el régimen. **No** es borrar el índice,
     * ni relajarlo, ni DEDUPLICAR EN LA APLICACIÓN para que pase: deduplicar sería registrar menos
     * de lo observado sin decirlo —el patrón `galicia.ts`— y la contadora vería una vía creyendo
     * que es toda la evidencia. El aborto es el detector; el silencio no lo es.
     */
    esperarRechazo(
      error,
      '23505',
      'uq_recon_contrapartida_match_socio_unico',
      'el precio conocido del índice dejó de cobrarse: revisar si cambió el dominio de hash',
    );
  });

  it('L-B13 legítimo (y demostrativo): un `es_socio` con CERO filas satélite PASA el índice — el `≥1` NO está en la base', async () => {
    const cuantas = await comoApp(async (ej) => {
      const cp = await crearContrapartida(ej, escenario.a, 'es_socio', 'propuesta');
      const f = await ej(
        `select count(*)::text as n from reconocimiento_contrapartida_match where contrapartida_id = $1`,
        [cp],
      );
      return Number(f[0]?.['n'] ?? '-1');
    });
    /**
     * El índice garantiza `≤1`, NUNCA `≥1`. Un `es_socio` sin matches es insertable y dejaría a
     * capa D sin sujeto: lo ataja `ContrapartidaEsSocioSinMatchError` en la LECTURA, no acá.
     * Índice (`≤1`) + excepción de lectura (`≥1`) = exactamente 1. Este test existe para que nadie
     * lea el índice como si cubriera las dos mitades y borre la excepción de lectura por
     * "redundante".
     */
    expect(cuantas, 'la base empezó a exigir al menos un match: el `≥1` bajó al esquema sin decirlo').toBe(0);
  });

  it('L-B14 legítimo: dos socios distintos bajo `multiples_socios` ENTRAN LOS DOS — sin este caso el índice sería vacuo', async () => {
    const n = await comoApp(async (ej) => {
      const cp = await crearContrapartida(ej, escenario.a, 'multiples_socios', 'decision_humana');
      await insertarMatch(ej, escenario.a.clienteId, cp, 'varios', escenario.socioA1);
      await insertarMatch(ej, escenario.a.clienteId, cp, 'varios', escenario.socioA2);
      const f = await ej(
        `select count(*)::text as n from reconocimiento_contrapartida_match where contrapartida_id = $1`,
        [cp],
      );
      return Number(f[0]?.['n'] ?? '-1');
    });
    // Es la mitad refutadora de M-B11/M-B12: sin ella, un índice único SIN el `where` parcial
    // pasaría los dos tests de arriba y rompería el hecho central de `multiples_socios`.
    expect(n, 'el índice parcial se comió `multiples_socios`: perdió el `where regimen_matches`').toBe(2);
  });

  it('L-B14b legítimo: el mismo socio por dos vías bajo `multiples_socios` también entra — `match_clase` VA en la clave', async () => {
    const n = await comoApp(async (ej) => {
      const cp = await crearContrapartida(ej, escenario.a, 'socio_fuera_de_vigencia', 'decision_humana');
      await insertarMatch(ej, escenario.a.clienteId, cp, 'varios', escenario.socioA1, 'cuit');
      await insertarMatch(ej, escenario.a.clienteId, cp, 'varios', escenario.socioA1, 'cbu');
      const f = await ej(
        `select count(*)::text as n from reconocimiento_contrapartida_match where contrapartida_id = $1`,
        [cp],
      );
      return Number(f[0]?.['n'] ?? '-1');
    });
    // Un CUIT identifica A LA PERSONA; un CBU identifica UNA CUENTA, que puede estar a nombre de
    // otro. Esa diferencia es evidencia que la persona tiene que ver, y por eso `match_clase` está
    // en `uq_recon_contrapartida_match_socio`. Sacarla de la clave pondría este caso en rojo.
    expect(n, '`match_clase` salió de la clave: dos vías del mismo socio dejaron de ser dos hechos').toBe(2);
  });
});

// =============================================================================
// BLOQUE C — la promoción
// =============================================================================
describe('0021 C — la promoción (4 mutaciones, 1 legítimo)', () => {
  it('M-C15 `es_socio` con `reconocimiento_clase = decision_humana` muere con `23514`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'decision_humana');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_socio',
          claseEspejada: 'decision_humana',
        });
      }),
    );
    // `es_socio` PROMUEVE (motor.ts:134-166): el padre tiene que haber quedado en `propuesta`.
    esperarRechazo(
      error,
      '23514',
      'contrapartida_promocion_chk',
      'un `es_socio` quedó sin promover y nadie lo va a ver en la cola como propuesta',
    );
  });

  it('M-C16 `sin_candidatos` con `reconocimiento_clase = propuesta` muere con `23514`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'sin_candidatos',
          claseEspejada: 'propuesta',
        });
      }),
    );
    // La dirección inversa, y es la peligrosa: un `sin_candidatos` promovido a propuesta se
    // presenta como listo para aceptar sin que capa C haya concluido nada.
    esperarRechazo(
      error,
      '23514',
      'contrapartida_promocion_chk',
      'un estado que NO concluye nada quedó presentado como propuesta lista',
    );
  });

  it('M-C17 🔴 un padre `sin_reconocer` con un estado NO promotor muere con `23514`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'sin_reconocer');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'sin_candidatos',
          claseEspejada: 'sin_reconocer',
        });
      }),
    );
    // Capa C sólo corre sobre `decision_humana` (`reconocer-lote.ts:283`): el padre de una
    // contrapartida NUNCA puede ser `sin_reconocer`.
    esperarRechazo(
      error,
      '23514',
      'contrapartida_promocion_chk',
      'una contrapartida colgó de un `sin_reconocer`, que capa C nunca evalúa',
    );
  });

  it('M-C17b 🔴 escrito como IGUALDAD DE BOOLEANOS, el mismo caso ENTRA — es lo que justifica el `CASE`', async () => {
    const error = await conDdlMutado(
      ['contrapartida_promocion_chk'],
      [
        'alter table reconocimiento_contrapartida drop constraint contrapartida_promocion_chk',
        // La forma tentadora, más corta y aparentemente equivalente.
        `alter table reconocimiento_contrapartida add constraint contrapartida_promocion_chk
           check ((resolucion_estado in ('es_socio','es_tercero_padron_completo'))
                  = (reconocimiento_clase = 'propuesta')) not valid`,
      ],
      async ({ ej, cuenta }) => {
        const padre = await crearReconocimiento(ej, cuenta, 'sin_reconocer');
        return capturar(() =>
          insertarContrapartida(ej, {
            clienteId: cuenta.clienteId,
            reconocimientoId: padre.id,
            estado: 'sin_candidatos',
            claseEspejada: 'sin_reconocer',
          }),
        );
      },
    );
    /**
     * 🔴 La fila ENTRA, porque `false = false` es `true`: la forma corta da VERDE a un padre
     * `sin_reconocer` con un estado no promotor. El `CASE` no es un gusto de estilo — es lo único
     * que ata la clase a un valor CONCRETO en cada rama en vez de a «no es propuesta».
     */
    expect(
      error,
      'con la igualdad de booleanos la fila NO entró: entonces el `CASE` no compra nada y el ' +
        'argumento del DDL es falso',
    ).toEqual(SIN_ERROR);
  });

  it('L-C18 legítimo: `sin_candidatos` + `decision_humana` ENTRA', async () => {
    const id = await comoApp(async (ej) => {
      const padre = await crearReconocimiento(ej, escenario.a, 'decision_humana');
      const f = await insertarContrapartida(ej, {
        clienteId: escenario.a.clienteId,
        reconocimientoId: padre.id,
        estado: 'sin_candidatos',
        claseEspejada: 'decision_humana',
      });
      return f[0]?.['id'];
    });
    expect(id, 'el camino normal de los cinco no promotores quedó rechazado').toBeTruthy();
  });
});

// =============================================================================
// BLOQUE D — la nulidad binaria de la manifestación
// =============================================================================
describe('0021 D — la nulidad binaria de la manifestación (3 mutaciones, 1 legítimo)', () => {
  it('M-D19 `es_tercero_padron_completo` SIN manifestación muere con `23514`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_tercero_padron_completo',
          claseEspejada: 'propuesta',
        });
      }),
    );
    // «sin padrón consultado, "no es socio" no es una conclusión: es ausencia de control»
    // (`04-imputacion-contable.md:270`). El único estado que usó el gate tiene que exhibir la premisa.
    esperarRechazo(
      error,
      '23514',
      'contrapartida_manifestacion_chk',
      'se concluyó "es un tercero" sin ninguna manifestación de padrón detrás',
    );
  });

  it('L-D20 🔴 legítimo: `sin_match_padron_incompleto` SIN manifestación ENTRA — es EL CASO QUE HOY PRODUCE EL 100% DEL CORPUS', async () => {
    const id = await comoApp(async (ej) => {
      const padre = await crearReconocimiento(ej, escenario.a, 'decision_humana');
      const f = await insertarContrapartida(ej, {
        clienteId: escenario.a.clienteId,
        reconocimientoId: padre.id,
        estado: 'sin_match_padron_incompleto',
        claseEspejada: 'decision_humana',
      });
      return f[0]?.['id'];
    });
    /**
     * 🔴 Ese estado ES la rama en la que el gate dio `false` (`contrapartida.ts:202-205`), y hoy ese
     * `false` es un LITERAL (`reconocer-lote.ts:288`): no hay manifestación que citar y NULL es el
     * valor verdadero. Con la forma que el plan proponía —`not null` exigido también acá— este test
     * se pone ROJO, y `reconocer:lote --aplicar` abortaría el LOTE ENTERO en la primera corrida
     * contra el piloto. Es la mutación M-D20b.
     */
    expect(id, 'el estado que produce el 100% del corpus quedó rechazado por el esquema').toBeTruthy();
  });

  it('M-D20b 🔴 con la manifestación exigida también en `sin_match_padron_incompleto`, el caso legítimo se pone ROJO', async () => {
    const error = await conDdlMutado(
      ['contrapartida_manifestacion_chk'],
      [
        'alter table reconocimiento_contrapartida drop constraint contrapartida_manifestacion_chk',
        // La forma del plan original (`0021-plan-de-sesion.md:369`), que tres agentes encontraron
        // insatisfacible por separado.
        `alter table reconocimiento_contrapartida add constraint contrapartida_manifestacion_chk
           check ((resolucion_estado in ('es_tercero_padron_completo','sin_match_padron_incompleto'))
                    = (padron_manifestacion_id is not null)
                  and (resolucion_estado in ('es_tercero_padron_completo','sin_match_padron_incompleto'))
                    = (padron_completo_hasta is not null)) not valid`,
      ],
      async ({ ej, cuenta }) => {
        const padre = await crearReconocimiento(ej, cuenta, 'decision_humana');
        return capturar(() =>
          insertarContrapartida(ej, {
            clienteId: cuenta.clienteId,
            reconocimientoId: padre.id,
            estado: 'sin_match_padron_incompleto',
            claseEspejada: 'decision_humana',
          }),
        );
      },
    );
    // Éste es el rojo que hay que ver: mide el COSTO de la forma descartada, en el único estado que
    // el sistema produce hoy.
    esperarRechazo(
      error,
      '23514',
      'contrapartida_manifestacion_chk',
      'la forma descartada del check NO rechaza el 100% del corpus: entonces la medición que la ' +
        'descartó es falsa y la decisión hay que revisarla',
    );
  });

  it('M-D21 `es_socio` CON manifestación muere con `23514` — una fila no exhibe una premisa que no usó', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_socio',
          claseEspejada: 'propuesta',
          manifestacionId: escenario.manA,
          completoHasta: ALCANCE_A,
        });
      }),
    );
    // `es_socio` sale de la rama que NO consulta el gate: adjuntarle una manifestación sería
    // afirmar una evidencia que no participó de la conclusión.
    esperarRechazo(
      error,
      '23514',
      'contrapartida_manifestacion_chk',
      'una resolución exhibe una premisa que no usó: la evidencia dice más de lo que sostiene',
    );
  });
});

// =============================================================================
// BLOQUE E — la satélite y el aislamiento
// =============================================================================
describe('0021 E — la satélite y el aislamiento (8 mutaciones, 1 legítimo)', () => {
  it('M-E22 🔴 un match colgado de un `sin_candidatos` es IMPOSIBLE por los TRES caminos, y cada uno lo ataja un mecanismo distinto', async () => {
    const errores = await comoApp(async (ej) => {
      const cp = await crearContrapartida(ej, escenario.a, 'sin_candidatos', 'decision_humana');
      return {
        socioUnico: await capturarAislado(ej, () =>
          insertarMatch(ej, escenario.a.clienteId, cp, 'socio_unico', escenario.socioA1),
        ),
        varios: await capturarAislado(ej, () =>
          insertarMatch(ej, escenario.a.clienteId, cp, 'varios', escenario.socioA1),
        ),
        sinMatches: await capturarAislado(ej, () =>
          insertarMatch(ej, escenario.a.clienteId, cp, 'sin_matches', escenario.socioA1),
        ),
      };
    });

    // Declarando un régimen que ADMITE matches, lo ataja la FK de la GENERADA BOOLEANA — por
    // mecanismo, no por valor: `admite_matches` de la hija es `generated always as (true)` y el
    // padre `sin_candidatos` la tiene en `false`.
    esperarRechazo(
      errores.socioUnico,
      '23503',
      'fk_recon_contrapartida_match_padre',
      'un match colgó de un padre que no admite matches',
    );
    esperarRechazo(
      errores.varios,
      '23503',
      'fk_recon_contrapartida_match_padre',
      'un match colgó de un padre que no admite matches',
    );
    // Declarando `sin_matches` —el valor que el padre SÍ tiene— la FK de régimen lo ACEPTARÍA, y
    // lo único que queda es el `check`. Es la medición que obliga a conservar la booleana.
    esperarRechazo(
      errores.sinMatches,
      '23514',
      'contrapartida_match_regimen_chk',
      'entró un match declarando el régimen `sin_matches`',
    );
  });

  it('M-E22b 🔴 sin el `check` de régimen, la FK de la generada booleana sigue rechazando — el `check` es RED, no la garantía', async () => {
    const error = await conDdlMutado(
      ['contrapartida_match_regimen_chk'],
      [
        'alter table reconocimiento_contrapartida_match drop constraint contrapartida_match_regimen_chk',
      ],
      async ({ ej, cuenta }) => {
        const cp = await crearContrapartida(ej, cuenta, 'sin_candidatos', 'decision_humana');
        return capturar(() =>
          insertarMatch(ej, cuenta.clienteId, cp, 'sin_matches', escenario.socioA1),
        );
      },
    );
    /**
     * 🔴 La FK de RÉGIMEN sola no alcanza —el padre `sin_candidatos` EXISTE en
     * `uq_recon_contrapartida_regimen` con el valor `'sin_matches'`, así que esa FK lo aceptaría—, y
     * con el `check` mutado lo único que queda en pie es `fk_recon_contrapartida_match_padre`. Si
     * este test diera «entró», `admite_matches` sería decorativa y el `check` sería load-bearing:
     * exactamente el defecto que `0014:671-679` describe.
     */
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_match_padre',
      'sin el check de régimen, un match entró bajo un `sin_candidatos`: `admite_matches` no ' +
        'sostiene nada y el control real era el check',
    );
  });

  it('M-E23 🔴 un `socio_id` de OTRO cliente muere con `23503` — es la razón de ser de la satélite frente a un `uuid[]`', async () => {
    const errores = await comoApp(async (ej) => {
      const cp = await crearContrapartida(ej, escenario.a, 'es_socio', 'propuesta');
      return {
        deOtroCliente: await capturarAislado(ej, () =>
          insertarMatch(ej, escenario.a.clienteId, cp, 'socio_unico', escenario.socioB1),
        ),
        inexistente: await capturarAislado(ej, () =>
          insertarMatch(ej, escenario.a.clienteId, cp, 'socio_unico', OTRO_UUID_INEXISTENTE),
        ),
      };
    });

    // Se arma con `USUARIOS.socio`, con membresía en A y en B: la RLS no lo frena y sólo queda la FK.
    esperarRechazo(
      errores.deOtroCliente,
      '23503',
      'fk_recon_contrapartida_match_socio',
      'un match apuntó al socio de otro cliente: un `uuid[]` habría dejado pasar exactamente esto',
    );
    // ⚠️ Y NO FILTRA EXISTENCIA CROSS-TENANT, que es la propiedad deseable: el socio de otro cliente
    // y el socio inexistente dan el MISMO error. Se asserta la igualdad para que nadie "mejore" el
    // diagnóstico distinguiéndolos, que sería un oráculo de existencia entre estudios.
    expect(
      { code: errores.inexistente.code, constraint: errores.inexistente.constraint },
      'el error de un socio de otro cliente se distingue del de un socio inexistente: es un ' +
        'oráculo de existencia cross-tenant',
    ).toEqual({ code: errores.deOtroCliente.code, constraint: errores.deOtroCliente.constraint });
  });

  it('M-E24 🔴 `admite_matches` no se puede escribir NI CON EL VALOR CORRECTO — rechaza el MECANISMO, no el valor', async () => {
    const errores = await comoApp(async (ej) => {
      const cp = await crearContrapartida(ej, escenario.a, 'es_socio', 'propuesta');
      return {
        satelite: await capturarAislado(ej, () =>
          ej(
            `insert into reconocimiento_contrapartida_match
               (cliente_id, contrapartida_id, admite_matches, regimen_matches, socio_id, match_clase)
             values ($1, $2, true, 'socio_unico', $3, 'cuit')`,
            [escenario.a.clienteId, cp, escenario.socioA1],
          ),
        ),
        padre: await capturarAislado(ej, () =>
          ej(
            `insert into reconocimiento_contrapartida
               (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase,
                admite_matches, resuelto_a_fecha)
             values ($1, $2, 'es_socio', 'propuesta', true, '2026-06-15')`,
            [escenario.a.clienteId, UUID_INEXISTENTE],
          ),
        ),
      };
    });

    /**
     * `428C9` = `cannot insert a non-DEFAULT value into column`. El valor `true` es EL CORRECTO para
     * la satélite y aun así se rechaza: es más fuerte que `default` + `check`, donde la garantía
     * depende de que el check siga diciendo lo mismo. Se afirma el código exacto, no el mensaje.
     */
    expect(errores.satelite.code, 'la generada constante de la satélite se pudo escribir').toBe('428C9');
    expect(errores.padre.code, 'la generada del padre se pudo escribir').toBe('428C9');
    // Y el rechazo llega ANTES de mirar la fila: el `reconocimiento_id` del segundo caso ni existe.
    expect(errores.padre.constraint, 'el rechazo vino de un constraint y no del mecanismo de la generada').toBeNull();
  });

  it('L-E24b legítimo: la satélite escrita SIN nombrar `admite_matches` entra, y la generada queda en `true`', async () => {
    const valor = await comoApp(async (ej) => {
      const cp = await crearContrapartida(ej, escenario.a, 'es_socio', 'propuesta');
      await insertarMatch(ej, escenario.a.clienteId, cp, 'socio_unico', escenario.socioA1);
      const f = await ej(
        `select admite_matches, regimen_matches from reconocimiento_contrapartida_match
          where contrapartida_id = $1`,
        [cp],
      );
      return f[0];
    });
    // Sin este caso, M-E24 sería compatible con «la satélite no se puede escribir de ninguna forma».
    expect(valor, 'el camino normal de la satélite quedó roto').toEqual({
      admite_matches: true,
      regimen_matches: 'socio_unico',
    });
  });
});

// =============================================================================
// BLOQUE F — el determinante y la foto histórica
// =============================================================================

/**
 * Las diez filas sintéticas del bloque F, con su digest ESPERADO como literal.
 *
 * 🔴 Los 16 hex van escritos, no calculados dentro del test: si se comparara sólo «SQL === TS», una
 * mutación que rompiera LAS DOS a la vez —cambiar el separador, o el orden de los campos, en los dos
 * lados— quedaría verde. El literal ancla la fórmula a un valor y no a la coincidencia.
 *
 * Ni un valor del material real: `CONCEPTO`, `ACRED` y `PAGO 💰 FIN` no existen en ningún léxico.
 */
const FILAS_DEL_DIGEST: readonly {
  readonly nombre: string;
  readonly cols: Partial<ColumnasDeMovimiento>;
  readonly digest: string;
}[] = [
  { nombre: 'la fila base', cols: {}, digest: '865a013ecab8feb1' },
  {
    // 🔴 El carácter FUERA DEL PLANO BÁSICO: `length()` en Postgres cuenta 10 caracteres y
    // `String.length` en JavaScript cuenta 11 unidades UTF-16. Es la divergencia que encontró la
    // mutación M8 de P0, y sin esta fila las dos gemelas podrían diferir sin que nada lo dijera.
    nombre: 'un emoji fuera del plano básico',
    cols: { conceptoBanco: 'PAGO \u{1F4B0} FIN' },
    digest: '90b04e0ce8082693',
  },
  {
    nombre: 'importe positivo: el digest va sobre el SIGNO',
    cols: { importe: '250.50', conceptoBanco: 'ACRED' },
    digest: 'cac5c0e2ce67662c',
  },
  {
    nombre: 'sin concepto capturado (`no_publicado`)',
    cols: { conceptoBanco: null, conceptoCompleto: null, conceptoBancoEstrategia: 'no_publicado' },
    digest: '31987648017803b4',
  },
  {
    // ⚠️ MISMO DIGEST que la fila anterior, y es a propósito: las dos estrategias que significan
    // «no hay concepto» colapsan al `-:` de la rama ausente, igual que `lecturas.ts` las colapsa a
    // `undefined` antes de entregárselas al motor. Consecuencia declarada: un movimiento que pasa de
    // `no_capturado` a `no_publicado` NO mueve `entrada_digest` y NO supersede — correcto, porque el
    // motor no puede leer esa diferencia.
    nombre: 'sin concepto capturado (`no_capturado`) — MISMO digest, a propósito',
    cols: { conceptoBanco: null, conceptoCompleto: null, conceptoBancoEstrategia: 'no_capturado' },
    digest: '31987648017803b4',
  },
  {
    nombre: '`concepto_codigo` cargado',
    cols: { conceptoCodigo: '0367' },
    digest: 'b9e6d8a6bd31e58d',
  },
  {
    nombre: '`concepto_completo` en false, con prefijo anclado',
    cols: {
      conceptoCompleto: false,
      descripcion: 'CONCEPTO Y COLA',
      conceptoBancoEstrategia: 'prefijo_anclado',
    },
    digest: '046916a2d2481a67',
  },
  {
    nombre: 'captura `sin_identificador`',
    cols: { contraparteCaptura: 'sin_identificador' },
    digest: '3bb86e274aceedf5',
  },
  {
    // El `lpad` de la fecha: mes y día de UN dígito tienen que salir con su cero adelante, o la
    // cadena legible que hashea TypeScript deja de coincidir.
    nombre: 'fecha con mes y día de un dígito',
    cols: { fecha: '2026-01-02' },
    digest: '146698f333a38fea',
  },
  {
    nombre: 'acentos y eñe (multibyte dentro del plano básico)',
    cols: { conceptoBanco: 'COMISIÓN AÑO' },
    digest: 'aedf6f3994add1e9',
  },
];

/** La entrada que el motor LEE de una fila cruda, armada igual que `lecturas.ts`. */
function entradaDe(movimientoId: string, cols: ColumnasDeMovimiento): EntradaDelMovimiento {
  const estrategia = cols.conceptoBancoEstrategia;
  return {
    movimientoId,
    bancoCodigo: BANCO,
    columnaOrigen: Number(cols.importe) < 0 ? 'debito' : 'credito',
    conceptoBanco: cols.conceptoBanco ?? undefined,
    conceptoCompleto: cols.conceptoCompleto ?? undefined,
    conceptoBancoEstrategia:
      estrategia === 'no_capturado' || estrategia === 'no_publicado'
        ? undefined
        : (estrategia as 'segmento_de_glosa' | 'prefijo_anclado' | 'columna_propia'),
    conceptoCodigo: cols.conceptoCodigo ?? undefined,
    fecha: cols.fecha,
    contraparteCaptura: cols.contraparteCaptura as EntradaDelMovimiento['contraparteCaptura'],
  };
}

describe('0021 F — el determinante y la foto histórica (2 mutaciones, 2 legítimos)', () => {
  it('L-F25 legítimo: `entrada_digest` de la base ≡ `digestDeEntrada()` de TypeScript en las 10 filas, contra el literal esperado', async () => {
    const medido = await comoApp(async (ej) => {
      const filas: { nombre: string; sql: string; ts: string; esperado: string }[] = [];
      for (const caso of FILAS_DEL_DIGEST) {
        const mov = await crearMovimiento(ej, escenario.a, caso.cols);
        const cols = { ...MOVIMIENTO_BASE, ...caso.cols };
        filas.push({
          nombre: caso.nombre,
          sql: mov.entradaDigest,
          ts: digestDeEntrada(entradaDe(mov.id, cols)),
          esperado: caso.digest,
        });
      }
      return filas;
    });

    // Aserción exacta y por fila: nada de «todas coinciden», que oculta CUÁL divergió.
    for (const f of medido) {
      expect(f.sql, `la columna generada divergió del literal esperado en: ${f.nombre}`).toBe(f.esperado);
      expect(f.ts, `digestDeEntrada() divergió del literal esperado en: ${f.nombre}`).toBe(f.esperado);
    }
    expect(medido, 'faltó ejercitar alguna de las diez filas').toHaveLength(10);
  });

  it('M-F25b 🔴 con `.length` UTF-16 en vez de puntos de código, la fila del emoji DIVERGE — la mutación que encontró M8', async () => {
    const glosa = 'PAGO \u{1F4B0} FIN';
    expect([...glosa].length, 'la glosa dejó de tener un carácter fuera del plano básico').toBe(10);
    expect(glosa.length, 'la glosa dejó de tener un carácter fuera del plano básico').toBe(11);

    // La gemela DEFECTUOSA: idéntica a `proyeccionDeEntrada()` salvo `.length` pelado.
    const enmarcarMal = (v: unknown): string =>
      v === null || v === undefined ? '-:' : String(v).length + ':' + String(v);
    const entrada = entradaDe('00000000-0000-4000-8000-000000000001', {
      ...MOVIMIENTO_BASE,
      conceptoBanco: glosa,
    });
    const claves = Object.keys(entrada)
      .sort()
      .filter((k) => k !== 'movimientoId' && k !== 'bancoCodigo');
    const proyeccionMala = claves
      .map((k) => enmarcarMal((entrada as Record<string, unknown>)[k]))
      .join('|');
    const digestMalo = createHash('md5').update(proyeccionMala, 'utf8').digest('hex').slice(0, 16);

    expect(
      digestMalo,
      'la mutación UTF-16 da el MISMO digest: entonces la fila del emoji no ejercita nada y el ' +
        'test de L-F25 quedaría verde con `.length` pelado',
    ).not.toBe('90b04e0ce8082693');
  });

  it('L-F26 legítimo: un `UPDATE` de `concepto_banco` MUEVE `entrada_digest` y NO mueve la foto del reconocimiento', async () => {
    const r = await comoApp(async (ej) => {
      const padre = await crearReconocimiento(ej, escenario.a, 'propuesta');
      const antes = padre.entradaDigest;
      await ej(`update movimiento_bancario_crudo set concepto_banco = 'CONCEPTO OTRO' where id = $1`, [
        padre.movimientoId,
      ]);
      const f = await una(
        ej,
        `select m.entrada_digest as movimiento, r.entrada_digest as foto
           from movimiento_bancario_crudo m
           join reconocimiento_movimiento r
             on r.cliente_id = m.cliente_id and r.movimiento_id = m.id
          where m.id = $1`,
        [padre.movimientoId],
      );
      return { antes, movimiento: String(f['movimiento']), foto: String(f['foto']) };
    });

    /**
     * Las dos mitades, y las dos son necesarias:
     *   - la generada SE RECALCULA (es lo que hace que un reproceso detecte el cambio);
     *   - la foto NO se mueve (es lo que hace que la interpretación ya emitida siga diciendo con qué
     *     entrada se emitió). Una FK con `cascade` habría reescrito la segunda en silencio — medido,
     *     y es el motivo por el que el invariante baja al trigger y no a una FK.
     */
    expect(r.movimiento, 'la columna generada NO se recalculó al cambiar la entrada').not.toBe(r.antes);
    expect(r.foto, 'la foto histórica del reconocimiento se movió: dejó de ser histórica').toBe(r.antes);
  });

  it('M-F27 🔴 mismo `motor_digest`, misma `clase`, ENTRADA CAMBIADA: NO es no-op, supersede — el bug de los 64 movimientos', async () => {
    const DIGEST_FIJO = 'aaaaaaaaaaaaaaaa';

    const r = await conUsuario(USUARIOS.socio, async (tx) => {
      const ej = desdeTx(tx);
      const mov = await crearMovimiento(ej, escenario.a, { conceptoBanco: 'CONCEPTO VIEJO' });

      const pedido = (id: string): PedidoDePersistirReconocimiento => ({
        clienteId: escenario.a.clienteId,
        movimientoId: mov.id,
        reconocimientoId: id,
        motorDigest: DIGEST_FIJO,
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
        candidatos: [] as readonly string[],
      });

      const escribir = (p: PedidoDePersistirReconocimiento) =>
        escribirConAuditoria(
          tx,
          {
            clienteId: p.clienteId,
            accion: 'escritura',
            recurso: 'reconocimiento_movimiento',
            motivo: 'prueba de mutación del determinante de 0021',
          },
          (ctx) => persistirReconocimiento(tx, ctx, p),
        );

      const primera = await escribir(pedido(randomUUID()));

      // Un reproceso que NO cambió nada: el no-op verdadero. Es el caso legítimo del par.
      const noOp = await escribir(pedido(randomUUID()));

      // 🔴 Ahora la ENTRADA cambia (es exactamente lo que hace `recapturar-conceptos.ts`), y el
      // léxico y la clase quedan IGUALES.
      await ej(`update movimiento_bancario_crudo set concepto_banco = 'CONCEPTO NUEVO' where id = $1`, [
        mov.id,
      ]);
      const conEntradaNueva = await escribir(pedido(randomUUID()));

      const total = await una(
        ej,
        `select count(*)::text as n from reconocimiento_movimiento where movimiento_id = $1`,
        [mov.id],
      );
      const vigente = await una(
        ej,
        `select entrada_digest from reconocimiento_movimiento
          where movimiento_id = $1 and superseded_por is null`,
        [mov.id],
      );
      const actual = await una(
        ej,
        `select entrada_digest from movimiento_bancario_crudo where id = $1`,
        [mov.id],
      );

      return {
        primera: primera.estado,
        noOp: noOp.estado,
        conEntradaNueva: conEntradaNueva.estado,
        total: Number(total['n']),
        vigente: String(vigente['entrada_digest']),
        actual: String(actual['entrada_digest']),
      };
    });

    /**
     * 🔴 EL BUG QUE TODA LA MIGRACIÓN EXISTE PARA CERRAR, medido en 64 movimientos del corpus real:
     * un reproceso que cambia la entrada sin cambiar la clase daba `no_op` y dejaba la
     * interpretación VIEJA intacta. Fail-open y silencioso — el reporte imprimía `noOp: N,
     * creados: 0` y parecía que había salido bien.
     *
     * MUTACIÓN OBLIGATORIA de este test: sacar la tercera condición del corto-circuito de
     * `escrituras.ts` (`activa.entrada_persistida === activa.entrada_actual`) y verificar que
     * `conEntradaNueva` pase de `supersedido` a `no_op`. Corrida y confirmada: con la condición
     * fuera, este `it` es el ÚNICO que se pone rojo en toda la suite.
     */
    expect(r.primera, 'la primera escritura no creó').toBe('creado');
    expect(r.noOp, 'el no-op verdadero (nada cambió) dejó de serlo: toda corrida escribiría fila nueva').toBe(
      'no_op',
    );
    expect(
      r.conEntradaNueva,
      'un reproceso con la ENTRADA cambiada dio no-op: la interpretación vieja queda intacta y en ' +
        'silencio — es el bug de los 64 movimientos, vivo',
    ).toBe('supersedido');
    // Y el viejo no se borra: dos filas, la vigente con la entrada de HOY.
    expect(r.total, 'la supersesión borró en vez de conservar').toBe(2);
    expect(r.vigente, 'la fila vigente no quedó con la entrada actual del movimiento').toBe(r.actual);
  });
});

// =============================================================================
// BLOQUE G — lo que el BARRIDO encontró sin cobertura
//
// Los dos controles que se podían BORRAR de la base sin que un solo test de los bloques A–F se
// pusiera rojo. Un control que ningún test detecta es cobertura aparente, y la única forma de
// enterarse es retirarlo y contar. Va como bloque propio para que el hallazgo no se diluya.
// =============================================================================
describe('0021 G — lo que el barrido encontró sin cobertura (6 mutaciones, 1 legítimo)', () => {
  it('M-G28 🔴 un padre `es_socio` con la hija declarando `varios` muere por `fk_recon_contrapartida_match_regimen` — y es el BYPASS del índice de cardinalidad', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const cp = await crearContrapartida(ej, escenario.a, 'es_socio', 'propuesta');
        // El padre es `socio_unico`; la hija DECLARA `varios`.
        return insertarMatch(ej, escenario.a.clienteId, cp, 'varios', escenario.socioA1);
      }),
    );
    /**
     * 🔴 EL HALLAZGO DEL BARRIDO, y no es cosmético. `uq_recon_contrapartida_match_socio_unico` es
     * un índice PARCIAL: `where regimen_matches = 'socio_unico'`. O sea que un escritor que declare
     * `'varios'` sobre un padre `es_socio` queda **FUERA del índice** y podría meter DOS SOCIOS
     * distintos bajo un `es_socio` — exactamente el error «sin detector aguas abajo y sin
     * reclamante» que el índice existe para cerrar.
     *
     * Lo único que lo cierra es esta FK: `fk_recon_contrapartida_match_padre` (la booleana) PASA
     * —el padre admite matches— y `contrapartida_match_regimen_chk` PASA —`'varios'` está en el
     * dominio—. **La FK por VALOR no es un cinturón de más: es la que sostiene la cardinalidad.**
     * Sin este test, `fk_recon_contrapartida_match_regimen` se podía borrar del esquema y la suite
     * quedaba verde con el bypass abierto (medido por el barrido: 0 rojos).
     */
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_match_regimen',
      'una hija declaró un régimen distinto del del padre: con `varios` sobre un `es_socio` el ' +
        'índice parcial NO aplica y entran dos socios',
    );
  });

  it('M-G29 un padre `multiples_socios` con la hija declarando `socio_unico` muere por la misma FK — la dirección inversa', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const cp = await crearContrapartida(ej, escenario.a, 'multiples_socios', 'decision_humana');
        return insertarMatch(ej, escenario.a.clienteId, cp, 'socio_unico', escenario.socioA1);
      }),
    );
    // Hacen falta las dos direcciones: una FK que sólo atajara una mitad dejaría la otra viva, y acá
    // la mentira es al revés — presentar como «un solo socio» una evidencia de varios.
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_match_regimen',
      'una hija declaró `socio_unico` bajo un padre de varios socios',
    );
  });

  it('M-G30 un OCTAVO estado inventado muere por `contrapartida_estado_chk`', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'decision_humana');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'sin_datos_del_padron', // no existe en `ESTADOS_RESOLUCION`
          claseEspejada: 'decision_humana',
        });
      }),
    );
    /**
     * `catalogo.test.ts` ya compara la DEFINICIÓN de este check contra `ESTADOS_RESOLUCION`, pero eso
     * es ESTRUCTURA: mide que el texto del check coincida con la constante. Nadie medía la CONDUCTA,
     * y por eso el barrido pudo borrar el check con este archivo entero en verde.
     */
    esperarRechazo(
      error,
      '23514',
      'contrapartida_estado_chk',
      'entró un estado que no es ninguno de los siete de `ESTADOS_RESOLUCION`',
    );
  });

  it('M-G31 🔴 sin el check de estado, el octavo estado ENTRA y nace con `admite_matches = false` — el «rompe en silencio» del `comment`, medido', async () => {
    const fila = await conDdlMutado(
      ['contrapartida_estado_chk'],
      ['alter table reconocimiento_contrapartida drop constraint contrapartida_estado_chk'],
      async ({ ej, cuenta }) => {
        const padre = await crearReconocimiento(ej, cuenta, 'decision_humana');
        const f = await ej(
          `insert into reconocimiento_contrapartida
             (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase, resuelto_a_fecha)
           values ($1, $2, 'sin_datos_del_padron', 'decision_humana', '2026-06-15')
           returning resolucion_estado, admite_matches, regimen_matches`,
          [cuenta.clienteId, padre.id],
        );
        return f[0];
      },
    );
    /**
     * 🔴 Lo que se asserta NO es sólo que entre: es CÓMO entra. Las dos generadas resuelven por la
     * rama `else`, así que un estado desconocido nace declarando «no admito matches» y «régimen
     * sin_matches» — con total confianza y sin que nada avise. Es literal el modo de falla que el
     * `comment on table` describe para la regla enunciada «por estado» en vez de «por evaluación»:
     * el octavo estado que «no dice nada» rompe EN SILENCIO la lectura «presencia = capa C evaluó».
     * Por eso el dominio cerrado va sobre LOS SIETE y no sobre los alcanzables.
     */
    expect(
      fila,
      'el octavo estado no entró sin el check: entonces algo más lo ataja y el dominio cerrado no ' +
        'es el control que se cree que es',
    ).toEqual({
      resolucion_estado: 'sin_datos_del_padron',
      admite_matches: false,
      regimen_matches: 'sin_matches',
    });
  });

  it('M-G32 una SEGUNDA contrapartida sobre el mismo reconocimiento muere por `uq_recon_contrapartida_reconocimiento` (la 1:0..1)', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'decision_humana');
        await insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'sin_candidatos',
          claseEspejada: 'decision_humana',
        });
        // La segunda pasada de capa C sobre el mismo reconocimiento es un bug del productor, no un dato.
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'sin_match_padron_incompleto',
          claseEspejada: 'decision_humana',
        });
      }),
    );
    // Sin esto, dos evaluaciones contradictorias del mismo movimiento convivirían y la cola mostraría
    // la que el `order by` decidiera.
    esperarRechazo(
      error,
      '23505',
      'uq_recon_contrapartida_reconocimiento',
      'un reconocimiento quedó con DOS resoluciones de capa C a la vez',
    );
  });

  it('M-G33 espejar `propuesta` sobre un padre `decision_humana` muere por `fk_recon_contrapartida_reconocimiento` — el espejo de la clase es INFALSIFICABLE', async () => {
    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearReconocimiento(ej, escenario.a, 'decision_humana');
        return insertarContrapartida(ej, {
          clienteId: escenario.a.clienteId,
          reconocimientoId: padre.id,
          estado: 'es_socio', // coherente con `propuesta` para el check de promoción…
          claseEspejada: 'propuesta', // …pero el padre real es `decision_humana`
        });
      }),
    );
    /**
     * El caso está construido para que `contrapartida_promocion_chk` PASE: `es_socio` + `propuesta`
     * es una combinación legítima. Lo que falla es la FK de TRES columnas contra `uq_recon_clase`
     * (`0014:451`): el valor escrito no coincide con la clase REAL del padre, no encuentra fila y
     * muere. La garantía es REFERENCIAL, no un check — y sin este test, un `reconocimiento_clase`
     * mentido pasaría los cuatro checks de la tabla.
     */
    esperarRechazo(
      error,
      '23503',
      'fk_recon_contrapartida_reconocimiento',
      'se pudo espejar una clase distinta de la del padre: `reconocimiento_clase` es falsificable',
    );
  });

  it('L-G34 legítimo: la hija que declara EL MISMO régimen del padre entra en los tres regímenes que admiten matches', async () => {
    const filas = await comoApp(async (ej) => {
      const resultado: { estado: string; regimen: unknown }[] = [];
      for (const [estado, clase, regimen] of [
        ['es_socio', 'propuesta', 'socio_unico'],
        ['multiples_socios', 'decision_humana', 'varios'],
        ['socio_fuera_de_vigencia', 'decision_humana', 'varios'],
      ] as const) {
        const cp = await crearContrapartida(ej, escenario.a, estado, clase);
        await insertarMatch(ej, escenario.a.clienteId, cp, regimen, escenario.socioA1);
        const f = await una(
          ej,
          `select regimen_matches from reconocimiento_contrapartida_match where contrapartida_id = $1`,
          [cp],
        );
        resultado.push({ estado, regimen: f['regimen_matches'] });
      }
      return resultado;
    });
    // La mitad refutadora de M-G28/M-G29: sin ella, una FK de régimen que rechazara TODO pasaría las
    // dos mutaciones de arriba y dejaría la satélite inescribible.
    expect(filas, 'un régimen legítimo quedó rechazado por la FK de valor').toEqual([
      { estado: 'es_socio', regimen: 'socio_unico' },
      { estado: 'multiples_socios', regimen: 'varios' },
      { estado: 'socio_fuera_de_vigencia', regimen: 'varios' },
    ]);
  });
});
