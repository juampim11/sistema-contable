/**
 * TESTS DE COMPORTAMIENTO — los invariantes de aislamiento ejercitados a través del código real,
 * no del SQL a mano.
 *
 * Cubren los puntos 1, 4 y 5 de ADR-0002 §H.3 y los invariantes INV-2, INV-3, INV-4, INV-10.
 * Corren con la MISMA credencial que va a usar la aplicación (`app_request`, sujeta a RLS).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cerrarConexiones,
  conJob,
  conUsuario,
  verificarCredencialDeRequest,
} from '../src/db/conexion.ts';
import { leerConAuditoria, registrarAcceso } from '../src/db/auditoria.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('punto 1 — guard de arranque', () => {
  it('la credencial de request no saltea RLS, no es superusuario, y el contexto es local a la transacción', async () => {
    const r = await verificarCredencialDeRequest();
    expect(r.salteaRls, 'DATABASE_URL_APP apunta a un rol con BYPASSRLS').toBe(false);
    expect(r.esSuperusuario, 'DATABASE_URL_APP apunta a un superusuario').toBe(false);
    expect(r.contextoLocalAislado, 'el contexto sobrevive a la transacción: pooler mal configurado').toBe(
      true,
    );
    expect(r.usuario).not.toBe('app_job');
  });
});

// -----------------------------------------------------------------------------
describe('punto 1 — conUsuario es el único camino, y falla ruidoso', () => {
  it('rechaza un usuarioId que no es uuid, en vez de devolver 0 filas en silencio', async () => {
    await expect(conUsuario('', async () => 1)).rejects.toThrow(/usuarioId uuid válido/);
    await expect(conUsuario('no-es-uuid', async () => 1)).rejects.toThrow(/usuarioId uuid válido/);
  });

  it('hace rollback si el cuerpo lanza', async () => {
    const antes = await conUsuario(USUARIOS.socio, async (tx) =>
      (await tx.consultar<{ n: string }>('select count(*)::text as n from acceso_auditoria'))[0]?.n,
    );

    await expect(
      conUsuario(USUARIOS.socio, async (tx) => {
        await registrarAcceso(tx, {
          clienteId: s.clienteA,
          accion: 'lectura',
          recurso: 'prueba_rollback',
        });
        throw new Error('falla a propósito');
      }),
    ).rejects.toThrow('falla a propósito');

    const despues = await conUsuario(USUARIOS.socio, async (tx) =>
      (await tx.consultar<{ n: string }>('select count(*)::text as n from acceso_auditoria'))[0]?.n,
    );
    expect(despues, 'el rollback no revirtió la fila de auditoría').toBe(antes);
  });

  it('INV-4: el contexto no sobrevive de una transacción a la siguiente en la misma conexión', async () => {
    // El pool se comparte; se piden dos transacciones seguidas y la segunda no debe heredar nada.
    await conUsuario(USUARIOS.contadorA, async (tx) => {
      const v = await tx.consultar<{ v: string }>(
        `select coalesce(current_setting('app.user_id', true), '') as v`,
      );
      expect(v[0]?.v).toBe(USUARIOS.contadorA);
    });

    await conUsuario(USUARIOS.contadorB, async (tx) => {
      const v = await tx.consultar<{ v: string }>(
        `select coalesce(current_setting('app.user_id', true), '') as v`,
      );
      // Si acá apareciera el usuario anterior, sería una fuga de tenant.
      expect(v[0]?.v).toBe(USUARIOS.contadorB);
    });
  });
});

// -----------------------------------------------------------------------------
describe('INV-2 / INV-3 — aislamiento a través del código', () => {
  it('el contador de A ve su cliente y no ve el de B', async () => {
    const nodos = await conUsuario(USUARIOS.contadorA, async (tx) =>
      tx.consultar<{ id: string }>('select id::text as id from tenant_node'),
    );
    const ids = nodos.map((f) => f.id);
    expect(ids).toContain(s.clienteA);
    expect(ids).not.toContain(s.clienteB);
    expect(ids).not.toContain(s.clienteC);
    expect(ids, 'un contador de un cliente no debería ver el nodo del estudio').not.toContain(s.estudio);
  });

  it('el socio ve su estudio y sus dos clientes, y nada del otro estudio', async () => {
    const ids = (
      await conUsuario(USUARIOS.socio, async (tx) =>
        tx.consultar<{ id: string }>('select id::text as id from tenant_node'),
      )
    ).map((f) => f.id);

    expect(ids).toContain(s.estudio);
    expect(ids).toContain(s.clienteA);
    expect(ids).toContain(s.clienteB);
    expect(ids).not.toContain(s.estudio2);
    expect(ids).not.toContain(s.clienteC);
  });

  it('un estudio ajeno no ve nada del primero', async () => {
    const ids = (
      await conUsuario(USUARIOS.socioOtroEstudio, async (tx) =>
        tx.consultar<{ id: string }>('select id::text as id from tenant_node'),
      )
    ).map((f) => f.id);
    expect(ids).toContain(s.clienteC);
    expect(ids).not.toContain(s.clienteA);
    expect(ids).not.toContain(s.clienteB);
    expect(ids).not.toContain(s.estudio);
  });

  it('INV-3: no se puede escribir una fila de auditoría en un cliente ajeno', async () => {
    // El contador de A intenta auditar sobre el cliente B: la policy `with check` lo rechaza.
    await expect(
      conUsuario(USUARIOS.contadorA, async (tx) =>
        registrarAcceso(tx, { clienteId: s.clienteB, accion: 'lectura', recurso: 'inyeccion' }),
      ),
    ).rejects.toThrow();

    const cuantas = await conUsuario(USUARIOS.socio, async (tx) =>
      tx.consultar<{ n: string }>(
        `select count(*)::text as n from acceso_auditoria where recurso = 'inyeccion'`,
      ),
    );
    expect(cuantas[0]?.n).toBe('0');
  });
});

// -----------------------------------------------------------------------------
describe('punto 5 — choke point de auditoría', () => {
  it('leerConAuditoria escribe exactamente una fila, ANTES de ejecutar la lectura', async () => {
    const orden: string[] = [];

    // Lo escribe el CONTADOR, que puede dejar rastro pero NO puede leerlo (la policy de lectura exige
    // socio o auditor). Por eso la verificación se hace después, con el socio: es la forma correcta de
    // testear una tabla append-only, y es lo que obligó a sacar el `returning` (migración 0003).
    const correlacion = await conUsuario(USUARIOS.contadorA, async (tx) =>
      leerConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'descarga', recurso: 'extracto_prueba', motivo: 'test' },
        async (ctx) => {
          orden.push('lectura');
          return ctx.correlacion;
        },
      ),
    );

    expect(orden).toEqual(['lectura']);
    expect(correlacion).toMatch(/^[0-9a-f-]{36}$/);

    const filas = await conUsuario(USUARIOS.socio, async (tx) =>
      tx.consultar<{ accion: string; recurso: string; motivo: string | null }>(
        `select accion, recurso, motivo from acceso_auditoria where correlacion = $1`,
        [correlacion],
      ),
    );
    expect(filas.length, 'tiene que haber exactamente una fila de rastro').toBe(1);
    expect(filas[0]?.accion).toBe('descarga');
    expect(filas[0]?.recurso).toBe('extracto_prueba');
    expect(filas[0]?.motivo).toBe('test');
  });

  it('el que escribe el rastro puede no poder leerlo: append-only no admite RETURNING', async () => {
    // Verificado contra Postgres 16: `insert ... returning` aplica la policy de SELECT a la fila
    // devuelta. Este test fija el comportamiento para que nadie "optimice" volviendo al returning.
    await expect(
      conUsuario(USUARIOS.contadorA, async (tx) =>
        tx.consultar(
          `insert into acceso_auditoria (cliente_id, user_id, accion, recurso, correlacion)
           values ($1, app.current_user_id(), 'lectura', 'con_returning', gen_random_uuid())
           returning id`,
          [s.clienteA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // El MISMO insert sin returning entra sin problema.
    await conUsuario(USUARIOS.contadorA, async (tx) =>
      tx.consultar(
        `insert into acceso_auditoria (cliente_id, user_id, accion, recurso, correlacion)
         values ($1, app.current_user_id(), 'lectura', 'sin_returning', gen_random_uuid())`,
        [s.clienteA],
      ),
    );
  });

  it('una descarga o un export SIN motivo se rechaza', async () => {
    await expect(
      conUsuario(USUARIOS.contadorA, async (tx) =>
        registrarAcceso(tx, { clienteId: s.clienteA, accion: 'export', recurso: 'libro_diario' }),
      ),
    ).rejects.toThrow(/exige un motivo escrito/);
  });

  it('no se puede auditar sin identidad: conJob no sirve para dejar rastro de una lectura', async () => {
    await expect(
      conJob('mantenimiento', async (tx) =>
        registrarAcceso(tx, { clienteId: s.clienteA, accion: 'lectura', recurso: 'x' }),
      ),
    ).rejects.toThrow(/necesita una transacción con identidad/);
  });

  it('el rastro no se puede borrar ni editar, ni con la credencial de jobs', async () => {
    await expect(
      conJob('mantenimiento', async (tx) => tx.consultar('delete from acceso_auditoria')),
    ).rejects.toThrow();

    await expect(
      conUsuario(USUARIOS.socio, async (tx) =>
        tx.consultar(`update acceso_auditoria set motivo = 'editado'`),
      ),
    ).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------
describe('punto 4 — el rol importa en la LECTURA, no solo en la escritura', () => {
  it('un administrativo con acceso al cliente NO puede leer el rastro de auditoría', async () => {
    // Deja rastro (puede), pero no lo lee: la policy de select exige socio o auditor.
    await conUsuario(USUARIOS.administrativoA, async (tx) => {
      await registrarAcceso(tx, {
        clienteId: s.clienteA,
        accion: 'lectura',
        recurso: 'plan_cuentas',
      });
    });

    const visto = await conUsuario(USUARIOS.administrativoA, async (tx) =>
      tx.consultar<{ n: string }>('select count(*)::text as n from acceso_auditoria'),
    );
    expect(visto[0]?.n, 'un administrativo no debería poder inspeccionar la auditoría').toBe('0');
  });

  it('el auditor sí lo lee, y el socio también', async () => {
    for (const usuario of [USUARIOS.auditorA, USUARIOS.socio]) {
      const visto = await conUsuario(usuario, async (tx) =>
        tx.consultar<{ n: string }>('select count(*)::text as n from acceso_auditoria'),
      );
      expect(Number(visto[0]?.n), `${usuario} debería poder leer el rastro`).toBeGreaterThan(0);
    }
  });

  it('nadie que no sea socio ve una credencial fiscal, ni sus metadatos', async () => {
    for (const usuario of [USUARIOS.contadorA, USUARIOS.administrativoA, USUARIOS.auditorA]) {
      const filas = await conUsuario(usuario, async (tx) =>
        tx.consultar<{ n: string }>('select count(*)::text as n from credencial_fiscal'),
      );
      expect(filas[0]?.n, `${usuario} no debería ver credenciales`).toBe('0');
    }
  });

  it('ni el socio puede leer la columna del material cifrado (grant a nivel columna)', async () => {
    await expect(
      conUsuario(USUARIOS.socio, async (tx) =>
        tx.consultar('select material_cifrado from credencial_fiscal'),
      ),
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });
});

// -----------------------------------------------------------------------------
describe('punto 2 — la FK compuesta impide cruzar clientes, sin depender de la RLS', () => {
  /**
   * Se corre con el DUEÑO DEL ESQUEMA, no con `app_request`, y es a propósito: lo que se prueba acá es
   * **integridad referencial**, que no depende de las políticas de fila. Justamente por eso vale — es
   * la única defensa de tenant que sobrevive a `BYPASSRLS`, a un `COPY` y a un bug de la aplicación
   * que pase el id de otro cliente (ADR-0002 R12 / H-2).
   */
  it('una rotación no puede apuntar a una credencial de OTRO cliente', async () => {
    const db = await clienteDuenio();
    try {
      await db.query('begin');

      const credencial = async (cliente: string, huella: string): Promise<string> => {
        const { rows } = await db.query<{ id: string }>(
          `insert into credencial_fiscal (cliente_id, servicio, ambiente, material_cifrado, kek_id,
                                          alg, fingerprint_sha256)
           values ($1, 'padron', 'homologacion', '\\x00', 'kek-test', 'aes-256-gcm', $2)
           returning id::text as id`,
          [cliente, huella],
        );
        const id = rows[0]?.id;
        if (!id) throw new Error('no se pudo crear la credencial de prueba');
        return id;
      };

      const credencialDeA = await credencial(s.clienteA, 'aaaa1111');
      const credencialDeB = await credencial(s.clienteB, 'bbbb2222');

      // (a) El caso legítimo entra: cliente A con SU credencial.
      await db.query(
        `insert into credencial_fiscal_rotacion (cliente_id, credencial_id, motivo, rotada_por)
         values ($1, $2, 'vencimiento', $3)`,
        [s.clienteA, credencialDeA, USUARIOS.socio],
      );

      // (b) El cruce NO entra: cliente A apuntando a la credencial de B.
      // Con una FK simple sobre `credencial_id` esto pasaría (la credencial existe). La FK compuesta
      // (cliente_id, credencial_id) lo hace imposible a nivel de integridad referencial.
      await expect(
        db.query(
          `insert into credencial_fiscal_rotacion (cliente_id, credencial_id, motivo, rotada_por)
           values ($1, $2, 'cruce', $3)`,
          [s.clienteA, credencialDeB, USUARIOS.socio],
        ),
      ).rejects.toThrow(/foreign key|llave externa|viola/i);
    } finally {
      await db.query('rollback');
      await db.end();
    }
  });
});

// -----------------------------------------------------------------------------
describe('INV-10 — revocar una membresía corta el acceso en el request siguiente', () => {
  it('sin reinicio y sin esperar ningún TTL', async () => {
    const antes = await conUsuario(USUARIOS.contadorB, async (tx) =>
      tx.consultar<{ id: string }>('select id::text as id from tenant_node'),
    );
    expect(antes.map((f) => f.id)).toContain(s.clienteB);

    await conJob('mantenimiento', async (tx) => {
      await tx.consultar('update membership set activo = false where user_id = $1', [
        USUARIOS.contadorB,
      ]);
    });

    const despues = await conUsuario(USUARIOS.contadorB, async (tx) =>
      tx.consultar<{ id: string }>('select id::text as id from tenant_node'),
    );
    expect(despues, 'el conjunto accesible estaba cacheado en la app').toEqual([]);

    // Se restaura para no dejar el estado sucio para otros archivos de test.
    await conJob('mantenimiento', async (tx) => {
      await tx.consultar('update membership set activo = true where user_id = $1', [
        USUARIOS.contadorB,
      ]);
    });
  });
});
