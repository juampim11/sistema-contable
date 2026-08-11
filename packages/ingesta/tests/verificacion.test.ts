/**
 * Condición de salida nº 12 — `verificarAritmetica` pura + las mutaciones.
 *
 * Dos bloques, y el segundo es el que importa:
 *   1. Que la verificación **calcule** el veredicto y las cinco ecuaciones funcionen.
 *   2. **La verificación del verificador**: cada mutación tiene que poner rojo a su detector.
 *
 * Todo con extractos SINTÉTICOS generados desde una especificación (ADR-0002 §F.1). Ningún dato real.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPACIDADES_SINTETICAS,
  extractoSintetico,
} from '../src/seed/extracto-sintetico.ts';
import {
  verificarAritmetica,
  verificarConsolidadoPorMoneda,
  verificarConteoDeCuentas,
  verificarDestinos,
} from '../src/verificacion/invariantes.ts';
import type { ConteoDeDestinos, DestinoBase } from '../src/adaptadores/toolkit.ts';
import { estadoSegunVerificacion } from '../src/persistir.ts';
import {
  CODIGO_ESPERADO,
  MUTACIONES,
  MUTACIONES_DE_TEXTO_PENDIENTES,
  mutar,
  type Mutacion,
} from '../src/verificacion/mutaciones.ts';
import {
  cuentaConMovimientosSchema,
  type CuentaConMovimientos,
  type Diferencia,
  type Moneda,
} from '../src/esquema.ts';

const BASE = extractoSintetico({
  semilla: 7,
  cantidadMovimientos: 40,
  saldoInicialCentavos: 599_474_53n,
  periodoDesde: '2026-06-01',
  periodoHasta: '2026-06-30',
});

const CONTEXTO = { capacidades: CAPACIDADES_SINTETICAS, coberturaDeLineasCompleta: true };

// -----------------------------------------------------------------------------
describe('el fixture sintético es coherente (si no, no puede probar nada)', () => {
  it('valida contra el esquema, incluido el refine que ata importe a su columna', () => {
    const r = cuentaConMovimientosSchema.safeParse(BASE);
    if (!r.success) {
      // Se imprime el CÓDIGO del problema, nunca el dato: es la regla del logging aplicada al test.
      throw new Error(`fixture inválido: ${r.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    }
    expect(r.success).toBe(true);
  });

  it('la cadena de saldos cierra y los totales declarados coinciden con el cuerpo', () => {
    const v = verificarAritmetica(BASE, CONTEXTO);
    expect(v.estado, `diferencias: ${v.diferencias.map((d) => d.codigo).join(',')}`).toBe('cuadra');
    expect(v.filasConRuptura).toEqual([]);
    expect(v.diferencias).toEqual([]);
  });

  it('ejercita los casos borde que rompen a un parser ingenuo', () => {
    // Repetidos: el mismo importe el mismo día. Es lo que obliga a que el hash no dependa de la posición.
    const claves = BASE.movimientos.map((m) => `${m.fecha}|${m.importe}`);
    expect(new Set(claves).size, 'el fixture debe tener (fecha, importe) repetidos').toBeLessThan(
      claves.length,
    );
    // Y aun así, todos los hashes distintos: el saldo es el discriminador.
    const hashes = BASE.movimientos.map((m) => m.filaHash);
    expect(new Set(hashes).size).toBe(hashes.length);
    // Saldo acreedor: la cuenta pasa a negativo en algún punto.
    expect(BASE.movimientos.some((m) => m.saldoEsAcreedor === true)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
describe('la verificación CALCULA, no le cree al adapter', () => {
  it('las sumas calculadas salen del cuerpo, no de lo declarado', () => {
    const v = verificarAritmetica(BASE, CONTEXTO);
    expect(v.totalCreditosCalculado).toBe(BASE.cuenta.totalCreditosDeclarado);
    expect(v.totalDebitosCalculado).toBe(BASE.cuenta.totalDebitosDeclarado);
    expect(v.cantidadMovimientos).toBe(BASE.movimientos.length);
  });

  it('declara QUÉ verificó, para que "no aplica" no se confunda con "está roto"', () => {
    const v = verificarAritmetica(BASE, CONTEXTO);
    expect(v.verificoTotales).toBe(true);
    expect(v.verificoSaldos).toBe(true);
    expect(v.verificoCadena).toBe(true);
    expect(v.cadenaDeSaldosUsada).toBe('completa');
  });

  it('un banco que NO publica totales da `no_verificable`, nunca `cuadra`', () => {
    const sinTotales = mutar(BASE, 'borrar_total_declarado');
    const capacidades = { ...CAPACIDADES_SINTETICAS, traeTotalesDeclarados: false };
    const v = verificarAritmetica(sinTotales, { ...CONTEXTO, capacidades });
    expect(v.verificoTotales).toBe(false);
    // La cadena sigue cerrando, así que hay algo verificado: cuadra por la cadena, no por los totales.
    expect(v.estado).toBe('cuadra');
    expect(v.diferencias).toEqual([]);
  });

  it('sin totales Y sin saldo por fila, no se puede verificar nada: `no_verificable`', () => {
    const capacidades = {
      ...CAPACIDADES_SINTETICAS,
      traeTotalesDeclarados: false,
      traeSaldoInicialDeclarado: false,
      traeSaldoPorFila: false,
      cadenaDeSaldos: 'no_disponible' as const,
    };
    const v = verificarAritmetica(BASE, { ...CONTEXTO, capacidades });
    expect(v.estado).toBe('no_verificable');
    // Y esto es lo que el contrato anterior permitía y ahora no: un `cuadra` sin nada verificado.
    expect(v.estado).not.toBe('cuadra');
  });

  it('una línea no interpretada en el cuerpo bloquea la persistencia', () => {
    const v = verificarAritmetica(BASE, { ...CONTEXTO, cantidadLineasNoInterpretadas: 1 });
    expect(v.estado).toBe('no_cuadra');
    // El criterio de "¿se persiste?" vive en UN solo lugar. `habilitaPersistir` era el segundo y se borró.
    expect(estadoSegunVerificacion(v, BASE.movimientos.length).persistir).toBe(false);
  });
});

// -----------------------------------------------------------------------------
describe('LA VERIFICACIÓN DEL VERIFICADOR — cada mutación pone rojo a su detector', () => {
  it.each(MUTACIONES.filter((m) => m !== 'borrar_total_declarado'))(
    'mutación "%s" es detectada',
    (mutacion: Mutacion) => {
      const mutado = mutar(BASE, mutacion);
      const v = verificarAritmetica(mutado, CONTEXTO);

      expect(v.estado, `la mutación "${mutacion}" pasó desapercibida`).toBe('no_cuadra');

      const codigos = new Set(v.diferencias.map((d) => d.codigo));
      const esperados = CODIGO_ESPERADO[mutacion];
      const alguno = esperados.some((c) => codigos.has(c as never));
      expect(
        alguno,
        `esperaba alguno de [${esperados.join(', ')}] y salieron [${[...codigos].join(', ')}]`,
      ).toBe(true);
    },
  );

  it('la cadena LOCALIZA la fila, no solo dice que no cuadra', () => {
    const mutado = mutar(BASE, 'borrar_fila_del_medio');
    const v = verificarAritmetica(mutado, CONTEXTO);
    // Es la diferencia entre un error detectado y un error depurable.
    expect(v.filasConRuptura.length).toBeGreaterThan(0);
    const conFila = v.diferencias.filter((d) => d.filaNumero !== undefined);
    expect(conFila.length).toBeGreaterThan(0);
  });

  it('la cadena es inmune a la compensación: una fila duplicada MÁS una perdida', () => {
    // Los totales pueden quedar intactos si los dos errores se cancelan; la cadena rompe DOS eslabones.
    //
    // Los índices son distintos A PROPÓSITO: con el índice por defecto, duplicar y borrar caen en la misma
    // posición y se cancelan exactamente — el dato queda correcto y la verificación dice `cuadra`, con
    // razón. Fue un bug de este test, no del detector, y lo encontró el propio test.
    const paso1 = mutar(BASE, 'duplicar_fila', { indice: 10 });
    const paso2 = mutar(paso1, 'borrar_fila_del_medio', { indice: 30 });
    const v = verificarAritmetica(paso2, CONTEXTO);
    expect(v.estado).toBe('no_cuadra');
    expect(v.filasConRuptura.length).toBeGreaterThan(0);
  });

  it('las dos sumas van por separado: un crédito cargado como débito no se cancela solo', () => {
    const mutado = mutar(BASE, 'invertir_signo_de_un_debito');
    const v = verificarAritmetica(mutado, CONTEXTO);
    const codigos = v.diferencias.map((d) => d.codigo);
    // Σcréditos y Σdébitos se comparan por separado contra lo declarado: los dos se corren.
    expect(codigos).toContain('ARIT_TOTAL_CREDITOS');
    expect(codigos).toContain('ARIT_TOTAL_DEBITOS');
  });

  it('"0 movimientos" NUNCA es éxito', () => {
    const v = verificarAritmetica(mutar(BASE, 'vaciar_movimientos'), CONTEXTO);
    expect(v.estado).toBe('no_cuadra');
    expect(v.diferencias.map((d) => d.codigo)).toContain('EST_SIN_MOVIMIENTOS');
    expect(estadoSegunVerificacion(v, 0).persistir).toBe(false);
  });

  it('ninguna diferencia lleva un valor: solo código, fila y página', () => {
    // Es la lección de ADR-0002 §D: prosa con importes adentro es cómo un N2 llega a un log.
    for (const m of MUTACIONES) {
      const v = verificarAritmetica(mutar(BASE, m), CONTEXTO);
      for (const d of v.diferencias) {
        const claves = Object.keys(d).sort();
        expect(claves.every((k) => ['codigo', 'severidad', 'filaNumero', 'paginaPdf', 'campo'].includes(k))).toBe(
          true,
        );
      }
    }
  });
});

// -----------------------------------------------------------------------------
describe('mutaciones de TEXTO — pendientes, declaradas para no omitirlas', () => {
  it('la lista está escrita y llega con el adapter (E3)', () => {
    // No se omiten en silencio: una de ellas —la glosa corrida— es el PEOR modo de falla del módulo,
    // porque sobrevive a todas las redes aritméticas y arruina justo lo que hace valioso al PDF.
    expect(MUTACIONES_DE_TEXTO_PENDIENTES).toContain(
      'mover_ultima_linea_de_descripcion_al_bloque_siguiente',
    );
    expect(MUTACIONES_DE_TEXTO_PENDIENTES.length).toBe(4);
  });

  it.todo('mover la última línea de descripción al bloque siguiente → EST_PAR_NO_EN_ULTIMA_LINEA');
  it.todo('borrar una página entera → EST_PAGINA_FALTANTE');
  it.todo('borrar la línea de totales del texto → no_verificable');
  it.todo('vaciar el texto de dos páginas → PDF_PAGINA_SIN_TEXTO');
});

// -----------------------------------------------------------------------------
/**
 * INV-multicuenta — la única ecuación que cruza cuentas.
 *
 * Todo lo que `verificarAritmetica` chequea se calcula **dentro** de una cuenta, así que cierra igual si el
 * adaptador se comió la separación. Medido en un banco del roster: mezclar sus tres cuentas produce **1
 * ruptura sobre 1346 filas = 0,07 %**, o sea que pasa cualquier umbral de tolerancia y deja persistida una
 * cuenta que no existe con dos saldos encimados. Este es el control que lo ve.
 */
