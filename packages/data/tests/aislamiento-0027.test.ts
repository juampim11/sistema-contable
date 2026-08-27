/**
 * AISLAMIENTO de las once tablas de `0027_cierre_mensual.sql` — conducta de las policies, no
 * estructura (eso lo cubre `mutaciones-0027.test.ts`). Mismo criterio que `aislamiento-0021.test.ts`:
 * con la credencial REAL de la aplicación (nunca `app_job`/superusuario), en las dos direcciones —
 * quien tiene membresía ve lo suyo, quien no tiene membresía no ve nada.
 *
 * Cubre una muestra representativa, no las once tablas con el mismo detalle: `cierre_cliente_periodo`
 * (la entidad central), `pendiente_cierre` (la cola, con su split de roles), y
 * `asiento_propuesto_renglon` (roles simétricos, D-18). Las demás comparten el mismo mecanismo de RLS
 * (`accessible_tenant_ids()` sin excepción) y no tienen conducta propia que las distinga.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup — esta migración (`0027`) tiene
 * que estar APLICADA para que este archivo corra. Al momento de escribirlo, no lo está todavía
 * (`docs/diseno/26-migracion-cierre-mensual.md`): es intencional, se corre recién cuando se apruebe
 * aplicar la migración a local.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '../src/db/conexion.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;

const creadas = {
  cierreA: '',
  cierreB: '',
  pendienteA: '',
  pendienteB: '',
  asientoA: '',
  asientoB: '',
  renglonA: '',
  renglonB: '',
};

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    for (const [clienteId, clave] of [
      [s.clienteA, 'A'],
      [s.clienteB, 'B'],
    ] as const) {
      const cierre = await duenio.query<{ id: string }>(
        `insert into cierre_cliente_periodo
           (cliente_id, tipo_periodo, periodo_desde, periodo_hasta, cierre_estado)
         values ($1, 'mensual', '2026-07-01', '2026-07-31', 'en_revision')
         returning id::text as id`,
        [clienteId],
      );
      const cierreId = cierre.rows[0]?.id as string;

      const pendiente = await duenio.query<{ id: string }>(
        `insert into pendiente_cierre
           (cliente_id, cierre_id, motivo_codigo, pendiente_estado)
         values ($1, $2, 'documento_faltante', 'abierto')
         returning id::text as id`,
        [clienteId, cierreId],
      );

      const cuenta = await duenio.query<{ id: string }>(
        `insert into cuenta (cliente_id) values ($1) returning id::text as id`,
        [clienteId],
      );
      const cuentaId = cuenta.rows[0]?.id as string;

      const asiento = await duenio.query<{ id: string }>(
        `insert into asiento_propuesto (cliente_id, cierre_id, tipo, fecha_imputacion)
         values ($1, $2, 'devengamiento', '2026-07-15')
         returning id::text as id`,
        [clienteId, cierreId],
      );
      const asientoId = asiento.rows[0]?.id as string;

      const renglon = await duenio.query<{ id: string }>(
        `insert into asiento_propuesto_renglon
           (cliente_id, asiento_id, orden, cuenta_id, cuenta_ref, debe, haber, fecha_imputacion)
         values ($1, $2, 1, $3, '{"codigo":"1.1.1","denominacion":"CUENTA 0027 ${clave}","rolFuncional":"generica"}'::jsonb, 100, 0, '2026-07-15')
         returning id::text as id`,
        [clienteId, asientoId, cuentaId],
      );

      const claveMin = clave.toLowerCase() as 'a' | 'b';
      creadas[`cierre${clave}` as 'cierreA' | 'cierreB'] = cierreId;
      creadas[`pendiente${clave}` as 'pendienteA' | 'pendienteB'] = pendiente.rows[0]?.id as string;
      creadas[`asiento${clave}` as 'asientoA' | 'asientoB'] = asientoId;
      creadas[`renglon${clave}` as 'renglonA' | 'renglonB'] = renglon.rows[0]?.id as string;
      void claveMin;
    }
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

describe('aislamiento — cierre_cliente_periodo', () => {
  it('contadorA ve el cierre de A y NO el de B', async () => {
    const filas = await conUsuario(USUARIOS.contadorA, (tx) =>
      tx.consultar<{ id: string }>('select id::text as id from cierre_cliente_periodo'),
    );
    const ids = filas.map((f) => f.id);
    expect(ids).toContain(creadas.cierreA);
    expect(ids).not.toContain(creadas.cierreB);
  });

  it('contadorB ve el cierre de B y NO el de A', async () => {
    const filas = await conUsuario(USUARIOS.contadorB, (tx) =>
      tx.consultar<{ id: string }>('select id::text as id from cierre_cliente_periodo'),
    );
    const ids = filas.map((f) => f.id);
    expect(ids).toContain(creadas.cierreB);
    expect(ids).not.toContain(creadas.cierreA);
  });

  it('socio de OTRO estudio no ve ninguno de los dos', async () => {
    const filas = await conUsuario(USUARIOS.socioOtroEstudio, (tx) =>
      tx.consultar<{ id: string }>('select id::text as id from cierre_cliente_periodo'),
    );
    const ids = filas.map((f) => f.id);
    expect(ids).not.toContain(creadas.cierreA);
    expect(ids).not.toContain(creadas.cierreB);
  });
});

describe('aislamiento — pendiente_cierre', () => {
  it('contadorA ve el pendiente de A y NO el de B', async () => {
    const filas = await conUsuario(USUARIOS.contadorA, (tx) =>
      tx.consultar<{ id: string }>('select id::text as id from pendiente_cierre'),
    );
    const ids = filas.map((f) => f.id);
    expect(ids).toContain(creadas.pendienteA);
    expect(ids).not.toContain(creadas.pendienteB);
  });
});

describe('aislamiento — asiento_propuesto_renglon (roles simétricos, D-18)', () => {
  it('contadorA ve el renglón de A y NO el de B', async () => {
    const filas = await conUsuario(USUARIOS.contadorA, (tx) =>
      tx.consultar<{ id: string }>('select id::text as id from asiento_propuesto_renglon'),
    );
    const ids = filas.map((f) => f.id);
    expect(ids).toContain(creadas.renglonA);
    expect(ids).not.toContain(creadas.renglonB);
  });

  it('auditorA (solo lectura) ve el renglón de A y puede leer la vista de totales', async () => {
    const filas = await conUsuario(USUARIOS.auditorA, (tx) =>
      tx.consultar<{ id: string }>('select id::text as id from asiento_propuesto_renglon'),
    );
    expect(filas.map((f) => f.id)).toContain(creadas.renglonA);

    const totales = await conUsuario(USUARIOS.auditorA, (tx) =>
      tx.consultar<{ totalDebe: string; totalHaber: string }>(
        'select total_debe as "totalDebe", total_haber as "totalHaber" ' +
          'from asiento_propuesto_totales where asiento_id = $1',
        [creadas.asientoA],
      ),
    );
    expect(totales[0]?.totalDebe).toBe('100.00');
    expect(totales[0]?.totalHaber).toBe('0.00');
  });
});
