/**
 * Generador de extractos SINTÉTICOS — ADR-0002 §F.1 y condición de salida nº 10.
 *
 * ## Por qué un generador y no un archivo recortado
 *
 * Al repo entran fixtures sintéticos, nunca un extracto real (ni recortado, ni "anonimizado a mano"). Y la
 * forma correcta no es guardar un archivo derivado del real: es **escribir la especificación del formato y
 * generar desde ahí**. Tres motivos:
 *
 *   1. **No existe nunca un archivo intermedio derivado del real**, que es donde se pierde el control.
 *   2. La especificación queda **documentada y revisable en un PR** — un `.txt` se lee, un PDF no.
 *   3. Se puede **mutar programáticamente**, que es lo que exige `mutaciones.test.ts`.
 *
 * ## Lo que se conserva (es la especificación del formato: N0) y lo que se reemplaza
 *
 * Se conserva la **forma**: la cadena de saldos que cierra, la línea de totales que cuadra, importes
 * signados con débito negativo, saldo con notación de saldo acreedor, descripciones multilínea, y las
 * repeticiones que rompen a un parser ingenuo (mismo importe el mismo día, saldos que pasan a negativo).
 *
 * Se reemplaza **todo** el contenido: importes **regenerados, no escalados** (escalar es reversible por
 * división contra los totales publicados), nombres obviamente ficticios, y CUIT/CBU con **dígito
 * verificador deliberadamente inválido** — un CUIT "válido" generado al azar **pertenece a un
 * contribuyente real**.
 *
 * ## Y el principio del piloto
 *
 * El generador toma **parámetros**, no supuestos: cantidad de movimientos, saldo inicial, si el banco
 * publica saldo por fila, si publica signo. Cuando llegue el formato real de un banco nuevo, se describe
 * con parámetros; no se escribe otro generador.
 */

import { centavosAImporte, importeCanonicoACentavos, type ImporteCanonico } from '../parseo-ar.ts';
import { asignarOrdinales, hashFila, type ClaveCuenta } from '../hash.ts';
import { cuitSintetico, prng, razonSocialSintetica } from '@sistema-contable/data';
import { cuentaConMovimientosSchema } from '../esquema.ts';
import type {
  CapacidadesAdaptador,
  CuentaConMovimientos,
  MovimientoBancarioCrudo,
} from '../esquema.ts';

export type OpcionesExtractoSintetico = {
  readonly semilla: number;
  readonly cantidadMovimientos: number;
  /** En centavos, para que el caller no tenga que pensar en la representación. */
  readonly saldoInicialCentavos: bigint;
  readonly periodoDesde: string;
  readonly periodoHasta: string;
  readonly moneda?: 'ARS' | 'USD';
  readonly bancoCodigo?: string;
  /** Fuerza al menos un par de filas con el mismo (fecha, importe): ejercita el dedupe y el ordinal. */
  readonly conRepetidos?: boolean;
  /** Fuerza que el saldo pase a negativo en algún punto: ejercita la notación de saldo acreedor. */
  readonly conSaldoAcreedor?: boolean;
};

const GLOSAS_SINTETICAS = [
  'CONCEPTO DE PRUEBA UNO',
  'CONCEPTO DE PRUEBA DOS',
  'MOVIMIENTO SIMULADO A',
  'MOVIMIENTO SIMULADO B',
  'CARGO FICTICIO MENSUAL',
  'ACREDITACION SIMULADA',
] as const;

export const CAPACIDADES_SINTETICAS: CapacidadesAdaptador = {
  familiaLayout: 'columnas-posicionales',
  cadenaDeSaldos: 'completa',
  traeTotalesDeclarados: true,
  traeSaldoInicialDeclarado: true,
  traeSignoEnElImporte: true,
  traeSaldoPorFila: true,
  traeFechaValor: false,
  traeReferencia: true,
  traeCodigoDeConcepto: true,
  anioEnLaFecha: true,
  multiCuenta: false,
  multiMoneda: false,
  // El generador sintético produce todas las fechas dentro del período: es el caso base del control.
  traeMovimientosFueraDelPeriodo: false,
  // El generador produce UNA cuenta: no hay consolidado por moneda.
  traeConsolidadoPorMoneda: false,
  // El fixture sintético no instrumenta destinos: no hay adaptador real detrás de este generador.
  declaraDestinos: false,
};

/**
 * Genera una cuenta con movimientos **coherente**: la cadena de saldos cierra, los totales declarados
 * coinciden con la suma del cuerpo, y el saldo final declarado es el de la última fila.
 *
 * Esa coherencia no es cosmética: un fixture cuyos totales no cuadran **no puede probar la verificación**,
 * que es justamente el control que se está construyendo.
 */
