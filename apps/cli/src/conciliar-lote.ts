/**
 * CLASIFICAR UN LOTE — Ítem E de Sesión 2b (`motor-conciliacion-contable`), migración `0030`-`0034`.
 *
 *     pnpm conciliar:lote --cliente <uuid> --usuario <uuid> --lote-id <uuid> --cierre-id <uuid>
 *       [--aplicar]
 *
 * Sin `--aplicar` es un DRY-RUN: corre el resolver entero y reporta qué haría, sin escribir una
 * fila. Mismo criterio que `reconocer-lote.ts`.
 *
 * ## `--cierre-id` es un argumento, no algo que este comando resuelva
 *
 * NO existe hoy ningún código de producción que cree o encuentre un `cierre_cliente_periodo` (B.13,
 * `docs/diseno/10-deuda-declarada.md`) — decisión explícita de JP de dejarlo fuera de esta tarea.
 * Quien invoque este comando tiene que pasar el `id` de un cierre ya abierto.
 *
 * ## Por qué este archivo puede reconstruir `{ clase: 'propuesta', ... }` (R-F)
 *
 * No arma una clasificación nueva: `leerReconocimientosParaImputar` ya filtró `clase = 'propuesta'`
 * en el `WHERE` (una decisión de la BASE, no de este archivo) y trae los campos reales de
 * `EvidenciaDelMatch` tal cual los persistió `reconocer-lote.ts` la primera vez. Reconstruir el
 * objeto acá es un RESHAPE de un hecho ya decidido y persistido, no una decisión nueva — mismo
 * argumento que ya cubre a `aislamiento-modulo-2.test.ts` en la allowlist de R-F
 * (`packages/data/tests/reglas-de-codigo.test.ts`), donde este archivo también está agregado.
 *
 * ## Adaptadores entre `data`/`contabilidad`/`motor-conciliacion`
 *
 * Este es el único lugar del repo que ve los tres paquetes a la vez (R-A/R-B y su espejo para
 * `motor-conciliacion`: ninguno de los tres puede importar a los otros dos). Los `cast`/adaptadores
 * de acá abajo son ese cruce, deliberado y acotado a este archivo.
 */

import { z } from 'zod';
import {
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  leerMapeoCuentasBancarias,
  leerPlanDeCuentasCompleto,
  leerReconocimientosParaImputar,
  leerReglasDeImputacionVigentes,
  escribirAsientoAutomatico,
  escribirPendienteDeImputacion,
  verificarCredencialDeRequest,
  type EvidenciaPendienteCierre,
  type FilaDelPlanDeCuentas,
  type FilaReconocimientoParaImputar,
  type MotivoPendienteCierre,
  type ReglaImputacion as ReglaImputacionData,
} from '@sistema-contable/data';
import {
  resolverAsiento,
  type CuentaBancariaResuelta,
  type CuentaDelPlan,
  type CuentaResolucionMotor,
  type EntradaResolver,
  type EvidenciaResolucion,
  type MotivoQueProduceElResolver,
  type ReglaImputacion,
  type RolFuncionalCuentaMotor,
} from '@sistema-contable/motor-conciliacion';
import type {
  ClaseDeReconocimiento,
  ConceptoCanonico,
  Lado,
  Polaridad,
  Reconocimiento,
  TipoMovimiento,
  ViaEvidencia,
} from '@sistema-contable/contabilidad';
import { loggerAcotado } from '@sistema-contable/shared/observabilidad';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CamposConciliar = 'cliente_id' | 'usuario_id' | 'lote_ingesta_id' | 'cierre_id' | 'aplicar' | 'motivo_codigo';
const log = loggerAcotado<CamposConciliar>();

function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

const esquemaArgumentos = z.object({
  cliente: z.string().regex(RE_UUID),
  usuario: z.string().regex(RE_UUID),
  loteId: z.string().regex(RE_UUID),
  cierreId: z.string().regex(RE_UUID),
  aplicar: z.boolean(),
});
export type ArgumentosConciliar = z.infer<typeof esquemaArgumentos>;

export function parsearArgumentos(argv: readonly string[]): ArgumentosConciliar {
  const mapa = new Map<string, string>();
  const banderas = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    if (actual?.startsWith('--')) {
      const clave = actual.slice(2);
      if (clave === 'aplicar') {
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
    cierreId: mapa.get('cierre-id') ?? '',
    aplicar: banderas.has('aplicar'),
  });
  if (!r.success) {
    const faltan = r.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; ');
    throw new Error(
      `Argumentos inválidos (${faltan}).${SALTO}${SALTO}` +
        '  pnpm conciliar:lote --cliente <uuid> --usuario <uuid> --lote-id <uuid> --cierre-id <uuid> [--aplicar]',
    );
  }
  return r.data;
}

