/**
 * `exportar-excel.ts` — el CLI. Acá se prueba el parseo de args, la reserva/escritura del destino y el
 * mapeo a exit codes — nunca el contenido del `.xlsx` (eso es `packages/ingesta/tests/`, el único
 * paquete que declara `exceljs`; `apps/cli` no lo tiene como dependencia). Plan `adaptive-herding-pillow`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { CAPACIDADES_SINTETICAS, extractoSintetico, persistirCuenta, verificarAritmetica } from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import {
  escritorReal,
  exportarExcel,
  parsearArgumentos,
  type EscritorReservado,
} from '../src/exportar-excel.ts';

let s: Sembrado;
let dirTemporal: string;

beforeAll(async () => {
  s = await sembrar();
  dirTemporal = mkdtempSync(join(tmpdir(), 'exportar-excel-'));
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

async function crearLoteConCuenta(bancoCodigo: string): Promise<string> {
  await registrarBanco(bancoCodigo);
  const cuentaBancariaId = await conUsuario(USUARIOS.socio, async (tx) => {
    const c = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, $2, 'ARS')
       returning id::text as id`,
      [s.clienteA, bancoCodigo],
    );
    const id = c[0]?.id;
    if (!id) throw new Error('no se creó la cuenta');
    return id;
  });

  const cuenta = extractoSintetico({
    semilla: 900 + bancoCodigo.length,
    cantidadMovimientos: 3,
    saldoInicialCentavos: 5_000_00n,
    periodoDesde: '2026-06-01',
    periodoHasta: '2026-06-30',
    bancoCodigo,
  });

  return conUsuario(USUARIOS.socio, async (tx) => {
    const creado = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, procesado_por)
       values ($1, $2, $3, 'archivo', $4, 'recibido', app.current_user_id())
       returning id::text as id`,
      [s.clienteA, bancoCodigo, `${bancoCodigo}@1`, randomUUID()],
    );
    const loteId = creado[0]?.id;
    if (!loteId) throw new Error('no se creó el lote');

    const verificacion = verificarAritmetica(cuenta, {
      capacidades: CAPACIDADES_SINTETICAS as never,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    const persistido = await persistirCuenta(tx, {
      clienteId: s.clienteA,
      loteId,
      cuentaBancariaId,
      cuenta,
      verificacion,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    if (!persistido.persistido) throw new Error(`fixture inválido: ${persistido.motivoCodigo}`);

    await tx.consultar(`update lote_ingesta set estado = 'procesado', filas_leidas = 3, filas_aceptadas = 3 where id = $1`, [
      loteId,
    ]);
    return loteId;
  });
}

function escritorDePrueba(destinos: string[]): EscritorReservado {
  return {
    reservar: (destino) => {
      writeFileSync(destino, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      destinos.push(destino);
      return 1; // fd simbólico: la escritura real la hace `writeFileSync` de arriba, no `writeSync(fd,...)`
    },
    escribir: (_fd, datos) => {
      const destino = destinos.at(-1);
      if (!destino) throw new Error('no hay destino reservado');
      writeFileSync(destino, Buffer.from(datos));
    },
  };
}

/** El escritor que reserva de verdad (archivo vacío en disco) pero SIEMPRE falla al escribir el
 *  contenido — simula un disco lleno / una I/O real que falla DESPUÉS de que el commit ya ocurrió, sin
 *  mockear `node:fs` entero. */
