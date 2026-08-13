/**
 * Dígito verificador de CUIT/CUIL — mismo algoritmo para los dos (`hmac-identificador.ts`
 * canoniza los dos al dominio de hash `cuit_cuil`; este validador sigue el mismo criterio).
 *
 * Movido de `packages/data/src/seed/sintetico.ts` (Módulo 2, capa C — plan `adaptive-herding-pillow`):
 * ese archivo es el generador de datos SINTÉTICOS (CLAUDE.md §2.1, "nunca un CUIT real") y genera
 * verificadores deliberadamente inválidos; un camino de escritura real (alta de socio) necesita la
 * validación real, que no depende de que el dato sea sintético o no — vive acá, en `shared`, donde
 * tanto `data` como `contabilidad` pueden llegar a necesitarla sin ciclos.
 */

const PESOS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/**
 * Dígito verificador real de un CUIT/CUIL de 10 dígitos (sin el propio verificador).
 *
 * La rama `resto === 1` no tiene una única convención publicada — acá se resuelve a `9` (la más
 * común en las implementaciones de referencia). Verificar contra AFIP es una pregunta de dominio
 * fiscal, no de seguridad; el caso ambiguo falla cerrado: `verificadorCuitEsValido` rechaza si no
 * matchea exacto, nunca acepta "por las dudas".
 */
function verificadorCuitReal(diez: string): number {
  const suma = PESOS.reduce((acc, peso, i) => acc + peso * Number(diez[i] ?? '0'), 0);
  const resto = suma % 11;
  if (resto === 0) return 0;
  if (resto === 1) return 9;
  return 11 - resto;
}

/** CUIT/CUIL de 11 dígitos con dígito verificador correcto. Falla cerrado ante cualquier forma
 *  inesperada (largo distinto, no numérico) — nunca asume válido. */
export function verificadorCuitEsValido(valor: string): boolean {
  const d = valor.replace(/\D/g, '');
  if (d.length !== 11) return false;
  return Number(d[10]) === verificadorCuitReal(d.slice(0, 10));
}
