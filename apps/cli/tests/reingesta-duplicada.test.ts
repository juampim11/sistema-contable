/**
 * REEMISIÓN DE UN EXTRACTO — el lote-ancla no se pierde (doc 35 §2.2).
 *
 * Bug real, existente HOY, sin relación con el wizard ni con la demo: un extracto reemitido (archivo
 * distinto, al menos una fila con el mismo contenido económico que una ya ingerida) dispara `23505` sobre
 * `uq_mov_crudo_fila` dentro de `persistirCuenta` — y nadie lo capturaba. El error subía como excepción
 * hasta el `catch` de `conUsuario`, que revierte la transacción ENTERA, incluido el `insert` del lote-ancla
 * del PASO 4. Resultado, antes del fix: cero rastro — ni `motivo_codigo`, ni fila en `acceso_auditoria`, la
 * excepción sube hasta el llamador.
 *
 * El fix es un `try/catch` puntual en `persistir.ts`, filtrado por `error.constraint`, que traduce ESE caso
 * puntual al vocabulario ya existente de rechazo (`persistido:false`) — mismo mecanismo que ya usan
 * `concepto_banco_no_es_prefijo` y el resto de los rechazos vecinos.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cerrarConexiones, conUsuario, ErrorDeBase } from '@sistema-contable/data';
import { hmacIdentificador, ultimos4ParaGuardar } from '@sistema-contable/shared/seguridad';
import type { ObjectStorage } from '@sistema-contable/almacenamiento';
import {
  CAPACIDADES_SINTETICAS,
  extractoSintetico,
  hashFila,
  persistirCuenta,
  registrarAdaptador,
  textoDeFila,
  verificarAritmetica,
  type Adaptador,
  type CuentaConMovimientos,
} from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { ingestar } from '../src/ingestar.ts';

let s: Sembrado;
let dirTemporal: string;

/**
 * Copiado del mismo helper de `ingestar.test.ts` (no hay módulo compartido de fixtures de PDF entre los
 * archivos de este directorio; es el patrón ya establecido). Un PDF mínimo, de verdad, para que
 * `extraerTexto`/`aFilas` (`unpdf`) lo puedan parsear.
 */
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

