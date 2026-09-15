/**
 * `agruparDecisionesPendientes` (Frente 1, backend genérico de agrupación) — contra base real.
 *
 * Cubre: rol insuficiente ANTES de cualquier select de dominio (spy de queries), `cliente_id_invalido`
 * sin tocar la base, `demasiadas_filas` (tope real, `MAX_FILAS` de `armar-libro.ts`), agrupación
 * correcta (montos como string, `cuentaPropuesta` por unanimidad, `requiereRevision`), y la prueba EN
 * VIVO de aislamiento con dos usuarios reales (mismo estándar que `mutaciones-0043-confirmacion-
 * grupo.test.ts`).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup, corriendo contra LOCAL.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conJob, conUsuario, type Tx } from '@sistema-contable/data';
import { agruparDecisionesPendientes } from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';

let s: Sembrado;
let filaSeq = 0;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

const BANCO_CODIGO = 'banco_agrupar_decisiones';
const DESDE = '2026-06-01';
const HASTA = '2026-06-30';

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

/** Cuenta las llamadas a `tx.consultar` — para verificar que el chequeo de rol corre ANTES de
 *  cualquier select de dominio (y que, al abortar, no corrió NINGÚN otro). */
function conEspiaDeQueries(tx: Tx): { readonly tx: Tx; readonly consultas: () => readonly string[] } {
  const consultas: string[] = [];
  const espiado: Tx = {
    usuarioId: tx.usuarioId,
    consultar: (sql, params) => {
      consultas.push(sql);
      return tx.consultar(sql, params);
    },
  };
  return { tx: espiado, consultas: () => consultas };
}

/** Un cliente sintético propio por bloque — evita interferencia con otras suites que comparten
 *  `s.clienteA`/`s.clienteB`. Mismo patrón que `alta-regla-imputacion.test.ts::clienteFresco`. */
async function clienteFresco(nombre: string): Promise<{ clienteId: string; cuentaBancariaId: string }> {
  const duenio = await clienteDuenio();
  let clienteId = '';
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      BANCO_CODIGO,
      'Banco Ficticio Agrupar Decisiones',
    ]);
    const f = await duenio.query<{ id: string }>(
      `insert into tenant_node (tipo, nombre, parent_id) values ('cliente', $1, $2) returning id`,
      [nombre, s.estudio],
    );
    clienteId = f.rows[0]?.id ?? '';
  } finally {
    await duenio.end();
  }

  return conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    // Membresía de `contador` para este cliente nuevo — `socio` (dueño del estudio) ya alcanza por
    // jerarquía de `path`, pero se agrega `contadorFresco` explícito más abajo por test cuando hace
    // falta un usuario SIN acceso al resto del estudio.
    const cuenta = await una(
      ej,
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, $2, 'ARS') returning id::text as id`,
      [clienteId, BANCO_CODIGO],
    );
    return { clienteId, cuentaBancariaId: String(cuenta['id']) };
  });
}

async function agregarMembresiaContador(clienteId: string, userId: string): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'contador'::app.rol_membership)`,
      [userId, clienteId],
    );
  } finally {
    await duenio.end();
  }
}

/** Un movimiento `propuesta`/`decision_humana` real, con su `reconocimiento_movimiento`. Este archivo
 *  está en `PERMITIDOS_PROPUESTA` de R-F (`reglas-de-codigo.test.ts`) por el mismo motivo exacto que
 *  `aislamiento-modulo-2.test.ts`/`persistencia-contrapartida-0038.test.ts`: construye el PEDIDO de
 *  persistencia (columnas de un `insert` SQL directo) para sembrar el fixture, nunca un objeto
 *  `Reconocimiento` armado a mano en código de producción — el riesgo que R-F cubre no existe acá. */
