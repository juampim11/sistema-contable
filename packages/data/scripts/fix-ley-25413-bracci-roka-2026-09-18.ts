/**
 * FIX PUNTUAL, HACIA ADELANTE — Ley 25413, Bracci y ROKA (2026-09-18).
 *
 * Corrige dos errores reales de la `regla_imputacion` de `impuesto_debitos_creditos` aplicada el
 * 2026-09-04 para los dos clientes: (1) no distinguía créditos de débitos — los débitos NUNCA son
 * computables a Ganancias bajo ningún %, y quedaban igual mandados a "Pago a Cuenta Ganancias"; (2)
 * asumía 100% computable en los créditos sin conocer la categorización MiPyME real de ninguno de los
 * dos clientes (dato que hoy no existe en el sistema — `categorizacion_mipyme`, diseñada pero sin
 * aplicar todavía).
 *
 * Dictamen de `contador-dominio` (sesión 2026-09-18, convocatoria real vía `Agent()`): una cuenta
 * PUENTE/transitoria aloja el crédito hasta el ajuste de cierre de ejercicio, que reclasifica según la
 * categorización MiPyME confirmada. El lado débitos vuelve a la cuenta original de cada cliente (nunca
 * fue el error que motivó la corrección de Laura — se rompió por generalización indebida del tipo
 * completo). Script puntual, fuera de `apps/cli/src`, a propósito: `alta-regla-imputacion.ts` está
 * dictaminado (doc 31 §B) para SOLO reglas generales del tipo (`concepto: null`) — esta corrección
 * necesita dos reglas por CONCEPTO, que ese CLI no sirve ni debe empezar a servir sin su propia
 * convocatoria. `altaPlanDeCuentas` tampoco sirve para el alta de Bracci: solo resuelve el padre de
 * una cuenta CONTRA EL PROPIO LOTE que se está insertando (alta inicial del plan completo), nunca
 * contra un padre ya existente en un plan ya poblado — se resuelve acá con `leerPlanDeCuentasCompleto`
 * + un insert directo, mismas dos sentencias que usa esa función internamente.
 *
 * Hacia ADELANTE únicamente: ningún asiento ya generado con la regla vieja se toca. La reclasificación
 * de lo ya generado es un ajuste de cierre aparte, fuera de este script.
 *
 * Corre UNA vez contra el piloto real:
 *
 *     ENV_FILE=.env.piloto node packages/data/scripts/fix-ley-25413-bracci-roka-2026-09-18.ts
 *
 * Ver HANDOFF.md (entrada de esta tarea) para el detalle completo de la convocatoria y el dictamen.
 */

import {
  altaReglaImputacion,
  cerrarConexiones,
  conUsuario,
  escribirConAuditoria,
  leerPlanDeCuentasCompleto,
  verificarCredencialDeRequest,
  type FilaDelPlanDeCuentas,
} from '@sistema-contable/data';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

const SALTO = String.fromCharCode(10);
function imprimir(t: string): void {
  process.stdout.write(t + SALTO);
}

const ACTOR = '11111111-1111-1111-1111-111111111111'; // socio, membership vigente en ESTUDIO PILOTO (verificado antes de escribir este script — única identidad real con rol socio/contador en este entorno).
const HOY = '2026-09-18';
const TIPO = 'impuesto_debitos_creditos';
const CONCEPTO_CREDITOS = 'impuesto_25413_sobre_creditos';
const CONCEPTO_DEBITOS = 'impuesto_25413_sobre_debitos';

function porCodigo(plan: readonly FilaDelPlanDeCuentas[], codigo: string): FilaDelPlanDeCuentas {
  const candidatas = plan.filter((c) => c.codigo === codigo && c.activa && c.vigenteHasta === null);
  if (candidatas.length !== 1) {
    throw new Error(`Esperaba exactamente 1 cuenta activa y vigente con código "${codigo}", encontré ${candidatas.length}.`);
  }
  return candidatas[0] as FilaDelPlanDeCuentas;
}