// -----------------------------------------------------------------------------
// Adaptadores entre los tipos de `data`, `contabilidad` y `motor-conciliacion`
// -----------------------------------------------------------------------------

function comoReconocimiento(f: FilaReconocimientoParaImputar): Reconocimiento {
  // `clase` ya viene filtrada a 'propuesta' por `leerReconocimientosParaImputar` — el `as const`
  // es sobre un valor que la propia consulta garantiza, no una afirmación nueva de este archivo.
  return {
    clase: f.clase as Extract<ClaseDeReconocimiento, 'propuesta'>,
    tipo: f.tipo as TipoMovimiento,
    concepto: f.concepto as ConceptoCanonico,
    polaridad: f.polaridad as Polaridad,
    lado: f.lado as Lado,
    via: f.via as ViaEvidencia,
    evidencia: {
      entradaLexicoId: f.evidenciaEntradaLexicoId,
      via: f.via as ViaEvidencia,
      caracteresMatcheados: f.evidenciaCaracteresMatcheados,
      huboCola: f.evidenciaHuboCola,
    },
  };
}

function comoReglaImputacionMotor(r: ReglaImputacionData): ReglaImputacion {
  return {
    id: r.id,
    tipoMovimiento: r.tipoMovimiento as TipoMovimiento,
    concepto: r.concepto as ConceptoCanonico | null,
    cuentaResolucion: r.cuentaResolucion as CuentaResolucionMotor,
    cuentaId: r.cuentaId,
    vigenteDesde: r.vigenteDesde,
    vigenteHasta: r.vigenteHasta,
  };
}

function comoCuentaDelPlanMotor(c: FilaDelPlanDeCuentas): CuentaDelPlan {
  return {
    cuentaId: c.cuentaId,
    codigo: c.codigo,
    denominacion: c.denominacion,
    rolFuncional: c.rolFuncional as RolFuncionalCuentaMotor,
    activa: c.activa,
    vigenteDesde: c.vigenteDesde,
    vigenteHasta: c.vigenteHasta,
  };
}

function comoEvidenciaParaGuardar(ev: EvidenciaResolucion): EvidenciaPendienteCierre {
  return {
    via: ev.via,
    ...(ev.reglaContrapartidaAplicada ? { reglaContrapartidaAplicada: ev.reglaContrapartidaAplicada } : {}),
    ...(ev.reglaContrapartidaDescartada ? { reglaContrapartidaDescartada: ev.reglaContrapartidaDescartada } : {}),
    ...(ev.candidatosContrapartida ? { candidatosContrapartida: ev.candidatosContrapartida } : {}),
    ...(ev.cuentaBancariaAplicada ? { cuentaBancariaAplicada: ev.cuentaBancariaAplicada } : {}),
    ...(ev.contrapartidaTambienFallaba ? { contrapartidaTambienFallaba: ev.contrapartidaTambienFallaba } : {}),
  };
}

// -----------------------------------------------------------------------------
// Orquestación
// -----------------------------------------------------------------------------

export type MotivoAbortoConciliar = 'credencial_saltea_rls' | 'contexto_no_aislado';

export type ReporteDeConciliacion = {
  readonly estado: 'reportado';
  readonly aplicado: boolean;
  readonly totalMovimientos: number;
  readonly automaticos: number;
  readonly pendientesPorMotivo: Record<string, number>;
  readonly asientosCreados: number;
  readonly pendientesCreados: number;
  readonly pendientesYaExistentes: number;
};

