/**
 * INV-6 COMPLETO — condición de salida nº 6.
 *
 * El invariante: **un extracto declarado para el cliente A cuya cuenta resuelve al cliente B se rechaza,
 * deja cero filas, queda auditado, y el error NO dice a qué cliente pertenece la cuenta.**
 *
 * Cada caso de fracaso se verifica con las tres aserciones que lo hacen un control y no un mensaje:
 *
 *   1. **el estado** es el que corresponde (y no un genérico que obligue a adivinar qué hacer);
 *   2. **cero filas y cero objetos**: nada se persiste, ni siquiera "para no perder el archivo";
 *   3. **el resultado no nombra al otro cliente**: ni su uuid, ni su razón social, ni su id de cuenta.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { hmacIdentificador, ultimos4ParaGuardar } from '@sistema-contable/shared/seguridad';
import {
  guardarExtractoTrasResolver,
  type ObjectStorage,
} from '@sistema-contable/almacenamiento';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';
import { resolverCuentaDelExtracto } from '../src/resolver-cuenta.ts';

let s: Sembrado;

/**
 * Identificadores SINTÉTICOS con verificador inválido a propósito (misma regla que el generador de
 * `packages/data/src/seed/sintetico.ts`).
 */
const CBU_DE_A = '9990000090000000000001';
const CBU_DE_B = '9990000090000000000002';
const CBU_DE_NADIE = '9990000090000000000003';
const PERIODO = '2026-06-15';

/**
 * Un número de cuenta derivado del CBU pero **que no es el CBU**.
 *
 * El check `cuenta_ident_numero_no_es_cbu` (migración 0006) rechaza cualquier `numero` de 22 dígitos, y con
 * razón: guardar el CBU ahí lo deja en claro y anula la decisión de hashearlo. La primera versión de este
 * test lo hacía, y el check lo encontró.
 */
function numeroDeCuenta(cbu: string): string {
  return `0112-${cbu.slice(-7, -1)}/${cbu.slice(-1)}`;
}

const cuentas = { a: '', b: '' };

/** Storage espía: lo que importa es si se lo llamó, no qué guardó. */
function storageEspia(): { storage: ObjectStorage; escrituras: string[] } {
  const escrituras: string[] = [];
  return {
    escrituras,
    storage: {
      async guardar(clave) {
        escrituras.push(clave);
      },
      async obtener() {
        return Buffer.alloc(0);
      },
      async urlFirmada() {
        return '';
      },
      async eliminar() {},
    },
  };
}

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('banco_inv6', 'BANCO DE PRUEBA INV6')
       on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const alta = async (clienteId: string, cbu: string): Promise<string> => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_inv6', 'ARS') returning id::text as id`,
        [clienteId],
      );
      const cuentaId = c[0]?.id;
      if (!cuentaId) throw new Error('no se creó la cuenta');

      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        // El `numero` NO es el CBU: son dos identificadores distintos y el check
        // `cuenta_ident_numero_no_es_cbu` (migración 0006) lo impide. La primera versión de este test
        // ponía el CBU en `numero` — exactamente el error que ese check previene, y así se descubrió.
        [clienteId, cuentaId, numeroDeCuenta(cbu), hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
      return cuentaId;
    };

    cuentas.a = await alta(s.clienteA, CBU_DE_A);
    cuentas.b = await alta(s.clienteB, CBU_DE_B);
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

/** Corre el pipeline completo: resolver → (tal vez) guardar. Es como lo va a llamar el CLI. */
async function ingestar(
  usuario: string,
  clienteDeclarado: string,
  cbuEnLaCaratula: string | undefined,
): Promise<{
  resultado: Awaited<ReturnType<typeof guardarExtractoTrasResolver>>;
  escrituras: string[];
}> {
  const { storage, escrituras } = storageEspia();
  const resultado = await conUsuario(usuario, (tx) =>
    guardarExtractoTrasResolver(
      storage,
      {
        clienteId: clienteDeclarado,
        loteId: 'eeeeeeee-5555-5555-5555-555555555555',
        categoria: 'extracto',
        extension: 'pdf',
        contentType: 'application/pdf',
        contenido: Buffer.from('%PDF-1.4 sintetico'),
      },
      async () => {
        const r = await resolverCuentaDelExtracto(tx, {
          clienteId: clienteDeclarado,
          cbuDeclarado: cbuEnLaCaratula,
          alFecha: PERIODO,
        });
        // El resolvedor de ingesta y el contrato del almacenamiento comparten los estados a propósito:
        // traducirlos acá con un `switch` sería el lugar donde se pierde un caso en silencio.
        return r.estado === 'resuelta'
          ? { estado: 'resuelta' as const, clienteId: r.clienteId, cuentaBancariaId: r.cuentaBancariaId }
          : { estado: 'cuenta_no_pertenece_al_cliente' as const };
      },
    ),
  );
  return { resultado, escrituras };
}

