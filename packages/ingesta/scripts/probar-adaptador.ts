/**
 * CORRIDA DE UN ADAPTADOR CONTRA UN ARCHIVO REAL, con salida **sin valores**.
 *
 *     node packages/ingesta/scripts/probar-adaptador.ts --banco <codigo> --archivo <ruta al PDF>
 *
 * ## Qué hace y qué NO hace
 *
 * Lee el PDF, lo parsea y lo verifica. **No toca la base ni el almacenamiento**: no abre una conexión, no
 * inserta nada, no escribe ningún objeto. Es la diferencia entre *leer para medir* —que es lo que hay que
 * hacer para saber si el adaptador entendió el documento— y *ingestar*, que persiste datos de un cliente.
 *
 * Imprime **conteos, códigos y estados**. Ningún importe, ninguna glosa, ningún identificador, ningún
 * número de cuenta. Es lo que permite pegar el resultado en un ticket o en el HANDOFF sin pensarlo dos
 * veces — la misma disciplina que el resto del módulo: el diagnóstico no puede ser el canal de fuga.
 *
 * ## Por qué genérico y no uno por banco
 *
 * Porque pasa por `resolverAdaptador`, que es **el mismo camino que usa el CLI**. Así la corrida verifica
 * tres cosas más que un script a medida no vería: que `reconoce()` enganche el documento, que **ningún
 * otro adaptador lo reconozca también** (el registro devuelve `ambiguo` y eso es un hallazgo), y que el
 * banco declarado coincida con el detectado.
 *
 * Y corre los controles de LOTE —INV-multicuenta y el conteo de cuentas declaradas— que por definición no
 * se pueden ver mirando una cuenta sola.
 */

import { readFileSync } from 'node:fs';
import { cargarEnv } from '../../../tools/cargar-env.ts';
import { aFilas, extraerTexto } from '../src/texto-pdf.ts';
import { formaParaLog } from '@sistema-contable/shared/observabilidad';
import { adaptadorGalicia } from '../src/adaptadores/galicia.ts';
import { adaptadorMacro } from '../src/adaptadores/macro.ts';
import { adaptadorSantander } from '../src/adaptadores/santander.ts';
import { adaptadorBancor } from '../src/adaptadores/bancor.ts';
import { adaptadorNacion } from '../src/adaptadores/nacion.ts';
import { registrarAdaptador, resolverAdaptador } from '../src/adaptadores/registro.ts';
import {
  verificarAritmetica,
  verificarConsolidadoPorMoneda,
  verificarConteoDeCuentas,
  verificarDestinos,
} from '../src/verificacion/invariantes.ts';
import { contieneIdentificador, depurarGlosa } from '../src/glosa.ts';
import { extractoParseadoSchema, type CapacidadesAdaptador } from '../src/esquema.ts';

cargarEnv();

// Los tres, como en el borde de la aplicación. Que el registro tenga más de uno es lo que hace
// significativo que `resolverAdaptador` devuelva exactamente uno.
registrarAdaptador(adaptadorGalicia);
registrarAdaptador(adaptadorMacro);
registrarAdaptador(adaptadorSantander);
registrarAdaptador(adaptadorBancor);
registrarAdaptador(adaptadorNacion);

const SALTO = String.fromCharCode(10);
const p = (t: string): void => {
  process.stdout.write(t + SALTO);
};

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v?.startsWith('--') === false ? v : undefined;
}

const banco = argumento('banco');
const ruta = argumento('archivo');
if (!banco || !ruta) {
  p('');
  p('  node packages/ingesta/scripts/probar-adaptador.ts --banco <codigo> --archivo <ruta>');
  p('');
  p('  Lee y verifica. NO toca la base ni el almacenamiento.');
  p('');
  process.exit(2);
}

const contenido = readFileSync(ruta);
const texto = await extraerTexto(contenido);
const filas = await aFilas(contenido);