export function extractoSintetico(opciones: OpcionesExtractoSintetico): CuentaConMovimientos {
  const {
    semilla,
    cantidadMovimientos,
    saldoInicialCentavos,
    periodoDesde,
    periodoHasta,
    moneda = 'ARS',
    bancoCodigo = 'sintetico',
    conRepetidos = true,
    conSaldoAcreedor = true,
  } = opciones;

  const rnd = prng(semilla);
  const entero = (min: number, max: number): number => min + Math.floor(rnd() * (max - min + 1));

  const numeroCuenta = `999${String(entero(1000, 9999))}0`;
  const claveCuenta: ClaveCuenta = { bancoCodigo, numeroNormalizado: numeroCuenta, moneda };

  const diaDesde = Number(periodoDesde.slice(8, 10));
  const mes = periodoHasta.slice(0, 7);

  type Borrador = Omit<MovimientoBancarioCrudo, 'filaHash'>;

  const borradores: Borrador[] = [];
  let saldo = saldoInicialCentavos;
  let importeAnterior = 0n;

  for (let i = 0; i < cantidadMovimientos; i += 1) {
    // Repetición deliberada: cada tercer movimiento repite el importe del anterior en el mismo día.
    const repetir = conRepetidos && i % 3 === 0 && i > 0;
    const magnitud = repetir ? (importeAnterior < 0n ? -importeAnterior : importeAnterior) : BigInt(entero(10_00, 500_000_00));

    /**
     * Empujar el saldo a negativo alrededor del 60% del recorrido, para ejercitar el saldo acreedor.
     *
     * ## El bug que tenía esta línea
     *
     * Calculaba el importe forzado como `-(saldo + margen)`. Si el saldo **ya era negativo** y
     * `saldo + margen` daba negativo, el `-` lo volvía **positivo**: el importe quedaba positivo (un
     * crédito) guardado en la columna `debito`. El generador producía un fixture **incoherente**, y sobre
     * ese fixture la verificación decía `no_cuadra` con razón — pero por culpa del generador, no del
     * verificador.
     *
     * Es el modo de falla más caro de todos: cuando el fixture está mal, el reflejo es relajar el
     * verificador hasta que pase.
     */
    const forzarDebitoGrande = conSaldoAcreedor && i === Math.floor(cantidadMovimientos * 0.6);
    const esDebito = forzarDebitoGrande || rnd() < 0.5;
    const importeCentavos = esDebito
      ? // Siempre negativo: si el saldo ya está en descubierto, alcanza con el margen para profundizarlo.
        -(forzarDebitoGrande ? (saldo > 0n ? saldo : 0n) + 50_000_00n : magnitud)
      : magnitud;

    saldo += importeCentavos;
    importeAnterior = importeCentavos;

    const dia = Math.min(28, diaDesde + Math.floor(i / 2));
    const fecha = `${mes}-${String(dia).padStart(2, '0')}`;
    const glosa = GLOSAS_SINTETICAS[entero(0, GLOSAS_SINTETICAS.length - 1)] ?? 'CONCEPTO DE PRUEBA';
    const contraparte = razonSocialSintetica(rnd, i);
    const cuit = cuitSintetico(rnd);

    const importe = centavosAImporte(importeCentavos);
    const magnitudCanonica = centavosAImporte(importeCentavos < 0n ? -importeCentavos : importeCentavos);

    borradores.push({
      tipoFila: 'movimiento',
      fecha,
      descripcionLineas: [glosa, contraparte, cuit],
      // ⚠️ La descripción NO incluye el CUIT: es el invariante INV-13, y es lo que sostiene que esta
      // columna sea N2 y no N2R. El identificador va a su campo propio.
      descripcion: `${glosa} | ${contraparte}`,
      /**
       * INV-14: `conceptoBanco` es **prefijo de `descripcion`**, y acá se ve por construcción —
       * `descripcion` es `${glosa} | ${contraparte}`—. El fixture tiene que cumplir el mismo invariante
       * que la base exige (`mov_crudo_concepto_prefijo_chk`): un fixture que lo viole no puede probar la
       * persistencia, y encima consagraría el malentendido.
       */
      conceptoBanco: glosa,
      /** El generador no trunca: el concepto entra entero. Se declara, no se asume. */
      conceptoCompleto: true,
      conceptoBancoEstrategia: 'segmento_de_glosa',
      conceptoCodigo: String(900000 + entero(100, 999)),
      conceptoGrupoCodigo: String(900 + entero(1, 99)),
      contraparteNombre: contraparte,
      candidatosIdentificacion: [
        { tipo: 'cuit', valor: cuit, lineaIndice: 2, verificadorValido: false },
      ],
      referencias: [{ tipo: 'operacion', valor: String(entero(10_000_000, 99_999_999)) }],
      columnaOrigen: esDebito ? 'debito' : 'credito',
      ...(esDebito ? { debito: magnitudCanonica } : { credito: magnitudCanonica }),
      importe,
      saldo: centavosAImporte(saldo),
      saldoEsAcreedor: saldo < 0n,
      moneda,
      cotizacionProvista: false,
      filaNumero: i + 1,
      paginaPdf: 1 + Math.floor(i / 13),
    });
  }

  // El ordinal se asigna en una pasada aparte: depende de cuántas filas idénticas hay, no de dónde están.
  const ordinales = asignarOrdinales(
    borradores.map((b) => ({
      fecha: b.fecha,
      importe: b.importe,
      saldo: b.saldo ?? null,
      descripcion: b.descripcion,
    })),
  );

  const movimientos: MovimientoBancarioCrudo[] = borradores.map((b, indice) => ({
    ...b,
    filaHash: hashFila({
      cuenta: claveCuenta,
      fecha: b.fecha,
      importe: b.importe,
      saldo: b.saldo ?? null,
      descripcion: b.descripcion,
      ordinalEnEmpate: ordinales[indice] ?? 0,
    }),
  }));

  const creditos = sumar(movimientos.filter((m) => m.credito !== undefined).map((m) => m.credito!));
  const debitos = sumar(movimientos.filter((m) => m.debito !== undefined).map((m) => m.debito!));

  const salida: CuentaConMovimientos = {
    cuenta: {
      denominacion: 'CUENTA CORRIENTE SIMULADA EN PESOS',
      tipoCuenta: 'cuenta_corriente',
      numero: numeroCuenta,
      moneda,
      periodoDesde,
      periodoHasta,
      saldoInicialDeclarado: centavosAImporte(saldoInicialCentavos),
      saldoFinalDeclarado: centavosAImporte(saldo),
      totalCreditosDeclarado: creditos,
      totalDebitosDeclarado: debitos,
      titular: 'EMPRESA DE PRUEBA 00 SRL',
    },
    movimientos,
    anexos: [],
  };

  return validarCoherencia(salida);
}

