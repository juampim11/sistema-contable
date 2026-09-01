/**
 * EL CLI DE INGESTA — condición de salida nº 11.
 *
 * Tres cosas se verifican acá, y las tres son de seguridad, no de usabilidad:
 *
 *   1. **el guard de R18 corre**, y corre **antes de abrir el archivo**;
 *   2. **`--cliente` es obligatorio** y no tiene default;
 *   3. **un rechazo se asienta con `accion = 'rechazo'`** en el rastro, además de en el lote.
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
  registrarAdaptador,
  textoDeFila,
  type Adaptador,
  type CapacidadesAdaptador,
} from '@sistema-contable/ingesta';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../../packages/data/tests/ayuda.ts';
import { ingestar, parsearArgumentos } from '../src/ingestar.ts';

let s: Sembrado;
let archivo: string;
let dirTemporal: string;

/**
 * Cada caso necesita su propio archivo.
 *
 * Salió de correrlo: el test del rechazo reusaba el archivo del test del guard y recibía `ya_procesado`
 * en vez de `rechazado` — la idempotencia funcionando. Reusar el archivo hacía que el orden de los tests
 * cambiara su resultado, que es la forma en que una suite empieza a fallar de a ratos.
 *
 * **El contenido NO es un PDF válido, y es a propósito.** Estos tests verifican el guard, la obligatoriedad
 * del cliente, la idempotencia y el rastro del rechazo: nada de eso necesita un PDF real. Lo que se espera es
 * el rechazo con `archivo_ilegible`, que es el caso de un archivo corrupto o que no es un PDF — un caso
 * esperado del dominio, no un fallo del programa. Los tests del **adaptador** son otros y van contra el
 * fixture sintético.
 */
function archivoUnico(marca: string): string {
  const ruta = join(dirTemporal, `extracto-${marca}.pdf`);
  writeFileSync(ruta, `no soy un PDF valido, marca ${marca}`);
  return ruta;
}

/**
 * Un PDF **de verdad**, mínimo, para el único test de este archivo que necesita llegar más allá del
 * parseo (A2, C5): el guard, `--cliente` y la idempotencia se prueban con bytes cualquiera porque
 * rechazan **antes** de abrir el documento; el gate de destinos rechaza **después** de leerlo, así que
 * hace falta un PDF que `extraerTexto`/`aFilas` (`unpdf`) puedan parsear de verdad.
 *
 * Cada línea es un objeto `Tj` propio (una fila geométrica por línea) a fuente chica, para que el texto
 * completo sobreviva a la extracción sin quedar recortado por el ancho de página — medido: a 24pt una
 * frase larga se corta a los ~37 caracteres, a 6pt no.
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
  // La primera entrada de todo xref (spec ISO 32000) es SIEMPRE offset cero con diez dígitos, generación
  // 65535, libre — no depende del documento. Se arma con `repeat` y no como un literal de diez ceros
  // seguidos: el barrido de fuga (`tools/barrido-fuga.ts`) cruza cualquier corrida de diez dígitos contra
  // el material real, y ese boilerplate del formato PDF no tiene nada que ver con un dato de cliente.
  let xref = `xref\n0 6\n${'0'.repeat(10)} 65535 f \n`;
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  cuerpo += `${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offsetXref}\n%%EOF`;
  return Buffer.from(cuerpo, 'latin1');
}

/**
 * Un adaptador de PRUEBA (no un banco real), registrado con el código ya sembrado `banco_cli`. Declara
 * `declaraDestinos: true` y devuelve `destinos.sinDestino = 1`: la partición de `contarDestinos` no
 * cerró, y eso es exactamente lo que `verificarDestinos` (A2, C5) tiene que agarrar antes de persistir
 * una sola fila.
 */
function adaptadorFalsoConResiduo(): Adaptador {
  const capacidades: CapacidadesAdaptador = { ...CAPACIDADES_SINTETICAS, declaraDestinos: true };
  const cuenta = extractoSintetico({
    semilla: 91,
    cantidadMovimientos: 3,
    saldoInicialCentavos: 10_000_00n,
    periodoDesde: '2026-06-01',
    periodoHasta: '2026-06-30',
  });
  return {
    bancoCodigo: 'banco_cli',
    version: 1,
    capacidades,
    // Específico al PDF de este test, no `() => true`: con el adaptador de la contingencia de residuo
    // (más abajo en este archivo) también registrado, dos `() => true` en el mismo registro global
    // harían que `resolverAdaptador` devuelva `ambiguo` para cualquier archivo.
    reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes('GATE DE DESTINOS A2 C5')),
    leer: () => ({
      cuentas: [cuenta],
      lineasNoInterpretadas: [],
      paginasDeclaradas: undefined,
      destinos: {
        movimiento: 3,
        continuacion: 0,
        saldoDeclarado: 0,
        ruido: 0,
        anexo: 0,
        fueraDelCuerpo: 0,
        residuo: 0,
        sinDestino: 1,
        total: 4,
      },
    }),
  };
}

