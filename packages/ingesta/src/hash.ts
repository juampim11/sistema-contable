/**
 * Hashes de idempotencia — ADR-0001 §5.1.
 *
 * Dos niveles, los dos **por cliente**, nunca globales:
 *   - `hashArchivo`: el mismo archivo no se procesa dos veces (`unique (cliente_id, archivo_hash)`).
 *   - `hashFila`: la misma fila no se inserta dos veces (`unique (cliente_id, cuenta_bancaria_id, fila_hash)`).
 *
 * Por qué por cliente y no global: dos clientes del mismo estudio pueden tener movimientos idénticos
 * — misma fecha, mismo importe y la misma glosa, porque los conceptos de comisión los genera el banco y
 * son iguales para todos sus clientes. Un `unique` global sería un bug que aparece con el segundo cliente
 * y además un **oráculo** de existencia cross-tenant (ADR-0002 H-10).
 *
 * ⚠️ Ningún ejemplo de este archivo se copia de un extracto real (hallazgo H-A).
 *
 * ---
 * ## La corrección del panel, que es de fondo
 *
 * La primera versión metía **`filaNumero` en el material del hash**, y el propio comentario enunciaba la
 * regla que el código violaba: "nada que dependa de cómo la parseamos". `filaNumero` **es** un producto
 * del parseo. Contra los cuatro escenarios que un hash de dedupe existe para cubrir:
 *
 * | Escenario | Con `filaNumero` adentro |
 * |---|---|
 * | Reproceso del mismo archivo | ✅ estable |
 * | **Extracto reemitido con un movimiento insertado arriba** | ❌ corre el número de **todas** las filas siguientes → el reproceso **duplica todo lo que está debajo**, sin violar ninguna constraint |
 * | Dos movimientos genuinamente idénticos el mismo día | ✅ los distingue… |
 * | **Mejora futura del parser** (separar una fila que hoy se lee pegada) | ❌ corren todos los números → **duplicación masiva** |
 *
 * Y lo que dirimió el conflicto entre los tres agentes que opinaron: **medido sobre el archivo real, los
 * 326 grupos de líneas crudas ya son únicos sin el número de fila** (326/326), porque el **saldo
 * corriente** está dentro del texto. O sea que el ordinal no compraba nada y costaba la fragilidad.
 *
 * **El discriminador correcto es el saldo.** Es un dato del banco, no del parser, y dos comisiones
 * idénticas del mismo día tienen saldos distintos. El ordinal queda solo para el empate genuino, y con eso
 * **insertar una fila no desplaza el hash de ninguna otra**.
 */

import { createHash } from 'node:crypto';
import { normalizar, type ImporteCanonico } from './parseo-ar.ts';

/** Separador de unidad: no aparece en ningún texto de un extracto. */
const SEP = '';

export function hashArchivo(contenido: Uint8Array): string {
  return createHash('sha256').update(contenido).digest('hex');
}

/**
 * Identidad de la cuenta para el hash: **número normalizado + moneda, nunca la denominación.**
 *
 * La denominación es una cadena de presentación: en un banco del roster se repite en sus tres cuentas y no
 * distingue nada — con lo cual el hash colisionaría entre cuentas del mismo cliente.
 */
export type ClaveCuenta = {
  readonly bancoCodigo: string;
  readonly numeroNormalizado: string;
  readonly moneda: string;
};

export type EntradaHashFila = {
  readonly cuenta: ClaveCuenta;
  readonly fecha: string;
  readonly importe: ImporteCanonico;
  /**
   * El discriminador real. `null` cuando el banco no lo publica — y en ese caso el hash **pierde
   * discriminación**, lo que queda **declarado** en `capacidades.traeSaldoPorFila`, no escondido.
   */
  readonly saldo: ImporteCanonico | null;
  readonly descripcion: string;
  /**
   * 0 salvo empate GENUINO en todo lo anterior. **Es un contador de ocurrencia dentro del grupo de filas
   * idénticas, no la posición absoluta**: por eso insertar una fila en otro lado no lo mueve.
   */
  readonly ordinalEnEmpate: number;
};

