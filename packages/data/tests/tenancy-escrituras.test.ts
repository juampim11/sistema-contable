/**
 * ALTA DE CLIENTE (`altaDeClienteEnEstudio`) — ítem 6.2, HANDOFF 2026-08-11 (26)/(27).
 *
 * Corre con la MISMA credencial que va a usar la aplicación (`app_request`, sujeta a RLS), igual que
 * `aislamiento.test.ts`: lo que se prueba es el comportamiento real bajo las políticas, no la firma en
 * el vacío.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '../src/db/conexion.ts';
import { altaDeClienteEnEstudio, ErrorDeTenancy } from '../src/tenancy/escrituras.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;

beforeAll(async () => {
  s = await sembrar();
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Cuenta filas de `tenant_node` con el dueño del esquema, sin pasar por RLS: mide el estado real. */
async function contarNodos(): Promise<number> {
  const db = await clienteDuenio();
  try {
    const { rows } = await db.query<{ n: string }>('select count(*)::text as n from tenant_node');
    return Number(rows[0]?.n ?? '-1');
  } finally {
    await db.end();
  }
}

// -----------------------------------------------------------------------------
describe('alta OK, con RLS real (no asumida)', () => {
  it('el socio del estudio da de alta un cliente, y lo ve por conUsuario', async () => {
    const { clienteId } = await conUsuario(USUARIOS.socio, (tx) =>
      altaDeClienteEnEstudio(tx, { estudioId: s.estudio, nombre: 'CLIENTE NUEVO 01' }),
    );

    expect(clienteId).toMatch(/^[0-9a-f-]{36}$/);

    const ids = (
      await conUsuario(USUARIOS.socio, (tx) =>
        tx.consultar<{ id: string }>('select id::text as id from tenant_node'),
      )
    ).map((f) => f.id);
    expect(ids).toContain(clienteId);
  });

  it('deja exactamente una fila de auditoría de escritura, con el uuid recién creado como recurso_id', async () => {
    const { clienteId } = await conUsuario(USUARIOS.socio, (tx) =>
      altaDeClienteEnEstudio(tx, { estudioId: s.estudio, nombre: 'CLIENTE CON RASTRO' }),
    );

    // Se lee con el socio (puede leer el rastro); quien lo escribió (el mismo socio acá) también podría,
    // pero el criterio correcto para una tabla append-only es siempre socio/auditor — ver
    // aislamiento.test.ts, punto 5.
    const filas = await conUsuario(USUARIOS.socio, (tx) =>
      tx.consultar<{ accion: string; recurso: string; recurso_id: string }>(
        `select accion, recurso, recurso_id::text as recurso_id from acceso_auditoria
          where recurso = 'tenant_node' and recurso_id = $1`,
        [clienteId],
      ),
    );
    expect(filas.length, 'tiene que haber exactamente una fila de rastro para este alta').toBe(1);
    expect(filas[0]?.accion).toBe('escritura');
  });
});

// -----------------------------------------------------------------------------
describe('rechazo: sin rol socio/admin_plataforma sobre el estudio', () => {
  it('un contador con rol sobre un CLIENTE, no sobre el estudio, no puede dar de alta', async () => {
    const antes = await contarNodos();

    await expect(
      conUsuario(USUARIOS.contadorA, (tx) =>
        altaDeClienteEnEstudio(tx, { estudioId: s.estudio, nombre: 'INTENTO DE CONTADOR' }),
      ),
    ).rejects.toThrow();

    expect(await contarNodos(), 'el rechazo no debe haber creado ningún nodo').toBe(antes);
  });
});

// -----------------------------------------------------------------------------
describe('aislamiento entre estudios', () => {
  it('un socio de OTRO estudio no ve el nodo nuevo', async () => {
    const { clienteId } = await conUsuario(USUARIOS.socio, (tx) =>
      altaDeClienteEnEstudio(tx, { estudioId: s.estudio, nombre: 'CLIENTE PARA AISLAMIENTO' }),
    );

    const ids = (
      await conUsuario(USUARIOS.socioOtroEstudio, (tx) =>
        tx.consultar<{ id: string }>('select id::text as id from tenant_node'),
      )
    ).map((f) => f.id);
    expect(ids).not.toContain(clienteId);
  });
});

