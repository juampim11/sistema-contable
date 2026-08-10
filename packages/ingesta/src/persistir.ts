/**
 * PERSISTENCIA DEL EXTRACTO — todo o nada.
 *
 * ## La decisión central: medio extracto es peor que ninguno
 *
 * Y el motivo es de negocio, no de purismo. La contadora arma el asiento **contra el saldo**. Un lote
 * parcial —280 de 326 filas— produce un asiento que cierra mal y que se descubre **al cierre de ejercicio**,
 * que es literalmente el dolor que originó el proyecto.
 *
 * El corolario del contador es más fuerte todavía: **un asiento balanceado sobre datos incompletos es peor
 * que ningún asiento, porque nadie lo va a revisar.** Un lote rechazado tiene a alguien mirándolo; un lote
 * que quedó a medias y dice `procesado` no tiene a nadie.
 *
 * De ahí que esta función:
 *
 *   - corre **dentro de la transacción** de `conUsuario()`, así que si algo falla no queda ni una fila;
 *   - recibe la verificación **ya calculada** y **no la calcula**: quien lee no puede ser quien certifica;
 *   - **no persiste nada** si la verificación dice `no_cuadra`;
 *   - **no persiste nada** si hay cero movimientos — "0 movimientos" nunca es éxito.
 *
 * ## Los tres estados del lote, y qué significa cada uno
 *
 * | Estado | Cuándo | Qué se persistió |
 * |---|---|---|
 * | `procesado` | la verificación **cuadra** | todo |
 * | `procesado_con_observaciones` | `no_verificable` con motivo aceptable (el banco no publica totales y la cadena cierra) | todo, con las observaciones en `verificacion_detalle` |
 * | `con_errores` | `no_cuadra`, cero movimientos, o cualquier motivo de rechazo | **nada**: cero filas |
 *
 * La diferencia entre los dos primeros importa: `procesado_con_observaciones` le dice al contador *"esto se
 * leyó bien pero no lo pude verificar contra los totales del banco porque el banco no los publica"*, que es
 * una información distinta de *"esto cuadra"*. Colapsarlos haría que un extracto no verificado se vea igual
 * que uno verificado.
 */

import { conErroresTraducidos, type Tx } from '@sistema-contable/data';
import { logger } from '@sistema-contable/shared/observabilidad';
import { contieneIdentificador, depurarGlosa } from './glosa.ts';
import type { CuentaConMovimientos, EstadoLotePersistido, Verificacion } from './esquema.ts';

export type PedidoDePersistencia = {
  readonly clienteId: string;
  readonly loteId: string;
  readonly cuentaBancariaId: string;
  readonly cuenta: CuentaConMovimientos;
  readonly verificacion: Verificacion;
  /** Movimientos del lote entero. Ver `estadoSegunVerificacion`: decide si una cuenta vacía es legítima. */
  readonly movimientosEnElLote?: number;
};

export type ResultadoPersistencia =
  | {
      readonly persistido: true;
      /** Del vocabulario cerrado de `lote_ingesta.estado`. Ver `ESTADOS_LOTE_PERSISTIDO`. */
      readonly estado: EstadoLotePersistido;
      readonly filas: number;
    }
  | { readonly persistido: false; readonly motivoCodigo: string };

/**
 * ¿Se puede persistir con este resultado de verificación?
 *
 * Función aparte y pura para que el criterio sea **una sola cosa en un solo lugar**. Si estuviera embebido
 * en la persistencia, el día que alguien agregue un caso lo va a agregar en un `if` y el criterio va a estar
 * en dos lados.
 */
