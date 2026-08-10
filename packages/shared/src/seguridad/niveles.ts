/**
 * Niveles de clasificación de datos — ADR-0002 §A.
 *
 * El nivel de un dato decide TODO lo demás: si puede salir a un log, a un export o a un entorno de
 * prueba; si se enmascara; si se cifra; y quién lo puede leer.
 */

export const NIVELES = ['N0', 'N1', 'N2', 'N2R', 'N3'] as const;

/**
 * - `N0` público: no identifica a nadie (normativa, catálogo de bancos, plan de cuentas modelo).
 * - `N1` interno: metadato operativo sin dato de tercero (uuid, conteos, duraciones).
 * - `N2` confidencial-cliente: **el default de toda tabla de dominio**.
 * - `N2R` confidencial restringido: identificador directo o pieza que habilita fraude
 *   (CUIT, CBU, extracto crudo, legajo de empleado).
 * - `N3` secreto: habilita actuar en nombre del cliente (clave fiscal, clave privada, DSN).
 */
export type NivelDato = (typeof NIVELES)[number];

/** Orden de severidad, para comparar niveles sin repetir la tabla en cada `if`. */
const ORDEN: Record<NivelDato, number> = { N0: 0, N1: 1, N2: 2, N2R: 3, N3: 4 };

export function nivelAlMenos(nivel: NivelDato, minimo: NivelDato): boolean {
  return ORDEN[nivel] >= ORDEN[minimo];
}

/** ≥ N2: no va a un log, ni a un entorno de prueba, ni a un servicio externo sin decisión registrada. */
export function esSensible(nivel: NivelDato): boolean {
  return nivelAlMenos(nivel, 'N2');
}

/** ≥ N2R: además exige chequeo de rol en LECTURA y deja rastro en `acceso_auditoria`. */
export function exigeRolEnLectura(nivel: NivelDato): boolean {
  return nivelAlMenos(nivel, 'N2R');
}

/** Cómo se muestra un dato cuando el rol puede verlo pero no hace falta el valor completo. */
export type FormaDeEnmascarar = 'ninguna' | 'ultimos4' | 'cuit_parcial' | 'huella';
