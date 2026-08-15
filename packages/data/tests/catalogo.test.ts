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
import { AMBIENTES_CREDENCIAL } from '../src/credenciales.ts';
import { TIPOS_CUENTA_ALTA } from '../src/ingesta/escrituras.ts';
import { LECTORES_AUDITADOS, tablasSinLectorAuditado } from '../src/db/lectores-auditados.ts';
/**
 * ⚠️ Import **relativo a `packages/ingesta`**, y es deliberado.
 *
 * `packages/data` no puede depender de `packages/ingesta` (ciclo prohibido, verificado en
 * `reglas-de-codigo.test.ts`), pero esa misma regla **exime explícitamente a los tests**: *"un test puede
 * armar el escenario completo"*. Y este test tiene que ver las dos puntas de cada par —el check de la base,
 * que es de `data`, y la constante de TypeScript, que en siete de diez casos es de `ingesta`—, así que no
 * hay lugar del que pueda correr sin cruzar el límite. Se cruza acá, en un `.test.ts`, y no en `src/`.
 */
import {
  ATRIBUCIONES_ANEXO,
  CAPTURAS_CONTRAPARTE,
  ESTADOS_LOTE,
  ESTADOS_VERIFICACION,
  ESTRATEGIAS_CONCEPTO,
  ORIGENES_LOTE,
  PERIODOS_ANEXO,
  RELACIONES_ANEXO,
  TIPOS_CUENTA,
} from '../../ingesta/src/esquema.ts';
import { CLASES_IDENTIFICADOR_CONTRAPARTE, TIPOS_DOCUMENTO_SOCIO } from '@sistema-contable/shared/seguridad';
import { CONCEPTOS_CANONICOS } from '../../contabilidad/src/nucleo/catalogo.ts';
import {
  CLASES_RECONOCIMIENTO,
  LADOS,
  MOTIVOS_SIN_RECONOCER,
  POLARIDADES,
  QUE_DECIDE,
  TIPOS_MOVIMIENTO,
  VIAS_EVIDENCIA,
} from '../../contabilidad/src/nucleo/tipos.ts';
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
  /**
   * 🔴 R10 REESCRITA (migración 0015, incidente #1 de `docs/seguridad/registro-incidentes.md`).
   *
   * La versión anterior exigía "toda `security definer` fija `search_path`" y miraba
   * `pg_proc.proconfig`. **Pasó VERDE con el bug adentro**: `accessible_tenant_ids` y `has_role_on`
   * fijaban `search_path = public, app`, o sea que cumplían la letra de la regla y aun así eran
   * explotables — `pg_temp` se busca PRIMERO para relaciones y tipos aunque no esté listado, así que
   * cualquiera con privilegio `TEMPORARY` plantaba una `membership` falsa y anulaba la RLS entera.
   * La regla medía "¿fija alguno?" en vez de "¿el que fija neutraliza `pg_temp`?".
   *
   * Dos cambios, y el segundo importa tanto como el primero:
   *
   *   1. Se exige que `pg_temp` sea el ÚLTIMO elemento del `search_path`, no que exista alguno.
   *   2. 🔴 Se barren TODAS las funciones, no sólo las `security definer`. Cuatro de las seis
   *      vulnerables eran INVOKER — entre ellas `exigir_nodo_cliente`, que es el renglón (3) de la
   *      plantilla de ADR-0001 §5 y vive en 15 tablas de dominio. Un R10 acotado a `prosecdef`
   *      seguiría verde con ella desprotegida: la misma falla, movida un renglón.
   *
   * El parseo va por `string_to_array` + último elemento + `btrim`, no por `like '%pg_temp'`: ese
   * `like` se rompe con comillas o espacios, y `proconfig` guarda la forma canónica.
   */
  it('R10: toda función de app/public neutraliza pg_temp (search_path terminado en pg_temp)', async () => {
    const { rows } = await db.query<{ nombre: string; search_path_actual: string }>(
      `select n.nspname || '.' || p.proname as nombre,
              coalesce(sp.valor, '(sin search_path)') as search_path_actual
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         left join lateral (
           select right(c, -length('search_path=')) as valor
             from unnest(coalesce(p.proconfig, '{}'::text[])) c
            where c like 'search_path=%' limit 1
         ) sp on true
         left join lateral (
           select btrim(e) as ultimo
             from unnest(string_to_array(sp.valor, ',')) with ordinality as t(e, i)
            order by i desc limit 1
         ) u on true
        where n.nspname in ('app', 'public')
          and p.prokind = 'f'
          -- EXENCION UNICA Y DOCUMENTADA: app.current_user_id() no lee ninguna relacion ni tipo
          -- (solo current_setting), y pg_temp NUNCA se busca para nombres de funcion. Y una
          -- clausula SET inhabilitaria su inlining dentro de has_role_on y de las policies:
          -- +75 % medido (131 -> ~230 us) sobre el predicado de RLS de TODA tabla de dominio.
          and p.proname <> 'current_user_id'
          and coalesce(u.ultimo, '') <> 'pg_temp'
        order by 1`,
    );
    expect(
      rows.map((f) => `${f.nombre} → ${f.search_path_actual}`),
      'una función que no termina su search_path en pg_temp es plantable: cualquiera con privilegio ' +
        'TEMPORARY le sustituye la relación (o el tipo) que lee. Ver 0015 y el incidente #1.',
    ).toEqual([]);
  });

  /**
   * La otra mitad del cierre de 0015, y la que sobrevive a una función nueva mal escrita: sin
   * privilegio `TEMPORARY` no se puede crear el objeto que shadowea.
   */
  it('R10 bis: ningún rol de aplicación puede crear tablas temporales', async () => {
    const { rows } = await db.query<{ rol: string; puede: boolean }>(
      `select rolname as rol,
              has_database_privilege(rolname, current_database(), 'TEMPORARY') as puede
         from pg_roles
        where rolname in ('app_request', 'app_job', 'app_firmador')`,
    );
    expect(
      rows.filter((r) => r.puede).map((r) => r.rol),
      'un rol de aplicación con TEMPORARY puede plantar una relación en pg_temp y secuestrar lo que ' +
        'lea cualquier función que no la califique. Ver 0015 §2.',
    ).toEqual([]);
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
// DOMINIOS CERRADOS — una lista en SQL, la misma lista en TypeScript
// -----------------------------------------------------------------------------
/**
 * Dos listas del mismo dominio en dos lenguajes distintos divergen: es cuestión de tiempo. Y la divergencia
 * no da un error legible — da un `check constraint violation` en el insert, meses después, en el camino que
 * menos se ejercita.
 *
 * **Ya pasó dos veces en este repo**: el check de `acceso_auditoria.accion` (0004) omitía `uso_credencial`,
 * que `ACCIONES` sí emite —todo registro de uso de una credencial fiscal habría fallado el día que se
 * integrara AFIP—; y el de `tipo_cuenta` (0004) tenía un `cuenta_unica` **inventado en la migración**, que
 * no existía en el dominio del código y que aplastaba a `otra` los cinco tipos reales.
 *
 * ## Por qué esto es una tabla y no diez tests copiados
 *
 * Hasta hoy había **un** test de este tipo, el de `ACCIONES`, y los otros nueve checks no tenían ninguno.
 * Peor: tres lugares del repo afirmaban **por escrito** que el test existía para los suyos —0007 §5, 0008 y
 * `ESTRATEGIAS_CONCEPTO` en `esquema.ts`— y era falso. Una afirmación falsa sobre un control es peor que la
 * ausencia del control, porque desactiva la pregunta: nadie vuelve a mirar un check del que ya leyó que
 * está testeado.
 *
 * Con el molde parametrizado, cubrir un dominio nuevo cuesta **una fila**. Y el test de cobertura de más
 * abajo hace que no cubrirlo cueste el gate: no depende de que alguien se acuerde de agregar la fila.
 */
type DominioCerrado = {
  /** El `check` de la base. */
  readonly check: string;
  /** Tabla y columna que restringe. Verificar esto atrapa el check correcto sobre la columna equivocada. */
  readonly tabla: string;
  readonly columna: string;
  /** Nombre de la constante de TypeScript, tal como se lee en el código y en el comentario del check. */
  readonly constante: string;
  readonly valores: readonly string[];
  readonly migracion: string;
};

/**
 * Los diez pares. Cada fila es un dominio que existe **dos veces** y tiene que decir lo mismo.
 *
 * `cuenta_ident_tipo_chk` aparece **dos veces a propósito**: su lista está copiada a mano en dos constantes
 * de TypeScript (`TIPOS_CUENTA` en el dominio y `TIPOS_CUENTA_ALTA` en el alta de cuenta), y ninguna puede
 * derivarse de la otra sin crear el ciclo `data → ingesta`, que está prohibido. Comparar **las dos** contra
 * el mismo check las obliga a ser iguales entre sí por transitividad, con la base de árbitro. El motivo
 * completo está en el comentario de `TIPOS_CUENTA_ALTA`.
 */
const DOMINIOS_CERRADOS: DominioCerrado[] = [
  {
    check: 'acceso_auditoria_accion_chk',
    tabla: 'acceso_auditoria',
    columna: 'accion',
    constante: 'ACCIONES',
    valores: ACCIONES,
    migracion: '0004',
  },
  {
    check: 'credencial_fiscal_ambiente_chk',
    tabla: 'credencial_fiscal',
    columna: 'ambiente',
    constante: 'AMBIENTES_CREDENCIAL',
    valores: AMBIENTES_CREDENCIAL,
    migracion: '0002',
  },
  {
    check: 'cuenta_ident_tipo_chk',
    tabla: 'cuenta_bancaria_identificador',
    columna: 'tipo_cuenta',
    constante: 'TIPOS_CUENTA',
    valores: TIPOS_CUENTA,
    migracion: '0006',
  },
  {
    check: 'cuenta_ident_tipo_chk',
    tabla: 'cuenta_bancaria_identificador',
    columna: 'tipo_cuenta',
    constante: 'TIPOS_CUENTA_ALTA',
    valores: TIPOS_CUENTA_ALTA,
    migracion: '0006',
  },
  {
    check: 'lote_ingesta_estado_chk',
    tabla: 'lote_ingesta',
    columna: 'estado',
    constante: 'ESTADOS_LOTE',
    valores: ESTADOS_LOTE,
    migracion: '0004',
  },
  {
    check: 'lote_ingesta_origen_chk',
    tabla: 'lote_ingesta',
    columna: 'origen',
    constante: 'ORIGENES_LOTE',
    valores: ORIGENES_LOTE,
    migracion: '0004',
  },
  {
    check: 'lote_cuenta_verif_chk',
    tabla: 'lote_ingesta_cuenta',
    columna: 'verificacion_estado',
    constante: 'ESTADOS_VERIFICACION',
    valores: ESTADOS_VERIFICACION,
    migracion: '0004',
  },
  {
    check: 'mov_crudo_concepto_estrategia_chk',
    tabla: 'movimiento_bancario_crudo',
    columna: 'concepto_banco_estrategia',
    constante: 'ESTRATEGIAS_CONCEPTO',
    valores: ESTRATEGIAS_CONCEPTO,
    migracion: '0007',
  },
  {
    check: 'anexo_atribucion_chk',
    tabla: 'anexo_extracto',
    columna: 'atribucion_cuenta',
    constante: 'ATRIBUCIONES_ANEXO',
    valores: ATRIBUCIONES_ANEXO,
    migracion: '0008',
  },
  {
    check: 'anexo_periodo_dato_chk',
    tabla: 'anexo_extracto',
    columna: 'periodo_dato',
    constante: 'PERIODOS_ANEXO',
    valores: PERIODOS_ANEXO,
    migracion: '0008',
  },
  {
    check: 'anexo_relacion_chk',
    tabla: 'anexo_extracto',
    columna: 'relacion_con_movimientos',
    constante: 'RELACIONES_ANEXO',
    valores: RELACIONES_ANEXO,
    migracion: '0008',
  },
  {
    check: 'mov_crudo_contraparte_captura_chk',
    tabla: 'movimiento_bancario_crudo',
    columna: 'contraparte_captura',
    constante: 'CAPTURAS_CONTRAPARTE',
    valores: CAPTURAS_CONTRAPARTE,
    migracion: '0013',
  },
  {
    check: 'mov_contraparte_clase_chk',
    tabla: 'movimiento_contraparte_identificador',
    columna: 'clase',
    constante: 'CLASES_IDENTIFICADOR_CONTRAPARTE',
    valores: CLASES_IDENTIFICADOR_CONTRAPARTE,
    migracion: '0013',
  },
  {
    check: 'padron_socio_documento_tipo_chk',
    tabla: 'padron_socio',
    columna: 'documento_tipo',
    constante: 'TIPOS_DOCUMENTO_SOCIO',
    valores: TIPOS_DOCUMENTO_SOCIO,
    migracion: '0013',
  },
  // -- 0014: los OCHO dominios del motor de reconocimiento -------------------------------------
  // `reconocimiento_forma_chk` NO está acá a propósito: lleva un `case` y no matchea
  // `FORMA_DOMINIO_CERRADO` (verificado contra pg_constraint). Su árbitro es
  // `packages/contabilidad/tests/forma-persistible.test.ts`, que lo ata a `motor.ts`.
  {
    check: 'reconocimiento_clase_chk',
    tabla: 'reconocimiento_movimiento',
    columna: 'clase',
    constante: 'CLASES_RECONOCIMIENTO',
    valores: CLASES_RECONOCIMIENTO,
    migracion: '0014',
  },
  {
    check: 'reconocimiento_tipo_chk',
    tabla: 'reconocimiento_movimiento',
    columna: 'tipo',
    constante: 'TIPOS_MOVIMIENTO',
    valores: TIPOS_MOVIMIENTO,
    migracion: '0014',
  },
  {
    check: 'reconocimiento_concepto_chk',
    tabla: 'reconocimiento_movimiento',
    columna: 'concepto',
    constante: 'CONCEPTOS_CANONICOS',
    valores: CONCEPTOS_CANONICOS,
    migracion: '0014',
  },
  {
    check: 'reconocimiento_polaridad_chk',
    tabla: 'reconocimiento_movimiento',
    columna: 'polaridad',
    constante: 'POLARIDADES',
    valores: POLARIDADES,
    migracion: '0014',
  },
  {
    check: 'reconocimiento_lado_chk',
    tabla: 'reconocimiento_movimiento',
    columna: 'lado',
    constante: 'LADOS',
    valores: LADOS,
    migracion: '0014',
  },
  {
    check: 'reconocimiento_via_chk',
    tabla: 'reconocimiento_movimiento',
    columna: 'via',
    constante: 'VIAS_EVIDENCIA',
    valores: VIAS_EVIDENCIA,
    migracion: '0014',
  },
  {
    check: 'reconocimiento_decide_chk',
    tabla: 'reconocimiento_movimiento',
    columna: 'que_decide',
    constante: 'QUE_DECIDE',
    valores: QUE_DECIDE,
    migracion: '0014',
  },
  {
    check: 'reconocimiento_motivo_chk',
    tabla: 'reconocimiento_movimiento',
    columna: 'motivo_codigo',
    constante: 'MOTIVOS_SIN_RECONOCER',
    valores: MOTIVOS_SIN_RECONOCER,
    migracion: '0014',
  },
];

/**
 * La **forma** que Postgres le da a un `check (col in ('a', 'b', …))` sobre una columna `text`.
 *
 * Se exige la forma exacta y no un "buscá comillas simples por ahí" —que es lo que hacía el molde original,
 * con `/'([a-z_]+)'/g`— por dos motivos. Primero, ese regex **pierde en silencio** cualquier valor con un
 * dígito o una mayúscula: el conjunto sale incompleto y la comparación falla por el motivo equivocado, o
 * peor, coincide por casualidad. Segundo, anclar la forma completa hace que un check que deje de ser un
 * dominio cerrado —porque alguien lo convirtió en una expresión compuesta— rompa **acá**, con un mensaje
 * que dice qué pasó, en vez de degradarse a una comparación que ya no significa nada.
 *
 * Un check de *coherencia* (`(a is null) = (b in (…))`) NO matchea, y está bien: ese `in` referencia un
 * **subconjunto** del dominio, no el dominio.
 */
const FORMA_DOMINIO_CERRADO = /^CHECK \(\((\w+) = ANY \(ARRAY\[(.+)\]\)\)\)$/;

/** Los literales del `ARRAY[...]`, en el orden en que los guardó Postgres. */
function valoresDelArray(cuerpo: string): string[] {
  // `''` es la forma en que Postgres escapa una comilla adentro de un literal; ninguno de estos dominios
  // tiene una, pero desescaparla cuesta nada y evita un falso rojo el día que aparezca.
  return [...cuerpo.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) => (m[1] ?? '').replaceAll("''", "'"));
}

type CheckDeLaBase = { conname: string; tabla: string; definicion: string; comentario: string | null };

/** Todos los `check` del esquema `public`, con su tabla y su comentario. */
async function checksDelEsquema(): Promise<CheckDeLaBase[]> {
  const { rows } = await db.query<CheckDeLaBase>(
    `select conname,
            conrelid::regclass::text as tabla,
            pg_get_constraintdef(oid) as definicion,
            obj_description(oid, 'pg_constraint') as comentario
       from pg_constraint
      where contype = 'c' and connamespace = 'public'::regnamespace
      order by conname`,
  );
  return rows;
}

describe('los dominios cerrados no pueden divergir entre el código y la base', () => {
  it.each(DOMINIOS_CERRADOS)(
    '$constante == $check ($migracion)',
    async (d) => {
      const encontrados = (await checksDelEsquema()).filter((c) => c.conname === d.check);

      expect(
        encontrados.length,
        `${d.check}: tiene que existir exactamente un check con ese nombre en el esquema. ` +
          'Cero significa que se renombró o se dropeó y la constante quedó sin árbitro.',
      ).toBe(1);

      const check = encontrados[0] as CheckDeLaBase;
      expect(check.tabla, `${d.check} no está sobre la tabla que declara la tabla de pares`).toBe(
        d.tabla,
      );

      const forma = FORMA_DOMINIO_CERRADO.exec(check.definicion);
      expect(
        forma,
        `${d.check} ya no tiene la forma de un dominio cerrado (\`col = ANY (ARRAY[…])\`). ` +
          `Definición actual: ${check.definicion}`,
      ).not.toBeNull();

      const [, columna, cuerpo] = forma as RegExpExecArray;
      expect(
        columna,
        `${d.check} restringe otra columna: un check correcto sobre la columna equivocada no protege nada`,
      ).toBe(d.columna);

      const enLaBase = valoresDelArray(cuerpo ?? '').sort();
      const enElCodigo = [...d.valores].sort();

      // Aserción de CONJUNTO: el orden de la lista no es parte del contrato, la pertenencia sí.
      expect(
        enLaBase,
        `el check ${d.check} y la constante ${d.constante} divergen. Lo que sobra en la base rechaza ` +
          `inserts que el código cree válidos; lo que falta en la base los deja pasar sin control.`,
      ).toEqual(enElCodigo);

      // Y una lista vacía no puede dar verde por vacío en ninguno de los dos lados.
      expect(enLaBase.length, `${d.check}: un dominio cerrado sin valores no es un dominio`).toBeGreaterThan(1);
    },
  );

  /**
   * 🔴 LA REGLA QUE HACE QUE ESTO NO DEPENDA DE QUE ALGUIEN SE ACUERDE.
   *
   * Los diez pares de arriba se cubren porque alguien los escribió. Un check de dominio cerrado **nuevo**,
   * agregado en la migración 0011 por otra persona, no estaría en la tabla y nadie lo notaría — que es
   * exactamente cómo llegamos a tener nueve sin test y tres afirmaciones falsas de que sí lo tenían.
   *
   * Esta regla invierte la carga: la base se lee entera, y todo check con forma de dominio cerrado tiene
   * que estar en la tabla de pares. Agregar el dominio sin su constante deja el gate rojo.
   */
  it('todo check con forma de dominio cerrado está en la tabla de pares', async () => {
    const enLaBase = (await checksDelEsquema())
      .filter((c) => FORMA_DOMINIO_CERRADO.test(c.definicion))
      .map((c) => c.conname);

    expect(enLaBase.length, 'el barrido no encontró ningún dominio cerrado: no está viendo el esquema')
      .toBeGreaterThanOrEqual(DOMINIOS_CERRADOS.length - 1);

    const cubiertos = new Set(DOMINIOS_CERRADOS.map((d) => d.check));
    expect(
      [...new Set(enLaBase)].filter((c) => !cubiertos.has(c)).sort(),
      'checks de dominio cerrado sin constante de TypeScript que los espeje. Declarala y agregá la fila ' +
        'en DOMINIOS_CERRADOS: si no, la lista de la base es la única y el código escribe a ciegas.',
    ).toEqual([]);
  });

  /**
   * La documentación también se verifica, y este test es la respuesta directa al hallazgo.
   *
   * Tres lugares del repo afirmaban que este test existía cuando no existía. La lección no es "escribir
   * mejores comentarios": es que **una afirmación sobre un control tiene que estar bajo el mismo gate que
   * el control**. El comentario de cada check vive en `pg_description` (migración 0010) y tiene que nombrar
   * a la constante contra la que se compara. Un comentario que promete otra cosa se pone rojo acá.
   */
  it('el comentario de cada check nombra a su constante de TypeScript', async () => {
    const porNombre = new Map((await checksDelEsquema()).map((c) => [c.conname, c.comentario]));

    const mudos: string[] = [];
    for (const d of DOMINIOS_CERRADOS) {
      const comentario = porNombre.get(d.check);
      if (comentario === null || comentario === undefined || !comentario.includes(d.constante)) {
        mudos.push(`${d.check} no menciona ${d.constante}`);
      }
    }

    expect(
      mudos,
      'checks cuyo comentario no dice contra qué constante se comparan. El comentario es lo que lee quien ' +
        'abre la tabla con \\d+, y si no nombra la fuente, la próxima copia se hace a ojo.',
    ).toEqual([]);
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
