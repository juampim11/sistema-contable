/**
 * EXPORT DE FCI — genérico, PRELIMINAR (no el adapter oficial, mismo criterio que ya declara
 * `extraer-posiciones.ts` sobre sí mismo). E-2 (`docs/seguridad/registro-excepciones.md`).
 *
 * One-off por diseño, **no wireado a `package.json` raíz**: corre fuera del piloto (sin tenant), no
 * pasa por `conUsuario`/`conJob`, no persiste nada, no genera ningún asiento — es un entregable
 * informativo para que el estudio lo audite.
 *
 * 🔴 Sin ningún nombre de cliente, ruta ni fecha de corte hardcodeada en este archivo — todo entra
 * por `--config <ruta-json>`, un archivo LOCAL que nunca se commitea (vive en `privado/`, ya
 * gitignorado, o en el scratchpad de la sesión). Corrección de `security-engineer` (revisión de esta
 * misma tarea): la versión anterior tenía el nombre del cliente y los nombres/fechas reales de los 3
 * PDF de Elite-IT en el código versionado — E-2 solo autoriza eso como "efímero, fuera del repo",
 * nunca commiteado. Este archivo, genérico, sí puede vivir en el repo (mismo criterio que
 * `verificar-posicion.ts`); el config con los datos reales, no.
 *
 *     node packages/ingesta/scripts/exportar-fci.ts --config <ruta al JSON de config>
 *
 * Forma del JSON de config:
 *   {
 *     "etiqueta": "cualquier-string-para-el-nombre-del-archivo",
 *     "dirSalida": "ruta absoluta a una carpeta dentro de privado/",
 *     "cortes": [
 *       { "archivo": "ruta al PDF", "corte": "2025-06-30", "periodoDesde": "2025-06-01", "periodoHasta": "2025-06-30" },
 *       ...
 *     ]
 *   }
 *
 * Lee los PDF reales que indique el config (nunca del repo). Corre el eje 1 (`extraerPosicionesFci`)
 * y el eje 2 (`simularFondo` → `consumirRescate`), arma el libro (`armarLibroFci`) y lo escribe DENTRO
 * de `dirSalida`. La consola imprime SOLO conteos y booleanos — nunca una cifra real del cliente.
 *
 * Se frena ANTES de escribir el `.xlsx` si algún invariante no cierra — nunca entrega un archivo con
 * un hallazgo sin resolver adentro (ver los `ABORTADO` de abajo, cada uno con su motivo).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { aPuntoFijo, CERO, esCero, formatear, multiplicar, sumar, type PuntoFijo } from '@sistema-contable/fci';
import { extraerPosicionesFci, type FondoExtraido } from '../src/fci-galicia/extraer-posiciones.ts';
import { simularFondo, type CorteDeFondo, type SnapshotDeCorte } from '../src/fci-galicia/simular-fondo.ts';
import {
  armarLibroFci,
  serializarLibroFci,
  type FilaHojaFondo,
  type FilaHojaResumen,
} from '../src/fci-galicia/armar-libro-fci.ts';

const p = (t: string): void => {
  process.stdout.write(t + '\n');
};

// -----------------------------------------------------------------------------
// 0. Config — nunca un literal en este archivo, siempre `--config <ruta>`.
// -----------------------------------------------------------------------------
const RE_NOMBRE_ARCHIVO_SEGURO = /^[a-zA-Z0-9._-]+$/;

const esquemaCorte = z.object({
  archivo: z.string().min(1),
  corte: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'corte tiene que ser ISO YYYY-MM-DD'),
  periodoDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodoDesde tiene que ser ISO YYYY-MM-DD'),
  periodoHasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodoHasta tiene que ser ISO YYYY-MM-DD'),
});

const esquemaConfig = z.object({
  etiqueta: z
    .string()
    .regex(RE_NOMBRE_ARCHIVO_SEGURO, 'etiqueta solo puede tener letras, números, punto, guion y guion bajo'),
  dirSalida: z.string().min(1),
  cortes: z.array(esquemaCorte).min(1),
});

const indiceConfig = process.argv.indexOf('--config');
const rutaConfig = indiceConfig === -1 ? undefined : process.argv[indiceConfig + 1];
if (!rutaConfig) {
  p('');
  p('  node packages/ingesta/scripts/exportar-fci.ts --config <ruta al JSON de config>');
  p('');
  p('  El config NUNCA se commitea — ver el header de este archivo para su forma.');
  p('');
  process.exit(2);
}

const configCruda: unknown = JSON.parse(readFileSync(rutaConfig, 'utf8'));
const parseoConfig = esquemaConfig.safeParse(configCruda);
if (!parseoConfig.success) {
  p(`ABORTADO: config inválido — ${parseoConfig.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  process.exit(1);
}
const config = parseoConfig.data;

// 🔴 Hallazgo de `code-reviewer`: al genericizar este script, `config.cortes` pasó de ser un array
// hardcodeado (visible en cualquier diff) a un JSON externo armado a mano por el operador — y nada
// verificaba que viniera ordenado cronológicamente. `simularFondo` usa `cortesOrdenados[0]` como base
// de la capa de apertura y confía en el orden sin comprobarlo; con `config.cortes` desordenado, el
// caso general lo detecta el guard `orden_no_peps` de `consumirRescate` (con un mensaje que no apunta
// al problema real), pero hay un caso borde donde NO crashea y produce un export cronológicamente
// incorrecto en silencio. Comparación lexicográfica alcanza: `corte` ya es ISO `YYYY-MM-DD`.
for (let i = 1; i < config.cortes.length; i += 1) {
  if (config.cortes[i]!.corte <= config.cortes[i - 1]!.corte) {
    p(
      `ABORTADO: config.cortes no está ordenado cronológicamente ascendente — ` +
        `"${config.cortes[i - 1]!.corte}" seguido de "${config.cortes[i]!.corte}".`,
    );
    process.exit(1);
  }
}

const DIR_SALIDA = config.dirSalida;
const ARCHIVO_SALIDA = join(DIR_SALIDA, `fci_${config.etiqueta}.xlsx`);

// -----------------------------------------------------------------------------
// 1. Extracción — eje 1.
// -----------------------------------------------------------------------------
const extraccionesPorCorte: { readonly corte: string; readonly fondos: readonly FondoExtraido[] }[] = [];
for (const c of config.cortes) {
  const bytes = readFileSync(c.archivo);
  const extraccion = await extraerPosicionesFci(bytes, { desde: c.periodoDesde, hasta: c.periodoHasta });
  extraccionesPorCorte.push({ corte: c.corte, fondos: extraccion.fondos });
}

const cantidadDeFondos = extraccionesPorCorte[0]!.fondos.length;
const cantidadConsistente = extraccionesPorCorte.every((e) => e.fondos.length === cantidadDeFondos);
p(`extraccion: cortes=${extraccionesPorCorte.length} fondosPorCorte=${cantidadDeFondos} cantidadConsistenteEntreCortes=${cantidadConsistente}`);
if (cantidadDeFondos === 0) {
  p('ABORTADO: 0 fondos reconocidos — el extractor no matcheó nada en ninguno de los cortes.');
  process.exit(1);
}
if (!cantidadConsistente) {
  p('ABORTADO: la cantidad de fondos no es la misma en todos los cortes — no se genera el archivo.');
  process.exit(1);
}

// 🔴 Hallazgo bloqueante de `code-reviewer`: `movimientosConfiables` es la ÚNICA señal de que, para
// un fondo en un corte, la fecha no resolvió o el orden no fue monótono — en ese caso `movimientos`
// queda `[]` EN SILENCIO (`extraer-posiciones.ts`, `FondoExtraido.movimientosConfiables`). Sin este
// chequeo, los dos "predicción falsable" de más abajo (conteo esperado vs. real) se calculan a partir
// de ese mismo campo ya vaciado y darían "consistente" igual — falsa confianza. Se verifica ACÁ,
// antes de cualquier otro cálculo.
const todosConfiables = extraccionesPorCorte.every((e) => e.fondos.every((f) => f.movimientosConfiables));
p(`movimientosConfiables en todos los fondos/cortes: ${todosConfiables}`);
if (!todosConfiables) {
  p('ABORTADO: al menos un fondo/corte tiene movimientosConfiables=false — hallazgo real, no se fuerza el export.');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 2. Simulación por fondo — eje 2.
// -----------------------------------------------------------------------------
type ResultadoPorFondo = {
  readonly fondo: string;
  readonly simulacion: ReturnType<typeof simularFondo>;
};

const resultadosPorFondo: ResultadoPorFondo[] = [];
for (let i = 0; i < cantidadDeFondos; i += 1) {
  const cortesDeFondo: CorteDeFondo[] = config.cortes.map((c, idx) => {
    const fondo = extraccionesPorCorte[idx]!.fondos[i]!;
    return {
      corte: c.corte,
      periodoDesde: c.periodoDesde,
      tenenciaDeclarada: fondo.tenenciaDeclarada,
      movimientos: fondo.movimientos,
    };
  });
  const simulacion = simularFondo(cortesDeFondo);
  resultadosPorFondo.push({ fondo: extraccionesPorCorte[0]!.fondos[i]!.fondo, simulacion });
}

// -----------------------------------------------------------------------------
// 3. Predicción falsable — se frena ANTES de armar el libro si algo no cierra. Solo booleanos y
//    conteos, nunca una cifra real.
// -----------------------------------------------------------------------------
let huboSinCubrir = false;
for (const r of resultadosPorFondo) {
  for (const consumo of r.simulacion.consumos) {
    if (!esCero(consumo.resultado.cantidadSinCubrir)) huboSinCubrir = true;
  }
}
p(`eje2: rescatesConSinCubrir=${huboSinCubrir}`);
if (huboSinCubrir) {
  p('ABORTADO: al menos un rescate no cubrió su cantidad con las capas disponibles — hallazgo real, no se fuerza el export.');
  process.exit(1);
}

const movimientosPorFondoEsperado = extraccionesPorCorte.reduce<number[]>((acc, e) => {
  e.fondos.forEach((f, i) => {
    acc[i] = (acc[i] ?? 0) + f.movimientos.length;
  });
  return acc;
}, []);
p(`movimientos por fondo (suma de todos los cortes): [${movimientosPorFondoEsperado.join(', ')}]`);

// -----------------------------------------------------------------------------
// 4. Armado de filas — hoja por fondo.
// -----------------------------------------------------------------------------
function sumaDeResultados(items: readonly { readonly resultado: PuntoFijo }[]): PuntoFijo {
  return items.reduce((acc, it) => sumar(acc, it.resultado), CERO);
}

function totalDeMovimiento(cantidad: string, precio: string): string {
  return formatear(multiplicar(aPuntoFijo(cantidad), aPuntoFijo(precio)));
}

const hojasPorFondo: { readonly fondo: string; readonly filas: readonly FilaHojaFondo[] }[] = [];
let hayEstimadoEnAlgunLado = false;

for (let i = 0; i < cantidadDeFondos; i += 1) {
  const resultado = resultadosPorFondo[i]!;
  const filas: FilaHojaFondo[] = [];
  let siguienteConsumo = 0;

  for (let c = 0; c < config.cortes.length; c += 1) {
    const fondoDelCorte = extraccionesPorCorte[c]!.fondos[i]!;

    for (const movimiento of fondoDelCorte.movimientos) {
      if (movimiento.tipo === 'suscripcion') {
        filas.push({
          fecha: movimiento.fecha,
          tipo: 'suscripcion',
          cantidadDeCuotas: movimiento.cantidad,
          precio: movimiento.precio,
          total: totalDeMovimiento(movimiento.cantidad, movimiento.precio),
          rendimientoPorRescate: null,
          estimado: null,
          stockAlCierre: null,
          valorUnitarioAlCierre: null,
          valuacionAlCierre: null,
        });
        continue;
      }

      // `simularFondo` produjo sus `consumos` en el MISMO orden de documento que estos movimientos
      // (corte por corte, filtrado a rescates, mismo array `fondo.movimientos` que este loop recorre)
      // — se consumen en paralelo, nunca por matching de valores.
      const consumo = resultado.simulacion.consumos[siguienteConsumo]!;
      siguienteConsumo += 1;
      if (consumo.resultado.parcialmenteEstimado) hayEstimadoEnAlgunLado = true;

      filas.push({
        fecha: movimiento.fecha,
        tipo: 'rescate',
        cantidadDeCuotas: movimiento.cantidad,
        precio: movimiento.precio,
        total: totalDeMovimiento(movimiento.cantidad, movimiento.precio),
        rendimientoPorRescate: formatear(sumaDeResultados(consumo.resultado.items)),
        estimado: consumo.resultado.parcialmenteEstimado,
        stockAlCierre: null,
        valorUnitarioAlCierre: null,
        valuacionAlCierre: null,
      });
    }

    filas.push({
      fecha: '',
      tipo: 'cierre',
      cantidadDeCuotas: null,
      precio: null,
      total: null,
      rendimientoPorRescate: null,
      estimado: null,
      stockAlCierre: fondoDelCorte.tenenciaDeclarada,
      valorUnitarioAlCierre: fondoDelCorte.cotizacionDeclarada,
      valuacionAlCierre: fondoDelCorte.valorizadoDeclarada,
    });
  }

  // Todo consumo de este fondo tiene que haberse consumido exactamente una vez — si sobrara alguno,
  // se estaría perdiendo un rescate entero del `.xlsx` en silencio (hallazgo menor de `code-reviewer`,
  // hoy inalcanzable dado cómo se arma `resultadosPorFondo`, pero barato de blindar).
  if (siguienteConsumo !== resultado.simulacion.consumos.length) {
    p(
      `ABORTADO: el fondo "${resultado.fondo}" tiene ${resultado.simulacion.consumos.length} rescates simulados ` +
        `pero se consumieron ${siguienteConsumo} al armar las filas — desalineación real entre extracción y simulación.`,
    );
    process.exit(1);
  }

  hojasPorFondo.push({ fondo: resultado.fondo, filas });
}
p(`incluyeEstimados: ${hayEstimadoEnAlgunLado}`);

// -----------------------------------------------------------------------------
// 5. Armado de filas — hoja Resumen (una fila por corte, consolidando todos los fondos).
// -----------------------------------------------------------------------------
function valorHistoricoDe(snapshot: SnapshotDeCorte | undefined): string {
  // Estado imposible dado cómo se arma `cortesDeFondo` arriba (un `CorteDeFondo` por elemento de
  // `config.cortes`, y `simularFondo` empuja un snapshot por cada uno, incondicionalmente) — un
  // `undefined` acá significa que esa invariante se rompió en otro lado. Se lanza, no se completa con
  // `CERO`: un "$0" plausible pero falso es peor que un crash (hallazgo menor de `code-reviewer`).
  if (!snapshot) throw new Error('inalcanzable: falta el snapshot de un corte al armar el Resumen');
  const total = snapshot.capasAbiertas.reduce(
    (acc, capa) => sumar(acc, multiplicar(capa.cantidadRemanente, capa.precioUnitarioOrigen)),
    CERO,
  );
  return formatear(total);
}

const resumen: FilaHojaResumen[] = config.cortes.map((c, idx) => {
  const porFondo = resultadosPorFondo.map((r, i) => ({
    fondo: r.fondo,
    cantidad: extraccionesPorCorte[idx]!.fondos[i]!.tenenciaDeclarada,
    valorHistorico: valorHistoricoDe(r.simulacion.snapshots[idx]),
    valuacionAlCierre: extraccionesPorCorte[idx]!.fondos[i]!.valorizadoDeclarada,
  }));

  let hayEstimadosEnElCorte = false;
  const rendimientoConsolidado = resultadosPorFondo.reduce((acc, r) => {
    const consumosDeEsteCorte = r.simulacion.consumos.filter((cons) => cons.corte === c.corte);
    for (const cons of consumosDeEsteCorte) {
      if (cons.resultado.parcialmenteEstimado) hayEstimadosEnElCorte = true;
    }
    const suma = consumosDeEsteCorte.reduce((a, cons) => sumar(a, sumaDeResultados(cons.resultado.items)), CERO);
    return sumar(acc, suma);
  }, CERO);

  return {
    corte: c.corte,
    porFondo,
    rendimientoPorRescatesConsolidado: formatear(rendimientoConsolidado),
    hayEstimadosEnElCorte,
  };
});

// -----------------------------------------------------------------------------
// 6. Chequeo final de conteo (predicción falsable) antes de escribir un solo byte.
// -----------------------------------------------------------------------------
const filasDeMovimientoPorHoja = hojasPorFondo.map((h) => h.filas.filter((f) => f.tipo !== 'cierre').length);
const conteoOk = filasDeMovimientoPorHoja.every((n, i) => n === movimientosPorFondoEsperado[i]);
p(`conteo de filas de movimiento por hoja coincide con lo extraído: ${conteoOk} [${filasDeMovimientoPorHoja.join(', ')}]`);
if (!conteoOk) {
  p('ABORTADO: el conteo de filas no coincide — no se escribe el archivo.');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 7. Armado del libro y escritura — SOLO en `config.dirSalida` (responsabilidad de quien arma el
//    config: que sea una ruta dentro de `privado/` o equivalente gitignorado).
// -----------------------------------------------------------------------------
const libro = armarLibroFci({ hojasPorFondo, resumen });
const buffer = await serializarLibroFci(libro);

mkdirSync(DIR_SALIDA, { recursive: true });
writeFileSync(ARCHIVO_SALIDA, buffer);

p('');
p(`hojas=${hojasPorFondo.length + 1} (${hojasPorFondo.length} por fondo + Resumen)`);
p(`archivo=${ARCHIVO_SALIDA}`);
p(`bytes=${buffer.byteLength}`);
p('OK — export generado.');
