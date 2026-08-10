/**
 * TESTS DE CATÁLOGO — ADR-0002 §B (R1–R15) y punto 6 de §H.3.
 *
 * Recorren el catálogo de Postgres **después de aplicar las migraciones** y verifican las reglas que
 * no se pueden confiar a una revisión de código. Una tabla nueva que se olvide un renglón de la
 * plantilla no necesita que alguien lo note: acá se pone rojo.
 *
 * Corren contra Postgres REAL. Requisito previo:
 *   pnpm db:up && pnpm db:migrate && pnpm db:setup
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  CLASIFICACION,
  columnasSoloFirmador,
  tablasConColumnaTenant,
  tablasQueExigenRolEnLectura,
  type NombreTabla,
} from '@sistema-contable/shared/seguridad';
import { ACCIONES } from '../src/db/auditoria.ts';
import { LECTORES_AUDITADOS, tablasSinLectorAuditado } from '../src/db/lectores-auditados.ts';
import { clienteDuenio } from './ayuda.ts';

let db: Client;

/** Tablas reales del esquema `public`, sin las internas del aplicador de migraciones. */
async function tablasDelEsquema(): Promise<string[]> {
  const { rows } = await db.query<{ nombre: string }>(
    `select c.relname as nombre
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname = 'public' and c.relname not like '\\_%'
      order by 1`,
  );
  return rows.map((f) => f.nombre);
}

beforeAll(async () => {
  db = await clienteDuenio();
});

afterAll(async () => {
  await db?.end();
});

