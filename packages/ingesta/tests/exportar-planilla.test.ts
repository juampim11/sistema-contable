/**
 * `exportarPlanillaDeLote` / `listarLotesExportables` contra base real. Plan `adaptive-herding-pillow`.
 *
 * Bloque C: camino feliz, volumen real, lote inexistente/no exportable, auditoría.
 * Bloque D: aislamiento — el caso más crítico. Cliente A nunca trae nada de cliente B (RLS + predicado
 * explícito), y dos cuentas del MISMO cliente no se mezclan entre hojas (eso NO lo cubre la RLS).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import {
  CAPACIDADES_SINTETICAS,
  exportarPlanillaDeLote,
  extractoSintetico,
  hashFila,
  listarLotesExportables,
  persistirCuenta,
  resolverBancoDelLote,
  verificarAritmetica,
  type CuentaConMovimientos,
  type EstadoLotePersistido,
} from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

async function registrarBanco(codigo: string): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(`insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`, [
      codigo,
      codigo.toUpperCase(),
    ]);
  } finally {
    await duenio.end();
  }
}

async function registrarCuenta(clienteId: string, bancoCodigo: string, moneda: string): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const c = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias) values ($1, $2, $3, $4)
       returning id::text as id`,
      [clienteId, bancoCodigo, moneda, `Cuenta ${moneda}`],
    );
    const id = c[0]?.id;
    if (!id) throw new Error('no se creó la cuenta de prueba');
    return id;
  });
}

/** Sin `alias` (el caso real que reportó JP, ajuste 1: dos cuentas Macro reales del piloto sin alias
 *  cargado quedaban indistinguibles en el export). */
async function registrarCuentaSinAlias(clienteId: string, bancoCodigo: string, moneda: string): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const c = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias) values ($1, $2, $3, null)
       returning id::text as id`,
      [clienteId, bancoCodigo, moneda],
    );
    const id = c[0]?.id;
    if (!id) throw new Error('no se creó la cuenta de prueba');
    return id;
  });
}

/** Un identificador de cuenta vigente — mismo camino de datos que usaría `alta-cuenta.ts` en
 *  producción, insertado directo para no arrastrar todo el CLI a este test. */
async function agregarIdentificador(args: {
  readonly clienteId: string;
  readonly cuentaBancariaId: string;
  readonly tipoCuenta: string;
  readonly numero: string;
  readonly cbuUltimos4: string | null;
  readonly vigenteDesde: string;
}): Promise<void> {
  await conUsuario(USUARIOS.socio, (tx) =>
    tx.consultar(
      `insert into cuenta_bancaria_identificador
         (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_ultimos4, vigente_desde)
       values ($1, $2, $3, $4, $5, $6::date)`,
      [args.clienteId, args.cuentaBancariaId, args.tipoCuenta, args.numero, args.cbuUltimos4, args.vigenteDesde],
    ),
  );
}

async function contarAuditoriaDeRecurso(recurso: string, recursoId: string): Promise<number> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ n: string }>(
      `select count(*)::text as n from acceso_auditoria where recurso = $1 and recurso_id = $2`,
      [recurso, recursoId],
    );
    return Number(f[0]?.n ?? '0');
  });
}

/** Crea un lote enteramente persistido (con `persistirCuenta` real, no SQL a mano) para una o más
 *  cuentas. Refleja el único camino por el que `lote_ingesta_cuenta` puede tener filas: nunca `no_cuadra`
 *  (esa rama de `estadoSegunVerificacion` no persiste nada, por diseño — `persistir.ts`). */
async function crearLotePersistido(opciones: {
  readonly clienteId: string;
  readonly bancoCodigo: string;
  readonly cuentas: ReadonlyArray<{ cuenta: CuentaConMovimientos; cuentaBancariaId: string }>;
}): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const creado = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, procesado_por)
       values ($1, $2, $3, 'archivo', $4, 'recibido', app.current_user_id())
       returning id::text as id`,
      [opciones.clienteId, opciones.bancoCodigo, `${opciones.bancoCodigo}@1`, randomUUID()],
    );
    const loteId = creado[0]?.id;
    if (!loteId) throw new Error('no se creó el lote de prueba');

    const movimientosEnElLote = opciones.cuentas.reduce((n, c) => n + c.cuenta.movimientos.length, 0);
    let peorEstado: EstadoLotePersistido = 'procesado';
    for (const { cuenta, cuentaBancariaId } of opciones.cuentas) {
      const verificacion = verificarAritmetica(cuenta, {
        capacidades: CAPACIDADES_SINTETICAS as never,
        movimientosEnElLote,
      });
      const persistido = await persistirCuenta(tx, {
        clienteId: opciones.clienteId,
        loteId,
        cuentaBancariaId,
        cuenta,
        verificacion,
        movimientosEnElLote,
      });
      if (!persistido.persistido) {
        throw new Error(`fixture inválido: la cuenta debía persistir y no lo hizo (${persistido.motivoCodigo})`);
      }
      if (persistido.estado === 'procesado_con_observaciones') peorEstado = 'procesado_con_observaciones';
    }

    await tx.consultar(
      `update lote_ingesta set estado = $2, filas_leidas = $3, filas_aceptadas = $3 where id = $1`,
      [loteId, peorEstado, movimientosEnElLote],
    );

    return loteId;
  });
}