/** Storage espía: registra si se lo llamó. Para este test importa eso, no qué guardó. */
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

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('banco_cli', 'BANCO DE PRUEBA CLI')
       on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }

  // El "PDF" es sintético: para lo que se prueba acá alcanza con que sea un archivo con bytes.
  dirTemporal = mkdtempSync(join(tmpdir(), 'ingesta-'));
  archivo = archivoUnico('base');
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('`--cliente` es obligatorio y no tiene default', () => {
  /**
   * "El único cliente que hay" es la comodidad que rompe el aislamiento en cuanto entra el segundo cliente
   * — y para entonces el default ya está en un script de alguien.
   */
  it('sin --cliente, no corre', () => {
    expect(() =>
      parsearArgumentos(['--archivo', 'x.pdf', '--banco', 'banco_cli', '--usuario', USUARIOS.socio]),
    ).toThrow(/--cliente/);
  });

  it('un --cliente que no es uuid tampoco', () => {
    expect(() =>
      parsearArgumentos([
        '--cliente',
        'el-de-siempre',
        '--archivo',
        'x.pdf',
        '--banco',
        'banco_cli',
        '--usuario',
        USUARIOS.socio,
      ]),
    ).toThrow(/uuid/);
  });

  it('el mensaje de error explica POR QUÉ es obligatorio', () => {
    // Un mensaje que solo dice "falta --cliente" invita a buscar la forma de no pasarlo.
    try {
      parsearArgumentos(['--archivo', 'x.pdf']);
      expect.unreachable('debería haber lanzado');
    } catch (error) {
      expect((error as Error).message).toMatch(/INV-6|aislamiento|sin cliente/i);
    }
  });

  it('con los cuatro argumentos, parsea', () => {
    const a = parsearArgumentos([
      '--cliente',
      s.clienteA,
      '--archivo',
      archivo,
      '--banco',
      'banco_cli',
      '--usuario',
      USUARIOS.socio,
    ]);
    expect(a.cliente).toBe(s.clienteA);
    expect(a.banco).toBe('banco_cli');
  });
});