describe('INV-multicuenta: el consolidado por moneda contra la suma de los saldos finales', () => {
  const cuentaDe = (moneda: Moneda, saldoFinalDeclarado?: string): CuentaConMovimientos => ({
    cuenta: {
      denominacion: 'CUENTA DE PRUEBA',
      tipoCuenta: 'cuenta_corriente',
      moneda,
      ...(saldoFinalDeclarado === undefined ? {} : { saldoFinalDeclarado }),
    },
    movimientos: [],
    anexos: [],
  });

  const codigos = (r: { readonly diferencias: readonly Diferencia[] }): readonly (string | undefined)[] =>
    r.diferencias.map((d) => d.campo ?? d.codigo);

  it('dos cuentas en pesos que suman el consolidado: cuadra', () => {
    const r = verificarConsolidadoPorMoneda(
      [cuentaDe('ARS', '-98765.43'), cuentaDe('ARS', '1234.56')],
      [{ moneda: 'ARS', importe: '-97530.87' }],
    );
    expect(r.verificado).toBe(true);
    expect(r.diferencias).toHaveLength(0);
  });

  /**
   * **El caso que justifica la invariante entera.** Si el adaptador mezcla las dos cuentas en una, la
   * cuenta resultante declara un solo saldo final —el de la última— y el consolidado deja de dar. Es lo
   * único que no cierra: la cadena de saldos de la cuenta inventada se rompe en un solo eslabón.
   */
  it('si se mezclaron dos cuentas en una, la suma ya no da', () => {
    const mezclada = [cuentaDe('ARS', '-98765.43')];
    const r = verificarConsolidadoPorMoneda(mezclada, [{ moneda: 'ARS', importe: '-97530.87' }]);
    expect(codigos(r)).toEqual(['EST_CONSOLIDADO_MONEDA']);
  });

  it('cada moneda se suma por separado: los pesos no se mezclan con los dólares', () => {
    const r = verificarConsolidadoPorMoneda(
      [cuentaDe('ARS', '1000.00'), cuentaDe('USD', '25.00')],
      [
        { moneda: 'ARS', importe: '1000.00' },
        { moneda: 'USD', importe: '25.00' },
      ],
    );
    expect(r.diferencias).toHaveLength(0);
  });

  /**
   * Las tres formas de "no puedo compararlo" son `error` y no observación, y es deliberado: el valor entero
   * de esta invariante es detectar que **falta una cuenta**, así que "falta el dato para compararla" no es
   * una atenuante — es el síntoma.
   */
  it('una cuenta sin saldo final declarado no se degrada a "no aplica"', () => {
    const r = verificarConsolidadoPorMoneda(
      [cuentaDe('ARS', '1000.00'), cuentaDe('ARS')],
      [{ moneda: 'ARS', importe: '1000.00' }],
    );
    expect(codigos(r)).toEqual(['saldo_final_ausente']);
  });

  it('el banco consolida una moneda de la que no se leyó ninguna cuenta: se perdió una cuenta entera', () => {
    const r = verificarConsolidadoPorMoneda(
      [cuentaDe('ARS', '1000.00')],
      [
        { moneda: 'ARS', importe: '1000.00' },
        { moneda: 'USD', importe: '25.00' },
      ],
    );
    expect(codigos(r)).toEqual(['moneda_sin_cuenta']);
  });

  it('se leyó una cuenta de una moneda que la carátula no consolida', () => {
    const r = verificarConsolidadoPorMoneda(
      [cuentaDe('ARS', '1000.00'), cuentaDe('USD', '25.00')],
      [{ moneda: 'ARS', importe: '1000.00' }],
    );
    expect(codigos(r)).toEqual(['moneda_sin_consolidado']);
  });

  it('dos renglones de consolidado para la misma moneda es un hallazgo', () => {
    const r = verificarConsolidadoPorMoneda(
      [cuentaDe('ARS', '1000.00')],
      [
        { moneda: 'ARS', importe: '1000.00' },
        { moneda: 'ARS', importe: '1000.00' },
      ],
    );
    expect(codigos(r)).toContain('consolidado_duplicado');
  });

  /**
   * El banco que no publica consolidado —el primero del roster— da `verificado: false` **sin diferencias**.
   * Es la misma distinción que `no_verificable` hace con `cuadra`: "no hay contra qué comparar" no es
   * "comparé y dio bien".
   */
  it('sin consolidado publicado: no verificado, y NO es cuadra', () => {
    const r = verificarConsolidadoPorMoneda([cuentaDe('ARS', '1000.00')], []);
    expect(r.verificado).toBe(false);
    expect(r.diferencias).toHaveLength(0);
  });

  it('ninguna diferencia lleva un valor: solo código, severidad y campo', () => {
    const r = verificarConsolidadoPorMoneda(
      [cuentaDe('ARS', '1.00'), cuentaDe('USD', '2.00')],
      [{ moneda: 'ARS', importe: '999.00' }],
    );
    for (const d of r.diferencias) {
      const claves = Object.keys(d);
      expect(claves.every((k) => ['codigo', 'severidad', 'filaNumero', 'paginaPdf', 'campo'].includes(k))).toBe(
        true,
      );
    }
  });
});