p('');
p(`  archivo_bytes=${contenido.byteLength}`);
p(
  `  paginas=${texto.paginas.length} sinTexto=[${texto.paginasSinTexto.join(',')}] ` +
    `requiereOcr=${texto.requiereOcr}`,
);
p(`  filas geometricas=${filas.length}`);

// -----------------------------------------------------------------------------
// El registro: el mismo camino que el CLI.
// -----------------------------------------------------------------------------
/**
 * `--caratula <n>` — las **formas** de las primeras `n` filas geométricas, con la `x` de cada fragmento.
 *
 * ## Para qué, y por qué es seguro
 *
 * Es la misma lente que resolvió el anexo de un banco y el CBU de otro: cuando un dato **existe en el
 * documento y el adaptador no lo lee**, el conteo no alcanza —dice "no está" y no dice por qué—. La
 * **forma** (dígitos a `9`, mayúsculas a `A`, minúsculas a `a`) muestra la estructura del renglón **sin
 * contener un solo dato**, y es lo único que se puede imprimir de la carátula, que es donde viven el CUIT y
 * la razón social del titular.
 *
 * La `x` es geometría del formato que imprime el banco: la misma para todos sus clientes, no es dato de
 * nadie, y es la que dice si el rótulo abre la fila o tiene algo a la izquierda.
 *
 * **No se activa sola.** Hay que pedirla, porque es una lente de diagnóstico y no parte del veredicto.
 */
const nCaratula = Number(argumento('caratula') ?? '0');
if (nCaratula > 0) {
  p('');
  p(`  ── FORMAS DE LAS PRIMERAS ${nCaratula} FILAS (solo estructura, ningún dato) ──`);
  /**
   * **Por FRAGMENTO, no por fila.** La forma de la fila entera no alcanza para decidir dónde termina un
   * campo: `textoDeFila` une todos los fragmentos con un espacio, así que un rótulo y la columna vecina que
   * comparte baseline se ven exactamente igual que un solo texto largo. Y esa diferencia es la que decide si
   * un lector que corta "todo lo que sigue a la etiqueta" se lleva puesta la columna de al lado.
   *
   * Con la `x` de cada fragmento al lado de su forma, la pregunta se contesta mirando: si el nombre está en
   * el mismo fragmento que su rótulo, se lee; si el rótulo está solo, hay que ir al siguiente.
   */
  for (const [i, f] of filas.slice(0, nCaratula).entries()) {
    p(`  ${String(i).padStart(3)} p${f.pagina}`);
    for (const g of f.fragmentos) {
      p(`      x=${g.x.toFixed(1).padStart(6)}  ${formaParaLog(g.texto, 80)}`);
    }
  }
}

const cual = resolverAdaptador({ filas }, banco);
p('');
p(`  RESOLUCION: ${cual.estado}`);
if (cual.estado !== 'encontrado') {
  if (cual.estado === 'ambiguo') p(`    candidatos=[${cual.candidatos.join(',')}]`);
  if (cual.estado === 'sin_adaptador') p(`    registrados=[${cual.bancosRegistrados.join(',')}]`);
  process.exit(1);
}

const capacidades = cual.adaptador.capacidades as CapacidadesAdaptador;
const salida = cual.adaptador.leer({ filas });

if (salida.cuentas.length === 0) {
  p('  SIN CUENTAS: el adaptador no pudo armar ninguna.');
  p(`  no interpretadas=${salida.lineasNoInterpretadas.length}`);
  for (const l of salida.lineasNoInterpretadas.slice(0, 8)) {
    p(`    ${l.codigo} pag=${l.paginaPdf} forma=${l.forma}`);
  }
  process.exit(1);
}

const movimientosEnElLote = salida.cuentas.reduce((n, c) => n + c.movimientos.length, 0);

