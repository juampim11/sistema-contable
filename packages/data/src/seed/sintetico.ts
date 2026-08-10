/**
 * GENERADOR DE DATOS SINTÉTICOS — ADR-0002 §F.1.
 *
 * Para no usar NUNCA datos reales de un cliente del estudio en desarrollo ni en tests.
 *
 * Las dos decisiones que importan, y el porqué:
 *
 *   1. **Los CUIT y los CBU se generan con dígito verificador DELIBERADAMENTE INVÁLIDO.** Un CUIT
 *      "válido" generado al azar **pertenece a un contribuyente real**: tenerlo en un fixture del
 *      repo es una filtración con pasos extra, y encima confunde a cualquiera que lo busque. Un CUIT
 *      con verificador inválido es inconfundiblemente de prueba.
 *   2. **Todo es determinístico a partir de una semilla.** Sin `Math.random()`: dos corridas dan el
 *      mismo dato, así un test que falla se puede reproducir. La semilla se pasa; no hay default
 *      oculto que cambie entre corridas.
 *
 * Los VALORES CANARIO (`CANARIO`) son aparte: existen para los tests INV-5 e INV-8, que verifican que
 * un dato de un cliente no se filtre a un reporte ni a un log. No se usan para nada más.
 */

// -----------------------------------------------------------------------------
// PRNG determinístico (mulberry32). 12 líneas y suficiente: no es criptografía.
// -----------------------------------------------------------------------------

export type Aleatorio = () => number;

export function prng(semilla: number): Aleatorio {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function entero(rnd: Aleatorio, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

function digitos(rnd: Aleatorio, cantidad: number): string {
  let s = '';
  for (let i = 0; i < cantidad; i += 1) s += String(entero(rnd, 0, 9));
  return s;
}

// -----------------------------------------------------------------------------
// Identificadores sintéticos, con verificador inválido a propósito
// -----------------------------------------------------------------------------

const PREFIJOS_CUIT = ['20', '23', '24', '27', '30', '33', '34'] as const;

/** Dígito verificador real de un CUIT, para poder elegir uno DISTINTO. */
function verificadorCuitReal(once: string): number {
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, peso, i) => acc + peso * Number(once[i] ?? '0'), 0);
  const resto = suma % 11;
  if (resto === 0) return 0;
  if (resto === 1) return 9;
  return 11 - resto;
}

export function verificadorCuitEsValido(cuit: string): boolean {
  const d = cuit.replace(/\D/g, '');
  if (d.length !== 11) return false;
  return Number(d[10]) === verificadorCuitReal(d.slice(0, 10));
}

/**
 * CUIT sintético con formato correcto (11 dígitos, prefijo plausible) y **verificador inválido**.
 * Pasa cualquier validación de forma y falla la de dígito verificador: exactamente lo que queremos.
 */
export function cuitSintetico(rnd: Aleatorio): string {
  const prefijo = PREFIJOS_CUIT[entero(rnd, 0, PREFIJOS_CUIT.length - 1)] ?? '20';
  const cuerpo = digitos(rnd, 8);
  const base = `${prefijo}${cuerpo}`;
  const valido = verificadorCuitReal(base);
  const invalido = (valido + 1 + entero(rnd, 0, 8)) % 10 === valido ? (valido + 3) % 10 : (valido + 1) % 10;
  return `${prefijo}-${cuerpo}-${invalido}`;
}

/** Verificador del primer bloque del CBU (8 dígitos: 3 de entidad + 4 de sucursal + 1 verificador). */
function verificadorCbuBloque1(siete: string): number {
  const pesos = [7, 1, 3, 9, 7, 1, 3];
  const suma = pesos.reduce((acc, peso, i) => acc + peso * Number(siete[i] ?? '0'), 0);
  return (10 - (suma % 10)) % 10;
}

export function verificadorCbuBloque1EsValido(cbu: string): boolean {
  const d = cbu.replace(/\D/g, '');
  if (d.length !== 22) return false;
  return Number(d[7]) === verificadorCbuBloque1(d.slice(0, 7));
}

/**
 * CBU sintético: 22 dígitos, **entidad inexistente (`999`)** y verificador inválido.
 * El `999` es la segunda señal: ninguna entidad financiera real lo usa.
 */
export function cbuSintetico(rnd: Aleatorio): string {
  const entidadInexistente = '999';
  const sucursal = digitos(rnd, 4);
  const siete = `${entidadInexistente}${sucursal}`;
  const valido = verificadorCbuBloque1(siete);
  const invalido = (valido + 1) % 10;
  const bloque2 = digitos(rnd, 14);
  return `${siete}${invalido}${bloque2}`;
}

// -----------------------------------------------------------------------------
// Nombres obviamente ficticios (ADR-0002 §F.1: prohibido "nombres realistas")
// -----------------------------------------------------------------------------