beforeAll(async () => {
  s = await sembrar();
  dirTemporal = mkdtempSync(join(tmpdir(), 'reingesta-'));
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('reemisión: un archivo distinto con una fila de igual contenido económico', () => {
  const cuentaBase = extractoSintetico({
    semilla: 731,
    cantidadMovimientos: 4,
    saldoInicialCentavos: 300_000_00n,
    periodoDesde: '2026-06-01',
    periodoHasta: '2026-06-30',
    bancoCodigo: 'banco_cli_reemision',
  });

  beforeAll(async () => {
    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `insert into banco (codigo, nombre) values ('banco_cli_reemision', 'BANCO DE PRUEBA REEMISION')
         on conflict (codigo) do nothing`,
      );
    } finally {
      await duenio.end();
    }

    const cbu = '9990000090000000000731';
    await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_reemision', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const cuentaBancariaId = c[0]?.id;
      if (!cuentaBancariaId) throw new Error('no se creó la cuenta de prueba');
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, cuentaBancariaId, cuentaBase.cuenta.numero, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
    });

    // El adaptador de este test SIEMPRE devuelve la MISMA cuenta (mismos `filaHash`), sin importar qué
    // archivo lo disparó: es lo que permite construir "un archivo distinto con la misma fila" sin depender
    // de que el parser lea el PDF de verdad — el PDF solo tiene que hacer que `reconoce()` dé `true`.
    registrarAdaptador({
      bancoCodigo: 'banco_cli_reemision',
      version: 1,
      capacidades: CAPACIDADES_SINTETICAS,
      reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes('MARCA REEMISION 2026-09-15')),
      leer: () => ({
        cuentas: [cuentaBase],
        lineasNoInterpretadas: [],
        paginasDeclaradas: undefined,
        destinos: undefined,
      }),
    } satisfies Adaptador);
  });

  const contarLotesPorHash = async (loteId: string): Promise<number> => {
    const f = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ n: string }>(
        `select count(*)::text as n from lote_ingesta
          where cliente_id = $1
            and archivo_hash = (select archivo_hash from lote_ingesta where id = $2)`,
        [s.clienteA, loteId],
      ),
    );
    return Number(f[0]?.n ?? '0');
  };

  const contarRechazosDelLote = async (loteId: string): Promise<number> => {
    const duenio = await clienteDuenio();
    try {
      const { rows } = await duenio.query<{ n: string }>(
        `select count(*)::text as n from acceso_auditoria
          where accion = 'rechazo' and recurso_id = $1`,
        [loteId],
      );
      return Number(rows[0]?.n ?? '0');
    } finally {
      await duenio.end();
    }
  };

  /**
   * LÍNEA DE BASE, medida antes de tocar `persistir.ts` (contra el código sin el fix), y confirmada:
   *
   *   - la segunda ingesta LANZA `ErrorDeBase('ING_DUPLICADO', 'uq_mov_crudo_fila')` — no vuelve un
   *     resultado, sube como excepción (lo que en el CLI real es `exit 2`);
   *   - `lote_ingesta` para el `archivo_hash` del segundo intento: **inexistente** (el `ROLLBACK` se llevó
   *     puesto el `insert` del PASO 4, el lote-ancla);
   *   - `acceso_auditoria` con `accion='rechazo'` para ese intento: **0 filas** (no hay lote del que colgar
   *     el rastro).
   *
   * Este test verifica el comportamiento DESPUÉS del fix — la línea de base quedó documentada en
   * `HANDOFF.md` (entrada 2026-09-15, 213), no acá, porque un test que afirma el bug se rompería solo en
   * cuanto el fix se aplique.
   */
  it('la reemisión se rechaza con motivoCodigo=fila_duplicada_por_hash, con lote y rastro', async () => {
    const { storage } = storageEspia();

    const archivo1 = join(dirTemporal, 'reemision-original.pdf');
    writeFileSync(
      archivo1,
      pdfMinimoConTexto([
        'MARCA REEMISION 2026-09-15 ARCHIVO ORIGINAL',
        'SEGUNDA LINEA PARA SUPERAR EL UMBRAL DE CARACTERES MINIMOS',
      ]),
    );
    const primera = await ingestar(
      { cliente: s.clienteA, archivo: archivo1, banco: 'banco_cli_reemision', usuario: USUARIOS.socio, esDatoReal: 'real' },
      storage,
    );
    expect(primera.estado).toBe('procesado');
    if (primera.estado !== 'procesado') return;

    // El "reemitido": bytes distintos (archivo_hash distinto), pero el adaptador de prueba devuelve la
    // MISMA cuenta — o sea, al menos una fila con el mismo contenido económico que ya se persistió.
    const archivo2 = join(dirTemporal, 'reemision-reemitido.pdf');
    writeFileSync(
      archivo2,
      pdfMinimoConTexto([
        'MARCA REEMISION 2026-09-15 ARCHIVO REEMITIDO',
        'SEGUNDA LINEA PARA SUPERAR EL UMBRAL DE CARACTERES MINIMOS',
      ]),
    );
    const args2 = {
      cliente: s.clienteA,
      archivo: archivo2,
      banco: 'banco_cli_reemision',
      usuario: USUARIOS.socio,
      esDatoReal: 'real' as const,
    };

    const segunda = await ingestar(args2, storage);
    expect(segunda.estado).toBe('rechazado');
    if (segunda.estado !== 'rechazado') return;
    expect(segunda.motivoCodigo).toBe('fila_duplicada_por_hash');

    const lote = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ estado: string; motivo_codigo: string | null }>(
        'select estado, motivo_codigo from lote_ingesta where id = $1 and cliente_id = $2',
        [segunda.loteId, s.clienteA],
      ),
    );
    expect(lote[0]?.estado).toBe('con_errores');
    expect(lote[0]?.motivo_codigo).toBe('fila_duplicada_por_hash');

    expect(await contarLotesPorHash(segunda.loteId), 'el lote-ancla del segundo intento no existe').toBe(1);
    expect(
      await contarRechazosDelLote(segunda.loteId),
      'el rechazo no dejó exactamente una fila de rastro',
    ).toBe(1);
  });

  /**
   * CONTROL NEGATIVO, exigido por el plan: dos filas con contenido económico idéntico DENTRO del mismo
   * archivo (duplicado intra-lote, no inter-lote). `ordinalEnEmpate` (`hash.ts`) tiene que seguir
   * distinguiéndolas — si este catch las atrapara igual, sería un bug de `hash.ts`, no el caso que este fix
   * ataca. Se prueba directo contra `persistirCuenta`, sin pasar por el CLI: alcanza con una sola cuenta con
   * dos movimientos de igual (fecha, importe, saldo, descripción) y `ordinalEnEmpate` 0 y 1.
   */
  it('control negativo: un duplicado intra-lote NO cae en fila_duplicada_por_hash — se persisten los dos', async () => {
    const base = extractoSintetico({
      semilla: 741,
      cantidadMovimientos: 2,
      saldoInicialCentavos: 400_000_00n,
      periodoDesde: '2026-07-01',
      periodoHasta: '2026-07-31',
      bancoCodigo: 'banco_cli_reemision',
      // Sin repetición forzada ni saldo acreedor: se arman las dos filas EMPATADAS a mano abajo.
      conRepetidos: false,
      conSaldoAcreedor: false,
    });

    const [m0, m1] = base.movimientos;
    if (!m0 || !m1) throw new Error('el fixture no generó las dos filas esperadas');

    // Se fuerza el empate GENUINO: la SEGUNDA fila es una copia exacta de la primera —misma fecha,
    // importe, saldo, descripción y `conceptoBanco` (INV-14 exige que sea prefijo de la descripción que se
    // guarda, y acá tiene que seguir siéndolo)—, solo con `filaNumero`/`paginaPdf` propios y
    // `ordinalEnEmpate=1` (la primera ya lleva 0), que es exactamente lo que produce `asignarOrdinales`
    // para dos filas idénticas del mismo archivo. Los dos `filaHash` quedan distintos por construcción.
    const empatada: CuentaConMovimientos['movimientos'][number] = {
      ...m0,
      filaNumero: m1.filaNumero,
      paginaPdf: m1.paginaPdf,
      filaHash: hashFila({
        cuenta: { bancoCodigo: 'banco_cli_reemision', numeroNormalizado: base.cuenta.numero ?? '', moneda: base.cuenta.moneda },
        fecha: m0.fecha,
        importe: m0.importe,
        saldo: m0.saldo ?? null,
        descripcion: m0.descripcion,
        ordinalEnEmpate: 1,
      }),
    };
    const cuentaConEmpate: CuentaConMovimientos = { ...base, movimientos: [m0, empatada] };

    const cbu = '9990000090000000000741';
    const cuentaBancariaId = await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_reemision', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const id = c[0]?.id;
      if (!id) throw new Error('no se creó la cuenta de prueba');
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, id, `${base.cuenta.numero}-741`, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
      return id;
    });

    const loteId = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
         values ($1, 'banco_cli_reemision', 'sintetico@1', 'archivo', $2, 'recibido', true)
         returning id::text as id`,
        [s.clienteA, 'hash_control_negativo_741'],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó el lote');
      return id;
    });

    const verificacion = { ...verificarAritmetica(cuentaConEmpate, { capacidades: CAPACIDADES_SINTETICAS }), estado: 'cuadra' as const };

    const r = await conUsuario(USUARIOS.socio, (tx) =>
      persistirCuenta(tx, {
        clienteId: s.clienteA,
        loteId,
        cuentaBancariaId,
        cuenta: cuentaConEmpate,
        verificacion,
      }),
    );

    expect(r.persistido, 'un empate genuino distinguido por ordinalEnEmpate se rechazó como duplicado').toBe(
      true,
    );
    if (r.persistido) expect(r.filas).toBe(2);

    const n = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo where lote_ingesta_id = $1',
        [loteId],
      ),
    );
    expect(n[0]?.n).toBe('2');
  });

  /**
   * PRUEBA DE MUTACIÓN — hallazgo, no cierre limpio (`HANDOFF.md`, entrada 2026-09-15, 213, sección
   * "Verificación").
   *
   * El plan pide construir un fixture con `uq_anexo_orden` o `uq_lote_cuenta_natural` para confirmar que
   * sacar `error.constraint === 'uq_mov_crudo_fila'` (dejando solo `error.codigo === 'ING_DUPLICADO'`) pone
   * rojo el test. Verificado leyendo `persistir.ts` de nuevo: NINGUNA de las dos violaciones pasa por el
   * `try/catch` que este fix agregó — `uq_lote_cuenta_natural` la dispara el `insert` de
   * `lote_ingesta_cuenta` (línea ~190, ANTES del catch) y `uq_anexo_orden` la dispara `persistirAnexos`
   * (función aparte, llamada DESPUÉS de cerrado el bucle). Este test lo deja demostrado en vivo: con
   * `uq_lote_cuenta_natural`, el resultado es el mismo (lanza) esté o no la condición del filtro — la
   * mutación NO se detecta con este fixture.
   *
   * La mutación que SÍ discrimina —una violación de OTRA constraint, pero en la MISMA tabla
   * (`movimiento_bancario_crudo`) y en el MISMO `insert` que el `try/catch` envuelve— está en el test
   * siguiente, `mov_crudo_moneda_chk` (mismo archivo, más abajo).
   */
  it('uq_lote_cuenta_natural NO pasa por el catch del fix — siempre relanza (evidencia del hallazgo)', async () => {
    const cuenta = extractoSintetico({
      semilla: 751,
      cantidadMovimientos: 2,
      saldoInicialCentavos: 100_000_00n,
      periodoDesde: '2026-08-01',
      periodoHasta: '2026-08-31',
      bancoCodigo: 'banco_cli_reemision',
    });
    const cbu = '9990000090000000000751';
    const cuentaBancariaId = await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_reemision', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const id = c[0]?.id;
      if (!id) throw new Error('no se creó la cuenta de prueba');
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, id, `${cuenta.cuenta.numero}-751`, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
      return id;
    });
    const loteId = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
         values ($1, 'banco_cli_reemision', 'sintetico@1', 'archivo', $2, 'recibido', true)
         returning id::text as id`,
        [s.clienteA, 'hash_mutacion_751'],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó el lote');
      return id;
    });
    const verificacion = { ...verificarAritmetica(cuenta, { capacidades: CAPACIDADES_SINTETICAS }), estado: 'cuadra' as const };

    // Primera vez: persiste bien.
    const primera = await conUsuario(USUARIOS.socio, (tx) =>
      persistirCuenta(tx, { clienteId: s.clienteA, loteId, cuentaBancariaId, cuenta, verificacion }),
    );
    expect(primera.persistido).toBe(true);

    // Segunda vez: MISMO lote, MISMA cuenta bancaria — `uq_lote_cuenta_natural` salta en el `insert` de
    // `lote_ingesta_cuenta`, ANTES de llegar al catch del fix. Relanza siempre, con o sin la mutación.
    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        persistirCuenta(tx, { clienteId: s.clienteA, loteId, cuentaBancariaId, cuenta, verificacion }),
      ),
    ).rejects.toThrow();
  });

  /**
   * LA MUTACIÓN QUE SÍ CORRESPONDE (`HANDOFF.md`, entrada 2026-09-15, 213, sección "Verificación";
   * hallazgo de `code-reviewer`, no bloqueante, cerrado en esta misma tarea).
   *
   * A diferencia de `uq_lote_cuenta_natural` (test anterior), acá la violación ocurre en la MISMA tabla
   * (`movimiento_bancario_crudo`) y en el MISMO `insert` que el `try/catch` del fix envuelve —
   * `mov_crudo_moneda_chk` (`packages/data/migrations/0004_ingesta.sql:463`, `check (moneda ~
   * '^[A-Z]{3}$')`) salta ANTES de llegar al filtro `error.constraint === 'uq_mov_crudo_fila'`, así que el
   * error SÍ pasa por el `catch`. Si el filtro se aflojara a "atrapar cualquier `ErrorDeBase`" (la
   * mutación que el comentario de `persistir.ts` dice explícitamente que evita), esta violación de un
   * `check` —`error.codigo === 'ING_CHECK'`, ni siquiera `ING_DUPLICADO`— se confundiría con una reemisión
   * legítima y devolvería `{persistido:false, motivoCodigo:'fila_duplicada_por_hash'}` en vez de relanzar.
   *
   * `moneda: 'zz'` (minúscula, dos caracteres) es el mismo valor plantado que usa
   * `packages/data/tests/errores-pg.test.ts` para violar esta constraint — no pasa por `monedaSchema`
   * (`'ARS' | 'USD'`) de `esquema.ts`, así que se fuerza el valor inválido con un cast, exactamente como
   * ya hace este archivo con `ordinalEnEmpate` en el control negativo de arriba: `persistirCuenta` se
   * llama directo, sin pasar por el CLI ni por el Zod de `ingestar.ts`.
   */
  it('mov_crudo_moneda_chk SÍ pasa por el catch del fix y relanza — no se confunde con fila_duplicada_por_hash', async () => {
    const cuenta = extractoSintetico({
      semilla: 761,
      cantidadMovimientos: 1,
      saldoInicialCentavos: 100_000_00n,
      periodoDesde: '2026-09-01',
      periodoHasta: '2026-09-30',
      bancoCodigo: 'banco_cli_reemision',
    });
    const [m0] = cuenta.movimientos;
    if (!m0) throw new Error('el fixture no generó el movimiento esperado');

    const cuentaConMonedaInvalida: CuentaConMovimientos = {
      ...cuenta,
      movimientos: [
        {
          ...m0,
          // Cast deliberado: `Moneda` es `'ARS' | 'USD'` y no admite este valor — es justo por eso que
          // hace falta forzarlo para llegar al `check` de la base en vez de quedar atajado antes por Zod.
          moneda: 'zz' as unknown as CuentaConMovimientos['movimientos'][number]['moneda'],
        },
      ],
    };

    const cbu = '9990000090000000000761';
    const cuentaBancariaId = await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_reemision', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const id = c[0]?.id;
      if (!id) throw new Error('no se creó la cuenta de prueba');
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, id, `${cuenta.cuenta.numero}-761`, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
      return id;
    });
    const loteId = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
         values ($1, 'banco_cli_reemision', 'sintetico@1', 'archivo', $2, 'recibido', true)
         returning id::text as id`,
        [s.clienteA, 'hash_moneda_chk_761'],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó el lote');
      return id;
    });
    // Forzado a `cuadra`, igual que el resto de los tests de este archivo: lo que se está probando es el
    // catch de la constraint, no el veredicto de la verificación aritmética.
    const verificacion = {
      ...verificarAritmetica(cuentaConMonedaInvalida, { capacidades: CAPACIDADES_SINTETICAS }),
      estado: 'cuadra' as const,
    };

    let errorCapturado: unknown;
    try {
      await conUsuario(USUARIOS.socio, (tx) =>
        persistirCuenta(tx, {
          clienteId: s.clienteA,
          loteId,
          cuentaBancariaId,
          cuenta: cuentaConMonedaInvalida,
          verificacion,
        }),
      );
      expect.unreachable('el insert con moneda inválida debería violar mov_crudo_moneda_chk');
    } catch (error) {
      errorCapturado = error;
    }

    expect(errorCapturado).toBeInstanceOf(ErrorDeBase);
    const traducido = errorCapturado as ErrorDeBase;
    // Es la constraint real la que discrimina — no el código: `mov_crudo_moneda_chk` traduce a
    // `ING_CHECK`, que ya es distinto de `ING_DUPLICADO`, pero lo que este test fija es el NOMBRE exacto
    // que el filtro de `persistir.ts` tiene que seguir rechazando.
    expect(traducido.constraint).toBe('mov_crudo_moneda_chk');
    expect(traducido.codigo).toBe('ING_CHECK');
  });
});
