/**
 * HU-6 MÍNIMA — bloqueo de una segunda carga con período solapado (doc 35 §2.3/§2.7).
 *
 * Bug que esto previene, ya identificado y diferido a propósito (`ADR-0004`, B.25): `uq_mov_crudo_fila`
 * (fila-a-fila, HU-5) no atrapa una SEGUNDA FUENTE con formato distinto para el mismo cuenta-período — un
 * re-export tras un cambio de versión del sistema del banco, o un PDF vs. un Excel del mismo extracto,
 * produce un `fila_hash` distinto para la misma transacción real y entra como fila nueva sin que nada lo
 * note. La guarda mínima (`persistirCuenta`, `packages/ingesta/src/persistir.ts`) no compara contenido:
 * bloquea, sin excepción, toda segunda carga sobre el mismo `(cliente_id, cuenta_bancaria_id)` cuyo
 * período se solape con uno ya vigente — sin fusión, sin comparación numérica, sin migración.
 *
 * 🔴 **Orden de precedencia, no negociable**: el chequeo de HU-6 corre DESPUÉS del loop de inserción por
 * fila (que ya incluye el catch de `uq_mov_crudo_fila` de HU-5), nunca antes. Si `fila_hash` ya explica
 * el rechazo (contenido idéntico, re-emisión legítima), ESE es el motivo — `fila_duplicada_por_hash` es
 * más específico y tiene que ganar. HU-6 es la red para lo que `fila_hash` no puede ver, no un filtro que
 * se adelante y lo tape. El primer intento de esta tarea invirtió el orden y rompió 9 archivos/28 tests
 * de la suite (HANDOFF, entrada de esta noche) — este archivo prueba ambos lados del orden correcto.
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

/** Copiado de `reingesta-duplicada.test.ts` (mismo patrón ya establecido en este directorio). */
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

