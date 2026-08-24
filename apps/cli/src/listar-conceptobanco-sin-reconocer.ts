/**
 * MÉTODO REFORZADO (E-4) — muestra el `conceptoBanco` REAL (texto crudo, N2) de las filas
 * `sin_reconocer` de un lote, para que JP lo mire en su propia terminal y me pase de vuelta solo los
 * literales que hagan falta, ya redactados/tokenizados. Este script NO lo corre un agente — el texto
 * que imprime nunca tiene que cruzar al contexto de esta conversación tal cual.
 *
 *     pnpm listar:conceptobanco --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--contiene <texto>]
 *
 * Sin `--contiene`, lista TODOS los `conceptoBanco` distintos de las filas sin_reconocer, con su
 * conteo — para ver de un vistazo qué vocabulario usa el banco. Con `--contiene`, filtra a los que
 * incluyen ese substring (case-insensitive) — útil para acotar antes de mirar la lista completa.
 */
import { z } from 'zod';
import { conUsuario, leerEvidenciaDeMovimientos, verificarCredencialDeRequest, cerrarConexiones } from '@sistema-contable/data';
import { construirIndice, lexicoDe, reconocer } from '@sistema-contable/contabilidad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  loteId: z.string().regex(RE_UUID),
  contiene: z.string().optional(),
});

function parsearArgumentos(argv: readonly string[]) {
  const mapa = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('--')) throw new Error(`El argumento --${clave} necesita un valor.`);
      mapa.set(clave, valor);
      i += 1;
    }
  }
  const r = esquemaArgumentos.safeParse({
    cliente: mapa.get('cliente') ?? '',
    usuario: mapa.get('usuario') ?? '',
    loteId: mapa.get('lote-id') ?? '',
    contiene: mapa.get('contiene'),
  });
  if (!r.success) {
    throw new Error(
      `Argumentos inválidos.${SALTO}${SALTO}` +
        `  pnpm listar:conceptobanco --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--contiene <texto>]`,
    );
  }
  return r.data;
}

const args = parsearArgumentos(process.argv.slice(2));

try {
  await verificarCredencialDeRequest();

  await conUsuario(args.usuario, async (tx) => {
    const evidencias = await leerEvidenciaDeMovimientos(tx, { clienteId: args.cliente, loteIngestaId: args.loteId });
    const bancoCodigo = evidencias[0]?.bancoCodigo ?? '';
    const lexico = lexicoDe(bancoCodigo);
    if (!lexico) {
      process.stdout.write(`Sin léxico para el banco "${bancoCodigo}".${SALTO}`);
      return;
    }
    const indice = construirIndice(lexico);

    const conteos = new Map<string, number>();
    for (const ev of evidencias) {
      const r = reconocer(
        {
          bancoCodigo: ev.bancoCodigo,
          conceptoBanco: ev.conceptoBanco,
          conceptoCompleto: ev.conceptoCompleto,
          conceptoBancoEstrategia: ev.conceptoBancoEstrategia,
          conceptoCodigo: ev.conceptoCodigo,
          columnaOrigen: ev.columnaOrigen,
        },
        indice,
      );
      if (r.clase !== 'sin_reconocer') continue;
      const concepto = ev.conceptoBanco;
      if (concepto === undefined) continue;
      if (args.contiene && !concepto.toLowerCase().includes(args.contiene.toLowerCase())) continue;
      conteos.set(concepto, (conteos.get(concepto) ?? 0) + 1);
    }

    const filas = [...conteos.entries()].sort((a, b) => b[1] - a[1]);
    process.stdout.write(`${filas.length} conceptoBanco distintos entre las filas sin_reconocer${args.contiene ? ` (filtrado por "${args.contiene}")` : ''}:${SALTO}${SALTO}`);
    for (const [concepto, n] of filas) {
      process.stdout.write(`  [${String(n).padStart(3)}]  ${concepto}${SALTO}`);
    }
  });
} finally {
  await cerrarConexiones();
}
process.exit(0);
