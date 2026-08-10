/**
 * Usuarios de login de ESTE entorno, para los roles que crean las migraciones.
 *
 * Los roles (`app_request`, `app_job`, `app_firmador`) nacen SIN CONTRASEÑA en las migraciones: un
 * secreto nunca va a un archivo versionado. Este script les asigna la de este entorno, tomada del
 * ambiente (o del `.env` local).
 *
 *   pnpm db:setup
 *
 * EN UN ENTORNO REAL ESTO NO SE CORRE ASÍ: las contraseñas las emite el almacén de secretos del
 * proveedor y se rotan desde ahí (ADR-0002 §E). Este script existe para que `local` funcione sin
 * inventar tooling. Es idempotente: se puede volver a correr para rotar la contraseña local.
 *
 * Termina verificando lo único que importa: que el rol de request NO saltee RLS.
 */

import { Client } from 'pg';
import { cargarEnv } from '../../../tools/cargar-env.ts';

cargarEnv();

function requerido(nombre: string): string {
  const v = process.env[nombre];
  if (!v) throw new Error(`Falta ${nombre}. Ver .env.example.`);
  return v;
}

async function principal(): Promise<void> {
  const dsn = requerido('DATABASE_URL'); // dueño del esquema
  const usuarioApp = requerido('APP_DB_USER');
  const passApp = requerido('APP_DB_PASSWORD');
  const passJob = requerido('JOB_DB_PASSWORD');

  const cliente = new Client({ connectionString: dsn });
  await cliente.connect();

  try {
    // Un bloque `DO` de plpgsql NO acepta parámetros ($1). Se usa el servidor para ARMAR el comando
    // con format() —que cita identificadores y literales correctamente— y después se ejecuta el
    // texto resultante. Así ni el nombre del rol ni la contraseña se interpolan a mano en el cliente.
    const armar = async (plantilla: string, args: readonly unknown[]): Promise<string> => {
      const { rows } = await cliente.query<{ sql: string }>(
        `select format(${plantilla}) as sql`,
        args as unknown[],
      );
      const sql = rows[0]?.sql;
      if (!sql) throw new Error(`No se pudo armar el comando: ${plantilla}`);
      return sql;
    };

    const { rows: existe } = await cliente.query<{ existe: boolean }>(
      'select exists (select 1 from pg_roles where rolname = $1) as existe',
      [usuarioApp],
    );
    if (!existe[0]?.existe) {
      await cliente.query(await armar(`'create role %I login', $1::text`, [usuarioApp]));
    }

    await cliente.query(
      await armar(`'alter role %I password %L', $1::text, $2::text`, [usuarioApp, passApp]),
    );
    // Miembro de app_request: hereda PRIVILEGIOS. No hereda ATRIBUTOS, así que no tiene BYPASSRLS —
    // que es exactamente lo que queremos: las políticas se le aplican.
    await cliente.query(await armar(`'grant app_request to %I', $1::text`, [usuarioApp]));

    // app_job es EL rol que se conecta: los atributos de rol (LOGIN, BYPASSRLS) no se heredan por
    // pertenencia, así que un usuario "miembro de app_job" no tendría el bypass.
    await cliente.query(await armar(`'alter role app_job password %L', $1::text`, [passJob]));

    const { rows } = await cliente.query<{
      rolname: string;
      puede_conectarse: boolean;
      saltea_rls: boolean;
    }>(
      `select rolname, rolcanlogin as puede_conectarse, rolbypassrls as saltea_rls
         from pg_roles
        where rolname in ('app_request', 'app_job', 'app_firmador', $1)
        order by rolname`,
      [usuarioApp],
    );

    process.stdout.write('\n  rol                   login   saltea_rls\n');
    for (const f of rows) {
      process.stdout.write(
        `  ${f.rolname.padEnd(22)}${String(f.puede_conectarse).padEnd(8)}${f.saltea_rls}\n`,
      );
    }

    const request = rows.find((f) => f.rolname === usuarioApp);
    if (!request) throw new Error(`No se encontró el rol ${usuarioApp} después de crearlo.`);
    if (request.saltea_rls) {
      throw new Error(
        `${usuarioApp} tiene BYPASSRLS: con esa credencial no hay aislamiento entre clientes.`,
      );
    }

    process.stdout.write(
      '\n  OK: el rol de request no saltea RLS. Solo app_job puede tener saltea_rls = true.\n',
    );
  } finally {
    await cliente.end();
  }
}

await principal();
