/**
 * Utilidades compartidas por los tests de base: conexión como dueño del esquema y siembra sintética.
 *
 * La siembra usa `conJob` (BYPASSRLS) por consistencia con el camino de producción de un job.
 *
 * ⚠️ **CORREGIDO en `0021`.** Este docblock decía que el nodo raíz «NO lo puede crear el dueño del
 * esquema porque `force row level security` le aplica las políticas también a él». **Es falso, y se
 * midió:** `sistema_contable` es `rolsuper = true` —y por lo tanto `rolbypassrls`— en los dos
 * entornos (premisa **P-1**, declarada en `docs/diseno/11-migracion-0021-...md` §0), así que el
 * insert del nodo raíz le funciona sin GUC ninguno. `force row level security` fuerza las policies
 * al dueño de la TABLA, pero **no** al superusuario.
 *
 * 🔴 Importa más de lo que parece, y por eso se corrige en vez de borrarse: la conclusión de abajo
 * —que `clienteDuenio()` sirve para medir MECANISMO— sigue en pie, pero por otra razón. Y de la
 * premisa falsa se sigue una trampa: **cualquier test que intente medir una POLICY a través de
 * `clienteDuenio()` va a pasar EN VACÍO**, porque el superusuario nunca las evalúa. Es la misma
 * forma de R7, que `security-engineer` ya midió como vacua bajo P-1.
 */

import { Client } from 'pg';
import { conJob } from '../src/db/conexion.ts';
import { entornoActual } from '../src/db/entorno.ts';
import { estudioSintetico } from '../src/seed/sintetico.ts';

export const USUARIOS = {
  socio: '11111111-1111-1111-1111-111111111111',
  contadorA: '22222222-2222-2222-2222-222222222222',
  contadorB: '33333333-3333-3333-3333-333333333333',
  socioOtroEstudio: '44444444-4444-4444-4444-444444444444',
  administrativoA: '55555555-5555-5555-5555-555555555555',
  auditorA: '66666666-6666-6666-6666-666666666666',
} as const;

export type Sembrado = {
  estudio: string;
  clienteA: string;
  clienteB: string;
  estudio2: string;
  clienteC: string;
};

/**
 * Conexión con **`app_job`** (BYPASSRLS), para los tests que tienen que medir un INVARIANTE y no un
 * privilegio.
 *
 * Existe por una razón concreta, de `0017`: un ataque probado sólo con `app_request` muere por
 * `permission denied` antes de llegar al invariante, así que ese test **se pone verde el día que
 * alguien re-otorgue un grant de tabla entera** copiando la plantilla de ADR-0001 §5 — que es el
 * escenario de regresión realista. Para saber si el invariante existe hay que atacarlo con el
 * escritor más privilegiado que no sea el dueño.
 */
export async function clienteJob(): Promise<Client> {
  const dsn = process.env['DATABASE_URL_JOB'];
  if (!dsn) {
    throw new Error(
      'Falta DATABASE_URL_JOB. Sin app_job no se puede distinguir "el invariante se cumple" de\n' +
        '"a este rol le falta un grant", que es justo lo que 0017 vino a separar.',
    );
  }
  const c = new Client({ connectionString: dsn });
  await c.connect();
  await exigirRol(c, 'app_job', 'DATABASE_URL_JOB');
  return c;
}

/**
 * Un DSN mal apuntado convierte "esto lo mide `app_job`" en "esto lo mide el dueño" **sin que nada se
 * ponga rojo**: los dos casos de INVARIANTE de `path-coherente.test.ts` pasan igual con el dueño,
 * porque lo que los frena es el CHECK y no un privilegio. MEDIDO: con `DATABASE_URL_JOB` apuntando al
 * dueño, 13 de 14 casos quedan verdes. Sin este control, la mitad "y no es el dueño" no la verifica
 * nada.
 */
async function exigirRol(c: Client, esperado: string, variable: string): Promise<void> {
  const r = await c.query<{ u: string }>('select current_user as u');
  const actual = r.rows[0]?.u;
  if (actual !== esperado) {
    await c.end();
    throw new Error(
      `${variable} conecta como "${actual}" y tiene que conectar como "${esperado}". ` +
        'Un test que dice medir un rol y mide otro no mide nada.',
    );
  }
}

/** Conexión con el dueño del esquema, para leer el catálogo y hacer DDL en los tests. */
export async function clienteDuenio(): Promise<Client> {
  const dsn = process.env['DATABASE_URL'];
  if (!dsn) {
    throw new Error(
      'Falta DATABASE_URL. Los tests de base necesitan Postgres corriendo:\n' +
        '  pnpm db:up && pnpm db:migrate && pnpm db:setup',
    );
  }
  const c = new Client({ connectionString: dsn });
  try {
    await c.connect();
  } catch (error) {
    throw new Error(
      'No se pudo conectar a Postgres. Levantá la infraestructura local:\n' +
        '  pnpm db:up && pnpm db:migrate && pnpm db:setup\n' +
        `Detalle: ${(error as Error).message}`,
    );
  }
  const r = await c.query<{ u: string }>('select current_user as u');
  if (r.rows[0]?.u === 'app_job' || r.rows[0]?.u === 'app_request') {
    const u = r.rows[0]?.u;
    await c.end();
    throw new Error(
      `DATABASE_URL conecta como "${u}", no como el dueño del esquema. Los tests que miden ` +
        'MECANISMO (lo que ni el dueño puede saltear) medirían un privilegio y saldrían verdes.',
    );
  }
  return c;
}

/**
 * Siembra un estudio con dos clientes y otro estudio ajeno, con membresías por rol.
 * Idempotente: borra y vuelve a sembrar. Devuelve los uuid de los nodos.
 */