async function crearMovimiento(args: {
  readonly clienteId: string;
  readonly cuentaBancariaId: string;
  readonly conceptoBanco: string;
  readonly importe: string;
  readonly fecha: string;
  readonly clase: 'propuesta' | 'decision_humana';
  // `reconocimiento_forma_chk` (0014) exige tipo/concepto/polaridad/lado los CUATRO no nulos para
  // 'propuesta' Y para 'decision_humana' — nunca `tipo: null` salvo `clase: 'sin_reconocer'` (fuera
  // de este fixture, no lo necesita ningún test de este archivo).
  readonly tipo: string;
  // Obligatorio (no nulo) cuando `clase === 'decision_humana'` (mismo check); tiene que ser distinto
  // de 'distinguir_tercero_de_socio' para que el movimiento siga siendo `agrupable` (el único valor
  // que `esAgrupable()` excluye).
  readonly queDecide: string | null;
}): Promise<string> {
  filaSeq += 1;
  return conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const lote = await una(
      ej,
      `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
       values ($1, $2, 'agrupar-decisiones-pendientes@fixture', 'archivo', $3, 'procesado', true) returning id::text as id`,
      [args.clienteId, BANCO_CODIGO, randomUUID()],
    );
    await ej(
      `insert into lote_ingesta_cuenta (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
       values ($1, $2, $3, $4::date, $4::date, 'no_verificable')`,
      [args.clienteId, String(lote['id']), args.cuentaBancariaId, args.fecha],
    );
    // 'columna_propia' para concepto_banco_estrategia: exenta del check de prefijo sobre
    // descripcion (mov_crudo_concepto_prefijo_chk / INV-14, 0007_concepto_banco.sql) — el
    // fixture no depura ninguna glosa real, así que no puede cumplir "prefijo de descripcion".
    const movimiento = await una(
      ej,
      `insert into movimiento_bancario_crudo
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
          concepto_banco, concepto_banco_estrategia, concepto_completo, importe, contraparte_captura)
       values ($1, $2, $3, $4, $5, $6::date, 'movimiento fixture agrupar-decisiones-pendientes', $7,
               'columna_propia', true, $8, 'no_capturado')
       returning id::text as id, entrada_digest`,
      [args.clienteId, String(lote['id']), args.cuentaBancariaId, filaSeq, randomUUID(), args.fecha, args.conceptoBanco, args.importe],
    );
    const movimientoId = String(movimiento['id']);
    // `concepto` es vocabulario CERRADO (`reconocimiento_concepto_chk`, 0014) — nunca texto libre;
    // 'transferencia_a_terceros' es un valor real de esa lista, sin relación semántica con `tipo`
    // (el check no cruza las dos columnas), solo tiene que pertenecer al conjunto válido.
    await ej(
      `insert into reconocimiento_movimiento
         (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
          lado, que_decide, via, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados, evidencia_hubo_cola)
       values ($1, $2, 'e2e00000e2e00003', $3, $4, $5, 'transferencia_a_terceros', 'normal', 'haber', $6,
               'texto_literal_exacto', 'fixture.agrupar_decisiones', 10, false)`,
      [args.clienteId, movimientoId, String(movimiento['entrada_digest']), args.clase, args.tipo, args.queDecide],
    );
    return movimientoId;
  });
}

/** Un `asiento_propuesto_renglon` REAL (Capa D) citando el movimiento por `referencia_origen`, con
 *  `cuenta_ref` explícito — la fuente de `cuentaPropuesta`. */
async function marcarConCuentaReal(args: {
  readonly clienteId: string;
  readonly movimientoId: string;
  readonly fecha: string;
  readonly codigo: string;
  readonly denominacion: string;
}): Promise<void> {
  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    const cierre = await una(
      ej,
      `insert into cierre_cliente_periodo (cliente_id, tipo_periodo, periodo_desde, periodo_hasta)
       values ($1, 'mensual', $2::date, $2::date) returning id::text as id`,
      [args.clienteId, args.fecha],
    );
    const asiento = await una(
      ej,
      `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
       values ($1, $2, 'devengamiento', $3::date) returning id::text as id`,
      [args.clienteId, String(cierre['id']), args.fecha],
    );
    const cuenta = await una(ej, `insert into cuenta (cliente_id) values ($1) returning id::text as id`, [args.clienteId]);
    const cuentaRef = JSON.stringify({ codigo: args.codigo, denominacion: args.denominacion, rolFuncional: 'generica' });
    await ej(
      `insert into asiento_propuesto_renglon
         (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion, referencia_origen)
       values ($1, $2, 1, $3, $4::jsonb, 100.00, 0, $5::date, $6)`,
      [args.clienteId, String(asiento['id']), String(cuenta['id']), cuentaRef, args.fecha, args.movimientoId],
    );
  });
}

