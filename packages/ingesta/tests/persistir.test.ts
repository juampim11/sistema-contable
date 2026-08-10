/**
 * PERSISTENCIA — "todo o nada", verificado contra la base real.
 *
 * La decisión que se verifica acá es de negocio, no técnica: **medio extracto es peor que ninguno**. La
 * contadora arma el asiento contra el saldo, y un lote parcial produce un asiento que cierra mal y que se
 * descubre al cierre de ejercicio — el dolor que originó el proyecto.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { hmacIdentificador, ultimos4ParaGuardar } from '@sistema-contable/shared/seguridad';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';
import { CAPACIDADES_SINTETICAS, extractoSintetico } from '../src/seed/extracto-sintetico.ts';
import { estadoSegunVerificacion, persistirCuenta } from '../src/persistir.ts';
import { verificarAritmetica } from '../src/verificacion/invariantes.ts';
import { contieneIdentificador } from '../src/glosa.ts';
import type { CuentaConMovimientos, Verificacion } from '../src/esquema.ts';

let s: Sembrado;
const ids = { cuentaA: '', loteA: '' };
const CBU = '9990000090000000000001';

/** Una cuenta sintética coherente: la cadena cierra y los totales coinciden. */
function cuentaSintetica(semilla: number, movimientos: number): CuentaConMovimientos {
  return extractoSintetico({
    semilla,
    cantidadMovimientos: movimientos,
    saldoInicialCentavos: 1_000_000n,
    periodoDesde: '2026-06-01',
    periodoHasta: '2026-06-30',
  });
}

function verificar(cuenta: CuentaConMovimientos): Verificacion {
  return verificarAritmetica(cuenta, { capacidades: CAPACIDADES_SINTETICAS });
}