export async function sembrar(): Promise<Sembrado> {
  /**
   * **GUARD: la siembra de tests solo corre en `local`.**
   *
   * Esta función hace `truncate … tenant_node`, así que borra **todo**: los nodos, las cuentas, los
   * movimientos y el rastro de auditoría append-only. Contra una base con material real de un cliente eso es
   * una pérdida irreparable — y `pnpm test` se corre veinte veces por día, sin pensarlo.
   *
   * Por eso el piloto tiene su **propia base** (`APP_ENTORNO=piloto`), y este guard es la red que impide que
   * los dos se cruzen por un `.env` mal apuntado. Es el mismo razonamiento que el guard de `sembrar.ts`, y
   * acá importa más porque la frecuencia es otra.
   */
  if (entornoActual() !== 'local') {
    throw new Error(
      `La siembra de tests trunca tenant_node y todo lo que cuelga, y APP_ENTORNO es ` +
        `"${entornoActual()}". Los tests corren SOLO contra la base local con datos sintéticos. Si estás ` +
        'apuntando a la base del piloto, revisá DATABASE_URL y APP_ENTORNO.',
    );
  }

  const demo = estudioSintetico(42, 2);

  // La limpieza se hace con el DUEÑO DEL ESQUEMA y con TRUNCATE, no con `delete` desde conJob.
  // Salió de correrlo: `app_job` no tiene ningún privilegio sobre las tablas de credenciales (es a
  // propósito — un job no tiene nada que hacer con una credencial fiscal), así que el `delete` fallaba
  // con "permission denied". Limpiar es una operación de mantenimiento del dueño, no de la aplicación.
  // TRUNCATE, además, es un privilegio de tabla y no pasa por las políticas de fila.
  const duenio = await clienteDuenio();
  try {
    await duenio.query(
      // Las tablas del Módulo 1 van primero por dependencia, aunque `cascade` las alcanzaría igual:
      // nombrarlas hace que agregar una tabla nueva y olvidarla se note al fallar el truncate, no dos
      // suites después con filas de una corrida anterior.
      // Las del Módulo 2 (0013/0014) van primero que las del Módulo 1: `reconocimiento_candidato`
      // cuelga de `reconocimiento_movimiento`, que cuelga de `movimiento_bancario_crudo` con
      // `on delete restrict`. Nombrarlas no es redundante con `cascade` — es lo que hace que
      // agregar una tabla nueva y olvidarla se note acá y no dos suites después.
      // Las de `0021` van primero que `reconocimiento_movimiento`, que es de quien cuelgan con
      // `on delete restrict`. El `cascade` del final las alcanzaría igual —así que esto NO es un
      // arreglo de un fallo—, pero nombrarlas es lo único que hace que la próxima tabla del Módulo 2
      // se note acá. Es literal la lección que este bloque ya documenta para `membership_historia`:
      // `0019` la agregó y esta lista no se enteró.
      'truncate reconocimiento_contrapartida_match, reconocimiento_contrapartida, ' +
        'padron_manifestacion, reconocimiento_candidato, reconocimiento_movimiento, ' +
        'movimiento_contraparte_identificador, padron_socio_documento, padron_socio, ' +
        'movimiento_origen_crudo, movimiento_bancario_crudo, lote_ingesta_cuenta, ' +
        'lote_ingesta, cuenta_bancaria_identificador, cuenta_bancaria, banco, ' +
        'credencial_fiscal_rotacion, credencial_fiscal, acceso_auditoria, ' +
        // `membership_historia` antes que `membership`: el `cascade` la alcanzaría igual por la FK a
        // `tenant_node`, pero nombrarla es lo que hace que la próxima tabla del plano de tenancía se
        // note acá. 0019 la agregó y esta lista no se enteró — que es la misma falla que tenía R1 de
        // `catalogo.test.ts`, y por el mismo motivo: una lista escrita a mano.
        'membership_historia, membership, ' +
        'tenant_node cascade',
    );
  } finally {
    await duenio.end();
  }

  return conJob('siembra_sintetica', async (tx) => {
    const nodo = async (tipo: string, nombre: string, padre: string | null): Promise<string> => {
      const filas = await tx.consultar<{ id: string }>(
        `insert into tenant_node (tipo, nombre, parent_id)
         values ($1::app.tipo_tenant, $2, $3) returning id::text as id`,
        [tipo, nombre, padre],
      );
      const id = filas[0]?.id;
      if (!id) throw new Error(`No se pudo crear el nodo ${nombre}`);
      return id;
    };

    const estudio = await nodo('estudio', demo.nombre, null);
    const clienteA = await nodo('cliente', demo.clientes[0]?.razonSocial ?? 'CLIENTE A', estudio);
    const clienteB = await nodo('cliente', demo.clientes[1]?.razonSocial ?? 'CLIENTE B', estudio);
    const estudio2 = await nodo('estudio', 'ESTUDIO AJENO 99', null);
    const clienteC = await nodo('cliente', 'CLIENTE AJENO 99 SA', estudio2);

    const membresia = async (userId: string, nodoId: string, rol: string): Promise<void> => {
      await tx.consultar(
        `insert into membership (user_id, tenant_node_id, rol)
         values ($1, $2, $3::app.rol_membership)`,
        [userId, nodoId, rol],
      );
    };

    await membresia(USUARIOS.socio, estudio, 'socio');
    await membresia(USUARIOS.contadorA, clienteA, 'contador');
    await membresia(USUARIOS.contadorB, clienteB, 'contador');
    await membresia(USUARIOS.socioOtroEstudio, estudio2, 'socio');
    await membresia(USUARIOS.administrativoA, clienteA, 'administrativo');
    await membresia(USUARIOS.auditorA, clienteA, 'auditor');

    return { estudio, clienteA, clienteB, estudio2, clienteC };
  });
}
