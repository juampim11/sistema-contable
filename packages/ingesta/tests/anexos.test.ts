/**
 * ANEXOS — el bloque que NO son movimientos, verificado contra la base real.
 *
 * ## Por qué estos tests existen, y por qué llegaron tarde
 *
 * `anexoExtractoSchema` estaba escrito desde el principio del módulo y **`persistirCuenta` nunca lo
 * tocaba**: el adaptador leía el bloque y la persistencia lo tiraba. No había ni una línea de código que lo
 * mencionara, así que no había nada que revisar — el dato desaparecía entre dos capas donde cada una daba
 * por sentado que la otra se ocupaba.
 *
 * Lo destapó correr los tres adaptadores contra los archivos reales:
 *
 * | Banco | `lineasNoInterpretadas` | `anexos` | Qué pasaba |
 * |---|---|---|---|
 * | uno | 47 | 0 | sus **9 renglones estaban en el residuo**: se veían |
 * | otro | 141 | 3 de 6 | capturaba unos y el resto se veía en el residuo |
 * | el tercero | **0** | **0** | **no estaban en ningún lado** |
 *
 * **El que mejor puntuaba en "líneas no interpretadas" era el que más perdía**, porque su adaptador no
 * reportaba lo que caía fuera de la región de tabla. De ahí la regla que sale de todo esto: el destino de
 * una línea es **qué es**, no **dónde está**.
 *
 * Y lo que se perdía no es decorativo: entre esos renglones está el **importe computable como pago a
 * cuenta**, que no existe como movimiento y **no es derivable de ellos**.
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cerrarConexiones, conUsuario } from '@sistema-contable/data';
import { hmacIdentificador, ultimos4ParaGuardar } from '@sistema-contable/shared/seguridad';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';
import { CAPACIDADES_SINTETICAS, extractoSintetico } from '../src/seed/extracto-sintetico.ts';
import { persistirCuenta } from '../src/persistir.ts';
import { verificarAritmetica } from '../src/verificacion/invariantes.ts';
import { anexoExtractoSchema, type AnexoExtracto, type CuentaConMovimientos } from '../src/esquema.ts';

let s: Sembrado;
const ids = { cuenta: '', cuenta2: '' };
const CBU = '9990000090000000000077';
const CBU2 = '9990000090000000000078';

/** Un anexo sintético coherente. Todo inventado: ni un valor sale de un archivo real. */
function anexo(sobrescribe: Partial<AnexoExtracto> = {}): AnexoExtracto {
  return {
    tipoFila: 'anexo',
    conceptoLiteral: 'TOTAL RETENCION IMPUESTO SOBRE CREDITOS',
    ordenEnLote: 1,
    atribucionCuenta: 'cuenta_unica_del_lote',
    periodoDesde: '2026-06-01',
    periodoHasta: '2026-06-30',
    periodoDato: 'publicado_completo',
    importeDeclarado: '1234.00',
    moneda: 'ARS',
    relacionConMovimientos: 'resume_movimientos_del_cuerpo',
    paginaPdf: 9,
    ...sobrescribe,
  };
}

function cuentaCon(anexos: readonly AnexoExtracto[], semilla = 31): CuentaConMovimientos {
  const base = extractoSintetico({
    semilla,
    cantidadMovimientos: 12,
    saldoInicialCentavos: 1_000_000n,
    periodoDesde: '2026-06-01',
    periodoHasta: '2026-06-30',
  });
  return { ...base, anexos: [...anexos] };
}