// -----------------------------------------------------------------------------
// cliente_id_invalido — nunca toca la base
// -----------------------------------------------------------------------------

describe('agruparDecisionesPendientes — cliente_id_invalido', () => {
  it('un clienteId sin forma de uuid aborta SIN ejecutar ninguna consulta', async () => {
    await conUsuario(USUARIOS.socio, async (tx) => {
      const espia = conEspiaDeQueries(tx);
      const r = await agruparDecisionesPendientes(espia.tx, { clienteId: 'no-es-un-uuid', desde: DESDE, hasta: HASTA });
      expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'cliente_id_invalido' });
      expect(espia.consultas(), 'la validación de forma tiene que correr ANTES de tocar la base').toHaveLength(0);
    });
  });
});

// -----------------------------------------------------------------------------
// rol_insuficiente — aborta ANTES de cualquier select de dominio
// -----------------------------------------------------------------------------

describe('agruparDecisionesPendientes — rol_insuficiente', () => {
  it('administrativoA (rol fuera de ROLES_QUE_EXPORTAN) aborta después de UNA sola consulta (el chequeo de rol)', async () => {
    await conUsuario(USUARIOS.administrativoA, async (tx) => {
      const espia = conEspiaDeQueries(tx);
      const r = await agruparDecisionesPendientes(espia.tx, { clienteId: s.clienteA, desde: DESDE, hasta: HASTA });
      expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });
      expect(espia.consultas()).toHaveLength(1);
      expect(espia.consultas()[0]).toMatch(/has_role_on/);
    });
  });

  it('un usuario SIN membresía sobre el cliente (otro estudio) también aborta con rol_insuficiente', async () => {
    const r = await conUsuario(USUARIOS.socioOtroEstudio, (tx) =>
      agruparDecisionesPendientes(tx, { clienteId: s.clienteA, desde: DESDE, hasta: HASTA }),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });
  });

  it('mutación: dentro de conJob (bypassa RLS) el chequeo de rol explícito SIGUE cortando — no es RLS quien protege acá', async () => {
    // `export_cliente_archivado` YA existe en la unión cerrada de `MotivoJob` (`conexion.ts`), sin
    // caller hoy — exactamente el hallazgo de `security-engineer` que esta prueba cierra: si algún día
    // alguien invoca esta función desde un job, `has_role_on()` depende de `app.current_user_id()`, que
    // bajo `conJob` no resuelve a ningún socio/contador real, así que `puede` da `false` igual. La
    // función NUNCA llega a leer un movimiento por el solo hecho de correr con una credencial que
    // saltea RLS.
    const r = await conJob('export_cliente_archivado', (tx) =>
      agruparDecisionesPendientes(tx, { clienteId: s.clienteA, desde: DESDE, hasta: HASTA }),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });
  });
});

// -----------------------------------------------------------------------------
// demasiadas_filas — tope real, MAX_FILAS de armar-libro.ts (50_000)
// -----------------------------------------------------------------------------

