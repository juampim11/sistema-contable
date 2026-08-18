/**
 * AISLAMIENTO DE LAS TRES TABLAS DE `0021` — conducta de las policies, no estructura.
 *
 * 🔴 POR QUÉ EXISTE ESTE ARCHIVO, y conviene que quede escrito porque el modo de falla fue de
 * proceso y no de código.
 *
 * `0021` creó `padron_manifestacion`, `reconocimiento_contrapartida` y
 * `reconocimiento_contrapartida_match`, y las tres se excluyeron del barrido de
 * `packages/ingesta/tests/aislamiento-modulo-1.test.ts` con el motivo *«cobertura de aislamiento en
 * aislamiento-modulo-2.test.ts»*. **Ese archivo no las mencionaba: cero ocurrencias.** El detector
 * que existe justamente para que una tabla nueva no quede sin cobertura se silenció con una
 * justificación falsa — el mismo patrón que este repo ya documentó («tres lugares del repo afirmaban
 * que este test existía cuando no existía», ADR-0002) y que `0018:58-59` volvió a producir.
 *
 * ## Y por qué `mutaciones-0021.test.ts` NO lo suple
 *
 * Aquel archivo cubre el DDL con 37 mutaciones, pero **todos sus casos cross-tenant usan
 * `USUARIOS.socio`**, que tiene membresía en A y en B, explícitamente «para que la RLS no lo frene y
 * sólo quede la FK». Y su helper de dueño es superusuario, o sea `BYPASSRLS`. Medir una policy por
 * cualquiera de esos dos caminos **pasa EN VACÍO** — lo dice el propio `ayuda.ts`.
 *
 * Lo que se mide acá es lo que ninguno de los dos mide: que un `using (true)` o un `with check` mal
 * escrito en cualquiera de las tres policies **se vea**. Con la credencial real de la aplicación, y
 * en las DOS direcciones: que quien tiene membresía vea lo suyo, y que quien no la tiene no vea nada.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '../src/db/conexion.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;

const escenario = {
  movimientoA: '',
  movimientoB: '',
  reconocimientoA: '',
  reconocimientoB: '',
  socioA: '',
  socioB: '',
};

/** Filas creadas por el dueño, una por cliente, para poder medir QUIÉN LAS VE. */
const creadas = {
  manifestacionA: '',
  manifestacionB: '',
  contrapartidaA: '',
  contrapartidaB: '',
};

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ('banco_0021', 'BANCO 0021', '{"cadenaDeSaldos": true}'::jsonb)
       on conflict (codigo) do nothing`,
    );

    // Un movimiento y un reconocimiento por cliente. Se arma con el DUEÑO a propósito: acá el
    // escenario es andamio, no lo que se mide. Lo que se mide son las lecturas de más abajo, que van
    // con la credencial real.
    for (const [clienteId, clave] of [
      [s.clienteA, 'A'],
      [s.clienteB, 'B'],
    ] as const) {
      const cuenta = await duenio.query<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
         values ($1, 'banco_0021', 'ARS', $2) returning id::text as id`,
        [clienteId, `CUENTA 0021 ${clave}`],
      );
      const lote = await duenio.query<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
         values ($1, 'banco_0021', 'prueba-1', 'archivo', $2, 'recibido', 0)
         returning id::text as id`,
        [clienteId, `hash_0021_${clave}`],
      );
      const cuentaId = cuenta.rows[0]?.id as string;
      const loteId = lote.rows[0]?.id as string;
      await duenio.query(
        `insert into lote_ingesta_cuenta
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, verificacion_estado)
         values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
        [clienteId, loteId, cuentaId],
      );
      const mov = await duenio.query<{ id: string; d: string }>(
        `insert into movimiento_bancario_crudo
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash, fecha,
            descripcion, importe, saldo, concepto_banco_estrategia, contraparte_captura)
         values ($1, $2, $3, 1, $4, '2026-06-15', 'MOVIMIENTO 0021', -100.00, 900.00, 'no_publicado',
                 'no_capturado')
         returning id::text as id, entrada_digest as d`,
        [clienteId, loteId, cuentaId, `hash_mov_0021_${clave}`],
      );
      const movId = mov.rows[0]?.id as string;
      const rec = await duenio.query<{ id: string }>(
        `insert into reconocimiento_movimiento
           (cliente_id, movimiento_id, motor_digest, entrada_digest, clase, tipo, concepto, polaridad,
            lado, via, que_decide, evidencia_entrada_lexico_id, evidencia_caracteres_matcheados,
            evidencia_hubo_cola)
         values ($1, $2, 'aaaaaaaaaaaaaaaa', $3, 'decision_humana', 'pago_a_proveedor_transferencia',
                 'pago_con_transferencia_generico', 'normal', 'debe', 'texto_literal_exacto',
                 'distinguir_tercero_de_socio', 'galicia.pago_con_transferencia_generico', 12, false)
         returning id::text as id`,
        [clienteId, movId, mov.rows[0]?.d as string],
      );
      const socio = await duenio.query<{ id: string }>(
        `insert into padron_socio
           (cliente_id, denominacion, documento_tipo, documento_hmac, documento_ultimos4, pepper_id,
            vigente_desde)
         values ($1, 'SOCIO 0021', 'cuit', $2, '1234', 'v1', '2026-01-01')
         returning id::text as id`,
        [clienteId, Buffer.alloc(32, clave === 'A' ? 1 : 2)],
      );

      if (clave === 'A') {
        escenario.movimientoA = movId;
        escenario.reconocimientoA = rec.rows[0]?.id as string;
        escenario.socioA = socio.rows[0]?.id as string;
      } else {
        escenario.movimientoB = movId;
        escenario.reconocimientoB = rec.rows[0]?.id as string;
        escenario.socioB = socio.rows[0]?.id as string;
      }
    }
  } finally {
    await duenio.end();
  }
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Filas de las tres tablas, una por cliente, creadas por el dueño antes de cada bloque de lectura. */
async function sembrarLasTres(): Promise<void> {
  const duenio = await clienteDuenio();
  try {
    await duenio.query('truncate reconocimiento_contrapartida_match, reconocimiento_contrapartida, padron_manifestacion cascade');
    for (const [clienteId, recId, clave] of [
      [s.clienteA, escenario.reconocimientoA, 'A'],
      [s.clienteB, escenario.reconocimientoB, 'B'],
    ] as const) {
      const man = await duenio.query<{ id: string }>(
        `insert into padron_manifestacion (cliente_id, completo_hasta, manifestado_por)
         values ($1, '2026-12-31', $2) returning id::text as id`,
        [clienteId, USUARIOS.socio],
      );
      const cp = await duenio.query<{ id: string }>(
        `insert into reconocimiento_contrapartida
           (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase, resuelto_a_fecha)
         values ($1, $2, 'es_socio', 'decision_humana', '2026-06-15')
         returning id::text as id`,
        [clienteId, recId],
      ).catch(async () => {
        // `es_socio` exige clase `propuesta` (`contrapartida_promocion_chk`). Para este archivo da
        // igual el estado: lo que se mide es QUIÉN VE LA FILA, no su forma — eso ya lo cubre
        // `mutaciones-0021.test.ts`. Se usa un estado no promotor, que es el que el motor produce hoy.
        return duenio.query<{ id: string }>(
          `insert into reconocimiento_contrapartida
             (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase, resuelto_a_fecha)
           values ($1, $2, 'sin_candidatos', 'decision_humana', '2026-06-15')
           returning id::text as id`,
          [clienteId, recId],
        );
      });
      if (clave === 'A') {
        creadas.manifestacionA = man.rows[0]?.id as string;
        creadas.contrapartidaA = cp.rows[0]?.id as string;
      } else {
        creadas.manifestacionB = man.rows[0]?.id as string;
        creadas.contrapartidaB = cp.rows[0]?.id as string;
      }
    }
  } finally {
    await duenio.end();
  }
}

