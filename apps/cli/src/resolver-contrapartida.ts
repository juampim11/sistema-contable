/**
 * DRY-RUN DE CAPA C — corre el motor completo (capa B, `reconocer()` + capa C, `resolverContraparte()`
 * / `aplicarContrapartida()`) sobre un lote real y reporta la matriz de clases antes/después. Plan
 * `adaptive-herding-pillow` (Módulo 2, capa C), P6.
 *
 *     pnpm resolver:contrapartida --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--padron-completo]
 *
 * NUNCA escribe: no hay migración `0014` (fuera de alcance de esta etapa, decisión del usuario) —
 * cada corrida recalcula desde cero.
 *
 * ## `--padron-completo`, y por qué es un flag manual y no un dato persistido
 *
 * `contador-dominio` (Ronda 1) exige un gate explícito, atestiguado por un humano, antes de que
 * "ningún candidato matchea" se proponga automáticamente como tercero (`04-imputacion-contable.md`:
 * *"sin padrón consultado, 'no es socio' no es una conclusión: es ausencia de control"*). Sin la
 * migración `0014` no hay dónde persistir un atributo del cliente con vigencia — eso es dominio de
 * `plan-cuentas-multicliente` y no existe todavía. En vez de fabricar un lugar de guardado ad-hoc, el
 * gate es un flag que el CONTADOR pasa a mano en CADA corrida: decisión explícita, nunca un "quedó
 * prendido" silencioso. Se revisita cuando exista la tabla real.
 *
 * ## Qué imprime
 *
 * Conteos agregados por clase y por estado de resolución, y los `socioId` (uuid) involucrados en un
 * `es_socio`. NUNCA `denominacion` — ni por accidente: `leerPadronDeSocios` no la trae a esta
 * consulta (Ronda 1, `seguridad-datos-financieros`).
 */

import { z } from 'zod';
import {
  cerrarConexiones,
  conUsuario,
  leerEvidenciaDeMovimientos,
  leerPadronYCandidatosDeContraparte,
  verificarCredencialDeRequest,
  type EvidenciaDeMovimientoLeida,
} from '@sistema-contable/data';
import {
  aplicarContrapartida,
  construirIndice,
  lexicoDe,
  marcarPadronConsultado,
  reconocer,
  resolverContraparte,
  type IndiceDeLexico,
  type Reconocimiento,
} from '@sistema-contable/contabilidad';
import { comoCandidatoDeContraparte, comoSocioDelPadron } from '@sistema-contable/ingesta';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CamposResolucion =
  | 'cliente_id'
  | 'usuario_id'
  | 'lote_id'
  | 'total_movimientos'
  | 'padron_completo'
  | 'motivo_codigo'
  | 'causa_tipo';
const log = loggerAcotado<CamposResolucion>();

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
  padronCompleto: z.boolean(),
});
export type ArgumentosResolucion = z.infer<typeof esquemaArgumentos>;

