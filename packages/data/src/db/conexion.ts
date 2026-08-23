/**
 * ÚNICO PUNTO DE CONEXIÓN CON CONTEXTO DE TENANT — ADR-0001 §6, ADR-0002 R16/R17/R18/R22.
 *
 * Nada fuera de este archivo crea un `Pool`. Todo acceso a datos entra por `conUsuario()` o, para la
 * whitelist cerrada de ADR-0002 R19, por `conJob()`.
 *
 * Los cuatro agujeros clásicos del patrón RLS + pooling, y cómo se cierran acá:
 *
 *   1. **`SET` de sesión en vez de `SET LOCAL`.** Con pooling en *transaction mode*, un `SET` de
 *      sesión se PEGA a la conexión y el próximo request —de otro estudio— la hereda. Acá se usa
 *      siempre `set_config(..., true)` dentro de una transacción explícita, y nunca se expone una
 *      forma de ejecutar `SET`.
 *   2. **Contexto heredado de un request anterior.** Antes de setear, se verifica que el contexto
 *      venga VACÍO. Si viene con valor, se aborta: es una fuga de sesión, no un detalle (INV-4).
 *   3. **La credencial de jobs en el proceso de requests.** El guard de arranque rechaza arrancar si
 *      el rol conectado tiene `BYPASSRLS` o es superusuario.
 *   4. **"Arreglar" el fallo cerrado.** Sin identidad, la RLS devuelve 0 filas SIN error, y la
 *      reacción natural de quien no entiende es agregar un fallback a la policy o usar el pool de
 *      jobs. Por eso `conUsuario()` **lanza** con un mensaje explícito si no hay identidad válida, en
 *      vez de dejar que el síntoma sea una lista vacía (H-14).
 */

import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { logger } from '@sistema-contable/shared/observabilidad';
import { dsnJob, dsnRequest, entornoActual } from './entorno.ts';

// -----------------------------------------------------------------------------
// Tipos
// -----------------------------------------------------------------------------

/** Lo único que ve el código de negocio. No expone el `PoolClient` crudo ni `release()`. */
export type Tx = {
  readonly consultar: <F extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parametros?: readonly unknown[],
  ) => Promise<F[]>;
  /** Identidad efectiva de esta transacción. `null` cuando corre con la credencial de jobs. */
  readonly usuarioId: string | null;
};

/**
 * Motivos permitidos para usar la credencial que SALTEA RLS (ADR-0002 R19).
 *
 * Es una unión CERRADA a propósito: `conJob('ingesta_bancaria')` **no compila**. La ingesta del
 * Módulo 1 corre con `conUsuario()` (R20), y esta firma es lo que lo hace verificable en el editor y
 * no en una revisión de código.
 */
export type MotivoJob =
  | 'migracion'
  | 'alta_estudio'
  | 'reparentar_nodo'
  | 'mantenimiento'
  | 'export_cliente_archivado'
  | 'siembra_sintetica'
  | 'cargar_cotizaciones'
  | 'auditoria_seguridad_readonly';

/**
 * Forma de un uuid, sin exigir versión ni variante RFC.
 *
 * NO se usa `z.uuid()` a propósito: en Zod 4 valida además los bits de versión y variante, y rechaza
 * identificadores que Postgres acepta sin chistar (pasó con los uuid de los tests). El `user_id` lo
 * emite el proveedor de identidad —que puede usar v4, v7 o un formato propio— y lo que acá importa es
 * la FORMA (que sea un uuid y no una inyección), no su linaje RFC.
 */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esquemaUsuarioId = z.string().regex(RE_UUID, 'no tiene forma de uuid');

// -----------------------------------------------------------------------------
// Pools
// -----------------------------------------------------------------------------

let poolRequest: Pool | null = null;
let poolJob: Pool | null = null;

/** Tamaño chico a propósito: hace que una fuga de contexto entre requests aparezca en los tests. */
const MAX_CONEXIONES = Number(process.env['DB_POOL_MAX'] ?? 10);

function obtenerPoolRequest(): Pool {
  poolRequest ??= new Pool({ connectionString: dsnRequest(), max: MAX_CONEXIONES });
  return poolRequest;
}

function obtenerPoolJob(): Pool {
  poolJob ??= new Pool({ connectionString: dsnJob(), max: 4 });
  return poolJob;
}

export async function cerrarConexiones(): Promise<void> {
  await Promise.all([poolRequest?.end(), poolJob?.end()]);
  poolRequest = null;
  poolJob = null;
  guardVerificado = false;
}