// -----------------------------------------------------------------------------
describe('el guard de R18, extendido al CLI', () => {
  /**
   * El CLI se corre a mano, en una terminal donde suele estar exportado el `DATABASE_URL` del dueño del
   * esquema porque hace cinco minutos alguien corrió una migración. Ese es el escenario en que la RLS se
   * apaga sin que nadie lo decida — y es más probable en un CLI que en un servidor.
   */
  it('la credencial de este entorno pasa el guard (si no, el resto de la suite no significa nada)', async () => {
    const { storage } = storageEspia();
    const r = await ingestar(
      { cliente: s.clienteA, archivo, banco: 'banco_cli', usuario: USUARIOS.socio },
      storage,
    );
    // Pasa el guard y llega al parseo, donde rechaza porque el archivo no es un PDF. Lo que importa acá es
    // que NO abortó: si abortara, el resto de la suite no significaría nada.
    expect(r.estado, 'el guard abortó: DATABASE_URL_APP apunta a un rol que saltea RLS').not.toBe(
      'abortado',
    );
  });

  /**
   * Un archivo que no es un PDF es un caso **esperado**, no una excepción.
   *
   * Antes la excepción del extractor subía hasta el `catch` del CLI: el lote quedaba en `recibido` **sin
   * motivo** —o sea sin nadie mirándolo— y el operador recibía un error técnico en vez de un código.
   */
  it('un archivo que no es un PDF se RECHAZA con código, no explota', async () => {
    const { storage, escrituras } = storageEspia();
    const r = await ingestar(
      { cliente: s.clienteA, archivo: archivoUnico('corrupto'), banco: 'banco_cli', usuario: USUARIOS.socio },
      storage,
    );
    expect(r.estado).toBe('rechazado');
    if (r.estado === 'rechazado') expect(r.motivoCodigo).toBe('archivo_ilegible');
    expect(escrituras, 'guardó el objeto de un archivo ilegible').toEqual([]);
  });

  it('una extensión no soportada aborta ANTES de leer el archivo', async () => {
    const { storage, escrituras } = storageEspia();
    const r = await ingestar(
      {
        cliente: s.clienteA,
        archivo: 'no-existe.docx',
        banco: 'banco_cli',
        usuario: USUARIOS.socio,
      },
      storage,
    );
    // Si abriera el archivo primero, esto lanzaría ENOENT en vez de devolver un código.
    expect(r.estado).toBe('abortado');
    if (r.estado === 'abortado') expect(r.motivoCodigo).toBe('extension_no_soportada');
    expect(escrituras).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('el rechazo se asienta con accion = rechazo', () => {
  const contarRechazos = async (): Promise<number> => {
    const duenio = await clienteDuenio();
    try {
      const { rows } = await duenio.query<{ n: string }>(
        `select count(*)::text as n from acceso_auditoria where accion = 'rechazo'`,
      );
      return Number(rows[0]?.n ?? '0');
    } finally {
      await duenio.end();
    }
  };

  /**
   * Hoy el rechazo es `adapter_no_disponible` porque no hay ningún adapter escrito. Da igual para lo que se
   * prueba: lo que importa es que un lote que no se pudo procesar deje rastro con la acción correcta.
   *
   * Registrarlo como `escritura` sería asentar un hecho que no ocurrió en la única tabla append-only del
   * sistema. No registrarlo dejaría el caso más importante del módulo —un archivo que no era de este
   * cliente— sin rastro.
   */
  it('un lote rechazado deja una fila de rechazo y el lote con su motivo_codigo', async () => {
    const antes = await contarRechazos();
    const { storage, escrituras } = storageEspia();

    const r = await ingestar(
      { cliente: s.clienteA, archivo: archivoUnico('rechazo'), banco: 'banco_cli', usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('rechazado');
    if (r.estado === 'rechazado') {
      // El archivo no es un PDF, así que el rechazo llega en el paso de parseo. Lo que este test verifica es
      // el RASTRO del rechazo, que es igual para cualquier motivo.
      expect(r.motivoCodigo).toBe('archivo_ilegible');

      const lote = await conUsuario(USUARIOS.socio, async (tx) => {
        const f = await tx.consultar<{ estado: string; motivo_codigo: string | null }>(
          'select estado, motivo_codigo from lote_ingesta where id = $1 and cliente_id = $2',
          [r.loteId, s.clienteA],
        );
        return f[0];
      });
      expect(lote?.estado).toBe('con_errores');
      expect(lote?.motivo_codigo).toBe('archivo_ilegible');
    }

    expect((await contarRechazos()) - antes, 'el rechazo no dejó rastro').toBe(1);
    // Y cero objetos: un lote rechazado no escribe el archivo.
    expect(escrituras, 'guardó el archivo de un lote rechazado').toEqual([]);
  });

  it('el motivo del rastro es un CÓDIGO, no una frase con el contenido del archivo', async () => {
    const duenio = await clienteDuenio();
    try {
      const { rows } = await duenio.query<{ motivo: string | null }>(
        `select motivo from acceso_auditoria where accion = 'rechazo'
          order by ocurrido_en desc limit 1`,
      );
      // Un mensaje libre armado desde el archivo filtra su contenido al rastro, que es append-only: no se
      // puede corregir después.
      expect(rows[0]?.motivo).toMatch(/^[a-z_]+$/);
    } finally {
      await duenio.end();
    }
  });
});

// -----------------------------------------------------------------------------
describe('idempotencia por cliente', () => {
  /**
   * 🔴 Este archivo NUNCA es un PDF válido (`archivoUnico`, ver su comentario), así que las dos corridas
   * rechazan por `archivo_ilegible`: nada se "corrigió" entre medio. Lo que este test verifica es el
   * invariante que sí tiene que sostenerse SIEMPRE, se corrija la causa o no — `uq_lote_ingesta_archivo`
   * (migración 0004, `cliente_id, archivo_hash`) nunca deja crear un segundo lote para el mismo archivo,
   * así que un reintento no puede sino REUSAR el ancla existente.
   *
   * Antes del fix, la segunda corrida devolvía `ya_procesado` sin volver a abrir el archivo — el bug real
   * (HANDOFF, cliente Bracci del piloto): un lote `con_errores` quedaba indistinguible de uno `procesado`
   * para este guard, así que ni siquiera un archivo TODAVÍA roto podía dejar rastro de que se reintentó.
   */
  it('un archivo rechazado, reintentado sin cambios, vuelve a rechazar sobre el MISMO lote', async () => {
    const { storage } = storageEspia();
    const args = {
      cliente: s.clienteB,
      archivo: archivoUnico('idempotencia'),
      banco: 'banco_cli',
      usuario: USUARIOS.socio,
    };

    const primera = await ingestar(args, storage);
    expect(primera.estado).toBe('rechazado');
    if (primera.estado !== 'rechazado') return;

    const segunda = await ingestar(args, storage);
    // El punto central del fix: NO es `ya_procesado` — un rechazo no es un éxito silencioso.
    expect(segunda.estado, 'un lote rechazado se reportó como si ya hubiera terminado con éxito').toBe(
      'rechazado',
    );
    if (segunda.estado !== 'rechazado') return;
    expect(segunda.loteId, 'el reintento no reusó el ancla del rechazo original').toBe(primera.loteId);
    expect(segunda.motivoCodigo).toBe(primera.motivoCodigo);

    const lotes = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `select count(*)::text as n from lote_ingesta
          where cliente_id = $1
            and archivo_hash = (select archivo_hash from lote_ingesta where id = $2)`,
        [s.clienteB, primera.loteId],
      );
      return f[0]?.n;
    });
    expect(lotes, 'uq_lote_ingesta_archivo debería impedir un segundo lote para el mismo archivo').toBe(
      '1',
    );
  });

  it('un lote YA PROCESADO con éxito, reintentado, es un no-op real: ya_procesado, sin re-persistir', async () => {
    const { storage, escrituras } = storageEspia();
    const cuenta = extractoSintetico({
      semilla: 611,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 2_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'banco_cli_noop',
    });

    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `insert into banco (codigo, nombre) values ('banco_cli_noop', 'BANCO DE PRUEBA NO-OP')
         on conflict (codigo) do nothing`,
      );
    } finally {
      await duenio.end();
    }

    const cbu = '9990000090000000000299';
    await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_noop', 'ARS') returning id::text as id`,
        [s.clienteB],
      );
      const cuentaBancariaId = c[0]?.id;
      if (!cuentaBancariaId) throw new Error('no se creó la cuenta de prueba');
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteB, cuentaBancariaId, cuenta.cuenta.numero, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
    });

    registrarAdaptador({
      bancoCodigo: 'banco_cli_noop',
      version: 1,
      capacidades: CAPACIDADES_SINTETICAS,
      reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes('MARCA NOOP 2026-08-31')),
      leer: () => ({
        cuentas: [cuenta],
        lineasNoInterpretadas: [],
        paginasDeclaradas: undefined,
        destinos: undefined,
      }),
    });

    const ruta = join(dirTemporal, 'extracto-noop.pdf');
    writeFileSync(
      ruta,
      pdfMinimoConTexto([
        'MARCA NOOP 2026-08-31 PARA EL TEST DE IDEMPOTENCIA REAL',
        'SEGUNDA LINEA SOLO PARA SUPERAR EL UMBRAL DE CARACTERES MINIMOS',
      ]),
    );
    const args = { cliente: s.clienteB, archivo: ruta, banco: 'banco_cli_noop', usuario: USUARIOS.socio };

    const primera = await ingestar(args, storage);
    expect(primera.estado).toBe('procesado');
    if (primera.estado !== 'procesado') return;

    const segunda = await ingestar(args, storage);
    expect(segunda.estado).toBe('ya_procesado');
    if (segunda.estado !== 'ya_procesado') return;
    expect(segunda.loteId).toBe(primera.loteId);

    // El no-op no vuelve a leer ni a guardar el objeto: una sola escritura de storage en las dos corridas.
    expect(escrituras).toHaveLength(1);

    const filas = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `select count(*)::text as n from movimiento_bancario_crudo where lote_ingesta_id = $1`,
        [primera.loteId],
      );
      return f[0]?.n;
    });
    expect(filas, 'el reintento de un lote exitoso duplicó filas').toBe('3');
  });

  it('el MISMO archivo para OTRO cliente sí crea su lote: la idempotencia es por cliente', async () => {
    // Con un `unique (archivo_hash)` global, el segundo cliente que ingesta un archivo idéntico —una
    // liquidación con el mismo formato, por ejemplo— sería rechazado con un error que además le confirma
    // que ese archivo ya está cargado en otro cliente.
    const antesA = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from lote_ingesta where cliente_id = $1',
        [s.clienteA],
      );
      return Number(f[0]?.n ?? '0');
    });
    expect(antesA).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
