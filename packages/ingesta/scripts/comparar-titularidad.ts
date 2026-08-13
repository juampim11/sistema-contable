/**
 * SCRIPT DESCARTABLE — compara si dos extractos son del mismo titular. Ítem 6.3, primer paso.
 *
 * NO SE COMITEA AL REPO (HANDOFF.md 2026-08-11 (29), diseño revisado por `seguridad-datos-financieros`
 * antes de escribirse). Corré, leé el resultado, borrá el archivo.
 *
 *     node packages/ingesta/scripts/comparar-titularidad.ts \
 *       --archivo1 <ruta al PDF real 1> --banco1 <codigo> \
 *       --archivo2 <ruta al PDF real 2> --banco2 <codigo>
 *
 * ## Qué hace y qué NO hace
 *
 * Lee los dos PDF con el mismo camino que `probar-adaptador.ts` (`resolverAdaptador` → `.leer()`), sin
 * tocar la base ni el storage. Compara `cuenta.titularDocumento` (el CUIT que cada adaptador ya extrae
 * de la carátula) de las dos cuentas. Imprime POR STDOUT ÚNICAMENTE `mismo_titular: true|false` — el
 * CUIT nunca se imprime, nunca se loguea, nunca sale de `compararTitulares()`.
 *
 * ## Las guardas, y por qué cada una
 *
 * 1. `compararTitulares` es la ÚNICA función que toca `titularDocumento`: firma angosta, devuelve un
 *    enum de 3 estados (`igual | distinto | no_publicado`), nunca los valores de entrada. Nada fuera de
 *    esa función ve el CUIT.
 * 2. Normaliza (`replace(/\D/g, '')`) antes de comparar: Macro publica 11 dígitos pegados, Santander
 *    puede traer guiones — comparar los strings crudos daría `distinto` por un problema de formato, no
 *    porque los titulares lo sean. Ese falso negativo es el peor error posible en este dominio (afirma
 *    "cuidado, es de otro cliente" cuando no lo es).
 * 3. `undefined` en cualquiera de los dos → `no_publicado`, NUNCA `undefined !== undefined` → `false`
 *    silencioso. Comparar por ausencia y reportar "distintos" sería una afirmación falsa sobre secreto
 *    fiscal, no un dato que falta.
 * 4. Un único `try/catch` envuelve todo el script. El `catch` NUNCA imprime `error.message` (ni
 *    redactado): un error de parseo de PDF puede interpolar el fragmento de texto que estaba
 *    procesando, y apostar el control entero a que el redactor por regex no falle en un texto no medido
 *    es débil para el único dato que este script maneja. Imprime solo `redactar(error).nombre` (el
 *    nombre del constructor, p. ej. `TypeError`/`ZodError` — nunca lleva datos por construcción) y un
 *    código genérico.
 * 5. Nunca se serializa `cuenta` ni `salida` completos: `cuenta.titular`, `cuenta.numero`, `cuenta.cbu`
 *    viajan en el mismo objeto que `titularDocumento` y son igual de sensibles. Todo el diagnóstico que
 *    no es el booleano final sigue el patrón de `probar-adaptador.ts`: presencia (`si`/`no`), conteos,
 *    códigos de banco (N0-público) — nunca un valor.
 * 6. No usa `logger` ni `conUsuario`/`conJob`: no toca la base, así que `verificarCredencialDeRequest()`
 *    no aplica — mismo criterio que `probar-adaptador.ts`.
 *
 * Códigos de salida: `0` mismo_titular determinado (true o false, ver stdout); `1` error interno;
 * `2` argumentos inválidos; `3` alguno de los dos extractos no publica `titularDocumento`;
 * `4` alguno de los dos archivos no se pudo resolver a un adaptador único.
 */

import { readFileSync } from 'node:fs';
import { cargarEnv } from '../../../tools/cargar-env.ts';
import { aFilas } from '../src/texto-pdf.ts';
import { redactar } from '@sistema-contable/shared/seguridad';
import { adaptadorGalicia } from '../src/adaptadores/galicia.ts';
import { adaptadorMacro } from '../src/adaptadores/macro.ts';
import { adaptadorSantander } from '../src/adaptadores/santander.ts';
import { registrarAdaptador, resolverAdaptador } from '../src/adaptadores/registro.ts';