describe('agruparDecisionesPendientes — demasiadas_filas', () => {
  it(
    'más de MAX_FILAS movimientos en el rango aborta antes de agrupar nada',
    async () => {
      const { clienteId, cuentaBancariaId } = await clienteFresco('CLIENTE TOPE AGRUPAR DECISIONES');
      await agregarMembresiaContador(clienteId, USUARIOS.contadorA);

      const duenio = await clienteDuenio();
      try {
        const lote = await duenio.query<{ id: string }>(
          `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
           values ($1, $2, 'agrupar-decisiones-pendientes@fixture', 'archivo', $3, 'procesado', true) returning id::text as id`,
          [clienteId, BANCO_CODIGO, randomUUID()],
        );
        const loteId = lote.rows[0]?.id;
        // `lote_ingesta_cuenta` PRIMERO — `fk_mov_crudo_lote_cuenta` (0004, FK de tres columnas)
        // exige que (cliente_id, lote_ingesta_id, cuenta_bancaria_id) ya exista ahí antes de que
        // un solo `movimiento_bancario_crudo` pueda citarlo.
        await duenio.query(
          `insert into lote_ingesta_cuenta (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
           values ($1, $2, $3, $4::date, $4::date, 'no_verificable')`,
          [clienteId, loteId, cuentaBancariaId, DESDE],
        );
        // Bulk insert vía `generate_series` — 50_001 filas en una sola sentencia, nunca una por una:
        // insertar 50k filas con un `INSERT` por fila haría este test inviable en tiempo.
        await duenio.query(
          `insert into movimiento_bancario_crudo
             (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
              importe, concepto_banco_estrategia, contraparte_captura)
           select $1, $2, $3, gs, md5('tope-agrupar-' || gs::text), $4::date, 'bulk fixture', '-1.00',
                  'no_capturado', 'no_capturado'
           from generate_series(1, 50001) as gs`,
          [clienteId, loteId, cuentaBancariaId, DESDE],
        );
      } finally {
        await duenio.end();
      }

      const r = await conUsuario(USUARIOS.contadorA, (tx) =>
        agruparDecisionesPendientes(tx, { clienteId, desde: DESDE, hasta: HASTA }),
      );
      expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'demasiadas_filas' });
    },
    120_000,
  );
});

// -----------------------------------------------------------------------------
// agrupa correcto — montos como string, cuentaPropuesta por unanimidad, requiereRevision
// -----------------------------------------------------------------------------

