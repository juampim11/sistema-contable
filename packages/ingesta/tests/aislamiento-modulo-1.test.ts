/**
 * AISLAMIENTO DEL MÓDULO 1, MEDIDO SOBRE EL PIPELINE REAL — INV-6 / ADR-0002 §C.
 *
 * ## Qué agrega esto sobre lo que ya existe, y por qué no alcanzaba
 *
 * Hay tres capas de verificación de aislamiento en el repo y ninguna cubre lo que cubre ésta:
 *
 * | Archivo | Qué mide | Su punto ciego |
 * |---|---|---|
 * | `packages/data/tests/catalogo.test.ts` | la **estructura**: RLS forzada, predicado canónico, FK compuestas | una policy impecable **aplicada a la tabla equivocada** se ve idéntica desde el catálogo |
 * | `packages/data/tests/aislamiento-ingesta.test.ts` | el **comportamiento**, con filas puestas con `insert` a mano | lo que prueba es la policy, no el camino que de verdad escribe: si `persistirCuenta` pasara el `clienteId` equivocado, ese test seguiría verde |
 * | `packages/ingesta/tests/inv6-resolucion.test.ts` | la **resolución** de la cuenta antes de escribir | corta antes de que exista una sola fila; no dice nada de lo que quedó guardado |
 *
 * Acá las filas de los dos clientes entran **por `persistirCuenta` dentro de `conUsuario()`**, que es
 * literalmente lo que corre `apps/cli/src/ingestar.ts`, y con la identidad de un usuario que **solo tiene
 * membresía en su cliente** (`contadorA` / `contadorB`) — no con el socio del estudio, que ve los dos y por
 * lo tanto no puede fallar. Después se barre **toda** tabla con `cliente_id`, en las dos direcciones.
 *
 * ## Los dos modos de falla que este archivo existe para evitar
 *
 *   1. 🔴 **El test que pasa porque no cargó nada.** Un bug que dejara al cliente B sin filas daría "0 filas
 *      de B" y el barrido diría verde. Por eso el barrido va **acompañado** de la verificación del
 *      verificador (`describe` nº 2): el dueño del esquema —que acá es superusuario y por lo tanto ignora la
 *      RLS— cuenta las filas de B y tienen que ser **exactamente** las que el pipeline escribió. El "0" del
 *      barrido significa RLS solo porque ese conteo dice que las filas están.
 *   2. 🔴 **La tabla futura que nadie agrega al barrido.** La lista de tablas **no está escrita a mano**: se
 *      deriva del catálogo de Postgres por "tiene columna `cliente_id`". Una tabla nueva del Módulo 2 entra
 *      al barrido sola, y si además no la carga el escenario ni figura en las exclusiones documentadas, el
 *      `describe` nº 1 se pone rojo y obliga a decidir. Es el mismo criterio con el que `catalogo.test.ts`
 *      deriva de `CLASIFICACION` en vez de mantener una lista paralela.
 *
 * ## Datos
 *
 * Todo sintético y generado desde `extracto-sintetico.ts`: ni un valor sale de un archivo real, y los CBU
 * llevan **verificador inválido a propósito** (un identificador sintético con verificador válido puede
 * pertenecerle a un contribuyente real — ADR-0002 §F.1).
 *
 * Requisito previo: pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  altaDeCuentaBancaria,
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  type Tx,
} from '@sistema-contable/data';
import {
  CLASIFICACION,
  tablasConColumnaTenant,
  type NombreTabla,
} from '@sistema-contable/shared/seguridad';
import { clienteDuenio, sembrar, USUARIOS, type Sembrado } from '../../data/tests/ayuda.ts';
import { CAPACIDADES_SINTETICAS, extractoSintetico } from '../src/seed/extracto-sintetico.ts';
import { persistirCuenta } from '../src/persistir.ts';
import { verificarAritmetica } from '../src/verificacion/invariantes.ts';
import type { AnexoExtracto, CuentaConMovimientos } from '../src/esquema.ts';

const BANCO = 'banco_aisl';
const PERIODO_DESDE = '2026-06-01';
const PERIODO_HASTA = '2026-06-30';

/**
 * CBU y número **sintéticos**, con dígito verificador inválido a propósito.
 *
 * Los dos clientes llevan identificadores **distintos**: el caso del mismo CBU en dos clientes ya lo cubre
 * `inv6-resolucion.test.ts` y repetirlo acá solo agregaría tiempo de corrida.
 */
const CBU = { A: '9990000090000000000101', B: '9990000090000000000102' } as const;
const NUMERO = { A: '0112-100101/0', B: '0112-100102/0' } as const;

/**
 * **Cantidades distintas a propósito.** Con 11 y 7 movimientos, un bug que intercambiara los dos clientes
 * —o que escribiera las filas de B bajo el `cliente_id` de A— produce números que no cierran. Con la misma
 * cantidad en los dos lados, ese intercambio es invisible.
 */
