/**
 * CLI DE INGESTA — el orden del pipeline, y el guard antes de todo.
 *
 *     pnpm ingesta --cliente <uuid> --archivo <ruta> [--banco <codigo>] [--usuario <uuid>]
 *
 * ## Por qué el CLI es un punto de seguridad y no un envoltorio
 *
 * ADR-0002 R18 exige que el proceso que toca datos de clientes **no arranque** si su credencial saltea RLS
 * o es superusuario. Estaba escrito para "el proceso que atiende pedidos", y el CLI parecía quedar afuera
 * por no ser un servidor.
 *
 * Queda adentro, y es el caso más expuesto de los dos: un CLI se corre a mano, en una terminal donde suele
 * estar exportado el `DATABASE_URL` del dueño del esquema porque hace cinco minutos alguien corrió una
 * migración. Ese es exactamente el escenario en que la RLS se apaga sin que nadie lo decida.
 *
 * ## El orden, que es el control
 *
 * Los once pasos del plan §7.2, y tres de ellos están donde están por un motivo:
 *
 *   - **el guard va antes de abrir el archivo.** Si el proceso va a abortar, que aborte sin el extracto de
 *     un cliente cargado en memoria;
 *   - **el lote se crea antes de todo lo demás**, incluso si el archivo se va a rechazar: es el ancla a la
 *     que se cuelgan el rechazo y su motivo. Sin lote, un rechazo no tiene dónde asentarse;
 *   - **el objeto se guarda último**, después de resolver la cuenta. Guardar primero "para no perder el
 *     archivo" escribe el PDF de un cliente bajo el prefijo de otro.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import {
  conUsuario,
  registrarAcceso,
  verificarCredencialDeRequest,
  type Tx,
} from '@sistema-contable/data';
import {
  configDelEntorno,
  crearObjectStorage,
  guardarExtractoTrasResolver,
  type ObjectStorage,
} from '@sistema-contable/almacenamiento';
import {
  adaptadorGalicia,
  adaptadorMacro,
  adaptadorSantander,
  aFilas,
  bancosConAdaptador,
  extraerTexto,
  type CapacidadesAdaptador,
  persistirCuenta,
  registrarAdaptador,
  resolverAdaptador,
  resolverCuentaDelExtracto,
  verificarAritmetica,
  verificarConsolidadoPorMoneda,
  verificarConteoDeCuentas,
  verificarDestinos,
  type EstadoLote,
  type EstadoLotePersistido,
  type OrigenLote,
} from '@sistema-contable/ingesta';

import { logger } from '@sistema-contable/shared/observabilidad';
import { redactar } from '@sistema-contable/shared/seguridad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

/**
 * Los adaptadores se registran **acá**, en el borde de la aplicación.
 *
 * No lo hace `packages/ingesta` en un side-effect de import: un registro que se puebla al importar depende
 * del orden de los imports, y el día que un test importe solo una parte tendría un registro distinto. Que la
 * app declare qué bancos sabe leer también deja la lista en un solo lugar visible.
 */
registrarAdaptador(adaptadorGalicia);
registrarAdaptador(adaptadorMacro);
registrarAdaptador(adaptadorSantander);

/**
 * La configuración se carga acá y no se asume heredada del shell.
 *
 * Sin esto el CLI funcionaba **solo en los tests**, donde vitest carga el entorno por `setupFiles`, y a mano
 * fallaba con "falta S3_ENDPOINT". Un comando que anda en la suite y no en la terminal es la peor forma de
 * estar roto: el que lo corre concluye que el problema es su máquina.
 *
 * `ENV_FILE` permite apuntar al entorno del piloto, que tiene su propia base.
 */
cargarEnv();

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esquemaArgumentos = z.object({
  /** Obligatorio. No hay default, ni "el único cliente que hay" (ADR-0001 §5.1). */
  cliente: z.string().regex(RE_UUID, 'el --cliente tiene que ser un uuid'),
  archivo: z.string().min(1),
  banco: z.string().regex(/^[a-z0-9_]{2,32}$/),
  usuario: z.string().regex(RE_UUID, 'el --usuario tiene que ser un uuid'),
});

export type Argumentos = z.infer<typeof esquemaArgumentos>;

/**
 * Códigos de resultado. Son un vocabulario cerrado a propósito: un mensaje libre construido desde el
 * archivo filtra su contenido al log y a la salida estándar, que en CI queda guardada.
 */
