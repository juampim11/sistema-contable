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

/**
 * Checksum de Luhn — el dígito verificador estándar de un PAN (ISO/IEC 7812).
 *
 * Recorre de derecha a izquierda, duplica cada segundo dígito (restando 9 si el resultado supera 9)
 * y suma todo: válido si el total es múltiplo de 10.
 *
 * ## Por qué existe, y qué NO decide
 *
 * En `visa-corporativa.ts` (`sinPan`), Luhn decide el **motivo** que se deja registrado
 * (`pan_confirmado_luhn` vs `pan_shape_sin_luhn`) — **nunca** si un candidato con forma de PAN se
 * trunca: eso pasa siempre que la forma matchee (falla cerrado, un PAN real mal leído por OCR puede
 * fallar Luhn y seguir siendo un PAN real). Acá es solo el checksum puro, sin esa decisión encima.
 *
 * Falla cerrado ante cualquier forma inesperada (vacío, no numérico): nunca asume válido.
 */
export function luhnEsValido(valor: string): boolean {
  const d = valor.replace(/\D/g, '');
  if (d.length === 0 || d.length !== valor.length) return false;
  let suma = 0;
  let duplicar = false;
  for (let i = d.length - 1; i >= 0; i -= 1) {
    let digito = Number(d[i]);
    if (duplicar) {
      digito *= 2;
      if (digito > 9) digito -= 9;
    }
    suma += digito;
    duplicar = !duplicar;
  }
  return suma % 10 === 0;
}