// -----------------------------------------------------------------------------
// Guard de arranque (R18, R22)
// -----------------------------------------------------------------------------

let guardVerificado = false;

export type ResultadoGuard = {
  readonly usuario: string;
  readonly salteaRls: boolean;
  readonly esSuperusuario: boolean;
  readonly contextoLocalAislado: boolean;
};

/**
 * Se corre UNA vez al arrancar el proceso que atiende pedidos, antes de servir el primer request.
 * Si algo no cierra, **lanza**: el proceso no arranca. Un sistema multi-tenant que arranca con la
 * credencial equivocada es peor que uno que no arranca.
 */
export async function verificarCredencialDeRequest(): Promise<ResultadoGuard> {
  const cliente = await obtenerPoolRequest().connect();
  try {
    const { rows } = await cliente.query<{
      usuario: string;
      saltea_rls: boolean;
      es_super: boolean;
    }>(
      `select current_user as usuario,
              coalesce(rolbypassrls, false) as saltea_rls,
              coalesce(rolsuper, false)     as es_super
         from pg_roles where rolname = current_user`,
    );
    const fila = rows[0];
    if (!fila) {
      throw new Error('El guard no pudo leer pg_roles para el rol actual.');
    }

    if (fila.saltea_rls) {
      throw new Error(
        `El proceso de request está conectado como "${fila.usuario}", que tiene BYPASSRLS. ` +
          'Con esa credencial las políticas no se evalúan y NO HAY AISLAMIENTO entre clientes. ' +
          'DATABASE_URL_APP tiene que apuntar al rol app_request. Ver ADR-0002 R18.',
      );
    }
    if (fila.es_super) {
      throw new Error(
        `El proceso de request está conectado como "${fila.usuario}", que es SUPERUSUARIO. ` +
          'Un superusuario ignora RLS siempre, incluso forzada. Ver ADR-0002 §C.0.',
      );
    }

    // R22: que `set_config(..., true)` viva SOLO dentro de la transacción. En un pooler configurado
    // en statement mode esto no se sostiene, y el aislamiento se rompe en silencio.
    await cliente.query('begin');
    await cliente.query(`select set_config('app.user_id', $1, true)`, [
      '00000000-0000-0000-0000-000000000000',
    ]);
    const dentro = await cliente.query<{ v: string }>(
      `select coalesce(current_setting('app.user_id', true), '') as v`,
    );
    await cliente.query('commit');
    const fuera = await cliente.query<{ v: string }>(
      `select coalesce(current_setting('app.user_id', true), '') as v`,
    );

    const contextoLocalAislado =
      dentro.rows[0]?.v === '00000000-0000-0000-0000-000000000000' && fuera.rows[0]?.v === '';

    if (!contextoLocalAislado) {
      throw new Error(
        'El contexto de tenant sobrevivió al fin de la transacción. El pooler no está en ' +
          'transaction mode, o algo usa SET de sesión: el contexto de un request se filtra al ' +
          'siguiente. Ver ADR-0002 R22 e INV-4.',
      );
    }

    guardVerificado = true;
    logger.info('db.guard.ok', {
      usuario: fila.usuario,
      entorno: entornoActual(),
      contexto_local_aislado: contextoLocalAislado,
    });

    return {
      usuario: fila.usuario,
      salteaRls: fila.saltea_rls,
      esSuperusuario: fila.es_super,
      contextoLocalAislado,
    };
  } finally {
    cliente.release();
  }
}

// -----------------------------------------------------------------------------
// conUsuario — el camino normal, sujeto a RLS
// -----------------------------------------------------------------------------

function envolver(cliente: PoolClient, usuarioId: string | null): Tx {
  return {
    usuarioId,
    consultar: async <F extends Record<string, unknown>>(
      sql: string,
      parametros: readonly unknown[] = [],
    ): Promise<F[]> => {
      const r = await cliente.query<F>(sql, parametros as unknown[]);
      return r.rows;
    },
  };
}

/**
 * Abre una transacción con la identidad del usuario y corre `fn` adentro.
 *
 * Todo acceso a datos de un cliente pasa por acá. Si `fn` lanza, se hace ROLLBACK.
 */