export type ResultadoIngesta =
  | { readonly estado: 'procesado'; readonly loteId: string; readonly clave: string }
  | { readonly estado: 'ya_procesado'; readonly loteId: string }
  | { readonly estado: 'rechazado'; readonly loteId: string; readonly motivoCodigo: string }
  | { readonly estado: 'abortado'; readonly motivoCodigo: string };

/**
 * Motivos de rechazo que NO son de resolución de cuenta.
 *
 * Cada uno dice algo distinto y por eso no se colapsan: `adapter_no_disponible` es "no sé leer este banco",
 * `banco_declarado_no_coincide` es "el archivo no es del banco que dijiste", `archivo_ilegible` es "esto no
 * es un PDF". Un código genérico obligaría al operador a adivinar cuál de las tres cosas pasó.
 */
export const MOTIVOS_TECNICOS = [
  'requiere_ocr',
  'adapter_no_disponible',
  'extension_no_soportada',
  'archivo_ilegible',
  'banco_ambiguo',
  'banco_declarado_no_coincide',
  'sin_movimientos',
  /**
   * INV-multicuenta: el consolidado por moneda de la carátula no coincide con la suma de los saldos finales
   * de las cuentas de esa moneda. Significa que el adaptador **mezcló, perdió o duplicó una cuenta**, y no
   * se arregla descartando una fila: se rechaza el lote entero.
   */
  'consolidado_no_cuadra',
  /**
   * El documento declara N cuentas y el adaptador leyó otra cantidad. Es el único control que ve una cuenta
   * que **nunca se abrió** — que con saldo final `0,00` no mueve ninguna otra verificación.
   */
  'cuentas_no_coinciden',
  /**
   * Una cuenta del archivo no trae período. Es un código propio y no se colapsa con INV-6: sin él, el
   * operador recibía `cuenta_no_pertenece_al_cliente` —el mensaje más grave del módulo— por un problema de
   * parseo de la carátula.
   */
  'cuenta_sin_periodo',
  /**
   * A2 (C5): la partición de destinos no cerró — el adaptador declaró destinos y no llegó
   * (`EST_DESTINOS_NO_DECLARADOS`), quedó una fila sin clasificar (`EST_DESTINOS_SIN_CLASIFICAR`), o hay
   * residuo del cuerpo sin interpretar (`EST_LINEA_NO_INTERPRETADA`, reusado). Ver `verificarDestinos`.
   */
  'destinos_no_cuadran',
] as const;

const EXTENSIONES_ACEPTADAS = new Set(['.pdf', '.xlsx', '.xls', '.csv']);

/**
 * Los tres valores de `lote_ingesta` que este CLI escribe, **tipados contra el vocabulario cerrado** de
 * `@sistema-contable/ingesta` (`ORIGENES_LOTE` / `ESTADOS_LOTE`).
 *
 * Estaban embebidos como literales adentro del texto de los `insert`/`update`, donde no los mira nadie: ni
 * el typecheck (para `tsc` son parte de una cadena) ni el check de la base hasta que la sentencia corre. Un
 * `'recibdo'` de un dedo se manifestaba como un error de constraint en producción, en el paso 4 del
 * pipeline, con el archivo ya leído. Declarados acá con su tipo, ese error **no compila** — y además le dan
 * al test de catálogo una lista con la cual comparar el check.
 */
const ORIGEN_DEL_CLI: OrigenLote = 'archivo';
const ESTADO_AL_CREAR: EstadoLote = 'recibido';
const ESTADO_AL_RECHAZAR: EstadoLote = 'con_errores';