// -----------------------------------------------------------------------------
// LOTE — lo que no se puede ver mirando una cuenta sola.
// -----------------------------------------------------------------------------
p('');
p('  ── LOTE ──');
p(`  cuentas detectadas=${salida.cuentas.length}  declaradas=${salida.cuentasDeclaradas ?? 'sin dato'}`);
p(`  movimientos totales=${movimientosEnElLote}`);
p(`  paginasDeclaradas=${salida.paginasDeclaradas ?? 'sin dato'}`);
p(`  no interpretadas=${salida.lineasNoInterpretadas.length}`);

const porCodigo = new Map<string, number>();
for (const l of salida.lineasNoInterpretadas) {
  porCodigo.set(l.codigo, (porCodigo.get(l.codigo) ?? 0) + 1);
}
for (const [c, n] of porCodigo) p(`    ${c}: ${n}`);

/**
 * 🔴 **QUÉ HAY EN EL RESIDUO.**
 *
 * "No interpretada" no quiere decir "descartada": la línea se reporta con su **forma**. Pero un conteo
 * solo dice *cuántas*, y lo que hay que saber es *qué son* — porque si entre ellas hay un renglón de
 * carátula con un dato que el adaptador NO está leyendo, eso sí es información que se pierde.
 *
 * La `forma` es el texto con los dígitos a `9`, las mayúsculas a `A` y las minúsculas a `a`: alcanza para
 * reconocer la estructura de un renglón y **no contiene ni un dato**. Es lo único que se puede imprimir.
 *
 * Se agrupan las formas repetidas: un encabezado que aparece 45 veces es un renglón, no cuarenta y cinco.
 */
const porForma = new Map<string, number>();
for (const l of salida.lineasNoInterpretadas) {
  porForma.set(l.forma, (porForma.get(l.forma) ?? 0) + 1);
}
const formas = [...porForma.entries()].sort((a, b) => b[1] - a[1]);
p(`  formas distintas en el residuo=${formas.length}`);
for (const [f, n] of formas.slice(0, 15)) p(`    ×${n}  ${f}`);
if (formas.length > 15) p(`    … y ${formas.length - 15} formas más`);

const consolidado = verificarConsolidadoPorMoneda(salida.cuentas, salida.consolidadosPorMoneda ?? [], {
  declaraConsolidado: capacidades.traeConsolidadoPorMoneda,
});
p(
  `  INV-multicuenta: verificado=${consolidado.verificado} ` +
    `renglones=${salida.consolidadosPorMoneda?.length ?? 0} ` +
    `diferencias=${consolidado.diferencias.length}`,
);
for (const d of consolidado.diferencias) p(`    ${d.severidad}: ${d.codigo} campo=${d.campo ?? '-'}`);

const conteo = verificarConteoDeCuentas(salida.cuentas.length, salida.cuentasDeclaradas);
p(`  INV-conteo de cuentas: diferencias=${conteo.length}`);
for (const d of conteo) p(`    ${d.severidad}: ${d.codigo}`);

// A2 (C5): el gate de residuo. `salida.destinos` no existe hasta que el adaptador declare
// `declaraDestinos: true` — ver `verificarDestinos`.
const destinos = verificarDestinos(salida.destinos, capacidades.declaraDestinos);
p(
  `  INV-destinos: sinDestino=${salida.destinos?.sinDestino ?? 'sin dato'} ` +
    `fueraDelCuerpo=${salida.destinos?.fueraDelCuerpo ?? 'sin dato'} diferencias=${destinos.length}`,
);
for (const d of destinos) p(`    ${d.severidad}: ${d.codigo}`);