const MOVIMIENTOS = { A: 11, B: 7 } as const;

type Lado = 'A' | 'B';

type Escenario = {
  /** Se completa en el `beforeAll`, con el uuid que devuelve la siembra. */
  clienteId: string;
  readonly usuario: string;
  cuentaId: string;
  loteId: string;
  /** Id de un movimiento concreto, para el caso "ni conociendo el uuid". */
  movimientoId: string;
};

const lados: Record<Lado, Escenario> = {
  A: { clienteId: '', usuario: USUARIOS.contadorA, cuentaId: '', loteId: '', movimientoId: '' },
  B: { clienteId: '', usuario: USUARIOS.contadorB, cuentaId: '', loteId: '', movimientoId: '' },
};

let s: Sembrado;

// -----------------------------------------------------------------------------
// Derivación de la lista de tablas — el corazón del barrido
// -----------------------------------------------------------------------------

/**
 * Tablas del esquema `public` que llevan `cliente_id`, **leídas del catálogo de Postgres**.
 *
 * Se deriva de `pg_attribute` y no de una lista escrita a mano ni de `CLASIFICACION`: el catálogo es lo que
 * de verdad hay en la base, así que una tabla creada por una migración futura aparece acá **sin que nadie
 * se acuerde de agregarla**. `CLASIFICACION` se usa después como contraste (ver el primer `it`), no como
 * fuente: si las dos divergen, queremos verlo, y para eso tienen que ser dos mediciones independientes.
 *
 * El `not like '\_%'` saca las tablas internas del aplicador de migraciones, igual que en
 * `catalogo.test.ts`.
 */
async function tablasConClienteId(duenio: Client): Promise<readonly string[]> {
  const { rows } = await duenio.query<{ tabla: string }>(
    `select c.relname as tabla
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid
      where c.relkind = 'r' and n.nspname = 'public'
        and a.attnum > 0 and not a.attisdropped and a.attname = 'cliente_id'
        and c.relname not like '\\_%'
      order by 1`,
  );
  return rows.map((f) => f.tabla);
}

/**
 * Tablas con `cliente_id` que **no** son del Módulo 1, con el motivo escrito.
 *
 * Existe para que el barrido las cubra igual (van al conteo de "0 filas del otro cliente") pero no se les
 * exija tener filas cargadas por el pipeline de ingesta. Sin este registro, la única alternativa sería
 * bajar la exigencia del `describe` nº 2 a "alguna tabla tiene filas", que es exactamente el "mayor que
 * cero" que deja pasar un escenario que no cargó nada.
 */