export function parsearArgumentos(argv: readonly string[]): Argumentos {
  const mapa = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('--')) {
        throw new Error(`El argumento --${clave} necesita un valor.`);
      }
      mapa.set(clave, valor);
      i += 1;
    }
  }

  const crudo = {
    cliente: mapa.get('cliente') ?? '',
    archivo: mapa.get('archivo') ?? '',
    banco: mapa.get('banco') ?? '',
    usuario: mapa.get('usuario') ?? '',
  };

  const r = esquemaArgumentos.safeParse(crudo);
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).\n\n` +
        '  pnpm ingesta --cliente <uuid> --archivo <ruta> --banco <codigo> --usuario <uuid>\n\n' +
        'El --cliente es OBLIGATORIO y no tiene default: sin cliente declarado no hay contra qué\n' +
        'verificar que el archivo sea de quien se dice (ADR-0001 §5.1, INV-6).',
    );
  }
  return r.data;
}

/**
 * Corre el pipeline. Separado del CLI para que el test pueda ejercitarlo sin `process.exit`.
 *
 * `storage` se inyecta para que el test use un doble: montar MinIO para verificar el ORDEN de las
 * operaciones sería verificar dos cosas a la vez y fallar por la que no se está probando.
 */
export async function ingestar(
  args: Argumentos,
  storage: ObjectStorage,
): Promise<ResultadoIngesta> {
  /**
   * PASO 1 — EL GUARD, antes de abrir el archivo (R18 extendido al CLI).
   *
   * Si la terminal tiene exportado el DSN del dueño del esquema —cosa habitual después de correr una
   * migración— la RLS queda apagada y el resto del pipeline "funciona" mientras escribe con las policies
   * fuera de juego. Abortar acá es la diferencia entre un error y una fuga silenciosa.
   */
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    logger.error('ingesta.abortada', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    // El contexto sobrevive a la transacción: el pooler no está en transaction mode y la identidad de un
    // pedido puede filtrarse al siguiente.
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const extension = extname(args.archivo).toLowerCase();
  if (!EXTENSIONES_ACEPTADAS.has(extension)) {
    return { estado: 'abortado', motivoCodigo: 'extension_no_soportada' };
  }

  // PASO 2 — recién ahora se abre el archivo.
  const contenido = readFileSync(args.archivo);
  const archivoHash = createHash('sha256').update(contenido).digest('hex');

  // El nombre original NO viaja a la base ni al log: suele traer la razón social y el período. Solo su
  // forma, para que un problema de nombre sea diagnosticable.
  logger.info('ingesta.iniciada', {
    cliente_id: args.cliente,
    banco_codigo: args.banco,
    archivo_bytes: contenido.byteLength,
  });

  return conUsuario(args.usuario, async (tx) => {
    // PASO 3 — idempotencia POR CLIENTE. El mismo archivo dos veces es un no-op, no un duplicado.
    const yaEsta = await tx.consultar<{ id: string }>(
      `select id::text as id from lote_ingesta where cliente_id = $1 and archivo_hash = $2`,
      [args.cliente, archivoHash],
    );
    const loteExistente = yaEsta[0]?.id;
    if (loteExistente) {
      logger.info('ingesta.ya_procesado', { cliente_id: args.cliente, lote_id: loteExistente });
      return { estado: 'ya_procesado' as const, loteId: loteExistente };
    }

    // PASO 4 — el lote es el ancla de todo lo que sigue, incluso del rechazo.
    const creado = await tx.consultar<{ id: string }>(
      `insert into lote_ingesta
         (cliente_id, banco_codigo, adaptador_version, origen, archivo_hash, estado, procesado_por)
       values ($1, $2, $3, $4, $5, $6, app.current_user_id())
       returning id::text as id`,
      // La versión definitiva se escribe al cerrar el lote, con la del adaptador que de verdad lo leyó.
      [
        args.cliente,
        args.banco,
        `${args.banco}@pendiente`,
        ORIGEN_DEL_CLI,
        archivoHash,
        ESTADO_AL_CREAR,
      ],
    );
    const loteId = creado[0]?.id;
    if (!loteId) throw new Error('No se pudo crear el lote de ingesta.');

    /**
     * PASOS 5 A 11 — leer, resolver, verificar, persistir, y **recién ahí** guardar el objeto.
     *
     * El orden no es una preferencia:
     *
     *   - guardar el archivo **antes de resolver** escribe el PDF de un cliente bajo el prefijo de otro, y a
     *     partir de ahí el socio del cliente equivocado se lo baja legítimamente;
     *   - guardarlo **antes de persistir** deja un objeto huérfano si la persistencia falla — en un lugar del
     *     que el sistema no sabe, sin listado, sin inventario, fuera de la retención y de la auditoría. Un
     *     `ROLLBACK` no borra un `PUT`.
     */

    /**
     * 5. Texto y geometría.
     *
     * El parseo del PDF va en un `try`: un archivo **corrupto o que no es un PDF** hacía subir la excepción
     * del extractor (`Invalid PDF structure`) hasta el `catch` del CLI, que devolvía código de salida 2 y un
     * mensaje del driver. Eso está mal por dos motivos: el lote quedaba en `recibido` sin motivo —o sea sin
     * nadie mirándolo— y el operador recibía un error técnico en vez de un código de rechazo.
     *
     * Un archivo ilegible es un caso **esperado** del dominio, no un fallo del programa.
     */
    let texto;
    let filas;
    try {
      texto = await extraerTexto(contenido);
      filas = await aFilas(contenido);
    } catch {
      await rechazar(tx, { clienteId: args.cliente, loteId, motivoCodigo: 'archivo_ilegible' });
      return { estado: 'rechazado' as const, loteId, motivoCodigo: 'archivo_ilegible' };
    }

    // Sin texto es un escaneo: rechazo, cero filas, cero objeto.
    if (texto.requiereOcr) {
      await rechazar(tx, { clienteId: args.cliente, loteId, motivoCodigo: 'requiere_ocr' });
      return { estado: 'rechazado' as const, loteId, motivoCodigo: 'requiere_ocr' };
    }

    // 6. Qué banco es. Se detecta por CONTENIDO y se compara con lo declarado: el operador sube el PDF de un
    //    banco a la carpeta de otro, y el archivo manda.
    const cual = resolverAdaptador({ filas }, args.banco);
    if (cual.estado !== 'encontrado') {
      const motivo =
        cual.estado === 'sin_adaptador'
          ? 'adapter_no_disponible'
          : cual.estado === 'ambiguo'
            ? 'banco_ambiguo'
            : 'banco_declarado_no_coincide';
      await rechazar(tx, { clienteId: args.cliente, loteId, motivoCodigo: motivo });
      return { estado: 'rechazado' as const, loteId, motivoCodigo: motivo };
    }

    // 7. Leer. El adaptador reporta lo que leyó y NO dice si cuadra.
    const leido = cual.adaptador.leer({ filas });
    if (leido.cuentas.length === 0) {
      await rechazar(tx, { clienteId: args.cliente, loteId, motivoCodigo: 'sin_movimientos' });
      return { estado: 'rechazado' as const, loteId, motivoCodigo: 'sin_movimientos' };
    }

    const movimientosEnElLote = leido.cuentas.reduce((n, c) => n + c.movimientos.length, 0);

    logger.info('ingesta.parseada', {
      lote_id: loteId,
      cuentas_detectadas: leido.cuentas.length,
      filas_leidas: movimientosEnElLote,
      paginas: texto.paginas.length,
      lineas_no_interpretadas: leido.lineasNoInterpretadas.length,
    });

    /**
     * 7.bis — INV-multicuenta, **antes de persistir una sola fila y antes de mirar cuenta por cuenta**.
     *
     * Es la única verificación del pipeline que **cruza cuentas**, y por eso no puede vivir adentro del
     * bucle: todo lo que `verificarAritmetica` chequea se calcula dentro de una cuenta, así que cierra igual
     * si la separación se hizo mal. Medido en un banco del roster: mezclar sus tres cuentas da **1 ruptura
     * sobre 1346 = 0,07 %**, o sea que "casi cuadra" y lo que se persiste es una cuenta que no existe.
     *
     * Va acá arriba porque una mezcla de cuentas **no se arregla descartando una fila**: si el reparto está
     * mal, todas las filas del lote están atribuidas a la cuenta equivocada.
     */
    const consolidado = verificarConsolidadoPorMoneda(
      leido.cuentas,
      leido.consolidadosPorMoneda ?? [],
      // Sin la capacidad declarada, "el banco no lo publica" y "el parser de carátula no lo encontró" se
      // ven igual, y el segundo apaga el control en silencio. Ver `traeConsolidadoPorMoneda`.
      { declaraConsolidado: (cual.adaptador.capacidades as CapacidadesAdaptador).traeConsolidadoPorMoneda },
    );
    /**
     * Y junto con el consolidado, el **conteo de cuentas declarado por el documento**.
     *
     * Son dos controles distintos y hacen falta los dos: el consolidado ve una cuenta **mezclada**; el
     * conteo ve una cuenta que **nunca se abrió**. Si esa cuenta tiene saldo final `0,00` —una cuenta
     * cerrada o vaciada en el período, que es un caso real— no mueve la suma del consolidado, no rompe
     * ninguna cadena, y desaparece del sistema con el lote en verde. Ver `verificarConteoDeCuentas`.
     */
    /**
     * A2 (C5) — el gate de residuo, tercer control del lote: la partición de destinos declarada por el
     * adaptador (`DESTINOS_BASE`, `toolkit.ts`) tiene que cerrar. Es el único de los tres commits de A2
     * que cambia un veredicto de producción — C1-C4 solo instrumentaron. Ver `verificarDestinos`.
     */
    const capacidadesAdaptador = cual.adaptador.capacidades as CapacidadesAdaptador;
    const diferenciasDeLote = [
      ...consolidado.diferencias,
      ...verificarConteoDeCuentas(leido.cuentas.length, leido.cuentasDeclaradas),
      ...verificarDestinos(leido.destinos, capacidadesAdaptador.declaraDestinos),
    ];

    if (diferenciasDeLote.length > 0) {
      // Vocabulario cerrado de `CODIGOS_DIFERENCIA`: los tres códigos de la izquierda son los únicos que
      // puede empujar `verificarDestinos`.
      const codigosDestinos = new Set([
        'EST_DESTINOS_NO_DECLARADOS',
        'EST_DESTINOS_SIN_CLASIFICAR',
        'EST_LINEA_NO_INTERPRETADA',
      ]);
      const motivo = diferenciasDeLote.some((d) => d.codigo === 'EST_CUENTAS_NO_COINCIDEN')
        ? 'cuentas_no_coinciden'
        : diferenciasDeLote.some((d) => codigosDestinos.has(d.codigo))
          ? 'destinos_no_cuadran'
          : 'consolidado_no_cuadra';
      logger.warn('ingesta.lote_no_cuadra', {
        lote_id: loteId,
        cuentas_detectadas: leido.cuentas.length,
        // Códigos y campos de un vocabulario CERRADO (`CAMPOS_DIFERENCIA`). Nunca un valor.
        codigos_diferencia: diferenciasDeLote.map((d) => d.campo ?? d.codigo).join(','),
      });
      await rechazar(tx, { clienteId: args.cliente, loteId, motivoCodigo: motivo });
      return { estado: 'rechazado' as const, loteId, motivoCodigo: motivo };
    }

    /**
     * PASOS 8 A 10 — POR CUENTA, y el lote entero es la unidad atómica.
     *
     * ## El bug que esto corrige
     *
     * La primera versión hacía `leido.cuentas[0]` y seguía. Con un archivo de una sola cuenta —el primer
     * banco— funcionaba, y con un archivo multi-cuenta habría **persistido la primera y descartado las otras
     * en silencio**: el lote quedaba `procesado`, con un conteo plausible y **dos tercios del extracto
     * afuera**. Es el peor modo de falla del módulo, otra vez: los números cierran y falta la mitad.
     *
     * Un banco del roster trae **dos o tres cuentas en el mismo resumen**, así que no es un caso hipotético.
     *
     * ## Por qué el veredicto del lote es el PEOR de sus cuentas
     *
     * Si una cuenta de tres no cuadra, **no se persiste ninguna**. El motivo es el mismo por el que medio
     * extracto es peor que ninguno: la contadora arma el asiento contra el saldo, y un lote con dos cuentas
     * buenas y una mala produce un asiento que cierra mal y se descubre al cierre de ejercicio.
     *
     * Es el **default seguro** mientras la pregunta esté abierta (plan §11: *"¿un archivo con una sola cuenta
     * no resuelta se rechaza entero?"*). Queda escrito como default **elegido**, no como olvido: si no
     * estuviera acá, la primera corrida multi-cuenta lo resolvería por accidente en la dirección contraria.
     */
    let filasTotales = 0;
    let estadoPeor: EstadoLotePersistido = 'procesado';

    for (const cuentaLeida of leido.cuentas) {
      /**
       * 8.pre — sin período no se puede resolver la cuenta, y hay que decirlo con ese motivo.
       *
       * `periodoDesde`/`periodoHasta` son opcionales en el esquema y **pueden faltar de verdad**: en un
       * banco el período sale de dos etiquetas separadas y `periodoPorEtiquetas` devuelve `null` si falta
       * una; en otro el período es del archivo y las etiquetas de saldo son por cuenta, así que una cuenta
       * dada de alta a mitad de mes puede no traerlo.
       *
       * Sin este guard, el `undefined` llegaba a `alFecha` → la consulta comparaba contra `null` → cero
       * candidatas → el operador recibía **`cuenta_no_pertenece_al_cliente`**, que es el mensaje más grave
       * del módulo, cuando el hecho real es "no pude leer el período". El reflejo sería dar de alta una
       * cuenta que ya existe. Y aguas abajo, las columnas de `lote_ingesta_cuenta` son `not null`: el
       * insert habría reventado la transacción entera con un error técnico en vez de un código.
       *
       * El typecheck no lo veía porque `apps/` estaba fuera del `include` de `tsconfig.json`.
       */
      const { periodoDesde, periodoHasta } = cuentaLeida.cuenta;
      if (periodoDesde === undefined || periodoHasta === undefined) {
        await rechazar(tx, { clienteId: args.cliente, loteId, motivoCodigo: 'cuenta_sin_periodo' });
        return { estado: 'rechazado' as const, loteId, motivoCodigo: 'cuenta_sin_periodo' };
      }

      // 8. INV-6, **por cuenta**: cada una tiene que pertenecer al cliente declarado. Un resumen multi-cuenta
      //    donde una de las cuentas es de otro cliente se rechaza entero.
      const resolucion = await resolverCuentaDelExtracto(tx, {
        clienteId: args.cliente,
        numeroDeclarado: cuentaLeida.cuenta.numero,
        alFecha: periodoHasta,
      });
      if (resolucion.estado !== 'resuelta') {
        await rechazar(tx, { clienteId: args.cliente, loteId, motivoCodigo: resolucion.estado });
        return { estado: 'rechazado' as const, loteId, motivoCodigo: resolucion.estado };
      }

      // 9. La verificación es **por cuenta**: la cadena de saldos de una cuenta no tiene nada que ver con la
      //    de otra, y sumarlas juntas daría una ruptura en cada cambio de cuenta.
      const verificacion = verificarAritmetica(cuentaLeida, {
        capacidades: cual.adaptador.capacidades as never,
        // El alcance de `EST_SIN_MOVIMIENTOS` es el ARCHIVO, no la cuenta: hay un banco del roster cuya
        // segunda cuenta viene vacía y es legítimo. Ver `ContextoVerificacion.movimientosEnElLote`.
        movimientosEnElLote,
      });
      logger.info('ingesta.verificada', {
        lote_id: loteId,
        verificacion_estado: verificacion.estado,
        filas_con_ruptura: verificacion.filasConRuptura.length,
        codigos_diferencia: verificacion.diferencias.map((d) => d.codigo).join(','),
      });

      // 10. Persistir. Un fallo revierte **todo el lote**, incluidas las cuentas ya insertadas: están en la
      //     misma transacción.
      const persistido = await persistirCuenta(tx, {
        clienteId: args.cliente,
        loteId,
        cuentaBancariaId: resolucion.cuentaBancariaId,
        cuenta: cuentaLeida,
        verificacion,
        movimientosEnElLote,
      });
      if (!persistido.persistido) {
        await rechazar(tx, { clienteId: args.cliente, loteId, motivoCodigo: persistido.motivoCodigo });
        return { estado: 'rechazado' as const, loteId, motivoCodigo: persistido.motivoCodigo };
      }

      filasTotales += persistido.filas;
      // El peor estado gana: una sola cuenta con observaciones marca el lote entero.
      if (persistido.estado === 'procesado_con_observaciones') estadoPeor = persistido.estado;
    }

    const persistido = { estado: estadoPeor, filas: filasTotales };

    // 11. **Último**: el objeto.
    const resultado = await guardarExtractoTrasResolver(
      storage,
      {
        clienteId: args.cliente,
        loteId,
        categoria: 'extracto',
        extension: extension.slice(1) as 'pdf' | 'xlsx' | 'xls' | 'csv',
        contentType: contentTypeDe(extension),
        contenido,
      },
      /**
       * Todas las cuentas del lote resolvieron al cliente declarado en el paso 8 —si alguna no, ya se
       * rechazó y no se llega acá— y las filas ya entraron. La función sigue garantizando lo que garantiza:
       * no escribe si la resolución no fue exitosa.
       *
       * La clave del objeto se arma con el **lote**, no con una cuenta: un archivo con tres cuentas sigue
       * siendo un archivo, y guardarlo tres veces bajo tres claves sería el mismo PDF triplicado.
       */
      async () => ({
        estado: 'resuelta' as const,
        clienteId: args.cliente,
        // `cuentaBancariaId` no participa de la clave del objeto —esa se arma con cliente y lote— y con
        // varias cuentas en el archivo no habría una sola para poner. Se pasa el lote, que es lo que el
        // objeto representa.
        cuentaBancariaId: loteId,
      }),
    );

    if (!resultado.guardado) {
      // Un lote persistido sin su archivo no se puede reinterpretar nunca más: se revierte todo.
      throw new Error(`No se pudo guardar el objeto del lote: ${resultado.motivoCodigo}`);
    }

    await tx.consultar(
      `update lote_ingesta
          set estado = $2, archivo_clave = $3, paginas_declaradas = $4, paginas_sin_texto = $5,
              filas_leidas = $6, filas_aceptadas = $6, adaptador_version = $7
        where id = $1 and cliente_id = $8`,
      [
        loteId,
        persistido.estado,
        resultado.clave,
        leido.paginasDeclaradas ?? null,
        texto.paginasSinTexto.length,
        persistido.filas,
        `${cual.adaptador.bancoCodigo}@${cual.adaptador.version}`,
        args.cliente,
      ],
    );

    logger.info('ingesta.persistida', {
      lote_id: loteId,
      filas_insertadas: persistido.filas,
      estado: persistido.estado,
    });

    return { estado: 'procesado' as const, loteId, clave: resultado.clave };
  });
}

/**
 * Asienta el rechazo: en el lote **y** en el rastro de auditoría, con `accion = 'rechazo'`.
 *
 * El valor `'rechazo'` existe justamente por esto (migración 0004). Registrarlo como `'escritura'` sería
 * asentar un hecho que no ocurrió en la única tabla append-only del sistema; y no registrarlo dejaría el
 * caso más importante del módulo —un archivo que no era de este cliente— sin rastro.
 */
async function rechazar(
  tx: Tx,
  args: { readonly clienteId: string; readonly loteId: string; readonly motivoCodigo: string },
): Promise<void> {
  await tx.consultar(
    `update lote_ingesta set estado = $4, motivo_codigo = $2
      where id = $1 and cliente_id = $3`,
    [args.loteId, args.motivoCodigo, args.clienteId, ESTADO_AL_RECHAZAR],
  );

  await registrarAcceso(tx, {
    clienteId: args.clienteId,
    accion: 'rechazo',
    recurso: 'lote_ingesta',
    recursoId: args.loteId,
    // El motivo del rastro es el CÓDIGO, no una frase armada con el contenido del archivo.
    motivo: args.motivoCodigo,
  });

  logger.warn('ingesta.rechazada', {
    cliente_id: args.clienteId,
    lote_id: args.loteId,
    motivo_codigo: args.motivoCodigo,
  });
}

/** Los bancos que el CLI sabe leer. Sale del registro, no de una lista paralela que divergiría. */
export function bancosSoportados(): readonly string[] {
  return bancosConAdaptador();
}

function contentTypeDe(extension: string): string {
  switch (extension) {
    case '.pdf':
      return 'application/pdf';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls':
      return 'application/vnd.ms-excel';
    default:
      return 'text/csv';
  }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/ingestar.ts');

if (esEjecucionDirecta) {
  const salto = String.fromCharCode(10);
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await ingestar(args, crearObjectStorage(configDelEntorno()));

    // La salida lleva CÓDIGOS y uuid. Nunca el nombre del archivo ni un fragmento de su contenido: la
    // salida estándar de un CLI termina en el historial de la terminal y en los logs de CI.
    process.stdout.write(`${JSON.stringify(r)}${salto}`);
    process.exit(r.estado === 'procesado' || r.estado === 'ya_procesado' ? 0 : 1);
  } catch (error) {
    /**
     * **El stderr pasa por el redactor.** Era el único camino de salida del proyecto sin ninguna de las
     * tres capas de defensa del logger: un error de constraint de Postgres trae
     * `DETAIL: Failing row contains (…)` con la fila entera, y el reflejo de quien lo ve es pegarlo en un
     * issue para pedir ayuda. Ahí viaja la fila de un extracto real.
     *
     * `redactar()` devuelve nombre + mensaje tapado, y descarta stack, detail y where.
     */
    // `redactar` de un Error devuelve `{ nombre, mensaje }` sin stack, sin `detail`, sin `where` y sin los
    // parámetros ligados de la query. Se serializa eso y nada más.
    process.stderr.write(`${JSON.stringify(redactar(error))}${salto}`);
    process.exit(2);
  }
}

/** Nombre del archivo solo para diagnóstico local, nunca para la base ni el log. */
export function nombreSoloParaDiagnostico(ruta: string): string {
  return basename(ruta);
}
