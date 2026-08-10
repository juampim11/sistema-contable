/**
 * EL ORDEN Y LA CLAVE — el corazón de la condición de salida nº 9.
 *
 * Son tests puros: no hace falta MinIO ni Postgres, porque lo que se verifica es **control de flujo** y
 * **construcción de un string**. Que no necesiten infraestructura es parte del punto: son los dos
 * invariantes que tienen que poder correr en cualquier máquina, siempre.
 */

import { describe, expect, it } from 'vitest';
import {
  claveEsDelCliente,
  clienteDeClave,
  construirClave,
} from '../src/clave.ts';
import {
  guardarExtractoTrasResolver,
  type PedidoDeGuardado,
  type ResolucionCuenta,
} from '../src/extracto.ts';
import type { ObjectStorage } from '../src/object-storage.ts';

const CLIENTE_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const CLIENTE_B = 'bbbbbbbb-2222-2222-2222-222222222222';
const LOTE = 'cccccccc-3333-3333-3333-333333333333';

/**
 * Storage espía: registra el orden de las llamadas. Es el instrumento con el que se mide el invariante,
 * así que no hace nada más — un doble que además escribiera a disco mezclaría dos cosas.
 */
function storageEspia(): { storage: ObjectStorage; llamadas: string[] } {
  const llamadas: string[] = [];
  const storage: ObjectStorage = {
    async guardar(clave) {
      llamadas.push(`guardar:${clave}`);
    },
    async obtener() {
      llamadas.push('obtener');
      return Buffer.alloc(0);
    },
    async urlFirmada() {
      llamadas.push('urlFirmada');
      return 'https://ejemplo.invalid/firmada';
    },
    async eliminar() {
      llamadas.push('eliminar');
    },
  };
  return { storage, llamadas };
}

const pedidoBase: PedidoDeGuardado = {
  clienteId: CLIENTE_A,
  loteId: LOTE,
  categoria: 'extracto',
  extension: 'pdf',
  contentType: 'application/pdf',
  contenido: Buffer.from('%PDF-1.4 contenido sintetico'),
};

// -----------------------------------------------------------------------------
describe('el orden: resolver la cuenta ANTES de guardar el objeto', () => {
  /**
   * El bug que esto previene: guardar primero "para no perder el archivo" escribe el PDF bajo el prefijo
   * del cliente **declarado**. Cuando la resolución después dice que la cuenta es de otro, el objeto ya
   * está en la carpeta equivocada — y a partir de ahí el socio del cliente equivocado se lo baja
   * legítimamente, con auditoría normal y sin que nada falle.
   */
  it('el resolvedor se ejecuta primero, y el guardado después', async () => {
    const { storage, llamadas } = storageEspia();

    const r = await guardarExtractoTrasResolver(storage, pedidoBase, async () => {
      llamadas.push('resolver');
      return { estado: 'resuelta', clienteId: CLIENTE_A, cuentaBancariaId: LOTE };
    });

    expect(r.guardado).toBe(true);
    expect(llamadas[0], 'guardó antes de resolver').toBe('resolver');
    expect(llamadas[1]).toMatch(/^guardar:/);
  });

  /**
   * Es el test que falla si alguien invierte el orden: con la resolución fallida, `guardar()` **no puede
   * haberse invocado ni una vez**. Un `guardar` antes del `resolver` haría que esta aserción encuentre la
   * llamada, sin importar qué devuelva la resolución.
   */
  it.each([
    ['la cuenta no pertenece al cliente declarado', 'cuenta_no_pertenece_al_cliente'],
    ['la cuenta no está registrada', 'cuenta_no_registrada'],
    ['hay más de una cuenta candidata', 'cuenta_ambigua'],
    ['el PDF no tiene texto extraíble', 'requiere_ocr'],
  ] as const)('con %s: cero objetos escritos', async (_caso, estado) => {
    const { storage, llamadas } = storageEspia();

    const r = await guardarExtractoTrasResolver(
      storage,
      pedidoBase,
      async () => ({ estado }) as ResolucionCuenta,
    );

    expect(r.guardado).toBe(false);
    expect(llamadas.filter((l) => l.startsWith('guardar')), 'escribió el objeto igual').toEqual([]);
    if (!r.guardado) expect(r.motivoCodigo).toBe(estado);
  });

  /**
   * INV-6 con el orden ya correcto.
   *
   * Resolver primero y después armar la clave con el cliente **declarado** tiene exactamente el mismo
   * efecto que guardar antes de resolver: el objeto termina en el prefijo equivocado. La clave se arma con
   * el cliente que devolvió la resolución, y si no coincide se rechaza.
   */
  it('si la resolución devuelve OTRO cliente, no se escribe nada', async () => {
    const { storage, llamadas } = storageEspia();

    const r = await guardarExtractoTrasResolver(storage, pedidoBase, async () => ({
      estado: 'resuelta',
      clienteId: CLIENTE_B, // ← la cuenta es del cliente B; el comando declaró A
      cuentaBancariaId: LOTE,
    }));

    expect(r.guardado).toBe(false);
    expect(llamadas.filter((l) => l.startsWith('guardar'))).toEqual([]);
    if (!r.guardado) expect(r.motivoCodigo).toBe('cuenta_no_pertenece_al_cliente');
  });

  it('el rechazo NO revela a qué cliente pertenece la cuenta', async () => {
    const r = await guardarExtractoTrasResolver(storageEspia().storage, pedidoBase, async () => ({
      estado: 'resuelta',
      clienteId: CLIENTE_B,
      cuentaBancariaId: LOTE,
    }));

    // Decirlo filtra la cartera de un competidor y confirma la existencia de un cliente sobre el que no
    // hay membresía. Y el operador no lo necesita: tiene el archivo y sabe quién se lo mandó.
    const serializado = JSON.stringify(r);
    expect(serializado, 'el rechazo nombra al otro cliente').not.toContain(CLIENTE_B);
  });

  it('cuando SÍ guarda, la clave se arma con el cliente que RESOLVIÓ, no con el declarado', async () => {
    const { storage, llamadas } = storageEspia();
    await guardarExtractoTrasResolver(storage, pedidoBase, async () => ({
      estado: 'resuelta',
      clienteId: CLIENTE_A,
      cuentaBancariaId: LOTE,
    }));
    // Este resolvedor no anota nada en `llamadas`, así que el guardado es la única entrada.
    expect(llamadas).toEqual([`guardar:cliente/${CLIENTE_A}/extracto/${LOTE}.pdf`]);
  });
});