const FUERA_DEL_MODULO_1: Readonly<Record<string, string>> = {
  acceso_auditoria:
    'Rastro append-only de 0001: lo escribe el choke point de auditoría, no la ingesta. Su aislamiento ' +
    'lo cubre packages/data/tests/aislamiento.test.ts.',
  credencial_fiscal:
    'N3 de 0002: material de AFIP. No hay ni una línea del Módulo 1 que la toque, y su lectura exige ' +
    'socio (aislamiento.test.ts).',
  credencial_fiscal_rotacion:
    'Bitácora de rotación de 0002, misma razón que credencial_fiscal.',
  movimiento_contraparte_identificador:
    'Tabla del Módulo 2 (migración 0013). `persistirCuenta` la escribe (el candidato se calcula en el ' +
    'momento de ingerir), pero su cobertura de aislamiento propia vive en ' +
    'packages/data/tests/aislamiento-modulo-2.test.ts — excluirla acá sin esa cobertura sería el ' +
    '"arreglo tentador y equivocado" que dba-data señaló al revisar 0013.',
  padron_socio:
    'Tabla del Módulo 2 (0013). El pipeline de este escenario no la escribe (no hay alta de socio en la ' +
    'ingesta). Cobertura de aislamiento en aislamiento-modulo-2.test.ts.',
  padron_socio_documento:
    'Satélite N2-R del padrón de socios (0013), misma razón que padron_socio.',
  reconocimiento_movimiento:
    'Tabla del Módulo 2 (migración 0014): el resultado del motor. La ingesta NO la escribe — el ' +
    'motor corre después, sobre movimientos ya persistidos, y es lo que separa "qué dice el ' +
    'documento" (Módulo 1) de "qué significa" (Módulo 2). Cobertura de aislamiento propia en ' +
    'packages/data/tests/aislamiento-modulo-2.test.ts.',
  reconocimiento_candidato:
    'Satélite 0..N de reconocimiento_movimiento (0014), misma razón que su padre.',
  padron_manifestacion:
    'Tabla del Módulo 2 (migración 0021): la declaración de que el padrón de socios está completo. ' +
    'La ingesta no la toca —es una premisa que carga una persona, no un dato que salga de un ' +
    'extracto— y hoy NO TIENE PRODUCTOR: reconocer-lote.ts:288 pasa el gate en false fijo, así que ' +
    'nace vacía a propósito. Cobertura de aislamiento en aislamiento-modulo-2.test.ts.',
  reconocimiento_contrapartida:
    'Tabla del Módulo 2 (migración 0021): qué resolvió capa C sobre un movimiento. Misma razón que ' +
    'reconocimiento_movimiento — la escribe el motor, que corre después de la ingesta.',
  reconocimiento_contrapartida_match:
    'Satélite 0..N de reconocimiento_contrapartida (0021), misma razón que su padre.',
  // --- Capa D, migración 0027 (HANDOFF 129/130) — el cierre mensual. Ninguna de las once la escribe
  // la ingesta bancaria: todas nacen DESPUÉS de que un extracto ya se ingirió, o son el plan de
  // cuentas del cliente (un dato de configuración, no un hecho que salga de un banco).
  cierre_cliente_periodo:
    'Tabla de Capa D (migración 0027): la entidad central del cierre mensual. Nace cuando arranca el ' +
    'proceso de cierre de un período, después de que los documentos del período ya se ingirieron — no ' +
    'es algo que la ingesta bancaria escriba. Cobertura de aislamiento propia en ' +
    'packages/data/tests/aislamiento-0027.test.ts.',
  cierre_transicion:
    'Satélite append-only de cierre_cliente_periodo (0027): cada cambio de estado del cierre, con ' +
    'hecho_por/hecho_via. Misma razón que su padre — la ingesta no la toca.',
  expectativa_fuente_cliente:
    'Tabla de Capa D (0027): qué documentos espera el estudio de cada cliente (declarados o ' +
    'inferidos) — la premisa del gate de confirmación de D-24. Es una declaración que carga una ' +
    'persona o se infiere, no un dato que salga de un extracto. La ingesta no la escribe.',
  fuente_cierre:
    'Tabla de Capa D (0027): vincula un documento_ingerido/expectativa con un cierre puntual y su ' +
    'estado de cuadratura. Se llena cuando el cierre se arma, no cuando la ingesta corre.',
  pendiente_cierre:
    'Tabla de Capa D (0027): la cola de pendientes que bloquea la confirmación de un cierre (D-24). ' +
    'La ingesta no la escribe — nace del proceso de cierre, no del proceso de ingerir un extracto.',
  pendiente_dispensa:
    'Satélite append-only de pendiente_cierre (0027, D-14): el motivo por el que un socio dispensó un ' +
    'pendiente. Misma razón que su padre.',
  cuenta:
    'Tabla de Capa D (0027): identidad estable de una cuenta del plan de cuentas de un cliente. La ' +
    'llena el adaptador de plan de cuentas (packages/ingesta/src/plan-cuentas/, HANDOFF 129), un ' +
    'proceso de configuración del cliente — nunca el pipeline de ingesta bancaria del Módulo 1.',
  cuenta_atributo:
    'Satélite versionado de cuenta (0027): denominación, jerarquía, rol_funcional. Misma razón que ' +
    'cuenta — la llena el adaptador de plan de cuentas, no la ingesta bancaria.',
  asiento_propuesto:
    'Tabla de Capa D (0027): la propuesta de asiento que arma el motor de conciliación DESPUÉS de que ' +
    'la ingesta corrió — es el resultado de clasificar movimientos ya persistidos, mismo criterio que ' +
    'reconocimiento_movimiento (Módulo 2): la ingesta no la escribe, el motor corre después.',
  asiento_propuesto_renglon:
    'Satélite de asiento_propuesto (0027): misma razón que su padre — lo escribe el motor de ' +
    'conciliación, no la ingesta.',
  // 🔴 Distinta de las diez de arriba: esta SÍ está pensada para conectarse al Módulo 1 en el futuro
  // — no es "nunca la llena Módulo 1", es "todavía no". Ver D-17 de
  // docs/diseno/25-segunda-convocatoria-cierre-mensual.md y B.7 de docs/diseno/10-deuda-declarada.md
  // (el backfill está bloqueado por la semántica de periodo_desde/periodo_hasta en documentos
  // multi-cuenta, no por falta de interés). El día que esa conexión exista, esta tabla sale de acá y
  // pasa a tener su propia cobertura medida contra el pipeline real, como las demás.
  documento_ingerido:
    'Tabla de Capa D (0027): la evidencia de un documento ya ingerido, para cruzar contra ' +
    'expectativa_fuente_cliente. HOY vacía — el pipeline del Módulo 1 no la escribe todavía, el ' +
    'backfill contra los adaptadores existentes está bloqueado por B.7 de 10-deuda-declarada.md — ' +
    'pero la conexión futura está pendiente y declarada (D-17 de 25-segunda-convocatoria-cierre-' +
    'mensual.md), no descartada. Revisar este motivo el día que esa conexión se implemente.',
  // --- Capa D, migración 0030 (Ítem E de Sesión 2b, D-29) — llegó después que las once de 0027.
  regla_imputacion:
    'Tabla de Capa D (migración 0030, D-29): reglas de imputación por cliente que decide el ' +
    'contador/socio (tipo_movimiento[, concepto] → cuenta_id) — dato de configuración, misma ' +
    'categoría que cuenta/cuenta_atributo. La ingesta bancaria nunca la escribe; la carga o el ' +
    'motor de conciliación (packages/motor-conciliacion) la LEE, corriendo después de que la ' +
    'ingesta ya persistió el movimiento. Cobertura de aislamiento propia en ' +
    'packages/data/tests/mutaciones-0030-regla-imputacion.test.ts.',
};

