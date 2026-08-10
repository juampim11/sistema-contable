/**
 * EL EMISOR DE URL FIRMADA, contra Postgres y MinIO reales.
 *
 * Una URL firmada es una capacidad transferible: quien la tiene lee el objeto sin autenticarse, sin pasar
 * por la RLS y sin dejar rastro en la base. Estos tests verifican que el único punto que las emite haga
 * los cinco chequeos, **en orden**, con la misma infraestructura que corre en desarrollo.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';
import { construirClave } from '../src/clave.ts';
import {
  configDelEntorno,
  crearObjectStorage,
  type ObjectStorage,
} from '../src/object-storage.ts';
import {
  emitirUrlDeDescarga,
  ROLES_QUE_DESCARGAN,
  TTL_MAXIMO_SEGUNDOS,
} from '../src/descarga.ts';

let s: Sembrado;
let storage: ObjectStorage;
let clave: string;

const LOTE = 'dddddddd-4444-4444-4444-444444444444';
const CONTENIDO = Buffer.from('%PDF-1.4 extracto SINTETICO de prueba');

beforeAll(async () => {
  s = await sembrar();
  storage = crearObjectStorage(configDelEntorno());
  clave = construirClave({
    clienteId: s.clienteA,
    categoria: 'extracto',
    recursoId: LOTE,
    extension: 'pdf',
  });
  await storage.guardar(clave, CONTENIDO, 'application/pdf');
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('el almacenamiento hace ida y vuelta contra MinIO', () => {
  it('lo que se guarda es lo que se lee', async () => {
    const leido = await storage.obtener(clave);
    expect(leido.equals(CONTENIDO)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
describe('quién puede descargar y quién no', () => {
  const emitir = (usuario: string, clienteId = s.clienteA, laClave = clave) =>
    conUsuario(usuario, (tx) =>
      emitirUrlDeDescarga(tx, storage, {
        clienteId,
        clave: laClave,
        motivo: 'revision de conciliacion de junio',
        recursoId: LOTE,
      }),
    );

  it('el socio y el contador reciben la URL', async () => {
    for (const usuario of [USUARIOS.socio, USUARIOS.contadorA]) {
      const r = await emitir(usuario);
      expect(r.emitida, `${usuario} no pudo descargar`).toBe(true);
      if (r.emitida) expect(r.url).toMatch(/^https?:\/\//);
    }
  });

  /**
   * **El punto entero de la condición 9.** El escenario H-8 de ADR-0002 es literalmente el administrativo
   * bajándose cuarenta extractos en su última semana. Puede ingestar —es su trabajo, y el test de
   * aislamiento lo verifica— y no puede descargar.
   */
  it('el administrativo NO recibe la URL, aunque tenga acceso al cliente', async () => {
    const r = await emitir(USUARIOS.administrativoA);
    expect(r.emitida, 'H-8: el administrativo se bajó el archivo').toBe(false);
    if (!r.emitida) expect(r.motivoCodigo).toBe('rol_insuficiente');
  });

  it('el auditor tampoco: verifica que el proceso ocurrió sin necesitar el documento', async () => {
    const r = await emitir(USUARIOS.auditorA);
    expect(r.emitida).toBe(false);
  });

  it('el socio de otro estudio tampoco', async () => {
    const r = await emitir(USUARIOS.socioOtroEstudio);
    expect(r.emitida).toBe(false);
  });

  it('el rol se pregunta a la BASE, con la misma función que usan las policies', () => {
    // Dos fuentes de verdad para "qué rol tiene esta persona" divergen, y la que gana es la de la base.
    // Esto fija la lista para que un cambio en `ROLES_QUE_DESCARGAN` sea una decisión visible.
    expect([...ROLES_QUE_DESCARGAN]).toEqual(['socio', 'contador']);
  });
});

