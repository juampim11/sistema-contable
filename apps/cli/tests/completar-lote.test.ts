/**
 * `completar-lote.ts` — remediación de un lote `con_errores` al que le faltó UNA cuenta (HANDOFF
 * 2026-08-11 (42)). Cinco escenarios son el criterio de aceptación tal cual quedó escrito ahí:
 *
 *   1. 0 cuentas faltantes → `ya_completado`.
 *   2. 1 faltante que resuelve → estado/contadores/`adaptador_version` correctos, auditoría escrita.
 *   3. 1 faltante que NO resuelve → aborta sin tocar nada.
 *   4. ≥2 faltantes → aborta explícito sin intentar ninguna.
 *   5. Segunda corrida sobre un lote ya completado → `ya_completado`, sin `23505` crudo.
 *
 * Más los guardrails de `security-engineer`: el lote tiene que EXISTIR (nunca se crea uno ni se cae a
 * "el más reciente"), y el `--banco` releído tiene que coincidir con el ya persistido.
 *
 * **Todo contra fixtures sintéticos — nunca contra el piloto real.** Eso lo corre el usuario, con el
 * comando exacto que deja HANDOFF (42)/(43).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { hmacIdentificador, ultimos4ParaGuardar } from '@sistema-contable/shared/seguridad';
import type { ObjectStorage } from '@sistema-contable/almacenamiento';
import {
  CAPACIDADES_SINTETICAS,
  extractoSintetico,
  mutar,
  persistirCuenta,
  registrarAdaptador,
  textoDeFila,
  verificarAritmetica,
  type Adaptador,
  type CuentaConMovimientos,
} from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { completarLote } from '../src/completar-lote.ts';

let s: Sembrado;
let dirTemporal: string;

/** Mismo generador mínimo de PDF que `ingestar.test.ts`: hace falta un documento parseable de verdad
 *  porque `completarLote` tiene que llegar más allá del parseo para ejercitar la lógica de pendientes. */
function pdfMinimoConTexto(lineas: readonly string[]): Buffer {
  const objetos: Record<number, string> = {
    1: '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    2: '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    3: '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> ' +
      '/MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n',
    4: '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  };
  let y = 720;
  const contenidoStream = lineas
    .map((l) => {
      const linea = `BT /F1 6 Tf 72 ${y} Td (${l}) Tj ET`;
      y -= 12;
      return linea;
    })
    .join('\n');
  objetos[5] =
    `5 0 obj\n<< /Length ${contenidoStream.length} >>\nstream\n${contenidoStream}\nendstream\nendobj\n`;

  let cuerpo = '%PDF-1.4\n';
  const offsets: number[] = [0, 0, 0, 0, 0, 0];
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = Buffer.byteLength(cuerpo, 'latin1');
    cuerpo += objetos[i];
  }
  const offsetXref = Buffer.byteLength(cuerpo, 'latin1');
  let xref = `xref\n0 6\n${'0'.repeat(10)} 65535 f \n`;
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  cuerpo += `${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offsetXref}\n%%EOF`;
  return Buffer.from(cuerpo, 'latin1');
}

function storageEspia(): { storage: ObjectStorage; escrituras: string[] } {
  const escrituras: string[] = [];
  return {
    escrituras,
    storage: {
      async guardar(clave) {
        escrituras.push(clave);
      },
      async obtener() {
        return Buffer.alloc(0);
      },
      async urlFirmada() {
        return '';
      },
      async eliminar() {},
    },
  };
}