export function parsearArgumentos(argv: readonly string[]): ArgumentosResolucion {
  const mapa = new Map<string, string>();
  const banderas = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      if (clave === 'padron-completo') {
        banderas.add(clave);
        continue;
      }
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
    padronCompleto: banderas.has('padron-completo'),
  });
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).${SALTO}${SALTO}` +
        `  pnpm resolver:contrapartida --cliente <uuid> --usuario <uuid> --lote-id <uuid> [--padron-completo]`,
    );
  }
  return r.data;
}

// -----------------------------------------------------------------------------
// La matriz — pura, sin base. Testable con datos sintéticos.
// -----------------------------------------------------------------------------

// 🔴 `ESTADOS_RESOLUCION` se MOVIÓ a `packages/contabilidad/src/nucleo/tipos.ts` en `0021`: desde
// que existe `contrapartida_estado_chk`, la constante espeja un dominio cerrado DE LA BASE, y el
// test de catálogo que los compara vive en `packages/data`, que no puede importar de `apps/`. Se
// re-exporta acá para no romper a quien la importaba de este módulo.
import { ESTADOS_RESOLUCION, type EstadoResolucion } from '@sistema-contable/contabilidad';
export { ESTADOS_RESOLUCION, type EstadoResolucion };

export const CLASES = ['propuesta', 'decision_humana', 'sin_reconocer'] as const;
export type Clase = (typeof CLASES)[number];

export type Matriz = {
  readonly porClaseAntes: Record<Clase, number>;
  readonly porClaseDespues: Record<Clase, number>;
  readonly porEstadoDeResolucion: Record<EstadoResolucion, number>;
  /** 🔴 EL CONTEO, NUNCA LA LISTA (H-2, cerrado por `0021`). Esta estructura se publica entera a
   *  stdout con `process.stdout.write`, que **esquiva el redactor**, y `socio_id` pasó a **N2** con
   *  `0021`: la variante anterior (`readonly string[]`) dejaba en disco, sin clasificar y sin
   *  rastro, la lista de socios de un cliente ante un simple `pnpm resolver:contrapartida > x.json`.
   *  El conteo responde la única pregunta que el reporte necesita —cuántos socios distintos
   *  aparecieron— sin nombrar a ninguno. */
  readonly sociosInvolucrados: number;
  /** Movimientos de un banco sin léxico registrado (fuera del roster de 3 bancos del piloto) —
   *  se saltan del cálculo, pero CONTADOS acá (Ronda 3, `code-reviewer`): sin esto, el total
   *  reportado no reflejaría el tamaño real del lote sin que el operador se entere. */
  readonly sinLexico: number;
};

function filaVaciaDeClase(): Record<Clase, number> {
  return { propuesta: 0, decision_humana: 0, sin_reconocer: 0 };
}

function filaVaciaDeEstado(): Record<EstadoResolucion, number> {
  return Object.fromEntries(ESTADOS_RESOLUCION.map((e) => [e, 0])) as Record<EstadoResolucion, number>;
}

/**
 * Agrega los pares (reconocimiento antes de capa C, reconocimiento después) en la matriz completa.
 * Pura — separada de la lectura para poder testearla con datos sintéticos sin Postgres.
 */
export function agregarMatriz(
  pares: readonly { readonly antes: Reconocimiento; readonly despues: Reconocimiento }[],
  sinLexico = 0,
): Matriz {
  const porClaseAntes = filaVaciaDeClase();
  const porClaseDespues = filaVaciaDeClase();
  const porEstadoDeResolucion = filaVaciaDeEstado();
  const socios = new Set<string>();

  for (const { antes, despues } of pares) {
    porClaseAntes[antes.clase] += 1;
    porClaseDespues[despues.clase] += 1;

    const evidencia =
      despues.clase !== 'sin_reconocer' ? despues.evidenciaContrapartida : undefined;
    if (evidencia) {
      porEstadoDeResolucion[evidencia.estado] += 1;
      if (evidencia.estado === 'es_socio') socios.add(evidencia.socioId);
    }
  }

  return {
    porClaseAntes,
    porClaseDespues,
    porEstadoDeResolucion,
    sociosInvolucrados: socios.size,
    sinLexico,
  };
}

// -----------------------------------------------------------------------------
// Orquestación
// -----------------------------------------------------------------------------

export type MotivoAbortoResolucion = 'credencial_saltea_rls' | 'contexto_no_aislado';
/** `padronCompleto` queda en el reporte (Ronda 3, `qa-funcional`): sin esto, auditar una corrida
 *  vieja no dice bajo qué supuesto salió la matriz — dependería de que alguien haya guardado aparte
 *  la línea de comando exacta. */
export type ReporteResolucion = { readonly estado: 'reportado'; readonly padronCompleto: boolean } & Matriz;

export async function resolverContrapartidaDeLote(
  args: ArgumentosResolucion,
): Promise<{ readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoResolucion } | ReporteResolucion> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('resolver_contrapartida.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  const matriz = await conUsuario(args.usuario, async (tx) => {
    const evidencias = await leerEvidenciaDeMovimientos(tx, { clienteId: args.cliente, loteIngestaId: args.loteId });

    const { padron, candidatosPorMovimiento } = await leerPadronYCandidatosDeContraparte(tx, {
      clienteId: args.cliente,
      movimientoIds: evidencias.map((e) => e.movimientoId),
    });
    const padronConsultado = marcarPadronConsultado(padron.map(comoSocioDelPadron));

    const indicesPorBanco = new Map<string, IndiceDeLexico>();
    function indiceDe(bancoCodigo: string): IndiceDeLexico | undefined {
      const cacheado = indicesPorBanco.get(bancoCodigo);
      if (cacheado) return cacheado;
      const lexico = lexicoDe(bancoCodigo);
      if (!lexico) return undefined;
      const indice = construirIndice(lexico);
      indicesPorBanco.set(bancoCodigo, indice);
      return indice;
    }

    const pares: { readonly antes: Reconocimiento; readonly despues: Reconocimiento }[] = [];
    let sinLexico = 0;
    for (const ev of evidencias) {
      const indice = indiceDe(ev.bancoCodigo);
      if (!indice) {
        // Banco sin léxico registrado (fuera del roster de 3 bancos del piloto) — no es un caso de
        // esta etapa; se salta en vez de fallar el lote entero, pero CONTADO (Ronda 3, code-reviewer):
        // sin esto, el total reportado no reflejaría el tamaño real del lote sin aviso.
        sinLexico += 1;
        continue;
      }
      const antes = reconocer(evidenciaDeMotorDesde(ev), indice);

      let despues = antes;
      if (antes.clase === 'decision_humana' && antes.queDecide === 'distinguir_tercero_de_socio') {
        const candidatos = (candidatosPorMovimiento.get(ev.movimientoId) ?? []).map(comoCandidatoDeContraparte);
        const resolucion = resolverContraparte(candidatos, padronConsultado, ev.fecha, args.padronCompleto);
        despues = aplicarContrapartida(antes, resolucion);
      }
      pares.push({ antes, despues });
    }

    return agregarMatriz(pares, sinLexico);
  });

  log.info('resolver_contrapartida.reportado', {
    cliente_id: args.cliente,
    lote_id: args.loteId,
    total_movimientos: Object.values(matriz.porClaseDespues).reduce((a, b) => a + b, 0),
    padron_completo: args.padronCompleto,
  });

  return { estado: 'reportado', padronCompleto: args.padronCompleto, ...matriz };
}

function evidenciaDeMotorDesde(ev: EvidenciaDeMovimientoLeida) {
  return {
    bancoCodigo: ev.bancoCodigo,
    conceptoBanco: ev.conceptoBanco,
    conceptoCompleto: ev.conceptoCompleto,
    conceptoBancoEstrategia: ev.conceptoBancoEstrategia,
    conceptoCodigo: ev.conceptoCodigo,
    columnaOrigen: ev.columnaOrigen,
  };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/resolver-contrapartida.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await resolverContrapartidaDeLote(args);
    imprimir(JSON.stringify(r, null, 2));
    process.exit(r.estado === 'abortado' ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', causa_tipo: causaTipo(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
