/**
 * % DE IDENTIDAD RESUELTA — misma definición fijada en HANDOFF 93: `propuesta` + categoría (a) de
 * `decision_humana` (identidad ya resuelta, falta Capa D — mapeo tipo→cuenta), sobre el corpus real.
 *
 *     pnpm medir:identidad --cliente <uuid> --usuario <uuid> --lote-id <uuid>
 *
 * Categoría (a), fijada en HANDOFF 93 con 5 de los 8 `queDecide` — el sexto (`completar_con_liquidacion_
 * de_la_tarjeta`, agregado después de esa medición) se trata como (a) por el mismo criterio que su par
 * `completar_con_liquidacion_del_adquirente` (identidad conocida, falta el documento externo) — supuesto
 * explícito, no confirmado contra HANDOFF 93 porque esa entrada no lo clasificó (probablemente 0
 * entonces). `distinguir_tercero_de_socio` es (d) y `confirmar_hipotesis_del_lexico` es (c) — ninguno de
 * los dos cuenta acá.
 *
 * NUNCA escribe — mismo criterio que `resolver-contrapartida.ts`.
 */
import { z } from 'zod';
import { conUsuario, leerEvidenciaDeMovimientos, leerPadronYCandidatosDeContraparte, verificarCredencialDeRequest, cerrarConexiones } from '@sistema-contable/data';
import { aplicarContrapartida, construirIndice, lexicoDe, marcarPadronConsultado, reconocer, resolverContraparte, type QueDecide, type Reconocimiento } from '@sistema-contable/contabilidad';
import { comoCandidatoDeContraparte, comoSocioDelPadron } from '@sistema-contable/ingesta';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const QUE_DECIDE_CATEGORIA_A: readonly QueDecide[] = [
  'completar_con_liquidacion_del_adquirente',
  'confirmar_computo_de_credito_fiscal',
  'confirmar_cuenta_propia_destino',
  'elegir_jurisdiccion_de_la_retencion',
  'elegir_cuenta_de_pasivo_del_impuesto',
  'completar_con_liquidacion_de_la_tarjeta',
];

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  loteId: z.string().regex(RE_UUID),
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
  const r = esquemaArgumentos.safeParse({ cliente: mapa.get('cliente') ?? '', usuario: mapa.get('usuario') ?? '', loteId: mapa.get('lote-id') ?? '' });
  if (!r.success) throw new Error('pnpm medir:identidad --cliente <uuid> --usuario <uuid> --lote-id <uuid>');
  return r.data;
}

async function medirLote(args: { readonly cliente: string; readonly usuario: string; readonly loteId: string }) {
  await verificarCredencialDeRequest();
  return conUsuario(args.usuario, async (tx) => {
  const evidencias = await leerEvidenciaDeMovimientos(tx, { clienteId: args.cliente, loteIngestaId: args.loteId });
  const { padron, candidatosPorMovimiento } = await leerPadronYCandidatosDeContraparte(tx, {
    clienteId: args.cliente,
    movimientoIds: evidencias.map((e) => e.movimientoId),
  });
  const padronConsultado = marcarPadronConsultado(padron.map(comoSocioDelPadron));
  const lexico = lexicoDe(evidencias[0]?.bancoCodigo ?? '');
  if (!lexico) return null;
  const indice = construirIndice(lexico);

  let propuesta = 0;
  let decisionHumana = 0;
  let sinReconocer = 0;
  const porQueDecide: Record<string, number> = {};

  for (const ev of evidencias) {
    const antes: Reconocimiento = reconocer(
      { bancoCodigo: ev.bancoCodigo, conceptoBanco: ev.conceptoBanco, conceptoCompleto: ev.conceptoCompleto, conceptoBancoEstrategia: ev.conceptoBancoEstrategia, conceptoCodigo: ev.conceptoCodigo, columnaOrigen: ev.columnaOrigen },
      indice,
    );
    let despues = antes;
    if (antes.clase === 'decision_humana' && antes.queDecide === 'distinguir_tercero_de_socio') {
      const candidatos = (candidatosPorMovimiento.get(ev.movimientoId) ?? []).map(comoCandidatoDeContraparte);
      const resolucion = resolverContraparte(candidatos, padronConsultado, ev.fecha, false);
      despues = aplicarContrapartida(antes, resolucion);
    }
    if (despues.clase === 'propuesta') propuesta += 1;
    else if (despues.clase === 'decision_humana') {
      decisionHumana += 1;
      porQueDecide[despues.queDecide] = (porQueDecide[despues.queDecide] ?? 0) + 1;
    } else sinReconocer += 1;
  }

  const categoriaA = QUE_DECIDE_CATEGORIA_A.reduce((acc, q) => acc + (porQueDecide[q] ?? 0), 0);
  const total = propuesta + decisionHumana + sinReconocer;
    return { total, propuesta, decisionHumana, sinReconocer, porQueDecide, categoriaA, identidadResuelta: propuesta + categoriaA };
  });
}

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/medir-identidad-resuelta.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const resultado = await medirLote(args);
    process.stdout.write(JSON.stringify(resultado, null, 2) + SALTO);
    process.exit(0);
  } finally {
    await cerrarConexiones();
  }
}