export function estadoSegunVerificacion(
  verificacion: Verificacion,
  cantidadMovimientos: number,
  opciones: {
    /**
     * Movimientos del **lote entero**. Es lo que distingue una cuenta vacía legítima de un parser que no
     * encontró nada. Ver `ContextoVerificacion.movimientosEnElLote`, donde está el razonamiento completo.
     *
     * Sin este dato se conserva la regla estricta: 0 movimientos en la cuenta no se persiste. El default es
     * el seguro **a propósito**.
     */
    readonly movimientosEnElLote?: number;
  } = {},
): { readonly persistir: false; readonly motivoCodigo: string } | {
  readonly persistir: true;
  readonly estado: EstadoLotePersistido;
} {
  // "0 movimientos" NUNCA es éxito **para el archivo**. Un extracto sin movimientos existe (una cuenta sin
  // actividad), pero es indistinguible de un parser que no encontró nada — y las dos cosas necesitan que
  // alguien mire.
  if (cantidadMovimientos === 0) {
    /**
     * La excepción medida: una cuenta vacía **dentro de un lote que sí trajo movimientos**.
     *
     * El segundo banco del roster publica dos cuentas en un archivo y la de dólares viene vacía con la
     * leyenda impresa del propio banco (`06-formato-santander.md` §11.7). Rechazarla arrastraría las 158
     * filas correctas de la cuenta en pesos, porque el veredicto del lote es el peor de sus cuentas.
     *
     * Se persiste la **cuenta** —su período, su saldo inicial y su saldo final declarados— con cero
     * movimientos y estado `procesado_con_observaciones`. Guardar la cuenta vacía no es un detalle: es lo
     * que le da a INV-multicuenta el saldo final con el que la suma por moneda tiene que cerrar.
     *
     * ## 🔴 La excepción NO saltea el veredicto de la verificación
     *
     * La primera versión de este bloque **retornaba antes del `switch`**, o sea que aceptaba la cuenta sin
     * mirar nunca si cuadraba. Lo encontró el panel (tres agentes, por separado) y es un agujero real:
     *
     * > una cuenta vacía cuyo **saldo inicial declarado ≠ saldo final declarado** es el síntoma de que el
     * > parser perdió sus movimientos, o de que le colgó a esa sección el `SALDO FINAL` de otra cuenta.
     *
     * `verificarAritmetica` lo ve —da `ARIT_SALDO_FINAL` y `no_cuadra`— y este bloque lo tiraba a la
     * basura: el lote quedaba `procesado_con_observaciones` con una cuenta entera sin movimientos. Es
     * exactamente el modo de falla que la cabecera de este archivo dice existir para evitar, reintroducido
     * por la excepción. Y peor: `EST_SIN_MOVIMIENTOS` se bajó a observación en el mismo cambio, así que
     * **las dos redes se retiraron juntas**.
     *
     * La cuenta vacía **legítima** no se ve afectada: con saldo inicial = saldo final y cero movimientos, el
     * tri-estado no puede dar `cuadra` (no hay nada que verificar) pero tampoco da `no_cuadra`. Da
     * `no_verificable`, que es el caso que pasa por acá.
     */
    const hayMovimientosEnElLote = (opciones.movimientosEnElLote ?? 0) > 0;

    if (hayMovimientosEnElLote && verificacion.estado !== 'no_cuadra') {
      return { persistir: true, estado: 'procesado_con_observaciones' };
    }
    if (hayMovimientosEnElLote) {
      // Vacía Y con la aritmética rota: no es la cuenta legítima, es una cuenta que perdió sus filas.
      return { persistir: false, motivoCodigo: primeraDiferencia(verificacion) };
    }
    return { persistir: false, motivoCodigo: 'sin_movimientos' };
  }

  switch (verificacion.estado) {
    case 'cuadra':
      return { persistir: true, estado: 'procesado' };
    case 'no_verificable':
      // El banco no publica con qué comparar y la cadena cierra. Se acepta, pero se dice.
      return { persistir: true, estado: 'procesado_con_observaciones' };
    case 'no_cuadra':
      // Cero filas. Ver la nota de la cabecera: medio extracto es peor que ninguno.
      return { persistir: false, motivoCodigo: primeraDiferencia(verificacion) };
  }
}

/**
 * El código de la primera diferencia de severidad `error`.
 *
 * Se busca la de severidad `error` y no "la primera": una lista que arranca con observaciones haría que el
 * motivo del rechazo sea una observación, y el operador leería "falta la fecha valor" cuando el problema
 * real es que la cadena de saldos se rompió.
 */
