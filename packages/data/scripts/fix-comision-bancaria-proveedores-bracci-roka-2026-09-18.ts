/**
 * FIX PUNTUAL, HACIA ADELANTE — comisión bancaria → Proveedores, Bracci y ROKA (2026-09-18).
 *
 * Laura confirmó, sin ambigüedad: "todo el IVA compras va contra proveedores" — decisión general del
 * estudio, no condicional por concepto. La `regla_imputacion` general de `comision_bancaria` (alta
 * previa, `concepto: null`, mismo mecanismo que este script reusa) manda hoy cada comisión bancaria
 * nueva a la cuenta de gasto directo (4.2.5.200 "Gastos y comisiones bancarias") — hallazgo #1 del
 * feedback de Laura/Ana sobre el cierre de mayo-agosto 2026. Se cierra esa vigencia y se da de alta
 * la regla nueva, mismo tipo entero (sin `--concepto`, mismo criterio que la regla vieja), apuntando
 * a 2.1.1.100 "Proveedores" en cada cliente.
 *
 * Hacia ADELANTE únicamente: ningún asiento ya generado con la regla vieja se toca.
 *
 * Corre UNA vez contra el piloto real:
 *
 *     ENV_FILE=.env.piloto node packages/data/scripts/fix-comision-bancaria-proveedores-bracci-roka-2026-09-18.ts
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

const ACTOR = '11111111-1111-1111-1111-111111111111'; // socio, membership vigente en ESTUDIO PILOTO.
const HOY = '2026-09-18';
const TIPO = 'comision_bancaria';
const CODIGO_PROVEEDORES = '2.1.1.100';

const RESPALDO =
  'Laura confirmó (feedback sobre el cierre de mayo-agosto 2026): "todo el IVA compras va contra ' +
  'proveedores" — decisión general del estudio, no condicional por concepto. Cierra la regla anterior ' +
  '(comision_bancaria -> 4.2.5.200 Gastos y comisiones bancarias, gasto directo) y la reemplaza por ' +
  'esta, contra 2.1.1.100 Proveedores. Hacia adelante: ningún asiento ya generado se toca.';

const CLIENTES = [
  { clienteId: 'f84d9ecc-6d54-4009-8fb6-b6fa3f8d8579', nombre: 'Bracci (CLIENTE PILOTO 01)' },
  { clienteId: '69479b8f-9b6a-4d6b-bdb2-bff817c2e750', nombre: 'ROKA (CLIENTE PILOTO 03)' },
] as const;

function porCodigo(plan: readonly FilaDelPlanDeCuentas[], codigo: string): FilaDelPlanDeCuentas {
  const candidatas = plan.filter((c) => c.codigo === codigo && c.activa && c.vigenteHasta === null);
  if (candidatas.length !== 1) {
    throw new Error(`Esperaba exactamente 1 cuenta activa y vigente con código "${codigo}", encontré ${candidatas.length}.`);
  }
  return candidatas[0] as FilaDelPlanDeCuentas;
}

async function aplicarFix(cliente: (typeof CLIENTES)[number]): Promise<void> {
  imprimir(`Cliente: ${cliente.nombre}`);

  await conUsuario(ACTOR, async (tx) => {
    const plan = await leerPlanDeCuentasCompleto(tx, { clienteId: cliente.clienteId });
    const proveedores = porCodigo(plan, CODIGO_PROVEEDORES);
    imprimir(`  Cuenta Proveedores: ${proveedores.codigo} "${proveedores.denominacion}" (${proveedores.cuentaId})`);

    // 1) Cerrar la regla general vieja (concepto NULL, apunta a 4.2.5.200 Gastos y comisiones bancarias).
    await escribirConAuditoria(
      tx,
      { clienteId: cliente.clienteId, accion: 'escritura', recurso: 'regla_imputacion', motivo: `fix-comision-bancaria-proveedores: cierre regla general de ${TIPO} (${cliente.nombre})` },
      async () => {
        const cerrada = await tx.consultar<{ id: string }>(
          `update regla_imputacion set vigente_hasta = $1::date
            where cliente_id = $2 and tipo_movimiento = $3 and concepto is null and vigente_hasta is null
            returning id::text as id`,
          [HOY, cliente.clienteId, TIPO],
        );
        if (cerrada.length !== 1) throw new Error(`Esperaba cerrar exactamente 1 regla general de ${TIPO}, cerré ${cerrada.length}.`);
        imprimir(`  Regla vieja cerrada: id ${cerrada[0]?.id}`);
      },
    );

    // 2) Alta de la regla nueva -> Proveedores.
    const alta = await escribirConAuditoria(
      tx,
      { clienteId: cliente.clienteId, accion: 'escritura', recurso: 'regla_imputacion', motivo: `fix-comision-bancaria-proveedores: alta regla ${TIPO} -> Proveedores (${cliente.nombre})` },
      (ctx) =>
        altaReglaImputacion(tx, ctx, {
          clienteId: cliente.clienteId,
          tipoMovimiento: TIPO,
          concepto: null,
          cuentaId: proveedores.cuentaId,
          vigenteDesde: HOY,
          respaldo: RESPALDO,
          decididoPor: ACTOR,
        }),
    );
    imprimir(`  Alta ${TIPO} -> Proveedores: regla_imputacion_id ${alta.reglaImputacionId}`);
  });

  imprimir('');
}

async function main(): Promise<void> {
  const credencial = await verificarCredencialDeRequest();
  if (credencial.salteaRls || credencial.esSuperusuario) {
    throw new Error('Credencial saltea RLS o es superusuario — este script exige app_request real.');
  }
  if (!credencial.contextoLocalAislado) {
    throw new Error('Contexto no aislado — abortando.');
  }

  for (const cliente of CLIENTES) {
    await aplicarFix(cliente);
  }

  imprimir('Listo. Ningún asiento ya generado con la regla vieja fue tocado — cambio hacia adelante únicamente.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${String(error instanceof Error ? error.stack ?? error.message : error)}${SALTO}`);
    process.exit(1);
  })
  .finally(() => cerrarConexiones());