// -----------------------------------------------------------------------------
// POR CUENTA — la verificación aritmética es por cuenta, siempre.
// -----------------------------------------------------------------------------
let peor = 'cuadra';
for (const [i, c] of salida.cuentas.entries()) {
  const m = c.movimientos;
  p('');
  p(`  ── CUENTA ${i + 1} de ${salida.cuentas.length} ── moneda=${c.cuenta.moneda} tipo=${c.cuenta.tipoCuenta}`);
  p(`  movimientos=${m.length}`);
  p(`  periodo=${c.cuenta.periodoDesde ?? 'sin dato'} .. ${c.cuenta.periodoHasta ?? 'sin dato'}`);
  p(
    `  saldoInicialDeclarado=${c.cuenta.saldoInicialDeclarado === undefined ? 'no' : 'si'} ` +
      `saldoFinalDeclarado=${c.cuenta.saldoFinalDeclarado === undefined ? 'no' : 'si'} ` +
      `totalesDeclarados=${c.cuenta.totalCreditosDeclarado === undefined ? 'no' : 'si'}`,
  );

  /**
   * 🔴 **LO QUE SE LEYÓ DE LA CARÁTULA — presencia, nunca el valor.**
   *
   * Es la contracara del residuo: no alcanza con saber que 141 líneas quedaron sin clasificar, hay que
   * saber si **el dato que importa se extrajo igual**. Una fila de carátula puede estar sin clasificar y
   * su valor ya leído por etiqueta: son dos cosas distintas.
   *
   * Y el renglón `resoluble por INV-6` es el que decide si este lote se puede ingestar: sin número ni CBU,
   * `resolverCuentaDelExtracto` no tiene contra qué buscar y **el lote se rechaza entero**. Vale saberlo
   * ahora y no en la primera corrida real.
   */
  const ident = c.cuenta.numero !== undefined || c.cuenta.cbu !== undefined;
  p(
    `  CARATULA: numero=${c.cuenta.numero === undefined ? 'no' : 'si'} ` +
      `cbu=${c.cuenta.cbu === undefined ? 'no' : 'si'} ` +
      `titular=${c.cuenta.titular === undefined ? 'no' : 'si'} ` +
      `documento=${c.cuenta.titularDocumento === undefined ? 'no' : 'si'} ` +
      `condicionIva=${c.cuenta.titularCondicionIva === undefined ? 'no' : 'si'}`,
  );
  p(`  resoluble por INV-6 (hay numero o cbu): ${ident ? 'SI' : 'NO — el lote se rechazaria'}`);
  // 🔴 EL REPARTO, que es el criterio de Done que la cadena de saldos NO atrapa: un parser que ponga
  //    todo en una columna da 0 rupturas si además invierte el saldo.
  p(`  creditos=${m.filter((x) => x.credito !== undefined).length}`);
  p(`  debitos=${m.filter((x) => x.debito !== undefined).length}`);
  p(`  con saldo negativo=${m.filter((x) => x.saldoEsAcreedor === true).length}`);
  p(`  con referencias=${m.filter((x) => (x.referencias?.length ?? 0) > 0).length}`);
  p(`  con conceptoBanco=${m.filter((x) => x.conceptoBanco !== undefined).length}`);
  /**
   * Las dos métricas que hablan de la **calidad de la glosa**, que es lo único que los conteos de filas
   * no verifican. Un adaptador puede clavar 158 movimientos con las descripciones mutiladas: los importes
   * cuadran, la cadena cierra, y el producto está roto. Es el peor modo de falla del módulo.
   */
  p(`  conceptos distintos=${new Set(m.map((x) => x.conceptoBanco ?? '')).size}`);
  const porLineas = new Map<number, number>();
  for (const x of m) {
    const n = x.descripcionLineas.length;
    porLineas.set(n, (porLineas.get(n) ?? 0) + 1);
  }
  p(
    `  lineas de glosa por movimiento: ${[...porLineas.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, c]) => `${n}→${c}`)
      .join(' ')}`,
  );
  p(`  fechas distintas=${new Set(m.map((x) => x.fecha)).size}`);
  p(`  paginas con movimientos=${new Set(m.map((x) => x.paginaPdf)).size}`);
  p(`  anexos=${c.anexos.length}`);

  const v = verificarAritmetica(c, { capacidades, movimientosEnElLote });
  p(`  VERIFICACION: ${v.estado}`);
  p(
    `    verificoTotales=${v.verificoTotales} verificoSaldos=${v.verificoSaldos} ` +
      `verificoCadena=${v.verificoCadena}`,
  );
  p(`    filasConRuptura=${v.filasConRuptura.length} [${v.filasConRuptura.slice(0, 12).join(',')}]`);
  p(`    fechasMonotonas=${v.fechasMonotonas} dentroDelPeriodo=${v.fechasDentroDelPeriodo}`);
  for (const d of v.diferencias.slice(0, 10)) {
    p(
      `    ${d.severidad}: ${d.codigo}` +
        `${d.filaNumero === undefined ? '' : ` fila=${d.filaNumero}`}` +
        `${d.campo === undefined ? '' : ` campo=${d.campo}`}`,
    );
  }
  if (v.diferencias.length > 10) p(`    … y ${v.diferencias.length - 10} más`);
  if (v.estado === 'no_cuadra') peor = 'no_cuadra';
  else if (v.estado === 'no_verificable' && peor === 'cuadra') peor = 'no_verificable';
}