export async function conciliarLote(
  args: ArgumentosConciliar,
): Promise<{ readonly estado: 'abortado'; readonly motivoCodigo: MotivoAbortoConciliar } | ReporteDeConciliacion> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    log.error('conciliar_lote.abortado', { motivo_codigo: 'credencial_saltea_rls' });
    return { estado: 'abortado', motivoCodigo: 'credencial_saltea_rls' };
  }
  if (!credencial.contextoLocalAislado) {
    return { estado: 'abortado', motivoCodigo: 'contexto_no_aislado' };
  }

  return conUsuario(args.usuario, async (tx) => {
    // Secuencial, NUNCA `Promise.all` sobre el mismo `tx`: un cliente de `pg` no admite más de una
    // consulta concurrente sobre la misma conexión — `Promise.all` las dispara todas a la vez y el
    // driver las intercala/serializa con un warning de deprecación, más allá de que hoy no haya
    // fallado el resultado. Encontrado corriendo el test de integración real, no en la convocatoria.
    const reconocimientos = await leerReconocimientosParaImputar(tx, { clienteId: args.cliente, loteIngestaId: args.loteId });
    const reglasData = await leerReglasDeImputacionVigentes(tx, { clienteId: args.cliente });
    const planData = await leerPlanDeCuentasCompleto(tx, { clienteId: args.cliente });
    const mapeoBanco = await leerMapeoCuentasBancarias(tx, { clienteId: args.cliente });

    const reglas = reglasData.map(comoReglaImputacionMotor);
    const planDeCuentas = planData.map(comoCuentaDelPlanMotor);

    type Resultado =
      | { readonly tipo: 'automatico'; readonly movimientoId: string; readonly fecha: string; readonly resultado: ReturnType<typeof resolverAsiento> }
      | { readonly tipo: 'pendiente'; readonly movimientoId: string; readonly motivoCodigo: MotivoQueProduceElResolver; readonly evidencia: EvidenciaPendienteCierre };

    const resultados: Resultado[] = [];

    for (const r of reconocimientos) {
      const cuentaBancaria: CuentaBancariaResuelta = {
        cuentaBancariaId: r.cuentaBancariaId,
        cuentaId: mapeoBanco.get(r.cuentaBancariaId) ?? null,
      };

      const entrada: EntradaResolver = {
        reconocimiento: comoReconocimiento(r),
        movimiento: { movimientoId: r.movimientoId, clienteId: args.cliente, fecha: r.fecha, importe: r.importe, cuentaBancariaId: r.cuentaBancariaId },
        cuentaBancaria,
        reglasImputacion: reglas,
        planDeCuentas,
      };

      const resultado = resolverAsiento(entrada);
      if (resultado.tipo === 'automatico') {
        resultados.push({ tipo: 'automatico', movimientoId: r.movimientoId, fecha: r.fecha, resultado });
      } else {
        resultados.push({
          tipo: 'pendiente',
          movimientoId: r.movimientoId,
          motivoCodigo: resultado.motivoCodigo,
          evidencia: comoEvidenciaParaGuardar(resultado.evidencia),
        });
      }
    }

    const pendientesPorMotivo: Record<string, number> = {};
    let automaticos = 0;
    for (const r of resultados) {
      if (r.tipo === 'automatico') automaticos += 1;
      else pendientesPorMotivo[r.motivoCodigo] = (pendientesPorMotivo[r.motivoCodigo] ?? 0) + 1;
    }

    const base = {
      estado: 'reportado' as const,
      totalMovimientos: resultados.length,
      automaticos,
      pendientesPorMotivo,
    };

    if (!args.aplicar) {
      log.info('conciliar_lote.dry_run', {
        cliente_id: args.cliente,
        lote_ingesta_id: args.loteId,
        cierre_id: args.cierreId,
      });
      return { ...base, aplicado: false, asientosCreados: 0, pendientesCreados: 0, pendientesYaExistentes: 0 };
    }

    let asientosCreados = 0;
    let pendientesCreados = 0;
    let pendientesYaExistentes = 0;

    // Un evento de auditoría por LOTE, no por movimiento — mismo criterio que `reconocer-lote.ts`.
    await escribirConAuditoria(
      tx,
      {
        clienteId: args.cliente,
        accion: 'escritura',
        recurso: 'asiento_propuesto',
        recursoId: args.loteId,
        motivo: 'clasificación de Capa D — motor-conciliacion-contable (Ítem E)',
      },
      async (ctx) => {
        for (const r of resultados) {
          if (r.tipo === 'automatico' && r.resultado.tipo === 'automatico') {
            await escribirAsientoAutomatico(tx, ctx, {
              clienteId: args.cliente,
              cierreId: args.cierreId,
              fechaImputacion: r.fecha,
              movimientoId: r.movimientoId,
              renglones: r.resultado.renglones,
            });
            asientosCreados += 1;
          } else if (r.tipo === 'pendiente') {
            const res = await escribirPendienteDeImputacion(tx, ctx, {
              clienteId: args.cliente,
              cierreId: args.cierreId,
              movimientoId: r.movimientoId,
              motivoCodigo: r.motivoCodigo as MotivoPendienteCierre,
              evidencia: r.evidencia,
            });
            if (res.estado === 'creado') pendientesCreados += 1;
            else pendientesYaExistentes += 1;
          }
        }
      },
    );

    return { ...base, aplicado: true, asientosCreados, pendientesCreados, pendientesYaExistentes };
  });
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const esEjecucionDirecta = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/cli/src/conciliar-lote.ts');

if (esEjecucionDirecta) {
  try {
    const args = parsearArgumentos(process.argv.slice(2));
    const r = await conciliarLote(args);
    imprimir(JSON.stringify(r, null, 2));
    if (r.estado === 'reportado' && !r.aplicado) {
      imprimir('');
      imprimir('  DRY-RUN: no se escribió ninguna fila. Volvé a correr con --aplicar.');
    }
    process.exit(r.estado === 'abortado' ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ motivo_codigo: 'error_interno', mensaje: String(error) })}${SALTO}`);
    process.exit(2);
  } finally {
    await cerrarConexiones();
  }
}