/**
 * Hash de una fila.
 *
 * El material lleva **el largo de cada campo** además del valor. Sin eso, `join` sobre campos de largo
 * variable es ambiguo: `['A B','C']` y `['A','B C']` producen el mismo material, y esa es exactamente la
 * variación que introduce un extractor de PDF cuando cambia de versión.
 */
export function hashFila(entrada: EntradaHashFila): string {
  const campos: readonly string[] = [
    entrada.cuenta.bancoCodigo,
    entrada.cuenta.numeroNormalizado,
    entrada.cuenta.moneda,
    entrada.fecha,
    entrada.importe,
    entrada.saldo ?? '',
    normalizar(entrada.descripcion),
    String(entrada.ordinalEnEmpate),
  ];

  const material = campos.map((c) => `${c.length}:${c}`).join(SEP);
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * Asigna el `ordinalEnEmpate` a un conjunto de filas ya parseadas.
 *
 * Se hace en una pasada aparte, y a propósito: el ordinal depende de **cuántas filas idénticas hay**, no
 * de dónde está cada una. Calcularlo dentro del bucle de parseo lo ataría a la posición otra vez.
 */
export type ClaveDeEmpate = {
  readonly fecha: string;
  readonly importe: ImporteCanonico;
  readonly saldo: ImporteCanonico | null;
  readonly descripcion: string;
};

/**
 * Devuelve **solo los ordinales**, en el mismo orden que las filas de entrada.
 *
 * No devuelve las filas enriquecidas a propósito: así el helper no impone la forma del objeto del que
 * salen los datos, y sirve igual para el generador sintético que para un adapter de banco.
 */
export function asignarOrdinales(filas: readonly ClaveDeEmpate[]): number[] {
  const vistas = new Map<string, number>();
  return filas.map((f) => {
    const clave = [f.fecha, f.importe, f.saldo ?? '', normalizar(f.descripcion)].join(SEP);
    const n = vistas.get(clave) ?? 0;
    vistas.set(clave, n + 1);
    return n;
  });
}

/**
 * Los hashes de **una** cuenta, en el orden de sus filas.
 *
 * ## Por qué es una función y no dos llamadas sueltas en cada adaptador
 *
 * Porque las dos cosas que hay que hacer bien son fáciles de hacer mal por separado, y las dos fallan en
 * verde:
 *
 * 1. **La `ClaveCuenta` es por cuenta, no del adaptador.** Con un banco de una sola cuenta se puede
 *    escribir como constante del módulo y funciona. El tercer banco del roster trae **tres cuentas en un
 *    archivo** (`07-formato-macro.md` §14) con **7 grupos de filas duplicadas**: sin la cuenta adentro del
 *    material, dos movimientos idénticos en cuentas distintas **colapsan al mismo hash**, y el segundo se
 *    pierde contra `unique (cliente_id, cuenta_bancaria_id, fila_hash)` — o peor, no se pierde y queda un
 *    movimiento atribuido a la cuenta equivocada.
 * 2. **El ordinal de empate se cuenta DENTRO de la cuenta.** Contarlo sobre el archivo entero hace que
 *    insertar una cuenta corra el ordinal de las filas de la otra, y el reproceso duplica todo lo de abajo
 *    — que es exactamente el defecto que la cabecera de este archivo explica que ya se corrigió una vez.
 *
 * Con esta función, las dos quedan atadas: no hay forma de pasar las filas de dos cuentas juntas sin
 * pasarles también una sola clave, que es evidentemente incorrecto al leerlo.
 */
export function hashesDeCuenta(
  clave: ClaveCuenta,
  filas: readonly ClaveDeEmpate[],
): readonly string[] {
  const ordinales = asignarOrdinales(filas);
  return filas.map((f, i) =>
    hashFila({
      cuenta: clave,
      fecha: f.fecha,
      importe: f.importe,
      saldo: f.saldo,
      descripcion: f.descripcion,
      ordinalEnEmpate: ordinales[i] ?? 0,
    }),
  );
}

/** Normaliza un número de cuenta a solo dígitos: los bancos lo escriben con guiones y espacios distintos. */
export function normalizarNumeroCuenta(numero: string): string {
  return numero.replace(/\D/g, '');
}