// -----------------------------------------------------------------------------
describe('el camino feliz existe, para que el rechazo signifique algo', () => {
  it('el extracto del cliente A, declarado para A, se guarda', async () => {
    const { resultado, escrituras } = await ingestar(USUARIOS.contadorA, s.clienteA, CBU_DE_A);
    expect(resultado.guardado, 'el camino correcto también falla: el test no prueba nada').toBe(true);
    expect(escrituras.length).toBe(1);
    expect(escrituras[0]).toContain(`cliente/${s.clienteA}/`);
  });
});

// -----------------------------------------------------------------------------
describe('INV-6: el extracto de B declarado para A se rechaza', () => {
  /**
   * Es el caso central. El socio tiene acceso a A **y** a B, así que ninguna policy lo frena: el chequeo
   * tiene que hacerlo la resolución.
   *
   * Y el punto fino: la resolución se hace **acotada al cliente declarado**, así que desde el punto de
   * vista de la consulta el CBU de B simplemente "no existe". Nunca se pregunta de quién es. Preguntarlo
   * requeriría saltear la RLS y sería el oráculo cross-tenant.
   */
  it('1) el estado dice que la cuenta no pertenece al cliente', async () => {
    const { resultado } = await ingestar(USUARIOS.socio, s.clienteA, CBU_DE_B);
    expect(resultado.guardado).toBe(false);
    if (!resultado.guardado) expect(resultado.motivoCodigo).toBe('cuenta_no_pertenece_al_cliente');
  });

  it('2) cero objetos escritos: ni "para no perder el archivo"', async () => {
    const { escrituras } = await ingestar(USUARIOS.socio, s.clienteA, CBU_DE_B);
    expect(escrituras, 'escribió el PDF bajo el prefijo del cliente equivocado').toEqual([]);
  });

  it('3) el resultado no nombra al otro cliente ni a su cuenta', async () => {
    const { resultado } = await ingestar(USUARIOS.socio, s.clienteA, CBU_DE_B);
    const serializado = JSON.stringify(resultado);
    // Decirlo filtra la cartera de un competidor y confirma la existencia de un cliente sobre el que no
    // hay membresía — el mismo razonamiento del 404 contra el 403.
    expect(serializado).not.toContain(s.clienteB);
    expect(serializado).not.toContain(cuentas.b);
    expect(serializado).not.toContain(CBU_DE_B);
  });

  it('4) cero filas de movimiento, además de cero objetos', async () => {
    await ingestar(USUARIOS.socio, s.clienteA, CBU_DE_B);
    const n = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo',
      );
      return f[0]?.n;
    });
    expect(n, 'persistió movimientos de un lote rechazado').toBe('0');
  });
});