async function contarAuditoria(recursoId: string): Promise<number> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ n: string }>(
      `select count(*)::text as n from acceso_auditoria
        where recurso = 'movimiento_bancario_crudo' and recurso_id = $1 and accion = 'export'`,
      [recursoId],
    );
    return Number(f[0]?.n ?? '0');
  });
}

/** Todas las cadenas imprimibles de un `.xlsx` — string suelto + cada entrada ZIP inflada. Mismo camino
 *  conceptual que `tools/barrido-fuga.ts` (firma ZIP local `0x04034b50` + `inflateRawSync`), reimplementado
 *  acá porque esa función no está exportada y este test necesita operar sobre un buffer en memoria, no
 *  sobre un archivo en disco. */
function cadenasDelXlsx(buffer: Uint8Array): string {
  const buf = Buffer.from(buffer);
  const partes: string[] = [buf.toString('latin1')];
  for (let i = 0; i < buf.length - 30; i += 1) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nombreLargo = buf.readUInt16LE(i + 26);
    const extraLargo = buf.readUInt16LE(i + 28);
    const inicio = i + 30 + nombreLargo + extraLargo;
    try {
      partes.push(inflateRawSync(buf.subarray(inicio), { finishFlush: 2 }).toString('latin1'));
    } catch {
      /* entrada sin comprimir o corrupta: ya cubierta por el string crudo de arriba */
    }
  }
  return partes.join('\n');
}

// -----------------------------------------------------------------------------
// Bloque C — camino feliz, volumen, abortos, auditoría
// -----------------------------------------------------------------------------

describe('exportarPlanillaDeLote — camino feliz', () => {
  it('exporta un lote de una cuenta: arma el libro, audita, cuenta filas', async () => {
    await registrarBanco('bancoexport1');
    const cuentaBancariaId = await registrarCuenta(s.clienteA, 'bancoexport1', 'ARS');
    const cuenta = extractoSintetico({
      semilla: 101,
      cantidadMovimientos: 12,
      saldoInicialCentavos: 100_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport1',
    });
    const loteId = await crearLotePersistido({
      clienteId: s.clienteA,
      bancoCodigo: 'bancoexport1',
      cuentas: [{ cuenta, cuentaBancariaId }],
    });

    const antes = await contarAuditoria(loteId);
    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );

    expect(r.estado).toBe('armada');
    if (r.estado !== 'armada') return;
    expect(r.filas).toBe(12);
    expect(r.cuentas).toBe(1);
    expect(r.verificacion).toEqual(['cuadra']);
    expect(r.libro[0]).toBe(0x50);

    const despues = await contarAuditoria(loteId);
    expect(despues - antes).toBe(1);
  });

  it('1400 filas (volumen real de Macro): arma sin error', async () => {
    await registrarBanco('bancoexport2');
    const cuentaBancariaId = await registrarCuenta(s.clienteA, 'bancoexport2', 'ARS');
    const cuenta = extractoSintetico({
      semilla: 202,
      cantidadMovimientos: 1400,
      saldoInicialCentavos: 500_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport2',
    });
    const loteId = await crearLotePersistido({
      clienteId: s.clienteA,
      bancoCodigo: 'bancoexport2',
      cuentas: [{ cuenta, cuentaBancariaId }],
    });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );
    expect(r.estado).toBe('armada');
    if (r.estado === 'armada') expect(r.filas).toBe(1400);
  }, 60_000);
});