async function registrarBanco(codigo: string, nombre: string): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing`,
      [codigo, nombre],
    );
  } finally {
    await duenio.end();
  }
}

/** Da de alta una cuenta y su identificador vigente para `clienteId` — el paso que en la vida real hace
 *  el operador con `alta-cuenta.ts` antes de poder completar el lote. */
async function registrarCuentaDelCliente(
  clienteId: string,
  bancoCodigo: string,
  cuenta: CuentaConMovimientos,
): Promise<string> {
  const cbuFicticio = `999${cuenta.cuenta.numero}${cuenta.cuenta.moneda === 'USD' ? '9' : '1'}`.padEnd(
    22,
    '0',
  );
  return conUsuario(USUARIOS.socio, async (tx) => {
    const c = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, $2, $3)
       returning id::text as id`,
      [clienteId, bancoCodigo, cuenta.cuenta.moneda],
    );
    const cuentaBancariaId = c[0]?.id;
    if (!cuentaBancariaId) throw new Error('no se creó la cuenta de prueba');
    await tx.consultar(
      `insert into cuenta_bancaria_identificador
         (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
       values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
      [
        clienteId,
        cuentaBancariaId,
        cuenta.cuenta.numero,
        hmacIdentificador(cbuFicticio),
        ultimos4ParaGuardar(cbuFicticio),
      ],
    );
    return cuentaBancariaId;
  });
}

/**
 * Reproduce EXACTAMENTE el estado de un lote huérfano pre-(40)/(41): crea el lote, persiste (con la
 * función real `persistirCuenta`, no SQL a mano) las cuentas que ya "cuadraron" antes del bug, y deja el
 * lote `con_errores` sin revertirlas — que es lo que `rechazar()` hacía ANTES del `SAVEPOINT`. Usar la
 * función real de persistencia en vez de un `insert` manual evita tener que replicar a mano las columnas
 * de `movimiento_bancario_crudo`/`movimiento_origen_crudo`, que no son el objeto de este test.
 */
async function crearLoteHuerfano(opciones: {
  readonly clienteId: string;
  readonly bancoCodigo: string;
  readonly archivoHash: string;
  readonly motivoCodigo: string;
  readonly yaPersistidas: ReadonlyArray<{ cuenta: CuentaConMovimientos; cuentaBancariaId: string }>;
  readonly movimientosEnElLote: number;
}): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const creado = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, motivo_codigo, procesado_por)
       values ($1, $2, $3, 'archivo', $4, 'con_errores', $5, app.current_user_id())
       returning id::text as id`,
      [
        opciones.clienteId,
        opciones.bancoCodigo,
        `${opciones.bancoCodigo}@pendiente`,
        opciones.archivoHash,
        opciones.motivoCodigo,
      ],
    );
    const loteId = creado[0]?.id;
    if (!loteId) throw new Error('no se creó el lote de prueba');

    for (const { cuenta, cuentaBancariaId } of opciones.yaPersistidas) {
      const verificacion = verificarAritmetica(cuenta, {
        capacidades: CAPACIDADES_SINTETICAS as never,
        movimientosEnElLote: opciones.movimientosEnElLote,
      });
      const persistido = await persistirCuenta(tx, {
        clienteId: opciones.clienteId,
        loteId,
        cuentaBancariaId,
        cuenta,
        verificacion,
        movimientosEnElLote: opciones.movimientosEnElLote,
      });
      if (!persistido.persistido) {
        throw new Error(`fixture inválido: la cuenta debía persistir y no lo hizo (${persistido.motivoCodigo})`);
      }
    }

    return loteId;
  });
}

async function contarFilas(sql: string, params: readonly unknown[]): Promise<number> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ n: string }>(sql, params as unknown[]);
    return Number(f[0]?.n ?? '0');
  });
}

beforeAll(async () => {
  s = await sembrar();
  dirTemporal = mkdtempSync(join(tmpdir(), 'completar-lote-'));
});

afterAll(async () => {
  await cerrarConexiones();
});

function registrarAdaptadorDePrueba(bancoCodigo: string, marca: string, cuentas: readonly CuentaConMovimientos[]): Adaptador {
  const adaptador: Adaptador = {
    bancoCodigo,
    version: 1,
    capacidades: CAPACIDADES_SINTETICAS,
    reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes(marca)),
    leer: () => ({
      cuentas: [...cuentas],
      lineasNoInterpretadas: [],
      paginasDeclaradas: undefined,
      destinos: undefined,
    }),
  };
  registrarAdaptador(adaptador);
  return adaptador;
}

