/**
 * ALTA DEL PLAN DE CUENTAS — primera vez que `cuenta`/`cuenta_atributo` (`0027`) se llenan.
 *
 *     node apps/cli/src/alta-plan-cuentas.ts \
 *       --cliente <uuid> --usuario <uuid> --archivo <ruta al .xlsx> \
 *       [--mapeo <ruta a un JSON codigo→padronSocioId>] [--confirmar]
 *
 * ## Regla de impresión — `docs/seguridad/registro-incidentes.md` #14
 *
 * Vocabulario contable genérico se imprime libre (mismo criterio que los conceptos de un extracto
 * bancario). Una denominación que embeba nombre propio de persona real (hoy: `rolFuncionalCandidato
 * !== 'generica'`, patrón "Cuenta Particular") **nunca se imprime literal** — ni en el reporte de
 * anomalías, ni en la confirmación, ni en el resultado final. Se describe por código + patrón. Esta
 * regla rige SIEMPRE que esta CLI la ejecute un agente; si la ejecuta JP tecleando directo, JP puede
 * abrir el `.xlsx` él mismo para leer el contenido — la CLI no necesita imprimirlo para que JP confirme.
 *
 * Sin `--confirmar`: solo reporte (dry-run), no escribe nada. Con `--confirmar`: inserta.
 *
 * ## El mapeo código→`padron_socio_id`
 *
 * Un JSON `{ "codigo": "uuid-o-null", ... }`. Toda fila con `rolFuncionalCandidato ===
 * 'cuenta_particular_socio'` tiene que tener una entrada — si falta, ABORTA antes de tocar la base
 * (Opción A, D-25 de la segunda convocatoria: el adaptador nunca asume por matching de texto). El
 * mapeo REAL de un cliente (nombres reales) vive fuera del repo, en `privado/`, mismo régimen que su
 * `.xlsx` fuente (`seguridad-datos-financieros`, convocatoria de este adaptador) — nunca se commitea.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ANOMALIAS_BLOQUEANTES,
  cargarPlanDeCuentas,
  type NodoPlanCuentas,
  type ResultadoParseoPlanCuentas,
} from '@sistema-contable/ingesta';
import {
  altaPlanDeCuentas,
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  verificarCredencialDeRequest,
  type FilaAltaPlanCuentas,
} from '@sistema-contable/data';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

/** Nunca imprimir `denominacion` para un nodo no-genérico — describir por código + patrón (incidente #14). */
function descripcion(nodo: NodoPlanCuentas): string {
  return nodo.rolFuncionalCandidato === 'generica'
    ? `${nodo.codigo} "${nodo.denominacion}"`
    : `${nodo.codigo} (patrón: cuenta ligada a un socio — denominación no impresa, incidente #14)`;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

const esquemaArgs = z.object({
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  archivo: z.string().min(1),
  mapeo: z.string().min(1).optional(),
  confirmar: z.boolean(),
  vigenteDesde: z.string().regex(RE_FECHA),
});
export type ArgumentosAltaPlanCuentas = z.infer<typeof esquemaArgs>;

export function argumentos(argv: readonly string[] = process.argv.slice(2)): ArgumentosAltaPlanCuentas {
  const mapa = new Map<string, string>();
  let confirmar = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirmar') {
      confirmar = true;
      continue;
    }
    if (a?.startsWith('--')) {
      const clave = a.slice(2);
      const valor = argv[i + 1];
      if (valor !== undefined) mapa.set(clave, valor);
      i++;
    }
  }
  const parsed = esquemaArgs.safeParse({
    cliente: mapa.get('cliente'),
    usuario: mapa.get('usuario'),
    archivo: mapa.get('archivo'),
    mapeo: mapa.get('mapeo'),
    confirmar,
    vigenteDesde: mapa.get('vigente-desde') ?? new Date().toISOString().slice(0, 10),
  });
  if (!parsed.success) {
    throw new Error(
      `argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. ` +
        'Uso: --cliente <uuid> --usuario <uuid> --archivo <ruta> [--mapeo <ruta>] [--confirmar] [--vigente-desde YYYY-MM-DD]',
    );
  }
  return parsed.data;
}

function esquemaMapeo() {
  return z.record(z.string(), z.string().regex(RE_UUID).nullable());
}

export type ResolucionFilas = {
  readonly filas: readonly FilaAltaPlanCuentas[];
  readonly faltantesEnMapeo: readonly string[];
};