async function loteNuevo(marca: string): Promise<string> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const f = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
       values ($1, 'banco_anexo', 'sintetico@1', 'archivo', $2, 'recibido')
       returning id::text as id`,
      [s.clienteA, `hash_anexo_${marca}`],
    );
    const id = f[0]?.id;
    if (!id) throw new Error('no se creó el lote');
    return id;
  });
}

async function persistir(
  loteId: string,
  cuenta: CuentaConMovimientos,
  cuentaBancariaId = ids.cuenta,
): Promise<{ persistido: boolean; motivoCodigo?: string }> {
  return conUsuario(USUARIOS.socio, async (tx) => {
    const r = await persistirCuenta(tx, {
      clienteId: s.clienteA,
      loteId,
      cuentaBancariaId,
      cuenta,
      verificacion: verificarAritmetica(cuenta, { capacidades: CAPACIDADES_SINTETICAS }),
    });
    return r.persistido ? { persistido: true } : { persistido: false, motivoCodigo: r.motivoCodigo };
  });
}

type FilaAnexo = {
  readonly cuenta_bancaria_id: string | null;
  readonly atribucion_cuenta: string;
  readonly orden_en_lote: number;
  readonly concepto_literal: string;
  readonly periodo_desde: Date | null;
  readonly periodo_hasta: Date | null;
  readonly periodo_dato: string;
  readonly importe_declarado: string;
  readonly relacion_con_movimientos: string;
};

async function anexosDelLote(loteId: string): Promise<readonly FilaAnexo[]> {
  return conUsuario(USUARIOS.socio, async (tx) =>
    tx.consultar<FilaAnexo>(
      `select cuenta_bancaria_id::text as cuenta_bancaria_id, atribucion_cuenta, orden_en_lote,
              concepto_literal, periodo_desde, periodo_hasta, periodo_dato,
              importe_declarado::text as importe_declarado, relacion_con_movimientos
         from anexo_extracto
        where cliente_id = $1 and lote_ingesta_id = $2
        order by orden_en_lote`,
      [s.clienteA, loteId],
    ),
  );
}

beforeAll(async () => {
  s = await sembrar();

  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ('banco_anexo', 'BANCO DE PRUEBA ANEXOS', '{}'::jsonb)`,
    );
  } finally {
    await duenio.end();
  }

  await conUsuario(USUARIOS.socio, async (tx) => {
    const alta = async (alias: string, cbu: string, numero: string): Promise<string> => {
      const f = await tx.consultar<{ id: string }>(
        `insert into cuenta_bancaria (cliente_id, banco_codigo, moneda, alias)
         values ($1, 'banco_anexo', 'ARS', $2) returning id::text as id`,
        [s.clienteA, alias],
      );
      const id = f[0]?.id ?? '';
      await tx.consultar(
        // `numero` es el número de cuenta y NO el CBU: el check `cuenta_ident_numero_no_es_cbu` de la
        // migración 0006 rechaza cualquier valor de 22 dígitos.
        `insert into cuenta_bancaria_identificador
           (cliente_id, cuenta_bancaria_id, tipo_cuenta, numero, cbu_hmac, cbu_ultimos4, vigente_desde)
         values ($1, $2, 'cuenta_corriente', $3, $4, $5, '2026-01-01')`,
        [s.clienteA, id, numero, hmacIdentificador(cbu), ultimos4ParaGuardar(cbu)],
      );
      return id;
    };
    ids.cuenta = await alta('OPERATIVA ANEXOS', CBU, '0112-100077/0');
    ids.cuenta2 = await alta('OPERATIVA ANEXOS 2', CBU2, '0112-100078/0');
  });
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('el anexo se persiste, que es lo que antes no pasaba', () => {
  it('los renglones entran con sus tres vocabularios', async () => {
    const lote = await loteNuevo('feliz');
    const r = await persistir(
      lote,
      cuentaCon([
        anexo({ ordenEnLote: 1 }),
        anexo({
          ordenEnLote: 2,
          conceptoLiteral: 'IMPORTE SUSCEPTIBLE DE SER COMPUTADO CONTRA OTROS TRIBUTOS',
          // 🔴 El único candidato a registración: no existe como movimiento.
          relacionConMovimientos: 'no_esta_en_los_movimientos',
        }),
      ]),
    );
    expect(r.persistido).toBe(true);

    const filas = await anexosDelLote(lote);
    expect(filas).toHaveLength(2);
    expect(filas[0]?.relacion_con_movimientos).toBe('resume_movimientos_del_cuerpo');
    expect(filas[1]?.relacion_con_movimientos).toBe('no_esta_en_los_movimientos');
    expect(filas[0]?.periodo_dato).toBe('publicado_completo');
  });

  /**
   * El importe del anexo va a **su** tabla y no a la de movimientos. Es la separación estructural que
   * sostiene el invariante del doble conteo: sumar el anexo cuenta el impuesto dos veces **y el asiento
   * cuadra igual**, que es la peor clase de error de este dominio.
   */
  it('el importe del anexo NO entra en la tabla de movimientos', async () => {
    const lote = await loteNuevo('separado');
    await persistir(lote, cuentaCon([anexo({ importeDeclarado: '999999.00' })], 32));

    const enMovimientos = await conUsuario(USUARIOS.socio, async (tx) =>
      tx.consultar<{ n: string }>(
        `select count(*)::text as n from movimiento_bancario_crudo
          where cliente_id = $1 and lote_ingesta_id = $2 and abs(importe) = 999999.00`,
        [s.clienteA, lote],
      ),
    );
    expect(enMovimientos[0]?.n).toBe('0');

    const filas = await anexosDelLote(lote);
    expect(filas[0]?.importe_declarado).toBe('999999.00');
  });
});

