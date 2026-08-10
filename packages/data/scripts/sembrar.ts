/**
 * Siembra de desarrollo con datos SINTÉTICOS — ADR-0002 §F.1.
 *
 *   pnpm db:seed              un estudio con 3 clientes, semilla 42
 *   pnpm db:seed --clientes 8 --semilla 7
 *
 * NUNCA usa datos reales de un cliente del estudio. Los CUIT y CBU que genera tienen el dígito
 * verificador **inválido a propósito**: un CUIT "válido" generado al azar pertenece a un contribuyente
 * real, y tenerlo en una base de desarrollo es una filtración con pasos extra.
 *
 * La siembra del árbol la hace `conJob` (BYPASSRLS) porque el nodo raíz no lo puede crear el dueño del
 * esquema: `force row level security` le aplica las políticas también a él y no hay ninguna que permita
 * crear un nodo sin padre. El resto de los datos entra con la identidad del socio, por `conUsuario`.
 */

import { Client } from 'pg';
import { entornoActual } from '../src/db/entorno.ts';
import { cargarEnv } from '../../../tools/cargar-env.ts';
import { cerrarConexiones, conJob } from '../src/db/conexion.ts';
import {
  clienteSintetico,
  estudioSintetico,
  movimientosSinteticos,
  verificadorCbuBloque1EsValido,
  verificadorCuitEsValido,
} from '../src/seed/sintetico.ts';

cargarEnv();

function argumento(nombre: string, porDefecto: number): number {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i === -1) return porDefecto;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : porDefecto;
}

const SEMILLA = argumento('semilla', 42);
const CANTIDAD = argumento('clientes', 3);

async function limpiar(): Promise<void> {
  // Con el dueño del esquema y con TRUNCATE: es mantenimiento, no una operación de la aplicación.
  const dsn = process.env['DATABASE_URL'];
  if (!dsn) throw new Error('Falta DATABASE_URL. Ver .env.example.');

  /**
   * DOS GUARDS ANTES DE BORRAR NADA.
   *
   * 1. **Solo en `local`.** Este script trunca doce tablas con el dueño del esquema: es la operación más
   *    destructiva del repo y no tiene por qué existir fuera de una máquina de desarrollo.
   * 2. **Solo si no hay material ingestado.** Un `lote_ingesta` con filas significa que alguien procesó
   *    un extracto real. Sembrar encima lo borra, y con él el rastro de auditoría de esa corrida.
   *
   * El segundo guard es el que importa: el primero se puede satisfacer con una variable de entorno mal
   * puesta, el segundo mira el estado real de la base.
   */
  if (entornoActual() !== 'local') {
    throw new Error(
      `db:seed trunca doce tablas con el dueño del esquema y solo corre con APP_ENTORNO=local ` +
        `(actual: ${entornoActual()}). Sembrar datos sintéticos sobre otro entorno borra lo que haya.`,
    );
  }

  const c = new Client({ connectionString: dsn });
  await c.connect();
  try {
    const { rows } = await c.query<{ n: string }>('select count(*)::text as n from lote_ingesta');
    if (Number(rows[0]?.n ?? '0') > 0) {
      throw new Error(
        'Hay lotes de ingesta cargados: sembrar los borraría junto con su rastro de auditoría, que es ' +
          'append-only y no se puede reponer. Si de verdad querés empezar de cero, recreá la base ' +
          '(drop/create) de forma explícita: pnpm db:migrate && pnpm db:setup.',
      );
    }

    /**
     * ## Por qué este truncate está enumerado y SIN `cascade`
     *
     * La versión anterior era `truncate … tenant_node cascade`, con cinco tablas nombradas. Con las siete
     * tablas del Módulo 1 colgando de `tenant_node`, el `cascade` arrastraba `cuenta_bancaria`,
     * `cuenta_bancaria_identificador`, `lote_ingesta`, `lote_ingesta_cuenta`,
     * `movimiento_bancario_crudo` y `movimiento_origen_crudo` — **ninguna nombrada en el comando**.
     *
     * O sea que `pnpm db:seed`, que está en el runbook de arranque y se corre por reflejo, borraba la
     * cuenta dada de alta, los movimientos ingestados y **el rastro de auditoría append-only**: la única
     * tabla que el sistema declara imborrable, verificada en T13 y en P1-0 donde se demuestra que ni
     * `app_job` puede borrarla. La borraba este script, porque corre con el dueño del esquema, que es el
     * único rol al que nadie le puso ese límite.
     *
     * Y la pérdida no deja hueco: deja vacío. Nadie la nota.
     *
     * Ahora las tablas van **enumeradas y sin `cascade`**, así que una tabla nueva no entra al truncate
     * sola: entra cuando alguien la escribe acá, que es cuando lo decide.
     */
    await c.query(
      // `anexo_extracto` referencia `lote_ingesta` y `lote_ingesta_cuenta`, así que va ANTES de las dos.
      // Nótese que sin `cascade` el olvido es RUIDOSO: un truncate enumerado exige que toda tabla que
      // referencie a las nombradas esté en la lista, así que si alguien agrega una y no la pone acá, el
      // comando falla con un error explícito en vez de dejar filas huérfanas. Es lo que se buscaba.
      'truncate movimiento_origen_crudo, movimiento_bancario_crudo, anexo_extracto, ' +
        'lote_ingesta_cuenta, ' +
        'lote_ingesta, cuenta_bancaria_identificador, cuenta_bancaria, ' +
        'credencial_fiscal_rotacion, credencial_fiscal, acceso_auditoria, membership, tenant_node',
    );
  } finally {
    await c.end();
  }
}