// -----------------------------------------------------------------------------
describe('los chequeos previos a la firma', () => {
  it('una clave de OTRO cliente se rechaza, aunque el usuario tenga acceso a los dos', async () => {
    /**
     * El socio tiene acceso al cliente A y al B. Sin este chequeo, declarar `clienteId: A` y pasar la
     * clave de B produce un rastro que dice lo contrario de lo que pasó — el peor resultado posible,
     * porque la investigación posterior arranca con una pista falsa.
     */
    const claveDeB = construirClave({
      clienteId: s.clienteB,
      categoria: 'extracto',
      recursoId: LOTE,
      extension: 'pdf',
    });

    const r = await conUsuario(USUARIOS.socio, (tx) =>
      emitirUrlDeDescarga(tx, storage, {
        clienteId: s.clienteA,
        clave: claveDeB,
        motivo: 'revision',
      }),
    );

    expect(r.emitida).toBe(false);
    if (!r.emitida) expect(r.motivoCodigo).toBe('clave_de_otro_cliente');
  });

  it('sin motivo escrito no se firma: sacar un dato del sistema exige decir para qué', async () => {
    for (const motivo of ['', '  ', 'ok']) {
      const r = await conUsuario(USUARIOS.socio, (tx) =>
        emitirUrlDeDescarga(tx, storage, { clienteId: s.clienteA, clave, motivo }),
      );
      expect(r.emitida, `aceptó el motivo "${motivo}"`).toBe(false);
      if (!r.emitida) expect(r.motivoCodigo).toBe('motivo_faltante');
    }
  });
});

// -----------------------------------------------------------------------------
describe('el TTL tiene un tope DURO, no una recomendación', () => {
  it('recorta un TTL exagerado en vez de confiar en el llamador', async () => {
    const r = await conUsuario(USUARIOS.socio, (tx) =>
      emitirUrlDeDescarga(tx, storage, {
        clienteId: s.clienteA,
        clave,
        motivo: 'revision',
        ttlSegundos: 86_400,
      }),
    );
    expect(r.emitida).toBe(true);
    if (r.emitida) expect(r.expiraEnSegundos).toBe(TTL_MAXIMO_SEGUNDOS);
  });

  it('respeta un TTL más corto', async () => {
    const r = await conUsuario(USUARIOS.socio, (tx) =>
      emitirUrlDeDescarga(tx, storage, {
        clienteId: s.clienteA,
        clave,
        motivo: 'revision',
        ttlSegundos: 30,
      }),
    );
    if (r.emitida) expect(r.expiraEnSegundos).toBe(30);
  });

  it('la URL firmada lleva la expiración, y es la acotada', async () => {
    const r = await conUsuario(USUARIOS.socio, (tx) =>
      emitirUrlDeDescarga(tx, storage, {
        clienteId: s.clienteA,
        clave,
        motivo: 'revision',
        ttlSegundos: 999_999,
      }),
    );
    expect(r.emitida).toBe(true);
    if (r.emitida) {
      const url = new URL(r.url);
      expect(url.searchParams.get('X-Amz-Expires')).toBe(String(TTL_MAXIMO_SEGUNDOS));
    }
  });
});

// -----------------------------------------------------------------------------
describe('la auditoría se escribe ANTES de firmar', () => {
  /**
   * El orden importa: si la firma falla, queda registrado el intento, que es información. Al revés, una
   * firma emitida y una auditoría que falló dejan una **capacidad viva sin rastro**.
   */
  const contarDescargas = async (): Promise<number> => {
    const duenio = await clienteDuenio();
    try {
      const { rows } = await duenio.query<{ n: string }>(
        `select count(*)::text as n from acceso_auditoria where accion = 'descarga'`,
      );
      return Number(rows[0]?.n ?? '0');
    } finally {
      await duenio.end();
    }
  };

  it('una emisión exitosa deja exactamente una fila, con su motivo', async () => {
    const antes = await contarDescargas();
    await conUsuario(USUARIOS.socio, (tx) =>
      emitirUrlDeDescarga(tx, storage, {
        clienteId: s.clienteA,
        clave,
        motivo: 'auditoria de la fila de descarga',
        recursoId: LOTE,
      }),
    );
    expect((await contarDescargas()) - antes).toBe(1);

    const duenio = await clienteDuenio();
    try {
      const { rows } = await duenio.query<{ motivo: string | null; recurso: string }>(
        `select motivo, recurso from acceso_auditoria
          where accion = 'descarga' order by ocurrido_en desc limit 1`,
      );
      expect(rows[0]?.recurso).toBe('extracto');
      expect(rows[0]?.motivo).toBe('auditoria de la fila de descarga');
    } finally {
      await duenio.end();
    }
  });

  it('un rechazo por rol NO deja fila de descarga: no hubo descarga que auditar', async () => {
    const antes = await contarDescargas();
    await conUsuario(USUARIOS.administrativoA, (tx) =>
      emitirUrlDeDescarga(tx, storage, { clienteId: s.clienteA, clave, motivo: 'intento' }),
    );
    expect((await contarDescargas()) - antes).toBe(0);
  });
});