// -----------------------------------------------------------------------------
/**
 * Las dos invariantes que un banco real falsificó, y que ahora se **declaran** en vez de cablearse.
 *
 * Las dos tenían la misma forma: una regla que parecía universal, que es verdadera en el primer banco, y que
 * aplicada al segundo o al tercero **pone rojo un archivo correcto**. La salida no es relajarlas para todos
 * —eso apaga el control donde sí sirve— sino declarar la propiedad del banco y que la verificación la lea.
 */
describe('lo que declara el banco cambia la severidad, no la existencia del control', () => {
  const conFechaDeOtroMes = {
    ...BASE,
    movimientos: BASE.movimientos.map((m, i) =>
      i === 0 ? { ...m, fecha: '2026-05-20' } : m,
    ),
  };

  it('por defecto, una fecha fuera del período pone el lote en rojo', () => {
    const v = verificarAritmetica(conFechaDeOtroMes, CONTEXTO);
    expect(v.estado).toBe('no_cuadra');
    expect(v.fechasDentroDelPeriodo).toBe(false);
  });

  /**
   * El tercer banco arranca la cuenta corriente con **4 movimientos de octubre en un resumen de noviembre**,
   * con glosas del propio banco. Son legítimos: la regla "toda fecha cae dentro del período" es **falsa**
   * ahí. Baja a observación y el hecho se sigue escribiendo.
   */
  it('un banco que declara arrastrar movimientos de otro mes: observación, no error', () => {
    const capacidades = { ...CAPACIDADES_SINTETICAS, traeMovimientosFueraDelPeriodo: true };
    const v = verificarAritmetica(conFechaDeOtroMes, { ...CONTEXTO, capacidades });

    expect(v.estado).toBe('cuadra');
    // El dato NO se pierde: sigue reportado, con su fila, y el flag sigue diciendo la verdad.
    expect(v.fechasDentroDelPeriodo).toBe(false);
    const fuera = v.diferencias.filter((d) => d.codigo === 'EST_FECHA_FUERA_DE_PERIODO');
    expect(fuera).toHaveLength(1);
    expect(fuera[0]?.severidad).toBe('observacion');
    expect(fuera[0]?.filaNumero).toBe(1);
  });

  it('la relajación NO alcanza a las fechas desordenadas, que siguen siendo error', () => {
    const capacidades = { ...CAPACIDADES_SINTETICAS, traeMovimientosFueraDelPeriodo: true };
    const desordenado = {
      ...BASE,
      movimientos: BASE.movimientos.map((m, i) =>
        i === 5 ? { ...m, fecha: BASE.cuenta.periodoDesde ?? m.fecha } : m,
      ),
    };
    const v = verificarAritmetica(desordenado, { ...CONTEXTO, capacidades });
    expect(v.diferencias.map((d) => d.codigo)).toContain('EST_FECHA_NO_MONOTONA');
    expect(v.estado).toBe('no_cuadra');
  });

  /**
   * `EST_SIN_MOVIMIENTOS` con alcance de **archivo**, no de cuenta.
   *
   * El segundo banco publica dos cuentas en un archivo y la de dólares viene vacía, con la leyenda impresa
   * del propio banco. Aplicada por cuenta, la regla rechaza el lote entero y se lleva puestos los 158
   * movimientos correctos de la cuenta en pesos.
   */
  /**
   * La cuenta vacía **legítima**, con la forma que tiene en el archivo real: trae su saldo inicial, su saldo
   * final —iguales— y la leyenda impresa del banco, y **no declara totales**.
   *
   * Escrita a mano y no derivada del fixture de 40 movimientos: `{...BASE, movimientos: []}` conserva los
   * totales declarados de esas 40 filas, así que da `no_cuadra` por `ARIT_TOTAL_CREDITOS` — un rojo que no
   * tiene nada que ver con lo que este bloque prueba. Lo encontró este mismo test.
   */
  const CUENTA_VACIA_LEGITIMA: CuentaConMovimientos = {
    cuenta: {
      denominacion: 'CUENTA CORRIENTE ESPECIAL EN DOLARES',
      tipoCuenta: 'cuenta_corriente_especial',
      moneda: 'USD',
      periodoDesde: '2026-06-01',
      periodoHasta: '2026-06-30',
      saldoInicialDeclarado: '0.00',
      saldoFinalDeclarado: '0.00',
    },
    movimientos: [],
    anexos: [],
  };

  const CONTEXTO_SIN_TOTALES = {
    ...CONTEXTO,
    capacidades: { ...CAPACIDADES_SINTETICAS, traeTotalesDeclarados: false },
  };

  it('una cuenta vacía dentro de un lote que trajo movimientos es observación, no error', () => {
    const v = verificarAritmetica(CUENTA_VACIA_LEGITIMA, {
      ...CONTEXTO_SIN_TOTALES,
      movimientosEnElLote: 158,
    });

    const sinMov = v.diferencias.filter((d) => d.codigo === 'EST_SIN_MOVIMIENTOS');
    expect(sinMov[0]?.severidad).toBe('observacion');
    // `no_verificable` y no `cuadra`: no hay nada que verificar en una cuenta sin movimientos. Lo que
    // importa es que NO sea `no_cuadra`, que es lo que se llevaría puesto el lote entero.
    expect(v.estado).toBe('no_verificable');
  });

  it('si el LOTE entero está en cero, sigue siendo error: es el parser que no leyó nada', () => {
    const v = verificarAritmetica(CUENTA_VACIA_LEGITIMA, {
      ...CONTEXTO_SIN_TOTALES,
      movimientosEnElLote: 0,
    });
    expect(v.estado).toBe('no_cuadra');
    expect(v.diferencias.map((d) => d.codigo)).toContain('EST_SIN_MOVIMIENTOS');
  });

  it('sin el dato del lote se mantiene la regla estricta: el default falla del lado seguro', () => {
    const v = verificarAritmetica(CUENTA_VACIA_LEGITIMA, CONTEXTO_SIN_TOTALES);
    expect(v.estado).toBe('no_cuadra');
  });

  /**
   * Y el corolario en la persistencia: la cuenta vacía **se guarda**, con cero movimientos. No es un
   * detalle de completitud — su saldo final declarado es justamente lo que INV-multicuenta necesita para
   * que la suma por moneda cierre.
   */
  it('la cuenta vacía legítima se persiste con observaciones; sola, no se persiste', () => {
    const v = verificarAritmetica(CUENTA_VACIA_LEGITIMA, {
      ...CONTEXTO_SIN_TOTALES,
      movimientosEnElLote: 158,
    });

    expect(estadoSegunVerificacion(v, 0, { movimientosEnElLote: 158 })).toEqual({
      persistir: true,
      estado: 'procesado_con_observaciones',
    });
    expect(estadoSegunVerificacion(v, 0)).toEqual({
      persistir: false,
      motivoCodigo: 'sin_movimientos',
    });
  });

  /**
   * 🔴 **El agujero que encontró el panel**, y es el peor de E1.
   *
   * La primera versión de la excepción retornaba **antes** del `switch (verificacion.estado)`, o sea que
   * aceptaba la cuenta vacía sin mirar nunca si cuadraba. Una cuenta vacía cuyo saldo inicial declarado ≠
   * saldo final declarado **no es la cuenta legítima**: es el síntoma de que el parser perdió sus
   * movimientos, o de que le colgó el `SALDO FINAL` de otra cuenta. Y no lo tapa nada más: INV-multicuenta
   * compara contra el saldo *declarado*, que sigue sumando bien.
   */
  it('una cuenta VACÍA cuya aritmética no cuadra NO se persiste, aunque el lote tenga movimientos', () => {
    const vaciaRota: CuentaConMovimientos = {
      ...CUENTA_VACIA_LEGITIMA,
      cuenta: {
        ...CUENTA_VACIA_LEGITIMA.cuenta,
        saldoInicialDeclarado: '100.00',
        saldoFinalDeclarado: '2500.00', // ← sin movimientos, 100 ≠ 2500
      },
    };
    const v = verificarAritmetica(vaciaRota, { ...CONTEXTO_SIN_TOTALES, movimientosEnElLote: 158 });

    expect(v.estado).toBe('no_cuadra');
    expect(v.diferencias.map((d) => d.codigo)).toContain('ARIT_SALDO_FINAL');
    expect(estadoSegunVerificacion(v, 0, { movimientosEnElLote: 158 })).toEqual({
      persistir: false,
      motivoCodigo: 'ARIT_SALDO_FINAL',
    });
  });

  /**
   * El complemento del anterior, y el que faltaba en el gate: `movimientosEnElLote: 0` explícito. Sin este
   * test, cambiar la condición a `!== undefined` no pondría rojo nada — y un lote donde **todas** las
   * cuentas están vacías se persistiría con cero filas y estado `procesado_con_observaciones`.
   */
  it('con el lote explícitamente en cero, la cuenta vacía no se persiste', () => {
    const v = verificarAritmetica(CUENTA_VACIA_LEGITIMA, {
      ...CONTEXTO_SIN_TOTALES,
      movimientosEnElLote: 0,
    });
    expect(estadoSegunVerificacion(v, 0, { movimientosEnElLote: 0 })).toEqual({
      persistir: false,
      motivoCodigo: 'sin_movimientos',
    });
  });
});