// -----------------------------------------------------------------------------
// Los dos invariantes de secreto, sobre la salida REAL — que es donde importan.
// -----------------------------------------------------------------------------
const todos = salida.cuentas.flatMap((c) => c.movimientos);

const conIdent = todos.filter((m) => contieneIdentificador(depurarGlosa(m.descripcion).descripcion));

// INV-14: `conceptoBanco` tiene que ser prefijo de la descripción DEPURADA. Es lo que sostiene que la
// columna sea N2 y no arrastre la tabla al régimen de lectura auditada.
const rompenInv14 = todos.filter((m) => {
  if (m.conceptoBanco === undefined) return false;
  if (m.conceptoBancoEstrategia === 'columna_propia') return false;
  return !depurarGlosa(m.descripcion).descripcion.startsWith(depurarGlosa(m.conceptoBanco).descripcion);
});

p('');
p('  ── INVARIANTES DE SECRETO ──');
p(`  INV-13: descripciones con identificador tras depurar = ${conIdent.length}   (tiene que ser 0)`);
p(`  INV-14: conceptoBanco que no es prefijo de la descripcion = ${rompenInv14.length}   (tiene que ser 0)`);
p(`  descripciones vacias = ${todos.filter((m) => m.descripcion.trim() === '').length}`);
for (const c of salida.cuentas) {
  const hashes = new Set(c.movimientos.map((m) => m.filaHash));
  p(`  hashes unicos por cuenta = ${hashes.size} de ${c.movimientos.length}`);
}
// Entre cuentas: dos movimientos idénticos en cuentas distintas NO pueden compartir hash.
const todosLosHashes = todos.map((m) => m.filaHash);
p(`  hashes unicos en el lote = ${new Set(todosLosHashes).size} de ${todosLosHashes.length}`);

// -----------------------------------------------------------------------------
const parseado = extractoParseadoSchema.safeParse({
  bancoCodigo: cual.adaptador.bancoCodigo,
  adaptadorVersion: cual.adaptador.version,
  capacidades,
  archivoHash: 'a'.repeat(64),
  paginas: texto.paginas.length,
  ...(salida.paginasDeclaradas === undefined ? {} : { paginasDeclaradas: salida.paginasDeclaradas }),
  paginasSinTexto: [...texto.paginasSinTexto],
  cuentas: salida.cuentas,
  ...(salida.consolidadosPorMoneda === undefined
    ? {}
    : { consolidadosPorMoneda: salida.consolidadosPorMoneda }),
  lineasNoInterpretadas: salida.lineasNoInterpretadas,
});
p('');
p(`  esquema Zod: ${parseado.success ? 'valida' : 'NO valida'}`);
if (!parseado.success) {
  for (const i of parseado.error.issues.slice(0, 10)) p(`    ${i.path.join('.')}: ${i.message}`);
}

p('');
p(`  VEREDICTO DEL LOTE: ${peor}`);
p('');
