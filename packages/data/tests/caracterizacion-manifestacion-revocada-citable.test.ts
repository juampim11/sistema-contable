/**
 * CARACTERIZACIÓN — una manifestación REVOCADA sigue siendo citable por una contrapartida nueva.
 *
 * 🔴 ESTO NO ES UNA MUTACIÓN NI UN BUG A ARREGLAR: es el comportamiento HOY ACEPTADO del DDL de
 * `0021` (`packages/data/migrations/0021_determinante_de_entrada_y_capa_c.sql`, ver el
 * `comment on column padron_manifestacion.revoca_a`), y se fija en un archivo APARTE de
 * `mutaciones-0021.test.ts` a propósito — ese archivo declara en su cabecera un conteo exacto
 * (37 mutaciones + 16 legítimos, 44 `it`) y este caso no es ninguna de las dos cosas: no es una
 * fila defectuosa que el DDL tenga que rechazar, es una fila LEGÍTIMA cuya legitimidad sorprende.
 * Meterlo ahí adentro habría corrompido el conteo sin sumar cobertura real — y por el mismo
 * motivo el nombre de los casos de acá usa el prefijo `CARACT`, nunca `M-` ni `L-`: quien mida
 * cobertura por nombre de test no debe leer esto como "control verificado" cuando es lo opuesto
 * (`seguridad-datos-financieros`, ronda de revisión de este archivo).
 *
 * ## El gap, con línea de la migración
 *
 * `padron_manifestacion` es append-only: una manifestación errónea se SUPERSEDE con una fila
 * nueva que apunta `revoca_a` a la vieja, y no hay policy de `UPDATE` ni de `DELETE` para nadie
 * — así que la fila revocada NUNCA desaparece ni cambia.
 *
 * Las dos FK que protegen `reconocimiento_contrapartida.padron_manifestacion_id` verifican:
 *   - `fk_recon_contrapartida_manifestacion`: que la manifestación EXISTA, del mismo cliente.
 *   - `fk_recon_contrapartida_alcance`: que el espejo `padron_completo_hasta` coincida con el
 *     `completo_hasta` REAL de esa manifestación — así el espejo es infalsificable.
 *
 * Ninguna de las dos pregunta si esa manifestación sigue siendo la VIGENTE, o si alguien la
 * revocó. Este archivo PINEA eso: si algún día se agrega un control de vigencia (una FK
 * compuesta contra una vista de "no revocadas", un trigger, una unicidad parcial tipo
 * `uq_recon_vigente`), el CARACT-1 de abajo tiene que reescribirse A PROPÓSITO —cambiar la
 * aserción de éxito a rechazo, con su código y su constraint exactos— no romperse por sorpresa
 * en medio de otro cambio, ni relajarse para que vuelva a pasar.
 *
 * ## Por qué NO cruza tenant (CARACT-2)
 *
 * `security-engineer` y `seguridad-datos-financieros` verificaron, en la ronda de revisión de
 * este ítem, que el gap está contenido dentro de un mismo cliente: las FK que importan llevan
 * `cliente_id`. CARACT-2 lo deja escrito en código, no solo en el reporte de la revisión: citar
 * la manifestación revocada de un cliente desde una fila de OTRO cliente sigue muriendo por FK,
 * igual que citar cualquier fila ajena.
 *
 * ## Por qué SQL crudo, y con qué credencial
 *
 * No hay productor de aplicación para `reconocimiento_contrapartida` todavía (la tabla "NACE SIN
 * PRODUCTOR", comment de la propia migración): capa C construye `ResolucionDeContraparte` en
 * memoria, pero nada la persiste hoy. El armado de abajo —cuenta, lote, movimiento,
 * reconocimiento, contrapartida— es el mismo mínimo que usan los bloques A y D de
 * `mutaciones-0021.test.ts`, duplicado acá a propósito: ese archivo no exporta sus helpers, y
 * este archivo existe justamente para no compartir su conteo de mutaciones. Corre con
 * `conUsuario()` (credencial `app_request`, no el dueño del esquema): lo que se pinea es una
 * ausencia de CHECK/FK, que corre igual bajo `force row level security` para cualquier escritor
 * — no hace falta bypassear RLS para medirlo.
 *
 * Ni un valor del material real: cliente y usuario salen de `sembrar()` (sintético), y las
 * fechas son literales de esta migración.
 *
 * Requisito previo: `pnpm db:up && pnpm db:migrate && pnpm db:setup`
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario, type Tx } from '../src/db/conexion.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

// -----------------------------------------------------------------------------
// Andamio mínimo — mismo estilo que `mutaciones-0021.test.ts`, duplicado a propósito (ver el
// docstring de arriba: este archivo existe para NO compartir el conteo de mutaciones de aquél).
// -----------------------------------------------------------------------------

type Fila = Record<string, unknown>;
type Ejecutar = (sql: string, params?: readonly unknown[]) => Promise<Fila[]>;

const desdeTx = (tx: Tx): Ejecutar => (sql, params) => tx.consultar<Fila>(sql, params);

async function una(ej: Ejecutar, sql: string, params?: readonly unknown[]): Promise<Fila> {
  const filas = await ej(sql, params);
  const fila = filas[0];
  if (!fila) throw new Error(`La consulta no devolvió fila: ${sql.slice(0, 80)}`);
  return fila;
}

type ErrorPg = { readonly code: string; readonly constraint: string | null };
async function capturar(fn: () => Promise<unknown>): Promise<ErrorPg> {
  try {
    await fn();
    return { code: '', constraint: null };
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return { code: err.code ?? '(sin code)', constraint: err.constraint ?? null };
  }
}

const BANCO = 'banco_caract_manrev';

type Cuenta = { readonly clienteId: string; readonly cuentaId: string; readonly loteId: string };

let s: Sembrado;
let filaSeq = 0;
const escenario = {
  a: { clienteId: '', cuentaId: '', loteId: '' } as Cuenta,
  b: { clienteId: '', cuentaId: '', loteId: '' } as Cuenta,
};

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ($1, 'BANCO CARACT MANREV', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
      [BANCO],
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const ej = desdeTx(tx);
    for (const [clave, clienteId] of [
      ['a', s.clienteA],
      ['b', s.clienteB],
    ] as const) {
      const cuenta = await una(
        ej,
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
         values ($1, $2, 'ARS', $3) returning id::text as id`,
        [clienteId, BANCO, `CARACT MANREV ${clave.toUpperCase()}`],
      );
      const lote = await una(
        ej,
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
         values ($1, $2, 'prueba-caract-manrev', 'archivo', $3, 'recibido', 0)
         returning id::text as id`,
        [clienteId, BANCO, `hash_caract_manrev_${clave}`],
      );
      await ej(
        `insert into lote_ingesta_cuenta
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
            verificacion_estado)
         values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
        [clienteId, String(lote['id']), String(cuenta['id'])],
      );
      escenario[clave] = { clienteId, cuentaId: String(cuenta['id']), loteId: String(lote['id']) };
    }
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

function comoApp<T>(fn: (ej: Ejecutar) => Promise<T>): Promise<T> {
  return conUsuario(USUARIOS.socio, (tx) => fn(desdeTx(tx)));
}

/** Padre mínimo válido: movimiento + reconocimiento clase `propuesta` — la única clase que
 *  admite `es_tercero_padron_completo` vía `contrapartida_promocion_chk`. */
