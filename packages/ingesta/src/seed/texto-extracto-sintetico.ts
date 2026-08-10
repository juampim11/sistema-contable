/**
 * GENERADOR DEL TEXTO DE UN EXTRACTO — el fixture que el adapter va a leer.
 *
 * ## Por qué un generador y no el PDF real editado
 *
 * Editar el archivo real es la opción que parece más rápida y es la peor: **queda dato real adentro**. Un
 * PDF arrastra el XMP con el nombre del titular, las glosas que no se tocaron siguen ahí, y los importes
 * "escalados" son **reversibles por división** contra los totales que el documento publica. Nadie revisa
 * el XMP.
 *
 * Así que se escribe desde una especificación: se conserva la **forma** y se reemplaza **todo** el
 * contenido.
 *
 * ## Qué forma se conserva, y por qué cada cosa
 *
 * | Rasgo | Por qué está |
 * |---|---|
 * | Encabezado repetido por página | El adapter tiene que saltearlo sin contarlo como movimiento |
 * | Etiquetas de carátula (`CUIT:`, `CBU:`, `Cuenta Nº`) | La resolución lee **por etiqueta**, no por patrón |
 * | Las dos fechas del período **pegadas sin separador** | Aparece en el material real y rompe un `split` naíf |
 * | Las cuatro notaciones de signo | Es la variabilidad medida: signo adelante, atrás, antes del `$`, y paréntesis |
 * | Multi-línea con su distribución | La glosa sigue en la línea siguiente sin fecha: confundirla con un movimiento duplica filas |
 * | Línea de totales que **cuadra** | Sin totales coherentes no se puede probar la verificación, que es el control que se está construyendo |
 * | Bloques que no son movimientos | Leyendas legales y avisos: si el adapter los toma, inventa filas |
 * | Variante **multi-cuenta** | La muestra real tiene una sola cuenta, pero el modelo soporta N y hay que ejercitarlo |
 *
 * Todos los identificadores son **sintéticos con verificador inválido**, y hay un chequeo del gate que lo
 * verifica: si el generador produjera un CUIT válido, podría existir y pertenecerle a alguien.
 */

import { centavosAImporte } from '../parseo-ar.ts';