function escritorQueFallaAlEscribir(): EscritorReservado {
  return {
    reservar: (destino) => {
      writeFileSync(destino, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      return 1;
    },
    escribir: () => {
      throw new Error('disco lleno (simulado)');
    },
  };
}

// -----------------------------------------------------------------------------
// parsearArgumentos
// -----------------------------------------------------------------------------

describe('parsearArgumentos', () => {
  const base = ['--cliente', s0(), '--usuario', s0(), '--motivo', 'demo_contadora', '--destinatario', 'estudio_interno'];

  function s0(): string {
    return '00000000-0000-0000-0000-000000000000';
  }

  it('falta --motivo: tira', () => {
    expect(() =>
      parsearArgumentos(['--cliente', s0(), '--usuario', s0(), '--destinatario', 'estudio_interno', '--lote-id', s0()]),
    ).toThrow();
  });

  it('--motivo con texto libre fuera del vocabulario cerrado: tira', () => {
    expect(() =>
      parsearArgumentos([
        '--cliente', s0(), '--usuario', s0(), '--motivo', 'porque si', '--destinatario', 'estudio_interno', '--lote-id', s0(),
      ]),
    ).toThrow();
  });

  it('--lote-id y --listar juntos: tira (selector ambiguo)', () => {
    expect(() => parsearArgumentos([...base, '--lote-id', s0(), '--listar'])).toThrow();
  });

  it('ninguno de los dos (ni --lote-id ni --listar): tira', () => {
    expect(() => parsearArgumentos(base)).toThrow();
  });

  it('--listar es una bandera SIN valor: no tira por "necesita un valor"', () => {
    const args = parsearArgumentos([...base, '--listar']);
    expect(args.listar).toBe(true);
    expect(args.loteId).toBeUndefined();
  });

  it('uuid mal formado: tira', () => {
    expect(() => parsearArgumentos([...base, '--lote-id', 'no-es-un-uuid'])).toThrow();
  });

  it('camino válido con --lote-id: parsea', () => {
    const args = parsearArgumentos([...base, '--lote-id', s0()]);
    expect(args.loteId).toBe(s0());
    expect(args.listar).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// exportarExcel — destino y escritura
// -----------------------------------------------------------------------------

describe('exportarExcel — destino', () => {
  it('destino ya existe: aborta con destino_existe, el archivo previo queda BYTE A BYTE intacto', async () => {
    const destinos: string[] = [];
    const loteId = await crearLoteConCuenta('cliexport_destino');
    const destino = join(dirTemporal, `ya-existe-${randomUUID()}.xlsx`);
    const contenidoPrevio = Buffer.from('contenido previo, no tocar');
    writeFileSync(destino, contenidoPrevio);

    const escritor: EscritorReservado = {
      reservar: () => {
        // Simula exactamente lo que hace `openSync(destino,'wx',...)` sobre un archivo existente.
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      },
      escribir: () => {
        throw new Error('no debería llamarse: la reserva ya falló');
      },
    };

    const antes = await contarAuditoria(loteId);
    const r = await exportarExcel(
      {
        cliente: s.clienteA,
        usuario: USUARIOS.contadorA,
        motivo: 'demo_contadora',
        destinatario: 'estudio_interno',
        loteId,
        listar: false,
      },
      escritor,
      undefined,
      dirTemporal,
    );

    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'destino_existe' });
    expect(readFileSync(destino)).toEqual(contenidoPrevio);
    // Sin efecto colateral: no se abrió transacción de exportación (el gate de rol/auditoría nunca corrió).
    expect(await contarAuditoria(loteId)).toBe(antes);
    expect(destinos).toEqual([]);
  });

  it('la auditoría ya commiteó pero la escritura a disco falla: no queda archivo, exit distinto de éxito', async () => {
    const loteId = await crearLoteConCuenta('cliexport_fallaescritura');
    const escritor = escritorQueFallaAlEscribir();

    const antes = await contarAuditoria(loteId);
    const r = await exportarExcel(
      {
        cliente: s.clienteA,
        usuario: USUARIOS.contadorA,
        motivo: 'demo_contadora',
        destinatario: 'estudio_interno',
        loteId,
        listar: false,
      },
      escritor,
      undefined,
      dirTemporal,
    );

    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'escritura_fallida' });
    // El commit YA pasó (es el punto del test): exactamente 1 fila nueva, ni 0 ni 2 por un reintento.
    expect(await contarAuditoria(loteId)).toBe(antes + 1);
  });

  it('camino feliz: arranca con PK, bytes>0, estado=exportado', async () => {
    const loteId = await crearLoteConCuenta('cliexport_feliz');
    const destinos: string[] = [];
    const r = await exportarExcel(
      {
        cliente: s.clienteA,
        usuario: USUARIOS.contadorA,
        motivo: 'demo_contadora',
        destinatario: 'estudio_interno',
        loteId,
        listar: false,
      },
      escritorDePrueba(destinos),
      undefined,
      dirTemporal,
    );

    expect(r.estado).toBe('exportado');
    if (r.estado !== 'exportado') return;
    expect(r.bytes).toBeGreaterThan(0);
    expect(existsSync(r.archivo)).toBe(true);
    const contenido = readFileSync(r.archivo);
    expect(contenido[0]).toBe(0x50);
    expect(contenido[1]).toBe(0x4b);

    // El nombre queda legible (banco incluido) y con una forma FIJA — no "contiene banco", la forma
    // completa. `security-engineer`, hallazgo H-1: sin este test, un futuro cambio a la composición se
    // cuela en silencio.
    const nombreArchivo = r.archivo.split(/[\\/]/).at(-1) ?? '';
    expect(nombreArchivo).toMatch(
      /^movimientos_[0-9a-f]{8}_cliexport_feliz_[0-9a-f]{8}_\d{8}T\d{6}Z\.xlsx$/,
    );

    // TTL: recordatorio de destrucción, 7 días desde la generación — nunca un borrado automático
    // (ADR-0002 §F.3.8, es un acto humano). Solo el CÁLCULO está automatizado.
    const hoy = new Date().toISOString().slice(0, 10);
    const enSieteDias = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(r.destruirAntesDe > hoy).toBe(true);
    expect(r.destruirAntesDe).toBe(enSieteDias);
  });

  it('--listar nunca reserva ni escribe un archivo, y nunca llama a resolverBanco', async () => {
    await crearLoteConCuenta('cliexport_listar');
    const destinos: string[] = [];
    let llamado = false;
    const r = await exportarExcel(
      {
        cliente: s.clienteA,
        usuario: USUARIOS.contadorA,
        motivo: 'demo_contadora',
        destinatario: 'estudio_interno',
        listar: true,
      },
      escritorDePrueba(destinos),
      async () => {
        llamado = true;
        return null;
      },
      dirTemporal,
    );

    expect(r.estado).toBe('listado');
    expect(destinos).toEqual([]);
    expect(llamado).toBe(false);
  });

  it('resolverBanco inyectado devuelve null: exporta igual, sin segmento de banco en el nombre', async () => {
    const loteId = await crearLoteConCuenta('cliexport_sinbanco');
    const destinos: string[] = [];
    const r = await exportarExcel(
      {
        cliente: s.clienteA,
        usuario: USUARIOS.contadorA,
        motivo: 'demo_contadora',
        destinatario: 'estudio_interno',
        loteId,
        listar: false,
      },
      escritorDePrueba(destinos),
      async () => null,
      dirTemporal,
    );

    expect(r.estado).toBe('exportado');
    if (r.estado !== 'exportado') return;
    const nombreArchivo = r.archivo.split(/[\\/]/).at(-1) ?? '';
    expect(nombreArchivo).toMatch(/^movimientos_[0-9a-f]{8}_[0-9a-f]{8}_\d{8}T\d{6}Z\.xlsx$/);
  });

  it('resolverBanco inyectado devuelve null y el lote NO existe: lote_no_encontrado, sin archivo', async () => {
    const destinos: string[] = [];
    const r = await exportarExcel(
      {
        cliente: s.clienteA,
        usuario: USUARIOS.contadorA,
        motivo: 'demo_contadora',
        destinatario: 'estudio_interno',
        loteId: randomUUID(),
        listar: false,
      },
      escritorDePrueba(destinos),
      async () => null,
      dirTemporal,
    );

    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'lote_no_encontrado' });
    // La reserva ocurre ANTES de saber si el lote existe (así tiene que ser: el nombre se arma antes de
    // abrir la transacción real) — lo que importa es que se limpia, no que nunca se haya tocado disco.
    for (const d of destinos) expect(existsSync(d)).toBe(false);
  });

  it('resolverBanco inyectado devuelve un banco DISTINTO del real: banco_incoherente, cero bytes', async () => {
    const loteId = await crearLoteConCuenta('cliexport_incoherente');
    const antes = await contarAuditoria(loteId);
    const destinos: string[] = [];
    let escribioSeLlamo = false;
    const escritor: EscritorReservado = {
      ...escritorDePrueba(destinos),
      escribir: () => {
        // No debería llegar acá NUNCA: el chequeo de coherencia tiene que cortar ANTES. Un spy en vez de
        // solo mirar el estado final del disco (`code-reviewer`: los dos escenarios —corta antes de
        // escribir, o escribe y después se borra igual— dejan el mismo archivo final, 0 bytes).
        escribioSeLlamo = true;
      },
    };
    const r = await exportarExcel(
      {
        cliente: s.clienteA,
        usuario: USUARIOS.contadorA,
        motivo: 'demo_contadora',
        destinatario: 'estudio_interno',
        loteId,
        listar: false,
      },
      escritor,
      async () => 'un_banco_que_no_es',
      dirTemporal,
    );

    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'banco_incoherente' });
    expect(escribioSeLlamo).toBe(false);
    // La reserva se hizo y se limpió: nada quedó en disco.
    for (const d of destinos) expect(existsSync(d)).toBe(false);
    // La auditoría del intento real SÍ quedó (ya commiteó adentro de exportarPlanillaDeLote, antes del
    // chequeo de coherencia) — mismo criterio que el resto de los abortos post-commit.
    expect(await contarAuditoria(loteId)).toBe(antes + 1);
  });

  it('resolverBanco inyectado lanza: la promesa rechaza, nada se reserva todavía', async () => {
    const loteId = await crearLoteConCuenta('cliexport_lanza');
    const destinos: string[] = [];
    const promesa = exportarExcel(
      {
        cliente: s.clienteA,
        usuario: USUARIOS.contadorA,
        motivo: 'demo_contadora',
        destinatario: 'estudio_interno',
        loteId,
        listar: false,
      },
      escritorDePrueba(destinos),
      async () => {
        throw new Error('falla simulada de la lectura previa');
      },
    );

    await expect(promesa).rejects.toThrow('falla simulada de la lectura previa');
    expect(destinos).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// `escritorReal` — el camino que corre en producción (`openSync`/`writeSync`/`closeSync` sobre el mismo
// `fd`), no los dobles de arriba que reabren por ruta. `code-reviewer` lo señaló: sin esto, la ruta real
// nunca se ejercitaba.
// -----------------------------------------------------------------------------

describe('escritorReal', () => {
  it('reserva y escribe el contenido completo, byte a byte', () => {
    const destino = join(dirTemporal, `real-${randomUUID()}.xlsx`);
    const datos = new Uint8Array(Buffer.from('PK contenido de prueba, no un xlsx real'));

    const fd = escritorReal.reservar(destino);
    escritorReal.escribir(fd, datos);

    expect(readFileSync(destino)).toEqual(Buffer.from(datos));
  });

  it('reservar sobre un destino existente tira EEXIST, mismo código que valida exportarExcel', () => {
    const destino = join(dirTemporal, `real-existente-${randomUUID()}.xlsx`);
    writeFileSync(destino, 'ya está');
    expect(() => escritorReal.reservar(destino)).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
  });
});

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