export async function conUsuario<T>(usuarioId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const r = esquemaUsuarioId.safeParse(usuarioId);
  if (!r.success) {
    // Lanza en vez de devolver 0 filas: el error #1 esperado es "no veo nada y no sé por qué".
    throw new Error(
      `conUsuario() necesita un usuarioId uuid válido y recibió ${JSON.stringify(usuarioId)}. ` +
        'Sin identidad la RLS devuelve 0 filas sin error, y el "arreglo" natural (un fallback en la ' +
        'policy, o usar el pool de jobs) rompe el aislamiento. Ver ADR-0002 H-14.',
    );
  }

  if (!guardVerificado && entornoActual() !== 'local') {
    throw new Error(
      'conUsuario() se llamó antes de verificarCredencialDeRequest(). El guard de arranque es ' +
        'obligatorio fuera de local: ver ADR-0002 R18.',
    );
  }

  const cliente = await obtenerPoolRequest().connect();
  try {
    await cliente.query('begin');

    // INV-4: si el contexto viene con valor, esta conexión trae contexto de OTRO request.
    const previo = await cliente.query<{ v: string }>(
      `select coalesce(current_setting('app.user_id', true), '') as v`,
    );
    if (previo.rows[0]?.v) {
      await cliente.query('rollback');
      throw new Error(
        'La conexión ya traía un contexto de tenant seteado al abrir la transacción: es una fuga ' +
          'de sesión entre requests. Se aborta. Ver ADR-0002 INV-4.',
      );
    }

    await cliente.query(`select set_config('app.user_id', $1, true)`, [r.data]);

    const resultado = await fn(envolver(cliente, r.data));
    await cliente.query('commit');
    return resultado;
  } catch (error) {
    try {
      await cliente.query('rollback');
    } catch {
      // Si el rollback falla la conexión ya está perdida; el `release` de abajo la descarta.
    }
    throw error;
  } finally {
    cliente.release();
  }
}

// -----------------------------------------------------------------------------
// conJob — la credencial que saltea RLS, acotada
// -----------------------------------------------------------------------------

/**
 * Corre `fn` con la credencial que SALTEA RLS. Solo para los motivos de `MotivoJob` (R19).
 *
 * No hay `'ingesta_bancaria'` en esa unión: la ingesta del Módulo 1 corre con `conUsuario()` y su
 * `clienteId`, y la RLS la re-verifica (R20). Que la firma no lo permita es lo que hace la regla
 * verificable sin depender de que alguien lo recuerde en la revisión.
 */
export async function conJob<T>(motivo: MotivoJob, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const cliente = await obtenerPoolJob().connect();
  try {
    await cliente.query('begin');

    // R42 (ADR-0002 §B): `auditoria_seguridad_readonly` es el único motivo que puede leer dominio de
    // cliente cross-tenant con esta credencial. Dos capas INDEPENDIENTES, no de la misma fuerza:
    // - El grant angosto de `app_job` (`0023`, cero privilegios de escritura hoy) es el que de verdad
    //   no tiene excepción conocida: no importa qué corra `fn`, no hay ningún insert/update/delete que
    //   otorgar sobre esas columnas.
    // - `set transaction read only`, acá abajo, es una capa ADICIONAL: Postgres rechaza con su error
    //   nativo `25006` cualquier DML que llegue mientras la transacción siga en ese modo — pero si `fn`
    //   ejecutara `set transaction read write` como PRIMER statement (antes de cualquier otra query), la
    //   transacción vuelve a modo lectura-escritura y esta capa deja de contener desde ese punto. No es
    //   explotable por un atacante externo (`fn` es código de confianza de este motivo, nunca input de
    //   usuario), pero no hay que prometerle a esta línea más de lo que garantiza: en ese caso límite,
    //   quien contiene es el grant, no la transacción. Va ANTES de cualquier otra query propia de
    //   `conJob`, para que no haya ventana sin esta capa tampoco.
    if (motivo === 'auditoria_seguridad_readonly') {
      await cliente.query('set transaction read only');
    }

    // `motivo_job` y no `motivo`: `motivo` es una columna clasificada N2 (texto libre que puede
    // mencionar al cliente) y el tipo del logger la rechaza. Acá es un código de una unión cerrada.
    // El error de compilación lo encontró el propio tipo — quedó anotado porque el nombre era ambiguo.
    logger.warn('db.job.bypassrls', { motivo_job: motivo, entorno: entornoActual() });
    const resultado = await fn(envolver(cliente, null));
    await cliente.query('commit');
    return resultado;
  } catch (error) {
    try {
      await cliente.query('rollback');
    } catch {
      /* conexión perdida */
    }
    throw error;
  } finally {
    cliente.release();
  }
}