// -----------------------------------------------------------------------------
/**
 * La asimetría que impide que INV-multicuenta se apague sola.
 *
 * Sin esto, "el banco no publica consolidado" y "el parser de carátula no lo encontró" se ven exactamente
 * igual — y el segundo desactiva, en silencio, el único control que ve una mezcla de cuentas. En el banco
 * donde más falta hace, además, el literal viene con **dos espaciados distintos en el mismo archivo**.
 */
describe('INV-multicuenta: el banco declara si publica consolidado', () => {
  const cuentaARS: CuentaConMovimientos = {
    cuenta: {
      denominacion: 'X',
      tipoCuenta: 'cuenta_corriente',
      moneda: 'ARS',
      saldoFinalDeclarado: '1000.00',
    },
    movimientos: [],
    anexos: [],
  };

  it('el banco NO lo publica y la lista viene vacía: no verificado, sin diferencias', () => {
    const r = verificarConsolidadoPorMoneda([cuentaARS], [], { declaraConsolidado: false });
    expect(r.verificado).toBe(false);
    expect(r.diferencias).toHaveLength(0);
  });

  it('🔴 el banco SÍ lo publica y la lista viene vacía: el parser falló, y es error', () => {
    const r = verificarConsolidadoPorMoneda([cuentaARS], [], { declaraConsolidado: true });
    expect(r.verificado).toBe(false);
    expect(r.diferencias).toHaveLength(1);
    expect(r.diferencias[0]?.severidad).toBe('error');
    expect(r.diferencias[0]?.campo).toBe('consolidado_no_encontrado');
  });

  it('sin declarar la capacidad se conserva el comportamiento anterior', () => {
    expect(verificarConsolidadoPorMoneda([cuentaARS], []).diferencias).toHaveLength(0);
  });

  /** Un consolidado que se leyó pero no se pudo parsear no es "la suma no da": el `campo` los separa. */
  it('un consolidado ilegible se reporta con su propio campo', () => {
    const r = verificarConsolidadoPorMoneda(
      [cuentaARS],
      [{ moneda: 'ARS', importe: 'no-es-un-importe' as never }],
      { declaraConsolidado: true },
    );
    expect(r.diferencias[0]?.campo).toBe('consolidado_ilegible');
  });

  /**
   * 🔴 **El agujero que el consolidado NO puede ver**, y por eso hace falta el conteo.
   *
   * Una cuenta inactiva —cero movimientos, saldo final `0,00`— cuya sección el adaptador **nunca abre**:
   * la suma del consolidado **cuadra igual** (sumarle cero no cambia nada), ninguna cadena se rompe, y
   * `EST_SIN_MOVIMIENTOS` no dispara porque la cuenta no existe. Lote `procesado`, y una cuenta bancaria
   * entera desaparecida sin pasar por INV-6.
   */
  it('el consolidado NO detecta una cuenta con saldo 0,00 que nunca se abrió; el conteo SÍ', () => {
    const declarado = [{ moneda: 'ARS' as const, importe: '1000.00' }];

    // Se leyó UNA cuenta; el documento declara DOS (la segunda, inactiva en 0,00, se perdió).
    const r = verificarConsolidadoPorMoneda([cuentaARS], declarado, { declaraConsolidado: true });
    expect(r.diferencias).toHaveLength(0); // ← el consolidado cuadra, y está bien: 1000 + 0 = 1000

    expect(verificarConteoDeCuentas(1, 2)).toHaveLength(1);
    expect(verificarConteoDeCuentas(1, 2)[0]?.codigo).toBe('EST_CUENTAS_NO_COINCIDEN');
  });
});