describe('agruparDecisionesPendientes — agrupación correcta', () => {
  it('agrupa por (banco, concepto), suma en centavos (nunca number), y resuelve cuentaPropuesta por unanimidad', async () => {
    const { clienteId, cuentaBancariaId } = await clienteFresco('CLIENTE AGRUPA CORRECTO');
    await agregarMembresiaContador(clienteId, USUARIOS.contadorA);

    // Grupo 1 — dos movimientos `propuesta`, mismo concepto, AMBOS con la MISMA cuenta real (Capa D):
    // unanimidad → cuentaPropuesta resuelta, requiereRevision === false.
    const mov1 = await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'TRANSFERENCIA PROVEEDOR X',
      importe: '-100.00',
      fecha: '2026-06-05',
      clase: 'propuesta',
      tipo: 'cobranza_de_cliente',
      queDecide: null,
    });
    await marcarConCuentaReal({ clienteId, movimientoId: mov1, fecha: '2026-06-05', codigo: '5.1.1', denominacion: 'Proveedores' });
    const mov2 = await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'transferencia proveedor x', // mismo concepto, distinta capitalización — misma clave
      importe: '-50.00',
      fecha: '2026-06-10',
      clase: 'propuesta',
      tipo: 'cobranza_de_cliente',
      queDecide: null,
    });
    await marcarConCuentaReal({ clienteId, movimientoId: mov2, fecha: '2026-06-10', codigo: '5.1.1', denominacion: 'Proveedores' });

    // Grupo 2 — un movimiento `decision_humana`, concepto distinto, SIN cuenta real todavía.
    // `tipo`/`concepto`/`polaridad`/`lado` los cuatro no nulos (mismo `reconocimiento_forma_chk` que
    // 'propuesta') — `que_decide` distinto de 'distinguir_tercero_de_socio' para que siga agrupable.
    await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'OTRO CONCEPTO SIN RESOLVER',
      importe: '200.00',
      fecha: '2026-06-15',
      clase: 'decision_humana',
      tipo: 'indeterminado',
      // Vocabulario CERRADO (`reconocimiento_decide_chk`, 0014) — cualquier valor de la lista
      // DISTINTO de 'distinguir_tercero_de_socio' sirve para este fixture.
      queDecide: 'confirmar_cuenta_propia_destino',
    });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientes(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    if (r.estado !== 'ok') throw new Error(`se esperaba 'ok', se obtuvo abortado: ${r.motivoCodigo}`);

    expect(r.clienteId).toBe(clienteId);
    expect(r.clienteNombre).toBe('CLIENTE AGRUPA CORRECTO');
    expect(r.cantidadMovimientos).toBe(3);
    expect(r.grupos).toHaveLength(2);

    const grupoTransferencia = r.grupos.find((g) => g.bancoCodigo === BANCO_CODIGO && g.conceptoBanco?.toUpperCase() === 'TRANSFERENCIA PROVEEDOR X');
    expect(grupoTransferencia).toBeDefined();
    expect(grupoTransferencia?.cantidad).toBe(2);
    // string, NUNCA number — dos importes de -100.00/-50.00 (débitos) suman 150.00 exacto.
    expect(grupoTransferencia?.totalDebito).toBe('150.00');
    expect(grupoTransferencia?.totalCredito).toBe('0.00');
    expect(typeof grupoTransferencia?.totalDebito).toBe('string');
    expect(grupoTransferencia?.cuentaPropuesta).toEqual({ codigo: '5.1.1', denominacion: 'Proveedores' });
    expect(grupoTransferencia?.requiereRevision).toBe(false);
    expect(grupoTransferencia?.fechaDesde).toBe('2026-06-05');
    expect(grupoTransferencia?.fechaHasta).toBe('2026-06-10');

    const grupoOtro = r.grupos.find((g) => g.conceptoBanco === 'OTRO CONCEPTO SIN RESOLVER');
    expect(grupoOtro).toBeDefined();
    expect(grupoOtro?.cantidad).toBe(1);
    expect(grupoOtro?.totalCredito).toBe('200.00');
    expect(grupoOtro?.totalDebito).toBe('0.00');
    expect(grupoOtro?.cuentaPropuesta).toBeNull();
    expect(grupoOtro?.requiereRevision).toBe(true);
  });

  it('un grupo con cuentas reales DISTINTAS entre sus miembros no propone ninguna (nunca "probable")', async () => {
    const { clienteId, cuentaBancariaId } = await clienteFresco('CLIENTE AGRUPA MIXTO');
    await agregarMembresiaContador(clienteId, USUARIOS.contadorA);

    const mov1 = await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'CONCEPTO MIXTO',
      importe: '-10.00',
      fecha: '2026-06-05',
      clase: 'propuesta',
      tipo: 'cobranza_de_cliente',
      queDecide: null,
    });
    await marcarConCuentaReal({ clienteId, movimientoId: mov1, fecha: '2026-06-05', codigo: '5.1.1', denominacion: 'Proveedores' });
    const mov2 = await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'CONCEPTO MIXTO',
      importe: '-20.00',
      fecha: '2026-06-06',
      clase: 'propuesta',
      tipo: 'cobranza_de_cliente',
      queDecide: null,
    });
    await marcarConCuentaReal({ clienteId, movimientoId: mov2, fecha: '2026-06-06', codigo: '5.1.2', denominacion: 'Otra Cuenta' });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientes(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    if (r.estado !== 'ok') throw new Error(`se esperaba 'ok', se obtuvo abortado: ${r.motivoCodigo}`);
    expect(r.grupos).toHaveLength(1);
    expect(r.grupos[0]?.cuentaPropuesta).toBeNull();
  });

  // 🔴 AGREGADO (code-reviewer, revisión de este PR): `claveEfectiva()` duplica el sufijo
  // `::individual:${filaNumero}` que `agruparFilas` (armar-libro.ts) usa internamente para el ÚNICO
  // caso no agrupable (`esAgrupable`, `clase === 'decision_humana' && queDecide ===
  // 'distinguir_tercero_de_socio'`) — sin este test, ese camino nunca se ejercitaba en el gate, y el
  // `throw` de invariante roto (si el sufijo divergiera) era una promesa sin verificar.
  it('un movimiento distinguir_tercero_de_socio NUNCA se agrupa con otro del mismo (banco, concepto) — clave individual', async () => {
    const { clienteId, cuentaBancariaId } = await clienteFresco('CLIENTE DISTINGUIR TERCERO SOCIO');
    await agregarMembresiaContador(clienteId, USUARIOS.contadorA);

    // Mismo (bancoCodigo, conceptoBanco) que el movimiento de abajo — si `claveEfectiva` estuviera
    // desincronizada de `agruparFilas`, estos dos terminarían en el mismo grupo.
    await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'ING TRANSF: JUAN PEREZ',
      importe: '300.00',
      fecha: '2026-06-05',
      clase: 'decision_humana',
      tipo: 'indeterminado',
      queDecide: 'confirmar_cuenta_propia_destino', // agrupable: forma su propio grupo "normal"
    });
    await crearMovimiento({
      clienteId,
      cuentaBancariaId,
      conceptoBanco: 'ING TRANSF: JUAN PEREZ', // MISMO concepto que el de arriba, a propósito
      importe: '400.00',
      fecha: '2026-06-06',
      clase: 'decision_humana',
      tipo: 'indeterminado',
      queDecide: 'distinguir_tercero_de_socio', // el ÚNICO valor que hace `agrupable: false`
    });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      agruparDecisionesPendientes(tx, { clienteId, desde: DESDE, hasta: HASTA }),
    );
    if (r.estado !== 'ok') throw new Error(`se esperaba 'ok', se obtuvo abortado: ${r.motivoCodigo}`);

    // DOS grupos, no uno — el `distinguir_tercero_de_socio` queda solo, con su propia clave individual,
    // exactamente lo mismo que ya hace `agruparFilas` puro (mismo criterio, dos implementaciones que
    // tienen que coincidir; si no coinciden, el `throw` de la función central ya lo hubiera cortado
    // antes de llegar acá con una excepción, no con este mismatch de longitud). Ambos terminan con
    // `cantidad === 1` (el agrupable, porque es el único con ese concepto; el individual, por diseño) —
    // se distinguen por monto, no por cantidad/requiereRevision, que son iguales en los dos.
    expect(r.grupos).toHaveLength(2);
    const montos = r.grupos.map((g) => g.totalCredito).sort();
    expect(montos).toEqual(['300.00', '400.00']);
  });
});

// -----------------------------------------------------------------------------
// Prueba EN VIVO — aislamiento con dos usuarios reales (mismo estándar que 0040-0043)
// -----------------------------------------------------------------------------

describe('agruparDecisionesPendientes — aislamiento EN VIVO, dos usuarios reales', () => {
  it('contadorA (membresía SOLO en A) pidiendo el cliente B aborta con rol_insuficiente, antes de leer nada de B', async () => {
    const r = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const espia = conEspiaDeQueries(tx);
      const resultado = await agruparDecisionesPendientes(espia.tx, { clienteId: s.clienteB, desde: DESDE, hasta: HASTA });
      expect(espia.consultas()).toHaveLength(1);
      return resultado;
    });
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });
  });

  it('administrativoA (membresía en A, rol insuficiente) pidiendo A aborta antes de leer un solo movimiento', async () => {
    const r = await conUsuario(USUARIOS.administrativoA, async (tx) => {
      const espia = conEspiaDeQueries(tx);
      const resultado = await agruparDecisionesPendientes(espia.tx, { clienteId: s.clienteA, desde: DESDE, hasta: HASTA });
      expect(espia.consultas()).toHaveLength(1);
      return resultado;
    });
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });
  });
});