/** Las tablas que el pipeline de ingesta **tiene que** haber llenado en los dos clientes. */
function tablasDelModulo1(todas: readonly string[]): readonly string[] {
  return todas.filter((t) => FUERA_DEL_MODULO_1[t] === undefined);
}

/**
 * Cuenta las filas de `clienteId` en cada tabla, con el ejecutor que se le pase.
 *
 * El nombre de tabla se interpola porque un identificador no puede ir como parámetro. Viene del catálogo
 * —o sea que no hay entrada de usuario en juego— pero se valida igual: un helper que interpola sin mirar es
 * el que alguien reusa mañana con un valor que sí viene de afuera.
 */
async function contarPorTabla(
  consultar: (sql: string, parametros: readonly unknown[]) => Promise<readonly { n: string }[]>,
  tablas: readonly string[],
  clienteId: string,
): Promise<Record<string, number>> {
  const salida: Record<string, number> = {};
  for (const tabla of tablas) {
    if (!/^[a-z][a-z0-9_]*$/.test(tabla)) throw new Error(`nombre de tabla inesperado: ${tabla}`);
    const filas = await consultar(
      `select count(*)::text as n from "${tabla}" where cliente_id = $1`,
      [clienteId],
    );
    salida[tabla] = Number(filas[0]?.n ?? '-1');
  }
  return salida;
}

/** Envuelve un `Client` de `pg` para que tenga la misma forma que `Tx.consultar`. */
function comoConsultar(duenio: Client) {
  return async (sql: string, parametros: readonly unknown[]): Promise<readonly { n: string }[]> => {
    const { rows } = await duenio.query<{ n: string }>(sql, parametros as unknown[]);
    return rows;
  };
}

/** El barrido completo visto por un usuario de la aplicación (sujeto a RLS). */
async function contarComoUsuario(
  usuario: string,
  tablas: readonly string[],
  clienteId: string,
): Promise<Record<string, number>> {
  return conUsuario(usuario, async (tx: Tx) =>
    contarPorTabla((sql, p) => tx.consultar<{ n: string }>(sql, p), tablas, clienteId),
  );
}

/** Un objeto con la misma forma que el barrido, todo en cero: es contra lo que se compara. */
function todoEnCero(tablas: readonly string[]): Record<string, number> {
  return Object.fromEntries(tablas.map((t) => [t, 0]));
}

// -----------------------------------------------------------------------------
// Escenario
// -----------------------------------------------------------------------------

/** Un anexo sintético coherente. Sin identificadores en el literal (INV-14). */
function anexo(): AnexoExtracto {
  return {
    tipoFila: 'anexo',
    conceptoLiteral: 'TOTAL RETENCION IMPUESTO SOBRE CREDITOS',
    ordenEnLote: 1,
    atribucionCuenta: 'cuenta_unica_del_lote',
    periodoDesde: PERIODO_DESDE,
    periodoHasta: PERIODO_HASTA,
    periodoDato: 'publicado_completo',
    importeDeclarado: '1234.00',
    moneda: 'ARS',
    relacionConMovimientos: 'resume_movimientos_del_cuerpo',
    paginaPdf: 4,
  };
}

function cuentaSintetica(semilla: number, cantidadMovimientos: number): CuentaConMovimientos {
  const base = extractoSintetico({
    semilla,
    cantidadMovimientos,
    saldoInicialCentavos: 1_000_000n,
    periodoDesde: PERIODO_DESDE,
    periodoHasta: PERIODO_HASTA,
  });
  return { ...base, anexos: [anexo()] };
}

/**
 * Carga un cliente **entero por el camino real**: alta de cuenta auditada, lote, y `persistirCuenta`.
 *
 * Todo corre bajo `conUsuario(<el contador de ese cliente>)`, que es un usuario **sin acceso al otro**.
 * Es la diferencia con `aislamiento-ingesta.test.ts`, que siembra con el socio del estudio: acá, si el
 * pipeline escribiera con el `clienteId` equivocado, la policy de escritura lo rechazaría y el `beforeAll`
 * se caería — o sea que el escenario mismo es parte del control.
 */
