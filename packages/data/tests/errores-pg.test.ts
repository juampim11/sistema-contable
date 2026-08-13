/**
 * R28 — UN ERROR DE POSTGRES NO PUEDE SACAR LA FILA.
 *
 * Cuando se viola un `check` o un `not null`, Postgres agrega
 * `DETAIL: Failing row contains (…)` **con la fila entera**. En `movimiento_bancario_crudo` eso es la
 * fecha, la glosa con el nombre de la contraparte, el importe y el saldo: N2 completo.
 *
 * El escenario de daño es el más probable del módulo: la primera corrida contra un PDF real falla en la
 * fila 143, el error sube sin capturar, y alguien —razonablemente, para pedir ayuda— pega el stderr en un
 * issue. Ahí viajó la fila de un extracto real, y no hay rotación posible.
 *
 * Estos tests plantan un valor reconocible y exigen que **no aparezca en ninguna salida**.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '../src/db/conexion.ts';
import { ErrorDeBase, traducirErrorDeBase } from '../src/db/errores-pg.ts';
import { redactar } from '@sistema-contable/shared/seguridad';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;
const ids = { cuenta: '', lote: '' };

/** Valores plantados, reconocibles y sintéticos. Son lo que NO puede salir. */
const GLOSA_PLANTADA = 'GLOSAPLANTADAPARAELTEST';
const IMPORTE_PLANTADO = '-1482350.00';

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('banco_r28', 'BANCO DE PRUEBA R28')
       on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const c = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
       values ($1, 'banco_r28', 'ARS') returning id::text as id`,
      [s.clienteA],
    );
    ids.cuenta = c[0]?.id ?? '';

    const l = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
       values ($1, 'banco_r28', 'r28@1', 'archivo', 'hash_r28', 'recibido')
       returning id::text as id`,
      [s.clienteA],
    );
    ids.lote = l[0]?.id ?? '';

    await tx.consultar(
      `insert into lote_ingesta_cuenta
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
          verificacion_estado)
       values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
      [s.clienteA, ids.lote, ids.cuenta],
    );
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Provoca la violación de check con los valores plantados y devuelve el error CRUDO del driver. */
async function violarCheck(): Promise<unknown> {
  try {
    await conUsuario(USUARIOS.socio, async (tx) => {
      await tx.consultar(
        `insert into movimiento_bancario_crudo
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
            fecha, descripcion, importe, moneda, concepto_banco_estrategia, contraparte_captura)
         values ($1, $2, $3, 1, 'hash_r28_fila', '2026-06-15', $4, $5::numeric, 'zz',
                 'no_publicado', 'no_capturado')`,
        [s.clienteA, ids.lote, ids.cuenta, GLOSA_PLANTADA, IMPORTE_PLANTADO],
      );
    });
    throw new Error('el insert no falló: el check de moneda no está puesto');
  } catch (error) {
    return error;
  }
}

// -----------------------------------------------------------------------------
describe('cuánto expone el driver, medido — y el hallazgo que salió de medirlo', () => {
  /**
   * ## El riesgo es real: en una tabla SIN RLS, el `DETAIL` trae la fila entera
   *
   * Verificado contra Postgres 16:
   *
   *     ERROR:  new row for relation "banco" violates check constraint "banco_codigo_chk"
   *     DETAIL:  Failing row contains (XX-MAYUSCULA-INVALIDA, PRUEBA, {}, t, 2026-…).
   *
   * `banco` es un catálogo N0 sin datos de nadie, así que ahí no hay daño. El punto es que **el mecanismo
   * existe** y que en una tabla con datos de un cliente sacaría la fila.
   */
  it('en una tabla SIN RLS, el detail del driver expone la fila que falló', async () => {
    const duenio = await clienteDuenio();
    let detail = '';
    try {
      // El código viola `banco_codigo_chk` (solo minúsculas, dígitos y guión bajo). Valor sintético.
      await duenio.query(`insert into banco (codigo, nombre) values ('CODIGO-INVALIDO', 'PRUEBA')`);
      expect.unreachable('el check de banco.codigo no está puesto');
    } catch (error) {
      detail = (error as { detail?: string }).detail ?? '';
    } finally {
      await duenio.end();
    }

    // Si esto deja de dar true, Postgres cambió y conviene revisar si el traductor sigue haciendo falta.
    expect(detail, 'el driver ya no expone la fila: revisar si el traductor sigue haciendo falta').toContain(
      'Failing row contains',
    );
    expect(detail).toContain('CODIGO-INVALIDO');
  });

  /**
   * ## EL HALLAZGO: la RLS forzada también protege el `DETAIL`
   *
   * La misma violación, en una tabla con `force row level security`, **no** trae la fila. Postgres es
   * conservador: si las políticas podrían ocultarle esa fila al rol, no la muestra en el mensaje de error.
   *
   * O sea que los siete renglones obligatorios de ADR-0001 §5 —puestos para aislar clientes— dan además
   * una defensa que nadie diseñó: **una tabla de dominio no puede filtrar su fila por un mensaje de
   * error**. Es la mejor clase de resultado, y conviene tenerlo escrito: es un argumento más para que
   * ninguna tabla con datos de cliente quede sin RLS "porque es auxiliar".
   *
   * **No reemplaza al traductor.** El traductor cubre lo que esto no: las tablas sin RLS, un rol futuro
   * con más privilegios, el `where` con el contexto de la query, y el hecho de que re-lanzar el error del
   * driver arrastra `stack` y `parameters` aunque el `detail` venga limpio.
   */
  it('en una tabla CON RLS forzada, el detail NO expone la fila', async () => {
    const crudo = await violarCheck();
    const todo = JSON.stringify({
      message: (crudo as { message?: string }).message,
      detail: (crudo as { detail?: string }).detail,
      where: (crudo as { where?: string }).where,
    });

    expect(todo).not.toContain(GLOSA_PLANTADA);
    expect(todo).not.toContain('1482350');
    // Y sí trae lo que hace falta para diagnosticar: la constraint.
    expect((crudo as { constraint?: string }).constraint).toBe('mov_crudo_moneda_chk');
  });

  it('pero el error crudo igual arrastra campos que no queremos propagar', async () => {
    const crudo = await violarCheck();
    const campos = Object.keys(crudo as object);
    // `where`, `table`, `column`, `dataType`, `internalQuery`: nada de esto tiene que salir del proceso, y
    // un `throw error` los lleva todos. Es la razón por la que el traductor construye un Error NUEVO.
    expect(campos).toContain('where');
    expect(campos).toContain('table');
    expect(campos).toContain('internalQuery');
  });
});

// -----------------------------------------------------------------------------
describe('el error TRADUCIDO no saca nada', () => {
  it('no contiene la glosa ni el importe, y sí el código y la constraint', async () => {
    const traducido = traducirErrorDeBase(await violarCheck(), 143);

    expect(traducido).toBeInstanceOf(ErrorDeBase);
    expect(traducido.codigo).toBe('ING_CHECK');
    // El nombre de la constraint es seguro y es lo más útil que hay: dice qué se violó sin decir con qué.
    expect(traducido.constraint).toBe('mov_crudo_moneda_chk');
    expect(traducido.filaNumero).toBe(143);

    // Todo lo enumerable del error traducido más su mensaje: si alguien agrega un campo, este test lo ve.
    const serializado = JSON.stringify({ ...traducido, mensaje: traducido.message });
    expect(serializado).not.toContain(GLOSA_PLANTADA);
    expect(serializado).not.toContain('1482350');
    expect(serializado).not.toContain('Failing row');
  });

  it('tampoco lo saca por `stack`: el mensaje es el que armamos nosotros', async () => {
    const traducido = traducirErrorDeBase(await violarCheck(), 7);
    expect(traducido.stack ?? '').not.toContain(GLOSA_PLANTADA);
  });

  it('un `unique` violado traduce a ING_DUPLICADO', async () => {
    // Se inserta la misma fila dos veces con el mismo `fila_hash`.
    const insertar = (): Promise<unknown> =>
      conUsuario(USUARIOS.socio, async (tx) =>
        tx.consultar(
          `insert into movimiento_bancario_crudo
             (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
              fecha, descripcion, importe, concepto_banco_estrategia, contraparte_captura)
           values ($1, $2, $3, 1, 'hash_duplicado_r28', '2026-06-15', 'CONCEPTO', -100.00,
                   'no_publicado', 'no_capturado')`,
          [s.clienteA, ids.lote, ids.cuenta],
        ),
      );

    await insertar();
    try {
      await insertar();
      expect.unreachable('la segunda inserción debería violar la unicidad');
    } catch (error) {
      const t = traducirErrorDeBase(error);
      expect(t.codigo).toBe('ING_DUPLICADO');
      expect(t.constraint).toBe('uq_mov_crudo_fila');
    }
  });

  it('un error que no es de Postgres cae en ING_OTRO, sin filtrar su mensaje', () => {
    const t = traducirErrorDeBase(new Error(`explotó con ${GLOSA_PLANTADA}`));
    expect(t.codigo).toBe('ING_OTRO');
    expect(t.message).not.toContain(GLOSA_PLANTADA);
  });

  it('traducir dos veces conserva el número de fila original', () => {
    const primero = traducirErrorDeBase({ code: '23514', constraint: 'x_chk' }, 99);
    expect(traducirErrorDeBase(primero, 1).filaNumero).toBe(99);
  });
});

// -----------------------------------------------------------------------------
describe('el redactor es la RED, y por sí solo no alcanza', () => {
  /**
   * Es el límite declarado, y es la razón por la que el traductor existe.
   *
   * La forma canónica de un `numeric` de Postgres es `1482350.00` —punto decimal, sin separador de miles—
   * y el detector `importe_ar` busca el formato **local** (`1.482.350,00`). Un importe que sale por el
   * camino del driver **pasa el redactor limpio**. Y una razón social no tiene patrón: el redactor no
   * puede reconocerla (ADR-0002 §C.0.bis).
   *
   * Dejarlo escrito como test es lo que impide que alguien concluya "ya está, el redactor lo tapa".
   */
  it('el redactor NO tapa un importe en forma canónica de Postgres', () => {
    const redactado = JSON.stringify(redactar(new Error(`fila con importe ${IMPORTE_PLANTADO}`)));
    expect(
      redactado.includes('1482350'),
      'si esto empieza a dar false, se agregó un detector de forma canónica: revisar si ' +
        'no está tapando también duraciones y conteos',
    ).toBe(true);
  });

  it('el redactor SÍ tapa el mismo importe en formato argentino', () => {
    const redactado = JSON.stringify(redactar(new Error('fila con importe 1.482.350,00')));
    expect(redactado).not.toContain('1.482.350,00');
  });

  it('por eso el camino seguro es el traductor, no el redactor', async () => {
    // El traductor no depende de reconocer el valor: descarta el campo entero.
    const t = traducirErrorDeBase(await violarCheck(), 143);
    expect(JSON.stringify(redactar(t))).not.toContain('1482350');
  });
});