type Fix = {
  readonly clienteId: string;
  readonly nombre: string;
  readonly codigoDebitos: string; // cuenta ORIGINAL del cliente para impuesto_25413_sobre_debitos (vuelve ahí)
  /** Bracci: alta de cuenta nueva. ROKA: reasigna 1.2.3.600 (0 movimientos históricos verificado). */
  readonly puente: { readonly modo: 'alta_nueva'; readonly codigo: string; readonly denominacion: string; readonly codigoPadre: string; readonly nivel: number; readonly respaldo: string }
             | { readonly modo: 'renombrar'; readonly codigo: string; readonly denominacionNueva: string; readonly respaldo: string };
};

const FIXES: readonly Fix[] = [
  {
    clienteId: 'f84d9ecc-6d54-4009-8fb6-b6fa3f8d8579',
    nombre: 'Bracci',
    codigoDebitos: '1.2.3.130', // "Ley Deb Cred. Bancario" — cuenta original, antes del 2026-09-04
    puente: {
      modo: 'alta_nueva',
      codigo: '1.2.3.240',
      denominacion: 'Ley 25413 Deb.Cred.Bancario a Recuperar',
      codigoPadre: '1.2.3.000', // "Impuestos Anticipados" — mismo padre que 1.2.3.210/220/230
      nivel: 4,
      respaldo:
        'Alta correctiva — la regla_imputacion de impuesto_25413_sobre_creditos vigente desde ' +
        '2026-09-04 enviaba el 100% de cada movimiento (créditos y débitos, sin distinguir) directo ' +
        'a 1.2.3.230 Pago a Cuenta Ganancias, sin conocer la categorización MiPyME real del cliente. ' +
        'Esta cuenta aloja transitoriamente el crédito hasta el ajuste de cierre de ejercicio, que ' +
        'reclasifica según la categorización MiPyME confirmada: la porción computable pasa a ' +
        '1.2.3.230, el resto a gasto no deducible, saldando esta cuenta a cero. Dictamen ' +
        'contador-dominio, sesión 2026-09-18. Autorizado por el titular.',
    },
  },
  {
    clienteId: '69479b8f-9b6a-4d6b-bdb2-bff817c2e750',
    nombre: 'ROKA',
    codigoDebitos: '4.2.3.310', // "Impuesto al Débito Bancario" — cuenta original, antes del 2026-09-04
    puente: {
      modo: 'renombrar',
      codigo: '1.2.3.600', // "Imp DB CR bancario" — verificado 0 movimientos históricos antes de reasignar
      denominacionNueva: 'Ley 25413 DB CR Bancario a Recuperar',
      respaldo:
        'Alta/resignificación correctiva — la regla_imputacion de impuesto_25413_sobre_creditos ' +
        'vigente desde 2026-09-04 enviaba el 100% de cada movimiento (créditos y débitos, sin ' +
        'distinguir) directo a 1.2.3.230 Pago a Cuenta Ganancias, sin conocer la categorización ' +
        'MiPyME real del cliente. Se reutiliza 1.2.3.600, verificado sin movimientos históricos ' +
        '(count = 0, consulta directa 2026-09-18), en lugar de dar de alta un código nuevo. Esta ' +
        'cuenta aloja transitoriamente el crédito hasta el ajuste de cierre de ejercicio, que ' +
        'reclasifica según la categorización MiPyME confirmada: la porción computable pasa a ' +
        '1.2.3.230, el resto a gasto no deducible (el antecedente de ROKA, 4.2.3.310 Impuesto al ' +
        'Débito Bancario, trataba el 100% como gasto — ese criterio queda reemplazado por esta ' +
        'apertura activo/gasto). Dictamen contador-dominio, sesión 2026-09-18. Autorizado por el ' +
        'titular.',
    },
  },
];