function primeraDiferencia(verificacion: Verificacion): string {
  const error = verificacion.diferencias.find((d) => d.severidad === 'error');
  return error?.codigo ?? verificacion.diferencias[0]?.codigo ?? 'verificacion_no_cuadra';
}

/**
 * Persiste una cuenta con sus movimientos. **Asume que ya está dentro de una transacción** con identidad
 * (la de `conUsuario`): no abre ni cierra nada, así que un fallo revierte todo el lote.
 */
export async function persistirCuenta(
  tx: Tx,
  pedido: PedidoDePersistencia,
): Promise<ResultadoPersistencia> {
  const movimientos = pedido.cuenta.movimientos;
  const decision = estadoSegunVerificacion(pedido.verificacion, movimientos.length, {
    ...(pedido.movimientosEnElLote === undefined
      ? {}
      : { movimientosEnElLote: pedido.movimientosEnElLote }),
  });

  if (!decision.persistir) {
    logger.warn('persistencia.rechazada', {
      cliente_id: pedido.clienteId,
      lote_id: pedido.loteId,
      motivo_codigo: decision.motivoCodigo,
      // Cuántas filas se habrían escrito: es lo que hace visible que un rechazo NO es "no había nada".
      filas_descartadas: movimientos.length,
    });
    return { persistido: false, motivoCodigo: decision.motivoCodigo };
  }

  const c = pedido.cuenta.cuenta;

  await conErroresTraducidos(undefined, () =>
    tx.consultar(
    `insert into lote_ingesta_cuenta
       (cliente_id, lote_ingesta_id, cuenta_bancaria_id, periodo_desde, periodo_hasta, moneda,
        saldo_inicial_declarado, saldo_final_declarado, total_creditos_declarado, total_debitos_declarado,
        saldo_final_calculado, total_creditos_calculado, total_debitos_calculado,
        filas_leidas, filas_aceptadas, verificacion_estado, verificacion_detalle)
     values ($1, $2, $3, $4::date, $5::date, $6,
             $7::numeric, $8::numeric, $9::numeric, $10::numeric,
             $11::numeric, $12::numeric, $13::numeric,
             $14, $15, $16, $17::jsonb)`,
    [
      pedido.clienteId,
      pedido.loteId,
      pedido.cuentaBancariaId,
      c.periodoDesde,
      c.periodoHasta,
      c.moneda,
      c.saldoInicialDeclarado ?? null,
      c.saldoFinalDeclarado ?? null,
      c.totalCreditosDeclarado ?? null,
      c.totalDebitosDeclarado ?? null,
      pedido.verificacion.saldoFinalCalculado ?? null,
      pedido.verificacion.totalCreditosCalculado ?? null,
      pedido.verificacion.totalDebitosCalculado ?? null,
      movimientos.length,
      movimientos.length,
      pedido.verificacion.estado,
      // El detalle lleva CÓDIGOS y números de fila. Ninguna diferencia lleva un valor: el diagnóstico no
      // puede ser el canal de fuga (hay un test que lo verifica sobre el esquema).
      JSON.stringify({
        diferencias: pedido.verificacion.diferencias.map((d) => ({
          codigo: d.codigo,
          severidad: d.severidad,
          filaNumero: d.filaNumero ?? null,
          paginaPdf: d.paginaPdf ?? null,
          campo: d.campo ?? null,
        })),
        filasConRuptura: pedido.verificacion.filasConRuptura,
        // Qué se pudo verificar y qué no aplicaba. Sin esto, `no_verificable` no dice POR QUÉ, y en tres
        // sprints todos los bancos están ahí sin que nadie sepa cuál se puede arreglar.
        chequeos: {
          verificoTotales: pedido.verificacion.verificoTotales,
          verificoSaldos: pedido.verificacion.verificoSaldos,
          verificoCadena: pedido.verificacion.verificoCadena,
          cadenaDeSaldosUsada: pedido.verificacion.cadenaDeSaldosUsada,
          coberturaDeLineasCompleta: pedido.verificacion.coberturaDeLineasCompleta,
          fechasDentroDelPeriodo: pedido.verificacion.fechasDentroDelPeriodo,
          fechasMonotonas: pedido.verificacion.fechasMonotonas,
        },
        paginasSinMovimientos: pedido.verificacion.paginasSinMovimientos,
      }),
    ],
    ),
  );

  /**
   * Inserción de los movimientos.
   *
   * Se hace fila por fila y **no** con un `COPY`. Cuesta más, y es a propósito: `COPY` corre por fuera de
   * las políticas de fila, así que el aislamiento entre clientes dejaría de verificarse justo en el camino
   * que escribe más datos. Es el precio del aislamiento verificable (ADR-0002, consecuencias).
   */
  let filas = 0;
  for (const m of movimientos) {
    // La glosa se depura ANTES de guardarse: los identificadores de terceros van a la satélite N2R, no a
    // `descripcion`. Es lo que sostiene que `descripcion` sea N2 (INV-13).
    const glosa = depurarGlosa(m.descripcion);

    /**
     * INV-14, la cláusula que solo se puede verificar acá: `conceptoBanco` tiene que salir de la glosa
     * **depurada**, o sea ser prefijo de lo que se va a guardar en `descripcion`.
     *
     * El adaptador no corre `depurarGlosa` —es responsabilidad de esta capa—, así que corta sobre el texto
     * crudo. Se vuelve a depurar el concepto con la misma función y se **verifica** el prefijo. Si no da, no
     * se afloja nada: **es un bug del adaptador**, que construyó el concepto de un texto distinto del que se
     * persiste, y ese es exactamente el caso que este control existe para atrapar. El `check` de la base es
     * la red final; esto es lo que da un código de rechazo en vez de una violación de constraint.
     *
     * `columna_propia` queda exenta: viene de otro artefacto (una celda del Excel) y no es prefijo de la
     * glosa del PDF. Para esa estrategia la garantía es este mismo `depurarGlosa`, en código.
     */
    const conceptoBanco =
      m.conceptoBanco === undefined ? null : depurarGlosa(m.conceptoBanco).descripcion;

    if (
      conceptoBanco !== null &&
      m.conceptoBancoEstrategia !== 'columna_propia' &&
      !glosa.descripcion.startsWith(conceptoBanco)
    ) {
      logger.warn('persistencia.rechazada', {
        cliente_id: pedido.clienteId,
        lote_id: pedido.loteId,
        motivo_codigo: 'concepto_banco_no_es_prefijo',
        fila_numero: m.filaNumero,
      });
      return { persistido: false, motivoCodigo: 'concepto_banco_no_es_prefijo' };
    }

    // El traductor lleva el número de fila: sin él, un insert de 326 filas que falla no dice cuál, y la
    // única salida sería volver al archivo del cliente.
    const insertado = await conErroresTraducidos(m.filaNumero, () =>
      tx.consultar<{ id: string }>(
      `insert into movimiento_bancario_crudo
         (cliente_id, lote_ingesta_id, cuenta_bancaria_id, fila_numero, fila_hash,
          fecha, fecha_valor, descripcion, importe, saldo, saldo_es_acreedor, moneda,
          concepto_codigo, referencia_externa,
          concepto_banco, concepto_completo, concepto_banco_estrategia, pagina_pdf)
       values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9::numeric, $10::numeric, $11, $12, $13, $14,
               $15, $16, $17, $18)
       returning id::text as id`,
      [
        pedido.clienteId,
        pedido.loteId,
        pedido.cuentaBancariaId,
        m.filaNumero,
        m.filaHash,
        m.fecha,
        m.fechaValor ?? null,
        glosa.descripcion,
        m.importe,
        m.saldo ?? null,
        m.saldoEsAcreedor ?? null,
        m.moneda,
        m.conceptoCodigo ?? null,
        m.referenciaExterna ?? null,
        conceptoBanco,
        m.conceptoCompleto ?? null,
        // `no_publicado` cuando el adaptador no declaró nada Y no trajo concepto: es el caso honesto.
        // Con concepto y sin estrategia el esquema ya no valida, así que acá no puede llegar.
        m.conceptoBancoEstrategia ?? 'no_publicado',
        m.paginaPdf,
      ],
      ),
    );

    const movimientoId = insertado[0]?.id;
    if (!movimientoId) throw new Error('El movimiento no devolvió id: la transacción se revierte.');

    /**
     * La fila cruda va a la satélite N2R.
     *
     * Acá **sí** van los identificadores enteros y la glosa sin depurar: es el único lugar del sistema donde
     * un dato de un tercero puede vivir, porque es el único con rol exigido en lectura y lector auditado.
     * Guardarla es lo que permite reinterpretar el lote cuando se descubre que el adaptador leyó mal una
     * columna — el dato de origen no se altera nunca (ADR-0000).
     */
    await conErroresTraducidos(m.filaNumero, () =>
      tx.consultar(
      `insert into movimiento_origen_crudo (cliente_id, movimiento_id, fila_origen)
       values ($1, $2, $3::jsonb)`,
      [
        pedido.clienteId,
        movimientoId,
        JSON.stringify({
          lineas: m.descripcionLineas ?? [m.descripcion],
          glosaOriginal: m.descripcion,
          identificadores: glosa.identificadores,
          columnaOrigen: m.columnaOrigen ?? null,
          candidatosIdentificacion: m.candidatosIdentificacion ?? [],
          referencias: m.referencias ?? [],
        }),
      ],
      ),
    );

    filas += 1;
  }

  /**
   * Los anexos, en la misma transacción y con el mismo todo-o-nada.
   *
   * ## Por qué esto existía como agujero y no como bug conocido
   *
   * `anexoExtractoSchema` estaba escrito desde el principio y **`persistirCuenta` nunca lo tocaba**: el
   * adaptador leía el bloque y esta función lo tiraba. No había ni una fila de código que lo mencionara, así
   * que no había nada que revisar — el dato desaparecía entre dos capas que cada una daba por sentado que la
   * otra se ocupaba.
   *
   * Lo destapó correr los tres adaptadores contra los archivos reales: un banco tenía sus **9 renglones de
   * anexo en el residuo**, otro capturaba **3 de 6**, y el tercero los perdía **sin dejar rastro** —ni en
   * `anexos` ni en `lineasNoInterpretadas`— porque su adaptador no reporta lo que cae fuera de la región de
   * tabla. **El que mejor puntuaba en "líneas no interpretadas" era el que más perdía.**
   *
   * Y lo que se perdía no es decorativo: entre esos renglones está el **importe computable como pago a
   * cuenta**, que no existe como movimiento y **no es derivable de ellos**.
   */
  const anexos = await persistirAnexos(tx, pedido);

  logger.info('persistencia.completada', {
    cliente_id: pedido.clienteId,
    lote_id: pedido.loteId,
    cuenta_bancaria_id: pedido.cuentaBancariaId,
    filas,
    anexos,
    verificacion_estado: pedido.verificacion.estado,
  });

  return { persistido: true, estado: decision.estado, filas };
}