/** PRNG determinístico (mulberry32). Sin él, dos corridas producen fixtures distintos y el gate no sirve. */
function prng(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONCEPTOS = [
  'TRANSFERENCIA RECIBIDA CUIT 20-12345678-9',
  'PAGO A PROVEEDOR SINTETICO CBU 9990000090000000000001',
  'DEBITO AUTOMATICO SERVICIO SIMULADO',
  'COMISION MANTENIMIENTO DE CUENTA',
  'ACREDITACION DE HABERES SIMULADA',
  'IMPUESTO LEY 25413 DEBITOS',
  'RETENCION IIBB JURISDICCION 901',
  'DEPOSITO EN EFECTIVO VENTANILLA',
] as const;

/** Glosa de continuación: sigue al movimiento anterior en la línea siguiente, SIN fecha. */
const CONTINUACIONES = [
  '    REF OPERACION 000123456 SUCURSAL 0112',
  '    ORIGEN EMPRESA DE PRUEBA 07 SRL',
  '    DETALLE ADICIONAL DE LA OPERACION',
] as const;

/**
 * Las cuatro notaciones de negativo observadas. **El fixture usa las cuatro** aunque un banco real use
 * una sola: el toolkit tiene que soportarlas todas y esto es lo que lo ejercita.
 */
function conNotacion(centavos: bigint, notacion: 0 | 1 | 2 | 3): string {
  const canonico = centavosAImporte(centavos < 0n ? -centavos : centavos);
  // Se rearma desde las partes: aplicar el separador de miles sobre el string completo se lo mete
  // también en los decimales, y el resultado es un importe que ningún parser acepta.
  const [entero = '0', decimales = '00'] = canonico.split('.');
  const abs = `${entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${decimales}`;

  if (centavos >= 0n) return abs;
  switch (notacion) {
    case 0:
      return `-${abs}`;
    case 1:
      return `${abs}-`;
    case 2:
      return `-$ ${abs}`;
    case 3:
      return `(${abs})`;
  }
}

export type OpcionesTextoSintetico = {
  readonly semilla: number;
  readonly movimientosPorCuenta: number;
  /** Dos cuentas ejercita la variante multi-cuenta que el modelo soporta. */
  readonly cuentas: 1 | 2;
  readonly periodoDesde: string;
  readonly periodoHasta: string;
  readonly lineasPorPagina: number;
};

export type TextoSintetico = {
  /** El texto completo, como lo devolvería el extractor de PDF. */
  readonly texto: string;
  /** Lo que el adapter tiene que llegar a producir. Es la respuesta contra la que se compara. */
  readonly esperado: {
    readonly cuentas: readonly {
      readonly numero: string;
      readonly cbu: string;
      readonly saldoInicial: string;
      readonly saldoFinal: string;
      readonly totalCreditos: string;
      readonly totalDebitos: string;
      readonly movimientos: number;
    }[];
  };
};

function ddmmaaaa(iso: string): string {
  const [a = '', m = '', d = ''] = iso.split('-');
  return `${d}/${m}/${a}`;
}

/**
 * Genera el texto y la respuesta esperada juntos.
 *
 * Devolver las dos cosas del mismo lugar es lo que permite que el test del adapter compare contra algo que
 * no calculó él: un fixture sin respuesta esperada solo permite verificar que el adapter no explote.
 */
export function textoExtractoSintetico(opciones: OpcionesTextoSintetico): TextoSintetico {
  const azar = prng(opciones.semilla);
  const lineas: string[] = [];
  const cuentasEsperadas: TextoSintetico['esperado']['cuentas'][number][] = [];

  // Las dos fechas del período PEGADAS SIN SEPARADOR: está en el material real y rompe un split naíf.
  const periodoPegado = `${ddmmaaaa(opciones.periodoDesde)}${ddmmaaaa(opciones.periodoHasta)}`;

  /**
   * El mes y el año salen del PERÍODO, no de una constante.
   *
   * Estaban hardcodeados como `/06/26` mientras el período era parámetro: generar con
   * `periodoDesde: '2026-01-01'` producía un fixture con fechas de junio y período de enero, y eso hace
   * fallar V7 (fechas dentro del período) **por un defecto del fixture**. El camino de menor resistencia
   * frente a eso es relajar V7, que es el detector.
   */
  const [anioCompleto = '2026', mesDosDigitos = '06'] = opciones.periodoDesde.split('-');
  const anioDosDigitos = anioCompleto.slice(-2);

  const encabezado = (pagina: number): string[] => [
    'BANCO SINTETICO S.A.  -  RESUMEN DE CUENTA',
    `Periodo: ${periodoPegado}                        Pagina ${pagina}`,
    'Fecha     Concepto                                      Importe        Saldo',
    '-------------------------------------------------------------------------------',
  ];

  let pagina = 1;
  let lineasEnPagina = 0;
  const emitir = (linea: string): void => {
    if (lineasEnPagina === 0) {
      for (const l of encabezado(pagina)) lineas.push(l);
      lineasEnPagina = encabezado(pagina).length;
    }
    lineas.push(linea);
    lineasEnPagina += 1;
    if (lineasEnPagina >= opciones.lineasPorPagina) {
      lineas.push('');
      pagina += 1;
      lineasEnPagina = 0;
    }
  };

  for (let c = 0; c < opciones.cuentas; c += 1) {
    // Identificadores SINTÉTICOS con verificador inválido a propósito.
    const numero = `0112-${String(100000 + c).padStart(6, '0')}/${c}`;
    const cbu = `999000009000000000000${c + 1}`;

    let saldo = 1_000_000n + BigInt(c) * 500_000n;
    const saldoInicial = saldo;
    let creditos = 0n;
    let debitos = 0n;
    let filas = 0;

    /**
     * La carátula pasa por `emitir`, no por `lineas.push`.
     *
     * Con `push` directo, la carátula salía **antes** del encabezado del banco (ningún resumen real
     * arranca así) y la página 1 terminaba con más líneas que las demás. Y el `lineasEnPagina = 0` que
     * venía después reiniciaba el contador **sin incrementar `pagina`**, así que el fixture declaraba la
     * secuencia `1,2,3,4,4,5,6`: la página 4 dos veces.
     *
     * Eso vuelve inalcanzable el "0 diferencias" del caso base para cualquier detector de páginas
     * faltantes — y un caso base que no puede dar cero es la mejor forma de que alguien relaje el detector.
     */
    if (c > 0) {
      // Cuenta nueva: arranca en página nueva, con su número propio.
      lineas.push('');
      pagina += 1;
      lineasEnPagina = 0;
    }
    emitir(`Cuenta Nº ${numero}          CBU: ${cbu}`);
    emitir('Titular: EMPRESA DE PRUEBA 07 SRL          CUIT: 20-12345678-9');
    emitir(`Saldo Anterior al ${ddmmaaaa(opciones.periodoDesde)}: ${conNotacion(saldoInicial, 0)}`);

    /**
     * Los días avanzan de forma MONÓTONA a lo largo del período.
     *
     * La primera versión sorteaba el día suelto y salían fechas desordenadas (28/06, 27/06, 17/06…). Un
     * extracto real está ordenado por fecha, y la verificación lo usa: V7 exige monotonía porque una fecha
     * que retrocede es la señal de que se capturó un bloque de otra sección del documento. Un fixture con
     * fechas desordenadas haría fallar la verificación por un defecto del fixture, no del adapter — y el
     * camino de menor resistencia sería relajar V7.
     */
    let diaActual = 1;
    for (let i = 0; i < opciones.movimientosPorCuenta; i += 1) {
      const avance = Math.floor(azar() * 2);
      diaActual = Math.min(28, diaActual + avance);
      const dia = String(diaActual).padStart(2, '0');
      const concepto = CONCEPTOS[Math.floor(azar() * CONCEPTOS.length)] ?? CONCEPTOS[0];
      const esCredito = azar() < 0.45;
      const magnitud = BigInt(1000 + Math.floor(azar() * 900_000));
      const delta = esCredito ? magnitud : -magnitud;

      saldo += delta;
      if (delta > 0n) creditos += delta;
      else debitos += -delta;
      filas += 1;

      const notacion = (i % 4) as 0 | 1 | 2 | 3;
      const importeTexto = conNotacion(delta, notacion);
      const saldoTexto = conNotacion(saldo, 1); // el saldo acreedor con el signo atrás

      emitir(
        `${dia}/${mesDosDigitos}/${anioDosDigitos}  ${concepto.padEnd(44).slice(0, 44)}  ` +
          `${importeTexto.padStart(14)}  ${saldoTexto.padStart(14)}`,
      );

      // Multi-línea: la glosa sigue en la línea siguiente, sin fecha. Confundirla con un movimiento
      // duplica filas; ignorar la línea pierde la referencia.
      if (azar() < 0.25) {
        emitir(CONTINUACIONES[Math.floor(azar() * CONTINUACIONES.length)] ?? CONTINUACIONES[0]);
      }

      // Bloque que NO es un movimiento: si el adapter lo toma, inventa una fila.
      if (i === Math.floor(opciones.movimientosPorCuenta / 2)) {
        emitir('*** IMPORTANTE: este documento es una SIMULACION sin valor legal ***');
        emitir('    Ante cualquier consulta comuniquese con su sucursal');
      }
    }

    emitir('-------------------------------------------------------------------------------');
    emitir(`Total Creditos: ${conNotacion(creditos, 0).padStart(16)}`);
    emitir(`Total Debitos:  ${conNotacion(-debitos, 0).padStart(16)}`);
    emitir(`Saldo Final al ${ddmmaaaa(opciones.periodoHasta)}: ${conNotacion(saldo, 1)}`);

    cuentasEsperadas.push({
      numero,
      cbu,
      saldoInicial: centavosAImporte(saldoInicial),
      saldoFinal: centavosAImporte(saldo),
      totalCreditos: centavosAImporte(creditos),
      totalDebitos: centavosAImporte(debitos),
      movimientos: filas,
    });
  }

  return { texto: `${lineas.join('\n')}\n`, esperado: { cuentas: cuentasEsperadas } };
}
