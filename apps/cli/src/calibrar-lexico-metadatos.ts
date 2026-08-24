/**
 * CALIBRACIÓN DE LÉXICO — método reforzado (E-4, `docs/seguridad/registro-excepciones.md`).
 *
 * Corre el motor completo (capa B, `reconocer()`) sobre un lote real, igual que `resolver-contrapartida.ts`,
 * pero en vez de reportar la matriz de clases reporta, para las filas que caen en `clase: 'sin_reconocer'`
 * ("Indeterminado" en el export), cuántas matchean cada uno de un puñado de PATRONES CANDIDATOS —
 * pensados para calibrar 4 reglas de léxico provisorias (Galicia: suscripción FCI, formato de cobro de
 * tarjeta, Plan de Pagos AFIP) sin que el texto real de `concepto_banco` (N2 — trae nombres y a veces
 * CUIT de contraparte, `packages/shared/src/seguridad/clasificacion-campos.ts:426-434`) cruce al
 * contexto de ningún agente.
 *
 *     pnpm calibrar:lexico --cliente <uuid> --usuario <uuid> --lote-id <uuid>
 *
 * **Corré esto vos mismo, en tu propia terminal — no lo automatiza un agente.** La salida es solo
 * conteos agregados por patrón: nunca imprime `concepto_banco` de ninguna fila. Pegá la salida (JSON)
 * en el chat si hace falta decidir con eso; si algún conteo no alcanza para calibrar un regex, mirá vos
 * mismo el dato real y pasá solo el fragmento ya sustituido por tokens sintéticos (mismo criterio que el
 * Addendum E-2 del 24/08).
 *
 * NUNCA escribe: mismo criterio que `resolver-contrapartida.ts`, recalcula desde cero en cada corrida.
 */

import { z } from 'zod';
import {
  cerrarConexiones,
  conUsuario,
  leerEvidenciaDeMovimientos,
  verificarCredencialDeRequest,
} from '@sistema-contable/data';
import {
  construirIndice,
  lexicoDe,
  reconocer,
  type IndiceDeLexico,
  type Reconocimiento,
} from '@sistema-contable/contabilidad';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CamposCalibracion = 'cliente_id' | 'usuario_id' | 'lote_id' | 'total_movimientos' | 'motivo_codigo' | 'causa_tipo';
const log = loggerAcotado<CamposCalibracion>();

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

function causaTipo(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'desconocido';
}

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  loteId: z.string().regex(RE_UUID),
});
export type ArgumentosCalibracion = z.infer<typeof esquemaArgumentos>;

export function parsearArgumentos(argv: readonly string[]): ArgumentosCalibracion {
  const mapa = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('--')) {
        throw new Error(`El argumento --${clave} necesita un valor.`);
      }
      mapa.set(clave, valor);
      i += 1;
    }
  }
  const r = esquemaArgumentos.safeParse({
    cliente: mapa.get('cliente') ?? '',
    usuario: mapa.get('usuario') ?? '',
    loteId: mapa.get('lote-id') ?? '',
  });
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).${SALTO}${SALTO}` +
        `  pnpm calibrar:lexico --cliente <uuid> --usuario <uuid> --lote-id <uuid>`,
    );
  }
  return r.data;
}

// -----------------------------------------------------------------------------
// Patrones candidatos — pensados a partir del feedback de Laura (columna "Corrección/Identidad" del
// export enriquecido) y del criterio de dominio ya validado por `contador-dominio`. Nunca se imprime
// el texto contra el que matchean, solo el conteo de cuántas filas de `sin_reconocer` matchean cada uno.
// -----------------------------------------------------------------------------

// 🔴 Regla de anclaje, deliberada — no mezclar los dos tipos de patrón:
//   - `ya_reconocido_*` van ANCLADOS (`^...`) A PROPÓSITO: están chequeando el mismo criterio de
//     PREFIJO que usa el propio léxico (`matcher.ts`) para decidir si una entrada ya existente
//     matchea. Si el texto real no empieza así, el léxico tampoco lo reconocería hoy — es la
//     pregunta correcta para "¿ya está reconocido?".
//   - `candidato_*` NO van anclados (salvo que se sepa de antemano que el texto empieza ahí): son
//     hipótesis sobre un literal nuevo, y anclarlas de más da falsos negativos si el texto real
//     tiene cualquier prefijo antes de la frase buscada. (Corregido en esta sesión: `candidato_
//     cobro_de_tarjeta` estaba anclado por error, copiado del patrón de al lado — J.P. lo detectó
//     comparando contra `candidato_plan_pagos_afip`, que sí estaba bien.)
const PATRONES_CANDIDATOS: readonly { readonly etiqueta: string; readonly patron: RegExp }[] = [
  // Punto 1 del feedback: suscripción FCI (~8 filas Galicia). El léxico YA tiene una entrada
  // (`galicia.suscripcion_fci`, literal 'SUSCRIPCION FIMA') marcada `resuelve: 'sin_tipo_asignado'`
  // (`implementacion_diferida`) — el motor SÍ reconoce el literal, pero el resultado igual cae en
  // `clase: 'sin_reconocer'` (mismo patrón que documenta HANDOFF 93 para `rescate_fci`). Por eso
  // esta etiqueta cuenta DENTRO de `totalSinReconocer`, no es una contradicción del nombre: mide
  // "reconocido por el literal, pero bloqueado a propósito" vs. "un literal distinto, sin regla".
  { etiqueta: 'ya_reconocido_suscripcion_fima', patron: /^SUSCRIPCION FIMA/i },
  { etiqueta: 'candidato_fci_generico', patron: /FCI|FIMA|FONDO COM[UÚ]N/i },

  // Punto 2: formato de cobro de tarjeta (~3 filas Galicia). El léxico ya tiene `acreditamiento`
  // (literal 'ACREDITAMIENTO', prefijo). Este patrón mide si el texto real de Laura ya empieza así
  // (no falta regla) o si hace falta un literal nuevo bajo el mismo concepto.
  { etiqueta: 'ya_reconocido_acreditamiento', patron: /^ACREDITAMIENTO/i },
  // Sin anclar: es un candidato nuevo, no se sabe si "COBRO DE TARJETA" está al inicio del texto.
  { etiqueta: 'candidato_cobro_de_tarjeta', patron: /COBRO DE TARJETA/i },

  // Punto 3: Plan de Pagos AFIP (2 filas Galicia) — concepto nuevo, sin literal previo. Dos variantes
  // candidatas porque el texto de Laura ("PLAN DE PAGOS AFIP") puede no ser el literal exacto del banco.
  { etiqueta: 'candidato_plan_pagos_afip', patron: /PLAN DE PAGOS( AFIP)?/i },
  { etiqueta: 'candidato_plan_facilidades_afip', patron: /PLAN DE FACILIDADES/i },
  { etiqueta: 'contiene_afip', patron: /AFIP/i },
] as const;