// -----------------------------------------------------------------------------
describe('nombre no es clave de dominio', () => {
  it('dos altas con el mismo --nombre producen dos uuid distintos, a propósito (sin unicidad)', async () => {
    const primero = await conUsuario(USUARIOS.socio, (tx) =>
      altaDeClienteEnEstudio(tx, { estudioId: s.estudio, nombre: 'MISMO NOMBRE' }),
    );
    const segundo = await conUsuario(USUARIOS.socio, (tx) =>
      altaDeClienteEnEstudio(tx, { estudioId: s.estudio, nombre: 'MISMO NOMBRE' }),
    );
    expect(segundo.clienteId).not.toBe(primero.clienteId);
  });
});

// -----------------------------------------------------------------------------
describe('el guard nuevo: un cliente no puede colgar de otro cliente', () => {
  /**
   * Hallazgo de `seguridad-datos-financieros` (HANDOFF 27, punto 3): nada en el `check` de `tenant_node`
   * impide que un `cliente` cuelgue de otro `cliente`. El guard de aplicación lo cierra ANTES del
   * insert — este test confirma las dos partes: el rechazo con el código, y que no se creó el nodo.
   */
  it('--estudio apuntando a un nodo tipo=cliente existente se rechaza, sin crear el nodo', async () => {
    const antes = await contarNodos();

    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        altaDeClienteEnEstudio(tx, { estudioId: s.clienteA, nombre: 'CLIENTE COLGADO DE CLIENTE' }),
      ),
    ).rejects.toThrow(ErrorDeTenancy);

    let codigo: string | undefined;
    try {
      await conUsuario(USUARIOS.socio, (tx) =>
        altaDeClienteEnEstudio(tx, { estudioId: s.clienteA, nombre: 'CLIENTE COLGADO DE CLIENTE 2' }),
      );
    } catch (error) {
      codigo = error instanceof ErrorDeTenancy ? error.codigo : undefined;
    }
    expect(codigo).toBe('estudio_no_es_estudio');

    expect(await contarNodos(), 'el guard tiene que frenar ANTES del insert').toBe(antes);
  });

  it('un uuid que no existe se rechaza con su propio código, distinto del anterior', async () => {
    const inexistente = '99999999-9999-9999-9999-999999999999';
    let codigo: string | undefined;
    try {
      await conUsuario(USUARIOS.socio, (tx) =>
        altaDeClienteEnEstudio(tx, { estudioId: inexistente, nombre: 'CLIENTE HUERFANO' }),
      );
    } catch (error) {
      codigo = error instanceof ErrorDeTenancy ? error.codigo : undefined;
    }
    expect(codigo).toBe('estudio_no_encontrado');
  });
});

// -----------------------------------------------------------------------------
describe('por qué altaDeClienteEnEstudio no usa `returning` (docs/diseno/10-deuda-declarada.md §1.3)', () => {
  /**
   * Mismo patrón que `aislamiento.test.ts` ("el que escribe el rastro puede no poder leerlo") — fija el
   * comportamiento para que nadie "optimice" agregando `returning` de vuelta. Verificado en Postgres
   * real: `tenant_node_sel` es self-referencial (resuelve consultando la propia tabla vía
   * `accessible_tenant_ids()`), así que la re-evaluación de esa policy contra la fila que `returning`
   * devuelve, DENTRO del mismo statement, rechaza — aunque el mismo socio SÍ tenga `select` sobre esa
   * fila un instante después, en la misma transacción. No es el mismo motivo que el caso de
   * `acceso_auditoria` (ahí el escritor no tiene rol de lectura en absoluto): acá sí lo tiene, y falla
   * igual — por timing, no por acceso.
   */
  it('insert ... returning sobre tenant_node rechaza aunque el socio tenga select un instante después', async () => {
    await expect(
      conUsuario(USUARIOS.socio, async (tx) =>
        tx.consultar(
          `insert into tenant_node (id, tipo, nombre, parent_id)
           values (gen_random_uuid(), 'cliente', 'CON RETURNING', $1)
           returning id`,
          [s.estudio],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // El MISMO insert sin `returning` entra sin problema, y una `select` posterior en la misma
    // transacción ve la fila sin inconveniente.
    const clienteId = await conUsuario(USUARIOS.socio, async (tx) => {
      const id = randomUUID();
      await tx.consultar(
        `insert into tenant_node (id, tipo, nombre, parent_id) values ($1, 'cliente', 'SIN RETURNING', $2)`,
        [id, s.estudio],
      );
      const filas = await tx.consultar<{ id: string }>('select id::text as id from tenant_node where id = $1', [
        id,
      ]);
      expect(filas).toHaveLength(1);
      return id;
    });
    expect(clienteId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