/**
 * Espejo literal de `anexo_literal_sin_identificador_chk` (migración 0008). Ver el porqué en la puerta de
 * admisión de `persistirAnexos`: sin él, la app y la base no rechazan el mismo conjunto.
 */
const RE_LITERAL_CON_IDENTIFICADOR = /\d{7}/;

/**
 * Inserta los anexos de esta cuenta. Devuelve cuántos.
 *
 * ## El ordinal es del LOTE, no de la cuenta, y por eso se resuelve acá
 *
 * `uq_anexo_orden` es `(cliente_id, lote_ingesta_id, orden_en_lote)`: el anexo **no tiene clave natural**
 * —un banco imprime el mismo literal con dos espaciados y tiene tres renglones que pueden compartir
 * período— así que su identidad es la **posición en el documento**.
 *
 * El adaptador entrega el ordinal ya asignado sobre el lote entero. Esta función **no lo recalcula**: si lo
 * hiciera por cuenta, dos cuentas del mismo lote colisionarían en el `unique` y el segundo insert reventaría
 * la transacción entera.
 *
 * ## `atribucion_cuenta` decide si va la cuenta, no al revés
 *
 * `no_determinada` ⇒ `cuenta_bancaria_id` **null**, y hay un `check` de coherencia en la base que lo exige.
 * Es lo que impide que "no sé de qué cuenta es" se guarde como si fuera de ésta — que es la tentación
 * natural cuando estás iterando cuenta por cuenta.
 */