async function crearPadrePropuesta(ej: Ejecutar, cuenta: Cuenta): Promise<{ readonly reconocimientoId: string }> {
  filaSeq += 1;
  const mov = await una(
    ej,
    `insert into movimiento_bancario_crudo
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha, descripcion,
        importe, saldo, concepto_banco, concepto_completo, concepto_banco_estrategia, concepto_codigo,
        contraparte_captura)
     values ($1, $2, $3, $4, $5, '2026-06-15'::date, 'GLOSA CARACT MANREV', '-100.00'::numeric, 900.00,
             'CONCEPTO', true, 'columna_propia', null, 'capturado')
     returning id::text as id, entrada_digest`,
    [cuenta.clienteId, cuenta.loteId, cuenta.cuentaId, filaSeq, randomUUID()],
  );

  const recon = await una(
    ej,
    `insert into reconocimiento_movimiento
       (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
        lado, via, que_decide, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados,
        evidencia_hubo_cola)
     values ($1, $2, $3, $4, 'propuesta', 'comision_bancaria', 'comision_de_transferencia', 'normal',
             'debe', 'texto_literal_exacto', null, 'galicia.comision_de_transferencia', 12, false)
     returning id::text as id`,
    [cuenta.clienteId, String(mov['id']), filaSeq.toString(16).padStart(16, '0'), String(mov['entrada_digest'])],
  );
  return { reconocimientoId: String(recon['id']) };
}

