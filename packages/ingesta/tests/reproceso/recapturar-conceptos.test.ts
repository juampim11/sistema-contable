/**
 * `recapturarConceptosDeLote` contra base real. Plan `adaptive-herding-pillow`.
 *
 * Reproduce con datos sintéticos el mecanismo exacto del hallazgo de la sesión de diagnóstico: un lote
 * "pre-0007" (`concepto_banco` NULL, `concepto_banco_estrategia='no_capturado'`, tal como quedó Galicia
 * real tras la ALTER TABLE de la migración 0007) se recaptura limpio cuando el releído reproduce el
 * `fila_hash` de lo persistido — y aborta sin escribir nada cuando no lo reproduce.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { hmacIdentificador, ultimos4ParaGuardar } from '@sistema-contable/shared/seguridad';
import {
  CAPACIDADES_SINTETICAS,
  extractoSintetico,
  mutar,
  persistirCuenta,
  recapturarConceptosDeLote,
  verificarAritmetica,
  type CuentaConMovimientos,
  type SalidaDeAdaptador,
} from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../data/tests/ayuda.ts';

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

/** Da de alta la cuenta y su identificador vigente — el paso que en la vida real hace `alta-cuenta.ts`
 *  antes de que un extracto pueda resolver. Mismo patrón que `completar-lote.test.ts`. */
async function registrarCuentaDelCliente(
  clienteId: string,
  bancoCodigo: string,
  cuenta: CuentaConMovimientos,
): Promise<string> {
  const cbuFicticio = `999${cuenta.cuenta.numero}1`.padEnd(22, '0');
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
      [clienteId, cuentaBancariaId, cuenta.cuenta.numero, hmacIdentificador(cbuFicticio), ultimos4ParaGuardar(cbuFicticio)],
    );
    return cuentaBancariaId;
  });
}

/** Persiste una cuenta normalmente y la deja en estado "pre-0007": `concepto_banco`/`concepto_completo`
 *  en NULL y `concepto_banco_estrategia='no_capturado'` — el backfill exacto que dejó la ALTER TABLE de
 *  la migración 0007 sobre filas ya existentes. */
