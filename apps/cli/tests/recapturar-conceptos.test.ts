/**
 * `recapturar-conceptos.ts` — el CLI. Parseo de args, y el flujo completo (storage real + base real):
 * lectura previa de `lote_ingesta`, `obtenerObjetoDeCliente`, releer con el adaptador, compuertas, y
 * mapeo a exit codes. Plan `adaptive-herding-pillow`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { construirClave, configDelEntorno, crearObjectStorage, type ObjectStorage } from '@sistema-contable/almacenamiento';
import {
  CAPACIDADES_SINTETICAS,
  extractoSintetico,
  hashArchivo,
  persistirCuenta,
  registrarAdaptador,
  textoDeFila,
  verificarAritmetica,
  type Adaptador,
  type CuentaConMovimientos,
} from '@sistema-contable/ingesta';
import { hmacIdentificador, ultimos4ParaGuardar } from '@sistema-contable/shared/seguridad';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { parsearArgumentos, recapturarConceptos } from '../src/recapturar-conceptos.ts';

let s: Sembrado;
let storage: ObjectStorage;

beforeAll(async () => {
  s = await sembrar();
  storage = crearObjectStorage(configDelEntorno());
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

async function registrarCuentaDelCliente(clienteId: string, bancoCodigo: string, cuenta: CuentaConMovimientos): Promise<string> {
  const cbuFicticio = `999${cuenta.cuenta.numero}1`.padEnd(22, '0');
  return conUsuario(USUARIOS.socio, async (tx) => {
    const c = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda) values ($1, $2, $3) returning id::text as id`,
      [clienteId, bancoCodigo, cuenta.cuenta.moneda],
    );
    const cuentaBancariaId = c[0]?.id;
    if (!cuentaBancariaId) throw new Error('no se creó la cuenta');
    await tx.consultar(
      `insert into cuenta_bancaria_identificador
         (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
       values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
      [clienteId, cuentaBancariaId, cuenta.cuenta.numero, hmacIdentificador(cbuFicticio), ultimos4ParaGuardar(cbuFicticio)],
    );
    return cuentaBancariaId;
  });
}

/** Mismo generador mínimo de PDF que `completar-lote.test.ts`: hace falta un documento parseable de
 *  verdad porque el CLI llega hasta `extraerTexto`/`aFilas` antes de resolver el adaptador. */