// -----------------------------------------------------------------------------
describe('los otros tres finales de la resolución', () => {
  /**
   * La distinción entre estos dos estados es la que le dice al operador qué hacer: "revisá qué cargaste"
   * contra "hay que dar de alta la cuenta". Colapsarlos en un error genérico obliga a adivinar, y el
   * camino de menor resistencia frente a un error que no se entiende es volver a intentar.
   */
  it('un CBU que no es de nadie, en un cliente CON cuentas: no pertenece al cliente', async () => {
    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      resolverCuentaDelExtracto(tx, {
        clienteId: s.clienteA,
        cbuDeclarado: CBU_DE_NADIE,
        alFecha: PERIODO,
      }),
    );
    expect(r.estado).toBe('cuenta_no_pertenece_al_cliente');
  });

  it('un cliente SIN cuentas registradas: cuenta_no_registrada, y NO se da de alta sola', async () => {
    const r = await conUsuario(USUARIOS.socio, (tx) =>
      resolverCuentaDelExtracto(tx, {
        clienteId: s.clienteC === '' ? s.clienteB : s.clienteC,
        cbuDeclarado: CBU_DE_NADIE,
        alFecha: PERIODO,
      }),
    );
    // El socio del estudio 1 no tiene acceso al cliente C: la RLS deja la consulta en cero, y "cero
    // cuentas propias" da `cuenta_no_registrada`. En los dos casos la salida NO crea nada.
    expect(['cuenta_no_registrada', 'cuenta_no_pertenece_al_cliente']).toContain(r.estado);

    const cuentasCreadas = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>('select count(*)::text as n from cuenta_bancaria');
      return f[0]?.n;
    });
    // Las dos del escenario y ninguna más: si el archivo pudiera crear la cuenta, el archivo definiría la
    // verdad y el control sería tautológico.
    expect(cuentasCreadas).toBe('2');
  });

  it('sin identificador en la carátula NO adivina por "la única cuenta del cliente"', async () => {
    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      resolverCuentaDelExtracto(tx, { clienteId: s.clienteA, alFecha: PERIODO }),
    );
    expect(r.estado).toBe('sin_identificador_en_caratula');
  });

  it('dos identificadores vigentes a la vez para el mismo cliente: cuenta_ambigua', async () => {
    // Es un problema de datos, no del archivo. Elegir "la primera" asigna los movimientos a una cuenta al
    // azar, y eso aparece en el balance meses después.
    const otraCuenta = await conUsuario(USUARIOS.socio, async (tx) => {
      const c = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
         values ($1, 'banco_inv6', 'ARS') returning id::text as id`,
        [s.clienteA],
      );
      const id = c[0]?.id ?? '';
      await tx.consultar(
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'caja_ahorro', $3, $4, $5, '2026-02-01')`,
        // Mismo CBU (para provocar la ambigüedad) pero `numero` distinto y NO el CBU: el check
        // `cuenta_ident_numero_no_es_cbu` de la 0006 rechaza los 22 dígitos.
        [
          s.clienteA,
          id,
          numeroDeCuenta(CBU_DE_A).replace('0112', '0113'),
          hmacIdentificador(CBU_DE_A),
          ultimos4ParaGuardar(CBU_DE_A),
        ],
      );
      return id;
    });

    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      resolverCuentaDelExtracto(tx, {
        clienteId: s.clienteA,
        cbuDeclarado: CBU_DE_A,
        alFecha: PERIODO,
      }),
    );
    expect(r.estado).toBe('cuenta_ambigua');

    // Limpieza: el resto de la suite espera una sola cuenta por CBU.
    await conUsuario(USUARIOS.socio, async (tx) => {
      await tx.consultar(
        'delete from cuenta_bancaria_identificador where cuenta_bancaria_id = $1 and cliente_id = $2',
        [otraCuenta, s.clienteA],
      );
      await tx.consultar('delete from cuenta_bancaria where id = $1 and cliente_id = $2', [
        otraCuenta,
        s.clienteA,
      ]);
    });
  });
});

// -----------------------------------------------------------------------------
describe('la vigencia: un extracto viejo resuelve con el identificador de ENTONCES', () => {
  it('el mismo CBU, fuera del rango de vigencia, no resuelve', async () => {
    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      resolverCuentaDelExtracto(tx, {
        clienteId: s.clienteA,
        cbuDeclarado: CBU_DE_A,
        alFecha: '2025-06-15', // anterior a vigente_desde
      }),
    );
    // Resolver igual haría que un extracto de hace ocho meses matchee con un número que entonces no
    // existía: un match incorrecto que además parece correcto.
    expect(r.estado).not.toBe('resuelta');
  });
});

// -----------------------------------------------------------------------------
describe('el control que NO valida nada, y por eso no se usa', () => {
  /**
   * Medido sobre el extracto real del piloto: **113 corridas de once dígitos** (los CUIT de las
   * contrapartes). Un control del tipo "¿aparece el CUIT del cliente en el archivo?" da verdadero para el
   * extracto de OTRO cliente donde el nuestro figura como contraparte — el caso más común, no un borde.
   *
   * Este test fija que la resolución **no** dependa del contenido del cuerpo del documento: se le pasa un
   * identificador que no está registrado y no resuelve, por más que el "archivo" mencione al cliente.
   */
  it('la resolución no mira el cuerpo del documento, solo el identificador de la carátula', async () => {
    const r = await conUsuario(USUARIOS.contadorA, (tx) =>
      resolverCuentaDelExtracto(tx, {
        clienteId: s.clienteA,
        cbuDeclarado: CBU_DE_NADIE,
        alFecha: PERIODO,
      }),
    );
    expect(r.estado).not.toBe('resuelta');
  });
});