// -----------------------------------------------------------------------------
describe('la atribución de cuenta: no se inventa de cuál es', () => {
  /**
   * `no_determinada` tiene que guardar `cuenta_bancaria_id` en **null**, aunque la persistencia esté
   * iterando una cuenta concreta. Es la tentación natural —"estoy en la cuenta X, se la pongo"— y sería
   * atribuir plata a una cuenta sobre la base de nada. La atribución del anexo a su cuenta **no es
   * posicional en ninguno de los tres bancos medidos**.
   */
  it('`no_determinada` guarda la cuenta en NULL, aunque se persista desde una cuenta', async () => {
    const lote = await loteNuevo('sin_cuenta');
    await persistir(lote, cuentaCon([anexo({ atribucionCuenta: 'no_determinada' })], 33));

    const filas = await anexosDelLote(lote);
    expect(filas[0]?.atribucion_cuenta).toBe('no_determinada');
    expect(filas[0]?.cuenta_bancaria_id).toBeNull();
  });

  it('`cuenta_unica_del_lote` sí guarda la cuenta', async () => {
    const lote = await loteNuevo('con_cuenta');
    await persistir(lote, cuentaCon([anexo({ atribucionCuenta: 'cuenta_unica_del_lote' })], 34));

    const filas = await anexosDelLote(lote);
    expect(filas[0]?.cuenta_bancaria_id).toBe(ids.cuenta);
  });

  /**
   * `cuenta_unica_del_lote` y `publicada_por_cuenta` son valores distintos a propósito: la evidencia es
   * distinta —aritmética del lote contra el banco diciéndolo—. Con un solo valor, el día que ese banco
   * mande un archivo de dos cuentas la deducción dejaría de valer **y sería invisible**.
   */
  it('los dos valores "con cuenta" son distintos y se conservan', async () => {
    const lote = await loteNuevo('dos_atribuciones');
    await persistir(
      lote,
      cuentaCon(
        [
          anexo({ ordenEnLote: 1, atribucionCuenta: 'cuenta_unica_del_lote' }),
          // Literal e importe distintos **a propósito**: dos renglones que difieren SOLO en la atribución
          // son, para el documento, el mismo renglón leído dos veces — y el índice
          // `uq_anexo_sin_doble_lectura` los rechaza. Lo comprobó este mismo test en su primera versión.
          anexo({
            ordenEnLote: 2,
            atribucionCuenta: 'publicada_por_cuenta',
            conceptoLiteral: 'TOTAL RETENCION IMPUESTO SOBRE DEBITOS',
            importeDeclarado: '2345.00',
          }),
        ],
        35,
      ),
    );
    const filas = await anexosDelLote(lote);
    expect(filas.map((f) => f.atribucion_cuenta)).toEqual([
      'cuenta_unica_del_lote',
      'publicada_por_cuenta',
    ]);
  });
});

// -----------------------------------------------------------------------------
describe('la detección de doble lectura', () => {
  /**
   * `uq_anexo_sin_doble_lectura` es un índice `nulls not distinct` sobre
   * `(cliente, lote, literal, período, importe, cuenta)`. **No es una clave natural** —el anexo no tiene—:
   * es detección de que el adaptador leyó el mismo renglón dos veces.
   *
   * El candidato natural es el renglón que **cruza el corte de página** en uno de los bancos: su etiqueta
   * queda en una hoja y su importe en la siguiente, después del encabezado repetido. `uq_anexo_orden` no lo
   * atraparía, porque el adaptador le daría dos ordinales distintos.
   *
   * El `nulls not distinct` es lo que lo hace servir: sin eso, las filas con `cuenta_bancaria_id` NULL —las
   * `no_determinada`, que son justamente las que se repiten— nunca colisionarían.
   */
  it('dos renglones idénticos en el mismo lote se rechazan', async () => {
    const lote = await loteNuevo('doble_lectura');
    await expect(
      persistir(
        lote,
        cuentaCon([anexo({ ordenEnLote: 1 }), anexo({ ordenEnLote: 2 })], 40),
      ),
    ).rejects.toThrow(/uq_anexo_sin_doble_lectura|ING_DUPLICADO/);
  });
});

