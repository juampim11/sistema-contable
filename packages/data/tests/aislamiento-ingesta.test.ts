/**
 * AISLAMIENTO DE LAS TABLAS DEL MÓDULO 1 — etapa E0 del plan de ingesta.
 *
 * `catalogo.test.ts` verifica que la **estructura** esté bien (RLS forzada, predicados canónicos, FK
 * compuestas, unicidad por tenant). Esto verifica que el **comportamiento** sea el que la estructura
 * promete, con la misma credencial que va a usar la aplicación.
 *
 * Son cosas distintas y hacen falta las dos: una policy puede estar escrita con el predicado canónico y
 * aplicarse a la tabla equivocada, y el catálogo no lo vería.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conJob, conUsuario } from '../src/db/conexion.ts';
import { leerConAuditoria } from '../src/db/auditoria.ts';
import { leerFilasOrigenDeLote, leerIdentificadoresDeCuenta } from '../src/ingesta/lecturas.ts';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from './ayuda.ts';

let s: Sembrado;

/** Ids del escenario, para poder afirmar sobre filas concretas. */
const escenario = {
  cuentaA: '',
  cuentaB: '',
  loteA: '',
  loteB: '',
  movimientoA: '',
};

/**
 * ## Con qué credencial se arma el escenario, y por qué NO con la que saltea RLS
 *
 * El primer intento lo armó con `conJob` (BYPASSRLS), razonando que sembrar por encima de la RLS hace que
 * un "0 filas" al leer signifique algo. Falló con `permission denied for table banco`, y **el diseño tenía
 * razón**: `BYPASSRLS` no otorga privilegios de tabla, y `app_job` no tiene ninguno sobre las tablas del
 * Módulo 1 a propósito — la ingesta corre con `conUsuario()` y su `clienteId`, y que la credencial de job
 * no pueda ni escribir es lo que hace la regla verificable.
 *
 * Así que el escenario se arma con el **socio**, que tiene membresía en el estudio y por lo tanto acceso
 * legítimo a los dos clientes. Eso resulta ser el caso *más fuerte* para lo que hay que probar: cuando el
 * cruce entre carteras lo intenta alguien que la policy **no puede frenar** —porque tiene acceso a las
 * dos— lo único que queda en pie es la integridad referencial.
 *
 * El catálogo `banco` lo siembra el dueño del esquema: no tiene RLS y su escritura es de la migración, no
 * de la aplicación (un banco nuevo llega con su adapter, no por formulario).
 */
beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ('banco_prueba', 'BANCO DE PRUEBA', '{"cadenaDeSaldos": true}'::jsonb)`,
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const cuenta = async (clienteId: string, alias: string): Promise<string> => {
      const f = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
         values ($1, 'banco_prueba', 'ARS', $2) returning id::text as id`,
        [clienteId, alias],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó la cuenta');
      return id;
    };

    const lote = async (clienteId: string, hash: string): Promise<string> => {
      const f = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, filas_leidas)
         values ($1, 'banco_prueba', 'prueba-1', 'archivo', $2, 'recibido', 0)
         returning id::text as id`,
        [clienteId, hash],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó el lote');
      return id;
    };

    escenario.cuentaA = await cuenta(s.clienteA, 'OPERATIVA A');
    escenario.cuentaB = await cuenta(s.clienteB, 'OPERATIVA B');
    escenario.loteA = await lote(s.clienteA, 'hash_a');
    escenario.loteB = await lote(s.clienteB, 'hash_b');

    for (const [clienteId, loteId, cuentaId] of [
      [s.clienteA, escenario.loteA, escenario.cuentaA],
      [s.clienteB, escenario.loteB, escenario.cuentaB],
    ] as const) {
      await tx.consultar(
        `insert into lote_ingesta_cuenta
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta,
            verificacion_estado)
         values ($1, $2, $3, '2026-06-01', '2026-06-30', 'no_verificable')`,
        [clienteId, loteId, cuentaId],
      );
      await tx.consultar(
        // `numero` es el número de cuenta y NO el CBU: el check `cuenta_ident_numero_no_es_cbu` de la
        // migración 0006 rechaza cualquier valor de 22 dígitos, porque guardar el CBU ahí lo deja en claro.
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', '0112-100000/0', '0001', '2026-01-01')`,
        [clienteId, cuentaId],
      );
    }

    // Un movimiento en cada cliente, con EL MISMO fila_hash: es lo que prueba que la unicidad por
    // cliente no los hace colisionar.
    const movimiento = async (
      clienteId: string,
      loteId: string,
      cuentaId: string,
    ): Promise<string> => {
      const f = await tx.consultar<{ id: string }>(
        `insert into movimiento_bancario_crudo
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
            fecha, descripcion, importe, saldo, concepto_banco_estrategia, contraparte_captura)
         values ($1, $2, $3, 1, 'mismo_hash_en_los_dos', '2026-06-15', 'CONCEPTO DE PRUEBA',
                 -4321.00, 765432.10, 'no_publicado', 'no_capturado')
         returning id::text as id`,
        [clienteId, loteId, cuentaId],
      );
      const id = f[0]?.id;
      if (!id) throw new Error('no se creó el movimiento');
      return id;
    };

    escenario.movimientoA = await movimiento(s.clienteA, escenario.loteA, escenario.cuentaA);
    const movB = await movimiento(s.clienteB, escenario.loteB, escenario.cuentaB);

    for (const [clienteId, movId] of [
      [s.clienteA, escenario.movimientoA],
      [s.clienteB, movB],
    ] as const) {
      await tx.consultar(
        `insert into movimiento_origen_crudo (cliente_id, movimiento_id, fila_origen)
         values ($1, $2, '{"columnas": ["15/06/26", "CONCEPTO DE PRUEBA", "-4.321,00"]}'::jsonb)`,
        [clienteId, movId],
      );
    }
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('el mismo hash de fila en dos clientes NO colisiona (unicidad por tenant)', () => {
  /**
   * Es la consecuencia número uno de nacer con `cliente_id`. Con `unique (fila_hash)` global, el segundo
   * cliente con un movimiento idéntico —misma fecha, mismo importe, misma glosa, cosa que pasa todo el
   * tiempo con una comisión bancaria— habría sido rechazado con un error de clave duplicada que además
   * le confirma al estudio que ese movimiento existe en otro cliente.
   */
  it('las dos filas existen, una por cliente', async () => {
    const duenio = await clienteDuenio();
    try {
      const { rows } = await duenio.query<{ n: string }>(
        `select count(*)::text as n from movimiento_bancario_crudo
          where fila_hash = 'mismo_hash_en_los_dos'`,
      );
      expect(rows[0]?.n, 'la unicidad global habría rechazado la segunda').toBe('2');
    } finally {
      await duenio.end();
    }
  });
});