// -----------------------------------------------------------------------------
describe('el conteo de cuentas declarado por el documento', () => {
  it('coinciden: sin diferencias', () => {
    expect(verificarConteoDeCuentas(3, 3)).toHaveLength(0);
  });

  it('el adaptador leyó de MENOS: se perdió una cuenta', () => {
    expect(verificarConteoDeCuentas(2, 3)[0]?.codigo).toBe('EST_CUENTAS_NO_COINCIDEN');
  });

  /**
   * De más también es error, y es el otro modo de falla de la sectorización: el encabezado se repite una
   * vez por página, y sin deduplicar por número el adaptador emite decenas de cuentas para tres.
   */
  it('el adaptador leyó de MÁS: la deduplicación de secciones falló', () => {
    expect(verificarConteoDeCuentas(47, 3)[0]?.codigo).toBe('EST_CUENTAS_NO_COINCIDEN');
  });

  it('un banco que no publica el dato no corre el control, y NO se degrada a cuadra', () => {
    expect(verificarConteoDeCuentas(1, undefined)).toHaveLength(0);
  });

  /** El diagnóstico no es canal de fuga: no se publican los dos números. */
  it('la diferencia no lleva ningún número adentro', () => {
    const d = verificarConteoDeCuentas(2, 3)[0];
    expect(d?.campo).toBeUndefined();
    expect(Object.keys(d ?? {}).sort()).toEqual(['codigo', 'severidad']);
  });
});