// -----------------------------------------------------------------------------
describe('la clave del objeto', () => {
  const clave = construirClave({
    clienteId: CLIENTE_A,
    categoria: 'extracto',
    recursoId: LOTE,
    extension: 'pdf',
  });

  it('el cliente_id va PRIMERO: habilita una política de bucket por prefijo sin migrar objetos', () => {
    expect(clave.startsWith(`cliente/${CLIENTE_A}/`)).toBe(true);
    expect(clave).toBe(`cliente/${CLIENTE_A}/extracto/${LOTE}.pdf`);
  });

  /**
   * Una clave derivada del contenido vuelve al storage un **oráculo**: con acceso de lectura al bucket,
   * cualquiera pregunta "¿tenés este archivo exacto?" calculando el hash de un archivo que ya tiene, y la
   * respuesta confirma que ese extracto pasó por el sistema sin leer nada.
   */
  it('el nombre es el id del LOTE, no el hash del contenido', () => {
    expect(clave).toContain(LOTE);
    // La firma de `construirClave` solo acepta un uuid: un hash hexadecimal de 64 no entra.
    expect(() =>
      construirClave({
        clienteId: CLIENTE_A,
        categoria: 'extracto',
        recursoId: 'a'.repeat(64),
        extension: 'pdf',
      }),
    ).toThrow();
  });

  it('rechaza un cliente que no es uuid en vez de armar una clave rara', () => {
    // Sin esto, un `clienteId` vacío produce `cliente//extracto/...`: una clave que ningún prefijo
    // cubre y que por lo tanto queda fuera de cualquier política de bucket.
    for (const malo of ['', 'todos', '../otro-cliente', 'cliente']) {
      expect(() =>
        construirClave({
          clienteId: malo,
          categoria: 'extracto',
          recursoId: LOTE,
          extension: 'pdf',
        }),
      ).toThrow();
    }
  });

  it('`claveEsDelCliente` distingue el prefijo exacto, no un prefijo parecido', () => {
    expect(claveEsDelCliente(clave, CLIENTE_A)).toBe(true);
    expect(claveEsDelCliente(clave, CLIENTE_B)).toBe(false);
    // Y no se conforma con que el uuid aparezca en algún lado de la clave.
    expect(claveEsDelCliente(`cliente/${CLIENTE_B}/extracto/${CLIENTE_A}.pdf`, CLIENTE_A)).toBe(false);
  });

  it('`clienteDeClave` devuelve null ante una clave que no tiene la forma canónica', () => {
    expect(clienteDeClave(clave)).toBe(CLIENTE_A);
    expect(clienteDeClave('extracto/algo.pdf')).toBeNull();
    expect(clienteDeClave('cliente/no-uuid/extracto/x.pdf')).toBeNull();
  });
});