function storageEspia(): { storage: ObjectStorage } {
  return {
    storage: {
      async guardar() {},
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
  dirTemporal = mkdtempSync(join(tmpdir(), 'hu6-'));
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('HU-6 mínima: bloqueo de carga con período solapado, sin tapar a HU-5', () => {
  const cuentaPrimera = extractoSintetico({
    semilla: 901,
    cantidadMovimientos: 4,
    saldoInicialCentavos: 300_000_00n,
    periodoDesde: '2026-06-01',
    periodoHasta: '2026-06-30',
    bancoCodigo: 'banco_cli_hu6',
  });
  // Semilla DISTINTA a propósito: contenido económico distinto → `fila_hash` distinto → HU-5 no se
  // dispara. Es exactamente el hueco que HU-6 tiene que atrapar (segunda fuente, período solapado, hash
  // que no matchea). Solo `numero` se fuerza IGUAL al de `cuentaPrimera` (tiene que resolver a la MISMA
  // `cuenta_bancaria_id` — "el mismo banco, otro archivo", no otra cuenta): el resto de `cuenta`
  // (saldos/totales declarados, período) queda como lo generó `extractoSintetico` para esta semilla, así
  // la aritmética interna de ESTE archivo sigue cerrando sola.
  // Período DENTRO del mismo mes a propósito: `extractoSintetico` deriva el mes de las fechas sintéticas
  // de `periodoHasta` sola (`extracto-sintetico.ts:113-114`) y no está pensado para un período que cruza
  // un límite de mes — un `periodoHasta` en julio generaría fechas de julio que caen fuera de un
  // `periodoDesde` de junio. El solape real con `cuentaPrimera` (01-30 de junio) alcanza igual: 15 al 28
  // de junio.
  const cuentaSegundaBase = extractoSintetico({
    semilla: 902,
    cantidadMovimientos: 4,
    saldoInicialCentavos: 300_000_00n,
    periodoDesde: '2026-06-15',
    periodoHasta: '2026-06-28',
    bancoCodigo: 'banco_cli_hu6',
  });
  const cuentaSegundaFuenteDistinta: CuentaConMovimientos = {
    ...cuentaSegundaBase,
    cuenta: { ...cuentaSegundaBase.cuenta, numero: cuentaPrimera.cuenta.numero },
  };

  beforeAll(async () => {
    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `insert into banco (codigo, nombre) values ('banco_cli_hu6', 'BANCO DE PRUEBA HU6')
         on conflict (codigo) do nothing`,
      );
    } finally {
      await duenio.end();
    }

    const cbu = '9990000090000000000901';
    await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_hu6', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const cuentaBancariaId = c[0]?.id;
      if (!cuentaBancariaId) throw new Error('no se creó la cuenta de prueba');
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, cuentaBancariaId, cuentaPrimera.cuenta.numero, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
    });

    // El adaptador distingue por una marca de texto cuál de las dos cuentas sintéticas devolver —
    // mismo patrón que `reingesta-duplicada.test.ts`, pero acá las dos cuentas tienen CONTENIDO
    // DISTINTO (semillas distintas), no el mismo.
    registrarAdaptador({
      bancoCodigo: 'banco_cli_hu6',
      version: 1,
      capacidades: CAPACIDADES_SINTETICAS,
      reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes('MARCA HU6')),
      leer: (entrada) => ({
        cuentas: [
          entrada.filas.some((f) => textoDeFila(f).includes('SEGUNDA FUENTE'))
            ? cuentaSegundaFuenteDistinta
            : cuentaPrimera,
        ],
        lineasNoInterpretadas: [],
        paginasDeclaradas: undefined,
        destinos: undefined,
      }),
    } satisfies Adaptador);
  });

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
   * PREDICCIÓN FALSABLE (antes de correr) — el caso que motivó HU-6: dos archivos con CONTENIDO
   * ECONÓMICO DISTINTO (hash distinto, HU-5 no se dispara) mismo cuenta-período solapado.
   *
   *   1. Primera carga (junio): persiste.
   *   2. Segunda carga (15-28 de junio, contenido con hash distinto): rechazada,
   *      `motivoCodigo:'periodo_solapa_con_carga_existente'` — no `fila_duplicada_por_hash`, porque
   *      ninguna fila colisionó por hash. `lote_ingesta` con `estado:'con_errores'` + 1 fila de rastro
   *      en `acceso_auditoria`, mismo estándar que HU-5.
   *   3. Si (2) da `persistido`/`estado:'procesado'`, la guarda no existe. Si da
   *      `fila_duplicada_por_hash`, el catch de HU-5 se está disparando donde no debería (falso
   *      positivo de hash) — sería síntoma de otro bug, no del que este test mide.
   */
  it('segunda fuente con hash distinto y período solapado: rechazada por HU-6, con lote y rastro', async () => {
    const { storage } = storageEspia();

    const archivo1 = join(dirTemporal, 'hu6-primera.pdf');
    writeFileSync(archivo1, pdfMinimoConTexto(['MARCA HU6 PRIMERA FUENTE', 'SEGUNDA LINEA DE RELLENO PARA EL UMBRAL']));
    const primera = await ingestar(
      { cliente: s.clienteA, archivo: archivo1, banco: 'banco_cli_hu6', usuario: USUARIOS.socio, esDatoReal: 'real' },
      storage,
    );
    expect(primera.estado).toBe('procesado');

    const archivo2 = join(dirTemporal, 'hu6-segunda-fuente.pdf');
    writeFileSync(
      archivo2,
      pdfMinimoConTexto(['MARCA HU6 SEGUNDA FUENTE DISTINTA', 'OTRA LINEA DE RELLENO PARA EL UMBRAL']),
    );
    const segunda = await ingestar(
      { cliente: s.clienteA, archivo: archivo2, banco: 'banco_cli_hu6', usuario: USUARIOS.socio, esDatoReal: 'real' },
      storage,
    );
    expect(segunda.estado).toBe('rechazado');
    if (segunda.estado !== 'rechazado') return;
    expect(segunda.motivoCodigo).toBe('periodo_solapa_con_carga_existente');

    const lote = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ estado: string; motivo_codigo: string | null }>(
        'select estado, motivo_codigo from lote_ingesta where id = $1 and cliente_id = $2',
        [segunda.loteId, s.clienteA],
      ),
    );
    expect(lote[0]?.estado).toBe('con_errores');
    expect(lote[0]?.motivo_codigo).toBe('periodo_solapa_con_carga_existente');
    expect(await contarRechazosDelLote(segunda.loteId)).toBe(1);
  });

  /**
   * PREDICCIÓN FALSABLE — LA REGRESIÓN QUE HAY QUE EVITAR: contenido económico IDÉNTICO (hash idéntico,
   * re-emisión legítima) en el MISMO período — el caso que HU-5 ya cubre y cerró en `bb4e2ea`. Tiene que
   * seguir devolviendo `fila_duplicada_por_hash`, NUNCA `periodo_solapa_con_carga_existente`: si HU-6 se
   * evaluara antes del loop (el error del primer intento de esta tarea), este motivo más específico
   * quedaría inalcanzable para siempre, porque toda re-emisión del mismo período TAMBIÉN es un período
   * solapado.
   */
  it('re-emisión con hash idéntico y mismo período: sigue ganando fila_duplicada_por_hash', async () => {
    const cuentaBancariaId = await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_hu6', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const id = c[0]?.id;
      if (!id) throw new Error('no se creó la cuenta de prueba');
      const cbu = '9990000090000000000903';
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, id, `hu6-precedencia-${id.slice(0, 8)}`, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
      return id;
    });

    const cuenta = extractoSintetico({
      semilla: 904,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 200_000_00n,
      periodoDesde: '2026-08-01',
      periodoHasta: '2026-08-31',
      bancoCodigo: 'banco_cli_hu6',
    });
    const verificacion = { ...verificarAritmetica(cuenta, { capacidades: CAPACIDADES_SINTETICAS }), estado: 'cuadra' as const };

    const loteUno = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
         values ($1, 'banco_cli_hu6', 'sintetico@1', 'archivo', $2, 'recibido', true)
         returning id::text as id`,
        [s.clienteA, 'hu6_precedencia_hash_a'],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó el lote');
      return id;
    });
    const primera = await conUsuario(USUARIOS.socio, (tx) =>
      persistirCuenta(tx, { clienteId: s.clienteA, loteId: loteUno, cuentaBancariaId, cuenta, verificacion }),
    );
    expect(primera.persistido).toBe(true);

    // Mismo `cuenta` (mismos `filaHash`) y mismo período exacto — re-emisión legítima, otro lote.
    const loteDos = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
         values ($1, 'banco_cli_hu6', 'sintetico@1', 'archivo', $2, 'recibido', true)
         returning id::text as id`,
        [s.clienteA, 'hu6_precedencia_hash_b'],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó el lote');
      return id;
    });
    const segunda = await conUsuario(USUARIOS.socio, (tx) =>
      persistirCuenta(tx, { clienteId: s.clienteA, loteId: loteDos, cuentaBancariaId, cuenta, verificacion }),
    );
    expect(segunda.persistido).toBe(false);
    if (segunda.persistido) return;
    expect(segunda.motivoCodigo).toBe('fila_duplicada_por_hash');
  });

  /**
   * PREDICCIÓN FALSABLE: un período ADYACENTE (arranca el día siguiente al que termina el vigente) NO se
   * solapa. Si esto rechazara, el chequeo sería demasiado agresivo (off-by-one) y bloquearía meses
   * consecutivos legítimos.
   */
  it('un período adyacente (sin superposición real) persiste normalmente', async () => {
    const cuentaBancariaId = await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_hu6', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const id = c[0]?.id;
      if (!id) throw new Error('no se creó la cuenta de prueba');
      const cbu = '9990000090000000000911';
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, id, `hu6-adyacente-${id.slice(0, 8)}`, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
      return id;
    });

    const persistirPeriodo = async (loteHash: string, semilla: number, desde: string, hasta: string) => {
      const cuenta = extractoSintetico({
        semilla,
        cantidadMovimientos: 2,
        saldoInicialCentavos: 150_000_00n,
        periodoDesde: desde,
        periodoHasta: hasta,
        bancoCodigo: 'banco_cli_hu6',
      });
      const verificacion = { ...verificarAritmetica(cuenta, { capacidades: CAPACIDADES_SINTETICAS }), estado: 'cuadra' as const };
      const loteId = await conUsuario(USUARIOS.socio, async (tx) => {
        const f = await tx.consultar<{ id: string }>(
          `insert into lote_ingesta
             (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
           values ($1, 'banco_cli_hu6', 'sintetico@1', 'archivo', $2, 'recibido', true)
           returning id::text as id`,
          [s.clienteA, loteHash],
        );
        const id = f[0]?.id;
        if (!id) throw new Error('no se creó el lote');
        return id;
      });
      return conUsuario(USUARIOS.socio, (tx) =>
        persistirCuenta(tx, { clienteId: s.clienteA, loteId, cuentaBancariaId, cuenta, verificacion }),
      );
    };

    const primera = await persistirPeriodo('hu6_adyacente_a', 921, '2026-06-01', '2026-06-30');
    expect(primera.persistido).toBe(true);

    const segunda = await persistirPeriodo('hu6_adyacente_b', 922, '2026-07-01', '2026-07-31');
    expect(segunda.persistido).toBe(true);
  });

  /**
   * PREDICCIÓN FALSABLE: el caso borde exacto — el nuevo período empieza el MISMO día en que termina el
   * vigente (comparten el 30/06) — sí es superposición real y tiene que bloquearse. Distingue el
   * `<=`/`>=` del chequeo de un `<`/`>` que dejaría pasar el borde compartido.
   */
  it('un período que comparte el día de borde con uno vigente se rechaza (no es adyacente)', async () => {
    const cuentaBancariaId = await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_hu6', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const id = c[0]?.id;
      if (!id) throw new Error('no se creó la cuenta de prueba');
      const cbu = '9990000090000000000931';
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, id, `hu6-borde-${id.slice(0, 8)}`, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
      return id;
    });

    const persistirPeriodo = async (loteHash: string, semilla: number, desde: string, hasta: string) => {
      const cuenta = extractoSintetico({
        semilla,
        cantidadMovimientos: 2,
        saldoInicialCentavos: 150_000_00n,
        periodoDesde: desde,
        periodoHasta: hasta,
        bancoCodigo: 'banco_cli_hu6',
      });
      const verificacion = { ...verificarAritmetica(cuenta, { capacidades: CAPACIDADES_SINTETICAS }), estado: 'cuadra' as const };
      const loteId = await conUsuario(USUARIOS.socio, async (tx) => {
        const f = await tx.consultar<{ id: string }>(
          `insert into lote_ingesta
             (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
           values ($1, 'banco_cli_hu6', 'sintetico@1', 'archivo', $2, 'recibido', true)
           returning id::text as id`,
          [s.clienteA, loteHash],
        );
        const id = f[0]?.id;
        if (!id) throw new Error('no se creó el lote');
        return id;
      });
      return conUsuario(USUARIOS.socio, (tx) =>
        persistirCuenta(tx, { clienteId: s.clienteA, loteId, cuentaBancariaId, cuenta, verificacion }),
      );
    };

    const primera = await persistirPeriodo('hu6_borde_a', 941, '2026-06-01', '2026-06-30');
    expect(primera.persistido).toBe(true);

    const segunda = await persistirPeriodo('hu6_borde_b', 942, '2026-06-30', '2026-07-31');
    expect(segunda.persistido).toBe(false);
    if (segunda.persistido) return;
    expect(segunda.motivoCodigo).toBe('periodo_solapa_con_carga_existente');
  });

  /**
   * PREDICCIÓN FALSABLE: dos cuentas bancarias DISTINTAS del mismo cliente, mismo período — el chequeo es
   * por `(cliente_id, cuenta_bancaria_id)`, no solo por cliente. Si esto se rechazara, bloquearía a
   * Laura cargando dos bancos distintos del mismo mes — un falso positivo real.
   */
  it('el mismo período en una cuenta bancaria DISTINTA del mismo cliente no se bloquea', async () => {
    const crearCuenta = async (semillaCbu: number) =>
      conUsuario(USUARIOS.socio, async (tx) => {
        const c = await tx.consultar<{ id: string }>(
          `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
           values ($1, 'banco_cli_hu6', 'ARS') returning id::text as id`,
          [s.clienteA],
        );
        const id = c[0]?.id;
        if (!id) throw new Error('no se creó la cuenta de prueba');
        const cbu = `999000009000000000${semillaCbu}`;
        await tx.consultar(
          `insert into cuenta_bancaria_identificador
             (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
           values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
          [s.clienteA, id, `hu6-multicuenta-${semillaCbu}`, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
        );
        return id;
      });

    const cuentaUno = await crearCuenta(951);
    const cuentaDos = await crearCuenta(952);

    const persistirEn = async (cuentaBancariaId: string, loteHash: string, semilla: number) => {
      const cuenta = extractoSintetico({
        semilla,
        cantidadMovimientos: 2,
        saldoInicialCentavos: 150_000_00n,
        periodoDesde: '2026-06-01',
        periodoHasta: '2026-06-30',
        bancoCodigo: 'banco_cli_hu6',
      });
      const verificacion = { ...verificarAritmetica(cuenta, { capacidades: CAPACIDADES_SINTETICAS }), estado: 'cuadra' as const };
      const loteId = await conUsuario(USUARIOS.socio, async (tx) => {
        const f = await tx.consultar<{ id: string }>(
          `insert into lote_ingesta
             (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, es_dato_real)
           values ($1, 'banco_cli_hu6', 'sintetico@1', 'archivo', $2, 'recibido', true)
           returning id::text as id`,
          [s.clienteA, loteHash],
        );
        const id = f[0]?.id;
        if (!id) throw new Error('no se creó el lote');
        return id;
      });
      return conUsuario(USUARIOS.socio, (tx) =>
        persistirCuenta(tx, { clienteId: s.clienteA, loteId, cuentaBancariaId, cuenta, verificacion }),
      );
    };

    const primera = await persistirEn(cuentaUno, 'hu6_multicuenta_a', 961);
    expect(primera.persistido).toBe(true);

    const segunda = await persistirEn(cuentaDos, 'hu6_multicuenta_b', 962);
    expect(segunda.persistido).toBe(true);
  });
});

// -----------------------------------------------------------------------------
/**
 * ¿UN RECHAZO DE HU-5 DEJA RASTRO QUE BLOQUEE ALGO DESPUÉS? — verificado con evidencia real, no
 * asumido por el patrón de `SAVEPOINT` ya establecido en otros mecanismos de este archivo.
 *
 * `persistirCuenta` inserta `lote_ingesta_cuenta` ANTES del loop de movimientos (necesario por la FK de
 * tres columnas que necesitan los `movimiento_bancario_crudo`). Cuando una fila del loop choca contra
 * `uq_mov_crudo_fila` (HU-5), el `SAVEPOINT` interno (`sp_persistir_movimiento_crudo`) solo envuelve ESE
 * insert puntual — nunca el insert de `lote_ingesta_cuenta` que ya pasó antes. La garantía de que ese
 * insert también se deshace es de una capa más arriba: `rechazar()` (`apps/cli/src/ingestar.ts`) hace
 * `ROLLBACK TO SAVEPOINT despues_del_lote`, que sí cubre todo el intento. Esto solo se prueba yendo por
 * el camino completo de `ingestar()`, no llamando a `persistirCuenta` suelto.
 */
describe('HU-6: un rechazo de HU-5 no deja rastro que bloquee una carga legítima después', () => {
  const PERIODO_DESDE = '2026-05-01';
  const PERIODO_HASTA = '2026-05-28';

  const cuentaA = extractoSintetico({
    semilla: 1001,
    cantidadMovimientos: 3,
    saldoInicialCentavos: 500_000_00n,
    periodoDesde: PERIODO_DESDE,
    periodoHasta: PERIODO_HASTA,
    bancoCodigo: 'banco_cli_hu6_revocacion',
  });
  // Contenido económico DISTINTO (semilla distinta -> fila_hash distinto), mismo período que `cuentaA` y
  // MISMO número de cuenta (forzado abajo) -- para que resuelva a la misma `cuentaBancariaId` y HU-6
  // (no HU-5) sea el único mecanismo que puede rechazarla.
  const cuentaDistintaBase = extractoSintetico({
    semilla: 1002,
    cantidadMovimientos: 3,
    saldoInicialCentavos: 500_000_00n,
    periodoDesde: PERIODO_DESDE,
    periodoHasta: PERIODO_HASTA,
    bancoCodigo: 'banco_cli_hu6_revocacion',
  });
  const cuentaDistinta: CuentaConMovimientos = {
    ...cuentaDistintaBase,
    cuenta: { ...cuentaDistintaBase.cuenta, numero: cuentaA.cuenta.numero },
  };

  let cuentaBancariaId: string;

  beforeAll(async () => {
    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `insert into banco (codigo, nombre) values ('banco_cli_hu6_revocacion', 'BANCO DE PRUEBA HU6 REVOCACION')
         on conflict (codigo) do nothing`,
      );
    } finally {
      await duenio.end();
    }

    const cbu = '9990000090000000001001';
    cuentaBancariaId = await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_hu6_revocacion', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const id = c[0]?.id;
      if (!id) throw new Error('no se creó la cuenta de prueba');
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, id, cuentaA.cuenta.numero, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
      return id;
    });

    // El adaptador distingue por marca de texto: cualquier archivo con "DISTINTA" devuelve el contenido
    // con hash distinto; el resto (original y su reemisión textual) devuelve exactamente `cuentaA`.
    registrarAdaptador({
      bancoCodigo: 'banco_cli_hu6_revocacion',
      version: 1,
      capacidades: CAPACIDADES_SINTETICAS,
      reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes('MARCA REVOCACION')),
      leer: (entrada) => ({
        cuentas: [entrada.filas.some((f) => textoDeFila(f).includes('DISTINTA')) ? cuentaDistinta : cuentaA],
        lineasNoInterpretadas: [],
        paginasDeclaradas: undefined,
        destinos: undefined,
      }),
    } satisfies Adaptador);
  });

  const contarLoteCuenta = async (loteId: string): Promise<number> => {
    const filas = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ n: string }>(
        'select count(*)::text as n from lote_ingesta_cuenta where lote_ingesta_id = $1',
        [loteId],
      ),
    );
    return Number(filas[0]?.n ?? '0');
  };

  /**
   * No existe hoy un mecanismo de revocación real para `lote_ingesta`/`lote_ingesta_cuenta` (HU-7/HU-8,
   * doc 35 §3, deliberadamente sin construir). Se simula acá borrando directo con el dueño del esquema,
   * en el orden de FK correcto -- misma técnica ya documentada en HANDOFF (199).
   *
   * 🔴 Esta lista de 5 tablas es la que corresponde a ESTE escenario puntual (un lote que nunca pasó por
   * Capa C/conciliación ni tiene anexos: `extractoSintetico()` siempre da `anexos: []`, y
   * `reconocimiento_movimiento`/`anexo_extracto`/`documento_ingerido` no se pueblan acá). NO es la lista
   * genérica de un borrado real: HANDOFF (199) tuvo que sumar 3 tablas más sobre lo previsto al
   * ejecutarlo contra un lote real que sí había sido conciliado. Si este helper se reusa para un lote que
   * pasó por `reconocer:lote --aplicar` o que trae anexos, hay que volver a verificar el árbol de FK
   * completo, no asumir que esta lista alcanza.
   */
  const borrarLoteCompleto = async (loteId: string, cuentaBancariaIdDelLote: string): Promise<void> => {
    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `delete from movimiento_contraparte_identificador
          where movimiento_id in (select id from movimiento_bancario_crudo where lote_ingesta_id = $1)`,
        [loteId],
      );
      await duenio.query(
        `delete from movimiento_origen_crudo
          where movimiento_id in (select id from movimiento_bancario_crudo where lote_ingesta_id = $1)`,
        [loteId],
      );
      await duenio.query('delete from movimiento_bancario_crudo where lote_ingesta_id = $1', [loteId]);
      await duenio.query(
        'delete from lote_ingesta_cuenta where lote_ingesta_id = $1 and cuenta_bancaria_id = $2',
        [loteId, cuentaBancariaIdDelLote],
      );
      await duenio.query('delete from lote_ingesta where id = $1', [loteId]);
    } finally {
      await duenio.end();
    }
  };

  /**
   * PREDICCIÓN FALSABLE, en 5 pasos, antes de correr:
   *
   *   1. Cargar A (éxito) -> `procesado`.
   *   2. Reintentar A con archivo distinto, mismo contenido (mismo `fila_hash`) -> `rechazado`,
   *      `motivoCodigo:'fila_duplicada_por_hash'` (HU-5, no HU-6 -- ya probado en el test de precedencia
   *      de arriba). CERO filas en `lote_ingesta_cuenta` para este segundo lote: si el rollback de
   *      `rechazar()` no alcanzara al insert de `lote_ingesta_cuenta` (que pasó antes del loop), acá
   *      quedaría una fila huérfana.
   *   3. Cargar C, contenido distinto, MISMO período que A: A sigue vigente -> `rechazado`,
   *      `motivoCodigo:'periodo_solapa_con_carga_existente'` (HU-6). Esto por sí solo NO prueba que el
   *      paso 2 no dejó nada -- A solo, vigente, ya alcanza para explicar este rechazo.
   *   4. Simular la revocación de A (borrado directo, no hay mecanismo real todavía).
   *   5. LA PRUEBA REAL: reintentar EXACTAMENTE el archivo de C (mismo `archivo_hash`, lote en
   *      `con_errores`, reintentable) -> tiene que dar `procesado`. Si el intento rechazado del paso 2
   *      hubiera dejado algo colgado, este paso fallaría igual que el paso 3 -- y ya no por A, que para
   *      este punto no existe.
   */
  it('revocar la carga vigente habilita una carga nueva sobre el mismo período, sin residuo del rechazo de HU-5 en el medio', async () => {
    const { storage } = storageEspia();

    // PASO 1
    const archivoOriginal = join(dirTemporal, 'hu6rev-original.pdf');
    writeFileSync(
      archivoOriginal,
      pdfMinimoConTexto(['MARCA REVOCACION ORIGINAL', 'RELLENO PARA SUPERAR EL UMBRAL MINIMO DE CARACTERES']),
    );
    const cargaA = await ingestar(
      { cliente: s.clienteA, archivo: archivoOriginal, banco: 'banco_cli_hu6_revocacion', usuario: USUARIOS.socio, esDatoReal: 'real' },
      storage,
    );
    expect(cargaA.estado).toBe('procesado');
    if (cargaA.estado !== 'procesado') return;
    const loteA = cargaA.loteId;

    // PASO 2
    const archivoReemitido = join(dirTemporal, 'hu6rev-reemitida.pdf');
    writeFileSync(
      archivoReemitido,
      pdfMinimoConTexto(['MARCA REVOCACION ORIGINAL REEMITIDA', 'RELLENO PARA SUPERAR EL UMBRAL MINIMO DE CARACTERES']),
    );
    const cargaReemitida = await ingestar(
      { cliente: s.clienteA, archivo: archivoReemitido, banco: 'banco_cli_hu6_revocacion', usuario: USUARIOS.socio, esDatoReal: 'real' },
      storage,
    );
    expect(cargaReemitida.estado).toBe('rechazado');
    if (cargaReemitida.estado !== 'rechazado') return;
    expect(cargaReemitida.motivoCodigo).toBe('fila_duplicada_por_hash');
    expect(
      await contarLoteCuenta(cargaReemitida.loteId),
      'el lote rechazado por HU-5 dejó una fila en lote_ingesta_cuenta -- el rollback de rechazar() no está cubriendo ese insert',
    ).toBe(0);

    // PASO 3
    const archivoDistinto = join(dirTemporal, 'hu6rev-distinta.pdf');
    writeFileSync(
      archivoDistinto,
      pdfMinimoConTexto(['MARCA REVOCACION DISTINTA', 'RELLENO PARA SUPERAR EL UMBRAL MINIMO DE CARACTERES']),
    );
    const cargaC = await ingestar(
      { cliente: s.clienteA, archivo: archivoDistinto, banco: 'banco_cli_hu6_revocacion', usuario: USUARIOS.socio, esDatoReal: 'real' },
      storage,
    );
    expect(cargaC.estado).toBe('rechazado');
    if (cargaC.estado !== 'rechazado') return;
    expect(cargaC.motivoCodigo).toBe('periodo_solapa_con_carga_existente');

    // PASO 4 — revocación simulada de A.
    await borrarLoteCompleto(loteA, cuentaBancariaId);

    // PASO 5 — reintento EXACTO del archivo de C (mismo archivo_hash, lote con_errores, reintentable).
    const cargaD = await ingestar(
      { cliente: s.clienteA, archivo: archivoDistinto, banco: 'banco_cli_hu6_revocacion', usuario: USUARIOS.socio, esDatoReal: 'real' },
      storage,
    );
    expect(
      cargaD.estado,
      'con A revocada, el mismo contenido que antes chocaba contra HU-6 debería persistir -- si sigue rechazado, algo del intento rechazado por HU-5 en el paso 2 quedó colgado',
    ).toBe('procesado');
  });
});