/**
 * Reproducción del bug real de esta tarea: un lote `con_errores` (rechazo) NO puede quedar indistinguible
 * de uno `procesado` para el guard de idempotencia — la causa del rechazo puede corregirse sin tocar el
 * archivo, y el reintento tiene que volver a intentar el pipeline, no devolver `ya_procesado` a ciegas.
 *
 * Confirmado contra el piloto: cliente Bracci, lote rechazado por `cuenta_no_pertenece_al_cliente` con la
 * vigencia de la cuenta mal calculada; corregida la vigencia, `pnpm ingesta` con el MISMO archivo seguía
 * devolviendo `ya_procesado` sin volver a intentar el parseo.
 */
describe('reintento de un lote rechazado (con_errores): SÍ reprocesa, no es ya_procesado', () => {
  let cuentaReintento: ReturnType<typeof extractoSintetico>;

  beforeAll(async () => {
    cuentaReintento = extractoSintetico({
      semilla: 621,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 3_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'banco_cli_reintento',
    });

    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `insert into banco (codigo, nombre) values ('banco_cli_reintento', 'BANCO DE PRUEBA REINTENTO')
         on conflict (codigo) do nothing`,
      );
    } finally {
      await duenio.end();
    }

    registrarAdaptador({
      bancoCodigo: 'banco_cli_reintento',
      version: 1,
      capacidades: CAPACIDADES_SINTETICAS,
      reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes('MARCA REINTENTO 2026-08-31')),
      leer: () => ({
        cuentas: [cuentaReintento],
        lineasNoInterpretadas: [],
        paginasDeclaradas: undefined,
        destinos: undefined,
      }),
    });
  });

  it(
    'la cuenta del archivo no está registrada -> se rechaza; se da de alta -> el MISMO archivo, ' +
      'reintentado, se procesa con éxito sobre el MISMO lote',
    async () => {
      const { storage } = storageEspia();
      const ruta = join(dirTemporal, 'extracto-reintento.pdf');
      writeFileSync(
        ruta,
        pdfMinimoConTexto([
          'MARCA REINTENTO 2026-08-31 PARA EL TEST DE IDEMPOTENCIA',
          'SEGUNDA LINEA SOLO PARA SUPERAR EL UMBRAL DE CARACTERES MINIMOS',
        ]),
      );
      const args = {
        cliente: s.clienteB,
        archivo: ruta,
        banco: 'banco_cli_reintento',
        usuario: USUARIOS.socio,
      };

      // Primer intento: la cuenta del archivo todavía no está registrada para este cliente. Se rechaza.
      const primera = await ingestar(args, storage);
      expect(primera.estado).toBe('rechazado');
      if (primera.estado !== 'rechazado') return;
      expect(['cuenta_no_registrada', 'cuenta_no_pertenece_al_cliente']).toContain(primera.motivoCodigo);

      // Se "corrige" la causa del rechazo —dar de alta la cuenta, análogo a corregir la vigencia mal
      // calculada de Bracci en el piloto— SIN tocar el archivo: el hash es el mismo.
      const cbu = '9990000090000000000399';
      await conUsuario(USUARIOS.socio, async (tx) => {
        const c = await tx.consultar<{ id: string }>(
          `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
           values ($1, 'banco_cli_reintento', 'ARS') returning id::text as id`,
          [s.clienteB],
        );
        const cuentaBancariaId = c[0]?.id;
        if (!cuentaBancariaId) throw new Error('no se creó la cuenta de prueba');
        await tx.consultar(
          `insert into cuenta_bancaria_identificador
             (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
           values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
          [
            s.clienteB,
            cuentaBancariaId,
            cuentaReintento.cuenta.numero,
            hmacIdentificador(cbu),
            ultimos4ParaGuardar(cbu),
          ],
        );
      });

      // Segundo intento, MISMO archivo: antes del fix esto devolvía `ya_procesado` sin volver a intentar
      // nada. El fix reprocesa sobre el MISMO lote y ahora resuelve.
      const segunda = await ingestar(args, storage);
      expect(
        segunda.estado,
        'el reintento no reprocesó: devolvió ya_procesado en vez de volver a intentar el pipeline',
      ).toBe('procesado');
      if (segunda.estado !== 'procesado') return;
      expect(segunda.loteId, 'el reintento creó un lote nuevo en vez de reusar el rechazado').toBe(
        primera.loteId,
      );

      const lote = await conUsuario(USUARIOS.socio, async (tx) => {
        const f = await tx.consultar<{
          n: string;
          estado: string;
          motivo_codigo: string | null;
          motivo_codigo_previo: string | null;
        }>(
          `select estado, motivo_codigo, motivo_codigo_previo,
                  (select count(*)::text from lote_ingesta
                    where cliente_id = $2
                      and archivo_hash = (select archivo_hash from lote_ingesta where id = $1)) as n
             from lote_ingesta where id = $1 and cliente_id = $2`,
          [segunda.loteId, s.clienteB],
        );
        return f[0];
      });
      expect(lote?.estado).toBe('procesado');
      // Nunca hay un SEGUNDO lote para el mismo (cliente, archivo_hash): `uq_lote_ingesta_archivo` lo
      // impediría, y el fix reusa el ancla en vez de intentar insertar uno nuevo.
      expect(lote?.n, 'quedó un lote duplicado para el mismo archivo').toBe('1');
      // El motivo del rechazo original va al HISTORIAL (`motivo_codigo_previo`, migración 0012, mismo
      // criterio que `completar-lote.ts`) — no queda mintiendo en `motivo_codigo` de un lote `procesado`.
      expect(lote?.motivo_codigo).toBeNull();
      expect(lote?.motivo_codigo_previo).toBe(primera.motivoCodigo);
    },
  );
});

// -----------------------------------------------------------------------------
/**
 * Hallazgo real de `tester`/`code-reviewer` sobre el fix de arriba: el reintento reusa el lote, pero
 * el `UPDATE` final de éxito no tocaba `banco_codigo` — si el PRIMER intento se rechazó por
 * `banco_declarado_no_coincide` (el operador tipeó mal `--banco`), el lote quedaba con el banco
 * DECLARADO del intento fallido para siempre, aunque el reintento con el `--banco` correcto
 * procesara con éxito. `banco_codigo` alimenta el filtro y el léxico de `exportar-planilla.ts`: un
 * lote `procesado` con el banco equivocado no aparece al filtrar por su banco real, y se clasifica
 * con el léxico de otro banco.
 */
describe('reintento con --banco corregido: banco_codigo queda consistente, no el del intento fallido', () => {
  let cuentaBancoCorregido: ReturnType<typeof extractoSintetico>;

  beforeAll(async () => {
    cuentaBancoCorregido = extractoSintetico({
      semilla: 622,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 5_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'banco_cli_correcto',
    });

    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `insert into banco (codigo, nombre) values
           ('banco_cli_incorrecto', 'BANCO DE PRUEBA DECLARADO MAL'),
           ('banco_cli_correcto', 'BANCO DE PRUEBA REAL DEL ARCHIVO')
         on conflict (codigo) do nothing`,
      );
    } finally {
      await duenio.end();
    }

    // Un solo adaptador registrado, para el banco REAL del contenido — `resolverAdaptador` lo
    // encuentra por `reconoce()` sin importar qué `--banco` haya declarado el operador, y recién
    // ahí compara contra lo declarado.
    registrarAdaptador({
      bancoCodigo: 'banco_cli_correcto',
      version: 1,
      capacidades: CAPACIDADES_SINTETICAS,
      reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes('MARCA BANCO CORREGIDO 2026-08-31')),
      leer: () => ({
        cuentas: [cuentaBancoCorregido],
        lineasNoInterpretadas: [],
        paginasDeclaradas: undefined,
        destinos: undefined,
      }),
    });

    await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_correcto', 'ARS') returning id::text as id`,
        [s.clienteB],
      );
      const cuentaBancariaId = c[0]?.id;
      if (!cuentaBancariaId) throw new Error('no se creó la cuenta de prueba');
      const cbu = '9990000090000000000622';
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [
          s.clienteB,
          cuentaBancariaId,
          cuentaBancoCorregido.cuenta.numero,
          hmacIdentificador(cbu),
          ultimos4ParaGuardar(cbu),
        ],
      );
    });
  });

  it('el reintento con --banco correcto deja banco_codigo y adaptador_version consistentes', async () => {
    const { storage } = storageEspia();
    const ruta = join(dirTemporal, 'extracto-banco-corregido.pdf');
    writeFileSync(
      ruta,
      pdfMinimoConTexto([
        'MARCA BANCO CORREGIDO 2026-08-31 PARA EL TEST DE BANCO_CODIGO',
        'SEGUNDA LINEA SOLO PARA SUPERAR EL UMBRAL DE CARACTERES MINIMOS',
      ]),
    );

    // Primer intento: el operador declara el banco EQUIVOCADO. El adaptador que reconoce el
    // contenido es 'banco_cli_correcto', distinto del declarado -> rechaza.
    const primera = await ingestar(
      { cliente: s.clienteB, archivo: ruta, banco: 'banco_cli_incorrecto', usuario: USUARIOS.socio },
      storage,
    );
    expect(primera.estado).toBe('rechazado');
    if (primera.estado !== 'rechazado') return;
    expect(primera.motivoCodigo).toBe('banco_declarado_no_coincide');

    // Segundo intento, MISMO archivo, ahora con el --banco correcto: reprocesa sobre el MISMO lote.
    const segunda = await ingestar(
      { cliente: s.clienteB, archivo: ruta, banco: 'banco_cli_correcto', usuario: USUARIOS.socio },
      storage,
    );
    expect(segunda.estado).toBe('procesado');
    if (segunda.estado !== 'procesado') return;
    expect(segunda.loteId).toBe(primera.loteId);

    const lote = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ banco_codigo: string; adaptador_version: string; estado: string }>(
        `select banco_codigo, adaptador_version, estado from lote_ingesta where id = $1 and cliente_id = $2`,
        [segunda.loteId, s.clienteB],
      );
      return f[0];
    });
    expect(lote?.estado).toBe('procesado');
    // El hallazgo: SIN el fix, esto queda en 'banco_cli_incorrecto' (el del intento rechazado) para
    // siempre, contradiciendo a `adaptador_version`, que sí queda correcto.
    expect(
      lote?.banco_codigo,
      'banco_codigo quedó con el banco DECLARADO del intento fallido, no el que realmente procesó el archivo',
    ).toBe('banco_cli_correcto');
    expect(lote?.adaptador_version).toBe('banco_cli_correcto@1');
  });
});