function archivoConMarca(marca: string): { ruta: string; contenido: Buffer } {
  const ruta = join(dirTemporal, `${marca.replace(/\s+/g, '-').toLowerCase()}.pdf`);
  const contenido = pdfMinimoConTexto([
    `MARCA ${marca} PARA COMPLETAR-LOTE`,
    'SEGUNDA LINEA SOLO PARA SUPERAR EL UMBRAL DE CARACTERES MINIMOS',
  ]);
  writeFileSync(ruta, contenido);
  return { ruta, contenido };
}

// -----------------------------------------------------------------------------
describe('el lote tiene que existir — nunca se crea uno nuevo ni se cae a "el más reciente"', () => {
  it('archivo que no matchea ningún lote existente: lote_no_encontrado', async () => {
    const { storage, escrituras } = storageEspia();
    const ruta = join(dirTemporal, 'nunca-ingestado.pdf');
    writeFileSync(ruta, 'contenido cualquiera, nunca se llega a parsear');

    const r = await completarLote(
      { cliente: s.clienteA, archivo: ruta, banco: 'banco_que_no_existe', usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('abortado');
    if (r.estado === 'abortado') expect(r.motivoCodigo).toBe('lote_no_encontrado');
    expect(escrituras).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('el --banco releído tiene que coincidir con el persistido en el lote', () => {
  it('banco distinto del que quedó en el lote: banco_no_coincide, no toca nada', async () => {
    await registrarBanco('banco_cli_remediar_bancoorig', 'BANCO ORIGINAL DE PRUEBA');
    const { ruta, contenido } = archivoConMarca('BANCO NO COINCIDE');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(contenido).digest('hex');

    await crearLoteHuerfano({
      clienteId: s.clienteA,
      bancoCodigo: 'banco_cli_remediar_bancoorig',
      archivoHash: hash,
      motivoCodigo: 'cuenta_no_registrada',
      yaPersistidas: [],
      movimientosEnElLote: 0,
    });

    const { storage, escrituras } = storageEspia();
    const r = await completarLote(
      { cliente: s.clienteA, archivo: ruta, banco: 'banco_declarado_distinto', usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('abortado');
    if (r.estado === 'abortado') expect(r.motivoCodigo).toBe('banco_no_coincide');
    expect(escrituras).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('0 cuentas faltantes → ya_completado, sin tocar el lote', () => {
  it('todas las cuentas del archivo ya tienen su fila: no-op', async () => {
    const bancoCodigo = 'banco_cli_remediar_0pend';
    await registrarBanco(bancoCodigo, 'BANCO DE PRUEBA — 0 PENDIENTES');

    const cuenta = extractoSintetico({
      semilla: 601,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 10_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo,
    });
    const cuentaBancariaId = await registrarCuentaDelCliente(s.clienteA, bancoCodigo, cuenta);
    registrarAdaptadorDePrueba(bancoCodigo, '0 PENDIENTES', [cuenta]);

    const { ruta, contenido } = archivoConMarca('0 PENDIENTES');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(contenido).digest('hex');

    const loteId = await crearLoteHuerfano({
      clienteId: s.clienteA,
      bancoCodigo,
      archivoHash: hash,
      // Motivo de placeholder: da igual cuál, este test no lo ejercita — lo que importa es que la
      // única cuenta del archivo YA está en `lote_ingesta_cuenta`.
      motivoCodigo: 'cuenta_sin_periodo',
      yaPersistidas: [{ cuenta, cuentaBancariaId }],
      movimientosEnElLote: 3,
    });

    const { storage, escrituras } = storageEspia();
    const r = await completarLote(
      { cliente: s.clienteA, archivo: ruta, banco: bancoCodigo, usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('ya_completado');
    if (r.estado === 'ya_completado') expect(r.loteId).toBe(loteId);
    expect(escrituras, 'ya_completado no debería escribir ningún objeto').toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('1 cuenta faltante que resuelve — el camino feliz', () => {
  const bancoCodigo = 'banco_cli_remediar_ok';
  let loteId: string;
  let ruta: string;
  let cuenta1: CuentaConMovimientos;
  let cuenta2: CuentaConMovimientos;

  beforeAll(async () => {
    await registrarBanco(bancoCodigo, 'BANCO DE PRUEBA — REMEDIACIÓN OK');

    cuenta1 = extractoSintetico({
      semilla: 701,
      cantidadMovimientos: 4,
      saldoInicialCentavos: 5_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo,
    });
    // Cuenta vacía, misma forma que la USD real de Santander/Macro (HANDOFF (42)): 0 movimientos,
    // saldo inicial = saldo final por construcción del generador. Es la que falta al principio.
    cuenta2 = extractoSintetico({
      semilla: 702,
      cantidadMovimientos: 0,
      saldoInicialCentavos: 0n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      moneda: 'USD',
      bancoCodigo,
    });

    const cuentaBancariaId1 = await registrarCuentaDelCliente(s.clienteA, bancoCodigo, cuenta1);
    registrarAdaptadorDePrueba(bancoCodigo, 'REMEDIAR OK', [cuenta1, cuenta2]);

    const archivo = archivoConMarca('REMEDIAR OK');
    ruta = archivo.ruta;
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(archivo.contenido).digest('hex');

    // El estado exacto del lote real de Santander en el piloto: cuenta1 (ARS) ya persistida por el bug
    // de atomicidad, cuenta2 (USD) sin registrar todavía.
    loteId = await crearLoteHuerfano({
      clienteId: s.clienteA,
      bancoCodigo,
      archivoHash: hash,
      motivoCodigo: 'cuenta_no_pertenece_al_cliente',
      yaPersistidas: [{ cuenta: cuenta1, cuentaBancariaId: cuentaBancariaId1 }],
      movimientosEnElLote: 4,
    });

    // El paso que en la vida real hace el operador con `alta-cuenta.ts` ANTES de correr esta remediación.
    await registrarCuentaDelCliente(s.clienteA, bancoCodigo, cuenta2);
  });

  it('completa la cuenta que faltaba: estado, contadores, adaptador_version y auditoría correctos', async () => {
    const antesAuditoria = await contarFilas(
      `select count(*)::text as n from acceso_auditoria where recurso = 'lote_ingesta' and recurso_id = $1`,
      [loteId],
    );

    const { storage, escrituras } = storageEspia();
    const r = await completarLote(
      { cliente: s.clienteA, archivo: ruta, banco: bancoCodigo, usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('completado');
    if (r.estado !== 'completado') return;
    expect(r.loteId).toBe(loteId);
    expect(r.filas).toBe(4);
    // Cuenta vacía y legítima dentro de un lote con movimientos: `procesado_con_observaciones`, mismo
    // caso que Macro/Santander USD (criterio de aceptación de HANDOFF (42), punto 1).
    expect(r.estadoLote).toBe('procesado_con_observaciones');

    const lote = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{
        estado: string;
        motivo_codigo: string | null;
        motivo_codigo_previo: string | null;
        filas_leidas: number;
        filas_aceptadas: number;
        filas_rechazadas: number;
        adaptador_version: string;
        archivo_clave: string | null;
      }>(
        `select estado, motivo_codigo, motivo_codigo_previo, filas_leidas::int as filas_leidas,
                filas_aceptadas::int as filas_aceptadas, filas_rechazadas::int as filas_rechazadas,
                adaptador_version, archivo_clave
           from lote_ingesta where id = $1 and cliente_id = $2`,
        [loteId, s.clienteA],
      );
      return f[0];
    });

    expect(lote?.estado).toBe('procesado_con_observaciones');
    expect(lote?.motivo_codigo).toBeNull();
    expect(lote?.motivo_codigo_previo).toBe('cuenta_no_pertenece_al_cliente');
    expect(lote?.filas_leidas).toBe(4);
    expect(lote?.filas_aceptadas).toBe(4);
    // Vestigial, nunca se inaugura acá (criterio de aceptación, punto 3).
    expect(lote?.filas_rechazadas).toBe(0);
    expect(lote?.adaptador_version).toBe(`${bancoCodigo}@1`);
    expect(lote?.archivo_clave, 'el objeto nunca se había guardado y esta corrida tenía que hacerlo').not.toBeNull();

    const cuentasDelLote = await contarFilas(
      `select count(*)::text as n from lote_ingesta_cuenta where lote_ingesta_id = $1`,
      [loteId],
    );
    expect(cuentasDelLote).toBe(2);

    expect(escrituras, 'tenía que guardar el objeto, nunca antes guardado').toHaveLength(1);

    const auditoriaDespues = await contarFilas(
      `select count(*)::text as n from acceso_auditoria
        where recurso = 'lote_ingesta' and recurso_id = $1 and accion = 'escritura'`,
      [loteId],
    );
    expect(auditoriaDespues - antesAuditoria).toBe(1);

    const motivoAuditoria = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ motivo: string | null }>(
        `select motivo from acceso_auditoria
          where recurso = 'lote_ingesta' and recurso_id = $1 and accion = 'escritura'
          order by ocurrido_en desc limit 1`,
        [loteId],
      );
      return f[0]?.motivo;
    });
    // Solo códigos cerrados: nunca texto libre del operador ni un dato leído del archivo.
    expect(motivoAuditoria).toMatch(/^completar_lote:[a-z_]+$/);
  });

  it('segunda corrida sobre el lote ya completado: ya_completado, sin 23505 crudo', async () => {
    const { storage, escrituras } = storageEspia();
    const r = await completarLote(
      { cliente: s.clienteA, archivo: ruta, banco: bancoCodigo, usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('ya_completado');
    if (r.estado === 'ya_completado') expect(r.loteId).toBe(loteId);
    expect(escrituras).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('1 cuenta faltante que resuelve pero NO cuadra — se trata igual que un fallo de resolución', () => {
  /**
   * `code-reviewer` señaló el hueco: los tests existentes solo cubrían el fallo de RESOLUCIÓN
   * (`resolverCuentaDelExtracto`), nunca el fallo de VERIFICACIÓN sobre una cuenta que sí resolvió — el
   * guardrail explícito de `seguridad-datos-financieros` en HANDOFF (42) ("fallo de verificación después
   * de una resolución exitosa se trata IGUAL que fallo de resolución: aborto limpio").
   */
  it('la cuenta pendiente resuelve pero verificarAritmetica da no_cuadra: rechazado, nada persiste', async () => {
    const bancoCodigo = 'banco_cli_remediar_nocuadra';
    await registrarBanco(bancoCodigo, 'BANCO DE PRUEBA — NO CUADRA');

    const cuenta1 = extractoSintetico({
      semilla: 851,
      cantidadMovimientos: 4,
      saldoInicialCentavos: 2_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo,
    });
    const cuenta2Coherente = extractoSintetico({
      semilla: 852,
      cantidadMovimientos: 4,
      saldoInicialCentavos: 500_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo,
    });
    // Se borra una fila del MEDIO después de generar el fixture: los totales declarados (calculados
    // sobre las 4 filas originales) quedan sin coincidir con las 3 que el adaptador termina reportando.
    // `extractoSintetico` valida su propia coherencia, así que la incoherencia se introduce DESPUÉS, con
    // el mismo mutador que usa `mutaciones.test.ts` — no un fixture armado a mano.
    const cuenta2Rota = mutar(cuenta2Coherente, 'borrar_fila_del_medio');

    const cuentaBancariaId1 = await registrarCuentaDelCliente(s.clienteA, bancoCodigo, cuenta1);
    // cuenta2 SÍ se da de alta (resuelve), pero el documento que se relee trae la versión rota.
    await registrarCuentaDelCliente(s.clienteA, bancoCodigo, cuenta2Rota);
    registrarAdaptadorDePrueba(bancoCodigo, 'NO CUADRA', [cuenta1, cuenta2Rota]);

    const { ruta, contenido } = archivoConMarca('NO CUADRA');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(contenido).digest('hex');

    const loteId = await crearLoteHuerfano({
      clienteId: s.clienteA,
      bancoCodigo,
      archivoHash: hash,
      motivoCodigo: 'cuenta_no_pertenece_al_cliente',
      yaPersistidas: [{ cuenta: cuenta1, cuentaBancariaId: cuentaBancariaId1 }],
      movimientosEnElLote: 7,
    });

    const { storage, escrituras } = storageEspia();
    const r = await completarLote(
      { cliente: s.clienteA, archivo: ruta, banco: bancoCodigo, usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('rechazado');
    if (r.estado === 'rechazado') {
      expect(r.loteId).toBe(loteId);
      // Cualquier código de `CODIGOS_DIFERENCIA` sirve acá: lo que importa es que NO sea un código de
      // resolución (`cuenta_no_pertenece_al_cliente`, `cuenta_no_registrada`, ...) — la cuenta SÍ resolvió,
      // lo que falló fue la aritmética.
      expect(r.motivoCodigo).not.toMatch(/^cuenta_/);
    }
    expect(escrituras, 'un rechazo por no_cuadra no guarda ningún objeto').toEqual([]);

    const lote = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ estado: string; motivo_codigo: string | null }>(
        'select estado, motivo_codigo from lote_ingesta where id = $1 and cliente_id = $2',
        [loteId, s.clienteA],
      );
      return f[0];
    });
    expect(lote?.estado).toBe('con_errores');
    expect(lote?.motivo_codigo).toBe('cuenta_no_pertenece_al_cliente');

    const cuentasDelLote = await contarFilas(
      `select count(*)::text as n from lote_ingesta_cuenta where lote_ingesta_id = $1`,
      [loteId],
    );
    expect(cuentasDelLote, 'la cuenta rota no debería haber entrado').toBe(1);
  });
});

// -----------------------------------------------------------------------------
describe('1 cuenta faltante que NO resuelve — aborta sin tocar nada', () => {
  it('la cuenta que falta sigue sin darse de alta: rechazado, el lote queda exactamente como estaba', async () => {
    const bancoCodigo = 'banco_cli_remediar_norresuelve';
    await registrarBanco(bancoCodigo, 'BANCO DE PRUEBA — NO RESUELVE');

    const cuenta1 = extractoSintetico({
      semilla: 801,
      cantidadMovimientos: 4,
      saldoInicialCentavos: 3_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo,
    });
    const cuenta2 = extractoSintetico({
      semilla: 802,
      cantidadMovimientos: 2,
      saldoInicialCentavos: 1_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo,
    });

    const cuentaBancariaId1 = await registrarCuentaDelCliente(s.clienteA, bancoCodigo, cuenta1);
    registrarAdaptadorDePrueba(bancoCodigo, 'NO RESUELVE', [cuenta1, cuenta2]);

    const { ruta, contenido } = archivoConMarca('NO RESUELVE');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(contenido).digest('hex');

    // cuenta2 NUNCA se registra: es el caso "el operador todavía no dio de alta la cuenta que falta".
    const loteId = await crearLoteHuerfano({
      clienteId: s.clienteA,
      bancoCodigo,
      archivoHash: hash,
      motivoCodigo: 'cuenta_no_pertenece_al_cliente',
      yaPersistidas: [{ cuenta: cuenta1, cuentaBancariaId: cuentaBancariaId1 }],
      movimientosEnElLote: 6,
    });

    const { storage, escrituras } = storageEspia();
    const r = await completarLote(
      { cliente: s.clienteA, archivo: ruta, banco: bancoCodigo, usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('rechazado');
    if (r.estado === 'rechazado') {
      expect(r.loteId).toBe(loteId);
      // El cliente ya tiene cuentas (cuenta1) — el mismo mecanismo de INV-6 que ingestar.ts.
      expect(r.motivoCodigo).toBe('cuenta_no_pertenece_al_cliente');
    }
    expect(escrituras, 'un rechazo no guarda ningún objeto').toEqual([]);

    const lote = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ estado: string; motivo_codigo: string | null }>(
        'select estado, motivo_codigo from lote_ingesta where id = $1 and cliente_id = $2',
        [loteId, s.clienteA],
      );
      return f[0];
    });
    // El lote queda EXACTAMENTE como estaba: esta corrida no escribió nada sobre él.
    expect(lote?.estado).toBe('con_errores');
    expect(lote?.motivo_codigo).toBe('cuenta_no_pertenece_al_cliente');

    const cuentasDelLote = await contarFilas(
      `select count(*)::text as n from lote_ingesta_cuenta where lote_ingesta_id = $1`,
      [loteId],
    );
    expect(cuentasDelLote, 'no debería haber intentado persistir la cuenta que no resuelve').toBe(1);
  });
});

// -----------------------------------------------------------------------------
describe('2 o más cuentas faltantes — aborta explícito, nunca intenta ninguna', () => {
  it('tres cuentas pendientes en el mismo archivo: abortado, el lote queda intacto', async () => {
    const bancoCodigo = 'banco_cli_remediar_multiples';
    await registrarBanco(bancoCodigo, 'BANCO DE PRUEBA — MÚLTIPLES PENDIENTES');

    const cuentas = [901, 902, 903].map((semilla) =>
      extractoSintetico({
        semilla,
        cantidadMovimientos: 2,
        saldoInicialCentavos: 1_000_00n,
        periodoDesde: '2026-06-01',
        periodoHasta: '2026-06-30',
        bancoCodigo,
      }),
    );
    registrarAdaptadorDePrueba(bancoCodigo, 'MULTIPLES PENDIENTES', cuentas);

    const { ruta, contenido } = archivoConMarca('MULTIPLES PENDIENTES');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(contenido).digest('hex');

    // Ninguna de las tres cuentas está registrada: el lote quedó `con_errores` en la etapa de LOTE (por
    // ejemplo `consolidado_no_cuadra`), antes de que existiera una sola fila en `lote_ingesta_cuenta`.
    const loteId = await crearLoteHuerfano({
      clienteId: s.clienteA,
      bancoCodigo,
      archivoHash: hash,
      motivoCodigo: 'cuenta_no_registrada',
      yaPersistidas: [],
      movimientosEnElLote: 6,
    });

    const { storage, escrituras } = storageEspia();
    const r = await completarLote(
      { cliente: s.clienteA, archivo: ruta, banco: bancoCodigo, usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('abortado');
    if (r.estado === 'abortado') {
      expect(r.motivoCodigo).toBe('multiples_cuentas_pendientes');
      expect(r.pendientes).toBe(3);
    }
    expect(escrituras).toEqual([]);

    const cuentasDelLote = await contarFilas(
      `select count(*)::text as n from lote_ingesta_cuenta where lote_ingesta_id = $1`,
      [loteId],
    );
    expect(cuentasDelLote, 'no debería haber intentado persistir ninguna').toBe(0);

    const lote = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ estado: string }>(
        'select estado from lote_ingesta where id = $1 and cliente_id = $2',
        [loteId, s.clienteA],
      );
      return f[0];
    });
    expect(lote?.estado).toBe('con_errores');
  });
});