async function aplicarFix(fix: Fix): Promise<void> {
  imprimir('');
  imprimir(`=== ${fix.nombre} (${fix.clienteId}) ===`);

  await conUsuario(ACTOR, async (tx) => {
    const planAntes = await leerPlanDeCuentasCompleto(tx, { clienteId: fix.clienteId });
    const cuentaDebitos = porCodigo(planAntes, fix.codigoDebitos);

    // 1) Cuenta puente — alta nueva o renombrar, según el cliente.
    let cuentaPuenteId: string;
    if (fix.puente.modo === 'alta_nueva') {
      const puente = fix.puente; // narrowing perdido dentro del closure de abajo si se accede vía fix.puente
      const cuentaPadre = porCodigo(planAntes, puente.codigoPadre);
      cuentaPuenteId = await escribirConAuditoria(
        tx,
        { clienteId: fix.clienteId, accion: 'escritura', recurso: 'cuenta_atributo', motivo: `fix-ley-25413: alta cuenta puente ${puente.codigo} (${fix.nombre})` },
        async () => {
          const insertadaCuenta = await tx.consultar<{ id: string }>(
            `insert into cuenta (cliente_id) values ($1) returning id::text as id`,
            [fix.clienteId],
          );
          const id = insertadaCuenta[0]?.id;
          if (!id) throw new Error('El alta de cuenta (puente) no devolvió id.');
          await tx.consultar(
            `insert into cuenta_atributo
               (cliente_id, cuenta_id, codigo, denominacion, nivel, cuenta_padre_id, rol_funcional,
                padron_socio_id, vigente_desde, respaldo)
             values ($1, $2, $3, $4, $5, $6, 'generica', null, $7::date, $8)`,
            [fix.clienteId, id, puente.codigo, puente.denominacion, puente.nivel, cuentaPadre.cuentaId, HOY, puente.respaldo],
          );
          return id;
        },
      );
      imprimir(`  Cuenta puente (alta nueva): ${puente.codigo} "${puente.denominacion}" -> ${cuentaPuenteId}`);
    } else {
      const puente = fix.puente; // idem — capturar antes del closure
      const cuentaExistente = porCodigo(planAntes, puente.codigo);
      cuentaPuenteId = cuentaExistente.cuentaId;
      await escribirConAuditoria(
        tx,
        { clienteId: fix.clienteId, accion: 'escritura', recurso: 'cuenta_atributo', motivo: `fix-ley-25413: renombrar ${puente.codigo} (${fix.nombre})` },
        async () => {
          const cerrado = await tx.consultar(
            `update cuenta_atributo set vigente_hasta = $1::date
              where cliente_id = $2 and cuenta_id = $3 and vigente_hasta is null
              returning cuenta_id::text as id`,
            [HOY, fix.clienteId, cuentaPuenteId],
          );
          if (cerrado.length !== 1) throw new Error(`Esperaba cerrar exactamente 1 vigencia de ${puente.codigo}, cerré ${cerrado.length}.`);
          await tx.consultar(
            `insert into cuenta_atributo
               (cliente_id, cuenta_id, codigo, denominacion, nivel, cuenta_padre_id, rol_funcional,
                padron_socio_id, vigente_desde, respaldo)
             select cliente_id, cuenta_id, codigo, $1, nivel, cuenta_padre_id, rol_funcional,
                    padron_socio_id, $2::date, $3
               from cuenta_atributo
              where cliente_id = $4 and cuenta_id = $5 and vigente_hasta = $2::date`,
            [puente.denominacionNueva, HOY, puente.respaldo, fix.clienteId, cuentaPuenteId],
          );
        },
      );
      imprimir(`  Cuenta puente (renombrada): ${puente.codigo} "${puente.denominacionNueva}" (misma cuenta_id: ${cuentaPuenteId})`);
    }

    // 2) Cerrar la regla_imputacion vieja (concepto NULL, cubre créditos y débitos juntos).
    await escribirConAuditoria(
      tx,
      { clienteId: fix.clienteId, accion: 'escritura', recurso: 'regla_imputacion', motivo: `fix-ley-25413: cierre regla general de ${TIPO} (${fix.nombre})` },
      async () => {
        const cerrada = await tx.consultar<{ id: string }>(
          `update regla_imputacion set vigente_hasta = $1::date
            where cliente_id = $2 and tipo_movimiento = $3 and concepto is null and vigente_hasta is null
            returning id::text as id`,
          [HOY, fix.clienteId, TIPO],
        );
        if (cerrada.length !== 1) throw new Error(`Esperaba cerrar exactamente 1 regla general de ${TIPO}, cerré ${cerrada.length}.`);
        imprimir(`  Regla general cerrada: id ${cerrada[0]?.id}`);
      },
    );

    // 3) Alta de la regla de CRÉDITOS -> cuenta puente.
    const altaCreditos = await escribirConAuditoria(
      tx,
      { clienteId: fix.clienteId, accion: 'escritura', recurso: 'regla_imputacion', motivo: `fix-ley-25413: alta regla ${CONCEPTO_CREDITOS} -> cuenta puente (${fix.nombre})` },
      (ctx) =>
        altaReglaImputacion(tx, ctx, {
          clienteId: fix.clienteId,
          tipoMovimiento: TIPO,
          concepto: CONCEPTO_CREDITOS,
          cuentaId: cuentaPuenteId,
          vigenteDesde: HOY,
          respaldo: fix.puente.respaldo,
          decididoPor: ACTOR,
        }),
    );
    imprimir(`  Alta ${CONCEPTO_CREDITOS} -> cuenta puente: regla_imputacion_id ${altaCreditos.reglaImputacionId}`);

    // 4) Alta de la regla de DÉBITOS -> cuenta original del cliente (nunca computable a Ganancias).
    const altaDebitos = await escribirConAuditoria(
      tx,
      { clienteId: fix.clienteId, accion: 'escritura', recurso: 'regla_imputacion', motivo: `fix-ley-25413: alta regla ${CONCEPTO_DEBITOS} -> cuenta original (${fix.nombre})` },
      (ctx) =>
        altaReglaImputacion(tx, ctx, {
          clienteId: fix.clienteId,
          tipoMovimiento: TIPO,
          concepto: CONCEPTO_DEBITOS,
          cuentaId: cuentaDebitos.cuentaId,
          vigenteDesde: HOY,
          respaldo:
            `Restaura el tratamiento original de este cliente para ${CONCEPTO_DEBITOS} (${fix.codigoDebitos} ` +
            `"${cuentaDebitos.denominacion}") — nunca computable a Ganancias bajo ningún %, a diferencia del ` +
            `lado créditos. La regla del 2026-09-04 lo mandaba, por error, junto con los créditos, a Pago a ` +
            `Cuenta Ganancias. Dictamen contador-dominio, sesión 2026-09-18. Autorizado por el titular.`,
          decididoPor: ACTOR,
        }),
    );
    imprimir(`  Alta ${CONCEPTO_DEBITOS} -> cuenta original (${fix.codigoDebitos}): regla_imputacion_id ${altaDebitos.reglaImputacionId}`);
  });
}

async function main(): Promise<void> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    throw new Error('Credencial saltea RLS o es superusuario — este script exige app_request real.');
  }
  if (!credencial.contextoLocalAislado) {
    throw new Error('Contexto no aislado — abortando.');
  }

  for (const fix of FIXES) {
    await aplicarFix(fix);
  }

  imprimir('');
  imprimir('Listo. Ningún asiento ya generado con la regla vieja fue tocado — cambio hacia adelante únicamente.');
  imprimir('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${SALTO}ERROR: ${error instanceof Error ? error.message : String(error)}${SALTO}`);
    process.exit(1);
  })
  .finally(() => cerrarConexiones());