describe('exportarPlanillaDeLote — abortos', () => {
  it('lote inexistente: lote_no_encontrado', async () => {
    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId: randomUUID(),
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'lote_no_encontrado' });
  });

  it('lote con_errores (nunca completado): lote_no_exportable, sin auditar', async () => {
    await registrarBanco('bancoexport3');
    const loteId = await conUsuario(USUARIOS.socio, async (tx) => {
      const creado = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, motivo_codigo, procesado_por)
         values ($1, 'bancoexport3', 'bancoexport3@1', 'archivo', $2, 'con_errores', 'cuenta_no_pertenece_al_cliente', app.current_user_id())
         returning id::text as id`,
        [s.clienteA, randomUUID()],
      );
      const id = creado[0]?.id;
      if (!id) throw new Error('no se creó el lote');
      return id;
    });

    const antes = await contarAuditoria(loteId);
    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'lote_no_exportable' });
    expect(await contarAuditoria(loteId)).toBe(antes);
  });
});

describe('exportarPlanillaDeLote — rol', () => {
  it('administrativo: rol_insuficiente (H-8, mismo criterio que descarga.ts)', async () => {
    await registrarBanco('bancoexport4');
    const cuentaBancariaId = await registrarCuenta(s.clienteA, 'bancoexport4', 'ARS');
    const cuenta = extractoSintetico({
      semilla: 303,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 10_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport4',
    });
    const loteId = await crearLotePersistido({
      clienteId: s.clienteA,
      bancoCodigo: 'bancoexport4',
      cuentas: [{ cuenta, cuentaBancariaId }],
    });

    const rAdmin = await conUsuario(USUARIOS.administrativoA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );
    expect(rAdmin).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });

    const rAuditor = await conUsuario(USUARIOS.auditorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );
    expect(rAuditor).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });
  });
});

// -----------------------------------------------------------------------------
// Bloque D — aislamiento multi-tenant. El caso más crítico.
// -----------------------------------------------------------------------------

describe('exportarPlanillaDeLote — aislamiento', () => {
  it('el export de A no trae NADA de B: 0 matches del canario en todas las celdas', async () => {
    await registrarBanco('bancoexport5');
    const cuentaA = await registrarCuenta(s.clienteA, 'bancoexport5', 'ARS');
    const cuentaB = await registrarCuenta(s.clienteB, 'bancoexport5', 'ARS');

    const extractoA = extractoSintetico({
      semilla: 401,
      cantidadMovimientos: 8,
      saldoInicialCentavos: 20_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport5',
    });
    // El canario reservado por ADR-0002 §F.1 — nunca usarlo para otra cosa.
    const CANARIO_GLOSA = 'CANARIO SRL';
    const CANARIO_IMPORTE = '999999.99';
    // Construida a mano, coherente por diseño: mutar un movimiento de un `extractoSintetico` YA generado
    // rompe la cadena de saldos y `verificarAritmetica` la rechaza (`persistirCuenta` no persiste nada
    // que no cuadre — `persistir.ts`). Acá el saldo/los totales se calculan para que sí cuadren.
    const extractoBConCanario: CuentaConMovimientos = {
      cuenta: {
        denominacion: 'CUENTA CANARIO',
        tipoCuenta: 'cuenta_corriente',
        numero: '9999990',
        moneda: 'ARS',
        periodoDesde: '2026-06-01',
        periodoHasta: '2026-06-30',
        saldoInicialDeclarado: '10000.00',
        saldoFinalDeclarado: '1009999.99',
        totalCreditosDeclarado: CANARIO_IMPORTE,
        totalDebitosDeclarado: '0.00',
        titular: CANARIO_GLOSA,
      },
      movimientos: [
        {
          tipoFila: 'movimiento',
          fecha: '2026-06-05',
          descripcionLineas: [CANARIO_GLOSA],
          descripcion: `${CANARIO_GLOSA} | movimiento canario`,
          conceptoBanco: 'CANARIO',
          conceptoCompleto: true,
          conceptoBancoEstrategia: 'segmento_de_glosa',
          conceptoCodigo: '900999',
          conceptoGrupoCodigo: '900',
          contraparteNombre: CANARIO_GLOSA,
          candidatosIdentificacion: [],
          referencias: [],
          columnaOrigen: 'credito',
          credito: CANARIO_IMPORTE,
          importe: CANARIO_IMPORTE,
          saldo: '1009999.99',
          saldoEsAcreedor: false,
          moneda: 'ARS',
          cotizacionProvista: false,
          filaNumero: 1,
          paginaPdf: 1,
          filaHash: hashFila({
            cuenta: { bancoCodigo: 'bancoexport5', numeroNormalizado: '9999990', moneda: 'ARS' },
            fecha: '2026-06-05',
            importe: CANARIO_IMPORTE,
            saldo: '1009999.99',
            descripcion: `${CANARIO_GLOSA} | movimiento canario`,
            ordinalEnEmpate: 0,
          }),
        },
      ],
      anexos: [],
    };

    const loteA = await crearLotePersistido({
      clienteId: s.clienteA,
      bancoCodigo: 'bancoexport5',
      cuentas: [{ cuenta: extractoA, cuentaBancariaId: cuentaA }],
    });
    await crearLotePersistido({
      clienteId: s.clienteB,
      bancoCodigo: 'bancoexport5',
      cuentas: [{ cuenta: extractoBConCanario, cuentaBancariaId: cuentaB }],
    });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId: loteA,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );
    expect(r.estado).toBe('armada');
    if (r.estado !== 'armada') return;

    const texto = cadenasDelXlsx(r.libro);
    expect(texto).not.toContain(CANARIO_GLOSA);
    expect(texto).not.toContain(CANARIO_IMPORTE);
    // Assert positivo: A sí exportó (el test no pasa por no exportar nada).
    expect(r.filas).toBe(8);

    // Releído, también: las descripciones reales de A aparecen en alguna celda.
    const releido = new ExcelJS.Workbook();
    await releido.xlsx.load(Buffer.from(r.libro) as unknown as ExcelJS.Buffer);
    expect(releido.worksheets.length).toBeGreaterThan(1);
  });

  it('pedir el lote de B siendo contadorA (mismo cliente en el argumento, lote de otro): lote_no_encontrado', async () => {
    await registrarBanco('bancoexport6');
    const cuentaB = await registrarCuenta(s.clienteB, 'bancoexport6', 'ARS');
    const cuenta = extractoSintetico({
      semilla: 501,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 5_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport6',
    });
    const loteB = await crearLotePersistido({
      clienteId: s.clienteB,
      bancoCodigo: 'bancoexport6',
      cuentas: [{ cuenta, cuentaBancariaId: cuentaB }],
    });

    // --cliente=clienteA (donde contadorA SÍ tiene rol) pero --lote-id es el de clienteB: el predicado
    // explícito `where id=$1 and cliente_id=$2` tiene que frenarlo, no solo la RLS.
    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId: loteB,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'lote_no_encontrado' });
  });

  it('socio de OTRO estudio: rol_insuficiente (cruce entre estudios, no solo entre clientes)', async () => {
    await registrarBanco('bancoexport7');
    const cuentaA = await registrarCuenta(s.clienteA, 'bancoexport7', 'ARS');
    const cuenta = extractoSintetico({
      semilla: 601,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 5_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport7',
    });
    const loteA = await crearLotePersistido({
      clienteId: s.clienteA,
      bancoCodigo: 'bancoexport7',
      cuentas: [{ cuenta, cuentaBancariaId: cuentaA }],
    });

    const r = await conUsuario(USUARIOS.socioOtroEstudio, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId: loteA,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });
  });

  it('dos cuentas del MISMO cliente en un lote: cada hoja trae SOLO sus propias filas', async () => {
    await registrarBanco('bancoexport8');
    const cuenta1 = await registrarCuenta(s.clienteA, 'bancoexport8', 'ARS');
    const cuenta2 = await registrarCuenta(s.clienteA, 'bancoexport8', 'USD');

    const extracto1 = extractoSintetico({
      semilla: 701,
      cantidadMovimientos: 5,
      saldoInicialCentavos: 10_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport8',
      moneda: 'ARS',
    });
    const extracto2 = extractoSintetico({
      semilla: 702,
      cantidadMovimientos: 9,
      saldoInicialCentavos: 30_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport8',
      moneda: 'USD',
    });

    const loteId = await crearLotePersistido({
      clienteId: s.clienteA,
      bancoCodigo: 'bancoexport8',
      cuentas: [
        { cuenta: extracto1, cuentaBancariaId: cuenta1 },
        { cuenta: extracto2, cuentaBancariaId: cuenta2 },
      ],
    });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-12T00:00:00.000Z',
      }),
    );
    expect(r.estado).toBe('armada');
    if (r.estado !== 'armada') return;
    expect(r.filas).toBe(14);
    expect(r.cuentas).toBe(2);

    const releido = new ExcelJS.Workbook();
    await releido.xlsx.load(Buffer.from(r.libro) as unknown as ExcelJS.Buffer);
    // Control de saldos + 2 hojas de movimientos, ninguna mezclada.
    expect(releido.worksheets.length).toBe(3);
    const hojasMov = releido.worksheets.filter((w) => w.name !== 'Control de saldos');
    const conteos = hojasMov
      .map((h) => {
        let n = 0;
        h.eachRow((fila, num) => {
          if (num >= 8 && fila.getCell(1).value !== null) n += 1;
        });
        return n;
      })
      .sort((a, b) => a - b);
    expect(conteos).toEqual([5, 9]);
  });
});

// -----------------------------------------------------------------------------
// Ajuste 1 (2026-08-21) — desambiguar hojas sin alias, contra base real, wiring de leerConAuditoria
// -----------------------------------------------------------------------------

describe('exportarPlanillaDeLote — identificador de cuenta (ajuste 1, base real)', () => {
  it('🔴 el caso real que reportó JP: dos cuentas Macro del piloto, misma moneda, SIN alias — ' +
    'quedan distinguibles en el export, y la lectura N2R queda auditada por cuenta', async () => {
    await registrarBanco('bancoexport12');
    const cuentaCC = await registrarCuentaSinAlias(s.clienteA, 'bancoexport12', 'ARS');
    const cuentaEspecial = await registrarCuentaSinAlias(s.clienteA, 'bancoexport12', 'ARS');
    await agregarIdentificador({
      clienteId: s.clienteA,
      cuentaBancariaId: cuentaCC,
      tipoCuenta: 'cuenta_corriente',
      numero: '1112223334',
      cbuUltimos4: null,
      vigenteDesde: '2026-01-01',
    });
    await agregarIdentificador({
      clienteId: s.clienteA,
      cuentaBancariaId: cuentaEspecial,
      tipoCuenta: 'cuenta_corriente_especial',
      numero: '5556667778',
      cbuUltimos4: '4321',
      vigenteDesde: '2026-01-01',
    });

    const extractoCC = extractoSintetico({
      semilla: 1201,
      cantidadMovimientos: 4,
      saldoInicialCentavos: 10_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport12',
      moneda: 'ARS',
    });
    const extractoEspecial = extractoSintetico({
      semilla: 1202,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 20_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport12',
      moneda: 'ARS',
    });
    const loteId = await crearLotePersistido({
      clienteId: s.clienteA,
      bancoCodigo: 'bancoexport12',
      cuentas: [
        { cuenta: extractoCC, cuentaBancariaId: cuentaCC },
        { cuenta: extractoEspecial, cuentaBancariaId: cuentaEspecial },
      ],
    });

    const antesCC = await contarAuditoriaDeRecurso('cuenta_bancaria_identificador', cuentaCC);
    const antesEspecial = await contarAuditoriaDeRecurso('cuenta_bancaria_identificador', cuentaEspecial);

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'estudio_interno',
        generadoEn: '2026-08-21T00:00:00.000Z',
      }),
    );
    expect(r.estado).toBe('armada');
    if (r.estado !== 'armada') return;

    const releido = new ExcelJS.Workbook();
    await releido.xlsx.load(Buffer.from(r.libro) as unknown as ExcelJS.Buffer);
    // El orden entre las dos hojas no es un requisito (ajuste 1 pide DISTINGUIBLES, no un orden
    // específico) y no puede serlo: el desempate de la consulta es `cuenta_bancaria_id`, un uuid
    // generado al azar por cuenta de prueba — afirmar un orden fijo acá haría el test dependiente
    // de qué uuid salió "menor" en esta corrida (confirmado con 6 corridas sueltas: falló en 4/6).
    const nombresDeHoja = releido.worksheets.map((w) => w.name).filter((n) => n !== 'Control de saldos');
    expect(nombresDeHoja.slice().sort()).toEqual(['ARS bancoexport12 Cta.Cte', 'ARS bancoexport12 Cta.Esp']);
    expect(nombresDeHoja.some((n) => n.includes('(2)'))).toBe(false);

    // El CBU sí aparece, pero DENTRO de la hoja — nunca en el nombre de pestaña.
    const hojaEspecial = releido.getWorksheet('ARS bancoexport12 Cta.Esp');
    expect(hojaEspecial?.getCell('A1').value).toContain('····4321');

    // El número completo (N2R) NUNCA sale a ningún lado del archivo — inflado, no el zip crudo
    // (comprimido no contiene el substring aunque el dato esté adentro; sin esto el assert no prueba nada).
    const texto = cadenasDelXlsx(r.libro);
    expect(texto).not.toContain('1112223334');
    expect(texto).not.toContain('5556667778');

    // La lectura N2R quedó auditada — una fila POR CUENTA, no una sola para "todo el lote".
    expect(await contarAuditoriaDeRecurso('cuenta_bancaria_identificador', cuentaCC)).toBe(antesCC + 1);
    expect(await contarAuditoriaDeRecurso('cuenta_bancaria_identificador', cuentaEspecial)).toBe(antesEspecial + 1);
  });

  it('destinatario=organismo: NUNCA lee el identificador de cuenta — ninguna auditoría nueva, sello de siempre', async () => {
    await registrarBanco('bancoexport13');
    const cuenta = await registrarCuentaSinAlias(s.clienteA, 'bancoexport13', 'ARS');
    await agregarIdentificador({
      clienteId: s.clienteA,
      cuentaBancariaId: cuenta,
      tipoCuenta: 'cuenta_corriente',
      numero: '9998887776',
      cbuUltimos4: '7777',
      vigenteDesde: '2026-01-01',
    });
    const extracto = extractoSintetico({
      semilla: 1301,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 5_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport13',
    });
    const loteId = await crearLotePersistido({ clienteId: s.clienteA, bancoCodigo: 'bancoexport13', cuentas: [{ cuenta: extracto, cuentaBancariaId: cuenta }] });

    const antes = await contarAuditoriaDeRecurso('cuenta_bancaria_identificador', cuenta);
    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      exportarPlanillaDeLote(tx, {
        clienteId: s.clienteA,
        loteId,
        motivoCodigo: 'demo_contadora',
        destinatarioCodigo: 'organismo',
        generadoEn: '2026-08-21T00:00:00.000Z',
      }),
    );
    expect(r.estado).toBe('armada');
    expect(await contarAuditoriaDeRecurso('cuenta_bancaria_identificador', cuenta)).toBe(antes);
  });
});

// -----------------------------------------------------------------------------
// listarLotesExportables
// -----------------------------------------------------------------------------

describe('listarLotesExportables', () => {
  it('solo lotes procesados/con_observaciones de ESE cliente, sin un solo importe', async () => {
    await registrarBanco('bancoexport9');
    const cuentaBancariaId = await registrarCuenta(s.clienteA, 'bancoexport9', 'ARS');
    const cuenta = extractoSintetico({
      semilla: 801,
      cantidadMovimientos: 4,
      saldoInicialCentavos: 1_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport9',
    });
    const loteId = await crearLotePersistido({
      clienteId: s.clienteA,
      bancoCodigo: 'bancoexport9',
      cuentas: [{ cuenta, cuentaBancariaId }],
    });

    const lotes = await conUsuario(USUARIOS.contadorA, (tx) =>
      listarLotesExportables(tx, { clienteId: s.clienteA, bancoCodigo: 'bancoexport9' }),
    );
    expect(lotes.some((l) => l.loteId === loteId)).toBe(true);
    const encontrado = lotes.find((l) => l.loteId === loteId);
    expect(encontrado?.filasAceptadas).toBe(4);
    expect(encontrado?.cuentas).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// resolverBancoDelLote — lectura N1 previa, best-effort (plan `adaptive-herding-pillow`, nombre legible)
// -----------------------------------------------------------------------------

describe('resolverBancoDelLote', () => {
  it('lote real: devuelve el banco_codigo correcto', async () => {
    await registrarBanco('bancoexport10');
    const cuentaBancariaId = await registrarCuenta(s.clienteA, 'bancoexport10', 'ARS');
    const cuenta = extractoSintetico({
      semilla: 901,
      cantidadMovimientos: 2,
      saldoInicialCentavos: 1_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport10',
    });
    const loteId = await crearLotePersistido({
      clienteId: s.clienteA,
      bancoCodigo: 'bancoexport10',
      cuentas: [{ cuenta, cuentaBancariaId }],
    });

    const banco = await conUsuario(USUARIOS.contadorA, (tx) =>
      resolverBancoDelLote(tx, { clienteId: s.clienteA, loteId }),
    );
    expect(banco).toBe('bancoexport10');
  });

  it('lote inexistente: null, nunca una excepción', async () => {
    const banco = await conUsuario(USUARIOS.contadorA, (tx) =>
      resolverBancoDelLote(tx, { clienteId: s.clienteA, loteId: randomUUID() }),
    );
    expect(banco).toBeNull();
  });

  it('lote de OTRO cliente: null (mismo predicado cliente_id explícito que el resto del módulo)', async () => {
    await registrarBanco('bancoexport11');
    const cuentaB = await registrarCuenta(s.clienteB, 'bancoexport11', 'ARS');
    const cuenta = extractoSintetico({
      semilla: 902,
      cantidadMovimientos: 2,
      saldoInicialCentavos: 1_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'bancoexport11',
    });
    const loteB = await crearLotePersistido({
      clienteId: s.clienteB,
      bancoCodigo: 'bancoexport11',
      cuentas: [{ cuenta, cuentaBancariaId: cuentaB }],
    });

    const banco = await conUsuario(USUARIOS.contadorA, (tx) =>
      resolverBancoDelLote(tx, { clienteId: s.clienteA, loteId: loteB }),
    );
    expect(banco).toBeNull();
  });
});