// -----------------------------------------------------------------------------
describe('el ordinal es del LOTE, no de la cuenta', () => {
  /**
   * `uq_anexo_orden` es `(cliente_id, lote_ingesta_id, orden_en_lote)`. Si la persistencia recalculara el
   * ordinal por cuenta, dos cuentas del mismo lote con anexos colisionarían y el segundo insert **reventaría
   * la transacción entera**. Es un archivo, no dos.
   */
  it('dos cuentas del mismo lote con anexos no colisionan', async () => {
    const lote = await loteNuevo('dos_cuentas');

    const r1 = await persistir(lote, cuentaCon([anexo({ ordenEnLote: 1 })], 41), ids.cuenta);
    const r2 = await persistir(lote, cuentaCon([anexo({ ordenEnLote: 2 })], 42), ids.cuenta2);

    expect(r1.persistido).toBe(true);
    expect(r2.persistido).toBe(true);

    const filas = await anexosDelLote(lote);
    expect(filas.map((f) => f.orden_en_lote)).toEqual([1, 2]);
    expect(new Set(filas.map((f) => f.cuenta_bancaria_id)).size).toBe(2);
  });
});

// -----------------------------------------------------------------------------
describe('el período del anexo no se rellena con el del extracto', () => {
  /**
   * El bloque cubre **períodos distintos** del extracto — un banco publica tres—, y hay renglones que no
   * publican fechas. Rellenarlos con el período del lote sería **un hecho fiscal fabricado que cuadra**: la
   * misma clase de error que una cotización completada con la de hoy.
   */
  it('`no_publicado` guarda las dos fechas en NULL', async () => {
    const lote = await loteNuevo('sin_periodo');
    await persistir(
      lote,
      cuentaCon(
        [anexo({ periodoDato: 'no_publicado', periodoDesde: undefined, periodoHasta: undefined })],
        36,
      ),
    );
    const filas = await anexosDelLote(lote);
    expect(filas[0]?.periodo_desde).toBeNull();
    expect(filas[0]?.periodo_hasta).toBeNull();
    expect(filas[0]?.periodo_dato).toBe('no_publicado');
  });

  /**
   * `periodo_de_emision` **no es** `no_publicado`: acá el banco **declara** que el período es el del
   * extracto, sin imprimir las fechas. Las dos van sin fechas y el valor las distingue — porque quien las
   * resuelva después tiene que saber si está usando un dato del banco o inventando uno.
   */
  it('`periodo_de_emision` se distingue de `no_publicado`', async () => {
    const lote = await loteNuevo('emision');
    await persistir(
      lote,
      cuentaCon(
        [
          anexo({
            conceptoLiteral: 'TOTAL RETENCION REGIMEN DE RECAUDACION EN EL PERIODO DE EMISION',
            periodoDato: 'periodo_de_emision',
            periodoDesde: undefined,
            periodoHasta: undefined,
          }),
        ],
        37,
      ),
    );
    const filas = await anexosDelLote(lote);
    expect(filas[0]?.periodo_dato).toBe('periodo_de_emision');
    expect(filas[0]?.periodo_desde).toBeNull();
  });

  it('el esquema rechaza fechas incoherentes con `periodoDato`', () => {
    // `publicado_completo` sin fechas: el `refine` tiene el mismo predicado que el check de la base.
    const r = anexoExtractoSchema.safeParse({
      ...anexo(),
      periodoDato: 'publicado_completo',
      periodoDesde: undefined,
      periodoHasta: undefined,
    });
    expect(r.success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
describe('INV-14 aplicado al literal del anexo', () => {
  /**
   * Acá **no hay una `descripcion` de la cual ser prefijo**, así que la garantía no se hereda como en
   * `conceptoBanco`: se pone como **puerta de admisión**. Un anexo es un totalizador impositivo y no una
   * transacción —su contraparte es el fisco—, así que ningún literal medido lleva un identificador. Pero
   * "no hay caso medido" no es una garantía.
   *
   * Siete dígitos es la clase de identificador más corta del depurador: tapa documento (7-8), CUIT (11) y
   * CBU (22). En los literales medidos de los tres bancos la corrida más larga es de **5**.
   */
  it('un literal con una corrida de identificador NO se persiste', async () => {
    const lote = await loteNuevo('con_identificador');
    await expect(
      persistir(lote, cuentaCon([anexo({ conceptoLiteral: 'RETENCION A CUIT 20123456789 DEL PERIODO' })], 38)),
    ).rejects.toThrow(/anexo_literal_con_identificador/);
  });

  it('los literales de los tres bancos pasan', async () => {
    const lote = await loteNuevo('literales_ok');
    const literales = [
      'TOTAL RETENCION IMPUESTO LEY 25.413 SOBRE CREDITOS',
      'D. 409/2018 - IMPUESTO LEY 25413 COMPUTABLE CONTRA OTROS TRIBUTOS',
      'IVA PERCEP RG 2408 ALIC REDUCIDA',
      'IVA 10,5% REG TRANS FISC LEY 27743',
    ];
    const r = await persistir(
      lote,
      cuentaCon(
        literales.map((conceptoLiteral, i) => anexo({ conceptoLiteral, ordenEnLote: i + 1 })),
        39,
      ),
    );
    expect(r.persistido).toBe(true);
    expect(await anexosDelLote(lote)).toHaveLength(4);
  });
});

// -----------------------------------------------------------------------------
/**
 * INV-15 — EL CANARIO DEL DOBLE CONTEO. **Pendiente, y declarado para no omitirlo.**
 *
 * ## Qué protege
 *
 * *"Prohibido que el anexo entre en la suma de movimientos."* Si entra, **el impuesto queda contado dos
 * veces y el asiento cuadra igual** — la peor clase de error de este dominio, porque ninguna red aritmética
 * lo ve: los totales cierran, la cadena de saldos cierra, el consolidado por moneda cierra.
 *
 * Y no es hipotético. Medido en un banco del roster: su `Detalle impositivo` **resume los 21+19 movimientos
 * del impuesto al cheque y los 8 de SIRCREB que ya están en el cuerpo**, y su `Interés cobrado` también.
 *
 * ## Por qué no se puede escribir todavía, y por qué eso NO es una excusa
 *
 * El invariante es sobre **la exportación y la propuesta de asiento**, o sea el Módulo 2, que no existe. Un
 * test que lo probara contra la persistencia no probaría nada: hoy son dos tablas distintas y nadie las
 * suma. El sujeto del test todavía no está escrito.
 *
 * Lo que **sí** está hecho es lo que lo vuelve verificable el día que exista: `relacion_con_movimientos`
 * convierte una prohibición que nadie puede chequear en una **condición sobre una columna**. Sin ese campo,
 * este test no se podría escribir nunca.
 *
 * ## Las tres aserciones, y la tercera es la que importa
 *
 * Se declaran acá para que lleguen con el Módulo 2 y no se descubran después:
 *
 *   1. el total de impuestos del período == la suma de los **movimientos**, no la del anexo;
 *   2. el `importe_declarado` de todo anexo `resume_movimientos_del_cuerpo` **no aparece en ningún renglón**
 *      del resultado — serializando la salida a texto y buscándolo, como ya se hace con otros invariantes;
 *   3. 🔴 y el renglón `no_esta_en_los_movimientos` **SÍ aparece**.
 *
 * La tercera existe porque sin ella **el test se pasa no registrando nada**, que es el modo de falla clásico
 * de un canario: prohibir es fácil de cumplir de más. Es el mismo razonamiento por el que "0 movimientos
 * nunca es éxito".
 */
describe('INV-15 — el canario del doble conteo (llega con el Módulo 2)', () => {
  it.todo('el total de impuestos sale de los movimientos, no del anexo');
  it.todo('ningún importe de un anexo `resume_movimientos_del_cuerpo` aparece en el resultado');
  it.todo('el renglón `no_esta_en_los_movimientos` SÍ aparece — si no, el test se pasa no registrando nada');
});