export type ConteoCalibracion = {
  readonly totalSinReconocer: number;
  readonly sinConceptoBanco: number;
  readonly porPatron: Record<string, number>;
};

/** Pura — separada de la lectura para poder testearla con datos sintéticos, sin Postgres. */
export function contarPatrones(
  reconocimientos: readonly Reconocimiento[],
  conceptosPorIndice: readonly (string | undefined)[],
): ConteoCalibracion {
  const porPatron: Record<string, number> = Object.fromEntries(PATRONES_CANDIDATOS.map((p) => [p.etiqueta, 0]));
  let totalSinReconocer = 0;
  let sinConceptoBanco = 0;

  reconocimientos.forEach((r, i) => {
    if (r.clase !== 'sin_reconocer') return;
    totalSinReconocer += 1;
    const concepto = conceptosPorIndice[i];
    if (concepto === undefined) {
      sinConceptoBanco += 1;
      return;
    }
    for (const { etiqueta, patron } of PATRONES_CANDIDATOS) {
      if (patron.test(concepto)) porPatron[etiqueta] = (porPatron[etiqueta] ?? 0) + 1;
    }
  });

  return { totalSinReconocer, sinConceptoBanco, porPatron };
}

// -----------------------------------------------------------------------------
// Orquestación
// -----------------------------------------------------------------------------

export type MotivoAbortoCalibracion = 'credencial_saltea_rls' | 'contexto_no_aislado' | 'banco_sin_lexico';
export type ReporteCalibracion = { readonly estado: 'reportado'; readonly bancoCodigo: string } & ConteoCalibracion;

export async function calibrarLexicoDeLote(
  args: ArgumentosCalibracion,
): Promise<{ readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoCalibracion } | ReporteCalibracion> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('calibrar_lexico.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const resultado = await conUsuario(args.usuario, async (tx) => {
    const evidencias = await leerEvidenciaDeMovimientos(tx, { clienteId: args.cliente, loteIngestaId: args.loteId });
    const bancoCodigo = evidencias[0]?.bancoCodigo ?? '';
    const indice: IndiceDeLexico | undefined = lexicoDe(bancoCodigo) ? construirIndice(lexicoDe(bancoCodigo)!) : undefined;
    if (!indice) return { motivoCodigo: 'banco_sin_lexico' as const };

    const reconocimientos = evidencias.map((ev) =>
      reconocer(
        {
          bancoCodigo: ev.bancoCodigo,
          conceptoBanco: ev.conceptoBanco,
          conceptoCompleto: ev.conceptoCompleto,
          conceptoBancoEstrategia: ev.conceptoBancoEstrategia,
          conceptoCodigo: ev.conceptoCodigo,
          columnaOrigen: ev.columnaOrigen,
        },
        indice,
      ),
    );
    const conteo = contarPatrones(
      reconocimientos,
      evidencias.map((ev) => ev.conceptoBanco),
    );
    return { bancoCodigo, conteo };
  });

  if ('motivoCodigo' in resultado) {
    return { estado: 'abortado', motivoCodigo: resultado.motivoCodigo };
  }

  log.info('calibrar_lexico.reportado', {
    cliente_id: args.cliente,
    lote_id: args.loteId,
    total_movimientos: resultado.conteo.totalSinReconocer,
  });

  return { estado: 'reportado', bancoCodigo: resultado.bancoCodigo, ...resultado.conteo };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/calibrar-lexico-metadatos.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await calibrarLexicoDeLote(args);
    imprimir(JSON.stringify(r, null, 2));
    process.exit(r.estado === 'abortado' ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