async function persistirAnexos(tx: Tx, pedido: PedidoDePersistencia): Promise<number> {
  let n = 0;
  for (const a of pedido.cuenta.anexos) {
    /**
     * INV-14, aplicado al literal del anexo.
     *
     * Acá **no hay una `descripcion` de la cual ser prefijo**, así que la garantía no se puede heredar como
     * en `concepto_banco`: se pone como **puerta de admisión**. Un anexo es un totalizador impositivo y no
     * una transacción —su contraparte es el fisco— así que ningún literal medido lleva un identificador de
     * un tercero. Pero "no hay caso medido" no es una garantía, y el `check`
     * `anexo_literal_sin_identificador_chk` de la base rechaza toda corrida de 7+ dígitos.
     *
     * Se verifica acá **antes** del insert para que el operador reciba un código de dominio y no una
     * violación de constraint traducida.
     *
     * 🔴 **Y por eso la puerta tiene que ser el ESPEJO EXACTO del `check`, no "algo parecido".**
     * `contieneIdentificador` **no lo es**: sus patrones llevan lookarounds que excluyen `[\d\-.,]`, así
     * que `RES. 1234567-2018` o `1234567,89` **pasan esta puerta y la base los rechaza igual**. El
     * resultado es justo lo que la puerta existe para evitar: una violación de constraint que voltea la
     * transacción del lote entero —1346 movimientos— por un renglón de anexo.
     *
     * El `check` es `[0-9]{7}` a secas. El espejo tiene que ser el mismo regex, y va **primero**.
     * `contieneIdentificador` se conserva porque es más estricto en otras direcciones (un CUIT con
     * guiones): los dos suman, ninguno reemplaza al otro.
     */
    if (RE_LITERAL_CON_IDENTIFICADOR.test(a.conceptoLiteral) || contieneIdentificador(a.conceptoLiteral)) {
      logger.warn('persistencia.rechazada', {
        cliente_id: pedido.clienteId,
        lote_id: pedido.loteId,
        motivo_codigo: 'anexo_literal_con_identificador',
      });
      throw new Error('anexo_literal_con_identificador');
    }

    const esDeLaCuenta = a.atribucionCuenta !== 'no_determinada';

    await conErroresTraducidos(undefined, () =>
      tx.consultar(
        `insert into anexo_extracto
           (cliente_id, lote_ingesta_id, cuenta_bancaria_id, atribucion_cuenta, orden_en_lote,
            pagina_pdf, concepto_literal, periodo_desde, periodo_hasta, periodo_dato,
            importe_declarado, moneda, alicuota_publicada, relacion_con_movimientos)
         values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11::numeric, $12, $13, $14)`,
        [
          pedido.clienteId,
          pedido.loteId,
          // La cuenta va SOLO si la atribución lo autoriza. Ver la nota de arriba.
          esDeLaCuenta ? pedido.cuentaBancariaId : null,
          a.atribucionCuenta,
          a.ordenEnLote,
          a.paginaPdf,
          a.conceptoLiteral,
          a.periodoDesde ?? null,
          a.periodoHasta ?? null,
          a.periodoDato,
          a.importeDeclarado,
          a.moneda,
          a.alicuotaPublicada ?? null,
          a.relacionConMovimientos,
        ],
      ),
    );
    n += 1;
  }
  return n;
}