const RAICES = [
  'EMPRESA DE PRUEBA',
  'SOCIEDAD FICTICIA',
  'COMERCIO DE ENSAYO',
  'ENTIDAD DEMO',
  'FIRMA SIMULADA',
] as const;

const FORMAS = ['SA', 'SRL', 'SAS'] as const;

export function razonSocialSintetica(rnd: Aleatorio, indice: number): string {
  const raiz = RAICES[indice % RAICES.length] ?? 'EMPRESA DE PRUEBA';
  const forma = FORMAS[entero(rnd, 0, FORMAS.length - 1)] ?? 'SA';
  return `${raiz} ${String(indice).padStart(2, '0')} ${forma}`;
}

// -----------------------------------------------------------------------------
// Valores canario — para INV-5 (reportes) e INV-8 (logs). No usar para otra cosa.
// -----------------------------------------------------------------------------

export const CANARIO = {
  importe: '999999.99',
  razonSocial: 'CANARIO SRL',
  /** Entidad inexistente + verificador inválido, igual que el resto. */
  cbu: '9990000090000000000001',
  cuit: '30-99999999-0',
  descripcion: 'CANARIO MOVIMIENTO QUE NO DEBE APARECER',
} as const;

/** Todos los valores canario, para que un test los busque en una salida de un solo barrido. */
export const VALORES_CANARIO: readonly string[] = Object.values(CANARIO);

// -----------------------------------------------------------------------------
// Cliente sintético completo
// -----------------------------------------------------------------------------

export type ClienteSintetico = {
  readonly razonSocial: string;
  readonly cuit: string;
  readonly cbu: string;
  readonly condicionIva: 'responsable_inscripto' | 'monotributo' | 'exento';
};

const CONDICIONES = ['responsable_inscripto', 'monotributo', 'exento'] as const;

export function clienteSintetico(semilla: number, indice: number): ClienteSintetico {
  // La semilla se combina con el índice para que cada cliente sea distinto pero reproducible.
  const rnd = prng(semilla + indice * 7919);
  return {
    razonSocial: razonSocialSintetica(rnd, indice),
    cuit: cuitSintetico(rnd),
    cbu: cbuSintetico(rnd),
    condicionIva: CONDICIONES[entero(rnd, 0, CONDICIONES.length - 1)] ?? 'responsable_inscripto',
  };
}

export type EstudioSintetico = {
  readonly nombre: string;
  readonly clientes: readonly ClienteSintetico[];
};

export function estudioSintetico(semilla: number, cantidadClientes: number): EstudioSintetico {
  return {
    nombre: `ESTUDIO DE PRUEBA ${String(semilla % 100).padStart(2, '0')}`,
    clientes: Array.from({ length: cantidadClientes }, (_, i) => clienteSintetico(semilla, i)),
  };
}

// -----------------------------------------------------------------------------
// Movimientos bancarios sintéticos (insumo del Módulo 1, sin depender de él)
// -----------------------------------------------------------------------------

export type MovimientoSintetico = {
  readonly fecha: string;
  readonly descripcion: string;
  readonly importe: string;
  readonly saldo: string;
};

const GLOSAS = [
  'TRANSFERENCIA RECIBIDA',
  'DEBITO AUTOMATICO SERVICIOS',
  'PAGO A PROVEEDOR',
  'ACREDITACION HABERES',
  'COMISION MANTENIMIENTO',
  'IMPUESTO DEBITOS Y CREDITOS',
] as const;

/**
 * Incluye a propósito los casos borde que rompen un parser: importes iguales el mismo día (dedupe),
 * importe negativo, y un movimiento con la misma glosa repetida.
 */
export function movimientosSinteticos(
  semilla: number,
  cantidad: number,
  saldoInicial = 100000,
): MovimientoSintetico[] {
  const rnd = prng(semilla);
  let saldo = saldoInicial;
  const salida: MovimientoSintetico[] = [];

  for (let i = 0; i < cantidad; i += 1) {
    const dia = Math.min(28, 1 + Math.floor(i / 2));
    const esDebito = rnd() < 0.5;
    // Cada tercer movimiento repite el importe del anterior: ejercita el dedupe por (cliente, hash).
    const bruto = i % 3 === 0 && i > 0 ? salida[i - 1]?.importe : undefined;
    const magnitud = bruto ? Math.abs(Number(bruto)) : entero(rnd, 100, 500000) / 100;
    const importe = (esDebito ? -magnitud : magnitud).toFixed(2);
    saldo = Number((saldo + Number(importe)).toFixed(2));
    salida.push({
      fecha: `2026-07-${String(dia).padStart(2, '0')}`,
      descripcion: GLOSAS[entero(rnd, 0, GLOSAS.length - 1)] ?? 'MOVIMIENTO',
      importe,
      saldo: saldo.toFixed(2),
    });
  }
  return salida;
}