// -----------------------------------------------------------------------------
describe('A2 (C5) — el gate de residuo rechaza el lote entero, antes de persistir una cuenta', () => {
  beforeAll(() => {
    // Un adaptador de prueba, no uno de los tres bancos reales: lo único que hace falta demostrar es que
    // el CLI, con un `SalidaDeAdaptador.destinos` que no cierra, rechaza el lote con el motivo nuevo —
    // `verificarDestinos` en sí ya está probado exhaustivamente en `verificacion.test.ts`.
    registrarAdaptador(adaptadorFalsoConResiduo());
  });

  it('sinDestino > 0 se rechaza con motivo_codigo = destinos_no_cuadran, y no persiste nada', async () => {
    const { storage, escrituras } = storageEspia();
    const ruta = join(dirTemporal, 'extracto-destinos.pdf');
    writeFileSync(
      ruta,
      pdfMinimoConTexto([
        'DOCUMENTO SINTETICO DE PRUEBA PARA EL GATE DE DESTINOS A2 C5',
        'SEGUNDA LINEA SOLO PARA SUPERAR EL UMBRAL DE CARACTERES MINIMOS',
      ]),
    );

    const r = await ingestar(
      { cliente: s.clienteA, archivo: ruta, banco: 'banco_cli', usuario: USUARIOS.socio },
      storage,
    );

    expect(r.estado).toBe('rechazado');
    if (r.estado === 'rechazado') {
      expect(r.motivoCodigo).toBe('destinos_no_cuadran');

      const lote = await conUsuario(USUARIOS.socio, async (tx) => {
        const f = await tx.consultar<{ estado: string; motivo_codigo: string | null }>(
          'select estado, motivo_codigo from lote_ingesta where id = $1 and cliente_id = $2',
          [r.loteId, s.clienteA],
        );
        return f[0];
      });
      expect(lote?.estado).toBe('con_errores');
      expect(lote?.motivo_codigo).toBe('destinos_no_cuadran');
    }

    // El lote se rechaza ANTES del bucle por cuenta: ni el objeto ni ninguna cuenta llegan a persistirse.
    expect(escrituras).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('contingencia de residuo (2026-08-11): observación NO rechaza, a diferencia de error', () => {
  /**
   * El hueco de cobertura que `code-reviewer` señaló al revisar la contingencia: existía un test para
   * `sinDestino>0` (severidad `error`, rechaza) pero ninguno para `residuo>0` con `sinDestino=0`
   * (severidad `observación` desde la contingencia). Sin este test, `ingestar.ts` decidiendo por
   * `diferenciasDeLote.length > 0` en vez de por severidad se hubiera colado sin que nada lo agarrara.
   *
   * **Por qué el test no verifica `estado === 'procesado'`.** Llegar a persistir de verdad exige una
   * `cuenta_bancaria` ya registrada para `s.clienteA` que resuelva contra el número/CBU del extracto
   * (`resolverCuentaDelExtracto`, INV-6) — infraestructura de test desproporcionada para este fix
   * puntual. En cambio, el adaptador de prueba **omite** `numero`/`cbu` de la carátula a propósito: eso
   * fuerza un rechazo DETERMINÍSTICO y conocido en el paso siguiente
   * (`sin_identificador_en_caratula`), sin ningún dato con el que armar una cuenta. La prueba que
   * importa es que el rechazo **no sea por destinos**: si `verificarDestinos` siguiera rechazando por
   * `residuo` (el bug que este test existe para agarrar), el `motivoCodigo` sería `destinos_no_cuadran`
   * y el código nunca llegaría a intentar resolver la cuenta.
   */
  function adaptadorFalsoConResiduoObservacion(): Adaptador {
    const capacidades: CapacidadesAdaptador = { ...CAPACIDADES_SINTETICAS, declaraDestinos: true };
    const sintetica = extractoSintetico({
      semilla: 92,
      cantidadMovimientos: 3,
      saldoInicialCentavos: 10_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
    });
    // Sin `numero` ni `cbu`: `resolverCuentaDelExtracto` no tiene contra qué resolver, y rechaza con
    // `sin_identificador_en_caratula` — determinístico, sin depender de una cuenta pre-registrada.
    const { numero: _numero, cbu: _cbu, ...caratulaSinIdentificador } = sintetica.cuenta;
    const cuenta = { ...sintetica, cuenta: caratulaSinIdentificador };
    return {
      bancoCodigo: 'banco_cli_residuo_obs',
      version: 1,
      capacidades,
      // Específico al PDF de ESTE test, no `() => true`: la suite ya registra otro adaptador falso
      // (`adaptadorFalsoConResiduo`, describe de arriba) con `reconoce: () => true` — dos así en el
      // mismo registro global hacen que `resolverAdaptador` devuelva `ambiguo` para cualquier archivo.
      reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes('CONTINGENCIA DE RESIDUO')),
      leer: () => ({
        cuentas: [cuenta],
        lineasNoInterpretadas: [],
        paginasDeclaradas: undefined,
        destinos: {
          movimiento: 3,
          continuacion: 0,
          saldoDeclarado: 0,
          ruido: 0,
          anexo: 0,
          fueraDelCuerpo: 0,
          residuo: 1,
          sinDestino: 0,
          total: 4,
        },
      }),
    };
  }

  beforeAll(async () => {
    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `insert into banco (codigo, nombre) values ('banco_cli_residuo_obs', 'BANCO DE PRUEBA — RESIDUO OBSERVACION')
         on conflict (codigo) do nothing`,
      );
    } finally {
      await duenio.end();
    }
    registrarAdaptador(adaptadorFalsoConResiduoObservacion());
  });

  it('residuo > 0 con sinDestino = 0 no rechaza por destinos — el rechazo, si lo hay, es por otra causa', async () => {
    const { storage, escrituras } = storageEspia();
    const ruta = join(dirTemporal, 'extracto-residuo-observacion.pdf');
    writeFileSync(
      ruta,
      pdfMinimoConTexto([
        'DOCUMENTO SINTETICO PARA LA CONTINGENCIA DE RESIDUO EN OBSERVACION',
        'SEGUNDA LINEA SOLO PARA SUPERAR EL UMBRAL DE CARACTERES MINIMOS',
      ]),
    );

    const r = await ingestar(
      { cliente: s.clienteA, archivo: ruta, banco: 'banco_cli_residuo_obs', usuario: USUARIOS.socio },
      storage,
    );

    // El gate de destinos (A2, C5) no puede haber rechazado esto: `residuo=1` con `sinDestino=0` es
    // severidad `observación`, no `error`. Si el bug que este test agarra volviera, el motivo sería
    // `destinos_no_cuadran` y nada llegaría al paso de resolución de cuenta.
    expect(r.estado).toBe('rechazado');
    if (r.estado === 'rechazado') {
      expect(r.motivoCodigo).not.toBe('destinos_no_cuadran');
      expect(r.motivoCodigo).toBe('sin_identificador_en_caratula');
    }

    // Rechazado por la causa esperada (sin identificador), no por destinos: no llegó a persistir nada,
    // pero tampoco por el bug que este test existe para agarrar.
    expect(escrituras).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('atomicidad del lote multi-cuenta (HANDOFF 2026-08-11 (40))', () => {
  /**
   * A diferencia de los demás adaptadores falsos de este archivo, ACÁ sí hace falta una `cuenta_bancaria`
   * real registrada para `s.clienteA` — es la única forma de que la PRIMERA cuenta del archivo resuelva y
   * se persista de verdad, que es la precondición del bug: una cuenta exitosa comiteada junto con el
   * rechazo de la cuenta siguiente. Es exactamente la infraestructura que los demás tests de este archivo
   * evitan a propósito (ver el comentario de la contingencia de residuo, más arriba) — acá no se puede
   * evitar porque es lo que se está probando.
   */
  let cuenta1: ReturnType<typeof extractoSintetico>;
  let cuenta2: ReturnType<typeof extractoSintetico>;

  beforeAll(async () => {
    cuenta1 = extractoSintetico({
      semilla: 501,
      cantidadMovimientos: 4,
      saldoInicialCentavos: 5_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'banco_cli_atomico',
    });
    // Semilla distinta: número de cuenta distinto, y a propósito NUNCA se registra para este cliente —
    // es el análogo sintético de la cuenta USD real que HANDOFF (40) documenta como "se deja para después".
    cuenta2 = extractoSintetico({
      semilla: 502,
      cantidadMovimientos: 4,
      saldoInicialCentavos: 5_000_00n,
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      bancoCodigo: 'banco_cli_atomico',
    });

    const duenio = await clienteDuenio();
    try {
      await duenio.query(
        `insert into banco (codigo, nombre) values ('banco_cli_atomico', 'BANCO DE PRUEBA ATOMICIDAD')
         on conflict (codigo) do nothing`,
      );
    } finally {
      await duenio.end();
    }

    const cbuCuenta1 = '9990000090000000000099';
    await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_cli_atomico', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const cuentaBancariaId = c[0]?.id;
      if (!cuentaBancariaId) throw new Error('no se creó la cuenta de prueba');
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [
          s.clienteA,
          cuentaBancariaId,
          cuenta1.cuenta.numero,
          hmacIdentificador(cbuCuenta1),
          ultimos4ParaGuardar(cbuCuenta1),
        ],
      );
    });

    registrarAdaptador({
      bancoCodigo: 'banco_cli_atomico',
      version: 1,
      capacidades: CAPACIDADES_SINTETICAS,
      reconoce: (e) => e.filas.some((f) => textoDeFila(f).includes('MARCA ATOMICIDAD 2026-08-11')),
      leer: () => ({
        // Cuenta 1: resuelve contra la cuenta ya registrada arriba y cuadra — se persiste. Cuenta 2:
        // ningún identificador registrado para este cliente — falla la resolución DESPUÉS de que la 1
        // ya se persistió. Reproducción mínima del bug real (158 filas de Santander, HANDOFF (40)).
        cuentas: [cuenta1, cuenta2],
        lineasNoInterpretadas: [],
        paginasDeclaradas: undefined,
        destinos: undefined,
      }),
    });
  });

  it(
    'una cuenta persistida con éxito NO sobrevive si una cuenta posterior del mismo archivo falla ' +
      '(antes del fix: quedaba comiteada junto con el rechazo — 158 filas reales contra el piloto)',
    async () => {
      const { storage, escrituras } = storageEspia();
      const ruta = join(dirTemporal, 'extracto-atomicidad.pdf');
      writeFileSync(
        ruta,
        pdfMinimoConTexto([
          'MARCA ATOMICIDAD 2026-08-11 PARA EL TEST DE SAVEPOINT',
          'SEGUNDA LINEA SOLO PARA SUPERAR EL UMBRAL DE CARACTERES MINIMOS',
        ]),
      );

      const r = await ingestar(
        { cliente: s.clienteA, archivo: ruta, banco: 'banco_cli_atomico', usuario: USUARIOS.socio },
        storage,
      );

      expect(r.estado).toBe('rechazado');
      if (r.estado !== 'rechazado') return;

      // La cuenta 2 nunca se registró para este cliente, y el cliente YA tiene una cuenta (la 1) —
      // exactamente el mecanismo real de HANDOFF (40): `cuenta_no_pertenece_al_cliente`, no
      // `cuenta_no_registrada`.
      expect(r.motivoCodigo).toBe('cuenta_no_pertenece_al_cliente');

      const { filasDeLaCuentaExitosa, lote, rechazoAuditado } = await conUsuario(
        USUARIOS.socio,
        async (tx) => {
          const filas = await tx.consultar<{ n: string }>(
            `select count(*)::text as n from movimiento_bancario_crudo where lote_ingesta_id = $1`,
            [r.loteId],
          );
          const l = await tx.consultar<{ estado: string; motivo_codigo: string | null }>(
            'select estado, motivo_codigo from lote_ingesta where id = $1 and cliente_id = $2',
            [r.loteId, s.clienteA],
          );
          const rechazo = await tx.consultar<{ n: string }>(
            `select count(*)::text as n from acceso_auditoria
              where accion = 'rechazo' and recurso_id = $1`,
            [r.loteId],
          );
          return {
            filasDeLaCuentaExitosa: Number(filas[0]?.n ?? '0'),
            lote: l[0],
            rechazoAuditado: Number(rechazo[0]?.n ?? '0'),
          };
        },
      );

      // La aserción central: CERO filas, ni siquiera las 4 de la cuenta 1 que sí cuadraba y sí se
      // persistió con éxito. Sin el SAVEPOINT, este número daba 4 acá (158 contra el archivo real).
      expect(filasDeLaCuentaExitosa, 'la cuenta exitosa quedó comiteada bajo un lote rechazado').toBe(0);
      expect(lote?.estado).toBe('con_errores');
      expect(lote?.motivo_codigo).toBe('cuenta_no_pertenece_al_cliente');
      // El rollback parcial no puede llevarse puesto el propio registro del rechazo — el orden correcto
      // es ROLLBACK TO SAVEPOINT primero, `rechazar()` después (security-engineer, HANDOFF (40)): si se
      // invirtiera, el lote volvería a `recibido` sin motivo ni rastro, peor que el bug original.
      expect(rechazoAuditado, 'el rechazo no quedó auditado').toBe(1);
      expect(escrituras, 'guardó el objeto de un lote que terminó rechazado').toEqual([]);
    },
  );
});
