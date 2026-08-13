/**
 * `obtenerObjetoDeCliente` — el choke point de lectura, hermano de `emitirUrlDeDescarga`. Contra Postgres
 * y MinIO reales. Plan `adaptive-herding-pillow`.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones } from '@sistema-contable/data';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';
import { construirClave } from '../src/clave.ts';
import { configDelEntorno, crearObjectStorage, type ObjectStorage } from '../src/object-storage.ts';
import { obtenerObjetoDeCliente } from '../src/lectura.ts';

let s: Sembrado;
let storage: ObjectStorage;
let clave: string;

const LOTE = 'eeeeeeee-5555-5555-5555-555555555555';
const CONTENIDO = Buffer.from('%PDF-1.4 extracto SINTETICO de prueba, lectura.test.ts');
const HASH = createHash('sha256').update(CONTENIDO).digest('hex');

beforeAll(async () => {
  s = await sembrar();
  storage = crearObjectStorage(configDelEntorno());
  clave = construirClave({ clienteId: s.clienteA, categoria: 'extracto', recursoId: LOTE, extension: 'pdf' });
  await storage.guardar(clave, CONTENIDO, 'application/pdf');
});

afterAll(async () => {
  await cerrarConexiones();
});

function espiarObtener(base: ObjectStorage): { storage: ObjectStorage; llamado: boolean } {
  const estado = { llamado: false };
  return {
    storage: {
      ...base,
      async obtener(k: string) {
        estado.llamado = true;
        return base.obtener(k);
      },
    },
    get llamado() {
      return estado.llamado;
    },
  } as { storage: ObjectStorage; llamado: boolean };
}

async function contar(accion: string): Promise<number> {
  const duenio = await clienteDuenio();
  try {
    const { rows } = await duenio.query<{ n: string }>(
      `select count(*)::text as n from acceso_auditoria where accion = $1`,
      [accion],
    );
    return Number(rows[0]?.n ?? '0');
  } finally {
    await duenio.end();
  }
}

describe('camino feliz', () => {
  it('trae el contenido, audita accion=descarga con su motivo', async () => {
    const antesDescarga = await contar('descarga');
    const r = await obtenerObjetoDeCliente(USUARIOS.socio, storage, {
      clienteId: s.clienteA,
      clave,
      hashEsperado: HASH,
      motivo: 'recapturar_conceptos: verificación de lectura',
      recursoId: LOTE,
      rolesPermitidos: ['socio'],
    });

    expect(r.obtenido).toBe(true);
    if (r.obtenido) expect(r.contenido.equals(CONTENIDO)).toBe(true);
    expect((await contar('descarga')) - antesDescarga).toBe(1);
  });
});

describe('rol', () => {
  it('rol insuficiente: storage.obtener() nunca se llama', async () => {
    const espia = espiarObtener(storage);
    const r = await obtenerObjetoDeCliente(USUARIOS.administrativoA, espia.storage, {
      clienteId: s.clienteA,
      clave,
      hashEsperado: HASH,
      motivo: 'intento sin rol',
      rolesPermitidos: ['socio'],
    });

    expect(r).toEqual({ obtenido: false, motivoCodigo: 'rol_insuficiente' });
    expect(espia.llamado).toBe(false);
  });

  it('contador NO alcanza si rolesPermitidos es solo socio (más estricto que ROLES_QUE_DESCARGAN)', async () => {
    const r = await obtenerObjetoDeCliente(USUARIOS.contadorA, storage, {
      clienteId: s.clienteA,
      clave,
      hashEsperado: HASH,
      motivo: 'intento con contador',
      rolesPermitidos: ['socio'],
    });
    expect(r).toEqual({ obtenido: false, motivoCodigo: 'rol_insuficiente' });
  });
});

describe('chequeos previos', () => {
  it('clave de otro cliente: rechazada, storage.obtener() nunca se llama', async () => {
    const claveDeB = construirClave({ clienteId: s.clienteB, categoria: 'extracto', recursoId: LOTE, extension: 'pdf' });
    const espia = espiarObtener(storage);
    const r = await obtenerObjetoDeCliente(USUARIOS.socio, espia.storage, {
      clienteId: s.clienteA,
      clave: claveDeB,
      hashEsperado: HASH,
      motivo: 'intento con clave ajena',
      rolesPermitidos: ['socio'],
    });
    expect(r).toEqual({ obtenido: false, motivoCodigo: 'clave_de_otro_cliente' });
    expect(espia.llamado).toBe(false);
  });

  it('sin motivo escrito: rechazado antes de tocar la base', async () => {
    for (const motivo of ['', '  ', 'ok']) {
      const r = await obtenerObjetoDeCliente(USUARIOS.socio, storage, {
        clienteId: s.clienteA,
        clave,
        hashEsperado: HASH,
        motivo,
        rolesPermitidos: ['socio'],
      });
      expect(r).toEqual({ obtenido: false, motivoCodigo: 'motivo_faltante' });
    }
  });
});

describe('integridad', () => {
  it('hash que no coincide: integridad_no_coincide, auditado como rechazo, contenido NUNCA devuelto', async () => {
    const antesRechazo = await contar('rechazo');
    const r = await obtenerObjetoDeCliente(USUARIOS.socio, storage, {
      clienteId: s.clienteA,
      clave,
      hashEsperado: 'hash-que-no-va-a-coincidir-nunca',
      motivo: 'verificación de integridad',
      recursoId: LOTE,
      rolesPermitidos: ['socio'],
    });

    expect(r).toEqual({ obtenido: false, motivoCodigo: 'integridad_no_coincide' });
    expect((await contar('rechazo')) - antesRechazo).toBe(1);
  });
});
