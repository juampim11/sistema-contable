/**
 * ESCRITURAS de `cuenta`/`cuenta_atributo` (`0027_cierre_mensual.sql`) — primera vez que se llenan.
 * Alta del plan de cuentas de un cliente, DOS pasadas sin orden topológico (D-15/D-25, ratificado por
 * `plan-cuentas-multicliente` en la convocatoria de este adaptador):
 *
 *   1. Un `insert` por nodo en `cuenta` (identidad estable, sin jerarquía) — arma `codigo → cuenta.id`.
 *   2. Un `insert` por nodo en `cuenta_atributo`, resolviendo `cuentaPadreId` directo de ese mapa. El
 *      marcador de raíz (`cuentaPadreCodigo === null`) se trata ANTES del lookup, nunca pasa por el
 *      mapa — es el primer hueco que encontró `plan-cuentas-multicliente` en la convocatoria.
 *
 * Exige `ContextoAuditado` (mismo patrón que `contabilidad/escrituras.ts::altaDeSocio`): el caller
 * (CLI) abre la transacción con `escribirConAuditoria`, nunca esta función.
 */

import { logger } from '@sistema-contable/shared/observabilidad';
import type { RolFuncionalCuenta } from './tipos.ts';
import type { ContextoAuditado } from '../db/auditoria.ts';
import type { Tx } from '../db/conexion.ts';
import { conErroresTraducidos } from '../db/errores-pg.ts';

export type FilaAltaPlanCuentas = {
  readonly codigo: string;
  /** Tal cual el archivo — nunca modificada (R42 de este proyecto: el código es el identificador local, la denominación es presentación). */
  readonly denominacion: string;
  readonly nivel: number;
  /** `null` = raíz. Tiene que ser el `codigo` de OTRA fila de este mismo pedido. */
  readonly cuentaPadreCodigo: string | null;
  readonly rolFuncional: RolFuncionalCuenta;
  /** Obligatorio cuando `rolFuncional` liga a un socio puntual — la migración lo exige por CHECK. */
  readonly padronSocioId: string | null;
  readonly vigenteDesde: string;
  /** Quién autorizó + referencia al archivo/mapeo — nunca genérico para las filas de socio (D-16, convocatoria de este adaptador). */
  readonly respaldo: string;
};

export type PedidoAltaPlanCuentas = {
  readonly clienteId: string;
  readonly filas: readonly FilaAltaPlanCuentas[];
};

export type ResultadoAltaPlanCuentas = {
  readonly cuentasCreadas: number;
  readonly cuentaIdPorCodigo: ReadonlyMap<string, string>;
};

export class ErrorAltaPlanCuentas extends Error {
  readonly codigo: 'padre_no_encontrado_en_el_pedido';
  readonly codigoCuenta: string;
  constructor(codigo: 'padre_no_encontrado_en_el_pedido', codigoCuenta: string) {
    super(`plan-cuentas: ${codigo} (${codigoCuenta})`);
    this.codigo = codigo;
    this.codigoCuenta = codigoCuenta;
  }
}

export async function altaPlanDeCuentas(
  tx: Tx,
  _ctx: ContextoAuditado,
  pedido: PedidoAltaPlanCuentas,
): Promise<ResultadoAltaPlanCuentas> {
  // Pasada 1 — identidad estable, sin jerarquía. Un insert por nodo, en el orden que venga.
  const cuentaIdPorCodigo = new Map<string, string>();
  for (const fila of pedido.filas) {
    const insertado = await conErroresTraducidos(undefined, () =>
      tx.consultar<{ id: string }>(
        `insert into cuenta (cliente_id) values ($1) returning id::text as id`,
        [pedido.clienteId],
      ),
    );
    const id = insertado[0]?.id;
    if (!id) throw new Error(`El alta de cuenta (${fila.codigo}) no devolvió id.`); // H-14
    cuentaIdPorCodigo.set(fila.codigo, id);
  }

  // Pasada 2 — atributos + jerarquía. Ya existen TODOS los cuenta.id, sin importar el orden.
  for (const fila of pedido.filas) {
    const cuentaId = cuentaIdPorCodigo.get(fila.codigo);
    if (!cuentaId) throw new Error(`Falta cuenta.id para ${fila.codigo} — no debería pasar tras la pasada 1.`);

    let cuentaPadreId: string | null = null;
    if (fila.cuentaPadreCodigo !== null) {
      const padreId = cuentaIdPorCodigo.get(fila.cuentaPadreCodigo);
      if (!padreId) throw new ErrorAltaPlanCuentas('padre_no_encontrado_en_el_pedido', fila.codigo);
      cuentaPadreId = padreId;
    }

    await conErroresTraducidos(undefined, () =>
      tx.consultar(
        `insert into cuenta_atributo
           (cliente_id, cuenta_id, codigo, denominacion, nivel, cuenta_padre_id, rol_funcional,
            padron_socio_id, vigente_desde, respaldo)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10)`,
        [
          pedido.clienteId,
          cuentaId,
          fila.codigo,
          fila.denominacion,
          fila.nivel,
          cuentaPadreId,
          fila.rolFuncional,
          fila.padronSocioId,
          fila.vigenteDesde,
          fila.respaldo,
        ],
      ),
    );
  }

  logger.info('plan_cuentas.alta', { cliente_id: pedido.clienteId, cuentas: pedido.filas.length });

  return { cuentasCreadas: pedido.filas.length, cuentaIdPorCodigo };
}