/** Resuelve las filas a insertar. NUNCA decide `padronSocioId` por matching de texto (D-25, Opción A). */
export function resolverFilas(
  resultado: ResultadoParseoPlanCuentas,
  mapeo: Readonly<Record<string, string | null>>,
  opciones: { readonly usuario: string; readonly vigenteDesde: string; readonly archivoRef: string; readonly mapeoRef: string | null },
): ResolucionFilas {
  const faltantesEnMapeo: string[] = [];
  const filas: FilaAltaPlanCuentas[] = [];
  for (const nodo of resultado.nodos) {
    let padronSocioId: string | null = null;
    if (nodo.rolFuncionalCandidato !== 'generica') {
      if (!(nodo.codigo in mapeo)) {
        faltantesEnMapeo.push(nodo.codigo);
        continue;
      }
      padronSocioId = mapeo[nodo.codigo] ?? null;
      if (padronSocioId === null) {
        // La migración exige padron_socio_id NOT NULL cuando rolFuncional liga a un socio —
        // una entrada explícita `null` en el mapeo significa "todavía no se resolvió", así que
        // ese nodo tampoco se puede insertar como socio-ligado hoy.
        faltantesEnMapeo.push(nodo.codigo);
        continue;
      }
    }
    const esSocio = nodo.rolFuncionalCandidato !== 'generica';
    filas.push({
      codigo: nodo.codigo,
      denominacion: nodo.denominacion,
      nivel: nodo.profundidadReal,
      cuentaPadreCodigo: nodo.sumariza,
      rolFuncional: nodo.rolFuncionalCandidato,
      padronSocioId,
      vigenteDesde: opciones.vigenteDesde,
      respaldo:
        `Carga plan de cuentas — archivo: ${opciones.archivoRef}, autorizado por: ${opciones.usuario}, ` +
        `fecha: ${opciones.vigenteDesde}` +
        (esSocio && opciones.mapeoRef ? ` — ver mapeo de socios: ${opciones.mapeoRef}` : ''),
    });
  }
  return { filas, faltantesEnMapeo };
}

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/alta-plan-cuentas.ts');

if (esEjecucionDirecta) {
  const args = argumentos();

  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    imprimir('  ABORTA: la credencial de DATABASE_URL_APP saltea RLS o es superusuario.');
    process.exit(1);
  }

  const contenido = readFileSync(args.archivo);
  const resultado = await cargarPlanDeCuentas(contenido);

  const mapeoCrudo = args.mapeo
    ? esquemaMapeo().parse(JSON.parse(readFileSync(args.mapeo, 'utf8')))
    : {};

  const { filas, faltantesEnMapeo } = resolverFilas(resultado, mapeoCrudo, {
    usuario: args.usuario,
    vigenteDesde: args.vigenteDesde,
    archivoRef: args.archivo,
    mapeoRef: args.mapeo ?? null,
  });

  imprimir('');
  imprimir(`  Nodos leídos: ${resultado.nodos.length}`);
  imprimir(
    `  Cuentas ligadas a socio (candidatas por patrón "Cuenta Particular"): ${
      resultado.nodos.filter((n) => n.rolFuncionalCandidato !== 'generica').length
    }`,
  );
  imprimir('');
  imprimir(`  Anomalías detectadas: ${resultado.anomalias.length}`);
  for (const a of resultado.anomalias) {
    imprimir(`    [${a.tipo}] ${a.codigo} — ${a.detalle}`);
  }
  if (!resultado.jerarquiaCruzadaEvaluable) {
    imprimir('    [jerarquia_cruzada] NO EVALUADA — el archivo no usa codificación segmentada consistente');
  }
  imprimir('');

  const bloqueantes = resultado.anomalias.filter((a) => ANOMALIAS_BLOQUEANTES.includes(a.tipo));
  if (bloqueantes.length > 0) {
    imprimir(`  ABORTA: ${bloqueantes.length} anomalía(s) bloqueante(s) — sin cuentaPadreId resoluble.`);
    process.exit(1);
  }

  if (faltantesEnMapeo.length > 0) {
    imprimir(`  ABORTA: ${faltantesEnMapeo.length} cuenta(s) ligada(s) a socio sin entrada en el mapeo:`);
    for (const codigo of faltantesEnMapeo) imprimir(`    ${codigo}`);
    imprimir('  Completá --mapeo antes de reintentar. Nunca se asume por matching de texto (D-25).');
    process.exit(1);
  }

  imprimir(`  Listo para insertar: ${filas.length} cuenta(s).`);
  for (const nodo of resultado.nodos) {
    if (nodo.rolFuncionalCandidato !== 'generica') imprimir(`    socio: ${descripcion(nodo)}`);
  }
  imprimir('');

  if (!args.confirmar) {
    imprimir('  DRY-RUN (sin --confirmar): no se escribió nada.');
    await cerrarConexiones();
    process.exit(0);
  }

  const resultadoAlta = await conUsuario(args.usuario, (tx) =>
    escribirConAuditoria(
      tx,
      {
        clienteId: args.cliente,
        accion: 'escritura',
        recurso: 'cuenta_atributo',
        motivo: `alta del plan de cuentas — archivo: ${args.archivo}, ${filas.length} cuentas`,
      },
      (ctx) => altaPlanDeCuentas(tx, ctx, { clienteId: args.cliente, filas }),
    ),
  );

  imprimir(`  OK — ${resultadoAlta.cuentasCreadas} cuenta(s) insertadas.`);
  await cerrarConexiones();
}