async function crearLotePre0007(
  clienteId: string,
  bancoCodigo: string,
  cuentaBancariaId: string,
  cuenta: CuentaConMovimientos,
): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const creado = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, archivo_clave, estado, procesado_por)
       values ($1, $2, $3, 'archivo', $4, $5, 'recibido', app.current_user_id())
       returning id::text as id`,
      [clienteId, bancoCodigo, `${bancoCodigo}@pendiente`, randomUUID(), `cliente/${clienteId}/extracto/${randomUUID()}.pdf`],
    );
    const loteId = creado[0]?.id;
    if (!loteId) throw new Error('no se creó el lote');

    const verificacion = verificarAritmetica(cuenta, {
      capacidades: CAPACIDADES_SINTETICAS as never,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    const persistido = await persistirCuenta(tx, {
      clienteId,
      loteId,
      cuentaBancariaId,
      cuenta,
      verificacion,
      movimientosEnElLote: cuenta.movimientos.length,
    });
    if (!persistido.persistido) throw new Error(`fixture inválido: ${persistido.motivoCodigo}`);

    await tx.consultar(
      `update lote_ingesta set estado = 'procesado', filas_leidas = $2, filas_aceptadas = $2 where id = $1`,
      [loteId, cuenta.movimientos.length],
    );
    await tx.consultar(
      `update movimiento_bancario_crudo
          set concepto_banco = null, concepto_completo = null, concepto_banco_estrategia = 'no_capturado',
              pagina_pdf = null
        where lote_ingesta_id = $1`,
      [loteId],
    );

    return loteId;
  });
}

function comoSalidaDeAdaptador(...cuentas: readonly CuentaConMovimientos[]): SalidaDeAdaptador {
  return { cuentas, lineasNoInterpretadas: [], paginasDeclaradas: undefined, destinos: undefined };
}

async function contarAuditoria(loteId: string, accion: string): Promise<number> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ n: string }>(
      `select count(*)::text as n from acceso_auditoria
        where recurso = 'lote_ingesta' and recurso_id = $1 and accion = $2`,
      [loteId, accion],
    );
    return Number(f[0]?.n ?? '0');
  });
}

// -----------------------------------------------------------------------------

describe('recapturarConceptosDeLote — camino feliz', () => {
  it('dry-run limpio reporta "listo" y no escribe nada; --aplicar backfillea las 4 columnas', async () => {
    const banco = 'reco_feliz';
    await registrarBanco(banco);
    const cuenta = extractoSintetico({
      semilla: 3001,
      cantidadMovimientos: 6,
      saldoInicialCentavos: 10_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: banco,
    });
    const cuentaBancariaId = await registrarCuentaDelCliente(s.clienteA, banco, cuenta);
    const loteId = await crearLotePre0007(s.clienteA, banco, cuentaBancariaId, cuenta);

    // El `archivo_hash` lo generó `crearLotePre0007` con un uuid al azar (no hay PDF real en este test
    // puro) — se lee de la base para pasarlo como el "ya verificado por `obtenerObjetoDeCliente`".
    const archivoHash = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ archivo_hash: string }>(
        `select archivo_hash from lote_ingesta where id = $1`,
        [loteId],
      );
      return f[0]?.archivo_hash ?? '';
    });

    const dryReal = await conUsuario(USUARIOS.socio, (tx) =>
      recapturarConceptosDeLote(
        tx,
        { clienteId: s.clienteA, loteId, archivoHashEsperado: archivoHash, bancoCodigo: banco, adaptadorVersion: 1, aplicar: false },
        comoSalidaDeAdaptador(cuenta),
      ),
    );
    expect(dryReal.estado).toBe('listo');
    if (dryReal.estado === 'listo') {
      expect(dryReal.compuertas).toEqual({
        totalPersistido: 6,
        totalReleido: 6,
        hashNoReproduce: 0,
        prefijoInv14Falla: 0,
        depuracionDivergente: 0,
        filaNumeroDiverge: 0,
        identificadorEncontrado: 0,
      });
    }

    // Dry-run no escribió nada.
    const sigueSinCapturar = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `select count(*)::text as n from movimiento_bancario_crudo
          where lote_ingesta_id = $1 and concepto_banco_estrategia = 'no_capturado'`,
        [loteId],
      );
      return Number(f[0]?.n ?? '0');
    });
    expect(sigueSinCapturar).toBe(6);

    const aplicado = await conUsuario(USUARIOS.socio, (tx) =>
      recapturarConceptosDeLote(
        tx,
        { clienteId: s.clienteA, loteId, archivoHashEsperado: archivoHash, bancoCodigo: banco, adaptadorVersion: 1, aplicar: true },
        comoSalidaDeAdaptador(cuenta),
      ),
    );
    expect(aplicado.estado).toBe('aplicado');
    if (aplicado.estado === 'aplicado') {
      expect(aplicado.filasActualizadas).toBe(6);
      expect(aplicado.adaptadorVersion).toBe(`${banco}@1`);
    }

    const yaCapturadas = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string; con_concepto: string }>(
        `select count(*)::text as n,
                count(concepto_banco)::text as con_concepto
           from movimiento_bancario_crudo
          where lote_ingesta_id = $1 and concepto_banco_estrategia != 'no_capturado'`,
        [loteId],
      );
      return { n: Number(f[0]?.n ?? '0'), conConcepto: Number(f[0]?.con_concepto ?? '0') };
    });
    expect(yaCapturadas.n).toBe(6);
    expect(yaCapturadas.conConcepto).toBe(6);

    const bancoVersion = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ adaptador_version: string }>(
        `select adaptador_version from lote_ingesta where id = $1`,
        [loteId],
      );
      return f[0]?.adaptador_version;
    });
    expect(bancoVersion).toBe(`${banco}@1`);
  });

  it('segunda corrida de --aplicar: ya_backfilleado, no-op, filas intactas', async () => {
    const banco = 'reco_idempotente';
    await registrarBanco(banco);
    const cuenta = extractoSintetico({
      semilla: 3002,
      cantidadMovimientos: 4,
      saldoInicialCentavos: 5_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: banco,
    });
    const cuentaBancariaId = await registrarCuentaDelCliente(s.clienteA, banco, cuenta);
    const loteId = await crearLotePre0007(s.clienteA, banco, cuentaBancariaId, cuenta);
    const archivoHash = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ archivo_hash: string }>(`select archivo_hash from lote_ingesta where id = $1`, [loteId]);
      return f[0]?.archivo_hash ?? '';
    });

    await conUsuario(USUARIOS.socio, (tx) =>
      recapturarConceptosDeLote(
        tx,
        { clienteId: s.clienteA, loteId, archivoHashEsperado: archivoHash, bancoCodigo: banco, adaptadorVersion: 1, aplicar: true },
        comoSalidaDeAdaptador(cuenta),
      ),
    );

    const segunda = await conUsuario(USUARIOS.socio, (tx) =>
      recapturarConceptosDeLote(
        tx,
        { clienteId: s.clienteA, loteId, archivoHashEsperado: archivoHash, bancoCodigo: banco, adaptadorVersion: 1, aplicar: true },
        comoSalidaDeAdaptador(cuenta),
      ),
    );
    expect(segunda).toEqual({ estado: 'ya_backfilleado', loteId });
  });
});

describe('recapturarConceptosDeLote — compuertas', () => {
  it('el releído no reproduce una fila (mutar borrar_fila_del_medio): "sucio", cero UPDATEs', async () => {
    const banco = 'reco_hashdiverge';
    await registrarBanco(banco);
    const cuenta = extractoSintetico({
      semilla: 3003,
      cantidadMovimientos: 8,
      saldoInicialCentavos: 20_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: banco,
    });
    const cuentaBancariaId = await registrarCuentaDelCliente(s.clienteA, banco, cuenta);
    const loteId = await crearLotePre0007(s.clienteA, banco, cuentaBancariaId, cuenta);
    const archivoHash = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ archivo_hash: string }>(`select archivo_hash from lote_ingesta where id = $1`, [loteId]);
      return f[0]?.archivo_hash ?? '';
    });

    const releidoMutado = mutar(cuenta, 'borrar_fila_del_medio');

    const antesEscritura = await contarAuditoria(loteId, 'escritura');
    const r = await conUsuario(USUARIOS.socio, (tx) =>
      recapturarConceptosDeLote(
        tx,
        { clienteId: s.clienteA, loteId, archivoHashEsperado: archivoHash, bancoCodigo: banco, adaptadorVersion: 1, aplicar: true },
        comoSalidaDeAdaptador(releidoMutado),
      ),
    );

    expect(r.estado).toBe('sucio');
    if (r.estado === 'sucio') {
      expect(r.compuertas.hashNoReproduce).toBeGreaterThan(0);
    }
    // No se auditó ninguna escritura: la corrida nunca llegó a escribirConAuditoria.
    expect(await contarAuditoria(loteId, 'escritura')).toBe(antesEscritura);
    // Y las filas siguen en no_capturado.
    const sinCapturar = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `select count(*)::text as n from movimiento_bancario_crudo
          where lote_ingesta_id = $1 and concepto_banco_estrategia = 'no_capturado'`,
        [loteId],
      );
      return Number(f[0]?.n ?? '0');
    });
    expect(sinCapturar).toBe(8);
  });

  it('la descripción YA ALMACENADA contiene un identificador: "sucio", nunca se escribe', async () => {
    const banco = 'reco_identificador';
    await registrarBanco(banco);
    const cuenta = extractoSintetico({
      semilla: 3004,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 3_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: banco,
    });
    const cuentaBancariaId = await registrarCuentaDelCliente(s.clienteA, banco, cuenta);
    const loteId = await crearLotePre0007(s.clienteA, banco, cuentaBancariaId, cuenta);
    const archivoHash = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ archivo_hash: string }>(`select archivo_hash from lote_ingesta where id = $1`, [loteId]);
      return f[0]?.archivo_hash ?? '';
    });

    // Simula una `descripcion` persistida ANTES de que existiera el detector de DNI (HANDOFF 2026-08-10
    // (17)/(18)) — un DNI de 8 dígitos que la depuración de esa época no tapó. `contieneIdentificador`
    // de hoy sí lo detecta.
    await conUsuario(USUARIOS.socio, async (tx) => {
      const filas = await tx.consultar<{ id: string; descripcion: string }>(
        `select id::text as id, descripcion from movimiento_bancario_crudo where lote_ingesta_id = $1 order by fila_numero limit 1`,
        [loteId],
      );
      const primera = filas[0];
      if (!primera) throw new Error('fixture sin filas');
      await tx.consultar(`update movimiento_bancario_crudo set descripcion = $1 where id = $2`, [
        `${primera.descripcion} 34567890`,
        primera.id,
      ]);
      // El concepto tiene que seguir siendo prefijo de la nueva descripción para no confundir esta
      // compuerta con la de INV-14 — se agrega el DNI al FINAL, después del concepto.
    });

    const r = await conUsuario(USUARIOS.socio, (tx) =>
      recapturarConceptosDeLote(
        tx,
        { clienteId: s.clienteA, loteId, archivoHashEsperado: archivoHash, bancoCodigo: banco, adaptadorVersion: 1, aplicar: true },
        comoSalidaDeAdaptador(cuenta),
      ),
    );

    expect(r.estado).toBe('sucio');
    if (r.estado === 'sucio') {
      expect(r.compuertas.identificadorEncontrado).toBeGreaterThan(0);
    }
  });
});

describe('recapturarConceptosDeLote — aislamiento y abortos', () => {
  it('lote de OTRO cliente: lote_no_encontrado', async () => {
    const banco = 'reco_aislamiento';
    await registrarBanco(banco);
    const cuenta = extractoSintetico({
      semilla: 3005,
      cantidadMovimientos: 2,
      saldoInicialCentavos: 1_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: banco,
    });
    const cuentaBancariaId = await registrarCuentaDelCliente(s.clienteB, banco, cuenta);
    const loteB = await crearLotePre0007(s.clienteB, banco, cuentaBancariaId, cuenta);

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      recapturarConceptosDeLote(
        tx,
        { clienteId: s.clienteA, loteId: loteB, archivoHashEsperado: 'x', bancoCodigo: banco, adaptadorVersion: 1, aplicar: false },
        comoSalidaDeAdaptador(cuenta),
      ),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'lote_no_encontrado' });
  });

  it('lote con_errores: lote_no_recapturable', async () => {
    const banco = 'reco_conerrores';
    await registrarBanco(banco);
    const archivoHash = randomUUID();
    const loteId = await conUsuario(USUARIOS.socio, async (tx) => {
      const creado = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, motivo_codigo, procesado_por)
         values ($1, $2, $3, 'archivo', $4, 'con_errores', 'cuenta_no_registrada', app.current_user_id())
         returning id::text as id`,
        [s.clienteA, banco, `${banco}@1`, archivoHash],
      );
      const id = creado[0]?.id;
      if (!id) throw new Error('no se creó el lote');
      return id;
    });

    const r = await conUsuario(USUARIOS.socio, (tx) =>
      recapturarConceptosDeLote(
        tx,
        { clienteId: s.clienteA, loteId, archivoHashEsperado: archivoHash, bancoCodigo: banco, adaptadorVersion: 1, aplicar: false },
        comoSalidaDeAdaptador(),
      ),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'lote_no_recapturable' });
  });

  it('rol insuficiente: administrativo no puede recapturar (ROLES_QUE_RECAPTURAN = [socio])', async () => {
    const banco = 'reco_rol';
    await registrarBanco(banco);
    const cuenta = extractoSintetico({
      semilla: 3006,
      cantidadMovimientos: 2,
      saldoInicialCentavos: 1_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: banco,
    });
    const cuentaBancariaId = await registrarCuentaDelCliente(s.clienteA, banco, cuenta);
    const loteId = await crearLotePre0007(s.clienteA, banco, cuentaBancariaId, cuenta);
    const archivoHash = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ archivo_hash: string }>(`select archivo_hash from lote_ingesta where id = $1`, [loteId]);
      return f[0]?.archivo_hash ?? '';
    });

    const r = await conUsuario(USUARIOS.administrativoA, (tx) =>
      recapturarConceptosDeLote(
        tx,
        { clienteId: s.clienteA, loteId, archivoHashEsperado: archivoHash, bancoCodigo: banco, adaptadorVersion: 1, aplicar: false },
        comoSalidaDeAdaptador(cuenta),
      ),
    );
    expect(r).toEqual({ estado: 'abortado', motivoCodigo: 'rol_insuficiente' });
  });
});