// -----------------------------------------------------------------------------
describe('RLS sobre los movimientos: el contador de un cliente no ve el otro', () => {
  const contarMovimientos = async (usuario: string): Promise<number> =>
    conUsuario(usuario, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo',
      );
      return Number(f[0]?.n ?? '-1');
    });

  it('el contador de A ve solo el movimiento de A', async () => {
    expect(await contarMovimientos(USUARIOS.contadorA)).toBe(1);
  });

  it('el socio del estudio ve los de sus dos clientes', async () => {
    expect(await contarMovimientos(USUARIOS.socio)).toBe(2);
  });

  it('el socio de OTRO estudio no ve ninguno', async () => {
    expect(await contarMovimientos(USUARIOS.socioOtroEstudio)).toBe(0);
  });

  it('sin identidad no hay filas: fail-closed', async () => {
    // `conUsuario` exige un uuid válido, así que la ausencia de identidad se prueba con un usuario que
    // existe pero no tiene ninguna membresía: `accessible_tenant_ids()` vuelve vacío.
    expect(await contarMovimientos('99999999-9999-9999-9999-999999999999')).toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('la satélite N2R exige rol en LECTURA, no solo en escritura', () => {
  const contarOrigen = async (usuario: string): Promise<number> =>
    conUsuario(usuario, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_origen_crudo',
      );
      return Number(f[0]?.n ?? '-1');
    });

  /**
   * Es el escenario H-8 sin descargar ni un PDF: el administrativo que ingesta los archivos tiene acceso
   * al cliente, así que un predicado de solo tenant le daría las 326 filas crudas con los CUIT de todas
   * las contrapartes. El rol en lectura es lo que lo corta.
   */
  it('el administrativo puede INGESTAR pero no puede leer las filas crudas', async () => {
    // Primero: sí puede escribir en el lote, que es su trabajo.
    const pudoEscribir = await conUsuario(USUARIOS.administrativoA, async (tx) => {
      const f = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
         values ($1, 'banco_prueba', 'prueba-1', 'archivo', 'hash_del_administrativo', 'recibido')
         returning id::text as id`,
        [s.clienteA],
      );
      return f[0]?.id !== undefined;
    });
    expect(pudoEscribir, 'el administrativo tiene que poder ingestar').toBe(true);

    // Y no puede leer la satélite N2R.
    expect(await contarOrigen(USUARIOS.administrativoA), 'H-8: leyó las filas crudas').toBe(0);
  });

  it('el contador y el auditor sí las leen', async () => {
    expect(await contarOrigen(USUARIOS.contadorA)).toBe(1);
    expect(await contarOrigen(USUARIOS.auditorA)).toBe(1);
  });
});

// -----------------------------------------------------------------------------
describe('los lectores auditados escriben el rastro ANTES del dato', () => {
  it('leerFilasOrigenDeLote deja la fila de auditoría y devuelve las filas', async () => {
    /**
     * El conteo del rastro se hace con el **socio**, no con el contador que hace la lectura.
     *
     * Salió de correrlo: contando con el contador daba 0 antes y 0 después, y el test "pasaba" en el
     * sentido de no ver diferencia. La causa es que la policy de lectura de `acceso_auditoria` exige
     * socio o auditor — el que deja el rastro normalmente **no puede leerlo**, que es exactamente lo que
     * se quiere de un rastro. Contarlo con quien lo escribe es medir con el instrumento apagado.
     */
    const contarRastro = async (): Promise<number> =>
      conUsuario(USUARIOS.socio, async (tx) => {
        const f = await tx.consultar<{ n: string }>(
          `select count(*)::text as n from acceso_auditoria where recurso = 'movimiento_origen_crudo'`,
        );
        return Number(f[0]?.n ?? '0');
      });

    const antes = await contarRastro();

    const filas = await conUsuario(USUARIOS.contadorA, async (tx) =>
      leerConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'lectura', recurso: 'movimiento_origen_crudo' },
        (ctx) =>
          leerFilasOrigenDeLote(tx, ctx, { clienteId: s.clienteA, loteIngestaId: escenario.loteA }),
      ),
    );

    expect(filas.length).toBe(1);
    expect((await contarRastro()) - antes, 'la lectura no dejó rastro').toBe(1);
  });

  it('leerIdentificadoresDeCuenta resuelve por vigencia, no por "el actual"', async () => {
    const vigentes = await conUsuario(USUARIOS.contadorA, async (tx) =>
      leerConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'lectura', recurso: 'cuenta_bancaria_identificador' },
        (ctx) =>
          leerIdentificadoresDeCuenta(tx, ctx, {
            clienteId: s.clienteA,
            cuentaBancariaId: escenario.cuentaA,
            alFecha: '2026-06-30',
          }),
      ),
    );
    expect(vigentes.length).toBe(1);

    // Una fecha ANTERIOR a la vigencia no devuelve nada, en vez de devolver el identificador actual.
    // Devolverlo haría que un extracto viejo matchee con un número que entonces no existía.
    const antesDeExistir = await conUsuario(USUARIOS.contadorA, async (tx) =>
      leerConAuditoria(
        tx,
        { clienteId: s.clienteA, accion: 'lectura', recurso: 'cuenta_bancaria_identificador' },
        (ctx) =>
          leerIdentificadoresDeCuenta(tx, ctx, {
            clienteId: s.clienteA,
            cuentaBancariaId: escenario.cuentaA,
            alFecha: '2025-06-30',
          }),
      ),
    );
    expect(antesDeExistir.length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('la FK de TRES columnas: lo que queda en pie cuando la policy no puede frenar nada', () => {
  /**
   * Se prueba con el **socio**, que tiene membresía en el estudio y por lo tanto acceso legítimo al
   * cliente A y al cliente B. Ese es el punto: la policy lo deja pasar —y hace bien, tiene acceso a los
   * dos— así que lo único que impide que un movimiento de A apunte a la cuenta de B es la integridad
   * referencial. Es el mismo agujero que abriría un `COPY`, un job con BYPASSRLS o un bug de la
   * aplicación que pase el id equivocado.
   */
  it('un movimiento no puede apuntar a la cuenta de OTRO cliente, aunque el usuario tenga acceso a los dos', async () => {
    await expect(
      conUsuario(USUARIOS.socio, async (tx) =>
        tx.consultar(
          `insert into movimiento_bancario_crudo
             (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
              fecha, descripcion, importe, concepto_banco_estrategia, contraparte_captura)
           values ($1, $2, $3, 99, 'cruce_prohibido', '2026-06-20', 'CRUCE', -1000.00,
                   'no_publicado', 'no_capturado')`,
          // cliente A, lote de A, pero la CUENTA de B.
          [s.clienteA, escenario.loteA, escenario.cuentaB],
        ),
      ),
    ).rejects.toThrow(/fk_mov_crudo_lote_cuenta|foreign key/i);
  });

  it('tampoco puede apuntar a una cuenta propia que no fue detectada en ESE lote', async () => {
    // La cuenta es del cliente A y el lote también, pero el par (lote, cuenta) no existe en
    // `lote_ingesta_cuenta`: la cuenta no se detectó en ese archivo.
    const otroLote = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ id: string }>(
        `insert into lote_ingesta
           (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
         values ($1, 'banco_prueba', 'prueba-1', 'archivo', 'hash_sin_cuentas', 'recibido')
         returning id::text as id`,
        [s.clienteA],
      );
      return f[0]?.id ?? '';
    });

    await expect(
      conUsuario(USUARIOS.socio, async (tx) =>
        tx.consultar(
          `insert into movimiento_bancario_crudo
             (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
              fecha, descripcion, importe, concepto_banco_estrategia, contraparte_captura)
           values ($1, $2, $3, 1, 'cuenta_no_detectada', '2026-06-20', 'X', -1.00,
                   'no_publicado', 'no_capturado')`,
          [s.clienteA, otroLote, escenario.cuentaA],
        ),
      ),
    ).rejects.toThrow(/fk_mov_crudo_lote_cuenta|foreign key/i);
  });
});

// -----------------------------------------------------------------------------
describe('`exigir_nodo_cliente`: un extracto no se le carga a un estudio', () => {
  it('rechaza un lote cuyo cliente_id apunta a un nodo `estudio`', async () => {
    await expect(
      conUsuario(USUARIOS.socio, async (tx) =>
        tx.consultar(
          `insert into lote_ingesta
             (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
           values ($1, 'banco_prueba', 'prueba-1', 'archivo', 'hash_al_estudio', 'recibido')`,
          [s.estudio],
        ),
      ),
    ).rejects.toThrow(/cliente/i);
  });
});

// -----------------------------------------------------------------------------
describe('app_job tiene el privilegio mínimo sobre los identificadores de cuenta', () => {
  /**
   * El job de mantenimiento que detecta el mismo CBU en dos clientes necesita contar clientes por HMAC, y
   * nada más. Con `BYPASSRLS` la policy no lo frena, así que el límite tiene que ser el **grant de
   * columna**: es lo único que Postgres evalúa antes de la RLS.
   */
  it('puede contar por cbu_hmac', async () => {
    const n = await conJob('mantenimiento', async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `select count(distinct cliente_id)::text as n from cuenta_bancaria_identificador
          where cbu_hmac is not null`,
      );
      return f[0]?.n;
    });
    expect(n).toBeDefined();
  });

  it('NO puede leer el número de cuenta', async () => {
    await expect(
      conJob('mantenimiento', async (tx) =>
        tx.consultar('select numero from cuenta_bancaria_identificador'),
      ),
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });
});

// -----------------------------------------------------------------------------
describe('el rastro acepta `rechazo` y rechaza un valor mal escrito', () => {
  it('acepta la acción `rechazo`', async () => {
    await expect(
      conUsuario(USUARIOS.contadorA, async (tx) =>
        tx.consultar(
          `insert into acceso_auditoria (cliente_id, user_id, accion, recurso)
           values ($1, app.current_user_id(), 'rechazo', 'lote_ingesta')`,
          [s.clienteA],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('rechaza un valor fuera del dominio, que si no desaparecería de toda consulta del rastro', async () => {
    await expect(
      conUsuario(USUARIOS.contadorA, async (tx) =>
        tx.consultar(
          `insert into acceso_auditoria (cliente_id, user_id, accion, recurso)
           values ($1, app.current_user_id(), 'rechzo', 'lote_ingesta')`,
          [s.clienteA],
        ),
      ),
    ).rejects.toThrow(/acceso_auditoria_accion_chk|check constraint/i);
  });
});