/** Un lote nuevo por caso: dos casos sobre el mismo lote chocan con la unicidad de fila. */
async function loteNuevo(marca: string): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
       values ($1, 'banco_persist', 'sintetico@1', 'archivo', $2, 'recibido')
       returning id::text as id`,
      [s.clienteA, `hash_${marca}`],
    );
    const id = f[0]?.id;
    if (!id) throw new Error('no se creó el lote');
    /**
     * **El helper NO inserta `lote_ingesta_cuenta`**: eso lo hace `persistirCuenta`.
     *
     * La primera versión lo pre-insertaba "para satisfacer la FK de tres columnas del movimiento", y el
     * resultado fue `ING_DUPLICADO (uq_lote_cuenta_natural)`: la persistencia insertaba la segunda. El
     * error lo dio el traductor nuevo, legible y sin un solo dato — que es como se descubrió rápido.
     *
     * La FK se satisface igual, porque `persistirCuenta` inserta la fila de la cuenta **antes** que los
     * movimientos. Que el orden esté ahí y no acá es parte de lo que se está probando.
     */
    return id;
  });
}

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre) values ('banco_persist', 'BANCO DE PRUEBA PERSIST')
       on conflict (codigo) do nothing`,
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const c = await tx.consultar<{ id: string }>(
      `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda)
       values ($1, 'banco_persist', 'ARS') returning id::text as id`,
      [s.clienteA],
    );
    ids.cuentaA = c[0]?.id ?? '';
    await tx.consultar(
      `insert into cuenta_bancaria_identificador
         (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
       values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
      // `numero` es el número de cuenta, NO el CBU: el check de la 0006 lo impide.
      [s.clienteA, ids.cuentaA, '0112-100000/0', hmacIdentificador(CBU), ultimos4ParaGuardar(CBU)],
    );
  });

  ids.loteA = await loteNuevo('base');
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('el criterio de aceptación, como función pura', () => {
  const cuenta = cuentaSintetica(11, 30);

  it('`cuadra` → procesado', () => {
    const v = { ...verificar(cuenta), estado: 'cuadra' as const };
    const d = estadoSegunVerificacion(v, 30);
    expect(d.persistir).toBe(true);
    if (d.persistir) expect(d.estado).toBe('procesado');
  });

  /**
   * `no_verificable` no es `cuadra` y tampoco es un error: es "se leyó bien y el banco no publica con qué
   * comparar". Colapsarlo con `cuadra` haría que un extracto no verificado se vea igual que uno verificado.
   */
  it('`no_verificable` → procesado_con_observaciones, no `procesado`', () => {
    const v = { ...verificar(cuenta), estado: 'no_verificable' as const };
    const d = estadoSegunVerificacion(v, 30);
    expect(d.persistir).toBe(true);
    if (d.persistir) expect(d.estado).toBe('procesado_con_observaciones');
  });

  it('`no_cuadra` → NO se persiste, y el motivo es el código de la diferencia', () => {
    const v: Verificacion = {
      ...verificar(cuenta),
      estado: 'no_cuadra',
      diferencias: [
        { codigo: 'ARIT_TOTAL_CREDITOS', severidad: 'observacion' },
        { codigo: 'ARIT_CADENA_ROTA', severidad: 'error', filaNumero: 143 },
      ],
    };
    const d = estadoSegunVerificacion(v, 30);
    expect(d.persistir).toBe(false);
    // La de severidad `error`, no "la primera": si no, el operador lee una observación como motivo del
    // rechazo y busca el problema en el lugar equivocado.
    if (!d.persistir) expect(d.motivoCodigo).toBe('ARIT_CADENA_ROTA');
  });

  it('cero movimientos NUNCA se persiste, ni siquiera si la verificación dice `cuadra`', () => {
    const v = { ...verificar(cuenta), estado: 'cuadra' as const };
    const d = estadoSegunVerificacion(v, 0);
    expect(d.persistir).toBe(false);
    if (!d.persistir) expect(d.motivoCodigo).toBe('sin_movimientos');
  });
});

// -----------------------------------------------------------------------------
describe('el camino feliz: se persiste todo', () => {
  it('inserta la cuenta del lote, los movimientos y sus filas crudas', async () => {
    const cuenta = cuentaSintetica(21, 40);
    const v = verificar(cuenta);
    expect(v.estado, 'el fixture sintético no cuadra: el test no prueba nada').toBe('cuadra');

    const lote = await loteNuevo('feliz');
    const r = await conUsuario(USUARIOS.socio, (tx) =>
      persistirCuenta(tx, {
        clienteId: s.clienteA,
        loteId: lote,
        cuentaBancariaId: ids.cuentaA,
        cuenta,
        verificacion: v,
      }),
    );

    expect(r.persistido).toBe(true);
    if (r.persistido) {
      expect(r.estado).toBe('procesado');
      expect(r.filas).toBe(40);
    }

    const conteos = await conUsuario(USUARIOS.socio, async (tx) => {
      const m = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo where lote_ingesta_id = $1',
        [lote],
      );
      const o = await tx.consultar<{ n: string }>(
        `select count(*)::text as n from movimiento_origen_crudo o
           join movimiento_bancario_crudo m on m.id = o.movimiento_id
          where m.lote_ingesta_id = $1`,
        [lote],
      );
      return { movimientos: m[0]?.n, origen: o[0]?.n };
    });

    expect(conteos.movimientos).toBe('40');
    // Una fila cruda por movimiento: si falta alguna, ese movimiento no se puede reinterpretar nunca más.
    expect(conteos.origen).toBe('40');
  });

  it('la `descripcion` persistida NO lleva identificadores (INV-13 en el camino real)', async () => {
    const descripciones = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ descripcion: string }>(
        'select descripcion from movimiento_bancario_crudo where cliente_id = $1',
        [s.clienteA],
      );
      return f.map((x) => x.descripcion);
    });

    expect(descripciones.length).toBeGreaterThan(0);
    for (const d of descripciones) {
      expect(contieneIdentificador(d), `identificador en la descripción: ${d}`).toBe(false);
    }
  });

  it('el detalle de la verificación no lleva ni un IMPORTE', async () => {
    const detalle = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ d: unknown }>(
        'select verificacion_detalle as d from lote_ingesta_cuenta where cliente_id = $1 limit 1',
        [s.clienteA],
      );
      return JSON.stringify(f[0]?.d ?? {});
    });

    // Códigos, severidades y números de fila. Ningún valor: el diagnóstico no puede ser el canal de fuga.
    expect(detalle).not.toMatch(/\d{1,3}(?:\.\d{3})+,\d{2}/);
    expect(detalle).toContain('chequeos');
  });
});

// -----------------------------------------------------------------------------
describe('todo o nada: `no_cuadra` deja CERO filas', () => {
  /**
   * Es el test central del criterio. Un lote parcial con estado `procesado` no tiene a nadie mirándolo, y el
   * asiento armado contra un saldo incompleto cierra mal — pero cierra, así que pasa la revisión.
   */
  it('con la verificación en `no_cuadra` no se escribe ni una fila', async () => {
    const cuenta = cuentaSintetica(31, 25);
    const lote = await loteNuevo('nocuadra');

    const r = await conUsuario(USUARIOS.socio, (tx) =>
      persistirCuenta(tx, {
        clienteId: s.clienteA,
        loteId: lote,
        cuentaBancariaId: ids.cuentaA,
        cuenta,
        verificacion: {
          ...verificar(cuenta),
          estado: 'no_cuadra',
          diferencias: [{ codigo: 'ARIT_CADENA_ROTA', severidad: 'error', filaNumero: 7 }],
        },
      }),
    );

    expect(r.persistido).toBe(false);

    const n = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo where lote_ingesta_id = $1',
        [lote],
      );
      return f[0]?.n;
    });
    expect(n, 'persistió filas de un lote que no cuadra').toBe('0');
  });

  /**
   * El caso peligroso: la transacción muere **a mitad** de la inserción. Se simula con una violación de
   * unicidad (el mismo `filaHash` dos veces en la misma cuenta), que es exactamente lo que pasaría si el
   * adaptador produjera dos filas idénticas.
   */
  it('si la inserción falla a mitad de camino, la transacción revierte TODO', async () => {
    const cuenta = cuentaSintetica(41, 20);
    const lote = await loteNuevo('mitad');

    // Se duplica el hash de la primera fila en la última: la inserción va a fallar cerca del final.
    const primera = cuenta.movimientos[0];
    const conDuplicado: CuentaConMovimientos = {
      ...cuenta,
      movimientos: cuenta.movimientos.map((m, i) =>
        i === cuenta.movimientos.length - 1 && primera
          ? { ...m, filaHash: primera.filaHash }
          : m,
      ),
    };

    await expect(
      conUsuario(USUARIOS.socio, (tx) =>
        persistirCuenta(tx, {
          clienteId: s.clienteA,
          loteId: lote,
          cuentaBancariaId: ids.cuentaA,
          cuenta: conDuplicado,
          verificacion: { ...verificar(cuenta), estado: 'cuadra' },
        }),
      ),
    ).rejects.toThrow();

    const n = await conUsuario(USUARIOS.socio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo where lote_ingesta_id = $1',
        [lote],
      );
      return f[0]?.n;
    });
    // Las 19 primeras filas entraron y la 20 falló: sin transacción quedarían 19. El rollback las saca.
    expect(n, 'quedaron filas de una inserción que falló a mitad de camino').toBe('0');
  });
});

// -----------------------------------------------------------------------------
describe('el aislamiento se mantiene en el camino de escritura', () => {
  it('los movimientos quedan con el cliente_id correcto y nadie más los ve', async () => {
    const delOtroEstudio = await conUsuario(USUARIOS.socioOtroEstudio, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo',
      );
      return f[0]?.n;
    });
    expect(delOtroEstudio).toBe('0');
  });

  it('el contador del cliente B no ve los movimientos del cliente A', async () => {
    const n = await conUsuario(USUARIOS.contadorB, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo',
      );
      return f[0]?.n;
    });
    expect(n).toBe('0');
  });
});
