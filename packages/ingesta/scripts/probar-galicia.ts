/**
 * Corrida del adaptador contra un archivo real, con salida **sin valores**.
 *
 * Imprime conteos, códigos y estados. Ningún importe, ninguna glosa, ningún identificador. Es lo que permite
 * pegar el resultado en un ticket o en el HANDOFF sin pensarlo dos veces — y es la misma disciplina que el
 * resto del módulo: el diagnóstico no puede ser el canal de fuga.
 *
 *     ENV_FILE=.env.piloto node packages/ingesta/scripts/probar-galicia.ts <ruta al PDF>
 */

import { readFileSync } from 'node:fs';
import { cargarEnv } from '../../../tools/cargar-env.ts';
import { aFilas, extraerTexto } from '../src/texto-pdf.ts';
import { CAPACIDADES_GALICIA, leerGalicia, reconoceGalicia } from '../src/adaptadores/galicia.ts';
import { verificarAritmetica } from '../src/verificacion/invariantes.ts';
import { contieneIdentificador, depurarGlosa } from '../src/glosa.ts';
import { extractoParseadoSchema } from '../src/esquema.ts';

cargarEnv();
const SALTO = String.fromCharCode(10);
const p = (t: string): void => {
  process.stdout.write(t + SALTO);
};

const ruta = process.argv[2];
if (!ruta) throw new Error('Falta la ruta del PDF.');

const buf = readFileSync(ruta);
const texto = await extraerTexto(buf);
const filas = await aFilas(buf);

p('');
p(
  `  paginas=${texto.paginas.length} sinTexto=[${texto.paginasSinTexto.join(',')}] ` +
    `requiereOcr=${texto.requiereOcr}`,
);
p(`  filas geometricas=${filas.length}  reconoce=${reconoceGalicia(filas)}`);

const salida = leerGalicia(filas);
const cuenta = salida.cuentas[0];
if (!cuenta) {
  p('  SIN CUENTAS: el adaptador no pudo armar ninguna.');
  p(`  no interpretadas=${salida.lineasNoInterpretadas.length}`);
  for (const l of salida.lineasNoInterpretadas.slice(0, 8)) {
    p(`    ${l.codigo} pag=${l.paginaPdf} forma=${l.forma}`);
  }
  process.exit(1);
}

p('');
p(`  movimientos=${cuenta.movimientos.length}`);
p(`  paginasDeclaradas=${salida.paginasDeclaradas ?? 'sin dato'}`);
p(`  periodo=${cuenta.cuenta.periodoDesde} .. ${cuenta.cuenta.periodoHasta}`);
p(`  creditos=${cuenta.movimientos.filter((m) => m.credito !== undefined).length}`);
p(`  debitos=${cuenta.movimientos.filter((m) => m.debito !== undefined).length}`);
p(`  con saldo negativo=${cuenta.movimientos.filter((m) => m.saldoEsAcreedor === true).length}`);
p(`  con referencias=${cuenta.movimientos.filter((m) => (m.referencias?.length ?? 0) > 0).length}`);
p(`  no interpretadas=${salida.lineasNoInterpretadas.length}`);

const porCodigo = new Map<string, number>();
for (const l of salida.lineasNoInterpretadas) {
  porCodigo.set(l.codigo, (porCodigo.get(l.codigo) ?? 0) + 1);
}
for (const [c, n] of porCodigo) p(`    ${c}: ${n}`);

const v = verificarAritmetica(cuenta, { capacidades: CAPACIDADES_GALICIA });
p('');
p(`  VERIFICACION: ${v.estado}`);
p(
  `    verificoTotales=${v.verificoTotales} verificoSaldos=${v.verificoSaldos} ` +
    `verificoCadena=${v.verificoCadena}`,
);
p(`    filasConRuptura=[${v.filasConRuptura.slice(0, 12).join(',')}]`);
p(`    fechasMonotonas=${v.fechasMonotonas} dentroDelPeriodo=${v.fechasDentroDelPeriodo}`);
for (const d of v.diferencias.slice(0, 10)) {
  p(
    `    ${d.severidad}: ${d.codigo}` +
      `${d.filaNumero === undefined ? '' : ` fila=${d.filaNumero}`}` +
      `${d.campo === undefined ? '' : ` campo=${d.campo}`}`,
  );
}

// INV-13 sobre la salida real, que es donde importa.
const conIdent = cuenta.movimientos.filter((m) =>
  contieneIdentificador(depurarGlosa(m.descripcion).descripcion),
);
p('');
p(`  INV-13: descripciones con identificador tras depurar = ${conIdent.length}`);
p(
  `  hashes unicos = ${new Set(cuenta.movimientos.map((m) => m.filaHash)).size} de ` +
    `${cuenta.movimientos.length}`,
);
p(`  descripciones vacias = ${cuenta.movimientos.filter((m) => m.descripcion.trim() === '').length}`);

const parseado = extractoParseadoSchema.safeParse({
  bancoCodigo: 'galicia',
  adaptadorVersion: 1,
  capacidades: CAPACIDADES_GALICIA,
  archivoHash: 'a'.repeat(64),
  paginas: texto.paginas.length,
  ...(salida.paginasDeclaradas === undefined ? {} : { paginasDeclaradas: salida.paginasDeclaradas }),
  paginasSinTexto: [...texto.paginasSinTexto],
  cuentas: salida.cuentas,
  lineasNoInterpretadas: salida.lineasNoInterpretadas,
});
p('');
p(`  esquema Zod: ${parseado.success ? 'valida' : 'NO valida'}`);
if (!parseado.success) {
  for (const i of parseado.error.issues.slice(0, 8)) p(`    ${i.path.join('.')}: ${i.message}`);
}
p('');