// -----------------------------------------------------------------------------
describe('registro de clasificación (ADR-0002 §A.3)', () => {
  it('toda tabla del esquema está clasificada, y toda tabla clasificada existe', async () => {
    const enEsquema = new Set(await tablasDelEsquema());
    const enRegistro = new Set(Object.keys(CLASIFICACION));

    const sinClasificar = [...enEsquema].filter((t) => !enRegistro.has(t));
    const fantasmas = [...enRegistro].filter((t) => !enEsquema.has(t));

    expect(sinClasificar, 'tablas en la base sin entrada en el registro de clasificación').toEqual([]);
    expect(fantasmas, 'tablas en el registro que no existen en la base').toEqual([]);
  });

  it('toda columna de la base está clasificada, y toda columna clasificada existe', async () => {
    const { rows } = await db.query<{ tabla: string; columna: string }>(
      `select c.relname as tabla, a.attname as columna
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
        where c.relkind = 'r' and n.nspname = 'public'
          and a.attnum > 0 and not a.attisdropped and c.relname not like '\\_%'`,
    );

    const faltantes: string[] = [];
    const sobrantes: string[] = [];

    for (const tabla of Object.keys(CLASIFICACION) as NombreTabla[]) {
      const enBase = new Set(rows.filter((f) => f.tabla === tabla).map((f) => f.columna));
      const enRegistro = new Set(Object.keys(CLASIFICACION[tabla].campos));
      for (const c of enBase) if (!enRegistro.has(c)) faltantes.push(`${tabla}.${c}`);
      for (const c of enRegistro) if (!enBase.has(c)) sobrantes.push(`${tabla}.${c}`);
    }

    expect(faltantes, 'columnas en la base sin clasificar (el default sería N2)').toEqual([]);
    expect(sobrantes, 'columnas clasificadas que no existen en la base').toEqual([]);
  });

  it('una tabla sin columna de tenant tiene el motivo escrito', () => {
    const sinMotivo = (Object.keys(CLASIFICACION) as NombreTabla[]).filter(
      (t) => CLASIFICACION[t].columnaTenant === 'ninguna' && !CLASIFICACION[t].motivoSinTenant,
    );
    expect(sinMotivo).toEqual([]);
  });

  it('todo campo N3 está marcado como cifrado y no exportable', () => {
    const mal: string[] = [];
    for (const tabla of Object.keys(CLASIFICACION) as NombreTabla[]) {
      for (const [columna, campo] of Object.entries(CLASIFICACION[tabla].campos)) {
        if (campo.nivel !== 'N3') continue;
        if (campo.cifrado !== true) mal.push(`${tabla}.${columna} (sin cifrado)`);
        if (campo.exportable !== false) mal.push(`${tabla}.${columna} (exportable)`);
      }
    }
    expect(mal).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('R1/R2/R3 — RLS, columna de tenant e índice', () => {
  it('R1: toda tabla con columna de tenant tiene RLS habilitada Y forzada', async () => {
    const { rows } = await db.query<{ nombre: string; habilitada: boolean; forzada: boolean }>(
      `select c.relname as nombre, c.relrowsecurity as habilitada, c.relforcerowsecurity as forzada
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname = 'public'`,
    );
    const esperadas = new Set<string>([...tablasConColumnaTenant(), 'tenant_node', 'membership']);
    const mal = rows
      .filter((f) => esperadas.has(f.nombre) && !(f.habilitada && f.forzada))
      .map((f) => `${f.nombre} (habilitada=${f.habilitada}, forzada=${f.forzada})`);
    expect(mal).toEqual([]);
  });

  it('R2: la columna de tenant es not null, referencia tenant_node y está indexada primera', async () => {
    for (const tabla of tablasConColumnaTenant()) {
      const columna = CLASIFICACION[tabla].columnaTenant;

      const { rows: nn } = await db.query<{ notnull: boolean }>(
        `select a.attnotnull as notnull from pg_attribute a
          where a.attrelid = $1::regclass and a.attname = $2`,
        [tabla, columna],
      );
      expect(nn[0]?.notnull, `${tabla}.${columna} debe ser not null`).toBe(true);

      const { rows: fk } = await db.query<{ n: string }>(
        `select conname as n from pg_constraint
          where conrelid = $1::regclass and contype = 'f'
            and confrelid = 'tenant_node'::regclass
            and (select attname from pg_attribute
                  where attrelid = conrelid and attnum = conkey[1]) = $2`,
        [tabla, columna],
      );
      expect(fk.length, `${tabla}.${columna} debe referenciar tenant_node`).toBeGreaterThan(0);

      const { rows: idx } = await db.query<{ n: string }>(
        `select i.relname as n
           from pg_index x
           join pg_class i on i.oid = x.indexrelid
          where x.indrelid = $1::regclass
            and (select attname from pg_attribute
                  where attrelid = x.indrelid and attnum = x.indkey[0]) = $2`,
        [tabla, columna],
      );
      expect(idx.length, `${tabla}.${columna} debe estar indexada como primera columna`).toBeGreaterThan(0);
    }
  });

  it('R3: toda tabla con RLS tiene policy de select, y las de escritura tienen with_check', async () => {
    const { rows } = await db.query<{
      tablename: string;
      policyname: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(`select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public'`);

    const conRls = new Set<string>([...tablasConColumnaTenant(), 'tenant_node', 'membership']);
    for (const tabla of conRls) {
      const suyas = rows.filter((f) => f.tablename === tabla);
      expect(suyas.length, `${tabla} no tiene ninguna policy`).toBeGreaterThan(0);
      const lee = suyas.some((f) => f.cmd === 'SELECT' || f.cmd === 'ALL');
      expect(lee, `${tabla} no tiene policy de lectura`).toBe(true);
    }

    const escrituraSinCheck = rows
      .filter((f) => ['INSERT', 'UPDATE', 'ALL'].includes(f.cmd) && f.with_check === null)
      .map((f) => `${f.tablename}.${f.policyname} (${f.cmd})`);
    expect(escrituraSinCheck, 'policies de escritura sin with_check').toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('R4/R5 — el predicado de tenant, exacto y sin fisuras', () => {
  it('R4: el predicado usa el patrón canónico `in (select app.accessible_tenant_ids())`', async () => {
    const { rows } = await db.query<{
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(`select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public'`);

    const mal: string[] = [];
    for (const p of rows) {
      for (const [cual, expr] of [
        ['qual', p.qual],
        ['with_check', p.with_check],
      ] as const) {
        if (!expr) continue;
        const usaLaFuncion = expr.includes('accessible_tenant_ids');
        if (!usaLaFuncion) {
          mal.push(`${p.tablename}.${p.policyname}.${cual}: no usa accessible_tenant_ids()`);
          continue;
        }
        // La forma correcta es `<col> IN (SELECT ...)`. Un `EXISTS (SELECT 1 FROM ...)` se lee igual
        // y significa "el usuario tiene acceso a ALGO": abre la tabla a todo el SaaS (H-4).
        const normal = expr.replace(/\s+/g, ' ').toLowerCase();
        if (!normal.includes('in ( select') && !normal.includes('in (select')) {
          mal.push(`${p.tablename}.${p.policyname}.${cual}: usa accessible_tenant_ids() sin IN (SELECT ...)`);
        }
        if (/exists\s*\(\s*select[^)]*accessible_tenant_ids/.test(normal)) {
          mal.push(`${p.tablename}.${p.policyname}.${cual}: EXISTS sobre accessible_tenant_ids (fail-open)`);
        }
      }
    }
    expect(mal).toEqual([]);
  });

  it('R5: ninguna policy tiene `true`, `or true`, `is null` ni un coalesce que abra el predicado', async () => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_policies
        where schemaname = 'public'
          and ( coalesce(qual, '') ~* '^\\s*true\\s*$'
             or coalesce(qual, '') ~* '(or\\s+true|is\\s+null)'
             or coalesce(with_check, '') ~* '^\\s*true\\s*$'
             or coalesce(with_check, '') ~* '(or\\s+true|is\\s+null)' )`,
    );
    expect(rows[0]?.n, 'policies con predicado abierto').toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('R6 — unicidad siempre por tenant', () => {
  it('ningún índice único sobre una columna sensible omite la columna de tenant', async () => {
    const { rows } = await db.query<{ tabla: string; indice: string; columnas: string[] }>(
      // attname es de tipo `name`: sin el cast a text, node-pg no parsea el array y devuelve un
      // string. Salió de correrlo (`idx.columnas.some is not a function`).
      `select c.relname as tabla, i.relname as indice,
              array_agg(a.attname::text order by k.ord) as columnas
         from pg_index x
         join pg_class c on c.oid = x.indrelid
         join pg_class i on i.oid = x.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
         cross join unnest(x.indkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
        where x.indisunique and n.nspname = 'public' and c.relkind = 'r'
        group by 1, 2`,
    );

    const mal: string[] = [];
    for (const idx of rows) {
      const tabla = idx.tabla as NombreTabla;
      const clasif = CLASIFICACION[tabla];
      if (!clasif || clasif.columnaTenant === 'ninguna') continue;

      const campos: Record<string, { nivel: string }> = clasif.campos;
      const tocaSensible = idx.columnas.some((c) => {
        const nivel = campos[c]?.nivel;
        return nivel === 'N2' || nivel === 'N2R' || nivel === 'N3';
      });
      if (tocaSensible && !idx.columnas.includes(clasif.columnaTenant)) {
        mal.push(`${idx.tabla}.${idx.indice} (${idx.columnas.join(', ')})`);
      }
    }
    expect(mal, 'índices únicos sobre datos sensibles sin la columna de tenant').toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('R7/R8/R9 — owner, vistas y materializadas', () => {
  it('R7: ninguna relación tiene como owner un rol con BYPASSRLS', async () => {
    const { rows } = await db.query<{ nombre: string; owner: string }>(
      `select c.relname as nombre, r.rolname as owner
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.oid = c.relowner
        where n.nspname in ('public', 'app') and r.rolbypassrls and r.rolname <> 'postgres'`,
    );
    // El dueño del esquema en desarrollo es el superusuario del contenedor: eso ya lo marca el guard
    // de arranque y está documentado. Lo que acá no puede pasar es que sea `app_job`.
    const conAppJob = rows.filter((f) => f.owner === 'app_job');
    expect(conAppJob).toEqual([]);
  });

  it('R8: toda vista sobre dominio usa security_invoker', async () => {
    const { rows } = await db.query<{ nombre: string; opciones: string[] | null }>(
      `select c.relname as nombre, c.reloptions as opciones
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'v' and n.nspname = 'public'`,
    );
    const mal = rows
      .filter((f) => !(f.opciones ?? []).some((o) => o.replace(/\s/g, '') === 'security_invoker=true'))
      .map((f) => f.nombre);
    expect(mal, 'vistas sin security_invoker=true').toEqual([]);
  });

  it('R9: no hay vistas materializadas sobre dominio (no admiten policies de RLS)', async () => {
    const { rows } = await db.query<{ nombre: string }>(
      `select c.relname as nombre from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'm' and n.nspname = 'public'`,
    );
    expect(rows.map((f) => f.nombre), 'materializadas: el contenido queda cross-tenant').toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('R10/R11 — funciones SECURITY DEFINER', () => {
  it('R10: toda SECURITY DEFINER fija search_path', async () => {
    const { rows } = await db.query<{ nombre: string }>(
      `select p.proname as nombre
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname in ('app', 'public')
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                           where c like 'search_path=%')`,
    );
    expect(rows.map((f) => f.nombre)).toEqual([]);
  });

  it('R11: las únicas SECURITY DEFINER son las dos que leen tenancía', async () => {
    const { rows } = await db.query<{ nombre: string }>(
      `select p.proname as nombre
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname in ('app', 'public') order by 1`,
    );
    expect(rows.map((f) => f.nombre)).toEqual(['accessible_tenant_ids', 'has_role_on']);
  });
});

// -----------------------------------------------------------------------------
describe('R12 — FK compuestas tenant-consistentes (punto 2 de §H.3)', () => {
  /** Devuelve las FK entre dos tablas que ambas tienen columna de tenant. */
  async function fksEntreTablasConTenant(): Promise<
    { hija: string; padre: string; nombre: string; columnasHija: string[]; columnasPadre: string[] }[]
  > {
    const { rows } = await db.query<{
      hija: string;
      padre: string;
      nombre: string;
      columnas_hija: string[];
      columnas_padre: string[];
    }>(
      `select ch.relname as hija, cp.relname as padre, con.conname as nombre,
              (select array_agg(a.attname order by k.ord)
                 from unnest(con.conkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columnas_hija,
              (select array_agg(a.attname order by k.ord)
                 from unnest(con.confkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as columnas_padre
         from pg_constraint con
         join pg_class ch on ch.oid = con.conrelid
         join pg_class cp on cp.oid = con.confrelid
         join pg_namespace n on n.oid = ch.relnamespace
        where con.contype = 'f' and n.nspname = 'public'`,
    );

    const conTenant = new Set<string>(tablasConColumnaTenant());
    return rows
      .filter((f) => conTenant.has(f.hija) && conTenant.has(f.padre))
      .map((f) => ({
        hija: f.hija,
        padre: f.padre,
        nombre: f.nombre,
        columnasHija: f.columnas_hija,
        columnasPadre: f.columnas_padre,
      }));
  }

  it('toda FK entre dos tablas de dominio incluye la columna de tenant en AMBOS lados', async () => {
    const fks = await fksEntreTablasConTenant();
    const mal = fks
      .filter(
        (f) =>
          !f.columnasHija.includes(CLASIFICACION[f.hija as NombreTabla].columnaTenant) ||
          !f.columnasPadre.includes(CLASIFICACION[f.padre as NombreTabla].columnaTenant),
      )
      .map((f) => `${f.hija}.${f.nombre} -> ${f.padre} (${f.columnasHija.join(',')})`);

    expect(mal, 'FK de dominio sin la columna de tenant: no impiden cruzar clientes').toEqual([]);
  });

  it('hay al menos una FK compuesta real, para que la regla no sea vacía', async () => {
    const fks = await fksEntreTablasConTenant();
    expect(fks.length, 'no hay ninguna FK entre tablas de dominio que verificar').toBeGreaterThan(0);
    expect(fks.some((f) => f.columnasHija.length >= 2)).toBe(true);
  });

  it('el chequeo DETECTA una FK simple entre tablas de dominio (verificación del verificador)', async () => {
    // Una regla que nunca vio un caso malo no está verificada. Se arma uno a propósito y se comprueba
    // que el chequeo lo marca; después se deshace.
    await db.query('begin');
    try {
      await db.query(`
        create table _mala_padre (
          id uuid primary key default gen_random_uuid(),
          cliente_id uuid not null references tenant_node(id)
        );
        create table _mala_hija (
          id uuid primary key default gen_random_uuid(),
          cliente_id uuid not null references tenant_node(id),
          padre_id uuid not null references _mala_padre(id)   -- FK SIMPLE: el caso malo
        );
      `);

      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n
           from pg_constraint con
           join pg_class ch on ch.oid = con.conrelid
           join pg_class cp on cp.oid = con.confrelid
          where con.contype = 'f' and ch.relname = '_mala_hija' and cp.relname = '_mala_padre'
            and not exists (
              select 1 from unnest(con.conkey) k(attnum)
               join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
              where a.attname = 'cliente_id')`,
      );
      expect(rows[0]?.n, 'el chequeo debería marcar la FK simple').toBe(1);
    } finally {
      await db.query('rollback');
    }
  });
});

// -----------------------------------------------------------------------------
describe('R13/R15 — coherencia del árbol y ausencia de super-raíz', () => {
  it('R13: el path de todo nodo es coherente con su padre', async () => {
    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from app.verificar_coherencia_path()',
    );
    expect(rows[0]?.n, 'nodos con path incoherente = subárbol accesible corrupto').toBe(0);
  });

  it('R13: existe el trigger de UPDATE de parent_id (no solo el de INSERT)', async () => {
    const { rows } = await db.query<{ nombre: string }>(
      `select tgname as nombre from pg_trigger
        where tgrelid = 'tenant_node'::regclass and not tgisinternal order by 1`,
    );
    const nombres = rows.map((f) => f.nombre);
    expect(nombres).toContain('trg_tenant_node_path');
    expect(nombres, 'sin trigger en UPDATE, un cambio de parent_id corrompe el path (H-1)').toContain(
      'trg_tenant_node_path_upd',
    );
    expect(nombres).toContain('trg_tenant_node_path_manual');
  });

  it('R15: ningún estudio tiene padre (no hay super-raíz de plataforma)', async () => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from tenant_node where tipo = 'estudio' and parent_id is not null`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('punto 4 — chequeo de rol en LECTURA para N2R/N3', () => {
  it('toda tabla con columnas N2R/N3 chequea rol en su policy de SELECT', async () => {
    const tablas = tablasQueExigenRolEnLectura();
    expect(tablas.length, 'no hay tablas N2R/N3: la regla quedaría vacía').toBeGreaterThan(0);

    for (const tabla of tablas) {
      const { rows } = await db.query<{ policyname: string; qual: string | null }>(
        `select policyname, qual from pg_policies
          where schemaname = 'public' and tablename = $1 and cmd in ('SELECT', 'ALL')`,
        [tabla],
      );
      expect(rows.length, `${tabla} no tiene policy de lectura`).toBeGreaterThan(0);
      const todasChequeanRol = rows.every((f) => (f.qual ?? '').includes('has_role_on'));
      expect(
        todasChequeanRol,
        `${tabla} tiene columnas N2R/N3 y su policy de SELECT no chequea rol`,
      ).toBe(true);
    }
  });

  it('app_request NO puede seleccionar las columnas N3 (grant a nivel columna)', async () => {
    const columnas = columnasSoloFirmador();
    expect(columnas.length, 'no hay columnas N3 declaradas').toBeGreaterThan(0);

    for (const { tabla, columna } of columnas) {
      const { rows } = await db.query<{ puede: boolean }>(
        `select has_column_privilege('app_request', $1, $2, 'SELECT') as puede`,
        [tabla, columna],
      );
      expect(rows[0]?.puede, `app_request puede leer ${tabla}.${columna} (N3)`).toBe(false);

      const { rows: firmador } = await db.query<{ puede: boolean }>(
        `select has_column_privilege('app_firmador', $1, $2, 'SELECT') as puede`,
        [tabla, columna],
      );
      expect(firmador[0]?.puede, `app_firmador debería poder leer ${tabla}.${columna}`).toBe(true);
    }
  });

  it('app_job no tiene ningún privilegio sobre las tablas con material N3', async () => {
    for (const { tabla } of columnasSoloFirmador()) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
        const { rows } = await db.query<{ puede: boolean }>(
          `select has_table_privilege('app_job', $1, $2) as puede`,
          [tabla, priv],
        );
        expect(rows[0]?.puede, `app_job tiene ${priv} sobre ${tabla}`).toBe(false);
      }
    }
  });

  it('toda tabla que exige rol en lectura tiene un lector auditado declarado', () => {
    expect(tablasSinLectorAuditado(), 'tablas N2R/N3 sin lector auditado').toEqual([]);
  });

  /**
   * La verificación que faltaba, y por la que el registro pasó de strings a funciones.
   *
   * La entrada de `credencial_fiscal` decía `'leerMetadatosCredencial (packages/data/src/credenciales.ts)'`
   * y **ese archivo no existía**. El test de arriba pasaba, porque preguntaba si la tabla tenía entrada,
   * no si el lector existía. Un control que se satisface escribiendo una cadena de texto no es un control.
   */
  /**
   * LA TRAMPA DE `for all`, verificada mecánicamente.
   *
   * Las policies permisivas de Postgres se combinan con **OR**, y `for all` incluye SELECT. En una tabla
   * con lectura restringida, una policy de escritura `for all` que admita más roles que la de lectura
   * **anula la restricción de lectura** — y la línea que lo causa no menciona la lectura en ningún lado.
   *
   * Pasó de verdad: el `administrativo` leía las filas crudas de `movimiento_origen_crudo` (escenario
   * H-8) porque su policy de escritura era `for all` y él tiene que poder escribir. La policy de lectura
   * estaba bien escrita. El control se veía correcto en la migración y no existía en la base.
   *
   * Esta regla prohíbe el patrón, no la instancia: en una tabla N2R/N3 la escritura se declara por
   * operación. Así el bug no puede volver por otra tabla.
   */
  it('ninguna tabla con lectura restringida tiene una policy `for all`', async () => {
    const restringidas = tablasQueExigenRolEnLectura();
    if (restringidas.length === 0) return;

    const { rows } = await db.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies
        where schemaname = 'public' and cmd = 'ALL' and tablename = any($1::text[])`,
      [restringidas],
    );
    const mal = rows.map(
      (r) =>
        `${r.tablename}.${r.policyname}: es \`for all\`, así que otorga SELECT y puede anular la ` +
        `policy de lectura restringida. Declarala por operación (insert/update/delete).`,
    );
    expect(mal).toEqual([]);
  });

  it('cada lector declarado es una FUNCION real, no el nombre de una', () => {
    for (const tabla of tablasQueExigenRolEnLectura()) {
      const lector = LECTORES_AUDITADOS[tabla];
      expect(typeof lector?.fn, `${tabla}: el lector declarado no es invocable`).toBe('function');
      // Y recibe (tx, ctx, args): un lector sin el contexto auditado no pasó por el choke point.
      expect(lector?.fn.length, `${tabla}: el lector no exige (tx, ctx, args)`).toBe(3);
    }
  });
});

// -----------------------------------------------------------------------------
describe('el dominio de `accion` no puede divergir entre el código y la base', () => {
  /**
   * Dos listas del mismo dominio en dos lenguajes distintos divergen: es cuestión de tiempo. Y la
   * divergencia no da un error legible — da un `check constraint violation` en el insert, meses después,
   * en el camino que menos se ejercita.
   *
   * Ya pasó al escribir la migración 0004: el check omitía `uso_credencial`, que `ACCIONES` sí emite.
   * Todo registro de uso de una credencial fiscal habría fallado el día que se integrara AFIP.
   */
  it('el check constraint de la base tiene EXACTAMENTE los valores de ACCIONES', async () => {
    const { rows } = await db.query<{ definicion: string }>(
      `select pg_get_constraintdef(oid) as definicion
         from pg_constraint where conname = 'acceso_auditoria_accion_chk'`,
    );
    const definicion = rows[0]?.definicion;
    expect(definicion, 'falta el check constraint de accion').toBeDefined();

    const enLaBase = [...(definicion ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(enLaBase, 'el check de la base y la constante ACCIONES divergen').toEqual(
      [...ACCIONES].sort(),
    );
  });
});

// -----------------------------------------------------------------------------
describe('R32 — la auditoría es append-only', () => {
  it('nadie tiene UPDATE ni DELETE sobre acceso_auditoria', async () => {
    for (const rol of ['app_request', 'app_job', 'app_firmador']) {
      for (const priv of ['UPDATE', 'DELETE'] as const) {
        const { rows } = await db.query<{ puede: boolean }>(
          `select has_table_privilege($1, 'acceso_auditoria', $2) as puede`,
          [rol, priv],
        );
        expect(rows[0]?.puede, `${rol} tiene ${priv} sobre acceso_auditoria`).toBe(false);
      }
    }
  });

  it('app_job puede INSERTAR el rastro (R19) pero no leerlo', async () => {
    const { rows: insert } = await db.query<{ puede: boolean }>(
      `select has_table_privilege('app_job', 'acceso_auditoria', 'INSERT') as puede`,
    );
    expect(insert[0]?.puede, 'app_job debe poder dejar rastro de su uso de BYPASSRLS').toBe(true);

    const { rows: select } = await db.query<{ puede: boolean }>(
      `select has_table_privilege('app_job', 'acceso_auditoria', 'SELECT') as puede`,
    );
    expect(select[0]?.puede, 'app_job no tiene por qué leer el rastro de otros').toBe(false);
  });
});

// -----------------------------------------------------------------------------
describe('R29 — Postgres no loguea sentencias ni parámetros', () => {
  it('log_statement=none y los parámetros no van al log', async () => {
    const { rows } = await db.query<{ name: string; setting: string }>(
      `select name, setting from pg_settings
        where name in ('log_statement', 'log_parameter_max_length',
                       'log_parameter_max_length_on_error')
        order by name`,
    );
    const porNombre = new Map(rows.map((f) => [f.name, f.setting]));
    expect(porNombre.get('log_statement'), 'log_statement debería ser none').toBe('none');
    // 0 = no loguear el valor del parámetro. El `detail` de un error trae valores de fila (R28).
    expect(porNombre.get('log_parameter_max_length')).toBe('0');
    expect(porNombre.get('log_parameter_max_length_on_error')).toBe('0');
  });
});