async function principal(): Promise<void> {
  const demo = estudioSintetico(SEMILLA, CANTIDAD);

  // Antes de escribir nada: verificar que lo generado es INCONFUNDIBLEMENTE sintético.
  for (let i = 0; i < CANTIDAD; i += 1) {
    const c = clienteSintetico(SEMILLA, i);
    if (verificadorCuitEsValido(c.cuit)) {
      throw new Error(
        `El generador produjo un CUIT con verificador VÁLIDO (${c.cuit}): puede pertenecer a un ` +
          'contribuyente real. Se aborta la siembra. Ver ADR-0002 §F.1.',
      );
    }
    if (verificadorCbuBloque1EsValido(c.cbu)) {
      throw new Error(`El generador produjo un CBU con verificador válido (${c.cbu}). Se aborta.`);
    }
  }

  await limpiar();

  const socioId = '11111111-1111-1111-1111-111111111111';

  const resumen = await conJob('siembra_sintetica', async (tx) => {
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
    await tx.consultar(
      `insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'socio')`,
      [socioId, estudio],
    );

    const clientes: { id: string; razonSocial: string; cuit: string }[] = [];
    for (const c of demo.clientes) {
      const id = await nodo('cliente', c.razonSocial, estudio);
      clientes.push({ id, razonSocial: c.razonSocial, cuit: c.cuit });
    }
    return { estudio, clientes };
  });

  const movimientos = movimientosSinteticos(SEMILLA, 12);

  process.stdout.write(`\n  Estudio:  ${demo.nombre}\n`);
  process.stdout.write(`  Socio:    ${socioId} (usalo como app.user_id en desarrollo)\n\n`);
  process.stdout.write('  Clientes (CUIT con verificador INVÁLIDO a propósito):\n');
  for (const c of resumen.clientes) {
    process.stdout.write(`    ${c.id}  ${c.cuit}  ${c.razonSocial}\n`);
  }
  process.stdout.write(
    `\n  Movimientos sintéticos disponibles para el Módulo 1: ${movimientos.length} ` +
      '(no se persisten todavía: la tabla es del Módulo 1)\n\n',
  );
  process.stdout.write(`  Poné DEV_USER_ID=${socioId} en tu .env\n\n`);

  await cerrarConexiones();
}

await principal();