async function cargar(lado: Lado, semilla: number): Promise<void> {
  const e = lados[lado];

  const alta = await conUsuario(e.usuario, (tx) =>
    escribirConAuditoria(
      tx,
      { clienteId: e.clienteId, accion: 'escritura', recurso: 'cuenta_bancaria_identificador' },
      (ctx) =>
        altaDeCuentaBancaria(tx, ctx, {
          clienteId: e.clienteId,
          bancoCodigo: BANCO,
          moneda: 'ARS',
          alias: `OPERATIVA ${lado}`,
          tipoCuenta: 'cuenta_corriente',
          numero: NUMERO[lado],
          cbu: CBU[lado],
          vigenteDesde: '2026-01-01',
        }),
    ),
  );
  e.cuentaId = alta.cuentaBancariaId;

  e.loteId = await conUsuario(e.usuario, async (tx) => {
    // Mismo `insert` que hace `apps/cli/src/ingestar.ts` en su paso 4: el lote es el ancla de todo lo que
    // sigue, incluido el rechazo, así que nace antes de leer una sola fila.
    const f = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, procesado_por)
       values ($1, $2, 'sintetico@1', 'archivo', $3, 'recibido', app.current_user_id())
       returning id::text as id`,
      [e.clienteId, BANCO, `hash_aisl_${lado}`],
    );
    const id = f[0]?.id;
    if (!id) throw new Error(`no se creó el lote de ${lado}`);
    return id;
  });

  const cuenta = cuentaSintetica(semilla, MOVIMIENTOS[lado]);

  const resultado = await conUsuario(e.usuario, (tx) =>
    persistirCuenta(tx, {
      clienteId: e.clienteId,
      loteId: e.loteId,
      cuentaBancariaId: e.cuentaId,
      cuenta,
      // La verificación llega **ya calculada**: quien lee no puede ser quien certifica (persistir.ts).
      verificacion: verificarAritmetica(cuenta, { capacidades: CAPACIDADES_SINTETICAS }),
    }),
  );
  if (!resultado.persistido) {
    throw new Error(`el escenario de ${lado} no persistió: ${resultado.motivoCodigo}`);
  }

  e.movimientoId = await conUsuario(e.usuario, async (tx) => {
    const f = await tx.consultar<{ id: string }>(
      `select id::text as id from movimiento_bancario_crudo
        where cliente_id = $1 and lote_ingesta_id = $2 order by fila_numero limit 1`,
      [e.clienteId, e.loteId],
    );
    return f[0]?.id ?? '';
  });
}

let TABLAS: readonly string[] = [];
let TABLAS_M1: readonly string[] = [];

beforeAll(async () => {
  s = await sembrar();
  lados.A.clienteId = s.clienteA;
  lados.B.clienteId = s.clienteB;

  // `banco` es N0 y no lleva tenant: su escritura es de la migración o del alta de un adapter, no de la
  // aplicación. Por eso lo siembra el dueño del esquema y no un usuario.
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      `insert into banco (codigo, nombre, capacidades)
       values ($1, 'BANCO DE PRUEBA AISLAMIENTO', '{"cadenaDeSaldos": true}'::jsonb)`,
      [BANCO],
    );
    TABLAS = await tablasConClienteId(duenio);
    TABLAS_M1 = tablasDelModulo1(TABLAS);
  } finally {
    await duenio.end();
  }

  // Semillas distintas: dos extractos distintos, para que ninguna aserción pueda cerrar por casualidad.
  await cargar('A', 101);
  await cargar('B', 202);
});

afterAll(async () => {
  await cerrarConexiones();
});

// -----------------------------------------------------------------------------
describe('1 — la lista de tablas se DERIVA, para que una tabla futura entre sola', () => {
  /**
   * Dos mediciones independientes del mismo conjunto: el catálogo de Postgres y el registro de
   * clasificación (`packages/shared/src/seguridad/clasificacion-campos.ts`). Que coincidan es lo que
   * permite confiar en la derivación; que se comparen **acá** es lo que hace que una divergencia se vea
   * como un problema de aislamiento y no solo como un registro desactualizado.
   */
  it('el catálogo y el registro de clasificación describen el mismo conjunto', () => {
    const delRegistro = tablasConColumnaTenant()
      .filter((t: NombreTabla) => CLASIFICACION[t].columnaTenant === 'cliente_id')
      .slice()
      .sort();
    expect([...TABLAS].sort()).toEqual(delRegistro);
  });

  /**
   * 🔴 El control que obliga a decidir. Si una migración futura agrega una tabla con `cliente_id`, esta
   * aserción se pone roja hasta que alguien la cargue en el escenario o la declare en `FUERA_DEL_MODULO_1`
   * con el motivo escrito. No hay una tercera opción, que es el punto: la tabla que "se olvidó" es
   * exactamente la que queda legible para todos los tenants (ADR-0001 §8.5).
   */
  it('toda tabla con cliente_id está o cargada por el escenario o excluida con motivo', () => {
    const excluidasQueNoExisten = Object.keys(FUERA_DEL_MODULO_1).filter(
      (t) => !TABLAS.includes(t),
    );
    expect(excluidasQueNoExisten, 'exclusiones que ya no corresponden a ninguna tabla').toEqual([]);

    expect([...TABLAS_M1].sort()).toEqual([
      'anexo_extracto',
      'cuenta_bancaria',
      'cuenta_bancaria_identificador',
      'lote_ingesta',
      'lote_ingesta_cuenta',
      'movimiento_bancario_crudo',
      'movimiento_origen_crudo',
    ]);
  });
});

// -----------------------------------------------------------------------------
describe('2 — la verificación del verificador: los datos del otro cliente EXISTEN', () => {
  /**
   * 🔴 Sin este `describe`, todo el archivo se pasa con el escenario vacío.
   *
   * El dueño del esquema, que en la base local es superusuario y por lo tanto ignora la RLS (forzada
   * incluida — ADR-0002 §C.0), cuenta las filas de cada cliente. Los números son **exactos** y salen de
   * `MOVIMIENTOS`: si el pipeline escribiera de más, de menos, o en el cliente equivocado, se ve acá y no
   * en el barrido, que solo sabe decir "no vi nada".
   */
  const esperado = (lado: Lado): Record<string, number> => ({
    cuenta_bancaria: 1,
    cuenta_bancaria_identificador: 1,
    lote_ingesta: 1,
    lote_ingesta_cuenta: 1,
    movimiento_bancario_crudo: MOVIMIENTOS[lado],
    // Una satélite N2R por movimiento: es donde viven los identificadores de los terceros.
    movimiento_origen_crudo: MOVIMIENTOS[lado],
    anexo_extracto: 1,
  });

  it('sin RLS de por medio, cada cliente tiene exactamente las filas que el pipeline escribió', async () => {
    const duenio = await clienteDuenio();
    try {
      const consultar = comoConsultar(duenio);
      expect(await contarPorTabla(consultar, TABLAS_M1, s.clienteA)).toEqual(esperado('A'));
      expect(await contarPorTabla(consultar, TABLAS_M1, s.clienteB)).toEqual(esperado('B'));
    } finally {
      await duenio.end();
    }
  });

  /**
   * El otro lado de la misma moneda: cada contador ve **lo suyo completo**, con los mismos números.
   *
   * Un aislamiento que además rompa la lectura propia no es aislamiento, es una base rota — y sería
   * indistinguible del caso bueno mirando solo los ceros del barrido.
   */
  it('cada contador ve lo suyo, con los mismos números que ve el dueño', async () => {
    expect(await contarComoUsuario(USUARIOS.contadorA, TABLAS_M1, s.clienteA)).toEqual(esperado('A'));
    expect(await contarComoUsuario(USUARIOS.contadorB, TABLAS_M1, s.clienteB)).toEqual(esperado('B'));
  });
});

// -----------------------------------------------------------------------------
describe('3 — el barrido: ni un registro del otro cliente, en las dos direcciones', () => {
  it('el contador de A no ve NADA de B, en ninguna tabla con cliente_id', async () => {
    expect(await contarComoUsuario(USUARIOS.contadorA, TABLAS, s.clienteB)).toEqual(
      todoEnCero(TABLAS),
    );
  });

  it('el contador de B no ve NADA de A, en ninguna tabla con cliente_id', async () => {
    expect(await contarComoUsuario(USUARIOS.contadorB, TABLAS, s.clienteA)).toEqual(
      todoEnCero(TABLAS),
    );
  });

  /**
   * El barrido sin filtro por cliente: lo que el usuario ve **en total** tiene que ser exactamente lo
   * suyo. Es la versión que atrapa una policy que filtra bien en el `where` explícito y mal cuando no hay
   * ninguno — el caso de una fila que "se cuela" por un `or` en el predicado (R5).
   */
  it('un `select` sin where devuelve solo lo propio, no una unión de los dos', async () => {
    const totalA = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const salida: Record<string, number> = {};
      for (const tabla of TABLAS_M1) {
        if (!/^[a-z][a-z0-9_]*$/.test(tabla)) throw new Error(`nombre de tabla inesperado: ${tabla}`);
        const f = await tx.consultar<{ n: string }>(`select count(*)::text as n from "${tabla}"`);
        salida[tabla] = Number(f[0]?.n ?? '-1');
      }
      return salida;
    });
    expect(totalA).toEqual({
      cuenta_bancaria: 1,
      cuenta_bancaria_identificador: 1,
      lote_ingesta: 1,
      lote_ingesta_cuenta: 1,
      movimiento_bancario_crudo: MOVIMIENTOS.A,
      movimiento_origen_crudo: MOVIMIENTOS.A,
      anexo_extracto: 1,
    });
  });
});

// -----------------------------------------------------------------------------
describe('4 — conocer el uuid no alcanza: ni por lote, ni por id de movimiento', () => {
  /**
   * Es el caso que más duele porque es el que un bug de la aplicación produce sin querer: un id que se
   * filtra por un log, por una URL, por un export, o simplemente por un `loteId` que llegó del cliente
   * equivocado en el body de un request. La RLS tiene que ser suficiente **sin** que la consulta filtre
   * por `cliente_id` — el `cliente_id` que llega de afuera es un filtro, no una autorización (R24).
   */
  it('el contador de A pide los movimientos del lote de B por su uuid: cero filas', async () => {
    const n = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo where lote_ingesta_id = $1',
        [lados.B.loteId],
      );
      return Number(f[0]?.n ?? '-1');
    });
    expect(n).toBe(0);
  });

  it('tampoco ve el lote de B, ni su cuenta, ni sus anexos, pidiéndolos por uuid', async () => {
    const vistos = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const uno = async (sql: string, id: string): Promise<number> => {
        const f = await tx.consultar<{ n: string }>(sql, [id]);
        return Number(f[0]?.n ?? '-1');
      };
      return {
        lote: await uno('select count(*)::text as n from lote_ingesta where id = $1', lados.B.loteId),
        cuenta: await uno(
          'select count(*)::text as n from cuenta_bancaria where id = $1',
          lados.B.cuentaId,
        ),
        anexos: await uno(
          'select count(*)::text as n from anexo_extracto where lote_ingesta_id = $1',
          lados.B.loteId,
        ),
        movimiento: await uno(
          'select count(*)::text as n from movimiento_bancario_crudo where id = $1',
          lados.B.movimientoId,
        ),
        origen: await uno(
          'select count(*)::text as n from movimiento_origen_crudo where movimiento_id = $1',
          lados.B.movimientoId,
        ),
      };
    });
    expect(vistos).toEqual({ lote: 0, cuenta: 0, anexos: 0, movimiento: 0, origen: 0 });
  });

  /**
   * La verificación del verificador de este `describe`: **las mismas cinco consultas, con los uuid de A**,
   * devuelven lo que tienen que devolver. Sin esto, los cinco ceros de arriba también los daría un
   * `lados.B.loteId` vacío o un typo en el nombre de la columna.
   */
  it('las mismas consultas con los uuid propios sí devuelven las filas', async () => {
    const vistos = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const uno = async (sql: string, id: string): Promise<number> => {
        const f = await tx.consultar<{ n: string }>(sql, [id]);
        return Number(f[0]?.n ?? '-1');
      };
      return {
        lote: await uno('select count(*)::text as n from lote_ingesta where id = $1', lados.A.loteId),
        cuenta: await uno(
          'select count(*)::text as n from cuenta_bancaria where id = $1',
          lados.A.cuentaId,
        ),
        anexos: await uno(
          'select count(*)::text as n from anexo_extracto where lote_ingesta_id = $1',
          lados.A.loteId,
        ),
        movimiento: await uno(
          'select count(*)::text as n from movimiento_bancario_crudo where id = $1',
          lados.A.movimientoId,
        ),
        origen: await uno(
          'select count(*)::text as n from movimiento_origen_crudo where movimiento_id = $1',
          lados.A.movimientoId,
        ),
      };
    });
    expect(vistos).toEqual({ lote: 1, cuenta: 1, anexos: 1, movimiento: 1, origen: 1 });
  });
});

// -----------------------------------------------------------------------------
describe('5 — escritura cruzada: un usuario de A no puede escribir en B', () => {
  /**
   * ## Qué control frena esto, exactamente (salió de correrlo, no de leer la migración)
   *
   * La respuesta intuitiva es "la `with check` de la policy". **No es la que dispara.** En una tabla de
   * dominio hay un `before insert or update of cliente_id` que ejecuta `app.exigir_nodo_cliente()`, y los
   * triggers `BEFORE ROW` corren **antes** de que Postgres evalúe la `with check`. Esa función no es
   * `SECURITY DEFINER` a propósito (ADR-0001 §4.4): corre con los privilegios de quien inserta, así que la
   * RLS de `tenant_node` le esconde el nodo de B, el `exists` da falso y el `INSERT` **falla**.
   *
   * O sea que en el camino cruzado el trigger **tapa** a la `with check`, y las dos dicen lo mismo: la
   * visibilidad del nodo en `tenant_node` y la pertenencia a `accessible_tenant_ids()` son el mismo
   * predicado. No se pierde nada, pero la aserción tiene que nombrar al control que de verdad actuó — un
   * test que dijera "falla por la policy" estaría afirmando algo falso, y el día que alguien saque el
   * trigger seguiría verde por el motivo equivocado.
   */
  it('INSERT de un lote con el cliente_id de B: rechazado', async () => {
    await expect(
      conUsuario(USUARIOS.contadorA, async (tx) =>
        tx.consultar(
          `insert into lote_ingesta
             (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado)
           values ($1, $2, 'sintetico@1', 'archivo', 'hash_cruce_escritura', 'recibido')`,
          [s.clienteB, BANCO],
        ),
      ),
    ).rejects.toThrow(/no es un nodo activo de tipo cliente/);
  });

  it('UPDATE que mueve una fila propia al cliente_id de B: rechazado', async () => {
    await expect(
      conUsuario(USUARIOS.contadorA, async (tx) =>
        tx.consultar('update movimiento_bancario_crudo set cliente_id = $1 where id = $2', [
          s.clienteB,
          lados.A.movimientoId,
        ]),
      ),
    ).rejects.toThrow(/no es un nodo activo de tipo cliente/);
  });

  /**
   * El caso silencioso, que es el peligroso: un `UPDATE` que **no** menciona `cliente_id` y por lo tanto
   * no despierta al trigger. Acá el único control es el `using` de la policy de escritura, y lo que tiene
   * que pasar es que la sentencia **no toque ni una fila** — no que falle. Un `UPDATE` que no matchea nada
   * es legal en SQL, así que el test cuenta las filas afectadas con un CTE.
   */
  it('UPDATE sobre las filas de B sin nombrar cliente_id: cero filas afectadas', async () => {
    const afectadas = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `with u as (
           update lote_ingesta set estado = 'con_errores', motivo_codigo = 'cruce'
            where id = $1 returning 1 as x
         ) select count(*)::text as n from u`,
        [lados.B.loteId],
      );
      return Number(f[0]?.n ?? '-1');
    });
    expect(afectadas).toBe(0);

    // Y la fila de B quedó como estaba: se mira con el dueño, porque el contador de A no la puede ver
    // ni para comprobarlo. Medir con el instrumento apagado es el error clásico de este tipo de test.
    const duenio = await clienteDuenio();
    try {
      const { rows } = await duenio.query<{ estado: string; motivo_codigo: string | null }>(
        'select estado, motivo_codigo from lote_ingesta where id = $1',
        [lados.B.loteId],
      );
      expect(rows[0]?.estado).toBe('recibido');
      expect(rows[0]?.motivo_codigo).toBeNull();
    } finally {
      await duenio.end();
    }
  });

  /**
   * La verificación del verificador del caso anterior: **el mismo `UPDATE`, sobre el lote propio, sí
   * afecta una fila**. Sin él, el "0 filas afectadas" también lo daría un SQL mal escrito.
   */
  it('el mismo UPDATE sobre el lote propio afecta exactamente una fila', async () => {
    const afectadas = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `with u as (
           update lote_ingesta set estado = 'con_errores', motivo_codigo = 'prueba'
            where id = $1 returning 1 as x
         ) select count(*)::text as n from u`,
        [lados.A.loteId],
      );
      return Number(f[0]?.n ?? '-1');
    });
    expect(afectadas).toBe(1);
  });

  /**
   * DELETE cruzado. `movimiento_bancario_crudo` es la única tabla del Módulo 1 donde `app_request` tiene
   * `delete`, así que es donde el borrado cruzado es siquiera expresable. Tiene que borrar cero, y las
   * filas de B tienen que seguir estando **todas**.
   */
  it('DELETE de los movimientos de B: cero borrados y las filas de B intactas', async () => {
    const borradas = await conUsuario(USUARIOS.contadorA, async (tx) => {
      const f = await tx.consultar<{ n: string }>(
        `with d as (
           delete from movimiento_bancario_crudo where lote_ingesta_id = $1 returning 1 as x
         ) select count(*)::text as n from d`,
        [lados.B.loteId],
      );
      return Number(f[0]?.n ?? '-1');
    });
    expect(borradas).toBe(0);

    const duenio = await clienteDuenio();
    try {
      const { rows } = await duenio.query<{ n: string }>(
        'select count(*)::text as n from movimiento_bancario_crudo where cliente_id = $1',
        [s.clienteB],
      );
      expect(Number(rows[0]?.n ?? '-1')).toBe(MOVIMIENTOS.B);
    } finally {
      await duenio.end();
    }
  });

  /**
   * El último barrido, después de todos los intentos de escritura: nada cambió de lado.
   *
   * Va al final a propósito. Los `describe` anteriores miden el estado que dejó el pipeline; éste mide que
   * **ningún intento cruzado dejó residuo** — ni una fila a medias, ni un `cliente_id` movido, ni una fila
   * insertada que la transacción no revirtió.
   */
  it('después de todos los intentos, el barrido sigue dando cero en las dos direcciones', async () => {
    expect(await contarComoUsuario(USUARIOS.contadorA, TABLAS, s.clienteB)).toEqual(
      todoEnCero(TABLAS),
    );
    expect(await contarComoUsuario(USUARIOS.contadorB, TABLAS, s.clienteA)).toEqual(
      todoEnCero(TABLAS),
    );
  });
});
