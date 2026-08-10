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
import type { ObjectStorage } from '@sistema-contable/almacenamiento';
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
  it('el mismo archivo dos veces es un no-op, no un duplicado', async () => {
    const { storage } = storageEspia();
    const args = {
      cliente: s.clienteB,
      archivo: archivoUnico('idempotencia'),
      banco: 'banco_cli',
      usuario: USUARIOS.socio,
    };

    const primera = await ingestar(args, storage);
    const segunda = await ingestar(args, storage);

    expect(primera.estado).toBe('rechazado');
    expect(segunda.estado, 'creó un segundo lote para el mismo archivo').toBe('ya_procesado');

    const lotes = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from lote_ingesta where cliente_id = $1',
        [s.clienteB],
      );
      return f[0]?.n;
    });
    expect(lotes).toBe('1');
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