function pdfMinimoConTexto(lineas: readonly string[]): Buffer {
  const objetos: Record<number, string> = {
    1: '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    2: '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    3:
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> ' +
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
  objetos[5] = `5 0 obj\n<< /Length ${contenidoStream.length} >>\nstream\n${contenidoStream}\nendstream\nendobj\n`;

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

function registrarAdaptadorDePrueba(bancoCodigo: string, marca: string, cuentas: readonly CuentaConMovimientos[]): Adaptador {
  const adaptador: Adaptador = {
    bancoCodigo,
    version: 1,
    capacidades: CAPACIDADES_SINTETICAS,
    reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes(marca)),
    leer: () => ({ cuentas: [...cuentas], lineasNoInterpretadas: [], paginasDeclaradas: undefined, destinos: undefined }),
  };
  registrarAdaptador(adaptador);
  return adaptador;
}

/** Crea el lote "pre-0007" (backfilleado a NULL/no_capturado) Y sube el PDF correspondiente a storage,
 *  con `archivo_clave`/`archivo_hash` reales — lo que hace falta para que `recapturarConceptos` (que
 *  arranca leyendo `lote_ingesta` y bajando el objeto de storage) tenga algo real de qué partir. */
async function crearLoteConArchivoEnStorage(
  clienteId: string,
  bancoCodigo: string,
  cuentaBancariaId: string,
  cuenta: CuentaConMovimientos,
  contenido: Buffer,
): Promise<string> {
  const archivoHash = hashArchivo(contenido);
  const clave = construirClave({ clienteId, categoria: 'extracto', recursoId: randomUUID(), extension: 'pdf' });
  await storage.guardar(clave, contenido, 'application/pdf');

  return conUsuario(USUARIOS.socio, async (tx) => {
    const creado = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, archivo_clave, estado, procesado_por)
       values ($1, $2, $3, 'archivo', $4, $5, 'recibido', app.current_user_id())
       returning id::text as id`,
      [clienteId, bancoCodigo, `${bancoCodigo}@pendiente`, archivoHash, clave],
    );
    const loteId = creado[0]?.id;
    if (!loteId) throw new Error('no se creó el lote');

    const verificacion = verificarAritmetica(cuenta, { capacidades: CAPACIDADES_SINTETICAS as never, movimientosEnElLote: cuenta.movimientos.length });
    const persistido = await persistirCuenta(tx, {
      clienteId,
      loteId,
      cuentaBancariaId,
      cuenta,
      verificacion,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    if (!persistido.persistido) throw new Error(`fixture inválido: ${persistido.motivoCodigo}`);

    await tx.consultar(`update lote_ingesta set estado = 'procesado', filas_leidas = $2, filas_aceptadas = $2 where id = $1`, [
      loteId,
      cuenta.movimientos.length,
    ]);
    await tx.consultar(
      `update movimiento_bancario_crudo
          set concepto_banco = null, concepto_completo = null, concepto_banco_estrategia = 'no_capturado', pagina_pdf = null
        where lote_ingesta_id = $1`,
      [loteId],
    );
    return loteId;
  });
}

// -----------------------------------------------------------------------------

describe('parsearArgumentos', () => {
  const uuid = '00000000-0000-0000-0000-000000000000';

  it('falta --lote-id: tira', () => {
    expect(() => parsearArgumentos(['--cliente', uuid, '--usuario', uuid])).toThrow();
  });

  it('--aplicar es una bandera SIN valor: no tira por "necesita un valor"', () => {
    const args = parsearArgumentos(['--cliente', uuid, '--usuario', uuid, '--lote-id', uuid, '--aplicar']);
    expect(args.aplicar).toBe(true);
  });

  it('sin --aplicar: dry-run por defecto', () => {
    const args = parsearArgumentos(['--cliente', uuid, '--usuario', uuid, '--lote-id', uuid]);
    expect(args.aplicar).toBe(false);
  });

  it('uuid mal formado: tira', () => {
    expect(() => parsearArgumentos(['--cliente', 'no-es-un-uuid', '--usuario', uuid, '--lote-id', uuid])).toThrow();
  });
});

describe('recapturarConceptos — flujo completo (storage + base reales)', () => {
  it('dry-run limpio: "listo", sin escribir; --aplicar backfillea', async () => {
    const banco = 'cli_reco_feliz';
    await registrarBanco(banco);
    const cuenta = extractoSintetico({
      semilla: 4001,
      cantidadMovimientos: 5,
      saldoInicialCentavos: 8_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: banco,
    });
    const cuentaBancariaId = await registrarCuentaDelCliente(s.clienteA, banco, cuenta);
    registrarAdaptadorDePrueba(banco, 'MARCA CLI RECO FELIZ', [cuenta]);
    const pdf = pdfMinimoConTexto(['MARCA CLI RECO FELIZ', 'SEGUNDA LINEA PARA SUPERAR EL UMBRAL MINIMO']);
    const loteId = await crearLoteConArchivoEnStorage(s.clienteA, banco, cuentaBancariaId, cuenta, pdf);

    const dry = await recapturarConceptos({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, aplicar: false }, storage);
    expect(dry.estado).toBe('listo');

    const aplicado = await recapturarConceptos({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, aplicar: true }, storage);
    expect(aplicado.estado).toBe('aplicado');
    if (aplicado.estado === 'aplicado') expect(aplicado.filasActualizadas).toBe(5);
  });

  it('sin archivo_clave (nunca se guardó): archivo_no_almacenado', async () => {
    const banco = 'cli_reco_sinarchivo';
    await registrarBanco(banco);
    const loteId = await conUsuario(USUARIOS.socio, async (tx) => {
      const creado = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, procesado_por)
         values ($1, $2, $3, 'archivo', $4, 'procesado', app.current_user_id())
         returning id::text as id`,
        [s.clienteA, banco, `${banco}@1`, randomUUID()],
      );
      const id = creado[0]?.id;
      if (!id) throw new Error('no se creó el lote');
      return id;
    });

    const r = await recapturarConceptos({ cliente: s.clienteA, usuario: USUARIOS.socio, loteId, aplicar: false }, storage);
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'archivo_no_almacenado' });
  });

  it('rol insuficiente: el PDF nunca sale de storage', async () => {
    const banco = 'cli_reco_rol';
    await registrarBanco(banco);
    const cuenta = extractoSintetico({
      semilla: 4002,
      cantidadMovimientos: 2,
      saldoInicialCentavos: 1_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: banco,
    });
    const cuentaBancariaId = await registrarCuentaDelCliente(s.clienteA, banco, cuenta);
    registrarAdaptadorDePrueba(banco, 'MARCA CLI RECO ROL', [cuenta]);
    const pdf = pdfMinimoConTexto(['MARCA CLI RECO ROL', 'SEGUNDA LINEA PARA SUPERAR EL UMBRAL MINIMO']);
    const loteId = await crearLoteConArchivoEnStorage(s.clienteA, banco, cuentaBancariaId, cuenta, pdf);

    const r = await recapturarConceptos({ cliente: s.clienteA, usuario: USUARIOS.contadorA, loteId, aplicar: false }, storage);
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });
  });
});