const contar = async (usuario: string, tabla: string): Promise<number> =>
  conUsuario(usuario, async (tx) => {
    const f = await tx.consultar<{ n: string }>(`select count(*)::text as n from ${tabla}`);
    return Number(f[0]?.n ?? '-1');
  });

// -----------------------------------------------------------------------------
describe('0021 — aislamiento por CONDUCTA de las tres tablas nuevas', () => {
  beforeEach(async () => {
    await sembrarLasTres();
  });

  /**
   * 🔴 LAS DOS DIRECCIONES, que es lo único que hace útil a un test de aislamiento. La primera
   * (quien tiene membresía ve lo suyo) sola pasaría con `using (true)`; la segunda (quien no la
   * tiene no ve nada) sola pasaría con una tabla vacía. Juntas discriminan.
   */
  it.each([
    ['padron_manifestacion'],
    ['reconocimiento_contrapartida'],
  ])('%s: el contador de A ve lo suyo y NADA de B; el de otro estudio no ve nada', async (tabla) => {
    expect(await contar(USUARIOS.contadorA, tabla), `${tabla}: el contador de A no ve su propia fila`).toBe(1);
    expect(await contar(USUARIOS.contadorB, tabla), `${tabla}: FUGA entre clientes del mismo estudio`).toBe(1);
    expect(
      await contar(USUARIOS.socioOtroEstudio, tabla),
      `${tabla}: FUGA entre estudios — un usuario ajeno ve filas`,
    ).toBe(0);
    // El socio del estudio tiene membresía en los DOS clientes: ve las dos filas. Es lo que
    // distingue «la policy filtra por tenant» de «la policy filtra por usuario».
    expect(await contar(USUARIOS.socio, tabla), `${tabla}: el socio del estudio no ve sus dos clientes`).toBe(2);
  });

  it('reconocimiento_contrapartida_match: mismo aislamiento en la satélite', async () => {
    const duenio = await clienteDuenio();
    try {
      for (const [clienteId, cpId, socioId] of [
        [s.clienteA, creadas.contrapartidaA, escenario.socioA],
        [s.clienteB, creadas.contrapartidaB, escenario.socioB],
      ] as const) {
        // La satélite sólo cuelga de un estado que admite matches; se ajusta el padre para poder
        // sembrarla. Es andamio: lo que se mide es la lectura.
        await duenio.query(
          `update reconocimiento_contrapartida set resolucion_estado = 'multiples_socios'
            where id = $1`,
          [cpId],
        );
        await duenio.query(
          `insert into reconocimiento_contrapartida_match
             (cliente_id, contrapartida_id, regimen_matches, socio_id, match_clase)
           values ($1, $2, 'varios', $3, 'cuit')`,
          [clienteId, cpId, socioId],
        );
      }
    } finally {
      await duenio.end();
    }

    const tabla = 'reconocimiento_contrapartida_match';
    expect(await contar(USUARIOS.contadorA, tabla)).toBe(1);
    expect(await contar(USUARIOS.contadorB, tabla)).toBe(1);
    expect(await contar(USUARIOS.socioOtroEstudio, tabla), 'FUGA entre estudios en la satélite').toBe(0);
    expect(await contar(USUARIOS.socio, tabla)).toBe(2);
  });

  /**
   * 🔴 LA MITAD DE ESCRITURA. La policy de `insert` lleva `has_role_on`, así que además del tenant
   * filtra por ROL — y en `padron_manifestacion` el `administrativo` está excluido a propósito:
   * «decidir quién es socio de un cliente es criterio del contador», y manifestar es esa decisión un
   * nivel más arriba (no dice «esta persona es socia», dice «no hay ninguna otra que lo sea»).
   *
   * Sin este caso, sacar `administrativo` de la policy sería un cambio que ningún test detecta.
   */
  it('padron_manifestacion: el administrativo NO puede manifestar, el contador sí', async () => {
    const manifestar = async (usuario: string): Promise<string> =>
      conUsuario(usuario, async (tx) => {
        try {
          await tx.consultar(
            `insert into padron_manifestacion (cliente_id, completo_hasta) values ($1, '2026-12-31')`,
            [s.clienteA],
          );
          return 'entro';
        } catch (error) {
          return (error as { codigo?: string; code?: string }).codigo ?? (error as { code?: string }).code ?? 'error';
        }
      });

    expect(await manifestar(USUARIOS.contadorA), 'el contador de A no pudo manifestar').toBe('entro');
    expect(
      await manifestar(USUARIOS.administrativoA),
      '🔴 el administrativo pudo declarar el padrón completo — es la premisa que convierte su propio ' +
        'trabajo en propuesta lista',
    ).not.toBe('entro');
  });

  /**
   * La otra mitad del rol: `reconocimiento_contrapartida` SÍ admite al `administrativo`, porque es
   * SALIDA DEL MOTOR y no una premisa. Sin este caso, alguien podría «arreglar» la diferencia
   * copiando la policy de la manifestación y nadie se enteraría.
   */
  it('reconocimiento_contrapartida: el administrativo SÍ puede escribir — es salida del motor', async () => {
    const r = await conUsuario(USUARIOS.administrativoA, async (tx) => {
      try {
        await tx.consultar(
          `insert into reconocimiento_contrapartida
             (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase, resuelto_a_fecha)
           values ($1, $2, 'sin_match_padron_incompleto', 'decision_humana', '2026-06-15')`,
          [s.clienteA, escenario.reconocimientoA],
        );
        return 'entro';
      } catch (error) {
        return (error as { codigo?: string; code?: string }).codigo ?? (error as { code?: string }).code ?? 'error';
      }
    });
    // 🔴 La aserción es sobre la POLICY, no sobre el resultado del insert: la 1:0..1
    // (`uq_recon_contrapartida_reconocimiento`) puede rechazarlo con `23505` si el `beforeEach` ya
    // sembró la fila de ese reconocimiento, y eso es correcto. Lo que NO puede pasar es que lo
    // rechace la RLS, que responde `42501` — ése es el único desenlace que este caso prohíbe.
    // Asertar `=== 'entro'` habría medido la unicidad y no el rol, y habría quedado verde el día que
    // alguien sacara al administrativo de la policy.
    expect(r, 'la RLS rechazó al administrativo: es SALIDA DEL MOTOR y debe poder escribir').not.toBe('42501');
  });

  /**
   * 🔴 Y LA ESCRITURA CROSS-TENANT, que es distinta de la lectura: el `with check` de la policy de
   * insert. Un `with check (true)` dejaría escribir en el tenant ajeno aunque la lectura filtrara
   * bien — y esa fila después la vería su dueño legítimo como propia.
   */
  it('ninguna de las tres admite escribir en el tenant AJENO', async () => {
    const escribirEnB = async (sql: string, params: readonly unknown[]): Promise<string> =>
      conUsuario(USUARIOS.contadorA, async (tx) => {
        try {
          await tx.consultar(sql, params as unknown[]);
          return 'entro';
        } catch (error) {
          return (error as { codigo?: string; code?: string }).codigo ?? (error as { code?: string }).code ?? 'error';
        }
      });

    expect(
      await escribirEnB(
        `insert into padron_manifestacion (cliente_id, completo_hasta) values ($1, '2026-12-31')`,
        [s.clienteB],
      ),
      '🔴 el contador de A escribió una manifestación en el cliente B',
    ).not.toBe('entro');

    expect(
      await escribirEnB(
        `insert into reconocimiento_contrapartida
           (cliente_id, reconocimiento_id, resolucion_estado, reconocimiento_clase, resuelto_a_fecha)
         values ($1, $2, 'sin_candidatos', 'decision_humana', '2026-06-15')`,
        [s.clienteB, escenario.reconocimientoB],
      ),
      '🔴 el contador de A escribió una contrapartida en el cliente B',
    ).not.toBe('entro');

    expect(
      await escribirEnB(
        `insert into reconocimiento_contrapartida_match
           (cliente_id, contrapartida_id, regimen_matches, socio_id, match_clase)
         values ($1, $2, 'varios', $3, 'cuit')`,
        [s.clienteB, creadas.contrapartidaB, escenario.socioB],
      ),
      '🔴 el contador de A escribió un match en el cliente B',
    ).not.toBe('entro');
  });
});