const SALTO = String.fromCharCode(10);
const p = (t: string): void => {
  process.stdout.write(t + SALTO);
};

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v?.startsWith('--') === false ? v : undefined;
}

/**
 * La ÚNICA función que toca `titularDocumento`. Firma angosta, devuelve un enum — nunca el valor de
 * entrada. Nada fuera de acá ve el CUIT.
 */
function compararTitulares(a: string | undefined, b: string | undefined): 'igual' | 'distinto' | 'no_publicado' {
  if (a === undefined || b === undefined) return 'no_publicado';
  const normA = a.replace(/\D/g, '');
  const normB = b.replace(/\D/g, '');
  if (normA === '' || normB === '') return 'no_publicado';
  return normA === normB ? 'igual' : 'distinto';
}

async function leerPrimerTitular(
  rutaArchivo: string,
  bancoDeclarado: string,
): Promise<{ readonly titularDocumento: string | undefined } | { readonly error: 'no_resuelto' }> {
  const contenido = readFileSync(rutaArchivo);
  const filas = await aFilas(contenido);
  const cual = resolverAdaptador({ filas }, bancoDeclarado);

  if (cual.estado !== 'encontrado') {
    p(`  archivo=${rutaArchivo}`);
    p(`  RESOLUCION: ${cual.estado}`);
    if (cual.estado === 'ambiguo') p(`    candidatos=[${cual.candidatos.join(',')}]`);
    if (cual.estado === 'sin_adaptador') p(`    registrados=[${cual.bancosRegistrados.join(',')}]`);
    return { error: 'no_resuelto' };
  }

  const salida = cual.adaptador.leer({ filas });
  p(`  archivo=${rutaArchivo} banco=${cual.adaptador.bancoCodigo} cuentas=${salida.cuentas.length}`);
  const primera = salida.cuentas[0];
  return { titularDocumento: primera?.cuenta.titularDocumento };
}

async function main(): Promise<void> {
  cargarEnv();
  registrarAdaptador(adaptadorGalicia);
  registrarAdaptador(adaptadorMacro);
  registrarAdaptador(adaptadorSantander);

  const archivo1 = argumento('archivo1');
  const banco1 = argumento('banco1');
  const archivo2 = argumento('archivo2');
  const banco2 = argumento('banco2');

  if (!archivo1 || !banco1 || !archivo2 || !banco2) {
    p('');
    p('  node packages/ingesta/scripts/comparar-titularidad.ts \\');
    p('    --archivo1 <ruta> --banco1 <codigo> --archivo2 <ruta> --banco2 <codigo>');
    p('');
    p('  Lee los dos extractos y compara si son del mismo titular. NUNCA imprime el CUIT.');
    p('');
    process.exit(2);
  }

  p('');
  const r1 = await leerPrimerTitular(archivo1, banco1);
  const r2 = await leerPrimerTitular(archivo2, banco2);
  p('');

  if ('error' in r1 || 'error' in r2) {
    p('  NO SE PUDO DETERMINAR: alguno de los dos archivos no se resolvió a un adaptador único.');
    process.exit(4);
  }

  const resultado = compararTitulares(r1.titularDocumento, r2.titularDocumento);

  if (resultado === 'no_publicado') {
    const cuales = [
      r1.titularDocumento === undefined ? '1' : null,
      r2.titularDocumento === undefined ? '2' : null,
    ].filter((x): x is string => x !== null);
    p(`  documento_no_publicado: archivo=[${cuales.join(',')}]`);
    process.exit(3);
  }

  p(`  mismo_titular: ${resultado === 'igual'}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  // Nunca error.message crudo, ni siquiera redactado: el único dato que maneja este script es un CUIT,
  // y un error de parseo de PDF puede interpolar el fragmento de texto que estaba procesando. Solo el
  // nombre del constructor del error, que por construcción nunca lleva datos.
  const nombre = error instanceof Error ? (redactar(error) as { nombre: string }).nombre : 'desconocido';
  p('');
  p(`  error_interno: ${nombre}`);
  process.exit(1);
});