/**
 * EL GENERADOR VALIDA SU PROPIA SALIDA, y aborta si produjo algo incoherente.
 *
 * ## Por qué esto existe
 *
 * Una versión de este generador tenía un bug de una línea: al forzar el débito grande calculaba
 * `-(saldo + margen)`, y cuando el saldo ya estaba negativo el resultado quedaba **positivo** — un crédito
 * guardado en la columna `debito`. El fixture salía incoherente y la verificación decía `no_cuadra`, con
 * razón, pero por culpa del generador.
 *
 * **Ese es el modo de falla más caro de todos.** Cuando el fixture está mal, el reflejo es relajar el
 * verificador hasta que el test pase — y ahí se pierde el único control que detecta un parseo mal hecho.
 * Un generador que no se valida convierte cada bug propio en presión para debilitar la verificación.
 *
 * Así que el generador falla ruidoso: es mejor que un `pnpm test` explote acá que que alguien pase media
 * hora buscando el error en `verificarAritmetica`.
 */
function validarCoherencia(salida: CuentaConMovimientos): CuentaConMovimientos {
  // 1. El esquema: incluye el refine que exige `importe === credito ?? '-' + debito`.
  const parseado = cuentaConMovimientosSchema.safeParse(salida);
  if (!parseado.success) {
    throw new Error(
      'El generador sintético produjo una cuenta que no pasa su propio esquema. Es un bug del ' +
        `generador, no del verificador: ${parseado.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }

  // 2. La aritmética: los totales declarados tienen que ser la suma de los importes.
  let creditos = 0n;
  let debitos = 0n;
  for (const m of salida.movimientos) {
    const v = importeCanonicoACentavos(m.importe) ?? 0n;
    if (v >= 0n) creditos += v;
    else debitos += -v;
  }

  const declarados = {
    creditos: importeCanonicoACentavos(salida.cuenta.totalCreditosDeclarado ?? '0.00') ?? 0n,
    debitos: importeCanonicoACentavos(salida.cuenta.totalDebitosDeclarado ?? '0.00') ?? 0n,
  };

  if (declarados.creditos !== creditos || declarados.debitos !== debitos) {
    throw new Error(
      'El generador sintético produjo totales que no coinciden con la suma de los importes. Es un bug ' +
        'del generador. Diferencias en centavos: ' +
        `creditos=${declarados.creditos - creditos}, debitos=${declarados.debitos - debitos}`,
    );
  }

  // 3. La cadena de saldos: cada saldo tiene que ser el anterior más el importe.
  let esperado = importeCanonicoACentavos(salida.cuenta.saldoInicialDeclarado ?? '0.00') ?? 0n;
  for (const m of salida.movimientos) {
    esperado += importeCanonicoACentavos(m.importe) ?? 0n;
    const publicado = m.saldo === undefined ? null : importeCanonicoACentavos(m.saldo);
    if (publicado !== null && publicado !== esperado) {
      throw new Error(
        `El generador sintético produjo una cadena de saldos que no cierra en la fila ${m.filaNumero}. ` +
          `Es un bug del generador. Diferencia: ${publicado - esperado} centavos.`,
      );
    }
  }

  return salida;
}

function sumar(canonicos: readonly ImporteCanonico[]): ImporteCanonico {
  let total = 0n;
  for (const c of canonicos) total += importeCanonicoACentavos(c) ?? 0n;
  return centavosAImporte(total);
}