// -----------------------------------------------------------------------------
// A2 (C5) — el gate de residuo: `verificarDestinos`
// -----------------------------------------------------------------------------

/**
 * Fixture mínimo de `ConteoDeDestinos<DestinoBase>`: todos los destinos en 0 salvo los que el test
 * pisa. `total` no importa para `verificarDestinos` (no lo lee), así que se completa por consistencia
 * del tipo y no se usa como aserción.
 */
function destinosDe(
  over: { readonly sinDestino?: number; readonly residuo?: number; readonly fueraDelCuerpo?: number } = {},
): ConteoDeDestinos<DestinoBase> {
  const conteo: Record<DestinoBase, number> = {
    movimiento: 0,
    continuacion: 0,
    saldoDeclarado: 0,
    ruido: 0,
    anexo: 0,
    fueraDelCuerpo: over.fueraDelCuerpo ?? 0,
    residuo: over.residuo ?? 0,
  };
  const sinDestino = over.sinDestino ?? 0;
  const total = sinDestino + Object.values(conteo).reduce((a, b) => a + b, 0);
  return { ...conteo, sinDestino, total };
}

describe('verificarDestinos — el gate de residuo (A2, C5)', () => {
  it('caso A: sin destinos y el adaptador no declara → no aplica todavía, no "cuadra"', () => {
    expect(verificarDestinos(undefined, false)).toEqual([]);
  });

  it('caso B: sin destinos y el adaptador SÍ declara → prometió el conteo y no llegó', () => {
    const r = verificarDestinos(undefined, true);
    expect(r).toEqual([{ codigo: 'EST_DESTINOS_NO_DECLARADOS', severidad: 'error' }]);
  });

  it('caso C: sinDestino > 0 → la partición no cierra', () => {
    const r = verificarDestinos(destinosDe({ sinDestino: 1 }), true);
    expect(r).toEqual([{ codigo: 'EST_DESTINOS_SIN_CLASIFICAR', severidad: 'error' }]);
  });

  it("caso C': sinDestino = 0 (control negativo) → sin diferencias", () => {
    expect(verificarDestinos(destinosDe({ sinDestino: 0 }), true)).toEqual([]);
  });

  /**
   * Severidad `observacion`, no `error`: contingencia aplicada (2026-08-11, confirmación con el
   * usuario contra archivo real de Santander — ver el comentario en `verificarDestinos`). El residuo
   * sigue reportado (código exacto, se sigue viendo en el log), pero no rechaza el lote mientras se
   * termina de investigar (`docs/diseno/10-deuda-declarada.md`).
   */
  it('caso D: residuo > 0 → reusa EST_LINEA_NO_INTERPRETADA, severidad observación (contingencia)', () => {
    const r = verificarDestinos(destinosDe({ residuo: 1 }), true);
    expect(r).toEqual([{ codigo: 'EST_LINEA_NO_INTERPRETADA', severidad: 'observacion' }]);
  });

  it('caso E: fueraDelCuerpo > 0 (resto en 0) → NINGUNA diferencia — es la distinción entera del diseño', () => {
    const r = verificarDestinos(destinosDe({ fueraDelCuerpo: 5 }), true);
    expect(r).toEqual([]);
  });

  it('caso F: sinDestino Y residuo a la vez → las DOS diferencias, cada una con su propia severidad', () => {
    const r = verificarDestinos(destinosDe({ sinDestino: 1, residuo: 1 }), true);
    expect(r).toEqual([
      { codigo: 'EST_DESTINOS_SIN_CLASIFICAR', severidad: 'error' },
      { codigo: 'EST_LINEA_NO_INTERPRETADA', severidad: 'observacion' },
    ]);
  });
});