describe('0021 — caracterización: manifestación revocada sigue siendo citable (legítimo, NO mutación)', () => {
  it('CARACT-1 la FK de alcance acepta una manifestación YA REVOCADA (`revoca_a` apunta a ella) porque nunca verifica vigencia, solo existencia + espejo', async () => {
    const { manA, seRevoco } = await comoApp(async (ej) => {
      const a = await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta) values ($1, '2026-06-30'::date)
         returning id::text as id`,
        [escenario.a.clienteId],
      );
      const manA = String(a['id']);

      await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta, revoca_a)
         values ($1, '2026-09-30'::date, $2) returning id::text as id`,
        [escenario.a.clienteId, manA],
      );

      // Sanity check del propio fixture: A está efectivamente revocada por otra fila. Esto no
      // ejercita el gap — solo confirma que el escenario construido es el que se quería.
      const chequeo = await una(
        ej,
        `select count(*)::int as n from padron_manifestacion where cliente_id = $1 and revoca_a = $2`,
        [escenario.a.clienteId, manA],
      );
      return { manA, seRevoco: Number(chequeo['n']) };
    });
    expect(seRevoco, 'el fixture no armó una revocación real: revisar el insert de la revocadora').toBe(1);

    // Una contrapartida NUEVA cita a la manifestación YA REVOCADA, con su espejo correcto (el
    // `completo_hasta` REAL de A, no el de la revocadora). Nada en el DDL distingue "vigente" de
    // "revocada" — las dos FK ven la misma fila existente con el mismo `completo_hasta`.
    const id = await comoApp(async (ej) => {
      const padre = await crearPadrePropuesta(ej, escenario.a);
      const f = await ej(
        `insert into reconocimiento_contrapartida
           (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase,
            padron_manifestacion_id, padron_completo_hasta, resuelto_a_fecha)
         values ($1, $2, 'es_tercero_padron_completo', 'propuesta', $3, $4::date, $5::date)
         returning id::text as id`,
        [escenario.a.clienteId, padre.reconocimientoId, manA, '2026-06-30', '2026-06-15'],
      );
      return f[0]?.['id'];
    });

    // El insert TIENE ÉXITO. Se pinea el comportamiento, no se lo corrige.
    expect(
      id,
      'una contrapartida citando una manifestación YA REVOCADA fue rechazada: si esto se puso ' +
        'rojo, alguien agregó un control de vigencia — actualizar este test A PROPÓSITO, con su ' +
        'nueva aserción de rechazo (código y constraint exactos), no relajarlo para que vuelva a pasar.',
    ).toBeTruthy();
  });

  it('CARACT-2 el gap NO CRUZA TENANT: citar la manifestación revocada de A desde una fila de B sigue muriendo por FK', async () => {
    const manA = await comoApp(async (ej) => {
      const f = await una(
        ej,
        `insert into padron_manifestacion (cliente_id, completo_hasta) values ($1, '2026-06-30'::date)
         returning id::text as id`,
        [escenario.a.clienteId],
      );
      return String(f['id']);
    });

    const error = await capturar(() =>
      comoApp(async (ej) => {
        const padre = await crearPadrePropuesta(ej, escenario.b);
        return ej(
          `insert into reconocimiento_contrapartida
             (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase,
              padron_manifestacion_id, padron_completo_hasta, resuelto_a_fecha)
           values ($1, $2, 'es_tercero_padron_completo', 'propuesta', $3, $4::date, $5::date)`,
          [escenario.b.clienteId, padre.reconocimientoId, manA, '2026-06-30', '2026-06-15'],
        );
      }),
    );

    expect(
      { code: error.code, constraint: error.constraint },
      'una fila del cliente B citó una manifestación del cliente A sin que la FK de dos ' +
        'columnas (cliente_id, padron_manifestacion_id) lo rechazara',
    ).toEqual({ code: '23503', constraint: 'fk_recon_contrapartida_manifestacion' });
  });
});
